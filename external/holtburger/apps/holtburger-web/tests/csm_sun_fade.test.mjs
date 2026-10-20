// tests/csm_sun_fade.test.mjs
//
// 2026-10-20 (improvement hunt shadows-restore-5) — the CSM shadow follows the
// time of day and shades the sun's direct term only.
//
// THE BUG. The cascades take the RAW authored sun (atmosphere_lights.js), whose
// pitch bottoms at 0.9 deg for the whole 23:02h -> 03:50h block, so every caster
// threw a ~64x-height streak at full strength all night; and the receivers'
// flat `mix(0.45, 1.0, s)` multiplied the FINAL colour (after emissive, IBL and
// fog_fragment), so lit windows and fogged distance went 55% dark in shade.
//
//   S  strength: lighting.js csmSunStrength IS cloud_night.js cloudDirectFactor
//      (sweep, ===); 0 for the whole night block through the art remap, 1 by day
//   C  csm.js: directOnly opt-in, shade defaults 1 / 0.55, clamps; uCsmStrength /
//      uCsmShade in the shared set; refreshCsmUniforms writes them (shared set +
//      a registered terrain-style receiver), NaN strength -> 1
//   L  lighting.js tick + gate (the bug trigger and the skip):
//      L1 flag readers (absent = on; off/0/false/no = off) and setupSceneLighting
//         plumbing (directOnly, ?csmShade)
//      L2 day: strength 1, rasters as before
//      L3 night: strength 0, uniform 0; 120 ticks of walking + a moving rig arm
//         NO cascade, rasterTicks frozen, fadedTicks counts; ?csmSunFade=off
//         (negative control) rasters the same scene; castShadow / light count
//         never move
//      L4 dawn: the first tick above 0 marks all 3 cascades FRUSTUM
//      L5 dusk: partial strength = the formula; raw-pitch fallback; no sky -> 1;
//         ?cloudShadowFadeDeg moves it
//      L6 ?shadowMoverScope=off (RP5 body): faded arms nothing, dawn arms
//   M  materials.js receiver on three r184's REAL standard shader:
//      M1 direct-only: main() is BYTE-IDENTICAL to stock (emissive, IBL, fog,
//         tone map untouched); the only factor is the incident colour of the
//         directional lights, through a wrapper declared after three's
//         getDirectionalLightInfo and before main(), redirected by a
//         FUNCTION-like macro defined after the wrapper; gone at 0 dir lights
//      M2 composes with the ?csmDeadLights chunk patch and a pre-expanded
//         lights_pars_begin (light clamp / clone order)
//      M3 legacy arm (direct callers): the whole-colour multiply, now
//         mix(1 - uCsmShade * uCsmStrength, 1, s) — float32 bit-identical to
//         mix(0.45, 1, s) at strength 1 / shade 0.55; an unlit shader under
//         direct-only falls back to it
//      M4 shared uniforms bound by identity; stub bundles get 1 / 0.55
//   T  terrain.js: every change inside #ifdef HB_TERRAIN_CSM(_DIRECT); the
//      default (no CSM) active code carries none of it; legacy arm = strength-
//      scaled whole multiply; direct arm = sun term of the retail Gouraud, the
//      whole multiply neutralised after the last glint / sparkle read; the
//      define keyed on csmState.directOnly
//   D  default path untouched: no csmState -> no hook text, key |c0, no
//      strength work, terrain defines without CSM
//
// Run: node tests/csm_sun_fade.test.mjs

import * as THREE from "three";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

globalThis.window = globalThis.window || {};
globalThis.location = { search: "" };
window.location = globalThis.location;

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CSM = await import("../scene3d/csm.js");
const L = await import("../scene3d/lighting.js");
const CN = await import("../scene3d/cloud_night.js");
const NR = await import("../scene3d/night_ramp.js");
const LL = await import("../scene3d/light_loops.js");
const { installCsmShaderPatch, MaterialCache, SURFACE_TYPE } = await import("../scene3d/materials.js");

let pass = 0, fail = 0;
function check(name, cond, extra = "") {
  if (cond) { pass += 1; console.log(`  [OK] ${name}`); }
  else { fail += 1; console.error(`  [FAIL] ${name}${extra ? ` — ${extra}` : ""}`); }
}
const SUN0 = { x: 60, y: 80, z: 30 };
const f32 = Math.fround;

// ============================================================================ S
console.log("\n-- S strength = cloud_night.js directFactor ---------------------");
{
  let same = true, worst = "";
  for (const fade of [0.1, 0.5, 2, 6, 12, 45]) {
    for (let p = -30; p <= 90; p += 0.25) {
      const a = L.csmSunStrength(p, fade);
      const b = CN.cloudDirectFactor(p, fade);
      if (a !== b) { same = false; worst = `${p}/${fade}: ${a} vs ${b}`; }
    }
  }
  check("S1 csmSunStrength === cloudDirectFactor over pitch -30..90 x fade 0.1..45", same, worst);
  check("S1 ...same defaults (fade 6, NaN pitch = 0)", L.csmSunStrength(3) === CN.cloudDirectFactor(3) && L.csmSunStrength(NaN) === 0);
  // The authored night block: 0.9 deg -> art -14 deg (night_ramp.js, flag on).
  const art = NR.artSunPitchDeg(0.9, true);
  check("S2 night block: art elevation -14 deg -> strength exactly 0", art === -14 && L.csmSunStrength(art) === 0, String(art));
  check("S2 ...day (authored 45 / 20 deg, above the knee) -> 1", L.csmSunStrength(NR.artSunPitchDeg(45, true)) === 1 && L.csmSunStrength(NR.artSunPitchDeg(20, true)) === 1);
  const raw = L.csmSunStrength(0.9);
  check("S2 ...the raw 0.9 deg sun (?nightRamp=off) keeps ~15%", Math.abs(raw - Math.sin(0.9 * Math.PI / 180) / Math.sin(6 * Math.PI / 180)) < 1e-12 && raw > 0.14 && raw < 0.16, String(raw));
}

// ============================================================================ C
console.log("\n-- C csm.js bundle ----------------------------------------------");
{
  const sDef = CSM.setupCsm(new THREE.Scene(), { sunDir: SUN0 });
  const sDir = CSM.setupCsm(new THREE.Scene(), { sunDir: SUN0, directOnly: true });
  const sTruthy = CSM.setupCsm(new THREE.Scene(), { sunDir: SUN0, directOnly: 1 });
  check("C1 default: legacy multiply, shade 0.55, strength 1", sDef.directOnly === false && sDef.shade === 0.55 && sDef.strength === 1 &&
    sDef.uniforms.uCsmShade.value === 0.55 && sDef.uniforms.uCsmStrength.value === 1);
  check("C1 only an explicit `directOnly: true` opts in; its shade defaults to 1", sDir.directOnly === true && sDir.shade === 1 &&
    sDir.uniforms.uCsmShade.value === 1 && sTruthy.directOnly === false);
  check("C1 constants", CSM.CSM_SHADE_LEGACY === 0.55 && CSM.CSM_SHADE_DIRECT === 1);
  const sK = CSM.setupCsm(new THREE.Scene(), { sunDir: SUN0, directOnly: true, shade: 0.3 });
  const sHi = CSM.setupCsm(new THREE.Scene(), { sunDir: SUN0, shade: 7 });
  const sNaN = CSM.setupCsm(new THREE.Scene(), { sunDir: SUN0, directOnly: true, shade: NaN });
  check("C1 explicit shade: used, clamped [0,1], NaN = mode default", sK.shade === 0.3 && sHi.shade === 1 && sNaN.shade === 1);

  // refreshCsmUniforms: shared set + a registered terrain-style receiver.
  const st = CSM.setupCsm(new THREE.Scene(), { sunDir: SUN0, directOnly: true });
  const terr = new THREE.ShaderMaterial({ uniforms: { uCsmStrength: { value: 1 }, uCsmShade: { value: 0.55 } } });
  terr.userData = { csmShaderUniforms: terr.uniforms };
  st.patchedMaterials.add(terr);
  const bare = new THREE.ShaderMaterial({ uniforms: { uCsmFar: { value: 0 } } });
  bare.userData = { csmShaderUniforms: bare.uniforms };
  st.patchedMaterials.add(bare);
  st.strength = 0.25;
  CSM.refreshCsmUniforms(st);
  check("C2 refresh writes strength + shade to the shared set", st.uniforms.uCsmStrength.value === 0.25 && st.uniforms.uCsmShade.value === 1);
  check("C2 ...and to a registered receiver that carries them", terr.uniforms.uCsmStrength.value === 0.25 && terr.uniforms.uCsmShade.value === 1);
  check("C2 ...a receiver without them is left alone", !("uCsmStrength" in bare.uniforms) && bare.uniforms.uCsmFar.value === 300);
  st.strength = NaN; CSM.refreshCsmUniforms(st);
  const nanOk = st.uniforms.uCsmStrength.value === 1;
  st.strength = -2; CSM.refreshCsmUniforms(st);
  const loOk = st.uniforms.uCsmStrength.value === 0;
  st.strength = 3; CSM.refreshCsmUniforms(st);
  check("C2 non-finite strength -> 1 (old full strength), clamped [0,1]", nanOk && loOk && st.uniforms.uCsmStrength.value === 1);
}

// ============================================================================ L
console.log("\n-- L lighting.js tick + gate ------------------------------------");
function session(search, cfg, sky = {}) {
  globalThis.location.search = search;
  L.__resetRp5ConfigForTest(cfg);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(53.6, 16 / 9, 0.1, 5000);
  camera.position.set(0, 5, 0);
  scene.add(camera);
  scene.updateMatrixWorld(true);
  const lighting = L.setupSceneLighting(scene, { csm: true });
  const shadowMap = { enabled: true, autoUpdate: true, needsUpdate: false, type: THREE.PCFShadowMap };
  const rig = new THREE.Object3D();
  rig.position.set(3, 0, -6);
  scene.add(rig);
  const scene3d = { renderer: { shadowMap }, lighting, camera, scene, entityManager: { entityMap: new Map([[0x50000001, { root: rig }]]) } };
  if (sky.art !== undefined) scene3d.atmosphereSky = { _artPitchDeg: sky.art };
  if (sky.raw !== undefined) scene3d.skyLightingController = { _lastState: { dirPitch: sky.raw } };
  const lights = lighting.csmState.lights;
  function tick() {
    L.tickLightingForCellState(scene3d, null);
    const out = lights.map((l) => (l.shadow.needsUpdate ? (l.userData.hbShadowReason | 0) || 8 : 0));
    const any = shadowMap.needsUpdate === true;
    for (const l of lights) { l.shadow.needsUpdate = false; l.userData.hbShadowReason = 0; }
    shadowMap.needsUpdate = false;
    out.any = any;
    return out;
  }
  return { scene, scene3d, lighting, camera, rig, lights, tick, shadowMap, cs: lighting.csmState };
}
const FR = 4;
{
  const read = (s) => { const S = session(s); return [S.cs.directOnly, S.cs.shade]; };
  check("L1 absent: directOnly on, shade 1", read("")[0] === true && read("")[1] === 1);
  check("L1 ?csmDirectOnly=off/0/false/no: legacy multiply, shade 0.55",
    ["off", "0", "false", "no", "OFF"].every((v) => { const r = read(`?csmDirectOnly=${v}`); return r[0] === false && r[1] === 0.55; }));
  check("L1 ?csmShade=0.3 / 2 / junk", read("?csmShade=0.3")[1] === 0.3 && read("?csmShade=2")[1] === 1 && read("?csmShade=abc")[1] === 1 &&
    read("?csmDirectOnly=off&csmShade=0.8")[1] === 0.8);
  const fadeOn = (s) => { globalThis.location.search = s; L.__resetRp5ConfigForTest(undefined); const S = session(s, undefined, { art: -14 }); S.tick(); return S.cs.strength === 0; };
  check("L1 ?csmSunFade absent = on; off/0/false/no = off", fadeOn("") && ["off", "0", "false", "no"].every((v) => !fadeOn(`?csmSunFade=${v}`)));
}
{
  const S = session("", undefined, { art: 45, raw: 45 });
  const w = S.tick();
  check("L2 day: strength 1, uniform 1", S.cs.strength === 1 && S.cs.uniforms.uCsmStrength.value === 1);
  check("L2 ...warm tick arms all 3 cascades FRUSTUM (unchanged)", w.every((r) => r & FR), w.join());
}
function nightRun(search) {
  const S = session(search, undefined, { art: -14, raw: 0.9 });
  S.tick(); // warm / take control
  const sc = S.scene3d._shadowScope.stats;
  const r0 = sc.rasterTicks, f0 = sc.fadedTicks | 0;
  let armed = 0, any = 0;
  const nLights0 = (() => { let n = 0; S.scene.traverse((o) => { if (o.isLight) n += 1; }); return n; })();
  for (let k = 1; k <= 120; k += 1) {
    S.camera.position.x += 1.5;              // walking: stable cascades refit
    S.camera.rotation.y = k * 0.05;          // and turning
    S.rig.position.x = 3 + 0.4 * k;          // a rig walking in view
    const r = S.tick();
    if (r.some((x) => x)) armed += 1;
    if (r.any) any += 1;
  }
  let nLights1 = 0; S.scene.traverse((o) => { if (o.isLight) nLights1 += 1; });
  return { S, sc, armed, any, rasters: sc.rasterTicks - r0, faded: (sc.fadedTicks | 0) - f0, nLights0, nLights1 };
}
{
  const N = nightRun("");
  check("L3 night: strength 0, uniform 0", N.S.cs.strength === 0 && N.S.cs.uniforms.uCsmStrength.value === 0);
  check("L3 ...120 ticks of walking + a moving rig arm NO cascade", N.armed === 0 && N.any === 0, `armed ${N.armed} any ${N.any}`);
  check("L3 ...rasterTicks frozen, fadedTicks counts every tick", N.rasters === 0 && N.faded === 120, `rasters ${N.rasters} faded ${N.faded}`);
  check("L3 ...the cascades still refit (fit stays current for dawn)", N.S.cs.stats.refits[0] > 10);
  check("L3 ...castShadow never toggled, scene light count constant", N.S.lights.every((l) => l.castShadow === true) && N.nLights0 === N.nLights1);
  const C = nightRun("?csmSunFade=off");
  check("L3 negative control ?csmSunFade=off: strength 1 at night, the same run rasters", C.S.cs.strength === 1 && C.armed > 100 && C.rasters > 100, `armed ${C.armed} rasters ${C.rasters}`);

  // L4 dawn: leave 0.
  const S = N.S;
  S.scene3d.atmosphereSky._artPitchDeg = 1.0;
  const d = S.tick();
  check("L4 dawn: strength > 0 marks all 3 cascades FRUSTUM on that tick", S.cs.strength > 0 && d.every((r) => r & FR), d.join());
  check("L4 ...and the uniform follows", S.cs.uniforms.uCsmStrength.value === S.cs.strength);
  const d2 = S.tick();
  check("L4 ...the next still tick is normal again (no forced full raster)", !d2.every((r) => r & FR) || S.cs.refitMask === 0b111, d2.join());
}
{
  const S = session("", undefined, { art: 3, raw: 13 });
  S.tick();
  check("L5 dusk (art 3 deg): strength = sin 3 / sin 6", Math.abs(S.cs.strength - Math.sin(3 * Math.PI / 180) / Math.sin(6 * Math.PI / 180)) < 1e-12, String(S.cs.strength));
  const R = session("", undefined, { raw: 0.9 });
  R.tick();
  check("L5 no atmosphere sky: falls back to the raw pitch", Math.abs(R.cs.strength - L.csmSunStrength(0.9)) < 1e-12, String(R.cs.strength));
  const Z = session("", undefined, {});
  Z.tick();
  check("L5 no sky state at all: full strength (1)", Z.cs.strength === 1);
  const F = session("?cloudShadowFadeDeg=12", undefined, { art: 6 });
  F.tick();
  check("L5 ?cloudShadowFadeDeg=12 moves the fade (sin 6 / sin 12)", Math.abs(F.cs.strength - Math.sin(6 * Math.PI / 180) / Math.sin(12 * Math.PI / 180)) < 1e-12, String(F.cs.strength));
}
{
  const S = session("", { shadowMoverScope: false }, { art: -14 });
  let any = 0;
  for (let k = 0; k < 30; k += 1) { S.camera.position.x += 6; S.rig.position.x += 0.5; if (S.tick().any) any += 1; }
  check("L6 ?shadowMoverScope=off (RP5 body): a faded sun arms nothing", any === 0, String(any));
  S.scene3d.atmosphereSky._artPitchDeg = 2;
  check("L6 ...dawn arms the raster", S.tick().any === true);
}
globalThis.location.search = "";
L.__resetRp5ConfigForTest(undefined);

// ============================================================================ M
console.log("\n-- M materials.js receiver (real r184 standard shader) -----------");
function resolveIncludes(s, chunks = {}) {
  return s.replace(/^[ \t]*#include +<([\w\d./]+)>/gm, (_m, name) => {
    const c = chunks[name] ?? THREE.ShaderChunk[name];
    if (c === undefined) throw new Error(`unknown chunk ${name}`);
    return resolveIncludes(c, chunks);
  });
}
function compile(mat, lib = THREE.ShaderLib.standard, fragmentShader = lib.fragmentShader) {
  const shader = { uniforms: THREE.UniformsUtils.clone(lib.uniforms), vertexShader: lib.vertexShader, fragmentShader, defines: {} };
  mat.onBeforeCompile(shader, null);
  return shader;
}
const mainOf = (s) => s.slice(s.indexOf("void main() {"));
// Tiny #if/#ifdef/#else/#endif evaluator for integer #if after light-count substitution.
function activeLines(src, defines = {}) {
  const out = [], stack = [];
  const on = () => stack.every((f) => f.active);
  const evalIf = (e) => {
    const x = e.replace(/defined\s*\(\s*(\w+)\s*\)/g, (_, n) => (n in defines ? "1" : "0")).replace(/\b[A-Za-z_]\w*\b/g, (id) => (id in defines ? String(defines[id] || 1) : "0"));
    return !!Function(`"use strict"; return (${x});`)();
  };
  for (const raw of src.split("\n")) {
    const t = raw.trim(); let m;
    if ((m = t.match(/^#\s*(ifdef|ifndef)\s+(\w+)/))) { const v = m[1] === "ifdef" ? m[2] in defines : !(m[2] in defines); stack.push({ active: on() && v, taken: v, pa: on() }); }
    else if ((m = t.match(/^#\s*if\s+(.*)$/))) { const pa = on(); const v = pa && evalIf(m[1]); stack.push({ active: v, taken: v, pa }); }
    else if ((m = t.match(/^#\s*elif\s+(.*)$/))) { const f = stack[stack.length - 1]; if (f.taken || !f.pa) f.active = false; else { f.active = evalIf(m[1]); f.taken = f.active; } }
    else if (/^#\s*else\b/.test(t)) { const f = stack[stack.length - 1]; f.active = f.pa && !f.taken; f.taken = true; }
    else if (/^#\s*endif\b/.test(t)) stack.pop();
    else if (on()) out.push(raw);
  }
  return out.join("\n");
}
{
  const stDir = CSM.setupCsm(new THREE.Scene(), { sunDir: SUN0, directOnly: true });
  const stock = compile(new THREE.MeshStandardMaterial());
  const m = new THREE.MeshStandardMaterial({ emissive: 0xffaa00 });
  installCsmShaderPatch(m, stDir);
  const sh = compile(m);
  const fs = sh.fragmentShader;
  check("M1 direct-only: main() is byte-identical to the stock main() (emissive / IBL / fog / tone map untouched)",
    mainOf(fs) === mainOf(stock.fragmentShader));
  check("M1 ...no whole-colour multiply anywhere", !fs.includes("_csmAtten") && !/gl_FragColor\.rgb \*=/.test(fs));
  const full = resolveIncludes(fs);
  const iThree = full.indexOf("void getDirectionalLightInfo(");
  const iWrap = full.indexOf("void _hbCsmDirLightInfo(");
  const iInner = full.indexOf("getDirectionalLightInfo( directionalLight, light );", iWrap);
  const iDef = full.indexOf("#define getDirectionalLightInfo(dl, il) _hbCsmDirLightInfo(dl, il)");
  const iMain = full.indexOf("void main() {");
  const iCall = full.indexOf("getDirectionalLightInfo( directionalLight, directLight );", iMain);
  check("M1 order: three's function < wrapper < wrapper's call to it < #define < main() < the loop call",
    iThree > 0 && iThree < iWrap && iWrap < iInner && iInner < iDef && iDef < iMain && iMain < iCall,
    [iThree, iWrap, iInner, iDef, iMain, iCall].join());
  check("M1 ...the macro is FUNCTION-like (no space before its parameter list)", /#define getDirectionalLightInfo\(dl, il\) /.test(full) && !/#define getDirectionalLightInfo \(/.test(full));
  check("M1 ...the only shading op is the incident colour: light.color *= _hbCsmSun",
    (full.match(/_hbCsmSun/g) || []).length === 5 && full.includes("light.color *= _hbCsmSun;") &&
    full.includes("_hbCsmSun = mix( 1.0 - uCsmShade * uCsmStrength, 1.0, _csmShadowFactor( vCsmWorldPos, vCsmViewDepth ) );"));
  check("M1 ...strength 0 skips the taps", /if \( uCsmStrength > 0\.0 \) \{\s*_hbCsmSun = mix/.test(full));
  const at = (n) => activeLines(full.replace(/NUM_DIR_LIGHTS/g, String(n)).replace(/NUM_[A-Z_]+/g, "0"), {});
  check("M1 ...compiled in with directional lights, absent with none (DirectionalLight undeclared there)",
    at(4).includes("void _hbCsmDirLightInfo(") && at(4).includes("struct DirectionalLight") &&
    !at(0).includes("_hbCsmDirLightInfo") && !at(0).includes("struct DirectionalLight"));
  check("M1 ...the uniforms are declared before the wrapper", full.indexOf("uniform float uCsmStrength;") < iWrap && full.indexOf("uniform float uCsmShade;") < iWrap);

  // M2 — ?csmDeadLights chunk + a pre-expanded lights_pars_begin.
  // setupCsm already ran installCsmDeadLights on THREE.ShaderChunk (light_loops.js is
  // loaded here, so its global hook exists); patch a stock copy otherwise.
  const cur = THREE.ShaderChunk.lights_fragment_begin;
  const deadText = cur.includes("__hbCsmDeadLights") ? cur : LL.patchCsmDeadLightsChunk(cur, 3).text;
  const fullDead = resolveIncludes(fs, { lights_fragment_begin: deadText });
  check("M2 with the ?csmDeadLights chunk: the loop call survives once, after the #define", deadText.includes("__hbCsmDeadLights") &&
    (fullDead.match(/getDirectionalLightInfo\( directionalLight, directLight \);/g) || []).length === 1 &&
    fullDead.indexOf("getDirectionalLightInfo( directionalLight, directLight );") > fullDead.indexOf("#define getDirectionalLightInfo(dl, il)"));
  const preExpanded = THREE.ShaderLib.standard.fragmentShader.replace("#include <lights_pars_begin>", THREE.ShaderChunk.lights_pars_begin);
  const m2 = new THREE.MeshStandardMaterial();
  installCsmShaderPatch(m2, stDir);
  const sh2 = compile(m2, THREE.ShaderLib.standard, preExpanded);
  check("M2 lights_pars_begin already expanded (light clamp ran first): still the sun hook", sh2.fragmentShader.includes("void _hbCsmDirLightInfo(") && !sh2.fragmentShader.includes("_csmAtten"));

  // M3 — legacy arm.
  const stLeg = CSM.setupCsm(new THREE.Scene(), { sunDir: SUN0 });
  const ml = new THREE.MeshStandardMaterial();
  installCsmShaderPatch(ml, stLeg);
  const shl = compile(ml);
  check("M3 legacy (direct callers / =off): whole-colour multiply before dithering, strength-scaled, taps skipped at 0",
    !shl.fragmentShader.includes("_hbCsmDirLightInfo") &&
    /if \(uCsmStrength > 0\.0\) \{[\s\S]*?_csmAtten = mix\(1\.0 - uCsmShade \* uCsmStrength, 1\.0, _csmShadow\);[\s\S]*?gl_FragColor\.rgb \*= _csmAtten;[\s\S]*?#include <dithering_fragment>/.test(shl.fragmentShader));
  // Bit identity of the floor: GLSL float32. 0.55f * 1 is exact; 1 - 0.55f is exact (Sterbenz).
  const floorNew = f32(1 - f32(f32(0.55) * f32(1)));
  let mixSame = floorNew === f32(0.45);
  for (let i = 0; i <= 1000 && mixSame; i += 1) {
    const s = f32(i / 1000);
    const mixF = (a, b, t) => f32(f32(a * f32(1 - t)) + f32(b * t));
    if (mixF(floorNew, 1, s) !== mixF(f32(0.45), 1, s)) mixSame = false;
  }
  check("M3 ...at strength 1 / shade 0.55 the floor is float32 0.45 exactly, every mix identical", mixSame, String(floorNew));
  const mb = new THREE.MeshBasicMaterial();
  installCsmShaderPatch(mb, stDir);
  const shb = compile(mb, THREE.ShaderLib.basic);
  check("M3 unlit shader under direct-only: no wrapper (no DirectionalLight), whole-colour multiply instead",
    !shb.fragmentShader.includes("_hbCsmDirLightInfo") && shb.fragmentShader.includes("gl_FragColor.rgb *= _csmAtten;"));

  // M4 — uniforms.
  check("M4 shared uCsmStrength / uCsmShade bound by identity", sh.uniforms.uCsmStrength === stDir.uniforms.uCsmStrength && sh.uniforms.uCsmShade === stDir.uniforms.uCsmShade);
  const stub = { uniforms: Object.fromEntries(["uCsmShadowMap0", "uCsmShadowMap1", "uCsmShadowMap2", "uCsmMatrix0", "uCsmMatrix1", "uCsmMatrix2", "uCsmSplits", "uCsmFar", "uCsmBlend"].map((k) => [k, { value: null }])) };
  const ms = new THREE.MeshStandardMaterial();
  installCsmShaderPatch(ms, stub);
  const shs = compile(ms);
  check("M4 a stub bundle without them: strength 1, shade 0.55, legacy arm (pre-change maths)",
    shs.uniforms.uCsmStrength.value === 1 && shs.uniforms.uCsmShade.value === 0.55 && shs.fragmentShader.includes("_csmAtten"));
  check("M4 program key unchanged: |c2 on both arms", m.customProgramCacheKey().includes("|c2|") && ml.customProgramCacheKey().includes("|c2|"));
}

// ============================================================================ T
console.log("\n-- T terrain.js -------------------------------------------------");
const TSRC = readFileSync(resolve(ROOT, "scene3d/terrain.js"), "utf8");
{
  const lines = TSRC.split("\n");
  const i0 = lines.indexOf("const TERRAIN_FRAGMENT_GLSL = `");
  let j = i0 + 1;
  while (j < lines.length && lines[j] !== "`;") j += 1;
  const FRAG = lines.slice(i0 + 1, j).join("\n");
  check("T0 no backticks in the terrain fragment GLSL", !FRAG.includes("`"));
  const u0 = FRAG.indexOf("#ifdef HB_TERRAIN_CSM\nuniform float uCsmEnabled;");
  const u1 = FRAG.indexOf("#endif  // HB_TERRAIN_CSM", u0);
  const decl = FRAG.slice(u0, u1);
  check("T1 uCsmStrength / uCsmShade declared once, inside the HB_TERRAIN_CSM block",
    decl.includes("uniform float uCsmStrength;") && decl.includes("uniform float uCsmShade;") &&
    (FRAG.match(/uniform float uCsmStrength;/g) || []).length === 1 && (FRAG.match(/uniform float uCsmShade;/g) || []).length === 1);
  const r0 = FRAG.indexOf("float cloudShadow = 1.0;");
  const r1 = FRAG.indexOf("fragColor = vec4(terrainApplyFog(");
  const REGION = FRAG.slice(r0, r1);
  const strip = (s) => s.replace(/\/\/[^\n]*/g, "");
  const def = strip(activeLines(REGION, {}));
  const leg = strip(activeLines(REGION, { HB_TERRAIN_CSM: "" }));
  const dir = strip(activeLines(REGION, { HB_TERRAIN_CSM: "", HB_TERRAIN_CSM_DIRECT: "" }));
  check("T2 default (no CSM): none of it is active — csmShadow stays 1.0, Gouraud reads uAcSunColor",
    !/uCsmStrength|uCsmShade|csmSun\b|csmShadowFactor/.test(def) && (def.match(/csmShadow = /g) || []).length === 1 &&
    /terrainAcGouraud\(modulated, acShadeN, uAcSunVec,\s*uAcSunColor,\s*uAcAmbColor, uAcAmbLevel\);/.test(def));
  check("T3 legacy CSM: strength-scaled whole multiply, taps skipped at 0, Gouraud untouched",
    /if \(uCsmEnabled > 0\.5 && uCsmStrength > 0\.0\) \{\s*float s = csmShadowFactor\(vWorldPos, vViewDepth\);\s*csmShadow = mix\(1\.0 - uCsmShade \* uCsmStrength, 1\.0, s\);\s*\}/.test(leg) &&
    /uAcSunVec,\s*uAcSunColor,\s*uAcAmbColor/.test(leg) && !/csmSun\b/.test(leg) && (leg.match(/csmShadow = /g) || []).length === 2);
  check("T4 direct CSM: the sun term of the retail Gouraud carries csmSun (at uCsmShade)",
    /csmSun = mix\(1\.0 - uCsmShade \* uCsmStrength, 1\.0, s\);/.test(dir) &&
    /terrainAcGouraud\(modulated, acShadeN, uAcSunVec,\s*uAcSunColor \* csmSun,\s*uAcAmbColor, uAcAmbLevel\);/.test(dir));
  check("T4 ...csmShadow keeps the legacy 0.45-floor shape for the glint / sparkles",
    /csmShadow = mix\(1\.0 - 0\.55 \* uCsmStrength, 1\.0, s\);/.test(dir));
  const iFold = dir.indexOf("sandSparkle *= csmShadow;");
  const iNeut = dir.indexOf("csmShadow = 1.0;", iFold);
  const lastRead = Math.max(dir.lastIndexOf("* cloudShadow * csmShadow;", iFold), dir.indexOf("clamp((csmShadow - 0.45) / 0.55, 0.0, 1.0)"));
  const iLit = dir.indexOf("vec3 terrainLit = terrainApplyLight(modulated, ndotl, cloudShadow, csmShadow)");
  check("T4 ...the whole multiply is neutralised under acGouraud AFTER the glint + snow sparkle reads and BEFORE terrainLit; the sand sparkle keeps its factor",
    iFold > 0 && iNeut > iFold && lastRead > 0 && lastRead < iFold && iNeut < iLit &&
    /if \(acGouraud\) \{\s*sandSparkle \*= csmShadow;\s*csmShadow = 1\.0;\s*\}/.test(dir));
  check("T4 ...the terrainLit statement text is unchanged (shared tail)", iLit > 0 && leg.includes("vec3 terrainLit = terrainApplyLight(modulated, ndotl, cloudShadow, csmShadow)"));
  check("T5 the define is keyed on csmState.directOnly, next to HB_TERRAIN_CSM",
    TSRC.includes('...(scene3d?.csmState?.directOnly === true ? { HB_TERRAIN_CSM_DIRECT: "" } : {}),') &&
    (TSRC.match(/HB_TERRAIN_CSM:/g) || []).length === 1);
  check("T5 ...uniform values seeded from csmState (strength / shade), defaults 1 / 0.55",
    /uCsmStrength: \{\s*value: Number\.isFinite\(scene3d\?\.csmState\?\.strength\) \? scene3d\.csmState\.strength : 1,/.test(TSRC) &&
    /uCsmShade: \{\s*value: Number\.isFinite\(scene3d\?\.csmState\?\.shade\) \? scene3d\.csmState\.shade : 0\.55,/.test(TSRC));
  // Model of the direct arm vs legacy (shade 1 vs 0.55), full shadow, bright day:
  const gouraud = (sun, L_, amb) => Math.min(1, sun * L_ + amb);
  const lit = gouraud(0.8, 1, 0.5), legacyShade = 0.45 * lit, directShade = gouraud(0.8 * 0, 1, 0.5);
  check("T6 model: full shadow keeps the ambient exactly (direct arm), the legacy multiply also halved it",
    directShade === 0.5 && Math.abs(legacyShade - 0.45) < 1e-12);
}

// ============================================================================ D
console.log("\n-- D default path untouched -------------------------------------");
{
  globalThis.location.search = "";
  L.__resetRp5ConfigForTest(undefined);
  const scene = new THREE.Scene();
  const lighting = L.setupSceneLighting(scene, {});
  const camera = new THREE.PerspectiveCamera(53.6, 16 / 9, 0.1, 5000);
  const scene3d = { renderer: { shadowMap: { enabled: false, autoUpdate: true, needsUpdate: false } }, lighting, camera, scene, atmosphereSky: { _artPitchDeg: -14 } };
  let threw = null;
  try { for (let k = 0; k < 5; k += 1) L.tickLightingForCellState(scene3d, null); } catch (e) { threw = e; }
  check("D1 no CSM: no csmState, the tick runs, no shadow gate state", lighting.csmState === null && !threw && scene3d._shadowScope === undefined, String(threw));
  const tex = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  tex.needsUpdate = true;
  const cache = new MaterialCache({});
  const m = cache._materialFromFlags(SURFACE_TYPE.Base1Image, tex, undefined);
  const sh = compile(m);
  check("D2 no csmState: the MaterialCache material carries no CSM hook, no new uniform, key |c0",
    // (not /_hbCsm/: the light clamp expands the global lights_fragment_begin, which
    // setupCsm above already marked `__hbCsmDeadLights` — count-keyed, inert here.)
    m.userData?.csmEnabled !== true && !/uCsm|_hbCsmDir|_hbCsmSun|_csmAtten|vCsmWorldPos/.test(sh.fragmentShader + sh.vertexShader) &&
    m.customProgramCacheKey().includes("|c0|"), m.customProgramCacheKey());
  // The same builder WITH a direct-only bundle reaches the sun hook (integration).
  const stDir = CSM.setupCsm(new THREE.Scene(), { sunDir: SUN0, directOnly: true });
  const cacheDir = new MaterialCache({ csmState: stDir });
  const md = cacheDir._materialFromFlags(SURFACE_TYPE.Base1Image, tex, undefined);
  const shd = compile(md);
  check("D2 ...with a direct-only csmState the same builder compiles the sun hook (and no whole-colour multiply)",
    md.userData?.csmEnabled === true && shd.fragmentShader.includes("void _hbCsmDirLightInfo(") && !shd.fragmentShader.includes("_csmAtten"));
  const tdef = TSRC.slice(TSRC.indexOf("    defines: {\n      ...(scene3d?.csmState ? { HB_TERRAIN_CSM"), TSRC.indexOf("    },", TSRC.indexOf("    defines: {\n      ...(scene3d?.csmState ? { HB_TERRAIN_CSM")));
  check("D3 terrain without csmState: neither CSM define (both keyed on scene3d.csmState)",
    tdef.includes('...(scene3d?.csmState ? { HB_TERRAIN_CSM: "" } : {}),') && tdef.includes("scene3d?.csmState?.directOnly === true ? { HB_TERRAIN_CSM_DIRECT"));
}

console.log(`\ncsm_sun_fade: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
