package main

import (
	"context"
	"encoding/json"
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
	"github.com/868-no/map/internal/terrain"
	"github.com/868-no/map/internal/weather"
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

// openDB connects a pool of at most conns connections and waits for the
// database to accept connections.
func openDB(ctx context.Context, e config.Env, log *slog.Logger, role string, conns int) (*pgxpool.Pool, error) {
	pool, err := storage.Open(ctx, databaseURL(e), role, conns)
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
			pool, err := openDB(cmd.Context(), e, log, "schema", 1)
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
			pool, err := openDB(cmd.Context(), e, log, "maintenance", 2)
			if err != nil {
				return err
			}
			defer pool.Close()
			if err := storage.InitSchema(cmd.Context(), pool); err != nil {
				return err
			}
			c := openCache(e, log)
			r := &maintenance.Runner{Pool: pool, Cache: c, Months: e.RetentionMonths, Interval: time.Duration(e.MaintenanceInterval) * time.Hour, Log: log}
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

func (s storeSink) AddAlsoVia(ctx context.Context, byRow map[int64][]string, since time.Time) (int64, error) {
	return storage.AddAlsoVia(ctx, s.pool, byRow, since)
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
			// API reads and ingest get separate pools, so slow readers can
			// never hold the connections the writer needs (D-115).
			pool, err := openDB(ctx, c.Env, log, "api", c.Env.DBAPIConns)
			if err != nil {
				return err
			}
			defer pool.Close()
			if err := storage.InitSchema(ctx, pool); err != nil {
				return err
			}
			// The writer, dedupe lookups, identity reloads and the startup
			// re-decode and backfill jobs. Opened here so that it closes only
			// after every deferred stop below has run.
			var ipool *pgxpool.Pool
			if !noIngest {
				if ipool, err = openDB(ctx, c.Env, log, "ingest", c.Env.DBIngestConns); err != nil {
					return err
				}
				defer ipool.Close()
			}
			rc := openCache(c.Env, log)
			if noIngest {
				// Ingesting processes rebuild encodings after decoding old rows again (below).
				go func() {
					if _, err := storage.BackfillObsRows(ctx, pool, log); err != nil && ctx.Err() == nil {
						log.Error("rebuilding stored row encodings failed; rows are built per request", "err", err)
					}
				}()
			}

			var sup *supervisor
			var wg sync.WaitGroup
			hub := api.NewHub(!noIngest)
			ingestCtx, stopIngest := context.WithCancel(context.Background())
			defer stopIngest()
			// MQTT input has its own context so it stops before the pipeline
			// (design §2.7): no callback is still submitting when the queue closes.
			mqttCtx, stopMQTT := context.WithCancel(context.Background())
			defer stopMQTT()
			var mqttWG sync.WaitGroup
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
				kr.DefaultFallback = c.Env.DefaultKeyFallback
				ids := identity.New(identity.StorageLoader(ipool), log)
				if err := ids.Reload(ctx); err != nil {
					return fmt.Errorf("identity rebuild: %w", err)
				}
				m.Identities.Set(float64(ids.Len()))
				log.Info("identity index rebuilt from packet_log", "identities", ids.Len())
				// Rows decoded by an older decoder get the current one (D-107),
				// then their client encodings are rebuilt.
				// One after the other, not side by side: each walks the table.
				go func(o ingest.Options) {
					if _, err := storage.Redecode(ctx, ipool, o, log); err != nil && ctx.Err() == nil {
						log.Error("decoding old rows again failed", "err", err)
					}
					if _, err := storage.BackfillObsRows(ctx, ipool, log); err != nil && ctx.Err() == nil {
						log.Error("rebuilding stored row encodings failed; rows are built per request", "err", err)
					}
				}(ingest.Options{Keyring: kr, Identities: ids, Policy: c.Policy, KeyBudget: c.Env.KeyAttemptBudget, AcceptRetained: func(string) bool { return true }})
				retained := map[string]bool{}
				for _, b := range brokers {
					retained[b.ID] = b.AcceptRetained
				}
				var dd ingest.Dedupe
				pubs := multiPublisher{hub}
				if rc != nil {
					dd = rc
					pubs = append(pubs, newLivePublisher(ingestCtx, rc, log))
				}
				var pub ingest.Publisher = pubs
				pipe := ingest.New(ingest.Config{
					QueueSize: c.Env.IngestQueueSize, BatchSize: c.Env.WriterBatchSize,
					ProcessOpts: ingest.Options{Keyring: kr, Identities: ids, Policy: c.Policy, KeyBudget: c.Env.KeyAttemptBudget,
						AcceptRetained: func(b string) bool { return retained[b] }},
				}, storeSink{ipool}, dd, pub, ids, m, log)
				sup = &supervisor{pipe: pipe}
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
					sup.mu.Lock()
					sup.clients = append(sup.clients, cl)
					sup.mu.Unlock()
					mqttWG.Add(1)
					go func() {
						defer mqttWG.Done()
						if err := cl.Run(mqttCtx); err != nil {
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
				Hub: hub, Env: c.Env, ConfigRev: c.Revision(), Metrics: m, Log: log, HeavySlots: c.Env.APIReadSlots,
				Geo: api.GeoOptions{Enabled: c.Env.GeolocationEnabled, MinPrecisionBits: c.Env.GeolocationMinPrec, Exclude: c.Exclude, Params: c.GeoParams()}}
			if rc != nil {
				apiSrv.DayCache = rc // whole days shared between replicas (D-158)
			}
			ua := "868-map/" + api.Version + " github.com/868-no/map"
			if c.Env.OperatorContact != "" {
				ua += " " + c.Env.OperatorContact
			}
			// Routers and base stations, read once for the terrain warmer and
			// the weather keeper alike (D-133, D-144), over the longer of their
			// windows.
			roster := &storage.Roster{Pool: pool, Window: max(terrain.WarmWindow, time.Duration(c.Env.MaxWindowHours)*time.Hour), Alive: 24 * time.Hour, TTL: 20 * time.Minute}
			if c.Env.TerrainEnabled {
				apiSrv.Terrain = terrain.New(c.Env.TerrainURL, ua)
				apiSrv.Terrain.Store, apiSrv.Terrain.Log = &terrain.Store{Pool: pool}, log
				go apiSrv.Terrain.Run(ctx)
				// Heights between infrastructure nodes, fetched before anyone
				// asks (D-144). Each replica warms its own queue; the store
				// keeps any point from being fetched twice once it is in.
				warm := &terrain.Warmer{Client: apiSrv.Terrain, Interval: terrain.WarmInterval, Log: log,
					Load: func(ctx context.Context) ([]terrain.End, error) {
						nodes, err := roster.Nodes(ctx)
						if err != nil {
							return nil, err
						}
						ends := make([]terrain.End, len(nodes))
						for i, n := range nodes {
							ends[i] = terrain.End{Point: terrain.Point{Lat: n.Lat, Lon: n.Lon}, Alt: n.Alt}
						}
						return ends, nil
					}}
				go warm.Run(ctx)
			}
			if c.Env.WeatherEnabled {
				apiSrv.Weather = weather.New(c.Env.WeatherURL, ua)
				apiSrv.Weather.Store, apiSrv.Weather.Log = &weather.Store{Pool: pool}, log
				go apiSrv.Weather.Run(ctx)
				// Live routers' weather is kept ready over the longest window (D-133).
				span := time.Duration(c.Env.MaxWindowHours) * time.Hour
				go apiSrv.Weather.Keep(ctx, roster.TTL, span, func(ctx context.Context) ([]weather.Cell, error) {
					nodes, err := roster.Nodes(ctx)
					return weather.Cells(nodes), err
				})
			}
			apiSrv.NewHandler(mux)
			go apiSrv.WarmTrends(ctx)
			handler := api.Protect(mux, api.Limits{Trusted: c.Proxies, PerSecond: c.Env.APIRatePerSecond, Burst: c.Env.APIRateBurst,
				Timeout: c.Env.APIRequestTimeout, MaxStreams: c.Env.APIStreamsPerClient, MaxStreamsTotal: c.Env.APIStreamsTotal,
				HeavyPerClient: c.Env.APIReadsPerClient})
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
			// Stop taking MQTT input first (clients disconnect, workers drain,
			// the writer flushes, bounded by its drain timeout), end live
			// streams so Shutdown need not wait for them, then let in-flight
			// requests finish.
			stopMQTT()
			waitFor(&mqttWG, 3*time.Second)
			stopIngest()
			apiSrv.CloseStreams()
			sctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			_ = srv.Shutdown(sctx)
			_ = msrv.Shutdown(sctx)
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

// waitFor waits for wg, at most d.
func waitFor(wg *sync.WaitGroup, d time.Duration) {
	done := make(chan struct{})
	go func() { wg.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(d):
	}
}

// multiPublisher fans live events to several sinks (in-process hub, Redis).
type multiPublisher []ingest.Publisher

func (m multiPublisher) PublishLive(ctx context.Context, batch json.RawMessage) {
	for _, p := range m {
		p.PublishLive(ctx, batch)
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

// retentionTrigger converts retention notifications into identity reloads,
// until ctx ends. A reconnect also reloads: a notice may have been missed.
func retentionTrigger(ctx context.Context, rc *cache.Client, log *slog.Logger) <-chan struct{} {
	ch := make(chan struct{}, 1)
	if rc == nil {
		return ch
	}
	poke := func() {
		select {
		case ch <- struct{}{}:
		default:
		}
	}
	lost := false
	go rc.Listen(ctx, []string{maintenance.RetentionChannel}, cache.Listener{
		Up: func() {
			if lost {
				poke()
			}
		},
		Down: func(err error) {
			lost = true
			log.Debug("retention notices from Redis lost; reconnecting", "err", err)
		},
		Message: func(string, string) { poke() },
	})
	return ch
}
