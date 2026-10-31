package ingest

import (
	"bufio"
	"encoding/hex"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/868-no/map/internal/security"
)

// Real firmware traffic must never trip signature checks, and signed 2.8
// NodeInfo must verify through first contact (XEdDSA gate 3).
func TestCapturedTraffic(t *testing.T) {
	files, _ := filepath.Glob("../../test/fixtures/captured/*.txt")
	if len(files) == 0 {
		t.Skip("no captures")
	}
	for _, f := range files {
		t.Run(filepath.Base(f), func(t *testing.T) {
			kr, _ := security.NewKeyring([]security.ChannelConfig{
				{Name: "NarrowFast", PSKs: []string{"AQ=="}, AcceptPlaintext: true},
				{Name: "LongFast", PSKs: []string{"AQ=="}, AcceptPlaintext: true},
			})
			ids := mapIDs{}
			o := Options{Keyring: kr, Identities: ids, KeyBudget: 4}
			fh, err := os.Open(f)
			if err != nil {
				t.Fatal(err)
			}
			defer fh.Close()
			stats := map[string]int{}
			sc := bufio.NewScanner(fh)
			sc.Buffer(make([]byte, 1<<20), 1<<20)
			for sc.Scan() {
				p := strings.SplitN(sc.Text(), "|", 4)
				if len(p) != 4 {
					continue
				}
				ts, _ := strconv.ParseFloat(p[0], 64)
				raw, _ := hex.DecodeString(p[3])
				obs, err := Process(RawMessage{BrokerID: "cap", Topic: p[2], Payload: raw, Retained: p[1] == "1", ObservedAt: time.Unix(int64(ts), 0)}, o)
				if err != nil {
					stats["reject:"+Category(err)]++
					continue
				}
				stats[obs.PacketType+"/"+string(obs.SignatureStatus)]++
				if obs.Promote != nil {
					ids[obs.Promote.Node] = *obs.Promote
				}
			}
			t.Logf("%v", stats)
			for _, bad := range []string{"sig_invalid", "sig_malformed", "first_contact_invalid", "nodeinfo_key_mismatch", "malformed_proto", "payload_invalid"} {
				if stats["reject:"+bad] > 0 {
					t.Errorf("real traffic rejected as %s: %d", bad, stats["reject:"+bad])
				}
			}
			if stats["nodeinfo/verified"] == 0 || stats["telemetry/verified"] == 0 {
				t.Error("expected verified NodeInfo and Telemetry from real 2.8 nodes")
			}
		})
	}
}
