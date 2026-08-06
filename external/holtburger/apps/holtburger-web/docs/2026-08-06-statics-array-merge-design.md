# Array-texture merging for the cross-LB statics batcher — design, projection, and a recommendation against building it as scoped

**2026-08-06.** Successor to `2026-08-06-frame-cost-structure-measured.md` §5a/§6.2, whose
sizing of this item this document **supersedes twice over**. Nothing here is shipped; one
read-only instrument is added.

**Verdict up front (SUPERSEDED — see §0a, measured on the 1070: +2.48 ms for the scoped design and +3.9 ms with canonical tiers).** The honest reachable win is **~1.4–2.3 ms of a ~24 ms frame**, against a
ceiling of 3.68 ms, for a subsystem touching the layer pool, the shader, the material cache's
derived clones, eviction refcounting and the X7 memory ceiling — and validatable only by
1070 A/B plus an owner eye-test. Two changes shipped **today** bought 0.7 ms and 1.2–2.0 ms
for a fraction of that work. **Recommend against building it as scoped.**

There is one variant that clears the bar — canonical tile sizes, worth ~2.7–3.2 ms — and it
turns out to be a **bake-side** change rather than a client one, because `?texBc7` is
default-ON and a `CompressedArrayTexture` layer cannot be resampled at runtime. That is a
different task, and §6 specs it.

---

## 0c. CORRECTION to §0a AND §0b — every figure above was RESIDENT-scale. The prize is 2.00 ms.

§0a and §0b both priced the merge over `drawn.buckets`. **That population is not drawn.**
`_projDrawn` tests `visible` + `instances > 0` and never the frustum, so it removed 4 buckets
of 346. Two independent proofs:

* arithmetic: `batchBuckets 346 − blocked.deformed 193 = 153 = all.buckets.today`, exactly —
  so `blocked.deformed` counts BUCKETS, and the "drawn" split is resident-scale;
* consistency: 149 mergeable + 193 deformed = 342 static-batch-c draws, against **177**
  measured directly by attributing `renderBufferDirect`, and 129 in the region sweep.

A real submitted-scale sampler now exists (`__statMergeArmSubmitted`, which shadows
`onBeforeRender` and counts what three actually submits). Run on a settled Nanto session:

```
submitted BatchedMesh nodes: 128   =   60 mergeable  +  68 deformed
```

| population | submitted today | → regionStrict | → regionState | worth (strict) |
|---|---|---|---|---|
| mergeable | 60 | 35 | 19 | **+1.00 ms** |
| deformed (blocked today) | 68 | 43 | 22 | **+1.00 ms** |
| **combined** | **128** | **78** | **41** | **+2.00 ms** |

**So the array merge is worth ~1.00 ms, not the 2.9 ms of §0b or the 2.48 ms of §0a — and the
LARGER half of the remaining prize is the population this doc's gate analysis treats as
unmergeable.**

**The deformed half is reachable, and cheaply.** Sway already survives batching today:
`per_instance.js` derives `vVfxHash` under an explicit `#ifdef USE_BATCHING` from
`batchingMatrix[3].xy`; three r184 applies `batchingMatrix` after the `begin_vertex` seam
where windSwayGpu writes its object-space shear; and 206 live BatchedMesh buckets already
carry a windSwayGpu variant, because `_getOrCreateBucket` passes the member material through
verbatim. The `ptDeformed` gate is about MATERIAL SUBSTITUTION — the array material never
went through `buildFragVariant` — not about batching. Including `__vfxSetKey` in the bucket
key admits them, splits each class into at most two buckets (there is exactly one set in the
world, 206 of 206), and structurally cannot reproduce the 2026-07-02 "trunk sways, foliage
frozen" split, because membership and material would then be decided by the same key.

**Fourth 2× of this investigation, and the first one an instrument caused.** The pattern is
always the same: a population counted at residency and priced as if drawn. Every future
figure on this workload states its scale — resident, drawn, or submitted — or it is not a
figure. Raw sampler output: `RESULTS-stat-merge-SUBMITTED-2026-08-06.json`.

---

## 0b. CORRECTION to §0a — canonical tiers are NOT the thread; native-tile array merging is

§0a read the `snapped` rows as "canonical tiers are worth ~3.9 ms, and they are a bake
change". **That was a misreading of the baseline, and I made it.** Those rows price their
saving against the *unmerged* drawn bucket count, so each one silently bundles in the
native-tile array-merge win and then attributes the whole thing to the tier.

Re-measured with every rule scored in ONE keying against the SAME baseline, on a live Nanto
session (127 drawn submitted buckets, native keying → 54):

| rule | drawn buckets | saved | worth | detail loss |
|---|---|---|---|---|
| **native — array-merge only** | **54** | **73** | **+2.92 ms** | **none** |
| square-snap (short axis up) | 52 | +2 | +0.08 ms | none |
| tiers `[128,512,2048]` | 42 | +12 | +0.48 ms | 0.2% of corpus |
| square + cap 1024 | 41 | +13 | +0.52 ms | 9.2% |
| tiers `[256,1024]` | 34 | +20 | +0.80 ms | 9.2%+ |
| tiers `[512]` | 28 | +26 | +1.04 ms | **31.6%** |

**Nearly the whole prize is the array merge at NATIVE tile sizes — many textures of one
(tile, state) sharing one array — and it costs no fidelity at all.** It agrees with this
doc's own §3 "the design" row (149 → 84, +2.60 ms) once both are measured the same way.

**Canonical tiers are a marginal add-on with a steep fidelity price.** The full corpus
(2,893 records, from `tex-bc7-pre/derive-ledger.jsonl`) is 34 distinct (w,h) classes but only
6 distinct max-dimensions — 512² alone is 35.1%, and **26.3% are non-square**. Snapping to a
single 512 tier downscales **915 records (31.6%)**, i.e. every 512, 1024 and 2048 including
the Remacri hi-res corpus, to buy 1.04 ms. Fidelity-preserving snapping buys 0.08–0.52 ms.

**So the bake-side canonical-tier task is WITHDRAWN.** It is the wrong end of the frontier:
the perf comes precisely from destroying the resolution variety the corpus was upscaled to
provide. §0a's "the thread to pull" conclusion does not survive its own follow-up
measurement.

Two facts worth keeping from the investigation anyway:
* Statics `tex-bc7` records are level-0 only, but the v2 mip container is live and shipping
  (terrain carries 10–11 levels) and `tex-bc7-pre/derive_pre.py` already downscales records by
  **byte-slicing a mip level, no re-encode**. So IF a downscale tier is ever wanted, it is
  cheap to produce — the reason not to do it is fidelity, not cost.
* Upscaling can never be byte-sliced, so any snap-UP tier (the only fidelity-preserving
  direction) is a genuine resample-and-re-encode of the corpus.

---

## 0a. MEASURED ON THE 1070 (2026-08-06, after this doc was written) — the verdict moves

The projection above was estimated with R≈8 drawn regions. `window.__statMergeProjection()`
was then run on a settled Nanto session. **The ranges collapse, and the recommendation
changes.**

```
DRAWN 149 of 346 resident · 17,844 instances submitted · 16 regions
drawn axes: 12 tile sizes · 4 render states · 51 material values
```

| keying | drawn buckets | worth |
|---|---|---|
| (region, state) — ceiling, not reachable | 47 | +4.08 ms |
| (region, tile, state, format) — the design | 84 | +2.60 ms |
| + side / polygonOffset / emissive / shadow — image-preserving | **87** | **+2.48 ms** |

**+2.48 ms, not the 1.4–2.3 ms estimated below** — R was 16, not 8, and the estimate was
low. That alone puts the scoped design at the top of its predicted band rather than under it.

**The tile axis is the whole problem, and it is fixable off-client.** Going from the
(region, state) ceiling to the real design costs **47 → 84 drawn buckets (+37): 36% of the
prize is eaten by tile-size fragmentation before a single correctness constraint is applied.**
Snapping layers to canonical tiers recovers nearly all of it:

| canonical tiers | drawn (strict) | worth | layers / memory |
|---|---|---|---|
| `[512]` | 52 | **+3.88 ms** | 51 / **66 MB** |
| `[256, 1024]` | 57 | +3.68 ms | 51 / 96.2 MB |
| `[128, 512, 2048]` | 73 | +3.04 ms | 51 / 95.5 MB |

So the bake-side variant this doc specs in §6 is worth **~3.9 ms at 66 MB** — near the
theoretical ceiling, and it makes the CLIENT side simpler rather than harder, because one
canonical tier removes the packing problem entirely.

**The memory argument holds exactly as argued:** global pools **142.2 MB** against
region-scoped **1,440.2 MB (10.1×)**. Region-scoped arrays are not viable; global pools with
regional BatchedMeshes are mandatory, as designed.

**Confirmed unchanged:** 17,844 instances submitted × 0.386 µs = 6.89 ms, identical in every
arm — merging moves no instance into a bucket that survives culling when it did not before,
because the region key is kept.

**Largest residue: `deformed` = 193** unmergeable drawn members (wind-sway variants), which is
the least-bounded term below and now the one worth attacking next.

**Revised recommendation.** The client-only design at +2.48 ms is still a subsystem for a
middling return and I would still not build it first. But the canonical-tier variant at
**+3.9 ms** is the largest measured item on the board, is a BAKE change rather than a renderer
one, and *reduces* client complexity. That is the thread to pull. The §4 recommendation below
stands only for the client-only scoping it was written against.

---

## 0. Two corrections that halve the prize, in order

**Correction 1 — count DRAWN buckets.** §5a scaled an all-buckets figure (396 → 86) by the
rendered fraction and quoted ~6.4 ms. The region-width sweep measures that scaling directly
and kills it:

| `regionDiv` | resident buckets | draws/frame | p50 |
|---|---|---|---|
| 3 (shipped) | 376 | 452.2 | 23.4 ms |
| 6 | 245 | 438.3 | 23.4 ms |
| 12 | 142 | 437.9 | **24.5 ms** |

**131 fewer resident buckets bought 14 fewer draws and 0.00 ms.** Resident bucket count and
drawn bucket count are decoupled, because most buckets are frustum-culled and never submitted.
(It also settles the alternative: bigger regions are not a cheaper route to the same place. At
`div=12` a merged bucket straddles visible and invisible space and the frame got *worse* —
which is the same reason the brief's instruction to keep the region key is right.)

Re-measured over drawn buckets at Nanto:

```
376 resident · 129 DRAWN · 5,063 instances submitted
drawn keyed by (region, material VALUE) : 123
drawn keyed by (region, render STATE)   :  37   <- the ceiling
drawn distinct render states            :   6
drawn distinct material values          :  38
```

**129 → 37 drawn buckets at ~40 µs each ≈ 3.68 ms.** Not 6.4.

*A correction owed to §6 of the predecessor while we are here:* its **item 4** ("bucket
merging by material *value*, −35 buckets, ~1.3 ms") is over-stated ~5×. Over drawn buckets it
is **129 → 123, six buckets, ~0.24 ms.** It is not a tractable half of anything; it is noise.

**Correction 2 — a texture array cannot ignore tile size.** The 37 comes from `bucketfrag.mjs`'s
`stateOnlyKey`, which ignores the bound texture *entirely*, dimensions included. `texStorage3D`
fixes `(format, width, height, depth)` at allocation — which is exactly why `_bucketKeyFor`
(`static_atlas.js:1092`) carries `w x h` **and** a format field. The reachable key is

> **(region × TILE × state × format)**, not (region × state).

And with only **6** distinct render states across all drawn buckets against **38** distinct
material values, the tile axis is essentially the entire problem. §3 models it at ~2× on the
drawn key — i.e. the tile axis plausibly eats half the ceiling before a single correctness
constraint is applied.

---

## 1. Why the strong merger only handles the leftovers

The framing question was "why does the atlas only get the residue?" The answer has a routing
half and a structural half, and only the structural half is interesting.

### 1a. The routing: the two populations are the SAME SURFACES

Both bakers pull one material per surface DID from the same place —
`_fragMat(materialCache.getCached(sg.surfaceDid), …)`, `statics.js:2989`. The split between
them is made by **placement count within one landblock feed**, nothing else:

* `statics.js:2343-2345` runs `consolidateStaticSingletonsCrossLb` **first** on `addedNodes`.
* `static_batch_x.js:569` — a material group with `length < 2` punts; groups of ≥2 are consumed.
* `statics.js:2398-2434` offers the atlas only `crossRes.out` — the punted loners, LOD wrappers
  and fail-soft leftovers.
* `static_atlas.js:1427` then additionally rejects `n.isBatchedMesh` and
  `n.userData.__staticBatch`, so a batched node can never be re-fed.

**There is no texture, format or render-state property that distinguishes the two
populations.** The atlas's members are not a special narrow class of surface; they are ordinary
surfaces that happened to appear once in the landblock being baked. Every "why can't the atlas
take them" answer that appeals to the *kind* of surface is wrong.

### 1b. The structure: the atlas copies geometry per NODE; the batcher shares it per MODEL

This is the real answer, and it is why "route everything through the atlas" measured 89 ms.

| | atlas (`addSingletonsToCrossLbAtlas`) | batcher (`consolidateStaticSingletonsCrossLb`) |
|---|---|---|
| geometry | `normalizeForMerge` **clones per node** (`static_atlas.js:1562`), one `addGeometry` per node (`:1570`) | one `addGeometry` per distinct `BufferGeometry` (`static_batch_x.js:581`, `gidOf`) |
| instances | exactly **one** `addInstance` per gid (`:1578`) | one `addInstance` **per placement** (`:633`) |
| result | N props ⇒ N geometry copies | N props ⇒ ~1 geometry copy per model |

The batcher's own header records the scale: **17,774 batched instances over 324 distinct
geometries**. Feeding that population through the atlas as written copies 17,774 geometries
into bucket vertex buffers. That is the mechanism behind `?staticBatch=off&texBc7=off` →
22,365 singletons / 4,576 draws / 89 ms, and it is why the atlas is the *weaker* merger on
volume.

**It is fixable, and cheaply.** The atlas bakes the layer index into a per-**vertex** attribute
(`normalizeForMerge`, `static_atlas.js:802-812`), which *looks* like it forbids geometry
sharing. It does not. A statics geometry is a pure function of `(modelId, surfaceDid,
doubleSided)` — that is precisely the `?statGeomDedup` content key, `static_batch_x.js:287-307`
— so it carries exactly **one** surface, hence one texture, hence **one layer**. Every
placement of a geometry wants the same `aLayer`. Per-vertex `aLayer` and cross-placement
geometry sharing are compatible; the atlas simply never learned to share, because its
population is singletons *by definition* and sharing was structurally impossible there.

### 1c. Gate-by-gate

Verdicts: **incidental** = routing or a fixable race; **fragmenting** = it multiplies the
bucket count; **hard** = merging across it changes the image or the memory ceiling.

| # | gate | where | verdict |
|---|---|---|---|
| G1 | batcher runs first, atlas gets `crossRes.out` | `statics.js:2343-2345`, `:2398-2434` | **incidental** — pure ordering |
| G2 | `group.length < 2` punts to the atlas | `static_batch_x.js:569` | **incidental** — this IS the selection rule |
| G3 | `isBatchedMesh` / `__staticBatch` rejected | `static_atlas.js:1427` | **incidental** — a double-feed guard |
| G4 | one `addGeometry` **per node** | `static_atlas.js:1562-1578` | **hard as written**, fixable per §1b — the reason routing everything to the atlas measures 89 ms |
| G5 | `frustumCulled = false` (ring-spanning) | `static_atlas.js:1213` vs `static_batch_x.js:385` | **hard** — must NOT be inherited. The region sweep proves drawn-bucket count is what pays; a ring-spanning bucket is always drawn |
| G6 | tile size in the bucket key | `static_atlas.js:1092` (`texStorage3D`) | **fragmenting, hard** — ~2× on the drawn key (§3). Removable only by resampling (§6) |
| G7 | `f7`/`f8` format field | `static_atlas.js:1092-1095` | **fragmenting, hard** — a compressed array's internal format is fixed at allocation |
| G8 | layer ceiling `_layerCapacityFor` | `static_atlas.js:1139-1169` | **incidental** — 38 distinct drawn values against per-class ceilings of 16–128; `ptLayerFull` already measures 0 |
| G9 | render state `_stateKeyOf` | `static_atlas.js:474-493` | **nearly free** — 6 distinct states across all drawn buckets |
| G10 | `side` — `makeArrayMaterial` hardcodes `DoubleSide` | `static_atlas.js:537-542` | **hard** — `?perPolyCull` splits sidedness deliberately, and `doubleSided` is in the geometry dedup key. Survivable for lone props; not for a batched population |
| G11 | `polygonOffset` not in `_stateKeyOf` | `materials.js:750-786`, `:2878-2884` | **hard** — `staticBiasMaterials` / `floorBiasMaterials` exist for nothing else. Flattening it is z-fighting |
| G12 | `emissive` dropped (array material fixes roughness 1 / metalness 0) | `static_atlas.js:537-542` | **hard** if any drawn statics carry Luminosity (materials.js emits flat emissive, not an emissiveMap) |
| G13 | `castShadow`/`receiveShadow` hardcoded `true` | `static_atlas.js:1214-1215` vs `static_batch_x.js:388-389` | **hard** — these are per-BUCKET; flattening changes the depth-only pass, which ignores opacity |
| G14 | `deformation.` variants rejected (`ptDeformed`) | `static_atlas.js:1464-1466` | **hard** — an array material replaces the member's material wholesale and silently freezes wind sway (the 2026-07-02 "trunk sways, foliage frozen" split) |
| G15 | `bc7AtlasShouldDefer` — 79% of offered props | `static_atlas.js:1453-1455` | **incidental** — a race, and measured: `?texBc7=off` took it to 0, lifted admission 21%→67%, and moved the frame 25.8 → 25.2 ms |
| G16 | `canSupplyPlanes` / no-uv / no-map | `static_atlas.js:1425-1427`, `surface_planes.js:146-154` | **incidental** — the batcher's members are the same MaterialCache materials with the same maps |
| G17 | non-`MeshStandardMaterial` (wireframe `MeshBasic`) | — | **incidental** — wireframe deliberately routes to the batcher (`static_batch_x.js:563`) |

**G10–G13 are the finding that is easy to miss.** `_stateKeyOf` carries five fields:
`transparent | alphaTest | depthWrite | blending | wrapS`. Four rendering-relevant properties
are *absent* from it, and each has a live population. They are absent legitimately — for lone
props, one per material, flattening them is invisible — and they become load-bearing the
moment a bucket holds thousands of instances. Any merge must extend the key, and every
extension costs buckets back.

---

## 2. The design

**Global array pools; region-scoped BatchedMeshes.** State it as one sentence because the
split is the whole idea: *the BatchedMesh must be regional (for node-level frustum culling —
§0 correction 1), and the array texture must not be (for memory — §2b).*

### 2a. Shape

* **Bucket key** `(region, tile, stateStrict, format)`, where `stateStrict` = `_stateKeyOf` plus
  `side`, `polygonOffset{Factor,Units}`, `emissive{,Intensity}`, `castShadow`, `receiveShadow`
  (G10–G13). Regional, frustum-culled, exactly as `static_batch_x.js` buckets are today.
* **Array pool** keyed by `(tile, stateStrict, format)` — **global**, refcounted by texture
  uuid. This is `static_atlas.js`'s existing `layerOf` / `freeLayers` / `nextLayer` /
  `_growBucketLayers` machinery lifted out of the bucket `userData` into a pool object. Nothing
  about it changes; it changes owner.
* **Material**: **one per pool**, shared by every region bucket of that class. `makeArrayMaterial`
  already works on a `BatchedMesh` (`static_atlas.js:1204`), and three binds material uniforms
  per draw, so sharing is free. It is better than free: three sorts the opaque pass by
  `material.id`, so a class's region buckets sort adjacent — and the predecessor measured **71%
  of draws change material** and **160 program switches against 79 distinct programs**. Sharing
  materials across region buckets attacks that directly.
* **Geometry**: unchanged from the batcher — one `addGeometry` per distinct `BufferGeometry`,
  one `addInstance` per placement (§1b). `aLayer` is written into the attribute immediately
  before `addGeometry`; `BatchedMesh` copies attributes into its own buffers on add (three r184
  `BatchedMesh.js:694` → `setGeometryAt:738-792`), so the mutation is not retained and a
  geometry shared across two pools cannot carry a stale layer.
* **Refcounting**: **one record holds both refcounts.** The geometry refcount (per bucket, by
  content key — `?statGeomDedup`'s `dedupGids`) and the layer refcount (per pool, by texture
  uuid) are released at the same moment, by the same LB eviction. Two independent refcounts
  drift; one record cannot. This is the single highest-risk part of the implementation and it
  is why the eviction path — not the feed path — is where a prototype would need its tests.

### 2b. Why the arrays must be global — the memory argument

This is the load-bearing number. **376 resident buckets over 95 distinct material objects = a
surface is resident in ~4.0 regions on average.** Region-scoped arrays therefore re-cut every
layer ~4×, because a layer is per-array and arrays would be per-region.

For scale: the atlas's measured occupancy was 123 MB of *occupied* layers, and the X7
grow-on-demand fix recovered **428 MB** on a page whose renderer OOM-crashes at ~2,800 MB with
a 2,445 MB heap already measured. A 4× layer multiplier is the same order as the incident X7
just closed. **Region-scoped arrays would hand back most of the X7 win to buy bucket count.**
Global pools cost exactly what the atlas costs today.

`window.__statMergeProjection()` reports both figures (`layers.sharedMB` vs
`layers.regionalMB`) so this stops being an argument and becomes a measurement.

### 2c. Tile sizes that differ — they don't get packed

Stated plainly because it is the design's central cost and there is no clever escape inside
this scope:

* **One bucket per tile size.** That is the honest answer, and §3 prices it at ~2×.
* **Sub-rect packing** (many small surfaces inside one layer, with a per-layer `(scale, offset)`
  rect) is the textbook fix and is *shader-compatible* — the wrap buckets already do
  `fract(uv)` through `textureGrad` (`static_atlas.js:563-575`), so a rect transform is a
  two-line change. It founders on **mips**: a 128² sub-rect inside a 512² layer merges with its
  neighbours at low mip levels, and the existing code already accepts a half-texel bilinear
  discontinuity at tile repeats — a *cross-surface* bleed is a different order of wrong.
  Bounding it needs per-rect mip clamping. **Ruled out for this scope**, not on principle.
* **Round-up tiers** (snap each surface up to the next power of two) blow up memory: the
  occupancy census has 16×16 and 32×32 surfaces, and rounding those to a shared 512 costs
  1024× their layer bytes each.
* **Nearest-tier resampling** is the one that works, and it is the §6 follow-up. Because each
  layer holds exactly one surface addressed by *normalized* UV, resampling to another tile size
  is a pure **resolution** change with no UV math anywhere and no aspect distortion — a 128×256
  surface resampled to 256×256 simply has its U axis upsampled. `_liftChannel`
  (`static_atlas.js:350-364`) already does exactly this for nra channels whose bake size differs.

### 2d. Eviction and growth

Both are the atlas's, unchanged in mechanism and improved in amortisation:

* **Eviction** — an LB leaving drops its geometry refcount in its region bucket and its layer
  refcount in the global pool. A layer survives while any region still references it, which is
  what today's `evictStaticAtlasForLb` (`:1656-1677`) already does; the only change is that the
  refcount now lives beside the geometry record rather than in a parallel list.
* **Growth** — `_growBucketLayers` becomes `_growPoolLayers`: same doubling, same
  `capacity` clamp, same load-bearing `addLayerUpdate` re-mark (three uploads *only*
  `layerUpdates` on a fresh array, so an unmarked carried-over layer is GPU garbage). It gets
  *cheaper*: `_rebindArrayUniforms` now re-points **one** shared material instead of one per
  bucket, and growth events amortise across every region bucket of the class.
* **Overflow** stays fail-soft `ptLayerFull` — a prop falls back to an unbatched draw, never
  vanishes.

---

## 3. Bucket projection — stated in DRAWN buckets

The idealised 37 is not reachable; here is what this design actually lands on, and why.

**Inputs** (all measured): 129 drawn buckets · 123 drawn `(region, value)` · 37 drawn
`(region, state)` · 6 drawn states · 38 drawn material values · ~40 µs per drawn bucket. Tile
distribution modelled from `RESULTS-atlas-occupancy-2026-08-05.json` (112 layers over 29
`(size, state, format)` classes, ~15 distinct sizes, top three sizes only 62%).

**Method.** Drawn regions `R` ≈ 8 (bounded below by 37 ÷ 6 = 6.2 and above by ring geometry;
swept 6–12). Distinct surfaces per drawn region ≈ 123 ÷ R ≈ 15. Expected distinct
`(tile, state, format)` classes when drawing 15 surfaces from the occupancy class distribution
is Σ_c [1 − (1 − n_c/112)^15] ≈ **9.0**. So drawn buckets ≈ R × 9.0.

| keying | drawn buckets | worth (at 40 µs) |
|---|---|---|
| today — (region, material object) | **129** | — |
| (region, material value) | 123 | 0.24 ms *(the predecessor's §6 item 4, corrected)* |
| **(region, tile, state, format)** | **~72** (range 64–83) | **~2.28 ms** |
| **+ side/offset/emissive/shadow (G10–G13)** | **~80** | **~1.96 ms** |
| **− deformation residue (G14)** | **~93** | **~1.44 ms** |
| (region, state) — the idealised ceiling | 37 | 3.68 ms |

**Headline: ~1.4–2.3 ms, centre ~1.9 ms, against a 3.68 ms ceiling.** The tile axis costs
~2× on the drawn key; G10–G13 cost ~10–20% more; the deformation residue is the least-bounded
term and the probe's `blockedDrawn.deformed` settles it.

**Sanity checks on the model, stated so it can be disbelieved properly:**

* It reproduces the direction of the measured state axis. Modelled classes-per-region 9.0
  against measured states-per-region 37 ÷ 8 = 4.6 ⇒ a **1.96× tile multiplier per region**;
  globally the same model gives 14.7 classes against 6 measured states ⇒ **2.45×**. The
  per-region multiplier being smaller than the global one is correct — fewer surfaces in view
  means fewer distinct sizes seen — and getting that ordering right by accident is unlikely.
* It is **not** stable against `R`: `R=6` → 64 buckets, `R=12` → 83. That spread is the
  dominant error bar and is exactly what the probe removes.
* The tile distribution is borrowed from a **biased sample** — the atlas's residue is the
  surfaces the batcher did *not* take, and BC7's 4× upscale inflates its tail. This could be
  wrong in either direction and is the second reason to measure rather than model.

**Instance check (required by the brief).** Merging does **not** multiply instances submitted:
the region key is kept, so no instance moves into a bucket that survives culling when it did
not before. 5,063 drawn instances × (0.038 + 0.348) µs = 1.96 ms, unchanged in every arm above.

---

## 4. Recommendation

**Do not build it as scoped.** Setting ~1.9 ms against what it costs:

* a global layer-pool module, and the pool/bucket refcount unification of §2a;
* shader work in `static_batch_x.js`, which is today a deliberate **THREE-only leaf** (its
  headless test loads it by stripping the import lines outright, and `setDeadBatchPredicate`
  exists precisely so that stays true);
* extending the render-state key by four fields, each of which hands buckets back;
* a real risk to the X7 memory ceiling if the global/regional split is got wrong;
* and validation that is 1070 A/B **plus** an owner eye-test on shadows, depth bias and
  sidedness.

Against a session whose two shipped changes bought **0.7 ms** and **1.2–2.0 ms** for far less
work, ~1.9 ms does not clear the bar. This is the same conclusion the region-width sweep
reached from the other direction: the mechanisms that reduce *resident* buckets are cheap and
worth nothing, and the mechanism that reduces *drawn* buckets is expensive and worth less than
its ceiling suggested.

**What to do instead, in order:**

1. **Run the probe** (§5). One command against an already-settled session. It replaces the
   ±30% modelling in §3 with a measurement, and specifically reports
   `drawn.snapped` — which is what decides whether §6 is worth commissioning.
2. **If `drawn.buckets.regionStrict` comes back near 37–50**, the model is wrong in the
   favourable direction and this design becomes worth ~3 ms. Reopen it.
3. **If it comes back near 80 as modelled**, close this line and take §6 or nothing.
4. **Do not spend anything on (region, material value) keying** — 0.24 ms, corrected from the
   predecessor's 1.3 ms.

---

## 5. What was built

Read-only instrumentation only. No behaviour change, no flag, no default-path cost.

* **`scene3d/static_atlas.js` — `projectStatMergeBuckets()` / `window.__statMergeProjection()`.**
  Traverses the live scene for `__staticBatchCrossLb` buckets and projects the bucket count and
  array-texture memory under every candidate keying, over **both** the resident and the
  **drawn** populations. It computes those keys with the atlas's *own* functions —
  `_stateKeyOf`, `_bucketKeyFor`, `_perLayerBytesFor`, `_layerCapacityFor` — rather than a
  transcription, so it cannot drift from the code that would implement the design (the rule
  `bc7AtlasShouldDefer`'s comment states for the regression suite). It also prices tier
  snapping (§2c/§6) in buckets *and* megabytes, and reports the unmergeable residue by reason.
* **`scripts/net-review/stat-merge-projection.mjs`** — CDP courier + arithmetic, in
  `bucketfrag.mjs`'s shape. Attaches to an already-settled page.
* **`test_static_merge_projection.mjs`** — 50 offline checks. The two that matter most:
  *the tile axis is real and is not silently collapsed* (PART 3), and *the drawn split
  genuinely differs from the resident one* (PART 8) — a probe reporting only resident buckets
  would have re-made the exact mistake the region sweep caught.

**Why no merging prototype.** The design is coherent but not self-contained: it is a
subsystem whose correctness lives in an eviction path with two unified refcounts, and whose
*value* is a number this document argues is below the bar. Shipping 400 lines of default-OFF
code that nobody should turn on is worse than shipping the instrument that decides whether to
write them.

---

## 6. The variant that clears the bar — and why it is a BAKE task

Snapping every statics surface to a small set of **canonical tile sizes** collapses G6
entirely. One canonical tier reaches `(region, state)` — the full 37 and the full 3.68 ms,
less the G10–G14 haircut, so ~2.7–3.2 ms. Two tiers land around 2.4–2.9 ms. The probe prices
all three off the live population.

It is attractive because the shader does not move at all: each layer holds one surface
addressed by *normalized* UV, so resampling is a pure resolution change (§2c).

**But it cannot be done in the client, because `?texBc7` is default-ON.** A BC7 surface
arrives as pre-encoded blocks in an `HBC7` container and is uploaded straight to a
`CompressedArrayTexture`; resampling one at runtime means decode → resample → **re-encode BC7**
per surface, which is not a thing to do on a frame budget. So canonical tiles have to be
emitted by the bake: the `holtburger/tex-bc7` records (and their RGBA8 twins) authored at a
fixed tier set rather than at each surface's native size.

That makes it a bake-pipeline change with a client change of roughly zero, which is a much
better shape than this task — and it needs its own decision from the owner, because it is a
**global resolution trade**, visible on close walls, not a perf knob.

**Open questions it would have to answer, none of which need the client:**

1. What fraction of drawn statics surfaces are natively above the chosen tier? (The occupancy
   census suggests 512² is already the single largest bucket, so the tier may be nearly free —
   but that census is the residue population, and BC7's 4× upscale is in it.)
2. What does one tier cost in bake output size and in VRAM, once small surfaces are snapped up?
3. Does the tier interact with the mip chains the v2 BC7 container now ships?

---

## 7. What needs the 1070

* **The projection itself** — §5's probe, on a settled session at Nanto. Everything in §3 with
  a range attached collapses to a number. Settle `draws/frame` first.
* **`blockedDrawn.deformed`** — the least-bounded term in §3 and a straight read from the same
  probe run.
* **`layers.sharedMB` vs `layers.regionalMB`** — confirms or refutes the §2b memory argument
  with live data rather than the 376 ÷ 95 = 4.0 estimate.
* **`drawn.snapped`** — the §6 go/no-go.
* Nothing here changes a pixel, so no eye-test is owed by *this* work. An eye-test is owed by
  anything built on it: shadows (G13), depth bias (G11), sidedness (G10) and Luminosity (G12)
  are all image-visible, and the ClipMap episode in the predecessor (§5e) is the standing
  reminder that a coarse material classifier passes the numbers and fails the picture.
