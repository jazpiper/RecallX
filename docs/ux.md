# RecallX — UX Design

## 1. Purpose

This document describes the current RecallX local UI and renderer UX and the product rules that should guide future UI changes.

RecallX should feel:
- fast
- calm
- local
- inspectable
- trustworthy
- useful for daily work

It should not feel like:
- a bloated dashboard
- a generic note app clone
- a graph toy
- a chat-first AI shell
- an enterprise admin console

The UI should help users do four things well:
1. capture durable knowledge
2. retrieve context quickly
3. inspect relationships and provenance
4. review what tools and agents added

---

## 2. UX principles

## 2.1 Retrieval first
Users should be able to get back to useful context quickly.
The product is search-and-context-first, not folder-first.

## 2.2 Context should stay visible
The selected node should always have nearby context visible in the right rail.

## 2.3 Operations should stay explainable
If the system exposes semantic indexing, inferred links, or review policy, the UI should show them as operational aids, not magic.

## 2.4 Human control matters
The user should feel in control of:
- what is canonical
- what is reviewable
- what was written by tools
- which surfaces affect retrieval quality

## 2.5 Graph is secondary
Graph exists to inspect neighborhoods, not to replace the primary reading and search workflow.

## 2.6 Fast paths should be obvious
The quickest paths should stay clear:
- quick capture
- search
- inspect in graph
- inspect contested governance items
- reindex or diagnose semantic state when needed

---

## 3. Current app shape

RecallX currently ships a 3-pane local UI shell.

### Left sidebar
- workspace identity
- top-level navigation
- quick capture entry
- recent nodes

### Center pane
- Home
- Guide
- Recent
- Graph
- Project map
- Governance
- Settings

### Right pane
- selected node detail
- related nodes
- context bundle preview
- recent activity
- artifacts
- governance summary

This shape is correct for v1 because it keeps retrieval and inspection near each other without making graph or settings dominate the product.

---

## 4. Information architecture

Top-level navigation stays intentionally small:
- Home
- Guide
- Recent
- Graph
- Project map
- Governance
- Settings

Supporting navigation stays lightweight:
- recent nodes

Do not add more top-level surfaces unless they clearly improve capture, retrieval, review, or context inspection.

---

## 5. Screen-by-screen behavior

## 5.1 Home

### Goal
Home is the re-entry screen.
It should answer:
- what workspace am I in?
- what needs review?
- how do I connect external tools?
- what is the semantic index doing?
- how do I capture something quickly?

### Current sections
- workspace summary card
- workspace-wide search field
- command palette entry point
- lightweight search filter chips for scope, node type, and source
- quick actions for Guide, Graph, Governance, and Notes
- active project digest
- recent project cards
- compact governance follow-up card for recent manual decisions
- recent movement / mixed-search result panels

### Important notes
- Home now includes a workspace-wide search bar and keeps quick actions secondary
- Home can carry recent manual governance decisions forward, but only as a small continuity cue
- Home search refinement should stay client-visible and small, not turn into an advanced query builder
- Home is a retrieval-first re-entry surface, not the primary node-creation surface
- semantic indexing still belongs on Home as an operational aid, not as a dedicated page

### Design rule
Home should remain a compact re-entry surface, not expand into analytics or system-monitor sprawl.

---

## 5.2 Guide

### Goal
Guide is the human-readable integration surface.

### Current behavior
- unified HTTP + MCP setup guidance
- grouped sections for overview, base URL, starter routes, example requests, MCP connection, search flow, write path, and workspace paths
- keeps operational setup in the renderer instead of forcing users to switch to external docs first

### Current non-goals
- not a full API reference replacement
- not an interactive integration dashboard
- not a substitute for the machine-readable service index

### Design rule
Keep this page text-first and immediately useful.
It should lower setup friction without turning into a verbose control panel.

---

## 5.3 Recent

### Goal
Recent is the quickest way back to recently touched nodes.

### Current behavior
- simple list of recently touched nodes
- summary-first cards
- click-through to a Recent note modal with lightweight curation actions
- selected note can be edited inline for title/body corrections
- selected note can be archived without leaving the Recent surface

### Design rule
Keep this page minimal.
It exists for continuity, not deep triage.

---

## 5.4 Graph

### Goal
Graph is a node-centric neighborhood inspection tool.

### Current behavior
- selected focus node is explicit
- 1-hop / 2-hop radius controls
- relation density summary
- relation legend
- direct click-through to related nodes

### Design rule
Graph should stay user-directed and readable.
It should never become the default landing page or imply that every visible edge is canonical truth.

---

## 5.5 Project Map

### Goal
Project map is the project-scoped graph exploration surface.

### Current behavior
- starts from a selected project node
- renders a bounded project-scoped graph payload from `/api/v1/projects/:id/graph`
- supports canonical/inferred source filters and relation-type filters
- supports timeline emphasis playback and scrubbing without rebuilding the structural graph each tick
- uses a lazy-loaded canvas stack so graph libraries do not inflate the main renderer bundle for every session

### Design rule
Keep this surface bounded and inspectable.
It should explain project structure, not drift into an unbounded global graph browser.

---

## 5.6 Governance

### Goal
Governance protects trust without reviving the old review queue.

### Current behavior
- surfaced contested and low-confidence items
- current state summary and confidence explanation
- click-through into the affected node or relation context
- direct promote, contest, and archive actions for node issues from Governance and node detail
- direct accept, reject, and archive actions for relation issues from Governance
- optional short decision notes with compact review-action logging
- recent manual decision feed across nodes and relations with entity and action filters
- link-out from recent decisions back into notes, graph, or still-open governance issues
- bounded recompute/inspection flows backed by automatic governance state, not a manual approval inbox

### Design rule
Governance should feel operational and explainable.
It should help the user inspect trust signals without creating heavy moderation ceremony.

---

## 5.7 Settings

### Goal
Settings should stay practical and workspace-oriented.

### Current sections
- workspace create/open controls
- current workspace metadata
- import onboarding for Markdown and RecallX JSON exports with preview, normalization, and duplicate handling
- safe handoff guidance for single-writer multi-device use
- semantic and operational settings routed through the local API
- recent workspaces

### Important note
Settings focus more on workspace switching, import onboarding, handoff safety, and operational control than on speculative product preferences.

### Design rule
Only expose settings users can actually act on.
Avoid surfacing internal tuning knobs unless they are operationally necessary.

---

## 6. Right-rail model

The right rail is the main context inspector.

## 6.1 Node detail

### Current sections
- title and type
- summary lifecycle
- source and canonicality
- body
- tags

### Current actions
- Inspect in Graph
- Refresh summary
- Edit title/body from the Recent note modal
- Archive from the Recent note modal
- Reindex selected node

### Design rule
The node detail should present one durable object clearly, and lightweight curation should stay bounded to fast corrections rather than expand into a full editing workspace.

## 6.2 Context rail

### Current sections
- related nodes
- bundle preview
- recent activity
- artifacts

### Important operational behavior
- bundle preview items are clickable
- preview cards may show relation source, relation type, semantic similarity, and retrieval rank
- clicking a relation-backed bundle preview can emit a bounded usage signal (`bundle_clicked`) for retrieval feedback

### Design rule
The right rail should stay compact and scannable.
If more context blocks are added later, they should compete for vertical space deliberately.

---

## 7. Semantic UX

Semantic indexing is currently exposed as an operational surface, not a primary navigation destination.

## 7.1 Home semantic card

### Current behavior
- enabled / disabled state
- provider and model
- pending / processing / stale / ready / failed counts
- last reindex timestamp
- issue filter chips
- issue list with pagination
- workspace reindex action

### Why this belongs on Home
Semantic indexing affects retrieval quality and maintenance operations, but it does not deserve a full page in v1.

## 7.2 Semantic issue handling

### Current behavior
- issues are filterable by `all`, `failed`, `stale`, `pending`
- the list is paginated
- empty filtered states should be explicit

### Design rule
Semantic issue UX should feel like lightweight triage, not a complex admin dashboard.

---

## 8. Quick capture

### Goal
Capture should stay friction-light while still producing useful durable nodes.

### Current behavior
- available on Recent
- node type selector
- optional project association selector with active-project default when one is set
- title
- body
- one-step create action

### Current non-goals
- no rich tagging flow yet
- no command palette shortcut documented yet

### Design rule
Quick capture should stay short and structured.
If more fields are added later, they should remain optional by default.
The active project may prefill the project selector, but it should still be easy to clear or override.

---

## 9. Core workflows

## 9.1 Search-to-context flow
1. user searches
   Search can begin from Home or Recent
2. user optionally narrows scope, node type, or source with lightweight chips
3. user can also narrow activity hits to recent review decisions without rerunning the backend
4. user can also open the command palette for route jump, recent search reuse, recent-node jump, or recent review re-entry
5. user selects a node
6. right rail shows surrounding context
7. user optionally opens graph or acts on bundle preview

### Design rule
Refinement should speed up the existing deterministic loop.
It should not hide the underlying result shape or replace the normal search surface.

## 9.2 Governance inspection flow
1. tool or maintenance pass writes or updates state
2. surfaced governance issues appear when confidence or trust needs inspection
3. user inspects the issue and decides whether a follow-up action is needed
4. user can promote, contest, or archive a node in place, or accept, reject, or archive a relation in place
5. the decision lands in a compact cross-entity recall feed without opening a queue

## 9.3 Context inspection flow
1. user selects a node
2. right rail reveals related nodes and bundle preview
3. user opens a promising bundle item
4. graph inspection is used only when needed

## 9.4 Local integration flow
1. user opens Home
2. user copies HTTP or MCP configuration
3. user verifies file locations and runtime mode
4. user reindexes semantic state if local retrieval maintenance is needed

## 9.5 Active project continuity flow
1. user sets one active project from Home
2. Home shows a lightweight digest with nearby context and recent activity
3. quick capture defaults to that project unless the user overrides it
4. project map falls back to that project when there is no more specific focus

## 9.6 Governance follow-up flow
1. user makes a manual governance decision from Governance
2. the recent decision remains visible in the compact Governance feed
3. when the user returns to Home, a small follow-up card keeps that recent trust history nearby
4. the user can jump back into notes, graph, or Governance without reopening a queue
5. command palette shortcuts can also reopen recent review context or a filtered Governance slice

## 9.7 Review-action recall flow
1. user opens a note or runs a mixed workspace search
2. recent review decisions appear with human-readable labels instead of raw `review_action` text
3. user can narrow activity hits to review decisions only
4. note detail keeps a compact review recall slice with fast jump-back into Governance or graph
5. provenance cues explain what the manual review changed without requiring a second inspection step

### Design rule
This is a continuity loop, not a second navigation system.
The active project should reduce reselection work without hiding other projects.

---

## 10. Visual tone

The current visual direction should stay:
- calm
- compact
- technical but not severe
- readable before decorative

Priorities:
1. reading clarity
2. retrieval speed
3. context discoverability
4. provenance and review trust

Avoid:
- excessive decoration
- giant data tables as the default answer
- graph-first visual storytelling
- heavy motion

---

## 11. What is explicitly not in v1

These are not current UX commitments:
- full project dashboard
- advanced search filtering UI
- edit-then-approve review workflow
- archive/dismiss review queue
- full migration wizard
- dedicated semantic admin page
- broad settings matrix for internal retrieval tuning

These can be added later, but the current product should be documented honestly around what already exists.

---

## 12. Immediate follow-up rules

When updating the renderer, keep this document in sync if any of these change:
- top-level navigation
- Home composition
- right-rail sections
- semantic issue triage behavior
- bundle preview interaction model
- review actions

The UX document should describe the real product, not the product we might build later.
