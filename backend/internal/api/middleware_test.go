package api

import (
	"encoding/json"
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

// Handlers see the client Protect counted the request against (the weather
// queue serves clients in turn by it, D-141).
func TestProtectNamesTheClient(t *testing.T) {
	var got string
	h := Protect(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { got = clientOf(r.Context()) }),
		Limits{PerSecond: 100, Burst: 100, Timeout: time.Minute, MaxStreams: 1, HeavyPerClient: 1})
	r := httptest.NewRequest(http.MethodGet, "/api/v1/weather", nil)
	r.RemoteAddr = "[2001:db8:1:2::7]:1234"
	h.ServeHTTP(httptest.NewRecorder(), r)
	if got != "2001:db8:1:2::/64" {
		t.Fatalf("client %q, want 2001:db8:1:2::/64", got)
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

// A read whose deadline passes while it queues behind the client's others
// is answered 503, never an empty 200.
func TestQueuedReadOutOfTimeIs503(t *testing.T) {
	release, holding := make(chan struct{}), make(chan struct{})
	defer close(release)
	h := Protect(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { close(holding); <-release }),
		Limits{PerSecond: 100, Burst: 100, Timeout: 50 * time.Millisecond, MaxStreams: 1, HeavyPerClient: 1})
	go h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, heavyPath, nil)) // holds the slot
	<-holding
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest(http.MethodGet, heavyPath, nil))
	if w.Code != http.StatusServiceUnavailable || w.Header().Get("Retry-After") == "" {
		t.Fatalf("queued past the deadline: %d %v", w.Code, w.Header())
	}
	// The backend's own 503: problem+json, which the browser does not take for a proxy's (D-156).
	var p struct {
		Status int    `json:"status"`
		Detail string `json:"detail"`
	}
	if ct := w.Header().Get("Content-Type"); ct != "application/problem+json" {
		t.Fatalf("content type %q", ct)
	}
	if err := json.Unmarshal(w.Body.Bytes(), &p); err != nil || p.Status != 503 || p.Detail == "" {
		t.Fatalf("body %q: %v", w.Body.String(), err)
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
