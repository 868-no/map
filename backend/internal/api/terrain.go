package api

import (
	"context"
	"errors"
	"fmt"
	"math"

	"github.com/danielgtaylor/huma/v2"

	"github.com/868-no/map/internal/terrain"
)

// ---- terrain (D-143) ----
//
// Cross sections of the earth between two points from Kartverket's terrain
// model, and whether a radio link between them is clear, grazing or blocked.
// Not mesh data: the browser sends the positions of the ends it already
// shows, and this server fetches the heights, so visitors make no
// third-party request.

const maxTerrainLinks = 400

// terrainEnds makes a link's ends. bad is why they cannot be looked up:
// not finite (a NaN passes huma's minimum and maximum, since no comparison
// holds), outside the area the terrain model covers (terrain.Coverage), or
// over 300 km apart. Only the first is the request's fault in every use
// (design §6.19, D-147).
func terrainEnds(lat1, lon1, alt1, lat2, lon2, alt2 float64) (a, b terrain.End, finite bool, bad string) {
	for _, v := range []float64{lat1, lon1, alt1, lat2, lon2, alt2} {
		if math.IsNaN(v) || math.IsInf(v, 0) {
			return a, b, false, "positions and altitudes must be finite numbers"
		}
	}
	a = terrain.End{Point: terrain.Point{Lat: lat1, Lon: lon1}, Alt: alt(alt1)}
	b = terrain.End{Point: terrain.Point{Lat: lat2, Lon: lon2}, Alt: alt(alt2)}
	switch {
	case !terrain.Covered(a.Point) || !terrain.Covered(b.Point):
		return a, b, true, "an end is outside the area the terrain model covers (mainland Norway)"
	case terrain.Distance(a.Point, b.Point) > terrain.MaxLengthM:
		return a, b, true, "the ends are further apart than 300 km"
	}
	return a, b, true, ""
}

type TerrainProfileInput struct {
	Lat1 float64 `query:"lat1" required:"true" minimum:"-90" maximum:"90" doc:"Latitude of the first end; both ends must lie in mainland Norway or its border strip (57.5–71.5° N, 4–31.5° E), else 422"`
	Lon1 float64 `query:"lon1" required:"true" minimum:"-180" maximum:"180"`
	Lat2 float64 `query:"lat2" required:"true" minimum:"-90" maximum:"90" doc:"Latitude of the second end"`
	Lon2 float64 `query:"lon2" required:"true" minimum:"-180" maximum:"180"`
	Alt1 float64 `query:"alt1" doc:"Altitude the first end reports, m above sea level; 0 or absent: none, the antenna is put 2 m above the terrain"`
	Alt2 float64 `query:"alt2" doc:"Altitude the second end reports"`
}

// alt is a reported altitude: Meshtastic sends 0 when it has none.
func alt(v float64) *float64 {
	if v == 0 {
		return nil
	}
	return &v
}

type TerrainProfileBody struct {
	terrain.Profile
	Incomplete  bool   `json:"incomplete,omitempty" doc:"Heights are still being fetched; ask again in a few seconds"`
	Attribution string `json:"attribution"`
}

type TerrainProfileOutput struct {
	CacheControl string `header:"Cache-Control"`
	Body         TerrainProfileBody
}

func (s *Server) terrainProfile(ctx context.Context, in *TerrainProfileInput) (*TerrainProfileOutput, error) {
	if s.Terrain == nil {
		return nil, huma.Error404NotFound("terrain is not enabled on this server")
	}
	a, b, _, bad := terrainEnds(in.Lat1, in.Lon1, in.Alt1, in.Lat2, in.Lon2, in.Alt2)
	if bad != "" {
		return nil, huma.Error422UnprocessableEntity(bad)
	}
	p, incomplete := s.Terrain.ProfileFor(ctx, clientOf(ctx), a, b)
	cache := "public, max-age=86400" // terrain does not change
	switch {
	case incomplete:
		cache = "no-store"
	case p.Class == "unknown":
		// The model lacks heights here (abroad); kept briefly in case that
		// was a fault rather than the border.
		cache = "public, max-age=300"
	}
	return &TerrainProfileOutput{CacheControl: cache, Body: TerrainProfileBody{Profile: p, Incomplete: incomplete, Attribution: terrain.Attribution}}, nil
}

type TerrainLink struct {
	Lat1 float64 `json:"lat1" minimum:"-90" maximum:"90"`
	Lon1 float64 `json:"lon1" minimum:"-180" maximum:"180"`
	Lat2 float64 `json:"lat2" minimum:"-90" maximum:"90"`
	Lon2 float64 `json:"lon2" minimum:"-180" maximum:"180"`
	Alt1 float64 `json:"alt1,omitempty" doc:"Altitude the first end reports, m above sea level; 0 or absent: none"`
	Alt2 float64 `json:"alt2,omitempty"`
}

type TerrainClassesInput struct {
	Body struct {
		Links []TerrainLink `json:"links" maxItems:"400" doc:"Links to classify, by the positions of their ends. A link with an end outside mainland Norway and its border strip (57.5–71.5° N, 4–31.5° E), or over 300 km long, is unknown; at most 120 000 distinct terrain points in all, else 422"`
	}
}

type TerrainClass struct {
	Class string `json:"class" enum:"clear,grazing,blocked,unknown"`
}

type TerrainClassesOutput struct {
	Body struct {
		Classes     []TerrainClass `json:"classes" doc:"One per link, in order"`
		Incomplete  bool           `json:"incomplete,omitempty" doc:"Heights are still being fetched; ask again in a few seconds"`
		Attribution string         `json:"attribution"`
	}
}

func (s *Server) terrainClasses(ctx context.Context, in *TerrainClassesInput) (*TerrainClassesOutput, error) {
	if s.Terrain == nil {
		return nil, huma.Error404NotFound("terrain is not enabled on this server")
	}
	if len(in.Body.Links) > maxTerrainLinks {
		return nil, huma.Error400BadRequest("too many links")
	}
	// One lookup for every link's points: nearby links share most of them.
	// A link abroad or too long is not looked up and stays unknown: the page
	// sends every router link, wherever its ends are.
	// Their points are gathered without holding them all: up to 400 links of
	// 300 km would be 600 000.
	var looked [][2]terrain.Point
	ends := make([][2]terrain.End, len(in.Body.Links))
	ok := make([]bool, len(in.Body.Links))
	for i, l := range in.Body.Links {
		a, b, finite, bad := terrainEnds(l.Lat1, l.Lon1, l.Alt1, l.Lat2, l.Lon2, l.Alt2)
		if !finite {
			return nil, huma.Error422UnprocessableEntity(fmt.Sprintf("link %d: %s", i, bad))
		}
		ends[i], ok[i] = [2]terrain.End{a, b}, bad == ""
		if ok[i] {
			looked = append(looked, [2]terrain.Point{a.Point, b.Point})
		}
	}
	heights, incomplete, err := s.Terrain.LinksFor(ctx, clientOf(ctx), looked)
	if errors.Is(err, terrain.ErrTooManyPoints) {
		return nil, huma.Error422UnprocessableEntity(fmt.Sprintf("the links need more than %d terrain points; ask for fewer or shorter links", terrain.MaxPoints))
	} else if err != nil {
		return nil, err
	}
	out := &TerrainClassesOutput{}
	out.Body.Incomplete, out.Body.Attribution = incomplete, terrain.Attribution
	out.Body.Classes = make([]TerrainClass, len(ends))
	for i, e := range ends {
		c := TerrainClass{Class: "unknown"}
		if ok[i] {
			p := terrain.Build(e[0], e[1], heights.At)
			// Until every height of this link is in, a missing one could be
			// what blocks it; other links' missing heights do not matter.
			if linkKnown(heights, e[0].Point, e[1].Point) {
				c.Class = p.Class
			}
		}
		out.Body.Classes[i] = c
	}
	return out, nil
}

// linkKnown reports whether every point of the link's cross section has
// been looked up.
func linkKnown(h terrain.Lookup, a, b terrain.Point) bool {
	for _, p := range terrain.Points(a, b) {
		if !h.Known(p) {
			return false
		}
	}
	return true
}
