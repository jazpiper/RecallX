# Memforge — Promotion Rules (v2)

## Purpose
Define the append-first path from activity to durable memory under fully automatic governance.

## Default landing rules

| Source Type | Output Form | Default Landing Stage | Governance |
| --- | --- | --- | --- |
| Human | any node | `canonical active` | immediate |
| Agent append | activity | activity | timeline only |
| Agent summary | short, log-like | activity | timeline only |
| Agent work update | implementation summary or completed task note | activity | preferred default |
| Agent note | long, non-reusable | `appended active` | auto-evaluated |
| Agent durable note | reusable or durable metadata | `suggested active` | auto-promote or contest |
| Agent decision | decision node | `suggested active` | auto-promote or contest |
| Import | node | `imported active` | auto-evaluated |

## Core principles

- Finished-work summaries should usually be stored as activities, not durable notes.
- The capture path should prefer activities for short log-like agent updates and only create durable nodes when the content is reusable, decision-shaped, or explicitly requested as a node.
- Low-risk agent-authored notes should default to `appended active`, not `canonical`.
- Reusable or durable agent-authored knowledge should start as `suggested active`.
- Decision nodes are allowed for agents, but they start as `suggested active` and rely on automatic confidence promotion.
- `canonical` is a durable landing stage, not proof of human approval.
- `contested` is a node status, not a canonicality level.
- Search feedback, contradiction signals, relation usage, and stability are the primary local confidence inputs.

## Automatic governance rules

- Human-authored nodes still land `canonical active` by default.
- Suggested nodes can auto-promote to `canonical` once deterministic confidence crosses the type-specific threshold.
- Strong contradiction or repeated negative usefulness feedback can move `active` or `canonical` content to `contested`.
- Suggested relations stay `suggested` until automatic governance promotes them to `active` or demotes them.
- Long durable activities may auto-create suggested promotion candidates, which then flow through the same governance engine.

## Retrieval implications

- `search_nodes` is durable-memory search only.
- `search_activities` is operational-log search only.
- `search_workspace` merges both, but contested items rank below healthy peers.
- Governance events are audit history, not hot-path retrieval content.
