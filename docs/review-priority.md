# Personal Neural Workspace — Review Priorities

## 1. Purpose

This document defines the four highest-priority review questions for the current design.

These are the areas most likely to determine whether Personal Neural Workspace becomes:
- fast and durable
or
- noisy, heavy, and hard to trust

The goal is to focus external review effort on the few questions with the highest leverage.

---

## 2. Priority order

## Priority 1 — Summary ownership and maintenance model

### Core question
Who owns the summary layer, and how is it kept accurate without making the system heavy?

### Why this is #1
The entire retrieval strategy depends on summary-first behavior.
If summaries are weak, stale, expensive to maintain, or inconsistent, then:
- scout retrieval quality drops
- context bundles get worse
- hot path gets slower
- full-body fetches become too common

That would damage the product’s core advantage.

### What should be reviewed
- Should summaries be primarily:
  - human-authored,
  - deterministically derived,
  - model-assisted,
  - background-generated,
  - or hybrid?
- Which summary types are truly necessary in v1?
- How often should summaries be regenerated?
- What happens when summaries go stale?
- How can summary maintenance stay cheap and local-first?

### What a good answer looks like
A good review outcome should produce:
- a small number of summary classes
- a low-maintenance ownership model
- minimal dependency on expensive model calls
- a path that preserves speed as the workspace grows

---

## Priority 2 — Durable knowledge promotion rules

### Core question
What exact rules decide whether something stays an activity, becomes a suggested note, or gets promoted into canonical knowledge?

### Why this is #2
This product will fail if it either:
- stores too little and loses continuity
or
- stores too much and becomes a noisy landfill

The promotion pipeline is the main mechanism that keeps the workspace useful.

### What should be reviewed
- What should default to:
  - activity
  - suggested node
  - reviewed node
  - canonical node
- Which sources should be trusted more or less by default?
- Which writes should require explicit human review?
- Should some node types, such as decisions, have stricter promotion rules?
- How should archived but still relevant material remain retrievable without polluting the hot path?

### What a good answer looks like
A good review outcome should produce:
- crisp promotion criteria
- strong noise-control rules
- a clear human curation role
- confidence that write-back from tools will not bloat the workspace

---

## Priority 3 — Node vs activity vs artifact boundary

### Core question
What belongs in a durable node, what belongs only in an activity stream, and what should live as an external artifact reference?

### Why this is #3
This boundary controls:
- storage quality
- retrieval quality
- UI clarity
- long-term maintainability

If the system gets this wrong, the workspace will either feel too thin or become overloaded with low-signal material.

### What should be reviewed
- What classes of information should become first-class nodes?
- When should tool output be stored only as:
  - activity summary
  - artifact attachment
  - both
- Should raw transcripts almost always stay outside canonical nodes?
- Should implementation logs stay as activities unless manually promoted?
- What is the right threshold for creating new nodes versus appending to existing context?

### What a good answer looks like
A good review outcome should produce:
- a practical classification heuristic
- examples of common write-back cases
- a bias toward compact durable knowledge
- less ambiguity for future implementation

---

## Priority 4 — Relation quality and graph-noise control

### Core question
How should the system preserve useful connections without letting the graph become noisy, inflated, or misleading?

### Why this is #4
The product depends on relationships, but graph quality is fragile.
If relations become too noisy:
- retrieval relevance drops
- graph inspection becomes less trustworthy
- users lose confidence in automated suggestions

### What should be reviewed
- Which relation types should be allowed in v1 without review?
- Should agent-created relations default to `suggested` in almost all cases?
- How much relation automation is actually justified early?
- Should relation strength and confidence both exist in v1, or is that too much complexity?
- What anti-duplication or anti-spam logic is necessary for links?

### What a good answer looks like
A good review outcome should produce:
- conservative relation defaults
- clear review thresholds
- a simple but trustworthy edge model
- less chance of the graph becoming decorative or noisy

---

## 3. Why these four were prioritized

These four were chosen because they sit at the intersection of:
- retrieval quality
- speed
- trust
- long-term usability
- anti-bloat discipline

Other topics matter too, but these four are the highest leverage because they shape whether the workspace remains:
- compact
- high-signal
- fast
- maintainable

---

## 4. Topics intentionally placed below the top four

The following topics still matter, but were not prioritized ahead of the four above:
- Electron vs Tauri
- exact API ergonomics
- UI polish choices
- semantic retrieval timing
- per-tool permission detail
- sync strategy
- plugin strategy

These are important, but they are less existential than the top four design boundaries.

---

## 5. Reviewer instruction

A reviewer should focus first on whether the current design is sufficiently strong and concrete in these four areas.

If the answer is “not yet,” the review should suggest:
- what to simplify
- what to make stricter
- what to delay
- what to operationalize more clearly

The preferred review style is not maximum feature expansion.
It is disciplined refinement in service of speed, clarity, and durability.
