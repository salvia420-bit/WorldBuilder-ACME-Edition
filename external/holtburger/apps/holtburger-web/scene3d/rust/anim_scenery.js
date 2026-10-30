// scene3d/rust/anim_scenery.js — lane D bridge: the per-DID template pose of
// the DAT-animated scenery from Rust (`?rustAnimScenery`, DEFAULT ON since 2026-10-26; `=off`
// escape).
//
// Lane notes (the cut, the measurements, what stays in JS and why):
// docs/2026-10-26-rust-anim-terrain.md. Kernel:
// crates/holtburger-scene/src/anim_scenery.rs. wasm glue:
// src/scene_wasm/anim_scenery.rs (`SceneAnimScenery`).
//
// WHAT IT REPLACES. Every frame animated_scenery.js advances one three.js
// AnimationMixer per animation DID ("group"), its SetOmega orbit, and (with
// ?animSceneryGpu, default on) writes one pose-texture row per (DID, part).
// Under the flag ONE wasm call (`SceneAnimScenery.advance`) does all three:
// the mixer arithmetic of three r184 (action time + LoopRepeat wrap, the
// interpolant seek, lerp / slerpFlat, the PropertyMixer accu interleave), the
// orbit, and the rows (compose, × post, the orbit rotation, f32 store). JS
// then:
//   - writes each group's template parts back (`position.x/y/z` and the
//     quaternion's raw `_x.._w`, no onChange → no Euler re-derivation) and
//     its `orbitQ` / `orbitAngle`, so everything that still reads the
//     template — CPU-posed slots (`?animSceneryGpu=off`), legacy per-mesh
//     instances, wind trees — sees bit-identical values;
//   - copies the rows the kernel wrote into anim_scenery_gpu.js's table.
// A group the kernel does not hold (no pkg / stale pkg / a refused clip) keeps
// its mixer, and its rows are written by the JS code as before.
//
// WHAT CHANGES: the template parts' `rotation` (Euler) is not re-derived, and
// the groups' AnimationMixer objects are no longer advanced (their `time`
// stays 0; `animatedSceneryDiag().maxMixerTime` reads the kernel's). Nothing
// reads either (lane notes, reader audit).

import { sceneWasmClass, sceneWasmMemory, WasmF32View, WasmF64View, rustFlag } from "./scene_core.js";

/** f64 per template part in the parts output: px py pz qx qy qz qw. */
export const ANIM_PART_STRIDE = 7;
/** f64 per group slot: orbit qx qy qz qw, orbit angle, mixer time, action time. */
export const ANIM_GROUP_STRIDE = 7;
/** f32 per pose-table row (anim_scenery_gpu.js POSE_TEXELS_PER_ROW * 4). */
export const ANIM_ROW_FLOATS = 32;

let _flag = null;
/** `?rustAnimScenery` (read once; `__setRustAnimSceneryForTest` overrides). */
export function rustAnimSceneryEnabled() {
  if (_flag === null) _flag = rustFlag("rustAnimScenery", true);
  return _flag;
}

let _k = null; // SceneAnimScenery; false = unavailable this session
let _rowsRegistered = 0;
let _rowsOk = true;
let _broken = false;
const _partsView = new WasmF64View();
const _groupView = new WasmF64View();
const _rowsView = new WasmF32View();
let _rowsWrittenView = null; // Uint8Array view (re-made like the others)
let _rwBuf = null;
let _rwPtr = -1;
let _rwLen = -1;
// Views of the current frame (valid until the next call into the kernel).
let _parts = null;
let _group = null;
let _rows = null;
let _written = null;

const _stats = {
  groupsRegistered: 0,
  groupsRejected: 0,
  groupsUnregistered: 0,
  rowsRegistered: 0,
  advances: 0,
  rowsWritten: 0,
  failures: 0,
};

/** Diag snapshot (`window.__rustAnimScenery.stats()`). */
export function rustAnimSceneryStats() {
  return {
    enabled: rustAnimSceneryEnabled(),
    available: !!_k,
    broken: _broken,
    rowsInLockstep: _rowsOk,
    groups: _k ? _k.groupCount : 0,
    rows: _k ? _k.rowCount : 0,
    ..._stats,
  };
}

function _kernel() {
  if (_k !== null) return _k || null;
  // No class yet (asked before boot published the wasm, or no / stale pkg):
  // stay unresolved and look again on the next registration. Only a class
  // that throws on construction is given up on for the session.
  const C = sceneWasmClass("SceneAnimScenery");
  if (!C) return null;
  let k = false;
  try {
    k = new C();
  } catch (_) {
    k = false;
  }
  _k = k;
  if (k && typeof window !== "undefined" && window && !window.__rustAnimScenery) {
    try { window.__rustAnimScenery = { stats: rustAnimSceneryStats }; } catch (_) { /* diag only */ }
  }
  return k || null;
}

function _u8View(ptr, len) {
  const mem = sceneWasmMemory();
  if (!mem) return null;
  const buf = mem.buffer;
  if (_rowsWrittenView === null || buf !== _rwBuf || ptr !== _rwPtr || len !== _rwLen) {
    _rwBuf = buf;
    _rwPtr = ptr;
    _rwLen = len;
    _rowsWrittenView = len > 0 ? new Uint8Array(buf, ptr, len) : new Uint8Array(0);
  }
  return _rowsWrittenView;
}

// Output pointers / lengths. Only a registration or a clear can reallocate a
// kernel buffer (advance never resizes), so they are re-read after those
// calls; the views themselves re-check memory growth on every get().
const _ptr = { parts: 0, partsLen: 0, group: 0, groupLen: 0, rows: 0, rowsLen: 0, written: 0, writtenLen: 0 };
let _ptrsDirty = true;
function _readPtrs(k) {
  _ptr.parts = k.partsPtr() >>> 0; _ptr.partsLen = k.partsLen() >>> 0;
  _ptr.group = k.groupPtr() >>> 0; _ptr.groupLen = k.groupLen() >>> 0;
  _ptr.rows = k.rowsPtr() >>> 0; _ptr.rowsLen = k.rowsLen() >>> 0;
  _ptr.written = k.rowsWrittenPtr() >>> 0; _ptr.writtenLen = k.rowsWrittenLen() >>> 0;
  _ptrsDirty = false;
}
function _refreshViews(k) {
  if (_ptrsDirty) _readPtrs(k);
  _parts = _partsView.get(_ptr.parts, _ptr.partsLen);
  _group = _groupView.get(_ptr.group, _ptr.groupLen);
  _rows = _rowsView.get(_ptr.rows, _ptr.rowsLen);
  _written = _u8View(_ptr.written, _ptr.writtenLen);
}

/**
 * Hand a freshly built group (animated_scenery.js getOrCreateDidGroup /
 * getOrCreateWindGroup, after `action.play()`) to the kernel: the same inputs
 * buildSceneryAnimationClip got. Sets `group._rust` and returns true, or
 * leaves the group on its mixer and returns false.
 */
export function rustAnimRegisterGroup(group, key, frames, numParts, numFrames, fps, closedLoop) {
  if (_broken || !rustAnimSceneryEnabled()) return false;
  const k = _kernel();
  if (!k) return false;
  const np = numParts | 0;
  const nf = numFrames | 0;
  if (!(np > 0) || !(nf > 0) || !frames || !(frames.length >= np * nf * 7)) {
    _stats.groupsRejected += 1;
    return false;
  }
  // The clip builder stores every value into Float32Arrays; Float32Array.from
  // rounds a non-f32 source the same way.
  const f32 = frames instanceof Float32Array ? frames : Float32Array.from(frames);
  const om = group.omega || null;
  let h = 0;
  try {
    h = k.registerGroup(
      key >>> 0, f32, np, nf, Number(fps), closedLoop !== false,
      !!om, om ? om.axis.x : 0, om ? om.axis.y : 0, om ? om.axis.z : 0, om ? om.rad : 0,
    ) >>> 0;
  } catch (_) {
    h = 0;
  }
  if (!h) {
    _stats.groupsRejected += 1;
    return false;
  }
  let partsOff = 0xffffffff;
  let slot = 0xffffffff;
  try {
    partsOff = k.partsOffset(h) >>> 0;
    slot = k.slotOf(h) >>> 0;
  } catch (_) { /* below */ }
  if (partsOff === 0xffffffff || slot === 0xffffffff) {
    try { k.unregisterGroup(h); } catch (_) {}
    _stats.groupsRejected += 1;
    return false;
  }
  _ptrsDirty = true;
  // mixerTime / actionTime: the group's clocks as of the last successful
  // advance (rustAnimWriteBack copies them while the view is fresh; a group
  // never advanced is at 0, like its untouched mixer).
  group._rust = { handle: h, partsOff, slot, numParts: np, mixerTime: 0, actionTime: 0 };
  _stats.groupsRegistered += 1;
  return true;
}

/** The group left `_didGroups` (refCount 0 / dispose). */
export function rustAnimUnregisterGroup(group) {
  const r = group && group._rust;
  if (!r) return;
  group._rust = null;
  _stats.groupsUnregistered += 1;
  if (!_k) return;
  _ptrsDirty = true;
  try { _k.unregisterGroup(r.handle); } catch (_) { /* freed with the instance */ }
}

/**
 * anim_scenery_gpu.js poseRowFor allocated table row `row` (1-based, in
 * order). Keeps the kernel's rows in lockstep with the table; any gap (no
 * kernel at that moment, a throw) turns the kernel's rows off for the
 * session — every row is then written by the JS code, as before.
 */
export function rustAnimRegisterRow(row, animId, partIdx, initMat, post) {
  if (!rustAnimSceneryEnabled()) return false;
  if (!_rowsOk) return false;
  const k = _broken ? null : _kernel();
  if (!k || row !== _rowsRegistered + 1) {
    _rowsOk = false;
    return false;
  }
  const key = typeof animId === "number" ? animId >>> 0 : 0;
  let idx = -1;
  try {
    idx = k.registerRow(
      key, partIdx >>> 0,
      post ? Float64Array.from(post.elements) : new Float64Array(0),
      initMat ? Float64Array.from(initMat.elements) : new Float64Array(0),
    );
  } catch (_) {
    idx = -1;
  }
  _ptrsDirty = true;
  if (idx !== row - 1) {
    _rowsOk = false;
    return false;
  }
  _rowsRegistered = row;
  _stats.rowsRegistered += 1;
  return true;
}

/** disposeAnimSceneryGpu: the table and its rows are gone. */
export function rustAnimClearRows() {
  _rowsRegistered = 0;
  _rowsOk = true;
  _ptrsDirty = true;
  if (!_k) return;
  try { _k.clearRows(); } catch (_) { /* freed */ }
}

/** True while the kernel's rows match the table row for row. */
export function rustAnimRowsOk() {
  return _rowsOk && !_broken && !!_k;
}

/**
 * ONE call per frame: advance every kernel-held group and write every row.
 * Returns false (nothing advanced) when there is no kernel or it failed —
 * the caller then hands the groups back to their mixers
 * (`rustAnimFallback`).
 */
export function rustAnimAdvance(dt, omegaHz) {
  const k = _broken ? null : _k;
  if (!k) return false;
  let n = 0;
  try {
    n = k.advance(dt, omegaHz) >>> 0;
    _refreshViews(k);
  } catch (_) {
    _broken = true;
    _stats.failures += 1;
    return false;
  }
  if (!_parts || !_group || !_rows || !_written) {
    _broken = true;
    _stats.failures += 1;
    return false;
  }
  _stats.advances += 1;
  _stats.rowsWritten += n;
  return true;
}

/** After rustAnimAdvance: write the group's template parts + orbit back. */
export function rustAnimWriteBack(g) {
  const r = g._rust;
  const parts = _parts;
  const n = Math.min(g.parts.length, r.numParts);
  for (let j = 0, o = r.partsOff; j < n; j += 1, o += ANIM_PART_STRIDE) {
    const part = g.parts[j];
    const p = part.position;
    p.x = parts[o];
    p.y = parts[o + 1];
    p.z = parts[o + 2];
    // What PropertyBinding's quaternion.fromArray stores, minus the onChange.
    const q = part.quaternion;
    q._x = parts[o + 3];
    q._y = parts[o + 4];
    q._z = parts[o + 5];
    q._w = parts[o + 6];
  }
  const go = r.slot * ANIM_GROUP_STRIDE;
  const gv = _group;
  // Snapshot the clocks now: rustAnimFallback / rustAnimMixerTime must never
  // read wasm memory later (a grown memory detaches the view; a registration
  // can move the group buffer).
  r.mixerTime = gv[go + 5];
  r.actionTime = gv[go + 6];
  if (g.omega) {
    g.orbitQ.set(gv[go], gv[go + 1], gv[go + 2], gv[go + 3]);
    g.orbitAngle = gv[go + 4];
  }
}

/** After rustAnimAdvance: did the kernel write row index `i` (table row i + 1)? */
export function rustAnimRowWritten(i) {
  return _written !== null && _written[i] === 1;
}

/** The current frame's f32 rows (row index i at i * ANIM_ROW_FLOATS). */
export function rustAnimRows() {
  return _rows;
}

/** The kernel's mixer time for a group (diag; the last advance's snapshot). */
export function rustAnimMixerTime(g) {
  const r = g && g._rust;
  if (!r) return 0;
  return Number.isFinite(r.mixerTime) ? r.mixerTime : 0;
}

// three r184 PropertyMixer.apply writes a binding only when its two accu
// buffers differ. A mixer the kernel stood in for still holds the accus of
// its creation (the pre-play pose), so its first update could skip a part
// whose new pose happens to equal that pose and leave the kernel's last one
// in the template. Poison the accu the next update compares against: that
// update then writes every part — exactly what an always-running mixer
// leaves (the new value, or the same value again).
function _poisonAccu(mixer) {
  const binds = mixer && mixer._bindings;
  if (!Array.isArray(binds)) return;
  const ai = mixer._accuIndex | 0; // the next update writes accu[ai ^ 1] and compares it with accu[ai]
  for (const b of binds) {
    const buf = b && b.buffer;
    const st = b && b.valueSize;
    if (!buf || !(st > 0) || typeof buf.fill !== "function") continue;
    const off = ai * st + st;
    buf.fill(NaN, off, off + st);
  }
}

/**
 * The kernel failed mid-session: give every group back to its mixer, with the
 * mixer and action clocks moved to where the kernel had them at its last
 * successful advance (snapshots — no wasm memory is read here; the template
 * parts already hold that advance's pose). Then the JS path runs as before.
 */
export function rustAnimFallback(groups) {
  for (const g of groups) {
    const r = g && g._rust;
    if (!r) continue;
    try {
      if (g.mixer && Number.isFinite(r.mixerTime)) g.mixer.time = r.mixerTime;
      // The interpolants' cached index is only a seek hint; with the action
      // time and the poisoned accus the mixer continues the clip exactly where
      // the kernel left it.
      if (g._action && Number.isFinite(r.actionTime)) g._action.time = r.actionTime;
      _poisonAccu(g.mixer);
    } catch (_) { /* best effort */ }
    g._rust = null;
  }
}

/** disposeAnimatedScenery: every group and row gone. */
export function rustAnimReset() {
  _rowsRegistered = 0;
  _rowsOk = true;
  _parts = _group = _rows = _written = null;
  _ptrsDirty = true;
  if (!_k) return;
  try { _k.clear(); } catch (_) { /* freed */ }
}

/** Test seam: force the flag (`undefined` re-reads `rustFlag`). */
export function __setRustAnimSceneryForTest(on) {
  _flag = on === undefined ? null : !!on;
}

/** Test seam: forget the kernel and all state (after `__setSceneWasmForTest`). */
export function __resetRustAnimSceneryForTest() {
  _k = null;
  _rowsRegistered = 0;
  _rowsOk = true;
  _broken = false;
  _parts = _group = _rows = _written = null;
  _ptrsDirty = true;
  _rowsWrittenView = null;
  _rwBuf = null;
  _rwPtr = -1;
  _rwLen = -1;
  for (const key of Object.keys(_stats)) _stats[key] = 0;
}
