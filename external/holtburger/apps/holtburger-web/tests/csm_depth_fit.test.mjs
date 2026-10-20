// tests/csm_depth_fit.test.mjs
//
// 2026-10-20 (improvement hunt shadows-restore-7) — per-cascade depth range and
// a texel-scaled receiver bias (`setupCsm(…, { depthFit: true })`, lighting.js
// `?csmBias`, DEFAULT ON under ?csm, `=legacy` escape; csm.js header "DEPTH FIT
// + TEXEL BIAS").
//
// THE BUGS. (1) Every cascade's light sat 200 m sunward of its centre with
// far = 400 m + radius, so the far cascade's sphere (radius ~328 m) reached in
// front of the near plane: casters in its sun-side cap were never rastered and
// receivers there read lit. (2) The receivers' fixed `bias = 0.0007` of [0, 1]
// depth is 0.30 / 0.36 / 0.51 m along the light over those ranges: ground
// within that distance of its occluder read lit (a ~0.26 m lit seam behind
// every wall base at a 30 deg sun, detached feet).
//
//   D1  opt-in: only `depthFit: true`; biasTexels default 2, clamped 0.25..16
//   D2  csmBackDistance: max(200, radius + min(400, 50 / sin e))
//   D3  legacy (no depthFit): light 200 m back, far = 400 + radius, uniforms =
//       plain copies of shadow.matrix — the old behaviour
//   D4  depthFit, stable and view-slice fits: back / far per cascade from the
//       sphere and the sun; near 0.1; turning the camera still refits nothing
//   D5  the far cascade's sun-side cap: a receiver there and a caster 20 m
//       sunward of it are inside the depth range (legacy: in front of the near
//       plane — the bug trigger)
//   D6  the folded bias, conventional AND reversed cascade cameras: for random
//       points in each sphere, the receiver's reference with the folded
//       matrix and its fixed 0.0007 == the raw depth of the point moved exactly
//       biasM metres toward the light (both receiver classes)
//   D7  bias values: ground k·texel, casters 2k·texel, each capped at the old
//       metres; ?csmBiasTexels scales it
//   D8  the lit seam behind a wall (CPU compare on the real matrices, 30 deg
//       sun): legacy ~0.26 m; ground 2 texels ~0.06 m; casters ~0.12 m
//   D9  receiver classes in refreshCsmUniforms: the shared set = casters, a
//       registered terrain ShaderMaterial = ground, a registered materials.js
//       receiver (userData.csmEnabled) = casters, a material binding the shared
//       matrix objects by identity is never overwritten with the ground fold;
//       no map yet ⇒ plain copy (unfoldable)
//   D10 the receivers' constant is the one the fold assumes (materials.js and
//       terrain.js `float bias = 0.0007;`, once each)
//   D11 lighting.js: `?csmBias` absent ⇒ depthFit on; legacy/off/0/false/no ⇒
//       off; ?csmBiasTexels plumbs through (garbage ⇒ default)
//
// Run:  cd apps/holtburger-web && node tests/csm_depth_fit.test.mjs

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

let pass = 0, fail = 0;
function check(name, cond, extra = "") {
  if (cond) { pass += 1; console.log(`  [OK] ${name}`); }
  else { fail += 1; console.error(`  [FAIL] ${name}${extra ? ` — ${extra}` : ""}`); }
}
const near = (a, b, eps) => Math.abs(a - b) <= eps;

// Deterministic RNG (mulberry32).
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

const RETAIL_V_FOV = 53.6;
// A 30 deg sun (sin 0.5) from +x, a little south.
const SUN30 = { x: Math.cos(Math.PI / 6) * 0.98, y: 0.5, z: Math.cos(Math.PI / 6) * 0.2 };
function mkCam() {
  const c = new THREE.PerspectiveCamera(RETAIL_V_FOV, 16 / 9, 0.1, 5000);
  c.position.set(32448, 40, -34560);
  c.lookAt(32448 + 10, 38, -34560 - 50);
  c.updateMatrixWorld();
  c.updateProjectionMatrix();
  return c;
}
const unit = (s) => { const l = Math.hypot(s.x, s.y, s.z); return new THREE.Vector3(s.x / l, s.y / l, s.z / l); };
const dist = (a, b) => a.distanceTo(b);
const zOf = (m, p) => new THREE.Vector3(p.x, p.y, p.z).applyMatrix4(m).z;
// three r184 computes shadow.matrix inside its shadow render (LightShadow.updateMatrices);
// do it here, optionally on a reversed cascade camera (WebGLShadowMap sets _reversedDepth).
function rasterMatrices(state, reversed = false) {
  for (const l of state.lights) {
    l.shadow.camera._reversedDepth = reversed;
    l.shadow.camera.updateProjectionMatrix();
    l.updateMatrixWorld();
    l.target.updateMatrixWorld();
    l.shadow.updateMatrices(l);
    if (!l.shadow.map) l.shadow.map = { depthTexture: null }; // "rastered once"
  }
}

// ============================================================================ D1
console.log("\n-- D1 opt-in ------------------------------------------------------");
{
  const sDef = CSM.setupCsm(new THREE.Scene(), { sunDir: SUN30 });
  const sOn = CSM.setupCsm(new THREE.Scene(), { sunDir: SUN30, depthFit: true });
  const sTruthy = CSM.setupCsm(new THREE.Scene(), { sunDir: SUN30, depthFit: 1 });
  check("D1 setupCsm default = fixed range + bias", sDef.depthFit === false && sOn.depthFit === true && sTruthy.depthFit === false);
  check("D1 biasTexels default 2", sOn.biasTexels === 2 && CSM.DEFAULT_CSM_BIAS_TEXELS === 2);
  const lo = CSM.setupCsm(new THREE.Scene(), { depthFit: true, biasTexels: 0.01 });
  const hi = CSM.setupCsm(new THREE.Scene(), { depthFit: true, biasTexels: 99 });
  const nan = CSM.setupCsm(new THREE.Scene(), { depthFit: true, biasTexels: NaN });
  check("D1 biasTexels clamps 0.25..16, NaN ⇒ default", lo.biasTexels === 0.25 && hi.biasTexels === 16 && nan.biasTexels === 2);
  check("D1 receiver constant exported", CSM.CSM_RECEIVER_BIAS === 0.0007);
}

// ============================================================================ D2
console.log("\n-- D2 csmBackDistance ---------------------------------------------");
{
  const B = CSM.csmBackDistance;
  check("D2 near cascade at 30 deg keeps the 200 m lead-in", B(35, 0.5) === 200);
  check("D2 far cascade at 30 deg: radius + 50/sin e = 428", near(B(328, 0.5), 428, 1e-9), String(B(328, 0.5)));
  check("D2 lead capped at 400 m (low sun)", near(B(328, Math.sin(3 * Math.PI / 180)), 728, 1e-9));
  check("D2 zenith: radius + 50", near(B(328, 1), 378, 1e-9) && B(110, 1) === 200);
  check("D2 below the horizon / NaN: the cap, never NaN", B(328, -0.2) === 728 && B(328, NaN) === 728);
}

// ============================================================================ D3
console.log("\n-- D3 legacy is the old behaviour ---------------------------------");
{
  const st = CSM.setupCsm(new THREE.Scene(), { sunDir: SUN30, stable: true });
  CSM.updateCsm(st, mkCam(), SUN30);
  let ok = true;
  const detail = [];
  st.lights.forEach((l, i) => {
    const c = l.shadow.camera;
    const r = c.right;
    const back = dist(l.position, l.target.position);
    detail.push(`c${i} back=${back.toFixed(3)} far=${c.far}`);
    if (!near(back, 200, 1e-6) || c.far !== 200 * 2 + r || c.near !== 0.1) ok = false;
  });
  check("D3 legacy: light 200 m back, far = 400 + radius, near 0.1", ok, detail.join(" "));
  rasterMatrices(st);
  CSM.refreshCsmUniforms(st);
  check("D3 legacy: shared uCsmMatrix = shadow.matrix copies",
    [0, 1, 2].every((i) => st.uniforms[`uCsmMatrix${i}`].value.equals(st.lights[i].shadow.matrix)));
  check("D3 legacy: no fold work", st._biasFold === null && st.bias.folds === 0);
}

// ============================================================================ D4
console.log("\n-- D4 depthFit back / far -----------------------------------------");
for (const stable of [true, false]) {
  const st = CSM.setupCsm(new THREE.Scene(), { sunDir: SUN30, stable, depthFit: true });
  const cam = mkCam();
  CSM.updateCsm(st, cam, SUN30);
  const ly = unit(SUN30).y;
  let ok = true;
  const detail = [];
  st.lights.forEach((l, i) => {
    const c = l.shadow.camera;
    const r = c.right;
    const back = dist(l.position, l.target.position);
    const want = CSM.csmBackDistance(r, ly);
    detail.push(`c${i} r=${r.toFixed(1)} back=${back.toFixed(2)} far=${c.far.toFixed(2)}`);
    if (!near(back, want, 1e-6) || !near(c.far, want + r + 2, 1e-9) || c.near !== 0.1) ok = false;
  });
  check(`D4 ${stable ? "stable" : "view-slice"}: back = csmBackDistance(radius, sin e), far = back + radius + 2`, ok, detail.join(" "));
  // At a 30 deg sun the lead is 50 / 0.5 = 100 m: c0 (r ~35) keeps the 200 m
  // floor, c1 (r ~110) and c2 (r ~328) sit at radius + 100.
  const backs = st.lights.map((l) => dist(l.position, l.target.position));
  const radii = st.lights.map((l) => l.shadow.camera.right);
  check(`D4 ${stable ? "stable" : "view-slice"}: c0 keeps the 200 m lead-in; c1 / c2 sit radius + 100 m back`,
    near(backs[0], 200, 1e-6) && near(backs[1], radii[1] + 100, 0.05) && near(backs[2], radii[2] + 100, 0.05),
    backs.map((b) => b.toFixed(2)).join(" "));
  check(`D4 ${stable ? "stable" : "view-slice"}: c0 / c1 ranges shrink by the dead space behind the sphere`,
    st.lights[0].shadow.camera.far < 400 + radii[0] - 150 && st.lights[1].shadow.camera.far < 400 + radii[1] - 150);
  if (stable) {
    const snap = () => st.lights.map((l) => [l.position.toArray(), l.shadow.camera.far].join()).join("|");
    const before = snap();
    let refits = 0;
    for (let k = 0; k < 24; k += 1) {
      cam.rotation.y += Math.PI / 12;
      cam.updateMatrixWorld();
      CSM.updateCsm(st, cam, SUN30);
      if (st.refitMask) refits += 1;
    }
    check("D4 stable + depthFit: a full turn in place refits nothing, lights bit-identical", refits === 0 && snap() === before);
  }
}

// ============================================================================ D5
console.log("\n-- D5 far cascade sun-side cap ------------------------------------");
{
  const u = unit(SUN30);
  const run = (depthFit) => {
    const st = CSM.setupCsm(new THREE.Scene(), { sunDir: SUN30, stable: true, depthFit });
    CSM.updateCsm(st, mkCam(), SUN30);
    rasterMatrices(st);
    const l = st.lights[2];
    const r = l.shadow.camera.right;
    const recv = l.target.position.clone().addScaledVector(u, 0.9 * r); // inside the sphere, sun side
    const caster = recv.clone().addScaledVector(u, 20);                  // 20 m sunward of it
    const m = l.shadow.matrix;
    return { zr: zOf(m, recv), zc: zOf(m, caster), far: zOf(m, l.target.position.clone().addScaledVector(u, -r)) };
  };
  const old = run(false);
  const neu = run(true);
  check("D5 legacy (bug trigger): the cap's receiver is in front of the near plane (z < 0)", old.zr < 0, `z=${old.zr.toFixed(4)}`);
  check("D5 legacy: a caster 20 m sunward of it is clipped too (z < 0)", old.zc < 0);
  check("D5 depthFit: receiver and caster inside the depth range", neu.zr > 0 && neu.zr < 1 && neu.zc > 0 && neu.zc < 1,
    `zr=${neu.zr.toFixed(4)} zc=${neu.zc.toFixed(4)}`);
  check("D5 depthFit: the anti-sun side of the sphere is inside the far plane", neu.far < 1 && neu.far > 0.99, `z=${neu.far.toFixed(5)}`);
}

// ============================================================================ D6
console.log("\n-- D6 folded bias == biasM toward the light (conventional + reversed)");
for (const reversed of [false, true]) {
  const st = CSM.setupCsm(new THREE.Scene(), { sunDir: SUN30, stable: true, depthFit: true });
  CSM.updateCsm(st, mkCam(), SUN30);
  rasterMatrices(st, reversed);
  // A terrain-style receiver (its own uniform objects, no csmEnabled).
  const terr = { userData: {} };
  terr.userData.csmShaderUniforms = {
    uCsmMatrix0: { value: new THREE.Matrix4() }, uCsmMatrix1: { value: new THREE.Matrix4() }, uCsmMatrix2: { value: new THREE.Matrix4() },
  };
  st.patchedMaterials.add(terr);
  CSM.refreshCsmUniforms(st);
  const u = unit(SUN30);
  const R = rng(reversed ? 7 : 3);
  let worst = 0;
  let toward = true;
  for (let i = 0; i < 3; i += 1) {
    const l = st.lights[i];
    const raw = l.shadow.matrix;
    const r = l.shadow.camera.right;
    for (const [cls, m, bM] of [
      ["caster", st.uniforms[`uCsmMatrix${i}`].value, st.bias.caster[i]],
      ["ground", terr.userData.csmShaderUniforms[`uCsmMatrix${i}`].value, st.bias.ground[i]],
    ]) {
      for (let k = 0; k < 40; k += 1) {
        const p = l.target.position.clone().add(new THREE.Vector3(R() - 0.5, R() - 0.5, R() - 0.5).multiplyScalar(r));
        // The receiver GLSL: ref = z ∓ 0.0007 (conventional −, reversed +).
        const ref = zOf(m, p) + (reversed ? CSM.CSM_RECEIVER_BIAS : -CSM.CSM_RECEIVER_BIAS);
        const want = zOf(raw, p.clone().addScaledVector(u, bM));
        worst = Math.max(worst, Math.abs(ref - want));
        // "toward the light": conventional depth shrinks toward it, reversed grows.
        const plain = zOf(raw, p);
        if (reversed ? !(want > plain) : !(want < plain)) toward = false;
      }
      void cls;
    }
  }
  check(`D6 ${reversed ? "reversed" : "conventional"}: folded reference == raw depth moved biasM toward the light (|err| ${worst.toExponential(1)})`, worst < 1e-9);
  check(`D6 ${reversed ? "reversed" : "conventional"}: and that is toward the light`, toward);
  check(`D6 ${reversed ? "reversed" : "conventional"}: every cascade folded`, st.bias.folds === 3 && st.bias.unfoldable === 0);
}

// ============================================================================ D7
console.log("\n-- D7 bias values ----------------------------------------------------");
{
  const st = CSM.setupCsm(new THREE.Scene(), { sunDir: SUN30, stable: true, depthFit: true });
  CSM.updateCsm(st, mkCam(), SUN30);
  rasterMatrices(st);
  CSM.refreshCsmUniforms(st);
  const texel = st.lights.map((l, i) => (2 * l.shadow.camera.right) / st.mapSizes[i]);
  const legacyM = st.lights.map((l) => 0.0007 * (400 + l.shadow.camera.right - 0.1));
  const g = st.bias.ground;
  const c = st.bias.caster;
  console.log(`    texel cm ${texel.map((t) => (t * 100).toFixed(2)).join(" / ")}; ground cm ${g.map((v) => (v * 100).toFixed(1)).join(" / ")}; caster cm ${c.map((v) => (v * 100).toFixed(1)).join(" / ")}; old cm ${legacyM.map((v) => (v * 100).toFixed(1)).join(" / ")}`);
  check("D7 ground = min(2 texels, old metres)", [0, 1, 2].every((i) => near(g[i], Math.min(2 * texel[i], legacyM[i]), 1e-12)));
  check("D7 casters = min(4 texels, old metres)", [0, 1, 2].every((i) => near(c[i], Math.min(4 * texel[i], legacyM[i]), 1e-12)));
  check("D7 near cascade: ground 6.8 cm, casters 13.7 cm (was 30.4)", near(g[0], 0.0684, 5e-4) && near(c[0], 0.1367, 5e-4) && near(legacyM[0], 0.3044, 5e-4));
  check("D7 mid: ground 21.5 cm; casters keep the old 35.7 cm", near(g[1], 0.2148, 5e-4) && c[1] === legacyM[1]);
  check("D7 far cascade keeps the old 51 cm for both", g[2] === legacyM[2] && c[2] === legacyM[2]);
  check("D7 nothing leaks more than before", [0, 1, 2].every((i) => g[i] <= legacyM[i] && c[i] <= legacyM[i]));
  const st1 = CSM.setupCsm(new THREE.Scene(), { sunDir: SUN30, stable: true, depthFit: true, biasTexels: 1 });
  CSM.updateCsm(st1, mkCam(), SUN30);
  rasterMatrices(st1);
  CSM.refreshCsmUniforms(st1);
  check("D7 biasTexels 1 halves the near cascade's bias", near(st1.bias.ground[0], g[0] / 2, 1e-12) && near(st1.bias.caster[0], c[0] / 2, 1e-12));
}

// ============================================================================ D8
console.log("\n-- D8 the lit seam behind a wall (30 deg sun) ------------------------");
{
  // A wall in the plane facing the sun's azimuth through the camera; ground
  // points Q at horizontal distance δ behind it (anti-sun side). The ray from Q
  // toward the sun meets the wall δ·tan(e) up: that is the depth the map holds
  // at Q's texel. Q reads lit iff ref(Q) is not farther than it (LessEqual).
  const u = unit(SUN30);
  const horiz = new THREE.Vector3(u.x, 0, u.z).normalize();
  const tanE = u.y / Math.hypot(u.x, u.z);
  const seam = (st, cls) => {
    const i = 0;
    const l = st.lights[i];
    const raw = l.shadow.matrix;
    const m = cls === "ground" ? st._terr.userData.csmShaderUniforms.uCsmMatrix0.value : st.uniforms.uCsmMatrix0.value;
    const base = l.target.position.clone();
    base.y = 40; // ground level near the camera
    let lit = 0;
    for (let mm = 1; mm <= 800; mm += 1) {
      const d = mm / 1000; // metres behind the wall
      const q = base.clone().addScaledVector(horiz, -d);
      const w = base.clone();
      w.y += d * tanE;
      const stored = zOf(raw, w);
      const ref = zOf(m, q) - CSM.CSM_RECEIVER_BIAS;
      if (ref <= stored) lit = d; else break;
    }
    return lit;
  };
  const mk = (depthFit) => {
    const st = CSM.setupCsm(new THREE.Scene(), { sunDir: SUN30, stable: true, depthFit });
    CSM.updateCsm(st, mkCam(), SUN30);
    rasterMatrices(st);
    const terr = { userData: { csmShaderUniforms: { uCsmMatrix0: { value: new THREE.Matrix4() }, uCsmMatrix1: { value: new THREE.Matrix4() }, uCsmMatrix2: { value: new THREE.Matrix4() } } } };
    st.patchedMaterials.add(terr);
    st._terr = terr;
    CSM.refreshCsmUniforms(st);
    return st;
  };
  const old = mk(false);
  const neu = mk(true);
  const sOld = seam(old, "ground");
  const sG = seam(neu, "ground");
  const sC = seam(neu, "caster");
  const cosE = Math.hypot(u.x, u.z);
  console.log(`    lit seam: legacy ${(sOld * 100).toFixed(1)} cm; depthFit ground ${(sG * 100).toFixed(1)} cm, casters ${(sC * 100).toFixed(1)} cm`);
  check("D8 legacy (bug trigger): ~0.26 m of ground behind the wall reads lit", sOld > 0.25 && sOld < 0.28, `${sOld}`);
  check("D8 depthFit ground: the seam is biasM·cos e (~6 cm)", near(sG, neu.bias.ground[0] * cosE, 0.0015) && sG < 0.07, `${sG}`);
  check("D8 depthFit casters: ~12 cm", near(sC, neu.bias.caster[0] * cosE, 0.0015) && sC < 0.13, `${sC}`);
}

// ============================================================================ D9
console.log("\n-- D9 receiver classes in refreshCsmUniforms -------------------------");
{
  const st = CSM.setupCsm(new THREE.Scene(), { sunDir: SUN30, stable: true, depthFit: true });
  CSM.updateCsm(st, mkCam(), SUN30);
  // No map yet: nothing to fold — plain copies, counted.
  CSM.refreshCsmUniforms(st);
  check("D9 before the first raster: plain copies (unfoldable)", st.bias.unfoldable === 3 && st.bias.folds === 0 &&
    st.uniforms.uCsmMatrix0.value.equals(st.lights[0].shadow.matrix));
  rasterMatrices(st);
  const mk = (ud) => ({ userData: { ...ud, csmShaderUniforms: { uCsmMatrix0: { value: new THREE.Matrix4() }, uCsmMatrix1: { value: new THREE.Matrix4() }, uCsmMatrix2: { value: new THREE.Matrix4() } } } });
  const terr = mk({});
  const legacyStd = mk({ csmEnabled: true });
  // Binds the SHARED matrix objects by identity (a hypothetical receiver).
  const sharedBinder = { userData: { csmShaderUniforms: { uCsmMatrix0: st.uniforms.uCsmMatrix0, uCsmMatrix1: st.uniforms.uCsmMatrix1, uCsmMatrix2: st.uniforms.uCsmMatrix2 } } };
  st.patchedMaterials.add(terr);
  st.patchedMaterials.add(legacyStd);
  st.patchedMaterials.add(sharedBinder);
  CSM.refreshCsmUniforms(st);
  const f = st._biasFold;
  check("D9 shared set = caster fold", [0, 1, 2].every((i) => st.uniforms[`uCsmMatrix${i}`].value.equals(f.caster[i])));
  check("D9 terrain ShaderMaterial = ground fold", [0, 1, 2].every((i) => terr.userData.csmShaderUniforms[`uCsmMatrix${i}`].value.equals(f.ground[i])));
  check("D9 a registered materials.js receiver (csmEnabled) = caster fold", [0, 1, 2].every((i) => legacyStd.userData.csmShaderUniforms[`uCsmMatrix${i}`].value.equals(f.caster[i])));
  check("D9 shared matrix objects are never overwritten with the ground fold", [0, 1, 2].every((i) => st.uniforms[`uCsmMatrix${i}`].value.equals(f.caster[i])));
  check("D9 the folds differ from the raw matrix only in the z translation",
    [0, 1, 2].every((i) => f.ground[i].elements.every((v, k) => k === 14 || v === st.lights[i].shadow.matrix.elements[k]) &&
      f.ground[i].elements[14] !== st.lights[i].shadow.matrix.elements[14]));
}

// ============================================================================ D10
console.log("\n-- D10 receivers' constant ----------------------------------------");
{
  const mat = readFileSync(resolve(ROOT, "scene3d/materials.js"), "utf8");
  const ter = readFileSync(resolve(ROOT, "scene3d/terrain.js"), "utf8");
  const n = (s) => s.split("float bias = 0.0007;").length - 1;
  check("D10 materials.js _csmSampleCascade: `float bias = 0.0007;` once", n(mat) === 1);
  check("D10 terrain.js csmSampleCascade: `float bias = 0.0007;` once", n(ter) === 1);
}

// ============================================================================ D11
console.log("\n-- D11 lighting.js ?csmBias / ?csmBiasTexels -------------------------");
{
  const make = (search) => {
    globalThis.location.search = search;
    L.__resetRp5ConfigForTest(undefined);
    const lit = L.setupSceneLighting(new THREE.Scene(), { csm: true });
    const cs = lit.csmState;
    lit.dispose();
    return cs;
  };
  const a = make("");
  check("D11 absent ⇒ depthFit on, 2 texels", a.depthFit === true && a.biasTexels === 2);
  check("D11 legacy / off / 0 / false / no ⇒ off", ["legacy", "LEGACY", "off", "0", "false", "no"].every((v) => make(`?csmBias=${v}`).depthFit === false));
  check("D11 on / anything else ⇒ on", ["on", "1", "yes", "x"].every((v) => make(`?csmBias=${v}`).depthFit === true));
  check("D11 ?csmBiasTexels=3 ⇒ 3; 40 ⇒ 16; garbage ⇒ 2",
    make("?csmBiasTexels=3").biasTexels === 3 && make("?csmBiasTexels=40").biasTexels === 16 && make("?csmBiasTexels=abc").biasTexels === 2);
  globalThis.location.search = "";
  L.__resetRp5ConfigForTest(undefined);
}

console.log(`\ncsm_depth_fit: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
