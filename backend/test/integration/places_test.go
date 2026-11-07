//go:build integration

package integration

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/868-no/map/internal/places"
)

// nordFronGML is the register as Geonorge's GML has it, holding one place.
const nordFronGML = `<?xml version="1.0" encoding="UTF-8"?>
<gml:FeatureCollection xmlns:app="https://skjema.geonorge.no/SOSI/produktspesifikasjon/StedsnavnForVanligBruk/20231001" xmlns:gml="http://www.opengis.net/gml/3.2">
 <gml:featureMember><app:Sted gml:id="a">
  <app:posisjon><gml:Point><gml:pos>61.6 9.6</gml:pos></gml:Point></app:posisjon>
  <app:stedsnavn><app:Stedsnavn><app:offentligBruk>true</app:offentligBruk><app:navnestatus>hovednavn</app:navnestatus>
   <app:skrivemåte><app:Skrivemåte><app:komplettskrivemåte>Nord-Fron</app:komplettskrivemåte><app:skrivemåtestatus>vedtatt</app:skrivemåtestatus></app:Skrivemåte></app:skrivemåte>
  </app:Stedsnavn></app:stedsnavn>
  <app:navneobjekttype>kommune</app:navneobjekttype><app:sortering>viktighetA</app:sortering><app:stedsnummer>1</app:stedsnummer>
  <app:kommune><app:Kommune><app:kommunenavn>Nord-Fron</app:kommunenavn><app:fylkesnavn>Innlandet</app:fylkesnavn></app:Kommune></app:kommune>
 </app:Sted></gml:featureMember>
</gml:FeatureCollection>`

// A register loaded under an older way of folding names into keys is
// loaded again at the next check, however recent; one loaded under the
// current way is not.
func TestPlacesReloadUnderANewFold(t *testing.T) {
	pool := freshDB(t)
	ctx := context.Background()
	src := filepath.Join(t.TempDir(), "stedsnavn.gml")
	if err := os.WriteFile(src, []byte(nordFronGML), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := places.Refresh(ctx, pool, src, "test", time.Hour, quiet); err != nil {
		t.Fatal(err)
	}
	first, err := places.LoadedAt(ctx, pool)
	if err != nil || first.IsZero() {
		t.Fatalf("not loaded: %v %v", first, err)
	}
	// As a register loaded before key formats were recorded, a minute ago:
	// its keys keep the hyphen, so "nord fron" finds nothing in them.
	old := first.Add(-time.Minute).Format(time.RFC3339)
	if _, err := pool.Exec(ctx, fmt.Sprintf(`COMMENT ON TABLE place_name IS '%s 1 names from %s'`, old, src)); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE place_name SET name_lc = lower(name)`); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE place_key SET key = 'nord-fron' WHERE key = 'nord fron'`); err != nil {
		t.Fatal(err)
	}
	store := &places.Store{Pool: pool}
	if got := names(t, ctx, store, "nord fron"); got != "" {
		t.Fatalf("the old keys already match: %s", got)
	}
	if err := places.Refresh(ctx, pool, src, "test", time.Hour, quiet); err != nil {
		t.Fatal(err)
	}
	again, err := places.LoadedAt(ctx, pool)
	if err != nil || !again.After(first.Add(-time.Minute)) {
		t.Fatalf("not loaded again: %v %v", again, err)
	}
	if got := names(t, ctx, store, "nord fron"); got != "Nord-Fron/Kommune/Nord-Fron" {
		t.Fatalf("after loading again: %q", got)
	}
	// Loaded under the current format and recent: left as it is.
	if _, err := pool.Exec(ctx, `COMMENT ON TABLE place_name IS '`+old+` fold=`+fmt.Sprint(places.FoldVersion)+` 1 names from x'`); err != nil {
		t.Fatal(err)
	}
	if err := places.Refresh(ctx, pool, src, "test", time.Hour, quiet); err != nil {
		t.Fatal(err)
	}
	if at, _ := places.LoadedAt(ctx, pool); at.Format(time.RFC3339) != old {
		t.Fatalf("a current register was loaded again (%v)", at)
	}
}

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
		rec("Sør-Fron", "kommune", "Sør-Fron", 0),
		rec("St. Olavs gate", "adressenavn", "Trondheim", 0),
		rec("100%_sikker", "annenKulturdetalj", "Oslo", 0),
	)
	// Each search twice: as one matching few keys, and as a common one
	// (walking names in rank order), which must answer the same.
	for _, store := range []*places.Store{store, {Pool: pool, CommonPrefix: 1}} {
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
		// Punctuation between words reads as a space on both sides (places.Fold).
		if got := names(t, ctx, store, "fron"); got != "Sør-Fron/Kommune/Sør-Fron,Nord-Fron/Kommune/Nord-Fron" { // the shorter name first
			t.Errorf("fron: %s", got)
		}
		for _, q := range []string{"nord fron", "nord-fron", "Nord–Fron", "nord fr"} {
			if got := names(t, ctx, store, q); got != "Nord-Fron/Kommune/Nord-Fron" {
				t.Errorf("%s: %s", q, got)
			}
		}
		gate := "St. Olavs gate/" + places.Label("adressenavn") + "/Trondheim"
		for _, q := range []string{"st olav", "st. olav", "St.Olavs", "olavs g"} {
			if got := names(t, ctx, store, q); got != gate {
				t.Errorf("%s: %s", q, got)
			}
		}
		if got := names(t, ctx, store, "%_"); got != "" { // LIKE wildcards are text
			t.Errorf("wildcards: %s", got)
		}
		if got := names(t, ctx, store, "100%_"); got != "100%_sikker/Annen kulturdetalj/Oslo" {
			t.Errorf("literal: %s", got)
		}
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
