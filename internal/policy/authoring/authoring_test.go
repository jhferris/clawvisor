package authoring_test

import (
	"strings"
	"testing"

	"github.com/ericlevine/clawvisor/internal/policy/authoring"
	"github.com/ericlevine/clawvisor/internal/store"
)

// ── ParseConflictResponse ─────────────────────────────────────────────────────

func TestParseConflictResponse_Empty(t *testing.T) {
	got := authoring.ParseConflictResponse("[]")
	if len(got) != 0 {
		t.Errorf("expected empty slice, got %v", got)
	}
	if got == nil {
		t.Error("expected non-nil empty slice")
	}
}

func TestParseConflictResponse_SingleWarning(t *testing.T) {
	raw := `[{"description":"Policy A allows but Policy B blocks","affected_policies":["a","b"],"severity":"warning"}]`
	got := authoring.ParseConflictResponse(raw)
	if len(got) != 1 {
		t.Fatalf("expected 1 conflict, got %d", len(got))
	}
	if got[0].Severity != "warning" {
		t.Errorf("severity: got %q, want warning", got[0].Severity)
	}
	if got[0].Description == "" {
		t.Error("description should be non-empty")
	}
	if len(got[0].AffectedPolicies) != 2 {
		t.Errorf("affected_policies: got %v, want 2 items", got[0].AffectedPolicies)
	}
}

func TestParseConflictResponse_InfoSeverity(t *testing.T) {
	raw := `[{"description":"Possible overlap","affected_policies":["x"],"severity":"info"}]`
	got := authoring.ParseConflictResponse(raw)
	if len(got) != 1 {
		t.Fatalf("expected 1 conflict, got %d", len(got))
	}
	if got[0].Severity != "info" {
		t.Errorf("severity: got %q, want info", got[0].Severity)
	}
}

func TestParseConflictResponse_Multiple(t *testing.T) {
	raw := `[
		{"description":"first","affected_policies":["a"],"severity":"warning"},
		{"description":"second","affected_policies":["b","c"],"severity":"info"}
	]`
	got := authoring.ParseConflictResponse(raw)
	if len(got) != 2 {
		t.Fatalf("expected 2 conflicts, got %d", len(got))
	}
}

func TestParseConflictResponse_WithJSONFence(t *testing.T) {
	raw := "```json\n[]\n```"
	got := authoring.ParseConflictResponse(raw)
	if len(got) != 0 {
		t.Errorf("expected empty after json fence strip, got %v", got)
	}
}

func TestParseConflictResponse_WithPlainFence(t *testing.T) {
	raw := "```\n[]\n```"
	got := authoring.ParseConflictResponse(raw)
	if len(got) != 0 {
		t.Errorf("expected empty after plain fence strip, got %v", got)
	}
}

func TestParseConflictResponse_Invalid_ReturnsEmptyNotNil(t *testing.T) {
	// Malformed JSON → empty slice (not nil), so callers can distinguish "no conflicts"
	// from "check not run" (nil comes from ConflictChecker.Check when disabled).
	got := authoring.ParseConflictResponse("not valid json")
	if got == nil {
		t.Error("expected non-nil empty slice on parse error")
	}
	if len(got) != 0 {
		t.Errorf("expected 0 items on parse error, got %d", len(got))
	}
}

func TestParseConflictResponse_EmptyString_ReturnsEmpty(t *testing.T) {
	got := authoring.ParseConflictResponse("")
	if got == nil {
		t.Error("expected non-nil slice")
	}
}

// ── CleanYAMLFences ───────────────────────────────────────────────────────────

func TestCleanYAMLFences_YAMLFence(t *testing.T) {
	in := "```yaml\nid: test\n```"
	got := authoring.CleanYAMLFences(in)
	if got != "id: test" {
		t.Errorf("got %q, want %q", got, "id: test")
	}
}

func TestCleanYAMLFences_PlainFence(t *testing.T) {
	in := "```\nid: test\n```"
	got := authoring.CleanYAMLFences(in)
	if got != "id: test" {
		t.Errorf("got %q, want %q", got, "id: test")
	}
}

func TestCleanYAMLFences_NoFence(t *testing.T) {
	in := "id: test\nname: Test Policy"
	got := authoring.CleanYAMLFences(in)
	if got != in {
		t.Errorf("no-fence: got %q, want %q", got, in)
	}
}

func TestCleanYAMLFences_LeadingTrailingWhitespace(t *testing.T) {
	in := "\n  \n```yaml\nid: test\n```\n  "
	got := authoring.CleanYAMLFences(in)
	if got != "id: test" {
		t.Errorf("whitespace trim: got %q", got)
	}
}

func TestCleanYAMLFences_MultiLine(t *testing.T) {
	in := "```yaml\nid: test\nname: My Policy\nrules: []\n```"
	got := authoring.CleanYAMLFences(in)
	if strings.Contains(got, "```") {
		t.Errorf("fences not stripped: %q", got)
	}
	if !strings.Contains(got, "id: test") {
		t.Errorf("content missing: %q", got)
	}
}

// ── BuildGeneratorUserMessage ─────────────────────────────────────────────────

func TestBuildGeneratorUserMessage_DescriptionIncluded(t *testing.T) {
	req := authoring.GenerateRequest{Description: "Block all email sending for bots"}
	msg := authoring.BuildGeneratorUserMessage(req)
	if !strings.Contains(msg, "Block all email sending for bots") {
		t.Errorf("message missing description: %s", msg)
	}
}

func TestBuildGeneratorUserMessage_WithRole(t *testing.T) {
	req := authoring.GenerateRequest{
		Description: "Restrict calendar access",
		Role:        "researcher",
	}
	msg := authoring.BuildGeneratorUserMessage(req)
	if !strings.Contains(msg, "researcher") {
		t.Errorf("message missing role name: %s", msg)
	}
}

func TestBuildGeneratorUserMessage_WithExistingIDs(t *testing.T) {
	req := authoring.GenerateRequest{
		Description: "New policy",
		ExistingIDs: []string{"p-block-email", "p-allow-calendar"},
	}
	msg := authoring.BuildGeneratorUserMessage(req)
	if !strings.Contains(msg, "p-block-email") {
		t.Errorf("message missing existing ID: %s", msg)
	}
	if !strings.Contains(msg, "p-allow-calendar") {
		t.Errorf("message missing existing ID: %s", msg)
	}
}

func TestBuildGeneratorUserMessage_NoRoleSection(t *testing.T) {
	req := authoring.GenerateRequest{Description: "Simple policy"}
	msg := authoring.BuildGeneratorUserMessage(req)
	if strings.Contains(msg, "Target role") {
		t.Errorf("message should omit role section when empty: %s", msg)
	}
}

func TestBuildGeneratorUserMessage_NoExistingIDsSection(t *testing.T) {
	req := authoring.GenerateRequest{Description: "Simple policy"}
	msg := authoring.BuildGeneratorUserMessage(req)
	if strings.Contains(msg, "Existing policy IDs") {
		t.Errorf("message should omit existing IDs section when empty: %s", msg)
	}
}

// ── BuildConflictUserMessage ──────────────────────────────────────────────────

func TestBuildConflictUserMessage_ContainsIncoming(t *testing.T) {
	incoming := &store.PolicyRecord{
		Slug:      "new-policy",
		RulesYAML: "id: new-policy\nrules: []",
	}
	msg := authoring.BuildConflictUserMessage(incoming, nil)
	if !strings.Contains(msg, "id: new-policy") {
		t.Errorf("message missing incoming policy YAML: %s", msg)
	}
}

func TestBuildConflictUserMessage_ContainsExisting(t *testing.T) {
	incoming := &store.PolicyRecord{
		Slug:      "new",
		RulesYAML: "id: new\nrules: []",
	}
	existing := []*store.PolicyRecord{
		{Slug: "old-one", RulesYAML: "id: old-one\nrules: []"},
		{Slug: "old-two", RulesYAML: "id: old-two\nrules: []"},
	}
	msg := authoring.BuildConflictUserMessage(incoming, existing)
	if !strings.Contains(msg, "id: old-one") {
		t.Errorf("message missing first existing policy: %s", msg)
	}
	if !strings.Contains(msg, "id: old-two") {
		t.Errorf("message missing second existing policy: %s", msg)
	}
}
