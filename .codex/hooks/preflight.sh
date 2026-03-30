#!/bin/sh

set -eu

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

echo "[preflight] RecallX task start checks"
echo "- repo: $ROOT"
echo "- reminder: recall relevant RecallX memory context before broad implementation work"

npm run branch:check
npm run version:check

echo "[preflight] baseline checks passed"
