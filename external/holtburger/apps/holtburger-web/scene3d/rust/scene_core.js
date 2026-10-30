// scene3d/rust/scene_core.js — the JS side of the Rust scene core.
//
// Plan, contract and lane status: docs/2026-10-26-rust-scene-core.md.
// Kernels: crates/holtburger-scene (pure Rust, natively tested).
// wasm-bindgen wrappers: src/scene_wasm/ (one file per lane).
//
// What this module gives a lane bridge (scene3d/rust/<lane>.js):
//   - sceneWasmClass(name): a wasm class from the main pkg, or null when the
//     pkg is missing / stale (the ABI check below). A null means "use the JS
//     path", never an error.
//   - WasmF32View / WasmU32View: typed-array views on wasm memory that
//     re-create themselves when memory grows (growth detaches the old
//     ArrayBuffer and every view on it reads length 0) or when the Rust side
//     hands back a new pointer (a Vec reallocated).
//   - rustFlag(name, defaultOn): the lane's URL flag, read once.
//
// Rules for bridges:
//   - One wasm call per kernel per frame, plus add/remove calls when objects
//     come and go. Never a wasm call per object per frame.
//   - Read pointers/lengths AFTER the frame call, every frame: any call that
//     allocates in Rust may move a buffer or grow memory.
//   - Copy out of a view before the next wasm call, or re-fetch the view.

export const SCENE_CORE_ABI = 1;

let _ns = null;
let _memory = null;
let _resolved = false;
let _abiOk = false;
let _warned = false;

function _resolve() {
  if (_resolved) return;
  const g = typeof globalThis !== "undefined" ? globalThis : {};
  if (!_ns) _ns = g.__hbSceneWasm ?? null;
  if (!_memory) _memory = g.__hbWasmMemory ?? g.__hbSharedWasm?.memory ?? null;
  // Not booted yet (index.html sets __hbSceneWasm after wasm init) or no pkg:
  // stay unresolved and look again on the next call, so an early caller never
  // latches "no wasm" for the whole session. Only a namespace we can judge
  // (ABI present or not) is final.
  if (!_ns) return;
  _resolved = true;
  let abi = null;
  try { abi = typeof _ns?.sceneCoreAbi === "function" ? _ns.sceneCoreAbi() : null; } catch (_) { abi = null; }
  _abiOk = abi === SCENE_CORE_ABI && !!_memory;
  if (!_abiOk && !_warned && _ns) {
    _warned = true;
    // eslint-disable-next-line no-console
    console.warn(
      `[scene_core] Rust scene core unavailable (abi ${abi} vs ${SCENE_CORE_ABI}, memory ${!!_memory}); ` +
      "the JS paths stay in use. Rebuild pkg/ (wasm-pack) if this is unexpected.",
    );
  }
}

/** True when the pkg carries a scene core this file can drive. */
export function sceneCoreAvailable() {
  _resolve();
  return _abiOk;
}

/** A wasm class (e.g. "SceneParticles") from the main pkg, or null. */
export function sceneWasmClass(name) {
  _resolve();
  if (!_abiOk) return null;
  const c = _ns[name];
  return typeof c === "function" ? c : null;
}

/** The wasm `WebAssembly.Memory` (null when unavailable). */
export function sceneWasmMemory() {
  _resolve();
  return _abiOk ? _memory : null;
}

/**
 * Test seam: point the bridge at a namespace + memory (node tests import
 * pkg/holtburger_web.js and pass `init()`'s output `.memory`). `null` resets
 * to the window globals on next use.
 */
export function __setSceneWasmForTest(ns, memory) {
  _ns = ns ?? null;
  _memory = memory ?? null;
  _resolved = false;
  _abiOk = false;
  _warned = false;
}

class _WasmView {
  constructor(Ctor) {
    this._Ctor = Ctor;
    this._buf = null;
    this._ptr = -1;
    this._len = -1;
    this._view = null;
  }

  /** The view for (ptr, len) in elements; re-created only when needed. */
  get(ptr, len) {
    const mem = sceneWasmMemory();
    if (!mem) return null;
    const buf = mem.buffer;
    if (buf !== this._buf || ptr !== this._ptr || len !== this._len || this._view === null) {
      this._buf = buf;
      this._ptr = ptr;
      this._len = len;
      this._view = len > 0 ? new this._Ctor(buf, ptr, len) : new this._Ctor(0);
    }
    return this._view;
  }
}

/** Float32Array view on wasm memory: `new WasmF32View().get(ptr, len)`. */
export class WasmF32View extends _WasmView {
  constructor() { super(Float32Array); }
}

/** Uint32Array view on wasm memory. */
export class WasmU32View extends _WasmView {
  constructor() { super(Uint32Array); }
}

/** Float64Array view on wasm memory (inputs such as camera matrices). */
export class WasmF64View extends _WasmView {
  constructor() { super(Float64Array); }
}

const _flagMemo = new Map();
const _flagOverride = new Map();

/**
 * A lane's URL flag, read once. `defaultOn` is the lane's shipped default.
 * Off spellings: off / 0 / false / no. On spellings: on / 1 / true / yes.
 * Anything else (or absent) reads the default.
 */
export function rustFlag(name, defaultOn = false) {
  if (_flagOverride.has(name)) return _flagOverride.get(name);
  if (_flagMemo.has(name)) return _flagMemo.get(name);
  let on = !!defaultOn;
  try {
    const search = globalThis.location?.search;
    if (search) {
      const v = (new URLSearchParams(search).get(name) ?? "").trim().toLowerCase();
      if (v === "off" || v === "0" || v === "false" || v === "no") on = false;
      else if (v === "on" || v === "1" || v === "true" || v === "yes") on = true;
    }
  } catch (_) { on = !!defaultOn; }
  _flagMemo.set(name, on);
  return on;
}

/** Test seam: force a flag (`undefined` clears the override and the memo). */
export function __setRustFlagForTest(name, on) {
  _flagMemo.delete(name);
  if (on === undefined) _flagOverride.delete(name);
  else _flagOverride.set(name, !!on);
}
