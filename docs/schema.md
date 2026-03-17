# Personal Neural Workspace — Schema

## 1. Schema goal

This schema defines the initial durable data model for a local-first personal knowledge layer shared by:

- human users
- local desktop UI
- external tools and agents
- integration bridges such as Claude Code, Codex, Gemini CLI, OpenClaw, and future adapters

The schema is designed for:
- clarity
- local durability
- append-first writes
- provenance tracking
- safe evolution over time

It is intentionally pragmatic for v0/v1 rather than fully abstract.

---

## 2. Design principles

### 1) Canonical core, optional extensions
The core schema should remain small and stable. Specialized behaviors should be layered on top rather than encoded too early.

### 2) Durable identity
Each meaningful knowledge object should have a stable ID.

### 3) Provenance everywhere
Every durable write should be attributable.

### 4) Append-first interoperability
Agents and external tools should be able to add value without requiring broad rewrite powers.

### 5) Human-readable exports matter
The schema should support export to markdown/JSON without losing too much meaning.

---

## 3. Core entity model

There are five primary durable entities:

1. **node** — a durable unit of knowledge
2. **relation** — a typed link between nodes
3. **activity** — an append-only event tied to a node
4. **artifact** — a file or external output attached to a node
5. **provenance_event** — a durable record of who/what created or changed something

There are also supporting entities:

6. **review_queue_item** — pending approvals or suggestions
7. **integration** — registered local tool/client metadata
8. **setting** — workspace configuration

---

## 4. ID strategy

## Recommendation
Use string IDs that are globally unique within the workspace.

Examples:
- `node_01HV...`
- `rel_01HV...`
- `act_01HV...`
- `art_01HV...`
- `prov_01HV...`

### Suggested format
ULID or UUIDv7 style IDs are preferable because they:
- are sortable by time
- work well offline
- are safe to generate locally

---

## 5. Enumerations

The following enums should start small and be extensible.

## 5.1 NodeType
Required initial values:
- `note`
- `project`
- `idea`
- `question`
- `decision`
- `reference`
- `artifact_ref`
- `conversation`

Optional later values:
- `person`
- `task`
- `meeting`
- `spec`
- `summary`

## 5.2 NodeStatus
- `active`
- `draft`
- `review`
- `archived`

## 5.3 Canonicality
- `canonical`
- `appended`
- `suggested`
- `imported`
- `generated`

## 5.4 RelationType
Required initial values:
- `related_to`
- `supports`
- `contradicts`
- `elaborates`
- `depends_on`
- `relevant_to`
- `derived_from`
- `produced_by`

Optional later values:
- `answers`
- `blocks`
- `supersedes`
- `mentions`
- `clustered_with`

## 5.5 RelationStatus
- `active`
- `suggested`
- `rejected`
- `archived`

## 5.6 ActivityType
Required initial values:
- `note_appended`
- `agent_run_summary`
- `import_completed`
- `artifact_attached`
- `decision_recorded`
- `review_action`
- `context_bundle_generated`

Optional later values:
- `merge_proposed`
- `node_promoted`
- `duplicate_detected`

## 5.7 SourceType
- `human`
- `agent`
- `import`
- `system`
- `integration`

## 5.8 ReviewType
- `relation_suggestion`
- `node_promotion`
- `canonical_edit`
- `merge_proposal`
- `archive_proposal`

## 5.9 ReviewStatus
- `pending`
- `approved`
- `rejected`
- `dismissed`

---

## 6. Nodes table

The `nodes` table stores the canonical durable knowledge objects.

## 6.1 Columns

### Identity and classification
- `id TEXT PRIMARY KEY`
- `type TEXT NOT NULL`
- `status TEXT NOT NULL DEFAULT 'active'`
- `canonicality TEXT NOT NULL DEFAULT 'canonical'`
- `visibility TEXT NOT NULL DEFAULT 'normal'`

### Display and content
- `title TEXT`
- `body TEXT`
- `summary TEXT`

### Ownership and source
- `created_by TEXT`
- `source_type TEXT`
- `source_label TEXT`

### Timestamps
- `created_at TEXT NOT NULL`
- `updated_at TEXT NOT NULL`

### Flexible metadata
- `tags_json TEXT`
- `metadata_json TEXT`

## 6.2 Column notes

### `title`
Short display name for browsing/search.

### `body`
Main content. Can contain markdown or structured text later.

### `summary`
Optional short summary for fast retrieval and context packing.

### `tags_json`
Start as JSON array of strings for simplicity.
Can later evolve into first-class tag entities if needed.

### `metadata_json`
Use sparingly for per-type data that is not yet worth first-class columns.
Examples:
- project stage
- question state
- decision impact level
- external reference URL

## 6.3 Node constraints
- `type` must be a valid `NodeType`
- `status` must be a valid `NodeStatus`
- `canonicality` must be a valid `Canonicality`
- `created_at <= updated_at`

## 6.4 Suggested indexes
- index on `type`
- index on `status`
- index on `created_at`
- index on `updated_at`

---

## 7. Relations table

The `relations` table stores typed edges between nodes.

## 7.1 Columns
- `id TEXT PRIMARY KEY`
- `from_node_id TEXT NOT NULL`
- `to_node_id TEXT NOT NULL`
- `relation_type TEXT NOT NULL`
- `status TEXT NOT NULL DEFAULT 'active'`
- `strength REAL`
- `confidence REAL`
- `created_by TEXT`
- `source_type TEXT`
- `source_label TEXT`
- `created_at TEXT NOT NULL`
- `metadata_json TEXT`

## 7.2 Semantics

### `strength`
Represents how strong the relation is believed to be.
Initial suggested range: `0.0` to `1.0`.
This can be:
- user-assigned
- inferred
- integration-provided

### `confidence`
Represents confidence in the relation claim, especially useful for agent suggestions.
Initial suggested range: `0.0` to `1.0`.

## 7.3 Constraints
- `from_node_id != to_node_id`
- both node IDs must exist unless using deferred foreign keys during import
- `relation_type` must be valid `RelationType`
- `status` must be valid `RelationStatus`

## 7.4 Suggested uniqueness rule
To reduce accidental duplicates, consider a soft uniqueness on:
- `from_node_id`
- `to_node_id`
- `relation_type`
- `status='active'`

This can be application-enforced first.

## 7.5 Suggested indexes
- index on `from_node_id`
- index on `to_node_id`
- index on `relation_type`
- compound index on `(from_node_id, relation_type)`

---

## 8. Activities table

The `activities` table stores append-only timeline events.

## 8.1 Columns
- `id TEXT PRIMARY KEY`
- `target_node_id TEXT NOT NULL`
- `activity_type TEXT NOT NULL`
- `body TEXT`
- `created_by TEXT`
- `source_type TEXT`
- `source_label TEXT`
- `created_at TEXT NOT NULL`
- `metadata_json TEXT`

## 8.2 Purpose
Use `activities` for:
- operational history
- append-only agent logs
- status/event timeline
- summaries of work tied to a node

Do **not** use it as a substitute for canonical node content.

## 8.3 Suggested indexes
- index on `target_node_id`
- index on `activity_type`
- index on `created_at`

---

## 9. Artifacts table

The `artifacts` table tracks files attached to a node.

## 9.1 Columns
- `id TEXT PRIMARY KEY`
- `node_id TEXT NOT NULL`
- `path TEXT NOT NULL`
- `mime_type TEXT`
- `size_bytes INTEGER`
- `checksum TEXT`
- `created_by TEXT`
- `source_label TEXT`
- `created_at TEXT NOT NULL`
- `metadata_json TEXT`

## 9.2 Notes
- `path` is local workspace-relative when possible
- `checksum` helps detect duplicates or corruption
- large files remain in filesystem storage, not the DB blob

## 9.3 Suggested indexes
- index on `node_id`
- index on `checksum`

---

## 10. Provenance events table

The `provenance_events` table is mandatory.
It records durable change history.

## 10.1 Columns
- `id TEXT PRIMARY KEY`
- `entity_type TEXT NOT NULL`
- `entity_id TEXT NOT NULL`
- `operation_type TEXT NOT NULL`
- `actor_type TEXT NOT NULL`
- `actor_label TEXT`
- `tool_name TEXT`
- `tool_version TEXT`
- `timestamp TEXT NOT NULL`
- `input_ref TEXT`
- `metadata_json TEXT`

## 10.2 Allowed `entity_type`
- `node`
- `relation`
- `activity`
- `artifact`
- `review_queue_item`

## 10.3 Example `operation_type`
- `create`
- `update`
- `append`
- `import`
- `attach`
- `approve`
- `reject`
- `archive`
- `promote`

## 10.4 Why separate from activities?
Activities are domain timeline events.
Provenance events are trust and audit records.

They should stay separate even if some operations create both.

## 10.5 Suggested indexes
- index on `(entity_type, entity_id)`
- index on `timestamp`
- index on `actor_label`
- index on `tool_name`

---

## 11. Review queue table

The `review_queue` table supports human governance over high-impact suggestions.

## 11.1 Columns
- `id TEXT PRIMARY KEY`
- `entity_type TEXT NOT NULL`
- `entity_id TEXT NOT NULL`
- `review_type TEXT NOT NULL`
- `proposed_by TEXT`
- `created_at TEXT NOT NULL`
- `status TEXT NOT NULL DEFAULT 'pending'`
- `notes TEXT`
- `metadata_json TEXT`

## 11.2 Purpose
Use review queue items for:
- relation suggestions
- merge proposals
- canonical body replacements
- archive requests
- promotions from generated/suggested to canonical

## 11.3 Suggested indexes
- index on `status`
- index on `review_type`
- index on `created_at`

---

## 12. Integrations table

The `integrations` table stores local client registrations.

## 12.1 Columns
- `id TEXT PRIMARY KEY`
- `name TEXT NOT NULL`
- `kind TEXT NOT NULL`
- `status TEXT NOT NULL`
- `capabilities_json TEXT`
- `config_json TEXT`
- `created_at TEXT NOT NULL`
- `updated_at TEXT NOT NULL`

## 12.2 Example `kind`
- `openclaw`
- `claude_code`
- `codex`
- `gemini_cli`
- `custom`

## 12.3 Example capability flags
- read_search
- get_context_bundle
- append_activity
- create_node
- create_relation
- submit_review_item

---

## 13. Settings table

The `settings` table stores workspace-level configuration.

## 13.1 Columns
- `key TEXT PRIMARY KEY`
- `value_json TEXT NOT NULL`

## 13.2 Example keys
- `workspace.name`
- `workspace.version`
- `api.bind`
- `api.auth.mode`
- `search.semantic.enabled`
- `review.autoApproveLowRisk`
- `export.defaultFormat`

---

## 14. Full foreign-key intent

Even if some early imports temporarily relax constraints, the conceptual foreign-key model is:

- `relations.from_node_id -> nodes.id`
- `relations.to_node_id -> nodes.id`
- `activities.target_node_id -> nodes.id`
- `artifacts.node_id -> nodes.id`

`provenance_events.entity_id` is polymorphic and should be application-validated.

---

## 15. FTS strategy

For search, create a full-text index over nodes.

## Suggested FTS source fields
- `title`
- `body`
- `summary`

### Recommended approach
Use SQLite FTS5 virtual table synced from `nodes`.

This gives:
- fast local keyword search
- no separate search server
- easier packaging

---

## 16. Embeddings strategy

Embeddings should be optional and non-canonical.

## Suggested table: `node_embeddings`
- `node_id TEXT PRIMARY KEY`
- `embedding_model TEXT NOT NULL`
- `vector_blob BLOB or external ref`
- `content_hash TEXT NOT NULL`
- `updated_at TEXT NOT NULL`
- `metadata_json TEXT`

### Notes
- this table can be omitted in earliest prototype
- embeddings can be rebuilt from node content
- do not make the product depend on embeddings to function

---

## 17. Export model

The schema should support export into human-readable formats.

## Markdown export expectations
For each node, preserve:
- id
- type
- title
- status
- tags
- source label
- created/updated timestamps
- body

For relations, preserve either:
- frontmatter references
or
- a separate relations JSON/manifest file

## JSON export expectations
JSON export should preserve the full schema fidelity including:
- nodes
- relations
- activities
- artifacts metadata
- provenance
- review queue

---

## 18. Mutation rules

These rules should be enforced at app/service level.

### Rule 1
External agents should not hard-delete canonical nodes in v1.

### Rule 2
Agent-created or agent-modified canonical content should generate provenance.

### Rule 3
High-impact generated content should enter review or be marked non-canonical.

### Rule 4
Activities should be append-only after creation except for rare admin fixes.

### Rule 5
Archived nodes remain addressable.

---

## 19. Example record shapes

## 19.1 Example node
```json
{
  "id": "node_01J123ABC",
  "type": "project",
  "status": "active",
  "canonicality": "canonical",
  "title": "Personal Neural Workspace",
  "body": "A local-first knowledge layer for humans and agents.",
  "summary": "Shared personal knowledge substrate.",
  "created_by": "human:juhwan",
  "source_type": "human",
  "source_label": "manual",
  "created_at": "2026-03-17T13:30:00Z",
  "updated_at": "2026-03-17T13:30:00Z",
  "tags_json": "[\"knowledge\",\"graph\",\"agents\"]",
  "metadata_json": "{\"stage\":\"concept\"}"
}
```

## 19.2 Example relation
```json
{
  "id": "rel_01J123DEF",
  "from_node_id": "node_project",
  "to_node_id": "node_architecture",
  "relation_type": "depends_on",
  "status": "active",
  "strength": 0.9,
  "confidence": 1.0,
  "created_by": "human:juhwan",
  "source_type": "human",
  "source_label": "manual",
  "created_at": "2026-03-17T13:35:00Z"
}
```

## 19.3 Example activity
```json
{
  "id": "act_01J123GHI",
  "target_node_id": "node_project",
  "activity_type": "agent_run_summary",
  "body": "OpenClaw drafted concept and MVP documents.",
  "created_by": "agent:openclaw",
  "source_type": "agent",
  "source_label": "OpenClaw",
  "created_at": "2026-03-17T13:40:00Z"
}
```

## 19.4 Example provenance event
```json
{
  "id": "prov_01J123JKL",
  "entity_type": "node",
  "entity_id": "node_project",
  "operation_type": "create",
  "actor_type": "human",
  "actor_label": "juhwan",
  "tool_name": "pnw-desktop",
  "tool_version": "0.1.0",
  "timestamp": "2026-03-17T13:30:00Z"
}
```

---

## 20. Migration strategy

The schema should evolve carefully.

### Recommendations
- keep numbered SQL migrations
- snapshot DB before major upgrades
- avoid renaming core enums casually
- prefer additive changes before destructive refactors
- store workspace schema version in settings

Example:
- `workspace.schemaVersion = 1`

---

## 21. What not to over-model yet

Do not overcomplicate v1 with:
- full ontology systems
- dozens of node types
- per-field ACL systems
- distributed sync metadata
- plugin-defined schema mutation at core level
- auto-derived graph semantics baked into canonical schema

These can come later after real usage patterns appear.

---

## 22. Summary

This schema is intentionally simple but strong enough to support the core promise of the product:

- one durable local knowledge base
- shared across humans and agents
- graph-aware
- provenance-aware
- append-friendly
- exportable and portable

If the product stays disciplined around these tables and mutation rules, it will have a solid foundation for both UI and integrations.
