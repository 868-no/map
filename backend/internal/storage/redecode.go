package storage

import (
	"context"
	"encoding/json"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/868-no/map/internal/ingest"
	"github.com/868-no/map/internal/protocol/ports"
)

// Redecode re-runs ingest on the stored envelopes of rows decoded by an older
// ingest.DecodeVersion (D-107), newest first, in small batches: envelopes are
// kept so that decoder improvements reach old rows too. A row gets the
// current decoding (type, signature status, channel name, decoded metadata,
// and the stored envelope, which a header-only row now has stripped), keeps
// its keys, broker provenance and import mark, and loses its stored client
// encoding so the backfill rebuilds it. A row the current decoder would
// reject, or whose envelope was stripped at ingest (it cannot decode to more
// than it holds), keeps its decoding: only its channel name and topic root
// are cleaned as ingest now cleans them, and it is marked as checked. Nothing
// stored is ever dropped, and identities are never promoted from old rows.
// Rows another worker holds (the encoding backfill locks batches too) are
// waited for, not skipped: a skipped row would keep its old decoding until
// the next start. Returns how many rows changed.
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
		  COALESCE((decoded_metadata->>'not_ok_to_mqtt')::boolean, false), COALESCE((decoded_metadata->>'imported')::boolean, false),
		  channel_name, decoded_metadata->>'topic_root'
		FROM packet_log WHERE id < $1 AND `+staleDecodePred+` -- served by the partial index
		ORDER BY id DESC LIMIT $2 FOR UPDATE`, below, limit)
	if err != nil {
		return 0, 0, err
	}
	var (
		ids, kept               []int64
		ats, keptAts            []time.Time
		types, sigs, metas, chs []string
		ports                   []int32
		envs                    [][]byte
		keptChs, keptRoots      []*string
		keptChanged             []bool
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
			imp    bool
			ch     *string
			root   *string
		)
		if err := rows.Scan(&id, &at, &broker, &topic, &env, &also, &ty, &crypto, &inval, &notOK, &imp, &ch, &root); err != nil {
			rows.Close()
			return 0, 0, err
		}
		seen++
		last = id
		// A stripped envelope (payload zeroed: header-only and invalid rows,
		// opt-out NodeInfo and status) can never decode to more than the row
		// already holds; decoding it again would only lose what was kept.
		keep := func() {
			// The channel name and topic root come from whoever published
			// and are cleaned on every row, kept ones too (version 4).
			cch, croot := cleanShown(ch, ingest.MaxShownChannel), cleanShown(root, ingest.MaxShownRoot)
			kept, keptAts = append(kept, id), append(keptAts, at)
			keptChs, keptRoots = append(keptChs, cch), append(keptRoots, croot)
			keptChanged = append(keptChanged, !sameString(ch, cch) || !sameString(root, croot))
		}
		if stripped(ty, crypto, inval, notOK) {
			keep()
			continue
		}
		obs, perr := ingest.Process(ingest.RawMessage{BrokerID: broker, Topic: topic, Payload: env, ObservedAt: at}, o)
		if perr != nil {
			keep()
			continue
		}
		if len(also) > 0 && string(also) != "null" {
			_ = json.Unmarshal(also, &obs.Meta.AlsoVia)
		}
		obs.Meta.Imported = imp
		meta, err := json.Marshal(obs.Meta)
		if err != nil {
			rows.Close()
			return 0, 0, err
		}
		ids, ats, types, ports, sigs = append(ids, id), append(ats, at), append(types, obs.PacketType), append(ports, obs.Portnum), append(sigs, string(obs.SignatureStatus))
		metas, envs, chs = append(metas, string(meta)), append(envs, obs.EnvelopeBytes), append(chs, obs.Channel)
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
			decoded_metadata = u.meta::jsonb, envelope_bytes = u.env, channel_name = NULLIF(u.ch, ''), decode_version = $9, obs_row = NULL, obs_row_version = NULL
			FROM unnest($1::bigint[], $2::timestamptz[], $3::text[], $4::int[], $5::text[], $6::text[], $7::bytea[], $8::text[]) AS u(id, at, ty, port, sig, meta, env, ch)
			WHERE p.id = u.id AND p.observed_at = u.at`, ids, ats, types, ports, sigs, metas, envs, chs, ingest.DecodeVersion); err != nil {
			return 0, 0, err
		}
	}
	if len(kept) > 0 {
		// Only a cleaning that changed something rewrites more than the version.
		if _, err := tx.Exec(ctx, `UPDATE packet_log p SET decode_version = $6, channel_name = CASE WHEN u.changed THEN NULLIF(u.ch, '') ELSE p.channel_name END,
			  decoded_metadata = CASE WHEN u.changed AND u.root IS NOT NULL THEN jsonb_set(p.decoded_metadata, '{topic_root}', to_jsonb(u.root)) ELSE p.decoded_metadata END,
			  obs_row = CASE WHEN u.changed THEN NULL ELSE p.obs_row END,
			  obs_row_version = CASE WHEN u.changed THEN NULL ELSE p.obs_row_version END
			FROM unnest($1::bigint[], $2::timestamptz[], $3::text[], $4::text[], $5::bool[]) AS u(id, at, ch, root, changed)
			WHERE p.id = u.id AND p.observed_at = u.at`, kept, keptAts, keptChs, keptRoots, keptChanged, ingest.DecodeVersion); err != nil {
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

// cleanShown cleans a stored channel name or topic root as ingest does.
func cleanShown(s *string, max int) *string {
	if s == nil {
		return nil
	}
	c := ports.CleanString(*s, max)
	return &c
}

func sameString(a, b *string) bool {
	return (a == nil) == (b == nil) && (a == nil || *a == *b)
}
