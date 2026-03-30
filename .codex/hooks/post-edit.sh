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

print_header "post-edit"
if [ -z "$PATHS" ]; then
  echo "No changed paths detected."
  exit 0
fi

echo "$PATHS" | sed 's/^/- /'

compute_validation_flags <<EOF
$PATHS
EOF

print_validation_plan

if [ "$RUN_MODE" -eq 1 ]; then
  print_header "running validation"
  run_validation_plan
fi
