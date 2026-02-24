# Clawvisor Handoff — 2026-02-23

Tested against the running instance at `http://192.168.4.247:8080/`.

---

## What's Working ✅

### Auth
- `POST /api/auth/login` exists and returns proper error codes (`INVALID_CREDENTIALS`)
- User JWT auth is live — dashboard routes (`/api/services`, `/api/policies`, `/api/audit`, `/api/approvals`) all return 401 correctly when hit with an agent bearer token
- Agent bearer token auth is working on `/api/gateway/request`

### Gateway request flow (partial)
- `POST /api/gateway/request` with agent bearer token correctly:
  - Authenticates the agent
  - Creates a pending approval request
  - Returns `{ status: "pending", request_id, audit_id, message }`
  - Generates real `audit_id` UUIDs (audit logging is live)
  - Default-deny posture is working — no matching policy → approval queue
- The approval appears in the dashboard and can be approved/denied

### Static assets
- `/health` → `{"status":"ok"}`
- `/skill/SKILL.md` → full skill file served correctly

---

## What's Broken / Missing ❌

### 1. Request result retrieval — agent can't get the outcome

**The core missing piece.** After a request is approved (or denied), there is no way for the agent to retrieve the result.

Two mechanisms are needed (both are in the design docs):

#### A. Poll by `request_id` (sync fallback)
Resubmitting a request with the same `request_id` should detect the existing resolved request and return its outcome instead of creating a new pending request.

Currently: resubmitting creates a **new** pending request with a new `audit_id`. The `request_id` uniqueness constraint isn't being enforced/used for result retrieval.

Expected behavior:
```
POST /api/gateway/request  { request_id: "test-001", ... }
→ { status: "executed", result: { ... } }   // if already resolved
→ { status: "pending", ... }                 // if still waiting
→ { status: "denied", reason: "..." }        // if denied
```

#### B. Callback to `callback_url` (async push)
When Clawvisor resolves a request (approved/denied), it should POST the result to the `callback_url` included in the original request context, HMAC-signed with the agent's token.

Currently: not implemented. Approvals are recorded in the DB but nothing is posted to `callback_url`.

Expected POST body to `callback_url`:
```json
{
  "request_id": "test-001",
  "status": "executed",
  "result": { "summary": "...", "data": { ... } },
  "audit_id": "f102d4b1-..."
}
```

### 2. Service execution after approval
When a request is approved, the actual service call (e.g. Gmail API) needs to be executed and the result stored. It's unclear whether this is wired up — no way to test without a configured OAuth service.

### 3. `GET /api/gateway/result` or equivalent
No dedicated result retrieval endpoint exists:
- `GET /api/gateway/request/<audit_id>` → 404
- `GET /api/gateway/request?request_id=test-001` → 404

A result endpoint would be the cleanest polling interface for the agent.

---

## API Surface Confirmed

| Route | Auth | Status |
|-------|------|--------|
| `GET /health` | none | ✅ works |
| `GET /skill/SKILL.md` | none | ✅ works |
| `POST /api/auth/login` | none | ✅ works |
| `POST /api/gateway/request` | agent bearer | ✅ works (partial — no result delivery) |
| `GET /api/services` | user JWT | ✅ exists (auth tested) |
| `GET /api/policies` | user JWT | ✅ exists (auth tested) |
| `GET /api/audit` | user JWT | ✅ exists (auth tested) |
| `GET /api/approvals` | user JWT | ✅ exists (auth tested) |
| `GET /api/gateway/result` | agent bearer | ❌ not implemented |

---

## Priority Order for Next Work

1. **`request_id` dedup + result retrieval** — resubmitting same `request_id` should return the resolved outcome. This is the minimum needed to close the agent request loop.
2. **Callback delivery** — POST result to `callback_url` after approval/denial, HMAC-signed.
3. **Service execution** — verify the actual service call fires after approval and result is stored.

---

## Reference Docs

All design docs are in `docs/`:
- `docs/PROTOCOL.md` — full request/response spec including `request_id` dedup behavior
- `docs/APPROVAL.md` — approval flow and callback architecture
- `docs/PHASE-3-GATEWAY-AND-ADAPTERS.md` — gateway implementation spec
