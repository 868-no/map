// Package weather reads hourly weather at a point from MET Norway (D-133):
// the MET Nordic analysis (a 1 km grid over the Nordic countries, one file
// per hour, archived since 2012) for temperature, precipitation, humidity and
// wind, and the first hours of MEPS forecast runs (2.5 km) for gusts, which
// the analysis lacks. Both are served over OPeNDAP without a key. Only grid
// indices are sent upstream, never a node or visitor.
package weather

import "math"

// grid is a Lambert conformal conic grid on a sphere with one standard
// parallel (lat0), as both MET Norway products use.
type grid struct {
	lat0, lon0 float64 // degrees
	x0, y0     float64 // centre of cell (0, 0), m
	step       float64 // m
	nx, ny     int
	cone, f    float64
	rho0       float64
}

const radius = 6_371_000.0

func newGrid(lat0, lon0, x0, y0, step float64, nx, ny int) *grid {
	p0 := lat0 * math.Pi / 180
	g := &grid{lat0: lat0, lon0: lon0, x0: x0, y0: y0, step: step, nx: nx, ny: ny, cone: math.Sin(p0)}
	g.f = math.Cos(p0) * math.Pow(math.Tan(math.Pi/4+p0/2), g.cone) / g.cone
	g.rho0 = g.rho(lat0)
	return g
}

func (g *grid) rho(lat float64) float64 {
	return radius * g.f / math.Pow(math.Tan(math.Pi/4+lat*math.Pi/360), g.cone)
}

// cell is the cell holding a point, and false outside the grid.
func (g *grid) cell(lat, lon float64) (Cell, bool) {
	if math.IsNaN(lat) || math.IsNaN(lon) || lat <= -89 || lat >= 89 {
		return Cell{}, false
	}
	r, t := g.rho(lat), g.cone*(lon-g.lon0)*math.Pi/180
	x, y := r*math.Sin(t), g.rho0-r*math.Cos(t)
	c := Cell{int(math.Round((x - g.x0) / g.step)), int(math.Round((y - g.y0) / g.step))}
	return c, c.X >= 0 && c.X < g.nx && c.Y >= 0 && c.Y < g.ny
}

// centre is a cell's centre in degrees.
func (g *grid) centre(c Cell) (lat, lon float64) {
	x, y := g.x0+float64(c.X)*g.step, g.rho0-(g.y0+float64(c.Y)*g.step)
	r := math.Hypot(x, y)
	lat = (2*math.Atan(math.Pow(radius*g.f/r, 1/g.cone)) - math.Pi/2) * 180 / math.Pi
	lon = g.lon0 + math.Atan2(x, y)/g.cone*180/math.Pi
	return lat, lon
}

// Cell is a cell of the analysis grid by index.
type Cell struct{ X, Y int }

var (
	// MET Nordic analysis: 1796 × 2321 cells of 1 km (lat_0 = 63°N, lon_0 = 15°E).
	analysis = newGrid(63, 15, -897_442.2, -1_104_322.0, 1000, 1796, 2321)
	// MEPS deterministic runs: 949 × 1069 cells of 2.5 km (lat_0 = 63.3°N, lon_0 = 15°E).
	meps = newGrid(63.3, 15, -1_060_084.0, -1_332_517.9, 2500, 949, 1069)
)

// CellAt is the analysis cell holding a point, and false outside the grid.
func CellAt(lat, lon float64) (Cell, bool) { return analysis.cell(lat, lon) }
