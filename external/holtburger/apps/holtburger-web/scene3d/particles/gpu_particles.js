// scene3d/particles/gpu_particles.js — `?gpuParticles` (round 3 R3-7a,
// 2026-10-30; DEFAULT OFF, `on`/`1`/`true`/`yes` opts in).
//
// Particle motion evaluated in the bucket vertex shader. Plan:
// docs/2026-10-29-round3-gpu-driven.md R3-7a. Design (the contract, the record
// layout, the precision argument, the proof plan):
// /mnt/wbterminal1/tmp/claude-scratch/rustcore-2026-10-29/r3-7a/design/design.md
//
// WHAT CHANGES (flag on, eligible emitters only):
//   - Emission is today's code: `emitParticle` -> `Particle.init` with the same
//     RNG draws in the same order and the same slot. After it, ONE spawn record
//     (8 RGBA32F texels) is written into the shared record table `uGpRec`.
//   - Per tick the CPU runs only the lifetime half of `Particle.update` (the
//     exact f64 accumulation) and `killParticle`, so kill ticks, slot reuse and
//     every emission decision stay bit-identical. No carrier mesh is written per
//     frame and no billboard math runs on the CPU.
//   - The append branch writes the record INDEX of each live, visible slot into
//     the bucket's `instanceColor.r`, in today's order. Alpha buckets also get the
//     f64 twin position (bit-identical to `Particle.update`) for today's
//     back-to-front sort; kid rows get the twin for `ParticleFxKids.pushParticle`.
//   - The bucket vertex shader (GP_GLSL_HEADER) decodes the record and the
//     per-frame rows (`uGpRow`: one manager row per tick, one row per drawn
//     moving parent-local emitter), evaluates particle.js's closed forms, the
//     scale / translucency lerps and the billboard modes, and hands three's
//     chunks and the unchanged FX / fog / glow patches the same
//     `instanceMatrix` / `instanceColor` they read today through a #define.
// Flag off: nothing here runs. No texture, listener, global or scratch (manager
// slots, camera matrices, self-check memo; particle_manager.js's append
// scratch) exists until the flag-on path first needs it; module load only
// builds the frozen layout tables and the GLSL strings. particle_manager.js
// gates every hook behind one memoised `_gpOn()` per tick (typeof-guarded:
// test_particles.mjs concatenates the particle modules and strips their local
// imports).
//
// NOT bit-identical by design (HOW changes, docs: url-flags.md row):
//   - the FX seed is drawn at spawn (`particleFxDrawSeed`, the same xorshift
//     stream in another order);
//   - `?fxMotion` stretch reads the analytic velocity at t - 1.5 dt instead of
//     the smoothed finite difference;
//   - degenerate billboards (camera inside a particle, viewer line parallel to
//     the kept axis) fall back to identity / the GR frame instead of keeping
//     last tick's orientation; positions are formed in f32 on the GPU.
// The shader calls no driver sin / cos (2026-10-31 smoke: SwiftShader's are an
// order-5 polynomial, 1.3e-4 relative, 2.5 mm on a 12.6 m Swarm amplitude):
// `hbGpSinCos` reduces by quadrant and evaluates the cephes polynomials with
// + - * floor only, so every driver agrees with the f32 twin to ~1e-7.

import * as THREE from "three";

import { rustFlag } from "../rust/scene_core.js";
import { currentTime } from "./time_rng.js";
import { ParticleEmitter, particleFrozenPartFastEnabled } from "./particle_emitter.js";
import { particleLegacyFlags } from "./particle.js";
import {
  patchParticleFxShader,
  particleFxDrawSeed,
  particleFxEnabled,
  particleFxLive,
  particleFxTeleportSpeedSq,
} from "./particle_fx.js";

// ---------------------------------------------------------------------------
// Flag
// ---------------------------------------------------------------------------

/**
 * `?gpuParticles` — DEFAULT OFF. `on`/`1`/`true`/`yes` opt in; `off`/`0`/
 * `false`/`no`, absent or anything else read OFF. Memoised by `rustFlag`
 * (scene3d/rust/scene_core.js); test seam `__setRustFlagForTest("gpuParticles", on)`.
 */
export function gpuParticlesEnabled() {
  return rustFlag("gpuParticles", false);
}

// ---------------------------------------------------------------------------
// Layout (normative; the GLSL below and tests/helpers/gpu_particles_f32.mjs read it)
// ---------------------------------------------------------------------------

/** Texture width in texels (WebGL2's guaranteed MAX_TEXTURE_SIZE). */
export const GP_WIDTH = 2048;
/** Texels per record / row. */
export const GP_TEXELS = 8;
/** Records (rows) per texture row. */
export const GP_PER_ROW = GP_WIDTH / GP_TEXELS;
/** Floats per record / row. */
export const GP_FLOATS = GP_TEXELS * 4;

/** Spawn record texels (`uGpRec`). */
export const GP_REC = Object.freeze({
  BASE: 0,   // base.xyz (startPos + off, or off when parent-local), Thi
  A: 1,      // A.xyz, lifespan
  B: 2,      // B.xyz, Tlo
  C: 3,      // C.xyz, FX seed
  Q: 4,      // start-frame quaternion (non-parent-local GR; else identity)
  LERP: 5,   // startScale, finalScale, startTrans, finalTrans
  EROW: 6,   // emitter row index, 0, 0, 0
  SPIN: 7,   // spin axis xyz, rate |C| (GR; else 0)
});

/** Per-frame row texels (`uGpRow`). Row 0 global, rows 1..8 managers, 9+ emitters. */
export const GP_ROW = Object.freeze({
  GLOBAL: 0,
  MANAGER0: 1,
  MANAGERS: 8,
  EMITTER0: 9,
  // manager row texels
  M_CLOCK: 0,    // Chi, Clo, dtTick, bbOn
  M_CAMLOCAL: 1, // camera in _scene-local space (retail degrade-mode billboards)
  M_CAMWORLD: 2, // camera.position (the POJO sprite billboard's quirk)
  // emitter row texels
  E_ANCHOR: 0,   // anchor position xyz, manager row
  E_QUAT: 1,     // anchor quaternion
  E_VEL: 2,      // anchor velocity xyz, FX row
  E_STATIC: 3,   // particleType, parentLocal, bbMode (0, 2-5, 6 = POJO sprite), velLimitSq
  E_NORMAL: 4,   // POJO sprite quad normal xyz
});

/** Seconds after which a manager epoch is rebased (exact hi/lo below 16,384 s). */
export const GP_REBASE_SECONDS_DEFAULT = 8192;
let _rebaseSeconds = GP_REBASE_SECONDS_DEFAULT;
/** Test / fallback seam (design §5: a 32 s rebase if a driver reassociates). */
export function setGpRebaseSeconds(s) {
  _rebaseSeconds = Number.isFinite(s) && s > 0 ? s : GP_REBASE_SECONDS_DEFAULT;
  return _rebaseSeconds;
}

/** Split a time (s, relative to the epoch) into an exact f32 hi (multiple of 1/1024) + lo. */
export function gpSplitTime(t, out, o = 0) {
  const hi = Math.floor(t * 1024) / 1024;
  out[o] = hi;
  out[o + 1] = t - hi;
  return out;
}

// ---------------------------------------------------------------------------
// GLSL (no backticks, quotes or non-ASCII anywhere in it: house rule + H2)
// ---------------------------------------------------------------------------

export const GP_MARKER = "// HB_GP_PARTICLES r3-7a";
export const GP_KEY_STOCK_ADD = "hbParticleGpAdd";
export const GP_KEY_SUFFIX = "|gp";

/**
 * The header prepended to every gpu bucket vertex program (and the glow twin).
 * `hbGpEval()` runs as main's first statement and fills `hbGpIm` / `hbGpIc`,
 * which the #define redirect hands to three's chunks and the FX / fog / glow
 * patches in place of the instance attributes.
 */
export const GP_GLSL_HEADER = [
  GP_MARKER,
  "// particle motion evaluated in the vertex shader (scene3d/particles/gpu_particles.js)",
  "#if defined( USE_INSTANCING ) && defined( USE_INSTANCING_COLOR )",
  "uniform highp sampler2D uGpRec;",
  "uniform highp sampler2D uGpRow;",
  "vec3 hbGpRawIndex() { return instanceColor; }",
  "mat4 hbGpIm;",
  "vec3 hbGpIc;",
  "#define instanceMatrix hbGpIm",
  "#define instanceColor hbGpIc",
  "ivec2 hbGpAt( int i, int k ) {",
  "\tint q = i / 256;",
  "\treturn ivec2( ( i - q * 256 ) * 8 + k, q );",
  "}",
  "vec4 hbGpR( int i, int k ) { return texelFetch( uGpRec, hbGpAt( i, k ), 0 ); }",
  "vec4 hbGpE( int i, int k ) { return texelFetch( uGpRow, hbGpAt( i, k ), 0 ); }",
  "// sin and cos from + - * floor only: GLSL ES 3.00 leaves the builtins precision",
  "// open (SwiftShader: an order-5 polynomial, 1.3e-4 relative near 0, 1.9e-4 absolute;",
  "// Vulkan allows 2^-11, D3D11 8e-4), times a Swarm amplitude of metres. Cody-Waite",
  "// quadrant reduction, pi / 2 = 1.5703125 + 0.00048382679 (k * 1.5703125 exact for",
  "// k below 2^16), then the cephes sinf / cosf minimax polynomials on [-pi / 4, pi / 4].",
  "vec2 hbGpSinCos( float x ) {",
  "\tfloat k = floor( x * 0.63661977 + 0.5 );",
  "\tfloat r = ( x - k * 1.5703125 ) - k * 0.00048382679;",
  "\tfloat z = r * r;",
  "\tfloat s = ( ( -1.9515295891e-4 * z + 8.3321608736e-3 ) * z - 1.6666654611e-1 ) * z * r + r;",
  "\tfloat c = ( ( 2.443315711809948e-5 * z - 1.388731625493765e-3 ) * z + 4.166664568298827e-2 ) * z * z - 0.5 * z + 1.0;",
  "\tfloat q = k - 4.0 * floor( k * 0.25 );",
  "\tif ( q == 1.0 ) return vec2( c, -s );",
  "\tif ( q == 2.0 ) return vec2( -s, -c );",
  "\tif ( q == 3.0 ) return vec2( -c, s );",
  "\treturn vec2( s, c );",
  "}",
  "float hbGpSin( float x ) { return hbGpSinCos( x ).x; }",
  "float hbGpCos( float x ) { return hbGpSinCos( x ).y; }",
  "vec4 hbGpQMul( vec4 a, vec4 b ) {",
  "\treturn vec4( a.x * b.w + a.w * b.x + a.y * b.z - a.z * b.y,",
  "\t\ta.y * b.w + a.w * b.y + a.z * b.x - a.x * b.z,",
  "\t\ta.z * b.w + a.w * b.z + a.x * b.y - a.y * b.x,",
  "\t\ta.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z );",
  "}",
  "mat3 hbGpQMat( vec4 q ) {",
  "\tfloat x2 = q.x + q.x;",
  "\tfloat y2 = q.y + q.y;",
  "\tfloat z2 = q.z + q.z;",
  "\tfloat xx = q.x * x2;",
  "\tfloat xy = q.x * y2;",
  "\tfloat xz = q.x * z2;",
  "\tfloat yy = q.y * y2;",
  "\tfloat yz = q.y * z2;",
  "\tfloat zz = q.z * z2;",
  "\tfloat wx = q.w * x2;",
  "\tfloat wy = q.w * y2;",
  "\tfloat wz = q.w * z2;",
  "\treturn mat3( 1.0 - ( yy + zz ), xy + wz, xz - wy,",
  "\t\txy - wz, 1.0 - ( xx + zz ), yz + wx,",
  "\t\txz + wy, yz - wx, 1.0 - ( xx + yy ) );",
  "}",
  "vec4 hbGpUnitVectors( vec3 f, vec3 t ) {",
  "\tfloat r = dot( f, t ) + 1.0;",
  "\tvec4 q;",
  "\tif ( r < 1e-8 ) q = abs( f.x ) > abs( f.z ) ? vec4( -f.y, f.x, 0.0, 0.0 ) : vec4( 0.0, -f.z, f.y, 0.0 );",
  "\telse q = vec4( cross( f, t ), r );",
  "\treturn normalize( q );",
  "}",
  "void hbGpEval() {",
  "\thbGpIm = mat4( 0.0 );",
  "\thbGpIc = vec3( 0.0 );",
  "\tint rec = int( hbGpRawIndex().x + 0.5 );",
  "\tif ( rec <= 0 ) return;",
  "\tvec4 r0 = hbGpR( rec, 0 );",
  "\tvec4 r1 = hbGpR( rec, 1 );",
  "\tvec4 r2 = hbGpR( rec, 2 );",
  "\tvec4 r3 = hbGpR( rec, 3 );",
  "\tvec4 r5 = hbGpR( rec, 5 );",
  "\tvec4 r6 = hbGpR( rec, 6 );",
  "\tint er = int( r6.x + 0.5 );",
  "\tvec4 e0 = hbGpE( er, 0 );",
  "\tvec4 e2 = hbGpE( er, 2 );",
  "\tvec4 e3 = hbGpE( er, 3 );",
  "\tint mr = int( e0.w + 0.5 );",
  "\tvec4 m0 = hbGpE( mr, 0 );",
  "\t// age = (Chi - Thi) + (Clo - Tlo): exact hi parts, f32-relative age",
  "\tfloat t = ( m0.x - r0.w ) + ( m0.y - r2.w );",
  "\tfloat ls = r1.w;",
  "\tfloat iv = ls > 0.0 ? min( t / ls, 1.0 ) : 1.0;",
  "\tfloat sc = r5.x + ( r5.y - r5.x ) * iv;",
  "\tfloat tr = r5.z + ( r5.w - r5.z ) * iv;",
  "\tif ( !( tr < 1.0 ) || sc == 0.0 ) return;",
  "\tfloat op = clamp( 1.0 - tr, 0.0, 1.0 );",
  "\tint ty = int( e3.x + 0.5 );",
  "\tbool pl = e3.y > 0.5;",
  "\tvec3 A = r1.xyz;",
  "\tvec3 B = r2.xyz;",
  "\tvec3 C = r3.xyz;",
  "\tvec3 P = pl ? e0.xyz + r0.xyz : r0.xyz;",
  "\tfloat tv = max( t - 1.5 * m0.z, 0.0 );",
  "\tvec3 V = vec3( 0.0 );",
  "\tif ( ty == 2 || ty == 12 ) {",
  "\t\tP += t * A;",
  "\t\tV = A;",
  "\t} else if ( ty == 3 || ty == 8 || ty == 10 || ty == 4 || ty == 9 || ty == 11 ) {",
  "\t\tP += t * A + ( t * t * 0.5 ) * B;",
  "\t\tV = A + tv * B;",
  "\t} else if ( ty == 5 ) {",
  "\t\t// Swarm: y uses sin (retail quirk, kept); C is the amplitude",
  "\t\tP += vec3( hbGpCos( t * B.x ) * C.x, hbGpSin( t * B.y ) * C.y, hbGpCos( t * B.z ) * C.z ) + t * A;",
  "\t\tV = A + vec3( -B.x * hbGpSin( tv * B.x ) * C.x, B.y * hbGpCos( tv * B.y ) * C.y, -B.z * hbGpSin( tv * B.z ) * C.z );",
  "\t} else if ( ty == 6 ) {",
  "\t\t// Explode: (t B + C A.x) t, z adds A.z inside",
  "\t\tP += ( t * B + C * A.x + vec3( 0.0, 0.0, A.z ) ) * t;",
  "\t\tV = 2.0 * tv * B + C * A.x + vec3( 0.0, 0.0, A.z );",
  "\t} else if ( ty == 7 ) {",
  "\t\t// Implode: cos(A.x t) C + t t B (C is the multiplied offset)",
  "\t\tP += hbGpCos( A.x * t ) * C + ( t * t ) * B;",
  "\t\tV = -A.x * hbGpSin( A.x * tv ) * C + 2.0 * tv * B;",
  "\t}",
  "\tmat3 R = mat3( 1.0 );",
  "\tif ( ty == 4 || ty == 9 || ty == 11 ) {",
  "\t\tvec4 qf = pl ? hbGpE( er, 1 ) : hbGpR( rec, 4 );",
  "\t\tvec4 r7 = hbGpR( rec, 7 );",
  "\t\tfloat th = r7.w * t;",
  "\t\tvec4 sp = vec4( 0.0, 0.0, 0.0, 1.0 );",
  "\t\tif ( th >= 0.0002 ) {",
  "\t\t\tvec2 h = hbGpSinCos( 0.5 * th );",
  "\t\t\tsp = vec4( r7.xyz * h.x, h.y );",
  "\t\t}",
  "\t\tR = hbGpQMat( normalize( hbGpQMul( qf, sp ) ) );",
  "\t}",
  "\tint bb = int( e3.z + 0.5 );",
  "\tif ( bb != 0 && m0.w > 0.5 ) {",
  "\t\tif ( bb == 6 ) {",
  "\t\t\tvec3 d6 = hbGpE( mr, 2 ).xyz - P;",
  "\t\t\tif ( dot( d6, d6 ) >= 1e-10 ) R = hbGpQMat( hbGpUnitVectors( hbGpE( er, 4 ).xyz, normalize( d6 ) ) );",
  "\t\t} else {",
  "\t\t\tvec3 d = P - hbGpE( mr, 1 ).xyz;",
  "\t\t\tif ( dot( d, d ) >= 1e-10 ) {",
  "\t\t\t\td = normalize( d );",
  "\t\t\t\tif ( bb == 2 ) {",
  "\t\t\t\t\tvec3 z = vec3( 0.0, 0.0, 1.0 ) - d * d.z;",
  "\t\t\t\t\tif ( dot( z, z ) >= 1e-10 ) {",
  "\t\t\t\t\t\tz = normalize( z );",
  "\t\t\t\t\t\tR = mat3( cross( d, z ), d, z );",
  "\t\t\t\t\t}",
  "\t\t\t\t} else {",
  "\t\t\t\t\tvec3 keep = normalize( bb == 5 ? R[ 2 ] : ( bb == 4 ? R[ 1 ] : R[ 0 ] ) );",
  "\t\t\t\t\tvec3 aim = d - keep * dot( d, keep );",
  "\t\t\t\t\tif ( dot( aim, aim ) >= 1e-10 ) {",
  "\t\t\t\t\t\taim = normalize( aim );",
  "\t\t\t\t\t\tvec3 third = cross( aim, keep );",
  "\t\t\t\t\t\tif ( bb == 5 ) R = mat3( third, aim, keep );",
  "\t\t\t\t\t\telse if ( bb == 4 ) R = mat3( aim, keep, third );",
  "\t\t\t\t\t\telse R = mat3( keep, third, aim );",
  "\t\t\t\t\t}",
  "\t\t\t\t}",
  "\t\t\t}",
  "\t\t}",
  "\t}",
  "\thbGpIm = mat4( vec4( R[ 0 ] * sc, 0.0 ), vec4( R[ 1 ] * sc, 0.0 ), vec4( R[ 2 ] * sc, 0.0 ), vec4( P, 1.0 ) );",
  "\t#ifdef HB_FX_MOTION",
  "\tif ( pl ) V += e2.xyz;",
  "\tif ( t < 0.5 * m0.z || dot( V, V ) > e3.w ) V = vec3( 0.0 );",
  "\thbGpIm[ 0 ][ 3 ] = V.x;",
  "\thbGpIm[ 1 ][ 3 ] = V.y;",
  "\thbGpIm[ 2 ][ 3 ] = V.z;",
  "\t#endif",
  "\t#ifdef HB_GP_FXCOLOR",
  "\tfloat fa = ls > 0.0 ? clamp( t / ls, 0.0, 1.0 ) : 0.0;",
  "\thbGpIc = vec3( op, fa, ( hbGpE( 0, 0 ).x > 0.5 ? e2.w : 0.0 ) + r3.w );",
  "\t#else",
  "\thbGpIc = vec3( op );",
  "\t#endif",
  "}",
  "#endif",
  "",
].join("\n");

/** The statement injected as main's first. */
export const GP_GLSL_CALL = "\n#if defined( USE_INSTANCING ) && defined( USE_INSTANCING_COLOR )\n\thbGpEval();\n#endif";
const GP_FXCOLOR_DEFINE = "#define HB_GP_FXCOLOR\n";
const MAIN = "void main() {";
const DEFINE_IM_RE = /^([ \t]*)#define instanceMatrix /gm;

/**
 * Patch a vertex shader object in place (onBeforeCompile seam; the gpu_batch
 * kit's `injectVertexHeader` shape, copied so the flag-off module graph only
 * gains this file): prepend the header (+ HB_GP_FXCOLOR for FX materials),
 * call `hbGpEval()` first in main, and put `#undef instanceMatrix` in front of
 * every later `#define instanceMatrix` (FX's `hbFxIm` under HB_FX_MOTION /
 * HB_FX_CLAMP; GLSL ES 3.00 forbids redefining a macro with another body).
 * Idempotent. Returns false (shader untouched) when main is missing.
 */
export function patchGpVertexShader(shader, fx = false) {
  const vs = shader && shader.vertexShader;
  if (typeof vs !== "string") return false;
  if (vs.indexOf(GP_MARKER) !== -1) return true;
  const at = vs.indexOf(MAIN);
  if (at === -1) return false;
  let body = vs.slice(0, at) + MAIN + GP_GLSL_CALL + vs.slice(at + MAIN.length);
  body = body.replace(DEFINE_IM_RE, "$1#undef instanceMatrix\n$1#define instanceMatrix ");
  shader.vertexShader = (fx ? GP_FXCOLOR_DEFINE : "") + GP_GLSL_HEADER + body;
  return true;
}

/** Structural check of a patched vertex source (self-check + tests H1). */
export function gpVerifyPatchedVertex(vs) {
  if (typeof vs !== "string") return false;
  const first = vs.indexOf(GP_MARKER);
  if (first === -1 || vs.indexOf(GP_MARKER, first + 1) !== -1) return false;
  const common = vs.indexOf("#include <common>");
  if (common !== -1 && common < first) return false;
  const main = vs.indexOf(MAIN);
  if (main === -1 || vs.slice(main + MAIN.length, main + MAIN.length + GP_GLSL_CALL.length) !== GP_GLSL_CALL) return false;
  const headerEnd = first + GP_GLSL_HEADER.length;
  const lines = vs.slice(headerEnd).split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (/^[ \t]*#define instanceMatrix /.test(lines[i]) && !(i > 0 && /^[ \t]*#undef instanceMatrix\s*$/.test(lines[i - 1]))) return false;
  }
  return true;
}

// Shared uniform objects (every gpu program binds these by identity).
export const GP_UNIFORMS = {
  uGpRec: { value: null },
  uGpRow: { value: null },
};

let _watchedRenderer = null;
function _watchRenderer(renderer) {
  if (!renderer || renderer === _watchedRenderer) return;
  _watchedRenderer = renderer;
  // A restored context re-allocates every texture; its first upload must be
  // whole, never this frame's ranges only.
  try {
    renderer.domElement?.addEventListener?.("webglcontextrestored", () => {
      if (_recs) _recs.markFresh();
      if (_rows) _rows.markFresh();
    });
  } catch (_) { /* no canvas (node) */ }
}

const _hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/**
 * Turn a bucket (or glow twin) material into its gpu variant: wrap its
 * onBeforeCompile (the previous hook runs first, then the vertex patch) and
 * key it `previous key + |gp` (the stock additive bucket, which has no key of
 * its own, gets `hbParticleGpAdd`). Must run BEFORE applyAdditiveParticleFog:
 * the fog's live switch restores the hook it saved at its first apply.
 * @returns {boolean} true when the material is (now) a gpu material
 */
export function applyGpParticleMaterial(mat, { fx = false } = {}) {
  if (!mat) return false;
  const ud = mat.userData || (mat.userData = {});
  if (ud.__gpParticles === true) return true;
  const prevObc = _hasOwn(mat, "onBeforeCompile") ? mat.onBeforeCompile : null;
  const prevKey = _hasOwn(mat, "customProgramCacheKey") ? mat.customProgramCacheKey : null;
  const base = typeof prevKey === "function" ? String(prevKey.call(mat)) : null;
  const key = base !== null ? base + GP_KEY_SUFFIX : GP_KEY_STOCK_ADD;
  const isFx = fx === true;
  mat.onBeforeCompile = function hbGpParticles(shader, renderer) {
    if (typeof prevObc === "function") prevObc.call(this, shader, renderer);
    // Unreachable for an eligible emitter (gpEligible dry-runs this material's
    // template); a hook chain that removed main's anchor would leave the
    // program reading record indices as colour: say so, once.
    if (!patchGpVertexShader(shader, isFx)) _gpPatchFailed(this);
    shader.uniforms.uGpRec = GP_UNIFORMS.uGpRec;
    shader.uniforms.uGpRow = GP_UNIFORMS.uGpRow;
    _watchRenderer(renderer);
  };
  mat.customProgramCacheKey = () => key;
  ud.__gpParticles = true;
  mat.needsUpdate = true;
  return true;
}

let _patchFailures = 0;
/** Compile-time patch failures this session (diag, H6). */
export function gpPatchFailures() { return _patchFailures; }
function _gpPatchFailed(mat) {
  _patchFailures++;
  if (_patchFailures === 1) {
    // eslint-disable-next-line no-console
    console.warn(`[gpu_particles] the vertex patch found no "void main() {" in ${mat && mat.type} (a hook chain rewrote it?); that bucket draws garbage.`);
  }
}

// ---------------------------------------------------------------------------
// Self-check (dry run per shader template, at the first eligible emitter of it)
// ---------------------------------------------------------------------------

// three r184 WebGLPrograms' shader ids for the material types a bucket can be
// (a clone of the factory's base material: MeshBasic, MeshStandard under
// ?particleUnlit=off). Any other type is not eligible.
const _SHADER_IDS = Object.freeze({
  MeshBasicMaterial: "basic",
  MeshLambertMaterial: "lambert",
  MeshPhongMaterial: "phong",
  MeshToonMaterial: "toon",
  MeshStandardMaterial: "physical",
  MeshPhysicalMaterial: "physical",
  MeshMatcapMaterial: "matcap",
});

/** The ShaderLib template a bucket cloned from `mat` compiles from, or null (not eligible). */
export function gpShaderTemplateOf(mat) {
  if (!mat || typeof mat.type !== "string") return null;
  return _hasOwn(_SHADER_IDS, mat.type) ? _SHADER_IDS[mat.type] : null;
}

let _selfChecks = null; // template id -> boolean (made at the first check)
let _selfCheckSrc = null;
let _selfCheckWarned = false;
/** Test seam: dry-run a different vertex source (null = three's ShaderLib template); resets the latches. */
export function __setGpSelfCheckSourceForTest(src) {
  _selfCheckSrc = typeof src === "string" ? src : null;
  _selfChecks = null;
  _selfCheckWarned = false;
}

/**
 * Patch three r184's ShaderLib[template] vertex source as every gpu program of
 * that template will be patched (stock / alpha instance, the FX-patched copy,
 * the glow copy) and verify the header, the call and the undef rule. Memoised
 * per template. On failure: one warn and emitters of that template stay on
 * today's path for the session.
 */
export function gpSelfCheck(template = "basic") {
  if (_selfChecks !== null && _selfChecks.has(template)) return _selfChecks.get(template);
  let ok = false;
  try {
    const lib = THREE.ShaderLib && THREE.ShaderLib[template];
    const vs = _selfCheckSrc !== null ? _selfCheckSrc : lib.vertexShader;
    const mk = () => ({ vertexShader: vs, fragmentShader: lib.fragmentShader, uniforms: {} });
    const stock = mk();
    const fxS = mk();
    ok = patchGpVertexShader(stock, false) && gpVerifyPatchedVertex(stock.vertexShader);
    if (ok) {
      // the FX program (and its glow twin: the same vertex body, HB_FX_GLOW
      // only adds a define) carries FX's own instanceMatrix redirect
      ok = patchParticleFxShader(fxS) && patchGpVertexShader(fxS, true) && gpVerifyPatchedVertex(fxS.vertexShader)
        && fxS.vertexShader.indexOf("#undef instanceMatrix") !== -1;
    }
  } catch (_) {
    ok = false;
  }
  if (_selfChecks === null) _selfChecks = new Map();
  _selfChecks.set(template, ok);
  if (!ok && !_selfCheckWarned) {
    _selfCheckWarned = true;
    // eslint-disable-next-line no-console
    console.warn(`[gpu_particles] the vertex patch self-check failed for ShaderLib.${template} (three's chunks changed shape?); its emitters stay on today's path.`);
  }
  return ok;
}

// ---------------------------------------------------------------------------
// Tables: wide RGBA32F data textures with ranged uploads
// ---------------------------------------------------------------------------

export class GpTable {
  /**
   * @param {string} name texture name
   * @param {number} reserved leading records that are never handed out
   */
  constructor(name, reserved) {
    this.name = name;
    this.rows = 1;
    this.data = new Float32Array(GP_WIDTH * 4 * this.rows);
    this.tex = null;
    this.next = reserved;
    this.free = [];
    this.live = 0;
    this._dirtyMin = new Int32Array(this.rows).fill(-1);
    this._dirtyMax = new Int32Array(this.rows).fill(-1);
    this._dirtyRows = [];
    // Texels flushed since the texture's last upload, per texture row (the
    // ranges on `tex.updateRanges`). three consumes and clears the ranges only
    // when a draw binds the texture; while none does (every gpu bucket reaped,
    // culled or cell-hidden, film hide, ?nullRender) each flush merges into
    // these instead of adding ranges: at most one pending range per row.
    this._pendMin = new Int32Array(this.rows).fill(-1);
    this._pendMax = new Int32Array(this.rows).fill(-1);
    this._pendRows = [];
    this.fresh = true;
    this.stats = { flushes: 0, ranges: 0, lastRanges: 0, fullUploads: 0, grows: 0, writes: 0, uploads: 0, merged: 0 };
    this._makeTex();
  }

  _makeTex() {
    const t = new THREE.DataTexture(this.data, GP_WIDTH, this.rows, THREE.RGBAFormat, THREE.FloatType);
    t.minFilter = THREE.NearestFilter;
    t.magFilter = THREE.NearestFilter;
    t.generateMipmaps = false;
    t.flipY = false;
    t.name = this.name;
    t.needsUpdate = true;
    // three calls onUpdate after every upload of this texture: the first one
    // of a fresh texture (texStorage2D + data) was whole, a later one consumed
    // (and cleared) the pending ranges.
    t.onUpdate = () => { this._onUploaded(t); };
    const old = this.tex;
    this.tex = t;
    this.fresh = true;
    this._clearPending();
    if (old) { try { old.dispose(); } catch (_) {} }
  }

  _onUploaded(t) {
    if (t !== this.tex) return;
    this.fresh = false;
    this.stats.uploads++;
    this._clearPending();
  }

  _clearPending() {
    const rows = this._pendRows;
    for (let i = 0; i < rows.length; i++) {
      this._pendMin[rows[i]] = -1;
      this._pendMax[rows[i]] = -1;
    }
    rows.length = 0;
  }

  /** A restored context or a new texture: the next upload is a full one. */
  markFresh() {
    this.fresh = true;
    this._clearPending();
    if (this.tex) { this.tex.clearUpdateRanges(); this.tex.needsUpdate = true; }
  }

  /** Records the table can hold at its current height. */
  get capacity() { return this.rows * GP_PER_ROW; }

  _grow(need) {
    let rows = this.rows;
    while (rows * GP_PER_ROW < need) rows *= 2;
    if (rows === this.rows) return;
    const nd = new Float32Array(GP_WIDTH * 4 * rows);
    nd.set(this.data);
    this.data = nd;
    this.rows = rows;
    this._dirtyMin = new Int32Array(rows).fill(-1);
    this._dirtyMax = new Int32Array(rows).fill(-1);
    this._dirtyRows.length = 0;
    this._pendMin = new Int32Array(rows).fill(-1);
    this._pendMax = new Int32Array(rows).fill(-1);
    this._pendRows.length = 0;
    this.stats.grows++;
    this._makeTex();
  }

  /** Hand out a record index (LIFO free list, then the high-water mark). */
  alloc() {
    const r = this.free.length > 0 ? this.free.pop() : this.next++;
    if (r >= this.capacity) this._grow(r + 1);
    this.live++;
    return r;
  }

  /** Zero a record and return it to the free list. */
  release(r) {
    if (!(r > 0)) return;
    const o = r * GP_FLOATS;
    this.data.fill(0, o, o + GP_FLOATS);
    this._touch(r, 0);
    this._touch(r, GP_TEXELS - 1);
    this.free.push(r);
    this.live--;
  }

  _touch(r, k) {
    const row = (r / GP_PER_ROW) | 0;
    const texel = (r - row * GP_PER_ROW) * GP_TEXELS + k;
    const mn = this._dirtyMin[row];
    if (mn === -1) {
      this._dirtyMin[row] = texel;
      this._dirtyMax[row] = texel;
      this._dirtyRows.push(row);
    } else {
      if (texel < mn) this._dirtyMin[row] = texel;
      if (texel > this._dirtyMax[row]) this._dirtyMax[row] = texel;
    }
  }

  /** Write texel k of record r (f64 in, f32 stored). */
  set(r, k, x, y, z, w) {
    const o = r * GP_FLOATS + k * 4;
    const d = this.data;
    d[o] = x; d[o + 1] = y; d[o + 2] = z; d[o + 3] = w;
    this._touch(r, k);
    this.stats.writes++;
  }

  /**
   * One update range per touched texture row (three r184 updateTexture), then
   * needsUpdate. Rows still pending from earlier flushes that no upload took
   * yet are merged into (their span widened), never stacked: however many
   * flushes run between two uploads, `tex.updateRanges` holds at most one
   * range per texture row, covering every texel written since the last upload.
   * Returns the number of ranges now pending.
   */
  flush() {
    const rowsTouched = this._dirtyRows;
    if (rowsTouched.length === 0) return 0;
    const tex = this.tex;
    this.stats.flushes++;
    let n = 0;
    if (this.fresh) {
      // never uploaded (or a restored context): three uploads it whole
      tex.clearUpdateRanges();
      this._clearPending();
      this.stats.fullUploads++;
    } else {
      const pend = this._pendRows;
      const before = pend.length;
      for (let i = 0; i < rowsTouched.length; i++) {
        const row = rowsTouched[i];
        const a = this._dirtyMin[row], b = this._dirtyMax[row];
        const pa = this._pendMin[row];
        if (pa === -1) {
          this._pendMin[row] = a;
          this._pendMax[row] = b;
          pend.push(row);
        } else {
          if (a < pa) this._pendMin[row] = a;
          if (b > this._pendMax[row]) this._pendMax[row] = b;
        }
      }
      // `tex.updateRanges` holds one range per pending row, in `pend` order
      // (three reorders the array only inside the upload that clears it). The
      // ranges of earlier flushes not consumed yet are widened in place (no
      // allocation while nothing draws); rows new since then are appended. A
      // range list in any other state is rebuilt.
      const R = tex.updateRanges;
      const inPlace = before > 0 && R.length === before;
      if (before > 0) {
        this.stats.merged++;
        if (!inPlace) tex.clearUpdateRanges();
      }
      for (let i = 0; i < pend.length; i++) {
        const row = pend[i];
        const a = this._pendMin[row], b = this._pendMax[row];
        const start = (row * GP_WIDTH + a) * 4, count = (b - a + 1) * 4;
        if (inPlace && i < before) { R[i].start = start; R[i].count = count; }
        else tex.addUpdateRange(start, count);
      }
      n = pend.length;
    }
    for (let i = 0; i < rowsTouched.length; i++) {
      const row = rowsTouched[i];
      this._dirtyMin[row] = -1;
      this._dirtyMax[row] = -1;
    }
    rowsTouched.length = 0;
    tex.needsUpdate = true;
    this.stats.ranges += n;
    this.stats.lastRanges = n;
    return n;
  }
}

let _recs = null;   // spawn records (record 0 reserved, zero)
let _rows = null;   // per-frame rows (row 0 global, 1..8 managers)
let _gpManagers = null; // manager slots (made with the tables: no flag-off allocation)
let _lastFxLive = -1;

function _ensureTables() {
  if (_recs !== null) return;
  _recs = new GpTable("gpu-particles-records", 1);
  _rows = new GpTable("gpu-particles-rows", GP_ROW.EMITTER0);
  GP_UNIFORMS.uGpRec.value = _recs.tex;
  GP_UNIFORMS.uGpRow.value = _rows.tex;
  _installDiag();
}
function _syncUniforms() {
  if (_recs && GP_UNIFORMS.uGpRec.value !== _recs.tex) GP_UNIFORMS.uGpRec.value = _recs.tex;
  if (_rows && GP_UNIFORMS.uGpRow.value !== _rows.tex) GP_UNIFORMS.uGpRow.value = _rows.tex;
}

/** The tables (tests / diag). null until the first gpu emitter. */
export function gpTables() { return _recs === null ? null : { records: _recs, rows: _rows }; }

/**
 * A manager's gpu state (slot, epoch, last tick), created at its first eligible
 * emitter; null when all 8 manager rows are taken.
 */
export function gpManagerState(mgr) {
  if (!mgr) return null;
  if (mgr._gpState) return mgr._gpState;
  if (_gpManagers === null) _gpManagers = new Array(GP_ROW.MANAGERS).fill(null);
  let slot = -1;
  for (let i = 0; i < _gpManagers.length; i++) if (_gpManagers[i] === null) { slot = i; break; }
  if (slot === -1) return null;
  _ensureTables();
  _gpManagers[slot] = mgr;
  const now = currentTime();
  const st = {
    slot,
    row: GP_ROW.MANAGER0 + slot,
    M0: Math.floor(Number.isFinite(now) ? now : 0),
    lastNow: NaN,
    dt: 1 / 60,
    emitters: new Set(),
    rebases: 0,
  };
  mgr._gpState = st;
  return st;
}

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------

/**
 * Does this (instanced) emitter take the gpu path? The flag is on (the caller
 * checks), not the sky chain, an integer type in 1..12, no legacy escape (they
 * change particle.js's closed forms at module load), the self-check of the
 * shader template its bucket will compile from (`baseMat`, the bucket's
 * source material; omitted = MeshBasic) passed, and a manager row is available.
 */
export function gpEligible(info, skyGlow, mgr, baseMat) {
  if (!info || skyGlow === true) return false;
  const t = info.particleType;
  if (!(Number.isInteger(t) && t >= 1 && t <= 12)) return false;
  const L = particleLegacyFlags();
  if (L.swarmAce || L.initAce || L.rotEuler || L.initFrameAce) return false;
  const tpl = baseMat === undefined ? "basic" : gpShaderTemplateOf(baseMat);
  if (tpl === null || !gpSelfCheck(tpl)) return false;
  return gpManagerState(mgr) !== null;
}

// ---------------------------------------------------------------------------
// The f64 twin (bit-identical to Particle.update's position / translucency)
// ---------------------------------------------------------------------------

/** Particle.update's translucency, same operation order. */
export function gpSlotTrans(p) {
  let interval;
  if (p.lifespan > 0) interval = Math.min(p.lifetime / p.lifespan, 1.0);
  else interval = 1.0;
  return p.startTrans + (p.finalTrans - p.startTrans) * interval;
}

/** Particle.update's scale, same operation order. */
export function gpSlotScale(p) {
  let interval;
  if (p.lifespan > 0) interval = Math.min(p.lifetime / p.lifespan, 1.0);
  else interval = 1.0;
  return p.startScale + (p.finalScale - p.startScale) * interval;
}

/**
 * Particle.update's position at the particle's current lifetime, in its JS
 * expression order per type (default, non-legacy variants: gpu emitters never
 * run with an escape on). `fp` = the frame position (startFrame.position, or
 * the parent-local anchor copy `{x,y,z}` / [x,y,z]). Writes out[0..2].
 */
export function gpTwinPos(p, type, fp, out) {
  const lt = p.lifetime;
  const ox = p.offset.x, oy = p.offset.y, oz = p.offset.z;
  let px, py, pz;
  if (ArrayBuffer.isView(fp) || Array.isArray(fp)) { px = fp[0]; py = fp[1]; pz = fp[2]; }
  else { px = fp.x; py = fp.y; pz = fp.z; }
  const a = p.a, b = p.b, c = p.c;
  switch (type) {
    case 1:
      out[0] = px + ox; out[1] = py + oy; out[2] = pz + oz;
      break;
    case 2:
    case 12:
      out[0] = lt * a.x + px + ox;
      out[1] = lt * a.y + py + oy;
      out[2] = lt * a.z + pz + oz;
      break;
    case 3:
    case 8:
    case 10: {
      const halfT2 = lt * lt * 0.5;
      out[0] = px + ox + lt * a.x + halfT2 * b.x;
      out[1] = py + oy + lt * a.y + halfT2 * b.y;
      out[2] = pz + oz + lt * a.z + halfT2 * b.z;
      break;
    }
    case 4:
    case 9:
    case 11: {
      const halfT2 = lt * lt * 0.5;
      out[0] = px + halfT2 * b.x + lt * a.x + ox;
      out[1] = py + halfT2 * b.y + lt * a.y + oy;
      out[2] = pz + halfT2 * b.z + lt * a.z + oz;
      break;
    }
    case 5: {
      const bx = lt * a.x + px + ox;
      const by = lt * a.y + py + oy;
      const bz = lt * a.z + pz + oz;
      out[0] = Math.cos(lt * b.x) * c.x + bx;
      out[1] = Math.sin(lt * b.y) * c.y + by;
      out[2] = Math.cos(lt * b.z) * c.z + bz;
      break;
    }
    case 6: {
      const ax = a.x, az = a.z;
      out[0] = (lt * b.x + c.x * ax) * lt + ox + px;
      out[1] = (lt * b.y + c.y * ax) * lt + oy + py;
      out[2] = (lt * b.z + c.z * ax + az) * lt + oz + pz;
      break;
    }
    case 7: {
      const cs = Math.cos(a.x * lt);
      const lt2 = lt * lt;
      out[0] = cs * c.x + lt2 * b.x + px + ox;
      out[1] = cs * c.y + lt2 * b.y + py + oy;
      out[2] = cs * c.z + lt2 * b.z + pz + oz;
      break;
    }
    default:
      out[0] = NaN; out[1] = NaN; out[2] = NaN;
      break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// The gpu emitter
// ---------------------------------------------------------------------------

const _isGr = (t) => t === 4 || t === 9 || t === 11;

export class GpParticleEmitter extends ParticleEmitter {
  constructor(opts) {
    super(opts);
    /** true while the shader owns this emitter's motion (false = today's path). */
    this._gp = true;
    this._gpMgr = null;
    this._gpRow = 0;
    /** slot -> record index (0 = none yet) */
    this._gpRec = null;
    /** slot -> FX seed (f32, as `_fxSeeds` stores them today) */
    this._gpSeed = null;
    /** the parent-local anchor frame of the last update [px,py,pz,qx,qy,qz,qw] (f64) */
    this._gpF = new Float64Array(7);
    this._gpTook = false;
    this._gpBbW = -1;
    /** last anchor written to the row (f64) + its tick time, for the anchor velocity */
    this._gpRowF = null;
    this._gpRowT = NaN;
    this._gpRowVel = false;
  }

  /** Allocate this emitter's row and register it with its manager (first record write). */
  _gpEnsure() {
    if (this._gpRow > 0) return true;
    const st = gpManagerState(this._gpMgr);
    if (!st || !this.info) return false;
    this._gpRow = _rows.alloc();
    st.emitters.add(this);
    const info = this.info;
    const r = this._gpRow;
    _rows.set(r, GP_ROW.E_ANCHOR, 0, 0, 0, st.row);
    _rows.set(r, GP_ROW.E_QUAT, 0, 0, 0, 1);
    _rows.set(r, GP_ROW.E_VEL, 0, 0, 0, this._fxRow | 0);
    _rows.set(r, GP_ROW.E_STATIC, info.particleType, info.isParentLocal ? 1 : 0, 0, particleFxTeleportSpeedSq(this));
    _rows.set(r, GP_ROW.E_NORMAL, 0, 0, 1, 0);
    this._gpBbW = 0;
    const n = this.parts.length;
    if (this._gpRec === null || this._gpRec.length < n) {
      this._gpRec = new Int32Array(n);
      this._gpSeed = new Float32Array(n);
    }
    return true;
  }

  /** Free every record and the row (teardown, the per-mesh conversion, an orphaned table entry). */
  _gpRelease() {
    if (this._gpRec !== null && _recs !== null) {
      for (let i = 0; i < this._gpRec.length; i++) {
        if (this._gpRec[i] > 0) _recs.release(this._gpRec[i]);
        this._gpRec[i] = 0;
      }
    }
    if (this._gpRow > 0 && _rows !== null) {
      _rows.release(this._gpRow);
      this._gpRow = 0;
    }
    const st = this._gpMgr ? this._gpMgr._gpState : null;
    if (st) st.emitters.delete(this);
  }

  _gpTakeFrame(f) {
    const F = this._gpF;
    F[0] = f.position.x; F[1] = f.position.y; F[2] = f.position.z;
    const q = f.quaternion;
    if (q) { F[3] = q.x; F[4] = q.y; F[5] = q.z; F[6] = q.w; }
    else { F[3] = 0; F[4] = 0; F[5] = 0; F[6] = 1; }
    this._gpTook = true;
  }

  /** The record time pair of one live particle (effective birth vs the epoch). */
  _gpWriteTimes(i) {
    const p = this.particles[i];
    const r = this._gpRec[i];
    const st = this._gpMgr._gpState;
    const info = this.info;
    const persistent = info.totalParticles === 0 && info.totalSeconds === 0;
    const bEff = persistent ? p.lastUpdateTime - p.lifetime : p.lastUpdateTime;
    const T = bEff - st.M0;
    const hi = Math.floor(T * 1024) / 1024;
    const d = _recs.data;
    const o = r * GP_FLOATS;
    _recs.set(r, GP_REC.BASE, d[o], d[o + 1], d[o + 2], hi);
    _recs.set(r, GP_REC.B, d[o + 8], d[o + 9], d[o + 10], T - hi);
  }

  /** The spawn record of the particle just emitted into slot i. */
  _gpOnEmit(i) {
    if (!this._gpEnsure()) return;
    let r = this._gpRec[i];
    if (r === 0) { r = _recs.alloc(); this._gpRec[i] = r; }
    _syncUniforms();
    const p = this.particles[i];
    const info = this.info;
    const pl = info.isParentLocal === true;
    const type = info.particleType;
    if (pl && !this._gpTook) this._gpTakeFrame(p.startFrame);
    // seed: drawn at spawn from particle_fx.js's stream (flag-off draws it at
    // the slot's first append after a respawn)
    const seed = particleFxEnabled() ? particleFxDrawSeed() : 0;
    this._gpSeed[i] = seed;
    const s = this._gpSeed[i]; // f32, as `_fxSeeds` holds it
    const off = p.offset;
    const sp = p.startFrame.position;
    const bx = pl ? off.x : sp.x + off.x;
    const by = pl ? off.y : sp.y + off.y;
    const bz = pl ? off.z : sp.z + off.z;
    const st = this._gpMgr._gpState;
    const persistent = info.totalParticles === 0 && info.totalSeconds === 0;
    const bEff = persistent ? p.lastUpdateTime - p.lifetime : p.lastUpdateTime;
    const T = bEff - st.M0;
    const hi = Math.floor(T * 1024) / 1024;
    _recs.set(r, GP_REC.BASE, bx, by, bz, hi);
    _recs.set(r, GP_REC.A, p.a.x, p.a.y, p.a.z, p.lifespan);
    _recs.set(r, GP_REC.B, p.b.x, p.b.y, p.b.z, T - hi);
    _recs.set(r, GP_REC.C, p.c.x, p.c.y, p.c.z, s);
    const gr = _isGr(type);
    const q = p.startFrame.quaternion;
    if (gr && !pl) _recs.set(r, GP_REC.Q, q.x, q.y, q.z, q.w);
    else _recs.set(r, GP_REC.Q, 0, 0, 0, 1);
    _recs.set(r, GP_REC.LERP, p.startScale, p.finalScale, p.startTrans, p.finalTrans);
    _recs.set(r, GP_REC.EROW, this._gpRow, 0, 0, 0);
    if (gr) {
      const cx = p.c.x, cy = p.c.y, cz = p.c.z;
      const w = Math.sqrt(cx * cx + cy * cy + cz * cz);
      if (w > 0) _recs.set(r, GP_REC.SPIN, cx / w, cy / w, cz / w, w);
      else _recs.set(r, GP_REC.SPIN, 0, 0, 0, 0);
    } else {
      _recs.set(r, GP_REC.SPIN, 0, 0, 0, 0);
    }
  }

  /** PLIFECYCLE-2 thaw / epoch rebase: rewrite Thi/Tlo of every live record. */
  _gpRetime() {
    if (this._gp !== true || this._gpRec === null || !this._gpMgr || !this._gpMgr._gpState) return 0;
    let n = 0;
    for (let i = 0; i < this._gpRec.length; i++) {
      if (this.parts[i] !== null && this.parts[i] !== undefined && this._gpRec[i] > 0) {
        this._gpWriteTimes(i);
        n++;
      }
    }
    return n;
  }

  /** `emitParticle` + the spawn record (peek the free slot the base will claim). */
  emitParticle() {
    if (this._gp !== true) return super.emitParticle();
    let idx = -1;
    for (let i = 0; i < this._createdSlots; i++) {
      if (this.parts[i] === null && this.partStorage[i]) { idx = i; break; }
    }
    super.emitParticle();
    if (idx >= 0 && this.parts[idx] !== null) this._gpOnEmit(idx);
  }

  /**
   * The base `updateParticles` with only the lifetime half of
   * `Particle.update` (verbatim arithmetic) in place of the call: no carrier
   * writes. The parent-local anchor is resolved once (the first live slot, as
   * the ?frozenPartFast memo does) and copied for the row and the twin.
   */
  updateParticles() {
    if (this._gp !== true) return super.updateParticles();
    if (this.info === null) return false;
    const hoist = particleFrozenPartFastEnabled();
    if (hoist) this._tickAnchor = null;
    try {
      const info = this.info;
      const pl = info.isParentLocal;
      this._gpTook = false;
      if (info.maxParticles > 0) {
        const parts = this.parts;
        const particles = this.particles;
        for (let i = 0; i < info.maxParticles; i++) {
          if (parts[i] === null) continue;
          if (pl && !this._gpTook) this._gpTakeFrame(hoist ? this._tickAnchorFrame() : this._resolveAnchorFrame());
          const persistent = info.totalParticles === 0 && info.totalSeconds === 0;
          const p = particles[i];
          const now = currentTime();
          const elapsed = now - p.lastUpdateTime;
          if (persistent) {
            p.lifetime += elapsed;
            p.lastUpdateTime = now;
          } else {
            p.lifetime = elapsed;
          }
          this.killParticle(i);
        }
      }
      let hasParticles = true;
      if (!this.stopped) {
        if (this.shouldEmitParticle()) {
          this.emitParticle();
        }
        this.stopEmitter();
      } else {
        hasParticles = this.numParticles !== 0;
      }
      this.lastUpdateTime = currentTime();
      return hasParticles;
    } finally {
      if (hoist) this._tickAnchor = undefined;
    }
  }

  /**
   * Film mode (scene3d/film/scene/particles_query.js): `[x, y, z, scale, op]`
   * per live, visible slot with op above the 0.02 floor, from the f64 twin —
   * what the carrier meshes hold on the flag-off path. `_scene`-local.
   */
  _gpFilmSample(max) {
    const rows = [];
    if (this._gp !== true || !this.info) return rows;
    const m = Math.max(0, max | 0);
    const type = this.info.particleType;
    const pl = this.info.isParentLocal === true;
    const parts = this.parts;
    for (let i = 0; i < parts.length && rows.length < m; i++) {
      if (parts[i] === null || parts[i] === undefined) continue;
      const p = this.particles[i];
      const trans = gpSlotTrans(p);
      if (trans >= 1.0) continue;
      const op = Math.max(0.0, Math.min(1.0, 1.0 - trans));
      if (op <= 0.02) continue;
      const v = gpTwinPos(p, type, pl ? this._gpF : p.startFrame.position, [0, 0, 0]);
      rows.push([v[0], v[1], v[2], gpSlotScale(p), op]);
    }
    return rows;
  }
}

/**
 * `__setParticleInstancing(false)` on a gpu emitter: free its records + row and
 * hand it back to today's code (its update then rewrites the carriers that
 * same tick). Toggling back on keeps it on the legacy instanced path.
 */
export function gpConvertToMesh(emitter) {
  if (!emitter || emitter._gp !== true) return false;
  emitter._gpRelease();
  emitter._gp = false;
  return true;
}

// ---------------------------------------------------------------------------
// Per-tick hooks (particle_manager.js, flag on)
// ---------------------------------------------------------------------------

// scratch, made at the first gpu tick (no flag-off allocation)
let _camInv = null;
let _camLocal = null;

/**
 * `_tickLatched` start: this manager's row (clock hi/lo, dt, billboard on, the
 * camera the CPU billboards would have used) and the global row; an epoch
 * rebase every `_rebaseSeconds`. A manager without a slot (no `_gpState`: it
 * never had a gpu-eligible emitter) writes nothing. Once `gpEligible` gave it
 * one, its clock row (+ the two camera texels when a camera is given) is
 * written every tick, even with no gpu emitter left, so a new emitter's first
 * record draws against a current clock (3 texels, merged into one pending
 * range while nothing uploads).
 */
export function gpBeginTick(mgr, now, camera) {
  const st = mgr ? mgr._gpState : null;
  if (!st || _rows === null) return;
  if (now - st.M0 >= _rebaseSeconds) {
    st.M0 += _rebaseSeconds * Math.floor((now - st.M0) / _rebaseSeconds);
    st.rebases++;
    for (const e of st.emitters) e._gpRetime();
  }
  if (Number.isFinite(st.lastNow)) {
    const d = now - st.lastNow;
    if (d > 0) st.dt = Math.min(d, 0.5);
  }
  st.lastNow = now;
  const C = now - st.M0;
  const hi = Math.floor(C * 1024) / 1024;
  let bbOn = 0;
  const scene = mgr._scene;
  if (camera && camera.position) {
    bbOn = 1;
    if (_camInv === null) { _camInv = new THREE.Matrix4(); _camLocal = new THREE.Vector3(); }
    if (scene && scene.matrixWorld) {
      _camInv.copy(scene.matrixWorld).invert();
      _camLocal.copy(camera.position).applyMatrix4(_camInv);
    } else {
      _camLocal.copy(camera.position);
    }
    _rows.set(st.row, GP_ROW.M_CAMLOCAL, _camLocal.x, _camLocal.y, _camLocal.z, 0);
    _rows.set(st.row, GP_ROW.M_CAMWORLD, camera.position.x, camera.position.y, camera.position.z, 0);
  }
  _rows.set(st.row, GP_ROW.M_CLOCK, hi, C - hi, st.dt, bbOn);
  const live = particleFxLive() ? 1 : 0;
  if (live !== _lastFxLive) {
    _lastFxLive = live;
    _rows.set(0, 0, live, 0, 0, 0);
  }
}

/** `_tickLatched` end: one update range per touched texture row of each table. */
export function gpEndTick(mgr) {
  if (!mgr || !mgr._gpState || _recs === null) return;
  _syncUniforms();
  _recs.flush();
  _rows.flush();
}

/**
 * The append branch, before the index walk: the emitter row's billboard mode
 * (the async `_bbMode` lands late) and, for a parent-local emitter, this
 * tick's anchor (+ its velocity for `?fxMotion`). Returns the frame position
 * the twin reads for parent-local emitters (null otherwise).
 */
export function gpPrepareAppend(emitter, normalOf) {
  const r = emitter._gpRow;
  if (!(r > 0)) return null;
  const info = emitter.info;
  let want = 0;
  if (info.billboard) {
    // the POJO sprite path (precedence over the retail mode, as in tick())
    if (emitter._gpBbW === 6) {
      want = 6;
    } else {
      const probe = emitter.partStorage ? emitter.partStorage.find(Boolean) : null;
      const nrm = probe && typeof normalOf === "function" ? normalOf(probe.geometry) : null;
      if (nrm) {
        want = 6;
        _rows.set(r, GP_ROW.E_NORMAL, nrm.x, nrm.y, nrm.z, 0);
      }
    }
  } else {
    want = emitter._bbMode | 0;
  }
  if (want !== emitter._gpBbW) {
    emitter._gpBbW = want;
    _rows.set(r, GP_ROW.E_STATIC, info.particleType, info.isParentLocal ? 1 : 0, want, particleFxTeleportSpeedSq(emitter));
  }
  if (info.isParentLocal !== true) return null;
  const F = emitter._gpF;
  const now = currentTime();
  let prev = emitter._gpRowF;
  if (prev === null) prev = emitter._gpRowF = new Float64Array(7).fill(NaN);
  let changed = false;
  for (let k = 0; k < 7; k++) if (!Object.is(prev[k], F[k])) { changed = true; break; }
  if (changed) {
    let vx = 0, vy = 0, vz = 0;
    const dt = now - emitter._gpRowT;
    if (dt > 1e-4 && dt < 0.5 && Number.isFinite(prev[0])) {
      vx = (F[0] - prev[0]) / dt; vy = (F[1] - prev[1]) / dt; vz = (F[2] - prev[2]) / dt;
    }
    const st = emitter._gpMgr._gpState;
    _rows.set(r, GP_ROW.E_ANCHOR, F[0], F[1], F[2], st.row);
    _rows.set(r, GP_ROW.E_QUAT, F[3], F[4], F[5], F[6]);
    _rows.set(r, GP_ROW.E_VEL, vx, vy, vz, emitter._fxRow | 0);
    emitter._gpRowVel = vx !== 0 || vy !== 0 || vz !== 0;
    prev.set(F);
    emitter._gpRowT = now;
  } else if (emitter._gpRowVel) {
    // the anchor stopped: its velocity goes to zero once
    _rows.set(r, GP_ROW.E_VEL, 0, 0, 0, emitter._fxRow | 0);
    emitter._gpRowVel = false;
    emitter._gpRowT = now;
  } else {
    emitter._gpRowT = now;
  }
  return F;
}

// ---------------------------------------------------------------------------
// Diagnostics (installed with the tables, i.e. at the first gpu emitter)
// ---------------------------------------------------------------------------

function _installDiag() {
  if (typeof window === "undefined") return;
  window.__gpuParticlesDiag = () => {
    let emitters = 0;
    const managers = [];
    for (const m of _gpManagers || []) {
      if (!m || !m._gpState) continue;
      emitters += m._gpState.emitters.size;
      managers.push({ slot: m._gpState.slot, emitters: m._gpState.emitters.size, epoch: m._gpState.M0, rebases: m._gpState.rebases, dt: m._gpState.dt });
    }
    return {
      on: gpuParticlesEnabled(),
      selfCheck: _selfChecks === null ? null : [..._selfChecks.values()].every(Boolean),
      selfChecks: _selfChecks === null ? {} : Object.fromEntries(_selfChecks),
      patchFailures: _patchFailures,
      emitters,
      managers,
      records: _recs ? { live: _recs.live, rows: _recs.rows, capacity: _recs.capacity, ..._recs.stats } : null,
      rows: _rows ? { live: _rows.live, rows: _rows.rows, capacity: _rows.capacity, ..._rows.stats } : null,
    };
  };
}

// ---------------------------------------------------------------------------
// Test seam
// ---------------------------------------------------------------------------

/** Which lazily made state exists (F1: none of it with the flag off). */
export function __gpScratchForTest() {
  return { tables: _recs !== null, managers: _gpManagers !== null, cam: _camInv !== null, selfChecks: _selfChecks !== null,
    renderer: _watchedRenderer !== null };
}

/** Drop every table, manager slot and latch (node tests run many scenarios per process). */
export function __resetGpParticlesForTest() {
  if (_gpManagers !== null) {
    for (let i = 0; i < _gpManagers.length; i++) {
      const m = _gpManagers[i];
      if (m) m._gpState = undefined;
    }
  }
  _gpManagers = null;
  if (_recs && _recs.tex) { try { _recs.tex.dispose(); } catch (_) {} }
  if (_rows && _rows.tex) { try { _rows.tex.dispose(); } catch (_) {} }
  _recs = null;
  _rows = null;
  GP_UNIFORMS.uGpRec.value = null;
  GP_UNIFORMS.uGpRow.value = null;
  _lastFxLive = -1;
  _rebaseSeconds = GP_REBASE_SECONDS_DEFAULT;
  _selfChecks = null;
  _patchFailures = 0;
  _camInv = null;
  _camLocal = null;
  _selfCheckSrc = null;
  _selfCheckWarned = false;
  _watchedRenderer = null;
  if (typeof window !== "undefined") delete window.__gpuParticlesDiag;
}
