# RecallX UI Redesign Wireframes

## 1. Purpose

This document converts the redesign plan into low-fidelity layout wireframes.
It is intentionally structural, not decorative.

Design lock:

- Figma direction
- Minimalism
- Micro-interactions
- Flat Design baseline

Do not use this document to justify:

- oversized headers
- long explanatory copy
- decorative empty space
- ornamental depth

## 2. Global shell

Desktop shell:

```text
+---------------------------------------------------------------+
| Left Sidebar | Top Command Row                               |
|              +-----------------------------------------------+
|              | Center Canvas                  | Right Rail   |
|              |                                |              |
|              |                                |              |
|              |                                |              |
+---------------------------------------------------------------+
```

Left sidebar modules:

```text
+----------------------+
| Brand                |
| Workspace switcher   |
| Main nav             |
| Active project       |
| Quick capture        |
| Secondary utilities  |
+----------------------+
```

Top command row:

```text
+---------------------------------------------------------------+
| Page title | status chips | search | cmd+k | primary action  |
+---------------------------------------------------------------+
```

Right rail:

```text
+----------------------+
| Selection summary    |
| Actions              |
| Provenance / trust   |
| Related context      |
| Recent activity      |
| Artifacts            |
+----------------------+
```

Global shell rules:

- sidebar-first, not topbar-first
- right rail is stable across pages
- page title stays compact
- top row must not become a second navigation bar

## 3. Home

Goal:

- re-entry
- orientation
- next action

Desktop wireframe:

```text
+-----------------------------------------------------------------------+
| Top Row: Home | workspace status | search | cmd+k                     |
+-----------------------------------------------------------------------+
| Search Panel                                          | Right Rail    |
| [global search input...............................]  | project        |
| [scope chips] [recent count] [review count]          | summary        |
+-------------------------------------------------------+---------------+
| Pulse Strip                                                          |
| [projects] [recent] [review] [integrations] [workspace safety]      |
+-------------------------------------------+---------------------------+
| Continue Panel                            | Active Project Panel      |
| recent nodes                              | selected project          |
| recent flows                              | recent activity           |
| next actions                              | jump actions              |
+-------------------------------------------+---------------------------+
| Recent Movement Panel                     | Review Signals Panel      |
| mixed node/activity stream                | contested / low conf      |
| compact rows                              | quick jump to Review      |
+-------------------------------------------+---------------------------+
```

Micro-interactions:

- subtle focus ring on search
- quick hover state on recent rows
- pulse strip numbers animate only on load or state change
- no decorative page-load hero animation

Header rule:

- short title only
- no hero slogan

## 4. Memory

Goal:

- browse
- read
- capture

Desktop wireframe:

```text
+-----------------------------------------------------------------------+
| Top Row: Memory | filters | search | cmd+k | new                      |
+-----------------------------------------------------------------------+
| Filter Rail   | Memory List                       | Right Rail        |
| type          | [row] type title meta            | related nodes     |
| source        | [row] type title meta            | bundle preview    |
| project       | [row] type title meta            | recent activity   |
| status        | [row] type title meta            | artifacts         |
+---------------+-----------------------------------+-------------------+
| Detail Pane                                                           |
| title / type / status                                                 |
| main body                                                             |
| metadata                                                              |
| actions                                                               |
+-----------------------------------------------------------------------+
| Quick Capture Bar                                                     |
| type | project | title | submit                                       |
+-----------------------------------------------------------------------+
```

Micro-interactions:

- selected row highlights with restrained blue
- detail pane updates with fast crossfade or slide
- quick capture submit gives compact success state
- filter chips animate selection only lightly

Copy rule:

- no intro paragraph above the list
- one-line summaries in list rows

## 5. Graph

Goal:

- inspect neighborhoods
- inspect project-scoped structure

Desktop wireframe:

```text
+-----------------------------------------------------------------------+
| Top Row: Graph | mode tabs | filters | cmd+k                          |
+-----------------------------------------------------------------------+
| Graph Toolbar                                                         |
| [Neighborhood / Project map] [focus selector] [relation filters]     |
+-------------------------------------------------------+---------------+
| Main Graph Canvas                                     | Right Rail    |
|                                                       | selected node |
|                                                       | relation meta |
|                                                       | trust state   |
|                                                       | jump actions  |
+-------------------------------------------------------+---------------+
| Legend / Structural Summary                                            |
| [legend] [density] [source breakdown]                                 |
+-----------------------------------------------------------------------+
```

Micro-interactions:

- hovered node gets a clean focus cue
- selected node centers smoothly but quickly
- filter changes do not animate excessively

Copy rule:

- label-driven controls only
- no descriptive block around legend

## 6. Review

Goal:

- triage trust-sensitive items
- decide quickly

Desktop wireframe:

```text
+-----------------------------------------------------------------------+
| Top Row: Review | state filter | entity filter | cmd+k                |
+-----------------------------------------------------------------------+
| Filter Panel | Issue Queue                    | Right Rail            |
| state        | [row] title state confidence   | actions               |
| entity       | [row] title state confidence   | provenance            |
| sort         | [row] title state confidence   | linked context        |
+--------------+--------------------------------+-----------------------+
| Issue Detail                                                         |
| selected issue summary                                               |
| surfaced reason                                                      |
| evidence / related node or relation                                  |
| recent decisions                                                     |
+-----------------------------------------------------------------------+
```

Micro-interactions:

- queue row hover and select
- decision buttons show immediate compact result state
- expanded rationale reveals inline, not in a new page

Copy rule:

- queue reasons: one line
- detail rationale: short bullets or compact lines

## 7. Workspace

Goal:

- operate the workspace safely
- create, open, import, backup, connect

Desktop wireframe:

```text
+-----------------------------------------------------------------------+
| Top Row: Workspace | status chips | cmd+k                             |
+-----------------------------------------------------------------------+
| Status Panel                                                          |
| workspace name | bind | auth | safety                                 |
+-------------------------------------------+---------------------------+
| Switcher / Create Panel                   | Recent Workspaces         |
| create workspace                          | recent items              |
| open workspace                            | quick resume              |
+-------------------------------------------+---------------------------+
| Safety / Backup Panel                     | Import Panel              |
| warnings                                  | preview                   |
| backup / restore                          | import actions            |
+-------------------------------------------+---------------------------+
| Integrations / API Access Panel                                       |
| MCP, HTTP API, guide, local paths                                      |
+-----------------------------------------------------------------------+
```

Micro-interactions:

- action buttons provide compact progress feedback
- risky actions use restrained warning color
- disclosure panels expand inline

Copy rule:

- short operational labels
- guide content collapsed by default

## 8. Responsive adaptation

Tablet:

```text
+--------------------------------------------------+
| Sidebar or nav drawer                            |
+--------------------------------------------------+
| Top Row                                          |
+--------------------------------------------------+
| Center Canvas                                    |
+--------------------------------------------------+
| Right Rail becomes lower detail stack            |
+--------------------------------------------------+
```

Mobile:

```text
+------------------------------------+
| Compact top row                    |
+------------------------------------+
| Center canvas                      |
|                                    |
+------------------------------------+
| Bottom sheet inspector / actions   |
+------------------------------------+
```

Responsive rules:

- reduce module count before increasing text
- keep one primary action visible in first viewport
- never scale titles up to compensate for lost space

## 9. Micro-interaction policy

Allowed:

- hover feedback
- selected-state transitions
- inline expand/collapse
- subtle progress feedback
- focused-node transitions in graph

Avoid:

- floating decorative motion
- delayed reveals that slow operation
- oversized motion on page load
- any motion that requires extra copy to explain itself
