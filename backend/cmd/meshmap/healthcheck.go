package main

import (
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
	cmd := &cobra.Command{
		Use:   "healthcheck",
		Short: "Exit 0 when /health/ready answers (for container health checks)",
		RunE: func(cmd *cobra.Command, _ []string) error {
			c := http.Client{Timeout: 4 * time.Second}
			resp, err := c.Get("http://" + addr + "/health/ready")
			if err != nil {
				return err
			}
			defer resp.Body.Close()
			if resp.StatusCode != http.StatusOK {
				return fmt.Errorf("not ready: HTTP %d", resp.StatusCode)
			}
			return nil
		},
	}
	cmd.Flags().StringVar(&addr, "addr", probeAddr(os.Getenv("HTTP_ADDR")), "backend HTTP address (default from HTTP_ADDR)")
	return cmd
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
