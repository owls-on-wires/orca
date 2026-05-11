#!/bin/bash
# Copy a fixture to tmp/, import it into the running API, and start the executor.
# Usage: bash scripts/fixture-run.sh [fixture-name]
# Default: calculator
#
# Requires: API server running on :7072

set -e

FIXTURE="${1:-calculator}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MAIN_REPO="$(cd "$SCRIPT_DIR/.." && pwd)"
API_URL="http://localhost:7072"

if ! curl -sf "$API_URL/health" &>/dev/null; then
  echo "Error: API server not running on $API_URL"
  echo "  Start it with: bun run packages/server/src/v2/server.ts --port 7072 --db ~/.orca/orca.db"
  exit 1
fi

if [ ! -d "$MAIN_REPO/fixtures/$FIXTURE" ]; then
  echo "Error: Fixture not found: $MAIN_REPO/fixtures/$FIXTURE"
  exit 1
fi

echo "=== Preparing fixture: $FIXTURE ==="
# fixture-reset.sh outputs the working directory path on the last line
WORK_DIR=$(bash "$SCRIPT_DIR/fixture-reset.sh" "$FIXTURE")
echo "  Working directory: $WORK_DIR"

echo ""
echo "=== Clearing database ==="
# Delete any existing actions
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
  -d "{\"dir\": \"$WORK_DIR\"}")

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
echo "Working directory: $WORK_DIR"
echo "Open http://localhost:8095 to watch the build."
