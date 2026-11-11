package api

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/868-no/map/internal/query"
)

// D-212: the newer of a node's Position packet and map report gives its
// position; its NodeInfo, or else a map report naming it, its identity;
// nodes without a position are left out.
func TestNodeEntries(t *testing.T) {
	at := time.Date(2026, 11, 1, 12, 0, 0, 0, time.UTC)
	row := func(node uint32, ty, sig string, ago time.Duration, meta string) query.NodeRow {
		return query.NodeRow{Node: node, Type: ty, Sig: sig, At: at.Add(-ago), Meta: []byte(meta)}
	}
	rows := []query.NodeRow{
		// 1: NodeInfo, an older position packet and a newer map report.
		row(1, "mapreport", "not-applicable", time.Hour, `{"position":{"lat":60.5,"lon":10.5,"precision_bits":16,"precision_known":true},"mapreport":{"long_name":"Report","short_name":"RP"}}`),
		row(1, "nodeinfo", "verified", 5*time.Hour, `{"nodeinfo":{"long_name":"Alpha","short_name":"AL","hw_model":"HELTEC_V3","role":"ROUTER"}}`),
		row(1, "position", "verified", 2*time.Hour, `{"position":{"lat":60,"lon":10,"alt":120,"precision_bits":32,"precision_known":true}}`),
		// 2: a position and no NodeInfo, but a named map report older than the position.
		row(2, "mapreport", "not-applicable", 3*time.Hour, `{"position":{"lat":59,"lon":11,"precision_bits":13,"precision_known":true},"mapreport":{"long_name":"Bravo"}}`),
		row(2, "position", "unsigned", time.Hour, `{"position":{"lat":59.1,"lon":11.1,"precision_bits":32,"precision_known":false}}`),
		// 3: named, but no position.
		row(3, "nodeinfo", "unsigned", time.Hour, `{"nodeinfo":{"long_name":"Charlie"}}`),
		// 4: a position only.
		row(4, "position", "unsigned", time.Hour, `{"position":{"lat":58,"lon":9,"precision_bits":32,"precision_known":true}}`),
	}
	got := nodeEntries(rows)
	if len(got) != 3 || got[0].Num != 1 || got[1].Num != 2 || got[2].Num != 4 {
		t.Fatalf("nodes: %+v", got)
	}
	a := got[0]
	if a.ID != "!00000001" || a.Position.Source != "mapreport" || a.Position.Lat != 60.5 || a.Position.PrecisionBits != 16 || !a.Position.ObservedAt.Equal(at.Add(-time.Hour)) {
		t.Fatalf("1: newest position should be the map report: %+v", a.Position)
	}
	if a.Identity == nil || a.Identity.Source != "nodeinfo" || a.Identity.LongName != "Alpha" || a.Identity.Role != "ROUTER" || a.Identity.Signature != "verified" {
		t.Fatalf("1: identity should be the NodeInfo: %+v", a.Identity)
	}
	b := got[1]
	if b.Position.Source != "position" || b.Position.Lat != 59.1 || b.Position.Signature != "unsigned" || b.Position.PrecisionKnown {
		t.Fatalf("2: position: %+v", b.Position)
	}
	if b.Identity == nil || b.Identity.Source != "mapreport" || b.Identity.LongName != "Bravo" {
		t.Fatalf("2: identity from the map report: %+v", b.Identity)
	}
	if got[2].Identity != nil {
		t.Fatalf("4: no identity expected: %+v", got[2].Identity)
	}
	if e := nodeEntries(nil); e == nil || len(e) != 0 {
		t.Fatal("no rows: an empty list, not null")
	}

	// GeoJSON: [lon, lat] points with the entry as properties.
	fc := nodesGeoJSON(WindowEcho{}, got)
	b2, err := json.Marshal(fc)
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		Type     string
		Features []struct {
			Type     string
			ID       string
			Geometry struct {
				Type        string
				Coordinates []float64
			}
			Properties map[string]any
		}
	}
	if err := json.Unmarshal(b2, &doc); err != nil {
		t.Fatal(err)
	}
	f := doc.Features[0]
	if doc.Type != "FeatureCollection" || len(doc.Features) != 3 || f.Type != "Feature" || f.ID != "!00000001" || f.Geometry.Type != "Point" ||
		len(f.Geometry.Coordinates) != 2 || f.Geometry.Coordinates[0] != 10.5 || f.Geometry.Coordinates[1] != 60.5 || f.Properties["id"] != "!00000001" {
		t.Fatalf("geojson: %s", b2)
	}
}
