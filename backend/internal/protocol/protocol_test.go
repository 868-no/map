package protocol

import (
	"errors"
	"testing"

	"google.golang.org/protobuf/proto"

	"github.com/868-no/map/internal/protocol/pb"
	"pgregory.net/rapid"
)

func TestParseTopic(t *testing.T) {
	cases := []struct {
		in   string
		want Topic
	}{
		{"msh/EU_868/NO/Østlandet/2/e/NarrowFast/!06f53d8c", Topic{TopicEncrypted, "msh/EU_868/NO/Østlandet", "NarrowFast", "!06f53d8c"}},
		{"msh/EU_868/2/e/LongFast/!aabbccdd", Topic{TopicEncrypted, "msh/EU_868", "LongFast", "!aabbccdd"}},
		{"msh/2/c/LongFast/!aabbccdd", Topic{TopicLegacyC, "msh", "LongFast", "!aabbccdd"}},
		{"msh/EU_868/NO/2/stat/!06f53d8c", Topic{TopicStat, "msh/EU_868/NO", "", "!06f53d8c"}},
		{"msh/EU_868/NO/2/json/NarrowFast/!06f53d8c", Topic{Kind: TopicJSON, Root: "msh/EU_868/NO"}},
		{"msh/EU_868/2/map/", Topic{Kind: TopicMap, Root: "msh/EU_868"}},
		{"msh/EU_868/2/e/LongFast", Topic{}},
		{"msh/EU_868/2/e//!aabbccdd", Topic{}},
		{"garbage", Topic{}},
		{"", Topic{}},
		// Control characters (Postgres text cannot hold NUL) are rejected.
		{"msh/EU_868/2/e/Long\x00Fast/!aabbccdd", Topic{}},
		{"msh/EU_868/2/e/LongFast/!aabb\nccdd", Topic{}},
		{"msh/EU\x7f868/2/e/LongFast/!aabbccdd", Topic{}},
		{"msh/EU_868/2/e/LongFast/!aabb\u0085ccdd", Topic{}},
		{"msh/EU_868/2/stat/!aabb\tccdd", Topic{}},
	}
	for _, c := range cases {
		if got := ParseTopic(c.in); got != c.want {
			t.Errorf("%q: got %+v want %+v", c.in, got, c.want)
		}
	}
}

func TestParseEnvelopeValidation(t *testing.T) {
	good := &pb.ServiceEnvelope{
		Packet:    &pb.MeshPacket{From: 0x12345678, Id: 1, PayloadVariant: &pb.MeshPacket_Encrypted{Encrypted: []byte{1, 2, 3}}},
		ChannelId: "LongFast", GatewayId: "!aabbccdd",
	}
	b, _ := proto.Marshal(good)
	env, err := ParseEnvelope(b)
	if err != nil || env.Gateway != 0xaabbccdd || env.Kind != PayloadEncrypted {
		t.Fatalf("good envelope: %+v %v", env, err)
	}
	bad := proto.Clone(good).(*pb.ServiceEnvelope)
	bad.GatewayId = "!zz"
	b, _ = proto.Marshal(bad)
	if _, err := ParseEnvelope(b); !errors.Is(err, ErrBadGateway) {
		t.Fatalf("bad gateway: %v", err)
	}
	bad = proto.Clone(good).(*pb.ServiceEnvelope)
	bad.Packet.From = 0xFFFFFFFF
	b, _ = proto.Marshal(bad)
	if _, err := ParseEnvelope(b); !errors.Is(err, ErrBadSender) {
		t.Fatalf("broadcast sender: %v", err)
	}
	if _, err := ParseEnvelope(make([]byte, MaxEnvelopeBytes+1)); !errors.Is(err, ErrOversize) {
		t.Fatal("oversize accepted")
	}
}

// Arbitrary bytes must never panic the parser (design §10.2 test 10).
func TestParseEnvelopeNeverPanics(t *testing.T) {
	rapid.Check(t, func(t *rapid.T) {
		b := rapid.SliceOfN(rapid.Byte(), 0, 2048).Draw(t, "b")
		_, _ = ParseEnvelope(b)
		_, _ = ParseData(b)
	})
}

func TestParseTopicNeverPanics(t *testing.T) {
	rapid.Check(t, func(t *rapid.T) {
		_ = ParseTopic(rapid.String().Draw(t, "s"))
	})
}
