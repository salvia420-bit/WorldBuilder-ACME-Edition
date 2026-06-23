I have everything I need. Here is my buildable spec for slice 01.

---

# Slice 01 — VisualComponent Interface Spec (BUILD SPEC)

**Scope:** the canonical `VisualComponent` contract + composition substrate so deformation / weathering / emissive / texture / particle components share ONE `_chainBeforeCompile` chain, ONE `uTime`, ONE shared uniform block — with program count bounded by *distinct component-sets*, never by instance count.

---

## Goal

Generalize the proven detail/CSM/POM patch-chain (`materials.js`) and the tree-wind shared-mixer player (`animated_scenery.js`) into one component model where:

1. **N components on one part-surface compose onto ONE cloned material → ONE WebGLProgram.** glint + tarnish + wetness on a sword = one patch chain, one link.
2. **The program-link key encodes only the component-SET (+ link-variant bits), never config, never per-instance state.** Config → uniforms; per-instance → an instanced attribute. This is the firewall against the project's #1 cold-load cost (`RESULTS-shader-link-landscape`) — `customProgramCacheKey` must stay coarse.
3. **MECH-A (CPU per-part keyframe, `animated_scenery.js`) and MECH-B/fragment (GPU patch, `materials.js`) coexist on one object** as orthogonal layers driven by one shared clock.
4. Lifecycle (`register`/`attach`/`tick`/`dispose`) maps 1:1 onto existing seams so the runtime stays "dumb" (reads tags, runs the chain).

---

## Design

### 0. The two-tier identity that prevents N² explosion

The whole spec hinges on separating three identities that today are conflated:

| Identity | Granularity | Controls | Mechanism |
|---|---|---|---|
| **Program key** (`customProgramCacheKey`) | per *component-SET* (+ link bits) | how many shaders LINK (cold-load cost) | `_patchSetCacheKey` (`materials.js:262`) extended with `__vfxSetKey` |
| **Clone key** (JS Map) | per `(surfaceDid, setKey, configKey)` | how many material OBJECTS exist (heap) | `getCachedVariant` (new, mirrors `getCachedFloorBias` `materials.js:1794`) |
| **Per-instance channel** | per instance | per-object phase / weathering age | `InstancedBufferAttribute aVfxHash` (or `uVfxHash` for singletons) |

> **Invariant (the firewall):** config scalars and per-instance hashes flow ONLY through uniforms / attributes. They MUST NOT appear in `customProgramCacheKey`. Programs ≈ distinct component-sets (~20–40 across the whole catalog), not 10k DIDs × instances. Verified mechanism: `_patchSetCacheKey` already reads boolean userData flags lazily at `setProgram` time (`materials.js:259-261`) — we append one more field, not a new scheme.

### 1. The component contract (pseudo-TS; implemented as plain JS objects — repo is `.js`)

```ts
type Family =
  | "deformation"   // MECH-B begin_vertex (or MECH-A routed elsewhere)
  | "weathering"    // fragment, after <map_fragment>
  | "emissive"      // fragment, totalEmissiveRadiance
  | "texture"       // fragment, sampler/UV
  | "particle";     // no shader — spawns emitters

type Mech = "A" | "B" | "frag" | "particle"; // routing hint (rule = slice 04)

interface VisualComponent {
  id: string;                 // stable, e.g. "emissive.glint" — sorted into setKey
  family: Family;
  mech: Mech;

  // ---- LINK-AFFECTING (goes into the program cache key) ----
  // Any bit that changes the GENERATED GLSL TEXT. Examples: "needs a 2nd
  // sampler", "recomputes normals". MUST be derivable from config WITHOUT
  // per-instance / per-config-scalar input. Return "" for none.
  linkVariant(config: Cfg): string;

  // ---- GLSL injection (frag/vertex components only) ----
  // Pure: same (config-shape) -> same text. Edits shader chunks at the
  // canonical seams below. NEVER reads per-instance values here.
  inject(shader: Shader, ctx: InjectCtx): void;

  // ---- uniform declaration ----
  // GLOBAL uniforms: assign the SHARED object by REFERENCE (VFX_GLOBALS.uTime).
  // CONFIG uniforms: fresh {value} set ONCE at clone build from config.
  declareUniforms(shader: Shader, config: Cfg, globals: VfxGlobals): void;

  // ---- per-frame (oscillators / MECH-A clip drivers); optional ----
  // Updates SHARED uniforms only. O(1). No per-instance, no per-material loop.
  tick?(dt: number, t: number): void;

  // ---- MECH-A only: produce the keyframe rig fed to buildSceneryAnimationClip ----
  buildClip?(parts: PartGeom[], config: Cfg): { frames: Float32Array; numParts; numFrames; fps };

  // ---- particle only ----
  spawn?(node, anchorPartIdx: number, config: Cfg, pm: ParticleManager): EmitterHandle[];

  // ---- legacy-safety manifest (consumed by slice 13 lint) ----
  reads:  ("dat" | "weenie" | "pos" | "heading" | "hash01" | "clock" | "drawState")[];
  writes: ("renderTransform" | "clonedUniform" | "partGroupTransform" | "emitter")[];

  defaults: Cfg;
}
```

```ts
// Created ONCE (module scope). Every patch references these BY REFERENCE so a
// single mutation/frame updates all programs (vs the O(N) tickTerrainUTime loop
// at loop.js:817). Same source: scene3d.frameTime.tsSec.
const VFX_GLOBALS = {
  uTime:    { value: 0 },                 // seconds, wall-clock
  uWindDir: { value: new THREE.Vector2(/*cos,sin of treeWindDir*/) },
  uWetness: { value: 0 },                 // weather manager (0..1)
  uFrost:   { value: 0 },
  uCamPos:  { value: new THREE.Vector3() }
};
```

### 2. The registry (`register`)

```js
// scene3d/vfx/registry.js  (new)
const VFX_REGISTRY = new Map();              // id -> VisualComponent
export function registerComponent(c) { VFX_REGISTRY.set(c.id, c); }
export function getComponent(id) { return VFX_REGISTRY.get(id); }
```

Each component module (`scene3d/vfx/components/glint.js`, …) calls `registerComponent(...)` at import. `trunk-canopy`'s `procMotion.windBend` is the first registration — it wraps the EXISTING `buildTreeWindClip` (`wind_rig.js:149`) as `buildClip`, proving the contract round-trips shipped code.

### 3. The set key — deterministic, order-independent (the link firewall)

```js
// Canonical family order so chained GLSL is deterministic regardless of
// descriptor order: deformation(vertex) -> weathering(diffuse) -> emissive ->
// texture -> particle(no-op for GLSL). Within a family, sort by id.
const FAMILY_ORDER = { deformation:0, texture:1, weathering:2, emissive:3, particle:9 };

function orderedFragVertComps(ids) {
  return ids.map(getComponent)
            .filter(c => c.mech === "B" || c.mech === "frag")
            .sort((a,b) => (FAMILY_ORDER[a.family]-FAMILY_ORDER[b.family]) || (a.id<b.id?-1:1));
}

// setKey = sorted ids + their link variants. NO config scalars, NO hash.
function componentSetKey(comps, config) {
  return comps.map(c => c.id + (c.linkVariant(config[c.id]) || "")).join("+");
}
```

Two objects with `{glint,tarnish}` and `{tarnish,glint}` → identical `setKey` → identical GLSL text → identical program. Two swords with `glint.strength` 0.4 vs 0.6 → identical `setKey` (strength is a uniform) → ONE program, possibly two clones (different `configKey`).

### 4. The clone cache — `getCachedVariant` (mirrors `getCachedFloorBias` exactly)

Add to the `MaterialCache` class (alongside `getCachedFloorBias` `materials.js:1794`):

```js
// materials.js  — new method on MaterialCache
getCachedVariant(surfaceDid, setKey, configKey, builder) {
  if (this.wireframeMode) return this._getCachedDouble(surfaceDid);
  const key = `${surfaceDid >>> 0}|${setKey}|${configKey}`;
  let v = this.vfxVariants.get(key);            // new Map in ctor
  if (!v) {
    const base = this._getCachedDouble(surfaceDid);
    v = base.clone();                            // CLONE shares textures (like 1779/1800)
    v.userData = { ...(base.userData || {}), __cacheOwned: true, __vfxSetKey: setKey };
    builder(v);                                  // installs each component's patch chain
    v.needsUpdate = true;
    this.vfxVariants.set(key, v);
    // reuse the insertion-order LRU eviction pattern from installPaletted (1873)
  }
  return v;
}
```

`builder(v)` runs, in `FAMILY_ORDER`, each component's `declareUniforms` + `_chainBeforeCompile(v, shader => comp.inject(shader, ctx))` — i.e. the EXACT pattern of `_installDetailShaderPatch` (`materials.js:398-444`). Because `__vfxSetKey` is set BEFORE `_chainBeforeCompile` (which installs `customProgramCacheKey` via `_installPatchSetCacheKey` `materials.js:281`), the key reflects the full set.

Extend `_patchSetCacheKey` (`materials.js:262`) by one line:

```js
function _patchSetCacheKey(material) {
  const u = material.userData || {};
  return "hb"
    + "|d" + (u.detailEnabled?1:0) + "|c" + (u.csmEnabled?1:0)
    + "|p" + (u.pomEnabled?1:0) + "|l" + (u.lightClampRetail?1:0)
    + "|a" + (u.__aoPatched?1:0) + "|b" + (u.__depthBiased?1:0) + "|f" + (u.__floorBiased?1:0)
    + "|v" + (u.__vfxSetKey || "");        // <-- the single firewall line
}
```

This one field makes program count = distinct component-sets (× three's own natural material variety), and is read lazily at `setProgram` so install order is irrelevant (the property's existing contract, `materials.js:259-261`).

### 5. The GLSL chain — canonical injection seams (all verified in-tree)

| Family | Seam (chunk) | What it edits | Evidence |
|---|---|---|---|
| varying decl | `#include <common>` (vtx+frag) | add `varying float vVfxHash; varying vec3 vVfxWorld;` | `materials.js:319,331` |
| deformation (MECH-B) | after `#include <begin_vertex>` | `transformed += displace(...)` (sum across deform comps) | `materials.js:325` |
| per-instance read | after `#include <begin_vertex>` | `#ifdef USE_INSTANCING vVfxHash=aVfxHash; #else vVfxHash=uVfxHash; #endif` | three sets `USE_INSTANCING` for `InstancedMesh` (`statics.js:1223`) |
| uniform decl | after `void main() {` (frag) | `uniform float uTime; uniform float uGlintStrength; …` | `materials.js:417,499` |
| weathering | after `#include <map_fragment>` | modify `diffuseColor.rgb` (post-palette — slice 08) | `materials.js:427` |
| emissive | after `#include <emissivemap_fragment>` | `totalEmissiveRadiance += …` | three std chunk; reuses `applyFloatLumDiffuse` path `materials.js:1238` |
| glint/spec | after `#include <roughnessmap_fragment>` | modulate `roughnessFactor` / spec | three std chunk |

Multiple deformations **sum** into `transformed`; multiple weatherings **chain-modify** `diffuseColor`; multiple emissives **accumulate** into `totalEmissiveRadiance`. All composition is additive/sequential at distinct seams → no conflict, deterministic given `FAMILY_ORDER`.

### 6. Per-instance channel (`aVfxHash`)

- **InstancedMesh path** (`statics.js:1223`): after building, attach
  `geom.setAttribute("aVfxHash", new THREE.InstancedBufferAttribute(Float32Array[count], 1))`,
  filling `hash01(guid)` / `hash01(setupDid^instanceHash)` (`wind_rig.js:199`) per instance. `USE_INSTANCING` (three-defined, already in three's program key) selects the attribute path — **costs us zero extra key bits**.
- **Singleton Mesh path** (`statics.js:1031`): no instancing; set `uVfxHash` as a per-node uniform. Singletons are few (LOD leaves / non-instanced), so a per-node material clone is acceptable; the `#else` branch above reads `uVfxHash`.

This is the ONLY per-instance channel. It never touches `customProgramCacheKey`.

### 7. Shared `uTime` + globals tick (O(1), not O(materials))

Because every patch assigns `shader.uniforms.uTime = VFX_GLOBALS.uTime` **by reference**, the frame tick mutates ONE object:

```js
// scene3d/vfx/tick.js (new) — called from loop.js
export function tickVfxGlobals(scene3d, dt) {
  const t = scene3d.frameTime?.tsSec ?? performance.now()*0.001;  // same src as loop.js:822
  VFX_GLOBALS.uTime.value = t;
  VFX_GLOBALS.uWetness.value = scene3d.weather?.wetness ?? 0;
  VFX_GLOBALS.uFrost.value   = scene3d.weather?.frost ?? 0;
  for (const c of VFX_REGISTRY.values()) c.tick?.(dt, t);   // oscillators (slice 07); handful
}
```

This is strictly cheaper than `tickTerrainUTime`'s per-material loop (`loop.js:826`) and removes the multi-clock risk (single source, per `loop.js:807`).

### 8. `attach` — the dispatcher (splits by mech; the coexistence proof)

```js
// scene3d/vfx/attach.js (new)
export function attachVfx(scene3d, node, surfaceDidByPart, descriptor, ctx) {
  const comps = descriptor.components.map(getComponent);
  const cfg   = descriptor.config;

  // (A) MECH-A: route to the SHIPPED shared-mixer player (animated_scenery.js).
  const mechA = comps.filter(c => c.mech === "A");
  if (mechA.length) routeMechA(scene3d, node, mechA, cfg);   // -> attachWindTrees-style (495)

  // (B) MECH-B + frag: ONE cloned material variant per part-surface.
  const fv = orderedFragVertComps(descriptor.components);
  if (fv.length) {
    const setKey = componentSetKey(fv, cfg);
    const configKey = quantizeConfig(fv, cfg);   // stable; -> clone key only
    for (const [partIdx, surfaceDid] of surfaceDidByPart) {
      const mat = scene3d.materialCache.getCachedVariant(surfaceDid, setKey, configKey, (v) => {
        for (const c of fv) {                    // FAMILY_ORDER already applied
          c.declareUniforms(/*captured in chain*/ null, cfg[c.id], VFX_GLOBALS);
          _chainBeforeCompile(v, (shader) => {
            c.declareUniforms(shader, cfg[c.id], VFX_GLOBALS);
            c.inject(shader, ctx);
          });
        }
      });
      node.partMeshes[partIdx].material = mat;   // bind the variant
    }
  }

  // (C) particle: spawn emitters on anchor parts (slice 09).
  for (const c of comps.filter(c => c.mech === "particle"))
    c.spawn(node, ctx.anchorPartIdx, cfg[c.id], scene3d.particleManager);
}
```

**Coexistence proof (MECH-A ⟂ MECH-B on the bow):** MECH-A's `stringHinge` writes the **part Group local transform** via the shared mixer template copy (`animated_scenery.js` template→instance copy, `:235`+). MECH-B's `limbFlex` writes `transformed` in the **vertex shader**. The vertex shader's `modelViewMatrix` already includes the MECH-A part-Group transform, so B's intra-part displacement composes ON TOP of A's rigid part motion automatically — no shared state, no ordering dependency, both read only `VFX_GLOBALS.uTime`. They cannot interfere because they write disjoint layers of the same pipeline.

### 9. `dispose`

- Material variants are `__cacheOwned` → freed by `MaterialCache.dispose()`/LRU (`materials.js:3331`, `installPaletted` LRU `:1873`). Add `vfxVariants` to the dispose walk (`_disposeEach`, `materials.js:3336`).
- MECH-A mixers are ref-counted + orphan-reclaimed by the shipped player (`animated_scenery.js` `refCount`/`_disposeDidGroup` `:562`).
- Particle emitters torn down by ParticleManager landblock eviction (slice 09/15).
- Components are stateless defs → nothing to dispose.

---

## Integration seams (file:line)

| Seam | Where | Change |
|---|---|---|
| Cache-key firewall | `materials.js:262` `_patchSetCacheKey` | append `|v + __vfxSetKey` |
| Chain mechanism (reuse as-is) | `materials.js:292` `_chainBeforeCompile`, `:281` `_installPatchSetCacheKey` | none — components call these |
| Patch-installer template | `materials.js:398` `_installDetailShaderPatch` | copy its uniform+chunk-replace shape |
| Clone-variant template | `materials.js:1794` `getCachedFloorBias`, `:1809` `_getCachedDouble` | add `getCachedVariant` + `vfxVariants` Map |
| Variant dispose | `materials.js:3336` `_disposeEach` in `dispose()` | add `this.vfxVariants` |
| Emissive reuse | `materials.js:1238` `applyFloatLumDiffuse` | emissive components reuse the `emissiveMap`+intensity path |
| Global uTime tick | `loop.js:817` `tickTerrainUTime` (pattern), call site `loop.js:1812` | add `tickVfxGlobals(scene3d, dt)` next to `tickAnimatedSurfaces` |
| MECH-A player (reuse) | `animated_scenery.js:127` `buildSceneryAnimationClip`, `:387` `getOrCreateWindGroup`, `:495` `attachWindTrees`, `:618` `tickAnimatedScenery` | `routeMechA` calls these |
| MECH-A rig (reuse) | `wind_rig.js:113` `buildBboxRig`, `:149` `buildTreeWindClip`, `:199` `hash01` | `windBend.buildClip` wraps these |
| Attach divert (precedent) | `statics.js:1593-1600` (treeWind peel), `:1846` `attachWindTrees` call | generalize peel → `attachVfx` per placement |
| Instanced attr | `statics.js:1223` `new THREE.InstancedMesh` | add `aVfxHash` InstancedBufferAttribute |
| Allowlist→descriptor | `tree_wind.js:64` `TREE_WIND_DIDS` | becomes a `visual_descriptors.jsonl` line for `trunk-canopy` |
| Shadow gate (consult) | `materials.js:123` `materialCanCastShadow` | depth-pass safety check (below) |

---

## Edge cases & legacy-safety check (per THE RULE)

- **Reads (allowed):** components read DAT geometry (`partBBox` `wind_rig.js:59`), weenie props, server pos/heading, `hash01(guid)` (`:199`), and `VFX_GLOBALS.uTime` (= `frameTime.tsSec`). The contract's `reads:` manifest is the machine-checkable declaration (slice 13 lints it). ✅
- **Writes (allowed):** only cloned-material uniforms (`getCachedVariant` clone — base never mutated, like `getCachedFloorBias` `:1801`), per-part Group transforms (MECH-A, on the non-rendered template), and synthesized emitters. NEVER wire/physics/replicated. The `writes:` manifest enforces this. ✅
- **No light-count change:** the contract has no light-creation surface; emissive components only modulate `emissiveIntensity`/`totalEmissiveRadiance` (`applyFloatLumDiffuse` path `:1246`), never `.visible`/count → no MeshStandard relink-freeze. ✅
- **No per-instance cache key:** `configKey`/`aVfxHash` are walled out of `customProgramCacheKey` by construction (§3 invariant). The only key contributor is `__vfxSetKey` (per-set). This is the explicit defense against the #1 cold-load cost. ✅
- **Shadow/depth pass:** fragment patches (weathering/emissive/glint) are inherently shadow-safe — three's shadow pass uses a separate `MeshDepthMaterial`, not our patched color material, so `diffuseColor`/emissive edits never reach depth. **Caveat:** MECH-B vertex displacement is NOT seen by the depth pass → displaced geometry casts undisplaced shadows. The contract carries an `affectsDepth` link bit; resolution (patch `customDepthMaterial` or accept) is deferred to slices 05/08. Consult `materialCanCastShadow` (`materials.js:123`) for eligibility. ⚠️ flagged, not in this slice.
- **DAT-hook coexistence:** if a SetupModel already self-animates (hooks 22/23/24), the dispatcher must NOT double-drive it — handled by slice 14; the contract exposes `mech` + the classifier self-label so `attachVfx` can skip. ✅ (cross-slice)
- **Byte-identical when off:** with no descriptor, `attachVfx` is never called and the frozen instanced path is unchanged (same guarantee as the `treeWindEnabled()` gate `statics.js:1594`). ✅

---

## GPU cost

- **Link cost (the budget that matters):** programs added = **distinct component-sets** present in the loaded world, ~20–40 worst case across the full catalog (vs 2,763 SetupDIDs / 10k models). At Holtburg ref (66 models) far fewer. Each `_chainBeforeCompile` adds zero programs beyond what `__vfxSetKey` distinguishes.
- **Per-frame CPU:** `tickVfxGlobals` = O(globals + registry size) ≈ O(1); strictly less than `tickTerrainUTime`'s per-material loop. MECH-A unchanged (one mixer per (setup,bucket), `animated_scenery.js`).
- **Per-frag ALU:** sum of each component's injected ops on the shared material — paid once per fragment regardless of instance count. Heap: one clone per `(surfaceDid,setKey,configKey)` (textures shared, like `:1779`).
- **Per-instance:** one float attribute (`aVfxHash`) per instance — negligible VRAM, zero draw-call change (still one InstancedMesh per surface, `statics.js:1223`).

---

## Build checklist (ordered, each step a concrete code change)

1. **`scene3d/vfx/registry.js`** — `VFX_REGISTRY` Map + `registerComponent`/`getComponent`; export `VFX_GLOBALS` (uTime/uWindDir/uWetness/uFrost/uCamPos as shared `{value}` objects).
2. **`scene3d/vfx/setkey.js`** — `FAMILY_ORDER`, `orderedFragVertComps`, `componentSetKey`, `quantizeConfig` (stable config→string, NEVER into program key).
3. **`materials.js:262`** — append `+ "|v" + (u.__vfxSetKey || "")` to `_patchSetCacheKey`.
4. **`materials.js`** (MaterialCache ctor + near `:1794`) — add `this.vfxVariants = new Map()` and `getCachedVariant(surfaceDid, setKey, configKey, builder)` cloning via `_getCachedDouble`, tagging `__cacheOwned`+`__vfxSetKey`, with the `installPaletted` LRU pattern (`:1873`).
5. **`materials.js:3336`** — add `this.vfxVariants` to the `dispose()` `_disposeEach` walk.
6. **`scene3d/vfx/attach.js`** — `attachVfx(scene3d, node, surfaceDidByPart, descriptor, ctx)`: split by `mech`; build frag/vertex variant via `getCachedVariant` + `_chainBeforeCompile`; bind to part meshes; call `routeMechA` and particle `spawn`.
7. **`scene3d/vfx/tick.js`** — `tickVfxGlobals(scene3d, dt)`; wire it in `loop.js` immediately after `scene3d?.materialCache?.tickAnimatedSurfaces?.(dt)` (`loop.js:1812`).
8. **`statics.js:1223`** — after `new THREE.InstancedMesh(...)`, attach `aVfxHash` `InstancedBufferAttribute` filled per-instance via `hash01` (`wind_rig.js:199`); guard the shader read with `USE_INSTANCING`.
9. **`scene3d/vfx/components/windBend.js`** — first component: `id:"procMotion.windBend"`, `family:"deformation"`, `mech:"A"`, `buildClip` = wrap `buildBboxRig`+`buildTreeWindClip` (`wind_rig.js:113/149`); reads `["dat","hash01","clock"]`, writes `["partGroupTransform"]`. `routeMechA` delegates to the shipped `attachWindTrees` (`animated_scenery.js:495`).
10. **Round-trip proof** — feed a `visual_descriptors.jsonl` with the 6 `TREE_WIND_DIDS` (`tree_wind.js:64`) as `trunk-canopy/[procMotion.windBend]`; confirm `attachVfx`→`routeMechA` reproduces today's `?treeWind=on` output byte-identically (the exit bar from Phase 0).
11. **One frag exemplar** (`scene3d/vfx/components/glint.js`, `family:"emissive"`, `mech:"frag"`) — declares `uGlintStrength` (config uniform) + references `VFX_GLOBALS.uTime` (shared ref); inject after `<roughnessmap_fragment>`. Verify two glint configs → 1 program, 2 clones (program-count assertion via `renderer.info.memory.programs`).
12. **Lint hook (stub for slice 13)** — assert every registered component has `reads`/`writes` manifests and that `linkVariant` output contains no digits derived from config scalars (firewall regression guard).
