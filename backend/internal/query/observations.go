package query

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/868-no/map/internal/ingest"
	"github.com/868-no/map/internal/window"
)

// MaxObservationPage bounds one page of raw observations.
const MaxObservationPage = 20000

// ObsRow is ingest.ObsRow: the same compact row is streamed live.
type ObsRow = ingest.ObsRow

// Cursor is a position in (observed_at, id) order: the last row returned.
type Cursor struct {
	At time.Time
	ID int64
}

// String encodes the cursor for clients: Unix microseconds and row id.
func (c Cursor) String() string { return fmt.Sprintf("%d.%d", c.At.UnixMicro(), c.ID) }

// ParseCursor decodes Cursor.String; ok is false for anything else.
func ParseCursor(s string) (Cursor, bool) {
	us, id, found := strings.Cut(s, ".")
	if !found {
		return Cursor{}, false
	}
	u, err1 := strconv.ParseInt(us, 10, 64)
	i, err2 := strconv.ParseInt(id, 10, 64)
	if err1 != nil || err2 != nil || i < 0 {
		return Cursor{}, false
	}
	return Cursor{At: time.UnixMicro(u).UTC(), ID: i}, true
}

// ListObservations returns rows of w after the cursor (all of them when nil)
// in (observed_at, id) order, at most limit of them, plus whether more
// remain. Time order lets the observed_at index serve every page; id order
// made PostgreSQL walk the primary key through all older rows (D-038).
// Callers narrow w (never widen it) to fetch only what they do not hold.
func ListObservations(ctx context.Context, pool *pgxpool.Pool, w window.Window, after *Cursor, limit int) ([]ObsRow, *Cursor, bool, error) {
	if limit <= 0 || limit > MaxObservationPage {
		limit = MaxObservationPage
	}
	b := where(w)
	if after != nil {
		// A cursor inside the window, never a bound on it.
		b.and("(observed_at, id) > (?, ?)", after.At, after.ID)
	}
	lim := b.arg(limit + 1)
	rows, err := pool.Query(ctx, `
		SELECT id, observed_at, broker_id, gateway_node_id, source_node_id, destination_node_id, packet_id,
		       COALESCE(channel_name, ''), packet_type, logical_packet_key, observation_key,
		       rx_snr, rx_rssi, hop_start, hop_limit, relay_hint, signature_status, decoded_metadata
		FROM packet_log WHERE `+b.String()+` ORDER BY observed_at, id LIMIT `+lim, b.args...)
	if err != nil {
		return nil, nil, false, err
	}
	defer rows.Close()
	out := make([]ObsRow, 0, min(limit, 4096))
	var last Cursor
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
			return nil, nil, false, err
		}
		if len(out) < limit {
			last = Cursor{At: at, ID: id}
		}
		out = append(out, ingest.NewObsRow(ingest.RowFields{
			ID: id, At: at, Broker: broker, Gateway: u32(gw), Source: uint32(src), Dest: u32(dst), PacketID: u32(pid),
			Channel: ch, Type: typ, Logical: lp, Reception: ok, SNR: snr, RSSI: rssi, HopStart: hopStart, HopLimit: hopLimit,
			Relay: relay, Sig: sig,
		}, raw))
	}
	if err := rows.Err(); err != nil {
		return nil, nil, false, err
	}
	more := len(out) > limit
	if more {
		out = out[:limit]
	}
	if len(out) == 0 {
		return out, after, false, nil
	}
	return out, &last, more, nil
}

func u32(p *int64) *uint32 {
	if p == nil {
		return nil
	}
	v := uint32(*p)
	return &v
}
