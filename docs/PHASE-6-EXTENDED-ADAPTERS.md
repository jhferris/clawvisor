# Phase 6: Extended Adapters

## Goal
Expand beyond Gmail to cover the core Google Workspace services and GitHub. After this phase, Clawvisor is genuinely useful as a daily driver for a personal AI assistant.

---

## Deliverables
- Google Calendar adapter
- Google Drive adapter
- Google Contacts adapter (also enables `recipient_in_contacts` policy condition)
- GitHub adapter (API key, not OAuth)
- Unified Google OAuth flow (single consent covering all Google scopes)
- Dashboard updates: service cards for each new adapter

---

## Unified Google OAuth

Gmail, Calendar, Drive, and Contacts all use the same Google OAuth2 client. Rather than separate consent flows per service, a single OAuth flow requests all needed scopes at once. The credential (access/refresh token) is shared across all `google.*` adapters.

**Implementation:**
- Single vault entry keyed `google` (not `google.gmail`, `google.calendar` etc.)
- All Google adapters retrieve credential from `vault.Get(userID, "google")`
- Scopes requested at consent time are additive — activating Calendar when Gmail is already active triggers a re-consent with expanded scopes
- `service_meta` table records each `google.*` service separately (for UI status), but they share one vault entry

**Scope list (cumulative):**
```
gmail.readonly
gmail.send
calendar.readonly
calendar.events      (create/update/delete — gated by policy)
drive.readonly
drive.file           (agent-created files only)
contacts.readonly
```

**Dashboard flow:** "Activate Google Services" — single button, one consent screen covering all Google scopes. Individual service cards show their own status derived from whether `google` credential exists in vault.

---

## Google Calendar Adapter (`internal/adapters/google/calendar/`)

**Service ID:** `google.calendar`

**Actions:**

| Action | Params | Returns |
|---|---|---|
| `list_events` | `calendar_id` (default: "primary"), `time_min`, `time_max`, `max_results` | Events in range, semantic summary |
| `get_event` | `calendar_id`, `event_id` | Full event details |
| `create_event` | `calendar_id`, `summary`, `start`, `end`, `description`, `attendees` | Created event |
| `update_event` | `calendar_id`, `event_id`, `summary?`, `start?`, `end?`, `description?` | Updated event |
| `delete_event` | `calendar_id`, `event_id` | Confirmation |
| `list_calendars` | _(none)_ | User's calendar list |

**Semantic result example (list_events):**
```json
{
  "summary": "3 events in the next 24 hours",
  "data": [
    {
      "id": "evt-abc",
      "summary": "Team standup",
      "start": "2026-02-23T09:00:00-08:00",
      "end": "2026-02-23T09:30:00-08:00",
      "location": "Zoom",
      "attendees": ["alice@co.com", "bob@co.com"],
      "status": "confirmed"
    }
  ]
}
```

---

## Google Drive Adapter (`internal/adapters/google/drive/`)

**Service ID:** `google.drive`

**Actions:**

| Action | Params | Returns |
|---|---|---|
| `list_files` | `query` (Drive search syntax), `max_results` | File list with metadata |
| `get_file` | `file_id` | File metadata + content preview (text files only, first 2000 chars) |
| `create_file` | `name`, `content`, `mime_type`, `parent_folder_id?` | Created file metadata |
| `update_file` | `file_id`, `content` | Updated file metadata |
| `search_files` | `query` | Semantic search results |

**Security note:** `get_file` returns content preview for text MIME types only (`text/plain`, `text/markdown`, `application/json`). Binary files return metadata only. Content is truncated at 2000 characters.

---

## Google Contacts Adapter (`internal/adapters/google/contacts/`)

**Service ID:** `google.contacts`

**Actions:**

| Action | Params | Returns |
|---|---|---|
| `list_contacts` | `max_results` | Contact list (name, email, phone) |
| `get_contact` | `contact_id` | Full contact details |
| `search_contacts` | `query` | Contacts matching name or email |

**Enables policy condition:** `recipient_in_contacts`

The evaluator's `recipient_in_contacts` condition is pre-resolved by the gateway handler before `Evaluate` is called. Once the Contacts adapter is activated, the gateway handler resolves the condition and passes the result in `req.ResolvedConditions`:

```go
// internal/api/handlers/gateway.go — pre-resolution before Evaluate
resolvedConditions := map[string]bool{}
if needsRecipientInContacts(decision candidate rules) && contactsAdapter != nil {
    inContacts, err := contactsAdapter.IsInContacts(ctx, userID, req.Params["to"])
    if err == nil {
        resolvedConditions["recipient_in_contacts"] = inContacts
    }
    // On error: leave absent → evaluator defaults to false → routes to approval
}

decision := policyRegistry.Evaluate(userID, policy.EvalRequest{
    ...
    ResolvedConditions: resolvedConditions,
})
```

The evaluator itself remains a pure function with no I/O. See PHASE-2 for the `EvalRequest.ResolvedConditions` field and evaluator algorithm.

---

## GitHub Adapter (`internal/adapters/github/`)

**Service ID:** `github`

**Auth:** API key (Personal Access Token), not OAuth. Dashboard shows a password input modal instead of OAuth button.

**Vault entry:** `vault.Set(userID, "github", {type: "api_key", key: "ghp_..."})`

**Actions:**

| Action | Params | Returns |
|---|---|---|
| `list_issues` | `owner`, `repo`, `state` (open/closed/all), `labels`, `assignee`, `max_results` | Issue list |
| `get_issue` | `owner`, `repo`, `number` | Full issue details + comments |
| `create_issue` | `owner`, `repo`, `title`, `body`, `labels`, `assignees` | Created issue |
| `comment_issue` | `owner`, `repo`, `number`, `body` | Created comment |
| `list_prs` | `owner`, `repo`, `state`, `max_results` | PR list |
| `get_pr` | `owner`, `repo`, `number` | PR details + review status |
| `list_repos` | `org?` (defaults to authenticated user) | Repository list |
| `search_code` | `query`, `repo?` | Code search results |

**Semantic result example (list_issues):**
```json
{
  "summary": "5 open issues in owner/repo, 2 assigned to you",
  "data": [
    {
      "number": 42,
      "title": "Fix authentication bug",
      "state": "open",
      "labels": ["bug", "priority:high"],
      "assignees": ["ericjlevine"],
      "created_at": "2026-02-20T10:00:00Z",
      "url": "https://github.com/owner/repo/issues/42"
    }
  ]
}
```

---

## Dashboard Updates

Each new service gets a card in the service catalog. Cards are defined in the adapter and exposed via `GET /api/services` — the dashboard doesn't need to hardcode service info.

```go
// Part of Adapter interface (addition):
Metadata() ServiceMetadata

type ServiceMetadata struct {
    ID          string
    Name        string
    Description string
    Icon        string   // SVG or emoji fallback
    OAuthBased  bool
    Docs        string   // link to setup docs
}
```

---

## Policy Examples (starter set, shipped with skill)

```yaml
# google-workspace-safe.yaml
id: google-workspace-safe
name: Google Workspace — safe defaults
description: Read-only access to all Google services; write operations require approval
rules:
  - service: google.gmail
    actions: [list_messages, get_message]
    allow: true
  - service: google.gmail
    actions: [send_message]
    require_approval: true
  - service: google.gmail
    actions: [delete_message, modify_message]
    allow: false

  - service: google.calendar
    actions: [list_events, get_event, list_calendars]
    allow: true
  - service: google.calendar
    actions: [create_event, update_event, delete_event]
    require_approval: true

  - service: google.drive
    actions: [list_files, get_file, search_files]
    allow: true
  - service: google.drive
    actions: [create_file, update_file]
    require_approval: true

  - service: google.contacts
    actions: [list_contacts, get_contact, search_contacts]
    allow: true

# github-read-only.yaml
id: github-readonly
name: GitHub — read only
rules:
  - service: github
    actions: [list_issues, get_issue, list_prs, get_pr, list_repos, search_code]
    allow: true
  - service: github
    actions: [create_issue, comment_issue]
    require_approval: true
```

---

## Success Criteria
- [ ] Calendar: agent can list events for the next 24 hours
- [ ] Calendar: creating an event routes to approval, executes on approval
- [ ] Drive: agent can list and preview text files
- [ ] Contacts: `recipient_in_contacts` condition works when Google is activated
- [ ] GitHub: activated with PAT, agent can list issues and PRs
- [ ] All adapters share one Google credential (single OAuth consent)
- [ ] Adding Calendar scope re-prompts consent when Gmail was already activated
- [ ] Dashboard shows all 5 services with correct activation status
- [ ] Starter policy set ships with the OpenClaw skill and installs correctly
