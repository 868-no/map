// Package places searches Norwegian place names for the map's search
// (D-193): Kartverket's place-name register (Sentralt stedsnavnregister,
// CC BY 4.0), downloaded from Geonorge and loaded into the database, so a
// search asks no one outside this server.
package places

import (
	"errors"
	"strings"
	"unicode"
)

// DefaultURL is Geonorge's download of the register for common use, as GML
// in EPSG:4258 (latitude and longitude), zipped: about 140 MB.
const DefaultURL = "https://nedlasting.geonorge.no/geonorge/Basisdata/Stedsnavn/GML/Basisdata_0000_Norge_4258_Stedsnavn_GML.zip"

// Attribution is what Kartverket's licence asks for.
const Attribution = "Place names: © Kartverket"

const (
	// MinQuery and MaxQuery bound a search, in characters.
	MinQuery = 2
	MaxQuery = 64
	// Results per search.
	perSearch = 8
)

// ErrQuery: the search text is too short, too long or not text.
var ErrQuery = errors.New("places: the search must be 2 to 64 characters of text")

// Place is one named place.
type Place struct {
	Name         string  `json:"name"`
	Kind         string  `json:"kind" doc:"Kartverket's name object type, e.g. Fjell, By, Tettsted, Innsjø (Norwegian)"`
	Municipality string  `json:"municipality,omitempty"`
	County       string  `json:"county,omitempty"`
	Lat          float64 `json:"lat"`
	Lon          float64 `json:"lon"`
}

// Fold is a name or search as matched: lower case, with the punctuation
// that separates words in names (hyphens, dashes, full stops, slashes,
// brackets, commas and the like) turned into spaces and apostrophes
// dropped, spaces collapsed and trimmed. Names are stored folded (name_lc)
// and their keys taken from that, and searches are folded the same way, so
// "nord fron" finds Nord-Fron and "st olav" St. Olavs gate. Other
// characters, '%' and '_' among them, are kept.
func Fold(s string) string {
	s = strings.Map(func(r rune) rune {
		switch r {
		case '-', '‐', '‑', '–', '—', '.', '/', '\\', '(', ')', '[', ']', ',', ':', ';', '!', '?', '"', '«', '»', '“', '”':
			return ' '
		case '\'', '’', '`', '´':
			return -1
		}
		return unicode.ToLower(r)
	}, s)
	return strings.Join(strings.Fields(s), " ")
}

// FoldVersion names how Fold and the keys taken from its result work. A
// register loaded under another version is loaded again (Refresh), so a
// change here reaches loaded names without waiting for PLACES_MAX_AGE_DAYS.
// 1: lower case only (no version recorded); 2: Fold.
const FoldVersion = 2

// Normalize is the search as matched (Fold); ErrQuery when that is not 2
// to 64 characters of text.
func Normalize(q string) (string, error) {
	q = Fold(q)
	n := 0
	for _, r := range q {
		if unicode.IsControl(r) {
			return "", ErrQuery
		}
		n++
	}
	if n < MinQuery || n > MaxQuery {
		return "", ErrQuery
	}
	return q, nil
}

// rank orders kinds of place (navneobjekttype codes): where people live
// first, minor features last, others in between.
func rank(code string) int {
	switch code {
	case "by", "kommune", "fylke":
		return 0
	case "tettsted", "tettbebyggelse", "bydel", "tettsteddel", "administrativBydel":
		return 1
	case "grend", "bygdelagBygd", "boligfelt", "hyttefelt":
		return 2
	case "gard", "bruk", "navnegard", "adressenavn", "adressetilleggsnavn", "matrikkeladressenavn", "bru", "vegkryss", "vegsving",
		"jorde", "eng", "sti", "traktorveg", "utmark", "eiendom", "eiendomsteig", "stølsSetereiendom", "eneboligMindreBoligbygg",
		"fritidsbolig", "boligblokk", "byggForJordbrukFiskeOgFangst", "gammelBosettingsplass", "annenKulturdetalj",
		"annenTerrengdetalj", "grunnkrets", "valgkrets", "skolekrets", "sokn", "grind", "gjerde", "tuft", "statistiskTettsted":
		return 4
	}
	return 3
}
