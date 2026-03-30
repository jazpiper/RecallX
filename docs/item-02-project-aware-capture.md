# Item 02 - Project-aware Capture

## Why this exists

RecallX is strongest when durable notes, decisions, and questions stay attached to the project context they belong to.

The current quick capture flow creates useful nodes, but it still leaves project association to a later manual step. That weakens project continuity and makes later retrieval, project maps, and recent re-entry less precise than they should be.

## Goals

- let quick capture optionally attach a new node to a project at creation time
- keep the capture form short and calm
- persist project linkage in a retrieval-friendly way
- make the resulting node visible in project-oriented surfaces without extra cleanup

## Shipped scope

1. Add an optional project selector to the Recent quick capture form.
2. Send the selected project through the node create path as explicit metadata.
3. Automatically create a canonical `relevant_to` relation between the new node and the chosen project.
4. Keep project selection optional so quick capture remains lightweight.
5. Update product docs to describe the new project-aware capture flow.

## Non-goals

- no multi-project capture in this slice
- no new project dashboard
- no heavy project planner UI
- no automatic tagging system

## UX direction

The capture form should still feel like one short move:

1. choose type
2. optionally choose project
3. title
4. body
5. create

If a project is already obvious from the current context, the UI may preselect it, but the user should be able to clear it easily.

## Storage direction

- store the chosen project id in node metadata for attribution and debugging
- create a `relevant_to` relation at write time so existing project graph and membership logic can see the node immediately
- preserve append-first provenance for both the node and the created relation

## Validation

- `npm run check`
- `npm test`
- `npm run build`

## Figma

Create an item-specific capture screen in Figma before renderer edits:

- https://www.figma.com/design/HCDxaViy1UUrUktsHqJYVM
