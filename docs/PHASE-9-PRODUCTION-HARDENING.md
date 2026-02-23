# Phase 9: Production Hardening

## Goal
Make Clawvisor production-ready: reliable, observable, performant, and secure enough for public use. This phase focuses on operational robustness rather than new features.

---

## Deliverables
- Structured logging (slog, JSON output)
- Metrics endpoint (Prometheus-compatible, Cloud Monitoring integration)
- Rate limiting (per-user, per-agent)
- Retry logic with backoff for adapter calls
- Request/response size limits
- Input validation hardening
- CSRF protection for dashboard
- Security headers
- Graceful shutdown
- Database connection pooling tuning
- Load testing + performance baseline
- Cloud Run autoscaling configuration
- Alerting (Cloud Monitoring alerts for error rates, latency)
- Admin API (for hosted product: user management, usage stats)
- Terms of service + data handling docs (for hosted product)

---

## Structured Logging

Replace `fmt.Println` / `log.Printf` throughout with `slog` (Go 1.21+ standard library):

```go
// internal/logging/logging.go
func New(level slog.Level, format string) *slog.Logger {
    var handler slog.Handler
    if format == "json" {
        handler = slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: level})
    } else {
        handler = slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: level})
    }
    return slog.New(handler)
}
```

Log fields on every request:
```json
{
  "time": "2026-02-22T21:00:00Z",
  "level": "INFO",
  "msg": "gateway request",
  "request_id": "...",
  "user_id": "...",
  "agent_id": "...",
  "service": "google.gmail",
  "action": "list_messages",
  "decision": "execute",
  "outcome": "executed",
  "duration_ms": 234,
  "trace_id": "..."   // Cloud Trace ID if available
}
```

Never log: credentials, access tokens, refresh tokens, raw params that might contain PII.

---

## Metrics

Expose `GET /metrics` in Prometheus format. Scraped by Cloud Monitoring via managed Prometheus or a sidecar.

Key metrics:
```
# Gateway
clawvisor_gateway_requests_total{user_id, service, action, decision, outcome}
clawvisor_gateway_request_duration_seconds{service, action, outcome} (histogram)
clawvisor_pending_approvals_total{user_id}
clawvisor_approval_resolution_duration_seconds (histogram: time from pending to resolved)

# Adapters
clawvisor_adapter_calls_total{service, action, status}
clawvisor_adapter_call_duration_seconds{service} (histogram)
clawvisor_token_refreshes_total{service}
clawvisor_token_refresh_errors_total{service}

# System
clawvisor_db_query_duration_seconds{query_name} (histogram)
clawvisor_active_connections (gauge)
go_* (standard Go runtime metrics)
```

---

## Rate Limiting

```go
// internal/ratelimit/ratelimit.go
// Token bucket, per-agent
type Limiter struct {
    agents sync.Map  // agentID → *rate.Limiter
}

// Limits (configurable):
// - Gateway requests: 60/minute per agent
// - OAuth operations: 5/minute per user
// - Policy API: 30/minute per user
// - Review run: 5/hour per user
```

Rate limit headers on every response:
```
X-RateLimit-Limit: 60
X-RateLimit-Remaining: 47
X-RateLimit-Reset: 1740268800
```

Return `429 Too Many Requests` when exceeded.

---

## Retry Logic for Adapter Calls

```go
// internal/adapters/retry.go
func WithRetry(fn func() (*Result, error), maxAttempts int, backoff time.Duration) (*Result, error) {
    for attempt := 1; attempt <= maxAttempts; attempt++ {
        result, err := fn()
        if err == nil {
            return result, nil
        }
        if isRetryable(err) && attempt < maxAttempts {
            time.Sleep(backoff * time.Duration(attempt))
            continue
        }
        return nil, err
    }
}

func isRetryable(err error) bool {
    // Retry on: 429 (rate limit), 500, 502, 503, 504
    // Don't retry on: 400, 401, 403, 404
}
```

Default: 3 attempts, 500ms base backoff (exponential).

---

## Input Validation Hardening

All gateway request fields validated before policy evaluation:

```go
type RequestValidator struct{}

func (v *RequestValidator) Validate(req *Request) []ValidationError {
    var errs []ValidationError

    if req.Service == "" || len(req.Service) > 64 { errs = append(errs, ...) }
    if req.Action == "" || len(req.Action) > 64 { errs = append(errs, ...) }
    if len(req.Params) > 50 { errs = append(errs, ...) }  // max 50 params
    // Each param key: max 64 chars, alphanumeric + underscore
    // Each param value: max 10KB total serialized
    if req.Reason != nil && len(*req.Reason) > 1000 { errs = append(errs, ...) }
    if len(serialized(req)) > 64*1024 { errs = append(errs, ...) }  // 64KB total request limit

    return errs
}
```

Request body size limit: 64KB (set on HTTP server).

---

## Security Headers

All HTTP responses include:

```go
// middleware/security.go
w.Header().Set("X-Content-Type-Options", "nosniff")
w.Header().Set("X-Frame-Options", "DENY")
w.Header().Set("Referrer-Policy", "strict-origin-when-cross-origin")
w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'")
// HSTS only if TLS:
w.Header().Set("Strict-Transport-Security", "max-age=63072000; includeSubDomains")
```

CSRF protection: SameSite=Lax cookie for session, CSRF token in header for state-changing requests from the dashboard.

---

## Graceful Shutdown

```go
func (s *Server) Run(ctx context.Context) error {
    srv := &http.Server{Addr: s.addr, Handler: s.handler}

    go srv.ListenAndServe()

    <-ctx.Done()

    shutdownCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
    defer cancel()

    // 1. Stop accepting new requests
    srv.Shutdown(shutdownCtx)
    // 2. Wait for in-flight requests (30s max)
    // 3. Close DB pool
    s.db.Close()
    // 4. Flush pending approval notifications
    return nil
}
```

Cloud Run sends SIGTERM before termination — handle it cleanly.

---

## Cloud Run Configuration

```yaml
# deploy/cloudrun.yaml
apiVersion: serving.knative.dev/v1
kind: Service
metadata:
  name: clawvisor
spec:
  template:
    metadata:
      annotations:
        autoscaling.knative.dev/minScale: "1"   # keep warm for approval callbacks
        autoscaling.knative.dev/maxScale: "10"
        run.googleapis.com/cloudsql-instances: "project:region:instance"
    spec:
      timeoutSeconds: 360     # buffer above approval timeout (300s) and MCP approval timeout (240s)
      containers:
        - image: gcr.io/PROJECT/clawvisor:latest
          resources:
            limits:
              cpu: "1"
              memory: "512Mi"
          env:
            - name: DATABASE_URL
              valueFrom:
                secretKeyRef:
                  name: clawvisor-db-url
                  key: latest
            - name: JWT_SECRET
              valueFrom:
                secretKeyRef:
                  name: clawvisor-jwt-secret
                  key: latest
```

Note: `minScale: 1` is important — approval callbacks from Telegram need a running instance. Scale to zero breaks async approval flows.

---

## Admin API (for hosted product)

```
# Requires admin JWT (separate role)
GET    /api/admin/users              → paginated user list + stats
DELETE /api/admin/users/:id          → account deletion (GDPR)
GET    /api/admin/stats              → global usage stats
POST   /api/admin/users/:id/suspend  → suspend account
```

---

## Alerting (Cloud Monitoring)

Configure alerts for:
- Error rate > 1% over 5 minutes
- P99 gateway latency > 5s over 5 minutes
- Pending approvals queue > 50 (stuck approvals)
- Token refresh error rate > 5%
- DB connection pool exhaustion

---

## Load Testing

Before production launch, run load tests:
- Tool: `k6` or `wrk`
- Target: 100 concurrent agents, 1000 requests/minute per user
- Measure: P50/P95/P99 latency, error rate, DB connection pool behavior
- Identify: bottlenecks (adapter calls, DB queries, vault decryption)

---

## Success Criteria
- [ ] All requests logged as structured JSON with request_id, user_id, duration
- [ ] `GET /metrics` returns Prometheus-compatible metrics
- [ ] Rate limiting returns 429 with correct headers when exceeded
- [ ] Adapter call failures retry 3 times with backoff before returning error
- [ ] Oversized requests (>64KB) rejected with 413
- [ ] Security headers present on all responses
- [ ] Graceful shutdown completes within 30s with no dropped in-flight requests
- [ ] Cloud Run min instances set to 1 (approval callbacks work)
- [ ] Load test: 1000 req/min sustained, P99 < 2s, error rate < 0.1%
- [ ] Cloud Monitoring alert fires on simulated error spike
- [ ] Admin API accessible to admin role only
