// scene3d/rust/particles.js — lane A of the Rust scene core: instanced
// particle emitters simulated by `SceneParticles` (src/scene_wasm/particles.rs
// over crates/holtburger-scene/src/particles/). Lane notes:
// docs/2026-10-26-rust-particles.md. Contract: docs/2026-10-26-rust-scene-core.md.
//
// `?rustParticles` (rustFlag, DEFAULT OFF since 2026-10-29 — ON 10-26..29; `=on` opts in). When on and the pkg
// carries SceneParticles, ParticleManager hands every emitter that takes the
// INSTANCED path to one RustParticles per manager:
//   - addEmitter builds the JS ParticleEmitter as a "shell" (parent, offsets,
//     info, bucket keying, tier-1 light, film/diag fields) with no slot meshes
//     or Particles, and registers it here (the kernel runs initEnd).
//   - _tickLatched calls tick(ctx) ONCE, before its JS loop (which then only
//     walks the per-mesh emitters). tick() writes the inputs (dynamic anchors,
//     the JS RP6 / cell-gate decisions of dynamic emitters, the route + bucket
//     tables, the globals), runs the kernel, then replays its events in order
//     (bucket create / acquire / grow, kids manager + layers — so three.js
//     objects are created exactly when and in the order the JS path creates
//     them) and copies each bucket's instances in with one `set` per bucket.
//   - finished emitters come back for the manager's normal removal path.
// Everything the JS path computes from three.js objects stays in JS and is
// handed in (anchors through `_resolveAnchorFrame`, RP6 spheres through
// `rp6CullSphere`, the frustum planes, camera positions, cell visibility).

import * as THREE from "three";

import { sceneWasmClass, sceneCoreAvailable, WasmF32View, WasmF64View, WasmU32View, rustFlag } from "./scene_core.js";
import { initEndBurst } from "../particles/particle_emitter.js";
import { Particle, particleLegacyFlags } from "../particles/particle.js";
import {
  particleFxEnabled,
  particleFxLive,
  particleFxMotionOn,
  particleFxSeedState,
  particleFxTeleportSpeedSq,
  particleFxTier1,
  particleFxTier2,
  particleFxTier2Latched,
  setParticleFxSeedState,
} from "../particles/particle_fx.js";
import { fxTier2Enabled } from "../vfx/fx_tier2.js";

/** The kernel's buffer layout (crates/holtburger-scene/src/particles/layout.rs). */
export const L = Object.freeze({
  CFG_SWARM_ACE: 0, CFG_INIT_ACE: 1, CFG_ROT_EULER: 2, CFG_INIT_FRAME_ACE: 3, CFG_LEN: 4,

  D_ID: 0, D_EMITTER_TYPE: 1, D_PARTICLE_TYPE: 2, D_BIRTHRATE: 3, D_MAX_PARTICLES: 4,
  D_TOTAL_PARTICLES: 5, D_TOTAL_SECONDS: 6, D_LIFESPAN: 7, D_LIFESPAN_RAND: 8, D_OFFSET_DIR: 9,
  D_MIN_OFFSET: 12, D_MAX_OFFSET: 13, D_A: 14, D_MIN_A: 17, D_MAX_A: 18, D_B: 19, D_MIN_B: 22,
  D_MAX_B: 23, D_C: 24, D_MIN_C: 27, D_MAX_C: 28, D_SCALE_RAND: 29, D_START_SCALE: 30,
  D_FINAL_SCALE: 31, D_TRANS_RAND: 32, D_START_TRANS: 33, D_FINAL_TRANS: 34, D_PARENT_LOCAL: 35,
  D_BILLBOARD: 36, D_PO_POS: 37, D_PO_QUAT: 40, D_LAST_EMIT_OFFSET: 44, D_LAST_EMIT_TIME: 47,
  D_LAST_UPDATE_TIME: 48, D_CREATED_SLOTS: 49, D_INIT_NOW: 50, D_BURST: 51, D_ANCHOR_POS: 52,
  D_ANCHOR_QUAT: 55, D_CACHED: 59, D_RP6_CENTER: 60, D_RP6_RADIUS: 63, D_DEGRADE_DISTANCE: 64,
  D_FORCE_DEGRADE: 65, D_ROUTE: 66, D_SHARED_ELIGIBLE: 67, D_FX_IF_CREATE: 68, D_ROW: 69,
  D_KIDS_ROW: 70, D_STRETCH_ROW: 71, D_VEL_LIM_SQ: 72, D_RENDER_LAYER: 73, D_BB_MODE: 74,
  D_HAS_BB_NORMAL: 75, D_BB_NORMAL: 76, D_FILM_HIDDEN: 79, D_RP6_CULLED: 80, D_LEN: 81,

  F_DEGRADE_DISTANCE: 1, F_FORCE_DEGRADE: 2, F_BB_MODE: 3, F_FILM_HIDDEN: 4, F_STOPPED: 5, F_ID: 6,
  F_RP6_CX: 7, F_RP6_CY: 8, F_RP6_CZ: 9, F_RP6_RADIUS: 10,

  G_NOW: 0, G_FRAME: 1, G_INTERVAL: 2, G_RECHECK: 3, G_STAGGER: 4, G_HALF_PHASE: 5,
  G_CAMERA_VALID: 6, G_CAM_POS: 7, G_PLANES: 10, G_MAX_DISTANCE: 34, G_DEGRADE_ON: 35,
  G_DEGRADE_CAP_ON: 36, G_CULL_FREEZE: 37, G_LEAN_CULLED: 38, G_CULLED_STOP_SECONDS: 39,
  G_CELL_GATE: 40, G_BB_ON: 41, G_BB_CAM: 42, G_BB_CAM_LOCAL: 45, G_SORT_ON: 48, G_SORT_CAM: 49,
  G_FX_ENABLED: 52, G_FX_LIVE: 53, G_KIDS_ON: 54, G_MOTION_ON: 55, G_SHARED_ON: 56, G_FX_SEED: 57,
  G_LEN: 58,

  ANCHOR_STRIDE: 7, FLAG_CULLED: 1, FLAG_CELL_HIDDEN: 2, NEED_NEVER: 0, NEED_ALWAYS: 1, NEED_IF_DUE: 2,
  NEED_SKIP_IF_CULLED: 4, NEED_IF_SLOT: 8, NEED_SLOT_MARGIN_US: 1000,
  ROUTE_STRIDE: 2,
  K_OWN_EXISTS: 0, K_OWN_CAP: 1, K_OWN_FX: 2, K_SH_EXISTS: 3, K_SH_SIG: 4, K_SH_SCENE_OK: 5,
  K_SH_CAP: 6, K_SH_START_N: 7, K_SH_FX: 8, K_ALPHA: 9, KEY_STRIDE: 10,

  EV_STRIDE: 3, EV_OWN: 1, EV_SHARED: 2, EV_GROW_OWN: 3, EV_GROW_SHARED: 4, EV_KIDS_MGR: 5,
  EV_KIDS_LAYER: 6, BK_STRIDE: 4, BK_OWN: 0, BK_SHARED: 1, MAT_STRIDE: 16, COL_STRIDE: 3,
  KL_STRIDE: 3, KID_STRIDE: 10,
  S_FORCE_STOPPED: 0, S_CELL_HIDDEN: 1, S_CELL_PARTICLE_TICKS: 2, S_REJECTED_SCENE: 3,
  S_REJECTED_MAT: 4, S_FX_SEED: 5, S_LEN: 6,

  Q_NUM_PARTICLES: 0, Q_TOTAL_EMITTED: 1, Q_CREATION_TIME: 2, Q_LAST_EMIT_TIME: 3,
  Q_LAST_UPDATE_TIME: 4, Q_STOPPED: 5, Q_CREATED_SLOTS: 6, Q_CULLED: 7, Q_LAST_EMIT_OFFSET: 8,
  Q_FROZEN_AT: 11, Q_CULLED_SINCE: 12, Q_GROWING: 13, Q_LEN: 14,

  SL_LIVE: 0, SL_VISIBLE: 1, SL_OP: 2, SL_POS: 3, SL_QUAT: 6, SL_SCALE: 10,
  SL_LAST_UPDATE_TIME: 11, SL_BIRTHTIME: 12, SL_LIFESPAN: 13, SL_LIFETIME: 14, SL_SF_POS: 15,
  SL_SF_QUAT: 18, SL_OFFSET: 22, SL_A: 25, SL_B: 28, SL_C: 31, SL_START_SCALE: 34,
  SL_FINAL_SCALE: 35, SL_START_TRANS: 36, SL_FINAL_TRANS: 37, SL_SEED: 38, SL_LIFE: 39,
  SL_VEL: 40, SL_KID_PREV: 48, SL_STRIDE: 53,

  FS_X: 0, FS_SCALE: 3, FS_OP: 4, FS_STRIDE: 5,
});

/** NEED_IF_SLOT's margin in seconds. */
const NEED_SLOT_MARGIN = L.NEED_SLOT_MARGIN_US * 1e-6;
/** `sigIds` is re-interned from scratch (at a tick boundary) past this size. */
const SIG_INTERN_CAP = 4096;
/** film/scene/particles_query.js `sphereOf`'s opacity floor for a sample. */
export const FILM_SAMPLE_OP_MIN = 0.02;

/** `?rustParticles` — DEFAULT OFF again since 2026-10-29 (`=on` opts in). DEFAULT ON 2026-10-26..29; the
 *  1070 measured it as the one stage-1 loss: +1.13 ms/frame main thread in 3 of 3 interleaved CPU-profile
 *  pairs at the Holtburg orbit (particles 2.34 / 2.54 / 2.44 vs 1.23 / 1.40 / 1.30 ms; the per-emitter
 *  input marshalling in this bridge, `tick` + `dynamicInputs`, costs more than the JS simulation it
 *  replaces). Round 3 replaces CPU particles with shader-evaluated ones (docs/2026-10-29-round3-gpu-driven.md
 *  R3-7). batch-RC (docs/reengineering/queue-1070/) holds the numbers. */
export function rustParticlesEnabled() {
  return rustFlag("rustParticles", false);
}

/** The pkg's SceneParticles class, or null (stale / missing pkg ⇒ JS path). */
export function sceneParticlesClass() {
  return sceneWasmClass("SceneParticles");
}

/**
 * True while `?rustParticles` is on but boot has not yet published the wasm
 * namespace: a manager that asked too early asks again on its next emitter
 * instead of keeping the JS path for the session.
 */
export function rustParticlesPending() {
  return rustParticlesEnabled() && !sceneCoreAvailable();
}

/** The kernel config block from particle.js's module-load escapes. */
export function particleConfigBlock() {
  const f = particleLegacyFlags();
  const c = new Float64Array(L.CFG_LEN);
  c[L.CFG_SWARM_ACE] = f.swarmAce ? 1 : 0;
  c[L.CFG_INIT_ACE] = f.initAce ? 1 : 0;
  c[L.CFG_ROT_EULER] = f.rotEuler ? 1 : 0;
  c[L.CFG_INIT_FRAME_ACE] = f.initFrameAce ? 1 : 0;
  return c;
}

/** A shell whose anchor (and RP6 sphere) cannot move: a frozen static anchor. */
export function shellIsCached(shell) {
  const ud = shell && shell.parent ? shell.parent.userData : null;
  if (!ud || ud.__anchorFrozen !== true || ud.__ballistic === true) return false;
  return ud.cellId === undefined || ud.cellId === null;
}

const _v3 = new THREE.Vector3();
const _sceneInv = new THREE.Matrix4();
const _camLocal = new THREE.Vector3();

/**
 * The per-manager input side, pure JS (no wasm): interning of bucket keys,
 * routes and material signatures, the emitter descriptor, and the per-tick
 * globals + dynamic inputs. The real bridge and the fixture recorder
 * (tools/rust_parity/gen_particles.mjs) share it, so the fixtures carry
 * exactly what the bridge would hand the kernel.
 */
export class RustParticleInputs {
  constructor(mgr, deps) {
    this.mgr = mgr;
    this.deps = deps;
    /** keyStr → id; id → { keyStr, gfx, layer, alpha, sky } */
    this.keyIds = new Map();
    this.keyList = [];
    /** `${keyId}|${mat uuid}` → id; id → { rkey, keyId, mat, sharedEligible, refs } or null (free) */
    this.routeIds = new Map();
    this.routeList = [];
    /** Route ids whose last emitter is gone, reused before the table grows. */
    this.freeRoutes = [];
    /** alpha-material signature string → id (0 = none). */
    this.sigIds = new Map();
    this.globals = new Float64Array(L.G_LEN);
    this.desc = new Float64Array(L.D_LEN);
    this.tablesDirty = true;
    /** The rp6 flags a cached sphere was computed under (re-done if they flip). */
    this.rp6FlagSig = this._rp6FlagSig();
  }

  _rp6FlagSig() {
    try { return this.deps.rp6FlagSig ? this.deps.rp6FlagSig() : ""; } catch (_) { return ""; }
  }

  sigId(str) {
    let id = this.sigIds.get(str);
    if (id === undefined) { id = this.sigIds.size + 1; this.sigIds.set(str, id); }
    return id;
  }

  /** The bucket key `_appendInstances` builds for this emitter, interned. */
  keyIdFor(shell) {
    const gfx = shell._instKey >>> 0;
    const layer = shell.renderLayer | 0;
    const alpha = shell._instAlpha === true;
    const sky = shell.skyGlow === true;
    const keyStr = `${gfx}|${layer}${alpha ? "|a" : ""}${sky ? "|sky" : ""}`;
    let id = this.keyIds.get(keyStr);
    if (id === undefined) {
      id = this.keyList.length;
      this.keyIds.set(keyStr, id);
      this.keyList.push({ keyStr, gfx, layer, alpha, sky });
      this.tablesDirty = true;
    }
    return id;
  }

  routeIdFor(shell) {
    const keyId = this.keyIdFor(shell);
    const ko = this.keyList[keyId];
    const mat = shell._instBaseMat || null;
    const rkey = `${keyId}|${mat ? mat.uuid : "-"}`;
    let id = this.routeIds.get(rkey);
    if (id === undefined) {
      const route = { rkey, keyId, mat, sharedEligible: ko.alpha && !ko.sky, refs: 0 };
      if (this.freeRoutes.length > 0) {
        // same table size: the next writeRoutes fills the reused row
        id = this.freeRoutes.pop();
        this.routeList[id] = route;
      } else {
        id = this.routeList.length;
        this.routeList.push(route);
        this.tablesDirty = true;
      }
      this.routeIds.set(rkey, id);
    }
    this.routeList[id].refs += 1;
    return id;
  }

  /**
   * One emitter of route `id` is gone. At the last one the route is freed:
   * the bridge drops its base material — so one that `?matBudgetMB` evicted
   * (and re-minted under a new uuid) is collectable with its texture — and
   * the id is reused. No live kernel emitter refers to a freed id (a route
   * is released only after its emitter left the kernel), and writeRoutes
   * rewrites a reused row before the next tick.
   */
  releaseRoute(id) {
    const r = this.routeList[id];
    if (!r || r.refs <= 0) return;
    r.refs -= 1;
    if (r.refs === 0) {
      this.routeIds.delete(r.rkey);
      this.routeList[id] = null;
      this.freeRoutes.push(id);
    }
  }

  /** Live (non-free) routes — diagnostics / tests. */
  liveRouteCount() {
    let n = 0;
    for (const r of this.routeList) if (r) n += 1;
    return n;
  }

  /**
   * The add-time descriptor (layout D_*) of a shell that has been through
   * setInfo + setParenting. `now` is the initEnd clock. `pre` (fixture
   * recorder only) carries the state a JS emitter had right before its own
   * initEnd ran: { leo, lastEmitTime, lastUpdateTime, createdSlots,
   * anchorPos, anchorQuat }.
   */
  describe(shell, now, routeId, pre = null) {
    const d = this.desc;
    d.fill(0);
    const info = shell.info;
    d[L.D_ID] = shell.id >>> 0;
    d[L.D_EMITTER_TYPE] = +info.emitterType;
    d[L.D_PARTICLE_TYPE] = +info.particleType;
    d[L.D_BIRTHRATE] = +info.birthrate;
    d[L.D_MAX_PARTICLES] = +info.maxParticles;
    d[L.D_TOTAL_PARTICLES] = +info.totalParticles;
    d[L.D_TOTAL_SECONDS] = +info.totalSeconds;
    d[L.D_LIFESPAN] = +info.lifespan;
    d[L.D_LIFESPAN_RAND] = +info.lifespanRand;
    d[L.D_OFFSET_DIR] = info.offsetDir.x; d[L.D_OFFSET_DIR + 1] = info.offsetDir.y; d[L.D_OFFSET_DIR + 2] = info.offsetDir.z;
    d[L.D_MIN_OFFSET] = +info.minOffset;
    d[L.D_MAX_OFFSET] = +info.maxOffset;
    d[L.D_A] = info.a.x; d[L.D_A + 1] = info.a.y; d[L.D_A + 2] = info.a.z;
    d[L.D_MIN_A] = +info.minA; d[L.D_MAX_A] = +info.maxA;
    d[L.D_B] = info.b.x; d[L.D_B + 1] = info.b.y; d[L.D_B + 2] = info.b.z;
    d[L.D_MIN_B] = +info.minB; d[L.D_MAX_B] = +info.maxB;
    d[L.D_C] = info.c.x; d[L.D_C + 1] = info.c.y; d[L.D_C + 2] = info.c.z;
    d[L.D_MIN_C] = +info.minC; d[L.D_MAX_C] = +info.maxC;
    d[L.D_SCALE_RAND] = +info.scaleRand;
    d[L.D_START_SCALE] = +info.startScale;
    d[L.D_FINAL_SCALE] = +info.finalScale;
    d[L.D_TRANS_RAND] = +info.transRand;
    d[L.D_START_TRANS] = +info.startTrans;
    d[L.D_FINAL_TRANS] = +info.finalTrans;
    d[L.D_PARENT_LOCAL] = info.isParentLocal ? 1 : 0;
    d[L.D_BILLBOARD] = info.billboard ? 1 : 0;
    const po = shell.parentOffset;
    d[L.D_PO_POS] = po.position.x; d[L.D_PO_POS + 1] = po.position.y; d[L.D_PO_POS + 2] = po.position.z;
    d[L.D_PO_QUAT] = po.quaternion.x; d[L.D_PO_QUAT + 1] = po.quaternion.y;
    d[L.D_PO_QUAT + 2] = po.quaternion.z; d[L.D_PO_QUAT + 3] = po.quaternion.w;
    const leo = pre ? pre.leo : shell.lastEmitOffset;
    d[L.D_LAST_EMIT_OFFSET] = leo.x; d[L.D_LAST_EMIT_OFFSET + 1] = leo.y; d[L.D_LAST_EMIT_OFFSET + 2] = leo.z;
    d[L.D_LAST_EMIT_TIME] = pre ? pre.lastEmitTime : shell.lastEmitTime;
    d[L.D_LAST_UPDATE_TIME] = pre ? pre.lastUpdateTime : shell.lastUpdateTime;
    d[L.D_CREATED_SLOTS] = (pre ? pre.createdSlots : shell._createdSlots) | 0;
    d[L.D_INIT_NOW] = now;
    d[L.D_BURST] = initEndBurst(info);
    const f = pre ? { position: pre.anchorPos, quaternion: pre.anchorQuat } : shell._resolveAnchorFrame();
    d[L.D_ANCHOR_POS] = f.position.x; d[L.D_ANCHOR_POS + 1] = f.position.y; d[L.D_ANCHOR_POS + 2] = f.position.z;
    d[L.D_ANCHOR_QUAT] = f.quaternion.x; d[L.D_ANCHOR_QUAT + 1] = f.quaternion.y;
    d[L.D_ANCHOR_QUAT + 2] = f.quaternion.z; d[L.D_ANCHOR_QUAT + 3] = f.quaternion.w;
    const cached = shellIsCached(shell);
    d[L.D_CACHED] = cached ? 1 : 0;
    if (cached) {
      const r = this.deps.rp6CullSphere(shell, _v3);
      d[L.D_RP6_CENTER] = _v3.x; d[L.D_RP6_CENTER + 1] = _v3.y; d[L.D_RP6_CENTER + 2] = _v3.z;
      d[L.D_RP6_RADIUS] = r;
    } else {
      d[L.D_RP6_RADIUS] = -1;
    }
    d[L.D_DEGRADE_DISTANCE] = shell.degradeDistance;
    d[L.D_FORCE_DEGRADE] = shell._forceDegrade === true ? 1 : 0;
    d[L.D_ROUTE] = routeId;
    const route = this.routeList[routeId];
    d[L.D_SHARED_ELIGIBLE] = route && route.sharedEligible ? 1 : 0;
    const base = shell._instBaseMat;
    d[L.D_FX_IF_CREATE] = shell.skyGlow !== true && !!base && base.isMeshBasicMaterial === true && base.wireframe !== true ? 1 : 0;
    const row = shell._fxRow | 0;
    d[L.D_ROW] = row;
    d[L.D_KIDS_ROW] = row > 0 && particleFxTier1(row).kids > 0 ? 1 : 0;
    d[L.D_STRETCH_ROW] = row > 0 && particleFxTier2(row).stretch > 0 ? 1 : 0;
    d[L.D_VEL_LIM_SQ] = particleFxTeleportSpeedSq(shell);
    d[L.D_RENDER_LAYER] = shell.renderLayer | 0;
    d[L.D_BB_MODE] = shell._bbMode | 0;
    if (info.billboard) {
      const n = this.deps.billboardLocalNormal(shell._rustGeometry);
      if (n) {
        d[L.D_HAS_BB_NORMAL] = 1;
        d[L.D_BB_NORMAL] = n.x; d[L.D_BB_NORMAL + 1] = n.y; d[L.D_BB_NORMAL + 2] = n.z;
      }
    }
    d[L.D_FILM_HIDDEN] = shell.filmHidden === true ? 1 : 0;
    d[L.D_RP6_CULLED] = shell._rp6Culled === true ? 1 : 0;
    return d;
  }

  /** Fill the globals block (layout G_*) from the manager's tick context. */
  writeGlobals(ctx) {
    const g = this.globals;
    g.fill(0);
    g[L.G_NOW] = ctx.now;
    g[L.G_FRAME] = ctx.frame;
    g[L.G_INTERVAL] = ctx.interval;
    g[L.G_RECHECK] = ctx.recheck ? 1 : 0;
    g[L.G_STAGGER] = ctx.stagger ? 1 : 0;
    g[L.G_HALF_PHASE] = ctx.halfPhase ? 1 : 0;
    const cam = ctx.camera;
    g[L.G_CAMERA_VALID] = cam ? 1 : 0;
    if (cam) {
      g[L.G_CAM_POS] = cam.position.x; g[L.G_CAM_POS + 1] = cam.position.y; g[L.G_CAM_POS + 2] = cam.position.z;
      const planes = ctx.frustum.planes;
      for (let i = 0; i < 6; i++) {
        const p = planes[i];
        g[L.G_PLANES + i * 4] = p.normal.x;
        g[L.G_PLANES + i * 4 + 1] = p.normal.y;
        g[L.G_PLANES + i * 4 + 2] = p.normal.z;
        g[L.G_PLANES + i * 4 + 3] = p.constant;
      }
    }
    g[L.G_MAX_DISTANCE] = ctx.maxDistance;
    g[L.G_DEGRADE_ON] = ctx.degradeOn ? 1 : 0;
    g[L.G_DEGRADE_CAP_ON] = ctx.degradeCapOn ? 1 : 0;
    g[L.G_CULL_FREEZE] = ctx.cullFreeze ? 1 : 0;
    g[L.G_LEAN_CULLED] = ctx.leanCulled ? 1 : 0;
    g[L.G_CULLED_STOP_SECONDS] = ctx.culledStopSeconds;
    g[L.G_CELL_GATE] = ctx.cellGate ? 1 : 0;
    const bb = ctx.bbCamera;
    g[L.G_BB_ON] = bb ? 1 : 0;
    if (bb && bb.position) {
      g[L.G_BB_CAM] = bb.position.x; g[L.G_BB_CAM + 1] = bb.position.y; g[L.G_BB_CAM + 2] = bb.position.z;
      // `_billboardEmitterRetail`'s camera, exactly as it derives it.
      const scene = ctx.scene;
      if (scene && scene.matrixWorld) {
        _sceneInv.copy(scene.matrixWorld).invert();
        _camLocal.copy(bb.position).applyMatrix4(_sceneInv);
      } else {
        _camLocal.copy(bb.position);
      }
      g[L.G_BB_CAM_LOCAL] = _camLocal.x; g[L.G_BB_CAM_LOCAL + 1] = _camLocal.y; g[L.G_BB_CAM_LOCAL + 2] = _camLocal.z;
    } else {
      g[L.G_BB_ON] = 0;
    }
    const sc = ctx.sortCam;
    g[L.G_SORT_ON] = sc ? 1 : 0;
    if (sc) { g[L.G_SORT_CAM] = sc.x; g[L.G_SORT_CAM + 1] = sc.y; g[L.G_SORT_CAM + 2] = sc.z; }
    g[L.G_FX_ENABLED] = ctx.fxEnabled ? 1 : 0;
    g[L.G_FX_LIVE] = ctx.fxLive ? 1 : 0;
    g[L.G_KIDS_ON] = ctx.kidsOn ? 1 : 0;
    g[L.G_MOTION_ON] = ctx.motionOn ? 1 : 0;
    g[L.G_SHARED_ON] = ctx.sharedOn ? 1 : 0;
    g[L.G_FX_SEED] = ctx.fxSeed >>> 0;
    return g;
  }

  /**
   * One dynamic emitter's per-tick inputs, as `_tickLatched` would compute
   * them for it: the RP6 decision on a due tick (`_rp6ShouldCull`), the cell
   * gate, and the anchor frame. Returns the new flag word; writes the anchor
   * into `anchors` at `h * 7` when `wantAnchor`.
   */
  dynamicInputs(shell, ctx, prevFlags, wantAnchor, anchors, h, skipIfCulled = false) {
    let fl = prevFlags;
    const id = shell.id >>> 0;
    const due = ctx.stagger
      ? ((ctx.frame + (ctx.halfPhase ? (id >>> 1) : id)) % ctx.interval) === 0
      : ctx.recheck;
    if (due) {
      const nowCulled = ctx.camera ? this.deps.rp6ShouldCull(shell, ctx.camera) : false;
      shell._rp6CulledJs = nowCulled;
      fl = nowCulled ? (fl | L.FLAG_CULLED) : (fl & ~L.FLAG_CULLED);
    }
    if (ctx.cellGate && this.deps.emitterCellHidden(shell, ctx.cellLookup)) fl |= L.FLAG_CELL_HIDDEN;
    else fl &= ~L.FLAG_CELL_HIDDEN;
    // NEED_SKIP_IF_CULLED: `fl` is the decision the kernel acts on this tick,
    // so a re-entry tick (culled → visible) still gets a fresh frame.
    if (wantAnchor && !(skipIfCulled && (fl & L.FLAG_CULLED) !== 0)) {
      const f = shell._resolveAnchorFrame();
      const o = h * L.ANCHOR_STRIDE;
      anchors[o] = f.position.x; anchors[o + 1] = f.position.y; anchors[o + 2] = f.position.z;
      anchors[o + 3] = f.quaternion.x; anchors[o + 4] = f.quaternion.y;
      anchors[o + 5] = f.quaternion.z; anchors[o + 6] = f.quaternion.w;
    }
    return fl >>> 0;
  }

  /**
   * The route table (layout ROUTE_*): key id + the current alpha signature.
   * Called first in a tick's table writes, so the signature ids it and
   * writeKeys hand out are consistent within the tick; they are only
   * compared within one tick, so the intern map restarts past SIG_INTERN_CAP
   * (every signature string embeds a texture uuid).
   */
  writeRoutes(rv) {
    if (this.sigIds.size > SIG_INTERN_CAP) this.sigIds.clear();
    for (let r = 0; r < this.routeList.length; r++) {
      const ro = this.routeList[r];
      if (!ro || ro.refs <= 0) { rv[r * 2] = -1; rv[r * 2 + 1] = 0; continue; }
      rv[r * 2] = ro.keyId;
      rv[r * 2 + 1] = ro.sharedEligible && ro.mat ? this.sigId(this.deps.alphaMatSig(ro.mat)) : 0;
    }
  }

  /** The bucket key table (layout K_*): the buckets as they stand now. */
  writeKeys(kv) {
    const mgr = this.mgr;
    const shared = this.deps.sharedAlphaBuckets;
    const frameId = this.deps.sharedFrameId();
    for (let k = 0; k < this.keyList.length; k++) {
      const ko = this.keyList[k];
      const o = k * L.KEY_STRIDE;
      const own = mgr._instBuckets.get(ko.keyStr);
      kv[o + L.K_OWN_EXISTS] = own ? 1 : 0;
      kv[o + L.K_OWN_CAP] = own ? own.im.instanceMatrix.count : 0;
      kv[o + L.K_OWN_FX] = own && own.im.userData?.particleFx === true && own.im.instanceColor ? 1 : 0;
      const sh = ko.alpha && !ko.sky ? shared.buckets.get(ko.keyStr) : undefined;
      kv[o + L.K_SH_EXISTS] = sh ? 1 : 0;
      kv[o + L.K_SH_SIG] = sh ? this.sigId(sh.sig) : 0;
      kv[o + L.K_SH_SCENE_OK] = sh && this.deps.sameWorld(sh.scene, mgr._scene) ? 1 : 0;
      kv[o + L.K_SH_CAP] = sh ? sh.im.instanceMatrix.count : 0;
      kv[o + L.K_SH_START_N] = sh ? (sh.frame === frameId ? sh.n : 0) : 0;
      kv[o + L.K_SH_FX] = sh && sh.im.userData?.particleFx === true && sh.im.instanceColor ? 1 : 0;
      kv[o + L.K_ALPHA] = ko.alpha ? 1 : 0;
    }
  }
}

/** `motionOn` for this tick without latching the tier-2 variant early. */
export function rustMotionOn() {
  return particleFxTier2Latched() ? particleFxMotionOn() : fxTier2Enabled("fxMotion");
}

let _warned = false;
function _warnOnce(msg) {
  if (_warned) return;
  _warned = true;
  // eslint-disable-next-line no-console
  console.warn(`[rust/particles] ${msg}`);
}

/**
 * One manager's Rust particle kernel. Created by ParticleManager on its first
 * instanced emitter under `?rustParticles=on` (see `createRustParticles`).
 */
export class RustParticles {
  constructor(mgr, deps, Cls) {
    this.mgr = mgr;
    this.deps = deps;
    this.inputs = new RustParticleInputs(mgr, deps);
    const seedLo = (Math.random() * 4294967296) >>> 0;
    const seedHi = (Math.random() * 4294967296) >>> 0;
    this.sys = new Cls(seedLo, seedHi, particleConfigBlock());
    /** handle → shell */
    this.shells = [];
    /** Shells whose anchor / RP6 / cell inputs JS supplies every tick. */
    this.dynamic = new Set();
    /** Shells with a cached (frozen-anchor) frame: re-anchored if `_scene` moves. */
    this.cachedCount = 0;
    this._sceneSnap = null;
    this._tickNo = 0;
    this._v = {
      anchor: new WasmF64View(), flags: new WasmU32View(), needs: new WasmU32View(), lastEmit: new WasmF64View(),
      slotFree: new WasmF64View(), route: new WasmF64View(), key: new WasmF64View(),
      events: new WasmU32View(), buckets: new WasmU32View(), mat: new WasmF32View(), col: new WasmF32View(),
      kids: new WasmU32View(), kidData: new WasmF32View(), finished: new WasmU32View(), stats: new WasmF64View(),
      sortMat: new WasmF32View(), sortCol: new WasmF32View(), state: new WasmF64View(), film: new WasmF64View(),
    };
    // Exports added after the first SceneParticles build; an older pkg runs
    // the fallbacks (per-read emitterState, slot-blind anchor test, appended
    // overwrites, slotSnapshot-based film samples).
    const sp = this.sys;
    this._hasStateOut = typeof sp.stateOutPtr === "function";
    this._hasSlotFree = typeof sp.anchorSlotFreePtr === "function";
    this._hasAddAt = typeof sp.addEmitterAt === "function";
    this._hasFilm = typeof sp.filmSamples === "function";
    this._statePtr = 0;
    this._stateLen = 0;
    this._refreshStatePtr();
    /** Film samples: built once per tick (see filmSample). */
    this._film = { tick: -1, max: -1, data: null, at: new Map() };
  }

  /** `state_out` moves only when a handle is allocated (addEmitter). */
  _refreshStatePtr() {
    if (!this._hasStateOut) return;
    this._statePtr = this.sys.stateOutPtr();
    this._stateLen = this.sys.stateOutLen();
  }

  get emitterCount() { return this.sys.emitterCount(); }

  // ---------------------------------------------------------------- emitters

  /**
   * Register a shell after addEmitter assigned its id (the kernel runs
   * initEnd's burst with `now`). Installs the shell's Rust-backed fields.
   */
  register(shell, now, before = null) {
    const routeId = this.inputs.routeIdFor(shell);
    shell._rustRoute = routeId;
    let h;
    try {
      const d = this.inputs.describe(shell, now, routeId);
      // `before`: a registered shell the newcomer goes in front of in the tick
      // order (an in-place table overwrite; see ParticleManager.addEmitter).
      const bh = before && before._rustHandle >= 0 && this.shells[before._rustHandle] === before ? before._rustHandle : 0xffffffff;
      h = bh !== 0xffffffff && this._hasAddAt ? this.sys.addEmitterAt(d, bh) : this.sys.addEmitter(d);
      if (h === 0xffffffff) throw new Error("SceneParticles.addEmitter rejected the descriptor");
      shell._rustCached = d[L.D_CACHED] === 1;
    } catch (e) {
      this.inputs.releaseRoute(routeId);
      shell._rustRoute = -1;
      throw e;
    }
    this._refreshStatePtr();
    this._film.tick = -1; // a reused handle must not read another shell's samples
    shell._rustHandle = h;
    shell._rustBridge = this;
    this.shells[h] = shell;
    if (shell._rustCached) {
      this.cachedCount += 1;
      if (!this._sceneSnap) this._sceneSnap = this._sceneElements();
    } else {
      this.dynamic.add(shell);
    }
    _installShellAccessors(shell, this);
    return h;
  }

  /** destroyParticleEmitter / replace: drop it from the kernel. */
  remove(shell) {
    const h = shell._rustHandle;
    if (!(h >= 0) || this.shells[h] !== shell) return false;
    const st = this.stateRow(shell);
    this.sys.removeEmitter(h);
    this._release(shell, st, false);
    return true;
  }

  stop(shell) {
    const h = shell._rustHandle;
    if (h >= 0 && this.shells[h] === shell) this.sys.stopEmitter(h);
    shell._rustStateTick = -1;
  }

  setField(shell, field, value) {
    const h = shell._rustHandle;
    if (h >= 0 && this.shells[h] === shell) this.sys.setField(h, field, +value);
    shell._rustStateTick = -1;
  }

  /**
   * One Q_* scalar of a registered shell: a read of the kernel's published
   * row (no wasm call); an older pkg falls back to `state()`.
   */
  stateValue(shell, i) {
    const h = shell._rustHandle;
    if (!(h >= 0) || this.shells[h] !== shell) {
      const f = shell._rustFinalState;
      return f ? f[i] : 0;
    }
    if (this._hasStateOut) {
      const v = this._v.state.get(this._statePtr, this._stateLen);
      const o = h * L.Q_LEN + i;
      return o < v.length ? v[o] : 0;
    }
    const st = this.state(shell);
    return st ? st[i] : 0;
  }

  /** A registered shell's Q_* row as an array (published row, or emitterState). */
  stateRow(shell) {
    const h = shell._rustHandle;
    if (!(h >= 0) || this.shells[h] !== shell) return shell._rustFinalState || null;
    if (this._hasStateOut) {
      const v = this._v.state.get(this._statePtr, this._stateLen);
      return Float64Array.from(v.subarray(h * L.Q_LEN, h * L.Q_LEN + L.Q_LEN));
    }
    return this.sys.emitterState(h);
  }

  /** The emitter's scalars (Q_* layout) through emitterState, cached per tick (older pkg). */
  state(shell) {
    const h = shell._rustHandle;
    if (!(h >= 0) || this.shells[h] !== shell) return shell._rustFinalState || null;
    if (shell._rustStateTick !== this._tickNo || !shell._rustState) {
      shell._rustState = this.sys.emitterState(h);
      shell._rustStateTick = this._tickNo;
    }
    return shell._rustState;
  }

  _release(shell, st, finished) {
    const h = shell._rustHandle;
    // a finished emitter's row was published final in its last tick
    if (!st && finished && this._hasStateOut && h >= 0 && this.shells[h] === shell) {
      const v = this._v.state.get(this._statePtr, this._stateLen);
      st = v.subarray(h * L.Q_LEN, h * L.Q_LEN + L.Q_LEN);
    }
    if (h >= 0 && this.shells[h] === shell) this.shells[h] = null;
    this._film.tick = -1;
    this.dynamic.delete(shell);
    if (shell._rustCached) this.cachedCount -= 1;
    this.inputs.releaseRoute(shell._rustRoute);
    const final = st && st.length ? Float64Array.from(st) : new Float64Array(L.Q_LEN);
    if (finished) { final[L.Q_NUM_PARTICLES] = 0; final[L.Q_STOPPED] = 1; }
    shell._rustFinalState = final;
    shell._rustHandle = -1;
    _freezeShellFields(shell, final);
  }

  _sceneElements() {
    const s = this.mgr._scene;
    return s && s.matrixWorld ? Array.from(s.matrixWorld.elements) : null;
  }

  /**
   * Cached emitters keep a `_scene`-local anchor frame and a world RP6 sphere.
   * Re-send them if `_scene` moved (part-anchored frames are localized
   * through it) or the sphere flags flipped (test / A-B seams). Rare; the
   * steady state is 16 compares and one string compare per tick.
   */
  _checkCachedAnchors() {
    if (this.cachedCount <= 0) return;
    const s0 = this.mgr._scene;
    const el = s0 && s0.matrixWorld ? s0.matrixWorld.elements : null;
    const prev = this._sceneSnap;
    let moved = false;
    if (el && prev) {
      for (let i = 0; i < 16; i++) if (el[i] !== prev[i]) { moved = true; break; }
    }
    const sig = this.inputs._rp6FlagSig();
    const flagsFlipped = sig !== this.inputs.rp6FlagSig;
    if (!moved && !flagsFlipped) return;
    this._sceneSnap = this._sceneElements();
    this.inputs.rp6FlagSig = sig;
    const f7 = new Float64Array(L.ANCHOR_STRIDE);
    for (let h = 0; h < this.shells.length; h++) {
      const s = this.shells[h];
      if (!s || !s._rustCached) continue;
      if (moved) {
        const f = s._resolveAnchorFrame();
        f7[0] = f.position.x; f7[1] = f.position.y; f7[2] = f.position.z;
        f7[3] = f.quaternion.x; f7[4] = f.quaternion.y; f7[5] = f.quaternion.z; f7[6] = f.quaternion.w;
        this.sys.setCachedAnchor(h, f7);
      }
      if (flagsFlipped) {
        const r = this.deps.rp6CullSphere(s, _v3);
        this.sys.setField(h, L.F_RP6_CX, _v3.x);
        this.sys.setField(h, L.F_RP6_CY, _v3.y);
        this.sys.setField(h, L.F_RP6_CZ, _v3.z);
        this.sys.setField(h, L.F_RP6_RADIUS, r);
      }
    }
  }

  // ------------------------------------------------------------------ tick

  /**
   * The Rust half of `_tickLatched`. `ctx` carries everything the JS loop
   * reads per tick. Returns { finished: shells[], cellHidden }.
   */
  tick(ctx) {
    const sys = this.sys;
    const inputs = this.inputs;
    this._tickNo += 1;
    this._checkCachedAnchors();
    if (inputs.tablesDirty) {
      sys.setTables(inputs.routeList.length, inputs.keyList.length);
      inputs.tablesDirty = false;
    }
    // ---- dynamic emitters: RP6 (due ticks), cell gate, anchors ----
    if (this.dynamic.size > 0) {
      const flags = this._v.flags.get(sys.flagsInPtr(), sys.flagsInLen());
      const anchors = this._v.anchor.get(sys.anchorInPtr(), sys.anchorInLen());
      const needs = this._v.needs.get(sys.needsAnchorPtr(), sys.needsAnchorLen());
      const lastEmit = this._v.lastEmit.get(sys.anchorLastEmitPtr(), sys.anchorLastEmitLen());
      const slotFree = this._hasSlotFree ? this._v.slotFree.get(sys.anchorSlotFreePtr(), sys.anchorSlotFreeLen()) : null;
      const now = ctx.now;
      for (const s of this.dynamic) {
        const h = s._rustHandle;
        const need = needs[h];
        // layout NEED_*: always, or every condition present — the kernel's own
        // per-second emit test (`now - lastEmitTime > birthrate`) and "a slot
        // is free or a particle can die by now" — never on a culled tick for a
        // running persistent emitter (applied in dynamicInputs).
        let want = false;
        if ((need & L.NEED_ALWAYS) !== 0) {
          want = true;
        } else if ((need & (L.NEED_IF_DUE | L.NEED_IF_SLOT)) !== 0) {
          want = ((need & L.NEED_IF_DUE) === 0 || now - lastEmit[h] > s.info.birthrate)
            && ((need & L.NEED_IF_SLOT) === 0 || slotFree === null || now >= slotFree[h] - NEED_SLOT_MARGIN);
        }
        flags[h] = inputs.dynamicInputs(s, ctx, flags[h], want, anchors, h, (need & L.NEED_SKIP_IF_CULLED) !== 0);
      }
    }
    inputs.writeRoutes(this._v.route.get(sys.routeInPtr(), sys.routeInLen()));
    inputs.writeKeys(this._v.key.get(sys.keyInPtr(), sys.keyInLen()));
    ctx.fxSeed = particleFxSeedState();
    sys.tick(inputs.writeGlobals(ctx));
    this._refreshStatePtr();
    return this._applyOutputs(ctx);
  }

  _applyOutputs(ctx) {
    const sys = this.sys;
    const mgr = this.mgr;
    const deps = this.deps;
    const keys = this.inputs.keyList;
    const st = this._v.stats.get(sys.statsPtr(), sys.statsLen());
    const forceStopped = st[L.S_FORCE_STOPPED] || 0;
    const cellHidden = st[L.S_CELL_HIDDEN] || 0;
    const cellParticles = st[L.S_CELL_PARTICLE_TICKS] || 0;
    const rejScene = st[L.S_REJECTED_SCENE] || 0;
    const rejMat = st[L.S_REJECTED_MAT] || 0;
    if (st.length >= L.S_LEN) setParticleFxSeedState(st[L.S_FX_SEED]);
    if (deps.rp6Stats) {
      deps.rp6Stats.culledForceStopped += forceStopped;
      deps.rp6Stats.cellHiddenEmitterTicks += cellHidden;
      deps.rp6Stats.cellHiddenParticleTicks += cellParticles;
    }
    const shared = deps.sharedAlphaBuckets;
    shared.stats.rejectedScene += rejScene;
    shared.stats.rejectedMat += rejMat;

    // ---- events, in order (only JS calls inside: the views stay valid) ----
    const ev = this._v.events.get(sys.eventsPtr(), sys.eventsLen());
    for (let i = 0; i + 2 < ev.length; i += L.EV_STRIDE) {
      const type = ev[i], a = ev[i + 1], b = ev[i + 2];
      const ko = keys[a];
      switch (type) {
        case L.EV_OWN: {
          if (!ko || mgr._instBuckets.has(ko.keyStr)) break;
          const shell = this.shells[b];
          if (!shell) { _warnOnce("bucket event for an unknown emitter"); break; }
          const im = mgr._makeBucketIm(shell, ko.gfx, ko.layer, ko.alpha);
          mgr._scene.add(im);
          mgr._instBuckets.set(ko.keyStr, { im, n: 0, alpha: ko.alpha });
          break;
        }
        case L.EV_SHARED: {
          const shell = this.shells[b];
          if (!ko || !shell) { _warnOnce("shared bucket event for an unknown emitter"); break; }
          const bk = shared.acquire(ko.keyStr, mgr._scene, deps.alphaMatSig(shell._instBaseMat),
            () => { const im = mgr._makeBucketIm(shell, ko.gfx, ko.layer, ko.alpha); im.name += "-s"; return im; },
            deps.sharedFrameId());
          if (!bk) _warnOnce(`shared bucket ${ko.keyStr} rejected where the kernel expected it`);
          break;
        }
        case L.EV_GROW_OWN: {
          const bk = ko ? mgr._instBuckets.get(ko.keyStr) : null;
          if (bk) deps.growBucket(bk, b, bk.scene || mgr._scene);
          break;
        }
        case L.EV_GROW_SHARED: {
          const bk = ko ? shared.buckets.get(ko.keyStr) : null;
          if (bk) deps.growBucket(bk, b, bk.scene || mgr._scene);
          break;
        }
        case L.EV_KIDS_MGR: {
          if (!mgr._kids) mgr._kids = new deps.ParticleFxKids(mgr._scene);
          break;
        }
        case L.EV_KIDS_LAYER: {
          if (!mgr._kids) mgr._kids = new deps.ParticleFxKids(mgr._scene);
          mgr._kids.layer(a);
          break;
        }
        default:
          break;
      }
    }

    // ---- bucket data: one set per bucket ----
    const bk = this._v.buckets.get(sys.bucketsPtr(), sys.bucketsLen());
    const mat = this._v.mat.get(sys.matPtr(), sys.matLen());
    const col = this._v.col.get(sys.colPtr(), sys.colLen());
    for (let i = 0; i + 3 < bk.length; i += L.BK_STRIDE) {
      const kind = bk[i], ko = keys[bk[i + 1]], count = bk[i + 2], first = bk[i + 3];
      if (!ko) continue;
      const bucket = kind === L.BK_SHARED ? shared.buckets.get(ko.keyStr) : mgr._instBuckets.get(ko.keyStr);
      if (!bucket) { _warnOnce(`no bucket for ${ko.keyStr}`); continue; }
      if (count > 0) {
        const im = bucket.im;
        im.instanceMatrix.array.set(mat.subarray(first * 16, (first + count) * 16), bucket.n * 16);
        if (im.instanceColor) im.instanceColor.array.set(col.subarray(first * 3, (first + count) * 3), bucket.n * 3);
      }
      bucket.n += count;
      if (kind === L.BK_OWN) bucket._rustN = bucket.n; // sorted by the kernel (see _finalizeInstBuckets)
    }

    // ---- kids records ----
    const kl = this._v.kids.get(sys.kidsPtr(), sys.kidsLen());
    if (kl.length > 0) {
      const kd = this._v.kidData.get(sys.kidDataPtr(), sys.kidDataLen());
      if (!mgr._kids) mgr._kids = new deps.ParticleFxKids(mgr._scene);
      for (let i = 0; i + 2 < kl.length; i += L.KL_STRIDE) {
        mgr._kids.layer(kl[i]).pushRecords(kd, kl[i + 2], kl[i + 1]);
        mgr._kids.records += kl[i + 1];
      }
    }

    // ---- finished emitters ----
    const fin = this._v.finished.get(sys.finishedPtr(), sys.finishedLen());
    const finished = [];
    if (fin.length > 0) {
      const hs = Array.from(fin);
      for (const h of hs) {
        const s = this.shells[h];
        if (!s) continue;
        finished.push(s);
        this._release(s, this._hasStateOut ? null : s._rustState, true);
      }
    }
    return { finished, cellHidden };
  }

  // ------------------------------------------------------------ shared sort

  /** `_sortBucketBackToFront` through the kernel (bit-identical: V8's sort). */
  sortBucket(im, n, cam) {
    if (n < 2) return;
    const sys = this.sys;
    sys.sortReserve(n);
    const m = im.instanceMatrix.array;
    const col = im.instanceColor ? im.instanceColor.array : null;
    this._v.sortMat.get(sys.sortMatPtr(), sys.sortMatLen()).set(m.subarray(0, n * 16));
    if (col) this._v.sortCol.get(sys.sortColPtr(), sys.sortColLen()).set(col.subarray(0, n * 3));
    sys.sortRun(n, cam.x, cam.y, cam.z, !!col);
    m.set(this._v.sortMat.get(sys.sortMatPtr(), sys.sortMatLen()).subarray(0, n * 16));
    if (col) col.set(this._v.sortCol.get(sys.sortColPtr(), sys.sortColLen()).subarray(0, n * 3));
  }

  // ------------------------------------------------- readers (diag / film)

  /**
   * `emitter.parts` / `partStorage` for a reader (film queries, __diag): the
   * kernel's slots as carrier-shaped meshes, built lazily per shell and only
   * when read.
   */
  materialize(shell) {
    const h = shell._rustHandle;
    const cache = shell._rustProxy || (shell._rustProxy = { meshes: [], parts: [], storage: [], tick: -1 });
    if (!(h >= 0) || this.shells[h] !== shell) { cache.parts = []; cache.storage = []; return cache; }
    // slots only change in a tick: one snapshot per tick however often read
    if (cache.tick === this._tickNo) return cache;
    cache.tick = this._tickNo;
    const snap = this.sys.slotSnapshot(h);
    const n = (snap.length / L.SL_STRIDE) | 0;
    const max = shell.info ? (shell.info.maxParticles | 0) : n;
    const parts = new Array(Math.max(max, n)).fill(null);
    const storage = new Array(Math.max(max, n)).fill(null);
    for (let i = 0; i < n; i++) {
      let m = cache.meshes[i];
      if (!m) m = cache.meshes[i] = this.deps.buildSlotMesh(shell);
      const o = i * L.SL_STRIDE;
      m.position.set(snap[o + L.SL_POS], snap[o + L.SL_POS + 1], snap[o + L.SL_POS + 2]);
      m.quaternion.set(snap[o + L.SL_QUAT], snap[o + L.SL_QUAT + 1], snap[o + L.SL_QUAT + 2], snap[o + L.SL_QUAT + 3]);
      m.scale.setScalar(snap[o + L.SL_SCALE]);
      m.visible = snap[o + L.SL_VISIBLE] === 1;
      m.userData.__op = snap[o + L.SL_OP];
      storage[i] = m;
      if (snap[o + L.SL_LIVE] === 1) parts[i] = m;
    }
    cache.parts = parts;
    cache.storage = storage;
    return cache;
  }

  /**
   * Film mode's sample of one shell's particles (film/scene/particles_query.js
   * `sphereOf`): up to `max` rows `[x, y, z, scale, op]` (`_scene`-local
   * position, raw opacity) of the first slots that are live, visible, at a
   * finite position and above FILM_SAMPLE_OP_MIN — the sample sphereOf takes
   * from `emitter.parts`, built for every shell in ONE kernel call per tick
   * (per `max`; again after a shell came or went) and without slot meshes.
   */
  filmSample(shell, max) {
    const h = shell._rustHandle;
    if (!(h >= 0) || this.shells[h] !== shell) return [];
    const f = this._film;
    const m = Math.max(0, max | 0);
    if (f.tick !== this._tickNo || f.max !== m) this._buildFilm(m);
    const at = f.at.get(h);
    if (at === undefined) return [];
    const d = f.data;
    const n = d[at + 1];
    const rows = new Array(n);
    for (let k = 0; k < n; k++) {
      const o = at + 2 + k * L.FS_STRIDE;
      rows[k] = [d[o + L.FS_X], d[o + L.FS_X + 1], d[o + L.FS_X + 2], d[o + L.FS_SCALE], d[o + L.FS_OP]];
    }
    return rows;
  }

  _buildFilm(max) {
    const f = this._film;
    f.tick = this._tickNo;
    f.max = max;
    f.at.clear();
    if (this._hasFilm) {
      this.sys.filmSamples(max, FILM_SAMPLE_OP_MIN);
      f.data = Float64Array.from(this._v.film.get(this.sys.filmOutPtr(), this.sys.filmOutLen()));
    } else {
      // older pkg: the same rows from each shell's slotSnapshot (no meshes)
      const out = [];
      for (let h = 0; h < this.shells.length; h++) {
        if (!this.shells[h]) continue;
        const snap = this.sys.slotSnapshot(h);
        out.push(h, 0);
        const head = out.length - 1;
        let n = 0;
        for (let o = 0; o + L.SL_STRIDE <= snap.length && n < max; o += L.SL_STRIDE) {
          if (snap[o + L.SL_LIVE] !== 1 || snap[o + L.SL_VISIBLE] !== 1) continue;
          const raw = snap[o + L.SL_OP];
          const r1 = Number.isFinite(raw) ? raw : 1;
          const op = r1 < 0 ? 0 : r1 > 1 ? 1 : r1;
          if (op <= FILM_SAMPLE_OP_MIN) continue;
          const x = snap[o + L.SL_POS], y = snap[o + L.SL_POS + 1], z = snap[o + L.SL_POS + 2];
          if (!(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z))) continue;
          out.push(x, y, z, snap[o + L.SL_SCALE], raw);
          n += 1;
        }
        out[head] = n;
      }
      f.data = Float64Array.from(out);
    }
    const d = f.data;
    for (let i = 0; i + 1 < d.length; i += 2 + d[i + 1] * L.FS_STRIDE) f.at.set(d[i], i);
  }

  /**
   * The runtime instancing toggle OFF (`setInstancing(false)`): hand the
   * emitter back to the JS per-mesh path with its exact state (particles,
   * slot transforms, opacity, FX seeds/velocities/kid history). The caller
   * then runs `_applyInstancing`'s OFF branch on it as for any instanced JS
   * emitter.
   */
  convertToJs(shell) {
    const h = shell._rustHandle;
    if (!(h >= 0) || this.shells[h] !== shell) return false;
    const st = Float64Array.from(this.sys.emitterState(h));
    const snap = this.sys.slotSnapshot(h);
    this.sys.removeEmitter(h);
    this._release(shell, st, false);
    _unfreezeShellFields(shell, st);
    const max = shell.info.maxParticles | 0;
    const n = (snap.length / L.SL_STRIDE) | 0;
    // A reader that already holds the materialized meshes keeps them: they
    // become the emitter's real slot meshes.
    const proxies = shell._rustProxy ? shell._rustProxy.meshes : [];
    shell._rustProxy = null;
    shell.parts = new Array(max).fill(null);
    shell.partStorage = new Array(max).fill(null);
    shell.particles = new Array(max).fill(null);
    const nn = Math.max(max, 1);
    const seeds = new Float32Array(nn).fill(-1);
    const lives = new Float32Array(nn).fill(Infinity);
    const vel = new Float32Array(nn * 8).fill(NaN);
    const kid = new Float32Array(nn * 5).fill(NaN);
    for (let i = 0; i < n; i++) {
      const o = i * L.SL_STRIDE;
      const m = proxies[i] || this.deps.buildSlotMesh(shell);
      m.position.set(snap[o + L.SL_POS], snap[o + L.SL_POS + 1], snap[o + L.SL_POS + 2]);
      m.quaternion.set(snap[o + L.SL_QUAT], snap[o + L.SL_QUAT + 1], snap[o + L.SL_QUAT + 2], snap[o + L.SL_QUAT + 3]);
      m.scale.setScalar(snap[o + L.SL_SCALE]);
      m.visible = snap[o + L.SL_VISIBLE] === 1;
      m.userData.__op = snap[o + L.SL_OP];
      const p = new Particle();
      p.lastUpdateTime = snap[o + L.SL_LAST_UPDATE_TIME];
      p.birthtime = snap[o + L.SL_BIRTHTIME];
      p.lifespan = snap[o + L.SL_LIFESPAN];
      p.lifetime = snap[o + L.SL_LIFETIME];
      p.startFrame.position.set(snap[o + L.SL_SF_POS], snap[o + L.SL_SF_POS + 1], snap[o + L.SL_SF_POS + 2]);
      p.startFrame.quaternion.set(snap[o + L.SL_SF_QUAT], snap[o + L.SL_SF_QUAT + 1], snap[o + L.SL_SF_QUAT + 2], snap[o + L.SL_SF_QUAT + 3]);
      p.offset.set(snap[o + L.SL_OFFSET], snap[o + L.SL_OFFSET + 1], snap[o + L.SL_OFFSET + 2]);
      p.a.set(snap[o + L.SL_A], snap[o + L.SL_A + 1], snap[o + L.SL_A + 2]);
      p.b.set(snap[o + L.SL_B], snap[o + L.SL_B + 1], snap[o + L.SL_B + 2]);
      p.c.set(snap[o + L.SL_C], snap[o + L.SL_C + 1], snap[o + L.SL_C + 2]);
      p.startScale = snap[o + L.SL_START_SCALE];
      p.finalScale = snap[o + L.SL_FINAL_SCALE];
      p.startTrans = snap[o + L.SL_START_TRANS];
      p.finalTrans = snap[o + L.SL_FINAL_TRANS];
      shell.partStorage[i] = m;
      shell.particles[i] = p;
      if (snap[o + L.SL_LIVE] === 1) shell.parts[i] = m;
      seeds[i] = snap[o + L.SL_SEED];
      lives[i] = snap[o + L.SL_LIFE];
      for (let k = 0; k < 8; k++) vel[i * 8 + k] = snap[o + L.SL_VEL + k];
      for (let k = 0; k < 5; k++) kid[i * 5 + k] = snap[o + L.SL_KID_PREV + k];
    }
    shell._fxSeeds = seeds;
    shell._fxLives = lives;
    shell._fxVel = vel;
    shell._kidPrev = kid;
    shell._createdSlots = n;
    shell._growing = false;
    shell._rustShell = false;
    if (shell._rustMeshFactory) shell._meshFactory = shell._rustMeshFactory;
    return true;
  }
}

/** Rust-backed fields on a registered shell (own accessors, configurable). */
function _installShellAccessors(shell, bridge) {
  // Reads go to the kernel's published per-handle row (a view; no wasm call):
  // tier-1 lights, film queries and diagnostics read these every frame.
  const q = (i) => () => bridge.stateValue(shell, i);
  const def = (name, get, set) => Object.defineProperty(shell, name, {
    configurable: true, enumerable: true, get, set: set || (() => {}),
  });
  def("numParticles", q(L.Q_NUM_PARTICLES));
  def("totalEmitted", q(L.Q_TOTAL_EMITTED));
  def("creationTime", q(L.Q_CREATION_TIME));
  def("lastEmitTime", q(L.Q_LAST_EMIT_TIME));
  def("lastUpdateTime", q(L.Q_LAST_UPDATE_TIME));
  def("_createdSlots", q(L.Q_CREATED_SLOTS));
  def("_growing", () => bridge.stateValue(shell, L.Q_GROWING) === 1);
  def("stopped", () => bridge.stateValue(shell, L.Q_STOPPED) === 1,
    (v) => { if (v === true) bridge.stop(shell); });
  def("_rp6Culled", () => {
    if (!shell._rustCached) return shell._rp6CulledJs === true;
    return bridge.stateValue(shell, L.Q_CULLED) === 1;
  }, (v) => { shell._rp6CulledJs = v === true; });
  shell._filmHiddenJs = shell.filmHidden;
  def("filmHidden", () => shell._filmHiddenJs, (v) => {
    shell._filmHiddenJs = v;
    bridge.setField(shell, L.F_FILM_HIDDEN, v === true ? 1 : 0);
  });
  shell._degradeDistanceJs = shell.degradeDistance;
  def("degradeDistance", () => shell._degradeDistanceJs, (v) => {
    shell._degradeDistanceJs = v;
    bridge.setField(shell, L.F_DEGRADE_DISTANCE, v);
  });
  shell._forceDegradeJs = shell._forceDegrade;
  def("_forceDegrade", () => shell._forceDegradeJs, (v) => {
    shell._forceDegradeJs = v;
    bridge.setField(shell, L.F_FORCE_DEGRADE, v === true ? 1 : 0);
  });
  shell._bbModeJs = shell._bbMode;
  def("_bbMode", () => shell._bbModeJs, (v) => {
    shell._bbModeJs = v;
    bridge.setField(shell, L.F_BB_MODE, v | 0);
  });
  def("parts", () => bridge.materialize(shell).parts);
  def("partStorage", () => bridge.materialize(shell).storage);
}

/** After removal: plain values (the last state), so later reads cost nothing. */
function _freezeShellFields(shell, st) {
  const val = (name, v) => Object.defineProperty(shell, name, { configurable: true, enumerable: true, writable: true, value: v });
  val("numParticles", st[L.Q_NUM_PARTICLES]);
  val("totalEmitted", st[L.Q_TOTAL_EMITTED]);
  val("creationTime", st[L.Q_CREATION_TIME]);
  val("lastEmitTime", st[L.Q_LAST_EMIT_TIME]);
  val("lastUpdateTime", st[L.Q_LAST_UPDATE_TIME]);
  val("_createdSlots", st[L.Q_CREATED_SLOTS]);
  val("_growing", false);
  val("stopped", st[L.Q_STOPPED] === 1);
  val("_rp6Culled", shell._rustCached ? st[L.Q_CULLED] === 1 : shell._rp6CulledJs === true);
  val("filmHidden", shell._filmHiddenJs);
  val("degradeDistance", shell._degradeDistanceJs);
  val("_forceDegrade", shell._forceDegradeJs);
  val("_bbMode", shell._bbModeJs);
  val("parts", []);
  val("partStorage", []);
}

/** convertToJs: the rest of the JS emitter state from the kernel's. */
function _unfreezeShellFields(shell, st) {
  shell.lastEmitOffset.set(st[L.Q_LAST_EMIT_OFFSET], st[L.Q_LAST_EMIT_OFFSET + 1], st[L.Q_LAST_EMIT_OFFSET + 2]);
  shell._rp6FrozenAt = Number.isNaN(st[L.Q_FROZEN_AT]) ? undefined : st[L.Q_FROZEN_AT];
  shell._rp6CulledSinceSec = Number.isNaN(st[L.Q_CULLED_SINCE]) ? undefined : st[L.Q_CULLED_SINCE];
}

/**
 * The manager's bridge, or null when `?rustParticles` is off or the pkg has
 * no SceneParticles (JS path). `deps` are particle_manager.js internals.
 */
export function createRustParticles(mgr, deps) {
  if (!rustParticlesEnabled()) return null;
  const Cls = sceneParticlesClass();
  if (!Cls) return null;
  try {
    return new RustParticles(mgr, deps, Cls);
  } catch (e) {
    _warnOnce(`SceneParticles unavailable: ${String(e?.message ?? e)}`);
    return null;
  }
}
