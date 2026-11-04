package terrain

import (
	"math"
	"testing"
)

func ptr(v float64) *float64 { return &v }

// Two antennas 20 km apart reporting 110 m, over flat ground at 0 m: the
// earth's bulge midway is about 5.9 m and the Fresnel radius about 41.5 m,
// so the line clears it. A ridge midway decides the class: 85 m leaves less
// than 60 % of the zone free, 120 m cuts the line.
func TestBuildClasses(t *testing.T) {
	a := End{Point{63.0, 10.0}, ptr(110)}
	b := End{Point{63.0 + 20_000.0/111_195, 10.0}, ptr(110)}
	mid := lerp(a.Point, b.Point, 0.5)
	for _, tc := range []struct {
		ridge float64
		want  string
	}{{0, "clear"}, {85, "grazing"}, {120, "blocked"}} {
		h := func(p Point) (float64, bool) {
			if Distance(p, mid) < 150 {
				return tc.ridge, true
			}
			return 0, true
		}
		p := Build(a, b, h)
		if p.Class != tc.want {
			t.Errorf("ridge %v m: %s (clearance %v at %v m), want %s", tc.ridge, p.Class, p.WorstClearance, p.WorstD, tc.want)
		}
		if *p.A.Height != 110 || p.A.Source != "reported" || *p.A.Ground != 0 || math.Abs(p.LengthM-20_000) > 50 || len(p.Samples) < 98 {
			t.Errorf("profile: antenna %+v length %v samples %d", p.A, p.LengthM, len(p.Samples))
		}
	}
	s := Build(a, b, func(Point) (float64, bool) { return 0, true }).Samples[49] // about midway
	if math.Abs(s.Bulge-5.9) > 0.1 || math.Abs(s.Fresnel-41.5) > 0.5 {
		t.Errorf("midway bulge %.2f fresnel %.2f", s.Bulge, s.Fresnel)
	}
}

// Without a reported altitude, the antenna is 2 m above the terrain.
func TestBuildAntennaOnTerrain(t *testing.T) {
	a, b := End{Point: Point{63.0, 10.0}}, End{Point{63.1, 10.0}, ptr(700)}
	p := Build(a, b, func(q Point) (float64, bool) { return 400, true })
	if p.A.Source != "terrain" || *p.A.Height != 402 || p.B.Source != "reported" || *p.B.Height != 700 {
		t.Fatalf("%+v %+v", p.A, p.B)
	}
	if p.Samples[0].Line <= 402 || p.Class != "clear" {
		t.Fatalf("line %v class %s", p.Samples[0].Line, p.Class)
	}
}

// Without an antenna height, or heights for most of the path, there is no class.
func TestBuildUnknown(t *testing.T) {
	a, b := End{Point: Point{63.0, 10.0}}, End{Point: Point{63.1, 10.0}}
	if p := Build(a, b, func(Point) (float64, bool) { return 0, false }); p.Class != "unknown" || p.A.Source != "none" {
		t.Fatalf("%+v", p)
	}
	a.Alt, b.Alt = ptr(100), ptr(100)
	half := func(q Point) (float64, bool) { return 0, q.Lat < 63.02 }
	if p := Build(a, b, half); p.Class != "unknown" {
		t.Fatalf("mostly unknown path: %s", p.Class)
	}
}

func TestKeyRoundTrip(t *testing.T) {
	p := Point{63.43021, 10.39507}
	k := keyOf(p)
	if q := k.point(); Distance(p, q) > 30 || keyOf(q) != k {
		t.Fatalf("%v → %v → %v", p, k, q)
	}
}
