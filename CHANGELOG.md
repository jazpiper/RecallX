# Changelog

## 1.2.0

### Minor Changes

- 28d10b3: Add server-backed renderer search, workspace backup/export/restore flows, and single-writer workspace safety warnings.

### Patch Changes

- ad4128a: Polish review-action recall in search and note detail with clearer labels, metadata-backed activity hits, and lightweight review-decision filtering.
- fc9a5e5: Add stage-level workspace search telemetry so deterministic search, token fallback, and merged candidate totals are easier to inspect.
- 14019ae: Fix release PR generation by keeping pending changesets scoped to the root package and validating changeset metadata in CI.
- 893f68a: Refresh the renderer redesign with a sidebar-first shell, tighter copy, browser-led UI polish, and quieter review/memory/workspace surfaces.
- dcb2f4a: Avoid self-lock workspace safety warnings when reopening a workspace in the same session manager.
- 560a77e: Precompute palette command search text and label indexes so command-palette filtering and recent-command lookup avoid repeated string normalization and linear scans.
- 5aa8fab: Add relation governance follow-through in the Governance UI with accept, reject, and archive actions plus selected-issue decision history.
- 08dd35c: Add lightweight node governance actions in Governance and note detail, including promote, contest, and archive decisions with review-action logging.
- c94d6eb: Add search refinement chips and a command palette so Home and Notes search can narrow results and jump faster.
- cf701bf: Refresh the Home renderer into a search-first re-entry surface with recent project and movement shortcuts, plus updated UX docs for the new Home and capture flow.
- 831cd78: Add restore safety snapshots and multi-device handoff guidance.
- 7e7f289: Add review-action command palette shortcuts and clearer provenance cues across Governance, Home, and note recall surfaces.
- 16ca495: Suppress expected readonly SQLite auto-refresh noise in tests by recognizing readonly write errors and skipping stderr logs for that known case.
- aac5361: Move renderer shell selector logic for Home and command-palette recent node state into a dedicated helper module with regression coverage.
- 8b9a171: Add a compact governance decision feed with entity and action filters in the Governance view.
- f3a9635: Add a lightweight hot-path profiling toggle, baseline measurement guide, and renderer timing samples for Home, search, notes, and command palette derivations.
- 698029d: Avoid duplicate project graph fallback edges when inferred project links already exist.
- 4804ee8: Split workspace import option, duplicate, and preview helper logic into a dedicated module with focused unit coverage.
- 856d8f8: Add project-aware quick capture so Recent can optionally link new nodes to a project immediately, including automatic relevant_to relation creation and updated UX docs.
- 9af85c9: Add compact governance follow-up cues on Home and persist governance feed filters across Home and Governance.
- 6105869: Add lightweight Recent note curation actions for inline edits and archive.
- 450dff7: Add preview-first workspace imports with normalization options and exact-duplicate skipping.
- 13aef75: Hide stale governance-issue entry points for resolved review decisions and keep review shortcuts aligned with still-open Governance issues.
- 0c3c78c: Add active project mode on Home so project continuity, quick capture defaults, and project-map fallback stay aligned.
- 4f6f49c: Add import onboarding for Markdown files and RecallX JSON exports.
- a8596e4: Centralize renderer governance feed and review-action derivation helpers so Home, note preview, and command-palette recall use shared logic.

## 1.0.6

### Patch Changes

- Reduce observability request overhead, add span hierarchy across MCP and API telemetry, and allow short-form project nodes to stay durable so project capture routing continues to work.

## 1.0.1

### Patch Changes

- 48a9b31: Organize the release workflow around Changesets, add dedicated CI and publish GitHub Actions, and standardize version syncing for the full and headless npm packages.
- e37fc9e: Tighten npm runtime and MCP release readiness by aligning the supported Node version with `node:sqlite`, preferring `RECALLX_API_TOKEN` in the CLI while keeping the legacy token alias, removing stale renderer version fallbacks, and making the installed MCP launcher resolve `node` from `PATH`.

## Unreleased

## 1.0.0

- published the first public RecallX release around two supported distribution paths: Git source-run and npm terminal-only
- published the npm CLI/MCP distribution path with `recallx` and `recallx-mcp`
- documented the source-run local API, renderer, and MCP workflows for public use
- finalized the current renderer/API surface around Guide, Recent, Graph, Project map, Governance, and Settings
- shipped the local semantic sidecar with `local-ngram` / `chargram-v1` embedding version `2`
