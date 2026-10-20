// 2026-10-20 (improvement hunt shadows-restore-3) — ?csmDeadLights (scene3d/light_loops.js
// installCsmDeadLights, called by scene3d/csm.js setupCsm): under ?csm the three intensity-0
// cascade lights get no copy of three's unrolled directional loop. The loop body is wrapped in
//   #if !( NUM_DIR_LIGHT_SHADOWS == 3 && UNROLLED_LOOP_INDEX < NUM_DIR_LIGHT_SHADOWS )
// so the gate is keyed in the GLSL on the cascade count.
//
// What is pinned here (no browser, no GPU):
//   1. PREMISE — three r184's own WebGLLights, fed the real setupCsm cascades plus two lit
//      directional lights in any order: directional uniforms 0..2 are the cascades, colour
//      exactly 0, NUM_DIR_LIGHT_SHADOWS = 3 (casters sort first). lighting.js sets the sun's
//      castShadow only without csm. getDirectionalLightInfo writes every field of its out param,
//      and nothing after the directional loop reads directLight / directionalLight.
//   2. SHAPE — on the stock chunk and on both installLightLoops outputs (?lightRangeSkip on /
//      off): only the directional loop changes; removing the 3 inserted lines gives the input
//      back byte for byte (body untouched); it commutes with patchLightLoopsChunk; fails closed.
//   3. ACTIVE CODE — through three's replaceLightNums / unroll_loop and a small preprocessor:
//      with exactly 3 directional shadows (2..6 directional lights, USE_SHADOWMAP or not) the
//      program equals the finder's "loop starts at NUM_DIR_LIGHT_SHADOWS" program (copies 3.. only,
//      no getShadow); with 0 / 1 (?shadows=on sun) / 2 / 4 (CSM + a casting sun) it equals the
//      unpatched program. A full MeshStandardMaterial fragment shader keeps no static use of
//      directionalShadowMap / vDirectionalShadowCoord / directionalLightShadows (the 3 samplers go
//      inactive), and the retail light clamp (materials.js, real onBeforeCompile) still wraps
//      every emitted RE_Direct.
//   4. INSTALL / ESCAPE — installs once, ?csmDeadLights=off|0|false|no leaves the chunk alone,
//      importing light_loops.js changes no chunk, csm.js setupCsm installs it through the global
//      hook (keyed on its cascade count) and is a no-op without it, and csm.js still imports only
//      three (the legacy `new Function` loaders keep working).
//
// Run:
//   cd apps/holtburger-web/
//   node tests/csm_dead_lights.test.mjs

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as THREE from "three";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(HERE, "..");
const STOCK = THREE.ShaderChunk.lights_fragment_begin;
const L = await import("../scene3d/light_loops.js");
const AFTER_IMPORT = THREE.ShaderChunk.lights_fragment_begin;
const { setupCsm } = await import("../scene3d/csm.js");
const { WebGLLights } = await import("three/src/renderers/webgl/WebGLLights.js");
const { installLightClampShaderPatch } = await import("../scene3d/materials.js");

let passed = 0, failed = 0;
function check(label, cond, extra = "") {
  if (cond) { passed++; console.log(`  [OK] ${label}${extra ? " — " + extra : ""}`); }
  else { failed++; console.log(`  [FAIL] ${label} ${extra}`); }
}

const RE_DIRECT = "RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );";
const DIR_HEAD = "#pragma unroll_loop_start\n\tfor ( int i = 0; i < NUM_DIR_LIGHTS; i ++ ) {";
const LOOP_END = "#pragma unroll_loop_end";
const GATE3 = "#if !( NUM_DIR_LIGHT_SHADOWS == 3 && UNROLLED_LOOP_INDEX < NUM_DIR_LIGHT_SHADOWS )";
// tests/light_range_skip.test.mjs: sha256 of three r184's stock lights_fragment_begin
const STOCK_SHA = "88970fde062487e5485e279e5c4fa3cfe16e6486d3148edc68def33042d054c1";
const sha = (s) => createHash("sha256").update(s).digest("hex");
const count = (s, needle) => s.split(needle).length - 1;

// --- three r184 program assembly steps (same copies as tests/light_range_skip.test.mjs) -------
function resolveIncludes(s, chunks = {}) {
  return s.replace(/^[ \t]*#include +<([\w\d./]+)>/gm, (_m, name) => {
    const c = chunks[name] ?? THREE.ShaderChunk[name];
    if (c === undefined) throw new Error(`unknown chunk ${name}`);
    return resolveIncludes(c, chunks);
  });
}
function replaceLightNums(s, p) {
  const coords = p.spotShadows + p.spotMaps - p.spotShadowsWithMaps;
  return s.replace(/NUM_DIR_LIGHTS/g, p.dir).replace(/NUM_SPOT_LIGHTS/g, p.spot).replace(/NUM_SPOT_LIGHT_MAPS/g, p.spotMaps)
    .replace(/NUM_SPOT_LIGHT_COORDS/g, coords).replace(/NUM_RECT_AREA_LIGHTS/g, p.rect).replace(/NUM_POINT_LIGHTS/g, p.point)
    .replace(/NUM_HEMI_LIGHTS/g, p.hemi).replace(/NUM_DIR_LIGHT_SHADOWS/g, p.dirShadows)
    .replace(/NUM_SPOT_LIGHT_SHADOWS_WITH_MAPS/g, p.spotShadowsWithMaps).replace(/NUM_SPOT_LIGHT_SHADOWS/g, p.spotShadows)
    .replace(/NUM_POINT_LIGHT_SHADOWS/g, p.pointShadows);
}
const unrollLoopPattern = /#pragma unroll_loop_start\s+for\s*\(\s*int\s+i\s*=\s*(\d+)\s*;\s*i\s*<\s*(\d+)\s*;\s*i\s*\+\+\s*\)\s*{([\s\S]+?)}\s+#pragma unroll_loop_end/g;
function unrollLoops(s) {
  return s.replace(unrollLoopPattern, (_m, a, b, snippet) => {
    let out = "";
    for (let i = +a; i < +b; i++) out += snippet.replace(/\[\s*i\s*\]/g, "[ " + i + " ]").replace(/UNROLLED_LOOP_INDEX/g, i);
    return out;
  });
}
function preprocess(src, defines) {
  const macros = new Map(Object.entries(defines));
  const expand = (expr) => {
    let e = expr.replace(/defined\s*\(\s*(\w+)\s*\)|defined\s+(\w+)/g, (_, a, b) => (macros.has(a || b) ? " 1 " : " 0 "));
    for (let n = 0; n < 8; n++) {
      const next = e.replace(/\b[A-Za-z_]\w*\b/g, (id) => (macros.has(id) ? ` ( ${macros.get(id) === "" ? "1" : macros.get(id)} ) ` : " 0 "));
      if (next === e) break;
      e = next;
    }
    return e;
  };
  const evalIf = (expr) => !!Function(`"use strict"; return ( ${expand(expr)} );`)();
  const out = [], stack = [];
  const isActive = () => stack.every((f) => f.active);
  for (const raw of src.split("\n")) {
    const line = raw.trim();
    let m;
    if ((m = line.match(/^#\s*(ifdef|ifndef)\s+(\w+)/))) {
      const v = m[1] === "ifdef" ? macros.has(m[2]) : !macros.has(m[2]);
      stack.push({ active: isActive() && v, taken: v, parentActive: isActive() });
    } else if ((m = line.match(/^#\s*if\s+(.*)$/))) {
      const pa = isActive(); const v = pa && evalIf(m[1]);
      stack.push({ active: v, taken: v, parentActive: pa });
    } else if ((m = line.match(/^#\s*elif\s+(.*)$/))) {
      const f = stack[stack.length - 1];
      if (f.taken || !f.parentActive) f.active = false; else { f.active = evalIf(m[1]); f.taken = f.active; }
    } else if (/^#\s*else\b/.test(line)) {
      const f = stack[stack.length - 1]; f.active = f.parentActive && !f.taken; f.taken = true;
    } else if (/^#\s*endif\b/.test(line)) {
      stack.pop();
    } else if ((m = line.match(/^#\s*define\s+(\w+)\s*(.*)$/))) {
      if (isActive()) macros.set(m[1], m[2]);
    } else if ((m = line.match(/^#\s*undef\s+(\w+)/))) {
      if (isActive()) macros.delete(m[1]);
    } else if (/^#\s*(pragma|version|extension)\b/.test(line)) {
      // no code
    } else if (isActive()) out.push(raw);
  }
  if (stack.length) throw new Error("unbalanced #if");
  return out.join("\n");
}
const norm = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "").replace(/\s+/g, " ").trim();
const balanced = (s) => {
  let b = 0, p = 0;
  for (const ch of s) {
    if (ch === "{") b++; else if (ch === "}") b--; else if (ch === "(") p++; else if (ch === ")") p--;
    if (b < 0 || p < 0) return false;
  }
  return b === 0 && p === 0;
};
const LIGHTS = { point: 16, spot: 2, dir: 2, hemi: 1, rect: 0, pointShadows: 0, spotShadows: 0, spotMaps: 0, spotShadowsWithMaps: 0, dirShadows: 0 };
const DEFS = { RE_Direct: "RE_Direct_Physical", RE_IndirectDiffuse: "RE_IndirectDiffuse_Physical", RE_IndirectSpecular: "RE_IndirectSpecular_Physical" };
const SHADOW_DEFS = { ...DEFS, USE_SHADOWMAP: "", SHADOWMAP_TYPE_PCF: "" };
const active = (chunk, p, defs) => norm(preprocess(unrollLoops(replaceLightNums(chunk, p)), defs));
// the finder's form: the unrolled directional loop starts at NUM_DIR_LIGHT_SHADOWS
const startAtShadows = (chunk) =>
  chunk.replace("for ( int i = 0; i < NUM_DIR_LIGHTS; i ++ ) {", "for ( int i = NUM_DIR_LIGHT_SHADOWS; i < NUM_DIR_LIGHTS; i ++ ) {");
const dirCopies = (a) => [...a.matchAll(/directionalLight = directionalLights\[ (\d+) \];/g)].map((m) => +m[1]);

const LOOPS_ON = L.patchLightLoopsChunk(STOCK).text; // what installLightLoops leaves (default)
const LOOPS_OFF = L.patchLightLoopsChunk(STOCK, { rangeSkip: false }).text; // ?lightRangeSkip=off
const INPUTS = { stock: STOCK, "lightLoops (default)": LOOPS_ON, "lightLoops, ?lightRangeSkip=off": LOOPS_OFF };

// ---------------------------------------------------------------------------------------------
console.log("-- 1. premise -------------------------------------------------------------");
check("three r184 stock chunk (same sha as tests/light_range_skip.test.mjs)", sha(STOCK) === STOCK_SHA);
check("importing light_loops.js changes no chunk; it only registers the hook",
  AFTER_IMPORT === STOCK && globalThis.__hbInstallCsmDeadLights === L.installCsmDeadLights);
{
  const hook = globalThis.__hbInstallCsmDeadLights;
  delete globalThis.__hbInstallCsmDeadLights;
  const csm = setupCsm(new THREE.Scene(), { sunDir: { x: 60, y: 80, z: 30 } });
  globalThis.__hbInstallCsmDeadLights = hook;
  check("setupCsm: 3 cascade lights, intensity 0, castShadow", csm.lights.length === 3 &&
    csm.lights.every((l) => l.isDirectionalLight && l.intensity === 0 && l.castShadow === true));
  const sun = new THREE.DirectionalLight(0xfff4e0, 1.0); // lighting.js sun: castShadow stays false under csm
  const sky = new THREE.DirectionalLight(0xffffff, 3.0); // e.g. the atmosphere sun
  const orders = {
    "cascades last": [new THREE.AmbientLight(0xffffff, 0.4), sun, sky, ...csm.lights, new THREE.HemisphereLight(0xffffff, 0x444444, 0.5)],
    "cascades first": [...csm.lights, sun, sky],
    "interleaved": [sun, csm.lights[1], sky, csm.lights[0], csm.lights[2]],
  };
  for (const [name, list] of Object.entries(orders)) {
    const wl = WebGLLights({ has: () => false });
    wl.setup(list);
    const st = wl.state;
    const zero = (c) => c.r === 0 && c.g === 0 && c.b === 0;
    check(`WebGLLights (${name}): NUM_DIR_LIGHTS 5, NUM_DIR_LIGHT_SHADOWS 3, uniforms 0..2 colour exactly 0, 3..4 lit`,
      st.directional.length === 5 && st.directionalShadowMap.length === 3 &&
      [0, 1, 2].every((i) => zero(st.directional[i].color)) && [3, 4].every((i) => !zero(st.directional[i].color)) &&
      Math.abs(st.directional[3].color.r - sun.color.r) < 1e-12 && Math.abs(st.directional[4].color.r - 3) < 1e-12);
  }
  const lightingSrc = readFileSync(path.join(APP, "scene3d/lighting.js"), "utf8");
  check("lighting.js: the sun casts only without csm (the only `sun.castShadow = true`)",
    count(lightingSrc, "sun.castShadow = true") === 1 && /if \(castShadow && !csmEnabled\) \{\s*sun\.castShadow = true;/.test(lightingSrc));
  check("getDirectionalLightInfo writes colour, direction and visible of its out param",
    /void getDirectionalLightInfo\( const in DirectionalLight directionalLight, out IncidentLight light \) \{\s*light\.color = directionalLight\.color;\s*light\.direction = directionalLight\.direction;\s*light\.visible = true;\s*\}/
      .test(THREE.ShaderChunk.lights_pars_begin));
  const a = active(LOOPS_ON, { ...LIGHTS, dir: 5, dirShadows: 3 }, SHADOW_DEFS);
  const lastDir = a.lastIndexOf("directionalLight = directionalLights[ 4 ];");
  const tail = a.slice(a.indexOf(RE_DIRECT, lastDir) + RE_DIRECT.length);
  check("nothing after the directional loop reads directLight / directionalLight / directionalLightShadow",
    lastDir > 0 && !/\b(directLight|directionalLight|directionalLightShadow)\b/.test(tail));
  // the dropped copies' only effect: colour 0 * shadow in [0, 1] feeding a RE_Direct that adds
  // zero (tests/light_range_skip.test.mjs §3c: bitwise, through the retail clamp) — and with
  // ?lightRangeSkip the zero-colour gate skips that RE_Direct outright
  check("stock CSM program: copies 0..2 multiply the shadow into the colour, then the zero gate",
    dirCopies(a).join(",") === "0,1,2,3,4" &&
    /directLight\.color \*= \( directLight\.visible && receiveShadow \) \? getShadow\( directionalShadowMap\[ 2 \][^;]*; if \( any\( notEqual\( directLight\.color, vec3\( 0\.0 \) \) \) \) \{ RE_Direct\(/.test(a));
}

// ---------------------------------------------------------------------------------------------
console.log("-- 2. shape ---------------------------------------------------------------");
for (const [name, input] of Object.entries(INPUTS)) {
  const r = L.patchCsmDeadLightsChunk(input);
  const start = input.indexOf(DIR_HEAD), end = input.indexOf(LOOP_END, start);
  check(`${name}: patched, no reason`, r.patched === true && r.reason === null);
  check(`${name}: text before / after the directional loop byte-identical`,
    r.text.startsWith(input.slice(0, start)) && r.text.endsWith(input.slice(end)));
  const undone = r.text
    .replace(/\/\/ __hbCsmDeadLights[^\n]*\n\t/, "")
    .replace(`\n\t\t${GATE3}`, "")
    .replace("\n\t\t#endif\n\t}\n\t" + LOOP_END, "\n\t}\n\t" + LOOP_END);
  check(`${name}: removing the comment, #if and #endif lines gives the input back (body untouched)`, undone === input);
  check(`${name}: one gate, one marker, RE_Direct calls unchanged`,
    count(r.text, GATE3) === 1 && count(r.text, "__hbCsmDeadLights") === 1 && count(r.text, RE_DIRECT) === count(input, RE_DIRECT));
  check(`${name}: no backtick in the GLSL`, !r.text.includes("`"));
  check(`${name}: a second patch fails closed`, (() => { const r2 = L.patchCsmDeadLightsChunk(r.text); return !r2.patched && r2.text === r.text && r2.reason === "already patched"; })());
}
{
  const a = L.patchLightLoopsChunk(L.patchCsmDeadLightsChunk(STOCK).text);
  const b = L.patchCsmDeadLightsChunk(LOOPS_ON).text;
  check("commutes with patchLightLoopsChunk (byte-identical either order, all four range-skip gates)",
    a.text === b && a.skips.join(",") === "point-range,spot-range,dir,probe" && a.skipReason === null);
  check("commutes with ?lightRangeSkip=off too",
    L.patchLightLoopsChunk(L.patchCsmDeadLightsChunk(STOCK).text, { rangeSkip: false }).text === L.patchCsmDeadLightsChunk(LOOPS_OFF).text);
  check("the gate is keyed on the cascade count passed", L.patchCsmDeadLightsChunk(STOCK, 2).text.includes("#if !( NUM_DIR_LIGHT_SHADOWS == 2 &&"));
  for (const bad of [0, -1, 2.5, NaN, "3"]) {
    const r = L.patchCsmDeadLightsChunk(STOCK, bad);
    check(`bad cascade count ${String(bad)}: fails closed`, !r.patched && r.text === STOCK && /bad cascade count/.test(r.reason));
  }
  const misses = {
    "not a string": null,
    "renamed loop variable": STOCK.replace("for ( int i = 0; i < NUM_DIR_LIGHTS; i ++ ) {", "for ( int j = 0; j < NUM_DIR_LIGHTS; j ++ ) {"),
    "no stock shadow branch": STOCK.replace("#if defined( USE_SHADOWMAP ) && ( UNROLLED_LOOP_INDEX < NUM_DIR_LIGHT_SHADOWS )", "#if defined( USE_SHADOWMAP ) && ( UNROLLED_LOOP_INDEX < 1 )"),
    "body does not start with the light fetch": STOCK.replace("directionalLight = directionalLights[ i ];", "directionalLight = directionalLights[ 0 ];"),
    "two RE_Direct calls in the body": STOCK.replace("getDirectionalLightInfo( directionalLight, directLight );", "getDirectionalLightInfo( directionalLight, directLight );\n\t\t" + RE_DIRECT),
    "loop tail reshaped": (() => { const s = STOCK.indexOf(DIR_HEAD); const e = STOCK.indexOf(LOOP_END, s); return STOCK.slice(0, e) + "// x\n\t" + STOCK.slice(e); })(),
  };
  for (const [why, text] of Object.entries(misses)) {
    const r = L.patchCsmDeadLightsChunk(text);
    check(`shape miss (${why}): fails closed, text unchanged, reason`, !r.patched && r.text === text && typeof r.reason === "string", r.reason);
  }
}

// ---------------------------------------------------------------------------------------------
console.log("-- 3. active code --------------------------------------------------------");
for (const [name, input] of Object.entries(INPUTS)) {
  const patched = L.patchCsmDeadLightsChunk(input).text;
  let csmOk = 0, csmN = 0;
  for (const dir of [3, 4, 5, 6]) {
    for (const defs of [DEFS, SHADOW_DEFS]) {
      csmN++;
      const p = { ...LIGHTS, dir, dirShadows: 3 };
      const a = active(patched, p, defs);
      const want = [];
      for (let k = 3; k < dir; k++) want.push(k);
      if (a === active(startAtShadows(input), p, defs) && dirCopies(a).join(",") === want.join(",") &&
          !a.includes("getShadow(") && !a.includes("directionalLightShadows") && balanced(a)) csmOk++;
    }
  }
  check(`${name}: 3 directional shadows (2..6 dir lights, shadow map on / off) = the loop-starts-at-NUM_DIR_LIGHT_SHADOWS program, copies 3.. only, no getShadow`,
    csmOk === csmN, `${csmOk}/${csmN}`);
  let otherOk = 0, otherN = 0;
  for (const [dir, ds] of [[2, 0], [2, 1], [3, 1], [4, 2], [6, 4], [7, 4]]) {
    for (const defs of [DEFS, SHADOW_DEFS]) {
      otherN++;
      const p = { ...LIGHTS, dir, dirShadows: ds };
      if (active(patched, p, defs) === active(input, p, defs)) otherOk++;
    }
  }
  check(`${name}: 0 / 1 (?shadows=on) / 2 / 4 (CSM + a casting sun) directional shadows = the unpatched program`,
    otherOk === otherN, `${otherOk}/${otherN}`);
  const sunShadow = active(patched, { ...LIGHTS, dir: 2, dirShadows: 1 }, SHADOW_DEFS);
  check(`${name}: ?shadows=on keeps the sun's getShadow( directionalShadowMap[ 0 ] ) and both copies`,
    count(sunShadow, "getShadow( directionalShadowMap[ 0 ]") === 1 && dirCopies(sunShadow).join(",") === "0,1");
  // negative control: an UNKEYED start-at-NUM_DIR_LIGHT_SHADOWS loop would drop the ?shadows=on sun
  const unkeyed = active(startAtShadows(input), { ...LIGHTS, dir: 2, dirShadows: 1 }, SHADOW_DEFS);
  check(`${name}: control — the unkeyed form loses the ?shadows=on sun (why the gate is count-keyed)`,
    dirCopies(unkeyed).join(",") === "1" && unkeyed !== sunShadow);
}
{
  // full MeshStandardMaterial fragment program (the "physical" template without PHYSICAL)
  const CSM_LIGHTS = { ...LIGHTS, dir: 5, dirShadows: 3 };
  const STD = { STANDARD: "", USE_MAP: "", USE_UV: "", ...SHADOW_DEFS };
  delete STD.RE_Direct; delete STD.RE_IndirectDiffuse; delete STD.RE_IndirectSpecular; // the template #defines them
  const frag = (fs, chunk) => preprocess(unrollLoops(replaceLightNums(resolveIncludes(fs, { lights_fragment_begin: chunk }), CSM_LIGHTS)), STD);
  const codeLines = (src, name) => norm(src).split(";").filter((l) => new RegExp(`\\b${name}\\b`).test(l));
  const isDecl = (l) => /^\s*(uniform|varying|in)\b/.test(l.replace(/^.*\}\s*/, ""));
  const fs = THREE.ShaderLib.standard.fragmentShader;
  const before = frag(fs, LOOPS_ON), after = frag(fs, L.patchCsmDeadLightsChunk(LOOPS_ON).text);
  check("full program, stock: 3 getShadow calls on the cascades", count(norm(before), "getShadow( directionalShadowMap[") === 3);
  const users = ["directionalShadowMap", "vDirectionalShadowCoord", "directionalLightShadows"].map((n) => [n, codeLines(after, n)]);
  check("full program, patched: directionalShadowMap / vDirectionalShadowCoord / directionalLightShadows only declared (inactive)",
    users.every(([, ls]) => ls.length === 1 && isDecl(ls[0])), users.map(([n, ls]) => `${n}:${ls.length}`).join(" "));
  check("full program, patched: 2 directional RE_Direct copies, = the start-at-shadows program",
    dirCopies(norm(after)).join(",") === "3,4" && norm(after) === norm(frag(fs, startAtShadows(LOOPS_ON))) && balanced(norm(after)));

  // the retail light clamp inlines THREE.ShaderChunk.lights_fragment_begin at onBeforeCompile
  const clampCompile = (chunk) => {
    const saved = THREE.ShaderChunk.lights_fragment_begin;
    THREE.ShaderChunk.lights_fragment_begin = chunk;
    try {
      const m = new THREE.MeshStandardMaterial({ roughness: 0.8 });
      installLightClampShaderPatch(m);
      const lib = THREE.ShaderLib.standard;
      const shader = { uniforms: THREE.UniformsUtils.clone(lib.uniforms), vertexShader: lib.vertexShader, fragmentShader: lib.fragmentShader, defines: {} };
      m.onBeforeCompile(shader, null);
      return norm(frag(shader.fragmentShader, chunk));
    } finally {
      THREE.ShaderChunk.lights_fragment_begin = saved;
    }
  };
  const cl = clampCompile(L.patchCsmDeadLightsChunk(LOOPS_ON).text);
  check("light clamp: inlined the patched chunk, wraps every emitted RE_Direct (2 point / spot + 2 directional), no cascade getShadow call",
    count(cl, "RE_Direct(") === 4 && count(cl, "vec3 _lcDiffBefore = reflectedLight.directDiffuse;") === 4 &&
    dirCopies(cl).join(",") === "3,4" && !cl.includes("getShadow( directionalShadowMap[") && balanced(cl),
    `RE_Direct ${count(cl, "RE_Direct(")}, wraps ${count(cl, "vec3 _lcDiffBefore = reflectedLight.directDiffuse;")}, dir copies ${dirCopies(cl).join(",")}, balanced ${balanced(cl)}`);
  check("light clamp: same program as the clamp over the start-at-shadows chunk", cl === clampCompile(startAtShadows(LOOPS_ON)));
}

// ---------------------------------------------------------------------------------------------
console.log("-- 4. install / escape / csm.js hook ----------------------------------------");
{
  const fake = (text) => ({ ShaderChunk: { lights_fragment_begin: text } });
  const run = (search, f, cascades = 3) => {
    L.__resetCsmDeadLightsForTest();
    globalThis.window = { location: { search } };
    const d = L.installCsmDeadLights(f, cascades);
    return { text: f.ShaderChunk ? f.ShaderChunk.lights_fragment_begin : undefined, diag: { ...d } };
  };
  const want = L.patchCsmDeadLightsChunk(LOOPS_ON).text;
  const f = fake(LOOPS_ON);
  const d = run("", f);
  check("default: chunk patched, diag installed / cascades 3", d.text === want && d.diag.installed && d.diag.cascades === 3 && d.diag.reason === null);
  L.installCsmDeadLights(f, 3);
  check("idempotent: a second install leaves the text alone", f.ShaderChunk.lights_fragment_begin === want);
  check("diag reachable as lightLoopsPatch.csmDeadLights (window.__lightLoops)", L.lightLoopsPatch.csmDeadLights === L.csmDeadLightsPatch);
  for (const v of ["off", "0", "false", "no", "OFF"]) {
    const o = run(`?csmDeadLights=${v}`, fake(LOOPS_ON));
    check(`?csmDeadLights=${v}: chunk untouched`, o.text === LOOPS_ON && !o.diag.installed && o.diag.reason === "?csmDeadLights=off");
  }
  check("?csmDeadLights=on (any other value) = default", run("?csmDeadLights=on", fake(LOOPS_ON)).text === want);
  check("no ShaderChunk: reason, no throw", run("", {}).diag.reason === "no ShaderChunk");
  const warns = [];
  const origWarn = console.warn;
  console.warn = (...a) => warns.push(a.join(" "));
  const miss = STOCK.replace("for ( int i = 0; i < NUM_DIR_LIGHTS; i ++ ) {", "for ( int j = 0; j < NUM_DIR_LIGHTS; j ++ ) {");
  const m = run("", fake(miss));
  console.warn = origWarn;
  check("shape miss: chunk untouched, reason, one console warning", m.text === miss && !m.diag.installed && !!m.diag.reason && warns.length === 1 && /csmDeadLights/.test(warns[0]));
  delete globalThis.window;
  check("csmDeadLightsEnabled with no window: true", L.csmDeadLightsEnabled() === true);

  // csm.js setupCsm -> globalThis.__hbInstallCsmDeadLights(THREE, lights.length)
  const viaCsm = (search, { hook = true } = {}) => {
    L.__resetCsmDeadLightsForTest();
    globalThis.window = { location: { search } };
    THREE.ShaderChunk.lights_fragment_begin = LOOPS_ON; // as installLightLoops leaves it at boot
    const saved = globalThis.__hbInstallCsmDeadLights;
    if (!hook) delete globalThis.__hbInstallCsmDeadLights;
    try {
      setupCsm(new THREE.Scene(), {});
      return THREE.ShaderChunk.lights_fragment_begin;
    } finally {
      globalThis.__hbInstallCsmDeadLights = saved;
      delete globalThis.window;
    }
  };
  check("setupCsm installs it on the real ShaderChunk, keyed on its 3 cascades", viaCsm("") === want && L.csmDeadLightsPatch.cascades === 3);
  check("setupCsm with ?csmDeadLights=off: chunk untouched", viaCsm("?csmDeadLights=off") === LOOPS_ON);
  check("setupCsm without the hook (light_loops.js not loaded): chunk untouched", viaCsm("", { hook: false }) === LOOPS_ON);
  const csmSrc = readFileSync(path.join(APP, "scene3d/csm.js"), "utf8");
  const imports = csmSrc.match(/^\s*import\b[^\n]*$/gm) || [];
  check("csm.js still imports only three", imports.length === 1 && /^import \* as THREE from "three";$/.test(imports[0].trim()));
  // the legacy loaders (test_visfid_p33_csm.mjs & co.): strip the three import + exports, eval
  const legacy = csmSrc.replace(/^\s*import\s+\*\s+as\s+THREE\s+from\s+["']three["'];?\s*$/m, "")
    .replace(/^\s*export\s+function\s+/gm, "function ").replace(/^\s*export\s+const\s+/gm, "const ");
  let legacyOk = false;
  try {
    const mod = new Function("THREE", legacy + "\n; return { setupCsm };")(THREE);
    const saved = globalThis.__hbInstallCsmDeadLights;
    delete globalThis.__hbInstallCsmDeadLights;
    try { legacyOk = mod.setupCsm(new THREE.Scene(), {}).lights.length === 3; } finally { globalThis.__hbInstallCsmDeadLights = saved; }
  } catch (e) { legacyOk = false; console.log("    legacy load threw:", e && e.message); }
  check("csm.js still loads through a legacy `new Function` loader", legacyOk);
  THREE.ShaderChunk.lights_fragment_begin = STOCK;
  L.__resetCsmDeadLightsForTest();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
