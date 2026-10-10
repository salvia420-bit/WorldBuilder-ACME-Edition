// scene3d/vfx/fx_decals.js — tier 2 `?fxDecals` (2026-10-10): the ground-mark
// registry behind vfx/fx_decal_effect.js.
//
// MARKS (FX_DECAL_KIND):
//   1 scorch  multiply-darkened char with a hot rim and embers that cool off
//             (explosions, fire / lightning / nether bolt impacts, flame breath,
//             the smites)
//   2 frost   a whitening rime with crystal glints (frost bolts, frost breath)
//   3 acid    a green stain with a wet, bubbling sheen (acid bolts, acid breath)
//   4 ring    an emissive light ring (the portal and lifestone showcase rings)
//
// A mark is a world-space BOX (centre, horizontal radius, half-height, yaw): the
// effect draws the box's back faces, reconstructs each pixel's world position
// from the scene depth, keeps the up-facing surface points inside the box and
// paints the procedural mark there — on terrain, a dungeon floor, a step, a
// rock, whatever lies under it. Blood is NOT here: `?blood` (blood_decals.js)
// already stamps every splatter.
//
// Transient marks fade over their last 40 % and are capped at FX_DECAL_MAX
// (the oldest goes first); persistent ones (the showcase rings) live until
// released and are capped separately, so a fight never evicts a portal's ring.
//
// No postprocessing / particles import: play_effect_vfx.js (cues) and
// vfx/fx_showcase.js feed it, the composer reads it.

import { fxTier2Enabled } from "./fx_tier2.js";

export const FX_DECAL_MAX = 32;
export const FX_DECAL_PERSISTENT_MAX = 8;
export const FX_DECAL_KIND = Object.freeze({ scorch: 1, frost: 2, acid: 3, ring: 4 });
const RANGE_M = 70;

/** Per-kind defaults: life (ms), radius (m), half-height (m). */
export const FX_DECAL_DEFAULTS = Object.freeze({
  scorch: Object.freeze({ lifeMs: 22000, radius: 1.5, height: 1.2, color: [1.0, 0.42, 0.1] }),
  frost: Object.freeze({ lifeMs: 14000, radius: 1.6, height: 1.2, color: [0.6, 0.85, 1.0] }),
  acid: Object.freeze({ lifeMs: 16000, radius: 1.4, height: 1.2, color: [0.5, 1.0, 0.25] }),
  ring: Object.freeze({ lifeMs: 0, radius: 1.8, height: 1.5, color: [0.75, 0.5, 1.0] }),
});

const _transient = [];   // oldest first
const _persistent = new Set();
const _stats = { spawned: 0, evicted: 0, persistent: 0, live: 0, drawn: 0 };

function _now() {
  return typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
}

function _make(o, kindName) {
  const def = FX_DECAL_DEFAULTS[kindName];
  const p = o.position;
  const c = Array.isArray(o.color) && o.color.length === 3 ? o.color : def.color;
  return {
    kind: FX_DECAL_KIND[kindName],
    kindName,
    x: p.x, y: p.y, z: p.z,
    radius: Math.min(8, Math.max(0.2, Number.isFinite(o.radius) ? o.radius : def.radius)),
    height: Math.min(4, Math.max(0.2, Number.isFinite(o.height) ? o.height : def.height)),
    yaw: Number.isFinite(o.yaw) ? o.yaw : Math.random() * Math.PI * 2,
    color: [+c[0] || 0, +c[1] || 0, +c[2] || 0],
    intensity: Number.isFinite(o.intensity) ? Math.max(0, o.intensity) : 1,
    seed: Math.random(),
    t0: Number.isFinite(o.nowMs) ? o.nowMs : _now(),
    lifeMs: Number.isFinite(o.lifeMs) ? Math.max(500, o.lifeMs) : def.lifeMs,
    persistent: false,
    released: false,
    fade: 1,
    dist2: 0,
  };
}

function _validPos(p) {
  return !!p && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z);
}

/**
 * A transient ground mark at a THREE-world point (the ground under the event).
 * @param {{position:{x:number,y:number,z:number}, kind:string, radius?:number,
 *   height?:number, lifeMs?:number, color?:number[], intensity?:number, yaw?:number,
 *   nowMs?:number}} o
 * @returns {object|null}
 */
export function spawnFxDecal(o) {
  if (!fxTier2Enabled("fxDecals") || !o || !_validPos(o.position)) return null;
  const kindName = typeof o.kind === "string" ? o.kind : null;
  if (!kindName || !FX_DECAL_KIND[kindName] || kindName === "ring") return null;
  const d = _make(o, kindName);
  _transient.push(d);
  while (_transient.length > FX_DECAL_MAX) { _transient.shift(); _stats.evicted++; }
  _stats.spawned++;
  return d;
}

/**
 * A persistent mark (the showcase rings) that lives until `releaseFxDecal`.
 * @returns {object|null}
 */
export function addFxDecal(o) {
  if (!fxTier2Enabled("fxDecals") || !o || !_validPos(o.position)) return null;
  const kindName = typeof o.kind === "string" ? o.kind : "ring";
  if (!FX_DECAL_KIND[kindName]) return null;
  if (_persistent.size >= FX_DECAL_PERSISTENT_MAX) return null;
  const d = _make(o, kindName);
  d.persistent = true;
  d.lifeMs = 0;
  _persistent.add(d);
  _stats.persistent = _persistent.size;
  return d;
}

/** Drop a persistent (or transient) mark. */
export function releaseFxDecal(d) {
  if (!d) return;
  d.released = true;
  if (_persistent.delete(d)) _stats.persistent = _persistent.size;
  const i = _transient.indexOf(d);
  if (i >= 0) _transient.splice(i, 1);
}

/** Pure: a transient mark's opacity at `ageMs` (fades over the last 40 %, in over 120 ms). */
export function fxDecalFade(ageMs, lifeMs) {
  if (!(lifeMs > 0)) return 1;
  if (ageMs < 0) return 0;
  if (ageMs >= lifeMs) return 0;
  const fin = Math.min(1, ageMs / 120);
  const t = ageMs / lifeMs;
  return fin * (t < 0.6 ? 1 : 1 - (t - 0.6) / 0.4);
}

const _out = [];
/**
 * The marks to draw this frame, nearest first, at most FX_DECAL_MAX, within
 * 70 m of `eye` ({x,y,z} THREE world). Prunes the expired ones. Each entry
 * carries `fade` (0..1) and `ageSec`.
 */
export function collectFxDecals(eye, out = _out, nowMs) {
  out.length = 0;
  if (!fxTier2Enabled("fxDecals")) return out;
  const now = Number.isFinite(nowMs) ? nowMs : _now();
  for (let i = _transient.length - 1; i >= 0; i--) {
    const d = _transient[i];
    const age = now - d.t0;
    d.fade = fxDecalFade(age, d.lifeMs);
    if (age >= d.lifeMs || d.released) { _transient.splice(i, 1); continue; }
  }
  const consider = (d) => {
    const dx = d.x - (eye ? eye.x : 0), dy = d.y - (eye ? eye.y : 0), dz = d.z - (eye ? eye.z : 0);
    d.dist2 = dx * dx + dy * dy + dz * dz;
    if (eye && d.dist2 > (RANGE_M + d.radius) * (RANGE_M + d.radius)) return;
    d.ageSec = (now - d.t0) / 1000;
    if (d.persistent) d.fade = 1;
    if (d.fade <= 0) return;
    out.push(d);
  };
  for (const d of _persistent) consider(d);
  for (const d of _transient) consider(d);
  out.sort((a, b) => a.dist2 - b.dist2);
  if (out.length > FX_DECAL_MAX) out.length = FX_DECAL_MAX;
  _stats.live = _transient.length + _persistent.size;
  _stats.drawn = out.length;
  return out;
}

/** Diagnostics (`window.__fxDecals`). */
export function fxDecalStats() {
  return { ..._stats, transient: _transient.length, persistent: _persistent.size };
}

/** Test seam. */
export function _resetFxDecalsForTest() {
  _transient.length = 0;
  _persistent.clear();
  for (const k of Object.keys(_stats)) _stats[k] = 0;
}
