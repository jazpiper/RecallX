# RecallX UI/UX Redesign Plan

## 1. Goal

This document turns the current RecallX renderer shape into an actionable redesign plan based on the latest Figma direction anchored on:

- file: `RecallX-Redesign`
- file key: `ZNLmItultGoqFoC363f7iR`
- latest reviewed shared entry: `node-id=0:1`

The goal is not to turn RecallX into a generic admin dashboard.
The goal is to preserve RecallX's core product intent while upgrading the shell, information hierarchy, and component system so the product feels:

- faster to re-enter
- more legible under dense knowledge data
- more opinionated and premium
- more modular to evolve
- more consistent across Home, Memory, Graph, Governance, and Workspace flows

This plan assumes the Figma direction should be adopted as strongly as possible while still respecting the existing product guardrails in `../guardrails.md` and `../ux.md`.

## 1.2 Visual direction lock

The redesign should follow:

- Figma direction
- Minimalism
- Micro-interactions
- Flat Design as the baseline visual philosophy

Interpretation rules:

- remove non-essential ornament aggressively
- use whitespace intentionally, not theatrically
- keep typography simple and highly legible
- use a limited color palette with blue as the focused active accent
- prefer clean flat surfaces first, then add depth only where state or hierarchy needs it
- use motion sparingly and only to clarify focus, selection, expansion, or transition

This means:

- no heavy skeuomorphic depth
- no decorative gradients as a primary identity device
- no glassmorphism for its own sake
- no animated flourish that does not improve comprehension

## 1.1 Non-negotiable visual constraints

The redesign must explicitly avoid two failure modes:

1. oversized hero headers
2. long explanatory marketing copy

Hard rules:

- do not use oversized display typography as the main visual trick
- page titles should feel sharp and controlled, not poster-like
- avoid multi-line “manifesto” headings
- avoid paragraph blocks that explain obvious UI meaning
- prefer labels, short summaries, counts, status, and actions over narrative copy
- if a card needs more than 2 short lines of explanation, the information architecture is probably wrong

Practical type rules:

- page titles: compact, typically one line, visually strong but not dominant
- supporting copy: one short sentence max
- card descriptions: one line by default, two short lines only when necessary
- inspector metadata: label-value first, prose second
- no large decorative slogan blocks on Home, Memory, Review, Graph, or Workspace

## 2. Inputs Used

This plan is based on four inputs:

1. current renderer structure in `app/renderer/src/App.tsx`
2. current renderer styling in `app/renderer/src/styles.css`
3. current renderer data model and API shapes in `app/renderer/src/lib/types.ts` and `app/renderer/src/lib/mockApi.ts`
4. the visible `Page1` Figma redesign direction from the `RecallX-Redesign` file

Important note:

- Figma MCP inspection hit a plan limit during analysis, so the Figma input here comes from the public node-specific oEmbed preview for `node-id=0:1` rather than a full node-by-node extraction.
- This is still strong enough for planning because the shell, page families, and visual hierarchy are clearly visible.

## 3. Current Renderer Snapshot

## 3.1 Current app shape

The renderer is still effectively a single-shell app with most state, route branching, and page composition inside `app/renderer/src/App.tsx`.

Current top-level surfaces:

- `Home`
- `Guide`
- `Notes`
- `Workspace`
- utility views for `Graph`, `Project map`, and `Governance`

Current data shape is centered on `WorkspaceSeed`:

- `workspace`
- `nodes`
- `relations`
- `activities`
- `artifacts`
- `integrations`
- `pinnedProjectIds`
- `recentNodeIds`

Current detail flows are centered on:

- `NodeDetail`
- `RelationDetail`
- governance issue/detail payloads
- mixed workspace search results for nodes and activities

## 3.2 Current UX strengths worth preserving

- Home is already retrieval-first rather than folder-first.
- Governance is operational and explainable rather than magical.
- Graph and Project Map are already bounded, not infinite graph theater.
- Workspace operations are practical and local-first.
- Command palette already exists as a fast secondary navigation surface.

## 3.3 Current UX bottlenecks

- `App.tsx` is too large and mixes shell, route logic, data derivation, and page implementation.
- top navigation is split awkwardly between main and utility surfaces, which makes the product map harder to read
- `Guide` competes with product usage surfaces at the same navigation level
- there is no real componentized design system; the product has global CSS tokens but not a reusable UI kit
- routing is state-driven rather than URL-first, which weakens deep linking and app-level clarity
- visual hierarchy is consistent enough to use, but not yet strong enough to feel like a coherent product system

## 4. What The Figma Direction Appears To Introduce

From the latest visible `node-id=0:1` composition, the redesign direction appears to introduce these patterns:

- a stable vertical left rail instead of nav being primarily top-driven
- a central canvas that changes by task type: memory detail, queue/list, graph, or chart surface
- a persistent right-side utility or inspector column for properties, actions, and small status cards
- dark near-black surfaces with electric blue as the main active accent, white for primary CTA, and red for warning or exception states
- very strong panel segmentation: every major cluster reads as a deliberate module rather than a loose card grid
- denser “operator console” layouts with compact metadata, counters, and small charts
- specialized views that still share the same shell language rather than each page inventing its own layout
- graph, review queue, and analytics-like operational modules all living inside one coherent visual system

The latest preview also changes one important interpretation from the earlier pass:

- this is less “multiple separate dashboard pages” and more “one unified application shell expressed across several task-specific views”
- the visual language depends more on density, restraint, and modular rhythm than on oversized typography

This direction is a good fit for RecallX if we translate it carefully:

- keep the product retrieval-first
- use density to improve scanability, not to add noise
- keep graph and operational panels bounded
- avoid adding decorative analytics that do not help memory workflows

## 5. Recommended Target Information Architecture

## 5.1 Navigation model

Replace the current split navigation with one clearer primary shell:

- `Home`
- `Memory`
- `Graph`
- `Review`
- `Workspace`

Supporting global utilities:

- command palette
- global search
- active project switcher
- workspace status
- optional quick capture entry

Route mapping from current app:

- current `Home` stays `Home`
- current `Notes` becomes `Memory`
- current `Graph` and `Project map` merge into one `Graph` surface with mode tabs
- current `Governance` becomes `Review`
- current `Workspace` stays `Workspace`
- current `Guide` moves out of top-level product nav and becomes an `Integrations / API guide` module inside `Workspace` or a secondary docs drawer

This preserves all major capabilities while making the shell easier to understand.

The biggest shell change should be:

- move from topbar-first navigation to sidebar-first navigation
- keep the top row for utility context, search, and page-local controls

## 5.2 Shell layout

Adopt a stable three-zone shell that matches both RecallX UX rules and the Figma direction:

1. left rail
   - brand
   - primary nav
   - active workspace
   - active project
   - quick capture shortcut
2. center canvas
   - current page content
   - search results
   - graph canvas
   - memory detail
   - queue/list views
   - workspace operations
3. right inspector
   - selected node or relation summary
   - provenance
   - related context
   - governance state
   - recent activity
   - action shortcuts
   - local page controls when the current surface needs them

The important product change is not "add more rails".
It is "make contextual inspection stable and spatially predictable".

## 5.3 Page responsibilities

### Home

Home should become the operational re-entry dashboard.

Keep:

- workspace-wide search
- active project digest
- recent movement
- governance follow-up

Add or strengthen:

- one clear hero search input as the main action
- a compact "workspace pulse" band for projects, recent writes, governance signals, and integration health
- curated recent activity grouped by project or relevance
- a persistent "continue where you left off" module
- one large focal panel rather than several equally weighted hero cards

Avoid:

- turning Home into a general analytics dashboard
- overloading Home with settings or raw documentation
- using a giant slogan headline above the search box
- adding explanatory paragraphs when status chips and module titles already say enough

Copy and hierarchy rule:

- headline should be a compact action statement, not branding copy
- supporting text should be one short operational sentence
- most meaning should come from modules, counts, and recency cues

### Memory

Memory should become the main reading and capture surface.

Replace the current "Notes" mental model with a broader memory browser:

- mixed node list with stronger type hierarchy
- better card system for note, decision, project, reference, and question types
- consistent quick-capture row
- richer filters for node type, source, project, and status
- split layout: list or filter rail on the left, primary reading/detail canvas in the center, inspector/actions on the right

This better matches both the latest Figma shell and RecallX's real data model, which is broader than notes.

Copy and hierarchy rule:

- item titles should stay concise and content-led
- summaries should remain compact and scannable
- do not add editorial section intros that slow down browsing
- the reading surface should privilege the actual memory content, not UI explanation

### Graph

Graph should become one unified exploration surface with tabs:

- `Neighborhood`
- `Project map`
- later, optionally `Timeline emphasis`

Keep the bounded behavior, but redesign the surrounding panels:

- top control bar for scope, focus node, relation filters, and source filters
- central graph canvas
- right inspector for selected node or relation
- lower or side cards for legend, density, and related context

The Figma graph frame suggests this surface can look much more intentional without becoming visually noisy.

Copy and hierarchy rule:

- graph controls should be mostly label-driven
- avoid descriptive prose around filters or legends
- use terse helper text only where interaction would otherwise be ambiguous

### Review

Review should be the evolved Governance surface.

Keep the explainable trust model, but present it with stronger structure:

- issue filters and queue navigation on the left
- selected entity narrative and queue cards in the center
- decision actions and provenance in a dedicated inspector column
- recent manual decisions as a secondary continuity stream

Rename emphasis:

- use "Review" as the product label
- keep "Governance" as the internal concept and section heading inside the page

This reduces cognitive friction for new users while preserving the existing product model.

Copy and hierarchy rule:

- issue rows should surface the entity, state, and key reason quickly
- do not wrap trust explanations in long paragraphs
- keep rationale terse, with expandable detail only where necessary

### Workspace

Workspace should hold operational configuration, import/export, backup, safety, and integration setup.

Move current `Guide` content here as one collapsible area:

- `Workspace overview`
- `Imports and backups`
- `Safety`
- `Integrations`
- `HTTP API / MCP guide`

This removes a top-level navigation conflict and makes the product shell feel more product-led than docs-led.

The latest Figma direction suggests Workspace should look less like a settings form dump and more like a structured operations console with:

- status cards
- action panels
- compact forms
- safety and import sections in clearly segmented modules

Copy and hierarchy rule:

- use short operational labels and section headers
- forms should explain only what is necessary to avoid mistakes
- move deep documentation into collapsible or secondary surfaces instead of placing it inline by default

## 5.4 Detailed screen specifications

The sections below turn the high-level IA into implementable page specs.

## 5.4.1 Global shell specification

Desktop shell:

- left sidebar: fixed
- center canvas: flexible primary working area
- right inspector: fixed or semi-fixed depending on page

Left sidebar modules, top to bottom:

1. brand block
2. workspace selector
3. primary navigation
4. active project switcher
5. quick capture action
6. secondary utility links or compact recent items

Top command row, left to right:

1. current page title
2. compact page-local status chips
3. global search trigger or page-local search
4. command palette trigger
5. page-local primary action if needed

Right inspector modules, priority order:

1. selected entity summary
2. actions
3. provenance and trust state
4. related context
5. recent activity
6. artifacts or output links

Shell rules:

- left sidebar and right inspector should feel structurally consistent across pages
- only the center canvas should change dramatically by task
- top command row should remain short and utility-led
- do not let the top row become a second navigation bar

Spacing and density rules:

- prefer more modules with clear framing over fewer oversized cards
- each module should have a clear title, one focal content block, and one action area
- avoid stacking three different information densities inside one card

## 5.4.2 Home specification

Home should answer three questions fast:

1. where am I
2. what changed
3. what should I open next

Center canvas layout:

- row 1: compact page header plus global search
- row 2: workspace pulse strip
- row 3: primary re-entry panel and active project panel
- row 4: recent movement and review signal panels

Required center modules:

- `HomeSearchPanel`
- `WorkspacePulseStrip`
- `ContinuePanel`
- `ActiveProjectPanel`
- `RecentMovementPanel`
- `ReviewSignalsPanel`

Recommended module behavior:

- `HomeSearchPanel`
  - dominant element on the page
  - short title only
  - one search field
  - optional search scope chips
- `WorkspacePulseStrip`
  - 4 to 6 compact stats max
  - no charts unless the chart adds a decision
- `ContinuePanel`
  - reopen recent nodes or recent flows
  - strongest “next action” module
- `ActiveProjectPanel`
  - one selected project, recent activity, quick jump actions
- `RecentMovementPanel`
  - mixed node and activity hits, compact list style
- `ReviewSignalsPanel`
  - contested and low-confidence counts, direct jump into Review

Right inspector on Home:

- active project summary
- selected recent item details
- compact governance summary

Text budget:

- page title: 2 to 4 words
- page subtitle: 1 sentence, under 12 words preferred
- panel titles: 2 to 4 words
- panel body copy: usually none, or 1 short line max

Do:

- let counts, names, timestamps, and states carry meaning
- use one white CTA if there is a single dominant next step

Do not:

- open with a manifesto-style heading
- use Home as a documentation or onboarding essay surface

## 5.4.3 Memory specification

Memory is the main read, scan, and capture environment.

Center canvas layout:

- local filter rail or compact filter row on the left side of canvas
- primary memory list in the middle-left
- selected memory reading panel in the middle-right

Required center modules:

- `MemoryFilterRail`
- `MemoryList`
- `MemoryDetailPane`

Optional center modules:

- `QuickCaptureBar`
- `PinnedProjectContextStrip`

List item requirements:

- node type marker
- title
- one-line summary or first useful line
- project or source tag
- timestamp
- governance or status badge when relevant

Detail pane requirements:

- title row with node type and status
- body content first
- metadata second
- actions third

Right inspector on Memory:

- related nodes
- bundle preview
- recent activity
- artifacts
- provenance and governance

Interaction rules:

- selecting a node should not feel modal-first by default
- inline reading should be the main path
- modal can remain as a secondary focus mode if needed later
- quick capture should stay visible but visually subordinate to reading

Text budget:

- list summaries: one line
- detail meta descriptions: label-value first
- empty states: one sentence max

Do:

- make node type differences obvious through structure and small visual cues
- let the reading pane feel calm and information-dense

Do not:

- make all node types look like generic note cards
- waste vertical space with oversized titles or intro copy

## 5.4.4 Graph specification

Graph is a bounded inspection surface, not a graph toy.

Center canvas layout:

- row 1: graph mode tabs and filters
- row 2: main graph canvas
- row 3: compact legend and structural summary

Required center modules:

- `GraphModeTabs`
- `GraphToolbar`
- `GraphCanvas`
- `GraphLegendPanel`

Mode behavior:

- `Neighborhood`
  - focus node selector
  - hop controls
  - relation filter
  - canonical or inferred toggle
- `Project map`
  - focus project selector
  - timeline emphasis if enabled
  - relation group filters

Right inspector on Graph:

- selected node or relation summary
- structural metadata
- trust state
- quick jump to Memory or Review

Graph display rules:

- the graph must remain visually quiet enough that selected nodes stand out immediately
- blue strokes should mark active or selected structures, not every edge equally
- side metrics should support interpretation, not compete with the canvas

Text budget:

- almost all copy should be labels
- helper text only for one ambiguous control at a time

Do:

- make the graph feel embedded in the product shell
- keep the inspector useful enough that users do not need a second detail modal

Do not:

- add prose-heavy interpretation cards
- overload the view with decorative legends, tutorial copy, or analytics filler

## 5.4.5 Review specification

Review should feel like a clear triage console for trust-sensitive items.

Center canvas layout:

- left subcolumn: issue filters and issue queue
- middle subcolumn: selected issue narrative and evidence

Required center modules:

- `ReviewFilterPanel`
- `ReviewIssueQueue`
- `ReviewIssueDetail`
- `ReviewDecisionFeed`

Issue queue row requirements:

- entity type
- title
- one-line reason
- confidence
- state badge
- recency if meaningful

Issue detail requirements:

- what the issue is
- why it is surfaced
- linked node or relation context
- what action is available now

Right inspector on Review:

- decision actions
- provenance
- prior related decisions
- linked context and jump actions

Decision action rules:

- actions should stay visually grouped and easy to scan
- destructive or negative actions use restrained red accents
- the default next action should be visually clear without oversizing the button

Text budget:

- issue reason: one line in the queue
- detail rationale: short bullets or compact lines
- notes and decision history can expand, but not in the default dense view

Do:

- make it easy to compare issues quickly
- keep state, confidence, and reason visible at the same time

Do not:

- turn Review into a moderation essay workflow
- bury actions under long trust explanations

## 5.4.6 Workspace specification

Workspace is the operational control room.

Center canvas layout:

- row 1: workspace identity and status
- row 2: create or open workspace actions plus recent workspaces
- row 3: safety, backup, export, restore, and import modules
- row 4: integrations and API or MCP guide

Required center modules:

- `WorkspaceStatusPanel`
- `WorkspaceSwitcherPanel`
- `RecentWorkspacesPanel`
- `WorkspaceSafetyPanel`
- `BackupRestorePanel`
- `ImportPanel`
- `IntegrationAccessPanel`

Right inspector on Workspace:

- current workspace metadata
- bind and auth state
- recent operations
- selected import or backup record details

Operational rules:

- actions should be grouped by lifecycle
- forms should be short and explicit
- advanced operational guidance should be collapsed or segmented

Text budget:

- module intros: one short sentence max
- form helper text: one line only when the action is risky
- guide content should default closed or secondary

Do:

- make risky actions legible and calm
- show the current workspace state before asking the user to change it

Do not:

- dump the entire API guide inline above operational actions
- use verbose technical prose in the default view

## 5.4.7 Responsive behavior

Desktop:

- preserve three-zone shell whenever possible

Tablet:

- collapse right inspector into a drawer or stacked lower panel
- keep left navigation visible if space permits

Mobile:

- navigation becomes drawer-based
- right inspector becomes a bottom sheet or segmented detail view
- page header stays compact
- no large hero title expansion on small screens

Responsive rules:

- do not solve small screens by increasing copy
- reduce module count before increasing text
- keep primary action discoverable in the first viewport

## 5.4.8 Copy density budget

Default copy budget per page:

- page title: 1 line
- page subtitle: 0 to 1 sentence
- module title: 1 line
- module description: usually 0 to 1 line
- empty state: 1 sentence
- button labels: 1 to 3 words preferred

If a page exceeds these budgets, redesign the module structure before adding more text.

## 6. Design System Translation Plan

## 6.1 Design principles

The new system should express:

- dark, local, focused atmosphere
- minimalist discipline
- flat-design clarity
- precise cobalt emphasis rather than generic blue gradients everywhere
- stronger visual contrast between content tiers
- restrained motion
- clear state semantics for healthy / warning / contested / active
- readability first under dense mixed data
- control-console discipline instead of decorative futurism

The system should not express:

- oversized editorial hero text
- speculative marketing language
- excessive whitespace that hides useful information
- long “AI product” explanations inside primary task surfaces
- ornamental depth without functional value
- decorative motion without interaction value

## 6.2 Tokens to formalize

Move from loose CSS custom properties toward explicit renderer tokens.

Create token groups for:

- color
  - background tiers
  - panel tiers
  - borders
  - text tiers
  - accent
  - semantic state colors
- typography
  - display
  - section title
  - body
  - mono
- spacing
  - layout gaps
  - card padding
  - page padding
- radius
  - shell
  - panel
  - chip
  - input
- elevation
  - shell
  - floating card
  - overlay
- motion
  - hover
  - panel transitions
  - modal transitions

Recommended file direction:

- `app/renderer/src/design/tokens.ts`
- `app/renderer/src/design/themes/dark.ts`
- `app/renderer/src/design/types.ts`

CSS variables can still be the runtime output, but token ownership should move out of one giant stylesheet.

Add explicit typography constraints to the token layer:

- `pageTitle`
- `sectionTitle`
- `moduleTitle`
- `body`
- `meta`
- `mono`

Important:

- do not create a giant `displayHero` scale unless a later branded landing page truly needs it
- app surfaces should mostly live in compact title scales

## 6.3 Core components to introduce

Create a reusable component layer before page-by-page redesign.

Foundational shell:

- `AppFrame`
- `SidebarNav`
- `TopCommandBar`
- `InspectorRail`
- `PageHeader`
- `StatusStrip`

Data display:

- `MetricCard`
- `EntityCard`
- `ActivityFeed`
- `ContextBundleList`
- `GovernanceStateBadge`
- `RelationChip`
- `PropertyList`
- `CompactStatRow`
- `InlineReason`

Interaction:

- `GlobalSearchInput`
- `FilterChipGroup`
- `SegmentedTabs`
- `PanelToolbar`
- `EmptyState`
- `CommandPaletteModal`
- `RightInspectorSection`
- `SelectionSummaryCard`
- `CompactEmptyState`

Graph and workspace-specific:

- `GraphPanel`
- `GraphLegendCard`
- `WorkspaceSafetyCard`
- `ImportPreviewCard`
- `IntegrationGuidePanel`

## 6.4 Visual patterns to carry from Figma

Based on the latest visible frames, the system should intentionally carry these motifs:

- bright blue focus lines for active states and selected panels
- compact metric strips and small operational counters
- compact but high-contrast headings for key page identity
- inset control panels with strong border framing
- sparse but deliberate chart and graph strokes
- mostly flat dark surfaces with only minimal depth cues where hierarchy needs help
- white high-contrast CTA buttons used sparingly for the one primary next action
- narrow right-column action stacks instead of scattering buttons across the canvas

These should be used as a system, not sprinkled ad hoc.

Text usage rule for components:

- every reusable component should assume compact copy by default
- components should not require long body text to feel visually balanced
- spacing should be tuned for dense operational content, not marketing blocks

Motion rule for components:

- every micro-interaction should answer one of these: what changed, what is selected, what expanded, what completed
- transitions should be short and calm
- if motion feels decorative, cut it

## 7. Data-to-UI Mapping

The redesign should follow the existing data model instead of inventing dashboard filler.

## 7.1 Home mappings

- `workspace` -> workspace identity, local bind, integration mode, safety state
- `pinnedProjectIds` + project nodes -> active project shelf
- `recentNodeIds` -> continue/re-entry strip
- `searchWorkspace` mixed results -> hero search results and recent movement
- governance issue and event APIs -> review signal cards

## 7.2 Memory mappings

- `nodes` -> primary memory cards
- `relations` -> quick related context counts and chips
- `activities` -> per-node activity trail
- `artifacts` -> linked outputs and attachments
- `NodeDetail` -> persistent inspector content

## 7.3 Graph mappings

- graph neighborhood payload -> main network canvas
- project graph payload -> project map tab
- relation source and type -> filter bar and legend
- selected node or relation -> inspector stack

## 7.4 Review mappings

- governance issues -> queue list
- governance state -> trust summary card
- governance events -> recent decision stream
- node/relation detail payloads -> entity context and rationale

## 7.5 Workspace mappings

- workspace catalog -> workspace switcher
- safety data -> operational warnings
- backup/export/import records -> lifecycle panels
- integration and bootstrap data -> API/MCP setup module

## 8. Suggested Technical Refactor Path

The redesign should not start with CSS repainting.
It should start with shell and ownership cleanup.

Before implementation, define two lint-like design rules for the renderer work:

- no oversized page headers without explicit approval
- no default explanatory paragraph blocks added to page headers or cards

## Phase 0. Audit and alignment

- confirm the Figma `Page1` frame set in detail once full MCP access or exported captures are available
- decide the final navigation names
- freeze page responsibilities before visual implementation

Output:

- approved IA map
- approved token direction
- approved page priority order

## Phase 1. Shell extraction

Break `App.tsx` into route-owned page modules and shell modules.

Suggested structure:

- `app/renderer/src/shell/AppFrame.tsx`
- `app/renderer/src/shell/SidebarNav.tsx`
- `app/renderer/src/shell/TopCommandBar.tsx`
- `app/renderer/src/shell/InspectorRail.tsx`
- `app/renderer/src/pages/HomePage.tsx`
- `app/renderer/src/pages/MemoryPage.tsx`
- `app/renderer/src/pages/GraphPage.tsx`
- `app/renderer/src/pages/ReviewPage.tsx`
- `app/renderer/src/pages/WorkspacePage.tsx`

Goals:

- reduce `App.tsx` orchestration burden
- make page-by-page redesign safer
- prepare for stable right-rail context composition
- move the app from topbar-first layout logic to sidebar-first shell ownership

## Phase 2. Design system foundation

- introduce token files
- introduce panel, badge, toolbar, and input primitives
- migrate existing CSS variables into grouped design tokens
- define semantic state mappings once

Goals:

- stop repeating ad hoc visual rules
- make the Figma direction reusable across pages

## Phase 3. Home and Memory redesign

Start where users feel the redesign most:

- Home first
- Memory second

These surfaces validate:

- new shell
- new search hierarchy
- new card system
- new inspector rail
- the new “large center canvas + narrow action column” layout model

## Phase 4. Review redesign

Rebuild Governance as `Review` with:

- clearer queue structure
- stronger selected-entity storytelling
- better action grouping
- improved provenance readability

## Phase 5. Graph redesign

Rebuild Graph inside the new shell with:

- integrated tab model for neighborhood vs project map
- refined control hierarchy
- cleaner canvas framing
- stable inspector synchronization

## Phase 6. Workspace and integrations cleanup

- move Guide into Workspace
- redesign setup and operational panels
- keep docs accessible but visually subordinate to product usage

## Phase 7. Polish and hardening

- responsive passes
- motion pass
- dark theme contrast pass
- keyboard navigation pass
- hot path profiling for Home, search, palette, and inspector rendering

## 9. Priority Order

Recommended implementation order:

1. shell extraction
2. navigation consolidation
3. token and primitive layer
4. Home redesign
5. Memory redesign
6. Review redesign
7. Graph redesign
8. Workspace redesign
9. Guide relocation and cleanup

This order gives visible value early without risking the graph or review surfaces before the shell is stable.

Within each page redesign, use this micro-order:

1. define module layout
2. define data mapping
3. define compact text hierarchy
4. implement interaction states
5. only then tune visual polish

## 10. Risks and Guardrails

## 10.1 Biggest risks

- overfitting to a dashboard aesthetic and losing RecallX restraint
- spending too long on visuals before reducing `App.tsx` complexity
- turning Review into a heavy moderation console
- keeping `Guide` as top-level even after the new shell clarifies the product
- adding too many decorative metrics that are not anchored to real RecallX data
- copying Figma panel density literally without adapting it to actual RecallX task flows

## 10.2 Guardrails for implementation

- every new panel must map to existing or clearly planned data
- Home stays retrieval-first
- Graph stays secondary and bounded
- Review stays explainable
- Workspace stays practical
- command palette remains globally accessible
- right-rail context remains persistent wherever possible
- large headers require explicit justification
- explanatory copy must be cut aggressively unless it prevents a real usability error
- if a surface feels empty without long copy, add better data modules instead of more text

## 11. Concrete Next Actions

Before implementation starts, the next practical outputs should be:

1. export or inspect the latest `node-id=0:1` frames at full fidelity and identify the exact page/component names
2. approve the new navigation labels: `Home / Memory / Graph / Review / Workspace`
3. create a renderer IA diagram showing left rail, center canvas, and inspector rail responsibilities
4. split `App.tsx` into page modules without changing behavior
5. implement the new token and primitive layer
6. redesign Home first as the proving ground for the system

## 12. Recommended Definition Of Done For The Redesign

The redesign should be considered successful when:

- the shell is modular rather than `App.tsx`-centric
- the product map is easier to understand in one glance
- Home is a stronger retrieval and continuation surface
- Memory better represents RecallX's mixed node model than the current Notes view
- Review feels clear and trustworthy
- Graph feels integrated but still bounded
- Workspace absorbs setup and guide responsibilities cleanly
- the visual system is identifiable and reusable, not page-specific
- performance and inspectability remain aligned with RecallX guardrails
