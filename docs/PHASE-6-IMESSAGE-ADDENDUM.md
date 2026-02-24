# Phase 6 Addendum: iMessage Adapter

## Overview

An iMessage adapter for Clawvisor running on macOS. Enables agents to search and read iMessage conversations — useful for queries like "What's Bob's address? He sent it to me in a message."

**Platform:** macOS local deployments only. This adapter does not exist in cloud deployments — it will not appear in the service catalog when running on Cloud Run or any non-macOS host.

**Capability:** Read-only by default. Sending supported as a separate, always-approval-required action.

---

## Prerequisites

1. **macOS with Messages.app configured** — iMessages must be enabled and synced. If the user has iCloud Messages enabled on iPhone, messages sync to the Mac automatically.

2. **Full Disk Access permission** — macOS TCC protects `~/Library/Messages/`. The Clawvisor process needs Full Disk Access granted in:
   `System Settings → Privacy & Security → Full Disk Access`

3. **Messages.app** — Must be installed (standard macOS). For sending, Messages.app must be running (AppleScript dependency).

---

## How It Works

### Reading Messages

iMessage stores all messages in a SQLite database:
```
~/Library/Messages/chat.db
```

The database uses WAL mode — concurrent reads alongside Messages.app are safe. The adapter opens the DB read-only.

**Core tables used:**

| Table | Purpose |
|---|---|
| `message` | Message content, timestamps, `is_from_me` flag |
| `handle` | Contact identifiers (phone numbers, email addresses) |
| `chat` | Conversation threads |
| `chat_message_join` | Links messages to chats |
| `chat_handle_join` | Links contacts to chats |

Contact names are not in `chat.db`. Name resolution requires a secondary lookup against the macOS Contacts database:
```
~/Library/Application Support/AddressBook/Sources/*/AddressBook-v22.abcddb
```

The adapter resolves "Bob" → phone/email identifiers → messages in a two-step query.

### Sending Messages

Outbound messages are sent via AppleScript:
```applescript
tell application "Messages"
    set targetBuddy to buddy "+15551234567" of service "iMessage"
    send "Your message here" to targetBuddy
end tell
```

AppleScript execution requires:
- Messages.app running
- Accessibility permissions for the Clawvisor process (`System Settings → Privacy & Security → Accessibility`)
- **Always requires human approval** — hardcoded, not overridable by policy. Sending an iMessage on behalf of a user without approval is not permitted regardless of policy configuration.

---

## Service Definition

**Service ID:** `apple.imessage`
**Platform:** `macos`
**Auth:** None (local file access, permission managed by macOS TCC)

---

## Actions

### `search_messages`

Search messages by content and/or sender.

**Params:**
| Param | Type | Required | Description |
|---|---|---|---|
| `query` | string | Yes | Text to search for in message content |
| `contact` | string | No | Contact name or phone/email to filter by |
| `days_back` | int | No | Limit to messages within N days (default: 90) |
| `max_results` | int | No | Max messages to return (default: 20, max: 50) |

**Example:**
```json
{
  "service": "apple.imessage",
  "action": "search_messages",
  "params": {
    "query": "address",
    "contact": "Bob",
    "days_back": 180
  },
  "reason": "User asked for Bob's address from a past message"
}
```

**Returns:**
```json
{
  "summary": "3 messages matching 'address' from Bob in the last 180 days",
  "data": [
    {
      "id": "msg-12345",
      "from": "Bob Smith",
      "from_identifier": "+15551234567",
      "text": "My address is 123 Main St, San Francisco CA 94105",
      "timestamp": "2026-01-15T14:23:00-08:00",
      "is_from_me": false,
      "thread_id": "chat-678"
    }
  ]
}
```

---

### `list_threads`

List recent conversation threads.

**Params:**
| Param | Type | Required | Description |
|---|---|---|---|
| `max_results` | int | No | Max threads to return (default: 20) |

**Returns:**
```json
{
  "summary": "15 recent conversations",
  "data": [
    {
      "thread_id": "chat-678",
      "display_name": "Bob Smith",
      "last_message_snippet": "Sounds good, see you then",
      "last_message_at": "2026-02-20T09:15:00-08:00",
      "participant_count": 1
    }
  ]
}
```

---

### `get_thread`

Get messages from a specific conversation thread.

**Params:**
| Param | Type | Required | Description |
|---|---|---|---|
| `contact` | string | Yes* | Contact name, phone, or email |
| `thread_id` | string | Yes* | Thread ID (from `list_threads`). *Either `contact` or `thread_id` required. |
| `max_results` | int | No | Max messages (default: 50) |
| `days_back` | int | No | Limit to last N days (default: 30) |

**Returns:**
```json
{
  "summary": "Last 30 days of messages with Bob Smith (23 messages)",
  "data": {
    "thread_id": "chat-678",
    "contact": "Bob Smith",
    "messages": [
      {
        "id": "msg-12345",
        "text": "My address is 123 Main St...",
        "timestamp": "2026-01-15T14:23:00-08:00",
        "is_from_me": false
      }
    ]
  }
}
```

---

### `send_message`

Send an iMessage. **Always requires approval — this cannot be overridden by policy.**

**Params:**
| Param | Type | Required | Description |
|---|---|---|---|
| `to` | string | Yes | Contact name, phone number, or email address |
| `text` | string | Yes | Message text (max 2000 chars) |

**Returns:**
```json
{
  "summary": "iMessage sent to Bob Smith (+15551234567)",
  "data": { "to": "Bob Smith", "to_identifier": "+15551234567" }
}
```

---

## Platform Detection

The adapter performs a platform check at startup:

```go
// internal/adapters/apple/imessage/adapter.go

func (a *IMessageAdapter) Available() bool {
    if runtime.GOOS != "darwin" {
        return false
    }
    dbPath := filepath.Join(os.Getenv("HOME"), "Library/Messages/chat.db")
    _, err := os.Stat(dbPath)
    return err == nil
}
```

If `Available()` returns false, the service does not appear in `GET /api/services`. No error is shown — it simply isn't listed.

---

## Permission Check on Activation

When the user tries to activate `apple.imessage` from the dashboard, Clawvisor performs a permission check before proceeding:

```go
func (a *IMessageAdapter) CheckPermissions() PermissionStatus {
    // Attempt to open chat.db read-only
    db, err := sql.Open("sqlite3", "file:"+a.dbPath+"?mode=ro")
    if err != nil || db.Ping() != nil {
        return PermissionStatus{
            OK: false,
            Message: "Cannot read ~/Library/Messages/chat.db. Grant Full Disk Access to Clawvisor in System Settings → Privacy & Security → Full Disk Access.",
        }
    }
    return PermissionStatus{OK: true}
}
```

The dashboard shows a clear setup guide with a screenshot/link when FDA is not yet granted.

---

## Privacy Considerations

iMessages are the most sensitive data source in Clawvisor. Setup should include explicit consent:

- Dashboard activation shows a plain-language warning: "Clawvisor will be able to read your iMessage conversations on this Mac. This includes messages with all contacts. Your messages are never sent to any server — they are read locally and returned only to your agent."
- Default policy for `apple.imessage` (auto-created on activation) is read-only with no send:
  ```yaml
  id: imessage-safe-default
  name: iMessage — read only (default)
  rules:
    - service: apple.imessage
      actions: [search_messages, list_threads, get_thread]
      allow: true
    - service: apple.imessage
      actions: [send_message]
      allow: false
      reason: "Sending iMessages requires explicit policy change"
  ```
- `send_message` requires **both** an explicit `allow: true` policy AND human approval at request time. The approval requirement is hardcoded and cannot be removed.

**Recommended semantic response filters:**
```yaml
response_filters:
  - semantic: "only return messages directly relevant to the user's query"
  - semantic: "if messages contain health, financial, or relationship information unrelated to the query, omit them"
```

---

## Schema Stability

Apple does not document `chat.db`'s schema. It has changed across macOS versions. The adapter should:

1. Check schema version on startup: query `sqlite_master` for expected table/column names
2. Log a warning (not an error) if schema looks unexpected
3. Return a clear `ADAPTER_ERROR` with upgrade guidance if queries fail due to schema changes
4. Pin known-good schema versions and test against each macOS release

---

## Success Criteria
- [ ] `apple.imessage` appears in service catalog on macOS with Messages configured
- [ ] `apple.imessage` does not appear on non-macOS deployments or Cloud Run
- [ ] Activation flow shows FDA setup guide if permission not yet granted
- [ ] `search_messages` with `contact: "Bob"` returns messages from contacts named Bob
- [ ] `search_messages` with `query: "address"` finds messages containing that word
- [ ] Contact name resolution works (phone/email → display name via Contacts DB)
- [ ] `get_thread` returns messages in chronological order
- [ ] `send_message` always routes to approval regardless of policy
- [ ] `send_message` returns clear error if Messages.app is not running
- [ ] Default read-only policy auto-created on activation
- [ ] Schema version check logs warning on unexpected schema
- [ ] Audit log records request params (`query`, `contact`) but never message content (results are never logged — consistent with all adapters)
