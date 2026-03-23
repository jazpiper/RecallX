# RecallX

RecallX is a local-first personal knowledge layer for humans and agents.

It gives your local API, CLI, MCP-capable tools, and source-run UI one durable workspace for shared memory instead of scattering context across prompts, notes, and tool-specific state.

## What It Is For

RecallX is built to keep these things in one local workspace:

- notes
- projects
- ideas
- questions
- decisions
- references
- activities
- relationships between them

The core idea is simple: one brain, many tools.

## Why RecallX

- local-first storage with SQLite-backed workspaces
- shared memory for humans and coding agents
- append-first writes with explicit provenance
- compact context assembly for agent workflows
- HTTP API, CLI, MCP, and source-run UI access over the same local data

## Distribution Paths

RecallX is documented around three public ways to use it:

1. Git public repo for direct source execution
2. npm package `recallx` for the full local runtime
3. npm package `recallx-headless` for the headless runtime

## 1. Git Public Repo

Use the public repo when you want the full source-run surface:

- local API under `/api/v1`
- source-run renderer workflow through `npm run dev`
- source-run desktop workflow through `npm run dev:desktop`
- stdio MCP bridge through `npm run mcp`
- runtime workspace create/open switching without restarting the service

```bash
git clone https://github.com/jazpiper/RecallX.git RecallX
cd RecallX
npm install
npm run dev
```

Desktop runtime from source:

```bash
npm run dev:desktop
```

MCP from source:

```bash
npm run mcp
```

Server only:

```bash
npm run build:server
npm start
```

Checks:

```bash
npm run check
npm test
npm run build
```

If you want an installable runtime instead of source-run workflows, use one of the npm distribution paths below.

## 2. npm Full Runtime (`recallx`)

Use the full npm package when you want a local install that includes the API, renderer, CLI, and MCP entrypoint:

```bash
npm install -g recallx
recallx serve
```

In another shell:

```bash
recallx health
recallx mcp install
recallx-mcp --help
```

The full npm package includes:

- local API under `/api/v1`
- browser renderer served from `/`
- `recallx`
- `recallx serve` and subcommands
- `recallx-mcp`

The full npm package does not include:

- desktop release artifacts

`recallx mcp install` writes a stable launcher to `~/.recallx/bin/recallx-mcp`, which is the recommended command path for Codex and other editor MCP configs.

If the API is running in bearer mode, set `RECALLX_API_TOKEN` in the MCP client environment. The launcher does not write tokens to disk.

Start the packaged runtime with:

```bash
recallx serve
```

Optional runtime overrides:

```bash
recallx serve --port 8787 --bind 127.0.0.1
recallx serve --workspace-root /Users/name/Documents/RecallX
recallx serve --api-token secret-token
```

## 3. npm Headless Runtime (`recallx-headless`)

Use the headless npm package when you want the local API, CLI, and MCP entrypoint without shipping the renderer bundle:

```bash
npm install -g recallx-headless
recallx serve
```

In another shell:

```bash
recallx health
recallx-mcp --help
```

The headless npm package includes:

- local API under `/api/v1`
- `recallx`
- `recallx serve` and subcommands
- `recallx-mcp`

The headless npm package does not include:

- renderer pages
- desktop release artifacts

At `/`, the headless runtime returns a small runtime notice instead of the renderer.

Node requirements:

- npm packages: Node 22.13+
- local source development: Node 25+ is recommended because the backend uses `node:sqlite`

## Use From Other Coding Agents

If you want another coding agent to use a running local RecallX service, start with health and bootstrap first instead of assuming the protected service index is available.

- health check: `GET http://127.0.0.1:8787/api/v1/health`
- bootstrap: `GET http://127.0.0.1:8787/api/v1/bootstrap`
- service index after auth or in optional mode: `GET http://127.0.0.1:8787/api/v1`
- current workspace after auth or in optional mode: `GET http://127.0.0.1:8787/api/v1/workspace`

Recommended instruction:

```text
Use my running local RecallX service at http://127.0.0.1:8787/api/v1.
Start by calling GET /health and GET /bootstrap.
If authMode is bearer, include Authorization: Bearer <token> before calling GET /api/v1 or GET /workspace.
Use the returned endpoint list and request examples to search nodes and activities, inspect governance state, build context bundles, and switch workspaces.
Reuse the existing local service instead of starting a new one.
```

## MCP Bridge

RecallX also ships a stdio MCP adapter for agent clients that prefer tool discovery over raw HTTP calls.

```bash
npm run mcp
node dist/server/app/mcp/index.js --api http://127.0.0.1:8787/api/v1
recallx-mcp --api http://127.0.0.1:8787/api/v1
```

For launcher paths, environment variables, and editor-specific setup, see `docs/mcp.md`.

## Docs

- `docs/README.md` for the full documentation map and reading order
- `app/cli/README.md` for the npm headless package
- `docs/concept.md` for product positioning
- `docs/api.md` for the local HTTP and CLI contract
- `docs/mcp.md` for MCP bridge setup
- `docs/workflows.md` for common usage flows
- `docs/schema.md` for storage and data model details
