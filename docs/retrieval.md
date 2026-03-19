# Memforge — Retrieval & Context Assembly

## 1. Document purpose

This document defines how Memforge should retrieve, rank, compress, and hand off knowledge to external tools and agents.

This is not a generic search design.
It is a **speed-critical retrieval design** for a local-first knowledge layer used by:
- humans
- coding tools
- personal assistants
- research tools
- multi-agent workflows

The core goal is simple:

> **Main agents should think and act, not waste time browsing a large workspace.**

The retrieval layer exists to make the workspace feel fast, compact, and useful even as it grows.

---

## 2. Core philosophy

### 1) Speed is a first-class product feature
Retrieval latency is not an implementation detail.
If context feels slow, the whole product feels heavy.

### 2) Retrieval should prefer compression before expansion
The system should first find a small relevant working set, then only expand deeper if required.

### 3) Strong models should not do cheap browsing work
Broad scanning, ranking, filtering, and summarizing should happen in cheaper and faster stages whenever possible.

### 4) Most tasks need a working set, not the whole graph
The product should optimize for returning the **right 5–20 pieces of context**, not maximum recall at any cost.

### 5) Over-smart retrieval is a risk
If the retrieval layer becomes too complex, opaque, or expensive, the workspace will become slow and brittle.
Simplicity and predictability matter.

---

## 3. Design constraints

This system should explicitly avoid becoming:
- a giant always-on inference pipeline
- a heavyweight graph analytics engine for every query
- a cloud-dependent retrieval service
- a framework that requires expensive LLM calls for basic use
- an over-abstracted orchestration system before real user value is proven

The retrieval design should stay:
- local-first
- fast by default
- incremental
- inspectable
- easy to reason about

---

## 4. Retrieval model overview

The recommended retrieval model is **multi-stage, but lightweight**.

## Stage 0 — Fast local retrieval primitives
The system uses cheap local signals to pull candidates quickly.

Examples:
- SQLite FTS keyword match
- node type filters
- tag filters
- recent activity proximity
- direct graph neighborhood traversal
- pinned project context

## Stage 1 — Scout filtering
A scout stage trims the candidate set into a small high-signal shortlist.

The scout can be:
- non-LLM retrieval logic only
- a cheap small model
- a hybrid of retrieval + small model

## Stage 2 — Context assembly
The shortlist is assembled into a compact task-shaped bundle.

## Stage 3 — Main agent consumption
The main agent receives the bundle and performs deeper reasoning, coding, or synthesis.

### Principle
The main agent should rarely be the component that first touches the full workspace.

---

## 5. Scout/Main pattern

## 5.1 Scout stage
The scout is optimized for:
- speed
- cheap relevance triage
- low token cost
- shortlist generation

### Scout responsibilities
- retrieve candidate nodes quickly
- prefer summary fields over full bodies
- fetch recent activity digests
- fetch open questions / decisions / linked notes as compact items
- rank and prune candidates
- return a compact handoff

### Scout non-goals
The scout should not:
- do long-form reasoning
- write user-facing final output
- scan the full workspace deeply unless explicitly needed
- mutate canonical knowledge unnecessarily

## 5.2 Main stage
The main agent is optimized for:
- deeper reasoning
- coding
- synthesis
- planning
- execution
- user-facing responses

### Main agent responsibilities
- consume curated context
- solve the user’s actual task
- optionally write back a concise durable result

---

## 6. Retrieval layers

The retrieval system should be built in clear layers.

## 6.1 Layer A — Deterministic retrieval
This is the default foundation.

### Inputs
- text query
- target node/project
- filters
- relation scope
- recency window

### Mechanisms
- SQLite FTS
- exact metadata filters
- relation traversal by degree 1 or 2
- pinned project context
- recent activity lookup
- source/status filtering

### Why this layer matters
It is:
- cheap
- local
- predictable
- explainable
- enough for many tasks

This layer should carry most of the day-to-day workload.

---

## 6.2 Layer B — Summary-first retrieval
Each important node class should expose compressed retrieval-friendly fields.

### Recommended precomputed or maintained fields
- `summary`
- `key_points`
- `open_questions`
- `decision_digest`
- `recent_activity_digest`
- `artifact_refs`

### Goal
The scout should often be able to operate without opening full node bodies.

### Important rule
If the system frequently needs full-body reads for ordinary retrieval, the retrieval design is too heavy.

---

## 6.3 Layer C — Optional semantic retrieval
Semantic retrieval can improve recall, but it must stay optional.

### Good uses
- fuzzy conceptual recall
- finding semantically related ideas
- bridging vocabulary mismatch

### Risks
- slower query path
- less explainable ranking
- unnecessary complexity in early versions

### Recommendation
Treat semantic retrieval as a refinement layer, not the default foundation.

---

## 6.4 Layer D — Cheap model triage
A small/fast model can be useful after deterministic retrieval.

### Good uses
- shortlist ranking
- compressing candidate summaries
- selecting top contexts by task type
- removing obvious noise

### Important boundary
The cheap model should work on a small candidate set, not the full workspace.

---

## 7. Hot path vs cold path

This distinction is important to keep the system fast.

## 7.1 Hot path
Hot path operations must feel very fast and should avoid heavy computation.

### Examples
- search by keyword
- fetch node summaries
- fetch related nodes
- fetch recent activities
- fetch decision digest
- fetch open questions
- build compact context bundle

### Hot path rules
- avoid full graph traversal
- avoid large artifact parsing
- avoid mandatory LLM calls
- avoid long blocking work
- prefer cached summaries and cheap scoring

## 7.2 Cold path
Cold path operations can be slower and deeper.

### Examples
- full node body reconstruction
- deep multi-hop graph exploration
- semantic re-indexing
- artifact parsing
- duplicate detection across the workspace
- bulk import repair

### Cold path rules
- not part of ordinary agent handoff
- can run on demand or in background
- should not block hot path queries

### Key product principle
The user should interact mostly with hot path behavior.
Cold path should stay in the background or behind explicit actions.

---

## 8. Context budget model

Context should be intentionally budgeted.
More context is not always better.

## Recommended bundle sizes
### `micro`
For scout → main handoff where latency matters most.

Typical contents:
- short project summary
- top 3–5 candidate nodes
- recent decision digest
- 1–3 open questions

### `compact`
Default for routine coding or assistant tasks.

Typical contents:
- project summary
- top 5–10 relevant nodes
- recent activities digest
- linked decisions and references

### `standard`
For more complex implementation or research tasks.

Typical contents:
- broader node shortlist
- decision history
- related references
- recent agent outputs

### `deep`
For explicit heavy analysis.

Typical contents:
- more nodes
- larger excerpts
- more historical context
- possibly selective full bodies

### Recommendation
Default to `micro` or `compact` as much as possible.
The system should not drift into `deep` by habit.

---

## 9. Task-shaped retrieval

Different tasks need different context composition.
Retrieval should use presets rather than one generic bundle for everything.

## Suggested presets
### `for-coding`
Prioritize:
- project node
- relevant architecture/design notes
- recent implementation activity
- technical decisions
- attached code-related artifacts

### `for-research`
Prioritize:
- references
- linked ideas
- contradictions/supporting notes
- open questions
- recent summaries

### `for-decision`
Prioritize:
- decision history
- trade-offs
- contradictory notes
- unresolved questions
- project impact references

### `for-writing`
Prioritize:
- concept summaries
- supporting references
- previous drafts or idea nodes
- structure notes

### `for-assistant`
Prioritize:
- current project context
- recent durable notes
- personal preferences if relevant
- open loops and pending decisions

### Why this matters
Task-shaped retrieval reduces noise, improves speed, and avoids overloading agents with irrelevant context.

---

## 10. Ranking strategy

Ranking should stay simple and layered.

## 10.1 Primary ranking signals
Recommended early signals:
- exact keyword match score
- title hit boost
- summary hit boost
- node type relevance
- relation distance from target node/project
- canonicality weight
- relation type specificity
- relation usage feedback

## 10.2 Secondary ranking signals
Optional later signals:
- semantic similarity
- task-preset weighting
- integration-specific preferences
- recency of activity
- pinned status or manually marked importance
- previous user approvals or promotions

## 10.3 Rule of thumb
Start with deterministic ranking and only add more signals when clear failures appear.

If ranking logic becomes hard to explain, it is probably too heavy for this product stage.

---

## 11. Summary-first architecture

This is one of the most important parts of the design.

## 11.1 Why summaries matter
Summaries let the system:
- retrieve faster
- rank faster
- hand off smaller bundles
- keep main agents focused

## 11.2 What should have summaries
At minimum:
- project nodes
- decision nodes
- idea nodes
- question nodes
- reference nodes with substantial content

## 11.3 Summary classes
### `short_summary`
1–3 lines. Best for scout ranking.

### `working_summary`
Task-friendly compact summary.

### `decision_digest`
List of important decisions and rationale.

### `recent_activity_digest`
Compact summary of recent meaningful changes.

### `open_question_digest`
Unresolved or active questions.

## 11.4 Important caution
Do not create a giant summary-generation subsystem too early.
Start with simple summaries and improve only where they create clear speed wins.

## 11.5 Summary ownership and lifecycle

Summaries are the foundation of fast retrieval, but maintenance must never slow down the hot path.

### Current implementation snapshot (2026-03-18)
- if a node is created or updated without an explicit `summary`, the server fills one using a cheap deterministic `stableSummary(title, body)` helper
- callers can still override the summary explicitly on create/update when they have a better durable summary
- retrieval consumes the stored summary first and does not trigger background model work in the request path
- bundle assembly falls back to simple placeholders such as `No summary yet.` when a richer digest does not exist

### What is not implemented yet
- no dedicated `refresh summaries` CLI/API command
- no stale-summary age tracking or UI warning yet
- no nightly regeneration job
- no richer `key_points` / `decision_digest` materialization beyond the current lightweight activity and node-summary helpers

**Rule**: summary maintenance must stay cheap, synchronous, and local unless real usage proves a heavier pipeline is necessary.

---

## 12. Scout implementations

The product should support several scout styles.

## 12.1 Retrieval-only scout
Uses:
- FTS
- metadata filters
- graph neighborhood
- simple scoring
- summary-first handoff

### Pros
- fastest
- cheapest
- easiest to debug
- works offline

### Cons
- may miss fuzzy conceptual relevance

### Recommendation
This should be the default baseline.

## 12.2 Cheap-model scout
Uses a small/fast model after deterministic retrieval.

### Pros
- better pruning/compression
- better semantic triage

### Cons
- adds latency
- can be less predictable

### Recommendation
Use only after deterministic narrowing.

## 12.3 Hybrid scout
Uses deterministic retrieval first, then a small model for final shortlist assembly.

### Recommendation
This is likely the best long-term pattern, but not required in earliest versions.

---

## 13. Write-back implications

Retrieval and write-back should reinforce each other.

### Important idea
If write-back is noisy, retrieval quality collapses.

So write-back should prefer:
- concise activity summaries
- clear node types
- good source labels
- compact decision records
- explicit links to projects and ideas

### Bad pattern to avoid
Dumping huge raw transcripts into the workspace and expecting retrieval to remain fast.

### Good pattern
Promote compact, structured durable records and archive bulky raw material separately as artifacts.

---

## 14. Promotion pipeline

To prevent the workspace from becoming bloated, the retrieval layer should work with a lightweight promotion model.

## Suggested stages
1. raw output
2. activity summary
3. suggested note
4. review queue decision
5. approved canonical node

### Principle
Not everything that enters the workspace deserves equal prominence.

The retrieval layer should prefer:
- canonical nodes
- approved suggested content that has been promoted into canonical nodes
- high-signal activity digests

over raw uncurated material.

`Reviewed` is a governance event, not a separate persisted node stage in v1.

---

## 15. Minimal retrieval primitives

These are the API primitives the retrieval system should expose early.

### Essential read primitives
- `searchNodes(query, filters)`
- `getNode(id)`
- `getNodeSummaries(ids)`
- `listRelatedNodes(id, depth=1)`
- `getRecentActivityDigest(targetId)`
- `getDecisionSet(targetId)`
- `getOpenQuestions(targetId)`
- `getContextBundle(target, mode, preset)`

### Optional but useful
- `rankCandidates(query, candidateIds, preset)`
- `getNeighborhoodSummary(id)`
- `getPinnedContext(targetId)`

### Principle
A small set of fast primitives is better than one giant magical endpoint that tries to do everything.

---

## 16. Caching strategy

Caching should be pragmatic, not elaborate.

## Good candidates for caching
- node summaries
- recent activity digests
- decision digests
- open question digests
- compact context bundles for frequently used projects

## Bad candidates for over-caching
- unstable ad hoc query outputs
- giant deep bundles
- anything highly user-session-specific too early

### Rule
Cache what is small, reusable, and cheap to invalidate.
Avoid complex cache invalidation logic in the first versions.

---

## 17. Metrics that matter

If retrieval is central, it needs practical evaluation.

## Speed metrics
- search latency
- summary fetch latency
- context bundle assembly latency
- end-to-end scout handoff latency

## Quality metrics
- top-k usefulness rate
- unnecessary context rate
- missing-context failure rate
- user correction frequency

## Product metrics
- main agent context size reduction
- task completion speed improvement
- repeated query friction

### Important note
Measure speed and usefulness, not just retrieval sophistication.

---

## 18. Failure modes to guard against

### 1) Context bloat
Bundles keep growing because “maybe it helps.”
This will make the whole system slower and noisier.

### 2) Summary sprawl
Too many summary layers with unclear ownership become hard to maintain.

### 3) Over-engineered ranking
A ranking system with too many signals becomes opaque and fragile.

### 4) Scout overreach
If the scout starts doing too much reasoning, the speed advantage collapses.

### 5) Retrieval dependent on LLM availability
Basic workflows must not break if no model is available.

### 6) Giant graph-first behavior
If every request turns into broad graph crawling, the workspace will feel heavy.

---

## Appendix A — Inferred relation ranking (v2 direction)

This appendix describes how retrieval can use a high-volume inferred relation layer without treating those links as canonical truth.

### A.1 Retrieval should combine two relation layers

When expanding node neighborhoods or ranking bundle candidates:

1. canonical relations should be included first
2. inferred relations should be included second
3. inferred relations should be filtered by threshold and top-k rules
4. final ranking should explain whether a result came from canonical or inferred structure

### A.2 Suggested ranking signals

Canonical-first signals:
- direct canonical relation
- canonical relation type specificity
- relation distance from target project/node

Inferred-layer signals:
- inferred `final_score`
- evidence quality
- recent usage bonus
- decay penalty for stale weak links

Usage-derived signals:
- relation included in bundle
- relation clicked or inspected in graph
- relation-linked node used in final output
- repeated rejection or mute behavior

### A.3 Example ranking formula

```text
relation_rank_score =
  canonical_bonus +
  inferred_final_score +
  relation_type_specificity_bonus +
  recent_usage_bonus -
  age_decay -
  noise_penalty
```

Rule:
- weak inferred links must never outrank strong canonical links by default

### A.4 Usage event write points

The following actions are good candidates for `relation_usage_events`:
- context bundle assembly includes an inferred link
- graph UI node card is opened from an inferred link
- agent run uses a linked node in final output or work product
- a tool explicitly hides or mutes an inferred link

These writes should stay cheap and append-only.

### A.5 Hot-path rule

Retrieval should **not** call an LLM just to update relation weights.

The safe model is:
- append cheap usage events during the hot path
- aggregate those events later in a background or maintenance pass
- refresh inferred `final_score` asynchronously

This preserves the existing retrieval goal:
- deterministic first
- explainable first
- fast first

### A.6 Recommended desktop maintenance defaults

For an installable local app, inferred-score maintenance should feel automatic without behaving like a per-event synchronous write cascade.

Recommended defaults:
- keep usage-event writes append-only
- when pending events reach `12`, arm a short debounce timer
- recompute after `30s` of quiet since the latest event
- force a catch-up recompute once pending work is `5m` old
- cap a single maintenance batch at `100` relation ids
- persist `lastRunAt` so the next app launch can catch up after downtime

This is effectively near-real-time for the user while still protecting SQLite write contention and keeping ranking behavior easier to reason about.

---

## 19. Recommended build order

### Step 1
Implement deterministic retrieval:
- FTS
- filters
- relation traversal
- project-centered retrieval

### Step 2
Add summary fields and summary fetch endpoints.

### Step 3
Add compact task-shaped context bundle presets.

### Step 4
Add caching for summaries and common bundles.

### Step 5
Optionally add cheap-model scout compression.

### Step 6
Add semantic retrieval only if real workflows show gaps.

### Core rule
Do not start with the fanciest retrieval stack.
Start with the fastest stack that feels useful.

---

## 20. Strategic reminder

Memforge should not become a massive intelligence engine that is impressive on paper but slow in daily use.

The right shape is:
- light retrieval core
- summary-first handoff
- optional scout stage
- strong main agents using compact context
- careful promotion of durable knowledge

If the system remains disciplined here, it can grow in capability without becoming bloated or heavy.

---

## 21. Summary

This retrieval design exists to protect the product’s core intent:

- fast local memory access
- compact context handoff
- minimal browsing burden on strong agents
- low-friction interoperability across tools
- no unnecessary architectural weight

The workspace should feel like a fast memory substrate, not a slow knowledge maze.
