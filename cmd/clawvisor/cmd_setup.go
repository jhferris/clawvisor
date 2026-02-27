package main

import (
	"fmt"
	"os"

	"github.com/clawvisor/clawvisor/internal/setup"
	"github.com/spf13/cobra"
)

var setupCmd = &cobra.Command{
	Use:   "setup",
	Short: "Run the first-time setup wizard",
	RunE: func(cmd *cobra.Command, args []string) error {
		if err := setup.Run(); err != nil {
			return fmt.Errorf("setup failed: %w", err)
		}
		fmt.Fprintln(os.Stderr)
		return nil
	},
}
