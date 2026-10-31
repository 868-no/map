package demo

import "github.com/868-no/map/internal/security"

// Channels is the keyring configuration matching the simulator.
func Channels() []security.ChannelConfig {
	return []security.ChannelConfig{
		{Name: PublicChannel, BrokerIDs: []string{"*"}, Mode: security.ModeCTR, PSKs: []string{"AQ=="}, AcceptPlaintext: true},
		{Name: PrivateChannel, BrokerIDs: []string{"*"}, Mode: security.ModeCCM, PSKs: []string{PrivatePSK}, AcceptPlaintext: true},
	}
}
