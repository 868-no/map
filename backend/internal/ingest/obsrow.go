package ingest

import (
	"encoding/json"
	"fmt"

	"github.com/868-no/map/internal/obsrow"
)

// rowOf is the ObsRow of an observation stored as row id with the
// decoded_metadata meta.
func rowOf(o *Observation, id int64, meta []byte) obsrow.ObsRow {
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
// pipeline's takeAlsoVia, which resets the encoding. Called by the writer
// (storage.copyRow), which owns the observation until it commits. Its error
// wraps ErrUnencodable, so the row is refused alone rather than retried.
func (o *Observation) Encoded() (meta, tail []byte, err error) {
	if o.tail == nil {
		if o.meta, o.tail, err = o.encode(); err != nil {
			return nil, nil, fmt.Errorf("%w: %w", ErrUnencodable, err)
		}
	}
	return o.meta, o.tail, nil
}

func (o *Observation) encode() (meta, tail []byte, err error) {
	if meta, err = json.Marshal(o.Meta); err != nil {
		return nil, nil, err
	}
	if tail, err = obsrow.EncodeTail(rowOf(o, 0, meta)); err != nil {
		return nil, nil, err
	}
	return meta, tail, nil
}

// LiveRow is the encoded row for an observation just committed as row id:
// byte for byte what /observations serves for it. It reads the encoding
// storage made and never writes the observation (a sink may still hold it);
// without one (a sink that did not encode) it encodes anew.
func LiveRow(o *Observation, id int64) (json.RawMessage, error) {
	tail := o.tail
	if tail == nil {
		var err error
		if _, tail, err = o.encode(); err != nil {
			return nil, err
		}
	}
	return obsrow.WithID(id, tail), nil
}
