package api

import (
	"context"

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

type TerrainProfileInput struct {
	Lat1 float64 `query:"lat1" required:"true" minimum:"-90" maximum:"90" doc:"Latitude of the first end"`
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
	a := terrain.End{Point: terrain.Point{Lat: in.Lat1, Lon: in.Lon1}, Alt: alt(in.Alt1)}
	b := terrain.End{Point: terrain.Point{Lat: in.Lat2, Lon: in.Lon2}, Alt: alt(in.Alt2)}
	if terrain.Distance(a.Point, b.Point) > terrain.MaxLengthM {
		return nil, huma.Error422UnprocessableEntity("the ends are further apart than 300 km")
	}
	p, incomplete := s.Terrain.Profile(ctx, a, b)
	cache := "public, max-age=86400" // terrain does not change
	if incomplete {
		cache = "no-store"
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
		Links []TerrainLink `json:"links" maxItems:"400" doc:"Links to classify, by the positions of their ends"`
	}
}

type TerrainClass struct {
	Class          string  `json:"class" enum:"clear,grazing,blocked,unknown"`
	LengthM        float64 `json:"length_m"`
	WorstClearance float64 `json:"worst_clearance" doc:"Least free part of the first Fresnel zone, in Fresnel radii"`
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
	var pts []terrain.Point
	ends := make([][2]terrain.End, len(in.Body.Links))
	for i, l := range in.Body.Links {
		a := terrain.End{Point: terrain.Point{Lat: l.Lat1, Lon: l.Lon1}, Alt: alt(l.Alt1)}
		b := terrain.End{Point: terrain.Point{Lat: l.Lat2, Lon: l.Lon2}, Alt: alt(l.Alt2)}
		ends[i] = [2]terrain.End{a, b}
		if terrain.Distance(a.Point, b.Point) <= terrain.MaxLengthM {
			pts = append(pts, terrain.Points(a.Point, b.Point)...)
		}
	}
	height, incomplete := s.Terrain.Heights(ctx, pts)
	out := &TerrainClassesOutput{}
	out.Body.Incomplete, out.Body.Attribution = incomplete, terrain.Attribution
	out.Body.Classes = make([]TerrainClass, len(ends))
	for i, e := range ends {
		c := TerrainClass{Class: "unknown", LengthM: terrain.Distance(e[0].Point, e[1].Point)}
		if c.LengthM <= terrain.MaxLengthM {
			p := terrain.Build(e[0], e[1], height)
			c.LengthM, c.WorstClearance = p.LengthM, p.WorstClearance
			// Until every height is in, a missing one could be what blocks a link.
			if !incomplete {
				c.Class = p.Class
			}
		}
		c.LengthM = float64(int(c.LengthM + 0.5))
		out.Body.Classes[i] = c
	}
	return out, nil
}
