// ===========================================================================
// FRAME SPLIT — attributing the ~24 ms `renderer.render()` REMAINDER
// (2026-08-06, successor instrument to `docs/2026-08-06-frame-cost-structure-
// measured.md` §2)
//
// WHAT THIS IS FOR. That document splits the render call three ways on the
// 1070 at Nanto, quality `mid`:
//
//     renderer.render() total                   24.22 ms
//     ├ renderBufferDirect (the draw funnel)    12.78 ms   53%
//     ├ BatchedMesh.onBeforeRender (rebuild)     5.72 ms   24%
//     └ REMAINDER — unattributed                 5.72 ms   24%
//
// The remainder is three's own per-frame work, and it has never been split.
// This module splits it, from OUTSIDE three, with a fixed ~14 timestamps per
// render call rather than a timer per node.
//
// ---------------------------------------------------------------------------
// A PREMISE THIS INSTRUMENT KILLS BEFORE IT MEASURES ANYTHING
// ---------------------------------------------------------------------------
// The remainder was described as "projectObject + render-list sort + WebGL-
// Materials uniform refresh + program/state selection + shadow-map setup".
// Two of those are NOT in it. `WebGLRenderer.renderBufferDirect` opens with
//
//     const program = setProgram( camera, scene, geometry, material, object );
//
// (three r184 `WebGLRenderer.js`, first statement of `renderBufferDirect`), and
// `setProgram` is where `getProgram` / `WebGLPrograms` / `materials.refresh` /
// every uniform upload lives. So program selection and the uniform refresh are
// already inside the 12.78 ms draw funnel. Looking for them in the remainder
// finds nothing, and this file does not offer a bucket for them.
//
// ---------------------------------------------------------------------------
// THE GRAPH IS WALKED FIVE TIMES PER FRAME, NOT ONCE
// ---------------------------------------------------------------------------
// The scene is ~5,073 nodes for ~1,484 meshes. `projectObject` walking it once
// is the obvious cost and is the SMALLEST of the walks. Per world render call
// three also walks it in:
//
//   * `scene.updateMatrixWorld()` (`WebGLRenderer.render` line 1 of the body) —
//     `Object3D.updateMatrixWorld` recurses into EVERY child unconditionally.
//     It does not early-out on `visible === false`, and — read this next line
//     twice — `matrixWorldAutoUpdate = false` does NOT prune the subtree. It
//     skips one `multiplyMatrices`; the recursion and the per-node
//     `if (this.matrixAutoUpdate) this.updateMatrix()` both still run. The
//     comment on `cells.js` FREEZE_STATIC_MATRIX ("makes three skip the whole
//     subtree every frame") overstates what r184 actually does. That gate is
//     still worth its keep — it removes ~1,100 matrix composes — but it did
//     not remove ~1,100 visits, and no number derived from it should assume so.
//
//   * `shadowMap.render()` — `WebGLShadowMap.renderObject` recurses the whole
//     scene ONCE PER SHADOW-CASTING LIGHT. `csm.js` runs THREE cascade lights
//     (`DEFAULT_CSM_SPLITS = [30, 100, 300]`), each `castShadow = true`. So on
//     a frame that rasters, that is three more full walks.
//
// One `updateMatrixWorld` + one `projectObject` + three cascades = five walks,
// so `projectObject` is ~20% of the traversal the frame actually pays for.
// Whether the shadow walks fire at all depends on the RP5 static-shadow gate
// (`lighting.js applyStaticShadowGate`, default ON), which sets
// `renderer.shadowMap.autoUpdate = false` and re-arms `needsUpdate` only when
// something shadow-relevant moved. THE DUTY CYCLE OF THAT GATE IS THEREFORE A
// FIRST-CLASS OUTPUT OF THIS PROBE — a shadow bucket quoted without it is
// meaningless, because the same traversal is either 3x or 0x depending on
// whether an NPC took a step.
//
// ---------------------------------------------------------------------------
// HOW IT TIMES WITHOUT DOMINATING WHAT IT MEASURES
// ---------------------------------------------------------------------------
// A `performance.now()` per node over 5,073 nodes costs ~0.25-0.5 ms and would
// be a third of the thing being measured. So nothing here is timed per node.
// Instead the probe hooks the SEAMS three already exposes, each of which fires
// exactly once per render call and brackets a phase precisely:
//
//   seam                                  brackets
//   ------------------------------------  --------------------------------
//   renderer.render (own instance prop)   the whole call
//   scene.onBeforeRender                  END of updateMatrixWorld phase
//   renderList.init  (own prop, exit)     START of projectObject
//   renderList.finish (own prop, entry)   END of projectObject   <- EXACT
//   renderList.sort  (own prop)           the two sorts          <- EXACT
//   renderer.shadowMap.render (own prop)  the shadow phase       <- EXACT
//   scene.onAfterRender                   END of the scene submission
//
// `renderer.renderLists.get(scene, 0)` returns the SAME `WebGLRenderList`
// object every frame (`WebGLRenderLists` caches per scene in a WeakMap, indexed
// by render-call depth), and that object is a plain literal whose `init` /
// `finish` / `sort` are own properties — so they can be wrapped and restored
// without touching a prototype. `projectObject` sits between `init()` and
// `finish()` with nothing else in between (`WebGLRenderer.js`: `init()`,
// optional XR depth-mesh, `projectObject(scene, …)`, `finish()`), so
// `finish-entry - init-exit` IS `projectObject`, measured, not modelled.
//
// That is 14 timestamps per render call. `renderBufferDirect` is wrapped too
// (2 more per draw) so that draw time can be SUBTRACTED from the shadow and
// scene windows — the shadow phase contains real draws, and a shadow bucket
// that included them would double-count the funnel. The probe measures its own
// `performance.now()` unit cost at arm time and reports `probeOverheadMs` so
// the reader can price the instrument instead of trusting it.
//
// ---------------------------------------------------------------------------
// SPLITTING `sceneSubmit` — the last unattributed block (2026-08-06, part 2)
// ---------------------------------------------------------------------------
// The first run of this probe on the 1070 (549 calls, quality `mid`) left one
// block standing:
//
//     sceneSubmit − draws (per-object glue)   3.42 ms   <- unattributed
//     preProject (scene.updateMatrixWorld)    2.06 ms   closed (ceiling 0.48)
//     project    (projectObject)              1.54 ms   closed
//     sort                                    0.16 ms
//     shadow                                  0.002 ms  (dutyCycle 0 at `mid`)
//
// At ~470 SUBMITTED objects that is ~7.3 µs per submitted object of non-draw
// work — which is a very large number for three lines of matrix arithmetic, and
// that discrepancy is the reason this half exists. `sceneSubmit` is NOT one
// thing. Reading `WebGLRenderer.render` r184 from the end of `shadowMap.render`
// to `scene.onAfterRender`, in order:
//
//     clipping.endShadows(); info.reset()
//     currentRenderState.setupLights()                 <- once per call, O(lights)
//     renderTransmissionPass(...)   if transmissive.length > 0
//     background.render(scene)      if scene.background
//     renderScene(...)
//       └ currentRenderState.setupLightsView(camera)   <- once per call, O(lights)
//       └ renderObjects(opaque) / (transmissive) / (transparent)
//           └ object.layers.test(camera.layers)            per SUBMITTED object
//           └ renderObject:
//               object.onBeforeRender(...)                     <- OBJ HOOK
//               object.modelViewMatrix.multiplyMatrices(...)   } THE GLUE
//               object.normalMatrix.getNormalMatrix(...)       }
//               material.onBeforeRender(...)                   }
//               renderer.renderBufferDirect(...)               <- already timed
//               object.onAfterRender(...)
//     textures.updateMultisampleRenderTarget / updateRenderTargetMipmap
//     output.end(...)                                   <- once per call
//
// Two of those groups are ONCE PER CALL and two are PER SUBMITTED OBJECT, and
// they were being quoted as one 3.42 ms number. The split between them costs
// ZERO extra timestamps: `renderBufferDirect` is already wrapped, so the FIRST
// scene-phase draw's entry and the LAST one's exit are timestamps the probe
// already takes. That gives, exactly:
//
//   preSubmitMs  = firstSceneDraw.entry − shadowEnd
//                  ... setupLights + setupLightsView + background.render +
//                      clipping.endShadows + info.reset. ONCE PER CALL.
//   drawLoopMs   = lastSceneDraw.exit  − firstSceneDraw.entry
//                  ... every renderObject, start to finish.
//   postDrawMs   = onAfterRender       − lastSceneDraw.exit
//                  ... multisample resolve + mipmap + output.end. ONCE PER CALL.
//   glueSpanMs   = drawLoopMs − rbdSceneMs − objHookInLoopMs
//                  ... THE per-submitted-object glue, with the draws and the
//                      object hooks removed. This is the 7.3 µs claim's home.
//
// TWO WINDOW-EDGE FACTS, both of which cost a 2x-class error if ignored — this
// investigation has now produced five of those, and both of these were caught
// by the regression suite rather than by reading the code:
//   1. `drawLoopMs` opens at the FIRST draw's entry, so the first submitted
//      object's `onBeforeRender` has ALREADY FIRED and is inside `preSubmitMs`.
//      Subtracting the whole hook total leaves `glueSpanMs` negative when hooks
//      are few and expensive, and quietly low when they are many and cheap. So
//      only `objHookInLoopMs` — the hooks that fired after the window opened —
//      is subtracted. The split costs one null check per hook.
//   2. For the same reason the window spans N draws but only N−1 inter-draw
//      GAPS. `glueSpanPerSubmittedUs` (÷N) is therefore biased LOW by 1/N and
//      `glueSpanPerGapUs` (÷N−1) is the unbiased per-object figure. At the live
//      470 submitted the gap between them is 0.2% and either will do; at 8 it
//      is 12.5%. Both are reported; quote the per-submitted one for "what would
//      deleting an object save" and the per-gap one against the glue sampler.
//
// If `setupLights` is the co-suspect, it shows as a large `preSubmitMs` that
// does NOT scale with submitted count. If the glue is, `glueSpanMs` carries it
// and `glueSpanPerSubmittedUs` is the unit. They cannot both hide in one bucket
// any more. Caveats, stated because they are the ways this reads wrong:
//   * a transmission pass (`submitted.transmissive > 0`) draws BEFORE
//     `background.render`, so its first draw closes `preSubmitMs` early and the
//     rest of the pass lands in `drawLoopMs`. `submitted.transmissive` is
//     reported next to it; at 0 the concern does not exist.
//   * `output.end` renders a fullscreen quad. If that goes through
//     `renderBufferDirect` it is the LAST scene draw and `postDrawMs` shrinks to
//     the resolve; if it does not, it is in `postDrawMs`. Either way it is one
//     draw and it is inside `sceneSubmit`, not lost.
//   * a call with ZERO scene draws leaves all three null. Never 0.
//
// ---------------------------------------------------------------------------
// WHY `objHookMs` IS ADOPTED FROM THE RENDER LIST, NOT WRAPPED ON A PROTOTYPE
// ---------------------------------------------------------------------------
// TOMBSTONE. The first version of this file wrapped `BatchedMesh.prototype
// .onBeforeRender` and called that "the object hooks". On THIS app that would
// have measured close to nothing and reported it with confidence, because the
// app does not use the prototype hook on its hot population:
//
//   * `static_batch_x.js:_installMemo`  `bm.onBeforeRender = _memoOnBeforeRender`
//   * `static_atlas.js:armStatMergeSubmittedSampler`  `o.onBeforeRender = fn`
//   * `blood_decals.js`                 `mesh.onBeforeRender = () => {...}`
//
// All three are OWN properties on the instance, which SHADOW the prototype. A
// prototype wrapper never runs for them. That is the same class of error as
// `_projDrawn`: an instrument that looks right, reports a small number, and is
// measuring an empty population.
//
// So the hooks are adopted from the SUBMITTED population instead. Once per
// call, inside the already-wrapped `list.finish`, the probe walks
// `list.opaque/transmissive/transparent` — three's own answer, at SUBMITTED
// scale, never re-derived — and for every object whose `onBeforeRender` is not
// `Object3D.prototype.onBeforeRender` it installs a timing wrapper (memoised by
// function identity, so a steady-state frame wraps nothing). Objects that carry
// the stock no-op are left alone: an empty function call is ~2 ns and wrapping
// 470 of them would cost more than the thing being measured. Their dispatch is
// therefore inside `glueSpanMs`, where it belongs, and is bounded by
// `submitted × ~2 ns` ≈ 0.001 ms.
//
// The scan costs 2 timestamps and ~470 property reads per call. It is MEASURED
// (`health.adoptScanMs`) rather than assumed, and it lands inside the
// `listFinish` bucket — so `listFinish` is inflated by exactly that much while
// `{objHooks:true}` is armed, and the books still close.
//
// ⚠ INTERACTION. `static_atlas.js armStatMergeSubmittedSampler` skips any node
// that already owns an `onBeforeRender`. While this probe is armed with
// `{objHooks:true}` every hooked node owns one, so that sampler will arm and
// then sample nothing — the same trap `static_batch_x.js` documents for
// `?statBatchMemo`. Run them one at a time.
//
// ---------------------------------------------------------------------------
// HOW IT PRICES A VISIT — the ballast, not an estimate
// ---------------------------------------------------------------------------
// "3,600 Groups are visited every frame" is a COUNT. `docs/2026-08-06-frame-
// cost-structure-measured.md` §2 states the rule this workload keeps teaching:
// draw/object count is a poor proxy for cost (`?skipDeadAlpha` removed 12.1% of
// draws for 2.8% of frame; `?statArrayMerge` removed 23 draws for 0.0 ms). So
// this probe does not multiply 3,600 by a guess.
//
// `setFrameSplitBallast(n)` attaches `n` empty `Group`s to the scene. An empty
// Group is provably image-identical: `projectObject` matches none of its
// isSprite/isMesh/isLine/isPoints branches so it pushes nothing, and
// `WebGLShadowMap.renderObject` draws nothing for it. But it IS visited by all
// five walks. So `Δbucket / n` is the MEASURED unit cost of one node in that
// bucket, and `inertNodes × unit` is what deleting the Groups would recover.
//
// Two arms, because they isolate different walks:
//   `setFrameSplitBallast(n)`                  → prices updateMatrixWorld,
//                                                projectObject AND the shadow
//                                                walk in one injection.
//   `setFrameSplitBallast(n, {visible:false})` → prices updateMatrixWorld ONLY.
//                                                `updateMatrixWorld` ignores
//                                                `visible`; `projectObject` and
//                                                the shadow walk both return on
//                                                it. The difference between the
//                                                two arms is the cleanest split
//                                                this instrument can produce.
//
// The node ballast prices a VISIT. It cannot price a SUBMISSION, because an
// empty Group is never submitted — so it says nothing about the 7.3 µs per
// submitted object. `setFrameSplitDrawBallast(n)` is the second ballast, for
// exactly that: `n` Meshes sharing ONE degenerate geometry (three identical
// vertices → zero area → the rasteriser emits no fragments, so it is
// image-identical for the same reason an empty Group is) and ONE material, with
// `frustumCulled = false` so three submits every one of them regardless of where
// the camera is looking. Each costs one full trip through `renderObject`. So
//
//     glueUnit = Δ(drawLoopMs − rbdSceneMs) / n
//
// is the MEASURED per-submitted-object glue, independent of the span arithmetic
// above, and the two should agree. Sharing one geometry and one material is
// deliberate: `objects.update` memoises per geometry per frame and `setProgram`
// early-outs on an unchanged material, so the ballast adds the renderObject
// glue and almost nothing else. It DOES also add `n` to the render list, which
// inflates `project` and `sort` — expected, and the reason the node ballast is
// still the right tool for those two buckets.
//
// ---------------------------------------------------------------------------
// SCALE DISCIPLINE — every population here names its scale
// ---------------------------------------------------------------------------
// Four 2x+ overestimates on this workload came from counting at one scale and
// pricing at another (`static_atlas.js _projDrawn` is the tombstone: it tested
// `visible` + `instances > 0`, never the frustum, and its "drawn" removed 4
// buckets of 346 against 177 really submitted). So:
//
//   RESIDENT  — every node under the scene. Prices `updateMatrixWorld`, which
//               does not early-out on `visible`.
//   VISITED   — nodes reachable without crossing a `visible === false`. Prices
//               `projectObject` and each shadow-cascade walk, both of which DO
//               early-out on it. Strictly smaller than resident.
//   SUBMITTED — render-list length, read off `list.opaque/transmissive/
//               transparent` in the `sort` wrapper. This is three's own answer
//               after its own frustum cull. The census NEVER re-derives the
//               frustum — that would be the transcription `static_atlas.js`
//               forbids, and it is exactly how `_projDrawn` went wrong.
//
// ---------------------------------------------------------------------------
// SILENCE IS NOT SUCCESS
// ---------------------------------------------------------------------------
// Every bucket this probe could not time reads `null`, never `0`:
//   * `projectMs` is null on any frame `list.init` did not fire (a
//     `renderLists.dispose()` on context loss orphans the patch — counted as
//     `listDetachedCalls`).
//   * `sortMs` is null when `renderer.sortObjects === false`, because then
//     three never calls `sort` at all.
//   * `objHookMs` is null unless armed with `{objHooks:true}`, and every bucket
//     derived from it is null too. It is OFF by default because it installs own
//     properties on live scene objects, which is a bigger footprint than the
//     rest of this file and collides with the two other samplers that use the
//     same slot (see the INTERACTION note above).
//   * `objHookMs` is ALSO null when the adopt scan did not run on every
//     accounted call (`health.adoptScans !== calls` — a detached render list
//     orphans it). A hook total over a subset of calls is not comparable with a
//     per-call mean and must not be subtracted from one.
//   * `preSubmitMs` / `drawLoopMs` / `postDrawMs` / `glueSpanMs` are null on any
//     call with no scene-phase draw at all, because their boundaries ARE the
//     first and last draw. A frame that drew nothing is not a frame whose glue
//     cost zero.
//   * `glueSampleUs` is null unless armed with `{glueSample:k}`.
//   * `booksClosed` is false, loudly, when the buckets do not re-add to the
//     measured total within tolerance. `sceneSubmitBooksClosed` is the same
//     check one level down: preSubmit + drawLoop + postDraw must re-add to
//     `sceneSubmit`.
//
// Read-only. Never called by the app. Costs nothing until `armFrameSplit()`.
// ===========================================================================

// `Object3D` is imported for ONE reason: `Object3D.prototype.onBeforeRender` is
// the identity of the stock no-op, and the adopt pass needs to compare against
// it rather than against `typeof fn === "function"` (which every object passes).
// This resolves through the app's importmap, so it is the same class object the
// scene's nodes actually inherit from — a second copy of three would make the
// comparison silently false for every node and the probe would wrap all 470.
// `frameSplitCensus().hooks.identityCheckOk` reports whether that held.
import { BufferAttribute, BufferGeometry, Group, Mesh, MeshBasicMaterial, Object3D } from "three";

const _DEFAULT_ON_BEFORE_RENDER = Object3D.prototype.onBeforeRender;

const _now =
  typeof performance !== "undefined" && performance.now
    ? () => performance.now()
    : () => Date.now();

// Books-closed tolerance. The buckets are wall-clock windows measured with the
// same clock as the total, so they should re-add to within the instrument's own
// noise; 2% of the total (or 0.05 ms, whichever is larger, for tiny frames) is
// generous enough not to cry wolf on a 60 Hz timer and tight enough that a
// genuinely missing phase shows up.
const _BOOKS_TOL_FRAC = 0.02;
const _BOOKS_TOL_MS = 0.05;

// How many per-call samples to keep for percentiles and for an offline
// regression (the §5a method: regress a bucket against a population that varies
// naturally rather than building a synthetic scene). 900 calls is ~15 s at
// 60 fps and ~35 s at the 1070's measured 25 ms/frame.
const _RING = 900;

const S = {
  armed: false,
  renderer: null,
  scene: null,
  list: null,
  // Captured originals. Every one of these is an OWN property of its object
  // (`this.render = function` on the renderer, `this.render = function` on the
  // shadowMap, and a plain object literal for the render list), so restoring by
  // assignment restores the real function and cannot pin a stale prototype
  // method — the failure `static_atlas.js armStatMergeSubmittedSampler` warns
  // about does not apply here. `scene.onBeforeRender` is the one case that may
  // legitimately have NO own property, and that one is restored by `delete`.
  orig: null,
  sceneHookOwned: { before: false, after: false },
  phase: "idle",
  depth: 0,
  nowCostNs: null,
  ballast: null,
  ballastCount: 0,
  ballastVisible: true,
  drawBallast: null,
  drawBallastCount: 0,
  objHooks: false,
  // Every own `onBeforeRender` this probe installed, so disarm can hand each
  // object back exactly what it had — including "no own property at all", which
  // is restored by `delete`, not by assigning the prototype's no-op over it.
  // Rows are append-only and identity-checked at restore time: if the app has
  // since reassigned the slot (it does — `_installMemo` runs on bucket
  // creation), our row is stale and must be left alone rather than clobbering
  // the app's function with a captured one.
  adopted: null,
  glueSampleEvery: 0,
  glueSampleTargets: 0,
  glueMark: 0,
  glueMarkArmed: false,
  acc: null,
  ring: null,
  ringAt: 0,
  cur: null,
};

function _freshAcc() {
  return {
    calls: 0, // world-scene render() calls accounted
    otherCalls: 0, // render() calls for some OTHER scene (sky dome, HUD, …)
    otherMs: 0,
    listDetachedCalls: 0,
    noSortCalls: 0,
    shadowRasterCalls: 0, // calls where shadowMap.render did real work
    // Calls on which the adopt pass actually walked the render list. Must equal
    // `calls` for `objHookMs` to mean anything — see "silence is not success".
    adoptScans: 0,
    adoptScanMs: 0,
    adoptWrapped: 0, // wrappers installed, cumulative (steady state: 0/frame)
    adoptCapped: 0, // hooks the row cap refused to wrap — a non-zero here means
                    // objHookMs is a FLOOR, not the total

    adoptScanned: 0, // render-list entries examined, cumulative
    sums: {
      total: 0,
      preProject: 0,
      listSetup: 0,
      project: 0,
      listFinish: 0,
      postFinishPreSort: 0,
      sort: 0,
      postSortPreShadow: 0,
      shadow: 0,
      sceneSubmit: 0,
      tail: 0,
      rbdShadow: 0,
      rbdScene: 0,
      rbdOther: 0,
      objHook: 0,
      objHookPre: 0, // hooks that fired before the first scene draw
      // The sceneSubmit sub-split. Boundaries are the first scene-phase draw's
      // entry and the last one's exit — timestamps the rbd wrapper already
      // takes, so these three buckets cost ZERO extra clock reads.
      preSubmit: 0,
      drawLoop: 0,
      postDraw: 0,
      glueSample: 0, // sampled per-object glue, in ms; reported as µs
    },
    // Per-bucket sample counts. Every bucket carries one, because a seam that
    // never fired must divide by zero and report `null`, not divide by `calls`
    // and report a confident `0.00 ms`. That is the whole "silence is not
    // success" rule, mechanised.
    counts: {
      preProject: 0,
      listSetup: 0,
      project: 0,
      listFinish: 0,
      postFinishPreSort: 0,
      postSortPreShadow: 0,
      shadow: 0,
      sceneSubmit: 0,
      tail: 0,
      sort: 0,
      rbdShadow: 0,
      rbdScene: 0,
      rbdOther: 0,
      objHook: 0,
      objHookPre: 0,
      preSubmit: 0,
      drawLoop: 0,
      postDraw: 0,
      glueSample: 0,
      submitted: 0, // sum of render-list lengths, SUBMITTED scale
      submittedOpaque: 0,
      submittedTransmissive: 0,
      submittedTransparent: 0,
      shadowLights: 0,
    },
  };
}

function _freshCur() {
  return {
    t0: 0,
    tBefore: null,
    tInitEnd: null,
    tFinishStart: null,
    tFinishEnd: null,
    tSortStart: null,
    tSortEnd: null,
    tShadowStart: null,
    tShadowEnd: null,
    tAfter: null,
    sawInit: false,
    sawSort: false,
    shadowRastered: false,
    shadowLights: 0,
    rbdShadowMs: 0,
    rbdSceneMs: 0,
    rbdShadowN: 0,
    rbdSceneN: 0,
    // First scene-phase draw ENTRY and last scene-phase draw EXIT. These are
    // the sceneSubmit sub-split's boundaries and they are free: the rbd wrapper
    // already reads the clock on both sides of every draw.
    tFirstSceneRbd: null,
    tLastSceneRbdEnd: null,
    objHookMs: 0,
    objHookN: 0,
    // The part of the hook total that fired before the first scene draw, i.e.
    // outside `drawLoopMs`. Kept separate so `glueSpanMs` subtracts only the
    // hooks its own window actually contains.
    objHookPreMs: 0,
    objHookPreN: 0,
    glueSampleMs: 0,
    glueSampleN: 0,
    sawAdopt: false,
    opaque: 0,
    transmissive: 0,
    transparent: 0,
  };
}

/**
 * Cost of one `performance.now()` on THIS machine, in nanoseconds. Measured, so
 * `probeOverheadMs` is a number rather than a hope. Called once at arm time.
 */
function _measureNowCostNs() {
  const N = 20000;
  // Warm the JIT before the timed loop, or the first few thousand iterations
  // price the interpreter instead of the clock.
  for (let i = 0; i < 2000; i++) _now();
  const a = _now();
  let sink = 0;
  for (let i = 0; i < N; i++) sink += _now();
  const b = _now();
  // `sink` is consumed so the loop cannot be optimised away.
  return sink === Infinity ? 0 : ((b - a) * 1e6) / N;
}

// ---------------------------------------------------------------------------
// The object-hook adopt pass — SUBMITTED scale, read from three's own list
// ---------------------------------------------------------------------------

// Marker on every function this file installs into an `onBeforeRender` slot, so
// the scan recognises its own work in O(1) and never wraps a wrapper. Two
// wrappers deep on the same object would charge the inner one's time twice.
const _OB_MARK = "__frameSplitObHook";

// Ceiling on restore rows. Each app-side reassignment of a hook slot leaves one
// stale row behind, so an app that swaps every frame would grow this without
// bound. 8,192 is far above any plausible submitted population and small enough
// that the probe can never be the memory story.
const _ADOPT_ROW_CAP = 8192;

/** Wrap one object's `onBeforeRender` so its time lands in `cur.objHookMs`.
 *  `fn` is whatever the slot resolved to — an own property or an inherited
 *  prototype method; which it was is recorded, because the restore differs. */
function _wrapObjHook(o, fn) {
  const own = Object.prototype.hasOwnProperty.call(o, "onBeforeRender");
  const wrapper = function (...args) {
    const cur = S.cur;
    // "other" = a foreign scene's render nested in ours; "shadow" = the shadow
    // phase (three calls `onBeforeShadow` there, not `onBeforeRender`, so this
    // is belt-and-braces). Neither belongs in the world call's scene books.
    if (!cur || S.phase === "other" || S.phase === "shadow") {
      return fn.apply(this, args);
    }
    const a = _now();
    try {
      return fn.apply(this, args);
    } finally {
      const d = _now() - a;
      cur.objHookMs += d;
      cur.objHookN += 1;
      // THE WINDOW EDGE. `drawLoopMs` runs from the FIRST draw's entry, so the
      // first submitted object's hook fired BEFORE the window opened and is
      // already inside `preSubmitMs`. Subtracting the full hook total from
      // `drawLoopMs` would therefore double-charge it — visibly (glueSpan goes
      // negative) when hooks are few and expensive, invisibly when they are
      // many and cheap. One null check per hook keeps the two halves disjoint.
      if (cur.tFirstSceneRbd === null) {
        cur.objHookPreMs += d;
        cur.objHookPreN += 1;
      }
    }
  };
  wrapper[_OB_MARK] = true;
  o.onBeforeRender = wrapper;
  S.adopted.push({ o, fn, own, wrapper });
  S.acc.adoptWrapped += 1;
}

/** Install a timestamp-only hook on an object that carries the stock no-op, so
 *  the glue between `onBeforeRender` returning and `renderBufferDirect` being
 *  entered can be read for that object. Replacing an empty function with a
 *  one-timestamp function is semantically identical; the cost is one clock read
 *  per sampled object per call, and the rbd side reuses a timestamp it already
 *  takes, so a sample is ONE extra read, not two. */
function _wrapGlueSampler(o) {
  const sampler = function () {
    S.glueMark = _now();
    S.glueMarkArmed = true;
  };
  sampler[_OB_MARK] = true;
  sampler.__frameSplitGlueSampler = true;
  o.onBeforeRender = sampler;
  S.adopted.push({ o, fn: _DEFAULT_ON_BEFORE_RENDER, own: false, wrapper: sampler });
  S.glueSampleTargets += 1;
}

/**
 * Walk the live render list and adopt every non-default `onBeforeRender`.
 *
 * Runs once per accounted call, from inside the `list.finish` wrapper — the
 * first moment the list is complete and the last before three starts drawing
 * from it. The population is therefore SUBMITTED scale, taken from three's own
 * arrays after three's own frustum cull. It is never re-derived.
 *
 * Steady-state cost is a property read and one identity compare per submitted
 * object; the wrapper installs happen on the first call and then only when the
 * app swaps a hook (`_installMemo` does, on every new batch bucket). Measured
 * into `acc.adoptScanMs`, not assumed.
 */
function _adoptListHooks(list) {
  const t0 = _now();
  let scanned = 0;
  const arrays = [list.opaque, list.transmissive, list.transparent];
  for (let ai = 0; ai < arrays.length; ai++) {
    const arr = arrays[ai];
    if (!arr) continue;
    for (let i = 0; i < arr.length; i++) {
      const item = arr[i];
      const o = item && item.object;
      if (!o) continue;
      scanned += 1;
      const fn = o.onBeforeRender;
      if (fn === _DEFAULT_ON_BEFORE_RENDER) {
        // The stock no-op. Not worth a wrapper — its dispatch is ~2 ns and
        // lives inside `glueSpanMs` where it belongs. It is, however, the only
        // population safe to borrow for a glue sample.
        if (S.glueSampleEvery > 0 && S.glueSampleTargets < S.glueSampleEvery) {
          _wrapGlueSampler(o);
        }
        continue;
      }
      if (typeof fn !== "function") continue;
      if (fn[_OB_MARK] === true) continue; // already ours
      // Hard cap. Every swap the app makes leaves one stale restore row behind,
      // and an app that reassigns hooks every frame would grow this without
      // bound. Refusing to wrap past the cap keeps the probe's own footprint
      // finite; `acc.adoptCapped` makes the refusal visible instead of turning
      // it into a quietly incomplete hook total. (`objHookMs` is NOT nulled on
      // this — the scan still ran on every call — but a non-zero `adoptCapped`
      // means the total is a floor, and the report says so.)
      if (S.adopted.length >= _ADOPT_ROW_CAP) {
        S.acc.adoptCapped += 1;
        continue;
      }
      _wrapObjHook(o, fn);
    }
  }
  S.acc.adoptScanned += scanned;
  S.acc.adoptScans += 1;
  S.acc.adoptScanMs += _now() - t0;
  if (S.cur) S.cur.sawAdopt = true;
}

/** Give every adopted slot back. Identity-checked: if the app has reassigned
 *  the slot since we wrapped it, the row is stale and touching it would
 *  overwrite the app's live function with a captured one. */
function _releaseObjHooks() {
  const rows = S.adopted || [];
  let restored = 0;
  let stale = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (r.o.onBeforeRender !== r.wrapper) {
      stale += 1;
      continue;
    }
    if (r.own) r.o.onBeforeRender = r.fn;
    else delete r.o.onBeforeRender;
    restored += 1;
  }
  S.adopted = null;
  // `glueSampleTargets` is NOT cleared here. It is a fact about the run that
  // just happened, and the report is read AFTER disarm by design; zeroing it
  // would make the sampler's own population read 0 in every honest workflow.
  // `armFrameSplit` resets it, which is the right place.
  S.glueMarkArmed = false;
  return { restored, stale };
}

// ---------------------------------------------------------------------------
// Arm / disarm
// ---------------------------------------------------------------------------

/**
 * Wrap the seams and start accumulating.
 *
 * @param {object}  [opts]
 * @param {object}  [opts.renderer] defaults to `window.liveScene3d.renderer`
 * @param {object}  [opts.scene]    defaults to `window.liveScene3d.scene`
 * @param {boolean} [opts.rbd=true] wrap `renderBufferDirect`. Required to split
 *   the shadow phase into traversal-vs-draws and to close the books; turning it
 *   off makes `shadowTraversalMs` and `sceneSubmitMinusDrawsMs` read null.
 * @param {boolean} [opts.objHooks=false] time `object.onBeforeRender` by
 *   ADOPTING every non-default hook off the live render list once per call —
 *   not by wrapping `BatchedMesh.prototype`, which on this app misses the entire
 *   hot population (`static_batch_x.js` installs the memo hook as an OWN
 *   property; see the header tombstone). OFF by default because it installs own
 *   properties on live scene objects and collides with the two other samplers
 *   that use the same slot.
 * @param {number} [opts.glueSample=0] when > 0, borrow up to this many
 *   stock-no-op `onBeforeRender` slots off the submitted list and use them to
 *   time the per-object glue DIRECTLY (hook-exit → `renderBufferDirect` entry),
 *   as a cross-check on the span arithmetic. Requires `objHooks` (the adopt
 *   pass is where the borrowing happens) and `rbd`. 8 is plenty; each sample
 *   costs ONE extra clock read per call.
 * @returns {{armed:boolean}|{error:string}}
 */
export function armFrameSplit(opts = {}) {
  if (S.armed) return { error: "already armed — disarm first" };
  const live = typeof window !== "undefined" ? window.liveScene3d : null;
  const renderer = opts.renderer || live?.renderer || null;
  const scene = opts.scene || live?.scene || null;
  if (!renderer || typeof renderer.render !== "function") {
    return { error: "no renderer — pass one, or wait for window.liveScene3d" };
  }
  if (!scene) return { error: "no scene — pass one, or wait for window.liveScene3d" };

  // The render list three will use for this scene at render-call depth 0. `get`
  // creates it on first ask, and three then finds the same object in the
  // WeakMap, so patching it here is patching the live one — no race, no copy.
  let list = null;
  try {
    list = renderer.renderLists?.get ? renderer.renderLists.get(scene, 0) : null;
  } catch (_) {
    list = null;
  }
  if (!list || typeof list.init !== "function") {
    return { error: "renderer.renderLists.get(scene,0) gave no patchable list" };
  }

  const wantRbd = opts.rbd !== false;
  const shadowMap = renderer.shadowMap || null;

  S.renderer = renderer;
  S.scene = scene;
  S.list = list;
  S.acc = _freshAcc();
  S.ring = [];
  S.ringAt = 0;
  S.cur = null;
  S.phase = "idle";
  S.depth = 0;
  // The adopt pass needs `rbd` for the glue sampler's second boundary, and it
  // needs somewhere to put its rows. Both are decided here so the wrappers below
  // can branch on a plain boolean rather than re-deriving the option.
  S.objHooks = opts.objHooks === true;
  S.adopted = S.objHooks ? [] : null;
  S.glueSampleEvery =
    S.objHooks && wantRbd && opts.glueSample > 0 ? Math.min(64, opts.glueSample | 0) : 0;
  S.glueSampleTargets = 0;
  S.glueMarkArmed = false;
  S.orig = {
    render: renderer.render,
    rbd: wantRbd ? renderer.renderBufferDirect : null,
    shadowRender: shadowMap && typeof shadowMap.render === "function" ? shadowMap.render : null,
    listInit: list.init,
    listFinish: list.finish,
    listSort: list.sort,
    sceneBefore: Object.prototype.hasOwnProperty.call(scene, "onBeforeRender")
      ? scene.onBeforeRender
      : null,
    sceneAfter: Object.prototype.hasOwnProperty.call(scene, "onAfterRender")
      ? scene.onAfterRender
      : null,
  };
  S.sceneHookOwned.before = S.orig.sceneBefore !== null;
  S.sceneHookOwned.after = S.orig.sceneAfter !== null;

  // --- renderer.render -----------------------------------------------------
  renderer.render = function (sceneArg, cameraArg) {
    // Only depth-0 calls for OUR scene are accounted. The composer also renders
    // the sky-dome scene and (on some paths) the world twice, and folding those
    // into one mean is how a "per frame" number becomes uninterpretable.
    if (S.depth > 0 || sceneArg !== S.scene) {
      const oa = _now();
      S.depth += 1;
      const prevPhase = S.phase;
      // Always "other", including when NESTED inside an accounted world call —
      // otherwise a nested foreign render's draws would be charged to the world
      // call's scene bucket, which is the silent kind of wrong.
      S.phase = "other";
      try {
        return S.orig.render.call(this, sceneArg, cameraArg);
      } finally {
        S.depth -= 1;
        S.phase = prevPhase;
        if (S.depth === 0) {
          S.acc.otherCalls += 1;
          S.acc.otherMs += _now() - oa;
        }
      }
    }
    const cur = _freshCur();
    S.cur = cur;
    S.depth = 1;
    S.phase = "pre";
    // A glue mark left armed by an object whose draw never happened (a material
    // that threw, an XR early-out) must not be paired with the FIRST draw of the
    // next call — that would report a whole inter-frame gap as one object's glue.
    S.glueMarkArmed = false;
    cur.t0 = _now();
    try {
      return S.orig.render.call(this, sceneArg, cameraArg);
    } finally {
      const t9 = _now();
      S.depth = 0;
      S.phase = "idle";
      _closeCall(cur, t9);
      S.cur = null;
    }
  };

  // --- scene.onBeforeRender / onAfterRender --------------------------------
  // Called by `render()` at `if (scene.isScene === true) scene.onBeforeRender(…)`
  // — i.e. AFTER `scene.updateMatrixWorld()` and the camera matrix update, and
  // BEFORE `renderStates.get`. That makes it the exact end of the matrix phase.
  scene.onBeforeRender = function (...args) {
    if (S.cur && S.cur.tBefore === null) S.cur.tBefore = _now();
    if (S.orig.sceneBefore) return S.orig.sceneBefore.apply(this, args);
    return undefined;
  };
  scene.onAfterRender = function (...args) {
    if (S.cur && S.cur.tAfter === null) S.cur.tAfter = _now();
    if (S.orig.sceneAfter) return S.orig.sceneAfter.apply(this, args);
    return undefined;
  };

  // --- render list ---------------------------------------------------------
  list.init = function (...args) {
    const r = S.orig.listInit.apply(this, args);
    if (S.cur && !S.cur.sawInit) {
      S.cur.sawInit = true;
      S.cur.tInitEnd = _now();
    }
    return r;
  };
  list.finish = function (...args) {
    const a = _now();
    // The adopt pass runs HERE, inside the finish window, because this is the
    // first instant the render list is complete and the last before three draws
    // from it. Its cost is therefore inside `buckets.listFinish` — stated, and
    // separately measured as `health.adoptScanMs`, rather than hidden. Putting
    // it outside the window would open a hole the books would then fail to close
    // on, which is a worse lie than an inflated bucket that says so.
    if (S.objHooks && S.cur) _adoptListHooks(this);
    const r = S.orig.listFinish.apply(this, args);
    if (S.cur && S.cur.tFinishStart === null) {
      S.cur.tFinishStart = a;
      S.cur.tFinishEnd = _now();
    }
    return r;
  };
  list.sort = function (...args) {
    // Lengths are read BEFORE the sort, which is free (the sort does not change
    // them) and gives the SUBMITTED-scale population that three itself produced.
    if (S.cur && S.cur.tSortStart === null) {
      S.cur.opaque = this.opaque ? this.opaque.length : 0;
      S.cur.transmissive = this.transmissive ? this.transmissive.length : 0;
      S.cur.transparent = this.transparent ? this.transparent.length : 0;
    }
    const a = _now();
    const r = S.orig.listSort.apply(this, args);
    if (S.cur && S.cur.tSortStart === null) {
      S.cur.sawSort = true;
      S.cur.tSortStart = a;
      S.cur.tSortEnd = _now();
    }
    return r;
  };

  // --- shadowMap.render ----------------------------------------------------
  if (S.orig.shadowRender) {
    shadowMap.render = function (lights, sceneArg, cameraArg) {
      if (!S.cur) return S.orig.shadowRender.call(this, lights, sceneArg, cameraArg);
      // Will this call do real work, or hit one of three's three early returns?
      // Evaluated from the SAME inputs three reads on the next three lines of
      // `WebGLShadowMap.render` — not a model of the cost, a read of the gate.
      // This matters more than any bucket here: `lighting.js` RP5 sets
      // `autoUpdate = false` and re-arms `needsUpdate` only on shadow-relevant
      // change, so the identical traversal is 3x or 0x frame to frame.
      const willRaster =
        this.enabled === true &&
        (this.autoUpdate === true || this.needsUpdate === true) &&
        !!lights &&
        lights.length > 0;
      S.cur.shadowRastered = willRaster;
      S.cur.shadowLights = lights ? lights.length : 0;
      S.cur.tShadowStart = _now();
      S.phase = "shadow";
      try {
        return S.orig.shadowRender.call(this, lights, sceneArg, cameraArg);
      } finally {
        S.phase = "scene";
        S.cur.tShadowEnd = _now();
      }
    };
  }

  // --- renderBufferDirect --------------------------------------------------
  if (wantRbd && typeof renderer.renderBufferDirect === "function") {
    renderer.renderBufferDirect = function (...args) {
      const cur = S.cur;
      if (!cur || S.phase === "other") {
        // A draw outside an accounted render call — the sky-dome scene, the
        // HUD, a shader warm-up, or a foreign render nested inside ours.
        // Counted separately so it is never silently folded into the world
        // call's draw funnel.
        const a = _now();
        try {
          return S.orig.rbd.apply(this, args);
        } finally {
          S.acc.sums.rbdOther += _now() - a;
          S.acc.counts.rbdOther += 1;
        }
      }
      const a = _now();
      const isShadow = S.phase === "shadow";
      if (!isShadow) {
        // FREE BOUNDARIES. `a` and the exit stamp below are read for the draw
        // funnel anyway; remembering the first entry and the last exit costs two
        // stores per draw and gives the whole sceneSubmit sub-split.
        if (cur.tFirstSceneRbd === null) cur.tFirstSceneRbd = a;
        // One boolean test per draw (~1 ns × ~470) closes a glue sample: the
        // window from the sampled object's hook returning to this draw starting
        // is exactly `modelViewMatrix.multiplyMatrices` + `normalMatrix
        // .getNormalMatrix` + `material.onBeforeRender` + the DoubleSide branch.
        if (S.glueMarkArmed) {
          S.glueMarkArmed = false;
          cur.glueSampleMs += a - S.glueMark;
          cur.glueSampleN += 1;
        }
      }
      try {
        return S.orig.rbd.apply(this, args);
      } finally {
        const t = _now();
        const d = t - a;
        if (isShadow) {
          cur.rbdShadowMs += d;
          cur.rbdShadowN += 1;
        } else {
          cur.rbdSceneMs += d;
          cur.rbdSceneN += 1;
          cur.tLastSceneRbdEnd = t;
        }
      }
    };
  }

  // --- optional: object onBeforeRender, adopted from the render list --------
  // Nothing to install here. The adopt pass runs inside the `list.finish`
  // wrapper above, once per accounted call, against the SUBMITTED population.
  // There is deliberately no prototype patching: see the header tombstone on
  // why `BatchedMesh.prototype` was the wrong seam on this app.

  S.nowCostNs = _measureNowCostNs();
  S.armed = true;
  return {
    armed: true,
    rbdWrapped: wantRbd,
    shadowWrapped: !!S.orig.shadowRender,
    objHooksWrapped: S.objHooks,
    objHookMethod: S.objHooks ? "adopt-from-render-list (submitted scale)" : null,
    glueSampleTargets: S.glueSampleEvery,
    nowCostNs: S.nowCostNs,
  };
}

/** Restore every seam. Accumulators are LEFT IN PLACE so a report can be read
 *  after disarming — which is the order a measurement wants: disarm, then quote
 *  (the wrappers themselves cost time, so a frame number read while armed is a
 *  frame number that includes the instrument). */
export function disarmFrameSplit() {
  if (!S.armed) return { error: "not armed" };
  const { renderer, scene, list, orig } = S;
  renderer.render = orig.render;
  if (orig.rbd) renderer.renderBufferDirect = orig.rbd;
  if (orig.shadowRender && renderer.shadowMap) renderer.shadowMap.render = orig.shadowRender;
  list.init = orig.listInit;
  list.finish = orig.listFinish;
  list.sort = orig.listSort;
  // The scene hooks are the one case where the pre-existing value may have been
  // "no own property at all" (the no-op lives on Object3D.prototype). Restoring
  // by assignment there would leave a permanent own property shadowing the
  // prototype; delete restores the real shape.
  if (S.sceneHookOwned.before) scene.onBeforeRender = orig.sceneBefore;
  else delete scene.onBeforeRender;
  if (S.sceneHookOwned.after) scene.onAfterRender = orig.sceneAfter;
  else delete scene.onAfterRender;
  // Adopted object hooks. `objHooks` stays TRUE after disarm so the report can
  // still say the hook total was measured rather than absent — the accumulators
  // outlive the wrappers on purpose (see the doc comment above).
  const released = S.objHooks ? _releaseObjHooks() : null;
  S.armed = false;
  S.phase = "idle";
  S.depth = 0;
  S.cur = null;
  return released ? { disarmed: true, objHooksReleased: released } : { disarmed: true };
}

/** Zero the accumulators without disarming — the A/B seam. Arm once, measure,
 *  reset, change ONE thing (ballast in, a flag toggled), measure again. Two
 *  arms inside one session is the method `docs/2026-08-06-frame-cost-structure-
 *  measured.md` §7 insists on: two control runs ten minutes apart have differed
 *  40% in bucket count on this workload. */
export function resetFrameSplit() {
  if (!S.acc) return { error: "never armed" };
  S.acc = _freshAcc();
  S.ring = [];
  S.ringAt = 0;
  return { reset: true };
}

// ---------------------------------------------------------------------------
// Per-call bookkeeping
// ---------------------------------------------------------------------------

function _closeCall(cur, t9) {
  const acc = S.acc;
  acc.calls += 1;
  const total = t9 - cur.t0;
  const s = acc.sums;
  const c = acc.counts;
  s.total += total;

  // updateMatrixWorld + camera matrices + output.begin, ending at
  // scene.onBeforeRender. Null if the hook never fired (a non-Scene root).
  const preProject = cur.tBefore !== null ? cur.tBefore - cur.t0 : null;
  if (preProject !== null) {
    s.preProject += preProject;
    c.preProject += 1;
  }

  // renderStates.get/init + frustum + clipping.init + renderLists.get.
  const listSetup =
    cur.tBefore !== null && cur.tInitEnd !== null ? cur.tInitEnd - cur.tBefore : null;
  if (listSetup !== null) {
    s.listSetup += listSetup;
    c.listSetup += 1;
  }

  // THE traversal. init-exit → finish-entry, with nothing between them but
  // projectObject.
  let project = null;
  if (cur.sawInit && cur.tFinishStart !== null) {
    project = cur.tFinishStart - cur.tInitEnd;
    s.project += project;
    c.project += 1;
  } else {
    acc.listDetachedCalls += 1;
  }

  const listFinish =
    cur.tFinishEnd !== null && cur.tFinishStart !== null ? cur.tFinishEnd - cur.tFinishStart : null;
  if (listFinish !== null) {
    s.listFinish += listFinish;
    c.listFinish += 1;
  }

  let sort = null;
  if (cur.sawSort) {
    sort = cur.tSortEnd - cur.tSortStart;
    s.sort += sort;
    c.sort += 1;
    if (cur.tFinishEnd !== null) {
      s.postFinishPreSort += cur.tSortStart - cur.tFinishEnd;
      c.postFinishPreSort += 1;
    }
  } else {
    // `renderer.sortObjects === false` — three does not call sort at all. That
    // is a real configuration (and a measurement arm), not a zero.
    acc.noSortCalls += 1;
  }

  // The last timestamp before the shadow phase. `sort` is skipped entirely when
  // `renderer.sortObjects === false`, so fall back down the chain rather than
  // leaving a hole.
  const preShadowEnd = cur.sawSort ? cur.tSortEnd : cur.tFinishEnd;

  const shadow =
    cur.tShadowStart !== null && cur.tShadowEnd !== null
      ? cur.tShadowEnd - cur.tShadowStart
      : null;
  if (shadow !== null) {
    s.shadow += shadow;
    c.shadow += 1;
    if (cur.shadowRastered) acc.shadowRasterCalls += 1;
    c.shadowLights += cur.shadowLights;
    if (preShadowEnd !== null) {
      s.postSortPreShadow += cur.tShadowStart - preShadowEnd;
      c.postSortPreShadow += 1;
    }
  }

  // Everything from the end of the shadow phase to scene.onAfterRender:
  // setupLights, the transmission pass, background.render, and the three
  // renderObjects loops (per-draw glue + object hooks + renderBufferDirect).
  // With no shadowMap seam (a renderer that exposes none) the window opens at
  // the last timestamp we do have, and `shadow` reads null rather than 0 — the
  // phase was not measured, it was not absent.
  const sceneStart = cur.tShadowEnd !== null ? cur.tShadowEnd : preShadowEnd;
  const sceneSubmit =
    sceneStart !== null && cur.tAfter !== null ? cur.tAfter - sceneStart : null;
  if (sceneSubmit !== null) {
    s.sceneSubmit += sceneSubmit;
    c.sceneSubmit += 1;
  }

  const tail = cur.tAfter !== null ? t9 - cur.tAfter : null;
  if (tail !== null) {
    s.tail += tail;
    c.tail += 1;
  }

  // --- the sceneSubmit sub-split -------------------------------------------
  // Boundaries: the first scene-phase draw's ENTRY and the last one's EXIT.
  // Both are timestamps the rbd wrapper already took, so these three buckets
  // are free. All three are null together on a call that drew nothing in the
  // scene phase — a frame that drew nothing is not a frame whose glue was 0.
  let preSubmit = null;
  let drawLoop = null;
  let postDraw = null;
  if (cur.tFirstSceneRbd !== null && cur.tLastSceneRbdEnd !== null) {
    if (sceneStart !== null) {
      preSubmit = cur.tFirstSceneRbd - sceneStart;
      s.preSubmit += preSubmit;
      c.preSubmit += 1;
    }
    drawLoop = cur.tLastSceneRbdEnd - cur.tFirstSceneRbd;
    s.drawLoop += drawLoop;
    c.drawLoop += 1;
    if (cur.tAfter !== null) {
      postDraw = cur.tAfter - cur.tLastSceneRbdEnd;
      s.postDraw += postDraw;
      c.postDraw += 1;
    }
  }

  s.rbdShadow += cur.rbdShadowMs;
  s.rbdScene += cur.rbdSceneMs;
  c.rbdShadow += cur.rbdShadowN;
  c.rbdScene += cur.rbdSceneN;
  s.objHook += cur.objHookMs;
  c.objHook += cur.objHookN;
  s.objHookPre += cur.objHookPreMs;
  c.objHookPre += cur.objHookPreN;
  s.glueSample += cur.glueSampleMs;
  c.glueSample += cur.glueSampleN;

  c.submittedOpaque += cur.opaque;
  c.submittedTransmissive += cur.transmissive;
  c.submittedTransparent += cur.transparent;
  c.submitted += cur.opaque + cur.transmissive + cur.transparent;

  // Ring for percentiles and for regressing a bucket against a naturally
  // varying population (the §5a method).
  const row = {
    total,
    preProject,
    project,
    sort,
    shadow,
    sceneSubmit,
    preSubmit,
    drawLoop,
    postDraw,
    // drawLoop minus the draws minus the object hooks: the per-submitted-object
    // glue for THIS call. Kept per-call so it can be regressed against
    // `submitted`, which varies naturally as the camera moves — the §5a method,
    // and the only way to tell a per-object cost from a per-frame one without
    // building a synthetic scene.
    glueSpan:
      drawLoop === null ? null : drawLoop - cur.rbdSceneMs - (S.objHooks ? cur.objHookMs : 0),
    rbdScene: cur.rbdSceneMs,
    rbdShadow: cur.rbdShadowMs,
    drawsScene: cur.rbdSceneN,
    drawsShadow: cur.rbdShadowN,
    objHook: S.objHooks ? cur.objHookMs : null,
    submitted: cur.opaque + cur.transmissive + cur.transparent,
    shadowRastered: cur.shadowRastered,
  };
  if (S.ring.length < _RING) S.ring.push(row);
  else {
    S.ring[S.ringAt] = row;
    S.ringAt = (S.ringAt + 1) % _RING;
  }
}

function _p50(vals) {
  const v = vals.filter((x) => typeof x === "number" && isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  return v[(v.length / 2) | 0];
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

/**
 * The split. Every ms figure is PER ACCOUNTED `renderer.render(worldScene, …)`
 * CALL — the same unit as the 24.22 ms the split is being reconciled against.
 * `callsPerDisplayedFrame` is not knowable from inside this probe (the display
 * cadence is the loop's business), so if the app submits the world twice per
 * frame — the `?indoorDepthSplit` path does — the caller must halve accordingly
 * and `calls` is reported so that is visible rather than assumed.
 */
export function frameSplitReport() {
  if (!S.acc) return { error: "never armed" };
  const acc = S.acc;
  const n = acc.calls;
  if (n === 0) {
    return {
      error: "no accounted render calls — is window.liveScene3d.scene the scene being rendered?",
      otherCalls: acc.otherCalls,
    };
  }
  const s = acc.sums;
  const c = acc.counts;
  const per = (x) => x / n;
  const perOr = (x, k) => (k > 0 ? x / k : null);

  const rbdWrapped = S.orig?.rbd != null;
  const rbdShadow = rbdWrapped ? per(s.rbdShadow) : null;
  const rbdScene = rbdWrapped ? per(s.rbdScene) : null;

  const shadowMs = perOr(s.shadow, c.shadow);
  // The shadow window contains real draws. Subtracting them leaves the walk +
  // per-caster getDepthMaterial + the render-target/viewport churn — which is
  // the part nobody has attributed. Null when rbd was not wrapped, because the
  // subtraction is then unavailable and a bare `shadow` would be read as
  // traversal.
  const shadowTraversal =
    rbdShadow === null || shadowMs === null ? null : shadowMs - rbdShadow;

  const sceneSubmitMs = perOr(s.sceneSubmit, c.sceneSubmit);
  // = object onBeforeRender + per-draw glue (modelViewMatrix, normalMatrix,
  // layers.test, material.onBeforeRender) + setupLights/setupLightsView +
  // background.render + the transmission pass.
  const sceneMinusDraws =
    rbdScene === null || sceneSubmitMs === null ? null : sceneSubmitMs - rbdScene;
  // The hook total is only comparable with a per-call mean if the adopt pass ran
  // on EVERY accounted call. A detached render list (context loss) orphans it,
  // and a hook sum over 400 of 549 calls divided by 549 is a number that looks
  // right and is 27% low. Same denominator discipline as `allBucketsFullySampled`.
  const objHooksFullySampled = S.objHooks && acc.adoptScans === n;
  const objHookMs = objHooksFullySampled ? per(s.objHook) : null;
  const glueAndLights =
    sceneMinusDraws === null || objHookMs === null ? null : sceneMinusDraws - objHookMs;

  // --- the sceneSubmit sub-split -------------------------------------------
  const preSubmitMs = perOr(s.preSubmit, c.preSubmit);
  const drawLoopMs = perOr(s.drawLoop, c.drawLoop);
  const postDrawMs = perOr(s.postDraw, c.postDraw);
  // THE per-submitted-object glue: the whole renderObject loop, minus the draws
  // it contains, minus the object hooks it dispatches. What is left is
  // `layers.test` + `modelViewMatrix.multiplyMatrices` + `normalMatrix
  // .getNormalMatrix` + `material.onBeforeRender` + `object.onAfterRender` +
  // the loop itself, and the stock-no-op `onBeforeRender` dispatches (~2 ns
  // each, bounded by `submitted × 2 ns` ≈ 0.001 ms — deliberately NOT wrapped,
  // because wrapping 470 of them would cost more than they do).
  //
  // Only the hooks the WINDOW CONTAINS are subtracted. The first submitted
  // object's hook fires before the first draw, so it is in `preSubmitMs`;
  // subtracting the full hook total here would charge it twice and can drive
  // `glueSpanMs` negative outright.
  const objHookInLoopMs = objHookMs === null ? null : per(s.objHook - s.objHookPre);
  const glueSpanMs =
    drawLoopMs === null || rbdScene === null || objHookInLoopMs === null
      ? null
      : drawLoopMs - rbdScene - objHookInLoopMs;
  const submittedPerCall = c.submitted / n;
  // Books one level down. The three sub-buckets are disjoint wall-clock windows
  // that tile `sceneSubmit` exactly, so they must re-add to it. They are sampled
  // on their own counts (a call with no scene draw contributes to none of them),
  // so this also requires the counts to agree with `sceneSubmit`'s.
  const subSampled =
    c.preSubmit === c.sceneSubmit && c.drawLoop === c.sceneSubmit && c.postDraw === c.sceneSubmit;
  const subSum =
    preSubmitMs === null || drawLoopMs === null || postDrawMs === null
      ? null
      : preSubmitMs + drawLoopMs + postDrawMs;
  const subResidual = subSum === null || sceneSubmitMs === null ? null : sceneSubmitMs - subSum;
  const sceneSubmitBooksClosed =
    subResidual !== null &&
    subSampled &&
    Math.abs(subResidual) <= Math.max(_BOOKS_TOL_MS, (sceneSubmitMs || 0) * _BOOKS_TOL_FRAC);

  const buckets = {
    preProject: perOr(s.preProject, c.preProject),
    listSetup: perOr(s.listSetup, c.listSetup),
    project: perOr(s.project, c.project),
    listFinish: perOr(s.listFinish, c.listFinish),
    postFinishPreSort: perOr(s.postFinishPreSort, c.postFinishPreSort),
    sort: perOr(s.sort, c.sort),
    postSortPreShadow: perOr(s.postSortPreShadow, c.postSortPreShadow),
    shadow: shadowMs,
    sceneSubmit: sceneSubmitMs,
    tail: perOr(s.tail, c.tail),
  };

  // Do the buckets re-add to the measured total? They are disjoint wall-clock
  // windows over the same call, so they must. When they do not, a phase is
  // missing (a seam that never fired) and every share below is wrong — so this
  // is reported as a boolean, not buried in a residual nobody reads.
  //
  // The residual ALONE is not enough, and the way it fails is subtle enough to
  // have been caught only by the regression suite: each bucket is a mean over
  // ITS OWN sample count, so if a phase went unmeasured on 2 of 3 calls its
  // mean is still the right size and the residual still lands near zero. A
  // partially-measured phase would then be certified closed. So the books also
  // require every bucket to have been sampled on EVERY accounted call —
  // mismatched denominators are not comparable and must not be added.
  const bucketSamples = {
    preProject: c.preProject,
    listSetup: c.listSetup,
    project: c.project,
    listFinish: c.listFinish,
    postFinishPreSort: c.postFinishPreSort,
    sort: c.sort,
    postSortPreShadow: c.postSortPreShadow,
    shadow: c.shadow,
    sceneSubmit: c.sceneSubmit,
    tail: c.tail,
  };
  let summed = 0;
  let anyNull = false;
  let allSampled = true;
  for (const k of Object.keys(buckets)) {
    if (buckets[k] === null) anyNull = true;
    else summed += buckets[k];
    if (bucketSamples[k] !== n) allSampled = false;
  }
  const total = per(s.total);
  const residual = total - summed;
  const tol = Math.max(_BOOKS_TOL_MS, total * _BOOKS_TOL_FRAC);
  const booksClosed = !anyNull && allSampled && Math.abs(residual) <= tol;

  // THE HEADLINE. The remainder is defined by the prior measurement as
  // render() minus the draw funnel minus the object hooks. Reproduce that
  // definition here so the two instruments are directly comparable, and split
  // it into the phases above.
  const rbdTotal = rbdWrapped ? per(s.rbdShadow + s.rbdScene) : null;
  const remainder =
    rbdTotal === null ? null : total - rbdTotal - (objHookMs === null ? 0 : objHookMs);

  const ring = S.ring;
  return {
    unit: "ms per accounted renderer.render(worldScene, …) call",
    armed: S.armed,
    calls: n,
    otherSceneCalls: acc.otherCalls,
    otherSceneMs: acc.otherCalls ? acc.otherMs / acc.otherCalls : null,

    total,
    totalP50: _p50(ring.map((r) => r.total)),

    // The three-way split the prior measurement produced, reproduced.
    drawFunnelMs: rbdTotal,
    objHookMs, // null unless armed with {objHooks:true} — see the header
    remainderMs: remainder,
    remainderIncludesObjHooks: objHookMs === null,

    buckets,
    bucketsP50: {
      preProject: _p50(ring.map((r) => r.preProject)),
      project: _p50(ring.map((r) => r.project)),
      sort: _p50(ring.map((r) => r.sort)),
      shadow: _p50(ring.map((r) => r.shadow)),
      sceneSubmit: _p50(ring.map((r) => r.sceneSubmit)),
      preSubmit: _p50(ring.map((r) => r.preSubmit)),
      drawLoop: _p50(ring.map((r) => r.drawLoop)),
      postDraw: _p50(ring.map((r) => r.postDraw)),
      glueSpan: S.objHooks ? _p50(ring.map((r) => r.glueSpan)) : null,
    },

    // The shadow phase, split. `dutyCycle` is the number that decides whether
    // the shadow bucket means anything at all: the RP5 gate (`lighting.js`)
    // makes the identical traversal cost 3x or 0x depending on whether a
    // dynamic caster moved this frame.
    shadowSplit: {
      dutyCycle: acc.shadowRasterCalls / n,
      rasterCalls: acc.shadowRasterCalls,
      cascades: c.shadowLights / n,
      drawsPerCall: rbdWrapped ? c.rbdShadow / n : null,
      drawMs: rbdShadow,
      traversalMs: shadowTraversal,
      // Per RASTERING call, which is the honest denominator for "what does one
      // shadow raster cost". Quoting the all-calls mean understates it by
      // exactly 1/dutyCycle.
      traversalMsPerRaster:
        shadowTraversal === null || acc.shadowRasterCalls === 0
          ? null
          : (s.shadow - s.rbdShadow) / acc.shadowRasterCalls,
    },

    sceneSplit: {
      drawsPerCall: rbdWrapped ? c.rbdScene / n : null,
      drawMs: rbdScene,
      minusDrawsMs: sceneMinusDraws,
      objHookMs,
      glueAndLightsMs: glueAndLights,

      // The sub-split. `glueAndLightsMs` is ONE number covering two populations
      // — once-per-call lights/background/resolve work and per-submitted-object
      // glue. These three tile `sceneSubmit` and separate them. Boundaries are
      // the first scene draw's entry and the last one's exit, so they cost no
      // extra timestamps and they are null (never 0) on a call that drew
      // nothing in the scene phase.
      split: {
        // setupLights + setupLightsView + background.render + clipping.endShadows
        // + info.reset. ONCE PER CALL — this is `setupLights`'s home, and if it
        // is the suspect this number is large and does NOT track `submitted`.
        preSubmitMs,
        // Every renderObject, start to finish: hooks + glue + the draws.
        drawLoopMs,
        // Multisample resolve + render-target mipmap + output.end. ONCE PER CALL.
        postDrawMs,
        // drawLoop − draws − hooks. THE per-object glue.
        glueSpanMs,
        // Of the hook total, the part inside `drawLoopMs`. The remainder fired
        // before the first draw and is inside `preSubmitMs`.
        objHookInLoopMs,
        // Per SUBMITTED object — the conservative reading, and the one to quote
        // for "what would deleting an object save". It is a slight UNDER-count:
        // the window spans N draws but only N−1 inter-draw gaps, so the first
        // object's glue is in `preSubmitMs`. At 470 submitted that bias is 0.2%;
        // at 8 it is 12.5%, which is why the per-gap figure sits next to it and
        // why the glue sampler is the tie-breaker.
        glueSpanPerSubmittedUs:
          glueSpanMs === null || submittedPerCall <= 0 ? null : (glueSpanMs * 1000) / submittedPerCall,
        // Per INTER-DRAW GAP — the unbiased per-object cost, and the figure the
        // glue sampler should agree with.
        glueSpanPerGapUs:
          glueSpanMs === null || submittedPerCall <= 1
            ? null
            : (glueSpanMs * 1000) / (submittedPerCall - 1),
        // Direct measurement of the same quantity, from `{glueSample:k}`:
        // hook-exit → renderBufferDirect-entry on k borrowed objects. It covers
        // a strict SUBSET of a gap (no layers.test, no onAfterRender, no loop
        // overhead), so `glueSampleUs <= glueSpanPerGapUs` is the expected
        // relation and a violation means one of the two is wrong.
        glueSampleUs: c.glueSample > 0 ? (s.glueSample * 1000) / c.glueSample : null,
        glueSamplesPerCall: S.glueSampleEvery > 0 ? c.glueSample / n : null,
        glueSampleObjects: S.glueSampleEvery > 0 ? S.glueSampleTargets : null,
        // Hooks that actually did something. If this is 0 while `objHookMs` is
        // non-null, the app genuinely has no non-default hook in the submitted
        // population — a MEASURED zero, and visibly so, which is not the same
        // thing as an unmeasured one.
        hookedPerCall: objHooksFullySampled ? c.objHook / n : null,
        objHookPerHookedUs:
          objHooksFullySampled && c.objHook > 0 ? (s.objHook * 1000) / c.objHook : null,
        // `renderTransmissionPass` draws BEFORE `background.render`, so a
        // non-zero count here means `preSubmitMs` closes at the transmission
        // pass's first draw and the rest of that pass is inside `drawLoopMs`.
        transmissivePerCall: c.submittedTransmissive / n,
        booksClosed: sceneSubmitBooksClosed,
        residualMs: subResidual,
      },
    },

    // SUBMITTED scale — three's own render-list lengths after its own cull.
    // Never re-derived here. See the header's scale note.
    submitted: {
      scale: "submitted (render-list length after three's frustum cull)",
      perCall: c.submitted / n,
      opaque: c.submittedOpaque / n,
      transmissive: c.submittedTransmissive / n,
      transparent: c.submittedTransparent / n,
    },

    ballast: {
      nodes: S.ballastCount,
      visible: S.ballastVisible,
      // The SUBMITTED-scale ballast. Non-zero means `submitted`, `project`,
      // `sort` and `drawLoop` all contain injected population — every one of
      // those numbers is an ARM, not a baseline.
      drawNodes: S.drawBallastCount,
    },

    health: {
      booksClosed,
      residualMs: residual,
      toleranceMs: tol,
      // How many of the `calls` each bucket was actually sampled on. Anything
      // below `calls` means that bucket's mean is over a different population
      // than the total and cannot be added to it.
      bucketSamples,
      allBucketsFullySampled: allSampled,
      // Non-zero means the render list was swapped out from under the patch
      // (a `renderLists.dispose()`, e.g. WebGL context loss). Those calls
      // contribute no `project` sample rather than a zero one.
      listDetachedCalls: acc.listDetachedCalls,
      // Non-zero means `renderer.sortObjects === false` for those calls.
      noSortCalls: acc.noSortCalls,
      rbdWrapped,
      // Draws that happened OUTSIDE an accounted world render call — the sky
      // dome, the HUD, shader warm-up. Totals, not per-call: they do not belong
      // to this call's books and are reported only so they are not invisible.
      rbdOtherDraws: c.rbdOther,
      rbdOtherTotalMs: s.rbdOther,
      nowCostNs: S.nowCostNs,
      // What this instrument costs the frame it is measuring. Two clock reads
      // per draw, fourteen per call, plus — only when `{objHooks:true}` — two
      // per adopted hook per call and one per glue sample. The sceneSubmit
      // sub-split adds ZERO: its boundaries are timestamps the draw wrapper
      // already takes. Reported so nobody has to trust that it is small.
      //
      // The adopt SCAN is not a clock cost (it is ~470 property reads), so it
      // is measured directly and added rather than modelled from `nowCostNs`.
      probeClockReadsPerCall:
        (2 * (c.rbdShadow + c.rbdScene)) / n +
        14 +
        (S.objHooks ? 2 + (2 * c.objHook) / n + c.glueSample / n : 0),
      probeOverheadMs:
        S.nowCostNs === null
          ? null
          : ((2 * (c.rbdShadow + c.rbdScene)) / n +
              14 +
              (S.objHooks ? 2 + (2 * c.objHook) / n + c.glueSample / n : 0)) *
              (S.nowCostNs / 1e6) +
            (S.objHooks ? acc.adoptScanMs / n : 0),

      // The object-hook adopt pass, priced and disclosed. `adoptScanMs` is
      // INSIDE `buckets.listFinish` — that bucket is inflated by exactly this
      // much while objHooks is armed, which is why it is reported next to it
      // rather than netted out silently.
      objHooks: S.objHooks
        ? {
            method: "adopt from render list (SUBMITTED scale)",
            scans: acc.adoptScans,
            fullySampled: objHooksFullySampled,
            scanMs: acc.adoptScanMs / n,
            scannedPerCall: acc.adoptScanned / n,
            // Cumulative wrapper installs. In steady state this stops growing;
            // continued growth means the app is swapping hooks every frame
            // (`_installMemo` on new buckets) and the scan is doing real work.
            wrappersInstalled: acc.adoptWrapped,
            liveRows: S.adopted ? S.adopted.length : 0,
            // Non-zero ⇒ the row cap was hit and `objHookMs` is a LOWER BOUND.
            refusedByRowCap: acc.adoptCapped,
            note: "prototype patching deliberately not used — static_batch_x.js installs its memo hook as an OWN property and a prototype wrapper would never see it",
          }
        : null,
    },
  };
}

/** Raw per-call rows, for an offline regression (bucket vs submitted count,
 *  bucket vs draw count). Returned newest-last in insertion order. */
export function frameSplitSamples() {
  if (!S.ring) return [];
  if (S.ring.length < _RING) return S.ring.slice();
  return S.ring.slice(S.ringAt).concat(S.ring.slice(0, S.ringAt));
}

// ---------------------------------------------------------------------------
// The census — structure only, never a re-derived frustum
// ---------------------------------------------------------------------------

/**
 * One-shot structural census of the scene graph, at the two scales the walks
 * actually pay for.
 *
 * RESIDENT = every node. This is what `scene.updateMatrixWorld()` walks: it has
 * no `visible` early-out at all.
 * VISITED  = nodes reachable without crossing a `visible === false`. This is
 * what `projectObject` and EACH shadow cascade walk, both of which open with
 * `if (object.visible === false) return;`.
 *
 * SUBMITTED is deliberately absent: it is three's answer after its own frustum
 * cull, it is reported by `frameSplitReport().submitted` from the live render
 * list, and re-deriving it here would repeat the `_projDrawn` mistake
 * (`static_atlas.js`) that produced a resident-scale number wearing a
 * submitted-scale name.
 *
 * @param {object} [root] defaults to `window.liveScene3d.scene`
 */
export function frameSplitCensus(root) {
  const scene =
    root || (typeof window !== "undefined" ? window.liveScene3d?.scene : null) || null;
  if (!scene || !scene.children) {
    return { error: "no scene — pass a root or wait for window.liveScene3d" };
  }

  const resident = {
    nodes: 0,
    matrixAutoUpdate: 0,
    matrixWorldAutoUpdateFalse: 0,
  };
  const visited = {
    nodes: 0,
    // "inert" = visited, but matches NONE of projectObject's dispatch branches
    // (not a light, sprite, mesh, line or points). Every one of these is a pure
    // traversal tax: it can never contribute a draw. Groups are the bulk.
    inert: 0,
    groups: 0,
    meshes: 0,
    batchedMeshes: 0,
    instancedMeshes: 0,
    skinnedMeshes: 0,
    linesOrPoints: 0,
    sprites: 0,
    lights: 0,
    lightsCastingShadow: 0,
    lods: 0,
    frustumCulledMeshes: 0,
    castShadowMeshes: 0,
    maxDepth: 0,
  };
  // The `onBeforeRender` population, at VISITED scale. This is what decides
  // whether the hook total can be reached by patching a prototype (it cannot on
  // this app) and it is the census that would have caught the tombstoned
  // prototype-wrap design before it reported a confident near-zero.
  //
  // VISITED, not SUBMITTED: the census never re-derives the frustum. The
  // SUBMITTED-scale answer comes from the probe itself
  // (`report().health.objHooks.scannedPerCall`), off three's own render list.
  const hooks = {
    scale: "visited (superset of submitted — the census never re-derives the frustum)",
    defaultOnBeforeRender: 0,
    ownOnBeforeRender: 0, // instance property — a prototype wrapper CANNOT see these
    inheritedOverride: 0, // a non-default prototype method, e.g. stock BatchedMesh
    ownOnAfterRender: 0,
    byConstructor: {}, // ctor name → count, for the non-default ones
    // If this is false the module's `three` is a different copy from the
    // scene's and every identity compare in the adopt pass is meaningless.
    identityCheckOk: typeof _DEFAULT_ON_BEFORE_RENDER === "function",
  };
  // `setupLights` and `setupLightsView` are O(lights) and sit inside
  // `sceneSplit.split.preSubmitMs`. This is the population that prices them.
  const lightsByType = {};
  let prunedSubtrees = 0;
  let prunedNodes = 0;

  const walkResident = (o) => {
    resident.nodes += 1;
    if (o.matrixAutoUpdate) resident.matrixAutoUpdate += 1;
    if (o.matrixWorldAutoUpdate === false) resident.matrixWorldAutoUpdateFalse += 1;
    const kids = o.children;
    for (let i = 0; i < kids.length; i++) walkResident(kids[i]);
  };
  walkResident(scene);

  const countSubtree = (o) => {
    let k = 1;
    const kids = o.children;
    for (let i = 0; i < kids.length; i++) k += countSubtree(kids[i]);
    return k;
  };

  // Mirrors ONLY three's early-out (`visible === false` → return, subtree not
  // recursed). It does not mirror the frustum test, the layers test, or the
  // material-visible test: those change what is PUSHED, never what is VISITED,
  // and the visit is the cost being priced.
  const walkVisited = (o, depth) => {
    if (o.visible === false) {
      prunedSubtrees += 1;
      prunedNodes += countSubtree(o);
      return;
    }
    visited.nodes += 1;
    if (depth > visited.maxDepth) visited.maxDepth = depth;

    // The hook census. Three outcomes, and the distinction between the last two
    // is the whole point: an OWN property shadows the prototype, so a prototype
    // wrapper never runs for it.
    const obr = o.onBeforeRender;
    if (obr === _DEFAULT_ON_BEFORE_RENDER) {
      hooks.defaultOnBeforeRender += 1;
    } else {
      if (Object.prototype.hasOwnProperty.call(o, "onBeforeRender")) hooks.ownOnBeforeRender += 1;
      else hooks.inheritedOverride += 1;
      const cn = (o.constructor && o.constructor.name) || "anonymous";
      hooks.byConstructor[cn] = (hooks.byConstructor[cn] || 0) + 1;
    }
    if (Object.prototype.hasOwnProperty.call(o, "onAfterRender")) hooks.ownOnAfterRender += 1;

    let dispatched = false;
    if (o.isLight) {
      visited.lights += 1;
      if (o.castShadow) visited.lightsCastingShadow += 1;
      const lt = (o.type || (o.constructor && o.constructor.name) || "Light").toString();
      lightsByType[lt] = (lightsByType[lt] || 0) + 1;
      dispatched = true;
    } else if (o.isSprite) {
      visited.sprites += 1;
      dispatched = true;
    } else if (o.isMesh) {
      visited.meshes += 1;
      if (o.isBatchedMesh) visited.batchedMeshes += 1;
      if (o.isInstancedMesh) visited.instancedMeshes += 1;
      if (o.isSkinnedMesh) visited.skinnedMeshes += 1;
      if (o.frustumCulled !== false) visited.frustumCulledMeshes += 1;
      if (o.castShadow) visited.castShadowMeshes += 1;
      dispatched = true;
    } else if (o.isLine || o.isPoints) {
      visited.linesOrPoints += 1;
      if (o.frustumCulled !== false) visited.frustumCulledMeshes += 1;
      dispatched = true;
    }
    if (o.isLOD) visited.lods += 1;
    if (o.isGroup) visited.groups += 1;
    if (!dispatched) visited.inert += 1;
    const kids = o.children;
    for (let i = 0; i < kids.length; i++) walkVisited(kids[i], depth + 1);
  };
  walkVisited(scene, 0);

  const renderer =
    (typeof window !== "undefined" ? window.liveScene3d?.renderer : null) || S.renderer || null;
  const sm = renderer?.shadowMap || null;

  // Total per-frame node VISITS, the number the traversal buckets are really a
  // function of. `projectObject` walks visited once; each shadow cascade walks
  // it again on a rastering frame; `updateMatrixWorld` walks RESIDENT (not
  // visited) once. Stating it as one number is the point — "5,073 nodes visited
  // once" understates the frame by roughly 5x.
  const cascades = visited.lightsCastingShadow;
  const visitsPerFrame = {
    updateMatrixWorld: resident.nodes,
    projectObject: visited.nodes,
    shadowWalks: visited.nodes * cascades,
    totalIfShadowsRaster: resident.nodes + visited.nodes * (1 + cascades),
    totalIfShadowsSkip: resident.nodes + visited.nodes,
    note:
      "updateMatrixWorld walks RESIDENT (no visible early-out); projectObject " +
      "and every shadow cascade walk VISITED. matrixWorldAutoUpdate=false does " +
      "NOT prune a subtree in r184 — it skips one matrix multiply.",
  };

  return {
    scales: {
      resident: "every node under the scene — what updateMatrixWorld walks",
      visited: "nodes reachable without crossing visible===false — what projectObject and each shadow cascade walk",
      submitted: "NOT computed here; read frameSplitReport().submitted (three's own render-list length)",
    },
    resident,
    visited,
    hooks,
    // What `sceneSplit.split.preSubmitMs` is a function of, besides the draws:
    // `setupLights`/`setupLightsView` are O(lights), `background.render` only
    // exists when the scene has one, and `overrideMaterial` suppresses the
    // transmission pass entirely (`renderTransmissionPass` returns on it).
    preSubmitInputs: {
      lights: visited.lights,
      lightsByType,
      sceneBackground: scene.background ? scene.background.type || "set" : null,
      sceneEnvironment: !!scene.environment,
      overrideMaterial: !!scene.overrideMaterial,
    },
    pruned: { subtrees: prunedSubtrees, nodes: prunedNodes },
    shadow: sm
      ? {
          enabled: sm.enabled === true,
          autoUpdate: sm.autoUpdate === true,
          needsUpdate: sm.needsUpdate === true,
          type: sm.type,
          cascades,
        }
      : { available: false, cascades },
    visitsPerFrame,
    ballast: {
      nodes: S.ballastCount,
      visible: S.ballastVisible,
      drawNodes: S.drawBallastCount,
    },
  };
}

// ---------------------------------------------------------------------------
// The ballast — a MEASURED unit price for one node visit
// ---------------------------------------------------------------------------

const _BALLAST_NAME = "__frameSplitBallast";

/**
 * Attach `n` empty Groups to the scene so the per-node cost of a walk can be
 * measured as `Δbucket / n` instead of guessed.
 *
 * WHY THIS IS IMAGE-IDENTICAL, stated because a perf instrument that changes
 * the picture measures a different program. An empty `Group`:
 *   * has no geometry and no material, so `projectObject` falls through every
 *     one of its isSprite / isMesh / isLine / isPoints branches and pushes
 *     NOTHING onto the render list;
 *   * is not a light, so it adds nothing to the lights state;
 *   * is skipped by `WebGLShadowMap.renderObject`'s `object.isMesh` guard, so
 *     it rasters nothing into a shadow map.
 * It is visited by all five walks and does nothing else. The `Group` type is
 * used rather than a bare `Object3D` because the population being priced is
 * ~3,600 Groups and `projectObject` takes the `object.isGroup` branch for them.
 *
 * TWO ARMS:
 *   `setFrameSplitBallast(n)`  — visible. Adds n visits to updateMatrixWorld,
 *      n to projectObject, and n per cascade to the shadow walk.
 *   `setFrameSplitBallast(n, {visible:false})` — the root is hidden. ONLY
 *      updateMatrixWorld still walks it (that walk has no `visible` early-out);
 *      projectObject and the shadow walk both return at the root. This isolates
 *      the matrix-phase unit cost with zero effect on the other two.
 *
 * SHAPE MATTERS AND IS A KNOB. A flat array of n children under one parent is
 * not the same memory access pattern as a real graph. `opts.fanout` (default 8)
 * builds a balanced tree of that branching factor, which is closer to the live
 * shape. Report which you used; a unit cost measured flat should not be quoted
 * against a deep population without saying so.
 *
 * `setFrameSplitBallast(0)` removes it. Idempotent.
 *
 * @param {number} n
 * @param {object} [opts]
 * @param {boolean} [opts.visible=true]
 * @param {number}  [opts.fanout=8]
 * @param {boolean} [opts.matrixAutoUpdate=true] match the live population; set
 *   false to price the `updateMatrix()` compose separately from the recursion.
 * @param {object}  [opts.scene]
 */
export function setFrameSplitBallast(n, opts = {}) {
  const scene =
    opts.scene ||
    S.scene ||
    (typeof window !== "undefined" ? window.liveScene3d?.scene : null) ||
    null;
  if (!scene || typeof scene.add !== "function") {
    return { error: "no scene — pass one, or wait for window.liveScene3d" };
  }
  // Always tear down first, so this is idempotent and n is absolute rather than
  // cumulative. A cumulative ballast would silently invalidate an A/B.
  if (S.ballast && S.ballast.parent) S.ballast.parent.remove(S.ballast);
  S.ballast = null;
  S.ballastCount = 0;
  S.ballastVisible = true;
  const count = Math.max(0, n | 0);
  if (count === 0) return { ballast: 0 };

  const fanout = Math.max(1, opts.fanout === undefined ? 8 : opts.fanout | 0);
  const matrixAutoUpdate = opts.matrixAutoUpdate !== false;
  const root = new Group();
  root.name = _BALLAST_NAME;
  root.visible = opts.visible !== false;
  root.matrixAutoUpdate = matrixAutoUpdate;

  // Balanced tree, breadth-first: node i's parent is the (i/fanout)th node
  // already made. `made[0]` is the root, so `count` counts the root plus
  // `count-1` descendants — the ballast is exactly `count` extra visited nodes.
  const made = [root];
  for (let i = 1; i < count; i++) {
    const g = new Group();
    g.matrixAutoUpdate = matrixAutoUpdate;
    made[((i - 1) / fanout) | 0].add(g);
    made.push(g);
  }
  scene.add(root);
  // Compose once so the first measured frame is not paying a one-off dirty
  // cascade that the steady state does not.
  root.updateMatrixWorld(true);
  S.ballast = root;
  S.ballastCount = count;
  S.ballastVisible = root.visible;
  return {
    ballast: count,
    visible: root.visible,
    fanout,
    matrixAutoUpdate,
    shape: fanout >= count ? "flat" : "tree",
    note:
      root.visible
        ? "visible — adds visits to updateMatrixWorld, projectObject AND each shadow cascade"
        : "hidden — adds visits to updateMatrixWorld ONLY (the other walks early-out on visible===false)",
  };
}

// ---------------------------------------------------------------------------
// The DRAW ballast — a MEASURED unit price for one SUBMITTED object
// ---------------------------------------------------------------------------

const _DRAW_BALLAST_NAME = "__frameSplitDrawBallast";

/**
 * Attach `n` Meshes that are SUBMITTED and DRAWN but paint nothing, so the
 * per-submitted-object cost of `renderObject` can be measured as `Δ / n`.
 *
 * THE NODE BALLAST CANNOT DO THIS. An empty `Group` is never pushed onto a
 * render list, so it prices a VISIT and says nothing about the ~7.3 µs per
 * SUBMITTED object that `sceneSubmit − draws` implies. Different scale,
 * different instrument — which is the rule this investigation keeps relearning.
 *
 * WHY IT IS IMAGE-IDENTICAL, stated because a perf instrument that changes the
 * picture measures a different program. The geometry is ONE triangle whose
 * three vertices are the SAME point. A zero-area triangle produces no fragments
 * — the rasteriser has nothing to cover — so it writes no colour and no depth,
 * at any camera, in any order, with any material. It is the draw-scale analogue
 * of the empty Group's "matches none of projectObject's branches".
 *
 * WHAT IT COSTS AND WHAT IT DOES NOT. Every ballast mesh pays, in full:
 * `projectObject`'s dispatch and `objects.update`, a render-list push, a sort
 * comparison, `layers.test`, `onBeforeRender` (the stock no-op),
 * `modelViewMatrix.multiplyMatrices`, `normalMatrix.getNormalMatrix`,
 * `material.onBeforeRender`, one `renderBufferDirect` and `onAfterRender`. It
 * shares ONE geometry and ONE material across all `n` deliberately:
 * `WebGLObjects.update` memoises per geometry per frame and `setProgram`
 * early-outs on an unchanged material, so the injection adds renderObject glue
 * and close to the floor of a draw, rather than n distinct programs.
 *
 * So the unit that falls out of an A/B is
 *
 *     glueUnit = (B.sceneSplit.split.drawLoopMs - A.sceneSplit.split.drawLoopMs
 *                 - (B.sceneSplit.drawMs - A.sceneSplit.drawMs)) / n
 *
 * i.e. Δ(drawLoop − draws) / n — the same quantity `glueSpanPerSubmittedUs`
 * reports from the span arithmetic, measured a second, independent way. If the
 * two disagree, at least one is wrong and neither should be quoted.
 *
 * IT ALSO INFLATES `project`, `sort` AND `submitted`. Those are arms, not
 * baselines, while it is attached — `report().ballast.drawNodes` says so.
 * `frustumCulled = false` is what guarantees submission regardless of where the
 * camera points; without it the arm would silently measure 0 objects whenever
 * the ballast fell outside the frustum, which is exactly the `_projDrawn`
 * failure mode one rung down.
 *
 * `setFrameSplitDrawBallast(0)` removes it. Idempotent and absolute, not
 * cumulative — a cumulative ballast voids the A/B it exists to serve.
 *
 * @param {number} n
 * @param {object} [opts]
 * @param {object} [opts.scene]
 * @param {boolean} [opts.matrixAutoUpdate=true] match the live population.
 */
export function setFrameSplitDrawBallast(n, opts = {}) {
  const scene =
    opts.scene ||
    S.scene ||
    (typeof window !== "undefined" ? window.liveScene3d?.scene : null) ||
    null;
  if (!scene || typeof scene.add !== "function") {
    return { error: "no scene — pass one, or wait for window.liveScene3d" };
  }
  if (S.drawBallast) {
    if (S.drawBallast.parent) S.drawBallast.parent.remove(S.drawBallast);
    // Dispose the shared pair once; the meshes hold no resources of their own.
    S.drawBallast.userData.__geom?.dispose?.();
    S.drawBallast.userData.__mat?.dispose?.();
  }
  S.drawBallast = null;
  S.drawBallastCount = 0;
  const count = Math.max(0, n | 0);
  if (count === 0) return { drawBallast: 0 };

  const geom = new BufferGeometry();
  // Three identical vertices. Zero area ⇒ no fragments ⇒ no pixels touched.
  geom.setAttribute("position", new BufferAttribute(new Float32Array(9), 3));
  const mat = new MeshBasicMaterial();
  const root = new Group();
  root.name = _DRAW_BALLAST_NAME;
  root.userData.__geom = geom;
  root.userData.__mat = mat;
  const matrixAutoUpdate = opts.matrixAutoUpdate !== false;
  for (let i = 0; i < count; i++) {
    const m = new Mesh(geom, mat);
    m.frustumCulled = false; // submitted every frame, at every camera
    m.castShadow = false;
    m.receiveShadow = false;
    m.matrixAutoUpdate = matrixAutoUpdate;
    root.add(m);
  }
  scene.add(root);
  root.updateMatrixWorld(true);
  S.drawBallast = root;
  S.drawBallastCount = count;
  return {
    drawBallast: count,
    sharedGeometry: true,
    sharedMaterial: true,
    frustumCulled: false,
    matrixAutoUpdate,
    note:
      "submitted + drawn, paints nothing (zero-area triangle). Inflates submitted, project, sort and drawLoop — every one of those is an ARM while this is attached.",
  };
}

// ---------------------------------------------------------------------------
// Window surface. No URL flag: this is a pure diagnostic that costs nothing
// until armed, which is the shape `window.__statMergeProjection` established.
// ---------------------------------------------------------------------------

if (typeof window !== "undefined") {
  const guard = (fn) => (...args) => {
    try {
      return fn(...args);
    } catch (e) {
      return { error: String(e?.message ?? e) };
    }
  };
  window.__frameSplitArm = guard(armFrameSplit);
  window.__frameSplitDisarm = guard(disarmFrameSplit);
  window.__frameSplitReset = guard(resetFrameSplit);
  window.__frameSplitReport = guard(frameSplitReport);
  window.__frameSplitSamples = guard(frameSplitSamples);
  window.__frameSplitCensus = guard(frameSplitCensus);
  window.__frameSplitBallast = guard(setFrameSplitBallast);
  window.__frameSplitDrawBallast = guard(setFrameSplitDrawBallast);
}
