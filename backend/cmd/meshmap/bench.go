package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"runtime"
	"slices"
	"time"

	"github.com/spf13/cobra"

	"github.com/868-no/map/internal/api"
	"github.com/868-no/map/internal/config"
	"github.com/868-no/map/internal/demo"
	"github.com/868-no/map/internal/ingest"
	"github.com/868-no/map/internal/security"
	"github.com/868-no/map/internal/storage"
)

// seedCmd fills a database with synthetic, protocol-correct observations
// spread over a time range, through the production Process + COPY path.
func seedCmd() *cobra.Command {
	var nodes, rows int
	var days float64
	var seed uint64
	var force bool
	cmd := &cobra.Command{
		Use:   "seed",
		Short: "Fill the database with a synthetic mesh for benchmarks (never use on production data)",
		RunE: func(cmd *cobra.Command, _ []string) error {
			e, err := config.LoadEnv()
			if err != nil {
				return err
			}
			// Synthetic rows are indistinguishable from real ones once stored.
			if !e.DemoMode && !force {
				return errors.New("seed writes synthetic rows: refusing without DEMO_MODE=true or --force")
			}
			log := slog.New(slog.NewTextHandler(io.Discard, nil))
			pool, err := openDB(cmd.Context(), e, log, "seed", 4)
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
			ids := memIDs{}
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
					// The clock moves on only for a stored row: rejected inputs
					// and repeats would otherwise push the last rows past now.
					at := t.Add(step)
					obs, err := ingest.Process(ingest.RawMessage{BrokerID: "bench", Topic: m.Topic, Payload: m.Payload, ObservedAt: at}, o)
					if err != nil {
						rejected++
						continue
					}
					if seen[obs.ObservationKey] {
						continue
					}
					t = at
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
	cmd.Flags().BoolVar(&force, "force", false, "seed even when DEMO_MODE is not true (a throwaway database)")
	return cmd
}

// benchCmd measures what a browser does when it opens a window: fetch every
// /observations page for it (the views are derived client-side, D-041).
func benchCmd() *cobra.Command {
	var n int
	var hours int
	var dump string
	cmd := &cobra.Command{
		Use:   "bench",
		Short: "Measure full-window /observations fetches on the current database",
		RunE: func(cmd *cobra.Command, _ []string) error {
			e, err := config.LoadEnv()
			if err != nil {
				return err
			}
			log := slog.New(slog.NewTextHandler(io.Discard, nil))
			pool, err := openDB(cmd.Context(), e, log, "api", e.DBAPIConns)
			if err != nil {
				return err
			}
			defer pool.Close()
			s := &api.Server{Pool: pool, Env: e, ConfigRev: "bench", Log: log}
			mux := http.NewServeMux()
			s.NewHandler(mux)
			srv := httptest.NewServer(mux)
			defer srv.Close()
			var rowsTotal int64
			_ = pool.QueryRow(cmd.Context(), `SELECT count(*) FROM packet_log`).Scan(&rowsTotal)
			fmt.Printf("database rows: %d; CPUs visible to bench: %d\n", rowsTotal, runtime.NumCPU())
			end := time.Now().UTC().Add(-time.Minute).Truncate(time.Minute)
			var took, first []time.Duration
			var rows, bytes, pages int
			var all []json.RawMessage // first window's rows, for --dump
			for i := range n {
				// Distinct windows (shifted by i minutes) avoid measuring one cached plan.
				we := end.Add(-time.Duration(i) * time.Minute)
				q := url.Values{"start": {we.Add(-time.Duration(hours) * time.Hour).Format(time.RFC3339)}, "end": {we.Format(time.RFC3339)}}
				t0 := time.Now()
				rows, bytes, pages = 0, 0, 0
				for cursor := ""; ; {
					if cursor != "" {
						q.Set("cursor", cursor)
					}
					d, body, err := timeGetBody(cmd.Context(), srv.URL+"/api/v1/observations?"+q.Encode())
					if err != nil {
						return err
					}
					if pages == 0 {
						first = append(first, d)
					}
					var page struct {
						Rows       []json.RawMessage `json:"rows"`
						More       bool              `json:"more"`
						NextCursor string            `json:"next_cursor"`
					}
					if err := json.Unmarshal(body, &page); err != nil {
						return err
					}
					rows, bytes, pages = rows+len(page.Rows), bytes+len(body), pages+1
					if i == 0 && dump != "" {
						all = append(all, page.Rows...)
					}
					if !page.More {
						break
					}
					cursor = page.NextCursor
				}
				took = append(took, time.Since(t0))
			}
			if dump != "" {
				b, err := json.Marshal(all)
				if err != nil {
					return err
				}
				if err := os.WriteFile(dump, b, 0o644); err != nil {
					return err
				}
			}
			fmt.Printf("%dh window: %d rows in %d pages, %d MiB uncompressed | first page p50 %s | whole window p50 %s p95 %s\n",
				hours, rows, pages, bytes>>20, pct(first, 50), pct(took, 50), pct(took, 95))
			return nil
		},
	}
	cmd.Flags().IntVar(&n, "n", 8, "fetches per window length")
	cmd.Flags().IntVar(&hours, "hours", 72, "window length")
	cmd.Flags().StringVar(&dump, "dump", "", "also write the first window's rows (JSON array) to this file, e.g. for the engine benchmark")
	return cmd
}

func timeGetBody(ctx context.Context, u string) (time.Duration, []byte, error) {
	t := time.Now()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return 0, nil, err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(resp.Body)
	if err != nil {
		return 0, nil, err
	}
	if resp.StatusCode != http.StatusOK {
		var p map[string]any
		_ = json.Unmarshal(b, &p)
		return 0, nil, fmt.Errorf("%s: HTTP %d %v", u, resp.StatusCode, p["detail"])
	}
	return time.Since(t), b, nil
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
