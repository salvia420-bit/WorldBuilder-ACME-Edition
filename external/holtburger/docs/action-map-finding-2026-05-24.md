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

## Where retail's real defaults live (and why we can't extract them)

**Hypothesis tested:** retail defaults are hardcoded `BindAction()`
calls in `acclient.c` we could extract literally.

**Finding (2026-05-24 follow-up):** No. Searched the 31 MB
Hex-Rays decompile for `BindAction` and `AddMapping` call sites:

- `BindAction` definition exists at L13434 / L669899 — but only **two**
  call sites in the entire decompile, both runtime mouse-turn special-
  case rebinds at L196307/L196334 (`m_dwKey = 524545 / 524801`).
- `AddMapping` has **5** call sites — all driven by **loops reading
  from existing data structures** (`CInputMap::Copy()` rhs walking,
  config-file parser at L678888 reading `PFileNode` entries).
- `gmKeyboardUI::AddActionKeyMap` populates the in-game keybind UI
  by calling `CInputMap::FindKeysForAction(map, action, &qclDefaults)`
  on a CInputMap whose contents come from elsewhere.

A `grep` for literal `m_dwKey = <N>` assignments anywhere in the
binary returns exactly **3** results (the two mouse-turn quirks +
one `m_dwKey = 0` init). There is **no hardcoded table** of
retail default bindings in acclient.c.

The shipped defaults must come from one of:

- A `UserPreferences.ini` or similar config file the installer
  places in the user's profile dir (we don't have one).
- A binary resource section inside `acclient.exe` (we have the
  exe but Hex-Rays output strips resource sections; the strings
  dump shows no obvious keymap config blob).
- The retail installer's `setup.exe` decoding a default-state
  file at install time.

We don't have the original AC installer or the per-user
preferences file. Even with them, the `m_dwKey` packed format
encodes a **DirectInput device index** (`m_idxDevice` byte) that
is assigned dynamically at runtime — the literal `0xC1` we see
for mouse in the two known examples is the index DirectInput
gave to the mouse on the particular box where the binary was
captured. Decoding it to a portable `KeyboardEvent.code` would
require either reproducing DirectInput's device enumeration order
or matching by the surrounding context (device-type lookups).

**Conclusion:** extracting retail default keystrokes is not
feasible from the artifacts we have. The Controls-tab path
forward is what we already shipped: group retail actions by
category, let users bind any key they want, no "(default)"
column for the retail block. Closing as won't-do.

If a future agent gets hold of the AC installer's default
`UserPreferences.ini` or someone reverse-engineers
`acclient.exe`'s resource section, the wiring contract is
already in place — just populate
`ACTION_CATEGORY_NAMES`-keyed default bindings into the
`ui/keymap.js` layer.

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
