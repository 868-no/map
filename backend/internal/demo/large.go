package demo

import (
	"fmt"
	"hash/crc32"
	"math"
	"math/rand/v2"
	"sort"

	"github.com/868-no/map/internal/protocol/pb"
	"github.com/868-no/map/internal/testutil"
)

// LargeScenario builds a synthetic mesh for benchmarks: n nodes scattered
// over southern Norway, ~gatewayShare of them gateways, ~unpositioned share
// without positions, links to the nearest neighbours within radio range.
func LargeScenario(n int, seed uint64) *Scenario {
	r := rand.New(rand.NewPCG(seed, 0x6c617267))
	s := &Scenario{Links: map[int][]Link{}, index: map[uint32]int{}}
	for i := 0; i < n; i++ {
		lat := 58.5 + r.Float64()*5.5
		lon := 5.5 + r.Float64()*6.5
		node := &Node{
			Long: fmt.Sprintf("Bench node %d", i), Short: fmt.Sprintf("B%03d", i%1000),
			Lat: lat, Lon: lon, Alt: int32(r.IntN(900)),
			SharesPos: r.Float64() > 0.25, Gateway: r.Float64() < 0.08,
			Role: pb.Config_DeviceConfig_CLIENT, HW: pb.HardwareModel_HELTEC_V3,
		}
		if i%4 == 3 {
			node.Num = 0x0b000000 | (crc32.ChecksumIEEE([]byte(node.Long)) & 0x00ffffff)
		} else {
			k := testutil.NewXKey(uint64(100000 + i))
			node.Key = &k
			node.Num = k.NodeNum()
		}
		if _, dup := s.index[node.Num]; dup {
			continue
		}
		s.index[node.Num] = len(s.Nodes)
		s.Nodes = append(s.Nodes, node)
	}
	// Grid index for neighbour search.
	type cell struct{ x, y int }
	grid := map[cell][]int{}
	cellOf := func(nd *Node) cell { return cell{int(nd.Lon / 0.2), int(nd.Lat / 0.1)} }
	for i, nd := range s.Nodes {
		grid[cellOf(nd)] = append(grid[cellOf(nd)], i)
	}
	for i, a := range s.Nodes {
		c := cellOf(a)
		type cand struct {
			j int
			d float64
		}
		var cs []cand
		for dx := -1; dx <= 1; dx++ {
			for dy := -1; dy <= 1; dy++ {
				for _, j := range grid[cell{c.x + dx, c.y + dy}] {
					if j == i {
						continue
					}
					if d := distKm(a.Lat, a.Lon, s.Nodes[j].Lat, s.Nodes[j].Lon); d < 12+float64(a.Alt)/60 {
						cs = append(cs, cand{j, d})
					}
				}
			}
		}
		sort.Slice(cs, func(x, y int) bool { return cs[x].d < cs[y].d })
		if len(cs) > 12 {
			cs = cs[:12]
		}
		for _, c := range cs {
			snr := 12 - 18*math.Log10(c.d+0.5) + (r.Float64()*4 - 2)
			rssi := -60 - 25*math.Log10(c.d+0.5) + (r.Float64()*6 - 3)
			s.Links[i] = append(s.Links[i], Link{Src: i, Dst: c.j, SNR: float32(math.Round(snr*4) / 4), RSSI: int32(math.Round(rssi))})
		}
	}
	return s
}
