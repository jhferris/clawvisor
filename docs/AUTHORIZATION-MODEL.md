# Authorization Model — Redesign

## Current State

Clawvisor's current authorization model has two mechanisms that partially
overlap:

- **Policies** — YAML rules with `allow`, `require_approval`, and `block`
  verbs. Standing permissions, no expiry, no param enforcement, no declared
  purpose.
- **Tasks** — ephemeral, purpose-bound authorizations with scope enforcement
  and optional param constraints. Require a fresh approval each session.

The problem: `allow: true` in a policy and `auto_execute: true` in a task are
doing the same thing through different mechanisms. The two concepts overlap,
which makes the trust model harder to reason about and harder to explain to
users.

---

## Proposed Model

Replace policies with two distinct, non-overlapping primitives:

### 1. Tasks (grants)

Tasks express what the agent *is allowed to do* — for a session, on a
permanently. See `STANDING-TASKS.md` for the full spec.

Tasks are the *only* way to grant an agent permission to execute an action.
No task → no execution. Default behavior for any action without a covering
task is `require_approval` (the agent is prompted to create a task).

Tasks can be:
- **Session** — ephemeral, expires in N seconds
- **Standing** — approved once, permanent until revoked

All tasks enforce scope (which actions) and optionally enforce param
constraints (which parameter values). Approval is always explicit — the user
sees the purpose, actions, and constraints before approving.

### 2. Restrictions (prohibitions)

Restrictions express what the agent *can never do*, regardless of any task
that might otherwise authorize it.

Restrictions are the *only* remaining use case for the old "policy" concept.
They are hard overrides: a restriction cannot be bypassed by any task,
regardless of lifetime or who approved it.

```yaml
restrictions:
  - service: google.calendar
    action: delete_event
    reason: "Calendar events should never be deleted by an agent"

  - service: google.gmail
    action: send_message
    recipient_domain: "*.competitor.com"
    reason: "Never send email to competitor domains"
```

Restrictions are evaluated *after* task scope is checked. If a task authorizes
an action but a restriction matches, the request is blocked with status
`restricted` — distinct from `blocked` (old policy block) in the audit log.

---

## Why Tasks Supersede Allow Policies

| Old policy | New equivalent | Improvement |
|---|---|---|
| `allow: true` (standing permission) | `standing` task, `auto_execute: true` | Has declared purpose, audit trail per run, revocable |
| `allow: true` + implicit param scope | `standing` task + `param_constraints` | Explicit param enforcement; agent cannot exceed approved scope |
| `require_approval: true` | Default behavior (no task, no restriction) | No configuration needed |
| `allow: false` (block) | Restriction | Clearer semantics; lives outside the task system |

The key improvement of tasks over allow policies: the user approves a
*specific behavior* ("check today's calendar"), not a *broad capability*
("read calendar"). Param constraints make the scope of approval concrete and
machine-enforced, not just implicit.

---

## Default Stance

Without any tasks or restrictions configured:

- All actions → `require_approval` (agent must create a task; user approves)
- No action is ever auto-executed without explicit task authorization

This is a zero-trust default. A new user who activates a service gets
meaningful protection immediately, without configuring anything. The task
system teaches them what the agent is doing before they've decided to trust
it at scale.

---

## What Happens to Existing Policy Concepts

| Old concept | Disposition |
|---|---|
| `allow: true` | Removed. Use a standing task. |
| `require_approval: true` | Removed. This is now the default. |
| `allow: false` | Renamed to restriction. Moved to its own config section. |
| Policy YAML file | Replaced by two separate concepts: tasks (in DB) and restrictions (in config or DB) |

Restrictions remain human-editable config (YAML or dashboard) because they
are standing prohibitions that should be easy to audit and version-control.

Tasks are stored in the database (they have state, history, run counts,
approval timestamps) and managed via the dashboard and API.

---

## Layered Defense

With this model, authorization has two independent control points:

```
Request
  │
  ├─ Is there an active task covering this action + params?
  │     No  → require_approval (agent creates a task; user approves)
  │     Yes ↓
  │
  ├─ Does a restriction match?
  │     Yes → blocked (status: restricted) — no task can override this
  │     No  ↓
  │
  └─ Execute
```

This is strictly stronger than the old model because:
1. Tasks enforce *both* which actions and which param values are allowed
2. Restrictions are independent of tasks — a compromised agent that creates
   its own tasks cannot bypass a restriction
3. The default (no task) is `require_approval`, not silent execution

---

## Migration

### For existing users with allow policies

Each allow policy becomes a standing task. The migration assistant (or a
one-time setup flow) can auto-convert:

```
Found 3 allow policies. Convert them to standing tasks?

  google.gmail: list_messages, get_message → standing task "Gmail read access"
  google.calendar: list_events, get_event  → standing task "Calendar read access"
  apple.imessage: list_threads, get_thread → standing task "iMessage read access"

[Convert] [Review individually] [Skip]
```

The user reviews and approves each converted task. The approval is now
explicit and purposeful rather than implicit in a YAML file.

### For existing users with block policies

Each block policy becomes a restriction. This is a mechanical rename — no
behavior change, no approval needed.

### For new users

No migration needed. Tasks and restrictions are the only primitives from day
one.

---

## Open Questions

1. **Restrictions in config vs. DB** — YAML config is easy to version-control
   and audit, but the dashboard can't edit files. Options: restrictions live
   in DB (manageable from dashboard) with optional export to YAML, or YAML
   only with a CLI to manage them.

2. **Restriction granularity** — the examples above show action-level
   restrictions. Should restrictions support param-level matching too? (e.g.
   "never send email to @competitor.com" requires inspecting the `to` param.)
   More powerful but more complex to configure.

3. **Task creation UX for one-off queries** — "what's on my calendar today?"
   doesn't warrant a standing task. The agent could auto-create a
   single-action session task with a 5-minute expiry, collapsing the
   approval to a single tap. Or the dashboard could offer a "quick approve"
   flow. Either way, one-off reads shouldn't require full task setup overhead.

4. **Who can create restrictions** — should agents be able to propose
   restrictions? Probably not (a restriction is a user-level control), but
   it's worth stating explicitly.
