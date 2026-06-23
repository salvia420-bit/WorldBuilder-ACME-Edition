I now have full context. Here is my deliverable.

---

# Task 15 — Test & Verification Surface for `?treeWind`

## Assignment
Design the test/verification surface so the tree-wind feature cannot regress statics / LRU / perf. Specify: (a) unit tests for the procedural clip generator, the bbox-rig math, and VAT encode (pure functions, hand-rolled `check()` style like `test_animated_scenery.mjs`); (b) a headless smoke (`treeWind=on` loads, spawns, 0 errors, trees get a wind node); (c) a diag counter `windTreesDiag` (instances, didGroups, lod-tier counts); (d) the batched 1070 visual checklist hand-off. The load-bearing requirement is the **off = identical-to-frozen** regression guard.

## Findings (file:line)

**Test harness conventions (what every new test must match):**
- Tests are plain ESM `test_*.mjs` files run individually with `node test_X.mjs` — there is **no `package.json` test script** and no `node:test` runner. 92 of 102 tests use a hand-rolled pattern: `let passed=0, failed=0; function check(label,cond,extra){...}` and end with `process.exit(failed === 0 ? 0 : 1)` (`test_animated_scenery.mjs:12-16,92`; `test_landblock_lru_evict.mjs:26-34,210`). New tests MUST follow this exact shape so the existing aggregate runner (whatever globs `test_*.mjs`) picks them up and the exit code gates CI.
- **Pure-function-from-a-big-module technique** is already established in `test_static_batch.mjs:31-44`: read the source, strip every `import` line (`/^\s*import\s+.*$/gm`), shim the unused deps, demote `export` keywords, wrap in `new Function("THREE", shims + stripped + "; return { fn };")`. This is how I extract `consolidateStaticSingletons` and how the wind tests will extract the divert filter + bbox rig out of `statics.js`/the wind module without pulling in wasm.
- **Clip-builder unit test is the template** (`test_animated_scenery.mjs`): it imports `buildSceneryAnimationClip` directly (it's `export`ed at `animated_scenery.js:125`), feeds a synthetic flat `Float32Array` (frame-major, part-major, 7 floats `[ox,oy,oz,qw,qx,qy,qz]`), and asserts track count, times, the AC-wxyz→THREE-xyzw reorder, degenerate→null, AND that a real `THREE.AnimationMixer` plays it (`:78-89`). The wind clip generator slots straight into this harness because it must emit the **same flat layout** that `buildSceneryAnimationClip` consumes.

**The divert seam I must guard (off = frozen):**
- `statics.js:1581` `if (animSceneryEnabled()) { ... statics = statics.filter(...) }` — the existing animScenery peel. When the flag is off the `statics` array is **never reassigned**, so `consolidateStaticSingletons` (`statics.js:1442`) receives the identical array → byte-identical frozen `BatchedMesh`. The comment at `:1578-1579` states the contract explicitly: *"when off, statics is unchanged (byte-identical frozen path)."* The `windTrees` peel (task 02) lands at this same seam (and the mirror at `:2086`). The off=frozen guard test asserts precisely this invariant for the wind gate.

**LRU contract the wind path must not break:**
- `test_landblock_lru_evict.mjs` proves the InstancedMesh refcount eviction (`coversLbKeys` Set, geometry-only dispose, `__cacheOwned` material never disposed, dedup on re-track). Any wind node added to `staticsGroup` is tagged `userData.landblockId` (mirroring `animated_scenery.js:271`) and evicted by the same LRU — so the wind tests must include an eviction/orphan-reclaim assert mirroring `animated_scenery.js:407-414` (`_isOrphaned` → splice + refCount-- → `_disposeDidGroup`).

**Diag surface I extend:**
- `window.__diag` is always-on (`diag.js:56-60`), installed once, with per-surface attach modules registered in the loop at `diag.js:454-471` (`["lod", _attachLod]`, `["clothing", _attachClothing]`, …). Each surface lives in `scene3d/diag/<name>.js` exporting `attach<Name>(diag)` and owns a `summary()`/`snapshot()`/`reset()` (`diag/lod.js:138-176`). The wind counter follows this exact pattern.
- The wind module ALSO exposes a standalone `windTreesDiag()` export, mirroring `animatedSceneryDiag()` (`animated_scenery.js:449-460`, which already returns `{instances, didGroups, tickCalls, lastDt, maxMixerTime, rafArmed}`) for devtools probing during the A/B.

**url-flags doc format:**
- `docs/url-flags.md:120-121` table header `| Flag | Values | Default | Effect | Where |`. The "Pending 1070 eye-test (BATCHED)" phrasing is the house style for queued visual checks (`:144` `ambientBaked` entry: *"Pending 1070 ear-test (BATCHED): roam varied terrain…"*). The wind entry matches that format (task 14 owns the diff; I supply the eye-test checklist rows).

---

## Concrete coding steps

> Convention for every file below: hand-rolled `check()` + `passed/failed` + `process.exit(failed===0?0:1)`, ESM, no new deps. **All of these are JS-ONLY (no wasm rebuild)** — they test pure functions and stub wasm, exactly like `test_static_batch.mjs`/`test_animated_scenery.mjs`.

### 1. `test_wind_clip_gen.mjs` — procedural clip generator (JS-only)
Targets the Phase-1a synthetic clip function from task 01 (expected signature `buildWindClipFrames(numParts, opts) -> Float32Array` in the flat `numParts*numFrames*7` layout). Imports it directly (it will be `export`ed from the wind module / `animated_scenery.js`), feeds the result into the already-trusted `buildSceneryAnimationClip` to close the loop.

Asserts:
- **Layout contract**: `frames.length === numParts*numFrames*7` and `buildSceneryAnimationClip(THREE, frames, numParts, numFrames, fps)` returns a clip with `2*numParts` tracks (reuses the `test_animated_scenery.mjs:39` assert).
- **Determinism (no Date/Random)**: two calls with the same `opts` produce byte-identical `Float32Array` — `frames1.every((v,i)=>v===frames2[i])`. This is the guard that phase comes from a hash of part index, not `Math.random` (per established facts: `Math.random` unavailable in sandboxes).
- **Loop seam**: frame 0 ≈ frame `numFrames-1` for both position and quaternion within `1e-4` (seamless wrap — required because the rAF mixer loops `LoopRepeat`, `animated_scenery.js:232`).
- **Per-part phase divergence**: part 0 and part 1 trajectories differ at the same frame (`frames[p0] !== frames[p1]`) — proves the forest doesn't sway in lockstep.
- **Amplitude monotonic with sway weight**: with `opts.swayWeight` higher, the peak displacement is strictly larger (links the clip gen to the bbox rig weight).
- **Degenerate**: `numParts<=0` / `numFrames<=0` → empty or `null`, soft-degrade.
- **Mixer plays it**: copy `test_animated_scenery.mjs:78-89` — build a `THREE.Group` with `part0..partN`, play via `AnimationMixer`, `update(1/30)`, assert a part actually moved.

### 2. `test_bbox_rig.mjs` — bbox base-pivot rig math (JS-only) — **the co-located-origin shear guard**
Targets task 03's pure rig functions (`computePartRig(bbox) -> {pivot:{x,y,z}, heightSpan, swayWeight}` and `hingeFrameAboutBase(pivot, axis, angle) -> {origin:{x,y,z}, q:{w,x,y,z}}`). Extract via the `new Function` strip technique if they live inside a module with imports; otherwise import directly.

Asserts (use the real per-part bboxes from established facts — tall tree `0x02000258` parts):
- **Pivot = (centroidXY, vertex Zmin)**: for branch part `0x010037A1` (Z 3.8..22.2) `pivot.z === 3.8`, NOT 0 (model origin) and NOT the centroid Z. For trunk `0x0100379F` (Z −1.7..21.2) `pivot.z === -1.7`.
- **Sway weight ordering**: narrow full-height trunk (`0x0100379F`, 2.2 m wide) gets the **lowest** weight; high broad canopy (`0x010037A2`, 16 m wide, Z 5.3..21.8) gets the **highest**. Assert `weight(trunk) < weight(branch) < weight(canopy)`.
- **★ THE KEY ASSERT (co-located-origin shear)**: take a canopy part with `pivot.z=5.3`. Build `hingeFrameAboutBase(pivot, windAxis, 0.3rad)`. Apply that AC Frame (combine: `p' = R*p + origin`) to the **pivot point itself** → it must map back to itself within `1e-5` (the base stays planted). THEN apply the SAME frame to the **model origin (0,0,0)** → it must produce a displacement of magnitude ≈ `2*sin(0.15)*|pivot|` (a large swing). This single test encodes the entire gotcha: *rotating about the part base keeps the tree planted; rotating about the shared origin would swing the whole canopy through a huge arc.* A regression that pivots about origin fails the first sub-assert.
- **Frame round-trips into the flat clip buffer**: `bakeRigToFrames(rig, numFrames)` produces a `Float32Array` whose per-(frame,part) 7-float records, fed to `buildSceneryAnimationClip`, drive a mixer such that the part's base point is stationary across all frames (sample 3 frames, assert base displacement `< 1e-4`).
- **Zero wind → identity**: `angle=0` ⇒ `origin≈(0,0,0)`, `q≈(1,0,0,0)` — the part sits exactly where the frozen mesh would (continuity with off=frozen).

### 3. `test_vat_encode.mjs` — VAT encode/decode round-trip (JS-only)
Targets task 06's pure encoder `encodeVat(restPositions, perFramePositions, bbox) -> {data:Float32Array|Uint16, width, height, min, max}` and a JS reference decoder `decodeVatTexel(data, vertexId, frame, meta)`.

Asserts:
- **Texel layout**: `width === vertexCount`, `height === numFrames`; texel for (vertexId v, frame f) is at index `(f*width + v)*channels`.
- **vertexId ↔ adapter stream**: build a tiny non-indexed buffer matching `adapter.js` output (`triCount*9` positions), assign `vertexId = gl_VertexID` = sequential `0..triCount*3-1`, and assert `decodeVatTexel(...,v,...)` returns the position at `positions[v*3..]` — proves the VAT row order matches the adapter triangulation order (the established VAT-vertexId-mismatch risk).
- **bbox normalize round-trip**: encode→decode reproduces every sampled position within the quantization epsilon (`< (max-min)/65535` for RGBA16, looser for delta-encoding).
- **Loop seam**: row 0 === row `height-1` exactly (identical first/last frame for seamless `frac(time)` wrap).
- **Delta-from-rest option**: if delta encoding is chosen, `rest + decodedDelta ≈ absolute` within eps, and the rest row decodes to ~zero delta.
- **Determinism**: same inputs → identical texture bytes (no Date/Random — bake reproducibility, mirrors the existing `.sha256` sidecar convention).

### 4. `scene3d/diag/wind_trees.js` + register in `diag.js` — the `windTreesDiag` counter (JS-only)
New attach module mirroring `diag/lod.js`. Registered by adding one line to the attach loop at `diag.js:471`:
```js
    ["windTrees",  _attachWindTrees],   // + import { attachWindTrees as _attachWindTrees } from "./diag/wind_trees.js";
```
The module exposes:
```js
export function attachWindTrees(diag) {
  const wind = {
    instances: 0,          // live per-part wind nodes (Phase 1a/1b player path)
    didGroups: 0,          // shared synthetic-clip drivers (mirrors _didGroups.size)
    lodTier: { near: 0, mid: 0, far: 0, frozen: 0 },  // task 13 crossover buckets
    shaderForestDids: 0,   // BatchedMesh surfaces carrying the wind material (Phase-2 route)
    vatBound: 0,           // tree DIDs with a VAT texture bound
    errors: [],            // capped list of build/fetch failures (pushCapped, like diag/lod.js:24)
    droppedOverCap: 0,     // instances refused by the 512 animScenery-style cap
    onBuilt(n){ this.instances += n; },
    onLodCensus(tiers){ this.lodTier = { ...tiers }; },
    onError(e){ pushCapped(this.errors, { error: String(e?.message ?? e), ts: performance.now() }, 20); },
    summary(){ return { instances:this.instances, didGroups:this.didGroups,
                        lodTier:{...this.lodTier}, shaderForestDids:this.shaderForestDids,
                        vatBound:this.vatBound, errors:this.errors.length, droppedOverCap:this.droppedOverCap }; },
    snapshot(){ /* full lists like diag/lod.js:151 */ },
    reset(){ this.instances=0; this.lodTier={near:0,mid:0,far:0,frozen:0}; this.errors.length=0; this.droppedOverCap=0; },
  };
  diag.windTrees = wind;
}
```
The wind module ALSO exports a standalone `windTreesDiag()` (mirror `animatedSceneryDiag()`, `animated_scenery.js:449`) returning `{instances, didGroups, lodTier, rafArmed, maxMixerTime}` for direct devtools probing. Hook points: `attachWindTrees`/the rAF census call `window.__diag?.windTrees?.onLodCensus(...)` once per second (not per frame — keep diag cost off the hot path). This is the single number a 1070 tester reads to confirm wind is live without opening the network panel.

### 5. `test_wind_off_frozen.mjs` — **★ off = identical-to-frozen regression guard** (JS-only)
The load-bearing test. Extract the divert filter from `statics.js` with the `new Function` strip technique (`test_static_batch.mjs:31-44`). Stub `treeWindEnabled()` so the test controls the flag both ways.

Asserts:
- **Flag OFF → array identity**: with `treeWindEnabled()===false`, run the seam logic over a `statics` array containing tree DIDs (`0x02001063`, `0x020007A2`, …) mixed with non-trees. Assert the array handed to `consolidateStaticSingletons` is the **same reference / same members / same length** as the input — no peel happened (`statics.js:1581` gate not entered). Assert `attachWindTrees` was never called and `materialCache.getTreeWind` was never invoked (spy counters === 0).
- **Frozen output byte-stable**: run `consolidateStaticSingletons(nodes, batches)` with the flag off and snapshot `out.length`, each batch `instanceCount`, and `getMatrixAt(i)` for a few instances; assert they equal a golden captured with NO wind code present at all (i.e. the wind import is inert when off). Reuses the matrix-carry asserts from `test_static_batch.mjs:95-99`.
- **Flag ON → exactly the trees peel, nothing else**: with `treeWindEnabled()===true`, assert the trees (and only DIDs in `TREE_DIDS`) are removed from `statics` and the count removed equals the count handed to the wind attach. Non-tree statics count into `consolidateStaticSingletons` is unchanged.
- **Cap parity**: when wind attach hits the 512 cap, the dropped placements are NOT silently lost from the frozen path — assert they either stay frozen or are counted in `diag.windTrees.droppedOverCap` (no-silent-cap rule).

This is the test that makes the "retail-faithful frozen rendering when off" promise mechanically enforced rather than a comment.

### 6. `test_wind_lru_evict.mjs` — wind node eviction parity (JS-only)
Mirror `test_landblock_lru_evict.mjs` for wind nodes. Assert a wind node tagged `userData.landblockId` (per `animated_scenery.js:271`) is removed from `staticsGroup` on LRU evict, its geometry disposed exactly once, its `__cacheOwned` wind material NEVER disposed (the wind material is cloned-and-cached per surface — task 05 — so it's shared and must not be double-freed), and the orphan-reclaim path (`animated_scenery.js:407-414`) decrements the shared-clip `refCount` and disposes the driver at 0. For the shader-forest route, assert the `windUniforms` object survives node disposal (it's process-global, not per-node).

### 7. `test_wind_smoke.mjs` — headless boot smoke (JS-only, stubbed wasm)
Not a browser — a node smoke that drives `attachWindTrees(scene3d, placements, wasmExports, opts)` with: a stub `scene3d` (`staticsGroup` recording `add()`, like `test_landblock_lru_evict.mjs:41`), mock placements (tree DIDs at known LB coords), and a **stub `wasmExports`** whose `fetchBuildingPlacement(setupId)` returns 3 fake per-part meshes + hinge frames and `fetchAnimation` is absent (Phase-1a uses the synthetic clip, no DAT). Asserts:
- attach returns `built > 0`; `scene3d.staticsGroup` received ≥1 node tagged `isWindTree:true` + correct `landblockId`.
- One shared driver per synthetic clip id (`didGroups === 1` for one DID, regardless of instance count) — proves the shared-mixer keying generalizes to a synthetic clip id (task 01).
- `tickWindTrees(1/30)` (the manual-advance export, mirror `tickAnimatedScenery`, `animated_scenery.js:432`) runs with **0 thrown errors** and moves a part.
- Flag off ⇒ attach returns 0, nothing added (re-asserts the gate at the runtime entry, complementing test 5's seam check).

### 8. Real-browser smoke via chrome-devtools MCP (manual / CI-optional, JS-only)
A scripted check (the `chrome-devtools` skill / MCP `evaluate_script`) for the things node can't see: navigate to `…/holtburger-web/?treeWind=on&…`, wait for boot, then assert via `evaluate_script`:
- `window.__diag.windTrees.summary().instances > 0` and `.errors === 0`.
- `list_console_messages` returns **0 errors** with `treeWind=on` (and a clean baseline with `treeWind=off`).
- A scene-graph probe: `window.liveScene3d.staticsGroup.children.some(n => n.userData?.isWindTree)` is true near a forested LB. This is the "trees get a wind node" assertion. Keep it in the eye-test batch (below), not the per-commit node suite, because it needs DATs + a GPU.

---

## 1070 visual checklist hand-off (BATCHED — queued, not run piecemeal)
Add these rows to the eye-test queue in `docs/url-flags.md` (task 14 owns the flag-table diff; this is the **checklist** content, format-matched to the `ambientBaked` "Pending 1070 ear-test (BATCHED)" style at `:144`). One session, one set of URLs:

| View / URL | Inspect | PASS criteria |
|---|---|---|
| Forested LB (e.g. near Holtburg outskirts), `?treeWind=on` | Canopy + foliage of `0x02001063` (fern), `0x020007A2` (shrub), tall `0x02000258` | Bases **planted** (no sliding/floating); canopy **sways**, trunk barely moves; **no joint cracking** between parts; **no z-fight** with terrain |
| Same view, `?treeWind=off` | Same trees | **Frozen, identical to pre-feature build** (A/B against a `treeWind` absent build — this is the visual twin of `test_wind_off_frozen.mjs`) |
| Same view, `?treeWind=on&treeWindStrength=2` and `=0.2` | Sway amplitude | Stronger ⇒ visibly larger sway, still planted; weak ⇒ subtle rustle; no clipping through ground at high strength |
| Storm vs clear (toggle weather) | Gust coupling (task 12) | Gusts stronger during `is_storm`; calm otherwise |
| Pan camera across a dense forest, watch fps overlay | Perf | **No regression vs `=off`** at the CPU-bound ~20fps outdoor baseline; uniform-only updates on the bulk (no per-instance CPU); `window.__diag.windTrees.lodTier` shows far trees in `frozen`/`far`, near in `near` |
| LRU stress: run to a far LB and back | Eviction | No leaked wind nodes (`__diag.windTrees.instances` returns to baseline), no disappearing/duplicated trees |

PASS = all six rows green; record results in the flag's doc row exactly like the `cellStaticMultiSurface` "eye-test PASSED 2026-06-10" pattern (`:135`). Until then the flag stays **default-OFF, non-retail**.

---

## Risks & open questions

- **The off=frozen guard is only as good as the seam it inspects.** `test_wind_off_frozen.mjs` extracts the divert via regex import-stripping; if task 02 places the wind peel somewhere `consolidateStaticSingletons` can't be reached by the same `new Function` shim, the test silently tests nothing. *Mitigation*: assert the extracted factory actually exposes both the wind filter and `consolidateStaticSingletons`, and fail loudly (`process.exit(1)`) if either is missing — never SKIP-to-pass. Mirror the `locateThree()` SKIP guard (`test_static_batch.mjs:24`) ONLY for the THREE dependency, never for the unit under test.

- **No `Date.now`/`Math.random` in the sim/encode (established constraint).** The determinism asserts (tests 1, 3) are the enforcement, but they only cover what they sample. *Mitigation*: in test 1 and 3, run the generator twice and compare the FULL `Float32Array`, not a spot value, so any stray nondeterminism surfaces.

- **VAT vertexId ↔ adapter triangulation order is assumed, not proven end-to-end** here. `test_vat_encode.mjs` checks a synthetic non-indexed buffer; it can't see whether `adapter.js:meshToGeometryGroups` (task 04) emits the same vertex order the offline bake assumed. *Open question*: do we need a golden-vertex-order fixture exported from the real adapter (a small fetched tree DID) to pin this? Recommend a follow-on `test_vat_vertex_order.mjs` that fetches one real tree mesh through the adapter (browser/MCP path) and diffs vertex order against the bake manifest — flagged as the single highest-risk integration seam.

- **Perf regression is a visual/eye-test only.** Node tests can't measure the 1070 frame budget. *Mitigation*: make `diag.windTrees` cheap (census ≤1 Hz, not per-frame) so the diag itself never costs frames, and make the eye-test perf row a hard PASS gate. Consider a `performance_start_trace`/`performance_stop_trace` capture (chrome-devtools MCP) over a forest pan as a semi-automated perf artifact attached to the eye-test results.

- **The 512 cap (`animSceneryMax`, `animated_scenery.js:336`) silently drops near-field trees in a dense forest.** *Mitigation*: `test_wind_smoke.mjs` asserts `droppedOverCap` is counted (no-silent-cap rule) and the eye-test perf row watches for popping at the cap boundary. The bulk forest must ride the shader/VAT path, NOT the capped player — so the diag's `lodTier.near` count should stay ≤ cap by construction; assert that invariant once task 13's crossover lands.

- **Open: should the off=frozen golden be a committed fixture or computed in-test?** Computing it in-test (run `consolidateStaticSingletons` twice, with and without the wind import inert) is more robust to THREE version drift than a committed byte-golden. Recommend in-test computation — it can't go stale.
