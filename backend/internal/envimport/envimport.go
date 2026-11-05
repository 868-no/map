// Package envimport loads MQTT history recorded by another collector into
// packet_log through the same ingest.Process as live traffic (D-137): the
// same decoding, keys, signature checks and privacy stripping. Input is CSV,
// one envelope per line: receive time (Unix seconds, milliseconds,
// microseconds or nanoseconds) and the raw MQTT payload in hex.
//
// Such collectors (Meshstellar's service_envelopes) keep the payload but not
// the topic, so the topic is rebuilt from the envelope.
package envimport

import (
	"bufio"
	"context"
	"encoding/csv"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/868-no/map/internal/identity"
	"github.com/868-no/map/internal/ingest"
	"github.com/868-no/map/internal/protocol"
	"github.com/868-no/map/internal/protocol/pb"
	"github.com/868-no/map/internal/storage"
)

// GatewayRoots is the topic root each gateway last published under, from a
// broker's stored rows: "!xxxxxxxx" -> root.
// Last by observed_at: an earlier import stores older rows with higher ids.
func GatewayRoots(ctx context.Context, pool *pgxpool.Pool, broker string) (map[string]string, error) {
	rows, err := pool.Query(ctx, `SELECT DISTINCT ON (gateway_node_id) gateway_node_id, mqtt_topic FROM packet_log
		WHERE broker_id = $1 AND gateway_node_id IS NOT NULL ORDER BY gateway_node_id, observed_at DESC, id DESC`, broker)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]string{}
	for rows.Next() {
		var gw int64
		var topic string
		if err := rows.Scan(&gw, &topic); err != nil {
			return nil, err
		}
		if t := protocol.ParseTopic(topic); t.Root != "" {
			out[fmt.Sprintf("!%08x", uint32(gw))] = t.Root
		}
	}
	return out, rows.Err()
}

// FirstRow is when a broker's earliest row collected live was received
// (zero: none): the default --before. Rows an import stored are marked
// (decoded_metadata.imported) and left out, so after an interrupted import
// the bound is still the first live row and a re-run resumes where the last
// one stopped instead of skipping the rest as already collected (D-150).
// Scans past the broker's imported rows, oldest first: run once per import.
func FirstRow(ctx context.Context, pool *pgxpool.Pool, broker string) (time.Time, error) {
	var t *time.Time
	if err := pool.QueryRow(ctx, `SELECT min(observed_at) FROM packet_log
		WHERE broker_id = $1 AND NOT COALESCE((decoded_metadata->>'imported')::boolean, false)`, broker).Scan(&t); err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return time.Time{}, err
	}
	if t == nil {
		return time.Time{}, nil
	}
	return *t, nil
}

func FormatTime(t time.Time) string {
	if t.IsZero() {
		return "no limit"
	}
	return t.UTC().Format(time.RFC3339)
}

// Importer feeds recorded envelopes through ingest.Process into packet_log.
type Importer struct {
	Broker string            // configured broker: its keys and plaintext rules apply
	Root   string            // topic root for rebuilt topics
	Roots  map[string]string // per gateway ("!xxxxxxxx"): the root it publishes under, where known
	After  time.Time
	Before time.Time // zero: no upper bound
	DryRun bool
	Batch  int
	Opts   ingest.Options
	IDs    *identity.Store
	Pool   *pgxpool.Pool
	Log    *slog.Logger

	Stats       map[string]int
	First, Last time.Time // span of what was decoded

	seen      map[[16]byte]time.Time // observation keys within the dedupe window
	lastPrune time.Time
	prev      time.Time // the previous decoded line's receive time
	pending   []*ingest.Observation
}

// dedupeWindow is the live pipeline's: the same upload delivered twice
// (a QoS retry, a reconnect) within it is one reception.
const dedupeWindow = ingest.DedupeWindow

// Run reads CSV lines (receive time, payload hex) until EOF.
func (im *Importer) Run(ctx context.Context, in io.Reader) (err error) {
	if !im.DryRun && im.Pool != nil {
		// Rows land in past days: while this runs no day is cached as final,
		// and the history revision moves on both ends, so nothing read before
		// or during the import is reused (D-158).
		finish, err := storage.BeginHistoryChange(ctx, im.Pool)
		if err != nil {
			return err
		}
		defer func() {
			if ferr := finish(); ferr != nil {
				err = errors.Join(err, ferr)
			}
		}()
	}
	if im.Stats == nil {
		im.Stats = map[string]int{}
	}
	if im.seen == nil {
		im.seen = map[[16]byte]time.Time{}
	}
	if im.Batch <= 0 {
		im.Batch = 1000
	}
	r := csv.NewReader(bufio.NewReaderSize(in, 1<<20))
	r.FieldsPerRecord = -1
	r.ReuseRecord = true
	next := time.Now().Add(10 * time.Second)
	for line := 1; ; line++ {
		rec, err := r.Read()
		if err == io.EOF {
			break
		}
		// A bad line is skipped; any other error (I/O) would repeat forever.
		var pe *csv.ParseError
		if errors.As(err, &pe) {
			im.Stats["line malformed"]++
			continue
		}
		if err != nil {
			return err
		}
		if line == 1 && len(rec) > 0 && !isDigits(rec[0]) {
			continue // a header row
		}
		if err := im.one(ctx, rec); err != nil {
			return err
		}
		if time.Now().After(next) {
			im.Log.Info("progress", "lines", line, "at", FormatTime(im.Last))
			next = time.Now().Add(10 * time.Second)
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
	}
	return im.flush(ctx)
}

func absDur(d time.Duration) time.Duration {
	if d < 0 {
		return -d
	}
	return d
}

func isDigits(s string) bool {
	_, err := strconv.ParseInt(strings.TrimSpace(s), 10, 64)
	return err == nil
}

func (im *Importer) one(ctx context.Context, rec []string) error {
	if len(rec) < 2 {
		im.Stats["line malformed"]++
		return nil
	}
	at, ok := ParseStamp(rec[0])
	payload, err := hex.DecodeString(strings.TrimSpace(rec[1]))
	if !ok || err != nil {
		im.Stats["line malformed"]++
		return nil
	}
	im.Stats["read"]++
	if !at.After(im.After) {
		im.Stats["skipped: older than retention or --after"]++
		return nil
	}
	if !im.Before.IsZero() && !at.Before(im.Before) {
		im.Stats["skipped: not before --before (already collected live)"]++
		return nil
	}
	topic, why := RebuildTopic(im.Root, im.Roots, payload)
	if topic == "" {
		im.Stats["skipped: "+why]++
		return nil
	}
	obs, err := ingest.Process(ingest.RawMessage{BrokerID: im.Broker, Topic: topic, Payload: payload, ObservedAt: at}, im.Opts)
	if err != nil {
		im.Stats["rejected: "+ingest.Category(err)]++
		return nil
	}
	// Input is expected oldest first; a line out of order is still compared
	// both ways, so it is never taken for a copy of a later reception.
	if at.Before(im.prev) {
		im.Stats["out of order (earlier than the line before)"]++
	}
	im.prev = at
	if t, dup := im.seen[obs.ObservationKey]; dup && absDur(at.Sub(t)) < dedupeWindow {
		im.Stats["duplicate delivery"]++
		return nil
	}
	im.seen[obs.ObservationKey] = at
	if absDur(at.Sub(im.lastPrune)) > dedupeWindow {
		for k, t := range im.seen {
			if absDur(at.Sub(t)) >= dedupeWindow {
				delete(im.seen, k)
			}
		}
		im.lastPrune = at
	}
	obs.Meta.Imported = true
	if im.First.IsZero() || at.Before(im.First) {
		im.First = at
	}
	if at.After(im.Last) {
		im.Last = at
	}
	im.Stats[fmt.Sprintf("decoded: %s", obs.PacketType)]++
	o := obs
	im.pending = append(im.pending, &o)
	if len(im.pending) >= im.Batch {
		return im.flush(ctx)
	}
	return nil
}

// flush stores the pending rows, then records the identities they carry:
// promoted only once their rows have committed, as at ingest.
func (im *Importer) flush(ctx context.Context) error {
	if len(im.pending) == 0 {
		return nil
	}
	batch := im.pending
	im.pending = nil
	if !im.DryRun {
		// Rows a previous run stored are skipped by the insert itself; with
		// the default bound (FirstRow ignores imported rows) a re-run after
		// an interruption therefore adds only what is missing.
		if _, err := storage.InsertBatch(ctx, im.Pool, batch); err != nil {
			return fmt.Errorf("insert: %w", err)
		}
		im.Stats["stored (new, or already there from an earlier run)"] += len(batch)
	} else {
		im.Stats["would be stored (dry run)"] += len(batch)
	}
	for _, o := range batch {
		if o.Promote != nil && im.IDs.Promote(*o.Promote) {
			im.Stats["identities learned"]++
		}
	}
	return nil
}

// Report prints the counts.
func (im *Importer) Report(w io.Writer) {
	keys := make([]string, 0, len(im.Stats))
	for k := range im.Stats {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		fmt.Fprintf(w, "%9d  %s\n", im.Stats[k], k)
	}
	if !im.First.IsZero() {
		fmt.Fprintf(w, "imported span: %s to %s\n", FormatTime(im.First), FormatTime(im.Last))
	}
}

// ParseStamp reads a Unix time in seconds, milliseconds, microseconds or
// nanoseconds, told apart by magnitude (any of them for a date after 2001).
func ParseStamp(s string) (time.Time, bool) {
	v, err := strconv.ParseInt(strings.TrimSpace(s), 10, 64)
	if err != nil || v <= 0 {
		return time.Time{}, false
	}
	switch {
	case v > 1e17:
		return time.Unix(0, v), true
	case v > 1e14:
		return time.UnixMicro(v), true
	case v > 1e11:
		return time.UnixMilli(v), true
	default:
		return time.Unix(v, 0), true
	}
}

// RebuildTopic gives an envelope the topic it was published on, as far as
// the envelope tells: a node's own map report on <root>/2/map/, anything
// else on <root>/2/e/<channel_id>/<gateway_id>. The root is the gateway's
// own where roots knows it (its live rows show it), else root. Payloads
// that are not envelopes (JSON, status messages) have none.
func RebuildTopic(root string, roots map[string]string, payload []byte) (string, string) {
	env, err := protocol.ParseEnvelope(payload)
	if err != nil {
		return "", "not an envelope (" + err.Error() + ")"
	}
	gw := env.Raw.GetGatewayId()
	if r, ok := roots[gw]; ok {
		root = r
	}
	if env.Kind == protocol.PayloadDecoded && env.Packet.GetDecoded().GetPortnum() == pb.PortNum_MAP_REPORT_APP {
		return root + "/2/map/", ""
	}
	if env.ChannelID == "" || gw == "" || strings.ContainsAny(env.ChannelID+gw, "/+#") {
		return "", "no channel or gateway to rebuild a topic from"
	}
	if protocol.HasControl(env.ChannelID + gw) {
		return "", "control character in channel or gateway"
	}
	return root + "/2/e/" + env.ChannelID + "/" + gw, ""
}
