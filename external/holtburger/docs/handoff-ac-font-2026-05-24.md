# Handoff — AC retail bitmap font + StringTable/ActionMap consumers

**For:** the next agent picking up holtburger-web HUD / text / input
work after the AC-font push.

**Session that produced this:** 2026-05-24, ~10 commits on master,
ending at `e098dae2`.

**Status: shippable.** Every commit verified end-to-end against a
running ACE on the local box. AC retail bitmap font now drives every
text element in the live HUD; retail keybinding labels (389 actions)
are loaded at boot and exposed.

## Don't read everything inline — use Explore agents

Same discipline as the prior handoff. Workspace is large; use
`subagent_type: "Explore"` for open-ended discovery. Direct reads
for known paths.

## Required reading

1. **`docs/vitaeum-parity-plan-2026-05-23.md`** — the canonical
   plan-doc. Wave-1/2/3 status logs at the bottom capture exactly
   what shipped through which commit.
2. **`apps/holtburger-web/ui/ac_font.js`** — the AC bitmap-font
   runtime. ~430 LOC. Read top-to-bottom — the comments explain
   the load-bearing bug fixes (see "gotchas" below).
3. **`apps/holtburger-web/ui/ac_strings.js`** — the string/action
   map runtime. ~150 LOC.

Optional but useful:
- `feedback_open_memory_files.md` and the auto-memory `MEMORY.md`
  index. The relevant memories are:
  - `feedback_dat_format_ace_over_drw.md` — ACE > DRW for wire format.
  - `feedback_ground_in_real_wire_data.md` — discipline.

## State of the project after this push

### AC retail bitmap font is wired everywhere

The HUD renders in retail font 0x40000000 (16 px) or compact
0x4000001C (10 px) for crowded contexts. All visible text:

- Vitals HUD (HP/ST/MN labels + numeric readouts)
- 3D nameplates (canvas-to-texture sprites over entities)
- DOM nameplates (overlay layer)
- Chat panel: tab buttons, channel dropdown, send button, **chat
  lines** (compact font, per-category color)
- Hotbar slot numbers (1–9)
- Combat bar: Stance/Height/Power/Repeat/Charge labels + Hi/Med/Lo
  buttons + numbered spell-bar tabs
- Target bar (target name + "— no target —")
- Long-tail plugins: radar, buffs-hud, combat-hud, status-indicators,
  options-panel, spellbook (school-tinted), main-panel, inventory,
  character-info, map-panel, allegiance-panel, fellowship-panel,
  journal-panel (parchment-ink color), vendor-ui, contracts-panel

Total `<ac-text>` count in a typical autoLogin'd session: ~130.

### StringTable + ActionMap consumers shipped

- StringTable 0x23000005 (input-binding labels) is preloaded at
  boot — 637 entries: "Cast Spell", "Increase Power", etc.
- ActionMap 0x26000000 is chain-resolved through that StringTable,
  exposed at `window.__acKeybindings`. 389 action entries.
- Options-panel "Controls" tab renders the dedup'd action list
  (sorted, scrollable, 200 rows). No rebind functionality yet.
- LanguageString 0x31000010 (Sho-name hint) verified end-to-end.

### dist/ bake

Re-baked with **`--input dats/assets.hba --eor-local
.../client_local_English.dat`** (the new dat-shard merge mode).
Manifest namespaces: `["eor/cell", "eor/local", "eor/portal",
"holtburger/core"]`. Boot pack includes Font 0x40000000 + atlas
Textures 0x06005EE5/EE6.

## Load-bearing gotchas (read before touching `ui/ac_font.js`)

These are bugs I hit. The fixes are landed but the rationale is
non-obvious:

### 1. Top-level `customElements.define` hangs Firefox at DCL

If `ac_font.js` ends up in the page-init static-import graph
(any plugin doing `import ... from "../ui/ac_font.js"`) and
runs `customElements.define` at module top-level, Firefox hangs
at DOMContentLoaded — observed on both SwiftShader headless AND
the 1070 Ti's real-GPU Firefox. Reproducible bug; root cause not
fully understood (likely interacts with the deferred-script
mount sequence + MutationObserver init).

**Fix:** registration is gated behind `registerAcText()` which
runs `customElements.define` on a `setTimeout(0)` — escapes the
deferred-script execution window. `setAcText()` does NOT call
`registerAcText()`; only `loadAcFont` / `renderAcText` do. The
dynamic `import("./ui/ac_font.js").then(loadAcFont)` preload in
`index.html` (post-`init_resource_source`) is what triggers
registration.

If you touch the registration path: verify with
`verify_ac_font_e2e.cjs` against a fresh chromium. A hung
renderer at 99% CPU with no console errors is the symptom.

### 2. Atlas mask MUST be in alpha channel

The wasm `to_rgba8` decodes A8 atlas pixels as `(V,V,V,255)` —
mask in R/G/B, alpha=255 everywhere. Canvas2D's compositing
operates on alpha. With the wasm-default layout, multi-glyph
rendering via per-glyph `destination-in` wipes every prior
glyph (only single-char hotbar slots happened to work pre-fix).

**Fix:** `_atlasToCanvas` re-packs to `(255,255,255,V)`. Then
`renderAcText` draws all glyphs with default source-over (alpha
accumulates the shape) and `source-in`-colorizes once.

Don't add a per-glyph compositing pass that uses
`destination-in` again — it will wipe earlier glyphs.

### 3. ActionMap ID is `0x26000000` (not `0x26000001`)

The ActionMap parity test in `tests/action_map_parity.rs` uses
the correct ID. The plan-doc's earlier hand-wave at
`0x26000001` was wrong. ActionMap lives in **portal.dat**, not
local.

### 4. `MANIFEST_URL` must be module-scoped

The const declaring `MANIFEST_URL = "../../dist/manifest.json"`
needs to be at the top of the `<script type="module">` block,
NOT inside the async init body — there's a downstream error-hint
reference at ~`index.html:6890` that ReferenceErrors otherwise
and tanks autoLogin.

## What's left (open follow-ons)

### Easy wins (rebake-free)

1. **Rebind UI in the Controls tab.** The Input tab today is
   read-only — labels only, no current key shown. Wire to a
   keystroke capture flow + persist to localStorage. ACE doesn't
   define a server-side keybind protocol; this is purely client.
   Per `acclient.c` retail uses `UIOption_ActionKeyMap` for this.

2. **Multi-font support beyond UI + compact.** 47 unused Font
   records. Pick the right one for context:
   - 0x40000007–0x40000018 (21x22 cell, 1912 glyphs) — possibly
     the bold/heading variant.
   - 0x40000017 / 0x40000021 (226735 bytes) — huge, likely the
     Asian-language font.
   - Probe with `od -An -tu4 -N12 -j4 font.bin` to read cell dims.

3. **Wire LanguageString into character creation.**
   `loadLanguageString(0x31000010)` already returns the
   Sho-naming hint. Plug it into a tooltip / sidebar in
   character-creation UI.

### Medium effort (rebake worth batching)

4. **Re-bake to include compact font 0x4000001C + atlases in
   boot.hba.** Currently lazy-fetched over HTTP on first chat-line
   render (3 round-trips). Add IDs to `BOOT_ESSENTIAL_PORTAL_IDS`
   in `apps/holtburger-tools/src/dat_shard.rs`. Also add
   ActionMap (`0x26000000`) for the same reason — Controls tab
   first-render is HTTP-gated today.

### Big efforts (separate sessions)

5. **Full-world bake scope-up: 13×13 → 255×255 Dereth (65,025
   landblocks).** Operations work, not parser work. Per
   `project_world_expand_step_1.md`.

6. **Layer color forwarding into more migrations.** Some
   character-info / inventory / vendor-ui sites have CSS color
   tokens (`--hb-text-gold`, `--hb-text-numeric-green`) that
   render white today. Pass `{color}` through `setAcText` for
   them; values are concrete hex via `getComputedStyle` resolution.

## Files at a glance

| File | What it does |
|---|---|
| `apps/holtburger-web/ui/ac_font.js` | AC font runtime — `loadAcFont`, `renderAcText`, `setAcText`, `<ac-text>` custom element. Read the gotchas above. |
| `apps/holtburger-web/ui/ac_strings.js` | String/ActionMap runtime — `loadStringTable`, `loadActionMap`, `loadLanguageString`. |
| `apps/holtburger-web/src/lib.rs` (search `fetch_font` / `fetch_string_table` / `fetch_action_map`) | Wasm exports. ~150 LOC across all three. |
| `crates/holtburger-dat/src/file_type/{font,string_table,language_string,action_map}.rs` | The parsers. All have `unpack(&[u8])` helpers now. |
| `apps/holtburger-tools/src/dat_shard.rs` | Bake tool. The merge-mode now accepts `--input` + `--eor-*` together. |
| `apps/holtburger-tools/src/bin/dat-shard.rs` | CLI; `--input` is no longer mutually-exclusive with `--eor-*`. |

## Verification harness

`/mnt/wbterminal1/tmp/claude-scratch/font-wiring/verify_ac_font_e2e.cjs`
— Playwright script that:
1. Launches headless chromium with SwiftShader
2. Loads holtburger-web with autoLogin
3. Waits 7s for the runtime to load
4. Probes `getAcFont()` and counts `<ac-text>` elements
5. Captures a screenshot to
   `/mnt/wbterminal1/tmp/claude-scratch/font-wiring/`

Use it as the smoke test for any future ac-font changes. PASS
criteria: `bootState ∈ {ready, in-world}`, `acFontReady: true`,
`acFontGlyphCount: 1050`. Screenshot should show recognizable
HUD text (numerics in vitals, labels in chat tabs, nameplates).

## Where to leave artifacts

`/mnt/wbterminal1/tmp/claude-scratch/font-wiring/` — scratch.
`/mnt/wbterminal1/holtburger-captures/` — screenshots.
Repo `external/holtburger/docs/` — committed PNG references.

Good luck. The text is buttery now.
