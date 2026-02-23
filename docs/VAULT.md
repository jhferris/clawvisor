# Clawvisor — Credential Vault

## Design

The vault stores service credentials encrypted at rest. The AI agent never interacts with the vault directly and never receives credential values in any response. Clawvisor injects credentials into outbound adapter calls internally.

Credentials are stored **per user per service**. In a multi-user deployment, each user's credentials are isolated — a user can only access their own vault entries, and vault keys are scoped accordingly.

---

## Vault Interface

```go
type Vault interface {
    Set(ctx context.Context, userID, serviceID string, credential []byte) error
    Get(ctx context.Context, userID, serviceID string) ([]byte, error)
    Delete(ctx context.Context, userID, serviceID string) error
    List(ctx context.Context, userID string) ([]string, error)
}
```

Two implementations, selected by config (`vault.backend`):

---

## Local Vault (`vault.backend: local`)

For local deployments and development.

- AES-256-GCM encryption
- 32-byte master key stored in `vault.key` (auto-generated if missing, `chmod 600`)
- Credential rows stored in the same Postgres or SQLite database as the rest of Clawvisor
- Key never stored in config, never logged

**Encryption:**
```
plaintext (JSON credential)
  → AES-256-GCM(masterKey, randomIV)
  → { ciphertext, iv, authTag }
  → base64-encoded, stored in DB
```

Decryption verifies `authTag` — detects tampering.

**Database schema:**
```sql
CREATE TABLE vault_entries (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    service_id  TEXT NOT NULL,
    encrypted   TEXT NOT NULL,
    iv          TEXT NOT NULL,
    auth_tag    TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(user_id, service_id)
);
```

---

## GCP Vault (`vault.backend: gcp`)

For Cloud Run deployments.

- Uses GCP Secret Manager
- Secret named: `clawvisor-{userID}-{serviceID}`
- Secret value: AES-256-GCM encrypted credential (same encryption as local vault, with per-deployment key stored in a separate Secret Manager entry `clawvisor-vault-key`)
- Credentials are encrypted before storing in Secret Manager — GCP access is a second layer, not the primary encryption

**Why encrypt even in Secret Manager?** Defense in depth. If GCP access is compromised, raw credentials aren't directly exposed.

---

## Credential Structure

Credential bytes are JSON, schema defined per adapter.

**Google (shared across gmail, calendar, drive, contacts):**
```json
{
  "type": "oauth2",
  "access_token": "ya29...",
  "refresh_token": "1//...",
  "expiry": "2026-02-22T22:00:00Z",
  "scopes": ["gmail.readonly", "gmail.send", "calendar.readonly"]
}
```

Note: `client_id` and `client_secret` come from Clawvisor's server configuration (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` env vars) — they are shared across all users and never stored per-user in the vault.

**GitHub and other API-key services:**
```json
{
  "type": "api_key",
  "key": "ghp_..."
}
```

---

## Unified Google Credential

Gmail, Calendar, Drive, and Contacts share one vault entry: `google`. Individual service metadata entries (`service_meta` table) record which Google services are activated, but the credential is retrieved as `vault.Get(userID, "google")`.

Activating a new Google service triggers re-consent with expanded scopes. The updated token (with new scopes) replaces the existing vault entry.

---

## Injection

When a request is authorized, the gateway calls `vault.Inject(userID, serviceID, params)`, which returns a copy of params with `_credential` added:

```go
injected := map[string]any{
    "query":       "is:unread",
    "max_results": 10,
    "_credential": Credential{Type: "oauth2", AccessToken: "..."},
}
```

The `_credential` key is:
- Passed to the adapter's `Execute` function
- Stripped from all API responses
- Never written to the audit log
- Never returned to the agent

---

## Token Refresh

OAuth2 adapters check token expiry before each call. If the token expires within 60 seconds:
1. Retrieve refresh token from vault
2. Call provider's token endpoint
3. Store updated credential back in vault
4. Proceed with the API call

Token refresh errors are returned as `VAULT_ERROR` to the gateway.

---

## Credential Management

Credentials are managed through the **dashboard** (primary) or the **API**:

```
GET  /api/services                                → list services with activation status
GET  /api/oauth/start?service=google.gmail        → begin OAuth flow (browser redirect)
GET  /api/oauth/callback?code=...&state=...       → complete OAuth, store credential
POST /api/services/:id/credential                 → set API key (for non-OAuth services)
DELETE /api/services/:id/credential               → deactivate service, remove credential
```

There is no CLI for credential management in the Go build — the dashboard and OAuth flow handle everything.

---

## Security Properties

- The agent never receives credential values — not in responses, not in errors
- Credentials are encrypted at rest in both local and GCP backends
- The vault master key is never stored in application config or logs
- Credential injection happens inside the Clawvisor process, after policy approval and safety check
- Vault entries are scoped per user — no cross-user access is possible through the API
