# RecallX - Optimization Roadmap

## Purpose

RecallX has reached a point where continued product expansion carries more risk than leverage.

The product now has:

- Home re-entry and search-first recall
- project-aware capture and active project continuity
- import preview and duplicate handling
- lightweight node and relation governance
- decision recall across Home, Governance, notes, and command palette

That is enough product surface for the next phase.

The goal of this roadmap is to shift the repo into a temporary feature-freeze mode and focus on:

- hot-path speed
- renderer simplicity
- test confidence
- operational trust

This is not a permanent freeze. It is a deliberate stabilization phase.

## Mode

RecallX is now in `feature freeze` mode for normal product work.

What this means:

- do not open a new rolling product queue by default
- prefer optimization, simplification, and reliability work over new UI or workflow surfaces
- only add new features when they unblock optimization work or fix a clear product gap

### Exit rule

Leave feature-freeze mode only when all of the following are true:

- the top optimization batches below are shipped or intentionally deferred
- hot-path renderer and API behavior feel measurably calmer in normal use
- current known test and observability gaps are narrowed enough that new feature work will not compound hidden instability

## Current optimization queue snapshot

Queued for this finite optimization run:

- O1. hot-path profiling checklist and baseline capture
- O2. renderer shell simplification around `App.tsx`
- O3. governance and review recall derivation tightening
- O4. import cold-path structure cleanup
- O5. test-noise reduction and confidence-gap coverage

Stop rule for this queue:

- the run is complete when O1 through O5 are shipped or intentionally deferred
- any new optimization idea discovered during this run should be recorded as a later candidate unless it clearly blocks one of O1 through O5

## Optimization principles

### 1. Protect the hot path

Optimize the surfaces the user and agent touch most:

- search
- Home re-entry
- project digest and recent activity recall
- Governance feed and review re-entry
- compact context assembly

Do not spend the first pass on low-frequency background flows unless they are actively harming the hot path.

### 2. Measure before broad refactors

Prefer:

- render-count checks
- cheap timing instrumentation
- targeted profiling
- narrow before/after comparisons

Avoid large cleanup passes that do not prove user-visible benefit.

### 3. Reduce moving parts

If the same behavior can be preserved with fewer conditions, fewer inline selectors, or smaller state surfaces, that is usually a win.

### 4. Favor testable boundaries

When optimization requires code movement, prefer extracting helpers or hooks that make the behavior easier to test in isolation.

## Current pressure points

These are the most credible optimization targets based on shipped work so far.

### 1. Renderer shell size and state concentration

Current signal:

- `app/renderer/src/App.tsx` carries a large amount of route, retrieval, governance, Home, palette, and workspace coordination logic

Why it matters:

- changes become expensive to reason about
- small UI fixes carry broader regression risk
- memoization and render cost are harder to inspect when logic is too centralized

Goal:

- shrink the amount of derived logic living directly in `App.tsx`
- move reusable selectors and handlers into small helpers or hooks
- preserve behavior while lowering change risk

### 2. Governance and review recall render churn

Current signal:

- recent governance work added follow-up cards, filters, shortcuts, and review recall across multiple renderer surfaces

Why it matters:

- the functionality is useful, but the same feed-shaped data now influences several UI regions
- repeated derived filtering or mapping can quietly grow render cost and complexity

Goal:

- centralize feed-to-UI derivation where it is repeated
- keep only active-issue and recent-review calculations on the cheap path
- add narrow renderer tests around re-entry and filter persistence

### 3. Search and Home hot path discipline

Current signal:

- Home and command-palette flows are now stronger, which makes their latency and predictability more important

Why it matters:

- these are now primary re-entry surfaces
- they should stay fast even as more activity types and shortcuts accumulate

Goal:

- audit avoidable recomputation in Home and search result shaping
- keep search result formatting summary-first
- avoid broadening default result preparation into a cold-path workflow

### 4. Import cold-path complexity

Current signal:

- import preview and duplicate handling are valuable, but `app/server/workspace-import.ts` now carries a lot of logic

Why it matters:

- this is mostly a cold-path surface, but complexity here raises maintenance cost and can leak risk into import reliability

Goal:

- split dense import logic into smaller testable units
- keep preview and exact-duplicate behavior stable
- avoid turning import into a heavier migration engine

### 5. Test and observability noise

Current signal:

- test runs still emit readonly SQLite stderr noise during inferred-relation refresh paths
- some recent UI flows rely more on integration confidence than explicit interaction coverage

Why it matters:

- noisy test output erodes trust in CI
- missing interaction coverage makes optimization work riskier than it needs to be

Goal:

- reduce or intentionally suppress the known non-failing stderr path
- add renderer interaction coverage only where it protects hot-path behavior

## Recommended optimization order

### Batch O1 - Measure the hot path

Impact: high
Effort: low

Scope:

- define a short profiling checklist for Home, search, Governance feed, command palette, and compact context flows
- add lightweight measurement notes or instrumentation where the current code gives little visibility
- record baseline timing and render observations before deeper edits

Why first:

- this lowers the chance of optimizing the wrong thing

### Batch O2 - De-risk the renderer shell

Impact: high
Effort: medium

Scope:

- extract repeated derived selectors or helper logic from `App.tsx`
- isolate Home, Governance, and palette-specific derivation into smaller units
- preserve the current UI surface and behavior

Why second:

- it reduces the cost of every future fix and optimization

### Batch O3 - Tighten governance and recall rendering

Impact: medium-high
Effort: medium

Scope:

- remove repeated review-feed calculations
- make active-issue matching and recent-review derivation cheap and explicit
- add focused renderer coverage for filter persistence and review re-entry

Why third:

- these surfaces are now central to trust and continuity

### Batch O4 - Clean up import cold-path structure

Impact: medium
Effort: medium

Scope:

- split `workspace-import.ts` into smaller units without changing shipped behavior
- keep duplicate preview and normalization logic easy to test
- avoid new import features during this pass

Why fourth:

- this improves maintainability without pulling attention away from the hot path too early

### Batch O5 - Remove test noise and fill confidence gaps

Impact: medium
Effort: medium

Scope:

- investigate the readonly SQLite inferred-relation stderr path in tests
- decide whether to fix the root cause, gate the path in tests, or intentionally suppress the noise
- add only the highest-value renderer interaction tests that stabilize the optimized paths

Why fifth:

- it makes the repo calmer to work in once the highest-leverage code movement is done

## Stop rule for this optimization pass

This optimization pass is complete when:

- O1 through O3 are shipped or intentionally deferred
- one of O4 or O5 is also shipped
- the next meaningful improvement would require a new planning pass rather than more obvious cleanup

## Non-goals during feature freeze

- no new dashboard surfaces
- no new workflow engine
- no broader notification system
- no additional import formats
- no team or cloud collaboration layer
- no semantic or model-heavy work on the default hot path without fresh justification

## First recommended execution slice

Start with `Batch O1`.

Concrete first step:

1. document the profiling checklist
2. inspect `App.tsx` hot-path derivation for Home, command palette, and Governance feed
3. record the first bounded optimization queue before writing code

Supporting baseline document:

- [`docs/optimization-baseline.md`](./optimization-baseline.md)
