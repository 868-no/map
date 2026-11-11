package api

import (
	"cmp"
	"context"
	"encoding/json"
	"slices"
	"time"

	"github.com/868-no/map/internal/protocol"
	"github.com/868-no/map/internal/query"
)

// ---- nodes with their reported positions (D-212) ----
//
// For other services: every node that reported its own position in the
// window, with its newest name and role. Read straight from the stored
// rows, without the browser's rules (no estimates, staleness, position
// choice or plausibility checks): a light lookup, not a view.

// nodesPath is /nodes: per-client concurrency counts it as heavy.
const nodesPath = "/api/v1/nodes"

type NodesInput struct {
	WindowParams
	Format string `query:"format" enum:"json,geojson" default:"json" doc:"json: a list of nodes; geojson: a FeatureCollection of points (application/geo+json)"`
}

// NodePosition is a node's newest reported position in the window.
type NodePosition struct {
	Lat            float64   `json:"lat"`
	Lon            float64   `json:"lon"`
	Alt            *int32    `json:"alt,omitempty" doc:"Altitude above sea level, metres, as reported"`
	PrecisionBits  uint32    `json:"precision_bits" doc:"Bits of latitude and longitude the node shared: fewer is coarser (32: full precision)"`
	PrecisionKnown bool      `json:"precision_known" doc:"The node stated its precision; false: precision_bits is assumed"`
	Source         string    `json:"source" enum:"position,mapreport" doc:"A Position packet over the mesh, or the node's own map report over MQTT"`
	Signature      string    `json:"signature" enum:"verified,unsigned,not-applicable" doc:"Signature status of that packet (map reports are never signed)"`
	ObservedAt     time.Time `json:"observed_at" doc:"When this service received it"`
}

// NodeIdentity is a node's newest name and role in the window.
type NodeIdentity struct {
	LongName   string    `json:"long_name,omitempty"`
	ShortName  string    `json:"short_name,omitempty"`
	HwModel    string    `json:"hw_model,omitempty"`
	Role       string    `json:"role,omitempty"`
	Source     string    `json:"source" enum:"nodeinfo,mapreport" doc:"A NodeInfo packet, or the node's map report when the window holds no NodeInfo from it"`
	Signature  string    `json:"signature" enum:"verified,unsigned,not-applicable" doc:"Signature status of that packet"`
	ObservedAt time.Time `json:"observed_at" doc:"When this service received it"`
}

type NodeEntry struct {
	ID       string        `json:"id" example:"!98644b01"`
	Num      uint32        `json:"num" doc:"The node number, as id in decimal"`
	Identity *NodeIdentity `json:"identity,omitempty" doc:"Absent when the window holds no usable NodeInfo or named map report from it"`
	Position NodePosition  `json:"position"`
}

type NodesBody struct {
	Window WindowEcho  `json:"window"`
	Nodes  []NodeEntry `json:"nodes" doc:"By id"`
}

// The GeoJSON form: one Point feature per node, its NodeEntry fields (but
// the coordinates) as properties.
type NodeFeatureProps struct {
	ID       string        `json:"id"`
	Num      uint32        `json:"num"`
	Identity *NodeIdentity `json:"identity,omitempty"`
	Position NodePosition  `json:"position"`
}

type NodePoint struct {
	Type        string     `json:"type" enum:"Point"`
	Coordinates [2]float64 `json:"coordinates" doc:"[longitude, latitude] (WGS 84)"`
}

type NodeFeature struct {
	Type       string           `json:"type" enum:"Feature"`
	ID         string           `json:"id"`
	Geometry   NodePoint        `json:"geometry"`
	Properties NodeFeatureProps `json:"properties"`
}

type NodesGeoJSON struct {
	Type     string        `json:"type" enum:"FeatureCollection"`
	Window   WindowEcho    `json:"window" doc:"Foreign member: the window the nodes were read from"`
	Features []NodeFeature `json:"features"`
}

// NodesOutput carries either form, already encoded; the operation declares
// both schemas.
type NodesOutput struct {
	ContentType  string `header:"Content-Type"`
	CacheControl string `header:"Cache-Control"`
	Body         []byte
}

func (s *Server) nodes(ctx context.Context, in *NodesInput) (*NodesOutput, error) {
	w, err := s.parseWindow(in.WindowParams)
	if err != nil {
		return nil, err
	}
	release, err := s.acquire(ctx)
	if err != nil {
		return nil, err
	}
	rows, err := query.LatestNodeRows(ctx, s.Pool, w)
	release()
	if err != nil {
		return nil, err
	}
	nodes := nodeEntries(rows)
	var body any = NodesBody{Window: echo(w), Nodes: nodes}
	ct := "application/json"
	if in.Format == "geojson" {
		body, ct = nodesGeoJSON(echo(w), nodes), "application/geo+json"
	}
	b, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	// A rolling window's bounds are floored to the live quantum, so callers
	// polling it share answers; a minute behind is fine for a lookup.
	return &NodesOutput{ContentType: ct, CacheControl: "public, max-age=60", Body: b}, nil
}

// nodeMeta is the part of decoded_metadata /nodes reads.
type nodeMeta struct {
	NodeInfo *struct {
		LongName  string `json:"long_name"`
		ShortName string `json:"short_name"`
		HwModel   string `json:"hw_model"`
		Role      string `json:"role"`
	} `json:"nodeinfo"`
	Position *struct {
		Lat            float64 `json:"lat"`
		Lon            float64 `json:"lon"`
		Alt            *int32  `json:"alt"`
		PrecisionBits  uint32  `json:"precision_bits"`
		PrecisionKnown bool    `json:"precision_known"`
	} `json:"position"`
	MapReport *struct {
		LongName  string `json:"long_name"`
		ShortName string `json:"short_name"`
		HwModel   string `json:"hw_model"`
		Role      string `json:"role"`
	} `json:"mapreport"`
}

// nodeEntries builds one entry per node with a position from each node's
// newest rows (query.LatestNodeRows): the newer of its Position packet and
// map report gives the position; its NodeInfo, or else a map report that
// names it, the identity. Nodes without a position are left out.
func nodeEntries(rows []query.NodeRow) []NodeEntry {
	type acc struct {
		pos      *NodePosition
		info, mr *NodeIdentity
	}
	by := map[uint32]*acc{}
	for _, r := range rows {
		var m nodeMeta
		if json.Unmarshal(r.Meta, &m) != nil {
			continue
		}
		a := by[r.Node]
		if a == nil {
			a = &acc{}
			by[r.Node] = a
		}
		if p := m.Position; p != nil && (r.Type == "position" || r.Type == "mapreport") {
			if a.pos == nil || r.At.After(a.pos.ObservedAt) {
				a.pos = &NodePosition{Lat: p.Lat, Lon: p.Lon, Alt: p.Alt, PrecisionBits: p.PrecisionBits, PrecisionKnown: p.PrecisionKnown,
					Source: r.Type, Signature: r.Sig, ObservedAt: r.At}
			}
		}
		switch {
		case r.Type == "nodeinfo" && m.NodeInfo != nil:
			n := m.NodeInfo
			a.info = &NodeIdentity{LongName: n.LongName, ShortName: n.ShortName, HwModel: n.HwModel, Role: n.Role, Source: r.Type, Signature: r.Sig, ObservedAt: r.At}
		case r.Type == "mapreport" && m.MapReport != nil && (m.MapReport.LongName != "" || m.MapReport.ShortName != ""):
			n := m.MapReport
			a.mr = &NodeIdentity{LongName: n.LongName, ShortName: n.ShortName, HwModel: n.HwModel, Role: n.Role, Source: r.Type, Signature: r.Sig, ObservedAt: r.At}
		}
	}
	out := []NodeEntry{}
	for n, a := range by {
		if a.pos == nil {
			continue
		}
		e := NodeEntry{ID: protocol.NodeID(n), Num: n, Identity: a.info, Position: *a.pos}
		if e.Identity == nil {
			e.Identity = a.mr
		}
		out = append(out, e)
	}
	slices.SortFunc(out, func(a, b NodeEntry) int { return cmp.Compare(a.Num, b.Num) })
	return out
}

func nodesGeoJSON(w WindowEcho, nodes []NodeEntry) NodesGeoJSON {
	fc := NodesGeoJSON{Type: "FeatureCollection", Window: w, Features: make([]NodeFeature, 0, len(nodes))}
	for _, n := range nodes {
		fc.Features = append(fc.Features, NodeFeature{Type: "Feature", ID: n.ID,
			Geometry:   NodePoint{Type: "Point", Coordinates: [2]float64{n.Position.Lon, n.Position.Lat}},
			Properties: NodeFeatureProps(n)})
	}
	return fc
}
