# Personal Neural Workspace — Concept Document

## 1. One-line definition

**Personal Neural Workspace** is a local-first personal knowledge layer where humans and multiple AI agents can read, write, search, and connect ideas through a shared neural workspace.

It is not primarily an AI note-taking app.
It is a **durable personal knowledge substrate** for notes, projects, questions, decisions, references, and relationships — designed to be usable by both people and tools such as Claude Code, Codex, Gemini CLI, OpenClaw, and other local or remote agents.

---

## 2. Why this product should exist

Today, personal knowledge is fragmented across:

- markdown vaults
- chat histories
- coding assistants
- project docs
- task tools
- internal memory systems inside different AI products

Each tool can be useful in the moment, but continuity is weak.

Typical problems:
- Claude Code knows something that Codex does not
- an AI assistant has useful context, but it is trapped in its own session memory
- notes exist, but are not structured for agent access
- project decisions are recorded, but not easy to retrieve by context
- ideas are stored, but relationships between them are weak or invisible

Users do not need another isolated note app.
They need **one durable, local knowledge base that many tools can think with**.

---

## 3. Core thesis

The real opportunity is not “an app with AI inside.”
The opportunity is a **shared knowledge layer for people and agents**.

### Traditional model
- notes are for humans only
- AI assistants each have separate memory
- knowledge continuity is tool-specific

### Personal Neural Workspace model
- knowledge is stored locally in a durable graph-like structure
- both humans and agents can access the same source of truth
- ideas, projects, questions, and decisions persist across tools
- any single model can be replaced without losing the knowledge base

This makes the product closer to a **personal context OS** than a simple note app.

---

## 4. Product vision

Build a workspace that acts like a personal neural layer:

- knowledge stays local and portable
- thoughts are stored as nodes, not just flat files
- relationships are first-class and queryable
- agents can append, search, and link knowledge safely
- context can be packaged and delivered into any compatible tool
- users can inspect, refine, and govern their own knowledge graph

The system should feel like:
- a personal memory layer
- a graph-backed knowledge store
- a bridge between human thinking and agent workflows

---

## 5. What the product is — and is not

### It is
- a local-first knowledge repository
- a neural-style graph of personal context
- a human UI for browsing and maintaining knowledge
- an agent-readable and agent-writable memory layer
- a portable context system for multiple tools

### It is not
- just another chat app
- primarily an AI writing assistant
- a model-specific product
- a SaaS-first collaborative note platform
- a pure visual graph toy

---

## 6. Primary use cases

### 1) Shared context across coding tools
A user works with Claude Code, Codex, Gemini CLI, and OpenClaw.
All of them should be able to:
- retrieve relevant project context
- read prior design decisions
- append execution notes
- link outputs to projects and concepts

### 2) Persistent personal memory
A user wants their ideas, decisions, references, and open questions to persist across time and across tools.

### 3) Project continuity
Project context should not be trapped in a single thread, terminal session, or app.
It should live in a reusable knowledge layer.

### 4) Local knowledge governance
The user should own the storage, schema, export, and access policy.

---

## 7. Product principles

### 1) Local-first by default
The knowledge base is primarily stored on the user’s machine.
Cloud sync, if ever added, is optional.

### 2) Model-agnostic by design
Claude, Codex, Gemini, OpenClaw, local models, and future tools should all be replaceable clients of the system.

### 3) Knowledge is the asset, not the model
The graph, notes, links, decisions, and history are the durable value.
Any single AI provider is interchangeable.

### 4) Append-first for agents
Agents should primarily append, annotate, or propose changes rather than silently rewriting core knowledge.

### 5) Provenance matters
The system should preserve where knowledge came from:
- human-authored
- imported
- agent-generated
- summarized
- inferred

### 6) Humans stay in control
Users should be able to review, edit, promote, archive, reject, and reorganize knowledge.

---

## 8. Core object model

### Node
A node represents a durable unit of knowledge.
Possible node types:
- note
- project
- idea
- question
- decision
- person
- reference
- artifact
- conversation
- task (optional later)

### Relation
A relation connects nodes.
Examples:
- related_to
- supports
- contradicts
- caused_by
- elaborates
- depends_on
- derived_from
- produced_by
- relevant_to

### Activity
An activity records time-based events or append-only updates.
Examples:
- agent run completed
- design decision proposed
- summary generated
- file artifact attached
- meeting note added

### Source / Provenance
Tracks how the knowledge entered the system.
Examples:
- human note
- imported markdown
- Claude Code append
- OpenClaw memory sync
- Codex result
- Gemini CLI run output

This allows the system to behave like a personal neural history, not just a static notebook.

---

## 9. Required interfaces

The product should expose three major interfaces.

### A. Human UI
For people to:
- write and edit notes
- inspect node relationships
- search by keyword and semantic meaning
- browse projects and decisions
- review agent-appended knowledge
- inspect provenance and history

### B. Agent API / Local service
For external tools and agents to:
- search nodes
- fetch context bundles
- create notes and artifacts
- append activity logs
- suggest or create links
- attach outputs to projects
- query related context for a task

### C. Filesystem bridge
For interoperability with local workflows:
- markdown import/export
- directory watching (optional later)
- JSON export/import
- artifact attachment storage
- backup-friendly local files

---

## 10. Key product behavior

### 1) One knowledge base, many tools
A user can maintain one durable workspace while connecting multiple agent clients to it.

### 2) Context packaging
The system can prepare relevant context bundles for external tools.
For example:
- project summary + decisions + recent activity
- related notes + open questions
- artifact links + prior agent outputs

### 3) Agent append workflow
Agents should be able to write structured additions such as:
- result notes
- implementation logs
- proposed links
- artifact references
- summaries of a run

### 4) Reviewable memory updates
Important changes should be inspectable.
The user should be able to see what came from which agent and decide what becomes canonical.

---

## 11. What makes it different

### vs Obsidian
Obsidian is primarily a human-facing linked note system.
Personal Neural Workspace should be a **human-and-agent shared knowledge layer**.

### vs NotebookLM
NotebookLM reasons over a provided document set.
Personal Neural Workspace should be a **persistent, evolving local memory substrate**.

### vs internal AI memories
Many AI tools have their own internal memory, but those memories are siloed.
Personal Neural Workspace aims to be **tool-independent memory infrastructure**.

### vs general AI note apps
Most AI note apps try to add generation and summarization inside the product.
This product instead focuses on **durable knowledge interoperability**.

---

## 12. MVP hypothesis

Users will find strong value in a local knowledge system that can be shared across multiple AI tools and preserved independently of any single vendor.

If users can reliably use one workspace with several agents and feel improved continuity, the product has real leverage.

---

## 13. MVP direction

The first version should be intentionally narrow.

### Focus
- local knowledge storage
- node and relation model
- search and retrieval
- human browsing UI
- agent read/write API
- provenance-aware append flow

### Avoid in v1
- heavy collaborative features
- complex team permissions
- cloud-first sync
- built-in general chat assistant as the main experience
- broad productivity suite features

---

## 14. Candidate positioning lines

- **One brain, many tools.**
- **A personal knowledge layer for humans and agents.**
- **Keep your knowledge local. Let every agent think with it.**
- **Your local neural workspace for Claude Code, Codex, Gemini CLI, OpenClaw, and beyond.**
- **Bring your own model. Keep your own mind.**

---

## 15. Risks and traps

### 1) Becoming a generic note app
If the product just looks like another markdown or PKM tool, the core idea gets diluted.

### 2) Overbuilding agent automation too early
The first job is durable context sharing, not autonomous agent orchestration.

### 3) Weak interoperability
If external tools cannot integrate easily, the product loses its main advantage.

### 4) Poor provenance and trust
If users cannot tell what came from which tool or agent, trust will collapse.

### 5) Too much hidden rewriting
Silent agent edits to important knowledge will feel dangerous.

---

## 16. Strategic direction

The strongest version of Personal Neural Workspace is not a smarter notebook.
It is a **local personal memory infrastructure layer**.

Over time, it can become:
- a shared context bus for personal AI tools
- a durable project memory system
- a reasoning and decision archive
- a user-owned graph of long-term context

If executed well, it becomes the user’s canonical knowledge layer across models, tools, projects, and time.

---

## 17. Next recommended documents

After this concept doc, the next useful artifacts are:

1. `docs/mvp.md` — scope, features, boundaries, and phased rollout
2. `docs/architecture.md` — local storage, node schema, API, provenance, and integration plan
3. `docs/integrations.md` — Claude Code / Codex / Gemini CLI / OpenClaw integration patterns
4. `docs/ux.md` — human UI flows for search, browse, review, and graph inspection
