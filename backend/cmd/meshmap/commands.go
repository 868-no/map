package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/spf13/cobra"

	"github.com/868-no/map/internal/api"
	"github.com/868-no/map/internal/cache"
	"github.com/868-no/map/internal/config"
	"github.com/868-no/map/internal/demo"
	"github.com/868-no/map/internal/identity"
	"github.com/868-no/map/internal/ingest"
	"github.com/868-no/map/internal/maintenance"
	"github.com/868-no/map/internal/mqtt"
	"github.com/868-no/map/internal/observability"
	"github.com/868-no/map/internal/security"
	"github.com/868-no/map/internal/storage"
)

func databaseURL(e config.Env) string {
	if e.DatabaseURL != "" {
		return e.DatabaseURL
	}
	u := url.URL{Scheme: "postgres", User: url.UserPassword(e.PGUser, e.PGPassword), Host: e.PGHost + ":" + strconv.Itoa(e.PGPort), Path: "/" + e.PGDB}
	q := u.Query()
	q.Set("sslmode", "disable") // compose-internal network; set DATABASE_URL for remote TLS
	u.RawQuery = q.Encode()
	return u.String()
}

// openDB connects and waits for the database to accept connections.
func openDB(ctx context.Context, e config.Env, log *slog.Logger) (*pgxpool.Pool, error) {
	pool, err := storage.Open(ctx, databaseURL(e))
	if err != nil {
		return nil, err
	}
	for attempt := 0; ; attempt++ {
		pctx, cancel := context.WithTimeout(ctx, 3*time.Second)
		err = pool.Ping(pctx)
		cancel()
		if err == nil {
			return pool, nil
		}
		if attempt >= 30 || ctx.Err() != nil {
			pool.Close()
			return nil, fmt.Errorf("database unreachable: %w", err)
		}
		log.Info("waiting for database", "attempt", attempt+1)
		time.Sleep(mqtt.Backoff(min(attempt, 3)))
	}
}

func openCache(e config.Env, log *slog.Logger) *cache.Client {
	c, err := cache.New(e.RedisURL)
	if err != nil {
		log.Warn("invalid REDIS_URL; running without cache", "err", err)
		return nil
	}
	return c
}

func checkConfigCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "check-config",
		Short: "Validate environment and mounted broker/channel configuration (secrets redacted)",
		RunE: func(cmd *cobra.Command, _ []string) error {
			c, err := config.Load()
			if err != nil {
				return fmt.Errorf("invalid configuration:\n%w", err)
			}
			fmt.Print(c.Summary())
			fmt.Println("configuration OK")
			return nil
		},
	}
}

func initSchemaCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "init-schema",
		Short: "Create or verify packet_log (idempotent, advisory-locked)",
		RunE: func(cmd *cobra.Command, _ []string) error {
			e, err := config.LoadEnv()
			if err != nil {
				return err
			}
			log := observability.NewLogger(e.LogLevel)
			pool, err := openDB(cmd.Context(), e, log)
			if err != nil {
				return err
			}
			defer pool.Close()
			if err := storage.InitSchema(cmd.Context(), pool); err != nil {
				return err
			}
			if err := storage.CheckSchema(cmd.Context(), pool); err != nil {
				return err
			}
			log.Info("schema ready", "version", storage.SchemaVersion)
			return nil
		},
	}
}

func maintenanceCmd() *cobra.Command {
	var once bool
	cmd := &cobra.Command{
		Use:   "maintenance",
		Short: "Run retention cleanup (daily loop, or --once)",
		RunE: func(cmd *cobra.Command, _ []string) error {
			e, err := config.LoadEnv()
			if err != nil {
				return err
			}
			log := observability.NewLogger(e.LogLevel).With("role", "maintenance")
			pool, err := openDB(cmd.Context(), e, log)
			if err != nil {
				return err
			}
			defer pool.Close()
			if err := storage.InitSchema(cmd.Context(), pool); err != nil {
				return err
			}
			c := openCache(e, log)
			r := &maintenance.Runner{Pool: pool, Cache: c, Months: e.RetentionMonths, Interval: time.Duration(e.MaintenanceInterval) * time.Hour,
				Metrics: observability.NewMetrics(), Log: log}
			if once {
				st, err := r.RunOnce(cmd.Context())
				if err != nil {
					return err
				}
				fmt.Printf("deleted %d rows older than %s; table %d bytes\n", st.DeletedRows, st.Cutoff.Format(time.RFC3339), st.TableBytes)
				return nil
			}
			return r.Loop(cmd.Context())
		},
	}
	cmd.Flags().BoolVar(&once, "once", false, "run a single cleanup and exit")
	return cmd
}

func demoPublishCmd() *cobra.Command {
	c := demo.PublishConfig{}
	cmd := &cobra.Command{
		Use:   "demo-publish",
		Short: "Publish simulated mesh traffic to a local demo broker",
		RunE: func(cmd *cobra.Command, _ []string) error {
			e, _ := config.LoadEnv()
			c.Log = observability.NewLogger(e.LogLevel).With("role", "demo")
			return demo.Publish(cmd.Context(), c)
		},
	}
	cmd.Flags().StringVar(&c.Host, "host", "mosquitto", "demo broker host (must be private/local)")
	cmd.Flags().IntVar(&c.Port, "port", 1883, "demo broker port")
	cmd.Flags().Float64Var(&c.Rate, "rate", 5, "simulation ticks per second")
	cmd.Flags().Uint64Var(&c.Seed, "seed", 1, "deterministic scenario seed")
	cmd.Flags().BoolVar(&c.AllowExternal, "allow-external", false, "allow a non-private broker host (isolated test brokers only)")
	return cmd
}

// supervisor owns the broker clients for readiness reporting.
type supervisor struct {
	pipe    *ingest.Pipeline
	mu      sync.Mutex
	clients []mqtt.Client
	demo    bool
}

func (s *supervisor) Healthy() (bool, string) { return s.pipe.Healthy() }

func (s *supervisor) Brokers() map[string]string {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := map[string]string{}
	for _, c := range s.clients {
		out[c.ID()] = c.State().String()
	}
	return out
}

type storeSink struct{ pool *pgxpool.Pool }

func (s storeSink) InsertBatch(ctx context.Context, obs []*ingest.Observation) ([]int64, error) {
	return storage.InsertBatch(ctx, s.pool, obs)
}

func (s storeSink) RecentObservation(ctx context.Context, k [16]byte, since time.Time) (int64, bool, error) {
	return storage.RecentObservation(ctx, s.pool, k, since)
}

func (s storeSink) AddAlsoVia(ctx context.Context, byRow map[int64][]string) (int64, error) {
	return storage.AddAlsoVia(ctx, s.pool, byRow)
}

// demoBroker is the compose demo profile's broker, used when DEMO_MODE is
// set and no broker file is mounted.
var demoBroker = config.Broker{ID: "demo", Host: "mosquitto", Port: 1883, Protocol: "v5", ClientID: "meshmap-ingest-demo",
	Topics: []config.Subscription{{Filter: demo.TopicRoot + "/#"}}}

func serveCmd() *cobra.Command {
	var noIngest bool
	cmd := &cobra.Command{
		Use:   "serve",
		Short: "Run MQTT ingestion and the HTTP server",
		RunE: func(cmd *cobra.Command, _ []string) error {
			ctx := cmd.Context()
			c, err := config.Load()
			if err != nil {
				return fmt.Errorf("invalid configuration:\n%w", err)
			}
			log := observability.NewLogger(c.Env.LogLevel).With("role", "serve")
			m := observability.NewMetrics()
			pool, err := openDB(ctx, c.Env, log)
			if err != nil {
				return err
			}
			defer pool.Close()
			if err := storage.InitSchema(ctx, pool); err != nil {
				return err
			}
			rc := openCache(c.Env, log)

			var sup *supervisor
			var wg sync.WaitGroup
			hub := api.NewHub(!noIngest)
			ingestCtx, stopIngest := context.WithCancel(context.Background())
			defer stopIngest()
			if !noIngest {
				chs := c.SecurityChannels()
				brokers := c.Brokers
				if c.Env.DemoMode {
					if len(chs) == 0 {
						chs = demo.Channels()
					}
					if len(brokers) == 0 {
						brokers = []config.Broker{demoBroker}
					}
				}
				kr, err := security.NewKeyring(chs)
				if err != nil {
					return err
				}
				ids := identity.New(func(ctx context.Context) ([]storage.IdentityRow, error) {
					return storage.VerifiedIdentities(ctx, pool, nil)
				}, log)
				if err := ids.Reload(ctx); err != nil {
					return fmt.Errorf("identity rebuild: %w", err)
				}
				m.Identities.Set(float64(ids.Len()))
				log.Info("identity index rebuilt from packet_log", "identities", ids.Len())
				retained := map[string]bool{}
				for _, b := range brokers {
					retained[b.ID] = b.AcceptRetained
				}
				var dd ingest.Dedupe
				pubs := multiPublisher{hub}
				if rc != nil {
					dd = rc
					pubs = append(pubs, &livePublisher{c: rc, log: log})
				}
				var pub ingest.Publisher = pubs
				pipe := ingest.New(ingest.Config{
					QueueSize: c.Env.IngestQueueSize, BatchSize: c.Env.WriterBatchSize,
					ProcessOpts: ingest.Options{Keyring: kr, Identities: ids, Policy: c.Policy, KeyBudget: c.Env.KeyAttemptBudget,
						AcceptRetained: func(b string) bool { return retained[b] }},
				}, storeSink{pool}, dd, pub, ids, m, log)
				sup = &supervisor{pipe: pipe, demo: c.Env.DemoMode}
				wg.Add(1)
				go func() { defer wg.Done(); pipe.Run(ingestCtx) }()
				go ids.Run(ingestCtx, time.Hour, retentionTrigger(ingestCtx, rc, log))
				go func() {
					t := time.NewTicker(30 * time.Second)
					defer t.Stop()
					for {
						select {
						case <-ingestCtx.Done():
							return
						case <-t.C:
							m.Identities.Set(float64(ids.Len()))
						}
					}
				}()
				for _, b := range brokers {
					cl, err := mqtt.New(b, pipe.Submit, m, log)
					if err != nil {
						return err
					}
					sup.clients = append(sup.clients, cl)
					go func() {
						if err := cl.Run(ingestCtx); err != nil {
							log.Error("broker client stopped", "broker", cl.ID(), "err", err)
						}
					}()
				}
				log.Info("ingest started", "brokers", len(brokers), "keys", kr.Len(), "demo", c.Env.DemoMode)
			}

			mux := http.NewServeMux()
			h := &api.Health{Pool: pool, Cache: rc, Started: time.Now()}
			if sup != nil {
				h.Ingest = sup
			}
			h.Register(mux, m, c.Env.PublicMetricsEnabled)
			if rc != nil {
				// Retention notices always; live events too in API-only mode.
				go hub.FeedFromRedis(ingestCtx, rc, noIngest, log)
			}
			apiSrv := &api.Server{Pool: pool,
				Hub: hub, Env: c.Env, ConfigRev: c.Revision(), Metrics: m, Log: log,
				Geo: api.GeoOptions{Enabled: c.Env.GeolocationEnabled, MinPrecisionBits: c.Env.GeolocationMinPrec, Exclude: c.Exclude, Params: c.GeoParams()}}
			apiSrv.NewHandler(mux)
			handler := api.Protect(mux, api.Limits{Trusted: c.Proxies, PerSecond: 20, Burst: 60, Timeout: 20 * time.Second, MaxStreams: 4})
			srv := &http.Server{Addr: c.Env.HTTPAddr, Handler: handler, ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 2 * time.Minute}
			msrv := &http.Server{Addr: ":9100", Handler: api.MetricsHandler(m), ReadHeaderTimeout: 5 * time.Second}
			errc := make(chan error, 2)
			go func() { errc <- srv.ListenAndServe() }()
			go func() { errc <- msrv.ListenAndServe() }()
			log.Info("http listening", "addr", c.Env.HTTPAddr, "metrics", ":9100")
			select {
			case <-ctx.Done():
			case err := <-errc:
				if !errors.Is(err, http.ErrServerClosed) {
					log.Error("http server failed", "err", err)
				}
			}
			log.Info("shutting down")
			sctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			_ = srv.Shutdown(sctx)
			_ = msrv.Shutdown(sctx)
			stopIngest() // clients disconnect, workers drain, writer flushes
			wg.Wait()
			if rc != nil {
				_ = rc.Close()
			}
			log.Info("stopped")
			return nil
		},
	}
	cmd.Flags().BoolVar(&noIngest, "no-ingest", false, "serve HTTP only (split deployments)")
	return cmd
}

// multiPublisher fans live events to several sinks (in-process hub, Redis).
type multiPublisher []ingest.Publisher

func (m multiPublisher) PublishLive(ctx context.Context, evs []ingest.LiveEvent) {
	for _, p := range m {
		p.PublishLive(ctx, evs)
	}
}

func openapiCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "openapi",
		Short: "Print the OpenAPI document (YAML) generated from the serving code",
		RunE: func(cmd *cobra.Command, _ []string) error {
			e, _ := config.LoadEnv()
			s := &api.Server{Env: e}
			a := s.NewHandler(http.NewServeMux())
			b, err := a.OpenAPI().YAML()
			if err != nil {
				return err
			}
			_, err = os.Stdout.Write(b)
			return err
		},
	}
}

// retentionTrigger converts retention notifications into identity reloads.
func retentionTrigger(ctx context.Context, rc *cache.Client, log *slog.Logger) <-chan struct{} {
	ch := make(chan struct{}, 1)
	if rc == nil {
		return ch
	}
	go func() {
		for ctx.Err() == nil {
			sub := rc.R.Subscribe(ctx, maintenance.RetentionChannel)
			for range sub.Channel() {
				select {
				case ch <- struct{}{}:
				default:
				}
			}
			_ = sub.Close()
			select {
			case <-ctx.Done():
			case <-time.After(5 * time.Second):
			}
		}
	}()
	return ch
}
