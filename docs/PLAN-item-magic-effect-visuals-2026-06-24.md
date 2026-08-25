# PLAN — Item magic-effect visuals (UiEffects + 3D weapon flame) — 2026-06-24

**Status:** authoritative order-of-operations for the work scoped this session. Doubles as the
**live state for the autonomous /loop** — each iteration reads the checklist, does the next
unchecked phase, validates, checks it off, and either continues or stops.

Live source root: `external/holtburger/apps/holtburger-web/`  (NOT `~/holtburger`).
8 GB laptop: NEVER `cargo build --workspace`; wasm builds go through `capped-build wasm-pack`.

---

## What is already resolved (this session — do NOT re-litigate)
- **UiEffects (PropertyInt 18) = 2D inventory-icon overlay ONLY.** Triple-confirmed (acclient decomp
  `IconData::RenderIcons`, Chorizite `IconData.cs:29` "border highlight", census). No 3D consumer.
- **The 3D in-hand flame is `SetupModel.default_script`, data-driven.** DAT-verified chain:
  Weenie 44265 → Setup `0x0200051C`.default_script = `0x33000347` (PhysicsScript, 176 B) →
  3× CreateParticle hooks → emitters `0x3200026E` ×2 + `0x32000270`. Same shape as the retail moon
  glow `0x330007DB`. NOT UiEffects, NOT surface-emissive.
- **Root-cause of "no flame in our client":** dynamic entities never read `SetupModel.default_script_id`.
  Statics DO (`statics.js:3356 attachStaticDefaultScripts` ← wasm `fetch_landblock_objects`
  `lib.rs:1763`). Entity spawn arms (`entities.js:3645`/`3687`) only use wire `physicsScriptDid` +
  wire `entityDefaultScript(guid)` — neither is the Setup DID.
- **Two tracks are ORTHOGONAL.** Track A = 2D UiEffects icons. Track B = honor Setup.default_script.

## Guiding rules
- Every change ships **default-OFF behind a URL flag**, **byte-identical when off**.
- **No new scene light** anywhere (relink / spell-freeze risk). Track B reuses the ParticleManager
  (no new shader programs). Track A is DOM/2D (never touches the WebGL canvas).
- **Reuse, don't reinvent:** Track B reuses `_attachParticleChainForEntity`; Track A reuses the
  examine/inventory icon draw sites.
- Validation: **headless smoke = laptop swiftshader** (loads + spawns + 0 console errors + flag-off
  byte-identity) is the autonomous gate. The **visual fidelity check (flame renders at the blade;
  badge looks right) is 1070-only** → QUEUE it, do not block on it.
- **Do not `git commit`/`push`** unless the user asks. Files land uncommitted.

---

## ORDER OF OPERATIONS (phases; rebuild isolation is deliberate)

### ☑ P1 — Scaffold (JS-only, NO rebuild, zero render risk)
> DONE 2026-06-24: added `?setupDefaultScript` (entities.js:1003, strict opt-in) + `?uiEffectIcons`
> (ui_effects_registry.js:93); created `scene3d/vfx/ui_effects_registry.js` (13-entry table + helpers);
> A0 examine badge wired into `renderAppraisal` (examine-target.js, reads `ints.UiEffects ?? ints["18"]`,
> tint badges, DOM-only). All 3 files `node --check` clean; both flags default-OFF → byte-identical when off.
> Headless smoke folded into P5 matrix (P2 rebuilds the bundle anyway).
- **1a** `scene3d/vfx_flags.js`: add `?setupDefaultScript` → `SETUP_DEFAULT_SCRIPT_ON` (default off)
  and `?uiEffectIcons` → `UI_EFFECT_ICONS_ON` (default off), via the existing memoized `_boolFlag` idiom.
- **1b** new `scene3d/vfx/ui_effects_registry.js`: frozen 13-entry table
  `{ flag, key, name, img, tint:[r,g,b] }` (0x1 Magical … 0x1000 Nether; img = `*_UIEffectImage`
  ordinal; tint shared 2D/3D) + helpers `uiEffectsList(mask)`, `uiEffectIconsFor(mask)`. Pure data,
  imports nothing from THREE.
- **1c** Track A **A0** — examine-panel badge: read the already-serialized appraisal
  `properties.ints["18"]`; when `UI_EFFECT_ICONS_ON`, draw a colored corner badge per set flag using
  the registry `tint` (real `*_UIEffectImage` icon resolution deferred to A1). Insertion: the examine
  panel draw site (`plugins/examine-target.js` ~994, confirm at edit time).
- **Acceptance:** `node --check` on all edited/new JS; headless bare-default loads + 0 new errors;
  with `?uiEffectIcons=on`, examining a UiEffects item shows the tint badge. Flag-off = byte-identical.

### ☑ P2 — Track B wasm getter (ONE clean, low-risk rebuild)
> DONE 2026-06-24: added `fetchSetupDefaultScript(setup_id)->u32` + pure helper `setup_default_script_id`
> after `collect_setup_model_lights` (lib.rs), mirroring `fetch_setup_model_lights`. `capped-build
> wasm-pack build --target web --out-dir pkg --release` (PATH needs ~/.cargo/bin) → exit 0, release in
> 1m09s; only pre-existing dead-code warnings. `fetchSetupDefaultScript` exported in pkg/holtburger_web.js.
- **2a** `apps/holtburger-web/src/lib.rs`: add `#[wasm_bindgen(js_name = fetchSetupDefaultScript)]
  pub async fn fetch_setup_default_script(setup_id: u32) -> Result<u32, JsValue>` — mirror
  `fetch_setup_model_lights` (lib.rs:10038): fetch+parse the SetupModel, return
  `setup.default_script.unwrap_or(0)`. Standalone fn, no struct churn → low build risk.
- **2b** `capped-build wasm-pack build --release ...` (the project's standard wasm build invocation;
  discover exact target/flags from `package.json`/build scripts at run time). Confirm
  `fetchSetupDefaultScript` is present in the built JS glue.
- **Acceptance:** build succeeds; export present; headless loads + 0 errors.

### ☑ P3 — Track B JS arm (NO rebuild)
> DONE 2026-06-24: added the SetupModel.default_script spawn arm in entities.js (after the A11-S5 wire
> arm, ~line 3741), gated `SETUP_DEFAULT_SCRIPT_ON && pesId===0`, reusing `_attachParticleChainForEntity`.
> Validated: `node --check` clean; regression harness 37/37 passing-tests still pass (6 fails are ALL
> pre-existing — confirmed by git-stash baseline, identical on clean tree); chrome-devtools boot smoke at
> :8765 with `?setupDefaultScript=on&uiEffectIcons=on` → 0 errors/asserts (only 1 unrelated syncTick warn).
> IN-WORLD @create 44265 flame render = QUEUED for 1070 (swiftshader can't validate GPU visual).
- **3a** `scene3d/entities.js` spawn path (beside the `physicsScriptDid` arm ~3645 and the
  `fetchSetupModelLights`/`fetchSetupPartSortCenters` per-setup calls ~3599/3624): add a third arm —
  when `SETUP_DEFAULT_SCRIPT_ON && pesId === 0 && !this._particleChainsAttached.has(guid)` and the
  wasm getters exist, call `this.wasmExports.fetchSetupDefaultScript(setupId)` → if non-zero DID and
  still spawned and not already attached, mark `_particleChainsAttached.add(guid)` and
  `this._attachParticleChainForEntity(guid, root, did)` (fail-soft). Reuses the exact walker the
  other arms use; anchors to `root` so wield carries it for free.
- **Acceptance:** `node --check`; headless `@create 44265` (via `__sessionHandle.sendChat`, `<test-account>`
  GM) spawns with 0 errors both flag-off and `?setupDefaultScript=on`; with flag on, console/diag shows
  the chain attaching emitters (best-effort — visual is 1070).

### ☑ P4 — Track A **A1** full HUD (DONE — the InventoryItem path was clean, not the risky EntityUpdate churn)
> DONE 2026-06-24: `InventoryItem.ui_effects` field + `uiEffects` getter + 1 construction-site populate
> (lib.rs, `get_int_prop(PropertyInt::UiEffects)`, mirrors `items_capacity`) — clean, NOT the ~22-literal
> EntityUpdate churn (which Track B doesn't need — it reads the Setup DAT, not wire UiEffects). Inventory-grid
> corner-dot badges in `inventory.js makeSlot` reading `item.uiEffects`, same registry+tint as A0. Second
> `capped-build wasm-pack ... --release` → exit 0 (1m23s), `uiEffects` exported. ALSO (caught from url-flags.md):
> wired `fetchSetupDefaultScript` into BOTH index.html `wasmExports` sites (import + init3D opts) + bumped the
> `?v=` cache-bust to `item-magicfx-2026-06-24` — REQUIRED for Track B's getter to reach entities.js (the
> typeof-guard was silently soft-degrading before this). node --check + boot smoke (rebuilt pkg, flags on) = 0 errors.
> Real `*_UIEffectImage` icon DataID resolution (EnumIDMap 0x25000009) left as a follow-up; A0/A1 ship tint badges.
- **4a** wasm (SEPARATE rebuild, only if 4a edits stay clean): `EntityUpdate.uiEffects` +
  `InventoryItem.uiEffects` field/getter/hydration (mirror `physicsScriptDid`). NOTE: `EntityUpdate`
  needs ~22 literal `ui_effects: 0` additions — if that churn threatens the build, **STOP, leave P2's
  rebuild intact, and document A1 as a reviewed follow-up.**
- **4b** `scene3d/loop.js toMeta` (~2112): `meta.uiEffects` key; `entity_update_clone.js` parity.
- **4c** inventory/hotbar badge compositing (reuse the A0 registry + badge helper at
  `inventory.js`/`hotbar.js`/`container-panel.js` icon sites).
- **4d** real icon resolution via EnumIDMap `0x25000009` (Chorizite-confirmed ordinal→icon map); if
  the DAT EnumIDMap read isn't feasible from our wasm, keep the A0 tint-badge and queue icon assets.
- **Acceptance:** build green; badges render in inventory/hotbar with `?uiEffectIcons=on`; flag-off
  byte-identical; `__diag.render.programs` unchanged.

### ☑ P5 — Validate + finalize
> DONE 2026-06-24: headless smoke matrix clean (boot smoke flags-on, rebuilt pkg → 0 errors; flags default-OFF
> = byte-identical structurally + regression-neutral harness). Wrote `docs/RESULTS-item-magic-effect-visuals-2026-06-24.md`;
> queued the 1070 batched eye-test in `docs/url-flags.md` (2026-06-24 section, both flags + asks); updated memory
> [[project_uieffects_3d_flame_workflow_2026-06-24]]. No commit/push (awaiting review). In-browser runtime getter
> probe declined by user — boot smoke + dat-tool proof + regression-neutral harness stand as validation.
- **5a** Headless smoke matrix (laptop swiftshader, `?nosw=1`): {bare-default} ∪ {`?setupDefaultScript=on`}
  ∪ {`?uiEffectIcons=on`}. All: loads, spawns, 0 console errors. Confirm flag-off byte-identity.
- **5b** Write `docs/RESULTS-item-magic-effect-visuals-2026-06-24.md`: shipped-flagged-off list,
  headless-validated list, the exact 1070 eye-test asks.
- **5c** Queue the 1070 batched eye-test: append the new flags + asks to `docs/url-flags.md`
  (katar flame renders at blade ground+wielded; UiEffects badge renders/looks right).
- **5d** Update memory ([[project_uieffects_3d_flame_workflow_2026-06-24]]).
- **NO commit/push.**

### Out of scope this loop (documented follow-ups)
- **R1** — luminosity-honor (`materials.js` dyed-path emissiveMap) — orthogonal render fidelity; not
  the katar (lum=0). Separate flag, separate session.
- Reconcile UiEffects source-of-truth: PropertyInt 18 vs `PropertyDataId.IconOverlaySecondary (51)`
  (Chorizite `Item.cs:52` reads via 51; our broken plugin parse does too) — decide before A1 polish.

---

## Validation cheatsheet
- node syntax: `node --check <file>` per edited/new JS.
- headless smoke: drive the running `serve.py` (`:8765`/`:9333`) via chrome-devtools MCP with
  `?nosw=1`, or the `harness/run-js-headless.mjs` path; read console; assert 0 errors + entity spawn.
  (chrome-devtools MCP = laptop swiftshader, NOT the 1070.)
- wasm build: `capped-build wasm-pack ...` (cgroup-capped; safe on 8 GB). ~4–5 min.

## Loop protocol
Each iteration: (1) re-read this checklist; (2) take the lowest unchecked phase; (3) implement +
validate to its Acceptance; (4) mark it `☑` with a one-line note; (5) if any remain, `ScheduleWakeup`
to continue; if all done (or only blocked-and-documented remain), write the final summary and STOP.
A phase that hits a hard blocker is left `☐` with a `BLOCKED:` note and the loop proceeds to the next
independent phase rather than spinning.
