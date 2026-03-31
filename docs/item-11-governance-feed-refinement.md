# Item 11 - Governance Feed Refinement and Cross-Entity Review Recall

## Why this exists

Item 09 and item 10 gave RecallX direct human governance actions for both nodes and relations.

The product can now record explicit trust decisions, but those decisions are still easiest to inspect one entity at a time. That makes governance feel session-local instead of durable across a longer review loop.

This batch adds a small recent decision feed so humans can revisit what they changed, filter it quickly, and jump back into the underlying node or relation context without turning Governance into a moderation inbox.

## Goals

- show a compact recent human decision feed across node and relation governance actions
- let humans filter that feed by entity type and action without leaving Governance
- provide direct link-out from recent decisions back into notes, graph, or selected governance detail
- keep the flow inspectable and local-first by building on existing governance events

## Shipped scope

1. Add a recent manual governance decision feed on the Governance screen.
2. Add feed filters for entity type and action.
3. Add a small server endpoint for recent governance events filtered to manual decisions.
4. Return enough display context for each decision row to support fast jump-back into nodes, graph, or relation detail.
5. Keep the existing issue queue and selected-issue detail intact.

## Non-goals

- no bulk review actions
- no moderation inbox or queue
- no new top-level navigation surface
- no background auto-resolution of past human decisions
- no attempt to expose every automatic governance evaluation in the new feed

## UX direction

The refined Governance screen should feel like this:

1. scan current surfaced issues on the left
2. inspect one selected issue in the detail panel
3. glance at a cross-entity recent decision feed nearby
4. filter that feed down to node or relation decisions, or to a specific action
5. jump back into the affected note, graph context, or selected relation issue when needed

This should feel like a compact trust history layer, not a second workspace activity stream.

## Validation

- `npm run check`
- `npm test`
- `npm run build`
- `npm run release:verify`

## Figma

Figma was intentionally skipped for this batch because the change refines an existing Governance surface instead of introducing a new top-level flow.
