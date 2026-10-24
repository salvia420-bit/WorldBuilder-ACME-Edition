// scene3d/anim_scenery_gpu.js — ?animSceneryGpu (2026-10-17, DEFAULT ON; `=off`
// escape): the per-instance pose of instanced DAT-anim scenery is composed in
// the VERTEX shader instead of on the CPU.
//
// THE COST. animated_scenery.js's instanced path (one InstancedMesh per
// (setup, part, surface group)) wrote every live instance's matrix every frame
// — `instanceMatrix[i] = orbitNode_i × templatePart(t)` — and re-uploaded the
// dirty span. Live on the 1070 (LB 0xE632, 2026-10-17) that population is the
// AMBIENT CRITTERS, not trees: butterflies 0x02000493/494 (2,334), seagulls
// 0x020005AC (992), the insect cloud 0x020004B0, birds 0x020005A9, 0x02000BBF —
// 3,411 instanced placements, 7,088-7,298 instance slots in 27 buckets. The
// rAF loop cost 1.3 ms/frame (`loop animated_scenery.js` 280 ms of a 7.25 s
// profile; `_writeInstancedPose` 86.5 ms of it). (Tree sway proper is already
// GPU: deformation.windSwayGpu on the frozen statics.)
//
// THE IDENTITY. Every placement of one animation DID shares ONE pose (one
// mixer per DID — that is what made the instancing legal), and the retail
// SetOmega orbit is one angle per DID too. So, with N_i the STATIC placement
// matrix (T_i·R_i·S_i), P(t) the template part pose and R_o(t) the DID orbit,
// today's CPU product is
//     instanceMatrix_i(t) = T_i · R_o(t) · (R_i·S_i) · P(t)
// and only P and R_o change per frame. They live in a small RGBA32F texture,
// one ROW per (animation DID, part): texels 0-3 = P's columns, 4-6 = R_o's
// columns. The instance attribute keeps N_i (written once, at registration
// and when a collapsed instance is shown again); each bucket's geometry
// carries a constant per-vertex `hbAiPose` = its row. The vertex shader
// rebuilds the very same matrix and `#define`s `instanceMatrix` to it, so
// every downstream use — three's project/worldpos/normal chunks AND every
// patch in the material's own chain (CSM, POM, light clamp, …) — reads the
// posed matrix exactly as it read the attribute before. Per frame the CPU now
// writes ~30 rows (not ~7,000 matrices) and uploads an 8×N texture.
//
// THE MATERIAL. A bucket cannot patch its surface material in place (the same
// object draws frozen statics), so it draws with ONE variant per member
// material: an instance of the member's class whose own properties are the
// member's BY REFERENCE (same hidden class, same textures / userData /
// defines — the batched_material_variant.js recipe), kept in sync once per
// frame, with `onBeforeCompile` = the member's chain + this injection and
// `customProgramCacheKey` = the member's key + "|aiGpu1". Buckets of the same
// surface share the variant (the pose index rides the geometry, not a
// uniform), so the draw/material-switch count is unchanged.
//
// FALLBACK. A ShaderMaterial / array material, or the flag off, keeps the CPU
// path for that bucket (`bucket.gpu === false`); an instance may mix both.
// What can look different: instances beyond `?animSceneryRadius` (800 m) used
// to freeze in their last pose and now keep animating (they share the GPU
// row); a placement registered far away showed its hinge rest pose until it
// first came within the radius, now it shows the live pose.
//
// GLSL text below: no backticks, no quotes/apostrophes even in comments (keep
// to the GLSL ES source character set).

import * as THREE from "three";

let _flag;
/** `?animSceneryGpu` — DEFAULT ON; `off`/`0`/`false`/`no` keeps the CPU pose. */
export function animSceneryGpuEnabled() {
  if (_flag !== undefined) return _flag;
  let on = true;
  try {
    if (typeof window !== "undefined" && window.location) {
      const v = new URLSearchParams(window.location.search).get("animSceneryGpu")?.toLowerCase();
      if (v != null) on = !(v === "off" || v === "0" || v === "false" || v === "no");
    }
  } catch (_) { on = true; }
  _flag = on;
  return on;
}
/** Test seam: true/false forces, undefined re-reads the URL. */
export function __setAnimSceneryGpuForTest(v) { _flag = v; }

// ===========================================================================
// Pose table — one RGBA32F row per (animation DID, part).
// ===========================================================================
export const POSE_TEXELS_PER_ROW = 8;
const FLOATS_PER_ROW = POSE_TEXELS_PER_ROW * 4;

/** `post`: a matrix the per-frame writer right-multiplies onto P (animated_scenery.js
 *  `?animSceneryUnbake`: the inverse of the frame the wasm baked into the part's
 *  vertices), or null.
 *  @type {Array<{row:number, animId:(number|string), partIdx:number, post:(THREE.Matrix4|null)}>} */
const _rows = [];
const _rowByKey = new Map();
let _capacity = 0;
let _data = null;
let _tex = null;
let _dirty = false;
/** Shared by reference into every variant's shader.uniforms. */
const _texUniform = { value: null };

const _IDENTITY4 = new THREE.Matrix4();
const _rot4 = new THREE.Matrix4();

function _grow(rows) {
  if (_tex && rows <= _capacity) return;
  let cap = Math.max(32, _capacity);
  while (cap < rows) cap *= 2;
  const data = new Float32Array(cap * FLOATS_PER_ROW);
  if (_data) data.set(_data);
  const tex = new THREE.DataTexture(data, POSE_TEXELS_PER_ROW, cap, THREE.RGBAFormat, THREE.FloatType);
  tex.name = "anim-scenery-gpu-poses";
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.flipY = false;
  tex.needsUpdate = true;
  const old = _tex;
  _data = data;
  _tex = tex;
  _capacity = cap;
  _texUniform.value = tex;
  if (old) { try { old.dispose(); } catch (_) {} }
}

/**
 * Write one row: P (a Matrix4) into texels 0-3 and the orbit rotation (a
 * Quaternion, or null for identity) into texels 4-6 as mat3 columns.
 */
export function writePoseRow(row, partMat, orbitQuat) {
  if (!_data || row < 0 || row >= _capacity) return;
  const d = _data;
  const b = row * FLOATS_PER_ROW;
  const e = (partMat || _IDENTITY4).elements;
  for (let i = 0; i < 16; i++) d[b + i] = e[i];
  if (orbitQuat) {
    const r = _rot4.makeRotationFromQuaternion(orbitQuat).elements;
    d[b + 16] = r[0]; d[b + 17] = r[1]; d[b + 18] = r[2]; d[b + 19] = 0;
    d[b + 20] = r[4]; d[b + 21] = r[5]; d[b + 22] = r[6]; d[b + 23] = 0;
    d[b + 24] = r[8]; d[b + 25] = r[9]; d[b + 26] = r[10]; d[b + 27] = 0;
  } else {
    d[b + 16] = 1; d[b + 17] = 0; d[b + 18] = 0; d[b + 19] = 0;
    d[b + 20] = 0; d[b + 21] = 1; d[b + 22] = 0; d[b + 23] = 0;
    d[b + 24] = 0; d[b + 25] = 0; d[b + 26] = 1; d[b + 27] = 0;
  }
  d[b + 28] = 0; d[b + 29] = 0; d[b + 30] = 0; d[b + 31] = 0;
  _dirty = true;
}

/**
 * The row for (animId, partIdx), allocated on first use and seeded with
 * `initMat` (the part's hinge rest pose — what the CPU path seeded a slot
 * with until its first tick). Row 0 is reserved as identity: a vertex whose
 * `hbAiPose` attribute is missing reads the default generic value 0.
 *
 * `variant` (optional) splits the row when the same (DID, part) is drawn by
 * setups that need different `post` matrices (animated_scenery.js passes the
 * setup id when the part's geometry carries a baked frame to undo); absent ⇒
 * the pre-2026-10-23 key, so rows without a `post` stay shared as before.
 */
export function poseRowFor(animId, partIdx, initMat, variant, post) {
  const key = variant == null ? `${animId}:${partIdx}` : `${animId}:${partIdx}:${variant}`;
  let row = _rowByKey.get(key);
  if (row !== undefined) return row;
  if (!_tex) { _grow(1); writePoseRow(0, null, null); }
  row = _rows.length + 1;
  _grow(row + 1);
  _rowByKey.set(key, row);
  _rows.push({ row, animId, partIdx, post: post || null });
  writePoseRow(row, initMat || null, null);
  return row;
}

/** Every allocated row (read by the per-frame update). */
export function poseRows() { return _rows; }

/** Once per frame, after the rows are written: schedule the texture upload. */
export function flushPoseTable() {
  if (_dirty && _tex) { _tex.needsUpdate = true; _dirty = false; }
}

/**
 * JS mirror of the vertex shader's `hbAiPoseSetup` (tests / diag), step for
 * step on the same float layout: `n` is the slot's static placement (the
 * instanceMatrix attribute), `row` its bucket's pose row. Writes the posed
 * matrix into `out` (may alias `n`) and returns it.
 */
export function posedMatrixFromRow(n, row, out) {
  const target = out || new THREE.Matrix4();
  if (!_data || row < 0 || row >= _capacity) return target.copy(n);
  const d = _data;
  const b = row * FLOATS_PER_ROW;
  const ne = n.elements;
  // mat3(N) columns, then Ro * mat3(N) (column-major: c[col*3 + row]).
  const N3 = [ne[0], ne[1], ne[2], ne[4], ne[5], ne[6], ne[8], ne[9], ne[10]];
  const Ro = [d[b + 16], d[b + 17], d[b + 18], d[b + 20], d[b + 21], d[b + 22], d[b + 24], d[b + 25], d[b + 26]];
  const RN = new Array(9);
  for (let c = 0; c < 3; c++) {
    for (let r = 0; r < 3; r++) {
      RN[c * 3 + r] = Ro[0 * 3 + r] * N3[c * 3 + 0] + Ro[1 * 3 + r] * N3[c * 3 + 1] + Ro[2 * 3 + r] * N3[c * 3 + 2];
    }
  }
  // mat4(RN) * P, then column 3 += N's translation.
  const A = [RN[0], RN[1], RN[2], 0, RN[3], RN[4], RN[5], 0, RN[6], RN[7], RN[8], 0, 0, 0, 0, 1];
  const M = new Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let acc = 0;
      for (let k = 0; k < 4; k++) acc += A[k * 4 + r] * d[b + c * 4 + k];
      M[c * 4 + r] = acc;
    }
  }
  M[12] += ne[12]; M[13] += ne[13]; M[14] += ne[14];
  return target.fromArray(M);
}

/** Test / diag view of a row's 32 floats. */
export function __poseRowForTest(row) {
  if (!_data) return null;
  return Array.from(_data.subarray(row * FLOATS_PER_ROW, (row + 1) * FLOATS_PER_ROW));
}

// ===========================================================================
// Vertex shader injection.
// ===========================================================================
export const ANIM_GPU_MARKER = "HB_ANIM_SCENERY_GPU";

const _HEADER = [
  "#ifdef USE_INSTANCING",
  "// ---- " + ANIM_GPU_MARKER + " (anim_scenery_gpu.js ?animSceneryGpu) ----",
  "// instanceMatrix (the attribute) holds the STATIC placement N = T*R*S; the",
  "// pose table row hbAiPose holds the part pose P of the DID (texels 0-3), orbit",
  "// R_o (texels 4-6). Posed matrix = T * R_o * (R*S) * P, exactly the matrix",
  "// the CPU path wrote. Everything below the define reads the posed matrix.",
  "uniform highp sampler2D hbAiPoseTex;",
  "attribute float hbAiPose;",
  "mat4 hbAiInstanceMatrix;",
  "void hbAiPoseSetup() {",
  "  int hbRow = int(hbAiPose + 0.5);",
  "  mat4 hbP = mat4(texelFetch(hbAiPoseTex, ivec2(0, hbRow), 0), texelFetch(hbAiPoseTex, ivec2(1, hbRow), 0),",
  "                  texelFetch(hbAiPoseTex, ivec2(2, hbRow), 0), texelFetch(hbAiPoseTex, ivec2(3, hbRow), 0));",
  "  mat3 hbRo = mat3(texelFetch(hbAiPoseTex, ivec2(4, hbRow), 0).xyz,",
  "                   texelFetch(hbAiPoseTex, ivec2(5, hbRow), 0).xyz,",
  "                   texelFetch(hbAiPoseTex, ivec2(6, hbRow), 0).xyz);",
  "  mat4 hbN = instanceMatrix;",
  "  mat4 hbM = mat4(hbRo * mat3(hbN)) * hbP;",
  "  hbM[3].xyz += hbN[3].xyz;",
  "  hbAiInstanceMatrix = hbM;",
  "}",
  "#define instanceMatrix hbAiInstanceMatrix",
  "// ---- end " + ANIM_GPU_MARKER + " ----",
  "#endif",
  "",
].join("\n");

/**
 * Patch a vertex shader (onBeforeCompile `shader`): the header goes at the
 * very TOP of the body — before every declaration another patch put ahead of
 * main — and the setup call becomes main's first statement. Idempotent;
 * without a `void main() {` it changes nothing (and returns false), so a
 * shader can never get the define without the call that fills it.
 */
export function injectAnimInstPose(shader) {
  const vs = shader && shader.vertexShader;
  if (typeof vs !== "string") return false;
  if (vs.indexOf(ANIM_GPU_MARKER) !== -1) return true;
  const at = vs.indexOf("void main() {");
  if (at === -1) return false;
  const withCall = vs.slice(0, at)
    + "void main() {\n#ifdef USE_INSTANCING\n  hbAiPoseSetup();\n#endif"
    + vs.slice(at + "void main() {".length);
  shader.vertexShader = _HEADER + withCall;
  return true;
}

// ===========================================================================
// Material variants — one per member surface material.
// ===========================================================================
const _variantOf = new WeakMap(); // member -> variant
const _live = new Map();          // variant -> entry
const _KEY_SUFFIX = "|aiGpu1";
// Non-enumerable live uniform handles the member's own hooks stash on the
// (shared) userData. The variant's compile restores them so it never steals
// the member's handle (materials.js `_LIVE_USERDATA_KEYS`).
const _LIVE_HANDLE_KEYS = [
  "acBakedLightUniforms", "detailShaderUniforms", "csmShaderUniforms",
  "pomShaderUniforms", "lightClampShaderUniforms",
];
const HOT_KEYS = ["version", "opacity", "visible", "transparent", "depthWrite", "depthTest", "_alphaTest",
  "map", "normalMap", "roughnessMap", "aoMap", "emissiveMap", "alphaMap", "emissiveIntensity", "side",
  "blending", "colorWrite", "fog", "wireframe"];
const FULL_SWEEP_DIV = 16;
let _sweepPhase = 0;

function _skipKey(k) {
  return k === "id" || k === "uuid" || k === "_listeners" || k === "onBeforeCompile"
    || k === "customProgramCacheKey"
    || (k.charCodeAt(0) === 95 && k.charCodeAt(1) === 95 && (k.startsWith("__hb") || k.startsWith("__dsp")));
}
function _mirrorKeys(mat) {
  const keys = [];
  for (const k of Object.keys(mat)) if (!_skipKey(k)) keys.push(k);
  return keys;
}
function _mirror(v, mat, keys) {
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    const val = mat[k];
    if (v[k] !== val) v[k] = val;
  }
}

/**
 * The variant a GPU-posed bucket draws with, or null when this member cannot
 * take the patch (array / ShaderMaterial / exotic subclass) — the caller then
 * keeps the CPU pose for that bucket.
 */
export function animInstMaterialFor(member) {
  if (!member || Array.isArray(member) || !member.isMaterial) return null;
  if (member.isShaderMaterial || member.isRawShaderMaterial) return null;
  const have = _variantOf.get(member);
  if (have) return have;
  let v = null;
  try { v = new member.constructor(); } catch (_) { v = null; }
  if (!v || !v.isMaterial) return null;
  // Assign in the member's own key order (same hidden class as the member).
  const keys = [];
  for (const k of Object.keys(member)) {
    if (k === "id" || k === "uuid" || k === "_listeners") continue;
    if (k.charCodeAt(0) === 95 && k.charCodeAt(1) === 95 && (k.startsWith("__hb") || k.startsWith("__dsp"))) continue;
    v[k] = member[k];
    if (!_skipKey(k)) keys.push(k);
  }
  v.onBeforeCompile = function hbAnimSceneryGpuOnBeforeCompile(shader, renderer) {
    const ud = member.userData;
    const saved = [];
    if (ud) {
      for (const k of _LIVE_HANDLE_KEYS) saved.push(Object.getOwnPropertyDescriptor(ud, k));
    }
    try {
      const f = member.onBeforeCompile;
      if (typeof f === "function" && f !== THREE.Material.prototype.onBeforeCompile) f.call(this, shader, renderer);
    } finally {
      if (ud) {
        for (let i = 0; i < _LIVE_HANDLE_KEYS.length; i++) {
          const k = _LIVE_HANDLE_KEYS[i];
          try {
            if (saved[i]) Object.defineProperty(ud, k, saved[i]);
            else if (Object.prototype.hasOwnProperty.call(ud, k)) delete ud[k];
          } catch (_) { /* frozen userData: leave it */ }
        }
      }
    }
    shader.uniforms = shader.uniforms || {};
    shader.uniforms.hbAiPoseTex = _texUniform;
    injectAnimInstPose(shader);
  };
  v.customProgramCacheKey = function hbAnimSceneryGpuProgramKey() {
    let base = "";
    try { base = String(member.customProgramCacheKey.call(this)); } catch (_) { base = ""; }
    return base + _KEY_SUFFIX;
  };
  const e = { member, keys, hot: HOT_KEYS.filter((k) => keys.includes(k)), ver: member.version, onDispose: null };
  e.onDispose = () => _drop(v);
  try { member.addEventListener("dispose", e.onDispose); } catch (_) {}
  _variantOf.set(member, v);
  _live.set(v, e);
  return v;
}

function _drop(v) {
  const e = _live.get(v);
  if (!e) return;
  _live.delete(v);
  _variantOf.delete(e.member);
  try { e.member.removeEventListener("dispose", e.onDispose); } catch (_) {}
  try { v.dispose(); } catch (_) {}
}

/** Once per frame: bring every variant up to its member (fades, re-seated maps, needsUpdate). */
export function syncAnimInstMaterials() {
  if (_live.size === 0) return;
  _sweepPhase = (_sweepPhase + 1) % FULL_SWEEP_DIV;
  let i = 0;
  for (const [v, e] of _live) {
    const mat = e.member;
    if (mat.version !== e.ver || (i++ % FULL_SWEEP_DIV) === _sweepPhase) {
      if (mat.version !== e.ver) { e.keys = _mirrorKeys(mat); e.ver = mat.version; }
      for (const k of e.keys) {
        if (v[k] !== mat[k]) { v[k] = mat[k]; if (!e.hot.includes(k)) e.hot.push(k); }
      }
    } else {
      _mirror(v, mat, e.hot);
    }
  }
}

/** Diag counts. */
export function animSceneryGpuDiag() {
  return { variants: _live.size, rows: _rows.length, capacity: _capacity };
}

/** Full teardown (disposeAnimatedScenery): variants, the table, the rows. */
export function disposeAnimSceneryGpu() {
  for (const v of [..._live.keys()]) _drop(v);
  _rows.length = 0;
  _rowByKey.clear();
  if (_tex) { try { _tex.dispose(); } catch (_) {} }
  _tex = null;
  _data = null;
  _capacity = 0;
  _texUniform.value = null;
  _dirty = false;
}
