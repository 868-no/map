package places

import (
	"errors"
	"strings"
	"testing"
)

// Three places as Geonorge's GML has them: a district with three points, a
// mountain with a Norwegian and a Northern Sami name (and a historical
// spelling), and a road known only by a line, whose name is not in public use.
const sample = `<?xml version="1.0" encoding="UTF-8"?>
<gml:FeatureCollection xmlns:app="https://skjema.geonorge.no/SOSI/produktspesifikasjon/StedsnavnForVanligBruk/20231001" xmlns:gml="http://www.opengis.net/gml/3.2">
 <gml:featureMember><app:Sted gml:id="a">
  <app:multipunkt><gml:MultiPoint><gml:pointMember><gml:Point><gml:pos>63.35 10.36</gml:pos></gml:Point></gml:pointMember>
   <gml:pointMember><gml:Point><gml:pos>63.36 10.37</gml:pos></gml:Point></gml:pointMember>
   <gml:pointMember><gml:Point><gml:pos>63.40 10.40</gml:pos></gml:Point></gml:pointMember></gml:MultiPoint></app:multipunkt>
  <app:stedsnavn><app:Stedsnavn><app:offentligBruk>true</app:offentligBruk><app:navnestatus>hovednavn</app:navnestatus>
   <app:skrivemåte><app:Skrivemåte><app:komplettskrivemåte>Heimdal</app:komplettskrivemåte><app:skrivemåtestatus>godkjent</app:skrivemåtestatus></app:Skrivemåte></app:skrivemåte>
  </app:Stedsnavn></app:stedsnavn>
  <app:navneobjekttype>bydel</app:navneobjekttype><app:sortering>viktighetE</app:sortering><app:stedsnummer>781023</app:stedsnummer>
  <app:kommune><app:Kommune><app:kommunenavn>Trondheim</app:kommunenavn><app:fylkesnavn>Trøndelag</app:fylkesnavn></app:Kommune></app:kommune>
 </app:Sted></gml:featureMember>
 <gml:featureMember><app:Sted gml:id="b">
  <app:posisjon><gml:Point><gml:pos>69.0 20.5</gml:pos></gml:Point></app:posisjon>
  <app:stedsnavn><app:Stedsnavn><app:offentligBruk>true</app:offentligBruk><app:navnestatus>hovednavn</app:navnestatus>
   <app:skrivemåte><app:Skrivemåte><app:komplettskrivemåte>Store  Fjell</app:komplettskrivemåte><app:skrivemåtestatus>vedtatt</app:skrivemåtestatus></app:Skrivemåte></app:skrivemåte>
   <app:skrivemåte><app:Skrivemåte><app:komplettskrivemåte>Storfjellet</app:komplettskrivemåte><app:skrivemåtestatus>historisk</app:skrivemåtestatus></app:Skrivemåte></app:skrivemåte>
  </app:Stedsnavn><app:Stedsnavn><app:offentligBruk>true</app:offentligBruk><app:navnestatus>sidenavn</app:navnestatus>
   <app:skrivemåte><app:Skrivemåte><app:komplettskrivemåte>Stuorravárri</app:komplettskrivemåte><app:skrivemåtestatus>godkjent</app:skrivemåtestatus></app:Skrivemåte></app:skrivemåte>
  </app:Stedsnavn></app:stedsnavn>
  <app:navneobjekttype>fjell</app:navneobjekttype><app:sortering>viktighetC</app:sortering>
 </app:Sted></gml:featureMember>
 <gml:featureMember><app:Sted gml:id="c">
  <app:multikurve><gml:MultiCurve><gml:curveMember><gml:LineString><gml:posList>60.0 5.0 60.1 5.1 60.2 5.2</gml:posList></gml:LineString></gml:curveMember></gml:MultiCurve></app:multikurve>
  <app:stedsnavn><app:Stedsnavn><app:offentligBruk>false</app:offentligBruk><app:navnestatus>hovednavn</app:navnestatus>
   <app:skrivemåte><app:Skrivemåte><app:komplettskrivemåte>Kjekallen</app:komplettskrivemåte><app:skrivemåtestatus>vedtatt</app:skrivemåtestatus></app:Skrivemåte></app:skrivemåte>
  </app:Stedsnavn></app:stedsnavn>
  <app:navneobjekttype>adressenavn</app:navneobjekttype><app:sortering>viktighetC</app:sortering>
 </app:Sted></gml:featureMember>
</gml:FeatureCollection>`

func TestParseKeepsNamesInUseWithAPointOnTheFeature(t *testing.T) {
	var got []Record
	st, err := Parse(strings.NewReader(sample), func(r Record) error { got = append(got, r); return nil })
	if err != nil {
		t.Fatal(err)
	}
	if st.Places != 3 || st.Names != 3 || st.NotInUse != 1 {
		t.Errorf("stats %+v", st)
	}
	if len(got) != 3 {
		t.Fatalf("records %+v", got)
	}
	h := got[0]
	// Of three points, the one nearest their mean, not the mean itself.
	if h.Name != "Heimdal" || h.Kind != "Bydel" || h.Code != "bydel" || h.Municipality != "Trondheim" || h.County != "Trøndelag" || h.Importance != 4 || h.ID != 781023 || h.Lat != 63.36 || h.Lon != 10.37 {
		t.Errorf("district %+v", h)
	}
	if got[1].Name != "Store Fjell" || got[1].Alt || !got[2].Alt || h.Alt || got[1].Kind != "Fjell" || got[2].Name != "Stuorravárri" || got[2].Lat != 69 || got[2].Lon != 20.5 {
		t.Errorf("mountain %+v %+v", got[1], got[2])
	}
}

func TestParseTakesTheVertexNearestTheMiddleOfALine(t *testing.T) {
	s := strings.Replace(sample, "<app:offentligBruk>false", "<app:offentligBruk>true", 1)
	var road Record
	if _, err := Parse(strings.NewReader(s), func(r Record) error {
		if r.Name == "Kjekallen" {
			road = r
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if road.Lat != 60.1 || road.Lon != 5.1 || road.Kind != "Adressenavn" {
		t.Errorf("road %+v", road)
	}
}

func TestParseStopsWhenTold(t *testing.T) {
	stop := errors.New("stop")
	if _, err := Parse(strings.NewReader(sample), func(Record) error { return stop }); !errors.Is(err, stop) {
		t.Errorf("err %v", err)
	}
}

func TestRankPutsSettlementsFirstAndMinorFeaturesLast(t *testing.T) {
	if rank("by") >= rank("bydel") || rank("bydel") >= rank("grend") || rank("grend") >= rank("fjell") || rank("fjell") >= rank("gard") {
		t.Error("rank order")
	}
	if Label("bygdelagBygd") != "Bygdelag (bygd)" || Label("ukjentType") != "ukjentType" {
		t.Error("labels")
	}
}

func TestNormalizeRefusesBadQueries(t *testing.T) {
	for _, q := range []string{"a", " ", "a\x00b", string(make([]rune, 65))} {
		if _, err := Normalize(q); !errors.Is(err, ErrQuery) {
			t.Errorf("%q: %v, want ErrQuery", q, err)
		}
	}
	if q, err := Normalize("  St   Olav "); err != nil || q != "st olav" {
		t.Errorf("%q %v", q, err)
	}
}

// Names and searches fold the same way: punctuation between words is a
// space, apostrophes vanish, and LIKE wildcards stay text.
func TestFold(t *testing.T) {
	for in, want := range map[string]string{
		"Nord-Fron":          "nord fron",
		"nord  fron":         "nord fron",
		"St. Olavs gate":     "st olavs gate",
		"St.Olavs gate":      "st olavs gate",
		"Bø (Telemark)":      "bø telemark",
		"Inn/Ut – Øvre":      "inn ut øvre",
		"Jacob's plass":      "jacobs plass",
		"100%_sikker":        "100%_sikker",
		" -. ":               "",
		"ÆRØ, Sør-Trøndelag": "ærø sør trøndelag",
	} {
		if got := Fold(in); got != want {
			t.Errorf("Fold(%q) = %q, want %q", in, got, want)
		}
	}
	if _, err := Normalize("-.-"); !errors.Is(err, ErrQuery) {
		t.Errorf("punctuation alone: %v", err)
	}
	if q, err := Normalize("St. Olav"); err != nil || q != "st olav" {
		t.Errorf("%q %v", q, err)
	}
}
