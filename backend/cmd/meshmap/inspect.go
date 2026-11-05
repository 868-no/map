package main

import (
	"bufio"
	"encoding/hex"
	"fmt"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/868-no/map/internal/ingest"
	"github.com/868-no/map/internal/security"
)

// memIDs is an identity index held in memory (inspect, seed).
type memIDs map[uint32]security.Identity

func (m memIDs) Lookup(n uint32) (security.Identity, bool) { id, ok := m[n]; return id, ok }

// inspectCmd replays a mosquitto_sub capture (-F '%U|%r|%t|%x') through the
// production ingest.Process without a database, for protocol diagnostics.
func inspectCmd() *cobra.Command {
	var channels []string
	var twoPass bool
	cmd := &cobra.Command{
		Use:   "inspect CAPTURE",
		Short: "Run a captured MQTT stream through decode/decrypt/verify and print statistics",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			var chs []security.ChannelConfig
			for _, c := range channels {
				name, psk, ok := strings.Cut(c, "=")
				if !ok {
					return fmt.Errorf("--channel wants NAME=PSK, got %q", c)
				}
				chs = append(chs, security.ChannelConfig{Name: name, PSKs: []string{psk}, AcceptPlaintext: true})
			}
			kr, err := security.NewKeyring(chs)
			if err != nil {
				return err
			}
			kr.DefaultFallback = true // like serve's default
			store := memIDs{}
			o := ingest.Options{Keyring: kr, Identities: store, KeyBudget: 4, AcceptRetained: func(string) bool { return false }}
			if twoPass {
				// Ground-truth mode: learn identities from the whole capture first.
				if err := replay(args[0], o, store, map[string]int{}); err != nil {
					return err
				}
			}
			stats := map[string]int{}
			if err := replay(args[0], o, store, stats); err != nil {
				return err
			}
			keys := make([]string, 0, len(stats))
			for k := range stats {
				keys = append(keys, k)
			}
			sort.Strings(keys)
			for _, k := range keys {
				fmt.Printf("%6d  %s\n", stats[k], k)
			}
			fmt.Printf("identities learned: %d\n", len(store))
			return nil
		},
	}
	cmd.Flags().StringArrayVar(&channels, "channel", []string{"LongFast=AQ==", "NarrowFast=AQ=="}, "channel NAME=PSK (repeatable)")
	cmd.Flags().BoolVar(&twoPass, "two-pass", false, "learn identities from the whole capture before verifying (offline ground truth only)")
	return cmd
}

func replay(path string, o ingest.Options, store memIDs, stats map[string]int) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 1<<20), 1<<20)
	for sc.Scan() {
		parts := strings.SplitN(sc.Text(), "|", 4)
		if len(parts) != 4 {
			stats["line_malformed"]++
			continue
		}
		ts, _ := strconv.ParseFloat(parts[0], 64)
		raw, err := hex.DecodeString(parts[3])
		if err != nil {
			stats["line_malformed"]++
			continue
		}
		obs, err := ingest.Process(ingest.RawMessage{BrokerID: "capture", Topic: parts[2], Payload: raw, Retained: parts[1] == "1",
			ObservedAt: time.Unix(int64(ts), int64((ts-float64(int64(ts)))*1e9))}, o)
		if err != nil {
			stats["reject "+ingest.Category(err)]++
			continue
		}
		stats[fmt.Sprintf("ok %-12s sig=%-14s %s", obs.PacketType, obs.SignatureStatus, obs.Meta.Crypto)]++
		if obs.Promote != nil {
			store[obs.Promote.Node] = *obs.Promote
		}
	}
	return sc.Err()
}
