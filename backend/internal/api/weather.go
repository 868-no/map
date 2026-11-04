package api

import (
	"context"
	"time"

	"github.com/danielgtaylor/huma/v2"

	"github.com/868-no/map/internal/weather"
	"github.com/868-no/map/internal/window"
)

// ---- weather (D-133) ----
//
// Hourly weather at a point from MET Norway's MET Nordic analysis, for the
// charts of stationary routers and their links. It is not mesh data: the
// browser asks for it beside the window's rows, and this server fetches it,
// so visitors make no third-party request.

type WeatherInput struct {
	Lat   float64 `query:"lat" required:"true" minimum:"-90" maximum:"90" doc:"Latitude of the point"`
	Lon   float64 `query:"lon" required:"true" minimum:"-180" maximum:"180" doc:"Longitude of the point"`
	Start string  `query:"start" required:"true" doc:"Inclusive start, RFC 3339" example:"2026-10-28T00:00:00Z"`
	End   string  `query:"end" required:"true" doc:"Exclusive end, RFC 3339; at most the longest window after start" example:"2026-10-31T00:00:00Z"`
}

type WeatherBody struct {
	Hours       []weather.Hour `json:"hours" doc:"Hourly values in [start, end), oldest first; hours the analysis lacks are left out"`
	Incomplete  bool           `json:"incomplete,omitempty" doc:"Some hours are still being fetched; ask again in a few seconds"`
	Attribution string         `json:"attribution"`
}

type WeatherOutput struct {
	CacheControl string `header:"Cache-Control"`
	Body         WeatherBody
}

func (s *Server) weather(ctx context.Context, in *WeatherInput) (*WeatherOutput, error) {
	if s.Weather == nil {
		return nil, huma.Error404NotFound("weather is not enabled on this server")
	}
	start, err := parseTime("start", in.Start)
	if err != nil {
		return nil, err
	}
	end, err := parseTime("end", in.End)
	if err != nil {
		return nil, err
	}
	now := s.now()
	maxSpan := time.Duration(s.Env.MaxWindowHours+2) * time.Hour // slack for rounding both ends to hours
	switch {
	case !end.After(start):
		return nil, huma.Error400BadRequest("end must be after start")
	case end.Sub(start) > maxSpan:
		return nil, huma.Error400BadRequest("span longer than the longest window")
	case start.Before(window.RetentionCutoff(now, s.Env.RetentionMonths).Add(-time.Hour)):
		return nil, huma.Error400BadRequest("start before the retention period")
	}
	cell, ok := weather.CellAt(in.Lat, in.Lon)
	if !ok {
		return nil, huma.Error422UnprocessableEntity("outside the area the weather analysis covers")
	}
	// Cached hours now; the rest are fetched in the background, each
	// client's in turn (D-141), and the browser asks again while the answer
	// is incomplete.
	hours, incomplete := s.Weather.SeriesFor(ctx, clientOf(ctx), cell, start, end)
	if hours == nil {
		hours = []weather.Hour{}
	}
	cache := "public, max-age=600"
	if incomplete {
		cache = "no-store"
	} else if now.Sub(end) > weather.SettledAfter {
		cache = "public, max-age=86400" // settled hours do not change; gust-less ones are asked again until then
	}
	return &WeatherOutput{CacheControl: cache, Body: WeatherBody{Hours: hours, Incomplete: incomplete, Attribution: weather.Attribution}}, nil
}
