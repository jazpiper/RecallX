# Memforge - External Workflows

## At A Glance

- This document covers the main external ways to use Memforge.
- The primary routes are terminal-native workspace management, raw HTTP API usage, and stdio MCP access.
- Use this file as a compact usage guide, then go deeper in `docs/api.md` and `docs/mcp.md` when needed.

## 1. Terminal-native workspace management

Use the `pnw` wrapper to inspect and switch workspaces against the running local service:

- `pnw workspace current`
- `pnw workspace list`
- `pnw workspace create --root /path/to/workspace [--name "Personal"]`
- `pnw workspace open --root /path/to/workspace`

## 2. Raw HTTP client workflow

A non-agent client can bootstrap from health and bootstrap, then use the API directly:

- `GET /api/v1/health`
- `GET /api/v1/bootstrap`
- `GET /api/v1` after auth or in optional mode
- `GET /api/v1/workspace` after auth or in optional mode
- `POST /api/v1/capture`
- `POST /api/v1/nodes/search`
- `POST /api/v1/activities/search`
- `POST /api/v1/search`
- `GET /api/v1/projects/:id/graph`
- `GET /api/v1/governance/issues`
- `GET /api/v1/semantic/status`
- `POST /api/v1/context/bundles`

## 3. Stdio MCP bridge

For agent tooling that prefers structured tool calls, the MCP bridge is available through:

- `npm run mcp`
- `node dist/server/app/mcp/index.js --api http://127.0.0.1:8787/api/v1`
- `memforge-mcp --api http://127.0.0.1:8787/api/v1`
- `~/.memforge/bin/memforge-mcp`

Representative tools:

- `memforge_get_related`
- `memforge_capture_memory`
- `memforge_append_activity`
- `memforge_search_workspace`
- `memforge_list_governance_issues`
- `memforge_get_governance_state`

Operational guidance:

- keep the current workspace as the default MCP scope unless the user explicitly asks to switch workspaces
- use `memforge_search_workspace` for broad mixed recall when the request shape is still unclear
- when calling `memforge_search_workspace`, pass `scopes: ["nodes", "activities"]` for mixed recall instead of a comma-separated string
- use `memforge_search_nodes` for durable-only lookups, especially `type=project` when checking whether a project already exists
- use `memforge_search_activities` for recent logs, change history, and "what happened recently" questions
- when work is clearly project-shaped, search for an existing project inside the current workspace before creating a new project node

## 4. Default workspace root behavior

- The default unmanaged workspace location lives under `~/.memforge/{workspaceName}`.
- `pnw workspace create` and `pnw workspace open` are the supported CLI entrypoints for changing the active workspace.
