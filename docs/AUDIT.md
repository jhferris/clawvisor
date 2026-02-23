# Clawvisor — Audit System

## Overview

Every request that flows through Clawvisor is logged, regardless of outcome. The audit system has two functions:

1. **Real-time logging** — a complete, immutable record of every request and decision
2. **Retrospective review** — scheduled pattern analysis to catch slow or subtle attacks that per-request evaluation misses

---

## Audit Log Schema

Stored in the `audit_log` table (Postgres or SQLite, per `database.driver` config).

```sql
CREATE TABLE audit_log (
    id            TEXT PRIMARY KEY,          -- UUID v4
    user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    agent_id      TEXT REFERENCES agents(id) ON DELETE SET NULL,
    request_id    TEXT NOT NULL,
    timestamp     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    service       TEXT NOT NULL,             -- "google.gmail"
    action        TEXT NOT NULL,             -- "list_messages"
    params_safe   JSONB NOT NULL,            -- sanitized: credentials stripped, secrets redacted
    decision      TEXT NOT NULL,             -- "execute" | "approve" | "block"
    outcome       TEXT NOT NULL,             -- see outcomes below
    policy_id     TEXT,                      -- policy that matched (if any)
    rule_id       TEXT,                      -- specific rule that matched
    safety_flagged BOOLEAN NOT NULL DEFAULT FALSE,
    safety_reason TEXT,                      -- LLM safety check reason (if flagged)
    reason        TEXT,                      -- agent's stated reason (untrusted)
    data_origin   TEXT,                      -- injection forensics: what agent was processing
    context_src   TEXT,                      -- "heartbeat" | "user_message" | "mcp" | etc.
    duration_ms   INTEGER NOT NULL,
    filters_applied JSONB,            -- [{type, filter, matches?, truncated?, applied?, error?}]
    error_msg     TEXT
);

CREATE INDEX idx_audit_user_time  ON audit_log(user_id, timestamp DESC);
CREATE INDEX idx_audit_outcome    ON audit_log(user_id, outcome);
CREATE INDEX idx_audit_service    ON audit_log(user_id, service);
CREATE INDEX idx_audit_origin     ON audit_log(user_id, data_origin);
```

### Outcome Values

| Outcome | Meaning |
|---|---|
| `executed` | Policy allowed, safety passed, adapter call succeeded |
| `blocked` | Explicit `allow: false` policy rule matched |
| `pending` | Approval requested, awaiting human response |
| `approved` | Human approved; execution in progress |
| `denied` | Human explicitly denied |
| `timeout` | Approval window expired |
| `pending_activation` | Service not activated; activation requested |
| `error` | Execution attempted but adapter or vault failed |

---

## What Gets Logged

| Field | Source | Trusted? | Notes |
|---|---|---|---|
| `service`, `action` | Request (validated) | Yes | |
| `params_safe` | Request, sanitized | Yes | Credentials stripped; secret-looking keys redacted |
| `decision` | Policy evaluator | Yes | |
| `outcome` | Execution result | Yes | |
| `policy_id`, `rule_id` | Evaluator | Yes | |
| `safety_flagged` | LLM safety check | Yes | |
| `safety_reason` | LLM safety check | Partial | Model output, not human-verified |
| `reason` | Agent field | No | Logged for context, never affects decisions |
| `data_origin` | Agent field | No | Logged for forensics; key injection artifact |
| `duration_ms` | Server timer | Yes | |

**Credentials are never logged.** `params_safe` is a sanitized copy: `_credential` keys removed, any key matching `/token|secret|key|password|auth/i` redacted to `"[redacted]"`.

---

## Pending Approvals Table

```sql
CREATE TABLE pending_approvals (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    request_id      TEXT NOT NULL UNIQUE,
    audit_id        TEXT NOT NULL,
    request_blob    JSONB NOT NULL,       -- full original request for re-execution on approval
    callback_url    TEXT,
    telegram_msg_id TEXT,
    expires_at      TIMESTAMPTZ NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

---

## Querying the Audit Log

Via the **dashboard** (`/dashboard/audit`): filterable table, click-to-expand, date range picker.

Via the **API**:
```
GET /api/audit
  ?outcome=blocked
  &service=google.gmail
  &since=2026-02-22
  &limit=50
  &offset=0
→ { entries: [...], total: N }

GET /api/audit/:id
→ AuditEntry (includes related pending approval status if applicable)
```

Both API and dashboard require user JWT. Users only see their own audit entries.

---

## Retrospective Review

Scheduled analysis runs against the audit log looking for patterns that per-request evaluation misses. See `PHASE-7-RETROSPECTIVE-REVIEW.md` for full detector specifications.

**Detectors:**
- **Volume anomaly** — request spike vs. 7-day rolling baseline
- **Exfiltration sequence** — read burst followed by unusual write/send to new recipient
- **Policy probing** — clustered blocked requests on same service (testing the boundary)
- **Injection fingerprints** — suspicious `reason` fields, first-seen `data_origin` domains, repeated manipulation from same source
- **Off-hours activity** — requests outside configured active hours from non-scheduled context

Findings are stored in the `review_findings` table and surfaced in the dashboard and via Telegram. See `PHASE-7-RETROSPECTIVE-REVIEW.md` for schema and API.

---

## Forensic Use

The `data_origin` field is the key forensic artifact for prompt injection investigations. It answers: *"what was the agent reading when it decided to make this request?"*

To investigate a suspected injection:

```
# Via API
GET /api/audit?data_origin_contains=suspicious-domain.com
GET /api/audit?since=2026-02-22T14:00:00Z&until=2026-02-22T15:00:00Z

# Reconstruct a session's request sequence
GET /api/audit?context_src=user_message&since=...
```

If `data_origin` is consistently null for suspicious requests, it means the agent wasn't populating it — worth enforcing via the OpenClaw skill instructions.

---

## Retention

- Default: 90 days (configurable: `audit.retain_days`)
- Purge job runs on startup and daily
- Pending approvals: cleaned up on resolution or expiry
- Review findings: retained indefinitely until manually marked reviewed and purged
