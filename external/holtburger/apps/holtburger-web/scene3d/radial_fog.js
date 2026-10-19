// scene3d/radial_fog.js — ?radialFog: retail RANGE fog. The fog distance is the
// eye-to-vertex distance, not three's view-plane depth. Added 2026-10-13; DEFAULT ON since
// 2026-10-19 (ahead of its 1070 eye test, still owed), `?radialFog=off|0|false|no` escapes.
//
// RETAIL. RenderDeviceD3D::SetDefaultD3DStates (acclient.c) programs D3D fixed-function
// VERTEX fog: render state 35 D3DRS_FOGTABLEMODE = D3DFOG_NONE, 140 D3DRS_FOGVERTEXMODE =
// D3DFOG_LINEAR, 48 D3DRS_RANGEFOGENABLE = TRUE. With range fog on, D3D fogs each vertex by
// its DISTANCE from the eye.
//
// STOCK (?radialFog=off). three's <fog_vertex> writes `vFogDepth = - mvPosition.z` (the view-plane
// depth), and both terrain shaders pass the same plane depth (vViewDepth = -mvPos.z) to the
// shared terrainApplyFog tail. Toward the frame sides, plane depth is SHORTER than range by
// cos(angle off the view axis). At the 60 deg vertical FOV and 16:9, the side edge is 45.7 deg
// off axis, so a point at range d has depth 0.698 d. The horizon band
// (far_terrain_flags.js computeFogBand) runs from near 0.62 E to far 0.95 E, where E is the
// drawn edge. When facing a diagonal of the square streaming ring, the drawn edge at the frame
// side is then only ~14 % fogged (~35 % at 22.5 deg yaw), and distant objects gain and lose
// fog as the camera turns. Range fog does not depend on yaw, and it is the retail metric.
//
// WHAT. One flag covers three shader sites, so terrain, statics and models never disagree at
// a shared silhouette:
//   1. installRadialFog(THREE) rewrites THREE.ShaderChunk.fog_vertex once. It runs before the
//      WebGLRenderer exists (scene3d/index.js preInit3D, next to installLightLoops), so every
//      stock or onBeforeCompile material that includes <fog_vertex> switches together.
//   2. radialFogTerrainGlsl() gives the near monolith (terrain.js) and the far composite ring
//      (far_terrain.js) a `vFogDist = length(mvPos.xyz)` varying and passes it to
//      terrainApplyFog. vViewDepth stays plane depth for every other ramp: POM, detail, macro,
//      sparkle fades, the CSM cascade pick and paint light. Those ramps are tuned against
//      plane depth and are not fog.
// The fog CURVE is unchanged. fog_fragment and terrainApplyFog keep three's smoothstep
// (retail's D3DFOG_LINEAR ramp would be a separate opt-in), so the fog_fragment patches in
// particles/additive_fog.js and materials.js still compose.
//
// FLAG. DEFAULT ON since 2026-10-19, flipped ahead of its 1070 eye test (owner: "default on
// what would be on after a successful eyetest"; the 1070 is unavailable), so that eye test is
// now an owed post-flip A/B against `=off`. Absent, `on` or any other value reads ON;
// `?radialFog=off|0|false|no` (trimmed, any case) is the escape. Range is >= depth everywhere,
// so the change adds haze toward the frame sides at EVERY yaw. horizonFogNear 0.62 was tuned
// against plane depth; `&horizonFogNear=0.7` is the retune knob if the mid-field washes out.
// Under an off form no chunk is touched and the terrain consumers get the very same strings,
// so the compiled programs are byte-identical to the pre-flag build.
//
// The fog_vertex rewrite follows WebAC packages/renderer/src/effects/RetailFog.ts
// patchFogVertex (after WebAC, AGPL-3.0).

/** three r184 <fog_vertex>: plane depth. */
const PLANE_LINE = "vFogDepth = - mvPosition.z;";
/** D3DRS_RANGEFOGENABLE: the distance from the eye, not the depth. */
const RANGE_LINE = "vFogDepth = length( mvPosition.xyz );";

// Terrain anchors. Each must match exactly once or the patch refuses (fail closed). The
// inserted GLSL is plain text with no backticks (terrain sources are template literals).
const T_VERT_DECL = "out float vViewDepth;";
const T_FRAG_DECL = "in float vViewDepth;";
const T_VERT_DECL_RANGE =
  "out float vFogDist;  // ?radialFog=on (scene3d/radial_fog.js): eye-to-vertex range, retail D3DRS_RANGEFOGENABLE\n";
const T_FRAG_DECL_RANGE =
  "in float vFogDist;   // ?radialFog=on (scene3d/radial_fog.js): eye-to-vertex range for terrainApplyFog\n";
const T_VERT_ASSIGN_RE = /^([ \t]*)vViewDepth = -mvPos\.z;.*$/gm;
const T_VERT_ASSIGN_RANGE = "vFogDist = length(mvPos.xyz);";
const T_FOG_CALL_RE = /terrainApplyFog\(([^,()]+), vViewDepth\)/g;

function _search(search) {
  if (typeof search === "string") return search;
  try {
    if (typeof window === "undefined" || !window.location) return "";
    return window.location.search || "";
  } catch (_) {
    return "";
  }
}

/**
 * `?radialFog` — DEFAULT ON (2026-10-19, ahead of its 1070 eye test): absent, `=on` or any
 * other value reads ON; `off`/`0`/`false`/`no` (trimmed, any case) is the escape back to
 * three's plane-depth fog. An unreadable URL reads ON.
 * @param {string} [search] defaults to window.location.search
 */
export function radialFogEnabled(search) {
  try {
    const v = new URLSearchParams(_search(search)).get("radialFog");
    const s = v == null ? "" : v.trim().toLowerCase();
    return !(s === "off" || s === "0" || s === "false" || s === "no");
  } catch (_) {
    return true;
  }
}

/**
 * Rewrite three's `fog_vertex` chunk to range fog. Idempotent. Throws if the r184 anchor is
 * missing or ambiguous.
 * @param {string} chunk three's stock `ShaderChunk.fog_vertex`
 * @returns {string}
 */
export function patchFogVertex(chunk) {
  if (typeof chunk !== "string") throw new Error("radialFog: fog_vertex chunk missing");
  if (chunk.includes(RANGE_LINE)) return chunk;
  if (chunk.split(PLANE_LINE).length !== 2) throw new Error("radialFog: fog_vertex anchor missing");
  return chunk.replace(PLANE_LINE, RANGE_LINE);
}

function _drift(label, n) {
  return new Error(`radialFog: terrain GLSL anchor drift (${label}: ${n} matches)`);
}

/**
 * Give a terrain vertex/fragment pair (terrain.js monolith or far_terrain.js patch) range fog.
 * It adds a `vFogDist = length(mvPos.xyz)` varying next to vViewDepth and passes it to the
 * terrainApplyFog call. Nothing else changes, and vViewDepth still feeds every other ramp.
 * Pure and idempotent. Throws on anchor drift.
 * @param {string} vertex
 * @param {string} fragment
 * @returns {{vertex: string, fragment: string}}
 */
export function patchTerrainFogGlsl(vertex, fragment) {
  if (typeof vertex !== "string" || typeof fragment !== "string") {
    throw new Error("radialFog: terrain GLSL missing");
  }
  const vDone = vertex.includes("out float vFogDist;");
  const fDone = fragment.includes("in float vFogDist;");
  if (vDone && fDone) return { vertex, fragment };
  if (vDone || fDone) throw new Error("radialFog: terrain GLSL half-patched");

  let n = vertex.split(T_VERT_DECL).length - 1;
  if (n !== 1) throw _drift("vertex vViewDepth decl", n);
  n = (vertex.match(T_VERT_ASSIGN_RE) || []).length;
  if (n !== 1) throw _drift("vertex vViewDepth = -mvPos.z", n);
  n = fragment.split(T_FRAG_DECL).length - 1;
  if (n !== 1) throw _drift("fragment vViewDepth decl", n);
  n = (fragment.match(T_FOG_CALL_RE) || []).length;
  if (n !== 1) throw _drift("fragment terrainApplyFog call", n);

  const v = vertex
    .replace(T_VERT_DECL, T_VERT_DECL_RANGE + T_VERT_DECL)
    .replace(T_VERT_ASSIGN_RE, (line, indent) => `${line}\n${indent}${T_VERT_ASSIGN_RANGE}`);
  const f = fragment
    .replace(T_FRAG_DECL, T_FRAG_DECL_RANGE + T_FRAG_DECL)
    .replace(T_FOG_CALL_RE, (_m, rgb) => `terrainApplyFog(${rgb}, vFogDist)`);
  return { vertex: v, fragment: f };
}

/** Diag surface: what the install did (window.__radialFog mirrors it). */
export const radialFogState = {
  enabled: false,
  installed: false,
  reason: null,
  terrainPatched: 0,
  terrainReason: null,
};

/** Test seam. */
export function __resetRadialFogForTest() {
  radialFogState.enabled = false;
  radialFogState.installed = false;
  radialFogState.reason = null;
  radialFogState.terrainPatched = 0;
  radialFogState.terrainReason = null;
}

function _publish() {
  try {
    if (typeof window !== "undefined") window.__radialFog = radialFogState;
  } catch (_) { /* fail-soft */ }
}

/**
 * The terrain shader pair a terrain module should compile this session. By default (flag
 * absent or on) it returns the range-fog pair. Under `?radialFog=off` (or 0/false/no) it
 * returns the SAME two strings, the byte-identical pre-flag program. If an anchor has
 * drifted, it warns, keeps the plane-depth pair and records the reason. Terrain modules call
 * this once at load (session-constant, like their other GLSL flags).
 * @param {string} vertex
 * @param {string} fragment
 * @param {string} [search] defaults to window.location.search
 * @returns {{vertex: string, fragment: string}}
 */
export function radialFogTerrainGlsl(vertex, fragment, search) {
  if (!radialFogEnabled(search)) return { vertex, fragment };
  try {
    const out = patchTerrainFogGlsl(vertex, fragment);
    radialFogState.terrainPatched++;
    _publish();
    return out;
  } catch (e) {
    radialFogState.terrainReason = String((e && e.message) || e);
    _publish();
    try { console.warn(`[radialFog] terrain keeps plane-depth fog: ${radialFogState.terrainReason}`); } catch (_) { /* fail-soft */ }
    return { vertex, fragment };
  }
}

/**
 * Patch `THREE.ShaderChunk.fog_vertex` in place to range fog unless `?radialFog=off` (the
 * default is on). It must run before the first program compiles (scene3d/index.js
 * preInit3D, right before the WebGLRenderer is built). Programs compiled earlier keep the stock text. Idempotent. Fails
 * closed: if the chunk has drifted, the stock chunk is kept and `reason` says why.
 * @param {{ ShaderChunk: Record<string, string> }} three the THREE namespace
 * @param {string} [search] defaults to window.location.search
 */
export function installRadialFog(three, search) {
  if (radialFogState.installed) return radialFogState;
  radialFogState.enabled = radialFogEnabled(search);
  if (!radialFogState.enabled) {
    radialFogState.reason = "off (?radialFog=off escape)";
  } else if (!three || !three.ShaderChunk || typeof three.ShaderChunk.fog_vertex !== "string") {
    radialFogState.reason = "no ShaderChunk.fog_vertex";
  } else {
    try {
      three.ShaderChunk.fog_vertex = patchFogVertex(three.ShaderChunk.fog_vertex);
      radialFogState.installed = true;
      radialFogState.reason = null;
    } catch (e) {
      radialFogState.reason = String((e && e.message) || e);
    }
  }
  _publish();
  if (radialFogState.enabled && !radialFogState.installed) {
    try { console.warn(`[radialFog] three keeps plane-depth fog: ${radialFogState.reason}`); } catch (_) { /* fail-soft */ }
  }
  return radialFogState;
}

/**
 * GLSL smoothstep(near, far, d), which is three's linear <fog_fragment> factor and
 * terrainApplyFog's.
 */
export function fogSmoothstep(near, far, d) {
  const t = Math.min(1, Math.max(0, (d - near) / (far - near)));
  return t * t * (3 - 2 * t);
}

/**
 * JS mirror of the shaders' fog factor for a LEVEL camera, used by tests and eye-test notes.
 * By default the distance is the range |pos - cam| (the shipped default). With
 * `{ radial: false }` it is three's stock plane depth along the view axis (the
 * `?radialFog=off` arm). Positions are AC metres (z up). `cam.yaw` is the heading of the view axis in radians from +x.
 * @param {{x:number, y:number, z?:number}} pos
 * @param {{x:number, y:number, z?:number, yaw:number}} cam
 * @param {{near:number, far:number}} band e.g. far_terrain_flags.js computeFogBand(...)
 * @param {{radial?: boolean}} [opts]
 */
export function radialFogFactor(pos, cam, band, opts = {}) {
  const dx = pos.x - cam.x;
  const dy = pos.y - cam.y;
  const dz = (pos.z || 0) - (cam.z || 0);
  const d = opts.radial === false
    ? dx * Math.cos(cam.yaw) + dy * Math.sin(cam.yaw)
    : Math.hypot(dx, dy, dz);
  return fogSmoothstep(band.near, band.far, d);
}
