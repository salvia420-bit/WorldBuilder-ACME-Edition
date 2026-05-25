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

## Addendum (2026-05-24, later that day) — actually they ARE in the DAT

The "won't-do" conclusion above is **wrong**. Retail's factory-default
keystroke bindings live in `client_portal.dat` after all — as **DAT
type 0x14** (`DB_TYPE_KEYMAP` / DRW's `MasterInputMap`), two records:

- `0x14000000` — 2391 bytes, name = `"gmDefaultMap"`. **The factory
  default keymap.** 14 input_map categories, 133 mappings.
- `0x14000002` — 1005 bytes, name = `"DefaultMap"`. Alt/secondary
  map.

ACE doesn't parse this type (server doesn't dispatch keystrokes) which
is why the search missed it. DRW has the schema. The wire format:

```
MasterInputMap:
  u32 id
  PString<u8> name
  u8[16] guid_map
  u32 num_devices + [DeviceKeyMapEntry; n]   // DeviceType + DI guid
  u32 num_meta_keys + [ControlSpecification; n]
  u32 num_input_maps + Dictionary<u32, CInputMap>

QualifiedControl (16 bytes):
  ControlSpecification key       // 2 × u32: key (DIK + dev) + modifier
  u32                  activation
  u32                  action_hash // DRW calls this `Unknown` — it is
                                   // actually the ActionMap inner-dict
                                   // key. Cross-checked 114-hit/0-miss
                                   // against gmDefaultMap.
```

The `key` u32 decomposes as `(idxDevice | eSubControl | ofsKey)`:
the low byte indexes into `devices[]`, the high u16 is the
DirectInput scan code (`DIK_*`). `modifier` is a bitfield —
`0x80000000`=shift, `0x40000000`=ctrl, `0x20000000`=alt,
`0x10000000`=meta — matching the modifier-bit assignments declared
in `meta_keys[]`.

The wrong-path investigation in this doc happened to also reveal
that the `action_hash` field (which DRW labels "Unknown") is the
linking field — 114-hit/0-miss cross-check verified that every
KeyMap mapping's `action_hash` matches an ActionMap entry's inner-dict
key in the same `input_map` category. That's the join.

**What we shipped to close this:**

- Rust parser at `crates/holtburger-dat/src/file_type/keymap.rs`
  (already existed; only the `unknown` → `action_hash` rename + the
  `unpack()` helper were added in this push).
- Standalone dump example
  `apps/holtburger-tools/examples/keymap_dump.rs` and the cross-check
  validator `keymap_actionmap_xcheck.rs`.
- Wasm export `fetch_key_map(id) → JSON` in
  `apps/holtburger-web/src/lib.rs`. Bundled into `window.__hbWasm`.
- JS resolver in `apps/holtburger-web/ui/keymap.js`:
  - `DIK_TO_KEYBOARD_EVENT_CODE` static table (103 entries — the
    full retail keyboard subset).
  - `qualifiedControlToBinding(mapping, devices)` decodes one
    wire mapping into `{code, shift, ctrl, alt, meta}` shape.
  - `loadRetailKeyMap(id=0x14000000)` is async + cached, returns
    `{raw, byActionHash, byCategoryAction}`. Boots in parallel
    with the ActionMap chain in `index.html`.
  - `lookupRetailDefault(inputMap, actionHash)` is the sync
    join-key lookup the Controls tab uses.
- `apps/holtburger-tools/src/dat_shard.rs` adds `0x14000000` to
  `BOOT_ESSENTIAL_PORTAL_IDS` so the next re-bake lands the
  keymap in `boot.hba` (until then it lazy-fetches over HTTP).
- The note in the Controls tab now reads:

  > Click Bind, press a key (Esc to cancel). Local actions below
  > route through live JS handlers. Retail actions are grouped by
  > their ActionMap category and show their factory-default key
  > (from KeyMap 0x14000000 / gmDefaultMap).

- The Retail Actions section now shows the `(default)` column,
  populated from `gmDefaultMap`.

**Limitations carried forward from the won't-do conclusion:**

- The two mouse-turn quirks (`m_dwKey = 524545 / 524801`) ARE in
  the KeyMap data — they're mouse bindings filtered out at the
  `device_type != 1` boundary in `qualifiedControlToBinding`. The
  Controls tab is keyboard-only by design.
- Alt-bindings (multiple keys → same action, e.g. `W` and
  `ArrowUp` both moving forward) are visible in the `byActionHash`
  map but only the *primary* (modifier-less or first) is shown
  in the row. The capture flow still rebinds to a single key.
  Extending to N-bindings-per-row is a future UI enhancement.
- The `0x08000000` / `0x04000000` modifier bits used by two of
  `gmDefaultMap`'s `meta_keys` entries (mapping the `Tab` and
  `Q` keys as user-extensible meta slots) are NOT surfaced as
  KeyboardEvent modifiers — only the four canonical
  shift/ctrl/alt/meta bits are.

## Reference screenshot

`docs/keymap-controls-tab-2026-05-24.png` — Options → Controls
tab showing retail defaults populated. Local Actions section ends
with Escape / Delete, then the Retail Actions section opens with
the MOVEMENT category: `Autorun → Q (default)`, `Crouch → H
(default)`, etc.

## Verification

End-to-end (Playwright + headless chromium with autoLogin against
local ACE on the same box):

- `bootState`: in-world
- `__hbWasm.fetch_key_map`: present
- `loadRetailKeyMap()`: returns `{raw, byActionHash, byCategoryAction}`
- `gmDefaultMap` (0x14000000): parsed, 133 mappings → 131 keyboard
  bindings + 2 mouse skipped + 0 unmapped DIK codes
- Controls tab in-DOM: 122 `(default)` markers rendered (11 local
  + 111 retail-action defaults from the 112-row
  `byCategoryAction` map minus a couple of dedup'd alt categories)
- Sample retail rows visible in the DOM scrape: "Autorun → Q",
  "Crouch → H", "Move Forward → W", "Strafe Left → A", etc.

Verifier source: `/mnt/wbterminal1/tmp/claude-scratch/keymap/verify_keymap_e2e.cjs`
