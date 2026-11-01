package security

import "testing"

func TestDefaultKeyFallback(t *testing.T) {
	kr, err := NewKeyring([]ChannelConfig{{Name: "NarrowFast", PSKs: []string{"AQ=="}}, {Name: "Private", PSKs: []string{"hex:00112233445566778899aabbccddeeff"}}})
	if err != nil {
		t.Fatal(err)
	}
	custom := ChannelHash("Custom", DefaultPSK[:], ModeCTR)
	if n := len(kr.Candidates("b", "Custom", custom, 4)); n != 0 {
		t.Fatalf("fallback off: %d candidates", n)
	}
	kr.DefaultFallback = true
	c := kr.Candidates("b", "Custom", custom, 4)
	if len(c) != 1 || c[0].Channel != "Custom" || c[0].Label != "Custom#default" || c[0].Mode != ModeCTR {
		t.Fatalf("candidates %v", c)
	}
	if n := len(kr.Candidates("b", "Custom", custom^0x55, 4)); n != 0 {
		t.Fatal("a hash that does not match the default key gets no fallback")
	}
	// A configured channel never falls back, even with a matching hash.
	if c := kr.Candidates("b", "Private", ChannelHash("Private", DefaultPSK[:], ModeCTR), 4); len(c) != 0 {
		t.Fatalf("configured channel fell back: %v", c)
	}
	if n := len(kr.Candidates("b", "PKI", ChannelHash("PKI", DefaultPSK[:], ModeCTR), 4)); n != 0 {
		t.Fatal("PKI never falls back")
	}
}
