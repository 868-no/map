package ports

import (
	"strings"
	"unicode/utf8"

	"google.golang.org/protobuf/encoding/protowire"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protoreflect"
)

// decode unmarshals a port payload, accepting string fields that are not
// valid UTF-8. Firmware cuts names and status texts to a byte length, often
// mid-character (a name ending in an emoji), and proto3 rejects the whole
// message for it: such a payload is decoded again with each invalid string
// repaired (the broken bytes replaced) instead of dropped as invalid.
func decode(b []byte, m proto.Message) error {
	err := unmarshal.Unmarshal(b, m)
	if err == nil {
		return nil
	}
	fixed, changed := repairUTF8(b, m.ProtoReflect().Descriptor(), 4)
	if !changed {
		return err
	}
	return unmarshal.Unmarshal(fixed, m)
}

// repairUTF8 re-encodes b with the invalid UTF-8 in md's string fields (and
// its submessages', depth levels deep) replaced. It reports false when there
// was nothing to repair or b does not parse.
func repairUTF8(b []byte, md protoreflect.MessageDescriptor, depth int) ([]byte, bool) {
	out := make([]byte, 0, len(b))
	changed := false
	for len(b) > 0 {
		num, typ, n := protowire.ConsumeTag(b)
		if n < 0 {
			return nil, false
		}
		m := protowire.ConsumeFieldValue(num, typ, b[n:])
		if m < 0 {
			return nil, false
		}
		field := b[:n+m]
		b = b[n+m:]
		fd := md.Fields().ByNumber(num)
		if typ != protowire.BytesType || fd == nil {
			out = append(out, field...)
			continue
		}
		v, _ := protowire.ConsumeBytes(field[n:])
		switch {
		case fd.Kind() == protoreflect.StringKind && !utf8.Valid(v):
			v = []byte(strings.ToValidUTF8(string(v), "�"))
		case fd.Kind() == protoreflect.MessageKind && depth > 0:
			sub, ok := repairUTF8(v, fd.Message(), depth-1)
			if !ok {
				out = append(out, field...)
				continue
			}
			v = sub
		default:
			out = append(out, field...)
			continue
		}
		changed = true
		out = protowire.AppendTag(out, num, typ)
		out = protowire.AppendBytes(out, v)
	}
	return out, changed
}
