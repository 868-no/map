package graph

import (
	"fmt"
	"time"
)

// Hop mirrors ports.Hop without importing storage concerns.
type Hop struct {
	ID      uint32
	Unknown bool
}

// TracerouteRecord is one stored traceroute copy.
type TracerouteRecord struct {
	From, To   uint32 // packet header
	IsReply    bool
	Route      []Hop
	SNRTowards []*float64
	RouteBack  []Hop
	SNRBack    []*float64
	T          time.Time
	Logical    string
}

// TracerouteSamples derives only adjacent segments actually traversed.
//
// Firmware semantics: each node receiving the packet appends its SNR (and,
// unless it is the endpoint, itself) to the arrays, so snr_towards[k] is
// measured at the receiver of segment k of [origin, route...]. An extra
// trailing SNR (len(snr) == len(route)+1) means the endpoint received it,
// adding the final segment. For a request the forward origin is From; for a
// reply From is the original destination, so the forward path runs
// To -> route -> From and the return path From -> route_back -> To.
// Segments touching an unknown placeholder hop produce nothing. No shortcut
// from origin to destination is ever created.
func TracerouteSamples(r TracerouteRecord) []Sample {
	var out []Sample
	fwdOrigin, fwdDest := r.From, r.To
	if r.IsReply {
		fwdOrigin, fwdDest = r.To, r.From
	}
	out = append(out, segments(fwdOrigin, fwdDest, r.Route, r.SNRTowards, r.T, r.Logical, "f")...)
	if r.IsReply {
		out = append(out, segments(r.From, r.To, r.RouteBack, r.SNRBack, r.T, r.Logical, "b")...)
	}
	return out
}

func segments(origin, dest uint32, route []Hop, snr []*float64, t time.Time, logical, dir string) []Sample {
	seq := append([]Hop{{ID: origin}}, route...)
	if len(snr) == len(route)+1 {
		seq = append(seq, Hop{ID: dest})
	}
	var out []Sample
	for k := 0; k+1 < len(seq); k++ {
		a, b := seq[k], seq[k+1]
		if a.Unknown || b.Unknown {
			continue
		}
		var s *float64
		if k < len(snr) {
			s = snr[k]
		}
		out = append(out, Sample{Src: a.ID, Dst: b.ID, Ev: Traceroute, T: t, SNR: s,
			Key: fmt.Sprintf("%s:%s:%d", logical, dir, k)})
	}
	return out
}
