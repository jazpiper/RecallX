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

During the current feature freeze, these planning artifacts are the maintainer-facing guide to the optimization stream.

- `guardrails.md` for product and architecture decision constraints
- `optimization-roadmap.md` for the active optimization plan and current execution slice during feature freeze
- `optimization-baseline.md` for the Batch O1 baseline evidence artifact that anchors optimization comparisons
- `post-batch-roadmap.md` for the completed product-batch handoff and historical audit trail that preceded the optimization pass
- `release-checklist.md` for release verification and packaging checks
- `release-workflow.md` for the Changesets and npm publish flow
- `semantic-sidecar.md` for semantic sidecar design and local development notes
- `sync-backup.md` for backup and sync strategy
- `archive/README.md` for archived planning and design references that are no longer part of the current product contract

### Historical shipped item docs

These completed batch records are kept for maintainer context, not as the current optimization plan.

1. `item-01-home-reentry.md`
2. `item-02-project-aware-capture.md`
3. `item-03-lightweight-curation.md`
4. `item-04-import-onboarding.md`
5. `item-05-safety-automation.md`
6. `item-06-active-project-mode.md`
7. `item-07-search-refinement-command-palette.md`
8. `item-08-import-normalization-duplicate-handling.md`
9. `item-09-lightweight-governance-actions.md`
10. `item-10-relation-governance-follow-through.md`
11. `item-11-governance-feed-refinement.md`
12. `item-12-governance-home-followup.md`
13. `item-13-review-action-retrieval-polish.md`
14. `item-14-review-action-shortcuts-provenance.md`

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
