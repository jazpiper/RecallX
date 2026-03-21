# Memforge CLI

Public CLI and MCP entrypoint for Memforge.

This package is the npm-distributed command surface for:

- `memforge`
- `pnw`
- `memforge-mcp`

It stays intentionally thin and defers behavior to the local Memforge API contract in [`docs/api.md`](../../docs/api.md).

## Install

```bash
npm install -g memforge
memforge --help
memforge-mcp --help
pnw mcp install
```

`pnw mcp install` writes the stable launcher path used by editor MCP configs:

```text
~/.memforge/bin/memforge-mcp
```

You can also print the direct MCP command or a config snippet:

```bash
pnw mcp command
pnw mcp config
pnw mcp path
```

## Commands

```bash
pnw health
pnw mcp config
pnw mcp install
pnw mcp path
pnw mcp command
pnw search "agent memory" --type project --limit 5
pnw get node_123
pnw related node_123 --depth 1
pnw context node_project_1 --mode compact --preset for-coding --format markdown
pnw create --type note --title "Idea" --body "..."
pnw append --target node_project_1 --type agent_run_summary --text "Implemented draft"
pnw link node_a node_b supports --status suggested
pnw attach --node node_project_1 --path artifacts/report.md
pnw search activities "implemented draft"
pnw search workspace "what changed"
pnw governance issues --states contested,low_confidence
pnw governance show --entity-type node --entity-id node_123
pnw governance recompute --entity-type node --entity-ids node_123
pnw workspace current
pnw workspace list
pnw workspace create --root /Users/name/Documents/Memforge-Test --name "Test Workspace"
pnw workspace open --root /Users/name/Documents/Memforge-Test
```

## Environment

- `MEMFORGE_API_URL` or `PNW_API_URL` to override the local API base URL
- `MEMFORGE_TOKEN` or `PNW_TOKEN` to pass a bearer token
- Node 20+ is recommended for the CLI package

## Notes

- Default API base: `http://127.0.0.1:8787/api/v1`
- The CLI is intentionally thin and defers behavior to the HTTP API contract
- `--format json` is useful when scripting, while `--format markdown` is best for `context`
- `workspace open` switches the active workspace in the running local Memforge service without restarting the server
- `memforge-mcp` is the direct stdio MCP entrypoint from the npm package
