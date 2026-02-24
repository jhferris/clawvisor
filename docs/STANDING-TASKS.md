# Standing Tasks — Design

## Problem

Clawvisor's current authorization model has two mechanisms:

- **Policies** — standing rules that auto-allow or block actions indefinitely.
  Convenient for trusted patterns but coarse: no scope enforcement on params,
  no declared purpose, no per-workflow audit trail.
- **Tasks** — ephemeral, purpose-bound authorizations for a session. Scope-
  enforced, but expire after use. Painful for recurring workflows.

This creates a gap: recurring agent behaviors (e.g. "check my calendar every
morning") have to choose between a broad policy (no param enforcement) or a
new task approval every day (high friction). Neither is right.

---

## Proposal: Two Task Lifetime Types

Extend tasks with a `lifetime` field:

| `lifetime` | Behavior |
|---|---|
| `session` | Current default. Expires after `expires_in_seconds`. |
| `standing` | Approved once. Permanent until revoked. Scope enforced on every run. |

A standing task is callable on-demand by the agent any number of times.
The agent decides when to call — Clawvisor decides whether the call is
authorized. Scheduling is the agent's concern, not Clawvisor's.

---

## Param Constraints

Standing (and session) tasks support optional **param constraints** per
action. These constrain what parameter values the agent may pass, even on
an auto-approved action within the task scope.

```json
{
  "authorized_actions": [
    {
      "service": "google.calendar",
      "action": "list_events",
      "auto_execute": true,
      "param_constraints": {
        "from": "today",
        "to": "today",
        "max_results": 20
      }
    }
  ]
}
```

If the agent submits a request with params that violate the constraints
(e.g. `from: 2020-01-01`), the gateway rejects it with `SCOPE_VIOLATION`
and does not execute the action — even though the action is within the task's
`authorized_actions`.

### Constraint value types

| Type | Example | Meaning |
|---|---|---|
| Literal | `"primary"` | Param must equal this exact value |
| Dynamic | `"today"` | Resolved at request time (`today` → current date) |
| Dynamic | `"tomorrow"` | Resolved at request time |
| Range | `{"max": 20}` | Numeric upper bound |
| Allowlist | `["primary", "work"]` | Param must be one of these values |
| Absent | `null` | Param must not be present |

Dynamic values are resolved server-side at the time of each request, not at
task creation time. This is what makes "only today's events" enforceable on
a standing daily task.

---

## API Changes

### `POST /api/tasks`

Add `lifetime` field:

```json
{
  "purpose": "Check my calendar every morning",
  "lifetime": "standing",
  "authorized_actions": [
    {
      "service": "google.calendar",
      "action": "list_events",
      "auto_execute": true,
      "param_constraints": {
        "from": "today",
        "to": "today",
        "max_results": 20
      }
    }
  ]
}
```

`expires_in_seconds` is only valid when `lifetime` is `session`. It is
ignored (and should be rejected) for standing tasks.

### `POST /api/tasks/{id}/revoke`

Revokes a standing task immediately. No further executions allowed.
This is the undo for a standing approval.

### `GET /api/tasks` (dashboard)

Returns all tasks. Standing tasks appear as a distinct section from session
tasks, showing last-run time and total run count.

---

## Approval Flow

Standing tasks go through the same approval flow as session tasks. The
approval card makes the lifetime explicit:

> **Standing task** — will remain active until you revoke it.
> Actions and param constraints are enforced on every run.

This prevents the user from accidentally approving a permanent authorization
when they thought they were approving a one-time thing.

---

## Scope Enforcement on Every Run

For a `session` task, scope enforcement runs during the task's active window.
For `standing` tasks, scope enforcement runs on **every gateway request**,
even after the task has been running for months.

If the agent submits a request that violates scope (wrong action, wrong
service, or param constraint violation), the gateway rejects it with the
appropriate status. It does not silently execute or accumulate scope drift
over time.

---

## Implementation Notes

- `lifetime` defaults to `"session"` if omitted — no breaking change.
- Standing task run history should be stored (timestamp, request count,
  actions used) for audit purposes.
- A `SCOPE_VIOLATION` audit entry (distinct from `restricted`) should be
  created whenever a param constraint is violated — useful for detecting
  scope creep or agent misbehavior.
- Param constraint validation happens in the gateway layer, before the
  adapter is called.
