---
"recallx": patch
---

Suppress expected readonly SQLite auto-refresh noise in tests by recognizing readonly write errors and skipping stderr logs for that known case.
