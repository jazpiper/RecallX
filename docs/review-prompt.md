# Memforge — External Review Prompt

Use the prompt below when asking another model to review the current documentation set.

---

## Review prompt

You are reviewing a product/design document set for a software concept called **Memforge**.

Your job is **not** to brainstorm endless new features.
Your job is to act like a rigorous product + architecture reviewer and pressure-test the design.

This product is intended to be:
- a **local-first personal knowledge layer for humans and agents**
- usable by a human through a desktop UI
- usable by external tools such as Claude Code, Codex, Gemini CLI, OpenClaw, and future integrations
- optimized for **speed**, **compact context retrieval**, **append-first writes**, **provenance**, and **anti-bloat discipline**

This product is **not** intended to become:
- a bloated productivity suite
- a cloud-required AI app
- a giant orchestration platform
- a graph toy
- a transcript landfill

### Important review stance
Please review with these priorities:
1. preserve speed
2. preserve local-first simplicity
3. preserve trust/provenance
4. prevent product bloat
5. keep the product differentiated as a shared memory layer rather than an AI note app

Do **not** default to “add more features.”
Prefer simplification, stronger boundaries, and clearer operational rules where appropriate.

---

## Documents to review

Read in this order if possible:
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
13. `docs/review-priority.md`

---

## Highest-priority review questions

Please focus especially on these four areas.

### 1) Summary ownership and maintenance model
Pressure-test whether the summary-first retrieval design is operationally realistic.

Questions to answer:
- Who should own summaries and digests?
- How should they be generated and refreshed?
- How can summary maintenance stay cheap enough for a speed-sensitive local-first product?
- Is the current design too vague, too heavy, or about right?

### 2) Durable knowledge promotion rules
Pressure-test the pipeline that separates activity / suggestion / reviewed material / canonical knowledge.

Questions to answer:
- Are the current promotion ideas strong enough to prevent noise?
- What should become canonical versus remain append-only?
- Which parts need stricter operational rules?
- Where is the design still too fuzzy?

### 3) Node vs activity vs artifact boundary
Pressure-test the data-shape boundary.

Questions to answer:
- What belongs as a durable node?
- What belongs only in activity history?
- What should remain merely an artifact reference?
- Are the current docs likely to produce a clean high-signal workspace, or a messy one?

### 4) Relation quality and graph-noise control
Pressure-test graph discipline.

Questions to answer:
- Are the relation rules conservative enough?
- Will agent-generated links likely become noisy?
- Is relation scoring deferred firmly enough for v1?
- What should be simplified or tightened?

---

## Additional review areas

After the top four, also review:

### Product positioning
- Is the product clearly differentiated from Obsidian, Tana, NotebookLM, and internal assistant memory systems?
- Is the core value proposition strong enough without making built-in AI chat the main experience?

### Architecture
- Is desktop app + embedded local service the right shape?
- Is SQLite the right canonical store?
- Is local HTTP + CLI the right integration surface?

### Retrieval
- Is the scout → main pattern realistic and useful?
- Is the hot path / cold path separation strong enough?
- Is the retrieval design fast-first in a believable way?

### UX
- Is the 3-pane desktop UI the right human interface?
- Is the graph correctly treated as secondary?
- Are governance inspection and project-map exploration lightweight enough?

### API / schema
- Are the current API primitives and schema boundaries clean and implementable?
- Are any essential endpoints or fields missing?
- Is anything over-designed for v1?

### Guardrails
- Are the anti-bloat guardrails strong enough to actually preserve the intent of the project?
- Where could the project still drift into heaviness despite the current guardrails?

---

## Output format required

Please structure your response in the following format.

### 1. Executive judgment
Give a concise overall judgment of the document set.
For example:
- strong / promising but needs tightening in X
- overcomplicated in Y
- under-specified in Z

### 2. Biggest strengths
List the 3–7 strongest aspects of the current design.

### 3. Highest-risk weaknesses
List the 3–7 most important weaknesses, ambiguities, or failure risks.

### 4. Review of the top four priority areas
Use one subsection for each:
- Summary ownership
- Promotion rules
- Node vs activity vs artifact boundary
- Relation quality / graph-noise control

For each subsection, include:
- what is good
- what is weak or unclear
- concrete recommended changes

### 5. What should be simplified
List any parts of the design that should be reduced, tightened, or deferred.

### 6. What should be clarified before implementation
List the things that should be documented more concretely before coding starts.

### 7. What should stay exactly as-is
Call out the design choices you think are especially correct and should be protected.

### 8. Final verdict
State whether the project is:
- ready for scaffold/build,
- ready with minor doc fixes,
- or needs another design pass first.

---

## Style constraints for the review

Please keep the review:
- critical but constructive
- concrete rather than vague
- focused on trade-offs
- aligned with speed/local-first/anti-bloat goals

Avoid:
- generic praise only
- idea sprawl
- suggesting lots of adjacent product expansion
- assuming the product should become a cloud SaaS or a full AI workspace suite

If you recommend additions, prefer:
- simpler rules
- clearer boundaries
- stronger defaults
- better trust and retrieval discipline

---

## Optional short instruction

If you have limited time, prioritize reviewing these docs first:
- `docs/concept.md`
- `docs/guardrails.md`
- `docs/retrieval.md`
- `docs/api.md`
- `docs/architecture.md`
- `docs/review-priority.md`

---

End of prompt.
