// tests/csm_stable.test.mjs
//
// 2026-10-20 (improvement hunt shadows-restore-1) — stable CSM cascades
// (`setupCsm(…, { stable: true })`, lighting.js `?csmStable`, DEFAULT ON under
// ?csm, `=off` = the view-slice fit) and FRUSTUM-as-REFRESH in the static cache.
//
//   A  csm.js, stable refit decisions
//      A1  opt-in: only `stable: true`; uCsmSelDist 1 / 0
//      A2  first tick fits all 3 (forced); radius = split + margin (35 / 110 /
//          328 m); centre = the camera, texel-snapped; texel within 2.5% of the
//          view-slice fit at the default retail fov (90° game → 53.6° v, 16:9)
//      A3  rotation: a full yaw turn, pitch, roll — no refit, lights
//          bit-identical (the view-slice fit refits: negative control)
//      A4  fov / aspect / zoom changes: no refit (view-slice: refits)
//      A5  translation: cascade i refits exactly when the camera leaves its
//          slack zone (margin less a 2-texel guard), alone; counts over 60 m
//      A6  coverage: every point within splits[i] of the camera (any
//          direction) lands inside cascade i's map, guard included, along a
//          random walk with random look directions; negative control — view-
//          depth selection (screen corners at 28 m view depth) leaves c0
//      A7  sun drift: never two cascades on one tick (stagger), c0/c1 every
//          ~6 ticks at 2e-4 rad/tick, c2 (2e-3 rad epsilon) every ~11; each
//          cascade's sun lag stays bounded
//      A8  sun jump (0.1 rad): every cascade on the same tick
//      A9  a move refit and a due sun refit on one tick: the move goes, the
//          sun waits one tick
//      A10 invalidate → all 3; ortho camera → none
//      A11 the view-slice fit is bit-identical to the pre-split algorithm
//          (inline reference: corners → centroid → sphere → snap → place)
//      A12 refreshCsmUniforms writes uCsmSelDist to the shared set and to
//          registered receivers that carry it; others untouched
//   B  receivers: materials.js and terrain.js select by distance when
//      uCsmSelDist > 0.5 (shader text), the shared uniform bound by identity
//   C  lighting.js gate
//      C1  the ?csmStable reader (absent ⇒ on; off/0/false/no ⇒ off)
//      C2  a stable refit marks THAT cascade FRUSTUM alone (refitTicks /
//          refitMarks); turning marks nothing; ceilings 12 / 24 / 60;
//          ?csmStable=off: a move marks all 3, ceilings 12 / 12 / 12;
//          ?shadowMoverScope=off: a stable refit still rasters (RP5 body)
//   D  the real chain (lighting gate → ?shadowCasterList → three r184's REAL
//      WebGLShadowMap on a depth-content stub renderer, as in
//      shadow_static_cache.test.mjs): walking and turning with a rig in view
//      run OVERLAY; a refit cascade REFRESHes (FRUSTUM → REFRESH, counted);
//      zero NORMAL after warm; every rastered map exact. ?csmStable=off arm:
//      every walking frame re-rasters all 3 statics (today's cost).
//
// Run:  cd apps/holtburger-web && node tests/csm_stable.test.mjs

import * as THREE from "three";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

globalThis.window = globalThis.window || {};
globalThis.location = { search: "" };
window.location = globalThis.location;

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CSM = await import("../scene3d/csm.js");
const L = await import("../scene3d/lighting.js");
const SCL = await import("../scene3d/shadow_caster_list.js");
const { installCsmShaderPatch } = await import("../scene3d/materials.js");

let pass = 0, fail = 0;
function check(name, cond, extra = "") {
  if (cond) { pass += 1; console.log(`  [OK] ${name}`); }
  else { fail += 1; console.error(`  [FAIL] ${name}${extra ? ` — ${extra}` : ""}`); }
}

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

const RETAIL_V_FOV = 53.6; // camera_math.js: 90° game fov at 16:9
const SUN0 = { x: 60, y: 80, z: 30 };
function mkCam(fov = RETAIL_V_FOV, aspect = 16 / 9) {
  const c = new THREE.PerspectiveCamera(fov, aspect, 0.1, 5000);
  c.position.set(32448, 40, -34560); // Holtburg-ish, far from the origin
  c.lookAt(32448 + 10, 38, -34560 - 50);
  c.updateMatrixWorld();
  c.updateProjectionMatrix();
  return c;
}
const snapLights = (st) => st.lights.map((l) => {
  const c = l.shadow.camera;
  return [l.position.x, l.position.y, l.position.z, l.target.position.x, l.target.position.y, l.target.position.z,
    c.left, c.right, c.top, c.bottom, c.near, c.far].join(",");
}).join("|");
const halfW = (st) => st.lights.map((l) => l.shadow.camera.right);
const camPos = (c) => new THREE.Vector3().setFromMatrixPosition(c.matrixWorld);
const MARGINS = CSM.DEFAULT_CSM_STABLE_MARGINS;
const SPLITS = CSM.DEFAULT_CSM_SPLITS;
const SIZES = CSM.DEFAULT_CSM_MAP_SIZES;
const slackOf = (i) => MARGINS[i] - 2 * ((2 * (SPLITS[i] + MARGINS[i])) / SIZES[i]);
// An axis perpendicular to the sun, so `ang` IS the sun's angular step.
const perpAxis = (s) => new THREE.Vector3(s.x, s.y, s.z).cross(new THREE.Vector3(0, 0, 1)).normalize();
const rotSun = (s, axis, ang) => {
  const v = new THREE.Vector3(s.x, s.y, s.z).applyAxisAngle(axis, ang);
  return { x: v.x, y: v.y, z: v.z };
};

// ============================================================================ A
console.log("\n-- A csm.js stable refit decisions ------------------------------");
{
  const sDef = CSM.setupCsm(new THREE.Scene(), { sunDir: SUN0 });
  const sOn = CSM.setupCsm(new THREE.Scene(), { sunDir: SUN0, stable: true });
  const sTruthy = CSM.setupCsm(new THREE.Scene(), { sunDir: SUN0, stable: 1 });
  check("A1 setupCsm default = the view-slice fit", sDef.stable === false && sDef.uniforms.uCsmSelDist.value === 0);
  check("A1 ...only an explicit `stable: true` opts in", sOn.stable === true && sTruthy.stable === false);
  check("A1 ...stable ⇒ uCsmSelDist 1, per-cascade stale scale 1/2/5", sOn.uniforms.uCsmSelDist.value === 1 && sOn.stableStaleScale.join() === "1,2,5" && sDef.stableStaleScale === null);
  let threw = false;
  try { CSM.setupCsm(new THREE.Scene(), { stable: true, stableMargins: [5, 0, 28] }); } catch (_) { threw = true; }
  check("A1 ...a non-positive margin is refused", threw);
}

{
  const cam = mkCam();
  const st = CSM.setupCsm(new THREE.Scene(), { sunDir: SUN0, stable: true });
  CSM.updateCsm(st, cam);
  check("A2 first tick fits all 3 (forced)", st.refitMask === 0b111 && st.didRefitThisTick === true && st.stats.forced.join() === "1,1,1");
  const hw = halfW(st);
  check("A2 radius = split + margin (35 / 110 / 328 m)", hw[0] === 35 && hw[1] === 110 && hw[2] === 328, hw.join());
  const p = camPos(cam);
  const centreOk = st.lights.every((l, i) => {
    const texel = (2 * (SPLITS[i] + MARGINS[i])) / SIZES[i];
    return l.target.position.distanceTo(p) <= texel * Math.SQRT1_2 + 1e-9;
  });
  check("A2 ...centred on the camera, texel-snapped (≤ half a texel diagonal)", centreOk);
  const leg = CSM.setupCsm(new THREE.Scene(), { sunDir: SUN0 });
  CSM.updateCsm(leg, cam);
  const lw = halfW(leg);
  const ratio = hw.map((w, i) => w / lw[i]);
  check("A2 texel density ≈ the view-slice fit at the default retail fov (within 2.5%)", ratio.every((r) => Math.abs(r - 1) < 0.025), ratio.map((r) => r.toFixed(4)).join());
  CSM.updateCsm(st, cam);
  check("A2 ...and a still camera then refits nothing", st.refitMask === 0 && st.didRefitThisTick === false);
}

{
  const cam = mkCam();
  const st = CSM.setupCsm(new THREE.Scene(), { sunDir: SUN0, stable: true });
  const leg = CSM.setupCsm(new THREE.Scene(), { sunDir: SUN0 });
  CSM.updateCsm(st, cam);
  CSM.updateCsm(leg, cam);
  const before = snapLights(st);
  let anyRefit = false, legRefits = 0;
  for (let k = 1; k <= 36; k += 1) {
    cam.rotation.set(Math.sin(k) * 0.9, (k * 10 * Math.PI) / 180, Math.cos(k) * 0.2, "YXZ");
    cam.updateMatrixWorld();
    CSM.updateCsm(st, cam);
    CSM.updateCsm(leg, cam);
    if (st.refitMask !== 0) anyRefit = true;
    if (leg.refitMask === 0b111) legRefits += 1;
  }
  check("A3 a full yaw turn with pitch + roll: no stable refit", !anyRefit);
  check("A3 ...the cascades are bit-identical after it", snapLights(st) === before);
  check("A3 negative control: the view-slice fit refit all 3 on every step", legRefits === 36, `legRefits=${legRefits}`);

  const legB = snapLights(leg);
  cam.fov = 75; cam.aspect = 4 / 3; cam.zoom = 1.7; cam.updateProjectionMatrix();
  CSM.updateCsm(st, cam);
  CSM.updateCsm(leg, cam);
  check("A4 fov / aspect / zoom change: no stable refit", st.refitMask === 0 && snapLights(st) === before);
  check("A4 negative control: the view-slice fit refits", leg.refitMask === 0b111 && snapLights(leg) !== legB);
}

{
  const cam = mkCam();
  const st = CSM.setupCsm(new THREE.Scene(), { sunDir: SUN0, stable: true });
  CSM.updateCsm(st, cam);
  const centres = st.lights.map((l) => l.target.position.clone());
  const dir = new THREE.Vector3(0.8, 0.05, -0.6).normalize();
  const counts = [0, 0, 0];
  let invariant = true, alone = true;
  const R = rng(7);
  for (let k = 1; k <= 240; k += 1) {
    cam.position.addScaledVector(dir, 0.25);
    cam.rotation.y = R() * Math.PI * 2; // look anywhere: must not matter
    cam.updateMatrixWorld();
    const p = camPos(cam);
    const due = centres.map((c, i) => c.distanceTo(p) > slackOf(i));
    CSM.updateCsm(st, cam);
    for (let i = 0; i < 3; i += 1) {
      const refit = (st.refitMask >> i) & 1;
      if (!!refit !== due[i]) invariant = false;
      if (refit) { counts[i] += 1; centres[i].copy(st.lights[i].target.position); }
    }
    if (st.refitMask & ~(due[0] | (due[1] << 1) | (due[2] << 2))) alone = false;
  }
  check("A5 cascade i refits exactly when the camera leaves its slack zone (margin − 2 texels)", invariant);
  check("A5 ...and only the cascades that left it", alone);
  // 60 m walked: ⌊60 / slack⌋ recentres (4.93 / 9.79 / 26.72 m).
  check("A5 recentres over 60 m: 12 / 6 / 2", counts.join() === "12,6,2", counts.join());
  check("A5 counted as move refits", st.stats.move.join() === counts.join() && st.stats.forced.join() === "1,1,1");
}

{
  // Coverage: shadow coords of every point within splits[i] of the camera.
  const cam = mkCam();
  const st = CSM.setupCsm(new THREE.Scene(), { sunDir: SUN0, stable: true });
  const R = rng(42);
  const v = new THREE.Vector3();
  let worstEdge = Infinity, zOk = true, inside = true;
  for (let step = 0; step < 400; step += 1) {
    cam.position.x += (R() - 0.5) * 3;
    cam.position.z += (R() - 0.5) * 3;
    cam.position.y = 30 + R() * 20;
    cam.rotation.set((R() - 0.5) * 1.2, R() * Math.PI * 2, 0, "YXZ");
    cam.updateMatrixWorld();
    CSM.updateCsm(st, cam);
    const p = camPos(cam);
    for (let i = 0; i < 3; i += 1) {
      const l = st.lights[i];
      l.shadow.updateMatrices(l); // what three does when it rasters the map
      const g = 1.5 / SIZES[i]; // half-texel tap + bilinear footprint
      for (let s = 0; s < 24; s += 1) {
        // uniform direction, radius up to the split (incl. the boundary)
        const u = R() * 2 - 1, th = R() * Math.PI * 2, r = SPLITS[i] * (s < 6 ? 1 : Math.cbrt(R()));
        const q = Math.sqrt(1 - u * u);
        v.set(p.x + r * q * Math.cos(th), p.y + r * u, p.z + r * q * Math.sin(th)).applyMatrix4(l.shadow.matrix);
        const edge = Math.min(v.x, 1 - v.x, v.y, 1 - v.y);
        if (edge < g) inside = false;
        worstEdge = Math.min(worstEdge, edge * SIZES[i]);
        if (i < 2 && !(v.z >= 0 && v.z <= 1)) zOk = false;
      }
    }
  }
  check("A6 every point within splits[i] of the camera is inside cascade i's map (PCF guard kept)", inside, `worst edge ${worstEdge.toFixed(2)} texels`);
  check("A6 ...and inside the near / mid cascades' depth range", zOk);

  // Negative control: select by VIEW depth with stable cascades — the screen
  // corners at 28 m view depth (~40 m away) are outside c0.
  let outside = 0;
  const corner = new THREE.Vector3();
  for (let k = 0; k < 64; k += 1) {
    cam.rotation.set((R() - 0.5) * 0.6, (k / 64) * Math.PI * 2, 0, "YXZ");
    cam.updateMatrixWorld();
    CSM.updateCsm(st, cam);
    const l = st.lights[0];
    l.shadow.updateMatrices(l);
    const t = Math.tan((cam.fov * Math.PI) / 360);
    for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      corner.set(sx * 28 * t * cam.aspect, sy * 28 * t, -28).applyMatrix4(cam.matrixWorld).applyMatrix4(l.shadow.matrix);
      if (corner.x < 0 || corner.x > 1 || corner.y < 0 || corner.y > 1) outside += 1;
    }
  }
  check("A6 negative control: view-depth selection would leave c0 at the screen corners (why receivers switch)", outside > 0, `outside=${outside}/256`);
}

{
  // Sun drift, camera still.
  const cam = mkCam();
  const st = CSM.setupCsm(new THREE.Scene(), { sunDir: SUN0, stable: true });
  CSM.updateCsm(st, cam, SUN0);
  const axis = perpAxis(SUN0);
  const d = 2e-4;
  const counts = [0, 0, 0];
  const last = [0, 0, 0], gaps = [[], [], []];
  let multi = false, maxLag = [0, 0, 0];
  const fitSun = [0, 1, 2].map(() => new THREE.Vector3(SUN0.x, SUN0.y, SUN0.z).normalize());
  for (let k = 1; k <= 300; k += 1) {
    const sun = rotSun(SUN0, axis, d * k);
    CSM.updateCsm(st, cam, sun);
    const cur = new THREE.Vector3(sun.x, sun.y, sun.z).normalize();
    let n = 0;
    for (let i = 0; i < 3; i += 1) {
      if ((st.refitMask >> i) & 1) { n += 1; counts[i] += 1; fitSun[i].copy(cur); gaps[i].push(k - last[i]); last[i] = k; }
      maxLag[i] = Math.max(maxLag[i], fitSun[i].angleTo(cur));
    }
    if (n > 1) multi = true;
  }
  check("A7 sun drift: never two cascades on one tick", !multi);
  // Due once the step passes epsilon: 6 ticks (1.2e-3 > 1e-3 rad) for c0 / c1,
  // 11 (2.2e-3 > 2e-3) for c2; a stagger deferral adds a tick now and then.
  const mean = gaps.map((g) => g.reduce((x, y) => x + y, 0) / g.length);
  const span = gaps.map((g) => [Math.min(...g), Math.max(...g)]);
  check("A7 ...c0 / c1 refit every 6-7 ticks (1e-3 rad), c2 every 11-12 (2e-3 rad)", span[0][0] >= 6 && span[0][1] <= 7 && span[1][0] >= 6 && span[1][1] <= 8 && span[2][0] >= 11 && span[2][1] <= 13 && mean[0] < 6.5 && mean[2] < 12, JSON.stringify({ counts, mean: mean.map((x) => x.toFixed(2)), span }));
  check("A7 ...counted as sun refits, the stagger as deferrals", st.stats.sun.join() === counts.join() && st.stats.sunDeferred > 0, JSON.stringify(st.stats));
  check("A7 ...each cascade's sun lag stays bounded (≤ epsilon + 2 ticks)", maxLag[0] <= 1e-3 + 2 * d + 1e-9 && maxLag[1] <= 1e-3 + 2 * d + 1e-9 && maxLag[2] <= 2e-3 + 2 * d + 1e-9, maxLag.map((x) => x.toExponential(2)).join());

  const sunNow = rotSun(SUN0, axis, d * 300);
  const axis2 = perpAxis(sunNow);
  CSM.updateCsm(st, cam, sunNow);
  CSM.updateCsm(st, cam, sunNow);
  const jumps0 = st.stats.sunJumps;
  CSM.updateCsm(st, cam, rotSun(sunNow, axis2, 0.1));
  check("A8 a sun JUMP (0.1 rad) refits every cascade on the same tick", st.refitMask === 0b111 && st.stats.sunJumps === jumps0 + 1);
}

{
  const cam = mkCam();
  const st = CSM.setupCsm(new THREE.Scene(), { sunDir: SUN0, stable: true });
  CSM.updateCsm(st, cam, SUN0);
  const sun = rotSun(SUN0, perpAxis(SUN0), 1.5e-3); // past c0/c1 epsilon, under c2's and the jump
  cam.position.x += 6; // past c0's slack only
  cam.updateMatrixWorld();
  const def0 = st.stats.sunDeferred;
  CSM.updateCsm(st, cam, sun);
  const m1 = st.refitMask;
  CSM.updateCsm(st, cam, sun);
  const m2 = st.refitMask;
  CSM.updateCsm(st, cam, sun);
  const m3 = st.refitMask;
  check("A9 move + due sun on one tick: the move refit (c0) goes alone", m1 === 0b001 && st.stats.sunDeferred === def0 + 1, `m1=${m1}`);
  check("A9 ...the sun refit (c1) the next tick, then quiet", m2 === 0b010 && m3 === 0, `m2=${m2} m3=${m3}`);
}

{
  const cam = mkCam();
  const st = CSM.setupCsm(new THREE.Scene(), { sunDir: SUN0, stable: true });
  CSM.updateCsm(st, cam);
  CSM.updateCsm(st, cam);
  st.invalidate();
  check("A10 invalidate marks a refit at once", st.didRefitThisTick === true && st.refitMask === 0b111);
  CSM.updateCsm(st, cam);
  check("A10 ...and the next tick refits all 3 (forced)", st.refitMask === 0b111 && st.stats.forced.join() === "2,2,2");
  CSM.updateCsm(st, new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10));
  check("A10 ortho camera: no refit, empty mask", st.refitMask === 0 && st.didRefitThisTick === false);
}

{
  // A11 — the view-slice fit vs. an inline copy of the pre-split algorithm.
  const NDC = [[-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1], [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]];
  function refFit(camera, near, far, lx, ly, lz, mapSize) {
    const top = near * Math.tan((camera.fov * 0.5 * Math.PI) / 180) / camera.zoom;
    const height = 2 * top, width = camera.aspect * height, left = -0.5 * width;
    const proj = new THREE.Matrix4().makePerspective(left, left + width, top, top - height, near, far, camera.coordinateSystem);
    const inv = proj.clone().invert();
    const corners = NDC.map((c) => new THREE.Vector3(c[0], c[1], c[2]).applyMatrix4(inv).applyMatrix4(camera.matrixWorld));
    const center = new THREE.Vector3(0, 0, 0);
    for (const c of corners) center.add(c);
    center.multiplyScalar(1 / 8);
    let r2 = 0;
    for (const c of corners) { const dd = c.distanceToSquared(center); if (dd > r2) r2 = dd; }
    const radius = Math.max(1e-3, Math.sqrt(r2));
    const O = new THREE.Vector3(0, 0, 0);
    const rot = new THREE.Matrix4().lookAt(new THREE.Vector3(lx, ly, lz), O, new THREE.Vector3(0, 1, 0));
    rot.setPosition(O);
    const rotInv = rot.clone().invert();
    const texel = (radius * 2) / mapSize;
    const s = center.clone().applyMatrix4(rotInv);
    s.x = Math.round(s.x / texel) * texel;
    s.y = Math.round(s.y / texel) * texel;
    s.applyMatrix4(rot);
    return [s.x + lx * 200, s.y + ly * 200, s.z + lz * 200, s.x, s.y, s.z, -radius, radius, radius, -radius, 0.1, 200 * 2 + radius].join(",");
  }
  const R = rng(3);
  let same = true, n = 0;
  for (let k = 0; k < 20; k += 1) {
    const cam = mkCam(40 + R() * 50, 1 + R());
    cam.position.set((R() - 0.5) * 60000, R() * 200, (R() - 0.5) * 60000);
    cam.rotation.set((R() - 0.5) * 1.5, R() * 6.28, (R() - 0.5) * 0.3, "YXZ");
    cam.updateMatrixWorld();
    const sun = { x: R() - 0.5, y: 0.2 + R(), z: R() - 0.5 };
    const st = CSM.setupCsm(new THREE.Scene(), { sunDir: sun });
    CSM.updateCsm(st, cam, sun);
    const len = Math.hypot(sun.x, sun.y, sun.z);
    const lx = sun.x / len, ly = sun.y / len, lz = sun.z / len;
    let prev = cam.near;
    const want = SPLITS.map((sp, i) => { const r = refFit(cam, prev, sp, lx, ly, lz, SIZES[i]); prev = sp; return r; }).join("|");
    if (snapLights(st) !== want) same = false;
    n += 1;
  }
  check("A11 view-slice fit bit-identical to the pre-split algorithm (20 random poses / suns / fovs)", same && n === 20);
}

{
  const st = CSM.setupCsm(new THREE.Scene(), { sunDir: SUN0, stable: true });
  st.uniforms.uCsmSelDist.value = 0; // stale value: the refresh owns it
  const recv = { userData: { csmShaderUniforms: { uCsmSplits: { value: new THREE.Vector2() }, uCsmSelDist: { value: 0 } } } };
  const bare = { userData: { csmShaderUniforms: { uCsmSplits: { value: new THREE.Vector2() } } } };
  st.patchedMaterials.add(recv);
  st.patchedMaterials.add(bare);
  let threw = false;
  try { CSM.refreshCsmUniforms(st); } catch (_) { threw = true; }
  check("A12 refreshCsmUniforms writes uCsmSelDist (shared + registered receivers)", !threw && st.uniforms.uCsmSelDist.value === 1 && recv.userData.csmShaderUniforms.uCsmSelDist.value === 1);
  check("A12 ...a receiver without the uniform is left alone", !("uCsmSelDist" in bare.userData.csmShaderUniforms));
  const lg = CSM.setupCsm(new THREE.Scene(), { sunDir: SUN0 });
  CSM.refreshCsmUniforms(lg);
  check("A12 ...the view-slice fit keeps it 0", lg.uniforms.uCsmSelDist.value === 0);
}

// ============================================================================ B
console.log("\n-- B receivers select by distance under uCsmSelDist -------------");
{
  function compile(mat) {
    const lib = THREE.ShaderLib.standard;
    const shader = { uniforms: THREE.UniformsUtils.clone(lib.uniforms), vertexShader: lib.vertexShader, fragmentShader: lib.fragmentShader, defines: {} };
    mat.onBeforeCompile(shader, null);
    return shader;
  }
  const st = CSM.setupCsm(new THREE.Scene(), { sunDir: SUN0, stable: true });
  const mat = new THREE.MeshStandardMaterial();
  installCsmShaderPatch(mat, st);
  const sh = compile(mat);
  const fs = sh.fragmentShader;
  const fn = fs.slice(fs.indexOf("float _csmShadowFactor("), fs.indexOf("void main() {", fs.indexOf("float _csmShadowFactor(")));
  const sel = "if (uCsmSelDist > 0.5) viewDepth = length(worldPos - cameraPosition);";
  check("B1 materials.js: uCsmSelDist declared", /uniform float uCsmSelDist;/.test(fs));
  check("B1 ..._csmShadowFactor swaps view depth for camera distance before any use", fn.includes(sel) && fn.indexOf(sel) < fn.indexOf("float blendW0"));
  check("B1 ...the shared uniform bound BY IDENTITY", sh.uniforms.uCsmSelDist === st.uniforms.uCsmSelDist);
  const legacyBundle = { lights: st.lights, splits: st.splits, blendFrac: st.blendFrac, stable: true, patchedMaterials: new Set() };
  const mat2 = new THREE.MeshStandardMaterial();
  installCsmShaderPatch(mat2, legacyBundle);
  const sh2 = compile(mat2);
  check("B1 ...a bundle without shared uniforms gets its own {value: 1}", sh2.uniforms.uCsmSelDist && sh2.uniforms.uCsmSelDist.value === 1);
  const stOff = CSM.setupCsm(new THREE.Scene(), { sunDir: SUN0 });
  const mat3 = new THREE.MeshStandardMaterial();
  installCsmShaderPatch(mat3, stOff);
  check("B1 ...the view-slice fit: 0 (view depth, as before)", compile(mat3).uniforms.uCsmSelDist.value === 0);

  const tsrc = readFileSync(resolve(ROOT, "scene3d/terrain.js"), "utf8");
  const a = tsrc.indexOf("#ifdef HB_TERRAIN_CSM\nuniform float uCsmEnabled;");
  const b = tsrc.indexOf("#endif  // HB_TERRAIN_CSM", a);
  const blk = a >= 0 && b > a ? tsrc.slice(a, b) : "";
  const tfn = blk.slice(blk.indexOf("float csmShadowFactor("));
  check("B2 terrain.js: uCsmSelDist declared inside #ifdef HB_TERRAIN_CSM", /uniform float uCsmSelDist;/.test(blk));
  check("B2 ...csmShadowFactor swaps view depth for camera distance before any use", tfn.includes(sel) && tfn.indexOf(sel) < tfn.indexOf("float blendW0"));
  check("B2 ...the material's uniform starts from csmState.stable", /uCsmSelDist:\s*\{\s*value:\s*scene3d\?\.csmState\?\.stable === true \? 1 : 0,/.test(tsrc));
}

// ============================================================================ C
console.log("\n-- C lighting.js gate --------------------------------------------");
function gateSession(search, cfg) {
  globalThis.location.search = search;
  L.__resetRp5ConfigForTest(cfg);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(RETAIL_V_FOV, 16 / 9, 0.1, 5000);
  camera.position.set(0, 5, 0);
  scene.add(camera);
  scene.updateMatrixWorld(true);
  const lighting = L.setupSceneLighting(scene, { csm: true });
  const shadowMap = { enabled: true, autoUpdate: true, needsUpdate: false, type: THREE.PCFShadowMap };
  const scene3d = { renderer: { shadowMap }, lighting, camera, scene, entityManager: { entityMap: new Map() } };
  const lights = lighting.csmState.lights;
  // One tick, then "three renders": consume every armed mark, report reasons.
  function tick() {
    L.tickLightingForCellState(scene3d, null);
    const out = lights.map((l) => (l.shadow.needsUpdate ? (l.userData.hbShadowReason | 0) || 8 : 0));
    for (const l of lights) { l.shadow.needsUpdate = false; l.userData.hbShadowReason = 0; }
    shadowMap.needsUpdate = false;
    return out;
  }
  return { scene3d, lighting, camera, lights, tick, shadowMap };
}
const FR = 4, STA = 2;
{
  const read = (s) => { globalThis.location.search = s; L.__resetRp5ConfigForTest(undefined); const S = gateSession(s); return S.lighting.csmState.stable; };
  check("C1 absent ⇒ stable", read("") === true);
  check("C1 off / 0 / false / no / OFF ⇒ the view-slice fit", ["off", "0", "false", "no", "OFF"].every((v) => read(`?csmStable=${v}`) === false));
  check("C1 on ⇒ stable", read("?csmStable=on") === true);
}
{
  const S = gateSession("");
  const w = S.tick();
  check("C2 warm tick: all 3 FRUSTUM", w.every((r) => r & FR));
  // Still scene: per-cascade ceilings 12 / 24 / 60.
  const at = [[], [], []];
  let frustumWhileStill = false;
  for (let f = 2; f <= 160; f += 1) {
    const r = S.tick();
    r.forEach((x, i) => { if (x & STA) at[i].push(f); if (x & FR) frustumWhileStill = true; });
  }
  const gaps = at.map((a) => a.slice(1).map((f, k) => f - a[k]));
  check("C2 still scene: no frustum marks", !frustumWhileStill);
  check("C2 ...stable ceilings every 12 / 24 / 60 frames", gaps[0].length > 3 && gaps[0].every((g) => g === 12) && gaps[1].length > 2 && gaps[1].every((g) => g === 24) && gaps[2].length >= 1 && gaps[2].every((g) => g === 60), JSON.stringify(at));
  const sc = S.scene3d._shadowScope.stats;
  const rt0 = sc.refitTicks, rm0 = sc.refitMarks.slice();
  S.camera.position.x += 6; // past c0's slack (4.93 m) only
  const m = S.tick();
  check("C2 a 6 m move marks c0 FRUSTUM alone", (m[0] & FR) && !(m[1] & FR) && !(m[2] & FR), m.join());
  check("C2 ...counted as a refit tick / c0 refit mark", sc.refitTicks === rt0 + 1 && sc.refitMarks[0] === rm0[0] + 1 && sc.refitMarks[1] === rm0[1] && sc.refitMarks[2] === rm0[2]);
  let turned = false;
  for (let k = 1; k <= 24; k += 1) {
    S.camera.rotation.set(0.3 * Math.sin(k), (k * 15 * Math.PI) / 180, 0, "YXZ");
    if (S.tick().some((x) => x & FR)) turned = true;
  }
  check("C2 turning in place marks nothing FRUSTUM", !turned);
}
{
  const S = gateSession("?csmStable=off");
  S.tick();
  const at = [[], [], []];
  for (let f = 2; f <= 40; f += 1) S.tick().forEach((x, i) => { if (x & STA) at[i].push(f); });
  const gaps = at.map((a) => a.slice(1).map((f, k) => f - a[k]));
  check("C2 ?csmStable=off: ceilings 12 / 12 / 12 (unchanged)", gaps.every((g) => g.length >= 1 && g.every((x) => x === 12)), JSON.stringify(at));
  S.camera.position.x += 0.5;
  const m = S.tick();
  check("C2 ?csmStable=off: a 0.5 m move marks all 3 FRUSTUM (unchanged)", m.every((r) => r & FR), m.join());
}
{
  const S = gateSession("", { shadowMoverScope: false });
  S.tick();
  for (let k = 0; k < 3; k += 1) S.tick();
  S.camera.position.x += 6;
  L.tickLightingForCellState(S.scene3d, null);
  check("C2 ?shadowMoverScope=off: a stable refit still rasters (RP5 body)", S.shadowMap.needsUpdate === true && S.lighting.csmState.refitMask === 0b001);
}
globalThis.location.search = "";
L.__resetRp5ConfigForTest(undefined);

// ============================================================================ D
console.log("\n-- D real chain: walking / turning run OVERLAY ------------------");
const require = createRequire(import.meta.url);
const threeDir = require.resolve("three").replace(/[^/\\]+$/, "");
const tsrc3 = readFileSync(threeDir + "three.module.js", "utf8");
const ia = tsrc3.indexOf("const vertex = \"void main()");
const ib = tsrc3.indexOf("function WebGLState(");
if (ia < 0 || ib < 0 || !tsrc3.slice(ia, ib).includes("function WebGLShadowMap(")) {
  console.log("csm_stable: three.module.js layout changed — re-anchor the extraction.");
  process.exit(1);
}
// eslint-disable-next-line no-new-func
const WebGLShadowMap = new Function("THREE", "with (THREE) {\n" + tsrc3.slice(ia, ib) + "\nreturn WebGLShadowMap; }")(THREE);
const poseKey = (o) => o.matrixWorld.elements.map((x) => x.toFixed(4)).join(",");

function makeRenderer() {
  const content = new Map();
  const byDepth = new Map();
  const log = { draws: [], blits: [], setRT: [] };
  let current = null;
  const reg = (rt) => { if (rt && rt.depthTexture) byDepth.set(rt.depthTexture, rt); if (rt && !content.has(rt)) content.set(rt, new Set()); };
  const r = {
    domElement: { addEventListener() {} },
    getRenderTarget: () => current,
    getActiveCubeFace: () => 0,
    getActiveMipmapLevel: () => 0,
    setRenderTarget(rt) { current = rt; log.setRT.push(rt); reg(rt); },
    clear() { if (current) content.set(current, new Set()); },
    initRenderTarget(rt) { reg(rt); },
    copyTextureToTexture(srcTex, dstTex) {
      const s = byDepth.get(srcTex), d = byDepth.get(dstTex);
      if (!s || !d) throw new Error("blit between unregistered targets");
      log.blits.push({ s, d });
      content.set(d, new Set(content.get(s)));
    },
    state: {
      setBlending() {}, viewport() {}, setScissorTest() {},
      buffers: { depth: { getReversed: () => false, setTest() {}, setMask() {} }, color: { setClear() {} } },
    },
    renderBufferDirect(camera, scene, geometry, material, object) {
      if (!current) return;
      content.get(current).add(`${object.id}@${poseKey(object)}`);
      log.draws.push({ rt: current, object });
    },
  };
  const sm = new WebGLShadowMap(r, { update: (o) => o.geometry }, { maxTextureSize: 16384 });
  sm.enabled = true;
  sm.type = THREE.PCFShadowMap;
  r.shadowMap = sm;
  return { renderer: r, sm, content, log };
}

const box = new THREE.BoxGeometry(2, 2, 4);
const mat = new THREE.MeshStandardMaterial();
function chainSession(search) {
  globalThis.location.search = search;
  L.__resetRp5ConfigForTest(undefined);
  SCL.__resetShadowStaticCacheForTest();
  const scene = new THREE.Scene();
  const worldRoot = new THREE.Group();
  worldRoot.rotation.x = -Math.PI / 2;
  scene.add(worldRoot);
  const staticsGroup = new THREE.Group();
  const entitiesGroup = new THREE.Group();
  worldRoot.add(staticsGroup, entitiesGroup);
  const camera = new THREE.PerspectiveCamera(RETAIL_V_FOV, 16 / 9, 0.1, 5000);
  camera.position.set(0, 5, 0); // looks down three -Z = AC +Y
  scene.add(camera);
  for (let i = 0; i < 60; i += 1) {
    const m = new THREE.Mesh(box, mat);
    m.castShadow = true;
    m.position.set(((i * 37) % 200) - 100, ((i * 53) % 360) - 40, 2);
    staticsGroup.add(m);
  }
  const rigRoot = new THREE.Group();
  const rm = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 2), mat);
  rm.castShadow = true;
  rm.position.set(0, 0, 1);
  rigRoot.add(rm);
  rigRoot.position.set(2, 8, 0);
  entitiesGroup.add(rigRoot);
  scene.updateMatrixWorld(true);
  const R = makeRenderer();
  SCL.installShadowCasterList(R.renderer);
  const lighting = L.setupSceneLighting(scene, { csm: true });
  const lights = lighting.csmState.lights;
  for (const l of lights) l.shadow.mapSize.set(64, 64);
  const entityMap = new Map([[1, { root: rigRoot }]]);
  const scene3d = { renderer: R.renderer, lighting, camera, scene, entityManager: { entityMap }, entitiesGroup };
  const isStatic = (o) => { for (let x = o; x; x = x.parent) if (x === staticsGroup) return true; return false; };
  function frame(move) {
    L.tickLightingForCellState(scene3d, null);
    const refitMask = lighting.csmState.refitMask;
    if (move) move();
    scene.updateMatrixWorld();
    R.log.draws.length = 0; R.log.blits.length = 0; R.log.setRT.length = 0;
    const s0 = SCL.getShadowStaticCacheStats();
    R.sm.render(lights, scene, camera);
    const s1 = SCL.getShadowStaticCacheStats();
    const rastered = new Set();
    for (const rt of R.log.setRT) { const i = lights.findIndex((l) => l.shadow.map === rt); if (i >= 0) rastered.add(i); }
    return {
      refitMask,
      rastered: [...rastered].sort().join(""),
      normal: s1.normal - s0.normal, refresh: s1.refresh - s0.refresh, overlay: s1.overlay - s0.overlay,
      passthrough: s1.passthrough - s0.passthrough, // an all-NORMAL call: three's plain single pass
      frustumRefresh: s1.frustumRefresh - s0.frustumRefresh,
      staticDraws: R.log.draws.filter((d) => isStatic(d.object)).length,
    };
  }
  function exact(i) {
    const got = R.content.get(lights[i].shadow.map) || new Set();
    const want = new Set();
    const fr = lights[i].shadow.getFrustum();
    (function walk(o) {
      if (o.visible === false) return;
      if (o.isMesh && o.castShadow && o.layers.test(camera.layers) && (!o.frustumCulled || fr.intersectsObject(o))) want.add(`${o.id}@${poseKey(o)}`);
      for (const c of o.children) walk(c);
    })(scene);
    if (got.size !== want.size) return false;
    for (const k of want) if (!got.has(k)) return false;
    return true;
  }
  const allExact = (res) => [...res.rastered].every((ch) => exact(Number(ch)));
  return { camera, rigRoot, lighting, frame, allExact };
}
const popcount = (m) => (m & 1) + ((m >> 1) & 1) + ((m >> 2) & 1);
{
  const S = chainSession("");
  const w = S.frame();
  check("D0 warm frame: all 3 in the plain pass (no maps yet, so NORMAL), exact", w.rastered === "012" && w.passthrough === 1 && w.refresh === 0 && w.overlay === 0 && S.allExact(w));
  let normals = 0, overlays = 0, refreshes = 0, frustumOk = true, exactAll = true, overlayOnly = 0, overlayOnlyClean = true, refitFrames = 0;
  // Walk: the camera 0.5 m / frame (AC +X), the rig keeping pace in view.
  for (let f = 0; f < 48; f += 1) {
    S.camera.position.x += 0.5;
    const res = S.frame(() => { S.rigRoot.position.x += 0.5; });
    normals += res.normal + res.passthrough; overlays += res.overlay; refreshes += res.refresh;
    if (res.frustumRefresh !== popcount(res.refitMask)) frustumOk = false;
    if (res.refitMask) refitFrames += 1;
    if (!S.allExact(res)) exactAll = false;
    if (res.refresh === 0 && res.overlay > 0) { overlayOnly += 1; if (res.staticDraws !== 0) overlayOnlyClean = false; }
  }
  check("D1 walking: no NORMAL raster after warm", normals === 0, `normals=${normals}`);
  // 24 m walked: c0 recentres 4× (4.93 m slack), c1 2× (9.79 m) — 4+ frames.
  check("D1 ...each refit cascade REFRESHes in its refit frame (FRUSTUM → REFRESH, counted)", frustumOk && refitFrames >= 4, `refitFrames=${refitFrames}`);
  check("D1 ...the rest OVERLAY: most walking frames draw zero statics", overlayOnly >= 30 && overlayOnlyClean, `overlayOnly=${overlayOnly}/48`);
  check("D1 ...overlays far outnumber static refreshes", overlays > 4 * refreshes, `overlays=${overlays} refreshes=${refreshes}`);
  check("D1 ...every rastered map exact (statics + the rig's current pose)", exactAll);
  let spinRefit = false, spinRefresh = 0, spinExact = true, spinNormal = 0;
  for (let k = 1; k <= 24; k += 1) {
    S.camera.rotation.set(0, (k * 15 * Math.PI) / 180, 0, "YXZ");
    const res = S.frame(() => { S.rigRoot.position.y += 0.3; });
    if (res.refitMask) spinRefit = true;
    spinRefresh += res.refresh; spinNormal += res.normal + res.passthrough;
    if (!S.allExact(res)) spinExact = false;
  }
  check("D2 a full turn in place: no refit, no NORMAL", !spinRefit && spinNormal === 0);
  // 24 frames hold at most c0's ceiling twice (12), c1's once (24), c2's once (60).
  check("D2 ...only the staggered ceilings refresh statics (≤ 4 in 24 frames)", spinRefresh <= 4, `refresh=${spinRefresh}`);
  check("D2 ...every rastered map exact", spinExact);
}
{
  const S = chainSession("?csmStable=off");
  S.frame();
  let allRefresh = true, statics = true;
  for (let f = 0; f < 8; f += 1) {
    S.camera.position.x += 0.5;
    const res = S.frame(() => { S.rigRoot.position.x += 0.5; });
    if (!(res.refresh === 3 && res.frustumRefresh === 3 && res.overlay === 0)) allRefresh = false;
    if (res.staticDraws === 0) statics = false;
  }
  check("D3 ?csmStable=off arm: every walking frame refits all 3 and re-rasters their statics (REFRESH ×3)", allRefresh && statics);
}
globalThis.location.search = "";
L.__resetRp5ConfigForTest(undefined);

console.log(`\ncsm_stable: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
