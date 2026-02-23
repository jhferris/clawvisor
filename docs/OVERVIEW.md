# Clawvisor — Overview

## Vision

Clawvisor is a gatekeeper service that sits between an AI agent and sensitive external APIs. The agent never holds credentials. Every action the agent wants to take on your behalf flows through Clawvisor, which evaluates it against your policies, vaults and injects credentials, runs a safety check, and returns semantically useful results.

The goal is not to restrict what your AI agent can do — it's to ensure that what it does reflects *your* intentions, not those of anything it's been tricked into acting on behalf of.

Clawvisor is designed for personal use first and scales to a multi-user hosted product.

---

## The Problem

Modern AI agents read email, browse the web, access calendars, process documents. Every piece of external data they consume is a potential attack surface.

**Prompt injection** is the primary threat: malicious content embedded in data the agent processes (an email body, a webpage, a filename, a calendar event description) that manipulates the agent into taking actions the user didn't intend.

### Attack Vectors

- **Email body** — attacker sends you an email crafted to instruct your agent
- **Web page content** — a page the agent fetches contains hidden instructions
- **Document content** — a file the agent reads includes embedded directives
- **Calendar event descriptions** — meeting invites with injected instructions
- **Contact names/metadata** — adversarial strings in fields the agent reads
- **API response data** — a service returns data designed to influence next actions
- **Filenames and directory listings** — adversarial filenames visible in file system operations

The agent isn't malicious. But it processes untrusted content, and that content can steer it toward requests it wouldn't otherwise make.

---

## Core Design Principles

1. **Default deny.** Everything not explicitly allowed by policy is blocked or requires approval.
2. **Agent never holds credentials.** API keys and OAuth tokens are vaulted in Clawvisor; injected at execution time. Nothing to exfiltrate.
3. **Deterministic policy enforcement.** Policies are compiled to rules evaluated by a pure function — no LLM in the primary enforcement path. Fast, auditable, consistent.
4. **LLM safety check as a secondary layer.** After policy approves a request, an optional LLM check reviews the structured request for novel threats not covered by rules. It can only flag (route to approval) or pass — never execute actions of its own.
5. **Human in the loop for ambiguity.** Requests not covered by policy don't fail silently — they pause and ask you.
6. **Semantically formatted responses with user-defined filters.** Clawvisor returns structured, cleaned summaries — not raw API responses. On top of the baseline formatter, users define response filters (structural and semantic) that control exactly what data each agent role can see. The right data for the right agent.
7. **Role-based access for agents.** Policies can target agent roles rather than specific agents. A "researcher" role gets full document content; a "scheduler" role gets calendar metadata only. Roles are defined in Clawvisor and assigned to agent tokens — platform-agnostic, so moving an agent to a different platform means reassigning a token, not rewriting policies.
8. **Full audit trail.** Every request, decision, and execution is logged. Retrospective review catches slow/subtle attacks that real-time enforcement misses.

---

## Request Lifecycle

```
Agent → [Request: service, action, params] → Policy Evaluator (deterministic)
                                                        │
                        ┌───────────────────────────────┼───────────────────┐
                        ▼                               ▼                   ▼
                     BLOCK                         APPROVE             LLM CHECK
               (policy violation)             (not in policy      (policy said execute;
                        │                    or require_approval)  secondary safety check)
                        │                               │                   │
                   Audit + return               Notify human          Flag? → APPROVE
                    blocked                     (Telegram /           Pass? → EXECUTE
                                                 Dashboard)                  │
                                                        │                   ▼
                                                 On approval:         Inject credentials
                                                 Inject + Execute     → Adapter call
                                                        │             → Semantic formatter
                                                        └──────────────────→ Audit + return result
```

---

## Non-Goals

- Not a firewall for arbitrary network traffic
- Not an LLM output filter (what the agent *says* is separate from what it *does*)
- Not a replacement for OS-level sandboxing (complementary to it)
- Not attempting to detect all possible injection attacks (defense in depth reduces risk; no single layer eliminates it)

---

## Roadmap

Phases align with the detailed phase plans in `PHASES.md`.

### Phases 1–5 — MVP (Personal use, OpenClaw integration)
- Go backend, Postgres + SQLite, Cloud Run deployment
- Multi-user auth from day one
- Policy engine: YAML policies, deterministic evaluation
- Core gateway: Gmail adapter, Telegram approval, OpenClaw callback
- Dashboard: service catalog, policy editor, audit log, in-browser approvals
- OpenClaw skill published to ClawHub

### Phases 6–7 — Expanded coverage
- Google Calendar, Drive, Contacts, GitHub adapters
- Unified Google OAuth (single consent, all scopes)
- Retrospective review: audit pattern analysis, anomaly detection, findings dashboard

### Phase 8 — Interoperability
- MCP server: each activated service becomes a native MCP tool
- Compatible with Claude Desktop and any MCP client
- Policy enforcement transparent to MCP clients

### Phase 9 — Production hardening
- Structured logging, metrics, rate limiting, retry logic
- Cloud Monitoring alerts
- Load testing
- Admin API for hosted product
