// 2026-10-07 — terrain FINE SURFACE DETAIL (scene3d/terrain_micro.js, step 4
// of the owner's terrain plan) test.
//
// Run with:
//   cd apps/holtburger-web && node test_terrain_micro.mjs
// (needs the three stub that test_terrain_palette.mjs generates; it is
// committed-by-generation next to this file.)
//
// Locks:
//  1. FLAGS — all four features default-ON; off/0/false/no escapes; numeric
//     strength knobs; `=on` forces past the low-tier hold; clamps; fades.
//  2. MATHS (JS mirrors of the GLSL):
//     - micro perturbation is LINEAR in the slope => the mean Gouraud dot is
//       exactly the retail one (no near/far brightness drift); the tangent
//       frame is east/north on flat ground and orthonormal everywhere;
//     - the two-slice procedural blend is continuous where the nearest
//       corner switches (the single nearest-slice form is not);
//     - the height blend never changes authored full coverage (0 / 1), is
//       the identity at amount 0, stays in [0, 1], is 0.5 at the mask
//       midpoint for equal heights, and favours the higher layer;
//     - the gamma crossfade reproduces retail's framebuffer operation and
//       the old linear mix measurably lifts dark ground;
//     - snapped procedural tiles are seamless across a 192 m landblock edge
//       (fine axis-aligned AND coarse 3-4-5 rotated).
//  3. ASSEMBLED GLSL (terrain.js resolved for the default session):
//     - no sampler added: the fragment program's sampler set is exactly the
//       known 15 + the #ifdef'd trail map (cells.js / terrain_shared_glsl.js
//       budget); none of the step-4 strings declares a sampler;
//     - every raw atlas / nra / mask texture() tap is gone outside the
//       helpers (the mip-seam fix covers every site);
//     - gradients taken in uniform control flow (top of main);
//     - every helper / local is defined before first use; braces balanced;
//       no integer literal in float arithmetic in the step-4 strings;
//     - the terrain_batch anchors still occur exactly once;
//     - micro-relief perturbs the bevel's OUTPUT inside the Gouraud branch.
//  4. WIRING — uniforms spread into the material, diag installed, far-ring
//     safety (every fade ends inside one landblock), url-flags rows.
//  5. FLAG VARIANTS — every escape compiles its own program (the features are
//     compile-time); a child process per URL re-assembles terrain.js and
//     checks it is well-formed, keeps 16 sampler declarations and contains
//     exactly the gated code.

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";
import { register } from "node:module";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const __filename = fileURLToPath(import.meta.url);
// Variant mode (section 5): the four features are COMPILE-TIME (read once at
// module load from window.location), so each escape compiles a different
// program. A child process per variant sets the URL before any import.
const VI = process.argv.indexOf("--variant");
const VARIANT = VI >= 0 ? (process.argv[VI + 1] ?? "") : null;
if (VARIANT !== null) {
  globalThis.window = { location: { search: VARIANT }, addEventListener() {}, removeEventListener() {} };
}
const M = await import("./scene3d/terrain_micro.js");
let passed = 0, failed = 0;
function check(label, cond, extra = "") {
  if (cond) { passed++; console.log(`  [OK] ${label}`); }
  else { failed++; console.log(`  [FAIL] ${label} ${extra}`); }
}
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm3 = (a) => Math.hypot(a[0], a[1], a[2]);
// Deterministic PRNG (mulberry32) — no Math.random in tests either.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const STUB_LOADER = resolvePath(__dirname, "_three_stub_palette_loader.mjs");
const stripC = (g) => g.replace(/\/\/[^\n]*/g, "");
const balanced = (code) => [["{", "}"], ["(", ")"], ["[", "]"]].every(([o, c]) => {
  let d = 0;
  for (const ch of code) { if (ch === o) d += 1; else if (ch === c) { d -= 1; if (d < 0) return false; } }
  return d === 0;
});
const samplerNames = (code) => [...code.matchAll(/uniform\s+(?:highp\s+|mediump\s+|lowp\s+)?sampler\w+\s+(\w+)\s*;/g)].map((m) => m[1]).sort();

if (VARIANT !== null) {
  // ---- child: one flag variant ----
  register(pathToFileURL(STUB_LOADER).href, import.meta.url);
  const T = await import(pathToFileURL(resolvePath(__dirname, "scene3d/terrain.js")).href);
  const code = stripC(T._terrainGlslForTest().fragment);
  const C = M.TERRAIN_MICRO;
  check(`[${VARIANT || "default"}] delimiters balanced`, balanced(code));
  check(`[${VARIANT || "default"}] 16 sampler declarations (no new unit)`, samplerNames(code).length === 16);
  check(`[${VARIANT || "default"}] sampling helpers always present`, /vec4 terrainAtlasTex\(/.test(code) && /vec4 terrainMaskTex\(/.test(code));
  check(`[${VARIANT || "default"}] gradUv=${C.gradUv}: textureGrad / gradients iff on`,
    C.gradUv === code.includes("textureGrad(") && C.gradUv === code.includes("gTerrainGridDx = dFdx(vGridUv);"));
  check(`[${VARIANT || "default"}] micro=${C.micro}: micro uniforms + apply iff on`,
    C.micro === code.includes("uniform vec4 uMicroAmt;") && C.micro === code.includes("acShadeN = terrainMicroPerturb(")
    && C.micro === /\bmicroNear\b/.test(code));
  check(`[${VARIANT || "default"}] heightBlend=${C.heightBlend}: height-blend code iff on`,
    C.heightBlend === code.includes("uniform vec4 uHeightBlend;") && C.heightBlend === /\bhbAmt\b/.test(code));
  check(`[${VARIANT || "default"}] detailGamma=${C.detailGamma}: gamma vs linear crossfade`,
    C.detailGamma === code.includes("result = terrainDetailGammaMix(result, detail.rgb, amtA);")
    && C.detailGamma !== code.includes("result = mix(result, detail.rgb, amtA);"));
  check(`[${VARIANT || "default"}] the Gouraud call reads acShadeN`, code.includes("modulated = terrainAcGouraud(modulated, acShadeN, uAcSunVec,"));
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

// ---------------------------------------------------------------------------
console.log("\n-- 1. flags --");
{
  const d = M.readTerrainMicroConfig("");
  check("defaults: all four features ON", d.micro && d.heightBlend && d.detailGamma && d.gradUv);
  check("defaults: documented numbers", d.strength === 1 && d.fadeStartM === 20 && d.fadeEndM === 75
    && d.material === 2 && d.procedural === 0.25 && d.rock === 0.6 && d.hbAmount === 1
    && d.hbGain === 3 && d.hbSharp === 0.15 && d.hbFadeStartM === 30 && d.hbFadeEndM === 90);
  check("defaults frozen", Object.isFrozen(M.TERRAIN_MICRO_DEFAULTS));
  for (const v of ["off", "0", "false", "no", "OFF"]) {
    const c = M.readTerrainMicroConfig(`?terrainMicro=${v}&terrainHeightBlend=${v}&terrainDetailGamma=${v}&terrainGradUv=${v}`);
    check(`escape '${v}' disables all four`, !c.micro && !c.heightBlend && !c.detailGamma && !c.gradUv);
  }
  const s = M.readTerrainMicroConfig("?terrainMicro=0.4&terrainHeightBlend=0.5");
  check("numeric master = strength / amount", s.micro && s.strength === 0.4 && s.heightBlend && s.hbAmount === 0.5);
  check("numeric clamps", M.readTerrainMicroConfig("?terrainMicro=9").strength === 3
    && M.readTerrainMicroConfig("?terrainMicroMaterial=99").material === 6
    && M.readTerrainMicroConfig("?terrainMicroDetail=-1").procedural === 0
    && M.readTerrainMicroConfig("?terrainHeightBlendSharp=0").hbSharp === 0.02);
  const f = M.readTerrainMicroConfig("?terrainMicroFade=10,60&terrainHeightBlendFade=45");
  check("fade pairs (A,B) and (B -> B/3,B)", f.fadeStartM === 10 && f.fadeEndM === 60 && f.hbFadeStartM === 15 && f.hbFadeEndM === 45);
  const bad = M.readTerrainMicroConfig("?terrainMicroFade=50,20");
  check("inverted fade repaired (smoothstep needs e0 < e1)", bad.fadeEndM > bad.fadeStartM);
  check("garbage numerics fall back to defaults", M.readTerrainMicroConfig("?terrainMicroMaterial=abc").material === 2);
  const on = M.readTerrainMicroConfig("?terrainMicro=on&terrainHeightBlend=on");
  check("low tier holds micro + height blend at 0 by default",
    !M.terrainMicroTierOn("low", "micro", d) && !M.terrainMicroTierOn("low", "heightBlend", d)
    && M.terrainMicroTierOn("ultra", "micro", d) && M.terrainMicroTierOn("mid", "heightBlend", d));
  check("`=on` forces them on the low tier", M.terrainMicroTierOn("low", "micro", on) && M.terrainMicroTierOn("low", "heightBlend", on));
  check("source records only what the URL set", Object.keys(d.source).length === 0
    && f.source.terrainMicroFade === "10,60");
  // Uniform factory (fake THREE).
  class V2 { constructor(x, y) { this.x = x; this.y = y; } set(x, y) { this.x = x; this.y = y; } }
  class V4 { constructor(x, y, z, w) { this.x = x; this.y = y; this.z = z; this.w = w; } set(x, y, z, w) { this.x = x; this.y = y; this.z = z; this.w = w; } }
  const T = { Vector2: V2, Vector4: V4 };
  const uu = M.terrainMicroUniforms(T, "ultra", d);
  check("uniforms: all five entries at ultra", ["uMicroFade", "uMicroAmt", "uMicroTiles", "uHeightBlend", "uHeightBlendFade"].every((k) => uu[k] && uu[k].value));
  check("uniforms: amounts live at ultra", uu.uMicroAmt.value.x === 1 && uu.uMicroAmt.value.y === 2 && uu.uHeightBlend.value.x === 1);
  const ul = M.terrainMicroUniforms(T, "low", d);
  check("uniforms: low tier -> amount 0 (shader early-outs)", ul.uMicroAmt.value.x === 0 && ul.uHeightBlend.value.x === 0);
  const uo = M.terrainMicroUniforms(T, "ultra", M.readTerrainMicroConfig("?terrainMicro=off&terrainHeightBlend=off"));
  check("uniforms: none when both features are compiled out", Object.keys(uo).length === 0);
  // Live setter.
  const mat = { uniforms: M.terrainMicroUniforms(T, "ultra", d) };
  const r = M.setTerrainMicroLive({ terrainMaterials: [mat, mat] }, { strength: 0.5, hbAmount: 0.25, fadeStartM: 5, fadeEndM: 40, fineTileM: 3 });
  check("live set reaches each material once", r.materials === 1 && mat.uniforms.uMicroAmt.value.x === 0.5
    && mat.uniforms.uHeightBlend.value.x === 0.25 && mat.uniforms.uMicroFade.value.y === 40);
  check("live tile size is re-snapped seamless", near(mat.uniforms.uMicroTiles.value.x * 8, Math.round(mat.uniforms.uMicroTiles.value.x * 8)));
  M.setTerrainMicroLive({ terrainMaterials: [] }, { ...M.TERRAIN_MICRO_DEFAULTS }); // restore module state
}

// ---------------------------------------------------------------------------
console.log("\n-- 2. maths --");
{
  // (a) micro perturbation: frame + exact mean preservation.
  const R = rng(0x5eed);
  const e0 = M.microPerturbNormal([0, 0, 1], [1, 0]);
  const n0 = M.microPerturbNormal([0, 0, 1], [0, 1]);
  check("flat ground: +x slope tilts EAST, +y slope tilts NORTH (the nra/detail convention)",
    near(e0[0], 1) && near(e0[1], 0) && near(n0[0], 0) && near(n0[1], 1));
  check("zero slope is the identity", M.microPerturbNormal([0.1, -0.2, 0.7], [0, 0]).every((c, i) => near(c, [0.1, -0.2, 0.7][i])));
  let maxMeanErr = 0, maxFrameErr = 0;
  for (let i = 0; i < 2000; i += 1) {
    const len = 0.6 + 0.4 * R();
    const t = R() * 1.2, p = R() * 2 * Math.PI; // tilt up to ~69 deg
    const n = [Math.sin(t) * Math.cos(p) * len, Math.sin(t) * Math.sin(p) * len, Math.cos(t) * len];
    const sun = [R() - 0.5, R() - 0.5, R()]; const sl = norm3(sun); for (let k = 0; k < 3; k += 1) sun[k] *= 0.8 / sl;
    const s = [(R() - 0.5) * 0.6, (R() - 0.5) * 0.6];
    const a = M.microPerturbNormal(n, s), b = M.microPerturbNormal(n, [-s[0], -s[1]]);
    maxMeanErr = Math.max(maxMeanErr, Math.abs((dot3(a, sun) + dot3(b, sun)) / 2 - dot3(n, sun)));
    // Frame: perturbation is perpendicular to n and has length |n|*|s|.
    const d = [a[0] - n[0], a[1] - n[1], a[2] - n[2]];
    maxFrameErr = Math.max(maxFrameErr, Math.abs(dot3(d, n)) / len, Math.abs(norm3(d) - len * Math.hypot(s[0], s[1])));
  }
  check(`mean Gouraud dot preserved exactly (linear in slope; max err ${maxMeanErr.toExponential(1)})`, maxMeanErr < 1e-12);
  check(`tangent frame orthonormal to n (max err ${maxFrameErr.toExponential(1)})`, maxFrameErr < 1e-9);
  check("degenerate normal passes through", M.microPerturbNormal([0, 0, 0], [0.3, 0.3]).every((c) => c === 0));

  // (b) fade curve.
  check("fade: 1 nearer than start, 0 beyond end, monotone",
    M.microFadeAt(5, 20, 75) === 1 && M.microFadeAt(80, 20, 75) === 0
    && M.microFadeAt(30, 20, 75) > M.microFadeAt(50, 20, 75) && M.microFadeAt(50, 20, 75) > 0);

  // (c) two-slice blend continuity across the nearest-corner switch.
  const R2 = rng(0xc0ffee);
  let worst2 = 0, worst1 = 0, configs = 0;
  for (let k = 0; k < 400; k += 1) {
    const pool = [0, 1, 2, 3, 4];
    const a = pool[Math.floor(R2() * 5)];
    let b = pool[Math.floor(R2() * 5)]; if (b === a) b = (a + 1) % 5;
    const corners = [0, 1, 2, 3].map(() => (R2() < 0.5 ? a : b));
    if (R2() < 0.2) corners[Math.floor(R2() * 4)] = 255; // a water / swamp corner
    const det = {}; for (const sl of [0, 1, 2, 3, 4]) det[sl] = [R2() - 0.5, R2() - 0.5];
    const blend2 = (fu, fv) => {
      const w = [(1 - fu) * (1 - fv), fu * (1 - fv), (1 - fu) * fv, fu * fv];
      const sw = M.microSliceWeights(corners, w);
      const out = [0, 0];
      if (sw.s1 < 5) { out[0] += det[sw.s1][0] * sw.w1; out[1] += det[sw.s1][1] * sw.w1; }
      if (sw.s2 < 5) { out[0] += det[sw.s2][0] * sw.w2; out[1] += det[sw.s2][1] * sw.w2; }
      return out;
    };
    const blend1 = (fu, fv) => { // the single nearest-corner slice (the Phase 1.2 form)
      const w = [(1 - fu) * (1 - fv), fu * (1 - fv), (1 - fu) * fv, fu * fv];
      let ni = 0; for (let i = 1; i < 4; i += 1) if (w[i] > w[ni]) ni = i;
      return corners[ni] < 5 ? det[corners[ni]] : [0, 0];
    };
    const h = 1e-4;
    for (let t = 0.05; t < 1; t += 0.05) {
      for (const [p, q] of [[[0.5 - h, t], [0.5 + h, t]], [[t, 0.5 - h], [t, 0.5 + h]]]) {
        const d2 = Math.hypot(blend2(...p)[0] - blend2(...q)[0], blend2(...p)[1] - blend2(...q)[1]);
        const d1 = Math.hypot(blend1(...p)[0] - blend1(...q)[0], blend1(...p)[1] - blend1(...q)[1]);
        worst2 = Math.max(worst2, d2); worst1 = Math.max(worst1, d1);
      }
    }
    configs += 1;
  }
  check(`two-slice blend continuous across the midlines (${configs} cells, max jump ${worst2.toExponential(1)})`, worst2 < 1e-3);
  check(`(the old nearest-slice form jumps there: ${worst1.toFixed(2)})`, worst1 > 0.1);
  const sw = M.microSliceWeights([0, 0, 3, 255], [0.4, 0.3, 0.2, 0.1]);
  check("slice weights: primary sums its corners, secondary the heaviest other real slice, water excluded",
    sw.s1 === 0 && near(sw.w1, 0.7) && sw.s2 === 3 && near(sw.w2, 0.2));
  const sww = M.microSliceWeights([255, 1, 4, 1], [0.4, 0.3, 0.2, 0.1]);
  check("a heaviest WATER corner does not take a slot (both real slices kept)",
    sww.s1 === 1 && near(sww.w1, 0.4) && sww.s2 === 4 && near(sww.w2, 0.2));

  // (d) height blend.
  let okEnds = true, okId = true, okRange = true;
  const R3 = rng(77);
  for (let i = 0; i < 3000; i += 1) {
    const hB = (R3() - 0.5) * 0.4, hO = (R3() - 0.5) * 0.4, amt = R3(), g = R3() * 10, sh = 0.02 + R3() * 0.48;
    if (M.heightBlendWeight(0, hB, hO, amt, g, sh) !== 0 || M.heightBlendWeight(1, hB, hO, amt, g, sh) !== 1) okEnds = false;
    const bw = R3();
    if (!near(M.heightBlendWeight(bw, hB, hO, 0, g, sh), bw)) okId = false;
    const v = M.heightBlendWeight(bw, hB, hO, amt, g, sh);
    if (!(v >= 0 && v <= 1)) okRange = false;
  }
  check("height blend never touches authored full coverage (w = 0 / 1 exact)", okEnds);
  check("height blend is the identity at amount 0", okId);
  check("height blend stays in [0, 1]", okRange);
  check("equal heights at the mask midpoint stay 0.5", near(M.heightBlendWeight(0.5, 0.1, 0.1, 1, 3, 0.15), 0.5));
  check("the HIGHER layer wins the transition (base higher -> more base)",
    M.heightBlendWeight(0.5, 0.06, -0.06, 1, 3, 0.15) > 0.9 && M.heightBlendWeight(0.5, -0.06, 0.06, 1, 3, 0.15) < 0.1);
  check("sharpening: same-height ramp steepens around 0.5",
    M.heightBlendWeight(0.4, 0, 0, 1, 3, 0.15) < 0.4 && M.heightBlendWeight(0.6, 0, 0, 1, 3, 0.15) > 0.6);

  // (e) gamma crossfade (retail tile 0x06006D57: sRGB mean 0.41, alpha ~0.21).
  const baseS = 0.22, detS = 0.41, a = 0.21;
  const baseL = M.srgbToLin(baseS), detL = M.srgbToLin(detS);
  const retail = M.srgbToLin(baseS * (1 - a) + detS * a);
  const gamma = M.detailGammaMix(baseL, detL, a);
  const linear = baseL * (1 - a) + detL * a;
  check(`gamma crossfade == retail framebuffer op (${gamma.toFixed(5)} vs ${retail.toFixed(5)})`, near(gamma, retail, 1e-12));
  check(`the old linear mix lifted dark grass by ${((linear / retail - 1) * 100).toFixed(0)}% at the camera`, linear / retail > 1.1);
  check("a = 0 round-trips the base", near(M.detailGammaMix(0.05, 0.168, 0), 0.05, 1e-12));
  check("srgb <-> lin round trip", [0, 0.001, 0.02, 0.2, 0.5, 1].every((v) => near(M.srgbToLin(M.linToSrgb(v)), v, 1e-12)));

  // (f) seamless tiles across the landblock edge.
  let okSeam = true;
  for (const [fm, cm] of [[2.4, 7.68], [1.5, 6], [3.3, 11], [0.7, 19.9], [24, 50]]) {
    const t = M.snapMicroTiles(fm, cm);
    const fine = [8 * t.fine, 0], cx = [0.8 * 8 * t.coarse, 0.6 * 8 * t.coarse], cy = [-0.6 * 8 * t.coarse, 0.8 * 8 * t.coarse];
    for (const v of [...fine, ...cx, ...cy]) if (!near(v, Math.round(v), 1e-9)) okSeam = false;
    if (Math.abs(t.fineM - fm) / fm > 0.5 || Math.abs(t.coarseM - cm) / cm > 0.5) okSeam = false;
  }
  check("snapped tiles: integer UV step across a 192 m edge (fine + rotated coarse), close to the request", okSeam);
  const td = M.snapMicroTiles(2.4, 7.68);
  check("default tiles: 80 + 25 per landblock (2.4 m / 7.68 m)", td.finePerLb === 80 && td.coarsePerLb === 25);
}

// ---------------------------------------------------------------------------
console.log("\n-- 3. assembled GLSL --");
const STUB_LOADER_PATH = resolvePath(__dirname, "_three_stub_palette_loader.mjs");
if (!existsSync(STUB_LOADER_PATH)) {
  console.error(`[setup] missing ${STUB_LOADER_PATH}; run test_terrain_palette.mjs once first.`);
  process.exit(2);
}
register(pathToFileURL(STUB_LOADER_PATH).href, import.meta.url);
const T = await import(pathToFileURL(resolvePath(__dirname, "scene3d/terrain.js")).href);
const { fragment: FRAG } = T._terrainGlslForTest();
const SRC = readFileSync(resolvePath(__dirname, "scene3d/terrain.js"), "utf8");
const MICRO_SRC = readFileSync(resolvePath(__dirname, "scene3d/terrain_micro.js"), "utf8");
const stripComments = (g) => g.replace(/\/\/[^\n]*/g, "");
const CODE = stripComments(FRAG);
const STEP4 = [
  M.terrainSamplingGlsl(true), M.terrainSamplingGlsl(false), M.TERRAIN_GRADUV_MAIN_GLSL,
  M.TERRAIN_DETAIL_GAMMA_GLSL, M.TERRAIN_DETAIL_GAMMA_MIX_GLSL, M.TERRAIN_MICRO_FRAG_GLSL,
  M.TERRAIN_MICRO_DECL_GLSL, M.TERRAIN_MICRO_MERGE_BASE_GLSL, M.TERRAIN_MICRO_MERGE_SLOT_GLSL,
  M.TERRAIN_MICRO_APPLY_GLSL, M.TERRAIN_HEIGHT_BLEND_FRAG_GLSL, M.TERRAIN_HEIGHT_BLEND_DECL_GLSL,
  M.TERRAIN_HEIGHT_BLEND_MERGE_SLOT_GLSL,
];
{
  check("no backticks in any step-4 GLSL", !STEP4.some((g) => g.includes("`")));
  check("no step-4 GLSL declares a sampler", !STEP4.some((g) => /\bsampler\w*\s+\w+\s*;/.test(stripComments(g))));

  // Sampler budget: the fragment program's sampler set is unchanged.
  const decl = [...CODE.matchAll(/uniform\s+(?:highp\s+|mediump\s+|lowp\s+)?(sampler\w+)\s+(\w+)\s*;/g)].map((m) => m[2]);
  const KNOWN = ["uAtlas", "uAtlasNormalAo", "uEnvCube", "uVertexTypes", "uRoadTexture", "uTerrainPalette",
    "uTerrainDetailNormalArray", "uTerrainDetailTex", "uMacroTex", "uMergeData", "uAlphaMasks",
    "uSnowTrailMap", "uCloudShadowMap", "uCsmShadowMap0", "uCsmShadowMap1", "uCsmShadowMap2"];
  check(`fragment samplers == the known 16 declarations (${decl.length})`,
    decl.length === KNOWN.length && KNOWN.every((n) => decl.includes(n)), decl.join(","));
  // Default session (trail off, CSM on): 15 active, as cells.js documents.
  const trailIfdef = /#ifdef HB_TERRAIN_TRAIL_MAP\s*\nuniform sampler2D uSnowTrailMap;/.test(FRAG);
  check("trail sampler still #ifdef-gated (default session = 15 fragment units)", trailIfdef && decl.length - 1 === 15);

  // Mip-seam fix covers every atlas / nra / mask tap.
  const helperStart = CODE.indexOf("vec4 terrainAtlasTex(");
  const helperEnd = CODE.indexOf("vec4 terrainMaskTex(");
  const helperBlockEnd = CODE.indexOf("}", CODE.indexOf("}", helperEnd) + 1);
  const outside = CODE.slice(0, helperStart) + CODE.slice(helperBlockEnd);
  const raw = (outside.match(/texture(?:Grad)?\(\s*(?:uAtlas|uAtlasNormalAo|uAlphaMasks)\s*,/g) || []);
  check(`no raw atlas / nra / mask tap outside the helpers (${raw.length})`, raw.length === 0, raw.join(" | "));
  const lodTaps = (CODE.match(/textureLod\(uAtlas,/g) || []).length;
  // 2026-10-08 — the layer mean is now one shared helper (terrain.js
  // terrainTypeMeanTex): the height blend's .a and the far harmonize's .rgb.
  check("the only other uAtlas read is the shared layer-mean helper (1x1 mip)", lodTaps === 1
    && /float terrainHbHeight[\s\S]{0,200}terrainTypeMeanTex\(c\)\.a/.test(CODE));
  check("helpers use textureGrad with the continuous grid gradient",
    /textureGrad\(uAtlas, atlasUvFor\(code, cellUv\),\s*\n\s*gTerrainGridDx \* tiling, gTerrainGridDy \* tiling\)/.test(FRAG)
    && /textureGrad\(uAlphaMasks, vec3\(m, float\(maskIdx\)\),\s*\n\s*maskUvFor\(cellUv \+ gTerrainGridDx, rot\) - m,/.test(FRAG));
  // Gradients in uniform control flow: dFdx/dFdy before the first branch of main.
  const iMain = CODE.indexOf("void main()");
  const mainBody = CODE.slice(iMain);
  const iFirstIf = mainBody.search(/\bif\s*\(/);
  const iDx = mainBody.indexOf("gTerrainGridDx = dFdx(vGridUv);");
  const iDy = mainBody.indexOf("gTerrainGridDy = dFdy(vGridUv);");
  check("dFdx/dFdy of vGridUv taken at the top of main (uniform control flow)", iDx > 0 && iDy > iDx && iDy < iFirstIf);
  check("no other derivative call in the program", (CODE.match(/\bdFd[xy]\(/g) || []).length === 2 && !/\bfwidth\(/.test(CODE));

  // Definition before use (the class of compile error that turns terrain black).
  const defIdx = (name) => CODE.search(new RegExp(`\\b(?:vec[234]|float|int|bool|void)\\s+${name}\\s*\\(`));
  const firstUse = (name) => {
    const re = new RegExp(`\\b${name}\\s*\\(`, "g");
    const d = defIdx(name);
    let m;
    while ((m = re.exec(CODE))) if (m.index !== d + CODE.slice(d).indexOf(name)) return m.index;
    return -1;
  };
  for (const fn of ["terrainAtlasTex", "terrainNraTex", "terrainMaskTex", "terrainLinToSrgb", "terrainSrgbToLin",
    "terrainDetailGammaMix", "terrainMicroNra", "terrainMicroSlice", "terrainMicroPerturb", "terrainHbHeight",
    "terrainHeightBlendW", "atlasUvFor", "maskUvFor", "isWaterCode", "terrainRoundBevel", "terrainAcGouraud"]) {
    const d = defIdx(fn), u = firstUse(fn);
    check(`${fn}() defined before first use`, d >= 0 && u > d, `def ${d} use ${u}`);
  }
  for (const u of ["uMicroFade", "uMicroAmt", "uMicroTiles", "uHeightBlend", "uHeightBlendFade"]) {
    const n = (CODE.match(new RegExp(`uniform\\s+vec[24]\\s+${u}\\s*;`, "g")) || []).length;
    check(`uniform ${u} declared exactly once, before use`, n === 1
      && CODE.search(new RegExp(`uniform\\s+vec[24]\\s+${u}\\s*;`)) < CODE.indexOf(`${u}.`));
  }
  const declBeforeUse = (declRe, use) => {
    const d = mainBody.search(declRe);
    const u = mainBody.indexOf(use, d + 1);
    return d > 0 && u > d && mainBody.indexOf(use) >= d;
  };
  check("main locals declared before use (micro / height blend / shade normal)",
    declBeforeUse(/bool microNear =/, "microNear") && declBeforeUse(/vec2 microMerged =/, "microMerged")
    && declBeforeUse(/float microRoad =/, "microRoad") && declBeforeUse(/float hbAmt =/, "hbAmt")
    && declBeforeUse(/float hbH =/, "hbH") && declBeforeUse(/bool hbHSet =/, "hbHSet")
    && declBeforeUse(/vec3 acShadeN =/, "acShadeN")
    && mainBody.indexOf("vec3 geomN =") < mainBody.indexOf("geomN.z)")
    && mainBody.indexOf("float waterW =") < mainBody.indexOf("(1.0 - waterW)))")
    && mainBody.indexOf("vec2 uv11 =") < mainBody.indexOf("terrainMicroNra(t11, uv11)")
    && !M.TERRAIN_MICRO_APPLY_GLSL.includes("nearCode"));
  // Balanced delimiters across the whole program.
  const bal = (o, c) => { let d = 0; for (const ch of CODE) { if (ch === o) d += 1; else if (ch === c) { d -= 1; if (d < 0) return false; } } return d === 0; };
  check("braces / parens / brackets balanced", bal("{", "}") && bal("(", ")") && bal("[", "]"));
  // GLSL ES 3.00 has no implicit int -> float: no integer literal in arithmetic
  // in the step-4 strings (comparisons / int args / array indices are fine).
  const intArith = [];
  for (const g of STEP4) {
    const c = stripComments(g);
    const re = /(?<![\w.])(\d+)(?![\w.])\s*[*/]|[*/]\s*(\d+)(?![\w.])|(?<![\w.e])(\d+)(?![\w.])\s*[+-](?!\s*\d+\s*[;)])|(?<![e(,])[+-]\s*(\d+)(?![\w.])/g;
    let m;
    while ((m = re.exec(c))) {
      const ctx = c.slice(Math.max(0, m.index - 30), m.index + 20).replace(/\n/g, " ");
      if (/(?:clamp\(code, 0, 32|clamp\(t\d\d, 0, 31|int\(|ms\d+ < 5|s [<>]=? 4)/.test(ctx)) continue;
      intArith.push(ctx);
    }
  }
  check("no integer literal in float arithmetic (step-4 GLSL)", intArith.length === 0, intArith.join(" || "));

  // terrain_batch anchors: still exactly once in the ASSEMBLED program.
  for (const a of [
    "uniform sampler2D uVertexTypes;",
    "  return int(texelFetch(uVertexTypes, ivec2(iu, iv), 0).r * 255.0 + 0.5);",
    "  return texelFetch(uVertexTypes, ivec2(iu, iv), 0).g > 0.125 ? 1.0 : 0.0;",
    "uniform highp sampler2D uMergeData;",
    "vec4 baseTexel = texelFetch(uMergeData, ivec2(colBase, iv), 0);",
    "vec4 t = texelFetch(uMergeData, ivec2(colBase + s, iv), 0);",
    "  if (uTexMergeEnabled > 0.5) {\n    int colBase = iu * 6;",
    "  if (uRoadEnabled > 0.5 && !(uTexMergeEnabled > 0.5 && uRoadSlotsEnabled > 0.5)) {",
    "  bool acGouraud = uAcGouraudEnabled > 0.5;",
  ]) check(`batch anchor intact: ${JSON.stringify(a.trim().slice(0, 48))}`, FRAG.split(a).length === 2);
  check("no step-4 string reads uVertexTypes (its A channel is the batch's Gouraud bit)",
    !STEP4.some((g) => g.includes("uVertexTypes")));

  // The micro-relief perturbs the bevel OUTPUT, inside the Gouraud branch only.
  const gBlock = mainBody.slice(mainBody.indexOf("  if (acGouraud) {\n    vec3 acShadeN"), mainBody.indexOf("modulated = terrainAcGouraud(modulated, acShadeN,"));
  check("micro-relief sits inside the Gouraud branch, between the bevel and the Gouraud call",
    gBlock.includes("terrainRoundBevel(vAcLightNormal)") && gBlock.includes("acShadeN = terrainMicroPerturb(acShadeN,"));
  check("the shared Gouraud tail is unchanged (far ring runs the same characters)",
    /terrainAcGouraud\(vec3 albedo, vec3 acLightNormal, vec3 acSunVec,/.test(CODE));
  check("micro weights fade with distance AND water (shoreline is the water agent's)",
    M.TERRAIN_MICRO_APPLY_GLSL.includes("uMicroAmt.x * microFade * (1.0 - waterW)"));
  check("height blend skips water + road slots and needs the height bake",
    M.TERRAIN_HEIGHT_BLEND_MERGE_SLOT_GLSL.includes("s < 4 && !isWaterCode(layer) && !isWaterCode(baseLayer)")
    && M.TERRAIN_HEIGHT_BLEND_DECL_GLSL.includes("uPbrEnabled > 0.5"));
  check("height blend fetches the base height lazily (only cells with a terrain overlay pay for it)",
    M.TERRAIN_HEIGHT_BLEND_MERGE_SLOT_GLSL.includes("if (!hbHSet) { hbH = terrainHbHeight(baseLayer, cellUv); hbHSet = true; }")
    && (CODE.match(/terrainHbHeight\(/g) || []).length === 3);
  check("height blend runs BEFORE the albedo mix (the albedo uses the reshaped weight)",
    CODE.indexOf("baseW = terrainHeightBlendW(") < CODE.indexOf("merged = mix(overlayCol, merged, baseW);"));
  check("material relief is composited with the SAME baseW as the albedo",
    CODE.indexOf("microMerged, baseW);") < CODE.indexOf("merged = mix(overlayCol, merged, baseW);")
    && CODE.indexOf("microMerged, baseW);") > CODE.indexOf("baseW = terrainHeightBlendW("));
  check("gamma crossfade replaced the linear mix in the retail branch (skips amtA == 0 => far bake exact)",
    CODE.includes("if (amtA > 0.0) result = terrainDetailGammaMix(result, detail.rgb, amtA);")
    && !CODE.includes("result = mix(result, detail.rgb, amtA);"));
  check("rock slice constant matches terrain.js DETAIL_SLICE_STONE",
    /const DETAIL_SLICE_STONE = 3;/.test(SRC) && M.MICRO_ROCK_SLICE === 3);
}

// ---------------------------------------------------------------------------
console.log("\n-- 4. wiring --");
{
  check("material spreads terrainMicroUniforms with the quality preset",
    SRC.includes("...terrainMicroUniforms(THREE, scene3d?.quality?.preset),"));
  check("diag installed from the ring resolve", SRC.includes("installTerrainMicroDiag(scene3d);"));
  check("helpers injected right after distToSegment (after maskUvFor / atlasUvFor)",
    SRC.includes('  return length(p - (a + ab * t));\n}\n${terrainDetailFragGlsl().replace(/\\n$/, "")}'));
  check("each main() injection is compile-time gated on its own flag",
    SRC.includes("${TERRAIN_MICRO.gradUv ? TERRAIN_GRADUV_MAIN_GLSL")
    && SRC.includes("${TERRAIN_MICRO.micro ? TERRAIN_MICRO_DECL_GLSL")
    && SRC.includes("${TERRAIN_MICRO.heightBlend ? TERRAIN_HEIGHT_BLEND_DECL_GLSL")
    && SRC.includes("${TERRAIN_MICRO.detailGamma ? TERRAIN_DETAIL_GAMMA_MIX_GLSL : TERRAIN_DETAIL_LINEAR_MIX_GLSL}")
    && SRC.includes("${TERRAIN_MICRO.micro ? TERRAIN_MICRO_APPLY_GLSL"));
  const d = M.TERRAIN_MICRO_DEFAULTS;
  check("far-ring safety: every step-4 fade ends inside one landblock (192 m)", d.fadeEndM < 192 && d.hbFadeEndM < 192);
  check("module header records the audit (dead detail normals under Gouraud)",
    /shades NOTHING/.test(MICRO_SRC) && /wraps with fract\(\)/.test(MICRO_SRC));
  const flags = readFileSync(resolvePath(__dirname, "docs/url-flags.md"), "utf8");
  for (const f of ["terrainMicro", "terrainMicroFade", "terrainMicroMaterial", "terrainMicroDetail", "terrainMicroRock",
    "terrainMicroTile", "terrainHeightBlend", "terrainHeightBlendGain", "terrainHeightBlendSharp",
    "terrainHeightBlendFade", "terrainDetailGamma", "terrainGradUv"]) {
    check(`url-flags.md row: ${f}`, flags.includes(`| \`${f}\` |`));
  }
}

// ---------------------------------------------------------------------------
console.log("\n-- 5. flag variants (each escape compiles its own program) --");
for (const v of [
  "",
  "?terrainMicro=off&terrainHeightBlend=off&terrainDetailGamma=off&terrainGradUv=off",
  "?terrainGradUv=off",
  "?terrainMicro=off",
  "?terrainHeightBlend=off",
  "?terrainDetailGamma=off",
  "?terrainRound=off",
  "?terrainBevel=off&terrainMicro=0.5",
]) {
  const r = spawnSync(process.execPath, [__filename, "--variant", v], { cwd: __dirname, encoding: "utf8", timeout: 120000 });
  const tail = (r.stdout || "").trim().split("\n").pop();
  check(`variant ${JSON.stringify(v || "default")}: ${tail}`, r.status === 0,
    (r.stdout || "").split("\n").filter((l) => l.includes("[FAIL]")).join(" | ") + (r.status !== 0 ? (r.stderr || "").slice(-400) : ""));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
