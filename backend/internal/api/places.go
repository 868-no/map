package api

import (
	"context"
	"errors"

	"github.com/danielgtaylor/huma/v2"

	"github.com/868-no/map/internal/places"
)

// ---- place names (D-193) ----
//
// The map's search finds Norwegian places by name. Not mesh data: the names
// are Kartverket's register, loaded into the database (places.Store), so a
// search asks no one else.

type PlacesInput struct {
	Q string `query:"q" required:"true" minLength:"2" maxLength:"256" doc:"The start of a place name, or of a word in it; 2 to 64 characters once folded (lower case, punctuation between words read as spaces)"`
}

type PlacesOutput struct {
	CacheControl string `header:"Cache-Control"`
	Body         struct {
		Places      []places.Place `json:"places" doc:"Best match first, at most 8"`
		Attribution string         `json:"attribution"`
	}
}

func (s *Server) places(ctx context.Context, in *PlacesInput) (*PlacesOutput, error) {
	if s.Places == nil {
		return nil, huma.Error404NotFound("place search is not enabled on this server")
	}
	ps, err := s.Places.Search(ctx, in.Q)
	switch {
	case errors.Is(err, places.ErrQuery):
		return nil, huma.Error400BadRequest(err.Error())
	case errors.Is(err, places.ErrNotLoaded):
		return nil, huma.Error503ServiceUnavailable("place names are still being loaded")
	case errors.Is(err, places.ErrSearchBusy):
		return nil, huma.Error503ServiceUnavailable("place search is busy, retry shortly")
	case err != nil:
		if ctx.Err() == nil {
			s.Log.Warn("place search failed", "err", err)
		}
		return nil, huma.Error503ServiceUnavailable("place search is unavailable right now")
	}
	out := &PlacesOutput{CacheControl: "public, max-age=86400"} // the register is reloaded monthly
	out.Body.Places, out.Body.Attribution = ps, places.Attribution
	return out, nil
}
