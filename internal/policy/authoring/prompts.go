package authoring

import (
	"encoding/json"
	"strings"

	"github.com/ericlevine/clawvisor/internal/store"
)

// GeneratorSystemPrompt instructs the LLM to produce valid Clawvisor policy YAML.
const GeneratorSystemPrompt = `You are a policy generator for Clawvisor, an AI agent access control gateway.

Generate a Clawvisor policy in YAML based on the user's description.
Return ONLY the raw YAML — no explanation, no markdown fences, no comments unless they add clarity.

## Policy YAML Schema

` + "```yaml" + `
id: unique-slug           # required; lowercase, hyphens only
name: Human-readable name # optional
description: Purpose      # optional
role: role-name           # optional; omit for global policy (applies to all agents)

rules:
  - service: google.gmail             # service ID; use * for any service
    actions: [list_messages]          # action names; use ["*"] for all actions
    allow: true                       # true = allow; false = block
    require_approval: false           # optional; true = always require human approval
    reason: "Why this rule exists"    # optional; shown in audit log
    response_filters:                 # optional; applied to response before agent sees it
      - redact: email_address         # built-in patterns: email_address, phone_number,
                                      #   credit_card, ssn, api_key
      - remove_field: body            # remove a field entirely (dot notation for nested)
      - truncate_field: snippet       # truncate a field
        max_chars: 150
      - semantic: "natural language"  # LLM best-effort filter (label as non-deterministic)
` + "```" + `

## Available Services
- google.gmail     actions: list_messages, get_message, send_message, create_draft, delete_message
- google.calendar  actions: list_events, get_event, create_event, update_event, delete_event
- google.drive     actions: list_files, get_file, create_file, update_file, delete_file
- google.contacts  actions: list_contacts, get_contact, create_contact, update_contact
- github           actions: list_issues, get_issue, create_issue, list_prs, get_pr, create_pr, list_repos

## Precedence Rules
1. block (allow: false) beats everything
2. require_approval beats allow: true
3. default (no matching rule) → approval queue
4. role-targeted rules take precedence over global rules for agents with that role

## Guidelines
- Use specific actions rather than ["*"] unless the description clearly intends broad access
- Prefer require_approval over block for ambiguous cases
- Add response_filters when the description implies data minimization
- Use semantic filters for intent-based filtering; use structural filters for security
- Generate a sensible, unique id slug from the policy name`

// ConflictSystemPrompt instructs the LLM to find intent-level policy conflicts.
const ConflictSystemPrompt = `You are a policy conflict analyzer for Clawvisor, an AI agent access control gateway.

You will receive a new policy being added and the user's existing policies.
Your job is to identify semantic conflicts — cases where the policies interact in ways
that may not match the user's intent, beyond simple mechanical overlaps.

Look for:
1. Contradictory data access intent across policies (e.g., "strip all PII" in one policy
   while another instructs an agent to "include full contact details")
2. Role-level access that is broader or narrower than likely intended when policies combine
3. Response filters from different policies that produce contradictory results for the same agent
4. Allow rules that are effectively negated by block rules in other policies in non-obvious ways
5. Approval requirements that may be accidentally bypassed by a combination of rules

Do NOT flag:
- Expected role-based differences (researcher gets more access than assistant — that's intended)
- The same action appearing in multiple policies with compatible rules
- Structural conflicts already caught by mechanical analysis (same service+action, opposing allow values)

Respond ONLY with a JSON array on a single line, no markdown:
  [{"description": "plain English explanation", "affected_policies": ["slug1", "slug2"], "severity": "warning"}]
  [] if no conflicts found

Severity levels:
- "warning" — likely unintended; user should review
- "info"    — possibly intentional but worth noting`

// BuildGeneratorUserMessage constructs the user message for policy generation.
func BuildGeneratorUserMessage(req GenerateRequest) string {
	var sb strings.Builder
	sb.WriteString("Description: ")
	sb.WriteString(req.Description)
	if req.Role != "" {
		sb.WriteString("\nTarget role: ")
		sb.WriteString(req.Role)
	}
	if len(req.ExistingIDs) > 0 {
		sb.WriteString("\nExisting policy IDs (avoid duplicates): ")
		sb.WriteString(strings.Join(req.ExistingIDs, ", "))
	}
	return sb.String()
}

// BuildConflictUserMessage constructs the user message for conflict detection.
func BuildConflictUserMessage(incoming *store.PolicyRecord, existing []*store.PolicyRecord) string {
	var sb strings.Builder
	sb.WriteString("New policy being added:\n```yaml\n")
	sb.WriteString(incoming.RulesYAML)
	sb.WriteString("\n```\n\nExisting policies:\n")
	for _, p := range existing {
		sb.WriteString("```yaml\n")
		sb.WriteString(p.RulesYAML)
		sb.WriteString("\n```\n")
	}
	return sb.String()
}

// ParseConflictResponse parses the LLM conflict response JSON.
// Returns an empty slice (not nil) on parse error so callers can distinguish
// "no conflicts" from "check not run".
func ParseConflictResponse(raw string) []SemanticConflict {
	raw = strings.TrimSpace(raw)
	raw = strings.TrimPrefix(raw, "```json")
	raw = strings.TrimPrefix(raw, "```")
	raw = strings.TrimSuffix(raw, "```")
	raw = strings.TrimSpace(raw)

	var out []SemanticConflict
	if err := json.Unmarshal([]byte(raw), &out); err != nil {
		return []SemanticConflict{}
	}
	return out
}

// CleanYAMLFences strips markdown code fences from LLM output.
func CleanYAMLFences(s string) string {
	s = strings.TrimSpace(s)
	s = strings.TrimPrefix(s, "```yaml")
	s = strings.TrimPrefix(s, "```")
	s = strings.TrimSuffix(s, "```")
	return strings.TrimSpace(s)
}
