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
//   LIFESTONE  (LIFESTONE flag) `?lifestoneFx` (2026-10-11, DEFAULT ON — see
//              vfx/lifestone_fx.js): the crystal's own materials (inner light,
//              rim, facet glints, breathing), an AURA here (kind 4: a soft halo
//              round the crystal, wisps drifting outward, motes leaving it), a
//              light carrier that paints the claws and the ground, and the
//              crystal in the glow buffer at high / ultra. No shaft, no ring.
//              `?lifestoneFx=off` = the 2026-10-10 look: a vertical light shaft
//              (an additive column facing the camera round the vertical, its
//              noise mask scrolling up, glitter rising in it) and a ground ring.
//              (Retail's Holtburg stone — Setup 0x020002EE — has no emitters and
//              no light: the "breathing light" this line used to promise only
//              exists on the 9 "new" stones, Setup 0x02000EAD.)
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
// ONE draw for every disc, shaft, column, flare and aura (an instanced
// billboard, the kind is per instance), one program, plus the flare's glow
// variant. No light here (the lifestone's carrier lives in lifestone_fx.js).
//
// PORTAL PARITY (2026-10-11, `?portalFxLum`, DEFAULT ON, `=off` escape). Owner:
// "yellow, green, white etc portals don't have the 3dness ... that the purple
// portals have". The retail data is symmetric — Setups 0x020001B3 (purple) and
// 0x020005D2-D6 / 0x020006F4 differ only in light colour + default_script, the
// swirl emitters 0x320002CD vs 0x320003B1-B5 / 0x32000437 only in GfxObj and
// surface (the same swirl art recoloured). The set piece was not: the disc and
// the ground ring are ADDITIVE at the swirl light colour normalised to max
// channel 1, so their luminance follows the hue — purple 0.29, red 0.34, blue
// 0.21, but yellow 0.83, green 0.78, white 0.95 (Rec.709 on the tier-1 light
// colours). On exactly the colours the owner named the disc fogged the swirl's
// dark gaps ~3x harder than on purple, and the depth went with them; the fixed
// violet base of the nebula (`deep`) greyed them further. ON: a portal's disc +
// ring intensity is scaled so its luminance matches purple's (never brightened,
// so purple / blue / red keep today's look), and the nebula base keeps the
// portal's own hue. The tagging half of the same defect (red / orange / pillar
// swirls lost portal breathing, ×1.25 swirl distortion, ×1.3 light) is fixed in
// the generator: tools/particle-fx/enrich.py tags by Portal weenie type.

import * as THREE from "three";
import { fxTier2Enabled } from "./fx_tier2.js";
import { fxTier1Enabled } from "./fx_tier1.js";
import { addFxDecal, releaseFxDecal } from "./fx_decals.js";
import { fxDistortSwirlNear } from "./fx_distort.js";
import { fxEmitterLightNear } from "./fx_lights.js";
import { registerLateFxSource, registerFxGlowExtras } from "../particles_over_clouds.js";
import {
  lifestoneFxEnabled,
  lifestoneFxSync,
  lifestoneFxRelease,
  lifestoneFxReleaseAll,
  lifestoneFxTick,
  lifestoneFxAuras,
  isLifestoneLightCarrier,
  _resetLifestoneFxForTest,
} from "./lifestone_fx.js";

export const ODF_LIFESTONE = 0x00004000;
export const ODF_PORTAL = 0x00040000;
export const FX_SHOWCASE_MAX = 16;
export const FX_SHOWCASE_KIND = Object.freeze({ disc: 1, shaft: 2, flare: 3, aura: 4 });
const SCAN_MS = 500;
const RANGE_M = 60;
// `?lifestoneFx`: a lifestone already in the set leaves it only past this
// (its crystal materials, aura and light fade out and back in, never flicker
// at the edge of the scan range).
const LIFESTONE_KEEP_M = RANGE_M + 8;

const PORTAL_VIOLET = [0.75, 0.5, 1.0];
const LIFESTONE_BLUE = [0.55, 0.78, 1.0];
const LEVELUP_GOLD = [1.0, 0.86, 0.48];

// `?portalFxLum` (see the PORTAL PARITY note above). Read once at module load;
// `_setPortalFxLumForTest` is the seam.
let _portalFxLumOn = (() => {
  try {
    return new URLSearchParams(globalThis.location?.search || "").get("portalFxLum")?.toLowerCase() !== "off";
  } catch (_) {
    return true;
  }
})();
/** Test seam: force `?portalFxLum` (null re-reads the URL). */
export function _setPortalFxLumForTest(on) {
  if (on == null) {
    try {
      _portalFxLumOn = new URLSearchParams(globalThis.location?.search || "").get("portalFxLum")?.toLowerCase() !== "off";
    } catch (_) {
      _portalFxLumOn = true;
    }
  } else {
    _portalFxLumOn = !!on;
  }
}
export function portalFxLumEnabled() { return _portalFxLumOn; }

/** The purple swirl's tier-1 light colour (0x320002CD, data/particle-fx-tier1.json). */
export const PORTAL_REF_COLOR = Object.freeze([0.8335, 0.0611, 1.0]);
/** Rec.709 relative luminance of a linear rgb triple. */
export function portalColorLuminance(c) {
  return 0.2126 * (+c[0] || 0) + 0.7152 * (+c[1] || 0) + 0.0722 * (+c[2] || 0);
}
export const PORTAL_REF_LUM = portalColorLuminance(PORTAL_REF_COLOR);
/**
 * Pure: the set-piece intensity scale for a portal colour (max channel 1) — its
 * luminance brought down to the purple portal's, never up.
 */
export function portalLumScale(color) {
  const l = portalColorLuminance(color || PORTAL_REF_COLOR);
  return l > PORTAL_REF_LUM ? PORTAL_REF_LUM / l : 1;
}

// ---------------------------------------------------------------------------
// Shader (one program; the glow variant draws only the flares)
// ---------------------------------------------------------------------------

const VERT = /* glsl */`
#include <common>
#include <logdepthbuf_pars_vertex>
attribute vec4 aS0;   // centre (THREE world), kind
attribute vec4 aS1;   // radius / width, height, fade, seed (aura: x / y radius, fade, seed)
attribute vec4 aS2;   // colour rgb, intensity
attribute vec4 aS3;   // age (s), grow (0..1), 0, 0 (aura: age, the crystal's edge in aura units, breath, soft share)
uniform float uShowFlareInScene;
varying vec2 vUv;
varying vec4 vCol;
varying vec4 vInfo;    // kind, seed, age, fade
varying vec4 vAux;     // aura: radii (m), the crystal's edge (aura units), breath
varying float vSoft;   // aura: the soft halo's share (day / night, glow pass)
varying float vDepth;
void main() {
	vec3 C = aS0.xyz;
	float kind = aS0.w;
	vInfo = vec4( kind, aS1.w, aS3.x, aS1.z );
	vCol = aS2;
	vAux = vec4( aS1.xy, aS3.yz );
	vSoft = aS3.w;
	vec4 mv;
	// the glow variant draws only the flares; the scene draws the rest (and the
	// flares too when no glow pass is running)
	#ifdef HB_SHOWCASE_GLOW
	bool keep = kind > 2.5 && kind < 3.5;
	#else
	bool keep = kind < 2.5 || kind > 3.5 || uShowFlareInScene > 0.5;
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
	} else if ( kind < 3.5 ) {
		// lens flare: camera-facing, a constant size on screen, a wide quad for
		// the streak, pulled a little toward the camera
		mv = viewMatrix * vec4( C, 1.0 );
		float s = aS1.x * max( -mv.z, 0.5 ) * 0.1;
		mv.xy += position.xy * vec2( 6.0, 1.5 ) * s;
		mv.z += min( 0.6, -mv.z * 0.2 );
		vUv = position.xy * vec2( 6.0, 1.5 ) * 2.0;
	} else {
		// lifestone aura: camera-facing round the crystal, pulled up to 1 m toward
		// the camera (its size on screen kept) so neither the claws nor the crystal
		// cut it with a hard edge
		mv = viewMatrix * vec4( C, 1.0 );
		float dz = max( -mv.z, 0.05 );
		float pull = min( 1.0, dz * 0.4 );
		mv.xy += position.xy * 2.0 * aS1.xy * ( ( dz - pull ) / dz );
		mv.z += pull;
		vUv = position.xy * 2.0;
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
uniform float uShowDeepHue;   // 1: the nebula base keeps the portal's hue (?portalFxLum); 0: the fixed violet base
uniform float uShowMotes;     // the lifestone aura's motes (live: __lifestoneFx.tune.motes)
varying vec2 vUv;
varying vec4 vCol;
varying vec4 vInfo;
varying vec4 vAux;
varying float vSoft;
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
		vec3 deep = vCol.rgb * ( 0.12 + 0.04 * uShowDeepHue ) + vec3( 0.02, 0.0, 0.05 ) * ( 1.0 - uShowDeepHue );
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
	} else if ( kind < 3.5 ) {
		// lens flare: a hot core, an anamorphic streak, a faint ghost ring (the
		// ring's offset is squared by hand: pow() of a negative base is undefined)
		vec2 q = vUv;
		float core = exp( -dot( q, q ) * 6.0 );
		float streak = exp( -abs( q.y ) * 10.0 ) * max( 1.0 - abs( q.x ) / 12.0, 0.0 );
		float k = ( length( q ) - 1.6 ) / 0.12;
		float ring = exp( -k * k ) * 0.25;
		c = vCol.rgb * ( core * 2.0 + streak * 0.9 + ring ) + vec3( core * 0.6 );
	} else {
		// lifestone aura (vfx/lifestone_fx.js): a soft halo round the crystal's
		// extent, breathing, its wisps drifting outward; motes leaving the crystal
		vec2 q = vUv;
		if ( q.y < 0.0 ) q.y *= 1.3;   // tighter below: it never reaches the ground
		float r = length( q );
		if ( r >= 1.0 ) discard;
		float ce = vAux.z;
		float inner = mix( 0.15, 1.0, smoothstep( 0.0, ce, r ) );
		float o = max( r - ce, 0.0 ) / max( 1.0 - ce, 0.05 );
		float halo = inner * exp( -o * o * 4.0 ) * ( 1.0 - smoothstep( 0.82, 1.0, r ) );
		vec2 dir = q / max( r, 1e-3 );
		float wisp = hbShowFbm( dir * 2.3 + vec2( r * 2.6 - t * 0.22, seed * 7.0 ) );
		halo *= 0.6 + 0.8 * wisp;
		// motes, in metres: soft specks drifting out of the crystal, each on its own clock
		vec2 qm = vUv * vAux.xy;
		float motes = 0.0;
		for ( int i = 0; i < 10; i++ ) {
			float fi = float( i );
			float h1 = hbShowHash( vec2( fi * 3.1 + 1.0, seed * 37.0 + 2.0 ) );
			float h2 = hbShowHash( vec2( fi * 1.7 + 5.0, seed * 19.0 + 9.0 ) );
			float ph = fract( t * ( 0.07 + 0.06 * h2 ) + h1 );
			float ang = 6.2831853 * h1 + 0.8 * sin( t * 0.23 + fi * 1.3 );
			vec2 mp = vec2( cos( ang ), sin( ang ) ) * vAux.xy * mix( ce * 0.85, 1.0, ph ) + vec2( 0.0, ph * 0.35 );
			vec2 dq = ( qm - mp ) / 0.045;
			float life = sin( 3.1415926 * ph );
			motes += exp( -dot( dq, dq ) ) * life * life * ( 0.6 + 0.4 * sin( t * 5.0 + fi * 2.7 ) );
		}
		motes *= uShowMotes;
		c = vCol.rgb * ( halo * 0.05 * vSoft * vAux.w + motes * 0.32 ) + vec3( motes * 0.08 );
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

const _uniforms = {
  uShowTime: { value: 0 }, uShowCal: { value: 1 }, uShowFlareInScene: { value: 1 },
  uShowDeepHue: { value: _portalFxLumOn ? 1 : 0 },
  uShowMotes: { value: 1 },
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
/** this frame's lifestone auras (lifestone_fx.lifestoneFxAuras) */
const _auraList = [];
let _flares = 0;
let _lastScan = -Infinity;
let _gain = 1;   // `window.__fxShowcase.gain` (live tuning)
const _stats = { portals: 0, lifestones: 0, auras: 0, bursts: 0, drawn: 0, scans: 0 };

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

function _scan(scene3d, now) {
  _stats.scans++;
  const seen = new Set();
  const map = scene3d?.entityManager?.entityMap;
  const lifestoneOn = lifestoneFxEnabled();
  if (map) {
    for (const inst of map.values()) {
      if (!inst || !inst.root || inst._disposed) continue;
      const odf = _odfOf(inst);
      const kind = (odf & ODF_PORTAL) ? "portal" : ((odf & ODF_LIFESTONE) ? "lifestone" : null);
      if (!kind) continue;
      try { inst.root.updateWorldMatrix(true, false); _root.setFromMatrixPosition(inst.root.matrixWorld); } catch (_) { continue; }
      const had = kind === "lifestone" && lifestoneOn && _pieces.has(inst);
      if (_root.distanceTo(_cam) > (had ? LIFESTONE_KEEP_M : RANGE_M)) continue;
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
        let light = null;
        if (sw) {
          p.centre.set(sw.x, sw.y, sw.z);
          p.radius = Math.min(3.5, Math.max(0.8, sw.radius * 0.95));
          light = sw.emitter && sw.emitter._fxLight ? sw.emitter._fxLight : fxEmitterLightNear(p.centre, 3);
        } else {
          p.centre.copy(_root); p.centre.y += 1.6;
          light = fxEmitterLightNear(p.centre, 3);
        }
        if (light) p.color = _colorOf(light, PORTAL_VIOLET);
        // `?portalFxLum`: the disc + ring at purple's luminance in the portal's
        // own colour. Only for a colour read off the swirl's light: the
        // fallback violet (tier-1 off) is the same on every portal already.
        p.k = _portalFxLumOn && light ? portalLumScale(p.color) : 1;
      } else {
        p.centre.copy(_root);
        // the stone's OWN emitter light (the 9 "new" stones, Setup 0x02000EAD,
        // carry one); the carrier lifestone_fx adds is not that
        const light = fxEmitterLightNear(_root.clone().setY(_root.y + 1.5), 3, isLifestoneLightCarrier);
        if (light) p.color = _colorOf(light, LIFESTONE_BLUE);
        // `?lifestoneFx`: the crystal, aura and light (vfx/lifestone_fx.js); no ring
        if (lifestoneOn) {
          lifestoneFxSync(inst, scene3d, now, p.color, !!light);
          if (p.ring) { releaseFxDecal(p.ring); p.ring = null; }
          continue;
        }
      }
      // the ground ring (a persistent mark): re-placed when it moved, recoloured
      const ringR = kind === "portal" ? p.radius * 1.05 : 1.6;
      const ringI = kind === "portal" ? 0.9 * (p.k ?? 1) : 0.75;
      if (!p.ring || p.ring.released || Math.hypot(p.ring.x - p.ground.x, p.ring.z - p.ground.z) > 0.3) {
        if (p.ring) releaseFxDecal(p.ring);
        p.ring = addFxDecal({ position: p.ground, kind: "ring", radius: ringR, height: 1.6, color: p.color,
          intensity: ringI });
      } else {
        p.ring.color[0] = p.color[0]; p.ring.color[1] = p.color[1]; p.ring.color[2] = p.color[2];
        p.ring.radius = ringR;
        p.ring.intensity = ringI;
      }
    }
  }
  for (const [inst, p] of _pieces) {
    if (!seen.has(inst)) {
      if (p.ring) releaseFxDecal(p.ring);
      if (p.kind === "lifestone") lifestoneFxRelease(inst);   // fades out, then reverts the crystal
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
    lifestoneFxReleaseAll();   // the crystals back to retail, the lights freed
    if (_mesh) _mesh.visible = false;
    return 0;
  }
  const lifestoneOn = lifestoneFxEnabled();
  if (!lifestoneOn) lifestoneFxReleaseAll();
  const cam = scene3d?.cameraSwitcher?.activeCamera || scene3d?.camera || null;
  if (cam) { try { cam.getWorldPosition(_cam); } catch (_) { /* keep the last */ } }
  if (now - _lastScan >= SCAN_MS || now < _lastScan) {
    _lastScan = now;
    _scan(scene3d, now);
  }
  // `?lifestoneFx`: levels, breath, the crystals' uniforms, the light — every frame
  const lsLive = lifestoneOn ? lifestoneFxTick(scene3d, now) : 0;
  if (lsLive) lifestoneFxAuras(_auraList);
  else _auraList.length = 0;
  const auras = _auraList;
  for (let i = _bursts.length - 1; i >= 0; i--) if (now - _bursts[i].t0 > 3200) _bursts.splice(i, 1);
  _stats.portals = 0;
  _stats.lifestones = 0;
  _stats.auras = 0;
  _stats.bursts = _bursts.length;
  if (_pieces.size === 0 && _bursts.length === 0 && auras.length === 0) {
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
  const put = (x, y, z, kind, r, h, fade, seed, col, inten, age, grow, a3z = 0, a3w = 0) => {
    if (n >= FX_SHOWCASE_MAX) return;
    const o = n * 4;
    A0[o] = x; A0[o + 1] = y; A0[o + 2] = z; A0[o + 3] = kind;
    A1[o] = r; A1[o + 1] = h; A1[o + 2] = fade; A1[o + 3] = seed;
    A2[o] = col[0]; A2[o + 1] = col[1]; A2[o + 2] = col[2]; A2[o + 3] = inten;
    A3[o] = age; A3[o + 1] = grow; A3[o + 2] = a3z; A3[o + 3] = a3w;
    n++;
  };
  for (const p of _pieces.values()) {
    const age = (now - p.t0) / 1000;
    const fadeIn = Math.min(1, age / 0.6);
    if (p.kind === "portal") {
      _stats.portals++;
      put(p.centre.x, p.centre.y, p.centre.z, FX_SHOWCASE_KIND.disc, p.radius * 0.85, 0, fadeIn, p.seed, p.color, 0.9 * (p.k ?? 1), age, 1);
    } else {
      _stats.lifestones++;
      // `?lifestoneFx=off`: the 2026-10-10 light shaft (the new look draws an aura below)
      if (!lifestoneOn) put(p.centre.x, p.centre.y, p.centre.z, FX_SHOWCASE_KIND.shaft, 1.1, 9.0, fadeIn, p.seed, p.color, 0.8, age, 1);
    }
  }
  // the lifestone auras: from lifestone_fx's states, so one fades out with its
  // crystal after it left the scan. aS1 = radii, fade (the level), seed;
  // aS3 = age, the crystal's edge (aura units), breath, the soft halo's share.
  for (const a of auras) {
    _stats.auras++;
    put(a.x, a.y, a.z, FX_SHOWCASE_KIND.aura, a.rx, a.ry, a.level, a.seed, a.color, 1, 0, a.ce, a.breath, a.soft);
  }
  if (auras.length) _uniforms.uShowMotes.value = auras[0].motes;
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
  _uniforms.uShowDeepHue.value = _portalFxLumOn ? 1 : 0;
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
  _auraList.length = 0;
  _flares = 0;
  _lastScan = -Infinity;
  _resetLifestoneFxForTest();
  if (_mesh) _mesh.visible = false;
}

if (typeof window !== "undefined") {
  window.__fxShowcase = {
    stats: fxShowcaseStats,
    get gain() { return _gain; },
    set gain(v) { if (Number.isFinite(+v)) _gain = Math.max(0, +v); },
  };
}
