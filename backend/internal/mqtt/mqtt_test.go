package mqtt

import (
	"errors"
	"go/ast"
	"go/parser"
	"go/token"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/868-no/map/internal/config"
	"github.com/868-no/map/internal/observability"
)

func testBase() *base {
	b := &base{cfg: config.Broker{ID: "t"}, m: observability.NewMetrics(), log: slog.New(slog.NewTextHandler(io.Discard, nil))}
	b.setState(StateConnecting)
	return b
}

// A broker is up only once every filter is granted (readiness depends on it).
func TestSubscribedNeedsEveryFilterGranted(t *testing.T) {
	cases := []struct {
		name  string
		err   error
		codes []byte
		want  int
		state ConnState
	}{
		{"granted", nil, []byte{0, 1}, 2, StateUp},
		{"refused", nil, []byte{0, 0x87}, 2, StateDown},
		{"v3 failure code", nil, []byte{0x80}, 1, StateDown},
		{"missing codes", nil, []byte{0}, 2, StateDown},
		{"error", errors.New("boom"), nil, 1, StateDown},
		{"timeout", errSubscribeTimeout, nil, 1, StateDown},
	}
	for _, c := range cases {
		b := testBase()
		b.subscribed(c.err, c.codes, c.want)
		if got := b.State(); got != c.state {
			t.Errorf("%s: state %v, want %v", c.name, got, c.state)
		}
	}
}

// The subscription is read-only (never publish to the configured brokers):
// no code in this package may call a Publish method.
func TestPackageNeverPublishes(t *testing.T) {
	files, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatal(err)
	}
	fs := token.NewFileSet()
	for _, f := range files {
		if strings.HasSuffix(f, "_test.go") {
			continue
		}
		src, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		file, err := parser.ParseFile(fs, f, src, 0)
		if err != nil {
			t.Fatal(err)
		}
		ast.Inspect(file, func(n ast.Node) bool {
			// Publish, PublishWithContext, ... (types like paho.PublishReceived are fine).
			if call, ok := n.(*ast.CallExpr); ok {
				if sel, ok := call.Fun.(*ast.SelectorExpr); ok && strings.HasPrefix(sel.Sel.Name, "Publish") {
					t.Errorf("%s calls %s; the MQTT client must never publish", fs.Position(sel.Pos()), sel.Sel.Name)
				}
			}
			return true
		})
	}
}
