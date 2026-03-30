---
name: recallx-release-guard
description: Release, package, version, workflow, or publish safety workflow for RecallX. Use when editing package versions, release scripts, Changesets flow, generated npm packages, or GitHub Actions for release and publish.
---

# RecallX Release Guard

Use this skill whenever the task touches versioning, release workflow, packaging, or publish behavior.

## Read First

1. `docs/release-workflow.md`
2. `README.md`
3. The relevant script or workflow file under `scripts/` or `.github/workflows/`

## Required Commands

Start with:

```bash
npm run version:check
```

For meaningful release-surface changes, finish with:

```bash
npm run release:verify
```

## Rules

- Do not hand-edit versions casually.
- Use the repo version scripts instead of ad hoc edits.
- If the change belongs in release notes, add a changeset.
- Keep npm runtime, source-run workflow, and generated package expectations aligned.
- Treat publish behavior as idempotent and safety-sensitive.

## Watch For

- version mismatch across root, locks, renderer, CLI, and shared constants
- docs drifting from actual release commands
- CI validating a narrower path than local release verification
- workflow edits that break Node version or provenance assumptions
