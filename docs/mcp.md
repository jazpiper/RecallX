# Memforge — MCP Bridge

## 1. Goal

Memforge's durable product surface remains:
- local HTTP API
- local CLI
- renderer UI

The MCP server is an adapter layer for coding agents that prefer tool discovery and structured tool calls over raw HTTP prompts.

v1 MCP scope is intentionally narrow:
- stdio transport only
- tools first
- no separate storage layer
- all tool calls proxy the already-running local Memforge HTTP API

This keeps Memforge's real contract in one place while making Claude Code, Codex, and similar tools easier to wire up.

---

## 2. Transport

### v1 recommendation
- stdio only

### Why
- best fit for local process-spawned integrations
- simplest setup for coding tools
- no second network listener to manage
- keeps MCP as a thin bridge, not a competing runtime

Entrypoints:

```bash
npm run mcp
npm run dev:mcp
node dist/server/app/mcp/index.js --api http://127.0.0.1:8787/api/v1
```

Environment:

- `MEMFORGE_API_URL` — target Memforge HTTP API base URL
- `MEMFORGE_API_TOKEN` — optional bearer token for auth-enabled local services
- `MEMFORGE_MCP_SOURCE_LABEL` — default provenance label for writes
- `MEMFORGE_MCP_TOOL_NAME` — default provenance tool name for writes

---

## 3. Architecture

```mermaid
flowchart LR
  Agent["Coding Agent"] -->|"stdio MCP"| Mcp["Memforge MCP Server"]
  Mcp -->|"HTTP JSON"| Api["Memforge Local API"]
  Api --> Repo["Workspace / SQLite / Files"]
```

Rules:
- the MCP server never mutates storage directly
- every durable write still flows through the existing HTTP governance layer
- bearer auth stays enforced by the HTTP API if enabled
- MCP defaults a provenance source when the caller does not provide one

---

## 4. First-pass tool surface

| Tool | Purpose | HTTP mapping |
| --- | --- | --- |
| `memforge_health` | Check local API health | `GET /health` |
| `memforge_workspace_current` | Read current workspace | `GET /workspace` |
| `memforge_workspace_list` | List known workspaces | `GET /workspaces` |
| `memforge_workspace_create` | Create and switch workspace | `POST /workspaces` |
| `memforge_workspace_open` | Switch to existing workspace | `POST /workspaces/open` |
| `memforge_semantic_status` | Read semantic index status and queue counts | `GET /semantic/status` |
| `memforge_semantic_issues` | Read semantic issue details with optional status filters and cursor pagination | `GET /semantic/issues` |
| `memforge_search_nodes` | Search nodes with filters | `POST /nodes/search` |
| `memforge_get_node` | Read node detail bundle | `GET /nodes/:id` |
| `memforge_get_related` | Read canonical plus inferred neighborhood items | `GET /nodes/:id/neighborhood` |
| `memforge_upsert_inferred_relation` | Upsert inferred relation | `POST /inferred-relations` |
| `memforge_append_relation_usage_event` | Append relation usage signal | `POST /relation-usage-events` |
| `memforge_recompute_inferred_relations` | Recompute inferred relation scores | `POST /inferred-relations/recompute` |
| `memforge_append_activity` | Append node activity | `POST /activities` |
| `memforge_create_node` | Create durable node | `POST /nodes` |
| `memforge_create_relation` | Create relation | `POST /relations` |
| `memforge_review_list` | Read review queue | `GET /review-queue` |
| `memforge_review_get` | Read one review item | `GET /review-queue/:id` |
| `memforge_review_decide` | Approve / reject / edit-and-approve | `POST /review-queue/:id/:action` |
| `memforge_context_bundle` | Build compact agent context | `POST /context/bundles` |
| `memforge_rank_candidates` | Rank candidate nodes with relation and semantic request-time signals | `POST /retrieval/rank-candidates` |
| `memforge_semantic_reindex` | Queue workspace semantic reindex | `POST /semantic/reindex` |
| `memforge_semantic_reindex_node` | Queue semantic reindex for one node | `POST /semantic/reindex/:nodeId` |

### Tool design notes

- Read tools are marked read-only/idempotent where possible.
- Durable write tools accept an optional `source` object.
- If `source` is omitted, the MCP bridge fills in its own default agent provenance.
- We do not expose low-level retrieval fragments or settings mutation in the first pass.
- `memforge_get_related` defaults to including inferred relations because that is the most useful shape for downstream LLMs; agents can disable inferred items when they specifically need only canonical links.
- Usage feedback is intentionally a separate write. Do not append a relation usage event for every read; reserve it for cases where a canonical or inferred relation actually helped retrieval or final output.
- Score recomputation is also explicit. Use `memforge_recompute_inferred_relations` in maintenance flows or automations, not in the latency-sensitive request path.

---

## 5. Input schema conventions

### Durable writes

```json
{
  "source": {
    "actorType": "agent",
    "actorLabel": "Claude Code",
    "toolName": "claude-code",
    "toolVersion": "1.0.0"
  }
}
```

The `source` block is optional at the MCP layer but always present by the time the request reaches the Memforge API.

### Context bundle target

The MCP tool simplifies the HTTP payload:

```json
{
  "targetId": "node_...",
  "mode": "compact",
  "preset": "for-coding"
}
```

The bridge expands that to the API's `target: { type, id }` shape.

### Review decisions

`memforge_review_decide` accepts:
- `action`: `approve` | `reject` | `edit-and-approve`
- `notes`
- optional `patch`
- optional `source`

This collapses three HTTP endpoints into one MCP tool because the action is part of the natural agent intent.

---

## 6. Why tools first

Resources and prompts are useful, but tools are the highest-value first step because Memforge is primarily an action-oriented local knowledge service:
- search
- inspect
- create
- relate
- review
- bundle

Future additions can include:
- `memforge://service-index`
- `memforge://workspace/current`
- reusable prompts for "capture note", "triage review queue", and "build coding context"

---

## 7. Suggested agent configuration

Example command:

```text
node /absolute/path/to/Memforge/dist/server/app/mcp/index.js
```

Suggested environment:

```text
MEMFORGE_API_URL=http://127.0.0.1:8787/api/v1
MEMFORGE_API_TOKEN=<optional>
```

Operational expectation:
- reuse the existing running Memforge service
- do not start a second API instance unless the configured one is unavailable
- prefer `memforge_workspace_current` and `memforge_search_nodes` before creating new data
- pass `MEMFORGE_API_TOKEN` directly to the MCP process when bearer auth is enabled; do not rely on renderer/browser token storage

JetBrains AI Assistant / IntelliJ MCP JSON example:

```json
{
  "mcpServers": {
    "memforge": {
      "command": "/Users/yourname/.memforge/bin/memforge-mcp",
      "args": []
    }
  }
}
```

Notes:
- JetBrains expects the top-level `mcpServers` wrapper.
- Prefer the stable launcher path over a bare `Memforge` command because GUI apps do not always inherit your shell `PATH`.
- If the launcher script points at a packaged `Memforge.app`, open the app at least once first so the launcher is created.
