package main

import (
	"fmt"
	"net/http"
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
	cmd.Flags().StringVar(&addr, "addr", "127.0.0.1:8000", "backend HTTP address")
	return cmd
}
