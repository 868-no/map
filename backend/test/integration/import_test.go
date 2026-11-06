//go:build integration

package integration

import (
	"bufio"
	"context"
	"encoding/hex"
	"fmt"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/868-no/map/internal/envimport"
	"github.com/868-no/map/internal/identity"
	"github.com/868-no/map/internal/ingest"
	"github.com/868-no/map/internal/security"
	"github.com/868-no/map/internal/storage"
)

type learnIDs map[uint32]security.Identity

func (m learnIDs) Lookup(n uint32) (security.Identity, bool) { id, ok := m[n]; return id, ok }

// Imported history must be stored as live ingest would have stored it
// (D-137): a real capture, published topics and all, through Process, and
// the same payloads with their topics thrown away (as Meshstellar keeps
// them), rebuilt and imported, give the same receptions with the same type,
// sender, gateway and channel. A second run adds nothing. By default nothing
// at or after the broker's first live row is imported, imported rows never
// move that bound, and so a re-run with the default bound completes an
// interrupted import (D-150).
func TestImportEnvelopesMatchesLiveIngest(t *testing.T) {
	pool := freshDB(t)
	ctx := context.Background()
	kr, err := security.NewKeyring([]security.ChannelConfig{
		{Name: "NarrowFast", PSKs: []string{"AQ=="}, AcceptPlaintext: true},
		{Name: "LongFast", PSKs: []string{"AQ=="}, AcceptPlaintext: true},
	})
	if err != nil {
		t.Fatal(err)
	}
	f, err := os.Open("../fixtures/captured/mqtt868-2026-10-31-long.txt")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()

	type row struct {
		ty       string
		src      uint32
		gw       uint32
		ch       string
		retained bool
	}
	live := map[[16]byte]row{}
	liveAt := map[[16]byte]time.Time{}
	type line struct {
		at         time.Time
		topic, csv string
		raw        []byte
	}
	var input []line
	learned := learnIDs{}
	liveOpts := ingest.Options{Keyring: kr, Identities: learned, KeyBudget: 4, AcceptRetained: func(string) bool { return true }}
	var csv strings.Builder
	csv.WriteString("created_at,payload\n") // a header, as sqlite3 -header writes
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 1<<20), 1<<20)
	lines := 0
	for sc.Scan() {
		p := strings.SplitN(sc.Text(), "|", 4)
		if len(p) != 4 {
			continue
		}
		sec, frac, _ := strings.Cut(p[0], ".")
		s, _ := strconv.ParseInt(sec, 10, 64)
		ns, _ := strconv.ParseInt((frac + "000000000")[:9], 10, 64)
		at := time.Unix(s, ns)
		raw, _ := hex.DecodeString(p[3])
		lines++
		l := fmt.Sprintf("%d,%s\n", at.UnixNano(), strings.ToUpper(p[3]))
		csv.WriteString(l)
		input = append(input, line{at, p[2], l, raw})
		obs, err := ingest.Process(ingest.RawMessage{BrokerID: "no868", Topic: p[2], Payload: raw, ObservedAt: at}, liveOpts)
		if err != nil {
			continue
		}
		var gw uint32
		if obs.Gateway != nil {
			gw = *obs.Gateway
		}
		live[obs.ObservationKey] = row{obs.PacketType, obs.Source, gw, obs.Channel, p[1] == "1"}
		liveAt[obs.ObservationKey] = at
		if obs.Promote != nil {
			if _, ok := learned[obs.Promote.Node]; !ok {
				learned[obs.Promote.Node] = *obs.Promote
			}
		}
	}
	if len(live) < 200 {
		t.Fatalf("capture gave only %d receptions", len(live))
	}

	run := func(before time.Time, in ...string) *envimport.Importer {
		t.Helper()
		if len(in) == 0 {
			in = []string{csv.String()}
		}
		ids := identity.New(identity.StorageLoader(pool), quiet)
		if err := ids.Reload(ctx); err != nil {
			t.Fatal(err)
		}
		im := &envimport.Importer{
			Broker: "no868", Root: "msh/EU_868/NO", After: time.Unix(0, 0), Before: before, Batch: 250,
			Opts: ingest.Options{Keyring: kr, Identities: ids, KeyBudget: 4, AcceptRetained: func(string) bool { return true }},
			IDs:  ids, Pool: pool, Log: quiet,
		}
		hist, err := storage.History(ctx, pool)
		if err != nil {
			t.Fatal(err)
		}
		if err := im.Run(ctx, strings.NewReader(in[0])); err != nil {
			t.Fatal(err)
		}
		// The history revision moved on both ends, and the import lock is free (D-158).
		if h, err := storage.History(ctx, pool); err != nil || h.Rev != hist.Rev+2 || h.Importing {
			t.Fatalf("history after an import: %+v (before %+v) %v", h, hist, err)
		}
		return im
	}
	im := run(time.Time{})
	var sb strings.Builder
	im.Report(&sb)
	t.Logf("first run:\n%s", sb.String())

	rs, err := pool.Query(ctx, `SELECT observation_key, packet_type, source_node_id, COALESCE(gateway_node_id, 0), COALESCE(channel_name, '') FROM packet_log`)
	if err != nil {
		t.Fatal(err)
	}
	stored := map[[16]byte]row{}
	for rs.Next() {
		var k []byte
		var r row
		var src, gw int64
		if err := rs.Scan(&k, &r.ty, &src, &gw, &r.ch); err != nil {
			t.Fatal(err)
		}
		r.src, r.gw = uint32(src), uint32(gw)
		stored[[16]byte(k)] = r
	}
	rs.Close()
	missing, wrong := 0, 0
	for k, want := range live {
		got, ok := stored[k]
		if !ok {
			missing++
			if missing <= 5 {
				t.Errorf("reception not imported: %+v", want)
			}
			continue
		}
		want.retained = false
		if got != want {
			wrong++
			if wrong <= 5 {
				t.Errorf("imported as %+v, live ingest stores %+v", got, want)
			}
		}
	}
	for k, got := range stored {
		if _, ok := live[k]; !ok {
			t.Errorf("imported a reception live ingest would not store: %+v", got)
		}
	}
	if missing+wrong > 0 {
		t.Fatalf("%d of %d receptions missing, %d stored differently", missing, len(live), wrong)
	}

	n := count(t, pool, `SELECT count(*) FROM packet_log`)
	run(time.Time{})
	if again := count(t, pool, `SELECT count(*) FROM packet_log`); again != n {
		t.Errorf("a second run changed the row count from %d to %d", n, again)
	}
	// Imported rows are marked and never set the default bound.
	if first, err := envimport.FirstRow(ctx, pool, "no868"); err != nil || !first.IsZero() {
		t.Fatalf("first live row of an import-only log: %v %v", first, err)
	}
	if n := count(t, pool, `SELECT count(*) FROM packet_log WHERE NOT (decoded_metadata->>'imported')::boolean`); n != 0 {
		t.Fatalf("%d imported rows not marked as imported", n)
	}

	// The broker collected live from two thirds into the capture; an
	// import was interrupted a third of the way in. A re-run with the
	// default bound, the broker's first live row, completes it.
	if _, err := pool.Exec(ctx, `TRUNCATE packet_log`); err != nil {
		t.Fatal(err)
	}
	cut := input[2*len(input)/3].at
	var liveRows []*ingest.Observation
	for _, l := range input {
		if l.at.Before(cut) {
			continue
		}
		obs, err := ingest.Process(ingest.RawMessage{BrokerID: "no868", Topic: l.topic, Payload: l.raw, ObservedAt: l.at}, liveOpts)
		if err != nil {
			continue
		}
		liveRows = append(liveRows, &obs)
	}
	if _, err := storage.InsertBatch(ctx, pool, liveRows); err != nil {
		t.Fatal(err)
	}
	first, err := envimport.FirstRow(ctx, pool, "no868")
	if err != nil || first.Before(cut.Add(-time.Microsecond)) { // stored to the microsecond
		t.Fatalf("first live row %v (%v), live collection began %v", first, err, cut)
	}
	var partial strings.Builder
	for _, l := range input[:len(input)/3] {
		partial.WriteString(l.csv)
	}
	if im := run(first, partial.String()); im.First.IsZero() {
		t.Fatal("the interrupted run imported nothing")
	}
	again, err := envimport.FirstRow(ctx, pool, "no868")
	if err != nil || !again.Equal(first) {
		t.Fatalf("the interrupted import moved the default bound from %v to %v (%v)", first, again, err)
	}
	im = run(again)
	if im.Last.After(first) || !im.Last.After(input[len(input)/3].at) {
		t.Errorf("the re-run imported up to %v, bound %v", im.Last, first)
	}
	if got := im.Stats["skipped: not before --before (already collected live)"]; got == 0 || got > lines-lines/2 {
		t.Errorf("%d of %d lines skipped as already collected live", got, lines)
	}
	stored = map[[16]byte]row{}
	rs, err = pool.Query(ctx, `SELECT observation_key FROM packet_log`)
	if err != nil {
		t.Fatal(err)
	}
	for rs.Next() {
		var k []byte
		if err := rs.Scan(&k); err != nil {
			t.Fatal(err)
		}
		stored[[16]byte(k)] = row{}
	}
	rs.Close()
	missing = 0
	for k, at := range liveAt {
		if _, ok := stored[k]; !ok {
			missing++
			if missing <= 5 {
				t.Errorf("reception at %v not stored after the re-run (bound %v)", at, first)
			}
		}
	}
	if missing > 0 {
		t.Fatalf("%d of %d receptions missing after resuming", missing, len(liveAt))
	}
}

// Rows stored later into hours trends have already summed, anywhere in the
// range (history imported for one broker inside another's), and into an
// hour between summarised ones, are summed by the next refresh (D-151).
func TestTrendsSumHistoryImportedAnywhere(t *testing.T) {
	pool := freshDB(t)
	f := newFixture(t, pool)
	ctx := context.Background()
	f.position(base.Add(time.Hour), nodeA, gw1, 63.0)
	f.position(base.Add(30*time.Hour), nodeB, gw1, 63.1)
	var th storage.TrendHours
	now := base.Add(31 * time.Hour)
	if err := th.Refresh(ctx, pool, now); err != nil {
		t.Fatal(err)
	}
	if th.Len() != 2 {
		t.Fatalf("%d summarised hours, want 2", th.Len())
	}
	f.position(base.Add(time.Hour+20*time.Minute), nodeB, gw1, 63.1) // the oldest summarised hour
	f.position(base.Add(10*time.Hour), nodeA, gw1, 63.0)             // between summarised hours
	if err := th.Refresh(ctx, pool, now); err != nil {
		t.Fatal(err)
	}
	if h, _ := th.Hour(base.Add(time.Hour)); h.Packets != 2 || len(h.Nodes) != 2 {
		t.Errorf("oldest hour after the import: %+v", h)
	}
	if h, ok := th.Hour(base.Add(10 * time.Hour)); !ok || h.Packets != 1 {
		t.Errorf("hour between: %+v %v", h, ok)
	}
	if th.Len() != 3 {
		t.Errorf("%d summarised hours, want 3", th.Len())
	}
	// Nothing new: the next refreshes keep the same sums.
	for range 2 {
		if err := th.Refresh(ctx, pool, now); err != nil {
			t.Fatal(err)
		}
	}
	if h, _ := th.Hour(base.Add(time.Hour)); h.Packets != 2 || th.Len() != 3 {
		t.Errorf("after further refreshes: %+v (%d hours)", h, th.Len())
	}
}

// Decoding version 4 cleans channel names and topic roots stored before
// ingest cleaned them, on rows decoded again and on rows kept as they are
// (here one marked invalid), and keeps an imported row's mark (D-152).
func TestRedecodeCleansChannelAndRoot(t *testing.T) {
	pool := freshDB(t)
	f := newFixture(t, pool)
	ctx := context.Background()
	f.position(base.Add(time.Hour), nodeA, gw1, 63.0)
	f.position(base.Add(2*time.Hour), nodeB, gw1, 63.1)
	if _, err := pool.Exec(ctx, `UPDATE packet_log SET decode_version = 3, channel_name = 'Long‮Fast',
		decoded_metadata = decoded_metadata || '{"topic_root": "msh/‮EU_868", "imported": true}'::jsonb`); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE packet_log SET decoded_metadata = decoded_metadata || '{"invalid": "sig_invalid"}'::jsonb WHERE source_node_id = $1`, int64(nodeB)); err != nil {
		t.Fatal(err)
	}
	if _, err := storage.Redecode(ctx, pool, ingest.Options{Keyring: f.kr, Identities: fixtureIDs(f.ids), KeyBudget: 4}, quiet); err != nil {
		t.Fatal(err)
	}
	rs, err := pool.Query(ctx, `SELECT source_node_id, channel_name, decoded_metadata->>'topic_root', COALESCE(decoded_metadata->>'imported', ''), decode_version, obs_row IS NULL FROM packet_log`)
	if err != nil {
		t.Fatal(err)
	}
	defer rs.Close()
	n := 0
	for rs.Next() {
		var src int64
		var ch, root, imp string
		var dv int
		var rebuilt bool
		if err := rs.Scan(&src, &ch, &root, &imp, &dv, &rebuilt); err != nil {
			t.Fatal(err)
		}
		n++
		if ch != "LongFast" || dv != ingest.DecodeVersion || !rebuilt || imp != "true" {
			t.Errorf("node %x: channel %q, decode version %d, encoding dropped %v, imported %q", src, ch, dv, rebuilt, imp)
		}
		if src == int64(nodeB) && root != "msh/EU_868" {
			t.Errorf("kept row's topic root %q", root)
		}
		if src == int64(nodeA) && strings.ContainsRune(root, '‮') {
			t.Errorf("decoded row's topic root %q", root)
		}
	}
	if n != 2 {
		t.Fatalf("%d rows", n)
	}
}
