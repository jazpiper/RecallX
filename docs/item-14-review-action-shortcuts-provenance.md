# Item 14 - Review-Action Shortcuts and Provenance Cues

## Why this exists

Item 13 made review decisions easier to rediscover from search and note history.

What still felt missing was the final one-step return path. Recent manual trust decisions were visible, but not yet easy enough to reopen directly from the command palette, and the surrounding provenance wording still relied too much on reading raw card content carefully.

This batch keeps the same lightweight review loop while making recent trust history easier to jump back into.

## Goals

- add one-step command-palette shortcuts for recent review re-entry
- add a few quick Governance filter presets without introducing a new top-level surface
- make recent review cards explain their provenance more directly
- keep the work renderer-only and retrieval-first

## Shipped scope

1. Add command-palette shortcuts for recent review re-entry into notes, graph, and Governance detail.
2. Add command-palette presets for promoted, archived, contested, and relation review decisions.
3. Add clearer provenance wording to Home and Governance recent decision cards.
4. Add provenance wording to note-level review recall cards.
5. Keep the current Governance feed, note recall, and search surfaces intact.

## Non-goals

- no new backend routes
- no separate provenance browser
- no notification system
- no new dashboard or reporting page
- no Figma work for this batch

## UX direction

The review-action loop should now feel like this:

1. open `Cmd/Ctrl+K`
2. jump straight back into the latest review context or a filtered Governance slice
3. read a compact provenance cue without decoding the card structure manually
4. continue trust inspection only when needed

This should feel like a shortcut layer, not a new review workflow.

## Validation

- `npm run check`
- `npm run build`
- `npm test`
- `npm run release:verify`
