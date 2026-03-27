#!/usr/bin/env bash
set -euo pipefail

# Run OWASP ZAP scan against Clawvisor staging
#
# Usage:
#   ./security/zap/run-scan.sh
#
# Environment variables:
#   ZAP_AUTH_EMAIL    - Staging account email (required)
#   ZAP_AUTH_PASSWORD - Staging account password (required)
#   ZAP_MODE         - "full" (default) or "baseline" (passive-only, faster)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
ZAP_CMD="/Applications/ZAP.app/Contents/Java/zap.sh"
REPORT_DIR="$SCRIPT_DIR/reports"

if [[ ! -x "$ZAP_CMD" ]]; then
  echo "Error: ZAP not found at $ZAP_CMD"
  echo "Install with: brew install --cask zap"
  exit 1
fi

if [[ -z "${ZAP_AUTH_EMAIL:-}" || -z "${ZAP_AUTH_PASSWORD:-}" ]]; then
  echo "Error: Set ZAP_AUTH_EMAIL and ZAP_AUTH_PASSWORD environment variables"
  echo ""
  echo "  export ZAP_AUTH_EMAIL='your-email@example.com'"
  echo "  export ZAP_AUTH_PASSWORD='your-password'"
  exit 1
fi

mkdir -p "$REPORT_DIR"

MODE="${ZAP_MODE:-full}"

echo "=== OWASP ZAP Scan ==="
echo "Target: https://app.staging.clawvisor.com"
echo "Mode:   $MODE"
echo "User:   $ZAP_AUTH_EMAIL"
echo ""

if [[ "$MODE" == "baseline" ]]; then
  echo "Running baseline (passive-only) scan..."
  "$ZAP_CMD" -cmd \
    -autorun "$SCRIPT_DIR/automation-baseline.yaml" \
    2>&1 | tee "$REPORT_DIR/scan.log"
else
  echo "Running full scan (spider + active scan)..."
  "$ZAP_CMD" -cmd \
    -autorun "$SCRIPT_DIR/automation.yaml" \
    2>&1 | tee "$REPORT_DIR/scan.log"
fi

echo ""
echo "=== Scan complete ==="
echo "Reports: $REPORT_DIR/"
ls -la "$REPORT_DIR"/*.html "$REPORT_DIR"/*.json 2>/dev/null || echo "(no reports generated)"
