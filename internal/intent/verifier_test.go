package intent

import (
	"testing"
	"time"
)

func TestParseVerificationResponse_ValidJSON(t *testing.T) {
	raw := `{"allow": true, "param_scope": "ok", "reason_coherence": "ok", "explanation": "All checks passed."}`
	v, err := parseVerificationResponse(raw)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !v.Allow {
		t.Error("expected Allow=true")
	}
	if v.ParamScope != "ok" {
		t.Errorf("expected param_scope=ok, got %q", v.ParamScope)
	}
	if v.ReasonCoherence != "ok" {
		t.Errorf("expected reason_coherence=ok, got %q", v.ReasonCoherence)
	}
	if v.Explanation != "All checks passed." {
		t.Errorf("unexpected explanation: %q", v.Explanation)
	}
}

func TestParseVerificationResponse_MarkdownWrapped(t *testing.T) {
	raw := "```json\n{\"allow\": false, \"param_scope\": \"violation\", \"reason_coherence\": \"ok\", \"explanation\": \"Params too broad.\"}\n```"
	v, err := parseVerificationResponse(raw)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if v.Allow {
		t.Error("expected Allow=false")
	}
	if v.ParamScope != "violation" {
		t.Errorf("expected param_scope=violation, got %q", v.ParamScope)
	}
}

func TestParseVerificationResponse_Invalid(t *testing.T) {
	_, err := parseVerificationResponse("not json at all")
	if err == nil {
		t.Error("expected error for invalid JSON")
	}
}

func TestParseVerificationResponse_InvalidEnum(t *testing.T) {
	raw := `{"allow": true, "param_scope": "bad", "reason_coherence": "ok", "explanation": "test"}`
	_, err := parseVerificationResponse(raw)
	if err == nil {
		t.Error("expected error for invalid param_scope enum")
	}
}

func TestBuildVerificationUserMessage_WithExpectedUse(t *testing.T) {
	req := VerifyRequest{
		TaskPurpose: "Check today's calendar",
		ExpectedUse: "Fetch today's events only",
		Service:     "google.calendar",
		Action:      "list_events",
		Params:      map[string]any{"from": "2025-01-01", "to": "2025-01-01"},
		Reason:      "Getting today's schedule",
	}
	msg := buildVerificationUserMessage(req)
	if msg == "" {
		t.Fatal("expected non-empty message")
	}
	if !contains(msg, "Fetch today's events only") {
		t.Error("expected expected_use in message")
	}
	if !contains(msg, "google.calendar") {
		t.Error("expected service in message")
	}
}

func TestBuildVerificationUserMessage_NoExpectedUse(t *testing.T) {
	req := VerifyRequest{
		TaskPurpose: "Check calendar",
		Service:     "google.calendar",
		Action:      "list_events",
		Params:      map[string]any{},
		Reason:      "Testing",
	}
	msg := buildVerificationUserMessage(req)
	if !contains(msg, "not specified") {
		t.Error("expected 'not specified' when no expected_use")
	}
}

func TestCacheHitAndMiss(t *testing.T) {
	c := newVerdictCache(time.Minute)
	key := cacheKey("test-key")

	// Miss
	_, ok := c.Get(key)
	if ok {
		t.Error("expected cache miss")
	}

	// Put + hit
	verdict := &VerificationVerdict{Allow: true, ParamScope: "ok", ReasonCoherence: "ok"}
	c.Put(key, verdict)

	got, ok := c.Get(key)
	if !ok {
		t.Fatal("expected cache hit")
	}
	if !got.Allow {
		t.Error("expected cached Allow=true")
	}
}

func TestCacheExpiry(t *testing.T) {
	c := newVerdictCache(1 * time.Millisecond)
	key := cacheKey("expire-key")
	c.Put(key, &VerificationVerdict{Allow: true})

	time.Sleep(5 * time.Millisecond)

	_, ok := c.Get(key)
	if ok {
		t.Error("expected cache miss after expiry")
	}
}

func TestCacheCleanup(t *testing.T) {
	c := newVerdictCache(1 * time.Millisecond)
	c.Put(cacheKey("a"), &VerificationVerdict{Allow: true})
	c.Put(cacheKey("b"), &VerificationVerdict{Allow: false})

	time.Sleep(5 * time.Millisecond)
	c.Cleanup()

	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.entries) != 0 {
		t.Errorf("expected 0 entries after cleanup, got %d", len(c.entries))
	}
}

func TestBuildCacheKey(t *testing.T) {
	req1 := VerifyRequest{
		TaskID:  "task-1",
		Service: "google.gmail",
		Action:  "send_email",
		Params:  map[string]any{"to": "test@example.com"},
		Reason:  "Sending update",
	}
	req2 := req1
	req2.Reason = "Different reason"

	key1 := buildCacheKey(req1)
	key2 := buildCacheKey(req2)

	if key1 == key2 {
		t.Error("different reasons should produce different cache keys")
	}

	// Same request → same key
	key1b := buildCacheKey(req1)
	if key1 != key1b {
		t.Error("same request should produce same cache key")
	}
}

func TestMarshalVerdict(t *testing.T) {
	v := &VerificationVerdict{
		Allow:           true,
		ParamScope:      "ok",
		ReasonCoherence: "ok",
		Explanation:     "All good",
		Model:           "test-model",
		LatencyMS:       100,
	}
	b := MarshalVerdict(v)
	if b == nil {
		t.Fatal("expected non-nil bytes")
	}
	if !contains(string(b), "All good") {
		t.Error("expected explanation in marshaled output")
	}
}

func TestMarshalVerdict_Nil(t *testing.T) {
	b := MarshalVerdict(nil)
	if b != nil {
		t.Error("expected nil for nil verdict")
	}
}

func contains(s, sub string) bool {
	return len(s) >= len(sub) && (s == sub || len(s) > 0 && containsStr(s, sub))
}

func containsStr(s, sub string) bool {
	for i := 0; i <= len(s)-len(sub); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}
