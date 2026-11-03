package api

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/868-no/map/internal/config"
	"github.com/868-no/map/internal/weather"
)

func TestWeatherEndpoint(t *testing.T) {
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, "air_temperature_2m.air_temperature_2m[1][1][1]\n[0][0], 274.15\nprecipitation_amount.precipitation_amount[1][1][1]\n[0][0], 1.5\n")
	}))
	defer up.Close()
	now := time.Date(2026, 11, 3, 12, 0, 0, 0, time.UTC)
	s := &Server{Env: config.Env{MaxWindowHours: 168, RetentionMonths: 6}, Log: slog.Default(), Now: func() time.Time { return now }}
	s.Weather = weather.New(up.URL, "test")
	s.Weather.Now, s.Weather.Interval = s.Now, time.Millisecond
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go s.Weather.Run(ctx)
	mux := http.NewServeMux()
	s.NewHandler(mux)
	get := func(q string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/weather?"+q, nil))
		return rec
	}
	var rec *httptest.ResponseRecorder
	var b WeatherBody
	for i := 0; i < 100; i++ {
		rec = get("lat=63.42&lon=10.27&start=2026-11-01T00:00:00Z&end=2026-11-01T03:00:00Z")
		if rec.Code != 200 {
			t.Fatal(rec.Code, rec.Body.String())
		}
		b = WeatherBody{}
		if err := json.Unmarshal(rec.Body.Bytes(), &b); err != nil {
			t.Fatal(err)
		}
		if i == 0 && (!b.Incomplete || rec.Header().Get("Cache-Control") != "no-store") {
			t.Fatalf("first answer: %+v %q", b, rec.Header().Get("Cache-Control"))
		}
		if !b.Incomplete {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	if len(b.Hours) != 3 || *b.Hours[0].TempC != 1 || *b.Hours[0].PrecipMM != 1.5 || b.Attribution == "" {
		t.Fatalf("%+v", b)
	}
	if cc := rec.Header().Get("Cache-Control"); cc != "public, max-age=86400" {
		t.Fatalf("settled hours: %q", cc)
	}
	for q, code := range map[string]int{
		"lat=48.85&lon=2.35&start=2026-11-01T00:00:00Z&end=2026-11-01T03:00:00Z":  422, // Paris
		"lat=63.42&lon=10.27&start=2026-10-01T00:00:00Z&end=2026-11-01T03:00:00Z": 400, // too long
		"lat=63.42&lon=10.27&start=2026-11-01T03:00:00Z&end=2026-11-01T00:00:00Z": 400,
		"lat=63.42&lon=10.27&start=2025-01-01T00:00:00Z&end=2025-01-01T03:00:00Z": 400, // before retention
	} {
		if rec := get(q); rec.Code != code {
			t.Errorf("%s: %d, want %d", q, rec.Code, code)
		}
	}
	s2 := &Server{Env: s.Env}
	mux2 := http.NewServeMux()
	s2.NewHandler(mux2)
	rec = httptest.NewRecorder()
	mux2.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/weather?lat=63.42&lon=10.27&start=2026-11-01T00:00:00Z&end=2026-11-01T03:00:00Z", nil))
	if rec.Code != 404 {
		t.Fatalf("disabled: %d", rec.Code)
	}
}
