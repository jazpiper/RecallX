#!/bin/sh

set -eu

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

. "$ROOT/.codex/hooks/lib/recallx-common.sh"

RUN_MODE=0

if [ "${1:-}" = "--run" ]; then
  RUN_MODE=1
  shift
fi

PATHS="$(collect_paths "$@")"

print_header "pre-finish"
git status --short

if [ -n "$PATHS" ]; then
  echo
  echo "Changed paths:"
  echo "$PATHS" | sed 's/^/- /'

  compute_validation_flags <<EOF
$PATHS
EOF

  echo
  print_validation_plan
else
  echo "No changed paths detected."
fi

echo
echo "Finish checklist:"
echo "- confirm the requested behavior or docs change is actually present"
echo "- confirm the relevant validation commands were rerun"
echo "- note residual risks or follow-ups"
echo "- write a concise RecallX activity summary if the task was meaningful"
echo "- run recallx-harness-self-improve and update AGENTS.md or .codex only if the lesson is reusable"
echo "- optionally run ./.codex/hooks/finish-report.sh for a concise closeout draft, or add --verbose to include changed paths"

if [ "$RUN_MODE" -eq 1 ] && [ -n "$PATHS" ]; then
  print_header "running validation"
  run_validation_plan
fi
