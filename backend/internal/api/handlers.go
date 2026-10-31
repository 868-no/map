package api

import (
	"context"
	"errors"
	"slices"
	"time"

	"github.com/danielgtaylor/huma/v2"

	"fmt"

	"github.com/868-no/map/internal/cache"
	"github.com/868-no/map/internal/geo"
	"github.com/868-no/map/internal/graph"
	"github.com/868-no/map/internal/ingest"
	"github.com/868-no/map/internal/protocol"
	"github.com/868-no/map/internal/query"
)

// ---- capabilities ----

type Preset struct {
	Label string `json:"label" example:"3d"`
	Hours int    `json:"hours" example:"72"`
}

type CapabilitiesBody struct {
	Presets            []Preset `json:"presets"`
	DefaultWindowHours int      `json:"default_window_hours"`
	MinWindowHours     int      `json:"min_window_hours"`
	MaxWindowHours     int      `json:"max_window_hours"`
	LiveQuantumSeconds int      `json:"live_quantum_seconds"`
	RetentionMonths    int      `json:"retention_months"`
	Map                struct {
		Lat        float64 `json:"lat"`
		Lon        float64 `json:"lon"`
		Zoom       float64 `json:"zoom"`
		StyleURL   string  `json:"style_url"`
		TileSource string  `json:"tile_source" doc:"Vector tile source for the style: pmtiles:///path for the self-hosted archive, or a TileJSON URL"`
	} `json:"map"`
	Features struct {
		Geolocation bool `json:"geolocation"`
		Live        bool `json:"live"`
	} `json:"features"`
	// Geolocation carries the estimator settings so browsers deriving views
	// themselves apply the operator's rules (D-031).
	Geolocation     GeoSettings `json:"geolocation"`
	SignaturePolicy string      `json:"signature_policy" enum:"balanced,strict"`
	DecodeVersion   int         `json:"decode_version"`
}

type CapabilitiesOutput struct{ Body CapabilitiesBody }

// GeoSettings mirror query.GeoOptions for the browser.
type GeoSettings struct {
	Enabled            bool             `json:"enabled"`
	MinPrecisionBits   uint32           `json:"min_precision_bits"`
	Exclude            []string         `json:"exclude" doc:"Node ids the operator excluded from estimates"`
	MinAnchors         int              `json:"min_anchors"`
	MinSamples         int              `json:"min_samples"`
	MinAnchorSpacingM  float64          `json:"min_anchor_spacing_m"`
	MinSpreadM         float64          `json:"min_spread_m"`
	MinShapeRatio      float64          `json:"min_shape_ratio"`
	MaxAnchorDistanceM float64          `json:"max_anchor_distance_m"`
	FloorM             float64          `json:"floor_m"`
	UncalibratedFloorM float64          `json:"uncalibrated_floor_m"`
	Calibration        *geo.Calibration `json:"calibration,omitempty"`
}

func (s *Server) geoSettings() GeoSettings {
	p := s.Geo.Params
	g := GeoSettings{Enabled: s.Geo.Enabled, MinPrecisionBits: s.Geo.MinPrecisionBits, Exclude: []string{},
		MinAnchors: p.MinAnchors, MinSamples: p.MinSamples, MinAnchorSpacingM: p.MinAnchorSpacingM, MinSpreadM: p.MinSpreadM,
		MinShapeRatio: p.MinShapeRatio, MaxAnchorDistanceM: p.MaxAnchorDistanceM, FloorM: p.FloorM,
		UncalibratedFloorM: p.UncalibratedFloorM, Calibration: p.Calibration}
	for n := range s.Geo.Exclude {
		g.Exclude = append(g.Exclude, protocol.NodeID(n))
	}
	slices.Sort(g.Exclude)
	return g
}

var presets = []Preset{{"1h", 1}, {"3h", 3}, {"6h", 6}, {"12h", 12}, {"24h", 24}, {"3d", 72}, {"7d", 168}}

func (s *Server) capabilities(ctx context.Context, _ *struct{}) (*CapabilitiesOutput, error) {
	var b CapabilitiesBody
	for _, p := range presets {
		if p.Hours <= s.Env.MaxWindowHours {
			b.Presets = append(b.Presets, p)
		}
	}
	b.DefaultWindowHours, b.MinWindowHours, b.MaxWindowHours = s.Env.DefaultWindowHours, 1, s.Env.MaxWindowHours
	b.LiveQuantumSeconds = int(s.Env.LiveQuantum / time.Second)
	b.RetentionMonths = s.Env.RetentionMonths
	b.Map.Lat, b.Map.Lon, b.Map.Zoom, b.Map.StyleURL, b.Map.TileSource = s.Env.DefaultMapLat, s.Env.DefaultMapLon, s.Env.DefaultMapZoom, s.Env.MapStyleURL, s.Env.MapTileSource
	b.Features.Geolocation = s.Env.GeolocationEnabled
	b.Features.Live = s.Hub != nil && s.Hub.Available()
	b.Geolocation = s.geoSettings()
	b.SignaturePolicy = s.Env.SignaturePolicy
	b.DecodeVersion = ingest.DecodeVersion
	return &CapabilitiesOutput{Body: b}, nil
}

// ---- retention ----

type RetentionBody struct {
	Now                 time.Time  `json:"now"`
	ConfiguredCutoff    time.Time  `json:"configured_cutoff" doc:"Oldest selectable instant: now minus the configured retention"`
	EarliestObservation *time.Time `json:"earliest_observation,omitempty" doc:"Oldest observed_at actually retained (may be later than the cutoff)"`
	LatestObservation   *time.Time `json:"latest_observation,omitempty"`
	RetentionMonths     int        `json:"retention_months"`
}

type RetentionOutput struct{ Body RetentionBody }

func (s *Server) retention(ctx context.Context, _ *struct{}) (*RetentionOutput, error) {
	b := s.Bounds()
	out := RetentionBody{Now: b.Now, ConfiguredCutoff: b.Cutoff, RetentionMonths: s.Env.RetentionMonths}
	// Whole-table bounds are operational metadata, not mesh-derived state.
	if err := s.Pool.QueryRow(ctx, `SELECT min(observed_at), max(observed_at) FROM packet_log`).Scan(&out.EarliestObservation, &out.LatestObservation); err != nil {
		return nil, err
	}
	return &RetentionOutput{Body: out}, nil
}

// ---- snapshot ----

type SnapshotInput struct {
	WindowParams
	FilterParams
}

type SnapshotBody struct {
	Meta Meta `json:"meta"`
	query.Snapshot
}

type SnapshotOutput struct{ Body SnapshotBody }

func (s *Server) snapshot(ctx context.Context, in *SnapshotInput) (*SnapshotOutput, error) {
	w, err := s.parseWindow(in.WindowParams)
	if err != nil {
		return nil, err
	}
	f, err := in.FilterParams.parse()
	if err != nil {
		return nil, err
	}
	release, err := s.acquire(ctx)
	if err != nil {
		return nil, err
	}
	defer release()
	rev, useCache, err := s.revision(ctx, w)
	if err != nil {
		return nil, err
	}
	snap, err := cache.Get(ctx, s.Results, cacheKey("snapshot", w, f, rev, ""), s.ttl(w), useCache,
		func(ctx context.Context) (*query.Snapshot, error) {
			return query.BuildSnapshot(ctx, s.Pool, w, f, s.Geo)
		})
	if err != nil {
		return nil, err
	}
	return &SnapshotOutput{Body: SnapshotBody{Meta: s.meta(w, rev, f), Snapshot: *snap}}, nil
}

// ---- traffic ----

type TrafficInput struct {
	WindowParams
	FilterParams
	Bucket string `query:"bucket" doc:"Minimum bucket width (1m, 5m, 15m, 1h, 6h); widened to keep at most 600 buckets" example:"5m"`
}

type TrafficBody struct {
	Meta Meta `json:"meta"`
	query.Traffic
}

type TrafficOutput struct{ Body TrafficBody }

func (s *Server) traffic(ctx context.Context, in *TrafficInput) (*TrafficOutput, error) {
	w, err := s.parseWindow(in.WindowParams)
	if err != nil {
		return nil, err
	}
	f, err := in.FilterParams.parse()
	if err != nil {
		return nil, err
	}
	var req time.Duration
	if in.Bucket != "" {
		if req, err = time.ParseDuration(in.Bucket); err != nil || req <= 0 {
			return nil, huma.Error400BadRequest("bucket: invalid duration")
		}
	}
	bucket := query.BucketFor(w.Duration(), req)
	release, err := s.acquire(ctx)
	if err != nil {
		return nil, err
	}
	defer release()
	rev, useCache, err := s.revision(ctx, w)
	if err != nil {
		return nil, err
	}
	tr, err := cache.Get(ctx, s.Results, cacheKey("traffic", w, f, rev, bucket.String()), s.ttl(w), useCache,
		func(ctx context.Context) (*query.Traffic, error) {
			return query.BuildTraffic(ctx, s.Pool, w, f, bucket)
		})
	if err != nil {
		return nil, err
	}
	return &TrafficOutput{Body: TrafficBody{Meta: s.meta(w, rev, f), Traffic: *tr}}, nil
}

// ---- node detail ----

type NodeInput struct {
	ID string `path:"id" doc:"Node id (!xxxxxxxx) or decimal node number" example:"!a1b2c3d4"`
	WindowParams
	FilterParams
}

type NodeBody struct {
	Meta Meta `json:"meta"`
	query.NodeDetail
}

type NodeOutput struct{ Body NodeBody }

func (s *Server) node(ctx context.Context, in *NodeInput) (*NodeOutput, error) {
	num, ok := protocol.ParseNodeID(in.ID)
	if !ok || !protocol.ValidNode(num) {
		return nil, huma.Error400BadRequest("invalid node id")
	}
	w, err := s.parseWindow(in.WindowParams)
	if err != nil {
		return nil, err
	}
	f, err := in.FilterParams.parse()
	if err != nil {
		return nil, err
	}
	release, err := s.acquire(ctx)
	if err != nil {
		return nil, err
	}
	defer release()
	rev, useCache, err := s.revision(ctx, w)
	if err != nil {
		return nil, err
	}
	d, err := cache.Get(ctx, s.Results, cacheKey("node", w, f, rev, protocol.NodeID(num)), s.ttl(w), useCache,
		func(ctx context.Context) (*query.NodeDetail, error) {
			return query.BuildNodeDetail(ctx, s.Pool, w, f, num)
		})
	if errors.Is(err, query.ErrNoNode) {
		return nil, huma.Error404NotFound("node not observed or referenced in the selected window")
	}
	if err != nil {
		return nil, err
	}
	return &NodeOutput{Body: NodeBody{Meta: s.meta(w, rev, f), NodeDetail: *d}}, nil
}

// ---- edges ----

type EdgesInput struct {
	WindowParams
	FilterParams
	Evidence      string `query:"evidence" doc:"Keep edges having any of these evidence types: neighbor, traceroute, direct_rf, relay_hint (comma-separated)"`
	MinConfidence string `query:"min_confidence" enum:"low,medium,high" default:"low"`
	BBox          string `query:"bbox" doc:"west,south,east,north: keep edges with an endpoint positioned (reported or estimated) inside"`
	Inferred      bool   `query:"include_inferred" default:"true" doc:"Include relay-hint-only (inferred) links"`
}

type EdgesBody struct {
	Meta      Meta         `json:"meta"`
	Edges     []graph.Edge `json:"edges"`
	Truncated bool         `json:"truncated"`
	Total     int          `json:"total" doc:"edges in the window before evidence/confidence/bbox filtering"`
}

type EdgesOutput struct{ Body EdgesBody }

func (s *Server) edges(ctx context.Context, in *EdgesInput) (*EdgesOutput, error) {
	w, err := s.parseWindow(in.WindowParams)
	if err != nil {
		return nil, err
	}
	f, err := in.FilterParams.parse()
	if err != nil {
		return nil, err
	}
	var bbox *[4]float64
	if in.BBox != "" {
		var b [4]float64
		parts := splitList(in.BBox)
		if len(parts) != 4 {
			return nil, huma.Error400BadRequest("bbox: want west,south,east,north")
		}
		for i, p := range parts {
			if _, err := fmt.Sscanf(p, "%g", &b[i]); err != nil {
				return nil, huma.Error400BadRequest("bbox: invalid number")
			}
		}
		bbox = &b
	}
	evid := splitList(in.Evidence)
	rank := map[string]int{"low": 0, "medium": 1, "high": 2}
	minRank, ok := rank[in.MinConfidence]
	if !ok {
		minRank = 0
	}
	release, err := s.acquire(ctx)
	if err != nil {
		return nil, err
	}
	defer release()
	rev, useCache, err := s.revision(ctx, w)
	if err != nil {
		return nil, err
	}
	snap, err := cache.Get(ctx, s.Results, cacheKey("snapshot", w, f, rev, ""), s.ttl(w), useCache,
		func(ctx context.Context) (*query.Snapshot, error) {
			return query.BuildSnapshot(ctx, s.Pool, w, f, s.Geo)
		})
	if err != nil {
		return nil, err
	}
	pos := map[uint32][2]float64{}
	for _, n := range snap.Nodes {
		switch {
		case n.Position != nil:
			pos[n.Num] = [2]float64{n.Position.Lon, n.Position.Lat}
		case n.Estimate != nil:
			pos[n.Num] = [2]float64{n.Estimate.Lon, n.Estimate.Lat}
		}
	}
	inBox := func(n uint32) bool {
		p, ok := pos[n]
		return ok && p[0] >= bbox[0] && p[0] <= bbox[2] && p[1] >= bbox[1] && p[1] <= bbox[3]
	}
	out := EdgesBody{Meta: s.meta(w, rev, f), Edges: []graph.Edge{}, Truncated: snap.EdgesTruncated, Total: len(snap.Edges)}
	for _, e := range snap.Edges {
		if rank[e.Confidence] < minRank || (e.Inferred && !in.Inferred) {
			continue
		}
		if len(evid) > 0 && !hasEvidence(e, evid) {
			continue
		}
		if bbox != nil && !inBox(e.SrcNum) && !inBox(e.DstNum) {
			continue
		}
		out.Edges = append(out.Edges, e)
	}
	return &EdgesOutput{Body: out}, nil
}

func hasEvidence(e graph.Edge, types []string) bool {
	for _, t := range types {
		switch t {
		case "neighbor":
			if e.Evidence.Neighbor > 0 {
				return true
			}
		case "traceroute":
			if e.Evidence.Traceroute > 0 {
				return true
			}
		case "direct_rf":
			if e.Evidence.DirectRF > 0 {
				return true
			}
		case "relay_hint":
			if e.Evidence.RelayHint > 0 {
				return true
			}
		}
	}
	return false
}

// ---- raw observations (client-side derivation, D-031) ----

type ObservationsInput struct {
	WindowParams
	Since string `query:"since" doc:"Narrow the lower bound to this instant (RFC 3339); clamped to the window, never widening it"`
	Until string `query:"until" doc:"Narrow the upper bound to this instant (RFC 3339); clamped to the window"`
	Cursor string `query:"cursor" doc:"Page cursor: next_cursor from the previous page"`
	Limit int    `query:"limit" minimum:"0" maximum:"20000" doc:"Page size (default and maximum 20000)"`
}

type ObservationsBody struct {
	Window     WindowEcho     `json:"window" doc:"The full window the rows belong to"`
	Since      time.Time      `json:"since" doc:"Effective lower bound of the rows returned"`
	Until      time.Time      `json:"until" doc:"Effective upper bound (exclusive)"`
	Generation string         `json:"generation" doc:"Decoder and configuration generation; rows from another generation must be discarded"`
	Now        time.Time      `json:"now" doc:"Server time when the rows were read; lets clients follow the server clock between fetches"`
	Rows       []query.ObsRow `json:"rows"`
	More       bool           `json:"more" doc:"More rows remain; request again with cursor = next_cursor"`
	NextCursor string         `json:"next_cursor,omitempty" doc:"Opaque position after the last row returned (rows come in observed_at order)"`
}

type ObservationsOutput struct {
	CacheControl string `header:"Cache-Control"`
	Body         ObservationsBody
}

func (s *Server) observations(ctx context.Context, in *ObservationsInput) (*ObservationsOutput, error) {
	w, err := s.parseWindow(in.WindowParams)
	if err != nil {
		return nil, err
	}
	n := w // narrowed copy: bounds only ever move inwards
	if in.Since != "" {
		t, err := parseTime("since", in.Since)
		if err != nil {
			return nil, err
		}
		if t.After(n.Start) {
			n.Start = t
		}
	}
	if in.Until != "" {
		t, err := parseTime("until", in.Until)
		if err != nil {
			return nil, err
		}
		if t.Before(n.End) {
			n.End = t
		}
	}
	out := ObservationsBody{Now: s.now(), Window: echo(w), Generation: fmt.Sprintf("d%d.c%s", ingest.DecodeVersion, s.ConfigRev), Rows: []query.ObsRow{}}
	if n.End.Before(n.Start) {
		n.End = n.Start
	}
	out.Since, out.Until = n.Start, n.End
	if n.End.After(n.Start) {
		release, err := s.acquire(ctx)
		if err != nil {
			return nil, err
		}
		defer release()
		var after *query.Cursor
		if in.Cursor != "" {
			c, ok := query.ParseCursor(in.Cursor)
			if !ok {
				return nil, huma.Error400BadRequest("cursor: invalid")
			}
			after = &c
		}
		rows, next, more, err := query.ListObservations(ctx, s.Pool, n, after, in.Limit)
		if err != nil {
			return nil, err
		}
		out.Rows, out.More = rows, more
		if next != nil {
			out.NextCursor = next.String()
		}
	}
	// Rows are immutable, but the window may still be filling; the browser
	// keeps its own copy, so nothing here is worth a shared cache.
	return &ObservationsOutput{CacheControl: "no-store", Body: out}, nil
}
