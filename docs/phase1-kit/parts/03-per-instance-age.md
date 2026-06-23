Everything is implemented and verified (24/24 test pass, no regression, firewall-clean). Here is my slice deliverable.

---

# Slice 03 — Per-Instance Variation for Frag Effects (`vVfxHash`)

## Goal

Give every Phase-1 frag effect (weathering age, emissive glint/shimmer phase) a **stable, per-object** pseudo-random float `vVfxHash ∈ [0,1)` — **without a per-instance shader program and without any geometry/instance attribute** — across all three static-mesh build paths (plain `Mesh`, `InstancedMesh`, `BatchedMesh`). The value rides the per-instance transform three *already* uploads, so program count stays O(component-SETs), never O(instances). This is the substrate that slices 05/07/08/13 read.

**Decision: PROCEDURAL, not an attribute.** Verified reasons (see Risks for the one caveat):
- `THREE.BatchedMesh` (statics.js `?staticBatch` path, r184) has **no first-class per-instance custom float attribute** — an `InstancedBufferAttribute aVfxHash` would never reach it. Procedural is the *only* mechanism covering `Mesh`+`InstancedMesh`+`BatchedMesh` uniformly (`statics.js:1035`, `:1227/1255`, `:1471/1479`, all confirmed to carry the shared variant material).
- Zero CPU: no buffer write, no allocation, no upload.
- **Firewall-safe by construction**: variation comes from per-instance matrix *data*, never the program; the module never names `customProgramCacheKey`. `USE_INSTANCING`/`USE_BATCHING` are already distinct three program layers (WebGLPrograms layers 0/18, verified `three.module.js:7865/7901`), so the `#ifdef` ladder adds **zero** new programs.

## Files

### NEW — `scene3d/vfx/per_instance.js` (full contents)

Pure string-surgery module, **no `three` import** (so it runs in any node test and never forces a WebGL context). Exports `ensureVfxHashVarying(shader)` (idempotent, called first inside each frag component's `inject`), `hasVfxHashVarying`, the GLSL constants, `VFX_HASH_VARYING="vVfxHash"`, and a JS reference port `vfxHash01Ref` for offline/eye-test use. *(File written & verified — key contract below; the on-disk file has the full rationale header.)*

```js
export const VFX_HASH_VARYING = "vVfxHash";
const VERT_GUARD = "vfxHash01";          // idempotency guard (vertex)
const FRAG_DECL  = "varying float vVfxHash;"; // idempotency guard (fragment)

export const VFX_HASH_PARS_VERTEX = [ /* varying + vfxHash01() — after #include <common> */ ].join("\n");
export const VFX_HASH_ASSIGN_VERTEX = [ /* #ifdef ladder — after #include <begin_vertex> */ ].join("\n");
export const VFX_HASH_PARS_FRAGMENT = [ /* varying — after #include <common> */ ].join("\n");

export function ensureVfxHashVarying(shader) {
  if (!shader || typeof shader.vertexShader !== "string" || typeof shader.fragmentShader !== "string") return shader;
  if (!shader.vertexShader.includes(VERT_GUARD)) {
    if (shader.vertexShader.includes("#include <common>"))
      shader.vertexShader = shader.vertexShader.replace("#include <common>", "#include <common>\n" + VFX_HASH_PARS_VERTEX);
    if (shader.vertexShader.includes("#include <begin_vertex>"))
      shader.vertexShader = shader.vertexShader.replace("#include <begin_vertex>", "#include <begin_vertex>\n" + VFX_HASH_ASSIGN_VERTEX);
  }
  if (!shader.fragmentShader.includes(FRAG_DECL) && shader.fragmentShader.includes("#include <common>"))
    shader.fragmentShader = shader.fragmentShader.replace("#include <common>", "#include <common>\n" + VFX_HASH_PARS_FRAGMENT);
  return shader;
}
```

The injection points were verified against the vendored r184 build: `batching_vertex` (declares `mat4 batchingMatrix`) precedes `begin_vertex` in **every** built-in vertex shader (confirmed programmatically), so reading `batchingMatrix` after `<begin_vertex>` is always in-scope; `instanceMatrix` is the `attribute mat4` declared under `USE_INSTANCING` (`three.module.js:6838`); `modelMatrix` is an always-present uniform.

### NEW — `test_vfx_per_instance_hash.mjs` (full contents)

Written & passing **24/24** under bare `node`. Covers: injection shape (both stages), ordering (assign after `<begin_vertex>`, PARS after `<common>`), the 3-branch mesh-type ladder, idempotency under repeat calls, bad-input tolerance, the **firewall** (comment-stripped CODE never references `customProgramCacheKey`; no `aVfxHash`/`InstancedBufferAttribute`), a `lint_caps.lintSource` clean scan of the module, and hash determinism/range/variety.

### SHARED EDIT (seam, not applied — file under concurrent sibling edits) — `harness/run-js-headless.mjs`

Add one TIER1 row. Anchor = the vfx block immediately before the array close (currently `harness/run-js-headless.mjs:100` — `].map((t) => ({ ...t, tier: 1 }));`). Insert after the last `vfx*(JS)` entry:

```js
  { flag: "vfxPerInstanceHash(JS)", file: "test_vfx_per_instance_hash.mjs" },
```

I deliberately did **not** edit this file — slices 01/02/04/05… all append here in parallel; slice 16's integration pass should land all TIER1 rows in one commit to avoid clobbering.

## GLSL (backtick-safe — no backticks anywhere, `//` comments only)

Vertex PARS — after `#include <common>`:
```glsl
// vfx:perInstanceHash (slice 03) — procedural per-object variety, no attribute, no per-instance program.
varying float vVfxHash;
float vfxHash01(vec2 p){
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
```
Vertex ASSIGN — after `#include <begin_vertex>` (batchingMatrix now in scope):
```glsl
#ifdef USE_BATCHING
  vVfxHash = vfxHash01(batchingMatrix[3].xy);
#elif defined( USE_INSTANCING )
  vVfxHash = vfxHash01(instanceMatrix[3].xy);
#else
  vVfxHash = vfxHash01(modelMatrix[3].xy);
#endif
```
Fragment PARS — after `#include <common>`:
```glsl
// vfx:perInstanceHash (slice 03) — per-object hash read by weathering/emissive.
varying float vVfxHash;
```
`vfxHash01` is Dave Hoskins' "hash without sine" (`hash12`) — chosen over `sin()`-based hashing because static-scenery world XY reaches thousands of units, where `sin()` loses mantissa precision and banding appears; the multiply-fract form stays stable on mediump.

## Manifest

This is **shared INFRA, not a registered component** — like slice 01's oscillator registry, it does not pass through `registerComponent`. It therefore has no manifest of its own, but it is the *provider* for the per-instance hash capability. The legacy-safety contract is honored two ways:

- **Mechanism caps (informational):** READS the per-instance render transform (`serverPose` — the read-only authoritative placement three uploads as `instanceMatrix`/`batchingMatrix`/`modelMatrix`); WRITES only a render-time varying on the **cloned** color material (`materialUniform` class). `deterministic: true` (pure function of placement, no clock, no `Math.random`); `lightCountDelta: 0`; `cacheKeyScope: "none"` (never touches `customProgramCacheKey`).
- **Consumer obligation (binding):** every frag component that reads `vVfxHash` (slices 05/07/08) **MUST** declare `"instanceHash"` in its `reads[]` — the per-instance hash is exactly what THE RULE calls `instanceHash`. That keeps `lint_caps.lintManifest` honest at the component level. The module source itself is `lintSource`-clean (asserted in the test), and because it lives at `scene3d/vfx/per_instance.js` (not `scene3d/vfx/components/*`) it is outside the harness's component scan — but it passes that scan anyway.

## Test

`node test_vfx_per_instance_hash.mjs` → `VFX per-instance hash: 24 passed, 0 failed`. Style matches the existing `test_vfx_*.mjs` (`check()` / `process.exit(1)`); no three / no WebGL dependency, so it runs standalone and under the headless harness once the TIER1 row lands. Existing `test_vfx_legacy_safety.mjs` still **17/17** (no regression).

## Integration notes

- **How it composes on the chain:** frag components call `ensureVfxHashVarying(shader)` as the **first line** of their `inject(shader, ctx)`. Under `materials.js` `_chainBeforeCompile`, all components in a SET run sequentially on the **same** `shader` object, so the first one injects the varying/function/assignment and the rest no-op via the guard. Declaration appears exactly once regardless of how many effects in the set read it. Order-independent (works whether glint runs before or after tarnish under `FAMILY_ORDER`).
- **Firewall (the headline):** the value flows through the per-instance matrix three already uploads — **never** the program. The module never names `customProgramCacheKey`; `__vfxSetKey` (the only program-cache discriminator, `materials.js:262/277`) is identical across plain/instanced/batched draws of a given SET. Program count = distinct component SETs, unaffected by instance count. Slice-16's gauge program-count check after each effect will confirm this stays flat.
- **Shadow/depth pass:** `ensureVfxHashVarying` only runs on the color material's `onBeforeCompile` chain. The depth/shadow material is a separate, unpatched object (slice 04 owns the exclusion). Even if it leaked there, a vertex varying that the depth fragment shader never reads — and that moves no vertex — is a no-op; depth stays byte-identical. Defense in depth, but slice 04 is the contract.
- **Gauge cost row:** per-instance hash = **+1 cheap varying, ~5 ALU/vertex, 0 draw calls, 0 textures, 0 programs** — placement-independent. Slice 15 should fold this into each *consuming* effect's row (it is not separately toggleable; it activates only when a frag effect is present), not as its own line item.
- **`?flag`:** none of its own — it is inert until a frag effect under `?visual` injects it. No URL flag, no default-on path.
- **Queued-for-1070:** (a) optional strict **world-space** hash (multiply per-instance translation by `modelMatrix` for rotated container nodes — not needed for static scenery, see Risks); (b) an `aVfxHash` `InstancedBufferAttribute` *opt-in fast path* only if a future effect needs a *baked, art-authored* per-instance value (e.g. hand-placed "this statue is ancient") that position can't express.

## Risks

- **Hash collisions across separate meshes:** two different `InstancedMesh`/`BatchedMesh` nodes whose local instance translations coincide would share a phase. In practice all three statics paths bake **world** placement into the matrix translation (`placementMatrix(group[i])` / `m.matrix`), and the container nodes are un-rotated, so `*Matrix[3].xy` ≈ distinct world XY. Worst case is two objects sharing a shimmer phase — cosmetic, never a correctness issue. *Mitigation if ever visible:* fold `modelMatrix[3].xy` into the input (queued-for-1070).
- **mediump precision:** at very large world coords the low bits of `vVfxHash` may differ across GPUs. Irrelevant — it drives *variety* (age/phase), not anything reproducible cross-client; it is client-only and never replicated.
- **Anchor coupling:** injection depends on stock `#include <common>` / `#include <begin_vertex>` / `<batching_vertex>` ordering. Locked to r184 (verified). If three is bumped, re-run this test — the ordering assert will catch a chunk reorder immediately. `ensureVfxHashVarying` fails *soft* (skips) if an anchor is missing rather than throwing.
- **Consumer discipline:** components must call `ensureVfxHashVarying` **before** emitting GLSL that reads `vVfxHash`, and must declare `"instanceHash"` in `reads[]`. Not mechanically enforced here — slice 16's audit should grep each component for `vVfxHash` ⇒ `instanceHash` in its manifest.
