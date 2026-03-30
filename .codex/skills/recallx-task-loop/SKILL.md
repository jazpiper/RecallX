---
name: recallx-task-loop
description: Default implementation workflow for the RecallX repository. Use when doing code or docs work in this repo and you need a stable loop for context recall, branch hygiene, drift control, validation, and RecallX write-back.
---

# RecallX Task Loop

Use this as the default skill for work inside the RecallX repo.

## Start Here

1. Read `AGENTS.md`.
2. Recall relevant context from RecallX memory before making assumptions.
3. Run:

```bash
npm run branch:check
npm run version:check
```

4. Read only the docs and files needed for the requested task.

## Execution Loop

1. Restate the concrete task and success signal to yourself.
2. Edit the smallest useful slice first.
3. Run the narrowest meaningful validation immediately.
4. If validation fails, fix the root cause and rerun the same command before broadening.
5. Re-anchor on the task after failures or broad exploration.

## Validation Defaults

- Server, MCP, retrieval, workspace, governance, shared-contract changes:
  - `npm run check`
  - `npm test`
- Renderer changes:
  - `npm run check`
  - `npm run build`
- Packaging, workflow, release, version changes:
  - `npm run release:verify`
- Docs-only changes:
  - verify commands, paths, and referenced behavior manually

## Do Not Drift

- Do not keep working on `main` for unrelated tasks.
- Do not turn adjacent cleanup into hidden scope creep.
- Do not claim success without rerunning the relevant validation command.

## Finish

Before wrapping up:

1. Re-run the relevant validation.
2. Call out residual risks or follow-ups.
3. Write a concise RecallX activity summary when the task was meaningful.
4. Run `recallx-harness-self-improve`.
5. If that review says "no reusable lesson", stop.
6. If that review says "yes", make one small reusable harness improvement and stop.
7. If a quick closeout draft would help, run `./.codex/hooks/finish-report.sh`.
8. Add `--verbose` only when the changed-path list is actually useful.
9. After push or PR creation, run `./.codex/hooks/return-to-main.sh` unless you are intentionally continuing the same task branch.
10. If the user explicitly wants the full publish path, default to `./.codex/hooks/publish-and-sync.sh`.
11. Only use `--no-merge` when the user explicitly wants to review or merge manually.
