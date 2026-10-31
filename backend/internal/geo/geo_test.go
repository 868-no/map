package geo

import (
	"errors"
	"fmt"
	"math"
	"math/rand/v2"
	"testing"
	"time"
)

func nid(n uint32) string   { return fmt.Sprintf("!%08x", n) }
func fp(v float64) *float64 { return &v }

var t0 = time.Date(2026, 10, 31, 0, 0, 0, 0, time.UTC)

func meas(a uint32, snr float64, n int) Measurement {
	return Measurement{Anchor: a, SNR: fp(snr), Samples: n, First: t0, Last: t0.Add(time.Hour)}
}

func distM(lat1, lon1, lat2, lon2 float64) float64 {
	e := newENU(lat1, lon1)
	x, y := e.to(lat2, lon2)
	return math.Hypot(x, y)
}

// §17 test 26 (positive): three well-spaced anchors -> coarse labelled
// estimate whose uncertainty circle contains the true position.
func TestThreeAnchorsCoarseEstimate(t *testing.T) {
	anchors := map[uint32]Anchor{1: {1, 63.43, 10.39, 0}, 2: {2, 63.35, 10.36, 0}, 3: {3, 63.41, 10.55, 0}}
	truth := [2]float64{63.40, 10.43}
	est, err := Locate(anchors, []Measurement{meas(1, 3, 3), meas(2, -2, 2), meas(3, 1, 4)}, DefaultParams(), nid)
	if err != nil {
		t.Fatal(err)
	}
	if est.Quality != "very_low" || est.Method != "weighted_centroid" || est.UncertaintyM < 2000 {
		t.Fatalf("uncalibrated estimate must be very_low with broad uncertainty: %+v", est)
	}
	if d := distM(est.Lat, est.Lon, truth[0], truth[1]); d > est.UncertaintyM {
		t.Fatalf("truth %.0f m from estimate, outside %.0f m radius", d, est.UncertaintyM)
	}
	if est.AnchorCount != 3 || est.SampleCount != 9 || len(est.Reasons) == 0 {
		t.Fatalf("provenance missing: %+v", est)
	}
}

// §17 test 26 (negative): two anchors, collocated anchors, collinear
// anchors, too few samples and inconsistent anchors yield no estimate.
func TestUnderdeterminedRejected(t *testing.T) {
	p := DefaultParams()
	cases := map[string]struct {
		anchors map[uint32]Anchor
		ms      []Measurement
	}{
		"two anchors": {map[uint32]Anchor{1: {1, 63.43, 10.39, 0}, 2: {2, 63.35, 10.36, 0}},
			[]Measurement{meas(1, 3, 5), meas(2, 3, 5)}},
		"collocated": {map[uint32]Anchor{1: {1, 63.4300, 10.3900, 0}, 2: {2, 63.4301, 10.3901, 0}, 3: {3, 63.41, 10.55, 0}},
			[]Measurement{meas(1, 3, 5), meas(2, 3, 5), meas(3, 3, 5)}},
		"collinear": {map[uint32]Anchor{1: {1, 63.40, 10.30, 0}, 2: {2, 63.40, 10.40, 0}, 3: {3, 63.40, 10.50, 0}},
			[]Measurement{meas(1, 3, 5), meas(2, 3, 5), meas(3, 3, 5)}},
		"too few samples": {map[uint32]Anchor{1: {1, 63.43, 10.39, 0}, 2: {2, 63.35, 10.36, 0}, 3: {3, 63.41, 10.55, 0}},
			[]Measurement{meas(1, 3, 1), meas(2, 3, 1), meas(3, 3, 1)}},
		"inconsistent (one anchor 400 km away)": {map[uint32]Anchor{1: {1, 63.43, 10.39, 0}, 2: {2, 63.35, 10.36, 0}, 3: {3, 59.91, 10.75, 0}},
			[]Measurement{meas(1, 3, 5), meas(2, 3, 5), meas(3, 3, 5)}},
		"measurement for unknown anchor": {map[uint32]Anchor{1: {1, 63.43, 10.39, 0}, 2: {2, 63.35, 10.36, 0}},
			[]Measurement{meas(1, 3, 5), meas(2, 3, 5), meas(9, 3, 5)}},
	}
	for name, c := range cases {
		est, err := Locate(c.anchors, c.ms, p, nid)
		var r *Rejection
		if est != nil || !errors.As(err, &r) {
			t.Errorf("%s: want rejection, got %+v %v", name, est, err)
		}
	}
}

// Calibrated estimator against simulated placements with noisy RSSI: error
// stays within the reported uncertainty in the large majority of trials.
func TestCalibratedSimulation(t *testing.T) {
	cal := Calibration{P0DBm: -30, Exponent: 2.8}
	p := DefaultParams()
	p.Calibration = &cal
	r := rand.New(rand.NewPCG(1, 2))
	anchors := map[uint32]Anchor{1: {1, 63.43, 10.39, 0}, 2: {2, 63.35, 10.36, 0}, 3: {3, 63.41, 10.55, 0}, 4: {4, 63.47, 10.48, 0}}
	e := newENU(63.41, 10.45)
	within, trials := 0, 200
	var errSum float64
	for i := 0; i < trials; i++ {
		tx, ty := (r.Float64()-0.5)*8000, (r.Float64()-0.5)*8000
		var ms []Measurement
		for id, a := range anchors {
			ax, ay := e.to(a.Lat, a.Lon)
			d := math.Max(math.Hypot(tx-ax, ty-ay), 50)
			rssi := cal.P0DBm - 10*cal.Exponent*math.Log10(d) + r.NormFloat64()*4 // 4 dB shadowing
			ms = append(ms, Measurement{Anchor: id, RSSI: fp(rssi), SNR: fp(0), Samples: 3, First: t0, Last: t0})
		}
		est, err := Locate(anchors, ms, p, nid)
		if err != nil {
			t.Fatal(err)
		}
		lat, lon := e.from(tx, ty)
		d := distM(est.Lat, est.Lon, lat, lon)
		errSum += d
		if d <= est.UncertaintyM*2 {
			within++
		}
	}
	t.Logf("calibrated: mean error %.0f m over %d trials; %d within 2x reported radius", errSum/float64(trials), trials, within)
	if within < trials*8/10 {
		t.Fatalf("uncertainty badly understated: only %d/%d within 2x radius", within, trials)
	}
}

func TestPrecisionError(t *testing.T) {
	if PrecisionErrorM(32, 63) != 0 {
		t.Fatal("full precision must have no error")
	}
	// Meshtastic's 15-bit setting is roughly a 1.5 km cell: half-diagonal ~0.8 km at 63°N.
	if e := PrecisionErrorM(15, 63); e < 700 || e > 900 {
		t.Fatalf("15 bits at 63N: %.0f m", e)
	}
	if PrecisionErrorM(13, 63) <= PrecisionErrorM(15, 63) {
		t.Fatal("fewer bits must mean more error")
	}
}

func TestAnchorErrorWidensRadius(t *testing.T) {
	ms := []Measurement{meas(1, 3, 3), meas(2, -2, 2), meas(3, 1, 4)}
	exact := map[uint32]Anchor{1: {1, 63.43, 10.39, 0}, 2: {2, 63.35, 10.36, 0}, 3: {3, 63.41, 10.55, 0}}
	coarse := map[uint32]Anchor{1: {1, 63.43, 10.39, 800}, 2: {2, 63.35, 10.36, 0}, 3: {3, 63.41, 10.55, 300}}
	a, err := Locate(exact, ms, DefaultParams(), nid)
	if err != nil {
		t.Fatal(err)
	}
	b, err := Locate(coarse, ms, DefaultParams(), nid)
	if err != nil {
		t.Fatal(err)
	}
	if b.UncertaintyM-a.UncertaintyM < 700 || b.UncertaintyM-a.UncertaintyM > 900 {
		t.Fatalf("radius should grow by the largest anchor error (800 m): %.0f -> %.0f", a.UncertaintyM, b.UncertaintyM)
	}
}
