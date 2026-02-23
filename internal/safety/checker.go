// Package safety provides a secondary LLM-based check on formatted adapter results.
// It runs after policy evaluation and before the result is returned to the agent.
// Disabled by default; enabled via config.safety.enabled.
package safety

import (
	"context"

	"github.com/ericlevine/clawvisor/internal/adapters"
	"github.com/ericlevine/clawvisor/internal/gateway"
)

// SafetyResult is returned by a SafetyChecker.
type SafetyResult struct {
	Safe   bool
	Reason string
}

// SafetyChecker evaluates a formatted adapter result for anomalies.
// It receives the SemanticResult after all formatting — never raw API content.
type SafetyChecker interface {
	// Check evaluates the result. Returns Safe=true to allow execution,
	// Safe=false to route to approval. On error, fails safe (treats as unsafe).
	Check(ctx context.Context, userID string, req *gateway.Request, result *adapters.Result) (SafetyResult, error)
}

// NoopChecker always returns safe. Used when safety is disabled.
type NoopChecker struct{}

func (NoopChecker) Check(_ context.Context, _ string, _ *gateway.Request, _ *adapters.Result) (SafetyResult, error) {
	return SafetyResult{Safe: true}, nil
}
