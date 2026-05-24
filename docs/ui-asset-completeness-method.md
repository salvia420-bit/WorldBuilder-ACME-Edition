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
| **CombatManeuverTable** *(W7.1)* | 0x30 (71 records) | `fetch_combat_maneuver_table(id) → JSON` | `ui/ac_combat_maneuver.js` + `scene3d/picking.js` melee dispatch |
| **PaletteSet** *(W7.1)* | 0x0F (2681 records) | `fetch_palette_set(id) → JSON` | `ui/ac_palette_set.js` (standalone reader; ClothingTable composer also uses it via `fetch_entity_surface_pixels`) |
| **GfxObjDegradeInfo** *(W7.1 reader + W7.4 entity-spawn LOD)* | 0x11 (4131 records) | `fetch_gfx_obj_degrade_info(id) → JSON` + `fetch_entity_degrade_for_distance(setupId, distance) → u32` | `ui/ac_lod.js` (loader + band picker) + `scene3d/entities.js::_spawnImpl` (spawn-time setup substitution at camera-positioned spawns; matches the statics LOD path). |
| **ClothingTable** *(W7.2/W7.3 — reader + equip-mid-game)* | 0x10 (1917 records) | `fetch_clothing_table(id) → JSON` (serde_json) | `ui/ac_clothing.js` (loader + `getCloObjectEffects` + `getCloSubPalEffect`). Spawn-time substitution lives in `fetch_entity_animation_keyframes`. Wave 7.3 added `ENTITY_UPDATE_KIND_APPEARANCE=6` + `EntityManager.applyAppearance(guid, opts)` (despawn+respawn) so `UpdateObject` (0xF7DB) equip changes propagate live. Hot-swap optimization deferred — see `handoff-clothing-table-2026-05-24.md` § D. |

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

### `__diag.combat` — CombatManeuverTable lookup audit *(W7.1)*

| API | What it reports |
|---|---|
| `summary()` | `{tablesLoaded, tablesCached, failures, hits, misses, missByReason: {stance, height, type}}` |
| `snapshot()` | Full picture: loaded tables + cached state + failure ring + hit sample + miss ring with reasons |
| `cached()` | Read-through to `getCombatDiagSnapshot()` (boot-time pre-loaded tables) |
| `loaded` Map | Hook-observed CMT loads with maneuver + stance counts |
| `failures` ring | Load failures with error string, max 20 |
| `hits` counter + `hitsSample` ring | Each successful (stance, height, type) → motion lookup with the picked motion u32 + chosen powerLevel + candidate count |
| `misses` ring + `missByReason` counters | Failed lookups bucketed by which dict-level missed: stance / height / type |

Source: `scene3d/diag/combat.js`. Hooks at `ui/ac_combat_maneuver.js` `loadCombatManeuverTable` success/empty/catch + `getCombatManeuver` hit/miss. Picking.js wires the lookup on every melee swing.

### `__diag.palettes` — PaletteSet load audit *(W7.1)*

| API | What it reports |
|---|---|
| `summary()` | `{loaded, cached, failures}` |
| `snapshot()` | Full picture: loaded sets + cached state + failure ring |
| `cached()` | Read-through to `getPaletteSetDiagSnapshot()` |
| `loaded` Map | Hook-observed PaletteSet loads (setId → paletteCount, loadedAt) |
| `failures` ring | Load failures, max 20 |

Source: `scene3d/diag/palettes.js`. Hooks at `ui/ac_palette_set.js` `loadPaletteSet` success/empty/catch.

### `__diag.clothing` — ClothingTable load + equip-change audit *(W7.2 + W7.3)*

| API | What it reports |
|---|---|
| `summary()` | `{loaded, cached, failures, appearanceChanges}` |
| `snapshot()` | Full picture: loaded tables (with `baseEffectCount` + `subPalEffectCount`) + cached state + failure ring + appearanceChanges counter + recentChanges ring |
| `cached()` | Read-through to `getClothingDiagSnapshot()` |
| `loaded` Map | Hook-observed ClothingTable loads |
| `failures` ring | Load failures, max 20 |
| `appearanceChanges` counter + `recentChanges` ring (W7.3) | Each `EntityManager.applyAppearance(guid, opts)` invocation records {guid, source, modelChangesCount, textureChangesCount, subPalettesCount, paletteId, ts}. Max 30 recent. |

Source: `scene3d/diag/clothing.js`. Hooks at `ui/ac_clothing.js` `loadClothingTable` success/empty/catch + `entities.js::applyAppearance` (W7.3).

### `__diag.lod` — GfxObjDegradeInfo chain audit *(W7.1)*

| API | What it reports |
|---|---|
| `summary()` | `{loaded, cached, failures, bandHits, bandMisses}` |
| `snapshot()` | Full picture: loaded chains + cached state + failure ring + recent band-hit/miss samples |
| `cached()` | Read-through to `getLodDiagSnapshot()` (per-chain band counts + distance ranges) |
| `loaded` Map | Hook-observed DegradeInfo loads |
| `failures` ring | Load failures, max 20 |
| `bandHits` / `bandMisses` counters + sample rings | Per `pickDegradeBand(runtime, distance)` call: hit records the chosen gfxObjId, miss records the queried distance |

Source: `scene3d/diag/lod.js`. Hooks at `ui/ac_lod.js` `loadDegradeInfo` + `pickDegradeBand`. Entity-spawn LOD integration is the deferred follow-on (see `handoff-degrade-info-entity-lod-2026-05-24.md`).

### Composition

All seven install during `installDiag()` in `scene3d/index.js::preInit3D`, alongside the Wave-1-through-5 surfaces. No URL flag gates them; `__diag.{fonts,strings,input,combat,palettes,lod,clothing}` is always available for inspection from devtools.

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

Three of the five vitaeum-parity deferred items shipped in Wave 7.1 (CombatManeuverTable, PaletteSet, GfxObjDegradeInfo reader). Two remain deferred with concrete handoff docs:

- **ClothingTable** — `handoff-clothing-table-2026-05-24.md`. Scoped as Clothing I (helmet + weapon MVS, ~9-12 days) + Clothing II (full body + dyes, ~15-20 days).
- **LayoutDesc** — `handoff-layout-desc-2026-05-24.md`. Recommended defer until a concrete UX win is identified; 24-panel refactor estimated at multi-week per panel.
- **GfxObjDegradeInfo entity-spawn integration** — `handoff-degrade-info-entity-lod-2026-05-24.md`. The reader shipped in 7.1; the actual entity-spawn substitution is a 6-hour follow-on.

If a future agent wires one of these (or the next batch), add it here:

1. Add a row to §1's pipeline table.
2. If it has its own observability needs, add a `__diag.<name>` sub-surface following the same hooks-at-pipeline-edge + read-through-for-cache pattern. Wave 7.1's `scene3d/diag/{combat,palettes,lod}.js` are the template.
3. Update §4 with the surface description.
4. Update the surface inventory in [`diagnostic-toolset-method.md`](diagnostic-toolset-method.md) §5 + the sub-surface table in §5.1.
5. Mark the corresponding handoff doc closed with a link to the shipping commit.

Don't pile up dead diag — only ship a surface when the consumer ships.

---

## 7. Provenance

| Date | Commit | What landed |
|---|---|---|
| 2026-05-23 | `c36a1054` → `54c3c085` | vitaeum-parity wave: 4 milestone-C parsers + Layout chain + KeyMap + ActionMap |
| 2026-05-24 | `e098dae2` → `c995132d` | AC font + LanguageString + StringTable + ActionMap consumers in `ui/ac_*.js` + HUD migration |
| 2026-05-24 | `c77b0daa` → `80ae3bcf` | KeyMap rebind UI + LOCAL_ACTIONS table in `ui/keymap.js` |
| 2026-05-24 | `30d0d8c8` | Wave 7: UI-asset-completeness method + three `__diag` surfaces (`scene3d/diag/{fonts,strings,input}.js`) + host-file hooks |
| 2026-05-24 | (this doc, Wave 7.1) | Three more wasm exports + JS runtimes for the previously-deferred vitaeum-parity parsers: CombatManeuverTable (with picking.js dispatch + `__diag.combat`), PaletteSet (standalone reader + `__diag.palettes`), GfxObjDegradeInfo (reader + band picker + `__diag.lod`). ClothingTable and LayoutDesc deferred with explicit handoff docs. |
| 2026-05-24 | (this doc, Wave 7.2) | ClothingTable reader foundation: `fetch_clothing_table` (serde_json), `ui/ac_clothing.js` (`loadClothingTable` + `getCloObjectEffects` + `getCloSubPalEffect`), `__diag.clothing`. Original handoff doc was corrected: spawn-time clothing substitution was ALREADY plumbed through `fetch_entity_animation_keyframes` (lib.rs:~L10778-10830). |
| 2026-05-24 | (this doc, Wave 7.3) | Equip-mid-game UpdateObject (0xF7DB) wire path: `ENTITY_UPDATE_KIND_APPEARANCE=6` + lib.rs handler + loop.js dispatch + `EntityManager.applyAppearance(guid, opts)` (despawn+respawn) + `__diag.clothing.onAppearanceChange` hook with `appearanceChanges` counter + `recentChanges` ring. Hot-swap optimization deferred — see `handoff-clothing-table-2026-05-24.md` § D. |
| 2026-05-24 | (this doc, Wave 7.4) | DegradeInfo entity-spawn LOD: `fetch_entity_degrade_for_distance(setupId, distance) → u32` wasm composer (resolve_did_degrade + GfxObjDegradeInfo unpack + band pick) + spawn-time gate in `_spawnImpl` + `__diag.lod.{spawnAttempts, spawnSubstitutions, recentSubstitutions}`. Closes the last item from `handoff-degrade-info-entity-lod-2026-05-24.md`. |
| 2026-05-24 | (this doc, Wave 7.5) | applyAppearance hot-swap: load-bearing AnimationCache fix (key now includes substitution hash — pre-W7.5 the cache silently returned stale entries for W7.3 despawn+respawn AND would have broken hot-swap) + opt-in `?clothingHotSwap=1` URL flag routing into `_applyAppearanceHotSwap` (preserves root + mixer + currentAction; swaps only child Mesh contents of each part Group). Diag distinguishes via `source: "hot-swap"` vs `source: "wire-update-object"`. Closes `handoff-clothing-table-2026-05-24.md` § D. |
| 2026-05-24 | (this doc, Wave 7.6) | AnimationCache strict-LRU eviction: `entries.size` capped at 256 (configurable via `?animCacheMax=N`); move-to-tail on hit; skip in-flight entries during eviction; eviction also triggers on Promise resolution (catches boot-drain concurrent-fetches case). Stats exposed via `__diag.assets.summary().animCache = {size, max, pending, evictions, watermark}`. Closes W7.5's "cache memory grows by equip-variants" follow-on. |
| 2026-05-24 | (this doc, Wave 7.7) | Clothing II foundation (Phase A + B). A: `__diag.clothing.dyeApplications` ring + `dyesBySource` counter hooks into `fetchEntitySurfacesPixels` callsites in both `_spawnImpl` AND `_applyAppearanceHotSwap`. B: `fetch_palette(id) → JSON` wasm export + `ui/ac_palette.js` (`loadPalette`/`paletteColor`) + `__diag.palettes.{palettesLoaded, paletteFailures}` extension. Wiki-grounded design (server owns commit via Dye Pot recipe; client renders pre-computed overlays). Phases C (preview compositor) + D (plugin UI) deferred — see `handoff-clothing-table-2026-05-24.md` § C. |

Cross-references:
- [`diagnostic-toolset-method.md`](diagnostic-toolset-method.md) — umbrella; surface-15 sub-surface table updated alongside this doc
- `external/holtburger/docs/vitaeum-parity-plan-2026-05-23.md` — the source-wave plan with full pipeline-by-pipeline rationale
- `~/.claude/projects/-home-wbterminal/memory/reference_wire_agent_diag_layer.md` — the runtime diag layer this extends
