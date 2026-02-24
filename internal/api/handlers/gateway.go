package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/ericlevine/clawvisor/internal/adapters"
	"github.com/ericlevine/clawvisor/internal/adapters/format"
	"github.com/ericlevine/clawvisor/internal/api/middleware"
	"github.com/ericlevine/clawvisor/internal/callback"
	"github.com/ericlevine/clawvisor/internal/config"
	"github.com/ericlevine/clawvisor/internal/filters"
	"github.com/ericlevine/clawvisor/internal/gateway"
	"github.com/ericlevine/clawvisor/internal/llm"
	"github.com/ericlevine/clawvisor/internal/notify"
	"github.com/ericlevine/clawvisor/internal/safety"
	"github.com/ericlevine/clawvisor/internal/store"
	"github.com/ericlevine/clawvisor/internal/vault"
)

// pendingRequestBlob is stored in pending_approvals.request_blob.
// It contains everything needed to re-execute the request on approval.
type pendingRequestBlob struct {
	Service         string                   `json:"service"`
	Action          string                   `json:"action"`
	Params          map[string]any           `json:"params"`
	UserID          string                   `json:"user_id"`
	AgentID         string                   `json:"agent_id"`
	AgentName       string                   `json:"agent_name"`
	RequestID       string                   `json:"request_id"`
	Reason          string                   `json:"reason"`
	CallbackURL     string                   `json:"callback_url"`
	CallbackKey     string                   `json:"callback_key,omitempty"`
	ResponseFilters []filters.ResponseFilter `json:"response_filters,omitempty"`
}

// GatewayHandler handles POST /api/gateway/request.
type GatewayHandler struct {
	store      store.Store
	vault      vault.Vault
	adapterReg *adapters.Registry
	notifier   notify.Notifier // may be nil if Telegram not configured
	safety     safety.SafetyChecker
	llmCfg     config.LLMConfig
	cfg        config.Config
	logger     *slog.Logger
	baseURL    string
}

func NewGatewayHandler(
	st store.Store,
	v vault.Vault,
	adapterReg *adapters.Registry,
	notifier notify.Notifier,
	safetyChecker safety.SafetyChecker,
	llmCfg config.LLMConfig,
	cfg config.Config,
	logger *slog.Logger,
	baseURL string,
) *GatewayHandler {
	return &GatewayHandler{
		store: st, vault: v, adapterReg: adapterReg,
		notifier: notifier, safety: safetyChecker, llmCfg: llmCfg, cfg: cfg, logger: logger, baseURL: baseURL,
	}
}

// HandleRequest is the main gateway entry point.
//
// Authorization flow: restrictions → task scope → per-request approval.
//
// POST /api/gateway/request
// Auth: agent bearer token
func (h *GatewayHandler) HandleRequest(w http.ResponseWriter, r *http.Request) {
	start := time.Now()
	ctx := r.Context()

	agent := middleware.AgentFromContext(ctx)
	if agent == nil {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "not authenticated")
		return
	}

	var req gateway.Request
	if !decodeJSON(w, r, &req) {
		return
	}
	if req.Service == "" || req.Action == "" {
		writeError(w, http.StatusBadRequest, "INVALID_REQUEST", "service and action are required")
		return
	}
	if req.RequestID == "" {
		req.RequestID = uuid.New().String()
	} else {
		// Dedup: if this request_id was already processed, return the existing outcome.
		if existing, err := h.store.GetAuditEntryByRequestID(ctx, req.RequestID, agent.UserID); err == nil {
			writeGatewayStatusResponse(w, existing)
			return
		}
	}

	paramsSafe, _ := json.Marshal(format.StripSecrets(cloneParams(req.Params)))

	auditID := uuid.New().String()

	// baseEntry builds an AuditEntry with fields common to all outcomes.
	baseEntry := func(decision, outcome string, taskID *string) *store.AuditEntry {
		return &store.AuditEntry{
			ID:         auditID,
			UserID:     agent.UserID,
			AgentID:    &agent.ID,
			RequestID:  req.RequestID,
			TaskID:     taskID,
			Timestamp:  time.Now().UTC(),
			Service:    req.Service,
			Action:     req.Action,
			ParamsSafe: json.RawMessage(paramsSafe),
			Decision:   decision,
			Outcome:    outcome,
			Reason:     nullableStr(req.Reason),
			DataOrigin: req.Context.DataOrigin,
			ContextSrc: nullableStr(req.Context.Source),
		}
	}

	// ── Step 1: Check restrictions ────────────────────────────────────────────
	if restriction, err := h.store.MatchRestriction(ctx, agent.UserID, req.Service, req.Action); err == nil {
		e := baseEntry("block", "blocked", nil)
		e.DurationMS = int(time.Since(start).Milliseconds())
		if logErr := h.store.LogAudit(ctx, e); logErr != nil {
			h.logger.Warn("audit log failed", "err", logErr)
		}
		reason := restriction.Reason
		if reason == "" {
			reason = fmt.Sprintf("Restricted: %s:%s is blocked", restriction.Service, restriction.Action)
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"status":     "blocked",
			"request_id": req.RequestID,
			"audit_id":   auditID,
			"reason":     reason,
		})
		return
	}

	// ── Step 2: Hardcoded approval check ─────────────────────────────────────
	hardcoded := RequiresHardcodedApproval(req.Service, req.Action)

	// ── Step 3: Task scope enforcement ───────────────────────────────────────
	if req.TaskID != "" {
		task, taskErr := h.store.GetTask(ctx, req.TaskID)
		if taskErr != nil {
			writeError(w, http.StatusBadRequest, "INVALID_REQUEST", "task not found")
			return
		}
		if task.UserID != agent.UserID {
			writeError(w, http.StatusForbidden, "FORBIDDEN", "task does not belong to this agent's user")
			return
		}
		if task.ExpiresAt != nil && time.Now().After(*task.ExpiresAt) {
			writeJSON(w, http.StatusOK, map[string]any{
				"status":  "task_expired",
				"task_id": req.TaskID,
				"message": "Task has expired. Use POST /api/tasks/{id}/expand to extend.",
			})
			return
		}
		if task.Status != "active" {
			writeError(w, http.StatusConflict, "INVALID_STATE",
				fmt.Sprintf("task is %s, not active", task.Status))
			return
		}

		match := CheckTaskScope(task, req.Service, req.Action)

		if !match.InScope {
			_ = h.store.IncrementTaskRequestCount(ctx, req.TaskID)
			msg := fmt.Sprintf("Action %s:%s is outside the approved task scope. Use POST /api/tasks/%s/expand to request it.",
				req.Service, req.Action, req.TaskID)
			if task.Lifetime == "standing" {
				msg = fmt.Sprintf("Action %s:%s is outside this standing task's scope. Standing tasks cannot be expanded — create a separate session task for this action, or revoke this task and create a new one with the additional actions.",
					req.Service, req.Action)
			}
			writeJSON(w, http.StatusOK, map[string]any{
				"status":     "pending_scope_expansion",
				"task_id":    req.TaskID,
				"request_id": req.RequestID,
				"message":    msg,
			})
			return
		}

		_ = h.store.IncrementTaskRequestCount(ctx, req.TaskID)

		// In scope + auto_execute + not hardcoded → execute directly
		if match.AutoExecute && !hardcoded {
			taskIDPtr := &req.TaskID
			responseFilters := getTaskActionFilters(task, req.Service, req.Action)
			result, filterRecs, execErr := executeAdapterRequest(ctx, h.vault, h.adapterReg,
				agent.UserID, req.Service, req.Action, req.Params, responseFilters,
				h.llmFilterFn())
			dur := int(time.Since(start).Milliseconds())

			if execErr != nil {
				if errors.Is(execErr, vault.ErrNotFound) {
					// Vault credential missing — handle pending_activation inline.
					adapter, adapterOK := h.adapterReg.Get(req.Service)
					if adapterOK && adapter.ValidateCredential(nil) != nil {
						e := baseEntry("approve", "pending_activation", taskIDPtr)
						e.DurationMS = dur
						errMsg := fmt.Sprintf("service %q not activated", req.Service)
						e.ErrorMsg = &errMsg
						if logErr := h.store.LogAudit(ctx, e); logErr != nil {
							h.logger.Warn("audit log failed", "err", logErr)
						}
						expiresAt := time.Now().Add(time.Duration(h.cfg.Approval.Timeout) * time.Second)
						blob := buildRequestBlob(req, agent, nil)
						activateURL := fmt.Sprintf("%s/api/oauth/start?service=%s&pending_request_id=%s",
							h.baseURL, req.Service, req.RequestID)
						denyURL := fmt.Sprintf("%s/api/approvals/%s/deny", h.baseURL, req.RequestID)
						if notifyErr := h.saveAndNotifyActivation(ctx, agent.UserID, blob, auditID,
							req.Context.CallbackURL, expiresAt, req.Service, agent.Name, req.Action,
							activateURL, denyURL); notifyErr != nil {
							h.logger.Warn("activation notification failed", "err", notifyErr)
						}
						writeJSON(w, http.StatusAccepted, map[string]any{
							"status":       "pending_activation",
							"request_id":   req.RequestID,
							"audit_id":     auditID,
							"message":      "Service not activated. Please activate in the Clawvisor dashboard.",
							"code":         "SERVICE_NOT_CONFIGURED",
							"activate_url": activateURL,
						})
						return
					}
				}
				errMsg := execErr.Error()
				e := baseEntry("execute", "error", taskIDPtr)
				e.DurationMS = dur
				e.ErrorMsg = &errMsg
				if logErr := h.store.LogAudit(ctx, e); logErr != nil {
					h.logger.Warn("audit log failed", "err", logErr)
				}
				if req.Context.CallbackURL != "" {
					tokenHash := agent.TokenHash
					go func() {
						_ = callback.DeliverResult(context.Background(), req.Context.CallbackURL, &callback.Payload{
							RequestID: req.RequestID, Status: "error", Error: errMsg, AuditID: auditID,
						}, tokenHash)
					}()
				}
				writeJSON(w, http.StatusOK, map[string]any{
					"status":     "error",
					"request_id": req.RequestID,
					"audit_id":   auditID,
					"error":      errMsg,
					"code":       "EXECUTION_ERROR",
				})
				return
			}

			// LLM safety check
			safetyResult, _ := h.safety.Check(ctx, agent.UserID, &req, result)
			if !safetyResult.Safe {
				e := baseEntry("execute", "pending", taskIDPtr)
				e.DurationMS = dur
				e.SafetyFlagged = true
				e.SafetyReason = &safetyResult.Reason
				if len(filterRecs) > 0 {
					if b, err := json.Marshal(filterRecs); err == nil {
						e.FiltersApplied = b
					}
				}
				if logErr := h.store.LogAudit(ctx, e); logErr != nil {
					h.logger.Warn("audit log failed", "err", logErr)
				}
				expiresAt := time.Now().Add(time.Duration(h.cfg.Approval.Timeout) * time.Second)
				blob := buildRequestBlob(req, agent, responseFilters)
				if routeErr := h.routeToApproval(ctx, agent.UserID, blob, auditID,
					req.Context.CallbackURL, expiresAt, "Safety: "+safetyResult.Reason,
					true, safetyResult.Reason); routeErr != nil {
					h.logger.Warn("route to approval failed (safety)", "err", routeErr)
				}
				writeJSON(w, http.StatusAccepted, map[string]any{
					"status":     "pending",
					"request_id": req.RequestID,
					"audit_id":   auditID,
					"message":    "Safety check flagged this request. Approval requested.",
				})
				return
			}

			// Success
			e := baseEntry("execute", "executed", taskIDPtr)
			e.DurationMS = dur
			if len(filterRecs) > 0 {
				if b, err := json.Marshal(filterRecs); err == nil {
					e.FiltersApplied = b
				}
			}
			if logErr := h.store.LogAudit(ctx, e); logErr != nil {
				h.logger.Warn("audit log failed", "err", logErr)
			}
			if req.Context.CallbackURL != "" {
				tokenHash := agent.TokenHash
				go func() {
					_ = callback.DeliverResult(context.Background(), req.Context.CallbackURL, &callback.Payload{
						RequestID: req.RequestID, Status: "executed", Result: result, AuditID: auditID,
					}, tokenHash)
				}()
			}
			writeJSON(w, http.StatusOK, map[string]any{
				"status":     "executed",
				"request_id": req.RequestID,
				"audit_id":   auditID,
				"result":     result,
			})
			return
		}

		// In scope + (!auto_execute || hardcoded) → falls through to per-request approval below
	}

	// ── Step 4: Per-request approval (default path) ──────────────────────────
	// This covers: no task_id, or task in-scope but not auto-execute, or hardcoded approval.

	// Reject unknown services immediately.
	approveAdapter, ok := h.adapterReg.Get(req.Service)
	if !ok {
		e := baseEntry("approve", "error", nil)
		e.DurationMS = int(time.Since(start).Milliseconds())
		errMsg := fmt.Sprintf("unknown service %q", req.Service)
		e.ErrorMsg = &errMsg
		if logErr := h.store.LogAudit(ctx, e); logErr != nil {
			h.logger.Warn("audit log failed", "err", logErr)
		}
		writeJSON(w, http.StatusBadRequest, map[string]any{
			"status":     "error",
			"request_id": req.RequestID,
			"audit_id":   auditID,
			"error":      fmt.Sprintf("unknown service %q: not a supported service", req.Service),
			"code":       "UNKNOWN_SERVICE",
		})
		return
	}

	// Check if service needs activation.
	vKey := vaultKeyForService(req.Service)
	if _, vaultErr := h.vault.Get(ctx, agent.UserID, vKey); errors.Is(vaultErr, vault.ErrNotFound) &&
		approveAdapter.ValidateCredential(nil) != nil {
		e := baseEntry("approve", "pending_activation", nil)
		e.DurationMS = int(time.Since(start).Milliseconds())
		errMsg := fmt.Sprintf("service %q not activated", req.Service)
		e.ErrorMsg = &errMsg
		if logErr := h.store.LogAudit(ctx, e); logErr != nil {
			h.logger.Warn("audit log failed", "err", logErr)
		}
		expiresAt := time.Now().Add(time.Duration(h.cfg.Approval.Timeout) * time.Second)
		blob := buildRequestBlob(req, agent, nil)
		activateURL := fmt.Sprintf("%s/api/oauth/start?service=%s&pending_request_id=%s",
			h.baseURL, req.Service, req.RequestID)
		denyURL := fmt.Sprintf("%s/api/approvals/%s/deny", h.baseURL, req.RequestID)
		if notifyErr := h.saveAndNotifyActivation(ctx, agent.UserID, blob, auditID,
			req.Context.CallbackURL, expiresAt, req.Service, agent.Name, req.Action,
			activateURL, denyURL); notifyErr != nil {
			h.logger.Warn("activation notification failed", "err", notifyErr)
		}
		writeJSON(w, http.StatusAccepted, map[string]any{
			"status":       "pending_activation",
			"request_id":   req.RequestID,
			"audit_id":     auditID,
			"message":      "Service not activated. Please activate in the Clawvisor dashboard.",
			"code":         "SERVICE_NOT_CONFIGURED",
			"activate_url": activateURL,
		})
		return
	}

	// Route to per-request approval.
	e := baseEntry("approve", "pending", nil)
	if req.TaskID != "" {
		e.TaskID = &req.TaskID
	}
	e.DurationMS = int(time.Since(start).Milliseconds())
	if logErr := h.store.LogAudit(ctx, e); logErr != nil {
		h.logger.Warn("audit log failed", "err", logErr)
	}
	expiresAt := time.Now().Add(time.Duration(h.cfg.Approval.Timeout) * time.Second)
	blob := buildRequestBlob(req, agent, nil)
	reason := ""
	if hardcoded {
		reason = "iMessage send_message always requires human approval"
	}
	if routeErr := h.routeToApproval(ctx, agent.UserID, blob, auditID,
		req.Context.CallbackURL, expiresAt, reason, false, ""); routeErr != nil {
		h.logger.Warn("route to approval failed", "err", routeErr)
	}
	writeJSON(w, http.StatusAccepted, map[string]any{
		"status":     "pending",
		"request_id": req.RequestID,
		"audit_id":   auditID,
		"message":    fmt.Sprintf("Approval requested. Waiting up to %ds.", h.cfg.Approval.Timeout),
	})
}

// HandleStatus returns the current status of a gateway request by request_id.
//
// GET /api/gateway/request/{request_id}/status
// Auth: agent bearer token
func (h *GatewayHandler) HandleStatus(w http.ResponseWriter, r *http.Request) {
	agent := middleware.AgentFromContext(r.Context())
	if agent == nil {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "not authenticated")
		return
	}
	requestID := r.PathValue("request_id")
	entry, err := h.store.GetAuditEntryByRequestID(r.Context(), requestID, agent.UserID)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusNotFound, "NOT_FOUND", "request not found")
			return
		}
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "could not fetch request status")
		return
	}
	writeGatewayStatusResponse(w, entry)
}

// writeGatewayStatusResponse writes a consistent status payload for a resolved audit entry.
func writeGatewayStatusResponse(w http.ResponseWriter, e *store.AuditEntry) {
	resp := map[string]any{
		"status":     e.Outcome,
		"request_id": e.RequestID,
		"audit_id":   e.ID,
	}
	if e.ErrorMsg != nil && *e.ErrorMsg != "" {
		resp["error"] = *e.ErrorMsg
	}
	if e.Reason != nil {
		resp["reason"] = *e.Reason
	}
	writeJSON(w, http.StatusOK, resp)
}

// ── Shared execution logic ────────────────────────────────────────────────────

// executeAdapterRequest fetches the credential from vault, calls the adapter,
// and applies response filters. Shared between gateway and approvals handlers.
func executeAdapterRequest(
	ctx context.Context,
	v vault.Vault,
	reg *adapters.Registry,
	userID, service, action string,
	params map[string]any,
	responseFilters []filters.ResponseFilter,
	semanticFn filters.SemanticApplyFn,
) (*adapters.Result, []filters.FilterRecord, error) {
	adapter, ok := reg.Get(service)
	if !ok {
		return nil, nil, fmt.Errorf("service %q is not supported", service)
	}

	vKey := vaultKeyForService(service)
	cred, err := v.Get(ctx, userID, vKey)
	if err != nil {
		if errors.Is(err, vault.ErrNotFound) && adapter.ValidateCredential(nil) == nil {
			cred = nil
		} else {
			return nil, nil, err
		}
	}

	result, err := adapter.Execute(ctx, adapters.Request{
		Action:     action,
		Params:     params,
		Credential: cred,
	})
	if err != nil {
		return nil, nil, fmt.Errorf("adapter %s: %w", service, err)
	}

	if len(responseFilters) > 0 {
		result, filterRecs := filters.ApplyContext(ctx, result, responseFilters, semanticFn)
		return result, filterRecs, nil
	}
	return result, nil, nil
}

// llmFilterFn builds a SemanticApplyFn from the current LLM filter config.
func (h *GatewayHandler) llmFilterFn() filters.SemanticApplyFn {
	cfg := h.llmCfg.Filters
	if !cfg.Enabled {
		return nil
	}
	return filters.MakeLLMFilterFn(llm.NewClient(cfg))
}

// ── Approval routing ──────────────────────────────────────────────────────────

func (h *GatewayHandler) routeToApproval(
	ctx context.Context,
	userID string,
	blob *pendingRequestBlob,
	auditID, callbackURL string,
	expiresAt time.Time,
	policyReason string,
	safetyFlagged bool,
	safetyReason string,
) error {
	blobBytes, _ := json.Marshal(blob)
	pa := &store.PendingApproval{
		ID:          uuid.New().String(),
		UserID:      userID,
		RequestID:   blob.RequestID,
		AuditID:     auditID,
		RequestBlob: json.RawMessage(blobBytes),
		ExpiresAt:   expiresAt,
	}
	if callbackURL != "" {
		pa.CallbackURL = &callbackURL
	}
	if err := h.store.SavePendingApproval(ctx, pa); err != nil {
		return fmt.Errorf("save pending approval: %w", err)
	}

	if h.notifier == nil {
		return nil
	}

	expiresIn := fmt.Sprintf("%d minutes", int(time.Until(expiresAt).Minutes()))
	approveURL := fmt.Sprintf("%s/api/approvals/%s/approve", h.baseURL, blob.RequestID)
	denyURL := fmt.Sprintf("%s/api/approvals/%s/deny", h.baseURL, blob.RequestID)

	reason := policyReason
	if safetyFlagged && safetyReason != "" {
		reason = "🔴 Safety check flagged: " + safetyReason
	}

	msgID, err := h.notifier.SendApprovalRequest(ctx, notify.ApprovalRequest{
		PendingID:    pa.ID,
		RequestID:    blob.RequestID,
		UserID:       userID,
		AgentName:    blob.AgentName,
		Service:      blob.Service,
		Action:       blob.Action,
		Params:       blob.Params,
		Reason:       blob.Reason,
		PolicyReason: reason,
		ExpiresIn:    expiresIn,
		ApproveURL:   approveURL,
		DenyURL:      denyURL,
	})
	if err != nil {
		h.logger.Warn("telegram approval notification failed", "err", err)
		return nil
	}

	_ = h.store.UpdatePendingTelegramMsgID(ctx, blob.RequestID, msgID)
	return nil
}

func (h *GatewayHandler) saveAndNotifyActivation(
	ctx context.Context,
	userID string,
	blob *pendingRequestBlob,
	auditID, callbackURL string,
	expiresAt time.Time,
	service, agentName, action, activateURL, denyURL string,
) error {
	blobBytes, _ := json.Marshal(blob)
	pa := &store.PendingApproval{
		ID:          uuid.New().String(),
		UserID:      userID,
		RequestID:   blob.RequestID,
		AuditID:     auditID,
		RequestBlob: json.RawMessage(blobBytes),
		ExpiresAt:   expiresAt,
	}
	if callbackURL != "" {
		pa.CallbackURL = &callbackURL
	}
	if err := h.store.SavePendingApproval(ctx, pa); err != nil {
		return fmt.Errorf("save pending approval (activation): %w", err)
	}

	if h.notifier == nil {
		return nil
	}

	if err := h.notifier.SendActivationRequest(ctx, notify.ActivationRequest{
		UserID:      userID,
		AgentName:   agentName,
		Service:     service,
		ActivateURL: activateURL,
		DenyURL:     denyURL,
	}); err != nil {
		h.logger.Warn("telegram activation notification failed", "err", err)
	}
	return nil
}

// ── Helpers ───────────────────────────────────────────────────────────────────

func vaultKeyForService(serviceID string) string {
	if strings.HasPrefix(serviceID, "google.") {
		return "google"
	}
	return serviceID
}

func buildRequestBlob(req gateway.Request, agent *store.Agent, responseFilters []filters.ResponseFilter) *pendingRequestBlob {
	return &pendingRequestBlob{
		Service:         req.Service,
		Action:          req.Action,
		Params:          req.Params,
		UserID:          agent.UserID,
		AgentID:         agent.ID,
		AgentName:       agent.Name,
		RequestID:       req.RequestID,
		Reason:          req.Reason,
		CallbackURL:     req.Context.CallbackURL,
		CallbackKey:     agent.TokenHash,
		ResponseFilters: responseFilters,
	}
}

func nullableStr(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func cloneParams(m map[string]any) map[string]any {
	if m == nil {
		return nil
	}
	out := make(map[string]any, len(m))
	for k, v := range m {
		out[k] = v
	}
	return out
}

// getTaskActionFilters finds the matching TaskAction for service/action and
// unmarshals its response_filters JSON.
func getTaskActionFilters(task *store.Task, service, action string) []filters.ResponseFilter {
	for _, a := range task.AuthorizedActions {
		if a.Service == service && (a.Action == action || a.Action == "*") {
			if len(a.ResponseFilters) == 0 {
				return nil
			}
			var rf []filters.ResponseFilter
			if err := json.Unmarshal(a.ResponseFilters, &rf); err != nil {
				return nil
			}
			return rf
		}
	}
	return nil
}
