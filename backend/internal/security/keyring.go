package security

import "slices"

// ChannelConfig is one configured channel with one or more PSKs (current
// key first, then historical keys kept for rotation).
type ChannelConfig struct {
	Name            string
	BrokerIDs       []string // "*" or empty = all brokers
	Mode            Mode
	PSKs            []string
	AcceptPlaintext bool // accept gateway-uplinked decoded packets on this channel
}

// Keyring selects candidate keys for a packet. The channel hash is only a
// weak hint: it orders and filters candidates, it authenticates nothing.
type Keyring struct {
	keys      []Key
	brokers   [][]string // parallel to keys
	plaintext map[string][]string
}

// NewKeyring resolves all configured PSKs, failing on any invalid entry.
func NewKeyring(chs []ChannelConfig) (*Keyring, error) {
	kr := &Keyring{plaintext: map[string][]string{}}
	for _, ch := range chs {
		for i, psk := range ch.PSKs {
			k, err := NewKey(ch.Name, labelFor(ch.Name, i), psk, ch.Mode)
			if err != nil {
				return nil, err
			}
			kr.keys = append(kr.keys, k)
			kr.brokers = append(kr.brokers, ch.BrokerIDs)
		}
		if ch.AcceptPlaintext {
			kr.plaintext[ch.Name] = ch.BrokerIDs
		}
	}
	return kr, nil
}

func labelFor(name string, i int) string {
	if i == 0 {
		return name + "#current"
	}
	return name + "#prev" + string(rune('0'+min(i, 9)))
}

func brokerAllowed(list []string, broker string) bool {
	return len(list) == 0 || slices.Contains(list, "*") || slices.Contains(list, broker)
}

// Candidates returns keys whose channel hash matches, those whose channel
// name equals the topic's channel first, capped at budget.
func (kr *Keyring) Candidates(broker, topicChannel string, hash uint8, budget int) []Key {
	var named, other []Key
	for i, k := range kr.keys {
		if k.hash != hash || !brokerAllowed(kr.brokers[i], broker) {
			continue
		}
		if k.Channel == topicChannel {
			named = append(named, k)
		} else {
			other = append(other, k)
		}
	}
	out := append(named, other...)
	if len(out) > budget {
		out = out[:budget]
	}
	return out
}

// AcceptsPlaintext reports whether decoded uplinks are accepted for a channel.
func (kr *Keyring) AcceptsPlaintext(broker, channel string) bool {
	list, ok := kr.plaintext[channel]
	return ok && brokerAllowed(list, broker)
}

// Len is the number of resolved keys.
func (kr *Keyring) Len() int { return len(kr.keys) }
