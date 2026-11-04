package envimport

import (
	"bufio"
	"encoding/hex"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/868-no/map/internal/protocol"
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
