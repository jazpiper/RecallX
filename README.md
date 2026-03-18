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
- `docs/review-brief.md` — concise reviewer guide and open questions

## Current stage

First implementation scaffold is now in place:

- local Node/TypeScript service with SQLite-backed workspace storage
- append-first governance rules and review queue behavior
- loopback HTTP API under `/api/v1`
- thin `pnw` / `memforge` CLI wrapper
- React renderer with 3-pane layout and live API-first data access
- runtime workspace create/open switching without restarting the local service

## Latest update

On 2026-03-18, Memforge gained two new agent-facing entry points on top of the existing local API and CLI:

- a machine-discoverable service index at `GET /api/v1`
- a first-pass stdio MCP bridge under `app/mcp`

The same update also tightened repository guidance so coding agents treat Memforge as the primary durable memory system for this workspace.

## Progress snapshot

- Phase 0 foundation is scaffolded locally with workspace boot, SQLite schema, migrations, and runtime workspace switching.
- Phase 1 UI is in first-pass shape with home, search, review, and settings flows backed by the live local API when available.
- Phase 2 retrieval is wired through local search, related-node lookup, decisions/open questions helpers, and compact context bundles.
- Phase 3 external access is live through the loopback HTTP API, the thin `pnw` CLI, and the new service index for self-discovery.
- Phase 4 append-first write-back is live through durable node creation, relation creation, activities, artifacts, provenance, and review-aware governance.
- Phase 5 curation is partially implemented through review queue endpoints and renderer review actions, but the review UX is still early.
- Phase 6 real cross-tool adoption is now beginning through the first-pass MCP adapter and local coding-agent workflows.

## Current status

Memforge has moved past the docs-only stage into a usable implementation scaffold: one local workspace can now be opened by the renderer, served over the loopback API, queried from the CLI, and reached through an MCP bridge without adding a second storage layer.

The project is still pre-packaging and pre-polish. The main work now is tightening live renderer flows, validating real multi-tool usage, and keeping governance and retrieval behavior sharp as integration surface grows.

## Next focus

- tighten the renderer so live workspace flows feel fully native instead of scaffold-like
- validate the MCP bridge and service index against real Claude Code / Codex style workflows
- keep the project hub docs and implementation progress aligned as the integration layer expands

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
- The project is still an implementation-first scaffold, not yet a packaged desktop app.

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

Important environment variables:

- `MEMFORGE_API_URL` — local Memforge API base URL
- `MEMFORGE_API_TOKEN` — bearer token when local auth is enabled
- `MEMFORGE_MCP_SOURCE_LABEL` — default provenance label for writes
- `MEMFORGE_MCP_TOOL_NAME` — default provenance tool name

See `docs/mcp.md` for the first-pass tool list and HTTP-to-MCP mapping.
