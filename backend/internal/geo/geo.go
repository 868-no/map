// Package geo estimates coarse locations of unpositioned nodes from direct
// RF links to positioned anchors (spec §8). It is pure: callers supply only
// in-window anchors and measurements. Results are estimates with explicit
// uncertainty, never precise pins; underdetermined cases yield nothing.
package geo

import (
	"fmt"
	"math"
	"sort"
	"time"
)

// Anchor is a node with an in-window, precise-enough reported position.
// ErrM is how far its true position may be from the reported one.
type Anchor struct {
	Node     uint32
	Lat, Lon float64
	ErrM     float64
}

// PrecisionErrorM is the worst-case distance between a Meshtastic position
// reported with the given precision bits and the true position. Firmware
// keeps the top bits of the 1e-7-degree coordinates and reports the centre
// of the cell, so the error is at most half the cell diagonal.
func PrecisionErrorM(bits uint32, lat float64) float64 {
	if bits >= 32 {
		return 0
	}
	cellDeg := math.Ldexp(1e-7, int(32-bits))
	halfLat := cellDeg / 2 * 111_320
	halfLon := halfLat * math.Cos(lat*math.Pi/180)
	return math.Hypot(halfLat, halfLon)
}

// Measurement summarises direct links between a target and one anchor.
type Measurement struct {
	Anchor  uint32
	SNR     *float64 // median dB over samples (either direction)
	RSSI    *float64 // median dBm (gateway receptions only)
	Samples int
	First   time.Time
	Last    time.Time
}

// Calibration is a log-distance path-loss model: RSSI = P0 - 10 n log10(d/1m).
type Calibration struct {
	P0DBm    float64 `yaml:"p0_dbm" json:"p0_dbm"`
	Exponent float64 `yaml:"path_loss_exponent" json:"path_loss_exponent"`
}

// Params are the acceptance gates.
type Params struct {
	MinAnchors         int     // >= 3
	MinSamples         int     // independent samples across anchors
	MinAnchorSpacingM  float64 // pairwise
	MinSpreadM         float64 // RMS distance of anchors from their centroid
	MinShapeRatio      float64 // minor/major axis of anchor spread (collinearity)
	MaxAnchorDistanceM float64 // anchors farther than this from the median anchor are outliers
	FloorM             float64 // minimum uncertainty radius
	UncalibratedFloorM float64
	Calibration        *Calibration
}

// DefaultParams are conservative defaults.
func DefaultParams() Params {
	return Params{MinAnchors: 3, MinSamples: 5, MinAnchorSpacingM: 200, MinSpreadM: 500, MinShapeRatio: 0.2,
		MaxAnchorDistanceM: 150_000, FloorM: 500, UncalibratedFloorM: 2000}
}

// Estimate is an approximate location with provenance.
type Estimate struct {
	Lat          float64   `json:"lat"`
	Lon          float64   `json:"lon"`
	UncertaintyM float64   `json:"uncertainty_radius_m"`
	Method       string    `json:"method" enum:"weighted_centroid,log_distance_wls"`
	Quality      string    `json:"quality" enum:"very_low,low"`
	AnchorCount  int       `json:"anchor_count"`
	SampleCount  int       `json:"sample_count"`
	Anchors      []string  `json:"anchors"`
	EvidenceFrom time.Time `json:"evidence_from"`
	EvidenceTo   time.Time `json:"evidence_to"`
	Reasons      []string  `json:"reasons"`
}

// Rejection explains why no estimate was produced.
type Rejection struct{ Reason string }

func (r *Rejection) Error() string { return r.Reason }

func reject(format string, a ...any) error { return &Rejection{Reason: fmt.Sprintf(format, a...)} }

// local tangent plane (east/north metres) around an origin
type enu struct{ lat0, lon0, kx, ky float64 }

func newENU(lat, lon float64) enu {
	const R = 6371008.8
	return enu{lat, lon, R * math.Cos(lat*math.Pi/180) * math.Pi / 180, R * math.Pi / 180}
}
func (e enu) to(lat, lon float64) (float64, float64) {
	return (lon - e.lon0) * e.kx, (lat - e.lat0) * e.ky
}
func (e enu) from(x, y float64) (float64, float64) { return e.lat0 + y/e.ky, e.lon0 + x/e.kx }

type pt struct {
	x, y float64
	m    Measurement
	a    Anchor
}

// Locate estimates one target. anchors must already exclude coarse or
// operator-excluded positions; measurements must be direct links only.
func Locate(anchors map[uint32]Anchor, ms []Measurement, p Params, nodeID func(uint32) string) (*Estimate, error) {
	var pts []pt
	for _, m := range ms {
		if a, ok := anchors[m.Anchor]; ok && m.Samples > 0 {
			pts = append(pts, pt{m: m, a: a})
		}
	}
	if len(pts) < p.MinAnchors {
		return nil, reject("only %d positioned anchors with direct links (need %d)", len(pts), p.MinAnchors)
	}
	// Outliers: anchors implausibly far from the median anchor.
	medLat, medLon := median(pts, func(q pt) float64 { return q.a.Lat }), median(pts, func(q pt) float64 { return q.a.Lon })
	e := newENU(medLat, medLon)
	kept := pts[:0]
	dropped := 0
	for _, q := range pts {
		q.x, q.y = e.to(q.a.Lat, q.a.Lon)
		if math.Hypot(q.x, q.y) > p.MaxAnchorDistanceM {
			dropped++
			continue
		}
		kept = append(kept, q)
	}
	pts = kept
	if len(pts) < p.MinAnchors {
		return nil, reject("inconsistent anchors: %d implausibly distant from the rest", dropped)
	}
	samples := 0
	for _, q := range pts {
		samples += q.m.Samples
	}
	if samples < p.MinSamples {
		return nil, reject("only %d independent samples (need %d)", samples, p.MinSamples)
	}
	for i := range pts {
		for j := i + 1; j < len(pts); j++ {
			if math.Hypot(pts[i].x-pts[j].x, pts[i].y-pts[j].y) < p.MinAnchorSpacingM {
				return nil, reject("anchors %s and %s are collocated (< %.0f m apart)", nodeID(pts[i].a.Node), nodeID(pts[j].a.Node), p.MinAnchorSpacingM)
			}
		}
	}
	// Geometry: spread and collinearity from the anchor covariance.
	var cx, cy float64
	for _, q := range pts {
		cx += q.x
		cy += q.y
	}
	cx /= float64(len(pts))
	cy /= float64(len(pts))
	var sxx, syy, sxy float64
	for _, q := range pts {
		dx, dy := q.x-cx, q.y-cy
		sxx += dx * dx
		syy += dy * dy
		sxy += dx * dy
	}
	n := float64(len(pts))
	sxx, syy, sxy = sxx/n, syy/n, sxy/n
	tr, det := sxx+syy, sxx*syy-sxy*sxy
	l1 := tr/2 + math.Sqrt(math.Max(tr*tr/4-det, 0))
	l2 := tr/2 - math.Sqrt(math.Max(tr*tr/4-det, 0))
	if math.Sqrt(tr) < p.MinSpreadM {
		return nil, reject("anchors clustered (spread %.0f m < %.0f m)", math.Sqrt(tr), p.MinSpreadM)
	}
	if l1 <= 0 || math.Sqrt(math.Max(l2, 0)/l1) < p.MinShapeRatio {
		return nil, reject("anchors nearly collinear: position not constrained in two dimensions")
	}

	est := &Estimate{AnchorCount: len(pts), SampleCount: samples}
	for _, q := range pts {
		est.Anchors = append(est.Anchors, nodeID(q.a.Node))
		if est.EvidenceFrom.IsZero() || q.m.First.Before(est.EvidenceFrom) {
			est.EvidenceFrom = q.m.First
		}
		if q.m.Last.After(est.EvidenceTo) {
			est.EvidenceTo = q.m.Last
		}
	}
	sort.Strings(est.Anchors)

	var x, y, unc float64
	if p.Calibration != nil && countRSSI(pts) >= p.MinAnchors {
		var err error
		x, y, unc, err = wls(pts, *p.Calibration, cx, cy)
		if err != nil {
			return nil, err
		}
		est.Method, est.Quality = "log_distance_wls", "low"
		est.Reasons = append(est.Reasons, "calibrated log-distance model on RSSI; terrain and antennas still dominate error")
		unc = math.Max(unc, p.FloorM)
	} else {
		// Uncalibrated: SNR-weighted centroid of anchors. It always lies inside
		// the anchors' hull and claims nothing finer than "among these anchors".
		var sw float64
		for _, q := range pts {
			w := float64(q.m.Samples)
			if q.m.SNR != nil {
				w *= math.Pow(10, math.Max(math.Min(*q.m.SNR, 15), -20)/20)
			}
			x += w * q.x
			y += w * q.y
			sw += w
		}
		x, y = x/sw, y/sw
		var md float64
		for _, q := range pts {
			md += math.Hypot(q.x-x, q.y-y)
		}
		unc = math.Max(md/n, p.UncalibratedFloorM)
		est.Method, est.Quality = "weighted_centroid", "very_low"
		est.Reasons = append(est.Reasons, "uncalibrated: weighted centroid of anchors heard directly; SNR does not measure distance")
	}
	if dropped > 0 {
		est.Reasons = append(est.Reasons, fmt.Sprintf("%d distant anchor(s) ignored as inconsistent", dropped))
	}
	// Anchors' own reported positions may be off by up to ErrM; added in
	// full (worst case: every anchor shifted the same way).
	var anchorErr float64
	for _, q := range pts {
		anchorErr = math.Max(anchorErr, q.a.ErrM)
	}
	if anchorErr > 0 {
		unc += anchorErr
		est.Reasons = append(est.Reasons, fmt.Sprintf("radius includes up to %.0f m of anchor position imprecision", math.Round(anchorErr/100)*100))
	}
	est.Lat, est.Lon = e.from(x, y)
	// Never report finer than ~100 m in coordinates.
	est.Lat, est.Lon = math.Round(est.Lat*1000)/1000, math.Round(est.Lon*1000)/1000
	est.UncertaintyM = math.Round(unc/100) * 100
	return est, nil
}

func countRSSI(pts []pt) int {
	n := 0
	for _, q := range pts {
		if q.m.RSSI != nil {
			n++
		}
	}
	return n
}

// wls: Gauss-Newton on range residuals from the log-distance model with
// Huber weights. Uncertainty from shadowing propagated through the model.
func wls(pts []pt, c Calibration, x0, y0 float64) (float64, float64, float64, error) {
	if c.Exponent <= 0 {
		return 0, 0, 0, reject("invalid calibration exponent")
	}
	type obs struct{ x, y, r, w float64 }
	var os []obs
	for _, q := range pts {
		if q.m.RSSI == nil {
			continue
		}
		r := math.Pow(10, (c.P0DBm-*q.m.RSSI)/(10*c.Exponent))
		os = append(os, obs{q.x, q.y, r, math.Sqrt(float64(q.m.Samples))})
	}
	cost := func(x, y float64) float64 {
		var c float64
		for _, o := range os {
			r := math.Hypot(x-o.x, y-o.y) - o.r
			c += o.w * r * r
		}
		return c
	}
	// Levenberg-Marquardt with Huber weights and a clamped step.
	x, y := x0, y0
	lambda := 1e-3
	cur := cost(x, y)
	for iter := 0; iter < 100; iter++ {
		var a11, a12, a22, b1, b2 float64
		for _, o := range os {
			dx, dy := x-o.x, y-o.y
			d := math.Max(math.Hypot(dx, dy), 1)
			res := d - o.r
			hub := 1.0
			if k := 0.5 * o.r; math.Abs(res) > k {
				hub = k / math.Abs(res)
			}
			w := o.w * hub
			jx, jy := dx/d, dy/d
			a11 += w * jx * jx
			a12 += w * jx * jy
			a22 += w * jy * jy
			b1 -= w * jx * res
			b2 -= w * jy * res
		}
		m11, m22 := a11*(1+lambda)+1e-9, a22*(1+lambda)+1e-9
		det := m11*m22 - a12*a12
		if math.Abs(det) < 1e-12 {
			lambda *= 10
			continue
		}
		dx, dy := (m22*b1-a12*b2)/det, (m11*b2-a12*b1)/det
		if step := math.Hypot(dx, dy); step > 5000 {
			dx, dy = dx*5000/step, dy*5000/step
		}
		if nc := cost(x+dx, y+dy); nc < cur {
			x, y, cur = x+dx, y+dy, nc
			lambda = math.Max(lambda/3, 1e-7)
			if math.Hypot(dx, dy) < 1 {
				break
			}
		} else {
			lambda *= 4
			if lambda > 1e6 {
				break
			}
		}
	}
	// A solution far outside the anchors' reach is a fit failure, not a location.
	var maxR float64
	for _, o := range os {
		maxR = math.Max(maxR, o.r+math.Hypot(o.x-x0, o.y-y0))
	}
	if math.Hypot(x-x0, y-y0) > maxR {
		return 0, 0, 0, reject("calibrated fit did not converge to a plausible location")
	}
	// Uncertainty: shadowing (sigma dB) maps to a multiplicative range error
	// of 10^(sigma/(10 n)). Use the larger of the observed dB misfit and a
	// conservative 6 dB; residuals from fitting few anchors understate it.
	var ssDB, meanR float64
	for _, o := range os {
		d := math.Max(math.Hypot(x-o.x, y-o.y), 1)
		obsDB := c.P0DBm - 10*c.Exponent*math.Log10(o.r)
		predDB := c.P0DBm - 10*c.Exponent*math.Log10(d)
		ssDB += (obsDB - predDB) * (obsDB - predDB)
		meanR += o.r
	}
	meanR /= float64(len(os))
	sigma := math.Max(math.Sqrt(ssDB/float64(len(os))), 6)
	return x, y, meanR * (math.Pow(10, sigma/(10*c.Exponent)) - 1), nil
}

func median(pts []pt, f func(pt) float64) float64 {
	v := make([]float64, len(pts))
	for i, q := range pts {
		v[i] = f(q)
	}
	sort.Float64s(v)
	return v[len(v)/2]
}
