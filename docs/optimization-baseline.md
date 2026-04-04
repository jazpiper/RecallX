# RecallX - Hot Path Profiling Baseline

## Goal

This document is the concrete Batch O1 baseline artifact for the feature-freeze optimization cycle.

The point is not to produce perfect benchmarking. The point is to make the current hot path observable enough that optimization work is driven by evidence instead of guesswork.

## O1 completion checklist

Treat Batch O1 as complete only when all of the following are true:

- [x] Renderer profiling can be enabled with `?rxProfile=1` or `localStorage["recallx.hot-path-profile"] = "1"`.
- [x] `window.__recallxHotPathProfile` captures both synchronous derivations and async compact-context preview fetches.
- [x] A short baseline interaction pass has been recorded for Home, search, Governance, command palette, notes, and compact-context preview flows.
- [x] The active profiling labels below match the instrumented renderer hot paths in `app/renderer/src/App.tsx`.
- [x] The inspect and clear workflow below is known before starting O2 refactors.

## How to enable renderer profiling

Use either of these while running the source app locally:

1. Open the renderer with `?rxProfile=1` in the URL.
2. Or set `localStorage["recallx.hot-path-profile"] = "1"` in devtools and refresh.

When enabled, the renderer appends samples to `window.__recallxHotPathProfile`, keeps the newest 200 retained samples, and prints short `console.info` lines prefixed with `RecallX hot-path` for samples at or above the current logging threshold.

This profiling is intended for local development only.

## Measurement targets

Capture a short interaction pass for each of these:

1. Home search entry with an empty query, then with a short query.
2. Command palette open, filter, and recent-command rendering.
3. Governance view open, recent-feed rendering, and filter change when review issues are present.
4. Home follow-up cards that depend on recent governance feed and project continuity.
5. Notes search transition from empty query to mixed node and activity hits.
6. Compact-context preview fetches for graph detail, recent-note preview, and active-project digest flows.

## What to watch first

For the first pass, pay attention to:

- repeated selector work on the same data set
- sorting or filtering of large arrays during routine view switches
- command-palette command construction when unrelated renderer state changes
- governance feed derivation that recalculates when only detail-panel state changes
- node-map or recent-node reconstruction on every search response

## Active profiling labels

The active renderer label set for Batch O1 is:

- `search.filteredResults`
- `search.nodeMap`
- `search.recentSelectableNodeIds`
- `notes.searchableNoteNodes`
- `governance.detailReviewActions`
- `governance.notePreviewReviewActions`
- `governance.homeFeed`
- `home.homeRecentNodes`
- `palette.recentNodes`
- `palette.routeCommands`
- `palette.filteredRouteCommands`
- `palette.recentCommands`
- `compactContext.graphDetailPreview`
- `compactContext.recentNotePreview`
- `compactContext.activeProjectDigest`

These labels are intentionally small and local. They should help identify where O2 and O3 need deeper cleanup without turning profiling into a permanent surface.

## Inspect and clear samples

Use devtools after a profiling pass:

1. Inspect all retained samples:

   ```js
   window.__recallxHotPathProfile
   ```

2. Inspect only compact-context samples:

   ```js
   window.__recallxHotPathProfile?.filter((sample) => sample.label.startsWith('compactContext.'))
   ```

3. Clear retained samples before the next pass:

   ```js
   window.__recallxHotPathProfile = []
   ```

## Recording guidance

For each target flow, record:

- rough sample count
- largest observed duration for each relevant label
- whether the work repeated unexpectedly on unrelated interactions
- whether the work felt hot-path relevant or cold-path acceptable

Keep the notes compact. This baseline exists to rank follow-up engineering work, not to become a reporting dashboard.

## First local baseline pass - 2026-04-04

Environment:

- source renderer at `http://127.0.0.1:5173/?rxProfile=1`
- local API at `http://127.0.0.1:8787`
- local profiling seed data: 1 project plus 3 linked memory cards created in the workspace to exercise note, graph, and compact-context flows

Interaction pass:

1. clear the retained sample buffer
2. reset and re-apply the active project
3. Home search: `O1` -> `context` -> clear
4. open command palette, filter to `memory`, then run the Memory route
5. Memory query: `Search` -> `O1` -> clear
6. open `Search profiling note` in the note preview pane
7. run `Inspect in graph`, then click a nearby graph node
8. return Home and open Review

Captured sample summary:

- retained samples after the pass: `198`
- highest compact-context durations:
  - `compactContext.activeProjectDigest`: 4 samples, max `55ms`
  - `compactContext.graphDetailPreview`: 1 sample, max `42.6ms`
  - `compactContext.recentNotePreview`: 1 sample, max `41.1ms`
- highest synchronous derivation durations in this pass stayed at or below `0.1ms`

Observed repeat patterns:

- `palette.recentNodes`: 30 samples
- `home.homeRecentNodes`: 26 samples
- `search.nodeMap`: 26 samples
- `palette.recentCommands`: 18 samples
- `search.filteredResults`: 16 samples
- `search.recentSelectableNodeIds`: 16 samples

Interpretation:

- compact-context preview fetches are the only clearly material timings in this baseline pass; they are the strongest O2/O3 follow-up signal from Batch O1
- the local synchronous selector chain is cheap in absolute time, but several labels re-run frequently during navigation and view transitions in the current dev workflow
- the Review view in this workspace was an empty state (`0` surfaced governance issues), so this pass captures review-entry and empty-state rendering cost, but not a meaningful Governance filter-change workload yet
