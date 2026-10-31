package query

import (
	"testing"
	"time"
)

func TestChoosePosition(t *testing.T) {
	t0 := time.Date(2026, 10, 31, 12, 0, 0, 0, time.UTC)
	pos := func(src string, lat float64, bits uint32, at time.Duration) Position {
		return Position{Source: src, Lat: lat, Lon: 10.7, PrecisionBits: bits, PrecisionKnown: bits > 0, ObservedAt: t0.Add(at)}
	}
	cases := []struct {
		name string
		a, b Position
		want string
	}{
		// 14 bits: ~1.2 km error radius; 32 bits: exact. 200 m apart: overlapping.
		{"overlap: precise older wins", pos("position", 61.2232, 32, 0), pos("mapreport", 61.2250, 14, time.Hour), "position"},
		{"overlap: precise newer wins", pos("position", 61.2232, 13, 0), pos("mapreport", 61.2250, 16, time.Hour), "mapreport"},
		{"overlap, equal precision: newer", pos("position", 61.2232, 16, time.Hour), pos("mapreport", 61.2233, 16, 0), "position"},
		// 50 km apart: moving, so the newer report wins despite lower precision.
		{"apart: newer wins", pos("position", 61.0, 32, 0), pos("mapreport", 61.45, 14, time.Hour), "mapreport"},
		{"unknown precision: newer", pos("position", 61.2232, 0, time.Hour), pos("mapreport", 61.2232, 32, 0), "position"},
	}
	for _, c := range cases {
		if got := choosePosition(c.a, c.b).Source; got != c.want {
			t.Errorf("%s: got %s want %s", c.name, got, c.want)
		}
		if got := choosePosition(c.b, c.a).Source; got != c.want {
			t.Errorf("%s (swapped): got %s want %s", c.name, got, c.want)
		}
	}
}
