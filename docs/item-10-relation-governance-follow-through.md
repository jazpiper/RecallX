# Item 10 - Relation Governance Follow-Through and Decision-Log Polish

> Historical shipped record kept for maintainer context. For current guidance, see `README.md` and `optimization-roadmap.md`.

## Why this exists

Item 09 gave RecallX a compact human decision loop for node governance, but relation issues still remain mostly inspect-only.

The product already knows how to score relation trust and surface low-confidence or contested relation issues. What it still lacks is a small way for a human to settle those issues directly and then review recent decisions without opening a heavier moderation surface.

## Goals

- let a human accept, reject, or archive a surfaced relation issue directly from Governance
- keep human relation decisions explicit and stable instead of letting automatic recompute immediately blur them
- show a small recent decision log inside Governance so trust actions stay inspectable
- keep the batch local-first and compact instead of turning Governance into a workflow product

## Shipped scope

1. Add a manual relation governance action path for accept, reject, and archive.
2. Surface relation actions directly in Governance detail when the selected issue is a relation.
3. Record provenance-aware manual governance events for relation decisions.
4. Add a recent decision history slice to Governance using governance events.
5. Keep the existing node governance flow intact and avoid introducing batch review mechanics.

## Non-goals

- no node-governance expansion beyond what item 09 already shipped
- no bulk accept or bulk reject actions
- no dedicated relation-detail page
- no hidden background auto-resolution after a human decision
- no moderation inbox or queue

## UX direction

The relation governance loop should feel like this:

1. open a surfaced relation issue from Governance
2. inspect the reason summary and relation context
3. choose one direct action: accept, reject, or archive
4. optionally leave a short decision note
5. see the decision reflected immediately in both current issue state and a small recent decision log

This should feel like a trust-settling layer inside Governance, not a second review product.

## Validation

- `npm run check`
- `npm test`
- `npm run build`
- `npm run release:verify`

## Figma

Item 10 Figma exploration:

- https://www.figma.com/design/i3Pahsa9GmYRly2zqFI289
- The file was created first as required.
- Additional MCP-driven frame creation may still be blocked by the current Figma Starter plan tool-call limit during this run.
- The implementation should follow the scope and UX direction in this document until Figma MCP capacity is available again.
