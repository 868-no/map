// Package obsrow is the row format clients receive: the compact JSON form of
// a packet_log row that /observations serves, the live stream carries and
// packet_log.obs_row stores pre-encoded (D-031, D-046). Storage, query, API
// and ingest all depend on it; it depends on none of them. Type names keep
// their Obs prefix because they name the OpenAPI schemas.
package obsrow

import (
	"bytes"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"hash/crc32"
	"log/slog"
	"math/bits"
	"strconv"
	"sync/atomic"
	"time"
)

// ObsRow is one packet_log row reduced to what the browser needs to derive
// every view itself (D-031). Keys are short because a 7-day window holds
// tens of thousands of rows. Only decoded public RF fields are included:
// never envelope bytes, payload bodies or keys. Of the MQTT topic, only its
// root (`tp`, D-044) is kept.
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
	Invalid   string   `json:"iv,omitempty" doc:"Type invalid: why its content was not kept (sig_invalid, payload_invalid, ...); its sender may be forged"`
	WantAck   bool     `json:"wa,omitempty" doc:"The sender asked for an acknowledgement (D-109)"`
	// Port-specific decoded fields; omitted for types that have none.
	NodeInfo     *ObsNodeInfo     `json:"ni,omitempty"`
	Position     *ObsPosition     `json:"po,omitempty"`
	Telemetry    *ObsTelemetry    `json:"te,omitempty"`
	NeighborInfo *ObsNeighborInfo `json:"nb,omitempty"`
	Traceroute   *ObsTraceroute   `json:"tr,omitempty"`
	MapReport    *ObsMapReport    `json:"mr,omitempty"`
	Routing      *ObsRouting      `json:"rt,omitempty"`
	NodeStatus   *ObsNodeStatus   `json:"ns,omitempty"`
	StoreForward *ObsStoreForward `json:"sf,omitempty"`
}

// ObsNodeStatus is a node's status text (D-103).
type ObsNodeStatus struct {
	Status string `json:"status"`
}

// ObsStoreForward is a store-and-forward message's kind (never its content).
// Rows stored before it was decoded have kind "unknown" (D-103).
type ObsStoreForward struct {
	Kind      string `json:"kind"`
	TextBytes int    `json:"text_bytes,omitempty"`
	Period    uint32 `json:"period,omitempty" doc:"Heartbeat interval, seconds"`
	Messages  uint32 `json:"messages,omitempty" doc:"History: messages it will replay"`
}

// ObsRouting is a routing packet's outcome: an ACK or an error answering the
// packet whose id is RequestID (D-092).
type ObsRouting struct {
	Kind      string `json:"kind" enum:"ack,error,route_request,route_reply"`
	Error     string `json:"error,omitempty" doc:"Firmware Routing.Error name, e.g. NO_RESPONSE"`
	RequestID uint32 `json:"request_id,omitempty" doc:"Packet id of the packet this answers"`
}

// ObsMapReport is what a node's own map report says about itself and its
// radio. Firmware copies the stored modem preset even when the node uses a
// custom modem configuration (use_preset off); only HasDefaultChannel, which
// firmware sets only with use_preset on, confirms the preset is in use.
// FirmwareVersion is the reported version cut to major.minor.patch (the
// build hash dropped), for the Regions panel's firmware breakdown (D-196).
type ObsMapReport struct {
	Region            string `json:"region,omitempty"`
	ModemPreset       string `json:"modem_preset,omitempty"`
	HasDefaultChannel bool   `json:"has_default_channel,omitempty" doc:"the node uses a modem preset, the default frequency slot and a channel with the default name and key"`
	LongName          string `json:"long_name,omitempty"`
	ShortName         string `json:"short_name,omitempty"`
	HwModel           string `json:"hw_model,omitempty"`
	Role              string `json:"role,omitempty"`
	FirmwareVersion   string `json:"firmware_version,omitempty" doc:"The reported firmware version as major.minor.patch, e.g. 2.7.15 (the build hash dropped); absent when the report's version does not start with one"`
}

type ObsNodeInfo struct {
	LongName     string `json:"long_name,omitempty"`
	ShortName    string `json:"short_name,omitempty"`
	HwModel      string `json:"hw_model,omitempty"`
	Role         string `json:"role,omitempty"`
	HasPublicKey bool   `json:"has_public_key,omitempty"`
	// KeyID is the node id firmware 2.8 and later derive from the announced
	// key (CRC-32, as security.KeyBindsNode): equal to the sender's id when
	// the node runs 2.8 or later; on 2.7 and earlier the id comes from the
	// hardware. Equal values from different senders mean a shared key (D-142).
	KeyID     *uint32 `json:"key_id,omitempty"`
	Untrusted bool    `json:"identity_untrusted,omitempty"`
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
	// Environment telemetry (D-099).
	Temp     *float64 `json:"temp,omitempty" doc:"Temperature, °C"`
	Humidity *float64 `json:"humidity,omitempty" doc:"Relative humidity, %"`
	Pressure *float64 `json:"pressure,omitempty" doc:"Barometric pressure, hPa"`
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
	RequestID  uint32     `json:"request_id,omitempty" doc:"A reply: the packet id of the request it answers"`
}

// storedMeta is the subset of decoded_metadata copied into ObsRow.
type storedMeta struct {
	Crypto  string `json:"crypto"`
	Bytes   int    `json:"bytes"`
	NotOK   bool   `json:"not_ok_to_mqtt"`
	Topic   string `json:"topic_root"`
	Invalid string `json:"invalid"`
	WantAck bool   `json:"want_ack"`
	Rx      struct {
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
	Routing      *ObsRouting      `json:"routing"`
	NodeStatus   *ObsNodeStatus   `json:"node_status"`
	StoreForward *ObsStoreForward `json:"store_forward"`
	Other        *struct {
		PortName string `json:"port_name"`
	} `json:"other"`
}

// Version is bumped whenever ObsRow gains or changes fields, or
// New builds them differently. It is part of the generation
// /observations reports, so browsers holding rows in the old format start
// over, and stored encodings of an older version are rebuilt (D-046)
// (2: tp, mr; 3: map report identity and has_default_channel; 4: rt; 5: iv;
// 6: environment telemetry; 7: ns, sf, traceroute request_id; 8: wa;
// 9: ni.key_id; 10: mr.firmware_version).
const Version = 10

// Fields are the packet_log columns an ObsRow carries.
type Fields struct {
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

// New builds the compact row from stored columns and the
// decoded_metadata JSON. The query path and the live stream both use it, so
// a streamed row is identical to the one /observations returns later.
func New(f Fields, meta []byte) ObsRow {
	r := ObsRow{
		ID: f.ID, T: f.At.UnixMilli(), Broker: f.Broker, Gateway: f.Gateway, Source: f.Source, Dest: f.Dest, PacketID: f.PacketID,
		Channel: f.Channel, Type: f.Type, SNR: f.SNR, RSSI: f.RSSI, HopStart: f.HopStart, HopLimit: f.HopLimit, Relay: f.Relay, Sig: f.Sig,
		Logical: hex.EncodeToString(f.Logical[:min(8, len(f.Logical))]), Reception: hex.EncodeToString(f.Reception[:min(8, len(f.Reception))]),
	}
	var m storedMeta
	if err := json.Unmarshal(meta, &m); err != nil {
		badMeta(r.ID, err)
	}
	r.Crypto, r.Bytes, r.DirectRF, r.RxReason, r.NotOK, r.Topic, r.Invalid, r.WantAck = m.Crypto, m.Bytes, m.Rx.DirectRF, m.Rx.Reason, m.NotOK, m.Topic, m.Invalid, m.WantAck
	switch r.Type {
	case "nodeinfo":
		if n := m.NodeInfo; n != nil {
			r.NodeInfo = &ObsNodeInfo{LongName: n.LongName, ShortName: n.ShortName, HwModel: n.HwModel, Role: n.Role,
				HasPublicKey: n.PublicKey != "", KeyID: keyID(n.PublicKey), Untrusted: n.Untrusted}
		}
	case "position":
		r.Position = m.Position
	case "mapreport":
		r.Position = m.Position
		if mr := m.MapReport; mr != nil {
			mr.FirmwareVersion = shortVersion(mr.FirmwareVersion)
			if *mr != (ObsMapReport{}) {
				r.MapReport = mr
			}
		}
	case "telemetry":
		if t := m.Telemetry; t != nil {
			r.Telemetry = t
			switch t.Kind {
			case "device":
			case "environment":
				r.Telemetry = &ObsTelemetry{Kind: t.Kind, Temp: t.Temp, Humidity: t.Humidity, Pressure: t.Pressure}
			default:
				r.Telemetry = &ObsTelemetry{Kind: t.Kind}
			}
		}
	case "neighborinfo":
		r.NeighborInfo = m.NeighborInfo
	case "traceroute":
		r.Traceroute = m.Traceroute
	case "routing":
		r.Routing = m.Routing
	case "node_status":
		r.NodeStatus = m.NodeStatus
	case "store_forward":
		r.StoreForward = m.StoreForward
	case "other":
		// Stored before these apps were decoded (D-103): their type, if not their contents.
		switch o := m.Other; {
		case o != nil && o.PortName == "STORE_FORWARD_APP":
			r.Type, r.StoreForward = "store_forward", &ObsStoreForward{Kind: "unknown"}
		case o != nil && o.PortName == "NODE_STATUS_APP":
			r.Type = "node_status"
		}
	}
	return r
}

const tailHead = `{"i":0,`

// EncodeTail is r's JSON without the leading id: the form stored with each
// packet_log row (obs_row), written before the row has an id (D-046).
func EncodeTail(r ObsRow) ([]byte, error) {
	r.ID = 0
	b, err := json.Marshal(r)
	if err != nil {
		return nil, err
	}
	if !bytes.HasPrefix(b, []byte(tailHead)) {
		return nil, errors.New("obsrow: id is not the first field")
	}
	return b[len(tailHead):], nil
}

// WithID completes a tail from EncodeTail into the row's JSON, byte for byte
// what json.Marshal gives for the row with that id.
func WithID(id int64, tail []byte) []byte {
	return AppendWithID(make([]byte, 0, len(tail)+24), id, tail)
}

// AppendWithID appends WithID(id, tail) to b.
func AppendWithID(b []byte, id int64, tail []byte) []byte {
	b = append(b, `{"i":`...)
	b = strconv.AppendInt(b, id, 10)
	b = append(b, ',')
	return append(b, tail...)
}

// badMetas counts rows whose stored metadata failed to decode; such rows go
// out with the metadata fields missing.
var badMetas atomic.Int64

// BadMetas reports how many rows had undecodable metadata since start.
func BadMetas() int64 { return badMetas.Load() }

// badMeta warns on the 1st, 2nd, 4th, 8th, ... occurrence, so a corrupt or
// changed decoded_metadata shows in the log without flooding it.
func badMeta(id int64, err error) {
	if n := badMetas.Add(1); bits.OnesCount64(uint64(n)) == 1 {
		slog.Default().Warn("stored metadata did not decode; row sent without it", "row", id, "count", n, "err", err)
	}
}

// shortVersion is a firmware version's leading major.minor.patch
// ("2.7.15.567b8ea" gives "2.7.15"), or "" when it does not start with three
// dot-separated numbers of one to four digits: the build hash names the same
// release on every node, and anything else is no version the browser can
// group.
func shortVersion(v string) string {
	end := 0
	for part := range 3 {
		if part > 0 {
			if end >= len(v) || v[end] != '.' {
				return ""
			}
			end++
		}
		start := end
		for end < len(v) && v[end] >= '0' && v[end] <= '9' {
			end++
		}
		if n := end - start; n == 0 || n > 4 {
			return ""
		}
	}
	return v[:end]
}

// keyID is the node id derived from a base64 X25519 key, or nil without a
// valid 32-byte key.
func keyID(b64 string) *uint32 {
	k, err := base64.StdEncoding.DecodeString(b64)
	if err != nil || len(k) != 32 {
		return nil
	}
	id := crc32.ChecksumIEEE(k)
	return &id
}
