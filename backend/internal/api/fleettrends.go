package api

import (
	"cmp"
	"context"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/danielgtaylor/huma/v2"

	"github.com/868-no/map/internal/storage"
)

// ---- what the nodes run, over time (D-198) ----
//
// The Regions panel breaks a region's nodes down by firmware, hardware, role
// and preset over the selected window (D-196); the whole mesh's breakdown
// over everything kept comes from the hourly summaries behind trends, so
// no browser loads months of rows for it.

type FleetTrendsInput struct {
	Bucket string `query:"bucket" enum:"day,week,month" default:"day" doc:"Bucket length"`
	TZ     string `query:"tz" default:"UTC" doc:"IANA time zone the buckets start in, e.g. Europe/Oslo"`
}

type FleetValue struct {
	Name string `json:"name" doc:"A protobuf enum name (hardware model, role, modem preset), a firmware major.minor line (e.g. 2.7) or inferred generation (key, hardware, no_hop_start), or others or unknown"`
	Kind string `json:"kind" enum:"value,others,unknown" doc:"others: the values past the largest few, summed; unknown: nodes nothing tells this of"`
	// Basis is set for firmware values only.
	Basis  string `json:"basis,omitempty" enum:"reported,key,hardware,no_hop_start" doc:"Firmware only: reported, a line the nodes' own map reports state; else the generation inferred from their packets, never a version: key (node id derived from its key, 2.8 or later), hardware (node id from its hardware while it announces a key, 2.7 or earlier), no_hop_start (no hop start in its packets, before 2.3)"`
	Folded int    `json:"folded,omitempty" doc:"others: how many values it sums"`
}

type FleetDimension struct {
	Values []FleetValue `json:"values" doc:"Each bucket's counts follow this order: the largest values over the whole range (firmware: reported lines newest first, then the inferred generations newest first), then others and unknown when any"`
}

type FleetTrendBucket struct {
	Start    time.Time `json:"start" doc:"Bucket start in the requested time zone"`
	Nodes    int       `json:"nodes" doc:"Distinct nodes heard (senders); each dimension's counts sum to it"`
	Firmware []int     `json:"firmware" doc:"Nodes per firmware value, in the order of firmware.values"`
	Hardware []int     `json:"hardware" doc:"Nodes per hardware model, in the order of hardware.values"`
	Role     []int     `json:"role" doc:"Nodes per role, in the order of role.values"`
	Preset   []int     `json:"preset" doc:"Nodes per modem preset, in the order of preset.values"`
}

type FleetTrendsBody struct {
	Bucket   string             `json:"bucket"`
	Since    *time.Time         `json:"since,omitempty" doc:"Oldest retained observation: the first bucket may be partial"`
	Firmware FleetDimension     `json:"firmware"`
	Hardware FleetDimension     `json:"hardware"`
	Role     FleetDimension     `json:"role"`
	Preset   FleetDimension     `json:"preset"`
	Buckets  []FleetTrendBucket `json:"buckets"`
	Computed time.Time          `json:"-"` // for the response cache's expiry
}

type FleetTrendsOutput struct {
	CacheControl string `header:"Cache-Control"`
	Body         FleetTrendsBody
}

// Values kept apart per dimension; the rest are summed as "others". Eight
// colours at most in a chart: firmware keeps five reported lines beside
// the three inferred generations.
const (
	fleetTop         = 8
	fleetTopFirmware = 5
)

const fleetOthers = "others"

var inferredFirmware = []string{storage.FirmwareKey, storage.FirmwareHardware, storage.FirmwareNoHopStart}

// versionNewer orders firmware lines newest first ("2.10" before "2.7").
func versionNewer(a, b string) int {
	pa, pb := strings.Split(a, "."), strings.Split(b, ".")
	for i := 0; i < len(pa) && i < len(pb); i++ {
		x, _ := strconv.Atoi(pa[i])
		y, _ := strconv.Atoi(pb[i])
		if x != y {
			return cmp.Compare(y, x)
		}
	}
	return cmp.Compare(len(pb), len(pa))
}

// foldDimension picks a dimension's values from its per-bucket counts and
// lays every bucket's counts out in their order: the largest values over
// the whole range (most node-buckets first, then by name, firmware lines
// newest first), the rest summed
// as others, unknown last. Firmware keeps its reported lines newest first
// and the inferred generations after them, newest first.
func foldDimension(counts []map[string]int, firmware bool) (FleetDimension, [][]int) {
	total := map[string]int{}
	for _, c := range counts {
		for k, v := range c {
			total[k] += v
		}
	}
	var ranked []string
	for k := range total {
		if k != storage.Unknown && (!firmware || !slices.Contains(inferredFirmware, k)) {
			ranked = append(ranked, k)
		}
	}
	tie := strings.Compare
	if firmware {
		tie = versionNewer // equal counts: the newer line
	}
	slices.SortFunc(ranked, func(a, b string) int { return cmp.Or(cmp.Compare(total[b], total[a]), tie(a, b)) })
	top := fleetTop
	if firmware {
		top = fleetTopFirmware
	}
	if len(ranked) == top+1 {
		top++ // "1 others" would save nothing
	}
	keep, rest := ranked, []string(nil)
	if len(ranked) > top {
		keep, rest = ranked[:top], ranked[top:]
	}
	var d FleetDimension
	index := map[string]int{}
	add := func(v FleetValue, names ...string) {
		for _, n := range names {
			index[n] = len(d.Values)
		}
		d.Values = append(d.Values, v)
	}
	if firmware {
		slices.SortFunc(keep, versionNewer)
	}
	for _, k := range keep {
		v := FleetValue{Name: k, Kind: "value"}
		if firmware {
			v.Basis = "reported"
		}
		add(v, k)
	}
	if len(rest) > 0 {
		add(FleetValue{Name: fleetOthers, Kind: "others", Folded: len(rest)}, rest...)
	}
	if firmware {
		for _, k := range inferredFirmware {
			if total[k] > 0 {
				add(FleetValue{Name: k, Kind: "value", Basis: k}, k)
			}
		}
	}
	if total[storage.Unknown] > 0 {
		add(FleetValue{Name: storage.Unknown, Kind: "unknown"}, storage.Unknown)
	}
	if d.Values == nil {
		d.Values = []FleetValue{}
	}
	out := make([][]int, len(counts))
	for i, c := range counts {
		out[i] = make([]int, len(d.Values))
		for k, v := range c {
			out[i][index[k]] += v
		}
	}
	return d, out
}

// fleetBody lays the summaries' buckets out for the response.
func fleetBody(buckets []storage.FleetBucket) (body FleetTrendsBody) {
	var fw, hw, role, pre []map[string]int
	for _, b := range buckets {
		fw, hw, role, pre = append(fw, b.Firmware), append(hw, b.Hardware), append(role, b.Roles), append(pre, b.Presets)
	}
	var cf, ch, cr, cp [][]int
	body.Firmware, cf = foldDimension(fw, true)
	body.Hardware, ch = foldDimension(hw, false)
	body.Role, cr = foldDimension(role, false)
	body.Preset, cp = foldDimension(pre, false)
	body.Buckets = make([]FleetTrendBucket, len(buckets))
	for i, b := range buckets {
		body.Buckets[i] = FleetTrendBucket{Start: b.Start, Nodes: b.Nodes, Firmware: cf[i], Hardware: ch[i], Role: cr[i], Preset: cp[i]}
	}
	return body
}

func (s *Server) fleetTrends(ctx context.Context, in *FleetTrendsInput) (*FleetTrendsOutput, error) {
	loc, ok := zone(in.TZ)
	if !ok {
		return nil, huma.Error400BadRequest("unknown time zone")
	}
	key := in.Bucket + "|" + in.TZ
	if b, ok := s.fleetTrendsMemo.get(key, s.now()); ok {
		return &FleetTrendsOutput{CacheControl: trendsCC, Body: b}, nil
	}
	fresh, err := s.refreshTrends(ctx)
	if err != nil {
		return nil, err
	}
	body := fleetBody(s.trendHours.FleetBuckets(in.Bucket, loc))
	body.Bucket, body.Since, body.Computed = in.Bucket, s.trendHours.Oldest(), s.now()
	if !fresh {
		// As for /trends: the previous refresh's sums, neither kept nor shared.
		return &FleetTrendsOutput{CacheControl: "no-store", Body: body}, nil
	}
	s.fleetTrendsMemo.put(key, body)
	return &FleetTrendsOutput{CacheControl: trendsCC, Body: body}, nil
}
