# Memforge — MVP Spec

> Historical v1 design reference.
> Some sections in this document no longer reflect the shipped v2 surface.
> For current behavior, see `README.md`, `docs/api.md`, `docs/mcp.md`, `docs/schema.md`, and `docs/promotion-rules.md`.

## 1. MVP goal

Build a local-first personal knowledge workspace that:

1. stores durable knowledge as nodes and relations
2. provides a human UI for browsing and maintaining that knowledge
3. exposes a local interface that external tools and agents can use
4. preserves provenance so users know what came from where

The goal of the MVP is **not** to build a full PKM suite or a built-in AI assistant.
The goal is to validate that one local knowledge layer can be shared across several tools with useful continuity.

---

## 2. Core user story

> I want one local knowledge base that I can use myself, while also letting tools like Claude Code, Codex, Gemini CLI, and OpenClaw read from and write to it, so my context is not fragmented across tools.

---

## 3. Target users for MVP

### Primary
- the creator / owner user
- technically capable early adopters
- developer-heavy knowledge workers
- people already using multiple AI tools

### Early deployment context
- personal local use
- small trusted circle
- company acquaintances / internal pilot-style sharing

This means the MVP should prioritize:
- privacy
- portability
- install simplicity
- debuggability
- clear provenance

over mass-market polish.

---

## 4. Non-goals

The MVP should explicitly avoid trying to be:
- a real-time collaborative SaaS
- a task manager
- a document publishing platform
- a calendar or meeting platform
- a general autonomous AI agent product
- an all-in-one productivity operating system

---

## 5. MVP principles

### Local-first
Data lives on the local machine by default.

### Agent-compatible
Multiple external tools should be able to interact with the workspace.

### Append-first
External tools append notes, logs, artifacts, and suggestions rather than silently rewriting important records.

### Inspectable
Users can inspect node history, provenance, and incoming writes.

### Portable
The workspace should support export/import and avoid tight vendor lock-in.

### Fast-first
The workspace should be optimized so external tools can retrieve useful context quickly, often through a lightweight scout stage before invoking a stronger main agent.

---

## 6. MVP feature set

## A. Local knowledge store

### Required
- create node
- edit node
- archive node
- list nodes
- view node details
- attach metadata
- store relations between nodes

### Node types for MVP
- note
- project
- idea
- question
- decision
- reference
- artifact_ref

### Required metadata
- id
- type
- title
- content/body
- tags
- created_at
- updated_at
- source_type
- source_label
- status (active / archived)

---

## B. Relation system

### Required relation types
- related_to
- supports
- contradicts
- elaborates
- depends_on
- relevant_to
- produced_by

### MVP behavior
- users can create relations manually
- agents can propose or create relations through the local interface
- relation provenance is stored

---

## C. Human UI

### Required screens

#### 1) Workspace home
- recent nodes
- recent activity
- quick guide entry
- current integration and semantic status surface
- fast links into graph and project-map inspection

#### 2) Node detail
- node content
- metadata
- related nodes
- activity history
- artifacts
- context bundle preview

#### 3) Guide
- keyword-first retrieval surface for nodes, activities, and bundles
- semantic augmentation when local semantic status is healthy
- lightweight filters only when the simple query-first flow is insufficient

#### 4) Graph view
- limited graph visualization
- centered around the selected node or project
- not intended to be the main workflow

#### 5) Governance
- surfaced automatic-governance issues
- operational inspection rather than manual queue triage
- explainable issue details without reintroducing a human review queue

---

## D. Agent interface

The MVP needs a local integration surface.
This can be a local HTTP server, local IPC, CLI bridge, or a combination.

### Required capabilities
- search nodes
- get node by id
- create node
- append activity to node/project
- create relation
- list related nodes
- build context bundle
- fetch summaries for candidate nodes
- fetch recent activity digests
- fetch open questions / decision subsets

### Example conceptual operations
- `search(query, filters)`
- `getNode(id)`
- `createNode(type, title, body, source)`
- `appendActivity(targetId, body, source)`
- `linkNodes(a, b, relationType, source)`
- `getContextBundle(target, options)`

### MVP policy
- default read access is explicit
- write access is local-only and user-authorized
- destructive operations should be minimized or omitted in v1

---

## E. Provenance and history

This is mandatory for trust.

### Required
Every write should record:
- source_type (human / import / agent / system)
- source_label (e.g. Claude Code, Codex, OpenClaw)
- timestamp
- operation type
- target node(s)

### Why it matters
Users must be able to answer:
- who wrote this?
- which tool suggested this?
- what changed?
- should I trust or revise it?

---

## F. Import / export

### MVP import
- markdown import from folder
- JSON import optional

### MVP export
- markdown export
- JSON export
- backup-friendly local directory structure

This is important for:
- user trust
- migration safety
- interoperability
- future product flexibility

---

## 7. Nice-to-have, but not required for MVP

- embeddings-backed semantic retrieval
- automatic link suggestions
- watch-folder sync
- diff view for edits
- agent-specific permission presets
- local vector index optimization
- plugin system

These are useful, but they should not delay the first usable build.

---

## 8. Suggested technical shape

### App form
Desktop app.
Likely candidates:
- Electron
- Tauri

### Local storage
Recommended baseline:
- SQLite for structured data
- local filesystem for attached artifacts and markdown export

### Internal model
- nodes table
- relations table
- activities table
- sources/provenance table
- optional embeddings table later

### Integration layer
One of:
- local HTTP API
- local CLI
- lightweight SDK wrappers later

The priority is making integrations easy for tools that already work via terminal or local scripts.

---

## 9. Suggested MVP release phases

### Phase 0 — Solo usable prototype
- create/edit/view nodes
- create relations
- browse graph lightly
- local persistence

### Phase 1 — Agent-readable system
- search API
- get node API
- context bundle generation
- fast summary/digest endpoints for scout-stage retrieval

### Phase 2 — Agent-writable system
- append activity
- create node from tools
- provenance tracking
- promotion/governance checks for higher-risk writes

### Phase 3 — Better retrieval
- semantic search
- smarter context assembly
- optional relation suggestions

---

## 10. Integration targets

### High-priority
- OpenClaw
- Claude Code
- Codex
- Gemini CLI

### Why these first
They match the intended real workflow:
- coding help
- personal assistant memory
- project continuity
- multi-tool experimentation

### MVP expectation
Direct polished native integrations are not required at first.
A practical local bridge is enough if it is documented and stable.

---

## 11. Trust and permission model

### MVP stance
- local-only by default
- no hidden cloud sync
- explicit access setup for external tools
- append-first writes preferred
- archive over delete where possible

### Destructive actions
For MVP, avoid giving agents broad delete or rewrite powers.
Prefer:
- append
- propose
- link
- archive suggestion

---

## 12. Success criteria

The MVP is successful if a user can:

1. keep a meaningful local knowledge base in the app
2. connect at least two external tools to it
3. retrieve useful context from prior notes/projects
4. inspect what each tool added
5. feel less context fragmentation across tools

---

## 13. Failure modes to watch

- schema becomes too complex too early
- integrations are brittle or annoying to use
- provenance is unclear
- graph is impressive but not useful
- import/export is weak
- app feels slower than plain files without enough return

---

## 14. Suggested next build docs

1. `docs/architecture.md` — storage model, local API, and provenance design
2. `docs/integrations.md` — concrete patterns for Claude Code, Codex, Gemini CLI, OpenClaw
3. `docs/ux.md` — screen-by-screen flow for the human UI
4. `docs/schema.md` — node, relation, activity, provenance schemas
