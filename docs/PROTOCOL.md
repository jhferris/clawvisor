# Clawvisor — Agent↔Gatekeeper Protocol

## Overview

Agents communicate with Clawvisor over HTTP. The agent describes what it wants to do; Clawvisor decides whether, how, and when to do it. The agent never receives credentials. It receives results or decisions.

The agent's identity (and associated user account) is resolved from the bearer token — it does not need to be declared in the request body.

---

## Authentication

All requests require:
```
Authorization: Bearer <agent_token>
```

Agent tokens are created in the Clawvisor dashboard and are long-lived. They are SHA-256 hashed before storage. The raw token is shown once at creation.

---

## POST /api/gateway/request

### Request

```json
{
  "service": "google.gmail",
  "action": "list_messages",
  "params": {
    "query": "is:unread",
    "max_results": 10
  },
  "reason": "Checking for urgent unread emails during morning briefing",
  "context": {
    "source": "heartbeat",
    "data_origin": null,
    "callback_url": "http://localhost:18789/api/sessions/xyz/inbound"
  },
  "request_id": "550e8400-e29b-41d4-a716-446655440000"
}
```

### Fields

| Field | Required | Description |
|---|---|---|
| `service` | Yes | Dotted service identifier: `google.gmail`, `google.calendar`, `github`, etc. |
| `action` | Yes | Action name within the service: `list_messages`, `send_message`, etc. |
| `params` | Yes | Action-specific parameters. No credentials — Clawvisor injects those. Max 50 keys, 64KB total. |
| `reason` | No | Agent's stated reason. Logged and shown in approval notifications. **Never trusted for policy decisions.** |
| `context.source` | No | What triggered this request: `heartbeat`, `user_message`, `subagent`, `mcp`, `cron`. |
| `context.data_origin` | No | URL or path of external content the agent was processing when it made this request. Critical for injection forensics. Should always be populated when processing external data. |
| `context.callback_url` | No | URL for async result delivery. When a request goes pending, Clawvisor POSTs the result here once resolved. |
| `request_id` | No | Client-generated UUID for correlation. Auto-generated if omitted. |

---

## Response Statuses

### `executed` — Policy allowed, safety check passed, action completed

```json
{
  "status": "executed",
  "request_id": "550e8400-...",
  "result": {
    "summary": "3 unread emails: 1 from sister (dinner tonight), 1 meeting invite tomorrow 2pm, 1 newsletter",
    "data": [
      {
        "id": "msg-abc123",
        "from": "sister@example.com",
        "subject": "dinner tonight",
        "snippet": "Hey, are you free for dinner...",
        "timestamp": "2026-02-22T19:00:00Z",
        "is_unread": true
      }
    ]
  },
  "audit_id": "audit-uuid"
}
```

`result.summary` is always a human-readable string. `result.data` is structured but schema varies by adapter action — see each adapter's documentation. Credentials and raw API noise are never present.

### `blocked` — Explicit policy violation

```json
{
  "status": "blocked",
  "request_id": "...",
  "reason": "Policy 'gmail-readonly' blocks google.gmail/send_message",
  "policy_id": "gmail-readonly",
  "audit_id": "..."
}
```

Do not retry a blocked request without a policy change. The block is deterministic.

### `pending` — Awaiting human approval

```json
{
  "status": "pending",
  "request_id": "...",
  "message": "Approval requested. Waiting up to 300 seconds.",
  "audit_id": "..."
}
```

The action has not executed. Clawvisor has notified the user (Telegram and/or dashboard). When the user approves, Clawvisor executes and delivers the result to `context.callback_url` if provided. Poll `GET /api/gateway/request/:request_id/status` for synchronous workflows.

### `pending_activation` — Service not yet activated

```json
{
  "status": "pending_activation",
  "request_id": "...",
  "service": "google.gmail",
  "message": "google.gmail is not activated. The user has been notified to activate it.",
  "audit_id": "..."
}
```

Clawvisor has sent the user a Telegram/dashboard notification with an [Activate] button. Once activated, the pending request is re-evaluated and executed (if policy allows). The agent should inform the user and wait for the callback.

### `timeout` — Approval not received in time

```json
{
  "status": "timeout",
  "request_id": "...",
  "message": "Approval not received within 300 seconds. Request expired.",
  "audit_id": "..."
}
```

### `denied` — Human explicitly denied

```json
{
  "status": "denied",
  "request_id": "...",
  "message": "Request denied by user.",
  "audit_id": "..."
}
```

### `error` — Processing error

```json
{
  "status": "error",
  "request_id": "...",
  "error": "Adapter call failed: 429 rate limited by Gmail API",
  "code": "ADAPTER_ERROR",
  "audit_id": "..."
}
```

---

## Error Codes

| Code | Meaning |
|---|---|
| `POLICY_BLOCKED` | Explicit `allow: false` rule matched |
| `SERVICE_UNKNOWN` | No adapter registered for this service ID |
| `ACTION_UNKNOWN` | Action not supported by this adapter |
| `PARAMS_INVALID` | Missing required params or validation failed |
| `APPROVAL_TIMEOUT` | Approval window expired |
| `APPROVAL_DENIED` | User denied the request |
| `VAULT_ERROR` | Credential retrieval or decryption failed |
| `ADAPTER_ERROR` | Downstream API call failed |
| `SAFETY_ERROR` | LLM safety check call failed (request is blocked for safety) |
| `RATE_LIMITED` | Agent has exceeded rate limit (60 req/min per agent) |

---

## GET /api/gateway/request/:request_id/status

Poll for the current status of a pending or recently resolved request.

```json
{
  "status": "executed",
  "request_id": "...",
  "result": { "summary": "...", "data": [...] },
  "audit_id": "..."
}
```

Returns the same status shapes as above. Returns `404` if the request ID is unknown or too old.

---

## GET /api/services

Service catalog: all supported adapters and their activation status for the authenticated user.

```json
{
  "services": [
    {
      "id": "google.gmail",
      "name": "Gmail",
      "description": "Read and send email via Gmail",
      "oauth": true,
      "status": "activated",
      "activated_at": "2026-02-22T21:00:00Z",
      "actions": ["list_messages", "get_message", "send_message"]
    },
    {
      "id": "github",
      "name": "GitHub",
      "description": "Access GitHub issues, PRs, and code",
      "oauth": false,
      "status": "not_activated",
      "activated_at": null,
      "actions": ["list_issues", "get_issue", "create_issue", "list_prs", "get_pr", "search_code"]
    }
  ]
}
```

`status` values: `activated`, `not_activated`, `credential_expired`.

---

## OAuth Activation

```
GET /api/oauth/start?service=google.gmail[&pending_request_id=<id>]
```

Redirects to the service's OAuth consent URL. After consent:

```
GET /api/oauth/callback?code=...&state=...
```

Exchanges code for tokens, stores in vault, marks service as activated in `service_meta`. If `pending_request_id` was provided, re-evaluates and executes the pending request (if policy allows), then delivers result to its `callback_url`.

---

## Async Callback Delivery

When a request resolves asynchronously (after approval or activation), Clawvisor POSTs to `context.callback_url`:

```json
{
  "request_id": "...",
  "status": "executed",
  "result": { "summary": "...", "data": [...] },
  "audit_id": "...",
  "hmac": "<HMAC-SHA256 of body, keyed by agent token>"
}
```

The `hmac` field allows the callback recipient to verify the delivery is authentic. Verify before processing.

---

## Rate Limits

- Gateway requests: 60 per minute per agent token
- OAuth operations: 5 per minute per user
- Policy API writes: 30 per minute per user

Rate limit headers on every response:
```
X-RateLimit-Limit: 60
X-RateLimit-Remaining: 47
X-RateLimit-Reset: 1740268800
```

`429 Too Many Requests` when exceeded.

---

## Security Notes

- `reason` and `context` fields are **logged but never trusted** for policy decisions. Policy operates on `service` + `action` + `params` only.
- The LLM safety check receives sanitized `params` only — never raw external content.
- Credentials are never present in any response.
- Callback HMAC must be verified by the recipient before acting on the result.
