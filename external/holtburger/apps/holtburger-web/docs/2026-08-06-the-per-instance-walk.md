# The per-instance walk — what is actually in the 5.72 ms (2026-08-06)

Follows `2026-08-06-frame-cost-structure-measured.md` §5a, which established the number this
document is about:

```
BatchedMesh.onBeforeRender = 5.72 ms/frame
  = 5.9 µs FIXED per bucket  +  0.348 µs PER INSTANCE     (r² = 0.876)
  ~80% per-instance, over ~26,586 resident / ~13,195 drawn-bucket instances
  model check: 197 × 5.9 µs + 13,195 × 0.348 µs = 5.74 ms vs 5.75 observed
```

Everything below is **source reading plus that measurement**. Nothing here has been run on a
GPU. Where a number is a projection it says so, and the projections are stated as ranges
because every estimate in this investigation has so far collapsed 2–10× under measurement.

---

## 1. The premise that turned out to be wrong, and the one that replaced it

The brief said three r184 "rebuilds the multidraw arrays unconditionally every frame". It does
not. `three.core.js` r184 `:27214-27222`:

```js
onBeforeRender( renderer, scene, camera, geometry, material ) {
    // if visibility has not changed and frustum culling and object sorting is not required
    // then skip iterating over all items
    if ( ! this._visibilityChanged && ! this.perObjectFrustumCulled && ! this.sortObjects ) {
        return;
    }
```

**three already ships the dirty check. We disable it, on every bucket, on every frame.**
`static_batch_x.js` `_getOrCreateBucket` sets `perObjectFrustumCulled = true` (:480) and
`sortObjects = !!mat.transparent` (:479), and either one alone defeats the early-out.

That also resolves a puzzle §3d left open. Turning `perObjectFrustumCulled` off saved only
**0.40 ms of 5.72**. If that had unlocked the early-out, essentially the whole 5.72 ms would
have gone — the buckets would have returned on statement one. It did not, because the
early-out *also* requires `!sortObjects`. So the buckets that kept paying in that arm were the
**transparent** ones, which take three's other and more expensive branch:

| branch | per instance | plus |
|---|---|---|
| `sortObjects === false` (:27331-27360) | `getMatrixAt` + `getBoundingSphereAt().applyMatrix4()` + 6 plane tests | writes 3 array slots |
| `sortObjects === true` (:27273-27327) | the same, unconditionally (the z needs the sphere) | `_renderList.push` per survivor, **`list.sort()`** (n log n, function-call comparator), then a second pass over the sorted list |

And the statics instance *mass* is transparent: `applyClipMapRenderState` (materials.js) sets
`transparent = true` on ClipMap surfaces — foliage, fences, the high-count props — which is the
same population §5b found filling half the frame's draws.

> ⚠ **This is an inference, not a measurement.** It is consistent with §3d and §5b, but the
> sorted/unsorted split of statics buckets has never been read directly.
> `getStatBatchXStats().walk.slots` now reports it (`sorted` vs `all`, `drawnSorted` vs
> `drawn`) and works **with both new flags off**. That one read confirms or kills the whole
> premise of §2 below, and it should be the first thing done on the 1070.

---

## 2. What was built

Two flags, both default-OFF, both in `scene3d/static_batch_x.js`, both attacking the
per-instance 80% rather than the bucket-count 20% that four previous changes have already
proved is worth ~0 ms. Full rationale is in `docs/url-flags.md`; this is the shape.

### `?statBatchNoSort=on` — make the walked instance cheaper

Sets `sortObjects = false` on buckets whose material's blend cannot depend on draw order. A
bucket is ONE material by construction (`byMat` keys on the material object, and that same
object is `bm.material`), so the proof is per bucket and needs no population argument:

* `depthWrite === true` — a depth-writing alpha **mask**. ClipMap is `alphaTest 0.784`,
  opacity 1; the z-buffer resolves overlap, so range order cannot change a pixel.
* `AdditiveBlending` — addition commutes.

Everything else keeps its sort. This is deliberately a **weaker** claim than §5e's eye-tested
ClipMap change: that one moved materials into the opaque pass, changing inter-object depth
sorting *and* blending. This changes only the order of ranges inside one bucket of one
material — same pass, same blend, same alpha reference, same material.

**Projected: 0.8–2.0 ms**, and the low end is the honest expectation. Derivation: the sort
machinery (push + n log n comparator + second pass) is plausibly 30–45% of the 0.348 µs; if
~80% of drawn instances sit in sorted buckets, `0.8 × 4.59 ms × 0.35 ≈ 1.3 ms`. Both the 80%
and the 35% are guesses. `walk.slots.drawnSorted` replaces the first one with a fact.

### `?statBatchMemo=on|exact|slack[:m[:deg]]` — stop walking a bucket that cannot have changed

Re-implements three's own dirty check *without* giving up per-instance culling. Records every
input the rebuild read — `camera.matrixWorld`, `camera.projectionMatrix`, `this.matrixWorld`,
`sortObjects`, `perObjectFrustumCulled`, `material.wireframe`, index type, material and camera
identity, three's `_visibilityChanged`, plus our own epoch — and skips the rebuild when all of
them are bit-identical.

The epoch is load-bearing: three sets `_visibilityChanged` on `addInstance`, `deleteInstance`,
`deleteGeometry`, `setGeometryAt` and `optimize`, but **not** on `setMatrixAt` (`:26770`). The
epoch is bumped at every site that already nulls `boundingSphere` — which are exactly the
membership-change sites — plus `optimize()` and a `sortObjects` flip.

* **`=on` / `=exact`** is output-identical, and also skips the per-frame
  `indirectTexture.needsUpdate = true` re-upload. **Projected: up to ~5.7 ms standing still,
  ~0 while moving.** A moving camera changes the view matrix every frame. Do not sell this as
  a movement win.
* **`=slack`** is the movement half. It rebuilds through a frustum dilated by
  `trans + rot × r` — `r` being the camera-to-instance distance, so this is an *angular*
  dilation — which makes the cached answer a provable **superset** of the exact answer for any
  camera that has since translated ≤ `trans` and rotated ≤ `rot`. Nothing visible is dropped;
  a few extra ranges are drawn.

  Over-inclusion is affordable only because §1 measured this frame **CPU-bound**: 8.2× fewer
  pixels changed nothing, and §3d's +420k triangles cost ~0 ms. Extra ranges are therefore
  paid at the draw side's 0.038 µs/instance, not on the GPU.

  **Projected: `(1−h)·5.72·(1+over) + h·0.2` ms** for hit rate `h` and over-inclusion `over`.
  At `h = 0.5, over = 0.3` that is **~2 ms saved**; at `h = 0.8`, **~4 ms**. `h` is not
  predictable from source — it depends entirely on how the camera actually moves — which is
  why `walk.hitsExact` / `walk.hitsSlack` / `walk.rebuilds*` are counted per call instead of
  modelled.

Sorted buckets get the exact tier only: the dilated loop transcribes three's non-sorted branch,
and `_renderList` is module-private in three, so a sorted bucket is rebuilt by three itself.
`?statBatchNoSort=on` is what moves that population into the slack tier — the two flags
compose, and the pair is the interesting arm.

**The transcription is the real risk**, because a wrong multidraw byte offset draws another
geometry's triangles. `test_stat_batch_walk.mjs` (55 checks) therefore asserts, against the
real r0.184.0 build, that with both margins at **zero** our loop's `_multiDrawStarts`,
`_multiDrawCounts`, indirect array and `_multiDrawCount` are byte-identical to what three's own
loop just wrote — and separately that the dilated set is a superset of the exact set at 8 poses
on the boundary of the validity region.

---

## 3. What was rejected, and why

### 3a. Distance / LOD culling at FEED time — rejected on a structural fact

`statics.js` does have LOD-band machinery, and it is more developed than the brief implies:
`LOD_DISTANCE_M = 100`, `deriveLodDistances` (strictly-ascending authored `lodDist` per band,
mirroring `acclient.c:332374`), one degraded leaf per band in a `THREE.LOD`, and
`tagBillboardLod` for the per-band `degrade_mode`.

**But none of it touches this population.** `consolidateStaticSingletonsCrossLb`'s filter is
`n.isMesh && !n.isInstancedMesh && !n.isLOD` — an LOD-wrapped prop is pushed to `out`
verbatim and never enters a bucket. The batched population is, by construction, exactly the
props that have **no** degrade bands. Those are the 177 `static-batch-c` draws; the LOD
wrappers are part of the 49 `statics | Mesh` draws. Extending LOD to them is a fidelity
project (it needs degraded DIDs that the DAT does not have for these models), not a lever on
this 5.72 ms.

### 3b. A per-instance distance cap in the walk — rejected on arithmetic, and it generalises

`?cullDist` exists (`CULL_DIST_SQ`, default `Infinity`) and `cullStaticsGroup` explicitly skips
`isBatchedMesh` nodes. Adding a far cap inside the batch walk is easy — `_memoBuildSlack`
already computes the camera distance for its margin — but it **cannot move the 0.348 µs**:

> **Any per-instance test still walks the instance.** Distance, LOD, size-on-screen, anything.
> They all reduce the ranges *submitted*, which is the draw side's 0.038 µs/instance — an
> order of magnitude cheaper than the walk they do not avoid.

The only two ways to reduce instances *walked* are (a) don't have them resident, and (b) don't
run the walk. §2 is (b). §3c is (a).

### 3c. A smaller resident set — rejected as a fidelity dial, not a perf lever

Residency is 26,586 instances; the walk touches ~13,195, because it only runs on buckets that
survived node-level frustum culling. Those two populations are **not proportional**: the
in-frustum set is concentrated near the camera, while shrinking `staticsRadius` removes far
landblocks first. Cutting radius 6 → 4 removes 52% of resident landblocks and a much smaller
fraction of walked instances — for a visible draw-distance regression, plus the documented
re-decode churn on every re-approach, plus interaction with a memory governor that already
parks landblocks. Wrong tool.

### 3d. Splitting buckets spatially — rejected on an existing measurement

The appeal is real: a node-culled bucket costs **zero** `onBeforeRender`, because three never
calls it. So finer buckets do shrink the walk. It has already been measured, in the other
direction, by §5d Lead 2 — `?statBatchChunk=off` raises bucket count 356 → 1324 with
`ktris` identical in both arms:

| arm | buckets | draws/frame | p50 |
|---|---|---|---|
| default | 356 | 437.8 | **27.8 ms** |
| `statBatchChunk=off` | 1324 | 633.4 | 38 / 35.1 ms |

**+196 draws → +8.8 ms.** Even generously assuming a 4× split trims 30% of the walk
(≈ 1.4 ms), the draw-side fixed cost of 37.6–45 µs per added draw swamps it several times
over. Splitting is measured-negative and should not be re-proposed without a way to add
buckets without adding draws.

### 3e. `perObjectFrustumCulled = false` — already ruled out, and now explained

§3d of the frame-cost doc measured it at 0.40 ms saved for +420k triangles. §1 above explains
*why* it was only 0.40: the early-out it was supposed to unlock needs `!sortObjects` too. This
matters going forward — with `?statBatchNoSort=on` the same experiment would behave very
differently, which is a reason to re-run it as a diagnostic, **not** a reason to ship it. The
memo gets the same skip while keeping the cull.

---

## 4. Ranked, with projected ms

| # | change | projected | confidence | why |
|---|---|---|---|---|
| 1 | `?statBatchMemo=on` | **~5.7 ms standing still, ~0 moving** | high on the mechanism, unknown on how much of a session is "still" | output-identical; the whole function returns |
| 2 | `?statBatchMemo=slack` + `?statBatchNoSort=on` | **~2–4 ms moving** | low — `h` is unknown | superset-safe; needs the hit rate measured before the margins are swept |
| 3 | `?statBatchNoSort=on` alone | **0.8–2.0 ms** | medium; rests on the sorted-share inference | removes the n log n sort from the biggest population |
| — | everything in §3 | ≤ 0, or fidelity cost | — | see above |

## 5. What to measure on the 1070, in order

Settled Nanto, quality `mid`, `?renderScale=1&adaptiveRes=off`, arms toggled **within one page
load** (§7: two boots have differed 40% in bucket count), `renderer.info.autoReset = false`.

1. **First, with no flags at all**: `window.__statBatchXStats().walk.slots`. If
   `drawnSorted / drawn` is small, §2's `?statBatchNoSort` projection is wrong and #3 above
   drops off the board. This costs one line and re-bases everything else.
   Also read `slots.all` vs `instances` — divergence means eviction churn is leaving dead
   instance slots that are re-tested every frame.
2. **`?statBatchMemo=on`, standing perfectly still**, then walking. Two separate p50/p95
   numbers — they are effectively two different flags. Sample `walk` before and after N
   displayed frames and check
   `(Δhits × 5.9 µs + ΔinstancesSkipped × 0.348 µs) / N` against the frame-time delta. If the
   model over-predicts, the §5a regression is what needs revisiting, not this flag.
3. **`?statBatchMemo=slack&statBatchNoSort=on`, walking and mouse-looking.** Watch `ktris`:
   unchanged under `=on`, up under `=slack` by the over-inclusion. **If it is up by anything
   like §3d's +81%, the margins are far too big** — halve them before reading p50.
   `walk.errors` must be 0.
4. Only if (3) says the hit rate is the binding constraint, sweep
   `?statBatchMemo=slack:16:5` / `slack:4:1.5`.
5. **Eye-test owed for `?statBatchNoSort`**: swaying foliage and any overlapping translucent
   prop. Cheap — the arms are one page-load apart. `ktris` and `renderer.info.render.calls`
   must be **identical** between its arms; a moved draw count means something else drifted.

⚠ Measuring submitted scale with `window.__statMergeArmSubmitted` does **not** work while
`?statBatchMemo` is on: that sampler skips any node that already owns an `onBeforeRender`, so
it reports our buckets as armed and never counts them. Use `walk.calls`, which counts the same
thing and is always live.

---

## MEASURED ON THE 1070 (2026-08-06, parent) — the prediction held, including the bad half

The design's headline claim was "~5.7 ms standing still, ~0 moving". Measured, it is
directionally right and smaller: a real win parked, and a small **regression** moving.

### Step 1 — the census re-based the plan before any A/B

`__statBatchXStats().walk.slots` with no flags, settled Nanto:

```
all 26,347 · sorted 2,061 · drawn 26,308 · drawnSorted 2,022 · sortedBuckets 23
```

**Only 7.7% of walked instances sit in sorted buckets**, so `?statBatchNoSort` drops off the
board exactly as the design said this census would decide. It also falsifies one of the
design's own premises — "ClipMap foliage/fences are `transparent = true`, and that is where
the statics instance mass lives". That was true when written and is not true now:
`?clipMapOpaque` shipped the same morning and moved those 50 materials into the opaque pass.
An inference about a live population aged out within hours of being written.

### Step 2 — `?statBatchMemo=on`, parked vs moving, both conditions inside each boot

| condition | memo off | memo on | delta |
|---|---|---|---|
| parked | 23.7 | **21.4** | **−2.3 ms** |
| moving (~54°/s yaw) | 23.9 / 24.0 | 24.3 / 24.6 | **+0.5 ms WORSE** |

A separate boot-arm A/B, parked only, measured 23.1 → 19.8/20.2, i.e. **−3.1 ms**. So parked
is worth ~2–3 ms, reproduced across two sessions.

Mechanism confirmed: `hitsExact` 150k–184k, ~17M instances skipped, **`errors` 0**.

**The moving regression is small but consistent** — both ON runs sat above both OFF runs. It
is the memo's own bookkeeping paid on every rebuild that does not hit. Moving is when frame
time matters most, so this is the number that decides whether the flag can ever be default-ON.

### Step 3 — the `slack` tier: mechanism proven, frame effect NOT measured

`?statBatchMemo=slack` cut rebuilds from ~65,000–68,000 to **3,666–3,905 (17×)** at
`errors 0`, which is exactly what the dilated-frustum design predicts.

**Its frame numbers are unusable and are not quoted.** In that session the BASELINE moved:
`memo=off` measured 19.6 parked / 20.0 moving, against 23.7 / 23.9 in the run above — a 4 ms
swing in the control — and the slack arm itself spread 21.2 → 18.5. With n=1 on the control,
nothing can be read from it. This is the same variance that made the overnight census
worthless; a 4 ms baseline swing swamps a ~2 ms effect.

### Status

Both flags stay **default-OFF**. `=on` is a genuine ~2–3 ms win for a standing player and a
~0.5 ms loss for a moving one; that trade needs an owner decision, not a default. `=slack`
needs a clean interleaved moving measurement — three arms per condition, one session, control
repeated between every arm — before it can be believed either way.

What is NOT in doubt: three's early-out at `three.core.js:27218` is real, `static_batch_x`
disables it on every bucket every frame, and skipping the walk is worth real milliseconds when
the camera is still.
