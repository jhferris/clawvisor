# Phase 5: OpenClaw Skill

## Goal
A ClawHub-publishable skill that lets an OpenClaw agent use Clawvisor as its tool execution layer. The agent calls structured functions; the skill routes them through the Clawvisor HTTP API, handles async approval, and surfaces results. Publish to ClawHub when complete.

---

## Deliverables
- OpenClaw skill (`clawvisor/SKILL.md`) with full SKILL.md spec
- Skill instructs the agent on: how to make requests, how to handle pending/callback, how to handle not-activated services
- Agent-initiated activation path (agent requests a service → Clawvisor escalates activation to human)
- Skill published to ClawHub

---

## How the Skill Works

The skill is a `SKILL.md` file that instructs the agent (me) to:

1. **Know Clawvisor exists** — check `TOOLS.md` for the Clawvisor URL and agent token
2. **Make requests** via `exec` or `web_fetch` to `POST /api/gateway/request`
3. **Handle all response statuses** — executed (use result), blocked (inform user), pending (inform user, wait for callback), error (handle gracefully), pending_activation (inform user, await activation)
4. **Include `context.session_id` and `context.callback_url`** on every request so results can be delivered back
5. **On callback** — recognize inbound Clawvisor result messages and use the data

---

## SKILL.md Structure

```markdown
---
name: clawvisor
description: Route tool requests through Clawvisor for policy enforcement, credential vaulting,
  and human approval. Use when accessing Gmail, Calendar, GitHub, or any service managed
  by Clawvisor. Clawvisor ensures the user's policies are enforced and credentials
  are never exposed to the agent.
metadata:
  clawvisor:
    requires_env:
      - CLAWVISOR_URL         # e.g. http://localhost:8080 or https://your-instance.run.app
      - CLAWVISOR_AGENT_TOKEN # agent bearer token from dashboard
---

# Clawvisor Skill

[Instructions for the agent follow...]
```

---

## TOOLS.md Additions (for the user to fill in)

The skill instructs users to add to their `TOOLS.md`:

```markdown
### Clawvisor
- URL: http://localhost:8080   # or Cloud Run URL
- Agent Token: (stored in OpenClaw credentials, not here)
- Supported services: google.gmail, google.calendar, github
```

The agent token is stored via OpenClaw's credential system (`openclaw credentials set CLAWVISOR_AGENT_TOKEN`), not in plain text in TOOLS.md.

If the user has configured agent roles (e.g. "assistant", "researcher"), the token should be assigned its role in the Clawvisor dashboard. The agent doesn't declare its own role — Clawvisor resolves it from the token automatically. The agent just uses its token; the right policies apply transparently.

---

## Agent Request Protocol (in SKILL.md instructions)

### Making a request

When you need to access a Clawvisor-managed service, make a `POST` request:

```bash
curl -s -X POST "$CLAWVISOR_URL/api/gateway/request" \
  -H "Authorization: Bearer $CLAWVISOR_AGENT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "service": "google.gmail",
    "action": "list_messages",
    "params": {"query": "is:unread", "max_results": 10},
    "reason": "Checking for urgent messages",
    "context": {
      "source": "user_message",
      "data_origin": null,
      "callback_url": "<your OpenClaw session inbound URL if available>"
    }
  }'
```

### Handling responses

| Status | What to do |
|---|---|
| `executed` | Use `result.summary` and `result.data`. Report to user. |
| `blocked` | Tell the user the action was blocked and why (`reason`). Do not retry. |
| `pending` | Tell the user "I've requested approval for [action] — I'll follow up once you respond in Telegram or the dashboard." Do not retry until you receive the callback. |
| `pending_activation` | Tell the user "[Service] isn't activated yet. Check Telegram or the dashboard to activate it, then I can retry." |
| `error` with `SERVICE_NOT_CONFIGURED` | Same as `pending_activation`. |
| `error` other | Report the error to the user. |

### Receiving callbacks

When Clawvisor delivers a result after approval, it arrives as an inbound message to your OpenClaw session. The message will look like:

```
[Clawvisor Result] request_id: abc-123
Status: executed
Summary: 3 unread emails found...
Data: [...]
```

When you see this message pattern, pick up your prior task context and continue with the result data.

### Checking what services are available

Before asking the user to activate a service, check what's activated:

```bash
curl -s "$CLAWVISOR_URL/api/services" \
  -H "Authorization: Bearer $CLAWVISOR_AGENT_TOKEN"
```

If a service you need is `not_activated`, request it anyway — Clawvisor will escalate activation to the user automatically.

### data_origin field (important)

Always populate `context.data_origin` with the URL or path of any external data you were processing when you decided to make the request. Examples:
- Reading an email then deciding to reply: `"data_origin": "gmail:msg-abc123"`
- Processing a web page then taking action: `"data_origin": "https://example.com/page"`
- Responding to a direct user message: `"data_origin": null`

This field is critical for security forensics and should never be omitted when processing external content.

---

## Skill Installation

```yaml
# skill directory structure
skills/clawvisor/
├── SKILL.md
└── README.md
```

### SKILL.md metadata fields

```yaml
---
name: clawvisor
description: >
  Route tool requests through Clawvisor for policy enforcement, credential vaulting,
  and human approval flows. Supports Gmail, Calendar, GitHub, and more.
  Agent never handles credentials directly.
version: 0.1.0
homepage: https://github.com/yourgithub/clawvisor
metadata:
  openclaw:
    requires_env:
      - CLAWVISOR_URL
      - CLAWVISOR_AGENT_TOKEN
    user_setup:
      - "Set CLAWVISOR_URL to your Clawvisor instance URL"
      - "Create an agent token in the Clawvisor dashboard and set CLAWVISOR_AGENT_TOKEN"
---
```

---

## Callback Delivery from Clawvisor to Agent

On the Clawvisor side (implemented in Phase 3), the callback POST to OpenClaw's session inbound endpoint delivers:

```json
{
  "request_id": "abc-123",
  "status": "executed",
  "result": {
    "summary": "3 unread emails found",
    "data": [...]
  },
  "audit_id": "..."
}
```

OpenClaw receives this as an inbound message to the agent's session. The skill instructs the agent to recognize the `[Clawvisor Result]` prefix and handle it.

On the OpenClaw side, the skill should instruct the agent to listen for these messages and associate them with pending tasks using `request_id`. If the agent maintains a task context (e.g., in a daily notes file), it should note the `request_id` when a request goes pending, then resume the task when the callback arrives.

---

## Publishing to ClawHub

```bash
cd skills/clawvisor
clawhub login
clawhub publish . \
  --slug clawvisor \
  --name "Clawvisor" \
  --version 0.1.0 \
  --changelog "Initial release: Gmail, Calendar, GitHub support"
```

Pre-publish checklist:
- [ ] SKILL.md has accurate description, version, and metadata
- [ ] All env vars documented in `requires_env`
- [ ] Setup instructions clear and minimal
- [ ] README.md has a "Quick Start" section
- [ ] Tested against a real Clawvisor instance

---

## Success Criteria
- [ ] Agent can make a Gmail request through the skill and get results
- [ ] Agent correctly handles `pending` response (tells user, waits)
- [ ] Agent correctly handles `blocked` response (tells user, doesn't retry)
- [ ] Agent correctly handles `pending_activation` (tells user to activate)
- [ ] Callback from Clawvisor received and parsed correctly by agent
- [ ] `data_origin` populated correctly on requests made while processing external content
- [ ] Skill published to ClawHub and installable with `clawhub install clawvisor`
- [ ] Another OpenClaw user can install and configure the skill from scratch
