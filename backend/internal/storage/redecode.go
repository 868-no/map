package storage

import (
	"context"
	"encoding/json"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/868-no/map/internal/ingest"
)

// Redecode re-runs ingest on the stored envelopes of rows decoded by an older
// ingest.DecodeVersion (D-107), newest first, in small batches: envelopes are
// kept so that decoder improvements reach old rows too. A row gets the
// current decoding (type, signature status, decoded metadata, and the stored
// envelope, which a header-only row now has stripped), keeps its keys and
// broker provenance, and loses its stored client encoding so the backfill
// rebuilds it. A row the current decoder would reject is left as it is,
// only marked as checked: nothing stored is ever dropped. Identities are
// never promoted from old rows. A row whose envelope was stripped at ingest
// is only marked: it cannot decode to more than it holds. Rows another worker holds (the encoding
// backfill locks batches too) are waited for, not skipped: a skipped row would
// keep its old decoding until the next start. Returns how many rows changed.
func Redecode(ctx context.Context, pool *pgxpool.Pool, o ingest.Options, log *slog.Logger) (int, error) {
	const batch = 500
	below := int64(1) << 62
	total := 0
	for {
		n, last, err := redecodeBatch(ctx, pool, o, below, batch)
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
		case <-time.After(100 * time.Millisecond):
		}
	}
	if total > 0 {
		log.Info("old rows decoded again", "rows", total, "decode_version", ingest.DecodeVersion)
	}
	return total, nil
}

func redecodeBatch(ctx context.Context, pool *pgxpool.Pool, o ingest.Options, below int64, limit int) (changed int, last int64, err error) {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return 0, 0, err
	}
	defer tx.Rollback(context.WithoutCancel(ctx)) //nolint:errcheck
	rows, err := tx.Query(ctx, `SELECT id, observed_at, broker_id, mqtt_topic, envelope_bytes, decoded_metadata->'also_via',
		  packet_type, COALESCE(decoded_metadata->>'crypto', ''), COALESCE(decoded_metadata->>'invalid', ''),
		  COALESCE((decoded_metadata->>'not_ok_to_mqtt')::boolean, false)
		FROM packet_log WHERE id < $1 AND `+staleDecodePred+` -- served by the partial index
		ORDER BY id DESC LIMIT $2 FOR UPDATE`, below, limit)
	if err != nil {
		return 0, 0, err
	}
	var (
		ids, kept          []int64
		ats, keptAts       []time.Time
		types, sigs, metas []string
		ports              []int32
		envs               [][]byte
	)
	seen := 0
	for rows.Next() {
		var (
			id     int64
			at     time.Time
			broker string
			topic  string
			env    []byte
			also   []byte
			ty     string
			crypto string
			inval  string
			notOK  bool
		)
		if err := rows.Scan(&id, &at, &broker, &topic, &env, &also, &ty, &crypto, &inval, &notOK); err != nil {
			rows.Close()
			return 0, 0, err
		}
		seen++
		last = id
		// A stripped envelope (payload zeroed: header-only and invalid rows,
		// opt-out NodeInfo and status) can never decode to more than the row
		// already holds; decoding it again would only lose what was kept.
		if stripped(ty, crypto, inval, notOK) {
			kept, keptAts = append(kept, id), append(keptAts, at)
			continue
		}
		obs, perr := ingest.Process(ingest.RawMessage{BrokerID: broker, Topic: topic, Payload: env, ObservedAt: at}, o)
		if perr != nil {
			kept, keptAts = append(kept, id), append(keptAts, at)
			continue
		}
		if len(also) > 0 && string(also) != "null" {
			_ = json.Unmarshal(also, &obs.Meta.AlsoVia)
		}
		meta, err := json.Marshal(obs.Meta)
		if err != nil {
			rows.Close()
			return 0, 0, err
		}
		ids, ats, types, ports, sigs = append(ids, id), append(ats, at), append(types, obs.PacketType), append(ports, obs.Portnum), append(sigs, string(obs.SignatureStatus))
		metas, envs = append(metas, string(meta)), append(envs, obs.EnvelopeBytes)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, 0, err
	}
	if seen == 0 {
		return 0, 0, nil
	}
	if len(ids) > 0 {
		if _, err := tx.Exec(ctx, `UPDATE packet_log p SET packet_type = u.ty, portnum = u.port, signature_status = u.sig,
			decoded_metadata = u.meta::jsonb, envelope_bytes = u.env, decode_version = $8, obs_row = NULL, obs_row_version = NULL
			FROM unnest($1::bigint[], $2::timestamptz[], $3::text[], $4::int[], $5::text[], $6::text[], $7::bytea[]) AS u(id, at, ty, port, sig, meta, env)
			WHERE p.id = u.id AND p.observed_at = u.at`, ids, ats, types, ports, sigs, metas, envs, ingest.DecodeVersion); err != nil {
			return 0, 0, err
		}
	}
	if len(kept) > 0 {
		if _, err := tx.Exec(ctx, `UPDATE packet_log p SET decode_version = $3 FROM unnest($1::bigint[], $2::timestamptz[]) AS u(id, at)
			WHERE p.id = u.id AND p.observed_at = u.at`, kept, keptAts, ingest.DecodeVersion); err != nil {
			return 0, 0, err
		}
	}
	return len(ids), last, tx.Commit(ctx)
}

// stripped reports whether a row's stored envelope had its payload zeroed at
// ingest (D-091, D-093): header-only rows, rows that failed decoding or
// verification, and NodeInfo or status from a node that did not allow MQTT.
func stripped(packetType, crypto, invalid string, notOK bool) bool {
	switch {
	case crypto == string(ingest.CryptoPKI), crypto == string(ingest.CryptoUnreadable), invalid != "":
		return true
	case notOK && (packetType == "nodeinfo" || packetType == "node_status"):
		return true
	}
	return false
}
