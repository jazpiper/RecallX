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
- `docs/review-brief.md` — concise reviewer guide and open questions

## Current stage

First implementation scaffold is now in place:

- local Node/TypeScript service with SQLite-backed workspace storage
- append-first governance rules and review queue behavior
- loopback HTTP API under `/api/v1`
- thin `pnw` / `memforge` CLI wrapper
- React renderer with 3-pane layout, provenance-aware review/detail flows, and user-driven graph focus
- runtime workspace create/open switching without restarting the local service

## Latest update

On 2026-03-19, Memforge gained two new agent-facing entry points on top of the existing local API and CLI:

- a machine-discoverable service index at `GET /api/v1`
- a first-pass stdio MCP bridge under `app/mcp`

The same round of work also tightened local security defaults, expanded deterministic retrieval signals, and made the current UI and packaging story feel more native:

- browser requests are accepted only from loopback origins such as `127.0.0.1` and `localhost`
- renderer bearer tokens are kept in memory instead of persistent browser storage
- browser SSE subscriptions no longer put bearer tokens on the event-stream URL
- artifact paths must stay inside the active workspace root
- graph inspection now uses an explicit focus node and `Inspect in Graph` entry points instead of an implicit background selection
- summary refresh is now a first-class action on the node detail surface, with stale-summary cues when curated summaries drift behind body edits
- inferred relations now expand beyond tag/body/activity signals into project-membership and shared-artifact signals
- an Electron desktop shell can now boot the local API, expose stdio MCP through `--mcp-stdio`, and package the built app through `npm run desktop` and `npm run package:desktop`
- the packaged desktop shell can now stay resident in the background, expose a macOS menu bar item, and keep the local API alive after the main window is closed
- default workspace roots now live under `~/.memforge/{workspaceName}`, with legacy repo-local `.memforge-workspace` copied forward when needed

Repository guidance was also tightened so coding agents treat Memforge as the primary durable memory system for this workspace.

## Progress snapshot

- Phase 0 foundation is scaffolded locally with workspace boot, SQLite schema, migrations, and runtime workspace switching.
- Phase 1 UI is in first-pass shape with home, search, review, and settings flows backed by the live local API when available, plus provenance-aware detail views and an explicit graph focus picker.
- Phase 2 retrieval is wired through local search, related-node lookup, decisions/open questions helpers, and compact context bundles.
- Phase 3 external access is live through the loopback HTTP API, the thin `pnw` CLI, and the new service index for self-discovery.
- Phase 4 append-first write-back is live through durable node creation, relation creation, activities, artifacts, provenance, and review-aware governance.
- Phase 5 curation is in place through review queue endpoints, renderer review actions, provenance-friendly detail flows, and summary refresh/staleness visibility.
- Phase 6 real cross-tool adoption now includes documented terminal-native `pnw`, raw HTTP bootstrap, and stdio MCP workflows in addition to the local coding-agent path.
- Phase 7 selective retrieval enhancement now includes deterministic inferred-relation generation from tag/body/activity, project-membership, and shared-artifact signals, plus inferred-relation storage, usage feedback events, explicit/automatic score recompute, and relation-aware ranking; semantic retrieval is still deferred.

## Current status

Memforge has moved past the docs-only stage into a usable implementation scaffold: one local workspace can now be opened by the renderer, served over the loopback API, queried from the CLI, and reached through an MCP bridge without adding a second storage layer.

The project is now beyond the purely local scaffold stage: the desktop shell can boot the local service, the renderer can expose summary staleness and refresh, and the external-tool workflows are documented against the current implementation. The main work now is product polish: distribution hardening, inferred-link tuning, and deciding how much richer digest materialization is actually worth.

## Next focus

- dogfood the packaged desktop shell and add distribution polish such as app icons, signing, and notarization when needed
- tune inferred-relation thresholds, evidence display, and explainability based on real workspace usage
- decide whether richer digest materialization is worth adding beyond the current deterministic summary + stale-cue baseline

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
- In packaged mode, closing the main window now hides Memforge to the background instead of quitting immediately. Use the menu bar item to reopen the app, copy API/MCP info, or restart the local service, and use `Quit Memforge` to fully stop the desktop shell.
- The default workspace root is `~/.memforge/{workspaceName}`. Existing repo-local `.memforge-workspace` data is copied into the new home-directory root the first time the new default is used.

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
Use the returned endpoint list and request examples to search nodes, create notes, inspect review items, build context bundles, and switch workspaces.
Reuse the existing local service instead of starting a new one.
```

## MCP bridge

Memforge now also ships a stdio MCP adapter for coding agents that prefer tool discovery over raw HTTP calls.

Start it against the running local service:

```bash
npm run mcp
```

Or point it at a specific local API:

```bash
node dist/server/app/mcp/index.js --api http://127.0.0.1:8787/api/v1
```

Packaged desktop builds also support stdio MCP directly:

```bash
Memforge --mcp-stdio
```

If you want to bypass the PATH shim, the packaged binary also works directly:

```bash
./Memforge.app/Contents/MacOS/Memforge --mcp-stdio
```

When the packaged app is launched once, it also writes:

- a PATH-friendly desktop shim at `~/.local/bin/Memforge`
- a reusable MCP launcher script at `~/.memforge/bin/memforge-mcp`

For JetBrains AI Assistant / IntelliJ MCP settings, prefer the launcher path and wrap it under `mcpServers`:

```json
{
  "mcpServers": {
    "memforge": {
      "command": "/Users/yourname/.memforge/bin/memforge-mcp",
      "args": []
    }
  }
}
```

Using `Memforge --mcp-stdio` directly can fail in GUI apps when `~/.local/bin` is not present in the inherited `PATH`.

Important environment variables:

- `MEMFORGE_API_URL` — local Memforge API base URL
- `MEMFORGE_API_TOKEN` — bearer token when local auth is enabled
- `MEMFORGE_MCP_SOURCE_LABEL` — default provenance label for writes
- `MEMFORGE_MCP_TOOL_NAME` — default provenance tool name

See `docs/mcp.md` for the first-pass tool list and HTTP-to-MCP mapping.
See `docs/workflows.md` for the non-agent workflows that are already validated in the current implementation.
