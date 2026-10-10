// scene3d/vfx/fx_ribbons.js — tier 2 `?fxMotion` (2026-10-10): ribbon trails
// behind spell and missile projectiles, and elemental swing trails off flaming /
// frost / acid / lightning weapons.
//
// ONE shared dynamic BufferGeometry holds every live ribbon and draws in ONE
// call with an additive, noise-scrolled shader (one constant program):
//
//   bolt ribbons   a projectile (EntityManager `_isProjectile`) in ballistic
//                  flight leaves a camera-facing strip through its last ~0.22 s
//                  of world positions (≤ 16 points), width and alpha falling
//                  along the length, energy flowing back down it. Lightning
//                  ribbons jag: every point re-randomises its sideways offset
//                  every ~50 ms. On impact / NoDraw / despawn the ribbon stops
//                  growing and fades out over 0.25 s.
//   swing trails   while a wielder plays an attack motion (entities.js stamps
//                  `_fxSwingUntilMs` when an ATTACK command dispatches), each
//                  ELEMENTAL weapon it holds (a child entity whose name carries
//                  the element) sweeps a strip between a mid-blade point and its
//                  tip over the last ~0.16 s.
//
// COLOUR. The element decides it: the projectile's name (`objectName`), else the
// colour of its own Setup LightInfo light (PROJ-VIS attaches it through the light
// pool: retail's authored glow colour of the bolt), else a pale arcane violet.
// `fxProjectileElement(guid)` exposes the element for the impact cue (ground
// marks: scorch / frost / acid, vfx/fx_cues.js).
//
// No particles import (this module rides the boot chunk via loop.js): the
// display calibration is derived here from the renderer exposure, like the
// particle buckets' additive calibration (K / exposure, K 4 by day → 2 at night
// is approximated by a fixed K = 3).
//
// VFX invariant: reads entity positions + names + light colours and the clock,
// writes only its own render attributes; no light, one program, no per-frame
// allocation in the steady state.

import * as THREE from "three";
import { fxTier2Enabled } from "./fx_tier2.js";
import { registerLateFxSource } from "../particles_over_clouds.js";

export const FX_RIBBON_MAX = 32;
export const FX_RIBBON_POINTS = 16;
const VERTS_PER_RIBBON = FX_RIBBON_POINTS * 2;
const BOLT_AGE_S = 0.22;
const SWING_AGE_S = 0.16;
const FADE_S = 0.25;
const MIN_STEP_M = 0.05;
/** How long after an ATTACK command a wielder's elemental weapons trail (ms). */
export const FX_SWING_WINDOW_MS = 900;
const CAL_K = 3.0;

// ---------------------------------------------------------------------------
// Elements
// ---------------------------------------------------------------------------

/** Element looks (linear RGB, max channel 1; widths in metres; decal = ground mark kind). */
export const FX_ELEMENTS = Object.freeze({
  fire: Object.freeze({ color: [1.0, 0.48, 0.14], width: 0.30, alpha: 1.0, kind: 0, decal: "scorch" }),
  frost: Object.freeze({ color: [0.55, 0.85, 1.0], width: 0.28, alpha: 1.0, kind: 0, decal: "frost" }),
  acid: Object.freeze({ color: [0.5, 1.0, 0.22], width: 0.28, alpha: 1.0, kind: 0, decal: "acid" }),
  lightning: Object.freeze({ color: [0.72, 0.84, 1.0], width: 0.18, alpha: 1.0, kind: 2, decal: "scorch" }),
  nether: Object.freeze({ color: [0.62, 0.22, 0.95], width: 0.28, alpha: 0.9, kind: 0, decal: "scorch" }),
  force: Object.freeze({ color: [0.88, 0.9, 1.0], width: 0.22, alpha: 0.8, kind: 0, decal: null }),
  blade: Object.freeze({ color: [0.85, 0.9, 1.0], width: 0.24, alpha: 0.8, kind: 0, decal: null }),
  magic: Object.freeze({ color: [0.78, 0.62, 1.0], width: 0.24, alpha: 0.85, kind: 0, decal: null }),
  missile: Object.freeze({ color: [0.95, 0.92, 0.85], width: 0.05, alpha: 0.35, kind: 0, decal: null }),
});

// Order matters: an element word beats the missile words ("Fire Arrow" burns).
const ELEMENT_RULES = [
  ["lightning", /lightning|electric|\bshock|\bstatic\b|thunder|\bstorm|\barc\b|voltaic/i],
  ["fire", /\bfire|flam(e|ing)|blaz|\bburn|inferno|magma|\blava|incinerat|\bember|scorch|searing/i],
  ["frost", /frost|\bice\b|\bicy|\bcold\b|freez|blizzard|\bhail|glacial|\bchill|\bsnow/i],
  ["acid", /\bacid|corros|caustic|\bbile|venom|poison/i],
  ["nether", /nether|\bvoid|shadow|corrupt|\bdark\b/i],
  ["force", /\bforce\b|kinetic/i],
  ["blade", /whirling|\bblade/i],
  ["missile", /arrow|quarrel|\bbolt\b|\bdart|javelin|atlatl|shuriken|throwing|\bstone\b|\brock\b/i],
];

/** Pure: an element name from an object name, or null. */
export function fxElementFromName(name) {
  if (typeof name !== "string" || !name) return null;
  for (const [el, rx] of ELEMENT_RULES) if (rx.test(name)) return el;
  return null;
}

/** Pure: an element name from a light colour (r, g, b ≥ 0), or null when grey. */
export function fxElementFromColor(r, g, b) {
  const mx = Math.max(r, g, b);
  if (!(mx > 1e-4)) return null;
  const R = r / mx, G = g / mx, B = b / mx;
  if (Math.max(R, G, B) - Math.min(R, G, B) < 0.15) return null;
  if (R >= G && R >= B) return B > 0.6 && G < 0.55 ? "nether" : "fire";
  if (G >= R && G >= B) return B > 0.8 ? "frost" : "acid";
  return R > 0.55 && G < 0.6 ? "nether" : (G > 0.7 ? "frost" : "lightning");
}

function _nameOf(guid) {
  try {
    const sh = globalThis.window?.__sessionHandle;
    if (sh && typeof sh.objectName === "function") {
      const n = sh.objectName(guid >>> 0);
      return typeof n === "string" ? n : null;
    }
  } catch (_) { /* no name */ }
  return null;
}

function _lightColorOf(inst) {
  const ls = inst && inst._setupLights;
  if (!Array.isArray(ls)) return null;
  for (const l of ls) {
    const c = l && l.color;
    if (c && Number.isFinite(c.r) && Math.max(c.r, c.g, c.b) > 1e-4) return c;
  }
  return null;
}

/**
 * The element + colour of an entity (cached on the instance once a name or a
 * light colour has been seen; a bare guess is re-checked until then).
 */
export function fxEntityElement(inst) {
  if (!inst) return null;
  if (inst._fxElem && inst._fxElem.sure) return inst._fxElem;
  const name = _nameOf(inst.guid);
  let el = fxElementFromName(name);
  const lc = _lightColorOf(inst);
  if (!el && lc) el = fxElementFromColor(lc.r, lc.g, lc.b);
  const base = FX_ELEMENTS[el || "magic"];
  let color = base.color;
  if (lc && el !== "missile") {
    const m = Math.max(lc.r, lc.g, lc.b);
    color = [lc.r / m, lc.g / m, lc.b / m];
  }
  const rec = { element: el || "magic", color, width: base.width, alpha: base.alpha, kind: base.kind,
    decal: base.decal, sure: !!(name || lc) };
  inst._fxElem = rec;
  return rec;
}

// ---------------------------------------------------------------------------
// Ribbon state
// ---------------------------------------------------------------------------

class Ribbon {
  constructor() {
    this.pos = new Float32Array(FX_RIBBON_POINTS * 3);   // bolt centre / swing tip, newest first
    this.pos2 = new Float32Array(FX_RIBBON_POINTS * 3);  // swing mid-blade
    this.t = new Float64Array(FX_RIBBON_POINTS);
    this.n = 0;
    this.reset(null, null, "bolt", 0);
  }

  reset(key, look, mode, now) {
    this.key = key;
    this.mode = mode;               // "bolt" | "swing"
    this.color = look ? look.color : [1, 1, 1];
    this.width = look ? look.width : 0.2;
    this.alpha = look ? look.alpha : 1;
    this.kind = mode === "swing" ? 1 : (look ? look.kind : 0);
    this.n = 0;
    this.seenMs = now;
    this.dyingMs = -1;
    this.seed = Math.random();
  }

  push(x, y, z, x2, y2, z2, tSec) {
    if (this.n > 0) {
      const dx = x - this.pos[0], dy = y - this.pos[1], dz = z - this.pos[2];
      if (dx * dx + dy * dy + dz * dz < MIN_STEP_M * MIN_STEP_M) {
        // not moved enough for a new point: slide the head instead (and keep
        // it young — a slow bolt's head must not age out while it still flies)
        this.pos[0] = x; this.pos[1] = y; this.pos[2] = z;
        this.pos2[0] = x2; this.pos2[1] = y2; this.pos2[2] = z2;
        this.t[0] = tSec;
        return;
      }
    }
    const m = Math.min(this.n, FX_RIBBON_POINTS - 1);
    this.pos.copyWithin(3, 0, m * 3);
    this.pos2.copyWithin(3, 0, m * 3);
    this.t.copyWithin(1, 0, m);
    this.pos[0] = x; this.pos[1] = y; this.pos[2] = z;
    this.pos2[0] = x2; this.pos2[1] = y2; this.pos2[2] = z2;
    this.t[0] = tSec;
    this.n = m + 1;
  }

  /** Drop points older than the window; true while anything is left to draw. */
  age(tSec, maxAge) {
    while (this.n > 1 && tSec - this.t[this.n - 1] > maxAge) this.n--;
    if (this.dyingMs >= 0 && this.n === 1 && tSec - this.t[0] > maxAge) this.n = 0;
    return this.n > 1;
  }
}

const _ribbons = new Map();       // key → Ribbon
const _free = [];
const _stats = { bolts: 0, swings: 0, live: 0, drawn: 0, created: 0, retired: 0 };

function _acquire(key, look, mode, now) {
  let r = _ribbons.get(key);
  if (r) return r;
  if (_ribbons.size >= FX_RIBBON_MAX) return null;
  r = _free.pop() || new Ribbon();
  r.reset(key, look, mode, now);
  _ribbons.set(key, r);
  _stats.created++;
  return r;
}

function _retire(key, r) {
  _ribbons.delete(key);
  _free.push(r);
  _stats.retired++;
}

// ---------------------------------------------------------------------------
// The draw: one geometry, one program
// ---------------------------------------------------------------------------

const VERT = /* glsl */`
#include <common>
#include <logdepthbuf_pars_vertex>
attribute vec3 aTan;
attribute vec4 aInfo;   // u (0 head .. 1 tail), side (-1 / +1), width (m), alpha
attribute vec4 aCol;    // rgb, kind (0 facing strip, 1 swept swing, 2 lightning strip)
uniform float uRibTime;
varying vec2 vRib;
varying vec4 vRibCol;
varying float vRibKind;
float hbRibHash( float p ) {
	p = fract( p * 0.1031 );
	p *= p + 33.33;
	p *= p + p;
	return fract( p );
}
void main() {
	vec3 P = position;
	float kind = aCol.w;
	if ( kind < 0.5 || kind > 1.5 ) {
		// a camera-facing strip round the centre line
		vec3 toCam = normalize( cameraPosition - P );
		vec3 T = aTan;
		if ( dot( T, T ) < 1e-10 ) T = vec3( 0.0, 1.0, 0.0 );
		vec3 S = cross( normalize( T ), toCam );
		float sl = length( S );
		S = sl > 1e-5 ? S / sl : vec3( 1.0, 0.0, 0.0 );
		if ( kind > 1.5 ) {
			// lightning: each point jags sideways, re-randomised every ~50 ms
			float jst = floor( uRibTime * 20.0 );
			float j = hbRibHash( jst * 1.7 + floor( aInfo.x * 15.0 + 0.5 ) * 7.13 + aCol.r * 3.1 ) - 0.5;
			P += S * j * aInfo.z * 2.4 * step( 0.02, aInfo.x );
		}
		P += S * aInfo.y * aInfo.z * 0.5 * ( 1.0 - 0.6 * aInfo.x );
	}
	vRib = aInfo.xy;
	vRibCol = vec4( aCol.rgb, aInfo.w );
	vRibKind = kind;
	gl_Position = projectionMatrix * viewMatrix * vec4( P, 1.0 );
	#include <logdepthbuf_vertex>
}
`;

const FRAG = /* glsl */`
#include <common>
#include <logdepthbuf_pars_fragment>
uniform float uRibTime;
uniform float uRibCal;
varying vec2 vRib;
varying vec4 vRibCol;
varying float vRibKind;
float hbRibNoise( vec2 p ) {
	vec2 i = floor( p );
	vec2 f = fract( p );
	f = f * f * ( 3.0 - 2.0 * f );
	float a = fract( sin( dot( i, vec2( 127.1, 311.7 ) ) ) * 43758.5453 );
	float b = fract( sin( dot( i + vec2( 1.0, 0.0 ), vec2( 127.1, 311.7 ) ) ) * 43758.5453 );
	float c = fract( sin( dot( i + vec2( 0.0, 1.0 ), vec2( 127.1, 311.7 ) ) ) * 43758.5453 );
	float d = fract( sin( dot( i + vec2( 1.0, 1.0 ), vec2( 127.1, 311.7 ) ) ) * 43758.5453 );
	return mix( mix( a, b, f.x ), mix( c, d, f.x ), f.y );
}
void main() {
	#include <logdepthbuf_fragment>
	float u = clamp( vRib.x, 0.0, 1.0 );
	float across = vRib.y;
	float prof;
	float core;
	if ( vRibKind > 0.5 && vRibKind < 1.5 ) {
		// swept swing: brightest along the blade's edge (the tip side)
		float e = clamp( across * 0.5 + 0.5, 0.0, 1.0 );
		prof = e * e;
		core = pow( e, 8.0 );
	} else {
		prof = exp( -across * across * 3.5 );
		core = exp( -across * across * 26.0 );
	}
	float n = hbRibNoise( vec2( u * 7.0 - uRibTime * 6.0, across * 1.7 ) );
	float a = vRibCol.a * pow( 1.0 - u, 1.4 ) * ( 0.55 + 0.45 * n );
	vec3 c = vRibCol.rgb * ( prof * 0.8 + core * 1.1 ) + vec3( core * 0.5 );
	gl_FragColor = vec4( c * a * uRibCal, 1.0 );
}
`;

/** Shader sources (tests). */
export const FX_RIBBON_GLSL = Object.freeze({ vertex: VERT, fragment: FRAG });

let _mesh = null;
let _geom = null;
const _uniforms = { uRibTime: { value: 0 }, uRibCal: { value: 1 } };
let _gain = 1;   // `window.__fxRibbons.gain` (live tuning)

function _buildMesh() {
  const nv = FX_RIBBON_MAX * VERTS_PER_RIBBON;
  const g = new THREE.BufferGeometry();
  const mk = (n) => {
    const a = new THREE.BufferAttribute(new Float32Array(nv * n), n);
    a.setUsage(THREE.DynamicDrawUsage);
    return a;
  };
  g.setAttribute("position", mk(3));
  g.setAttribute("aTan", mk(3));
  g.setAttribute("aInfo", mk(4));
  g.setAttribute("aCol", mk(4));
  const idx = [];
  for (let r = 0; r < FX_RIBBON_MAX; r++) {
    const b = r * VERTS_PER_RIBBON;
    for (let i = 0; i < FX_RIBBON_POINTS - 1; i++) {
      const a0 = b + i * 2, a1 = a0 + 1, b0 = a0 + 2, b1 = a0 + 3;
      idx.push(a0, b0, a1, a1, b0, b1);
    }
  }
  g.setIndex(idx);
  g.setDrawRange(0, 0);
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
  const m = new THREE.ShaderMaterial({
    name: "fx-ribbons",
    uniforms: _uniforms,
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,
    fog: false,
  });
  m.userData = { __cacheOwned: true, __fxRibbons: true };
  const mesh = new THREE.Mesh(g, m);
  mesh.name = "fx-ribbons";
  mesh.frustumCulled = false;
  mesh.matrixAutoUpdate = false;
  mesh.renderOrder = 2;
  // entities' render layer (scene3d/index.js RENDER_LAYER_INDOOR = 1): drawn in
  // the indoor pass of a split frame, with the projectiles themselves
  mesh.layers.set(1);
  mesh.visible = false;
  mesh.userData = { isFxRibbons: true };
  _geom = g;
  _mesh = mesh;
  return mesh;
}

/** The shared ribbon mesh (built on first use; parented by the tick). */
export function fxRibbonMesh() { return _mesh || _buildMesh(); }

// Late particle pass: drawn after the cloud composite with the particles.
registerLateFxSource((out) => { if (_mesh && _mesh.visible && _mesh.parent) out.push(_mesh); });

// ---------------------------------------------------------------------------
// Sampling helpers
// ---------------------------------------------------------------------------

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _box = new THREE.Box3();
const _tmpBox = new THREE.Box3();

function _worldPos(obj, out) {
  try {
    obj.updateWorldMatrix(true, false);
    out.setFromMatrixPosition(obj.matrixWorld);
    return Number.isFinite(out.x) && Number.isFinite(out.y) && Number.isFinite(out.z);
  } catch (_) { return false; }
}

/**
 * A held weapon's blade in its root's local space: the long axis of its mesh
 * bounds, the tip at the end farthest from the grip (the root origin) and a
 * mid-blade point 35 % of the way out. Cached on the instance; null when the
 * rig has no geometry yet.
 */
export function fxBladeLocal(inst) {
  if (!inst || !inst.root) return null;
  if (inst._fxBlade !== undefined && inst._fxBlade !== null) return inst._fxBlade;
  const root = inst.root;
  try {
    root.updateWorldMatrix(true, true);
    _m.copy(root.matrixWorld).invert();
    _box.makeEmpty();
    root.traverse((o) => {
      const g = o.geometry;
      if (!o.isMesh || !g) return;
      if (!g.boundingBox) g.computeBoundingBox();
      if (!g.boundingBox) return;
      _tmpBox.copy(g.boundingBox).applyMatrix4(o.matrixWorld).applyMatrix4(_m);
      _box.union(_tmpBox);
    });
  } catch (_) { return null; }
  if (_box.isEmpty()) { inst._fxBlade = null; return null; }
  const sz = _box.getSize(_v);
  const ax = sz.x >= sz.y && sz.x >= sz.z ? "x" : (sz.y >= sz.z ? "y" : "z");
  const lo = _box.min[ax], hi = _box.max[ax];
  const far = Math.abs(hi) >= Math.abs(lo) ? hi : lo;
  const c = _box.getCenter(_v2);
  const tip = c.clone(); tip[ax] = far;
  const mid = c.clone(); mid[ax] = far * 0.35;
  if (!(Math.abs(far) > 0.15)) { inst._fxBlade = null; return null; }
  inst._fxBlade = { tip, mid };
  return inst._fxBlade;
}

// ---------------------------------------------------------------------------
// The tick
// ---------------------------------------------------------------------------

const _swingGuids = new Set();   // wielders mid-swing this frame (reused)
// Swing trails are ELEMENTAL: a plain sword leaves none.
const SWING_ELEMENTS = new Set(["fire", "frost", "acid", "lightning", "nether"]);
const _tipW = new THREE.Vector3();
const _midW = new THREE.Vector3();

function _calibration(scene3d) {
  try {
    const e = Number(scene3d?.renderer?.toneMappingExposure ?? globalThis.window?.liveScene3d?.renderer?.toneMappingExposure);
    if (Number.isFinite(e) && e > 1) return Math.min(1, CAL_K / Math.min(20, e));
  } catch (_) { /* fall through */ }
  return 1;
}

/**
 * Per frame (loop.js, after the particle managers): sample the projectiles and
 * the swinging elemental weapons, age the ribbons, rebuild the geometry.
 * @param {object} scene3d the live facade (entityManager, scene, renderer)
 * @param {number} [nowMs] test seam
 */
export function tickFxRibbons(scene3d, nowMs) {
  const now = Number.isFinite(nowMs) ? nowMs : (typeof performance !== "undefined" ? performance.now() : Date.now());
  const tSec = now / 1000;
  const on = fxTier2Enabled("fxMotion");
  if (!on) {
    if (_ribbons.size) { for (const [k, r] of _ribbons) _retire(k, r); }
    if (_mesh) { _mesh.visible = false; _geom.setDrawRange(0, 0); }
    return 0;
  }
  const em = scene3d?.entityManager;
  const map = em?.entityMap;
  _stats.bolts = 0;
  _stats.swings = 0;
  if (map && map.size) {
    // one walk for the projectiles and the wielders mid-swing; a second one,
    // only while someone swings, for the weapons they hold (no allocation)
    _swingGuids.clear();
    for (const inst of map.values()) {
      if (!inst || !inst.root) continue;
      if (inst._isProjectile === true) {
        _sampleBolt(inst, now, tSec);
        continue;
      }
      if (inst._fxSwingUntilMs > now) _swingGuids.add(inst.guid >>> 0);
    }
    if (_swingGuids.size) {
      for (const inst of map.values()) {
        if (inst && inst.root && inst._attachedParentGuid != null && _swingGuids.has(inst._attachedParentGuid >>> 0)) {
          _sampleSwing(inst, now, tSec);
        }
      }
    }
  }
  // age + retire: a ribbon whose entity stopped feeding it (impact, NoDraw,
  // despawn, the swing ended) fades out, and goes once faded or aged empty
  for (const [key, r] of _ribbons) {
    if (r.seenMs !== now && r.dyingMs < 0) r.dyingMs = now;
    const alive = r.age(tSec, r.mode === "swing" ? SWING_AGE_S : BOLT_AGE_S);
    if (r.dyingMs >= 0 && (!alive || now - r.dyingMs > FADE_S * 1000)) _retire(key, r);
  }
  return _rebuild(scene3d, now, tSec);
}

function _sampleBolt(inst, now, tSec) {
  const key = inst;
  let r = _ribbons.get(key);
  const flying = inst._ballistic === true && inst._stateVisible !== false && !inst._projectileImpacted;
  if (!r) {
    if (!flying) return;
    const look = fxEntityElement(inst);
    r = _acquire(key, look, "bolt", now);
    if (!r) return;
  } else if (r.mode === "bolt" && !(inst._fxElem && inst._fxElem.sure)) {
    // the light (or the name) can arrive after the spawn: refresh the look
    const look = fxEntityElement(inst);
    r.color = look.color; r.width = look.width; r.alpha = look.alpha; r.kind = look.kind;
  }
  r.seenMs = now;
  if (!flying) { if (r.dyingMs < 0) r.dyingMs = now; return; }
  if (!_worldPos(inst.root, _v)) return;
  r.push(_v.x, _v.y, _v.z, _v.x, _v.y, _v.z, tSec);
  _stats.bolts++;
}

function _sampleSwing(weapon, now, tSec) {
  const look = fxEntityElement(weapon);
  if (!look || !look.sure || !SWING_ELEMENTS.has(look.element)) return;
  const name = _nameOf(weapon.guid) || "";
  if (/shield|buckler|aegis/i.test(name)) return;
  const blade = fxBladeLocal(weapon);
  if (!blade) return;
  try {
    weapon.root.updateWorldMatrix(true, false);
    _tipW.copy(blade.tip).applyMatrix4(weapon.root.matrixWorld);
    _midW.copy(blade.mid).applyMatrix4(weapon.root.matrixWorld);
  } catch (_) { return; }
  if (!Number.isFinite(_tipW.x) || !Number.isFinite(_midW.x)) return;
  const key = weapon;
  let r = _ribbons.get(key);
  if (!r) {
    r = _acquire(key, look, "swing", now);
    if (!r) return;
  }
  r.seenMs = now;
  r.dyingMs = -1;
  r.push(_tipW.x, _tipW.y, _tipW.z, _midW.x, _midW.y, _midW.z, tSec);
  _stats.swings++;
}

function _rebuild(scene3d, now, tSec) {
  if (_ribbons.size === 0) {
    if (_mesh) { _mesh.visible = false; _geom.setDrawRange(0, 0); }
    _stats.live = 0;
    _stats.drawn = 0;
    return 0;
  }
  const mesh = fxRibbonMesh();
  const host = scene3d?.scene || globalThis.window?.liveScene3d?.scene || null;
  if (host && mesh.parent !== host) { try { host.add(mesh); } catch (_) { /* detached */ } }
  const g = _geom;
  const P = g.attributes.position.array, Tn = g.attributes.aTan.array;
  const I = g.attributes.aInfo.array, C = g.attributes.aCol.array;
  let slot = 0;
  for (const r of _ribbons.values()) {
    if (r.n < 2) continue;
    const maxAge = r.mode === "swing" ? SWING_AGE_S : BOLT_AGE_S;
    const fade = r.dyingMs >= 0 ? Math.max(0, 1 - (now - r.dyingMs) / (FADE_S * 1000)) : 1;
    const base = slot * VERTS_PER_RIBBON;
    for (let i = 0; i < FX_RIBBON_POINTS; i++) {
      const j = Math.min(i, r.n - 1);              // past the end: degenerate onto the last point
      const u = Math.min(1, Math.max(0, (tSec - r.t[j]) / maxAge));
      const px = r.pos[j * 3], py = r.pos[j * 3 + 1], pz = r.pos[j * 3 + 2];
      // tangent from the neighbours (head → tail direction)
      const a = Math.max(0, j - 1), b = Math.min(r.n - 1, j + 1);
      const tx = r.pos[a * 3] - r.pos[b * 3], ty = r.pos[a * 3 + 1] - r.pos[b * 3 + 1], tz = r.pos[a * 3 + 2] - r.pos[b * 3 + 2];
      const alpha = i < r.n ? r.alpha * fade : 0;
      for (let s = 0; s < 2; s++) {
        const v = base + i * 2 + s;
        const side = s === 0 ? -1 : 1;
        if (r.mode === "swing") {
          const q = s === 0 ? r.pos2 : r.pos;     // mid-blade edge / tip edge
          P[v * 3] = q[j * 3]; P[v * 3 + 1] = q[j * 3 + 1]; P[v * 3 + 2] = q[j * 3 + 2];
        } else {
          P[v * 3] = px; P[v * 3 + 1] = py; P[v * 3 + 2] = pz;
        }
        Tn[v * 3] = tx; Tn[v * 3 + 1] = ty; Tn[v * 3 + 2] = tz;
        I[v * 4] = u; I[v * 4 + 1] = side; I[v * 4 + 2] = r.width; I[v * 4 + 3] = alpha;
        C[v * 4] = r.color[0]; C[v * 4 + 1] = r.color[1]; C[v * 4 + 2] = r.color[2]; C[v * 4 + 3] = r.kind;
      }
    }
    slot++;
  }
  const nv = slot * VERTS_PER_RIBBON;
  for (const name of ["position", "aTan", "aInfo", "aCol"]) {
    const at = g.attributes[name];
    at.clearUpdateRanges();
    at.addUpdateRange(0, nv * at.itemSize);
    at.needsUpdate = true;
  }
  g.setDrawRange(0, slot * (FX_RIBBON_POINTS - 1) * 6);
  mesh.visible = slot > 0;
  _uniforms.uRibTime.value = tSec % 1024;
  _uniforms.uRibCal.value = _calibration(scene3d) * _gain;
  _stats.live = _ribbons.size;
  _stats.drawn = slot;
  return slot;
}

/**
 * entities.js `setMotion`: an ATTACK command just dispatched for `inst` — its
 * held elemental weapons trail for the next FX_SWING_WINDOW_MS. Never throws.
 */
export function fxNoteSwing(inst, nowMs) {
  try {
    if (!inst) return;
    const now = Number.isFinite(nowMs) ? nowMs : (typeof performance !== "undefined" ? performance.now() : Date.now());
    inst._fxSwingUntilMs = now + FX_SWING_WINDOW_MS;
  } catch (_) { /* a trail never breaks a swing */ }
}

/** The element of a live (or just-impacted) projectile, for the impact cue. */
export function fxProjectileElement(guid) {
  try {
    const inst = globalThis.window?.liveScene3d?.entityManager?.entityMap?.get(guid >>> 0);
    if (inst && inst._isProjectile) return fxEntityElement(inst);
  } catch (_) { /* unknown */ }
  return null;
}

/** Diagnostics (`window.__fxRibbons`). */
export function fxRibbonStats() {
  return { ..._stats, live: _ribbons.size };
}

/** Test seam. */
export function _resetFxRibbonsForTest() {
  for (const [k, r] of _ribbons) _retire(k, r);
  for (const k of Object.keys(_stats)) _stats[k] = 0;
  if (_mesh) { _mesh.visible = false; _geom.setDrawRange(0, 0); }
}

if (typeof window !== "undefined") {
  window.__fxRibbons = {
    stats: fxRibbonStats,
    elementOf: (guid) => fxProjectileElement(guid),
    get gain() { return _gain; },
    set gain(v) { if (Number.isFinite(+v)) _gain = Math.max(0, +v); },
  };
}
