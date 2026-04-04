# Item 01 - Home Re-entry Refresh

> Historical shipped record kept for maintainer context. For current guidance, see `README.md` and `optimization-roadmap.md`.

## Why this exists

RecallX Home should be the fastest way back into useful memory, not a sparse launch pad.

Today the product intent says Home is the re-entry screen, but the current surface still leaves search in the Recent view and keeps the Home page mostly focused on guide and graph entry.

This item tightens that gap without adding a new top-level surface.

## Goals

- make Home the default re-entry point for retrieval
- keep the first interaction workspace-first and calm
- surface recent project continuity without turning Home into a dashboard
- preserve the existing compact product tone

## Shipped scope

1. Add a workspace-wide search field to Home.
2. Add a compact quick-action row that keeps Guide and Graph nearby but secondary.
3. Add a recent projects section that highlights project nodes first.
4. Add a recent movement section that helps the user jump back into active memory.
5. Keep the page summary-first and reuse existing search and detail flows.

## Non-goals

- no new top-level navigation item
- no advanced filter builder
- no analytics-heavy operational dashboard
- no command palette in this first slice
- no semantic admin expansion

## UX direction

Home should answer four questions quickly:

1. what workspace am I in
2. what should I open next
3. what project memory is active
4. what happens if I search right now

The layout should stay lightweight:

- hero with a search-first call to action
- quick actions under the hero
- two compact content rails for projects and recent movement

## Implementation notes

- reuse the existing workspace search API and current note/detail selection flows
- prefer recent project cards sourced from existing snapshot data before adding new server work
- keep Home read-focused; capture stays in Recent for this slice
- update `docs/ux.md` once the renderer surface changes

## Validation

- `npm run check`
- `npm run build`

## Figma

The implementation should follow the item-specific Figma screen created before renderer edits:

- https://www.figma.com/design/6llr9oQJwjcLRorYlYauEm
