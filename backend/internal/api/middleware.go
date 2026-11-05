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
	Trusted         []netip.Prefix
	PerSecond       float64       // sustained requests per client
	Burst           int           // burst per client
	Timeout         time.Duration // non-streaming request deadline
	MaxStreams      int           // concurrent SSE streams per client
	MaxStreamsTotal int           // concurrent SSE streams across all clients
	HeavyPerClient  int           // concurrent /observations reads per client
}

type clientState struct {
	lim     *rate.Limiter
	heavy   chan struct{} // per-client share of the heavy-read slots
	streams int
	seen    time.Time
}

// ClientKey is what limits count per client: the address, or for IPv6 its
// /64, since one subscriber line usually holds a whole /64.
func ClientKey(a netip.Addr) netip.Prefix {
	if a.Is6() {
		p, _ := a.Prefix(64)
		return p
	}
	return netip.PrefixFrom(a, a.BitLen())
}

type clientCtxKey struct{}

// clientOf is the client key Protect found for the request, as text; empty
// without Protect.
func clientOf(ctx context.Context) string {
	if k, ok := ctx.Value(clientCtxKey{}).(netip.Prefix); ok {
		return k.String()
	}
	return ""
}

// heavyPath is the endpoint whose reads hold a database connection while
// they stream; each client may run only HeavyPerClient at once, so one
// client cannot take every slot of Server.acquire. Whole days (D-158) count
// too: most come from a cache, but a client asking for many uncached days
// at once would otherwise hold every slot building them.
const heavyPath = "/api/v1/observations"

func heavy(path string) bool {
	return path == heavyPath || strings.HasPrefix(path, heavyPath+"/day/")
}

// heavyWait is how long a read queues behind the same client's others.
var heavyWait = 5 * time.Second

// Protect wraps /api with per-client rate limits, concurrency and stream
// caps, and deadlines.
func Protect(next http.Handler, l Limits) http.Handler {
	var mu sync.Mutex
	clients := map[netip.Prefix]*clientState{}
	streams := 0
	// Clients idle for 10 minutes are forgotten, looked for at most once a
	// minute by a request (no goroutine outliving the handler).
	var pruned time.Time
	prune := func(now time.Time) {
		if now.Sub(pruned) < time.Minute {
			return
		}
		pruned = now
		for k, c := range clients {
			if c.streams == 0 && len(c.heavy) == 0 && now.Sub(c.seen) > 10*time.Minute {
				delete(clients, k)
			}
		}
	}
	tooMany := func(w http.ResponseWriter) {
		w.Header().Set("Retry-After", "2")
		http.Error(w, `{"title":"Too Many Requests","status":429}`, http.StatusTooManyRequests)
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.URL.Path, "/api/") {
			next.ServeHTTP(w, r)
			return
		}
		key := ClientKey(ClientIP(r, l.Trusted))
		now := time.Now()
		mu.Lock()
		prune(now)
		c := clients[key]
		if c == nil {
			c = &clientState{lim: rate.NewLimiter(rate.Limit(l.PerSecond), l.Burst), heavy: make(chan struct{}, max(l.HeavyPerClient, 1))}
			clients[key] = c
		}
		c.seen = now
		allowed := c.lim.Allow()
		stream := r.URL.Path == streamPath
		if stream && allowed {
			if c.streams >= l.MaxStreams || (l.MaxStreamsTotal > 0 && streams >= l.MaxStreamsTotal) {
				allowed = false
			} else {
				c.streams++
				streams++
			}
		}
		mu.Unlock()
		if !allowed {
			tooMany(w)
			return
		}
		if stream {
			defer func() { mu.Lock(); c.streams--; streams--; mu.Unlock() }()
			next.ServeHTTP(w, r)
			return
		}
		ctx, cancel := context.WithTimeout(context.WithValue(r.Context(), clientCtxKey{}, key), l.Timeout)
		defer cancel()
		if heavy(r.URL.Path) {
			// Queue behind this client's own reads (the browser runs a few
			// in parallel), but not for long.
			t := time.NewTimer(heavyWait)
			select {
			case c.heavy <- struct{}{}:
				t.Stop()
				defer func() { <-c.heavy }()
			case <-t.C:
				tooMany(w)
				return
			case <-ctx.Done():
				t.Stop()
				return
			}
		}
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}
