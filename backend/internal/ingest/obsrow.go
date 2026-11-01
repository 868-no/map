package ingest

import (
	"encoding/json"

	"github.com/868-no/map/internal/obsrow"
)

// RowOf is the ObsRow of an observation stored as row id with the
// decoded_metadata meta.
func RowOf(o *Observation, id int64, meta []byte) obsrow.ObsRow {
	pid := o.PacketID
	return obsrow.New(obsrow.Fields{
		ID: id, At: o.ObservedAt, Broker: o.BrokerID, Gateway: o.Gateway, Source: o.Source, Dest: o.Destination, PacketID: &pid,
		Channel: o.Channel, Type: o.PacketType, Sig: string(o.SignatureStatus), Logical: o.LogicalKey[:], Reception: o.ObservationKey[:],
		SNR: o.RxSNR, RSSI: o.RxRSSI, Relay: o.RelayHint, HopStart: o.HopStart, HopLimit: o.HopLimit,
	}, meta)
}

// LiveRow is the ObsRow for an observation just committed as row id.
func LiveRow(o *Observation, id int64) *obsrow.ObsRow {
	meta, err := json.Marshal(o.Meta)
	if err != nil {
		return nil
	}
	r := RowOf(o, id, meta)
	return &r
}
