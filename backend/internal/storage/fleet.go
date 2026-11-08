package storage

import (
	"slices"
	"sort"
	"strings"
	"time"

	"github.com/868-no/map/internal/obsrow"
	"github.com/868-no/map/internal/protocol"
)

// ---- what the nodes run, over everything kept (D-198) ----
//
// The browser counts the window's nodes by firmware, hardware, role and
// preset (D-196, engine fleet.rs); the whole mesh's counts over the retained
// log come from the hourly summaries instead, with the same rules as far as
// an hour's summary can hold them. Per node and hour the summaries keep one
// byte of radio evidence and an index into a table of what the node said
// about itself; a bucket counts each node heard in it with the values it
// had then (classify).

// The low two bits of NodeRadio: whether the node's packets that hour (its
// map reports aside) carried a hop start.
const (
	HopNone    = 0 // it sent only map reports
	HopWithout = 1 // none carried a hop start
	HopWith    = 2 // some did
)

// PresetNames are the presets channel names can stand for, sorted: NodeRadio
// holds 1 + an index into it, and ties between presets go to the first.
var PresetNames = func() []string {
	var out []string
	for _, p := range protocol.Presets {
		if !slices.Contains(out, p[1]) {
			out = append(out, p[1])
		}
	}
	slices.Sort(out)
	return out
}()

// presetChannels and presetChannelPresets are protocol.Presets as two
// arrays for the summary query, names lower case (it compares lower(channel_name)).
var presetChannels, presetChannelPresets = func() (names, presets []string) {
	for _, p := range protocol.Presets {
		names, presets = append(names, strings.ToLower(p[0])), append(presets, p[1])
	}
	return names, presets
}()

// NodeFacts is what one node said about itself in one hour: the newest of
// each kind of evidence that hour.
type NodeFacts struct {
	// Its newest NodeInfo not marked identity_untrusted (§2.4): role,
	// hardware and where its node id comes from ("key": derived from the
	// announced key, firmware 2.8 or later; "hardware": not, while it
	// announces one, 2.7 or earlier; "": no key, D-142).
	Info                     bool
	Role, Hardware, NodeIDBy string
	// Its newest map report naming it (a long or short name): the identity
	// the browser falls back on without a NodeInfo.
	Report                     bool
	ReportRole, ReportHardware string
	// The firmware version (major.minor.patch) of its newest map report
	// stating one, and the preset of its newest map report proving it with
	// a default channel; "" without.
	Firmware, Preset string
}

// factTable interns NodeFacts: nodes say the same few things hour after
// hour, so an hour keeps 2 bytes per node instead of the strings. Index 0 is
// "nothing said". It only grows, by the distinct combinations ever seen (a
// few thousand at most); past 65 535 new ones are dropped as nothing said.
type factTable struct {
	list []NodeFacts
	ix   map[NodeFacts]uint16
}

func (ft *factTable) intern(f NodeFacts) uint16 {
	if f == (NodeFacts{}) {
		return 0
	}
	if ft.ix == nil {
		ft.ix, ft.list = map[NodeFacts]uint16{}, []NodeFacts{{}}
	}
	if i, ok := ft.ix[f]; ok {
		return i
	}
	if len(ft.list) > 65535 {
		return 0
	}
	i := uint16(len(ft.list))
	ft.list = append(ft.list, f)
	ft.ix[f] = i
	return i
}

func (ft *factTable) get(i uint16) NodeFacts {
	if int(i) >= len(ft.list) {
		return NodeFacts{}
	}
	return ft.list[i]
}

// factRow is one node's evidence in an hour as the summary query returns it.
type factRow struct {
	S  int64 `json:"s"`
	NI *struct {
		Role      string `json:"role"`
		HwModel   string `json:"hw_model"`
		PublicKey string `json:"public_key"`
	} `json:"ni"`
	MR *struct {
		Role    string `json:"role"`
		HwModel string `json:"hw_model"`
	} `json:"mr"`
	FW *string `json:"fw"`
	P  *string `json:"p"`
}

// saidFacts is a node's facts, at its index in the hour's Nodes.
type saidFacts struct {
	at    int
	facts NodeFacts
}

// alignFacts turns the query's rows into facts at their node's index in
// Nodes; rows of nodes not in Nodes (none, as both come from the same rows)
// are dropped.
func (s *HourSummary) alignFacts(rows []factRow) []saidFacts {
	out := make([]saidFacts, 0, len(rows))
	for _, r := range rows {
		i, ok := slices.BinarySearch(s.Nodes, r.S)
		if !ok {
			continue
		}
		var f NodeFacts
		if r.NI != nil {
			f.Info, f.Role, f.Hardware = true, r.NI.Role, r.NI.HwModel
			if k := obsrow.KeyID(r.NI.PublicKey); k != nil {
				f.NodeIDBy = "hardware"
				if int64(*k) == r.S {
					f.NodeIDBy = "key"
				}
			}
		}
		if r.MR != nil {
			f.Report, f.ReportRole, f.ReportHardware = true, r.MR.Role, r.MR.HwModel
		}
		if r.FW != nil {
			f.Firmware = obsrow.ShortVersion(*r.FW)
		}
		if r.P != nil {
			f.Preset = *r.P
		}
		out = append(out, saidFacts{i, f})
	}
	return out
}

// setNodeRadio keeps the per-node radio evidence if it aligns with Nodes.
func (s *HourSummary) setNodeRadio(radio []int32) {
	if len(radio) != len(s.Nodes) {
		return
	}
	s.NodeRadio = make([]uint8, len(radio))
	for i, v := range radio {
		s.NodeRadio[i] = uint8(min(max(v, 0), 255))
	}
}

// setFacts interns an hour's facts into NodeFacts; under t.mu.
func (t *TrendHours) setFacts(s *HourSummary, said []saidFacts) {
	if len(said) == 0 {
		return
	}
	s.NodeFacts = make([]uint16, len(s.Nodes))
	for _, f := range said {
		s.NodeFacts[f.at] = t.facts.intern(f.facts)
	}
}

// Unknown is the value of a node nothing tells, in every dimension.
const Unknown = "unknown"

// Inferred firmware generations, newest first (as the engine's fleet.rs).
const (
	FirmwareKey        = "key"          // node id derived from its key: 2.8 or later
	FirmwareHardware   = "hardware"     // node id from its hardware while it announces a key: 2.7 or earlier
	FirmwareNoHopStart = "no_hop_start" // none of its packets carry a hop start: before 2.3
)

// FleetBucket is one day, week or month of nodes by what they run: per
// dimension, nodes per value. Firmware values are major.minor lines
// ("2.7"), the inferred generations or Unknown; the others are protobuf enum
// names or Unknown.
type FleetBucket struct {
	Start                              time.Time
	Nodes                              int
	Firmware, Hardware, Roles, Presets map[string]int
}

// factsKnown is the newest fact index of each kind for a node.
type factsKnown struct{ info, report, firmware, preset uint16 }

func (k *factsKnown) see(i uint16, f NodeFacts, newest bool) {
	set := func(p *uint16, has bool) {
		if has && (newest || *p == 0) {
			*p = i
		}
	}
	set(&k.info, f.Info)
	set(&k.report, f.Report)
	set(&k.firmware, f.Firmware != "")
	set(&k.preset, f.Preset != "")
}

// or is k, with the identities it lacks (NodeInfo, named map report) taken
// from first. A firmware version or proven preset is never taken from a
// later hour: both change, and an upgrade must not be dated back.
func (k factsKnown) or(first factsKnown) factsKnown {
	pick := func(a, b uint16) uint16 {
		if a != 0 {
			return a
		}
		return b
	}
	return factsKnown{pick(k.info, first.info), pick(k.report, first.report), k.firmware, k.preset}
}

// heardIn is a node's radio evidence over a bucket's hours.
type heardIn struct {
	hop     uint8           // the highest of its hours' HopNone, HopWithout, HopWith
	presets map[uint8]int16 // hours per channel-name preset (1 + index)
}

func orUnknown(s string) string {
	if s == "" || s == "UNSET" {
		return Unknown
	}
	return s
}

// majorMinor is "2.7" of "2.7.15".
func majorMinor(v string) string {
	if i := strings.IndexByte(v, '.'); i >= 0 {
		if j := strings.IndexByte(v[i+1:], '.'); j >= 0 {
			return v[:i+1+j]
		}
	}
	return v
}

// classify is a node's firmware, hardware, role and preset in a bucket,
// from the facts it is known by then (k, see FleetBuckets) and its radio
// evidence in the bucket, by the engine's
// rules (fleet.rs) as far as the summaries hold them:
//   - role and hardware from its NodeInfo, else its named map report;
//   - firmware: the major.minor of the version its map report states; else
//     the generation its NodeInfo's key shows; else, when none of its
//     packets in the bucket carried a hop start, before 2.3; else unknown;
//   - preset: its map report's when a default channel proves it; else the
//     preset whose default channel name it was heard on in most of its
//     hours (ties: the first by name); else unknown.
func (ft *factTable) classify(k factsKnown, h heardIn) (firmware, hardware, role, preset string) {
	firmware, hardware, role, preset = Unknown, Unknown, Unknown, Unknown
	switch {
	case k.info != 0:
		f := ft.get(k.info)
		role, hardware = orUnknown(f.Role), orUnknown(f.Hardware)
	case k.report != 0:
		f := ft.get(k.report)
		role, hardware = orUnknown(f.ReportRole), orUnknown(f.ReportHardware)
	}
	switch by := ft.get(k.info).NodeIDBy; {
	case k.firmware != 0:
		firmware = majorMinor(ft.get(k.firmware).Firmware)
	case k.info != 0 && by != "":
		firmware = by
	case h.hop == HopWithout:
		firmware = FirmwareNoHopStart
	}
	if k.preset != 0 {
		preset = ft.get(k.preset).Preset
	} else {
		best, most := uint8(0), int16(0)
		for p, n := range h.presets {
			if n > most || n == most && p < best {
				best, most = p, n
			}
		}
		if best > 0 && int(best) <= len(PresetNames) {
			preset = PresetNames[best-1]
		}
	}
	return firmware, hardware, role, preset
}

// FleetBuckets counts, per day, week or month starting in loc, the nodes
// heard in it (senders, as Buckets counts them) by what they run. A node
// counts with the facts it is known by at the bucket's end: of each kind
// the newest it said up to then. Its identity (NodeInfo, else named map
// report: role, hardware and where its node id comes from), when it said
// none by then, is the oldest it said later: hardware and roles rarely
// change, and a node heard before its first NodeInfo (sent every few
// hours) would otherwise count unknown, most of all at the start of the
// retained log. A firmware version or preset is never taken from later
// (it would date an upgrade back); without one by then, the bucket's own
// radio evidence (hop starts, channel names) decides, as it does for the
// browser's window.
func (t *TrendHours) FleetBuckets(unit string, loc *time.Location) []FleetBucket {
	t.mu.Lock()
	defer t.mu.Unlock()
	hours := make([]time.Time, 0, len(t.hours))
	for h := range t.hours {
		hours = append(hours, h)
	}
	sort.Slice(hours, func(i, j int) bool { return hours[i].Before(hours[j]) })
	// The oldest facts of each kind per node, for the fallback.
	first := map[int64]*factsKnown{}
	for _, h := range hours {
		s := t.hours[h]
		for i, fi := range s.NodeFacts {
			if fi == 0 || i >= len(s.Nodes) {
				continue
			}
			k := first[s.Nodes[i]]
			if k == nil {
				k = &factsKnown{}
				first[s.Nodes[i]] = k
			}
			k.see(fi, t.facts.get(fi), false)
		}
	}
	latest := map[int64]*factsKnown{}
	var out []FleetBucket
	var heard map[int64]*heardIn
	var cur time.Time
	flush := func() {
		if heard == nil {
			return
		}
		b := FleetBucket{Start: cur, Nodes: len(heard), Firmware: map[string]int{}, Hardware: map[string]int{}, Roles: map[string]int{}, Presets: map[string]int{}}
		for n, hi := range heard {
			k := factsKnown{}
			if l := latest[n]; l != nil {
				k = *l
			}
			if f := first[n]; f != nil {
				k = k.or(*f)
			}
			fw, hw, role, pre := t.facts.classify(k, *hi)
			b.Firmware[fw]++
			b.Hardware[hw]++
			b.Roles[role]++
			b.Presets[pre]++
		}
		out = append(out, b)
	}
	for _, h := range hours {
		if k := bucketStart(h, unit, loc); heard == nil || !k.Equal(cur) {
			flush()
			cur, heard = k, map[int64]*heardIn{}
		}
		s := t.hours[h]
		for i, n := range s.Nodes {
			hi := heard[n]
			if hi == nil {
				hi = &heardIn{}
				heard[n] = hi
			}
			if i < len(s.NodeRadio) {
				r := s.NodeRadio[i]
				hi.hop = max(hi.hop, r&3)
				if p := r >> 2; p > 0 {
					if hi.presets == nil {
						hi.presets = map[uint8]int16{}
					}
					hi.presets[p]++
				}
			}
			if i < len(s.NodeFacts) && s.NodeFacts[i] != 0 {
				l := latest[n]
				if l == nil {
					l = &factsKnown{}
					latest[n] = l
				}
				l.see(s.NodeFacts[i], t.facts.get(s.NodeFacts[i]), true)
			}
		}
	}
	flush()
	return out
}
