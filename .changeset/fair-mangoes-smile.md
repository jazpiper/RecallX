---
"recallx": patch
---

Tighten npm runtime and MCP release readiness by aligning the supported Node version with `node:sqlite`, preferring `RECALLX_API_TOKEN` in the CLI while keeping the legacy token alias, removing stale renderer version fallbacks, and making the installed MCP launcher resolve `node` from `PATH`.
