# Clawvisor — Architecture

## Component Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                         AI Agent (e.g. Clawby)                      │
│                                                                     │
│  POST /api/gateway/request                                          │
│  {service, action, params, reason, context}                         │
└────────────────────────────────────┬────────────────────────────────┘
                                     │ Bearer <agent_token>
                              ┌──────▼──────┐
                              │   Server    │  ← Go net/http
                              │  (cmd/server)│
                              └──────┬──────┘
                                     │ auth middleware resolves agent → user
                              ┌──────▼──────┐
                              │   Policy    │  ← pure function, compiled rules
                              │  Evaluator  │    per-user registry
                              └──────┬──────┘
                                     │
             ┌───────────────────────┼────────────────────────┐
             │                       │                        │
          BLOCK                 SEEK APPROVAL              EXECUTE
             │                       │                        │
      ┌──────▼──────┐        ┌───────▼──────┐       ┌────────▼────────┐
      │  Audit Log  │        │   Approval   │       │  LLM Safety     │
      │  (blocked)  │        │   Notifier   │       │  Check          │
      └─────────────┘        └───────┬──────┘       └────────┬────────┘
                                     │                   flag │ pass
                             Telegram/Dashboard              │    │
                             approve/deny              APPROVE│    ▼
                                     │                       │  Vault
                              ┌──────▼──────┐                │  (inject credential)
                              │ On approve: │                 │       │
                              │ → Vault     │                 └───────┤
                              │ → Adapter   │                         ▼
                              │ → Format    │               Service Adapter
                              │ → Audit     │               (Gmail, Calendar, etc.)
                              └─────────────┘                        │
                                                                      ▼
                                                            Semantic Formatter
                                                            (strips noise, structures result)
                                                                      │
                                                                      ▼
                                                            Response Filters
                                                            (structural: redact/remove/truncate)
                                                            (semantic: LLM best-effort, per role)
                                                                      │
                                                                      ▼
                                                            LLM Safety Check
                                                            (reviews filtered output)
                                                                      │
                                                                      ▼
                                                            Audit Log (executed)
                                                            + Callback to agent
```

---

## Components

### Server (`cmd/server/`, `internal/api/`)
- `net/http` ServeMux (Go 1.22+ path params, no router library)
- Binds to configured host:port (loopback for local, 0.0.0.0 for Cloud Run)
- Auth middleware: validates agent bearer token → resolves to User
- Routes to gateway handler, policy API, OAuth, dashboard API
- Serves `web/dist/` as static files (SPA fallback)

### Policy Registry (`internal/policy/`)
- In-memory per-user compiled rule set: `map[userID][]CompiledRule`
- `parser.go` — reads YAML → `Policy` structs (including `role`, `response_filters`)
- `compiler.go` — `Policy` → `CompiledRule[]`, priority-sorted
- `evaluator.go` — pure function: `Evaluate(EvalRequest, agentRoleID, []CompiledRule) → PolicyDecision`
- Role-aware evaluation: global rules (no role) always apply; role-specific rules layer on top and take precedence on conflict. An agent with no role assigned receives only global rules — identical to single-agent behavior.
- `filter.go` — applies structural response filters (deterministic); invokes LLM for semantic filters (best-effort)
- Zero I/O in the evaluator itself; filter application is separate
- Hot-reloads from DB on policy write; full reload on startup

### LLM Safety Checker (`internal/safety/`)
- Called only when policy decision is `execute`
- Sends sanitized request (service, action, structured params) to a configurable LLM endpoint
- Prompt is tightly constrained: classify as `safe` or `flag` with one-sentence reason
- If `flag` → decision becomes `approve`; shown to human in approval notification
- If `safe` → execution proceeds
- Configurable: can be disabled globally or per-service (`safety.enabled: false`)
- Uses a small/fast model — not the same model as the agent

### Vault (`internal/vault/`)
- Interface: `Vault{ Set, Get, Delete, List }`
- Two implementations selected by config:
  - `LocalVault` — AES-256-GCM, 32-byte keyfile, Postgres or SQLite backing table
  - `GCPVault` — GCP Secret Manager, secret named `clawvisor-{userID}-{serviceID}`
- Credentials stored per user per service
- Injection: `vault.Inject(userID, serviceID, params)` merges credential into params for adapter; credential never returned to caller or logged

### Service Adapters (`internal/adapters/`)
- Interface: `Adapter{ ServiceID, SupportedActions, Execute, OAuthConfig, Metadata, ActionSchema }`
- One package per service: `google/gmail`, `google/calendar`, `google/drive`, `google/contacts`, `github`
- `Execute(ctx, Request) → Result` — calls external API, returns `SemanticResult`
- Adapter owns: API call, OAuth token refresh, error handling, semantic formatting
- Registered at startup; registry queries adapters for service catalog

### Semantic Formatter (part of each adapter)
- See `SEMANTIC-FORMATTING.md` for full design
- Strips raw API noise before returning result to agent
- Returns `{summary: string, data: any}` — human-readable summary + structured data
- The LLM safety check and agent both receive this cleaned output, never raw API responses

### Approval Notifier (`internal/notify/`)
- Interface: `Notifier{ SendApprovalRequest, SendActivationRequest }`
- Per-user notification config (stored in DB): `channel`, `config`
- Implementations: Telegram (primary), Dashboard (in-browser via polling)
- Both run simultaneously — first response (Telegram or dashboard) wins
- Callback delivery: on resolution, Clawvisor POSTs result to `context.callback_url` (agent's OpenClaw session)

### Store (`internal/store/`)
- Interface covering: users, sessions, agents, policies, service metadata, audit log, pending approvals, notification configs, review findings
- Two implementations: `postgres/` and `sqlite/`
- Selected by config: `database.driver: "postgres" | "sqlite"`
- All DB access goes through the interface — no direct queries outside `store/`

### Audit Logger (`internal/audit/`)
- Thin wrapper over `store.LogAudit` / `store.UpdateAuditOutcome`
- Logs every request regardless of outcome
- Credentials stripped from params before logging
- Used by gateway handler, approval flow, and retrospective review engine

### Retrospective Review (`internal/review/`)
- Background goroutine, runs on schedule (default: daily)
- Queries audit log for analysis window
- Runs detectors: volume anomaly, exfiltration sequence, policy probing, injection fingerprints, off-hours activity
- Findings stored in DB, surfaced in dashboard and via Telegram

---

## Key Interfaces

```go
// Vault
type Vault interface {
    Set(ctx context.Context, userID, serviceID string, credential []byte) error
    Get(ctx context.Context, userID, serviceID string) ([]byte, error)
    Delete(ctx context.Context, userID, serviceID string) error
    List(ctx context.Context, userID string) ([]string, error)
}

// Adapter
type Adapter interface {
    ServiceID() string
    SupportedActions() []string
    Execute(ctx context.Context, req AdapterRequest) (*SemanticResult, error)
    OAuthConfig() *oauth2.Config   // nil for API-key services
    Metadata() ServiceMetadata
    ActionDescription(action string) string
    ActionSchema(action string) map[string]any
}

// Notifier
type Notifier interface {
    SendApprovalRequest(ctx context.Context, req ApprovalRequest) error
    SendActivationRequest(ctx context.Context, req ActivationRequest) error
}

// Safety checker (receives filtered output, not raw adapter result)
type SafetyChecker interface {
    Check(ctx context.Context, userID string, req *gateway.Request, result *SemanticResult) (SafetyResult, error)
}
type SafetyResult struct {
    Safe   bool
    Reason string   // if !Safe, shown in approval notification
}

// Response filter runner
type FilterRunner interface {
    // Apply structural filters (deterministic) and semantic filters (best-effort LLM)
    // for the given agent role. Returns filtered result.
    Apply(ctx context.Context, userID, roleID string, result *SemanticResult, filters []ResponseFilter) (*SemanticResult, error)
}
```

---

## Trust Boundaries

```
Trusted                          Untrusted
──────────────────────           ────────────────────────────────
Clawvisor process                Agent (potentially manipulated)
Policy registry (compiled)       External API responses
Vault (encrypted)                Data agent processes (email, web, docs)
Config + environment             Agent's "reason" field
Human approval decision          Agent's "context.data_origin" field (logged, not trusted)
LLM safety check output          LLM safety check input (may contain adversarial content)
```

**Key invariants:**
- Agent token grants access to the Clawvisor API only — never to credentials
- `reason` and `context` fields are logged but **never affect policy decisions**
- Credentials are stripped from all logs and responses
- Policy evaluation is a pure function with no external I/O
- The LLM safety checker receives sanitized params only — never raw external content the agent was processing
- The safety checker can only output `safe/flag` — it has no ability to execute actions

---

## Deployment

### Local (single user or development)
- SQLite store (`database.driver: sqlite`)
- Local vault (`vault.backend: local`, keyfile on disk)
- Binds to `127.0.0.1:8080`
- Approval notifications via Telegram; in-browser via dashboard

### Cloud Run (hosted, multi-user)
- Postgres store via Cloud SQL (`database.driver: postgres`, `DATABASE_URL` from Secret Manager)
- GCP vault (`vault.backend: gcp`, Secret Manager)
- Binds to `0.0.0.0:8080`
- HTTPS via Cloud Run managed TLS
- Min 1 instance (approvals need a live process for Telegram callbacks)
- Secrets injected as env vars from Secret Manager

### Configuration (`config.yaml` + env overrides)
```yaml
server:
  port: 8080
  host: "127.0.0.1"       # override to "0.0.0.0" for Cloud Run
  frontend_dir: "./web/dist"

database:
  driver: "postgres"       # "postgres" | "sqlite"
  postgres_url: ""         # from env: DATABASE_URL
  sqlite_path: "./clawvisor.db"

vault:
  backend: "local"         # "local" | "gcp"
  local_key_file: "./vault.key"
  gcp_project: ""          # from env: GCP_PROJECT

auth:
  jwt_secret: ""           # from env: JWT_SECRET
  access_token_ttl: "15m"
  refresh_token_ttl: "720h"

approval:
  timeout: 300
  on_timeout: "fail"       # "fail" | "skip"

safety:
  enabled: false           # LLM safety check; enable when LLM endpoint configured
  endpoint: ""             # LLM API endpoint for safety check calls
  model: ""                # model name
  api_key: ""              # from env: SAFETY_LLM_API_KEY
  skip_readonly: true      # skip check for read-only actions (list, get)

mcp:
  approval_timeout: 240    # seconds MCP tool calls block waiting for approval (shorter than
                           # approval.timeout to leave buffer before Cloud Run request timeout)
```
