# The wind-sway residue: what it costs, and whether sway can be batched (2026-08-06)

Follow-on to `2026-08-06-statics-array-merge-design.md`, whose §3 named
`blockedDrawn.deformed = 193` "the least-bounded term below and now the one worth
attacking next". Two questions were asked of it: what does the residue actually cost in
DRAWN buckets, and can the deformation survive batching at all.

The short answers:

1. **`193` is BUCKETS, not members — and it is a resident-scale number.** It is also not
   the population the follow-on live probe measured (127 resident / 34 drawn plain
   Meshes). Those are two disjoint populations and both are real.
2. **The deformation already survives batching. It has been surviving batching this
   whole time** — 193 live `BatchedMesh` buckets are rendering a `deformation.windSwayGpu`
   variant right now. The atlas gate is not about batching; it is about the array merge
   *substituting the material*.
3. `animated_scenery.js` is **not** the template. It animates rigid per-instance matrices
   on the CPU from DAT keyframes and carries no VFX variant at all. The trap the brief
   warned about is real.
4. Recommendation: **land the instrument, do not build the merge change yet.** When the
   array merge is built, add `__vfxSetKey` to its bucket key — one line in a key
   function, not a project.

---

## 1. Question 1 — the count, and what it is a count OF

### 1a. `blocked.deformed` counts BatchedMesh nodes

`projectStatMergeBuckets` traverses `isBatchedMesh` nodes only, and `bump()` fires once
per node. Three independent confirmations:

* the code path — `bump` is called from the per-node visitor, before any member is looked
  at;
* the arithmetic in the committed run — `batchBuckets 346 − blocked 193 = 153 =
  all.buckets.today`, exactly;
* `test_static_merge_projection.mjs` PART 6 has asserted it since the probe landed (four
  buckets in, `blocked.deformed === 1`). PART 10 now states it unmissably: a bucket with
  a thousand instances bumps the blocker once, and the payload carries a `units` field.

So the residue is **193 buckets**. A bucket holds many members, so "193 members" and "193
draws" are both wrong, in opposite directions.

### 1b. …and `drawn` cannot see the frustum

`_projDrawn` tests `visible` up the parent chain plus `instances > 0`. It does not model
the frustum — the docstring said so, and the live run shows what that costs:
**`drawnBuckets 342` against `batchBuckets 346`.** The filter removed four buckets out of
346. Against that:

| independent measurement of the SAME population | submitted |
|---|---|
| `2026-08-06-frame-cost-structure-measured.md` §2, `statics \| static-batch-c` | **177 draws/frame** |
| the region-width sweep, §0 of the design doc | **129 of 376 resident** |

So `drawn` here is a resident-scale number wearing a submitted-scale name, and the
resident→submitted ratio is somewhere around **34–52%**.

**This is not confined to the deformed row.** The design doc's own headline figures are
computed over `drawn.buckets.today = 149`: `(149 − 87) × 40 µs = 2.48 ms` and
`(149 − 52) × 40 µs = 3.88 ms`. Both are stated over the same over-counted population. A
consistency check makes the problem concrete: if 149 mergeable *and* 193 deformed buckets
were all submitted that would be 342 static-batch-c draws per frame, against 177
measured. At most half of them can be real. **§5's `+2.48 ms` and §6's `+3.9 ms` should be
re-run against `submitted` before anything is built on them**; scaled by the observed
ratio they land nearer 0.8–1.3 ms and 1.3–2.0 ms.

That would be the fourth 2× on this workload, and unlike the first three it is the
instrument's fault rather than an estimator's. §3 below fixes the instrument.

### 1c. The two populations are disjoint

| | what it is | resident | drawn | measured by |
|---|---|---|---|---|
| **P1** | cross-LB `BatchedMesh` buckets whose bucket material is a deformation variant | 193 | unmeasured | this probe (committed JSON) |
| **P2** | plain-Mesh singletons the atlas refuses (`ptDeformed`) — never batched at all | 127 | **34** | the 1070 follow-on run |

They cannot overlap: the projection only visits `isBatchedMesh` nodes, and P2 is by
definition the nodes that never became one. P1 members reached a bucket because
`consolidateStaticSingletonsCrossLb` groups by material OBJECT and found ≥2 nodes sharing
a sway variant; P2 members were the lone ones, punted to the atlas seam, which refused
them at `static_atlas.js:1464`.

### 1d. The answer, with its confidence

* **P2 — 34 drawn singletons, ceiling ~0.96 ms.** Measured live. This stands, and it is
  the number to quote for "what the atlas's `ptDeformed` gate costs".
* **P1 — 193 resident buckets; submitted count NOT MEASURED.** Scaling by the two
  available ratios gives 65–100 submitted draws, but that is the cost of *drawing* them,
  not the *saving* from merging them — they are already batched, and each already carries
  many members. The saving is `today − regionClass` over the residue, and the probe threw
  those rows away before it could compute it.
* **Confidence.** "193 = buckets" — certain (code, arithmetic, two tests). "P1 and P2 are
  disjoint" — certain. "`drawn` overstates submitted by ~2×" — high; three independent
  numbers agree and the 342/346 result is self-evidently not a cull. "65–100 submitted
  sway buckets" — inference only, from a ratio borrowed across sessions. **This needs a
  live probe**, and §3 is exactly what to run.

---

## 2. Question 2 — can the deformation survive batching?

### 2a. It already does

Three proofs, in increasing order of how conclusive they are.

**(i) The per-instance infrastructure was written for this case.**
`vfx/per_instance.js` derives `vVfxHash` — the per-instance sway phase — with an explicit
ladder:

```glsl
#ifdef USE_BATCHING
  vVfxHash = vfxHash01(batchingMatrix[3].xy);
#elif defined( USE_INSTANCING )
  vVfxHash = vfxHash01(instanceMatrix[3].xy);
#else
  vVfxHash = vfxHash01(modelMatrix[3].xy);
#endif
```

Its header says why in as many words: an `InstancedBufferAttribute` "would not even reach
a BatchedMesh", so the variation rides the per-instance matrix DATA three already uploads,
"the ONLY mechanism that covers plain Mesh + InstancedMesh + BatchedMesh uniformly".

**(ii) three r184 composes the shear correctly under `USE_BATCHING`.**
`batching_vertex` declares `batchingMatrix` *before* `begin_vertex`; `begin_vertex` gives
`vec3 transformed = vec3( position )` in the batched geometry's local space; and
`project_vertex` applies the instance transform *after*:

```glsl
vec4 mvPosition = vec4( transformed, 1.0 );
#ifdef USE_BATCHING  mvPosition = batchingMatrix * mvPosition;
#ifdef USE_INSTANCING  mvPosition = instanceMatrix * mvPosition;
```

`windSwayGpu` writes `transformed.x/y` at the `begin_vertex` seam, in AC object space
(Z-up), base-anchored and model-invariant. That composes with `batchingMatrix` exactly as
it composes with `instanceMatrix` — structurally the same two lines. Normals are untouched
by the component, so `defaultnormal_vertex`'s batching branch is not even in play.

**(iii) It is running live, on 193 buckets.**
`static_batch_x._getOrCreateBucket(group[0].material, …)` uses the member's material
verbatim as the bucket material. The committed probe run found 193 `BatchedMesh` buckets
whose `material.userData.__vfxSetKey` contains `deformation.`. That is not a model — it is
an observation that windSwayGpu is currently rendering inside BatchedMeshes.

### 2b. So what is the gate actually about?

**Material substitution, not batching.** The atlas replaces `n.material` with the bucket's
shared `makeArrayMaterial` — a `sampler2DArray` material built by the atlas, which never
went through `buildFragVariant` and therefore carries no vertex patch. Swapping a variant
for it silently drops the shear. That is the 2026-07-02 "trunk sways, foliage frozen"
split precisely: the trunk's ≥2-node surface group kept its variant via the consolidator,
the foliage singleton hit the atlas and lost it.

The distinction matters because it changes which fixes are even relevant.

### 2c. The four options, scored on the evidence

**1. Per-instance data — ruled out.** three r184 `BatchedMesh` offers exactly three
per-instance channels: the matrix (fully consumed by placement), `setVisibleAt` (a boolean
consumed by the multidraw), and `setColorAt` → `USE_BATCHING_COLOR`, whose `vec4` is
consumed by `vColor` in `color_vertex` and additionally forces `USE_COLOR_ALPHA`. There is
no free per-instance float and no custom per-instance attribute — `per_instance.js` says
so, and it is why the hash is procedural rather than an attribute. Nothing here can carry
a sway amplitude without stealing a channel that has a job.

**2. Fold the sway into the array material, `w == 0` as the no-op.** Buildable, but option
1 says the `w` has nowhere to live per-instance. A uniform is per-bucket — all-or-nothing —
which is not a no-op, it is the bug. Only viable in the per-VERTEX form, which is option 3.

**3. A per-vertex sway weight baked at merge time.** The strongest shader option, and it
has an exact precedent in the same file: the atlas already carries a per-vertex float
through the merge (`aLayer`, written by `normalizeForMerge`), and `static_atlas.js:902`
already records that `aLayer` survives BatchedMesh. An `aSway` float alongside it is the
same mechanism, and it also generalises to a *graded* sway (0 at the trunk, 1 at the
canopy) which the current height-shear approximates. Cost: +4 bytes per vertex on every
static in the merged population, and every array material recompiles with the windSway
snippet whether or not any member sways. It also puts sway state in geometry, which the
bake would then own.

**4. Key the bucket by `__vfxSetKey` — recommended, if anything is done.** The follow-on
probe found exactly ONE deformation set in the world (`deformation.windSwayGpu`, 127 of
127; the new `deformed.setKeys` census will confirm the same over P1). One set splits each
`(region, tile, state, format)` class into at most TWO buckets — sway and not — and the
bucket's array material is then built once per `(class, setKey)` through
`buildFragVariant`, so every member in it sways by construction. No new attribute, no new
GLSL, no `w == 0` branch, no bake change.

Its decisive property, given the brief's stated worry: **option 4 cannot reproduce the
2026-07-02 split.** That split happened because members with *different* materials landed
in *one* bucket. When membership and material are decided by the same key, a member's
material is its bucket's material by definition. The regression risk the brief is right to
fear is specific to options 2 and 3, which put swaying and non-swaying members in one
bucket and then try to tell them apart. Option 4 never puts them together.

It is also what `static_batch_x` already does — keying on the material object is why its
sway buckets are correct today — so it is a widening of a proven rule rather than a new
one.

### 2d. The trap: `animated_scenery.js` is not a template

The brief offered `animated_scenery.js` (4,096 trees, 6 draws, default-ON
`?animSceneryInstanced`) as an existence proof that sway and instancing coexist. It is an
existence proof for something else.

* **It is not the sway.** `?animSceneryInstanced` is the DAT-keyframe (`0x03` Animation)
  scenery path — mills, wheels, banners, and any scenery with a clip. The file contains no
  `buildFragVariant`, no `fragPlanForDid`, no `__vfxSetKey`: its materials are plain. The
  wind sway is `deformation.windSwayGpu`, attached at the statics seam via `frag_attach`,
  and it is what makes the *frozen* instanced trees bend.
* **Its mechanism is per-instance rigid matrices, recomputed on the CPU every frame**:
  `instanceMatrix[i] = placementMatrix × templatePartPose`, one buffer upload per dirty
  bucket (`animated_scenery.js` ~:488, `_dirtyBuckets`). It collapses to 6 draws *because*
  every placement of a DID shares ONE template pose from ONE shared mixer.
* **That is the opposite of what sway needs.** `vVfxHash` exists to decorrelate the phase
  per instance. Under the animated-scenery scheme you get one pose for everything (no
  decorrelation, a forest that flaps in unison) or one bucket per phase (no collapse).
* **And it gets worse on BatchedMesh, not better.** `BatchedMesh` keeps per-instance
  matrices in a float TEXTURE, so a per-frame rewrite is a texture re-upload rather than
  `InstancedMesh`'s tight `DynamicDrawUsage` buffer.

The real existence proof was never far away: windSwayGpu itself, already running on 193
BatchedMeshes, with the `USE_BATCHING` branch written for it in advance.

---

## 3. What landed here: the instrument, not the merge

`static_atlas.js`, additive and read-only; no render path is touched, so no URL flag and
no docs row is owed (nothing changes a pixel).

* **`armStatMergeSubmittedSampler(root)` / `disarmStatMergeSubmittedSampler(root)`**, and
  `window.__statMergeArmSubmitted` / `__statMergeDisarmSubmitted`. Counts, per bucket, the
  frames three actually submitted it, by shadowing `onBeforeRender` and delegating to
  BatchedMesh's prototype method. Three calls `onBeforeRender` if and only if the object
  reaches `renderObject`, so this measures the real draw rather than a transcription of
  `projectObject` — which is the rule the projection's header already sets for itself, and
  the same instrument `2026-08-06-frame-cost-structure-measured.md` used, so the two
  censuses are directly comparable. Costs one function call per submitted bucket per
  frame: **disarm before quoting a frame time.**
* **`submitted` / `submittedBuckets` / `submittedInstances` / `blockedSubmitted`** on the
  projection. `submitted` is **null** until the sampler has seen frames — an absent
  measurement must read as absent, never as a confident zero.
* **`deformed`** — the residue is now PROJECTED with the same key functions instead of
  discarded, over all three populations, plus a `setKeys` census. `today − regionClass` on
  `deformed.submitted` is the answer to "what would un-blocking buy", in ms, directly.
* **`units`** — because the field names alone have now been misread three times.
* `_projDrawn`'s docstring now states what it is: resident-scale. The field is kept
  because the results JSON quotes it.

Tests: `test_static_merge_projection.mjs` PARTS 10–12 (71 assertions total, was 50).
PART 10 pins the counting unit with a 1,000-instance blocked bucket; PART 11 pins that the
residue is projected, stays out of the mergeable totals, and is counted once when it also
fails a later gate; PART 12 pins the sampler — delegation to the prototype, restore on
disarm, re-arm resets rather than doubles, counts survive disarm, and un-armed reads null.

---

## 4. Recommendation

**Do not build the sway merge now. Run the instrument first, then fold option 4 into the
array merge when that merge is built.**

* The value on the side that matters is unmeasured. P2's ceiling is 0.96 ms and is real;
  P1 is the larger population and its submitted count has never been taken.
* Every estimate on this workload has collapsed under measurement — three 2× corrections
  so far, and §1b argues the design doc's own headline is a candidate fourth.
* The mechanism question is settled and the safe answer is cheap: option 4 is a term in a
  key function. Built alongside the array merge it costs a line; built separately it costs
  a subsystem for something between 0.3 ms and 1 ms.
* If the sampler says the submitted residue is under ~0.5 ms, **drop it and tombstone
  it** — with the note that the reason is arithmetic, not risk, because §2 shows the risk
  is manageable.

### What needs the 1070

1. `window.__statMergeArmSubmitted()` → let ~2 s of frames run at a settled Nanto session
   → `window.__statMergeProjection()` → `window.__statMergeDisarmSubmitted()`. Quote
   `submittedBuckets`, `submitted.buckets`, `blockedSubmitted.deformed`,
   `deformed.submitted.buckets` and `deformed.setKeys`.
2. Cross-check `submittedBuckets + atlas` against `renderer.info.render.calls` attributed
   by name, as `2026-08-06-frame-cost-structure-measured.md` §2 did. If they disagree the
   sampler is wrong and nothing here should be quoted.
3. Re-run the design doc's `+2.48 ms` / `+3.9 ms` over `submitted`.
4. **No eye-test is owed by this change** — it is a diagnostic, and nothing renders
   differently. An eye-test IS owed by option 4 if it is ever built: a stand of trees with
   `?treeWindGpu` on and off, checking specifically for a trunk/foliage split, because
   that is the failure this whole gate exists to prevent.
