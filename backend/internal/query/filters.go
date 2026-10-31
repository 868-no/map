// Package query derives every mesh view from packet_log rows inside one
// window. All SQL is built from where(), which always starts with
// window.Predicate, so no query can read outside [Start, End).
package query

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"slices"
	"strings"

	"github.com/868-no/map/internal/window"
)

// Filters narrow which observations contribute to a view. Empty means all.
type Filters struct {
	Channels []string `json:"channels,omitempty"`
	Brokers  []string `json:"brokers,omitempty"`
	Gateways []uint32 `json:"gateways,omitempty"`
	Types    []string `json:"types,omitempty"`
}

// Hash is a stable digest used in cache keys and cursors.
func (f Filters) Hash() string {
	c := f
	c.Channels = sortedCopy(f.Channels)
	c.Brokers = sortedCopy(f.Brokers)
	c.Types = sortedCopy(f.Types)
	c.Gateways = slices.Clone(f.Gateways)
	slices.Sort(c.Gateways)
	h := sha256.Sum256([]byte(fmt.Sprintf("%q|%q|%v|%q", c.Channels, c.Brokers, c.Gateways, c.Types)))
	return hex.EncodeToString(h[:8])
}

func sortedCopy(s []string) []string {
	c := slices.Clone(s)
	slices.Sort(c)
	return c
}

// sqlb accumulates a WHERE clause and its positional arguments.
type sqlb struct {
	conds []string
	args  []any
}

// where starts a clause with the window predicate (always $1, $2).
func where(w window.Window) *sqlb {
	s, e := w.Args()
	return &sqlb{conds: []string{window.Predicate(1, 2)}, args: []any{s, e}}
}

func (b *sqlb) arg(v any) string {
	b.args = append(b.args, v)
	return fmt.Sprintf("$%d", len(b.args))
}

func (b *sqlb) and(cond string, vals ...any) *sqlb {
	for _, v := range vals {
		cond = strings.Replace(cond, "?", b.arg(v), 1)
	}
	b.conds = append(b.conds, cond)
	return b
}

func (b *sqlb) filters(f Filters) *sqlb {
	if len(f.Channels) > 0 {
		b.and("channel_name = ANY(?)", f.Channels)
	}
	if len(f.Brokers) > 0 {
		b.and("broker_id = ANY(?)", f.Brokers)
	}
	if len(f.Gateways) > 0 {
		gws := make([]int64, len(f.Gateways))
		for i, g := range f.Gateways {
			gws[i] = int64(g)
		}
		b.and("gateway_node_id = ANY(?)", gws)
	}
	if len(f.Types) > 0 {
		b.and("packet_type = ANY(?)", f.Types)
	}
	return b
}

func (b *sqlb) String() string { return strings.Join(b.conds, " AND ") }
