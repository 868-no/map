package graph

import "math"

// LatLon is a reported position in degrees.
type LatLon struct{ Lat, Lon float64 }

// DistanceM is the great-circle distance in metres.
func DistanceM(a, b LatLon) float64 {
	const r = math.Pi / 180
	dLat, dLon := (b.Lat-a.Lat)*r, (b.Lon-a.Lon)*r
	h := math.Sin(dLat/2)*math.Sin(dLat/2) + math.Cos(a.Lat*r)*math.Cos(b.Lat*r)*math.Sin(dLon/2)*math.Sin(dLon/2)
	return 2 * 6_371_000 * math.Asin(math.Sqrt(h))
}

// Range bound for relay candidates: the longest confirmed link in the window
// plus margin, never below MinRelayRangeM.
const (
	MinRelayRangeM  = 50_000
	RelayRangeSlack = 1.25
)

// RelayContext is what the window knows for narrowing a last-hop byte.
type RelayContext struct {
	Known     []uint32           // nodes observed or referenced in the window
	Pos       map[uint32]LatLon  // reported in-window positions (never estimates)
	Confirmed map[[2]uint32]bool // unordered pairs with NeighborInfo, traceroute or direct-RF evidence
	MaxRangeM float64
}

// NewRelayContext derives the confirmed pairs and range bound from samples
// that do not themselves depend on relay hints.
func NewRelayContext(known []uint32, pos map[uint32]LatLon, confirmed []Sample) RelayContext {
	c := RelayContext{Known: known, Pos: pos, Confirmed: map[[2]uint32]bool{}, MaxRangeM: MinRelayRangeM}
	longest := 0.0
	for _, s := range confirmed {
		if s.Ev == RelayHint {
			continue
		}
		c.Confirmed[pair(s.Src, s.Dst)] = true
		if a, ok := pos[s.Src]; ok {
			if b, ok := pos[s.Dst]; ok {
				longest = math.Max(longest, DistanceM(a, b))
			}
		}
	}
	c.MaxRangeM = math.Max(MinRelayRangeM, longest*RelayRangeSlack)
	return c
}

func pair(a, b uint32) [2]uint32 {
	if a > b {
		a, b = b, a
	}
	return [2]uint32{a, b}
}

// RelayResult classifies a hint resolution.
type RelayResult int

const (
	RelayUnmatched RelayResult = iota
	RelayResolved
	RelayAmbiguous
)

// ResolveRelay narrows a last-hop byte to one node, or none. A byte equal
// to the gateway's own low byte is ignored. Candidates are
// window nodes with that last byte other than origin and gateway. Those whose
// reported position is beyond radio range of the gateway are excluded
// (unpositioned candidates stay); if several remain, the single one with
// confirmed link evidence to the gateway wins. Anything else is unresolved.
func ResolveRelay(hint uint8, origin, gw uint32, c RelayContext) (uint32, RelayResult) {
	// A byte equal to the gateway's own is the gateway itself, not a relay
	// before it: never hand it to another node sharing that byte.
	if hint == 0 || hint == uint8(gw&0xff) {
		return 0, RelayUnmatched
	}
	gp, gwPos := c.Pos[gw]
	var cands []uint32
	for _, k := range c.Known {
		if uint8(k&0xff) != hint || k == origin || k == gw {
			continue
		}
		if p, ok := c.Pos[k]; ok && gwPos && DistanceM(p, gp) > c.MaxRangeM {
			continue
		}
		cands = append(cands, k)
	}
	switch len(cands) {
	case 0:
		return 0, RelayUnmatched
	case 1:
		return cands[0], RelayResolved
	}
	var linked []uint32
	for _, k := range cands {
		if c.Confirmed[pair(k, gw)] {
			linked = append(linked, k)
		}
	}
	if len(linked) == 1 {
		return linked[0], RelayResolved
	}
	return 0, RelayAmbiguous
}
