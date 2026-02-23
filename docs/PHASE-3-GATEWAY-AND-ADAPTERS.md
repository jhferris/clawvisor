# Phase 3: Core Gateway, First Adapter & Approval Flow

## Goal
The gateway is live. Agents can make requests. Clawvisor evaluates them against policy, vaults credentials, calls the first real service (Gmail), and routes approval requests to the human via Telegram. Results are delivered back to the agent via OpenClaw callback.

---

## Deliverables
- Gateway request API (`POST /api/gateway/request`)
- Service adapter interface + adapter registry
- Gmail adapter (OAuth2 authorization flow, token refresh, list/read/send)
- Semantic formatter (per adapter; see `SEMANTIC-FORMATTING.md`)
- LLM safety checker (post-policy secondary check; configurable, off by default)
- Audit log (DB-backed, all requests logged regardless of outcome)
- Telegram approval notifier
- OpenClaw session callback (deliver results to agent)
- Agent token management API
- Service catalog API (supported vs. activated)
- Pending approval persistence + expiry cleanup
- Status polling endpoint

---

## Agent Authentication

Agents authenticate with a **separate token** from user JWTs. Agent tokens are long-lived bearer tokens associated with a user account. They're managed via the dashboard (Phase 4) and the API.

```
POST   /api/agents                         Auth: user JWT  → {agent, token}  # token shown once
GET    /api/agents                         Auth: user JWT  → []Agent
DELETE /api/agents/:id                     Auth: user JWT  → 204
```

Agent tokens are SHA-256 hashed before storage (same pattern as refresh tokens). The raw token is returned once at creation and never again. Agents use `Authorization: Bearer <agent_token>` on all gateway requests.

---

## Adapter Interface

```go
// internal/adapters/adapter.go

type Request struct {
    Action  string
    Params  map[string]any
    Credential []byte          // decrypted from vault, never logged
}

type Result struct {
    Summary string
    Data    any
}

type Adapter interface {
    ServiceID() string
    SupportedActions() []string
    // Execute runs the action. Credential is injected; never returned to caller.
    Execute(ctx context.Context, req Request) (*Result, error)
    // OAuthConfig returns the OAuth2 config for this adapter.
    // Nil if the service uses API keys instead.
    OAuthConfig() *oauth2.Config
    // CredentialFromToken builds a storable credential from an OAuth2 token.
    CredentialFromToken(token *oauth2.Token) ([]byte, error)
    // ValidateCredential checks if a stored credential is still valid/parseable.
    ValidateCredential(credBytes []byte) error
}

// Registry
type Registry struct {
    adapters map[string]Adapter
}
func (r *Registry) Register(a Adapter)
func (r *Registry) Get(serviceID string) (Adapter, bool)
func (r *Registry) All() []Adapter
func (r *Registry) SupportedServices() []ServiceInfo
```

---

## Gmail Adapter

```go
// internal/adapters/google/gmail/adapter.go

type GmailAdapter struct{}

func (a *GmailAdapter) ServiceID() string { return "google.gmail" }
func (a *GmailAdapter) SupportedActions() []string {
    return []string{"list_messages", "get_message", "send_message"}
}
func (a *GmailAdapter) OAuthConfig() *oauth2.Config {
    return &oauth2.Config{
        Scopes: []string{
            "https://www.googleapis.com/auth/gmail.readonly",
            "https://www.googleapis.com/auth/gmail.send",
        },
        Endpoint: google.Endpoint,
        // RedirectURL and ClientID/Secret injected from config at runtime
    }
}
```

### OAuth2 Flow (server-side PKCE)
1. `GET /api/oauth/start?service=google.gmail` — generate state token (stored in session), redirect to Google consent URL
2. `GET /api/oauth/callback?code=...&state=...` — validate state, exchange code for tokens, store in vault via `vault.Set(userID, "google", credBytes)`, redirect to dashboard
3. Token refresh: checked before every adapter call; if `token.Expiry.Before(time.Now().Add(60*time.Second))`, refresh and re-store

### Credential Schema (JSON, stored encrypted in vault under key `"google"`)
```json
{
  "type": "oauth2",
  "access_token": "...",
  "refresh_token": "...",
  "expiry": "2026-02-22T21:00:00Z",
  "scopes": ["https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/gmail.send"]
}
```

The vault key is `"google"` (not `"google.gmail"`), shared across all Google adapters. Client ID/Secret come from Clawvisor's server config (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` env vars) and are never stored per-user in the vault. The `scopes` field records which scopes were granted at consent time; Phase 6 expands this list when additional Google services are activated.

### Actions

**list_messages**
- Params: `query` (string, Gmail search syntax), `max_results` (int, 1-50)
- Calls `gmail.users.messages.list` then fetches metadata for each
- Returns: `{summary: "N messages (M unread)", data: [{id, from, subject, date, snippet, isUnread}]}`

**get_message**
- Params: `message_id` (string)
- Returns: `{summary: "Email from X: Subject", data: {id, from, to, subject, date, body (2000 char max), isUnread}}`
- Body: extracted from `text/plain` part, falls back to snippet
- HTML stripped before returning

**send_message**
- Params: `to` (string), `subject` (string), `body` (string), `in_reply_to` (string, optional)
- Returns: `{summary: "Email sent to X (subject: Y)", data: {message_id}}`

---

## Gateway Request API

### Request
```
POST /api/gateway/request
Authorization: Bearer <agent_token>
Content-Type: application/json

{
  "service": "google.gmail",
  "action": "list_messages",
  "params": {"query": "is:unread", "max_results": 10},
  "reason": "Morning email briefing",
  "context": {
    "source": "heartbeat",
    "data_origin": null,
    "callback_url": "http://localhost:18789/api/sessions/xyz/inbound"
  },
  "request_id": "uuid-v4"   // optional; generated if omitted
}
```

### Response shapes (same as prototype PROTOCOL.md, now implemented)

**Executed:**
```json
{"status": "executed", "request_id": "...", "result": {"summary": "...", "data": [...]}, "audit_id": "..."}
```

**Blocked:**
```json
{"status": "blocked", "request_id": "...", "reason": "...", "policy_id": "...", "audit_id": "..."}
```

**Pending:**
```json
{"status": "pending", "request_id": "...", "message": "Approval requested. Waiting up to 300s.", "audit_id": "..."}
```

**Error:**
```json
{"status": "error", "request_id": "...", "error": "...", "code": "SERVICE_NOT_CONFIGURED", "audit_id": "..."}
```

### SERVICE_NOT_CONFIGURED special handling
When a service isn't activated (no credential in vault), instead of returning a plain error, Clawvisor:
1. Sends an approval-style Telegram message: "Clawby wants to use Gmail, which isn't activated. [Activate] [Deny]"
2. The "Activate" button links to the OAuth start URL: `https://your-clawvisor.com/api/oauth/start?service=google.gmail&pending_request_id=...`
3. After activation, the pending request is re-evaluated and executed (if policy allows)
4. Returns `{"status": "pending_activation", ...}` to the agent

---

## LLM Safety Checker

A secondary check that runs **after** the policy evaluator returns `execute`. See `ARCHITECTURE.md` for the full design rationale.

```go
// internal/safety/checker.go
type SafetyChecker interface {
    // Check evaluates the formatted adapter result for anomalies.
    // req provides service/action/agent context; result is the SemanticResult
    // after formatting — never the raw API response.
    Check(ctx context.Context, userID string, req *gateway.Request, result *adapters.Result) (SafetyResult, error)
}
type SafetyResult struct {
    Safe   bool
    Reason string
}
```

- Receives sanitized request params only — never raw external content
- Receives the `SemanticResult` from the adapter (after formatting) — not the raw API response
- Output: `safe` → execution proceeds; `flag` → request routed to approval with LLM reason shown
- Configurable globally (`safety.enabled`) and per-service (`safety.skip_readonly: true` skips reads)
- Disabled by default; enabled by setting `safety.endpoint` and `safety.api_key` in config
- Timeout: 5 seconds max; on timeout, fail safe → route to approval

---

## Gateway Request Handler (internal flow)

```go
func (h *Handler) HandleRequest(w http.ResponseWriter, r *http.Request) {
    start := time.Now()
    req := parseAndValidate(r)

    agent := agentFromContext(r.Context())       // set by auth middleware
    user := agent.UserID

    // 1. Evaluate policy (role-aware)
    decision := h.policyRegistry.Evaluate(user, policy.EvalRequest{
        Service:     req.Service,
        Action:      req.Action,
        Params:      req.Params,
        AgentRoleID: agent.RoleID,  // empty string if agent has no role
    })

    // 2. Route by decision
    switch decision.Decision {
    case policy.DecisionBlock:
        auditID := h.audit.Log(...)
        respond(w, blockedResponse(req, decision, auditID))

    case policy.DecisionApprove:
        auditID := h.audit.Log(...) // outcome: "pending"
        h.approval.Request(ctx, ApprovalRequest{
            RequestID:   req.RequestID,
            UserID:      user,
            GatewayReq:  req,
            Decision:    decision,
            AuditID:     auditID,
            CallbackURL: req.Context.CallbackURL,
            ExpiresAt:   time.Now().Add(h.config.ApprovalTimeout),
        })
        respond(w, pendingResponse(req, auditID))

    case policy.DecisionExecute:
        // 1. Vault inject → adapter call → semantic format
        result, err := h.execute(ctx, user, req)
        if err != nil {
            auditID := h.audit.Log(...outcome: "error"...)
            respond(w, errorResponse(req, err, auditID))
            return
        }

        // 2. Apply response filters (structural first, then semantic)
        if len(decision.ResponseFilters) > 0 {
            result, err = h.filters.Apply(ctx, user, agent.RoleID, result, decision.ResponseFilters)
            if err != nil {
                // Filter errors are non-fatal; log and continue with unfiltered result
                h.logger.Warn("response filter error", "err", err)
            }
        }

        // 3. LLM safety check on filtered output (if enabled)
        if h.safety != nil {
            safetyResult, _ := h.safety.Check(ctx, user, req, result)
            if !safetyResult.Safe {
                decision.Decision = policy.DecisionApprove
                decision.Reason = "Safety check: " + safetyResult.Reason
                // fall through to approval flow
                break
            }
        }

        auditID := h.audit.Log(...outcome: "executed"...)
        respond(w, executedResponse(req, result, auditID))
    }
}
```

---

## Audit Log

### Schema

```sql
-- 003_audit.sql

CREATE TABLE audit_log (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    agent_id        TEXT REFERENCES agents(id) ON DELETE SET NULL,
    request_id      TEXT NOT NULL UNIQUE,  -- one-time use; enforces no duplicate request IDs
    timestamp       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    service         TEXT NOT NULL,
    action          TEXT NOT NULL,
    params_safe     JSONB NOT NULL,        -- credentials stripped
    decision        TEXT NOT NULL,         -- execute|approve|block
    outcome         TEXT NOT NULL,         -- executed|pending|blocked|denied|timeout|error|pending_activation
    policy_id       TEXT,
    rule_id         TEXT,
    safety_flagged  BOOLEAN NOT NULL DEFAULT FALSE,
    safety_reason   TEXT,                  -- LLM safety check reason (if flagged)
    reason          TEXT,                  -- agent's stated reason (untrusted)
    data_origin     TEXT,                  -- injection forensics
    context_src     TEXT,
    duration_ms     INTEGER NOT NULL,
    filters_applied JSONB,                 -- [{type, filter, matches?, truncated?, applied?, error?}]
    error_msg       TEXT
);

CREATE INDEX idx_audit_user_time ON audit_log(user_id, timestamp DESC);
CREATE INDEX idx_audit_outcome   ON audit_log(user_id, outcome);
CREATE INDEX idx_audit_service   ON audit_log(user_id, service);
CREATE INDEX idx_audit_origin    ON audit_log(user_id, data_origin);

CREATE TABLE pending_approvals (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    request_id      TEXT NOT NULL UNIQUE,
    audit_id        TEXT NOT NULL,
    request_blob    JSONB NOT NULL,
    callback_url    TEXT,
    telegram_msg_id TEXT,
    expires_at      TIMESTAMPTZ NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### Store Interface Additions

```go
LogAudit(ctx, entry *AuditEntry) error
UpdateAuditOutcome(ctx, id, outcome, errMsg string) error
GetAuditEntry(ctx, id, userID string) (*AuditEntry, error)
ListAuditEntries(ctx, userID string, filter AuditFilter) ([]*AuditEntry, int, error)

SavePendingApproval(ctx, *PendingApproval) error
GetPendingApproval(ctx, requestID string) (*PendingApproval, error)
UpdatePendingTelegramMsgID(ctx, requestID, msgID string) error
DeletePendingApproval(ctx, requestID string) error
ListExpiredPendingApprovals(ctx) ([]*PendingApproval, error)
```

---

## Approval Flow

### Notifier Interface

```go
// internal/notify/notify.go
type Notifier interface {
    SendApprovalRequest(ctx context.Context, req ApprovalRequest) error
    // Called when a service needs activation
    SendActivationRequest(ctx context.Context, req ActivationRequest) error
}

// internal/notify/telegram/telegram.go
type TelegramNotifier struct { /* bot token, chat ID per user */ }
```

Notification config (stored in `notification_configs` table) is per-user. On approval/denial, Clawvisor:
1. Edits the Telegram message to show the decision
2. Executes (if approved): vault inject → adapter call → audit update
3. Posts result to agent callback URL

### OpenClaw Callback

```go
// internal/callback/callback.go
func DeliverResult(ctx context.Context, callbackURL string, result *CallbackPayload) error
// POST callbackURL with:
// {
//   "request_id": "...",
//   "status": "executed" | "denied" | "timeout",
//   "result": {...},        // if executed
//   "audit_id": "..."
// }
```

The callback URL is `http://localhost:18789/api/sessions/{sessionID}/inbound` (OpenClaw gateway local endpoint). The agent token acts as auth for the callback — Clawvisor signs the callback with an HMAC using the agent token.

### Expiry Cleanup

Background goroutine runs every minute:
```go
func (s *Server) runExpiryCleanup(ctx context.Context) {
    ticker := time.NewTicker(time.Minute)
    for range ticker.C {
        expired, _ := s.store.ListExpiredPendingApprovals(ctx)
        for _, pa := range expired {
            s.store.UpdateAuditOutcome(ctx, pa.AuditID, "timeout", "")
            s.store.DeletePendingApproval(ctx, pa.RequestID)
            // Notify agent of timeout via callback
            if pa.CallbackURL != "" {
                callback.DeliverResult(ctx, pa.CallbackURL, &CallbackPayload{
                    RequestID: pa.RequestID,
                    Status:    "timeout",
                    AuditID:   pa.AuditID,
                })
            }
        }
    }
}
```

---

## Service Catalog API

```
GET /api/services
Authorization: Bearer <user JWT or agent token>

Response:
{
  "services": [
    {
      "id": "google.gmail",
      "name": "Gmail",
      "description": "Read and send email via Gmail",
      "oauth": true,
      "scopes": ["gmail.readonly", "gmail.send"],
      "actions": ["list_messages", "get_message", "send_message"],
      "status": "activated",          // "activated" | "not_activated" | "credential_expired"
      "activated_at": "2026-02-22T..."
    }
  ]
}
```

```
GET  /api/oauth/start?service=google.gmail[&pending_request_id=...]
     → 302 redirect to Google consent URL

GET  /api/oauth/callback?code=...&state=...
     → exchanges code, stores credential, redirects to dashboard
     → if pending_request_id present: re-evaluates and executes pending request
```

---

## Status Polling

```
GET /api/gateway/request/:request_id/status
Authorization: Bearer <agent token>

Response:
{"status": "pending" | "executed" | "denied" | "timeout" | "error", "result": {...}, "audit_id": "..."}
```

---

## Success Criteria
- [ ] Agent can register a token and make a request to `POST /api/gateway/request`
- [ ] Request blocked by policy returns `blocked` response with policy ID
- [ ] Request allowed by policy executes Gmail list and returns semantic result
- [ ] Request with no policy match routes to Telegram approval
- [ ] Telegram approve button triggers execution and delivers result to callback URL
- [ ] Telegram deny button logs denial, notifies callback URL
- [ ] Pending approval expires after configured timeout, callback notified
- [ ] OAuth flow completes: Gmail activated, credential stored in vault
- [ ] `GET /api/services` shows Gmail as activated after OAuth
- [ ] Unauthenticated request to `/api/gateway/request` returns 401
- [ ] Audit log records every request regardless of outcome
- [ ] Credentials never appear in audit log params
