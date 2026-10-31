// Package geo holds the location-estimate settings the operator configures.
// The estimator itself runs in the browser (frontend/engine/src/geo.rs,
// D-040); the server only validates these settings and publishes them in
// /capabilities.
package geo

// Calibration is a log-distance path-loss model: RSSI = P0 - 10 n log10(d/1m).
type Calibration struct {
	P0DBm    float64 `yaml:"p0_dbm" json:"p0_dbm"`
	Exponent float64 `yaml:"path_loss_exponent" json:"path_loss_exponent"`
}

// Params are the estimator's acceptance gates.
type Params struct {
	MinAnchors         int          // >= 3
	MinSamples         int          // independent samples across anchors
	MinAnchorSpacingM  float64      // pairwise
	MinSpreadM         float64      // RMS distance of anchors from their centroid
	MinShapeRatio      float64      // minor/major axis of anchor spread (collinearity)
	MaxAnchorDistanceM float64      // anchors farther than this from the median anchor are outliers
	FloorM             float64      // minimum uncertainty radius
	UncalibratedFloorM float64      // minimum radius without calibration
	Calibration        *Calibration // optional
}

// DefaultParams are conservative defaults.
func DefaultParams() Params {
	return Params{MinAnchors: 3, MinSamples: 5, MinAnchorSpacingM: 200, MinSpreadM: 500, MinShapeRatio: 0.2,
		MaxAnchorDistanceM: 150_000, FloorM: 500, UncalibratedFloorM: 2000}
}
