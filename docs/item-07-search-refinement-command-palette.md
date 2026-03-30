# Item 07 - Search Refinement and Command Palette

## Why this exists

Item 01 made Home search-first, but the retrieval loop is still missing a faster power path and lightweight refinement controls.

Users can search, but they still have to retype common intents, browse broad mixed results, and bounce through navigation for routine jumps.

## Goals

- make workspace search feel more precise without changing retrieval fundamentals
- add a fast command palette for route changes and recent-node jump
- keep search refinement inspectable and lightweight
- stay renderer-first unless a contract change is clearly necessary

## Shipped scope

1. Add a command palette opened by `Cmd+K` or `Ctrl+K`.
2. Let the palette jump to core routes and recent node targets.
3. Add lightweight search filter chips for node type and source label.
4. Show recent searches and recent commands inside the palette.
5. Keep the existing deterministic mixed search path as the backend.
6. Update UX docs to describe the refined search loop.

## Non-goals

- no search ranking rewrite
- no mandatory semantic behavior changes
- no new top-level navigation page
- no complex saved-search system
- no server-side command registry

## UX direction

The search loop should feel like this:

1. hit `Cmd+K` or `Ctrl+K`
2. choose whether you want a route, a recent search, or a recent node
3. narrow the visible results with a small number of chips
4. open the next useful memory without leaving Home

This is a speed layer on top of the current retrieval path, not a new search product.

## Validation

- `npm run check`
- `npm test`
- `npm run build`

## Figma

Item 07 Figma exploration:

- https://www.figma.com/design/zJZaZvZuRSDKgzPM7nQ0vz
- The file was created first, but additional MCP-driven frame creation was blocked by the current Figma Starter plan tool-call limit during this run.
- The implementation should follow the scope and UX direction in this document until Figma MCP capacity is available again.
