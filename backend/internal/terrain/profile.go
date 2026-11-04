// Package terrain builds cross sections of the earth between two points
// from Kartverket's terrain model (Geonorge høydedata), and says whether a
// radio link between them is clear, grazing or blocked (D-143). Heights are
// fetched by the server, cached and stored: terrain does not change.
package terrain

import "math"

// The radio path: an antenna at the altitude its node reports, or else
// AboveGroundM above the terrain at its position; the earth's curvature with
// the usual 4/3 radius for radio; and the first Fresnel zone at EU868.
const (
	AboveGroundM = 2.0
	earthR       = 6_371_000.0
	kFactor      = 4.0 / 3.0
	wavelength   = 299_792_458.0 / 869.5e6
	StepM        = 200.0 // spacing of the cross section
	MaxLengthM   = 300_000.0
	// Clear: at least this much of the first Fresnel zone is free.
	ClearFresnel = 0.6
)

// Point is a position in degrees.
type Point struct{ Lat, Lon float64 }

// End is a link's end: where its node is, and the altitude it reports (m
// above sea level), if any.
type End struct {
	Point
	Alt *float64
}

// Distance in metres along the great circle.
func Distance(a, b Point) float64 {
	la1, lo1, la2, lo2 := a.Lat*math.Pi/180, a.Lon*math.Pi/180, b.Lat*math.Pi/180, b.Lon*math.Pi/180
	h := math.Pow(math.Sin((la2-la1)/2), 2) + math.Cos(la1)*math.Cos(la2)*math.Pow(math.Sin((lo2-lo1)/2), 2)
	return 2 * earthR * math.Asin(math.Sqrt(h))
}

func lerp(a, b Point, f float64) Point {
	return Point{a.Lat + (b.Lat-a.Lat)*f, a.Lon + (b.Lon-a.Lon)*f}
}

// Points are every point a cross section from a to b needs heights for:
// both ends, then the path every StepM.
func Points(a, b Point) []Point {
	out := []Point{a, b}
	n := steps(a, b)
	for i := 1; i < n; i++ {
		out = append(out, lerp(a, b, float64(i)/float64(n)))
	}
	return out
}

func steps(a, b Point) int { return max(2, int(Distance(a, b)/StepM)) }

// Sample is one point of a cross section, heights in metres above sea level.
type Sample struct {
	D       float64  `json:"d" doc:"Distance from the first end, m"`
	Lat     float64  `json:"lat"`
	Lon     float64  `json:"lon"`
	Ground  *float64 `json:"ground,omitempty" doc:"Terrain height; absent where the terrain model has none (abroad)"`
	Bulge   float64  `json:"bulge" doc:"How far the earth's curvature raises the ground here relative to the straight line, m"`
	Line    float64  `json:"line" doc:"Height of the straight line between the antennas"`
	Fresnel float64  `json:"fresnel" doc:"Radius of the first Fresnel zone, m"`
}

// Antenna is where a cross section puts an end's antenna.
type Antenna struct {
	Ground *float64 `json:"ground,omitempty" doc:"Terrain height at the end's position"`
	Height *float64 `json:"height,omitempty" doc:"Antenna height above sea level; absent when neither reported nor known from the terrain"`
	Source string   `json:"source" enum:"reported,terrain,none" doc:"reported: the altitude the node reports; terrain: the terrain plus 2 m"`
}

// Profile is a cross section and what it says about the link.
type Profile struct {
	Class   string  `json:"class" enum:"clear,grazing,blocked,unknown" doc:"clear: at least 60 % of the first Fresnel zone free; grazing: the line is free, the zone is not; blocked: terrain cuts the line; unknown: the terrain model does not cover enough of it"`
	LengthM float64 `json:"length_m"`
	A       Antenna `json:"a" doc:"The first end's antenna"`
	B       Antenna `json:"b" doc:"The second end's antenna"`
	// Worst is where the least of the Fresnel zone is free: its distance and
	// the free part, in Fresnel radii (negative: terrain above the line).
	WorstD         float64  `json:"worst_d"`
	WorstClearance float64  `json:"worst_clearance"`
	Samples        []Sample `json:"samples,omitempty"`
}

func antenna(e End, height func(Point) (float64, bool)) Antenna {
	var a Antenna
	if z, ok := height(e.Point); ok {
		a.Ground = &z
	}
	switch {
	case e.Alt != nil:
		v := *e.Alt
		a.Height, a.Source = &v, "reported"
	case a.Ground != nil:
		v := *a.Ground + AboveGroundM
		a.Height, a.Source = &v, "terrain"
	default:
		a.Source = "none"
	}
	return a
}

// Build makes the cross section from a to b; height returns the terrain
// height at a point, or false where the model has none.
func Build(a, b End, height func(Point) (float64, bool)) Profile {
	D := Distance(a.Point, b.Point)
	p := Profile{LengthM: math.Round(D), Class: "unknown", A: antenna(a, height), B: antenna(b, height)}
	if p.A.Height == nil || p.B.Height == nil || D < 1 {
		return p
	}
	ha, hb := *p.A.Height, *p.B.Height
	n := steps(a.Point, b.Point)
	known := 0
	worst := math.Inf(1)
	r := func(v float64, k float64) float64 { return math.Round(v*k) / k }
	for i := 1; i < n; i++ {
		f := float64(i) / float64(n)
		q := lerp(a.Point, b.Point, f)
		d1 := D * f
		d2 := D - d1
		s := Sample{D: math.Round(d1), Lat: r(q.Lat, 1e6), Lon: r(q.Lon, 1e6), Bulge: d1 * d2 / (2 * kFactor * earthR), Line: ha + (hb-ha)*f, Fresnel: math.Sqrt(wavelength * d1 * d2 / D)}
		if z, ok := height(q); ok {
			v := z
			s.Ground = &v
			known++
			if c := (s.Line - (z + s.Bulge)) / s.Fresnel; c < worst {
				worst, p.WorstD = c, s.D
			}
		}
		s.Bulge, s.Line, s.Fresnel = r(s.Bulge, 100), r(s.Line, 100), r(s.Fresnel, 100)
		p.Samples = append(p.Samples, s)
	}
	// The model covers Norway and its sea; a path mostly abroad cannot be judged.
	if known*2 < n-1 {
		return p
	}
	p.WorstClearance = r(worst, 100)
	switch {
	case p.WorstClearance >= ClearFresnel:
		p.Class = "clear"
	case p.WorstClearance >= 0:
		p.Class = "grazing"
	default:
		p.Class = "blocked"
	}
	return p
}
