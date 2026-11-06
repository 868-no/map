package api

import (
	"net/http"
	"os"
	"testing"

	"github.com/868-no/map/internal/config"
)

// The committed OpenAPI document must match what the serving code
// generates. Regenerate: scripts/go.sh go run ./cmd/meshmap openapi > ../docs/api-openapi.yaml
func TestOpenAPIUpToDate(t *testing.T) {
	want, err := os.ReadFile("../../../docs/api-openapi.yaml")
	if err != nil {
		t.Skip("docs/api-openapi.yaml not present")
	}
	e := config.Env{}
	s := &Server{Env: e}
	got, err := s.NewHandler(http.NewServeMux()).OpenAPI().YAML()
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(want) {
		t.Fatal("docs/api-openapi.yaml is stale; regenerate with `meshmap openapi`")
	}
}

func TestClientIP(t *testing.T) {
	cases := []struct {
		peer, xff, want string
	}{
		{"203.0.113.9:1234", "1.2.3.4", "203.0.113.9"},                         // untrusted peer: header ignored
		{"172.18.0.5:1234", "198.51.100.7", "198.51.100.7"},                    // via trusted proxy
		{"172.18.0.5:1234", "6.6.6.6, 198.51.100.7, 10.0.0.2", "198.51.100.7"}, // spoofed leftmost ignored
		{"172.18.0.5:1234", "", "172.18.0.5"},
	}
	trusted := mustPrefixes("10.0.0.0/8", "172.16.0.0/12")
	for _, c := range cases {
		r, _ := http.NewRequest(http.MethodGet, "/api/v1/snapshot", nil)
		r.RemoteAddr = c.peer
		if c.xff != "" {
			r.Header.Set("X-Forwarded-For", c.xff)
		}
		if got := ClientIP(r, trusted).String(); got != c.want {
			t.Errorf("peer %s xff %q: got %s want %s", c.peer, c.xff, got, c.want)
		}
	}
}
