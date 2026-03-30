#!/bin/sh

set -eu

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

. "$ROOT/.codex/hooks/lib/recallx-common.sh"

TASK_TEXT=""
VALIDATED_TEXT=""
RISKS_TEXT=""
VERBOSE=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --task)
      TASK_TEXT="${2:-}"
      shift 2
      ;;
    --validated)
      VALIDATED_TEXT="${2:-}"
      shift 2
      ;;
    --risks)
      RISKS_TEXT="${2:-}"
      shift 2
      ;;
    --verbose)
      VERBOSE=1
      shift
      ;;
    *)
      break
      ;;
  esac
done

PATHS="$(collect_paths "$@")"

if [ -z "$PATHS" ]; then
  echo "No changed paths detected."
  exit 0
fi

compute_validation_flags <<EOF
$PATHS
EOF

echo "## Summary"

if [ -n "$TASK_TEXT" ]; then
  echo "$TASK_TEXT"
else
  echo "Completed the requested RecallX repo updates and kept the change scoped to the current task."
fi

echo
echo "## Change Areas"
print_change_area_summary

if [ "$VERBOSE" -eq 1 ]; then
  echo
  echo "Changed paths:"
  echo "$PATHS" | sed 's/^/- /'
fi

echo
echo "## Validation"
if [ -n "$VALIDATED_TEXT" ]; then
  printf '%s\n' "$VALIDATED_TEXT" | tr ',' '\n' | sed 's/^/- /'
else
  if [ "${docs_only}" -eq 1 ]; then
    echo "- docs-only changes; manually verify referenced commands, paths, and behavior"
  else
    [ "${needs_check}" -eq 1 ] && echo "- npm run check"
    [ "${needs_test}" -eq 1 ] && echo "- npm test"
    [ "${needs_build}" -eq 1 ] && echo "- npm run build"
    [ "${needs_release_verify}" -eq 1 ] && echo "- npm run release:verify"
    [ "${needs_shell_syntax}" -eq 1 ] && echo "- find .codex/hooks -type f -name '*.sh' -exec sh -n {} +"
  fi
fi

echo
echo "## Risks / Follow-ups"
if [ -n "$RISKS_TEXT" ]; then
  printf '%s\n' "$RISKS_TEXT" | tr ',' '\n' | sed 's/^/- /'
else
  echo "- Add any residual risks, skipped checks, or next steps here."
fi

echo
echo "## Harness Follow-up"
echo "- Run recallx-harness-self-improve."
echo "- If no reusable lesson emerged, say so explicitly."
