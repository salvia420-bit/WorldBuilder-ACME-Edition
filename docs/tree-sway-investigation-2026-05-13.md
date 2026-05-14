# Tree sway / wind — investigation findings (2026-05-13)

**Question:** can we add wind-driven tree sway to the holtburger 3D renderer, with branches swaying more than trunks, gentle ambient motion always on, and stronger motion in bad weather?

**Status:** scoping only. No implementation yet. Two decisions remain open (see §6).

---

## 1. What trees exist in AC

Scenery (foliage, props, signs) is rendered today via `external/holtburger/apps/holtburger-web/scene3d/statics.js`. In Holtburg's 9-landblock neighbourhood:

- ~225 placements / 66 unique `modelId`s
- Average 3.4 instances per model
- Pipeline: `fetch_landblock_objects(cellIds)` → filter `isBuilding === false` → fuse parts → instance when ≥2.

**The specific tree species (pine vs palm vs hardwood vs bush vs fern) are not labelled in our codebase yet.** The 66 IDs are an opaque mix of trees, signs, forges, lifestones, fireworks generators, etc. Naming the tree subset requires a DAT pass (e.g. `worldbuilder-terminal` lookup against the weenie/object DB) — small but not done.

What we know is in retail Dereth from prior surveys: conifer/pine, broadleaf/hardwood, palm (in southern regions like Yaraq), low bush, fern. Holtburg specifically is northern temperate so the local subset is mostly pine + hardwood + bush. Other landblocks will have a different distribution.

---

## 2. Geometric structure (the key constraint)

`statics.js` calls `meshToFusedGeometry()` per unique `modelId` and renders the result as one `THREE.Mesh` or `THREE.InstancedMesh`. **SetupModel part hierarchy is collapsed before reaching the GPU.** This is true regardless of whether the underlying SetupModel was authored as trunk + canopy parts or as a single mesh.

Consequences:

- **Branch-vs-trunk identity is not available at the renderer level today.** We can't ask "is this vertex a branch?" without changes.
- A **vertex-Z heuristic** (`sway *= smoothstep(treeMinZ, treeMaxZ, vPosition.z)`) works against the fused mesh without changing Rust/wasm. It needs per-instance AABB centroid + height, which we can compute once when the InstancedMesh is built.
- A **faithful part-based** approach (don't fuse trees, expose SetupModel parts through wasm, detect trunk by name or by lowest-Z part) is multi-day work and depends on retail SetupModel parts having meaningful names — which we have not verified.

PhatSDK / WorldBuilder.Terminal inspection of a representative tree SetupModel would tell us whether parts are named informatively. Not done yet.

---

## 3. Current render path (where a sway patch would land)

```
fetch_landblock_objects(cellIds)
  → filter isBuilding === false
  → fetch_model_meshes(uniqueModelIds)
  → meshToFusedGeometry(mesh)                        // parts → one BufferGeometry
  → materialCache.getCached(surfaceDid)              // PBR material
  → THREE.InstancedMesh (count ≥ 2) | THREE.Mesh     // optional THREE.LOD wrapping
  → scene3d.staticsGroup.add(...)
```

Files:
- `external/holtburger/apps/holtburger-web/scene3d/statics.js` — placement, fusion, instancing
- `external/holtburger/apps/holtburger-web/scene3d/materials.js` — material creation + shader patch composer
- `external/holtburger/apps/holtburger-web/scene3d/adapter.js` — `meshToFusedGeometry`, `placementToMatrix4`

The sway patch would attach in `statics.js` *after* `materialCache.getCached(did)` returns, mirroring how detail/CSM/POM patches already attach.

---

## 4. Weather system status — absent

There is **no wind, weather, or storm state** in AC data or in our codebase.

- `Region.dat` is partially decoded (skybox, DayGroup for day/night cycle, terrain codes) but not for weather. DayGroups carry sun/ambient/fog/cloud parameters per time-of-day, not a storm channel.
- `SkyObject.properties` bit `0x04` is `WEATHER_STREAK` — a visual hint that a SkyObject participates in rain/snow particle streaks, not a runtime "wind speed" value.
- ACE doesn't broadcast wind or weather state on the wire (verified across our network parser).
- PhatSDK reference: `GameSky::UseTime` was left unfinished by Turbine; no wind hook.

**Implication:** any weather-coupled wind has to be a client-side invention. Options sketched in §6.

---

## 5. Shader patch feasibility — yes

`materials.js` uses a `_chainBeforeCompile()` composer (lines ~178–186) that stacks multiple `onBeforeCompile` patches on a single material. Three existing patches compose cleanly today:

| Patch | Function | Approx location |
|---|---|---|
| Detail map | `_installDetailShaderPatch` | materials.js ~190 |
| CSM cascades | `_installCsmShaderPatch` | materials.js ~267 |
| POM | `_installPomShaderPatch` | materials.js ~517 |

A `_installTreeSwayShaderPatch(material, treeBoundsUniform)` would slot in identically. Vertex-shader injection point in three.js's `MeshStandardMaterial` is `#include <begin_vertex>` / `#include <project_vertex>` — used by every existing patch.

**Per-instance data** (each tree's centroid + height range, optional species ID) goes via `THREE.InstancedBufferAttribute` on the `InstancedMesh.geometry`, read in the vertex shader. We do not currently use instanced attributes (we use `setMatrixAt` for transforms only), so this is one new code path.

---

## 6. Open decisions (deferred per user 2026-05-13)

### 6a. Wind source

Three viable paths. None require server changes; all are client-side.

| Option | Effect | Cost |
|---|---|---|
| **Client weather state machine** (calm / breezy / stormy with slow random transitions or manual toggle) | Gives the "bad weather = strong wind" feel the user described | ~50 LoC for state + UI toggle |
| **Time-of-day driven** | Wind ramps at dawn/dusk, calm at midnight. No new state, but never feels stormy. | Trivial — read existing skybox time |
| **Always-on gentle sway only** | Constant low-amplitude ambient. No storms. | Simplest; loses the weather coupling |

**User has not chosen.**

### 6b. Trunk/branch fidelity

| Option | Result | Cost |
|---|---|---|
| **Z-height heuristic in shader** | Sway weighted by vertex height within tree AABB. Vase-shaped trees look good; palms look wrong (their trunk shouldn't move much but the entire crown should) | ~200–400 LoC, no Rust changes |
| **Expose SetupModel parts, detect trunk** | Faithful per-part sway. Trunk part rigid or low-amplitude, branch parts high-amplitude. | Multi-day. Requires Rust/wasm work to stop fusing for trees + plumb part hierarchy. Predicated on part names being informative (unverified). |
| **Hybrid (heuristic now, species profile later)** | Ship Z-heuristic, then add a per-`modelId` sway profile table (frequency, amplitude, canopy shape exponent) keyed to species, once species labels are known | Ships in two stages; the second stage depends on the §1 DAT-pass labelling step |

**User has not chosen.** Verbatim: *"we will wait before going further"*.

---

## 7. What I'd want to know before implementing

Listed for the next session:

1. **Label the tree subset of the 66 Holtburg scenery `modelId`s.** Without this, "per-species behaviour" is impossible and `?renderer=3d` will sway signs and forges in the wind if we blanket-apply.
2. **Inspect 2–3 representative tree SetupModels via WorldBuilder.Terminal** — multi-part or single? Are parts named? This determines whether the §6b "faithful path" is viable at all.
3. **Confirm whether the renderer should sway *only* tree IDs or all scenery.** Signs swaying gently in wind might actually look right; forges definitely should not.
4. **Pick wind source from §6a** so we know what time/weather signal to plumb into the shader uniform.

---

## 8. Bottom line

Sway is **technically feasible without any Rust changes** if we accept the Z-height heuristic and a client-fabricated wind signal. The shader-patch infrastructure is proven (detail/CSM/POM already compose on the same material) and the render path is single-funnelled through `statics.js` so there's exactly one place to inject.

The two real risks are:

- **Species labelling gap** — without it, we either sway everything (visually wrong on non-trees) or do nothing.
- **Palm-tree-shaped trees** — the Z-heuristic gets these wrong. Mitigation is a small per-species profile table, but that depends on the labelling step.

No code written. Waiting on decisions in §6.
