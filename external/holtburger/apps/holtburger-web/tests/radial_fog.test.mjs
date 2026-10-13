// tests/radial_fog.test.mjs — `?radialFog=on` (OPT-IN, 2026-10-13): retail RANGE fog.
//
// Retail: RenderDeviceD3D::SetDefaultD3DStates (acclient.c) sets D3DRS_FOGTABLEMODE (35) =
// NONE, D3DRS_RANGEFOGENABLE (48) = TRUE and D3DRS_FOGVERTEXMODE (140) = LINEAR, so retail
// fogs each vertex by its DISTANCE from the eye. three's <fog_vertex> and both terrain
// shaders use the view-PLANE depth instead. Under the horizon band (computeFogBand: near
// 0.62 E, far 0.95 E), that leaves the drawn edge only ~14 % fogged at the frame side when
// facing a diagonal of the square streaming ring.
//
//   R1  flag: OPT-IN, only the exact `?radialFog=on`
//   R2  patchFogVertex on three r184's REAL fog_vertex: rewrite, idempotent, throws on drift
//   R3  installRadialFog: off = chunk untouched; on = every stock ShaderLib program resolves
//       to range fog; idempotent; fails closed; fog_fragment (the smoothstep curve) untouched
//   R4  near monolith (terrain.js): vFogDist varying + fog call; nothing else changes (the
//       terrain_batch anchors survive); default pair is the SAME strings
//   R5  far ring (far_terrain.js): the same edit, so the near/far seam fogs by one metric
//   R6  session wiring: a fresh terrain.js / far_terrain.js under ?radialFog=on compiles
//       the patched pair
//   R7  geometry (computeFogBand at R = 5, 60 deg VFOV, 16:9): the side ray to the
//       near-ring face is fully fogged by range at yaw 0 / 22.5 / 45; plane depth leaks
//       (< 0.5) at 22.5 and 45 (the bug this documents)
//   R8  source wiring: index.js installs before the WebGLRenderer, both terrain modules
//       compile the live pair, the fog curve is unchanged
//
// Fails on the pre-change code: scene3d/radial_fog.js does not exist.
//
// Run: node tests/radial_fog.test.mjs

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(HERE, "..");
const src = (rel) => readFileSync(path.join(APP, rel), "utf8");

// Browser-ish globals the terrain modules read at load (same shape as test_particle_fx_tier1).
globalThis.window = globalThis.window || {};
globalThis.location = { search: "" };
window.location = globalThis.location;
window.requestAnimationFrame = window.requestAnimationFrame || (() => 0);
window.cancelAnimationFrame = window.cancelAnimationFrame || (() => {});

const THREE = await import("three");
const R = await import("../scene3d/radial_fog.js");

let passed = 0;
let failed = 0;
function check(label, cond, extra = "") {
  if (cond) { passed++; console.log(`  [OK] ${label}`); }
  else { failed++; console.log(`  [FAIL] ${label} ${extra}`); }
}
const count = (s, needle) => s.split(needle).length - 1;
const quiet = (fn) => {
  const w = console.warn;
  console.warn = () => {};
  try { return fn(); } finally { console.warn = w; }
};

// three r184 WebGLProgram's resolveIncludes, to inspect what the GPU would receive.
const includePattern = /^[ \t]*#include +<([\w\d./]+)>/gm;
function resolveIncludes(s) {
  return s.replace(includePattern, (m, inc) => {
    const chunk = THREE.ShaderChunk[inc];
    if (chunk === undefined) throw new Error(`unknown chunk ${inc}`);
    return resolveIncludes(chunk);
  });
}

const PLANE_LINE = "vFogDepth = - mvPosition.z;";
const RANGE_LINE = "vFogDepth = length( mvPosition.xyz );";
const STOCK_FOG_VERTEX = THREE.ShaderChunk.fog_vertex;
const STOCK_FOG_FRAGMENT = THREE.ShaderChunk.fog_fragment;

// ---------------------------------------------------------------------------
console.log("-- R1 ?radialFog parsing (OPT-IN) ---------------------------------");
{
  const e = R.radialFogEnabled;
  check("absent -> off (DEFAULT OFF)", e("") === false && e("?x=1") === false);
  check("?radialFog=on -> on", e("?radialFog=on") === true && e("?a=1&radialFog=on") === true);
  for (const v of ["", "1", "true", "yes", "ON", "On", "off", "0", "garbage"]) {
    check(`?radialFog=${v} -> off (only the exact "on" opts in)`, e(`?radialFog=${v}`) === false);
  }
  check("no search argument reads window.location.search (Node: empty -> off)", e() === false);
}

// ---------------------------------------------------------------------------
console.log("-- R2 patchFogVertex on three r184's real chunk ---------------------");
{
  check(`three is r184 (the anchor this patch pins)`, THREE.REVISION === "184", THREE.REVISION);
  check("stock fog_vertex is plane depth", count(STOCK_FOG_VERTEX, PLANE_LINE) === 1);
  const p = R.patchFogVertex(STOCK_FOG_VERTEX);
  check("patched: range line in, plane line out", p.includes(RANGE_LINE) && !p.includes(PLANE_LINE));
  check("patched: only that line changed", p.replace(RANGE_LINE, PLANE_LINE) === STOCK_FOG_VERTEX);
  check("patched: still guarded by USE_FOG", /^#ifdef USE_FOG\n/.test(p) && /#endif$/.test(p));
  check("idempotent", R.patchFogVertex(p) === p);
  let threw = 0;
  for (const bad of ["", "#ifdef USE_FOG\n#endif", `${PLANE_LINE}\n${PLANE_LINE}`, undefined]) {
    try { R.patchFogVertex(bad); } catch (_) { threw++; }
  }
  check("throws on a missing / ambiguous / absent anchor", threw === 4, `threw ${threw}/4`);
}

// ---------------------------------------------------------------------------
console.log("-- R3 installRadialFog -----------------------------------------------");
{
  R.__resetRadialFogForTest();
  const fake = { ShaderChunk: { fog_vertex: STOCK_FOG_VERTEX } };
  const s0 = R.installRadialFog(fake, "");
  check("default: the chunk is untouched, nothing installed",
    fake.ShaderChunk.fog_vertex === STOCK_FOG_VERTEX && s0.installed === false && s0.enabled === false
    && /opt-in/.test(String(s0.reason)));
  check("diag surface published as window.__radialFog", window.__radialFog === R.radialFogState);

  R.__resetRadialFogForTest();
  const s1 = R.installRadialFog(fake, "?radialFog=on");
  check("?radialFog=on: chunk replaced with range fog",
    s1.installed === true && s1.reason === null && fake.ShaderChunk.fog_vertex === R.patchFogVertex(STOCK_FOG_VERTEX));
  const after = fake.ShaderChunk.fog_vertex;
  R.installRadialFog(fake, "?radialFog=on");
  check("second install is a no-op", fake.ShaderChunk.fog_vertex === after);

  R.__resetRadialFogForTest();
  const broken = { ShaderChunk: { fog_vertex: "#ifdef USE_FOG\n#endif" } };
  const s2 = quiet(() => R.installRadialFog(broken, "?radialFog=on"));
  check("drifted chunk: fails closed (stock kept, reason recorded)",
    s2.installed === false && broken.ShaderChunk.fog_vertex === "#ifdef USE_FOG\n#endif" && /anchor missing/.test(String(s2.reason)));
  R.__resetRadialFogForTest();
  const s3 = quiet(() => R.installRadialFog({}, "?radialFog=on"));
  check("no ShaderChunk: fails closed", s3.installed === false && /no ShaderChunk/.test(String(s3.reason)));

  // The real three namespace: every stock fogged program becomes range fog together.
  R.__resetRadialFogForTest();
  const s4 = R.installRadialFog(THREE, "?radialFog=on");
  check("real THREE: installed", s4.installed === true && THREE.ShaderChunk.fog_vertex.includes(RANGE_LINE));
  for (const lib of ["basic", "lambert", "phong", "standard", "physical", "toon", "matcap", "points", "sprite"]) {
    const vs = resolveIncludes(THREE.ShaderLib[lib].vertexShader);
    check(`ShaderLib.${lib}: resolved vertex shader writes the range, not the plane depth`,
      vs.includes(RANGE_LINE) && !vs.includes(PLANE_LINE));
  }
  check("fog_fragment (three's smoothstep curve) is untouched", THREE.ShaderChunk.fog_fragment === STOCK_FOG_FRAGMENT
    && STOCK_FOG_FRAGMENT.includes("float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );"));
  THREE.ShaderChunk.fog_vertex = STOCK_FOG_VERTEX; // restore for the rest of this process
  R.__resetRadialFogForTest();
}

// ---------------------------------------------------------------------------
console.log("-- R4 near monolith (terrain.js) -------------------------------------");
const terrain = await import("../scene3d/terrain.js");
const stockT = terrain._terrainGlslForTest();
const patchedT = R.patchTerrainFogGlsl(stockT.vertex, stockT.fragment);
{
  check("default (no flag): the assembled pair has no vFogDist and fogs by vViewDepth",
    !stockT.vertex.includes("vFogDist") && !stockT.fragment.includes("vFogDist")
    && stockT.fragment.includes("fragColor = vec4(terrainApplyFog(terrainLit, vViewDepth), 1.0);"));
  const live = R.radialFogTerrainGlsl(stockT.vertex, stockT.fragment, "");
  check("default: radialFogTerrainGlsl returns the SAME strings (byte-identical program)",
    live.vertex === stockT.vertex && live.fragment === stockT.fragment);
  for (const v of ["1", "true", "ON", "off"]) {
    const o = R.radialFogTerrainGlsl(stockT.vertex, stockT.fragment, `?radialFog=${v}`);
    check(`?radialFog=${v}: same strings`, o.vertex === stockT.vertex && o.fragment === stockT.fragment);
  }

  const v = patchedT.vertex;
  const f = patchedT.fragment;
  check("vertex: one vFogDist varying, declared before main()",
    count(v, "out float vFogDist;") === 1 && v.indexOf("out float vFogDist;") < v.indexOf("void main()"));
  check("vertex: vFogDist = length(mvPos.xyz) once, after the final mvPos and before gl_Position",
    count(v, "vFogDist = length(mvPos.xyz);") === 1
    && v.indexOf("vViewDepth = -mvPos.z;") < v.indexOf("vFogDist = length(mvPos.xyz);")
    && v.indexOf("vFogDist = length(mvPos.xyz);") < v.indexOf("gl_Position = projectionMatrix * mvPos;"));
  check("vertex: vViewDepth stays plane depth", v.includes("vViewDepth = -mvPos.z;"));
  check("fragment: one vFogDist input, declared before main()",
    count(f, "in float vFogDist;") === 1 && f.indexOf("in float vFogDist;") < f.indexOf("void main()"));
  check("fragment: the fog call reads vFogDist",
    f.includes("fragColor = vec4(terrainApplyFog(terrainLit, vFogDist), 1.0);")
    && !f.includes("terrainApplyFog(terrainLit, vViewDepth)"));
  const vvd = /\bvViewDepth\b/g;
  check("fragment: every other vViewDepth use is kept (only the fog call moved)",
    (f.match(vvd) || []).length === (stockT.fragment.match(vvd) || []).length - 1
    && f.includes("if (uPomEnabled > 0.5 && vViewDepth < uPomFadeEnd && !cellTouchesWater)")
    && f.includes("modulated = terrainPaintLight(modulated, normalize(vAcNormal), sunDir, vViewDepth, uPaintLight);"));
  check("only those edits: drop the vFogDist lines + restore the call -> the stock pair",
    v.split("\n").filter((l) => !l.includes("vFogDist")).join("\n") === stockT.vertex
    && f.split("\n").filter((l) => !/^\s*in float vFogDist;/.test(l)).join("\n")
      .replace("terrainApplyFog(terrainLit, vFogDist)", "terrainApplyFog(terrainLit, vViewDepth)") === stockT.fragment);
  const BATCH = src("scene3d/terrain_batch.js");
  const placement = "  vWorldPos = (modelMatrix * vec4(displacedPos, 1.0)).xyz;\n  vec4 mvPos = modelViewMatrix * vec4(displacedPos, 1.0);";
  check("terrain_batch's vertex placement anchor still matches exactly once",
    BATCH.includes(JSON.stringify(placement).slice(1, -1)) && count(v, placement) === 1);
  check("no backtick in the patched GLSL", !v.includes("`") && !f.includes("`"));
  const again = R.patchTerrainFogGlsl(v, f);
  check("idempotent", again.vertex === v && again.fragment === f);

  let threw = 0;
  const tries = [
    [stockT.vertex.replace("vViewDepth = -mvPos.z;", ""), stockT.fragment],
    [stockT.vertex.replace("out float vViewDepth;", ""), stockT.fragment],
    [stockT.vertex, stockT.fragment.replace("in float vViewDepth;", "")],
    [stockT.vertex, stockT.fragment.replace("terrainApplyFog(terrainLit, vViewDepth)", "terrainLit")],
    [stockT.vertex, stockT.fragment + "\n// terrainApplyFog(x, vViewDepth)"],
    [v, stockT.fragment],
  ];
  for (const [tv, tf] of tries) {
    try { R.patchTerrainFogGlsl(tv, tf); } catch (_) { threw++; }
  }
  check("anchor drift / duplicate / half-patched -> throws", threw === tries.length, `threw ${threw}/${tries.length}`);
  R.__resetRadialFogForTest();
  const kept = quiet(() => R.radialFogTerrainGlsl(stockT.vertex, "void main() {}", "?radialFog=on"));
  check("radialFogTerrainGlsl on drift: keeps the plane-depth pair and records why",
    kept.vertex === stockT.vertex && kept.fragment === "void main() {}" && /anchor drift/.test(String(R.radialFogState.terrainReason)));
  R.__resetRadialFogForTest();
}

// ---------------------------------------------------------------------------
console.log("-- R5 far ring (far_terrain.js) ---------------------------------------");
const far = await import("../scene3d/far_terrain.js");
const stockF = far._farGlslForTest();
const patchedF = R.patchTerrainFogGlsl(stockF.vertex, stockF.fragment);
{
  check("default: the material compiles the exported strings unchanged",
    stockF.vertex === far.FAR_VERTEX_GLSL && stockF.fragment === far.FAR_FRAGMENT_GLSL
    && stockF.fragment.includes("terrainApplyFog(lit, vViewDepth)") && !stockF.fragment.includes("vFogDist"));
  const v = patchedF.vertex;
  const f = patchedF.fragment;
  check("patched: vFogDist varying, assigned after vViewDepth, read by the fog call",
    count(v, "out float vFogDist;") === 1
    && v.indexOf("vViewDepth = -mvPos.z;") < v.indexOf("vFogDist = length(mvPos.xyz);")
    && v.indexOf("vFogDist = length(mvPos.xyz);") < v.indexOf("gl_Position = projectionMatrix * mvPos;")
    && count(f, "in float vFogDist;") === 1
    && f.includes("fragColor = vec4(terrainApplyFog(lit, vFogDist), 1.0);"));
  check("patched: paint light keeps plane depth",
    f.includes("albedo = terrainPaintLight(albedo, normalize(vAcNormal), sunDir, vViewDepth, uPaintLight);"));
  const fogLines = (s) => s.split("\n").filter((l) => l.includes("vFogDist")).map((l) => l.trim());
  check("near and far carry the same range expression (one metric at the seam)",
    fogLines(patchedT.vertex).includes("vFogDist = length(mvPos.xyz);")
    && fogLines(v).includes("vFogDist = length(mvPos.xyz);"));
}

// ---------------------------------------------------------------------------
console.log("-- R6 session wiring under ?radialFog=on ------------------------------");
{
  window.location.search = "?radialFog=on";
  R.__resetRadialFogForTest();
  const t2 = await import("../scene3d/terrain.js?radialFog=on");
  const f2 = await import("../scene3d/far_terrain.js?radialFog=on");
  const lt = t2._terrainGlslForTest();
  const lf = f2._farGlslForTest();
  check("terrain.js compiles the range-fog pair", lt.vertex === patchedT.vertex && lt.fragment === patchedT.fragment);
  check("far_terrain.js compiles the range-fog pair", lf.vertex === patchedF.vertex && lf.fragment === patchedF.fragment);
  check("both terrain modules reported patched, no drift",
    R.radialFogState.terrainPatched === 2 && R.radialFogState.terrainReason === null);
  window.location.search = "";
  R.__resetRadialFogForTest();
}

// ---------------------------------------------------------------------------
console.log("-- R7 geometry: the side-ray leak at R = 5 ----------------------------");
{
  const F = await import("../scene3d/far_terrain_flags.js");
  const band = F.computeFogBand({
    authoredMin: 150, authoredMax: 2400, rEffLb: 5,
    frac: F.farFogFrac(), floorM: F.farFogFloorM(), floorMinLb: F.farFogFloorMinLb(),
    horizon: true, horizonNear: F.horizonFogNearFrac(),
  });
  const E = band.drawnEdgeM;
  check("live horizon band at R = 5: 0.62 E -> 0.95 E, E = 1056 m",
    band.mode === "horizon" && E === 1056 && Math.abs(band.near - 0.62 * E) < 1e-9 && Math.abs(band.far - 0.95 * E) < 1e-9,
    JSON.stringify(band));
  // index.js: new THREE.PerspectiveCamera(60, cssW / cssH, ...). 16:9 half-HFOV ~45.7 deg.
  const D = Math.PI / 180;
  const halfH = Math.atan(Math.tan(30 * D) * (16 / 9));
  check("16:9 at 60 deg VFOV: half-HFOV is 45.7 deg", Math.abs(halfH / D - 45.74) < 0.01, (halfH / D).toFixed(3));
  const cam = { x: 0, y: 0, z: 0 };
  // The near ring is a Chebyshev SQUARE (far_terrain.js): where a ground ray from the
  // ring centre first meets its drawn edge.
  const edgeHit = (theta) => {
    const t = E / Math.max(Math.abs(Math.cos(theta)), Math.abs(Math.sin(theta)));
    return { x: t * Math.cos(theta), y: t * Math.sin(theta) };
  };
  const factors = (yawDeg) => {
    const yaw = yawDeg * D;
    const c = { ...cam, yaw };
    const rays = [yaw - halfH, yaw, yaw + halfH].map(edgeHit);
    return {
      radial: rays.map((p) => R.radialFogFactor(p, c, band)),
      plane: rays.map((p) => R.radialFogFactor(p, c, band, { radial: false })),
    };
  };
  const f0 = factors(0);
  const f22 = factors(22.5);
  const f45 = factors(45);
  for (const [yawDeg, fx] of [[0, f0], [22.5, f22], [45, f45]]) {
    check(`yaw ${yawDeg}: range fog fully hides the drawn edge across the frame`,
      fx.radial.every((v) => v === 1), fx.radial.map((v) => v.toFixed(3)).join(" "));
  }
  check("yaw 0 (axis-aligned): plane depth already ~fully fogged at the sides",
    Math.min(f0.plane[0], f0.plane[2]) > 0.99, f0.plane.map((v) => v.toFixed(3)).join(" "));
  check("yaw 22.5: plane depth leaks the edge at a frame side (< 0.5)",
    Math.min(f22.plane[0], f22.plane[2]) < 0.5, f22.plane.map((v) => v.toFixed(3)).join(" "));
  check("yaw 45 (diagonal): plane depth leaves the side edge ~14 % fogged (< 0.5)",
    Math.min(f45.plane[0], f45.plane[2]) < 0.5 && Math.abs(Math.min(f45.plane[0], f45.plane[2]) - 0.14) < 0.02,
    f45.plane.map((v) => v.toFixed(3)).join(" "));
  // Range reaches factor 1 at 0.95 E for ANY yaw and any column of the frame.
  let allOne = true;
  let planeMin = 1;
  for (let yd = 0; yd < 360; yd += 7.5) {
    for (let k = -4; k <= 4; k++) {
      const theta = yd * D + (k / 4) * halfH;
      const p = { x: band.far * Math.cos(theta), y: band.far * Math.sin(theta) };
      const c = { ...cam, yaw: yd * D };
      if (R.radialFogFactor(p, c, band) !== 1) allOne = false;
      planeMin = Math.min(planeMin, R.radialFogFactor(p, c, band, { radial: false }));
    }
  }
  check("range: factor 1 at 0.95 E for every yaw and every frame column", allOne);
  check("plane: the same points drop well below 1 off-axis (yaw-dependent fog)", planeMin < 0.2, planeMin.toFixed(3));
  // Yaw invariance: one world point, the camera turning while it stays on screen.
  const pt = { x: 800, y: 300 };
  const bearing = Math.atan2(pt.y, pt.x);
  const rs = [];
  const ps = [];
  for (let k = -4; k <= 4; k++) {
    const c = { ...cam, yaw: bearing + (k / 4) * halfH * 0.95 };
    rs.push(R.radialFogFactor(pt, c, band));
    ps.push(R.radialFogFactor(pt, c, band, { radial: false }));
  }
  check("range fog of a fixed point does not change as the camera turns",
    rs.every((v) => Math.abs(v - rs[0]) < 1e-12));
  check("plane fog of the same point does", Math.max(...ps) - Math.min(...ps) > 0.2,
    `${Math.min(...ps).toFixed(3)}..${Math.max(...ps).toFixed(3)}`);
  check("fogSmoothstep is three's smoothstep(near, far, d)",
    R.fogSmoothstep(100, 200, 100) === 0 && R.fogSmoothstep(100, 200, 200) === 1
    && Math.abs(R.fogSmoothstep(100, 200, 150) - 0.5) < 1e-12 && Math.abs(R.fogSmoothstep(100, 200, 125) - 0.15625) < 1e-12);
}

// ---------------------------------------------------------------------------
console.log("-- R8 source wiring ---------------------------------------------------");
{
  const IDX = src("scene3d/index.js");
  const T = src("scene3d/terrain.js");
  const FT = src("scene3d/far_terrain.js");
  const TAIL = src("scene3d/terrain_shared_glsl.js");
  const RF = src("scene3d/radial_fog.js");
  check("index.js imports installRadialFog", IDX.includes('import { installRadialFog } from "./radial_fog.js";'));
  const iInstall = IDX.indexOf("installRadialFog(THREE);");
  check("index.js installs it before the WebGLRenderer is built (before any compile)",
    iInstall > 0 && iInstall < IDX.indexOf("new THREE.WebGLRenderer("));
  // The ShaderMaterial constructors name the template constants (so
  // test_shader_logdepth.mjs L4 resolves them) and the live pair is swapped in
  // right after construction, before the first compile.
  const ctorThenSwap = (S, ctorRe, vConst, fConst, live, matVar) => {
    const c = ctorRe.exec(S);
    if (!c) return false;
    const open = S.indexOf("(", c.index);
    let close = -1;
    for (let i = open, depth = 0; i < S.length; i++) {
      if (S[i] === "(") depth++;
      else if (S[i] === ")" && --depth === 0) { close = i; break; }
    }
    if (close < 0) return false;
    const call = S.slice(open, close + 1);
    // Only comments/whitespace between the constructor's `);` and the two swaps.
    const rest = S.slice(close + 1).replace(/^;/, "").replace(/^(\s*\/\/[^\n]*)*\s*/, "");
    const [l1 = "", l2 = ""] = rest.split("\n");
    return call.includes(`vertexShader: ${vConst},`) && call.includes(`fragmentShader: ${fConst},`)
      && !call.includes(live)
      && l1 === `if (${live}.vertex !== ${vConst}) ${matVar}.vertexShader = ${live}.vertex;`
      && l2.trim() === `if (${live}.fragment !== ${fConst}) ${matVar}.fragmentShader = ${live}.fragment;`;
  };
  check("terrain.js compiles the live pair (material swap + batch)",
    T.includes("const TERRAIN_LIVE_GLSL = radialFogTerrainGlsl(TERRAIN_VERTEX_GLSL, TERRAIN_FRAGMENT_GLSL);")
    && ctorThenSwap(T, /material = new THREE\.ShaderMaterial\(\{/, "TERRAIN_VERTEX_GLSL", "TERRAIN_FRAGMENT_GLSL", "TERRAIN_LIVE_GLSL", "material")
    && T.includes("vertexGlsl: TERRAIN_LIVE_GLSL.vertex,") && T.includes("fragmentGlsl: TERRAIN_LIVE_GLSL.fragment,")
    && !/vertexGlsl: TERRAIN_VERTEX_GLSL|fragmentGlsl: TERRAIN_FRAGMENT_GLSL/.test(T));
  check("far_terrain.js compiles the live pair (material swap)",
    FT.includes("const FAR_LIVE_GLSL = radialFogTerrainGlsl(FAR_VERTEX_GLSL, FAR_FRAGMENT_GLSL);")
    && ctorThenSwap(FT, /const mat = new THREE\.ShaderMaterial\(\{/, "FAR_VERTEX_GLSL", "FAR_FRAGMENT_GLSL", "FAR_LIVE_GLSL", "mat"));
  check("terrain source keeps the plane-depth call text (patched only at assembly)",
    T.includes("fragColor = vec4(terrainApplyFog(terrainLit, vViewDepth), 1.0);")
    && FT.includes("fragColor = vec4(terrainApplyFog(lit, vViewDepth), 1.0);"));
  check("the fog CURVE is unchanged: the shared tail keeps three's smoothstep",
    TAIL.includes("float fogFactor = smoothstep( fogNear, fogFar, viewDepth );"));
  check("radial_fog.js never touches fog_fragment", !/fog_fragment\s*=/.test(RF));
  check("flag reader is exact opt-in", RF.includes('.get("radialFog") === "on"'));
  check("WebAC attribution present", /after WebAC, AGPL-3\.0/.test(RF) && RF.includes("RetailFog.ts"));
}

console.log(`\nradial fog: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
