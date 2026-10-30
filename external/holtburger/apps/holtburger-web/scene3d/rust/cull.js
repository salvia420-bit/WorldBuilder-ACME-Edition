// scene3d/rust/cull.js — lane C bridge: the statics cull's per-node
// sphere-vs-frustum (and distance) tests in Rust (`?rustCull`, DEFAULT ON since 2026-10-26;
// `=off`/0/false/no escape).
//
// Lane notes (the cut, the reader/writer audit, costs): docs/2026-10-26-rust-cull.md.
// Kernel: crates/holtburger-scene/src/cull.rs. wasm glue: src/scene_wasm/cull.rs
// (`SceneStaticsCull`).
//
// WHAT IT REPLACES. statics.js `_cullStaticsWalk` visits every staticsGroup
// child on every walk (every moving frame, ~1,700 children at LB 0xE632 on the
// 1070, ~0.36-0.5 ms/frame): it re-reads up to a dozen userData markers per
// node, the cached cull sphere and the light guardrail, and runs the six
// plane tests through THREE objects. Under the flag `cullStaticsGroup` hands
// the walk to `rustCullStaticsWalk`, which:
//   1. keeps a REGISTRY of staticsGroup's children, maintained from the
//      group's own 'childadded' / 'childremoved' events (three r184 fires them
//      for add / remove / attach / clear / removeFromParent, and
//      bulk_child_remove.js fires the same pair), so streaming, park, unpark
//      and evict need no hooks of their own;
//   2. classifies a node (statics.js `_cullClassifyNode`, the walk's decision
//      order) when it first appears at a walk, when a marker writer says it
//      changed (`markStaticsCullDirty`: the dead-batch re-derive, the anchor
//      freeze) and when its child count moves (the light guardrail's own
//      invalidation rule) — not on every walk;
//   3. registers each sphere-bearing node's AC-space cull sphere in a flat
//      Rust table (stable slot ids, freed slots reused), batched into ONE
//      `applySlots` call per walk;
//   4. calls `frame()` ONCE per walk: Rust rebuilds the frustum from
//      `FrustumCuller._mvp` (three r184 `setFromProjectionMatrix`, both
//      coordinate systems, reversed depth) and writes one bit per slot;
//   5. sweeps the slots once, writing `node.visible` exactly as the walk
//      writes it — including forcing the walk's restore values back over any
//      foreign write (object_radius.js hides top-level nodes; the walk undoes
//      that on its next pass, and so must this).
// Why a sweep and not a flip list: the walk is a RESTORE pass (it rewrites a
// node's value whatever wrote it last), so an exact replacement has to look at
// `visible` of every node it owns on every walk. The sweep reads one property
// per node; the per-node marker reads, sphere lookup and plane math are what
// moved out.
//
// The same registry also hands statics.js `tickStaticsBillboards` the
// billboard-tagged LODs among the children (`rustCullBillboardList`, tracked
// at add / remove time), so the billboard rAF visits those instead of every
// child. The billboard MATH stays JS: measured in node it is about half the
// tick (the other half is the scan this removes), it runs atan2 / sin / cos
// (V8's fdlibm vs Rust's libm: not bit-exact) and its result lands in a
// quaternion whose onChange Euler sync would stay JS anyway (lane notes).
//
// Same pixels: the planes and verdicts are bit-identical to three's
// (tools/rust_parity/gen_cull.mjs → crates/holtburger-scene/tests/cull_parity.rs),
// the writes are the walk's (tests/rust_cull_parity.test.mjs compares every
// node's `visible` against the flag-off walk on every frame of a moving camera
// path with markers, lights, adds, removes, park/unpark and foreign writes).
// Anything unexpected falls back to the JS walk for that frame (no pkg, a POJO
// culler without `_mvp`, no frustum, film mode — statics.js keeps film on the
// JS walk) or for the session (an exception: the registry is torn down, warned
// once). A registry that lost count of the group (a child joined or left
// without an event) is re-seeded from `group.children` before the walk.
//
// `window.__rustCull.verify()` re-runs the walk's per-node decisions (an
// independent copy, statics.js `_cullDecideForVerify`) against the registry's
// answers from the last walk and counts disagreements; `stats()` has the
// counters.

import { sceneWasmClass, WasmF64View, WasmU32View, rustFlag } from "./scene_core.js";
import { CULL_DIST_SQ } from "../culling.js";

/** holtburger_scene::cull::IN_LEN / RECORD_LEN. */
export const CULL_IN_LEN = 24;
export const CULL_RECORD_LEN = 6;
const IN_CAM = 16;
const IN_COORDINATE_SYSTEM = 19;
const IN_REVERSED_DEPTH = 20;
const IN_DIST_ENABLED = 21;
const IN_HORIZON = 22;
const NO_FRUSTUM = 0xffffffff;

// Slot kinds: the walk's per-node policy (statics.js `_cullClassifyNode`
// returns these; `__cullKindsForTest` there pins the values).
export const CK_FREE = 0; // unused slot
export const CK_SKIP = 1; // the walk never writes it (particles, frozen anchors, animated buckets)
export const CK_SHOW = 2; // restored to visible (a live BatchedMesh; a node with no derivable bounds)
export const CK_HIDE = 3; // kept hidden, not counted (a dead batch)
export const CK_HIDE_COUNTED = 4; // kept hidden, counted tested + culled (a film hide)
export const CK_TEST = 5; // the sphere test decides; counted
export const CK_LIGHT = 6; // owns a light: restored to visible (sphere kept: the light may go)
export const CK_RETRY = 7; // a mesh whose bounds did not resolve yet: re-resolved every walk

let _flag = null;
/** `?rustCull` (read once; `__setRustCullForTest` overrides). */
export function rustCullEnabled() {
  if (_flag === null) _flag = rustFlag("rustCull", true);
  return _flag;
}
/** Test seam: true / false forces the flag; null re-reads it. */
export function __setRustCullForTest(v) {
  _flag = v === null || v === undefined ? null : !!v;
}

const _isParticle = (ud) => !!ud && (ud.__particle === true || ud.isParticleInstanced === true);

class StaticsCullRegistry {
  constructor(group, kernel, hooks) {
    this.group = group;
    this.k = kernel;
    this.hooks = hooks;
    this.inPtr = kernel.inPtr() >>> 0;
    this.inView = new WasmF64View();
    this.bitsView = new WasmU32View();
    // Membership: every child of `group` is in exactly one of these.
    this.slotOf = new Map(); // node → slot (classified, not SKIP)
    this.pending = new Set(); // joined since the last walk, not classified yet
    this.skipNodes = new Set(); // classified SKIP (no slot)
    this.particleCount = 0; // particle meshes / buckets (SKIP from birth: markers set before add)
    // Billboard-tagged LODs (statics.js tagBillboardLod stamps them before the
    // attach), tracked at EVENT time so the billboard tick — its own rAF, any
    // time after an add — never misses one (`billboardList`).
    this.billboards = new Set();
    // Slot tables.
    this.nodes = [];
    this.kinds = new Uint8Array(256);
    this.lightN = new Int32Array(256); // child count at the last light check (TEST / LIGHT)
    this.free = [];
    this.high = 0;
    this.dirty = new Set();
    // RETRY nodes whose bounds resolved at the last sweep: the verdict the
    // sweep wrote (they are re-classified at the next walk).
    this.resolvedVerdict = new Map();
    this.staged = [];
    this._sph = { x: 0, y: 0, z: 0, r: 0 };
    this.lastCuller = null;
    this.stats = {
      walks: 0, noFrustum: 0, reseeds: 0, classified: 0, reclassified: 0, retried: 0,
      retryResolved: 0, lightRechecks: 0, lightFlips: 0, applyCalls: 0, records: 0,
      lastTested: 0, lastCulled: 0, lastWrites: 0, strayRemovals: 0, billboardListsServed: 0,
    };
    this._onAdded = (e) => {
      try { this._added(e.child); } catch (err) { this._fail(err); }
    };
    this._onRemoved = (e) => {
      try { this._removed(e.child); } catch (err) { this._fail(err); }
    };
    this.failed = null;
    group.addEventListener("childadded", this._onAdded);
    group.addEventListener("childremoved", this._onRemoved);
    this.reseed();
    this.stats.reseeds = 0; // the first seed is not a desync
  }

  _fail(err) {
    if (!this.failed) this.failed = err || new Error("rustCull registry failure");
  }

  dispose() {
    try { this.group.removeEventListener("childadded", this._onAdded); } catch (_) {}
    try { this.group.removeEventListener("childremoved", this._onRemoved); } catch (_) {}
    this.slotOf.clear();
    this.pending.clear();
    this.skipNodes.clear();
    this.dirty.clear();
    this.billboards.clear();
    this.nodes.length = 0;
  }

  /** Every child is accounted for (no add / remove missed an event). */
  inSync() {
    return !this.failed &&
      this.slotOf.size + this.pending.size + this.skipNodes.size + this.particleCount === this.group.children.length;
  }

  _added(child) {
    if (!child) return;
    if (_isParticle(child.userData)) { this.particleCount += 1; return; }
    if (this.slotOf.has(child) || this.skipNodes.has(child)) return; // re-add without a remove: impossible through three
    this.pending.add(child);
    if (child.isLOD === true && ((child.userData && child.userData.billboardMode) ?? 0) >= 2) this.billboards.add(child);
  }

  _removed(child) {
    if (!child) return;
    this.billboards.delete(child);
    this.resolvedVerdict.delete(child);
    const s = this.slotOf.get(child);
    if (s !== undefined) {
      this.slotOf.delete(child);
      this.dirty.delete(child);
      this._freeSlot(s);
      return;
    }
    if (this.pending.delete(child)) return;
    if (this.skipNodes.delete(child)) { this.dirty.delete(child); return; }
    if (_isParticle(child.userData)) { this.particleCount -= 1; return; }
    this.stats.strayRemovals += 1; // the count check re-seeds
  }

  markDirty(node) {
    if (this.slotOf.has(node) || this.skipNodes.has(node)) this.dirty.add(node);
  }

  /** Forget everything and re-register every child (pending → classified at this walk). */
  reseed() {
    this.k.clear();
    this.slotOf.clear();
    this.pending.clear();
    this.skipNodes.clear();
    this.dirty.clear();
    this.billboards.clear();
    this.resolvedVerdict.clear();
    this.particleCount = 0;
    this.nodes.length = 0;
    this.kinds.fill(0);
    this.free.length = 0;
    this.high = 0;
    this.staged.length = 0;
    for (const c of this.group.children) this._added(c);
    this.stats.reseeds += 1;
  }

  _ensureCapacity(n) {
    if (n <= this.kinds.length) return;
    let cap = this.kinds.length;
    while (cap < n) cap *= 2;
    const k = new Uint8Array(cap);
    k.set(this.kinds);
    this.kinds = k;
    const l = new Int32Array(cap);
    l.set(this.lightN);
    this.lightN = l;
  }

  _allocSlot() {
    if (this.free.length > 0) return this.free.pop();
    const s = this.high;
    this.high += 1;
    this._ensureCapacity(this.high);
    return s;
  }

  _freeSlot(s) {
    this.nodes[s] = null;
    this.kinds[s] = CK_FREE;
    this.staged.push(s, 0, 0, 0, 0, 0);
    this.free.push(s);
  }

  // Classify `node` (new, or re-marked) and stage its slot record.
  _classify(node) {
    const sph = this._sph;
    const kind = this.hooks.classify(node, sph);
    let s = this.slotOf.get(node);
    if (kind === CK_SKIP) {
      if (s !== undefined) {
        this.slotOf.delete(node);
        this._freeSlot(s);
      }
      this.skipNodes.add(node);
      return;
    }
    this.skipNodes.delete(node);
    if (s === undefined) {
      s = this._allocSlot();
      this.slotOf.set(node, s);
    }
    this.nodes[s] = node;
    this.kinds[s] = kind;
    if (kind === CK_TEST || kind === CK_LIGHT) {
      const kids = node.children;
      this.lightN[s] = kids ? kids.length : 0; // what `_staticOwnsLight` just cached
      this.staged.push(s, 1, sph.x, sph.y, sph.z, sph.r);
    } else {
      this.staged.push(s, 0, 0, 0, 0, 0);
    }
  }

  _flush() {
    const st = this.staged;
    if (st.length === 0) return;
    const n = this.k.applySlots(Float64Array.from(st)) >>> 0;
    this.stats.applyCalls += 1;
    this.stats.records += st.length / CULL_RECORD_LEN;
    st.length = 0;
    if (n === NO_FRUSTUM) throw new Error("SceneStaticsCull.applySlots refused a batch");
  }

  /** One walk. `{tested, culled}`, or null to let the JS walk run this frame. */
  walk(culler) {
    if (this.failed) throw this.failed;
    if (!this.inSync()) this.reseed();
    if (this.pending.size > 0) {
      for (const n of this.pending) this._classify(n);
      this.stats.classified += this.pending.size;
      this.pending.clear();
    }
    if (this.dirty.size > 0) {
      for (const n of this.dirty) this._classify(n);
      this.stats.reclassified += this.dirty.size;
      this.dirty.clear();
    }
    if (this.resolvedVerdict.size > 0) this.resolvedVerdict.clear();
    this._flush();

    const distEnabled = CULL_DIST_SQ !== Infinity;
    const horizon = distEnabled ? Math.sqrt(CULL_DIST_SQ) : 0;
    const inp = this.inView.get(this.inPtr, CULL_IN_LEN);
    if (!inp || inp.length < CULL_IN_LEN) return null;
    const m = culler._mvp.elements;
    for (let i = 0; i < 16; i++) inp[i] = m[i];
    const cam = culler._camAc;
    inp[IN_CAM] = cam.x;
    inp[IN_CAM + 1] = cam.y;
    inp[IN_CAM + 2] = cam.z;
    inp[IN_COORDINATE_SYSTEM] = culler.coordinateSystem;
    inp[IN_REVERSED_DEPTH] = culler.reversedDepth === true ? 1 : 0;
    inp[IN_DIST_ENABLED] = distEnabled ? 1 : 0;
    inp[IN_HORIZON] = horizon;
    const n = this.k.frame() >>> 0;
    if (n === NO_FRUSTUM) { this.stats.noFrustum += 1; return null; }
    const bits = this.bitsView.get(this.k.bitsPtr() >>> 0, this.k.bitsLen() >>> 0);
    if (!bits || bits.length * 32 < this.high) {
      // The kernel lost slots the registry holds: re-seed and let the JS walk
      // answer this frame.
      this.reseed();
      return null;
    }
    this.lastCuller = culler;
    this.stats.walks += 1;
    return this._sweep(bits, culler, distEnabled, horizon);
  }

  // Write `visible` exactly as `_cullStaticsWalk` would, slot by slot.
  _sweep(bits, culler, distEnabled, horizon) {
    const nodes = this.nodes;
    const kinds = this.kinds;
    const lightN = this.lightN;
    const high = this.high;
    let tested = 0;
    let culled = 0;
    let writes = 0;
    for (let s = 0; s < high; s++) {
      const kind = kinds[s];
      if (kind === CK_FREE) continue;
      const node = nodes[s];
      if (kind === CK_TEST || kind === CK_LIGHT) {
        // The light guardrail, re-derived exactly when `_staticOwnsLight`
        // would re-scan (its cache is keyed on the child count).
        const kids = node.children;
        const nk = kids ? kids.length : 0;
        let k2 = kind;
        if (nk !== lightN[s]) {
          lightN[s] = nk;
          this.stats.lightRechecks += 1;
          k2 = this.hooks.ownsLight(node) ? CK_LIGHT : CK_TEST;
          if (k2 !== kind) { kinds[s] = k2; this.stats.lightFlips += 1; }
        }
        if (k2 === CK_TEST) {
          tested += 1;
          const want = ((bits[s >>> 5] >>> (s & 31)) & 1) === 1;
          if (node.visible !== want) {
            node.visible = want;
            writes += 1;
            if (!want) culled += 1;
          } else if (!want) {
            culled += 1;
          }
        } else if (node.visible === false) {
          node.visible = true;
          writes += 1;
        }
      } else if (kind === CK_SHOW) {
        if (node.visible === false) { node.visible = true; writes += 1; }
      } else if (kind === CK_HIDE) {
        if (node.visible !== false) { node.visible = false; writes += 1; }
      } else if (kind === CK_RETRY) {
        this.stats.retried += 1;
        const sphere = this.hooks.resolveSphere(node);
        if (!sphere) {
          if (node.visible === false) { node.visible = true; writes += 1; }
        } else {
          // Bounds resolved this walk: finish the walk's logic for this node
          // in JS (the same culler the walk reads), register it next walk.
          this.stats.retryResolved += 1;
          this.dirty.add(node);
          if (this.hooks.ownsLight(node)) {
            this.resolvedVerdict.set(node, true);
            if (node.visible === false) { node.visible = true; writes += 1; }
          } else {
            tested += 1;
            let want = culler.isSphereInFrustum(sphere);
            if (want && distEnabled) {
              const c = sphere.center;
              const distSq = culler.getDistanceSq(c.x, c.y, c.z);
              const padded = horizon + sphere.radius;
              if (distSq > padded * padded) want = false;
            }
            this.resolvedVerdict.set(node, want);
            if (node.visible !== want) {
              node.visible = want;
              writes += 1;
              if (!want) culled += 1;
            } else if (!want) {
              culled += 1;
            }
          }
        }
      } else if (kind === CK_HIDE_COUNTED) {
        tested += 1;
        culled += 1;
        if (node.visible !== false) { node.visible = false; writes += 1; }
      }
    }
    this.stats.lastTested = tested;
    this.stats.lastCulled = culled;
    this.stats.lastWrites = writes;
    return { tested, culled };
  }

  /** The registry's verdict for `node` at the last walk: true / false, null = no write, undefined = not tracked. */
  verdict(node) {
    const s = this.slotOf.get(node);
    if (s === undefined) {
      if (this.skipNodes.has(node) || _isParticle(node?.userData)) return null;
      return undefined;
    }
    const kind = this.kinds[s];
    switch (kind) {
      case CK_TEST: {
        const bits = this.bitsView.get(this.k.bitsPtr() >>> 0, this.k.bitsLen() >>> 0);
        return !!bits && ((bits[s >>> 5] >>> (s & 31)) & 1) === 1;
      }
      case CK_LIGHT:
      case CK_SHOW:
        return true;
      case CK_HIDE:
      case CK_HIDE_COUNTED:
        return false;
      case CK_RETRY:
        // resolved at the last sweep: what it wrote; else restored to visible
        return this.resolvedVerdict.has(node) ? this.resolvedVerdict.get(node) : true;
      default:
        return null;
    }
  }
}

const _registries = new WeakMap(); // staticsGroup → registry | false (unavailable / failed)
let _lastReg = null; // the registry stats() / verify() default to
let _warned = false;

function _warn(msg, err) {
  if (_warned) return;
  _warned = true;
  // eslint-disable-next-line no-console
  console.warn(`[rustCull] ${msg}; the JS statics walk stays in use.`, err || "");
}

function _registryFor(group, hooks) {
  let reg = _registries.get(group);
  if (reg !== undefined) return reg || null;
  reg = false;
  try {
    const C = sceneWasmClass("SceneStaticsCull");
    if (C) {
      const k = new C();
      if ((k.inLen() >>> 0) === CULL_IN_LEN && (k.recordLen() >>> 0) === CULL_RECORD_LEN) {
        reg = new StaticsCullRegistry(group, k, hooks);
      } else {
        _warn("SceneStaticsCull layout differs from this bridge (stale pkg?)");
        try { k.free?.(); } catch (_) {}
      }
    }
  } catch (e) {
    _warn("SceneStaticsCull unavailable", e);
    reg = false;
  }
  _registries.set(group, reg);
  if (reg) {
    _lastReg = reg;
    _installDiag();
  }
  return reg || null;
}

/**
 * The Rust statics walk (`cullStaticsGroup` calls it when `?rustCull` is on).
 * `hooks` = statics.js `{ classify, ownsLight, resolveSphere, decide }`.
 * Returns `{ tested, culled }`, or null to run the JS walk this frame.
 */
export function rustCullStaticsWalk(group, culler, hooks) {
  if (!rustCullEnabled() || !group || !hooks) return null;
  if (!culler || !culler._mvp || !culler._mvp.elements || !culler._camAc) return null;
  const reg = _registryFor(group, hooks);
  if (!reg) return null;
  try {
    return reg.walk(culler);
  } catch (e) {
    _warn("registry failed", e);
    reg.dispose();
    _registries.set(group, false);
    return null;
  }
}

/**
 * ?rustCull: the billboard-tagged LODs among `group`'s children (a Set, in
 * attach order), for statics.js `tickStaticsBillboards` to visit instead of
 * every child; null when there is no healthy registry for `group` (then the
 * tick walks the children, as before). Each leaf's facing depends only on its
 * own LOD and the camera, so the visiting order does not matter.
 */
export function rustCullBillboardList(group) {
  const reg = group ? _registries.get(group) : null;
  if (!reg || !reg.inSync()) return null;
  reg.stats.billboardListsServed += 1;
  return reg.billboards;
}

/**
 * A marker the walk reads changed on `node` (`__deadBatch`, `__anchorFrozen`,
 * …): re-classify it at the next walk. A no-op unless `node` is a tracked
 * staticsGroup child.
 */
export function markStaticsCullDirty(node) {
  const parent = node && node.parent;
  if (!parent) return;
  const reg = _registries.get(parent);
  if (reg) reg.markDirty(node);
}

/** Diag snapshot for one staticsGroup (or the first registry we hand out). */
export function rustCullStats(group) {
  const reg = group ? _registries.get(group) : _lastRegistry();
  return {
    enabled: rustCullEnabled(),
    available: !!reg,
    slots: reg ? reg.high : 0,
    freeSlots: reg ? reg.free.length : 0,
    tracked: reg ? reg.slotOf.size : 0,
    pending: reg ? reg.pending.size : 0,
    skip: reg ? reg.skipNodes.size : 0,
    particles: reg ? reg.particleCount : 0,
    kernelSlots: reg ? reg.k.slotCount >>> 0 : 0,
    spheresTested: reg ? reg.k.spheresTested >>> 0 : 0,
    ...(reg ? reg.stats : {}),
  };
}

function _lastRegistry() {
  return _lastReg;
}

/**
 * Compare the registry's last answers with the walk's own decisions (statics.js
 * `_cullDecideForVerify`, an independent copy of the walk's per-node branches)
 * for every child, plus the kernel's planes with three's. Run it right after a
 * frame whose walk ran: on a ?staticsCullGate-skipped frame the registry's
 * answers are the last walk's, and a change since (a light attach the gate did
 * not see) is legitimately not in them yet — the JS walk would not have run
 * either. `stats().walks` tells the two apart.
 */
export function verifyRustCull(group) {
  const reg = group ? _registries.get(group) : _lastRegistry();
  if (!reg) return { ok: false, reason: "no registry (flag off, no pkg, or never walked)" };
  const culler = reg.lastCuller;
  if (!culler) return { ok: false, reason: "no walk yet" };
  const res = { ok: true, checked: 0, agree: 0, disagree: 0, untracked: 0, pending: reg.pending.size, planeMismatches: 0, samples: [] };
  for (const node of reg.group.children) {
    const want = reg.hooks.decide(node, culler);
    const got = reg.verdict(node);
    res.checked += 1;
    if (got === undefined) {
      if (reg.pending.has(node)) continue;
      res.untracked += 1;
      if (res.samples.length < 8) res.samples.push(`${node.name || node.type}: untracked`);
      continue;
    }
    if (got === want) res.agree += 1;
    else {
      res.disagree += 1;
      if (res.samples.length < 8) res.samples.push(`${node.name || node.type}: walk ${want} vs rust ${got}`);
    }
  }
  // Planes: the kernel's frustum vs three's, bit for bit.
  try {
    const p = reg.k.planes();
    const planes = culler.frustum?.planes;
    if (planes && p && p.length === 24) {
      for (let i = 0; i < 6; i++) {
        const q = planes[i];
        const v = [q.normal.x, q.normal.y, q.normal.z, q.constant];
        for (let j = 0; j < 4; j++) if (!Object.is(v[j], p[i * 4 + j])) res.planeMismatches += 1;
      }
    }
  } catch (_) { /* diag only */ }
  res.ok = res.disagree === 0 && res.untracked === 0 && res.planeMismatches === 0;
  return res;
}

function _installDiag() {
  if (typeof window === "undefined" || !window) return;
  try {
    if (window.__rustCull) return;
    window.__rustCull = {
      stats: (g) => rustCullStats(g),
      verify: (g) => verifyRustCull(g),
    };
  } catch (_) { /* diag only */ }
}

/** Test seam: the registry of `group` (null when none). */
export function __registryForTest(group) {
  const r = _registries.get(group);
  return r || null;
}
/** Test seam: drop `group`'s registry (listeners removed); the next walk builds a new one. */
export function __resetRustCullForTest(group) {
  const r = group ? _registries.get(group) : null;
  if (r) r.dispose();
  if (group) _registries.delete(group);
  if (_lastReg === r) _lastReg = null;
  _warned = false;
}
