# Personal Neural Workspace — Guardrails

## 1. Purpose

This document exists to protect the project from drifting away from its core intent.

Personal Neural Workspace is promising precisely because it can become:
- fast
- local-first
- durable
- interoperable
- lightweight enough for real daily use

It can also easily become:
- bloated
- slow
- over-abstracted
- over-automated
- too clever to trust

This document defines the constraints that should keep the product sharp.

---

## 2. Core product intent

The product is:

> **a fast local personal knowledge layer for humans and agents**

It is **not** primarily:
- a giant AI operating system
- a full productivity suite
- a collaborative SaaS platform
- a graph research engine
- a notebook that tries to do everything

Whenever roadmap decisions feel ambiguous, the team should ask:

> Does this make the workspace feel faster, clearer, and more durable?
> Or does it make it heavier, broader, and harder to trust?

---

## 3. Non-negotiable principles

## 3.1 Speed over cleverness
If a feature is impressive but makes the system slower, heavier, or more complex in ordinary use, it should be rejected or deferred.

## 3.2 Local-first by default
The product should work well without cloud dependence for its core use.
Cloud features may exist later, but they must not redefine the product’s center of gravity.

## 3.3 Interoperability over lock-in
The workspace should remain useful even if the user changes their preferred AI tool, coding agent, or model provider.

## 3.4 Durable knowledge over raw accumulation
The goal is not to store everything.
The goal is to preserve the right things in a form that stays useful.

## 3.5 Append-first over silent mutation
Agent behavior should be additive and attributable by default.
Silent rewriting of important knowledge should be rare and explicit.

## 3.6 Inspectability over magic
A result that is slightly less magical but easy to inspect and trust is better than a clever opaque system.

---

## 4. What this product must remain good at

At minimum, the product should remain excellent at these:

1. storing durable local knowledge
2. retrieving relevant context quickly
3. letting multiple tools share one memory layer
4. preserving provenance clearly
5. staying usable as the workspace grows

If a proposed feature does not improve at least one of these, it should face a very high bar.

---

## 5. Anti-goals

These are the most important anti-goals.

## 5.1 Not an all-in-one workspace suite
Do not turn the product into:
- project management software
- calendar software
- chat app replacement
- docs publishing platform
- meeting operating system
- whiteboard/canvas platform

These may look adjacent, but they will dilute the core.

## 5.2 Not an agent orchestration empire
The product can support agents, but it should not prematurely become:
- a universal agent runtime
- a complicated orchestration layer
- a scheduling platform
- a workflow builder

The core is memory and context, not general automation.

## 5.3 Not a giant graph science product
The graph exists to support recall and context, not to become a research object of its own.
If the graph becomes more important than daily usability, the product is drifting.

## 5.4 Not a transcript landfill
Do not normalize dumping huge raw transcripts, giant logs, or endless AI outputs into the main workspace.
That will destroy retrieval quality and product speed.

## 5.5 Not a cloud-required AI shell
The product may connect to powerful external tools, but the workspace itself must not depend on always-available cloud intelligence to remain useful.

---

## 6. Performance guardrails

This project should be treated as speed-sensitive from day one.

## 6.1 Hot path must stay lean
The hot path includes:
- search
- summary fetch
- context assembly
- project recall
- recent activity inspection

Hot path work should avoid:
- mandatory LLM calls
- broad graph crawling
- deep artifact parsing
- expensive synchronous background jobs
- loading huge raw content by default

## 6.2 Summary-first by default
The system should favor:
- summaries
- digests
- compact bundles
- small candidate sets

It should not default to large raw-body handoff.

## 6.3 Context budgets must stay disciplined
The product should prefer:
- `micro`
- `compact`

and only expand to:
- `standard`
- `deep`

when clearly needed.

## 6.4 No heavy magic on every query
If every query triggers semantic ranking, model calls, deep graph scoring, and long bundle generation, the product will become slow and frustrating.

### Rule of thumb
The default query path should be mostly deterministic and local.

---

## 7. Product complexity guardrails

## 7.1 New abstractions need strong justification
Avoid inventing new layers, engines, or object types unless they solve a clear recurring problem.

## 7.2 Prefer fewer primitives
A small number of powerful primitives is better than many overlapping systems.

Good examples:
- node
- relation
- activity
- artifact
- provenance
- context bundle

Be suspicious of proliferating custom entity types too early.

## 7.3 UI must stay restrained
Do not let the UI become crowded with:
- too many modes
- too many dashboards
- giant control panels
- decorative graph views

The UI should help users:
- find things
- inspect context
- review writes
- maintain knowledge

Not manage a spaceship.

## 7.4 Integrations should stay generic
Prefer stable integration contracts over many one-off tool-specific hacks.

If a special case for one tool distorts the architecture, it is probably the wrong approach.

---

## 8. Storage and data-quality guardrails

## 8.1 Not everything deserves durable storage
Before storing something durably, ask:
- Will this still matter later?
- Can it be retrieved meaningfully?
- Is it compact enough to remain useful?
- Should this be a node, an activity, or just an artifact?

## 8.2 Prefer structured summaries over raw dumps
Examples:
- good: concise run summary with links to artifacts
- bad: full unfiltered AI transcript pasted into a canonical note

## 8.3 Canonical knowledge should be curated
Canonical nodes should remain relatively high-signal.
The system should not promote noisy generated content too easily.

## 8.4 Archive, don’t endlessly accumulate in the hot path
Old material may still matter, but it should not burden the hot path by default.

---

## 9. Integration guardrails

## 9.1 Read is easy, write is deliberate
External tools should be able to read context easily.
Writing durable canonical knowledge should stay more constrained.

## 9.2 Scout first, main later
For speed-sensitive integrations, prefer:
- scout retrieval
- compact handoff
- main-agent reasoning

Do not send strong agents on broad browsing missions when a fast scout can narrow the field first.

## 9.3 No privileged permanent tool assumptions
The architecture should not assume one tool will remain the dominant client forever.

Claude Code, Codex, Gemini CLI, OpenClaw, and future tools should all be replaceable clients.

## 9.4 Tool outputs must preserve provenance
Multi-agent use without provenance becomes confusion.
This should never be optional.

---

## 10. AI-specific guardrails

## 10.1 AI should support the memory layer, not define it
The product’s value should not collapse if a particular model is unavailable.

## 10.2 Avoid mandatory AI in the core loop
Core operations like browse, inspect, search, link review, and export should remain useful without model access.

## 10.3 Cheap stages should do cheap work
A scout model should retrieve, compress, and shortlist.
It should not drift into expensive pseudo-main-agent behavior.

## 10.4 Strong models should be used where they matter most
Use stronger models for:
- reasoning
- coding
- synthesis
- planning
- user-facing responses

Not for routine browsing and filtering.

---

## 11. Roadmap guardrails

Before adding a major feature, evaluate it against these questions.

## 11.1 Does it improve the hot path?
If no, be cautious.

## 11.2 Does it strengthen the core memory layer?
If no, be cautious.

## 11.3 Does it increase model dependence?
If yes, be cautious.

## 11.4 Does it increase schema or UI complexity significantly?
If yes, require strong evidence.

## 11.5 Can it be added later without harming the foundation?
If yes, defer it.

### Rule
When in doubt, defer.

---

## 12. Signs the project is drifting

These are warning signs.

### Architectural drift
- too many services
- too many background jobs
- too many query modes
- too many special-case integration paths

### Product drift
- the app feels like a dashboard before it feels like a memory tool
- graph visuals become more important than recall quality
- features are added because they are adjacent, not essential

### Performance drift
- hot path depends on model calls
- context bundles keep growing by default
- search becomes inconsistent or hard to predict
- routine actions feel slower as data grows

### Data-quality drift
- canonical notes become cluttered with generated noise
- provenance becomes partial or inconsistent
- retrieval starts surfacing too much low-signal content

If these signs appear, simplify before adding more features.

---

## 13. Default decision bias

When choosing between two directions, prefer the one that is:
- simpler
- faster
- more local
- easier to inspect
- more portable
- less magical
- easier to maintain

Even if it seems less ambitious in the short term.

The product will win by being reliably useful, not by looking maximally futuristic.

---

## 14. Practical heuristics

### Good additions
- faster summary retrieval
- better project context bundles
- clearer provenance views
- better review flow
- cleaner append/write-back patterns
- safer import/export

### Suspicious additions
- broad collaboration systems
- giant plugin frameworks too early
- automatic semantic everything
- multi-hop graph intelligence on every request
- always-on background inference pipelines
- complex permission systems before real need

### Likely bad additions for early versions
- built-in chat-first AI shell as the main UI
- full task/project management expansion
- workflow automation builder
- social or multiplayer features
- deeply nested ontology modeling

---

## 15. Final rule

If a proposed change makes Personal Neural Workspace feel more like:
- a fast memory substrate
- a durable local context layer
- a useful bridge between humans and agents

then it is likely aligned.

If it makes the product feel more like:
- a bloated knowledge empire
- a giant AI meta-platform
- a slow graph laboratory
- an all-purpose work operating system

then it is likely misaligned.

---

## 16. Summary

The product should stay disciplined.

It should be:
- small enough to stay fast
- structured enough to stay useful
- open enough to work with many tools
- careful enough to stay trustworthy

Its strength will come from restraint.
Not from trying to become everything around it.
