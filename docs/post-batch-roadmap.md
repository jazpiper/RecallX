# RecallX - Post Batch Roadmap

This document captures the recommended next batch after item 01 through item 05 shipped:

- Home re-entry refresh
- project-aware capture
- lightweight note curation
- import onboarding
- workspace safety automation

The goal is to keep the next step small, product-shaped, and aligned with the current renderer and local-first guardrails.

## Roadmap mode

This document is currently a rolling roadmap, not a fixed backlog.

- Each shipped batch can add one more "next recommended product batch".
- That is useful for iterative product shaping, but it does not give a natural stop point for an "implement everything" run.

When a user wants end-to-end execution until the current roadmap is done, treat this document in snapshot mode:

- freeze the currently queued items before implementation starts
- finish only that queued set unless the user explicitly asks for rolling mode
- record any newly discovered ideas as later candidates instead of silently growing the active queue

## Current queue snapshot

Shipped in this chain so far:

- 1. active project mode and project digest
- 2. search refinement and command palette
- 3. import normalization with dry-run and duplicate handling
- 4. lightweight governance actions beyond archive
- 5. relation governance follow-through and decision-log polish
- 6. governance feed refinement and cross-entity review recall
- 7. governance follow-up cues on Home
- 8. review-action retrieval and decision recall polish

Currently queued for the next finite run:

- 9. review-action shortcuts and provenance cues

Stop rule for the current finite queue:

- the run is done when item 9 is shipped or explicitly deferred
- any new ideas discovered while shipping item 9 should be recorded as later candidates, not auto-added to the same execution queue

That batch shipped:

- command-palette shortcuts for recent review re-entry into notes, graph, and Governance detail
- Governance filter presets for promoted, archived, contested, and relation review decisions
- compact provenance wording on Home, Governance, and note-level review recall cards
- no new dashboard, no provenance browser, no notification layer

Current finite queue state:

- empty

What this means:

- the current queued roadmap run is complete
- any further product work should start from a fresh planning pass or an explicitly approved new queue snapshot

Historical recommendation trail below:

- the remainder of this document is preserved as an audit trail of how the rolling roadmap evolved
- when the queue snapshot above and the historical trail disagree, treat the queue snapshot above as the current source of truth

## Recommendation

The recommended follow-up order is:

1. active project mode and project digest
2. search refinement and command palette
3. import normalization with dry-run and duplicate handling

This order keeps the product focused on the shortest continuity loop:

1. know which project you are in
2. find the right memory quickly
3. bring outside material in without making a mess

## Current status

Items 1 through 3 in the original follow-up order have now shipped:

1. active project mode and project digest
2. search refinement and command palette
3. import normalization with dry-run and duplicate handling

The latest shipped batch is now:

4. lightweight governance actions beyond archive

Why this is next now:

- it follows naturally after item 08 by helping users clean up and promote imported or suggested content
- it improves trust without opening a large moderation or review queue
- it stays compatible with the current local-first and renderer-first product shape

That batch shipped:

- promote action for suggested nodes from Governance and node detail
- contest or archive action for low-confidence suggestions
- compact decision logging tied to provenance when a human accepts or rejects a suggestion
- no full moderation inbox, no large workflow engine, no background auto-resolution

The latest shipped batch is now:

5. relation governance follow-through and decision-log polish

Why this is next now:

- item 09 completed the node side of lightweight governance, but relation issues still remain read-mostly
- the product now logs human trust decisions, so the next leverage is making those decisions easier to review and filter afterward
- this extends the same trust loop without opening a separate admin surface

That batch shipped:

- direct accept, reject, or archive actions for relation issues
- a small recent decision history slice on Governance
- compact decision-note support inside relation governance actions
- no bulk moderation tools, no workflow engine, no hidden background resolution

The latest shipped batch is now:

6. governance feed refinement and cross-entity review recall

That batch shipped:

- a recent manual governance feed on Governance across nodes and relations
- entity and action filters for recent governance decisions
- direct jump-back into notes, graph, or the selected governance issue
- no moderation inbox, no bulk review tools, no new top-level surface

The latest shipped batch is now:

7. governance follow-up cues on Home

That batch shipped:

- a small Home card for recent manual governance decisions
- one-click return to reviewed note, graph context, or Governance from Home
- persistence for the last-used governance feed filters across Home and Governance
- cleanup of duplicated Governance feed presentation instead of adding another review surface

The next recommended product batch is now:

8. review-action retrieval and decision recall polish

Why this is next now:

- manual governance decisions now persist across Governance and Home, but they are still not easy enough to rediscover from normal search and note-history workflows
- the next leverage is making `review_action` activity more visible in retrieval without adding a dashboard
- this extends the same compact trust loop instead of creating another top-level surface

Recommended scope for the next item:

- stronger search or notes visibility for `review_action` activities
- lightweight jump-back from decision recall into related provenance or node history
- compact wording polish for decision labels and notes where human actions are revisited later
- no analytics dashboard, no team workflow layer, no separate history page

That batch shipped:

- client-side search refinement for `review_action` activity hits
- renderer labels that describe the specific manual review decision instead of raw activity-type text
- compact review recall inside note detail with quick return paths into Governance or graph
- no reporting dashboard, no separate provenance browser, no new top-level surface

The next recommended product batch is now:

9. review-action shortcuts and provenance cues

Why this is next now:

- review decisions are now much easier to rediscover from Home, Governance, and note retrieval, but the user still lacks one-step shortcuts into those recall paths
- the next leverage is a few tiny affordances that make manual trust history feel first-class without expanding the information architecture
- this keeps the trust loop compact and retrieval-first

Recommended scope for the next item:

- command-palette shortcuts for recent review decisions or Governance re-entry
- lightweight provenance wording cues near manual review history
- optional quick-filter presets for recent manual decisions
- no dedicated provenance page, no dashboard, no notification system

## Impact x Effort

### 1. Active project mode and digest

- Impact: high
- Effort: medium
- Why now:
  item 02 added project-aware capture, but the product still lacks a stronger "current project" mode that shapes capture, Home, and context packaging together.
- What it would add:
  active project pin in the main shell
  project digest card on Home
  project-aware default routing for quick capture and context views
- Why it comes first:
  this improves continuity on every session, not just during one-off setup.

### 2. Search refinement and command palette

- Impact: high
- Effort: medium
- Why now:
  item 01 made Home search-first, but search still lacks a faster power path and more precise refinement controls.
- What it would add:
  command palette
  type/source/status filter chips
  recent searches and recent commands
- Why it comes second:
  this strengthens the main retrieval loop without broadening the information architecture.

### 3. Import normalization and duplicate handling

- Impact: high
- Effort: medium-high
- Why now:
  item 04 created the first inbound import path, but larger imports still need a safer normalization layer.
- What it would add:
  dry-run preview
  duplicate heuristics
  title/body normalization choices
  optional relation suggestions after import
- Why it comes third:
  the basic path exists now, so the next step should make it safer for real use instead of adding more import formats immediately.

### 4. Lightweight governance actions beyond archive

- Impact: medium
- Effort: medium
- Why now:
  item 03 gave Recent note modal edit and archive, but governance still lacks a small set of direct human actions for suggested or contested items.
- What it would add:
  promote
  dismiss or reject
  quick provenance-linked decisions from Governance
- Why it is not above the top three:
  it improves trust and cleanup, but it does not shorten the primary continuity loop as much as project mode or better retrieval.

### 5. Artifact-aware import and migration

- Impact: medium
- Effort: high
- Why now:
  item 04 intentionally left artifact files and integration records out of the first onboarding path.
- What it would add:
  optional artifact copy or registration
  path remapping
  import manifest review
- Why it stays later:
  the complexity is real, and the current import flow already covers the highest-signal text path.

## Recommended next implementation batch

If only one more batch should be done next, use this scope:

### Batch A

- active project pin in the shell
- Home project digest card
- project-aware quick actions from Home
- command palette with core routes and recent-node jump
- basic search filter chips for node type and source

Why this is the best next batch:

- it compounds item 01 and item 02 directly
- it improves both first minute re-entry and active work continuity
- it stays inside renderer-first scope with limited contract risk

## Scope to avoid next

These are tempting, but should wait:

- real-time sync language or collaborative editing
- a full migration wizard
- a dedicated semantic admin page
- broad moderation queue mechanics
- more top-level navigation surfaces

## Engineering note

One non-product follow-up is worth tracking separately:

- stabilize the intermittent observability or search-feedback test race that can appear when `npm test` and `npm run build` run in parallel

That should be treated as repo hygiene, not as the next product batch.
