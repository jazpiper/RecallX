---
name: recallx-harness-self-improve
description: Post-task harness review workflow for the RecallX repository. Use after a meaningful RecallX task to decide whether AGENTS.md or .codex skills/hooks need one small reusable improvement, and stop after one bounded pass.
---

# RecallX Harness Self-Improve

Use this skill only after a meaningful RecallX task is already complete.

The goal is not to reopen the task. The goal is to decide whether the harness needs one small reusable improvement.

## Inputs To Review

Look at only the minimum evidence needed:

1. the user task and what was actually changed
2. failures, retries, or drift that happened during the run
3. validation commands that were run or skipped
4. current harness files:
   - `AGENTS.md`
   - relevant files under `.codex/skills/`
   - relevant files under `.codex/hooks/`

## Decision Rule

Ask these in order:

1. Did the task expose a repeated preflight miss?
2. Did drift happen that a better checklist or reminder could have prevented earlier?
3. Did validation guidance prove wrong, too vague, or too broad for this repo?
4. Did I repeat the same explanation or manual decision that belongs in a reusable skill or hook?

If all four are "no", do not change the harness.

If any answer is "yes", make only one improvement that is:

- small
- reusable across future RecallX tasks
- easy to validate

## Where To Put The Improvement

- `AGENTS.md` for repo-wide policy, guardrails, and definitions of done
- `.codex/skills/` for reusable agent workflows or task-specific reasoning loops
- `.codex/hooks/` for lightweight command-line reminders or validation routing

Choose the narrowest location that solves the problem.

## Hard Limits

- Make at most one bounded harness improvement per task.
- Do not rewrite the harness wholesale.
- Do not create a new skill if an existing skill only needs one short rule.
- Do not use this skill to sneak in unrelated cleanup.
- After one self-improvement pass, stop.

## Finish

Record one of these outcomes:

- "No reusable harness lesson emerged."
- "Applied one bounded harness improvement: <short description>."
