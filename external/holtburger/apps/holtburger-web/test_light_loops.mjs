// 2026-10-06 — `?lightLoops` (scene3d/light_loops.js): three's point / spot light loops stay
// real loops when no shadow or light map needs the unrolled index.
//
// The checks run three r184's own shader pipeline steps on the chunk text (replaceLightNums,
// the unroll_loop pragma expansion) plus a small GLSL preprocessor, and compare the ACTIVE code
// a GPU compiler would see: one copy of the point / spot body instead of 16 / 2, and the exact
// same statements in the same order once the plain loops are unrolled by hand.
//
// Run:
//   cd apps/holtburger-web/
//   node test_light_loops.mjs

import { ShaderChunk } from "three";
import { patchLightLoopsChunk, installLightLoops, lightLoopsPatch, __resetLightLoopsForTest } from "./scene3d/light_loops.js";

let failed = 0, passed = 0;
function check(name, ok, detail) {
  console.log(`  [${ok ? "OK" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
  ok ? passed++ : failed++;
}

const RE_DIRECT = "RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );";

// three r184 WebGLProgram.replaceLightNums (same order: *_SHADOWS_WITH_MAPS before *_SHADOWS)
function replaceLightNums(s, p) {
  const coords = p.spotShadows + p.spotMaps - p.spotShadowsWithMaps;
  return s.replace(/NUM_DIR_LIGHTS/g, p.dir).replace(/NUM_SPOT_LIGHTS/g, p.spot).replace(/NUM_SPOT_LIGHT_MAPS/g, p.spotMaps)
    .replace(/NUM_SPOT_LIGHT_COORDS/g, coords).replace(/NUM_RECT_AREA_LIGHTS/g, p.rect).replace(/NUM_POINT_LIGHTS/g, p.point)
    .replace(/NUM_HEMI_LIGHTS/g, p.hemi).replace(/NUM_DIR_LIGHT_SHADOWS/g, p.dirShadows)
    .replace(/NUM_SPOT_LIGHT_SHADOWS_WITH_MAPS/g, p.spotShadowsWithMaps).replace(/NUM_SPOT_LIGHT_SHADOWS/g, p.spotShadows)
    .replace(/NUM_POINT_LIGHT_SHADOWS/g, p.pointShadows);
}
// three r184 WebGLProgram.unrollLoops
const unrollLoopPattern = /#pragma unroll_loop_start\s+for\s*\(\s*int\s+i\s*=\s*(\d+)\s*;\s*i\s*<\s*(\d+)\s*;\s*i\s*\+\+\s*\)\s*{([\s\S]+?)}\s+#pragma unroll_loop_end/g;
function unrollLoops(s) {
  return s.replace(unrollLoopPattern, (_m, a, b, snippet) => {
    let out = "";
    for (let i = +a; i < +b; i++) out += snippet.replace(/\[\s*i\s*\]/g, "[ " + i + " ]").replace(/UNROLLED_LOOP_INDEX/g, i);
    return out;
  });
}
// Minimal GLSL preprocessor: #if/#ifdef/#ifndef/#elif/#else/#endif, object-like #define/#undef,
// defined(), integer arithmetic + comparisons + logic in #if. Returns the active lines.
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
  const out = [], stack = []; // { active, taken, parentActive }
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
    } else if (/^#\s*pragma\b/.test(line)) {
      // leftover pragmas carry no code
    } else if (isActive()) out.push(raw);
  }
  return out.join("\n");
}
// what the GPU compiler sees, as comparable text
const norm = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "").replace(/\s+/g, " ").trim();
// The plain loops call RE_Direct only for a light with a non-zero colour (`directLight.visible`);
// stock adds that light's zero contribution instead. Drop the guard, then hand-unroll the
// plain loops, so "same statements, same order" is checkable against stock.
const unguard = (active) => active.replace(/if \( directLight\.visible \) \{\s*(RE_Direct\([^;]*;|\{ \/\*clamp\*\/ RE_Direct\([^;]*; \})\s*\}/g, "$1");
const handUnroll = (active) => unrollLoops(unguard(active).replace(/(for \( int i = 0; i < \d+; i \+\+ \) \{[^{}]*\})/g, "#pragma unroll_loop_start\n$1\n#pragma unroll_loop_end"));
const count = (s, needle) => s.split(needle).length - 1;
const BASE = { point: 16, spot: 2, dir: 2, hemi: 1, rect: 0, pointShadows: 0, spotShadows: 0, spotMaps: 0, spotShadowsWithMaps: 0, dirShadows: 0 };
const DEFS = { RE_Direct: "RE_Direct_Physical", RE_IndirectDiffuse: "RE_IndirectDiffuse_Physical", RE_IndirectSpecular: "RE_IndirectSpecular_Physical" };
const active = (chunk, p, defs = DEFS) => preprocess(unrollLoops(replaceLightNums(chunk, p)), defs);

const stock = ShaderChunk.lights_fragment_begin;
const r = patchLightLoopsChunk(stock);

console.log("patch shape");
check("both loops patched on the r184 chunk", r.reason === null && r.patched.join(",") === "point,spot", JSON.stringify({ reason: r.reason, patched: r.patched }));
check("the stock unrolled blocks are kept verbatim in the shadow / map branch",
  r.text.includes(stock.slice(stock.indexOf("#pragma unroll_loop_start\n\tfor ( int i = 0; i < NUM_POINT_LIGHTS"), stock.indexOf("#pragma unroll_loop_end", stock.indexOf("NUM_POINT_LIGHTS; i ++")))));
check("directional + hemisphere loops untouched", count(r.text, "#pragma unroll_loop_start") === count(stock, "#pragma unroll_loop_start"));
check("patching twice is a no-op", patchLightLoopsChunk(r.text).text === r.text && patchLightLoopsChunk(r.text).reason === "already patched");
const broken = stock.replace("for ( int i = 0; i < NUM_POINT_LIGHTS; i ++ ) {", "for ( int j = 0; j < NUM_POINT_LIGHTS; j ++ ) {");
const rb = patchLightLoopsChunk(broken);
check("fails closed on an unexpected chunk shape", rb.text === broken && rb.patched.length === 0 && /point/.test(rb.reason || ""), rb.reason);

console.log("\nno shadows, no light maps (this client: 16 point, 2 spot, 2 dir, 1 hemi)");
{
  const s = active(stock, BASE), o = active(r.text, BASE);
  check("stock: 16 point + 2 spot copies", count(s, "getPointLightInfo(") === 16 && count(s, "getSpotLightInfo(") === 2);
  check("patched: one point + one spot copy", count(o, "getPointLightInfo(") === 1 && count(o, "getSpotLightInfo(") === 1, `${count(o, "getPointLightInfo(")} / ${count(o, "getSpotLightInfo(")}`);
  check("RE_Direct copies 20 -> 4", count(s, "RE_Direct(") === 20 && count(o, "RE_Direct(") === 4, `${count(s, "RE_Direct(")} -> ${count(o, "RE_Direct(")}`);
  check("same statements in the same order once unrolled by hand", norm(handUnroll(o)) === norm(s));
  check("active code shrinks", norm(o).length * 3 < norm(s).length, `${norm(s).length} -> ${norm(o).length} chars`);
  check("plain loops skip zero-colour lights", count(o, "if ( directLight.visible ) {") === 2);
}

console.log("\nprograms that need the unrolled index keep the stock code");
for (const [label, p, extra] of [
  ["point shadows (PCF)", { ...BASE, pointShadows: 1 }, { USE_SHADOWMAP: "", SHADOWMAP_TYPE_PCF: "" }],
  ["spot shadows", { ...BASE, spotShadows: 1 }, { USE_SHADOWMAP: "", SHADOWMAP_TYPE_PCF: "" }],
  ["spot light map", { ...BASE, spotMaps: 1 }, {}],
  ["spot shadow with map", { ...BASE, spotShadows: 1, spotMaps: 1, spotShadowsWithMaps: 1 }, { USE_SHADOWMAP: "", SHADOWMAP_TYPE_PCF: "" }],
]) {
  const defs = { ...DEFS, ...extra };
  const s = active(stock, p, defs), o = active(r.text, p, defs);
  check(`${label}: active code identical to stock (plain loops hand-unrolled)`, norm(handUnroll(o)) === norm(s));
}
{
  const p = { ...BASE, pointShadows: 1 }, defs = { ...DEFS, USE_SHADOWMAP: "", SHADOWMAP_TYPE_PCF: "" };
  check("point shadows: the point loop is the stock unrolled one", count(active(r.text, p, defs), "getPointLightInfo(") === 16);
  check("shadow map present but zero point shadows: plain point loop", count(active(r.text, BASE, defs), "getPointLightInfo(") === 1);
}

console.log("\nretail light-clamp wrapper (materials.js split/join on the RE_Direct call)");
{
  const WRAP = "{ /*clamp*/ " + RE_DIRECT + " }";
  const wrapped = r.text.split(RE_DIRECT).join(WRAP);
  const o = active(wrapped, BASE);
  check("every active RE_Direct is wrapped (1 point + 1 spot + 2 dir)", count(o, "/*clamp*/") === 4 && count(o, "RE_Direct(") === 4);
  const s = active(stock.split(RE_DIRECT).join(WRAP), BASE);
  const flat = (x) => x.replace(/\{ \/\*clamp\*\/ /g, "CLAMP_OPEN ").replace(/ \}/g, " CLAMP_CLOSE");
  check("wrapped: same statements as the wrapped stock chunk", norm(handUnroll(flat(unguard(o)))) === norm(flat(s)));
}

console.log("\ninstall");
{
  const fake = { ShaderChunk: { lights_fragment_begin: stock } };
  __resetLightLoopsForTest();
  globalThis.window = { location: { search: "?lightLoops=off" } };
  installLightLoops(fake);
  check("?lightLoops=off leaves the stock chunk", fake.ShaderChunk.lights_fragment_begin === stock && !lightLoopsPatch.installed && lightLoopsPatch.reason === "?lightLoops=off");
  check("window.__lightLoops mirrors the result", window.__lightLoops === lightLoopsPatch);
  __resetLightLoopsForTest();
  globalThis.window = { location: { search: "" } };
  installLightLoops(fake);
  check("default: chunk replaced with the patched text", fake.ShaderChunk.lights_fragment_begin === r.text && lightLoopsPatch.installed);
  installLightLoops(fake);
  check("second install is a no-op", fake.ShaderChunk.lights_fragment_begin === r.text);
  __resetLightLoopsForTest();
  delete globalThis.window;
}

console.log(`\n${passed} passed / ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
