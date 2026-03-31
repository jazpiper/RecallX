# RecallX — API Contract

## At A Glance

- RecallX exposes one local HTTP API for the local UI, CLI, and external agent tools.
- The current base path is `/api/v1`.
- The most important bootstrap endpoints are `GET /api/v1/health` and `GET /api/v1/bootstrap`.
- `GET /api/v1` and `GET /api/v1/workspace` are available after auth or in optional mode.
- Durable writes are append-first and provenance-aware.
- MCP and CLI behavior should map back to this API instead of introducing a second contract.

## 1. Purpose

This document defines the first concrete API contract for RecallX.

The API exists to let:
- the local UI
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
The current implementation keeps these endpoints public even when bearer auth is enabled:
- `GET /api/v1/health`
- `GET /api/v1/bootstrap`

The machine-readable service index at `GET /api/v1` is still protected in bearer mode.
`GET /api/v1/workspace` and `GET /api/v1/events` require a bearer token in bearer mode.

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
- project graphs
- inferred relations
- relation usage events
- activities
- artifacts
- governance
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
    "schemaVersion": 1,
    "autoRecompute": {},
    "autoRefresh": {},
    "autoSemanticIndex": {},
    "semantic": {}
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
This allows another agent to receive one base URL and self-discover how to use RecallX without needing a separate MCP bridge or a human-written prompt for every endpoint.

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
- auto refresh status for deterministic inferred-link generation
- auto semantic index status for background chunk or embedding work
- current semantic sidecar summary

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
- browse-style empty-query results include `matchReason: { strategy: "browse", matchedFields: [] }`

### Response
```json
{
  "ok": true,
  "data": {
    "items": [
      {
        "id": "node_1",
        "type": "project",
        "title": "RecallX",
        "summary": "Shared memory layer for humans and agents.",
        "status": "active",
        "sourceLabel": "manual",
        "updatedAt": "2026-03-17T14:00:00Z",
        "matchReason": {
          "strategy": "fts",
          "matchedFields": ["title"]
        }
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
- response includes `landing` with `storedAs`, `canonicality` when applicable, `status`, `governanceState`, and `reason`

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

## 9.4a Refresh node summary
### HTTP
`POST /api/v1/nodes/:id/refresh-summary`

### Purpose
Recompute a node summary on demand using the current cheap local summary helper.

### Notes
- this is an explicit maintenance action, not a background job
- the endpoint returns the updated node payload after the summary is refreshed
- this supports the renderer `Refresh summary` action without introducing heavyweight summary pipelines

## 9.5 Create nodes in batch
### HTTP
`POST /api/v1/nodes/batch`

### Purpose
Create multiple durable nodes in one request while preserving per-item governance and landing details.

### Request
```json
{
  "nodes": [
    {
      "type": "note",
      "title": "Batch memory one",
      "body": "Use workspace search first when the target node is unknown.",
      "summary": "Mixed search should be the default entry point.",
      "tags": ["search"],
      "source": {
        "actorType": "agent",
        "actorLabel": "OpenClaw",
        "toolName": "openclaw"
      },
      "metadata": {}
    }
  ]
}
```

### Behavior
- accepts between 1 and 100 node inputs
- applies the same automatic-governance policy used by `POST /api/v1/nodes`
- allows partial success; one rejected item does not roll back successful siblings
- returns HTTP `201` when every item succeeds
- returns HTTP `207` when the batch contains a mix of successes and item-level errors

### Response shape
- `items[]` contains one entry per input in the original order
- success entries include `ok: true`, `index`, `node`, `governance`, and `landing`
- error entries include `ok: false`, `index`, and an `error` object with `code`, `message`, and optional `details`
- `summary` includes `requestedCount`, `successCount`, and `errorCount`

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
    "toolName": "recallx-ui"
  }
}
```

## 9.6 Manual governance action for node
### HTTP
`POST /api/v1/nodes/:id/governance-action`

### Purpose
Apply a compact human governance decision to a node without opening a separate review queue.

### Request
```json
{
  "action": "promote",
  "note": "Reviewed after import cleanup.",
  "source": {
    "actorType": "human",
    "actorLabel": "juhwan",
    "toolName": "recallx-ui"
  }
}
```

### Notes
- supported actions are `promote`, `contest`, and `archive`
- the endpoint records provenance for the node mutation
- the endpoint appends a `review_action` activity so the decision stays visible in node history
- the endpoint appends a governance event and returns the updated governance payload
- this is a lightweight renderer-facing trust control, not a general moderation workflow

---

## 10. Relation endpoints

## 10.1 List node neighborhood
### HTTP
`GET /api/v1/nodes/:id/neighborhood?depth=1&types=related_to,supports`

### Purpose
Return local graph neighborhood.

### Notes
- `GET /api/v1/nodes/:id/related` remains as a legacy compatibility alias over the same neighborhood implementation
- depth should default to 1
- keep depth limited in hot path

## 10.1a Get project graph
### HTTP
`GET /api/v1/projects/:id/graph?include_inferred=1&max_inferred=60&member_limit=120&activity_limit=200`

### Purpose
Return a bounded project-scoped graph payload for the renderer project-map view.

### Query parameters
- `include_inferred` — defaults to `true`
- `max_inferred` — clamped to `0..200`
- `member_limit` — clamped to `1..300`
- `activity_limit` — clamped to `0..400`

### Response fields
- `nodes[]`
  - `id`
  - `title`
  - `type`
  - `status`
  - `canonicality`
  - `summary`
  - `createdAt`
  - `updatedAt`
  - `degree`
  - `isFocus`
  - `projectRole`
- `edges[]`
  - `id`
  - `source`
  - `target`
  - `relationType`
  - `relationSource`
  - `status`
  - `score`
  - `generator`
  - `createdAt`
  - `evidence`
- `timeline[]`
  - `id`
  - `kind`
  - `at`
  - `nodeId`
  - `edgeId`
  - `label`
- `meta.focusProjectId`
- `meta.nodeCount`
- `meta.edgeCount`
- `meta.inferredEdgeCount`
- `meta.timeRange.start`
- `meta.timeRange.end`

### Notes
- membership is project-bounded and intentionally capped
- inferred edges are optional and bounded
- an empty project may receive a tiny inferred fallback seed set so the renderer still has exploratory context
- this endpoint is for project inspection, not for global graph traversal

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

### Response note
- response includes `landing` with `storedAs`, `status`, `governanceState`, and `reason`

## 10.3 Update relation status
### HTTP
`PATCH /api/v1/relations/:id`

### Typical uses
- archive stale relation
- accept explicit human-authored relation edits

## 10.4 Upsert inferred relation
### HTTP
`POST /api/v1/inferred-relations`

### Purpose
Store or refresh a rebuildable weighted relation outside the canonical durable graph path.

## 10.5 Append relation usage event
### HTTP
`POST /api/v1/relation-usage-events`

### Purpose
Append a lightweight signal that a canonical or inferred relation actually helped retrieval or final output.

### Notes
- this is append-only
- usage events may trigger debounced auto-recompute of inferred relation scores
- this endpoint is for meaningful feedback, not every read

## 10.6 Append search feedback event
### HTTP
`POST /api/v1/search-feedback-events`

### Purpose
Append usefulness feedback for a node or activity result after it actually helped a task or answer.

### Notes
- feedback is a ranking and governance signal, not a truth assertion
- negative feedback can help demote or contest noisy results

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

## 11.3 Search activities
### HTTP
`POST /api/v1/activities/search`

### Purpose
Search operational history without mixing it into durable-node retrieval.

### Request
```json
{
  "query": "cleanup",
  "filters": {
    "activityTypes": ["agent_run_summary"]
  },
  "limit": 10,
  "offset": 0,
  "sort": "relevance"
}
```

### Notes
- uses activity FTS first when available
- falls back to bounded `LIKE` matching for empty queries or compatibility cases
- result payload includes target node summary fields for display and reranking
- each result includes `matchReason` with `strategy` and `matchedFields`

## 11.4 Search workspace
### HTTP
`POST /api/v1/search`

### Purpose
Search nodes and activities together through one agent-friendly entry point.

### Request
```json
{
  "query": "what changed",
  "scopes": ["nodes", "activities"],
  "limit": 10,
  "offset": 0,
  "sort": "smart"
}
```

### Notes
- deterministic lexical quality still dominates ranking
- `smart` is the recommended mixed-search sort because it combines source-local ranking with recency and contested penalties
- activity results are capped per target node to avoid timeline spam
- if an initial multi-token mixed search returns zero results, the server may retry with bounded token fallback and mark those results with `matchReason.strategy = "fallback_token"`
- when `search.semantic.workspaceFallback.enabled=true`, `scopes` includes `nodes`, and `search.semantic.workspaceFallback.mode=strict_zero`, the server may do one bounded semantic retry only after deterministic search plus token fallback still return `0` items
- when `search.semantic.workspaceFallback.enabled=true`, `scopes` includes `nodes`, and `search.semantic.workspaceFallback.mode=no_strong_node_hit`, the server may do one bounded semantic retry when there is no strong lexical node hit; weak lexical node hits are preserved and merged with recovered semantic node results

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
The default path stays deterministic-first.
When semantic indexing is enabled and there is no strong exact lexical candidate match, the endpoint may add a bounded semantic bonus from the configured local vector-index backend (`sqlite-vec` when loaded, otherwise `sqlite`).
The current request-time tuning knobs are:
- `search.semantic.augmentation.minSimilarity` with a default of `0.2`
- `search.semantic.augmentation.maxBonus` with a default of `18`

### Response note
- `score` remains for compatibility
- `retrievalRank` is the request-time ranking value
- `score` and `retrievalRank` currently carry the same number for this endpoint
- relation-derived ranking is folded into the request-time rank; persisted `inferred_relations.final_score` is not renamed here
- `semanticSimilarity` is optional and only appears when semantic augmentation contributed to the request-time rank

### Example response
```json
{
  "ok": true,
  "requestId": "req_01",
  "data": {
    "items": [
      {
        "nodeId": "node_b",
        "title": "Candidate node",
        "score": 118.4,
        "retrievalRank": 118.4,
        "relationSource": "inferred",
        "relationType": "supports",
        "relationScore": 0.82,
        "semanticSimilarity": 0.41,
        "reason": "Inferred via supports (score 0.82), usage +0.06; Semantic similarity 0.41 via local-ngram across 1 chunk"
      }
    ]
  }
}
```

---

## 14. Context bundle endpoints

Context bundles are a core primitive.

## 14.1 Build context bundle
### HTTP
`POST /api/v1/context/bundles`

### Request
```json
{
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

`target` is optional. When omitted, the server builds a workspace-entry bundle instead of a node-anchored bundle.

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

### Notes
- deterministic related-context signals still rank first
- when semantic indexing is enabled and target text does not already have a strong lexical candidate match, bundle ordering may add a bounded semantic bonus from the active local vector-index backend
- `semanticSimilarity` is optional and only appears on items that benefited from that bonus
- `relationId` is optional and only appears on relation-backed bundle items so UI and agents can attribute follow-up usage signals precisely

### Response shape
```json
{
  "ok": true,
  "data": {
    "bundle": {
      "target": {
        "type": "workspace",
        "id": "workspace",
        "title": "Workspace context"
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
          "retrievalRank": 0.89,
          "semanticSimilarity": 0.31,
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
- this runs the cheap deterministic generator across existing active/contested nodes
- the current generator uses tag overlap, explicit body/title references, and activity-body references
- this is the endpoint to run when older workspace content should appear in graph/retrieval without waiting for fresh writes

---

## 15. Governance endpoints

### Recent manual pattern
- node governance actions use `POST /api/v1/nodes/:id/governance-action`
- relation governance actions use `POST /api/v1/relations/:id/governance-action`
- `GET /api/v1/governance/events` returns recent manual governance decisions across entities for renderer recall surfaces
- all three endpoints return enough governance context for the renderer to refresh trust state in place

### Relation governance action
`POST /api/v1/relations/:id/governance-action`

Purpose:
- apply a compact human trust decision to a surfaced relation issue

Supported actions:
- `accept`
- `reject`
- `archive`

Notes:
- this is separate from generic relation PATCH because the intent is a stable human governance decision, not only a raw status mutation
- the endpoint records provenance and appends a governance event with the optional decision note
- the endpoint returns the updated relation plus relation governance payload for immediate renderer refresh

### Relation detail
`GET /api/v1/relations/:id`

Purpose:
- fetch a relation together with its source node, target node, and governance history so Governance can show context without a dedicated relation page

## 15.1 List governance issues
### HTTP
`GET /api/v1/governance/issues?state=contested&limit=20`

### Query parameters
- `state` — optional `healthy` | `low_confidence` | `contested`
- `entityType` — optional `node` | `relation`
- `limit`

### Purpose
Return the surfaced automatic-governance issues without exposing a manual review queue.

## 15.2 List recent governance decisions
### HTTP
`GET /api/v1/governance/events?entity_types=node,relation&actions=promote,reject&limit=12`

### Query parameters
- `entity_types` — optional `node` | `relation`, comma-separated
- `actions` — optional `promote` | `contest` | `archive` | `accept` | `reject`, comma-separated
- `limit`

### Purpose
Return a compact recent feed of manual governance decisions across nodes and relations.

### Notes
- this endpoint is intentionally limited to manual governance actions, not every automatic evaluation event
- node items include `nodeId` for note-detail jump-back
- relation items include `fromNodeId`, `toNodeId`, and `relationType` so the renderer can link back into graph or related note context
- results are ordered by most recent governance decision first

### Search activity note
- workspace search and activity-search responses now preserve activity `metadata` so renderer activity recall can label `review_action` hits with the specific manual decision instead of a raw activity type string

## 15.3 Get governance state
### HTTP
`GET /api/v1/governance/state/:entityType/:id`

### Purpose
Return the current confidence, reasons, and transition timestamps for one node or relation.

## 15.4 Recompute governance
### HTTP
`POST /api/v1/governance/recompute`

### Request
```json
{
  "entityType": "node",
  "entityIds": ["node_1"],
  "limit": 50
}
```

### Purpose
Run a bounded deterministic maintenance pass across governance state.

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
In bearer mode, clients must authenticate the request. Browser `EventSource` cannot attach the `Authorization` header, so browser clients should use an authenticated fetch-based stream or polling fallback instead.

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
  - react to writes such as node creation, activity append, governance recompute, settings changes, or workspace switching
- Auth:
  - non-browser clients in bearer mode should still send the normal `Authorization: Bearer ...` header
  - browser `EventSource` clients connect without query-string tokens and are accepted only from loopback origins
  - renderer/browser reconnects may require re-entering the bearer token after a refresh because the renderer does not persist it

### Example event
```text
event: workspace.updated
data: {"type":"workspace.updated","reason":"activity.appended","entityType":"activity","entityId":"act_123","workspaceRoot":"/Users/name/Documents/RecallX","at":"2026-03-18T07:20:00.000Z"}
```

---

## 18. Semantic indexing endpoints

Semantic indexing is optional and currently operates as a background-maintained sidecar.

- writes mark nodes as `pending` or `stale`
- reindex endpoints only queue work; they do not generate embeddings inline
- `enabled` can stay `false` even while queue metadata and index-state tables exist
- `provider` chooses embedding generation while `indexBackend` chooses vector storage and search

## 18.1 Get semantic indexing status
### HTTP
`GET /api/v1/semantic/status`

### Response fields
- `enabled`
- `provider`
- `model`
- `indexBackend`
- `configuredIndexBackend`
- `extensionStatus`
- `extensionLoadError`
- `chunkEnabled`
- `workspaceFallbackEnabled`
- `workspaceFallbackMode`
- `lastBackfillAt`
- `counts.pending`
- `counts.processing`
- `counts.stale`
- `counts.ready`
- `counts.failed`

Notes:
- `provider=disabled` keeps semantic work in chunk-only mode
- `provider=local-ngram` is the built-in local provider for end-to-end validation without an external API
- the shipped local provider surface is currently `local-ngram` / `chargram-v1` with embedding version `2`
- semantic search now requires `embedding_provider + embedding_model + embedding_version` compatibility
- `configuredIndexBackend=sqlite-vec` is the default local-first preference
- `indexBackend=sqlite-vec` means the extension loaded and bounded vector math is running inside SQLite
- `indexBackend=sqlite` means RecallX is using the fallback app-calculated similarity path
- `extensionStatus=loaded` means `sqlite-vec` is active, `fallback` means RecallX downgraded to `sqlite`, and `disabled` means the workspace is explicitly configured to stay on plain `sqlite`
- `search.semantic.chunk.aggregation=max` remains the default request-time chunk aggregation strategy
- `search.semantic.chunk.aggregation=topk_mean` averages the top semantic chunk matches for each node without changing write-time indexing
- `search.semantic.workspaceFallback.mode=strict_zero` is the default rollout-safe mode
- `search.semantic.workspaceFallback.mode=no_strong_node_hit` enables semantic retry when no strong lexical node hit is present
- semantic configuration changes may automatically mark ready rows as `stale` and queue affected active/draft nodes for rebuild

## 18.2 Queue workspace semantic reindex
### HTTP
`POST /api/v1/semantic/reindex`

### Body
```json
{
  "limit": 250
}
```

### Response
```json
{
  "queuedNodeIds": ["node_1", "node_2"],
  "queuedCount": 2
}
```

### Current behavior note
- manual reindex queueing now batch-loads nodes before marking them pending so workspace-wide queueing does not degrade into one-by-one node hydration

## 18.3 Get semantic indexing issues
### HTTP
`GET /api/v1/semantic/issues?limit=5&statuses=failed,stale&cursor=opaque`

### Purpose
Return a detail list for pending, stale, or failed semantic indexing items without widening the aggregate status contract.

### Query parameters
- `limit` — capped to `25`
- `statuses` — optional comma-separated subset of `pending`, `stale`, `failed`
- `cursor` — optional opaque cursor returned by the previous call

### Response
```json
{
  "items": [
    {
      "nodeId": "node_1",
      "title": "Recovery checklist",
      "embeddingStatus": "failed",
      "staleReason": "embedding.provider_not_implemented:openai",
      "updatedAt": "2026-03-19T04:00:00.000Z"
    }
  ],
  "nextCursor": "eyJzdGF0dXNSYW5rIjowLCJ1cGRhdGVkQXQiOiIyMDI2LTAzLTE5VDA0OjAwOjAwLjAwMFoiLCJub2RlSWQiOiJub2RlXzEifQ"
}
```

## 18.4 Queue semantic reindex for a single node
### HTTP
`POST /api/v1/semantic/reindex/:nodeId`

### Response
```json
{
  "nodeId": "node_1",
  "queued": true
}
```

---

## 19. Settings endpoints

## 19.1 Get settings subset
### HTTP
`GET /api/v1/settings?keys=workspace.name,search.semantic.enabled`

## 19.2 Update settings subset
### HTTP
`PATCH /api/v1/settings`

### Important note
Keep settings patchable in small subsets.
Avoid giant replace-whole-config behavior.

Legacy governance-related settings:
- `review.autoApproveLowRisk`: retained only for backward-compatible policy reads during migration
- `review.trustedSourceToolNames`: retained only for backward-compatible trusted-source policy reads during migration

---

## 20. CLI contract

The CLI should be a thin ergonomic layer over the API.

## 20.1 Core commands
- `recallx health`
- `recallx search <query>`
- `recallx get <node-id>`
- `recallx neighborhood <node-id>`
- `recallx related <node-id>` (legacy compatibility alias)
- `recallx context <target-id>`
- `recallx create`
- `recallx append`
- `recallx link`
- `recallx attach`
- `recallx governance issues`
- `recallx governance show --entity-type node --entity-id <id>`
- `recallx governance recompute`
- `recallx workspace current`
- `recallx workspace list`
- `recallx workspace create`
- `recallx workspace open`

## 20.2 CLI examples
### Search
```bash
recallx search "agent memory" --type project --limit 5
```

### Build context bundle
```bash
recallx context node_project_1 --mode compact --preset for-coding --format markdown
```

`recallx context --mode compact --preset for-coding --format markdown` now builds a workspace-entry bundle when no target id is supplied.

### Append activity
```bash
recallx append node_project_1 \
  --type agent_run_summary \
  --source codex \
  --text "Implemented schema draft and wrote migration notes"
```

### Link nodes
```bash
recallx link node_a node_b supports --source claude-code --status suggested
```

---

## 21. Error handling

## 21.1 Recommended error codes
- `INVALID_INPUT`
- `NOT_FOUND`
- `UNAUTHORIZED`
- `FORBIDDEN`
- `CONFLICT`
- `RATE_LIMITED` (optional for local protection)
- `INTEGRATION_DISABLED`
- `WORKSPACE_NOT_LOADED`
- `INTERNAL_ERROR`

## 21.2 Error handling principles
- return precise messages
- do not leak unnecessary local secrets
- validate enum and field errors clearly
- make CLI errors human-readable

---

## 22. Provenance requirements

These operations currently create provenance events:
- create node
- archive node
- create relation
- update relation status
- append activity
- attach artifact
- inspect governance issue state

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
- list node neighborhood items
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
7. governance endpoints
8. integrations/settings endpoints

This keeps the API practical and aligned with the build plan.

---

## 24. Summary

The right v1 API for RecallX is:
- local-only by default
- small but expressive
- retrieval-first
- append-first
- provenance-aware
- friendly to scout-stage and main-agent workflows

If it stays disciplined, it will be easy to integrate with many tools without becoming a bloated platform surface.
