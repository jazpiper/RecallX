# RecallX - Hot Path Profiling Baseline

## Goal

This document defines the first measurement pass for the feature-freeze optimization cycle.

The point is not to produce perfect benchmarking. The point is to make the current hot path observable enough that optimization work is driven by evidence instead of guesswork.

## How to enable renderer profiling

Use either of these while running the source app locally:

1. Open the renderer with `?rxProfile=1` in the URL.
2. Or set `localStorage["recallx.hot-path-profile"] = "1"` in devtools and refresh.

When enabled, the renderer appends samples to `window.__recallxHotPathProfile` and prints short `console.info` lines prefixed with `RecallX hot-path`.

This profiling is intended for local development only.

## Initial measurement targets

Capture a short interaction pass for each of these:

1. Home search entry with an empty query, then with a short query.
2. Command palette open, filter, and recent-command rendering.
3. Governance view open, filter change, and recent-feed rendering.
4. Home follow-up cards that depend on recent governance feed and project continuity.
5. Notes search transition from empty query to mixed node and activity hits.

## What to watch first

For the first pass, pay attention to:

- repeated selector work on the same data set
- sorting or filtering of large arrays during routine view switches
- command-palette command construction when unrelated renderer state changes
- governance feed derivation that recalculates when only detail-panel state changes
- node-map or recent-node reconstruction on every search response

## Current instrumented labels

The first baseline pass instruments these synchronous renderer derivations:

- `search.filteredResults`
- `search.nodeMap`
- `search.recentSelectableNodeIds`
- `notes.searchableNoteNodes`
- `home.homeRecentNodes`
- `palette.routeCommands`

These labels are intentionally small and local. They should help identify where O2 and O3 need deeper cleanup without turning profiling into a permanent surface.

## Recording guidance

For each target flow, record:

- rough sample count
- largest observed duration for each relevant label
- whether the work repeated unexpectedly on unrelated interactions
- whether the work felt hot-path relevant or cold-path acceptable

Keep the notes compact. This baseline exists to rank follow-up engineering work, not to become a reporting dashboard.
