# RecallX Docs Map

This directory is the main entry point for RecallX product and maintainer documentation.

If you are reading RecallX for the first time, start here.

## Current Product Docs

These documents best match the shipped product surface.

- `../README.md` for the three public distribution paths: source-run from Git, the full npm runtime, and the headless npm runtime
- `../app/cli/README.md` for the npm headless package
- `concept.md` for product positioning and rationale
- `api.md` for the current local HTTP contract
- `mcp.md` for the current MCP bridge contract and setup
- `schema.md` for the current durable data model
- `retrieval.md` for retrieval and context assembly behavior
- `ux.md` for the current local UI and renderer UX model
- `workflows.md` for common user and agent workflows
- `promotion-rules.md` for append-first promotion and governance rules

## Maintainer Docs

These are useful for maintainers and contributors working on the product.

- `guardrails.md` for product and architecture decision constraints
- `release-checklist.md` for release verification and packaging checks
- `release-workflow.md` for the Changesets and npm publish flow
- `semantic-sidecar.md` for semantic sidecar design and local development notes
- `sync-backup.md` for backup and sync strategy

## Reading Order

For implementation understanding:

1. `../README.md`
2. `../app/cli/README.md`
3. `api.md`
4. `mcp.md`
5. `schema.md`
6. `retrieval.md`
7. `ux.md`
8. `workflows.md`

For product intent:

1. `concept.md`
2. `guardrails.md`
3. `promotion-rules.md`
