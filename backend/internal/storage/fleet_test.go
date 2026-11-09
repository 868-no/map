package storage

import (
	"fmt"
	"slices"
	"testing"
	"time"
)

func preset(name string) uint8 { return uint8(slices.Index(PresetNames, name)+1) << 2 }

// D-198: a node is classified as the engine's fleet.rs does, from what an
// hour's summary holds.
func TestClassify(t *testing.T) {
	var ft factTable
	info := func(role, hw, by string) uint16 {
		return ft.intern(NodeFacts{Info: true, Role: role, Hardware: hw, NodeIDBy: by})
	}
	cases := []struct {
		name string
		k    factsKnown
		h    heardIn
		want [4]string // firmware, hardware, role, preset
	}{
		{"nothing known", factsKnown{}, heardIn{hop: HopWith}, [4]string{Unknown, Unknown, Unknown, Unknown}},
		{"a reported version, cut to its line", factsKnown{info: info("ROUTER", "RAK4631", "key"), firmware: ft.intern(NodeFacts{Firmware: "2.7.15"})}, heardIn{}, [4]string{"2.7", "RAK4631", "ROUTER", Unknown}},
		{"2.10 is its own line", factsKnown{firmware: ft.intern(NodeFacts{Firmware: "2.10.0"})}, heardIn{}, [4]string{"2.10", Unknown, Unknown, Unknown}},
		{"key-derived id", factsKnown{info: info("CLIENT", "HELTEC_V3", "key")}, heardIn{hop: HopWithout}, [4]string{FirmwareKey, "HELTEC_V3", "CLIENT", Unknown}},
		{"hardware id with a key", factsKnown{info: info("CLIENT", "UNSET", "hardware")}, heardIn{}, [4]string{FirmwareHardware, Unknown, "CLIENT", Unknown}},
		{"no key, no hop start", factsKnown{info: info("CLIENT", "T_ECHO", "")}, heardIn{hop: HopWithout}, [4]string{FirmwareNoHopStart, "T_ECHO", "CLIENT", Unknown}},
		{"no key, hop start", factsKnown{info: info("CLIENT", "T_ECHO", "")}, heardIn{hop: HopWith}, [4]string{Unknown, "T_ECHO", "CLIENT", Unknown}},
		{"only map reports: no hop evidence", factsKnown{}, heardIn{hop: HopNone}, [4]string{Unknown, Unknown, Unknown, Unknown}},
		{"a named map report's identity without a NodeInfo", factsKnown{report: ft.intern(NodeFacts{Report: true, ReportRole: "ROUTER_LATE", ReportHardware: "STATION_G2"})}, heardIn{}, [4]string{Unknown, "STATION_G2", "ROUTER_LATE", Unknown}},
		{"a NodeInfo beats a map report", factsKnown{info: info("CLIENT", "TBEAM", ""), report: ft.intern(NodeFacts{Report: true, ReportRole: "ROUTER"})}, heardIn{}, [4]string{Unknown, "TBEAM", "CLIENT", Unknown}},
		{"a proven preset beats channel names", factsKnown{preset: ft.intern(NodeFacts{Preset: "MEDIUM_FAST"})}, heardIn{presets: map[uint8]int16{preset("LONG_FAST") >> 2: 5}}, [4]string{Unknown, Unknown, Unknown, "MEDIUM_FAST"}},
		{"the channel name of most hours", factsKnown{}, heardIn{presets: map[uint8]int16{preset("LONG_FAST") >> 2: 2, preset("NARROW_FAST") >> 2: 3}}, [4]string{Unknown, Unknown, Unknown, "NARROW_FAST"}},
		{"ties go to the first by name", factsKnown{}, heardIn{presets: map[uint8]int16{preset("NARROW_FAST") >> 2: 2, preset("LONG_FAST") >> 2: 2}}, [4]string{Unknown, Unknown, Unknown, "LONG_FAST"}},
	}
	for _, c := range cases {
		fw, hw, role, pre := ft.classify(c.k, c.h)
		if got := [4]string{fw, hw, role, pre}; got != c.want {
			t.Errorf("%s: %v, want %v", c.name, got, c.want)
		}
	}
	n := len(ft.list)
	if ft.intern(NodeFacts{}) != 0 || info("CLIENT", "HELTEC_V3", "key") == 0 || len(ft.list) != n {
		t.Fatal("facts are interned, nothing as 0")
	}
}

// D-198: buckets count each node heard in them with the facts it is known
// by at the bucket's end, the oldest later ones before it said any; radio
// evidence is the bucket's own.
func TestFleetBuckets(t *testing.T) {
	h0 := time.Date(2026, 11, 2, 10, 0, 0, 0, time.UTC)
	th := TrendHours{}
	v27 := th.facts.intern(NodeFacts{Firmware: "2.7.15"})
	v26 := th.facts.intern(NodeFacts{Firmware: "2.6.11"})
	router := th.facts.intern(NodeFacts{Info: true, Role: "ROUTER", Hardware: "RAK4631", NodeIDBy: "hardware"})
	client := th.facts.intern(NodeFacts{Info: true, Role: "CLIENT", Hardware: "RAK4631", NodeIDBy: "key"})
	day := 24 * time.Hour
	th.hours = map[time.Time]*HourSummary{
		// Day 1: node 1 says nothing yet; node 2 runs 2.6, sends without a hop start on LongFast.
		h0: {Nodes: []int64{1, 2}, NodeRadio: []uint8{HopWith, HopWithout | preset("LONG_FAST")}, NodeFacts: []uint16{0, v26}},
		// Day 2: node 1 a router (hardware id); node 2 updated to 2.7 later that day.
		h0.Add(day):               {Nodes: []int64{1, 2}, NodeRadio: []uint8{HopWith, HopWith}, NodeFacts: []uint16{router, 0}},
		h0.Add(day + 5*time.Hour): {Nodes: []int64{2}, NodeRadio: []uint8{HopWith}, NodeFacts: []uint16{v27}},
		// Day 3: node 1 now a client with a key-derived id; node 2 silent but for no facts.
		h0.Add(2 * day):             {Nodes: []int64{1}, NodeRadio: []uint8{HopWith}, NodeFacts: []uint16{client}},
		h0.Add(2*day + time.Hour):   {Nodes: []int64{3}, NodeRadio: []uint8{HopNone}},
		h0.Add(2*day + 2*time.Hour): {Nodes: []int64{1}, NodeRadio: []uint8{HopWith}},
		// Day 4: node 1 states 2.7, which must not be dated back.
		h0.Add(3 * day): {Nodes: []int64{1}, NodeRadio: []uint8{HopWith}, NodeFacts: []uint16{v27}},
	}
	b := th.FleetBuckets("day", time.UTC)
	if len(b) != 4 {
		t.Fatalf("%d buckets: %+v", len(b), b)
	}
	// Day 1: node 1 by its oldest later identity (a router, hardware id: no
	// later version); node 2 on 2.6, LongFast.
	if d := b[0]; d.Nodes != 2 || d.Roles["ROUTER"] != 1 || d.Roles[Unknown] != 1 || d.Firmware[FirmwareHardware] != 1 || d.Firmware["2.6"] != 1 || d.Presets["LONG_FAST"] != 1 || d.Presets[Unknown] != 1 {
		t.Fatalf("day 1: %+v", d)
	}
	// Day 2: node 2's newest by the day's end is 2.7; its LongFast was day 1's, not day 2's.
	if d := b[1]; d.Nodes != 2 || d.Firmware["2.7"] != 1 || d.Firmware["2.6"] != 0 || d.Presets[Unknown] != 2 || d.Hardware["RAK4631"] != 1 {
		t.Fatalf("day 2: %+v", d)
	}
	// Day 3: node 1 a client by then; node 3 heard only through map reports, nothing known.
	if d := b[2]; d.Nodes != 2 || d.Roles["CLIENT"] != 1 || d.Roles["ROUTER"] != 0 || d.Firmware[FirmwareKey] != 1 || d.Firmware[Unknown] != 1 {
		t.Fatalf("day 3: %+v", d)
	}
	if m := th.FleetBuckets("month", time.UTC); len(m) != 1 || m[0].Nodes != 3 || m[0].Roles["CLIENT"] != 1 || m[0].Firmware["2.7"] != 2 {
		t.Fatalf("month: %+v", m)
	}
}

func TestSetNodeRadioAndAlignFacts(t *testing.T) {
	s := HourSummary{Nodes: []int64{0x0a, 0x0b}}
	s.setNodeRadio([]int32{2, 1 + 4*3})
	if s.NodeRadio[0] != HopWith || s.NodeRadio[1]>>2 != 3 {
		t.Fatalf("radio: %v", s.NodeRadio)
	}
	fw := "2.7.15.567b8ea"
	p := "NARROW_FAST"
	said := s.alignFacts([]factRow{{S: 0x0b, FW: &fw, P: &p}, {S: 0x0c, FW: &fw}})
	if len(said) != 1 || said[0].at != 1 || said[0].facts.Firmware != "2.7.15" || said[0].facts.Preset != "NARROW_FAST" {
		t.Fatalf("facts: %+v", said)
	}
	var th TrendHours
	th.setFacts(&s, said)
	if s.NodeFacts[0] != 0 || th.facts.get(s.NodeFacts[1]).Firmware != "2.7.15" {
		t.Fatalf("interned: %v", s.NodeFacts)
	}
	m := HourSummary{Nodes: []int64{1}}
	if m.setNodeRadio([]int32{1, 2}); m.NodeRadio != nil {
		t.Fatal("misaligned radio kept")
	}
	if slices.Contains(PresetNames, "") || !slices.IsSorted(PresetNames) || len(PresetNames) > 63 {
		t.Fatalf("preset names: %v", PresetNames)
	}
}

// Sums are taken from a snapshot without the lock while a refresh replaces
// hours and interns new facts: hours are replaced, never changed, and the
// fact table only grows (run with -race).
func TestSumsRunBesideARefresh(t *testing.T) {
	h0 := time.Date(2026, 11, 2, 0, 0, 0, 0, time.UTC)
	th := TrendHours{hours: map[time.Time]*HourSummary{}}
	// The hour at pos, as read the i-th time: the same nodes, a new version
	// stated each time; under th.mu (setFacts interns).
	hour := func(pos, i int) *HourSummary {
		s := &HourSummary{Nodes: []int64{1, int64(2 + pos%5)}, Gateways: []int64{1}, Packets: 2, Receptions: 3, NodeRadio: []uint8{HopWith, HopWithout}, NodePackets: []uint16{1, 1}, NodeReceptions: []uint16{1, 1}, NodeBattery: []int8{NoBattery, 50}}
		th.setFacts(s, []saidFacts{{1, NodeFacts{Firmware: fmt.Sprintf("2.7.%d", i)}}})
		return s
	}
	th.mu.Lock()
	for pos := range 48 {
		th.hours[h0.Add(time.Duration(pos)*time.Hour)] = hour(pos, pos)
	}
	th.mu.Unlock()
	stop := make(chan struct{})
	refreshed := make(chan struct{})
	go func() {
		defer close(refreshed)
		for i := 48; ; i++ {
			select {
			case <-stop:
				return
			default:
			}
			th.mu.Lock()
			th.hours[h0.Add(time.Duration(i%48)*time.Hour)] = hour(i%48, i)
			th.mu.Unlock()
		}
	}()
	for range 50 {
		if b := th.Buckets("day", time.UTC, ""); len(b) != 2 || b[0].Packets != 48 || b[0].Nodes != 6 {
			t.Fatalf("buckets %+v", b)
		}
		if b, ok := th.NodeBuckets(1, "day", time.UTC); !ok || len(b) != 2 || b[1].HoursHeard != 24 {
			t.Fatalf("node %v %+v", ok, b)
		}
		if b := th.FleetBuckets("day", time.UTC); len(b) != 2 || b[0].Nodes != 6 {
			t.Fatalf("fleet %+v", b)
		}
	}
	close(stop)
	<-refreshed
}
