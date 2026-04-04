# Item 09 - Lightweight Governance Actions Beyond Archive

> Historical shipped record kept for maintainer context. For current guidance, see `README.md` and `optimization-roadmap.md`.

## Why this exists

Item 08 made it easier to import content safely, but RecallX still leaves too much cleanup work stranded after suggested or low-confidence nodes appear.

The product already has automatic governance, provenance, and archive behavior. What it lacks is a compact way for a human to settle a suggestion in place without reopening a heavy moderation queue.

## Goals

- let a human promote a suggested node directly from Governance and node detail
- let a human mark a suggestion contested when it should not rank like healthy content
- keep archive available as the lightweight removal path for bad or redundant suggestions
- record the human decision in a small, attributable way instead of creating a new review system

## Shipped scope

1. Add a promote action for suggested or low-confidence nodes in Governance detail.
2. Add a contest action for suggested or active nodes in Governance detail when the human wants to lower trust explicitly.
3. Surface the same governance actions in node detail when the current node is a live governance candidate.
4. Record a compact `review_action` activity after a human governance decision.
5. Record a matching provenance-aware governance event so the node history stays inspectable.
6. Keep the flow local-first and renderer-first without adding a separate moderation inbox.

## Non-goals

- no full review queue or moderation dashboard
- no batch governance action system
- no background auto-resolution after human actions
- no relation governance action UI in this batch
- no deletion path for nodes

## UX direction

The governance cleanup loop should feel like this:

1. open a surfaced node issue from Governance or open a suggested node from Notes
2. inspect the reason summary and current state
3. choose one direct action: promote, contest, or archive
4. optionally leave a short decision note
5. stay on the same screen and see the new state reflected immediately

This should feel like a small trust-control layer around the existing product, not a new workflow engine.

## Validation

- `npm run check`
- `npm test`
- `npm run build`

## Figma

Item 09 Figma exploration:

- https://www.figma.com/design/iu5L6QB9ztTMvFydSZQEPF
- The file was created first as required.
- Additional MCP-driven frame creation was blocked during this run by the current Figma Starter plan tool-call limit.
- The implementation should follow the scope and UX direction in this document until Figma MCP capacity is available again.
