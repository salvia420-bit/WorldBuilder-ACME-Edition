// scene3d/terrain_shared_uniforms.js — `?hotTerrainShared` (DEFAULT OFF; lane F2,
// 2026-10-26, docs/2026-10-26-rust-hotspots-2.md §G1).
//
// WHAT. Four per-frame pushes write ONE frame-constant value into every terrain
// material's own `{value}` object, over the 500+ materials of the terrain
// registry (per-LB ShaderMaterials + the terrain_batch material), memory-latency
// bound:
//   loop.js       tickTerrainUTime          uTime, uCrackGlowBreath
//   loop.js       tickTerrainSunDir         uSunDir (+ the epoch-guarded Gouraud loop)
//   cloud_volume  _pushCloudShadowsToTerrain uCloudShadowEnabled / Map / Matrix0 / Strength
//   (ibl_environment.js tick — uIblEnabled / uEnvCube / uEnvIntensity — has a pusher
//    here too, `sharedPushIbl`, wired only when its owner adds the 3-line call.)
// Under the flag each such uniform has ONE shared `{value}` object (a slot). A
// registry material is RE-POINTED at the slot lazily — at the first push that
// writes the uniform after the material joined the registry — and re-pointed
// back to a frozen private `{value}` copy at the first push after it left. A push
// is then: one pointer compare of the registry against its last view, one write
// to the slot, and the per-material writes of the few materials that cannot be
// shared (none in the field). When the registry moved, one ordered diff per
// pusher (Pusher.observe) gives the leavers and joiners, and each group touches
// only those (a group more than one diff step behind re-walks everything); the
// Gouraud epoch walk of tickTerrainSunDir likewise visits only the joiners when
// the light epoch did not move (every survivor already carries the epoch).
// Node, 541 materials, the three pushes: ~124 -> ~5 us/frame steady, ~98 -> ~31 us
// on a frame whose registry moved (tests/hot_terrain_shared.test.mjs --bench).
//
// EXACTNESS (the invariant). three r184 reads `material.uniforms[name].value`
// when it uploads (WebGLUniforms.upload reads `values[u.id]` at every refresh;
// terrain ShaderMaterials have no onBeforeCompile, so three's uniform map IS
// `material.uniforms` — WebGLRenderer.getProgram `materialProperties.uniforms =
// parameters.uniforms = material.uniforms`). The invariant kept here: AT EVERY
// MOMENT, every material's value equals the value the shipped loops would have
// left in its own object.
//   - Bound only at a push that writes the uniform, to materials in the registry
//     at that push, whose post-push value under the shipped rule equals the
//     slot's post-push value under the same rule (`=` / `.set` / `.copy`: always;
//     `if (v !== X) v = X` on a number: Object.is of the two results, which can
//     only differ in the sign of a zero). The slot write then gives them exactly
//     that value.
//   - A material that leaves the registry keeps the slot until the next push of
//     its pusher, which re-points it at a private copy of the slot's value BEFORE
//     writing the slot: it keeps the last value it was pushed, as it does today.
//   - A material that joins keeps its own object (its seed / stale value, as
//     today) until the next push that writes the uniform binds it.
//   - Nothing else writes these uniforms (audit below). A writer outside the
//     pusher must first `unbindAll` its slot (cloud_volume's
//     `__setCloudShadowStrength` does).
//   - Anything a shipped loop would throw on (a missing uniform its loop assumes,
//     a frozen object, a value whose set/copy is not three's) is a HAZARD: the
//     whole pusher is unbound and the caller runs its shipped loop, so the
//     partial writes before the throw are the shipped ones.
//
// AUDIT (2026-10-26, every writer / reader / cloner of these uniforms):
//   writers  — the four pushers above; cloud_volume `__setCloudShadowStrength`
//              (handled: unbinds first). Seeds: terrain.js material literal
//              (uTime = sharedTerrainTimeSec, uSunDir literal, cloud set,
//              Gouraud set), terrain_batch `_buildBatchMaterial` (key-by-key
//              VALUE clones: fresh `{value}` objects; only TERRAIN_FX_LIGHT_UNIFORMS
//              are shared by identity). No other code assigns `.value` of these
//              names on registry materials, mutates their values in place, or
//              replaces their `{value}` objects (rg over scene3d/, plugins/,
//              index.html, tools/; the VFX `shader.uniforms.uTime = g.uTime`
//              hooks are on MaterialCache materials, never terrain).
//   readers  — far_terrain publishFarUniforms (copies uSunDir / Gouraud by
//              value from the first registry member), far_terrain ensureBakeRig
//              (`src.clone()` → three cloneUniforms deep-copies values),
//              terrain_snow / terrain_dirt / terrain_sand light copies (by
//              value), cloud_night diag (`[0].uniforms` values), film tools
//              (values). All read `.value` through the material's map, so they
//              see the invariant's values.
//   per-material values that differ — uLbOriginXy, uVertexTypes, uMergeData,
//              uTexMergeEnabled, uAcGouraudEnabled, uBakeAlbedo, uPaintLight.xyz
//              (opts-derived): NOT slots. uPaintLight.w and the rest of the
//              Gouraud set stay per-material writes; only their per-frame epoch
//              guard walk is skipped when provably a no-op (sharedPushTerrainSun).
//   cloners  — terrain_batch (by value), far_terrain (three clone). No shallow
//              copy of a terrain uniform map anywhere (`...x.uniforms`,
//              Object.assign, UniformsUtils.merge: none).
//
// NOT HANDLED (documented limits): a Proxy uniform object or a `uniforms` getter
// (reads would happen fewer times); a uniform object replaced or a uniform added
// to a registry material by future code between registry changes (caught by
// `verifySharedTerrain()`); a uniform value aliased with ANOTHER uniform of the
// same material (terrain.js builds every value with its own `new`).

import * as THREE from "three";
import { rustFlag } from "./rust/scene_core.js";

let _flag;
/** `?hotTerrainShared` — DEFAULT OFF (lane F2, 2026-10-26). Read once. */
export function hotTerrainSharedEnabled() {
  if (_flag === undefined) _flag = rustFlag("hotTerrainShared", false);
  return _flag;
}
/** Test seam (`undefined` re-reads the URL flag). */
export function __setHotTerrainSharedForTest(on) {
  _flag = on === undefined ? undefined : !!on;
}

const SKIP = 0, BIND = 1, PRIV = 2, HAZ = 3;
const OP = Object.prototype;
const V3P = THREE.Vector3.prototype;
const V4P = THREE.Vector4.prototype;
const M4P = THREE.Matrix4.prototype;
const CP = THREE.Color.prototype;

function _isObj(x) {
  return x !== null && (typeof x === "object" || typeof x === "function");
}
// Own data property `k` that an assignment can write without throwing or
// calling anything (strict mode: a non-writable one throws, an accessor runs).
function _writableData(o, k) {
  if (!_isObj(o)) return false;
  const d = Object.getOwnPropertyDescriptor(o, k);
  return d !== undefined && d.writable === true;
}
// Own property names exactly `keys` (any order), each a writable, enumerable data
// property, no symbols, prototype `proto`.
function _plainShape(o, proto, keys) {
  if (!_isObj(o) || Object.getPrototypeOf(o) !== proto) return false;
  const own = Object.getOwnPropertyNames(o);
  if (own.length !== keys.length || Object.getOwnPropertySymbols(o).length !== 0) return false;
  for (let i = 0; i < keys.length; i++) {
    const d = Object.getOwnPropertyDescriptor(o, keys[i]);
    if (d === undefined || d.writable !== true || d.enumerable !== true) return false;
  }
  return true;
}
const _K_VALUE = ["value"];
const _K_XYZ = ["x", "y", "z"];
const _K_XYZW = ["x", "y", "z", "w"];
const _K_COLOR = ["isColor", "r", "g", "b"];
const _K_M4 = ["elements"];
/** A `{ value }` literal (what terrain.js and terrain_batch build). */
function _plainSlot(u) { return _plainShape(u, OP, _K_VALUE); }
function _plainVec3(v) { return _plainShape(v, V3P, _K_XYZ) && v.set === V3P.set; }
function _plainVec4(v) { return _plainShape(v, V4P, _K_XYZW); }
function _plainColor(c) { return _plainShape(c, CP, _K_COLOR) && c.setRGB === CP.setRGB; }
function _plainMat4(m) {
  if (!_plainShape(m, M4P, _K_M4) || m.copy !== M4P.copy) return false;
  const e = m.elements;
  return Array.isArray(e) && Object.getPrototypeOf(e) === Array.prototype && e.length === 16 && Object.isExtensible(e) && !Object.isFrozen(e);
}

// ---------------------------------------------------------------------------
// A pusher (one per call site) and its groups (uniforms always written together)
// ---------------------------------------------------------------------------

// Time pushes so far (tickTerrainUTime runs every frame): pushers that have not
// observed for IDLE_TICKS of them get their leavers swept by the time pusher.
let _tick = 0;
const IDLE_TICKS = 30;

class Pusher {
  constructor(name) {
    this.name = name;
    this.snap = [];      // the registry as of the last observe()
    this.version = 0;    // bumped whenever observe() saw a different registry
    this.removed = [];   // the last diff (version-1 -> version), see observe()
    this.added = [];
    this._gone = null;   // `removed` minus everything still in the registry (lazy)
    this._set = null;    // Set of `snap`, built lazily per version (full resyncs only)
    this._setVersion = -1;
    this.groups = [];
    this.lastTick = 0;   // _tick at this pusher's last observe (idle sweeps)
    this.stats = { pushes: 0, versions: 0, fallbacks: 0, releases: 0, idleSweeps: 0 };
  }
  /**
   * Element-wise pointer compare with the last view; on a difference, the new
   * view and the diff to it. The diff is an ORDERED walk (LRU filter / splice /
   * bake push / unpark keep the survivors' order): an entry it cannot match is
   * taken as removed. Exact whatever the mutation: `gone()` re-checks every
   * "removed" entry against the new registry, and a survivor the walk misread
   * as removed (a mid-array insert, a reorder) is also in `added`, where a
   * bound or private one is skipped.
   */
  observe(R) {
    this.lastTick = _tick;
    const s = this.snap;
    const n = R.length;
    const ns = s.length;
    const lim = ns < n ? ns : n;
    let k = 0;
    while (k < lim && R[k] === s[k]) k++;
    if (k === n && k === ns) return this.version;
    const removed = [];
    const added = [];
    let i = k, j = k;
    while (i < ns && j < n) {
      if (s[i] === R[j]) { i++; j++; } else { removed.push(s[i]); i++; }
    }
    while (i < ns) removed.push(s[i++]);
    while (j < n) added.push(R[j++]);
    this.snap = R.slice();
    this.removed = removed;
    this.added = added;
    this._gone = null;
    this.version += 1;
    this.stats.versions += 1;
    return this.version;
  }
  /** The last diff's removed entries that are no longer anywhere in the registry. */
  gone() {
    if (this._gone === null) {
      const r = this.removed;
      if (r.length === 0) {
        this._gone = r;
      } else if (r.length <= 8) {
        const R = this.snap;
        this._gone = r.filter((m) => !R.includes(m));
      } else {
        const inR = this.members();
        this._gone = r.filter((m) => !inR.has(m));
      }
    }
    return this._gone;
  }
  members() {
    if (this._setVersion !== this.version) {
      this._set = new Set(this.snap);
      this._setVersion = this.version;
    }
    return this._set;
  }
  /** Every member back on a private copy; forget the view (empty registry, teardown). */
  release() {
    for (const g of this.groups) g.unbindAll();
    this.snap = [];
    this.removed = [];
    this.added = [];
    this._gone = null;
    this.version += 1;
    this._set = null;
    this._setVersion = -1;
    this.stats.releases += 1;
  }
  unbindAll() {
    for (const g of this.groups) g.unbindAll();
  }
  holds() {
    for (const g of this.groups) if (g.bound.size !== 0 || g.priv.size !== 0) return true;
    return false;
  }
  /** Freeze bound members that left the registry, in groups not written by this push. */
  sweep(except) {
    for (const g of this.groups) {
      if (g !== except && (g.bound.size !== 0 || g.priv.size !== 0)) g.unbindRemoved();
    }
  }
}

class Group {
  /**
   * @param {Pusher} pusher
   * @param {string[]} names    uniform names (one shared `{value}` each)
   * @param {Function[]} makeValue  initial slot value per name
   * @param {Function[]} cloneValue frozen private copy of a slot value
   * @param {(m: object, ctx: any) => number} classify SKIP | BIND | PRIV | HAZ
   */
  constructor(pusher, names, makeValue, cloneValue, classify) {
    this.p = pusher;
    this.names = names;
    this.shared = names.map((_, i) => ({ value: makeValue[i]() }));
    this.cloneValue = cloneValue;
    this.classify = classify;
    this.bound = new Set();
    this.pending = [];       // classified BIND, bound by commit()
    this.priv = new Set();   // registry members written one by one (idempotent writes: a duplicate entry needs one)
    this.hazard = false;
    this.synced = -1;        // pusher version this group's classification is current for
    this.swept = -1;         // pusher version its leavers were last frozen for
    this.resyncs = 0;
    this.increments = 0;
    pusher.groups.push(this);
  }
  _freeze(m) {
    const U = m && m.uniforms;
    if (!_isObj(U)) return;
    for (let i = 0; i < this.names.length; i++) {
      const k = this.names[i];
      const s = this.shared[i];
      if (U[k] === s) U[k] = { value: this.cloneValue[i](s.value) };
    }
  }
  _bind(m) {
    const U = m.uniforms;
    for (let i = 0; i < this.names.length; i++) U[this.names[i]] = this.shared[i];
    this.bound.add(m);
  }
  _drop(m) {
    if (this.bound.has(m)) { this._freeze(m); this.bound.delete(m); }
    this.priv.delete(m);
  }
  /**
   * Bring the classification to the pusher's version before a push that writes
   * the group: leavers are frozen (exact at any time), joiners are only
   * CLASSIFIED — commit() binds them once the pusher knows no group has a hazard
   * (a fallback must find every joiner still on its own object). One diff step
   * behind: incremental; further behind: a full pass.
   */
  ensure(ctx) {
    const p = this.p;
    if (this.synced === p.version) return;
    const pending = [];
    let haz = false;
    if (this.synced >= 0 && this.synced === p.version - 1 && this.swept >= this.synced) {
      if (this.swept !== p.version) {
        const gone = p.gone();
        for (let i = 0; i < gone.length; i++) this._drop(gone[i]);
      }
      const added = p.added;
      for (let i = 0; i < added.length; i++) {
        const m = added[i];
        if (this.bound.has(m) || this.priv.has(m)) continue;
        const c = this.classify(m, ctx);
        if (c === BIND) pending.push(m);
        else if (c === PRIV) this.priv.add(m);
        else if (c === HAZ) haz = true;
      }
      this.increments += 1;
    } else {
      const R = p.snap;
      const inR = p.members();
      for (const m of this.bound) {
        if (!inR.has(m)) { this._freeze(m); this.bound.delete(m); }
      }
      const priv = new Set();
      for (let i = 0; i < R.length; i++) {
        const m = R[i];
        if (this.bound.has(m)) continue;
        const c = this.classify(m, ctx);
        if (c === BIND) pending.push(m);
        else if (c === PRIV) priv.add(m);
        else if (c === HAZ) haz = true;
      }
      this.priv = priv;
      this.resyncs += 1;
    }
    this.pending = pending;
    this.hazard = haz;
    this.synced = p.version;
    this.swept = p.version;
  }
  /** Bind the joiners ensure() classified BIND (before this push writes). */
  commit() {
    const p = this.pending;
    if (p.length === 0) return;
    for (let i = 0; i < p.length; i++) if (!this.bound.has(p[i])) this._bind(p[i]);
    this.pending = [];
  }
  /** Freeze leavers only (a push that does not write this group). */
  unbindRemoved() {
    const p = this.p;
    if (this.swept === p.version) return;
    if (this.swept >= 0 && this.swept === p.version - 1) {
      const gone = p.gone();
      for (let i = 0; i < gone.length; i++) this._drop(gone[i]);
    } else {
      const inR = p.members();
      for (const m of this.bound) {
        if (!inR.has(m)) { this._freeze(m); this.bound.delete(m); }
      }
      for (const m of this.priv) if (!inR.has(m)) this.priv.delete(m);
    }
    this.swept = p.version;
  }
  unbindAll() {
    for (const m of this.bound) this._freeze(m);
    this.bound.clear();
    this.pending = [];
    this.priv = new Set();
    this.hazard = false;
    this.synced = -1;
    this.swept = -1;
  }
}

const _num0 = () => 0;
const _null = () => null;
const _same = (v) => v;
const _vec3 = () => new THREE.Vector3();
const _vec3Clone = (v) => v.clone();
const _mat4 = () => new THREE.Matrix4();
const _mat4Clone = (m) => new THREE.Matrix4().copy(m);

// `if (v !== X) v = X` — the shipped rule's result for a current value `v`.
function _postIfDiff(v, X) { return v !== X ? X : v; }
// BIND / PRIV / HAZ for one `{value}` written by `=` (assign) or by the if-diff rule.
function _classAssign(u) {
  if (_plainSlot(u)) return BIND;
  if (_writableData(u, "value")) return PRIV;
  return HAZ;
}
function _classIfDiff(u, X, slot) {
  if (_plainSlot(u)) return Object.is(_postIfDiff(u.value, X), _postIfDiff(slot.value, X)) ? BIND : PRIV;
  if (_writableData(u, "value")) return PRIV;
  return HAZ;
}
function _uniformsOf(m) {
  // `mat?.uniforms` as the shipped loops evaluate it.
  return m == null ? undefined : m.uniforms;
}

// ---------------------------------------------------------------------------
// loop.js tickTerrainUTime — uTime, uCrackGlowBreath
// ---------------------------------------------------------------------------

const _TIME = new Pusher("time");
// shipped: `if (mat?.uniforms?.uTime) mat.uniforms.uTime.value = tSec;`
const _gTime = new Group(_TIME, ["uTime"], [_num0], [_same], (m) => {
  const U = _uniformsOf(m);
  const u = U == null ? undefined : U.uTime;
  return u ? _classAssign(u) : SKIP;
});
// shipped: `if (breath !== undefined && mat?.uniforms?.uCrackGlowBreath) ….value = breath;`
const _gBreath = new Group(_TIME, ["uCrackGlowBreath"], [_num0], [_same], (m) => {
  const U = _uniformsOf(m);
  const u = U == null ? undefined : U.uCrackGlowBreath;
  return u ? _classAssign(u) : SKIP;
});

/**
 * The flag-on tickTerrainUTime body. Returns false when the caller must run its
 * own loop (registry not an Array, or a hazard) — every member is then back on a
 * private copy.
 */
export function sharedPushTerrainTime(R, tSec, breath) {
  if (!Array.isArray(R)) { _TIME.release(); return false; }
  _TIME.stats.pushes += 1;
  _tick += 1;
  const v0 = _TIME.version;
  if (_TIME.observe(R) !== v0) _sweepIdle(R);
  _gTime.ensure(null);
  const withBreath = breath !== undefined;
  if (withBreath) _gBreath.ensure(null);
  else _TIME.sweep(_gTime);
  if (_gTime.hazard || (withBreath && _gBreath.hazard)) {
    _TIME.unbindAll();
    _TIME.stats.fallbacks += 1;
    return false;
  }
  _gTime.commit();
  _gTime.shared[0].value = tSec;
  if (_gTime.priv.size !== 0) {
    for (const m of _gTime.priv) {
      const u = m?.uniforms?.uTime;
      if (u) u.value = tSec;
    }
  }
  if (withBreath) {
    _gBreath.commit();
    _gBreath.shared[0].value = breath;
    if (_gBreath.priv.size !== 0) {
      for (const m of _gBreath.priv) {
        const u = m?.uniforms?.uCrackGlowBreath;
        if (u) u.value = breath;
      }
    }
  }
  return true;
}
/** Empty / missing registry: nothing is pushed; release every member. */
export function sharedReleaseTerrainTime() {
  if (_TIME.snap.length !== 0 || _gTime.bound.size !== 0 || _gBreath.bound.size !== 0) _TIME.release();
}

// ---------------------------------------------------------------------------
// loop.js tickTerrainSunDir — uSunDir (+ when the Gouraud loop can be skipped)
// ---------------------------------------------------------------------------

const _SUN = new Pusher("sun");
// Gouraud members the shipped loop would throw on (or call something unusual).
function _gouraudHazard(m, U) {
  if (!_isObj(U) || !U.uAcSunVec) return false;
  if (!_plainVec3(U.uAcSunVec.value)) return true;
  if (!U.uAcSunColor || !_plainColor(U.uAcSunColor.value)) return true;
  if (!U.uAcAmbColor || !_plainColor(U.uAcAmbColor.value)) return true;
  if (!U.uAcAmbLevel || !_writableData(U.uAcAmbLevel, "value")) return true;
  if (U.uSunGlint && !_writableData(U.uSunGlint, "value")) return true;
  if (U.uPaintLight && !_plainVec4(U.uPaintLight.value)) return true;
  const ud = m.userData;
  if (ud && !(_writableData(ud, "__acLightEpoch") ||
      (Object.isExtensible(ud) && !("__acLightEpoch" in ud)))) return true;
  return false;
}
// shipped: `const v = mat?.uniforms?.uSunDir?.value; if (v && typeof v.set === "function") v.set(sx, sy, sz);`
const _gSun = new Group(_SUN, ["uSunDir"], [_vec3], [_vec3Clone], (m) => {
  const U = _uniformsOf(m);
  if (_isObj(m) && _gouraudHazard(m, U)) return HAZ;
  const u = U == null ? undefined : U.uSunDir;
  const val = u == null ? undefined : u.value;
  if (!(val && typeof val.set === "function")) return SKIP;
  if (!_plainVec3(val)) return HAZ;
  return _plainSlot(u) ? BIND : PRIV;
});
// When the Gouraud loop last covered the registry (fixed shape).
const _gour = { version: -1, epoch: NaN, always: true, pendingVersion: -1, pendingEpoch: NaN, pendingIncr: false };

/**
 * The flag-on tickTerrainSunDir uSunDir push.
 * @returns {number} 0 = not handled (caller runs the shipped loop; every member
 *   is back on a private uSunDir); 1 = done, the Gouraud loop is a provable no-op
 *   this frame; 2 = done, the caller runs the Gouraud-only loop over the whole
 *   registry; 3 = done, the caller runs it over `sharedTerrainSunJoiners()` only.
 *   After 2 / 3 the caller calls `sharedTerrainSunGouraudDone(always)`.
 */
export function sharedPushTerrainSun(R, sx, sy, sz, epoch) {
  if (!Array.isArray(R)) { _SUN.release(); _gour.version = -1; return 0; }
  _SUN.stats.pushes += 1;
  const v = _SUN.observe(R);
  _gSun.ensure(null);
  if (_gSun.hazard) {
    _SUN.unbindAll();
    _gour.version = -1;
    _SUN.stats.fallbacks += 1;
    return 0;
  }
  _gSun.commit();
  _gSun.shared[0].value.set(sx, sy, sz);
  if (_gSun.priv.size !== 0) {
    for (const m of _gSun.priv) {
      const val = m?.uniforms?.uSunDir?.value;
      if (val && typeof val.set === "function") val.set(sx, sy, sz);
    }
  }
  // The Gouraud loop writes a member only when its userData epoch differs from
  // `epoch` (or it has no userData). After a loop over the registry every member
  // carries `epoch`: with the same epoch and no userData-less member, the same
  // registry needs nothing, and a registry one diff step on needs the joiners
  // only (every survivor still carries `epoch`).
  if (Object.is(_gour.epoch, epoch) && !_gour.always && _gour.version >= 0) {
    if (_gour.version === v) return 1;
    if (_gour.version === v - 1) {
      _gour.pendingVersion = v;
      _gour.pendingEpoch = epoch;
      _gour.pendingIncr = true;
      return 3;
    }
  }
  _gour.pendingVersion = v;
  _gour.pendingEpoch = epoch;
  _gour.pendingIncr = false;
  return 2;
}
/** The entries that joined in the sun pusher's last diff step (for result 3). */
export function sharedTerrainSunJoiners() { return _SUN.added; }
/** The caller ran the Gouraud-only loop (`always`: it met a member without userData). */
export function sharedTerrainSunGouraudDone(always) {
  _gour.version = _gour.pendingVersion;
  _gour.epoch = _gour.pendingEpoch;
  _gour.always = _gour.pendingIncr ? (_gour.always || !!always) : !!always;
}
export function sharedReleaseTerrainSun() {
  if (_SUN.snap.length !== 0 || _gSun.bound.size !== 0) _SUN.release();
  _gour.version = -1;
}
/** The sun push wrote nothing this frame (no sky state yet): drop leavers only. */
export function sharedObserveTerrainSun(R) {
  if (!Array.isArray(R)) { sharedReleaseTerrainSun(); return; }
  if (_gSun.bound.size === 0 && _gSun.priv.size === 0) return;
  _SUN.observe(R);
  _SUN.sweep(null);
}

// ---------------------------------------------------------------------------
// cloud_volume.js _pushCloudShadowsToTerrain
// ---------------------------------------------------------------------------

const _CLOUD = new Pusher("cloud");
// shipped (both branches): `if (!u?.uCloudShadowEnabled) continue; if (… .value !== X) … = X;`
const _gEn = new Group(_CLOUD, ["uCloudShadowEnabled"], [_num0], [_same], (m, X) => {
  const U = _uniformsOf(m);
  const u = U == null ? undefined : U.uCloudShadowEnabled;
  return u ? _classIfDiff(u, X, _gEn.shared[0]) : SKIP;
});
// shipped (enabled branch, same members): map if-diff, then `u.uCloudShadowMatrix0.value.copy(src)`
const _gMM = new Group(_CLOUD, ["uCloudShadowMap", "uCloudShadowMatrix0"], [_null, _mat4], [_same, _mat4Clone], (m, ctx) => {
  const U = _uniformsOf(m);
  if (!(U != null && U.uCloudShadowEnabled)) return SKIP;
  const um = U.uCloudShadowMap;
  const ux = U.uCloudShadowMatrix0;
  if (!um || !ux) return HAZ;
  const mv = ux.value;
  if (!_plainMat4(mv)) return HAZ;
  const cm = _classAssign(um); // the if-diff result on a texture is always the texture
  if (cm === HAZ) return HAZ;
  if (cm === BIND && _plainSlot(ux) && mv !== ctx.src) return BIND;
  return PRIV;
});
// shipped: `if (Number.isFinite(strength) && u.uCloudShadowStrength && ….value !== strength) … = strength;`
const _gSt = new Group(_CLOUD, ["uCloudShadowStrength"], [_num0], [_same], (m, X) => {
  const U = _uniformsOf(m);
  if (!(U != null && U.uCloudShadowEnabled)) return SKIP;
  const u = U.uCloudShadowStrength;
  return u ? _classIfDiff(u, X, _gSt.shared[0]) : SKIP;
});

/** The cloud push's off branch (`?cloudShadow=off`, sunset under ?cloudNight). */
export function sharedPushCloudOff(R) {
  if (!Array.isArray(R)) { _CLOUD.release(); return false; }
  _CLOUD.stats.pushes += 1;
  _CLOUD.observe(R);
  _gEn.ensure(0.0);
  _CLOUD.sweep(_gEn);
  if (_gEn.hazard) {
    _gEn.unbindAll();
    _CLOUD.stats.fallbacks += 1;
    return false;
  }
  _gEn.commit();
  const s = _gEn.shared[0];
  if (s.value !== 0.0) s.value = 0.0;
  if (_gEn.priv.size !== 0) {
    for (const m of _gEn.priv) {
      const u = m?.uniforms?.uCloudShadowEnabled;
      if (u && u.value !== 0.0) u.value = 0.0;
    }
  }
  return true;
}

/** The cloud push's on branch: the same writes, slot by slot. */
export function sharedPushCloudOn(R, shadowTex, src, strength) {
  if (!Array.isArray(R)) { _CLOUD.release(); return false; }
  const e = src == null ? undefined : src.elements;
  if (!(Array.isArray(e) || ArrayBuffer.isView(e))) {
    // The shipped loop meets that source (Matrix4.copy throws on missing elements).
    _CLOUD.unbindAll();
    _CLOUD.stats.fallbacks += 1;
    return false;
  }
  _CLOUD.stats.pushes += 1;
  _CLOUD.observe(R);
  const fin = Number.isFinite(strength);
  _gEn.ensure(1.0);
  _gMM.ensure({ src });
  if (fin) _gSt.ensure(strength);
  else if (_gSt.bound.size !== 0 || _gSt.priv.size !== 0) _gSt.unbindRemoved();
  if (_gEn.hazard || _gMM.hazard || (fin && _gSt.hazard)) {
    _CLOUD.unbindAll();
    _CLOUD.stats.fallbacks += 1;
    return false;
  }
  _gEn.commit();
  _gMM.commit();
  if (fin) _gSt.commit();
  const sEn = _gEn.shared[0];
  if (sEn.value !== 1.0) sEn.value = 1.0;
  const sMap = _gMM.shared[0];
  if (sMap.value !== shadowTex) sMap.value = shadowTex;
  _gMM.shared[1].value.copy(src);
  if (fin) {
    const sSt = _gSt.shared[0];
    if (sSt.value !== strength) sSt.value = strength;
  }
  if (_gEn.priv.size !== 0) {
    for (const m of _gEn.priv) {
      const u = m?.uniforms?.uCloudShadowEnabled;
      if (u && u.value !== 1.0) u.value = 1.0;
    }
  }
  if (_gMM.priv.size !== 0) {
    for (const m of _gMM.priv) {
      const U = m?.uniforms;
      if (!U?.uCloudShadowEnabled) continue;
      if (U.uCloudShadowMap.value !== shadowTex) U.uCloudShadowMap.value = shadowTex;
      U.uCloudShadowMatrix0.value.copy(src);
    }
  }
  if (fin && _gSt.priv.size !== 0) {
    for (const m of _gSt.priv) {
      const U = m?.uniforms;
      if (U?.uCloudShadowEnabled && U.uCloudShadowStrength && U.uCloudShadowStrength.value !== strength) {
        U.uCloudShadowStrength.value = strength;
      }
    }
  }
  return true;
}
/** The push found no shadow texture / matrices: nothing written; drop leavers. */
export function sharedObserveCloud(R) {
  if (!Array.isArray(R)) { _CLOUD.release(); return; }
  _CLOUD.observe(R);
  _CLOUD.sweep(null);
}
/** Before any other writer of uCloudShadowStrength (the devtools setter). */
export function sharedUnbindCloudStrength() { _gSt.unbindAll(); }
/** Empty registry / CloudVolume.dispose: every cloud member back on a private copy. */
export function sharedReleaseCloud() {
  if (_CLOUD.snap.length !== 0 || _gEn.bound.size !== 0 || _gMM.bound.size !== 0 || _gSt.bound.size !== 0) _CLOUD.release();
}

// ---------------------------------------------------------------------------
// ibl_environment.js tick (NOT wired here: its owner adds the call — see §G1)
//   shipped: for each mat: u = mat?.uniforms; if (!u || !u.uIblEnabled) continue;
//            u.uIblEnabled.value = 1.0; u.uEnvCube.value = envCube; u.uEnvIntensity.value = envI;
// ---------------------------------------------------------------------------

const _IBL = new Pusher("ibl");
const _gIbl = new Group(_IBL, ["uIblEnabled", "uEnvCube", "uEnvIntensity"], [_num0, _null, _num0], [_same, _same, _same], (m) => {
  const U = _uniformsOf(m);
  if (!_isObj(U) || !U.uIblEnabled) return SKIP;
  const a = U.uIblEnabled, b = U.uEnvCube, c = U.uEnvIntensity;
  if (!b || !c) return HAZ;
  const ca = _classAssign(a), cb = _classAssign(b), cc = _classAssign(c);
  if (ca === HAZ || cb === HAZ || cc === HAZ) return HAZ;
  return ca === BIND && cb === BIND && cc === BIND ? BIND : PRIV;
});
export function sharedPushIbl(R, envCube, envI) {
  if (!Array.isArray(R)) { _IBL.release(); return false; }
  _IBL.stats.pushes += 1;
  _IBL.observe(R);
  _gIbl.ensure(null);
  if (_gIbl.hazard) {
    _gIbl.unbindAll();
    _IBL.stats.fallbacks += 1;
    return false;
  }
  _gIbl.commit();
  const s = _gIbl.shared;
  s[0].value = 1.0;
  s[1].value = envCube;
  s[2].value = envI;
  if (_gIbl.priv.size !== 0) {
    for (const m of _gIbl.priv) {
      const u = m?.uniforms;
      if (!u || !u.uIblEnabled) continue;
      u.uIblEnabled.value = 1.0;
      u.uEnvCube.value = envCube;
      u.uEnvIntensity.value = envI;
    }
  }
  return true;
}
export function sharedReleaseIbl() { _IBL.release(); }

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

const _PUSHERS = [_TIME, _SUN, _CLOUD, _IBL];

// The cloud push pauses indoors (index.js calls CloudOverlay.preRender only while
// the sky shows) and the sun push without a sky state: their groups would hold
// evicted materials until they resume. On a registry change the per-frame time
// push freezes, in every pusher idle for IDLE_TICKS frames, the bound members
// that are no longer in its registry — freezing a leaver is exact at any time;
// a pusher whose own registry differs just re-diffs at its next push.
function _sweepIdle(R) {
  for (let i = 0; i < _PUSHERS.length; i++) {
    const p = _PUSHERS[i];
    if (p === _TIME || _tick - p.lastTick < IDLE_TICKS || !p.holds()) continue;
    const t = p.lastTick;
    p.observe(R);
    p.lastTick = t;      // still idle: the sweep is not a push
    p.sweep(null);
    p.stats.idleSweeps += 1;
  }
}

/** Per pusher: versions seen, pushes, fallbacks; per group: bound / private counts. */
export function terrainSharedStats() {
  const out = { enabled: hotTerrainSharedEnabled() };
  for (const p of _PUSHERS) {
    out[p.name] = {
      ...p.stats,
      registry: p.snap.length,
      groups: p.groups.map((g) => ({ names: g.names.join(","), bound: g.bound.size, priv: g.priv.size, hazard: g.hazard, resyncs: g.resyncs, increments: g.increments })),
    };
  }
  return out;
}

/**
 * Debug walk: every bound material still points at its slots and is in its
 * pusher's last registry view. Returns the problems found (empty = consistent).
 */
export function verifySharedTerrain() {
  const problems = [];
  for (const p of _PUSHERS) {
    const inR = p.members();
    for (const g of p.groups) {
      for (const m of g.bound) {
        if (!inR.has(m)) problems.push(`${p.name}: a bound material left the registry unfrozen`);
        for (let i = 0; i < g.names.length; i++) {
          if (m?.uniforms?.[g.names[i]] !== g.shared[i]) problems.push(`${p.name}: ${g.names[i]} re-pointed by someone else`);
        }
      }
    }
  }
  return problems;
}

if (typeof window !== "undefined") {
  try {
    window.__terrainShared = { stats: terrainSharedStats, verify: verifySharedTerrain };
  } catch (_) { /* diag only */ }
}
