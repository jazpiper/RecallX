# Memforge — Schema

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

Current runtime note:
- the shipped v2 runtime actively uses `governance_state`, `governance_events`, `inferred_relations`, `relation_usage_events`, and `search_feedback_events`
- references to review-era storage in this document are historical or migration-only unless explicitly marked as part of the current runtime surface

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

6. **governance_state** — derived confidence and health state for nodes or relations
7. **governance_event** — append-only governance audit history
8. **integration** — registered local tool/client metadata
9. **setting** — workspace configuration
10. **inferred_relation** — rebuildable weighted links used for retrieval support
11. **relation_usage_event** — append-only usage signals that feed inferred-link maintenance

Legacy note:
- the old `review_queue` table may still exist in upgraded workspaces as migration-only storage, but it is not part of the shipped v2 runtime surface

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
- `contested`
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

## 5.5a InferredRelationStatus
- `active`
- `muted`
- `hidden`
- `expired`

## 5.5b RelationSource
- `canonical`
- `inferred`

## 5.5c RelationUsageEventType
- `bundle_included`
- `bundle_clicked`
- `bundle_used_in_output`
- `bundle_skipped`
- `retrieval_confirmed`
- `retrieval_muted`
- `manual_hide`

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

## 5.8 GovernanceState
- `healthy`
- `low_confidence`
- `contested`

## 5.9 GovernanceEventType
- `evaluated`
- `promoted`
- `contested`
- `demoted`
- `migrated`

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
- `created_by TEXT`
- `source_type TEXT`
- `source_label TEXT`
- `created_at TEXT NOT NULL`
- `metadata_json TEXT`

## 7.2 Semantics
v1 keeps relations intentionally minimal:
- `relation_type`
- `status`
- provenance fields

Quantitative relation scoring does not live on canonical `relations`.
The current implementation keeps canonical relations minimal and stores retrieval-facing weighting in `inferred_relations` plus read-time bonuses from relation type specificity and usage summaries.

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

## 7.6 Inferred relations table

The `inferred_relations` table stores rebuildable, weighted links used by retrieval and graph expansion.

### Columns
- `id TEXT PRIMARY KEY`
- `from_node_id TEXT NOT NULL`
- `to_node_id TEXT NOT NULL`
- `relation_type TEXT NOT NULL`
- `base_score REAL NOT NULL`
- `usage_score REAL NOT NULL DEFAULT 0`
- `final_score REAL NOT NULL`
- `status TEXT NOT NULL DEFAULT 'active'`
- `generator TEXT NOT NULL`
- `evidence_json TEXT NOT NULL`
- `last_computed_at TEXT NOT NULL`
- `expires_at TEXT`
- `metadata_json TEXT`

### Notes
- this layer is derived and rebuildable, not canonical truth
- `base_score` comes from the generator or indexing pass that proposed the edge
- `usage_score` is adjusted from aggregated `relation_usage_events`
- `final_score` is the retrieval-visible score after maintenance
- `generator` identifies the rule or process that produced the link

### Suggested indexes
- unique index on `(from_node_id, to_node_id, relation_type, generator)`
- index on `(from_node_id, final_score DESC)`
- index on `(to_node_id, final_score DESC)`
- index on `status`

---

## 7.7 Relation usage events table

The `relation_usage_events` table stores append-only feedback about whether canonical or inferred links were actually helpful.

### Columns
- `id TEXT PRIMARY KEY`
- `relation_id TEXT NOT NULL`
- `relation_source TEXT NOT NULL`
- `event_type TEXT NOT NULL`
- `session_id TEXT`
- `run_id TEXT`
- `actor_type TEXT`
- `actor_label TEXT`
- `tool_name TEXT`
- `delta REAL NOT NULL`
- `created_at TEXT NOT NULL`
- `metadata_json TEXT`

### Notes
- `relation_source` distinguishes canonical from inferred links
- `delta` is the lightweight signed signal later aggregated into `usage_score`
- these rows are append-only and maintenance-friendly

### Suggested indexes
- index on `relation_id`
- index on `created_at`

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
- `governance_state`
- `governance_event`

## 10.3 Example `operation_type`
- `create`
- `update`
- `append`
- `import`
- `attach`
- `archive`
- `promote`
- `contest`
- `demote`

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

## 11. Governance tables

Memforge v2 uses automatic governance instead of a user-facing review queue.

## 11.1 `governance_state`
- `entity_type TEXT NOT NULL`
- `entity_id TEXT NOT NULL`
- `state TEXT NOT NULL`
- `confidence REAL NOT NULL`
- `reasons_json TEXT NOT NULL`
- `last_evaluated_at TEXT NOT NULL`
- `last_transition_at TEXT NOT NULL`
- `metadata_json TEXT`

Purpose:
- expose current health for nodes and relations
- surface low-confidence or contested entities
- keep retrieval ranking aware of confidence without mixing it into canonical data

Suggested indexes:
- unique index on `(entity_type, entity_id)`
- index on `state`
- index on `last_evaluated_at`

## 11.2 `governance_events`
- `id TEXT PRIMARY KEY`
- `entity_type TEXT NOT NULL`
- `entity_id TEXT NOT NULL`
- `event_type TEXT NOT NULL`
- `state TEXT NOT NULL`
- `confidence REAL NOT NULL`
- `reasons_json TEXT NOT NULL`
- `created_at TEXT NOT NULL`
- `metadata_json TEXT`

Purpose:
- append-only governance audit history
- provenance for promotion, contest, demotion, migration, and recompute passes

Suggested indexes:
- index on `(entity_type, entity_id, created_at)`
- index on `event_type`

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
- append_search_feedback

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
- `search.semantic.indexBackend`
- `search.semantic.workspaceFallback.enabled`
- `review.autoApproveLowRisk` (legacy compatibility only)
- `review.trustedSourceToolNames` (legacy compatibility only)
- `relations.autoRecompute.enabled`
- `relations.autoRecompute.eventThreshold`
- `relations.autoRecompute.debounceMs`
- `relations.autoRecompute.maxStalenessMs`
- `relations.autoRecompute.batchLimit`
- `relations.autoRecompute.lastRunAt`
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

For search, create full-text indexes over nodes and activities.

## Suggested node FTS source fields
- `title`
- `body`
- `summary`

## Suggested activity FTS source fields
- `body`

### Recommended approach
Use SQLite FTS5 virtual tables synced from `nodes` and `activities`.

This gives:
- fast local keyword search across durable notes and operational history
- no separate search server
- easier packaging

---

## 16. Semantic indexing sidecar

Semantic indexing is optional and non-canonical.

The current semantic skeleton uses three rebuildable tables.

## 16.1 `node_index_state`
- `node_id TEXT PRIMARY KEY`
- `content_hash TEXT`
- `embedding_status TEXT NOT NULL`
- `embedding_provider TEXT`
- `embedding_model TEXT`
- `embedding_version TEXT`
- `stale_reason TEXT`
- `updated_at TEXT NOT NULL`

Use this table to:
- track `pending / processing / stale / ready / failed`
- avoid duplicate worker effort
- surface backlog state to operators and the renderer

## 16.2 `node_chunks`
- `node_id TEXT NOT NULL`
- `ordinal INTEGER NOT NULL`
- `chunk_hash TEXT NOT NULL`
- `chunk_text TEXT NOT NULL`
- `token_count INTEGER`
- `start_offset INTEGER`
- `end_offset INTEGER`
- `updated_at TEXT NOT NULL`

Use this table to:
- materialize rebuildable chunk boundaries for long notes
- support chunk-level embeddings later without changing canonical node storage

## 16.3 `node_embeddings`
- `owner_type TEXT NOT NULL`
- `owner_id TEXT NOT NULL`
- `chunk_ordinal INTEGER`
- `vector_ref TEXT`
- `vector_blob BLOB`
- `embedding_provider TEXT`
- `embedding_model TEXT`
- `embedding_version TEXT`
- `content_hash TEXT`
- `status TEXT NOT NULL`
- `created_at TEXT NOT NULL`
- `updated_at TEXT NOT NULL`

Use this table to:
- store rebuildable vector sidecar data
- attach embeddings to node-level or chunk-level owners
- keep provider-specific payloads outside canonical tables
- keep `vector_ref` available for future index metadata without making it canonical

### Notes
- the product must still function when these tables are empty or stale
- writes should mark semantic state dirty, not generate embeddings inline
- embeddings and chunks can be rebuilt from node content and settings
- `vector_blob` remains the rebuildable local vector payload for both the plain `sqlite` path and the preferred `sqlite-vec` path
- `vector_ref` is currently optional metadata and is not required for local semantic retrieval

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
- governance state
- governance events

---

## 18. Mutation rules

These rules should be enforced at app/service level.

### Rule 1
External agents should not hard-delete canonical nodes in v1.

### Rule 2
Agent-created or agent-modified canonical content should generate provenance.

### Rule 3
High-impact generated content should land as suggested, appended, or contested content under automatic governance.

### Rule 4
Activities should be append-only after creation except for rare admin fixes.

### Rule 5
Archived nodes remain addressable.

## 18.1 Node vs Activity vs Artifact boundary heuristic (v1 decision guide)

When an agent writes back, use these three questions to decide in <10 seconds.

### Decision heuristic
1. Will this knowledge be reused across tools and time?  
2. Is it longer than 300 tokens and not a pure log?  
3. Is it an external file?

### Boundary table

| Condition                              | Storage Type     | Reason & Examples |
|----------------------------------------|------------------|-------------------|
| Long-lived, reusable across tools      | **Node**         | Project, Decision, Idea, Question, Reference |
| Timeline event or log                  | **Activity**     | Agent run summary, import log, governance event |
| External generated file                | **Artifact**     | Code patch, PDF report, generated image |
| >300 tokens and reusable               | **Suggested Node** | Must flow through automatic governance |

### Real-world examples (agent write-back)

1. **Claude Code generates a patch**  
   → Artifact (patch file) + Activity (one-line summary)  
   → Do not create node

2. **Gemini CLI produces research summary (450 tokens)**  
   → Suggested Note (reference type) → goes through automatic governance

3. **OpenClaw session summary (150 tokens)**  
   → Single Activity by default  
   → Promote only if it contains reusable cross-tool knowledge or a decision

4. **Codex discovers important technical decision**  
   → Suggested Decision Node (auto-promote or contest)  
   → Never store only as activity

**Forbidden pattern**: pasting raw transcripts into canonical node body  
**Strict rule**: “If creating a node feels scary, put it in activity or artifact instead.”

## 18.2 Relation quality and graph-noise control (v1 rules)

Agent-generated relations are the #1 source of graph noise.  
Therefore v2 keeps conservative defaults even without a manual review queue.

### Strict rules
- Every agent-created relation defaults to `status = "suggested"` (no exceptions)
- Suggested relations become `active` only through automatic governance
- Human-created relations only may be created as `active` directly
- `strength` and `confidence` columns are **deferred to v2** (keep only `relation_type` + `status` in v1)
- Application-level uniqueness check: `(from_node_id, to_node_id, relation_type)` for active relations

### Anti-spam limit
- One agent run may propose maximum 5 relations unless user explicitly requests more
- Duplicate detection: if identical relation already exists (even as suggested), reject silently with log

**Forbidden by default**: agents directly creating `active` relations or using strength/confidence values.

This rule, combined with the promotion table, guarantees the graph stays trustworthy even when multiple tools write heavily.

---

## 19. Example record shapes

## 19.1 Example node
```json
{
  "id": "node_01J123ABC",
  "type": "project",
  "status": "active",
  "canonicality": "canonical",
  "title": "Memforge",
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
  "tool_version": "1.0.0",
  "timestamp": "2026-03-17T13:30:00Z"
}
```

---

## Appendix A — V2 derived relation tables

This appendix describes a likely v2 direction.

It does **not** change the meaning of the v1 canonical `relations` table.
Instead, it adds a separate derived layer for retrieval and graph support.

### A.1 `inferred_relations`

Suggested columns:
- `id TEXT PRIMARY KEY`
- `from_node_id TEXT NOT NULL`
- `to_node_id TEXT NOT NULL`
- `relation_type TEXT NOT NULL`
- `base_score REAL NOT NULL`
- `usage_score REAL NOT NULL DEFAULT 0`
- `final_score REAL NOT NULL`
- `status TEXT NOT NULL DEFAULT 'active'`
- `generator TEXT NOT NULL`
- `evidence_json TEXT NOT NULL`
- `last_computed_at TEXT NOT NULL`
- `expires_at TEXT`
- `metadata_json TEXT`

Purpose:
- store auto-derived links from indexing or semantic passes
- keep relation richness out of the canonical `relations` table
- support retrieval ranking and graph inspection

Important rules:
- this table is derived, not canonical
- rows may be recomputed, replaced, or dropped during rebuild
- `final_score` should be explainable from `base_score`, `usage_score`, and decay rules

Suggested indexes:
- index on `from_node_id`
- index on `to_node_id`
- index on `relation_type`
- index on `status`
- compound index on `(from_node_id, final_score DESC)`
- compound index on `(to_node_id, final_score DESC)`

### A.2 `relation_usage_events`

Suggested columns:
- `id TEXT PRIMARY KEY`
- `relation_id TEXT NOT NULL`
- `relation_source TEXT NOT NULL`
- `event_type TEXT NOT NULL`
- `session_id TEXT`
- `run_id TEXT`
- `actor_type TEXT`
- `actor_label TEXT`
- `tool_name TEXT`
- `delta REAL NOT NULL`
- `created_at TEXT NOT NULL`
- `metadata_json TEXT`

Purpose:
- record whether a relation actually helped downstream retrieval or agent work
- support positive and negative adjustments without mutating canonical data

Recommended `relation_source` values:
- `canonical`
- `inferred`

Recommended `event_type` values:
- `bundle_included`
- `bundle_clicked`
- `bundle_used_in_output`
- `bundle_skipped`
- `retrieval_confirmed`
- `retrieval_muted`
- `manual_hide`

Suggested indexes:
- index on `relation_id`
- index on `(relation_source, relation_id)`
- index on `event_type`
- index on `created_at`

### A.3 `node_coaccess_stats` (optional)

This table is optional and should only exist if event volume makes per-event joins too expensive.

Suggested columns:
- `node_a_id TEXT NOT NULL`
- `node_b_id TEXT NOT NULL`
- `positive_events INTEGER NOT NULL`
- `negative_events INTEGER NOT NULL`
- `last_seen_at TEXT NOT NULL`
- `metadata_json TEXT`

Purpose:
- compactly summarize repeated co-usage across retrieval runs
- support cheap recalculation of usage-influenced inferred relation scores

Suggested indexes:
- compound primary key or uniqueness on `(node_a_id, node_b_id)`
- index on `last_seen_at`

### A.4 Canonical vs derived boundary

Recommended rule:
- canonical `relations` remain sparse, durable, and trusted
- `inferred_relations` remain rebuildable and retrieval-oriented

Do not auto-promote inferred links into canonical `relations` simply because they have high usage.

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
