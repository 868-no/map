package protocol

import (
	"fmt"
	"strconv"
	"strings"
)

// Broadcast is NODENUM_BROADCAST; traceroutes also use it as the placeholder
// for hops the firmware could not identify.
const Broadcast uint32 = 0xFFFFFFFF

// NodeID formats a node number the Meshtastic way: "!%08x".
func NodeID(n uint32) string { return fmt.Sprintf("!%08x", n) }

// ParseNodeID accepts "!xxxxxxxx" (case-insensitive) or a decimal number.
func ParseNodeID(s string) (uint32, bool) {
	s = strings.TrimSpace(s)
	if rest, ok := strings.CutPrefix(s, "!"); ok {
		if len(rest) != 8 {
			return 0, false
		}
		v, err := strconv.ParseUint(rest, 16, 32)
		return uint32(v), err == nil
	}
	v, err := strconv.ParseUint(s, 10, 32)
	return uint32(v), err == nil
}

// ValidNode reports whether n can identify a real node (not 0, not broadcast).
func ValidNode(n uint32) bool { return n != 0 && n != Broadcast }
