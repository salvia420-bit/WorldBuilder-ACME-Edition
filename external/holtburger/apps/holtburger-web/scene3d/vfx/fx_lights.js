// scene3d/vfx/fx_lights.js — tier 1 (2026-10-10): effects light the world.
//
// TWO SWITCHES (scene3d/vfx/fx_tier1.js):
//
//   fxLights       FX light SOURCES. Every lit emitter (flames, portals, spell
//                  swirls, orbs, lightning — `light` > 0 in its tier-1 profile
//                  row) carries one light at the emitter origin, coloured from
//                  its texture x tint, flickering / breathing with the row's own
//                  flicker / pulse terms, dimming as the emitter runs dry. Every
//                  PlayEffect cue adds a short FLASH (spell launch, impact,
//                  buff, level-up...). They are plain source carriers in
//                  `scene3d.activeLights`, the same duck type as the viewer
//                  light: the fixed pool (lighting.js) picks the nearest ones
//                  into its constant 16 point slots, so the per-type light COUNT
//                  never changes (the relink-freeze rule). Flashes carry
//                  `__dynamicPriority` (they outrank static torches within 48 m,
//                  like projectile lights).
//   terrainLights  the TERRAIN takes the pool's point lights. Retail drew the
//                  landscape with fixed-function lighting off
//                  (ACRender::landPolyDraw → SetFFLighting(0), acclient.c:719994):
//                  torches, braziers, portals and bolts lit walls and creatures
//                  but never the ground. Here the nearest 8 lit pool slots feed a
//                  small fixed loop in the terrain shader (terrain.js) — the same
//                  linear falloff and half-Lambert wrap as the statics' retail
//                  light law (materials.js ?lightClamp), soft-kneed so a 20-100
//                  DAT-intensity torch makes a pool of light, not a white disc,
//                  and scaled down by day (`uFxLightGain`).
//
// DEDUPE. Most braziers / torches / portals already carry Setup LightInfo
// (statics.js → lighting.js). An emitter light within 1.5 m of a NON-FX source,
// or within 1.2 m of a stronger FX light (a portal's swirl + rim + motes), is
// suppressed; re-checked twice a second. Only FX lights within 48 m of the
// player are registered at all (the pool could not pick farther ones anyway),
// so `activeLights` grows by tens, not by every lit emitter in the resident
// ring.
//
// VFX invariant: reads emitter state + clock, writes only light carrier fields
// and shared uniforms; adds no light object to the scene, varies no program.

import * as THREE from "three";
import { fxTier1Enabled } from "./fx_tier1.js";

// ---------------------------------------------------------------------------
// Terrain uniforms (shared BY IDENTITY with every terrain material)
// ---------------------------------------------------------------------------

export const TERRAIN_FX_LIGHT_COUNT = 8;

// Day / night response of the ground (a torch by day barely shows; at night it
// paints its pool). `?terrainLightGain=N` scales both (live: __fxLights.terrainGain).
export const TERRAIN_FX_LIGHT_DAY_GAIN = 0.18;
export const TERRAIN_FX_LIGHT_NIGHT_GAIN = 0.75;
export const TERRAIN_FX_LIGHT_KNEE = 0.6;

// FLAT typed arrays, not Vector4s: three uploads a numeric array straight into
// `vec4 x[8]` / `vec2` (WebGLUniforms flatten), and no three class is built at
// module load (play_effect_vfx.js pulls this module into suites that run on a
// minimal three stub).
export const TERRAIN_FX_LIGHT_UNIFORMS = {
  // per light: x, y, z (three world), range (m); range 0 = unused
  uFxLightPos: { value: new Float32Array(TERRAIN_FX_LIGHT_COUNT * 4) },
  // per light: r, g, b (colour x intensity), 0
  uFxLightCol: { value: new Float32Array(TERRAIN_FX_LIGHT_COUNT * 4) },
  // (gain, knee): contribution = albedo · gain · E / (1 + knee · E)
  uFxLightGain: { value: new Float32Array([0, TERRAIN_FX_LIGHT_KNEE]) },
};

/**
 * Terrain GLSL (fragment). `posW` is the three-world position (vWorldPos),
 * `nW` the three-world normal, `albedo` the unlit terrain colour. Returns the
 * light to ADD to the lit terrain colour. No backticks in here (template literal).
 */
export const TERRAIN_FX_LIGHT_GLSL = /* glsl */ `
// ==== tier-1 terrainLights (scene3d/vfx/fx_lights.js) ====
#define HB_FX_LIGHTS ${TERRAIN_FX_LIGHT_COUNT}
uniform vec4 uFxLightPos[HB_FX_LIGHTS];   // xyz three-world position, w range (m); w <= 0 unused
uniform vec4 uFxLightCol[HB_FX_LIGHTS];   // rgb colour x intensity (linear)
uniform vec2 uFxLightGain;                // (gain, knee)
vec3 hbTerrainFxLights(vec3 posW, vec3 nW, vec3 albedo) {
  if (uFxLightGain.x <= 0.0) return vec3(0.0);
  vec3 e = vec3(0.0);
  for (int i = 0; i < HB_FX_LIGHTS; i++) {
    vec4 lp = uFxLightPos[i];
    if (lp.w <= 0.0) continue;
    vec3 l = lp.xyz - posW;
    float d = length(l);
    if (d >= lp.w) continue;
    // retail light law (calc_point_light): linear falloff to the range, and
    // the statics' half-Lambert wrap (materials.js ?lightClamp)
    float att = 1.0 - d / lp.w;
    float wrap = dot(nW, l / max(d, 1e-4)) * 0.5 + 0.5;
    e += uFxLightCol[i].rgb * (att * wrap * wrap * 0.31830989);
  }
  return albedo * uFxLightGain.x * e / (1.0 + uFxLightGain.y * e);
}
// ==== end tier-1 terrainLights ====
`;

// ---------------------------------------------------------------------------
// Source carriers
// ---------------------------------------------------------------------------

const DECAY = 2.0;

/** A light-pool source carrier (duck type of lighting.js sources). */
export class FxLightSource {
  constructor(kind) {
    this.isFxLightSource = true;
    this.kind = kind;            // "flash" | "emitter"
    this.name = `fx-light-${kind}`;
    this.color = new THREE.Color(1, 1, 1);
    this.intensity = 0;
    this.distance = 6;
    this.decay = DECAY;
    this.parent = null;          // free-standing: never "detached" (lighting.js)
    this.userData = { __fxLight: true };
    this.position = new THREE.Vector3(0, -1e5, 0);
    this.baseIntensity = 0;
    this.suppressed = false;
    this.released = false;
    this.registered = false;     // inside the 48 m registration radius
    this._inActive = null;       // the activeLights array it was pushed into
    // flash envelope (ms) / modulation
    this._t0 = 0;
    this._attack = 0;
    this._hold = 0;
    this._decay = 1;
    this._flicker = 0;
    this._flickerHz = 0;
    this._pulse = 0;
    this._pulseHz = 1;
    this._seed = 0;
    // emitter binding
    this.emitter = null;
    /** @type {((out: THREE.Vector3) => boolean) | null} */
    this.resolvePosition = null;
    this._activity = 0;
    this._peak = 1;
  }
  getWorldPosition(target) { return target.copy(this.position); }
}

const _flashes = new Set();
const _emitterLights = new Set();
const _stats = { flashes: 0, flashesLive: 0, emitterLights: 0, registered: 0, suppressed: 0, ticks: 0 };

const FLASH_MAX = 10;
const REGISTER_RADIUS = 48;
const REGISTER_RADIUS_OUT = 56;
const DEDUPE_STATIC_M = 1.5;
const DEDUPE_FX_M = 1.2;
const DEDUPE_INTERVAL_MS = 500;

function _now() {
  return typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
}

function _setColor(c, color) {
  if (color == null) return;
  if (typeof color === "number") c.setHex(color);
  else if (Array.isArray(color)) c.setRGB(+color[0] || 0, +color[1] || 0, +color[2] || 0);
  else if (color.isColor) c.copy(color);
}

// Value noise matching particle_fx.js's flicker (smooth, seeded).
function _hash(p) {
  p = (p * 0.1031) % 1;
  if (p < 0) p += 1;
  p *= p + 33.33;
  p *= p + p;
  return p - Math.floor(p);
}
export function fxLightFlicker(tSec, hz, seed) {
  const n = tSec * hz + seed * 37.0;
  const i = Math.floor(n);
  const f = n - i;
  const s = f * f * (3 - 2 * f);
  return _hash(i) * (1 - s) + _hash(i + 1) * s; // [0, 1]
}

/**
 * Flash envelope at `t` ms after spawn: linear attack, hold, quadratic decay.
 * Pure. Returns 0 once the decay is over.
 */
export function fxFlashEnvelope(t, attackMs, holdMs, decayMs) {
  if (!(t >= 0)) return 0;
  if (t < attackMs) return attackMs > 0 ? t / attackMs : 1;
  const u = t - attackMs - holdMs;
  if (u <= 0) return 1;
  if (u >= decayMs) return 0;
  const x = 1 - u / decayMs;
  return x * x;
}

/**
 * Spawn a transient flash light (a spell landing, an impact, a level-up).
 * @param {{position:{x:number,y:number,z:number}, color?:number|number[]|THREE.Color,
 *   intensity?:number, range?:number, attackMs?:number, holdMs?:number, decayMs?:number,
 *   flicker?:number, flickerHz?:number}} o   position is THREE-WORLD space
 * @returns {FxLightSource|null}
 */
export function spawnFxFlash(o) {
  if (!fxTier1Enabled("fxLights") || !o || !o.position) return null;
  const p = o.position;
  if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) return null;
  // Cap concurrent flashes: drop the oldest (its envelope is the furthest gone).
  if (_flashes.size >= FLASH_MAX) {
    let oldest = null;
    for (const f of _flashes) if (!oldest || f._t0 < oldest._t0) oldest = f;
    if (oldest) _release(oldest);
  }
  const s = new FxLightSource("flash");
  s.position.set(p.x, p.y, p.z);
  _setColor(s.color, o.color ?? 0xffffff);
  s.baseIntensity = Math.max(0, Math.min(100, Number.isFinite(o.intensity) ? o.intensity : 30));
  s.distance = Math.max(0.5, Math.min(14, Number.isFinite(o.range) ? o.range : 6));
  s.userData.__dynamicPriority = true;
  s._t0 = _now();
  s._attack = Math.max(0, o.attackMs ?? 40);
  s._hold = Math.max(0, o.holdMs ?? 60);
  s._decay = Math.max(1, o.decayMs ?? 450);
  s._flicker = Math.max(0, Math.min(1, o.flicker ?? 0));
  s._flickerHz = Math.max(0, o.flickerHz ?? 0);
  s._seed = Math.random();
  s.intensity = 0;
  _flashes.add(s);
  _stats.flashes++;
  return s;
}

/**
 * Bind a persistent light to a particle emitter (particle_manager.js). The
 * caller passes a position resolver and the emitter, the light reads both
 * every tick. Returns the source (call `releaseFxLight` when the emitter dies).
 * @param {{emitter:object, resolvePosition:(out:THREE.Vector3)=>boolean,
 *   intensity:number, range:number, color:number[], flicker?:number, flickerHz?:number,
 *   pulse?:number, pulseHz?:number, transient?:boolean, outdoor?:boolean}} o
 */
export function bindEmitterFxLight(o) {
  if (!fxTier1Enabled("fxLights") || !o || !o.emitter || typeof o.resolvePosition !== "function") return null;
  if (!(o.intensity > 0) || !(o.range > 0)) return null;
  const s = new FxLightSource("emitter");
  s.emitter = o.emitter;
  s.resolvePosition = o.resolvePosition;
  _setColor(s.color, o.color ?? [1, 1, 1]);
  s.baseIntensity = Math.min(100, o.intensity);
  s.distance = Math.min(14, o.range);
  s._flicker = Math.max(0, Math.min(0.6, (o.flicker ?? 0) * 0.6));
  s._flickerHz = Math.max(0.5, o.flickerHz ?? 6);
  s._pulse = Math.max(0, Math.min(0.5, o.pulse ?? 0));
  s._pulseHz = Math.max(0.05, o.pulseHz ?? 1);
  s._seed = Math.random();
  s._activity = 0;
  s._peak = 1;
  if (o.transient) s.userData.__dynamicPriority = true;
  // An OUTDOOR static chain's light carries a (non-null) `__lbKey` like the
  // setup lamps it sits beside, so the pool's cell scoping drops it while the
  // player is in a sealed dungeon (lighting.js selectCellScopedSources) — a
  // surface brazier must not light the crypt below. Entity / interior emitters
  // stay dynamic (always candidates), as entity Setup lights are.
  if (o.outdoor) s.userData.__lbKey = 0;
  _emitterLights.add(s);
  _stats.emitterLights++;
  return s;
}

function _release(s) {
  if (!s) return;
  s.released = true;
  s.intensity = 0;
  _flashes.delete(s);
  _emitterLights.delete(s);
}

/** Stop a light (emitter destroyed / finished). Removal from activeLights happens on the next tick. */
export function releaseFxLight(s) {
  if (!s || s.released) return;
  _release(s);
  _pendingRemoval.add(s);
}
const _pendingRemoval = new Set();

// ---------------------------------------------------------------------------
// Per-frame tick
// ---------------------------------------------------------------------------

let _lastDedupe = -Infinity;
const _tmp = new THREE.Vector3();
let _staticPos = new Float32Array(0);

function _refPos(scene3d) {
  const r = scene3d?._lightRefPos;
  if (r && Number.isFinite(r.x)) return r;
  const cam = scene3d?.cameraSwitcher?.activeCamera ?? scene3d?.camera ?? null;
  return cam?.position ?? null;
}

function _removeFromActive(s) {
  const arr = s._inActive;
  s._inActive = null;
  if (!arr) return;
  const i = arr.indexOf(s);
  if (i !== -1) arr.splice(i, 1);
}

function _dedupeAndRegister(scene3d, ref) {
  // Positions of every NON-FX source once (THREE lights: matrixWorld based).
  const lights = Array.isArray(scene3d?.activeLights) ? scene3d.activeLights : [];
  let n = 0;
  if (_staticPos.length < lights.length * 3) _staticPos = new Float32Array(Math.max(64, lights.length * 3 * 2));
  for (let i = 0; i < lights.length; i++) {
    const l = lights[i];
    if (!l || l.isFxLightSource || l.isViewerLightSource) continue;
    try {
      if (typeof l.getWorldPosition === "function") l.getWorldPosition(_tmp);
      else continue;
    } catch (_) { continue; }
    if (!Number.isFinite(_tmp.x)) continue;
    if (ref) {
      const dx = _tmp.x - ref.x, dy = _tmp.y - ref.y, dz = _tmp.z - ref.z;
      if (dx * dx + dy * dy + dz * dz > (REGISTER_RADIUS_OUT + 4) * (REGISTER_RADIUS_OUT + 4)) continue;
    }
    _staticPos[n * 3] = _tmp.x; _staticPos[n * 3 + 1] = _tmp.y; _staticPos[n * 3 + 2] = _tmp.z;
    n++;
  }
  const sorted = [..._emitterLights].sort((a, b) => b.baseIntensity - a.baseIntensity);
  const kept = [];
  const st2 = DEDUPE_STATIC_M * DEDUPE_STATIC_M;
  const fx2 = DEDUPE_FX_M * DEDUPE_FX_M;
  let suppressed = 0;
  for (const s of sorted) {
    if (!s.resolvePosition(s.position)) { s.suppressed = true; s.registered = false; continue; }
    let sup = false;
    for (let i = 0; i < n && !sup; i++) {
      const dx = _staticPos[i * 3] - s.position.x, dy = _staticPos[i * 3 + 1] - s.position.y, dz = _staticPos[i * 3 + 2] - s.position.z;
      if (dx * dx + dy * dy + dz * dz < st2) sup = true;
    }
    for (let i = 0; i < kept.length && !sup; i++) {
      if (kept[i].position.distanceToSquared(s.position) < fx2) sup = true;
    }
    s.suppressed = sup;
    if (sup) suppressed++;
    else kept.push(s);
    // registration radius (with hysteresis)
    if (ref) {
      const d2 = s.position.distanceToSquared(ref);
      const lim = s.registered ? REGISTER_RADIUS_OUT : REGISTER_RADIUS;
      s.registered = !sup && d2 < lim * lim;
    } else {
      s.registered = !sup;
    }
  }
  _stats.suppressed = suppressed;
}

/**
 * Per-frame: envelopes + flicker, dedupe (2 Hz), and the `activeLights`
 * membership sync. Call BEFORE tickLightingForCellState (loop.js) so the pool
 * sees this frame's sources.
 */
export function tickFxLights(scene3d, nowMs) {
  const now = Number.isFinite(nowMs) ? nowMs : _now();
  const tSec = (now / 1000) % 4096;
  const arr = Array.isArray(scene3d?.activeLights) ? scene3d.activeLights : null;
  _stats.ticks++;
  for (const s of _pendingRemoval) _removeFromActive(s);
  _pendingRemoval.clear();
  if (!fxTier1Enabled("fxLights")) {
    for (const s of _flashes) { _removeFromActive(s); }
    for (const s of _emitterLights) { _removeFromActive(s); }
    _flashes.clear();
    return;
  }
  const ref = _refPos(scene3d);
  // flashes
  let live = 0;
  for (const s of [..._flashes]) {
    const t = now - s._t0;
    const env = fxFlashEnvelope(t, s._attack, s._hold, s._decay);
    if (env <= 0 && t > s._attack) { _release(s); _removeFromActive(s); continue; }
    let k = env;
    if (s._flicker > 0 && s._flickerHz > 0) k *= 1 - s._flicker + 2 * s._flicker * fxLightFlicker(tSec, s._flickerHz, s._seed);
    s.intensity = s.baseIntensity * k;
    live++;
    if (arr && s._inActive !== arr) { _removeFromActive(s); arr.push(s); s._inActive = arr; }
  }
  _stats.flashesLive = live;
  // emitter lights
  if (now - _lastDedupe >= DEDUPE_INTERVAL_MS) {
    _lastDedupe = now;
    _dedupeAndRegister(scene3d, ref);
  }
  let reg = 0;
  for (const s of _emitterLights) {
    const e = s.emitter;
    if (!e || s.released) continue;
    const parts = e.numParticles | 0;
    // activity: 1 while particles live, eased; transient lights follow the
    // live count against its own peak so a burst fades with its particles
    if (parts > s._peak) s._peak = parts;
    const target = parts > 0 ? (s.userData.__dynamicPriority ? Math.min(1, parts / Math.max(1, s._peak)) : 1) : 0;
    s._activity += (target - s._activity) * 0.15;
    let k = s._activity;
    if (s._flicker > 0) k *= 1 - s._flicker + 2 * s._flicker * fxLightFlicker(tSec, s._flickerHz, s._seed);
    if (s._pulse > 0) k *= 1 + s._pulse * Math.sin(((tSec * s._pulseHz + s._seed) % 1) * Math.PI * 2);
    const want = s.registered && !s.suppressed && k > 0.002;
    if (want) {
      s.resolvePosition(s.position);
      s.intensity = s.baseIntensity * k;
      if (arr && s._inActive !== arr) { _removeFromActive(s); arr.push(s); s._inActive = arr; }
      reg++;
    } else {
      s.intensity = 0;
      if (s._inActive) _removeFromActive(s);
    }
  }
  _stats.registered = reg;
}

// ---------------------------------------------------------------------------
// Terrain feed
// ---------------------------------------------------------------------------

let _gainScale = null;
function _terrainGainScale() {
  if (_gainScale === null) {
    _gainScale = 1;
    try {
      const v = parseFloat(new URLSearchParams(globalThis.location?.search || "").get("terrainLightGain"));
      if (Number.isFinite(v) && v >= 0) _gainScale = Math.min(4, v);
    } catch (_) { /* default */ }
  }
  return _gainScale;
}
/** Live tuning (`__fxLights.terrainGain = x`). */
export function setTerrainFxLightGainScale(v) { _gainScale = Number.isFinite(+v) && +v >= 0 ? Math.min(4, +v) : 1; }

/** Pure: the ground's response for a night fraction / indoor flag. */
export function terrainFxLightGainFor(night, indoor, scale = 1) {
  const n = indoor ? 1 : Math.min(1, Math.max(0, Number.isFinite(night) ? night : 0));
  return (TERRAIN_FX_LIGHT_DAY_GAIN + (TERRAIN_FX_LIGHT_NIGHT_GAIN - TERRAIN_FX_LIGHT_DAY_GAIN) * n) * scale;
}

const _cand = [];
const _feedStats = { lit: 0, candidates: 0, gain: 0 };

/**
 * Copy the nearest lit pool point slots into the terrain uniforms. Call after
 * the pool was fed this frame (loop.js, after tickLightingForCellState and the
 * flame flicker). `night` ∈ [0,1], `indoor` as the particle light uses.
 */
export function feedTerrainFxLights(scene3d, night = 0, indoor = false) {
  const U = TERRAIN_FX_LIGHT_UNIFORMS;
  const pos = U.uFxLightPos.value;
  const col = U.uFxLightCol.value;
  const pool = scene3d?.lighting?.lightPool;
  const on = fxTier1Enabled("terrainLights") && pool && pool.enabled && Array.isArray(pool.point);
  _cand.length = 0;
  if (on) {
    const cam = scene3d?.cameraSwitcher?.activeCamera ?? scene3d?.camera ?? null;
    const cp = cam?.position;
    for (let i = 0; i < pool.point.length; i++) {
      const pl = pool.point[i];
      const src = pool.selPoint ? pool.selPoint[i] : null;
      if (!pl || !(pl.intensity > 0) || !(pl.distance > 0)) continue;
      if (src && src.isViewerLightSource) continue; // the player lantern is an object light only
      const p = pl.position;
      if (!Number.isFinite(p.x) || p.y < -1e4) continue;
      const d = cp ? Math.sqrt((p.x - cp.x) ** 2 + (p.y - cp.y) ** 2 + (p.z - cp.z) ** 2) : 0;
      _cand.push({ pl, score: d - pl.distance });
    }
    _cand.sort((a, b) => a.score - b.score);
  }
  const n = Math.min(TERRAIN_FX_LIGHT_COUNT, _cand.length);
  for (let i = 0; i < TERRAIN_FX_LIGHT_COUNT; i++) {
    const o = i * 4;
    if (i < n) {
      const pl = _cand[i].pl;
      const I = pl.intensity;
      pos[o] = pl.position.x; pos[o + 1] = pl.position.y; pos[o + 2] = pl.position.z; pos[o + 3] = pl.distance;
      col[o] = pl.color.r * I; col[o + 1] = pl.color.g * I; col[o + 2] = pl.color.b * I; col[o + 3] = 0;
    } else {
      pos[o] = 0; pos[o + 1] = -1e5; pos[o + 2] = 0; pos[o + 3] = 0;
      col[o] = 0; col[o + 1] = 0; col[o + 2] = 0; col[o + 3] = 0;
    }
  }
  const gain = on ? terrainFxLightGainFor(night, indoor, _terrainGainScale()) : 0;
  U.uFxLightGain.value[0] = gain;
  U.uFxLightGain.value[1] = TERRAIN_FX_LIGHT_KNEE;
  _feedStats.lit = n;
  _feedStats.candidates = _cand.length;
  _feedStats.gain = gain;
  return n;
}

/** Diagnostics. */
export function fxLightsStats() {
  return {
    ..._stats,
    flashesNow: _flashes.size,
    emitterLightsNow: _emitterLights.size,
    terrain: { ..._feedStats },
  };
}

/** Test seam: drop every light. */
export function _resetFxLightsForTest() {
  for (const s of [..._flashes, ..._emitterLights]) _removeFromActive(s);
  _flashes.clear();
  _emitterLights.clear();
  _pendingRemoval.clear();
  _lastDedupe = -Infinity;
  for (const k of Object.keys(_stats)) _stats[k] = 0;
}

if (typeof window !== "undefined") {
  window.__fxLights = {
    stats: fxLightsStats,
    get terrainGain() { return _terrainGainScale(); },
    set terrainGain(v) { setTerrainFxLightGainScale(v); },
    get uniforms() { return TERRAIN_FX_LIGHT_UNIFORMS; },
  };
}
