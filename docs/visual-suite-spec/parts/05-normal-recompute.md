I have everything I need. Here's my buildable spec for the slice.

---

# Slice 05 — GPU Normal-Recompute Strategy for Displaced Vertices

**Pairs with:** MECH-B GPU vertex-displacement (slice 04). This slice owns *only* the lighting-normal correction that a `begin_vertex` displacement requires. It does **not** own the position displacement itself.

## Goal

When a MECH-B effect writes `transformed` in `#include <begin_vertex>` (`materials.js` `_chainBeforeCompile`, the seam already used by the wire-AO patch at `materials.js:324` and the POM TBN at `materials.js:801`), the lighting normal `vNormal` is **already stale** — three.js r184 computes it in `<normal_vertex>`, which runs *before* `<begin_vertex>`, from the **undisplaced** `objectNormal`. For small bends nobody notices; for large cloth/cape ripple the surface stays flat-lit and looks dead. This slice specifies **when to recompute** the normal, **which method**, **the exact GLSL injected**, and a **1070-measurable A/B**.

**Critical scoping fact (decides half the table):** MECH-A (tree-wind, `animated_scenery.js` + `wind_rig.js:149 buildTreeWindClip`) applies a **rigid per-part quaternion** to a part Group (`wind_rig.js:185-192`). A rigid rotation rotates that part's normals identically via the Group's `normalMatrix` — **three.js already does this for free**. So **MECH-A never needs normal recompute.** Normal staleness is *exclusively* a MECH-B (intra-part vertex displacement) problem. This slice only touches MECH-B materials.

## Design

### r184 vertex chunk order (the root cause)
```
<beginnormal_vertex>   // vec3 objectNormal = vec3(normal);  [+ objectTangent if USE_TANGENT]
<defaultnormal_vertex> // transformedNormal = normalMatrix * objectNormal
<normal_vertex>        // vNormal = normalize(transformedNormal)  [+ vTangent/vBitangent]
<begin_vertex>         // vec3 transformed = vec3(position);   ← MECH-B displaces HERE, too late
<project_vertex>       // mvPosition = modelViewMatrix * vec4(transformed,1.0)
```
**Consequence:** the *only* clean recompute seam is to perturb `objectNormal` **inside/after `<beginnormal_vertex>`**, so the stock `<defaultnormal_vertex>`/`<normal_vertex>` chunks propagate the corrected normal (and `vTangent`) to the fragment for free. This avoids hand-patching `transformedNormal`/`vNormal`/macro gates after the fact.

### One shared displacement function
The displacement body must be evaluated for **both** position (begin_vertex) and normal (beginnormal_vertex). Declare it **once** in `<common>` (vertex) so the two are guaranteed consistent and the body is authored in exactly one place:

```glsl
// injected into vertex <common> by the MECH-B installer (slice 04)
uniform float uTime;          // shared client wall-clock (scene3d.frameTime.tsSec)
uniform float uDispAmp;       // metres or radians — static, from descriptor config
uniform float uDispFreq;      // static
uniform float uDispOmega;     // static temporal rate
uniform vec3  uDispAxisObj;   // object-space bend/wave axis — static, from rig (wind_rig partBBox)
uniform float uDispPhase;     // per-INSTANCE phase = hash01(guid) — instanced uniform, NOT a #define

// Returns the OBJECT-SPACE displacement vector for an object-space point.
vec3 hbDisplace(vec3 p) {
  // example body: travelling sine sheet ripple (cloth-flutter)
  float u = dot(p, uDispAxisObj);
  float h = uDispAmp * sin(uDispFreq * u - uTime * uDispOmega + uDispPhase);
  return uDispAxisObj * h;
}
```
`begin_vertex` then does `transformed += hbDisplace(position);`.

### Strategy table (per effect)

| Effect (archetype) | Disp. gradient | **Strategy** | Why |
|---|---|---|---|
| tip-flex (spear/staff/wand) | tiny — near-rigid rotation of a thin 1D tip, `ampDeg≈1.5` | **SKIP** | a few-degree rotation of an almost-axial feature shifts the normal <2°; lighting error invisible. Vertex saved. |
| levitate-bob / soft-jiggle | pure translate / low-amp wobble | **SKIP** | translation does not change normals at all; tiny wobble is sub-perceptual. |
| breathing scale | uniform/near-uniform scale | **SKIP** (or analytic if anisotropic) | uniform scale leaves normal direction unchanged. |
| chain/pendulum (MECH-B catenary) | per-segment rigid-ish rotation | **SKIP** | each link rotates ~rigidly; the small intra-link bow is below threshold. |
| bow-limb flex | medium — limb bows through a known arc about the riser | **ANALYTIC** | bend is a known rotation `θ(axialCoord)`; rotating the rest normal by the same `θ` is 1 `sin/cos` pair, exact. |
| staff/wand whip (close) | small–medium 2-lobe | **ANALYTIC** at near LOD, **SKIP** at distance | analytic only where it reads. |
| **cloth/banner ripple** | **LARGE** — travelling sine, high spatial freq | **ANALYTIC** | a flat sheet's shading is *entirely* the wave slope; without it the banner is dead-flat. Analytic `dh/du = A·k·cos(...)` is exact and ~3 ALU. |
| **cloak/cape/robe flutter** | large, multi-octave / noisy | **FINITE-DIFFERENCE** | when `hbDisplace` is a sum of noise octaves whose analytic Jacobian is ugly, FD of the *same* function is the simplest correct path. |

**Rejected as default: screen-space normals** (`dFdx/dFdy` of view position in the *fragment* shader, i.e. three's `FLAT_SHADED` path). It is (a) per-**fragment** not per-vertex — wrong cost class for a fill-bound budget, (b) **faceted** — destroys the smooth shading organic cloth needs, (c) blind to the displacement function. Keep it only as a documented fallback for a single-quad hard-surface effect where flat shading is acceptable; not used by any archetype above.

### GLSL injected

**(A) ANALYTIC — sine sheet / bow-limb.** Inject after `<beginnormal_vertex>`, gated by a `#define` the installer adds:
```glsl
#include <beginnormal_vertex>
#ifdef HB_NORMAL_ANALYTIC
{
  float u = dot(position, uDispAxisObj);
  float dhdu = uDispAmp * uDispFreq * cos(uDispFreq * u - uTime * uDispOmega + uDispPhase);
  // height-field normal rule: tilt rest normal AGAINST the slope along the wave axis
  objectNormal = normalize(objectNormal - dhdu * uDispAxisObj);
  #ifdef USE_TANGENT
    objectTangent.xyz = normalize(objectTangent.xyz + dhdu * objectNormal);
  #endif
}
#endif
```
(For a 2-axis ripple add the cross-axis `dhdv` term; for bow-limb replace the body with `objectNormal = rotateAxis(objectNormal, hingeAxis, theta(axialCoord))` reusing the same `θ` as the position bend.)

**(B) FINITE-DIFFERENCE — cloak/noisy.** Re-evaluates the shared `hbDisplace` at two tangent neighbours:
```glsl
#include <beginnormal_vertex>
#ifdef HB_NORMAL_FINITEDIFF
{
  #ifdef USE_TANGENT
    vec3 t1 = normalize(objectTangent.xyz);
  #else                                   // stable basis, same trick as materials.js:814
    vec3 t1 = normalize(cross(vec3(0.0,1.0,0.0), objectNormal));
    if (length(t1) < 0.01) t1 = normalize(cross(vec3(1.0,0.0,0.0), objectNormal));
  #endif
  vec3 t2 = normalize(cross(objectNormal, t1));
  const float EPS = 0.01;                 // object-space metres — tune to mesh scale
  vec3 p0 = position            + hbDisplace(position);
  vec3 p1 = (position + EPS*t1)  + hbDisplace(position + EPS*t1);
  vec3 p2 = (position + EPS*t2)  + hbDisplace(position + EPS*t2);
  vec3 n  = normalize(cross(p1 - p0, p2 - p0));
  if (dot(n, objectNormal) < 0.0) n = -n; // preserve original facing
  objectNormal = n;
}
#endif
```

**(C) SKIP.** Inject nothing into `beginnormal_vertex`; only the begin_vertex displacement runs. Zero added cost.

### Cache-key: one bit per strategy, never per-instance
The strategy is selected by a `#define` (`HB_NORMAL_ANALYTIC` / `HB_NORMAL_FINITEDIFF`), so each strategy is a distinct compiled program — it **must** be reflected in `customProgramCacheKey` or two materials differing only by strategy collapse onto one program (the exact bug the comment at `materials.js:256-261` warns about). Extend `_patchSetCacheKey` (`materials.js:262`) with a small enum, **not** a per-instance value:
```js
// materials.js:262 _patchSetCacheKey — add:
"|n" + (u.hbNormalStrategy ?? 0)   // 0=skip 1=analytic 2=finitediff
```
Per-instance variance (`uDispPhase`, `uDispAmp`) flows through **uniforms / instanced attributes**, never the cache key — keeping `customProgramCacheKey` per-component-SET, per the binding constraint against shader-link explosion.

## Integration seams (file:line)

- **Inject point (vertex normal):** `#include <beginnormal_vertex>` — new `.replace()` in the MECH-B displacement installer; mirrors the existing `begin_vertex` patches at `materials.js:324` (wire-AO) and `materials.js:801-833` (POM TBN, which already reads `objectNormal`/`objectTangent` at vertex stage — proof those symbols are in scope at this seam).
- **Patch chaining:** `_chainBeforeCompile(material, hook)` `materials.js:292` — the displacement+normal installer registers through this so it composes with detail/CSM/POM.
- **Cache key:** `_patchSetCacheKey` `materials.js:262`; installer flips `material.userData.hbNormalStrategy` before chaining (same BEFORE-chain pattern as POM `materials.js:751-763`).
- **Shared `uTime`:** consume the same clock the suite's material-oscillator (slice 07) drives; wall-clock origin is `scene3d.frameTime.tsSec` / `performance.now()` per the design doc, fed via the `loop.js` per-frame material tick.
- **Fragment lighting (read-only reference):** corrected `vNormal` enters the fragment at `<normal_fragment_begin>`; nothing to patch there — the whole point of perturbing `objectNormal` early is that `<defaultnormal_vertex>`/`<normal_vertex>`/`<normal_fragment_begin>`/`<lights_fragment_begin>` (`materials.js:1444` references the stock chunk) all consume it untouched.
- **Strategy selection input:** descriptor `config["procMotion.*"].normalStrategy` (added to slice 02's schema) → installer; classifier (slice 03) can default it from archetype.

## Edge cases & legacy-safety check (THE RULE)

- **Reads:** only `attribute position/normal/tangent` (DAT geometry, static), config uniforms (static), `uDispPhase = hash01(guid)` (deterministic, `wind_rig.js:199`), and `uTime` (client wall-clock). **No server-replicated/mutable input.** ✅
- **Writes:** only the shader-local `objectNormal`/`objectTangent` → varying `vNormal`/`vTangent` (a render-time lighting input). The `BufferGeometry.attributes.normal` array is **never** mutated; nothing reaches the wire, physics, or collision BSP. ✅
- **Light count untouched** → no MeshStandard relink/freeze. ✅
- **`customProgramCacheKey` is per-strategy, not per-instance** → no shader-link explosion. ✅
- **Shadow/depth pass:** there is currently **no** `customDepthMaterial` in `scene3d/` (grep: none). The shadow pass uses stock `MeshDepthMaterial`, which **computes no lighting normals** — so this slice has *nothing* to patch there and cannot affect shadows. (If slice 04 adds a `customDepthMaterial` to apply the *position* displace for shadow consistency, that material must still **not** get the normal patch — depth output is normal-independent.) ✅
- **Double-sided / `flipped` normals:** the FD branch's `if (dot(n,objectNormal)<0) n=-n` preserves facing; analytic preserves it by construction (perturbation, not replacement). `<defaultnormal_vertex>` still applies three's double-side/instance-normal-matrix handling downstream. ✅
- **No-tangent geometry:** FD/analytic both have a `#ifndef USE_TANGENT` fallback basis (`materials.js:814` precedent). ✅
- **DAT self-animated objects (hooks 22/23/24):** out of scope here; slice 14 gates them before any MECH-B install — if it never installs displacement, no normal patch exists. ✅

## GPU cost

- **Recompute is VERTEX-stage.** The outdoor world is **CPU-bound ~20fps with GPU 30–50% idle** and **fill/fragment-bound**, never vertex-bound at these vertex counts (a banner is a few hundred verts; cloth a few thousand; a handful of unique drivers). Added cost:
  - SKIP: **0**.
  - ANALYTIC: ~3–5 ALU/vertex (`cos`, 2 mul, sub, `normalize`). If the displacement already computed `sin`, the `cos` is the only new transcendental.
  - FINITE-DIFFERENCE: **3× `hbDisplace` evals + 2 cross + normalize**. For a 3-`sin` body that's ~9 `sin` + adds — still trivial at vertex stage.
- **Scales with unique displaced-vertex count × unique drivers, not placements** (MECH-B = one shared program per `(model, strategy)`; per-instance is uniforms). Matches the §5.3 "cheap–medium, cap = unique-driver count" rule.
- **Net:** even FD is effectively free on the 1070 here; the cost gate that matters for these archetypes is fragment/fill (slices 10/11), not this. Prefer ANALYTIC where available purely for exactness, not cost.

## A/B plan (1070-measurable)

Reuse GROUND-4 harness: `renderer.info` (`render.calls/triangles`, `memory.programs`), `scene3d/diag.js` `window.__diag`, the perf-worker A/B harness, and `EXT_disjoint_timer_query_webgl2` for GPU-time where available.

1. **Scene:** spawn the Holtburg-ref banner/cloth set (or a synthetic N-banner grid) with MECH-B displacement ON.
2. **Conditions** (toggle the `#define` via the installer flag, fixed seed for `hash01`): `skip` → `analytic` → `finitediff`. Hold camera path + frame count identical (deterministic replay).
3. **Capture per condition:** median frame Δt (rAF), GPU timer-query ms, `renderer.info.render.triangles/calls`, and **`renderer.info.programs.length` (must be identical count across runs except the +1/+2 expected per distinct strategy program — verify NO per-instance program growth)**.
4. **Visual:** screenshot diff cloth under a steep directional light — `skip` shows flat banding across folds; `analytic`/`finitediff` show correct light/dark gradient. They should be visually near-identical to each other.
5. **Pass/fail:**
   - Frame-Δt delta `skip→analytic` and `skip→finitediff` **< 5%** of the idle GPU slice (expected well under, ~0.1ms).
   - `programs` count grows by **at most one per distinct strategy**, **zero per instance**.
   - `analytic` vs `finitediff` lighting within noise → **ship analytic** (deterministic/exact) wherever the displacement has a closed-form derivative; reserve `finitediff` for noisy multi-octave cloaks.
   - Any relink-stutter or program-count blowup → **FAIL**, audit the cache key.

## Build checklist

1. **`materials.js:262`** — extend `_patchSetCacheKey` with `"|n" + (u.hbNormalStrategy ?? 0)`.
2. **`materials.js` (new, near POM `:725`)** — add `_installVertexNormalRecompute(material, strategy)` (called by slice 04's `_installVertexDisplacePatch`): sets `material.userData.hbNormalStrategy` BEFORE `_chainBeforeCompile`; inside the hook, prepend `#define HB_NORMAL_ANALYTIC|FINITEDIFF` and `.replace("#include <beginnormal_vertex>", …)` with branch (A) or (B). For `skip`, no-op.
3. **Shared uniforms** — declare `uDispAmp/Freq/Omega/AxisObj/Phase` + `uTime` exactly once (in the displacement installer's `<common>` injection); the recompute reads them, adds none of its own.
4. **`hbDisplace` authoring** — ensure begin_vertex displacement and beginnormal_vertex recompute call the **same** `hbDisplace` (FD) or share the same `A/k/ω/phase` constants (analytic). One source of truth.
5. **Descriptor wiring** — add `normalStrategy: "skip"|"analytic"|"finitediff"` to `procMotion.*`/`deformation.*` config (slice 02); default from the strategy table; classifier (slice 03) sets cloth→analytic, cloak→finitediff, tip-flex/bob→skip.
6. **No-tangent guard** — verify the `#ifndef USE_TANGENT` basis fallback compiles on geometries lacking a `tangent` attribute (most AC statics).
7. **Shadow-pass assertion** — unit/lint test: the patch is installed only on the color material; any `customDepthMaterial` added by slice 04 carries the position displace but **not** `HB_NORMAL_*`.
8. **Cache-key test** — assert two materials with `analytic` vs `finitediff` get distinct `customProgramCacheKey()`, and two instances with different `uDispPhase` get the **same** key (legacy-safety regression for shader-link explosion).
9. **A/B run** — execute the plan above on the 1070; record the budget delta into the slice-11 cost table; flip cloth/banner archetypes' `normalStrategy` default to `analytic` once green.
