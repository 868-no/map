// Package graph folds in-window evidence into a directed, weighted RF link
// graph (spec §7). It is pure: callers supply evidence already restricted to
// the window; nothing here can reach outside it.
package graph

import (
	"math"
	"slices"
	"sort"
	"time"
)

// Evidence types in decreasing confidence order.
type Evidence uint8

const (
	Neighbor   Evidence = iota // NeighborInfo: reporter hears neighbour (high)
	Traceroute                 // adjacent traceroute segment (high)
	DirectRF                   // gateway received an unrelayed packet (medium)
	RelayHint                  // unique last-byte relay match (low, inferred)
)

func (e Evidence) String() string {
	return [...]string{"neighbor", "traceroute", "direct_rf", "relay_hint"}[e]
}

// Sample is one piece of evidence that Src was heard by Dst. SNR/RSSI are
// measured at Dst. Key deduplicates evidence derived from one RF event
// (e.g. one logical NeighborInfo packet uplinked by several gateways).
type Sample struct {
	Src, Dst uint32
	Ev       Evidence
	T        time.Time
	SNR      *float64
	RSSI     *float64
	Key      string
}

// Stats summarises a metric.
type Stats struct {
	N      int      `json:"n"`
	Median *float64 `json:"median,omitempty"`
	Min    *float64 `json:"min,omitempty"`
	Max    *float64 `json:"max,omitempty"`
	Last   *float64 `json:"last,omitempty"`
}

// EvidenceCounts counts independent samples per evidence type.
type EvidenceCounts struct {
	Neighbor   int `json:"neighbor"`
	Traceroute int `json:"traceroute"`
	DirectRF   int `json:"direct_rf"`
	RelayHint  int `json:"relay_hint"`
}

// Edge is directed Src -> Dst (Dst heard Src).
type Edge struct {
	Src        string         `json:"src" example:"!a1b2c3d4"`
	Dst        string         `json:"dst" example:"!0badf00d"`
	SrcNum     uint32         `json:"src_num"`
	DstNum     uint32         `json:"dst_num"`
	Evidence   EvidenceCounts `json:"evidence"`
	Samples    int            `json:"samples"`
	Confidence string         `json:"confidence" enum:"high,medium,low"`
	Inferred   bool           `json:"inferred" doc:"true when supported only by relay-hint inference"`
	Reason     string         `json:"reason"`
	SNR        Stats          `json:"snr" doc:"dB measured at dst"`
	RSSI       Stats          `json:"rssi" doc:"dBm measured at dst (gateway receptions only)"`
	FirstAt    time.Time      `json:"first_at"`
	LastAt     time.Time      `json:"last_at"`
}

type acc struct {
	src, dst uint32
	keys     map[string]bool
	counts   EvidenceCounts
	snr      []timed
	rssi     []timed
	first    time.Time
	last     time.Time
}

type timed struct {
	t time.Time
	v float64
}

// Reduce folds samples into edges. Self-links and invalid ids are dropped;
// duplicate samples (same Key, same direction, same evidence) count once.
func Reduce(samples []Sample, nodeID func(uint32) string) []Edge {
	m := map[[2]uint32]*acc{}
	for _, s := range samples {
		if s.Src == s.Dst || s.Src == 0 || s.Dst == 0 || s.Src == 0xFFFFFFFF || s.Dst == 0xFFFFFFFF {
			continue
		}
		k := [2]uint32{s.Src, s.Dst}
		a := m[k]
		if a == nil {
			a = &acc{src: s.Src, dst: s.Dst, keys: map[string]bool{}, first: s.T, last: s.T}
			m[k] = a
		}
		dk := s.Ev.String() + "|" + s.Key
		if s.Key != "" && a.keys[dk] {
			continue
		}
		a.keys[dk] = true
		switch s.Ev {
		case Neighbor:
			a.counts.Neighbor++
		case Traceroute:
			a.counts.Traceroute++
		case DirectRF:
			a.counts.DirectRF++
		case RelayHint:
			a.counts.RelayHint++
		}
		if s.SNR != nil && !math.IsNaN(*s.SNR) {
			a.snr = append(a.snr, timed{s.T, *s.SNR})
		}
		if s.RSSI != nil && !math.IsNaN(*s.RSSI) {
			a.rssi = append(a.rssi, timed{s.T, *s.RSSI})
		}
		if s.T.Before(a.first) {
			a.first = s.T
		}
		if s.T.After(a.last) {
			a.last = s.T
		}
	}
	out := make([]Edge, 0, len(m))
	for _, a := range m {
		e := Edge{Src: nodeID(a.src), Dst: nodeID(a.dst), SrcNum: a.src, DstNum: a.dst, Evidence: a.counts,
			FirstAt: a.first, LastAt: a.last, SNR: stats(a.snr), RSSI: stats(a.rssi)}
		e.Samples = a.counts.Neighbor + a.counts.Traceroute + a.counts.DirectRF + a.counts.RelayHint
		e.Confidence, e.Inferred, e.Reason = confidence(a.counts)
		out = append(out, e)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Samples != out[j].Samples {
			return out[i].Samples > out[j].Samples
		}
		if out[i].SrcNum != out[j].SrcNum {
			return out[i].SrcNum < out[j].SrcNum
		}
		return out[i].DstNum < out[j].DstNum
	})
	return out
}

// confidence ranks provenance: neighbor/traceroute high, direct RF medium,
// relay hint low (inferred). Independent types corroborate.
func confidence(c EvidenceCounts) (string, bool, string) {
	types := 0
	for _, n := range []int{c.Neighbor, c.Traceroute, c.DirectRF, c.RelayHint} {
		if n > 0 {
			types++
		}
	}
	switch {
	case c.Neighbor > 0 || c.Traceroute > 0:
		if types > 1 {
			return "high", false, "reported by NeighborInfo/traceroute and corroborated by other evidence"
		}
		if c.Neighbor > 0 {
			return "high", false, "reported by NeighborInfo"
		}
		return "high", false, "observed traceroute segment"
	case c.DirectRF > 0:
		if c.RelayHint > 0 {
			return "medium", false, "direct gateway RF reception, corroborated by relay hints"
		}
		return "medium", false, "direct gateway RF reception (zero-hop packet)"
	default:
		return "low", true, "inferred from unique relay-node byte; not directly confirmed"
	}
}

func stats(v []timed) Stats {
	if len(v) == 0 {
		return Stats{}
	}
	vals := make([]float64, len(v))
	last := v[0]
	for i, x := range v {
		vals[i] = x.v
		if x.t.After(last.t) {
			last = x
		}
	}
	slices.Sort(vals)
	med := vals[len(vals)/2]
	if len(vals)%2 == 0 {
		med = (vals[len(vals)/2-1] + vals[len(vals)/2]) / 2
	}
	r := func(f float64) *float64 { f = math.Round(f*100) / 100; return &f }
	return Stats{N: len(vals), Median: r(med), Min: r(vals[0]), Max: r(vals[len(vals)-1]), Last: r(last.v)}
}
