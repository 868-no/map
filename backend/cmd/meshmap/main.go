// Command meshmap is the single backend binary: ingest, API, maintenance,
// configuration checks, schema setup and the demo publisher.
package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"github.com/spf13/cobra"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

// run is main without the exit, so its deferred calls run.
func run() error {
	root := &cobra.Command{
		Use:           "meshmap",
		Short:         "868.no Map backend (Meshtastic MQTT mesh map)",
		SilenceUsage:  true,
		SilenceErrors: true,
	}
	root.AddCommand(serveCmd(), checkConfigCmd(), initSchemaCmd(), maintenanceCmd(), demoPublishCmd(), inspectCmd(), healthcheckCmd(), openapiCmd(), seedCmd(), benchCmd(), importEnvelopesCmd(), importPlacesCmd())
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	return root.ExecuteContext(ctx)
}
