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
// sender, gateway and channel. A second run adds nothing, and by default
// nothing at or after the broker's first stored row is imported.
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
		fmt.Fprintf(&csv, "%d,%s\n", at.UnixNano(), strings.ToUpper(p[3]))
		obs, err := ingest.Process(ingest.RawMessage{BrokerID: "no868", Topic: p[2], Payload: raw, ObservedAt: at}, liveOpts)
		if err != nil {
			continue
		}
		var gw uint32
		if obs.Gateway != nil {
			gw = *obs.Gateway
		}
		live[obs.ObservationKey] = row{obs.PacketType, obs.Source, gw, obs.Channel, p[1] == "1"}
		if obs.Promote != nil {
			if _, ok := learned[obs.Promote.Node]; !ok {
				learned[obs.Promote.Node] = *obs.Promote
			}
		}
	}
	if len(live) < 200 {
		t.Fatalf("capture gave only %d receptions", len(live))
	}

	run := func(before time.Time) *envimport.Importer {
		ids := identity.New(func(ctx context.Context) ([]storage.IdentityRow, error) {
			return storage.VerifiedIdentities(ctx, pool, nil)
		}, quiet)
		if err := ids.Reload(ctx); err != nil {
			t.Fatal(err)
		}
		im := &envimport.Importer{
			Broker: "no868", Root: "msh/EU_868/NO", After: time.Unix(0, 0), Before: before, Batch: 250,
			Opts: ingest.Options{Keyring: kr, Identities: ids, KeyBudget: 4, AcceptRetained: func(string) bool { return true }},
			IDs:  ids, Pool: pool, Log: quiet,
		}
		if err := im.Run(ctx, strings.NewReader(csv.String())); err != nil {
			t.Fatal(err)
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
	first, err := envimport.FirstRow(ctx, pool, "no868")
	if err != nil || first.IsZero() {
		t.Fatalf("first row: %v %v", first, err)
	}
	if im := run(first); im.First.Before(first) && !im.First.IsZero() {
		t.Errorf("imported %s, before the broker's first row %s was the bound", im.First, first)
	}
	if got := run(first).Stats["skipped: not before --before (already collected live)"]; got < lines-10 {
		t.Errorf("only %d of %d lines skipped as already collected live", got, lines)
	}
}
