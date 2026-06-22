# RESULTS — Shader-compile trim: 72-program sweep + implementation plan (2026-06-22)

> Executes `docs/HANDOFF-shader-compile-trim-72programs-2026-06-22.md`. Phase 0 (manifest)
> captured cold on the 1070; Phases 1–2 ran as the `shader-compile-trim-72` Workflow
> (72 Opus-4.8 per-program agents + a synthesis barrier); Phase 3 (this plan) is validated
> with a real 1070 A/B of the #1 lever. Baseline build = `a1ec6c20` on `origin/master`.

## Phase 0 — what the 72 programs actually cost (MEASURED, cold, 1070 ANGLE/D3D11)

Captured by hooking the GL context (`createShader`/`shaderSource`/`attachShader`/`compileShader`/
`linkProgram`/`getProgramParameter`/`getProgramInfoLog`) via `addInitScript` on a **fresh cold
profile**, `?quality=high&pvsRingRadius=10&lbCap=600&clouds=on`, then walking
`renderer.info.programs`. Artifacts: `shader-manifest.cjs`, `shader-manifest-full.json` (full
generated GLSL), `shader-manifest/manifest.json` (72-row slim) + `sources/` (144 GLSL files)
under `/mnt/wbterminal1/tmp/claude-scratch/terrain-realism/`.

- **72 programs, 100.3 s total link block** (handoff predicted ~98 s). **100% of it is `queryMs`**
  — the time inside the *first* `getProgramParameter`/`getProgramInfoLog` that forces the deferred
  D3D11 HLSL link. `compileShader` and `linkProgram` themselves are ≈0 ms. `KHR_parallel_shader_compile`
  present but `maxThreads=null` → links block, no background compile. This is the intrinsic wall.
- **Extreme skew:** rank0 = a 11-line-vert / 481-line-frag fullscreen pass at **25.9 s** (first-link
  driver warmup + heavy procedural-noise math — a *clouds* program), rank1 = 6.0 s (also clouds),
  then **36 `scene3d-surface-*` MeshStandard programs at 3.5–4.3 s each**; **median ≈ 18 ms** (most
  programs are cheap).

### Family breakdown (cold, clouds=on)

| programs | link ms | family |
|---:|---:|---|
| 44 | **59,568** | **object/building MeshStandardMaterial surfaces** (`scene3d-surface-*`, `paletted-*`) |
| 8 | 38,865 | clouds (takram, **gated `?clouds=on` — NOT on the default cold path**) |
| 4 | 641 | shadow/depth (MeshDepthMaterial) |
| 3 | 392 | sky/celestial (Bruneton + moons) |
| 2 | 371 | terrain ShaderMaterial (one shared program) |
| 2 | 308 | atmosphere fullscreen post (EffectPass) |
| 4 | 67 | fullscreen post (bloom/luminance/upsample/composite) |
| 4 | 27 | MeshBasic instanced unlit |
| 1 | 13 | nameplates |
| 4 | 0 | particles |

**Key reframing the sweep surfaced:** the 100.3 s figure was captured **with `clouds=on`**. Clouds'
38.9 s (incl. the 25.9 s rank-0 warmup) is **absent on the bare-default cold path** (clouds default
OFF). So the **real default-load budget ≈ 61 s, and ≈ 59.6 s of that is the single lit-surface
family.** Cutting surface-program cost is cutting essentially the whole default-path stall.

Why each surface program is ~4,330 frag lines: a `MeshStandardMaterial` whose physical BRDF is
**fully unrolled over the fixed light pool (6 dir + 32 point + 8 spot = 46 `RE_Direct*` sites)**,
each site carrying the `lightClampRetail` half-Lambert/clamp inline patch, plus log-depth
`gl_FragDepth` export, CSM, normal maps, POM, light-probe cubeUV IBL. Variants then **fork across 7
`onBeforeCompile` axes** (`materials.js:262` `_patchSetCacheKey` → `hb|d|c|p|l|a|b|f`) on top of
three.js's stock axes (num-lights, alphaTest, instancing, sidedness, …).

## Phase 1–2 — ranked levers (72-agent sweep → synthesis)

Two distinct levers: **(A) variant-collapse** (a fork `#define` → runtime uniform, so N programs
merge → fewer programs) and **(B) per-program-cost** (cheaper shader → lower link ms each). Ranked:

| # | lever | type | affected | risk | est. cold ms | note |
|---|---|---|---:|---|---:|---|
| 1 | **Shrink fixed light pool 32pt/8sp → 8pt/2sp** | per-prog | 41 | **low** | ~28,000 | ~halves the 46-way BRDF unroll on every lit surface; **flag already exists** |
| 2 | Hoist `lightClampRetail` out of per-light unroll + drop `l` axis | per-prog | 30 | low | ~14,000 | **overlaps #1** (same body) — not additive |
| 3 | Keep clouds default-OFF (prebake `.bin` noise if ever on) | per-prog | 8 | none | 0 | off the default path; excluded from budget |
| 4 | Collapse POM `p` axis → uniform + cap 64/16→24/8 | collapse | 14 | med | ~2,500 | merges p0/p1 surfaces + cheapens p1 |
| 5 | Collapse CSM `c` axis → `uCsmEnabled` uniform | collapse | 18 | med | — | merges c0/c1 surfaces (count, not ms) |
| 6 | Collapse `f`/`b` depth-bias axes → uniform | collapse | 4 | **none** | ~0 | 3-line patch shouldn't fork a program; free cleanup |
| 7 | Drop cubeUV light-probe IBL on opaque matte surfaces | per-prog | 30 | med | ~2,000 | some variants already have it dead (`USE_ENVMAP` undef) |
| 8 | Collapse instancing/sidedness forks (`FrontSide`) | collapse | 12 | med | — | one surface forks 4× on this alone |
| 9 | Strip inert shadow/probe defines on unlit/depth mats | collapse | 13 | **none** | ~0 | free program-count cleanup |
| 10 | Scope `logarithmicDepthBuffer` OFF for ortho-shadow + fullscreen-post passes | per-prog | ~6 | low | ~140 | log-z is inert there; restores early-Z |
| 11 | `#ifdef`-strip default-off terrain paths to active preset | per-prog | 1 | low | ~120 | terrain is one shared program |
| — | **Global `logDepth` removal on lit surfaces** | per-prog | 63 | **high** | ~4,000 | last resort; load-bearing for z-precision + floor bias |

**Headline:** lever #1. It is one constant, the flag (`?lightPoolSize`/`?lightPoolSpot`) already
exists (`lighting.js:566-571`), it keeps the pool **fixed-size** (so the spell-freeze relink fix
holds), and it targets ~59.6 s of the ~61 s default-path budget.

### Honest caveats (from the synthesis — do not ignore)

- **#1 and #2 overlap** (both shrink the same per-light body) → **NOT additive**; combined realistic
  win is **< ~42 s**, not 28+14.
- Many surface programs read `totalMs=0` because D3D11 served them bit-identically from its bytecode
  cache — their true cost is hidden, so **variant-collapse value is understated by raw ms**.
- **Cold-only.** Warm reloads hit Chrome's on-disk D3D11 program cache (~97 % idle); these trims do
  nothing warm. Weigh cold-r10 worth vs. accepting the one-time cost (PLAN-doc option 1).
- `logarithmicDepthBuffer` removal changes depth precision across the draw distance and is
  load-bearing for indoor floor coplanar bias + far z-fighting → **high risk**; only scope it off
  for passes where it's provably inert.
- The link-query block is **intrinsic** (checkShaderErrors=false already shipped, didn't fix). Trims
  reduce shader **complexity/count**; they do not unblock the query itself.
- **Every trim is a fidelity change** → ships behind a `?flag` **default-OFF** until a **batched**
  1070 eye-test (real ANGLE/D3D11; swiftshader can't validate link timing or z-fighting), then
  flips default-ON with `=off` escape. Never piecemeal.

## Phase 3 — implementation order + validation

**Order (each behind a flag, default-OFF until the batched eye-test):**

1. **#1 light-pool shrink** — change `LIGHT_POOL_DEFAULT_POINT`/`_SPOT` defaults (`lighting.js:570-571`)
   from 32/8 to 8/2 (flag already wired). *Validate first — see A/B below.*
2. **#6 + #9 free collapses** (none-risk): `f`/`b` depth-bias and inert unlit/depth defines →
   uniforms / stripped. Pure program-count cleanup, no visual change.
3. **#2 lightClamp hoist** — refactor `_installLightClampShaderPatch` (`materials.js:1379/1518`) to a
   single post-accumulation helper; drop `l` from `_patchSetCacheKey`.
4. **#4/#5 POM+CSM collapse** — uniform-gate, drop `p`/`c` from the cacheKey; cap POM loops.
5. Reassess remaining (#7 IBL, #8 sidedness, #10 logDepth scoping, #11 terrain `#ifdef`) against
   measured residual.

**Validation method (the success metric)** — the 3-arm cache-disambiguation probe from the PLAN doc:
**fresh Chrome profile per arm**, run-to-geometry-plateau, continuous full-fill profile, on the 1070
at r10 cold. Expect **program frag-line count ↓, total `queryMs` ↓, fillMs ↓**, and eye-test no
visual regression vs. baseline screenshots (batched on the 1070).

### A/B of lever #1 — MEASURED (1070, same-session, fresh cold profile per arm)

Harness: `shader-lever-ab.cjs`. Arm A = default (32 pt / 8 sp), Arm B = `?lightPoolSize=8&lightPoolSpot=2`.
Everything else identical (clouds=on, r10, quality=high).

| metric | A: base 32pt/8sp | B: lp8 8pt/2sp | delta |
|---|---:|---:|---:|
| heaviest surface `08000b47` — frag lines | 4431 | 2877 | **−1554 (−35.1 %)** |
| heaviest surface `08000b47` — link block | 4334 ms | 1058 ms | **−76 %** |
| lit-surface family — link block | 61,392 ms | 14,709 ms | **−46,683 ms (−76.0 %)** |
| total link block (all programs) | 102,377 ms | 34,370 ms | −68,007 ms (−66.4 %) |
| programs / surface programs | 77 / 44 | 72 / 39 | run-to-run variance |

**Verdict: lever #1 is validated and is the dominant default-path win.** The clean,
apples-to-apples signal is the *same* surface program in both arms (`08000b47`): cutting the pool
from 46 to 16 `RE_Direct` sites removed **1554 frag lines (−35 %)** and the D3D11 link fell
**−76 %** — i.e. **compile cost is super-linear in the unrolled instruction count**, so shrinking
the BRDF loop pays back more than proportionally. Across the surface family the link block dropped
**61.4 s → 14.7 s (−76 %)**, and the surface family is ~59.6 s of the ~61 s default-path budget.

**Honest confounds (do not over-claim the −68 s total):**
- Both arms ran `clouds=on`. The total-link delta is inflated because the **one-time first-link
  driver warmup** (~26 s in the manifest's rank-0) landed on a *different* program between arms — so
  the cross-arm *total* isn't fully attributable to the light pool. The **surface-family −76 %** is
  the attributable lever-#1 number.
- Surface program *count* differed run-to-run (44 vs 39 — which landblocks/objects materialized
  during the fill), so the family *sum* mixes "fewer lines/program" with "fewer programs". The
  per-program `08000b47` comparison controls for this and still shows −76 %.
- Cold-only (warm reloads hit the D3D11 bytecode cache). And this is a **fidelity change**: 8 point
  + 2 spot slots vs 32 + 8 — scenes with >8 nearby point lights (dense tavern candles, stacked spell
  glows) would drop the surplus. **The remaining gate is a batched visual eye-test on the 1070**
  (lp8 vs base in lit Holtburg interiors / night / spell effects) before flipping the default; the
  perf win is already proven.

**Recommended next step:** batched 1070 eye-test of `?lightPoolSize=8&lightPoolSpot=2` vs default in
worst-case lit scenes. If acceptable, flip `LIGHT_POOL_DEFAULT_POINT`→8 / `_SPOT`→2 default-ON with
the existing `?lightPoolSize`/`?lightPoolSpot` as the `=32/=8` escape. Then layer the free
none-risk collapses (#6, #9) and the lightClamp hoist (#2).

## Reproduce

- Manifest: `node shader-manifest.cjs` on the 1070 (`C:\Temp`), cold profile → `shader-manifest-full.json`.
- Sweep+synthesis: `Workflow({scriptPath: ".../shader-trim-workflow.js"})` — 72 agents + synthesis.
- A/B: `node shader-lever-ab.cjs` on the 1070 → `shader-lever-ab.json`.
- All under `/mnt/wbterminal1/tmp/claude-scratch/terrain-realism/`; full per-program analyses in
  `all-analyses.json`, ranked plan in `synthesis-plan.json`.
