# Phase 4: Dashboard (Frontend)

## Goal
A functional web UI where users can activate services, manage policies, review the audit log, and manage agent tokens. The dashboard is the primary UX for everything non-agent-facing.

---

## Deliverables
- Authentication screens (login, register)
- Service catalog with activation flow (OAuth button → consent → activated)
- Policy management (list, create from YAML editor, edit, delete, dry-run evaluator)
- Audit log viewer (filterable, paginated)
- Agent token management (create, list, revoke, assign role)
- Role management (create, name, describe roles; assign to agents)
- Notification config (Telegram setup)
- Pending approval UI (real-time via polling or WebSocket)
- User settings

---

## Tech Stack

- **Vite + React 18 + TypeScript**
- **TanStack Query v5** — data fetching, caching, invalidation
- **React Router v6** — client-side routing
- **Tailwind CSS + shadcn/ui** — components (use shadcn CLI to add components as needed)
- **@codemirror/lang-yaml** — YAML editor for policies
- **date-fns** — date formatting

Served as static files by the Go server: `GET /*` → `web/dist/index.html` (SPA fallback).

---

## Route Structure

```
/                      → redirect to /dashboard or /login
/login                 → Login page
/register              → Register page

/dashboard             → Overview: activated services, recent audit events, pending approvals
/dashboard/services    → Service catalog + activation
/dashboard/policies    → Policy list
/dashboard/policies/new     → Create policy (YAML editor)
/dashboard/policies/:id     → Edit policy
/dashboard/audit       → Audit log viewer
/dashboard/agents      → Agent token management + role assignment
/dashboard/settings    → Notification config, user settings
```

---

## Key Pages

### Service Catalog (`/dashboard/services`)

Grid of all supported services. Each card shows:
- Service name + icon
- Description
- Status badge: `Activated` (green) / `Not Activated` (gray) / `Expired` (red)
- For activated: when activated, which scopes
- Actions:
  - Not activated → **[Activate]** button → starts OAuth flow or API key modal
  - Activated → **[Manage]** (view scopes, deactivate) 

API key services (GitHub, etc.) show a modal with a password input instead of OAuth redirect.

After OAuth redirect and callback, the page auto-refreshes to show the service as activated.

### Policy Management (`/dashboard/policies`)

List view: policy name, slug, rule count, created date, actions (edit, delete, duplicate).

**Policy editor** — full-page YAML editor with:
- Syntax highlighting (CodeMirror + YAML)
- Live validation: calls `POST /api/policies/validate` on debounce (500ms)
- Conflict warnings shown inline below editor
- **Dry-run panel**: enter `service`, `action`, `params` → calls `POST /api/policies/evaluate` → shows decision with which rule matched

### Audit Log (`/dashboard/audit`)

Table with columns: Time, Agent, Service, Action, Decision, Outcome, Duration.
- Filter by: outcome, service, date range
- Click row → expand to show full request params (sanitized), reason, data_origin, error
- Pagination (50 per page)
- Polling: refresh every 30s or on user action

### Pending Approvals (Dashboard overlay)

Pending approvals appear as a notification badge on the dashboard nav. 
The pending approvals panel (slide-over or modal) shows:
- Requesting agent, service, action, params
- Agent's stated reason
- Data origin (if present)
- **[Approve]** / **[Deny]** buttons → calls `POST /api/approvals/:id/approve` or `/deny`
- Countdown timer showing time until expiry

This is the in-browser alternative to Telegram approvals. Both work — the first response (browser or Telegram) wins.

---

## New API Routes (Phase 4)

```
# Approvals (in-browser)
GET    /api/approvals                      → []PendingApproval (for current user)
POST   /api/approvals/:id/approve         → 200 (triggers execution + callback)
POST   /api/approvals/:id/deny            → 200

# Notification config
GET    /api/notifications                  → []NotificationConfig
PUT    /api/notifications/telegram         Body: {bot_token, chat_id}  → NotificationConfig
DELETE /api/notifications/telegram         → 204

# User
GET    /api/me                             → User
PUT    /api/me                             Body: {email?, current_password, new_password?} → User
DELETE /api/me                             → 204 (account deletion)
```

---

## Typed API Client

All API calls go through a typed client (`web/src/api/client.ts`):

```typescript
export const api = {
  auth: {
    login: (email: string, password: string) => post<AuthResponse>('/api/auth/login', {email, password}),
    register: (email: string, password: string) => post<AuthResponse>('/api/auth/register', {email, password}),
    refresh: () => post<AuthResponse>('/api/auth/refresh', {}),
    logout: () => post('/api/auth/logout', {}),
  },
  services: {
    list: () => get<{services: ServiceInfo[]}>('/api/services'),
    oauthStart: (serviceID: string) => `/api/oauth/start?service=${serviceID}`,
  },
  policies: {
    list: () => get<PolicyRecord[]>('/api/policies'),
    create: (yaml: string) => post<PolicyRecord>('/api/policies', {yaml}),
    update: (id: string, yaml: string) => put<PolicyRecord>(`/api/policies/${id}`, {yaml}),
    delete: (id: string) => del(`/api/policies/${id}`),
    validate: (yaml: string) => post<ValidationResult>('/api/policies/validate', {yaml}),
    evaluate: (req: EvalRequest) => post<PolicyDecision>('/api/policies/evaluate', req),
  },
  audit: {
    list: (filter?: AuditFilter) => get<{entries: AuditEntry[], total: number}>('/api/audit', filter),
    get: (id: string) => get<AuditEntry>(`/api/audit/${id}`),
  },
  agents: {
    list: () => get<Agent[]>('/api/agents'),
    create: (name: string) => post<{agent: Agent, token: string}>('/api/agents', {name}),
    delete: (id: string) => del(`/api/agents/${id}`),
  },
  approvals: {
    list: () => get<PendingApproval[]>('/api/approvals'),
    approve: (id: string) => post(`/api/approvals/${id}/approve`, {}),
    deny: (id: string) => post(`/api/approvals/${id}/deny`, {}),
  },
}
```

Token storage: access token in memory (React state/context), refresh token in `httpOnly` cookie. Auto-refresh on 401.

---

## New API Routes (Audit + Agents)

```
GET    /api/audit                          Auth: user JWT  → {entries, total}
GET    /api/audit/:id                      Auth: user JWT  → AuditEntry

POST   /api/agents                         Auth: user JWT  Body: {name, role_id?} → {agent, token}
GET    /api/agents                         Auth: user JWT  → []Agent (includes role info)
PATCH  /api/agents/:id                     Auth: user JWT  Body: {role_id: "id"|null} → Agent
DELETE /api/agents/:id                     Auth: user JWT  → 204
```

---

## Success Criteria
- [ ] Login/register flow works end-to-end
- [ ] Service catalog loads, shows Gmail as "not activated"
- [ ] Clicking Activate on Gmail starts OAuth, completes, shows as "activated"
- [ ] Policy editor validates YAML live and shows conflict warnings
- [ ] Dry-run evaluator shows correct decision
- [ ] Audit log loads, filters by outcome and service work
- [ ] Pending approvals appear in dashboard, approve/deny buttons work
- [ ] Agent token created in UI can be used to make a gateway request
- [ ] Telegram notification config saves and is used for approvals
- [ ] All API calls are authenticated; unauthenticated → redirected to /login
- [ ] Roles can be created, named, and described in the dashboard
- [ ] Agent tokens can be assigned a role at creation or updated afterward
- [ ] Policy editor shows which role a policy targets (or "All agents" if global)
- [ ] Policy list can be filtered by role
- [ ] Dry-run evaluator accepts a role field and returns role-aware decision
