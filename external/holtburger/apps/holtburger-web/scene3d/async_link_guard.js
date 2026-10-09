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

// `?asyncLinkKeySig` (2026-10-09, default on, `=off|0|false|no` escape) — the
// two exemptions above (the VERSION_DEFER_MAX rate cap and the
// VERSION_NOOP_TRUST churn trust) let a version move draw WITHOUT a compile on
// the assumption that it does not change the program key. That assumption is
// wrong for a map that APPEARS: the texchan sidecar adds roughnessMap + aoMap
// (`_applyRough` + `_reseatVariantsForDid`), the luminous alias adds
// emissiveMap — new `*MapUv` tokens, a new program. On a cold academy spawn the
// interior hold releases the HD albedo re-seats (`_repointAlbedoForDid`, same
// key: no-op compiles → trust) and the texchan sidecars together right after
// the cells attach, so the key-changing move arrives trusted or capped and
// links synchronously (1070 baseline 2026-10-09: five academy cell-surface
// programs, 449-716 ms each, two frames, 2.8 s; every key carries aoMapUv=uv).
// The key-relevant MATERIAL state is cheap to fingerprint (map presence +
// channels, the define/patch key, the blend/alpha/shading switches — never
// `side`, which three's two-pass toggles inside every draw), so a version move
// whose fingerprint changed since the guard's last compile is deferred and
// compiled like a new material — at most SIG_DEFER_MAX times per window — and
// churn with an unchanged fingerprint keeps its exemptions. A fingerprint the
// guard has already seen linked (another surface of the same class got its
// sidecar first) is a program-cache hit and draws at once, so only a class's
// first surface skips a frame. Diag: stats.sigDeferred / sigKnown / trustDraws.
const KEY_SIG = (() => {
  try {
    const v = (new URLSearchParams(globalThis.location?.search || "").get("asyncLinkKeySig") || "").toLowerCase();
    return !(v === "off" || v === "0" || v === "false" || v === "no");
  } catch (_) {
    return true;
  }
})();
export function asyncLinkKeySigEnabled() {
  return KEY_SIG;
}
export const SIG_DEFER_MAX = 6;

// `?asyncLinkFar` (2026-10-09, default on, `=off|0|false|no` escape) — the
// far-terrain patch ShaderMaterials (far_terrain.js `makePatchMaterial`: one
// clone of the base material per 4×4-LB patch, named `far-terrain-<px>-<py>`)
// join the guard. All patches share ONE program, linked by whichever patch
// draws first — on a cold academy spawn that was `far-terrain-33-0`, 202 ms
// inside the frame (1070, acad-diagF, 5.4 s after the login tunnel's reveal,
// i.e. after the tunnel's world warm had nothing to compile). Deferring a far
// patch's first draw by a few frames is invisible (it sits behind the fog band
// at ≥ 1 km); the guard compiles it against the composer-variant warm target
// with the main scene's fog + lights, so the key is the drawn one. Also: any
// ShaderMaterial carrying `userData.__asyncLink === true` (explicit opt-in).
// Every other ShaderMaterial still draws exactly as before (terrain, water,
// particles, post passes). Off: far patches draw untouched (today).
const FAR = (() => {
  try {
    const v = (new URLSearchParams(globalThis.location?.search || "").get("asyncLinkFar") || "").toLowerCase();
    return !(v === "off" || v === "0" || v === "false" || v === "no");
  } catch (_) {
    return true;
  }
})();
export function asyncLinkFarEnabled() {
  return FAR;
}
const _FAR_PATCH_RE = /^far-terrain-\d+-\d+$/;

/**
 * Would the guard defer this material's not-yet-linked draws in the main scene?
 * Built-in Mesh*Material (not `__noAsyncLink`), plus — under `?asyncLinkFar` —
 * far-terrain patch ShaderMaterials and explicit `userData.__asyncLink` opt-ins.
 * Exported for portal_space.js's tunnel warm (it holds the release only on
 * programs the guard would NOT defer) and the node tests.
 */
export function asyncLinkEligible(material) {
  if (!material || material.userData?.__noAsyncLink) return false;
  const t = material.type;
  if (typeof t !== "string") return false;
  if (t.charCodeAt(0) === 77 /* 'M' */ && t.startsWith("Mesh")) return true;
  if (!FAR || t !== "ShaderMaterial") return false;
  if (material.userData?.__asyncLink === true) return true;
  return typeof material.name === "string" && _FAR_PATCH_RE.test(material.name);
}

// Every texture slot three's getParameters reads (r184 HAS_* / *MapUv).
const _SIG_MAPS = [
  "map", "alphaMap", "lightMap", "aoMap", "bumpMap", "normalMap", "displacementMap", "emissiveMap",
  "metalnessMap", "roughnessMap", "specularMap", "specularColorMap", "specularIntensityMap", "gradientMap",
  "envMap", "matcap", "clearcoatMap", "clearcoatNormalMap", "clearcoatRoughnessMap", "iridescenceMap",
  "iridescenceThicknessMap", "sheenColorMap", "sheenRoughnessMap", "transmissionMap", "thicknessMap",
  "anisotropyMap",
];

/**
 * Fingerprint of the MATERIAL-side inputs of three r184's program cache key
 * (getParameters + getProgramCacheKey). Object/geometry axes are objectCombo's;
 * scene/state axes (lights, fog, env, target) are not material state. `side`
 * is deliberately excluded (see KEY_SIG). Exported for the node test.
 */
export function materialKeySig(m) {
  if (!m) return "";
  let maps = 0;
  let chans = "";
  for (let i = 0; i < _SIG_MAPS.length; i++) {
    const t = m[_SIG_MAPS[i]];
    if (t) {
      maps |= 1 << i;
      chans += (t.channel | 0);
    }
  }
  const nm = m.normalMap;
  const sw =
    (m.alphaTest > 0 ? 1 : 0) | (m.alphaHash ? 2 : 0) | (m.vertexColors ? 4 : 0) |
    (m.flatShading ? 8 : 0) | (m.wireframe ? 16 : 0) | (m.fog ? 32 : 0) |
    (m.toneMapped ? 64 : 0) | (m.dithering ? 128 : 0) | (m.premultipliedAlpha ? 256 : 0) |
    (m.transparent === false && m.blending === 1 && !m.alphaToCoverage ? 512 : 0) |
    (m.alphaToCoverage ? 1024 : 0) | (m.normalMapType === 1 ? 2048 : 0) |
    (m.clearcoat > 0 ? 4096 : 0) | (m.iridescence > 0 ? 8192 : 0) | (m.sheen > 0 ? 16384 : 0) |
    (m.transmission > 0 ? 32768 : 0) | (m.anisotropy > 0 ? 65536 : 0) | (m.dispersion > 0 ? 131072 : 0) |
    (m.sizeAttenuation ? 262144 : 0);
  let ck = "";
  try {
    if (typeof m.customProgramCacheKey === "function") ck = String(m.customProgramCacheKey());
  } catch (_) { /* a throwing key reads as "" (stable) */ }
  let defs = "";
  const d = m.defines;
  if (d) for (const k in d) defs += k + "=" + d[k] + ";";
  // packedNormalMap: three's isPackedRGFormat (RGFormat / RG11_EAC / RGTC2) —
  // any other normal-map format swap (DataTexture → BC7 re-seat) is key-neutral.
  const nf = nm ? nm.format : 0;
  const packed = nf === 1030 || nf === 37490 || nf === 36285 ? 1 : 0;
  // `type` leads: three keys the program on shaderIDs[material.type], and the
  // guard-wide readySigs set compares fingerprints ACROSS materials — a Basic /
  // Lambert / Depth material with the same maps + switches is another program.
  return (m.type || "") + "|" + maps + "|" + chans + "|" + sw + "|" + packed + "|" + (m.precision || "") + "|" + defs + "|" + ck;
}

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
    // ?asyncLinkKeySig: fingerprint at the guard's last compile (null = unknown
    // → no check), the one computed for the current decision, and the burst cap.
    sig: null, sigAtQueue: null, curSig: null, sigDefers: 0, sigDeferAt: -Infinity, sideAtQueue: 0, twoPassAtQueue: false,
  };
}

// ?asyncLinkKeySig: a version move whose key fingerprint changed since our last
// compile. Caches the computed fingerprint on `st.curSig` (slow-path state only).
function _sigMoved(material, st) {
  if (!KEY_SIG || !st || st.sig === null || st.sig === undefined) return false;
  const sg = materialKeySig(material);
  st.curSig = sg;
  if (sg === st.sig) return false;
  // Burst cap: a fingerprint that flips every frame must still draw eventually.
  return !(st.sigDefers >= SIG_DEFER_MAX && _now() - st.sigDeferAt < VERSION_DEFER_WINDOW_MS);
}

/**
 * Decide whether a draw must wait. Pure over its inputs (exported for the node
 * test) except for the `st.curSig` fingerprint cache. `mp` is
 * `renderer.properties.get(material)`, `st` the slow-path state (or undefined).
 * Returns 0 = draw, 1 = defer + compile, 2 = defer (in flight), 3 = defer +
 * compile because the key fingerprint moved (?asyncLinkKeySig; queued like 1).
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
    if (_sigMoved(material, st)) return 3; // a map/patch appeared: never draw it uncompiled
    // Same burst cap as below: a never-drawn material whose version moves
    // every frame must still draw eventually.
    if (st && st.verDefers >= VERSION_DEFER_MAX && _now() - st.verDeferAt < VERSION_DEFER_WINDOW_MS) return 0;
    return 1;
  }
  if (material.version !== mp.__version) {
    if (st && st.ver === material.version) return 0; // we compiled this version
    if (_sigMoved(material, st)) return 3; // key change: neither the trust nor the rate cap applies
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
  // sigDeferred: version moves deferred because the key fingerprint moved
  // (?asyncLinkKeySig); trustDraws: version moves drawn through on the churn
  // trust (the off arm's suspects for a first-draw link).
  const stats = { deferred: 0, queued: 0, compiled: 0, failed: 0, drains: 0, inFlight: 0, trustRevoked: 0, sigDeferred: 0, sigKnown: 0, trustDraws: 0 };
  // ?asyncLinkKeySig: `${fingerprint}#${objectCombo}` this guard has seen linked
  // (our compile became ready, or a draw went through on it). A key change to
  // one of these is a program-cache hit — draw it now instead of skipping a
  // frame (otherwise every surface of a class would blink when its texchan
  // sidecar lands; only the class's first one needs the off-frame compile).
  // Keyed with the draw's `side` too: the fingerprint ignores it (three's
  // two-pass toggles it inside every draw) but a Front and a Double material
  // are different programs.
  const readySigs = new Set();
  const noteReadySig = (sig, combo, side) => {
    if (sig === null || sig === undefined) return;
    if (readySigs.size >= 4096) readySigs.clear();
    readySigs.add(sig + "#" + combo + "#" + side);
  };
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
        if (KEY_SIG) {
          st.sig = st.sigAtQueue;
          // compile() builds a transparent DoubleSide material as its Back and
          // Front programs (three prepareMaterial) — the sides it draws with.
          if (st.sideAtQueue === 2 && st.twoPassAtQueue) { noteReadySig(st.sigAtQueue, st.comboAtQueue, 1); noteReadySig(st.sigAtQueue, st.comboAtQueue, 0); }
          else noteReadySig(st.sigAtQueue, st.comboAtQueue, st.sideAtQueue);
        }
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
      if (KEY_SIG) {
        st.sigAtQueue = materialKeySig(qm);
        st.sideAtQueue = qm.side;
        st.twoPassAtQueue = qm.transparent === true && qm.forceSinglePass !== true;
      }
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
        const combo = objectCombo(object, material);
        // Mesh*Material, or (?asyncLinkFar) a far-terrain patch / opted-in ShaderMaterial.
        if (!asyncLinkEligible(material)) {
          stamp(material, combo); // never eligible: stamp and forget
        } else {
          const mp = props.get(material);
          const s0 = slow.get(material);
          if (s0 !== undefined) s0.curSig = null; // fingerprint cache: this decision only
          let d = linkDecision(material, mp, combo, s0);
          if (d === 3 && s0 !== undefined && readySigs.has(s0.curSig + "#" + combo + "#" + material.side)) { d = 0; stats.sigKnown += 1; }
          if (d !== 0) {
            stats.deferred += 1;
            if ((d === 1 || d === 3) && !queue.has(material)) {
              if (d === 3) {
                // ?asyncLinkKeySig: its own burst cap (SIG_DEFER_MAX per window).
                const st = stateOf(material), now = _now();
                if (now - st.sigDeferAt >= VERSION_DEFER_WINDOW_MS) st.sigDefers = 0;
                st.sigDefers += 1;
                st.sigDeferAt = now;
                stats.sigDeferred += 1;
              } else if (material.version !== mp.__version && mp.currentProgram) {
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
          // A version move drawn without our compile (trust / rate cap): three
          // now holds a program for this fingerprint — remember it, or every
          // later move would compare against a stale one.
          if (KEY_SIG && st.curSig !== null && st.sig !== null && mp && mp.__version !== material.version) { st.sig = st.curSig; noteReadySig(st.curSig, combo, material.side); }
          // Trusted churn draws through a version move: if three had to build
          // a program for it after all, stop trusting (VERSION_NOOP_TRUST).
          if (st.verNoop >= VERSION_NOOP_TRUST && mp && mp.__version !== material.version) {
            stats.trustDraws += 1;
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
    /** Does the guard (while on) defer this material's unlinked main-scene draws? */
    guards: (m) => !ctl.off && asyncLinkEligible(m),
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
