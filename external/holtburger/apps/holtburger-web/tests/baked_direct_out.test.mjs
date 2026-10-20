// tests/baked_direct_out.test.mjs
//
// 2026-10-20 (improvement hunt building-fill-2) — `?bakedDirectOut` (default
// ON, `=off` escape). Under the retail vertex-bake arm (`suppressDirect`) the
// baked EnvCell program ran three's whole direct-light pipeline and then
// multiplied it by 0 after `<lights_fragment_end>`. applyBakedVertexLightPatch
// now also emits `#undef RE_Direct` right before `void main() {`, so every
// direct loop compiles out.
//
// The checks run the production patch against REAL three r184 shader text,
// resolve the #includes, apply three's own replaceLightNums + unroll_loop
// expansion (same helpers as test_light_loops.mjs), and preprocess with the
// macros a cell-baked MeshStandardMaterial program has. They compare the
// ACTIVE code a GPU compiler would see:
//
//   B1  flag grammar (`readBakedDirectOutFlag`): absent = ON, off-family = OFF.
//   B2  default arm: zero active RE_Direct / light-info calls; the bake add and
//       the `* acKeepDirect` multiply are still there.
//   B3  SAME IMAGE: the new active code is the old active code minus lines
//       that all sit inside the direct-light section of lights_fragment_begin
//       (between `IncidentLight directLight;` and the RE_IndirectDiffuse
//       block). Everything that feeds indirect light, the bake add, the
//       multiply and the output is byte-identical. Holds with the light-loops
//       chunk patch and with the retail light-clamp wrapper chained too.
//   B4  `?vertexBake=lit` (suppressDirect false) and `?bakedDirectOut=off`
//       emit no #undef: the shader string is byte-identical to the old patch.
//   B5  clearcoat / sheen guard: those accumulate DIRECT light into globals the
//       multiply never touched, so the #undef is preprocessed away for them.
//   B6  program keys: `|k1d` on the default arm only; lit / escape keep `|k1`;
//       the pooled interior class key gains a trailing `d` the same way.
//
// Run: node tests/baked_direct_out.test.mjs

import * as THREE from "three";
import {
  applyBakedVertexLightPatch,
  installLightClampShaderPatch,
  readBakedDirectOutFlag,
  BAKED_DIRECT_OUT,
  VERTEX_BAKE,
  MaterialCache,
} from "../scene3d/materials.js";
import { patchLightLoopsChunk } from "../scene3d/light_loops.js";
import { ClassMaterialRegistry } from "../scene3d/pool_material.js";

let passed = 0, failed = 0;
function check(label, cond, extra = "") {
  if (cond) { passed++; console.log(`  [OK] ${label}`); }
  else { failed++; console.log(`  [FAIL] ${label} ${extra}`); }
}

// --- three r184 program pipeline (mirrors test_light_loops.mjs) -------------
function resolveIncludes(s, chunks) {
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
// Minimal GLSL preprocessor (test_light_loops.mjs): #if/#ifdef/#ifndef/#elif/
// #else/#endif, object-like #define/#undef, defined(), integer logic in #if.
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
      // carries no code
    } else if (isActive()) out.push(raw);
  }
  return out;
}
const stripComments = (lines) =>
  lines.join("\n").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "")
    .split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
const count = (lines, needle) => lines.reduce((n, l) => n + (l.split(needle).length - 1), 0);

// This client's light pool: 16 point + 2 spot + 2 directional + 1 hemi, no
// point / spot shadows (lighting.js), one directional shadow is not used by
// cell-baked programs either; MeshStandardMaterial = the "physical" template
// WITHOUT the PHYSICAL define (so no clearcoat / sheen).
const LIGHTS = { point: 16, spot: 2, dir: 2, hemi: 1, rect: 0, pointShadows: 0, spotShadows: 0, spotMaps: 0, spotShadowsWithMaps: 0, dirShadows: 0 };
const STANDARD_DEFS = { STANDARD: "", USE_MAP: "", USE_UV: "", DOUBLE_SIDED: "" };

/** Run `mat`'s onBeforeCompile chain on the REAL r184 standard shader text. */
function compile(mat) {
  const lib = THREE.ShaderLib.standard;
  const shader = {
    uniforms: THREE.UniformsUtils.clone(lib.uniforms),
    vertexShader: lib.vertexShader,
    fragmentShader: lib.fragmentShader,
    defines: {},
  };
  mat.onBeforeCompile(shader, null);
  return shader;
}
/** The active fragment lines a GPU compiler sees for this program. */
function activeFrag(fragmentShader, { defs = STANDARD_DEFS, chunks = {} } = {}) {
  const full = unrollLoops(replaceLightNums(resolveIncludes(fragmentShader, chunks), LIGHTS));
  return stripComments(preprocess(full, defs));
}
function bakedMat(opts) {
  const m = new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0, side: THREE.DoubleSide });
  applyBakedVertexLightPatch(m, opts);
  return m;
}
/** Greedy in-order subsequence match: returns the indices of `big` that are NOT in `small`, or null. */
function removedIndices(big, small) {
  const removed = [];
  let j = 0;
  for (let i = 0; i < big.length; i++) {
    if (j < small.length && big[i] === small[j]) j++;
    else removed.push(i);
  }
  return j === small.length ? removed : null;
}

// ---------------------------------------------------------------------------
console.log("\n-- B1 flag grammar ---------------------------------------------");
check("absent -> ON", readBakedDirectOutFlag("") === true);
check("unrelated params -> ON", readBakedDirectOutFlag("?vertexBake=on&nosw=1") === true);
for (const off of ["off", "OFF", "false", "0", "no"]) {
  check(`?bakedDirectOut=${off} -> OFF`, readBakedDirectOutFlag(`?bakedDirectOut=${off}`) === false);
}
check("?bakedDirectOut=on -> ON (no-op, already the default)", readBakedDirectOutFlag("?bakedDirectOut=on") === true);
check("node (no location) boots ON", BAKED_DIRECT_OUT === true && VERTEX_BAKE.suppressDirect === true);

// ---------------------------------------------------------------------------
console.log("\n-- B2 default arm compiles the direct loops out -----------------");
const oldShader = compile(bakedMat({ suppressDirect: true, directOut: false })); // the pre-change patch
const newShader = compile(bakedMat({ suppressDirect: true })); // production default
const oldActive = activeFrag(oldShader.fragmentShader);
const newActive = activeFrag(newShader.fragmentShader);
// Call sites live in main(); the helper DEFINITIONS above it stay (unused).
const mainOf = (lines) => lines.slice(lines.indexOf("void main() {"));
const oldMain = mainOf(oldActive), newMain = mainOf(newActive);
check("old (escape) program: 20 active RE_Direct calls (16 point + 2 spot + 2 dir)",
  count(oldActive, "RE_Direct(") === 20, String(count(oldActive, "RE_Direct(")));
check("new program: 0 active RE_Direct calls", count(newActive, "RE_Direct(") === 0, String(count(newActive, "RE_Direct(")));
check("old main(): 16 point + 2 spot + 2 directional light-info evaluations",
  count(oldMain, "getPointLightInfo(") === 16 && count(oldMain, "getSpotLightInfo(") === 2 &&
  count(oldMain, "getDirectionalLightInfo(") === 2);
check("new main(): no point / spot / directional light-info evaluation",
  count(newMain, "getPointLightInfo(") === 0 && count(newMain, "getSpotLightInfo(") === 0 &&
  count(newMain, "getDirectionalLightInfo(") === 0);
check("the #undef sits right before main()",
  /#undef RE_Direct\n#endif\nvoid main\(\) \{/.test(newShader.fragmentShader));
check("the multiply and the bake add are still active",
  newActive.includes("float acKeepDirect = 1.0 - uAcBakedSuppressDirect;") &&
  newActive.includes("reflectedLight.directDiffuse *= acKeepDirect;") &&
  newActive.some((l) => l.includes("acBakedEotf(vAcBakedLight) * uAcBakedGain")));
check("indirect light still runs in main() (ambient + hemisphere + IBL)",
  count(newMain, "getAmbientLightIrradiance(") === 1 && count(newMain, "getHemisphereLightIrradiance(") === 1 &&
  count(newMain, "RE_IndirectDiffuse(") === count(oldMain, "RE_IndirectDiffuse(") &&
  count(newMain, "RE_IndirectSpecular(") === count(oldMain, "RE_IndirectSpecular(") &&
  count(newMain, "RE_IndirectDiffuse(") > 0);
check("main() shrinks by more than half", newMain.join("\n").length * 2 < oldMain.join("\n").length,
  `${oldMain.join("\n").length} -> ${newMain.join("\n").length} chars`);
check("the vertex shader is untouched by the #undef", newShader.vertexShader === oldShader.vertexShader);
check("uniform set unchanged (uAcBakedSuppressDirect kept for ?vertexBake=lit)",
  Object.keys(newShader.uniforms).join() === Object.keys(oldShader.uniforms).join() &&
  newShader.uniforms.uAcBakedSuppressDirect.value === 1);

// ---------------------------------------------------------------------------
console.log("\n-- B3 same image: only direct-light lines are removed ------------");
function sameImageCase(label, oldA, newA) {
  const removed = removedIndices(oldA, newA);
  check(`${label}: new active code is an in-order subsequence of the old`, removed !== null);
  if (!removed) return;
  const start = oldA.indexOf("IncidentLight directLight;");
  const end = oldA.indexOf("vec3 iblIrradiance = vec3( 0.0 );");
  check(`${label}: direct section located`, start >= 0 && end > start, `${start}..${end}`);
  check(`${label}: every removed line lies inside the direct section`,
    removed.length > 0 && removed.every((i) => i > start && i < end),
    `${removed.length} removed, first ${removed[0]}, last ${removed[removed.length - 1]}`);
  const removedText = removed.map((i) => oldA[i]).join("\n");
  check(`${label}: nothing indirect / output / bake-related is removed`,
    !/indirectDiffuse|indirectSpecular|irradiance\s*[+]?=|outgoingLight|totalEmissiveRadiance|acBaked|acKeepDirect|clearcoatSpecular|sheenSpecular|gl_FragColor/.test(removedText));
  check(`${label}: the code before and after the direct section is byte-identical`,
    oldA.slice(0, start + 1).join("\n") === newA.slice(0, start + 1).join("\n") &&
    oldA.slice(end).join("\n") === newA.slice(newA.length - (oldA.length - end)).join("\n"));
}
sameImageCase("stock chunk", oldActive, newActive);
{
  const lp = patchLightLoopsChunk(THREE.ShaderChunk.lights_fragment_begin);
  check("light-loops chunk patch applies to r184", lp.reason === null, String(lp.reason));
  const chunks = { lights_fragment_begin: lp.text };
  const o = activeFrag(oldShader.fragmentShader, { chunks });
  const n = activeFrag(newShader.fragmentShader, { chunks });
  check("light-loops chunk: old 4 RE_Direct (plain loops) -> new 0", count(o, "RE_Direct(") === 4 && count(n, "RE_Direct(") === 0);
  const sz = (lines) => mainOf(lines).join("\n").length;
  console.log(`    active main() chars: stock chunk ${sz(oldActive)} -> ${sz(newActive)}; ` +
    `light-loops chunk (the page default) ${sz(o)} -> ${sz(n)}`);
  sameImageCase("light-loops chunk", o, n);
}
{
  // The retail light-clamp wrapper expands lights_fragment_begin inline (a
  // future clamp re-install on cell-baked clones, or any host that chains it).
  const clampOld = new THREE.MeshStandardMaterial();
  installLightClampShaderPatch(clampOld);
  applyBakedVertexLightPatch(clampOld, { suppressDirect: true, directOut: false });
  const clampNew = new THREE.MeshStandardMaterial();
  installLightClampShaderPatch(clampNew);
  applyBakedVertexLightPatch(clampNew, { suppressDirect: true });
  const o = activeFrag(compile(clampOld).fragmentShader);
  const n = activeFrag(compile(clampNew).fragmentShader);
  check("light clamp chained (node default = retail)", clampNew.userData.lightClampRetail === true);
  check("light clamp: old 20 wrapped RE_Direct -> new 0", count(o, "RE_Direct(") === 20 && count(n, "RE_Direct(") === 0);
  sameImageCase("light clamp", o, n);
}

// ---------------------------------------------------------------------------
console.log("\n-- B4 lit arm + escape: shader string unchanged ------------------");
{
  const lit = compile(bakedMat({ suppressDirect: false }));
  const litEsc = compile(bakedMat({ suppressDirect: false, directOut: true })); // directOut never applies without suppress
  check("?vertexBake=lit: no #undef emitted", !lit.fragmentShader.includes("#undef RE_Direct"));
  check("?vertexBake=lit: directOut cannot force it", litEsc.fragmentShader === lit.fragmentShader);
  check("?vertexBake=lit: 20 active RE_Direct, uniform 0",
    count(activeFrag(lit.fragmentShader), "RE_Direct(") === 20 && lit.uniforms.uAcBakedSuppressDirect.value === 0);
  check("?bakedDirectOut=off: no #undef emitted", !oldShader.fragmentShader.includes("#undef RE_Direct"));
  check("?bakedDirectOut=off: string = the default string minus the #undef block",
    newShader.fragmentShader.replace("#if !defined( USE_CLEARCOAT ) && !defined( USE_SHEEN )\n#undef RE_Direct\n#endif\n", "") ===
      oldShader.fragmentShader);
}

// ---------------------------------------------------------------------------
console.log("\n-- B5 clearcoat / sheen keep their direct terms -------------------");
{
  for (const [label, extra] of [["USE_CLEARCOAT", { PHYSICAL: "", USE_CLEARCOAT: "" }], ["USE_SHEEN", { PHYSICAL: "", USE_SHEEN: "" }]]) {
    const defs = { ...STANDARD_DEFS, ...extra };
    const n = activeFrag(newShader.fragmentShader, { defs });
    check(`${label}: the guard keeps RE_Direct live (20 calls)`, count(n, "RE_Direct(") === 20, String(count(n, "RE_Direct(")));
  }
}

// ---------------------------------------------------------------------------
console.log("\n-- B6 program keys ----------------------------------------------");
{
  const keyDef = bakedMat({ suppressDirect: true }).customProgramCacheKey();
  const keyEsc = bakedMat({ suppressDirect: true, directOut: false }).customProgramCacheKey();
  const keyLit = bakedMat({ suppressDirect: false }).customProgramCacheKey();
  const plain = new THREE.MeshStandardMaterial();
  installLightClampShaderPatch(plain);
  check("default arm key carries k1d", keyDef === "hb|d0|c0|p0|l0|a0|b0|f0|s0|k1d|v", keyDef);
  check("escape key is the pre-change k1", keyEsc === "hb|d0|c0|p0|l0|a0|b0|f0|s0|k1|v", keyEsc);
  check("lit key is the pre-change k1", keyLit === keyEsc, keyLit);
  check("the #undef program never shares a key with the multiply-only one", keyDef !== keyEsc);
  check("un-baked keys unchanged (no d anywhere)", !/\|k0d/.test(plain.customProgramCacheKey()), plain.customProgramCacheKey());
  check("marker stamped at install time", bakedMat({ suppressDirect: true }).userData.__acBakedDirectOut === true &&
    bakedMat({ suppressDirect: false }).userData.__acBakedDirectOut === false);

  // getCachedCellBaked (the production caller) inherits the boot-time flag.
  const cache = new MaterialCache({});
  const tex = new THREE.DataTexture(new Uint8Array([200, 150, 100, 255]), 1, 1);
  const base = new THREE.MeshStandardMaterial({ map: tex });
  cache.materials.set(0x08000123, base);
  const cb = cache.getCachedCellBaked(0x08000123);
  check("getCachedCellBaked: k1d + #undef in the compiled string",
    /\|k1d\|/.test(cb.customProgramCacheKey()) && compile(cb).fragmentShader.includes("#undef RE_Direct"),
    cb.customProgramCacheKey());

  // Pooled interiors (ENVCELL-POOL-SWAP, opt-in): composed atlas key + k1s + d.
  const reg = new ClassMaterialRegistry({ warn: () => {} });
  const member = new THREE.MeshStandardMaterial({ map: tex });
  member.userData = { __acBakedLight: true };
  const c = reg._classOf("ec|test-baked", 256, 256, false, member);
  const pm = c && c.material;
  const pk = pm ? pm.customProgramCacheKey() : "";
  check("pool class: baked key ends |k1sd", pk.endsWith("|k1sd"), pk);
  check("pool class: compiled string carries the #undef", !!pm && compile(pm).fragmentShader.includes("#undef RE_Direct"));
  const plainMember = new THREE.MeshStandardMaterial({ map: tex });
  const c2 = reg._classOf("ec|test-plain", 256, 256, false, plainMember);
  const pk2 = c2 && c2.material ? c2.material.customProgramCacheKey() : "";
  check("pool class: un-baked key carries neither k1 nor d", !/\|k1/.test(pk2), pk2);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
