# SQLite-Vec Semantic Sidecar v1

This document defines the current local-first semantic retrieval design for Memforge.

## Goals

- keep `SQLite = canonical truth`
- keep semantic indexing optional and rebuildable
- prefer `sqlite-vec` for bounded vector math when available
- automatically fall back to the existing `sqlite` + app-side cosine path when the extension cannot be loaded
- require no external vector database for desktop or npm distribution

## Component roles

### SQLite

- stores canonical nodes, relations, activities, provenance, and settings
- stores the rebuildable semantic ledger tables:
  - `node_index_state`
  - `node_chunks`
  - `node_embeddings`

### Embedding provider

- turns text into vectors
- is still configured by `search.semantic.provider` and `search.semantic.model`
- defaults to the built-in `local-ngram` / `chargram-v1` validation path for local development
- the shipped built-in provider is currently embedding version `2` and uses a 384-dimensional local n-gram vector

### sqlite-vec

- is a local SQLite extension loaded at database-open time
- runs bounded vector distance math inside the same SQLite process
- is not a second source of truth and does not replace canonical storage

## Indexing lifecycle

Semantic indexing stays background-maintained:

1. Node writes mark `node_index_state` as `pending` or `stale`.
2. The worker reads pending rows and rebuilds semantic chunks.
3. The configured embedding provider generates vectors.
4. Ledger rows are written into `node_embeddings.vector_blob`.
5. If `sqlite-vec` is loaded, bounded semantic search uses SQLite extension functions.
6. If `sqlite-vec` is unavailable, the same ledger is still searched through the legacy app-side cosine path.

Compatibility rules:

- semantic lookup requires `embedding_provider`, `embedding_model`, and `embedding_version` to all match
- changing semantic configuration or upgrading the built-in provider version can mark prior ready rows as `stale`
- affected active/draft nodes are automatically requeued so old vectors are rebuilt instead of being silently mixed with new query embeddings

State transitions stay:

- `pending`
- `processing`
- `ready`
- `failed`

## Retrieval flow

- deterministic retrieval remains first
- semantic augmentation only runs when lexical signals are weak enough to justify it
- `searchWorkspace()` stays deterministic-only in the hot path
- `context bundle` and `retrieval/rank-candidates` are the semantic bonus surfaces
- semantic search is bounded to the provided candidate set, not a global full-corpus recall pass
- strong exact lexical candidate matches still short-circuit semantic bonus application

## Runtime behavior

Workspace setting:

- `search.semantic.indexBackend = sqlite-vec | sqlite`

Status fields:

- `configuredIndexBackend` reflects the saved workspace setting
- `indexBackend` reflects the active runtime backend
- `extensionStatus`
  - `loaded` when `sqlite-vec` is active
  - `fallback` when `sqlite-vec` was requested but Memforge downgraded to `sqlite`
  - `disabled` when the workspace explicitly uses plain `sqlite`
- `extensionLoadError` exposes the startup load failure message when fallback is active
- `embedding_version` is part of the stored semantic ledger and is used for compatibility filtering

## Local development

Install dependencies normally:

```bash
npm install
```

`sqlite-vec` ships platform-specific optional packages for supported environments. On macOS and Linux, Memforge attempts to load the extension automatically at startup.

No separate database process is required.

## Failure handling

- extension load failure does not block startup
- canonical writes continue even when semantic indexing is degraded
- semantic ranking automatically falls back to the plain `sqlite` path
- workers continue storing rebuildable vectors locally in `node_embeddings`
