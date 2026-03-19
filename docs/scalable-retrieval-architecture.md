# Memforge — Scalable Retrieval, DB, And Relation Architecture

## 1. Purpose

This document defines a retrieval and storage architecture that should remain robust as Memforge grows from small workspaces to very large local memory sets.

It is intentionally **not** anchored to a single note count.

The goal is:

- support ordinary local use comfortably
- stay predictable as corpus size grows by orders of magnitude
- keep hot-path latency low
- keep canonical data durable and simple
- let derived layers become richer without becoming operationally fragile

The design target is not "support exactly 100k notes".
The design target is:

> **Build invariants that still hold when the workspace grows much larger than early assumptions.**

---

## 2. Executive summary

The recommended Memforge architecture is:

- **SQLite remains canonical**
- **FTS + structured filters + shallow graph stay hot-path primary**
- **semantic/vector retrieval becomes optional secondary recall**
- **canonical relations and inferred relations remain separate layers**
- **relation weights affect retrieval, not truth**
- **heavy maintenance stays async and rebuildable**

In other words:

- use deterministic retrieval for speed and trust
- use inferred relations and vectors to widen recall only when useful
- never let rebuildable layers become critical-path truth

---

## 3. Current-state review

## 3.1 What is already strong

The current codebase already has several good architectural choices.

### Retrieval

- SQLite FTS5 exists for node search
- ranking already uses `bm25(...)`
- retrieval is summary-first more often than body-first
- context bundles are assembled from a small working set

### Relations

- canonical `relations` are separate from `inferred_relations`
- inferred links already have `base_score`, `usage_score`, and `final_score`
- `relation_usage_events` already exists as append-only feedback
- retrieval already gives canonical links stronger treatment than inferred ones

### Storage

- SQLite is already the canonical source of truth
- derived layers such as inferred relations are already conceptually rebuildable
- filesystem caches already have a place in workspace layout
- `node_index_state`, `node_chunks`, and `node_embeddings` now exist as semantic-sidecar tables
- semantic status and bounded reindex APIs now exist without putting embedding work on the write path

These are the right foundations.

## 3.2 Current risks

The main scaling risks are not the presence of SQLite itself.

The risks are:

- inferred-link refresh still being triggered directly from write paths
- raw usage-event aggregation being used directly for inferred-score maintenance
- broad fallback `LIKE` search over `body`
- tag filtering through `tags_json LIKE`
- query shapes that would benefit from compound indexes
- no background semantic worker has completed the full `pending -> processing -> ready/failed` lifecycle before this review
- inferred-relation generation still shaped around recent candidate sets, not full long-term scale
- scoring logic exists, but weight semantics are not yet fully governed as the system grows

None of these are fatal today, but they become more relevant as scale increases.

## 3.3 Immediate review findings from the current code path

These are the highest-value architectural corrections.

### Finding 1 — Inferred maintenance is too close to canonical writes

Today, node writes and adjacent events can trigger inferred-relation refresh immediately.

That means:

- a canonical write can fan out into candidate discovery
- related-node lookup happens inline
- artifact and activity inspection can happen inline
- write latency grows with workspace richness

This is the wrong long-term boundary.

### Recommendation

- keep canonical writes synchronous
- mark inferred maintenance dirty
- enqueue background recompute
- allow debounced micro-batches for desktop mode

### Finding 2 — Usage events need a rollup layer

`relation_usage_events` is a good durable event log.
It is not the best long-term maintenance substrate.

If score recompute repeatedly scans raw usage events, maintenance work grows with the historical event log.

### Recommendation

- keep the append-only event log
- add derived rollups such as relation usage summaries or coaccess aggregates
- compute retrieval maintenance from rollups first, not from raw history every time

### Finding 3 — Tag filtering should become first-class

`tags_json LIKE` is acceptable early, but not as a scaling strategy.

### Recommendation

- move to normalized tag membership
- avoid substring scans for structured filters

### Finding 4 — Compound indexes should match real read patterns

Single-column indexes are not enough once activity, artifact, review, and relation tables grow.

### Recommendation

Add compound indexes matching actual access patterns, especially for:

- relations by endpoint + status + recency
- activities by target + recency
- artifacts by node + recency
- review queue by status + recency

### Finding 5 — Chunking and embeddings should remain secondary

The live schema still treats note bodies as monolithic for FTS purposes.
That is workable early, but not a complete long-note strategy.

### Recommendation

- add chunk metadata tables
- add rebuildable embedding metadata
- keep both outside canonical truth semantics

---

## 4. Architectural invariants

These should remain true even as Memforge grows.

## Invariant 1 — SQLite is canonical

SQLite stores:

- nodes
- relations
- activities
- artifacts
- provenance
- review state
- retrieval metadata

Vector indexes, embedding files, inferred scores, and caches are **secondary**.

## Invariant 2 — Hot path stays deterministic-first

The hot path should not depend on:

- embeddings being fresh
- ANN indexes existing
- background jobs being caught up
- model calls succeeding

If semantic infrastructure is stale or absent, Memforge should still search well.

## Invariant 3 — Relation truth and retrieval hints stay separate

- canonical relations represent durable truth
- inferred relations represent retrieval support and graph hints
- usage weights tune retrieval ranking, not ontology truth

## Invariant 4 — Heavy maintenance is rebuildable

The system must be able to:

- drop vector indexes
- rebuild them later
- expire inferred links
- recompute inferred scores
- continue serving search while that happens

## Invariant 5 — Expansion is bounded

Any hot-path request must hard-cap:

- candidate counts
- graph depth
- inferred edge fanout
- full-body reads
- chunk expansion

These caps matter more than any one storage technology.

---

## 5. Scalable retrieval design

## 5.1 Query stages

Every search or context-bundle request should pass through these stages:

1. query classification
2. deterministic candidate generation
3. confidence check
4. optional semantic augmentation
5. bounded rerank
6. bounded expansion
7. context assembly

## 5.2 Stage 1 — Query classification

Classify queries cheaply into:

- exact lookup
- lexical search
- exploratory search
- node-centered expansion
- bundle-for-coding
- bundle-for-research

This decides whether semantic retrieval is even allowed.

## 5.3 Stage 2 — Deterministic candidate generation

This remains the default retrieval foundation.

Use:

- FTS5 over `title`, `summary`, and bounded search text
- exact filters over `type`, `status`, `canonicality`, `source_label`
- structured tag membership
- pinned project or workspace scope
- recent activity support
- direct relation neighborhood

### Strong recommendation

Do not rely on `tags_json LIKE` long term.

Move toward a normalized tag layer:

- `tags(id, name)`
- `node_tags(node_id, tag_id)`

That gives precise filters and better scaling.

## 5.4 Stage 3 — Confidence check

If deterministic retrieval already has strong signals, stop there.

Examples:

- exact title hit
- exact ID hit
- strong scoped FTS results
- direct neighborhood results around a known target

Semantic retrieval should not run automatically if deterministic retrieval is clearly good enough.

## 5.5 Stage 4 — Optional semantic augmentation

Semantic retrieval should be secondary.

Use it when:

- lexical recall is weak
- query wording is abstract
- vocabulary mismatch is likely
- the user is asking for "similar", "related", or "something like"

It should contribute candidates, not own ranking.

## 5.6 Stage 5 — Bounded rerank

Rerank a merged candidate set with:

- FTS relevance
- exact title bonus
- canonicality bonus
- recency
- project scope
- relation proximity
- usage bonus
- semantic similarity bonus

### Important rule

Semantic similarity must be a bounded influence.
It should rescue recall, not outrank strong exact results by default.

## 5.7 Stage 6 — Bounded expansion

Expand only the shortlist.

Typical hot-path expansion limits:

- `8-20` final candidates
- full body for top `3-5`
- graph depth `1` by default
- inferred neighbors capped per node
- chunk expansion only when long-body evidence is needed

---

## 6. Storage model review

## 6.1 Canonical tables

These should remain canonical:

- `nodes`
- `relations`
- `activities`
- `artifacts`
- `provenance_events`
- `review_queue`
- `settings`
- `integrations`

## 6.2 Derived tables

These should remain explicitly derived:

- `inferred_relations`
- `relation_usage_events`
- `node_index_state`
- `node_chunks`
- `node_embeddings`
- future query/result caches

## 6.3 Recommended schema additions

The first semantic skeleton is already implemented.
The remaining work is to enrich and operate it safely, not to invent the tables from scratch.

## `node_index_state`

Purpose:

- track stale summary/index/embedding state
- avoid duplicate background work
- make maintenance observable

Suggested fields:

- `node_id`
- `content_hash`
- `embedding_status`
- `embedding_provider`
- `embedding_model`
- `embedding_version`
- `stale_reason`
- `updated_at`

Current implementation:

- tracks semantic backlog state
- stores provider/model/version metadata
- is written on node, summary, activity, and artifact changes
- is exposed through `GET /api/v1/semantic/status`

## `node_chunks`

Purpose:

- handle long-note semantic retrieval without forcing whole-body embeddings

Suggested fields:

- `node_id`
- `ordinal`
- `chunk_hash`
- `chunk_text`
- `token_count`
- `start_offset`
- `end_offset`
- `updated_at`

Current implementation:

- the table exists now
- chunk materialization is the next safe worker step
- chunk data remains rebuildable from node content

## `node_embeddings`

Purpose:

- map node/chunk entities to sidecar vectors

Suggested fields:

- `owner_type`
- `owner_id`
- `chunk_ordinal`
- `vector_ref`
- `vector_blob`
- `embedding_provider`
- `embedding_model`
- `embedding_version`
- `content_hash`
- `status`
- `created_at`
- `updated_at`

Current implementation:

- the table exists now as a provider-agnostic sidecar
- a built-in `local-ngram` / `chargram-v1` provider can now exercise end-to-end write-back without external services
- request-time semantic augmentation is now wired as a bounded fallback path for candidate ranking and context bundles
- request-time tuning stays additive: `search.semantic.augmentation.minSimilarity`, `search.semantic.augmentation.maxBonus`, and `search.semantic.chunk.aggregation`
- provider-backed writes should stay behind the background worker boundary

## `node_tags`

Purpose:

- replace substring tag filtering with exact membership joins

Suggested shape:

- `tags(id, name)`
- `node_tags(node_id, tag_id)`

---

## 7. Indexing recommendations

## 7.1 Search indexes

Keep:

- FTS5 on `title`, `summary`, and bounded search text
- B-tree on `nodes(type)`
- B-tree on `nodes(status)`
- B-tree on `nodes(canonicality)`
- B-tree on `nodes(updated_at)`

Add:

- B-tree on `relations(from_node_id, status)`
- B-tree on `relations(to_node_id, status)`
- B-tree on `node_tags(node_id, tag_id)`
- B-tree on `node_index_state(embedding_status)`
- B-tree on `node_chunks(node_id, ordinal)`
- B-tree on `embedding_metadata(owner_type, owner_id)`

## 7.2 Search text strategy

Long term, FTS should not necessarily index raw entire bodies without discipline.

Recommended progression:

- keep `title` and `summary` always indexed
- keep a bounded search text or excerpt for ordinary note bodies
- use chunk tables for long-body semantic recall

This keeps FTS effective without forcing huge hot-path payloads.

---

## 8. Relation-layer review

## 8.1 Current relation model is directionally correct

The current separation is good:

- `relations` = durable typed truth
- `inferred_relations` = weighted derived edges
- `relation_usage_events` = append-only feedback

This should remain.

## 8.2 What should stay simple

Canonical relations should remain:

- low volume
- explicit
- provenance-aware
- human-legible

Canonical relations should not accumulate retrieval-style score semantics.

That means:

- no hidden confidence math on canonical truth
- no automatic promotion from inferred to canonical without a separate explicit rule
- no mixing retrieval score with governance state

## 8.3 What should move into inferred layer

The inferred layer should absorb:

- shared-project hints
- textual reference hints
- tag overlap hints
- shared-artifact hints
- future semantic similarity hints
- future co-usage hints

That layer can be large, decayed, tuned, hidden, and rebuilt.

## 8.4 Recommended relation stratification

Use three levels:

### Level A — Canonical relations

- durable
- manually or explicitly authored
- trusted
- govern truth and explicit navigation

### Level B — Inferred relations

- derived
- score-bearing
- retrieval-oriented
- rebuildable

### Level C — Usage signals

- append-only
- non-graph truth
- inputs to inferred-score maintenance

This keeps semantics clean.

## 8.5 Current relation-layer risks that should be fixed

### Risk 1 — Inferred relations should not seed canonical-style membership inference

Project membership is a particularly sensitive relation family.

If inferred project links can later be treated as membership evidence, inferred graph structure can recursively amplify itself.

That causes:

- widening candidate generation
- noisy project neighborhoods
- false "shared project" boosts
- difficult-to-debug retrieval drift

### Rule

Project membership inference must come only from:

- canonical project relations
- explicit node metadata
- other trusted canonical signals

It must not be seeded from inferred edges.

### Risk 2 — Score semantics are currently too leaky

If one persisted score is later re-boosted differently across multiple retrieval surfaces, tuning becomes non-local and fragile.

### Rule

Separate:

- maintenance score
- retrieval rank

Persist only maintenance-oriented values.
Compute request-specific retrieval rank at read time.

### Risk 3 — Stale inferred edges need a real lifecycle

A small age penalty alone is not enough once the inferred layer becomes large.

### Rule

Inferred edges should transition through explicit states such as:

- `active`
- `muted`
- `hidden`
- `expired`

Those transitions should be driven by thresholds and maintenance rules, not only by a soft subtractive decay.

---

## 9. Weighting-system review

## 9.1 What the current scoring gets right

The current scoring model is already conservative:

- relation-type specificity has small bounded bonuses
- usage bonus is clamped
- age decay is clamped
- final score remains bounded

That is good because it prevents runaway feedback loops.

## 9.2 Current conceptual risk

The main risk is not the math itself.
The risk is the absence of a fully explicit contract for what the score means.

A relation score can easily become ambiguous:

- is it truth confidence?
- retrieval usefulness?
- graph importance?
- recent utility?

Those should not be one number with multiple meanings.

## 9.3 Recommended score semantics

Use explicit meaning:

- `base_score` = generation strength
- `usage_score` = observed retrieval usefulness adjustment
- `health_score` = maintenance-state score after usage and lifecycle rules
- `freshness_penalty` or decay = staleness effect
- `degree_penalty` or fanout penalty = density control when needed
- `retrieval_rank` = request-time rank only

### Important rule

`health_score` and `retrieval_rank` should never be treated as ontological truth confidence.

It is a search/navigation score.

## 9.4 Recommended weighting boundaries

To keep the system sturdy:

- keep weights bounded
- keep each component interpretable
- avoid many tiny interacting bonuses
- prefer a few stable inputs over "smart" complexity

Good inputs:

- deterministic evidence quality
- relation-type specificity
- observed positive use
- observed negative use
- recency decay
- optional degree/fanout normalization

Avoid mixing in:

- opaque model confidence without evidence
- too many per-tool special cases
- unbounded reinforcement loops

## 9.5 Suggested scoring model

Use:

```text
final_score =
  clamp(
    base_score
    + usage_adjustment
    - freshness_penalty
    - degree_penalty
    - noise_penalty,
    min_score,
    max_score
  )
```

Where:

- `base_score` comes from deterministic or semantic generators
- `usage_adjustment` comes from observed downstream usefulness
- `freshness_penalty` fades stale weak links
- `degree_penalty` prevents dense hubs from overwhelming retrieval
- `noise_penalty` handles repeated negative feedback or ambiguity

Recommended naming:

```text
health_score =
  clamp(
    base_score
    + usage_adjustment
    - freshness_penalty
    - degree_penalty
    - noise_penalty
  )
```

Then compute:

```text
retrieval_rank =
  lexical_bonus
  + canonical_bonus
  + relation_type_bonus
  + request_scope_bonus
  + bounded(health_score)
```

This keeps maintenance semantics and request-time ranking separate.

This is enough.

---

## 10. Recommended retrieval/relation contract

Search and relation layers should interact like this:

1. deterministic search returns lexical candidates
2. canonical relations add trusted direct neighbors
3. inferred relations add bounded scored neighbors
4. usage signals tune inferred ranking only
5. semantic retrieval may add more node candidates, not rewrite relation truth

This prevents the graph layer from becoming an ungoverned ranking soup.

---

## 11. Failure modes to guard against

## 11.1 Canonical truth polluted by retrieval hints

Fix:

- never merge inferred semantics into canonical relations implicitly

## 11.2 Retrieval slowed by rebuildable systems

Fix:

- all embeddings, chunking, and inferred recompute remain async

## 11.3 Search degraded by fallback scans

Fix:

- eliminate broad `LIKE` dependence as scale grows
- normalize tags
- bound body search text

## 11.4 Relation explosion

Fix:

- cap inferred edges per node
- cap inferred edges per relation type
- require minimum thresholds per generator

## 11.5 Feedback loops become self-reinforcing noise

Fix:

- keep usage deltas bounded
- decay over time
- support mute/hide
- do not promote to canonical automatically

---

## 12. Implementation order

## Phase 1 — Tighten deterministic search

- normalize tag storage
- reduce reliance on body `LIKE` fallback
- define bounded search text strategy
- add explicit hot-path budgets

## Phase 2 — Operationalize the semantic skeleton

- use the existing `node_index_state`
- use the existing `node_chunks`
- use the existing `node_embeddings`
- add the background worker contract
- keep write-path behavior at "mark pending/stale only"

## Phase 3 — Formalize relation score semantics

- document score meanings
- defer breaking renames until all read surfaces are migrated
- add noise/mute semantics explicitly

## Phase 4 — Add semantic sidecar

- summary embeddings first
- chunk embeddings for long notes second
- semantic fallback only after deterministic confidence check

## Phase 5 — Add observability

- query latency percentiles
- deterministic-only success rate
- semantic fallback frequency
- stale-index backlog
- inferred-edge counts per node
- bundle size/fanout metrics

---

## 13. Bottom line

The right long-term Memforge architecture is not "vector-first".
It is:

- SQLite-first
- deterministic-first
- summary-first
- bounded-expansion
- relation-layered
- rebuildable

That architecture should remain healthy well beyond early corpus sizes, because the real scaling lever is not the raw note count.

The real scaling lever is whether the hot path stays small, predictable, and independent from heavy derived-state maintenance.
