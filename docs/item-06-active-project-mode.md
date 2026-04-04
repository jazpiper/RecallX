# Item 06 - Active Project Mode

> Historical shipped record kept for maintainer context. For current guidance, see `README.md` and `optimization-roadmap.md`.

## Why this exists

RecallX now supports project-aware capture, but the renderer still treats project context as something the user has to keep reselecting.

That leaves continuity on the table right where the product should feel most cohesive.

## Goals

- let the user choose one active project for the current workspace
- keep that selection visible on Home as a project digest
- route quick project-oriented actions through the active project by default
- persist the chosen active project through workspace settings

## Shipped scope

1. Add an active project mode to the renderer using `workspace.activeProjectId`.
2. Show an active project digest card on Home with summary, recent activity, and nearby context.
3. Let Home project cards promote a project into the active slot.
4. Default Recent quick capture to the active project when available.
5. Keep Project map aligned to the active project when no more specific project focus is chosen.
6. Update UX docs to describe the new active-project continuity loop.

## Non-goals

- no multi-project workspace dashboard
- no command palette yet
- no global project-specific search filter system
- no server-side project digest endpoint

## UX direction

The loop should feel simple:

1. choose the active project
2. re-enter on Home
3. see the project digest immediately
4. capture or inspect in the same project context

This is a continuity mode, not a new top-level page.

## Validation

- `npm run check`
- `npm run build`

## Figma

Item 06 Figma exploration:

- https://www.figma.com/design/GfF7Vf0OOiwbmQNf5KHrrs
- The file was created first, but additional MCP-driven frame creation was blocked by the current Figma Starter plan tool-call limit during this run.
- The implementation followed the scope and UX direction in this document until Figma MCP capacity is available again.
