package query

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// Every window-scoped query must filter observed_at through
// window.Predicate. This scans the source tree for hand-written observed_at
// comparisons; the allowlist holds the ingestion-side and retention lookups
// that are deliberately not window-scoped.
func TestObservedAtOnlyViaPredicate(t *testing.T) {
	allowed := map[string]string{
		"internal/window/window.go":           "defines Predicate",
		"internal/storage/storage.go":         "ingest dedupe fallback (recent observation lookup)",
		"internal/maintenance/maintenance.go": "retention delete (observed_at < cutoff)",
		"internal/storage/redecode.go":        "row identity (id, observed_at) so updates reach one partition, not a window",
	}
	cmp := regexp.MustCompile(`observed_at\s*(>=|<=|<|>|=|BETWEEN)`)
	root := "../.."
	err := filepath.Walk(filepath.Join(root, "internal"), func(path string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() || !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return err
		}
		rel, _ := filepath.Rel(root, path)
		b, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		if loc := cmp.FindIndex(b); loc != nil {
			if _, ok := allowed[filepath.ToSlash(rel)]; !ok {
				t.Errorf("%s: observed_at compared outside window.Predicate: %q", rel, b[loc[0]:min(loc[1]+20, len(b))])
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}
