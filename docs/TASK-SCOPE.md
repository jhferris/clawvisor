# Task-Scoped Authorization — Design Spec

## Problem

The current atomic approval model requires human sign-off on every individual gateway
request that matches a `require_approval` policy. For a task like "review my last 30
iMessage threads," this means 30 separate approvals — completely unusable in practice.

More fundamentally, the current model evaluates each request in isolation. It has no
concept of whether a request is consistent with what the agent was asked to do. An agent
that goes off-script mid-task is indistinguishable from one doing its job.

---

## Concept: Task Scope

Before starting a multi-step task, the agent declares its intent:

> "I am going to review the last 30 iMessage threads and classify their reply status.
> I will need to call `list_threads` and `get_thread` on `apple.imessage`."

The user reviews this declaration and approves the task once. The agent then executes
within the approved scope — all `list_threads` and `get_thread` calls auto-execute
without further prompts.

If the agent attempts an action outside the declared scope (e.g. `send_message`, or
adding `days_back: 365` to read far beyond the stated purpose), Clawvisor blocks it
and surfaces a **scope expansion request** — a lightweight approval for the new action.

This shifts the oversight model from:
- ❌ "Approve this specific request" × N times
- ✅ "Approve this task and what it will do" × 1, with escalation for surprises

---

## What Doesn't Change

- Requests without a `task_id` continue to work exactly as before. Atomic approval
  is the fallback for simple agents and one-off requests. No breaking changes.
- `allow: false` (block) policies are always enforced regardless of task scope.
- Per-action `require_approval` policies for **write actions** still fire individually
  within a task (see below). The task approval covers intent; individual write approvals
  cover specific content (who, what, when).

## Design Decisions

- **Policy-allowed actions skip task approval.** If the agent's policy already yields
  `execute` (allow: true) for a declared action, that action does not require task
  approval — it would execute without approval anyway. The task approval only covers
  actions that would otherwise require approval. This means a task whose every action
  is already policy-allowed needs no approval at all (status goes straight to `active`).
- **Hardcoded approval overrides `auto_execute`.** Actions with hardcoded approval
  requirements (e.g. `apple.imessage:send_message`) reject `auto_execute: true` at
  task creation time with a validation error. The agent must declare them with
  `auto_execute: false`.
- **Explicit `task_id` on every request.** An agent may have multiple active tasks
  concurrently. Each gateway request must include the `task_id` it belongs to; there
  is no implicit "current task" inference.
- **Task expiry fails requests, expansion extends.** When a task's `expires_at` passes,
  subsequent requests with that `task_id` fail with `task_expired`. The agent can issue
  a scope expansion (`POST /api/tasks/{id}/expand`) to extend the task — the expansion
  approval resets `expires_at`. The expiry cleanup goroutine delivers a callback when
  a task expires so the agent learns proactively.
- **`authorized_actions` stored as JSON column** on the `tasks` table, consistent with
  `request_blob` in `pending_approvals`.

---

## Data Model

### Task

```
id            UUID
user_id       → users.id
agent_id      → agents.id
purpose       string     — human-readable statement of intent
status        enum       — pending_approval | active | completed | expired | denied | cancelled
authorized_actions  []TaskAction
created_at    timestamp
approved_at   timestamp (nullable)
expires_at    timestamp (nullable) — set at approval time
request_count int        — number of gateway requests made under this task
audit_ids     []UUID     — all audit entries associated with this task
```

### TaskAction

```
service       string     — e.g. "apple.imessage"
action        string     — e.g. "get_thread", or "*" for all actions on a service
auto_execute  bool       — true: execute without per-request prompts
                           false: task declares intent but per-request approval still fires
```

`auto_execute: false` is for write actions the agent may need but should still require
individual review. The user sees these at task approval time and knows they'll be prompted
for each instance.

Example task declaration:

```json
{
  "purpose": "Review last 30 iMessage threads and classify reply status",
  "authorized_actions": [
    {"service": "apple.imessage", "action": "list_threads", "auto_execute": true},
    {"service": "apple.imessage", "action": "get_thread",   "auto_execute": true}
  ]
}
```

Example with a write action declared upfront:

```json
{
  "purpose": "Draft and send a reply to John Doe about the SF meetup",
  "authorized_actions": [
    {"service": "apple.imessage", "action": "get_thread",   "auto_execute": true},
    {"service": "apple.imessage", "action": "send_message", "auto_execute": false}
  ]
}
```

The user sees at approval time: "This task may send an iMessage. You will be asked to
review the message before it sends."

---

## API

### POST /api/tasks (agent auth)

Declare a task. Validates `authorized_actions` against policy and hardcodes:
- Actions with hardcoded approval (e.g. `apple.imessage:send_message`) reject
  `auto_execute: true` with a `400 INVALID_REQUEST` error.
- If every declared action is already `execute` by policy (no approval needed),
  the task skips approval and goes straight to `active`.
- Otherwise, returns `status: pending_approval`.

**Request:**
```json
{
  "purpose": "Review last 30 iMessage threads and classify reply status",
  "authorized_actions": [
    {"service": "apple.imessage", "action": "list_threads", "auto_execute": true},
    {"service": "apple.imessage", "action": "get_thread",   "auto_execute": true}
  ],
  "expires_in_seconds": 1800
}
```

**Response:**
```json
{
  "task_id": "task-uuid",
  "status": "pending_approval",
  "message": "Task approval requested. Waiting for human review."
}
```

The agent then polls `GET /api/tasks/{task_id}` or waits for a callback (same
`callback_url` mechanism as gateway requests — attach `callback_url` to the task
declaration).

---

### GET /api/tasks (user JWT)

List pending and active tasks. Shown in the dashboard Approvals panel alongside
request-level approvals.

---

### POST /api/tasks/{id}/approve (user JWT)

Approve the task. All `auto_execute: true` actions are now pre-authorized for the
task's duration. Returns the approved task with `expires_at`.

---

### POST /api/tasks/{id}/deny (user JWT)

Deny the task. The agent receives a callback with `status: denied`.

---

### POST /api/tasks/{id}/complete (agent auth)

Agent signals the task is done. Status → `completed`. Frees up the scope. Optional
but good practice.

---

### POST /api/gateway/request — changes

Add optional `task_id` field:

```json
{
  "task_id": "task-uuid",
  "service": "apple.imessage",
  "action": "get_thread",
  "params": {"thread_id": "+15551234567", "max_results": 5},
  "reason": "checking if John Doe's thread needs a reply",
  "request_id": "...",
  "context": {...}
}
```

**Execution logic with task_id:**

1. Look up the task. Verify it's `active`, not expired, and owned by this agent's user.
   If expired, return `{"status": "task_expired", "task_id": "..."}`.
2. Evaluate the policy for this `service/action` (same as non-task requests).
   - **Policy decision is `block`**: blocked regardless of task scope. Task scope
     cannot override block policies.
   - **Policy decision is `execute`**: execute immediately. The action is already
     allowed by policy — task scope is irrelevant. Audit entry is tagged with `task_id`.
   - **Policy decision is `approve`**: proceed to task scope check (step 3).
3. Check the requested `service/action` against `authorized_actions`.
   - **In scope + `auto_execute: true`**: execute immediately (no approval prompt).
     Audit entry is tagged with `task_id`.
   - **In scope + `auto_execute: false`**: follows normal `require_approval` flow, but
     approval notification shows task context ("as part of: Review last 30 threads").
   - **Out of scope**: return `pending_scope_expansion`:
     ```json
     {
       "status": "pending_scope_expansion",
       "task_id": "task-uuid",
       "message": "Action send_message is outside the approved task scope. Use POST /api/tasks/{id}/expand to request it."
     }
     ```
     Agent must explicitly expand scope before retrying.

---

### Scope Expansion

When the agent needs to go beyond the declared scope:

**POST /api/tasks/{id}/expand (agent auth)**

```json
{
  "service": "apple.imessage",
  "action": "send_message",
  "auto_execute": false,
  "reason": "John Doe asked a question that warrants a reply"
}
```

This triggers a notification (same path as approval notifications). The user sees:
"Clawby is requesting scope expansion: add `send_message` to the current task."

On approval, the action is added to `authorized_actions`, `expires_at` is reset
(extending the task's lifetime), and the original request can be retried with the
same `request_id`.

Scope expansion also serves as the mechanism for extending an expired task — the
agent issues an expand request (even with no new actions) and the approval resets
the expiry.

Scope expansion should be rare. If an agent is frequently expanding scope, it suggests
the task was declared too narrowly or the agent is going off-script — both worth surfacing.

---

## New Response Statuses

| Status | Meaning |
|---|---|
| `pending_task_approval` | Task declared but not yet approved |
| `pending_scope_expansion` | Request outside task scope; expansion requested |
| `task_expired` | Task has passed its `expires_at`; agent must expand to extend |

These join the existing: `executed`, `blocked`, `pending`, `pending_activation`, `error`.

---

## Audit

All requests made under a task are tagged with `task_id` in the audit log. The task
detail view shows:
- The declared purpose
- Each request made, in order, with params
- Any scope expansion requests
- Duration from approval to completion

This creates a narrative audit trail: "here's what Clawby said it would do, here's
exactly what it did."

---

## Enforcement: Out-of-Scope Detection

Two levels:

**Structural (deterministic):** The `service/action` is not in `authorized_actions`.
Always blocked, always surfaces an expansion request. No ambiguity.

**Semantic (LLM-based, optional):** The action is in `authorized_actions` but the
parameters look inconsistent with the stated purpose. Example: task purpose is "review
last 30 threads" but the agent calls `get_thread` with `days_back: 365`. This is
technically in scope (action is `get_thread`) but parametrically inconsistent with the
purpose.

Semantic enforcement uses Clawvisor's existing LLM safety check (Phase 4). The check
receives the task `purpose` as context: "Does this request look consistent with the
stated purpose?" If the safety check flags it, the request enters approval rather than
auto-executing.

Semantic enforcement is best-effort and on by default.

---

## Backwards Compatibility

- All existing behavior for requests without `task_id` is unchanged.
- Agents that don't declare tasks continue to work via atomic approvals.
- Policies still apply in both modes. Task scope is additive, not a bypass.
- SKILL.md gets a new section documenting task declaration. The catalog endpoint
  can note which services are well-suited to task-scoped access.

---

## Implementation Order

1. **Task CRUD + approval flow** — `POST /api/tasks`, `GET /api/tasks`,
   `POST /api/tasks/{id}/approve|deny`. Notifications via existing approval
   notification path.

2. **Gateway `task_id` enforcement** — structural check (in/out of scope). This is
   the core value.

3. **Scope expansion** — `POST /api/tasks/{id}/expand` + expansion approval flow.

4. **Task audit view** — tag audit entries with `task_id`, add task detail page
   to dashboard.

5. **Semantic enforcement** — optional, on top of structural. Reuse Phase 4 LLM
   safety check with task purpose as context.
