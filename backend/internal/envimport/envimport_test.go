package envimport

import (
	"bufio"
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"strings"
	"testing"
	"time"

	"google.golang.org/protobuf/proto"

	"github.com/868-no/map/internal/ingest"
	"github.com/868-no/map/internal/protocol"
	"github.com/868-no/map/internal/protocol/pb"
	"github.com/868-no/map/internal/security"
)

func TestParseStampTellsUnitsApartByMagnitude(t *testing.T) {
	want := time.Date(2026, 10, 31, 1, 32, 53, 0, time.UTC)
	for _, s := range []string{"1793410373", "1793410373000", "1793410373000000", "1793410373000000000", " 1793410373 "} {
		got, ok := ParseStamp(s)
		if !ok || !got.Equal(want) {
			t.Errorf("ParseStamp(%q) = %v %v, want %v", s, got, ok, want)
		}
	}
	for _, s := range []string{"", "x", "-5", "0", "12.5"} {
		if _, ok := ParseStamp(s); ok {
			t.Errorf("ParseStamp(%q) accepted", s)
		}
	}
}

// Every envelope of a real capture gets back the topic it was published on,
// up to the root (which the envelope does not hold): same kind, channel and
// gateway. Status messages are no envelopes and get none.
func TestRebuildTopicRestoresKindChannelAndGateway(t *testing.T) {
	f, err := os.Open("../../test/fixtures/captured/mqtt868-2026-10-31-long.txt")
	if err != nil {
		t.Skip("no capture")
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 1<<20), 1<<20)
	kinds := map[protocol.TopicKind]int{}
	for sc.Scan() {
		p := strings.SplitN(sc.Text(), "|", 4)
		if len(p) != 4 {
			continue
		}
		raw, _ := hex.DecodeString(p[3])
		orig := protocol.ParseTopic(p[2])
		got, why := RebuildTopic("msh/EU_868/NO", nil, raw)
		switch orig.Kind {
		case protocol.TopicEncrypted, protocol.TopicMap:
			if got == "" {
				t.Errorf("%s: no topic rebuilt (%s)", p[2], why)
				continue
			}
			r := protocol.ParseTopic(got)
			if r.Kind != orig.Kind || r.Channel != orig.Channel || r.Gateway != orig.Gateway || r.Root != "msh/EU_868/NO" {
				t.Errorf("%s rebuilt as %s", p[2], got)
			}
			kinds[orig.Kind]++
		case protocol.TopicStat:
			if got != "" {
				t.Errorf("status message %s got topic %s", p[2], got)
			}
		}
	}
	if kinds[protocol.TopicEncrypted] < 100 || kinds[protocol.TopicMap] == 0 {
		t.Errorf("too few envelopes checked: %v", kinds)
	}
}

// A gateway's own root, where known, replaces the default.
func TestRebuildTopicUsesTheGatewaysOwnRoot(t *testing.T) {
	f, err := os.Open("../../test/fixtures/captured/mqtt868-2026-10-31-30min.txt")
	if err != nil {
		t.Skip("no capture")
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 1<<20), 1<<20)
	for sc.Scan() {
		p := strings.SplitN(sc.Text(), "|", 4)
		if len(p) != 4 || !strings.Contains(p[2], "/Vestlandet/2/e/") {
			continue
		}
		raw, _ := hex.DecodeString(p[3])
		orig := protocol.ParseTopic(p[2])
		if got, _ := RebuildTopic("msh/EU_868/NO", map[string]string{orig.Gateway: orig.Root}, raw); got != p[2] {
			t.Errorf("rebuilt %s, published on %s", got, p[2])
		}
		return
	}
	t.Skip("no Vestlandet envelope in the capture")
}

type failingReader struct{}

func (failingReader) Read([]byte) (int, error) { return 0, errors.New("disk on fire") }

// A malformed line is counted and skipped; a read error ends the run.
func TestRunStopsOnReadError(t *testing.T) {
	im := &Importer{}
	err := im.Run(context.Background(), io.MultiReader(strings.NewReader("1,a\"b\n"), failingReader{}))
	if err == nil || err.Error() != "disk on fire" || im.Stats["line malformed"] != 1 {
		t.Fatalf("err %v, stats %v", err, im.Stats)
	}
}

// A copy of an envelope received well before an earlier line (input not
// strictly oldest first) is another reception, not a duplicate delivery;
// one within the window of it, either side, is a duplicate.
func TestDedupeComparesBothWays(t *testing.T) {
	kr, err := security.NewKeyring([]security.ChannelConfig{{Name: "LongFast", PSKs: []string{"AQ=="}, AcceptPlaintext: true}})
	if err != nil {
		t.Fatal(err)
	}
	env, err := proto.Marshal(&pb.ServiceEnvelope{ChannelId: "LongFast", GatewayId: "!aabbccdd", Packet: &pb.MeshPacket{
		From: 0x11111111, To: 0xffffffff, Id: 7, HopStart: 3, HopLimit: 3,
		PayloadVariant: &pb.MeshPacket_Decoded{Decoded: &pb.Data{Portnum: pb.PortNum_TEXT_MESSAGE_APP, Payload: []byte("hi")}},
	}})
	if err != nil {
		t.Fatal(err)
	}
	t0 := time.Date(2026, 10, 31, 12, 0, 0, 0, time.UTC)
	var in strings.Builder
	for _, at := range []time.Time{t0, t0.Add(-30 * time.Minute), t0.Add(-25 * time.Minute), t0.Add(20 * time.Minute)} {
		fmt.Fprintf(&in, "%d,%x\n", at.Unix(), env)
	}
	im := &Importer{Broker: "b", Root: "msh/EU_868", DryRun: true, Opts: ingest.Options{Keyring: kr, Identities: noIDs{}, KeyBudget: 4}, Log: slog.New(slog.DiscardHandler)}
	if err := im.Run(context.Background(), strings.NewReader(in.String())); err != nil {
		t.Fatal(err)
	}
	if im.Stats["would be stored (dry run)"] != 3 || im.Stats["duplicate delivery"] != 1 || im.Stats["out of order (earlier than the line before)"] != 1 {
		t.Fatalf("stats %v", im.Stats)
	}
	if !im.First.Equal(t0.Add(-30*time.Minute)) || !im.Last.Equal(t0.Add(20*time.Minute)) {
		t.Fatalf("span %v to %v", im.First, im.Last)
	}
}

// Channel ids with control characters get no topic (gateway ids are already
// checked as node ids by ParseEnvelope): Postgres
// text cannot hold NUL, and the import would fail at that line every run.
func TestRebuildTopicRejectsControlCharacters(t *testing.T) {
	for _, c := range []struct{ ch, gw string }{{"Long\x00Fast", "!aabbccdd"}, {"Long\nFast", "!aabbccdd"}, {"Long\u0085Fast", "!aabbccdd"}, {"Long\x7fFast", "!aabbccdd"}} {
		env, err := proto.Marshal(&pb.ServiceEnvelope{ChannelId: c.ch, GatewayId: c.gw, Packet: &pb.MeshPacket{
			From: 0x11111111, To: 0xffffffff, Id: 7,
			PayloadVariant: &pb.MeshPacket_Encrypted{Encrypted: []byte{1, 2, 3, 4}},
		}})
		if err != nil {
			t.Fatal(err)
		}
		if got, why := RebuildTopic("msh/EU_868", nil, env); got != "" || why != "control character in channel or gateway" {
			t.Errorf("%q/%q: topic %q (%s)", c.ch, c.gw, got, why)
		}
	}
}

// sqlStateErr is a database error with a SQLSTATE, as the driver's.
type sqlStateErr string

func (e sqlStateErr) Error() string    { return "SQLSTATE " + string(e) }
func (e sqlStateErr) SQLState() string { return string(e) }

// A row the database refuses on its data is skipped and counted; the rest
// of its batch is stored and the import goes on. A batch refused whole is
// the database's fault, and stops the import.
func TestImportSkipsRowsTheDatabaseRefuses(t *testing.T) {
	kr, err := security.NewKeyring([]security.ChannelConfig{{Name: "LongFast", PSKs: []string{"AQ=="}, AcceptPlaintext: true}})
	if err != nil {
		t.Fatal(err)
	}
	t0 := time.Date(2026, 10, 31, 12, 0, 0, 0, time.UTC)
	var in strings.Builder
	for i := range 7 {
		env, err := proto.Marshal(&pb.ServiceEnvelope{ChannelId: "LongFast", GatewayId: "!aabbccdd", Packet: &pb.MeshPacket{
			From: 0x11111111, To: 0xffffffff, Id: uint32(100 + i), HopStart: 3, HopLimit: 3,
			PayloadVariant: &pb.MeshPacket_Decoded{Decoded: &pb.Data{Portnum: pb.PortNum_TEXT_MESSAGE_APP, Payload: []byte("hi")}},
		}})
		if err != nil {
			t.Fatal(err)
		}
		fmt.Fprintf(&in, "%d,%x\n", t0.Add(time.Duration(i)*time.Minute).Unix(), env)
	}
	bad := func(o *ingest.Observation) bool { return o.PacketID == 102 || o.PacketID == 105 }
	var stored []uint32
	inserts := 0
	im := &Importer{Broker: "b", Root: "msh/EU_868", Batch: 4, Opts: ingest.Options{Keyring: kr, Identities: noIDs{}, KeyBudget: 4}, Log: slog.New(slog.DiscardHandler)}
	im.insert = func(_ context.Context, rows []*ingest.Observation) ([]int64, error) {
		inserts++
		for _, o := range rows {
			if bad(o) {
				return nil, fmt.Errorf("copy: %w", sqlStateErr("22021"))
			}
		}
		for _, o := range rows {
			stored = append(stored, o.PacketID)
		}
		return make([]int64, len(rows)), nil
	}
	if err := im.Run(context.Background(), strings.NewReader(in.String())); err != nil {
		t.Fatal(err)
	}
	if fmt.Sprint(stored) != "[100 101 103 104 106]" || im.Stats["skipped: the database refused the row"] != 2 ||
		im.Stats["stored (new, or already there from an earlier run)"] != 5 {
		t.Fatalf("stored %v, stats %v", stored, im.Stats)
	}
	// Every row of a batch refused: not skipped one by one, but an error.
	im = &Importer{Broker: "b", Root: "msh/EU_868", Batch: 4, Opts: im.Opts, Log: im.Log}
	im.insert = func(context.Context, []*ingest.Observation) ([]int64, error) {
		return nil, sqlStateErr("23502")
	}
	if err := im.Run(context.Background(), strings.NewReader(in.String())); err == nil || im.Stats["skipped: the database refused the row"] != 0 {
		t.Fatalf("a batch refused whole: err %v, stats %v", err, im.Stats)
	}
	// Any other error stops the import at once.
	im = &Importer{Broker: "b", Root: "msh/EU_868", Batch: 4, Opts: im.Opts, Log: im.Log}
	im.insert = func(context.Context, []*ingest.Observation) ([]int64, error) { return nil, errors.New("db down") }
	if err := im.Run(context.Background(), strings.NewReader(in.String())); err == nil {
		t.Fatal("an outage did not stop the import")
	}
}

type noIDs struct{}

func (noIDs) Lookup(uint32) (security.Identity, bool) { return security.Identity{}, false }
