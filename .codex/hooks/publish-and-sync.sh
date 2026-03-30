#!/bin/sh

set -eu

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

BASE_BRANCH="main"
MERGE_MODE=1
DRAFT_MODE=0
DELETE_BRANCH=1
RETURN_MAIN=1
TITLE=""
BODY=""
BODY_FILE=""
STRATEGY="squash"
TIMEOUT_SECONDS=900
CHECK_DISCOVERY_SECONDS=120

usage() {
  cat <<'EOF'
Usage: ./.codex/hooks/publish-and-sync.sh [options]

Options:
  --base <branch>         Base branch for the pull request (default: main)
  --title <text>          PR title
  --body <text>           PR body text
  --body-file <path>      PR body file
  --draft                 Create or keep the PR as draft when --no-merge is used
  --merge                 Explicitly keep auto-merge behavior enabled
  --no-merge              Stop after push and PR creation or reuse
  --strategy <name>       Merge strategy: squash, merge, rebase (default: squash)
  --keep-branch           Do not delete the remote branch after merge
  --no-return-main        Skip switching the primary checkout back to main
  --timeout-seconds <n>   Wait timeout for merge completion (default: 900)
  --check-discovery-seconds <n>
                          Wait for checks to appear before deciding how to gate merge (default: 120)
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --base)
      BASE_BRANCH="${2:-}"
      shift 2
      ;;
    --title)
      TITLE="${2:-}"
      shift 2
      ;;
    --body)
      BODY="${2:-}"
      shift 2
      ;;
    --body-file)
      BODY_FILE="${2:-}"
      shift 2
      ;;
    --draft)
      DRAFT_MODE=1
      shift
      ;;
    --merge)
      MERGE_MODE=1
      shift
      ;;
    --no-merge)
      MERGE_MODE=0
      shift
      ;;
    --strategy)
      STRATEGY="${2:-}"
      shift 2
      ;;
    --keep-branch)
      DELETE_BRANCH=0
      shift
      ;;
    --no-return-main)
      RETURN_MAIN=0
      shift
      ;;
    --timeout-seconds)
      TIMEOUT_SECONDS="${2:-}"
      shift 2
      ;;
    --check-discovery-seconds)
      CHECK_DISCOVERY_SECONDS="${2:-}"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

case "$STRATEGY" in
  squash|merge|rebase) ;;
  *)
    echo "Unsupported merge strategy: $STRATEGY" >&2
    exit 1
    ;;
esac

CURRENT_BRANCH="$(git branch --show-current)"
if [ -z "$CURRENT_BRANCH" ]; then
  echo "[publish-and-sync] detached HEAD is not supported" >&2
  exit 1
fi

if [ "$CURRENT_BRANCH" = "$BASE_BRANCH" ] || [ "$CURRENT_BRANCH" = "main" ]; then
  echo "[publish-and-sync] refusing to publish directly from $CURRENT_BRANCH" >&2
  exit 1
fi

STATUS="$(git status --porcelain)"
TRACKED_STATUS="$(printf '%s\n' "$STATUS" | grep -v '^?? ' || true)"
if [ -n "$TRACKED_STATUS" ]; then
  echo "[publish-and-sync] tracked changes are still present on $CURRENT_BRANCH" >&2
  echo "Commit or stash them before running the publish pipeline." >&2
  exit 1
fi

gh auth status >/dev/null

echo "[publish-and-sync] pushing $CURRENT_BRANCH"
git push -u origin "$CURRENT_BRANCH"

PR_JSON="$(gh pr list --head "$CURRENT_BRANCH" --base "$BASE_BRANCH" --state open --json number,url,isDraft --limit 1)"
PR_URL="$(printf '%s' "$PR_JSON" | node -e 'const fs=require("fs");const data=JSON.parse(fs.readFileSync(0,"utf8"));process.stdout.write(data[0]?.url ?? "")')"
PR_IS_DRAFT="$(printf '%s' "$PR_JSON" | node -e 'const fs=require("fs");const data=JSON.parse(fs.readFileSync(0,"utf8"));process.stdout.write(data[0] ? String(Boolean(data[0].isDraft)) : "")')"

if [ -z "$PR_URL" ]; then
  echo "[publish-and-sync] creating PR"
  set -- gh pr create --base "$BASE_BRANCH" --head "$CURRENT_BRANCH"
  if [ -n "$TITLE" ]; then
    set -- "$@" --title "$TITLE"
  fi
  if [ -n "$BODY_FILE" ]; then
    set -- "$@" --body-file "$BODY_FILE"
  elif [ -n "$BODY" ]; then
    set -- "$@" --body "$BODY"
  else
    set -- "$@" --fill
  fi
  if [ "$DRAFT_MODE" -eq 1 ] && [ "$MERGE_MODE" -eq 0 ]; then
    set -- "$@" --draft
  fi
  PR_URL="$("$@")"
  PR_IS_DRAFT="$([ "$DRAFT_MODE" -eq 1 ] && [ "$MERGE_MODE" -eq 0 ] && echo true || echo false)"
else
  echo "[publish-and-sync] reusing PR: $PR_URL"
fi

echo "[publish-and-sync] PR: $PR_URL"

if [ "$MERGE_MODE" -eq 0 ]; then
  exit 0
fi

if [ "$PR_IS_DRAFT" = "true" ]; then
  echo "[publish-and-sync] marking draft PR ready"
  gh pr ready "$PR_URL"
fi

wait_for_any_checks() {
  start_ts="$(date +%s)"
  while :; do
    checks_output="$(gh pr checks "$PR_URL" --json bucket,state,name,workflow 2>&1 || true)"
    if [ "$checks_output" != "no checks reported on the '$CURRENT_BRANCH' branch" ] && [ -n "$checks_output" ]; then
      return 0
    fi

    now_ts="$(date +%s)"
    elapsed=$((now_ts - start_ts))
    if [ "$elapsed" -ge "$CHECK_DISCOVERY_SECONDS" ]; then
      return 1
    fi

    sleep 5
  done
}

no_checks_reported() {
  case "$1" in
    *"no checks reported on the '"$CURRENT_BRANCH"' branch"*)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

wait_for_reported_checks() {
  start_ts="$(date +%s)"
  while :; do
    watch_output="$(gh pr checks "$PR_URL" --watch --fail-fast 2>&1)" && {
      printf '%s\n' "$watch_output"
      return 0
    }

    if ! no_checks_reported "$watch_output"; then
      printf '%s\n' "$watch_output" >&2
      return 1
    fi

    now_ts="$(date +%s)"
    elapsed=$((now_ts - start_ts))
    if [ "$elapsed" -ge "$CHECK_DISCOVERY_SECONDS" ]; then
      echo "[publish-and-sync] reported PR checks never became watchable within ${CHECK_DISCOVERY_SECONDS}s; continuing without check gating"
      return 0
    fi

    sleep 5
  done
}

echo "[publish-and-sync] waiting for GitHub checks to appear"
if wait_for_any_checks; then
  if gh pr checks "$PR_URL" --required >/dev/null 2>&1; then
    echo "[publish-and-sync] waiting for required GitHub checks"
    if ! gh pr checks "$PR_URL" --watch --required --fail-fast; then
      echo "[publish-and-sync] required GitHub checks did not pass" >&2
      exit 1
    fi
  else
    echo "[publish-and-sync] no required checks configured; waiting on reported PR checks"
    if ! wait_for_reported_checks; then
      echo "[publish-and-sync] reported PR checks did not pass" >&2
      exit 1
    fi
  fi
else
  echo "[publish-and-sync] no checks were reported within ${CHECK_DISCOVERY_SECONDS}s; continuing without check gating"
fi

DELETE_FLAG=""
if [ "$DELETE_BRANCH" -eq 1 ]; then
  DELETE_FLAG="--delete-branch"
fi

echo "[publish-and-sync] merging PR with strategy: $STRATEGY"
if ! gh pr merge "$PR_URL" "--$STRATEGY" $DELETE_FLAG >/dev/null 2>&1; then
  gh pr merge "$PR_URL" --auto "--$STRATEGY" $DELETE_FLAG
fi

echo "[publish-and-sync] waiting for PR to merge"
START_TS="$(date +%s)"
while :; do
  STATE="$(gh pr view "$PR_URL" --json state --jq '.state')"
  if [ "$STATE" = "MERGED" ]; then
    break
  fi

  NOW_TS="$(date +%s)"
  ELAPSED=$((NOW_TS - START_TS))
  if [ "$ELAPSED" -ge "$TIMEOUT_SECONDS" ]; then
    echo "[publish-and-sync] timed out waiting for PR to merge: $PR_URL" >&2
    exit 1
  fi

  sleep 10
done

echo "[publish-and-sync] PR merged"

if [ "$RETURN_MAIN" -eq 1 ]; then
  if [ -x "./.codex/hooks/return-to-main.sh" ]; then
    sh ./.codex/hooks/return-to-main.sh
  else
    git switch "$BASE_BRANCH"
    git pull --ff-only origin "$BASE_BRANCH"
  fi
fi
