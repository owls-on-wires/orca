#!/bin/bash
# Prepare a fixture for execution by copying it to tmp/.
# The fixtures/ directory is the immutable source of truth.
# Usage: bash scripts/fixture-reset.sh [fixture-name]
# Default: calculator
#
# Outputs the working directory path to stdout (last line).

set -e

FIXTURE="${1:-calculator}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MAIN_REPO="$(cd "$SCRIPT_DIR/.." && pwd)"
SOURCE_DIR="$MAIN_REPO/fixtures/$FIXTURE"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
WORK_DIR="$MAIN_REPO/tmp/fixtures/$FIXTURE-$TIMESTAMP"

if [ ! -d "$SOURCE_DIR" ]; then
  echo "Error: Fixture not found: $SOURCE_DIR" >&2
  exit 1
fi

echo "Resetting fixture: $FIXTURE" >&2
echo "  Source: $SOURCE_DIR" >&2
echo "  Working copy: $WORK_DIR" >&2

# Copy source to working directory
mkdir -p "$(dirname "$WORK_DIR")"
cp -r "$SOURCE_DIR" "$WORK_DIR"

cd "$WORK_DIR"

# Init fresh git repo
git init -q
git add -A
git commit -q -m "initial"

echo "  Git initialized" >&2

# Install deps if needed
if command -v bun &>/dev/null && [ -f "package.json" ]; then
  bun install --silent 2>/dev/null || true
  echo "  Test status:" >&2
  bun test 2>&1 | tail -3 >&2
fi

echo "Done." >&2

# Output the working directory path (for fixture-run.sh to capture)
echo "$WORK_DIR"
