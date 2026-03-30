---
name: recallx-subagent-orchestration
description: Delegation workflow for RecallX repo tasks. Use when deciding whether to spawn a sub-agent, which model to route it to, when to reuse an existing agent, and when to close completed agents so delegation stays cheap and available.
---

# RecallX Sub-Agent Orchestration

Use this skill when a RecallX task would benefit from delegated side work.

The goal is not "spawn more agents." The goal is to reduce latency and context pressure without losing ownership of the main task.

## Spawn By Default When It Helps

When platform policy and the current user request allow delegation, proactively spawn a sub-agent for bounded side work such as:

- read-only codebase exploration
- locating relevant tests, docs, or ownership boundaries
- parallel diagnostics on an error that does not block the next local step
- quick independent review of a diff or patch
- small isolated edits on a disjoint write scope
- verification that can run while the main agent keeps implementing

Do not wait for the user to repeat the request if delegation is already in bounds for the current task.

## Keep The Main Path Local

Do not delegate the very next blocking step when:

- the answer is needed immediately for your next action
- the subtask is tightly coupled to ongoing edits
- the scope is too fuzzy to assign cleanly
- reviewing or integrating the output would cost more than doing it locally

If the task is blocking and small, do it yourself.

## Routing Matrix

Choose the cheapest model that can finish the subtask safely.

- `gpt-5.4-mini`
  - best for read-only exploration, file discovery, lightweight review, narrow summaries, and confirming where logic lives
- `gpt-5.3-codex-spark`
  - best for small patches, test fixes, formatting/typing follow-ups, and quick bounded implementation work
- `gpt-5.3-codex`
  - best for medium implementation slices with a clear owner file set
- `gpt-5.4`
  - best for high-risk debugging, ambiguous failures, architecture-sensitive changes, or deeper code reasoning

Use lower reasoning by default for mini and spark unless the subtask is genuinely tricky. Raise reasoning only when the failure mode justifies it.

## Reuse Before Respawn

Before spawning a new sub-agent, check whether an existing one already owns the same thread of work.

Reuse the current sub-agent with `send_input` when:

- the follow-up stays on the same subtask
- the same files or module boundary are still in scope
- you need refinement, extension, or a second pass on its own output

Spawn a new sub-agent when:

- the subtask is materially different
- you need true parallelism
- the current agent's context is no longer the right fit

Do not spawn near-duplicate agents on the same unresolved question.

## Keep Prompts Tight

Every delegated prompt should include only:

- the bounded task
- the expected output
- owned files or write scope, when editing is allowed
- any critical repo rule that cannot be violated

Avoid copying the whole conversation unless the sub-agent truly needs it.

## Close Agents Aggressively

Close a sub-agent as soon as:

- its result has been integrated
- its task is complete and no immediate follow-up is planned
- its scope has become stale or superseded
- you are nearing task completion and it no longer has an active role

Do not leave agents open after "maybe useful later" work. Stale agents consume capacity and make future delegation fail at the worst time.

## Finish Checklist

Before finalizing the main task:

1. Check whether any open sub-agent is still actively needed.
2. Reuse it if one more follow-up is clearly in scope.
3. Otherwise close it.
4. Mention any meaningful delegated work in the final summary only if it affected the outcome.

## Default Pattern

1. Start locally and identify the immediate blocking step.
2. Spawn one small sidecar agent if it can run in parallel.
3. Reuse that agent for related follow-up instead of spawning duplicates.
4. Integrate the result.
5. Close the agent when its thread is done.
6. Repeat only when a new bounded side task appears.
