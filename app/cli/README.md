# RecallX Headless

## At A Glance

- This package is the npm-distributed headless runtime for RecallX.
- It provides the `recallx` and `recallx-mcp` commands.
- It can start the local RecallX API directly through `recallx serve`.
- It does not include the renderer.

It defers behavior to the local RecallX API contract in [`docs/api.md`](../../docs/api.md).

## What You Get

- `recallx` as the runtime and CLI entrypoint
- `recallx serve` and subcommands for day-to-day workspace and memory operations
- `recallx-mcp` as the direct stdio MCP entrypoint for agent clients

This distribution is for headless workflows. If you want the packaged renderer too, use the `recallx` npm package described in the root [`README.md`](../../README.md).

## Install

```bash
npm install -g recallx-headless
recallx serve
```

In another shell:

```bash
recallx health
recallx update
recallx-mcp --help
recallx mcp install
```

`recallx mcp install` writes the stable launcher path used by Codex and other editor MCP configs:

```text
~/.recallx/bin/recallx-mcp
```

If the API is running in bearer mode, set `RECALLX_API_TOKEN` in the MCP client environment. The launcher intentionally does not persist tokens to disk.

Start the local headless runtime with:

```bash
recallx serve
```

Useful runtime overrides:

```bash
recallx serve --port 8787 --bind 127.0.0.1
recallx serve --workspace-root /Users/name/Documents/RecallX
recallx serve --workspace-name "Personal Workspace"
recallx serve --api-token secret-token
```

To update an npm-installed RecallX runtime from the CLI:

```bash
recallx update
recallx update --apply
```

`recallx update` currently supports npm global installs of `recallx` and `recallx-headless`. Source checkouts should keep using their package manager directly.

The headless package does not ship renderer pages. At `/`, it returns a runtime notice instead of the renderer app.

You can also print the direct MCP command or a config snippet:

```bash
recallx mcp command
recallx mcp config
recallx mcp path
```

## Common Tasks

Quick health and workspace checks:

```bash
recallx health
recallx update
recallx workspace current
recallx workspace list
```

Search and inspect memory:

```bash
recallx search "agent memory" --type project --limit 5
recallx get node_123
recallx related node_123 --depth 1
recallx context node_project_1 --mode compact --preset for-coding --format markdown
```

Write back new information:

```bash
recallx create --type note --title "Idea" --body "..."
recallx append --target node_project_1 --type agent_run_summary --text "Implemented draft"
recallx link node_a node_b supports --status suggested
recallx attach --node node_project_1 --path artifacts/report.md
```

MCP setup helpers:

```bash
recallx mcp install
recallx mcp path
recallx mcp command
recallx mcp config
```

## Commands

```bash
recallx health
recallx update [--apply]
recallx mcp config
recallx mcp install
recallx mcp path
recallx mcp command
recallx search "agent memory" --type project --limit 5
recallx get node_123
recallx related node_123 --depth 1
recallx context node_project_1 --mode compact --preset for-coding --format markdown
recallx create --type note --title "Idea" --body "..."
recallx append --target node_project_1 --type agent_run_summary --text "Implemented draft"
recallx link node_a node_b supports --status suggested
recallx attach --node node_project_1 --path artifacts/report.md
recallx search activities "implemented draft"
recallx search workspace "what changed"
recallx governance issues --states contested,low_confidence
recallx governance show --entity-type node --entity-id node_123
recallx governance recompute --entity-type node --entity-ids node_123
recallx workspace current
recallx workspace list
recallx workspace create --root /Users/name/Documents/RecallX-Test --name "Test Workspace"
recallx workspace open --root /Users/name/Documents/RecallX-Test
```

## Environment

- `RECALLX_API_URL` to override the local API base URL
- `RECALLX_API_TOKEN` to pass a bearer token for CLI requests
- `RECALLX_TOKEN` remains supported as a legacy alias for CLI requests
- `RECALLX_PORT`, `RECALLX_BIND`, `RECALLX_WORKSPACE_ROOT`, `RECALLX_WORKSPACE_NAME`, and `RECALLX_API_TOKEN` are respected by `recallx serve`
- Node 22.13+ is recommended for the headless package

## Notes

- Default API base: `http://127.0.0.1:8787/api/v1`
- `recallx serve` starts the local RecallX API in-process from the installed package
- The CLI stays thin for day-to-day API operations and defers behavior to the HTTP API contract
- `--format json` is useful when scripting, while `--format markdown` is best for `context`
- `workspace open` switches the active workspace in the running local RecallX service without restarting the server
- `recallx-mcp` is the direct stdio MCP entrypoint from the npm package
- See the root [`README.md`](../../README.md) for source-run usage and install paths
- See [`docs/mcp.md`](../../docs/mcp.md) for editor MCP wiring details
