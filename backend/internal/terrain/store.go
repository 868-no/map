package terrain

import (
	"context"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Store keeps fetched heights in terrain_height (storage/schema.sql). Terrain
// does not change, so a height is fetched once and kept (D-143).
type Store struct{ Pool *pgxpool.Pool }

func (s *Store) load(ctx context.Context, keys []Key) (map[Key]Height, error) {
	lat, lon := make([]int32, len(keys)), make([]int32, len(keys))
	for i, k := range keys {
		lat[i], lon[i] = k.Lat, k.Lon
	}
	rows, err := s.Pool.Query(ctx, `SELECT t.lat_k, t.lon_k, t.z FROM terrain_height t
		JOIN unnest($1::int[], $2::int[]) AS q(lat_k, lon_k) USING (lat_k, lon_k)`, lat, lon)
	if err != nil {
		return nil, err
	}
	out := map[Key]Height{}
	var k Key
	var z *float32
	_, err = pgx.ForEachRow(rows, []any{&k.Lat, &k.Lon, &z}, func() error {
		if z == nil {
			out[k] = Height{}
		} else {
			out[k] = Height{Z: float64(*z), OK: true}
		}
		return nil
	})
	return out, err
}

// missing is which of keys have no row: never fetched. keys hold no duplicates.
func (s *Store) missing(ctx context.Context, keys []Key) ([]Key, error) {
	lat, lon := make([]int32, len(keys)), make([]int32, len(keys))
	for i, k := range keys {
		lat[i], lon[i] = k.Lat, k.Lon
	}
	rows, err := s.Pool.Query(ctx, `SELECT q.lat_k, q.lon_k FROM unnest($1::int[], $2::int[]) AS q(lat_k, lon_k)
		WHERE NOT EXISTS (SELECT 1 FROM terrain_height t WHERE t.lat_k = q.lat_k AND t.lon_k = q.lon_k)`, lat, lon)
	if err != nil {
		return nil, err
	}
	var out []Key
	var k Key
	_, err = pgx.ForEachRow(rows, []any{&k.Lat, &k.Lon}, func() error {
		out = append(out, k)
		return nil
	})
	return out, err
}

func (s *Store) save(ctx context.Context, hs map[Key]Height) error {
	if len(hs) == 0 {
		return nil
	}
	lat, lon := make([]int32, 0, len(hs)), make([]int32, 0, len(hs))
	z := make([]*float32, 0, len(hs))
	for k, h := range hs {
		lat, lon = append(lat, k.Lat), append(lon, k.Lon)
		if h.OK {
			v := float32(h.Z)
			z = append(z, &v)
		} else {
			z = append(z, nil)
		}
	}
	_, err := s.Pool.Exec(ctx, `INSERT INTO terrain_height (lat_k, lon_k, z)
		SELECT * FROM unnest($1::int[], $2::int[], $3::real[]) ON CONFLICT (lat_k, lon_k) DO UPDATE SET z = EXCLUDED.z`, lat, lon, z)
	return err
}
