All 16 reports are read and the load-bearing seams are verified against the live tree (line numbers match). Here is the authoritative synthesis.

---

# Tree Wind Animation — Implementation Coding Plan (holtburger)

**Repo root:** `external/holtburger/apps/holtburger-web` (the live source — never edit a staged copy). **Status:** non-retail enhancement, ships behind `?treeWind` default-OFF. **Verified:** every seam cited below was confirmed against the working tree on 2026-06-23.

---

## 1. Executive Summary + Architecture Verdict

### What ships

Trees in AC do **not** sway in retail. This plan adds procedural wind motion as a **flag-gated, default-OFF** enhancement where `?treeWind` absent ≡ byte-identical retail-frozen render. It delivers motion in four independently-shippable stages, front-loading the **JS-only, no-rebuild, no-bake** wins so a laptop dev sees motion on day one without ever invoking the OOM-prone `cargo build`.

### The architecture verdict (reconciling the two camps)

The reports split into a **GPU-shader camp** (parts 04/05/06/13: animate the existing batched forest in the vertex shader, scales to 317k placements, zero per-instance CPU) and a **detected-skeleton camp** (parts 07/08/09: skeletonize offline, run a harmonic sim, bake authentic per-part motion). **They are not competitors — they are tiers of one pipeline, selected by distance and fidelity:**

| Tier | Path | Scale | Motion source | Build class |
|---|---|---|---|---|
| **Near hero** | rigid-part keyframe player (`animated_scenery.js`) fed a synthetic/baked clip | ≤512, ≤140 m | bbox base-pivot rig (1b) → offline skeleton sim (2) | JS-ONLY → OFFLINE-BAKE clip |
| **Forest bulk (default)** | **Crytek two-band shader** on the existing InstancedMesh/BatchedMesh | unbounded (317k) | procedural, uniform-driven, per-instance phase | **JS-ONLY, no bake** |
| **Forest fidelity (optional upgrade)** | **VAT** on the same instanced nodes | unbounded | offline skeleton sim baked to texture | OFFLINE-BAKE + JS runtime |

The **offline skeleton-driven sim** (parts 07/08) is the single source of authentic motion: it bakes to **both** an AC-native rigid per-part `Animation 0x03` (cheap, for the near hero player) **and** a VAT texture (expensive, only when sub-part smooth bend is needed). The shader (part 05) is the **no-bake bring-up and forest fallback** that ships before any bake exists and animates trees that never reach the player's 512 cap.

**Why dense keyframes.** AC native playback is flat (no runtime parent chain), frame-snapping (integer keyframe lookup, no interpolation in the DAT path), and rigid (zero vertex skinning). So the offline cascade (trunk→branch→twig) must be **flattened to absolute root-relative per-part frames** and **densely sampled at 30 fps** — the spline is preserved as samples, not as a sparse keyed curve, because the consumer floor-snaps (part 08 §5, `animation.rs` / `setup_rig.js`). The JS player slerps and can decimate, but we bake dense so one record serves both routes.

**Why `?treeWind` default-OFF / non-retail.** Retail trees are frozen; this is beyond-retail. It ships in the "default-off on purpose" callout (`docs/url-flags.md:61`), NOT the default-ON flips list. A flip to default-ON requires explicit user sign-off after the BATCHED 1070 eye-test passes (part 14).

---

## 2. Corrected Ground Truth (with file:line)

1. **Trees ARE multi-part SetupModels, but co-located / flat / no hierarchy.** A SetupModel `0x02` carries `parts: Vec<u32>` GfxObj DIDs + `parent_index` (`crates/holtburger-dat/src/file_type/setup_model.rs:327-351`). Trees have `parent_index = -1` and all parts co-located at the model origin `(0,0,0)`. `compute_hinge_frames` reads each part's frame from `placement_frames[0]` (`apps/holtburger-web/src/lib.rs:9856`); for trees these are **identity** → the hinge gives no pivot, so a part's true base must come from its **vertex Zmin**.

2. **AC playback is flat + frame-snapping + rigid.** `CPartArray::UpdateParts` composes each part as `part_world = combine(model_root, animframe[i])` — it does **not** walk `parent_index`. So every authored `AnimationFrame.frames[p]` must be the **absolute, root-relative** transform with the cascade already flattened (part 09 §"absolute-frame requirement"). There is **no vertex skinning** — parts rotate rigidly, which is the root of the joint-cracking risk.

3. **The existing per-part player exists and is reusable verbatim.**
   - `buildSceneryAnimationClip(THREE_, frames, numParts, numFrames, fps)` — `scene3d/animated_scenery.js:125` (verified). Pure, exported, unit-tested. Consumes a **flat Float32Array, frame-major then part-major, 7 floats per (frame,part): `[ox,oy,oz, qw,qx,qy,qz]`** (index `base=(f*numParts+p)*7`). Reorders AC **wxyz → THREE xyzw**. **It never touches the DAT — a synthetic JS array drops straight in.**
   - `_didGroups = new Map()` (`:101`, verified) — shared-driver registry keyed by `animId`; a **string key drops in with zero structural change** (one shared mixer per key, advanced once per rAF).
   - `getOrCreateDidGroup(animId, wasmExports)` (`:204`) — the only DAT-specific lines are the `fetchAnimation(animId)` call + unpack; everything from clip-build down is generic.
   - `buildOne(p, ...)` (`:245`) already pulls **per-part meshes + rest-hinge frames** via `fetchBuildingPlacement(setupId)` — so the bbox rig needs **no new wasm export**.
   - The rAF copy loop (`:417-423`, verified) **overwrites** `inst.parts[j].position/quaternion.copy(g.parts[j]…)` every frame ⇒ **synthetic frames must be ABSOLUTE part-local (hinge baked in)**; for trees hinge ≈ identity. Distance cull at `:416`, 512 cap (`DEFAULT_MAX_ANIMATED=512` `:43`), LRU/orphan reclaim via `_isOrphaned` + `userData.landblockId` tag.
   - `attachAnimatedScenery` (`:314`) filters `defaultAnimationId != 0` (`:321`) — **trees (`defaultAnimation=0`) are invisible to it**, so Phase 1a needs a *sibling* entry, not a flag flip.

4. **The statics divert seam exists TWICE** (verified):
   - Per-LB `bakeStaticsForLandblock`: `statics.js:1575` `let statics = …concat(…)`, peel gated by `animSceneryEnabled()` at `:1581-1585` (`statics = statics.filter(…===0)`), attach at `:1830`.
   - Ring `bakeStaticsRing`: `:2080` / peel `:2086-2090` / attach `:2364`.
   - Import seam: `statics.js:89`. **When the flag is off, `statics` is never reassigned → `consolidateStaticSingletons` (`:1442`/`:1784`) gets the identical array → byte-identical frozen path.** This is the off=frozen guarantee, mechanically.

5. **dat-write authoring + offline bake tooling all exist.** `crates/holtburger-dat-write/src/pack/{setup_model.rs, animation.rs}` (verified present) with byte-round-trip tests; `apps/holtburger-tools/src/bin/scenery-bake.rs` (87 KB, verified) is the offline-tool template (CLI, `preflight_dat_dir`, `.sha256` sidecars, determinism harness, no Date/Random); client fetch via `init_scenery_base_url` (`lib.rs:2131`); `dist -> /mnt/wbterminal2/holtburger-dist` (verified symlink). Wind-relevant exports verified: `fetchBuildingPlacement` (`lib.rs:9819`), `takePartMeshes`/`takePartHingeFrames` (`:9785`/`:9797`), `fetchAnimation` (`:43128`), `fetch_model_meshes` (`:9665`).

6. **No wind state exists yet.** `scene3d/weather_state.js` carries only `is_storm` + T/Td/P/season; `scene3d/daygroup_weather.js` PROFILES are meteorology-only (no wind). Greenfield — couple gusts to the existing `is_storm` signal.

7. **Material/shader patch infra is mature** (verified): `_chainBeforeCompile` (`materials.js:292`), `_patchSetCacheKey` (`:262`), working `applyWireVertexAOPatch` injecting after `#include <begin_vertex>` (`:324-325`), `getCachedFloorBias` clone-and-cache template (`:1794`). Per-frame uniform precedent `tickTerrainUTime` (`loop.js:817`, called `:1605`).

---

## 3. The Staged Coding Roadmap (the heart)

**Module ownership (adjudicated — resolves where parts 01/02/03/08 each proposed a home):**
- `scene3d/tree_wind.js` **(NEW)** — the thin gate: `treeWindEnabled()`, `isTreeDid()`, the `TREE_WIND_DIDS` allowlist, and re-exports of the attach entry. This is what `statics.js` imports.
- `scene3d/wind_rig.js` **(NEW)** — pure, unit-testable math: `partBBox`, `swayAmp`, `buildTreeWindClip` (the bbox base-pivot clip generator). No THREE-scene state, no wasm.
- `scene3d/wind_state.js` **(NEW)** — the wind vector + gust singleton (part 12).
- `scene3d/animated_scenery.js` **(EDIT)** — gains `attachWindTrees`, `buildOneWind`, `getOrCreateWindGroup` (they need the module-private `_didGroups`/`_instances`/`_ensureRaf`/`placeNode`, so they must live here).
- `scene3d/adapter.js`, `scene3d/materials.js`, `scene3d/loop.js`, `scene3d/statics.js` — small **EDIT**s at the cited seams.

Each step is tagged **[JS]** (JS-only, no rebuild), **[WASM]** (needs gated rebuild — buildbox only), or **[BAKE]** (offline buildbox).

---

### PHASE 1a — Per-part rustle via existing player + synthetic clip + statics divert  *(all [JS])*

Ships first-visible-motion with **zero rebuild, zero bake**. Scope: **short foliage only** (origin-pivot is safe when origin ≈ ground; tall trees wait for 1b to avoid co-located-origin shear).

**Step 1a.1 — Flag scaffold + allowlist.** Create `scene3d/tree_wind.js`. **[JS]**
- File: `scene3d/tree_wind.js` (new). Seam: mirrors `animSceneryEnabled()` (`animated_scenery.js:70`) but **default-OFF** (`=== "on"`, accept truthy set `on|true|1|yes` per `docs/url-flags.md:75`).
```js
let _flag;
export function treeWindEnabled() {
  if (_flag !== undefined) return _flag;
  let on = false;
  try { if (typeof window !== "undefined" && window.location)
    on = new URLSearchParams(window.location.search).get("treeWind")?.toLowerCase() === "on";
  } catch (_) {}
  return (_flag = on);
}
// Phase-1a SHORT-FOLIAGE seed (from ground truth; tall trees added at 1b).
// Auditable git diff; offline classifier (Step 2.0) can regenerate later.
const TREE_WIND_DIDS = new Set([0x02001063 /*fern ~1.25m, 317k*/, 0x020007A2 /*shrub 6-part, 236k*/]);
export function isTreeDid(id) { return TREE_WIND_DIDS.has(id >>> 0); }
```
- Verified: `?treeWind` off ⇒ every downstream peel/attach skipped ⇒ frozen path untouched.

**Step 1a.2 — Synthetic clip generator (pure).** Create `scene3d/wind_rig.js` with `buildTreeWindClip`. **[JS]**
- File: `scene3d/wind_rig.js` (new). Emits the **exact flat layout** `buildSceneryAnimationClip` consumes (`animated_scenery.js:125`). For 1a, `rig=null` → rotate about origin (short foliage). Phase per part from a golden-ratio hash (deterministic — `Math.random` banned in sandbox).
```js
// out[(f*numParts+p)*7 + 0..6] = [ox,oy,oz, qw,qx,qy,qz]  (AC wxyz, ABSOLUTE part-local)
export function buildTreeWindClip(numParts, rig /*null in 1a*/, opts) {
  const { fps=30, loopSeconds=4, ampDeg=6, dir=[1,0], cycles1=3, cycles2=11, flutter=0.3 } = opts||{};
  const numFrames = Math.max(2, Math.round(fps*loopSeconds)), T = numFrames/fps;
  let dx=dir[0],dy=dir[1]; const dl=Math.hypot(dx,dy)||1; dx/=dl; dy/=dl;
  const ax=-dy, ay=dx;                       // hinge axis ⟂ wind, in ground plane (Z-up)
  const w1=2*Math.PI*cycles1/T, w2=2*Math.PI*cycles2/T;   // integer cycles → seamless loop
  const A=ampDeg*Math.PI/180, frames=new Float32Array(numParts*numFrames*7);
  for (let f=0; f<numFrames; f++){ const t=f/fps;
    for (let p=0; p<numParts; p++){
      const ph=2*Math.PI*((p*0.6180339887)%1);                 // deterministic per-part phase
      const th=A*(Math.sin(w1*t+ph)+flutter*Math.sin(w2*t+ph*1.7));
      const h=th*0.5, s=Math.sin(h), c=Math.cos(h);
      const qw=c, qx=s*ax, qy=s*ay, qz=0;
      const piv = rig?.[p]?.pivot || {x:0,y:0,z:0};            // 1a: origin; 1b: bbox base
      // O = pivot - R*pivot  (rotate-about-pivot; the co-located-origin shear fix)
      const rx=piv.x,ry=piv.y,rz=piv.z;
      const tx=2*(qy*rz-qz*ry), ty=2*(qz*rx-qx*rz), tz=2*(qx*ry-qy*rx);
      const Rx=rx+qw*tx+(qy*tz-qz*ty), Ry=ry+qw*ty+(qz*tx-qx*tz), Rz=rz+qw*tz+(qx*ty-qy*tx);
      const b=(f*numParts+p)*7;
      frames[b]=rx-Rx; frames[b+1]=ry-Ry; frames[b+2]=rz-Rz;
      frames[b+3]=qw; frames[b+4]=qx; frames[b+5]=qy; frames[b+6]=qz;
    }}
  return { frames, numParts, numFrames, fps };
}
```

**Step 1a.3 — Synthetic group + tree instance builder + attach entry.** Edit `scene3d/animated_scenery.js`. **[JS]**
- Seam: fork `getOrCreateDidGroup` (`:204`), `buildOne` (`:245`), `attachAnimatedScenery` (`:314`). Reuse `_didGroups`/`_instances`/`_builtKeys`/`_ensureRaf`/`placeNode`/`maxAnimated()` **unchanged**.
```js
import { buildTreeWindClip, partBBox, buildBboxRig } from "./wind_rig.js";   // 1b uses the latter two

function getOrCreateWindGroup(groupKey, numParts, rig, windParams) {
  const hit = _didGroups.get(groupKey); if (hit) return hit;
  const { frames, numFrames, fps } = buildTreeWindClip(numParts, rig, windParams);
  const clip = buildSceneryAnimationClip(THREE, frames, numParts, numFrames, fps);   // :125, unchanged
  if (!clip) return null;
  // ---- identical to getOrCreateDidGroup :221-235 (template/mixer/clipAction/play) ----
  // store { mixer, template, parts, numParts, refCount:0 } under the STRING key.
}

async function buildOneWind(p, wasmExports, materialCache, spFetch, windParams, instIdx) {
  const setupId = (p.objId ?? p.modelId ?? 0) >>> 0; if (!setupId) return null;
  const bundle = await wasmExports.fetchBuildingPlacement(setupId).catch(()=>null);  // FIRST (need partCount)
  if (!bundle) return null;
  const partCount = bundle.partCount|0; if (!partCount){ bundle.free?.(); return null; }
  const partMeshes = bundle.takePartMeshes();
  const hinge = (typeof bundle.takePartHingeFrames==="function") ? bundle.takePartHingeFrames() : [];
  bundle.free?.();
  const rig = buildBboxRig ? buildBboxRig(partMeshes) : null;          // null in pure 1a; real in 1b
  const K = windParams.phaseBuckets ?? 3;                              // mask lockstep across instances
  const groupKey = `wind:0x${setupId.toString(16)}:${instIdx % K}`;
  const g = getOrCreateWindGroup(groupKey, partCount, rig, windParams); if (!g) return null;
  // ---- node/part mesh build byte-identical to buildOne :267-301; tag isTreeWind ----
  return { node, parts, animId: groupKey };
}

export async function attachWindTrees(scene3d, placements, wasmExports, opts) {
  if (!treeWindEnabled?.()) return 0;                                  // imported from tree_wind.js
  if (!scene3d?.staticsGroup || !Array.isArray(placements) || !wasmExports) return 0;
  if (typeof wasmExports.fetchBuildingPlacement !== "function") return 0;  // fetchAnimation NOT needed
  // dedupe via placementKey, cap via maxAnimated(), parent = opts.resolveParent||staticsGroup,
  // tag userData={landblockId, isAnimatedScenery:true, isTreeWind:true}, _ensureRaf(), count dropped-over-cap.
}
```
- **Key insight (verified):** the instance record's `animId` field is already used as an opaque `_didGroups` key (`:417`), so a string drops in with no rAF/refcount/dispose changes.

**Step 1a.4 — Wire the divert + attach in statics.js.** Edit `scene3d/statics.js`. **[JS]**
- Import (`:89`): add `import { treeWindEnabled, isTreeDid } from "./tree_wind.js"; import { attachWindTrees } from "./animated_scenery.js";`
- **Per-LB** — insert immediately after the anim peel (`:1585`); **Ring** — after `:2090`. Runs *after* the anim peel so sets are disjoint:
```js
  let windTrees = null;
  if (treeWindEnabled()) {
    const t = statics.filter((p) => isTreeDid((p?.modelId >>> 0) || 0));
    if (t.length) { windTrees = t; statics = statics.filter((p) => !isTreeDid((p?.modelId >>> 0) || 0)); }
  }
```
- Attach — after `:1830` (and `:2364`): `if (windTrees) await attachWindTrees(scene3d, windTrees, wasmExports);`

**Shippable + verified:** near-field short foliage rustles; off=frozen (flag-gated peel never runs). Verify: `test_wind_clip_gen.mjs` (layout/determinism/seam/mixer-plays, part 15 §1) + `test_wind_off_frozen.mjs` (part 15 §5) + headless `test_wind_smoke.mjs` (part 15 §7).

---

### PHASE 1b — bbox base-pivot, height-weighted rig  *(all [JS])*

Adds the **co-located-origin shear fix** (the central gotcha) and enables tall trees. Pure JS from the same `bundle` 1a already fetches — **no new wasm export** (part 11 confirms `ModelMesh.bbox` getter at `lib.rs:4631` surfaces per-part Zmin).

**Step 1b.1 — Per-part bbox + sway weight (pure).** Add to `scene3d/wind_rig.js`. **[JS]**
- `partBBox(positions)` scans the `triCount*9` object-space stream (AC Z-up) → `{cx,cy,z0=minZ, w, h, minZ,maxZ}` (part 03 §A).
- `swayAmp(b, modelZmin, modelH, A_MAX)` — monotone, bbox-only: trunk (full-height, narrow) → ~15% amp; high broad canopy → max (part 03 §B).
- `buildBboxRig(partMeshes)` → `rig[p] = { pivot:{cx,cy,z0}, weight, axis }`. Pivot **Z = vertex Zmin (part base), never model origin**.

**Step 1b.2 — Feed rig into the clip.** `buildTreeWindClip` already takes `rig` (Step 1a.2) and applies the `O = pivot − R·pivot` translate-rotate-translate-back. With a real rig, per-part amplitude = `swayAmp` and pivot = part base. **[JS]**

**Step 1b.3 — Expand allowlist** to tall trees (`0x02000246`, `0x02000258` trunk/branch/canopy `0x0100379F/0x010037A1/0x010037A2`, `0x0200035F`) in `tree_wind.js`. **[JS]**

**Shippable + verified:** canopy hinges from its own base, trunk stays planted, no swing-through-arc. **The load-bearing test** is `test_bbox_rig.mjs` (part 15 §2): rotate a canopy part with `pivot.z=5.3` by 0.3 rad — the pivot point must map to itself (<1e-5), while the same frame applied to model origin produces a large arc. A regression that pivots about origin fails the first sub-assert.

---

### PHASE 1-Forest — No-bake Crytek two-band shader  *(all [JS])*

Parallel sub-track that **ships without any bake** and answers the 512 cap: animates the existing InstancedMesh/BatchedMesh forest in the vertex shader, uniform-only, per-instance phase, scales to 317k. This is the **default forest path** (`?treeWindLod=shader`, part 13). Does **not** peel from `statics` — animates in place.

**Step F.1 — `windWeight` vertex attribute.** Edit `scene3d/adapter.js`. **[JS]**
- Seam: `meshToGeometryGroups` (`:707`, verified). Inside the per-tri-vertex `d`-loop (~`:783-799`) write into a `new Float32Array(n*3)` using the **same reordered source vertex `sv`** (so it stays in lockstep on single-sided `[0,2,1]` winding). **Store RAW normalized height** `(z−zMin)/zSpan` (curve in shader, for tuning — part 04 risk adjudication), gated behind `opts.windWeight` (default off → frozen path byte-identical). `setAttribute("windWeight", …, 1)` after the position/uv/normal calls (~`:802-813`, mirror in the fallback branch ~`:860`).
- Pass `opts.windBBox` = **model-wide** Zmin/Zmax on the per-part path (co-located-origin caveat: a canopy part's local Zmin ≠ 0).

**Step F.2 — Shared `windUniforms` + `applyTreeWindPatch` + `getTreeWind`.** Edit `scene3d/materials.js`. **[JS]**
- Add module-level `windUniforms = { uTime, uDir(vec3 world), uStrength, uMainFreq, uDetailFreq, uMainAmp, uDetailAmp, uBendExp, uCamPos, uLodNear, uLodFar, uTreeRefHeight }` — **shared by reference** so one loop.js write updates every program.
- `applyTreeWindPatch(material)` via `_chainBeforeCompile` (`:292`): inject pars after `#include <common>` and the two-band displacement **after `#include <begin_vertex>`** (`:324`, same seam as `applyWireVertexAOPatch`) so `transformed` flows into `project_vertex`/`worldpos_vertex`/`shadowmap_vertex` → lighting/shadow/fog survive. Band 1 = whole-tree bend weighted by `pow(windWeight, uBendExp)` along `uDir`; Band 2 = canopy flutter, per-vertex phase. Per-instance phase from `batchingMatrix[3].xy`/`instanceMatrix[3].xy` hash (no lockstep). **Per-instance distance LOD** = `amp *= 1 - smoothstep(uLodNear, uLodFar, distance(instWorld, uCamPos))` → beyond `uLodFar` vertex is at rest = frozen.
- Extend `_patchSetCacheKey` (`:262`) with `"|w"+(u.__windPatched?1:0)` so a wind program never collides with a frozen one.
- `getTreeWind(surfaceDid)` mirrors `getCachedFloorBias` (`:1794`): `_getCachedDouble(sid).clone()` → `applyTreeWindPatch` → cache in `this.windMaterials`. Add to the dispose loop.

**Step F.3 — Bind wind material at the instanced build sites.** Edit `scene3d/statics.js`. **[JS]**
- At `buildInstancedNode` (`statics.js:1220`) and `buildSingletonNode`, when `treeWindEnabled() && isTreeDid(modelId)`, resolve `mat = materialCache.getTreeWind(surfaceDid)` instead of `getCached(surfaceDid)`. Shared-per-surface clone preserves the batch key (`consolidateStaticSingletons` `:1457` keys on `group[0].material`) → trees still batch to one draw call.

**Step F.4 — Per-frame uniform write.** Edit `scene3d/loop.js`. **[JS]**
- Add `tickWindUniforms(scene3d)` beside `tickTerrainUTime` (`:817`), call adjacent to `:1605` in the same try/catch + one-shot-warn idiom. Reads `scene3d.frameTime.tsSec` (same clock as terrain/water → phase-locked), `cam.position` → `uCamPos`, and the wind vector from `wind_state.js` (Phase 3). **O(1) per frame — the entire bulk-wind CPU cost.**

**Shippable + verified:** 317k-placement forest sways, GPU-only, no draw-call increase, no peel, no cap. Verify: shader bring-up uses the `position.z/uTreeRefHeight` fallback until F.1's attribute lands. Off=frozen: `getTreeWind` never called when flag off → `getCached` material identical to today.

---

### PHASE 2 — Offline skeletonize → harmonic sim → bake (VAT + AC-native Animation 0x03)

See §4 for the full pipeline. Runtime consumers:
- **AC-native dense `Animation 0x03` → sidecar JSON** feeds the **near hero player** (replaces the synthetic clip). `getOrCreateWindGroup` reads `frames` from a fetched `.windclip.json` instead of generating them. **[BAKE]** produces, **[JS]** consumes.
- **VAT texture** upgrades the **forest shader** to skeleton-driven motion where rigid-part cracking is unacceptable. `applyVatWindPatch` + `getTreeWindVAT` in `materials.js` (part 06 §4-5). **[BAKE]** produces, **[JS]** consumes.

---

### PHASE 3 — Wind state + storm gusts + LOD  *(all [JS])*

See §5 (wind state) and §3-Forest LOD. `wind_state.js` becomes the single source feeding both the player clip (build-time dir/strength, play-time gust modulation on the shared template) and the shader uniforms. LOD tier crossover via `uLodNear`/`uLodFar` + `?treeWindLod`.

---

## 4. The Offline Bake Pipeline  *(all [BAKE], buildbox only — never the 8 GB laptop)*

Runs on the buildbox (47 GiB) or via `cargo run --example … -p holtburger-dat` (single-crate, OOM-safe). **Never `cargo build --workspace`.**

**Step B.0 — New lib crate `crates/holtburger-tree-wind/`** mirroring `holtburger-scenery-bake`: `skeletonize.rs` (part 07), `sim.rs` (part 08), `vat.rs` (encoder), `author.rs` (part 09). Add to workspace `Cargo.toml`.

**Step B.1 — Skeletonize** (`skeletonize.rs`). Input = parts **with vertices + connectivity** (don't reuse the lossy `setup_local_mesh`; `GfxObj` exposes `vertex_array.vertices` + `polygons` → free adjacency graph, `gfx_obj.rs:13-24`, `graphics.rs:124-134`). **Primary = in-Rust height-slice + polygon-connectivity** (Verroust-Lazarus level sets); skeletor is opt-in `--quality=skeletor` for hero blobs only (deps not installed, marginal on 3-11 part trees).
- **Branch/tip detection:** tip = degree-1 bone-graph node with `z > root.z`.
- **Invariant:** `bones[i].index == i == part_index` (so sim `Frame[i]` ↔ `parts[i]` ↔ `part_frames[*].frames[i]`, `animation.rs:19-22`). Pivot = `(centroid_xy, vertex_zmin)` — **never model origin**. Connectivity-empty → Z-band fallback, logged (no silent degradation).
- Output: `dist/treewind/0x{DID:08X}.treeskel.json` + `.sha256`.

**Step B.2 — Per-bone harmonic sim** (`sim.rs`). Reuses `holtburger_common::{Quaternion::multiply, rotate_vector, normalize}` (the `Frame::combine` primitives already exist).
- **Per-bone oscillator** (part 08 §3): closed-form superposed sinusoid (form A, exactly seamless) for the cheap path; damped torsional ODE (form B, settle-then-sample over ≥3 periods) for the physical snap-back. **Depth decay/growth:** local hinge angle *grows* with depth (`ampGrowth^d` — trunk small, twig large = SpeedTree/Crytek two-band); frequency grows with depth (leaf flutter faster).
- **Phase:** `hash01(did, boneIndex)` integer xorshift-mul — **identical in JS and Rust**, deterministic (no `Math.random`).
- **Gusts:** looping envelope `gust(t) = base + amp*(0.5+0.5*sin(2π·gustCyc·t/L + ph))`, integer cycles over L so seamlessness survives; storm raises base/amp/freq.
- **Cascade → flatten:** convert each scalar angle to a local pivot-rotation Frame (`origin = P − q·P`), fold root→leaf via `combine(parent, child)`, store the **absolute root-relative** Frame. For the bbox rig (flat, parent=−1) the fold is trivial.
- **Wind direction:** axis = `Z × w = (−wy, wx, 0)`. Bake **per-bone scalar angle timelines** (direction-agnostic, for VAT/shader live direction) AND **flattened absolute frames** (for AC-native).

**Step B.3 — Dense-keyframe sampling** (part 08 §5): **fps = 30** (matches `DEFAULT_ANIM_FPS`, Nyquist ceiling 15 Hz ≫ ~2-5 Hz flutter). **Loop L = 8 s → 240 frames** (6 s/180 for smallest foliage). Every frequency snapped to integer cycles over L (`round(freq·L)/L`) so `frame[N] == frame[0]`. Do **not** duplicate frame 0 at the end — sample `f=0…N-1`, `LoopRepeat` wraps cleanly.

**Step B.4 — Bake to outputs.** New binary `apps/holtburger-tools/src/bin/tree-wind-bake.rs` cloning `scenery-bake.rs` skeleton (`preflight_dat_dir`, `format_f32_six_sig`, `sha256_file`, `--bits` EMIT_BITS, no Date/Random). CLI: `--dat-dir --out --tree-dids @file --emit vat,anim[,dat] --fps 30 --frames 240 --strength`.

| File (under `dist/treewind/`) | Route | Contents |
|---|---|---|
| `0x{DID:08X}.windclip.json` | hero player | `{numParts,numFrames,fps,frames:[…7·N·M flat…]}` — **identical shape to `fetchAnimation`'s flat array** (`lib.rs:43146`) so `buildSceneryAnimationClip` consumes it unchanged |
| `0x{DID:08X}.windvat.bin` + `.windvat.json` | VAT forest | RGBA16F delta-from-rest, **X=vertexId (soup `t*3+sv`), Y=frame**, `texH=numFrames+1` (+1 row = copy of row 0 for seamless bilinear); meta = bbox/scale/bias/encoding |
| `0x{DID:08X}.anim.bin` (+`.setup.bin`) | AC-native portability | `DatPack::pack` bytes, byte-round-trip validated (`pack/animation.rs`, `pack/setup_model.rs`) |
| `*.sha256` (two-line: `sha256\ncontent-hash\t{fnv1a:016x}`) | integrity | mirrors `scenery-bake.rs:984-1007` |
| `tree-wind-manifest.json` | index/audit | TREE_DID list + per-DID `{numParts,numFrames,vertexCount,fps,emit-modes}` + base-DAT content hashes + tool-version |

**Output paths + client fetch wiring** ([JS], no rebuild — these are plain static assets, the OOM-friendly transport): `const TREEWIND_BASE_URL = "../../dist/treewind/";` (mirrors `SCENERY_BASE_URL` `statics.js:305`). `fetchWindClip(did)` → feed flat `frames` to `buildSceneryAnimationClip`; `fetchWindVat(did)` → `THREE.DataTexture(Uint16Array, w, h, RGBAFormat, HalfFloatType)`. Fetch `tree-wind-manifest.json` once at init (parallel to `ensureSceneryInit`). **`fetchAnimation`/`fetchBuildingPlacement` are wasm/manifest exports, NOT sidecar fetches** — so the AC-native records only reach the web client through the JSON sidecar (Phase 2a) or a dat-shard manifest re-pack (Phase 3, optional `--emit dat`).

**Determinism + SHA sidecars:** all floats through `format_f32_six_sig` (normalizes `-0.0`, locale-free `{:.6}`); phase from `fnv1a(bone_index)`; `f32→f16` via deterministic `half::f16::from_f32`. Add `tree-wind-bake-determinism.rs` (bake twice, assert byte-identical) cloning `scenery-bake-determinism.rs`.

**VAT vertexId contract (highest bake risk):** the bake walks parts/polys in the **identical order `adapter.js meshToGeometryGroups` emits non-indexed verts** (`vid = t*3 + sv`, including the single-sided `[0,2,1]` reversal at `adapter.js:777`). Pin this in a header comment in both `vat.rs` and `adapter.js`; bake a `vertexCount` + `positions-hash` into `.windvat.json`; runtime asserts against live geometry and falls back to frozen on mismatch. **Adjudication (parts 04/06/11):** prefer the **JS-post-pass / per-fused-mesh** route so the client computes `windWeight` from its own stream (no cross-process order to reconcile for the shader route); reserve hard VAT alignment for the case where sub-part bend is actually needed.

---

## 5. Wind State Module + Weather/Storm Coupling + Tuning Flags  *(all [JS])*

**Step W.1 — `scene3d/wind_state.js`** (new, ~140 LOC, part 12). Singleton, single source of truth for `{dirX, dirZ, strength, gust}`, sampled by **both** routes against the same `performance.now()` clock (phase-locked). Deterministic gust = sum of incommensurate sines (no RNG).
```js
export function windEnabled();              // ?treeWind=on (default OFF)
export function sampleWind(tSec, out);      // {dirX,dirZ,strength(incl. gust),gust,windX,windZ}
export function sampleWindNow(out);          // performance.now()-based (player route)
export function updateFromWeather(profileName, isStorm, season);   // called from loop.js
export function setWindOverride(partial);    // window.__setWind
export function getWindState();              // window.__getWind
```
- **Profile coupling:** `WIND_BY_PROFILE` keyed off `daygroup_weather.js` profile names (windy-clear/squall/thunderstorm/hail/…), `is_storm` independently forces the gusty floor (×1.5 base, ×1.4 gust freq, ×1.3 amp) even on a name miss. Season multiplier `[winter 1.10, spring 0.95, summer 0.80, autumn 1.15]`. Keeps the meteorology module unedited.

**Step W.2 — Hook weather.** Edit `loop.js tickWeatherState` (`:890`), after `wxUpdateFromDayGroup(profile)` (~`:914`): `if (windEnabled()) windUpdateFromWeather(profile?.name, profile?.is_storm, profile?.season ?? 1);` (inside existing try/catch).

**Step W.3 — Feed both routes.** Shader: `tickWindUniforms` (Step F.4) writes `u.uDir/u.uStrength` from `sampleWind(frameTime.tsSec)`. Player: at clip **build** time pass `getWindState()` (dir/baseStrength → bake axis/amplitude); at **play** time modulate the shared template's per-part rotation by `1 + GAIN·gust` once per group in the rAF (`animated_scenery.js:395`, before instances copy) — zero per-instance cost.

**Tuning flags** (memoized readers in `tree_wind.js`/`wind_state.js`, `_numFlag` pattern `animated_scenery.js:45`):

| flag | type | default | meaning |
|---|---|---|---|
| `?treeWind` | on/absent | **OFF** | master gate |
| `?treeWindStrength` | float ≥0 (≤4) | 1.0 | global amplitude multiplier |
| `?treeWindDir` | deg (−360..360) | 135 (SE) | wind azimuth override (live value from weather when present) |
| `?treeWindLod` | shader\|hero\|near\|mid\|far\|off | shader | LOD tier ceiling (part 13) |
| `?treeWindBilinear` | on/off | off | VAT point-snap (AC-authentic) vs smooth |

---

## 6. New Files + New WASM Exports + New Dist Outputs — Checklist

**New JS files (all [JS], no rebuild):**
- [ ] `scene3d/tree_wind.js` — flag + allowlist + attach re-export (~60 LOC)
- [ ] `scene3d/wind_rig.js` — `partBBox`, `swayAmp`, `buildBboxRig`, `buildTreeWindClip` (~150 LOC, pure)
- [ ] `scene3d/wind_state.js` — wind vector + gust singleton (~140 LOC)
- [ ] `scene3d/diag/wind_trees.js` — `windTreesDiag` counter (~50 LOC)
- [ ] Tests: `test_wind_clip_gen.mjs`, `test_bbox_rig.mjs`, `test_vat_encode.mjs`, `test_wind_off_frozen.mjs`, `test_wind_lru_evict.mjs`, `test_wind_smoke.mjs`

**Edited JS files (all [JS]):** `animated_scenery.js` (attachWindTrees/buildOneWind/getOrCreateWindGroup), `statics.js` (×2 divert + ×2 attach + material bind + import), `adapter.js` (windWeight attr), `materials.js` (windUniforms/applyTreeWindPatch/getTreeWind[+VAT]), `loop.js` (tickWindUniforms + weather hook), `diag.js` (register windTrees), `docs/url-flags.md`.

**New WASM exports:** **NONE required for any shipping phase** (part 11 headline — verified: `fetchBuildingPlacement` surfaces per-part meshes + `bbox` getter at `lib.rs:4631`; `buildSceneryAnimationClip` is pure). Optional contingency only, **[WASM] gated, buildbox-only, off the critical path**, each requiring a bump of both the F18-2 manifest version (`lib.rs:591`) and `EXPECTED_WASM_MANIFEST_VERSION` in `index.html`:
- [ ] (optional) `parseAnimationBytes(Vec<u8>) -> AnimationJs` — ~25 LOC, reuses `Animation::read` + the flatten at `lib.rs:43142`. Only to consume `.anim.bin` natively on web (Phase 2 proof; sidecar JSON avoids it).
- [ ] (optional) `fetch_gfx_vertices` / `fetch_canonical_wind_mesh` — ~50-90 LOC. Only if in-browser skeletonization or hard VAT order alignment is forced — the offline bake + JS-post-pass make these unnecessary.

**New offline crate/binary (all [BAKE]):** `crates/holtburger-tree-wind/` lib; `apps/holtburger-tools/src/bin/tree-wind-bake.rs` + `tree-wind-bake-determinism.rs`.

**New dist outputs (under `dist/treewind/` → `/mnt/wbterminal2/holtburger-dist/treewind/`):** `0x{DID}.windclip.json`, `0x{DID}.windvat.bin`+`.windvat.json`, `0x{DID}.anim.bin`/`.setup.bin`, `*.sha256`, `tree-wind-manifest.json`, `0x{DID}.treeskel.json`.

---

## 7. Flags + docs/url-flags.md + the BATCHED 1070 Eye-Test Checklist

**`docs/url-flags.md` diff (DOC-ONLY, part 14 §4):**
- Add `treeWind` family to the "default-off on purpose" callout (`:61`) — **not** the default-ON flips list.
- Add `scene3d/tree_wind.js` + `scene3d/wind_state.js` to the central parsing-locations list (~`:73`).
- New dated subsection `### 2026-06-23 — tree wind sway — NON-RETAIL, DEFAULT-OFF` (after `:637`), with the prose intro (retail trees don't sway; flag-gated; staged delivery; live-source rule; **ACE untouched — pure client visual, no protocol/STB/wire change**) + the 4-flag table (`| Flag | What it does | Eye-test | Pass criteria |`), marked **Pending 1070 eye-test (BATCHED)**.

**BATCHED 1070 eye-test checklist** (queued with the other pending rows, run in one session; infra `docs/HANDOFF-3d-render-fidelity-2026-05-28.md:49-110`, Chrome `127.0.0.1:9333` at `young@100.127.215.75`, A/B JPEG pairs). **PASS bar = base planted + canopy sways + no cracking + off=frozen + no perf regression.**

- [ ] **T-0 REGRESSION GUARD** — bare-default (no flag): trees FROZEN exactly as today; A/B pixel-diff vs pre-change ~zero. *Must pass first.*
- [ ] **T-1 Short foliage rustle** — fern `0x02001063`/shrub `0x020007A2`: clusters rustle, stay planted, off=dead-still.
- [ ] **T-2 Canopy hinge + planted base** — tall `0x02000258` near-field: canopy sways about each part's Zmin base, trunk planted (no origin swing-through-arc), joints don't crack.
- [ ] **T-3 No-lockstep forest** — dense `0x02001063` region: independent per-instance phase, downwind lean tracks `?treeWindDir`.
- [ ] **T-4 Perf** — dense forest, FPS HUD: within ~1-2 fps of OFF baseline (~20 fps CPU-bound); no GC stutter; `__diag.windTrees.lodTier` far→frozen.
- [ ] **T-5 Direction/strength knobs** — `treeWindDir=0/180`, `treeWindStrength=0/0.5/2`: lean tracks dir, 0=frozen, smooth scaling.
- [ ] **T-6 LOD crossover** — `treeWindLod=shader/near/far`: no pop at crossover, far tier cheap.
- [ ] **T-7 Town interaction** — Holtburg: trees sway, animScenery flags still wave, no double-render, no z-fight/cracking at tree↔building seams.
- [ ] **T-8 Lighting/shadow** — dawn/dusk: swaying trees receive sun/shadow/fog (displacement before `begin_vertex`), no flat canopies.

Any FAIL ⇒ flag stays default-OFF; flip to default-ON requires explicit user sign-off.

---

## 8. Test / Verification Plan  *(all [JS], hand-rolled `check()` + `process.exit(failed?1:0)`, part 15)*

**Unit (pure functions):**
- [ ] `test_wind_clip_gen.mjs` — layout (`len === numParts·numFrames·7`); determinism (two calls byte-identical → no `Math.random`); loop seam (frame0 ≈ frame N−1 < 1e-4); per-part phase divergence; amplitude monotone with sway weight; degenerate → null; mixer actually plays it (copy `test_animated_scenery.mjs:78-89`).
- [ ] `test_bbox_rig.mjs` — **the shear guard**: pivot.z = part Zmin not 0; weight(trunk)<branch<canopy; ★ rotate canopy about its base → base maps to itself (<1e-5), same frame about origin → large arc; zero-wind → identity.
- [ ] `test_vat_encode.mjs` — texel layout `(f·width+v)·ch`; vertexId↔adapter order; bbox normalize round-trip; row0===row(H−1) seam; determinism.

**Headless smoke:** `test_wind_smoke.mjs` — stub `scene3d`/`wasmExports.fetchBuildingPlacement` (3 fake parts), assert `attachWindTrees` returns >0, node tagged `isTreeWind`, `didGroups===1` per DID, `tickAnimatedScenery(1/30)` moves a part with 0 errors, flag-off ⇒ returns 0.

**Diag counters:** `scene3d/diag/wind_trees.js` registered at `diag.js` attach loop (~`:471`): `{instances, didGroups, lodTier:{near,mid,far,frozen}, shaderForestDids, vatBound, droppedOverCap, errors}`. Census ≤1 Hz (off the hot path). Standalone `windTreesDiag()` export mirrors `animatedSceneryDiag()` (`:449`).

**★ The off=frozen regression guard:** `test_wind_off_frozen.mjs` — extract the divert via the `new Function` strip technique (`test_static_batch.mjs:31-44`), stub `treeWindEnabled()`. Flag OFF → array handed to `consolidateStaticSingletons` is same reference/members/length, `attachWindTrees`/`getTreeWind` never called (spies===0); frozen `consolidateStaticSingletons` output byte-stable; flag ON → exactly the TREE_DIDS peel, non-trees unchanged; cap-dropped placements counted in `droppedOverCap` (no silent loss). Compute the golden in-test (robust to THREE drift), don't commit a byte-golden.

**LRU parity:** `test_wind_lru_evict.mjs` — wind node tagged `userData.landblockId` evicted on LRU, geometry disposed once, `__cacheOwned` wind material never disposed, orphan reclaim decrements `refCount`, `windUniforms` survives node disposal.

**Real-browser (manual/CI-optional, chrome-devtools MCP):** navigate `?treeWind=on`, assert `__diag.windTrees.summary().instances > 0`, 0 console errors, `staticsGroup.children.some(n=>n.userData?.isWindTree)`. Visual sway is **strictly the 1070's job** (local MCP renders dark under swiftshader — can only confirm load/spawn/0-errors/node-attaches).

---

## 9. Dependency Graph + Minimal Phase-1a Critical Path

```
14 flag ─┐
12-lite ─┼─► 02 peel+allowlist ─► 01 attachWindTrees+synthetic clip ─► [SHIP 1a: first motion]
         │                                  │
         │                                  ▼
         │                         03 bbox base-pivot rig ──────────► [SHIP 1b: tall trees]
04 windWeight ─► 05 forest shader ◄─ 12-lite ────────────────────► [SHIP Forest: no-bake, 317k]
07 skeletonize ─► 08 sim ─┬─► 09 AC-native ─► sidecar JSON ────────► [SHIP hero fidelity]
                          └─► 10 VAT bake ─► 06 VAT runtime ───────► [SHIP VAT forest]
12-full ─► 13 LOD ────────────────────────────────────────────────► [SHIP polish]
15 tests run alongside every ship; 11 wasm gate only if a route needs an export (it doesn't)
```

**Minimal Phase-1a critical path to first-visible-motion — front-loaded JS-only, no rebuild, no bake:**

1. `tree_wind.js`: `treeWindEnabled()` (default-OFF) + hardcoded short-foliage `TREE_WIND_DIDS` seed. **[JS]**
2. `wind_rig.js`: `buildTreeWindClip(numParts, null, opts)` (origin-pivot, deterministic phase). **[JS]**
3. `animated_scenery.js`: `getOrCreateWindGroup` (string key into `_didGroups`) + `buildOneWind` + `attachWindTrees` (reuse rAF/cap/cull/LRU verbatim). **[JS]**
4. `statics.js`: `windTrees` peel after `:1585`/`:2090` + `attachWindTrees` call after `:1830`/`:2364` + imports at `:89`. **[JS]**
5. `test_wind_clip_gen.mjs` + `test_wind_off_frozen.mjs` + `test_wind_smoke.mjs`. **[JS]**

Five JS edits, no `cargo build`, no bake → short foliage rustles in the near field, off=frozen. Everything heavier (skeleton/sim/VAT/AC-native) is OFFLINE-BAKE on the buildbox; the only optional `[WASM]` rebuilds are off the critical path.

---

## 10. Risks → Mitigation → Rollback

| # | Risk | Mitigation | Rollback |
|---|---|---|---|
| R1 | **Joint cracking** — rigid parts (no skinning) open seams when rotated | Pivot at shared part base; clamp angle (≤~5° trunk, larger canopy); overlap/weld at bake; reserve large bends for VAT (continuous vertex displacement) | `?treeWind=off` → frozen |
| R2 | **Co-located-origin pivot shear** (central gotcha) — all parts at origin; rotating canopy about origin = huge arc | `O = pivot − R·pivot` about each part's **vertex Zmin** (`wind_rig.js`); unit-test asserts base maps to itself | flag-off → frozen |
| R3 | **Perf on 1070** (CPU-bound ~20 fps) | Player capped 512 + 140 m cull, near-field only; forest is **uniform-only** shader (zero per-instance CPU); mixers advanced once per DID (`:395`) | flag-off → zero added cost |
| R4 | **OOM on local `cargo build`** (8 GB laptop) | All shipping phases **[JS]**; bakes on buildbox; `[WASM]` deferred to one batched gate off-laptop; never `--workspace` | n/a (no build attempted) |
| R5 | **VAT vertexId/order mismatch** with adapter triangulation (non-indexed, surface-grouped, `[0,2,1]` reversal at `adapter.js:777`) | Bake from identical `meshToGeometryGroups` order (`vid=t*3+sv`); embed vertexCount+positions-hash in `.windvat.json`; runtime asserts, falls back to frozen; prefer JS-post-pass weight | flag-off → frozen; or fall back to no-VAT shader |
| R6 | **512 cap vs forest scale** (one DID = 317k placements) | Player = near hero only; bulk via shader (no peel)/VAT; **cap-aware peel** drops counted in `droppedOverCap`, not silent | flag-off → frozen |
| R7 | **Cap-aware peel hazard** — peeled-then-dropped trees vanish (neither frozen nor animated) | Peel only nearest-N that will attach; remainder stays in frozen `statics` (shader animates in place without peeling) | flag-off → all frozen |
| R8 | **TREE_DID misclassification** (non-tree sways / double-render) | Seed from verified top-placement DIDs; exclude non-zero `default_animation`; disjointness unit-test; attach fail-soft | flag-off → frozen |
| R9 | **Bake non-determinism** (no Date/Random) | Phase from `fnv1a(bone_index)`; fixed loop length; integer-cycle freq snap; `half::f16::from_f32`; SHA sidecars + bake-twice test | re-bake |
| R10 | **Loop seam pop** | Integer cycles over L (`round(freq·L)/L`); test `‖frame0 − frameAt(L)‖ < 1e-5` | re-bake / lower amp |
| R11 | **Shadow detachment** (shader/VAT run only in main material, depth pass uses rest pose) | Phase-1 default `windBatch.castShadow=false` (still receives shadows); faithful = patched `customDepthMaterial`; `?treeWindShadow=off` interim | flag-off → frozen |

Every row's rollback is the same single hatch: **`?treeWind` off → the gated peel/material-swap/uniform-tick never runs → byte-identical retail-frozen render**, enforced by `test_wind_off_frozen.mjs`.

---

## 11. Open Questions for the Laptop Dev

1. **Which physical dist dir does the running dev server serve?** Two symlinks exist (`apps/holtburger-web/dist → /mnt/wbterminal2/holtburger-dist` verified; scene3d-relative `../../dist`). `tree-wind-bake --out` is path-agnostic; confirm and stage `treewind/` there before the VAT/clip fetch wiring (Phase 2). Plan defaults to `/mnt/wbterminal2/holtburger-dist/treewind/`.
2. **Phase-1a phase-bucket count K.** Is K=3-4 enough to mask lockstep on the 1070, or does the forest read as "rippling in waves"? The per-part-node player structurally can't do true per-instance phase (instances copy one shared template); true variety needs the shader/VAT route. Defer to the T-3 eye-test.
3. **Hero-tree delivery: sidecar JSON vs DAT overlay** (parts 09/10/11). Recommend **sidecar JSON first** (runtime stays [JS]); DAT overlay (`--emit dat` + dat-shard re-pack) is the later retail-faithful option — confirm before B.4.
4. **Does `wasm-pack build -p holtburger-web` (single-crate, not `--workspace`) fit in 8 GB?** Untested (read-only). Until verified, treat every `[WASM]` rebuild as buildbox-only and keep the optional exports off the critical path.
5. **Skeleton slice count K** (`~height/1.5m` heuristic, part 07). Expose `--slices`, tune in the eye-test; don't hard-code.
6. **Directional bins for the AC-native clip** (part 08): bake only the prevailing direction for the hero clip (VAT gets direction live for free), or 4-8 bins? Recommend prevailing-only; revisit if the hero-clip direction mismatch is visible.
7. **`treeWindDir` memoization vs live wind** (part 14): the flag value is the *override*, `wind_state.js` is the live *source* — confirm the live uniform doesn't route through the memoized flag getter.

---

*All file:line citations verified against the working tree on 2026-06-23. Where parts disagreed — shader-vs-skeleton (resolved as distance/fidelity tiers of one pipeline, §1), clip-generator module home (resolved to `wind_rig.js` pure + `animated_scenery.js` orchestration, §3), windWeight baked-vs-raw (raw attribute + shader curve, §F.1), VAT-vs-AC-native for hero (rigid AC-native sidecar default, VAT only for sub-part bend, §1/§4), and TREE_DID storage (committed seed + optional offline classifier, §3/§B.1) — the adjudication and rationale are stated inline.*
