// scene3d/vfx/fx_fields.js — tier 2 `?fxFields` (2026-10-10): ambient GPU
// fields wrapped around the camera.
//
// Seven fields, each ONE instanced draw whose instances are placed entirely in
// the vertex shader — `fract((seed + wind·t) / box) · box` re-centred on the
// camera, soft-faded at the box faces and next to the camera — so the CPU never
// touches a particle:
//
//   fireflies  warm blinking motes at night over grass, marsh and shore; they
//              also send light to the glow buffer (`?fxGlow`, a glow extra)
//   dust       slow motes in a dungeon, visible ONLY where a pool light reaches
//              them (the terrain FX light feed, vfx/fx_lights.js: the nearest 8
//              lit pool slots) — dust in the torchlight, darkness elsewhere
//   pollen     sunlit specks drifting on the wind over grassland by day
//   leaves     tumbling leaves falling through forest floor / moss
//   snow       a light flurry over snow and ice
//   ash        grey ash drifting down over volcanic ground
//   embers     glowing embers rising off volcanic ground (+ glow buffer)
//
// WHERE. Coverage comes from the terrain oracle (terrain_vfx.js): a 9 x 9
// sample grid round the camera counts the terrain codes under it (families,
// plus the forest codes for the leaves) and keeps the ground heights, so the
// ground-hugging fields (fireflies, pollen, leaves, embers) ride the terrain
// (`uHgt`, bilinear in the vertex stage). Night / day, indoors / outdoors and
// the wind (`?treeWindDir` / `?treeWindStrength`, the trees' and the grass's)
// do the rest. Density is a per-field uniform: instances past it collapse in
// the vertex stage, a field at zero is not drawn at all.
//
// GATE. A `scope: "camera"` terrain-VFX provider (terrain_vfx.js), so the
// spine's kill switches (`?terrainVfx=off`, `?wireframe=1`) cover it, and the
// `fxFields` switch rides the terrain-VFX ladder like grass (quality.js
// TERRAIN_VFX_PROMOTED.fields x TERRAIN_VFX_TIERS: high / ultra).
//
// One program for every field (the kind is a uniform) plus one glow variant.
// No light, no material patch, no per-instance program key. The additive
// fields draw in the late particle pass with the particles.

import * as THREE from "three";
import { registerTerrainVfx, wireframeActive } from "../terrain_vfx.js";
import { FAM_GRASS, FAM_SWAMP, FAM_SNOWICE, FAM_VOLCANO, FAM_WATER, TERRAIN_CODE_TO_FAMILY } from "../terrain_families.js";
import { fxTier2Enabled } from "./fx_tier2.js";
import { TERRAIN_FX_LIGHT_UNIFORMS } from "./fx_lights.js";
import { nightFactorFromAuthoredPitch } from "../night_ramp.js";
import { viewerIndoorOr } from "../viewer_cell.js";
import { treeWindDir, treeWindStrength } from "../tree_wind.js";
import { registerLateFxSource, registerFxGlowExtras } from "../particles_over_clouds.js";

/** Terrain codes that read as woodland floor (leaves): forestfloor, Moss, DarkMoss. */
export const FX_FOREST_CODES = Object.freeze([21, 28, 29]);
const GRID = 9;
const GRID_SPAN_M = 40;

/**
 * The fields. `box` is the camera-centred volume (AC metres: x, y, z); a
 * `ground` field lives in a `box.z`-tall band starting `base` m above the
 * terrain. `blend` 0 = additive light, 1 = alpha matter.
 */
export const FX_FIELDS = Object.freeze([
  Object.freeze({ id: "fireflies", kind: 1, count: 160, box: [36, 36, 2.8], ground: true, base: 0.35, blend: 0, glow: true, layer: 0, size: 0.07, color: [1.0, 0.86, 0.36] }),
  Object.freeze({ id: "dust", kind: 2, count: 240, box: [14, 14, 7], ground: false, base: 0, blend: 0, glow: false, layer: 1, size: 0.022, color: [1.0, 0.93, 0.8] }),
  Object.freeze({ id: "pollen", kind: 3, count: 140, box: [28, 28, 3.5], ground: true, base: 0.3, blend: 0, glow: false, layer: 0, size: 0.03, color: [1.0, 0.95, 0.72] }),
  Object.freeze({ id: "leaves", kind: 4, count: 70, box: [30, 30, 9], ground: true, base: 0.0, blend: 1, glow: false, layer: 0, size: 0.12, color: [0.5, 0.46, 0.2] }),
  Object.freeze({ id: "snow", kind: 5, count: 600, box: [30, 30, 16], ground: false, base: 0, blend: 1, glow: false, layer: 0, size: 0.04, color: [0.95, 0.97, 1.0] }),
  Object.freeze({ id: "ash", kind: 6, count: 260, box: [30, 30, 12], ground: false, base: 0, blend: 1, glow: false, layer: 0, size: 0.05, color: [0.34, 0.32, 0.31] }),
  Object.freeze({ id: "embers", kind: 7, count: 90, box: [24, 24, 6], ground: true, base: 0.2, blend: 0, glow: true, layer: 0, size: 0.035, color: [1.0, 0.45, 0.12] }),
]);

// ---------------------------------------------------------------------------
// Pure helpers (node-tested)
// ---------------------------------------------------------------------------

/**
 * Pure: per-field density (0..1) for one environment.
 * @param {{grass:number, swamp:number, water:number, forest:number, snow:number, volcano:number}} cov
 *   coverage fractions (0..1) of the sample grid
 * @param {number} night 0 day .. 1 night
 * @param {boolean} indoor
 */
export function fxFieldDensities(cov, night, indoor) {
  const c = (k) => Math.min(1, Math.max(0, +cov?.[k] || 0));
  const n = Math.min(1, Math.max(0, Number.isFinite(night) ? night : 0));
  const out = { fireflies: 0, dust: 0, pollen: 0, leaves: 0, snow: 0, ash: 0, embers: 0 };
  if (indoor) { out.dust = 1; return out; }
  const nightOn = Math.min(1, Math.max(0, (n - 0.5) / 0.3));
  const dayOn = 1 - Math.min(1, Math.max(0, (n - 0.2) / 0.4));
  out.fireflies = nightOn * Math.min(1, (c("grass") + 1.5 * c("swamp") + 0.6 * c("water")) * 1.4);
  out.pollen = dayOn * Math.min(1, c("grass") * 0.9);
  out.leaves = Math.min(1, c("forest") * 1.2 + c("grass") * 0.12);
  out.snow = Math.min(1, c("snow") * 1.1);
  out.ash = Math.min(1, c("volcano") * 1.2);
  out.embers = Math.min(1, c("volcano") * 1.2);
  return out;
}

/** Pure: coverage fractions from a list of terrain codes (−1 = unknown, skipped). */
export function fxFieldCoverage(codes) {
  const cov = { grass: 0, swamp: 0, water: 0, forest: 0, snow: 0, volcano: 0 };
  let n = 0;
  for (const code of codes) {
    if (!(code >= 0)) continue;
    n++;
    const f = TERRAIN_CODE_TO_FAMILY[code & 0x1f];
    if (f === FAM_GRASS) cov.grass++;
    else if (f === FAM_SWAMP) cov.swamp++;
    else if (f === FAM_WATER) cov.water++;
    else if (f === FAM_SNOWICE) cov.snow++;
    else if (f === FAM_VOLCANO) cov.volcano++;
    if (FX_FOREST_CODES.includes(code & 0x1f)) cov.forest++;
  }
  if (n > 0) for (const k of Object.keys(cov)) cov[k] /= n;
  return cov;
}

// ---------------------------------------------------------------------------
// The shader (one program for every field; the kind is a uniform)
// ---------------------------------------------------------------------------

const VERT = /* glsl */`
#include <common>
#include <logdepthbuf_pars_vertex>
attribute vec4 aSeed;      // x, y, z position seeds, w = phase / density rank
uniform vec3 uCam;         // camera, AC-local (the mesh sits at identity under worldRoot)
uniform vec3 uBox;
uniform vec3 uWind;        // drift, m/s, AC
uniform float uTime;
uniform float uKind;
uniform float uDensity;
uniform float uSize;
uniform float uGround;
uniform float uBase;
uniform float uHgt[ ${GRID * GRID} ];
uniform vec3 uHgtGrid;     // grid origin x, y and step (m)
uniform vec4 uFxLightPos[ 8 ];
uniform vec4 uFxLightCol[ 8 ];
uniform float uViewH;      // drawing-buffer height, px (the sub-pixel clamp)
varying vec2 vUv;
varying float vBright;
varying float vDepth;
varying float vKind;
float hbFieldHgt( vec2 xy ) {
	vec2 g = clamp( ( xy - uHgtGrid.xy ) / uHgtGrid.z, vec2( 0.0 ), vec2( ${GRID - 1}.0 - 1e-3 ) );
	ivec2 i = ivec2( floor( g ) );
	vec2 f = g - vec2( i );
	int i00 = i.y * ${GRID} + i.x;
	float h00 = uHgt[ i00 ];
	float h10 = uHgt[ i00 + 1 ];
	float h01 = uHgt[ i00 + ${GRID} ];
	float h11 = uHgt[ i00 + ${GRID} + 1 ];
	return mix( mix( h00, h10, f.x ), mix( h01, h11, f.x ), f.y );
}
void main() {
	vUv = position.xy * 2.0;
	vKind = uKind;
	if ( aSeed.w >= uDensity ) {
		vBright = 0.0; vDepth = 0.0;
		gl_Position = vec4( 0.0, 0.0, 2.0, 1.0 );
		return;
	}
	float t = uTime;
	float ph = aSeed.w * 81.7;
	vec3 p = aSeed.xyz * uBox;
	float sz = uSize;
	float br = 1.0;
	float ang = 0.0;
	if ( uKind < 1.5 ) {
		// fireflies: lazy wander, a warm blink
		p += uWind * t * 0.15 + vec3( sin( t * 0.35 + ph ) * 1.2, cos( t * 0.28 + ph * 1.3 ) * 1.2, sin( t * 0.6 + ph * 0.7 ) * 0.4 );
		float bl = sin( t * ( 0.7 + 0.5 * fract( ph ) ) + ph * 3.0 );
		br = smoothstep( 0.25, 0.95, bl );
	} else if ( uKind < 2.5 ) {
		// dust motes: a slow brownian drift
		p += vec3( sin( t * 0.13 + ph ), cos( t * 0.11 + ph * 1.7 ), sin( t * 0.07 + ph * 0.5 ) * 0.6 ) * 0.8 + uWind * t * 0.05;
	} else if ( uKind < 3.5 ) {
		// pollen: rides the wind, bobbing, glinting in the sun
		p += uWind * t + vec3( 0.0, 0.0, sin( t * 0.9 + ph ) * 0.25 );
		br = 0.55 + 0.45 * pow( max( sin( t * 2.1 + ph * 5.0 ), 0.0 ), 8.0 );
	} else if ( uKind < 4.5 ) {
		// leaves: fall, sway, tumble
		p += uWind * t * 0.8 + vec3( sin( t * 1.3 + ph ) * 0.6, cos( t * 1.1 + ph ) * 0.4, -t * ( 0.55 + 0.35 * fract( ph ) ) );
		ang = t * ( 1.5 + 2.0 * fract( ph * 1.7 ) ) + ph;
	} else if ( uKind < 5.5 ) {
		// snow: falls and flutters
		p += uWind * t * 0.6 + vec3( sin( t * 1.7 + ph ) * 0.25, cos( t * 1.3 + ph ) * 0.25, -t * ( 0.8 + 0.5 * fract( ph ) ) );
	} else if ( uKind < 6.5 ) {
		// ash: drifts down slowly
		p += uWind * t * 0.7 + vec3( sin( t * 0.5 + ph ) * 0.4, cos( t * 0.4 + ph ) * 0.4, -t * ( 0.3 + 0.2 * fract( ph ) ) );
		ang = t * 0.6 + ph;
	} else {
		// embers: rise, flicker, cool
		p += uWind * t * 0.5 + vec3( sin( t * 2.3 + ph ) * 0.3, cos( t * 1.9 + ph ) * 0.3, t * ( 0.8 + 0.7 * fract( ph ) ) );
		br = 0.6 + 0.4 * sin( t * 13.0 + ph * 7.0 );
	}
	// wrap round the camera
	vec3 o = uCam - uBox * 0.5;
	vec3 w = mod( p - o, uBox ) + o;
	float band = 1.0;
	if ( uGround > 0.5 ) {
		float fz = fract( p.z / uBox.z );
		w.z = hbFieldHgt( w.xy ) + uBase + fz * uBox.z;
		band = smoothstep( 0.0, 0.12, fz ) * ( 1.0 - smoothstep( 0.85, 1.0, fz ) );
	}
	vec3 dc = w - uCam;
	float ex = max( abs( dc.x ) / uBox.x, abs( dc.y ) / uBox.y );
	if ( uGround < 0.5 ) ex = max( ex, abs( dc.z ) / uBox.z );
	float edge = 1.0 - smoothstep( 0.36, 0.5, ex );
	float nearF = smoothstep( 0.35, 1.1, length( dc ) );
	br *= edge * nearF * band;
	if ( uKind > 1.5 && uKind < 2.5 ) {
		// dust shows only in the pool lights' reach
		vec3 wpw = ( modelMatrix * vec4( w, 1.0 ) ).xyz;
		float lit = 0.0;
		for ( int i = 0; i < 8; i++ ) {
			vec4 lp = uFxLightPos[ i ];
			if ( lp.w <= 0.0 ) continue;
			float d = length( wpw - lp.xyz ) / lp.w;
			float fall = max( 1.0 - d, 0.0 );
			lit += fall * fall * dot( uFxLightCol[ i ].rgb, vec3( 0.333 ) ) * 0.02;
		}
		br *= min( lit, 1.5 );
	}
	vec4 mv = modelViewMatrix * vec4( w, 1.0 );
	vDepth = -mv.z;
	// the particles' sub-pixel clamp (tier 2 fxClamp): at least 1.5 px
	// projected radius, the brightness cut by the area ratio
	float sPx = 0.5 * sz * projectionMatrix[ 1 ][ 1 ] / max( -mv.z, 1e-3 ) * 0.5 * uViewH;
	if ( sPx > 1e-6 && sPx < 1.5 ) {
		float k = 1.5 / sPx;
		sz *= k;
		br /= k * k;
	}
	vBright = br;
	float c = cos( ang ), s = sin( ang );
	vec2 q = vec2( c * position.x - s * position.y, s * position.x + c * position.y );
	if ( uKind > 3.5 && uKind < 4.5 ) q.y *= 0.55 + 0.45 * abs( sin( ang * 0.7 ) ); // a leaf turning edge-on
	mv.xy += q * sz;
	gl_Position = br <= 0.0 ? vec4( 0.0, 0.0, 2.0, 1.0 ) : projectionMatrix * mv;
	#include <logdepthbuf_vertex>
}
`;

const FRAG = /* glsl */`
#include <common>
#include <logdepthbuf_pars_fragment>
uniform vec3 uColor;
uniform float uCal;
uniform float uLight;
uniform float uBlend;      // 0 additive light, 1 alpha matter
varying vec2 vUv;
varying float vBright;
varying float vDepth;
varying float vKind;
#ifdef HB_FIELD_GLOW
uniform highp sampler2D uGlowDepth;
uniform vec2 uGlowRes;
uniform float uGlowLogFar;
uniform float uGlowIsLog;
uniform vec2 uGlowNearFar;
uniform float uGlowScale;
#endif
void main() {
	#include <logdepthbuf_fragment>
	float r2 = dot( vUv, vUv );
	if ( r2 > 1.0 || vBright <= 0.0 ) discard;
	float a;
	if ( vKind > 3.5 && vKind < 4.5 ) {
		// leaf: an elongated lobe
		vec2 l = vUv * vec2( 1.0, 1.6 );
		a = 1.0 - smoothstep( 0.55, 0.75, length( l ) );
	} else {
		a = exp( -r2 * ( uBlend > 0.5 ? 4.0 : 7.0 ) );
	}
	a *= vBright;
	if ( a < 0.003 ) discard;
	#ifdef HB_FIELD_GLOW
	float gd = texture2D( uGlowDepth, gl_FragCoord.xy / uGlowRes ).x;
	float gw;
	if ( gd >= 0.999999 ) gw = 1e7;
	else if ( uGlowIsLog > 0.5 ) gw = exp2( gd * uGlowLogFar ) - 1.0;
	else {
		float z = gd * 2.0 - 1.0;
		gw = ( 2.0 * uGlowNearFar.x * uGlowNearFar.y ) / ( uGlowNearFar.y + uGlowNearFar.x - z * ( uGlowNearFar.y - uGlowNearFar.x ) );
	}
	a *= clamp( 1.0 - ( vDepth - gw ) * 2.0, 0.0, 1.0 );
	gl_FragColor = vec4( uColor * a * uCal * uGlowScale * 1.6, 1.0 );
	#else
	if ( uBlend > 0.5 ) gl_FragColor = vec4( uColor * uLight * uCal, a );
	else gl_FragColor = vec4( uColor * a * uCal, 1.0 );
	#endif
}
`;

/** Shader sources (tests). */
export const FX_FIELDS_GLSL = Object.freeze({ vertex: VERT, fragment: FRAG });

// ---------------------------------------------------------------------------
// GPU objects
// ---------------------------------------------------------------------------

const _hgt = new Float32Array(GRID * GRID);
const _shared = {
  uTime: { value: 0 },
  uWind: { value: new THREE.Vector3() },
  uCam: { value: new THREE.Vector3() },
  uHgt: { value: _hgt },
  uHgtGrid: { value: new THREE.Vector3(0, 0, GRID_SPAN_M / (GRID - 1)) },
  uLight: { value: 1 },
  uCalAdd: { value: 1 },
  uCalAlpha: { value: 1 },
  uViewH: { value: 1080 },
};
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

function _seededRng(seed) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) % 1000000) / 1000000; };
}

function _makeField(f) {
  const rnd = _seededRng(0x9e37 + f.kind * 7919);
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]), 3));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  const seeds = new Float32Array(f.count * 4);
  for (let i = 0; i < f.count; i++) {
    seeds[i * 4] = rnd(); seeds[i * 4 + 1] = rnd(); seeds[i * 4 + 2] = rnd();
    seeds[i * 4 + 3] = (i + rnd()) / f.count;   // density rank: a stratified 0..1
  }
  g.setAttribute("aSeed", new THREE.InstancedBufferAttribute(seeds, 4));
  g.instanceCount = f.count;
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
  const own = {
    uBox: { value: new THREE.Vector3(f.box[0], f.box[1], f.box[2]) },
    uKind: { value: f.kind },
    uDensity: { value: 0 },
    uSize: { value: f.size },
    uGround: { value: f.ground ? 1 : 0 },
    uBase: { value: f.base },
    uColor: { value: new THREE.Vector3(f.color[0], f.color[1], f.color[2]) },
    uBlend: { value: f.blend },
    uCal: f.blend ? _shared.uCalAlpha : _shared.uCalAdd,
  };
  const uniforms = {
    ...own,
    uTime: _shared.uTime, uWind: _shared.uWind, uCam: _shared.uCam, uHgt: _shared.uHgt, uHgtGrid: _shared.uHgtGrid,
    uLight: _shared.uLight, uViewH: _shared.uViewH,
    uFxLightPos: TERRAIN_FX_LIGHT_UNIFORMS.uFxLightPos, uFxLightCol: TERRAIN_FX_LIGHT_UNIFORMS.uFxLightCol,
  };
  const m = new THREE.ShaderMaterial({
    name: `fx-field-${f.id}`,
    uniforms,
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    blending: f.blend ? THREE.NormalBlending : THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: true,
    fog: false,
  });
  m.userData = { __cacheOwned: true, __fxField: f.id };
  const mesh = new THREE.Mesh(g, m);
  mesh.name = `fx-field-${f.id}`;
  mesh.frustumCulled = false;
  mesh.matrixAutoUpdate = false;
  mesh.renderOrder = 1;
  mesh.visible = false;
  if (f.layer) mesh.layers.set(f.layer);
  mesh.userData = { isFxField: true, field: f.id };
  let glowMat = null;
  if (f.glow) {
    glowMat = new THREE.ShaderMaterial({
      name: `fx-field-${f.id}-glow`,
      defines: { HB_FIELD_GLOW: "" },
      uniforms: { ...uniforms, ..._glowFrame },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
      fog: false,
    });
  }
  return { def: f, mesh, own, glowMat, density: 0 };
}

// ---------------------------------------------------------------------------
// The provider
// ---------------------------------------------------------------------------

const _camW = new THREE.Vector3();
const _buf = new THREE.Vector2();
const _sample = {};
let _fields = null;
let _group = null;
const _stats = { built: false, updates: 0, resamples: 0, densities: null, coverage: null, night: 0, indoor: false };
let _lastSample = { x: NaN, y: NaN, t: -1 };

function _worldRootOf(ctx) {
  return ctx?.scene3d?.terrainGroup?.parent || null;
}

function _resample(ctx, cx, cy, cz, tSec) {
  const oracle = ctx?.oracle || null;
  const step = GRID_SPAN_M / (GRID - 1);
  const ox = cx - GRID_SPAN_M / 2, oy = cy - GRID_SPAN_M / 2;
  _shared.uHgtGrid.value.set(ox, oy, step);
  const codes = [];
  let fallback = cz - 1.7;
  for (let j = 0; j < GRID; j++) {
    for (let i = 0; i < GRID; i++) {
      const x = ox + i * step, y = oy + j * step;
      let h = null;
      let code = -1;
      if (oracle && typeof oracle.sample === "function") {
        const s = oracle.sample(x, y, _sample);
        if (s) { code = s.code; if (s.hasHeight && Number.isFinite(s.height)) h = s.height; }
      }
      _hgt[j * GRID + i] = h != null ? h : fallback;
      if (h != null) fallback = h;
      codes.push(code);
    }
  }
  _lastSample = { x: cx, y: cy, t: tSec };
  _stats.resamples++;
  return fxFieldCoverage(codes);
}

let _coverage = { grass: 0, swamp: 0, water: 0, forest: 0, snow: 0, volcano: 0 };

/** The camera-scope provider (terrain_vfx.js). */
export function createFxFieldsProvider() {
  return {
    id: "fx.fields",
    scope: "camera",
    families: [],
    enabled: () => fxTier2Enabled("fxFields"),
    quality() { return fxTier2Enabled("fxFields") ? { fields: FX_FIELDS.length } : null; },
    update(dt, ctx) {
      _stats.updates++;
      // the camera the frame is drawn with (the switcher's), as the particles use
      const cam = ctx?.scene3d?.cameraSwitcher?.activeCamera || ctx?.camera || null;
      const root = _worldRootOf(ctx);
      if (!cam || !root) return;
      if (!_fields) {
        _fields = FX_FIELDS.map(_makeField);
        _group = new THREE.Group();
        _group.name = "fxFields";
        for (const f of _fields) _group.add(f.mesh);
        root.add(_group);
        _stats.built = true;
      }
      if (_group.parent !== root) root.add(_group);
      cam.getWorldPosition(_camW);
      root.worldToLocal(_camW);
      const tSec = Number.isFinite(ctx.tSec) ? ctx.tSec : (typeof performance !== "undefined" ? performance.now() / 1000 : 0);
      _shared.uCam.value.copy(_camW);
      _shared.uTime.value = tSec % 2048;
      const dir = (treeWindDir() * Math.PI) / 180;
      const ws = 0.6 * treeWindStrength();
      _shared.uWind.value.set(Math.cos(dir) * ws, Math.sin(dir) * ws, 0);
      const moved = Math.hypot(_camW.x - _lastSample.x, _camW.y - _lastSample.y);
      if (!(moved < 2) || tSec - _lastSample.t > 0.5 || tSec < _lastSample.t) {
        _coverage = _resample(ctx, _camW.x, _camW.y, _camW.z, tSec);
      }
      let night = 0;
      try {
        const st = ctx.scene3d?.skyLightingController?._lastState;
        if (st && Number.isFinite(st.dirPitch)) night = nightFactorFromAuthoredPitch(st.dirPitch);
      } catch (_) { night = 0; }
      let indoor = false;
      try { indoor = viewerIndoorOr(false); } catch (_) { indoor = false; }
      const dens = fxFieldDensities(_coverage, night, indoor);
      _shared.uLight.value = indoor ? 0.6 : 1 - 0.7 * night;
      const rdr = ctx.scene3d?.renderer;
      if (rdr && typeof rdr.getDrawingBufferSize === "function") {
        rdr.getDrawingBufferSize(_buf);
        if (_buf.y > 0) _shared.uViewH.value = _buf.y;
      }
      const e = Number(rdr?.toneMappingExposure);
      _shared.uCalAdd.value = (Number.isFinite(e) && e > 1 ? Math.min(1, 3 / Math.min(20, e)) : 1) * _gain;
      _shared.uCalAlpha.value = (Number.isFinite(e) && e > 1 ? 1 / Math.min(20, e) : 1) * _gain;
      for (const f of _fields) {
        const d = dens[f.def.id] || 0;
        // ease towards the target so a field never pops (≈ 1.5 s)
        f.density += (d - f.density) * Math.min(1, (Number.isFinite(dt) ? dt : 0.016) * 0.7);
        if (f.density < 0.002 && d === 0) f.density = 0;
        f.own.uDensity.value = f.density;
        f.mesh.visible = f.density > 0.002;
      }
      _stats.densities = dens;
      _stats.coverage = _coverage;
      _stats.night = night;
      _stats.indoor = indoor;
    },
    dispose() {
      if (_group && _group.parent) _group.parent.remove(_group);
      if (_fields) {
        for (const f of _fields) {
          try { f.mesh.geometry.dispose(); } catch (_) {}
          try { f.mesh.material.dispose(); } catch (_) {}
          try { f.glowMat?.dispose(); } catch (_) {}
        }
      }
      _fields = null;
      _group = null;
      _stats.built = false;
    },
    stats: () => fxFieldsStats(),
  };
}

// The additive fields draw with the particles in the late pass; the alpha
// fields stay in the world pass (they are matter, under the clouds like smoke
// would be without the late pass). Only visible fields are pushed.
registerLateFxSource((out) => {
  if (!_fields) return;
  for (const f of _fields) if (f.def.blend === 0 && f.mesh.visible && f.mesh.parent) out.push(f.mesh);
});

// Fireflies and embers also glow (`?fxGlow`).
registerFxGlowExtras({
  collect(out) {
    if (!_fields) return;
    for (const f of _fields) if (f.glowMat && f.mesh.visible) out.push({ object: f.mesh, material: f.glowMat });
  },
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

/** Diagnostics (`window.__fxFields`). */
export function fxFieldsStats() {
  return {
    ..._stats,
    live: _fields ? _fields.filter((f) => f.mesh.visible).map((f) => `${f.def.id}:${f.density.toFixed(2)}`) : [],
  };
}

let _gain = 1;   // `window.__fxFields.gain` (live tuning)
let _handle = null;
/**
 * Register the provider (index.js, after the terrain-VFX spine). Registers
 * nothing when `?fxFields` is off for this session or under `?wireframe=1`.
 * @returns {object|null} `window.__fxFields`
 */
export function initFxFields(opts = {}) {
  if (_handle) return _handle;
  if (!fxTier2Enabled("fxFields")) return null;
  if (wireframeActive(opts.search)) return null;
  const provider = createFxFieldsProvider();
  const reg = registerTerrainVfx(provider);
  _handle = {
    provider,
    stats: fxFieldsStats,
    get gain() { return _gain; },
    set gain(v) { if (Number.isFinite(+v)) _gain = Math.max(0, +v); },
    unregister: () => { reg.unregister(); _handle = null; },
  };
  try { if (typeof window !== "undefined") window.__fxFields = _handle; } catch (_) { /* fail-soft */ }
  return _handle;
}

/** Test seam. */
export function _resetFxFieldsForTest() {
  if (_handle) { try { _handle.unregister(); } catch (_) {} }
  _handle = null;
  if (_group && _group.parent) _group.parent.remove(_group);
  _fields = null;
  _group = null;
  _lastSample = { x: NaN, y: NaN, t: -1 };
  for (const k of Object.keys(_stats)) _stats[k] = k === "built" ? false : (typeof _stats[k] === "number" ? 0 : null);
}
