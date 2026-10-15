// scene3d/vfx/fx_decal_effect.js — tier 2 `?fxDecals` (2026-10-10): ground
// marks (scorch, frost, acid, the showcase light rings) projected onto the
// scene, deferred-decal style.
//
// HOW. Each live mark (vfx/fx_decals.js) is a world-space box. In `update()`
// the effect draws every box's back faces — ONE instanced draw per pass, two
// passes — into two private targets the size of the frame:
//   MUL  cleared to white, multiply-blended: the mark's tint of the surface
//        (char darkens, rime whitens, acid stains green). A multiply keeps the
//        surface's own lighting: a scorch at night is a darker shade of the
//        night ground, not a painted black disc.
//   ADD  cleared to black, additive: what the mark emits (the scorch's cooling
//        rim and embers, frost glints, acid bubbles, the rings' light).
// Each fragment reconstructs its pixel's world position from the composer's
// scene depth (sampled, never attached — the glow effect's rule), keeps the
// up-facing surface points inside its box and paints the procedural mark,
// faded by the scene fog. The composite is `scene * MUL + ADD`.
//
// PLACEMENT (atmosphere_pipeline.js). In the atmosphere EffectPass after the
// AO composite and BEFORE the clouds / aerial perspective, so a mark is hazed
// with the ground it lies on; declared EffectAttribute.DEPTH only so the pass's
// attribute sort keeps that slot. On the split chain the particles draw after
// this pass (no burst is darkened by its own scorch); on the single chain the
// scorch's darkening grows in over 0.8 s for the same reason. Works on both.
//
// COST. Two full-size half-float targets, cleared only while marks exist; two
// instanced box draws covering the marks' screen footprint (five depth texel
// fetches per covered pixel: its own and the normal's four neighbours); two
// texture taps in the composite (skipped by a uniform branch when nothing is
// live).
//
// SMOOTH MARKS (`?fxDecalSmooth`, 2026-10-11, default on; `=off` is the
// 2026-10-10 shader byte for byte). Owner: the war-spell scorch had "a squarish
// pixelated effect on the ground". Three causes, all in the box shader:
//   1. SQUARES. The scorch's embers were whole cells of a 9-per-radius grid
//      switched on by a step(): hard-edged ~20 cm orange tiles, in every
//      war-spell impact (ACE plays Explode on the bolt, and Explode scorches).
//      The frost glints and acid bubbles were pow(value noise), whose peaks sit
//      ON the lattice points: rounded squares in rows. Now round soft dots on a
//      jittered grid (hbDecalDot: one per cell, its centre kept a radius inside
//      the cell walls, a (1 - d^2)^2 profile that reaches zero with zero slope;
//      under 1.2 px of radius it is drawn at 1.2 px with the same light, as far
//      as its cell lets it grow); the outline and mottling fbm is gradient noise
//      on a lattice turned ~37 degrees per octave.
//   2. PRECISION. Each pixel's world position was rebuilt in ABSOLUTE THREE
//      world (uDecalCamWorld times the view position) in fp32. AC coordinates
//      run to 49 km, and past 32 km (the north and east halves of the map;
//      Holtburg sits ~34.6 km north) fp32 rounds them to 3.9 mm, coarser than
//      one pixel of ground a few metres from the camera. The up-facing test took dFdx / dFdy of that, so
//      whole 2x2 quads lost their normal and dropped out of the mark (fp32 model
//      in test_particle_fx_tier2.mjs, a mark 3.5 m from the camera: ~4 % of the
//      quads at 1080p, ~26 % at 1440p, ~46 % at 4K). Now camera-relative: the
//      instance centres are eye-relative (float64 on the CPU), the box is placed
//      with the view ROTATION only, and the fragment turns its view-space
//      position into world axes; every number is a few metres, so fp32 keeps it
//      to micrometres.
//   3. 2x2 QUADS. dFdx / dFdy are per 2x2 quad, so at every depth edge inside a
//      box (grass blades, rocks, a body's outline) the quad straddling it got a
//      nonsense normal. The normal is now per pixel, from the four neighbouring
//      depth texels, each axis taking the side with the smaller depth step.
// Also: the scorch rim's pow(negative, 2.0) (undefined in GLSL) is squared
// explicitly, the frost spokes no longer pinch to a one-pixel star at the
// centre, and the ring fades out before its box wall.

import * as THREE from "three";
import { BlendFunction, Effect, EffectAttribute } from "postprocessing";
import { FX_DECAL_MAX, collectFxDecals } from "./fx_decals.js";
import { fxTier2Enabled } from "./fx_tier2.js";
import { fxNowMs } from "../fx_clock.js";

/**
 * `?fxDecalSmooth` — default ON: the smooth box shader (round embers / glints /
 * blisters, camera-relative positions, per-pixel normals). An `off` / `0` /
 * `false` / `no` value builds the 2026-10-10 shader instead. Read once, when
 * the effect is built.
 * @param {string} [search] test seam for the URL
 */
export function fxDecalSmoothEnabled(search) {
  try {
    const s = typeof search === "string" ? search : (globalThis.location?.search || "");
    const v = new URLSearchParams(s).get("fxDecalSmooth");
    if (v == null) return true;
    const t = v.trim().toLowerCase();
    return t !== "off" && t !== "0" && t !== "false" && t !== "no";
  } catch (_) {
    return true;
  }
}

// No backticks in the GLSL (template literal).
const COMPOSITE = /* glsl */ `
uniform sampler2D tDecalMul;
uniform sampler2D tDecalAdd;
uniform float uDecalOn;
void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  if (uDecalOn < 0.5) { outputColor = inputColor; return; }
  vec3 m = texture2D(tDecalMul, uv).rgb;
  vec3 a = texture2D(tDecalAdd, uv).rgb;
  outputColor = vec4(inputColor.rgb * m + a, inputColor.a);
}
`;

// The 2026-10-10 box shader pair, kept byte for byte for `?fxDecalSmooth=off`
// (absolute world positions, quad-derivative normals, square ember cells).
const BOX_VERT_LEGACY = /* glsl */ `
attribute vec4 aD0;   // centre.xyz (THREE world), radius
attribute vec4 aD1;   // half-height, yaw, kind, fade
attribute vec4 aD2;   // colour.rgb, seed
attribute vec4 aD3;   // age (s), intensity, 0, 0
varying vec4 vD0;
varying vec4 vD1;
varying vec4 vD2;
varying vec4 vD3;
void main() {
	vec3 lp = position * vec3( 2.0 * aD0.w, 2.0 * aD1.x, 2.0 * aD0.w );
	float c = cos( aD1.y );
	float s = sin( aD1.y );
	vec3 wp = aD0.xyz + vec3( c * lp.x + s * lp.z, lp.y, -s * lp.x + c * lp.z );
	vD0 = aD0; vD1 = aD1; vD2 = aD2; vD3 = aD3;
	gl_Position = projectionMatrix * viewMatrix * vec4( wp, 1.0 );
}
`;

const BOX_FRAG_LEGACY = /* glsl */ `
uniform highp sampler2D uDecalDepth;
uniform vec2 uDecalRes;
uniform float uDecalLogFar;
uniform float uDecalIsLog;
uniform vec2 uDecalNearFar;
uniform mat4 uDecalCamWorld;
uniform vec4 uDecalProj;     // projection P00, P11, P20, P21 (the fragment stage has no projectionMatrix)
uniform float uDecalTime;
uniform vec4 uDecalFog;      // kind (0 none, 1 linear, 2 exp2), near, far, density
uniform float uDecalAddCal;
varying vec4 vD0;
varying vec4 vD1;
varying vec4 vD2;
varying vec4 vD3;
float hbDecalHash( vec2 p ) {
	vec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
	p3 += dot( p3, p3.yzx + 33.33 );
	return fract( ( p3.x + p3.y ) * p3.z );
}
float hbDecalNoise( vec2 p ) {
	vec2 i = floor( p );
	vec2 f = fract( p );
	f = f * f * ( 3.0 - 2.0 * f );
	return mix( mix( hbDecalHash( i ), hbDecalHash( i + vec2( 1.0, 0.0 ) ), f.x ),
		mix( hbDecalHash( i + vec2( 0.0, 1.0 ) ), hbDecalHash( i + vec2( 1.0, 1.0 ) ), f.x ), f.y );
}
float hbDecalFbm( vec2 p ) {
	float s = 0.0;
	float a = 0.5;
	for ( int i = 0; i < 4; i++ ) { s += a * hbDecalNoise( p ); p = p * 2.03 + 17.1; a *= 0.5; }
	return s / 0.9375;
}
void main() {
	vec2 suv = gl_FragCoord.xy / uDecalRes;
	float d = texture2D( uDecalDepth, suv ).x;
	if ( d >= 0.999999 ) discard;   // sky: nothing to mark
	float w;
	if ( uDecalIsLog > 0.5 ) {
		w = exp2( d * uDecalLogFar ) - 1.0;
	} else {
		float z = d * 2.0 - 1.0;
		w = ( 2.0 * uDecalNearFar.x * uDecalNearFar.y ) / ( uDecalNearFar.y + uDecalNearFar.x - z * ( uDecalNearFar.y - uDecalNearFar.x ) );
	}
	vec2 ndc = suv * 2.0 - 1.0;
	vec3 vp = vec3( ( ndc.x + uDecalProj.z ) * w / uDecalProj.x, ( ndc.y + uDecalProj.w ) * w / uDecalProj.y, -w );
	vec3 wp = ( uDecalCamWorld * vec4( vp, 1.0 ) ).xyz;
	vec3 rel = wp - vD0.xyz;
	float c = cos( vD1.y );
	float s = sin( vD1.y );
	vec2 q = vec2( c * rel.x - s * rel.z, s * rel.x + c * rel.z ) / vD0.w;   // into the box (unit disc)
	float ly = rel.y / vD1.x;
	if ( abs( ly ) > 1.0 || dot( q, q ) > 1.0 ) discard;
	// only up-facing surfaces take the mark (a wall or a creature's flank does not)
	vec3 n = cross( dFdx( wp ), dFdy( wp ) );
	float nl = length( n );
	float upF = nl > 1e-12 ? smoothstep( 0.45, 0.8, abs( n.y ) / nl ) : 0.0;
	float k = upF * ( 1.0 - smoothstep( 0.55, 1.0, abs( ly ) ) ) * vD1.w;
	if ( k <= 0.0 ) discard;
	float r = length( q );
	float kind = vD1.z;
	float age = vD3.x;
	float seed = vD2.w;
	vec3 mulC = vec3( 1.0 );
	vec3 addC = vec3( 0.0 );
	if ( kind < 1.5 ) {
		// scorch: a ragged char, mottled, its rim and embers cooling off
		float nz = hbDecalFbm( q * 2.6 + seed * 17.0 );
		float edgeR = 0.62 + 0.3 * nz;
		float ch = 1.0 - smoothstep( edgeR - 0.18, edgeR, r );
		ch *= 0.75 + 0.25 * hbDecalFbm( q * 7.0 + 3.1 );
		mulC = mix( vec3( 1.0 ), vec3( 0.16, 0.13, 0.11 ), ch * 0.92 * smoothstep( 0.0, 0.8, age ) );
		float rim = exp( -pow( ( r - edgeR * 0.92 ) / 0.07, 2.0 ) ) * exp( -age / 1.4 );
		vec2 cell = floor( q * 9.0 );
		float emb = step( 0.86, hbDecalHash( cell + seed * 31.0 ) ) * ch * exp( -age / 3.5 )
			* ( 0.6 + 0.4 * sin( uDecalTime * 7.0 + hbDecalHash( cell ) * 20.0 ) );
		addC = vD2.rgb * ( rim * 2.2 + emb * 1.6 );
	} else if ( kind < 2.5 ) {
		// frost: a whitening rime, six-fold crystal spokes, glints
		float nz = hbDecalFbm( q * 3.0 + seed * 11.0 );
		float edgeR = 0.55 + 0.35 * nz;
		float cov = ( 1.0 - smoothstep( edgeR - 0.25, edgeR, r ) ) * smoothstep( 0.0, 0.4, age );
		float th = r > 1e-4 ? atan( q.y, q.x ) : 0.0;
		float spokes = pow( abs( cos( th * 3.0 + nz * 2.0 ) ), 18.0 ) * ( 1.0 - r );
		mulC = mix( vec3( 1.0 ), vec3( 1.35, 1.5, 1.7 ), cov * ( 0.55 + 0.45 * hbDecalFbm( q * 11.0 ) ) * 0.75 );
		float glint = pow( hbDecalNoise( q * 24.0 + uDecalTime * 0.6 ), 14.0 ) * cov;
		addC = vD2.rgb * ( spokes * cov * 0.35 + glint * 1.4 );
	} else if ( kind < 3.5 ) {
		// acid: a green stain with a wet, bubbling sheen
		float nz = hbDecalFbm( q * 2.2 + seed * 13.0 );
		float edgeR = 0.45 + 0.4 * nz;
		float cov = ( 1.0 - smoothstep( edgeR - 0.2, edgeR, r ) ) * smoothstep( 0.0, 0.3, age );
		mulC = mix( vec3( 1.0 ), vec3( 0.55, 0.8, 0.32 ), cov * 0.8 );
		float bub = pow( hbDecalNoise( q * 14.0 + vec2( 0.0, uDecalTime * 0.7 ) ), 10.0 ) * cov;
		addC = vD2.rgb * ( bub * 1.2 + cov * 0.06 );
	} else {
		// ring: a breathing light ring on the ground (portal / lifestone showcase)
		float rr = abs( r - 0.82 );
		float ring = exp( -rr * rr / 0.0025 ) + 0.25 * exp( -rr * 9.0 );
		float pulse = 0.85 + 0.15 * sin( uDecalTime * 1.3 + seed * 6.2831853 );
		addC = vD2.rgb * ( ring + 0.12 * ( 1.0 - smoothstep( 0.0, 0.82, r ) ) ) * pulse;
	}
	float fogF = 0.0;
	if ( uDecalFog.x > 1.5 ) fogF = 1.0 - exp( -uDecalFog.w * uDecalFog.w * w * w );
	else if ( uDecalFog.x > 0.5 ) fogF = smoothstep( uDecalFog.y, uDecalFog.z, w );
	k *= 1.0 - fogF;
	#ifdef HB_DECAL_MUL
	gl_FragColor = vec4( mix( vec3( 1.0 ), mulC, k ), 1.0 );
	#else
	gl_FragColor = vec4( addC * k * vD3.y * uDecalAddCal, 1.0 );
	#endif
}
`;

// The smooth box shader pair (`?fxDecalSmooth`, the default; see the header).
// The instance centre arrives EYE-RELATIVE, the box is placed with the view
// rotation only, and the fragment never touches an absolute world coordinate.
const BOX_VERT = /* glsl */ `
attribute vec4 aD0;   // centre.xyz relative to the eye (THREE world axes, metres), radius
attribute vec4 aD1;   // half-height, yaw, kind, fade
attribute vec4 aD2;   // colour.rgb, seed
attribute vec4 aD3;   // age (s), intensity, 0, 0
uniform mat3 uDecalViewRot;   // world to view, rotation only: the eye is the origin
varying vec4 vD0;
varying vec4 vD1;
varying vec4 vD2;
varying vec4 vD3;
void main() {
	vec3 lp = position * vec3( 2.0 * aD0.w, 2.0 * aD1.x, 2.0 * aD0.w );
	float c = cos( aD1.y );
	float s = sin( aD1.y );
	vec3 rp = aD0.xyz + vec3( c * lp.x + s * lp.z, lp.y, -s * lp.x + c * lp.z );
	vD0 = aD0; vD1 = aD1; vD2 = aD2; vD3 = aD3;
	gl_Position = projectionMatrix * vec4( uDecalViewRot * rp, 1.0 );
}
`;

const BOX_FRAG = /* glsl */ `
uniform highp sampler2D uDecalDepth;
uniform vec2 uDecalRes;      // the decal targets' size (gl_FragCoord space)
uniform float uDecalLogFar;
uniform float uDecalIsLog;
uniform vec2 uDecalNearFar;
uniform mat3 uDecalCamRot;   // view to world, rotation only (the camera's axes)
uniform vec4 uDecalProj;     // projection P00, P11, P20, P21 (the fragment stage has no projectionMatrix)
uniform float uDecalTime;
uniform vec4 uDecalFog;      // kind (0 none, 1 linear, 2 exp2), near, far, density
uniform float uDecalAddCal;
varying vec4 vD0;
varying vec4 vD1;
varying vec4 vD2;
varying vec4 vD3;
vec2 hbDecalHash2( vec2 p ) {
	vec3 p3 = fract( vec3( p.xyx ) * vec3( 0.1031, 0.1030, 0.0973 ) );
	p3 += dot( p3, p3.yzx + 33.33 );
	return fract( ( p3.xx + p3.yz ) * p3.zy );
}
// gradient noise, about 0..1 around 0.5 (value noise puts its extremes ON the
// lattice points, so its hot spots were rounded squares in rows)
float hbDecalNoise( vec2 p ) {
	vec2 i = floor( p );
	vec2 f = p - i;
	vec2 u = f * f * f * ( f * ( f * 6.0 - 15.0 ) + 10.0 );
	float a = dot( hbDecalHash2( i ) * 2.0 - 1.0, f );
	float b = dot( hbDecalHash2( i + vec2( 1.0, 0.0 ) ) * 2.0 - 1.0, f - vec2( 1.0, 0.0 ) );
	float c = dot( hbDecalHash2( i + vec2( 0.0, 1.0 ) ) * 2.0 - 1.0, f - vec2( 0.0, 1.0 ) );
	float d = dot( hbDecalHash2( i + vec2( 1.0, 1.0 ) ) * 2.0 - 1.0, f - vec2( 1.0, 1.0 ) );
	return clamp( 0.5 + 1.2 * mix( mix( a, b, u.x ), mix( c, d, u.x ), u.y ), 0.0, 1.0 );
}
// four octaves, each on a lattice turned ~37 degrees (and scaled 2.03x) from the
// last: no grid axis is shared, so the outline has no square lobes
float hbDecalFbm( vec2 p ) {
	float s = 0.0;
	float a = 0.5;
	for ( int i = 0; i < 4; i++ ) {
		s += a * hbDecalNoise( p );
		p = mat2( 1.62, 1.22, -1.22, 1.62 ) * p + 17.1;
		a *= 0.5;
	}
	return s / 0.9375;
}
// Round soft dots on a jittered grid (embers, glints, blisters), p in cell units:
// at most one per cell (a density share of the cells), its radius 0.6..1 x rad
// (rad <= 0.5) times size, its centre kept a full radius inside the cell walls,
// so a dot never reaches a neighbour and no cell has to look at one. Profile
// (1 - x^2)^2: 1 at the centre, 0 with zero slope at the rim, no edge at any
// size. A dot under 1.2 px of radius (pxc = one pixel in cell units) is drawn at
// 1.2 px with its brightness cut by the area ratio, as far as its cell walls
// let it grow (the same light, steady instead of popping), and fades out only
// where even that is under a pixel. x = brightness, y = the cell's hash.
vec2 hbDecalDot( vec2 p, float density, float rad, float size, float pxc ) {
	vec2 c = floor( p );
	vec2 h = hbDecalHash2( c );
	float r = rad * ( 0.6 + 0.4 * h.y );
	vec2 o = vec2( r ) + ( 1.0 - 2.0 * r ) * hbDecalHash2( c + 19.19 );
	float rs = r * size;
	float re = min( max( rs, 1.2 * pxc ), min( min( o.x, o.y ), min( 1.0 - o.x, 1.0 - o.y ) ) );
	float x = length( p - c - o ) / re;
	float t = max( 0.0, 1.0 - x * x );
	return vec2( step( h.x, density ) * t * t * ( rs * rs ) / ( re * re ) * smoothstep( 0.5, 1.0, re / max( pxc, 1e-6 ) ), h.y );
}
// linear view depth of one scene depth value
float hbDecalW( float d ) {
	if ( uDecalIsLog > 0.5 ) return exp2( d * uDecalLogFar ) - 1.0;
	float z = d * 2.0 - 1.0;
	return ( 2.0 * uDecalNearFar.x * uDecalNearFar.y ) / ( uDecalNearFar.y + uDecalNearFar.x - z * ( uDecalNearFar.y - uDecalNearFar.x ) );
}
// view-space position of depth texel p at view depth w (the eye is the origin: small numbers)
vec3 hbDecalViewAt( ivec2 p, vec2 dsz, float w ) {
	vec2 ndc = ( vec2( p ) + 0.5 ) / dsz * 2.0 - 1.0;
	return vec3( ( ndc.x + uDecalProj.z ) * w / uDecalProj.x, ( ndc.y + uDecalProj.w ) * w / uDecalProj.y, -w );
}
vec3 hbDecalView( ivec2 p, vec2 dsz ) {
	return hbDecalViewAt( p, dsz, hbDecalW( texelFetch( uDecalDepth, p, 0 ).x ) );
}
void main() {
	vec2 dsz = vec2( textureSize( uDecalDepth, 0 ) );
	ivec2 lim = ivec2( dsz ) - 1;
	ivec2 p = clamp( ivec2( gl_FragCoord.xy * ( dsz / uDecalRes ) ), ivec2( 0 ), lim );
	float d = texelFetch( uDecalDepth, p, 0 ).x;
	if ( d >= 0.999999 ) discard;   // sky: nothing to mark
	float w = hbDecalW( d );
	vec3 c0 = hbDecalViewAt( p, dsz, w );
	// eye-relative offset from the mark's centre, in world axes: every term is
	// metres, not tens of kilometres (the absolute rebuild rounded to 3.9 mm)
	vec3 rel = uDecalCamRot * c0 - vD0.xyz;
	float c = cos( vD1.y );
	float s = sin( vD1.y );
	vec2 q = vec2( c * rel.x - s * rel.z, s * rel.x + c * rel.z ) / vD0.w;   // into the box (unit disc)
	float ly = rel.y / vD1.x;
	if ( abs( ly ) > 1.0 || dot( q, q ) > 1.0 ) discard;
	// only up-facing surfaces take the mark (a wall or a creature's flank does not).
	// The normal is per pixel, from the four neighbouring texels, each axis taking
	// the side with the smaller depth step (this pixel's own surface): no 2x2 quad
	// blocks, clean along grass blades, rocks and a body's outline.
	vec3 xr = hbDecalView( min( p + ivec2( 1, 0 ), lim ), dsz ) - c0;
	vec3 xl = c0 - hbDecalView( max( p - ivec2( 1, 0 ), ivec2( 0 ) ), dsz );
	vec3 yu = hbDecalView( min( p + ivec2( 0, 1 ), lim ), dsz ) - c0;
	vec3 yd = c0 - hbDecalView( max( p - ivec2( 0, 1 ), ivec2( 0 ) ), dsz );
	vec3 ex = ( dot( xl, xl ) == 0.0 || ( dot( xr, xr ) > 0.0 && abs( xr.z ) < abs( xl.z ) ) ) ? xr : xl;
	vec3 ey = ( dot( yd, yd ) == 0.0 || ( dot( yu, yu ) > 0.0 && abs( yu.z ) < abs( yd.z ) ) ) ? yu : yd;
	vec3 n = uDecalCamRot * cross( ex, ey );
	float nl = length( n );
	float upF = nl > 1e-12 ? smoothstep( 0.45, 0.8, abs( n.y ) / nl ) : 0.0;
	float k = upF * ( 1.0 - smoothstep( 0.55, 1.0, abs( ly ) ) ) * vD1.w;
	if ( k <= 0.0 ) discard;
	// one pixel's ground footprint in unit-disc units (keeps the dots from going sub-pixel)
	float pxq = max( length( ( uDecalCamRot * ex ).xz ), length( ( uDecalCamRot * ey ).xz ) ) / vD0.w;
	float r = length( q );
	float kind = vD1.z;
	float age = vD3.x;
	float seed = vD2.w;
	vec3 mulC = vec3( 1.0 );
	vec3 addC = vec3( 0.0 );
	if ( kind < 1.5 ) {
		// scorch: a ragged char, mottled, its rim and embers cooling off
		float nz = hbDecalFbm( q * 2.6 + seed * 17.0 );
		float edgeR = 0.62 + 0.3 * nz;
		float ch = 1.0 - smoothstep( edgeR - 0.18, edgeR, r );
		ch *= 0.75 + 0.25 * hbDecalFbm( q * 7.0 + 3.1 );
		mulC = mix( vec3( 1.0 ), vec3( 0.16, 0.13, 0.11 ), ch * 0.92 * smoothstep( 0.0, 0.8, age ) );
		float rd = ( r - edgeR * 0.92 ) / 0.07;
		float rim = exp( -rd * rd ) * exp( -age / 1.4 );
		// embers: round soft specks through the char (they were whole grid cells
		// switched on by a step: square tiles), each breathing on its own phase
		vec2 e = hbDecalDot( q * 9.0 + seed * 31.0, 0.2, 0.36, 1.0, pxq * 9.0 );
		float emb = e.x * ch * exp( -age / 3.5 ) * ( 0.6 + 0.4 * sin( uDecalTime * 7.0 + e.y * 20.0 ) );
		addC = vD2.rgb * ( rim * 2.2 + emb * 2.2 );
	} else if ( kind < 2.5 ) {
		// frost: a whitening rime, six-fold crystal spokes (faded out at the very
		// centre, where they would pinch to a one-pixel star), glints
		float nz = hbDecalFbm( q * 3.0 + seed * 11.0 );
		float edgeR = 0.55 + 0.35 * nz;
		float cov = ( 1.0 - smoothstep( edgeR - 0.25, edgeR, r ) ) * smoothstep( 0.0, 0.4, age );
		float th = r > 1e-4 ? atan( q.y, q.x ) : 0.0;
		float spokes = pow( abs( cos( th * 3.0 + nz * 2.0 ) ), 18.0 ) * ( 1.0 - r ) * smoothstep( 0.02, 0.12, r );
		mulC = mix( vec3( 1.0 ), vec3( 1.35, 1.5, 1.7 ), cov * ( 0.55 + 0.45 * hbDecalFbm( q * 11.0 ) ) * 0.75 );
		// glints: round specks, each twinkling on its own clock
		vec2 g = hbDecalDot( q * 14.0 + seed * 7.0, 0.22, 0.24, 1.0, pxq * 14.0 );
		float tw = 0.5 + 0.5 * sin( uDecalTime * ( 1.5 + 2.5 * g.y ) + g.y * 40.0 );
		float glint = g.x * tw * tw * tw * cov;
		addC = vD2.rgb * ( spokes * cov * 0.35 + glint * 1.4 );
	} else if ( kind < 3.5 ) {
		// acid: a green stain with a wet, bubbling sheen
		float nz = hbDecalFbm( q * 2.2 + seed * 13.0 );
		float edgeR = 0.45 + 0.4 * nz;
		float cov = ( 1.0 - smoothstep( edgeR - 0.2, edgeR, r ) ) * smoothstep( 0.0, 0.3, age );
		mulC = mix( vec3( 1.0 ), vec3( 0.55, 0.8, 0.32 ), cov * 0.8 );
		// blisters: round, each swelling and popping on its own cycle
		vec2 bp = q * 8.0 + seed * 5.0;
		float ph = fract( uDecalTime * 0.5 + hbDecalHash2( floor( bp ) ).y * 7.0 );
		vec2 b = hbDecalDot( bp, 0.3, 0.32, 0.35 + 0.65 * ph, pxq * 8.0 );
		float bub = b.x * smoothstep( 0.0, 0.1, ph ) * ( 1.0 - smoothstep( 0.8, 1.0, ph ) ) * cov;
		addC = vD2.rgb * ( bub * 1.2 + cov * 0.06 );
	} else {
		// ring: a breathing light ring on the ground (portal / lifestone showcase),
		// faded out before its box wall
		float rr = abs( r - 0.82 );
		float ring = exp( -rr * rr / 0.0025 ) + 0.25 * exp( -rr * 9.0 );
		float pulse = 0.85 + 0.15 * sin( uDecalTime * 1.3 + seed * 6.2831853 );
		addC = vD2.rgb * ( ring + 0.12 * ( 1.0 - smoothstep( 0.0, 0.82, r ) ) ) * pulse * ( 1.0 - smoothstep( 0.9, 1.0, r ) );
	}
	float fogF = 0.0;
	if ( uDecalFog.x > 1.5 ) fogF = 1.0 - exp( -uDecalFog.w * uDecalFog.w * w * w );
	else if ( uDecalFog.x > 0.5 ) fogF = smoothstep( uDecalFog.y, uDecalFog.z, w );
	k *= 1.0 - fogF;
	#ifdef HB_DECAL_MUL
	gl_FragColor = vec4( mix( vec3( 1.0 ), mulC, k ), 1.0 );
	#else
	gl_FragColor = vec4( addC * k * vD3.y * uDecalAddCal, 1.0 );
	#endif
}
`;

/** Shader sources (tests): the shipped smooth pair, and the `?fxDecalSmooth=off` one. */
export const FX_DECAL_GLSL = Object.freeze({ composite: COMPOSITE, vertex: BOX_VERT, fragment: BOX_FRAG });
export const FX_DECAL_GLSL_LEGACY = Object.freeze({ composite: COMPOSITE, vertex: BOX_VERT_LEGACY, fragment: BOX_FRAG_LEGACY });

const ALL_LAYERS = 0xffffffff;
const ADD_CAL_K = 3.0;

export class FxDecalEffect extends Effect {
  /**
   * @param {{camera?: THREE.Camera, depthSource?: () => (THREE.Texture|null), fog?: () => (object|null),
   *   smooth?: boolean}} [opts] `smooth` forces the box shader (else `?fxDecalSmooth`)
   */
  constructor(opts = {}) {
    super("FxDecalEffect", COMPOSITE, {
      blendFunction: BlendFunction.SRC,
      attributes: EffectAttribute.DEPTH,
      uniforms: new Map([
        ["tDecalMul", new THREE.Uniform(null)],
        ["tDecalAdd", new THREE.Uniform(null)],
        ["uDecalOn", new THREE.Uniform(0)],
      ]),
    });
    this.camera = opts.camera ?? null;
    this._depthSource = typeof opts.depthSource === "function" ? opts.depthSource : () => null;
    this._fogSource = typeof opts.fog === "function" ? opts.fog : () => null;
    /** The smooth box shader (eye-relative instances) vs the 2026-10-10 one. Fixed for the effect's life. */
    this.smooth = typeof opts.smooth === "boolean" ? opts.smooth : fxDecalSmoothEnabled();
    const mk = (name) => {
      const t = new THREE.WebGLRenderTarget(1, 1, {
        type: THREE.HalfFloatType, depthBuffer: false, stencilBuffer: false,
        minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      });
      t.texture.name = name;
      t.texture.generateMipmaps = false;
      return t;
    };
    this.mulTarget = mk("FxDecal.Mul");
    this.addTarget = mk("FxDecal.Add");
    this.uniforms.get("tDecalMul").value = this.mulTarget.texture;
    this.uniforms.get("tDecalAdd").value = this.addTarget.texture;
    this.boxUniforms = {
      uDecalDepth: { value: null },
      uDecalRes: { value: new THREE.Vector2(1, 1) },
      uDecalLogFar: { value: 1 },
      uDecalIsLog: { value: 1 },
      uDecalNearFar: { value: new THREE.Vector2(0.1, 1000) },
      uDecalCamWorld: { value: new THREE.Matrix4() },   // legacy shader only
      uDecalCamRot: { value: new THREE.Matrix3() },     // smooth: view to world, rotation only
      uDecalViewRot: { value: new THREE.Matrix3() },    // smooth: world to view, rotation only
      uDecalProj: { value: new THREE.Vector4(1, 1, 0, 0) },
      uDecalTime: { value: 0 },
      uDecalFog: { value: new THREE.Vector4(0, 0, 1, 0) },
      uDecalAddCal: { value: 1 },
    };
    const box = new THREE.BoxGeometry(1, 1, 1);
    const g = new THREE.InstancedBufferGeometry();
    g.index = box.index;
    g.setAttribute("position", box.getAttribute("position"));
    const mkI = () => {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(FX_DECAL_MAX * 4), 4);
      a.setUsage(THREE.DynamicDrawUsage);
      return a;
    };
    for (const n of ["aD0", "aD1", "aD2", "aD3"]) g.setAttribute(n, mkI());
    g.instanceCount = 0;
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
    this.boxGeometry = g;
    // Exact blend state (CustomBlending): MUL = src x dst, ADD = src + dst.
    const glsl = this.smooth ? FX_DECAL_GLSL : FX_DECAL_GLSL_LEGACY;
    const mat = (mul) => new THREE.ShaderMaterial({
      name: mul ? "fx-decal-mul" : "fx-decal-add",
      defines: mul ? { HB_DECAL_MUL: "" } : {},
      uniforms: this.boxUniforms,
      vertexShader: glsl.vertex,
      fragmentShader: glsl.fragment,
      side: THREE.BackSide,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: mul ? THREE.DstColorFactor : THREE.OneFactor,
      blendDst: mul ? THREE.ZeroFactor : THREE.OneFactor,
      fog: false,
    });
    this.mulMaterial = mat(true);
    this.addMaterial = mat(false);
    this.boxMesh = new THREE.Mesh(g, this.mulMaterial);
    this.boxMesh.frustumCulled = false;
    this.boxMesh.layers.mask = ALL_LAYERS;
    this.boxScene = new THREE.Scene();
    this.boxScene.name = "FxDecal.Scene";
    this.boxScene.matrixWorldAutoUpdate = false;
    this.boxScene.add(this.boxMesh);
    this._list = [];
    this._eye = new THREE.Vector3();
    this._rotM4 = new THREE.Matrix4();
    this._clearColor = new THREE.Color();
    this._dirty = true;
    /** Multiplier on what the marks emit (`window.__fxDecals.addGain`, live tuning). */
    this.addGain = 1;
    this.stats = { frames: 0, drawn: 0, cpuMs: 0 };
  }

  set mainCamera(c) { if (c) this.camera = c; }
  get mainCamera() { return this.camera; }

  /**
   * Fill the instance attributes from this frame's marks. Returns the count.
   * The smooth shader takes each centre EYE-RELATIVE (`eye` = the camera's world
   * position): the subtraction runs here in float64, so the Float32 attribute
   * holds a few metres to the micrometre instead of ~33 km to 3.9 mm.
   */
  _fill(list, eye) {
    const g = this.boxGeometry;
    const A0 = g.attributes.aD0.array, A1 = g.attributes.aD1.array, A2 = g.attributes.aD2.array, A3 = g.attributes.aD3.array;
    const n = Math.min(list.length, FX_DECAL_MAX);
    const rel = this.smooth && !!eye;
    const ox = rel ? eye.x : 0, oy = rel ? eye.y : 0, oz = rel ? eye.z : 0;
    for (let i = 0; i < n; i++) {
      const d = list[i];
      const o = i * 4;
      A0[o] = d.x - ox; A0[o + 1] = d.y - oy; A0[o + 2] = d.z - oz; A0[o + 3] = d.radius;
      A1[o] = d.height; A1[o + 1] = d.yaw; A1[o + 2] = d.kind; A1[o + 3] = d.fade;
      A2[o] = d.color[0]; A2[o + 1] = d.color[1]; A2[o + 2] = d.color[2]; A2[o + 3] = d.seed;
      A3[o] = d.ageSec || 0; A3[o + 1] = d.intensity; A3[o + 2] = 0; A3[o + 3] = 0;
    }
    for (const name of ["aD0", "aD1", "aD2", "aD3"]) {
      const a = g.attributes[name];
      a.clearUpdateRanges();
      a.addUpdateRange(0, n * 4);
      a.needsUpdate = true;
    }
    g.instanceCount = n;
    return n;
  }

  _setFrameUniforms(renderer, cam) {
    const U = this.boxUniforms;
    U.uDecalDepth.value = this._depthSource();
    U.uDecalRes.value.set(this.mulTarget.width, this.mulTarget.height);
    const far = Number.isFinite(cam.far) && cam.far > 0 ? cam.far : 1000;
    const near = Number.isFinite(cam.near) && cam.near > 0 ? cam.near : 0.1;
    U.uDecalLogFar.value = Math.log2(far + 1);
    U.uDecalIsLog.value = renderer.capabilities?.logarithmicDepthBuffer === true ? 1 : 0;
    U.uDecalNearFar.value.set(near, far);
    U.uDecalCamWorld.value.copy(cam.matrixWorld);
    // The camera's axes with no translation (the smooth shader works eye-relative);
    // the inverse of a rotation is its transpose.
    U.uDecalCamRot.value.setFromMatrix4(this._rotM4.extractRotation(cam.matrixWorld));
    U.uDecalViewRot.value.copy(U.uDecalCamRot.value).transpose();
    const pe = cam.projectionMatrix.elements;
    U.uDecalProj.value.set(pe[0], pe[5], pe[8], pe[9]);
    const now = fxNowMs(); // the film clock during a stepped take (fx_clock.js)
    U.uDecalTime.value = (now / 1000) % 1024;
    const fog = this._fogSource();
    if (fog && fog.isFogExp2) U.uDecalFog.value.set(2, 0, 1, fog.density || 0);
    else if (fog && fog.isFog) U.uDecalFog.value.set(1, fog.near || 0, Math.max((fog.near || 0) + 1e-3, fog.far || 1), 0);
    else U.uDecalFog.value.set(0, 0, 1, 0);
    const e = Number(renderer.toneMappingExposure);
    U.uDecalAddCal.value = (Number.isFinite(e) && e > 1 ? Math.min(1, ADD_CAL_K / Math.min(20, e)) : 1) * this.addGain;
  }

  update(renderer, _inputBuffer, _deltaTime) {
    const t0 = typeof performance !== "undefined" ? performance.now() : 0;
    this.stats.frames++;
    const cam = this.camera;
    const list = this._list;
    list.length = 0;
    if (cam && fxTier2Enabled("fxDecals") && this._depthSource()) {
      cam.getWorldPosition(this._eye);
      collectFxDecals(this._eye, list);
    }
    const on = this.uniforms.get("uDecalOn");
    if (list.length === 0) {
      on.value = 0;
      this.stats.drawn = 0;
      if (this._dirty) this._clearTargets(renderer);
      return;
    }
    const n = this._fill(list, this._eye);
    const prevTarget = renderer.getRenderTarget();
    const prevAuto = renderer.autoClear;
    renderer.getClearColor(this._clearColor);
    const prevAlpha = renderer.getClearAlpha();
    try {
      renderer.autoClear = false;
      this._setFrameUniforms(renderer, cam);
      renderer.setRenderTarget(this.mulTarget);
      renderer.setClearColor(0xffffff, 1);
      renderer.clear(true, false, false);
      this.boxMesh.material = this.mulMaterial;
      renderer.render(this.boxScene, cam);
      renderer.setRenderTarget(this.addTarget);
      renderer.setClearColor(0x000000, 0);
      renderer.clear(true, false, false);
      this.boxMesh.material = this.addMaterial;
      renderer.render(this.boxScene, cam);
      on.value = 1;
      this._dirty = true;
    } finally {
      this.boxUniforms.uDecalDepth.value = null;
      renderer.setRenderTarget(prevTarget);
      renderer.setClearColor(this._clearColor, prevAlpha);
      renderer.autoClear = prevAuto;
    }
    this.stats.drawn = n;
    this.stats.cpuMs = (typeof performance !== "undefined" ? performance.now() : 0) - t0;
  }

  _clearTargets(renderer) {
    const prevTarget = renderer.getRenderTarget();
    renderer.getClearColor(this._clearColor);
    const prevAlpha = renderer.getClearAlpha();
    try {
      renderer.setRenderTarget(this.mulTarget);
      renderer.setClearColor(0xffffff, 1);
      renderer.clear(true, false, false);
      renderer.setRenderTarget(this.addTarget);
      renderer.setClearColor(0x000000, 0);
      renderer.clear(true, false, false);
      this._dirty = false;
    } finally {
      renderer.setRenderTarget(prevTarget);
      renderer.setClearColor(this._clearColor, prevAlpha);
    }
  }

  setSize(width, height) {
    const w = Math.max(1, width | 0), h = Math.max(1, height | 0);
    this.mulTarget.setSize(w, h);
    this.addTarget.setSize(w, h);
    this._dirty = true;
  }

  dispose() {
    this.mulTarget.dispose();
    this.addTarget.dispose();
    this.boxGeometry.dispose();
    this.mulMaterial.dispose();
    this.addMaterial.dispose();
    super.dispose();
  }
}

/** The effect, or null when `?fxDecals` is off for this session (the pipeline drops the slot). */
export function createFxDecalEffect(opts = {}) {
  const on = typeof opts.enabled === "boolean" ? opts.enabled : fxTier2Enabled("fxDecals");
  if (!on) return null;
  return new FxDecalEffect(opts);
}

/** `window.__fxDecals` live handle. */
export function installFxDecalHandle(effect, extra = {}) {
  if (typeof window === "undefined" || !effect) return null;
  const h = {
    stats: () => ({ ...effect.stats, smooth: effect.smooth, ...(extra.stats ? extra.stats() : {}) }),
    get addGain() { return effect.addGain; },
    set addGain(v) { if (Number.isFinite(+v)) effect.addGain = Math.max(0, +v); },
    effect,
  };
  window.__fxDecals = h;
  return h;
}
