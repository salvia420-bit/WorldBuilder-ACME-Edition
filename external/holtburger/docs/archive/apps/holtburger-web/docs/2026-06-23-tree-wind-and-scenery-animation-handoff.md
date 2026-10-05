# Handoff: scenery animation model + the path to wind-swaying trees (2026-06-23)

Goal stated: make the **parts of a tree move in response to "wind"**. Today a tree
in AC is one stagnant merged static mesh. This doc captures how statics / meshes /
frames / animations / motion actually work in holtburger-web, what the
2026-06-23 animated-scenery work does (and why it is NOT the tree answer), and the
concrete approach + integration points for wind.

Author context: written right after shipping the ambient-animation arc (butterflies
= Swarm trajectory fix; birds = sky Swarm chain; flags/foliage = per-part keyframe
`default_animation`). Commit `e5e3e733`.

---

## 1. AC's object / animation data model (the vocabulary)

DAT file types involved (prefix = high byte of the DID):
- **GfxObj `0x01`** — one renderable unit: a vertex array + polygons + a `surfaces`
  list (`0x08` Surface DIDs). A *single visual primitive*. No parts, no animation.
- **SetupModel `0x02`** — a *multi-part* object: a `parts` list (GfxObj DIDs), per-part
  **placement frames** (where each part sits), `default_animation` (0x03),
  `default_script` (0x33), `default_motion_table` (0x09), `default_script_table` (0x34).
  The last 5 default-DIDs are the final 5 u32s of the file (see `setup_model.rs`).
- **Animation `0x03`** — a per-part KEYFRAME clip: `num_parts`, `num_frames`,
  `part_frames[frame].frames[part]` = a **Frame** (AFrame) for each part at each frame.
- **Frame / AFrame** — `origin: Vector3` + `orientation: Quaternion`. **Quaternion is
  AC order `wxyz`** (THREE is `xyzw` — reorder on consume). The scene is **AC Z-up**
  (up = +Z), no handedness conversion needed in object space (statics.js anchors are Z-up).
- **MotionTable `0x09`** — stance/command → animation links (creature locomotion;
  not used by static scenery).
- **Surface `0x08` → SurfaceTexture `0x05` → Texture `0x06`** — the material chain.

Retail: `CPhysicsObj::InitDefaults` (acclient.c:320854; ace PhysicsObj.cs:662) plays a
Static object's `default_animation` every frame (`PartArray.Update`, PhysicsObj.cs:2031)
+ continuous `Omega` rotation. That is the ONLY built-in scenery motion in retail.

---

## 2. How statics/scenery are rendered TODAY (why trees are frozen)

Outdoor scenery + placed objects bake through `scene3d/statics.js`:
- `fetchAndDrainScenery` → `wasmExports.fetch_landblock_scenery(cellIds)` →
  `ScenicPlacementJs[]` (baked per-LB JSONL at `/dist/scenery/0xLLLL.scenery.jsonl`).
  Plus `fetch_landblock_objects` for LandblockInfo objects/buildings.
- `bakeStaticsForLandblock` / `bakeStaticsRing` → unique modelIds →
  `fetch_model_meshes` → `adapter.meshToGeometryGroups(wasmMesh)` → **per-SURFACE merged
  `THREE.BufferGeometry`** (`{groups:[{geometry, surfaceDid, doubleSided}], surfaceDids}`).
- Each surface group becomes a node; identical placements are merged into a
  **`THREE.BatchedMesh` / instanced** node (one draw per surface-model, N instances),
  tagged `userData.landblockId` for LRU eviction (`landblock_lru.js`).
- Materials: `materials.js MaterialCache.getCached(surfaceDid)` (lit MeshStandard-ish).

**Net: a tree is ONE merged, instanced, static BufferGeometry per surface, frozen.**
There are no per-part nodes (merge discards part boundaries) and no per-vertex motion.
Most trees are GfxObj `0x01` (single-part, **no `default_animation`**) — even the
2026-06-23 per-part path can't touch them (nothing to keyframe).

---

## 3. What the 2026-06-23 animated-scenery work does (and why it's not trees)

`scene3d/animated_scenery.js` (`?animScenery`, default-ON): for placements whose
SetupModel has a non-zero `default_animation` (0x03), it peels them out of the frozen
bake and builds **per-part nodes** driven by a `THREE.AnimationClip` (per-part
position+quaternion tracks from the new `fetchAnimation` export), with ONE shared
mixer/clip/template **per animation DID** (instanced: ~512 instances → ~4 mixers),
per-LB eviction, distance copy-cull, and interior (EnvCell) support. Wasm side:
`defaultAnimationId` getters (live-resolved from the SetupModel) + `fetchAnimation`.

This is **keyframe articulation of authored parts** — correct for flags/banners/
animated foliage that ship a `default_animation` (e.g. setup `0x02000493` →
animation `0x030006cb`, 2 parts × 90 frames). **Trees do not have `default_animation`,
so they're never peeled** → they stay frozen. Reusing this path for trees would
require authoring per-part clips for thousands of tree models (there are none, and
trees have no part skeleton). **Wrong tool for wind.**

---

## 4. The right approach for wind: PROCEDURAL VERTEX-SHADER displacement

Trees have no skeleton and no keyframes; the only approach that scales to a forest is
GPU vertex displacement in the tree material's vertex shader. No per-part nodes, no
per-instance mixers — works directly on the existing merged/instanced static geometry.

**Per-vertex displacement:** `worldPos += windOffset(worldPos, t) * weight(vertex)`.

Recommended two-band model (the standard "Crytek vegetation" shape):
1. **Whole-tree bend** — low-frequency: `bend = sin(t*f0 + dot(worldXY, dir)*phase) * strength`,
   applied along the wind direction, **weighted by height** (0 at trunk base → max at
   canopy) so the trunk root stays planted and the crown sways.
2. **Leaf/branch flutter** — high-frequency, low-amplitude jitter on the canopy verts
   (weighted by a secondary "leafiness" weight), gives the shimmer.

**Per-vertex weight — two options:**
- (A, recommended) **Bake a `windWeight` vertex attribute** at mesh-build time. In
  `adapter.meshToGeometryGroups` (or a post-pass in the bake), compute per-vertex
  `weight = smoothstep(zMin, zMax, vertexZ)` over the model's bbox (AC Z-up → Z is
  height). Cheap, precise, lets you author trunk-vs-canopy falloff. Add it as a
  `BufferAttribute("windWeight", 1)`.
- (B, zero-bake) derive weight in-shader from local height above bbox-min. Simpler but
  can't distinguish a tall tree's trunk from a bush.

**Injection:** patch the existing lit material via `material.onBeforeCompile` (insert
the displacement into the `#include <begin_vertex>` / before the model→view transform)
so shadows + lighting + fog stay intact. Share a `windUniforms = { uTime, uDir, uStrength }`
object across all tree materials; update `uTime` per-frame in `loop.js` (and `uDir`/
`uStrength` from wind state). **InstancedMesh/BatchedMesh:** read the per-instance world
position from `instanceMatrix` so each tree gets a distinct phase (otherwise the whole
forest sways in lockstep).

**Wind state source:** check `scene3d/weather_state.js` / `daygroup_weather.js` for an
existing wind vector (AC region weather). If none, synthesize a slowly-rotating global
wind + gusts; optionally couple gust strength to storm weather (the W1 weather
SkyObjects / `is_storm` already exist). Tie nothing to the server — purely client visual.

---

## 5. Tree identification (don't sway rocks/statues/buildings)

Only foliage should sway. Statics are not tagged "tree" today. Options, roughly in
order of robustness:
- A **tree-setup allowlist**: the region Scene's tree ObjectDescs / a curated DID set.
  `WorldBuilder/Data/object-tags.json` + `pipeline_data/enrichment/ace_world_setup_names.json`
  may help name scenery; the top scenery DIDs (`0x02001063` etc., from the
  `/dist/scenery/*.jsonl` frequency scan) are the trees/bushes — classify those.
- A **surface/material heuristic** (foliage surfaces are often alpha-clip leaf textures)
  — fragile.
- Gate behind a **`?treeWind=on` flag** (default OFF — this is an ENHANCEMENT, see §6)
  and a per-model classification map so it's opt-in + auditable.

---

## 6. Retail-fidelity caveat

AC retail trees are **static — they do NOT sway**. Wind-swaying is an *enhancement
beyond retail-fidelity* (unlike butterflies/birds/flags, which ARE retail-authored).
Ship it flagged (`?treeWind=on`, default OFF), document it as non-retail in
`docs/url-flags.md`, and keep it cleanly separable so a fidelity purist can disable it.

---

## 7. Concrete integration checklist

1. `adapter.meshToGeometryGroups` (or a bake post-pass in `statics.js`): emit a
   per-vertex `windWeight` attribute (Z-normalized over the model bbox).
2. `materials.js MaterialCache`: a `getTreeWind(surfaceDid)` variant (clone of the lit
   material + `onBeforeCompile` wind patch + shared `windUniforms`). Only tree models
   get it; everything else uses `getCached` unchanged.
3. `statics.js` bake: when the model is classified a tree AND `?treeWind=on`, paint its
   surface groups with the wind material. Geometry/instancing path is otherwise unchanged
   (no peeling — wind is per-vertex, works on the merged/instanced mesh).
4. `loop.js`: per-frame `windUniforms.uTime = nowS` (+ `uDir`/`uStrength` from wind state).
   Cheap (one uniform write); no per-instance CPU.
5. Wind state: read `weather_state.js` for a wind vector or synthesize; couple to storms.
6. Flag + docs: `?treeWind=on` (default OFF), `?treeWindStrength` / `?treeWindDir` tuning.

**Gotchas (learned this session):** scene is **Z-up** (height = Z); statics are
**instanced + LRU-evicted** (wind material must be cache-shared + survive eviction;
use `instanceMatrix` for per-tree phase); the bake **merges per-surface** (fine for
vertex wind — bake the weight at merge time); placements carry **varied scale/rotation**
(bend along world-up/world-horizontal, not the tree's local frame). The
`animated_scenery.js` keyframe path and this vertex-wind path are **orthogonal** —
keep them separate (flags use one, trees the other).

---

## 8. Pointers

- Statics bake: `scene3d/statics.js` (`bakeStaticsForLandblock`/`bakeStaticsRing`,
  `fetchAndDrainScenery`, `meshToGeometryGroups` usage, BatchedMesh).
- Geometry: `scene3d/adapter.js::meshToGeometryGroups`.
- Materials: `scene3d/materials.js` (`MaterialCache`, `getCached`).
- Eviction: `scene3d/landblock_lru.js` (matches `userData.landblockId`).
- Weather/wind: `scene3d/weather_state.js`, `scene3d/daygroup_weather.js`,
  `scene3d/sky_dome.js` (W1 weather SkyObjects, `is_storm`).
- This session's keyframe path: `scene3d/animated_scenery.js`, wasm `fetchAnimation` +
  `defaultAnimationId`/`StaticObjectPlacement.defaultAnimationId` in `src/lib.rs`.
- Project memory: `project_ambient_swarm_birds_butterflies_2026-06-23`.
