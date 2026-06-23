I have everything I need. Producing the buildable spec for my slice.

---

# SLICE 11 — GPU-Cost Model + `vfx gauge` — Build Spec

## Goal

Make "don't get greedy" **measurable and enforceable**. Deliver four artifacts a developer can build directly:

1. A **per-archetype GPU-cost table** (cheap/medium/expensive) with estimated/measured deltas in the four real cost axes the renderer exposes — draw-calls, shader-program links, ALU (vtx+frag ops), texture fetches/VRAM, and fill/overdraw.
2. The **per-frame ceiling formula** `GPU_budget = 0.75·T_frame − T_gpu_baseline`, derived from the CPU-bound reality (world ≈20 fps, GPU 30–50% idle on the 1070).
3. **Concurrency caps per cost class**, reusing the existing cap machinery (animSceneryMax 512, particle per-emitter caps, RP6 220 m cull) instead of inventing new ones.
4. The **`vfx gauge` measurement protocol**: a deterministic A/B on the 222-placement / 66-model Holtburg reference (`statics.js:37-44`) with explicit pass/fail gates, built on the *already-shipped* `window.__diag.render` snapshot (`index.js:269-307`) + the perf-walk harness (`harness/perf-walk.mjs`).

The cost model is the contract every other slice's effect must satisfy; `vfx gauge` is the CI/REPL gate that rejects an effect set that exceeds it.

---

## Design

### 0. What we can actually measure (the substrate)

Three measurement surfaces already exist and are reused verbatim:

| Surface | Where | Gives us |
|---|---|---|
| `window.__diag.render` | `index.js:269-307`, armed by `?renderDiag=on`, stamped each frame right after `renderer.render` (`index.js:2022`, composer path `:1941`) | `calls`, `triangles`, `programs`, `geometries`, `textures`, `sceneNodes`, `meshNodes` |
| `window.__diag.renderer` | `landblock_lru.js:460-490` | `peakPrograms`, `lastPrograms`, eviction-keyed program-count ring buffer (the shader-link trend) |
| `harness/perf-walk.mjs` | rAF frame recorder `:111-120`, 5 s poll `:160-179`, FPS/spike stats `:192-196` | `fps`, frame-ms `p50/p95/p99/worst`, spikes `>33/100/500 ms`, min/max/avg of every `__diag.render` field, JS heap, Chrome RSS |

**Two hard caveats that shape the whole design:**

- **No GPU timer in-tree.** `grep` for `EXT_disjoint_timer / TIME_ELAPSED / gpuTime` returns nothing. `renderer.render()` is async-submit — it returns after queueing GL commands, *not* after the GPU finishes. So "frame ms" (rAF Δ) ≈ `max(T_cpu, T_gpu)` under double-buffering, not `T_gpu`. The gauge must derive `T_gpu` explicitly (§3).
- **This box renders in SwiftShader (software GL)** — `perf-walk.mjs:13-16` says it plainly: absolute FPS/GPU are **not** representative of the 1070; *structural* metrics (calls, programs, triangles, textures, nodes, heap, spikes) and *functionality* ARE. ⟹ the gauge splits into a **Structural Meter** (hardware-independent, runs anywhere incl. CI) and a **Timing Meter** (1070-only).

### 1. Cost axes & the scaling invariant

Every effect's cost decomposes into exactly five renderer-observable axes:

| Axis | renderer.info field | What raises it |
|---|---|---|
| **Draw-calls** | `render.calls` | a new emitter batch; a new InstancedMesh node (one per model×surface). Material/vertex patches add **0**. |
| **Program links** | `programs.length` | a new `_patchSetCacheKey` variant (`materials.js:262-274`). **The #1 cold-load cost.** |
| **ALU** | (est.) | extra GLSL ops in `begin_vertex` (MECH-B) or post-`map_fragment` (weathering/emissive) |
| **TexFetch / VRAM** | `memory.textures` | extra sampler (medium effects), POM raymarch (expensive) |
| **Fill / overdraw** | (est. from particle counts) | additive transparent sprites (particles only) |

**THE SCALING INVARIANT (the rule the gauge enforces):**
> Cost scales with **unique drivers** — `(model × surface × patch-set)` materials and `(setupId × phaseBucket)` animation drivers — **NOT with placement count.** Holtburg has 222 placements but only **66 unique models** (`statics.js:37-44`) and 4 phase buckets (`animated_scenery.js:508`). Any effect whose Δprograms or Δcalls grows with *placements* is a FAIL.

This is why MECH-A (CPU mixer copy onto N instances) and fragment/vertex patches (shared instanced material) are cheap: they touch the handful of unique drivers, and the per-instance work is either a memcpy (MECH-A) or already-paid-for GPU lanes (MECH-B). Per-instance `customProgramCacheKey` is explicitly forbidden — it would make Δprograms scale with placements (the shader-link explosion, `materials.js:259-261`).

### 2. Per-archetype GPU-cost table

Deltas are **per unique driver** unless marked *(per visible instance)*. ALU buckets: `~`=≤8 ops, `+`=8–30, `++`=30–100, `+++`=>100. Estimates are gauge-refined on first build; structural columns (calls/programs/tex) are measured exactly on SwiftShader.

| # | Archetype | Class | ΔCalls | ΔPrograms | ΔALU vtx | ΔALU frag | ΔTexFetch | ΔVRAM | ΔFill | Scaling |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | trunk-canopy (SHIPPED) | cheap | 0 | 0 | 0 (CPU) | 0 | 0 | 0 | 0 | per (setupId×bucket) mixer |
| 2 | plant/reed whip | cheap | 0 | 0/+1ᴮ | 0/~ | 0 | 0 | 0 | 0 | per driver |
| 3 | tip-flex (spear/staff) | cheap | 0 | +1 | `+` | 0 | 0 | 0 | 0 | per model×surface |
| 4 | bow-limb | medium | 0 | +1 | `+` | 0 | 0 | 0 | 0 | +1 uniform/visible inst |
| 5 | cloth-flutter | medium | 0 | +1 | `++` | 0/`+`(normals) | 0 | 0 | 0 | per model×surface |
| 6 | worn-garment | medium | 0 | +1 | `++` | `+` | 0 | 0 | 0 | per model×surface |
| 7 | chain/rope sway | cheap | 0 | 0/+1ᴮ | 0/~ | 0 | 0 | 0 | 0 | per driver |
| 8 | sign swing | cheap | 0 | 0 | 0 (CPU) | 0 | 0 | 0 | 0 | per driver (MECH-A) |
| 9 | display-spin | cheap | 0 | 0 | 0 (CPU `_tickHookOmega`) | 0 | 0 | 0 | 0 | per inst (transform only) |
| 10 | levitate-bob | cheap | 0 | 0 | 0 (CPU tick) | 0 | 0 | 0 | 0 | per inst |
| 11 | idle-breath | cheap | 0 | +1ᴮ | `~` | 0 | 0 | 0 | 0 | per model×surface |
| 12 | soft-jiggle | cheap | 0 | +1ᴮ | `+` | 0 | 0 | 0 | 0 | per model×surface |
| 13 | rigid-glint | cheap | 0 | +1 | 0 | `+` | 0 | 0 | 0 | per material |
| 14 | metal-tarnish | cheap | 0 | +1 | 0 | `+` | 0 | 0 | 0 | per material (uniform) |
| 14r | rust-pitting | medium | 0 | +1 | 0 | `+` | +1 | +1 tex | 0 | per material |
| 15 | magic-glow ambient | cheap | 0 | 0* | 0 | `~` | 0 | 0 | 0 | reuses emissiveMap path |
| 16 | enchant-shimmer | cheap | 0 | +1 | 0 | `~` | 0 | 0 | 0 | per material |
| 17 | school-aura rim | cheap | 0 | +1 | 0 | `+` | 0 | 0 | 0 | per material |
| 18 | glowing-runes | medium | 0 | +1 | 0 | `+` | +1 | +1 tex | 0 | per material |
| 19 | gem-inner-fire | medium | 0 | +1 | 0 | `++` | 0 | 0 | 0 | per material |
| 20 | value-sheen | cheap | 0 | +1 | 0 | `~` | 0 | 0 | 0 | per material |
| 21 | glowing-eyes | cheap | 0 | +1 | 0 | `~` | 0 | 0 | 0 | per head-part material |
| 22 | holy/corrupt tint | cheap | 0 | +1 | 0 | `~` | 0 | 0 | 0 | per material |
| 23 | flow-scroll | cheap | 0 | 0* | 0 | `~` (map.offset) | 0 | 0 | 0 | uniform only |
| 24 | flame-flicker | cheap | 0 | 0 | 0 | 0 | 0 | 0 | 0 | light **intensity** only (no count) |
| 25 | fire-particle (ember+smoke) | medium | **+2** | 0 | – | – | – | +sprite tex | **high** | per visible brazier ×(≤cap) |
| 26 | foliage-ambient motes | cheap | +1 | 0 | – | – | – | +sprite tex | low | per visible canopy |
| 27 | water-context | medium | +2 | 0 | – | – | – | +sprite tex | med | per visible anchor (audit) |
| 28 | dusty-indoor | cheap+frag | +1 | +1 | 0 | `+` | +1 | +1 tex | low | per cell |
| — | wetness/frost | cheap | 0 | +1 | 0 | `+` | 0 | 0 | 0 | **1 global uniform** (all materials) |
| — | detail micro-grain (SHIPPED) | cheap | 0 | +1 | 0 | `+` | +1 | shared tile | 0 | per material |
| — | POM | **expensive** | 0 | +1 | `~` | `+++` (8–32 raymarch fetch) | +8..32 | +1 tex | 0 | high-tier gate + dist LOD |
| — | anisotropic | medium | 0 | +1 | 0 | `++` | 0 | 0 | 0 | per metal material |
| — | heat-haze | **expensive** | **+1 pass** | +1 | – | `+++` | screen tex | +1 RT | full-screen | hot+on-screen gate |

ᴮ = +1 program only if implemented via MECH-B (GPU); the MECH-A variant is 0.
\* = reuses the existing emissiveMap / `map.offset` path (`materials.js:1238 applyFloatLumDiffuse`) — no new patch-set key.

**Reading the table:** the entire cheap column is ~free at steady state — `ΔCalls=0`, `ΔPrograms` bounded by the count of unique base materials (≤ ~66 models × few surfaces), `ΔVRAM=0`. Medium = +1 texture and/or +1 program *per material*, still placement-independent. Only **particles** add draw-calls and fill (the real Holtburg-scale risk), and only **POM/heat-haze** add `+++` ALU — both already hard-gated behind quality tier.

### 3. The per-frame ceiling formula

```
T_frame      = steady-state wall-clock per frame (rAF Δ).  CPU-bound ⇒ ≈ 50 ms @ 20 fps.
T_cpu        = synchronous JS submit cost  = perf.now() around [tickPerFrame .. renderer.render]
               (index.js:1779 → 2012/2017)
T_gpu        = GPU completion cost (measured via fence/timer — see §4 protocol)
GPU_util     = T_gpu / T_frame                       (baseline ≈ 0.50–0.70 ⇒ 30–50% idle)

Under pipelining, T_frame ≈ max(T_cpu, T_gpu). Effects raise T_gpu only.
Effects are "free" while T_gpu < T_cpu (they fit the idle slice); they cost fps once T_gpu > T_cpu.

CEILING (the binding rule — keep a 25% margin for variance + next-gen GPU headroom):

    GPU_budget_per_frame  =  0.75 · T_frame  −  T_gpu_baseline
    Σ ΔT_gpu(all enabled effects)  ≤  GPU_budget_per_frame
    PASS iff  GPU_util_with_all_effects  ≤  0.75   at full-Dereth visible counts.
```

**Worked example (1070 calibration target):** `T_frame≈50 ms`, baseline `T_gpu≈25 ms` (50% util). Ceiling `T_gpu ≤ 37.5 ms` ⟹ **budget = 12.5 ms/frame** of added GPU for the *entire* suite at full Dereth. The gauge spends that budget cost-class-first: cheap effects consume ~0, particles + POM consume the bulk.

**Full-Dereth projection.** Gauge runs on Holtburg (222/66) where visible instances are small. Project to full Dereth by scaling only the *per-visible-instance* axes (particle emitters, MECH-B uniforms) by the full-Dereth visible-instance ceiling, which is itself bounded by the existing caps: animScenery ≤ **512** (`animated_scenery.js:45`), particle emitters by the RP6 **220 m** cull (`particle_manager.js:129`) + per-emitter cap **64/256/1024/2048** (`particle_emitter.js:168`). Per-driver axes (programs, per-material patches) do **not** scale with Dereth — that's the invariant. So projected `ΔT_gpu_dereth = ΔT_gpu_holtburg_perdriver + (visible_inst_dereth / visible_inst_holtburg) · ΔT_gpu_holtburg_perinst`.

### 4. Concurrency caps per cost class

Reuse existing machinery — do not invent new caps:

| Class | Cap rule | Enforcement seam |
|---|---|---|
| **cheap** | No instance cap — cap on **unique-driver count**. Δprograms must stay ≤ (unique materials + a small constant). | `vfx gauge` asserts `Δprograms ≤ K`; runtime cap is the natural model count |
| **medium** | Cap **concurrent visible instances**. MECH-B/material → bounded by `animSceneryMax=512` + `animSceneryRadius=140 m` (`animated_scenery.js:45,46,602`). Particles → RP6 220 m cull + per-emitter cap (`particle_manager.js:129`, `particle_emitter.js:168`). | reuse existing culls; add `?visualBudget=N` % governor (§5) |
| **expensive** | Hard-gate behind `quality.preset==='high'/'ultra'` (`quality.js`) + on-screen/distance test. POM already LOD-gated; heat-haze only when hot AND on-screen. | gate at effect install; gauge FAILs if expensive effect is default-on below high tier |

**Runtime budget governor (`?visualBudget=80`, default 80%):** a degradation ladder ticked in the same per-frame slot. If a rolling `GPU_util` estimate exceeds the threshold, shed effects in cost-class order **expensive → medium → cheap**, reusing the per-system culls (lower `animSceneryRadius`, drop emitter caps a preset, disable POM). This is the live analogue of the offline `vfx gauge` gate.

### 5. `vfx gauge` measurement protocol

`vfx gauge` is **two reconciled halves**:

**Half A — C# static estimator (`CommandEngine.Vfx.cs`, offline, deterministic, FAILs fast).**
1. Enumerate Holtburg-area DIDs from `dist/manifest.json` + statics/scenery jsonl + the `0xA9B40000.json` oracle.
2. Classify each (slice 03 classifier) → archetype → look up its row in the §2 cost table.
3. Sum: `Σ ΔPrograms`, `Σ ΔCalls`, `Σ ΔTexFetch/VRAM`, `Σ particle-fill`, weighting per-visible-instance rows by the Holtburg visible count (≤66 models, ≤222 placements, ≤512 anim).
4. Emit `{drawcalls, programsDelta, vramMB, particleEmitters, instanceCounts, vsCaps{...}, headroomPct}` and **FAIL if any cap is exceeded** before a single frame renders. This is the CI pre-flight; runs with zero GPU.

**Half B — browser empirical A/B (extends `perf-walk.mjs` → `harness/vfx-gauge.mjs`).** The deterministic differential:

```
STEP 0  Boot Holtburg, ?renderDiag=on&vfxGauge=on, autoSpawn=first, FIXED camera pose
        (deterministic, statics-only — NO entity movement, NO WASD), atmosphere=off
        (so __diag.render.calls/triangles count the WHOLE scene, not the post pass —
         caveat index.js:266-267).
STEP 1  BASELINE — all ?visual= effects OFF. Settle 60 frames. Record over 300 frames:
          structural: median __diag.render {calls,programs,triangles,textures,geometries}
          timing(1070): frame-ms p50/p95 (window.__perf), T_cpu, T_gpu  (see §6 instrumentation)
STEP 2  TREATMENT — enable the effect set under test (e.g. ?visual=archetypes). SAME pose,
        SAME frame count. Record the same vector.
STEP 3  DELTA = treatment − baseline, per axis.
STEP 4  PROJECT delta to full-Dereth visible counts (§3 projection).
STEP 5  Write report.json (mirror perf-walk.mjs:205-231) → reconcile against Half-A estimate.

PASS/FAIL gates:
  STRUCTURAL (runs on SwiftShader + CI — hardware-independent):
    G1  Δprograms is O(unique drivers), NOT O(placements):  Δprograms ≤ Kₚ  (e.g. ≤ 1.5×#materials).      [hard FAIL — the shader-link explosion guard]
    G2  ΔCalls per non-particle effect = 0;  particle ΔCalls ≤ (#visible emitters × 2).
    G3  ΔVRAM (Δtextures) ≤ medium-effect tex budget;  no per-instance texture growth.
    G4  No new program appears keyed per-instance (peakPrograms flat across a pan — landblock_lru.js:485).
  TIMING (1070 ONLY — skipped/marked N/A on SwiftShader):
    G5  Projected GPU_util_full_dereth ≤ 0.75.                                                            [hard FAIL — the ceiling]
    G6  frame-ms p95 regression ≤ 10% vs baseline at Holtburg.
    G7  spikes>100ms delta = 0 (no new compile hitch — guards against a per-instance relink slipping in).
  EXIT: green only if all applicable gates pass. SwiftShader run reports G1–G4 + "G5–G7: N/A (software GL)".
```

The `vfx gauge --ref holtburg [--quality high]` REPL/JSON command (slice 12 surface) shells Half-A immediately and returns its report; with `--measured` it also ingests the latest `vfx-gauge.mjs` report.json and cross-checks estimate-vs-measured (flags any archetype whose measured cost exceeds its table estimate by >2× → cost-table needs revision).

### 6. Gauge instrumentation (the only new runtime code)

Behind `?vfxGauge=on` (zero overhead otherwise, mirroring `?renderDiag` arming at `index.js:268-279`), wrap the render tick at the seam already identified:

```js
// index.js — around the tick body (1779 tickPerFrame … 2012/2017 renderer.render … 2022 recordRenderDiag)
const _g = window.__vfxGauge;                       // armed once like _renderDiagArmed
if (_g) _g.tCpu0 = performance.now();
tickPerFrame(liveScene3dRef, sessionHandle, dt);    // :1779   — CPU (mixer copy, material hooks, cull)
// … camera/layer setup …
renderer.render(scene, activeCam);                  // :2012/2017 — GPU submit (async)
if (_g) {
  _g.tCpu = performance.now() - _g.tCpu0;           // T_cpu (submit cost)
  if (_g.timer) {                                   // EXT_disjoint_timer_query_webgl2 if present
    /* read prior frame's elapsed query → T_gpu */
  } else if (_g.fence) {                            // fallback: gl.finish fence (perturbs — gauge-only)
    const gl = renderer.getContext();
    const t = performance.now(); gl.finish();
    _g.tGpu = performance.now() - t + _g.tCpu;      // crude: full-frame GPU completion
  }
  _g.push({ tCpu: _g.tCpu, tGpu: _g.tGpu, util: _g.tGpu / dt });
}
recordRenderDiag(renderer, scene);                  // :2022 — structural snapshot (unchanged)
```

GPU-time source preference: **(1)** `EXT_disjoint_timer_query_webgl2` if the context exposes it; **(2)** `gl.finish()` fence delta (stalls the pipe — acceptable in the gauge build only, never production); **(3)** if neither and SwiftShader, mark timing N/A and rely on the structural meter. This is the *only* place GPU-time enters the system.

---

## Integration seams (file:line)

| Seam | Location | Use |
|---|---|---|
| Render-diag snapshot | `scene3d/index.js:269-307` (fields `:296-302`) | the structural meter — read directly; **add nothing** |
| `?renderDiag` arming pattern | `scene3d/index.js:268-279` | clone for `?vfxGauge` arming |
| Render tick body | `scene3d/index.js:1779` (tickPerFrame) → `2012/2017` (renderer.render) → `2022` (recordRenderDiag) | wrap with T_cpu timer + T_gpu fence |
| atmosphere=off draw-call caveat | `scene3d/index.js:266-267` | gauge must set `?atmosphere=off` for true `calls`/`triangles` |
| Program-count trend | `scene3d/landblock_lru.js:460-490` (`peakPrograms` `:485`) | gate G4 (no per-instance relink across pan) |
| Perf harness (FPS/spikes/A-B) | `harness/perf-walk.mjs` (rAF `:111-120`, poll `:160-179`, stats `:192-231`) | fork → `harness/vfx-gauge.mjs` (fixed pose, effect-set A/B) |
| SwiftShader caveat | `harness/perf-walk.mjs:13-16` | drives the structural/timing meter split |
| Holtburg ground truth | `scene3d/statics.js:37-44` (222 placements / 66 models) | the reference denominator for the scaling invariant |
| Anim cap + cull | `scene3d/animated_scenery.js:45` (512), `:46`/`:65` (radius 140 m), `:508` (4 buckets), `:602` (cull) | medium-class concurrency cap |
| Particle caps | `particles/particle_emitter.js:61,168-182` (64/256/1024/2048), `particles/particle_manager.js:129` (220 m RP6) | particle-class fill/concurrency cap |
| Cache-key (link cost) | `scene3d/materials.js:262-274` (`_patchSetCacheKey`), `:282-284` (`customProgramCacheKey`), `:292-304` (`_chainBeforeCompile`) | G1/G4 — patch-set-keyed, never per-instance |
| GPU-tier probe | `scene3d/quality.js:206-207` (regexes), `:222` (`detectGpuTier`) | expensive-class quality gate |
| C# command home | `CommandEngine.Vfx.cs` (new partial) — REPL `TerminalRepl.cs`, JSON `JsonCommandProcessor.cs` | `vfx gauge` Half-A |

---

## Edge cases & legacy-safety check (per THE RULE)

The gauge itself must obey THE RULE — it's an instrument, not an effect:

- **Reads only static/derived + client clock.** Gauge reads `renderer.info` (render-time counters), `performance.now()`, and the cost table — all client-side, none server-replicated. ✅
- **Writes nothing replicated.** `?vfxGauge=on` adds a ring buffer on `window.__vfxGauge` and (in the fence fallback) calls `gl.finish()`. Neither touches a wire value, physics/collision, or replicated state. ✅
- **`gl.finish()` perturbs but cannot desync.** It stalls the CPU until the GPU drains — a timing artifact, gauge-build-only, never shipped default-on. It changes *when* frames complete, never *what* the server sees. ✅
- **Cache-key explosion is a gate, not a risk we create.** G1/G4 exist precisely to catch any *other* slice that violates the per-instance-key prohibition (`materials.js:259-261`). The gauge never installs a material.
- **Light count untouched.** Flame-flicker (row 24) is in the table as **intensity-only**; the gauge has no light path. ✅
- **Edge: composer post-pass undercount.** `__diag.render.calls/triangles` reflect the LAST pass; under the atmosphere composer that's the post pass (`index.js:266-267`). Gauge MUST run `?atmosphere=off` or it under-reports draw calls → false PASS. Hard-coded into the harness flag set.
- **Edge: SwiftShader false-green on timing.** If a CI run reported G5–G7 as PASS on software GL it would be meaningless. Mitigation: structural gates only on SwiftShader; timing gates emit `N/A (software GL)` and the overall verdict is `STRUCTURAL-PASS`, never `PASS`, until a 1070 run supplies G5–G7.
- **Edge: non-determinism.** Particle RNG / entity motion would make the A/B noisy. Mitigation: fixed camera pose, statics-only, no WASD, no entity spawns beyond autoSpawn; particle effects gauged with a seeded clock (`particles/time_rng.js`).
- **Edge: program count warm-up.** First-render shader compiles inflate `programs` transiently. Mitigation: 60-frame settle before recording (compiles complete), and G4 watches `peakPrograms` *delta across a pan*, not the absolute warm-up.

---

## GPU cost (of the gauge)

- **Default (`?vfxGauge` off):** zero — single armed-boolean check, identical to `?renderDiag` (`index.js:268-279`). No allocation, no GL call.
- **Armed structural meter:** `recordRenderDiag` already runs under `?renderDiag`; the gauge adds one `performance.now()` pair per frame (`T_cpu`) and a bounded ring-buffer push — negligible (<<0.1 ms).
- **Armed timing meter — timer-query path:** `EXT_disjoint_timer_query_webgl2` is near-free (async readback one frame late).
- **Armed timing meter — fence fallback:** `gl.finish()` serializes CPU↔GPU and can *double* effective frame time while active. This is **acceptable and gauge-only** — we want the stall to expose `T_gpu`; it never ships default-on.

The gauge is a measurement harness; its own cost is irrelevant to the budget it measures, provided it's never default-armed in production.

---

## Build checklist (ordered)

1. **`scene3d/index.js` — arm `?vfxGauge`.** Add `_vfxGaugeArmed` + `window.__vfxGauge` ring buffer, cloning the `_renderDiagArmed` regex pattern (`:268-279`). Zero cost when off.
2. **`scene3d/index.js` — instrument the render tick.** Wrap `tickPerFrame` (`:1779`) → `renderer.render` (`:2012/2017`) with the `T_cpu` `performance.now()` pair; after render, read `T_gpu` via timer-query-or-fence (§6) and push `{tCpu,tGpu,util,dt}`. Guard all of it behind `_vfxGaugeArmed`.
3. **`scene3d/index.js` — GPU-time source.** On gauge arm, try `renderer.getContext().getExtension('EXT_disjoint_timer_query_webgl2')`; else set `fence=true`; else `timing=N/A`. Store on `window.__vfxGauge`.
4. **`harness/vfx-gauge.mjs` — fork perf-walk.** Copy `perf-walk.mjs`; replace the WASD walk (`:147-159`) with a **fixed deterministic camera pose**, force `atmosphere=off`+`vfxGauge=on`+`renderDiag=on` into `FLAGS` (`:41-61`), and implement the two-phase A/B (baseline OFF → treatment with a parameterized `?visual=` set), 60-frame settle + 300-frame record each.
5. **`harness/vfx-gauge.mjs` — delta + gates.** Compute per-axis delta (median of `__diag.render` fields + `window.__perf` frame-ms + `window.__vfxGauge` T_cpu/T_gpu/util), evaluate gates G1–G7, mark G5–G7 `N/A` when `timing==='N/A'`. Write `report.json` (mirror `:205-231`).
6. **Cost-table data file — `cost_model.jsonl`.** Encode the §2 table as data (one row per archetype: class + the five Δ axes + scaling kind) so Half-A and the runtime governor read one source of truth.
7. **`CommandEngine.Vfx.cs` — `vfx gauge` Half-A.** Enumerate Holtburg DIDs (manifest + statics/scenery jsonl + `0xA9B40000.json`), classify (slice 03), sum cost-table rows weighted by Holtburg visible counts, compare to caps (512 / particle caps / program-K), return `{drawcalls, programsDelta, vramMB, particleEmitters, instanceCounts, vsCaps, headroomPct, verdict}`. **FAIL fast** before any GPU work.
8. **`CommandEngine.Vfx.cs` — `--measured` reconcile.** Add `--measured` flag: ingest the latest `vfx-gauge.mjs` report.json, cross-check measured-vs-estimated per archetype, flag any >2× divergence for cost-table revision.
9. **Register the command (two-tier).** REPL `Dictionary` in `TerminalRepl.cs` + JSON `Dictionary` in `JsonCommandProcessor.cs`, parsing `--ref`, `--quality`, `--measured` (slice 12 surface pattern).
10. **`?visualBudget=N` runtime governor.** In the per-frame tick (`loop.js` material-hook phase), maintain a rolling `GPU_util` from `window.__vfxGauge` (or a cheap proxy when unarmed) and shed effects expensive→medium→cheap by lowering `animSceneryRadius` / emitter caps / disabling POM when `util > N%`. Default 80.
11. **Calibrate on the 1070.** Run `vfx-gauge.mjs` baseline on a real GTX 1070 to fill `T_frame`, `T_gpu_baseline`, `GPU_util` into `cost_model.jsonl` header; lock the §3 budget constant (≈12.5 ms) from real numbers, not the worked-example placeholder.
12. **CI wire-up.** Add the SwiftShader structural-only run (G1–G4) to CI as a hard gate on any branch that registers a new effect; the 1070 timing run (G5–G7) stays a manual/nightly gate. A new effect cannot default-on until both are green.
