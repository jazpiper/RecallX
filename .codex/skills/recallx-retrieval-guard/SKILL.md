---
name: recallx-retrieval-guard
description: Retrieval, semantic, context-bundle, project-graph, or hot-path change workflow for RecallX. Use when editing search, ranking, semantic augmentation, neighborhood traversal, context assembly, or related tests/docs.
---

# RecallX Retrieval Guard

Use this skill when touching retrieval or other hot-path recall behavior.

## Read First

1. `docs/retrieval.md`
2. `docs/guardrails.md`
3. The relevant code under `app/server/`
4. The relevant tests under `tests/`

## Guardrails

- Keep deterministic retrieval first.
- Keep semantic augmentation bounded and optional.
- Prefer summary-first behavior over raw-body expansion.
- Avoid hidden expensive work on every query.
- Preserve inspectability. Behavior should be explainable from local rules.

## Suggested Test Pass

Always run:

```bash
npm run check
npm test
```

If you changed a specific retrieval path, rerun the narrowest relevant Vitest target first, then the broader suite.

## Common Failure Modes To Watch

- semantic ranking fan-out grows silently
- weak semantic signals outrank strong lexical hits
- graph traversal duplicates or drops important neighborhood items
- context assembly expands too deeply by default
- "smart" fallback becomes the default path instead of the bounded fallback

## Finish

Summarize:

- what changed in retrieval behavior
- what stayed intentionally unchanged
- what commands verified the result
