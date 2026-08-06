# The 5.72 ms nobody has attributed — an instrument, and what it is looking for

Successor to `2026-08-06-frame-cost-structure-measured.md` §2, which split the render call
three ways on the 1070 at Nanto, quality `mid`, `?renderScale=1&adaptiveRes=off`:

| part | ms/frame | share |
|---|---|---|
| `renderer.render()` total | 24.22 | — |
| ├ `renderBufferDirect` — the draw funnel | 12.78 | 53% |
| ├ `BatchedMesh.onBeforeRender` — the multidraw rebuild | 5.72 | 24% |
| └ **remainder** | **5.72** | **24%** |

The remainder is three's own per-frame work and has never been split. This document is the
design of the instrument that splits it (`scene3d/frame_split.js`), the ranked hypotheses it
is built to decide between, and the exact sequence to run.

**Nothing here is a measurement.** Every number below is a prior, a formula, or a range with
its reasoning attached. The estimates on this workload have collapsed by 2–10× under
measurement four times now; treat the priors accordingly, including mine — §4 states plainly
that my own priors under-explain the remainder by about 2×.

---

## 0. Two premises corrected before any measurement

### 0a. Program selection and the uniform refresh are NOT in the remainder

The remainder was described as "`projectObject` + render-list sort + `WebGLMaterials` uniform
refresh + program/state selection + shadow-map setup". Two of those are not in it.
`WebGLRenderer.renderBufferDirect` (three r184) opens with:

```js
this.renderBufferDirect = function ( camera, scene, geometry, material, object, group ) {
    if ( scene === null ) scene = _emptyScene;
    const frontFaceCW = ( object.isMesh && object.matrixWorld.determinant() < 0 );
    const program = setProgram( camera, scene, geometry, material, object );   // <- here
```

`setProgram` is where `getProgram`, `WebGLPrograms`, `materials.refreshMaterialUniforms` and
every uniform upload live. They are already inside the 12.78 ms draw funnel. This is also
*why* the funnel measured 90% fixed per draw with r² = 0.014 against instance count
(`2026-08-06-frame-cost-structure-measured.md` §5a): a draw's cost is its state validation and
binding, and that is where they were all along. **Tombstone: do not look for them in the
remainder. The probe deliberately offers no bucket for them.**

### 0b. The graph is walked FIVE times per frame, not once

"~5,073 nodes for ~1,484 meshes, every Group visited by `projectObject` every frame" is true
and is the *smallest* of the walks. Per world render call three also walks the graph in:

* **`scene.updateMatrixWorld()`** — the first statement of the `render()` body.
  `Object3D.updateMatrixWorld` recurses into **every** child unconditionally. It has **no
  `visible` early-out**, and — the load-bearing detail — **`matrixWorldAutoUpdate = false`
  does not prune a subtree in r184.** Read the method:

  ```js
  updateMatrixWorld( force ) {
      if ( this.matrixAutoUpdate ) this.updateMatrix();
      if ( this.matrixWorldNeedsUpdate || force ) {
          if ( this.matrixWorldAutoUpdate === true ) { /* compose */ }
          this.matrixWorldNeedsUpdate = false;
          force = true;
      }
      const children = this.children;
      for ( let i = 0, l = children.length; i < l; i ++ ) children[ i ].updateMatrixWorld( force );
  }
  ```

  The flag skips one `multiplyMatrices`. The recursion and the per-node `updateMatrix()` both
  still run. **The comment on `cells.js` `FREEZE_STATIC_MATRIX` — "makes three skip the whole
  subtree every frame" — overstates what r184 does.** That gate is still worth its keep (it
  removes ~1,100 matrix composes and it is the reason the profile it quotes improved), but it
  did **not** remove ~1,100 node visits, and nothing derived from it should assume it did.

* **`shadowMap.render()`** — `WebGLShadowMap.renderObject` recurses the whole scene **once per
  shadow-casting light**. When CSM is on (`csm.js`, `DEFAULT_CSM_SPLITS = [30, 100, 300]`)
  that is three cascade lights, each `castShadow = true`, so three more full walks.

One `updateMatrixWorld` (RESIDENT scale) + one `projectObject` (VISITED scale) + N cascade
walks (VISITED scale). `projectObject` is ~20% of the traversal the frame pays for when
shadows raster.

### 0c. …but at quality `mid` the shadow walks may not happen at all

`quality.js` sets `csm: false` for both `low` and `mid` and `csm: true` for `high`/`ultra`,
and `index.js:1279` makes plain shadows a strict opt-in (`shadowsEnabled = !wireframeMode &&
shadowsParam === "on"`). So on a bare-URL `mid` run — **which is the configuration the 24.22 ms
was measured in** — `renderer.shadowMap.enabled` is likely never set true, `shadowMap.render`
returns on its first line, and the shadow bucket is ~0.

That is not a reason to drop the hypothesis; it is a reason the probe reports
`census.shadow.enabled` and `shadowSplit.dutyCycle` before anything else. **It also means the
remainder has a different shape at `mid` than at `high`, and a fix ranked off the `mid`
measurement must be re-ranked for the tiers that ship CSM.** One read settles which world we
are in.

---

## 1. The probe

`scene3d/frame_split.js`. Read-only, never called by the app, **no URL flag** — the shape
`window.__statMergeProjection` established for a pure diagnostic. `scene3d/index.js` imports it
for its side effect (installing the `window.__frameSplit*` surface) and nothing else; it costs
one module parse and zero frame time until something arms it.

### 1a. How it times without dominating what it measures

A `performance.now()` per node over 5,073 nodes costs ~0.25–0.5 ms — a third of the thing being
measured, and it would perturb the branch predictor and the allocation behaviour of the walk
it is timing. **Nothing here is timed per node.** The probe instead hooks the seams three
already exposes, each of which fires exactly once per render call and brackets a phase
precisely:

| seam | what it brackets |
|---|---|
| `renderer.render` (own instance property) | the whole call |
| `scene.onBeforeRender` | **end** of the `updateMatrixWorld` phase |
| `renderList.init` (exit) | **start** of `projectObject` |
| `renderList.finish` (entry) | **end** of `projectObject` |
| `renderList.sort` | the two sorts, exactly |
| `renderer.shadowMap.render` | the shadow phase, exactly |
| `scene.onAfterRender` | end of the scene submission |

The render-list seam is the unlock. `renderer.renderLists.get(scene, 0)` returns the **same**
`WebGLRenderList` object every frame (`WebGLRenderLists` caches per scene in a `WeakMap`,
indexed by render-call depth), and that object is a plain literal whose `init` / `finish` /
`sort` are **own properties** — wrappable and restorable without touching a prototype. In
`render()` the sequence is `init()`, an XR-only branch, `projectObject(scene, …)`, `finish()`,
with nothing else between them. So **`finish`-entry minus `init`-exit *is* `projectObject`** —
measured, not modelled, and not a transcription of three's traversal.

That is **14 timestamps per render call**. `renderBufferDirect` is wrapped as well (2 more per
draw, ~1,000/frame) so draw time can be **subtracted** from the shadow and scene windows — the
shadow phase contains real draws, and a shadow bucket that included them would double-charge
the draw funnel and invent a traversal cost that is really draw cost. The probe **measures its
own `performance.now()` unit cost at arm time** and reports `health.probeOverheadMs`, so the
instrument is priced rather than trusted. (In the offline suite it lands at ~0.005 ms.)

### 1b. How it prices a visit — the ballast, not an estimate

"3,600 Groups are visited every frame" is a **count**. This workload keeps teaching that count
is a poor proxy for cost: `?skipDeadAlpha` removed 12.1% of draws for 2.8% of frame;
`?statArrayMerge` removed 23 draws for 0.0 ms. So the probe does not multiply 3,600 by a guess.

`__frameSplitBallast(n)` attaches `n` empty `Group`s to the scene. An empty Group is
**provably image-identical**: `projectObject` matches none of its `isSprite` / `isMesh` /
`isLine` / `isPoints` branches so it pushes nothing onto the render list; it is not a light so
it changes no lights state; `WebGLShadowMap.renderObject`'s `object.isMesh` guard skips it so
it rasters nothing. It *is* visited by all five walks and does nothing else. So
**`Δbucket / n` is the measured unit cost of one node visit in that bucket.**

Two arms, because they isolate different walks:

| arm | walks affected |
|---|---|
| `__frameSplitBallast(n)` | `updateMatrixWorld` **and** `projectObject` **and** each shadow cascade |
| `__frameSplitBallast(n, {visible:false})` | `updateMatrixWorld` **only** — that walk has no `visible` early-out; the other two return at the ballast root |
| `__frameSplitBallast(n, {visible:false, matrixAutoUpdate:false})` | as above, minus the per-node `updateMatrix()` compose |

The differences between those three arms give, respectively, the projectObject+shadow visit
cost, the matrix-phase visit cost, and the compose-only cost — three units from three A/Bs, all
image-identical, none estimated. `opts.fanout` (default 8) builds a balanced tree rather than a
flat child array, because a flat 5,000-child array is not the memory access pattern of a real
graph; a unit measured flat should not be quoted against a deep population without saying so.

### 1c. Silence is not success

Every bucket the probe could not time reads `null`, never `0`:

* `buckets.project` is null on any call where `list.init` did not fire (a `renderLists.dispose()`
  on context loss orphans the patch — counted as `health.listDetachedCalls`).
* `buckets.sort` is null when `renderer.sortObjects === false`, because three then never calls
  `sort` at all. The skipped calls are counted in `health.noSortCalls`.
* `buckets.shadow` and `shadowSplit.traversalMs` are null when there is no shadow-map seam.
* `objHookMs` is null unless armed with `{objHooks:true}`, and `sceneSplit.glueAndLightsMs`,
  which is derived from it, is null too. It is **off by default**: `BatchedMesh.prototype
  .onBeforeRender` is the multidraw-rebuild investigation's instrument, and two wrappers on one
  prototype make both readings wrong in a way neither can detect. Arming it refuses outright if
  it finds the prototype already wrapped.
* `health.booksClosed` is false, loudly, when the buckets do not re-add to the measured total —
  **and it also requires every bucket to have been sampled on every accounted call.** The
  residual alone is not enough, and the way it fails is subtle enough that only the regression
  suite caught it: each bucket is a mean over *its own* sample count, so a phase that went
  unmeasured on 2 of 3 calls still has a right-sized mean and still lands the residual near
  zero. Mismatched denominators are not comparable and must not be added.

### 1d. Scale discipline

Four separate 2×+ overestimates on this workload came from counting at one scale and pricing at
another; `static_atlas.js _projDrawn` is the tombstone. So every population here names its
scale:

| scale | definition | what it prices |
|---|---|---|
| **RESIDENT** | every node under the scene | `scene.updateMatrixWorld` — no `visible` early-out |
| **VISITED** | nodes reachable without crossing a `visible === false` | `projectObject` and **each** shadow cascade — both open with that early-out |
| **SUBMITTED** | `list.opaque/transmissive/transparent` length, read in the `sort` wrapper | three's own answer after its own frustum cull |

The census **never re-derives the frustum**. Submitted comes only from the live render list.
Re-deriving it is exactly how `_projDrawn` produced a resident-scale number wearing a
submitted-scale name.

### 1e. What is measured but not yet split

`buckets.sceneSubmit` covers everything from the end of the shadow phase to
`scene.onAfterRender`: `setupLights` / `setupLightsView`, the transmission pass,
`background.render`, and the three `renderObjects` loops. Subtracting the measured
`renderBufferDirect` leaves `sceneSplit.minusDrawsMs`, which is **object `onBeforeRender` +
per-draw glue + lights setup** and is reported as one exact number. It splits further only when
`{objHooks:true}` is armed — which is the other investigation's call to make, not this one's.

### 1f. Tests

`test_frame_split_probe.mjs`, 61 assertions, 9 parts, no GL context needed: a fake renderer
reproduces three r184's real call **order** (the order is the entire basis of the attribution)
and burns known amounts of real wall-clock time in each phase. It asserts the phase boundaries,
that shadow draws are subtracted, that absent phases read `null`, that the books close and
*fail to close* when a phase goes missing, that foreign scenes are not folded in, the duty-cycle
denominator, the resident-vs-visited split, that the ballast is absolute rather than cumulative
and pushes nothing, and that disarm restores every seam — including `delete`-ing the
`scene.onBeforeRender` own property rather than reassigning a captured no-op over
`Object3D.prototype`.

---

## 2. Ranked hypotheses

Ranked for the **`mid` configuration the 24.22 ms was measured in** (see §0c — the ranking is
different at `high`/`ultra`). Each states its mechanism and what the probe shows if it is true.

### H1 — `scene.updateMatrixWorld()`: the RESIDENT walk with a per-node compose

**Mechanism.** ~5,073 resident nodes visited unconditionally; each with
`matrixAutoUpdate === true` (three's default) pays `updateMatrix()` = a `Matrix4.compose` from
position/quaternion/scale — ~40 arithmetic ops and 16 stores — *every frame, whether or not it
moved*, plus a 64-multiply `multiplyMatrices` wherever the dirty flag propagated. `cells.js`
already records an independent CPU profile at Town Network putting `updateMatrixWorld` at
**7.7% of the frame** with `cellsGroup ≈ 1,100 of ~2,900 scene nodes`. The graph has since
grown to ~5,073.

**Probe says true if:** `buckets.preProject` is the largest non-draw bucket, and
`census.resident.matrixAutoUpdate` is a large fraction of `census.resident.nodes`.
**Probe says false if:** `preProject` is small — in which case the app's own pre-render matrix
work has already left everything clean and the composes are being skipped upstream.

*Prior: 0.5–1.5 ms.* 5,073 × 100–300 ns.

### H2 — the per-draw glue and lights setup inside the scene submission

**Mechanism.** `renderObject` does, per draw, before it reaches the funnel:
`object.onBeforeRender(...)`, `object.modelViewMatrix.multiplyMatrices(...)` (64 mults),
`object.normalMatrix.getNormalMatrix(...)` (a 3×3 invert + transpose), `material.onBeforeRender`,
and in `renderObjects` an `object.layers.test`. At ~427 draws that is ~854 matrix operations
per frame that are not in the funnel. `currentRenderState.setupLights()` and
`setupLightsView(camera)` sit in the same window and are O(lights) with a per-light view-space
transform.

**Probe says true if:** `sceneSplit.minusDrawsMs` is large after the known ~5.72 ms of
`BatchedMesh.onBeforeRender` is accounted for. **This bucket cannot be fully resolved without
the object-hook number**, which is why it reports `null` for `glueAndLightsMs` rather than
guessing — arm `{objHooks:true}` (with the other instrument off) to close it.

*Prior: 0.2–0.6 ms of glue, plus whatever `setupLights` costs at this light count.*

### H3 — `projectObject`: the VISITED walk plus per-submitted work

**Mechanism.** ~5,073 visits of a 7-branch dispatch, of which ~3,600 are inert Groups that can
never contribute a draw. Plus, **per submitted object**, `objects.update(object)` (a
`WebGLObjects` map lookup and an attribute-update pass) and — because `sortObjects` is on — a
bounding-sphere `copy` + two `applyMatrix4`s to compute the sort key.

**Probe says true if:** `buckets.project` is large. The ballast then says *which half*: if
`Δproject/n` from the visible arm × `census.visited.inert` accounts for most of it, the Groups
are the cost; if not, it is the per-submitted work and deleting Groups buys little.

*Prior: 0.3–0.7 ms* — 5,073 visits at 25–60 ns (0.13–0.30 ms) plus ~427 × 0.3–1 µs.
**This is the user's leading hypothesis and I expect it to place third.**

### H4 — the shadow walk: 3 CSM cascades × the whole graph — CONDITIONAL

**Mechanism.** As §0b. Plus, per shadow draw, `getDepthMaterial` writes ~16 properties onto a
shared depth material and does a two-level cache lookup.

**Probe says true if:** `shadowSplit.dutyCycle` is near 1 **and** `shadowSplit.cascades` is 3
**and** `shadowSplit.traversalMs` is large. **Probe says it is ~0 if** `census.shadow.enabled`
is false — which §0c predicts for a bare-URL `mid` run. The RP5 gate (`lighting.js
applyStaticShadowGate`, default ON) makes the *identical* traversal fire on some frames and not
others, so `traversalMsPerRaster` — denominated in rastering calls, not all calls — is the only
honest way to quote one raster. Quoting the all-calls mean understates a raster by exactly
`1/dutyCycle`.

*Prior: 0 ms at `mid`; 0.4–1.0 ms of traversal at `high`/`ultra` at duty 1.0.*

### H5 — the two sorts

**Mechanism.** ~215 opaque items sorted by a 6-branch `painterSortStable`; ~212 transparent
z-sorted by a 4-branch `reversePainterSortStable`. ~1,700 comparisons each.

**Probe says true if:** `buckets.sort` is above ~0.3 ms. *Prior: 0.07–0.3 ms — the smallest
item on this list.* Cross-check it to death with the `sortObjects = false` arm (§3, step 6),
which removes the sorts **and** the bounding-sphere transform inside `projectObject`.

### H6 — `listSetup`, `listFinish`, `postSort…`, `tail`

`renderStates.init`, `clipping.init`, `renderList.finish`'s reference-clearing loop,
`background.addToRenderList`, the render-target resolve. *Prior: noise, together.* They are
bucketed anyway, because a bucket nobody looks at is how the books get to close on a phase that
was never there.

### Tombstoned before measurement

**"`WebGLMaterials` uniform refresh / program selection"** — inside `renderBufferDirect`, see
§0a. Already in the 12.78 ms. No bucket offered.

---

## 3. What to run

Boot as usual on the 1070 — Nanto, quality `mid`, `?renderScale=1&adaptiveRes=off&nosw=1`.
**Settle `draws/frame` before sampling** (`2026-08-06-frame-cost-structure-measured.md` §7: the
first sweep of that session was wasted because the scene was still streaming and draws climbed
291 → 523 across arms). Everything below runs in **one session** — two control runs ten minutes
apart have differed 40% in bucket count on this workload.

```js
// 1. Which world are we in? Do this FIRST — it decides whether H4 exists at all.
__frameSplitCensus()
//    read: resident.nodes, visited.nodes, visited.inert, resident.matrixAutoUpdate,
//          shadow.enabled, shadow.cascades, visitsPerFrame.*

// 2. The baseline split.
__frameSplitArm()          // → {armed:true, nowCostNs: …}
//    ... let ~10 s of frames run ...
__frameSplitDisarm()       // disarm BEFORE quoting: the wrappers cost time
__frameSplitReport()
```

**Stop and send me `health` if `booksClosed` is false.** Also check `health.probeOverheadMs`
(expected well under 0.1 ms), `health.listDetachedCalls` (expected 0) and `calls` vs your
displayed-frame count — if the app is submitting the world twice per frame, every ms figure is
per *call* and must be doubled to reach a per-frame number.

Then the ballast sweep, **interleaved base → arm → base** so drift is visible:

```js
// 3. Unit-cost sweep. ~10 s per arm. __frameSplitReset() zeroes without disarming.
__frameSplitArm()
__frameSplitReset();                                          /* 10 s */ const A = __frameSplitReport();  // BASE
__frameSplitBallast(4000);        __frameSplitReset();        /* 10 s */ const B = __frameSplitReport();  // visible
__frameSplitBallast(0);           __frameSplitReset();        /* 10 s */ const A2 = __frameSplitReport(); // BASE again (drift control)
__frameSplitBallast(4000, {visible:false});
                                  __frameSplitReset();        /* 10 s */ const C = __frameSplitReport();  // hidden
__frameSplitBallast(4000, {visible:false, matrixAutoUpdate:false});
                                  __frameSplitReset();        /* 10 s */ const D = __frameSplitReport();  // hidden, no compose
__frameSplitBallast(0);           __frameSplitReset();        /* 10 s */ const E = __frameSplitReport();  // BASE again
__frameSplitDisarm()
```

The units fall out as:

```
projectObject visit          = (B.buckets.project    - A.buckets.project)    / 4000
matrix-phase visit           = (C.buckets.preProject - A.buckets.preProject) / 4000
   ... of which the compose   = (C.buckets.preProject - D.buckets.preProject) / 4000
shadow visit per cascade     = (B.shadowSplit.traversalMs - C.shadowSplit.traversalMs)
                               / (4000 * cascades * dutyCycle)     // null when shadows are off
```

`A`, `A2` and `E` are three baselines around the arms; **if they disagree by more than the
smallest Δ you are trying to read, the sweep is not usable** and the arms need re-interleaving.
That check is the whole reason there are three of them.

```js
// 4. Optional: price the sort and the sort-key transform together. Changes draw ORDER,
//    so this is a measurement arm only — do not screenshot it.
liveScene3d.renderer.sortObjects = false;   // 10 s
liveScene3d.renderer.sortObjects = true;
```

```js
// 5. Close sceneSubmit. See §6 for the full sequence and what each number means.
__frameSplitDisarm();
__frameSplitArm({ objHooks: true, glueSample: 8 })
//    No constructor argument any more — the hooks are adopted off the live
//    render list, because on this app they are OWN properties. See §6a.
```

`__frameSplitSamples()` returns the raw per-call rows (`total`, `project`, `shadow`,
`submitted`, `drawsScene`, …) if you want to regress a bucket against a naturally varying
population — the §5a method — rather than trusting a mean.

---

## 4. If H1 or H3 confirm, what a fix looks like

Two things first, both of which apply to every number in this section.

**My priors under-explain the remainder.** H1 through H6's midpoints add to roughly 2.6 ms
against a 5.72 ms remainder. Either one bucket is much bigger than I predict, or
`sceneSubmit`'s glue+lights is, or the remainder contains something none of us has named. That
gap is the honest reason to run the probe before designing anything — and if the probe comes
back with the buckets summing to 5.72 ms and no bucket above 1 ms, then the right conclusion is
that **there is no single lever here**, and the two leads already on the board (`2026-08-06-
frame-cost-structure-measured.md` §6: ClipMap out of the transparent pass at −1.2 ms; array-
texture bucket merging at ~6.4 ms *before* its own §5a caveats) stay ahead of everything below.

**Every value below is a formula, not a promise.** Fill it from the ballast.

### Fix A — `matrixAutoUpdate = false` on the static population (pays H1)

**What it removes.** The per-node `updateMatrix()` compose, and *only* that. It does **not**
remove the recursion (§0b), so its ceiling is
`census.resident.matrixAutoUpdate × composeUnit`, where `composeUnit = (C.preProject -
D.preProject)/4000` from the sweep — never `buckets.preProject`.

**Risk.** A node that does move and gets frozen is a bug that shows as an object stuck in
place. So it applies only where a "never moves after attach" invariant already exists and is
written down — `cells.js` has one; `animated_scenery.js`, `far_terrain.js`, `portal_punch.js`
and `portal_stencil.js` already do this locally; `buildings.js:142` explicitly sets
`matrixAutoUpdate = true` and that line would need reading before touching anything nearby.

**Range: 0.2–0.9 ms**, on the reasoning that the compose is the larger half of a matrix-phase
visit and that most of the 5,073 are static. Bottom of the range if the app has already left
most of the graph clean; top if `resident.matrixAutoUpdate` comes back near 5,073.

### Fix B — delete the ~3,600 inert Groups (pays H1 + H3, and H4 where it applies)

**What it removes.** A whole node from every walk. Value:

```
inert × ( matrixVisitUnit + projectVisitUnit + cascades × shadowVisitUnit × dutyCycle )
```

with `inert = census.visited.inert` and every unit measured by the sweep. At `mid` with
shadows off the third term is zero and this is the sum of two units against ~3,600 nodes.

**Range: 0.15 ms – 1.2 ms.** The bottom is 3,600 × ~40 ns × 1 walk; the top is 3,600 × ~110 ns
× 3 walks, which only applies at `high`/`ultra`. **The spread is 8×, which is exactly why the
ballast exists and why this should not be sold before the sweep runs.** It is also, honestly,
the *most work* of anything here — flattening a scene graph touches attach/evict/visibility in
`statics.js`, `buildings.js`, `cells.js` and the LRU — so it needs to come back near the top of
that range to be worth starting.

### Fix C — prune the shadow walk (pays H4; **only at `high`/`ultra`**)

**Mechanism.** `WebGLShadowMap.render(lights, scene, camera)` uses `scene` for exactly two
things: a `typeChanged` material-refresh traverse, and `renderObject(scene, …)`'s recursion. And
`renderObject` reads only `visible`, `layers.test`, `isMesh`/`isLine`/`isPoints`,
`matrixWorld` and `children` — it never re-derives a matrix (they were composed by
`scene.updateMatrixWorld` earlier in the same `render()` call). So wrapping
`renderer.shadowMap.render` in app code and handing it a **caster-only view** — a plain object
carrying a `layers`, `visible: true` and a `children` array referencing the existing
caster group nodes, with no reparenting — is sufficient and image-identical, provided the view
contains every `castShadow` node. It is the same "hook a seam three already exposes" idiom as
this probe.

**Range: 40–70% of `shadowSplit.traversalMs`**, depending on what fraction of `visited.nodes`
is reachable only through non-casting subtrees (terrain, particles, HUD). Multiply by
`dutyCycle`. At `mid` that is zero and this fix does not exist; at `high` with 3 cascades at
duty 1.0 and a 1.0 ms traversal it is 0.4–0.7 ms.

**A cheaper variant with no code**: widen the RP5 gate so a distant NPC's step does not force a
full 3-cascade re-raster. Value `= (shadowTraversal + shadowDraws) × Δduty`. That one is a
fidelity trade and needs the eye-test, not a flag flip.

---

## 5. Notes for whoever runs this next

* **The runtime three is the CDN pin** (`index.html` importmap, `three@0.184.0`), not
  `node_modules/three`. They are different copies; `node_modules` happens to be pinned to the
  same 0.184.0, which is why the source citations above are trustworthy — but check the
  importmap before trusting a future one.
* `index.html`'s modulepreload block is generated by `scripts/gen-modulepreload.mjs`, and the
  committed block has **drifted** from what the generator now produces (running it drops the
  `pkg/holtburger_web.js` wasm preload and three scene3d modules, and adds a dozen unrelated
  ones). This change therefore hand-added its single line rather than regenerating. That drift
  is pre-existing and wants its own look; do not let a perf change be the thing that silently
  drops the wasm preload.
* `window.liveScene3d` is a one-time init snapshot, and the `__cam` / `__set*` helpers attach
  only after `in-world`. The probe reads `liveScene3d.renderer` and `liveScene3d.scene`, both
  of which are set at init, so arming any time after `in-world` is fine.
* Disarm before quoting any frame time. The probe's own wrappers are in the frame while armed,
  and `health.probeOverheadMs` is the size of that, not zero.

---

## 6. The `sceneSubmit` split — the 3.42 ms, and the instrument for it

The first run of the probe on the 1070 (549 calls, quality `mid`) closed three threads and left
one standing:

| bucket | ms/call | state |
|---|---|---|
| **`sceneSubmit` − draws (per-object glue)** | **3.42** | **unattributed, and `objHookMs` read `null`** |
| `preProject` (`scene.updateMatrixWorld`) | 2.06 | closed — ceiling 0.48 ms |
| `project` (`projectObject`) | 1.54 | closed |
| `sort` | 0.16 | — |
| `shadow` | 0.002 | `dutyCycle` 0 at `mid`, as §0c predicted |

At ~470 SUBMITTED objects, 3.42 ms is **~7.3 µs per submitted object** of non-draw work. That
is a very large number for three lines of matrix arithmetic, and the discrepancy is the whole
reason this section exists: **`sceneSubmit` is not one population.** Read
`WebGLRenderer.render` r184 from the end of `shadowMap.render` to `scene.onAfterRender` and
four of the things in that window are **once per call** (`setupLights`, `setupLightsView`,
`background.render`, the multisample resolve + `output.end`) while two are **per submitted
object** (the object hook, and the glue: `modelViewMatrix.multiplyMatrices` +
`normalMatrix.getNormalMatrix` + `material.onBeforeRender`). Quoting them as one number is
exactly the scale confusion that produced the five 2×+ overestimates on this workload.

### 6a. Why `objHookMs` could not be closed by wrapping a prototype — a tombstone

The probe's original `{objHooks:true}` wrapped `BatchedMesh.prototype.onBeforeRender`. **On this
app that measures an empty population and reports a confident ~0**, because the hot hooks are
instance properties, which shadow the prototype:

| site | what it does |
|---|---|
| `scene3d/static_batch_x.js` `_installMemo` | `bm.onBeforeRender = _memoOnBeforeRender` — on every batch bucket, default-on |
| `scene3d/static_atlas.js` `armStatMergeSubmittedSampler` | `o.onBeforeRender = fn` |
| `scene3d/blood_decals.js` | `mesh.onBeforeRender = () => {...}` |

A prototype wrapper never runs for any of them. So the hooks are now **adopted off the live
render list** instead: once per call, inside the already-wrapped `list.finish`, the probe walks
`list.opaque/transmissive/transparent` — three's own answer, at SUBMITTED scale, never
re-derived — and wraps every object whose `onBeforeRender` is not
`Object3D.prototype.onBeforeRender`. Objects carrying the stock no-op are deliberately left
alone: an empty call is ~2 ns and wrapping 470 of them would cost more than they do. Their
dispatch is inside `glueSpanMs`, bounded by `submitted × 2 ns` ≈ 0.001 ms.

The scan costs 2 timestamps and ~470 property reads per call, is measured as
`health.objHooks.scanMs`, and lands **inside `buckets.listFinish`** — that bucket is inflated by
exactly that much while `{objHooks:true}` is armed, which is stated rather than netted out,
because opening a hole outside the window would break the books.

⚠ **Interaction.** `static_atlas.js armStatMergeSubmittedSampler` skips any node that already
owns an `onBeforeRender`. While this probe is armed with `{objHooks:true}` every hooked node
owns one, so that sampler arms and samples nothing — the same trap `static_batch_x.js` documents
for `?statBatchMemo`. Run them one at a time.

### 6b. The split, and what it costs

**Zero extra timestamps.** `renderBufferDirect` is already wrapped, so the first scene-phase
draw's entry and the last one's exit are stamps the probe already takes. They tile `sceneSubmit`
three ways:

```
preSubmitMs  = firstSceneDraw.entry − shadowEnd    ONCE PER CALL
               setupLights + setupLightsView + background.render
               + clipping.endShadows + info.reset
drawLoopMs   = lastSceneDraw.exit  − firstSceneDraw.entry
               every renderObject, start to finish
postDrawMs   = onAfterRender       − lastSceneDraw.exit    ONCE PER CALL
               multisample resolve + render-target mipmap + output.end

glueSpanMs   = drawLoopMs − rbdSceneMs − objHookInLoopMs   PER SUBMITTED OBJECT
```

`sceneSplit.split.booksClosed` checks those three re-add to `sceneSubmit`, with the same
"every bucket sampled on every call" rule as the top-level books.

**Two window-edge facts, both worth a 2×-class error and both caught by the regression suite
rather than by reading the code:**

1. `drawLoopMs` opens at the **first draw**, so the first submitted object's `onBeforeRender`
   already fired and is inside `preSubmitMs`. Subtracting the whole hook total leaves
   `glueSpanMs` **negative** when hooks are few and expensive, and quietly low when they are
   many and cheap. Only `objHookInLoopMs` is subtracted. One null check per hook.
2. For the same reason the window spans N draws but only **N−1** inter-draw gaps.
   `glueSpanPerSubmittedUs` (÷N) is biased **low** by 1/N; `glueSpanPerGapUs` (÷N−1) is the
   unbiased per-object figure. At 470 submitted the difference is 0.2%; at 8 it is 12.5%. Quote
   per-submitted for "what would deleting an object save", per-gap against the sampler.

### 6c. Two independent cross-checks on the same number

The span arithmetic is one estimate. Neither of these shares its failure modes.

**The glue sampler** (`{glueSample:k}`) borrows up to *k* stock-no-op `onBeforeRender` slots off
the submitted list and times **hook-exit → `renderBufferDirect`-entry** directly. That window is
`modelViewMatrix.multiplyMatrices` + `normalMatrix.getNormalMatrix` + `material.onBeforeRender`
and nothing else — a strict subset of a gap, so `glueSampleUs ≤ glueSpanPerGapUs` must hold and
a violation means one of the two is wrong. Cost: **one** extra clock read per sample per call
(the rbd side reuses a stamp it already takes), so k=8 is ~0.0004 ms. Bias, stated: the k
objects are the first stock-hook objects in render-list order on the first sampled call and are
kept for the session, so the sample carries their cache locality, not a random object's. The
glue is the same three lines for every object, so this measures the code; the ballast below is
the check on whether it measures the population.

**The draw ballast** (`__frameSplitDrawBallast(n)`) is the SUBMITTED-scale ballast the node
ballast cannot be. An empty `Group` is never pushed onto a render list — it prices a **visit**
and can say nothing about a **submitted object**. The draw ballast attaches `n` Meshes sharing
one geometry and one material, `frustumCulled = false` so three submits every one at any camera.
Image-identical for the same class of reason as the empty Group: the geometry is **one triangle
whose three vertices are the same point**, so the rasteriser emits no fragments — no colour, no
depth, at any camera, in any order. Sharing the geometry and material is deliberate:
`WebGLObjects.update` memoises per geometry per frame and `setProgram` early-outs on an
unchanged material, so the injection adds `renderObject` glue and close to the floor of a draw
rather than n programs. The unit:

```
glueUnit = Δ(drawLoopMs − drawMs) / n
```

It also inflates `submitted`, `project` and `sort` — those are **arms, not baselines**, while it
is attached, and `report().ballast.drawNodes` says so.

### 6d. What to run

One session, after `draws/frame` has settled, same conditions as §3.

```js
// 0. Which hooks exist at all, and what would price setupLights.
__frameSplitCensus()
//    read: hooks.ownOnBeforeRender  <- a prototype wrapper CANNOT see these
//          hooks.inheritedOverride  <- it could
//          hooks.byConstructor      <- what is about to be timed
//          hooks.identityCheckOk    <- false ⇒ two copies of three, stop
//          preSubmitInputs.lights / lightsByType / sceneBackground

// 1. The split, with the hook total and the direct glue sample.
__frameSplitArm({ objHooks: true, glueSample: 8 })
//    ... ~10 s ...
__frameSplitDisarm(); const R = __frameSplitReport();
```

Read, in this order:

* `health.booksClosed` and `sceneSplit.split.booksClosed` — **stop and send `health` if either
  is false**; every share below is then wrong.
* `health.objHooks.fullySampled` — false means `objHookMs` is `null` on purpose (the adopt scan
  missed a call) and the split cannot be closed from this run.
* `health.probeOverheadMs` and `health.probeClockReadsPerCall` — the instrument, priced. The
  sub-split contributes **0** clock reads; the hooks contribute 2 per hooked object per call.
* `sceneSplit.split.preSubmitMs` vs `glueSpanMs` — **this is the decision.**

Then the ballast, interleaved base → arm → base as in §3:

```js
__frameSplitArm({ objHooks: true });
__frameSplitReset();                       /* 10 s */ const A  = __frameSplitReport();  // BASE
__frameSplitDrawBallast(400);
__frameSplitReset();                       /* 10 s */ const B  = __frameSplitReport();  // +400 submitted
__frameSplitDrawBallast(0);
__frameSplitReset();                       /* 10 s */ const A2 = __frameSplitReport();  // BASE (drift)
__frameSplitDisarm();

// glueUnit, µs per submitted object — the third independent estimate
1000 * ((B.sceneSplit.split.drawLoopMs - A.sceneSplit.split.drawLoopMs)
        - (B.sceneSplit.drawMs - A.sceneSplit.drawMs)) / 400
```

If `A` and `A2` disagree by more than the Δ being read, the sweep is not usable — the same rule
as §3, for the same reason.

### 6e. Ranked hypotheses for the 3.42 ms, with the probe's signature for each

Priors, not measurements. §4's warning applies with full force: my priors under-explained the
last block by ~2×, and **all of these can be true at once** — 3.42 ms is a big enough number to
be a sum rather than a lever.

**H2c — the object hooks are still inside it.** *Prior: 1.0–2.5 ms, and the one I would bet on
being biggest.* The 5.72 ms `BatchedMesh.onBeforeRender` in the original three-way split was
measured with a **prototype** wrapper, and per §6a this app installs the memo as an **own
property** — so that 5.72 ms and this 3.42 ms may be measuring overlapping or disjoint parts of
the same work depending on `?statBatchMemo`, and **nobody has checked which**. Probe signature:
`objHookMs` large, `sceneSplit.split.hookedPerCall` a substantial fraction of `submitted`. Run
it twice, `?statBatchMemo=on` and `=off`, before quoting either number.

**H2b — `setupLights` / `setupLightsView`, once per call.** *Prior: 0.2–1.5 ms, widening with
`census.preSubmitInputs.lights`.* `WebGLLights.setup` walks every light rebuilding the uniform
cache and `setupView` transforms each into view space; `getProgram` also compares
`lights.state.version`, so a churning light state invalidates the per-material early-out inside
the funnel. Probe signature: **large `preSubmitMs` that does NOT move with `submitted`** —
regress `preSubmit` against `submitted` over `__frameSplitSamples()`; a flat line confirms it,
and it is a *different* fix from anything per-object.

**H2a — the per-object glue really is ~7 µs × 470.** *Prior: 0.3–1.0 ms — I expect this to
explain a quarter of the block, not all of it.* `multiplyMatrices` is 64 multiplies and
`getNormalMatrix` a 3×3 invert-transpose; 7 µs each would make one `Matrix4.multiply` cost ~3 µs,
roughly 100× what it costs. **Something else is in there.** Probe signature: `glueSpanMs` ≈ 3 ms
**and** `glueSampleUs` ≈ 6–7 µs — the sampler is what makes this falsifiable, because if the
glue really were 7 µs the sampler would see it on a single object.

**H2d — `postDrawMs`: the multisample resolve and `output.end`.** *Prior: 0.1–0.4 ms.* A
CPU-side blit setup and a fullscreen quad. Small, but it has never been separated from the glue
and no per-object fix will touch it. Probe signature: `postDrawMs` alone.

**Tombstoned, again:** program selection and the uniform refresh (§0a — inside the funnel), and
`background.render` whenever `census.preSubmitInputs.sceneBackground` is `null`, which it is
when the sky is its own scene.
