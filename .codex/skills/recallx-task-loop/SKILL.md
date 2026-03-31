---
name: recallx-task-loop
description: Default implementation workflow for the RecallX repository. Use when doing code or docs work in this repo and you need a stable loop for context recall, branch hygiene, drift control, validation, and RecallX write-back.
---

# RecallX Task Loop

Use this as the default skill for work inside the RecallX repo.

## Start Here

1. Read `AGENTS.md`.
2. Recall relevant context from RecallX memory before making assumptions.
3. Prefer:

```bash
./.codex/hooks/start-task.sh <task-name>
```

4. If you are already inside the task branch, run:

```bash
npm run branch:check
npm run version:check
```

5. Read only the docs and files needed for the requested task.

## Execution Loop

1. Restate the concrete task and success signal to yourself.
2. Decide whether any bounded side work should be delegated now; use `recallx-subagent-orchestration` when helpful.
3. Reuse an existing suitable sub-agent before spawning a new one.
4. Edit the smallest useful slice first.
5. Run the narrowest meaningful validation immediately.
6. If validation fails, fix the root cause and rerun the same command before broadening.
7. Re-anchor on the task after failures or broad exploration.

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

## Roadmap Exhaustion Mode

Use this extra rule when the user asks to "keep going" until a roadmap or backlog is done:

1. If the source backlog is a rolling recommendation document, convert it into a finite queue snapshot first.
2. Write down the queued items and the stop rule before starting the execution chain.
3. During that run, treat newly discovered follow-ups as later candidates unless the user explicitly asked for rolling mode.
4. Keep one branch or PR per queued item unless the user asked to batch them together.
5. Stop when the queued snapshot is empty, shipped, or intentionally deferred.

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
9. Confirm there are no stale sub-agents left open from this task; reuse active ones intentionally or close them.
10. After push or PR creation, run `./.codex/hooks/return-to-main.sh` unless you are intentionally continuing the same task branch.
11. If the user explicitly wants the full publish path, default to `./.codex/hooks/publish-and-sync.sh`.
12. Only use `--no-merge` when the user explicitly wants to review or merge manually.
13. If the user wants maximum automation, prefer `./.codex/hooks/finish-task.sh`.
