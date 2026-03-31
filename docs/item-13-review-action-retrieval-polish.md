# Item 13 - Review-Action Retrieval and Decision Recall Polish

## Why this exists

Items 11 and 12 made manual governance decisions easier to revisit from Governance and Home.

What still felt weak was ordinary retrieval. Once those decisions became part of normal activity history, `review_action` events were still too easy to miss inside mixed activity search results and note history.

This batch makes review decisions easier to rediscover from search and note inspection without creating a separate dashboard.

## Goals

- make `review_action` activity easier to spot in mixed workspace search
- make review decisions easier to read from note history and note detail
- keep lightweight jump-back into Governance or graph close to recent review history
- avoid introducing a separate reporting surface

## Shipped scope

1. Add lightweight client-side search refinement for `review_action` activity hits.
2. Return activity metadata through workspace activity search results so renderer labels can stay specific.
3. Add human-friendly review-decision labels for activity hits and recent activity cards.
4. Add a compact review recall section in note detail when the selected note has recent manual governance actions.
5. Keep the existing mixed-search and recent-activity surfaces intact instead of replacing them.

## Non-goals

- no analytics dashboard
- no provenance browser or separate history page
- no new top-level search screen
- no bulk governance actions
- no background summarization pipeline for review history

## UX direction

The review-action recall loop should feel like this:

1. search normally or open a note
2. spot recent manual review decisions without decoding raw activity types
3. narrow activity hits to review decisions when needed
4. jump back into Governance or graph only when deeper trust inspection is useful

This should feel like better retrieval, not a new workflow layer.

## Validation

- `npm run check`
- `npm test`
- `npm run build`
- `npm run release:verify`

## Figma

Figma was intentionally skipped for this batch because the work refines existing search and note-history presentation rather than adding a new standalone flow.
