# Memforge — API Contract

## 1. Purpose

This document defines the first concrete API contract for Memforge.

The API exists to let:
- the desktop UI
- local CLI commands
- external tools and agents

interact with the same local knowledge workspace.

This API should optimize for:
- local-first usage
- speed
- simplicity
- provenance
- append-first writes
- stable integration patterns

It should not try to be a giant universal platform API in v1.

---

## 2. API shape

## Recommended transport
### Primary
- local HTTP API bound to loopback only (`127.0.0.1`)

### Secondary
- local CLI wrapper built on top of the same API

## Data format
- JSON request/response for HTTP
- human-readable text or JSON output for CLI

---

## 3. API design principles

### 1) Small stable surface
Prefer a smaller number of reliable endpoints over a broad, speculative API.

### 2) Fast primitives first
The API should expose cheap retrieval primitives that help scout-stage clients stay fast.

### 3) Append-first writes
Write operations should default to additive behavior rather than destructive mutation.

### 4) Provenance required on durable writes
Every durable write must be attributable.

### 5) Context bundles are a first-class primitive
The API should make it easy to request compact task-shaped bundles.

### 6) Human and tool parity
The UI should use the same core API concepts as external tools wherever practical.

---

## 4. Versioning

## Recommendation
Use explicit API versioning from the start.

### Example
- HTTP base path: `/api/v1/...`
- CLI version stays aligned with app version, but command behavior should map to API v1 semantics

### Why
This keeps future changes safer once multiple integrations exist.

---

## 5. Authentication and local security

## 5.1 Binding
- bind only to `127.0.0.1` by default
- never expose on LAN/public interfaces by default

## 5.2 Auth model
### Current implementation
The local service currently supports two modes:
- no token (`optional`)
- bearer token (`bearer`)

### HTTP example
```http
Authorization: Bearer <local-token>
```

### Public endpoints in bearer mode
The current scaffold keeps these endpoints public even when bearer auth is enabled:
- `GET /api/v1/health`
- `GET /api/v1/workspace`
- `GET /api/v1/bootstrap`
- `GET /api/v1/events` for browser clients on loopback origins only

The machine-readable service index at `GET /api/v1` is still protected in bearer mode.

### Browser origin policy
The local API only accepts browser requests from loopback HTTP origins such as `http://127.0.0.1:*` and `http://localhost:*`.
Requests with non-loopback `Origin` headers are rejected before route handling.

### Renderer token handling
The current renderer keeps bearer tokens in memory only.
That reduces exposure through persistent browser storage, but it also means the token is not retained across page refreshes or renderer restarts.

## 5.3 Access levels
Recommended integration capability levels:
- read-only
- append-only
- governed-write

### v1 recommendation
Default to:
- read-only
- append-only

Avoid broad governed-write by default.

---

## 6. Common request metadata

Some endpoints should support common metadata fields.

## 6.1 Standard source object
For write operations:

```json
{
  "actorType": "agent",
  "actorLabel": "Claude Code",
  "toolName": "claude-code",
  "toolVersion": "1.0.0"
}
```

### Field meanings
- `actorType`: `human` | `agent` | `system` | `import` | `integration`
- `actorLabel`: human-readable source label
- `toolName`: stable tool identifier
- `toolVersion`: optional but recommended

## 6.2 Standard response envelope
Recommended success envelope:

```json
{
  "ok": true,
  "data": { ... },
  "meta": {
    "requestId": "req_...",
    "apiVersion": "v1"
  }
}
```

Recommended error envelope:

```json
{
  "ok": false,
  "error": {
    "code": "INVALID_INPUT",
    "message": "Field 'type' is required"
  },
  "meta": {
    "requestId": "req_...",
    "apiVersion": "v1"
  }
}
```

---

## 7. Resource model

The API centers around these resource groups:

- workspace
- nodes
- relations
- inferred relations
- relation usage events
- activities
- artifacts
- review queue
- context bundles
- integrations
- settings

---

## 8. Health and workspace endpoints

## 8.1 Get service health
### HTTP
`GET /api/v1/health`

### Response
```json
{
  "ok": true,
  "data": {
    "status": "ok",
    "workspaceLoaded": true,
    "workspaceRoot": "/path/to/workspace",
    "schemaVersion": 1
  }
}
```

## 8.2 Get workspace info
### HTTP
`GET /api/v1/workspace`

### Purpose
Returns workspace identity and high-level configuration.

### Response fields
- root path
- schema version
- workspace name
- API bind info (sanitized)
- enabled integration modes

## 8.3 Get service index
### HTTP
`GET /api/v1`

### Purpose
Return a discoverable machine-friendly service index for external coding agents and local automation.

### Should include
- service identity
- current workspace
- auth mode
- major capabilities
- important endpoints
- example request payloads
- CLI examples
- MCP launch hints when a local stdio bridge is available

### Why
This allows another agent to receive one base URL and self-discover how to use Memforge without needing a separate MCP bridge or a human-written prompt for every endpoint.

### Auth note
When bearer auth is enabled, callers should bootstrap from `GET /api/v1/bootstrap` first and then call `GET /api/v1` with the bearer token.

## 8.4 Get bootstrap metadata
### HTTP
`GET /api/v1/bootstrap`

### Purpose
Return safe startup metadata for renderer and local tools.

### Response fields
- workspace info
- auth mode
- auto recompute status for inferred-relation maintenance

## 8.5 List known workspaces
### HTTP
`GET /api/v1/workspaces`

### Purpose
Return the current workspace plus the locally known workspace catalog.

## 8.6 Create and switch workspace
### HTTP
`POST /api/v1/workspaces`

## 8.7 Open existing workspace
### HTTP
`POST /api/v1/workspaces/open`

---

## 9. Node endpoints

## 9.1 Search nodes
### HTTP
`POST /api/v1/nodes/search`

### Purpose
Fast search over nodes using keyword/FTS and structured filters.

### Request
```json
{
  "query": "agent memory",
  "filters": {
    "types": ["project", "idea"],
    "status": ["active"],
    "sourceLabels": ["OpenClaw"],
    "tags": ["memory"]
  },
  "limit": 10,
  "offset": 0,
  "sort": "relevance"
}
```

### Notes
- `query` may be empty when listing by filters only
- `sort` should support at least `relevance` and `updated_at`

### Response
```json
{
  "ok": true,
  "data": {
    "items": [
      {
        "id": "node_1",
        "type": "project",
        "title": "Memforge",
        "summary": "Shared memory layer for humans and agents.",
        "status": "active",
        "sourceLabel": "manual",
        "updatedAt": "2026-03-17T14:00:00Z"
      }
    ],
    "total": 1
  }
}
```

## 9.2 Get node
### HTTP
`GET /api/v1/nodes/:id`

### Purpose
Return full node detail.

### Response should include
- core node fields
- tags
- metadata
- source fields
- timestamps

## 9.3 Create node
### HTTP
`POST /api/v1/nodes`

### Purpose
Create a durable node.

### Request
```json
{
  "type": "note",
  "title": "Agent memory idea",
  "body": "Use a shared local substrate.",
  "tags": ["memory", "agents"],
  "canonicality": "suggested",
  "source": {
    "actorType": "agent",
    "actorLabel": "OpenClaw",
    "toolName": "openclaw"
  },
  "metadata": {
    "projectId": "node_project_1"
  }
}
```

### Rules
- provenance event required
- if write source is external tool, default canonicality should usually be `appended` or `suggested`

## 9.4 Update node
### HTTP
`PATCH /api/v1/nodes/:id`

### Purpose
Update mutable node fields.

### Recommendation
Restrict in v1 to:
- title
- body
- tags
- status
- summary
- metadata

### Important note
High-trust or governed-write only for canonical changes.

### Request note
The current implementation expects a `source` object on this durable write so the update is attributable in provenance.

## 9.5 Archive node
### HTTP
`POST /api/v1/nodes/:id/archive`

### Purpose
Archive without hard deletion.

### Request
```json
{
  "source": {
    "actorType": "human",
    "actorLabel": "juhwan",
    "toolName": "pnw-desktop"
  }
}
```

---

## 10. Relation endpoints

## 10.1 List related nodes
### HTTP
`GET /api/v1/nodes/:id/related?depth=1&types=related_to,supports`

### Purpose
Return local graph neighborhood.

### Notes
- depth should default to 1
- keep depth limited in hot path

## 10.2 Create relation
### HTTP
`POST /api/v1/relations`

### Request
```json
{
  "fromNodeId": "node_a",
  "toNodeId": "node_b",
  "relationType": "supports",
  "status": "suggested",
  "source": {
    "actorType": "agent",
    "actorLabel": "Claude Code",
    "toolName": "claude-code"
  }
}
```

### Recommendation
For external tools, default relation status to `suggested` unless explicitly trusted.

## 10.3 Update relation status
### HTTP
`PATCH /api/v1/relations/:id`

### Typical uses
- approve suggested relation
- reject suggested relation
- archive stale relation

## 10.4 Upsert inferred relation
### HTTP
`POST /api/v1/inferred-relations`

### Purpose
Store or refresh a rebuildable weighted relation outside the canonical review path.

## 10.5 Append relation usage event
### HTTP
`POST /api/v1/relation-usage-events`

### Purpose
Append a lightweight signal that a canonical or inferred relation actually helped retrieval or final output.

### Notes
- this is append-only
- usage events may trigger debounced auto-recompute of inferred relation scores
- this endpoint is for meaningful feedback, not every read

---

## 11. Activity endpoints

## 11.1 List activities for node
### HTTP
`GET /api/v1/nodes/:id/activities?limit=20`

## 11.2 Append activity
### HTTP
`POST /api/v1/activities`

### Purpose
Append a timeline event tied to a node.

### Request
```json
{
  "targetNodeId": "node_project_1",
  "activityType": "agent_run_summary",
  "body": "Codex explored schema trade-offs and suggested append-first writes.",
  "source": {
    "actorType": "agent",
    "actorLabel": "Codex",
    "toolName": "codex"
  },
  "metadata": {
    "runId": "run_123"
  }
}
```

### Rules
- append-only by default
- activity edits should be rare and not part of normal external flow

---

## 12. Artifact endpoints

## 12.1 Attach artifact metadata
### HTTP
`POST /api/v1/artifacts`

### Purpose
Register a local file as an artifact attached to a node.

### Request
```json
{
  "nodeId": "node_project_1",
  "path": "artifacts/reports/schema-review.md",
  "mimeType": "text/markdown",
  "source": {
    "actorType": "agent",
    "actorLabel": "Claude Code",
    "toolName": "claude-code"
  },
  "metadata": {
    "kind": "report"
  }
}
```

### Notes
- artifact paths must resolve inside the active workspace root
- API validates path existence before registration
- file contents remain in filesystem, not in DB blob form by default

## 12.2 List artifacts for node
### HTTP
`GET /api/v1/nodes/:id/artifacts`

---

## 13. Summary and digest endpoints

These endpoints exist mainly to support fast scout-stage retrieval.

## 13.1 Get node summaries
### HTTP
`POST /api/v1/retrieval/node-summaries`

### Request
```json
{
  "nodeIds": ["node_1", "node_2", "node_3"]
}
```

### Response
Returns compact summary objects only.

## 13.2 Get recent activity digest
### HTTP
`GET /api/v1/retrieval/activity-digest/:targetId`

### Purpose
Return a compressed recent activity view for a node or project.

## 13.3 Get decision set
### HTTP
`GET /api/v1/retrieval/decisions/:targetId`

### Purpose
Return important linked decisions for a target.

## 13.4 Get open questions
### HTTP
`GET /api/v1/retrieval/open-questions/:targetId`

### Purpose
Return unresolved question nodes associated with a target.

## 13.5 Rank candidates
### HTTP
`POST /api/v1/retrieval/rank-candidates`

### Purpose
Optional scout-stage ranking primitive.

### Request
```json
{
  "query": "context for coding agent integration",
  "candidateNodeIds": ["node_a", "node_b", "node_c"],
  "preset": "for-coding"
}
```

### Note
In earliest versions, this can be deterministic only.
No model dependence required.

---

## 14. Context bundle endpoints

Context bundles are a core primitive.

## 14.1 Build context bundle
### HTTP
`POST /api/v1/context/bundles`

### Request
```json
{
  "target": {
    "type": "project",
    "id": "node_project_1"
  },
  "mode": "compact",
  "preset": "for-coding",
  "options": {
    "includeRelated": true,
    "includeInferred": true,
    "includeRecentActivities": true,
    "includeDecisions": true,
    "includeOpenQuestions": true,
    "maxInferred": 4,
    "maxItems": 12
  }
}
```

### Mode values
- `micro`
- `compact`
- `standard`
- `deep`

### Preset values
- `for-coding`
- `for-research`
- `for-decision`
- `for-writing`
- `for-assistant`

### Response shape
```json
{
  "ok": true,
  "data": {
    "bundle": {
      "target": {
        "type": "project",
        "id": "node_project_1",
        "title": "Memforge"
      },
      "mode": "compact",
      "preset": "for-coding",
      "summary": "Local-first knowledge layer for humans and agents.",
      "items": [
        {
          "nodeId": "node_decision_1",
          "type": "decision",
          "title": "Use SQLite as canonical store",
          "summary": "Chosen for portability and local-first durability.",
          "reason": "Inferred via supports (score 0.82)",
          "relationType": "supports",
          "relationSource": "inferred",
          "relationStatus": "active",
          "relationScore": 0.82,
          "generator": "deterministic-linker"
        }
      ],
      "sources": [
        {
          "nodeId": "node_decision_1",
          "sourceLabel": "manual"
        }
      ]
    }
  }
}
```

## 14.2 Preview context bundle
### Optional HTTP
`POST /api/v1/context/bundles/preview`

### Purpose
Useful for UI before export/handoff.

## 14.3 Export context bundle
### Optional HTTP
`POST /api/v1/context/bundles/export`

### Output formats
- json
- markdown
- text

## 14.4 Recompute inferred relation scores
### HTTP
`POST /api/v1/inferred-relations/recompute`

### Purpose
Run an explicit maintenance pass that aggregates `relation_usage_events` back into `inferred_relations.usage_score` and `final_score`.

### Request
```json
{
  "generator": "deterministic-linker",
  "limit": 100
}
```

### Notes
- this endpoint is maintenance-oriented, not part of the hot path
- it should be called on demand, from automations, or from explicit rebuild flows
- read-time retrieval may still apply lightweight usage-aware ranking before this maintenance pass runs

## 14.5 Reindex deterministic inferred relations
### HTTP
`POST /api/v1/inferred-relations/reindex`

### Purpose
Backfill or refresh automatically generated inferred relations across the active workspace.

### Request
```json
{
  "limit": 250
}
```

### Notes
- this runs the cheap deterministic generator across existing active/review nodes
- the current generator uses tag overlap, explicit body/title references, and activity-body references
- this is the endpoint to run when older workspace content should appear in graph/retrieval without waiting for fresh writes

---

## 15. Review queue endpoints

## 15.1 List review items
### HTTP
`GET /api/v1/review-queue?status=pending&limit=20`

## 15.2 Get review item detail
### HTTP
`GET /api/v1/review-queue/:id`

## 15.3 Approve review item
### HTTP
`POST /api/v1/review-queue/:id/approve`

### Request
```json
{
  "source": {
    "actorType": "human",
    "actorLabel": "juhwan",
    "toolName": "pnw-desktop"
  },
  "notes": "Looks good"
}
```

## 15.4 Reject review item
### HTTP
`POST /api/v1/review-queue/:id/reject`

## 15.5 Edit then approve
### HTTP
`POST /api/v1/review-queue/:id/edit-and-approve`

### Purpose
Supports human curation without losing provenance.

---

## 16. Integration endpoints

## 16.1 List integrations
### HTTP
`GET /api/v1/integrations`

## 16.2 Register integration
### HTTP
`POST /api/v1/integrations`

### Request
```json
{
  "name": "Claude Code",
  "kind": "claude_code",
  "capabilities": ["read_search", "get_context_bundle", "append_activity"],
  "config": {
    "mode": "append-only"
  }
}
```

## 16.3 Update integration
### HTTP
`PATCH /api/v1/integrations/:id`

## 16.4 Rotate token / disable integration
May be separate actions or integrated into PATCH depending on implementation.

---

## 17. Workspace event stream

## 17.1 Subscribe to workspace updates
### HTTP
`GET /api/v1/events`

### Behavior
Provides a Server-Sent Events stream for lightweight workspace update notifications.

- Event name: `workspace.updated`
- Payload fields:
  - `type`
  - `reason`
  - `entityType`
  - `entityId`
  - `workspaceRoot`
  - `at`
- Intended use:
  - keep `Recent` and similar live surfaces responsive without background polling
  - react to writes such as node creation, activity append, review action, settings changes, or workspace switching
- Auth:
  - non-browser clients in bearer mode should still send the normal `Authorization: Bearer ...` header
  - browser `EventSource` clients connect without query-string tokens and are accepted only from loopback origins
  - renderer/browser reconnects may require re-entering the bearer token after a refresh because the renderer does not persist it

### Example event
```text
event: workspace.updated
data: {"type":"workspace.updated","reason":"activity.appended","entityType":"activity","entityId":"act_123","workspaceRoot":"/Users/name/Documents/Memforge","at":"2026-03-18T07:20:00.000Z"}
```

---

## 18. Settings endpoints

## 18.1 Get settings subset
### HTTP
`GET /api/v1/settings?keys=workspace.name,search.semantic.enabled`

## 18.2 Update settings subset
### HTTP
`PATCH /api/v1/settings`

### Important note
Keep settings patchable in small subsets.
Avoid giant replace-whole-config behavior.

Useful review-related settings:
- `review.autoApproveLowRisk`: boolean toggle for letting low-risk agent-authored nodes bypass review
- `review.trustedSourceToolNames`: array of trusted agent `toolName` values that may bypass review for agent-authored notes, decisions, and default relations to `active`

---

## 19. CLI contract

The CLI should be a thin ergonomic layer over the API.

## 19.1 Core commands
- `pnw health`
- `pnw search <query>`
- `pnw get <node-id>`
- `pnw related <node-id>`
- `pnw context <target-id>`
- `pnw create`
- `pnw append`
- `pnw link`
- `pnw attach`
- `pnw review list`
- `pnw review show <id>`
- `pnw review approve <id>`
- `pnw review reject <id>`
- `pnw review edit-and-approve <id>`
- `pnw workspace current`
- `pnw workspace list`
- `pnw workspace create`
- `pnw workspace open`

## 19.2 CLI examples
### Search
```bash
pnw search "agent memory" --type project --limit 5
```

### Build context bundle
```bash
pnw context node_project_1 --mode compact --preset for-coding --format markdown
```

### Append activity
```bash
pnw append node_project_1 \
  --type agent_run_summary \
  --source codex \
  --text "Implemented schema draft and wrote migration notes"
```

### Link nodes
```bash
pnw link node_a node_b supports --source claude-code --status suggested
```

---

## 19. Error handling

## Recommended error codes
- `INVALID_INPUT`
- `NOT_FOUND`
- `UNAUTHORIZED`
- `FORBIDDEN`
- `CONFLICT`
- `RATE_LIMITED` (optional for local protection)
- `INTEGRATION_DISABLED`
- `WORKSPACE_NOT_LOADED`
- `INTERNAL_ERROR`

## Error handling principles
- return precise messages
- do not leak unnecessary local secrets
- validate enum and field errors clearly
- make CLI errors human-readable

---

## 20. Provenance requirements

These operations currently create provenance events:
- create node
- archive node
- create relation
- update relation status
- append activity
- attach artifact
- approve/reject review item

### Provenance minimum fields
- entity type
- entity id
- operation type
- actor type
- actor label
- tool name if available
- timestamp

This is not optional in v1.

---

## 21. Hot path performance expectations

The API should protect the hot path.

### Hot path endpoints
- search
- get node summaries
- list related nodes
- get recent activity digest
- get open questions
- get decision set
- build compact context bundle

### Hot path guidance
- should not require LLM access
- should avoid deep graph traversal
- should prefer summary-first payloads
- should return compact responses by default

### Key principle
The API should help scout-stage clients stay fast.

---

## 22. What to defer from the API

Do not overbuild the first contract with:
- bulk workflow orchestration
- remote multi-user auth systems
- giant query DSLs
- complex graph traversal languages
- plugin-defined endpoint surfaces
- mandatory semantic ranking endpoints

Add these only if real integration pressure justifies them.

---

## 23. Suggested implementation order

1. health + workspace endpoints
2. node CRUD + search
3. relation + activity endpoints
4. retrieval summary/digest endpoints
5. context bundle endpoint
6. CLI wrapper
7. review queue endpoints
8. integrations/settings endpoints

This keeps the API practical and aligned with the build plan.

---

## 24. Summary

The right v1 API for Memforge is:
- local-only by default
- small but expressive
- retrieval-first
- append-first
- provenance-aware
- friendly to scout-stage and main-agent workflows

If it stays disciplined, it will be easy to integrate with many tools without becoming a bloated platform surface.
