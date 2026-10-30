// scene3d/film/scene/particles_query.js — where are the particle clouds, and do they block the view?
// (SPEC §1.1 page adapters, §3.1 SensorFrame `particles`; recon_particles.md §1).
//
// WHY: smoke, gas and mist have NO colliders — the wasm sweeps never see them —
// yet a dolly through a brazier's smoke or a drone pass through a portal
// swirl ruins a take: the subject vanishes behind a soot puff, or the lens is
// filled with screen-sized quads. The JEV pilot has to hear "thick smoke on the
// lens" / "medium smoke blocking the view" in words, and the safety reflex has
// to know which emitters to hide near the lens. This adapter enumerates the
// live emitters and reduces each to a world sphere + a semantic family:
//   * managers: `liveScene3d.entityManager._worldParticleManager`, the static
//     manager (`liveScene3d._staticParticleManager` when stamped), every manager
//     reachable through the particle OWNER registry (`ownerRegistry._owners` —
//     the reliable way to find the static manager, which lives on an internal
//     facade), and any injected `managers` (e.g. particle_manager.js
//     `allParticleManagers`, passed in by the runtime — this module never
//     imports the stateful particle_manager.js);
//   * per emitter (`mgr.particleTable`): world centre = the anchor
//     (`parent.getWorldPosition` → THREE frame → AC via threeToAcPos; a part
//     anchor uses `parent.partFrames[partIndex]`, a POJO anchor its
//     `_scene`-local position); radius = max(info.sortingSphere.radius +
//     |parentOffset|, the extent of a few sampled live particles — slot meshes
//     are `_scene`-local, converted with `_scene.localToWorld`);
//   * skipped: `skyGlow` sky sheets, the `sky`/`none` catalog families, emitters
//     with no live particles, and `filmHidden` ones (already hidden by the
//     runtime) unless `includeHidden`;
//   * family / behaviour from the particle-fx catalog (data/particle-fx-catalog.json,
//     keyed by `info.id` as "0x32XXXXXX", synthesized emitters by
//     `info.fxProfile`) or an injected `familyOf(did)`;
//   * occludes: smoke / gas / mist / dust / haze / water-sheet families TRUE;
//     additive fire / star / glow / spark families FALSE; an uncatalogued
//     emitter occludes only when it is alpha-blended and ≥ 1.5 m.
// Density (0..1) = √(live / max particles) × mean particle opacity.
//
// The emitter snapshot is rebuilt at most once per render frame
// (`frameKey()`, default `liveScene3d.frameTime.tsMs`), so many queries per
// perception tick cost one enumeration. Static anchors never move: their world
// position is cached per anchor object.
//
// Film mode is DEFAULT OFF (`?filmMode=on`). Page adapter: every dependency is
// injected (THREE, liveScene3d, registry, catalog); imports only the
// dependency-free owner_registry.js and pure film modules. Deterministic: no clocks.

import { ownerRegistry as defaultOwnerRegistry } from "../../particles/owner_registry.js";
import { threeToAcPos } from "../core/gimbal.js";
import { qToBasis } from "../core/quat.js";
import { poseQuat } from "../shots/framing.js";

/** Catalog families whose clouds hide what is behind them (alpha smoke, gas, mist, dust, haze, falling water). */
export const OCCLUDING_FAMILIES = Object.freeze([
  "smoke_dark", "smoke_light", "smoke_add", "gas_alpha", "mist_white", "mist_magic", "mist_fire",
  "dust", "blood_mist", "dark_burst", "water_sheet",
]);

/** Catalog families never considered (sky-chain sheets, untextured surfaces). */
export const EXCLUDED_FAMILIES = Object.freeze(["sky", "none"]);

/** Default lens radius (m) for onLens. */
export const LENS_RADIUS_M = 2;

/** Smallest emitter radius (m) reported (a point anchor still has a body). */
export const MIN_EMITTER_RADIUS_M = 0.25;

/** Uncatalogued alpha emitters at least this big (m) are treated as occluding clouds. */
export const UNKNOWN_OCCLUDER_MIN_RADIUS_M = 1.5;

/** Default number of live particles sampled per emitter for the extent / lens tests. */
export const DEFAULT_PARTS_SAMPLED = 12;

const OCCLUDING = new Set(OCCLUDING_FAMILIES);
const EXCLUDED = new Set(EXCLUDED_FAMILIES);
const DEG = Math.PI / 180;

/**
 * Catalog key of an emitter DID: "0x" + 8 upper-case hex digits ("0x3200000B").
 * @param {number} did
 * @returns {string|null} null for a non-finite input
 */
export function emitterCatalogKey(did) {
  if (typeof did !== "number" || !Number.isFinite(did)) return null;
  return "0x" + (did >>> 0).toString(16).toUpperCase().padStart(8, "0");
}

/**
 * Does a family occlude? Known occluding families → true; other catalogued
 * families → false; an unknown family (null) → `additive === false && radius ≥ 1.5`.
 * @param {string|null} family
 * @param {{additive?:boolean, radius?:number}} [extra]
 * @returns {boolean}
 */
export function familyOccludes(family, extra = {}) {
  if (typeof family === "string" && family) return OCCLUDING.has(family);
  const e = extra && typeof extra === "object" ? extra : {};
  return e.additive === false && Number.isFinite(e.radius) && e.radius >= UNKNOWN_OCCLUDER_MIN_RADIUS_M;
}

/**
 * Build a `(did, fxProfile) → {family, behavior}|null` lookup from a catalog
 * object (`{emitters:{'0x32…':{family, behavior}}, synthesized:{profile:{family}}}`)
 * and/or a `familyOf(did)` function (returning a family string or `{family, behavior}`).
 * The function wins when it answers.
 * @param {object|null} catalog
 * @param {Function|null} familyOf
 * @returns {(did:number, fxProfile?:string|null) => ({family:string, behavior:string|null}|null)}
 */
export function makeFamilyLookup(catalog, familyOf) {
  const emitters = catalog && typeof catalog === "object" && catalog.emitters && typeof catalog.emitters === "object" ? catalog.emitters : null;
  const synth = catalog && typeof catalog === "object" && catalog.synthesized && typeof catalog.synthesized === "object" ? catalog.synthesized : null;
  const fn = typeof familyOf === "function" ? familyOf : null;
  const memo = new Map();
  const norm = (v) => {
    if (typeof v === "string" && v) return { family: v, behavior: null };
    if (v && typeof v === "object" && typeof v.family === "string" && v.family) {
      return { family: v.family, behavior: typeof v.behavior === "string" ? v.behavior : null };
    }
    return null;
  };
  return (did, fxProfile) => {
    const mk = `${did}|${fxProfile ?? ""}`;
    if (memo.has(mk)) return memo.get(mk);
    let out = null;
    if (fn) {
      try {
        out = norm(fn(did, fxProfile));
      } catch {
        out = null;
      }
    }
    if (!out && emitters) {
      const k = emitterCatalogKey(did);
      if (k) out = norm(emitters[k] ?? emitters[k.toLowerCase()] ?? emitters["0x" + k.slice(2).toLowerCase()]);
    }
    if (!out && synth && typeof fxProfile === "string" && fxProfile) out = norm(synth[fxProfile]);
    memo.set(mk, out);
    return out;
  };
}

/** `[x,y,z]` from an array-like / `{x,y,z}`; null unless finite. */
function vec(p) {
  if (p == null || typeof p !== "object") return null;
  const x = p[0] !== undefined ? p[0] : p.x;
  const y = p[1] !== undefined ? p[1] : p.y;
  const z = p[2] !== undefined ? p[2] : p.z;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
  return [x, y, z];
}

/** @param {number} v @returns {number} */
function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * @typedef {Object} EmitterSphere
 * @property {string} key       stable id "<ownerKey|m<index>>#<emitterId>" (what fades / hides name)
 * @property {number} emitterId the manager's emitter id
 * @property {number|string|null} ownerKey particle owner key (entity guid, "static:<lb>", …) when known
 * @property {number} did       info.id (0x32 DID), 0 when unknown
 * @property {string|null} family catalog family (null = uncatalogued)
 * @property {string|null} behavior catalog behaviour
 * @property {boolean} occludes
 * @property {boolean} additive emitter._baseIsAdditive
 * @property {number[]} center  AC world metres
 * @property {number} radius    metres
 * @property {number} density   0..1
 * @property {number[][]} parts sampled live particles `[x, y, z, size, opacity]` (AC)
 * @property {object} emitter   the live ParticleEmitter (for runtime hides; not JSON-safe)
 * @property {object} manager   its ParticleManager
 */

/**
 * Create the particle query adapter.
 *
 * Queries (AC world metres; results sorted nearest first; never throw):
 * - `near(center, radius)` → emitters whose sphere comes within `radius` of
 *   `center`, each with `range` = surface distance (0 inside the cloud);
 * - `alongSegment(a, b, radius=0)` → emitters whose sphere (inflated by
 *   `radius`) crosses the segment, with `t` (entry fraction) and `range`
 *   (metres from `a` to the entry), sorted by t;
 * - `onLens(pose, {radius=2})` → the densest cloud on the lens `{family,
 *   density, occludes, key, range}` or null — density × lens coverage (from the
 *   sampled live particles when available, else sphere overlap);
 * - `inView(pose, {rangeM=25, fovDeg=pose.fov, aspect=16/9})` → emitters within
 *   rangeM whose sphere overlaps the view cone (conservative diagonal cone);
 * - `snapshot()` → every EmitterSphere this frame; `invalidate()` forces a rebuild;
 * - `familyInfo(did, fxProfile)` → `{family, behavior}|null`.
 *
 * @param {{liveScene3d?:object|null, ownerRegistry?:object|null, managers?:object[]|(()=>object[]),
 *   THREE?:object|null, catalog?:object|null, familyOf?:Function|null, frameKey?:()=>*,
 *   maxPartsSampled?:number, includeHidden?:boolean}} [opts]
 *   ownerRegistry default: the owner_registry.js singleton (pass null to disable);
 *   frameKey default `() => liveScene3d.frameTime.tsMs` (undefined ⇒ rebuild every query)
 * @returns {{near:Function, alongSegment:Function, onLens:Function, inView:Function,
 *   snapshot:()=>EmitterSphere[], invalidate:()=>void, familyInfo:Function, stats:()=>object}}
 */
export function createParticlesQuery(opts = {}) {
  const o = opts && typeof opts === "object" ? opts : {};
  const live = o.liveScene3d && typeof o.liveScene3d === "object" ? o.liveScene3d : null;
  const registry = o.ownerRegistry === undefined ? defaultOwnerRegistry : o.ownerRegistry;
  const THREE = o.THREE && typeof o.THREE === "object" ? o.THREE : null;
  const lookup = makeFamilyLookup(o.catalog ?? null, o.familyOf ?? null);
  const maxParts = Number.isFinite(o.maxPartsSampled) ? Math.max(0, Math.floor(o.maxPartsSampled)) : DEFAULT_PARTS_SAMPLED;
  const includeHidden = o.includeHidden === true;
  const frameKey = typeof o.frameKey === "function"
    ? o.frameKey
    : () => {
      const ts = live && live.frameTime && typeof live.frameTime === "object" ? live.frameTime.tsMs : undefined;
      return Number.isFinite(ts) ? ts : undefined;
    };

  const v3 = THREE && typeof THREE.Vector3 === "function" ? new THREE.Vector3() : null;
  /** @type {WeakMap<object, number[]>} static anchor → AC centre */
  const staticAnchorPos = new WeakMap();
  let cacheKey;
  let cacheValid = false;
  /** @type {EmitterSphere[]} */
  let cache = [];
  const counters = { rebuilds: 0, emitters: 0, skipped: 0 };

  /** Every distinct manager, in a stable order. */
  function managers() {
    const out = [];
    const seen = new Set();
    const add = (m) => {
      if (!m || typeof m !== "object" || seen.has(m)) return;
      if (!(m.particleTable instanceof Map)) return;
      seen.add(m);
      out.push(m);
    };
    if (live) {
      const em = live.entityManager;
      if (em && typeof em === "object") add(em._worldParticleManager);
      add(live._staticParticleManager);
    }
    let extra = o.managers;
    if (typeof extra === "function") {
      try {
        extra = extra();
      } catch {
        extra = null;
      }
    }
    if (Array.isArray(extra)) for (const m of extra) add(m);
    if (registry && typeof registry === "object" && registry._owners instanceof Map) {
      for (const rec of registry._owners.values()) {
        if (!rec || !(rec.ids instanceof Map)) continue;
        for (const m of rec.ids.values()) add(m);
      }
    }
    return out;
  }

  /** Owner key of an emitter id in a manager (registry reverse map), or null. */
  function ownerOf(mgr, id) {
    if (!registry || typeof registry !== "object") return null;
    const by = registry._byMgr;
    if (!by || typeof by.get !== "function") return null;
    try {
      const m = by.get(mgr);
      const k = m && typeof m.get === "function" ? m.get(id) : undefined;
      return k === undefined ? null : k;
    } catch {
      return null;
    }
  }

  /** THREE-world position of an Object3D (or a matrixWorld-bearing object) → AC; null when unknown. */
  function objectWorldAc(obj) {
    if (!obj || typeof obj !== "object") return null;
    try {
      if (v3 && typeof obj.getWorldPosition === "function") {
        obj.getWorldPosition(v3);
        return vec(threeToAcPos(v3));
      }
      if (typeof obj.updateWorldMatrix === "function") obj.updateWorldMatrix(true, false);
      const e = obj.matrixWorld && obj.matrixWorld.elements;
      if (e && e.length >= 16) return vec(threeToAcPos(e[12], e[13], e[14]));
    } catch {
      return null;
    }
    return null;
  }

  /** A `_scene`-local point (the AC frame) → AC world, through the scene's world matrix when possible. */
  function sceneLocalToAc(scene, p) {
    const lp = vec(p);
    if (!lp) return null;
    if (v3 && scene && typeof scene.localToWorld === "function") {
      try {
        v3.set(lp[0], lp[1], lp[2]);
        scene.localToWorld(v3);
        return vec(threeToAcPos(v3));
      } catch {
        return lp;
      }
    }
    return lp;
  }

  /** Anchor centre (AC) of an emitter. */
  function anchorOf(em, mgr) {
    const parent = em.parent;
    if (!parent || typeof parent !== "object") return null;
    const pi = em.partIndex;
    const partAnchored = typeof pi === "number" && pi !== -1 && (pi >>> 0) !== 0xffffffff;
    if (partAnchored && parent.partFrames) {
      let wf = null;
      try {
        wf = parent.partFrames[pi];
      } catch {
        wf = null;
      }
      const wp = wf && wf.position ? vec(wf.position) : null;
      if (wp) return vec(threeToAcPos(wp));
    }
    const isStatic = parent.userData && typeof parent.userData === "object" && parent.userData.isStaticScriptAnchor === true;
    if (isStatic) {
      const hit = staticAnchorPos.get(parent);
      if (hit) return hit;
    }
    let c = null;
    if (typeof parent.getWorldPosition === "function" || (parent.matrixWorld && typeof parent.updateWorldMatrix === "function")) {
      c = objectWorldAc(parent);
    }
    if (!c && parent.position) c = sceneLocalToAc(mgr && mgr._scene, parent.position);
    if (c && isStatic) staticAnchorPos.set(parent, c);
    return c;
  }

  /** Build one EmitterSphere, or null when the emitter is skipped. */
  function sphereOf(em, mgr, mgrIndex, id) {
    if (!em || typeof em !== "object") return null;
    if (em.skyGlow === true) return null;
    if (em.filmHidden === true && !includeHidden) return null;
    const n = Number(em.numParticles);
    if (!(n > 0)) return null;
    const info = em.info && typeof em.info === "object" ? em.info : {};
    const did = Number.isFinite(info.id) ? info.id >>> 0 : 0;
    const fam = lookup(did, typeof info.fxProfile === "string" ? info.fxProfile : null);
    const family = fam ? fam.family : null;
    if (family && EXCLUDED.has(family)) return null;
    const center = anchorOf(em, mgr);
    if (!center) return null;
    const off = em.parentOffset && em.parentOffset.position ? vec(em.parentOffset.position) : null;
    const offLen = off ? Math.hypot(off[0], off[1], off[2]) : 0;
    const sortR = info.sortingSphere && Number.isFinite(info.sortingSphere.radius) ? Math.max(0, info.sortingSphere.radius) : 0;
    let radius = Math.max(MIN_EMITTER_RADIUS_M, sortR + offLen);
    // Sample a few live particles: extent + opacity.
    const parts = [];
    let opSum = 0;
    let opN = 0;
    const geomR = em._instGeom && em._instGeom.boundingSphere && Number.isFinite(em._instGeom.boundingSphere.radius)
      ? em._instGeom.boundingSphere.radius : null;
    // ?rustParticles: a kernel-simulated emitter's sample comes from its bridge
    // (scene3d/rust/particles.js filmSample) — the same slots this loop would
    // take, for every emitter in one kernel pass per tick. Reading `em.parts`
    // on it would build a proxy mesh per slot, for every emitter, every frame.
    const rustRows = em._rustShell === true && em._rustHandle >= 0 && em._rustBridge &&
      typeof em._rustBridge.filmSample === "function" ? em._rustBridge.filmSample(em, maxParts) : null;
    if (rustRows) {
      const rg = em._rustGeometry;
      const gR = rg && rg.boundingSphere && Number.isFinite(rg.boundingSphere.radius) ? rg.boundingSphere.radius : geomR ?? 0.5;
      for (let i = 0; i < rustRows.length && parts.length < maxParts; i++) {
        const r = rustRows[i]; // [x, y, z, scale, op] — live, visible, op above the floor
        const op = clamp01(Number.isFinite(r[4]) ? r[4] : 1);
        const p = sceneLocalToAc(mgr._scene, r);
        if (!p) continue;
        const sc = Number.isFinite(r[3]) ? Math.abs(r[3]) : 1;
        const size = Math.max(0, gR * sc);
        parts.push([p[0], p[1], p[2], size, op]);
        opSum += op;
        opN += 1;
        const ext = Math.hypot(p[0] - center[0], p[1] - center[1], p[2] - center[2]) + size;
        if (ext > radius) radius = ext;
      }
    }
    const rawParts = rustRows ? null : em.parts; // read once (an accessor on some emitters)
    const list = Array.isArray(rawParts) ? rawParts : [];
    for (let i = 0; i < list.length && parts.length < maxParts; i++) {
      const mesh = list[i];
      if (!mesh || typeof mesh !== "object" || mesh.visible === false) continue;
      const opRaw = mesh.userData && Number.isFinite(mesh.userData.__op) ? mesh.userData.__op : 1;
      const op = clamp01(opRaw);
      if (op <= 0.02) continue;
      const p = sceneLocalToAc(mgr._scene, mesh.position);
      if (!p) continue;
      const gR = mesh.geometry && mesh.geometry.boundingSphere && Number.isFinite(mesh.geometry.boundingSphere.radius)
        ? mesh.geometry.boundingSphere.radius : geomR ?? 0.5;
      const sc = mesh.scale && Number.isFinite(mesh.scale.x) ? Math.abs(mesh.scale.x) : 1;
      const size = Math.max(0, gR * sc);
      parts.push([p[0], p[1], p[2], size, op]);
      opSum += op;
      opN += 1;
      const ext = Math.hypot(p[0] - center[0], p[1] - center[1], p[2] - center[2]) + size;
      if (ext > radius) radius = ext;
    }
    const maxP = Number.isFinite(info.maxParticles) && info.maxParticles > 0 ? info.maxParticles : Math.max(1, n);
    const opacity = opN > 0 ? opSum / opN : clamp01(1 - (Number.isFinite(info.startTrans) ? info.startTrans : 0));
    const density = clamp01(Math.sqrt(clamp01(n / maxP)) * opacity);
    const additive = em._baseIsAdditive === true;
    const ownerKey = ownerOf(mgr, id);
    const key = `${ownerKey !== null ? String(ownerKey) : "m" + mgrIndex}#${id}`;
    return {
      key,
      emitterId: id,
      ownerKey,
      did,
      family,
      behavior: fam ? fam.behavior : null,
      occludes: familyOccludes(family, { additive, radius }),
      additive,
      center,
      radius,
      density,
      parts,
      emitter: em,
      manager: mgr,
    };
  }

  /** The (cached) emitter list for this frame. */
  function snapshot() {
    let k;
    try {
      k = frameKey();
    } catch {
      k = undefined;
    }
    if (cacheValid && k !== undefined && k === cacheKey) return cache;
    const out = [];
    const mgrs = managers();
    for (let mi = 0; mi < mgrs.length; mi++) {
      const mgr = mgrs[mi];
      for (const [id, em] of mgr.particleTable) {
        let s = null;
        try {
          s = sphereOf(em, mgr, mi, id);
        } catch {
          s = null;
        }
        if (s) out.push(s);
        else counters.skipped += 1;
      }
    }
    counters.rebuilds += 1;
    counters.emitters = out.length;
    cache = out;
    cacheKey = k;
    cacheValid = k !== undefined;
    return out;
  }

  /** Public result row (shallow copy with the query fields). */
  function row(s, extra) {
    return {
      key: s.key,
      emitterId: s.emitterId,
      ownerKey: s.ownerKey,
      did: s.did,
      family: s.family,
      behavior: s.behavior,
      occludes: s.occludes,
      additive: s.additive,
      center: s.center.slice(),
      radius: s.radius,
      density: s.density,
      emitter: s.emitter,
      manager: s.manager,
      ...extra,
    };
  }

  /**
   * Emitters within `radius` (surface distance) of `center`.
   * @param {number[]|{x:number,y:number,z:number}} center
   * @param {number} radius metres (≥ 0)
   * @returns {object[]} rows with `range`
   */
  function near(center, radius) {
    const c = vec(center);
    const R = Number.isFinite(radius) ? Math.max(0, radius) : 0;
    if (!c) return [];
    const out = [];
    for (const s of snapshot()) {
      const d = Math.hypot(s.center[0] - c[0], s.center[1] - c[1], s.center[2] - c[2]);
      const range = Math.max(0, d - s.radius);
      if (range <= R) out.push(row(s, { range }));
    }
    out.sort((a, b) => a.range - b.range || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    return out;
  }

  /**
   * Emitters whose sphere (inflated by `radius`) the segment a→b crosses.
   * @param {number[]|{x:number,y:number,z:number}} a
   * @param {number[]|{x:number,y:number,z:number}} b
   * @param {number} [radius=0]
   * @returns {object[]} rows with `t` (entry fraction 0..1) and `range` (m from a), sorted by t
   */
  function alongSegment(a, b, radius = 0) {
    const p = vec(a), q = vec(b);
    if (!p || !q) return [];
    const r0 = Number.isFinite(radius) ? Math.max(0, radius) : 0;
    const d = [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
    const L = Math.hypot(d[0], d[1], d[2]);
    const out = [];
    for (const s of snapshot()) {
      const rr = s.radius + r0;
      const m = [p[0] - s.center[0], p[1] - s.center[1], p[2] - s.center[2]];
      const C = m[0] * m[0] + m[1] * m[1] + m[2] * m[2] - rr * rr;
      if (C <= 0) {
        out.push(row(s, { t: 0, range: 0 }));
        continue;
      }
      if (!(L > 1e-9)) continue;
      const u = [d[0] / L, d[1] / L, d[2] / L];
      const B = m[0] * u[0] + m[1] * u[1] + m[2] * u[2];
      const disc = B * B - C;
      if (disc < 0) continue;
      const sEntry = -B - Math.sqrt(disc);
      if (sEntry < 0 || sEntry > L) continue;
      out.push(row(s, { t: sEntry / L, range: sEntry }));
    }
    out.sort((x, y) => x.t - y.t || (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
    return out;
  }

  /**
   * The densest particle cloud on the lens (within `radius` of the eye), or null.
   * @param {{pos:number[]}} pose
   * @param {{radius?:number}} [o2] radius default 2 m
   * @returns {{family:string, density:number, occludes:boolean, key:string, range:number}|null}
   */
  function onLens(pose, o2 = {}) {
    const eye = pose && typeof pose === "object" ? vec(pose.pos) : null;
    if (!eye) return null;
    const rl = o2 && Number.isFinite(o2.radius) && o2.radius > 0 ? o2.radius : LENS_RADIUS_M;
    let best = null;
    for (const s of snapshot()) {
      const d = Math.hypot(s.center[0] - eye[0], s.center[1] - eye[1], s.center[2] - eye[2]);
      if (d >= s.radius + rl) continue;
      let coverage;
      if (s.parts.length > 0) {
        let k = 0;
        for (const pt of s.parts) {
          const dp = Math.hypot(pt[0] - eye[0], pt[1] - eye[1], pt[2] - eye[2]);
          if (dp <= rl + pt[3]) k += 1;
        }
        coverage = clamp01((4 * k) / s.parts.length);
      } else {
        coverage = d <= s.radius ? 1 : clamp01((s.radius + rl - d) / rl);
      }
      const density = clamp01(s.density * coverage);
      if (density <= 0.02) continue;
      if (!best || density > best.density + 1e-12 || (Math.abs(density - best.density) <= 1e-12 && s.key < best.key)) {
        best = { family: s.family ?? "particles", density, occludes: s.occludes, key: s.key, range: Math.max(0, d - s.radius) };
      }
    }
    return best;
  }

  /**
   * Emitters within rangeM of the eye whose sphere overlaps the (diagonal) view cone.
   * @param {{pos:number[], q?:number[], h?:number, p?:number, r?:number, fov?:number}} pose
   * @param {{rangeM?:number, fovDeg?:number, aspect?:number}} [o2]
   * @returns {object[]} rows with `range`, nearest first
   */
  function inView(pose, o2 = {}) {
    const eye = pose && typeof pose === "object" ? vec(pose.pos) : null;
    if (!eye) return [];
    const oo = o2 && typeof o2 === "object" ? o2 : {};
    const rangeM = Number.isFinite(oo.rangeM) ? Math.max(0, oo.rangeM) : 25;
    const fov = Number.isFinite(oo.fovDeg) && oo.fovDeg > 0 && oo.fovDeg < 180 ? oo.fovDeg
      : Number.isFinite(pose.fov) && pose.fov > 0 && pose.fov < 180 ? pose.fov : 60;
    const aspect = Number.isFinite(oo.aspect) && oo.aspect > 0 ? oo.aspect : 16 / 9;
    const fwd = qToBasis(poseQuat(pose)).forward;
    const th = Math.tan((fov * DEG) / 2);
    const half = Math.atan(Math.hypot(th, th * aspect));
    const out = [];
    for (const r of near(eye, rangeM)) {
      const v = [r.center[0] - eye[0], r.center[1] - eye[1], r.center[2] - eye[2]];
      const d = Math.hypot(v[0], v[1], v[2]);
      if (d <= r.radius) {
        out.push(r);
        continue;
      }
      const cosA = (v[0] * fwd[0] + v[1] * fwd[1] + v[2] * fwd[2]) / d;
      const ang = Math.acos(Math.max(-1, Math.min(1, cosA)));
      if (ang <= half + Math.asin(Math.min(1, r.radius / d))) out.push(r);
    }
    return out;
  }

  return {
    near,
    alongSegment,
    onLens,
    inView,
    snapshot,
    /** Force the next query to re-enumerate the emitters. */
    invalidate() {
      cacheValid = false;
    },
    /**
     * Catalog lookup for an emitter DID (and synthesized fxProfile).
     * @param {number} did @param {string|null} [fxProfile]
     * @returns {{family:string, behavior:string|null}|null}
     */
    familyInfo(did, fxProfile = null) {
      return lookup(did, fxProfile);
    },
    /** @returns {{rebuilds:number, emitters:number, skipped:number}} */
    stats() {
      return { ...counters };
    },
  };
}
