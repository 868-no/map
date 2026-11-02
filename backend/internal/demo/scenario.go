// Package demo simulates a deterministic Meshtastic mesh and produces
// protocol-correct MQTT envelopes (real encryption, real XEdDSA signatures,
// realistic flood relaying). It feeds the local demo broker only.
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

// Node is one simulated radio.
type Node struct {
	Num       uint32
	Key       *testutil.XKey // nil: legacy node (MAC-derived number, never signs)
	Long      string
	Short     string
	Lat, Lon  float64
	Alt       int32
	SharesPos bool // false: unpositioned (geolocation candidate)
	Gateway   bool // uplinks to MQTT
	Plaintext bool // gateway uplinks decoded packets (discouraged, but real)
	Role      pb.Config_DeviceConfig_Role
	HW        pb.HardwareModel
	Private   bool // also member of the AEAD channel
}

// Link is a directed RF path with its receive quality at Dst.
type Link struct {
	Src, Dst int
	SNR      float32
	RSSI     int32
}

// Scenario is the static mesh: nodes and RF links.
type Scenario struct {
	Nodes []*Node
	Links map[int][]Link // by Src
	index map[uint32]int
}

type site struct {
	name, short string
	lat, lon    float64
	alt         int32
	gateway     bool
	pos         bool
}

// Places around Trondheim and Trøndelag (approximate public coordinates).
var sites = []site{
	{"Trondheim Sentrum", "TRDS", 63.4305, 10.3951, 20, true, true},
	{"Gråkallen", "GRAK", 63.4222, 10.2486, 552, true, true},
	{"Byåsen", "BYAS", 63.4040, 10.3480, 180, false, true},
	{"Heimdal", "HEIM", 63.3500, 10.3586, 140, true, true},
	{"Ranheim", "RANH", 63.4300, 10.5300, 30, false, true},
	{"Malvik", "MALV", 63.4300, 10.6800, 40, false, true},
	{"Stjørdal", "STJO", 63.4700, 10.9170, 15, true, true},
	{"Vassfjellet", "VASS", 63.2860, 10.4200, 710, false, true},
	{"Melhus", "MELH", 63.2850, 10.2780, 50, false, true},
	{"Klæbu", "KLAB", 63.2990, 10.4870, 80, false, true},
	{"Leinstrand", "LEIN", 63.3350, 10.2400, 120, false, false},
	{"Skaun", "SKAU", 63.2900, 10.0600, 150, false, true},
	{"Orkanger", "ORKA", 63.3050, 9.8500, 20, true, true},
	{"Rissa", "RISS", 63.5850, 10.0350, 30, false, true},
	{"Agdenes", "AGDE", 63.6400, 9.7500, 40, false, true},
	{"Lade", "LADE", 63.4450, 10.4450, 15, false, false},
	{"Tiller", "TILL", 63.3600, 10.4100, 130, false, false},
	{"Moholt", "MOHO", 63.4130, 10.4320, 110, false, true},
	{"Hommelvik", "HOMM", 63.4120, 10.7950, 20, false, true},
	{"Støren", "STOR", 63.0330, 10.2860, 70, false, true},
	{"Selbu", "SELB", 63.2180, 11.0400, 160, false, true},
	{"Frosta", "FROS", 63.5850, 10.7400, 50, false, true},
}

// DefaultScenario builds the deterministic demo mesh.
func DefaultScenario() *Scenario {
	r := rand.New(rand.NewPCG(868, 2026))
	s := &Scenario{Links: map[int][]Link{}, index: map[uint32]int{}}
	roles := []pb.Config_DeviceConfig_Role{pb.Config_DeviceConfig_CLIENT, pb.Config_DeviceConfig_CLIENT_MUTE, pb.Config_DeviceConfig_ROUTER}
	hws := []pb.HardwareModel{pb.HardwareModel_HELTEC_V3, pb.HardwareModel_RAK4631, pb.HardwareModel_T_ECHO, pb.HardwareModel_TBEAM, pb.HardwareModel_STATION_G2}
	for i, st := range sites {
		n := &Node{Long: st.name, Short: st.short, Lat: st.lat, Lon: st.lon, Alt: st.alt, SharesPos: st.pos, Gateway: st.gateway,
			Role: roles[r.IntN(len(roles))], HW: hws[r.IntN(len(hws))]}
		if st.alt > 400 {
			n.Role = pb.Config_DeviceConfig_ROUTER
		}
		// Every fourth node runs old firmware: MAC-derived number, unsigned.
		if i%4 == 3 {
			n.Num = 0x0a000000 | (crc32.ChecksumIEEE([]byte(st.name)) & 0x00ffffff)
		} else {
			k := testutil.NewXKey(uint64(1000 + i))
			n.Key = &k
			n.Num = k.NodeNum()
		}
		n.Private = i%3 == 0
		n.Plaintext = st.short == "ORKA"
		s.index[n.Num] = len(s.Nodes)
		s.Nodes = append(s.Nodes, n)
	}
	// Deliberate relay-byte collision: two nodes share the low byte so the
	// relay-hint inference must refuse to guess (design §10.2 test 23).
	s.Nodes[16].Num = (s.Nodes[16].Num &^ 0xff) | (s.Nodes[17].Num & 0xff)
	if s.Nodes[16].Key != nil {
		s.Nodes[16].Key = nil // a legacy node: its number need not match a key
	}
	s.index = map[uint32]int{}
	for i, n := range s.Nodes {
		s.index[n.Num] = i
	}
	for i, a := range s.Nodes {
		for j, b := range s.Nodes {
			if i == j {
				continue
			}
			d := distKm(a.Lat, a.Lon, b.Lat, b.Lon)
			// Range grows with the higher antenna; mountain sites see far.
			rng := 12 + float64(max(a.Alt, b.Alt))/25
			if d > rng {
				continue
			}
			// Asymmetric quality: transmitter height and receiver noise differ.
			snr := 12 - 18*math.Log10(d+0.5) + float64(a.Alt)/200 + (r.Float64()*4 - 2)
			rssi := -60 - 25*math.Log10(d+0.5) + float64(a.Alt)/100 + (r.Float64()*6 - 3)
			if snr < -18 {
				continue
			}
			s.Links[i] = append(s.Links[i], Link{Src: i, Dst: j, SNR: float32(math.Round(snr*4) / 4), RSSI: int32(math.Round(rssi))})
		}
		sort.Slice(s.Links[i], func(x, y int) bool { return s.Links[i][x].Dst < s.Links[i][y].Dst })
	}
	return s
}

func distKm(lat1, lon1, lat2, lon2 float64) float64 {
	const R = 6371.0
	p1, p2 := lat1*math.Pi/180, lat2*math.Pi/180
	dp, dl := (lat2-lat1)*math.Pi/180, (lon2-lon1)*math.Pi/180
	a := math.Sin(dp/2)*math.Sin(dp/2) + math.Cos(p1)*math.Cos(p2)*math.Sin(dl/2)*math.Sin(dl/2)
	return 2 * R * math.Asin(math.Sqrt(a))
}

// Describe summarises the scenario for logs.
func (s *Scenario) Describe() string {
	gw, signed, unpos, links := 0, 0, 0, 0
	for i, n := range s.Nodes {
		if n.Gateway {
			gw++
		}
		if n.Key != nil {
			signed++
		}
		if !n.SharesPos {
			unpos++
		}
		links += len(s.Links[i])
	}
	return fmt.Sprintf("%d nodes (%d signing, %d gateways, %d unpositioned), %d directed RF links", len(s.Nodes), signed, gw, unpos, links)
}
