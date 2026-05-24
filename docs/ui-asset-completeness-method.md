# UI-Asset + Input-Binding Completeness Method

**Status:** Shipped client-observation layer 2026-05-24. Build-side validator deferred to first-regression demand.
**Predecessor docs:** [`world-completeness-method.md`](world-completeness-method.md), [`event-completeness-method.md`](event-completeness-method.md), [`entity-completeness-method.md`](entity-completeness-method.md). This doc sits alongside them.
**Wave:** The vitaeum-parity DAT-coverage wave (`external/holtburger/docs/vitaeum-parity-plan-2026-05-23.md`) shipped four new boot-time asset pipelines that don't fit the per-frame placement-or-event mould of the existing completeness contracts. This doc defines the parallel contract for them.

---

## 1. What this method covers

Five boot-time pipelines that load retail data once, cache it module-scoped, and feed every later consumer. They are *implicit-load asset pipelines*, not per-frame state machines — there is no continuous stream of events to validate; the contract is "the cache contents at any point in time match the canonical DAT bytes."

| Pipeline | DAT type | Wasm export | JS consumer |
|---|---|---|---|
| **Font** | 0x40 (49 records) | `fetch_font(id) → FontData` | `ui/ac_font.js` (loadAcFont, renderAcText, `<ac-text>`) |
| **LanguageString** | 0x31 (28 records) | `fetch_language_string(id) → string` | `ui/ac_strings.js::loadLanguageString` |
| **StringTable** | 0x23 (15 records) | `fetch_string_table(id) → Map<u32, str>` | `ui/ac_strings.js::loadStringTable + acString` |
| **ActionMap** | 0x26 (1 record) | `fetch_action_map(id) → ActionMap` | `ui/ac_strings.js::loadActionMap` + `ui/keymap.js` |
| **KeyMap (rebind storage)** | (client-only, localStorage) | — | `ui/keymap.js::{setBinding, clearBinding, resolveLocalBinding}` |

The KeyMap pipeline is the one client-only entry: rebinds live in `localStorage["holtburger_keybindings_v1"]`. ACE has no server-side keybind protocol, so this is the canonical store.

---

## 2. The completeness contract

For a given session:

```
loaded_ui_assets(session) ≡ {
    fonts_cached    ⊆ Font records present in client_portal.dat
  ∪ string_tables_cached ⊆ StringTable records present in client_local_English.dat
  ∪ language_strings_cached ⊆ LanguageString records present in client_local_English.dat
  ∪ action_map_cached ⊆ ActionMap records present in client_portal.dat (1 expected)
}

active_input_bindings(session) ≡ {
    LOCAL_ACTIONS defaults
  ∪ localStorage["holtburger_keybindings_v1"] overrides (when present)
}
```

The contract has three correctness axes:

1. **Bytewise parity** — when an asset is fetched, the resulting wasm-side decode matches what the corresponding Rust parser produced for that DAT record. *Already gated* by the parser-side parity tests under `crates/holtburger-dat/tests/` (Milestone D shipped 101/101 Layout records byte-exact; Font/LanguageString/StringTable/ActionMap each ship their own parity test).
2. **Cache integrity at runtime** — once loaded, the in-memory cache value matches what was returned from the wasm export. *Gated* by the runtime diag surfaces (§4).
3. **Boot-failure observability** — when a load fails (missing record, parse error, wasm export absent), the diag surface records the failure with enough context to triage. *Gated* by the runtime diag surfaces (§4).

There is no "expected oracle" the way placements + events have one — every DAT record IS the oracle. Either the parser test passes (bytewise correct) or it doesn't.

---

## 3. Out of scope

- **Visual rendering correctness.** That a glyph drew at the right pixel offset is a render-pose / coordinate-frame question (surface 7 of [`diagnostic-toolset-method.md`](diagnostic-toolset-method.md)), not a UI-asset-completeness question.
- **Localization completeness.** That every UI string the client displays has a corresponding LanguageString record. Today the migration is gradual — most plugins still hard-code English strings; a future doc would gate "no hard-coded strings" but that's a UX/i18n axis, not a completeness axis.
- **Keybind conflict policy.** That two LOCAL_ACTIONS aren't bound to the same physical key. Detected by `__diag.input.conflicts()` but resolution is operator policy, not a contract.
- **Server-side ActionMap dispatch.** ACE has no server-side keybind protocol; if/when it gets one, that becomes a wire-conformance question, not a UI-asset question.

---

## 4. Client-side observation layer

Three new `__diag` sub-surfaces shipped 2026-05-24 alongside this doc. Hooks fire from the host pipelines (`ui/ac_font.js`, `ui/ac_strings.js`, `ui/keymap.js`) using the established optional-chained `window.__diag?.<surface>?.<onEvent>(meta)` pattern.

### `__diag.fonts` — AC bitmap-font pipeline

| API | What it reports |
|---|---|
| `summary()` | `{loaded, cached, failures, fallbackCodepoints, elements, atlasMemMB, customElement, canonicalIds}` |
| `snapshot()` | Full picture: per-font glyph counts + atlas dims + fallback chars + custom-element registration state |
| `cached()` | Read-through to `getAcFont(id)` for the 4 canonical font IDs (UI/HEADING/COMPACT/CHAT) |
| `loaded` Map | Hook-observed loads (fontId → {glyphCount, atlasWidth, atlasHeight, loadedAt}) |
| `failures` ring | `{fontId, error, source: "fetch"|"empty"|"build", ts}` — max 50 |
| `fallbacks` Set | Codepoints rendered via system-font fallback (deduped) |
| `customElementState()` | Whether `customElements.get("ac-text")` is registered |
| `elementCount()` | Live count of `<ac-text>` elements in the DOM |

Source: `scene3d/diag/fonts.js`. Hooks at `ui/ac_font.js` `loadAcFont` success/empty/catch + `_drawGlyphs` fallback branch.

### `__diag.strings` — StringTable + LanguageString + ActionMap

| API | What it reports |
|---|---|
| `summary()` | `{tablesLoaded, tablesCached, tablesFailed, languageStringsLoaded, ..., actionMapReady, lookupMissesUnique}` |
| `snapshot()` | Full picture: per-table entry counts + per-language-string lengths + ActionMap state + per-table missing-hash lists |
| `cached()` | Read-through to `getStringsDiagSnapshot()` for boot-time loaded items |
| `tablesLoaded` Map | Hook-observed StringTable loads |
| `tablesFailed` / `languageStringsFailed` rings | Load failures with error string, max 50 each |
| `lookupMisses` Map | `tableId → Set<hashId>` — keys requested but missing from a loaded table |
| `actionMap` | Hook-observed ActionMap load with `{stringTableId, actionCount, labelResolveFails, loadedAt}` |

Source: `scene3d/diag/strings.js`. Hooks at `ui/ac_strings.js` `loadStringTable`, `loadLanguageString`, `loadActionMap`, `acString` lookup-miss.

### `__diag.input` — Keybinding storage + rebind audit

| API | What it reports |
|---|---|
| `summary()` | `{defaultCount, overrideCount, conflictCount, rebindHistorySize, storageErrorCount, actionMapReady}` |
| `snapshot()` | Full picture: defaults + overrides + active merged + conflicts + rebind history + storage errors |
| `defaults()` | Pass-through of `LOCAL_ACTIONS` table |
| `overrides()` | Pass-through of `getKeybindings()` (raw localStorage shape) |
| `activeBindings()` | Merged: defaults + overrides, with `source: "default"|"override"` per row |
| `conflicts()` | Keypress shapes mapped to >1 labelHash |
| `rebindHistory` ring | `{labelHash, oldBinding, newBinding, op, ts}` — max 50 |
| `storageErrors` ring | `{op: "read"|"write", error, ts}` — max 20 |
| `actionMapState()` | Cross-reference into `__diag.strings.actionMap` (hook OR cache) |

Source: `scene3d/diag/input.js`. Hooks at `ui/keymap.js` `setBinding`, `clearBinding`, `load` catch, `persist` catch.

### Composition

All three install during `installDiag()` in `scene3d/index.js::preInit3D`, alongside the Wave-1-through-5 surfaces. No URL flag gates them; `__diag.{fonts,strings,input}` is always available for inspection from devtools.

---

## 5. Build-side validator (deferred)

The contract is currently policed by:

- **Per-parser parity tests** (`crates/holtburger-dat/tests/<type>_parity.rs`) gate the wire format.
- **Client-side `__diag` observation** gates the runtime cache.

A `validate_ui_asset_completeness.cjs` Playwright-driven script could exist to boot the wire-agent, force-load every canonical asset, and assert no failures — but the existing parser tests + the manual diag inspection already give high confidence. **Ship a build-side validator when a first regression hits**, not pre-emptively. Until then, manual verification recipe:

```bash
# From any node-modules-with-playwright location:
node /mnt/wbterminal1/tmp/claude-scratch/wire-agent-new-pipelines-2026-05-24/run-diag-new-pipelines.mjs

# Output: /mnt/wbterminal1/tmp/claude-scratch/wire-agent-new-pipelines-2026-05-24/out-<ts>/
#   - installed.json       — diag surfaces attached
#   - fonts_post.json      — full font snapshot after exercise
#   - strings_post.json    — full strings snapshot
#   - input_post.json      — full input snapshot
#   - console.log          — page console for failure-mode debugging
```

Verdicts to look for:
- `fonts.summary.loaded + fonts.summary.cached ≥ 1` and `fonts.summary.fallbackCodepoints ≥ 0`
- `strings.summary.tablesLoaded + strings.summary.tablesCached ≥ 1` and `strings.summary.actionMapReady === true`
- `input.summary.defaultCount === 11` and `input.summary.storageErrorCount === 0`

---

## 6. When this method's coverage extends

If a future agent wires one of the other vitaeum-parity parsers into a JS consumer (ClothingTable, PaletteSet, DegradeInfo, CombatManeuverTable, Layout/MasterProperty UI port), add it here:

1. Add a row to §1's pipeline table.
2. If it has its own observability needs, add a fourth `__diag` sub-surface (probably `__diag.clothing`, `__diag.palettes`, `__diag.combat`) following the same hooks-at-pipeline-edge + read-through-for-cache pattern. The three Wave-7 surfaces in `scene3d/diag/{fonts,strings,input}.js` are the template.
3. Update §4 with the surface description.
4. Update the surface inventory in [`diagnostic-toolset-method.md`](diagnostic-toolset-method.md) §5 + the sub-surface table in §5.1.

Don't pile up dead diag — only ship a surface when the consumer ships.

---

## 7. Provenance

| Date | Commit | What landed |
|---|---|---|
| 2026-05-23 | `c36a1054` → `54c3c085` | vitaeum-parity wave: 4 milestone-C parsers + Layout chain + KeyMap + ActionMap |
| 2026-05-24 | `e098dae2` → `c995132d` | AC font + LanguageString + StringTable + ActionMap consumers in `ui/ac_*.js` + HUD migration |
| 2026-05-24 | `c77b0daa` → `80ae3bcf` | KeyMap rebind UI + LOCAL_ACTIONS table in `ui/keymap.js` |
| 2026-05-24 | (this doc) | UI-asset-completeness method + three `__diag` surfaces (`scene3d/diag/{fonts,strings,input}.js`) + host-file hooks |

Cross-references:
- [`diagnostic-toolset-method.md`](diagnostic-toolset-method.md) — umbrella; surface-15 sub-surface table updated alongside this doc
- `external/holtburger/docs/vitaeum-parity-plan-2026-05-23.md` — the source-wave plan with full pipeline-by-pipeline rationale
- `~/.claude/projects/-home-wbterminal/memory/reference_wire_agent_diag_layer.md` — the runtime diag layer this extends
