# Clawvisor — Approval Flow

## When Approval Is Sought

A request enters the approval queue when any of the following are true:
1. No policy rule matches the request (default: seek approval, not block)
2. A matching rule has `require_approval: true`
3. The LLM safety check flags the request as suspicious

A request is immediately blocked (no approval queue) when:
1. An explicit `allow: false` rule matches

---

## Notification Channels

Approval notifications are per-user and configurable. Two channels run simultaneously — the first response (from either channel) resolves the request:

**Telegram** — inline approve/deny buttons sent to the user's configured chat.

**Dashboard** — pending approvals appear in real-time in the Clawvisor web UI. The user can approve or deny from the browser without opening Telegram.

Notification configs are stored per user in the `notification_configs` table. Telegram is configured in Settings; the dashboard is always available.

---

## Approval Notification (Telegram)

```
🔔 Clawvisor Approval Request

Agent: my-agent
Service: google.gmail
Action: send_message
Time: Sun Feb 22 2026, 2:14 PM PST

Parameters:
  to: sister@example.com
  subject: Dinner plans
  body: Hey, are you free Thursday?...

Agent's stated reason:
  "Replying to sister's dinner email per your instructions"

Data context:
  Processing: gmail:msg-abc123

⚠️ No policy covers this action.

[✅ Approve]  [❌ Deny]
```

If the request was flagged by the LLM safety check, that appears instead of the policy note:

```
🔴 Safety check flagged this request:
  "Request to send email made while processing content from an
   unknown domain — possible injection attempt."
```

---

## Service Activation Notification

When a request arrives for a service the user hasn't activated yet:

```
🔔 Clawvisor — Service Activation Required

Agent: my-agent wants to use: GitHub
Requested action: list_issues

[🔗 Activate GitHub]  [❌ Deny]
```

"Activate GitHub" links to `/api/oauth/start?service=github&pending_request_id=...` (or opens an API key modal for non-OAuth services). After activation, the pending request re-evaluates and executes automatically if policy allows.

---

## Approval States

```
pending → approved → executed → logged + callback delivered
        → denied   → logged + callback delivered
        → timeout  → logged + callback delivered
```

All state transitions are logged in the audit log. The callback URL (`context.callback_url` from the original request) is notified on every terminal state.

---

## Timeout Behavior

Controlled by `approval.timeout` (default: 300 seconds, configurable per user).

`approval.on_timeout`:
- `"fail"` (default) — agent receives `timeout` status; it knows the action didn't happen
- `"skip"` — request silently expires; use only for non-critical background tasks

On timeout, the Telegram message and dashboard card are updated to show expiry. Buttons are removed.

---

## Persistence

Pending approvals are stored in the database (`pending_approvals` table). They survive server restarts:
- On startup, Clawvisor re-registers Telegram callback listeners for all pending items
- Approval messages in Telegram remain interactive after restart
- Dashboard shows pending approvals from DB on load

Pending approvals are cleaned up on resolution or expiry. A background goroutine runs every minute to expire timed-out approvals and deliver timeout callbacks.

---

## Security

- Telegram callbacks are validated: the `callback_data` contains the `request_id`; Clawvisor verifies it matches a pending approval owned by the correct user
- Dashboard approve/deny calls require a valid user JWT — users can only act on their own approvals
- First response wins — if the user approves in Telegram and simultaneously in the dashboard, only the first is processed; the second is a no-op
- Clawvisor never auto-approves. Only an explicit human action resolves a pending approval.
- `request_id` is one-time use — once resolved, the same ID cannot be re-approved

---

## Future: Time-Boxed Auto-Approval

A future version will support configurable auto-approval windows — useful for travel or pre-authorized tasks:

```yaml
auto_approve:
  service: google.gmail
  action: send_message
  window:
    until: "2026-03-01T00:00:00-08:00"
  reason: "Travel week — pre-approved email replies"
```

This will be managed through the dashboard, not config files.
