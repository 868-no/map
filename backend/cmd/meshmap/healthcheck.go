package main

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"os"
	"time"

	"github.com/spf13/cobra"
)

// healthcheckCmd lets the distroless image run container health checks
// without a shell or curl.
func healthcheckCmd() *cobra.Command {
	var addr string
	var live bool
	cmd := &cobra.Command{
		Use:   "healthcheck",
		Short: "Exit 0 when /health/ready (with --live: /health/live) answers (for container health checks)",
		Long: "Exit 0 when /health/ready answers 200: the database, schema and ingest are fine.\n" +
			"With --live, when /health/live does: the process serves HTTP, whatever its backends.\n" +
			"Swarm replaces a task that turns unhealthy, so the deploy files use --live: a database\n" +
			"outage must not restart the ingest process, whose queue is what absorbs it.",
		RunE: func(cmd *cobra.Command, _ []string) error {
			return probeHealth(cmd.Context(), addr, live)
		},
	}
	cmd.Flags().StringVar(&addr, "addr", probeAddr(os.Getenv("HTTP_ADDR")), "backend HTTP address (default from HTTP_ADDR)")
	cmd.Flags().BoolVar(&live, "live", false, "probe /health/live (process up) instead of /health/ready")
	return cmd
}

// healthPath is the endpoint a probe asks.
func healthPath(live bool) string {
	if live {
		return "/health/live"
	}
	return "/health/ready"
}

func probeHealth(ctx context.Context, addr string, live bool) error {
	c := http.Client{Timeout: 4 * time.Second}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://"+addr+healthPath(live), nil)
	if err != nil {
		return err
	}
	resp, err := c.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("%s: HTTP %d", healthPath(live), resp.StatusCode)
	}
	return nil
}

// probeAddr is where to reach a server listening on listen (HTTP_ADDR,
// default ":8000"): a wildcard host is probed on loopback. Read directly,
// not through config.LoadEnv, so a probe never fails on unrelated settings.
func probeAddr(listen string) string {
	if listen == "" {
		listen = ":8000"
	}
	host, port, err := net.SplitHostPort(listen)
	if err != nil {
		return listen
	}
	if ip := net.ParseIP(host); host == "" || ip != nil && ip.IsUnspecified() {
		host = "127.0.0.1"
	}
	return net.JoinHostPort(host, port)
}
