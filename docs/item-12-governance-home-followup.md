# Item 12 - Governance Follow-Up Cues on Home

## Why this exists

Item 11 made manual governance decisions easier to revisit inside Governance, but that trust history still disappears as soon as the user returns to Home.

RecallX now needs a small re-entry cue that keeps recent human trust decisions visible without turning Home into a second governance screen.

## Goals

- show a small recent manual governance card on Home
- let the user jump back into notes, graph, or Governance from that card
- keep the last-used governance feed filters stable across Home and Governance
- preserve Home as a retrieval-first re-entry surface instead of a review dashboard

## Shipped scope

1. Add a compact Home card for recent manual governance decisions.
2. Reuse the existing governance feed endpoint instead of adding a new API surface.
3. Persist governance feed filters across Home and Governance.
4. Keep follow-up actions limited to open-note, open-graph, or return-to-Governance links.
5. Remove duplicate governance-feed rendering inside Governance so the Home cue and Governance detail stay consistent.

## Non-goals

- no notifications or badge system
- no new Home inbox semantics
- no extra governance analytics or reporting
- no bulk review actions
- no new top-level navigation item

## UX direction

The Home follow-up loop should feel like this:

1. user lands on Home
2. sees a small recent governance cue next to existing continuity surfaces
3. recognizes the last trust decision without opening Governance first
4. jumps back into notes, graph, or Governance only if more inspection is needed

This should feel like a re-entry reminder, not a new review workflow.

## Validation

- `npm run check`
- `npm test`
- `npm run build`
- `npm run release:verify`

## Figma

Figma was intentionally skipped for this batch because the work extends the existing Home layout and governance recall pattern rather than introducing a new standalone flow.
