# Item 08 - Import Normalization and Duplicate Handling

> Historical shipped record kept for maintainer context. For current guidance, see `README.md` and `optimization-roadmap.md`.

## Why this exists

Item 04 gave RecallX its first inbound import path, which is enough for onboarding but still too blunt for repeated real-world use.

Once a workspace already contains live notes, imports need a calmer loop that shows what will happen before mutation, highlights likely duplicates, and lets the user make a small number of explicit cleanup choices.

## Goals

- add a dry-run preview step before import mutates the workspace
- surface likely duplicate notes in a lightweight, inspectable way
- let the user choose a small set of normalization rules before import
- keep the import loop compact and local-first instead of turning it into a migration wizard

## Shipped scope

1. Add an import preview action to the Workspace import card.
2. Add a server-side dry-run preview path for Markdown and RecallX JSON imports.
3. Surface preview counts for nodes, relations, activities, and likely duplicates before the real import runs.
4. Let the user choose lightweight normalization options for titles and note bodies.
5. Let the user choose a duplicate handling mode between warning-only and skipping exact duplicates.
6. Show what the real import actually skipped or imported in the completion summary.
7. Update product docs to describe the safer import loop honestly.

## Non-goals

- no new import formats
- no artifact file migration
- no background file watching
- no automatic merge of near-duplicate notes
- no large moderation queue for imported content
- no relation suggestion UI in this batch

## UX direction

The import loop should feel like this:

1. choose format and source path
2. preview the import
3. review counts, duplicate signals, and a short sample
4. choose small normalization or duplicate options
5. run the real import with those choices
6. inspect the outcome without leaving Workspace

This should feel like a safety layer around the existing onboarding path, not a new migration product.

## Validation

- `npm run check`
- `npm test`
- `npm run build`

## Figma

Item 08 Figma exploration:

- https://www.figma.com/design/9EbLl0RfTcUlFiRKUz17w7
- The file was created first, but additional MCP-driven frame creation was blocked by the current Figma Starter plan tool-call limit during this run.
- The implementation should follow the scope and UX direction in this document until Figma MCP capacity is available again.
