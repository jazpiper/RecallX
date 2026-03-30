#!/bin/sh

set -eu

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

CURRENT_BRANCH="$(git branch --show-current)"

if [ "$CURRENT_BRANCH" = "main" ]; then
  echo "[return-to-main] already on main"
  exit 0
fi

STATUS="$(git status --porcelain)"
TRACKED_STATUS="$(printf '%s\n' "$STATUS" | grep -v '^?? ' || true)"

if [ -n "$TRACKED_STATUS" ]; then
  echo "[return-to-main] tracked changes are still present on $CURRENT_BRANCH"
  echo "Commit, stash, or clean the branch before switching the primary checkout back to main."
  exit 1
fi

if printf '%s\n' "$STATUS" | grep '^?? ' >/dev/null 2>&1; then
  echo "[return-to-main] untracked files are present; git switch may still fail if they conflict on main"
fi

git switch main
git pull --ff-only origin main

echo "[return-to-main] primary checkout is now on main"
