// 2026-10-20 (improvement hunt A6, building-fill-1 + building-fill-3) — ?lightRangeSkip
// (scene3d/light_loops.js): the plain point / spot loops test the light's squared range before
// getPointLightInfo / getSpotLightInfo; the directional RE_Direct runs only for a non-zero
// colour; the light-probe SH runs only for a non-zero DC term. `?lightRangeSkip=off` emits the
// previous chunk byte for byte.
//
// What is pinned here (no browser, no GPU):
//   1. SHAPE — the guards sit exactly where claimed in the patched chunk, run through three
//      r184's own replaceLightNums / unroll_loop expansion and a small GLSL preprocessor: one
//      range guard per plain loop (nested if, no `continue`), the info and RE_Direct call texts
//      byte-identical (so the retail light-clamp split/join still wraps every active RE_Direct),
//      the directional gate AFTER the shadow multiply in both unrolled copies, the probe gate
//      only under USE_LIGHT_PROBES, the stock unrolled shadow branch untouched.
//   2. ESCAPE — rangeSkip:false / ?lightRangeSkip=off is byte-identical to the 2026-10-06
//      chunk (sha256 taken from light_loops.js at HEAD before this change).
//   3. EXACTNESS — the guard condition is lifted out of the patched GLSL text and evaluated:
//      (a) in JS for its logic (NaN / cutoff <= 0 keep the stock path); (b) in a float32 model
//      with every op ulp-perturbed (dot / mul +-2, sqrt / div / pow +-4..8 ulps, i.e. past the
//      D3D11 tolerances) over ~1.3 M fragment samples straddling the light sphere: no skipped
//      sample would have contributed under either distance law (three's stock Frostbite window
//      or the retail linear clamp), so the skipped info call would have produced colour 0 /
//      visible false and added nothing. A negative control with margin 1.0 does find
//      contributing skipped samples, so the model is sharp enough to catch a bad margin.
//      (c) zero colour through RE_Direct (Physical / Lambert / BlinnPhong) and the retail clamp
//      wrapper leaves the accumulators bitwise unchanged (-0 included); (d) a zero SH adds
//      exactly nothing; (e) for the only LightProbe in the client (takram SkyLightProbe, as
//      summed by three's WebGLLights and uploaded as float32), a zero DC means all 9 zero.
//
// Run:
//   cd apps/holtburger-web/
//   node tests/light_range_skip.test.mjs

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(HERE, "..");
const { ShaderChunk } = await import("three");
const L = await import("../scene3d/light_loops.js");

let passed = 0, failed = 0;
function check(label, cond, extra = "") {
  if (cond) { passed++; console.log(`  [OK] ${label}${extra ? " — " + extra : ""}`); }
  else { failed++; console.log(`  [FAIL] ${label} ${extra}`); }
}

const RE_DIRECT = "RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );";
const POINT_INFO = "getPointLightInfo( pointLight, geometryPosition, directLight );";
const SPOT_INFO = "getSpotLightInfo( spotLight, geometryPosition, directLight );";
const PROBE_LINE = "irradiance += getLightProbeIrradiance( lightProbe, geometryNormal );";
// sha256 of patchLightLoopsChunk(three r184 lights_fragment_begin).text at HEAD 264ab98e, before
// ?lightRangeSkip existed (and of the stock chunk it was taken from).
const PREV_PATCHED_SHA = "158cf7e1275d41b250e458370477383dfc596ca85329ed425f69a5ae520ad05b";
const STOCK_SHA = "88970fde062487e5485e279e5c4fa3cfe16e6486d3148edc68def33042d054c1";
const sha = (s) => createHash("sha256").update(s).digest("hex");
const count = (s, needle) => s.split(needle).length - 1;

// --- three r184 program assembly steps (same copies as test_light_loops.mjs) -----------------
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
    } else if (/^#\s*pragma\b/.test(line)) {
      // no code
    } else if (isActive()) out.push(raw);
  }
  return out.join("\n");
}
const norm = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "").replace(/\s+/g, " ").trim();
const BASE = { point: 16, spot: 2, dir: 2, hemi: 1, rect: 0, pointShadows: 0, spotShadows: 0, spotMaps: 0, spotShadowsWithMaps: 0, dirShadows: 0 };
const DEFS = { RE_Direct: "RE_Direct_Physical", RE_IndirectDiffuse: "RE_IndirectDiffuse_Physical", RE_IndirectSpecular: "RE_IndirectSpecular_Physical" };
const active = (chunk, p = BASE, defs = DEFS) => preprocess(unrollLoops(replaceLightNums(chunk, p)), defs);
// brace / paren balance of the active code (a cheap stand-in for a GLSL parse)
const balanced = (s) => {
  let b = 0, p = 0;
  for (const ch of s) {
    if (ch === "{") b++; else if (ch === "}") b--; else if (ch === "(") p++; else if (ch === ")") p--;
    if (b < 0 || p < 0) return false;
  }
  return b === 0 && p === 0;
};

const stock = ShaderChunk.lights_fragment_begin;
const on = L.patchLightLoopsChunk(stock);
const off = L.patchLightLoopsChunk(stock, { rangeSkip: false });

console.log("-- 1. shape ---------------------------------------------------------------");
check("three r184 stock chunk is the one the escape hash was taken from", sha(stock) === STOCK_SHA);
check("default: loops patched + all four gates", on.reason === null && on.patched.join(",") === "point,spot" &&
  on.skips.join(",") === "point-range,spot-range,dir,probe" && on.skipReason === null, JSON.stringify(on.skips));
const RANGE_RE = /vec3 hbRangeL = (\w+)\.position - geometryPosition;\s*if \( (!\( \1\.distance > 0\.0 && dot\( hbRangeL, hbRangeL \) > \1\.distance \* \1\.distance \* ([0-9.]+) \)) \) \{\s*(get\w+LightInfo\([^;]*;)\s*if \( directLight\.visible \) \{\s*(RE_Direct\([^;]*;)\s*\}\s*\}/g;
const guards = [...on.text.matchAll(RANGE_RE)];
check("one range guard per plain loop (point, spot), nested if around info + visible + RE_Direct",
  guards.length === 2 && guards[0][1] === "pointLight" && guards[1][1] === "spotLight", `${guards.length} guards`);
check("info call texts byte-identical inside the guards", guards.length === 2 && guards[0][4] === POINT_INFO && guards[1][4] === SPOT_INFO);
check("RE_Direct call text byte-identical inside the guards", guards.length === 2 && guards.every((g) => g[5] === RE_DIRECT));
check("no `continue` / `break` added", count(on.text, "continue") === count(stock, "continue") && count(on.text, "break") === count(stock, "break"));
const MARGIN = guards.length ? guards[0][3] : "NaN";
check("one margin constant, > 1", guards.every((g) => g[3] === MARGIN) && Number(MARGIN) > 1, MARGIN);
{
  const a = active(on.text);
  check("active (16 point / 2 spot / 2 dir / 1 hemi, no probe): 1 + 1 range guards, 2 dir gates, 0 probe gates",
    count(a, "vec3 hbRangeL =") === 2 && count(a, "if ( any( notEqual( directLight.color, vec3( 0.0 ) ) ) ) {") === 2 &&
    count(a, "lightProbe") === 0);
  check("active code is brace / paren balanced", balanced(norm(a)));
  // the directional gate wraps exactly the RE_Direct call, after the shadow block
  const dirGated = norm(a).match(/directionalLight = directionalLights\[ \d \]; getDirectionalLightInfo\( directionalLight, directLight \); if \( any\( notEqual\( directLight\.color, vec3\( 0\.0 \) \) \) \) \{ RE_Direct\([^;]*; \}/g) || [];
  check("both unrolled directional copies: info, then gate { RE_Direct }", dirGated.length === 2);
  const ap = active(on.text, BASE, { ...DEFS, USE_LIGHT_PROBES: "" });
  check("USE_LIGHT_PROBES: one probe gate around the stock SH line",
    count(ap, "if ( any( notEqual( lightProbe[ 0 ], vec3( 0.0 ) ) ) ) {") === 1 &&
    /if \( any\( notEqual\( lightProbe\[ 0 \], vec3\( 0\.0 \) \) \) \) \{ irradiance \+= getLightProbeIrradiance\( lightProbe, geometryNormal \); \}/.test(norm(ap)) &&
    count(ap, PROBE_LINE) === 1 && balanced(norm(ap)));
  const ad = active(on.text, { ...BASE, dirShadows: 1 }, { ...DEFS, USE_SHADOWMAP: "", SHADOWMAP_TYPE_PCF: "" });
  check("directional shadows: the gate reads the SHADOWED colour (after the shadow multiply)",
    /directLight\.color \*= \( directLight\.visible && receiveShadow \) \? getShadow\( directionalShadowMap\[ 0 \][^;]*; if \( any\( notEqual\( directLight\.color/.test(norm(ad)));
  const aps = active(on.text, { ...BASE, pointShadows: 1 }, { ...DEFS, USE_SHADOWMAP: "", SHADOWMAP_TYPE_PCF: "" });
  check("point shadows: stock unrolled point loop, no range guard there (spot plain loop keeps its own)",
    count(aps, POINT_INFO) === 16 && count(aps, "vec3 hbRangeL = pointLight") === 0 && count(aps, "vec3 hbRangeL = spotLight") === 1);
}
{
  // materials.js _installLightClampShaderPatch: split/join on the RE_Direct call text
  const WRAP = "{ /*clamp*/ " + RE_DIRECT + " }";
  const a = active(on.text.split(RE_DIRECT).join(WRAP)).replace(/\s+/g, " "); // keep the /*clamp*/ marker (norm strips comments)
  const inGuards = (a.match(/if \( directLight\.visible \) \{ \{ \/\*clamp\*\/ RE_Direct\(/g) || []).length +
    (a.match(/if \( any\( notEqual\( directLight\.color, vec3\( 0\.0 \) \) \) \) \{ \{ \/\*clamp\*\/ RE_Direct\(/g) || []).length;
  check("light-clamp wrapper still wraps all 4 active RE_Direct calls, each inside its gate", count(a, "/*clamp*/") === 4 && inGuards === 4, `${inGuards} in gates`);
}
{
  const noProbe = stock.replace(PROBE_LINE, "irradiance += vec3( 0.0 );");
  const r = L.patchLightLoopsChunk(noProbe);
  check("a gate whose target is missing fails closed on its own (loops + other gates still go in)",
    r.patched.join(",") === "point,spot" && r.skips.join(",") === "point-range,spot-range,dir" && /probe/.test(r.skipReason || "") && !r.text.includes("lightProbe[ 0 ]"));
  const noDir = stock.replace(/for \( int i = 0; i < NUM_DIR_LIGHTS; i \+\+ \) \{/, "for ( int j = 0; j < NUM_DIR_LIGHTS; j ++ ) {");
  const rd = L.patchLightLoopsChunk(noDir);
  check("directional loop shape miss: dir gate skipped, reason says so", rd.skips.join(",") === "point-range,spot-range,probe" && /dir/.test(rd.skipReason || ""));
}

console.log("-- 2. escape --------------------------------------------------------------");
check("rangeSkip:false is byte-identical to the 2026-10-06 patched chunk", sha(off.text) === PREV_PATCHED_SHA && off.skips.length === 0);
check("rangeSkip:false carries none of the new text", !off.text.includes("hbRangeL") && !off.text.includes("notEqual"));
{
  const fake = () => ({ ShaderChunk: { lights_fragment_begin: stock } });
  const run = (search) => {
    L.__resetLightLoopsForTest();
    globalThis.window = { location: { search } };
    const f = fake();
    L.installLightLoops(f);
    return { text: f.ShaderChunk.lights_fragment_begin, diag: { ...L.lightLoopsPatch } };
  };
  const d = run("");
  check("install default: patched text with the gates, diag lists them", d.text === on.text && d.diag.installed && d.diag.rangeSkip.join(",") === "point-range,spot-range,dir,probe" && d.diag.rangeSkipReason === null);
  for (const v of ["off", "0", "false", "no", "OFF"]) {
    const o = run(`?lightRangeSkip=${v}`);
    check(`?lightRangeSkip=${v}: previous chunk, loops still patched`, sha(o.text) === PREV_PATCHED_SHA && o.diag.installed && o.diag.rangeSkip.length === 0 && o.diag.rangeSkipReason === "?lightRangeSkip=off");
  }
  const o2 = run("?lightRangeSkip=on");
  check("?lightRangeSkip=on (any other value) = default", o2.text === on.text);
  const o3 = run("?lightLoops=off");
  check("?lightLoops=off: stock chunk, no gates", o3.text === stock && !o3.diag.installed && o3.diag.rangeSkip.length === 0);
  check("lightRangeSkipEnabled with no window: true", (() => { delete globalThis.window; return L.lightRangeSkipEnabled() === true; })());
  L.__resetLightLoopsForTest();
}

console.log("-- 3. exactness -----------------------------------------------------------");
// float32 machinery
const f32 = Math.fround;
const _f = new Float32Array(1), _u = new Int32Array(_f.buffer);
// nudge a POSITIVE finite float32 by k ulps
function nudge(x, k) {
  if (!k || !(x > 0) || !Number.isFinite(x)) return x;
  _f[0] = x; _u[0] += k; return _f[0];
}
let seed = 0x1234567;
const rnd = () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const jit = (e) => Math.round((rnd() * 2 - 1) * e);
const sat = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const dot3 = (a, b) => f32(f32(f32(a[0] * b[0]) + f32(a[1] * b[1])) + f32(a[2] * b[2]));

// (a) the guard's LOGIC, evaluated from the GLSL text itself (double precision is fine here)
const conds = guards.map((g) => ({ light: g[1], fn: new Function(g[1], "hbRangeL", "dot", `return ${g[2]};`) }));
const jsDot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const callsInfo = (light, pos, gpos) => conds[0].fn(light, [pos[0] - gpos[0], pos[1] - gpos[1], pos[2] - gpos[2]], jsDot);
check("text: inside range -> info runs", conds.length === 2 && callsInfo({ distance: 10, position: [0, 0, 0] }, [0, 0, 0], [3, 4, 0]) === true);
check("text: out of range -> skipped", callsInfo({ distance: 10, position: [0, 0, 0] }, [0, 0, 0], [30, 4, 0]) === false);
check("text: parked pool slot (y = -1e5, cutoff 1) -> skipped", callsInfo({ distance: 1, position: [0, -1e5, 0] }, [0, -1e5, 0], [12, 3, -40]) === false);
check("text: cutoff 0 (infinite reach) / negative / NaN -> stock path", [0, -1, NaN].every((c) => callsInfo({ distance: c, position: [0, 0, 0] }, [0, 0, 0], [1e4, 0, 0]) === true));
check("text: NaN position -> stock path", callsInfo({ distance: 10, position: [NaN, 0, 0] }, [NaN, 0, 0], [30, 0, 0]) === true);
check("text: the spot guard is the same expression on spotLight", conds.length === 2 && conds[1].fn({ distance: 10, position: [0, 0, 0] }, [30, 4, 0], jsDot) === false && conds[1].light === "spotLight");

// (b) float32 model, ulp-perturbed. Returns { skipped, contributes } for one fragment / light.
function sample(K, light, g, E) {
  const Lv = [f32(light.p[0] - g[0]), f32(light.p[1] - g[1]), f32(light.p[2] - g[2])];
  const c = light.c;
  // the guard (its own dot, own rounding / FMA order)
  const dG = nudge(dot3(Lv, Lv), jit(2 * E));
  const ccK = nudge(f32(f32(c * c) * K), jit(2 * E));
  const skipped = c > 0 && dG > ccK;
  if (!skipped) return { skipped, contributes: false };
  // three's getPointLightInfo on the same lVector (independently perturbed ops), both laws
  let any = false;
  for (let t = 0; t < 4 && !any; t++) {
    const d = nudge(f32(Math.sqrt(nudge(dot3(Lv, Lv), jit(2 * E)))), jit(4 * E));
    const r = nudge(f32(d / c), jit(4 * E)); // div or d * rcp(c)
    // retail light clamp (materials.js): saturate( 1 - d / c )
    const lin = sat(f32(1 - r));
    // three stock: 1 / max( pow( d, decay ), 0.01 ) * pow2( saturate( 1 - pow4( d / c ) ) )
    const pw = nudge(f32(Math.pow(d, light.decay)), jit(8 * E));
    const fall = f32(1 / Math.max(pw, 0.01));
    const r2 = f32(r * r), r4 = f32(r2 * r2);
    const w = sat(f32(1 - r4));
    const stockAtt = f32(fall * f32(w * w));
    // colour * spot cone (smoothstep in [0,1]) * attenuation
    const spotAtt = rnd();
    for (const att of [lin, stockAtt]) {
      const col = f32(f32(light.col * spotAtt) * att);
      if (col !== 0) any = true;
    }
  }
  return { skipped, contributes: any };
}
function sweep(K, n, E) {
  let skipped = 0, bad = 0, near = 0, worst = Infinity;
  for (let i = 0; i < n; i++) {
    const kind = rnd();
    let light;
    // parked pool slot (lighting.js parkPoolSlot: y = -1e5, cutoff 1). Its uploaded colour is 0, but
    // give it colour 1 here: the proof must not lean on the colour.
    if (kind < 0.1) light = { p: [f32(rnd() * 200 - 100), -1e5, f32(rnd() * 200 - 100)], c: 1, decay: 2, col: 1 };
    else if (kind < 0.85) light = { p: [f32(rnd() * 4000 - 2000), f32(rnd() * 200 - 50), f32(rnd() * 4000 - 2000)], c: f32(1.3 + rnd() * 18.2), decay: 2, col: f32(0.05 + rnd() * 8) };
    else light = { p: [f32(rnd() * 400 - 200), f32(rnd() * 100), f32(rnd() * 400 - 200)], c: f32(1 + rnd() * 999), decay: rnd() < 0.5 ? 2 : f32(rnd() * 3), col: f32(rnd() * 100) };
    // a direction and a radius straddling the sphere: mostly within +-3e-5 relative, some far
    const u = rnd() * 2 - 1, th = rnd() * Math.PI * 2, s = Math.sqrt(1 - u * u);
    const dir = [s * Math.cos(th), u, s * Math.sin(th)];
    const rel = rnd() < 0.8 ? 1 + (rnd() * 2 - 1) * 3e-5 : rnd() * 3;
    const R = light.c * rel;
    const g = [f32(light.p[0] - dir[0] * R), f32(light.p[1] - dir[1] * R), f32(light.p[2] - dir[2] * R)];
    const r = sample(K, light, g, E);
    if (Math.abs(rel - 1) < 3e-5) near++;
    if (r.skipped) {
      skipped++;
      if (r.contributes) bad++;
      else worst = Math.min(worst, rel - 1);
    }
  }
  return { skipped, bad, near, worst };
}
const K = f32(Number(MARGIN));
const N = 1300000;
const t0 = Date.now();
const res = sweep(K, N, 1);
check(`margin ${MARGIN}: no skipped sample would have contributed (stock + linear law, ulp-perturbed)`,
  res.bad === 0 && res.skipped > N * 0.3 && res.near > N * 0.5,
  `${N} samples, ${res.near} within 3e-5 of the sphere, ${res.skipped} skipped, ${res.bad} contributing; ${Date.now() - t0} ms`);
const res2 = sweep(K, 300000, 2);
check(`margin ${MARGIN}: still exact with doubled op error (dot/mul +-4, sqrt/div +-8, pow +-16 ulps)`, res2.bad === 0 && res2.skipped > 0, `${res2.skipped} skipped, ${res2.bad} contributing`);
const neg = sweep(f32(1), 300000, 1);
check("negative control: margin 1.0 DOES skip contributing samples (the model can see a bad margin)", neg.bad > 0, `${neg.bad} contributing of ${neg.skipped} skipped`);

// (c) zero colour through every three RE_Direct variant + the retail clamp wrapper
{
  const RECIPROCAL_PI = f32(1 / Math.PI);
  const add3 = (a, b) => a.map((x, i) => f32(x + b[i]));
  const sub3 = (a, b) => a.map((x, i) => f32(x - b[i]));
  const mulS = (a, s) => a.map((x) => f32(x * s));
  const mul3 = (a, b) => a.map((x, i) => f32(x * b[i]));
  const min3 = (a, b) => a.map((x, i) => Math.min(x, b[i]));
  const mix3 = (a, b, t) => a.map((x, i) => f32(f32(x * f32(1 - t)) + f32(b[i] * t))); // GLSL x*(1-a)+y*a
  const same = (a, b) => a.every((x, i) => Object.is(x, b[i]));
  // RE_Direct variants: irradiance = factor * color; accumulators += irradiance * (finite BRDF)
  const variants = {
    Physical: (st, col, nl) => { const irr = mulS(col, nl); st.spec = add3(st.spec, mul3(irr, st.ggx)); st.diff = add3(st.diff, mul3(irr, st.lam)); },
    Lambert: (st, col, nl) => { const irr = mulS(col, nl); st.diff = add3(st.diff, mul3(irr, st.lam)); },
    BlinnPhong: (st, col, nl) => { const irr = mulS(col, nl); st.diff = add3(st.diff, mul3(irr, st.lam)); st.spec = add3(st.spec, mulS(mul3(irr, st.ggx), st.strength)); },
    Toon: (st, col, _nl, grad) => { const irr = mul3(grad, col); st.diff = add3(st.diff, mul3(irr, st.lam)); },
  };
  const clampWrap = (run, st, col, ndl, albedo, t) => {
    const before = [st.diff, st.spec];
    run(st);
    let dd = sub3(st.diff, before[0]);
    const ds = sub3(st.spec, before[1]);
    const raw = sat(ndl), base = f32(f32(ndl * 0.5) + 0.5), wrapped = sat(f32(base * base));
    dd = raw > 1e-4 ? mulS(dd, f32(wrapped / raw)) : mul3(mulS(col, f32(wrapped * RECIPROCAL_PI)), albedo);
    st.diff = add3(before[0], mix3(dd, min3(dd, col), t));
    st.spec = add3(before[1], mix3(ds, min3(ds, col), t));
  };
  let ok = true, cases = 0;
  for (let i = 0; i < 20000; i++) {
    const v3 = (lo, hi) => [0, 1, 2].map(() => f32(lo + rnd() * (hi - lo)));
    const acc0 = rnd() < 0.2 ? [0, 0, 0] : v3(0, 4);
    const sp0 = rnd() < 0.2 ? [0, 0, 0] : v3(0, 4);
    const col = rnd() < 0.5 ? [0, 0, 0] : [-0, 0, -0];
    const ndl = f32(rnd() * 2 - 1);
    for (const [name, fn] of Object.entries(variants)) {
      for (const wrap of [false, true]) {
        const st = { diff: acc0.slice(), spec: sp0.slice(), ggx: v3(0, 50), lam: v3(0, 0.4), strength: f32(rnd()) };
        const run = (s) => fn(s, col, sat(ndl), v3(0, 1));
        if (wrap) clampWrap(run, st, col, ndl, v3(0, 1), f32(rnd())); else run(st);
        cases++;
        if (ok && (!same(st.diff, acc0) || !same(st.spec, sp0))) { ok = false; console.log("    first mismatch", name, wrap, st, acc0, sp0); }
      }
    }
  }
  check("zero colour: RE_Direct Physical / Lambert / BlinnPhong / Toon, bare and clamp-wrapped, leave the accumulators bitwise unchanged", ok, `${cases} cases`);
  // the directional gate, evaluated from the GLSL text
  const dm = on.text.match(/if \( (any\( notEqual\( directLight\.color, vec3\( 0\.0 \) \) \)) \) \{/);
  const any = (v) => v.some(Boolean), notEqual = (a, b) => a.map((x, i) => x !== b[i]), vec3 = (...a) => (a.length === 1 ? [a[0], a[0], a[0]] : a);
  const gate = dm && new Function("directLight", "any", "notEqual", "vec3", `return ${dm[1]};`);
  const runs = (c) => gate({ color: c }, any, notEqual, vec3);
  check("dir gate text: skips exactly the zero colours (+0 / -0), runs any non-zero or NaN channel",
    !!gate && !runs([0, 0, 0]) && !runs([-0, 0, -0]) && runs([1e-38, 0, 0]) && runs([0, 0, 1.4e-45]) && runs([NaN, 0, 0]) && runs([0.2, 0.3, 0.1]));
}

// (d) the probe gate + a zero SH, (e) the client's one probe: zero DC => all 9 zero
{
  const pm = on.text.match(/if \( (any\( notEqual\( lightProbe\[ 0 \], vec3\( 0\.0 \) \) \)) \) \{/);
  const any = (v) => v.some(Boolean), notEqual = (a, b) => a.map((x, i) => x !== b[i]), vec3 = (...a) => (a.length === 1 ? [a[0], a[0], a[0]] : a);
  const gate = pm && new Function("lightProbe", "any", "notEqual", "vec3", `return ${pm[1]};`);
  const zeros = () => Array.from({ length: 9 }, () => [0, 0, 0]);
  const probe = zeros(); probe[0] = [0, 1e-3, 0];
  check("probe gate text: zero DC skips, any non-zero DC channel runs", !!gate && !gate(zeros(), any, notEqual, vec3) && gate(probe, any, notEqual, vec3));
  // three shGetIrradianceAt on all-zero coefficients, float32, then irradiance += result
  const shEval = (c, n) => {
    const [x, y, z] = n;
    const terms = [f32(0.886227), f32(2 * 0.511664 * y), f32(2 * 0.511664 * z), f32(2 * 0.511664 * x),
      f32(2 * 0.429043 * x * y), f32(2 * 0.429043 * y * z), f32(0.743125 * z * z - 0.247708), f32(2 * 0.429043 * x * z), f32(0.429043 * (x * x - y * y))];
    let r = [0, 0, 0].map((_, k) => f32(c[0][k] * terms[0]));
    for (let j = 1; j < 9; j++) r = r.map((v, k) => f32(v + f32(c[j][k] * terms[j])));
    return r;
  };
  let ok = true;
  for (let i = 0; i < 20000; i++) {
    const u = rnd() * 2 - 1, th = rnd() * Math.PI * 2, s = Math.sqrt(1 - u * u);
    const n = [f32(s * Math.cos(th)), f32(u), f32(s * Math.sin(th))];
    const irr = rnd() < 0.3 ? [0, 0, 0] : [f32(rnd()), f32(rnd()), f32(rnd())];
    const c = zeros(); if (rnd() < 0.5) for (const v of c) for (let k = 0; k < 3; k++) if (rnd() < 0.5) v[k] = -0;
    const out = irr.map((v, k) => f32(v + shEval(c, n)[k]));
    if (!out.every((v, k) => Object.is(v, irr[k]))) ok = false;
  }
  check("zero SH (+-0 coefficients) adds exactly nothing to irradiance", ok);
  // vendor takram SkyLightProbe.update: h0 = s*fi, h1..3 = s*(Ee*n), h4..8 never written
  const vendor = readFileSync(path.join(APP, "vendor/takram/three-atmosphere.js"), "utf8");
  const shape = vendor.includes("var fi = 1 / Math.sqrt(Math.PI);") && vendor.includes("var Ee = Math.sqrt(3) / (2 * Math.sqrt(Math.PI));") &&
    vendor.includes("h2[0].copy(s).multiplyScalar(fi), h2[1].copy(s).multiplyScalar(Ee * l2.y), h2[2].copy(s).multiplyScalar(Ee * l2.z), h2[3].copy(s).multiplyScalar(Ee * l2.x);") &&
    !/h2\[[4-8]\]/.test(vendor);
  check("vendor SkyLightProbe still writes only coefficients 0..3, each the sky irradiance times a constant", shape);
  const fi = 1 / Math.sqrt(Math.PI), Ee = Math.sqrt(3) / (2 * Math.sqrt(Math.PI));
  let held = true, zeroDc = 0;
  const pick = () => { const k = rnd(); return k < 0.3 ? 0 : k < 0.5 ? rnd() * 1e-44 : k < 0.6 ? rnd() * 1e-38 : k < 0.7 ? rnd() * 1e-300 : rnd() * 10; };
  for (let i = 0; i < 200000; i++) {
    const sky = [pick(), pick(), pick()];
    const u = rnd() * 2 - 1, th = rnd() * Math.PI * 2, s = Math.sqrt(1 - u * u);
    const n = [s * Math.cos(th), u, s * Math.sin(th)];
    const h = Array.from({ length: 9 }, () => [0, 0, 0]);
    for (let k = 0; k < 3; k++) { h[0][k] = sky[k] * fi; h[1][k] = sky[k] * (Ee * n[1]); h[2][k] = sky[k] * (Ee * n[2]); h[3][k] = sky[k] * (Ee * n[0]); }
    const intensity = rnd() < 0.3 ? 0 : rnd() < 0.2 ? rnd() * 1e-30 : rnd() * 3;
    // three WebGLLights: state.probe[j] (reset to 0) .addScaledVector(coef, intensity); float32 upload
    const uni = h.map((v) => v.map((x) => f32(0 + x * intensity)));
    if (uni[0].every((x) => x === 0)) { zeroDc++; if (!uni.every((v) => v.every((x) => x === 0))) held = false; }
  }
  check("SkyLightProbe as uploaded: a zero DC uniform means all 9 coefficients are zero (incl. denormal skies / intensities)", held && zeroDc > 1000, `${zeroDc} zero-DC cases`);
}

console.log(`\n${passed} passed / ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
