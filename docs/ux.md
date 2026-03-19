# Memforge — UX Design

## 1. Purpose

This document describes the current Memforge desktop UX and the product rules that should guide future UI changes.

Memforge should feel:
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
- review pending items
- reindex or diagnose semantic state when needed

---

## 3. Current app shape

Memforge currently ships as a 3-pane desktop shell.

### Left sidebar
- workspace identity
- top-level navigation
- quick capture entry
- pinned projects
- recent nodes

### Center pane
- Home
- Search
- Projects
- Recent
- Review
- Graph
- Settings

### Right pane
- selected node detail
- related nodes
- context bundle preview
- recent activity
- artifacts

This shape is correct for v1 because it keeps retrieval and inspection near each other without making graph or settings dominate the product.

---

## 4. Information architecture

Top-level navigation stays intentionally small:
- Home
- Search
- Projects
- Recent
- Review
- Graph
- Settings

Supporting navigation stays lightweight:
- pinned projects
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
- workspace / pinned / review summary cards
- API & MCP connection examples
- semantic indexing status card
- file and app path cards
- quick capture form
- recent activity trail

### Important notes
- Home currently does not include a search bar
- Home intentionally mixes product usage and local operations because Memforge is both an app and a local memory service
- semantic indexing belongs here as an operational card, not as a dedicated page

### Design rule
Home should remain a compact re-entry surface, not expand into analytics or system-monitor sprawl.

---

## 5.2 Search

### Goal
Search is the main retrieval surface.

### Current behavior
- one query input
- summary-first result cards
- cards show title, type, summary, source label, and updated time
- clicking a result updates the selected node and right-hand context rail

### Current non-goals
- no advanced filters yet
- no project-only toggle yet
- no explicit “why relevant” explanation yet

### Design rule
Keep search fast and summary-first.
If richer filters are added later, they should stay narrow and obviously useful.

---

## 5.3 Projects

### Goal
Projects is currently a lightweight project launcher, not a dedicated project dashboard.

### Current behavior
- pinned project list in the center pane
- click-through into the shared node detail + context rail on the right

### Important note
There is no separate project detail layout yet.
Until one exists, project understanding comes from:
- project selection
- node detail
- context rail
- graph inspection

### Design rule
Do not pretend there is a richer project surface than actually exists.
Future project dashboards should only land if they are materially better than the current node-plus-context pattern.

---

## 5.4 Recent

### Goal
Recent is the quickest way back to recently touched nodes.

### Current behavior
- simple list of recently touched nodes
- summary-first cards
- click-through to selected node detail

### Design rule
Keep this page minimal.
It exists for continuity, not deep triage.

---

## 5.5 Review

### Goal
Review protects trust without feeling heavy.

### Current behavior
- list of pending review items
- basic metadata
- approve / reject actions

### Current non-goals
- no edit-then-approve flow yet
- no archive / dismiss controls yet
- no dedicated review detail panel yet

### Design rule
The review queue should feel manageable.
When richer actions are added later, they should still preserve the lightweight feel.

---

## 5.6 Graph

### Goal
Graph is an inspection tool.

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

## 5.7 Settings

### Goal
Settings should stay practical and workspace-oriented.

### Current sections
- workspace create/open controls
- current workspace metadata
- review policy
- trusted source tools
- recent workspaces

### Important note
Settings currently focus more on review policy and workspace switching than on import/export or integration-specific controls.

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
- Reindex selected node

### Design rule
The node detail should present one durable object clearly, not turn into an all-in-one editor.

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
- available on Home
- node type selector
- title
- body
- one-step create action

### Current non-goals
- no project association field yet
- no rich tagging flow yet
- no command palette shortcut documented yet

### Design rule
Quick capture should stay short and structured.
If more fields are added later, they should remain optional by default.

---

## 9. Core workflows

## 9.1 Search-to-context flow
1. user searches
2. user selects a node
3. right rail shows surrounding context
4. user optionally opens graph or acts on bundle preview

## 9.2 Review flow
1. tool or agent writes a suggestion
2. item appears in review queue if needed
3. user approves or rejects quickly

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
- archive/dismiss review flows
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
