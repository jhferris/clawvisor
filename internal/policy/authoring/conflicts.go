package authoring

import (
	"context"
	"fmt"

	"github.com/ericlevine/clawvisor/internal/config"
	"github.com/ericlevine/clawvisor/internal/llm"
	"github.com/ericlevine/clawvisor/internal/store"
)

// SemanticConflict describes an intent-level conflict between policies.
type SemanticConflict struct {
	Description      string   `json:"description"`
	AffectedPolicies []string `json:"affected_policies"`
	Severity         string   `json:"severity"` // "warning" | "info"
}

// ConflictChecker detects semantic (intent-level) conflicts between policies.
type ConflictChecker struct {
	cfg config.LLMConfig
}

// NewConflictChecker creates a ConflictChecker backed by the given config.
func NewConflictChecker(cfg config.LLMConfig) *ConflictChecker {
	return &ConflictChecker{cfg: cfg}
}

// Check returns semantic conflicts between the incoming policy and existing ones.
// Returns nil (not []) when the LLM is disabled so callers can distinguish
// "no conflicts found" (empty slice) from "check not run" (nil).
func (c *ConflictChecker) Check(
	ctx context.Context,
	incoming *store.PolicyRecord,
	existing []*store.PolicyRecord,
) ([]SemanticConflict, error) {
	current := c.cfg.Authoring
	if !current.Enabled {
		return nil, nil
	}
	if len(existing) == 0 {
		return []SemanticConflict{}, nil
	}

	client := llm.NewClient(current)
	messages := []llm.ChatMessage{
		{Role: "system", Content: ConflictSystemPrompt},
		{Role: "user", Content: BuildConflictUserMessage(incoming, existing)},
	}

	raw, err := client.Complete(ctx, messages)
	if err != nil {
		return nil, fmt.Errorf("llm conflict check: %w", err)
	}
	return ParseConflictResponse(raw), nil
}

// Enabled reports whether the authoring LLM is configured and enabled.
func (c *ConflictChecker) Enabled() bool {
	return c.cfg.Authoring.Enabled
}
