# Multi-Account Services — Design

## Problem

Clawvisor currently models service activations as a unique `(user, service_type)`
pair — one credential per service type per user. This prevents common real-world
setups where a user has multiple accounts for the same service (e.g., a personal
Gmail inbox and a work Gmail inbox, or two Slack workspaces).

This document specifies how to extend the model to support one-to-many mappings
from users to service accounts.

---

## Design

### Core concept: aliases

Each service activation gains an optional `alias` — a short, human-readable name
that distinguishes one account from another when multiple instances of the same
service are active.

Examples:
- `google.gmail` → alias `personal`
- `google.gmail` → alias `work`
- `slack` → alias `acme-corp`
- `slack` → alias `side-project`

The alias is set by the user at activation time. It defaults to `"default"` if
omitted, preserving full backward compatibility for single-account users.

### Uniqueness constraint

The activation uniqueness constraint changes from:

```
UNIQUE(user_id, service_type)
```

to:

```
UNIQUE(user_id, service_type, alias)
```

This allows multiple activations of the same service as long as each has a
distinct alias.

### How agents address accounts

Agents specify the target account by appending the alias to the service name
with a colon separator:

```
google.gmail:personal
google.gmail:work
slack:acme-corp
```

When no alias is specified, the server resolves to the `"default"` activation
for that service (if one exists). This keeps existing agent prompts and policies
working without modification.

---

## API Changes

### Activation / OAuth flow

`POST /api/services/activate`

Add optional `alias` field:

```json
{
  "service": "google.gmail",
  "alias": "work"
}
```

If `alias` is omitted, defaults to `"default"`.

The OAuth callback must carry the alias through the state parameter so it can
be stored on the resulting credential record.

### Gateway requests

The `service` field in gateway requests already carries the service name string.
No structural change needed — the agent simply includes the alias in the string:

```json
{
  "service": "google.gmail:work",
  "action": "send_message",
  "params": { ... }
}
```

The gateway splits on `:` to resolve `(service_type, alias)` → credential.

If the service string contains no `:`, alias is treated as `"default"`.

### Policy rules

Policy rules can scope to a specific alias using the same colon syntax in the
`service` field:

```yaml
service: google.gmail:work
action: send_message
allow: true
require_approval: true
```

A rule with `service: google.gmail` (no alias) matches all aliases for that
service type, making it easy to write blanket policies that cover all accounts.

Rule specificity: a rule with an explicit alias takes precedence over a wildcard
rule for the same service type. Otherwise normal rule matching applies.

### Skill catalog

`GET /api/skill/catalog`

Each active service entry should include the alias so the agent knows which
name to use when addressing it:

```
### google.gmail:personal
Actions: list_threads, get_message, send_message, ...

### google.gmail:work
Actions: list_threads, get_message, send_message, ...
```

---

## Dashboard UX

### Service list

The services page lists each activation as a separate row, showing both service
type and alias. For single-account users (alias = `"default"`), the alias is
omitted from the display to avoid visual clutter.

### Adding a second account

An "Add account" button (or equivalent) on a service row launches the OAuth
flow for that service with a prompt for the alias name before redirecting.
Validation: alias must be non-empty, alphanumeric plus hyphens, unique per
`(service_type)` for this user.

### Removing an account

Each activation row has its own remove/deactivate action. Removing one account
does not affect others for the same service.

---

## Migration

Existing activations have no `alias` column. The migration:

1. Add `alias VARCHAR(64) NOT NULL DEFAULT 'default'` to the service activations
   table.
2. Drop the old `UNIQUE(user_id, service_type)` constraint.
3. Add `UNIQUE(user_id, service_type, alias)`.

No data changes needed — all existing rows get alias `"default"` and continue
working exactly as before.

---

## Backward Compatibility

- Agents that don't include an alias continue to work — requests routed to
  the `"default"` activation.
- Policies without an alias continue to match all accounts for that service type.
- The catalog includes alias in names only when more than one activation exists
  for a given service type (or always — implementer's choice; always is simpler).
- The `/api/skill/catalog` response should note if multiple accounts are active
  so the agent is aware it must specify an alias to avoid ambiguity.

---

## Implementation Notes

- Alias validation: `^[a-z0-9][a-z0-9-]{0,62}$` (lowercase, alphanumeric,
  hyphens, max 63 chars). Reject at API layer.
- The colon separator in service strings is already a reserved character in
  the existing service name namespace (no service type uses `:`) — safe to adopt.
- When multiple activations exist and no alias is given in a request, the server
  should return a descriptive error (not silently pick one):
  `"Multiple accounts active for google.gmail; specify an alias (e.g. google.gmail:personal)"`
- The `"default"` alias is a special value — if a user has only one account and
  didn't supply an alias at activation, it's `"default"`. If they later add a
  second account, the first remains addressable as both `google.gmail` and
  `google.gmail:default`.
