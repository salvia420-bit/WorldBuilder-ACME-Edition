# The 3.42 ms is not per-object glue — a census, and the one lever in it

Successor to `2026-08-06-frame-remainder-probe.md` and to the split `frame_split.js`
produced (commit `4e9be06d`, 549 world `render()` calls, 1070 at Nanto, quality `mid`,
`?renderScale=1&adaptiveRes=off`):

| bucket | ms/call |
|---|---|
| `sceneSubmit` minus draws | **3.42** |
| `preProject` (`scene.updateMatrixWorld`) | 2.06 |
| `project` (`projectObject`) | 1.54 |
| `sort` | 0.16 |
| `shadow` | 0.002 (dutyCycle 0 at `mid`) |

The brief for this document was: **3.42 ms across ~470 submitted objects is 7.3 µs per
submitted object; census what WE bolt onto that path and price each contributor.**

The census came back with a different answer than the brief expected, and the correction
is the most useful thing on this page. **7.3 µs/object was never plausible.** Three's
entire per-object glue benches at **70.7 ns**. The block is not per-OBJECT at all — it is
per-INSTANCE, over a population of ~13,000, and it arrives inside `sceneSubmit` because
three calls `BatchedMesh.onBeforeRender` from `renderObject`.

Everything with a number attached below is measured. Where it is a projection it says so,
and it says which direction it is likely wrong in.

---

## 1. What is actually inside the `sceneSubmit` bucket

`frame_split.js` brackets `sceneSubmit` from the end of the shadow phase to
`scene.onAfterRender`, and subtracts the `renderBufferDirect` time it measured inside that
window (`sceneSplit.minusDrawsMs`). Read against three r184's `render()` body
(`three.module.js` :17638-17719), that window contains exactly:

1. `currentRenderState.setupLights()` (:17655)
2. `renderTransmissionPass(...)`, **only if** `currentRenderList.transmissive.length > 0`
3. `background.render(scene)`, **only if** `_renderBackground`
4. `renderScene(...)` → three `renderObjects` loops → per item, `renderObject`
5. `textures.updateMultisampleRenderTarget` + `updateRenderTargetMipmap` (:17697-17707)
6. `output.end(...)`, only if `useOutput`

And `renderObject` (:18056-18085) is, minus the draw:

```js
object.onBeforeRender( _this, scene, camera, geometry, material, group );
object.modelViewMatrix.multiplyMatrices( camera.matrixWorldInverse, object.matrixWorld );
object.normalMatrix.getNormalMatrix( object.modelViewMatrix );
material.onBeforeRender( _this, scene, camera, geometry, object, group );
/* renderBufferDirect — measured and subtracted */
object.onAfterRender( _this, scene, camera, geometry, material, group );
```

plus `object.layers.test( camera.layers )` in the `renderObjects` loop above it.

**`objHookMs` was not armed for the 3.42 ms run**, so `sceneSplit.glueAndLightsMs` read
null and `BatchedMesh.prototype.onBeforeRender` is folded into the 3.42 rather than
separated from it. That is the whole misreading: the bucket's name says "scene submit
minus draws", and it was read as "glue".

---

## 2. The census, ranked, at the scale each item actually has

Node 22, this laptop, against the **real r0.184.0 build** (`node_modules/three` — pinned to
the same 0.184.0 the `index.html:969` importmap serves; that equality is checked, not
assumed). Bench in §3. Populations are the ones the earlier docs measured at Nanto:
**~470 SUBMITTED objects**, of which **~206 are `BatchedMesh`**, carrying **~13,000 walked
INSTANCES**; the resident scene is ~5,073 nodes and is not this bucket's scale.

| # | contributor | owner | unit | population | ms/frame |
|---|---|---|---|---|---|
| 1 | `BatchedMesh.prototype.onBeforeRender` — the per-instance multidraw walk | **three's code, OUR configuration** | 93–122 ns/instance | ~13,000 instances | **~1.2–1.6 measured-unit / ~3.3 by the live regression** |
| 2 | three's full per-object glue (6 ops above) | three, unavoidable | **70.7 ns/object** | 470 objects | **0.033** |
| 3 | `currentRenderState.setupLights()` + `setupLightsView` | three, **our pool size** | O(lights) | 21 lights (16 point + 2 spot + sun + ambient + hemi) | **<0.02** (est.) |
| 4 | `blood_decals.js:447` `mesh.onBeforeRender` (the ageing clock) | **ours** | one closure | **1 mesh** | **~0.000** |
| 5 | `?statBatchMemo` override | ours | — | **0 — default OFF** | 0 |
| 6 | `armStatMergeSubmittedSampler` (`static_atlas.js:1995`) | ours | — | **0 — manual arm only** | 0 |
| 7 | `renderTransmissionPass` | three | — | **0 — no `transmission > 0` material in the tree** | 0 |
| — | everything else in §1 | three | once per frame | 1 | noise |

**Item 2 is the answer to the brief as asked, and it is 0.033 ms.** Even multiplied by 4
for an unknown-CPU margin it is 0.13 ms. There is nothing to reduce there: the two matrix
ops are 79 ns of the 71 ns total (they overlap because they are benched separately), the
three hook calls are prototype no-ops at ~10 ns each, and `layers.test` is 2 ns.

**Item 4 is the only per-object hook this tree installs on a bare-default `mid` boot.**
One mesh. That is the entire answer to "which of our `onBeforeRender` handlers are live".

Item 1 is the block. Its two unit figures disagree and the disagreement is informative:
the node bench says 93–122 ns/instance for three's unsorted branch and ~250 ns for its
sorted branch, while `2026-08-06-frame-cost-structure-measured.md` §5a regressed the live
1070 buckets at **348 ns/instance**. A slower CPU, ~200 buckets' worth of cache misses that
a single-bucket bench cannot reproduce, and a mix of both branches all push the same way.
**Take the ratio from the bench and the absolute level from the live regression** — that is
the only combination either measurement supports.

### 2a. Why 3.42 here and 5.72 in the earlier session

`2026-08-06-frame-cost-structure-measured.md` §2 measured `BatchedMesh.onBeforeRender`
directly at **5.72 ms**. If it is inside the 3.42, something got cheaper in between. It
did: **`?clipMapOpaque` shipped between the two sessions** and set `transparent = false` on
50 ClipMap materials. `static_batch_x.js` derives `bm.sortObjects = !!mat.transparent`, so
those buckets moved from three's **sorted** branch to its **unsorted** one — 250 ns to
~110 ns per instance on the bench, a 0.44 ratio — and the ClipMap population is where the
statics instance mass lives. 5.72 × ~0.6 ≈ 3.4. That is a consistency check, not a proof;
`__frameSplitArm({objHooks: true})` settles it in one read and is the first thing to run.

---

## 3. The bench

No GL context is needed for any of this — every op is pure JS. Save as `bench.cjs` beside
`node_modules` and run with `node bench.cjs`.

```js
const THREE = require("./node_modules/three/build/three.cjs");   // r184, the pinned one
const cam = new THREE.PerspectiveCamera(60, 1.6, 0.1, 800);
cam.position.set(0, 12, 0); cam.updateMatrixWorld(true);
cam.matrixWorldInverse.copy(cam.matrixWorld).invert(); cam.updateProjectionMatrix();

// --- three's per-object glue, exactly :18046-18085 minus the draw ---
const o = new THREE.Mesh(); o.position.set(3, 4, 5); o.updateMatrixWorld(true);
o.material = new THREE.MeshBasicMaterial();
const glue = () => {
  o.layers.test(cam.layers);
  o.onBeforeRender(null, null, cam, null, o.material, null);
  o.modelViewMatrix.multiplyMatrices(cam.matrixWorldInverse, o.matrixWorld);
  o.normalMatrix.getNormalMatrix(o.modelViewMatrix);
  o.material.onBeforeRender(null, null, cam, null, o, null);
  o.onAfterRender(null, null, cam, null, o.material, null);
};
for (let i = 0; i < 50000; i++) glue();
let t = process.hrtime.bigint();
for (let i = 0; i < 1e6; i++) glue();
console.log("glue", Number(process.hrtime.bigint() - t) / 1e6, "ns/object");
```

Three runs, this laptop:

| op | ns |
|---|---|
| `layers.test` | 2.0 / 2.2 / 2.4 |
| `onBeforeRender()` prototype no-op | 8.5 / 9.7 / 9.9 |
| `modelViewMatrix.multiplyMatrices` | 51.1 / 51.8 / 57.0 |
| `normalMatrix.getNormalMatrix` | 25.6 / 29.6 / 30.3 |
| **full glue, one object** | **72.7 / 78.9 / 79.8** |
| `_patchSetCacheKey` (our `customProgramCacheKey`) | 24.5 / 24.7 / 42.6 |

The per-instance half, with the same rig building a `BatchedMesh` of `n` boxes spread over
a patch wide enough that a 60° camera culls most of them
(`perObjectFrustumCulled = true`, exactly as `static_batch_x` sets it):

| instances | three's unsorted branch | three's sorted branch | cached local sphere (§5) |
|---|---|---|---|
| 64 | 99 / 122 ns/inst | 255 / 229 ns/inst | 19–20 ns/inst |
| 256 | 93 / 117 ns/inst | 249 ns/inst | 16–19 ns/inst |
| 1024 | 93 / 114 ns/inst | 257 ns/inst | 15–16 ns/inst |
| — | | | **5.0–7.5×, survivor sets byte-identical** |

And three's own early-out — the one `static_batch_x` makes unreachable — costs **30.5 ns
per call**, i.e. free.

---

## 4. Tombstones — priors from the brief, each killed by reading

Recorded because each was reasonable and three of them were the brief's own.

### 4a. `customProgramCacheKey` — NOT IN THIS BUCKET AT ALL

three calls it in exactly one place: `WebGLPrograms.getParameters` (`three.module.js`
:7752), which is called from `getProgram`, which is called from **`setProgram`, the first
statement of `renderBufferDirect`**. So every `customProgramCacheKey` invocation is inside
the 12.78 ms draw funnel and was subtracted out of the 3.42 before anyone looked at it.
The same disposal applies to the `static_atlas.js` array variant and the VFX per-instance
patch. Its size, for the record, is 24–43 ns per call, and after `?bmColorTextureFix` the
tree makes ~78 `getProgram` calls per frame — so **0.003 ms**, which would not be worth
touching even if it were in the right bucket.

### 4b. `onBeforeCompile` chains — no churn to find

The concern was a churning cache key forcing recompiles. `_chainBeforeCompile`
(`materials.js`) installs the key lazily from `userData` and the flag bits it encodes are
set once at patch time. The measured churn source was found and fixed already: three r184
reads `object.colorTexture` on a `BatchedMesh` (a property three never defines — its field
is `_colorsTexture`), so `needsProgramChange` fired on every BatchedMesh every frame.
`three_batchedmesh_colortexture_fix.js` aliases it, is **default-ON**, and measured
`getProgram` 258/frame → 78/frame, renderCPU −3.35 ms. **The "160 program switches against
79 distinct programs" figure predates that fix.** Nothing further to collect here.

### 4c. `createPartFramesProxy` — not on the render path

`setup_rig.js:190` / `entities.js:4823`. Read as `parent.partFrames[i]` by
`particle_emitter.js:336`, `particle.js:179` and `setParenting` — the **sim tick**, outside
`renderer.render()` entirely, and per emitter rather than per submitted object. Not in this
bucket, and not per-object.

### 4d. Per-object `userData` walks / `.visible` chains — none exist in this window

The only `.visible` ancestor chain in `static_batch_x` is `_bucketDrawn`, which runs from
the **census**, not from a render. `Object.defineProperty` on a hot prototype appears twice
in the tree: `three_batchedmesh_colortexture_fix.js` (a two-line getter, inside the funnel,
and it removes far more than it adds) and `texture_census.js:218`, which is a strict
`?texCensus=on` opt-in and installs nothing by default.

### 4e. `materials.js` wireFill — wireframe mode only

`?wireFill` gates the solid-fill companion pass, which exists only under `?wireframe=1`.
Not present on a bare-default `mid` boot.

### 4f. The two-pass double-sided transparent submit — already fixed

`renderObject`'s `material.transparent && side === DoubleSide && !forceSinglePass` branch
submits the geometry twice AND sets `needsUpdate = true` twice, forcing two program
re-resolves per object per frame. `applyRetailSinglePass` (`materials.js`) sets
`forceSinglePass`, is **default-ON** since the measurement recorded at `materials.js:1680`
(−11% draws, 50 → 33.3 ms p50), and closes it.

---

## 5. `?statBatchSphere` — the one lever the census found

**Default OFF. Output-identical. `docs/url-flags.md` carries the full row.**

### What three recomputes and never needed to

Per instance, per frame (`three.core.js` r184 :27331-27360):

```js
this.getMatrixAt( i, _matrix );                                   // 16 texture-array reads
this.getBoundingSphereAt( geometryId, _sphere ).applyMatrix4( _matrix );  // + getMaxScaleOnAxis: 3 lengths, a sqrt
culled = ! frustum.intersectsSphere( _sphere, camera );           // 6 plane dots  <- the actual question
```

A static placement's local-frame world sphere is a pure function of its instance matrix and
its geometry's bounds. **Neither changes between frames.** The camera enters only through
the frustum, which three already composes **once per bucket per call** (:27251-27262) in
that same local frame. So the first two lines are cacheable in full and the third is not.

`=on` computes those spheres once per bucket into a `Float64Array` of `[cx, cy, cz, r]`
quads and walks them. Measured: **93–122 → 15–19 ns/instance, 5.0–7.5×**, with the survivor
set and the multidraw arrays byte-identical.

### Why this is the complement of `?statBatchMemo` and not a duplicate

| | invalidated by | parked | moving |
|---|---|---|---|
| `?statBatchMemo=on` | **the camera** | −2.3 ms | **+0.5 ms WORSE** |
| `?statBatchSphere=on` | **placement changes** | helps | **helps identically** |

A moving camera invalidates the memo every single frame, which is exactly why the head
commit records its moving arm as unresolved and the flag as default-OFF because of it. A
moving camera does not move a placement, so it does not touch this cache. They compose on
one seam: with both on, the memo owns `onBeforeRender` and rebuilds its **misses** through
the cache.

The sphere-only override deliberately does **not** carry the memo's per-call bookkeeping
(two 16-float compares, a camera decompose, a state write-back). That bookkeeping is the
named cause of the memo's +0.5 ms moving regression, and this flag exists for the moving
case, so it must not inherit the cost that broke it.

### Projection, and the direction it is wrong in

Taking the ratio from the bench and the level from the live regression: the walk's
per-instance cost drops by ~82%, applied to the ~3.3 ms this block costs at Nanto gives
**~2.4–2.8 ms**. **Expect less than that, for two named reasons:**

* Only `sortObjects === false` buckets are eligible. three's sorted branch needs its
  module-private `_renderList`, and this file's existing discipline refuses to transcribe
  it (a re-implementation would be a second sort with its own tie-breaking). `walk.slots
  .drawnSorted` vs `walk.slots.drawn` is the live read of how much of the mass that
  excludes, and `?statBatchNoSort=on` is what widens the eligible population.
* A single-bucket node bench does not reproduce the cache-miss behaviour of ~200 live
  buckets, and the *cached* loop is the more memory-bound of the two, so it has more to
  lose from that than three's does.

Five estimates on this workload have collapsed by 2× or more under measurement. This one
should be assumed to be in that family until the 1070 says otherwise.

### The cost side, stated

* **32 bytes per instance SLOT** — ~850 KB at the 26,586-instance resident scale. Reported
  live as `walk.sphere.bytes`, and it is a LIVE total: `_reapBucketIfEmpty` subtracts a
  reaped bucket's bytes back out, because a high-water mark wearing a live-total name is a
  reporting bug this file has already made once (`deadBatch.triangles`, §5c of the
  frame-cost doc).
* **One rebuild per bucket per epoch.** `walk.sphere.slotsBuilt` is the price;
  `walk.sphere.slotsWalked` is what got 5–7× cheaper. If `slotsBuilt` keeps pace with
  `slotsWalked`, something is bumping the epoch every frame and the cache is worth nothing.
  Check that ratio before believing any ms figure.

### Why the invalidation is right

The cache reuses the epoch `?statBatchMemo` already maintains, bumped by every membership
change, by `optimize()`, by a `sortObjects` flip, and by the feed's `setMatrixAt` — which
three does **not** flag via `_visibilityChanged` (`three.core.js` :26770). That hole is the
reason the epoch exists at all, and it is the exact hazard this cache would otherwise hit.

Values are `Float64` and computed by three's own expression on inputs that have not
changed, so a cached sphere is **bit-identical** to the one three would compute — not an
approximation, and the tests assert byte-identity rather than a tolerance. `r < 0` is the
skip sentinel and preserves `_memoBuildSlack`'s guard against a stale `geometryIndex`
(three's own loop has no such guard; drawing that instance would emit another geometry's
byte range).

Every failure path — a sorted bucket, an array camera, a malformed batch, any exception —
falls back to `BatchedMesh.prototype.onBeforeRender` untouched and is counted.

### Tests

`test_stat_batch_walk.mjs` §12-16, 24 new checks (79 total, up from 55), against the real
r0.184.0 build. The load-bearing ones:

* the cached build is **byte-identical to what three's own loop just wrote**, at four poses
  of a **moving** camera, with the arrays wiped between so a no-op fails loudly;
* the cache is built **once** across those four frames — a moving camera does not
  invalidate it, which is the property that distinguishes this from the memo;
* a `setMatrixAt` feed **does** invalidate it, the array grows past its first allocation,
  and the rebuilt answer is still byte-identical;
* a sorted bucket is **declined**, counted as ineligible, and falls through to three;
* cache bytes are held while the bucket lives and return to **0** when it is reaped;
* `=verify` is clean on the happy path **and reports a hand-corrupted entry** — a verifier
  that cannot fail is not a verifier;
* both flags on: the memo owns the seam, still hits on a still camera, and its **miss**
  rebuilt through the cache is byte-identical to three's;
* a slot that goes live while carrying the skip sentinel is **healed in place and counted**
  (`walk.sphere.lateActivations`), not dropped, and the heal is sticky.

That last one is a guard against something that should be unreachable — every
`addInstance` path ends in `_memoDirtyBounds` — and it is there because the failure mode if
it ever *is* reachable is a placement that silently does not draw, with nothing in any
counter to say so. **The branch measured free**: the cached walk is 14.8–20.6 ns/instance
with it, against 15–19 without.

---

## 6. What to run on the 1070

Settled Nanto, `?quality=mid&renderScale=1&adaptiveRes=off&nosw=1`. Settle `draws/frame`
before sampling. `renderer.info.autoReset = false`.

```js
// 0. FIRST — close §2a. This is one read and it decides whether any of the above
//    is aimed at the right thing. Requires ?statBatchMemo=off (it refuses to
//    double-wrap a prototype that already carries an override).
// There is no `window.THREE`; take the constructor off a live bucket instead.
let bmCtor = null;
liveScene3d.scene.traverse((o) => { if (!bmCtor && o.isBatchedMesh) bmCtor = o.constructor; });
__frameSplitArm({ objHooks: true, batchedMeshCtor: bmCtor })
//    ... 10 s ...
__frameSplitDisarm(); __frameSplitReport()
//    read: sceneSplit.objHookMs vs sceneSplit.minusDrawsMs.
//    If objHookMs is ~3.2 of the 3.42, this document is right and step 1 is worth
//    running. If it is small, the 3.42 is something none of us has named and
//    ?statBatchSphere is aimed at the wrong ms — say so and stop.
```

```js
// 1. The flag, WHILE WALKING first — that is the case it exists for.
//    A/B/A/B inside one page load where possible; two boots differ 40% in bucket count.
//    ?statBatchSphere=on   vs   bare default
```

Score, in this order:

1. **p50/p95 while moving**, then parked. Moving is the claim; parked is the control.
2. `window.__statBatchXStats().walk.sphere` — sample, wait N displayed frames, sample
   again, and read `slotsWalked` against `slotsBuilt` on the deltas. Also
   `walk.slots.drawnSorted / walk.slots.drawn`, which is how much of the mass the sorted
   exclusion costs — and if that is large, re-run with `?statBatchNoSort=on` added.
3. `renderer.info.render.calls` and `ktris` must be **IDENTICAL** between arms. This
   changes neither geometry nor draw count, only how the same multidraw is computed. A
   moved draw count means the identity broke and the arm is void.
4. One boot at `?statBatchSphere=verify` with `walk.sphere.verifyFails === 0` and
   `walk.sphere.errors === 0`.

**No eye-test is owed if (3) holds** — that is the point of an output-identical change, and
it is the one thing on the current board that does not need your eyes.

---

## 7. What is NOT worth doing, from this census

* **Anything aimed at three's per-object glue.** 0.033 ms. Even a perfect fix is invisible.
* **Shrinking the light pool to cheapen `setupLights`.** Under 0.02 ms, and the pool's
  fixed count is load-bearing for program-cache stability (a light-count change bumps
  `lights.state.version`, which forces `needsProgramChange` on every lit material).
* **The `static_atlas` and `terrain_batch` buckets.** They set the same
  `perObjectFrustumCulled = true` and pay the same per-instance walk, so the cache would
  apply — but the atlas admits ~120 props against `static_batch_x`'s ~26,586 instances, and
  terrain is one bucket. Widening the change surface for that is not justified until the
  1070 confirms the mechanism on the population that has the mass.
