I now have the full substrate grounded. I have everything needed to produce the integration-plan + audit deliverable for **slice 16**. Here it is.

---

# Phase-1 Visual-Behavior Suite — INTEGRATION PLAN + AUDIT (slice 16)

## Goal

Synthesize the Phase-1 dependency graph, the ordered commit/integration sequence, and a per-component **legacy-safety audit** against `lint_caps.js`, so the 15 sibling slices land in an order that is byte-identical-when-off at every step and provably keeps program count `O(component-SETs)`. This slice owns the cross-slice glue artifacts: the updated `test_vfx_legacy_safety.mjs` expectation, the TIER1 component barrel `scene3d/vfx/components/index.js`, a firewall test, and the audit checklist doc. It does **not** add a rendering effect.

Grounding (read, cited inline): `registry.js`, `lint_caps.js`, `materials.js:262/297/316/1845`, `loop.js:817/1605`, `statics.js:1598/1730/2122/2325`, `vfx_catalog.js`, `tree_wind.js:24/84`, `cost_model.jsonl`, `CommandEngine.Vfx.cs:349/405`, and all four `test_vfx_*.mjs`.

---

## Integration notes

### A. Dependency graph (edges = "must land before")

```
                       ┌──────────────────────────────────────────────┐
   01 oscillators.js ──┤ writes VFX_GLOBALS.uTime (+ named channels)   │
   (master clock,      │ ticked ONCE/frame at loop.js:1605             │
    loop tick)         └──────────────────────────────────────────────┘
        │  uTime / phase channels
        ├──────────────► 05 glint        (clock + vVfxHash)
        ├──────────────► 07 enchantShimmer (clock + vVfxHash)
        └──────────────► 11 flameFlicker  (clock → light.intensity)

   03 per-instance vVfxHash (procedural, in-shader; NO attribute, NO program)
        ├──────────────► 05 glint (phase)   07 enchantShimmer (phase)   08 tarnish (age)
   04 shadow/depth exclusion (color-pass-only patch) ──► gates ALL frag effects 05-10

   02 frag_install.js  (componentSetKey + getCachedVariant builder; FAMILY_ORDER chain)
        └── resolveFragMaterial(...) consumed by ──► 13 config-threading (the statics call-site swap)
            requires ≥1 registered component to be meaningful (lands dormant: no DID resolves frag yet)

   12 weather_inputs.js  writes uWetness / uFrost / uWindDir, ticked at loop.js:1605
        ├──────────────► 09 wetness (uWetness + world-normal)
        └──────────────► 10 frost   (uFrost   + world-normal)   [mutually exclusive w/ 09 via shared channel]

   14a vfx_flags.js  (per-effect default-OFF readers) ──► 13 config-threading (gating predicate)
   13 config-threading ── activates 05-11 at statics.js:1730 / :2325 behind ?visual && per-effect flag
   15 cost_model rows ── needs the 8 component ids (after 05-11 exist) ──► `vfx gauge` STRUCTURAL-PASS
   11 bloom strategy ── needs emissive set (05/06/07) to pick threshold
   14b url-flags.md docs + 16 audit/test-harness ── last
```

**The dormancy invariant that makes the order safe.** Every shared uniform (`VFX_GLOBALS.uTime/uWetness/uFrost` — `materials.js:316`) defaults to an inert value (`0`), proven by `test_vfx_material_substrate.mjs:18`. So a weathering component can land **before** its driver: `wetness` reads `uWetness=0` → its GLSL multiplies by 0 → no-op until `weather_inputs` (12) drives it. This is why the canonical sequence can place *weathering effects → weather-inputs* (effect first, driver second) symmetric to *oscillator → emissive effects* (driver first, effect second): both are safe because the seam is byte-identical while the uniform is at rest **and** while the statics swap (13) hasn't fired. Nothing renders differently until `?visual` + the per-effect flag are both on.

### B. Ordered integration sequence (one commit per piece, continues Phase-0 `commit 5`)

| # | Commit (subject) | Slice | Lands | Off-state proof |
|---|---|---|---|---|
| P1.1 | `feat(vfx): material-oscillator registry + single per-frame tick` | 01 | `oscillators.js`, `loop.js:1605` seam | tick only writes `VFX_GLOBALS.{value}`; no material consumes them yet → identical |
| P1.2 | `feat(vfx): frag-install path + componentSetKey (dormant)` | 02 | `frag_install.js` (`resolveFragMaterial`, `componentSetKey`) | function exists, **no call site yet** → identical |
| P1.3 | `feat(vfx): per-instance vVfxHash varying (procedural)` | 03 | GLSL helper consumed by later `inject()` | unused until an effect injects → identical |
| P1.4 | `feat(vfx): shadow/depth-pass exclusion guard` | 04 | color-pass-only patch guard | no frag patch installed yet → identical |
| P1.5 | `feat(vfx): per-effect flag readers + ?visualBudget stub` | 14a | `vfx_flags.js` (all default-OFF) | readers return false → identical |
| P1.6 | `feat(vfx): emissive.glint component` | 05 | `components/glint.js` | registered + lint-clean, **not attached** → identical |
| P1.7 | `feat(vfx): emissive.magicGlow component` | 06 | `components/magicGlow.js` | "" |
| P1.8 | `feat(vfx): emissive.enchantShimmer component` | 07 | `components/enchantShimmer.js` | "" |
| P1.9 | `feat(vfx): weathering.tarnish component` | 08 | `components/tarnish.js` | "" |
| P1.10 | `feat(vfx): weathering.wetness component` | 09 | `components/wetness.js` | "" (reads `uWetness=0`) |
| P1.11 | `feat(vfx): weathering.frost component` | 10 | `components/frost.js` | "" (reads `uFrost=0`) |
| P1.12 | `feat(vfx): weather inputs → uWetness/uFrost/uWindDir` | 12 | `weather_inputs.js`, `loop.js:1605` seam | drives uniforms, but effects still un-attached → identical |
| P1.13 | `feat(vfx): light.flameFlicker + bloom strategy (+lightIntensity cap)` | 11 | `components/flameFlicker.js`, **`lint_caps.js`/`registry.js` cap edit** | flicker tick only runs when `?flameFlicker` → identical |
| P1.14 | `feat(vfx): descriptor-config-threading — statics frag attach` | 13 | `statics.js:1730/:2325` getCached→resolveFragMaterial swap | gated `?visual && hasFrag(did) && perEffectFlag` → identical when off |
| P1.15 | `feat(vfx): cost-model rows + gauge accounting` | 15 | `cost_model.jsonl` (+gauge) | offline tool only |
| P1.16 | `docs(vfx): url-flags + TIER1 harness + legacy-safety expectation + audit checklist` | 14b/16 | this slice's files | tests + docs only |

**Audited reorder vs. the literal prompt sequence (one deviation, justified):** the prompt lists "flags/gauge" *last*, but `config-threading` (13) gates on the per-effect flag readers. So the **flag-reader module** (`vfx_flags.js`) is split out as **P1.5 (14a)** and lands before 13; only the **url-flags.md documentation** (14b) stays last. Likewise **`frag_install` (02) lands the function, not the call-site swap** — the live `statics.js:1730/:2325` edit is owned solely by **config-threading (13)**, so two slices never touch the same line. These two splits are the only ordering corrections the audit imposes.

### C. Firewall check — program count stays `O(component-SETs)`

The firewall line is `materials.js:277` (`"|v" + (u.__vfxSetKey||"")`), read lazily by `_patchSetCacheKey` (`materials.js:262`). `getCachedVariant` (`materials.js:1845`) keys the **material** by `(surfaceDid|setKey|configKey)` but the **program** key is `__vfxSetKey` only — independent of surfaceDid and configKey. So 10k DIDs sharing one component SET → 10k cache-shared clones, **one** compiled program.

Two gates enforce this:
1. **Static (CI):** after each effect's cost row lands (15), run `vfx gauge --ref holtburg`. G1 (`CommandEngine.Vfx.cs:405`) asserts `programsDelta ≤ uniqueModels + 8`; G2 (`:412`) asserts `drawcallsDelta == 0`; G3 (`:419`) asserts `vramMB ≤ 16`. Verdict must read `STRUCTURAL-PASS` (`:433`).
2. **Pure-logic (headless):** `test_vfx_firewall.mjs` (below) proves `componentSetKey` is config- and instance-invariant, so no scalar/hash can ever reach `customProgramCacheKey`.
3. **Live (1070 eye-test):** `?renderDiag` program count stays flat as you walk through frag-effect scenery (mirrors the `lightPool` proof in `url-flags.md:181`).

---

## Manifest — per-component legacy-safety AUDIT (vs `lint_caps.js`)

Every row verified: `reads ⊆ ALLOWED_READS` (`lint_caps.js:15`), `writes ⊆ ALLOWED_WRITES` (`lint_caps.js:28`), `deterministic:true`, `lightCountDelta:0`, `cacheKeyScope∈{set,none}`, `family∈FAMILIES` (`registry.js:34`), `mech∈MECHS` (`registry.js:35`). Source predicted clean against `FORBIDDEN_SOURCE` (`lint_caps.js:43`).

| Component (file) | family / mech | channel (§14 conflict unit) | reads | writes | cacheKeyScope | linkVariant | Manifest verdict |
|---|---|---|---|---|---|---|---|
| `deformation.windBend` (windBend.js) | deformation / A | `transform` | geometry, instanceHash, clock, weather | partTransform | none | `""` | ✅ **shipped** |
| `emissive.glint` (glint.js) | emissive / frag | `glint` | clock, instanceHash, surface | materialUniform | **set** | `""` | ✅ legal |
| `emissive.magicGlow` (magicGlow.js) | emissive / frag | `emissiveFloor` | surface | materialUniform | **set** | `""` | ✅ legal |
| `emissive.enchantShimmer` (enchantShimmer.js) | emissive / frag | `emissivePulse` | clock, instanceHash | materialUniform | **set** | `""` | ✅ legal |
| `weathering.tarnish` (tarnish.js) | weathering / frag | `tarnish` | setup, instanceHash, surface, clock | materialUniform | **set** | `""` or `"b"` (optional blotch-map = 1 structural bit) | ✅ legal |
| `weathering.wetness` (wetness.js) | weathering / frag | `precip` ◄─┐ | weather, geometry | materialUniform | **set** | `""` | ✅ legal |
| `weathering.frost` (frost.js) | weathering / frag | `precip` ◄─┘ shared ⇒ mutual-exclusion | weather, geometry, clock | materialUniform | **set** | `""` | ✅ legal |
| `light.flameFlicker` (flameFlicker.js) | emissive / light | `light` | clock | **lightIntensity** ⚠ | none | `""` | ⚠ **see F1** |

### Audit findings

**F1 (blocking, cross-slice — owned by slice 11, specified here).** `flameFlicker` modulates a pooled torch/brazier `Light.intensity`. That write is **not** in `ALLOWED_WRITES` (`{renderTransform, partTransform, materialUniform, emitter}`, `lint_caps.js:28`), so `lintManifest` (`lint_caps.js:64`) and `registerComponent` (`registry.js:62`) would **reject** it. Resolution — the single surgical substrate extension Phase 1 needs (an allowlist *addition*, not a redesign):

```js
// lint_caps.js — ALLOWED_WRITES (after :32, before "emitter")
  "lightIntensity",   // light.intensity — count-preserving render write (never .visible/array)
```
```js
// registry.js — WRITE_CAPS (:33)
const WRITE_CAPS = new Set(["renderTransform", "partTransform", "materialUniform", "emitter", "lightIntensity"]);
```
This keeps THE RULE intact: `.intensity` is render-time, server-unreplicated, and **count-preserving**. The `lightCountDelta!=0` reject (`registry.js:48`) and the `.visible=` source ban (`lint_caps.js:49`) are untouched and still fire — verified by a new negative below. Putting `flameFlicker.js` under `components/` (rather than a bare lighting-code tick) is deliberate: it brings the file under the Layer-B source scan (`test_vfx_legacy_safety.mjs:34`), so any accidental `.visible=` / count change is mechanically caught. *Fallback if the team wants zero substrate-vocab change:* register `flameFlicker` as a named oscillator in slice-01's registry (infra, no manifest) and cover its intensity-only/no-count safety with a dedicated test — but then it escapes the component gate. **Recommended: the cap addition.**

**F2 (advisory).** `frost` and `wetness` must share **one channel** (`precip`) so the §14 conflict resolver picks exactly one (the prompt's "mutually-exclusive" rule). Audit the resolver wiring in slice 02/13 to confirm same-channel components don't both attach. `magicGlow`/`enchantShimmer` use **distinct** channels (`emissiveFloor`/`emissivePulse`) so a magic item can both floor-glow and pulse — they compose on the chain (both emissive family=3, ordered by id under one `__vfxSetKey`).

**F3 (firewall rule for slices 05/08).** `linkVariant(config)` MUST return `""` for every continuous scalar (`strength`, `metalBias`, `age`, glow floor) — those ride uniforms. It may return **at most a low-cardinality structural bit** (e.g. tarnish's optional `uBlotchMap` sampler path → `"b"`). A continuous scalar in `linkVariant` would fork the program per-config and blow G1. `test_vfx_firewall.mjs` (below) enforces this.

**F4 (clean for all frag components).** None read `serverReplicated/otherEntityState/wireInbound`; none write the wire/physics/collision/replicatedPose. All use `hash01(setupDid^instanceHash)` or the procedural `vVfxHash` (slice 03), never `Math.random`/argless `Date.now`. Source-scan predicted clean against all seven `FORBIDDEN_SOURCE` patterns.

### GLSL seam-ordering invariants this audit enforces (no new GLSL in this slice)

Verified composition order under the **single** `_chainBeforeCompile` chain (`materials.js:297`), ordered by `FAMILY_ORDER` (`registry.js:25` = deformation 0, texture 1, weathering 2, emissive 3, particle 9):
- **emissive** (glint/magicGlow/enchantShimmer): inject after `#include <emissivemap_fragment>` → `totalEmissiveRadiance += …` (glint after `#include <roughnessmap_fragment>` for the metalness gate).
- **weathering** (tarnish/wetness/frost): inject after `#include <map_fragment>`, **POST-palette decode** (modify `diffuseColor.rgb` + `roughnessFactor`). Weathering family-order (2) < emissive (3) guarantees diffuse is tarnished/wetted *before* emissive radiance is added — correct per chorizite render semantics.
- **shadow/depth pass MUST NOT receive the patch** (slice 04): the patch installs only on the color material from `getCachedVariant`; `customDepthMaterial` stays unpatched.
- **No backticks inside GLSL comments** in any `inject()` template literal (closes the JS literal). Audit each `components/*.js` template-literal for stray `` ` ``.

---

## Files (produced by THIS slice)

### New: `scene3d/vfx/components/index.js` — the TIER1 barrel

```js
// VFX Phase-1 component barrel — the TIER1 registration set (2026-06-23).
//
// Importing this module registers every Phase-1 VisualComponent EXACTLY ONCE
// (each component file self-registers on import via registerComponent in
// registry.js). Runtime and tests import THIS single edge so the registry is
// fully + identically populated; the legacy-safety + gauge + firewall tests
// assert against TIER1_COMPONENT_IDS so a forgotten or stray component fails CI.
// Listed in FAMILY_ORDER then id, i.e. chain-composition order.

export { windBend } from "./windBend.js";              // deformation (Phase 0)
export { tarnish } from "./tarnish.js";                // weathering
export { wetness } from "./wetness.js";                // weathering
export { frost } from "./frost.js";                    // weathering
export { glint } from "./glint.js";                    // emissive
export { magicGlow } from "./magicGlow.js";            // emissive
export { enchantShimmer } from "./enchantShimmer.js";  // emissive
export { flameFlicker } from "./flameFlicker.js";      // emissive / mech light

// The closed Phase-1 set. test_vfx_legacy_safety asserts the live registry
// equals this set (no missing, no stray). Keep in sync with cost_model.jsonl.
export const TIER1_COMPONENT_IDS = Object.freeze([
  "deformation.windBend",
  "weathering.tarnish",
  "weathering.wetness",
  "weathering.frost",
  "emissive.glint",
  "emissive.magicGlow",
  "emissive.enchantShimmer",
  "light.flameFlicker",
]);
```

### Edit: `test_vfx_legacy_safety.mjs` — extend Layer A to the whole TIER1 set

**Anchor — replace lines 11-13:**
```js
import { lintManifest, lintSource, ALLOWED_READS, ALLOWED_WRITES } from "./scene3d/vfx/lint_caps.js";
import { windBend } from "./scene3d/vfx/components/windBend.js"; // registers it
import { allComponents } from "./scene3d/vfx/registry.js";
```
**with:**
```js
import { lintManifest, lintSource, ALLOWED_READS, ALLOWED_WRITES } from "./scene3d/vfx/lint_caps.js";
import { windBend, TIER1_COMPONENT_IDS } from "./scene3d/vfx/components/index.js"; // registers ALL Phase-1 components
import { allComponents, getComponent } from "./scene3d/vfx/registry.js";
```
**Anchor — replace line 23:**
```js
check("at least one component registered (windBend)", comps.length >= 1 && comps.includes(windBend));
```
**with:**
```js
check("all TIER1 Phase-1 components registered (barrel populated the registry)",
  TIER1_COMPONENT_IDS.every((id) => !!getComponent(id)) && comps.length >= TIER1_COMPONENT_IDS.length,
  `have ${comps.length}, expect ${TIER1_COMPONENT_IDS.length}`);
check("registry is CLOSED to the TIER1 set (no stray/forgotten component)",
  comps.every((c) => TIER1_COMPONENT_IDS.includes(c.id)), comps.map((c) => c.id).join());
```
**Anchor — append after the existing negative fixtures (after line 88), to lock F1:**
```js
// F1 — the lightIntensity write cap is legal AND count-change is still rejected.
check("lightIntensity is an allowed write (flameFlicker)", ALLOWED_WRITES.has("lightIntensity"));
check("NEG manifest: lightCountDelta!=0 STILL rejected even with lightIntensity write",
  lintManifest({ id: "x", channel: "light", deterministic: true, lightCountDelta: 1, cacheKeyScope: "none",
                 reads: ["clock"], writes: ["lightIntensity"] }).length > 0);
check("NEG source: a light tick using .visible= is STILL flagged",
  lintSource("light.visible = (uF > 0.0);").length > 0);
```
*(Layer A loop `:25-29`, Layer B dir-glob `:34-43`, and Layer C `:45-70` already auto-cover the eight component files — no change needed there.)*

### New: `test_vfx_firewall.mjs` (see ## Test)
### New: `docs/visual-suite-spec/PHASE1-AUDIT-CHECKLIST.md` (see ## Integration notes / checklist below)

---

## GLSL

None in this slice (audit/integration). The seam-ordering invariants this slice *audits* are listed under **Manifest → GLSL seam-ordering invariants** above; the per-effect snippets are owned by slices 03/05–11.

---

## Test

### `test_vfx_firewall.mjs` — program-count-is-O(SETs) invariant

```js
// VFX Phase-1 — firewall invariant test (program count = O(component-SETs)).
//
// THE FIREWALL (binding): the program-cache key is per component-SET — the
// single __vfxSetKey read by _patchSetCacheKey (materials.js:262/277). Config
// scalars and per-instance hashes flow ONLY through uniforms/attributes, NEVER
// into componentSetKey -> customProgramCacheKey. This proves componentSetKey is
// config-invariant, instance-invariant, and order-stable, so distinct programs
// ≈ distinct SETs (a handful), never ≈ DIDs (10k).

import { componentSetKey } from "./scene3d/vfx/frag_install.js";
import "./scene3d/vfx/components/index.js"; // registers all TIER1 components
import { getComponent } from "./scene3d/vfx/registry.js";

let passed = 0, failed = 0;
function check(label, cond, extra = "") {
  if (cond) { passed++; console.log(`  [OK] ${label}`); }
  else { failed++; console.log(`  [FAIL] ${label} ${extra}`); }
}

const glint = getComponent("emissive.glint");
const tarnish = getComponent("weathering.tarnish");

// (1) config-INVARIANCE — two different configs must collapse to ONE set key
//     (strength/metalBias ride uniforms, never the program).
check("set key is config-INVARIANT (scalar config never forks the program)",
  componentSetKey([glint], { strength: 0.2, metalBias: 0.1 }) ===
  componentSetKey([glint], { strength: 0.9, metalBias: 0.8 }));

// (2) order-STABILITY — sorted by FAMILY_ORDER then id, so input order is moot.
check("set key is order-STABLE (deterministic sort)",
  componentSetKey([tarnish, glint], {}) === componentSetKey([glint, tarnish], {}));

// (3) membership DOES matter — a different SET is a different (intended) program.
check("distinct SET -> distinct key (intended +1 program per set)",
  componentSetKey([glint], {}) !== componentSetKey([glint, tarnish], {}));

// (4) NO per-instance token may ever leak into the set key.
const k = componentSetKey([glint, tarnish], { aVfxHash: 0.7, guid: 0xdeadbeef, instanceHash: 0x1234 });
check("set key carries NO per-instance token (hash/guid/instanceHash)",
  !/dead|beef|0\.7|aVfxHash|instanceHash|0x1234/i.test(k), k);

console.log(`\nVFX firewall: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
```

### Test plan (whole Phase 1)

| Test file | Owner | Asserts |
|---|---|---|
| `test_vfx_oscillators.mjs` | 01 | named oscillators write `VFX_GLOBALS.{value}`; tick is O(1); `uTime` advances; off→0 |
| `test_vfx_frag_install.mjs` | 02 | `componentSetKey` sort; `resolveFragMaterial` builds via `_chainBeforeCompile`; binds globals by ref |
| `test_vfx_per_instance_hash.mjs` | 03 | vVfxHash derived from `instanceMatrix[3].xy`; deterministic; **never** touches `customProgramCacheKey` |
| `test_vfx_shadow_exclusion.mjs` | 04 | depth/`customDepthMaterial` has no `__vfxSetKey`/patch; color material does |
| `test_vfx_glint.mjs` / `_magicglow` / `_enchantshimmer` | 05/06/07 | registers; `lintManifest`==0; `inject`/`declareUniforms` shape; clip-off identical |
| `test_vfx_tarnish.mjs` / `_wetness` / `_frost` | 08/09/10 | as above; tarnish POST-`<map_fragment>`; wet/frost share `precip` channel |
| `test_vfx_flameflicker.mjs` | 11 | intensity-only; no `.visible`; pool count unchanged; `lightIntensity` cap accepted |
| `test_vfx_weather_inputs.mjs` | 12 | storm→uWetness, winter/temp→uFrost, slow uWindDir rotate; deterministic |
| `test_vfx_config_threading.mjs` | 13 | `?visual && hasFrag(did)` → `getCachedVariant`; coexists with windBend MECH-A peel |
| **`test_vfx_legacy_safety.mjs`** (updated) | **16** | Layer A over all 8; Layer B dir-scan; F1 cap negatives |
| **`test_vfx_firewall.mjs`** (new) | **16** | componentSetKey config/instance-invariance + order stability |
| `test_vfx_windbend/_catalog/_material_substrate` | (Phase 0) | unchanged — must stay green (regression gate) |

**Harness TIER1 registration:** every test that needs the full registry imports `./scene3d/vfx/components/index.js` (the barrel) **first** — one edge, no per-test import drift. Runtime does the same once at VFX boot.

---

## Risks

- **R1 — F1 substrate edit coordination.** Adding `lightIntensity` touches `lint_caps.js:28` + `registry.js:33` and must land **in the same commit** as `flameFlicker.js` (P1.13). If the cap lands late, `flameFlicker` registration throws and breaks the barrel import for every downstream test. Mitigated by the updated legacy-safety test asserting the cap is present.
- **R2 — barrel coupling.** `components/index.js` makes any single broken component file fail *all* registry-dependent tests at once (import-time throw). That's intentional (closed-set guarantee) but means a WIP component must register cleanly or be temporarily removed from the barrel + `TIER1_COMPONENT_IDS` together — the closed-set check (`comps.every(... includes)`) keeps them in lockstep.
- **R3 — two slices, one line.** `frag_install` (02) and `config-threading` (13) both reference `statics.js:1730/:2325`. Audit-enforced split (02 = function, 13 = call-site) prevents a merge conflict; if a sibling ignores it, the seam doubles. Flagged in the commit table.
- **R4 — `vVfxHash` from `batchingMatrix` vs `instanceMatrix`.** three sets `USE_BATCHING` xor `USE_INSTANCING` per draw path; slice 03's hash must `#ifdef` both (BatchedMesh vs InstancedMesh) or singletons get a constant hash (acceptable — they're 1-of-1). Audit slice 03's GLSL for both defines before P1.6 depends on it.
- **R5 — gauge is static (Half-A).** `vfx gauge` (`CommandEngine.Vfx.cs:349`) reads `cost_model.jsonl`, it does **not** count live programs — a mis-authored `linkVariant` returning a scalar would pass the gauge (cost row says `dProgramsPerDriver:1`) but explode live. `test_vfx_firewall.mjs` + the 1070 `?renderDiag` flat-program-count eye-test are the real backstops; the gauge is necessary-not-sufficient.
- **R6 — `cacheKeyScope` drift.** Every frag component must be `"set"` (it patches the program) — `"none"` would mean "no program contribution" and silently drop it from the firewall accounting. Layer A only checks `∈{set,none}`; the audit table is the human check that frag⇒`set`, light/A⇒`none`.

### Audit checklist (ships as `docs/visual-suite-spec/PHASE1-AUDIT-CHECKLIST.md`)

Per component, before its commit merges:
- [ ] `family ∈ {deformation,weathering,emissive,texture,particle}`; `mech ∈ {A,B,frag,light,particle}`
- [ ] `reads ⊆ ALLOWED_READS`, non-empty; `writes ⊆ ALLOWED_WRITES`, non-empty (`lint_caps.js:15/28`)
- [ ] `deterministic:true`, `lightCountDelta:0`, `cacheKeyScope ∈ {set,none}` (frag⇒`set`, A/light⇒`none`)
- [ ] `linkVariant(config)` returns `""` or a low-cardinality **structural** bit only (no scalar) — F3
- [ ] `lintSource(file)` == 0 hits; no backtick inside any GLSL comment
- [ ] GLSL seam matches family: emissive after `<emissivemap_fragment>`, weathering after `<map_fragment>` POST-palette, glint after `<roughnessmap_fragment>`
- [ ] depth/`customDepthMaterial` NOT patched (slice 04 guard)
- [ ] per-instance variation via `vVfxHash`/`hash01(setupDid^instanceHash)` — never a per-instance program
- [ ] added to `components/index.js` barrel **and** `TIER1_COMPONENT_IDS` **and** `cost_model.jsonl` (3-way sync)
- [ ] component unit test green; `test_vfx_legacy_safety.mjs` + `test_vfx_firewall.mjs` green
- [ ] `vfx gauge --ref holtburg` → `STRUCTURAL-PASS`, G1/G2/G3 pass after the cost row lands
- [ ] default-OFF: `?visual` off **and** per-effect flag off → byte-identical (the dormancy invariant)
- [ ] queued-for-1070: `?renderDiag` flat-program-count walk-through + the per-effect eye-test (slice 15)

Suite-level gates: Phase-0 tests (`windbend/catalog/material_substrate`) stay green; live program count flat under `?visual=on` + each effect; wet/frost mutual exclusion holds on the shared `precip` channel.

---

I read the real substrate end-to-end and the plan is anchored to it; the one substrate change Phase 1 requires (the `lightIntensity` write cap for `flameFlicker`) is surfaced as finding **F1** with the exact diff and a fallback, which is precisely the kind of cross-slice issue this audit slice exists to catch before 8 components land on a vocabulary that would reject one of them.
