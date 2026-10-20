// tests/cloud_shadow_cadence.test.mjs — ?cloudShadowEvery (2026-10-20,
// improvement hunt gpu-shading-4, OWNER-APPROVED look trade, default 2).
//
// scene3d/cloud_volume.js installCloudShadowCadence: the takram cloud-shadow
// march (ShadowPass: cascades × 512² + temporal resolve, α 0.05) runs every Nth
// cloud frame through instance-method wrappers on effect.shadowMaps.update and
// effect.shadowPass.update (no vendor edit). Held frames freeze the cascades
// AND the shadow buffer together; the march gets its own +1-per-run frame
// counter so the STBN slice advances one per march; `=1` installs nothing.
//
//   C1  parser: absent/junk → 2, off|0|1 → 1, floor, clamp to 8.
//   C2  stub effect (prototype methods, like the vendor classes): N=2 / N=3
//       call through on the right frames and hold otherwise; consecutive own
//       march frame; args passed through; N=1 = no own property (pass-through
//       by construction); forced runs on resize / target swap / camera jump,
//       not on running-speed motion; fallback decision; live setEvery and
//       uninstall restore the prototype.
//   C3  REAL CloudVolume over the vendored CloudsEffect.update (GPU draws
//       stubbed): at the default N=2 the march renders on alternate frames,
//       the clouds pass every frame; on a held frame the clouds pass reads the
//       SAME shadow buffer and the SAME cascade matrices / far as the frame
//       before (consistent pair) although the camera moved; the shadow `frame`
//       uniform is 1,2,3… per march; `?cloudShadowEvery=1` = the vendor path
//       (frame uniform === effect.frame, march every frame, no own property).
//   C4  diag: `__cloudStateDiag().shadowCadence` (cloudStateSnapshot) reports
//       the cadence; `__setCloudShadowEvery` drives it live.
//   C5  premises in the vendored build + wiring.
//
// Fails on the pre-change code: installCloudShadowCadence / parseCloudShadowEvery
// do not exist and the real effect marches the shadow on every frame.
//
// Run: node tests/cloud_shadow_cadence.test.mjs

import { register } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(HERE, "..");
const v = (p) => pathToFileURL(path.join(APP, p)).href;
// index.html's import map, mirrored for node (as clouds_boot_order does).
const MAP = {
  "@takram/three-clouds": v("vendor/takram-three-clouds/build/index.js"),
  "@takram/three-atmosphere": v("vendor/takram/three-atmosphere.js"),
  "@takram/three-atmosphere/shaders/bruneton": v("vendor/takram/three-atmosphere-shaders-bruneton.js"),
  "@takram/three-geospatial": v("vendor/takram/three-geospatial.js"),
  "@takram/three-geospatial/shaders": v("vendor/takram/three-geospatial-shaders.js"),
  "@takram/three-geospatial-effects": v("vendor/takram/three-geospatial-effects.js"),
};
register(
  "data:text/javascript," +
    encodeURIComponent(
      `const M = ${JSON.stringify(MAP)};
      export async function resolve(spec, ctx, next) {
        if (M[spec]) return { url: M[spec], shortCircuit: true };
        return next(spec, ctx);
      }`,
    ),
);

// Module-load devtools hooks need a window; the URL is set per CloudVolume.
globalThis.window = { location: { search: "" }, innerWidth: 800, innerHeight: 600 };
globalThis.location = window.location;

const THREE = await import("three");
const CV = await import("../scene3d/cloud_volume.js");
const {
  CloudVolume, parseCloudShadowEvery, installCloudShadowCadence,
  CLOUD_SHADOW_EVERY_DEFAULT, CLOUD_SHADOW_EVERY_MAX, CLOUD_SHADOW_JUMP_M,
} = CV;

let passed = 0;
let failed = 0;
function check(label, cond, extra = "") {
  if (cond) { passed++; console.log(`  [OK] ${label}`); }
  else { failed++; console.log(`  [FAIL] ${label} ${extra}`); }
}
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

// ---------------------------------------------------------------------------
console.log("-- C1 ?cloudShadowEvery parser ---------------------------------------");
check("default is 2 (owner-approved)", CLOUD_SHADOW_EVERY_DEFAULT === 2);
check("absent / empty -> 2", parseCloudShadowEvery("") === 2 && parseCloudShadowEvery("?x=1") === 2 &&
  parseCloudShadowEvery("?cloudShadowEvery=") === 2 && parseCloudShadowEvery(undefined) === 2);
check("off / false / no / 0 / 1 -> 1 (every frame)",
  ["off", "OFF", "false", "no", "0", "1"].every((s) => parseCloudShadowEvery(`?cloudShadowEvery=${s}`) === 1));
check("2 / 3 / 4 as given", [2, 3, 4].every((n) => parseCloudShadowEvery(`?cloudShadowEvery=${n}`) === n));
check("fractions floor (2.9 -> 2), 0.5 -> 1", parseCloudShadowEvery("?cloudShadowEvery=2.9") === 2 &&
  parseCloudShadowEvery("?cloudShadowEvery=0.5") === 1);
check(`clamped to ${CLOUD_SHADOW_EVERY_MAX}`, parseCloudShadowEvery("?cloudShadowEvery=99") === CLOUD_SHADOW_EVERY_MAX);
check("junk / negative -> default 2",
  ["abc", "-3", "NaN", "Infinity"].every((s) => parseCloudShadowEvery(`?cloudShadowEvery=${s}`) === 2));

// ---------------------------------------------------------------------------
console.log("\n-- C2 stub effect: call-through on the right frames, hold otherwise ---");
// Prototype methods, exactly like the vendor classes (CascadedShadowMaps /
// ShadowPass), so "no own property" means "the vendor method runs".
class StubMaps {
  constructor(log) { this.log = log; this.cascadeCount = 3; this.mapSize = new THREE.Vector2(512, 512); }
  update(camera, sunDirection, distance) { this.log.push(["maps", camera, sunDirection, distance]); }
}
class StubPass {
  constructor(log) { this.log = log; this.currentRenderTarget = { width: 512, height: 512, depth: 6 }; }
  update(renderer, frame, deltaTime) { this.log.push(["pass", renderer, frame, deltaTime]); }
}
function stubEffect() {
  const log = [];
  const camera = new THREE.PerspectiveCamera();
  camera.updateMatrixWorld(true);
  const eff = { log, camera, frame: 0, shadowMaps: new StubMaps(log), shadowPass: new StubPass(log) };
  // CloudsEffect.update's order: ++frame; updateSharedUniforms (→ shadowMaps.update); shadowPass.update.
  eff.update = (renderer, dt) => {
    ++eff.frame;
    eff.shadowMaps.update(eff.camera, "SUN", 1234);
    eff.shadowPass.update(renderer, eff.frame, dt);
  };
  return eff;
}
function runFrames(eff, n, perFrame) {
  const marched = [];
  for (let i = 0; i < n; i++) {
    if (perFrame) perFrame(i, eff);
    const before = eff.log.length;
    eff.update("R", 0.016);
    const calls = eff.log.slice(before);
    marched.push(calls.length ? calls : null);
  }
  return marched;
}
{
  const eff = stubEffect();
  const ctl = installCloudShadowCadence(eff, 1);
  check("N=1: nothing installed (no own update on either object -> the vendor methods run)",
    ctl.every === 1 && ctl.installed === false && !own(eff.shadowMaps, "update") && !own(eff.shadowPass, "update"));
  const m = runFrames(eff, 5);
  check("N=1: every frame marches with the EFFECT's frame (today's path)",
    m.every((calls, i) => calls && calls.length === 2 && calls[1][2] === i + 1));
}
{
  const eff = stubEffect();
  const ctl = installCloudShadowCadence(eff, 2);
  check("N=2: installed as own properties", ctl.installed && ctl.every === 2 &&
    own(eff.shadowMaps, "update") && own(eff.shadowPass, "update"));
  const m = runFrames(eff, 10);
  const ranAt = m.map((c, i) => (c ? i : -1)).filter((i) => i >= 0);
  check("N=2: marches on frames 0,2,4,6,8 only", ranAt.join(",") === "0,2,4,6,8", ranAt.join(","));
  check("N=2: each executed frame calls BOTH the cascade fit and the march, in order",
    m.filter(Boolean).every((c) => c.length === 2 && c[0][0] === "maps" && c[1][0] === "pass"));
  check("N=2: held frames call NEITHER (cascades + buffer frozen together)", m.filter((c) => !c).length === 5);
  check("N=2: own march frame 1,2,3,4,5 (consecutive STBN slices), not effect.frame 1,3,5,7,9",
    m.filter(Boolean).map((c) => c[1][2]).join(",") === "1,2,3,4,5");
  check("N=2: camera / sun / distance / renderer / dt passed through",
    m[0][0][1] === eff.camera && m[0][0][2] === "SUN" && m[0][0][3] === 1234 && m[0][1][1] === "R" && m[0][1][3] === 0.016);
  const d = ctl.diag();
  check("N=2: diag counts (10 frames, 5 runs, 5 skips, 1 forced = install)",
    d.every === 2 && d.frames === 10 && d.runs === 5 && d.skips === 5 && d.forced === 1 && d.lastForced === "install" && d.marchFrame === 5,
    JSON.stringify(d));
}
{
  const eff = stubEffect();
  installCloudShadowCadence(eff, 3);
  const m = runFrames(eff, 10);
  const ranAt = m.map((c, i) => (c ? i : -1)).filter((i) => i >= 0);
  check("N=3: marches on frames 0,3,6,9", ranAt.join(",") === "0,3,6,9", ranAt.join(","));
}
{
  // Forced runs, each restarting the cadence.
  const eff = stubEffect();
  const ctl = installCloudShadowCadence(eff, 3);
  const m = runFrames(eff, 12, (i, e) => {
    if (i === 1) e.shadowMaps.cascadeCount = 4;                       // preset change
    if (i === 5) e.shadowMaps.mapSize.set(1024, 1024);                 // ?cloudShadowRes / preset
    if (i === 7) e.shadowPass.currentRenderTarget = { width: 1024, height: 1024, depth: 4 }; // temporalPass toggle
    if (i === 9) { e.camera.position.x += CLOUD_SHADOW_JUMP_M + 5; e.camera.updateMatrixWorld(true); } // teleport
  });
  const ranAt = m.map((c, i) => (c ? i : -1)).filter((i) => i >= 0);
  check("forced on cascade-count change (1), map-size change (5), target swap (7), camera jump (9); cadence restarts",
    ranAt.join(",") === "0,1,4,5,7,9", ranAt.join(","));
  const d = ctl.diag();
  check("forced counted (install + 4), lastForced = jump", d.forced === 5 && d.lastForced === "jump", JSON.stringify(d));
}
{
  // Running-speed motion (0.5 m/frame) never forces; the depth of the target alone does.
  const eff = stubEffect();
  installCloudShadowCadence(eff, 2);
  const m = runFrames(eff, 8, (i, e) => { e.camera.position.z += 0.5; e.camera.updateMatrixWorld(true); });
  check("0.5 m/frame camera motion: plain N=2 cadence (no jump forcing)",
    m.map((c) => (c ? 1 : 0)).join("") === "10101010");
  const eff2 = stubEffect();
  installCloudShadowCadence(eff2, 2);
  const m2 = runFrames(eff2, 4, (i, e) => { if (i === 1) e.shadowPass.currentRenderTarget.depth = 3; });
  check("target depth change alone forces (cascade count via setSize); cadence restarts from it",
    m2.map((c) => (c ? 1 : 0)).join("") === "1101", m2.map((c) => (c ? 1 : 0)).join(""));
}
{
  // Fallback: shadowPass.update called without a cascade fit this frame.
  const eff = stubEffect();
  installCloudShadowCadence(eff, 2);
  const calls = [];
  for (let i = 0; i < 4; i++) {
    const before = eff.log.length;
    eff.shadowPass.update("R", 99, 0.016);
    calls.push(eff.log.length - before);
  }
  check("fallback: shadowPass alone still follows the cadence (1,0,1,0)", calls.join(",") === "1,0,1,0");
}
{
  // Live setEvery: to 1 restores the prototype; back to 2 re-installs + forces.
  const eff = stubEffect();
  const ctl = installCloudShadowCadence(eff, 2);
  runFrames(eff, 3);
  check("setEvery(1) -> 1 and the wrappers are removed", ctl.setEvery(1) === 1 && !ctl.installed &&
    !own(eff.shadowMaps, "update") && !own(eff.shadowPass, "update") &&
    eff.shadowMaps.update === StubMaps.prototype.update && eff.shadowPass.update === StubPass.prototype.update);
  const f0 = eff.frame;
  const m1 = runFrames(eff, 3);
  check("…every frame marches again with effect.frame", m1.every((c, i) => c && c.length === 2 && c[1][2] === f0 + i + 1));
  check("setEvery junk / negative -> unchanged", ctl.setEvery("x") === 1 && ctl.setEvery(-2) === 1);
  check("setEvery(4) re-installs", ctl.setEvery(4) === 4 && ctl.installed && own(eff.shadowPass, "update"));
  const m4 = runFrames(eff, 5);
  check("…and forces the first frame after install, then every 4th", m4.map((c) => (c ? 1 : 0)).join("") === "10001");
  check("setEvery clamps to MAX", ctl.setEvery(1000) === CLOUD_SHADOW_EVERY_MAX);
  // An own (pre-existing) update survives install/uninstall.
  const eff2 = stubEffect();
  const preOwn = function preOwn() {};
  eff2.shadowPass.update = preOwn;
  const ctl2 = installCloudShadowCadence(eff2, 2);
  ctl2.uninstall();
  check("uninstall restores a pre-existing own update, not the prototype", eff2.shadowPass.update === preOwn &&
    !own(eff2.shadowMaps, "update") && ctl2.every === 1);
  check("an effect without shadow passes: nothing installed, every 1",
    installCloudShadowCadence({}, 2).every === 1 && installCloudShadowCadence(null, 3).installed === false);
}

// ---------------------------------------------------------------------------
console.log("\n-- C3 REAL CloudVolume + vendored CloudsEffect.update ----------------");
function realVolume(search) {
  window.location.search = search;
  const camera = new THREE.PerspectiveCamera(60, 800 / 600, 0.1, 5000);
  camera.position.set(100, 60, -200);
  camera.lookAt(150, 400, -900);
  camera.updateMatrixWorld(true);
  const vol = new CloudVolume({ camera });
  const eff = vol.effect;
  eff.sunDirection.set(0.3, 0.8, 0.2).normalize();
  // GPU draws stubbed; everything else (cascade fit, copies, swaps) is vendor code.
  const draws = [];
  const sp = eff.shadowPass, cp = eff.cloudsPass;
  sp.currentPass.render = () => draws.push("shadow");
  sp.resolvePass.render = () => draws.push("shadowResolve");
  cp.currentPass.render = () => draws.push("clouds");
  cp.resolvePass.render = () => draws.push("cloudsResolve");
  return { vol, eff, camera, draws };
}
function step(s) {
  // Walk a little each frame so a re-fit cascade WOULD differ.
  s.camera.position.x += 0.4;
  s.camera.updateMatrixWorld(true);
  s.draws.length = 0;
  s.eff.update(null, null, 1 / 60);
  const cu = s.eff.cloudsPass.currentMaterial.uniforms;
  return {
    draws: s.draws.join(" "),
    shadowBuffer: s.eff.cloudsPass.shadowBuffer,
    m0: cu.shadowMatrices.value[0].clone(),
    m2: cu.shadowMatrices.value[2].clone(),
    inv0: s.eff.shadowPass.currentMaterial.uniforms.inverseShadowMatrices.value[0].clone(),
    far: cu.shadowFar.value,
    shadowFrame: s.eff.shadowPass.currentMaterial.uniforms.frame.value,
    effFrame: s.eff.frame,
    apShadowMap: s.eff.atmosphereShadow ? s.eff.atmosphereShadow.map : null,
  };
}
{
  const s = realVolume(""); // default
  check("default URL -> N=2 installed on the real effect", s.vol._shadowCadence.every === 2 &&
    own(s.eff.shadowMaps, "update") && own(s.eff.shadowPass, "update"));
  const f = [];
  for (let i = 0; i < 7; i++) f.push(step(s));
  check("march + resolve on frames 0,2,4,6; clouds march + resolve every frame",
    f.every((x, i) => x.draws === (i % 2 === 0 ? "shadow shadowResolve clouds cloudsResolve" : "clouds cloudsResolve")),
    f.map((x) => x.draws).join(" | "));
  const held = [1, 3, 5];
  check("held frame: clouds pass reads the SAME shadow buffer as the frame before (no swap)",
    held.every((i) => f[i].shadowBuffer === f[i - 1].shadowBuffer));
  check("held frame: SAME cascade matrices (0 and 2), inverse matrices and far although the camera moved",
    held.every((i) => f[i].m0.equals(f[i - 1].m0) && f[i].m2.equals(f[i - 1].m2) &&
      f[i].inv0.equals(f[i - 1].inv0) && f[i].far === f[i - 1].far));
  check("executed frame: cascades re-fit (camera moved) and the buffer swapped",
    [2, 4, 6].every((i) => !f[i].m0.equals(f[i - 1].m0) && f[i].shadowBuffer !== f[i - 1].shadowBuffer));
  check("AerialPerspective's shadow map tracks the same buffer", f.every((x) => x.apShadowMap === x.shadowBuffer));
  check("shadow `frame` uniform 1,1,2,2,3,3,4 (one STBN slice per march); effect.frame 1..7",
    f.map((x) => x.shadowFrame).join(",") === "1,1,2,2,3,3,4" && f.map((x) => x.effFrame).join(",") === "1,2,3,4,5,6,7",
    f.map((x) => x.shadowFrame).join(","));
  // Quality-preset change on a would-be held frame -> forced (resized targets + new cascade).
  s.eff.qualityPreset = "ultra"; // mapSize 1024
  const g = step(s);
  check("preset change on a held-phase frame forces a march (resize)",
    g.draws === "shadow shadowResolve clouds cloudsResolve" && s.vol.shadowCadenceDiag().lastForced === "resize");
  s.vol.dispose();
  check("dispose drops the wrappers", !own(s.eff.shadowMaps, "update") && !own(s.eff.shadowPass, "update"));
}
{
  const s = realVolume("?cloudShadowEvery=1");
  check("?cloudShadowEvery=1: nothing installed (vendor prototype methods)", s.vol._shadowCadence.every === 1 &&
    !own(s.eff.shadowMaps, "update") && !own(s.eff.shadowPass, "update"));
  const f = [];
  for (let i = 0; i < 5; i++) f.push(step(s));
  check("…march every frame with frame uniform === effect.frame (today's exact path)",
    f.every((x) => x.draws === "shadow shadowResolve clouds cloudsResolve" && x.shadowFrame === x.effFrame));
  check("…cascades re-fit every frame", f.slice(1).every((x, i) => !x.m0.equals(f[i].m0)));
}
{
  // Pair test: N=2 executed marches see the same inputs an N=1 run would at the same pose.
  const a = realVolume("?cloudShadowEvery=1");
  const b = realVolume("?cloudShadowEvery=2");
  const fa = [], fb = [];
  for (let i = 0; i < 5; i++) { fa.push(step(a)); fb.push(step(b)); }
  check("executed N=2 frames fit the same cascades as N=1 at the same pose (0, 2, 4)",
    [0, 2, 4].every((i) => fa[i].m0.equals(fb[i].m0) && fa[i].m2.equals(fb[i].m2) && fa[i].far === fb[i].far));
}

// ---------------------------------------------------------------------------
console.log("\n-- C4 diag + live setter ---------------------------------------------");
{
  const { cloudStateSnapshot } = await import("../scene3d/cloud_overlay.js");
  const s = realVolume("?cloudShadowEvery=3");
  for (let i = 0; i < 4; i++) step(s);
  const snap = cloudStateSnapshot({ volume: s.vol }, null);
  const sc = snap.shadowCadence;
  check("__cloudStateDiag().shadowCadence reports every=3 + counters",
    sc && sc.every === 3 && sc.installed === true && sc.runs === 2 && sc.skips === 2 && sc.marchFrame === 2,
    JSON.stringify(sc));
  window.liveScene3d = { cloudOverlay: { volume: s.vol } };
  check("window.__setCloudShadowEvery(1) -> vendor path", window.__setCloudShadowEvery(1) === 1 &&
    !own(s.eff.shadowPass, "update") && cloudStateSnapshot({ volume: s.vol }, null).shadowCadence.installed === false);
  check("window.__setCloudShadowEvery(2) -> re-installed", window.__setCloudShadowEvery(2) === 2 &&
    own(s.eff.shadowPass, "update"));
  delete window.liveScene3d;
  check("__setCloudShadowEvery without a scene -> null", window.__setCloudShadowEvery(2) === null);
}

// ---------------------------------------------------------------------------
console.log("\n-- C5 premises (vendored takram build) + wiring ------------------------");
{
  const vendor = readFileSync(path.join(APP, "vendor", "takram-three-clouds", "build", "index.js"), "utf8");
  check("CloudsEffect.update: ++frame; updateSharedUniforms; shadowPass.update(renderer, this.frame, …); buffer handed to the clouds pass",
    /\+\+this\.frame;\s*this\.updateSharedUniforms\(deltaTime\);\s*this\.updateWeatherTextureChannels\(\);\s*shadowPass\.update\(renderer, this\.frame, deltaTime\);\s*cloudsPass\.shadowBuffer = shadowPass\.outputBuffer;/.test(vendor));
  check("updateSharedUniforms fits the cascades via this.shadowMaps.update(", /this\.shadowMaps\.update\(\s*this\.camera,/.test(vendor));
  check("ShadowPass.update: frame uniform, copyShadow, march, resolve, copyReprojection, swapBuffers",
    /update\(renderer, frame, deltaTime\) \{\s*this\.currentMaterial\.uniforms\.frame\.value = frame;\s*this\.copyShadow\(\);\s*this\.currentPass\.render\(renderer, null, this\.currentRenderTarget\);\s*if \(this\.temporalPass\) \{[\s\S]{0,140}this\.copyReprojection\(\);\s*this\.swapBuffers\(\);/.test(vendor));
  check("CloudsPass.copyShadow copies the cascade matrices every frame (frozen cascades -> frozen matrices)",
    /currentUniforms\.shadowMatrices\.value\[i\]\.copy\(cascade\.matrix\);/.test(vendor));
  const stbn = readFileSync(path.join(APP, "vendor", "takram-three-clouds", "src", "shaders", "clouds.glsl"), "utf8");
  check("STBN slice = frame % depth (why the own counter matters)", stbn.includes("float(frame % size.z)"));
  const src = readFileSync(path.join(APP, "scene3d", "cloud_volume.js"), "utf8");
  check("constructor reads the flag once (no per-frame URL parsing)",
    (src.match(/parseCloudShadowEvery\(window\.location\.search\)/g) || []).length === 1);
  check("shadow temporalAlpha 0.05 still set (the EMA the cadence relies on)",
    /sm\.uniforms\.temporalAlpha\.value = 0\.05;/.test(src));
  const co = readFileSync(path.join(APP, "scene3d", "cloud_overlay.js"), "utf8");
  check("cloud_overlay cloudStateSnapshot exposes shadowCadence", /out\.shadowCadence = typeof vol\.shadowCadenceDiag === 'function'/.test(co));
}

delete globalThis.window;
console.log(`\ncloud shadow cadence: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
