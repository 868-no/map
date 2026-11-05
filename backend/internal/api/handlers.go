package api

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"reflect"
	"slices"
	"time"

	"github.com/danielgtaylor/huma/v2"

	"github.com/868-no/map/internal/geo"
	"github.com/868-no/map/internal/ingest"
	"github.com/868-no/map/internal/protocol"
	"github.com/868-no/map/internal/query"
	"github.com/868-no/map/internal/storage"
	"github.com/868-no/map/internal/window"
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
		StyleURL   string  `json:"style_url" doc:"Map style for the dark theme"`
		StyleLight string  `json:"style_url_light" doc:"Map style for the light theme (same layers)"`
		TileSource string  `json:"tile_source" doc:"Vector tile source for the style: pmtiles:///path for the self-hosted archive, or a TileJSON URL"`
	} `json:"map"`
	Features struct {
		Geolocation bool `json:"geolocation"`
		Live        bool `json:"live"`
		Weather     bool `json:"weather" doc:"GET /api/v1/weather is served (D-133)"`
		Terrain     bool `json:"terrain" doc:"/api/v1/terrain is served (D-143)"`
	} `json:"features"`
	// Geolocation carries the estimator settings so browsers deriving views
	// themselves apply the operator's rules (D-031).
	Geolocation     GeoSettings `json:"geolocation"`
	SignaturePolicy string      `json:"signature_policy" enum:"balanced,strict"`
	DecodeVersion   int         `json:"decode_version"`
	// Shown in the privacy policy; empty when the operator has not set them.
	Operator struct {
		Name    string `json:"name,omitempty" doc:"Who runs this deployment"`
		Contact string `json:"contact,omitempty" doc:"How to reach the operator about privacy (e-mail address or URL)"`
	} `json:"operator"`
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
	b.DefaultWindowHours, b.MinWindowHours, b.MaxWindowHours = s.Env.DefaultWindowHours, int(window.MinDuration/time.Hour), s.Env.MaxWindowHours
	b.LiveQuantumSeconds = int(s.Env.LiveQuantum / time.Second)
	b.RetentionMonths = s.Env.RetentionMonths
	b.Map.Lat, b.Map.Lon, b.Map.Zoom, b.Map.StyleURL, b.Map.TileSource = s.Env.DefaultMapLat, s.Env.DefaultMapLon, s.Env.DefaultMapZoom, s.Env.MapStyleURL, s.Env.MapTileSource
	b.Map.StyleLight = s.Env.MapStyleLightURL
	b.Operator.Name, b.Operator.Contact = s.Env.OperatorName, s.Env.OperatorContact
	b.Features.Geolocation = s.Env.GeolocationEnabled
	b.Features.Live = s.Hub != nil && s.Hub.Available()
	b.Features.Weather = s.Weather != nil
	b.Features.Terrain = s.Terrain != nil
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
	Generation          string     `json:"generation" doc:"The generation /observations reports now; lets a client request whole days without waiting for it (D-170)"`
}

type RetentionOutput struct{ Body RetentionBody }

func (s *Server) retention(ctx context.Context, _ *struct{}) (*RetentionOutput, error) {
	b := s.Bounds()
	out := RetentionBody{Now: b.Now, ConfiguredCutoff: b.Cutoff, RetentionMonths: s.Env.RetentionMonths}
	// Whole-table bounds are operational metadata, not mesh-derived state.
	var err error
	if out.EarliestObservation, out.LatestObservation, err = storage.ObservedRange(ctx, s.Pool); err != nil {
		return nil, err
	}
	hist, err := s.rowsDB().History(ctx)
	if err != nil {
		return nil, err
	}
	out.Generation = s.generation(hist.Rev)
	return &RetentionOutput{Body: out}, nil
}

// ---- a node's public key ----

type NodeKeyInput struct {
	ID string `path:"id" doc:"Node id, !xxxxxxxx or decimal" example:"!98644b01"`
}

type NodeKeyBody struct {
	Node         string     `json:"node" example:"!98644b01"`
	PublicKey    string     `json:"public_key,omitempty" doc:"Base64 X25519 key from the node's newest retained NodeInfo that carried one"`
	AnnouncedAt  *time.Time `json:"announced_at,omitempty"`
	Signature    string     `json:"signature,omitempty" doc:"Signature status of that NodeInfo"`
	TrustedKey   string     `json:"trusted_key,omitempty" doc:"Key of the first stored verified NodeInfo (trust on first use): signatures are checked against it"`
	TrustedSince *time.Time `json:"trusted_since,omitempty"`
}

type NodeKeyOutput struct {
	CacheControl string `header:"Cache-Control"`
	Body         NodeKeyBody
}

// nodeKey serves one node's public key. Keys are broadcast in the clear and
// identify a node rather than a window, so this spans the retained log.
func (s *Server) nodeKey(ctx context.Context, in *NodeKeyInput) (*NodeKeyOutput, error) {
	n, ok := protocol.ParseNodeID(in.ID)
	if !ok || !protocol.ValidNode(n) {
		return nil, huma.Error400BadRequest("invalid node id")
	}
	out := NodeKeyBody{Node: protocol.NodeID(n)}
	switch k, err := storage.LatestAnnouncedKey(ctx, s.Pool, n); {
	case err == nil:
		out.PublicKey, out.AnnouncedAt, out.Signature = k.PublicKey, &k.At, k.Signature
	case !errors.Is(err, storage.ErrNotFound):
		return nil, err
	}
	ids, err := storage.VerifiedIdentities(ctx, s.Pool, &n)
	if err != nil {
		return nil, err
	}
	if len(ids) > 0 {
		out.TrustedKey, out.TrustedSince = ids[0].PublicKey, &ids[0].Since
	}
	if out.PublicKey == "" && out.TrustedKey == "" {
		return nil, huma.Error404NotFound("no public key retained for this node")
	}
	return &NodeKeyOutput{CacheControl: "public, max-age=60", Body: out}, nil
}

// ---- raw observations (client-side derivation, D-031) ----

type ObservationsInput struct {
	WindowParams
	Since  string `query:"since" doc:"Narrow the lower bound to this instant (RFC 3339); clamped to the window, never widening it"`
	Until  string `query:"until" doc:"Narrow the upper bound to this instant (RFC 3339); clamped to the window"`
	Cursor string `query:"cursor" doc:"Page cursor: next_cursor from the previous page"`
	Limit  int    `query:"limit" minimum:"0" maximum:"20000" doc:"Page size (default and maximum 20000)"`
}

type ObservationsBody struct {
	Window     WindowEcho `json:"window" doc:"The full window the rows belong to"`
	Since      time.Time  `json:"since" doc:"Effective lower bound of the rows returned"`
	Until      time.Time  `json:"until" doc:"Effective upper bound (exclusive)"`
	Generation string     `json:"generation" doc:"Decoder, row-format, configuration and history-revision generation; rows from another generation must be discarded"`
	Now        time.Time  `json:"now" doc:"Server time when the rows were read; lets clients follow the server clock between fetches"`
	Rows       RowList    `json:"rows"`
	More       bool       `json:"more" doc:"More rows remain; request again with cursor = next_cursor"`
	NextCursor string     `json:"next_cursor,omitempty" doc:"Opaque position after the last row returned (rows come in observed_at order)"`
}

// RowList is a page of rows already encoded (D-046), documented as the
// ObsRow list it is.
type RowList []json.RawMessage

func (RowList) Schema(r huma.Registry) *huma.Schema {
	return huma.SchemaFromType(r, reflect.TypeOf([]query.ObsRow{}))
}

// ObservationsOutput streams the body: rows go from the database cursor to
// the client as they are read, never collected (D-057). Its schema is
// ObservationsBody, declared on the operation.
type ObservationsOutput struct {
	CacheControl string `header:"Cache-Control"`
	Body         func(huma.Context)
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
	if n.End.Before(n.Start) {
		n.End = n.Start
	}
	var after *query.Cursor
	if in.Cursor != "" {
		c, ok := query.ParseCursor(in.Cursor)
		if !ok {
			return nil, huma.Error400BadRequest("cursor: invalid")
		}
		after = &c
	}
	hist, err := s.rowsDB().History(ctx)
	if err != nil {
		return nil, err
	}
	head := ObservationsBody{Now: s.now(), Window: echo(w), Since: n.Start, Until: n.End, Generation: s.generation(hist.Rev)}
	var page rowSource // nil interface when nothing is read
	release := func() {}
	if n.End.After(n.Start) {
		if release, err = s.acquire(ctx); err != nil {
			return nil, err
		}
		// Errors up to the first row still get a proper status.
		p, err := query.OpenPage(ctx, s.Pool, n, after, in.Limit)
		if err != nil {
			release()
			return nil, err
		}
		page = p
	}
	// Rows are immutable, but the window may still be filling and its bounds
	// are the visitor's own; whole past days are shared through
	// /observations/day instead (D-158).
	return &ObservationsOutput{CacheControl: "no-store", Body: func(hc huma.Context) {
		defer release()
		hc.SetHeader("Content-Type", "application/json")
		if page != nil {
			defer page.Close()
		}
		if err := writeObservations(hc.BodyWriter(), head, page, after); err != nil {
			// Headers are gone: cut the response so the client sees a
			// truncated body, never a well-formed partial page.
			s.Log.Warn("observations stream aborted", "err", err)
			panic(http.ErrAbortHandler)
		}
	}}, nil
}

// writeObservations writes head as ObservationsBody with the page's rows,
// buffered in chunks.
func writeObservations(dst io.Writer, head ObservationsBody, page rowSource, after *query.Cursor) error {
	bw := bufio.NewWriterSize(dst, 64<<10)
	// The head is ObservationsBody's encoding up to its rows, which it
	// declares last with more and next_cursor: a field added to the body
	// is written too. Quotes inside string values are escaped, so the key
	// cannot be matched inside one.
	head.Rows, head.More, head.NextCursor = nil, false, ""
	enc, err := json.Marshal(head)
	if err != nil {
		return err
	}
	cut := bytes.Index(enc, []byte(`,"rows":`))
	if cut < 0 {
		return errors.New("observations head: no rows field")
	}
	bw.Write(enc[:cut])         //nolint:errcheck // bufio keeps the first error for Flush
	bw.WriteString(`,"rows":[`) //nolint:errcheck
	more, next := false, after
	if page != nil {
		first := true
		if err := page.Each(func(row []byte) error {
			if !first {
				bw.WriteByte(',') //nolint:errcheck
			}
			first = false
			_, err := bw.Write(row)
			return err
		}); err != nil {
			return err
		}
		more, next = page.More(), page.Next()
	}
	fmt.Fprintf(bw, `],"more":%t`, more)
	if next != nil {
		fmt.Fprintf(bw, `,"next_cursor":%q`, next.String())
	}
	bw.WriteByte('}') //nolint:errcheck
	return bw.Flush()
}
