package places

import (
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"math"
	"regexp"
	"strconv"
	"strings"
)

// Record is one name of one place, as loaded: a place with names in several
// languages, or several spellings in use, gives one Record per name.
type Record struct {
	Place
	ID         int    // the place's stedsnummer, shared by its names
	Alt        bool   // not the place's main name: another language or spelling
	Code       string // navneobjekttype as coded, e.g. bydel
	Importance int    // Kartverket's sortering: 0 for viktighetA, 1 for B, ...; higher is more important (fylke, by)
}

// ParseStats counts what Parse read and left out.
type ParseStats struct {
	Places, Names, NoPoint, NotInUse int
}

// The parts of a place (app:Sted) in Kartverket's GML for common use
// (StedsnavnForVanligBruk) read here.
type sted struct {
	Number int    `xml:"stedsnummer"`
	Kind   string `xml:"navneobjekttype"`
	Sort   string `xml:"sortering"`
	Names  []struct {
		Public   bool   `xml:"offentligBruk"`
		Status   string `xml:"navnestatus"`
		Spelling []struct {
			Text   string `xml:"komplettskrivemåte"`
			Status string `xml:"skrivemåtestatus"`
		} `xml:"skrivemåte>Skrivemåte"`
	} `xml:"stedsnavn>Stedsnavn"`
	Kommune []struct {
		Name   string `xml:"kommunenavn"`
		County string `xml:"fylkesnavn"`
	} `xml:"kommune>Kommune"`
	Geometry []geometry `xml:",any"`
}

// geometry is any child element; only those holding coordinates
// (posisjon, multipunkt, multikurve, senterlinje, område) yield any.
type geometry struct {
	XMLName xml.Name
	Inner   []byte `xml:",innerxml"`
}

var posRe = regexp.MustCompile(`<(?:[\w-]+:)?pos(?:List)?\b[^>]*>([^<]*)<`)

// point is a place's representative point: its position, or of several
// coordinates (points, a line, an outline) the one nearest their mean, so
// the point lies on the feature.
func (s *sted) point() (lat, lon float64, ok bool) {
	var pts [][2]float64
	for _, g := range s.Geometry {
		switch g.XMLName.Local {
		case "posisjon", "multipunkt", "multikurve", "senterlinje", "område":
		default:
			continue
		}
		for _, m := range posRe.FindAllSubmatch(g.Inner, -1) {
			f := strings.Fields(string(m[1]))
			for k := 0; k+1 < len(f); k += 2 { // EPSG:4258: latitude first
				la, err1 := strconv.ParseFloat(f[k], 64)
				lo, err2 := strconv.ParseFloat(f[k+1], 64)
				if err1 == nil && err2 == nil {
					pts = append(pts, [2]float64{la, lo})
				}
			}
		}
	}
	if len(pts) == 0 {
		return 0, 0, false
	}
	var mla, mlo float64
	for _, p := range pts {
		mla, mlo = mla+p[0], mlo+p[1]
	}
	mla, mlo = mla/float64(len(pts)), mlo/float64(len(pts))
	best, bd := pts[0], math.Inf(1)
	for _, p := range pts {
		if d := (p[0]-mla)*(p[0]-mla) + (p[1]-mlo)*(p[1]-mlo); d < bd {
			best, bd = p, d
		}
	}
	return best[0], best[1], true
}

// inUse: names in public use that are not historical, and their spellings
// approved, adopted, international, private or not yet assessed (proposed
// and historical spellings, and name parts, are left out).
var nameInUse = map[string]bool{"hovednavn": true, "sidenavn": true, "undernavn": true}
var spellingInUse = map[string]bool{"godkjent": true, "vedtatt": true, "internasjonal": true, "privat": true, "uvurdert": true}

// Label is a kind's display name, e.g. "Bydel" for bydel.
func Label(code string) string {
	if l, ok := kindLabels[code]; ok {
		return l
	}
	return code
}

// Parse reads Kartverket's place-name GML (StedsnavnForVanligBruk, EPSG:4258)
// and calls fn for each name in use, once per place, name and spelling.
func Parse(r io.Reader, fn func(Record) error) (ParseStats, error) {
	var st ParseStats
	d := xml.NewDecoder(r)
	for {
		tok, err := d.Token()
		if errors.Is(err, io.EOF) {
			return st, nil
		}
		if err != nil {
			return st, fmt.Errorf("places: %w", err)
		}
		se, ok := tok.(xml.StartElement)
		if !ok || se.Name.Local != "Sted" {
			continue
		}
		var s sted
		if err := d.DecodeElement(&s, &se); err != nil {
			return st, fmt.Errorf("places: %w", err)
		}
		st.Places++
		lat, lon, ok := s.point()
		if !ok {
			st.NoPoint++
			continue
		}
		base := Record{Place: Place{Kind: Label(s.Kind), Lat: lat, Lon: lon}, ID: s.Number, Code: s.Kind, Importance: importance(s.Sort)}
		if len(s.Kommune) > 0 {
			base.Municipality, base.County = s.Kommune[0].Name, s.Kommune[0].County
		}
		seen := map[string]bool{}
		for _, n := range s.Names {
			if !n.Public || !nameInUse[n.Status] {
				st.NotInUse++
				continue
			}
			for _, sp := range n.Spelling {
				name := strings.Join(strings.Fields(sp.Text), " ")
				if !spellingInUse[sp.Status] || name == "" || seen[name] {
					continue
				}
				seen[name] = true
				rec := base
				rec.Name, rec.Alt = name, len(seen) > 1
				st.Names++
				if err := fn(rec); err != nil {
					return st, err
				}
			}
		}
	}
}

// importance is the letter of viktighetA..viktighetN as 0..13, or -1.
func importance(s string) int {
	if v, ok := strings.CutPrefix(s, "viktighet"); ok && len(v) == 1 && v[0] >= 'A' && v[0] <= 'Z' {
		return int(v[0] - 'A')
	}
	return -1
}
