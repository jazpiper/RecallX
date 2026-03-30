#!/bin/sh

set -eu

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

. "$ROOT/.codex/hooks/lib/recallx-common.sh"

TASK_NAME="${1:-}"
BASE_BRANCH="main"

if [ -z "$TASK_NAME" ]; then
  echo "Usage: ./.codex/hooks/start-task.sh <task-name>" >&2
  exit 1
fi

ensure_state_dir

STATUS="$(git status --porcelain)"
TRACKED_STATUS="$(printf '%s\n' "$STATUS" | grep -v '^?? ' || true)"

if [ -n "$TRACKED_STATUS" ]; then
  echo "[start-task] tracked changes are present. Commit, stash, or clean them before starting a new task." >&2
  exit 1
fi

CURRENT_BRANCH="$(git branch --show-current)"
if [ "$CURRENT_BRANCH" != "$BASE_BRANCH" ]; then
  echo "[start-task] switching primary checkout back to $BASE_BRANCH first"
  git switch "$BASE_BRANCH"
fi

git pull --ff-only origin "$BASE_BRANCH"

SLUG="$(printf '%s' "$TASK_NAME" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9/_-]/-/g; s#//*#/#g; s/--*/-/g; s#^[-/]*##; s#[-/]*$##')"
BRANCH_NAME="${SLUG#codex/}"
BRANCH_NAME="codex/$BRANCH_NAME"

if git show-ref --verify --quiet "refs/heads/$BRANCH_NAME"; then
  echo "[start-task] local branch already exists: $BRANCH_NAME" >&2
  exit 1
fi

if git ls-remote --exit-code --heads origin "$BRANCH_NAME" >/dev/null 2>&1; then
  echo "[start-task] remote branch already exists: origin/$BRANCH_NAME" >&2
  exit 1
fi

BASELINE_FILE="$(baseline_untracked_file)"
collect_untracked_paths | sed '/^$/d' | sort -u > "$BASELINE_FILE"

STATE_FILE="$(task_state_file)"
cat > "$STATE_FILE" <<EOF
BASE_BRANCH=$BASE_BRANCH
BRANCH_NAME=$BRANCH_NAME
TASK_SLUG=$SLUG
STARTED_AT=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
EOF

git switch -c "$BRANCH_NAME"

echo "[start-task] started task branch: $BRANCH_NAME"
echo "[start-task] baseline untracked paths recorded in $BASELINE_FILE"
