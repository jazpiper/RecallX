# Memforge — Review Brief

## 1. Purpose of this document

This brief is for a reviewer who wants to quickly understand the project, its constraints, and the most important things to pressure-test.

It is intentionally shorter than the full document set.

---

## 2. Product in one paragraph

Memforge is a **local-first personal knowledge layer for humans and agents**.
It is meant to store durable knowledge — notes, projects, ideas, questions, decisions, references, activities, and relations — in one local workspace that can be used by both a human-facing desktop app and multiple external tools such as Claude Code, Codex, Gemini CLI, and OpenClaw.

The product is not primarily an AI note app. It is a **shared memory substrate** with fast retrieval, compact context handoff, provenance-aware append-first writes, and careful anti-bloat constraints.

---

## 3. Core thesis

The project assumes that the user’s context is currently fragmented across:
- note apps
- coding assistants
- chat sessions
- local docs
- tool-specific memory systems

The product’s core thesis is:

> one durable local workspace should be reusable by many tools, without locking the user into a single model or assistant

---

## 4. Primary strengths of the current design

### 1) Clear local-first stance
The documents consistently prefer local storage, loopback-only API access, portability, and low cloud dependence.

### 2) Good anti-bloat discipline
The project explicitly rejects becoming:
- an all-in-one productivity suite
- a giant orchestration platform
- a graph toy
- a transcript landfill

### 3) Strong retrieval philosophy
The retrieval design is one of the strongest parts of the concept:
- summary-first
- scout → main pattern
- compact context budgets
- deterministic retrieval first
- optional semantic enhancement later

### 4) Strong provenance and append-first model
The write path is thoughtfully constrained so external tools can contribute without silently taking over canonical knowledge.

### 5) Good interoperability framing
The product is defined as a tool-agnostic memory layer rather than a model-specific assistant product.

---

## 5. Core design decisions to validate

A reviewer should especially pressure-test these decisions:

### 1) Desktop-local app + embedded local service
Is this the right deployment shape for the initial product?

### 2) SQLite as canonical store
Is SQLite sufficient and ergonomically appropriate for the intended early workload?

### 3) Summary-first retrieval
Are the proposed summary/digest layers enough to keep the hot path fast without creating excessive maintenance burden?

### 4) Append-first external writes
Is the balance right between safety and usefulness for integrated tools?

### 5) 3-pane restrained desktop UI
Does the proposed UI shape correctly support search, inspection, and review without drifting into dashboard sprawl?

---

## 6. Important open questions

These are the most important unresolved issues across the current docs.

### A. Summary ownership
Who is responsible for maintaining summary fields and digests?
- human edits?
- deterministic derivation?
- optional model-generated summaries?
- background regeneration?

This is important because retrieval relies heavily on summaries.

### B. Canonical promotion rules
Exactly when should:
- activity
- suggested note
- review queue decision
- canonical node

transition from one state to another?

The current docs describe the philosophy, but the exact promotion workflow may need more operational detail.

### C. Node-vs-activity boundary
In practice, what types of write-back become:
- a node
- an activity
- just an artifact?

This boundary will heavily affect data quality and retrieval quality.

### D. Tags and metadata strategy
The schema intentionally keeps tags simple early.
A reviewer may want to challenge whether this is enough or whether project membership and certain metadata should become first-class sooner.

### E. Relation quality
How strict should relation creation be in v1?
There is a tension between useful connectivity and graph noise.

### F. Search explainability
The docs prefer deterministic retrieval first, which is good.
But the product may benefit from a more explicit explanation strategy for “why this result/bundle was returned.”

---

## 7. Suggested review questions

A reviewer can use these questions to critique the system.

### Product
- Is the product differentiated enough from Obsidian, Tana, NotebookLM, and internal assistant memory systems?
- Is the initial scope disciplined enough?
- Is the value proposition strong without built-in AI chat as the main experience?

### Architecture
- Is Electron + local Node service the right initial implementation path?
- Is the local HTTP + CLI dual interface the right contract surface?
- Are there missing persistence or migration concerns?

### Retrieval
- Is the scout/main model realistic and useful?
- Is the retrieval strategy fast enough in principle?
- Is the hot path/cold path separation clear and sufficient?

### Schema / API
- Are the node/relation/activity/provenance boundaries clean?
- Is the API too broad, too narrow, or about right?
- Are any critical fields or endpoints missing?

### UX
- Is the 3-pane model the right fit?
- Is the graph correctly demoted to inspection role?
- Is the review queue lightweight enough?

### Guardrails
- Are the anti-bloat constraints strong enough to actually protect the product?
- Are there hidden ways the project could still drift into a heavy platform?

---

## 8. Recommended reading order for reviewers

If a reviewer has limited time:

1. `README.md`
2. `docs/review-brief.md`
3. `docs/concept.md`
4. `docs/guardrails.md`
5. `docs/retrieval.md`
6. `docs/api.md`
7. `docs/architecture.md`
8. `docs/schema.md`
9. `docs/ux.md`
10. `docs/build-plan.md`
11. `docs/integrations.md`
12. `docs/mvp.md`

If they have even less time, the most important docs are probably:
- `concept.md`
- `guardrails.md`
- `retrieval.md`
- `api.md`
- `architecture.md`

---

## 9. Overall status

The project has moved beyond a docs-only concept into a working local implementation scaffold.

What is now real:
- local Node/TypeScript service with SQLite-backed workspaces
- loopback HTTP API and thin `pnw` CLI
- runtime workspace create/open switching without restarting the service
- append-first governance and review queue behavior
- React renderer with live API-first loading and first-pass review/search/settings flows
- stdio MCP bridge for coding-agent tool calls over the existing local API

What is still early:
- renderer polish and end-to-end UX refinement
- broader real-world multi-tool workflows
- packaging/distribution beyond the local development scaffold

The biggest remaining risk is not lack of ideas.
It is preserving discipline so the product stays fast, compact, and useful.
