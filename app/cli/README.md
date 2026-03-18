# Memforge CLI

Thin local wrapper around the Memforge API contract in `docs/api.md`.

## Commands

```bash
pnw health
pnw search "agent memory" --type project --limit 5
pnw get node_123
pnw related node_123 --depth 1
pnw context node_project_1 --mode compact --preset for-coding --format markdown
pnw create --type note --title "Idea" --body "..."
pnw append --target node_project_1 --type agent_run_summary --text "Implemented draft"
pnw link node_a node_b supports --status suggested
pnw attach --node node_project_1 --path artifacts/report.md
pnw review list --status pending
pnw review approve review_123
pnw review reject review_123
pnw workspace current
pnw workspace list
pnw workspace create --root /Users/name/Documents/Memforge-Test --name "Test Workspace"
pnw workspace open --root /Users/name/Documents/Memforge-Test
```

## Environment

- `MEMFORGE_API_URL` or `PNW_API_URL` to override the local API base URL
- `MEMFORGE_TOKEN` or `PNW_TOKEN` to pass a bearer token

## Notes

- Default API base: `http://127.0.0.1:8787/api/v1`
- The CLI is intentionally thin and defers behavior to the HTTP API contract
- `--format json` is useful when scripting, while `--format markdown` is best for `context`
- `workspace open` switches the active workspace in the running local Memforge service without restarting the server
