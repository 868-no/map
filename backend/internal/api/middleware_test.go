package api

import (
	"net/http"
	"net/http/httptest"
	"net/netip"
	"sync"
	"testing"
	"time"
)

func TestClientKeyGroupsIPv6By64(t *testing.T) {
	a, b := netip.MustParseAddr("2001:db8:1:2::1"), netip.MustParseAddr("2001:db8:1:2:ffff::9")
	if ClientKey(a) != ClientKey(b) {
		t.Fatal("addresses in one /64 must count as one client")
	}
	if ClientKey(a) == ClientKey(netip.MustParseAddr("2001:db8:1:3::1")) {
		t.Fatal("different /64s are different clients")
	}
	if ClientKey(netip.MustParseAddr("192.0.2.1")) == ClientKey(netip.MustParseAddr("192.0.2.2")) {
		t.Fatal("IPv4 clients are single addresses")
	}
}

// One client cannot hold more than HeavyPerClient reads; its extra reads
// queue, then give up with 429, while another client is unaffected.
func TestPerClientReadCap(t *testing.T) {
	old := heavyWait
	heavyWait = 100 * time.Millisecond
	defer func() { heavyWait = old }()
	release := make(chan struct{})
	var mu sync.Mutex
	running := 0
	h := Protect(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		running++
		mu.Unlock()
		<-release
	}), Limits{PerSecond: 100, Burst: 100, Timeout: time.Minute, MaxStreams: 1, HeavyPerClient: 2})
	get := func(ip string) chan int {
		ch := make(chan int, 1)
		go func() {
			r := httptest.NewRequest(http.MethodGet, heavyPath, nil)
			r.RemoteAddr = ip + ":1234"
			w := httptest.NewRecorder()
			h.ServeHTTP(w, r)
			ch <- w.Code
		}()
		return ch
	}
	a1, a2 := get("192.0.2.1"), get("192.0.2.1")
	time.Sleep(30 * time.Millisecond)
	a3 := get("192.0.2.1")
	if code := <-a3; code != http.StatusTooManyRequests {
		t.Fatalf("third read of one client: %d, want 429", code)
	}
	b := get("192.0.2.2")
	time.Sleep(30 * time.Millisecond)
	mu.Lock()
	if running != 3 {
		t.Fatalf("%d reads running, want 3 (two of a, one of b)", running)
	}
	mu.Unlock()
	close(release)
	for _, ch := range []chan int{a1, a2, b} {
		if code := <-ch; code != http.StatusOK {
			t.Fatalf("read: %d", code)
		}
	}
}

func TestTotalStreamCap(t *testing.T) {
	release := make(chan struct{})
	h := Protect(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { <-release }),
		Limits{PerSecond: 100, Burst: 100, Timeout: time.Minute, MaxStreams: 1, MaxStreamsTotal: 2, HeavyPerClient: 1})
	open := func(ip string) chan int {
		ch := make(chan int, 1)
		go func() {
			r := httptest.NewRequest(http.MethodGet, "/api/v1/stream", nil)
			r.RemoteAddr = ip + ":1"
			w := httptest.NewRecorder()
			h.ServeHTTP(w, r)
			ch <- w.Code
		}()
		return ch
	}
	s1, s2 := open("192.0.2.1"), open("192.0.2.2")
	time.Sleep(30 * time.Millisecond)
	if code := <-open("192.0.2.3"); code != http.StatusTooManyRequests {
		t.Fatalf("third stream overall: %d, want 429", code)
	}
	close(release)
	<-s1
	<-s2
}
