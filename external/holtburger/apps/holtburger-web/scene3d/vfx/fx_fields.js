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
//   ash        grey ash drifting down over volcanic ground (lava + ash codes)
//   embers     glowing embers rising off LAVA ground (+ glow buffer)
//
// 2026-10-23 volcano split (terrain_families.js): "volcanic" was codes 6, 25
// and 26 as one family. Now lava (25, FAM_VOLCANO) drives ash + embers, grey
// ash / pumice (26, FAM_ASH) drives the ash drift alone (no lava there, so no
// embers), and obsidian glass (6, FAM_OBSIDIAN) drives neither — the owner's
// "obsidian plains mixed up with lava".
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
import { FAM_GRASS, FAM_SAND, FAM_SWAMP, FAM_SNOWICE, FAM_VOLCANO, FAM_ASH, FAM_WATER, TERRAIN_CODE_TO_FAMILY } from "../terrain_families.js";
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
  Object.freeze({ id: "fireflies", kind: 1, count: 192, box: [38, 38, 3.2], ground: true, base: 0.32, blend: 0, glow: true, layer: 0, size: 0.068, color: [0.92, 0.78, 0.32] }),
  Object.freeze({ id: "dust", kind: 2, count: 240, box: [14, 14, 7], ground: false, base: 0, blend: 0, glow: false, layer: 1, size: 0.022, color: [0.92, 0.86, 0.74] }),
  Object.freeze({ id: "pollen", kind: 3, count: 180, box: [30, 30, 4.2], ground: true, base: 0.28, blend: 0, glow: false, layer: 0, size: 0.028, color: [0.94, 0.88, 0.64] }),
  Object.freeze({ id: "leaves", kind: 4, count: 120, box: [34, 34, 9.5], ground: true, base: 0.0, blend: 1, glow: false, layer: 0, size: 0.115, color: [0.54, 0.44, 0.19] }),
  Object.freeze({ id: "snow", kind: 5, count: 520, box: [32, 32, 16], ground: false, base: 0, blend: 1, glow: false, layer: 0, size: 0.038, color: [0.76, 0.81, 0.88] }),
  Object.freeze({ id: "ash", kind: 6, count: 240, box: [32, 32, 12], ground: false, base: 0, blend: 1, glow: false, layer: 0, size: 0.05, color: [0.34, 0.32, 0.31] }),
  Object.freeze({ id: "embers", kind: 7, count: 96, box: [24, 24, 6], ground: true, base: 0.2, blend: 0, glow: true, layer: 0, size: 0.035, color: [0.95, 0.44, 0.12] }),
]);

// ---------------------------------------------------------------------------
// Pure helpers (node-tested)
// ---------------------------------------------------------------------------

/**
 * Pure: per-field density (0..1) for one environment.
 * @param {{grass:number, swamp:number, water:number, forest:number, snow:number, volcano:number, ash?:number, sand?:number, lush?:number, canopy?:number, ridge?:number}} cov
 *   coverage fractions (0..1) of the sample grid
 * @param {number} night 0 day .. 1 night
 * @param {boolean} indoor
 */
export function fxFieldDensities(cov, night, indoor) {
  const c = (k) => Math.min(1, Math.max(0, +cov?.[k] || 0));
  const n = Math.min(1, Math.max(0, Number.isFinite(night) ? night : 0));
  const out = { fireflies: 0, dust: 0, pollen: 0, leaves: 0, snow: 0, ash: 0, embers: 0 };
  if (indoor) { out.dust = 1; return out; }
  const nightOn = Math.min(1, Math.max(0, (n - 0.38) / 0.34));
  const dayOn = 1 - Math.min(1, Math.max(0, (n - 0.2) / 0.4));
  const forestEff = Math.min(1, c("forest") + c("lush") * 0.45 + c("canopy") * 0.65);
  const volcTotal = c("volcano") + c("ash");
  const coastal = c("water") > 0.08 && c("swamp") < 0.15 && volcTotal === 0
    ? Math.min(1, Math.min(c("grass") * 1.4, c("water") * 2.2))
    : 0;
  const ridge = Math.min(1, Math.max(0, c("ridge")));
  out.fireflies = nightOn * Math.min(1, (c("grass") + 1.6 * c("swamp") + 0.85 * forestEff + 0.6 * c("water")) * 1.4);
  out.pollen = dayOn * Math.min(1, c("grass") * 0.9 + forestEff * 0.55);
  out.leaves = Math.min(1, Math.max(forestEff * 1.2 + c("grass") * 0.12, coastal * 0.82));
  out.snow = Math.min(1, c("snow") * 1.1 + ridge * 0.78);
  const volcAsh = volcTotal * 1.2;
  const marshMist = volcAsh > 0 ? 0 : Math.min(1, Math.max(0, (c("swamp") - 0.06) * 1.35));
  const surfSpray = volcAsh > 0 || marshMist > 0.15 ? 0 : Math.min(0.85, coastal * 0.85);
  const sandWisp = volcAsh > 0 || marshMist > 0.1 || surfSpray > 0.1
    ? 0
    : Math.min(0.9, Math.max(0, (c("sand") - 0.08) * 1.25));
  out.ash = Math.min(1, Math.max(volcAsh, marshMist, surfSpray, sandWisp));
  out.embers = Math.min(1, c("volcano") * 1.2);
  return out;
}

/** Pure: coverage fractions from a list of terrain codes (-1 = unknown, skipped). */
export function fxFieldCoverage(codes) {
  const cov = { grass: 0, swamp: 0, water: 0, forest: 0, snow: 0, volcano: 0, ash: 0, sand: 0, lush: 0 };
  let n = 0;
  for (const code of codes) {
    if (!(code >= 0)) continue;
    n++;
    const c32 = code & 0x1f;
    const f = TERRAIN_CODE_TO_FAMILY[c32];
    if (f === FAM_GRASS) cov.grass++;
    else if (f === FAM_SWAMP) cov.swamp++;
    else if (f === FAM_WATER) cov.water++;
    else if (f === FAM_SNOWICE) cov.snow++;
    else if (f === FAM_VOLCANO) cov.volcano++;
    else if (f === FAM_ASH) cov.ash++;
    else if (f === FAM_SAND) cov.sand++;
    if (FX_FOREST_CODES.includes(c32)) cov.forest++;
    if (c32 === 3) cov.lush++;
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
uniform float uSubMode;    // biome sub-mode (blossoms, marsh wisps, mist, spray, sand, spindrift)
uniform vec2 uAspect;      // billboard width/height aspect (mist ribbons & sand streaks)
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
	float wLen = length( uWind.xy );
	vec2 wDir = wLen > 1e-4 ? uWind.xy / wLen : vec2( 0.7071, 0.7071 );
	float gustPh = dot( p.xy, wDir ) * 0.085 - t * 1.15;
	float gust = 0.74 + 0.26 * sin( gustPh ) + 0.08 * sin( gustPh * 3.7 + ph );
	if ( uKind < 1.5 ) {
		// fireflies & swamp bioluminescent wisps: lazy hover + pulse
		float marsh = clamp( uSubMode, 0.0, 1.0 );
		vec3 wander = vec3(
			sin( t * mix( 0.35, 0.22, marsh ) + ph ) * mix( 1.2, 0.85, marsh ),
			cos( t * mix( 0.28, 0.19, marsh ) + ph * 1.3 ) * mix( 1.2, 0.85, marsh ),
			sin( t * mix( 0.6, 0.36, marsh ) + ph * 0.7 ) * mix( 0.42, 0.24, marsh )
		);
		p += uWind * t * mix( 0.15, 0.08, marsh ) + wander;
		float bl = sin( t * ( mix( 0.7, 0.46, marsh ) + 0.45 * fract( ph ) ) + ph * 3.0 );
		br = mix( smoothstep( 0.22, 0.95, bl ), 0.18 + 0.82 * smoothstep( -0.15, 0.92, bl ), marsh );
	} else if ( uKind < 2.5 ) {
		// dust motes: a slow brownian drift
		p += vec3( sin( t * 0.13 + ph ), cos( t * 0.11 + ph * 1.7 ), sin( t * 0.07 + ph * 0.5 ) * 0.6 ) * 0.8 + uWind * t * 0.05;
	} else if ( uKind < 3.5 ) {
		// pollen & forest sunbeam spores: buoyant drift + sun glint
		p += uWind * ( t * 0.85 * gust ) + vec3(
			sin( t * 0.45 + ph ) * 0.35,
			cos( t * 0.38 + ph * 1.4 ) * 0.35,
			sin( t * 0.85 + ph ) * 0.32 + t * 0.08
		);
		br = 0.52 + 0.48 * pow( max( sin( t * 1.9 + ph * 5.0 ), 0.0 ), 6.0 );
	} else if ( uKind < 4.5 ) {
		// canopy leaves (uSubMode ~ 0) vs wind-carried coastal/cherry blossoms (uSubMode ~ 1)
		float petal = clamp( uSubMode, 0.0, 1.0 );
		float sink = mix( 0.48 + 0.30 * fract( ph ), 0.20 + 0.16 * fract( ph ), petal );
		float swoop = sin( t * mix( 1.25, 1.65, petal ) + ph );
		p += uWind * ( t * mix( 0.85, 1.15, petal ) * gust ) + vec3(
			swoop * mix( 0.78, 0.55, petal ),
			cos( t * mix( 1.05, 1.45, petal ) + ph * 1.2 ) * 0.52,
			-t * sink + abs( swoop ) * mix( 0.22, 0.34, petal )
		);
		ang = t * ( mix( 1.4, 2.1, petal ) + 1.8 * fract( ph * 1.7 ) ) + ph;
	} else if ( uKind < 5.5 ) {
		// snow flurry (uSubMode ~ 0) vs high-ridge frost & spindrift motes (uSubMode ~ 1)
		float ridge = clamp( uSubMode, 0.0, 1.0 );
		p += uWind * ( t * mix( 0.6, 1.45, ridge ) * gust ) + vec3(
			sin( t * 1.7 + ph ) * mix( 0.25, 0.42, ridge ),
			cos( t * 1.3 + ph ) * mix( 0.25, 0.42, ridge ),
			-t * mix( 0.8 + 0.5 * fract( ph ), 0.22 + 0.20 * fract( ph ), ridge )
		);
		br = mix( 1.0, 0.65 + 0.35 * abs( sin( t * 3.4 + ph * 2.7 ) ), ridge );
	} else if ( uKind < 6.5 ) {
		// ash (0), coastal sea-spray mist (1), marsh mist ribbons (2), desert sand wisps (3)
		if ( uSubMode < 0.5 ) {
			p += uWind * t * 0.7 + vec3( sin( t * 0.5 + ph ) * 0.4, cos( t * 0.4 + ph ) * 0.4, -t * ( 0.3 + 0.2 * fract( ph ) ) );
			ang = t * 0.6 + ph;
		} else if ( uSubMode < 1.5 ) {
			// coastal sea-spray mist: buoyant inland surf drift
			p += uWind * ( t * 0.95 * gust ) + vec3( sin( t * 0.42 + ph ) * 0.45, cos( t * 0.36 + ph ) * 0.45, t * 0.16 );
			br = 0.28 + 0.22 * sin( t * 0.55 + ph * 2.1 );
		} else if ( uSubMode < 2.5 ) {
			// ground-hugging marsh mist ribbons: slow peat-skimming curl
			p += uWind * t * 0.22 + vec3( sin( t * 0.16 + ph ) * 0.9, cos( t * 0.14 + ph * 1.3 ) * 0.9, sin( t * 0.22 + ph ) * 0.08 );
			br = 0.24 + 0.16 * sin( t * 0.32 + ph * 1.9 );
		} else {
			// wind-skimming desert sand wisps: rapid low dune streak
			p += uWind * ( t * 2.05 * gust ) + vec3( wDir.x, wDir.y, 0.0 ) * ( sin( t * 0.9 + ph ) * 0.45 );
			br = 0.26 + 0.20 * smoothstep( 0.62, 1.02, gust );
		}
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
		band = smoothstep( 0.0, 0.14, fz ) * ( 1.0 - smoothstep( 0.82, 1.0, fz ) );
	}
	vec3 dc = w - uCam;
	float ex = max( abs( dc.x ) / uBox.x, abs( dc.y ) / uBox.y );
	if ( uGround < 0.5 ) ex = max( ex, abs( dc.z ) / uBox.z );
	float edge = 1.0 - smoothstep( 0.34, 0.5, ex );
	float nearF = smoothstep( 0.45, 1.35, length( dc ) );
	br *= edge * nearF * band;
	if ( uKind > 1.5 && uKind < 2.5 ) {
		// dust shows only in the pool lights reach
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
	float maxSpan = sz * max( uAspect.x, uAspect.y );
	if ( mv.z > -0.12 ) {
		vBright = 0.0; vDepth = 0.0;
		gl_Position = vec4( 0.0, 0.0, 2.0, 1.0 );
		return;
	}
	float clipLim = -mv.z * 1.35 + maxSpan * 2.5;
	if ( abs( mv.x ) * projectionMatrix[ 0 ][ 0 ] > clipLim || abs( mv.y ) * projectionMatrix[ 1 ][ 1 ] > clipLim ) {
		vBright = 0.0; vDepth = 0.0;
		gl_Position = vec4( 0.0, 0.0, 2.0, 1.0 );
		return;
	}
	vDepth = -mv.z;
	// the particles sub-pixel clamp (tier 2 fxClamp): at least 1.5 px
	// projected radius, the brightness cut by the area ratio
	float sPx = 0.5 * sz * projectionMatrix[ 1 ][ 1 ] / max( -mv.z, 1e-3 ) * 0.5 * uViewH;
	if ( sPx > 1e-6 && sPx < 1.5 ) {
		float k = 1.5 / sPx;
		sz *= k;
		br /= k * k;
	}
	vBright = br;
	float c = cos( ang ), s = sin( ang );
	vec2 q = vec2( c * position.x - s * position.y, s * position.x + c * position.y ) * uAspect;
	if ( uKind > 3.5 && uKind < 4.5 ) q.y *= 0.55 + 0.45 * abs( sin( ang * 0.7 ) ); // a leaf or petal turning edge-on
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
	#ifdef USE_REVERSED_DEPTH_BUFFER
	// ?reversedZ=on: raw reversed depth (1 near, 0 far / cleared)
	if ( gd <= 0.0 ) gw = 1e7;
	else gw = ( uGlowNearFar.x * uGlowNearFar.y ) / ( gd * ( uGlowNearFar.y - uGlowNearFar.x ) + uGlowNearFar.x );
	#else
	if ( gd >= 0.999999 ) gw = 1e7;
	else if ( uGlowIsLog > 0.5 ) gw = exp2( gd * uGlowLogFar ) - 1.0;
	else {
		float z = gd * 2.0 - 1.0;
		gw = ( 2.0 * uGlowNearFar.x * uGlowNearFar.y ) / ( uGlowNearFar.y + uGlowNearFar.x - z * ( uGlowNearFar.y - uGlowNearFar.x ) );
	}
	#endif
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
    uSubMode: { value: 0 },
    uAspect: { value: { x: 1, y: 1 } },
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
const _buf = typeof THREE.Vector2 === "function"
  ? new THREE.Vector2()
  : { x: 0, y: 0, set(x, y) { this.x = x; this.y = y; return this; } };
const _sample = {};
let _fields = null;
let _group = null;
const _stats = { built: false, updates: 0, resamples: 0, densities: null, coverage: null, night: 0, indoor: false };
let _lastSample = { x: NaN, y: NaN, t: -1 };

function _worldRootOf(ctx) {
  return ctx?.scene3d?.terrainGroup?.parent || null;
}

function _hasFoliageSubmesh(obj) {
  if (!obj) return false;
  const mat = obj.material;
  if (mat) {
    if (Array.isArray(mat)) {
      for (let i = 0; i < mat.length; i++) if (mat[i] && mat[i].alphaTest > 0) return true;
    } else if (mat.alphaTest > 0) return true;
  }
  const ch = obj.children;
  if (Array.isArray(ch)) {
    for (let i = 0; i < ch.length; i++) if (_hasFoliageSubmesh(ch[i])) return true;
  }
  return false;
}

function _sampleCanopyDensity(ctx, cx, cy) {
  const children = ctx?.scene3d?.staticsGroup?.children;
  if (!Array.isArray(children) || children.length === 0) return 0;
  const r2 = 44 * 44;
  let trees = 0;
  const lim = Math.min(children.length, 384);
  for (let i = 0; i < lim; i++) {
    const o = children[i];
    const p = o?.position;
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    const dx = p.x - cx, dy = p.y - cy;
    if (dx * dx + dy * dy > r2) continue;
    if (_hasFoliageSubmesh(o)) {
      trees++;
      if (trees >= 12) break;
    }
  }
  return Math.min(1, trees / 10);
}

function _resample(ctx, cx, cy, cz, tSec) {
  const oracle = ctx?.oracle || null;
  const step = GRID_SPAN_M / (GRID - 1);
  const ox = cx - GRID_SPAN_M / 2, oy = cy - GRID_SPAN_M / 2;
  _shared.uHgtGrid.value.set(ox, oy, step);
  const codes = [];
  let fallback = cz - 1.7;
  let hgtSum = 0;
  let hgtCnt = 0;
  for (let j = 0; j < GRID; j++) {
    for (let i = 0; i < GRID; i++) {
      const x = ox + i * step, y = oy + j * step;
      let h = null;
      let code = -1;
      if (oracle && typeof oracle.sample === "function") {
        const s = oracle.sample(x, y, _sample);
        if (s) { code = s.code; if (s.hasHeight && Number.isFinite(s.height)) h = s.height; }
      }
      const hv = h != null ? h : fallback;
      _hgt[j * GRID + i] = hv;
      if (h != null) { fallback = h; hgtSum += h; hgtCnt++; }
      codes.push(code);
    }
  }
  _lastSample = { x: cx, y: cy, t: tSec };
  _stats.resamples++;
  const cov = fxFieldCoverage(codes);
  const meanHgt = hgtCnt > 0 ? hgtSum / hgtCnt : fallback;
  // Mountain ridges (e.g. Linvak Tukal, z > 140 m): crisp frost & spindrift motes.
  cov.ridge = meanHgt > 140 ? Math.min(1, (meanHgt - 140) / 55) : 0;
  // Deep woodland / grove tree canopy (Glenden Wood, Baishi, Nanto groves).
  cov.canopy = _sampleCanopyDensity(ctx, cx, cy);
  return cov;
}

let _coverage = { grass: 0, swamp: 0, water: 0, forest: 0, snow: 0, volcano: 0, ash: 0, sand: 0, lush: 0, canopy: 0, ridge: 0 };

function _lerp(a, b, k) { return a + (b - a) * k; }

function _syncFieldBiomeUniforms(fields, cov, night, ease) {
  const swamp = Math.min(1, Math.max(0, +cov?.swamp || 0));
  const water = Math.min(1, Math.max(0, +cov?.water || 0));
  const grass = Math.min(1, Math.max(0, +cov?.grass || 0));
  const forest = Math.min(1, (+cov?.forest || 0) + (+cov?.lush || 0) * 0.45 + (+cov?.canopy || 0) * 0.65);
  const sand = Math.min(1, Math.max(0, +cov?.sand || 0));
  const ridge = Math.min(1, Math.max(0, +cov?.ridge || 0));
  const snow = Math.min(1, Math.max(0, +cov?.snow || 0));
  const volc = Math.min(1, (+cov?.volcano || 0) + (+cov?.ash || 0));
  const coastal = water > 0.08 && swamp < 0.15 && volc === 0
    ? Math.min(1, Math.min(grass * 1.4, water * 2.2))
    : 0;
  // Blossom vs autumn leaf weight: coastal towns (Mayoi / Nanto) shift leaves -> cherry blossoms
  // unless deep woodland floor dominates.
  const blossomW = coastal > 0 && forest < 0.65 ? Math.min(1, coastal * (1 - forest * 0.7)) : 0;
  const marshWispW = Math.min(1, swamp * 1.8);
  const spindriftW = snow > 0.25 ? Math.min(1, ridge * 0.65 + 0.25) : ridge;

  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    const own = f.own;
    const id = f.def.id;
    if (id === "fireflies") {
      // Meadow/canopy warm gold [0.92, 0.78, 0.32] <-> Shoushi bioluminescent marsh wisp [0.46, 0.84, 0.38]
      const tr = _lerp(0.92, 0.46, marshWispW);
      const tg = _lerp(0.78, 0.84, marshWispW);
      const tb = _lerp(0.32, 0.38, marshWispW);
      own.uColor.value.set(
        _lerp(own.uColor.value.x, tr, ease),
        _lerp(own.uColor.value.y, tg, ease),
        _lerp(own.uColor.value.z, tb, ease),
      );
      own.uSubMode.value = _lerp(own.uSubMode.value, marshWispW, ease);
      own.uSize.value = _lerp(own.uSize.value, _lerp(0.068, 0.088, marshWispW), ease);
      own.uBase.value = _lerp(own.uBase.value, _lerp(0.32, 0.22, marshWispW), ease);
    } else if (id === "leaves") {
      // Deep forest sunlit russet-olive [0.54, 0.44, 0.19] <-> Mayoi/Nanto cherry blossom [0.76, 0.54, 0.60]
      const tr = _lerp(0.54, 0.76, blossomW);
      const tg = _lerp(0.44, 0.54, blossomW);
      const tb = _lerp(0.19, 0.60, blossomW);
      own.uColor.value.set(
        _lerp(own.uColor.value.x, tr, ease),
        _lerp(own.uColor.value.y, tg, ease),
        _lerp(own.uColor.value.z, tb, ease),
      );
      own.uSubMode.value = _lerp(own.uSubMode.value, blossomW, ease);
      own.uSize.value = _lerp(own.uSize.value, _lerp(0.115, 0.086, blossomW), ease);
    } else if (id === "snow") {
      // Snow flurry [0.76, 0.81, 0.88] <-> Linvak Tukal crisp frost spindrift [0.68, 0.76, 0.86]
      own.uSubMode.value = _lerp(own.uSubMode.value, spindriftW, ease);
      own.uSize.value = _lerp(own.uSize.value, _lerp(0.038, 0.031, spindriftW), ease);
      own.uColor.value.set(
        _lerp(own.uColor.value.x, _lerp(0.76, 0.68, spindriftW), ease),
        _lerp(own.uColor.value.y, _lerp(0.81, 0.76, spindriftW), ease),
        _lerp(own.uColor.value.z, _lerp(0.88, 0.86, spindriftW), ease),
      );
    } else if (id === "ash") {
      // Multi-biome alpha matter slot (mutually exclusive in Dereth):
      //   0: volcanic ash | 1: coastal sea-spray mist | 2: Shoushi marsh mist ribbons | 3: Yaraq sand wisps
      let sub = 0, gnd = 0, base = 0, sz = 0.05, ax = 1, ay = 1;
      let cr = 0.34, cg = 0.32, cb = 0.31, bx = 32, by = 32, bz = 12;
      if (volc > 0) {
        sub = 0; gnd = 0; base = 0; sz = 0.05; ax = 1; ay = 1;
        cr = 0.34; cg = 0.32; cb = 0.31; bx = 32; by = 32; bz = 12;
      } else if (swamp > 0.06) {
        sub = 2; gnd = 1; base = 0.08; sz = 0.58; ax = 3.8; ay = 0.36;
        cr = 0.32; cg = 0.40; cb = 0.35; bx = 36; by = 36; bz = 1.35;
      } else if (coastal > 0.05) {
        sub = 1; gnd = 1; base = 0.14; sz = 0.40; ax = 2.6; ay = 0.62;
        cr = 0.54; cg = 0.62; cb = 0.68; bx = 34; by = 34; bz = 2.2;
      } else if (sand > 0.08) {
        sub = 3; gnd = 1; base = 0.05; sz = 0.36; ax = 3.5; ay = 0.28;
        cr = 0.52; cg = 0.42; cb = 0.28; bx = 34; by = 34; bz = 1.1;
      }
      own.uSubMode.value = sub;
      own.uGround.value = gnd;
      own.uBase.value = _lerp(own.uBase.value, base, ease);
      own.uSize.value = _lerp(own.uSize.value, sz, ease);
      own.uAspect.value.x = _lerp(own.uAspect.value.x, ax, ease);
      own.uAspect.value.y = _lerp(own.uAspect.value.y, ay, ease);
      own.uBox.value.set(
        _lerp(own.uBox.value.x, bx, ease),
        _lerp(own.uBox.value.y, by, ease),
        _lerp(own.uBox.value.z, bz, ease),
      );
      own.uColor.value.set(
        _lerp(own.uColor.value.x, cr, ease),
        _lerp(own.uColor.value.y, cg, ease),
        _lerp(own.uColor.value.z, cb, ease),
      );
    }
  }
  // Suppress unused-param lint while keeping signature ready for dusk tint hooks.
  void night;
}

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
      // Deep canopy twilight boost: when sun is low near dusk/dawn (night in 0.15..0.5),
      // dense forest canopies reach firefly twilight slightly earlier while noon stays 0.
      const canopyShade = (!indoor && night > 0.14 && (+_coverage.canopy || 0) > 0.25)
        ? Math.min(1, night + (+_coverage.canopy || 0) * 0.18)
        : night;
      const dens = fxFieldDensities(_coverage, canopyShade, indoor);
      _shared.uLight.value = indoor ? 0.55 : Math.max(0.16, 1 - 0.78 * night);
      const rdr = ctx.scene3d?.renderer;
      if (rdr && typeof rdr.getDrawingBufferSize === "function") {
        rdr.getDrawingBufferSize(_buf);
        if (_buf.y > 0) _shared.uViewH.value = _buf.y;
      }
      // Pre-exposure HDR calibration (prevents paper-white blowout under exposure = 5.0).
      const e = Number(rdr?.toneMappingExposure);
      _shared.uCalAdd.value = (Number.isFinite(e) && e > 1 ? Math.min(1, 1.35 / Math.min(20, e)) : 0.45) * _gain;
      _shared.uCalAlpha.value = (Number.isFinite(e) && e > 1 ? 0.58 / Math.min(20, e) : 0.58) * _gain;
      const stepDt = Number.isFinite(dt) ? dt : 0.016;
      const ease = Math.min(1, Math.max(0.02, stepDt * 0.7));
      _syncFieldBiomeUniforms(_fields, _coverage, night, Math.min(1, stepDt * 1.6));
      for (const f of _fields) {
        const d = dens[f.def.id] || 0;
        // ease towards the target so a field never pops (~1.5 s)
        f.density += (d - f.density) * ease;
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
// would be without the late pass). Only visible fields are pushed — except to
// the `?lateFxWarm` program warm (2026-10-20, `opts.all`): every field is built
// at once and most sit hidden (density 0) until their biome / the night comes,
// so the warm takes the hidden ones too.
registerLateFxSource((out, opts) => {
  if (!_fields) return;
  const all = opts?.all === true;
  for (const f of _fields) if (f.def.blend === 0 && (all || (f.mesh.visible && f.mesh.parent))) out.push(f.mesh);
});

// Fireflies and embers also glow (`?fxGlow`); `opts.all`: the warm, as above.
registerFxGlowExtras({
  collect(out, opts) {
    if (!_fields) return;
    const all = opts?.all === true;
    for (const f of _fields) if (f.glowMat && (all || f.mesh.visible)) out.push({ object: f.mesh, material: f.glowMat });
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
