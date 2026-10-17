// scene3d/vfx/lifestone_fx.js — the lifestone's glow (2026-10-11, `?lifestoneFx`,
// DEFAULT ON; `off` / `0` / `false` / `no` restores the 2026-10-10 lifestone:
// the light shaft and the ground ring).
//
// Owner, on the GTX 1070: "there is a light shaft coming from the lifestone or
// something, which is undesirable, instead add more of a glowing emanance and
// make the crystal look more lifelike."
//
// RETAIL (read 2026-10-11 from the base DATs and ace_world). The Holtburg stone
// is wcid 509 "Life Stone" (243 placements; 23618 / 24572 / 27096 are the rarer
// "new", Candeth Keep and Lugian stones). Setup 0x020002EE = three claws
// 0x01000D00 / D02 / D06 round the crystal 0x01000CFA, placed at (0, 0, 2): 31
// vertices, 58 one-sided facets, about 1.3 x 1.8 x 3.0 m, ONE surface
// 0x080011DE (Base1Image | Translucent, translucency 0.25, luminosity 0.75,
// texture 0x05002B92 -> 0x06005E03, a 256 x 256 DXT1 photograph of blue geode).
// MotionTable 0x09000026's Ready cycle plays Animation 0x03000568: 60 frames at
// 15 fps, part 3 turning 6 degrees a frame about Z, so the crystal spins once
// every 4 s (the rig plays it; nothing is added here). The Setup has NO default
// script and NO LightInfo, and the animation NO hooks: retail draws no particle
// and casts no light at a 509 stone, its glow is the 0.75 luminosity alone. So
// `fxEmitterLightNear` finds nothing there and the showcase colour is the
// fallback LIFESTONE_BLUE. (Setup 0x02000EAD, the 9 "new" stones, carries
// default script 0x33000D76; its emitter light is re-used when there is one.)
//
// WHAT IT DRAWS for every lifestone the fx_showcase scan finds within 60 m
// (under `?fxShowcase`, i.e. mid / high / ultra, and this flag):
//   CRYSTAL  its translucent surfaces get entity-OWNED materials
//            (MaterialCache.makeOwnedVariant, the weapon_fx pattern: CSM and the
//            light clamp re-installed, freed with the rig) carrying ONE
//            onBeforeCompile patch. One program for every lifestone: the key is
//            the patch SET, uniforms are bound by reference per lifestone and
//            per mesh.
//              - the retail luminous term is SHAPED, not replaced: deeper between
//                slowly writhing inner veins, brighter in them and in a "heart"
//                at the crystal's core, breathing; kept lit at night (?lumNight
//                dims the 0.75 luminosity to 25 % otherwise, but a lifestone is a
//                light source);
//              - the inner light lives in OBJECT space and is sampled along the
//                view ray refracted into the facet (quartz, n = 1.55) at two
//                depths: it turns with the crystal and shifts with the eye;
//              - a fresnel rim; facet glints against two view-fixed virtual
//                lights (flat facet normals from screen derivatives, so whole
//                facets flash as the crystal turns); polished roughness (0.32,
//                from the surface's ~0.9) so the sun and the torches leave real
//                highlights;
//              - glass alpha (clearer face-on, opaque at the rim and in a glint),
//                a touch of absorption on thick paths, a +-7 % violet / cyan drift.
//            Everything scales with uLsLevel. At 0 the patched program draws the
//            retail surface exactly, so the swap (made only once the program has
//            linked: bake_prewarm.prewarmSubtree) and the fade-in never pop.
//   AURA     fx_showcase kind 4, in the existing instanced billboard (no new
//            program): a soft breathing halo round the crystal's extent, wisps
//            drifting outward, ten motes leaving it. See fx_showcase.js.
//   LIGHT    one FX light CARRIER (vfx/fx_lights.js, the emitter-light duck type:
//            the pool's 16 slots are fixed, nothing is added to the scene) inside
//            the crystal, breathing with it. The claws catch it, and through
//            `terrainLights` the ground takes a soft pool (faint by day, painted
//            at night). The stone's own emitter light is used instead when it
//            has one.
//   GLOW     high / ultra (`?fxGlow`, with the glow pass running): the crystal
//            itself is drawn into the glow buffer (a glow extra, depth-occluded
//            there); the mip blur turns it into a halo that follows the real,
//            turning silhouette.
// The light shaft and its glitter are gone for lifestones (the level-up column
// keeps the shaft kind), and so is the hard ground ring: the crystal's light
// paints the ground now.
//
// CALIBRATION. The composer multiplies HDR by exposure 5 before the Neutral tone
// curve, and the crystal's own emission already sits on the curve's shoulder
// (mean texel x 0.75 x 5 = (0.29, 0.84, 2.6)): added light there whitens. Hence
// the SHAPING — between the veins the emission drops to ~0.66 x (a deeper,
// saturated blue: Neutral (0.14, 0.32, 0.93) for the mean texel), the heart and
// the veins reach ~1.6 x (pale but still blue: (0.45, 0.58, 0.99)). Added light
// passes uLsCal = 1 / exposure, so every gain reads in tone-mapper input units.
// The aura and motes pass the showcase's own calibration. By day the aura runs
// at 45 % and the light at 35 % of their night value (the night fraction the sky
// uses); the motes and the crystal do not change.
//
// LIVE TUNING: `window.__lifestoneFx.tune` (inner, rim, glint, roughness,
// shapeBase / shapeVein / shapeHeart / hueDrift, breathAmp / breathPeriod, aura /
// auraDay / motes, light / lightRange / lightDay, glow, nightKeep, fadeIn /
// fadeOut) is read every frame; `.stats()`, `.list()`, `.defaults`, `.reset()`.
//
// FIREWALL: reads static data (surfaces, mesh bounds), the rendered pose and the
// clock; writes owned-material uniforms, a light carrier's intensity and the
// billboard's attributes. No wire, no physics, no light count change, no
// per-instance program key.
//
// STUB-SAFE: several play_effect suites load this module (through
// fx_showcase.js) on a minimal three stub, so nothing three-shaped is built at
// module load, uniforms hold plain {x, y, z} objects (three's setters read .x),
// and materials.js / bake_prewarm.js are imported lazily (both are in the boot
// graph already, through entities.js: the import resolves from the module map).

import * as THREE from "three";
import { fxTier1Enabled } from "./fx_tier1.js";
import { fxNowMs } from "../fx_clock.js";
import { bindEmitterFxLight, releaseFxLight } from "./fx_lights.js";
import { registerFxGlowExtras } from "../particles_over_clouds.js";
import { nightFactorFromAuthoredPitch } from "../night_ramp.js";

// ---------------------------------------------------------------------------
// The flag
// ---------------------------------------------------------------------------

/**
 * `?lifestoneFx` — the new lifestone, DEFAULT ON. Absent or any other value
 * keeps it; `off` / `0` / `false` / `no` gives the 2026-10-10 lifestone back
 * (shaft + ring, the retail crystal). Pure given `search`.
 * @param {string} [search] test seam (else the page URL)
 */
export function readLifestoneFxFlag(search) {
  let on = true; // default-on; ?lifestoneFx=off is the escape
  try {
    const v = new URLSearchParams(typeof search === "string" ? search : (globalThis.location?.search || "")).get("lifestoneFx");
    if (v != null) { const s = v.trim().toLowerCase(); on = s !== "off" && s !== "0" && s !== "false" && s !== "no"; }
  } catch (_) {
    on = true;
  }
  return on;
}

let _flagMemo = null;
let _flagForced = null;
/** Is the new lifestone on? Read once per page load (test seam below). */
export function lifestoneFxEnabled() {
  if (_flagForced !== null) return _flagForced;
  if (_flagMemo === null) _flagMemo = readLifestoneFxFlag();
  return _flagMemo;
}
/** Test seam: force `?lifestoneFx` (null re-reads the URL). */
export function _setLifestoneFxForTest(on) {
  _flagForced = on == null ? null : !!on;
  _flagMemo = null;
}

// ---------------------------------------------------------------------------
// Tuning (live: window.__lifestoneFx.tune)
// ---------------------------------------------------------------------------

export const LIFESTONE_FX_DEFAULTS = Object.freeze({
  // crystal additions, tone-mapper input units (x uLsCal = 1 / exposure)
  inner: 0.3,          // the inner veins + heart
  rim: 0.55,           // fresnel rim
  glint: 1.6,          // facet glints
  roughness: 0.32,     // polished (the surface's own is ~0.9)
  // the retail luminous term, shaped: base + vein + heart (x breath)
  shapeBase: 0.66,
  shapeVein: 0.5,
  shapeHeart: 0.3,
  hueDrift: 0.8,       // 0..1 share of the +-7 % violet / cyan drift
  nightKeep: 1,        // 1: the crystal keeps its glow at night (undo ?lumNight's dim)
  breathAmp: 0.12,     // +-12 %
  breathPeriod: 5.2,   // s
  // aura (fx_showcase kind 4) and its motes
  aura: 1,
  auraDay: 0.45,       // the aura's day share of its night value
  motes: 1,
  // the light carrier (DAT-light units, like the emitter lights; range m)
  light: 3,
  lightRange: 4.5,
  lightDay: 0.35,      // the light's day share of its night value
  // high / ultra: the crystal in the glow buffer
  glow: 1,
  // level ramps (s)
  fadeIn: 1.4,
  fadeOut: 0.8,
});
const _tune = { ...LIFESTONE_FX_DEFAULTS };

/** The aura's margin round the crystal (m) — fx_showcase sizes the billboard with it. */
export const LIFESTONE_AURA_MARGIN_M = 0.8;
/** Fallback crystal extent when no crystal mesh is found (Setup 0x020002EE's). */
const FALLBACK_CENTRE_Y = 2.1;
const FALLBACK_HW = 0.9;
const FALLBACK_HH = 1.5;

// ---------------------------------------------------------------------------
// GLSL — no backticks; no pow() (every power is a product of a clamped base)
// ---------------------------------------------------------------------------

export const LS_SET_KEY = "emissive.lifestoneCrystal";
export const LS_MARKER = "// ==== lifestone crystal (vfx/lifestone_fx.js) ====";
const SEAM_COMMON = "#include <common>";
const SEAM_PROJECT = "#include <project_vertex>";
const SEAM_EMISSIVE = "#include <emissivemap_fragment>";
const SEAM_ROUGH = "#include <roughnessmap_fragment>";

const LS_VERT_DECLS = /* glsl */ `
// lifestone crystal (vfx/lifestone_fx.js)
varying vec3 vHbLsObj;
varying vec3 vHbLsNrm;
varying vec3 vHbLsEye;
`;

// after project_vertex: the object-space position / normal and the object-space
// eye (the inverse model-view keeps every number small: no absolute world
// coordinates, which round to millimetres past 32 km)
const LS_VERT_BODY = /* glsl */ `
	// lifestone crystal (vfx/lifestone_fx.js)
	vHbLsObj = transformed;
	vHbLsNrm = objectNormal;
	vHbLsEye = ( inverse( modelViewMatrix ) * vec4( 0.0, 0.0, 0.0, 1.0 ) ).xyz;
`;

const LS_FRAG_DECLS = /* glsl */ `
// lifestone crystal (vfx/lifestone_fx.js)
varying vec3 vHbLsObj;
varying vec3 vHbLsNrm;
varying vec3 vHbLsEye;
uniform float uLsLevel;     // 0: the retail surface exactly .. 1: the full look
uniform float uLsBreath;    // ~0.88 .. 1.12
uniform float uLsSeed;
uniform float uLsLumBoost;  // undoes ?lumNight's night dim (a light source)
uniform vec3 uLsColor;      // the lifestone's colour, max channel 1
uniform vec3 uLsCore;       // the mesh's bounds centre (object space)
uniform vec3 uLsHalf;       // and half-extents
uniform float uLsCal;       // 1 / exposure: gains read in tone-mapper units
uniform vec4 uLsGain;       // inner, rim, glint, roughness
uniform vec4 uLsShape;      // base, vein, heart, hue drift
float hbLsHash3( vec3 p ) {
	p = fract( p * 0.1031 );
	p += dot( p, p.zyx + 31.32 );
	return fract( ( p.x + p.y ) * p.z );
}
// thin, slowly writhing sheets of light: the zero set of a warped sine field
float hbLsVeins( vec3 p, float t ) {
	vec3 q = p * 2.2;
	q += 0.6 * sin( q.yzx * 1.3 + vec3( 0.0, 2.1, 4.2 ) + t * vec3( 0.9, 0.7, 0.8 ) );
	q += 0.3 * sin( q.zxy * 2.1 + vec3( 1.7, 0.3, 3.3 ) - t * vec3( 0.6, 0.8, 0.5 ) );
	float f = sin( q.x ) * sin( q.y ) * sin( q.z );
	float b = 1.0 - smoothstep( 0.0, 0.22, abs( f ) );
	return b * b;
}
`;

const LS_FRAG_BODY = /* glsl */ `
	${LS_MARKER}
	if ( uLsLevel > 0.0 ) {
		float lsL = min( uLsLevel, 1.0 );
		// object space: the crystal turns with its part, its inner light with it
		vec3 lsV = normalize( vHbLsObj - vHbLsEye );
		vec3 lsNf = cross( dFdx( vHbLsObj ), dFdy( vHbLsObj ) );
		float lsNfl = length( lsNf );
		vec3 lsNs = vHbLsNrm;
		float lsNsl = length( lsNs );
		lsNs = lsNsl > 1e-6 ? lsNs / lsNsl : ( lsNfl > 1e-12 ? lsNf / lsNfl : -lsV );
		lsNf = lsNfl > 1e-12 ? lsNf / lsNfl : lsNs;
		if ( dot( lsNs, lsV ) > 0.0 ) lsNs = -lsNs;
		if ( dot( lsNf, lsV ) > 0.0 ) lsNf = -lsNf;
		float lsNdv = clamp( -dot( lsNs, lsV ), 0.0, 1.0 );
		float lsFr = 1.0 - lsNdv;
		float lsFr2 = lsFr * lsFr;
		float lsFres = lsFr2 * lsFr2 * lsFr;
		// the view ray refracted into the facet (quartz, n 1.55): the inner light is
		// sampled along it at two depths, so it shifts with the eye (parallax)
		vec3 lsHalf = max( uLsHalf, vec3( 0.05 ) );
		vec3 lsP = ( vHbLsObj - uLsCore ) / lsHalf;
		vec3 lsR = refract( lsV, lsNf, 0.645 );
		if ( dot( lsR, lsR ) < 1e-6 ) lsR = lsV;
		vec3 lsRd = lsR / lsHalf;
		float lsT = uTime;
		float lsVein = 0.65 * hbLsVeins( lsP + lsRd * 0.22, lsT * 0.31 + uLsSeed * 11.0 )
			+ 0.35 * hbLsVeins( ( lsP + lsRd * 0.55 ) * 0.7 + 3.7, lsT * 0.19 + uLsSeed * 7.0 );
		// a heart of light: brightest where the refracted ray passes the core
		float lsRdl = length( lsRd );
		vec3 lsRn = lsRdl > 1e-6 ? lsRd / lsRdl : vec3( 0.0, 0.0, 1.0 );
		float lsAlong = max( dot( -lsP, lsRn ), 0.0 );
		vec3 lsOff = -lsP - lsRn * lsAlong;
		float lsHeart = exp( -dot( lsOff, lsOff ) * 3.5 );
		// facet glints against two virtual lights fixed to the VIEW (so facets
		// flash as the crystal turns, from wherever it is watched)
		vec3 lsNv = cross( dFdx( vViewPosition ), dFdy( vViewPosition ) );
		float lsNvl = length( lsNv );
		lsNv = lsNvl > 1e-12 ? lsNv / lsNvl : vec3( 0.0, 0.0, 1.0 );
		if ( dot( lsNv, vViewPosition ) < 0.0 ) lsNv = -lsNv;
		vec3 lsRv = reflect( -normalize( vViewPosition ), lsNv );
		float lsG1 = max( dot( lsRv, vec3( 0.4243, 0.7880, 0.4466 ) ), 0.0 );
		float lsG2 = max( dot( lsRv, vec3( -0.6390, 0.3651, 0.6771 ) ), 0.0 );
		lsG1 *= lsG1; lsG1 *= lsG1; lsG1 *= lsG1; lsG1 *= lsG1; lsG1 *= lsG1;
		lsG2 *= lsG2; lsG2 *= lsG2; lsG2 *= lsG2; lsG2 *= lsG2; lsG2 *= lsG2;
		float lsFacet = hbLsHash3( floor( lsNf * 4.0 + 4.5 ) + uLsSeed * 13.0 );
		float lsGlint = ( lsG1 + 0.7 * lsG2 ) * ( 0.55 + 0.45 * sin( lsT * 2.3 + lsFacet * 37.0 ) );
		// colours: the retail texel's hue (kept) and a paler light of it
		vec3 lsTex = diffuseColor.rgb;
		float lsTm = max( max( lsTex.r, lsTex.g ), max( lsTex.b, 1e-4 ) );
		vec3 lsHue = mix( uLsColor, lsTex / lsTm, 0.6 );
		vec3 lsPale = mix( lsHue, vec3( 1.0 ), 0.45 );
		float lsTint = 0.5 + 0.5 * sin( dot( lsP, vec3( 1.7, 1.1, 0.9 ) ) + lsT * 0.13 + uLsSeed * 6.2831853 );
		vec3 lsTintC = mix( vec3( 1.07, 0.94, 1.0 ), vec3( 0.9, 1.05, 1.02 ), lsTint );
		// the retail luminous term SHAPED: deeper between the veins, brighter in them
		// and in the heart, breathing, kept lit at night
		float lsShape = ( uLsShape.x + uLsShape.y * lsVein + uLsShape.z * lsHeart ) * uLsBreath * uLsLumBoost;
		totalEmissiveRadiance *= mix( vec3( 1.0 ), lsShape * mix( vec3( 1.0 ), lsTintC, uLsShape.w ), lsL );
		vec3 lsAdd = lsPale * ( uLsGain.x * ( lsVein * ( 0.35 + 0.65 * lsNdv ) + 0.6 * lsHeart * uLsBreath ) + uLsGain.y * lsFres )
			+ mix( lsPale, vec3( 1.0 ), 0.5 ) * ( uLsGain.z * lsGlint );
		totalEmissiveRadiance += lsAdd * ( uLsCal * lsL );
		// glass: clearer face-on, more opaque at the rim and in a glint
		float lsA = clamp( diffuseColor.a * ( 0.9 + 0.1 * lsFr ) + 0.3 * lsFres + 0.5 * lsGlint, 0.0, 1.0 );
		diffuseColor.a = mix( diffuseColor.a, lsA, lsL );
		// absorption: a thick (face-on) path saturates the lit body
		diffuseColor.rgb *= mix( vec3( 1.0 ), vec3( 0.78, 0.86, 1.0 ), lsNdv * 0.7 * lsL );
		// polished: the sun and the torches leave real highlights on the facets
		roughnessFactor = mix( roughnessFactor, uLsGain.w, lsL );
	}
`;

/** The crystal's GLSL (tests). */
export const LIFESTONE_CRYSTAL_GLSL = Object.freeze({
  vertexDecls: LS_VERT_DECLS,
  vertexBody: LS_VERT_BODY,
  fragmentDecls: LS_FRAG_DECLS,
  fragmentBody: LS_FRAG_BODY,
});

// Shared uniforms (every crystal binds these objects by reference).
const _shared = {
  uLsCal: { value: 0.2 },
  uLsGain: { value: { x: _tune.inner, y: _tune.rim, z: _tune.glint, w: _tune.roughness } },
  uLsShape: { value: { x: _tune.shapeBase, y: _tune.shapeVein, z: _tune.shapeHeart, w: _tune.hueDrift } },
};

function _inertState() {
  return {
    uLsLevel: { value: 0 }, uLsBreath: { value: 1 }, uLsSeed: { value: 0 }, uLsLumBoost: { value: 1 },
    uLsColor: { value: { x: 0.55, y: 0.78, z: 1 } },
  };
}
function _inertMesh() {
  return { uLsCore: { value: { x: 0, y: 0, z: 0 } }, uLsHalf: { value: { x: 0.5, y: 0.5, z: 0.5 } } };
}

/**
 * The crystal patch, in the VFX component shape (installed through
 * materials.installVfxComponentPatch, which keys the program on the SET). It is
 * NOT registered in the descriptor catalog: only lifestone_fx installs it, on the
 * owned crystal variants. It keeps the component contract (registry.js
 * validateComponent passes): deterministic, no light count change, set-scoped key.
 */
export const LIFESTONE_CRYSTAL_PATCH = Object.freeze({
  id: LS_SET_KEY,
  family: "emissive",
  mech: "frag",
  channel: "aura",
  linkVariant() { return ""; },
  cacheKeyScope: "set",
  deterministic: true,
  lightCountDelta: 0,
  enabled: () => lifestoneFxEnabled(),
  reads: ["surface", "geometry", "clock"],
  writes: ["materialUniform"],
  defaults: {},

  /**
   * Bind the uniforms BY REFERENCE: the lifestone's (`globals.ls`), the mesh's
   * (`globals.lsMesh`), the shared ones and the VFX clock.
   */
  declareUniforms(shader, _config, globals) {
    const g = globals || {};
    const s = g.ls || _inertState();
    const m = g.lsMesh || _inertMesh();
    const sh = g.lsShared || _shared;
    shader.uniforms = shader.uniforms || {};
    shader.uniforms.uTime = g.uTime || shader.uniforms.uTime || { value: 0 };
    for (const k of ["uLsLevel", "uLsBreath", "uLsSeed", "uLsLumBoost", "uLsColor"]) shader.uniforms[k] = s[k];
    for (const k of ["uLsCore", "uLsHalf"]) shader.uniforms[k] = m[k];
    for (const k of ["uLsCal", "uLsGain", "uLsShape"]) shader.uniforms[k] = sh[k];
  },

  /**
   * Splice the GLSL. Idempotent; inert on a material without the PBR seams
   * (only MeshStandard / MeshPhysical carry roughnessFactor).
   */
  inject(shader) {
    let vs = shader.vertexShader || "";
    let fs = shader.fragmentShader || "";
    if (fs.indexOf(LS_MARKER) !== -1) return;
    if (fs.indexOf(SEAM_EMISSIVE) === -1 || fs.indexOf(SEAM_ROUGH) === -1 || fs.indexOf(SEAM_COMMON) === -1) return;
    if (vs.indexOf(SEAM_PROJECT) === -1 || vs.indexOf(SEAM_COMMON) === -1) return;
    vs = vs.replace(SEAM_COMMON, SEAM_COMMON + "\n" + LS_VERT_DECLS);
    vs = vs.replace(SEAM_PROJECT, SEAM_PROJECT + "\n" + LS_VERT_BODY);
    const decls = (fs.indexOf("uniform float uTime;") === -1 ? "uniform float uTime;\n" : "") + LS_FRAG_DECLS;
    fs = fs.replace(SEAM_COMMON, SEAM_COMMON + "\n" + decls);
    fs = fs.replace(SEAM_EMISSIVE, SEAM_EMISSIVE + "\n" + LS_FRAG_BODY);
    shader.vertexShader = vs;
    shader.fragmentShader = fs;
  },
});

// The high / ultra glow extra: the crystal drawn into the glow buffer, occluded
// by hand against the scene depth (the buffer has no depth attachment).
const GLOW_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec3 vLgN;
varying vec3 vLgV;
varying float vLgDepth;
void main() {
	vec4 mv = modelViewMatrix * vec4( position, 1.0 );
	vLgN = normalMatrix * normal;
	vLgV = -mv.xyz;
	vLgDepth = -mv.z;
	gl_Position = projectionMatrix * mv;
	#include <logdepthbuf_vertex>
}
`;

const GLOW_FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform vec3 uLgColor;
uniform highp sampler2D uGlowDepth;
uniform vec2 uGlowRes;
uniform float uGlowLogFar;
uniform float uGlowIsLog;
uniform vec2 uGlowNearFar;
uniform float uGlowScale;
varying vec3 vLgN;
varying vec3 vLgV;
varying float vLgDepth;
void main() {
	#include <logdepthbuf_fragment>
	float nl = length( vLgN );
	float vl = length( vLgV );
	float ndv = ( nl > 1e-6 && vl > 1e-6 ) ? abs( dot( vLgN / nl, vLgV / vl ) ) : 1.0;
	vec3 c = uLgColor * ( 0.6 + 0.4 * ndv );
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
	c *= clamp( 1.0 - ( vLgDepth - gw ) * 2.0, 0.0, 1.0 ) * uGlowScale;
	gl_FragColor = vec4( c, 1.0 );
}
`;

/** The glow-extra GLSL (tests). */
export const LIFESTONE_GLOW_GLSL = Object.freeze({ vertex: GLOW_VERT, fragment: GLOW_FRAG });

const _glowFrame = {
  uGlowDepth: { value: null },
  uGlowRes: { value: { x: 1, y: 1 } },
  uGlowLogFar: { value: 1 },
  uGlowIsLog: { value: 1 },
  uGlowNearFar: { value: { x: 0.1, y: 1000 } },
  uGlowScale: { value: 1 },
};

// ---------------------------------------------------------------------------
// Lazy modules (stub-safe: see the header)
// ---------------------------------------------------------------------------

let _M = null;
let _Mp = null;
function _materialsModule() {
  if (_M) return _M;
  if (!_Mp) {
    _Mp = import("../materials.js").then((m) => { _M = m; return m; }, () => { _Mp = null; return null; });
  }
  return null;
}
let _BP = null;
let _BPp = null;
function _prewarmModule() {
  if (_BP) return Promise.resolve(_BP);
  if (!_BPp) {
    _BPp = import("../bake_prewarm.js").then((m) => { _BP = m; return m; }, () => { _BPp = null; return null; });
  }
  return _BPp;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** inst → lifestone state */
const _states = new Map();
let _seq = 0;
let _lastTick = -1;
const _stats = { swaps: 0, rebuilds: 0, reverts: 0, warmFails: 0 };

function _now() {
  return fxNowMs(); // the film clock during a stepped take (fx_clock.js), else performance.now()
}

/** Pure: a stable 0..1 seed per guid (no Math.random: the look is the same every visit). */
export function lifestoneSeed(guid) {
  let h = (guid >>> 0) ^ 0x9e3779b9;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Pure: the breathing multiplier at `tSec` (1 +- amp, period s, phase rad). */
export function lifestoneBreath(tSec, amp = _tune.breathAmp, period = _tune.breathPeriod, phase = 0) {
  const p = Math.max(0.5, Number.isFinite(period) ? period : 5.2);
  const a = Math.max(0, Math.min(0.5, Number.isFinite(amp) ? amp : 0));
  return 1 + a * Math.sin((2 * Math.PI * tSec) / p + phase);
}

/** Pure: a day-share term — `day` by day, 1 at night (`night` 0..1). */
export function lifestoneDayNight(night, day) {
  const n = Math.min(1, Math.max(0, Number.isFinite(night) ? night : 0));
  const d = Math.min(1, Math.max(0, Number.isFinite(day) ? day : 1));
  return d + (1 - d) * n;
}

function _newState(inst, now) {
  const seed = lifestoneSeed(inst.guid >>> 0);
  const u = _inertState();
  u.uLsSeed.value = seed;
  return {
    id: ++_seq,
    inst,
    guid: inst.guid >>> 0,
    seed,
    phase: seed * Math.PI * 2,
    t0: now,
    level: 0,
    dying: false,
    dead: false,
    breath: 1,
    night: 0,
    auraSoft: 1,
    u,
    recs: new Map(),       // mesh → { mesh, base, mat, u, snap, pending, swapped }
    warming: 0,
    centre: { x: 0, y: 0, z: 0 },
    hw: FALLBACK_HW,
    hh: FALLBACK_HH,
    crystalFound: false,
    color: [0.55, 0.78, 1.0],
    light: null,
    lightOurs: false,
    realLight: false,
    glowMat: null,
  };
}

/** A crystal surface: translucent (alpha-blended, 0 < opacity < 1), textured, PBR. */
export function lifestoneCrystalMaterial(m) {
  if (!m || Array.isArray(m)) return false;
  if (m.userData && m.userData.__lsCrystal) return true;
  return m.isMeshStandardMaterial === true && m.transparent === true && m.blending === 1 &&
    !!m.map && m.opacity > 0.02 && m.opacity < 0.999;
}

function _meshesOf(inst, out) {
  out.length = 0;
  const parts = inst && inst.parts;
  if (!Array.isArray(parts)) return out;
  for (const part of parts) {
    const kids = part && part.children;
    if (!kids) continue;
    for (let i = 0; i < kids.length; i++) {
      const m = kids[i];
      if (!m || !m.isMesh) continue;
      if (m.userData && m.userData.__attachedChildOf != null) continue;
      out.push(m);
    }
  }
  return out;
}

// ---- bounds (world, THREE frame: Y up) -------------------------------------

const _mw = [];
function _refreshBounds(st, crystalMeshes) {
  const inst = st.inst;
  let rx = 0, rz = 0, ry = 0;
  try {
    inst.root.updateWorldMatrix(true, false);
    const e = inst.root.matrixWorld.elements;
    rx = e[12]; ry = e[13]; rz = e[14];
  } catch (_) { /* keep the last */ }
  if (!crystalMeshes.length) {
    st.crystalFound = false;
    st.centre.x = rx; st.centre.y = ry + FALLBACK_CENTRE_Y; st.centre.z = rz;
    st.hw = FALLBACK_HW; st.hh = FALLBACK_HH;
    return;
  }
  // the crystal turns about its part's vertical axis: centre the aura on the
  // axes (the part origins), size it by the farthest vertex from the axis —
  // both stay put while it turns
  let ax = 0, az = 0, n = 0;
  let minY = Infinity, maxY = -Infinity;
  for (const mesh of crystalMeshes) {
    try { mesh.updateWorldMatrix(true, false); } catch (_) { continue; }
    const e = mesh.matrixWorld.elements;
    ax += e[12]; az += e[14]; n++;
  }
  if (!n) return;
  ax /= n; az /= n;
  let hw = 0;
  for (const mesh of crystalMeshes) {
    const pos = mesh.geometry && mesh.geometry.getAttribute ? mesh.geometry.getAttribute("position") : null;
    if (!pos || !pos.count || typeof pos.getX !== "function") continue;
    const e = mesh.matrixWorld.elements;
    for (let i = 0; i < 16; i++) _mw[i] = e[i];
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      const wx = _mw[0] * x + _mw[4] * y + _mw[8] * z + _mw[12];
      const wy = _mw[1] * x + _mw[5] * y + _mw[9] * z + _mw[13];
      const wz = _mw[2] * x + _mw[6] * y + _mw[10] * z + _mw[14];
      if (wy < minY) minY = wy;
      if (wy > maxY) maxY = wy;
      const d = Math.hypot(wx - ax, wz - az);
      if (d > hw) hw = d;
    }
  }
  if (!(maxY > minY) || !(hw > 0)) return;
  st.crystalFound = true;
  st.centre.x = ax; st.centre.y = (minY + maxY) * 0.5; st.centre.z = az;
  st.hw = Math.min(4, Math.max(0.2, hw));
  st.hh = Math.min(4, Math.max(0.2, (maxY - minY) * 0.5));
}

// ---- owned crystal materials -----------------------------------------------

function _snap(base, fields) {
  const s = {};
  for (const k of fields) s[k] = base[k];
  const c = base.color, e = base.emissive;
  s.cr = c ? c.r : 0; s.cg = c ? c.g : 0; s.cb = c ? c.b : 0;
  s.er = e ? e.r : 0; s.eg = e ? e.g : 0; s.eb = e ? e.b : 0;
  return s;
}

const _PROGRAM_FIELDS = new Set([
  "map", "normalMap", "emissiveMap", "roughnessMap", "aoMap",
  "transparent", "alphaTest", "blending", "fog", "forceSinglePass",
]);

/** Mirror in-place base-material changes (a late texture, a fade, a re-seat) onto the variant. */
function _syncRec(rec) {
  const M = _M;
  if (!M || !rec.mat || !rec.base) return;
  const b = rec.base, m = rec.mat, s = rec.snap;
  let prog = false;
  for (const k of M.MATERIAL_SURFACE_FIELDS) {
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

function _buildRec(st, mesh, base, mc) {
  const M = _M;
  if (!M || !mc || typeof mc.makeOwnedVariant !== "function" || mc.wireframeMode) return null;
  const geo = mesh.geometry;
  const u = _inertMesh();
  try { if (geo && !geo.boundingBox && typeof geo.computeBoundingBox === "function") geo.computeBoundingBox(); } catch (_) { /* inert bounds */ }
  const bb = geo && geo.boundingBox;
  if (bb && Number.isFinite(bb.min.x) && Number.isFinite(bb.max.x)) {
    u.uLsCore.value = { x: (bb.min.x + bb.max.x) / 2, y: (bb.min.y + bb.max.y) / 2, z: (bb.min.z + bb.max.z) / 2 };
    u.uLsHalf.value = {
      x: Math.max(0.05, (bb.max.x - bb.min.x) / 2),
      y: Math.max(0.05, (bb.max.y - bb.min.y) / 2),
      z: Math.max(0.05, (bb.max.z - bb.min.z) / 2),
    };
  }
  const globals = { uTime: M.VFX_GLOBALS ? M.VFX_GLOBALS.uTime : undefined, ls: st.u, lsMesh: u, lsShared: _shared };
  let mat = null;
  try {
    mat = mc.makeOwnedVariant(base, LS_SET_KEY, (m) => M.installVfxComponentPatch(m, LIFESTONE_CRYSTAL_PATCH, {}, globals));
  } catch (_) { mat = null; }
  if (!mat) return null;
  mat.userData.__lsCrystal = st.id;
  mat.name = (base.name || "surface") + "+lifestone";
  return { mesh, base, mat, u, snap: _snap(base, M.MATERIAL_SURFACE_FIELDS), pending: true, swapped: false };
}

function _disposeMat(m) {
  if (!m) return;
  try { m.dispose(); } catch (_) { /* already freed */ }
}

function _glowMaterial(st) {
  if (st.glowMat) return st.glowMat;
  if (typeof THREE.ShaderMaterial !== "function") return null;
  const m = new THREE.ShaderMaterial({
    name: "lifestone-crystal-glow",
    uniforms: { ..._glowFrame, uLgColor: { value: { x: 0, y: 0, z: 0 } } },
    vertexShader: GLOW_VERT,
    fragmentShader: GLOW_FRAG,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: false,
    side: THREE.DoubleSide,
    fog: false,
  });
  m.userData = { __lsGlow: st.id };
  st.glowMat = m;
  return m;
}

function _glowRunning() {
  return fxTier1Enabled("fxGlow") && !!(globalThis.window && globalThis.window.__fxGlow && globalThis.window.__fxGlow.effect);
}

/** Compile the new variants off the frame (the link guard would hide the crystal while it links), then swap. */
async function _warmAndSwap(st, recs, scene3d) {
  st.warming++;
  try {
    const bp = await _prewarmModule();
    if (bp && typeof bp.prewarmSubtree === "function" && typeof THREE.Group === "function") {
      const g = new THREE.Group();
      for (const rec of recs) {
        const p = new THREE.Mesh(rec.mesh.geometry, rec.mat);
        p.castShadow = !!rec.mesh.castShadow;
        p.receiveShadow = !!rec.mesh.receiveShadow;
        g.add(p);
        if (fxTier1Enabled("fxGlow")) {
          const gm = _glowMaterial(st);
          if (gm) g.add(new THREE.Mesh(rec.mesh.geometry, gm));
        }
      }
      await bp.prewarmSubtree(scene3d, g);
      g.clear();
    }
  } catch (_) {
    _stats.warmFails++;   // three links it on first draw (the async link guard defers that draw)
  }
  st.warming--;
  for (const rec of recs) {
    rec.pending = false;
    if (st.dead || st.inst._disposed || st.recs.get(rec.mesh) !== rec) {
      _disposeMat(rec.mat);
      continue;
    }
    if (rec.mesh.material === rec.base) {
      rec.mesh.material = rec.mat;
      rec.swapped = true;
      _stats.swaps++;
    } else {
      // the mesh moved on meanwhile (a fade clone, a recolour): the next scan rebuilds
      _disposeMat(rec.mat);
      st.recs.delete(rec.mesh);
    }
  }
}

const _meshTmp = [];
const _crystalTmp = [];
/** Find the crystal meshes, build + warm + swap their variants, re-seat after a re-point. */
function _discover(st, scene3d) {
  const inst = st.inst;
  _meshesOf(inst, _meshTmp);
  _crystalTmp.length = 0;
  for (const mesh of _meshTmp) if (lifestoneCrystalMaterial(mesh.material)) _crystalTmp.push(mesh);
  _refreshBounds(st, _crystalTmp);
  if (!_crystalTmp.length) return;
  const M = _materialsModule();
  if (!M) return;   // the module resolves within a frame; the next scan builds
  const mc = scene3d?.entityManager?.materialCache || globalThis.window?.liveScene3d?.entityManager?.materialCache || null;
  const fresh = [];
  for (const mesh of _crystalTmp) {
    let rec = st.recs.get(mesh);
    if (rec) {
      if (rec.pending) continue;
      if (mesh.material === rec.mat) continue;
      if (mesh.material === rec.base) {   // swapped back by someone: re-seat ours
        mesh.material = rec.mat;
        rec.swapped = true;
        continue;
      }
      // re-pointed to a new material (a camera-fade clone, a recolour heal): rebuild on it
      if (rec.swapped && mesh.material !== rec.mat) _disposeMat(rec.mat);
      st.recs.delete(mesh);
      rec = null;
      _stats.rebuilds++;
    }
    if (mesh.material && mesh.material.userData && mesh.material.userData.__lsCrystal) continue;   // someone else's
    const made = _buildRec(st, mesh, mesh.material, mc);
    if (!made) continue;
    st.recs.set(mesh, made);
    fresh.push(made);
  }
  if (fresh.length) _warmAndSwap(st, fresh, scene3d);
}

// ---- the light carrier -----------------------------------------------------

/** True for the light carriers this module adds (fx_showcase skips them when it looks for a stone's own light). */
export function isLifestoneLightCarrier(s) {
  return !!(s && s.userData && s.userData.__lifestoneCarrier);
}

function _lightPos(st, out) {
  const inst = st.inst;
  if (st.dead || !inst || inst._disposed || !inst.root) return false;
  out.set(st.centre.x, st.centre.y - 0.35 * st.hh, st.centre.z);
  return Number.isFinite(out.x) && Number.isFinite(out.y) && Number.isFinite(out.z);
}

function _releaseLight(st) {
  if (st.light && st.lightOurs) { try { releaseFxLight(st.light); } catch (_) { /* gone */ } }
  st.light = null;
  st.lightOurs = false;
}

function _ensureLight(st, hasRealLight) {
  st.realLight = !!hasRealLight;
  if (hasRealLight) { _releaseLight(st); return; }
  if (st.light && !st.light.released) return;
  st.light = null;
  const pseudo = { numParticles: 1, parent: st.inst.root, isLifestoneLight: true };
  let s = null;
  try {
    s = bindEmitterFxLight({
      emitter: pseudo,
      resolvePosition: (out) => _lightPos(st, out),
      intensity: 0.001,
      range: Math.max(0.5, Math.min(14, _tune.lightRange)),
      color: st.color,
      pulse: 0,
    });
  } catch (_) { s = null; }
  if (!s) return;   // `?fxLights` off: the crystal and the aura still glow
  s.userData.__lifestoneCarrier = true;
  s.name = "lifestone-light";
  st.light = s;
  st.lightOurs = true;
}

// ---- drop / revert ---------------------------------------------------------

function _drop(st, revert) {
  st.dead = true;
  _releaseLight(st);
  const alive = !!(st.inst && !st.inst._disposed);
  for (const rec of st.recs.values()) {
    if (rec.pending) continue;   // _warmAndSwap disposes it when it resolves
    if (rec.swapped && rec.mesh.material === rec.mat) {
      if (revert && alive) {
        rec.mesh.material = rec.base;
        _disposeMat(rec.mat);
        _stats.reverts++;
      }
      // a disposed entity already freed it (owned variants are `__disposable`)
    } else {
      _disposeMat(rec.mat);
    }
  }
  st.recs.clear();
  if (st.glowMat) { _disposeMat(st.glowMat); st.glowMat = null; }
  _states.delete(st.inst);
}

// ---------------------------------------------------------------------------
// API for fx_showcase.js
// ---------------------------------------------------------------------------

/**
 * The 2 Hz scan (fx_showcase) found this lifestone in range: create / refresh
 * its state (bounds, crystal materials, light). `color` is its showcase colour
 * (its own light's, else LIFESTONE_BLUE); `hasRealLight` — the stone carries an
 * emitter light of its own (then no carrier is added). Returns the state, or
 * null when the feature is off.
 */
export function lifestoneFxSync(inst, scene3d, nowMs, color, hasRealLight) {
  if (!lifestoneFxEnabled() || !inst || !inst.root || inst._disposed) return null;
  const now = Number.isFinite(nowMs) ? nowMs : _now();
  let st = _states.get(inst);
  if (!st || st.dead) {
    st = _newState(inst, now);
    _states.set(inst, st);
  }
  st.dying = false;
  if (Array.isArray(color) && color.length === 3 && color.every(Number.isFinite)) {
    st.color[0] = color[0]; st.color[1] = color[1]; st.color[2] = color[2];
  }
  _discover(st, scene3d);
  _ensureLight(st, hasRealLight);
  return st;
}

/** The lifestone left the scan (out of range): fade out, then revert. Idempotent. */
export function lifestoneFxRelease(inst) {
  const st = _states.get(inst);
  if (st) st.dying = true;
}

/** Drop every lifestone now (the showcase turned off): revert the crystals, free the lights. */
export function lifestoneFxReleaseAll() {
  for (const st of [..._states.values()]) _drop(st, true);
}

/**
 * The aura's billboard terms for a state (fx_showcase writes them into the
 * instance attributes): THREE-world centre, radii (m), the crystal's edge in
 * aura units, breath, the soft-glow share, the motes share, the level, seed.
 */
export function lifestoneFxAura(st, out = {}) {
  const m = LIFESTONE_AURA_MARGIN_M;
  const rx = st.hw + m;
  const ry = st.hh + m;
  out.x = st.centre.x; out.y = st.centre.y; out.z = st.centre.z;
  out.rx = rx;
  out.ry = ry;
  out.ce = Math.min(0.85, Math.max(0.2, 0.5 * (st.hw / rx + st.hh / ry)));
  out.breath = st.breath;
  out.soft = st.auraSoft;
  out.motes = Math.max(0, _tune.motes);
  out.level = st.level;
  out.seed = st.seed;
  out.color = st.color;
  return out;
}

const _auraPool = [];
/**
 * This frame's auras, one per live lifestone whose level is above zero (fading
 * ones included). Fills and returns `out` (entries are reused objects).
 */
export function lifestoneFxAuras(out = []) {
  out.length = 0;
  let i = 0;
  for (const st of _states.values()) {
    if (st.dead || !(st.level > 0)) continue;
    const a = _auraPool[i] || (_auraPool[i] = {});
    out.push(lifestoneFxAura(st, a));
    i++;
  }
  return out;
}

/** Pure: the ?lumNight undo for a crystal base — authored / current luminosity, 1..4, x nightKeep. */
export function lifestoneLumBoost(base, nightKeep = 1) {
  const hb = base && base.userData ? base.userData.hbLumBase : undefined;
  const cur = base ? base.emissiveIntensity : undefined;
  let raw = 1;
  if (Number.isFinite(hb) && hb > 0 && Number.isFinite(cur) && cur > 1e-4) raw = Math.min(4, Math.max(1, hb / cur));
  const k = Math.min(1, Math.max(0, Number.isFinite(nightKeep) ? nightKeep : 1));
  return 1 + (raw - 1) * k;
}

function _nightOf(scene3d) {
  if (scene3d && scene3d._poolSunIndoor === true) return 1;
  try {
    const s = scene3d?.skyLightingController?._lastState;
    if (s && Number.isFinite(s.dirPitch)) return nightFactorFromAuthoredPitch(s.dirPitch);
  } catch (_) { /* day */ }
  return 0;
}

/**
 * Per frame (fx_showcase.tickFxShowcase): levels, breath, calibration, the
 * crystals' uniforms and base mirroring, the light's intensity. Returns the
 * live lifestone count.
 */
export function lifestoneFxTick(scene3d, nowMs) {
  const now = Number.isFinite(nowMs) ? nowMs : _now();
  const dt = _lastTick < 0 ? 0 : Math.min(1, Math.max(0, (now - _lastTick) / 1000));
  _lastTick = now;
  if (_states.size === 0) return 0;
  let e = NaN;
  try { e = Number(scene3d?.renderer?.toneMappingExposure ?? globalThis.window?.liveScene3d?.renderer?.toneMappingExposure); } catch (_) { e = NaN; }
  if (!Number.isFinite(e) || e <= 0) e = 1;
  _shared.uLsCal.value = 1 / Math.max(0.25, e);
  const G = _shared.uLsGain.value, S = _shared.uLsShape.value;
  G.x = Math.max(0, +_tune.inner || 0); G.y = Math.max(0, +_tune.rim || 0); G.z = Math.max(0, +_tune.glint || 0);
  G.w = Math.min(1, Math.max(0.04, Number.isFinite(+_tune.roughness) ? +_tune.roughness : 0.32));
  S.x = Math.max(0, +_tune.shapeBase || 0); S.y = Math.max(0, +_tune.shapeVein || 0); S.z = Math.max(0, +_tune.shapeHeart || 0);
  S.w = Math.min(1, Math.max(0, +_tune.hueDrift || 0));
  const night = _nightOf(scene3d);
  const glowRunning = _glowRunning();
  const tSec = (now / 1000) % 3600;
  for (const st of [..._states.values()]) {
    const inst = st.inst;
    if (!inst || inst._disposed || !inst.root) { _drop(st, false); continue; }
    const target = st.dying ? 0 : 1;
    const span = Math.max(0.05, st.dying ? +_tune.fadeOut || 0.8 : +_tune.fadeIn || 1.4);
    const step = dt / span;
    st.level = target > st.level ? Math.min(target, st.level + step) : Math.max(target, st.level - step);
    if (st.dying && st.level <= 0) { _drop(st, true); continue; }
    st.breath = lifestoneBreath(tSec, _tune.breathAmp, _tune.breathPeriod, st.phase);
    st.night = night;
    st.auraSoft = lifestoneDayNight(night, _tune.auraDay) * (glowRunning ? 0.6 : 1) * Math.max(0, +_tune.aura || 0);
    const u = st.u;
    u.uLsLevel.value = st.level;
    u.uLsBreath.value = st.breath;
    u.uLsColor.value.x = st.color[0]; u.uLsColor.value.y = st.color[1]; u.uLsColor.value.z = st.color[2];
    let boost = 1;
    for (const rec of st.recs.values()) {
      _syncRec(rec);
      const b = lifestoneLumBoost(rec.base, _tune.nightKeep);
      if (b > boost) boost = b;
    }
    u.uLsLumBoost.value = boost;
    if (st.light && st.lightOurs && !st.light.released) {
      const k = lifestoneDayNight(night, _tune.lightDay);
      st.light.baseIntensity = Math.max(0, Math.min(100, (+_tune.light || 0) * k * st.breath * st.level));
      st.light.distance = Math.max(0.5, Math.min(14, +_tune.lightRange || 5));
      st.light.color.setRGB(st.color[0], st.color[1], st.color[2]);
    }
    if (st.glowMat) {
      const g = Math.max(0, +_tune.glow || 0) * 0.35 * _shared.uLsCal.value * st.breath * st.level *
        lifestoneDayNight(night, _tune.auraDay);
      const c = st.glowMat.uniforms.uLgColor.value;
      c.x = st.color[0] * g; c.y = st.color[1] * g; c.z = st.color[2] * g;
    }
  }
  return _states.size;
}

// The crystals in the glow buffer (`?fxGlow` with the pass running).
registerFxGlowExtras({
  collect(out) {
    if (_states.size === 0 || !_glowRunning()) return;
    for (const st of _states.values()) {
      if (st.dead || st.level <= 0.01 || !(_tune.glow > 0)) continue;
      for (const rec of st.recs.values()) {
        if (!rec.swapped || rec.mesh.material !== rec.mat) continue;
        const gm = _glowMaterial(st);
        if (gm) out.push({ object: rec.mesh, material: gm });
      }
    }
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

// ---------------------------------------------------------------------------
// Diagnostics + test seams
// ---------------------------------------------------------------------------

/** Counts (`window.__lifestoneFx.stats()`). */
export function lifestoneFxStats() {
  let crystals = 0, pending = 0, lights = 0, real = 0, glow = 0;
  for (const st of _states.values()) {
    for (const rec of st.recs.values()) {
      if (rec.swapped) crystals++;
      if (rec.pending) pending++;
    }
    if (st.light && st.lightOurs) lights++;
    if (st.realLight) real++;
    if (st.glowMat) glow++;
  }
  return { enabled: lifestoneFxEnabled(), lifestones: _states.size, crystals, pending, lights, realLights: real,
    glowMaterials: glow, glowRunning: _glowRunning(), ..._stats };
}

/** One row per lifestone (`window.__lifestoneFx.list()`). */
export function lifestoneFxList() {
  const rows = [];
  for (const st of _states.values()) {
    rows.push({
      guid: "0x" + st.guid.toString(16),
      level: +st.level.toFixed(3),
      dying: st.dying,
      crystal: st.crystalFound,
      meshes: st.recs.size,
      swapped: [...st.recs.values()].filter((r) => r.swapped).length,
      light: st.lightOurs ? "carrier" : (st.realLight ? "own emitter light" : "none"),
      lightIntensity: st.light ? +(+st.light.baseIntensity || 0).toFixed(3) : 0,
      centre: [+st.centre.x.toFixed(2), +st.centre.y.toFixed(2), +st.centre.z.toFixed(2)],
      halfWidth: +st.hw.toFixed(2),
      halfHeight: +st.hh.toFixed(2),
      breath: +st.breath.toFixed(3),
      night: +st.night.toFixed(2),
      color: st.color.map((v) => +v.toFixed(3)),
    });
  }
  return rows;
}

/** The live state for an entity (tests / diagnostics). */
export function lifestoneFxStateOf(inst) {
  return _states.get(inst) || null;
}

/** Test seam: the lazy materials module as a promise (resolved once loaded). */
export function _lifestoneFxModulesForTest() {
  _materialsModule();
  return Promise.all([_Mp || Promise.resolve(_M), _prewarmModule()]);
}

/** Test seam: drop every lifestone (reverting live crystals), reset the clock and the tuning. */
export function _resetLifestoneFxForTest() {
  for (const st of [..._states.values()]) _drop(st, true);
  _states.clear();
  _lastTick = -1;
  Object.assign(_tune, LIFESTONE_FX_DEFAULTS);
  for (const k of Object.keys(_stats)) _stats[k] = 0;
}

if (typeof window !== "undefined") {
  window.__lifestoneFx = {
    stats: lifestoneFxStats,
    list: lifestoneFxList,
    tune: _tune,
    defaults: LIFESTONE_FX_DEFAULTS,
    reset() { Object.assign(_tune, LIFESTONE_FX_DEFAULTS); return _tune; },
    get enabled() { return lifestoneFxEnabled(); },
  };
}
