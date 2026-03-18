## Default Workflow

- Memforge is the primary durable memory system for this workspace.
- For software, product, and operations work, proactively use connected Memforge, Linear, and Notion when they are available and authenticated.
- Use Memforge for durable working memory: decisions, stable project facts, open questions, summaries of completed work, and relationships between projects, notes, issues, and artifacts.
- Use Linear primarily for execution tracking: relevant project lookup, issue context, issue status, and work progress.
- Use Notion primarily for durable human-readable context: decisions, operating principles, summaries, and project hub updates.
- Before starting substantial work, check whether relevant Memforge context already exists. Check relevant Linear or Notion context as well when it is likely to affect execution or documentation.
- After meaningful work, prefer reflecting important status, decisions, or outcomes in Memforge and in Linear and/or Notion when appropriate unless the user explicitly says not to.
- If no relevant Memforge, Linear, or Notion context is found, state that briefly and continue with local work.
- Do not expose secrets or sensitive credentials when reading from or writing to Memforge, Linear, or Notion.

## Memforge Memory Workflow

### Start-of-task behavior

- At the beginning of a meaningful task, search Memforge for relevant prior context using project names, feature names, issue IDs, file names, and key concepts from the user request.
- Prefer `memforge_context_bundle` when a known project or node is already identified; otherwise start with `memforge_search_nodes`.
- If a relevant node exists, read the node and related context before making assumptions.
- Never rely only on conversation history when durable project memory may already exist in Memforge.

### During-task behavior

- When you discover a durable fact worth keeping, record it in Memforge.
- Create or update memory entries for:
  - important decisions
  - stable project facts
  - open questions that will matter later
  - summaries of completed work
  - relationships between projects, issues, notes, references, and artifacts
- Prefer concise, reusable memory entries over verbose logs.
- Agent-created relations should default to suggested until reviewed.

### End-of-task behavior

- After meaningful work, write back the outcome to Memforge.
- Record what changed, why it changed, any unresolved questions or follow-ups, and relevant relations to existing nodes when applicable.
- Briefly mention in the final response whether Memforge was updated when that is materially useful to the user.

### Memory Quality Rules

- Do not store secrets, credentials, tokens, or raw sensitive data.
- Do not store noisy transient details unless they are likely to matter in a future session.
- Prefer canonical nodes for durable concepts and append-only updates for work history.
- Use clear titles, summaries, and tags so memory can be found later.
