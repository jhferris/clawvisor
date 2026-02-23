# Clawvisor — Semantic Formatting

## Purpose

Every adapter returns a `SemanticResult` — a cleaned, structured summary of the API response — rather than raw API output. This serves three purposes:

1. **Security** — raw API responses contain noise that can carry injection payloads (HTML, base64 blobs, hidden Unicode, adversarial metadata). The formatter strips this before anything else sees it.
2. **LLM safety check quality** — the safety checker operates on the formatted result, not the raw API blob. Clean, structured data makes anomaly detection more reliable.
3. **Usability** — the agent receives what it actually needs to complete the task, not raw JSON with pagination tokens, OAuth headers, and 47 fields it doesn't use.

---

## SemanticResult Type

```go
type SemanticResult struct {
    Summary string `json:"summary"`   // always present; human-readable one-liner
    Data    any    `json:"data"`       // structured, schema varies by adapter action
}
```

`Summary` is a natural language description the agent can use directly. `Data` is structured for programmatic use. Both are returned to the agent.

**Example:**
```json
{
  "summary": "3 unread emails: sister (dinner tonight), Alex (meeting rescheduled), newsletter from Stripe",
  "data": [
    {
      "id": "msg-abc123",
      "from": "sister@example.com",
      "subject": "dinner tonight",
      "snippet": "Hey, are you free...",
      "timestamp": "2026-02-22T19:00:00Z",
      "is_unread": true
    }
  ]
}
```

---

## Formatting Rules

### What is always stripped

- OAuth tokens, API keys, session cookies — anything that looks like a credential
- Raw base64-encoded content blobs (e.g. Gmail message bodies in base64 before decoding)
- Internal API metadata: pagination cursors, ETags, resource versions, HTTP headers
- Redundant nesting that adds no information (e.g. `{items: [{item: {id: ...}}]}`)
- Empty or null fields unless they carry meaning
- HTML markup — converted to plain text before returning
- Dangerous Unicode: zero-width characters, bidirectional overrides, tag characters, variation selectors (used to hide injection payloads in HTML email)

### Content length limits

| Field | Limit | Rationale |
|---|---|---|
| Email/doc body | 2000 chars | Enough for context, limits injection surface |
| Snippet/preview | 300 chars | Summary use only |
| Single string field | 500 chars | Prevents oversized individual values |
| `data` array length | 50 items | Prevents overwhelming context window |
| Total `data` serialized | 100KB | Hard cap |

Content exceeding limits is truncated with a note: `"[truncated at 2000 chars]"`.

### What is preserved

- IDs needed for follow-up actions (message IDs, event IDs, file IDs)
- Timestamps in ISO 8601
- Human-readable fields: names, subjects, titles, descriptions (within length limits)
- Status fields: read/unread, accepted/declined, open/closed
- Relationships: from/to/cc, attendees, assignees

---

## Per-Adapter Formatting

### google.gmail

**list_messages:**
```json
{
  "summary": "N messages found (M unread). First K shown.",
  "data": [
    {
      "id": "string",
      "from": "string",
      "subject": "string",
      "snippet": "string (300 chars max)",
      "timestamp": "ISO 8601",
      "is_unread": true
    }
  ]
}
```

**get_message:**
```json
{
  "summary": "Email from {from}: \"{subject}\"",
  "data": {
    "id": "string",
    "from": "string",
    "to": "string",
    "subject": "string",
    "timestamp": "ISO 8601",
    "body": "string (2000 chars max, HTML stripped, dangerous Unicode removed)",
    "is_unread": true,
    "thread_id": "string"
  }
}
```

HTML is converted to plain text. Dangerous Unicode (zero-width, BiDi overrides) is removed before the body is returned. The 2000-character limit applies to the cleaned plain text.

**send_message:**
```json
{
  "summary": "Email sent to {to} (subject: \"{subject}\")",
  "data": {
    "message_id": "string",
    "to": "string",
    "subject": "string"
  }
}
```

---

### google.calendar

**list_events:**
```json
{
  "summary": "N events in the next 24 hours",
  "data": [
    {
      "id": "string",
      "summary": "string",
      "start": "ISO 8601",
      "end": "ISO 8601",
      "location": "string or null",
      "attendees": ["email1", "email2"],
      "status": "confirmed | tentative | cancelled"
    }
  ]
}
```

**create_event / update_event:**
```json
{
  "summary": "Event \"{title}\" created/updated for {start}",
  "data": { "id": "string", "summary": "string", "start": "ISO 8601", "end": "ISO 8601" }
}
```

---

### google.drive

**list_files / search_files:**
```json
{
  "summary": "N files found",
  "data": [
    {
      "id": "string",
      "name": "string",
      "mime_type": "string",
      "modified_at": "ISO 8601",
      "size_bytes": 12345
    }
  ]
}
```

**get_file:**
```json
{
  "summary": "File \"{name}\" ({mime_type})",
  "data": {
    "id": "string",
    "name": "string",
    "mime_type": "string",
    "modified_at": "ISO 8601",
    "content": "string (2000 chars, text files only) | null (binary files)"
  }
}
```

Binary files (images, PDFs, executables) return `content: null`. Only `text/plain`, `text/markdown`, `application/json`, `text/csv` return content previews.

---

### github

**list_issues / list_prs:**
```json
{
  "summary": "N open issues in {owner}/{repo}",
  "data": [
    {
      "number": 42,
      "title": "string",
      "state": "open | closed",
      "labels": ["string"],
      "assignees": ["string"],
      "created_at": "ISO 8601",
      "url": "string"
    }
  ]
}
```

**get_issue:**
```json
{
  "summary": "Issue #{number}: \"{title}\" ({state})",
  "data": {
    "number": 42,
    "title": "string",
    "state": "string",
    "body": "string (2000 chars max)",
    "labels": ["string"],
    "assignees": ["string"],
    "comments_count": 5,
    "created_at": "ISO 8601",
    "url": "string"
  }
}
```

Issue and PR bodies are truncated at 2000 characters. Comment bodies follow the same limit.

---

## Formatting and the LLM Safety Check

The safety check receives the `SemanticResult` **after** formatting, never before. This is intentional:

- Raw email bodies can contain injection payloads designed to manipulate the safety check itself
- Formatted output has dangerous Unicode stripped, HTML converted, and length-capped — a meaningfully smaller attack surface
- The safety check is evaluating "does this structured result look like the output of an injection attack?" — clean structure helps it do that accurately

The safety check does **not** re-format or modify the result. It only decides: safe or flag.

---

---

## Response Filters

On top of the baseline semantic formatter (which every response passes through), users define **response filters** in their policies that control exactly what data reaches each agent role.

### Pipeline Position

```
Raw API response
  → Semantic Formatter      baseline cleanup: HTML stripped, dangerous Unicode removed,
                            credentials stripped, length caps applied
  → Structural Filters      deterministic: field removal, redaction, truncation
  → Semantic Filters        LLM best-effort: natural language instructions
  → LLM Safety Check        reviews the final filtered output
  → Agent receives result
```

Structural filters always run before semantic filters. The safety check always sees the fully filtered output.

### Structural Filters (deterministic)

Applied in declaration order. Fast, no LLM, results are auditable and reproducible.

| Filter | YAML | Behavior |
|---|---|---|
| Built-in redaction | `redact: email_address` | Replaces all matches with `[redacted]`. Built-ins: `email_address`, `phone_number`, `credit_card`, `ssn`, `api_key`, `bearer_token` |
| Regex redaction | `redact_regex: "pattern"` | Redacts custom pattern matches |
| Field removal | `remove_field: body` | Removes field entirely from `data`. Supports dot notation: `remove_field: data.attachments` |
| Field truncation | `truncate_field: body` + `max_chars: 200` | Trims field value to N chars, appends `[truncated]` |

**Example:**
```yaml
response_filters:
  - redact: email_address
  - redact: phone_number
  - remove_field: data.raw_headers
  - truncate_field: data.body
    max_chars: 500
```

### Semantic Filters (LLM best-effort)

Natural language instructions applied by an LLM after structural filters. Non-deterministic — results may vary. Labeled clearly in the audit log as `filter_type: semantic`.

The LLM receives: the instruction, the current `SemanticResult`, and a constrained prompt. It returns a modified result. It cannot add data that wasn't in the original result — only remove or redact.

**Important:** semantic filters are a best-effort usability feature, not a security guarantee. The structural layer and safety check provide the security properties. Semantic filter failures (model errors, ambiguous instructions) are non-fatal — the request proceeds with the pre-semantic-filter result, and the failure is logged.

**Example:**
```yaml
response_filters:
  - semantic: "exclude newsletters and marketing emails"
  - semantic: "if any file appears confidential or proprietary, return only its name and date, not its content"
  - semantic: "for calendar events I am marked as optional attendee, return only the title and time"
```

### Per-Role Filter Configuration

Response filters are defined on policy rules and apply when that rule matches. Since rules can be role-targeted, filters are naturally per-role:

```yaml
# Global policy — structural redaction for everyone
id: gmail-global-redact
rules:
  - service: google.gmail
    actions: [list_messages, get_message]
    allow: true
    response_filters:
      - redact: phone_number

# Role-specific policy — researcher gets full bodies, scheduler gets truncated
id: researcher-gmail
role: researcher
rules:
  - service: google.gmail
    actions: [get_message]
    allow: true
    response_filters:
      - semantic: "return full message content"

id: scheduler-gmail
role: scheduler
rules:
  - service: google.gmail
    actions: [get_message]
    allow: true
    response_filters:
      - truncate_field: data.body
        max_chars: 100
      - semantic: "exclude any email that isn't about scheduling or meetings"
```

Filters from matching rules are collected and applied in order: global rules first, then role-specific rules.

### Audit Log Fields for Filters

The audit log records which filters were applied to each response:

```json
"filters_applied": [
  {"type": "structural", "filter": "redact:email_address", "matches": 3},
  {"type": "structural", "filter": "truncate_field:body", "truncated": true},
  {"type": "semantic",   "instruction": "exclude newsletters", "applied": true, "error": null}
]
```

If a semantic filter fails, `"error"` contains the reason and `"applied": false`. The response still proceeds.

---

## Implementing a New Adapter

Every adapter's `Execute` function must return a `SemanticResult`. The formatting helpers in `internal/adapters/format/` provide:

```go
// Sanitize a string: strip HTML, remove dangerous Unicode, truncate
format.SanitizeText(s string, maxLen int) string

// Build a standard summary line
format.Summary(template string, args ...any) string

// Truncate a data slice
format.TruncateSlice(items []any, max int) []any

// Strip credential-looking keys from a map
format.StripSecrets(m map[string]any) map[string]any
```

Adapters should use these helpers rather than ad-hoc string handling to ensure consistent security properties across the codebase.
