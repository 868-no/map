package ports

import (
	"testing"

	"google.golang.org/protobuf/proto"

	"github.com/868-no/map/internal/protocol/pb"
)

func data(t *testing.T, port pb.PortNum, m proto.Message) *pb.Data {
	t.Helper()
	b, err := proto.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	return &pb.Data{Portnum: port, Payload: b}
}

func i32(v int32) *int32 { return &v }

func TestTracerouteUnknownHopsAndSNRSentinel(t *testing.T) {
	d := data(t, pb.PortNum_TRACEROUTE_APP, &pb.RouteDiscovery{
		Route:      []uint32{0x11111111, 0xFFFFFFFF, 0x33333333},
		SnrTowards: []int32{40, -128, -10, 22},
	})
	got, err := Decode(d, 0xaaaaaaaa)
	if err != nil {
		t.Fatal(err)
	}
	tr := got.Traceroute
	if !tr.Valid {
		t.Fatalf("placeholder hop must not invalidate the route: %s", tr.Reason)
	}
	if !tr.Route[1].Unknown || tr.Route[0].Unknown {
		t.Fatal("unknown hop not marked")
	}
	if *tr.SNRTowards[0] != 10 || tr.SNRTowards[1] != nil || *tr.SNRTowards[2] != -2.5 {
		t.Fatalf("SNR scaling/sentinel wrong: %v %v %v", *tr.SNRTowards[0], tr.SNRTowards[1], *tr.SNRTowards[2])
	}
}

func TestTracerouteInvalidStructures(t *testing.T) {
	cases := map[string]*pb.RouteDiscovery{
		"loop":     {Route: []uint32{1, 2, 1}},
		"zero":     {Route: []uint32{0}},
		"snr_len":  {Route: []uint32{1}, SnrTowards: []int32{1, 2, 3}},
		"too_long": {Route: []uint32{1, 2, 3, 4, 5, 6, 7, 8, 9}},
	}
	for name, r := range cases {
		got, err := Decode(data(t, pb.PortNum_TRACEROUTE_APP, r), 0xaaaaaaaa)
		if err != nil || got.Traceroute.Valid {
			t.Errorf("%s: want stored-but-invalid, got valid=%v err=%v", name, got.Traceroute != nil && got.Traceroute.Valid, err)
		}
	}
}

func TestNeighborInfoKeepsFloatSNR(t *testing.T) {
	d := data(t, pb.PortNum_NEIGHBORINFO_APP, &pb.NeighborInfo{
		NodeId: 0xaaaaaaaa,
		Neighbors: []*pb.Neighbor{
			{NodeId: 0xbbbbbbbb, Snr: 6.25},
			{NodeId: 0xaaaaaaaa, Snr: 1}, // self: dropped
			{NodeId: 0, Snr: 1},          // invalid: dropped
		},
	})
	got, err := Decode(d, 0xaaaaaaaa)
	if err != nil {
		t.Fatal(err)
	}
	n := got.NeighborInfo
	if len(n.Neighbors) != 1 || *n.Neighbors[0].SNR != 6.25 || n.Dropped != 2 {
		t.Fatalf("got %+v", n)
	}
	if _, err := Decode(d, 0xcccccccc); err == nil {
		t.Fatal("report claiming another node_id must be rejected")
	}
}

func TestPositionValidation(t *testing.T) {
	ok, err := Decode(data(t, pb.PortNum_POSITION_APP, &pb.Position{LatitudeI: i32(634300000), LongitudeI: i32(104000000), PrecisionBits: 16}), 1)
	if err != nil || ok.Position.Lat != 63.43 || !ok.Position.PrecisionKnown {
		t.Fatalf("valid position: %+v %v", ok.Position, err)
	}
	p0, _ := Decode(data(t, pb.PortNum_POSITION_APP, &pb.Position{LatitudeI: i32(634300000), LongitudeI: i32(104000000)}), 1)
	if p0.Position == nil || p0.Position.PrecisionKnown {
		t.Fatal("precision 0 must be kept with precision_known=false")
	}
	absent, err := Decode(data(t, pb.PortNum_POSITION_APP, &pb.Position{LatitudeI: i32(0), LongitudeI: i32(0)}), 1)
	if err != nil || absent.Position != nil {
		t.Fatal("0/0 must be position-absent")
	}
	if _, err := Decode(data(t, pb.PortNum_POSITION_APP, &pb.Position{LatitudeI: i32(950000000), LongitudeI: i32(0)}), 1); err == nil {
		t.Fatal("lat 95 accepted")
	}
}

func TestNodeInfoSanitisesAndRejectsBadKeys(t *testing.T) {
	got, err := Decode(data(t, pb.PortNum_NODEINFO_APP, &pb.User{LongName: "Ola\x00‮Nordmann<script>", ShortName: "ON", PublicKey: make([]byte, 32)}), 1)
	if err != nil {
		t.Fatal(err)
	}
	if got.NodeInfo.LongName != "OlaNordmann<script>" {
		t.Fatalf("control/format chars not stripped: %q", got.NodeInfo.LongName)
	}
	if _, err := Decode(data(t, pb.PortNum_NODEINFO_APP, &pb.User{PublicKey: make([]byte, 31)}), 1); err == nil {
		t.Fatal("31-byte public key accepted")
	}
}

func TestTextBodiesNeverStored(t *testing.T) {
	got, err := Decode(&pb.Data{Portnum: pb.PortNum_TEXT_MESSAGE_APP, Payload: []byte("secret plans")}, 1)
	if err != nil || got.Text.Bytes != 12 {
		t.Fatal(err)
	}
}

func TestMalformedKnownPortRejected(t *testing.T) {
	if _, err := Decode(&pb.Data{Portnum: pb.PortNum_POSITION_APP, Payload: []byte{0xff, 0xff, 0xff}}, 1); err == nil {
		t.Fatal("garbage position accepted")
	}
	got, err := Decode(&pb.Data{Portnum: pb.PortNum(250), Payload: []byte{1, 2}}, 1)
	if err != nil || got.Type != TypeOther {
		t.Fatal("unknown well-formed port should be 'other'")
	}
}

// D-103: node status text, sanitised; store-and-forward kind and sizes only.
func TestNodeStatusAndStoreForward(t *testing.T) {
	d, err := Decode(data(t, pb.PortNum_NODE_STATUS_APP, &pb.StatusMessage{Status: "On the hill \x07until Friday"}), 1)
	if err != nil || d.Type != TypeNodeStatus || d.NodeStatus.Status != "On the hill until Friday" {
		t.Fatalf("status: %v %+v", err, d.NodeStatus)
	}
	text := []byte("a stored message nobody should see")
	d, err = Decode(data(t, pb.PortNum_STORE_FORWARD_APP, &pb.StoreAndForward{Rr: pb.StoreAndForward_ROUTER_TEXT_BROADCAST, Variant: &pb.StoreAndForward_Text{Text: text}}), 1)
	if err != nil || d.Type != TypeStoreForward || d.StoreForward.Kind != "router_text_broadcast" || d.StoreForward.TextBytes != len(text) {
		t.Fatalf("s&f text: %v %+v", err, d.StoreForward)
	}
	d, _ = Decode(data(t, pb.PortNum_STORE_FORWARD_APP, &pb.StoreAndForward{Rr: pb.StoreAndForward_ROUTER_HEARTBEAT, Variant: &pb.StoreAndForward_Heartbeat_{Heartbeat: &pb.StoreAndForward_Heartbeat{Period: 900}}}), 1)
	if d.StoreForward.Kind != "router_heartbeat" || d.StoreForward.Period != 900 {
		t.Fatalf("s&f heartbeat: %+v", d.StoreForward)
	}
	if _, err := Decode(&pb.Data{Portnum: pb.PortNum_STORE_FORWARD_APP, Payload: []byte{0xff, 0xff}}, 1); err == nil {
		t.Fatal("garbage store-and-forward decoded")
	}
}
