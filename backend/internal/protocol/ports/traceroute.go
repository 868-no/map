package ports

import (
	"github.com/868-no/map/internal/protocol/pb"
)

// MaxRouteHops bounds each traceroute direction (firmware ROUTE_SIZE is 8).
const MaxRouteHops = 8

// snrUnknown is the firmware's INT8_MIN sentinel for an SNR it did not measure.
const snrUnknown = -128

// Hop is one node in a traceroute path. Unknown marks a firmware
// insertUnknownHops placeholder (NODENUM_BROADCAST): some node relayed the
// packet but did not record itself. Segments touching it yield no edge.
type Hop struct {
	ID      uint32 `json:"id"`
	Unknown bool   `json:"unknown,omitempty"`
}

// Traceroute is a RouteDiscovery sample. Route and RouteBack hold the
// intermediate hops only (origin and destination come from the packet). SNR
// arrays are in dB (wire value / 4); nil means unknown (INT8_MIN).
type Traceroute struct {
	Route      []Hop      `json:"route"`
	SNRTowards []*float64 `json:"snr_towards"`
	RouteBack  []Hop      `json:"route_back"`
	SNRBack    []*float64 `json:"snr_back"`
	RequestID  uint32     `json:"request_id,omitempty"`
	IsReply    bool       `json:"is_reply"`
	Valid      bool       `json:"valid"`
	Reason     string     `json:"reason,omitempty"`
}

func hops(ids []uint32) []Hop {
	out := make([]Hop, len(ids))
	for i, id := range ids {
		out[i] = Hop{ID: id, Unknown: id == 0xFFFFFFFF}
	}
	return out
}

func snrs(v []int32) []*float64 {
	out := make([]*float64, len(v))
	for i, s := range v {
		if s == snrUnknown || s < -128 || s > 127 {
			continue
		}
		f := float64(s) / 4
		out[i] = &f
	}
	return out
}

// decodeTraceroute parses RouteDiscovery. Structurally broken routes are
// stored with Valid=false (the packet itself was genuine traffic) and never
// produce edges.
func decodeTraceroute(d *pb.Data) (*Traceroute, error) {
	var r pb.RouteDiscovery
	if err := unmarshal.Unmarshal(d.GetPayload(), &r); err != nil {
		return nil, ErrInvalid
	}
	t := &Traceroute{
		Route: hops(r.GetRoute()), SNRTowards: snrs(r.GetSnrTowards()),
		RouteBack: hops(r.GetRouteBack()), SNRBack: snrs(r.GetSnrBack()),
		RequestID: d.GetRequestId(), IsReply: d.GetRequestId() != 0,
		Valid: true,
	}
	switch {
	case len(t.Route) > MaxRouteHops || len(t.RouteBack) > MaxRouteHops:
		t.Valid, t.Reason = false, "too_many_hops"
	case len(t.SNRTowards) > len(t.Route)+1 || len(t.SNRBack) > len(t.RouteBack)+1:
		t.Valid, t.Reason = false, "snr_length"
	case hasLoop(t.Route) || hasLoop(t.RouteBack):
		t.Valid, t.Reason = false, "loop"
	case hasZero(t.Route) || hasZero(t.RouteBack):
		t.Valid, t.Reason = false, "zero_node"
	}
	return t, nil
}

func hasLoop(h []Hop) bool {
	seen := map[uint32]bool{}
	for _, x := range h {
		if x.Unknown {
			continue
		}
		if seen[x.ID] {
			return true
		}
		seen[x.ID] = true
	}
	return false
}

func hasZero(h []Hop) bool {
	for _, x := range h {
		if x.ID == 0 {
			return true
		}
	}
	return false
}
