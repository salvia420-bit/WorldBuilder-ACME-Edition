# RESULTS — Item magic-effect visuals (3D weapon flame + UiEffects badges) — 2026-06-24

Implemented autonomously via /loop from `docs/PLAN-item-magic-effect-visuals-2026-06-24.md`.
**All default-OFF, byte-identical when off, headless-validated. Pending the BATCHED 1070 visual eye-test.**
Branch: `feat/tree-wind-sway-2026-06-23` (UNCOMMITTED — no commit/push performed).

## Two orthogonal features shipped (flagged-off)

### Track B — 3D wielded/ground item flame · `?setupDefaultScript=on`
The flame is data-driven: an item's `SetupModel.default_script` (a 0x33 PhysicsScript DID) →
CreateParticle hooks → 0x32 emitters. Dynamic entities never read it (statics do). Now they can.
- **wasm:** `fetchSetupDefaultScript(setupId) -> u32` + helper `setup_default_script_id` (`src/lib.rs`,
  mirrors `fetch_setup_model_lights`).
- **JS:** new entity-spawn arm in `scene3d/entities.js` (after the A11-S5 wire arm), gated
  `SETUP_DEFAULT_SCRIPT_ON && pesId===0`, reusing `_attachParticleChainForEntity` (anchored on `root`
  → wield carries it for free).
- **wiring:** `fetchSetupDefaultScript` added to BOTH `index.html` `wasmExports` sites + `?v=` bump
  (REQUIRED — else the typeof-guard soft-degrades and the flame never fires).
- Retail call site: `acclient.c:320867 if (setup->default_script_id.id) play_script_internal(...)`.

### Track A — UiEffects (PropertyInt 18) icon badges · `?uiEffectIcons=on`
UiEffects is a 2D inventory-icon overlay in retail (icon-only). DOM/HUD, never touches WebGL.
- **registry:** new `scene3d/vfx/ui_effects_registry.js` — 13-flag → `{img ordinal, tint}` + helpers.
- **A0 (no rebuild):** "Magic Effects" tint badge in the examine panel (`plugins/examine-target.js`
  `renderAppraisal`, reads appraisal `ints.UiEffects ?? ints["18"]`).
- **A1 (rebuild):** inventory-grid corner-dot badges (`plugins/inventory.js makeSlot`) reading the new
  `InventoryItem.uiEffects` wasm getter.
- Real `*_UIEffectImage` icon DataID resolution (EnumIDMap `0x25000009`, Chorizite-confirmed) DEFERRED
  — A0/A1 ship the registry tint.

## Files touched
- `src/lib.rs` — `fetchSetupDefaultScript` getter + `InventoryItem.ui_effects` field/getter/populate.
- `scene3d/entities.js` — `SETUP_DEFAULT_SCRIPT_ON` flag + the Track B spawn arm.
- `scene3d/vfx/ui_effects_registry.js` — NEW.
- `plugins/examine-target.js` — A0 examine badge. `plugins/inventory.js` — A1 inventory badge.
- `index.html` — `fetchSetupDefaultScript` wiring (×2) + `?v=` cache-bust.
- `docs/url-flags.md` — eye-test queue entry. `docs/PLAN-…` / this doc.

## Validation (autonomous)
- 2× `capped-build wasm-pack build --target web --out-dir pkg --release` → exit 0; both exports present
  (`fetchSetupDefaultScript`, `InventoryItem.uiEffects`). (PATH needs `~/.cargo/bin`.)
- `node --check` clean on every edited/new JS file.
- Regression harness `harness/run-js-headless.mjs` — 37/37 prior-passing tests still pass; the 6 failures
  are ALL pre-existing (git-stash baseline gives identical failures on the clean tree).
- chrome-devtools boot smoke at `:8765` with `?setupDefaultScript=on&uiEffectIcons=on` (rebuilt pkg) →
  **0 errors / 0 asserts** (confirms the `fetchSetupDefaultScript` import resolves + nothing throws at load).
- DAT chain independently proven earlier via `dat-tool`: Setup `0x0200051C`.default_script = `0x33000347`
  → emitters `0x3200026E`/`0x32000270` (both real ParticleEmitters).

## NOT validated — QUEUED for the 1070 (swiftshader can't render the GPU particle/visual)
- Track B: `@create 44265` ground + wielded → the 3-emitter flame at the blade; `=off` no flame; roam for
  other Setup-default_script items. Reuse `katar-flame-lifecycle-1070.mjs` / `katar-tight-1070.mjs`.
- Track A: `?uiEffectIcons=on` examine + inventory on UiEffects items → correctly-tinted badges; `=off` none.

## Follow-ups (documented, not built)
- Real `*_UIEffectImage` icon resolution via EnumIDMap `0x25000009` (replace tint badges with retail icons).
- Reconcile UiEffects source-of-truth: PropertyInt 18 vs `PropertyDataId.IconOverlaySecondary (51)`
  (Chorizite `Item.cs:52` + our broken plugin parse both use 51).
- R1 luminosity-honor (orthogonal render fidelity; not the katar, lum=0).
- No `git commit`/`push` performed — awaiting review.
