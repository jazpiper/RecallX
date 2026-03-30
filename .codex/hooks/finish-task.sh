#!/bin/sh

set -eu

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

. "$ROOT/.codex/hooks/lib/recallx-common.sh"

ensure_state_dir

STATE_FILE="$(task_state_file)"
if [ ! -f "$STATE_FILE" ]; then
  echo "[finish-task] no current task state found. Run ./.codex/hooks/start-task.sh first or commit/publish manually." >&2
  exit 1
fi

# shellcheck disable=SC1090
. "$STATE_FILE"

COMMIT_MESSAGE=""
PR_TITLE=""
TASK_SUMMARY=""
RISKS_TEXT=""
NO_MERGE=0
DRAFT_MODE=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --message)
      COMMIT_MESSAGE="${2:-}"
      shift 2
      ;;
    --title)
      PR_TITLE="${2:-}"
      shift 2
      ;;
    --task)
      TASK_SUMMARY="${2:-}"
      shift 2
      ;;
    --risks)
      RISKS_TEXT="${2:-}"
      shift 2
      ;;
    --no-merge)
      NO_MERGE=1
      shift
      ;;
    --draft)
      DRAFT_MODE=1
      shift
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

PATHS="$(collect_task_paths)"
if [ -z "$PATHS" ]; then
  echo "[finish-task] no task-scoped changes detected."
  exit 0
fi

compute_validation_flags <<EOF
$PATHS
EOF
run_validation_plan

stage_paths <<EOF
$PATHS
EOF

if [ -z "$COMMIT_MESSAGE" ]; then
  COMMIT_MESSAGE="$(derive_default_commit_subject)"
fi

if git diff --cached --quiet; then
  echo "[finish-task] nothing staged after filtering baseline untracked paths." >&2
  exit 1
fi

git commit -m "$COMMIT_MESSAGE"

if [ -z "$PR_TITLE" ]; then
  PR_TITLE="[codex] $COMMIT_MESSAGE"
fi

if [ -z "$TASK_SUMMARY" ]; then
  TASK_SUMMARY="Completed task branch $BRANCH_NAME."
fi

BODY_FILE="$(mktemp)"
trap 'rm -f "$BODY_FILE"' EXIT INT TERM
./.codex/hooks/finish-report.sh \
  --task "$TASK_SUMMARY" \
  --validated "npm run check,npm test,find .codex/hooks -type f -name *.sh -exec sh -n {} +" \
  --risks "$RISKS_TEXT" \
  > "$BODY_FILE"

set -- ./.codex/hooks/publish-and-sync.sh --title "$PR_TITLE" --body-file "$BODY_FILE"
if [ "$NO_MERGE" -eq 1 ]; then
  set -- "$@" --no-merge
fi
if [ "$DRAFT_MODE" -eq 1 ]; then
  set -- "$@" --draft
fi

"$@"

rm -f "$STATE_FILE" "$(baseline_untracked_file)"
