package api

import (
	"bytes"
	"encoding/base64"
	"strings"
	"testing"

	"google.golang.org/protobuf/encoding/protowire"
	"google.golang.org/protobuf/proto"

	"github.com/868-no/map/internal/protocol/pb"
	"github.com/868-no/map/internal/protocol/ports"
)

// D-213: the link is the apps' shared-contact form, a SharedContact with the
// node number and the User as the node announced it, key included.
func TestContactURL(t *testing.T) {
	key := bytes.Repeat([]byte{7}, 32)
	ni := ports.NodeInfo{LongName: "Grefsenkollen", ShortName: "GRF", HwModel: "HELTEC_V3", Role: "ROUTER",
		PublicKey: base64.StdEncoding.EncodeToString(key)}
	url, err := contactURL(0xbfa97d12, ni)
	if err != nil {
		t.Fatal(err)
	}
	payload, ok := strings.CutPrefix(url, "https://meshtastic.org/v/#")
	if !ok || strings.ContainsAny(payload, "+/=") {
		t.Fatalf("want base64url without padding after the prefix: %s", url)
	}
	b, err := base64.RawURLEncoding.DecodeString(payload)
	if err != nil {
		t.Fatal(err)
	}
	var num uint64
	var u pb.User
	for len(b) > 0 {
		f, ty, n := protowire.ConsumeTag(b)
		b = b[n:]
		switch {
		case f == 1 && ty == protowire.VarintType:
			num, n = protowire.ConsumeVarint(b)
		case f == 2 && ty == protowire.BytesType:
			var v []byte
			v, n = protowire.ConsumeBytes(b)
			if err := proto.Unmarshal(v, &u); err != nil {
				t.Fatal(err)
			}
		default:
			t.Fatalf("unexpected field %d", f)
		}
		if n < 0 {
			t.Fatal("truncated")
		}
		b = b[n:]
	}
	if num != 0xbfa97d12 || u.GetId() != "!bfa97d12" || u.GetLongName() != "Grefsenkollen" || u.GetShortName() != "GRF" ||
		u.GetHwModel() != pb.HardwareModel_HELTEC_V3 || u.GetRole() != pb.Config_DeviceConfig_ROUTER || !bytes.Equal(u.GetPublicKey(), key) {
		t.Fatalf("decoded %d %v", num, &u)
	}

	// No key or no name: no contact (a keyless one would erase the radio's key).
	if _, err := contactURL(1, ports.NodeInfo{LongName: "A"}); err == nil {
		t.Fatal("keyless contact")
	}
	if _, err := contactURL(1, ports.NodeInfo{PublicKey: ni.PublicKey}); err == nil {
		t.Fatal("nameless contact")
	}
}
