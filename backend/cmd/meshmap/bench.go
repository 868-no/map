package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"runtime"
	"slices"
	"time"

	"github.com/spf13/cobra"

	"github.com/868-no/map/internal/api"
	"github.com/868-no/map/internal/cache"
	"github.com/868-no/map/internal/config"
	"github.com/868-no/map/internal/demo"
	"github.com/868-no/map/internal/geo"
	"github.com/868-no/map/internal/ingest"
	"github.com/868-no/map/internal/query"
	"github.com/868-no/map/internal/security"
	"github.com/868-no/map/internal/storage"
)

type benchIDs map[uint32]security.Identity

func (m benchIDs) Lookup(n uint32) (security.Identity, bool) { id, ok := m[n]; return id, ok }

// seedCmd fills a database with synthetic, protocol-correct observations
// spread over a time range, through the production Process + COPY path.
func seedCmd() *cobra.Command {
	var nodes, rows int
	var days float64
	var seed uint64
	cmd := &cobra.Command{
		Use:   "seed",
		Short: "Fill the database with a synthetic mesh for benchmarks (never use on production data)",
		RunE: func(cmd *cobra.Command, _ []string) error {
			e, err := config.LoadEnv()
			if err != nil {
				return err
			}
			log := slog.New(slog.NewTextHandler(io.Discard, nil))
			pool, err := openDB(cmd.Context(), e, log)
			if err != nil {
				return err
			}
			defer pool.Close()
			if err := storage.InitSchema(cmd.Context(), pool); err != nil {
				return err
			}
			scen := demo.LargeScenario(nodes, seed)
			fmt.Println("scenario:", scen.Describe())
			kr, _ := security.NewKeyring(demo.Channels())
			ids := benchIDs{}
			o := ingest.Options{Keyring: kr, Identities: ids, KeyBudget: 4}
			sim := demo.NewSimulator(scen, seed)
			end := time.Now().UTC()
			start := end.Add(-time.Duration(days * float64(24*time.Hour)))
			step := time.Duration(float64(end.Sub(start)) / float64(rows))
			t := start
			batch := make([]*ingest.Observation, 0, 2000)
			stored, rejected := 0, 0
			began := time.Now()
			flush := func() error {
				if len(batch) == 0 {
					return nil
				}
				if _, err := storage.InsertBatch(cmd.Context(), pool, batch); err != nil {
					return err
				}
				stored += len(batch)
				batch = batch[:0]
				return nil
			}
			seen := map[[16]byte]bool{}
			for stored+len(batch) < rows {
				for _, m := range sim.Step() {
					t = t.Add(step)
					obs, err := ingest.Process(ingest.RawMessage{BrokerID: "bench", Topic: m.Topic, Payload: m.Payload, ObservedAt: t}, o)
					if err != nil {
						rejected++
						continue
					}
					if seen[obs.ObservationKey] {
						continue
					}
					seen[obs.ObservationKey] = true
					if obs.Promote != nil {
						ids[obs.Promote.Node] = *obs.Promote
					}
					batch = append(batch, &obs)
					if len(batch) == cap(batch) {
						if err := flush(); err != nil {
							return err
						}
						if len(seen) > 2_000_000 {
							seen = map[[16]byte]bool{}
						}
						if stored%200_000 < cap(batch) {
							fmt.Printf("  %d rows (%.0f rows/s)\n", stored, float64(stored)/time.Since(began).Seconds())
						}
					}
				}
			}
			if err := flush(); err != nil {
				return err
			}
			if _, err := pool.Exec(cmd.Context(), `ANALYZE packet_log`); err != nil {
				return err
			}
			fmt.Printf("seeded %d rows (%d rejected test inputs) over %.1f days in %s (%.0f rows/s)\n", stored, rejected, days, time.Since(began).Round(time.Second), float64(stored)/time.Since(began).Seconds())
			return nil
		},
	}
	cmd.Flags().IntVar(&nodes, "nodes", 2000, "synthetic node count")
	cmd.Flags().IntVar(&rows, "rows", 2_000_000, "rows to insert")
	cmd.Flags().Float64Var(&days, "days", 30, "spread observations over this many days ending now")
	cmd.Flags().Uint64Var(&seed, "seed", 42, "deterministic seed")
	return cmd
}

// benchCmd measures API latency for the snapshot, traffic and edges
// endpoints, cold (no cache, distinct windows) and warm (cache hits).
func benchCmd() *cobra.Command {
	var n int
	var hours int
	cmd := &cobra.Command{
		Use:   "bench",
		Short: "Measure API latency on the current database (cold and warm cache)",
		RunE: func(cmd *cobra.Command, _ []string) error {
			e, err := config.LoadEnv()
			if err != nil {
				return err
			}
			log := slog.New(slog.NewTextHandler(io.Discard, nil))
			pool, err := openDB(cmd.Context(), e, log)
			if err != nil {
				return err
			}
			defer pool.Close()
			rc := openCache(e, log)
			s := &api.Server{Pool: pool, Results: cache.NewResults(rc, nil), Env: e, ConfigRev: "bench", Log: log,
				Geo: query.GeoOptions{Enabled: true, MinPrecisionBits: 20, Exclude: map[uint32]bool{}, Params: geo.DefaultParams()}}
			mux := http.NewServeMux()
			s.NewHandler(mux)
			srv := httptest.NewServer(mux)
			defer srv.Close()
			var rowsTotal int64
			_ = pool.QueryRow(cmd.Context(), `SELECT count(*) FROM packet_log`).Scan(&rowsTotal)
			fmt.Printf("database rows: %d; CPUs visible to bench: %d\n", rowsTotal, runtime.NumCPU())
			end := time.Now().UTC().Add(-time.Minute).Truncate(time.Minute)
			for _, ep := range []string{"/api/v1/snapshot", "/api/v1/traffic", "/api/v1/edges"} {
				var cold, warm []time.Duration
				var size int
				for i := 0; i < n; i++ {
					// Distinct windows (shifted by i minutes) defeat the cache: cold.
					we := end.Add(-time.Duration(i) * time.Minute)
					q := url.Values{"start": {we.Add(-time.Duration(hours) * time.Hour).Format(time.RFC3339)}, "end": {we.Format(time.RFC3339)}}
					if rc != nil {
						_ = rc.R.FlushDB(context.Background()).Err()
					}
					d, sz, err := timeGet(srv.URL + ep + "?" + q.Encode())
					if err != nil {
						return err
					}
					cold = append(cold, d)
					size = sz
					d, _, err = timeGet(srv.URL + ep + "?" + q.Encode())
					if err != nil {
						return err
					}
					warm = append(warm, d)
				}
				fmt.Printf("%-18s %dh window: cold p50 %6s p95 %6s | warm p50 %6s p95 %6s | %d KiB\n", ep, hours,
					pct(cold, 50), pct(cold, 95), pct(warm, 50), pct(warm, 95), size/1024)
			}
			return nil
		},
	}
	cmd.Flags().IntVar(&n, "n", 10, "requests per endpoint")
	cmd.Flags().IntVar(&hours, "hours", 72, "window length")
	return cmd
}

func timeGet(u string) (time.Duration, int, error) {
	t := time.Now()
	resp, err := http.Get(u)
	if err != nil {
		return 0, 0, err
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(resp.Body)
	if err != nil {
		return 0, 0, err
	}
	if resp.StatusCode != 200 {
		var p map[string]any
		_ = json.Unmarshal(b, &p)
		return 0, 0, fmt.Errorf("%s: HTTP %d %v", u, resp.StatusCode, p["detail"])
	}
	return time.Since(t), len(b), nil
}

func pct(d []time.Duration, p int) time.Duration {
	s := slices.Clone(d)
	slices.Sort(s)
	i := (len(s)*p + 99) / 100
	if i > 0 {
		i--
	}
	return s[i].Round(time.Millisecond)
}
