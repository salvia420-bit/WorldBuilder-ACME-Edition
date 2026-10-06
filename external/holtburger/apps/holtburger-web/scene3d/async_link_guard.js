// scene3d/async_link_guard.js — never let a world draw force a synchronous
// shader link (`?asyncLink`, DEFAULT ON, `=off` escape). Perf 2026-10-06.
//
// WHY. On the 1070 (ANGLE/D3D11) one MeshStandardMaterial variant takes 1-2 s
// to compile + link. three links lazily: the first draw of a material whose
// program is new calls `program.getUniforms()` → WebGLUniforms → a blocking
// `getProgramParameter`, and the whole frame waits. The prewarm passes
// (shader_prewarm.js boot pass, bake_prewarm.js `prewarmSubtree`, per-spawn rig
// warm) cover most content, but not every path: a teleport Holtburg → Shoushi
// linked two programs mid-frame at 1,658 ms and 1,082 ms (a tree material
// carrying `deformation.windSwayGpu`, and a one-feature-bit variant of a
// statics surface), and a 3-LB tour spent 3.8 s of its 8.1 s of >50 ms frames
// in `getProgramParameter`. Chasing each warm path one at a time does not end.
//
// WHAT. A wrapper on `renderer.renderBufferDirect` for draws of the MAIN scene:
// when the material has no program yet, or its program is still linking
// (KHR_parallel_shader_compile COMPLETION_STATUS, non-blocking), or its version
// moved since we last compiled it, or its current program belongs to another
// object KIND (batched / instanced / skinned), the draw is SKIPPED this frame
// and the object is queued and compiled after the frame against the
// composer-variant warm target (shader_prewarm.js). The object pops in a few
// frames late instead of freezing the game for a second.
//
//   - Only built-in mesh materials (Mesh*Material) in the main scene. Post
//     passes, the sky scene, shadow depth materials and ShaderMaterials draw
//     exactly as before.
//   - compile() must not run inside render() (it resets three's render state),
//     so the queue drains from a setTimeout after the frame.
//   - A material whose version keeps moving (an effect bumping needsUpdate
//     every frame) is deferred at most VERSION_DEFER_MAX times, then left to
//     three — a guard that could hide something forever is worse than a hitch.
//   - Materials flagged `userData.__noAsyncLink` (the occlusion proxies, whose
//     queries must bracket a real draw) are never deferred.
//
// OBJECT SHAPES. The steady-state fast path reads FOUR stamp fields on the
// material, always created together in one fixed order the first time a
// material is stamped; every other piece of bookkeeping lives in a WeakMap
// touched only on the slow path. Adding properties to materials in varying
// orders multiplies V8 hidden classes and turns three's material reads
// megamorphic (2.2x slower reads measured with prototype variants mixed into
// the population — see batched_material_variant.js).

import { withWarmTarget } from "./shader_prewarm.js";

const FLAG = (() => {
  try {
    const v = (new URLSearchParams(globalThis.location?.search || "").get("asyncLink") || "").toLowerCase();
    return !(v === "off" || v === "0" || v === "false" || v === "no");
  } catch (_) {
    return true;
  }
})();

export function asyncLinkEnabled() {
  return FLAG;
}

export const VERSION_DEFER_MAX = 2;
// The cap is a RATE: deferrals older than this no longer count. A material
// whose maps are upgraded a few times over minutes (DataTexture → BC7 → XU7
// re-seats each bump `version`, and each can need a new program) must be
// deferred EVERY time — a lifetime count let the third upgrade link
// synchronously (1.1-1.3 s on the 1070, first street-level camera sweep).
export const VERSION_DEFER_WINDOW_MS = 2000;
// Version CHURN that never needs a link (eye-test 2026-10-06, 1070). three
// draws a transparent DoubleSide material in two passes, each preceded by
// `side = Back|Front; needsUpdate = true` (r184 renderObject), so `version`
// moves twice per frame and both per-side programs are program-cache hits.
// Two Holtburg static-atlas buckets (`stat-atlas-x-*|1|…`) did this: the
// rate cap above let 2 deferrals through per window, so the bucket's statics
// blinked out for a frame every ~2 s (107 skipped frames over a 23 s cold
// Shoushi tour). A version-moved compile that added NO program to the
// material's `programs` map is a no-op; after VERSION_NOOP_TRUST of those in a
// row the material's version moves draw through. A trusted draw that does
// create a program (a real key change) revokes the trust on the spot, so at
// most that one link is synchronous — the pre-guard behaviour.
export const VERSION_NOOP_TRUST = 2;
const MAX_COMPILES_PER_DRAIN = 64;

let _activeApi = null;
/** True while a ?asyncLink compile is in flight. GPU-process round-trips
 *  (getBufferSubData, readPixels) issued then queue behind the driver's shader
 *  compile — a 189 ms fog-probe readback was measured on the 1070 — so
 *  optional readbacks should skip a beat. */
export function asyncLinkBusy() {
  return !!_activeApi && _activeApi.stats.inFlight > 0;
}

/** Program-variant bits three keys on the OBJECT / GEOMETRY, not the material
 *  (three r184 setProgram `needsProgramChange`): a material shared by a
 *  BatchedMesh / InstancedMesh / SkinnedMesh and a plain Mesh, or by geometries
 *  that differ in vertex alphas / tangents / morph targets / instance or batch
 *  colours, needs one program per combination, and three builds the missing one
 *  SYNCHRONOUSLY on first use (a 1.33 s link on the 1070, first street-level
 *  camera sweep at Holtburg). Same expressions as three, so a material whose
 *  combination was never compiled is deferred like a brand-new one. */
export function objectCombo(object, material) {
  const g = object?.geometry;
  const a = g?.attributes;
  let c = (object?.isBatchedMesh ? 1 : 0) | (object?.isInstancedMesh ? 2 : 0) | (object?.isSkinnedMesh ? 4 : 0);
  if (material && a) {
    if (material.vertexColors === true && a.color && a.color.itemSize === 4) c |= 8;
    if (a.tangent && (material.normalMap || material.anisotropy > 0)) c |= 16;
    const ma = g.morphAttributes;
    if (ma && ma.position) c |= 32;
  }
  if (object?.isInstancedMesh && object.instanceColor !== null && object.instanceColor !== undefined) c |= 64;
  if (object?.isBatchedMesh && (object._colorsTexture ?? object.colorTexture) != null) c |= 128;
  return c;
}
function mpCombo(mp) {
  return (mp.batching ? 1 : 0) | (mp.instancing ? 2 : 0) | (mp.skinning ? 4 : 0) |
    (mp.vertexAlphas ? 8 : 0) | (mp.vertexTangents ? 16 : 0) | (mp.morphTargets ? 32 : 0) |
    (mp.instancingColor ? 64 : 0) | (mp.batchingColor ? 128 : 0);
}

/** Slow-path bookkeeping per material (never stored ON the material). */
export function newLinkState() {
  return {
    pending: false, ver: -1, verAtQueue: -1, comboAtQueue: 0, verDefers: 0, verDeferAt: -Infinity, combos: new Set(),
    verMoveAtQueue: false, progsAtQueue: 0, verNoop: 0,
  };
}

/**
 * Decide whether a draw must wait. Pure over its inputs (exported for the node
 * test). `mp` is `renderer.properties.get(material)`, `st` the slow-path state
 * (or undefined). Returns 0 = draw, 1 = defer + compile, 2 = defer (in flight).
 */
export function linkDecision(material, mp, combo = 0, st = undefined) {
  if (!material || material.userData?.__noAsyncLink) return 0;
  if (st && st.pending) return 2;
  const prog = mp?.currentProgram;
  if (!prog) return 1;
  // The current program belongs to another object KIND (batched vs plain …):
  // three would build/look up the other kind's program synchronously. Safe
  // only once we have compiled that kind for this material (then it is a
  // program-cache hit) — measured 1.3-1.5 s links on the 1070 with
  // ?batchMatVariant=off, where batched + plain draws share a material.
  if (mp.batching !== undefined && mpCombo(mp) !== combo) {
    if (!st || !st.combos.has(combo)) return 1;
  }
  if (typeof prog.isReady === "function" && prog.isReady() !== true) return 2;
  // Compiled (by a prewarm) but NEVER drawn: three's first setProgram always
  // re-derives the program (`__version` is unset), and if the material changed
  // since that compile — late normal / roughness / AO channels re-seat maps and
  // bump `version` — the key differs and three links SYNCHRONOUSLY (1.0-1.15 s
  // on the 1070: cellstatic 0x0800013d, first street-level sweep, key fields
  // 10/16 false→uv). Draw it only at a version this guard compiled itself; a
  // re-compile of an unchanged key is a program-cache hit.
  if (mp.__version === undefined) {
    if (st && st.ver === material.version) return 0;
    // Same burst cap as below: a never-drawn material whose version moves
    // every frame must still draw eventually.
    if (st && st.verDefers >= VERSION_DEFER_MAX && _now() - st.verDeferAt < VERSION_DEFER_WINDOW_MS) return 0;
    return 1;
  }
  if (material.version !== mp.__version) {
    if (st && st.ver === material.version) return 0; // we compiled this version
    if (st && st.verNoop >= VERSION_NOOP_TRUST) return 0; // learned churn (see VERSION_NOOP_TRUST)
    if (st && st.verDefers >= VERSION_DEFER_MAX && _now() - st.verDeferAt < VERSION_DEFER_WINDOW_MS) return 0;
    return 1;
  }
  return 0;
}

function _now() { return typeof performance !== "undefined" ? performance.now() : Date.now(); }

// The four fast-path stamp fields, created together in one fixed order.
function stamp(material, combo) {
  material.__hbLinkOk = material.version;
  material.__hbLinkOkOwner = material;
  material.__hbLinkOkCombo = combo;
  if (material.__hbLinkOkListen !== true) material.__hbLinkOkListen = false;
}

export function installAsyncLinkGuard(renderer, getMainScene) {
  if (!FLAG || !renderer || typeof renderer.renderBufferDirect !== "function") return null;
  if (renderer.__hbAsyncLink) return renderer.__hbAsyncLink;
  const orig = renderer.renderBufferDirect;
  const props = renderer.properties;
  const slow = new WeakMap(); // material -> newLinkState()
  const stateOf = (m) => { let st = slow.get(m); if (!st) { st = newLinkState(); slow.set(m, st); } return st; };
  // Keyed by MATERIAL: three's compile() re-collects the target scene's lights,
  // so one compile per material — not per object — keeps a burst of new trees
  // from becoming its own hitch.
  const queue = new Map(); // material -> { object, camera, scene, combo }
  const stats = { deferred: 0, queued: 0, compiled: 0, failed: 0, drains: 0, inFlight: 0, trustRevoked: 0 };
  let drainArmed = false;

  // compile()'s target scene only contributes isScene / fog / environment /
  // environmentRotation (three r184 getParameters + getProgram) and the lights
  // its traverseVisible() reaches. A stand-in carrying exactly those — with the
  // main scene's visible lights cached for LIGHT_CACHE_MS — gives the same
  // program keys without walking the whole world on every drain.
  const LIGHT_CACHE_MS = 500;
  let lightCache = [], lightCacheAt = -Infinity, lightCacheScene = null, standIn = null;
  const targetFor = (main) => {
    const now = (typeof performance !== "undefined" ? performance.now() : Date.now());
    if (main !== lightCacheScene || now - lightCacheAt > LIGHT_CACHE_MS) {
      const ls = [];
      try { main.traverseVisible((o) => { if (o.isLight) ls.push(o); }); } catch (_) {}
      lightCache = ls; lightCacheAt = now; lightCacheScene = main;
    }
    if (!standIn || standIn.__main !== main) {
      standIn = {
        __main: main,
        isScene: true,
        get fog() { return main.fog; },
        get environment() { return main.environment; },
        get environmentRotation() { return main.environmentRotation; },
        traverseVisible(cb) { for (const l of lightCache) cb(l); },
        traverse(cb) { for (const l of lightCache) cb(l); },
      };
    }
    return standIn;
  };
  // One compile() per drain over EVERY queued object: compile() walks its
  // first argument with traverse/traverseVisible only, so a duck-typed root over
  // the queued meshes compiles them all at once. Readiness is then polled PER
  // MATERIAL, so a cache hit unblocks next frame instead of waiting on the
  // slowest link of its batch.
  const pollPending = new Set();
  let pollArmed = false;
  const poll = () => {
    pollArmed = false;
    for (const m of pollPending) {
      let prog = null;
      try { prog = props.get(m).currentProgram; } catch (_) { /* disposed */ }
      let ready = true;
      try { ready = !prog || typeof prog.isReady !== "function" || prog.isReady() === true; } catch (_) { ready = true; }
      if (ready) {
        pollPending.delete(m);
        const st = stateOf(m);
        st.pending = false;
        st.ver = st.verAtQueue;
        st.combos.add(st.comboAtQueue);
        if (st.verMoveAtQueue) {
          let progs = 0;
          try { progs = props.get(m).programs?.size ?? 0; } catch (_) { /* disposed */ }
          st.verNoop = progs > st.progsAtQueue ? 0 : st.verNoop + 1;
        }
        stats.compiled += 1;
        stats.inFlight -= 1;
      }
    }
    if (pollPending.size > 0) armPoll();
  };
  const armPoll = () => {
    if (pollArmed) return;
    pollArmed = true;
    setTimeout(poll, 10);
  };
  const drain = () => {
    drainArmed = false;
    stats.drains += 1;
    const objs = [];
    const mats = [];
    let camera = null, scene = null, n = 0;
    for (const [qm, ctx] of queue) {
      if (n++ >= MAX_COMPILES_PER_DRAIN) break;
      queue.delete(qm);
      const st = stateOf(qm);
      st.pending = true;
      st.verAtQueue = qm.version;
      st.comboAtQueue = ctx.combo | 0;
      // A re-compile of a material that already has a program (a version or
      // kind move, not a first link): the compile below tells us whether it
      // needed a new program at all.
      const qmp = props.get(qm);
      st.verMoveAtQueue = !!qmp.currentProgram;
      st.progsAtQueue = qmp.programs?.size ?? 0;
      objs.push(ctx.object);
      mats.push(qm);
      camera = camera || ctx.camera;
      scene = scene || ctx.scene;
    }
    if (objs.length) {
      const root = {
        traverse(cb) { for (const o of objs) cb(o); },
        traverseVisible(cb) { for (const o of objs) cb(o); },
      };
      try {
        withWarmTarget(renderer, () => renderer.compile(root, camera, scene && scene.isScene ? targetFor(scene) : scene));
      } catch (_) {
        stats.failed += 1;
      }
      for (const m of mats) { pollPending.add(m); stats.inFlight += 1; }
      armPoll();
    }
    if (queue.size > 0) arm();
  };
  const arm = () => {
    if (drainArmed) return;
    drainArmed = true;
    setTimeout(drain, 0);
  };

  // FAST PATH (steady state): a material whose current version already drew on
  // a ready program for this object KIND carries `__hbLinkOk === version` —
  // three property compares per draw. The 3-rep bench measured the unstamped
  // wrapper at -1.5 fps steady; the stamp makes the guard's cost proportional
  // to NEW materials, not to draws. The owner field matters: a prototype-derived
  // material would otherwise INHERIT another object's stamp. A material dispose
  // clears the stamp (three frees its program slot; a reused material object
  // must be checked again).
  let mainScene = null;
  const clearOk = (ev) => { const m = ev && ev.target; if (m) m.__hbLinkOk = -1; };
  const ctl = { off: false }; // live A/B seam: window.__asyncLink.off = true
  renderer.renderBufferDirect = function (camera, scene, geometry, material, object, group) {
    if (ctl.off) return orig.call(this, camera, scene, geometry, material, object, group);
    if (material && (material.__hbLinkOk !== material.version || material.__hbLinkOkOwner !== material || material.__hbLinkOkCombo !== objectCombo(object, material)) && scene !== null && object) {
      if (mainScene === null) mainScene = getMainScene() || null;
      if (scene === mainScene) {
        const t = material.type;
        const combo = objectCombo(object, material);
        if (typeof t !== "string" || t.charCodeAt(0) !== 77 /* 'M' */ || !t.startsWith("Mesh") || material.userData?.__noAsyncLink) {
          stamp(material, combo); // never eligible: stamp and forget
        } else {
          const mp = props.get(material);
          const d = linkDecision(material, mp, combo, slow.get(material));
          if (d !== 0) {
            stats.deferred += 1;
            if (d === 1 && !queue.has(material)) {
              if (material.version !== mp.__version && mp.currentProgram) {
                const st = stateOf(material), now = _now();
                if (now - st.verDeferAt >= VERSION_DEFER_WINDOW_MS) st.verDefers = 0;
                st.verDefers += 1;
                st.verDeferAt = now;
              }
              queue.set(material, { object, camera, scene, combo });
              stats.queued += 1;
              arm();
            }
            return;
          }
          stamp(material, combo);
          if (material.__hbLinkOkListen !== true && typeof material.addEventListener === "function") {
            try { material.addEventListener("dispose", clearOk); } catch (_) {}
            material.__hbLinkOkListen = true;
          }
          const st = stateOf(material);
          st.combos.add(combo);
          // Trusted churn draws through a version move: if three had to build
          // a program for it after all, stop trusting (VERSION_NOOP_TRUST).
          if (st.verNoop >= VERSION_NOOP_TRUST && mp && mp.__version !== material.version) {
            const before = mp.programs?.size ?? 0;
            const ret = orig.call(this, camera, scene, geometry, material, object, group);
            if ((mp.programs?.size ?? 0) > before) { st.verNoop = 0; stats.trustRevoked += 1; }
            return ret;
          }
        }
      }
    }
    return orig.call(this, camera, scene, geometry, material, object, group);
  };

  const api = {
    stats,
    get off() { return ctl.off; },
    set off(v) { ctl.off = !!v; },
    get pending() { return queue.size; },
    /** Test seam: the slow-path state of a material (undefined if none). */
    stateOf: (m) => slow.get(m),
    uninstall() { renderer.renderBufferDirect = orig; delete renderer.__hbAsyncLink; if (_activeApi === api) _activeApi = null; },
  };
  try { Object.defineProperty(renderer, "__hbAsyncLink", { value: api, configurable: true }); } catch (_) { renderer.__hbAsyncLink = api; }
  _activeApi = api;
  if (typeof window !== "undefined") {
    try { window.__asyncLink = api; } catch (_) {}
  }
  return api;
}
