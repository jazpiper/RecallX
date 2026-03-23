# Changelog

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
