#!/usr/bin/env bash
# test-phase4-addenda.sh — Smoke test for Phase 4 addenda:
#   - POST /api/policies/validate with check_semantic param
#   - POST /api/policies/generate (LLM-backed policy generation)
#
# Prerequisites:
#   - Server running:  go run ./cmd/server
#   - jq installed:    brew install jq
#
# Usage:
#   ./scripts/test-phase4-addenda.sh [BASE_URL]
#
# BASE_URL defaults to http://localhost:8080
#
# The script auto-detects whether the LLM authoring feature is enabled and
# adjusts expectations accordingly — no flags needed.

set -uo pipefail   # -e intentionally omitted: we collect failures, not abort on first

BASE="${1:-http://localhost:8080}"

# ── Colour helpers ──────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

pass() { echo -e "  ${GREEN}✓${RESET} $*"; }
fail() { echo -e "  ${RED}✗${RESET} $*"; FAILURES=$((FAILURES+1)); }
skip() { echo -e "  ${YELLOW}~${RESET} $*"; }
section() { echo -e "\n${BOLD}${CYAN}── $* ──${RESET}"; }

FAILURES=0

jqf() { echo "$1" | jq -r "$2" 2>/dev/null || true; }

# ── Dependency check ────────────────────────────────────────────────────────
if ! command -v jq &>/dev/null; then
  echo -e "${RED}Error: jq is required. Install with: brew install jq${RESET}"
  exit 1
fi

# ── Wait for server ─────────────────────────────────────────────────────────
section "Server health"
for i in $(seq 1 10); do
  if curl -sf "$BASE/health" &>/dev/null; then break; fi
  if [[ $i -eq 10 ]]; then
    echo -e "${RED}Server not reachable at $BASE — start with: go run ./cmd/server${RESET}"
    exit 1
  fi
  echo "  Waiting for server... ($i/10)"
  sleep 1
done

HEALTH=$(curl -sf "$BASE/health")
[[ "$(jqf "$HEALTH" .status)" == "ok" ]] \
  && pass "GET /health → ok" \
  || fail "GET /health unexpected: $HEALTH"

# ── Auth setup ───────────────────────────────────────────────────────────────
section "Auth setup"

EMAIL="addenda-$$@example.com"
PASSWORD="AddendaPass!"

REG=$(curl -sf -X POST "$BASE/api/auth/register" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}")
TOKEN=$(jqf "$REG" .access_token)

[[ -n "$TOKEN" && "$TOKEN" != "null" ]] \
  && pass "Registered user and got access_token" \
  || { fail "Registration failed: $REG"; exit 1; }

# Helper: authenticated curl
acurl() {
  curl -sf -H "Authorization: Bearer $TOKEN" "$@"
}
acurl_code() {
  curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $TOKEN" "$@"
}

# ── Probe LLM state ──────────────────────────────────────────────────────────
# Probe once here; use LLM_ENABLED throughout to gate expectations.
PROBE_STATUS=$(acurl_code -X POST "$BASE/api/policies/generate" \
  -H "Content-Type: application/json" \
  -d '{"description":"probe"}')

LLM_ENABLED=true
[[ "$PROBE_STATUS" == "503" ]] && LLM_ENABLED=false

if $LLM_ENABLED; then
  echo -e "  ${CYAN}LLM authoring: enabled${RESET}"
else
  echo -e "  ${YELLOW}LLM authoring: disabled (503 from /generate)${RESET}"
fi

# ── Create role and a base policy ────────────────────────────────────────────
section "Setup: role + policy"

ROLE=$(acurl -X POST "$BASE/api/roles" \
  -H "Content-Type: application/json" \
  -d '{"name":"analyst","description":"Test role"}')
ROLE_ID=$(jqf "$ROLE" .id)

[[ -n "$ROLE_ID" && "$ROLE_ID" != "null" ]] \
  && pass "Created role analyst (id=$ROLE_ID)" \
  || fail "create role: $ROLE"

EXISTING_POLICY=$(acurl -X POST "$BASE/api/policies" \
  -H "Content-Type: application/json" \
  -d '{"yaml":"id: existing-allow-github\nname: Allow GitHub reads\nrules:\n  - service: github\n    actions: [list_issues, list_repos]\n    allow: true\n"}')
EXISTING_POLICY_ID=$(jqf "$EXISTING_POLICY" .id)

[[ -n "$EXISTING_POLICY_ID" && "$EXISTING_POLICY_ID" != "null" ]] \
  && pass "Created base policy (id=$EXISTING_POLICY_ID)" \
  || fail "create base policy: $EXISTING_POLICY"

VALID_YAML='id: test-block-gmail
name: Block Gmail Send
rules:
  - service: google.gmail
    actions: [send_message]
    allow: false
    reason: Test block
'

INVALID_YAML='not: valid: yaml: ::::'

# ── POST /api/policies/validate — baseline ───────────────────────────────────
section "Validate: basic (no check_semantic)"

RESP=$(acurl -X POST "$BASE/api/policies/validate" \
  -H "Content-Type: application/json" \
  -d "{\"yaml\":$(echo "$VALID_YAML" | jq -Rs .)}")

[[ "$(jqf "$RESP" .valid)" == "true" ]] \
  && pass "Valid YAML → valid=true" \
  || fail "expected valid=true, got: $RESP"

SC=$(echo "$RESP" | jq 'has("semantic_conflicts")' 2>/dev/null || echo "false")
[[ "$SC" == "true" ]] \
  && pass "semantic_conflicts key is present in response" \
  || fail "semantic_conflicts key missing from response"

# Without check_semantic, the field must be null regardless of LLM state.
SC_VAL=$(echo "$RESP" | jq '.semantic_conflicts' 2>/dev/null || echo "MISSING")
[[ "$SC_VAL" == "null" ]] \
  && pass "semantic_conflicts=null when check_semantic not sent" \
  || fail "expected semantic_conflicts=null (check_semantic not sent), got: $SC_VAL"

RESP_INV=$(acurl -X POST "$BASE/api/policies/validate" \
  -H "Content-Type: application/json" \
  -d "{\"yaml\":$(echo "$INVALID_YAML" | jq -Rs .)}")

[[ "$(jqf "$RESP_INV" .valid)" == "false" ]] \
  && pass "Invalid YAML → valid=false" \
  || fail "expected valid=false for invalid YAML, got: $RESP_INV"

SC_INV=$(echo "$RESP_INV" | jq '.semantic_conflicts' 2>/dev/null || echo "MISSING")
[[ "$SC_INV" == "null" ]] \
  && pass "Invalid YAML → semantic_conflicts=null regardless of flag" \
  || fail "expected semantic_conflicts=null for invalid YAML, got: $SC_INV"

# ── POST /api/policies/validate — check_semantic=true ────────────────────────
section "Validate: check_semantic=true"

RESP_SEM=$(acurl -X POST "$BASE/api/policies/validate" \
  -H "Content-Type: application/json" \
  -d "{\"yaml\":$(echo "$VALID_YAML" | jq -Rs .),\"check_semantic\":true}")

[[ "$(jqf "$RESP_SEM" .valid)" == "true" ]] \
  && pass "check_semantic=true → still valid=true" \
  || fail "expected valid=true, got: $RESP_SEM"

SC_SEM=$(echo "$RESP_SEM" | jq '.semantic_conflicts' 2>/dev/null || echo "MISSING")

if $LLM_ENABLED; then
  # LLM enabled: semantic_conflicts must be a JSON array ([] or [...]).
  IS_ARR=$(echo "$RESP_SEM" | jq '.semantic_conflicts | type == "array"' 2>/dev/null || echo "false")
  [[ "$IS_ARR" == "true" ]] \
    && pass "check_semantic=true, LLM enabled → semantic_conflicts is array" \
    || fail "expected semantic_conflicts array, got: $SC_SEM"
  NUM=$(echo "$RESP_SEM" | jq '.semantic_conflicts | length' 2>/dev/null || echo "?")
  pass "  $NUM semantic conflict(s) reported"
else
  # LLM disabled: semantic_conflicts must be null.
  [[ "$SC_SEM" == "null" ]] \
    && pass "check_semantic=true, LLM disabled → semantic_conflicts=null" \
    || fail "expected semantic_conflicts=null when LLM disabled, got: $SC_SEM"
fi

# ── POST /api/policies/validate — auth enforcement ───────────────────────────
section "Validate: auth enforcement"

STATUS_UNAUTH=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/policies/validate" \
  -H "Content-Type: application/json" \
  -d "{\"yaml\":$(echo "$VALID_YAML" | jq -Rs .)}")
[[ "$STATUS_UNAUTH" == "401" ]] \
  && pass "POST /api/policies/validate without token → 401" \
  || fail "expected 401, got $STATUS_UNAUTH"

# ── POST /api/policies/generate ──────────────────────────────────────────────
section "Generate: POST /api/policies/generate"

if $LLM_ENABLED; then
  # Empty description → 400
  STATUS_NODESC=$(acurl_code -X POST "$BASE/api/policies/generate" \
    -H "Content-Type: application/json" \
    -d '{"description":""}')
  [[ "$STATUS_NODESC" == "400" ]] \
    && pass "Empty description → 400" \
    || fail "expected 400 for empty description, got $STATUS_NODESC"

  # Valid description → 200 with yaml
  GEN_RESP=$(acurl -X POST "$BASE/api/policies/generate" \
    -H "Content-Type: application/json" \
    -d '{"description":"Block all email sending for automation agents","context":{"role":"analyst"}}')
  GEN_YAML=$(jqf "$GEN_RESP" .yaml)

  [[ -n "$GEN_YAML" && "$GEN_YAML" != "null" ]] \
    && pass "POST /api/policies/generate → yaml returned (${#GEN_YAML} chars)" \
    || fail "generate: expected yaml field, got: $GEN_RESP"

  # Generated YAML must pass validation
  if [[ -n "$GEN_YAML" && "$GEN_YAML" != "null" ]]; then
    VALIDATE_GEN=$(acurl -X POST "$BASE/api/policies/validate" \
      -H "Content-Type: application/json" \
      -d "{\"yaml\":$(echo "$GEN_YAML" | jq -Rs .)}")
    [[ "$(jqf "$VALIDATE_GEN" .valid)" == "true" ]] \
      && pass "Generated YAML passes validation" \
      || fail "Generated YAML invalid: $(jqf "$VALIDATE_GEN" '.errors[0]')"
  fi
else
  # LLM disabled → 503 with LLM_DISABLED code
  STATUS_503=$(acurl_code -X POST "$BASE/api/policies/generate" \
    -H "Content-Type: application/json" \
    -d '{"description":"Block all email sending"}')
  [[ "$STATUS_503" == "503" ]] \
    && pass "LLM disabled → 503" \
    || fail "expected 503, got $STATUS_503"

  GEN_BODY=$(curl -s -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -X POST "$BASE/api/policies/generate" \
    -d '{"description":"Block all email sending"}' 2>/dev/null || echo '{}')
  GEN_CODE=$(jqf "$GEN_BODY" .code)
  [[ "$GEN_CODE" == "LLM_DISABLED" ]] \
    && pass "  error code=LLM_DISABLED" \
    || fail "  expected code=LLM_DISABLED, got: $GEN_CODE"
fi

# Auth always required regardless of LLM state
STATUS_AUTH=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/policies/generate" \
  -H "Content-Type: application/json" \
  -d '{"description":"Something"}')
[[ "$STATUS_AUTH" == "401" ]] \
  && pass "POST /api/policies/generate without token → 401" \
  || fail "expected 401, got $STATUS_AUTH"

# ── Validate: structural conflict detection ───────────────────────────────────
section "Validate: structural conflict detection"

# Create an opposing allow policy to trigger a structural conflict.
CONFLICT_YAML='id: conflicting-allow-gmail
name: Allow Gmail Send
rules:
  - service: google.gmail
    actions: [send_message]
    allow: true
'

# Ensure the block policy exists first (may have been created above).
acurl -X POST "$BASE/api/policies" \
  -H "Content-Type: application/json" \
  -d "{\"yaml\":$(echo "$VALID_YAML" | jq -Rs .)}" > /dev/null 2>&1 || true

CONFLICT_RESP=$(acurl -X POST "$BASE/api/policies/validate" \
  -H "Content-Type: application/json" \
  -d "{\"yaml\":$(echo "$CONFLICT_YAML" | jq -Rs .)}")

HAS_CONFLICTS_KEY=$(echo "$CONFLICT_RESP" | jq 'has("conflicts")' 2>/dev/null || echo "false")
[[ "$HAS_CONFLICTS_KEY" == "true" ]] \
  && pass "conflicts key always present in validate response" \
  || fail "conflicts key missing from validate response"

NUM_CONFLICTS=$(echo "$CONFLICT_RESP" | jq '.conflicts | length' 2>/dev/null || echo "0")
echo -e "  ${YELLOW}note: ${NUM_CONFLICTS} structural conflict(s) detected for opposing allow/block${RESET}"

# ── Summary ──────────────────────────────────────────────────────────────────
echo ""
if [[ $FAILURES -eq 0 ]]; then
  echo -e "${BOLD}${GREEN}All tests passed.${RESET}"
else
  echo -e "${BOLD}${RED}$FAILURES test(s) failed.${RESET}"
  exit 1
fi
