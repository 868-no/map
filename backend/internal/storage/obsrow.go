package storage

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/868-no/map/internal/obsrow"
)

// ObsColumns is the select list ScanObs reads; version is the placeholder
// bound to obsrow.Version. Rows whose stored obs_row is current come as id,
// observed_at and that encoding only; the columns that rebuild a row are
// fetched just for rows missing it or of another version (D-046).
func ObsColumns(version string) string {
	cols := make([]string, len(rebuildColumns))
	for i, c := range rebuildColumns {
		cols[i] = "CASE WHEN obs_row_version = $V THEN NULL ELSE " + c + " END"
	}
	return strings.ReplaceAll("id, observed_at, CASE WHEN obs_row_version = $V THEN obs_row END, "+strings.Join(cols, ", "), "$V", version)
}

// rebuildColumns are what obsrow.New needs besides id and observed_at.
var rebuildColumns = []string{"broker_id", "gateway_node_id", "source_node_id", "destination_node_id", "packet_id",
	"COALESCE(channel_name, '')", "packet_type", "logical_packet_key", "observation_key",
	"rx_snr", "rx_rssi", "hop_start", "hop_limit", "relay_hint", "signature_status", "decoded_metadata"}

// ScanObs reads one row selected with ObsColumns. tail is the stored
// encoding when current (obsrow.WithID completes it), and f then holds only
// ID and At; otherwise tail is nil and f with meta builds the row.
func ScanObs(rows pgx.Rows) (f obsrow.Fields, tail, meta []byte, err error) {
	var (
		gw, src, dst, pid         *int64
		hopStart, hopLimit        *int16
		broker, channel, typ, sig *string
	)
	err = rows.Scan(&f.ID, &f.At, &tail, &broker, &gw, &src, &dst, &pid, &channel, &typ, &f.Logical, &f.Reception,
		&f.SNR, &f.RSSI, &hopStart, &hopLimit, &f.Relay, &sig, &meta)
	if err != nil || tail != nil {
		return
	}
	f.Gateway, f.Dest, f.PacketID, f.HopStart, f.HopLimit = u32(gw), u32(dst), u32(pid), hopStart, hopLimit
	f.Broker, f.Channel, f.Type, f.Sig = deref(broker), deref(channel), deref(typ), deref(sig)
	if src != nil {
		f.Source = uint32(*src)
	}
	return
}

func deref(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

func u32(p *int64) *uint32 {
	if p == nil {
		return nil
	}
	v := uint32(*p)
	return &v
}

// BackfillObsRows stores the current encoding for rows lacking it (rows from
// before D-046, or of an older ObsRowVersion), newest first, in small
// batches, so a logic change rewrites the derived copies once. Rows inserted
// meanwhile already carry it. Concurrent backfillers skip each other's rows.
func BackfillObsRows(ctx context.Context, pool *pgxpool.Pool, log *slog.Logger) (int, error) {
	const batch = 2000
	below := int64(1) << 62
	total := 0
	for {
		n, last, err := backfillBatch(ctx, pool, below, batch)
		if err != nil {
			return total, err
		}
		total += n
		if last == 0 {
			break
		}
		below = last
		select { // leave room for ingest and readers
		case <-ctx.Done():
			return total, ctx.Err()
		case <-time.After(50 * time.Millisecond):
		}
	}
	if total > 0 {
		log.Info("stored row encodings rebuilt", "rows", total, "version", obsrow.Version)
	}
	return total, nil
}

// backfillBatch encodes up to limit stale rows with id < below; last is the
// lowest id examined, 0 when none remain.
func backfillBatch(ctx context.Context, pool *pgxpool.Pool, below int64, limit int) (n int, last int64, err error) {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return 0, 0, err
	}
	defer tx.Rollback(context.WithoutCancel(ctx)) //nolint:errcheck
	rows, err := tx.Query(ctx, `SELECT `+ObsColumns("$1")+` FROM packet_log
		WHERE id < $2 AND `+staleObsRowPred+` -- served by the partial index
		ORDER BY id DESC LIMIT $3 FOR UPDATE SKIP LOCKED`, int16(obsrow.Version), below, limit)
	if err != nil {
		return 0, 0, err
	}
	var ids []int64
	var ats []time.Time
	var tails []string
	for rows.Next() {
		f, _, meta, err := ScanObs(rows)
		if err != nil {
			rows.Close()
			return 0, 0, err
		}
		tail, err := obsrow.EncodeTail(obsrow.New(f, meta))
		if err != nil {
			rows.Close()
			return 0, 0, fmt.Errorf("row %d: %w", f.ID, err)
		}
		ids, ats, tails, last = append(ids, f.ID), append(ats, f.At), append(tails, string(tail)), f.ID
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, 0, err
	}
	if len(ids) == 0 {
		return 0, 0, nil
	}
	// By (id, observed_at), the primary key, so each row is found in its own partition.
	if _, err := tx.Exec(ctx, `UPDATE packet_log p SET obs_row = u.tail, obs_row_version = $4
		FROM unnest($1::bigint[], $2::timestamptz[], $3::text[]) AS u(id, at, tail) WHERE p.id = u.id AND p.observed_at = u.at`, ids, ats, tails, int16(obsrow.Version)); err != nil {
		return 0, 0, err
	}
	return len(ids), last, tx.Commit(ctx)
}
