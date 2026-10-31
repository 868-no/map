package query

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/868-no/map/internal/ingest"
	"github.com/868-no/map/internal/window"
)

// MaxObservationPage bounds one page of raw observations.
const MaxObservationPage = 20000

// ObsRow is ingest.ObsRow: the same compact row is streamed live.
type ObsRow = ingest.ObsRow

// ListObservations returns rows of w with id > afterID in id order, at most
// limit of them, and whether more remain. Callers narrow w (never widen it)
// to fetch only the part of a window they do not hold yet.
func ListObservations(ctx context.Context, pool *pgxpool.Pool, w window.Window, afterID int64, limit int) ([]ObsRow, bool, error) {
	if limit <= 0 || limit > MaxObservationPage {
		limit = MaxObservationPage
	}
	b := where(w).and("id > ?", afterID)
	lim := b.arg(limit + 1)
	rows, err := pool.Query(ctx, `
		SELECT id, observed_at, broker_id, gateway_node_id, source_node_id, destination_node_id, packet_id,
		       COALESCE(channel_name, ''), packet_type, logical_packet_key, observation_key,
		       rx_snr, rx_rssi, hop_start, hop_limit, relay_hint, signature_status, decoded_metadata
		FROM packet_log WHERE `+b.String()+` ORDER BY id LIMIT `+lim, b.args...)
	if err != nil {
		return nil, false, err
	}
	defer rows.Close()
	out := make([]ObsRow, 0, min(limit, 4096))
	for rows.Next() {
		var (
			id                 int64
			at                 time.Time
			broker, ch, typ    string
			sig                string
			gw, dst, pid       *int64
			src                int64
			lp, ok, raw        []byte
			snr                *float32
			rssi, relay        *int32
			hopStart, hopLimit *int16
		)
		if err := rows.Scan(&id, &at, &broker, &gw, &src, &dst, &pid, &ch, &typ, &lp, &ok,
			&snr, &rssi, &hopStart, &hopLimit, &relay, &sig, &raw); err != nil {
			return nil, false, err
		}
		out = append(out, ingest.NewObsRow(ingest.RowFields{
			ID: id, At: at, Broker: broker, Gateway: u32(gw), Source: uint32(src), Dest: u32(dst), PacketID: u32(pid),
			Channel: ch, Type: typ, Logical: lp, Reception: ok, SNR: snr, RSSI: rssi, HopStart: hopStart, HopLimit: hopLimit,
			Relay: relay, Sig: sig,
		}, raw))
	}
	if err := rows.Err(); err != nil {
		return nil, false, err
	}
	more := len(out) > limit
	if more {
		out = out[:limit]
	}
	return out, more, nil
}

func u32(p *int64) *uint32 {
	if p == nil {
		return nil
	}
	v := uint32(*p)
	return &v
}
