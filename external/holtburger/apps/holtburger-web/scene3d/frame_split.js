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
//     derived from it is null too. It is OFF by default because
//     `BatchedMesh.prototype.onBeforeRender` is a separate investigation's
//     instrument and two wrappers on one prototype is how a measurement
//     silently double-counts.
//   * `booksClosed` is false, loudly, when the buckets do not re-add to the
//     measured total within tolerance.
//
// Read-only. Never called by the app. Costs nothing until `armFrameSplit()`.
// ===========================================================================

import { Group } from "three";

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
  objHooks: false,
  objHookOrig: null,
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
    objHookMs: 0,
    objHookN: 0,
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
 * @param {boolean} [opts.objHooks=false] also wrap `BatchedMesh.prototype
 *   .onBeforeRender`. OFF by default: that prototype is the multidraw-rebuild
 *   investigation's instrument, and stacking two wrappers on it makes both
 *   readings wrong in a way neither can detect. Pass the constructor as
 *   `opts.batchedMeshCtor` (the app's `THREE.BatchedMesh`) to use this.
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
  S.objHooks = false;
  S.objHookOrig = null;
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
      try {
        return S.orig.rbd.apply(this, args);
      } finally {
        const d = _now() - a;
        if (isShadow) {
          cur.rbdShadowMs += d;
          cur.rbdShadowN += 1;
        } else {
          cur.rbdSceneMs += d;
          cur.rbdSceneN += 1;
        }
      }
    };
  }

  // --- optional: BatchedMesh.prototype.onBeforeRender -----------------------
  if (opts.objHooks === true && opts.batchedMeshCtor?.prototype) {
    const proto = opts.batchedMeshCtor.prototype;
    if (Object.prototype.hasOwnProperty.call(proto, "__frameSplitWrapped")) {
      return { error: "BatchedMesh.prototype.onBeforeRender already wrapped — refusing to stack" };
    }
    S.objHookOrig = proto.onBeforeRender;
    proto.onBeforeRender = function (...args) {
      const cur = S.cur;
      if (!cur) return S.objHookOrig.apply(this, args);
      const a = _now();
      try {
        return S.objHookOrig.apply(this, args);
      } finally {
        cur.objHookMs += _now() - a;
        cur.objHookN += 1;
      }
    };
    proto.__frameSplitWrapped = true;
    S.objHooks = true;
    S.objHookProto = proto;
  }

  S.nowCostNs = _measureNowCostNs();
  S.armed = true;
  return {
    armed: true,
    rbdWrapped: wantRbd,
    shadowWrapped: !!S.orig.shadowRender,
    objHooksWrapped: S.objHooks,
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
  if (S.objHooks && S.objHookProto) {
    S.objHookProto.onBeforeRender = S.objHookOrig;
    delete S.objHookProto.__frameSplitWrapped;
  }
  S.armed = false;
  S.phase = "idle";
  S.depth = 0;
  S.cur = null;
  return { disarmed: true };
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

  s.rbdShadow += cur.rbdShadowMs;
  s.rbdScene += cur.rbdSceneMs;
  c.rbdShadow += cur.rbdShadowN;
  c.rbdScene += cur.rbdSceneN;
  s.objHook += cur.objHookMs;
  c.objHook += cur.objHookN;

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
    rbdScene: cur.rbdSceneMs,
    rbdShadow: cur.rbdShadowMs,
    drawsScene: cur.rbdSceneN,
    drawsShadow: cur.rbdShadowN,
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
  const objHookMs = S.objHooks ? per(s.objHook) : null;
  const glueAndLights =
    sceneMinusDraws === null || objHookMs === null ? null : sceneMinusDraws - objHookMs;

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
      // What this instrument costs the frame it is measuring: two clock reads
      // per draw plus fourteen per call. Reported so nobody has to trust that
      // it is small.
      probeOverheadMs:
        S.nowCostNs === null
          ? null
          : ((2 * (c.rbdShadow + c.rbdScene)) / n + 14) * (S.nowCostNs / 1e6),
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
    let dispatched = false;
    if (o.isLight) {
      visited.lights += 1;
      if (o.castShadow) visited.lightsCastingShadow += 1;
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
    ballast: { nodes: S.ballastCount, visible: S.ballastVisible },
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
}
