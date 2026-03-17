# Personal Neural Workspace — Integrations

## 1. Integration goal

The purpose of integrations is not to make Personal Neural Workspace own every workflow.
The goal is to let many external tools share one durable local knowledge layer.

This document defines practical integration patterns for:
- Claude Code
- Codex
- Gemini CLI
- OpenClaw
- generic local tools and scripts

The product should treat all of these as clients of the same local workspace rather than building special-case product logic around any single one.

---

## 2. Core integration principles

### 1) Local-first access
Integrations should connect to a local service or local CLI bridge, not require cloud mediation.

### 2) Stable interface, replaceable tools
Tool-specific wrappers can change, but the underlying workspace contract should remain stable.

### 3) Read is easy, write is deliberate
Reading context should be simple. Writing durable knowledge should preserve provenance and often be append-first.

### 4) Context packages beat raw dumps
Most tools should consume compact bundles, not the entire graph.

### 5) Provenance must be explicit
Every integrated write should record:
- which tool wrote it
- when it wrote it
- what operation it performed

### 6) Speed is a product requirement
The workspace should help strong main agents think, not browse.
For speed-sensitive workflows, integrations should prefer a fast scout stage that rapidly searches, ranks, and compresses relevant context before the main agent is invoked.

---

## 3. Integration surface options

The product should support at least two integration surfaces.

## A. Local HTTP API
Best default surface for structured integrations.

Advantages:
- language-agnostic
- easy for wrappers/scripts
- good for desktop-local apps
- can support JSON payloads cleanly

## B. Local CLI bridge
Best ergonomic surface for terminal-native tools.

Advantages:
- easy to call from shell workflows
- easy to wrap inside agent prompts/scripts
- useful even when HTTP integration is unavailable

### Recommendation
Build both, with CLI as a thin wrapper around the local API.

---

## 4. Integration capability levels

Different tools may need different levels of access.

## Level 1 — Read-only
Allowed operations:
- search
- get node
- list related nodes
- get context bundle

## Level 2 — Append-only
Allowed operations:
- create node
- append activity
- attach artifact
- propose relation

## Level 3 — Governed write
Allowed operations:
- update canonical node
- create active relation directly
- archive or promote nodes

### Recommendation for early releases
Default most integrations to:
- read-only
or
- append-only

Avoid broad governed write until trust and UX are proven.

---

## 5. Shared workflow pattern

Most integrations should follow this sequence.

### Common pattern
1. tool asks for context
2. workspace returns compact, relevant bundle
3. tool performs its main work externally
4. tool optionally writes back:
   - summary
   - activity log
   - artifact reference
   - suggested relation
5. user reviews high-impact changes if required

This keeps Personal Neural Workspace as the durable memory layer rather than the execution engine.

## 5.1 Scout/Main retrieval pattern

For speed-sensitive workflows, integrations may use a two-stage retrieval flow:

1. a **scout** stage rapidly scans the workspace
2. the scout returns a shortlist or compressed working set
3. the **main agent** uses only that curated context for deeper reasoning or execution

### Scout responsibilities
- run fast keyword / metadata / graph-neighborhood queries
- fetch summaries instead of full node bodies when possible
- gather recent activities, decisions, and open questions
- rank candidate nodes for relevance
- produce a compact context handoff

### Main agent responsibilities
- planning
- deep reasoning
- coding
- synthesis
- user-facing output
- high-value write-back

### Why this pattern matters
- reduces latency
- lowers token cost
- prevents strong models from wasting effort on broad browsing
- keeps large workspaces usable as they grow

### Important note
The scout does **not** have to be an LLM.
A scout may be:
- pure retrieval and ranking logic
- a cheap/fast model
- a hybrid of retrieval plus a small model

The product should support all three.

---

## 6. Claude Code integration

## Primary role
Claude Code is a coding-focused external tool that should be able to:
- read project context
- read past design decisions
- append implementation notes
- attach generated artifacts or patch references

## Best integration shape
- local CLI wrapper
- optional local HTTP adapter

### Example use cases
- fetch context for a repo task
- store implementation summary after a coding run
- add a relation from a new design note to a project node
- attach generated architecture notes or code review summaries

### Example CLI flow
```bash
pnw context project_42 --mode standard > /tmp/pnw-context.md
# Claude Code consumes the context
pnw append node_project_42 --type agent_run_summary --source claude-code --file result.md
```

### Recommended write policy
Claude Code should default to:
- append activity
- create suggested notes
- attach artifacts
- propose relations

Not default to:
- rewriting canonical decision nodes
- deleting or archiving core knowledge

---

## 7. Codex integration

## Primary role
Codex-style tools are also coding and implementation oriented, similar to Claude Code, but may differ in workflow structure.

## Best integration shape
- local CLI bridge first
- HTTP API optional later

### Example use cases
- request the latest architecture context before coding
- append a run summary after implementation
- store references to diffs, patches, or output files
- create a new note for discovered technical debt

### Example workflow
1. `pnw context <project>`
2. Codex performs implementation work
3. Codex wrapper writes back:
   - summary note
   - activity entry
   - attached diff artifact reference

### Recommended write policy
Same as Claude Code:
- append-first
- provenance required
- high-impact canonical edits reviewed

---

## 8. Gemini CLI integration

## Primary role
Gemini CLI may be used more for:
- research
- synthesis
- broad ideation
- document exploration

## Best integration shape
- local CLI wrapper
- context bundle export files
- local HTTP API if the tool environment supports it well

### Example use cases
- fetch a research bundle around a topic
- append research notes back into a project node
- create reference nodes from a research session
- propose links between concepts discovered during exploration

### Recommended write style
Gemini CLI integrations should be especially good at:
- creating `reference` nodes
- appending `agent_run_summary`
- proposing `related_to` / `supports` / `contradicts` links

---

## 9. OpenClaw integration

## Primary role
OpenClaw is a strong fit because it acts like a personal assistant with memory, task continuity, and multi-tool orchestration.

## Best integration shape
- direct local HTTP integration
- optional local CLI fallback
- possible memory sync/adaptation layer

### High-value use cases
- retrieve durable project context before answering
- write durable notes from long conversations
- append summaries of external work
- maintain project continuity across sessions
- create decision records or open questions
- fetch user preference or long-term context bundles when appropriate

### Possible patterns
#### Pattern A — Read-through memory
OpenClaw queries the workspace during relevant tasks:
- search
- get related nodes
- get project bundle

#### Pattern B — Write-back memory
OpenClaw writes durable records when appropriate:
- summary notes
- decision nodes
- activity logs
- artifact references

#### Pattern C — Hybrid memory model
OpenClaw keeps its own working/session memory but promotes durable, cross-tool knowledge into Personal Neural Workspace.

This may be the strongest long-term model.

### Recommended write policy
OpenClaw should typically have:
- read access
- append-only write access
- explicit promotion path for canonical durable knowledge

---

## 10. Generic shell/script integration

Not every useful workflow needs deep native integration.

## Why generic scripts matter
Many users will want to connect:
- shell scripts
- cron jobs
- local automations
- MCP-style bridges later
- custom project tools

## Recommended approach
Provide a stable CLI such as:

```bash
pnw search "agent memory"
pnw get node_123
pnw context project_42 --mode compact
pnw append node_123 --type note_appended --source custom-script --text "Build passed locally"
pnw link node_123 node_456 related_to --source custom-script
```

This expands the product’s utility without waiting for polished first-party integrations everywhere.

---

## 11. Context bundle design for integrations

This is the most important integration primitive.

In speed-sensitive flows, context bundles should usually be assembled by the scout stage first, then passed to the main agent as a compact working package.

## 11.1 Bundle goals
A context bundle should be:
- compact enough to use in external tools
- rich enough to preserve continuity
- traceable back to source nodes
- shaped for the target use case

## 11.2 Suggested bundle types
### `project`
Includes:
- project summary
- related decisions
- active questions
- recent activities
- linked artifacts

### `topic`
Includes:
- concept summary
- connected notes
- supporting/contradicting nodes
- key references

### `task`
Includes:
- relevant project node
- recent task notes
- linked design decisions
- implementation history if available

### `agent-handshake`
Includes:
- workspace identity
- target project/topic
- key conventions
- relevant context bundle references

## 11.3 Output forms
Support at least:
- JSON
- markdown
- plain text summary

This lets different tools consume the same bundle in different ways.

---

## 12. Write-back patterns

Different tools should write back in different levels of ambition.

## Pattern 1 — Activity-only write-back
Safest default.

Example:
- tool completes work
- writes summary into activities
- attaches artifact if needed

## Pattern 2 — Suggested note creation
Tool creates a non-canonical node for review.

Good for:
- research summaries
- implementation notes
- imported findings

## Pattern 3 — Relation suggestion
Tool proposes a link that may require review.

Good for:
- semantic connections
- contradiction links
- support/elaboration edges

## Pattern 4 — Canonical update
Reserved for later or trusted flows only.

Good only when:
- scope is narrow
- provenance is preserved
- review path exists

---

## 13. Provenance requirements by integration

Every integration write should include:
- actor type
- actor label
- tool name
- timestamp
- operation type
- source reference if available

### Example provenance labels
- `Claude Code`
- `Codex`
- `Gemini CLI`
- `OpenClaw`
- `custom-script:deploy-summary`

### Why this matters
In a multi-agent environment, provenance is not a nice-to-have.
It is the difference between trust and confusion.

---

## 14. Authentication and local security

The integration layer should be easy but not reckless.

## Baseline
- local loopback-only HTTP service
- per-workspace auth token or session token
- optional integration registration
- write permissions checked locally

## For CLI
- CLI uses the same local auth under the hood
- local config file should not expose secrets recklessly

## Recommendation
Start simple, but never expose the API on LAN/public interfaces by default.

---

## 15. Integration UX in the desktop app

The human UI should include a basic integrations panel.

### It should show
- registered integrations
- last access time
- allowed capability level
- status
- recent write activity

### It should allow
- enable / disable integration
- rotate token
- set read-only vs append-only
- inspect recent writes by integration

This is important for trust and debuggability.

---

## 16. MVP integration priority

Do not try to build everything at once.

## Recommended order
### Priority 1
- generic local CLI bridge
- OpenClaw proof-of-concept

### Priority 2
- Claude Code wrapper
- Codex wrapper

### Priority 3
- Gemini CLI wrapper
- richer bundle presets

### Priority 4
- more formal SDKs or plugin APIs

Why this order:
- generic CLI unlocks many workflows quickly
- OpenClaw is a high-leverage personal memory client
- coding tools are practical daily drivers
- richer integrations can come after core patterns stabilize

---

## 17. Example end-to-end scenarios

## Scenario A — Coding task with Claude Code
1. User selects a project in Personal Neural Workspace
2. A fast scout stage fetches a compact task context bundle
3. Claude Code consumes only the curated bundle
4. Claude Code completes implementation externally
5. Claude Code appends:
   - one activity summary
   - one artifact reference
   - optional suggested relation to a design note

## Scenario B — Research burst with Gemini CLI
1. User requests a topic bundle
2. Gemini CLI explores and synthesizes findings
3. Integration creates:
   - one reference node
   - one activity summary
   - optional support/contradiction relations

## Scenario C — Long-term assistant continuity with OpenClaw
1. OpenClaw retrieves project and user-preference context
2. OpenClaw helps over multiple sessions
3. Durable outputs are promoted into the workspace as notes, decisions, and activities
4. Later, Claude Code or Codex can reuse the same project memory

This scenario is one of the strongest demonstrations of the product’s value.

---

## 18. Failure modes to avoid

- tool-specific schemas that fragment the workspace
- raw transcript dumping without structure
- hidden writes with no provenance
- broad write permissions too early
- huge context bundles that are expensive and noisy
- integrations that require cloud dependency for basic use

---

## 19. Summary

The right integration strategy is simple:

- one stable local knowledge layer
- one stable local integration contract
- many replaceable tools
- easy read access
- append-first write access
- explicit provenance everywhere

If done well, Personal Neural Workspace becomes the shared memory fabric across the user’s entire agent/tool ecosystem.
