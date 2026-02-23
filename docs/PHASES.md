# Clawvisor — Build Phases

## Stack
- **Backend:** Go 1.23+, minimal dependencies, `net/http` ServeMux
- **Frontend:** Vite + React + TypeScript + Tailwind + shadcn/ui
- **Database:** Postgres (Cloud Run / Cloud SQL) + SQLite (local), abstracted behind `Store` interface
- **Vault:** Local AES-256-GCM keyfile + GCP Secret Manager, abstracted behind `Vault` interface
- **Hosting:** Google Cloud Run
- **Auth:** JWT (access + refresh tokens), bcrypt passwords

## Phases

| Phase | Name | Key Deliverable |
|---|---|---|
| [1](PHASE-1-FOUNDATION.md) | Foundation & Infrastructure | Go skeleton, DB abstraction, user auth, vault, Cloud Run deploy |
| [2](PHASE-2-POLICY-ENGINE.md) | Policy Engine | YAML policies, compiler, pure evaluator, policy CRUD API |
| [3](PHASE-3-GATEWAY-AND-ADAPTERS.md) | Core Gateway & First Adapter | Gateway request flow, Gmail adapter, Telegram approval, OpenClaw callback |
| [4](PHASE-4-DASHBOARD.md) | Dashboard | Vite frontend: service catalog, policy editor, audit log, approvals UI |
| [5](PHASE-5-OPENCLAW-SKILL.md) | OpenClaw Skill | ClawHub-published skill, async approval handling, agent-initiated activation |
| [6](PHASE-6-EXTENDED-ADAPTERS.md) | Extended Adapters | Calendar, Drive, Contacts, GitHub; unified Google OAuth |
| [7](PHASE-7-RETROSPECTIVE-REVIEW.md) | Retrospective Review | Audit pattern analysis, anomaly detection, findings dashboard |
| [8](PHASE-8-MCP-SERVER.md) | MCP Server | MCP-compatible tool server, Claude Desktop support |
| [9](PHASE-9-PRODUCTION-HARDENING.md) | Production Hardening | Structured logging, metrics, rate limiting, load testing |

## Reference Docs

| Doc | What it covers |
|---|---|
| `OVERVIEW.md` | Vision, principles, request lifecycle, roadmap |
| `ARCHITECTURE.md` | Components, Go interfaces, deployment config |
| `PROTOCOL.md` | HTTP API spec, request/response shapes, error codes |
| `VAULT.md` | Credential storage, local vs GCP backends, injection |
| `APPROVAL.md` | Approval flow, Telegram + dashboard, timeout behavior |
| `AUDIT.md` | Audit log schema, retrospective review overview |
| `SEMANTIC-FORMATTING.md` | Output formatting: what gets stripped, per-adapter schemas |
| `prototype/` | TypeScript proof-of-concept docs (not the build target) |

---

## Key Design Decisions

**Default deny.** Requests with no matching policy route to approval, not block.

**Agent never holds credentials.** Vault injects credentials at execution time; they never appear in responses or logs.

**Deterministic enforcement.** Policy evaluation is a pure function — no LLM in the hot path. LLM may be used at policy *authoring* time for conflict detection (opt-in).

**Role-based policies.** Policies optionally target agent roles (e.g. "researcher", "scheduler"). Global policies (no role) apply to all agents. Roles are defined in Clawvisor — platform-agnostic. An agent with no role assigned receives only global policies, keeping single-agent personal use uncluttered.

**Response filters.** Policies include structural (deterministic) and semantic (LLM best-effort) response filters. Structural filters run first; semantic filters run after. The safety check always sees fully filtered output. Semantic filter failures are non-fatal and logged.

**Notification abstraction.** Approval notifications go through a `Notifier` interface. Telegram is the first implementation; dashboard in-browser approvals are the second. Both work simultaneously — first response wins.

**Store + Vault abstraction.** The `Store` interface has Postgres and SQLite implementations. The `Vault` interface has local (keyfile) and GCP Secret Manager implementations. Switching backends is a config change.

**Phases 1-5 = MVP.** After Phase 5, Clawvisor is a usable personal tool with Gmail support and an OpenClaw skill on ClawHub. Phases 6-9 expand adapters, add security review, add MCP, and harden for public hosting.
