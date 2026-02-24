# Local Dashboard Auth — Magic Link Design

## Problem

Clawvisor's JWT auth protects the dashboard (policy management, approvals, audit)
from being accessed by the agent. That boundary must always hold — even on localhost,
the agent cannot be allowed to approve its own requests or modify its own policies.

But requiring a manual email/password account to access your own local dashboard is
unnecessary friction. The magic link design keeps the security boundary intact while
eliminating account setup.

---

## Design

### At startup

The server generates a single-use, time-bound magic link token and prints it to stdout:

```
┌────────────────────────────────────────────────────────────┐
│  Clawvisor dashboard                                        │
│  http://localhost:8080/auth/local?token=a3f8b2c9d1e4f7...  │
│                                                             │
│  Open this link in your browser to sign in.                 │
│  Valid for 15 minutes. Single use.                          │
└────────────────────────────────────────────────────────────┘
```

The token is stored in memory only — never written to disk or logged.

### When the browser visits the link

1. Server validates: token matches, not expired, not already used.
2. On success: issues a long-lived session JWT as an HttpOnly cookie (30-day expiry),
   marks the magic token as used (invalidated), redirects to the dashboard.
3. On failure (expired, already used, wrong token): returns 401 with a message
   explaining how to get a new link.

### Subsequent visits

The session cookie carries auth. No login prompt. The user stays logged in for 30
days. On expiry, a new magic link is needed.

### Getting a new magic link

Two ways:

1. **Restart the server** — a new link is printed to stdout on every startup.
2. **CLI command** — `clawvisor auth` (or equivalent) prints a fresh link without
   requiring a restart:

```
$ clawvisor auth
http://localhost:8080/auth/local?token=b9e3c1a7f2d8...
```

---

## Security Properties

**What it protects against:**
- Other processes on localhost that don't have access to the server's stdout cannot
  obtain a magic link token. A background agent running as a service has no TTY
  and no access to the parent process's console output.
- Single-use tokens mean a token captured from logs cannot be replayed — it's
  invalidated on first use.
- Time-bound (15 min) limits the window for any leaked token.
- The JWT session cookie is HttpOnly and Secure (localhost exempted) — not readable
  by JavaScript or by the agent making HTTP requests without a browser.

**What it does not protect against:**
- An agent with full filesystem and process access (if the threat model has already
  broken down at that level, Clawvisor cannot help).
- Tokens printed to a log file that the agent can read. For this reason, the token
  must go to stdout only — never to any log file or structured logger.

**The invariant that must hold regardless:**
The magic link endpoint (`/auth/local`) only issues a session JWT — it does not
provide an agent bearer token. The agent's gateway access and the human's dashboard
access remain separate credential types. Even if an agent somehow obtained a magic
link, the worst case is dashboard access for that session, not silent policy changes
(those still generate audit log entries).

---

## Endpoints

### `GET /auth/local?token=<token>`

- No auth required
- Validates token, issues session cookie, redirects to dashboard
- Returns 401 if invalid/expired/used

### `POST /api/auth/magic` (user JWT required — for generating a new link from within the dashboard)

- Returns `{ "url": "http://localhost:8080/auth/local?token=..." }`
- Useful for sharing dashboard access with another browser/device on localhost
- Still requires an existing session to call

---

## Binding constraint

Magic link auth is only available when the server is bound to `localhost`
(`bind: local` in config). If the server is bound to a LAN or public interface,
magic link auth is disabled and full email/password JWT auth is required. The
server enforces this at startup and returns an appropriate error if misconfigured.

This prevents the scenario where a user binds to a LAN interface but leaves
dashboard auth weakened.

---

## Implementation Notes

- Token: 32 random bytes, hex-encoded (64 chars). Generated with `crypto/rand`.
- Storage: in-memory map `{ token → { created_at, used } }`. Purge used/expired
  tokens on a background ticker (every 5 min is fine).
- The `/auth/local` handler must run before any auth middleware that would
  otherwise reject the unauthenticated request.
- Session JWT issued after magic link redemption is identical to one issued by
  normal login — same claims, same middleware, same expiry. No special-casing
  needed after authentication.
- For the single-user case, there is no `users` table entry required at startup.
  The server can bootstrap a default admin user on first run (random credentials,
  never displayed) and the magic link is the only way to get a session as that user.
