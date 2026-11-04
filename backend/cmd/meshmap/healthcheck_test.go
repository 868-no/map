package main

import "testing"

func TestProbeAddr(t *testing.T) {
	for in, want := range map[string]string{
		"":              "127.0.0.1:8000",
		":9000":         "127.0.0.1:9000",
		"0.0.0.0:8080":  "127.0.0.1:8080",
		"[::]:8080":     "127.0.0.1:8080",
		"10.0.0.5:8000": "10.0.0.5:8000",
		"backend:8000":  "backend:8000",
	} {
		if got := probeAddr(in); got != want {
			t.Errorf("probeAddr(%q) = %q, want %q", in, got, want)
		}
	}
}
