package protocol

import "strings"

// Presets are Meshtastic's modem presets by their default channel names
// (the name a channel gets when left unnamed), plus long-form spellings seen
// in use: the engine's radio::PRESETS, which a test keeps this equal to, so
// the server's fleet trends (D-198) and the browser's breakdown (D-196)
// read channel names alike.
var Presets = [][2]string{
	{"LongFast", "LONG_FAST"},
	{"LongSlow", "LONG_SLOW"},
	{"VLongSlow", "VERY_LONG_SLOW"},
	{"VeryLongSlow", "VERY_LONG_SLOW"},
	{"MediumSlow", "MEDIUM_SLOW"},
	{"MediumFast", "MEDIUM_FAST"},
	{"MediumTurbo", "MEDIUM_TURBO"},
	{"ShortSlow", "SHORT_SLOW"},
	{"ShortFast", "SHORT_FAST"},
	{"ShortTurbo", "SHORT_TURBO"},
	{"LongMod", "LONG_MODERATE"},
	{"LongModerate", "LONG_MODERATE"},
	{"LongTurbo", "LONG_TURBO"},
	{"LiteFast", "LITE_FAST"},
	{"LiteSlow", "LITE_SLOW"},
	{"NarrowFast", "NARROW_FAST"},
	{"NarrowSlow", "NARROW_SLOW"},
	{"TinyFast", "TINY_FAST"},
	{"TinySlow", "TINY_SLOW"},
}

// PresetOf is the preset a channel name stands for, if it is a preset's
// default name (case-insensitive); "" for a custom name, which says nothing
// about the preset.
func PresetOf(channel string) string {
	for _, p := range Presets {
		if strings.EqualFold(p[0], channel) {
			return p[1]
		}
	}
	return ""
}
