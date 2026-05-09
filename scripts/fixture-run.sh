#!/bin/bash
# Reset a fixture project, import it into the running API, and start the executor.
# Usage: bash scripts/fixture-run.sh [fixture-name]
# Default: calculator
#
# Requires: API server running on :7072 (start with `bun run api:bg`)

set -e

FIXTURE="${1:-calculator}"
FIXTURE_DIR="$(cd "$(dirname "$0")/.." && pwd)/fixtures/$FIXTURE"
API_URL="http://localhost:7072"

if ! curl -sf "$API_URL/health" &>/dev/null; then
  echo "Error: API server not running on $API_URL"
  echo "  Start it with: bun run api:bg"
  exit 1
fi

if [ ! -d "$FIXTURE_DIR" ]; then
  echo "Error: Fixture not found: $FIXTURE_DIR"
  exit 1
fi

echo "=== Resetting fixture: $FIXTURE ==="
bash "$(dirname "$0")/fixture-reset.sh" "$FIXTURE"

echo ""
echo "=== Clearing database ==="
# Delete any existing actions from this project
EXISTING=$(curl -sf "$API_URL/actions" 2>/dev/null | jq -r '.[].id' 2>/dev/null || true)
if [ -n "$EXISTING" ]; then
  echo "$EXISTING" | while read -r id; do
    curl -sf -X DELETE "$API_URL/actions/$id" &>/dev/null
  done
  echo "  Cleared existing actions"
else
  echo "  No existing actions"
fi

echo ""
echo "=== Importing config ==="
RESULT=$(curl -sf -X POST "$API_URL/import" \
  -H "Content-Type: application/json" \
  -d "{\"dir\": \"$FIXTURE_DIR\"}")

ACTIONS=$(echo "$RESULT" | jq -r '.actions | length')
EDGES=$(echo "$RESULT" | jq -r '.edges')
echo "  Created $ACTIONS actions, $EDGES edges"

echo ""
echo "=== Starting executor ==="
curl -sf -X POST "$API_URL/executor/resume" | jq -r '"  Executor: " + .state'

echo ""
echo "=== Status ==="
curl -sf "$API_URL/executor/status" | jq .

echo ""
echo "Open http://localhost:8095 to watch the build."
