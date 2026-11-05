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

// Encoded is the observation's decoded_metadata JSON and its row without the
// id (obsrow.EncodeTail), encoded once: storage writes both, and the live
// stream completes the tail with the committed id rather than encoding the
// row again (D-046). Meta must not change afterwards except through the
// pipeline's takeAlsoVia, which resets the encoding.
func (o *Observation) Encoded() (meta, tail []byte, err error) {
	if o.tail == nil {
		m, err := json.Marshal(o.Meta)
		if err != nil {
			return nil, nil, err
		}
		t, err := obsrow.EncodeTail(RowOf(o, 0, m))
		if err != nil {
			return nil, nil, err
		}
		o.meta, o.tail = m, t
	}
	return o.meta, o.tail, nil
}

// LiveRow is the encoded row for an observation just committed as row id:
// byte for byte what /observations serves for it.
func LiveRow(o *Observation, id int64) (json.RawMessage, error) {
	_, tail, err := o.Encoded()
	if err != nil {
		return nil, err
	}
	return obsrow.WithID(id, tail), nil
}
