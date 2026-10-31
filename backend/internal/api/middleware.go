package api

import (
	"context"
	"net"
	"net/http"
	"net/netip"
	"strings"
	"sync"
	"time"

	"golang.org/x/time/rate"
)

// ClientIP resolves the client address: X-Forwarded-For is walked right to
// left skipping trusted proxies, and is ignored entirely when the direct
// peer is not a trusted proxy.
func ClientIP(r *http.Request, trusted []netip.Prefix) netip.Addr {
	peer := parseAddr(r.RemoteAddr)
	if !isTrusted(peer, trusted) {
		return peer
	}
	hops := strings.Split(r.Header.Get("X-Forwarded-For"), ",")
	for i := len(hops) - 1; i >= 0; i-- {
		a, err := netip.ParseAddr(strings.TrimSpace(hops[i]))
		if err != nil {
			break
		}
		a = a.Unmap()
		if !isTrusted(a, trusted) {
			return a
		}
		peer = a
	}
	return peer
}

func parseAddr(hostport string) netip.Addr {
	host, _, err := net.SplitHostPort(hostport)
	if err != nil {
		host = hostport
	}
	a, err := netip.ParseAddr(host)
	if err != nil {
		return netip.Addr{}
	}
	return a.Unmap()
}

func isTrusted(a netip.Addr, trusted []netip.Prefix) bool {
	if !a.IsValid() {
		return false
	}
	for _, p := range trusted {
		if p.Contains(a) {
			return true
		}
	}
	return false
}

// Limits configures request protection.
type Limits struct {
	Trusted    []netip.Prefix
	PerSecond  float64       // sustained requests per client
	Burst      int           // burst per client
	Timeout    time.Duration // non-streaming request deadline
	MaxStreams int           // concurrent SSE streams per client
}

type clientState struct {
	lim     *rate.Limiter
	streams int
	seen    time.Time
}

// Protect wraps /api with per-client rate limits, stream caps and deadlines.
func Protect(next http.Handler, l Limits) http.Handler {
	var mu sync.Mutex
	clients := map[netip.Addr]*clientState{}
	go func() {
		for range time.Tick(time.Minute) {
			mu.Lock()
			for k, c := range clients {
				if c.streams == 0 && time.Since(c.seen) > 10*time.Minute {
					delete(clients, k)
				}
			}
			mu.Unlock()
		}
	}()
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.URL.Path, "/api/") {
			next.ServeHTTP(w, r)
			return
		}
		ip := ClientIP(r, l.Trusted)
		mu.Lock()
		c := clients[ip]
		if c == nil {
			c = &clientState{lim: rate.NewLimiter(rate.Limit(l.PerSecond), l.Burst)}
			clients[ip] = c
		}
		c.seen = time.Now()
		allowed := c.lim.Allow()
		stream := r.URL.Path == "/api/v1/stream"
		if stream && allowed {
			if c.streams >= l.MaxStreams {
				allowed = false
			} else {
				c.streams++
			}
		}
		mu.Unlock()
		if !allowed {
			w.Header().Set("Retry-After", "2")
			http.Error(w, `{"title":"Too Many Requests","status":429}`, http.StatusTooManyRequests)
			return
		}
		if stream {
			defer func() { mu.Lock(); c.streams--; mu.Unlock() }()
			next.ServeHTTP(w, r)
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), l.Timeout)
		defer cancel()
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}
