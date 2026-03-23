# RecallX - External Workflows

## At A Glance

- This document covers the main external ways to use RecallX.
- The primary routes are terminal-native workspace management, raw HTTP API usage, and stdio MCP access.
- Use this file as a compact usage guide, then go deeper in `docs/api.md` and `docs/mcp.md` when needed.

## 1. Terminal-native workspace management

Use the `recallx` wrapper to inspect and switch workspaces against the running local service:

- `recallx workspace current`
- `recallx workspace list`
- `recallx workspace create --root /path/to/workspace [--name "Personal"]`
- `recallx workspace open --root /path/to/workspace`

## 1a. Repo branch hygiene

Use the repo helpers before starting unrelated work:

- `npm run branch:check`
- `npm run branch:new -- <short-task-name>`

Recommended flow:

- run `npm run branch:check` in the current checkout
- if it reports a dirty tree, open PR, or existing task branch, do not keep working there
- create a fresh worktree from `origin/main` with `npm run branch:new -- fix-short-name`
- do the new task in the created sibling checkout instead of stacking commits on the current branch

Versioning flow for releases:

- run `npm run version:check`
- this compares the local package versions against `origin/main`, npm latest, and internal version files
- when you are ready to release, run `npm run version:bump -- patch|minor|major`
- the bump script advances from the highest known baseline and then syncs internal package/version files

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
- `recallx-mcp --api http://127.0.0.1:8787/api/v1`
- `~/.recallx/bin/recallx-mcp`

Representative tools:

- `recallx_get_related`
- `recallx_capture_memory`
- `recallx_append_activity`
- `recallx_search_workspace`
- `recallx_list_governance_issues`
- `recallx_get_governance_state`

Operational guidance:

- keep the current workspace as the default MCP scope unless the user explicitly asks to switch workspaces
- use `recallx_search_workspace` for broad mixed recall when the request shape is still unclear
- when calling `recallx_search_workspace`, pass `scopes: ["nodes", "activities"]` for mixed recall instead of a comma-separated string
- use `recallx_search_nodes` for durable-only lookups, especially `type=project` when checking whether a project already exists
- use `recallx_search_activities` for recent logs, change history, and "what happened recently" questions
- when work is clearly project-shaped, search for an existing project inside the current workspace before creating a new project node

## 4. Default workspace root behavior

- The default unmanaged workspace location lives under `~/.recallx/{workspaceName}`.
- `recallx workspace create` and `recallx workspace open` are the supported CLI entrypoints for changing the active workspace.
