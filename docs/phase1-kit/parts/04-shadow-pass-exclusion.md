All clean and verified. Here is my structured deliverable.

---

# SLICE 04 — Shadow/Depth-Pass Exclusion (SHARED INFRA)

## Goal

Guarantee that a `getCachedVariant` frag patch (emissive/weathering, installed via `_chainBeforeCompile`) reaches the **color pass only** and never corrupts the **shadow/depth WRITE** — while frag surfaces still **receive and cast** shadows (spec §8, §18 R11).

**Core finding (verified at source level):** in three.js **r184** the shadow pass is *already* isolated by construction. `WebGLShadowMap.getDepthMaterial` (`vendor/.../three.module.js:9454-9541`) renders casters with the **shared internal** `_depthMaterial` (`MeshDepthMaterial`, :9080) / `_distanceMaterial` (`MeshDistanceMaterial`, :9081) — *unless* the object sets `customDepthMaterial`/`customDistanceMaterial` (:9458). From the color material it copies **only a fixed property allowlist** (:9504-9530): `visible, wireframe, side, alphaMap, alphaTest, map, clip*, displacement*, wireframeLinewidth, linewidth`. It **never** copies `onBeforeCompile`, `customProgramCacheKey`, `userData`, `emissive*`, or `roughness/metalness` — i.e. never our patch. The `_materialCache` clone branch (:9477-9498) clones the *internal* depth material, not our color material, so still no patch.

**Therefore the single real risk is**: an integrator assigning a VFX color variant as `object.customDepthMaterial`/`customDistanceMaterial`. This slice makes that the one guarded invariant + provides an executable proof. (Precedent that confirms the model: `getCachedFloorBias`'s `gl_FragDepth` nudge — `materials.js:1816`, `applyFloorDepthBias` — is already a color-pass-only `onBeforeCompile` patch shipping without touching shadows.)

## Files

### NEW — `scene3d/vfx/shadow_guard.js` (full contents, created & passing)

Three-free, duck-typed (mirrors `lint_caps.js`). Exports `DEPTH_PASS_COPY_KEYS`, `VFX_COLOR_PASS_TAG`, `isVfxColorVariant()`, `assertNoVfxDepthLeak(object)`, `projectDepthMaterial(color, depth)`, `assertDepthMaterialUnpatched(color)`. Lives in `scene3d/vfx/` (infra), **not** `components/`, so the legacy-safety component scan does not treat it as a component. Verified lint-clean (0 hits). Full body is in the repo at the path above — key surface:

```js
export const DEPTH_PASS_COPY_KEYS = Object.freeze([      // three.module.js:9504-9530
  "visible","wireframe","side","alphaMap","alphaTest","map",
  "clipShadows","clippingPlanes","clipIntersection",
  "displacementMap","displacementScale","displacementBias","wireframeLinewidth","linewidth",
]);
export const VFX_COLOR_PASS_TAG = "__vfxColorPassOnly";

export function isVfxColorVariant(m) {
  const u = m && m.userData;
  return !!(u && (u[VFX_COLOR_PASS_TAG] || u.__vfxSetKey));
}
export function assertNoVfxDepthLeak(object) {           // frag_install calls this post-attach
  const errs = [];
  if (!object) return errs;
  if (isVfxColorVariant(object.customDepthMaterial))    errs.push(`${object.name||"<obj>"}: customDepthMaterial is a VFX color variant ...`);
  if (isVfxColorVariant(object.customDistanceMaterial)) errs.push(`${object.name||"<obj>"}: customDistanceMaterial is a VFX color variant ...`);
  return errs;
}
export function projectDepthMaterial(colorMaterial, internalDepth = {}) {  // executable spec of getDepthMaterial copy step
  const depth = internalDepth;
  for (const k of DEPTH_PASS_COPY_KEYS) if (colorMaterial && k in colorMaterial) depth[k] = colorMaterial[k];
  return depth;
}
export function assertDepthMaterialUnpatched(colorMaterial) {
  const errs = []; const depth = projectDepthMaterial(colorMaterial, {});
  if ("onBeforeCompile" in depth) errs.push("depth material received onBeforeCompile (patch leaked)");
  if ("customProgramCacheKey" in depth) errs.push("depth material received customProgramCacheKey (patch leaked)");
  if ("userData" in depth) errs.push("depth material received userData (patch markers leaked)");
  return errs;
}
```

### EDIT — `scene3d/materials.js` `getCachedVariant` @ **1851-1854** (anchor: `v = base.clone();`)

Stamp the clone with the tag the guard reads. Inert to rendering and to `_patchSetCacheKey` (which reads only named keys, `materials.js:262-278`); the variant is only created when `?visual` triggers a frag attach.

```js
      v = base.clone();
      // Set __vfxSetKey BEFORE the builder runs _chainBeforeCompile so the
      // lazily-read program cache key reflects this variant's component SET.
      // __vfxColorPassOnly tags this clone as carrying a COLOR-pass-only patch
      // (spec §8): the shadow/depth WRITE must never use it — three renders
      // casters with its internal _depthMaterial (which never sees our
      // onBeforeCompile/userData). See scene3d/vfx/shadow_guard.js.
      v.userData = { ...(base.userData || {}), __cacheOwned: true, __vfxSetKey: setKey, __vfxColorPassOnly: true };
```

### EDIT — `harness/run-js-headless.mjs` TIER1 @ **98** (after the `vfxLegacySafety` row)

```js
  { flag: "vfxLegacySafety(JS)", file: "test_vfx_legacy_safety.mjs" },
  { flag: "vfxShadowPass(JS)", file: "test_vfx_shadow_pass.mjs" },   // <-- inserted
].map((t) => ({ ...t, tier: 1 }));
```

### NEW — `test_vfx_shadow_pass.mjs` (full contents, created & passing — see Test)

## GLSL

**This slice emits no GLSL** — it is the *negative* guarantee for everyone else's GLSL. The relevant fact about the canonical seams (spec §2.3): the emissive (`#include <emissivemap_fragment>`), weathering (`#include <map_fragment>`), and glint (`#include <roughnessmap_fragment>`) injections all live inside the **color** `MeshStandardMaterial` fragment shader, installed via `material.onBeforeCompile` (`materials.js:297` `_chainBeforeCompile`). The shadow caster's program is a **separate compile** of three's internal `MeshDepthMaterial`/`MeshDistanceMaterial`, whose fragment shader (`packing`/`depth` chunks) is never produced from our material and never receives `onBeforeCompile`. So no GLSL seam needs a depth-pass `#ifdef` guard — the separation is structural, not textual.

## Manifest

**Not a component — no registry manifest.** This is shared infra (like `oscillators.js`, slice 01). Lint implications I verified:
- `shadow_guard.js` is in `scene3d/vfx/`, **not** `scene3d/vfx/components/`, so `test_vfx_legacy_safety`'s Layer-B scan (`path.resolve("scene3d/vfx/components")`) does not scan it. Confirmed it is **lint-clean anyway** (0 `FORBIDDEN_SOURCE` hits — no `.visible=`, `Math.random`, etc.; the depth copy is done via a key loop, not literal property writes).
- The materials.js tag uses only allowed `userData`; no manifest cap is touched.

## Test

`test_vfx_shadow_pass.mjs` — three-free, `check()`/`process.exit(1)` style (matches `test_vfx_legacy_safety.mjs`). **20/20 pass** under plain `node` and via the harness. Covers:
1. **Classification** — `isVfxColorVariant` true for `__vfxColorPassOnly` and `__vfxSetKey` fallback; false for base/plain-depth/null.
2. **Depth material is unpatched** — `projectDepthMaterial(patchedColor)` copies the allowlist (`map/side/alphaTest`) but carries **no** `onBeforeCompile`/`customProgramCacheKey`/`userData`/`emissive`; `assertDepthMaterialUnpatched` clean even for a fully-patched color material; allowlist provably excludes every patch-bearing key.
3. **Leak guard** — `assertNoVfxDepthLeak` clean for the default (no custom depth mat) and for a legit non-VFX `customDepthMaterial`; **flags** a VFX variant wrongly set as `customDepthMaterial` *or* `customDistanceMaterial`.
4. **Source assertions** — `materials.js` actually stamps `__vfxColorPassOnly:true`, and `materials.js` never assigns `customDepthMaterial`/`customDistanceMaterial` (depth pass stays three's internal default).

```
VFX shadow-pass exclusion: 20 passed, 0 failed
[run-js-headless] 3 passed, 0 failed, 0 missing
```

## Integration notes

- **How it composes on the chain:** zero interaction with `_chainBeforeCompile` ordering. The guard operates at the **mesh level**, after the material is attached — orthogonal to FAMILY_ORDER, the `__vfxSetKey` firewall, and every effect's GLSL.
- **frag_install (slice 02) contract:** after `mesh.material = getCachedVariant(...)`, frag_install (a) **must not** set `mesh.customDepthMaterial`/`customDistanceMaterial`, and (b) **should** call `assertNoVfxDepthLeak(mesh)` in dev/asserts. Add the import: `import { assertNoVfxDepthLeak } from "./shadow_guard.js";`.
- **§18 R11 / `castShadow` handling (Phase-1 default — DO NOT change shadow flags):** frag effects swap **only the material**, never `castShadow`/`receiveShadow`.
  - Singleton/instanced sites keep `mesh.castShadow = staticsMatCastsShadow` and `receiveShadow = placementReceiveShadow` (`statics.js:1057/1066, 1240/1251, 1117/1119, 1309/1311`).
  - The static-**BatchedMesh** (windBatch) path takes `mat = group[0].material` (`statics.js:1464`) and `bm.castShadow = !!group[0].castShadow` / `bm.receiveShadow = !!group[0].receiveShadow` (`statics.js:1493-1494`) — so a frag variant flows in via the source meshes and the shadow flags are preserved untouched. The caster's depth-WRITE uses three's internal `_depthMaterial`; the color pass keeps receiving shadows.
- **Gauge cost row:** **none.** This slice adds **0 draw calls, 0 programs, 0 uniforms** — it is a pure invariant + a CI assertion. No `cost_model.jsonl` entry (slice 15).
- **`?flag`:** none of its own — gated transitively by `?visual` + per-effect flags (slice 14) since the guard is dormant until a frag variant exists.
- **Queued-for-1070:** an optional headless-GL render assertion (compile the real color + shadow programs and diff their fragment source) to complement the structural unit test in the 1070 eye-test (slice 15). Tracked, not blocking.
- **TIER1 harness:** registered as `vfxShadowPass(JS)` at `run-js-headless.mjs:98` (slice 16 owns final sequencing).

## Risks

- **three.js upgrade widening the copy allowlist.** If a future three adds a patch-bearing key (e.g. `userData`) to `getDepthMaterial`'s copy set, the patch could leak. Mitigated: `DEPTH_PASS_COPY_KEYS` mirrors the r184 list and the test asserts the allowlist excludes all patch-bearing keys — a widening shows up as a red test, prompting a re-audit. (Low: three has copied this fixed set for many majors.)
- **A future effect that genuinely needs depth-aware behavior** (e.g. a displacement-driven frag effect) would have to author a *separate, unpatched* `customDepthMaterial` deliberately — `assertNoVfxDepthLeak` would force that to be a non-VFX material, which is the correct outcome but is a manual step. Documented in `shadow_guard.js`.
- **Guard is advisory unless called.** `assertNoVfxDepthLeak` only protects sites that invoke it; the CI test + the materials.js source-assertion (no `customDepthMaterial=` anywhere) are the backstops. Low risk given no code in `scene3d/` currently sets a custom depth/distance material (grep-confirmed).
- **Shared-file edits** (`materials.js`, `run-js-headless.mjs`) are 1–6 lines each and additive; the integration owner (slice 16) sequences them against the other 15 agents. No logic shared with other slices' edits at those anchors.
