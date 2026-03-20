# Memforge - Validated External Workflows

This document captures the external-tool paths that are already supported by the current implementation and documented in the codebase.

The two workflows below are the important non-coding-agent routes. The MCP bridge is still useful, but it is the agent-native path rather than the one this doc is trying to prove out.

## 1. Terminal-native workspace management

Use the `pnw` wrapper to inspect and switch workspaces against the running local service:

- `pnw workspace current`
- `pnw workspace list`
- `pnw workspace create --root /path/to/workspace [--name "Personal"]`
- `pnw workspace open --root /path/to/workspace`

What this proves:

- the running service can manage multiple workspaces without restarting
- the local workspace catalog is visible to external tooling
- workspace switching stays local and loopback-only

Why this is validated:

- the CLI wrapper exposes the commands directly
- the service exposes runtime workspace catalog and open/create endpoints
- the current tests cover the runtime workspace switching behavior

## 2. Raw HTTP client workflow

A non-agent client can bootstrap from the service index and then use the API directly:

- `GET /api/v1`
- `GET /api/v1/health`
- `GET /api/v1/workspace`
- `GET /api/v1/bootstrap`
- `POST /api/v1/capture`
- `POST /api/v1/nodes/search`
- `POST /api/v1/activities/search`
- `POST /api/v1/search`
- `GET /api/v1/governance/issues`
- `POST /api/v1/context/bundles`

What this proves:

- another tool can discover Memforge without a custom SDK
- the local API is self-describing enough to bootstrap a client
- search, governance inspection, and context packaging are all reachable over plain HTTP

Why this is validated:

- the service index is implemented at `GET /api/v1`
- the API contract documents the bootstrap, workspace, search, governance, and bundle endpoints
- browser and non-browser auth behavior is already documented and enforced

## 3. Stdio MCP bridge

For agent tooling that prefers structured tool calls, the MCP bridge is available through:

- `Memforge --mcp-stdio`
- `npm run mcp`
- `node dist/server/app/mcp/index.js --api http://127.0.0.1:8787/api/v1`
- `~/.memforge/bin/memforge-mcp`
- `./Memforge.app/Contents/MacOS/Memforge --mcp-stdio`

Representative tools:

- `memforge_get_related`
- `memforge_capture_memory`
- `memforge_append_activity`
- `memforge_search_workspace`
- `memforge_list_governance_issues`
- `memforge_get_governance_state`

Why this matters:

- it lets coding agents reuse the running local service instead of starting a second store
- it keeps provenance attached to write operations
- it gives agent clients a discoverable tool surface without raw prompt coupling
- the packaged desktop app can now act as the stdio MCP command directly, writes a PATH-friendly `Memforge` shim under `~/.local/bin`, and writes a stable launcher script under `~/.memforge/bin/memforge-mcp`

## 4. Default workspace root behavior

The default unmanaged workspace location now lives under:

- `~/.memforge/{workspaceName}`

For example, this repo currently resolves to:

- `~/.memforge/Memforge`

CLI/server flows may still choose to copy forward a legacy repo-local `.memforge-workspace` when opening an unmanaged workspace for the first time.
The packaged desktop app does not do that migration path and instead stays pinned to the managed home-directory root.

The CLI also accepts:

- `pnw workspace switch --root /path/to/workspace`
