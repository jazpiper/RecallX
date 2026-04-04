# Item 03 - Lightweight Curation

> Historical shipped record kept for maintainer context. For current guidance, see `README.md` and `optimization-roadmap.md`.

## Why this exists

RecallX already exposes update and archive primitives, but the renderer still makes basic curation feel indirect.

If users have to leave the main reading surface to fix a title, trim a body, or archive stale memory, the system stays technically governable but practically sticky.

## Goals

- let the user make small node fixes from the note detail surface
- expose archive without turning the UI into a moderation queue
- keep editing bounded to lightweight curation, not full document tooling
- preserve existing append-first and provenance-aware API behavior

## Shipped scope

1. Add a lightweight edit mode to the Recent note modal.
2. Allow title and body edits through the existing node update API.
3. Add an archive action to the same modal.
4. Refresh the local snapshot after save or archive so Home, Recent, and Graph stay consistent.
5. Update UX documentation to reflect the new curation loop.

## Non-goals

- no rich text editor
- no diff or revision history UI
- no dedicated moderation inbox
- no bulk archive flow

## UX direction

The curation surface should feel like a quick correction path:

1. open node
2. tap edit
3. adjust title/body
4. save or archive
5. return to reading

This should remain one modal-level action set, not a new page.

## Validation

- `npm run check`
- `npm test`
- `npm run build`

## Figma

Item 03 Figma exploration:

- https://www.figma.com/design/CvLZ4njp5Y3vvw5OWlx092
