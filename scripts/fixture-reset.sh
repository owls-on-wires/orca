#!/bin/bash
# Reset a fixture project to its initial state.
# Creates a fresh git repo from the committed files each time.
# Usage: bash scripts/fixture-reset.sh [fixture-name]
# Default: calculator

set -e

FIXTURE="${1:-calculator}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MAIN_REPO="$(cd "$SCRIPT_DIR/.." && pwd)"
FIXTURE_DIR="$MAIN_REPO/fixtures/$FIXTURE"

if [ ! -d "$FIXTURE_DIR" ]; then
  echo "Error: Fixture not found: $FIXTURE_DIR"
  exit 1
fi

echo "Resetting fixture: $FIXTURE"
echo "  Directory: $FIXTURE_DIR"

cd "$FIXTURE_DIR"

# Remove existing git repo
rm -rf .git

# Nuke everything except node_modules and .orca
# (these are gitignored and persist across resets)
for item in *; do
  [ "$item" = "node_modules" ] && continue
  rm -rf "$item"
done
# Also remove hidden files/dirs (except . .. .orca node_modules)
for item in .[!.]*; do
  [ "$item" = ".orca" ] && continue
  rm -rf "$item"
done

# Restore original scaffold files from main repo
cd "$MAIN_REPO"
git checkout HEAD -- "fixtures/$FIXTURE/"
cd "$FIXTURE_DIR"

# Verify cleanup
remaining=$(find . -not -path './.orca/*' -not -path './node_modules/*' -not -name '.' -type f | head -20)
if [ -n "$remaining" ]; then
  echo "  Restored files:"
  echo "$remaining" | sed 's/^/    /'
fi

# Init fresh git repo
git init -q
git add -A
git commit -q -m "initial"

echo "  Git initialized from scaffold"

# Install deps if needed
if command -v bun &>/dev/null && [ -f "package.json" ]; then
  bun install --silent 2>/dev/null || true
  echo "  Test status:"
  bun test 2>&1 | tail -3
fi

echo "Done."
