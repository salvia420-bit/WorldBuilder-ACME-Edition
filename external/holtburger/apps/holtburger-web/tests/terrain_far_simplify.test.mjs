// tests/terrain_far_simplify.test.mjs
//
// `?terrainFarSimplify` (2026-10-17, DEFAULT ON, `=off` escape) — the terrain
// shader's distance fade (scene3d/terrain_far_simplify.js): past ~300 m of
// view depth the TexMerge composite gives way to its bilinear fallback (plus
// the road lane its road slots would have painted), with a smoothstep band in
// front; where the composite runs, its dead bilinear twin is no longer
// computed; the detail-texture fetch stops where its weight is 0; the
// Gouraud-off detail-normal path fades to the flat normal. 1070 basis: terrain
// is one draw at 6.1 ms GPU, texture merge -1.5 ms, detail texture -0.4 ms.
//
//   F1  flag parsing + band clamps; the JS mirror of the shader's fade.
//   F2  ASSEMBLED default program (terrain.js resolved for the session):
//       one new uniform, NO new sampler; the bilinear taps run once, AFTER the
//       composite, only where it does not own the pixel; the composite sits
//       inside the anchored per-LB merge gate, behind fsKeep; the far road and
//       the harmonize twin; the detail-texture skip is exactly its fade end;
//       the detail-normal far path is the flat normal; every terrain_batch
//       anchor still occurs exactly once; balanced delimiters; every helper
//       defined before use; no integer literal in float arithmetic.
//   F3  uniforms + live tuning + diag; wiring (url-flags.md row, harness
//       registration, terrain.js spreads the uniform and installs the diag).
//   F4  `=off` (child process, the flag is compile-time): no trace of the
//       feature, the legacy order (taps before the weights, the blend before
//       the composite), the same sampler set.
//
// Run: node tests/terrain_far_simplify.test.mjs

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";
import { register } from "node:module";
import { spawnSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolvePath(HERE, "..");
const __filename = fileURLToPath(import.meta.url);
const VI = process.argv.indexOf("--variant");
const VARIANT = VI >= 0 ? (process.argv[VI + 1] ?? "") : null;
if (VARIANT !== null) {
  globalThis.window = { location: { search: VARIANT }, addEventListener() {}, removeEventListener() {} };
}

let passed = 0, failed = 0;
function check(label, cond, extra = "") {
  if (cond) { passed++; console.log(`  [OK] ${label}`); }
  else { failed++; console.log(`  [FAIL] ${label} ${extra}`); }
}
const stripC = (g) => g.replace(/\/\/[^\n]*/g, "");
const balanced = (code) => [["{", "}"], ["(", ")"], ["[", "]"]].every(([o, c]) => {
  let d = 0;
  for (const ch of code) { if (ch === o) d += 1; else if (ch === c) { d -= 1; if (d < 0) return false; } }
  return d === 0;
});
const samplerNames = (code) => [...code.matchAll(/uniform\s+(?:highp\s+|mediump\s+|lowp\s+)?sampler\w+\s+(\w+)\s*;/g)].map((m) => m[1]).sort();
const count = (hay, needle) => hay.split(needle).length - 1;

const STUB_LOADER = resolvePath(APP, "_three_stub_palette_loader.mjs");
if (!existsSync(STUB_LOADER)) {
  console.error(`[setup] missing ${STUB_LOADER}; run test_terrain_palette.mjs once first.`);
  process.exit(2);
}
register(pathToFileURL(STUB_LOADER).href, import.meta.url);
const FS = await import(pathToFileURL(resolvePath(APP, "scene3d/terrain_far_simplify.js")).href);
const T = await import(pathToFileURL(resolvePath(APP, "scene3d/terrain.js")).href);
const FRAG = T._terrainGlslForTest().fragment;
const CODE = stripC(FRAG);
const main = CODE.slice(CODE.indexOf("void main() {"));

const BATCH_ANCHORS = [
  "uniform sampler2D uVertexTypes;",
  "  return int(texelFetch(uVertexTypes, ivec2(iu, iv), 0).r * 255.0 + 0.5);",
  "  return texelFetch(uVertexTypes, ivec2(iu, iv), 0).g > 0.125 ? 1.0 : 0.0;",
  "uniform highp sampler2D uMergeData;",
  "vec4 baseTexel = texelFetch(uMergeData, ivec2(colBase, iv), 0);",
  "vec4 t = texelFetch(uMergeData, ivec2(colBase + s, iv), 0);",
  "  if (uTexMergeEnabled > 0.5) {\n    int colBase = iu * 6;",
  "  if (uRoadEnabled > 0.5 && !(uTexMergeEnabled > 0.5 && uRoadSlotsEnabled > 0.5)) {",
  "  bool acGouraud = uAcGouraudEnabled > 0.5;",
];
const TAP = "vec3 c00 = terrainAtlasTex(clamp(t00, 0, 32), uv00).rgb;";

// ---------------------------------------------------------------------------
if (VARIANT !== null) {
  // ---- child: `=off` must assemble the legacy program ----
  const C = FS.TERRAIN_FAR_SIMPLIFY;
  check(`[${VARIANT}] config off`, C.on === false);
  check(`[${VARIANT}] no trace of the feature in the program`,
    !/fsKeep|fsMergeGate|fsMergeMix|fsBilin|fsRoadW|uFarSimplify|terrainFarRoadLane|terrainFarBilinTwin/.test(FRAG));
  check(`[${VARIANT}] legacy order: the 4 taps BEFORE the corner weights, the blend BEFORE the composite`,
    count(FRAG, TAP) === 1 && main.indexOf(TAP) < main.indexOf("float w00 = (1.0 - fu) * (1.0 - fv);")
    && main.indexOf("  vec3 result;\n  if (uPaintMode > 0.5 && !allSameType) {") < main.indexOf("  if (uTexMergeEnabled > 0.5) {"));
  check(`[${VARIANT}] the composite closes exactly as before`,
    FRAG.includes("    result = merged;\n    harmSharpMean = mergedMean;\n  }\n"));
  check(`[${VARIANT}] the legacy harmonize twin and detail-texture gate`,
    FRAG.includes("          ? harmSharpMean\n          : hm00 * w00 + hm10 * w10 + hm01 * w01 + hm11 * w11;\n")
    && FRAG.includes("    if (dslice >= 0 && dslice < uDetailTexSliceCount) {\n")
    && FRAG.includes("    if (slice < 5) {\n"));
  check(`[${VARIANT}] same 16 sampler declarations, balanced`, samplerNames(CODE).length === 16 && balanced(CODE));
  check(`[${VARIANT}] batch anchors exactly once`, BATCH_ANCHORS.every((a) => count(FRAG, a) === 1));
  check(`[${VARIANT}] no uniform entry`, Object.keys(FS.terrainFarSimplifyUniforms({ Vector2: class {} })).length === 0);
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

// ---------------------------------------------------------------------------
console.log("-- F1 flag + fade -----------------------------------------------------");
{
  const d = FS.readTerrainFarSimplifyConfig("");
  check("default: on, band 240..300 m", d.on && d.startM === 240 && d.endM === 300 && d.source === null);
  check("defaults frozen + documented", Object.isFrozen(FS.TERRAIN_FAR_SIMPLIFY_DEFAULTS)
    && FS.TERRAIN_FAR_SIMPLIFY_DEFAULTS.startM === 240 && FS.TERRAIN_FAR_SIMPLIFY_DEFAULTS.endM === 300);
  for (const v of ["off", "0", "false", "no", "OFF", " No "]) {
    check(`'${v}' -> off`, FS.readTerrainFarSimplifyConfig(`?terrainFarSimplify=${encodeURIComponent(v)}`).on === false);
  }
  check("'on' and garbage -> on with the default band",
    ["on", "banana", ""].every((v) => {
      const c = FS.readTerrainFarSimplifyConfig(`?terrainFarSimplify=${v}`);
      return c.on && c.startM === 240 && c.endM === 300;
    }));
  const ab = FS.readTerrainFarSimplifyConfig("?terrainFarSimplify=150,220");
  check("A,B -> band A..B", ab.on && ab.startM === 150 && ab.endM === 220);
  const b = FS.readTerrainFarSimplifyConfig("?terrainFarSimplify=400");
  check("B -> band 0.8 B .. B", b.on && b.startM === 320 && b.endM === 400);
  const inv = FS.readTerrainFarSimplifyConfig("?terrainFarSimplify=300,100");
  check("inverted band repaired (smoothstep needs e0 < e1)", inv.endM >= inv.startM + 1);
  const neg = FS.readTerrainFarSimplifyConfig("?terrainFarSimplify=-50,20");
  check("negative start clamps to 0", neg.startM === 0 && neg.endM === 20);
  check("module session config = the default (no URL in node)", FS.TERRAIN_FAR_SIMPLIFY.on === true);
  const k = (m) => FS.farKeepAt(m, 240, 300);
  check("fade: exactly 1 nearer than start (the near field keeps every feature)", k(0) === 1 && k(239.99) === 1 && k(240) === 1);
  check("fade: exactly 0 past end (the far path alone)", k(300) === 0 && k(1000) === 0);
  check("fade: 0.5 mid-band, monotone, C1 at the ends",
    Math.abs(k(270) - 0.5) < 1e-12 && [250, 260, 270, 280, 290].every((m, i, a) => i === 0 || k(m) < k(a[i - 1]))
    && Math.abs(k(240.001) - 1) < 1e-6 && Math.abs(k(299.999)) < 1e-6);
}

// ---------------------------------------------------------------------------
console.log("\n-- F2 the assembled default program -----------------------------------");
{
  check("one uniform vec2 uFarSimplify, declared once", count(CODE, "uniform vec2 uFarSimplify;") === 1);
  check("NO new sampler (16 declarations, as before)", samplerNames(CODE).length === 16, samplerNames(CODE).join(","));
  check("delimiters balanced", balanced(CODE));
  check("every terrain_batch anchor occurs exactly once (the batch rewrite still applies)",
    BATCH_ANCHORS.every((a) => count(FRAG, a) === 1),
    BATCH_ANCHORS.filter((a) => count(FRAG, a) !== 1).map((a) => a.trim().slice(0, 40)).join(" | "));
  check("no fs string reads uVertexTypes directly (the batch owns that sampler's addressing)",
    ![FS.TERRAIN_FAR_SIMPLIFY_FRAG_GLSL, FS.TERRAIN_FAR_SIMPLIFY_DECL_GLSL, FS.terrainFarSimplifyBilinearGlsl("", "")].some((g) => g.includes("uVertexTypes")));

  const iDecl = main.indexOf("float fsKeep = 1.0 - smoothstep(uFarSimplify.x, uFarSimplify.y, length(vWorldPos - cameraPosition));");
  const iGate = main.indexOf("  if (uTexMergeEnabled > 0.5) {\n    int colBase = iu * 6;\n    fsMergeGate = true;\n    if (fsKeep > 0.0) {\n    vec4 baseTexel");
  const iClose = main.indexOf("    result = merged;\n    harmSharpMean = mergedMean;\n    fsMergeMix = fsKeep;\n    }\n  }");
  const iBil = main.indexOf("  if (!fsMergeGate || fsMergeMix < 1.0) {");
  const iTap = main.indexOf(TAP);
  const iHarm = main.indexOf("if (uFarHarmonize > 0.0) {");
  check("fsKeep is the smoothstep fade on CAMERA DISTANCE (rotation-invariant), declared before the composite", iDecl > 0 && iDecl < iGate);
  check("the composite: fsMergeGate set INSIDE the anchored (per-LB) merge gate, body behind fsKeep > 0",
    iGate > 0 && iClose > iGate);
  check("fsMergeMix = fsKeep only where the composite ran", iClose > 0);
  check("the bilinear taps occur ONCE, after the composite, inside the not-fully-merged guard",
    count(FRAG, TAP) === 1 && iBil > iClose && iTap > iBil && iTap < iHarm);
  check("the corner weights the guard reads are declared before the composite",
    main.indexOf("float w00 = (1.0 - fu) * (1.0 - fv);") < iGate && main.indexOf("bool allSameType") < iGate);
  const bil = main.slice(iBil, iHarm);
  check("near field (fsMergeMix == 1): the guard is false, result = merged untouched (byte-identical)",
    bil.includes("result = fsMergeMix > 0.0 ? mix(fsBilin, result, fsMergeMix) : fsBilin;")
    && /if \(!fsMergeGate \|\| fsMergeMix < 1\.0\) \{/.test(bil));
  check("the blend writes fsBilin with the legacy paint-mode / bilinear logic",
    bil.includes("vec3 fsBilin;") && bil.includes("fsBilin = c00 * w00 + c10 * w10 + c01 * w01 + c11 * w11;")
    && bil.includes("float maxW = pw00; fsBilin = c00;") && !/\bresult = c00\b/.test(bil));
  check("far road: only for a merge LB with road slots on, the composite's own road layer (atlas 32)",
    bil.includes("if (fsMergeGate && uRoadSlotsEnabled > 0.5) {")
    && bil.includes("fsRoadW = terrainFarRoadLane(iu, iv, cellUv, w00, w10, w01, w11);")
    && bil.includes("fsBilin = mix(fsBilin, terrainAtlasTex(32, cellUv).rgb, fsRoadW);"));
  check("far road lane = the analytic painter's weight, both modes (legacy smoothstep + 5 m lane)",
    CODE.includes("return smoothstep(0.85, 0.95, r00 * w00 + r10 * w10 + r01 * w01 + r11 * w11);")
    && CODE.includes("return 1.0 - smoothstep(2.0, 3.0, d);")
    && (CODE.match(/distToSegment\(p, k\d\d, k\d\d\)/g) || []).length === 12);
  check("the legacy analytic painter is still suppressed for merge LBs (no double road)",
    FRAG.includes("  if (uRoadEnabled > 0.5 && !(uTexMergeEnabled > 0.5 && uRoadSlotsEnabled > 0.5)) {"));
  check("harmonize twin: the composite's mean where it owns the pixel, crossfaded in the band, the far twin beyond",
    CODE.includes("? (fsMergeMix < 1.0 ? mix(terrainFarBilinTwin(hm00, hm10, hm01, hm11, w00, w10, w01, w11, fsRoadW), harmSharpMean, fsMergeMix) : harmSharpMean)")
    && CODE.includes(": terrainFarBilinTwin(hm00, hm10, hm01, hm11, w00, w10, w01, w11, fsRoadW);")
    && CODE.includes("return roadW > 0.0 ? mix(tw, terrainTypeMean(32), roadW) : tw;"));
  check("detail texture: fetched only nearer than its own fade end (its weight is exactly 0 beyond)",
    CODE.includes("if (dslice >= 0 && dslice < uDetailTexSliceCount && vViewDepth < max(uDetailTexFadeEnd, uDetailTexFadeStart + 1.0e-3)) {"));
  check("detail normal (Gouraud-off): sampled while fsKeep > 0, faded to flat, the flat normal beyond",
    CODE.includes("if (slice < 5 && fsKeep > 0.0) {")
    && CODE.includes("if (fsKeep < 1.0) detailEncoded = mix(vec3(0.5, 0.5, 1.0), detailEncoded, fsKeep);")
    && CODE.includes("} else if (slice < 5) {\n      ndotl = terrainSunNdotl(vec3(0.0, 0.0, 1.0), sunDir);"));
  check("CSM untouched: it already stops at uCsmFar (the last split, 300 m)",
    CODE.includes("if (viewDepth > uCsmFar) return 1.0;") && !/csmShadowFactor[^\n]*fsKeep/.test(CODE));
  // Defined before use (helpers + locals).
  const iHelpers = CODE.indexOf("float terrainFarRoadLane(");
  check("helpers come after everything they call",
    ["float vertexRoadAt(", "float distToSegment(", "vec4 terrainAtlasTex(", "vec3 terrainTypeMean(", "uniform float uRoadPaintLegacy;"]
      .every((d) => CODE.indexOf(d) >= 0 && CODE.indexOf(d) < iHelpers));
  check("fs locals declared before first use", ["fsKeep", "fsMergeGate", "fsMergeMix", "fsRoadW"].every((v) => {
    const decl = new RegExp(`\\b(?:float|bool) ${v} = `).exec(main);
    const first = new RegExp(`\\b${v}\\b`).exec(main);
    return !!decl && !!first && first.index === decl.index + decl[0].indexOf(v);
  }));
  // GLSL ES 3.00 has no implicit int -> float conversion: no bare integer
  // literal may meet a float operand in the fs strings.
  const fsGlsl = stripC([FS.TERRAIN_FAR_SIMPLIFY_FRAG_GLSL, FS.TERRAIN_FAR_SIMPLIFY_DECL_GLSL,
    FS.TERRAIN_FAR_SIMPLIFY_MERGE_OPEN_GLSL, FS.TERRAIN_FAR_SIMPLIFY_MERGE_CLOSE_GLSL,
    FS.terrainFarSimplifyBilinearGlsl("", ""), FS.TERRAIN_FAR_SIMPLIFY_HARM_MERGED_GLSL,
    FS.TERRAIN_FAR_SIMPLIFY_HARM_BILIN_GLSL, FS.TERRAIN_FAR_SIMPLIFY_DETAIL_TEX_COND_GLSL,
    FS.TERRAIN_FAR_SIMPLIFY_DETAIL_NORMAL_COND_GLSL, FS.TERRAIN_FAR_SIMPLIFY_DETAIL_NORMAL_FADE_GLSL,
    FS.TERRAIN_FAR_SIMPLIFY_DETAIL_NORMAL_FAR_GLSL].join("\n"));
  const bareInts = [...fsGlsl.matchAll(/(?<![\w.]|e-)\d+(?![\w.])/g)].map((m) => fsGlsl.slice(Math.max(0, m.index - 24), m.index + 6).replace(/\n/g, " "))
    .filter((ctx) => !/(iu \+ 1|iv \+ 1|terrainTypeMean\(32|terrainAtlasTex\(32|slice < 5|1e9)/.test(ctx)); // int contexts
  check("no bare integer literal in float context in the fs GLSL", bareInts.length === 0, bareInts.join(" || "));
  check("no backtick inside the GLSL strings", !/`/.test(fsGlsl));
}

// ---------------------------------------------------------------------------
console.log("\n-- F3 uniforms, live tuning, wiring -----------------------------------");
{
  class V2 { constructor(x, y) { this.x = x; this.y = y; } set(x, y) { this.x = x; this.y = y; } }
  const THREE = { Vector2: V2 };
  const u = FS.terrainFarSimplifyUniforms(THREE);
  check("uniform: uFarSimplify = (start, end)", u.uFarSimplify && u.uFarSimplify.value.x === 240 && u.uFarSimplify.value.y === 300);
  check("no uniform when the flag is off", Object.keys(FS.terrainFarSimplifyUniforms(THREE, { on: false })).length === 0);
  const mat = { uniforms: FS.terrainFarSimplifyUniforms(THREE) };
  const other = { uniforms: {} };
  const r = FS.setTerrainFarSimplifyLive({ terrainMaterials: [mat, mat, other, null] }, { startM: 180, endM: 230 });
  check("live set reaches each terrain material once, skips materials without the uniform",
    r.materials === 1 && mat.uniforms.uFarSimplify.value.x === 180 && mat.uniforms.uFarSimplify.value.y === 230);
  const later = FS.terrainFarSimplifyUniforms(THREE);
  check("materials baked after a live set start from the live band", later.uFarSimplify.value.x === 180);
  FS.setTerrainFarSimplifyLive({ terrainMaterials: [mat] }, { startM: 500, endM: 100 });
  check("live set repairs an inverted band", mat.uniforms.uFarSimplify.value.y >= mat.uniforms.uFarSimplify.value.x + 1);
  FS.setTerrainFarSimplifyLive({ terrainMaterials: [] }, { ...FS.TERRAIN_FAR_SIMPLIFY_DEFAULTS });
  globalThis.window = globalThis.window || {};
  const api = FS.installTerrainFarSimplifyDiag({ terrainMaterials: [mat] });
  check("window.__terrainFarSimplify installed with config/live/set/state",
    globalThis.window.__terrainFarSimplify === api && api.config === FS.TERRAIN_FAR_SIMPLIFY
    && typeof api.set === "function" && api.state().startM === mat.uniforms.uFarSimplify.value.x);
  const SRC = readFileSync(resolvePath(APP, "scene3d/terrain.js"), "utf8");
  check("terrain.js spreads the uniform into the material and installs the diag",
    SRC.includes("...terrainFarSimplifyUniforms(THREE),") && SRC.includes("installTerrainFarSimplifyDiag(scene3d);"));
  const DOC = readFileSync(resolvePath(APP, "docs/url-flags.md"), "utf8");
  check("url-flags.md row", /^\| `terrainFarSimplify` \|/m.test(DOC));
  const HARNESS = readFileSync(resolvePath(APP, "harness/run-js-headless.mjs"), "utf8");
  check("registered in the JS gate", HARNESS.includes("tests/terrain_far_simplify.test.mjs"));
}

// ---------------------------------------------------------------------------
console.log("\n-- F4 =off assembles the legacy program (child process) ---------------");
for (const v of ["?terrainFarSimplify=off", "?terrainFarSimplify=no&terrainGradUv=off&terrainMicro=off"]) {
  const r = spawnSync(process.execPath, [__filename, "--variant", v], { cwd: APP, encoding: "utf8", timeout: 120000 });
  const tail = (r.stdout || "").trim().split("\n").pop();
  check(`variant ${JSON.stringify(v)}: ${tail}`, r.status === 0,
    (r.stdout || "").split("\n").filter((l) => l.includes("[FAIL]")).join(" | ") + (r.status !== 0 ? (r.stderr || "").slice(-400) : ""));
}

console.log(`\nterrain far simplify: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
