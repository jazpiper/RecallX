# Memforge — Promotion Rules (v1)

## Purpose
Define a strict pipeline from activity → suggested → review queue decision → canonical to prevent workspace noise.

## Promotion Rules Table (v1 fixed)

| Source Type       | Output Form            | Default Landing Stage | Requires Review | Notes |
|-------------------|------------------------|-----------------------|-----------------|-------|
| Human             | Any node               | canonical             | No              | Immediate |
| Agent append      | activity               | activity              | No              | Log only |
| Agent summary     | ≤300 tokens and log-like | activity            | No              | Default case |
| Agent note        | >300 tokens and not marked durable | appended active node | No | Low-risk append-only default |
| Agent summary     | >300 tokens and reusable | suggested note      | Yes             | Must review |
| Agent decision    | decision node          | suggested             | Yes (always)    | Never auto-promote |
| Import            | node                   | imported              | No              | - |
| Claude Code / Codex | run summary          | activity              | No              | - |
| Claude Code / Codex | technical decision   | suggested note        | Yes             | - |
| Gemini CLI        | research summary       | suggested reference   | Yes             | - |
| OpenClaw          | session summary        | activity              | Sometimes       | Promote only if durable or high-impact |

## Core principles
- Decision nodes require human approval only  
- Low-risk agent-authored notes should default to active `appended` nodes, not review  
- Any agent output >300 tokens that contains reusable durable knowledge must become a suggested note, never raw activity body  
- `reviewed` is a governance event captured by the review queue, not a separate node enum or canonicality value  
- Items in review queue should be handled within 7 days when possible  
- Only canonical nodes are included in hot-path retrieval by default

This table has no exceptions in v1.
