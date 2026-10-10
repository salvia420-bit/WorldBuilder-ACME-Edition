// scene3d/vfx/fx_distort.js — tier 1 `?fxDistort` (2026-10-10): the source
// registry behind the screen-space distortion effect (vfx/fx_distort_effect.js).
//
// No postprocessing / takram import: the particle chunk (emitter-bound sources)
// and play_effect_vfx.js (one-shot shockwaves) feed it, the composer reads it.
//
// KINDS (particle_fx.js FX_DISTORT_KIND):
//   1 heat    a rising shimmer column above the source (fires, braziers,
//             flaming weapons, lava fumes)
//   2 swirl   a slow vortex twist centred on the source (portals, dark
//             vortices, enchantment columns)
//   3 ring    an expanding shockwave ring, once (bursts, impacts, explosions,
//             level-up / create / death cues)
//   4 ripple  soft concentric ripples (runes, sigils)
//
// Every source is a WORLD position + radius (metres) + strength. Each frame the
// effect asks `collectFxDistortSources(camera, w, h, out)` for the strongest
// sources on screen (projected disc, depth for the in-front gate), at most
// FX_DISTORT_MAX — the shader loops over that fixed-size array.

import * as THREE from "three";
import { fxTier1Enabled } from "./fx_tier1.js";

export const FX_DISTORT_MAX = 16;
export const FX_DISTORT_KINDS = Object.freeze({ heat: 1, swirl: 2, ring: 3, ripple: 4 });

const _sources = new Set();
const _stats = { added: 0, shockwaves: 0, live: 0, onScreen: 0 };
const RING_MS = 650;
const SHOCK_MAX = 8;

function _now() {
  return typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
}

/**
 * Bind a distortion source to a particle emitter. `resolvePosition(out)` gives
 * the emitter origin in THREE world space (false ⇒ skip this frame). A
 * `transient` source (a finite emitter) of kind ring fires once from its
 * creation; persistent kinds follow the emitter while it has particles.
 * @returns {object|null} handle (pass to releaseFxDistortSource)
 */
export function addFxDistortSource(o) {
  if (!fxTier1Enabled("fxDistort") || !o || typeof o.resolvePosition !== "function") return null;
  if (!(o.strength > 0) || !(o.radius > 0) || !(o.kind >= 1 && o.kind <= 4)) return null;
  const s = {
    kind: o.kind | 0,
    strength: Math.min(1, o.strength),
    radius: Math.min(12, o.radius),
    resolvePosition: o.resolvePosition,
    emitter: o.emitter || null,
    t0: _now(),
    seed: Math.random(),
    released: false,
    pos: new THREE.Vector3(),
  };
  _sources.add(s);
  _stats.added++;
  return s;
}

/** Stop a source (emitter finished / destroyed). */
export function releaseFxDistortSource(s) {
  if (!s) return;
  s.released = true;
  _sources.delete(s);
}

/**
 * A one-shot shockwave ring at a THREE-world position (PlayEffect cues).
 * @param {{position:{x:number,y:number,z:number}, radius?:number, strength?:number, durationMs?:number}} o
 */
export function spawnFxShockwave(o) {
  if (!fxTier1Enabled("fxDistort") || !o || !o.position) return null;
  const p = o.position;
  if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) return null;
  let rings = 0;
  let oldest = null;
  for (const s of _sources) {
    if (s.shock) { rings++; if (!oldest || s.t0 < oldest.t0) oldest = s; }
  }
  if (rings >= SHOCK_MAX && oldest) _sources.delete(oldest);
  const pos = new THREE.Vector3(p.x, p.y, p.z);
  const s = {
    kind: FX_DISTORT_KINDS.ring,
    strength: Math.min(1, Number.isFinite(o.strength) ? o.strength : 0.6),
    radius: Math.min(12, Number.isFinite(o.radius) ? o.radius : 3),
    resolvePosition: (out) => { out.copy(pos); return true; },
    emitter: null,
    t0: _now(),
    durationMs: Math.max(150, o.durationMs ?? RING_MS),
    seed: Math.random(),
    released: false,
    shock: true,
    pos: new THREE.Vector3(),
  };
  _sources.add(s);
  _stats.shockwaves++;
  return s;
}

const _v = new THREE.Vector3();
const _cand = [];

/**
 * Project the live sources for this frame (`camera` must have current
 * matrices). Fills `out` (reused array of
 * {x, y, r, radiusM, depth, kind, strength, phase, seed}: x, y in [0,1] uv, r
 * the screen radius in uv-height units, radiusM the source radius in metres,
 * depth the view distance in metres,
 * phase the ring's 0..1 progress) with at most FX_DISTORT_MAX entries,
 * strongest on-screen first. Prunes finished rings.
 */
export function collectFxDistortSources(camera, out, nowMs) {
  out.length = 0;
  _cand.length = 0;
  if (!camera || !fxTier1Enabled("fxDistort")) return out;
  const now = Number.isFinite(nowMs) ? nowMs : _now();
  const tanHalf = Math.tan(((camera.fov ?? 60) * Math.PI) / 360);
  let live = 0;
  for (const s of _sources) {
    if (s.released) { _sources.delete(s); continue; }
    let phase = 0;
    let k = 1;
    if (s.kind === FX_DISTORT_KINDS.ring) {
      const dur = s.durationMs ?? RING_MS;
      phase = (now - s.t0) / dur;
      if (phase >= 1) {
        if (s.shock) _sources.delete(s);
        continue;
      }
    } else if (s.emitter) {
      // persistent kinds breathe with the emitter: none once it runs dry
      if ((s.emitter.numParticles | 0) <= 0) continue;
    }
    if (!s.resolvePosition(s.pos)) continue;
    live++;
    _v.copy(s.pos).applyMatrix4(camera.matrixWorldInverse);
    const depth = -_v.z;
    if (!(depth > 0.3)) continue;
    // heat rises: shift the column's centre one radius up the view
    const ry = s.kind === FX_DISTORT_KINDS.heat ? s.radius * 0.9 : 0;
    _v.copy(s.pos);
    _v.y += ry;
    _v.project(camera);
    if (!(Math.abs(_v.x) < 1.6 && Math.abs(_v.y) < 1.6 && _v.z < 1)) continue;
    const r = s.radius / (depth * tanHalf * 2); // uv-height units
    if (r < 0.004) continue;
    // fade over distance so far sources do not shimmer the horizon
    k *= 1 - Math.min(1, Math.max(0, (depth - 60) / 60));
    if (k <= 0) continue;
    _cand.push({
      x: _v.x * 0.5 + 0.5,
      y: _v.y * 0.5 + 0.5,
      r: Math.min(0.6, r),
      radiusM: s.radius,
      depth,
      kind: s.kind,
      strength: s.strength * k,
      phase,
      seed: s.seed,
      score: s.strength * k * Math.min(0.3, r),
    });
  }
  _cand.sort((a, b) => b.score - a.score);
  for (let i = 0; i < _cand.length && out.length < FX_DISTORT_MAX; i++) out.push(_cand[i]);
  _stats.live = live;
  _stats.onScreen = out.length;
  return out;
}

/**
 * Tier 2 (vfx/fx_showcase.js): the nearest live SWIRL source within `maxDist`
 * m (horizontally) of a THREE-world point — a portal's swirl centre and
 * radius. `out` receives {x, y, z, radius, emitter}; null when none.
 */
export function fxDistortSwirlNear(pos, maxDist, out = {}) {
  if (!pos) return null;
  let best = null;
  let bestD = Infinity;
  for (const s of _sources) {
    if (s.released || s.kind !== FX_DISTORT_KINDS.swirl) continue;
    if (!s.resolvePosition(_swirlTmp)) continue;
    const dx = _swirlTmp.x - pos.x, dz = _swirlTmp.z - pos.z;
    const d = Math.hypot(dx, dz);
    if (d > maxDist || d >= bestD) continue;
    bestD = d;
    best = s;
    out.x = _swirlTmp.x; out.y = _swirlTmp.y; out.z = _swirlTmp.z;
  }
  if (!best) return null;
  out.radius = best.radius;
  out.emitter = best.emitter;
  return out;
}
const _swirlTmp = new THREE.Vector3();

/** Diagnostics. */
export function fxDistortStats() {
  return { ..._stats, sources: _sources.size };
}

/** Test seam. */
export function _resetFxDistortForTest() {
  _sources.clear();
  for (const k of Object.keys(_stats)) _stats[k] = 0;
}
