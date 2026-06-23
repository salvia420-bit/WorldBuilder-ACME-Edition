I have enough grounding. Writing my structured plan for task 13 (LOD + scale strategy).

---

## Assignment

**Task 13 — LOD + scale strategy for a forest of millions of placements.** One tree DID (`0x02001063`) has 317k placements; the per-part-node player caps at 512 near-field only; the BatchedMesh/InstancedMesh forest is the bulk. Define the near/mid/far tiers, the crossover thresholds + flags, how they wire into the existing ring driver / frustum cull / `consolidateStaticSingletons` / `landblock_lru` / the `animated_scenery.js` distance cull, and a perf-budget argument that wind cannot regress the CPU-bound ~20fps 1070 outdoor frame.

## Findings (file:line)

**Two render shapes for the forest, with opposite LRU lifetimes — this is the crux of the LOD design:**
- `scene3d/statics.js:1442` `consolidateStaticSingletons(nodes, outBatches)` — per-LB plain-Mesh singletons → one `THREE.BatchedMesh` per `surfaceDid` (batch key = `group[0].material`, `statics.js:1457`). Tagged `userData.landblockId` (`:1482`) → **LRU-evicted per LB**.
- `scene3d/statics.js:1220` (`buildInstancedNode`) — ring driver collapses duplicate `modelId`s (≥2 instances) into `THREE.InstancedMesh` per surface. Per LRU comment `landblock_lru.js:238-240`: **InstancedMesh nodes have NO `landblockId` and are skipped by eviction — they persist across the whole 13×13 ring.** The 317k DID renders here.
- Material identity is the batch/instance key. To stay batched, a wind material **must be shared per `surfaceDid`** (one clone, not per-instance).

**The per-part player is per-instance-CPU bound — why it can't be the forest path:**
- `scene3d/animated_scenery.js:43` `DEFAULT_MAX_ANIMATED = 512`; `:44` `DEFAULT_TICK_RADIUS_M = 140.0`.
- `:406-424` the rAF **copies** per-part `position`/`quaternion` onto each live instance every frame (`inst.parts[j].position.copy(...)`). `:416` distance tick-cull: instances beyond `radSq` are skipped (frozen). This per-instance CPU copy is exactly what caps it at 512 + 140m. Extending it to 317k = frame death.
- `:402` camera read: `window.liveScene3d?.camera || window.liveScene3d?.activeCamera`.

**Existing LOD axis (geometry) is separate from the wind axis (material):**
- `scene3d/statics.js:194` `LOD_DISTANCE_M = 100.0`. `THREE.LOD` wrappers at `:1071` (singleton) and `:1277` (instanced), with degraded leaves added at `swapDists[li]` (`:1128`, `:1316`). **`THREE.LOD` picks one level per NODE by bounding-sphere distance — too coarse for a ring-spanning InstancedMesh.** Per-instance distance LOD must therefore live in the vertex shader, not in `THREE.LOD`.

**Divert seams + attach (mirror these for any hero-tree peel):**
- `statics.js:1580-1587` (per-LB) and `:2085-2092` (ring): peel `defaultAnimationId != 0` out of `statics`, store in `animatedStatics`. Attach at `:1829-1831` and `:2363-2364` (`attachAnimatedScenery(scene3d, animatedStatics, wasmExports)`).

**Per-frame uniform-push pattern to copy (this is the whole CPU cost of the bulk wind):**
- `scene3d/loop.js` `tickTerrainUTime(scene3d)` (~line 818): iterates `scene3d.terrainMaterials`, writes `mat.uniforms.uTime.value = scene3d.frameTime.tsSec`. Called from `tickPerFrame` (`loop.js:1507`). Camera for a `uCamPos` uniform: `scene3d.cameraSwitcher?.activeCamera ?? scene3d.camera` (`loop.js:1715`).

**Cull/visibility already handles trees — wind rides it:** `tickFrustumCull` (`culling.js`, wired in `loop.js:59,81`) and the 13×13 ring driver + 3×3 always-resident floor (`landblock_lru.js:172`). Wind changes no visibility.

## Concrete coding steps (ordered)

### Tier model (the decision)

| Tier | Range | Render path | Per-instance CPU | Motion |
|---|---|---|---|---|
| **T0 hero** (opt-in) | 0–140 m, capped ≤128 | per-part rig via `animated_scenery.js` player | yes (bounded by cap + 140 m copy-cull) | articulated branch sway |
| **T1 near/mid** (default) | 0–`uFarFade` | **wind material on existing InstancedMesh/BatchedMesh** | **zero** | two-band shader bend, per-instance phase |
| **T2 far** | > `uFarFade` | same node, amplitude faded to 0 in vertex shader | **zero** | frozen (imperceptible) |

The default (`?treeWindLod=shader`) is **100% shader on the bulk path — no peel, no cap risk, scales to 317k.** Hero is a separate opt-in overlay. This is the only design that satisfies "uniform-only updates, no per-instance CPU on the bulk."

**Step 1 — Default tier = shader on the bulk, with per-instance distance LOD in the vertex shader (JS-only).**
The crossover from T1→T2 is **not** a `THREE.LOD` swap (too coarse for a ring-spanning InstancedMesh) and **not** a CPU pass. It is an amplitude fade computed per-vertex from the instance's own world position:
- `materials.js` `getTreeWind(surfaceDid)` (task 05) injects, before `begin_vertex`:
  ```glsl
  // instance origin in world space:
  //   InstancedMesh -> instanceMatrix[3].xyz; BatchedMesh -> getBatchingMatrix()[3].xyz
  vec3 instWorld = (modelMatrix * instanceMatrix[3]).xyz;
  float d = distance(instWorld, uCamPos);
  float lod = 1.0 - smoothstep(uLodNear, uLodFar, d);   // 1 near, 0 far
  float amp = uStrength * lod;
  // ... two-band displacement scaled by amp ...
  ```
- `uLodNear` default 140 (= `animSceneryRadius`), `uLodFar` default 380. Beyond `uLodFar`, `amp == 0` → vertex is at rest → **byte-identical to frozen geometry**. Zero CPU, one draw call, full forest.
- **Classification:** JS-only. No new wasm export. Reuses the existing InstancedMesh/BatchedMesh the forest already builds.

**Step 2 — Bind the wind material to tree surfaces at the two build sites (JS-only).**
- `statics.js:1220` (`buildInstancedNode`): when `treeWindEnabled()` and `TREE_DID.has(modelId)`, resolve `mat = materialCache.getTreeWind(surfaceDid)` instead of `getCached(surfaceDid)`. One shared clone per surface keeps `addInstance` batching intact (instances of the same surface still share one material → one draw call).
- `consolidateStaticSingletons` (`statics.js:1457`): batch key is `group[0].material`. Because `getTreeWind` is cached per surface, all tree meshes of a surface already carry the **same** material object → they batch normally. No change to the consolidation loop itself; the material was swapped upstream at singleton-build time (`buildSingletonNode`, `statics.js:~999`). Add the same `TREE_DID`+flag gate there.
- **Classification:** JS-only.

**Step 3 — Register wind materials + per-frame uniform push (JS-only), mirroring `tickTerrainUTime`.**
- In `materials.js`, `getTreeWind` appends each new clone to `scene3d.windMaterials` (a `Set`) and shares one `windUniforms` object (`{uTime,uDir,uStrength,uCamPos,uLodNear,uLodFar}`).
- In `loop.js`, add `tickTreeWindUniforms(scene3d)` next to `tickTerrainUTime` (~`loop.js:818`) and call it from `tickPerFrame` (`loop.js:1507`):
  ```js
  function tickTreeWindUniforms(scene3d) {
    const u = scene3d.windUniforms; if (!u) return;
    u.uTime.value = scene3d.frameTime?.tsSec ?? performance.now()*0.001;
    const cam = scene3d.cameraSwitcher?.activeCamera ?? scene3d.camera;
    if (cam) u.uCamPos.value.copy(cam.position);
    // uDir/uStrength fed by wind-state module (task 12)
  }
  ```
- **Cost = O(1) uniform object) per frame** (uniforms are shared, not per-material — though even per-material is O(tens of surfaces)). This is the entire bulk-wind CPU cost.
- **Classification:** JS-only.

**Step 4 — Hero T0 overlay (opt-in `?treeWindLod=hero`), bounded by a count guard (JS-only).**
- Add a parallel peel beside the `animatedStatics` peel (`statics.js:1582` / `:2087`):
  ```js
  let heroTrees = null;
  if (treeWindEnabled() && treeWindLod() === "hero") {
    // ONLY peel low-count tree DIDs (named/landblockinfo trees, or per-LB
    // tree count < HERO_PEEL_MAX) so we never strip a 317k DID into the
    // 512-cap player and make 316.5k trees VANISH.
    const peel = statics.filter(p => TREE_DID.has(p.modelId) && heroEligible(p));
    if (peel.length) { heroTrees = peel; statics = statics.filter(p => !peel.includes(p)); }
  }
  ```
- Attach via a new `attachWindTrees(scene3d, heroTrees, wasmExports)` (task 01/03) that drives the existing shared-mixer player with a synthetic bbox-rig clip. The player's `animSceneryMax` (rename intent: `windTreesMax`, default 128) + the 140 m copy-cull (`animated_scenery.js:416`) bound per-instance CPU.
- **Double-render reconciliation:** because heroes are *removed from `statics`* before InstancedMesh/Batched consolidation (exactly as `animatedStatics` already is), they never enter the bulk path → no double-render. The count guard guarantees we never peel more than the player can build.
- **Classification:** JS-only.

**Step 5 — Flags + crossover constants (JS-only).**
- `?treeWind` (default OFF, gates everything; off → `getCached` returned, byte-identical).
- `?treeWindLod` ∈ `{shader (default), hero, off}` — selects bulk-only vs bulk+hero.
- `?treeWindLodNear` (default 140, reuses `animSceneryRadius` semantics), `?treeWindLodFar` (default 380) → `uLodNear`/`uLodFar`.
- `?windTreesMax` (default 128), `?windTreesRadius` (default 140) for the hero player (mirror `animSceneryMax`/`animSceneryRadius`, `animated_scenery.js:57,63`).
- **Classification:** JS-only.

## Perf budget reasoning (1070, CPU-bound ~20 fps = 50 ms/frame)

- **The binding constraint is CPU, not GPU.** The 1070 outdoor frame is CPU-bound (~20 fps per memory). Therefore the design rule is: **wind must add ~zero CPU per instance.**
- **Bulk (T1/T2) CPU cost = Step 3 only:** one uniform-object write per frame (`uTime`, `uCamPos`, `uDir`, `uStrength`). Even counting per-material writes that's O(unique tree surfaces) ≈ tens of `.value =` assignments → single-digit microseconds. **It cannot move the 50 ms CPU budget.** No per-instance loop, no matrix recompute, no geometry touch on the bulk.
- **Why NOT extend the per-part player:** it does per-instance CPU copies (`animated_scenery.js:419-422`). 317k × ~3 parts × (Vector3.copy + Quaternion.copy) per frame would be tens of millions of CPU ops → frame death. That is precisely why it caps at 512 + culls at 140 m, and why the bulk stays shader.
- **GPU side:** two-band bend adds ~10–20 ALU + 1–2 `sin` per vertex. The frozen forest already pushes this vertex count through the 1070; wind adds only per-vertex ALU (no extra draw calls, no CPU). The far-fade zeroes amplitude beyond `uLodFar`, and frustum cull (`culling.js`) already discards off-screen trees, so visible vertex work is bounded to the draw-distance subset. **1070 has ample vertex throughput; the GPU is not the bottleneck.**
- **Regression guard:** `?treeWind` default-OFF → `getTreeWind` never called → `getCached` material → identical CPU + GPU to today. The off path is the existing frozen path verbatim.

## Crossover thresholds + integration summary

- **T0→T1:** hero peel is per-DID/count-gated at bake time (not distance); the player's 140 m copy-cull + 128 cap bound it. Heroes excluded from bulk via the `statics` filter → no double-render.
- **T1→T2:** `smoothstep(uLodNear=140, uLodFar=380)` per-vertex amplitude fade. Pure GPU, per-instance, zero CPU. `uLodFar` ≈ 380 m ≈ 2 landblocks — beyond it sway is sub-pixel; frozen is imperceptible.
- **pvsRing / renderSet:** unchanged — wind rides whatever the 13×13 ring driver + `tickFrustumCull` already make visible. No new visibility state.
- **`consolidateStaticSingletons`:** unchanged loop; shared per-surface wind material preserves the batch key so trees still consolidate to one BatchedMesh/draw call.
- **InstancedMesh (bulk 317k):** wind material swapped in `buildInstancedNode` (`statics.js:1220`); node persists ring-wide (no `landblockId`), so the shared material + `windUniforms` live for the forest's lifetime and get one uniform write/frame regardless of player LB.
- **`landblock_lru`:** per-LB BatchedMesh wind batches evict normally (`landblock_lru.js:241-258` disposes geometry); the **shared wind material is owned by `MaterialCache`, not the batch**, so eviction never disposes it (no leak, no re-link cost on re-entry). InstancedMesh wind nodes are LRU-skipped as today.
- **`animated_scenery.js` distance cull:** reused verbatim for the hero tier (`?windTreesRadius` → the `tickRadiusSq` cull at `:416`).

## Risks & open questions

1. **BatchedMesh per-instance world pos in the vertex shader.** InstancedMesh exposes `instanceMatrix` directly; BatchedMesh stores per-instance matrices in `_matricesTexture` and three injects `getBatchingMatrix()`. Reading instance world pos for the LOD fade is straightforward on InstancedMesh, fiddlier on BatchedMesh. **Mitigation:** InstancedMesh is the ring-path carrier for the dense forest (≥2 instances → exactly the tree case), so the primary path is clean. For `?staticBatch` per-LB BatchedMesh, fall back to a coarser per-batch fade (uniform `uBatchCenter`) or extend `onBeforeCompile` to call `getBatchingMatrix`. Flag the BatchedMesh route as a follow-on.
2. **Hero count-guard tuning.** `heroEligible` must never peel a high-count DID into the 512-cap player (would make 316k trees vanish). **Mitigation:** gate on `source === "landblockinfo"` (named trees) or per-LB tree-count `< HERO_PEEL_MAX`; default the whole hero tier OFF (`?treeWindLod=shader`). **Rollback:** `?treeWindLod=shader` or `?treeWind=off` → frozen.
3. **`uFarFade` vs draw/shadow horizon.** If `uLodFar` exceeds the LB load horizon, distant trees may be frozen *and* unloaded — fine, but verify the fade band sits inside the resident ring so the near→far transition is on-screen, not at a pop-in seam. **Open question:** should `uLodFar` track the LRU `maxResident` radius dynamically? Default static 380 m is safe; revisit if pop-in is visible in the 1070 eye-test.
4. **GPU vertex cost at full forest if far-fade doesn't early-out.** `amp==0` still runs the `sin` math unless branched. **Mitigation:** `if (lod > 0.0) { ...displacement... }` dynamic branch, or accept the ALU (cheap on a 1070). Decide during the batched 1070 eye-test.
5. **Per-instance phase source.** The shader reads phase from `instanceMatrix` (translation hashed) so the forest doesn't sway in lockstep — depends on task 05 delivering a stable hash. **Open question:** confirm `instanceMatrix` translation is distinct enough across a clump of co-located trees (some placements are near-identical); may need to fold `gl_InstanceID` into the phase hash.
6. **Off-path purity.** Any code touching `statics.js`/`materials.js` must no-op when `?treeWind` is off so the frozen retail path stays byte-identical. **Mitigation:** gate every new branch on `treeWindEnabled()`; covered by the off=identical regression guard in task 15.
