# Phase 1: Foundation & Infrastructure

## Goal
Establish the project skeleton: Go backend, multi-user auth, database abstraction (Postgres + SQLite), secret vault abstraction (local + GCP Secret Manager), and a working Cloud Run deployment. No business logic yet — just the platform everything else will run on.

---

## Deliverables
- Go project with clean package structure
- Database interface with Postgres and SQLite implementations
- JWT-based user auth (register, login, refresh)
- Secret vault interface with local (AES-256-GCM) and GCP Secret Manager backends
- Config system (YAML + env vars, 12-factor friendly)
- Dockerfile + Cloud Run deployment (cloudbuild.yaml)
- Vite + React + TypeScript frontend scaffold with auth shell
- Health and readiness endpoints
- Docker Compose for local development (app + Postgres)

---

## Technical Decisions

### Backend
- **Go 1.23+** — use `net/http` ServeMux (Go 1.22+ supports path params natively, no router library needed)
- **Minimal deps:** `pgx/v5` (Postgres), `modernc.org/sqlite` (pure-Go SQLite, no CGO), `golang-jwt/jwt/v5`, `gopkg.in/yaml.v3`, `golang.org/x/crypto` (bcrypt)
- **No ORM** — raw SQL with a thin repository layer
- All DB access goes through a `Store` interface; no direct DB calls outside the `store` package

### Frontend
- **Vite + React + TypeScript**
- `@tanstack/react-query` for data fetching
- `react-router-dom` v6 for routing
- `tailwindcss` + `shadcn/ui` for components
- Frontend is a separate directory (`web/`), served as static files by the Go server in production

### Secret Vault Abstraction
```go
type Vault interface {
    Set(ctx context.Context, userID, serviceID string, credential []byte) error
    Get(ctx context.Context, userID, serviceID string) ([]byte, error)
    Delete(ctx context.Context, userID, serviceID string) error
    List(ctx context.Context, userID string) ([]string, error)
}
```
Two implementations:
- `LocalVault` — AES-256-GCM, keyfile on disk, SQLite or Postgres backing table
- `GCPVault` — GCP Secret Manager, secret named `clawvisor-{userID}-{serviceID}`

Selected via config: `vault.backend: local | gcp`

### Database Abstraction
```go
type Store interface {
    // Users
    CreateUser(ctx, email, passwordHash string) (*User, error)
    GetUserByEmail(ctx, email string) (*User, error)
    GetUserByID(ctx, id string) (*User, error)

    // Agent roles
    CreateRole(ctx, userID, name, description string) (*AgentRole, error)
    GetRole(ctx, id, userID string) (*AgentRole, error)
    ListRoles(ctx, userID string) ([]*AgentRole, error)
    DeleteRole(ctx, id, userID string) error

    // Agents
    CreateAgent(ctx, userID, name, tokenHash string, roleID *string) (*Agent, error)
    UpdateAgentRole(ctx, id, userID string, roleID *string) (*Agent, error)
    GetAgentByToken(ctx, tokenHash string) (*Agent, error)
    ListAgents(ctx, userID string) ([]*Agent, error)

    // Sessions (refresh tokens)
    CreateSession(ctx, userID, tokenHash string, expiresAt time.Time) (*Session, error)
    GetSession(ctx, tokenHash string) (*Session, error)
    DeleteSession(ctx, tokenHash string) error

    // Service credentials metadata (vault stores the actual bytes)
    UpsertServiceMeta(ctx, userID, serviceID string, activatedAt time.Time) error
    GetServiceMeta(ctx, userID, serviceID string) (*ServiceMeta, error)
    ListServiceMetas(ctx, userID string) ([]*ServiceMeta, error)
    DeleteServiceMeta(ctx, userID, serviceID string) error

    // Notification configs
    UpsertNotificationConfig(ctx, userID, channel string, config json.RawMessage) error
    GetNotificationConfig(ctx, userID, channel string) (*NotificationConfig, error)
}
```

Selected via config: `database.driver: postgres | sqlite`

---

## Directory Structure

```
clawvisor/
├── cmd/
│   └── server/
│       └── main.go               # Entry point
├── internal/
│   ├── api/
│   │   ├── server.go             # HTTP server setup, middleware, route registration
│   │   ├── middleware/
│   │   │   ├── auth.go           # JWT validation middleware
│   │   │   └── logging.go        # Request logging
│   │   └── handlers/
│   │       ├── auth.go           # POST /api/auth/register, /login, /refresh, /logout
│   │       └── health.go         # GET /health, /ready
│   ├── auth/
│   │   ├── jwt.go                # Token generation and validation
│   │   └── password.go           # bcrypt hashing
│   ├── config/
│   │   └── config.go             # Config struct, load from YAML + env override
│   ├── store/
│   │   ├── store.go              # Store interface + shared types
│   │   ├── postgres/
│   │   │   ├── postgres.go       # pgx connection pool
│   │   │   ├── migrations/       # SQL migration files (001_init.sql, etc.)
│   │   │   └── store.go          # Postgres Store implementation
│   │   └── sqlite/
│   │       ├── sqlite.go         # modernc sqlite connection
│   │       ├── migrations/       # SQLite-compatible SQL migrations
│   │       └── store.go          # SQLite Store implementation
│   └── vault/
│       ├── vault.go              # Vault interface
│       ├── local.go              # AES-256-GCM local vault
│       └── gcp.go                # GCP Secret Manager vault
├── web/                          # Vite frontend
│   ├── src/
│   │   ├── main.tsx
│   │   ├── App.tsx
│   │   ├── api/
│   │   │   └── client.ts         # Typed API client
│   │   ├── components/
│   │   │   └── ui/               # shadcn components
│   │   ├── pages/
│   │   │   ├── Login.tsx
│   │   │   ├── Register.tsx
│   │   │   └── Dashboard.tsx     # Shell only (Phase 4 fills this in)
│   │   └── hooks/
│   │       └── useAuth.ts
│   ├── index.html
│   ├── vite.config.ts
│   ├── tailwind.config.ts
│   └── package.json
├── deploy/
│   ├── Dockerfile
│   ├── cloudbuild.yaml           # GCP Cloud Build
│   ├── cloudrun.yaml             # Cloud Run service spec
│   └── docker-compose.yml        # Local dev (app + postgres)
├── config.example.yaml
├── go.mod
├── go.sum
└── Makefile
```

---

## Database Schema (Phase 1 tables)

```sql
-- 001_init.sql

CREATE TABLE users (
    id          TEXT PRIMARY KEY,           -- UUID v4
    email       TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE sessions (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash  TEXT NOT NULL UNIQUE,       -- SHA-256 of refresh token
    expires_at  TIMESTAMPTZ NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE agent_roles (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,              -- "researcher", "scheduler", "assistant"
    description TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(user_id, name)
);

CREATE TABLE agents (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    token_hash  TEXT NOT NULL UNIQUE,       -- SHA-256 of agent bearer token
    role_id     TEXT REFERENCES agent_roles(id) ON DELETE SET NULL,  -- NULL = no role, uses global policies only
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE service_meta (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    service_id  TEXT NOT NULL,              -- "google.gmail"
    activated_at TIMESTAMPTZ NOT NULL,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(user_id, service_id)
);

CREATE TABLE notification_configs (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    channel     TEXT NOT NULL,             -- "telegram"
    config      JSONB NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(user_id, channel)
);
```

SQLite version uses `TEXT` instead of `TIMESTAMPTZ`, `TEXT` instead of `JSONB`, and `INTEGER PRIMARY KEY AUTOINCREMENT` patterns as appropriate. Both sets of migrations live in their respective subdirectories.

---

## API Routes (Phase 1)

```
POST   /api/auth/register          Body: {email, password}  → {user, access_token, refresh_token}
POST   /api/auth/login             Body: {email, password}  → {user, access_token, refresh_token}
POST   /api/auth/refresh           Body: {refresh_token}    → {access_token, refresh_token}
POST   /api/auth/logout            Auth: bearer             → 204

GET    /health                     → {status: "ok"}
GET    /ready                      → {status: "ok", db: "ok", vault: "ok"}
```

JWT access tokens: 15-minute expiry, HS256, contain `{user_id, email}`.
Refresh tokens: 30-day expiry, stored hashed in `sessions` table.

---

## Config System

`config.yaml` (loaded first, env vars override):

```yaml
server:
  port: 8080
  host: "0.0.0.0"
  frontend_dir: "./web/dist"    # serve built frontend

database:
  driver: "postgres"            # "postgres" | "sqlite"
  postgres_url: ""              # from env: DATABASE_URL
  sqlite_path: "./clawvisor.db"

vault:
  backend: "local"              # "local" | "gcp"
  local_key_file: "./vault.key"
  gcp_project: ""               # from env: GCP_PROJECT

auth:
  jwt_secret: ""                # from env: JWT_SECRET
  access_token_ttl: "15m"
  refresh_token_ttl: "720h"     # 30 days
```

All sensitive fields (postgres_url, jwt_secret, gcp_project) should be set via environment variables in Cloud Run — never committed to config. Cloud Run receives these from Secret Manager or environment config.

---

## Deployment

### Dockerfile (multi-stage)
```dockerfile
# Stage 1: Build frontend
FROM node:20-alpine AS web-builder
WORKDIR /web
COPY web/package*.json .
RUN npm ci
COPY web/ .
RUN npm run build

# Stage 2: Build Go binary
FROM golang:1.23-alpine AS go-builder
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
COPY --from=web-builder /web/dist ./web/dist
RUN CGO_ENABLED=0 GOOS=linux go build -o clawvisor ./cmd/server

# Stage 3: Runtime
FROM gcr.io/distroless/static-debian12
COPY --from=go-builder /app/clawvisor /clawvisor
EXPOSE 8080
ENTRYPOINT ["/clawvisor"]
```

### Cloud Run
- Min instances: 0 (scale to zero)
- Max instances: 10
- CPU: 1, Memory: 512Mi
- Cloud SQL connection via Unix socket (for Postgres)
- Secrets injected as env vars from GCP Secret Manager
- `DATABASE_URL`, `JWT_SECRET` mounted from Secret Manager

---

## Success Criteria
- [ ] `go build ./...` passes with no errors
- [ ] `docker compose up` starts app + Postgres locally
- [ ] `POST /api/auth/register` creates a user, returns JWT pair
- [ ] `POST /api/auth/login` authenticates, returns JWT pair
- [ ] `POST /api/auth/refresh` rotates tokens
- [ ] `GET /health` returns 200
- [ ] `GET /ready` returns 200 with db + vault status
- [ ] Frontend scaffold loads at `/` (login page)
- [ ] Cloud Run deployment runs successfully with Postgres via Cloud SQL
- [ ] SQLite mode works: `DATABASE_DRIVER=sqlite ./clawvisor` starts and accepts requests
