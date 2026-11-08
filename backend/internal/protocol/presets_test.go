package protocol

import (
	"os"
	"regexp"
	"slices"
	"testing"
)

// The server's preset names are the engine's own (frontend/engine/src/radio.rs
// PRESETS): fleet trends (D-198) and the browser's breakdown (D-196) must
// read a channel name alike.
func TestPresetsMatchTheEngine(t *testing.T) {
	src, err := os.ReadFile("../../../frontend/engine/src/radio.rs")
	if err != nil {
		t.Skip("frontend/engine/src/radio.rs not present")
	}
	table := regexp.MustCompile(`(?s)const PRESETS: &\[\(&str, &str\)\] = &\[(.*?)\];`).FindSubmatch(src)
	if table == nil {
		t.Fatal("the engine's PRESETS table not found")
	}
	var engine [][2]string
	for _, m := range regexp.MustCompile(`\("(\w+)", "(\w+)"\)`).FindAllSubmatch(table[1], -1) {
		engine = append(engine, [2]string{string(m[1]), string(m[2])})
	}
	if len(engine) == 0 || !slices.Equal(engine, Presets) {
		t.Fatalf("engine presets %v\nserver presets %v", engine, Presets)
	}
}

func TestPresetOf(t *testing.T) {
	for in, want := range map[string]string{"LongFast": "LONG_FAST", "longfast": "LONG_FAST", "VeryLongSlow": "VERY_LONG_SLOW", "Hytta": "", "": ""} {
		if got := PresetOf(in); got != want {
			t.Errorf("PresetOf(%q) = %q, want %q", in, got, want)
		}
	}
}
