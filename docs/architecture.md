# Memforge — Architecture

> Historical v1 design reference.
> Some sections in this document no longer reflect the shipped v2 surface.
> For current behavior, see `README.md`, `docs/api.md`, `docs/mcp.md`, `docs/schema.md`, and `docs/promotion-rules.md`.

## 1. Architecture goal

Design a local-first knowledge system that works as a durable memory layer for both:

- **humans** using a desktop app
- **external tools and agents** such as Claude Code, Codex, Gemini CLI, OpenClaw, and future local or remote assistants

The architecture should optimize for:

- local ownership
- portability
- inspectability
- append-first agent writes
- multi-tool interoperability
- long-term maintainability
- fast scout-stage retrieval before main-agent reasoning

This document focuses on the initial architecture for a practical v0/v1 build, not an idealized end-state.

---

## 2. System overview

The product should be structured as four layers:

### Layer A — Human desktop app
A local desktop application for browsing, editing, linking, searching, and inspecting knowledge.

### Layer B — Local application service
A local process exposing a stable interface for:
- reads
- search
- writes
- relation creation
- activity append
- context bundle generation

This service acts as the integration point for external tools.

### Layer C — Knowledge storage layer
Local persistence for:
- nodes
- relations
- activities
- provenance
- artifacts
- optional embeddings/indexes

### Layer D — Integration clients
External tools and agents that call into the local service or filesystem bridge.

Examples:
- Claude Code helper script
- Codex bridge
- Gemini CLI integration script
- OpenClaw adapter
- shell/CLI utilities

---

## 3. Recommended deployment shape

## Initial recommendation
Build this as a **desktop app plus embedded local service**.

Meaning:
- user installs a desktop application
- app manages the local database and files
- app also starts or embeds a loopback-only local API/service
- external tools connect to that local service
- the embedded service may run light maintenance timers for rebuildable indexes such as inferred-relation score refresh

### Why this shape fits the product
- preserves local-first ownership
- makes human UI and agent access share one source of truth
- avoids needing remote infra in the first release
- works for personal and small-circle deployment
- keeps security boundaries simpler than a cloud-first design

---

## 4. Platform recommendation

There are two realistic paths.

### Option A — Electron
**Pros**
- fastest path if UI is web-tech heavy
- rich ecosystem
- easy local HTTP/service integration
- straightforward packaging for macOS/Windows/Linux

**Cons**
- heavier runtime footprint
- more memory use

### Option B — Tauri
**Pros**
- lighter app footprint
- native-feeling desktop packaging
- strong local-app story

**Cons**
- some integration flows may be slower to prototype depending on stack
- more decisions if the team is more web-first than Rust-first

### Recommendation
For a fast first build: **Electron is acceptable**.
For a more opinionated, lean local product: **Tauri is attractive**.

If speed of validation matters most, start with the stack that makes local API + UI + packaging easiest for the builder.

---

## 5. Local storage design

The system should use a hybrid local storage model.

### Structured storage
Use **SQLite** as the primary source of truth for structured knowledge.

Store:
- nodes
- relations
- activities
- provenance
- settings
- governance state and audit entries
- integration registrations
- rebuildable embedding metadata and index-state sidecar data

### Filesystem storage
Use the local filesystem for:
- artifact files
- markdown export/import
- backups
- snapshots
- optional watched directories

### Why hybrid is best
SQLite is excellent for:
- local durability
- portability
- relational queries
- easy bundling
- versionable migrations

Filesystem storage is excellent for:
- large text artifacts
- attachments
- direct user trust
- import/export interoperability

---

## 6. Workspace layout

Suggested local layout:

```text
<workspace-root>/
  workspace.db
  artifacts/
  exports/
  imports/
  backups/
  logs/
  config/
    settings.json
  cache/
    embeddings/
    search/
```

### Notes
- `workspace.db` is the main SQLite database
- `artifacts/` stores attached files and external outputs
- `exports/` stores markdown/json exports
- `imports/` can be used for import staging
- `backups/` stores periodic snapshots
- `cache/` stores rebuildable indexes and embeddings

The database is canonical. Cache directories are reconstructible.

---

## 7. Core data model

The architecture should separate durable knowledge from transient process state.

## 7.1 Nodes
Nodes are the core knowledge objects.

### Required fields
- `id`
- `type`
- `title`
- `body`
- `status`
- `created_at`
- `updated_at`
- `created_by`
- `source_type`
- `source_label`
- `canonicality`
- `visibility`

### Example meanings
- `type`: note, project, idea, question, decision, reference, artifact
- `status`: active, archived, draft, review
- `canonicality`: canonical, appended, suggested, imported
- `visibility`: normal, hidden, system

### Design note
A node should be durable and addressable even if its rendered representation changes later.

---

## 7.2 Relations
Relations connect nodes.

### Required fields
- `id`
- `from_node_id`
- `to_node_id`
- `relation_type`
- `status`
- `created_at`
- `created_by`
- `source_type`
- `source_label`

### Notes
- `status` can be active, suggested, rejected, archived
- quantitative relation scoring is intentionally deferred to v2

---

## 7.3 Activities
Activities are append-only timeline events.

### Use cases
- agent run wrote a summary
- a file artifact was attached
- a design note was appended
- a review decision was made
- an import occurred

### Required fields
- `id`
- `target_node_id`
- `activity_type`
- `body`
- `created_at`
- `created_by`
- `source_type`
- `source_label`
- `metadata_json`

### Why activities matter
Activities preserve time-based continuity without forcing every event into the core node body.

---

## 7.4 Provenance records
Provenance must be first-class.

### Required fields
- `id`
- `entity_type` (node, relation, activity, artifact)
- `entity_id`
- `operation_type` (create, update, append, import, promote, archive)
- `actor_type` (human, agent, system, import)
- `actor_label`
- `tool_name`
- `tool_version`
- `timestamp`
- `input_ref`
- `metadata_json`

### Why this matters
Without provenance, a shared human/agent memory system becomes untrustworthy.

---

## 7.5 Artifacts
Artifacts represent external or attached outputs.

Examples:
- markdown files
- generated code snippets
- images
- PDFs
- exported patches
- logs

### Required fields
- `id`
- `node_id`
- `path`
- `mime_type`
- `size_bytes`
- `checksum`
- `created_at`
- `created_by`
- `source_label`

---

## 8. Suggested SQLite tables

This is a pragmatic initial schema outline.

### `nodes`
- id TEXT PRIMARY KEY
- type TEXT NOT NULL
- title TEXT
- body TEXT
- status TEXT NOT NULL
- canonicality TEXT NOT NULL
- visibility TEXT NOT NULL DEFAULT 'normal'
- created_at TEXT NOT NULL
- updated_at TEXT NOT NULL
- created_by TEXT
- source_type TEXT
- source_label TEXT
- metadata_json TEXT

### `relations`
- id TEXT PRIMARY KEY
- from_node_id TEXT NOT NULL
- to_node_id TEXT NOT NULL
- relation_type TEXT NOT NULL
- status TEXT NOT NULL
- created_at TEXT NOT NULL
- created_by TEXT
- source_type TEXT
- source_label TEXT
- metadata_json TEXT

### `activities`
- id TEXT PRIMARY KEY
- target_node_id TEXT NOT NULL
- activity_type TEXT NOT NULL
- body TEXT
- created_at TEXT NOT NULL
- created_by TEXT
- source_type TEXT
- source_label TEXT
- metadata_json TEXT

### `provenance_events`
- id TEXT PRIMARY KEY
- entity_type TEXT NOT NULL
- entity_id TEXT NOT NULL
- operation_type TEXT NOT NULL
- actor_type TEXT NOT NULL
- actor_label TEXT
- tool_name TEXT
- tool_version TEXT
- timestamp TEXT NOT NULL
- input_ref TEXT
- metadata_json TEXT

### `artifacts`
- id TEXT PRIMARY KEY
- node_id TEXT NOT NULL
- path TEXT NOT NULL
- mime_type TEXT
- size_bytes INTEGER
- checksum TEXT
- created_at TEXT NOT NULL
- created_by TEXT
- source_label TEXT
- metadata_json TEXT

### `review_queue`
- id TEXT PRIMARY KEY
- entity_type TEXT NOT NULL
- entity_id TEXT NOT NULL
- review_type TEXT NOT NULL
- proposed_by TEXT
- created_at TEXT NOT NULL
- status TEXT NOT NULL
- notes TEXT
- metadata_json TEXT

### `settings`
- key TEXT PRIMARY KEY
- value_json TEXT NOT NULL

### `integrations`
- id TEXT PRIMARY KEY
- name TEXT NOT NULL
- kind TEXT NOT NULL
- status TEXT NOT NULL
- config_json TEXT
- created_at TEXT NOT NULL
- updated_at TEXT NOT NULL

---

## 9. Search architecture

Search should be staged.

## Phase 1 — Keyword + metadata search
Use SQLite FTS and structured filters.

Capabilities:
- text search in title/body
- filter by type/tag/source/status
- list recent or related nodes

This is enough for first useful workflows.

## Phase 2 — Semantic retrieval
Add optional embeddings-backed retrieval.

### Important design choice
Embeddings should be **optional enhancement**, not a hard dependency.

This preserves:
- local-first behavior
- lower setup burden
- no forced cloud reliance

### Recommended embedding design
- store embeddings outside the core tables or in dedicated tables
- allow pluggable embedding backends
- permit local embedding generation later
- support rebuild from canonical node content

## Phase 3 — Scout-optimized retrieval
As the workspace grows, the search layer should explicitly support a fast scout stage.

### Goal
Enable lightweight retrieval clients to scan the workspace quickly and hand off only compact, high-signal context to stronger main agents.

### Requirements
- fast summary-first retrieval
- neighborhood fetch by node ID
- recent activity digest fetch
- decision and question subset fetch
- inexpensive relevance ranking
- compact handoff formats for external agents

### Design implication
The system should not assume that the main agent is the first component touching the knowledge base.
The architecture should make scout-first flows cheap and natural.

---

## 10. Local API design

The local application service is central.

### Deployment pattern
- bind to `127.0.0.1` only by default
- random auth token or local app session token
- optionally expose a local CLI wrapper on top of the same interface

### Why loopback-only matters
The product is meant to be local-first and safe for personal use.
Remote exposure should not be default.

---

## 10.1 Core API surface

The first API should stay small and stable.

### Read operations
- `searchNodes`
- `getNode`
- `listRelatedNodes`
- `listActivities`
- `getContextBundle`
- `getNodeSummaries`
- `getRecentActivityDigest`
- `getDecisionSet`
- `getOpenQuestions`
- `rankCandidates`

### Write operations
- `createNode`
- `updateNode`
- `appendActivity`
- `createRelation`
- `attachArtifact`
- `enqueueSuggestion`

### Governance operations
- `listReviewQueue`
- `approveSuggestion`
- `rejectSuggestion`
- `archiveNode`

---

## 10.2 Example conceptual request shapes

### Search
```json
{
  "query": "personal context os",
  "filters": {
    "types": ["idea", "project"],
    "status": ["active"]
  },
  "limit": 10
}
```

### Create node
```json
{
  "type": "note",
  "title": "Agent memory layer idea",
  "body": "This system should work as a shared substrate for multiple tools.",
  "source": {
    "actorType": "agent",
    "actorLabel": "OpenClaw",
    "toolName": "openclaw"
  }
}
```

### Append activity
```json
{
  "targetNodeId": "node_123",
  "activityType": "agent_run_summary",
  "body": "Codex explored the schema and suggested append-first writes.",
  "source": {
    "actorType": "agent",
    "actorLabel": "Codex",
    "toolName": "codex"
  }
}
```

### Build context bundle
```json
{
  "target": {
    "type": "project",
    "id": "project_42"
  },
  "options": {
    "includeRelated": true,
    "includeRecentActivities": true,
    "includeDecisions": true,
    "maxItems": 20
  }
}
```

---

## 11. Context bundle design

This is one of the most important capabilities.

A context bundle is a structured package of relevant knowledge for a tool or task.
In many workflows, it should be assembled in two stages:
- a fast scout stage gathers and compresses candidates
- a main agent consumes the curated bundle for deeper work

### Possible contents
- project summary
- recent activities
- important decisions
- linked ideas
- open questions
- attached artifacts
- source paths or IDs
- provenance summary

### Why this matters
Most external agents do not need raw graph dumps.
They need a **useful, compact working context**.

### Design recommendation
Support at least four bundle modes:
- **micro** — minimal scout/main handoff
- **compact** — for token-sensitive tools
- **standard** — balanced context
- **deep** — rich context for major tasks

---

## 12. Permission and trust model

The permission system should be simple at first.

## Human user
Full control.

## External tool modes
### Read-only
Can search and fetch context.

### Append-only
Can create nodes, append activities, and propose links.
Cannot silently rewrite canonical content.

### Elevated local write
Can update certain node types if explicitly authorized.
Should not be default in v1.

### Recommendation
Start with only:
- read-only
- append-only

Then add stronger write capabilities later if real workflows require them.

---

## 13. Review and governance design

Since multiple agents may write into the workspace, the system needs a trust and escalation mechanism.

### What should enter review or governance escalation
- suggested relations
- proposed canonical edits
- duplicate-merge proposals
- promoted summaries
- high-impact agent-generated knowledge

### What may bypass manual review
- low-risk activity logs
- clearly labeled append-only notes
- artifacts attached with provenance

### Why this matters
Review preserves trust without blocking all automation.

---

## 14. Versioning and mutation strategy

A shared knowledge system becomes fragile if edits are destructive.

### Recommended approach
- append-first by default
- archive instead of hard-delete where possible
- preserve provenance events for changes
- keep canonical body updates explicit and attributable

### For node editing
Support either:
- direct editable current body + provenance trail
or later
- revision table for full history

### Recommendation for v1
Use direct current body plus provenance trail first.
Only add full revisions if editing complexity becomes painful.

---

## 15. Integration patterns

The architecture should support multiple integration styles.

## 15.1 Local HTTP API
Best general-purpose bridge.

Good for:
- OpenClaw adapters
- scripts
- wrappers around Claude Code / Codex / Gemini CLI
- local automation

## 15.2 Local CLI bridge
A thin CLI on top of the API can make adoption easier.

Examples:
- `pnw search "project context"`
- `pnw context project_42 --mode compact`
- `pnw append node_123 --file output.md --source codex`

This may be more ergonomic for terminal-native tools.

## 15.3 Filesystem import/export
Useful as fallback and for compatibility.

Examples:
- import markdown folder
- export node tree to markdown
- attach artifacts from local tool output

---

## 16. Integration guidance by tool type

## Claude Code / Codex / Gemini CLI
These tools will often work best through:
- a small local CLI wrapper
- local HTTP calls
- structured context export files

Recommended workflow:
1. tool requests context bundle
2. tool performs work
3. tool appends result note/activity/artifact reference
4. user reviews higher-impact writes if needed

## OpenClaw / personal assistant systems
These can potentially use richer integration:
- memory search into the workspace
- write-back of summaries or durable notes
- project-context retrieval
- decision logging

The product should not assume any one tool is privileged forever.

---

## 17. Security posture

Because the product stores personal knowledge, local safety matters.

### Baseline
- bind local service to loopback only
- require local auth token/session for writes
- store secrets in OS-native secure storage if possible
- keep provider credentials separate from core workspace DB if feasible
- avoid silent remote sync by default

### Data handling
- user data is local by default
- cloud model usage should be explicit and user-chosen
- export formats should be inspectable
- logs should avoid leaking sensitive note content unless the user opts in

---

## 18. Reliability and backup strategy

Local-first products must make backup easy.

### Recommended baseline
- automatic DB snapshot on major migrations
- manual export to markdown/json
- optional periodic backup folder snapshots
- corruption-safe writes and transactions

### Principle
If the system is a memory layer, users must trust they can preserve and move it.

---

## 19. Suggested implementation sequence

### Step 1 — Storage core
- SQLite schema
- node CRUD
- relation CRUD
- activity append
- provenance recording

### Step 2 — Human UI
- workspace home
- node detail
- search
- graph inspection
- governance inspection

### Step 3 — Local API
- read endpoints
- append endpoints
- context bundle generation
- local auth model

### Step 4 — CLI bridge
- basic terminal commands for search/context/append

### Step 5 — Integrations
- OpenClaw integration proof-of-concept
- one coding tool bridge
- one export/import flow

### Step 6 — Retrieval enhancement
- semantic search
- relation suggestions
- better bundle assembly
- scout-optimized retrieval primitives
- summary-first context handoff

For a scaled relation direction beyond v1 review-driven links, see `docs/relation-layer-v2.md`.

---

## 20. Key architectural decisions to keep

These should remain true unless strong evidence says otherwise:

1. **Local-first storage is canonical**
2. **SQLite is the initial source of truth**
3. **Agent writes are append-first**
4. **Provenance is mandatory, not optional**
5. **Human UI and agent API share one storage core**
6. **Context bundles are a core primitive**
7. **The system is model-agnostic**
8. **Import/export portability matters from day one**

---

## 21. Open questions for later design

These do not need to block the first build, but they will matter soon:

- should the graph be fully typed or lightly typed at first?
- should tags be first-class entities later?
- when should full revision history be added?
- when should quantitative relation scoring be introduced, if ever?
  Current design direction: keep canonical relations minimal and move scoring into a separate inferred relation layer. See `docs/relation-layer-v2.md`.
- how should duplicate detection work?
- should some node classes be immutable records, e.g. decisions?
- how should per-tool permissions be configured in UI?
- how should optional sync work later without violating local-first trust?

---

## 22. Summary

The right architecture for Memforge is not a cloud AI note app.
It is a **desktop-local knowledge system with an embedded local integration layer**.

Its core value comes from:
- durable local storage
- graph-like structure
- provenance-aware append workflows
- tool-agnostic interoperability
- useful context packaging for humans and agents

If built this way, the product can become a true personal memory substrate rather than another isolated note tool.
