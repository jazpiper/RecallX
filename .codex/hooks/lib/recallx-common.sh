#!/bin/sh

set -eu

repo_root() {
  git rev-parse --show-toplevel
}

state_dir() {
  printf '%s/.codex/state\n' "$(repo_root)"
}

ensure_state_dir() {
  mkdir -p "$(state_dir)"
}

task_state_file() {
  printf '%s/current-task.env\n' "$(state_dir)"
}

baseline_untracked_file() {
  printf '%s/baseline-untracked.txt\n' "$(state_dir)"
}

print_header() {
  printf '\n[%s]\n' "$1"
}

collect_paths() {
  if [ "$#" -gt 0 ]; then
    printf '%s\n' "$@" | sed '/^$/d' | sort -u
    return
  fi

  (
    git diff --name-only --relative HEAD 2>/dev/null || true
    git ls-files --others --exclude-standard 2>/dev/null || true
  ) | sed '/^$/d' | sort -u
}

collect_untracked_paths() {
  git ls-files --others --exclude-standard 2>/dev/null || true
}

filter_baseline_untracked() {
  baseline_file="$(baseline_untracked_file)"
  if [ ! -f "$baseline_file" ]; then
    cat
    return
  fi

  grep -vx -f "$baseline_file" || true
}

collect_task_paths() {
  (
    git diff --name-only --relative HEAD 2>/dev/null || true
    collect_untracked_paths | filter_baseline_untracked
  ) | sed '/^$/d' | sort -u
}

stage_paths() {
  while IFS= read -r path; do
    [ -n "$path" ] || continue
    git add -- "$path"
  done
}

derive_default_commit_subject() {
  branch_name="$(git branch --show-current)"
  slug="${branch_name#codex/}"
  slug="$(printf '%s' "$slug" | tr '-' ' ')"
  printf 'chore: %s\n' "$slug"
}

compute_validation_flags() {
  needs_check=0
  needs_test=0
  needs_build=0
  needs_release_verify=0
  needs_shell_syntax=0
  docs_only=1

  while IFS= read -r path; do
    [ -n "$path" ] || continue

    case "$path" in
      *.md|docs/*|README.md|CHANGELOG.md|LICENSE|AGENTS.md)
        ;;
      *)
        docs_only=0
        ;;
    esac

    case "$path" in
      app/server/*|app/mcp/*|app/shared/*|tests/*)
        needs_check=1
        needs_test=1
        ;;
      app/cli/*)
        needs_check=1
        needs_test=1
        ;;
      app/renderer/*|vite.config.ts|index.html|tsconfig.renderer.json)
        needs_check=1
        needs_build=1
        ;;
      scripts/*|package.json|package-lock.json|app/*/package.json|app/*/package-lock.json|app/shared/version.ts|.github/workflows/*|release/*|.changeset/*)
        needs_check=1
        needs_release_verify=1
        ;;
      .codex/hooks/*.sh|.codex/hooks/lib/*.sh)
        needs_shell_syntax=1
        ;;
    esac
  done
}

print_validation_plan() {
  if [ "${docs_only}" -eq 1 ]; then
    echo "Detected docs-only changes."
    echo "Recommended: manually verify referenced commands, paths, and behavior."
    return
  fi

  echo "Recommended validation:"
  [ "${needs_check}" -eq 1 ] && echo "- npm run check"
  [ "${needs_test}" -eq 1 ] && echo "- npm test"
  [ "${needs_build}" -eq 1 ] && echo "- npm run build"
  [ "${needs_release_verify}" -eq 1 ] && echo "- npm run release:verify"
  [ "${needs_shell_syntax}" -eq 1 ] && echo "- find .codex/hooks -type f -name '*.sh' -exec sh -n {} +"
}

run_validation_plan() {
  if [ "${docs_only}" -eq 1 ]; then
    echo "Docs-only change set. Skipping automatic command execution."
    return 0
  fi

  [ "${needs_check}" -eq 1 ] && npm run check
  [ "${needs_test}" -eq 1 ] && npm test
  [ "${needs_build}" -eq 1 ] && npm run build
  [ "${needs_release_verify}" -eq 1 ] && npm run release:verify
  [ "${needs_shell_syntax}" -eq 1 ] && find .codex/hooks -type f -name '*.sh' -exec sh -n {} +
}

print_change_area_summary() {
  printed=0

  [ "${needs_check}" -eq 1 ] && {
    echo "- touched implementation surfaces that should keep typecheck and behavior aligned"
    printed=1
  }
  [ "${needs_test}" -eq 1 ] && {
    echo "- affected code paths with repo test coverage expectations"
    printed=1
  }
  [ "${needs_build}" -eq 1 ] && {
    echo "- touched renderer or bundling-adjacent files"
    printed=1
  }
  [ "${needs_release_verify}" -eq 1 ] && {
    echo "- touched release, package, workflow, or version-sensitive surfaces"
    printed=1
  }
  [ "${needs_shell_syntax}" -eq 1 ] && {
    echo "- updated local Codex hook scripts"
    printed=1
  }

  if [ "${printed}" -eq 0 ]; then
    echo "- touched docs or lightweight repo guidance surfaces"
  fi
}
