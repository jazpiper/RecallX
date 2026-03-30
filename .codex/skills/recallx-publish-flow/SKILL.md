---
name: recallx-publish-flow
description: Publish, merge, and resync workflow for the RecallX repository. Use when the user explicitly wants you to push a task branch, open or reuse a PR, merge it, return the primary checkout to main, and sync from origin.
---

# RecallX Publish Flow

Use this skill only when the user explicitly wants the full publish flow.

## Default Path

If the task branch is validated and the user does not want a manual review gate, prefer:

```bash
./.codex/hooks/publish-and-sync.sh
```

Use this only when the user explicitly wants to stop before merge:

```bash
./.codex/hooks/publish-and-sync.sh --no-merge --draft
```

## Preconditions

Before running the publish pipeline:

1. Make sure the branch is not `main`.
2. Make sure tracked changes are committed.
3. Make sure the relevant validation already passed.
4. Make sure `gh auth status` is healthy.

## What The Pipeline Should Do

1. Push the current task branch.
2. Create or reuse the PR for that branch.
3. By default, make the PR ready if needed, merge it, and wait until GitHub reports it as merged.
4. Switch the primary checkout back to `main`.
5. Fast-forward `main` from `origin/main`.

## Scope Rule

Do not use this flow when:

- the user still wants to review the PR manually before merge; use `--no-merge` in that case
- the branch is intentionally being kept open for more work
- validation is still red

## Finish

After the pipeline completes:

- confirm the PR URL
- confirm whether it merged
- confirm the current checkout is back on `main`
