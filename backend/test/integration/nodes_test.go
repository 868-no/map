//go:build integration

package integration

import (
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"google.golang.org/protobuf/proto"

	"github.com/868-no/map/internal/api"
	"github.com/868-no/map/internal/protocol/pb"
)

// D-212: /nodes lists the nodes that reported a position in the window,
// each with its newest position and name from the window's rows alone,
// leaving out what a node did not allow onto MQTT.
func TestNodesEndpoint(t *testing.T) {
	pool := freshDB(t)
	f := newFixture(t, pool)
	nodeC := uint32(0x0d00000d)
	T1, T2, T3 := base.Add(1*time.Hour), base.Add(5*time.Hour), base.Add(9*time.Hour)
	f.nodeInfo(T1, nodeA, gw1, "Alpha")
	f.position(T1, nodeA, gw1, 62.0)
	f.position(T2, nodeA, gw1, 63.0)
	f.position(T3, nodeA, gw1, 64.0) // after the window below
	// nodeB did not allow MQTT uplink: left out.
	notOK := uint32(0)
	la, lo := int32(63.5e7), int32(10.4e7)
	b, _ := proto.Marshal(&pb.Position{LatitudeI: &la, LongitudeI: &lo, PrecisionBits: 32})
	f.store(T1, nodeB, gw1, &pb.Data{Portnum: pb.PortNum_POSITION_APP, Payload: b, Bitfield: &notOK}, nil)
	// nodeC is named but never reported a position: left out.
	f.nodeInfo(T1, nodeC, gw1, "Charlie")
	c := newAPI(t, pool, nil, testNow)

	var body api.NodesBody
	if code := c.get("/api/v1/nodes", win(base, base.Add(6*time.Hour)), &body); code != 200 {
		t.Fatalf("HTTP %d", code)
	}
	if len(body.Nodes) != 1 {
		t.Fatalf("nodes: %+v", body.Nodes)
	}
	n := body.Nodes[0]
	if n.ID != "!0a00000a" || n.Position.Lat != 63.0 || n.Position.Source != "position" || n.Position.Signature != "unsigned" || !n.Position.ObservedAt.Equal(T2) {
		t.Fatalf("position: %+v", n.Position)
	}
	if n.Identity == nil || n.Identity.LongName != "Alpha" || n.Identity.Source != "nodeinfo" {
		t.Fatalf("identity: %+v", n.Identity)
	}
	if !body.Window.Start.Equal(base) || body.Window.Rolling {
		t.Fatalf("window: %+v", body.Window)
	}

	// The whole day: the newest position wins.
	if c.get("/api/v1/nodes", win(base, base.Add(12*time.Hour)), &body); len(body.Nodes) != 1 || body.Nodes[0].Position.Lat != 64.0 {
		t.Fatalf("newest position: %+v", body.Nodes)
	}

	// GeoJSON.
	q := win(base, base.Add(6*time.Hour))
	q.Set("format", "geojson")
	resp, err := http.Get(c.srv.URL + "/api/v1/nodes?" + q.Encode())
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var fc api.NodesGeoJSON
	if err := json.NewDecoder(resp.Body).Decode(&fc); err != nil {
		t.Fatal(err)
	}
	if ct := resp.Header.Get("Content-Type"); ct != "application/geo+json" {
		t.Fatalf("content type %q", ct)
	}
	if fc.Type != "FeatureCollection" || len(fc.Features) != 1 || fc.Features[0].Geometry.Coordinates != [2]float64{10.4, 63.0} {
		t.Fatalf("geojson: %+v", fc)
	}

	// Window validation is the same as /observations'.
	if c.get("/api/v1/nodes", win(base.Add(-30*24*time.Hour*7), base), nil) != 400 {
		t.Fatal("expected 400 for a window beyond the maximum")
	}
	q.Set("format", "xml")
	if code := c.get("/api/v1/nodes", q, nil); code != 422 {
		t.Fatalf("unknown format: HTTP %d", code)
	}
}
