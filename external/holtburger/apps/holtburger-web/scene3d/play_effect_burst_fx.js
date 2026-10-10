// scene3d/play_effect_burst_fx.js — `?burstFx` (2026-10-09, DEFAULT ON,
// `=off` escape): the individual upgrade for the PlayEffect placeholder bursts.
//
// play_effect_vfx.js draws an instant placeholder cue for every PlayEffect
// (`?castPlaceholder`, default on) and the ONLY cue for targets without a
// PhysicsScriptTable: a pooled additive sphere, torus or cube, tweened in scale
// and opacity. As plain MeshBasicMaterials those were flat, hard-edged discs of
// one colour. This module turns each shape into a lit-from-within energy form
// and gives every PlayScript family its own look:
//
//   sphere  energy shell — fresnel rim (bright silhouette, translucent heart),
//           object-space noise streaks drifting up or in, HDR gain for bloom
//   ring    luminous filament — the tube's facing core glows, energy runs
//           round it (noise scrolled along the ring)
//   cube    crystal — edges glow, faces stay faint (skill / dirty fighting)
//
//   per look: gain, rim boost, rim power, heart opacity, streak amount /
//   frequency / speed (+ = rising, − = sinking/inward), flicker amount + rate,
//   end-of-life tint (fire cools, death darkens…), fade curve (>1 snaps out,
//   <1 lingers), cube edge width.
//
// Program cost: three constant programs (one per shape, `customProgramCacheKey`
// "hbBurstFx1|<shape>"); a look is only uniform values on the pooled material,
// so pool reuse never recompiles. The tween keeps driving scale and
// `material.opacity`; the shader reads the opacity as the life envelope and
// the burst age from a uniform the tween updates.
//
// No three import: callers own the materials; this file only patches shader
// strings and holds plain `{ value }` uniform objects (node-testable).

const OFF_FORMS = new Set(["off", "0", "false", "no"]);
let _on = null;
/** `?burstFx` — DEFAULT ON; `off|0|false|no` keeps the flat placeholder bursts. */
export function burstFxEnabled(search) {
  if (typeof search === "string") {
    try {
      const v = new URLSearchParams(search).get("burstFx");
      return v == null || !OFF_FORMS.has(String(v).trim().toLowerCase());
    } catch (_) { return true; }
  }
  if (_on === null) {
    let s = "";
    try { s = globalThis.location?.search || ""; } catch (_) { s = ""; }
    _on = burstFxEnabled(s);
  }
  return _on;
}
export function setBurstFxFlag(on) { _on = on == null ? null : !!on; }

export const BURST_SHAPE_NAMES = Object.freeze(["sphere", "ring", "cube"]);

// gain, rim (boost), pow (rim power), heart (opacity inside the rim),
// swirl, freq, speed, flicker, hz, tint [r,g,b] (multiplier at end of life),
// fade (opacity exponent), edge (cube edge width in UV).
const L = (o) => Object.freeze({
  gain: 1.4, rim: 1.0, pow: 2.0, heart: 0.25, swirl: 0.3, freq: 3.0, speed: 1.5,
  flicker: 0.0, hz: 6.0, tint: [1, 1, 1], fade: 1.2, edge: 0.12, ...o,
});

export const BURST_LOOKS = Object.freeze({
  default: L({ heart: 0.15 }),
  // cast / projectile
  launch: L({ gain: 1.8, rim: 1.2, pow: 2.0, heart: 0.25, swirl: 0.35, freq: 3.0, speed: 2.5, flicker: 0.1, hz: 12, tint: [0.7, 0.85, 1.2], fade: 1.3 }),
  explode: L({ gain: 1.3, rim: 0.6, pow: 1.5, heart: 0.45, swirl: 0.5, freq: 2.5, speed: 3.0, flicker: 0.15, hz: 10, tint: [1.0, 0.45, 0.25], fade: 1.5 }),
  projectileCollision: L({ gain: 1.7, rim: 0.7, pow: 1.5, heart: 0.5, swirl: 0.5, freq: 3.0, speed: 2.0, flicker: 0.2, hz: 14, tint: [1.0, 0.5, 0.3], fade: 1.5 }),
  fizzle: L({ gain: 0.8, rim: 0.3, pow: 1.2, heart: 0.6, swirl: 0.3, freq: 3, speed: 0.8, tint: [0.8, 0.8, 0.8], fade: 1.8 }),
  // combat
  splatter: L({ gain: 0.85, rim: 0.4, pow: 1.2, heart: 0.7, swirl: 0.45, freq: 4.0, speed: -0.6, tint: [0.6, 0.3, 0.3], fade: 1.6 }),
  splatterCrit: L({ gain: 1.1, rim: 0.6, pow: 1.3, heart: 0.75, swirl: 0.55, freq: 4.5, speed: -0.8, tint: [0.65, 0.3, 0.28], fade: 1.4 }),
  spark: L({ gain: 1.8, rim: 1.0, pow: 1.5, heart: 0.5, swirl: 0.2, freq: 6.0, speed: 1.0, flicker: 0.4, hz: 22, fade: 1.2 }),
  // vitals
  healthUp: L({ gain: 1.5, rim: 1.4, pow: 2.2, heart: 0.15, swirl: 0.45, freq: 3.0, speed: 1.5, tint: [0.8, 1.15, 0.95], fade: 1.2 }),
  healthDown: L({ gain: 1.2, rim: 0.8, pow: 1.6, heart: 0.45, swirl: 0.3, freq: 3.0, speed: -1.0, flicker: 0.15, hz: 6, tint: [0.6, 0.35, 0.35], fade: 1.4 }),
  regenUp: L({ gain: 1.4, rim: 1.2, pow: 2.2, heart: 0.15, swirl: 0.3, freq: 3.5, speed: 1.5, tint: [0.85, 1.1, 0.95], fade: 1.2 }),
  regenDown: L({ gain: 1.0, rim: 0.8, pow: 1.6, heart: 0.35, swirl: 0.3, freq: 3.5, speed: -1.0, tint: [0.7, 0.45, 0.45], fade: 1.3 }),
  swapHealth: L({ gain: 1, rim: 0.6, pow: 1.4, heart: 0.3, swirl: 0.4, freq: 6.0, speed: -5.0, flicker: 0.05, hz: 8, tint: [1.0, 0.6, 1.1], fade: 1.2 }),
  // wards / buffs
  shield: L({ gain: 1.2, rim: 0.7, pow: 1.5, heart: 0.3, swirl: 0.35, freq: 6.0, speed: 4.0, flicker: 0.08, hz: 9, tint: [0.8, 0.9, 1.2], fade: 1.1 }),
  attribUp: L({ gain: 1.6, rim: 1.2, pow: 2.0, heart: 0.2, swirl: 0.3, freq: 3.0, speed: 1.8, tint: [1.0, 1.1, 0.8], fade: 1.2 }),
  attribDown: L({ gain: 1.3, rim: 0.9, pow: 1.8, heart: 0.35, swirl: 0.3, freq: 3.0, speed: -1.2, flicker: 0.1, hz: 7, tint: [0.8, 0.5, 0.4], fade: 1.3 }),
  skillUp: L({ gain: 1.15, rim: 1.3, heart: 0.08, swirl: 0.2, freq: 4.0, speed: 1.5, tint: [1.0, 1.1, 0.85], fade: 1.2, edge: 0.12 }),
  skillDown: L({ gain: 1.3, rim: 1.2, heart: 0.18, swirl: 0.2, freq: 4.0, speed: -1.0, tint: [0.8, 0.5, 0.4], fade: 1.3, edge: 0.12 }),
  enchantUp: L({ gain: 1.8, rim: 1.4, pow: 2.4, heart: 0.12, swirl: 0.5, freq: 4.0, speed: 3.0, flicker: 0.05, hz: 5, tint: [1.1, 0.95, 0.7], fade: 1.2 }),
  enchantDown: L({ gain: 1.3, rim: 1.0, pow: 2.0, heart: 0.2, swirl: 0.4, freq: 4.0, speed: -2.0, tint: [0.7, 0.6, 0.9], fade: 1.3 }),
  dispel: L({ gain: 1.5, rim: 0.9, pow: 1.4, heart: 0.3, swirl: 0.5, freq: 5.0, speed: -4.0, tint: [0.8, 0.75, 1.0], fade: 1.3 }),
  vitaeUp: L({ gain: 1.3, rim: 1.4, pow: 2.0, heart: 0.1, swirl: 0.4, freq: 3.0, speed: 3.0, flicker: 0.05, hz: 4, fade: 1.1 }),
  vitaeDown: L({ gain: 2.4, rim: 2.0, pow: 2.6, heart: 0.08, swirl: 0.5, freq: 3.0, speed: -2.0, tint: [0.7, 0.7, 1.1], fade: 0.9 }),
  // presence
  death: L({ gain: 1.3, rim: 1.6, pow: 3.0, heart: 0.05, swirl: 0.6, freq: 2.0, speed: -2.0, tint: [0.5, 0.2, 0.6], fade: 0.8 }),
  create: L({ gain: 1.4, rim: 1.6, pow: 2.5, heart: 0.08, swirl: 0.5, freq: 4.0, speed: -3.0, fade: 1.0 }),
  hide: L({ gain: 0.9, rim: 1.2, pow: 2.5, heart: 0.05, swirl: 0.5, freq: 3.0, speed: 1.0, fade: 1.0 }),
  portal: L({ gain: 1.9, rim: 1.6, pow: 2.0, heart: 0.15, swirl: 0.8, freq: 3.0, speed: 4.0, flicker: 0.06, hz: 5, tint: [0.8, 0.6, 1.2], fade: 1.0 }),
  portalStorm: L({ gain: 1, rim: 0.8, pow: 2, heart: 0.12, swirl: 0.7, freq: 4.0, speed: 6.0, flicker: 0.2, hz: 16, fade: 1.2 }),
  camping: L({ gain: 1.3, rim: 1.2, pow: 2.2, heart: 0.15, swirl: 0.3, freq: 2.0, speed: 1.0, flicker: 0.15, hz: 2, fade: 1.0 }),
  layingOfHands: L({ gain: 1.5, rim: 1.4, pow: 2.2, heart: 0.12, swirl: 0.35, freq: 2.5, speed: 1.5, flicker: 0.1, hz: 2, tint: [0.9, 1.05, 1.1], fade: 1.0 }),
  // breath weapons
  breatheFlame: L({ gain: 1.4, rim: 0.6, pow: 1.4, heart: 0.55, swirl: 0.6, freq: 3.0, speed: 5.0, flicker: 0.2, hz: 12, tint: [1.0, 0.5, 0.3], fade: 1.4 }),
  breatheFrost: L({ gain: 1.6, rim: 0.9, pow: 1.6, heart: 0.45, swirl: 0.5, freq: 3.5, speed: 3.0, flicker: 0.05, hz: 6, tint: [0.8, 0.95, 1.2], fade: 1.3 }),
  breatheAcid: L({ gain: 1.5, rim: 0.7, pow: 1.4, heart: 0.5, swirl: 0.6, freq: 4.0, speed: 2.5, flicker: 0.1, hz: 8, tint: [0.8, 1.1, 0.6], fade: 1.4 }),
  breatheLightning: L({ gain: 1.35, rim: 0.8, pow: 1.5, heart: 0.4, swirl: 0.4, freq: 6.0, speed: 8.0, flicker: 0.5, hz: 24, fade: 1.2 }),
  // status / events
  specialState: L({ gain: 1.6, rim: 1.2, pow: 2.0, heart: 0.2, swirl: 0.2, freq: 3.0, speed: 1.0, fade: 1.2 }),
  specialStateBlack: L({ gain: 1.2, rim: 1.4, pow: 2.4, heart: 0.3, swirl: 0.3, freq: 3.0, speed: -1.0, fade: 1.2 }),
  levelUp: L({ gain: 1.35, rim: 1.8, pow: 2.0, heart: 0.12, swirl: 0.3, freq: 3.0, speed: 2.0, flicker: 0.1, hz: 4, tint: [1.1, 1.0, 0.75], fade: 0.9 }),
  augmentation: L({ gain: 1.15, rim: 1.1, pow: 2.0, heart: 0.12, swirl: 0.5, freq: 3.0, speed: 2.5, flicker: 0.08, hz: 4, tint: [1.1, 1.0, 0.8], fade: 0.95 }),
  aetheria: L({ gain: 1.8, rim: 1.4, pow: 2.2, heart: 0.15, swirl: 0.5, freq: 4.0, speed: 3.0, flicker: 0.1, hz: 6, fade: 1.1 }),
  restriction: L({ gain: 1.5, rim: 1.4, pow: 2.6, heart: 0.1, swirl: 0.3, freq: 5.0, speed: 0.5, fade: 1.2 }),
  wedding: L({ gain: 1.7, rim: 1.4, pow: 2.0, heart: 0.15, swirl: 0.4, freq: 3.0, speed: 2.0, flicker: 0.12, hz: 3, tint: [1.1, 0.95, 1.05], fade: 1.0 }),
  bunnySmite: L({ gain: 1.6, rim: 1.2, pow: 2.0, heart: 0.2, swirl: 0.4, freq: 3.0, speed: 2.0, flicker: 0.1, hz: 5, fade: 1.2 }),
  baelZharonSmite: L({ gain: 1.6, rim: 1.8, pow: 2.8, heart: 0.08, swirl: 0.7, freq: 2.5, speed: -3.0, flicker: 0.12, hz: 7, tint: [0.7, 0.25, 0.35], fade: 0.85 }),
  blackMadness: L({ gain: 2.0, rim: 2.0, pow: 2.8, heart: 0.06, swirl: 0.7, freq: 3.0, speed: -2.5, flicker: 0.15, hz: 9, tint: [0.7, 0.4, 0.9], fade: 0.9 }),
  dirtyFighting: L({ gain: 1.3, rim: 1.3, heart: 0.15, swirl: 0.3, freq: 4.0, speed: -1.0, flicker: 0.1, hz: 8, tint: [0.75, 0.5, 0.45], fade: 1.3, edge: 0.14 }),
});

/** Plain-number uniform layout (A,B,C,D vec4s) for a look + seed. Pure. */
export function burstLookVectors(lookName, seed = 0) {
  const k = BURST_LOOKS[lookName] || BURST_LOOKS.default;
  const s = Number.isFinite(seed) ? seed - Math.floor(seed) : 0;
  return {
    A: [k.gain, k.rim, k.pow, k.heart],
    B: [k.swirl, k.freq, k.speed, k.flicker],
    C: [k.tint[0], k.tint[1], k.tint[2], k.fade],
    D: [k.hz, k.edge, s, 0],
  };
}

// Shared time (seconds, wrapped like particle_fx so GPU phases stay precise).
export const BURST_TIME = { value: 0 };
export function burstFxFrame(nowMs) {
  const now = Number.isFinite(nowMs) ? nowMs : (typeof performance !== "undefined" ? performance.now() : 0);
  BURST_TIME.value = (now / 1000) % 1024;
}

const VERT_PARS = /* glsl */`
varying vec3 vBxN;
varying vec3 vBxV;
varying vec3 vBxP;
varying vec2 vBxUv;
`;
const VERT_BODY = /* glsl */`
	vBxN = normalize( normalMatrix * normal );
	vBxV = -mvPosition.xyz;
	vBxP = position;
	vBxUv = uv;
`;
const FRAG_PARS = /* glsl */`
uniform vec4 uBxA;
uniform vec4 uBxB;
uniform vec4 uBxC;
uniform vec4 uBxD;
uniform float uBxTime;
varying vec3 vBxN;
varying vec3 vBxV;
varying vec3 vBxP;
varying vec2 vBxUv;
float hbBxHash( float p ) {
	p = fract( p * 0.1031 );
	p *= p + 33.33;
	p *= p + p;
	return fract( p );
}
float hbBxHash3( vec3 p ) {
	p = fract( p * 0.1031 );
	p += dot( p, p.zyx + 31.32 );
	return fract( ( p.x + p.y ) * p.z );
}
float hbBxNoise( vec3 x ) {
	vec3 i = floor( x );
	vec3 f = fract( x );
	f = f * f * ( 3.0 - 2.0 * f );
	return mix(
		mix( mix( hbBxHash3( i ), hbBxHash3( i + vec3( 1.0, 0.0, 0.0 ) ), f.x ),
		     mix( hbBxHash3( i + vec3( 0.0, 1.0, 0.0 ) ), hbBxHash3( i + vec3( 1.0, 1.0, 0.0 ) ), f.x ), f.y ),
		mix( mix( hbBxHash3( i + vec3( 0.0, 0.0, 1.0 ) ), hbBxHash3( i + vec3( 1.0, 0.0, 1.0 ) ), f.x ),
		     mix( hbBxHash3( i + vec3( 0.0, 1.0, 1.0 ) ), hbBxHash3( i + vec3( 1.0, 1.0, 1.0 ) ), f.x ), f.y ),
		f.z );
}
`;
// Replaces <color_fragment> (a no-op for these vertex-colour-less materials).
const FRAG_BODY = /* glsl */`
	{
		float bxAge = clamp( uBxD.w, 0.0, 1.0 );
		vec3 bxN = normalize( vBxN );
		vec3 bxV = normalize( vBxV );
		float bxFacing = abs( dot( bxN, bxV ) );
	#if HB_BURST_SHAPE == 0
		float bxEdge = pow( 1.0 - bxFacing, max( uBxA.z, 0.1 ) );
	#elif HB_BURST_SHAPE == 1
		float bxEdge = pow( bxFacing, max( uBxA.z, 0.1 ) );
	#else
		vec2 bxE2 = min( vBxUv, 1.0 - vBxUv );
		float bxEdge = 1.0 - smoothstep( 0.0, max( uBxD.y, 1e-3 ), min( bxE2.x, bxE2.y ) );
	#endif
		float bxShell = mix( uBxA.w, 1.0, bxEdge );
		float bxGlow = 1.0 + uBxA.y * bxEdge;
		float bxSw = 1.0;
		if ( uBxB.x > 0.0 ) {
			float bxNz = hbBxNoise( vBxP * uBxB.y + vec3( uBxD.z * 7.0, uBxD.z * 3.0, -uBxTime * uBxB.z ) );
			bxSw = max( 0.0, 1.0 + uBxB.x * ( 2.0 * bxNz - 1.0 ) );
		}
		float bxFl = 1.0;
		if ( uBxB.w > 0.0 ) {
			float bxF = uBxTime * uBxD.x + uBxD.z * 13.0;
			float bxI = floor( bxF );
			float bxT = fract( bxF );
			float bxNo = mix( hbBxHash( bxI ), hbBxHash( bxI + 1.0 ), bxT * bxT * ( 3.0 - 2.0 * bxT ) );
			bxFl = max( 0.0, 1.0 + uBxB.w * ( 2.0 * bxNo - 1.0 ) );
		}
		vec3 bxTint = mix( vec3( 1.0 ), uBxC.rgb, bxAge );
		diffuseColor.rgb *= bxTint * uBxA.x * bxGlow * bxSw * bxFl;
		diffuseColor.a = clamp( pow( max( diffuseColor.a, 0.0 ), max( uBxC.w, 0.05 ) ) * bxShell * min( bxSw, 1.5 ), 0.0, 1.0 );
	}
`;

/** Rewrite a MeshBasicMaterial shader object in place. True when every anchor matched. */
export function patchBurstFxShader(shader, uniforms) {
  if (!shader || typeof shader.vertexShader !== "string" || typeof shader.fragmentShader !== "string") return false;
  const v = shader.vertexShader, f = shader.fragmentShader;
  if (!v.includes("#include <common>") || !v.includes("#include <project_vertex>") ||
      !f.includes("#include <common>") || !f.includes("#include <color_fragment>")) return false;
  shader.vertexShader = v
    .replace("#include <common>", `#include <common>\n${VERT_PARS}`)
    .replace("#include <project_vertex>", `#include <project_vertex>\n${VERT_BODY}`);
  shader.fragmentShader = f
    .replace("#include <common>", `#include <common>\n${FRAG_PARS}`)
    .replace("#include <color_fragment>", FRAG_BODY);
  if (uniforms) {
    shader.uniforms.uBxA = uniforms.uBxA;
    shader.uniforms.uBxB = uniforms.uBxB;
    shader.uniforms.uBxC = uniforms.uBxC;
    shader.uniforms.uBxD = uniforms.uBxD;
  }
  shader.uniforms.uBxTime = BURST_TIME;
  return true;
}

const _v4 = (a) => ({ x: a[0], y: a[1], z: a[2], w: a[3], set(x, y, z, w) { this.x = x; this.y = y; this.z = z; this.w = w; return this; } });

/**
 * Patch a burst material for `shape` (0 sphere, 1 ring, 2 cube). Idempotent.
 * `makeVec4` builds the uniform vectors (pass `(…) => new THREE.Vector4(…)`
 * from three-aware callers; the plain fallback works for tests).
 * @returns {boolean}
 */
export function applyBurstFxMaterial(mat, shape, makeVec4) {
  if (!mat || mat.isMeshBasicMaterial !== true || mat.wireframe === true) return false;
  if (mat.userData && mat.userData.__burstFx) return true;
  const s = shape === 1 || shape === 2 ? shape : 0;
  const mk = typeof makeVec4 === "function" ? makeVec4 : (x, y, z, w) => _v4([x, y, z, w]);
  const u = {
    uBxA: { value: mk(1, 0, 1, 1) },
    uBxB: { value: mk(0, 1, 0, 0) },
    uBxC: { value: mk(1, 1, 1, 1) },
    uBxD: { value: mk(6, 0.12, 0, 0) },
  };
  mat.defines = { ...(mat.defines || {}), HB_BURST_SHAPE: s };
  mat.onBeforeCompile = function hbBurstFx(shader) { patchBurstFxShader(shader, u); };
  const key = `hbBurstFx1|${s}`;
  mat.customProgramCacheKey = () => key;
  mat.userData = mat.userData || {};
  mat.userData.__burstFx = { shape: s, uniforms: u, look: "default" };
  mat.needsUpdate = true;
  return true;
}

/** Set a patched material's look (uniform values only — no recompile). */
export function setBurstLook(mat, lookName, seed) {
  const fx = mat && mat.userData && mat.userData.__burstFx;
  if (!fx) return false;
  const v = burstLookVectors(lookName, seed);
  fx.uniforms.uBxA.value.set(v.A[0], v.A[1], v.A[2], v.A[3]);
  fx.uniforms.uBxB.value.set(v.B[0], v.B[1], v.B[2], v.B[3]);
  fx.uniforms.uBxC.value.set(v.C[0], v.C[1], v.C[2], v.C[3]);
  fx.uniforms.uBxD.value.set(v.D[0], v.D[1], v.D[2], 0);
  fx.look = BURST_LOOKS[lookName] ? lookName : "default";
  return true;
}

/** Per-frame burst age (0..1) for a patched material. */
export function setBurstAge(mat, t) {
  const fx = mat && mat.userData && mat.userData.__burstFx;
  if (!fx) return;
  fx.uniforms.uBxD.value.w = t < 0 ? 0 : (t > 1 ? 1 : t);
}
