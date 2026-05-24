# Finding — retail ActionMap doesn't contain keystroke bindings

**Date:** 2026-05-24
**Context:** Investigating whether the retail `__acKeybindings`
`inputMap` field encodes a keystroke we could decode for the
Controls-tab "default key" column.

## TL;DR

It doesn't. The retail `ActionMap` DAT (`0x26000000`, 12,303 bytes)
is a two-level dictionary that catalogues **action categories** and
the **actions in each**, but carries no keystroke information.
Retail's actual key defaults are hardcoded in `acclient.c`'s
startup `BindAction()` calls and would need a separate RE pass to
extract.

## What's actually in the DAT

Per the dump at `/mnt/wbterminal1/tmp/claude-scratch/actionmap/`
(produced by `apps/holtburger-tools/examples/action_map_dump.rs`),
the outer-dict key (which our wasm exposes as `input_map`) is one
of ~27 small integers — the input-map **category index**:

| inputMap | Category |
|---|---|
| `0x00000004` | Movement (Move Forward / Strafe / Jump / Toggle Run/Walk / ...) |
| `0x00000005` | Camera (Rotate / Zoom / Map View / First Person / ...) |
| `0x00000006` | Camera (alt — duplicate set) |
| `0x10000002` | Combat Mode (Toggle Combat Mode) |
| `0x10000003` | Melee Combat (Increase/Decrease Power, Hi/Mid/Lo Attack) |
| `0x10000004` | Missile Combat (Increase/Decrease Accuracy, Hi/Mid/Lo Attack) |
| `0x10000005` | Magic (Cast Spell, Spell Slot 1-12, Spell Tab nav) |
| `0x10000006` | Emotes (Cheer / Wave / Drudge Dance / 80+ entries) |
| `0x10000007` | Selection (Select Closest Monster / Player / Corpse / ...) |
| `0x10000008` | Options (Auto Target / Display Timestamps / ...) |
| `0x10000009` | UI Panels (Show/Hide Inventory / Spellbook / Map / ...) |
| `0x1000000A` | Chat (Begin Chat / Reply / Tell to Selected / ...) |
| `0x1000000B` | Floating Chat |
| `0x1000000C` | Quickslots (Quickslot 1-18 + Select Quickslot 1-9) |
| `0x1000000D` | Chat Mode (Enter/Exit Chat) |

The bit pattern in `inputMap` looks like it *could* be a packed
`ControlSpecification` (per acclient.h ~L27499), but
empirically:

- `subControl` byte is always `0x00`
- `idxDevice` byte just counts up 0x01–0x10, then a separate
  `0x10000000`-prefixed block 0x02–0x0D
- `ofsKey` is either `0x0000` or `0x1000`

No realistic keystroke encoding fits this distribution. The data
is structurally an enumeration, not a packed key.

The inner-dict key is `action_hash` — the action identifier the
input system uses for dispatch (e.g. `MoveForward`'s hash). Each
inner value carries `action_class` + `action_name` (StringTable
hash for the human label) + `description` + a `toggle_type`.

## Where retail's real defaults live

`acclient.c` ships with hardcoded
`CInputManager_WIN32::BindAction(QualifiedControl, idAction, idMap)`
calls during startup. Each call passes a literal
`ControlSpecification.m_dwKey` (which IS a packed keystroke, per
acclient.h's bitfield), a `m_metamode` (shift/ctrl/alt state),
and a `m_activation` (press/hold/repeat).

Two known examples extracted from acclient.c L196307/196334:

```c
mouse_turn_qc.m_key.m_dwKey = 524545;   // 0x000801C1 — mouse wheel up
mouse_turn_qc.m_dwKey       = 524801;   // 0x000802C1 — mouse wheel down
```

So 0xC1 is the mouse device-index byte (a DirectInput-assigned
index, baked into the binary). 0x01 / 0x02 are wheel-up/down sub-
controls. `0x0008` is the wheel offset.

Extracting **all** retail defaults would require:
1. Locating each `BindAction(QualifiedControl{...}, action, map)`
   call in `acclient.c` (~250+ calls across various subsystems)
2. Mapping each literal `m_dwKey` to (device, sub, offset)
3. Resolving the `idAction` to a human-readable label
4. Mapping device/sub/offset to a portable JS shape
   (`KeyboardEvent.code` for keyboard, sentinel strings for mouse)

This is a multi-hour RE task. Out of scope for the current pass.

## What we did instead

The Controls-tab now groups the 200-row Retail Actions display by
ActionMap category — Movement / Camera / Magic / Emotes / Panels /
etc — using `ACTION_CATEGORY_NAMES` in `plugins/options-panel.js`.
Each row still shows label + Bind/× buttons so users can attach
**custom** keys to retail action labels even though no retail
default surfaces. The keymap layer in `ui/keymap.js` stores both
the local (synthetic-hash) and retail (label-hash) overrides in
the same `holtburger_keybindings_v1` storage.

The note in the Controls tab now reads:

> Retail actions are grouped by their ActionMap category — the
> DAT carries action labels but NOT retail's keystroke defaults
> (those live in acclient.c's startup BindAction calls).

## Artifacts

- Analysis script: `apps/holtburger-tools/examples/action_map_dump.rs`
- Raw dump: `/mnt/wbterminal1/tmp/claude-scratch/actionmap/`
  - `action_map.bin` — 12,303-byte DAT record
  - `string_table.bin` — 60,500-byte StringTable 0x23000005
  - `analyze.rs` — copy of the script for reference
