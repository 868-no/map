package weather

import (
	"context"
	"math"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Store keeps fetched hours in weather_hour (storage/schema.sql), so a
// restart or another API process never fetches an hour again (D-133).
type Store struct{ Pool *pgxpool.Pool }

// stored is one row: an hour, whether the archive lacked it, and when it was asked.
type stored struct {
	h       Hour
	missing bool
	fetched time.Time
}

func (s *Store) load(ctx context.Context, cell Cell, from, to time.Time) ([]stored, error) {
	rows, err := s.Pool.Query(ctx, `SELECT valid_at, temp_c, precip_mm, humidity_pct, cloud_pct, wind_ms, gust_ms, missing, fetched_at FROM weather_hour
		WHERE cell_x = $1 AND cell_y = $2 AND valid_at >= $3 AND valid_at < $4`, cell.X, cell.Y, from, to)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (stored, error) {
		var st stored
		var t, p, hu, cl, w, g *float32
		if err := r.Scan(&st.h.T, &t, &p, &hu, &cl, &w, &g, &st.missing, &st.fetched); err != nil {
			return st, err
		}
		st.h.T = st.h.T.UTC()
		st.h.TempC, st.h.PrecipMM, st.h.HumidityPct, st.h.CloudPct, st.h.WindMS, st.h.GustMS = f64(t), f64(p), f64(hu), f64(cl), f64(w), f64(g)
		return st, nil
	})
}

func (s *Store) save(ctx context.Context, cell Cell, st stored) error {
	h := st.h
	_, err := s.Pool.Exec(ctx, `INSERT INTO weather_hour (cell_x, cell_y, valid_at, temp_c, precip_mm, humidity_pct, cloud_pct, wind_ms, gust_ms, missing, fetched_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
		ON CONFLICT (cell_x, cell_y, valid_at) DO UPDATE
		SET temp_c = EXCLUDED.temp_c, precip_mm = EXCLUDED.precip_mm, humidity_pct = EXCLUDED.humidity_pct, cloud_pct = EXCLUDED.cloud_pct,
			wind_ms = EXCLUDED.wind_ms, gust_ms = EXCLUDED.gust_ms, missing = EXCLUDED.missing, fetched_at = EXCLUDED.fetched_at`,
		cell.X, cell.Y, h.T, h.TempC, h.PrecipMM, h.HumidityPct, h.CloudPct, h.WindMS, h.GustMS, st.missing, st.fetched)
	return err
}

// f64 widens a REAL, rounded back to the two decimals it was stored with.
func f64(v *float32) *float64 {
	if v == nil {
		return nil
	}
	x := math.Round(float64(*v)*100) / 100
	return &x
}
