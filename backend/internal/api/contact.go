package api

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"google.golang.org/protobuf/encoding/protowire"
	"google.golang.org/protobuf/proto"

	"github.com/868-no/map/internal/protocol"
	"github.com/868-no/map/internal/protocol/pb"
	"github.com/868-no/map/internal/protocol/ports"
	"github.com/868-no/map/internal/storage"
)

// ---- a node as a contact for the Meshtastic apps (D-213) ----

// contactURLPrefix is where the Meshtastic apps take a shared contact from:
// the Android and Apple apps open it from a QR code or a link, and send the
// radio an add_contact admin message.
const contactURLPrefix = "https://meshtastic.org/v/#"

type ContactInput struct {
	ID string `path:"id" doc:"Node id, !xxxxxxxx or decimal" example:"!98644b01"`
}

type ContactBody struct {
	Node       string    `json:"node" example:"!98644b01"`
	URL        string    `json:"url" doc:"A Meshtastic shared-contact link: https://meshtastic.org/v/# and a SharedContact protobuf (admin.proto), base64url without padding"`
	LongName   string    `json:"long_name"`
	ShortName  string    `json:"short_name,omitempty"`
	ObservedAt time.Time `json:"observed_at" doc:"When this service received the NodeInfo it is made from"`
	Signature  string    `json:"signature" enum:"verified,unsigned" doc:"Signature status of that NodeInfo"`
}

type ContactOutput struct {
	CacheControl string `header:"Cache-Control"`
	Body         ContactBody
}

// contact serves a node as a contact to import into a Meshtastic app: from
// its newest NodeInfo with a name and a key (storage.LatestContact). Without
// a key there is none: the apps refuse a keyless contact, since importing
// one would erase the key the radio holds for that node.
func (s *Server) contact(ctx context.Context, in *ContactInput) (*ContactOutput, error) {
	n, ok := protocol.ParseNodeID(in.ID)
	if !ok || !protocol.ValidNode(n) {
		return nil, huma.Error400BadRequest("invalid node id")
	}
	c, err := storage.LatestContact(ctx, s.Pool, n)
	if errors.Is(err, storage.ErrNotFound) {
		return nil, huma.Error404NotFound("no NodeInfo with a name and a public key retained for this node")
	}
	if err != nil {
		return nil, err
	}
	var ni ports.NodeInfo
	if err := json.Unmarshal(c.NodeInfo, &ni); err != nil {
		return nil, err
	}
	url, err := contactURL(n, ni)
	if err != nil {
		return nil, huma.Error404NotFound(err.Error())
	}
	return &ContactOutput{CacheControl: "public, max-age=60", Body: ContactBody{
		Node: protocol.NodeID(n), URL: url, LongName: ni.LongName, ShortName: ni.ShortName,
		ObservedAt: c.At, Signature: c.Signature,
	}}, nil
}

// contactURL encodes a node as a SharedContact link. It is never marked
// manually verified: this service only passes on what the node announced.
func contactURL(num uint32, ni ports.NodeInfo) (string, error) {
	key, err := base64.StdEncoding.DecodeString(ni.PublicKey)
	if err != nil || len(key) != 32 {
		return "", fmt.Errorf("no usable public key")
	}
	if ni.LongName == "" {
		return "", fmt.Errorf("no name")
	}
	u := &pb.User{
		Id:         protocol.NodeID(num),
		LongName:   ni.LongName,
		ShortName:  ni.ShortName,
		HwModel:    pb.HardwareModel(pb.HardwareModel_value[ni.HwModel]),
		IsLicensed: ni.IsLicensed,
		Role:       pb.Config_DeviceConfig_Role(pb.Config_DeviceConfig_Role_value[ni.Role]),
		PublicKey:  key,
	}
	user, err := proto.Marshal(u)
	if err != nil {
		return "", err
	}
	// SharedContact { uint32 node_num = 1; User user = 2; }: admin.proto is
	// not generated here, and these two fields are all it takes.
	var b []byte
	b = protowire.AppendTag(b, 1, protowire.VarintType)
	b = protowire.AppendVarint(b, uint64(num))
	b = protowire.AppendTag(b, 2, protowire.BytesType)
	b = protowire.AppendBytes(b, user)
	return contactURLPrefix + base64.RawURLEncoding.EncodeToString(b), nil
}
