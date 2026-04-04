# Item 04 - Import Onboarding

> Historical shipped record kept for maintainer context. For current guidance, see `README.md` and `optimization-roadmap.md`.

## Why this exists

RecallX already protects existing work with backup, export, and restore, but it still asks new users to arrive empty-handed.

That makes the product safe once someone is invested, yet weak at the exact moment adoption starts.

## Goals

- add a first inbound import path to the Workspace surface
- let users bring existing material into the active workspace without leaving the renderer
- keep provenance explicit so imported material stays inspectable
- create a safety snapshot before import work mutates the workspace

## Shipped scope

1. Add an import card to the Workspace page.
2. Support importing either a RecallX JSON export file or a Markdown file or folder.
3. Copy imported source files into the workspace `imports/` area for inspection-friendly provenance.
4. Create a snapshot automatically before the import mutates the current workspace.
5. Show a compact import result summary with created node, relation, and activity counts.
6. Update product docs to describe the first shipped import path honestly.

## Non-goals

- no automatic deduplication
- no live directory watching
- no backup archive bundle import
- no artifact file migration from old workspaces
- no full migration wizard

## UX direction

The onboarding loop should stay short:

1. choose import format
2. paste a local source path
3. optionally rename the import label
4. run import
5. inspect the summary and continue working in the same workspace

This should feel like a calm setup bridge, not a heavy migration dashboard.

## Validation

- `npm run check`
- `npm test`
- `npm run build`

## Figma

Item 04 Figma exploration:

- https://www.figma.com/design/52XGtpBe4mQG2NVme61TNU
