# Memforge — Build Plan

## 1. Purpose

This document turns the concept into a practical build sequence.

The goal is not to describe every possible future feature.
The goal is to define:
- what to build first
- what to defer
- what technical choices are good enough for v0/v1
- how to protect speed and simplicity during implementation

This plan follows the project guardrails:
- local-first
- speed-sensitive
- lightweight by default
- model-agnostic
- human + agent shared knowledge layer
- avoid bloat

---

## 1.1 Progress snapshot (2026-03-19)

- Phase 0 foundation is implemented as a local Node/TypeScript service with SQLite-backed workspaces, migrations, and runtime workspace switching.
- Phase 1 human-readable workspace is in first-pass shape through the renderer home/search/review/settings flows, provenance-aware node detail surfaces, and an explicit graph focus picker.
- Phase 2 fast retrieval is present through local search, related lookups, decision/open-question helpers, and compact context bundle assembly.
- Phase 3 local API and CLI bridge is live through the loopback API, the `pnw` wrapper, service index discovery at `GET /api/v1`, and runtime workspace catalog operations.
- Phase 4 append-first write-back is live through node, relation, activity, and artifact writes with provenance and governance-aware review creation.
- Phase 5 review and curation is in place through review queue endpoints, renderer review actions, and provenance-friendly detail flows.
- Phase 6 real integrations now include documented `pnw`, raw HTTP bootstrap, and stdio MCP workflows in addition to the coding-agent path.
- Phase 7 retrieval enhancement has started selectively through inferred-relation storage, deterministic inferred-link generation from tag/body/activity, project-membership, and shared-artifact signals, usage feedback capture, maintenance recompute, and relation-aware ranking. Semantic retrieval still remains deferred until real usage proves deterministic retrieval is insufficient.

## 1.2 Current Plan (2026-03-19)

The near-term backlog from the 2026-03-18 snapshot is closed in the current worktree.
The next track is:

- keep product docs aligned with the shipped renderer/API/MCP surfaces instead of future-state assumptions
- dogfood the new Electron desktop shell and add distribution polish such as icons, signing, and notarization when needed
- tune inferred-relation thresholds and explainability based on real workspace usage so stronger signals do not make the graph noisy
- decide whether richer digest materialization is worth adding beyond the current deterministic summary + stale-cue baseline

---

## 2. Build philosophy

## 2.1 Start with the smallest useful core
The first version should prove that one local workspace can:
- store structured knowledge
- retrieve useful context quickly
- serve both a human UI and external tools
- preserve provenance

If that works well, everything else can be layered on.

## 2.2 Optimize for the hot path early
The product will be judged by:
- search speed
- context recall speed
- clarity of stored knowledge
- integration friction

Not by the number of advanced features.

## 2.3 Avoid premature “platform thinking”
Do not start by building:
- a plugin framework
- a sync engine
- an agent runtime
- a broad SDK matrix
- a giant ontology system

Build direct value first.

---

## 3. Recommended stack direction

This is a practical recommendation, not a rigid requirement.

## 3.1 App shell
### Recommendation
**Electron** for the first implementation.

### Why
- fast iteration
- easy local desktop packaging
- simple local service integration
- low friction if the UI is built with familiar web tooling

### Alternative
Tauri is still a strong option later if footprint becomes a strategic concern.

For now, speed of execution matters more than elegance of packaging.

---

## 3.2 UI layer
### Recommendation
- React
- TypeScript
- light component strategy
- avoid heavy design-system overhead at first

### Goal
Build a restrained UI with a small number of screens, not a broad productivity shell.

---

## 3.3 Local backend/service
### Recommendation
Use a local Node/TypeScript service embedded in or launched by the desktop app.

### Why
- shared language with UI
- easy local HTTP or IPC interface
- fast prototyping
- fewer moving parts for v0/v1

---

## 3.4 Data storage
### Recommendation
- SQLite as the canonical structured store
- filesystem directories for artifacts, exports, backups, and caches

### Why
- local-first
- portable
- durable
- easy to bundle
- sufficient for single-user / small local use

---

## 3.5 Search
### Recommendation
Start with:
- SQLite FTS5
- metadata filters
- relation-neighborhood lookups
- summary-first retrieval

Do **not** start with:
- vector DB server
- remote search service
- expensive model-backed search dependency

---

## 3.6 Semantic layer
### Recommendation
Treat semantic retrieval as an optional later enhancement.

If needed later:
- use embeddings table or cache
- support local or pluggable embedding generation

But do not let semantic retrieval block the first working product.

---

## 3.7 Integration surface
### Recommendation
Ship both:
- local HTTP API
- thin CLI wrapper

### Why
HTTP makes integrations structured.
CLI makes integrations easy for terminal-native tools.

---

## 4. Product slices

The build should proceed in slices, each producing something usable.

## Slice A — Local knowledge core
Make the app useful for one person locally.

## Slice B — Fast retrieval core
Make context lookup fast and predictable.

## Slice C — Agent-readable interface
Allow external tools to fetch context.

## Slice D — Agent append/write-back
Allow tools to contribute safely with provenance.

## Slice E — Review and curation loop
Let the human keep the workspace high-signal.

These slices should build on each other without widening the scope too early.

---

## 5. Phase-by-phase build plan

## Phase 0 — Foundation

### Goal
Create the project skeleton and storage core.

### Deliverables
- desktop app shell boots locally
- workspace root selection
- SQLite database initialization
- migration system
- basic folder structure creation
- data access layer for core tables

### Must-have tables
- nodes
- relations
- activities
- provenance_events
- artifacts
- settings

### Out of scope
- integrations
- graph UI
- semantic retrieval
- fancy settings panel

### Success criteria
- app starts reliably
- workspace can be created and reopened
- DB migrations run safely
- a node can be created and loaded

---

## Phase 1 — Human-readable local workspace

### Goal
Make the product minimally useful as a personal knowledge tool.

### Deliverables
- create node
- node detail view
- recent node list
- recent activity view
- simple workspace home
- summary refresh / graph inspection / semantic reindex affordances are acceptable first-pass substitutes for fuller node editing

### Recommended screens
- workspace home
- node detail
- new/edit node form

### Important constraint
Do not build too many node types or complex UI modes yet.

### Success criteria
- user can meaningfully keep notes/projects/ideas locally
- relation model is visible and understandable
- activity/provenance basics are functioning

---

## Phase 2 — Fast retrieval v1

### Goal
Deliver the speed-critical retrieval foundation.

### Deliverables
- SQLite FTS search
- type/tag/status filters
- project-centered retrieval
- relation-neighborhood lookup
- node summaries
- recent activity digest generation
- simple context bundle builder

### Required bundle modes
- `micro`
- `compact`

### Required presets
- `for-coding`
- `for-assistant`
- `for-research`

### Important constraint
No heavy semantic or model-required retrieval in this phase.

### Success criteria
- user can find relevant context quickly
- context bundles feel compact and useful
- hot path stays fast with a moderate local dataset

---

## Phase 3 — Local API and CLI bridge

### Goal
Expose the workspace to external tools.

### Deliverables
- loopback-only local API
- auth token/session model
- read endpoints
- CLI wrapper for search/get/context

### Required API reads
- `searchNodes`
- `getNode`
- `listRelatedNodes`
- `getNodeSummaries`
- `getRecentActivityDigest`
- `getDecisionSet`
- `getOpenQuestions`
- `getContextBundle`

### Required CLI commands
- `pnw search`
- `pnw get`
- `pnw related`
- `pnw context`

### Success criteria
- a local script can fetch project context from the workspace
- the same workspace data is visible in UI and API
- integrations can use `micro`/`compact` bundles reliably

---

## Phase 4 — Append-first write-back

### Goal
Allow external tools to contribute durable records safely.

### Deliverables
- create node API
- append activity API
- create relation API
- attach artifact API
- provenance recorded on all writes
- append-only default policy

### Required CLI commands
- `pnw create`
- `pnw append`
- `pnw link`
- `pnw attach`

### Important constraint
Avoid canonical overwrite workflows unless explicitly reviewed.

### Success criteria
- external tool can write a run summary back into the workspace
- user can inspect who wrote it and when
- raw write-back does not pollute canonical notes by default

---

## Phase 5 — Review queue and curation

### Goal
Preserve quality as multiple tools begin writing.

### Deliverables
- review queue UI
- suggested relation review
- suggested note promotion flow
- approve/reject controls first
- provenance-friendly detail flow
- edit/dismiss/archive can remain deferred if the lightweight queue stays usable

### Why this phase matters
Without curation, the workspace will become noisy and retrieval quality will degrade.

### Success criteria
- user can review agent-created suggestions quickly
- canonical knowledge remains high-signal
- noisy writes can be contained without deleting history

---

## Phase 6 — First real integrations

### Goal
Prove cross-tool continuity.

### Recommended order
1. OpenClaw proof-of-concept
2. generic script/CLI usage
3. Claude Code wrapper
4. Codex wrapper
5. Gemini CLI wrapper

### Deliverables
- one documented OpenClaw context retrieval flow
- one documented coding-tool context + write-back flow
- one documented research-tool flow

### Success criteria
- at least two external tools can share the same workspace meaningfully
- context reuse feels real, not cosmetic
- provenance clearly separates each tool’s contribution

---

## Phase 7 — Retrieval enhancement only if needed

### Goal
Improve recall without breaking speed.

### Possible additions
- semantic retrieval
- cheap-model scout compression
- automatic inferred-relation generation from deterministic signals
- pinned context weighting
- better digest generation

### Important condition
Only do this after observing real retrieval failures.

### Anti-pattern
Do not add semantic layers because they sound advanced.
Add them only if deterministic retrieval is demonstrably insufficient.

---

## 6. Suggested milestone framing

A simple milestone map can help keep the build honest.

## Milestone 1 — Solo local memory works
Includes:
- Phase 0
- Phase 1

Outcome:
A working local desktop knowledge app.

## Milestone 2 — Fast retrieval works
Includes:
- Phase 2
- Phase 3

Outcome:
A local workspace that can serve external tools quickly.

## Milestone 3 — Multi-tool continuity works
Includes:
- Phase 4
- Phase 5
- first part of Phase 6

Outcome:
A shared memory substrate across the user and at least two tools.

## Milestone 4 — Refinement
Includes:
- rest of Phase 6
- selective Phase 7

Outcome:
A stable early product with real daily utility.

---

## 7. Suggested first prototype boundaries

To avoid bloat, the first serious prototype should explicitly include only:

### Include
- node CRUD
- relation CRUD
- activity append
- provenance events
- local search
- compact context bundles
- local API
- CLI bridge
- review queue basics

### Exclude
- sync
- collaboration
- mobile apps
- plugins
- vector DB server
- advanced permissions matrix
- giant graph exploration tools
- heavy agent orchestration
- built-in AI chat shell as core UI

---

## 8. Suggested implementation order inside the codebase

A practical module order:

1. `workspace/`
   - root paths
   - config
   - workspace init/open

2. `db/`
   - schema
   - migrations
   - repositories

3. `domain/`
   - node logic
   - relation logic
   - activity logic
   - provenance logic

4. `retrieval/`
   - search
   - summaries
   - bundle assembly
   - presets

5. `api/`
   - local service
   - auth
   - request handlers

6. `cli/`
   - thin wrapper commands

7. `ui/`
   - pages
   - components
   - review flow

This order supports a stable foundation before visual polish.

---

## 9. Build risks to watch

## 9.1 UI bloat risk
The UI may become too ambitious too early.

### Countermeasure
Keep the first UI to a few restrained screens.

## 9.2 schema over-modeling risk
Too many entity types too early can slow everything down.

### Countermeasure
Stick to the current schema and extend only for proven needs.

## 9.3 retrieval over-engineering risk
There will be temptation to add semantic intelligence too early.

### Countermeasure
Make deterministic retrieval excellent first.

## 9.4 integration fragmentation risk
Different tool wrappers may pull the system in different directions.

### Countermeasure
Keep one stable local contract and thin wrappers.

## 9.5 noisy write-back risk
External tools may flood the workspace with low-signal content.

### Countermeasure
Use append-first writes, provenance, and review queue early.

---

## Appendix A — Inferred relation implementation track

This appendix defines a concrete implementation track for the v2 inferred relation direction described in `docs/relation-layer-v2.md`.

### Goal
Increase graph density and retrieval usefulness without requiring humans to review large volumes of relation suggestions.

### Phase A1 — Deterministic inferred relation layer

Build:
- `inferred_relations` schema and repository support
- deterministic candidate generation from:
  - project membership
  - explicit body references
  - tag overlap
  - activity proximity
- top-k and threshold pruning
- retrieval read path that can include inferred links behind a flag

Current implementation:
- active for node create/update and activity append
- relation/artifact/review write paths now refresh inferred links live
- currently uses explicit body references, tag overlap, activity-body references, shared project membership, and shared artifact references
- canonical inheritance remains follow-up work

Do not build yet:
- semantic generation
- usage feedback loops
- automatic promotion into canonical relations

Success criteria:
- graph density improves on active workspaces
- retrieval recall improves on linked tasks
- canonical relation quality stays unchanged

### Phase A2 — Usage feedback instrumentation

Build:
- `relation_usage_events` append path
- event emission from:
  - context bundle assembly
  - graph inspection clicks
  - successful downstream linked-node use
- offline aggregation into `usage_score`

Success criteria:
- inferred relation ranking starts adapting to real use
- weak frequently ignored links decay naturally

### Phase A3 — Graph/UI differentiation

Build:
- graph filters for canonical vs inferred
- inferred edge evidence display
- mute/hide affordances for noisy inferred links
- score visibility for debugging and trust

Success criteria:
- the UI can show richer neighborhoods without implying that every visible edge is canonical truth

### Phase A4 — Optional semantic pass

Build only if deterministic inferred links leave clear recall gaps:
- embeddings-backed candidate generation
- semantic evidence fields
- periodic rebuild job

Success criteria:
- recall improves measurably without making the hot path slow or opaque

### Recommended implementation order

1. storage and repository support
2. deterministic candidate generator
3. retrieval integration
4. usage event logging
5. score aggregation
6. graph/UI exposure
7. optional semantic expansion

### Kill-switch requirement

The inferred relation layer should be easy to disable:
- per workspace
- per retrieval preset
- per UI surface

This keeps the feature reversible if graph noise outweighs benefit.

## 10. Practical success tests

Before calling early versions successful, test these scenarios.

## Test A — Solo recall
A user can create notes, ideas, and project nodes and later retrieve them quickly through search and project context.

## Test B — Context handoff
A local CLI command can produce a compact project bundle that is genuinely useful to an external tool.

## Test C — Durable write-back
An external tool can append a useful activity summary with provenance.

## Test D — Quality control
The user can review and reject noisy suggestions without damaging the workspace.

## Test E — Growth tolerance
The app still feels fast with a moderately larger local dataset.

---

## 11. Team decision rules

If there is uncertainty about what to build next, choose the task that most improves one of these:
- retrieval speed
- clarity of stored knowledge
- ease of integration
- provenance trust
- reduction of workflow friction

Avoid tasks that mostly improve perceived sophistication without improving daily use.

---

## 12. Suggested immediate next action after this doc

After the build plan, the most useful next artifacts are:

1. `docs/ux.md`
   - restrained screen flows
   - search / node / review / context views

2. `docs/api.md`
   - concrete local HTTP and CLI contract
   - request/response shapes

3. initial project scaffold
   - app shell
   - DB migrations
   - core repositories

---

## 13. Summary

The correct first build is not a massive platform.
It is a disciplined local product with:
- structured knowledge
- fast retrieval
- compact context assembly
- clear provenance
- safe append-first integration

If this foundation feels fast and trustworthy, the product has room to grow.
If it starts heavy, it will lose its core advantage.
