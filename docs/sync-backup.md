# RecallX — Backup & Sync Strategy

> Strategy reference for backup, restore, and future sync posture.
> This document mixes shipped backup/safety behavior with the intended operating stance for future sync work.
> For current product behavior, prefer `README.md` and the current app/runtime documentation.

## At A Glance

- RecallX should be easy to back up, restore, and move between machines.
- The recommended near-term model is backup-friendly local storage plus single-writer multi-device use.
- Cloud folders may be used as transport or backup locations, but they should not be described as real-time multi-writer sync.
- Safety, rebuildability, and local ownership matter more than early sync complexity.

## Current shipped behavior

RecallX already ships these backup and safety surfaces:

- workspace backup snapshots via the renderer Workspace page, local API, and CLI
- workspace export to `json` or `markdown`
- workspace restore into a chosen target root
- workspace session metadata and lock markers surfaced as workspace safety warnings

Representative CLI commands:

```bash
recallx workspace backups
recallx workspace backup --label "before-upgrade"
recallx workspace export --format json
recallx workspace restore --backup <id> --root /path/to/restore
```

These features support backup, restore, and sequential multi-device use. They do not change the product stance against promising concurrent multi-writer sync.

## 1. Purpose

This document defines how RecallX should think about:
- backup
- restore
- multi-device use
- cloud-folder workflows such as Google Drive, Dropbox, or iCloud Drive
- future synchronization possibilities

The goal is to support real-world multi-PC usage **without** violating the project’s core principles:
- local-first
- fast
- lightweight
- durable
- non-bloated

This document is intentionally conservative.
It prioritizes safety and simplicity over early real-time sync ambition.

---

## 2. Core position

### Short version
Yes, RecallX should support:
- reliable backup
- restore
- moving a workspace between machines
- practical multi-device use

But it should **not** begin with a heavy real-time sync system.

### Strategic position
The right progression is:

1. **backup-friendly local workspace**
2. **single-writer multi-device usage**
3. **careful app-level sync later only if truly needed**

This keeps the product aligned with its speed and anti-bloat goals.

---

## 3. Local-first principle applied to backup and sync

The workspace should remain fundamentally local.
That means:
- the canonical working copy lives on one machine at a time
- backup and transfer should be easy
- cloud storage can be used as a transport or backup layer
- cloud should not become the mandatory source of truth in v1

This is important because local-first trust is part of the product’s value.

---

## 4. Recommended data model for storage safety

To make backup and multi-device workflows safer, the system should distinguish between:

## 4.1 Canonical data
These are the files that matter most and should be preserved carefully.

### Examples
- `workspace.db`
- `artifacts/`
- export manifests
- essential workspace config

These represent the durable memory layer.

## 4.2 Rebuildable data
These are useful but not canonical.

### Examples
- `cache/`
- search indexes if rebuildable
- embeddings cache
- temporary bundle cache
- transient logs

These should be treated as disposable or rebuildable where possible.

### Why this distinction matters
A safe backup/sync strategy is much easier if:
- canonical data is small and well-defined
- caches do not need perfect cross-device consistency

This also reduces cloud-folder corruption or mismatch risk.

---

## 5. Workspace root strategy

The app should let the user choose the workspace root.

### Good examples
- local folder on internal disk
- Dropbox folder
- Google Drive folder
- iCloud Drive folder
- external SSD

### Why this matters
Users should not be forced into one storage location.
The product should stay flexible.

### Important note
Allowing a cloud-synced folder is **not the same as promising real-time multi-writer sync**.
That distinction should be explicit in product language.

---

## 6. Backup strategy for v1

The first release should strongly support backup before trying to support true sync.

## 6.1 Recommended backup capabilities
### A. Manual snapshot
The user can create a point-in-time backup of the workspace.

### B. Automatic snapshot on important events
Examples:
- before migrations
- before restore/import operations
- before major schema upgrades

### C. Export
The user can export:
- markdown
- JSON
- backup archive bundle

### D. Restore
The user can restore from:
- snapshot
- export package
- previous workspace copy

### Why this should come first
Backup is simpler, safer, and already valuable.
It also reduces fear when experimenting across devices.

---

## 7. Multi-device usage model for early versions

The most practical early model is:

## Single-writer, multi-device use
Meaning:
- the workspace may be opened from multiple machines over time
- but only **one machine should actively write to it at a time**

### Typical safe workflow
1. User works on machine A
2. User closes the app
3. Cloud folder finishes syncing
4. User opens the same workspace on machine B

This is very different from:
- real-time collaborative editing
- concurrent writes from multiple active machines

### Recommendation
This should be the official early multi-device model.

---

## 8. Google Drive / Dropbox / iCloud Drive support

## 8.1 Is it structurally possible?
Yes.
The structure can support cloud-folder-based workspace storage.

## 8.2 Is it safe by default?
Only if the product is explicit about constraints.

### Safe-ish usage
- one active device at a time
- app closed before switching devices
- sync allowed to complete between sessions
- backups available

### Risky usage
- two devices open at once
- background sync while both are writing
- stale cache/state copied across devices
- assuming SQLite file sync equals robust multi-writer sync

## 8.3 Important product stance
The app may support cloud-folder workflows, but should clearly label them as:
- **backup / transfer / single-writer multi-device support**
not
- **real-time concurrent sync**

---

## 9. Why SQLite file sync is not enough for true sync

A synced SQLite file can work as a transport mechanism for a single active writer.
But it is not a full synchronization system.

### Risks
- file locking differences across platforms
- partial sync timing issues
- one machine writing while another opens stale state
- artifacts synced differently from DB updates
- cache and canonical data drifting apart

### Conclusion
A synced workspace folder is acceptable for:
- backup
- transfer
- sequential multi-device use

It is not sufficient to claim:
- safe multi-writer sync
- conflict-free collaborative behavior

---

## 10. App behaviors recommended for safety

Even without building a heavy sync engine, the app can do several things to make cloud-folder workflows safer.

## 10.1 Workspace lock indicator
When the app opens a workspace, it can create a local/session lock marker.

### Goal
Warn the user that another device or session may still be using the workspace.

### Important note
This is not perfect sync conflict prevention, but it helps reduce accidental dual-open behavior.

## 10.2 Last-opened metadata
Track:
- machine identifier
- app version
- last opened timestamp
- last clean close timestamp

### Goal
Warn if the workspace may not have been cleanly closed or may have been opened elsewhere recently.

## 10.3 Cache segregation
Cache should be either:
- local to the machine
or
- clearly rebuildable

Do not make cross-device correctness depend on synced cache integrity.

## 10.4 Startup safety checks
On workspace open, the app may check:
- lock marker presence
- stale session marker
- app/schema mismatch
- suspicious sync state indicators

## 10.5 Read-only fallback
If the workspace looks unsafe, the app could offer:
- warning
- read-only open
- restore/repair suggestion

This could be valuable later, but should not become a huge system in v1.

---

## 11. Recommended workspace layout for sync friendliness

The storage layout should help separate durable state from transient state.

## Suggested layout
```text
<workspace-root>/
  workspace.db
  artifacts/
  exports/
  backups/
  config/
  cache/
```

## Recommendation
Treat these as follows:

### Sync-worthy / important
- `workspace.db`
- `artifacts/`
- `exports/`
- `backups/`
- essential config

### Rebuildable / less important
- `cache/`

### Design goal
The workspace should remain usable even if cache is missing or stale.

---

## 12. Recommended product language

To avoid misleading users, the product should use careful wording.

## Good wording
- local-first workspace
- backup-friendly
- portable workspace
- supports multi-device use with one active writer at a time
- compatible with cloud-folder workflows like Google Drive or Dropbox

## Wording to avoid early
- real-time sync
- seamless concurrent multi-device editing
- conflict-free distributed workspace

Unless the product actually implements those behaviors later.

---

## 13. Suggested v1 feature set for backup/sync

The first release does **not** need full sync.
It should include:

### Required
- choose workspace root
- manual backup snapshot
- pre-migration snapshot
- export workspace to portable format
- import/restore flow
- clear backup/restore UI

### Strongly recommended
- last-opened metadata
- simple lock marker
- warning when workspace looks potentially active elsewhere
- cache treated as rebuildable

### Not required in v1
- real-time sync engine
- conflict resolution UI
- multi-writer merge logic
- remote relay service
- collaboration features

---

## 14. Long-term sync direction (only if needed)

If the product later needs stronger sync, it should probably move away from “sync the DB file directly” and toward **app-level sync**.

## Better long-term model
Sync should operate on structured changes such as:
- node creation/update
- relation creation/update
- activity append
- artifact reference changes
- review decisions

That means the system would sync:
- durable events or records
not just
- raw database file state

### Why that is better
It enables:
- better conflict handling
- better auditability
- less corruption risk
- finer-grained cross-device behavior

### Why it should be deferred
It adds significant complexity and could easily violate the project’s anti-bloat goals if introduced too early.

---

## 15. Recommended product decision for now

The best current decision is:

### Official v1 position
RecallX supports:
- strong local backups
- export and restore
- portable workspaces
- cloud-folder workflows for sequential multi-device use

It does **not** promise:
- real-time concurrent sync
- multi-writer editing
- collaborative merge semantics

### Why this is the right trade-off
It gives users practical value now while preserving:
- speed
- simplicity
- local-first trust
- manageable implementation scope

---

## 16. Reviewer questions for this topic

If this design is externally reviewed, useful questions include:

- Is single-writer multi-device support the right early posture?
- Is the canonical-vs-cache split strong enough?
- What minimum safety checks should exist before opening a cloud-folder-backed workspace?
- Should read-only fallback be included early or deferred?
- Is the export/backup model strong enough before app-level sync exists?

---

## 17. Summary

RecallX should absolutely support backup and practical multi-device use.

But the right early approach is not heavy sync.
It is:
- local-first canonical storage
- safe backup and restore
- portable workspace roots
- cloud-folder compatibility for sequential usage
- caution around concurrent access

That approach fits the product far better than prematurely building a large synchronization system.
