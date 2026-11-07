//go:build integration

package integration

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/868-no/map/internal/places"
)

var nextPlace int

func rec(name, code, municipality string, importance int) places.Record {
	nextPlace++
	return places.Record{Place: places.Place{Name: name, Kind: places.Label(code), Municipality: municipality, Lat: 63, Lon: 10}, ID: nextPlace, Code: code, Importance: importance}
}

func load(t *testing.T, ctx context.Context, store *places.Store, rs ...places.Record) {
	t.Helper()
	st, err := places.Load(ctx, store.Pool, "test", func(fn func(places.Record) error) (places.ParseStats, error) {
		for _, r := range rs {
			if err := fn(r); err != nil {
				return places.ParseStats{}, err
			}
		}
		return places.ParseStats{Places: len(rs), Names: len(rs)}, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if st.Keys == 0 {
		t.Fatal("no keys")
	}
}

func names(t *testing.T, ctx context.Context, store *places.Store, q string) string {
	t.Helper()
	ps, err := store.Search(ctx, q)
	if err != nil {
		t.Fatal(err)
	}
	var out []string
	for _, p := range ps {
		out = append(out, p.Name+"/"+p.Kind+"/"+p.Municipality)
	}
	return strings.Join(out, ",")
}

// Place search over the loaded register (D-193): exact names first, then
// settlements, other features and minor ones; any word of a name matches;
// one per name and municipality; a reload swaps the names in whole.
func TestPlaceSearch(t *testing.T) {
	pool := freshDB(t)
	ctx := context.Background()
	store := &places.Store{Pool: pool}
	if _, err := store.Search(ctx, "heimdal"); !errors.Is(err, places.ErrNotLoaded) {
		t.Fatalf("before loading: %v", err)
	}
	if at, err := places.LoadedAt(ctx, pool); err != nil || !at.IsZero() {
		t.Fatalf("loaded at %v %v", at, err)
	}
	oslo := rec("Oslo", "kommune", "Oslo", 10)
	sami := rec("Oslo suohkan", "kommune", "Oslo", 10)
	sami.ID, sami.Alt = oslo.ID, true // the same place, in Northern Sami
	load(t, ctx, store, oslo, sami,
		rec("Heimdal", "gass-OljefeltISjø", "", 2),
		rec("Heimdalsbekken", "elv", "Trondheim", 2),
		rec("Heimdal", "gard", "Trondheim", 2),
		rec("Heimdal", "bydel", "Trondheim", 4),
		rec("Heimdal", "tettbebyggelse", "Arendal", 3),
		rec("Vesle Galdhøpiggen", "fjell", "Lom", 2),
		rec("Galdhøpiggen", "fjell", "Lom", 4),
		rec("Galdhøe", "fjell", "Lom", 2),
		rec("Nord-Fron", "kommune", "Nord-Fron", 0),
		rec("100%_sikker", "annenKulturdetalj", "Oslo", 0),
	)
	if got, want := names(t, ctx, store, "Heimdal"), "Heimdal/Bydel/Trondheim,Heimdal/Tettbebyggelse/Arendal,Heimdal/Gass-/oljefelt i sjø/,Heimdalsbekken/Elv/Trondheim"; got != want {
		t.Errorf("heimdal:\n got  %s\n want %s", got, want)
	}
	// The more important mountain first, then the shorter name.
	if got, want := names(t, ctx, store, "galdh"), "Galdhøpiggen/Fjell/Lom,Galdhøe/Fjell/Lom,Vesle Galdhøpiggen/Fjell/Lom"; got != want {
		t.Errorf("galdh: %s", got)
	}
	if got := names(t, ctx, store, "oslo"); got != "Oslo/Kommune/Oslo" { // not also as Oslo suohkan
		t.Errorf("oslo: %s", got)
	}
	if got := names(t, ctx, store, "fron"); got != "Nord-Fron/Kommune/Nord-Fron" {
		t.Errorf("fron: %s", got)
	}
	if got := names(t, ctx, store, "%_"); got != "" { // LIKE wildcards are text
		t.Errorf("wildcards: %s", got)
	}
	if got := names(t, ctx, store, "100%_"); got != "100%_sikker/Annen kulturdetalj/Oslo" {
		t.Errorf("literal: %s", got)
	}
	if at, err := places.LoadedAt(ctx, pool); err != nil || time.Since(at) > time.Minute {
		t.Errorf("loaded at %v %v", at, err)
	}
	load(t, ctx, store, rec("Tiller", "bydel", "Trondheim", 4))
	if got := names(t, ctx, store, "heimdal"); got != "" {
		t.Errorf("after a reload, old names: %s", got)
	}
	if got := names(t, ctx, store, "TILL"); got != "Tiller/Bydel/Trondheim" {
		t.Errorf("tiller: %s", got)
	}
	if err := pool.QueryRow(ctx, `SELECT 1 FROM pg_tables WHERE schemaname = 'places_load'`).Scan(new(int)); err == nil {
		t.Error("staging tables left behind")
	}
}
