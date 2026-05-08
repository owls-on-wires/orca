#!/bin/bash
# Setup the QA test environment for orca integration testing.
#
# Creates a working copy of the fixture project at /tmp/orca-qa-env/project
# with git history, and a clean data dir for the serve process.
#
# The fixture has 3 tasks:
#   task1 — add function (correct, passes immediately)
#   task2 — multiply function (bug, mock_develop fixes it)
#   task3 — divide function (bug, mock_develop fixes it)
#
# Usage: bash fixtures/setup-qa-env.sh

set -e

DEST=/tmp/orca-qa-env
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
FIXTURE_DIR="$SCRIPT_DIR/project"

# Kill any leftover test server
if [ -f /tmp/orca-qa-server.pid ]; then
  kill "$(cat /tmp/orca-qa-server.pid)" 2>/dev/null || true
  rm -f /tmp/orca-qa-server.pid
fi

# Clean slate
rm -rf "$DEST"
mkdir -p "$DEST/data"

# Copy fixture files
cp -r "$FIXTURE_DIR" "$DEST/project"

# Initialize git repo
cd "$DEST/project"
git init -q
git config user.email "qa@orca.test"
git config user.name "Orca QA"

# Initial commit — all files including the bugs
git add -A
git commit -q -m "initial project"

# Simulate task1 already being completed:
# task1.ts is already correct, so just record the commit
git commit -q --allow-empty -m "qa-fixture: task1 complete"

# Tag the baseline state for easy reset
git tag qa-baseline

echo "QA environment ready at $DEST"
echo "  Project: $DEST/project"
echo "  Data:    $DEST/data"
echo "  Git:     $(git log --oneline | wc -l) commits, tagged qa-baseline"
