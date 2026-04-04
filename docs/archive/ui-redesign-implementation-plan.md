# RecallX UI Redesign Implementation Plan

## 1. Goal

This document turns the redesign direction into an implementation order for the renderer.

It assumes:

- latest design reference is the shared `node-id=0:1` direction
- visual style remains Figma + Minimalism + Micro-interactions
- Flat Design is the baseline
- oversized headers and verbose explanatory copy are not allowed

## 2. Workstream map

There are four implementation workstreams:

1. shell architecture
2. design system primitives
3. page migrations
4. polish and validation

These should not be tackled in the reverse order.
Do not start with styling details before shell ownership is fixed.

## 3. Phase order

## Phase 0. Lock design rules

Deliverables:

- final navigation labels
- compact typography rules
- motion policy
- color and state rules

Output files:

- update `ui-redesign-plan.md`
- update `ui-redesign-wireframes.md`

## Phase 1. Shell extraction

Goal:

- get `App.tsx` out of the critical path for every page redesign

Suggested file targets:

- `app/renderer/src/shell/AppFrame.tsx`
- `app/renderer/src/shell/SidebarNav.tsx`
- `app/renderer/src/shell/TopCommandBar.tsx`
- `app/renderer/src/shell/InspectorRail.tsx`
- `app/renderer/src/pages/HomePage.tsx`
- `app/renderer/src/pages/MemoryPage.tsx`
- `app/renderer/src/pages/GraphPage.tsx`
- `app/renderer/src/pages/ReviewPage.tsx`
- `app/renderer/src/pages/WorkspacePage.tsx`

Required outcome:

- current behavior preserved
- navigation ownership moved into shell components
- route/page ownership separated from renderer-wide state orchestration

## Phase 2. Token system and primitives

Goal:

- define the design system before page repainting

Suggested file targets:

- `app/renderer/src/design/tokens.ts`
- `app/renderer/src/design/themes/dark.ts`
- `app/renderer/src/design/types.ts`
- `app/renderer/src/components/primitives/*`

Core primitive build order:

1. `PageHeader`
2. `StatusStrip`
3. `PanelToolbar`
4. `SelectionSummaryCard`
5. `CompactStatRow`
6. `GovernanceStateBadge`
7. `FilterChipGroup`
8. `GlobalSearchInput`
9. `RightInspectorSection`
10. `CompactEmptyState`

Hard rule:

- no giant `displayHero` token
- no primitive should require long copy to look complete

## Phase 3. Home migration

Goal:

- prove the shell and module rhythm on the most important entry surface

Required modules:

- `HomeSearchPanel`
- `WorkspacePulseStrip`
- `ContinuePanel`
- `ActiveProjectPanel`
- `RecentMovementPanel`
- `ReviewSignalsPanel`

Dependencies:

- shell extracted
- tokens present
- search input and status primitives complete

Done when:

- Home uses the new sidebar-first shell
- title remains compact
- global search is the dominant action
- no oversized header or explanatory copy sneaks in

## Phase 4. Memory migration

Goal:

- move from a “Notes page” into a broader memory workspace

Required modules:

- `MemoryFilterRail`
- `MemoryList`
- `MemoryDetailPane`
- `QuickCaptureBar`

Dependencies:

- shell stable
- list and detail primitives complete
- right inspector composition stable

Done when:

- inline reading becomes the default path
- node types feel structurally distinct
- quick capture remains visible but secondary

## Phase 5. Review migration

Goal:

- make Governance operational and faster to scan

Required modules:

- `ReviewFilterPanel`
- `ReviewIssueQueue`
- `ReviewIssueDetail`
- `ReviewDecisionFeed`

Dependencies:

- badge and state primitives complete
- right inspector action grouping complete

Done when:

- queue rows are fast to compare
- actions are visually grouped
- reasoning is concise by default

## Phase 6. Graph migration

Goal:

- unify neighborhood and project map under one shell

Required modules:

- `GraphModeTabs`
- `GraphToolbar`
- `GraphCanvas`
- `GraphLegendPanel`

Dependencies:

- shell stable
- inspector synchronization stable
- graph control primitives complete

Done when:

- selected nodes stand out immediately
- graph view feels integrated with the app shell
- side metrics stay secondary to the canvas

## Phase 7. Workspace migration

Goal:

- turn Workspace into a structured operations console

Required modules:

- `WorkspaceStatusPanel`
- `WorkspaceSwitcherPanel`
- `RecentWorkspacesPanel`
- `WorkspaceSafetyPanel`
- `BackupRestorePanel`
- `ImportPanel`
- `IntegrationAccessPanel`

Dependencies:

- form primitives complete
- action feedback states complete

Done when:

- operational actions are grouped cleanly
- guide content is secondary or collapsible
- risky actions are legible without long helper text

## Phase 8. Guide relocation

Goal:

- remove `Guide` from top-level navigation

Tasks:

- move HTTP API / MCP guidance into Workspace modules
- preserve discoverability
- avoid turning Workspace into a long doc page

Done when:

- top-level nav is reduced to `Home / Memory / Graph / Review / Workspace`

## Phase 9. Motion and polish

Goal:

- add only the micro-interactions that improve comprehension

Allowed motion targets:

- hover feedback
- selection transitions
- disclosure expand/collapse
- action progress
- graph focus transitions

Done when:

- motion clarifies state
- motion stays short and calm
- motion never becomes the main visual identity

## 4. File-level implementation priority

Priority 1:

- `app/renderer/src/App.tsx`
- new `shell/*`
- new `pages/*`

Priority 2:

- new `design/*`
- shared primitives

Priority 3:

- Home and Memory page modules

Priority 4:

- Review and Graph page modules

Priority 5:

- Workspace and Guide relocation

## 5. Validation order

Docs and planning are not enough once implementation begins.
Use this validation sequence during the actual build:

1. local slice validation after each page migration
2. `npm run check`
3. relevant renderer tests
4. `npm run build`

Design validation checklist:

- title scale stayed compact
- explanatory copy stayed minimal
- right rail remained useful
- shell feels consistent across pages
- blue accent is restrained
- whitespace supports clarity rather than emptiness

## 6. Anti-drift checklist

Before accepting any page implementation, ask:

- did we add a big header because the layout felt weak
- did we add explanatory text because the module hierarchy was unclear
- did we add decorative depth because spacing and framing were unresolved
- did motion become more visible than state change itself

If the answer is yes, redesign the module, not the copy.

## 7. Recommended execution queue

Recommended queue:

1. shell extraction
2. token layer
3. primitives
4. Home
5. Memory
6. Review
7. Graph
8. Workspace
9. Guide relocation
10. motion and polish

Stop rule:

- do not open the next page migration until the current page has both structural clarity and compact copy discipline

## 8. Definition of done

The redesign implementation is done when:

- shell ownership no longer depends on one giant page component
- every core page uses the same sidebar-first structure
- right inspector works as a stable context surface
- typography stays compact
- explanatory text is minimal
- micro-interactions are present but restrained
- the renderer still feels fast, local, and inspectable
