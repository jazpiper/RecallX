# Relation Layer V2

## 1. Goal

Design a relation system that works at real note volume without requiring a human to review large numbers of suggested links.

The core idea:
- keep `relations` as a small canonical layer
- add a separate auto-derived relation layer
- let retrieval and agent usage continuously adjust the usefulness of those derived links

This document is intentionally a v2 design note. It does not replace the current v1 relation rules.

## 1.1 Status snapshot (2026-03-18)

The current codebase already implements part of this design:

- `inferred_relations` exists as a real table and API surface
- `relation_usage_events` exists as a real append-only feedback table and API surface
- inferred links can be upserted manually or by external generators
- usage events can trigger explicit or debounced score recompute
- retrieval already uses relation-type specificity and usage-aware boosts when ranking neighborhood and bundle items

What is still not implemented:

- automatic inferred-relation generation on node create/update
- co-access aggregation tables such as `node_coaccess_stats`
- semantic candidate generation or embedding-backed relation discovery
- dedicated human UI controls for muting/hiding inferred links at scale

---

## 2. Problem

The current v1 model assumes relations are mainly created explicitly:
- human creates an active relation
- agent creates a suggested relation
- review queue decides whether that relation becomes active

That is safe, but it does not scale well for high-volume memory capture.

At larger note volume:
- most notes will never be linked manually
- agents will under-create relations because explicit linking is extra work
- review-based relation triage does not scale if links are numerous
- graph and retrieval quality will stay sparse even if node capture is healthy

In other words, the v1 write path is too manual for relation richness, but too conservative for relation coverage.

---

## 3. Design Principles

### 3.1 Separate fact from inference

Canonical relations should stay rare and trustworthy.

Auto-derived links should not be treated as the same kind of truth as:
- a human-created dependency
- a confirmed support relation
- a deliberate project membership decision

### 3.2 Do not make humans approve graph exhaust

High-volume inferred links should not flow through the same review queue used for higher-risk durable writes.

Instead:
- canonical edits remain reviewable where needed
- inferred links stay outside the canonical review path
- retrieval uses inferred links probabilistically, not as hard truth

### 3.3 Keep hot-path retrieval explainable

The system should be able to explain why a node or link was used:
- direct canonical relation
- same project membership
- semantic similarity
- repeated co-usage in bundles
- recent successful retrieval usage

If ranking becomes impossible to explain, the layer is too heavy.

### 3.4 Make derived state rebuildable

The database remains canonical.
Derived relation indexes should be reproducible from:
- nodes
- canonical relations
- activities
- optional embeddings
- usage events

This matches the current architecture rule that cache/index state should be reconstructible.

---

## 4. Layered Relation Model

### Layer A: Canonical relations

Stored in the existing `relations` table.

Use for:
- explicit human links
- small number of deliberate, trusted agent-written links
- durable facts that should survive rebuilds as first-class knowledge

Properties:
- typed
- provenance-aware
- low volume
- high trust

### Layer B: Inferred relations

Auto-derived by deterministic and optional semantic/indexing passes.

Use for:
- retrieval support
- graph orientation
- neighborhood expansion
- bundle assembly

Properties:
- weighted
- rebuildable
- not automatically treated as durable truth
- can be hidden, decayed, or replaced without review

### Layer C: Usage feedback

Captured from real retrieval and agent usage.

Use for:
- increasing weight on useful inferred links
- decreasing weight on noisy or ignored links
- adapting retrieval to actual use rather than static heuristics

Properties:
- append-only event trail
- cheap to write
- aggregate into scores later

---

## 5. Current implemented base and remaining data model

## 5.1 Keep `relations` minimal

No change to the current canonical relation table is required for phase 1 of v2.

Canonical `relations` should continue to represent durable, typed edges only.

## 5.2 `inferred_relations` (implemented)

Suggested table:

- `id TEXT PRIMARY KEY`
- `from_node_id TEXT NOT NULL`
- `to_node_id TEXT NOT NULL`
- `relation_type TEXT NOT NULL`
- `base_score REAL NOT NULL`
- `usage_score REAL NOT NULL DEFAULT 0`
- `final_score REAL NOT NULL`
- `evidence_json TEXT NOT NULL`
- `generator TEXT NOT NULL`
- `status TEXT NOT NULL DEFAULT 'active'`
- `last_computed_at TEXT NOT NULL`
- `expires_at TEXT`
- `metadata_json TEXT`

Notes:
- `base_score` is the score from indexing/generation
- `usage_score` is adjustment from real use
- `final_score` is the retrieval-visible score after aggregation
- `evidence_json` should explain why the link exists
- `generator` identifies the rule or model that produced it
- `status` supports hiding, muting, or decay without deleting history
- this table is derived, not canonical
- the current server stores and updates this table today

## 5.3 `relation_usage_events` (implemented)

Suggested table:

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

`relation_source` distinguishes:
- `canonical`
- `inferred`

Suggested `event_type` values:
- `bundle_included`
- `bundle_clicked`
- `bundle_used_in_output`
- `bundle_skipped`
- `retrieval_confirmed`
- `retrieval_muted`
- `manual_hide`

The current server stores these events today and aggregates them back into inferred-link maintenance.

## 5.4 Optional `node_coaccess_stats`

If event volume gets large, aggregate pair usage into a compact stats table:

- `node_a_id TEXT NOT NULL`
- `node_b_id TEXT NOT NULL`
- `positive_events INTEGER NOT NULL`
- `negative_events INTEGER NOT NULL`
- `last_seen_at TEXT NOT NULL`
- `metadata_json TEXT`

This can be recomputed from `relation_usage_events`.

---

## 6. Relation generation pipeline (still to do)

## 6.1 Trigger points

Inferred relation generation should run on:

1. Node create/update
2. Explicit reindex request
3. Background maintenance pass
4. Optional nightly semantic refresh

Hot path should stay cheap.
Heavy semantic work should be deferred to background jobs.

## 6.2 Generation stages

### Stage 1: Deterministic candidates

Create cheap candidates from signals such as:
- same project membership
- explicit node-id or title mention in body
- shared tags
- shared artifact reference
- repeated co-occurrence in activity trails
- canonical relation inheritance

These are cheap and explainable.

### Stage 2: Optional semantic candidates

Add candidates from:
- embedding similarity
- summary similarity
- title and summary paraphrase detection

This stage should be optional and rebuildable.

### Stage 3: Deduplicate and cap

Before writing inferred links:
- collapse duplicate node pairs
- keep the best score per `(from_node_id, to_node_id, relation_type, generator)`
- cap per-node outgoing inferred edges

The graph should prefer top useful links over exhaustive weak links.

### Stage 4: Score and persist

For each surviving candidate:
- compute `base_score`
- attach structured evidence
- write or update the `inferred_relations` row

### Stage 5: Micro-batch maintenance

Usage-driven score refresh should not run on every event write.

Recommended default shape for desktop/installable builds:
- append `relation_usage_events` immediately
- mark the relation layer as dirty in memory
- recompute in a micro-batch after a short quiet period
- persist a maintenance watermark so the next app launch can catch up

Recommended default thresholds:
- event threshold: `12`
- debounce after the latest event: `30s`
- max staleness for pending events: `5m`
- recompute batch size: `100` relations

This keeps the system feeling automatic without turning each read/write cycle into a synchronous maintenance job.

---

## 7. Scoring Model

## 7.1 Base score

Base score should come from stable generation logic.

Example:

```text
base_score =
  project_membership_bonus +
  direct_reference_bonus +
  tag_overlap_bonus +
  semantic_similarity_bonus +
  provenance_bonus -
  ambiguity_penalty
```

## 7.2 Usage score

Usage score should come from real downstream behavior.

Example:

```text
usage_score =
  bundle_used_in_output * +2.0 +
  retrieval_confirmed * +1.0 +
  bundle_clicked * +0.4 +
  bundle_skipped * -0.3 +
  retrieval_muted * -1.0 +
  manual_hide * -3.0
```

## 7.3 Final score

Final score should remain simple:

```text
final_score = base_score + usage_score - age_decay
```

Age decay helps old weak links fade out if they are never used.

## 7.4 Important rule

Usage score should influence retrieval ranking first, not canonical truth.

The system should not quietly turn high-usage inferred links into canonical relations without an explicit separate rule.

---

## 8. Retrieval Integration

## 8.1 Retrieval should combine both layers

When expanding a node neighborhood or ranking bundle candidates:

1. include direct canonical relations first
2. include high-scoring inferred relations second
3. merge and rank with a simple score explanation

## 8.2 Explainability requirement

Each retrieved related item should carry a reason such as:
- `Canonical: supports`
- `Inferred: same project + summary similarity`
- `Inferred: repeatedly used with this target in coding bundles`

## 8.3 Suggested ranking order

Canonical relation boost should dominate weak inferred links.

Example:

```text
retrieval_relation_score =
  canonical_relation_bonus +
  inferred_final_score +
  relation_type_specificity_bonus +
  recent_usage_bonus
```

This preserves trust while still letting inferred links improve recall.

## 8.4 Auto-recompute operating rule

The preferred operating model is not manual cron-only maintenance.

For installable desktop deployments:
1. append usage events cheaply during the hot path
2. recompute inferred scores automatically in-process with debounce
3. on app start, inspect usage events newer than the last maintenance watermark
4. if pending work exists, run a catch-up maintenance pass

This gives the user an effectively automatic system while respecting the fact that the app process may be fully closed between sessions.

---

## 9. Graph and UI Implications

The graph UI should not flatten canonical and inferred links into one visual class.

Recommended treatment:
- canonical edges: solid, stronger visual emphasis
- inferred edges: lighter, dashed, or lower contrast
- inferred edge detail: show score and evidence on inspection
- graph filters: canonical only / inferred only / combined

This prevents the graph from looking more trustworthy than it actually is.

---

## 10. Guardrails

## 10.1 No review queue flood

Inferred relations should not create standard review queue items by default.

## 10.2 No canonical auto-promotion

Do not auto-promote inferred links into canonical `relations` just because they are frequently used.

If promotion exists later, it should be:
- explicit
- sparse
- separately governed

## 10.3 Hard caps

Protect retrieval and graph readability with caps:
- max inferred edges per node
- max inferred edges per relation type
- minimum score threshold per preset

## 10.4 Rebuildability

Derived relation tables must be safely disposable and rebuildable.

---

## 11. Rollout Plan

## Phase 1: Retrieval-only inferred relation layer

Add:
- `inferred_relations`
- deterministic candidate generation
- retrieval ranking support

Do not add:
- LLM-based usage feedback
- canonical promotion
- graph editing semantics

Goal:
- improve neighborhood quality without touching canonical writes

## Phase 2: Usage feedback loop

Add:
- `relation_usage_events`
- retrieval inclusion and usage logging
- simple positive/negative score adjustments

Goal:
- let real agent behavior tune inferred link usefulness

## Phase 3: UI exposure

Add:
- graph filters for canonical vs inferred
- evidence display
- score visibility
- hide/mute controls for inferred links

Goal:
- make the graph richer without misleading users

## Phase 4: Optional semantic pass

Add:
- embeddings-backed candidate generation
- periodic rebuild jobs
- model-specific generator metadata

Goal:
- increase recall only after deterministic signals are solid

---

## 12. Why this fits Memforge

This design preserves the product's current strengths:
- local-first canonical storage
- conservative durable writes
- provenance-aware agent behavior
- explainable retrieval
- rebuildable caches and indexes

It also addresses the real scaling problem:
- relation richness should come from indexing and usage, not constant manual linking

---

## 13. Recommendation

The recommended direction for Memforge is:

1. Keep v1 canonical relations minimal and trusted
2. Add a separate inferred relation layer for retrieval and graph support
3. Let indexing generate links automatically
4. Let real retrieval usage adjust weights over time
5. Avoid human review for the high-volume inferred layer

This gives Memforge a dense, useful graph without turning relation maintenance into human moderation work.
