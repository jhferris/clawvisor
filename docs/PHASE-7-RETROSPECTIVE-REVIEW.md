# Phase 7: Retrospective Review

## Goal
Analyze the audit log for patterns that real-time enforcement misses — slow exfiltration, coordinated probing, injection fingerprints. Surface findings to the user via Telegram and the dashboard.

---

## Deliverables
- Retrospective analysis engine (scheduled job, configurable interval)
- Detection rules: volume anomalies, exfiltration sequences, injection fingerprints, policy probing
- Finding storage (DB table)
- Dashboard view: findings list, per-finding drill-down into relevant audit entries
- Telegram notification for new findings
- Manual "run now" trigger via API

---

## Architecture

The review engine runs as a background goroutine on a schedule (default: daily at 3am user's timezone, configurable). It queries the audit log for the analysis window (default: last 24 hours) and runs each detector against the results.

```go
// internal/review/engine.go

type Engine struct {
    store    Store
    detectors []Detector
    notify   notify.Notifier
}

type Detector interface {
    Name() string
    Analyze(ctx context.Context, userID string, entries []AuditEntry, window AnalysisWindow) ([]Finding, error)
}

type Finding struct {
    ID          string
    UserID      string
    DetectorName string
    Severity    Severity    // "info" | "warning" | "critical"
    Title       string
    Description string
    RelatedRequestIDs []string
    DetectedAt  time.Time
    Reviewed    bool
}

type AnalysisWindow struct {
    Start time.Time
    End   time.Time
}
```

---

## Detectors

### 1. Volume Anomaly (`detector/volume.go`)

Flags when request volume to a service is significantly above baseline.

**Algorithm:**
1. Compute request counts per service for the analysis window
2. Compare against 7-day rolling average (computed over prior audit entries)
3. Flag if count > baseline * 3 AND count > 10 (ignore noise on low-volume services)

**Finding example:**
> **Volume spike: google.gmail** — 143 requests in the last 24h vs. 12-day average of 18. This may be normal (large inbox processing) or may indicate the agent was redirected to read many emails.

**Configurable threshold:** `review.volume_spike_multiplier: 3.0`

---

### 2. Exfiltration Sequence (`detector/exfiltration.go`)

Flags when a burst of read operations is followed by an unusual write/send operation within a short window.

**Algorithm:**
1. Find windows where N+ read operations occurred within T minutes
2. Check if a send/write/share operation occurred within 30 minutes after
3. Flag if the send/write target is new (not seen in prior 7 days of audit)

**Pattern:**
```
[read email] x 10 → [send_message to new_recipient@external.com]
[get_file] x 5   → [create_file with unfamiliar name]
```

**Finding example:**
> **Possible exfiltration sequence** — 12 emails were read between 14:03-14:07, followed by a send_message to `unknown@external.com` at 14:09. The recipient has not appeared in prior audit history. Review the audit entries to confirm this was intentional.

---

### 3. Policy Probing (`detector/probing.go`)

Flags when blocked requests cluster around similar actions, suggesting the agent is testing the boundary of what's allowed.

**Algorithm:**
1. Find clusters of `blocked` outcomes within 10 minutes
2. If 3+ blocks hit the same service with different actions or param variations → flag
3. Also flag if blocks are immediately followed by a different action on the same service that succeeds

**Finding example:**
> **Possible policy probing** — 5 blocked requests to `google.gmail` between 09:14-09:16, trying actions: `delete_message`, `modify_message`, `batch_delete`, `trash_message`, `expunge`. This pattern may indicate the agent was influenced by content instructing it to delete emails and tried multiple variants.

---

### 4. Injection Fingerprints (`detector/injection.go`)

Flags requests with characteristics associated with prompt injection.

**Signals checked:**
- `data_origin` is a domain/path not seen in prior 7 days (new external data source)
- `reason` field is unusually long (>200 chars) — may be injected instructions leaking through
- `reason` field contains meta-instructions (contains words like "ignore", "override", "system", "pretend", "you are")
- Multiple blocked requests where `data_origin` is the same URL (repeated manipulation attempts from same source)

**Finding example:**
> **Possible injection signal** — A request to send an email was made while processing content from `https://new-domain.example.com/page` (first time this domain appeared in your audit history). The agent's stated reason was unusually long (312 characters) and contained the phrase "ignore previous instructions". Audit entry: `req-abc123`.

---

### 5. Off-Hours Activity (`detector/off_hours.go`)

Flags requests made outside configured active hours when there's no heartbeat or scheduled context.

**Algorithm:**
- User configures active hours (default: 07:00-23:00 local time)
- Flag requests outside active hours where `context_src` is not `heartbeat` or `cron`
- Ignore if user has explicitly set `review.off_hours_check: false`

---

## Database Schema (Phase 7)

```sql
-- 007_review_findings.sql

CREATE TABLE review_findings (
    id                  TEXT PRIMARY KEY,
    user_id             TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    detector_name       TEXT NOT NULL,
    severity            TEXT NOT NULL,      -- info|warning|critical
    title               TEXT NOT NULL,
    description         TEXT NOT NULL,
    related_request_ids TEXT NOT NULL,      -- JSON array
    detected_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    reviewed            BOOLEAN NOT NULL DEFAULT FALSE,
    reviewed_at         TIMESTAMPTZ,
    notes               TEXT                -- user's review notes
);

CREATE INDEX idx_findings_user ON review_findings(user_id, detected_at DESC);
CREATE INDEX idx_findings_reviewed ON review_findings(user_id, reviewed);
```

---

## API Routes (Phase 7)

```
GET    /api/review/findings              → {findings: [], unreviewed_count: N}
GET    /api/review/findings/:id          → Finding + related AuditEntries
POST   /api/review/findings/:id/review  Body: {notes?} → 200 (marks reviewed)
POST   /api/review/run                   → 202 Accepted (triggers immediate run for user)
GET    /api/review/config                → ReviewConfig
PUT    /api/review/config                Body: {schedule, window_hours, ...} → ReviewConfig
```

---

## Dashboard View

New section: **Security Review** (nav item with unread badge count).

- Findings list: severity badge, title, date, reviewed status
- Click finding: description, list of related audit entries (click each to expand), "Mark reviewed" button with optional notes field
- Unreviewed count shown in nav badge
- "Run analysis now" button (calls `POST /api/review/run`)

---

## Telegram Notifications

When new findings are detected:
```
⚠️ Clawvisor Security Review — 2 new findings

🔴 Critical: Possible injection signal (req-abc123)
🟡 Warning: Volume spike: google.gmail (143 vs avg 18)

Review at: https://your-clawvisor.com/dashboard/review
```

Only sends notification if there are `warning` or `critical` findings. `info` findings are dashboard-only.

---

## Success Criteria
- [ ] Review engine runs on schedule and produces findings
- [ ] Volume anomaly detector correctly flags 3x+ spike
- [ ] Exfiltration detector flags read-burst → send sequence with new recipient
- [ ] Policy probing detector flags clustered blocks on same service
- [ ] Injection fingerprint detector flags long/suspicious `reason` fields
- [ ] Findings stored in DB and retrievable via API
- [ ] Dashboard shows findings with severity badges and drill-down
- [ ] Telegram notification sent for warning/critical findings
- [ ] "Mark reviewed" updates finding status
- [ ] `POST /api/review/run` triggers immediate analysis
- [ ] No false positives on normal heartbeat-driven read-only activity
