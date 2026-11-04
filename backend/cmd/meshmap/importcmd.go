package main

import (
	"context"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/868-no/map/internal/config"
	"github.com/868-no/map/internal/envimport"
	"github.com/868-no/map/internal/identity"
	"github.com/868-no/map/internal/ingest"
	"github.com/868-no/map/internal/observability"
	"github.com/868-no/map/internal/security"
	"github.com/868-no/map/internal/storage"
	"github.com/868-no/map/internal/window"
)

// importEnvelopesCmd loads recorded MQTT history into packet_log (D-137),
// e.g. from Meshstellar's database:
//
//	sqlite3 -readonly -csv meshstellar.db \
//	  "SELECT created_at, hex(payload_data) FROM service_envelopes ORDER BY created_at" |
//	  meshmap import-envelopes --broker no868
func importEnvelopesCmd() *cobra.Command {
	var (
		broker, root, beforeS, afterS string
		dryRun                        bool
		batchSize                     int
	)
	cmd := &cobra.Command{
		Use:   "import-envelopes",
		Short: "Import recorded MQTT envelopes (CSV on stdin: receive time, payload hex) into packet_log",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			ctx := cmd.Context()
			c, err := config.Load()
			if err != nil {
				return fmt.Errorf("invalid configuration:\n%w", err)
			}
			log := observability.NewLogger(c.Env.LogLevel).With("role", "import")
			var b *config.Broker
			for i := range c.Brokers {
				if c.Brokers[i].ID == broker {
					b = &c.Brokers[i]
				}
			}
			if b == nil {
				return fmt.Errorf("--broker %q is not a configured broker: its channel keys and plaintext rules decide how envelopes decode", broker)
			}
			if root == "" {
				if root = subscriptionRoot(b.Topics); root == "" {
					return fmt.Errorf("cannot derive a topic root from broker %q's subscriptions; give --topic-root", broker)
				}
			}
			pool, err := openDB(ctx, c.Env, log, "import", 4)
			if err != nil {
				return err
			}
			defer pool.Close()
			if err := storage.CheckSchema(ctx, pool); err != nil {
				return err
			}
			// Only what retention keeps, and by default only what predates
			// this broker's first live row: the two collectors received the
			// same uploads at slightly different times, which the unique key
			// (observation key, observed_at) would not catch. Rows an import
			// stored do not count, so a re-run after an interruption resumes
			// (D-150).
			after := window.RetentionCutoff(time.Now(), c.Env.RetentionMonths)
			if afterS != "" {
				t, err := time.Parse(time.RFC3339, afterS)
				if err != nil {
					return fmt.Errorf("--after: %w", err)
				}
				if t.After(after) {
					after = t
				}
			}
			var before time.Time
			beforeFrom := "--before"
			if beforeS != "" {
				if before, err = time.Parse(time.RFC3339, beforeS); err != nil {
					return fmt.Errorf("--before: %w", err)
				}
			} else if before, err = envimport.FirstRow(ctx, pool, broker); err != nil {
				return err
			} else if before.IsZero() {
				beforeFrom = "no live rows from this broker"
			} else {
				beforeFrom = "the broker's first live row"
			}
			fmt.Printf("Importing envelopes received before %s (%s).\n", envimport.FormatTime(before), beforeFrom)
			kr, err := security.NewKeyring(c.SecurityChannels())
			if err != nil {
				return err
			}
			kr.DefaultFallback = c.Env.DefaultKeyFallback
			// Known identities verify signed packets; NodeInfo learned along
			// the way is added (first binding wins, as at ingest).
			ids := identity.New(func(ctx context.Context) ([]storage.IdentityRow, error) {
				return storage.VerifiedIdentities(ctx, pool, nil)
			}, log)
			if err := ids.Reload(ctx); err != nil {
				return fmt.Errorf("identities: %w", err)
			}
			roots, err := envimport.GatewayRoots(ctx, pool, broker)
			if err != nil {
				return err
			}
			im := &envimport.Importer{
				Roots:  roots,
				Broker: broker, Root: root, After: after, Before: before, DryRun: dryRun, Batch: batchSize,
				Opts: ingest.Options{Keyring: kr, Identities: ids, Policy: c.Policy, KeyBudget: c.Env.KeyAttemptBudget, AcceptRetained: func(string) bool { return true }},
				IDs:  ids, Pool: pool, Log: log,
			}
			log.Info("importing envelopes", "broker", broker, "topic_root", root, "after", after.UTC().Format(time.RFC3339),
				"before", envimport.FormatTime(before), "dry_run", dryRun)
			err = im.Run(ctx, os.Stdin)
			im.Report(os.Stdout)
			if err == nil && !dryRun && !im.First.IsZero() {
				fmt.Println("Restart the backend so the identity index and caches include the imported history.")
			}
			return err
		},
	}
	cmd.Flags().StringVar(&broker, "broker", "", "configured broker the envelopes came from (required)")
	cmd.Flags().StringVar(&root, "topic-root", "", "topic root for rebuilt topics (default: the broker's single subscription, without /#)")
	cmd.Flags().StringVar(&beforeS, "before", "", "import only envelopes received before this RFC 3339 time (default: the broker's first row collected live, not imported)")
	cmd.Flags().StringVar(&afterS, "after", "", "import only envelopes received after this RFC 3339 time (never before the retention cutoff)")
	cmd.Flags().BoolVar(&dryRun, "dry-run", false, "decode and count only; write nothing")
	cmd.Flags().IntVar(&batchSize, "batch", 1000, "rows per insert")
	_ = cmd.MarkFlagRequired("broker")
	return cmd
}

// subscriptionRoot is the root of a broker's single "<root>/#" subscription.
func subscriptionRoot(subs []config.Subscription) string {
	if len(subs) != 1 {
		return ""
	}
	r, ok := strings.CutSuffix(subs[0].Filter, "/#")
	if !ok || strings.ContainsAny(r, "+#") {
		return ""
	}
	return r
}
