# Memforge - Desktop Background + Menu Bar Plan

## 1. Goal

Let Memforge behave like a local memory utility instead of only a foreground windowed app.

The packaged desktop app should be able to:

- keep the local Memforge API alive in the background
- remain discoverable from the macOS menu bar
- expose basic health and integration status without opening the full window
- provide a few high-value quick actions

This should feel like:

- a calm local utility
- an always-available memory service
- a trustworthy status surface

It should not become:

- a noisy sync client
- a heavy background worker
- a second full UI crammed into a tray menu

## 2. Product stance

Memforge background mode is primarily a **local service shell**.

The menu bar item is not a second app. Its job is:

- tell the user whether Memforge is alive
- provide fast access to the main app
- provide a few operational controls
- make MCP and API access easy to confirm

The full renderer window remains the main place for retrieval, review, and editing.

## 3. Recommended behavior

## 3.1 App lifecycle

Default packaged behavior on macOS:

- launching the app starts or reuses the managed local API
- closing the main window hides the window and keeps Memforge running
- the app remains available from the menu bar
- explicit `Quit Memforge` stops the managed API and exits the app

Recommended supporting behaviors:

- use a single-instance lock so a second launch focuses the existing app
- reopen the main window from the menu bar or dock/app activation
- optional `Launch at Login` setting

## 3.2 Dock vs menu bar

Recommended v1 default:

- keep the dock icon visible while the main window is open
- allow background operation after window close
- always expose the menu bar item

Reason:

- easier to understand than a menu-bar-only app
- lower surprise for first-time users
- simpler failure recovery

Possible later option:

- `Menu bar only` mode that hides the dock icon except when a window is shown

## 4. Menu bar status model

The menu bar icon should reflect only the **desktop-managed Memforge service** for the current packaged app session.

Recommended states:

- `Healthy`
  - local API reachable
  - workspace mounted
  - tray icon neutral or active
- `Starting`
  - desktop shell launched
  - waiting for API health
  - tray icon subdued / spinner if available
- `Degraded`
  - API alive but workspace mismatch, restart pending, or last health check stale
  - tray icon warning accent
- `Failed`
  - managed API could not start or died unexpectedly
  - tray icon error accent

Status details to expose:

- current API address and port
- current workspace name
- current workspace root
- auth mode
- last successful health check time
- whether MCP launcher artifacts are present

Do not expose in v1:

- per-client MCP session counts
- heavy telemetry
- noisy live logs in the menu itself

## 5. Menu bar menu contents

Recommended top-level menu:

1. Status header
- `Memforge is healthy`
- `127.0.0.1:8788`
- `Workspace: Memforge`

2. Open surfaces
- `Open Memforge`
- `Quick Capture`
- `Open Settings`

3. Service controls
- `Restart Local Service`
- `Stop Local Service`
- `Start Local Service` when stopped

4. Integration info
- `Copy API URL`
- `Copy MCP Command`
- `Copy MCP Launcher Path`
- `Reveal Workspace Folder`

5. Lightweight status
- `Server Status...`
- `Workspace Status...`

6. Preferences
- `Launch at Login`
- `Keep running in background`
- `Show dock icon when closed`

7. Exit
- `Quit Memforge`

## 6. Quick actions

## 6.1 Quick Capture

Highest-value tray action.

Recommended behavior:

- opens a tiny focused capture window or lightweight sheet
- title + body only in v1
- writes directly into the current workspace as a note

Why this matters:

- it proves the value of background mode immediately
- it makes Memforge useful even when the full app is closed

## 6.2 Open Memforge

Always present.

Behavior:

- shows existing window if one exists
- creates a new main window if all windows are closed
- focuses the app

## 6.3 Restart Local Service

Important operational recovery action.

Behavior:

- restarts only the desktop-managed API
- preserves current workspace target
- refreshes menu state afterward

## 7. Server status surface

The menu item itself should stay minimal, but a small secondary surface can expose details.

Recommended v1 server status content:

- `Running` / `Starting` / `Stopped` / `Failed`
- bind address
- port
- workspace name
- workspace root
- auth mode
- API health URL
- MCP command
- last start time

This can be:

- a submenu in v1
- a small popover later if needed

## 8. Settings to add

Desktop settings that matter:

- `desktop.keepRunningInBackground`
- `desktop.launchAtLogin`
- `desktop.showDockIconWhenClosed`
- `desktop.menuBarEnabled`

Optional later:

- `desktop.quickCaptureShortcut`
- `desktop.showNotificationsForReviewQueue`
- `desktop.autoRestartService`

## 9. Implementation plan

## Phase 1 - Core background shell

Ship the minimum useful background utility:

- add single-instance lock
- add Electron `Tray`
- add menu bar icon asset
- keep app alive after window close
- add `Open Memforge`, `Restart Local Service`, `Copy API URL`, `Quit`
- add main-process health polling for the managed API
- expose current desktop-managed workspace and API state to the tray menu

Success criteria:

- user can close the window and still see Memforge alive in the menu bar
- user can reopen the app from the menu bar
- user can confirm the current API and workspace without reopening the full app

## Phase 2 - Useful quick actions

- add `Quick Capture`
- add `Copy MCP Command`
- add `Copy MCP Launcher Path`
- add `Reveal Workspace Folder`
- add `Launch at Login`

Success criteria:

- menu bar becomes useful for daily lightweight interactions
- MCP setup becomes checkable without opening the full window

## Phase 3 - Richer status and polish

- add clearer status icon states
- add service error recovery messaging
- add `Stop Local Service` and explicit `Start Local Service`
- add optional review queue count or stale-status hints

Success criteria:

- menu bar acts as a trustworthy operational surface
- service failures are legible and recoverable

## 10. Technical notes for this codebase

Current desktop shell facts:

- the Electron main process already manages a child API process
- the packaged app already resolves a dedicated workspace root under `~/.memforge/{workspaceName}`
- the packaged app already avoids reusing an API whose workspace root points somewhere else

That means the best ownership split is:

- main process owns tray state
- main process owns managed API health state
- renderer remains the full UI only

Important rule:

The tray should reflect the **desktop-managed** API, not any random Memforge API found on loopback.

## 11. Risks and guardrails

Main risks:

- users may think window close means full quit
- tray state can drift from actual API state if health checks are weak
- background mode can accidentally encourage too many always-on jobs

Guardrails:

- keep health model explicit and simple
- keep tray actions small and operational
- do not add heavy background indexing or semantic work just because the app stays alive
- keep background mode focused on serving, capture, and access

## 12. Recommended first implementation scope

If we start now, the best first cut is:

- close-to-hide behavior
- menu bar icon
- `Open Memforge`
- `Quick Capture`
- `Server: Healthy/Starting/Failed`
- `Workspace: <name>`
- `Copy API URL`
- `Copy MCP Command`
- `Restart Local Service`
- `Quit Memforge`

That is enough to make Memforge feel like a real local utility without overbuilding the tray surface.
