#!/bin/bash
# compare-checks.sh - Run ao-lens and optionally AO panel, compare outputs
#
# Usage:
#   ./scripts/compare-checks.sh <lua-file> [--with-panel]
#
# Examples:
#   ./scripts/compare-checks.sh ao/pid.lua              # ao-lens only (fast)
#   ./scripts/compare-checks.sh ao/pid.lua --with-panel # + AO panel (slow, ~40s)

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AO_LENS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LUA_FILE="$1"
WITH_PANEL="${2:-}"

if [ -z "$LUA_FILE" ]; then
  echo "Usage: $0 <lua-file> [--with-panel]"
  exit 1
fi

if [ ! -f "$LUA_FILE" ]; then
  echo "Error: File not found: $LUA_FILE"
  exit 1
fi

echo "=== ao-lens Check ==="
echo ""

# Run ao-lens
AO_LENS_OUTPUT=$(node "$AO_LENS_DIR/dist/cli.js" audit "$LUA_FILE" 2>&1)
echo "$AO_LENS_OUTPUT" | jq -r '
  .files[0].findings[] |
  "[\(.severity | ascii_upcase)] \(.code): \(.message) (line \(.line // "?"))"
' 2>/dev/null || echo "$AO_LENS_OUTPUT"

# Summary
echo ""
echo "Summary:"
echo "$AO_LENS_OUTPUT" | jq -r '
  "  Critical: \(.summary.critical), High: \(.summary.high), Medium: \(.summary.medium), Low: \(.summary.low)"
' 2>/dev/null

PASS=$(echo "$AO_LENS_OUTPUT" | jq -r '.pass' 2>/dev/null)
if [ "$PASS" = "true" ]; then
  echo "  Result: PASS"
else
  echo "  Result: FAIL"
fi

if [ "$WITH_PANEL" = "--with-panel" ]; then
  echo ""
  echo "=== AO Panel Check (calling API...) ==="
  echo ""

  # Read the file content
  FILE_CONTENT=$(cat "$LUA_FILE")

  # Call the AO panel via orchestrator API (if available)
  # This requires the orchestrator to be running
  PANEL_RESULT=$(curl -s -X POST "http://orchestrator:8080/api/ao-panel-review" \
    -H "Content-Type: application/json" \
    -d "{\"files\": [{\"path\": \"$LUA_FILE\", \"content\": $(echo "$FILE_CONTENT" | jq -Rs .)}]}" \
    2>/dev/null || echo '{"error": "Orchestrator not available"}')

  if echo "$PANEL_RESULT" | jq -e '.error' >/dev/null 2>&1; then
    echo "Note: AO Panel API not available. Use Redis to check historical results:"
    echo ""
    echo "  python3 << 'EOF'"
    echo "  import redis, os, json"
    echo "  from dotenv import load_dotenv"
    echo "  load_dotenv('/claude-workspace/.env')"
    echo "  r = redis.Redis(host='redis', port=6379, password=os.environ['REDIS_PASSWORD'], decode_responses=True)"
    echo "  # Get most recent ao_panel_completed events"
    echo "  for key in r.scan_iter('dev_team:saga_events:*'):"
    echo "      events = r.xrange(key, count=50)"
    echo "      for eid, data in events:"
    echo "          if 'ao_panel_completed' in data.get('event_type', ''):"
    echo "              details = json.loads(data.get('details', '{}'))"
    echo "              print(f\"Approved: {details.get('approved')}\")"
    echo "              for issue in details.get('issues', []):"
    echo "                  print(f\"  [{issue.get('severity')}] {issue.get('expert')}: {issue.get('description')}\")"
    echo "  EOF"
  else
    echo "$PANEL_RESULT" | jq -r '
      .issues[]? |
      "[\(.severity)] \(.expert): \(.description)"
    ' 2>/dev/null || echo "$PANEL_RESULT"
  fi
fi

echo ""
echo "=== Known AO Panel Checks (not in ao-lens) ==="
echo ""
echo "These are patterns AO Panel catches that ao-lens should also check:"
echo "  - Duplicate JSON decode (matcher + handler) - inefficient"
echo "  - Inconsistent error response Action tags"
echo "  - Council Requirement #1 (rationale field) not enforced"
echo "  - Matcher duplicates handler auth logic (maintenance risk)"
echo ""
echo "Run with --with-panel to get live AO Panel comparison."
