package storage

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/868-no/map/internal/ingest"
)

// ObsColumns is the select list ScanObs reads; version is the placeholder
// bound to ingest.ObsRowVersion. decoded_metadata is only fetched for rows
// whose stored obs_row is missing or of another version (D-046).
func ObsColumns(version string) string { return strings.ReplaceAll(obsColumns, "$V", version) }

const obsColumns = `id, observed_at, broker_id, gateway_node_id, source_node_id, destination_node_id, packet_id,
	COALESCE(channel_name, ''), packet_type, logical_packet_key, observation_key,
	rx_snr, rx_rssi, hop_start, hop_limit, relay_hint, signature_status,
	CASE WHEN obs_row_version = $V THEN obs_row END,
	CASE WHEN obs_row_version = $V THEN NULL ELSE decoded_metadata END`

// ScanObs reads one row selected with ObsColumns. tail is the stored
// encoding when current (ingest.WithID completes it); otherwise it is nil
// and f with meta builds the row.
func ScanObs(rows pgx.Rows) (f ingest.RowFields, tail, meta []byte, err error) {
	var (
		gw, dst, pid       *int64
		src                int64
		hopStart, hopLimit *int16
	)
	err = rows.Scan(&f.ID, &f.At, &f.Broker, &gw, &src, &dst, &pid, &f.Channel, &f.Type, &f.Logical, &f.Reception,
		&f.SNR, &f.RSSI, &hopStart, &hopLimit, &f.Relay, &f.Sig, &tail, &meta)
	f.Gateway, f.Source, f.Dest, f.PacketID, f.HopStart, f.HopLimit = u32(gw), uint32(src), u32(dst), u32(pid), hopStart, hopLimit
	return
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
		log.Info("stored row encodings rebuilt", "rows", total, "version", ingest.ObsRowVersion)
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
		WHERE id < $2 AND obs_row_version IS DISTINCT FROM $1
		ORDER BY id DESC LIMIT $3 FOR UPDATE SKIP LOCKED`, int16(ingest.ObsRowVersion), below, limit)
	if err != nil {
		return 0, 0, err
	}
	var ids []int64
	var tails []string
	for rows.Next() {
		f, _, meta, err := ScanObs(rows)
		if err != nil {
			rows.Close()
			return 0, 0, err
		}
		tail, err := ingest.EncodeTail(ingest.NewObsRow(f, meta))
		if err != nil {
			rows.Close()
			return 0, 0, fmt.Errorf("row %d: %w", f.ID, err)
		}
		ids, tails, last = append(ids, f.ID), append(tails, string(tail)), f.ID
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, 0, err
	}
	if len(ids) == 0 {
		return 0, 0, nil
	}
	if _, err := tx.Exec(ctx, `UPDATE packet_log p SET obs_row = u.tail, obs_row_version = $3
		FROM unnest($1::bigint[], $2::text[]) AS u(id, tail) WHERE p.id = u.id`, ids, tails, int16(ingest.ObsRowVersion)); err != nil {
		return 0, 0, err
	}
	return len(ids), last, tx.Commit(ctx)
}
