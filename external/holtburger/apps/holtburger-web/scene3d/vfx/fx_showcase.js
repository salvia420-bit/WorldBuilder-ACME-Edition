// scene3d/vfx/fx_showcase.js — tier 2 `?fxShowcase` (2026-10-10): the set
// pieces, each assembled from the tier-1 and tier-2 parts.
//
//   PORTAL     (every object with ObjectDescriptionFlags PORTAL within 60 m)
//              shipped: the swirl distortion, the inflow motes, the light pool,
//              the glow; tier 2: the analytic rim (`?fxShapes` turns the retail
//              rim layers into crisp swirling rings), a ground light ring
//              (`?fxDecals`) and here a faint "portal-space" disc — a swirling
//              nebula with a few stars on a camera-facing disc at the swirl's
//              centre, in the portal's own colour.
//   LIFESTONE  (LIFESTONE flag) shipped: its breathing light and glow; here: a
//              vertical light shaft (an additive column facing the camera round
//              the vertical, its noise mask scrolling up, glitter rising in it)
//              and a ground ring.
//   LEVEL-UP   (the levelUp PlayEffect cue) shipped: the flash, the ring, the
//              glitter; here: a column of light rising out of the player and a
//              short lens flare on the core — drawn into the glow buffer when
//              `?fxGlow` is on (the cheap route, soft and occluded there), in the
//              scene otherwise.
//   WAR-SPELL  shipped: the flash light, the shockwave, the sparks; tier 2: the
//   IMPACT     sparks stretch (`?fxMotion`) and bounce off the ground (the GPU
//              spark children, particle_fx_kids.js HB_FX_BOUNCE), and the impact
//              leaves its element's scorch / rime / stain (vfx/fx_cues.js) —
//              nothing to add here.
//
// The portal's centre and size come from its swirl distortion source
// (vfx/fx_distort.js — the retail swirl emitter's own origin), its colour from
// the swirl's FX light (vfx/fx_lights.js); without them (tier-1 switches off)
// a 1.6 m-high centre, a 1.5 m radius and portal violet.
//
// ONE draw for every disc, shaft, column and flare (an instanced billboard, the
// kind is per instance), one program, plus the flare's glow variant. No light.

import * as THREE from "three";
import { fxTier2Enabled } from "./fx_tier2.js";
import { fxTier1Enabled } from "./fx_tier1.js";
import { addFxDecal, releaseFxDecal } from "./fx_decals.js";
import { fxDistortSwirlNear } from "./fx_distort.js";
import { fxEmitterLightNear } from "./fx_lights.js";
import { registerLateFxSource, registerFxGlowExtras } from "../particles_over_clouds.js";

export const ODF_LIFESTONE = 0x00004000;
export const ODF_PORTAL = 0x00040000;
export const FX_SHOWCASE_MAX = 16;
export const FX_SHOWCASE_KIND = Object.freeze({ disc: 1, shaft: 2, flare: 3 });
const SCAN_MS = 500;
const RANGE_M = 60;

const PORTAL_VIOLET = [0.75, 0.5, 1.0];
const LIFESTONE_BLUE = [0.55, 0.78, 1.0];
const LEVELUP_GOLD = [1.0, 0.86, 0.48];

// ---------------------------------------------------------------------------
// Shader (one program; the glow variant draws only the flares)
// ---------------------------------------------------------------------------

const VERT = /* glsl */`
#include <common>
#include <logdepthbuf_pars_vertex>
attribute vec4 aS0;   // centre (THREE world), kind
attribute vec4 aS1;   // radius / width, height, fade, seed
attribute vec4 aS2;   // colour rgb, intensity
attribute vec4 aS3;   // age (s), grow (0..1), 0, 0
uniform float uShowFlareInScene;
varying vec2 vUv;
varying vec4 vCol;
varying vec4 vInfo;    // kind, seed, age, fade
varying float vDepth;
void main() {
	vec3 C = aS0.xyz;
	float kind = aS0.w;
	vInfo = vec4( kind, aS1.w, aS3.x, aS1.z );
	vCol = aS2;
	vec4 mv;
	#ifdef HB_SHOWCASE_GLOW
	bool keep = kind > 2.5;
	#else
	bool keep = kind < 2.5 || uShowFlareInScene > 0.5;
	#endif
	if ( !keep || aS1.z <= 0.0 ) {
		vUv = vec2( 0.0 ); vDepth = 0.0;
		gl_Position = vec4( 0.0, 0.0, 2.0, 1.0 );
		return;
	}
	if ( kind < 1.5 ) {
		// portal-space disc: camera-facing at the swirl centre
		mv = viewMatrix * vec4( C, 1.0 );
		mv.xy += position.xy * 2.0 * aS1.x;
		vUv = position.xy * 2.0;
	} else if ( kind < 2.5 ) {
		// light shaft / column: turns round the vertical to face the camera,
		// its base at C, its top growing in with aS3.y
		vec3 up = vec3( 0.0, 1.0, 0.0 );
		vec3 tc = cameraPosition - C;
		tc.y = 0.0;
		vec3 side = length( tc ) > 1e-4 ? normalize( cross( up, tc ) ) : vec3( 1.0, 0.0, 0.0 );
		float h = aS1.y * max( aS3.y, 0.02 );
		vec3 P = C + side * position.x * aS1.x + up * ( position.y + 0.5 ) * h;
		mv = viewMatrix * vec4( P, 1.0 );
		vUv = vec2( position.x * 2.0, position.y + 0.5 );
	} else {
		// lens flare: camera-facing, a constant size on screen, a wide quad for
		// the streak, pulled a little toward the camera
		mv = viewMatrix * vec4( C, 1.0 );
		float s = aS1.x * max( -mv.z, 0.5 ) * 0.1;
		mv.xy += position.xy * vec2( 6.0, 1.5 ) * s;
		mv.z += min( 0.6, -mv.z * 0.2 );
		vUv = position.xy * vec2( 6.0, 1.5 ) * 2.0;
	}
	vDepth = -mv.z;
	gl_Position = projectionMatrix * mv;
	#include <logdepthbuf_vertex>
}
`;

const FRAG = /* glsl */`
#include <common>
#include <logdepthbuf_pars_fragment>
uniform float uShowTime;
uniform float uShowCal;
varying vec2 vUv;
varying vec4 vCol;
varying vec4 vInfo;
varying float vDepth;
#ifdef HB_SHOWCASE_GLOW
uniform highp sampler2D uGlowDepth;
uniform vec2 uGlowRes;
uniform float uGlowLogFar;
uniform float uGlowIsLog;
uniform vec2 uGlowNearFar;
uniform float uGlowScale;
#endif
float hbShowHash( vec2 p ) {
	vec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
	p3 += dot( p3, p3.yzx + 33.33 );
	return fract( ( p3.x + p3.y ) * p3.z );
}
float hbShowNoise( vec2 p ) {
	vec2 i = floor( p );
	vec2 f = fract( p );
	f = f * f * ( 3.0 - 2.0 * f );
	return mix( mix( hbShowHash( i ), hbShowHash( i + vec2( 1.0, 0.0 ) ), f.x ),
		mix( hbShowHash( i + vec2( 0.0, 1.0 ) ), hbShowHash( i + vec2( 1.0, 1.0 ) ), f.x ), f.y );
}
float hbShowFbm( vec2 p ) {
	float s = 0.0;
	float a = 0.5;
	for ( int i = 0; i < 4; i++ ) { s += a * hbShowNoise( p ); p = p * 2.07 + 11.3; a *= 0.5; }
	return s / 0.9375;
}
void main() {
	#include <logdepthbuf_fragment>
	float kind = vInfo.x;
	float seed = vInfo.y;
	float t = uShowTime;
	vec3 c = vec3( 0.0 );
	if ( kind < 1.5 ) {
		// portal space: a slow swirling nebula in the portal's colour, a few stars
		float r = length( vUv );
		if ( r > 1.0 ) discard;
		float th = r > 1e-4 ? atan( vUv.y, vUv.x ) : 0.0;
		float sw = th + r * 3.2 - t * 0.35 + seed * 6.2831853;
		vec2 pp = vec2( cos( sw ), sin( sw ) ) * r * 2.5;
		float n = hbShowFbm( pp + vec2( t * 0.05, -t * 0.03 ) );
		float mask = 1.0 - smoothstep( 0.55, 1.0, r );
		vec3 deep = vCol.rgb * 0.12 + vec3( 0.02, 0.0, 0.05 );
		c = mix( deep, vCol.rgb, smoothstep( 0.35, 0.85, n ) ) * mask * 0.55;
		vec2 cell = floor( pp * 6.0 + 50.0 );
		float st = step( 0.965, hbShowHash( cell + seed * 17.0 ) );
		c += vec3( st * pow( 0.5 + 0.5 * sin( t * 3.0 + hbShowHash( cell ) * 30.0 ), 6.0 ) ) * mask;
	} else if ( kind < 2.5 ) {
		// light shaft: a soft core, a noise mask scrolling up, glitter rising
		float u = vUv.x;
		float v = vUv.y;
		float prof = exp( -u * u * 3.5 ) * smoothstep( 0.0, 0.06, v ) * ( 1.0 - smoothstep( 0.55, 1.0, v ) );
		float n = hbShowNoise( vec2( u * 2.5 + seed * 7.0, v * 7.0 - t * 1.1 ) );
		vec2 cell = floor( vec2( u * 7.0, v * 34.0 - t * 2.2 ) + seed * 23.0 );
		float gl = step( 0.93, hbShowHash( cell ) ) * pow( 0.5 + 0.5 * sin( t * 6.0 + hbShowHash( cell + 3.0 ) * 40.0 ), 4.0 );
		c = vCol.rgb * ( prof * ( 0.45 + 0.55 * n ) + gl * prof * 2.5 );
	} else {
		// lens flare: a hot core, an anamorphic streak, a faint ghost ring
		vec2 q = vUv;
		float core = exp( -dot( q, q ) * 6.0 );
		float streak = exp( -abs( q.y ) * 10.0 ) * max( 1.0 - abs( q.x ) / 12.0, 0.0 );
		float ring = exp( -pow( ( length( q ) - 1.6 ) / 0.12, 2.0 ) ) * 0.25;
		c = vCol.rgb * ( core * 2.0 + streak * 0.9 + ring ) + vec3( core * 0.6 );
	}
	c *= vCol.a * vInfo.w;
	#ifdef HB_SHOWCASE_GLOW
	float gd = texture2D( uGlowDepth, gl_FragCoord.xy / uGlowRes ).x;
	float gw;
	if ( gd >= 0.999999 ) gw = 1e7;
	else if ( uGlowIsLog > 0.5 ) gw = exp2( gd * uGlowLogFar ) - 1.0;
	else {
		float z = gd * 2.0 - 1.0;
		gw = ( 2.0 * uGlowNearFar.x * uGlowNearFar.y ) / ( uGlowNearFar.y + uGlowNearFar.x - z * ( uGlowNearFar.y - uGlowNearFar.x ) );
	}
	c *= clamp( 1.0 - ( vDepth - gw ) * 2.0, 0.0, 1.0 ) * uGlowScale;
	#endif
	if ( max( max( c.r, c.g ), c.b ) < 0.0008 ) discard;
	gl_FragColor = vec4( c * uShowCal, 1.0 );
}
`;

/** Shader sources (tests). */
export const FX_SHOWCASE_GLSL = Object.freeze({ vertex: VERT, fragment: FRAG });

const _uniforms = { uShowTime: { value: 0 }, uShowCal: { value: 1 }, uShowFlareInScene: { value: 1 } };
// Plain {x, y} vec2 values (three's uniform setter reads .x / .y): no
// THREE.Vector2 at module load — play_effect_vfx.js suites run this module on
// a minimal three stub.
const _glowFrame = {
  uGlowDepth: { value: null },
  uGlowRes: { value: { x: 1, y: 1 } },
  uGlowLogFar: { value: 1 },
  uGlowIsLog: { value: 1 },
  uGlowNearFar: { value: { x: 0.1, y: 1000 } },
  uGlowScale: { value: 1 },
};

let _mesh = null;
let _geom = null;
let _glowMat = null;

function _build() {
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]), 3));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  for (const n of ["aS0", "aS1", "aS2", "aS3"]) {
    const a = new THREE.InstancedBufferAttribute(new Float32Array(FX_SHOWCASE_MAX * 4), 4);
    a.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute(n, a);
  }
  g.instanceCount = 0;
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
  const m = new THREE.ShaderMaterial({
    name: "fx-showcase",
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
  m.userData = { __cacheOwned: true, __fxShowcase: true };
  _glowMat = new THREE.ShaderMaterial({
    name: "fx-showcase-glow",
    defines: { HB_SHOWCASE_GLOW: "" },
    uniforms: { ..._uniforms, ..._glowFrame },
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: false,
    side: THREE.DoubleSide,
    fog: false,
  });
  const mesh = new THREE.Mesh(g, m);
  mesh.name = "fx-showcase";
  mesh.frustumCulled = false;
  mesh.matrixAutoUpdate = false;
  mesh.renderOrder = 2;
  mesh.layers.set(1);   // with the entities (scene3d/index.js RENDER_LAYER_INDOOR)
  mesh.visible = false;
  mesh.userData = { isFxShowcase: true };
  _geom = g;
  _mesh = mesh;
  return mesh;
}

// Late particle pass: with the particles, after the cloud composite.
registerLateFxSource((out) => { if (_mesh && _mesh.visible && _mesh.parent) out.push(_mesh); });
// The flares glow (`?fxGlow`): the glow pass draws only them, occluded.
registerFxGlowExtras({
  collect(out) { if (_mesh && _mesh.visible && _flares > 0 && _glowMat) out.push({ object: _mesh, material: _glowMat }); },
  setFrame({ depthTexture, width, height, camera, isLog, scale }) {
    _glowFrame.uGlowDepth.value = depthTexture || null;
    _glowFrame.uGlowRes.value.x = Math.max(1, width | 0);
    _glowFrame.uGlowRes.value.y = Math.max(1, height | 0);
    const far = Number.isFinite(camera?.far) && camera.far > 0 ? camera.far : 1000;
    const near = Number.isFinite(camera?.near) && camera.near > 0 ? camera.near : 0.1;
    _glowFrame.uGlowLogFar.value = Math.log2(far + 1);
    _glowFrame.uGlowIsLog.value = isLog === false ? 0 : 1;
    _glowFrame.uGlowNearFar.value.x = near;
    _glowFrame.uGlowNearFar.value.y = far;
    if (Number.isFinite(scale)) _glowFrame.uGlowScale.value = Math.max(0, scale);
  },
});

// ---------------------------------------------------------------------------
// The set pieces
// ---------------------------------------------------------------------------

/** inst → { kind: "portal"|"lifestone", ring decal handle, centre, radius, colour, seed } */
const _pieces = new Map();
/** transient level-up columns + flares: { t0, pos, color } */
const _bursts = [];
let _flares = 0;
let _lastScan = -Infinity;
let _gain = 1;   // `window.__fxShowcase.gain` (live tuning)
const _stats = { portals: 0, lifestones: 0, bursts: 0, drawn: 0, scans: 0 };

const _cam = new THREE.Vector3();
const _root = new THREE.Vector3();
const _swirl = {};

function _odfOf(inst) {
  let odf = (inst?.meta?.objDescFlags >>> 0) || 0;
  if (!odf) {
    try {
      const sh = globalThis.window?.__sessionHandle;
      if (sh && typeof sh.objectDescFlags === "function") odf = (sh.objectDescFlags(inst.guid >>> 0) >>> 0) || 0;
    } catch (_) { odf = 0; }
  }
  return odf;
}

function _colorOf(src, fallback) {
  const c = src && src.color;
  if (c && Number.isFinite(c.r)) {
    const m = Math.max(c.r, c.g, c.b);
    if (m > 1e-4) return [c.r / m, c.g / m, c.b / m];
  }
  return fallback.slice();
}

function _scan(em, now) {
  _stats.scans++;
  const seen = new Set();
  const map = em?.entityMap;
  if (map) {
    for (const inst of map.values()) {
      if (!inst || !inst.root || inst._disposed) continue;
      const odf = _odfOf(inst);
      const kind = (odf & ODF_PORTAL) ? "portal" : ((odf & ODF_LIFESTONE) ? "lifestone" : null);
      if (!kind) continue;
      try { inst.root.updateWorldMatrix(true, false); _root.setFromMatrixPosition(inst.root.matrixWorld); } catch (_) { continue; }
      if (_root.distanceTo(_cam) > RANGE_M) continue;
      seen.add(inst);
      let p = _pieces.get(inst);
      if (!p) {
        if (_pieces.size >= 8) continue;
        p = { kind, ring: null, centre: new THREE.Vector3(), ground: new THREE.Vector3(), radius: kind === "portal" ? 1.5 : 0.7,
          color: (kind === "portal" ? PORTAL_VIOLET : LIFESTONE_BLUE).slice(), seed: Math.random(), t0: now };
        _pieces.set(inst, p);
      }
      p.ground.copy(_root);
      if (kind === "portal") {
        const sw = fxDistortSwirlNear(_root, 6, _swirl);
        if (sw) {
          p.centre.set(sw.x, sw.y, sw.z);
          p.radius = Math.min(3.5, Math.max(0.8, sw.radius * 0.95));
          const light = sw.emitter && sw.emitter._fxLight ? sw.emitter._fxLight : fxEmitterLightNear(p.centre, 3);
          if (light) p.color = _colorOf(light, PORTAL_VIOLET);
        } else {
          p.centre.copy(_root); p.centre.y += 1.6;
          const light = fxEmitterLightNear(p.centre, 3);
          if (light) p.color = _colorOf(light, PORTAL_VIOLET);
        }
      } else {
        p.centre.copy(_root);
        const light = fxEmitterLightNear(_root.clone().setY(_root.y + 1.5), 3);
        if (light) p.color = _colorOf(light, LIFESTONE_BLUE);
      }
      // the ground ring (a persistent mark): re-placed when it moved, recoloured
      const ringR = kind === "portal" ? p.radius * 1.05 : 1.6;
      if (!p.ring || p.ring.released || Math.hypot(p.ring.x - p.ground.x, p.ring.z - p.ground.z) > 0.3) {
        if (p.ring) releaseFxDecal(p.ring);
        p.ring = addFxDecal({ position: p.ground, kind: "ring", radius: ringR, height: 1.6, color: p.color,
          intensity: kind === "portal" ? 0.9 : 0.75 });
      } else {
        p.ring.color[0] = p.color[0]; p.ring.color[1] = p.color[1]; p.ring.color[2] = p.color[2];
        p.ring.radius = ringR;
      }
    }
  }
  for (const [inst, p] of _pieces) {
    if (!seen.has(inst)) {
      if (p.ring) releaseFxDecal(p.ring);
      _pieces.delete(inst);
    }
  }
}

/** Pure: a level-up column's (envelope, growth) at `ageSec`. */
export function fxColumnEnvelope(ageSec) {
  if (!(ageSec >= 0)) return [0, 0];
  const grow = Math.min(1, ageSec / 0.45);
  let env;
  if (ageSec < 0.25) env = ageSec / 0.25;
  else if (ageSec < 1.45) env = 1;
  else env = Math.max(0, 1 - (ageSec - 1.45) / 1.5);
  return [env, 1 - (1 - grow) * (1 - grow)];
}

/**
 * A showcase cue (play_effect_vfx.js, with the tier-1 cue): `levelUp` raises a
 * light column and flashes a lens flare at the target. THREE-world root.
 * Returns true when something was spawned.
 */
export function fireFxShowcaseCue(look, rootWorld, nowMs) {
  if (look !== "levelUp" || !rootWorld || !fxTier2Enabled("fxShowcase")) return false;
  if (!Number.isFinite(rootWorld.x) || !Number.isFinite(rootWorld.y) || !Number.isFinite(rootWorld.z)) return false;
  const now = Number.isFinite(nowMs) ? nowMs : (typeof performance !== "undefined" ? performance.now() : Date.now());
  while (_bursts.length >= 4) _bursts.shift();
  _bursts.push({ t0: now, pos: new THREE.Vector3(rootWorld.x, rootWorld.y, rootWorld.z), color: LEVELUP_GOLD.slice(), seed: Math.random() });
  return true;
}

/**
 * Per frame (loop.js): rescan the portals / lifestones twice a second, then
 * write every live piece into the instanced billboard.
 */
export function tickFxShowcase(scene3d, nowMs) {
  const now = Number.isFinite(nowMs) ? nowMs : (typeof performance !== "undefined" ? performance.now() : Date.now());
  const on = fxTier2Enabled("fxShowcase");
  if (!on) {
    if (_pieces.size) { for (const p of _pieces.values()) if (p.ring) releaseFxDecal(p.ring); _pieces.clear(); }
    _bursts.length = 0;
    if (_mesh) _mesh.visible = false;
    return 0;
  }
  const cam = scene3d?.cameraSwitcher?.activeCamera || scene3d?.camera || null;
  if (cam) { try { cam.getWorldPosition(_cam); } catch (_) { /* keep the last */ } }
  if (now - _lastScan >= SCAN_MS || now < _lastScan) {
    _lastScan = now;
    _scan(scene3d?.entityManager, now);
  }
  for (let i = _bursts.length - 1; i >= 0; i--) if (now - _bursts[i].t0 > 3200) _bursts.splice(i, 1);
  _stats.portals = 0;
  _stats.lifestones = 0;
  _stats.bursts = _bursts.length;
  if (_pieces.size === 0 && _bursts.length === 0) {
    if (_mesh) _mesh.visible = false;
    _stats.drawn = 0;
    _flares = 0;
    return 0;
  }
  const mesh = _mesh || _build();
  const host = scene3d?.scene || globalThis.window?.liveScene3d?.scene || null;
  if (host && mesh.parent !== host) { try { host.add(mesh); } catch (_) { /* detached */ } }
  const A0 = _geom.attributes.aS0.array, A1 = _geom.attributes.aS1.array, A2 = _geom.attributes.aS2.array, A3 = _geom.attributes.aS3.array;
  let n = 0;
  const put = (x, y, z, kind, r, h, fade, seed, col, inten, age, grow) => {
    if (n >= FX_SHOWCASE_MAX) return;
    const o = n * 4;
    A0[o] = x; A0[o + 1] = y; A0[o + 2] = z; A0[o + 3] = kind;
    A1[o] = r; A1[o + 1] = h; A1[o + 2] = fade; A1[o + 3] = seed;
    A2[o] = col[0]; A2[o + 1] = col[1]; A2[o + 2] = col[2]; A2[o + 3] = inten;
    A3[o] = age; A3[o + 1] = grow; A3[o + 2] = 0; A3[o + 3] = 0;
    n++;
  };
  for (const p of _pieces.values()) {
    const age = (now - p.t0) / 1000;
    const fadeIn = Math.min(1, age / 0.6);
    if (p.kind === "portal") {
      _stats.portals++;
      put(p.centre.x, p.centre.y, p.centre.z, FX_SHOWCASE_KIND.disc, p.radius * 0.85, 0, fadeIn, p.seed, p.color, 0.9, age, 1);
    } else {
      _stats.lifestones++;
      put(p.centre.x, p.centre.y, p.centre.z, FX_SHOWCASE_KIND.shaft, 1.1, 9.0, fadeIn, p.seed, p.color, 0.8, age, 1);
    }
  }
  let flares = 0;
  for (const b of _bursts) {
    const age = (now - b.t0) / 1000;
    const [env, grow] = fxColumnEnvelope(age);
    if (env <= 0) continue;
    put(b.pos.x, b.pos.y, b.pos.z, FX_SHOWCASE_KIND.shaft, 1.4, 10.0, env, b.seed, b.color, 1.4, age, grow);
    const fl = age < 1.2 ? Math.max(0, 1 - age / 1.2) : 0;
    if (fl > 0) {
      put(b.pos.x, b.pos.y + 1.2, b.pos.z, FX_SHOWCASE_KIND.flare, 0.6, 0, fl, b.seed, b.color, 1.6, age, 1);
      flares++;
    }
  }
  _flares = flares;
  for (const name of ["aS0", "aS1", "aS2", "aS3"]) {
    const a = _geom.attributes[name];
    a.clearUpdateRanges();
    a.addUpdateRange(0, n * 4);
    a.needsUpdate = true;
  }
  _geom.instanceCount = n;
  mesh.visible = n > 0;
  _uniforms.uShowTime.value = (now / 1000) % 1024;
  // the flare goes to the glow buffer when a glow pass is actually running
  // (`?fxGlow` on AND the composer built it: `window.__fxGlow`), else into the scene
  _uniforms.uShowFlareInScene.value = fxTier1Enabled("fxGlow") && globalThis.window?.__fxGlow?.effect ? 0 : 1;
  try {
    const e = Number(scene3d?.renderer?.toneMappingExposure);
    _uniforms.uShowCal.value = (Number.isFinite(e) && e > 1 ? Math.min(1, 3 / Math.min(20, e)) : 1) * _gain;
  } catch (_) { /* keep */ }
  _stats.drawn = n;
  return n;
}

/** Diagnostics (`window.__fxShowcase`). */
export function fxShowcaseStats() {
  return { ..._stats, pieces: _pieces.size, flares: _flares };
}

/** Test seam. */
export function _resetFxShowcaseForTest() {
  for (const p of _pieces.values()) if (p.ring) releaseFxDecal(p.ring);
  _pieces.clear();
  _bursts.length = 0;
  _flares = 0;
  _lastScan = -Infinity;
  if (_mesh) _mesh.visible = false;
}

if (typeof window !== "undefined") {
  window.__fxShowcase = {
    stats: fxShowcaseStats,
    get gain() { return _gain; },
    set gain(v) { if (Number.isFinite(+v)) _gain = Math.max(0, +v); },
  };
}
