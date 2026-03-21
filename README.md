# Memforge

Memforge is a **local-first personal knowledge layer for humans and agents**.

It is designed to let a human user and multiple external tools — such as Claude Code, Codex, Gemini CLI, OpenClaw, and future integrations — read from and write to one durable local workspace.

## Core idea

This product is **not** primarily an AI note-taking app.
It is a **shared memory substrate** for:
- notes
- projects
- ideas
- questions
- decisions
- references
- activities
- relationships between them

## Positioning

- **One brain, many tools.**
- **A personal knowledge layer for humans and agents.**
- **Keep your knowledge local. Let every agent think with it.**

## Product priorities

- local-first
- fast retrieval
- summary-first context assembly
- append-first agent writes
- explicit provenance
- lightweight, non-bloated architecture

## Documentation map

- `docs/concept.md` — product definition, positioning, and strategic direction
- `docs/mvp.md` — MVP scope and feature boundaries
- `docs/architecture.md` — system architecture and local service model
- `docs/schema.md` — durable storage schema
- `docs/integrations.md` — tool/agent integration patterns
- `docs/retrieval.md` — scout/main retrieval model and context assembly
- `docs/guardrails.md` — anti-bloat and speed-preserving constraints
- `docs/build-plan.md` — implementation phases and milestone plan
- `docs/ux.md` — human-facing desktop UX
- `docs/api.md` — local HTTP + CLI contract
- `docs/mcp.md` — stdio MCP bridge design and tool mapping
- `docs/workflows.md` — validated external-tool workflows
- `docs/release-checklist.md` — initial release gate for desktop + npm artifacts
- `docs/review-brief.md` — historical v1 review notes kept for reference
- `CHANGELOG.md` — shipped release notes

## Current product surface

Memforge now ships as a usable local-first desktop and agent surface:

- local Node/TypeScript service with SQLite-backed workspace storage
- append-first governance rules and automatic governance behavior
- loopback HTTP API under `/api/v1`
- thin `pnw` / `memforge` CLI wrapper
- React renderer with a 3-pane layout, a unified Guide surface for HTTP + MCP setup, governance/detail flows, graph neighborhood inspection, and a bounded project-map explorer
- runtime workspace create/open switching without restarting the local service

## Latest update

On 2026-03-21, Memforge's current code surface was synchronized around two recent feature rounds:

- the project graph explorer now ships as a bounded project-map flow in the renderer and as `GET /api/v1/projects/:id/graph` in the local API
- the local semantic sidecar now uses `local-ngram` / `chargram-v1` embedding version `2`, with version-aware lookup and automatic stale/requeue behavior when semantic configuration changes

The same round also tightened the hot paths around those features:

- the heavy graph renderer stack (`sigma`, `graphology`) is lazy-loaded instead of being shipped in the main renderer bundle
- timeline scrubbing no longer forces a full structural graph rebuild
- workspace-wide semantic reindex queueing now batch-loads nodes instead of hydrating them one by one
- project membership reads and empty-project fallback hydration now avoid avoidable full-scan and N+1 patterns
- the renderer no longer loads the third-party Figma capture script on every launch

The previous 2026-03-19 integration update is still in place:

- a machine-discoverable service index at `GET /api/v1`
- a first-pass stdio MCP bridge under `app/mcp`

That round also tightened local security defaults, expanded deterministic retrieval signals, and made the current UI and packaging story feel more native:

- a machine-discoverable service index at `GET /api/v1`
- a first-pass stdio MCP bridge under `app/mcp`

The same round of work also tightened local security defaults, expanded deterministic retrieval signals, and made the current UI and packaging story feel more native:

- browser requests are accepted only from loopback origins such as `127.0.0.1` and `localhost`
- renderer bearer tokens are kept in memory instead of persistent browser storage
- browser SSE subscriptions no longer put bearer tokens on the event-stream URL
- artifact paths must stay inside the active workspace root
- graph inspection now uses an explicit focus node and `Inspect in Graph` entry points instead of an implicit background selection
- project understanding now also includes a bounded project-map view with relation/source filters and timeline emphasis controls
- summary refresh is now a first-class on-demand action on the node detail surface
- inferred relations now expand beyond tag/body/activity signals into project-membership and shared-artifact signals
- an Electron desktop shell can now boot the local API, expose stdio MCP through `--mcp-stdio`, and package the built app through `npm run desktop` and `npm run package:desktop`
- the packaged desktop shell can now stay resident in the background, expose a macOS menu bar item, and keep the local API alive after the main window is closed
- default workspace roots now live under `~/.memforge/{workspaceName}`, with legacy repo-local `.memforge-workspace` copied forward when needed

Repository guidance was also tightened so coding agents treat Memforge as the primary durable memory system for this workspace.

## Progress snapshot

- Phase 0 foundation is live locally with workspace boot, SQLite schema, migrations, and runtime workspace switching.
- Phase 1 UI now exposes Home, Guide, Recent, Graph, Project map, Governance, and Settings flows backed by the live local API when available, plus provenance-aware detail views, explicit graph focus, and bounded project graph inspection.
- Phase 2 retrieval is wired through local search, neighborhood lookup, decisions/open questions helpers, and compact context bundles.
- Phase 3 external access is live through the loopback HTTP API, the thin `pnw` CLI, and the new service index for self-discovery.
- Phase 4 append-first write-back is live through durable node creation, relation creation, activities, artifacts, provenance, search feedback, and automatic governance.
- Phase 5 curation is now automatic through governance state/events, governance issue surfaces, provenance-friendly detail flows, and summary refresh/staleness visibility.
- Phase 6 real cross-tool adoption now includes documented terminal-native `pnw`, raw HTTP bootstrap, and stdio MCP workflows in addition to the local coding-agent path.
- Phase 7 selective retrieval enhancement now includes deterministic inferred-relation generation from tag/body/activity, project-membership, and shared-artifact signals, inferred-relation storage, usage feedback events, explicit/automatic score recompute, relation-aware ranking, and an optional local semantic sidecar with `sqlite-vec` preferred and `sqlite` fallback execution paths.

## Current status

Memforge has moved past the docs-only stage into a usable local product: one local workspace can now be opened by the renderer, served over the loopback API, queried from the CLI, and reached through an MCP bridge without adding a second storage layer.

The project is now beyond the purely local scaffold stage: the desktop shell can boot the local service, the renderer can expose workspace and runtime operations, the semantic worker can maintain a rebuildable vector sidecar, and the external-tool workflows are documented against the current implementation. The main work now is iterative polish after the first public release.

## Next focus

- dogfood the packaged desktop shell and add distribution polish such as app icons, signing, and notarization when needed
- tune inferred-relation thresholds, evidence display, and explainability based on real workspace usage
- decide whether richer digest materialization is worth adding beyond the current deterministic summary baseline

## Install

Desktop releases:

- macOS arm64: install the signed and notarized `.dmg` or `.zip` from the GitHub release
- Linux x64: install the `.AppImage` or `.deb` from the GitHub release

CLI + MCP from npm:

```bash
npm install -g memforge
memforge --help
pnw mcp install
memforge-mcp --help
```

`pnw mcp install` writes a stable launcher to `~/.memforge/bin/memforge-mcp`, which is the recommended command path for editor MCP configs.

Node requirement for CLI users:

- Node 20+

## Quick start

```bash
npm install
npm run dev
```

Server only:

```bash
npm run build:server
npm start
```

Key checks:

```bash
npm run check
npm test
npm run build
```

## Current implementation notes

- The backend uses Node's built-in `node:sqlite` module, so Node 25+ is currently the easiest path.
- The renderer prefers the local API and falls back to mock data if the API is unavailable.
- In bearer mode, the renderer token is session-only today, so a page refresh or restart may require entering it again.
- The repo now includes an Electron desktop shell. Use `npm run desktop` for a local packaged-shell run or `npm run package:desktop` to produce a distributable build under `release/`.
- Public release targets are macOS arm64 desktop artifacts plus Linux x64 `AppImage` / `.deb`, while the npm package is used for CLI and MCP access.
- The standalone server still defaults to `127.0.0.1:8787`, while the desktop shell now defaults to `127.0.0.1:8788` so both can run side by side more predictably. Override the desktop default with `MEMFORGE_DESKTOP_PORT` when needed.
- Renderer development is now split too: browser/local-service renderer stays on `127.0.0.1:5173`, while desktop dev renderer uses `127.0.0.1:5174` through `npm run dev:desktop`.
- To launch both together after a build, use `npm run start:desktop`. That starts the standalone API on `127.0.0.1:8787` and the desktop shell on `127.0.0.1:8788`.
- In packaged mode, closing the main window now hides Memforge to the background instead of quitting immediately. Use the menu bar item to reopen the app, copy API/MCP info, or restart the local service, and use `Quit Memforge` to fully stop the desktop shell.
- The default workspace root is `~/.memforge/{workspaceName}`. Existing repo-local `.memforge-workspace` data is copied into the new home-directory root the first time the new default is used.
- Semantic indexing stays local. Memforge now tries to load `sqlite-vec` on startup for bounded vector math and automatically falls back to the existing SQLite/app-calculated path if the extension is unavailable.
- The built-in validation provider is currently `local-ngram` / `chargram-v1` with embedding version `2`. Semantic lookup now requires `provider + model + version` compatibility, and semantic config changes automatically stale and requeue affected rows for rebuild.

## Using Memforge From Other Coding Agents

If you want Claude Code, Codex, Gemini CLI, or another coding agent to use the running local Memforge service, do not give it only the base URL. Point it to the service index first:

- Service index: `GET http://127.0.0.1:8787/api/v1`
- Health check: `GET http://127.0.0.1:8787/api/v1/health`
- Current workspace: `GET http://127.0.0.1:8787/api/v1/workspace`

The service index returns:

- what Memforge can do
- important endpoints
- example request payloads
- CLI examples
- current workspace and auth mode

Recommended instruction to another agent:

```text
Use my running local Memforge service at http://127.0.0.1:8787/api/v1.
Start by calling GET /api/v1, then GET /health and GET /workspace.
Use the returned endpoint list and request examples to search nodes and activities, inspect governance state, build context bundles, and switch workspaces.
Reuse the existing local service instead of starting a new one.
```

## MCP bridge

Memforge ships a stdio MCP adapter for coding agents that prefer tool discovery over raw HTTP calls.

Use one of these entrypoints:

```bash
npm run mcp
node dist/server/app/mcp/index.js --api http://127.0.0.1:8787/api/v1
Memforge --mcp-stdio
memforge-mcp --api http://127.0.0.1:8787/api/v1
```

For setup details, launcher paths, environment variables, and editor-specific examples, use `docs/mcp.md` as the source of truth.
See `docs/workflows.md` for the non-agent workflows that are already validated in the current implementation.
