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
- `docs/review-brief.md` — concise reviewer guide and open questions

## Current stage

First implementation scaffold is now in place:

- local Node/TypeScript service with SQLite-backed workspace storage
- append-first governance rules and review queue behavior
- loopback HTTP API under `/api/v1`
- thin `pnw` / `memforge` CLI wrapper
- React renderer with 3-pane layout and live API-first data access
- runtime workspace create/open switching without restarting the local service

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
