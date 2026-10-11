// scene3d/vfx/weapon_fx.js — per-weapon effects (2026-10-10, `?weaponFx`).
//
// WHAT IT REPLACES, AND WHY. Until now a held or dropped weapon took the
// statics' frag SET (catalog "tip-flex" ⇒ [deformation.tipFlex, emissive.glint],
// "rigid-glint" ⇒ [emissive.glint, weathering.tarnish]) plus, with a UiEffects
// bit, emissive.itemAura — all on SHARED variant materials keyed by surface.
// Three things went wrong on a weapon that moves with its wielder:
//   1. Shaking. Every per-object variation (the sway phase, the glint phase, the
//      tarnish amount) came from `vfxHash01(modelMatrix[3].xy)`: the mesh's
//      WORLD position. Right for a static placement; re-rolled every frame on a
//      held weapon. tipFlex's ±1.5° sine therefore jumped to a random point of
//      its cycle every frame, and it ran on daggers, swords and maces too (the
//      catalog's "tip-flex" is any weapon with aspect > 3).
//   2. White. itemAura added a flat `tint * 0.5` over the whole item, glint a
//      0.4 sparkle, both in DISPLAY units — but the composer applies a 5x
//      exposure before AgX, so Magical items (most loot) washed to lavender-
//      white and Slash / Pierce / Bludgeon items to white.
//   3. Too bright in shade. `Material.clone()` drops the base's onBeforeCompile,
//      so every variant lost the CSM patch, whose 0.45..1 shade multiplier
//      applies to entity materials too.
//
// WHAT THIS DOES. One small state per weapon-ish entity, made at spawn:
//   • its OWN materials (MaterialCache.makeOwnedVariant: CSM kept, entity-owned,
//     freed with the rig) carrying [deformation.weaponFlex?, emissive.weaponAura],
//     with uniforms bound BY REFERENCE from this weapon's bundle `u` — so every
//     weapon has its own stable phase, glow and bend, and the GLSL is still one
//     program per component SET;
//   • a shaft frame from the weapon's own mesh bounds and its grip (the weapon
//     root's origin is the hand once it is mounted);
//   • per frame (tickWeaponFx, after the rigs are posed): two springs (one per
//     shaft end) chase the real ends — acceleration bends a POLE, steady motion
//     does not; the shine is scheduled every few seconds and on each swing; a
//     swing flares the glow; base-material changes (a texture arriving late, a
//     fade, a recolour) are mirrored onto our clones.
//
// INVARIANTS (the VFX rule): reads static data (UiEffects, name, mesh bounds),
// the rendered pose and the clock; writes cloned-material uniforms only. No wire,
// no physics, no light, deterministic (seeded per guid).

import * as THREE from "three";
import { VFX_GLOBALS, installVfxComponentPatch, MATERIAL_SURFACE_FIELDS } from "../materials.js";
import { visualEnabled } from "../vfx_catalog.js";
import {
  weaponFxEnabled,
  weaponFlexEnabled,
  weaponAuraEnabled,
  weaponShineEnabled,
} from "../vfx_flags.js";
import {
  auraForUiEffects,
  auraForElement,
  elementFromWeaponName,
  nameLooksLikeWeapon,
  flexClassFor,
  longAxisOf,
  shaftFrame,
  flexParams,
  makeSpring,
  stepSpring,
  bendVector,
  makeRng,
  seed01,
} from "./weapon_class.js";
import { WFX_KIND } from "./weapon_fx_glsl.js";
import { weaponFlex } from "./components/weaponFlex.js";
import { weaponAura } from "./components/weaponAura.js";

// ---------------------------------------------------------------------------
// Tuning (URL-pinnable, live via window.__weaponFx)
// ---------------------------------------------------------------------------

function _numParam(name, def, min, max) {
  try {
    if (typeof window !== "undefined" && window.location) {
      const raw = new URLSearchParams(window.location.search).get(name);
      if (raw != null && raw !== "") {
        const n = Number(raw);
        if (Number.isFinite(n)) return Math.min(max, Math.max(min, n));
      }
    }
  } catch (_) { /* default */ }
  return def;
}
function _strParam(name) {
  try {
    if (typeof window !== "undefined" && window.location) {
      return new URLSearchParams(window.location.search).get(name);
    }
  } catch (_) { /* default */ }
  return null;
}

let _auraGain = _numParam("weaponAuraGain", 1, 0, 4);
let _flexGain = _numParam("weaponFlexGain", 1, 0, 4);
// `?weaponFlexLoco` (DEFAULT ON, `=off` escape; 2026-10-11, measured on the 1070): the run
// cycle's arm swing drives the pole springs near their 2-3 Hz natural frequency, so a held spear
// bent 4.8 deg on average (6.8 max) while running where the design sways ~0.5 deg. Full gain
// is kept for the whip after a swing (FLEX_SWING_FULL_MS, then a FLEX_SWING_EASE_MS ramp);
// otherwise the bend is scaled by the locomotion gain (`?weaponFlexLocoGain`, default 0.12).
const FLEX_LOCO_ON = !/^(off|0|false|no)$/i.test(String(_strParam("weaponFlexLoco") ?? "").trim());
let _flexLocoGain = _numParam("weaponFlexLocoGain", 0.12, 0, 1);
export const FLEX_SWING_FULL_MS = 1600;
export const FLEX_SWING_EASE_MS = 500;
/** The flex gain multiplier `sinceSwingMs` after the wielder's last swing (pure). */
export function flexLocoScale(sinceSwingMs, locoGain = _flexLocoGain, on = FLEX_LOCO_ON) {
  if (!on) return 1;
  const t = +sinceSwingMs;
  if (!(t >= 0) || t <= FLEX_SWING_FULL_MS) return Number.isFinite(t) && t >= 0 ? 1 : locoGain;
  const k = Math.min(1, (t - FLEX_SWING_FULL_MS) / FLEX_SWING_EASE_MS);
  return 1 + (locoGain - 1) * k;
}
/** Time constant of the applied scale (s). The spring keeps integrating at full strength and only
 * its output is scaled, so a swing started at a run must not jump 0.12 → 1 in one frame (the
 * run's ~5 deg lag would pop into view): it reaches ~95 % in 0.2 s, before the whip. */
export const FLEX_SCALE_TAU_S = 0.06;
/** One frame of the applied scale chasing `target` (pure; a NaN `cur` starts at the target). */
export function approachFlexScale(cur, target, dt, tau = FLEX_SCALE_TAU_S) {
  if (!Number.isFinite(cur)) return target;
  if (!(dt > 0)) return cur;
  return cur + (target - cur) * (1 - Math.exp(-dt / tau));
}
let _shineGain = _numParam("weaponShineGain", 1, 0, 4);
// `?weaponAuraForce=fire|frost|lightning|acid|nether|magic|poison|health|mana|stamina`
// shows that glow on EVERY weapon-ish item (eye-test aid; live: __weaponFx.force()).
let _forced = auraForElement(String(_strParam("weaponAuraForce") || "").toLowerCase());

/** Tone-mapper input units → pre-exposure radiance: K / exposure (K = the gain). */
const _cal = { value: 0.2 };
/** Beyond this camera distance a pole stops simulating (its bend relaxes to 0). */
const FLEX_RANGE_M = 45;

// ---------------------------------------------------------------------------
// Decision at spawn
// ---------------------------------------------------------------------------

/**
 * Bounds of the item's mesh in its part's object space, from the spawn's
 * part groups (`[{groups:[{geometry}]}]`). Weapons are single-part (740 of the
 * 744 catalog weapon setups); with more than one non-empty part the frame is
 * off (whole-object glow, no bend).
 */
export function weaponGeometryOf(partGroups) {
  if (!Array.isArray(partGroups)) return null;
  let partIndex = -1;
  let nonEmpty = 0;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let p = 0; p < partGroups.length; p++) {
    const groups = partGroups[p] && partGroups[p].groups;
    if (!Array.isArray(groups) || groups.length === 0) continue;
    nonEmpty += 1;
    if (partIndex < 0) partIndex = p;
    if (p !== partIndex) continue;
    for (const g of groups) {
      const geo = g && g.geometry;
      if (!geo) continue;
      try { if (!geo.boundingBox && typeof geo.computeBoundingBox === "function") geo.computeBoundingBox(); } catch (_) { /* skip */ }
      const bb = geo.boundingBox;
      if (!bb || !Number.isFinite(bb.min.x) || !Number.isFinite(bb.max.x)) continue;
      min[0] = Math.min(min[0], bb.min.x); min[1] = Math.min(min[1], bb.min.y); min[2] = Math.min(min[2], bb.min.z);
      max[0] = Math.max(max[0], bb.max.x); max[1] = Math.max(max[1], bb.max.y); max[2] = Math.max(max[2], bb.max.z);
    }
  }
  if (partIndex < 0 || !Number.isFinite(min[0])) return null;
  const la = longAxisOf(min, max);
  return { partIndex, singlePart: nonEmpty === 1, min, max, axis: la.axis, length: la.length, width: la.width };
}

/**
 * What a spawning item gets, or null (not weapon-ish, no glow bit).
 * Pure given its inputs + the flags.
 * @param {{archetype?:string, uiEffects?:number, name?:string, geometry?:object|null}} o
 */
export function weaponFxPlanFor({ archetype, uiEffects, name, geometry }) {
  if (!visualEnabled() || !weaponFxEnabled()) return null;
  const catalogWeapon = archetype === "tip-flex" || archetype === "rigid-glint";
  const weaponish = catalogWeapon || nameLooksLikeWeapon(name);
  let aura = null;
  if (weaponAuraEnabled()) {
    aura = auraForUiEffects(uiEffects);
    if (!aura && weaponish) aura = auraForElement(elementFromWeaponName(name));
    if (_forced && weaponish) aura = _forced;
  }
  const shine = weaponShineEnabled() && weaponish;
  let flexClass = null;
  if (weaponFlexEnabled() && weaponish && geometry && geometry.singlePart) {
    flexClass = flexClassFor({ name, length: geometry.length, width: geometry.width });
  }
  if (!aura && !shine && !flexClass) return null;
  return { weaponish, aura, shine, flexClass };
}

// ---------------------------------------------------------------------------
// State + materials
// ---------------------------------------------------------------------------

const _live = new Set();
let _seq = 0;

function _uniformBundle() {
  return {
    uWfxOrigin: { value: new THREE.Vector3() },
    uWfxAxis: { value: new THREE.Vector3(0, 0, 1) },
    uWfxLen: { value: new THREE.Vector2(1, 1e-3) },
    uWfxFrame: { value: 0 },
    uWfxGrip: { value: 0 },
    uWfxBendPos: { value: new THREE.Vector3() },
    uWfxBendNeg: { value: new THREE.Vector3() },
    uWfxAuraColor: { value: new THREE.Vector3() },
    uWfxAuraKind: { value: 0 },
    uWfxLevel: { value: 1 },
    uWfxShine: { value: new THREE.Vector4(-1e4, 0.5, 0, 0) },
    uWfxSeed: { value: 0 },
    uWfxCal: _cal,
  };
}

function _applyAura(st, aura) {
  st.aura = aura || null;
  st.u.uWfxAuraKind.value = aura ? aura.kind : WFX_KIND.none;
  if (aura) st.u.uWfxAuraColor.value.set(aura.color[0], aura.color[1], aura.color[2]);
  else st.u.uWfxAuraColor.value.set(0, 0, 0);
}

/**
 * Create the state for a spawning entity (entities.js, before its meshes are
 * built). Returns null when the item gets nothing or the cache cannot make
 * owned variants (stale build, wireframe).
 * @param {{inst:object, guid:number, name?:string, uiEffects?:number, archetype?:string,
 *          partGroups:Array, materialCache:object, nowMs?:number}} o
 */
export function weaponFxBegin({ inst, guid, name, uiEffects, archetype, partGroups, materialCache, nowMs }) {
  if (!materialCache || typeof materialCache.makeOwnedVariant !== "function" || materialCache.wireframeMode) return null;
  // Cheap gate first (every spawn passes through here — creatures, doors, players):
  // only a weapon-ish item or one carrying a glow bit is worth measuring.
  const weaponish = archetype === "tip-flex" || archetype === "rigid-glint" || nameLooksLikeWeapon(name);
  if (!weaponish && !auraForUiEffects(uiEffects)) return null;
  const geometry = weaponish ? weaponGeometryOf(partGroups) : null;
  const plan = weaponFxPlanFor({ archetype, uiEffects, name, geometry });
  if (!plan) return null;
  const comps = [];
  if (plan.flexClass) comps.push(weaponFlex);
  if (plan.aura || plan.shine || _forced) comps.push(weaponAura);
  if (comps.length === 0) return null;
  const now = Number.isFinite(nowMs) ? nowMs : _now();
  const u = _uniformBundle();
  const g = guid >>> 0;
  const frameOk = !!(geometry && geometry.singlePart && geometry.length > 0.05);
  const st = {
    id: ++_seq,
    inst,
    guid: g,
    name: typeof name === "string" ? name : "",
    plan,
    aura: null,
    // the sweep runs along the shaft frame; a multi-part item has none (it would
    // be a whole-item flash), so it gets no shine
    shine: plan.shine && frameOk,
    flexClass: plan.flexClass,
    geometry,
    partIndex: geometry ? geometry.partIndex : 0,
    frameOk,
    u,
    comps,
    setKey: comps.map((c) => c.id).join("+"),
    globals: Object.assign({}, VFX_GLOBALS, { wfx: u }),
    materialCache,
    mats: new Map(),            // surfaceDid → {did, mat, base, snap, cacheBase}
    held: null,                 // last seen held state (null = never framed)
    gx: NaN, gy: NaN, gz: NaN,  // last grip (object space) the frame was built for
    springPos: makeSpring(),
    springNeg: makeSpring(),
    paramsPos: flexParams(1),
    paramsNeg: flexParams(1),
    rng: makeRng(g ^ 0xa5a5a5a5),
    nextShineMs: now + 2500 + 6000 * ((seed01(g ^ 0x51ed) || 0.5)),
    swingMs: -1e9,
    flexScale: NaN,   // `?weaponFlexLoco` applied scale (approachFlexScale)
    lastSwing: 0,
    bendDegPos: 0,
    bendDegNeg: 0,
    disposed: false,
  };
  u.uWfxSeed.value = seed01(g);
  _applyAura(st, plan.aura);
  return st;
}

function _isCacheBase(mc, did, base) {
  try {
    if (base === mc.fallbackMaterial) return true;
    if (mc.materials && mc.materials.get(did) === base) return true;
    if (mc.frontSideMaterials && mc.frontSideMaterials.get(did) === base) return true;
  } catch (_) { /* not a cache base */ }
  return false;
}

function _snap(base) {
  const s = {};
  for (const k of MATERIAL_SURFACE_FIELDS) s[k] = base[k];
  const c = base.color, e = base.emissive;
  s.cr = c ? c.r : 0; s.cg = c ? c.g : 0; s.cb = c ? c.b : 0;
  s.er = e ? e.r : 0; s.eg = e ? e.g : 0; s.eb = e ? e.b : 0;
  return s;
}

function _makeMat(st, did, base) {
  const mat = st.materialCache.makeOwnedVariant(base, st.setKey, (m) => {
    for (const comp of st.comps) installVfxComponentPatch(m, comp, {}, st.globals);
  });
  if (!mat) return null;
  mat.userData.__wfx = st.id;
  mat.name = (base.name || "surface") + "+wfx";
  const rec = { did, mat, base, snap: _snap(base), cacheBase: _isCacheBase(st.materialCache, did, base) };
  st.mats.set(did, rec);
  return rec;
}

/**
 * The material a spawning mesh of this weapon should use for `did`, built on
 * `base` (the cache / paletted material the entity would otherwise use). One
 * per surface per weapon. Falls back to `base`.
 */
export function weaponFxMaterial(st, did, base) {
  if (!st || !base) return base;
  const d = did >>> 0;
  const rec = st.mats.get(d);
  if (rec) return rec.mat;
  const made = _makeMat(st, d, base);
  return made ? made.mat : base;
}

/** Commit a built weapon to the per-frame tick (entities.js, after the meshes). */
export function weaponFxCommit(st) {
  if (!st || st.disposed) return;
  if (st.mats.size === 0) return; // nothing was built (wireframe / every surface fell through)
  _live.add(st);
}

/** The weapon's own material for `did`, if any (entities.js clone-on-write). */
export function weaponFxOwnedMaterial(inst, did) {
  const st = inst && inst._wfx;
  if (!st || st.disposed) return null;
  const rec = st.mats.get(did >>> 0);
  return rec ? rec.mat : null;
}

/** Drop a weapon (entity dispose). Idempotent; frees our materials. */
export function weaponFxForget(st) {
  if (!st || st.disposed) return;
  st.disposed = true;
  _live.delete(st);
  for (const rec of st.mats.values()) {
    try { rec.mat.dispose(); } catch (_) { /* already freed */ }
  }
  st.mats.clear();
}

// ---------------------------------------------------------------------------
// Per-frame tick
// ---------------------------------------------------------------------------

function _now() {
  return (typeof performance !== "undefined" && performance.now) ? performance.now() : 0;
}

const _PROGRAM_FIELDS = new Set([
  "map", "normalMap", "emissiveMap", "roughnessMap", "aoMap",
  "transparent", "alphaTest", "blending", "fog", "forceSinglePass",
]);

function _copyAll(dst, src) {
  for (const k of MATERIAL_SURFACE_FIELDS) dst[k] = src[k];
  if (dst.color && src.color) dst.color.copy(src.color);
  if (dst.emissive && src.emissive) dst.emissive.copy(src.emissive);
  if (dst.normalScale && src.normalScale) dst.normalScale.copy(src.normalScale);
  dst.needsUpdate = true;
}

function _syncDelta(rec) {
  const b = rec.base, m = rec.mat, s = rec.snap;
  let prog = false;
  for (const k of MATERIAL_SURFACE_FIELDS) {
    const v = b[k];
    if (v !== s[k]) {
      m[k] = v;
      s[k] = v;
      if (_PROGRAM_FIELDS.has(k)) prog = true;
    }
  }
  const c = b.color;
  if (c && m.color && (c.r !== s.cr || c.g !== s.cg || c.b !== s.cb)) {
    m.color.copy(c); s.cr = c.r; s.cg = c.g; s.cb = c.b;
  }
  const e = b.emissive;
  if (e && m.emissive && (e.r !== s.er || e.g !== s.eg || e.b !== s.eb)) {
    m.emissive.copy(e); s.er = e.r; s.eg = e.g; s.eb = e.b;
  }
  if (prog) m.needsUpdate = true;
}

function _isAttachedChildNode(obj) {
  return obj && obj.userData && obj.userData.__attachedChildOf != null;
}

/**
 * Keep our clones on the meshes and in step with their bases:
 *  - a mesh whose material was replaced (recolour heal, appearance swap, a
 *    clone-on-write that missed us) gets a fresh clone of its NEW material;
 *  - a cache base that was replaced (the real texture arrived after the grey
 *    fallback, an evict + reinstall) is adopted wholesale;
 *  - in-place changes on a base (a texture upgrade, a fade) are mirrored.
 */
function _syncMaterials(st) {
  const inst = st.inst;
  const parts = inst.parts;
  let retired = null;
  if (Array.isArray(parts)) {
    for (const part of parts) {
      const kids = part && part.children;
      if (!kids) continue;
      for (let i = 0; i < kids.length; i++) {
        const mesh = kids[i];
        if (!mesh || !mesh.isMesh || _isAttachedChildNode(mesh)) continue;
        const m = mesh.material;
        if (!m || Array.isArray(m)) continue;
        if (m.userData && m.userData.__wfx === st.id) continue;
        const did = (mesh.userData && mesh.userData.surfaceDid) >>> 0;
        if (!did) continue;
        let rec = st.mats.get(did);
        if (rec && rec.base === m) { mesh.material = rec.mat; continue; }
        const old = rec ? rec.mat : null;
        rec = _makeMat(st, did, m);
        if (!rec) continue;
        mesh.material = rec.mat;
        if (old) (retired || (retired = [])).push(old);
        if (inst._entityMaterials && inst._entityMaterials.get(did) === old) inst._entityMaterials.set(did, rec.mat);
      }
    }
  }
  if (retired) {
    for (const mat of retired) {
      let used = false;
      for (const part of parts) {
        const kids = part && part.children;
        if (!kids) continue;
        for (let i = 0; i < kids.length && !used; i++) if (kids[i] && kids[i].material === mat) used = true;
        if (used) break;
      }
      if (!used) { try { mat.dispose(); } catch (_) { /* freed */ } }
    }
  }
  const mc = st.materialCache;
  for (const rec of st.mats.values()) {
    if (rec.cacheBase && mc && mc.materials) {
      const cur = mc.materials.get(rec.did);
      if (cur && cur !== rec.base) {
        _copyAll(rec.mat, cur);
        rec.base = cur;
        rec.snap = _snap(cur);
        continue;
      }
    }
    _syncDelta(rec);
  }
}

const _m = new THREE.Matrix4();
const _mInv = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _qInv = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _g = new THREE.Vector3();
const _tipP = new THREE.Vector3();
const _tipN = new THREE.Vector3();
const _piv = new THREE.Vector3();
const _cam = new THREE.Vector3();
const _bend = new THREE.Vector3();
const _arr3a = [0, 0, 0];
const _arr3b = [0, 0, 0];
const _lag = [0, 0, 0];
const _rv = [0, 0, 0];

/** Recompute the shaft frame when the held state or the grip moved. */
function _updateFrame(st, part, held) {
  const u = st.u;
  if (!st.frameOk || !st.geometry) {
    if (st.held !== held) { st.held = held; u.uWfxFrame.value = 0; u.uWfxGrip.value = held ? 1 : 0; }
    return false;
  }
  let grip = null;
  if (held) {
    _m.compose(part.position, part.quaternion, part.scale);
    _mInv.copy(_m).invert();
    _g.set(0, 0, 0).applyMatrix4(_mInv);
    if (!Number.isFinite(_g.x + _g.y + _g.z)) return false;
    grip = [_g.x, _g.y, _g.z];
    // unchanged grip (the usual case: a held weapon's parts sit still in their
    // placement frame) ⇒ nothing to do
    if (st.held === true && Math.abs(_g.x - st.gx) < 1e-4 && Math.abs(_g.y - st.gy) < 1e-4 && Math.abs(_g.z - st.gz) < 1e-4) return false;
    st.gx = _g.x; st.gy = _g.y; st.gz = _g.z;
  } else if (st.held === false) {
    return false;
  }
  st.held = held;
  const geo = st.geometry;
  const f = shaftFrame(geo.min, geo.max, geo.axis, grip);
  u.uWfxOrigin.value.set(f.origin[0], f.origin[1], f.origin[2]);
  u.uWfxAxis.value.set(f.dir[0], f.dir[1], f.dir[2]);
  u.uWfxLen.value.set(f.lenPos, f.lenNeg);
  u.uWfxFrame.value = 1;
  u.uWfxGrip.value = f.held ? 1 : 0;
  st.paramsPos = flexParams(f.lenPos);
  st.paramsNeg = flexParams(f.lenNeg);
  st.springPos.init = false;
  st.springNeg.init = false;
  u.uWfxBendPos.value.set(0, 0, 0);
  u.uWfxBendNeg.value.set(0, 0, 0);
  // the swing-trail blade sampler caches the weapon's root-space bounds
  try { st.inst._fxBlade = undefined; } catch (_) { /* fine */ }
  return true;
}

function _visible(obj) {
  for (let o = obj, n = 0; o && n < 16; o = o.parent, n++) if (o.visible === false) return false;
  return true;
}

function _relaxBend(st) {
  const u = st.u;
  if (u.uWfxBendPos.value.lengthSq() !== 0) u.uWfxBendPos.value.set(0, 0, 0);
  if (u.uWfxBendNeg.value.lengthSq() !== 0) u.uWfxBendNeg.value.set(0, 0, 0);
  st.springPos.init = false;
  st.springNeg.init = false;
  st.bendDegPos = 0;
  st.bendDegNeg = 0;
}

function _flexEnd(spring, params, tipW, len, dt, outVec, scale = 1) {
  _arr3a[0] = tipW.x; _arr3a[1] = tipW.y; _arr3a[2] = tipW.z;
  stepSpring(spring, _arr3a, dt, params, _lag);
  const inv = 1 / Math.max(len, 1e-6);
  _arr3b[0] = (tipW.x - _piv.x) * inv; _arr3b[1] = (tipW.y - _piv.y) * inv; _arr3b[2] = (tipW.z - _piv.z) * inv;
  bendVector(_lag, _arr3b, len, params, _flexGain * scale, _rv);
  // world rotation vector → the part's object space
  _bend.set(_rv[0], _rv[1], _rv[2]).applyQuaternion(_qInv);
  outVec.copy(_bend);
  return Math.hypot(_rv[0], _rv[1], _rv[2]) * 57.29578;
}

function _simulateFlex(st, part, dt, camPos, scale = 1) {
  const u = st.u;
  part.updateWorldMatrix(true, false);
  const mw = part.matrixWorld;
  const o = u.uWfxOrigin.value, a = u.uWfxAxis.value, L = u.uWfxLen.value;
  _piv.copy(o).applyMatrix4(mw);
  if (camPos && _piv.distanceToSquared(camPos) > FLEX_RANGE_M * FLEX_RANGE_M) { _relaxBend(st); return; }
  _tipP.set(o.x + a.x * L.x, o.y + a.y * L.x, o.z + a.z * L.x).applyMatrix4(mw);
  _tipN.set(o.x - a.x * L.y, o.y - a.y * L.y, o.z - a.z * L.y).applyMatrix4(mw);
  mw.decompose(_p, _q, _s);
  _qInv.copy(_q).invert();
  const lenP = _tipP.distanceTo(_piv);
  const lenN = _tipN.distanceTo(_piv);
  st.bendDegPos = _flexEnd(st.springPos, st.paramsPos, _tipP, lenP, dt, u.uWfxBendPos.value, scale);
  if (L.y > 0.15) {
    st.bendDegNeg = _flexEnd(st.springNeg, st.paramsNeg, _tipN, lenN, dt, u.uWfxBendNeg.value, scale);
  } else if (u.uWfxBendNeg.value.lengthSq() !== 0) {
    u.uWfxBendNeg.value.set(0, 0, 0);
    st.bendDegNeg = 0;
  }
}

function _startShine(st, tVfx, dur, strength) {
  st.u.uWfxShine.value.set(tVfx, dur, strength * _shineGain, 0);
}

function _tickOne(st, scene3d, now, dt, tVfx, camPos) {
  const inst = st.inst;
  if (st.disposed || !inst || !inst.root) { _live.delete(st); return; }
  _syncMaterials(st);
  const part = Array.isArray(inst.parts) ? inst.parts[st.partIndex] : null;
  const held = inst._attachedParentGuid != null && !!inst.root.parent;
  if (part) _updateFrame(st, part, held);
  const visible = _visible(inst.root);

  // the wielder's swing (entities.js setMotion → fx_ribbons.fxNoteSwing stamps it)
  let wielder = null;
  if (held) {
    try { wielder = scene3d?.entityManager?.entityMap?.get(inst._attachedParentGuid >>> 0) || null; } catch (_) { wielder = null; }
  }
  const stamp = wielder ? (wielder._fxSwingUntilMs || 0) : 0;
  const swung = !!stamp && stamp !== st.lastSwing;
  if (swung) { st.lastSwing = stamp; st.swingMs = now; }

  // flex (held poles only)
  if (st.flexClass && held && visible && part && st.u.uWfxFrame.value > 0.5 && dt > 0) {
    st.flexScale = approachFlexScale(st.flexScale, flexLocoScale(st.swingMs > 0 ? now - st.swingMs : Infinity), dt);
    _simulateFlex(st, part, dt, camPos, st.flexScale);
  } else if (st.flexClass) {
    _relaxBend(st);
  }

  // shine
  if (st.shine) {
    if (swung) {
      _startShine(st, tVfx, 0.32, 1.6);
      st.nextShineMs = now + 4000 + 4000 * st.rng();
    } else if (now >= st.nextShineMs) {
      if (visible) _startShine(st, tVfx, 0.55, held ? 1.25 : 0.9);
      st.nextShineMs = now + (held ? 5000 + 6000 * st.rng() : 7000 + 9000 * st.rng());
    }
  }
  // a swing flares the glow, decaying over ~half a second
  const since = now - st.swingMs;
  st.u.uWfxLevel.value = 1 + (since < 3000 ? 0.6 * Math.exp(-since / 450) : 0);
}

function _updateCalibration(scene3d) {
  let e = NaN;
  try { e = Number(scene3d?.renderer?.toneMappingExposure ?? globalThis.window?.liveScene3d?.renderer?.toneMappingExposure); } catch (_) { e = NaN; }
  if (!Number.isFinite(e) || e <= 0) e = 1;
  _cal.value = _auraGain / Math.max(0.25, e);
}

let _lastTickMs = -1;
let _warned = false;

/**
 * Per frame (loop.js, after the entity tick and the particle phase, so the
 * rigs are posed where this frame draws them).
 * @param {object} scene3d  the live facade (entityManager, renderer, camera)
 * @param {number} [nowMs]  test seam
 * @returns {number} live weapon count
 */
export function tickWeaponFx(scene3d, nowMs) {
  const now = Number.isFinite(nowMs) ? nowMs : _now();
  const dt = _lastTickMs < 0 ? 0 : Math.max(0, (now - _lastTickMs) / 1000);
  _lastTickMs = now;
  if (_live.size === 0) return 0;
  _updateCalibration(scene3d);
  const tVfx = VFX_GLOBALS.uTime.value;
  let camPos = null;
  try {
    const cam = scene3d?.cameraSwitcher?.activeCamera ?? scene3d?.camera;
    if (cam && typeof cam.getWorldPosition === "function") { cam.getWorldPosition(_cam); camPos = _cam; }
  } catch (_) { camPos = null; }
  for (const st of _live) {
    try {
      _tickOne(st, scene3d, now, dt, tVfx, camPos);
    } catch (e) {
      if (!_warned) {
        _warned = true;
        // eslint-disable-next-line no-console
        console.warn("[weapon-fx] tick failed (effects on that weapon pause):", e);
      }
    }
  }
  return _live.size;
}

// ---------------------------------------------------------------------------
// Diagnostics + live tuning (window.__weaponFx)
// ---------------------------------------------------------------------------

/** Counts for the HUD / a probe. */
export function weaponFxStats() {
  const out = { live: _live.size, held: 0, poles: 0, flexing: 0, shine: 0, materials: 0, auras: {} };
  for (const st of _live) {
    if (st.held) out.held++;
    if (st.flexClass) out.poles++;
    if (st.bendDegPos > 0.2 || st.bendDegNeg > 0.2) out.flexing++;
    if (st.shine) out.shine++;
    out.materials += st.mats.size;
    const k = st.aura ? st.aura.element : "none";
    out.auras[k] = (out.auras[k] || 0) + 1;
  }
  return out;
}

/** One row per live weapon. */
export function weaponFxList() {
  const rows = [];
  for (const st of _live) {
    const L = st.u.uWfxLen.value;
    rows.push({
      guid: "0x" + st.guid.toString(16),
      name: st.name,
      aura: st.aura ? st.aura.element : null,
      pole: st.flexClass === "pole",
      shine: st.shine,
      held: !!st.held,
      frame: st.u.uWfxFrame.value > 0.5,
      lenPos: +L.x.toFixed(2),
      lenNeg: +L.y.toFixed(2),
      bendDeg: [+st.bendDegPos.toFixed(2), +st.bendDegNeg.toFixed(2)],
      set: st.setKey,
    });
  }
  return rows;
}

/**
 * Show one glow on every live weapon-ish item (and future spawns), or restore
 * each item's own with null. Items without the aura component (pure-flex poles
 * with the shine off) are skipped.
 */
export function weaponFxForce(element) {
  _forced = element ? auraForElement(String(element).toLowerCase()) : null;
  for (const st of _live) {
    if (!st.comps.includes(weaponAura)) continue;
    _applyAura(st, _forced || st.plan.aura);
  }
  return _forced ? _forced.element : null;
}

/** Fire a shine sweep on every live weapon now. */
export function weaponFxShineAll() {
  const t = VFX_GLOBALS.uTime.value;
  for (const st of _live) if (st.shine) _startShine(st, t, 0.55, 1.4);
}

/** Test seam: drop every live weapon (no material disposal). */
export function _resetWeaponFxForTest() {
  _live.clear();
  _lastTickMs = -1;
  _forced = null;
}

if (typeof window !== "undefined") {
  window.__weaponFx = {
    stats: weaponFxStats,
    list: weaponFxList,
    force: weaponFxForce,
    shine: weaponFxShineAll,
    get auraGain() { return _auraGain; },
    set auraGain(v) { if (Number.isFinite(+v)) _auraGain = Math.max(0, +v); },
    get flexGain() { return _flexGain; },
    set flexGain(v) { if (Number.isFinite(+v)) _flexGain = Math.max(0, +v); },
    get flexLocoGain() { return _flexLocoGain; },
    set flexLocoGain(v) { if (Number.isFinite(+v)) _flexLocoGain = Math.min(1, Math.max(0, +v)); },
    get shineGain() { return _shineGain; },
    set shineGain(v) { if (Number.isFinite(+v)) _shineGain = Math.max(0, +v); },
  };
}
