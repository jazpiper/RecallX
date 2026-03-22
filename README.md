# Memforge

Memforge is a local-first personal knowledge layer for humans and agents.

It gives your local API, CLI, MCP-capable tools, and source-run UI one durable workspace for shared memory instead of scattering context across prompts, notes, and tool-specific state.

## What It Is For

Memforge is built to keep these things in one local workspace:

- notes
- projects
- ideas
- questions
- decisions
- references
- activities
- relationships between them

The core idea is simple: one brain, many tools.

## Why Memforge

- local-first storage with SQLite-backed workspaces
- shared memory for humans and coding agents
- append-first writes with explicit provenance
- compact context assembly for agent workflows
- HTTP API, CLI, MCP, and source-run UI access over the same local data

## Distribution Paths

Memforge is documented around two public ways to use it:

1. Git public repo for direct source execution
2. npm package for the terminal-only product

## 1. Git Public Repo

Use the public repo when you want the full source-run surface:

- local API under `/api/v1`
- CLI commands through `memforge` and `pnw`
- stdio MCP bridge through `memforge-mcp`
- renderer and desktop workflows from source
- runtime workspace create/open switching without restarting the service

```bash
git clone https://github.com/jazpiper/Memforge.git
cd Memforge
npm install
npm run dev
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

## 2. npm Terminal-Only Product

Use the npm package when you want terminal-native commands only:

```bash
npm install -g memforge
memforge --help
pnw mcp install
memforge-mcp --help
```

The npm package includes:

- `memforge`
- `pnw`
- `memforge-mcp`

The npm package does not include:

- renderer pages
- desktop release artifacts

`pnw mcp install` writes a stable launcher to `~/.memforge/bin/memforge-mcp`, which is the recommended command path for editor MCP configs.

If the API is running in bearer mode, set `MEMFORGE_API_TOKEN` in the MCP client environment. The launcher does not write tokens to disk.

The terminal-only npm package expects a running local Memforge API. If you want the full source-run product surface, use the Git public repo path above.

Node requirements:

- npm CLI package: Node 20+
- local source development: Node 25+ is recommended because the backend uses `node:sqlite`

## Use From Other Coding Agents

If you want another coding agent to use a running local Memforge service, start with health and bootstrap first instead of assuming the protected service index is available.

- health check: `GET http://127.0.0.1:8787/api/v1/health`
- bootstrap: `GET http://127.0.0.1:8787/api/v1/bootstrap`
- service index after auth or in optional mode: `GET http://127.0.0.1:8787/api/v1`
- current workspace after auth or in optional mode: `GET http://127.0.0.1:8787/api/v1/workspace`

Recommended instruction:

```text
Use my running local Memforge service at http://127.0.0.1:8787/api/v1.
Start by calling GET /health and GET /bootstrap.
If authMode is bearer, include Authorization: Bearer <token> before calling GET /api/v1 or GET /workspace.
Use the returned endpoint list and request examples to search nodes and activities, inspect governance state, build context bundles, and switch workspaces.
Reuse the existing local service instead of starting a new one.
```

## MCP Bridge

Memforge also ships a stdio MCP adapter for agent clients that prefer tool discovery over raw HTTP calls.

```bash
npm run mcp
node dist/server/app/mcp/index.js --api http://127.0.0.1:8787/api/v1
memforge-mcp --api http://127.0.0.1:8787/api/v1
```

For launcher paths, environment variables, and editor-specific setup, see `docs/mcp.md`.

## Docs

- `docs/README.md` for the full documentation map and reading order
- `app/cli/README.md` for the npm terminal-only package
- `docs/concept.md` for product positioning
- `docs/api.md` for the local HTTP and CLI contract
- `docs/mcp.md` for MCP bridge setup
- `docs/workflows.md` for common usage flows
- `docs/schema.md` for storage and data model details
