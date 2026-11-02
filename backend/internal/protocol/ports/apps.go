package ports

import (
	"strings"

	"github.com/868-no/map/internal/protocol/pb"
)

// NodeStatus is the free-text status a node broadcasts about itself
// (NODE_STATUS_APP, firmware 2.7.20+), sanitised like a name (D-103).
type NodeStatus struct {
	Status string `json:"status"`
}

func decodeNodeStatus(b []byte) (*NodeStatus, error) {
	var m pb.StatusMessage
	if err := unmarshal.Unmarshal(b, &m); err != nil {
		return nil, ErrInvalid
	}
	return &NodeStatus{Status: CleanString(m.GetStatus(), 80)}, nil
}

// StoreForward is a store-and-forward message: what kind it is, never what
// it carries. A replayed text keeps only its size (D-103).
type StoreForward struct {
	Kind      string `json:"kind"` // router_heartbeat, router_text_broadcast, client_history, ...
	TextBytes int    `json:"text_bytes,omitempty"`
	// Heartbeat: seconds between heartbeats. History: messages it will replay.
	Period   uint32 `json:"period,omitempty"`
	Messages uint32 `json:"messages,omitempty"`
}

func decodeStoreForward(b []byte) (*StoreForward, error) {
	var m pb.StoreAndForward
	if err := unmarshal.Unmarshal(b, &m); err != nil {
		return nil, ErrInvalid
	}
	out := &StoreForward{Kind: strings.ToLower(m.GetRr().String())}
	switch v := m.GetVariant().(type) {
	case *pb.StoreAndForward_Text:
		out.TextBytes = len(v.Text)
	case *pb.StoreAndForward_Heartbeat_:
		out.Period = v.Heartbeat.GetPeriod()
	case *pb.StoreAndForward_History_:
		out.Messages = v.History.GetHistoryMessages()
	}
	return out, nil
}
