// scene3d/batched_indirect_per_camera.js — one BatchedMesh indirect texture per
// CAMERA, re-uploaded only when that camera's answer changed
// (`?bmIndirectPerCamera`, DEFAULT ON, `=off` escape). Perf 2026-10-07.
//
// WHY. three r184's `BatchedMesh` keeps ONE `_indirectTexture` (drawId -> instance
// id, a tiny R32UI DataTexture). Every `onBeforeRender` rebuild rewrites it and
// sets `needsUpdate`, and the shadow pass routes through the same hook with the
// SHADOW camera (`onBeforeShadow` -> `this.onBeforeRender`, three.core.js
// :27370). At quality high/ultra (`csm: true`) every shadow-casting bucket is
// drawn by FOUR cameras a frame — 3 CSM cascades + the colour camera — each with
// a different culled answer, so the one texture is rewritten and RE-UPLOADED
// four times a frame, every frame, for every bucket:
//   * cross-LB atlas buckets (static_atlas.js) go through three's own rebuild,
//     which bumps the texture unconditionally on every call;
//   * `?statBatchMemo` buckets (static_batch_x.js) HIT their per-camera slot
//     (`?statBatchMemoSlots=4`) but a hit on a slot that is not the live one
//     copies its ids back and sets `needsUpdate` ("O(drawn) + one indirect
//     upload" — url-flags.md) — and with 4 cameras alternating, no hit is ever
//     on the live slot.
// MEASURED (prof3.json, 1070 ultra, fighting/running, 222 frames, every frame
// rastering shadows): `uploadTexture` 541 ms = 2.44 ms/frame, ALL of it
// DataTexture `texSubImage2D` (updateTexture :11789 is the DataTexture-only
// path) + three's per-upload glue (initTexture's cache-key string build,
// setTextureParameters, pixelStorei) — 1.66 ms/frame inside the shadow pass,
// 0.78 in the colour pass.
//
// WHAT. Each culled/sorted BatchedMesh gets a small per-camera table (WeakMap,
// no new fields on the node — V8 hidden-class discipline). Before the bucket's
// `onBeforeRender` runs, `_indirectTexture` is pointed at THAT camera's texture;
// after it runs, if the rebuild bumped the texture but wrote exactly the ids the
// camera's texture already holds (same count, same prefix), the version bump is
// rolled back, so three binds the texture without re-uploading it. The ids
// three writes are still written (into the camera's own array), the multidraw
// starts/counts are untouched, and a camera whose answer DID change uploads as
// before. OUTPUT-IDENTICAL: the GPU texture each draw samples holds, at indices
// < `_multiDrawCount` (the only ones the batching shader reads, gl_DrawID), the
// ids that draw's rebuild produced.
//
// WHEN IT STEPS ASIDE (calls straight through, one shared texture as before):
//   * `?bmIndirectPerCamera=off`, or the live seam `window.__bmIndirectPerCamera.off`;
//   * a bucket that is neither `perObjectFrustumCulled` nor `sortObjects` — its
//     ids are camera-INDEPENDENT and three only rewrites them when
//     `_visibilityChanged`, so every camera must keep reading the one texture;
//   * re-entry (the memo's miss path calls `BatchedMesh.prototype.onBeforeRender`
//     from inside its own override; the outer call already owns the swap).
//
// LIFETIME. three replaces `_indirectTexture` itself in `setInstanceCount`
// (dispose + re-init + copy). The next call sees a texture it did not install
// and resets the table: our other textures are disposed and the new one is
// adopted by the camera that last drew (its content is that camera's copy).
// `BatchedMesh.prototype.dispose` is wrapped to dispose the per-camera textures
// three does not know about. At most MAX_CAMERAS textures per bucket (LRU).
//
// ROLLBACK SAFETY. A bump is only rolled back when the texture's version at
// entry is the version we left it at last time (nothing else touched it) and the
// new ids equal the copy we kept when we last let an upload through. Rolling
// back to the entry version never hides data: if that version was already
// uploaded the GPU holds those exact ids, and if it was still pending the
// pending upload sends the (identical) current array.

import * as THREE from "three";

const FLAG = (() => {
  try {
    const v = (new URLSearchParams(globalThis.location?.search || "").get("bmIndirectPerCamera") || "").toLowerCase();
    return !(v === "off" || v === "0" || v === "false" || v === "no");
  } catch (_) {
    return true;
  }
})();

export function bmIndirectPerCameraEnabled() {
  return FLAG;
}

/** Cameras per bucket before the least-recently-used one's texture is freed.
 *  Colour camera + 3 CSM cascades + headroom (portal / prewarm cameras). */
export const MAX_CAMERAS = 6;

const ctl = { off: false };
const stats = {
  calls: 0,        // wrapped onBeforeRender calls that took the per-camera path
  passthrough: 0,  // camera-independent buckets / re-entry / no texture
  uploads: 0,      // calls whose rebuild changed this camera's ids (upload kept)
  skipped: 0,      // calls whose bump was rolled back (upload avoided)
  noWrite: 0,      // calls that did not touch the ids (memo live-slot hits)
  created: 0,      // per-camera textures allocated
  disposed: 0,     // per-camera textures freed (LRU, reset, bucket dispose)
  resets: 0,       // three replaced the texture (setInstanceCount)
  errors: 0,
};

/** @type {WeakMap<object, {installed: object, lastCam: object|null, cams: Array}>} */
const _state = new WeakMap();
let _active = null; // the bucket whose call currently owns the swap (re-entry guard)

function _newEntry(camera, tex) {
  // Fixed field order — every entry has the same shape.
  return { camera, tex, prev: null, prevN: -1, verOut: -1, srcVerOut: -1 };
}

function _makeLike(tex) {
  // NOT tex.clone(): Texture.copy SHARES the Source, and three keys the GL
  // texture and its upload version on the Source — two clones would be one GL
  // texture. A fresh DataTexture with its own array, same layout as three's
  // `_initIndirectTexture` (RedIntegerFormat / UnsignedIntType, nearest, no mips).
  const img = tex.image;
  const data = new img.data.constructor(img.data.length);
  const t = new THREE.DataTexture(data, img.width, img.height, tex.format, tex.type);
  t.internalFormat = tex.internalFormat;
  stats.created += 1;
  return t;
}

function _dispose(tex) {
  try { tex.dispose(); stats.disposed += 1; } catch (_) { stats.errors += 1; }
}

/** three swapped `_indirectTexture` under us — drop the table, adopt `live`. */
function _reset(st, live) {
  stats.resets += 1;
  for (const e of st.cams) if (e.tex !== live) _dispose(e.tex);
  st.cams.length = 0;
  // `live` holds a copy of whatever was installed last, i.e. the last caller's
  // ids — give it to that camera; every other camera starts fresh.
  if (st.lastCam) st.cams.push(_newEntry(st.lastCam, live));
  st.installed = live;
}

function _entryFor(st, camera) {
  const cams = st.cams;
  for (let i = 0; i < cams.length; i++) {
    const e = cams[i];
    if (e.camera !== camera) continue;
    // Move to front in place: with 4 cameras alternating this runs on nearly
    // every call, and `splice` would allocate an array each time.
    for (let j = i; j > 0; j--) cams[j] = cams[j - 1];
    cams[0] = e;
    return e;
  }
  // First camera on a fresh table adopts three's own texture; later ones get
  // their own.
  const tex = cams.length === 0 ? st.installed : _makeLike(st.installed);
  const e = _newEntry(camera, tex);
  cams.unshift(e);
  while (cams.length > MAX_CAMERAS) {
    const old = cams.pop();
    // Never the installed one: that is the most recent caller, at the front.
    if (old.tex !== st.installed) _dispose(old.tex);
  }
  return e;
}

function _samePrefix(a, b, n) {
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Run `fn` (a BatchedMesh `onBeforeRender` implementation) for `bm` with
 * `camera`'s own indirect texture installed, then roll back an upload that
 * would only re-send identical ids.
 */
export function runPerCamera(bm, fn, renderer, scene, camera, geometry, material, group) {
  if (ctl.off || _active === bm || !camera || !(bm.perObjectFrustumCulled || bm.sortObjects)) {
    stats.passthrough += 1;
    return fn.call(bm, renderer, scene, camera, geometry, material, group);
  }
  const live = bm._indirectTexture;
  if (!live || !live.image || !live.image.data || !live.source) {
    stats.passthrough += 1;
    return fn.call(bm, renderer, scene, camera, geometry, material, group);
  }
  let st = _state.get(bm);
  if (st === undefined) {
    st = { installed: live, lastCam: null, cams: [] };
    _state.set(bm, st);
  } else if (live !== st.installed) {
    _reset(st, live);
  }
  let e;
  try { e = _entryFor(st, camera); } catch (_) {
    stats.errors += 1;
    return fn.call(bm, renderer, scene, camera, geometry, material, group);
  }
  const tex = e.tex;
  bm._indirectTexture = tex;
  st.installed = tex;
  st.lastCam = camera;
  const v0 = tex.version;
  const sv0 = tex.source.version;
  stats.calls += 1;
  const prevActive = _active;
  _active = bm;
  let ret;
  try {
    ret = fn.call(bm, renderer, scene, camera, geometry, material, group);
  } finally {
    _active = prevActive;
  }
  try {
    if (bm._indirectTexture !== tex) return ret; // replaced mid-call: reset next time
    if (tex.version === v0) {
      stats.noWrite += 1;
      // Untouched ids are this camera's from its last write — unless something
      // else bumped the texture since (then the kept copy is no longer proof).
      if (e.verOut !== v0) e.prevN = -1;
      if (v0 === 0) tex.needsUpdate = true; // never let a never-uploaded texture draw
      return ret;
    }
    const n = bm._multiDrawCount | 0;
    const data = tex.image.data;
    if (e.prev !== null && e.prevN === n && e.verOut === v0 && e.srcVerOut === sv0
      && n <= data.length && _samePrefix(data, e.prev, n)) {
      tex.version = v0;
      tex.source.version = sv0;
      stats.skipped += 1;
      return ret;
    }
    if (e.prev === null || e.prev.length < data.length) e.prev = new data.constructor(data.length);
    e.prev.set(n <= data.length ? data.subarray(0, n) : data);
    e.prevN = n;
    e.verOut = tex.version;
    e.srcVerOut = tex.source.version;
    stats.uploads += 1;
  } catch (_) {
    stats.errors += 1;
    e.prevN = -1;
  }
  return ret;
}

/**
 * Wrap an own-property `onBeforeRender` override (static_batch_x's memo /
 * sphere paths) so it runs per camera too. Identity when the flag is off — or
 * when the prototype patch is not installed, because its `dispose` wrapper is
 * what frees the per-camera textures.
 */
export function wrapOnBeforeRenderPerCamera(fn) {
  if (!FLAG || typeof fn !== "function" || !THREE.BatchedMesh.prototype.__hbIndirectPerCam) return fn;
  return function (renderer, scene, camera, geometry, material, group) {
    return runPerCamera(this, fn, renderer, scene, camera, geometry, material, group);
  };
}

/** Free every per-camera texture three does not own for `bm`. */
export function releasePerCamera(bm) {
  const st = _state.get(bm);
  if (!st) return;
  const own = bm._indirectTexture;
  for (const e of st.cams) if (e.tex !== own) _dispose(e.tex);
  st.cams.length = 0;
  _state.delete(bm);
}

/**
 * Patch `THREE.BatchedMesh.prototype.onBeforeRender` + `dispose` once.
 * Returns true when installed (or already installed).
 */
export function installBatchedIndirectPerCamera(THREE_, { force = false } = {}) {
  if ((!FLAG && !force) || !THREE_?.BatchedMesh) return false;
  const proto = THREE_.BatchedMesh.prototype;
  if (proto.__hbIndirectPerCam) return true;
  const origOBR = proto.onBeforeRender;
  const origDispose = proto.dispose;
  proto.onBeforeRender = function (renderer, scene, camera, geometry, material, group) {
    return runPerCamera(this, origOBR, renderer, scene, camera, geometry, material, group);
  };
  proto.dispose = function () {
    try { releasePerCamera(this); } catch (_) { stats.errors += 1; }
    return origDispose.apply(this, arguments);
  };
  Object.defineProperty(proto, "__hbIndirectPerCam", { value: { origOBR, origDispose }, configurable: true });
  if (typeof window !== "undefined") {
    try {
      window.__bmIndirectPerCamera = {
        enabled: true,
        stats,
        get off() { return ctl.off; },
        // Turning it off mid-session is safe: every bucket keeps drawing from
        // whichever texture is installed, now rebuilt + uploaded every call.
        set off(v) { ctl.off = !!v; },
      };
    } catch (_) {}
  }
  return true;
}

/** Test hook: restore three's methods and the default seam state. */
export function uninstallBatchedIndirectPerCamera(THREE_) {
  const proto = THREE_?.BatchedMesh?.prototype;
  const saved = proto && proto.__hbIndirectPerCam;
  if (!saved) return;
  proto.onBeforeRender = saved.origOBR;
  proto.dispose = saved.origDispose;
  delete proto.__hbIndirectPerCam;
  ctl.off = false;
}

export function getBatchedIndirectPerCameraStats() {
  return { ...stats };
}

/** Test seam. */
export function __setBmIndirectPerCameraOffForTest(v) { ctl.off = !!v; }
