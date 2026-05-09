#!/bin/bash
# Reset a fixture project's git repo to its initial state.
# Usage: bash scripts/fixture-reset.sh [fixture-name]
# Default: calculator

set -e

FIXTURE="${1:-calculator}"
FIXTURE_DIR="$(cd "$(dirname "$0")/.." && pwd)/fixtures/$FIXTURE"

if [ ! -d "$FIXTURE_DIR/.git" ]; then
  echo "Error: $FIXTURE_DIR is not a git repo"
  exit 1
fi

cd "$FIXTURE_DIR"

echo "Resetting fixture: $FIXTURE"
echo "  Directory: $FIXTURE_DIR"

git checkout -- .
git clean -fd -e .orca/ 2>/dev/null

echo "  Git reset to initial state"

if command -v bun &>/dev/null && [ -f "package.json" ]; then
  echo "  Test status:"
  bun test 2>&1 | tail -3
fi

echo "Done."
