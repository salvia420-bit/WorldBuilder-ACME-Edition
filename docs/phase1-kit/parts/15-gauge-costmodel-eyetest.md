All edits applied and verified end-to-end. Here is my slice deliverable.

---

# Slice 15 — GAUGE + EYE-TEST (`15-gauge-costmodel-eyetest`)

## Goal

Make `vfx gauge` **account for every Phase-1 component** so the gauge never faults `"missing cost rows"` when a DID resolves to one, and give the integrator a single **batched 1070 eye-test checklist** + **url-flags queue entries** for the cheap-fragment family.

Concretely: (1) add the 5 missing Phase-1 cost rows to `cost_model.jsonl` (glint + tarnish already shipped in Phase 0) scored on the five placement-independent axes; (2) add a **G4 light-count gate** + a `dLightsPerDriver` axis so the C# gauge mirrors the JS manifest's binding `lightCountDelta==0` rule (the row that motivates it is `light.flameFlicker`); (3) ship a node test that mirrors the gauge sum; (4) the eye-test checklist + url-flags queue block. **All applied, built (0 errors), and run green (`STRUCTURAL-PASS`, headroom 100%).**

## Files

### 1. NEW DATA — `WorldBuilder.Terminal/VfxData/cost_model.jsonl` (5 rows inserted before the `rigid` fallback)

```jsonl
{"id":"emissive.magicGlow","costClass":"cheap","dProgramsPerDriver":1,"dCallsPerInstance":0,"dVramMB":0,"dParticleEmitters":0,"dLightsPerDriver":0,"dAluClass":"low","mech":"frag","note":"Fragment after <emissivemap_fragment>; totalEmissiveRadiance += diffuse*uGlow (reuses the resolved diffuse as emissiveMap — the applyFloatLumDiffuse path materials.js:1238 — so 0 new sampler, 0 VRAM). emissiveIntensity floored <=2.0. <=1 link variant per material-SET (build-spec 11.3), 0 draw calls. Bloom halos are free when ?bloom is on (bloom is a GLOBAL post pass, not a per-driver cost). Spends the FRAGMENT budget, never a light slot (dLightsPerDriver=0)."}
{"id":"emissive.enchantShimmer","costClass":"cheap","dProgramsPerDriver":1,"dCallsPerInstance":0,"dVramMB":0,"dParticleEmitters":0,"dLightsPerDriver":0,"dAluClass":"low","mech":"frag","note":"Fragment after <emissivemap_fragment>; totalEmissiveRadiance *= (1 + a*sin(uTime*f + phase)). Phase rides the per-instance hash (vVfxHash), NEVER baked into the GLSL string (a per-placement uniform in the source forks the program per placement = a hard FAIL, 2.1). uTime is the shared VFX_GLOBALS/oscillator uniform (one tick/frame, O(1), placement-independent). <=1 program per material-SET, 0 draw calls, 0 VRAM."}
{"id":"weathering.wetness","costClass":"cheap","dProgramsPerDriver":1,"dCallsPerInstance":0,"dVramMB":0,"dParticleEmitters":0,"dLightsPerDriver":0,"dAluClass":"low","mech":"frag","note":"Global rain sheen — fragment after <map_fragment> (POST-palette decode): darken resolved diffuseColor.rgb + drop roughnessFactor, weighted by world-normal.up * VFX_GLOBALS.uWetness. ONE shared global uniform (weather_inputs.js), applies broadly (not per-DID), composing into the existing material-SET: <=1 added program per SET, 0 draw calls, 0 VRAM (uniform-only, no new texture). Mutually exclusive with weathering.frost (single diffuse-channel owner per 14)."}
{"id":"weathering.frost","costClass":"cheap","dProgramsPerDriver":1,"dCallsPerInstance":0,"dVramMB":0,"dParticleEmitters":0,"dLightsPerDriver":0,"dAluClass":"low","mech":"frag","note":"Winter-zone frost — fragment after <map_fragment> (POST-palette): lighten + desaturate diffuseColor.rgb + micro-sparkle, weighted by world-normal.up * VFX_GLOBALS.uFrost (season/temp, weather_inputs.js). ONE shared global uniform, <=1 added program per material-SET, 0 draw calls, 0 VRAM. MUTUALLY EXCLUSIVE with weathering.wetness (14 diffuse-channel single-owner) — a driver carries at most one, so the two never double-count a program."}
{"id":"light.flameFlicker","costClass":"cheap","dProgramsPerDriver":0,"dCallsPerInstance":0,"dVramMB":0,"dParticleEmitters":0,"dLightsPerDriver":0,"dAluClass":"none","mech":"light","note":"Torch/brazier light whose .intensity jitters via a shared oscillator (smoothNoise/decay) ticked once/frame — NO shader patch (mech=light, not frag): 0 programs, 0 draw calls, 0 VRAM, 0 particle emitters. THE RULE (binding): modulates .intensity ONLY — NEVER .visible or the light array/count (a count change forces a MeshStandard RELINK + frame freeze — the spell-freeze light-pool history). dLightsPerDriver=0 is the G4 invariant (lightCountDelta must stay 0). CPU cost is O(flickering lights), placement-independent."}
```

### 2. EDIT — `WorldBuilder.Terminal/CommandEngine.Vfx.cs` (the gauge: G4 axis + gate)

**a. New cost-row axis** (after `DParticleEmitters`, now `:510`):
```csharp
/// <summary>Lights ADDED per driver (the G4 axis). MUST be 0 for every effect — a light-count change forces a
/// MeshStandard relink + frame freeze (THE RULE; the spell-freeze light-pool history). flameFlicker modulates
/// an existing light's .intensity only, so this stays 0. Absent on legacy rows ⇒ deserializes to 0 (no churn).</summary>
[System.Text.Json.Serialization.JsonPropertyName("dLightsPerDriver")] public int DLightsPerDriver { get; init; }
```

**b. Accumulator** (`:368`, beside `particleEmitters`): `int lightsDelta = 0;`
**c. Sum sites** (`:386` per-component loop; `:395` rigid fallback): `lightsDelta += row.DLightsPerDriver;` / `lightsDelta += rr.DLightsPerDriver;`

**d. The G4 gate** (after G3, `:431`); `allPass` now `g1 && g2 && g3 && g4` (`:438`):
```csharp
// G4 — Δlights = 0 (no light-COUNT change). A light effect (light.flameFlicker)
// modulates an EXISTING light's .intensity only; ANY added light forces a
// MeshStandard relink + frame freeze (THE RULE — the spell-freeze light-pool
// history). Mirrors the JS manifest's lightCountDelta==0 enforcement on the C#
// side, so a future light component that tried to grow the count FAILs here.
bool g4 = lightsDelta == 0;
gates.Add(new VfxGaugeGate(
    "G4", "Δlights = 0 (intensity-only, no light-count relink)",
    g4, $"lightsDelta={lightsDelta} (must be 0 — no MeshStandard relink)"));
```

**e. Result threading** — `LightsDelta: lightsDelta,` in the `VfxGauge` return (`:457`); `int LightsDelta,` added to the `VfxGaugeResult` record (`:536`); `LightsDelta: 0` in the `Failure` factory (`:548`).

### 3. EDIT — consumers (display parity)
- `WorldBuilder.Terminal/TerminalRepl.cs:3019` — `Console.WriteLine($"  lightsDelta       {r.LightsDelta}   (G4 — must be 0, no light-count relink)");`
- `WorldBuilder.Terminal/JsonCommandProcessor.cs:1154` — `lightsDelta = r.LightsDelta,`

### 4. NEW TEST — `external/holtburger/apps/holtburger-web/test_vfx_cost_model.mjs` (full contents in **## Test**)

## GLSL

**N/A for this slice** — gauge + eye-test owns no shader seam. The GLSL seams my cost rows *score* are owned by the effect slices (05 glint `<roughnessmap_fragment>`, 06 magicGlow / 07 enchantShimmer `<emissivemap_fragment>`, 08 tarnish / 09 wetness / 10 frost `<map_fragment>` POST-palette, 11 flameFlicker = no GLSL, light `.intensity` tick). My rows assert each of those is `dCallsPerInstance:0` and `<=1` program/SET — the firewall those slices must hold.

## Manifest

This slice ships **C# cost-model data + a gauge gate, not a JS `VisualComponent`**, so there is no `registerComponent` manifest and `lint_caps.js` does not scan it (it scans `scene3d/vfx/components/*`; my only JS file is a test). The analog is the **five-axis cost manifest** each row asserts — the gauge's structural contract:

| component | mech | dPrograms/driver | dCalls/inst (G2) | dVramMB (G3) | dParticle | **dLights (G4)** | dAlu | costClass |
|---|---|---|---|---|---|---|---|---|
| `emissive.magicGlow` | frag | 1 | **0** | 0 | 0 | **0** | low | cheap |
| `emissive.enchantShimmer` | frag | 1 | **0** | 0 | 0 | **0** | low | cheap |
| `weathering.wetness` | frag | 1 | **0** | 0 | 0 | **0** | low | cheap |
| `weathering.frost` | frag | 1 | **0** | 0 | 0 | **0** | low | cheap |
| `light.flameFlicker` | light | **0** | **0** | 0 | 0 | **0** | none | cheap |

**Placement-independence proof (the binding invariant):** every axis is summed **once per unique driver, never × placements** (the gauge's scaling invariant, `CommandEngine.Vfx.cs:362`). `dCallsPerInstance:0` ⇒ no de-instancing (G2). `dProgramsPerDriver:1` for frag rows = the single per-SET link variant the firewall guarantees (config scalars + `vVfxHash` ride uniforms/attributes, never `customProgramCacheKey`); `flameFlicker` is `0` (no shader). `dVramMB:0` = uniform-only, no per-instance texture growth (G3). `dLightsPerDriver:0` = the no-relink rule (G4). The C# `VfxComponentCost` record doc (`:478`) already forbids any axis that grows with placements as a "hard FAIL by the scaling invariant".

## Test

`external/holtburger/apps/holtburger-web/test_vfx_cost_model.mjs` — 62 checks, `check()/process.exit` style, pure-data (no three.js), resolves `VfxData/` by walking up to the repo root:

```js
// VFX Phase 1 / slice 15 — cost-model + gauge accounting test.
//   1. cost_model.jsonl parses; 2. every Phase-1 id has a row; 3. every
//   archetype-referenced id is scored; 4. placement-independence (0-calls,
//   O(1) programs, 0 VRAM, cheap) on every NEW row; 5. G4 dLights==0 on
//   EVERY row; 6. mech shape; 7. a JS mirror of the gauge sum proves a
//   frag+light archetype passes G1–G4; 7b. the Holtburg ref is unperturbed.
// (full contents committed to the file — abbreviated here)
```

Key assertions and **verified results**:

```
$ node test_vfx_cost_model.mjs       → 62 passed, 0 failed
$ node test_vfx_catalog.mjs          → 14 passed, 0 failed   (no regression)
$ node test_vfx_legacy_safety.mjs    → 17 passed, 0 failed   (no regression)
$ dotnet build WorldBuilder.Terminal → 0 Errors
$ echo '{"command":"vfx-gauge","ref":"holtburg"}' | …--stdin
  → verdict:"STRUCTURAL-PASS", drawcallsDelta:0, programsDelta:0,
    vramMB:0, lightsDelta:0, headroomPct:100,
    gates:[G1 pass, G2 pass, G3 pass, G4 pass]   ← G4 now present + green
```

The gauge is **byte-identical** on the Holtburg ref (programsDelta still 0) because the 5 new rows are only summed when a DID resolves to a magic-item/weatherable/torch archetype — none exist on the Holtburg ref yet (it resolves only to `trunk-canopy`×6 + `rigid`×21). Test 7b asserts this structurally.

**Harness registration (for slice 16's TIER1 list):** add `test_vfx_cost_model.mjs` to the node VFX suite. **Suggested C# gauge test** (slice 16's gate): assert `VfxGauge("holtburg").Gates.Count == 4` and `.Single(g => g.Id == "G4").Pass` — locks the G4 gate against regression.

## Integration notes

**How it composes on the chain.** Nothing on the GLSL `_chainBeforeCompile` — this slice is downstream of every effect. The cost model is **the gate that lets the effect slices land**: the moment slice 13 wires a magic-item archetype (`[emissive.magicGlow, emissive.enchantShimmer]`) or a weatherable/torch set into `visual_archetype_rules.jsonl`, the classifier resolves those component ids and the gauge sums their rows — **which now exist**, so it reports a real budget instead of faulting `"missing cost rows for resolved component(s)"` (`CommandEngine.Vfx.cs:396`). The rows are inert until then.

**Gauge cost rows (the 5 added):** see **## Files §1**. Conservative-by-design: `dProgramsPerDriver:1` per frag component is summed per driver, an **upper bound** ≥ the true per-SET program count (the firewall collapses a multi-component SET to one program). It holds for Phase 1 because the only resolvable archetypes on the ref carry 0-program components. **Queued-for-1070 / Phase 2:** refine the gauge to sum by **distinct component-SET** (collapse `componentSetKey`) rather than per-driver, so a frost+wetness+glow-heavy future ref isn't over-counted against `Kp = uniqueDrivers + 8`. Filed as a G1-accounting refinement.

**`?flag`s (queue, default-OFF, owned by slice 14).** Per-effect: `?magicGlow ?enchantShimmer ?wetness ?frost ?flameFlicker` (glint/tarnish via `?rigidGlint`/`?glint`/`?tarnish`); master `?visual`; governor `?visualBudget=<pct>`. My deliverable supplies the **url-flags queue block** below for slice 14/16 to paste — I do **not** edit `docs/url-flags.md` directly (16 agents would conflict).

---

### BATCHED 1070 EYE-TEST CHECKLIST — Phase 1 cheap-fragment family

> Knock out in ONE 1070 sitting. Prereq: `?visual=on` (master) + each per-effect flag. **PASS = effect visible · `=off` byte-identical · no perf regression vs `?visual=off` baseline · `vfx gauge` STRUCTURAL-PASS.** Capture an A/B screenshot pair (`on` / `off`) per row.

| # | Effect (flag) | Where to look on the 1070 | What you should see | Pass criteria |
|---|---|---|---|---|
| 1 | **glint** (`?visual=on&glint=on`, rigid-glint) | Draw/inspect a sword/axe/mace; sweep the camera | A view+time-varying specular **sparkle** travels across the metal as the half-vector sweeps; gated to metal | Sparkle visible on metal weapons only; `=off` identical; no fps drop; gauge green |
| 2 | **tarnish** (`?tarnish=on`) | Same metal weapons / metal scenery (lamp posts, fittings) | **Patina/crevice darkening** + raised roughness; per-instance age varies object-to-object (hash, not uniform) | Tarnish visible + per-object variation; POST-palette (no palette double-decode artifact); `=off` identical; gauge green |
| 3 | **magicGlow** (`?magicGlow=on`) | A magic item (glowing weapon/armor); + `?bloom=on` to confirm halo | Soft **ambient self-glow** (emissive ≈ diffuse, intensity floor ≤2.0); a bloom **halo** when bloom is on | Glow visible; bloom halo free when bloom on; emissive never blows out; `=off` identical; gauge green |
| 4 | **enchantShimmer** (`?enchantShimmer=on`) | Enchanted gear; watch ~2–4 s | A slow **pulsing shimmer** (`emissive *= 1+a·sin`); phase **differs per instance** (no lockstep) | Pulse visible + de-phased across copies; smooth (oscillator-driven); `=off` identical; gauge green |
| 5 | **wetness** (`?wetness=on`) | Roam into a **storm** (`?rain=on`); look at up-facing surfaces (roofs, ground, crates) | Up-facing faces go **darker + glossier**; vertical faces barely change; tracks `uWetness` as the storm ramps | Sheen on up-faces, broad (not just trees); fades with storm; `=off` identical; gauge green |
| 6 | **frost** (`?frost=on`) | A **winter/cold** zone (low temp/season); confirm **not** also wet | **Lighten + desaturate** + micro-sparkle; mutually exclusive with wetness (never both at once) | Frost visible in cold zones; wet+frost never co-occur on one surface; `=off` identical; gauge green |
| 7 | **flameFlicker** (`?flameFlicker=on`) | A torch/brazier light; watch the lit wall ~5 s | The **light intensity jitters** (warm flicker); **no popping/snapping**, no relink hitch | Flicker visible; **zero frame-freeze** on toggle (proves no `.visible`/light-count change); `=off` identical; gauge green |

**Global gate after all 7 on at once (`?visual=on&glint=on&magicGlow=on&enchantShimmer=on&tarnish=on&wetness=on&frost=on&flameFlicker=on`):** outdoor Holtburg steady-state stays **< 75% GPU** (design §5.2 ceiling), CPU-bound fps unregressed, **0 console errors**, and `vfx gauge --ref holtburg` still **STRUCTURAL-PASS** (the firewall: program count stays O(component-sets), `lightsDelta == 0`). The **timing meter (G5–G7) is 1070-only** — this sitting *is* that meter (the CI box is SwiftShader = STRUCTURAL-PASS only).

---

### url-flags.md QUEUE ENTRIES (ready-to-paste for slice 14/16 — NON-RETAIL · Pending-1070)

Add a new `### 2026-06-23 — Visual-Behavior Suite Phase 1 (cheap-fragment family)` block under the **"Still opt-in (default-off) on purpose"** area, with this table (matches the existing `| Flag | What it does | Eye-test | Pass criteria |` format):

```markdown
### 2026-06-23 — Visual-Behavior Suite Phase 1 (cheap-fragment family) · NON-RETAIL · Pending-1070

All DEFAULT-OFF behind `?visual` + a per-effect flag; byte-identical render when off;
`vfx gauge --ref holtburg` STRUCTURAL-PASS (program count O(component-sets), Δlights=0).
Batched 1070 eye-test: see `docs/visual-behavior-suite-design-2026-06-23.md` Phase-1 checklist.

| Flag | What it does | Eye-test | Pass criteria |
|------|--------------|----------|---------------|
| **`?visual=on`** | Master gate for the auto-classified visual-behavior suite (catalog-driven per-DID components). Default OFF = frozen/byte-identical. | Toggle with any per-effect flag below | Suite active; off = identical. |
| **`?glint=on`** (with `?visual`) | emissive.glint — view+time specular sparkle on metal weapons. | Sweep camera over a sword/axe/mace | Sparkle on metal; off = identical; gauge green. |
| **`?tarnish=on`** | weathering.tarnish — patina + crevice darkening, per-instance age (hash). | Inspect metal weapons/fittings | Tarnish + per-object variation; off = identical. |
| **`?magicGlow=on`** | emissive.magicGlow — ambient self-glow on magic items (intensity floor ≤2.0; bloom halo free if `?bloom`). | A glowing magic item | Glow + optional halo; off = identical. |
| **`?enchantShimmer=on`** | emissive.enchantShimmer — de-phased pulsing emissive on enchanted gear (oscillator-driven). | Enchanted gear ~3 s | Per-instance pulse; off = identical. |
| **`?wetness=on`** | weathering.wetness — global rain sheen on up-faces (uWetness from weather). | Roam a storm (`?rain=on`) | Up-faces darker+glossier; off = identical. |
| **`?frost=on`** | weathering.frost — winter-zone lighten/desaturate + micro-sparkle (uFrost); mutually exclusive with wetness. | A cold/winter zone | Frost in cold zones, never co-wet; off = identical. |
| **`?flameFlicker=on`** | light.flameFlicker — torch/brazier .intensity jitter (intensity-ONLY, never count/`.visible` → no relink). | Watch a torch ~5 s | Flicker, zero toggle-hitch; off = identical. |
| **`?visualBudget=<pct>`** | Governor stub for the suite GPU budget (Phase-2 enforcement; parses now, advisory). | — | Parses; no behavior change yet. |
```

## Risks

- **Conservative program over-count (low).** Per-component `dProgramsPerDriver:1` summed per driver over-estimates a multi-frag SET (firewall collapses to 1 program/SET). **Fails safe** (only ever a false STRUCTURAL-FAIL, never a false pass) and is inert on the Holtburg ref today. Mitigation: the per-SET refinement is queued for Phase 2; documented in the rows' notes.
- **Record-signature change (contained).** `VfxGaugeResult` gained a positional `LightsDelta`. Both construction sites and the `Failure` factory use **named** args and were updated; the two consumers (REPL, JSON) were updated. Grep confirmed no other callers. Verified by a clean build.
- **`vfxGauge` G4 added (intended, not a risk).** A *new* gate can only newly-FAIL a future component that adds a light. That is the point (mirrors the JS `lightCountDelta==0` manifest enforcement); all current rows are `0`, so today it always passes — confirmed live (`lightsDelta:0`, G4 green).
- **Test path resolution (low).** The node test walks up ≤12 dirs to find `WorldBuilder.Terminal/VfxData/`; if the test is ever relocated outside the repo tree it throws a clear error rather than silently skipping. Robust to the current `external/holtburger/apps/holtburger-web/` nesting (verified).
- **Cross-slice coupling (coordination).** My cost-row **ids must exactly match** the registered component ids from slices 06/07/09/10/11 (`emissive.magicGlow`, `emissive.enchantShimmer`, `weathering.wetness`, `weathering.frost`, `light.flameFlicker`) — taken verbatim from the slice specs + design doc §3.1. If any slice renames its id, update the matching cost row (the gauge's `"missing cost rows"` fault will flag a mismatch loudly at integration — a feature, not a silent gap). Slice 16's audit should diff registered ids ↔ cost-row ids.
