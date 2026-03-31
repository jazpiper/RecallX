# RecallX - Optimization Baseline

## Purpose

This document defines the first-pass measurement baseline for the feature-freeze optimization phase.

It exists to keep optimization work grounded in:

- visible user flows
- specific code surfaces
- narrow before/after comparisons

This is not a full performance lab.
It is a lightweight checklist for deciding whether a change improved the product in a meaningful way.

## Measurement rules

- measure hot-path behavior before broad refactors
- prefer the same workspace fixture and same user flow when comparing before and after
- treat renderer render churn, interaction latency, and repeated derived work as first-class concerns
- record only a small number of signals that are easy to repeat

## First-pass hot path checklist

### 1. Home re-entry

Check:

- initial Home render after app load
- switching back to Home from Governance, Notes, and Graph
- rendering of recent decisions, recent notes, and project digest slices

Watch for:

- repeated feed slicing or mapping
- avoidable recomputation when only view state changes
- slow follow-up card updates after governance state changes

Primary code surfaces:

- `app/renderer/src/App.tsx`

### 2. Search panel

Check:

- query change with 0, small, and medium result sets
- switching scope, source, node-type, and activity filters
- reopening a previously used search

Watch for:

- repeated result filtering work
- unnecessary rebuilding of node maps or option lists
- summary formatting work that grows with unrelated state changes

Primary code surfaces:

- `app/renderer/src/App.tsx`
- `app/renderer/src/lib/searchResults.ts`

### 3. Command palette

Check:

- open latency with no query
- query filtering with recent commands, recent nodes, and review shortcuts
- palette reopen after recent search and governance activity updates

Watch for:

- expensive route command rebuilding
- repeated label and hint normalization
- palette derivation depending on wider renderer state than needed

Primary code surfaces:

- `app/renderer/src/App.tsx`

### 4. Governance feed and review recall

Check:

- Governance view open with default filters
- filter changes for entity and action
- Home follow-up card refresh after a governance action
- reopening the latest still-open issue from Home or command palette

Watch for:

- repeated feed-to-card shaping across multiple UI surfaces
- active-issue matching that scans more often than necessary
- duplicated derivation logic between Home, Governance, and palette views

Primary code surfaces:

- `app/renderer/src/App.tsx`
- `app/renderer/src/lib/governance.ts`

### 5. Import preview cold path

Check:

- preview load for markdown import
- preview load for RecallX JSON import
- switching normalization and duplicate modes before running the real import

Watch for:

- overly dense logic that makes changes risky
- hard-to-test preview or duplicate code paths
- cold-path complexity spilling into renderer coordination logic

Primary code surfaces:

- `app/server/workspace-import.ts`

## Current baseline hypotheses

These are the most likely first optimization wins based on code inspection.

### H1. `App.tsx` is doing too much hot-path derivation inline

Likely impact:

- Home, search, command palette, and Governance each depend on nearby memo chains inside one large file
- small state changes can force broader re-evaluation than necessary

Measure first:

- how often search, Home, and command-palette derivations recompute during normal filter and view changes

### H2. Governance review recall now exists in enough places to justify shared derivation helpers

Likely impact:

- the same feed-shaped data now drives Home cards, Governance detail re-entry, and command-palette shortcuts

Measure first:

- whether repeated active-issue matching and recent-review shaping are happening across surfaces rather than once

### H3. Search result shaping is compact but still centralized

Likely impact:

- filtering, option construction, node-map construction, and recent-selectable node derivation all sit close together in the main renderer shell

Measure first:

- whether node map and filter derivations recompute during palette-only and view-only changes

### H4. Import reliability risk is now more about structure than raw speed

Likely impact:

- import preview is not the hot path, but dense control flow in `workspace-import.ts` raises maintenance cost

Measure first:

- code-size and test-surface pressure rather than raw latency

### H5. CI trust is being taxed by known stderr noise

Likely impact:

- green tests still look noisy because inferred-relation refresh writes hit readonly databases in some test paths

Measure first:

- whether the noise comes from a path that should be disabled in readonly test setups or from a real repository-level expectation mismatch

## Baseline capture template

Use this template before and after an optimization batch:

1. target flow
2. files touched
3. what was measured
4. before signal
5. after signal
6. residual risk

Keep the write-up short.
If the optimization has no visible signal, prefer not to do it.
