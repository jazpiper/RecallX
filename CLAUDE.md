# Harness Engineering: Agent Orchestration

## Role Separation

- **Main session** acts as orchestrator only. Do NOT implement features directly.
- Break tasks into discrete sub-tasks and delegate each to a sub-agent via the Agent tool.
- Review sub-agent results, then either assign follow-up work or commit.

## Sub-Agent Usage

- For implementation work: use `subagent_type: "general-purpose"` with a self-contained prompt.
- For codebase research: use `subagent_type: "Explore"`.
- For planning/architecture: use `subagent_type: "Plan"`.
- Always include complete context in each sub-agent prompt — they cannot see this conversation.
- Run multiple independent sub-agents in parallel when possible.

## Context Management

- When a sub-task completes, compact the conversation before starting the next one.
- Summarize key outcomes in a short status note before compacting.
- Keep the main session's context focused on: current task list, decisions made, blockers.
