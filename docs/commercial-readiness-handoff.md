# RecallX - Commercial Readiness Handoff

## Purpose

This document records the current finite hardening queue for RecallX during feature freeze.

It exists to support continuation work on shipped behavior only:

- reliability
- operational trust
- supportability
- cross-surface consistency

It is not a new rolling product roadmap.

## Current state

Three bounded hardening packets are now implemented locally in the `codex/workspace-reliability` worktree.

### Packet 1 - Workspace artifact reliability

What changed:

- same-second backup ids allocate deterministic `-2`, `-3`, ... suffixes instead of colliding
- same-second export ids allocate deterministic `-2`, `-3`, ... suffixes instead of overwriting files
- same-second staged import paths allocate deterministic `-2`, `-3`, ... suffixes instead of colliding
- restore rejects incomplete or malformed backups with `INVALID_BACKUP`
- restore uses a staged temp directory before the final move so failed restores do not leave partial workspaces behind

Primary files:

- `app/server/workspace-ops.ts`
- `app/server/workspace-import.ts`
- `tests/workspace-ops.test.ts`
- `tests/server.behavior.test.ts`

### Packet 2 - Workspace catalog persistence

What changed:

- known workspaces now persist across process restarts through a private local catalog file
- malformed catalog payloads are ignored safely
- missing roots are pruned from the persisted catalog during normal listing
- workspace switching no longer mutates the active process state if catalog persistence fails mid-switch

Primary files:

- `app/server/workspace-session.ts`
- `tests/workspace-catalog-persistence.test.ts`

### Packet 3 - Home semantic operational surface parity

What changed:

- blank-query `Home` now shows a compact semantic operations card
- the card surfaces enabled state, provider/model, counts, last reindex timestamp, issue filter chips, paginated issue list, and workspace reindex action
- renderer-side semantic client helpers and fallback data now exist for status/issues/reindex

Primary files:

- `app/renderer/src/App.tsx`
- `app/renderer/src/lib/mockApi.ts`
- `app/renderer/src/lib/types.ts`
- `app/renderer/src/lib/mockWorkspace.ts`
- `app/renderer/src/styles.css`
- `tests/renderer.semantic-home.test.ts`

Shared validation already completed in this worktree:

- `npx vitest run tests/workspace-ops.test.ts tests/server.behavior.test.ts`
- `npx vitest run tests/workspace-catalog-persistence.test.ts`
- `npx vitest run tests/renderer.semantic-home.test.ts`
- `npm run check`
- `npm test`
- `npm run build`

Environment note:

- `lsp_diagnostics` was not available because `typescript-language-server` is not installed in this environment

## Next finite queue snapshot

The next default packet should be:

### Packet 4 - MCP startup and observability failure clarity

Why this is next:

- the product already exposes MCP status and setup surfaces, but failure handling is still thinner than the surrounding workspace trust model
- fetch/config failures can still degrade into placeholder or low-context states that are harder to diagnose than they should be
- this is a hardening packet for existing shipped behavior, not a new product surface

Target surfaces:

- `app/mcp/server.ts`
- `app/mcp/api-client.ts`
- `app/server/app.ts` only if the existing status payload needs clearer wiring
- `app/renderer/src/App.tsx` only if the current MCP status card needs clearer error copy
- `tests/mcp.server.test.ts`
- `tests/server.behavior.test.ts` only if route/status coverage needs to expand

Acceptance target:

- MCP startup failures surface a clear actionable reason
- fetch/config failures do not silently collapse into misleading placeholder state
- existing MCP status surfaces stay lightweight and inspectable
- no new top-level page, no new route family, no model-provider scope expansion

Suggested stop rule:

- stop as soon as MCP startup and status failures are test-backed, clearly surfaced, and green in the normal validation matrix
- do not continue into Packet 5 from the same run unless explicitly asked

## Later candidates after Packet 4

1. workspace safety warning actionability

- the current warnings are visible, but recovery guidance is still thinner than the trust model implies

2. RecallX JSON import fidelity

- import currently warns and skips some exported surfaces such as settings, integrations, and artifacts
- this is worth revisiting after workspace/session/MCP trust work is tighter

## Boundaries for the next run

- strengthen shipped behavior only
- do not open a new rolling product queue
- do not add new top-level pages or new API endpoints
- do not broaden into semantic model-provider product work from this handoff
- keep RecallX local-first, deterministic-first, and inspectable

## Resume context

Resume from:

- branch: `codex/workspace-reliability`
- worktree: `/Users/kojuhwan/Documents/Develop/RecallX-workspace-reliability`

Current local state to preserve:

- Packet 1, Packet 2, and Packet 3 are still uncommitted together in the source worktree
- the packaging plan is to split them into separate packet-scoped branches and PRs before continuing Packet 4

If continuing from this state, the safest sequence is:

1. split Packet 1, Packet 2, and Packet 3 into separate branches/PRs
2. verify PR checks and fix any CI failures
3. clean up the source worktree branch state
4. start Packet 4 from a fresh sibling worktree or a clean surviving packet branch
