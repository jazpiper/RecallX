# Personal Neural Workspace — UX Design

## 1. Purpose

This document defines the human-facing UX for Personal Neural Workspace.

The UI should make the product feel:
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

The UX should help users do four things well:
1. capture durable knowledge
2. retrieve context quickly
3. inspect relationships and provenance
4. review what tools and agents added

---

## 2. UX principles

## 2.1 Search before browse
Users should be able to get to relevant knowledge quickly.
The product should feel retrieval-first, not folder-first.

## 2.2 Context should be visible, not hidden
When viewing a node or project, the user should immediately see surrounding context:
- related nodes
- decisions
- open questions
- recent activities
- provenance

## 2.3 The UI should stay restrained
The system may be conceptually rich, but the UI should expose only a small number of clear surfaces.

## 2.4 Human control matters
The user should feel in control of:
- what is canonical
- what tools wrote
- what should be promoted or rejected
- what is part of the hot path

## 2.5 Graph is secondary
Graph visualization is useful, but it should support understanding, not dominate the product.

## 2.6 Fast paths should be obvious
Common actions should be quick:
- capture a note
- search a project
- inspect context
- generate a context bundle
- review incoming agent output

---

## 3. Primary user posture

The product should assume the primary user is:
- a single local user
- technically comfortable
- often working across several AI tools
- more interested in continuity than decoration

This means the UI should optimize for:
- compactness
- speed
- clarity
- explainability

over broad onboarding or consumer-style guidance.

---

## 4. Recommended app shape

## Core shape
A **3-pane local desktop app**.

### Left pane
Navigation and workspace access.

### Center pane
Primary content surface:
- home
- search results
- node detail
- project detail
- review queue

### Right pane
Context inspector:
- related nodes
- decisions
- open questions
- recent activities
- provenance
- artifacts

### Why this shape fits
- familiar enough to learn quickly
- supports retrieval and inspection naturally
- works well for project-centered memory
- keeps graph as optional rather than central

---

## 5. Information architecture

The first navigation model should stay simple.

## Primary top-level surfaces
- Home
- Search
- Projects
- Recent
- Review
- Graph
- Settings

## Supporting pinned items
- pinned projects
- recently accessed nodes
- maybe favorite searches later

### Important note
Do not introduce too many top-level surfaces early.
If a surface does not clearly support capture, retrieval, context inspection, or review, it probably does not belong in v1.

---

## 6. Layout details

## 6.1 Left sidebar
### Purpose
Fast navigation, not deep system management.

### Recommended contents
- workspace name
- quick capture button
- top-level nav links
- pinned projects
- recent nodes
- maybe integration status indicator later

### Avoid
- deep nested trees
- huge folder hierarchies
- too many counters and badges
- heavy configuration visibility on every screen

---

## 6.2 Center pane
### Purpose
Primary reading, editing, searching, and review surface.

### Should support
- keyboard-focused workflows
- readable note/project content
- low visual clutter
- clear hierarchy

### Default mental model
The center pane is where the user looks at the current working object.

---

## 6.3 Right context pane
### Purpose
Turn isolated content into connected memory.

### Typical sections
- related nodes
- project context
- decisions
- open questions
- recent activity
- provenance
- artifacts

### Important rule
This pane should be compact and scannable.
It should not become a second full app crammed into the side panel.

---

## 7. Core screens

## 7.1 Home
### Goal
Provide a fast re-entry point into the workspace.

### Recommended sections
- search bar at top
- pinned projects
- recent nodes
- recent meaningful activity
- review queue highlights
- optionally “active context” for recently touched projects

### Home should answer
- what was I working on?
- what changed recently?
- what needs review?
- where do I jump back in?

### Home should not become
- a giant dashboard
- analytics-heavy
- visually overloaded

---

## 7.2 Search
### Goal
This is one of the most important views.
It should feel extremely fast.

### Search inputs
- query text
- optional filters:
  - type
  - project
  - source
  - status
  - date range later if needed

### Search result card should show
- title
- type
- short summary
- project or parent context if relevant
- source label
- updated time
- maybe why-relevant hint later

### Search modes
- default unified search
- optional quick toggle to project-only / decisions-only later

### Important rules
- results should be summary-first
- avoid loading full bodies by default
- filters should stay small and useful

---

## 7.3 Node detail
### Goal
Show one durable knowledge object with enough surrounding context to make it useful.

### Core sections in center pane
- title
- type / status / source metadata
- body
- tags
- editable fields

### Right pane sections
- related nodes
- open questions
- linked decisions
- recent activities
- provenance events
- attached artifacts

### Key actions
- edit node
- archive node
- copy link/id
- generate context bundle from this node
- create relation

### UX goal
A node should never feel like an isolated text blob.
It should feel like an addressable part of a larger memory system.

---

## 7.4 Project view
### Goal
Provide a human-readable equivalent of a project context bundle.

### Recommended sections
- project summary
- key decisions
- active questions
- important linked nodes
- recent activities
- related artifacts
- quick context actions

### Key actions
- generate `micro` / `compact` context
- pin project
- review incoming project-related writes
- add note / idea / decision under project

### UX goal
A user should be able to understand the current state of a project in under a minute.

---

## 7.5 Review queue
### Goal
Protect quality and trust.

### Reviewable items
- suggested relations
- suggested nodes
- promotion candidates
- archive proposals
- canonical edit suggestions

### Required item details
- what changed or is proposed
- source tool / actor
- timestamp
- target node(s)
- quick preview

### Required actions
- approve
- reject
- edit then approve
- archive / dismiss where appropriate

### UX rule
The review queue should feel lightweight and manageable.
It should not feel like enterprise moderation software.

---

## 7.6 Graph view
### Goal
Support inspection and orientation, not serve as the main working surface.

### Good uses
- inspect local neighborhood around a node
- inspect project-centered network
- understand relation density
- debug odd link behavior

### Avoid
- making the graph the default landing page
- forcing users into global graph exploration
- treating visual complexity as product value

### Recommendation
Default graph to:
- selected node center
- 1–2 hop radius
- simple relation coloring

Keep it readable.

---

## 7.7 Settings
### Goal
Keep settings compact and practical.

### Early settings sections
- workspace root
- local API status
- integration access settings
- export/import settings
- maybe performance/debug settings later

### Avoid
- giant preferences matrix
- exposing every internal tuning knob too early

---

## 8. Key interactions

## 8.1 Quick capture
### Entry points
- sidebar button
- keyboard shortcut
- maybe command palette later

### Output targets
- note
- idea
- question
- decision

### Required fields
- title optional initially
- body
- optional project association
- optional tags

### Goal
Capture should be friction-light but still structured enough to remain useful later.

---

## 8.2 Search-to-context flow
### Flow
1. user searches
2. sees summary-first results
3. opens node/project
4. inspects right-pane context
5. optionally generates external context bundle

### Why this matters
This is likely one of the most common workflows.

---

## 8.3 Agent write review flow
### Flow
1. tool writes an append or suggestion
2. item appears in review queue if high-impact
3. user previews source and content
4. user approves / edits / dismisses

### UX goal
Keep this flow fast enough that users will actually do it.

---

## 8.4 Context handoff flow
### Flow
1. user opens project or node
2. user chooses preset + budget (`micro`, `compact`, etc.)
3. UI shows preview of bundle
4. user copies, exports, or triggers CLI/API handoff

### Why this matters
The product should make human-to-agent and agent-to-human transitions feel natural.

---

## 9. Command and keyboard model

The product should support keyboard-heavy users.

## Recommended early shortcuts
- quick capture
- focus search
- open command palette later if needed
- next/previous recent item
- approve/reject in review queue

### Important rule
Do not overbuild keyboard systems early.
Implement the few that improve daily speed significantly.

---

## 10. Visual hierarchy and tone

## Recommended tone
- calm
- compact
- professional
- slightly technical
- not playful or noisy

## Visual priorities
1. search and reading clarity
2. context discoverability
3. provenance visibility
4. review simplicity

## Avoid
- excessive cards everywhere
- giant data tables by default
- excessive motion
- decorative graph-first visuals

---

## 11. Provenance UX

Provenance is not just backend metadata.
It should be visible and understandable.

## Recommended provenance display
- source label chip near content
- last updated by / when
- expandable provenance history in side pane or node section

### Example labels
- Human
- OpenClaw
- Claude Code
- Codex
- Gemini CLI
- Import

### UX goal
The user should rarely wonder: “Where did this come from?”

---

## 12. Context pane section priorities

The right pane should not show everything equally.

## Recommended order for node detail
1. related nodes
2. project context
3. decisions
4. open questions
5. recent activities
6. provenance
7. artifacts

## Recommended order for project view
1. key decisions
2. open questions
3. important linked nodes
4. recent activities
5. artifacts
6. provenance summary

This ordering reflects likely usefulness in real workflows.

---

## 13. MVP UX scope

To protect speed and focus, the MVP UI should include only:

- Home
- Search
- Node detail
- Project view
- Review queue
- minimal Graph view
- Settings basics

### Explicitly not required for MVP
- rich collaboration UI
- complex dashboards
- visual query builders
- timeline explorer
- deep graph analytics
- multi-workspace cloud switching
- chat-first AI surface

---

## 14. Wireframe-level layout sketches

## 14.1 Home
```text
+--------------------------------------------------------------+
| Sidebar      | Search bar                                    |
|              |-----------------------------------------------|
| Home         | Pinned Projects                               |
| Search       |  - Project A                                  |
| Projects     |  - Project B                                  |
| Review       |                                               |
| Graph        | Recent Nodes                                  |
| Settings     |  - Idea X                                     |
|              |  - Decision Y                                 |
| Pinned Proj  |                                               |
| Recent       | Review Needed                                 |
|              |  - 2 relation suggestions                     |
+--------------------------------------------------------------+
```

## 14.2 Node detail
```text
+--------------------------------------------------------------------------------+
| Sidebar      | Node Title                               | Context Pane          |
|              | Type / status / source                   |-----------------------|
| Search       |------------------------------------------| Related Nodes         |
| Projects     | Body                                     | Decisions             |
| Review       |                                          | Open Questions        |
| Graph        |                                          | Recent Activity       |
|              |                                          | Provenance            |
|              |                                          | Artifacts             |
+--------------------------------------------------------------------------------+
```

## 14.3 Review queue
```text
+--------------------------------------------------------------------------------+
| Sidebar      | Review Items                             | Preview / Details     |
|              |------------------------------------------|-----------------------|
| Review       | [Relation Suggestion]                    | source: Claude Code   |
|              | [Suggested Note]                         | target: Project A     |
|              | [Promotion Candidate]                    | diff/preview          |
|              |                                          | [Approve] [Reject]    |
|              |                                          | [Edit then Approve]   |
+--------------------------------------------------------------------------------+
```

---

## 15. UX risks to avoid

### 1) Turning Home into a dashboard monster
The home view should be a re-entry point, not an analytics cockpit.

### 2) Making Search too slow or too smart
Search must feel immediate. Relevance can improve over time, but latency must stay low.

### 3) Letting the graph dominate the product identity
The graph supports understanding. It is not the core workflow.

### 4) Hiding provenance behind too many clicks
Trust drops quickly if provenance is hard to inspect.

### 5) Overloading the right pane
If the context pane becomes too dense, it stops being useful.

### 6) Too many modes too early
A small number of strong surfaces is better than mode sprawl.

---

## 16. Summary

The right human UI for Personal Neural Workspace is a restrained local desktop app built around:
- search
- node/project reading
- surrounding context
- provenance
- review

It should feel less like a productivity suite and more like a calm memory browser and curation console.

That is the best way to keep the product fast, trustworthy, and aligned with its purpose.
