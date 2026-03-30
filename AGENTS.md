# RecallX Agent Harness

This repository builds RecallX: a local-first shared memory system with a source-run UI, local API, CLI, and MCP bridge.

The job of a coding agent in this repo is not just to "make code pass". The job is to protect product intent, keep retrieval and workspace behavior trustworthy, and make steady progress without drifting off-task.

## 1. Core Mission

- Keep RecallX fast, local-first, inspectable, and deterministic-first.
- Prefer small, reversible changes over broad speculative rewrites.
- Treat retrieval, context assembly, workspace behavior, and provenance as product-critical surfaces.
- Preserve release hygiene. This repo ships source-run workflows plus npm runtime packages.

Before changing behavior, read the docs that define the intended shape of the system:

- `README.md` for distribution paths and top-level commands
- `docs/guardrails.md` for product and architecture constraints
- `docs/retrieval.md` for retrieval and context assembly rules
- `docs/workflows.md` for branch/worktree and workspace workflows
- `docs/release-workflow.md` for changesets, versioning, and publish flow

## 2. Repo Map

Use this map to orient quickly before editing:

- `app/server/`: local API, workspace/session management, retrieval, governance, observability, semantic support
- `app/mcp/`: stdio MCP bridge that talks to the local HTTP API
- `app/cli/`: JavaScript CLI entrypoints and formatting/update helpers
- `app/renderer/`: React 19 + Vite renderer UI
- `app/shared/`: shared contracts, request helpers, version constants
- `tests/`: Vitest coverage for server behavior, MCP, observability, workspace flows, CLI formatting/update, and retrieval hot paths
- `scripts/`: branch hygiene, version hygiene, worktree creation, packaging, and release helpers
- `docs/`: product intent, API/MCP contracts, schema, retrieval model, release workflow

## 3. Tech Stack And Runtime Facts

- Language: TypeScript for server/renderer/MCP, JavaScript for CLI helpers
- Runtime: Node.js
- UI: React 19 + Vite
- API: Express over Node HTTP
- Storage: SQLite-backed local workspace
- Tests: Vitest
- Build: `tsc` for server, `vite build` for renderer

Version and runtime notes:

- `package.json` currently requires Node `>=22.13.0`
- repo docs recommend Node 25+ for source development because the backend uses `node:sqlite`

## 4. Required Memory Workflow

RecallX MCP is the primary durable memory system for this workspace.

- Before meaningful work, check RecallX memory for relevant context using project names, features, issue IDs, file names, or key concepts.
- If a project node is already known, prefer a context bundle. If not, start with broad workspace search and narrow only when needed.
- Read relevant memory before making assumptions.
- During work, write durable facts only when they are reusable: decisions, stable constraints, open questions, or durable relationships.
- Default routine progress notes, implementation summaries, and "what changed" logs to activities, not durable nodes.
- After meaningful work, write back what changed, why it changed, what was verified, and what follow-up remains.
- Never store secrets, credentials, tokens, or other sensitive data.

If tool names differ by client, treat `recallx_*` and older `memforge_*` naming as the same workspace memory system.

## 5. Local Codex Extensions

If local Codex helpers exist under `.codex/`, use them as lightweight guardrails rather than inventing a new workflow every run.

- `.codex/skills/recallx-task-loop/` for the default repo task loop
- `.codex/skills/recallx-harness-self-improve/` for the bounded post-task harness review
- `.codex/skills/recallx-publish-flow/` for explicit publish, merge, and resync work
- `.codex/skills/recallx-retrieval-guard/` for retrieval and hot-path changes
- `.codex/skills/recallx-release-guard/` for release, version, and packaging work
- `.codex/hooks/preflight.sh` for start-of-task checks
- `.codex/hooks/start-task.sh` for creating a fresh task branch from `main` and recording task-local baseline state
- `.codex/hooks/post-edit.sh` for validation suggestions after edits
- `.codex/hooks/pre-finish.sh` for end-of-task validation and write-back reminders
- `.codex/hooks/finish-task.sh` for task-scoped validation, commit, publish, merge, and cleanup in one flow
- `.codex/hooks/finish-report.sh` for a lightweight final response template; add `--verbose` only when changed paths are worth showing
- `.codex/hooks/return-to-main.sh` for switching the primary checkout back to `main` after a task branch is published
- `.codex/hooks/publish-and-sync.sh` for pushing the current task branch, creating or reusing a PR, optionally merging it, and resyncing the primary checkout to `main`

## 6. Start-Of-Task Checklist

Before doing meaningful implementation work:

1. Check memory context.
2. Inspect the current tree and avoid stepping on unrelated edits.
3. Prefer `.codex/hooks/start-task.sh <task-name>` when starting a new task in the primary checkout.
4. Run branch hygiene if you are not using `start-task.sh`.
5. Run version hygiene if the task may affect release artifacts, packaging, or versioned surfaces.
6. Read the most relevant docs and target files before proposing architecture changes.

Repo commands:

```bash
npm run branch:check
npm run version:check
```

Interpretation rules:

- If `branch:check` fails because you are on `main`, on a stacked task branch, or in a dirty tree, do not start unrelated work there.
- Use a fresh sibling worktree for unrelated work:

```bash
npm run branch:new -- <short-task-name>
```

- If the tree is intentionally dirty and you only need a new sibling worktree, `branch:new --allow-dirty` is available, but prefer a clean state when possible.

## 7. Drift-Control Rules

Long autonomous runs must continually re-anchor to the task.

- Keep an explicit task statement in mind: what is being changed, what should stay unchanged, and how success will be verified.
- Re-check the task statement after every significant failure, after broad code exploration, and before any large refactor.
- Do not keep exploring indefinitely. Once the relevant code path is known, switch to execution.
- Do not broaden scope just because adjacent cleanup looks tempting.
- When a new issue appears, decide whether it is blocking, related-but-separate, or unrelated:
  - blocking: fix now
  - related-but-separate: note it, finish the current task first
  - unrelated: leave it alone

When changing retrieval, semantic ranking, project graph, workspace switching, or provenance behavior, re-read the corresponding docs before finalizing the patch.

## 8. Execution Loop

Use this loop for implementation:

1. Understand the target surface and read only the files needed.
2. Form a concrete hypothesis about the change.
3. Edit the smallest useful slice.
4. Run the narrowest meaningful validation immediately.
5. If validation fails, diagnose, patch, and rerun before moving on.
6. After the local slice is stable, run broader repo validation as appropriate.

Prefer multiple small validation loops over one large late-stage validation pass.

## 9. Self-Repair Rules

If something breaks during an autonomous run:

- Reproduce the failure with the smallest command or test target possible.
- Fix the root cause, not only the symptom.
- Re-run the exact failing command first.
- Only expand to broader validation after the focused failure is green.
- If two repair attempts fail and the direction is uncertain, pause and re-anchor on the task before making more edits.

Avoid "confidence theater":

- Do not claim a fix without rerunning the relevant command.
- Do not mark work done because typecheck passed if behavior changed and tests were not exercised.
- Do not rely on memory of old behavior when the code or docs can be read directly.

## 10. Validation Matrix

Default commands:

```bash
npm run check
npm test
npm run build
```

Use this matrix:

- API, repository, workspace, governance, retrieval, semantic, MCP, or shared-contract changes:
  - run `npm run check`
  - run `npm test`
- Renderer-only changes:
  - run `npm run check`
  - run the most relevant tests if behavior is covered
  - run `npm run build` when the change could affect bundling or renderer startup
- CLI or formatting/update changes:
  - run `npm run check`
  - run `npm test`
- Packaging, release, version, workflow, or generated package changes:
  - run `npm run release:verify`
- Docs-only changes:
  - tests are optional, but commands and file paths must be checked for accuracy

Favor targeted test execution when iterating quickly, but do not skip the broader suite before finishing a real code change.

## 11. Release And Versioning Rules

This repo has real release discipline. Respect it.

- Do not hand-edit versions casually.
- Use the repo scripts:

```bash
npm run version:check
npm run version:bump -- patch|minor|major
```

- When a code change should appear in release notes, add a changeset.
- For release-sensitive work, read `docs/release-workflow.md` before editing workflows or packaging scripts.
- If changing publish/package behavior, prefer running `npm run release:verify` before considering the work done.

## 12. Retrieval And Performance Guardrails

RecallX is speed-sensitive. Retrieval is a hot path.

- Keep deterministic retrieval first.
- Keep semantic augmentation optional and bounded.
- Prefer summary-first and compact bundles over large raw-body reads.
- Avoid broad graph crawling, expensive default work, and hidden "smart" behavior on every query.
- Preserve inspectability: behavior should be explainable from local rules, not opaque magic.

If touching retrieval or semantic logic, read `docs/retrieval.md` and relevant tests first.

## 13. Writing Rules

- Preserve append-first and attributable behavior.
- Be cautious with canonical durable knowledge. High-signal summaries beat noisy raw dumps.
- External reads can be easy; durable writes should remain deliberate.
- Do not silently mutate important user knowledge structures unless the code path clearly intends that behavior.

## 14. Editing Rules

- Prefer precise edits over sweeping rewrites.
- Follow existing naming, formatting, and module boundaries unless there is a strong reason not to.
- Do not replace working repo scripts with ad hoc shell snippets in docs or automation guidance.
- Do not revert unrelated user changes.
- Do not remove guardrails because they are inconvenient for the current task.

## 15. Done Definition

Work is only done when all of the following are true:

- the requested behavior or documentation change exists
- the change is still aligned with RecallX product guardrails
- the relevant validation commands were rerun and passed
- remaining risks or follow-ups are explicitly called out
- a concise RecallX memory write-back was made when the task was meaningful

## 16. Branch Reset After Publish

After a completed task branch has been committed, pushed, or turned into a PR, return the primary checkout to `main` unless you are intentionally continuing the same branch.

Rules:

- do not start unrelated work from a stale `codex/*` branch
- prefer `main` as the reset point for the next task in the primary checkout
- use the task branch only when you are still actively iterating on that same PR
- if helpful, run `.codex/hooks/return-to-main.sh` after the publish step
- default to `.codex/hooks/publish-and-sync.sh` when the user wants the full publish flow
- when maximum automation is desired, prefer `.codex/hooks/finish-task.sh` as the final handoff step after implementation and validation
- only stop before merge when the user explicitly asks for manual review or manual merge
## 17. Post-Task Harness Self-Improvement

After a meaningful task is complete, run one short bounded self-review of the harness itself.

Default tool for that step:

- use `.codex/skills/recallx-harness-self-improve/`

Ask:

- did the start-of-task checklist miss an important precondition?
- did drift happen that the current loop failed to catch early enough?
- did validation guidance prove too weak, too broad, or misleading?
- did a repeated failure suggest a missing skill, hook, reminder, or repo-specific rule?

Improvement rules:

- make at most one bounded harness improvement per task unless the user explicitly asks for a deeper harness pass
- prefer small updates to `AGENTS.md`, `.codex/skills/`, or `.codex/hooks/` over rewriting the harness wholesale
- only promote lessons that seem reusable across future RecallX tasks
- do not recurse endlessly: after one self-improvement pass, stop

When no reusable lesson emerged, record that briefly and move on without changing the harness.

## 18. Suggested Operating Pattern For Long Autonomous Work

Use this rhythm on longer runs:

1. Recall context from memory and docs.
2. Restate the task and success criteria internally.
3. Work in small slices.
4. Validate after each slice.
5. Re-anchor after failures or after broad exploration.
6. Summarize what changed and write back the result.
7. Run one bounded harness self-improvement check.

If a task starts feeling vague, the correct response is not to do more random work. Narrow the objective, identify the next concrete checkpoint, and continue from there.
