// Package authoring provides LLM-assisted policy generation and conflict detection.
// Both features are interactive (dashboard only) and no-ops when disabled.
package authoring

import (
	"context"
	"fmt"

	"github.com/ericlevine/clawvisor/internal/config"
	"github.com/ericlevine/clawvisor/internal/llm"
	"github.com/ericlevine/clawvisor/internal/policy"
)

// GenerateRequest carries the inputs for policy generation.
type GenerateRequest struct {
	Description string
	Role        string   // optional target role
	ExistingIDs []string // existing policy slugs (for uniqueness hints)
}

// Generator produces policy YAML from plain-English descriptions.
type Generator struct {
	cfg config.LLMConfig
}

// NewGenerator creates a Generator backed by the given config.
func NewGenerator(cfg config.LLMConfig) *Generator {
	return &Generator{cfg: cfg}
}

// Generate produces validated policy YAML from a plain-English description.
// Returns (yaml, nil) on success, ("", err) if disabled or generation fails.
// Retries once with error feedback if the first attempt fails validation.
func (g *Generator) Generate(ctx context.Context, req GenerateRequest) (string, error) {
	current := g.cfg.Authoring
	if !current.Enabled {
		return "", fmt.Errorf("policy authoring LLM is not enabled")
	}

	client := llm.NewClient(current)
	messages := []llm.ChatMessage{
		{Role: "system", Content: GeneratorSystemPrompt},
		{Role: "user", Content: BuildGeneratorUserMessage(req)},
	}

	for attempt := range 2 {
		raw, err := client.Complete(ctx, messages)
		if err != nil {
			return "", fmt.Errorf("llm generate: %w", err)
		}
		yamlStr := CleanYAMLFences(raw)

		// Validate before returning.
		_, parseErr := policy.Parse([]byte(yamlStr))
		if parseErr == nil {
			return yamlStr, nil
		}
		if attempt == 0 {
			// Tell the model what went wrong and retry once.
			messages = append(messages,
				llm.ChatMessage{Role: "assistant", Content: raw},
				llm.ChatMessage{Role: "user", Content: fmt.Sprintf(
					"The YAML you produced failed validation: %s\nPlease fix it and return only the corrected YAML.", parseErr,
				)},
			)
		}
	}
	return "", fmt.Errorf("generated policy failed validation after 2 attempts")
}

// Enabled reports whether the authoring LLM is configured and enabled.
func (g *Generator) Enabled() bool {
	return g.cfg.Authoring.Enabled
}
