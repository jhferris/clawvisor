# Phase 2: Policy Engine

## Goal
Build the policy system: human-readable YAML policies, a compiler that turns them into deterministic rules, a pure evaluation function, and a CRUD API so users can manage policies. No adapter calls yet — this phase ends with a testable engine and a working `/api/policies` API.

---

## Deliverables
- Policy YAML format (defined and documented)
- Go policy parser (`yaml.v3` → `Policy` structs)
- Policy compiler (`Policy` → `CompiledRule[]`, priority-sorted)
- Policy evaluator: pure function `Evaluate(request, rules) → Decision`
- Policy store (DB-backed CRUD, per-user)
- REST API for policy management
- Policy conflict detector (structural, no LLM)
- Unit tests for evaluator covering all precedence cases

---

## Policy YAML Format

```yaml
id: gmail-readonly
name: Gmail read-only access
description: Agent can read emails but not send, delete, or modify them.
# role: researcher   ← optional; omit to apply to all agents regardless of role

rules:
  - service: google.gmail
    actions: [list_messages, get_message]
    allow: true

  - service: google.gmail
    actions: [send_message, delete_message, modify_message]
    allow: false
    reason: "Writing operations require explicit user action"

  - service: google.gmail
    actions: [send_message]
    allow: true
    require_approval: true          # overrides the block above if both match — block wins
    condition:
      type: param_matches
      param: to
      pattern: "^.+@mycompany\\.com$"
    reason: "Allow sending to company addresses with approval"

  - service: google.gmail
    actions: [list_messages]
    allow: true
    time_window:
      days: [mon, tue, wed, thu, fri]
      hours: "08:00-22:00"
      timezone: "America/Los_Angeles"
    response_filters:
      # Structural filters — deterministic, always applied
      - redact: email_address
      - redact: phone_number
      - truncate_field: snippet
        max_chars: 150
      # Semantic filters — LLM best-effort, clearly labeled as such
      - semantic: "exclude newsletters and marketing emails"
```

### Role-Targeted Policy

```yaml
id: researcher-drive-full
name: Researcher — full Drive access
role: researcher    # only applies to agents with this role
rules:
  - service: google.drive
    actions: [get_file]
    allow: true
    response_filters:
      - semantic: "return full document content"

---
id: scheduler-drive-restricted
name: Scheduler — Drive metadata only
role: scheduler
rules:
  - service: google.drive
    actions: [get_file]
    allow: true
    response_filters:
      - remove_field: content
      - semantic: "if this document looks confidential, return only its title and date"
```

**Evaluation with roles:**
- Global policies (no `role` field) always apply to every agent
- Role-targeted policies additionally apply when the requesting agent has that role
- On conflict between a global rule and a role rule: the role rule takes precedence (more specific wins)
- An agent with no role assigned receives global policies only — identical to single-agent behavior

### Policy-Level Fields

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | Yes | Unique slug for the policy |
| `name` | string | No | Human-readable name |
| `description` | string | No | Purpose description |
| `role` | string | No | Role name this policy targets. Omit for global (all agents). |

### Rule Fields

| Field | Type | Required | Description |
|---|---|---|---|
| `service` | string | Yes | Service ID (`google.gmail`, `github`, `*`) |
| `actions` | []string | Yes | Action names or `["*"]` |
| `allow` | bool | Yes* | `true` = allow/approve, `false` = block. *Required unless `require_approval` is set. |
| `require_approval` | bool | No | If true, route to approval queue even if allowed |
| `condition` | object | No | Additional predicate that must be true |
| `time_window` | object | No | Restrict rule to time window |
| `reason` | string | No | Shown in audit log and approval notifications |
| `response_filters` | []object | No | Filters applied to the response before it reaches the agent. See `SEMANTIC-FORMATTING.md`. |

### Response Filter Fields

| Filter type | Fields | Behavior |
|---|---|---|
| `redact: <pattern>` | Built-in: `email_address`, `phone_number`, `credit_card`, `ssn`, `api_key` | Replace matches with `[redacted]` |
| `redact_regex: <pattern>` | `pattern` (regex string) | Redact custom pattern |
| `remove_field: <field>` | Field name (dot notation for nested: `data.body`) | Remove field from response entirely |
| `truncate_field: <field>` | `field`, `max_chars` | Truncate field value to N characters |
| `semantic: "<description>"` | Natural language instruction | LLM-applied best-effort filter; labeled as non-deterministic in audit log |

### Precedence Rules (evaluated in order)
1. **Block beats everything.** Any matching `allow: false` rule blocks the request outright.
2. **Conditions narrow applicability.** A rule with a condition only applies if the condition is met.
3. **`require_approval` beats `allow: true`.** If any matching rule has `require_approval`, route to approval.
4. **Default: seek approval.** If no rule matches, route to approval (not block).
5. **Priority tiebreaker:** more specific rules (with conditions) have higher priority. Explicit `allow:false` gets highest base priority.

### Condition Types (v1)

| Type | Fields | Description |
|---|---|---|
| `param_matches` | `param`, `pattern` (regex) | A request param matches regex |
| `param_not_contains` | `param`, `value` | A request param does not contain value |
| `max_results_under` | `param`, `max` | Numeric param < max |
| `recipient_in_contacts` | _(none)_ | True if the `to` param is in the user's Google Contacts. Pre-resolved by the gateway handler before `Evaluate` is called; result passed via `req.ResolvedConditions["recipient_in_contacts"]`. If contacts adapter is not activated, resolves to `false` and the rule does not match (→ default approve). |

---

## Go Types

```go
// internal/policy/types.go

type Policy struct {
    ID          string  `yaml:"id" json:"id"`
    Name        string  `yaml:"name" json:"name"`
    Description string  `yaml:"description" json:"description"`
    Role        string  `yaml:"role" json:"role"`   // empty = global (all agents)
    Rules       []Rule  `yaml:"rules" json:"rules"`
}

type Rule struct {
    Service         string           `yaml:"service" json:"service"`
    Actions         []string         `yaml:"actions" json:"actions"`
    Allow           *bool            `yaml:"allow" json:"allow"`
    RequireApproval bool             `yaml:"require_approval" json:"require_approval"`
    Condition       *Condition       `yaml:"condition" json:"condition"`
    TimeWindow      *TimeWindow      `yaml:"time_window" json:"time_window"`
    Reason          string           `yaml:"reason" json:"reason"`
    ResponseFilters []ResponseFilter `yaml:"response_filters" json:"response_filters"`
}

type ResponseFilter struct {
    // Exactly one of these fields is set:
    Redact        string `yaml:"redact" json:"redact"`               // built-in pattern name
    RedactRegex   string `yaml:"redact_regex" json:"redact_regex"`   // custom regex
    RemoveField   string `yaml:"remove_field" json:"remove_field"`   // dot-notation field path
    TruncateField string `yaml:"truncate_field" json:"truncate_field"`
    MaxChars      int    `yaml:"max_chars" json:"max_chars"`         // used with truncate_field
    Semantic      string `yaml:"semantic" json:"semantic"`           // LLM instruction (best-effort)
}

func (f ResponseFilter) IsStructural() bool { return f.Semantic == "" }
func (f ResponseFilter) IsSemantic() bool   { return f.Semantic != "" }

type Condition struct {
    Type   string         `yaml:"type" json:"type"`
    Params map[string]any `yaml:",inline" json:",inline"`
}

type TimeWindow struct {
    Days     []string `yaml:"days" json:"days"`
    Hours    string   `yaml:"hours" json:"hours"`
    Timezone string   `yaml:"timezone" json:"timezone"`
}

// Compiled (internal)
type CompiledRule struct {
    ID              string           // "{policyID}:rule-{index}"
    PolicyID        string
    UserID          string
    RoleID          string           // empty = global
    Service         string
    Actions         []string
    Decision        Decision
    Condition       *Condition
    TimeWindow      *TimeWindow
    Reason          string
    ResponseFilters []ResponseFilter
    Priority        int
}

type Decision string
const (
    DecisionExecute Decision = "execute"
    DecisionApprove Decision = "approve"
    DecisionBlock   Decision = "block"
)

type PolicyDecision struct {
    Decision        Decision
    PolicyID        string
    RuleID          string
    Reason          string
    ResponseFilters []ResponseFilter // collected from all matching rules, applied in order
}

// Request passed to the evaluator
type EvalRequest struct {
    Service             string
    Action              string
    Params              map[string]any
    AgentRoleID         string            // empty if agent has no role
    ResolvedConditions  map[string]bool   // pre-resolved async conditions, keyed by condition type
                                          // e.g. {"recipient_in_contacts": true}
                                          // Gateway handler resolves these before calling Evaluate;
                                          // evaluator looks them up without performing any I/O.
    // Time is injected by evaluator (time.Now()) for time_window checks
}
```

---

## Package Structure

```
internal/
└── policy/
    ├── types.go          # All types above
    ├── parser.go         # ParsePolicy(yamlBytes) → Policy, error
    ├── validator.go      # ValidatePolicy(Policy) → []ValidationError
    ├── compiler.go       # Compile([]Policy, userID) → []CompiledRule
    ├── evaluator.go      # Evaluate(EvalRequest, []CompiledRule) → PolicyDecision
    ├── conflict.go       # DetectConflicts(newPolicy, existingRules) → []Conflict
    └── evaluator_test.go # Comprehensive unit tests
```

### Key functions

```go
// parser.go
func Parse(data []byte) (*Policy, error)
func ParseFile(path string) (*Policy, error)

// compiler.go
func Compile(policies []Policy, userID string) []CompiledRule
// Priority scoring:
//   block:   100 + (20 if condition) + (10 if specific actions, not *)
//   approve: 50  + same modifiers
//   execute: 10  + same modifiers

// evaluator.go — pure function, no I/O
func Evaluate(req EvalRequest, rules []CompiledRule) PolicyDecision
// Algorithm:
//   1. Partition rules into: global (RoleID == "") and role-specific (RoleID == req.AgentRoleID)
//   2. For each partition, filter to rules matching service + action + condition + time_window
//      - Condition matching is fully local: async conditions (e.g. recipient_in_contacts) are
//        resolved by the gateway handler before calling Evaluate and passed in
//        req.ResolvedConditions. If a condition type is absent from ResolvedConditions (e.g.
//        contacts not activated), it resolves to false → rule does not match → default approve.
//   3. Role-specific rules take precedence over global rules on conflict
//   4. Combined matched rules: if any is block → return block
//   5. If any is approve → return approve
//   6. If any is execute → return execute (collect all ResponseFilters from matched execute rules)
//   7. If no match → return approve (default)
//
// ResponseFilters are collected from ALL matched execute/approve rules (not just the deciding one)
// and returned in PolicyDecision.ResponseFilters for the filter runner to apply.

// conflict.go
type Conflict struct {
    RuleA     string   // rule ID
    RuleB     string   // rule ID
    Type      string   // "opposing_decisions" | "shadowed_rule"
    Message   string
}
func DetectConflicts(incoming []CompiledRule, existing []CompiledRule) []Conflict
```

---

## Database Schema (Phase 2 additions)

```sql
-- 002_policies.sql

CREATE TABLE policies (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    slug        TEXT NOT NULL,
    name        TEXT NOT NULL,
    description TEXT,
    role_id     TEXT REFERENCES agent_roles(id) ON DELETE CASCADE,  -- NULL = global
    rules_yaml  TEXT NOT NULL,              -- raw YAML (source of truth); compiled to in-memory rules on startup and on each write
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(user_id, slug)
);
```

Rules are stored as YAML only. On startup and after any policy change, all policies for active users are parsed from YAML and compiled into an in-memory `map[userID][]CompiledRule`. No compiled JSON is cached in the database — policy sets are small, compilation is fast, and avoiding a separate JSON column eliminates the risk of the cache going stale across compiler changes.

---

## Store Interface Additions

```go
// Add to Store interface:
CreatePolicy(ctx, userID string, p *Policy, rulesYAML string) (*PolicyRecord, error)
UpdatePolicy(ctx, id, userID string, p *Policy, rulesYAML string) (*PolicyRecord, error)
DeletePolicy(ctx, id, userID string) error
GetPolicy(ctx, id, userID string) (*PolicyRecord, error)
GetPolicyBySlug(ctx, slug, userID string) (*PolicyRecord, error)
ListPolicies(ctx, userID string, filter PolicyFilter) ([]*PolicyRecord, error)
// PolicyFilter: {RoleID *string, GlobalOnly bool}
// RoleID=nil + GlobalOnly=false → all policies for user
// GlobalOnly=true → only global (role_id IS NULL)
// RoleID=&id → only policies for that role
```

---

## API Routes (Phase 2)

All routes require `Authorization: Bearer <access_token>` (user JWT from Phase 1).

```
# Roles
GET    /api/roles                         → []AgentRole
POST   /api/roles                         Body: {name, description}  → AgentRole
PUT    /api/roles/:id                     Body: {name?, description?} → AgentRole
DELETE /api/roles/:id                     → 204

# Policies
GET    /api/policies                      → []PolicyRecord
GET    /api/policies?role=researcher      → []PolicyRecord (filtered by role)
GET    /api/policies?global=true          → []PolicyRecord (global policies only)
POST   /api/policies                      Body: {yaml: "..."}  → PolicyRecord + []Conflict (warnings)
GET    /api/policies/:id                  → PolicyRecord
PUT    /api/policies/:id                  Body: {yaml: "..."}  → PolicyRecord + []Conflict
DELETE /api/policies/:id                  → 204
POST   /api/policies/validate             Body: {yaml: "..."}  → {valid: bool, errors: [], conflicts: []}
POST   /api/policies/evaluate             Body: {service, action, params, role?} → PolicyDecision (dry-run)
```

The dry-run evaluate endpoint accepts an optional `role` field so you can test "what decision would an agent with role X get for this request?"

`POST /api/policies` and `PUT /api/policies/:id` return `409 Conflict` with conflict details only if conflicts are errors (opposing block/allow with no condition differentiation). Shadowed rules are warnings, not errors — returned in response body but still saved.

`POST /api/policies/evaluate` is a dry-run endpoint useful for debugging: "what would happen if my agent made this request right now?"

---

## Policy Registry (In-Memory Cache)

```go
// internal/policy/registry.go
type Registry struct {
    mu    sync.RWMutex
    rules map[string][]CompiledRule  // userID → compiled rules
}

func NewRegistry() *Registry
func (r *Registry) Load(userID string, policies []Policy)   // replace all rules for user
func (r *Registry) Reload(userID string, store Store)       // reload from DB
func (r *Registry) Evaluate(userID string, req EvalRequest) PolicyDecision
func (r *Registry) Append(userID string, p Policy)          // add/replace single policy
func (r *Registry) Remove(userID string, policyID string)   // remove by slug
```

The registry is the global in-memory compiled rule set. Policy API handlers invalidate/reload the relevant user's entry on write. On startup, all policies are loaded from DB into the registry.

---

## Unit Tests (evaluator_test.go)

Must cover:
- Block beats approve (when both rules match)
- Block beats execute
- Condition-gated rule only fires when condition met
- Condition-gated rule doesn't fire when condition not met
- Default approval when no rules match
- Time window: rule fires inside window
- Time window: rule doesn't fire outside window
- Wildcard action (`*`) matches any action
- Specific action doesn't match different action
- Wildcard service (`*`) matches any service
- Multiple block rules: first wins
- require_approval with allow:true compiles to "approve" decision
- Priority ordering: higher-priority rule evaluated first
- Empty rule set → approve (default)

---

## Success Criteria
- [ ] `go test ./internal/policy/...` passes, all evaluator cases covered
- [ ] `POST /api/policies` with valid YAML creates a policy, returns it
- [ ] `POST /api/policies` with conflicting rules returns conflict warnings
- [ ] `GET /api/policies` returns user's policies (not other users')
- [ ] `POST /api/policies/evaluate` returns correct decision for test cases
- [ ] Policy registry reloads after policy is created/updated/deleted
- [ ] Policies are isolated per user (user A cannot see user B's policies)
- [ ] Role-targeted policy only applies to agents with that role
- [ ] Global policies apply to all agents regardless of role
- [ ] Agent with no role receives global policies only — identical behavior to single-agent setup
- [ ] Role-specific rule takes precedence over global rule when both match
- [ ] `POST /api/policies/evaluate` with `role` field returns role-aware decision
- [ ] `POST /api/policies` with `role: unknown-role` in YAML returns validation error
- [ ] Response filters (structural) are returned in `PolicyDecision.ResponseFilters`
- [ ] `POST /api/roles` creates a role; `GET /api/roles` lists it; `DELETE` removes it
