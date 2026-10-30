// scene3d/rust/rig.js — lane B bridge: rig part poses from Rust (`?rustRig`,
// DEFAULT ON since 2026-10-26; `=off` escape).
//
// Lane notes (the cut and the measurements behind it, the reader/writer audit,
// the ordering findings): docs/2026-10-26-rust-rig.md. Kernel:
// crates/holtburger-scene/src/rig.rs. wasm glue: src/scene_wasm/rig.rs
// (`SceneRigs`).
//
// WHAT IT REPLACES. `poseRigAt` (motion/motion_sequence.js) writes every part
// Group's position + quaternion with `.set()`. Each `quaternion.set()` fires
// three's onQuaternionChange → `rotation.setFromQuaternion` (a compose into a
// scratch matrix, an asin and two atan2 per part) — ~40% of poseRigAt on the
// 1070 profiles. Under the flag poseRigAt hands the rig to `rustPoseRig`:
//   1. ONE wasm call per posed entity (`SceneRigs.pose`) computes every part's
//      position and quaternion — the exact poseRigAt arithmetic (raw /
//      in place by mean drift / in place exact), f64 throughout;
//   2. JS writes them into `position.x/y/z` and the quaternion's raw
//      `_x/_y/_z/_w` (no onChange → no Euler re-derivation).
// three's scene walk then composes and multiplies the part matrices exactly
// as on the flag-off path, from bit-identical position / quaternion / scale.
//
// WHY NOT THE LOCAL MATRIX TOO (measured, lane doc "Measurements"): writing the
// 16 matrix elements from Rust output and skipping three's compose made the
// pose + walk SLOWER than letting three compose (the matrix array is written
// once per frame either way; the compose arithmetic is the cheap part). The
// kernel keeps a parity-pinned `poseMatrices` for the stages that move the
// matrices themselves out of three.
//
// WHAT CHANGES: `part.rotation` (the Euler) of a Rust-posed part is NOT
// re-derived — that is the cost removed. Nothing in the app reads or writes a
// rig part's Euler (audit in the lane doc); any later quaternion write by
// other code re-syncs it through three's own callback, and a full
// `rotation.set(x, y, z)` replaces it. (A PARTIAL Euler write — `rotation.x =
// …` — would combine with the stale angles; there is none.)
//
// Anything the kernel cannot take returns false and poseRigAt runs its JS
// body unchanged: no pkg / stale pkg (sceneWasmClass → null), a descriptor
// whose buffers are not Float32Array or whose counts do not match. A part
// that is not a three.js Object3D (test stubs) is written through its
// setters, as poseRigAt does.

import { sceneWasmClass, sceneCoreAvailable, WasmF64View, rustFlag } from "./scene_core.js";

/** f64 per posed part in the `SceneRigs.pose` output: px py pz qx qy qz qw. */
export const RIG_POSE_STRIDE = 7;

const EMPTY_F32 = new Float32Array(0);
// Soft cap on the f32 values copied into Rust (≈32 MB of wasm memory). Past
// it, the least recently posed descriptors are dropped and simply re-register
// on their next use. Descriptors normally leave through the
// FinalizationRegistry when animation.js's cache lets them go.
const DEFAULT_MAX_FLOATS = 8 * 1024 * 1024;
let MAX_FLOATS = DEFAULT_MAX_FLOATS;

let _flag = null;
/** `?rustRig` (read once; `__setRustRigForTest` overrides). */
export function rustRigEnabled() {
  if (_flag === null) _flag = rustFlag("rustRig", true);
  return _flag;
}

let _rigs = null; // SceneRigs instance; false = unavailable this session
let _outPtr = 0;
let _outLen = 0;
const _outView = new WasmF64View();
let _recs = new WeakMap(); // descriptor → registration record
const _byId = new Map(); // id → record (eviction + finalizer bookkeeping)
let _floats = 0;
let _finalizer = null;
let _poseSeq = 0; // recency stamp for the cap's LRU

const _stats = {
  rigsPosed: 0, // poseRigAt calls the kernel took
  partsRaw: 0, // parts written through the raw fields (no Euler sync)
  partsSetter: 0, // parts written through the setters (not a three.js part)
  jsFallbacks: 0, // poseRigAt calls left to the JS body
  registered: 0,
  rejected: 0, // descriptors the kernel refused (kept on the JS path)
  unregistered: 0,
  evicted: 0,
};

/** Diag snapshot (`window.__rustRig.stats()`). */
export function rustRigStats() {
  return {
    enabled: rustRigEnabled(),
    available: !!_rigs,
    descriptors: _byId.size,
    floats: _floats,
    ..._stats,
  };
}

function _initRigs() {
  // Before boot has published the wasm namespace, ask again on the next pose
  // instead of latching "unavailable" for the session.
  if (!sceneCoreAvailable()) return null;
  let rigs = false;
  try {
    const C = sceneWasmClass("SceneRigs");
    if (C) rigs = new C();
  } catch (_) {
    rigs = false;
  }
  _rigs = rigs;
  if (rigs) {
    _outPtr = rigs.outPtr() >>> 0;
    _outLen = rigs.outLen() >>> 0;
    if (typeof FinalizationRegistry === "function") {
      _finalizer = new FinalizationRegistry(_onCollected);
    }
    if (typeof window !== "undefined" && window && !window.__rustRig) {
      try {
        window.__rustRig = { stats: rustRigStats };
      } catch (_) { /* diag only */ }
    }
  }
  return rigs || null;
}

function _onCollected(rec) {
  if (_byId.get(rec.id) !== rec) return; // already evicted / replaced
  _drop(rec);
  _stats.unregistered += 1;
}

function _drop(rec) {
  _byId.delete(rec.id);
  _floats -= rec.floats;
  try {
    if (_rigs) _rigs.unregister(rec.id);
  } catch (_) { /* freed with the instance */ }
  rec.id = 0;
}

// Over the cap: drop the least recently posed descriptors (never `keep`, the
// one being registered) until back under 3/4 of it.
function _evict(keep) {
  const list = [];
  for (const rec of _byId.values()) if (rec !== keep) list.push(rec);
  list.sort((a, b) => a.last - b.last);
  for (const rec of list) {
    if (_floats <= MAX_FLOATS * 0.75) break;
    if (_finalizer) _finalizer.unregister(rec);
    const d = rec.ref ? rec.ref.deref() : undefined;
    _drop(rec);
    if (d && _recs.get(d) === rec) _recs.delete(d); // re-registers on next use
    _stats.evicted += 1;
  }
}

// Register `desc` (or re-register it when its buffers changed). Returns the
// record; `rec.id === 0` keeps the descriptor on the JS path.
function _register(rigs, desc, old) {
  if (old && old.id) {
    if (_finalizer) _finalizer.unregister(old);
    _drop(old);
  }
  const pf = desc.partFrames;
  const pos = desc.posFrames;
  const rf = desc.rootFrames;
  const pc = desc.partCount;
  const nf = desc.numFrames;
  const rec = {
    id: 0, pf, pos, rf, pc, nf, floats: 0, last: ++_poseSeq,
    ref: typeof WeakRef === "function" ? new WeakRef(desc) : null,
  };
  _recs.set(desc, rec);
  // The production shape only: Float32Array buffers (exactly the f32 values
  // poseRigAt reads) and positive integer counts that match them. Anything
  // else stays on the JS path, whose behaviour then cannot differ.
  const hasPos = !!pos; // poseRigAt: `posFrames ? posFrames[i] : 0`
  // poseInPlaceExact's gate; a rootFrames of any other length poses by mean
  // drift there, which registering without it reproduces.
  const hasRoot = !!rf && rf.length === nf * 7;
  if (
    !(pf instanceof Float32Array) ||
    !Number.isInteger(pc) || pc <= 0 || pc > 0xffffffff ||
    !Number.isInteger(nf) || nf <= 0 || nf > 0xffffffff ||
    pf.length !== nf * pc * 7 ||
    (hasPos && !(pos instanceof Float32Array)) ||
    (hasRoot && !(rf instanceof Float32Array))
  ) {
    _stats.rejected += 1;
    return rec;
  }
  let id = 0;
  try {
    id = rigs.registerDescriptor(pc, nf, pf, hasPos ? pos : EMPTY_F32, hasPos, hasRoot ? rf : EMPTY_F32, hasRoot) >>> 0;
    // The only call that can move the output buffer.
    _outPtr = rigs.outPtr() >>> 0;
    _outLen = rigs.outLen() >>> 0;
  } catch (_) {
    id = 0;
  }
  if (!id) {
    _stats.rejected += 1;
    return rec;
  }
  rec.id = id;
  rec.floats = pf.length + (hasPos ? pos.length : 0) + (hasRoot ? rf.length : 0) + nf * 3;
  _byId.set(id, rec);
  _floats += rec.floats;
  _stats.registered += 1;
  if (_finalizer) _finalizer.register(desc, rec, rec);
  if (_floats > MAX_FLOATS) _evict(rec);
  return rec;
}

/**
 * The Rust half of `poseRigAt`. `f` is poseRigAt's frame (already `| 0` and
 * clamped), `mode` 0 raw / 1 in place by mean drift / 2 in place exact (the
 * kernel falls back to 1 without valid root frames, like poseInPlaceExact),
 * `n` = Math.min(partCount, partGroups.length). Returns false — nothing
 * written — when the kernel cannot take this rig; poseRigAt then runs its JS
 * body.
 */
export function rustPoseRig(desc, f, mode, partGroups, n) {
  const rigs = _rigs === null ? _initRigs() : _rigs;
  if (!rigs) return false;
  let rec = _recs.get(desc);
  if (
    rec === undefined || rec.pf !== desc.partFrames || rec.pos !== desc.posFrames ||
    rec.rf !== desc.rootFrames || rec.pc !== desc.partCount || rec.nf !== desc.numFrames
  ) {
    rec = _register(rigs, desc, rec);
  }
  if (rec.id === 0 || !(n >= 0)) {
    _stats.jsFallbacks += 1;
    return false;
  }
  let k = -1;
  try {
    k = rigs.pose(rec.id, f >>> 0, mode >>> 0, n >>> 0);
  } catch (_) {
    k = -1;
  }
  if (k !== n) {
    _stats.jsFallbacks += 1;
    return false;
  }
  rec.last = ++_poseSeq;
  if (n === 0) {
    _stats.rigsPosed += 1;
    return true;
  }
  const out = _outView.get(_outPtr, _outLen);
  if (!out || out.length < n * RIG_POSE_STRIDE) {
    _stats.jsFallbacks += 1;
    return false;
  }
  for (let p = 0, o = 0; p < n; p += 1, o += RIG_POSE_STRIDE) {
    const g = partGroups[p];
    if (!g) continue;
    const q = g.quaternion;
    if (g.isObject3D === true && q && q.isQuaternion === true) {
      // What position.set + quaternion.set store, minus the onChange.
      const pos = g.position;
      pos.x = out[o];
      pos.y = out[o + 1];
      pos.z = out[o + 2];
      q._x = out[o + 3];
      q._y = out[o + 4];
      q._z = out[o + 5];
      q._w = out[o + 6];
      _stats.partsRaw += 1;
    } else {
      // Exactly poseRigAt's writes (same values, same order, same setters).
      if (g.position && typeof g.position.set === "function") g.position.set(out[o], out[o + 1], out[o + 2]);
      if (q && typeof q.set === "function") q.set(out[o + 3], out[o + 4], out[o + 5], out[o + 6]);
      _stats.partsSetter += 1;
    }
  }
  _stats.rigsPosed += 1;
  return true;
}

/** Test seam: force the flag (`undefined` re-reads `rustFlag`). */
export function __setRustRigForTest(on) {
  _flag = on === undefined ? null : !!on;
}

/**
 * Test seam: forget the SceneRigs instance and every registration (call after
 * scene_core's `__setSceneWasmForTest`).
 */
export function __resetRustRigForTest() {
  _rigs = null;
  _outPtr = 0;
  _outLen = 0;
  _recs = new WeakMap();
  _byId.clear();
  _floats = 0;
  _finalizer = null;
  for (const k of Object.keys(_stats)) _stats[k] = 0;
}

/** Test seam: the descriptor float cap (`undefined` restores the default). */
export function __setRigFloatCapForTest(n) {
  MAX_FLOATS = n === undefined ? DEFAULT_MAX_FLOATS : n;
}
