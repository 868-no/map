package geo

import (
	"os"
	"regexp"
	"strconv"
	"strings"
	"testing"
)

// The server's defaults are the estimator's own: /capabilities publishes
// these for the browser engine (frontend/engine/src/geo.rs) to apply, so
// the two must not drift apart.
func TestDefaultsMatchTheEngine(t *testing.T) {
	src, err := os.ReadFile("../../../frontend/engine/src/geo.rs")
	if err != nil {
		t.Skip("frontend/engine/src/geo.rs not present")
	}
	line := regexp.MustCompile(`Params \{ min_anchors:[^}]*\}`).Find(src)
	if line == nil {
		t.Fatal("the engine's default Params not found")
	}
	engine := map[string]float64{}
	for _, m := range regexp.MustCompile(`(\w+): ([0-9][0-9_.]*)`).FindAllSubmatch(line, -1) {
		v, err := strconv.ParseFloat(strings.ReplaceAll(string(m[2]), "_", ""), 64)
		if err != nil {
			t.Fatal(err)
		}
		engine[string(m[1])] = v
	}
	p := DefaultParams()
	want := map[string]float64{
		"min_anchors": float64(p.MinAnchors), "min_samples": float64(p.MinSamples), "min_anchor_spacing_m": p.MinAnchorSpacingM,
		"min_spread_m": p.MinSpreadM, "min_shape_ratio": p.MinShapeRatio, "max_anchor_distance_m": p.MaxAnchorDistanceM,
		"floor_m": p.FloorM, "uncalibrated_floor_m": p.UncalibratedFloorM,
	}
	if len(engine) != len(want) {
		t.Fatalf("engine defaults %v, server %v", engine, want)
	}
	for k, v := range want {
		if engine[k] != v {
			t.Errorf("%s: engine %v, server %v", k, engine[k], v)
		}
	}
	if p.Calibration != nil || !strings.Contains(string(line), "calibration: None") {
		t.Error("defaults must be uncalibrated on both sides")
	}
	if p.MinAnchors < 3 {
		t.Errorf("MinAnchors %d: a position needs at least three anchors", p.MinAnchors)
	}
}
