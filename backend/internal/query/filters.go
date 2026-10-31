// Package query reads window-scoped observations. All SQL is built from
// where(), which always starts with window.Predicate, so no query can read
// outside [Start, End). Views are derived in the browser (D-031, D-041).
package query

import (
	"fmt"
	"strings"

	"github.com/868-no/map/internal/window"
)

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

func (b *sqlb) String() string { return strings.Join(b.conds, " AND ") }
