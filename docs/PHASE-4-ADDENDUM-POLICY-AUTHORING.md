# Phase 4 Addendum: LLM-Assisted Policy Authoring

## Goal

Two authoring-time LLM features for the policy editor:

1. **Generate from description** — user describes intent in plain English; LLM produces valid
   policy YAML ready to edit and save.
2. **Semantic conflict detection** — after structural conflict checks pass, LLM scans for
   intent-level conflicts across the user's full policy set that structural analysis can't catch.

Both are strictly interactive and dashboard-only. Neither touches the request hot path.

---

## Design Decisions

- **Separate `llm.authoring` config** — independent endpoint/model/key from the runtime configs.
  Authoring is latency-tolerant and benefits from a more capable model; a longer timeout is fine.
- **Generation returns YAML only** — no explanation, no markdown fences, ready to drop into
  the editor. The dashboard validates it immediately via `POST /api/policies/validate`.
- **Semantic conflicts are warnings, never blocking** — shown below the editor alongside
  structural warnings. User can save over them.
- **Semantic conflict check is incremental** — only runs when the user explicitly clicks
  **[Check for conflicts]** or when saving, not on every keystroke. It receives all of the
  user's existing compiled policies plus the new one.
- **Both features are no-ops when `llm.authoring.enabled: false`** — the UI hides the
  Generate button and suppresses semantic conflict results. Structural conflict detection
  always runs regardless.

---

## Config

```yaml
# config.yaml — extends the llm section from PHASE-4-ADDENDUM-LLM.md
llm:
  safety:   { ... }   # from previous addendum
  filters:  { ... }   # from previous addendum

  authoring:
    enabled: false
    endpoint: "https://api.anthropic.com/v1"   # More capable model for authoring
    api_key: "sk-ant-..."                       # Or env: CLAWVISOR_LLM_AUTHORING_API_KEY
    model: "claude-3-5-haiku-20241022"          # Fast + capable; good for structured output
    timeout_seconds: 30                          # User is waiting; longer is fine
```

**Env overrides:**
```
CLAWVISOR_LLM_AUTHORING_ENDPOINT
CLAWVISOR_LLM_AUTHORING_API_KEY
CLAWVISOR_LLM_AUTHORING_MODEL
```

---

## Feature 1: Generate Policy from Description

### API Route

```
POST /api/policies/generate
Auth: user JWT
Body: {
  description: string        // plain English description of intent
  context?: {
    role?: string            // if known, target role for the generated policy
    existing_ids?: string[]  // slugs of existing policies (for naming uniqueness hints)
  }
}
→ 200 { yaml: string }       // raw YAML string, validated server-side before returning
→ 422 { error: string }      // if LLM output fails validation after 2 retries
→ 503 { error: string }      // if llm.authoring is disabled or provider unavailable
```

### Go Implementation

```go
// internal/policy/authoring/generator.go

type Generator struct {
    client *llm.Client
}

func NewGenerator(cfg config.LLMProviderConfig) *Generator {
    return &Generator{client: llm.NewClient(cfg)}
}

type GenerateRequest struct {
    Description string
    Role        string   // optional
    ExistingIDs []string // for uniqueness hints
}

// Generate produces policy YAML from a plain-English description.
// Retries once if the first attempt fails validation.
func (g *Generator) Generate(ctx context.Context, req GenerateRequest) (string, error) {
    messages := []llm.ChatMessage{
        {Role: "system", Content: generatorSystemPrompt},
        {Role: "user",   Content: buildGeneratorUserMessage(req)},
    }

    for attempt := range 2 {
        raw, err := g.client.Complete(ctx, messages)
        if err != nil {
            return "", fmt.Errorf("llm generate: %w", err)
        }
        yaml := cleanYAMLFences(raw)

        // Validate before returning
        if _, err := policy.ParseAndCompile(yaml); err == nil {
            return yaml, nil
        } else if attempt == 0 {
            // Tell the model what went wrong and retry
            messages = append(messages,
                llm.ChatMessage{Role: "assistant", Content: raw},
                llm.ChatMessage{Role: "user", Content: fmt.Sprintf(
                    "The YAML you produced failed validation: %s\nPlease fix it and return only the corrected YAML.", err,
                )},
            )
        }
    }
    return "", fmt.Errorf("generated policy failed validation after 2 attempts")
}

func cleanYAMLFences(s string) string {
    s = strings.TrimSpace(s)
    s = strings.TrimPrefix(s, "```yaml")
    s = strings.TrimPrefix(s, "```")
    s = strings.TrimSuffix(s, "```")
    return strings.TrimSpace(s)
}
```

### Generator Prompt

```go
// internal/policy/authoring/prompts.go

const generatorSystemPrompt = `You are a policy generator for Clawvisor, an AI agent access control gateway.

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

func buildGeneratorUserMessage(req GenerateRequest) string {
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
```

---

## Feature 2: Semantic Conflict Detection

### What It Catches

The structural conflict detector (`conflict.go`) finds mechanical conflicts: same service +
action with opposing `allow` values, or a rule that can never be reached. The LLM check finds
intent-level conflicts that require understanding what the policies mean:

- A policy that allows `gmail.send_message` for the `assistant` role, while another blocks all
  external communication for that same role (different services, same intent)
- A response filter that strips email addresses structurally, while another policy's semantic
  filter is instructed to "include full contact info" — contradictory data minimization intent
- A time-window restriction in one policy that effectively overrides an unconditional allow in
  another for the same role, in a non-obvious way
- Two policies that together grant more access than either individually intends

### API Route

Extends the existing `POST /api/policies/validate` response to include semantic conflicts when
`llm.authoring` is enabled:

```
POST /api/policies/validate
Body: { yaml: string }
→ {
    valid: bool,
    errors: ValidationError[],          // existing: schema errors
    conflicts: StructuralConflict[],    // existing: structural conflicts
    semantic_conflicts: SemanticConflict[] | null  // new: null if authoring LLM disabled
  }
```

`semantic_conflicts` is `null` (not `[]`) when the LLM is disabled, so the UI can distinguish
"no conflicts found" from "check not run".

### New Types

```go
// internal/policy/authoring/conflicts.go

type SemanticConflict struct {
    Description     string   `json:"description"`      // plain English explanation
    AffectedPolicies []string `json:"affected_policies"` // policy slugs involved
    Severity        string   `json:"severity"`          // "warning" | "info"
}

type ConflictChecker struct {
    client *llm.Client
}

func NewConflictChecker(cfg config.LLMProviderConfig) *ConflictChecker {
    return &ConflictChecker{client: llm.NewClient(cfg)}
}

// Check returns semantic conflicts between the incoming policy and existing ones.
// Returns an empty slice (not nil) if no conflicts are found.
func (c *ConflictChecker) Check(
    ctx context.Context,
    incoming *policy.PolicyRecord,
    existing []*policy.PolicyRecord,
) ([]SemanticConflict, error) {
    if len(existing) == 0 {
        return []SemanticConflict{}, nil
    }

    messages := []llm.ChatMessage{
        {Role: "system", Content: conflictSystemPrompt},
        {Role: "user",   Content: buildConflictUserMessage(incoming, existing)},
    }

    raw, err := c.client.Complete(ctx, messages)
    if err != nil {
        return nil, fmt.Errorf("llm conflict check: %w", err)
    }
    return parseConflictResponse(raw)
}

func buildConflictUserMessage(
    incoming *policy.PolicyRecord,
    existing []*policy.PolicyRecord,
) string {
    var sb strings.Builder
    sb.WriteString("New policy being added:\n```yaml\n")
    sb.WriteString(incoming.YAML)
    sb.WriteString("\n```\n\nExisting policies:\n")
    for _, p := range existing {
        sb.WriteString("```yaml\n")
        sb.WriteString(p.YAML)
        sb.WriteString("\n```\n")
    }
    return sb.String()
}

func parseConflictResponse(raw string) ([]SemanticConflict, error) {
    raw = strings.TrimSpace(raw)
    raw = strings.TrimPrefix(raw, "```json")
    raw = strings.TrimPrefix(raw, "```")
    raw = strings.TrimSuffix(raw, "```")
    raw = strings.TrimSpace(raw)

    var out []SemanticConflict
    if err := json.Unmarshal([]byte(raw), &out); err != nil {
        // Non-fatal: return empty rather than surfacing a parse error to the user
        return []SemanticConflict{}, nil
    }
    return out, nil
}
```

### Conflict Detection Prompt

```go
const conflictSystemPrompt = `You are a policy conflict analyzer for Clawvisor, an AI agent access control gateway.

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
```

---

## Dashboard Policy Editor Updates

### Generate Panel

Add a collapsible **"Generate from description"** panel above the YAML editor (collapsed by
default; expanded state remembered in `localStorage`).

```
┌─ Generate from description ────────────────────────────── [▾] ─┐
│                                                                  │
│  [text area: "Allow my assistant to read Gmail but require      │
│   approval for sending. Strip email addresses from results."]   │
│                                                                  │
│  Role (optional): [dropdown: All agents / researcher / ...]     │
│                                                                  │
│  [Generate]                                                      │
└──────────────────────────────────────────────────────────────────┘
```

**Behavior on [Generate]:**
1. `POST /api/policies/generate` with description + role
2. Show spinner in button
3. On success: populate the YAML editor with the result, trigger live validation (same as
   typing). Show a `ℹ︎ AI-generated — review before saving` banner above the editor.
4. On error: show inline error below the button

The generated YAML replaces editor content. If the editor already has content, show a
confirmation dialog: "Replace current policy with generated version?"

### Semantic Conflict Warnings

`POST /api/policies/validate` already runs on debounce. When the response includes
`semantic_conflicts`, render them below the structural conflict warnings with a different
visual treatment:

```
⚠ Rule conflict (structural): rule #2 shadows rule #1 for google.gmail / send_message
🤖 Possible conflict (AI): "gmail-readonly" strips email addresses from all results,
   but this policy instructs the assistant role to include full contact details.
   Affected policies: gmail-readonly, [this policy]
```

- Structural conflicts: `⚠` yellow, blocking on save if error severity
- Semantic conflicts: `🤖` blue/purple, always non-blocking (warnings only)
- If `semantic_conflicts` is `null`: no AI badge shown (LLM not configured)
- If `semantic_conflicts` is `[]`: show nothing

---

## New API Routes

```
# Policy generation (requires llm.authoring.enabled)
POST   /api/policies/generate           Body: {description, context?}  → {yaml: string}
POST   /api/settings/llm/authoring/test → {ok: bool, error?: string}
GET    /api/settings/llm/authoring      → LLMProviderSettings          (extends existing GET)
PUT    /api/settings/llm/authoring      Body: LLMProviderSettings      → LLMProviderSettings
```

`POST /api/policies/validate` is unchanged in signature; response gains `semantic_conflicts`
field.

---

## API Client Update

```typescript
// web/src/api/client.ts

policies: {
  // ... existing ...
  generate: (description: string, context?: PolicyGenerateContext) =>
    post<{yaml: string}>('/api/policies/generate', {description, context}),
},

settings: {
  llm: {
    // ... existing safety + filters ...
    getAuthoring: () => get<LLMProviderSettings>('/api/settings/llm/authoring'),
    updateAuthoring: (s: Partial<LLMProviderSettings>) =>
      put<LLMProviderSettings>('/api/settings/llm/authoring', s),
    testAuthoring: () =>
      post<{ok: boolean, error?: string}>('/api/settings/llm/authoring/test', {}),
  }
}

// New types
interface PolicyGenerateContext {
  role?: string
  existing_ids?: string[]
}

interface ValidationResult {
  valid: boolean
  errors: ValidationError[]
  conflicts: StructuralConflict[]
  semantic_conflicts: SemanticConflict[] | null  // null = LLM not configured
}

interface SemanticConflict {
  description: string
  affected_policies: string[]
  severity: 'warning' | 'info'
}
```

---

## Dashboard Settings Update

The LLM Provider settings page from the previous addendum gains a third panel: **Policy
Authoring**, with the same fields (enabled toggle, endpoint, API key, model, timeout) and a
**[Test Connection]** button.

Updated settings page layout:
```
/dashboard/settings → LLM Provider
  ├── Safety Checker      (runtime, from previous addendum)
  ├── Response Filters    (runtime, from previous addendum)
  └── Policy Authoring    (interactive only)
```

---

## Success Criteria

- [ ] `POST /api/policies/generate` returns valid YAML from a natural language description
- [ ] Generated YAML passes `POST /api/policies/validate` without errors
- [ ] Generator retries once with error feedback on first validation failure
- [ ] `POST /api/policies/validate` returns `semantic_conflicts: []` when no conflicts found and LLM enabled
- [ ] `POST /api/policies/validate` returns `semantic_conflicts: null` when LLM disabled
- [ ] Semantic conflict check identifies a clear intent contradiction across two test policies
- [ ] Dashboard Generate panel populates editor and triggers live validation
- [ ] "Replace current policy?" confirmation shown when editor already has content
- [ ] `ℹ︎ AI-generated` banner shown after generation, dismissed on manual edit
- [ ] Semantic conflict warnings render with `🤖` treatment distinct from structural `⚠`
- [ ] Policy Authoring section appears in LLM settings; test connection works
- [ ] All LLM authoring calls are no-ops (return gracefully) when `llm.authoring.enabled: false`
