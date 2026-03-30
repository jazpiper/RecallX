# RecallX - Post Batch Roadmap

This document captures the recommended next batch after item 01 through item 05 shipped:

- Home re-entry refresh
- project-aware capture
- lightweight note curation
- import onboarding
- workspace safety automation

The goal is to keep the next step small, product-shaped, and aligned with the current renderer and local-first guardrails.

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

The next recommended product batch is now:

4. lightweight governance actions beyond archive

Why this is next now:

- it follows naturally after item 08 by helping users clean up and promote imported or suggested content
- it improves trust without opening a large moderation or review queue
- it stays compatible with the current local-first and renderer-first product shape

Recommended scope for the next item:

- promote action for suggested nodes from Governance and node detail
- dismiss or reject action for low-confidence suggestions
- compact decision logging tied to provenance when a human accepts or rejects a suggestion
- no full moderation inbox, no large workflow engine, no background auto-resolution

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
