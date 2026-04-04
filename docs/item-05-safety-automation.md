# Item 05 - Safety Automation

> Historical shipped record kept for maintainer context. For current guidance, see `README.md` and `optimization-roadmap.md`.

## Why this exists

RecallX already warns about risky multi-device patterns, but the product still leaves too much of the safe sequence in the user's head.

Warnings are useful only if the next safest action is obvious and the system quietly protects the workspace before risky transitions.

## Goals

- automate one more safety snapshot path around risky workspace operations
- make single-writer handoff guidance visible inside the Workspace surface
- keep the product honest about multi-device limits without becoming a sync dashboard
- strengthen trust with concrete before-you-switch guidance

## Shipped scope

1. Create an automatic safety snapshot before workspace restore runs.
2. Surface the auto-created snapshot in the Workspace restore flow.
3. Add a safe handoff guidance card to the Workspace page.
4. Tighten safety copy so active warnings point toward sequential multi-device behavior.
5. Update backup and UX docs to reflect the new shipped automation.

## Non-goals

- no real-time sync
- no concurrent multi-writer support
- no background conflict resolver
- no cloud-provider-specific integration

## UX direction

The safety loop should be calm and explicit:

1. user sees current warning state
2. user sees the recommended handoff sequence
3. risky restore paths create a safety snapshot automatically
4. UI reports what backup was created before continuing

The goal is confidence, not alarm.

## Validation

- `npm run check`
- `npm test`
- `npm run build`

## Figma

Item 05 Figma exploration:

- https://www.figma.com/design/H9oz8jVoarBfstTimsDjp0
