# GUI → Terminal Gap Analysis (March 25, 2026)

## Scope
This review compares GUI-only capabilities in `WorldBuilder` with currently exposed terminal commands in `WorldBuilder.Terminal`.

Primary evidence:
- GUI editor surfaces and registration in `MainViewModel` + project DI.
- REPL command surface in `docs/terminal_repl_commands.md` and `TerminalRepl` switch dispatch.

## Executive summary
The terminal is very strong for terrain/object/dungeon automation, but several high-value GUI workflows are still unavailable headlessly:

1. **Data-table editors (Spell, Skill, Vital, Experience, SpellSet, CharGen, Layout).**
2. **Terrain layer CRUD and ordering controls** (terminal currently only exposes read-only terrain-layer query).
3. **Edit-session ergonomics that are automation-friendly** (undo/redo transaction controls, snapshots/history, camera/bookmark navigation hooks).

## Confirmed GUI capabilities without terminal parity

### 1) GUI has dedicated non-terrain editors; terminal has no command families for them
GUI can switch into all of these editors:
- Spell
- SpellSet
- Skill
- Experience
- Vital
- CharGen
- Layout

These editors are all registered as project services and exposed as selectable active editors in the GUI.

In contrast, the terminal command catalog has no `spell ...`, `skill ...`, `vital ...`, `experience ...`, `chargen ...`, or `layout ...` command families.

**Implication:** Agent/headless workflows cannot perform the same table-editing operations now available to GUI users.

### 2) Terrain layer management is editable in GUI, read-only in terminal
GUI layer tooling supports:
- creating new layers/groups,
- renaming,
- deleting,
- toggling visibility,
- toggling export,
- reordering/moving layers.

Terminal currently exposes only:
- `get-terrain-layers <lbX> <lbY>`

**Implication:** terminal can inspect layer state, but cannot manipulate the layer graph or export flags that impact composition/export behavior.

### 3) GUI object/session UX has command-worthy operations absent from terminal
GUI landscape editor includes command-backed actions for:
- `Undo` / `Redo`,
- object copy/paste duplication,
- delete selected object(s),
- go-to landblock/cell camera navigation,
- camera bookmarks (add, go to, rename, reorder, delete),
- history snapshots (create, revert, rename, delete).

Terminal currently does not expose command counterparts for these session controls.

**Implication:** terminal can mutate state but cannot manage revision checkpoints with the same ergonomics available in GUI.

## Suggested terminal command additions (prioritized)

### P1 — Data editor parity families
- `spell list|get|add|update|delete`
- `skill list|get|add|update|delete`
- `vital get|set`
- `experience get|set|autoscale`
- `spellset list|get|add|update|delete|add-tier|remove-tier`
- `chargen list-heritages|add-heritage|update-heritage|remove-heritage|list-start-areas|add-start-area|remove-start-area`
- `layout list|get` (read-only is still useful for agents)

### P1 — Terrain layer mutation
- `layer list [--tree]`
- `layer add <name> [--parent <id>]`
- `layer add-group <name> [--parent <id>]`
- `layer rename <id> <name>`
- `layer move <id> <parentId|terrain> <index>`
- `layer set-visible <id> <true|false>`
- `layer set-export <id> <true|false>`
- `layer delete <id>`

### P2 — Session/history controls
- `history undo [n]`
- `history redo [n]`
- `snapshot create [name]`
- `snapshot list`
- `snapshot restore <id>`
- `snapshot rename <id> <name>`
- `snapshot delete <id>`

### P3 — Navigation/bookmarks (nice-to-have for human REPL users)
- `bookmark add [name]`
- `bookmark list`
- `bookmark goto <id|name>`
- `bookmark rename <id> <name>`
- `bookmark remove <id>`

## Implementation note
Most of these gaps are command-surface gaps rather than core-logic gaps: the GUI already demonstrates working behaviors. The fastest route is typically:
1. Extract/centralize shared operations (where still UI-coupled),
2. Expose through `CommandEngine`,
3. Add REPL + JSON protocol bindings.
