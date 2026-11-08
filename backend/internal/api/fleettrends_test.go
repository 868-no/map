package api

import (
	"fmt"
	"slices"
	"testing"

	"github.com/868-no/map/internal/storage"
)

func names(d FleetDimension) []string {
	var out []string
	for _, v := range d.Values {
		out = append(out, v.Name)
	}
	return out
}

// D-198: each dimension keeps its largest values over the whole range, sums
// the rest as others and puts unknown last; firmware keeps its reported lines
// newest first, then the inferred generations.
func TestFoldDimension(t *testing.T) {
	counts := []map[string]int{{"unknown": 4}, {"unknown": 1}}
	for i := range 10 {
		counts[0][fmt.Sprintf("HW_%02d", i)] = 20 - i
	}
	counts[1]["HW_09"] = 30 // the largest over both buckets
	d, c := foldDimension(counts, false)
	want := []string{"HW_09", "HW_00", "HW_01", "HW_02", "HW_03", "HW_04", "HW_05", "HW_06", "others", "unknown"}
	if !slices.Equal(names(d), want) || d.Values[8].Kind != "others" || d.Values[8].Folded != 2 || d.Values[9].Kind != "unknown" {
		t.Fatalf("values: %+v", d.Values)
	}
	if !slices.Equal(c[0], []int{11, 20, 19, 18, 17, 16, 15, 14, 13 + 12, 4}) || !slices.Equal(c[1], []int{30, 0, 0, 0, 0, 0, 0, 0, 0, 1}) {
		t.Fatalf("counts: %v", c)
	}
	// One value too many: kept rather than "1 others".
	nine := map[string]int{}
	for i := range 9 {
		nine[fmt.Sprintf("R%d", i)] = 1
	}
	if d, _ := foldDimension([]map[string]int{nine}, false); len(d.Values) != 9 || slices.Contains(names(d), "others") {
		t.Fatalf("nine: %v", names(d))
	}

	fw := []map[string]int{{"2.7": 5, "2.10": 1, "2.6": 3, "2.5": 1, "2.4": 1, "2.3": 1, "2.2": 1, storage.FirmwareNoHopStart: 2, storage.FirmwareKey: 7, storage.Unknown: 9}}
	d, c = foldDimension(fw, true)
	if want := []string{"2.10", "2.7", "2.6", "2.5", "2.4", "others", "key", "no_hop_start", "unknown"}; !slices.Equal(names(d), want) {
		t.Fatalf("firmware: %v", names(d))
	}
	if d.Values[1].Basis != "reported" || d.Values[6].Basis != "key" || d.Values[5].Basis != "" || !slices.Equal(c[0], []int{1, 5, 3, 1, 1, 2, 7, 2, 9}) {
		t.Fatalf("firmware: %+v %v", d.Values, c)
	}

	if d, c := foldDimension(nil, false); d.Values == nil || len(d.Values) != 0 || len(c) != 0 {
		t.Fatalf("empty: %+v %v", d, c)
	}
}
