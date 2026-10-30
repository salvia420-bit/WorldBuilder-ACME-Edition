// tools/rust_parity/gen_particles.mjs — the JS particle reference for lane A
// (crates/holtburger-scene/src/particles/, pinned by tests/particles_parity.rs).
//
// Runs the REAL ParticleManager / ParticleEmitter / Particle code (flag off) on
// scripted scenarios — scripted clock (`setCurrentTime`), recording RNG
// (`setRng`, fixture_util `recordRng`), a camera that moves — and records, per
// tick, (a) exactly what the ?rustParticles bridge would hand the kernel
// (scene3d/rust/particles.js `RustParticleInputs`: descriptors, globals,
// dynamic anchors / RP6 / cell flags, route + bucket tables) and (b) what the
// JS path wrote into the three.js objects: every bucket's instance matrices +
// colours (f32 bit patterns), counts and capacities, bucket / kids-layer
// creation order, kid records, removals, stats, the FX seed state and the RNG
// draws consumed.
//
// Run: node tools/rust_parity/gen_particles.mjs
//   (writes crates/holtburger-scene/tests/fixtures/particles_*.json; the
//    legacy-escape scenario re-runs itself in a child process with the
//    escape URL flags, since particle.js reads them at module load)
//
// The scenarios + harness are exported for tests/rust_particles_parity.test.mjs,
// which drives the same scenarios through the real wasm bridge.

import * as THREE from "three";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { f32arr, f64arr, f64hex, recordRng, writeFixture } from "./fixture_util.mjs";

const SELF = fileURLToPath(import.meta.url);

/** Install the browser-ish globals the particle modules read at import. */
export function installGlobals(search = "") {
  globalThis.location = { search };
  if (typeof globalThis.window === "undefined") globalThis.window = {};
  globalThis.window.location = globalThis.location;
}

/** The particle modules (import AFTER installGlobals). */
export async function loadModules() {
  return {
    time: await import("../../scene3d/particles/time_rng.js"),
    pm: await import("../../scene3d/particles/particle_manager.js"),
    pe: await import("../../scene3d/particles/particle_emitter.js"),
    fx: await import("../../scene3d/particles/particle_fx.js"),
    kids: await import("../../scene3d/particles/particle_fx_kids.js"),
    bridge: await import("../../scene3d/rust/particles.js"),
    core: await import("../../scene3d/rust/scene_core.js"),
  };
}

const flush = () => new Promise((r) => setImmediate(r));
const FX_SEED0 = 0x9e3779b9;

// ---------------------------------------------------------------- harness

/**
 * One scenario run: a manager under a worldRoot-like rotated group, factories
 * serving planes + additive/alpha base materials per gfxobj, a camera on
 * `window.liveScene3d`, a scripted clock and frame id.
 */
export class Harness {
  constructor(M, { recorder = null, onManager = null } = {}) {
    this.M = M;
    this.t = 1000;
    this.frame = 1;
    this.recorder = recorder;
    this.onManager = onManager;
    /** Per-manager RNG functions (multi-manager runs; see `useRngOf`). */
    this.rngs = new Map();
    M.time.setCurrentTime(() => this.t);
    M.pm.__setSharedAlphaFrameSource(() => this.frame);
    M.fx.setParticleFxSeedState(FX_SEED0);
    M.pm._resetParticleBillboardModeForTest();
    M.pm._resetParticleDegradeForTest();
    M.pm.sharedAlphaBuckets.buckets.clear();
    for (const k of Object.keys(M.pm.sharedAlphaBuckets.stats)) M.pm.sharedAlphaBuckets.stats[k] = 0;
    this.cam = new THREE.PerspectiveCamera(60, 1.6, 0.1, 4000);
    this.cam.position.set(0, 30, 60);
    this.cam.lookAt(0, 0, 0);
    globalThis.window.liveScene3d = { cameraSwitcher: { activeCamera: this.cam }, camera: this.cam };
    this.root = new THREE.Scene();
    this.world = new THREE.Group();
    this.world.rotation.x = -Math.PI / 2; // worldRoot: AC Z-up → three Y-up
    this.root.add(this.world);
    this.group = new THREE.Group();
    this.world.add(this.group);
    this.root.add(this.cam);
    this.root.updateMatrixWorld(true);
    this.cells = new Map();
    this.tex = new THREE.DataTexture(new Uint8Array(4 * 4 * 4).fill(255), 4, 4);
    this.gfx = new Map(); // hw → { geom, mat, bbMode, degrade }
    const h = this;
    globalThis.window.__hbWasm = {
      fetch_gfx_obj_degrade_info: async (did) => JSON.stringify({ degrades: [{ degrade_mode: h._bbModeOfDid(did) }] }),
      fetch_particle_degrade_distance: async (hw) => h.gfx.get(hw >>> 0)?.degrade ?? 0,
    };
    this.mgrs = [];
    this.removed = [];
    this.mgr = this.addManager(this.group, true);
  }

  /**
   * A ParticleManager on `scene` (the static manager has the cell lookup; a
   * second one stands for the world/entity manager, sharing the alpha buckets).
   */
  addManager(scene, cells = false) {
    const mgr = new this.M.pm.ParticleManager({
      scene,
      instancing: true,
      geometryFactory: (hw) => this.gfx.get(hw >>> 0)?.geom ?? null,
      materialFactory: (hw) => this.gfx.get(hw >>> 0)?.mat ?? null,
      degradeInfoFactory: async (hw) => ((this.gfx.get(hw >>> 0)?.bbMode | 0) ? ((hw >>> 0) ^ 0x10000000) >>> 0 : 0),
      ...(cells ? { cellLookup: (cid) => this.cells.get(cid >>> 0) } : {}),
    });
    const index = this.mgrs.length;
    mgr.onEmitterRemoved = (id) => this.removed.push([index, id]);
    this.mgrs.push(mgr);
    if (this.onManager) this.onManager(mgr, index, this);
    return mgr;
  }

  /** Install a manager's own RNG stream before it adds or ticks (multi-manager runs). */
  useRngOf(mgr) {
    const r = this.rngs.get(mgr);
    if (r) this.M.time.setRng(r);
  }

  _bbModeOfDid(did) {
    const g = this.gfx.get(((did >>> 0) ^ 0x10000000) >>> 0);
    return g ? g.bbMode | 0 : 0;
  }

  /** Register a particle gfxobj: additive or alpha base material, optional bb mode / degrade distance. */
  defGfx(hw, { alpha = false, bbMode = 0, degrade = 0, size = 0.5 } = {}) {
    const geom = new THREE.PlaneGeometry(size, size);
    const mat = new THREE.MeshBasicMaterial({ map: this.tex, transparent: true, side: THREE.DoubleSide, depthWrite: !!alpha });
    if (alpha) {
      mat.userData = { __cacheOwned: true, surfaceTypeFlags: 0x100 };
    } else {
      mat.blending = THREE.AdditiveBlending;
      mat.depthWrite = false;
      mat.userData = { __cacheOwned: true, surfaceTypeFlags: 0x10000 };
    }
    this.gfx.set(hw >>> 0, { geom, mat, bbMode, degrade });
  }

  /** A frozen static anchor (statics.js `_freezeStaticScriptAnchor`). */
  frozenAnchor(x, y, z, { yaw = 0, partFrames = null } = {}) {
    const a = new THREE.Object3D();
    a.position.set(x, y, z);
    a.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), yaw);
    a.userData = { isStaticScriptAnchor: true };
    this.group.add(a);
    a.updateWorldMatrix(true, true);
    if (partFrames) {
      // Frozen part frames (world space), as setup_rig's proxy reads them.
      a.partFrames = partFrames.map(([px, py, pz, ang]) => {
        const lp = new THREE.Vector3(px, py, pz);
        const lq = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), ang);
        const m = new THREE.Matrix4().compose(lp, lq, new THREE.Vector3(1, 1, 1)).premultiply(a.matrixWorld);
        const position = new THREE.Vector3(), quaternion = new THREE.Quaternion(), s = new THREE.Vector3();
        m.decompose(position, quaternion, s);
        return { position, quaternion };
      });
    }
    a.traverse((o) => { o.matrixAutoUpdate = false; o.matrixWorldAutoUpdate = false; });
    a.visible = false;
    a.userData.__anchorFrozen = true;
    return a;
  }

  /** A moving (entity-like) anchor; `parts` adds live part frames (WORLD space getters). */
  movingAnchor(x, y, z, { parts = 0 } = {}) {
    const a = new THREE.Object3D();
    a.position.set(x, y, z);
    this.group.add(a);
    a.updateWorldMatrix(true, true);
    if (parts > 0) {
      const kids = [];
      for (let i = 0; i < parts; i++) {
        const k = new THREE.Object3D();
        k.position.set(0.3 * (i + 1), 0, 1.2 + 0.4 * i);
        a.add(k);
        kids.push(k);
      }
      a.partFrames = kids.map((k) => ({
        get position() { return k.getWorldPosition(new THREE.Vector3()); },
        get quaternion() { return k.getWorldQuaternion(new THREE.Quaternion()); },
      }));
      a.userData.partKids = kids;
    }
    return a;
  }

  /** An interior anchor carrying a cellId (not frozen); the container is toggled per tick. */
  cellAnchor(x, y, z, cellId) {
    const a = new THREE.Object3D();
    a.position.set(x, y, z);
    a.userData = { isStaticScriptAnchor: true, isCellStaticScriptAnchor: true, cellId: cellId >>> 0 };
    this.group.add(a);
    a.updateWorldMatrix(true, true);
    if (!this.cells.has(cellId >>> 0)) {
      const c = new THREE.Group();
      this.root.add(c);
      this.cells.set(cellId >>> 0, c);
    }
    return a;
  }

  async add(spec) {
    const mgr = spec.mgr || this.mgr;
    this.useRngOf(mgr);
    const req = {
      emitterInfo: spec.info,
      parent: spec.anchor,
      partIndex: spec.partIndex ?? -1,
      parentOffset: spec.offset ?? null,
      emitterId: spec.emitterId ?? 0,
      renderLayer: spec.renderLayer ?? 0,
      skyGlow: spec.skyGlow ?? false,
    };
    const id = await mgr.addEmitter(req);
    if (this.recorder) this.recorder.completeAdd(this, id);
    await flush();
    return id;
  }

  stop(id) { this.mgr.stopParticleEmitter(id); }

  destroy(id) { this.mgr.destroyParticleEmitter(id); }

  async tick(dt = 1 / 60) {
    this.t += dt;
    this.frame += 1;
    if (this.recorder) this.recorder.beforeTick(this);
    this.removed.length = 0;
    const live = this.mgrs.map((m) => new Map(m.particleTable));
    const rp0 = { ...this.M.pm.PARTICLE_RP6_STATS };
    const sh0 = { ...this.M.pm.sharedAlphaBuckets.stats };
    for (const m of this.mgrs) { this.useRngOf(m); m.tick(); }
    const snap = this.snapshot(rp0, sh0, live);
    if (this.recorder) this.recorder.afterTick(this, snap);
    await flush();
    return snap;
  }

  /** What the JS path left in the three.js objects + counters this tick. */
  snapshot(rp0, sh0, live) {
    const multi = this.mgrs.length > 1;
    const tag = (i, k) => (multi ? `m${i}:${k}` : k);
    const bucket = (key, b, shared) => {
      const im = b.im;
      const n = im.count | 0;
      return {
        key, shared, count: n, cap: im.instanceMatrix.count,
        mat: Float32Array.from(im.instanceMatrix.array.subarray(0, n * 16)),
        col: im.instanceColor ? Float32Array.from(im.instanceColor.array.subarray(0, n * 3)) : new Float32Array(0),
      };
    };
    const own = [];
    this.mgrs.forEach((mgr, i) => { for (const [key, b] of mgr._instBuckets) own.push(bucket(tag(i, key), b, false)); });
    const shared = [];
    for (const [key, b] of this.M.pm.sharedAlphaBuckets.buckets) shared.push(bucket(key, b, true));
    const kids = [];
    this.mgrs.forEach((mgr, i) => {
      if (!mgr._kids) return;
      for (const [layer, l] of mgr._kids.layers) {
        const g = l.mesh.geometry;
        kids.push({
          layer: multi ? `m${i}:${layer}` : layer, n: l.n, cap: l.cap,
          pos: Float32Array.from(g.attributes.aKidPos.array.subarray(0, l.n * 4)),
          vel: Float32Array.from(g.attributes.aKidVel.array.subarray(0, l.n * 4)),
          row: Float32Array.from(g.attributes.aKidRow.array.subarray(0, l.n * 2)),
        });
      }
    });
    const rp = this.M.pm.PARTICLE_RP6_STATS;
    const sh = this.M.pm.sharedAlphaBuckets.stats;
    const mgr = this.mgr;
    const emitters = [];
    for (const m of this.mgrs) {
      for (const [, e] of m.particleTable) {
        emitters.push([e, e.numParticles | 0, e.totalEmitted | 0, e.stopped === true ? 1 : 0, e._rp6Culled === true ? 1 : 0]);
      }
    }
    // Slot meshes as a reader sees them (`emitter.parts`): JS carriers or the
    // bridge's materialized proxies, and per-mesh emitters' live meshes.
    const slots = [];
    if (this.snapSlots) {
      for (const [id, e] of mgr.particleTable) {
        const parts = e.parts || [];
        const rows = [];
        for (let i = 0; i < parts.length; i++) {
          const m = parts[i];
          if (!m) continue;
          rows.push([i, m.position.x, m.position.y, m.position.z, m.quaternion.x, m.quaternion.y, m.quaternion.z,
            m.quaternion.w, m.scale.x, m.visible ? 1 : 0, m.userData?.__op ?? -1,
            m.material && m.material.userData?.__slotCarrier !== true ? m.material.opacity : -1, m.parent ? 1 : 0]);
        }
        slots.push([id, rows]);
      }
    }
    return {
      own, shared, kids,
      removed: this.removed.map(([i, id]) => live[i].get(id) || null),
      stats: [
        rp.culledForceStopped - rp0.culledForceStopped,
        rp.cellHiddenEmitterTicks - rp0.cellHiddenEmitterTicks,
        rp.cellHiddenParticleTicks - rp0.cellHiddenParticleTicks,
        sh.rejectedScene - sh0.rejectedScene,
        sh.rejectedMat - sh0.rejectedMat,
      ],
      cellHidden: this.mgrs.reduce((a, m) => a + (m.cellHiddenLastTick | 0), 0),
      seed: this.M.fx.particleFxSeedState(),
      emitters,
      slots,
    };
  }
}

// ------------------------------------------------------------- recorder

/** Records the kernel inputs (via the bridge's own input builder) + the JS outputs. */
export class Recorder {
  constructor(M, h, rec) {
    this.M = M;
    this.rec = rec; // recordRng()
    this.ops = [];
    this.eIndex = new Map();
    this.emitters = [];
    this.cached = [];
    this.pending = new Map();
    this.prevFlags = new Map();
    this.fields = new Map();
    this.created = [];
    this.kidsCreated = [];
    this.inputs = null;
    const self = this;
    const pe = M.pe.ParticleEmitter.prototype;
    this._origInitEnd = pe.initEnd;
    pe.initEnd = function () {
      const f = this._resolveAnchorFrame();
      const pre = {
        leo: this.lastEmitOffset.clone(), lastEmitTime: this.lastEmitTime, lastUpdateTime: this.lastUpdateTime,
        createdSlots: this._createdSlots | 0, anchorPos: f.position.clone(), anchorQuat: f.quaternion.clone(),
        now: M.time.currentTime(),
      };
      const op = { op: "add", e: self.emitters.length, pre, desc: null };
      self.eIndex.set(this, op.e);
      self.emitters.push(this);
      self.ops.push(op);
      self.pending.set(this, op);
      return self._origInitEnd.call(this);
    };
    const kp = M.kids.ParticleFxKids.prototype;
    this._origLayer = kp.layer;
    kp.layer = function (layer) {
      const had = this.layers.has(layer | 0);
      const l = self._origLayer.call(this, layer);
      if (!had) self.kidsCreated.push(layer | 0);
      return l;
    };
  }

  attach(h) {
    this.inputs = new this.M.bridge.RustParticleInputs(h.mgr, h.mgr._rustDeps());
    const self = this;
    const orig = h.mgr._makeBucketIm;
    h.mgr._makeBucketIm = function (emitter, gfx, layer, alpha) {
      const im = orig.call(this, emitter, gfx, layer, alpha);
      self.created.push({ im, emitter, gfx, layer, alpha });
      return im;
    };
    h.mgr._rustTickTap = (ctx) => this.onTick(h, ctx);
    // stop / destroy as the manager sees them (addEmitter's replace path destroys too)
    const origStop = h.mgr.stopParticleEmitter;
    h.mgr.stopParticleEmitter = function (id) {
      const e = this.particleTable.get(id);
      if (e && self.eIndex.has(e)) self.ops.push({ op: "stop", e: self.eIndex.get(e) });
      return origStop.call(this, id);
    };
    const origDestroy = h.mgr.destroyParticleEmitter;
    h.mgr.destroyParticleEmitter = function (id) {
      const e = this.particleTable.get(id);
      if (e && self.eIndex.has(e)) { self.ops.push({ op: "destroy", e: self.eIndex.get(e) }); self.fields.delete(e); }
      return origDestroy.call(this, id);
    };
  }

  restore() {
    this.M.pe.ParticleEmitter.prototype.initEnd = this._origInitEnd;
    this.M.kids.ParticleFxKids.prototype.layer = this._origLayer;
  }

  completeAdd(h, id) {
    const e = h.mgr.particleTable.get(id);
    if (!e) return;
    const op = this.pending.get(e);
    if (!op) throw new Error("addEmitter without a recorded initEnd");
    this.pending.delete(e);
    if (e._instKey === null || e._instKey === undefined) throw new Error("scenario emitter is not instanced");
    e._rustGeometry = h.gfx.get(e.info.hwGfxObjId >>> 0).geom;
    const routeId = this.inputs.routeIdFor(e);
    const d = this.inputs.describe(e, op.pre.now, routeId, op.pre);
    op.desc = f64arr(d);
    this.cached[op.e] = d[this.M.bridge.L.D_CACHED] === 1;
    delete op.pre;
    this.fields.set(e, this._fieldsOf(e));
  }

  _fieldsOf(e) {
    return [e.degradeDistance, e._forceDegrade === true ? 1 : 0, e._bbMode | 0, e.filmHidden === true ? 1 : 0];
  }

  beforeTick(h) {
    const L = this.M.bridge.L;
    const ids = [L.F_DEGRADE_DISTANCE, L.F_FORCE_DEGRADE, L.F_BB_MODE, L.F_FILM_HIDDEN];
    for (const [, e] of h.mgr.particleTable) {
      const prev = this.fields.get(e);
      if (!prev) continue;
      const cur = this._fieldsOf(e);
      for (let i = 0; i < 4; i++) {
        if (!Object.is(cur[i], prev[i])) this.ops.push({ op: "set", e: this.eIndex.get(e), field: ids[i], value: f64hex(cur[i]) });
      }
      this.fields.set(e, cur);
    }
  }

  onTick(h, ctx) {
    const L = this.M.bridge.L;
    const inputs = this.inputs;
    const anchors = [];
    const flags = [];
    const tmp = new Float64Array(L.ANCHOR_STRIDE);
    for (const [, e] of h.mgr.particleTable) {
      const idx = this.eIndex.get(e);
      if (idx === undefined || this.cached[idx]) continue;
      const fl = inputs.dynamicInputs(e, ctx, this.prevFlags.get(e) | 0, true, tmp, 0);
      this.prevFlags.set(e, fl);
      anchors.push([idx, f64arr(tmp)]);
      flags.push([idx, fl]);
    }
    const rv = new Float64Array(inputs.routeList.length * L.ROUTE_STRIDE);
    inputs.writeRoutes(rv);
    const kv = new Float64Array(inputs.keyList.length * L.KEY_STRIDE);
    inputs.writeKeys(kv);
    ctx.fxSeed = this.M.fx.particleFxSeedState();
    const g = inputs.writeGlobals(ctx);
    this.created.length = 0;
    this.kidsCreated.length = 0;
    this._tickOp = { op: "tick", globals: f64arr(g), anchors, flags, routes: f64arr(rv), keys: f64arr(kv), expect: null };
    this.ops.push(this._tickOp);
  }

  afterTick(h, snap) {
    const op = this._tickOp;
    this._tickOp = null;
    if (!op) return;
    const keyId = (key) => this.inputs.keyIds.get(key);
    const enc = (b) => ({ key: keyId(b.key) ?? -1, count: b.count, cap: b.cap, mat: f32arr(b.mat), col: f32arr(b.col) });
    const created = this.created.map((c) => [c.im.name.endsWith("-s") ? 1 : 0,
      keyId(`${c.gfx}|${c.layer}${c.alpha ? "|a" : ""}${c.emitter.skyGlow === true ? "|sky" : ""}`) ?? -1]);
    let sortCam = null;
    if (h.mgr._instSortCamWorld) {
      const v = h.mgr._instSortCamWorld.clone();
      h.group.worldToLocal(v);
      sortCam = f64arr([v.x, v.y, v.z]);
    }
    const idxOf = (e) => (e && this.eIndex.has(e) ? this.eIndex.get(e) : -1);
    op.expect = {
      own: snap.own.map(enc),
      shared: snap.shared.map(enc),
      created,
      kids: snap.kids.map((k) => ({ layer: k.layer, n: k.n, cap: k.cap, pos: f32arr(k.pos), vel: f32arr(k.vel), row: f32arr(k.row) })),
      kidsCreated: [...this.kidsCreated],
      removed: snap.removed.map(idxOf),
      stats: snap.stats,
      cellHidden: snap.cellHidden,
      seed: snap.seed,
      rngUsed: this.rec.values.length,
      sharedSortCam: sortCam,
      emitters: snap.emitters.map(([e, n, t, s, c]) => [idxOf(e), n, t, s, c]),
    };
  }
}

// ------------------------------------------------------------ scenarios

export const POJO = (over = {}) => ({
  id: 0x32fff000, emitterType: 1, particleType: 2, gfxObjId: 0, hwGfxObjId: 0x0100a001,
  birthrate: 0.05, maxParticles: 12, initialParticles: 2, totalParticles: 0, totalSeconds: 0,
  lifespan: 0.6, lifespanRand: 0.25, offsetDirX: 0, offsetDirY: 0, offsetDirZ: 1,
  minOffset: 0.05, maxOffset: 0.4, aX: 0.2, aY: 0.6, aZ: 1.1, minA: 0.6, maxA: 1.4,
  bX: 0.1, bY: -0.2, bZ: -0.8, minB: 0.8, maxB: 1.2, cX: 0.5, cY: 0.9, cZ: 1.6, minC: 0.7, maxC: 1.3,
  scaleRand: 0.15, startScale: 0.6, finalScale: 1.4, transRand: 0.1, startTrans: 0.2, finalTrans: 0.85,
  isParentLocal: false, billboard: false,
  ...over,
});

const quatOffset = (x, y, z, ax, ang) => ({
  position: new THREE.Vector3(x, y, z),
  quaternion: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(...ax).normalize(), ang),
});

/**
 * Every scenario: `async (h) => void`. They only use instanced emitters
 * (the kernel's domain) and drive the clock / camera / gates explicitly.
 */
export const SCENARIOS = {
  /** All particle types on frozen anchors, FX rows (kids + stretch), lazy growth, finite + persistent. */
  async types(h) {
    h.defGfx(0x0100a001);
    h.defGfx(0x0100a002, { size: 0.3 });
    h.defGfx(0x0100a003, { size: 0.8 });
    const anchors = [h.frozenAnchor(0, 0, 0), h.frozenAnchor(4, -3, 1, { yaw: 0.7 }), h.frozenAnchor(-5, 2, 0.5, { yaw: -1.3 })];
    // all 12 types + Unknown + a non-integer type, on three gfxobjs
    const types = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13.5];
    for (let i = 0; i < types.length; i++) {
      await h.add({
        anchor: anchors[i % 3],
        info: POJO({
          particleType: types[i], hwGfxObjId: [0x0100a001, 0x0100a002, 0x0100a003][i % 3],
          // FX rows: 0x3200000c (kids + stretch), 0x3200000b (stretch), else row 0
          id: i % 4 === 0 ? 0x3200000c : i % 4 === 1 ? 0x3200000b : 0x32fff000 + i,
          birthrate: 0.03 + 0.01 * (i % 3), maxParticles: i === 3 ? 24 : 10, initialParticles: i === 3 ? 1 : 2 + (i % 3),
        }),
        offset: i % 2 ? quatOffset(0.2 * i, -0.1, 0.3, [0.3, 1, 0.2], 0.4 + 0.1 * i) : null,
        renderLayer: i === 8 ? 1 : 0,
      });
    }
    // finite by count, finite by time, and a burst-only one-shot
    await h.add({ anchor: anchors[0], info: POJO({ totalParticles: 9, initialParticles: 3, birthrate: 0.02, particleType: 3, id: 0x3200000c, lifespan: 0.25, lifespanRand: 0.05 }) });
    await h.add({ anchor: anchors[1], info: POJO({ totalSeconds: 0.2, initialParticles: 1, birthrate: 0.02, particleType: 11, lifespan: 0.25, lifespanRand: 0.05 }) });
    await h.add({ anchor: anchors[2], info: POJO({ totalParticles: 5, initialParticles: 5, birthrate: 9, particleType: 6, lifespan: 0.2, lifespanRand: 0.02 }) });
    for (let i = 0; i < 46; i++) await h.tick(i % 7 === 3 ? 1 / 30 : 1 / 60);
  },

  /** Billboards (sprite + retail modes 2/4/5), the shared alpha bucket, own alpha buckets (sorted in the kernel). */
  async facing(h) {
    h.defGfx(0x0100b001, { bbMode: 2 });
    h.defGfx(0x0100b002, { bbMode: 5, alpha: true });
    h.defGfx(0x0100b003, { bbMode: 4 });
    h.defGfx(0x0100b004, { alpha: true });
    h.defGfx(0x0100b005, { alpha: true, bbMode: 3 });
    const a0 = h.frozenAnchor(1, 1, 0, { yaw: 0.4, partFrames: [[0, 0, 1.5, 0.3], [0.5, -0.2, 2.5, -0.6]] });
    const a1 = h.frozenAnchor(-3, 4, 2, { yaw: 2.1 });
    await h.add({ anchor: a0, info: POJO({ hwGfxObjId: 0x0100b001, particleType: 1, billboard: false }) });
    await h.add({ anchor: a0, partIndex: 1, info: POJO({ hwGfxObjId: 0x0100b002, particleType: 2, initialParticles: 3 }) });
    await h.add({ anchor: a1, info: POJO({ hwGfxObjId: 0x0100b003, particleType: 8 }) });
    h.defGfx(0x0100a00f, {});
    await h.add({ anchor: a1, info: POJO({ hwGfxObjId: 0x0100a00f, particleType: 1, billboard: true }) });
    await h.add({ anchor: a1, info: POJO({ hwGfxObjId: 0x0100a00f, particleType: 12, billboard: true, id: 0x3200000c }) });
    await h.add({ anchor: a0, partIndex: 0, info: POJO({ hwGfxObjId: 0x0100b004, particleType: 2, maxParticles: 16, initialParticles: 6 }) });
    await h.add({ anchor: a1, info: POJO({ hwGfxObjId: 0x0100b004, particleType: 10, maxParticles: 16, initialParticles: 6 }) });
    await h.add({ anchor: a1, info: POJO({ hwGfxObjId: 0x0100b005, particleType: 9 }) });
    for (let i = 0; i < 24; i++) {
      h.cam.position.set(30 * Math.cos(i * 0.21), 12 + i * 0.3, 30 * Math.sin(i * 0.21));
      h.cam.lookAt(0, 0, 0);
      if (i === 10) {
        // same gfxobj, another base material (texture): the shared bucket
        // rejects it on the material signature → the manager's own bucket
        const g = h.gfx.get(0x0100b004);
        const tex2 = new THREE.DataTexture(new Uint8Array(4 * 4 * 4).fill(200), 4, 4);
        g.mat = new THREE.MeshBasicMaterial({ map: tex2, transparent: true, side: THREE.DoubleSide });
        g.mat.userData = { __cacheOwned: true, surfaceTypeFlags: 0x100 };
        await h.add({ anchor: a1, info: POJO({ hwGfxObjId: 0x0100b004, particleType: 3, initialParticles: 4 }) });
      }
      if (i === 14) h.M.fx.setParticleFxLive(false); // window.__particleFx(false): row 0 everywhere
      if (i === 18) h.M.fx.setParticleFxLive(true);
      await h.tick();
    }
    // own alpha buckets: the shared registry off (they then sort in the kernel)
    h.M.pm.setParticleSharedAlphaFlag(false);
    for (let i = 0; i < 14; i++) {
      h.cam.position.set(-25 + i, 9, 20 - 2 * i);
      h.cam.lookAt(0, 0, 0);
      await h.tick();
    }
    h.M.pm.setParticleSharedAlphaFlag(null);
  },

  /** RP6: frustum + distance culls, persistent freeze / thaw, finite virtual emission, force stop, degrade. */
  async cull(h) {
    h.defGfx(0x0100c001, { degrade: 40 });
    h.defGfx(0x0100c002, {});
    const near = h.frozenAnchor(0, 0, 0);
    const far = h.frozenAnchor(150, 0, 0);
    const behind = h.frozenAnchor(0, -80, 0);
    await h.add({ anchor: near, info: POJO({ hwGfxObjId: 0x0100c001, particleType: 2 }) }); // persistent
    await h.add({ anchor: far, info: POJO({ hwGfxObjId: 0x0100c002, particleType: 3, totalParticles: 40, birthrate: 0.08 }) });
    await h.add({ anchor: behind, info: POJO({ hwGfxObjId: 0x0100c002, particleType: 1, totalSeconds: 2.5 }) });
    await h.add({ anchor: behind, info: POJO({ hwGfxObjId: 0x0100c002, particleType: 2, totalParticles: 400, birthrate: 9 }) });
    await h.add({ anchor: far, info: POJO({ hwGfxObjId: 0x0100c001, particleType: 5, degradeDistanceMeters: 60 }) });
    const moving = h.movingAnchor(5, 5, 0);
    await h.add({ anchor: moving, info: POJO({ hwGfxObjId: 0x0100c002, particleType: 2 }) }); // dynamic RP6
    const pm = h.M.pm;
    const live = globalThis.window.liveScene3d;
    for (let i = 0; i < 90; i++) {
      // sweep: look at the origin, then away (+x far side), then back
      const phase = Math.floor(i / 12) % 3;
      if (phase === 0) { h.cam.position.set(0, 30, 60); h.cam.lookAt(0, 0, 0); }
      else if (phase === 1) { h.cam.position.set(0, 30, 60); h.cam.lookAt(0, 30, 200); }
      else { h.cam.position.set(120, 20, 40); h.cam.lookAt(150, 0, 0); }
      moving.position.set(5 + 0.2 * i, 5, Math.sin(i * 0.3));
      // RP6 variants: lean off, stagger off, the half-interval phase, freeze off, no camera
      if (i === 44) pm.setParticleCulledLeanFlag(false);
      if (i === 52) { pm.setParticleCulledLeanFlag(null); pm.setRp6StaggerFlag(false); }
      if (i === 60) { pm.setRp6StaggerFlag(null); h.mgr._frameDupDrivers = true; }
      if (i === 68) { h.mgr._frameDupDrivers = false; pm.setParticleCullFreezeFlag(false); }
      if (i === 76) { pm.setParticleCullFreezeFlag(null); globalThis.window.liveScene3d = null; }
      if (i === 80) globalThis.window.liveScene3d = live;
      // the clock jumps to pass culledStopSeconds (30 s) mid-scenario
      await h.tick(i >= 30 && i < 42 ? 3.0 : 1 / 60);
    }
  },

  /** Moving anchors: parent-local + part-anchored emitters, BirthratePerMeter, cell gate, film hide, stop / destroy / replace. */
  async dynamic(h) {
    h.defGfx(0x0100d001, {});
    h.defGfx(0x0100d002, { alpha: true });
    const rig = h.movingAnchor(0, 0, 0, { parts: 2 });
    const idLocal = await h.add({ anchor: rig, info: POJO({ hwGfxObjId: 0x0100d001, particleType: 2, isParentLocal: true }) });
    const idPart = await h.add({ anchor: rig, partIndex: 1, offset: quatOffset(0.1, 0, 0.2, [0, 0, 1], 0.5),
      info: POJO({ hwGfxObjId: 0x0100d001, particleType: 9, isParentLocal: true, id: 0x3200000c }) });
    const idMeter = await h.add({ anchor: rig, partIndex: 0,
      info: POJO({ hwGfxObjId: 0x0100d002, particleType: 1, emitterType: 2, birthrate: 0.15, maxParticles: 30, initialParticles: 0 }) });
    const cellA = h.cellAnchor(3, 3, 0, 0x01d40105);
    const idCell = await h.add({ anchor: cellA, info: POJO({ hwGfxObjId: 0x0100d001, particleType: 5 }) });
    const idFilm = await h.add({ anchor: h.frozenAnchor(-2, 1, 0), info: POJO({ hwGfxObjId: 0x0100d002, particleType: 7 }) });
    const idStop = await h.add({ anchor: h.frozenAnchor(2, -1, 0), info: POJO({ hwGfxObjId: 0x0100d001, particleType: 4 }) });
    for (let i = 0; i < 50; i++) {
      rig.position.set(0.25 * i, Math.sin(i * 0.2) * 2, 0.05 * i);
      rig.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), 0.08 * i);
      for (const k of rig.userData.partKids) k.rotation.x = 0.1 * i;
      rig.updateMatrixWorld(true);
      h.cells.get(0x01d40105).visible = (i % 9) < 5;
      if (i === 8) h.mgr.particleTable.get(idFilm).filmHidden = true;
      if (i === 15) h.mgr.particleTable.get(idFilm).filmHidden = false;
      if (i === 12) h.stop(idStop);
      if (i === 20) h.destroy(idCell);
      if (i === 26) {
        // replace a live id (destroy + rebuild at the end of the table)
        await h.add({ anchor: rig, emitterId: idLocal, info: POJO({ hwGfxObjId: 0x0100d001, particleType: 12, isParentLocal: true }) });
      }
      if (i === 33) h.stop(idPart);
      await h.tick(i % 5 === 0 ? 1 / 45 : 1 / 60);
    }
    void idMeter;
  },

  /** Bucket growth past 256 instances (own + shared), and buckets created mid-tick in emitter order. */
  async grow(h) {
    // ?particleFx off: stock buckets, (op, op, op) instance colours
    h.M.fx.setParticleFxFlag(false);
    h.defGfx(0x0100e001, {});
    h.defGfx(0x0100e002, { alpha: true });
    h.defGfx(0x0100e003, {});
    const a = h.frozenAnchor(0, 0, 0);
    for (let i = 0; i < 3; i++) {
      await h.add({ anchor: a, info: POJO({ hwGfxObjId: 0x0100e001, particleType: 1, maxParticles: 140, initialParticles: 100, birthrate: 0.001, lifespan: 50, lifespanRand: 0 }) });
    }
    await h.add({ anchor: a, info: POJO({ hwGfxObjId: 0x0100e002, particleType: 2, maxParticles: 300, initialParticles: 270, birthrate: 0.001, lifespan: 50, lifespanRand: 0, id: 0x3200000b }) });
    for (let i = 0; i < 6; i++) {
      if (i === 3) await h.add({ anchor: a, info: POJO({ hwGfxObjId: 0x0100e003, particleType: 2 }) });
      await h.tick();
    }
    h.M.fx.setParticleFxFlag(null);
  },
};

/**
 * Node-only (tests/rust_particles_parity.test.mjs): the runtime instancing
 * toggle (`setInstancing(false)` hands kernel emitters back to JS with their
 * state, `true` re-instances them on the JS path) and `emitter.parts` reads.
 */
export const NODE_ONLY_SCENARIOS = {
  /**
   * The static and the world manager both append to the SHARED alpha bucket
   * (`?particleSharedAlpha`, default ON) in one frame: start offsets, one
   * creator, the grow by the second manager, and both finalizes re-sorting the
   * combined bucket.
   */
  async twoManagers(h) {
    const g2 = new THREE.Group();
    h.world.add(g2);
    h.root.updateMatrixWorld(true);
    const world = h.addManager(g2);
    h.defGfx(0x01009001, { alpha: true });
    h.defGfx(0x01009002, {});
    const a = h.frozenAnchor(0, 0, 0);
    const rig = h.movingAnchor(1, 2, 0);
    await h.add({ anchor: a, info: POJO({ hwGfxObjId: 0x01009001, particleType: 2, maxParticles: 120, initialParticles: 100, lifespan: 9, lifespanRand: 0 }) });
    await h.add({ anchor: a, info: POJO({ hwGfxObjId: 0x01009002, particleType: 5, id: 0x3200000c }) });
    await h.add({ mgr: world, anchor: rig, info: POJO({ hwGfxObjId: 0x01009001, particleType: 10, maxParticles: 220, initialParticles: 170, lifespan: 9, lifespanRand: 0 }) });
    await h.add({ mgr: world, anchor: rig, info: POJO({ hwGfxObjId: 0x01009002, particleType: 2, isParentLocal: true, id: 0x3200000c }) });
    for (let i = 0; i < 20; i++) {
      rig.position.set(1 + 0.3 * i, 2, 0.1 * i);
      h.cam.position.set(20 * Math.cos(i * 0.3), 10, 20 * Math.sin(i * 0.3));
      h.cam.lookAt(0, 0, 0);
      await h.tick();
    }
  },

  async toggle(h) {
    h.snapSlots = true;
    h.defGfx(0x0100f001, {});
    h.defGfx(0x0100f002, { alpha: true, bbMode: 2 });
    const a = h.frozenAnchor(0, 0, 0);
    const rig = h.movingAnchor(2, 0, 0);
    await h.add({ anchor: a, info: POJO({ hwGfxObjId: 0x0100f001, particleType: 3, id: 0x3200000c, maxParticles: 20, initialParticles: 2 }) });
    await h.add({ anchor: a, info: POJO({ hwGfxObjId: 0x0100f002, particleType: 2, maxParticles: 14 }) });
    await h.add({ anchor: rig, info: POJO({ hwGfxObjId: 0x0100f001, particleType: 12, isParentLocal: true, totalParticles: 30 }) });
    for (let i = 0; i < 40; i++) {
      rig.position.set(2 + 0.1 * i, 0, 0.02 * i);
      if (i === 15) h.mgr.setInstancing(false);
      if (i === 27) h.mgr.setInstancing(true);
      await h.tick();
    }
  },

  /**
   * Two same-id creates that overlap (`?particleOwner=off` callers pass
   * explicit ids; both pass addEmitter's replace check before either awaits):
   * the second resolve overwrites the first's table entry in place. The JS
   * loop never walks the orphan again; the bridge drops it from the kernel and
   * runs the newcomer at the orphan's table position (SceneParticles
   * .addEmitterAt — an emitter created meanwhile sits after it). Records
   * `h.sameIdInfo` for tests/rust_particles_parity.test.mjs.
   */
  async sameId(h) {
    h.defGfx(0x01008001, {});
    h.defGfx(0x01008002, { alpha: true });
    const a = h.frozenAnchor(0, 0, 0);
    const rig = h.movingAnchor(2, 1, 0, { parts: 2 });
    await h.add({ anchor: a, info: POJO({ hwGfxObjId: 0x01008001, particleType: 2 }) });
    const br = h.mgr._rust;
    const regs = [];
    const reg0 = br ? br.register : null;
    if (br) br.register = function (s, now, before) { regs.push([s, before]); return reg0.call(this, s, now, before); };
    const req = (emitterId, anchor, partIndex, info) => ({
      emitterInfo: info, parent: anchor, partIndex, parentOffset: null, emitterId, renderLayer: 0, skyGlow: false,
    });
    h.useRngOf(h.mgr);
    // A finishes (count-bounded, short-lived) long before the survivor is destroyed
    const pA = h.mgr.addEmitter(req(77, a, -1, POJO({ hwGfxObjId: 0x01008001, particleType: 3, totalParticles: 4, initialParticles: 2, birthrate: 0.02, lifespan: 0.15, lifespanRand: 0 })));
    const pY = h.mgr.addEmitter(req(0, rig, 1, POJO({ hwGfxObjId: 0x01008002, particleType: 1 })));
    const pB = h.mgr.addEmitter(req(77, rig, 0, POJO({ hwGfxObjId: 0x01008001, particleType: 10, isParentLocal: true, initialParticles: 3 })));
    await Promise.all([pA, pY, pB]);
    await flush();
    if (br) br.register = reg0;
    const survivor = h.mgr.particleTable.get(77) || null;
    const shells = [...h.mgr.particleTable.values()].filter((e) => e._rustShell === true && e._rustHandle >= 0).length;
    h.sameIdInfo = {
      tableIds: [...h.mgr.particleTable.keys()].join(","),
      survivorPersistent: !!survivor && survivor.info.totalParticles === 0 && survivor.info.totalSeconds === 0,
      orphans: regs.filter(([s]) => s.id === 77 && s !== survivor).length,
      orphanInKernel: regs.some(([s]) => s.id === 77 && s !== survivor && s._rustHandle >= 0),
      placedBefore: regs.some(([s, before]) => s === survivor && before !== null),
      kernelEmitters: br ? br.emitterCount : null,
      tableShells: shells,
      removed: [],
    };
    for (let i = 0; i < 40; i++) {
      rig.position.set(2 + 0.15 * i, 1, 0.03 * i);
      for (const k of rig.userData.partKids) k.rotation.x = 0.12 * i;
      rig.updateMatrixWorld(true);
      if (i === 30) h.destroy(77); // the survivor still destroys by id
      const snap = await h.tick();
      for (const e of snap.removed) if (e) h.sameIdInfo.removed.push(`${i}:${e.id}`);
    }
  },

  /**
   * Moving-rig (dynamic) emitters while RP6-culled or unable to emit — the
   * anchor-need bits (layout NEED_*): culled persistent parent-local and
   * per-second emitters read no anchor; one stopped while culled drains with
   * its moving anchor; saturated per-second / per-metre emitters need one only
   * when a slot is free or may free; then back in view. `h.anchorResolves`
   * counts `_resolveAnchorFrame` calls per `${phase}:${name}`.
   */
  async culledDynamic(h) {
    h.defGfx(0x01007001, {});
    h.defGfx(0x01007002, { alpha: true });
    const rigs = [];
    for (let i = 0; i < 6; i++) rigs.push(h.movingAnchor(3 * i - 7, 2, 0, { parts: 2 }));
    const move = (t) => rigs.forEach((rig, i) => {
      rig.position.set(3 * i - 7 + 0.1 * t, 2 + Math.sin(0.2 * t + i), 0.02 * t);
      for (const k of rig.userData.partKids) k.rotation.x = 0.1 * t + 0.3 * i;
      rig.updateMatrixWorld(true);
    });
    const names = new Map();
    const counts = new Map();
    h.anchorResolves = counts;
    let phase = "setup";
    const PE = h.M.pe.ParticleEmitter.prototype;
    const orig = PE._resolveAnchorFrame;
    PE._resolveAnchorFrame = function () {
      const k = `${phase}:${names.get(this.id) ?? "?"}`;
      counts.set(k, (counts.get(k) || 0) + 1);
      return orig.call(this);
    };
    try {
      const add = async (name, spec) => { const id = await h.add(spec); names.set(id, name); return id; };
      const plPart = await add("plPart", { anchor: rigs[0], partIndex: 1, info: POJO({ hwGfxObjId: 0x01007001, particleType: 2, isParentLocal: true, maxParticles: 8, initialParticles: 4, lifespan: 2 }) });
      await add("plRoot", { anchor: rigs[1], info: POJO({ hwGfxObjId: 0x01007001, particleType: 9, isParentLocal: true, id: 0x3200000c, lifespan: 2 }) });
      await add("secSat", { anchor: rigs[2], partIndex: 0, info: POJO({ hwGfxObjId: 0x01007002, particleType: 3, maxParticles: 6, initialParticles: 6, birthrate: 0.02, lifespan: 1.5, lifespanRand: 0.4 }) });
      await add("meter", { anchor: rigs[3], partIndex: 1, info: POJO({ hwGfxObjId: 0x01007001, particleType: 1, emitterType: 2, birthrate: 0.05, maxParticles: 5, initialParticles: 0, lifespan: 1.2 }) });
      await add("finitePl", { anchor: rigs[4], info: POJO({ hwGfxObjId: 0x01007001, particleType: 2, isParentLocal: true, totalParticles: 30, birthrate: 0.04 }) });
      await add("secFixed", { anchor: rigs[5], partIndex: 0, info: POJO({ hwGfxObjId: 0x01007002, particleType: 10, maxParticles: 4, initialParticles: 4, birthrate: 0.01, lifespan: 0.9, lifespanRand: 0 }) });
      let t = 0;
      phase = "warm";
      for (let i = 0; i < 8; i++) { move(t++); await h.tick(); }
      phase = "culled"; // look away: every rig RP6-culled from its next due tick
      h.cam.position.set(0, 30, 60);
      h.cam.lookAt(0, 30, 400);
      for (let i = 0; i < 30; i++) {
        move(t++);
        if (i === 12) h.stop(plPart); // stopped while culled: drains with the moving anchor
        await h.tick();
      }
      phase = "visible";
      h.cam.position.set(0, 30, 60);
      h.cam.lookAt(0, 0, 0);
      for (let i = 0; i < 40; i++) { move(t++); await h.tick(i % 6 === 5 ? 1 / 30 : 1 / 60); }
    } finally {
      PE._resolveAnchorFrame = orig;
    }
  },

  /**
   * Film mode's particle query (scene3d/film/scene/particles_query.js) read
   * every tick: the spheres + samples it builds (`snapshot()`, `near()`) per
   * tick into `h.filmRows`, and the proxy slot meshes that left behind
   * (`h.filmProxies`; the kernel path reads `filmSample`, never `parts`).
   */
  async film(h) {
    const { createParticlesQuery } = await import("../../scene3d/film/scene/particles_query.js");
    h.defGfx(0x01006001, {});
    h.defGfx(0x01006002, { alpha: true, size: 0.7 });
    const a0 = h.frozenAnchor(0, 0, 0.5);
    const a1 = h.frozenAnchor(6, -2, 1, { yaw: 0.6 });
    const rig = h.movingAnchor(-3, 2, 0, { parts: 2 });
    await h.add({ anchor: a0, info: POJO({ hwGfxObjId: 0x01006001, particleType: 2, maxParticles: 16, initialParticles: 6, lifespan: 2 }) });
    // fades below the sample floor (op ≤ 0.02) over its life
    await h.add({ anchor: a1, info: POJO({ hwGfxObjId: 0x01006002, particleType: 3, maxParticles: 10, initialParticles: 4, startTrans: 0.97, finalTrans: 0.995 }) });
    await h.add({ anchor: rig, partIndex: 1, info: POJO({ hwGfxObjId: 0x01006001, particleType: 10, isParentLocal: true }) });
    const idFinite = await h.add({ anchor: a1, info: POJO({ hwGfxObjId: 0x01006002, particleType: 1, totalParticles: 8, birthrate: 0.03, lifespan: 0.3 }) });
    const idHide = await h.add({ anchor: a0, info: POJO({ hwGfxObjId: 0x01006001, particleType: 12, maxParticles: 9 }) });
    const q = createParticlesQuery({ liveScene3d: null, THREE, managers: () => h.mgrs, frameKey: () => h.frame });
    h.filmRows = [];
    for (let i = 0; i < 36; i++) {
      rig.position.set(-3 + 0.2 * i, 2, 0.05 * i);
      for (const k of rig.userData.partKids) k.rotation.x = 0.1 * i;
      rig.updateMatrixWorld(true);
      if (i === 8) h.mgr.particleTable.get(idHide).filmHidden = true;
      if (i === 20) h.mgr.particleTable.get(idHide).filmHidden = false;
      await h.tick();
      const rows = q.snapshot().map((s) => [s.key, s.did, s.center, s.radius, s.density, s.parts]);
      const near = q.near([0, 0, 0.5], 2.5).map((r) => [r.key, r.range]);
      h.filmRows.push(JSON.stringify([rows, near]));
    }
    void idFinite;
    let proxies = 0;
    for (const [, e] of h.mgr.particleTable) proxies += e._rustProxy ? e._rustProxy.meshes.length : 0;
    h.filmProxies = proxies;
  },
};

/** The legacy escape scenario (run with ?swarmAce=on&particleInitAce=on&particleRotAce=on&particleInitFrameAce=on). */
export const LEGACY_SEARCH = "?swarmAce=on&particleInitAce=on&particleRotAce=on&particleInitFrameAce=on";
export const LEGACY_SCENARIOS = { legacy: SCENARIOS.types };

/** Run one scenario in this process, recording a fixture (JS reference). */
export async function recordScenario(M, name, fn) {
  const rec = recordRng(0x5eed0000 + name.length * 7919);
  M.time.setRng(rec.rng);
  const recorder = new Recorder(M, null, rec);
  let h;
  try {
    h = new Harness(M, { recorder });
    recorder.attach(h);
    await fn(h);
  } finally {
    recorder.restore();
    M.time.setRng(null);
  }
  return {
    scenario: name,
    three: THREE.REVISION,
    config: f64arr(M.bridge.particleConfigBlock()),
    seed0: FX_SEED0 >>> 0,
    rng: f64arr(rec.values),
    ops: recorder.ops,
  };
}

async function main() {
  const legacy = process.argv.includes("--legacy");
  installGlobals(legacy ? LEGACY_SEARCH : "");
  const M = await loadModules();
  const set = legacy ? LEGACY_SCENARIOS : SCENARIOS;
  for (const [name, fn] of Object.entries(set)) {
    const fx = await recordScenario(M, name, fn);
    const p = writeFixture(`particles_${name}`, fx);
    const ticks = fx.ops.filter((o) => o.op === "tick").length;
    const adds = fx.ops.filter((o) => o.op === "add").length;
    console.log(`particles_${name}: ${adds} emitters, ${ticks} ticks, ${fx.rng.length} draws → ${p}`);
  }
  if (!legacy) {
    const r = spawnSync(process.execPath, [SELF, "--legacy"], { stdio: "inherit" });
    if (r.status !== 0) process.exit(r.status ?? 1);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
