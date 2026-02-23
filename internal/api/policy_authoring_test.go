package api_test

// Integration tests for Phase 4 addenda:
//   POST /api/policies/validate  (with check_semantic param)
//   POST /api/policies/generate  (LLM-backed policy generation)

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/ericlevine/clawvisor/internal/adapters"
	"github.com/ericlevine/clawvisor/internal/api"
	"github.com/ericlevine/clawvisor/internal/auth"
	"github.com/ericlevine/clawvisor/internal/config"
	"github.com/ericlevine/clawvisor/internal/policy"
	"github.com/ericlevine/clawvisor/internal/safety"
	sqlitestore "github.com/ericlevine/clawvisor/internal/store/sqlite"
	"github.com/ericlevine/clawvisor/internal/vault"
)

// ── Mock LLM server helpers ───────────────────────────────────────────────────

// mockLLMServer starts a test server that returns a fixed content string for
// every POST to /v1/chat/completions.
func mockLLMServer(t *testing.T, content string) *httptest.Server {
	t.Helper()
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/chat/completions" {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		resp, _ := json.Marshal(map[string]any{
			"choices": []map[string]any{
				{"message": map[string]any{"content": content}},
			},
		})
		w.Header().Set("Content-Type", "application/json")
		w.Write(resp)
	}))
	t.Cleanup(ts.Close)
	return ts
}

// llmProviderCfg returns an LLMProviderConfig pointing at ts.
func llmProviderCfg(ts *httptest.Server) config.LLMProviderConfig {
	return config.LLMProviderConfig{
		Enabled:        true,
		Endpoint:       ts.URL + "/v1",
		APIKey:         "test",
		Model:          "test-model",
		TimeoutSeconds: 5,
	}
}

// newTestEnvWithLLM is like newTestEnv but uses the supplied LLMConfig.
func newTestEnvWithLLM(t *testing.T, llmCfg config.LLMConfig) *testEnv {
	t.Helper()
	ctx := context.Background()

	db, err := sqlitestore.New(ctx, t.TempDir()+"/test.db")
	if err != nil {
		t.Fatalf("sqlite: %v", err)
	}
	st := sqlitestore.NewStore(db)

	v, err := vault.NewLocalVault(t.TempDir()+"/vault.key", db, "sqlite")
	if err != nil {
		t.Fatalf("vault: %v", err)
	}

	jwtSvc, err := auth.NewJWTService("test-secret-llm")
	if err != nil {
		t.Fatalf("jwt: %v", err)
	}

	reg := policy.NewRegistry()
	adapterReg := adapters.NewRegistry()

	cfg := &config.Config{
		Server: config.ServerConfig{Host: "127.0.0.1", Port: 0},
		Auth: config.AuthConfig{
			JWTSecret:       "test-secret-llm",
			AccessTokenTTL:  "15m",
			RefreshTokenTTL: "720h",
		},
		Approval: config.ApprovalConfig{Timeout: 300, OnTimeout: "fail"},
	}

	srv, err := api.New(cfg, st, v, jwtSvc, reg, adapterReg, nil, safety.NoopChecker{}, llmCfg)
	if err != nil {
		t.Fatalf("api.New: %v", err)
	}

	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)
	t.Cleanup(func() { _ = st.Close() })

	return &testEnv{t: t, ts: ts, Vault: v, Store: st, client: ts.Client()}
}

// validPolicyYAML is a simple valid policy for use across tests.
const validPolicyYAML = `id: test-validate-policy
name: Test Validate
rules:
  - service: google.gmail
    actions: [send_message]
    allow: false
    reason: Test block
`

// ── POST /api/policies/validate ───────────────────────────────────────────────

func TestValidate_SemanticConflicts_NullWhenLLMDisabled(t *testing.T) {
	// check_semantic=true but no LLM configured → semantic_conflicts must be null.
	env := newTestEnv(t)
	s := newSession(t, env)

	resp := s.do("POST", "/api/policies/validate", map[string]any{
		"yaml":           validPolicyYAML,
		"check_semantic": true,
	})
	body := mustStatus(t, resp, http.StatusOK)

	if v, ok := body["valid"].(bool); !ok || !v {
		t.Errorf("validate: expected valid=true, got %v", body["valid"])
	}
	// semantic_conflicts key must be present and null (not an array).
	sc, exists := body["semantic_conflicts"]
	if !exists {
		t.Error("validate: semantic_conflicts key missing from response")
	}
	if sc != nil {
		t.Errorf("validate: expected semantic_conflicts=null when LLM disabled, got %v", sc)
	}
}

func TestValidate_SemanticConflicts_NullWhenNotRequested(t *testing.T) {
	// check_semantic not sent (defaults false) → semantic_conflicts is null.
	env := newTestEnv(t)
	s := newSession(t, env)

	resp := s.do("POST", "/api/policies/validate", map[string]any{
		"yaml": validPolicyYAML,
		// check_semantic omitted
	})
	body := mustStatus(t, resp, http.StatusOK)

	sc, exists := body["semantic_conflicts"]
	if !exists {
		t.Error("validate: semantic_conflicts key missing from response")
	}
	if sc != nil {
		t.Errorf("validate: expected semantic_conflicts=null when not requested, got %v", sc)
	}
}

func TestValidate_SemanticConflicts_EmptyArrayWhenLLMEnabledNoConflicts(t *testing.T) {
	// check_semantic=true, LLM returns "[]" → semantic_conflicts is [] (empty array).
	llmTS := mockLLMServer(t, "[]")
	llmCfg := config.LLMConfig{Authoring: llmProviderCfg(llmTS)}

	env := newTestEnvWithLLM(t, llmCfg)
	s := newSession(t, env)

	// Create a pre-existing policy so conflict checker has something to compare against.
	s.do("POST", "/api/roles", map[string]any{"name": "ops"})
	s.do("POST", "/api/policies", map[string]any{"yaml": `id: existing-policy
name: Existing
rules:
  - service: github
    actions: [list_issues]
    allow: true
`})

	resp := s.do("POST", "/api/policies/validate", map[string]any{
		"yaml":           validPolicyYAML,
		"check_semantic": true,
	})
	body := mustStatus(t, resp, http.StatusOK)

	if v, ok := body["valid"].(bool); !ok || !v {
		t.Errorf("validate: expected valid=true, got %v", body["valid"])
	}
	sc, exists := body["semantic_conflicts"]
	if !exists {
		t.Fatal("validate: semantic_conflicts key missing")
	}
	if sc == nil {
		t.Error("validate: expected empty array (not null) when LLM enabled and returns []")
	}
	arr, ok := sc.([]any)
	if !ok {
		t.Fatalf("validate: expected semantic_conflicts to be array, got %T", sc)
	}
	if len(arr) != 0 {
		t.Errorf("validate: expected 0 semantic conflicts, got %d", len(arr))
	}
}

func TestValidate_SemanticConflicts_ConflictReturned(t *testing.T) {
	// LLM returns a warning conflict → it should appear in the response.
	conflictResp := `[{"description":"Contradictory data access intent","affected_policies":["existing-policy"],"severity":"warning"}]`
	llmTS := mockLLMServer(t, conflictResp)
	llmCfg := config.LLMConfig{Authoring: llmProviderCfg(llmTS)}

	env := newTestEnvWithLLM(t, llmCfg)
	s := newSession(t, env)

	s.do("POST", "/api/roles", map[string]any{"name": "ops"})
	s.do("POST", "/api/policies", map[string]any{"yaml": `id: existing-policy
name: Existing
rules:
  - service: github
    actions: [list_issues]
    allow: true
`})

	resp := s.do("POST", "/api/policies/validate", map[string]any{
		"yaml":           validPolicyYAML,
		"check_semantic": true,
	})
	body := mustStatus(t, resp, http.StatusOK)

	sc, exists := body["semantic_conflicts"]
	if !exists {
		t.Fatal("validate: semantic_conflicts key missing")
	}
	arr, ok := sc.([]any)
	if !ok || len(arr) == 0 {
		t.Fatalf("validate: expected at least 1 semantic conflict, got %v", sc)
	}
	conflict := arr[0].(map[string]any)
	if conflict["severity"] != "warning" {
		t.Errorf("conflict severity: got %v, want warning", conflict["severity"])
	}
	if conflict["description"] == "" {
		t.Error("conflict description should be non-empty")
	}
}

func TestValidate_InvalidYAML_SemanticNullRegardlessOfFlag(t *testing.T) {
	// Invalid YAML + check_semantic=true → valid=false, semantic_conflicts=null.
	llmTS := mockLLMServer(t, "[]")
	llmCfg := config.LLMConfig{Authoring: llmProviderCfg(llmTS)}

	env := newTestEnvWithLLM(t, llmCfg)
	s := newSession(t, env)

	resp := s.do("POST", "/api/policies/validate", map[string]any{
		"yaml":           "not: valid: yaml: ::::",
		"check_semantic": true,
	})
	body := mustStatus(t, resp, http.StatusOK)

	if v, _ := body["valid"].(bool); v {
		t.Error("invalid yaml: expected valid=false")
	}
	sc := body["semantic_conflicts"]
	if sc != nil {
		t.Errorf("invalid yaml: expected semantic_conflicts=null, got %v", sc)
	}
}

func TestValidate_RequiresAuth(t *testing.T) {
	env := newTestEnv(t)

	resp := env.do("POST", "/api/policies/validate", "", map[string]any{"yaml": validPolicyYAML})
	mustStatus(t, resp, http.StatusUnauthorized)
}

// ── POST /api/policies/generate ───────────────────────────────────────────────

func TestGenerate_LLMDisabled_Returns503(t *testing.T) {
	// No LLM configured → 503 SERVICE UNAVAILABLE.
	env := newTestEnv(t)
	s := newSession(t, env)

	resp := s.do("POST", "/api/policies/generate", map[string]any{
		"description": "Block all email sending",
	})
	body := mustStatus(t, resp, http.StatusServiceUnavailable)
	if code, _ := body["code"].(string); code != "LLM_DISABLED" {
		t.Errorf("generate disabled: expected code=LLM_DISABLED, got %q", code)
	}
}

func TestGenerate_MissingDescription_Returns400(t *testing.T) {
	llmTS := mockLLMServer(t, "")
	llmCfg := config.LLMConfig{Authoring: llmProviderCfg(llmTS)}

	env := newTestEnvWithLLM(t, llmCfg)
	s := newSession(t, env)

	resp := s.do("POST", "/api/policies/generate", map[string]any{
		"description": "",
	})
	mustStatus(t, resp, http.StatusBadRequest)
}

func TestGenerate_LLMEnabled_ReturnsYAML(t *testing.T) {
	generatedYAML := `id: block-gmail-send
name: Block Gmail Send
rules:
  - service: google.gmail
    actions: [send_message]
    allow: false
    reason: Generated policy
`
	llmTS := mockLLMServer(t, generatedYAML)
	llmCfg := config.LLMConfig{Authoring: llmProviderCfg(llmTS)}

	env := newTestEnvWithLLM(t, llmCfg)
	s := newSession(t, env)

	resp := s.do("POST", "/api/policies/generate", map[string]any{
		"description": "Block all email sending",
	})
	body := mustStatus(t, resp, http.StatusOK)

	yaml, ok := body["yaml"].(string)
	if !ok || yaml == "" {
		t.Fatalf("generate: expected non-empty yaml field, got %v", body["yaml"])
	}
	// CleanYAMLFences trims surrounding whitespace, so compare trimmed content.
	want := strings.TrimSpace(generatedYAML)
	if yaml != want {
		t.Errorf("generate: yaml mismatch\ngot:  %q\nwant: %q", yaml, want)
	}
}

func TestGenerate_LLMEnabled_WithContext_ReturnsYAML(t *testing.T) {
	generatedYAML := `id: researcher-gmail-allow
name: Researcher Gmail Allow
role: researcher
rules:
  - service: google.gmail
    actions: [list_messages, get_message]
    allow: true
`
	llmTS := mockLLMServer(t, generatedYAML)
	llmCfg := config.LLMConfig{Authoring: llmProviderCfg(llmTS)}

	env := newTestEnvWithLLM(t, llmCfg)
	s := newSession(t, env)

	resp := s.do("POST", "/api/policies/generate", map[string]any{
		"description": "Allow researchers to read gmail",
		"context": map[string]any{
			"role":         "researcher",
			"existing_ids": []string{"p-existing-1"},
		},
	})
	body := mustStatus(t, resp, http.StatusOK)

	yaml, ok := body["yaml"].(string)
	if !ok || yaml == "" {
		t.Fatalf("generate: expected non-empty yaml field, got %v", body["yaml"])
	}
}

func TestGenerate_LLMEnabled_InvalidYAMLFromLLM_Returns422(t *testing.T) {
	// LLM returns invalid YAML both attempts → 422.
	llmTS := mockLLMServer(t, "this is not: valid: yaml: :::")
	llmCfg := config.LLMConfig{Authoring: llmProviderCfg(llmTS)}

	env := newTestEnvWithLLM(t, llmCfg)
	s := newSession(t, env)

	resp := s.do("POST", "/api/policies/generate", map[string]any{
		"description": "Some policy",
	})
	mustStatus(t, resp, http.StatusUnprocessableEntity)
}

func TestGenerate_RequiresAuth(t *testing.T) {
	env := newTestEnv(t)

	resp := env.do("POST", "/api/policies/generate", "", map[string]any{
		"description": "Block email",
	})
	mustStatus(t, resp, http.StatusUnauthorized)
}

func TestGenerate_LLMEnabled_ResultSaveable(t *testing.T) {
	// Verify a generated policy can be saved without errors.
	generatedYAML := fmt.Sprintf(`id: generated-saveable-%s
name: Generated Saveable
rules:
  - service: google.gmail
    actions: [send_message]
    allow: false
    reason: Generated
`, randSuffix())

	llmTS := mockLLMServer(t, generatedYAML)
	llmCfg := config.LLMConfig{Authoring: llmProviderCfg(llmTS)}

	env := newTestEnvWithLLM(t, llmCfg)
	s := newSession(t, env)

	// Generate
	resp := s.do("POST", "/api/policies/generate", map[string]any{
		"description": "Block email sends",
	})
	body := mustStatus(t, resp, http.StatusOK)
	yaml := body["yaml"].(string)

	// Save the generated policy
	resp = s.do("POST", "/api/policies", map[string]any{"yaml": yaml})
	savedBody := mustStatus(t, resp, http.StatusCreated)
	if str(t, savedBody, "id") == "" {
		t.Error("saved generated policy: id missing")
	}
}
