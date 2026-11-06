// Package config loads environment settings and the mounted broker/channel
// YAML files, validates them, and renders a redacted summary. Secrets never
// appear in errors or summaries.
package config

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net/netip"
	"os"
	"regexp"
	"strings"
	"time"

	"github.com/caarlos0/env/v11"
	"gopkg.in/yaml.v3"

	"github.com/868-no/map/internal/geo"
	"github.com/868-no/map/internal/security"
	"github.com/868-no/map/internal/window"
)

// Env holds settings from environment variables (.env.example documents them).
type Env struct {
	DatabaseURL string `env:"DATABASE_URL"`
	PGHost      string `env:"POSTGRES_HOST" envDefault:"postgres"`
	PGPort      int    `env:"POSTGRES_PORT" envDefault:"5432"`
	PGDB        string `env:"POSTGRES_DB" envDefault:"meshmap"`
	PGUser      string `env:"POSTGRES_USER" envDefault:"meshmap"`
	PGPassword  string `env:"POSTGRES_PASSWORD"`
	RedisURL    string `env:"REDIS_URL" envDefault:"redis://redis:6379/0"`

	HTTPAddr string `env:"HTTP_ADDR" envDefault:":8000"`

	RetentionMonths     int           `env:"RETENTION_MONTHS" envDefault:"6"`
	DefaultWindowHours  int           `env:"DEFAULT_WINDOW_HOURS" envDefault:"72"`
	MaxWindowHours      int           `env:"MAX_WINDOW_HOURS" envDefault:"168"`
	MaintenanceInterval int           `env:"MAINTENANCE_INTERVAL_HOURS" envDefault:"24"`
	LiveQuantum         time.Duration `env:"LIVE_QUANTUM" envDefault:"10s"`
	DefaultMapLat       float64       `env:"DEFAULT_MAP_LAT" envDefault:"63.43"`
	DefaultMapLon       float64       `env:"DEFAULT_MAP_LON" envDefault:"10.40"`
	DefaultMapZoom      float64       `env:"DEFAULT_MAP_ZOOM" envDefault:"7"`
	MapStyleURL         string        `env:"MAP_STYLE_URL" envDefault:"/styles/dark.json"`
	MapStyleLightURL    string        `env:"MAP_STYLE_LIGHT_URL" envDefault:"/styles/light.json"`
	// Who runs this deployment, shown in the privacy policy (D-051).
	OperatorName         string   `env:"OPERATOR_NAME"`
	OperatorContact      string   `env:"OPERATOR_CONTACT"`
	MapTileSource        string   `env:"MAP_TILE_SOURCE" envDefault:"pmtiles:///tiles/basemap.pmtiles"`
	GeolocationEnabled   bool     `env:"GEOLOCATION_ENABLED" envDefault:"true"`
	GeolocationExclude   []string `env:"GEOLOCATION_EXCLUDE_NODE_IDS" envSeparator:","`
	GeolocationMinPrec   uint32   `env:"GEOLOCATION_MIN_PRECISION_BITS" envDefault:"15"`
	PublicMetricsEnabled bool     `env:"PUBLIC_METRICS_ENABLED" envDefault:"false"`
	// Hourly weather for stationary routers from MET Norway (D-133).
	WeatherEnabled bool   `env:"WEATHER_ENABLED" envDefault:"true"`
	WeatherURL     string `env:"WEATHER_URL" envDefault:"https://thredds.met.no/thredds/dodsC"`
	// Terrain cross sections of router links from Kartverket (D-143).
	TerrainEnabled  bool     `env:"TERRAIN_ENABLED" envDefault:"true"`
	TerrainURL      string   `env:"TERRAIN_URL" envDefault:"https://ws.geonorge.no/hoydedata/v1"`
	SignaturePolicy string   `env:"SIGNATURE_POLICY" envDefault:"balanced"`
	TrustedProxies  []string `env:"TRUSTED_PROXIES" envSeparator:"," envDefault:"10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,127.0.0.0/8,::1/128,fc00::/7"`
	// Public API protection, per client (an IPv4 address or an IPv6 /64).
	APIRatePerSecond    float64       `env:"API_RATE_PER_SECOND" envDefault:"20"`
	APIRateBurst        int           `env:"API_RATE_BURST" envDefault:"60"`
	APIRequestTimeout   time.Duration `env:"API_REQUEST_TIMEOUT" envDefault:"20s"`
	APIStreamsPerClient int           `env:"API_STREAMS_PER_CLIENT" envDefault:"4"`
	APIStreamsTotal     int           `env:"API_STREAMS_TOTAL" envDefault:"2000"`
	APIReadsPerClient   int           `env:"API_READS_PER_CLIENT" envDefault:"4"`
	APIReadSlots        int           `env:"API_READ_SLOTS" envDefault:"8"`
	// Separate database pools, so API reads can never take the connections
	// the ingest writer needs (D-115).
	DBIngestConns    int `env:"DB_INGEST_CONNS" envDefault:"6"`
	DBAPIConns       int `env:"DB_API_CONNS" envDefault:"12"`
	IngestQueueSize  int `env:"INGEST_QUEUE_SIZE" envDefault:"20000"`
	WriterBatchSize  int `env:"WRITER_BATCH_SIZE" envDefault:"500"`
	KeyAttemptBudget int `env:"KEY_ATTEMPT_BUDGET" envDefault:"4"`
	// Try the public default key (AQ==) for channels not in the channel
	// keys configuration (D-065).
	DefaultKeyFallback bool   `env:"DEFAULT_KEY_FALLBACK" envDefault:"true"`
	LogLevel           string `env:"LOG_LEVEL" envDefault:"info"`
	BrokersConfig      string `env:"MQTT_BROKERS_CONFIG" envDefault:"/run/secrets/mqtt-brokers.yaml"`
	ChannelsConfig     string `env:"CHANNEL_KEYS_CONFIG" envDefault:"/run/secrets/channel-keys.yaml"`
	// The same YAML documents inline, for deployments configured entirely in
	// the Compose file. When set they replace the files above. Never logged.
	BrokersYAML    string `env:"MQTT_BROKERS"`
	ChannelsYAML   string `env:"CHANNEL_KEYS"`
	DemoMode       bool   `env:"DEMO_MODE" envDefault:"false"`
	GeoCalibration string `env:"GEOLOCATION_CALIBRATION"`
}

// TLS settings for a broker.
type TLS struct {
	Enabled            bool   `yaml:"enabled"`
	CAFile             string `yaml:"ca_file"`
	InsecureSkipVerify bool   `yaml:"insecure_skip_verify"`
	ServerName         string `yaml:"server_name"`
}

// Subscription is one topic filter.
type Subscription struct {
	Filter string `yaml:"filter"`
	QoS    byte   `yaml:"qos"`
}

// Broker is one MQTT source.
type Broker struct {
	ID             string         `yaml:"id"`
	Host           string         `yaml:"host"`
	Port           int            `yaml:"port"`
	Protocol       string         `yaml:"protocol"` // v5 (default) or v311
	TLS            TLS            `yaml:"tls"`
	Username       string         `yaml:"username"`
	Password       string         `yaml:"password"`
	PasswordFile   string         `yaml:"password_file"`
	ClientID       string         `yaml:"client_id"`
	Topics         []Subscription `yaml:"topics"`
	AcceptRetained bool           `yaml:"accept_retained"`
}

// Channel is one channel definition with current and historical PSKs.
type Channel struct {
	Name            string   `yaml:"name"`
	BrokerIDs       []string `yaml:"broker_ids"`
	Mode            string   `yaml:"mode"`
	PSKs            []string `yaml:"psks"`
	AcceptPlaintext *bool    `yaml:"accept_plaintext"`
}

// Config is the full validated configuration.
type Config struct {
	Env      Env
	Brokers  []Broker
	Channels []Channel
	Policy   security.Policy
	Proxies  []netip.Prefix
	Exclude  map[uint32]bool
	Calib    *geo.Calibration
}

// GeoParams returns estimator gates plus optional calibration.
func (c *Config) GeoParams() geo.Params {
	p := geo.DefaultParams()
	p.Calibration = c.Calib
	return p
}

// APIReservedConns is how many API pool connections /observations reads
// leave free for health checks, node keys, trends and capabilities.
const APIReservedConns = 2

var idRe = regexp.MustCompile(`^[A-Za-z0-9_.-]{1,64}$`)

// LoadEnv parses environment variables only.
func LoadEnv() (Env, error) {
	var e Env
	if err := env.Parse(&e); err != nil {
		return Env{}, err
	}
	return e, nil
}

// Load reads env plus the broker and channel files and validates all of it.
// In demo mode missing files are allowed (no MQTT sources / demo defaults).
func Load() (*Config, error) {
	e, err := LoadEnv()
	if err != nil {
		return nil, err
	}
	c := &Config{Env: e}
	var errs []error
	if err := readYAML(e.BrokersYAML, "MQTT_BROKERS", e.BrokersConfig, "brokers", &c.Brokers, e.DemoMode); err != nil {
		errs = append(errs, err)
	}
	if err := readYAML(e.ChannelsYAML, "CHANNEL_KEYS", e.ChannelsConfig, "channels", &c.Channels, e.DemoMode); err != nil {
		errs = append(errs, err)
	}
	if err := c.validate(); err != nil {
		errs = append(errs, err)
	}
	if len(errs) > 0 {
		return nil, errors.Join(errs...)
	}
	return c, nil
}

// readYAML decodes the key list from inline (the env var named envName) when
// set, otherwise from the file at path.
func readYAML(inline, envName, path, key string, out any, optional bool) error {
	b := []byte(inline)
	if inline == "" {
		var err error
		if b, err = os.ReadFile(path); err != nil {
			if optional && errors.Is(err, os.ErrNotExist) {
				return nil
			}
			return fmt.Errorf("%s config %s: %w", key, path, err)
		}
	} else {
		path = "from " + envName
	}
	var doc yaml.Node
	if err := yaml.Unmarshal(b, &doc); err != nil {
		return fmt.Errorf("%s config %s: invalid YAML: %w", key, path, err)
	}
	wrapper := map[string]yaml.Node{}
	if err := doc.Decode(&wrapper); err != nil {
		return fmt.Errorf("%s config %s: top level must be a mapping", key, path)
	}
	node, ok := wrapper[key]
	if !ok {
		return fmt.Errorf("%s config %s: missing top-level %q list", key, path, key)
	}
	if err := node.Decode(out); err != nil {
		return fmt.Errorf("%s config %s: %w", key, path, err)
	}
	return nil
}

func (c *Config) validate() error {
	var errs []error
	add := func(format string, args ...any) { errs = append(errs, fmt.Errorf(format, args...)) }
	e := c.Env

	if e.DatabaseURL == "" && e.PGPassword == "" {
		add("POSTGRES_PASSWORD or DATABASE_URL is required")
	}
	if e.PGPassword == "CHANGE_ME" && !e.DemoMode {
		add("POSTGRES_PASSWORD is still the CHANGE_ME placeholder")
	}
	if e.RetentionMonths < 1 || e.RetentionMonths > 120 {
		add("RETENTION_MONTHS must be 1..120")
	}
	if maxH := int(window.MaxDuration / time.Hour); e.MaxWindowHours < 1 || e.MaxWindowHours > maxH {
		add("MAX_WINDOW_HOURS must be 1..%d (spec maximum is 7 days)", maxH)
	}
	if e.DefaultWindowHours < 1 || e.DefaultWindowHours > e.MaxWindowHours {
		add("DEFAULT_WINDOW_HOURS must be 1..MAX_WINDOW_HOURS")
	}
	if e.LiveQuantum < time.Second || e.LiveQuantum > time.Minute {
		add("LIVE_QUANTUM must be between 1s and 1m")
	}
	if e.IngestQueueSize < 100 || e.WriterBatchSize < 1 || e.KeyAttemptBudget < 1 || e.KeyAttemptBudget > 16 {
		add("INGEST_QUEUE_SIZE >= 100, WRITER_BATCH_SIZE >= 1, KEY_ATTEMPT_BUDGET 1..16 required")
	}
	if e.APIRatePerSecond <= 0 || e.APIRateBurst < 1 || e.APIRequestTimeout < time.Second || e.APIStreamsPerClient < 1 ||
		e.APIStreamsTotal < e.APIStreamsPerClient || e.APIReadsPerClient < 1 || e.APIReadSlots < e.APIReadsPerClient {
		add("API limits: API_RATE_PER_SECOND > 0, API_RATE_BURST >= 1, API_REQUEST_TIMEOUT >= 1s, API_STREAMS_PER_CLIENT >= 1, " +
			"API_STREAMS_TOTAL >= API_STREAMS_PER_CLIENT, API_READS_PER_CLIENT >= 1, API_READ_SLOTS >= API_READS_PER_CLIENT")
	}
	if e.DBIngestConns < 2 || e.DBAPIConns < 3 {
		add("DB_INGEST_CONNS >= 2 and DB_API_CONNS >= 3 required")
	} else if e.APIReadSlots > e.DBAPIConns-APIReservedConns {
		add("API_READ_SLOTS (%d) must be at most DB_API_CONNS - %d (%d): each /observations read holds an API connection, "+
			"and health checks and light queries need the rest", e.APIReadSlots, APIReservedConns, e.DBAPIConns-APIReservedConns)
	}
	if e.DefaultMapLat < -90 || e.DefaultMapLat > 90 || e.DefaultMapLon < -180 || e.DefaultMapLon > 180 {
		add("DEFAULT_MAP_LAT/LON out of range")
	}
	p, err := security.ParsePolicy(e.SignaturePolicy)
	if err != nil {
		add("%v", err)
	}
	c.Policy = p
	for _, s := range e.TrustedProxies {
		s = strings.TrimSpace(s)
		if s == "" {
			continue
		}
		pf, err := netip.ParsePrefix(s)
		if err != nil {
			add("TRUSTED_PROXIES: invalid CIDR %q", s)
			continue
		}
		c.Proxies = append(c.Proxies, pf)
	}
	c.Exclude = map[uint32]bool{}
	for _, s := range e.GeolocationExclude {
		if s = strings.TrimSpace(s); s == "" {
			continue
		}
		n, ok := parseNode(s)
		if !ok {
			add("GEOLOCATION_EXCLUDE_NODE_IDS: invalid node id %q", s)
			continue
		}
		c.Exclude[n] = true
	}

	if e.GeoCalibration != "" {
		var doc struct {
			Default geo.Calibration `yaml:"default"`
		}
		if err := readYAML("", "", e.GeoCalibration, "calibration", &doc, false); err != nil {
			add("%v", err)
		} else if doc.Default.Exponent < 1.5 || doc.Default.Exponent > 6 || doc.Default.P0DBm > 0 || doc.Default.P0DBm < -100 {
			add("GEOLOCATION_CALIBRATION: default.path_loss_exponent must be 1.5..6 and p0_dbm -100..0")
		} else {
			c.Calib = &doc.Default
		}
	}

	seen := map[string]bool{}
	for i := range c.Brokers {
		b := &c.Brokers[i]
		where := fmt.Sprintf("broker[%d]", i)
		if !idRe.MatchString(b.ID) {
			add("%s: id must match %s", where, idRe)
		} else if seen[b.ID] {
			add("%s: duplicate id %q", where, b.ID)
		}
		seen[b.ID] = true
		if b.Host == "" {
			add("%s (%s): host is required", where, b.ID)
		}
		if b.Port == 0 {
			b.Port = 1883
			if b.TLS.Enabled {
				b.Port = 8883
			}
		}
		if b.Port < 1 || b.Port > 65535 {
			add("%s (%s): invalid port", where, b.ID)
		}
		switch b.Protocol {
		case "":
			b.Protocol = "v5"
		case "v5", "v311":
		default:
			add("%s (%s): protocol must be v5 or v311", where, b.ID)
		}
		if b.PasswordFile != "" {
			pw, err := os.ReadFile(b.PasswordFile)
			if err != nil {
				add("%s (%s): password_file unreadable", where, b.ID)
			} else {
				b.Password = strings.TrimRight(string(pw), "\r\n")
			}
		}
		if b.TLS.CAFile != "" {
			if _, err := os.Stat(b.TLS.CAFile); err != nil {
				add("%s (%s): tls.ca_file unreadable", where, b.ID)
			}
		}
		if len(b.Topics) == 0 {
			add("%s (%s): at least one topic filter is required", where, b.ID)
		}
		for j, t := range b.Topics {
			if t.Filter == "" || t.QoS > 1 {
				add("%s (%s) topic[%d]: filter required, qos must be 0 or 1", where, b.ID, j)
			}
		}
		if b.ClientID == "" {
			b.ClientID = "meshmap-" + b.ID
		}
	}

	for i, ch := range c.Channels {
		where := fmt.Sprintf("channel[%d] (%s)", i, ch.Name)
		if ch.Name == "" || len(ch.Name) > 64 {
			add("channel[%d]: name required (max 64 bytes)", i)
		}
		if len(ch.PSKs) == 0 {
			add("%s: at least one psk is required", where)
		}
		for _, id := range ch.BrokerIDs {
			if id != "*" && !seen[id] && len(c.Brokers) > 0 {
				add("%s: unknown broker id %q", where, id)
			}
		}
	}
	if _, err := security.NewKeyring(c.SecurityChannels()); err != nil {
		// NewKeyring errors name channel and key label, never key material.
		add("%v", err)
	}
	return errors.Join(errs...)
}

func parseNode(s string) (uint32, bool) {
	var n uint32
	if strings.HasPrefix(s, "!") && len(s) == 9 {
		_, err := fmt.Sscanf(s[1:], "%08x", &n)
		return n, err == nil && n != 0
	}
	_, err := fmt.Sscanf(s, "%d", &n)
	return n, err == nil && n != 0
}

// SecurityChannels converts channel config for the keyring. Plaintext uplinks
// are accepted by default for configured channels (plan amendment 4).
func (c *Config) SecurityChannels() []security.ChannelConfig {
	out := make([]security.ChannelConfig, 0, len(c.Channels))
	for _, ch := range c.Channels {
		mode, _ := security.ParseMode(ch.Mode)
		accept := true
		if ch.AcceptPlaintext != nil {
			accept = *ch.AcceptPlaintext
		}
		out = append(out, security.ChannelConfig{Name: ch.Name, BrokerIDs: ch.BrokerIDs, Mode: mode, PSKs: ch.PSKs, AcceptPlaintext: accept})
	}
	return out
}

// Revision is a digest of everything that changes decoding or derived
// results (channel keys, modes, policy, retention, the key-attempt budget,
// which decides which packets decode when many keys are candidates). It is part of the data
// generation, which is public. Everything else in it is public too, so a plain
// hash would let anyone test guessed keys offline: it is an HMAC keyed with
// the database credentials, a secret every deployment must set (and rotating
// them only makes clients fetch their window again).
func (c *Config) Revision() string {
	key := sha256.Sum256([]byte("meshmap-revision|" + c.Env.DatabaseURL + "|" + c.Env.PGPassword))
	h := hmac.New(sha256.New, key[:])
	for _, ch := range c.Channels {
		// The resolved bool, never the *bool: %v of a pointer prints its
		// address, which differs per process and would churn the generation.
		accept := true
		if ch.AcceptPlaintext != nil {
			accept = *ch.AcceptPlaintext
		}
		fmt.Fprintf(h, "%s|%v|%s|%v|accept_plaintext=%v\n", ch.Name, ch.BrokerIDs, ch.Mode, ch.PSKs, accept)
	}
	fmt.Fprintf(h, "fallback=%v|budget=%d|", c.Env.DefaultKeyFallback, c.Env.KeyAttemptBudget)
	fmt.Fprintf(h, "%s|%d|%d|%v", c.Env.SignaturePolicy, c.Env.RetentionMonths, c.Env.GeolocationMinPrec, c.Env.GeolocationExclude)
	return hex.EncodeToString(h.Sum(nil))[:12]
}

// Summary renders the configuration with all secrets redacted.
func (c *Config) Summary() string {
	var b strings.Builder
	fmt.Fprintf(&b, "retention: %d months; windows default %dh max %dh; live quantum %s\n", c.Env.RetentionMonths, c.Env.DefaultWindowHours, c.Env.MaxWindowHours, c.Env.LiveQuantum)
	fmt.Fprintf(&b, "signature policy: %s; demo mode: %v\n", c.Env.SignaturePolicy, c.Env.DemoMode)
	fmt.Fprintf(&b, "brokers (%d):\n", len(c.Brokers))
	for _, br := range c.Brokers {
		user := "(anonymous)"
		if br.Username != "" {
			user = br.Username + " / password " + redacted(br.Password)
		}
		fmt.Fprintf(&b, "  - %s %s:%d %s tls=%v user=%s retained=%v topics=%d\n", br.ID, br.Host, br.Port, br.Protocol, br.TLS.Enabled, user, br.AcceptRetained, len(br.Topics))
	}
	fmt.Fprintf(&b, "channels (%d):\n", len(c.Channels))
	for _, ch := range c.Channels {
		mode, _ := security.ParseMode(ch.Mode)
		fmt.Fprintf(&b, "  - %s mode=%s keys=%d brokers=%v\n", ch.Name, mode, len(ch.PSKs), ch.BrokerIDs)
	}
	if c.Env.DefaultKeyFallback {
		b.WriteString("other channels: the public default key is tried\n")
	} else {
		b.WriteString("other channels: not decoded (DEFAULT_KEY_FALLBACK=false)\n")
	}
	return b.String()
}

func redacted(s string) string {
	if s == "" {
		return "(none)"
	}
	return "(set)"
}
