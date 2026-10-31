package ingest

import (
	"encoding/hex"
	"encoding/json"
	"time"
)

// ObsRow is one packet_log row reduced to what the browser needs to derive
// every view itself (D-031). Keys are short because a 7-day window holds
// tens of thousands of rows. Only decoded public RF fields are included:
// never envelope bytes, payload bodies, keys or MQTT topics.
type ObsRow struct {
	ID        int64    `json:"i"`
	T         int64    `json:"t" doc:"observed_at, Unix milliseconds (floored)"`
	Broker    string   `json:"b"`
	Gateway   *uint32  `json:"g,omitempty"`
	Source    uint32   `json:"s"`
	Dest      *uint32  `json:"d,omitempty"`
	PacketID  *uint32  `json:"p,omitempty"`
	Channel   string   `json:"c,omitempty"`
	Type      string   `json:"y"`
	Logical   string   `json:"l" doc:"logical packet key, first 8 bytes as hex"`
	Reception string   `json:"o" doc:"observation key, first 8 bytes as hex"`
	SNR       *float32 `json:"sn,omitempty"`
	RSSI      *int32   `json:"rs,omitempty"`
	HopStart  *int16   `json:"hs,omitempty"`
	HopLimit  *int16   `json:"hl,omitempty"`
	Relay     *int32   `json:"r,omitempty"`
	Sig       string   `json:"sg"`
	DirectRF  bool     `json:"dr,omitempty"`
	RxReason  string   `json:"rr,omitempty"`
	Crypto    string   `json:"cr,omitempty"`
	Bytes     int      `json:"by,omitempty"`
	NotOK     bool     `json:"nk,omitempty" doc:"sent without OK-to-MQTT and uplinked by another gateway"`
	Topic     string   `json:"tp,omitempty" doc:"MQTT topic root the reception arrived on (before /2/e/...), e.g. msh/EU_868/NO/Trøndelag"`
	// Port-specific decoded fields; omitted for types that have none.
	NodeInfo     *ObsNodeInfo     `json:"ni,omitempty"`
	Position     *ObsPosition     `json:"po,omitempty"`
	Telemetry    *ObsTelemetry    `json:"te,omitempty"`
	NeighborInfo *ObsNeighborInfo `json:"nb,omitempty"`
	Traceroute   *ObsTraceroute   `json:"tr,omitempty"`
	MapReport    *ObsMapReport    `json:"mr,omitempty"`
}

// ObsMapReport is what a node's own map report says about its radio.
type ObsMapReport struct {
	Region      string `json:"region,omitempty"`
	ModemPreset string `json:"modem_preset,omitempty"`
}

type ObsNodeInfo struct {
	LongName     string `json:"long_name,omitempty"`
	ShortName    string `json:"short_name,omitempty"`
	HwModel      string `json:"hw_model,omitempty"`
	Role         string `json:"role,omitempty"`
	HasPublicKey bool   `json:"has_public_key,omitempty"`
	Untrusted    bool   `json:"identity_untrusted,omitempty"`
}

type ObsPosition struct {
	Lat            float64 `json:"lat"`
	Lon            float64 `json:"lon"`
	Alt            *int32  `json:"alt,omitempty"`
	PrecisionBits  uint32  `json:"precision_bits"`
	PrecisionKnown bool    `json:"precision_known"`
}

type ObsTelemetry struct {
	Kind    string   `json:"kind"`
	Battery *float64 `json:"battery,omitempty"`
	Voltage *float64 `json:"voltage,omitempty"`
	ChUtil  *float64 `json:"ch_util,omitempty"`
	AirUtil *float64 `json:"air_util,omitempty"`
	Uptime  *uint32  `json:"uptime,omitempty"`
}

type ObsNeighbor struct {
	ID  uint32   `json:"id"`
	SNR *float64 `json:"snr,omitempty"`
}

type ObsNeighborInfo struct {
	Neighbors []ObsNeighbor `json:"neighbors"`
}

type ObsHop struct {
	ID      uint32 `json:"id"`
	Unknown bool   `json:"unknown,omitempty"`
}

type ObsTraceroute struct {
	Valid      bool       `json:"valid"`
	IsReply    bool       `json:"is_reply"`
	Route      []ObsHop   `json:"route"`
	SNRTowards []*float64 `json:"snr_towards"`
	RouteBack  []ObsHop   `json:"route_back"`
	SNRBack    []*float64 `json:"snr_back"`
}

// storedMeta is the subset of decoded_metadata copied into ObsRow.
type storedMeta struct {
	Crypto string `json:"crypto"`
	Bytes  int    `json:"bytes"`
	NotOK  bool   `json:"not_ok_to_mqtt"`
	Topic  string `json:"topic_root"`
	Rx     struct {
		DirectRF bool   `json:"direct_rf"`
		Reason   string `json:"reason"`
	} `json:"rx"`
	NodeInfo *struct {
		LongName  string `json:"long_name"`
		ShortName string `json:"short_name"`
		HwModel   string `json:"hw_model"`
		Role      string `json:"role"`
		PublicKey string `json:"public_key"`
		Untrusted bool   `json:"identity_untrusted"`
	} `json:"nodeinfo"`
	Position     *ObsPosition     `json:"position"`
	Telemetry    *ObsTelemetry    `json:"telemetry"`
	NeighborInfo *ObsNeighborInfo `json:"neighborinfo"`
	Traceroute   *ObsTraceroute   `json:"traceroute"`
	MapReport    *ObsMapReport    `json:"mapreport"`
}

// ObsRowVersion is bumped whenever ObsRow gains or changes fields. It is part
// of the generation /observations reports, so browsers holding rows in the
// old format start over (2: tp, mr).
const ObsRowVersion = 2

// RowFields are the packet_log columns an ObsRow carries.
type RowFields struct {
	ID                 int64
	At                 time.Time
	Broker             string
	Gateway            *uint32
	Source             uint32
	Dest, PacketID     *uint32
	Channel, Type, Sig string
	Logical, Reception []byte
	SNR                *float32
	RSSI, Relay        *int32
	HopStart, HopLimit *int16
}

// NewObsRow builds the compact row from stored columns and the
// decoded_metadata JSON. The query path and the live stream both use it, so
// a streamed row is identical to the one /observations returns later.
func NewObsRow(f RowFields, meta []byte) ObsRow {
	r := ObsRow{
		ID: f.ID, T: f.At.UnixMilli(), Broker: f.Broker, Gateway: f.Gateway, Source: f.Source, Dest: f.Dest, PacketID: f.PacketID,
		Channel: f.Channel, Type: f.Type, SNR: f.SNR, RSSI: f.RSSI, HopStart: f.HopStart, HopLimit: f.HopLimit, Relay: f.Relay, Sig: f.Sig,
		Logical: hex.EncodeToString(f.Logical[:min(8, len(f.Logical))]), Reception: hex.EncodeToString(f.Reception[:min(8, len(f.Reception))]),
	}
	var m storedMeta
	_ = json.Unmarshal(meta, &m)
	r.Crypto, r.Bytes, r.DirectRF, r.RxReason, r.NotOK, r.Topic = m.Crypto, m.Bytes, m.Rx.DirectRF, m.Rx.Reason, m.NotOK, m.Topic
	switch r.Type {
	case "nodeinfo":
		if n := m.NodeInfo; n != nil {
			r.NodeInfo = &ObsNodeInfo{LongName: n.LongName, ShortName: n.ShortName, HwModel: n.HwModel, Role: n.Role,
				HasPublicKey: n.PublicKey != "", Untrusted: n.Untrusted}
		}
	case "position":
		r.Position = m.Position
	case "mapreport":
		r.Position = m.Position
		if mr := m.MapReport; mr != nil && (mr.Region != "" || mr.ModemPreset != "") {
			r.MapReport = &ObsMapReport{Region: mr.Region, ModemPreset: mr.ModemPreset}
		}
	case "telemetry":
		if t := m.Telemetry; t != nil {
			r.Telemetry = t
			if t.Kind != "device" {
				r.Telemetry = &ObsTelemetry{Kind: t.Kind}
			}
		}
	case "neighborinfo":
		r.NeighborInfo = m.NeighborInfo
	case "traceroute":
		r.Traceroute = m.Traceroute
	}
	return r
}

// LiveRow is the ObsRow for an observation just committed as row id.
func LiveRow(o *Observation, id int64) *ObsRow {
	meta, err := json.Marshal(o.Meta)
	if err != nil {
		return nil
	}
	pid := o.PacketID
	r := NewObsRow(RowFields{
		ID: id, At: o.ObservedAt, Broker: o.BrokerID, Gateway: o.Gateway, Source: o.Source, Dest: o.Destination, PacketID: &pid,
		Channel: o.Channel, Type: o.PacketType, Sig: string(o.SignatureStatus), Logical: o.LogicalKey[:], Reception: o.ObservationKey[:],
		SNR: o.RxSNR, RSSI: o.RxRSSI, Relay: o.RelayHint, HopStart: o.HopStart, HopLimit: o.HopLimit,
	}, meta)
	return &r
}
