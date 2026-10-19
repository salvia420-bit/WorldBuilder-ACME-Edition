// tests/retail_fov.test.mjs — models-camera-2 (2026-10-13): retail world
// camera FOV. `?retailFov` is DEFAULT ON since 2026-10-19 (flipped ahead of
// its 1070 eye test, still owed); `?retailFov=off` (or 0/false/no) is the
// escape back to the fixed 60° vertical FOV. Until then only an exact `=on`
// enabled it.
//
// Retail never stores a vertical FOV: the SmartBox draw sets it every frame
// from the Render.FieldOfView preference, `m_fGameFOV / (aspect - 0.1)` →
// Render::SetFOVRad (acclient.c:144897; refuses ≤ 0 / ≥ π, :378905) →
// D3DXMatrixPerspectiveFovLH fovY (:453039). m_fGameFOV defaults to π/2
// (ctor :145517, raw 1070141403); the preference range is 10..160
// (SetPreferenceRange :63316).
//
//   F1  retailVerticalFovDeg: 16:9 / 4:3 / 21:9 values, refused inputs → null.
//   F2  applyRetailFov on a real THREE.PerspectiveCamera: fovY + the ~83.9°
//       horizontal FOV at 16:9; a refused value keeps the previous fov.
//   F3  helpers: the default-ON reader (off/0/false/no escape), clampGameFovDeg,
//       the f32 default constant.
//   F4  ui/camera_settings.js: on the bare default the slider is listed,
//       persists + drives __setGameFov (an explicit `=on` too); under
//       `?retailFov=off` there is no Field of View row and no setter push.
//   F5  source pins: index.js still builds the camera at 60° (the `=off` value
//       and the refused-value fallback) and every retail-FOV write is gated
//       on RETAIL_FOV_ON.
//
// Run: node tests/retail_fov.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import { installFakeDom, typeInto } from "./helpers/social_fake_dom.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(HERE, "..");

globalThis.window = globalThis;
globalThis.location = { search: "" };
const { document } = installFakeDom(globalThis);

const M = await import("../scene3d/camera_math.js");
const S = await import("../ui/camera_settings.js");

let passed = 0;
let failed = 0;
function check(label, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  [PASS] ${label}`);
  } catch (err) {
    failed += 1;
    console.log(`  [FAIL] ${label} — ${err.stack || err.message}`);
  }
}
const near = (a, b, eps, what) =>
  assert.ok(Math.abs(a - b) <= eps, `${what}: ${a} not within ${eps} of ${b}`);

console.log("── F1 retailVerticalFovDeg ──");

check("90° game FOV at 16:9 → 53.64° vertical", () => {
  near(M.retailVerticalFovDeg(90, 16 / 9), 53.64, 0.01, "16:9");
});
check("90° game FOV at 4:3 → 72.97° vertical", () => {
  near(M.retailVerticalFovDeg(90, 4 / 3), 72.97, 0.01, "4:3");
});
check("90° game FOV at 21:9 → 40.30° vertical", () => {
  near(M.retailVerticalFovDeg(90, 21 / 9), 40.30, 0.01, "21:9");
});
check("aspect ≤ 0.1 → null (Render::SetFOVRad refuses ≤ 0 / non-finite)", () => {
  assert.equal(M.retailVerticalFovDeg(90, 0.1), null);
  assert.equal(M.retailVerticalFovDeg(90, 0.05), null);
  assert.equal(M.retailVerticalFovDeg(90, NaN), null);
  assert.equal(M.retailVerticalFovDeg(0, 16 / 9), null);
  assert.equal(M.retailVerticalFovDeg(-30, 16 / 9), null);
});
check("a game FOV giving ≥ π → null (160° at aspect 0.9 = 200°)", () => {
  assert.equal(M.retailVerticalFovDeg(160, 0.9), null);
  assert.equal(M.retailVerticalFovDeg(90, 0.4), null); // π/2 / 0.3 > π
});
check("just under π is accepted (160° at 1:1 ≈ 177.8°)", () => {
  near(M.retailVerticalFovDeg(160, 1), 177.78, 0.01, "160° square");
});

console.log("── F2 applyRetailFov on a THREE.PerspectiveCamera ──");

check("16:9 camera: fovY 53.64°, horizontal ≈ 83.9° (holtburger 60° was 91.5°)", () => {
  const cam = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 5000);
  const legacyH = 2 * Math.atan(1 / cam.projectionMatrix.elements[0]) * 180 / Math.PI;
  near(legacyH, 91.49, 0.02, "legacy horizontal");
  assert.equal(M.applyRetailFov(cam, 90), true);
  cam.updateProjectionMatrix();
  near(cam.fov, 53.64, 0.01, "fovY");
  const h = 2 * Math.atan(1 / cam.projectionMatrix.elements[0]) * 180 / Math.PI;
  near(h, 83.9, 0.05, "horizontal");
});
check("horizontal FOV stays within 81..90° from 4:3 to 21:9", () => {
  for (const aspect of [4 / 3, 16 / 10, 16 / 9, 21 / 9]) {
    const cam = new THREE.PerspectiveCamera(60, aspect, 0.1, 5000);
    M.applyRetailFov(cam, 90);
    cam.updateProjectionMatrix();
    const h = 2 * Math.atan(1 / cam.projectionMatrix.elements[0]) * 180 / Math.PI;
    assert.ok(h > 80.5 && h < 90, `aspect ${aspect.toFixed(3)} → ${h.toFixed(2)}°`);
  }
});
check("a refused value keeps the previous fov (retail keeps its projection)", () => {
  const cam = new THREE.PerspectiveCamera(60, 0.4, 0.1, 5000);
  assert.equal(M.applyRetailFov(cam, 90), false);
  assert.equal(cam.fov, 60);
  assert.equal(M.applyRetailFov(null, 90), false);
});
check("bare default: a 16:9 world camera gets 53.64°; ?retailFov=off keeps 60°", () => {
  // The index.js construction path: build at 60°, then apply the retail
  // vertical FOV when the gate reads ON.
  const build = (search) => {
    const cam = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 5000);
    if (M.retailFovEnabled(search) && M.applyRetailFov(cam, M.RETAIL_GAME_FOV_DEFAULT_DEG)) {
      cam.updateProjectionMatrix();
    }
    return cam.fov;
  };
  near(build(""), 53.64, 0.01, "bare default");
  near(build("?retailFov=on"), 53.64, 0.01, "=on");
  assert.equal(build("?retailFov=off"), 60);
  assert.equal(build("?retailFov=0"), 60);
});

console.log("── F3 helpers ──");

check("retailFovEnabled: DEFAULT ON (absent / on / any other value)", () => {
  assert.equal(M.retailFovEnabled(""), true);
  assert.equal(M.retailFovEnabled(undefined), true);
  assert.equal(M.retailFovEnabled("?nosw=1"), true);
  assert.equal(M.retailFovEnabled("?retailFov"), true);
  assert.equal(M.retailFovEnabled("?retailFov="), true);
  assert.equal(M.retailFovEnabled("?retailFov=on"), true);
  assert.equal(M.retailFovEnabled("?retailFov=ON"), true);
  assert.equal(M.retailFovEnabled("?retailFov=1"), true);
  assert.equal(M.retailFovEnabled("?retailFov=true"), true);
  assert.equal(M.retailFovEnabled("?nosw=1&retailFov=on"), true);
});
check("retailFovEnabled: off/0/false/no escape (trimmed, any case)", () => {
  for (const v of ["off", "0", "false", "no", "OFF", "Off", "FALSE", "No", "%20off%20"]) {
    assert.equal(M.retailFovEnabled(`?retailFov=${v}`), false, `?retailFov=${v}`);
  }
  assert.equal(M.retailFovEnabled("?nosw=1&retailFov=off"), false);
});
check("clampGameFovDeg: junk → 90, clamped to the retail 10..160 range", () => {
  assert.equal(M.clampGameFovDeg(undefined), 90);
  assert.equal(M.clampGameFovDeg(null), 90);
  assert.equal(M.clampGameFovDeg("abc"), 90);
  assert.equal(M.clampGameFovDeg(NaN), 90);
  assert.equal(M.clampGameFovDeg(5), 10);
  assert.equal(M.clampGameFovDeg(400), 160);
  assert.equal(M.clampGameFovDeg("75"), 75);
  assert.equal(M.clampGameFovDeg(110), 110);
});
check("default 90° = the ctor's raw f32 1070141403 (π/2)", () => {
  const dv = new DataView(new ArrayBuffer(4));
  dv.setUint32(0, 1070141403);
  near(dv.getFloat32(0) * 180 / Math.PI, M.RETAIL_GAME_FOV_DEFAULT_DEG, 1e-4, "f32");
  assert.equal(M.RETAIL_GAME_FOV_MIN_DEG, 10);
  assert.equal(M.RETAIL_GAME_FOV_MAX_DEG, 160);
  assert.equal(M.LEGACY_VERTICAL_FOV_DEG, 60);
});

console.log("── F4 ui/camera_settings.js ──");

const labels = (host) => host.querySelectorAll("label").map((l) => l.textContent);
const fovCalls = [];
globalThis.__setGameFov = (v) => { fovCalls.push(v); return v; };

check("loadCameraState default carries fieldOfView 90", () => {
  localStorage.removeItem("holtburger_camera_v1");
  assert.equal(S.loadCameraState().fieldOfView, 90);
});
check("?retailFov=off: no Field of View row and no __setGameFov push", () => {
  globalThis.location = { search: "?retailFov=off" };
  const host = document.createElement("div");
  document.body.appendChild(host);
  S.renderCameraTab(host);
  const ls = labels(host);
  assert.ok(ls.includes("Stiffness"), `camera rows rendered: ${ls.join(", ")}`);
  assert.ok(!ls.includes("Field of View"), "no FOV row under ?retailFov=off");
  fovCalls.length = 0;
  S.applyCameraState({ fieldOfView: 75 });
  assert.deepEqual(fovCalls, []);
  for (const v of ["0", "false", "no", "OFF"]) {
    globalThis.location = { search: `?retailFov=${v}` };
    S.applyCameraState({ fieldOfView: 75 });
  }
  assert.deepEqual(fovCalls, [], "every escape form skips the push");
  host.remove();
  globalThis.location = { search: "" };
});
check("explicit ?retailFov=on still lists the row and pushes the setter", () => {
  globalThis.location = { search: "?retailFov=on" };
  const host = document.createElement("div");
  document.body.appendChild(host);
  S.renderCameraTab(host);
  assert.ok(labels(host).includes("Field of View"), "FOV row under =on");
  fovCalls.length = 0;
  S.applyCameraState({ fieldOfView: 80 });
  assert.deepEqual(fovCalls, [80]);
  host.remove();
  globalThis.location = { search: "" };
});
check("bare default: the slider (10..160, default 90) persists and drives __setGameFov", () => {
  globalThis.location = { search: "" };
  localStorage.removeItem("holtburger_camera_v1");
  const host = document.createElement("div");
  document.body.appendChild(host);
  S.renderCameraTab(host);
  const lbl = host.querySelectorAll("label").find((l) => l.textContent === "Field of View");
  assert.ok(lbl, "FOV row rendered on the bare default");
  const input = lbl.parentNode.querySelector("input");
  assert.equal(input.min, "10");
  assert.equal(input.max, "160");
  assert.equal(input.value, "90");
  fovCalls.length = 0;
  typeInto(input, "70");
  assert.deepEqual(fovCalls, [70]);
  assert.equal(JSON.parse(localStorage.getItem("holtburger_camera_v1")).fieldOfView, 70);
  S.applyCameraState({ fieldOfView: 75 });
  assert.deepEqual(fovCalls, [70, 75]);
  host.remove();
  globalThis.location = { search: "" };
});

console.log("── F5 source pins ──");

const indexSrc = readFileSync(path.join(APP, "scene3d", "index.js"), "utf8");
check("index.js still constructs the world camera at 60° (=off value / refused-value fallback)", () => {
  assert.ok(
    indexSrc.includes("new THREE.PerspectiveCamera(60, cssW / cssH, 0.1, 5000)"),
    "60° PerspectiveCamera ctor",
  );
});
check("index.js reads the gate through retailFovEnabled", () => {
  assert.match(indexSrc, /const RETAIL_FOV_ON = retailFovEnabled\(/);
});
check("every applyRetailFov / __setGameFov write sits under RETAIL_FOV_ON", () => {
  const block = indexSrc.match(/if \(RETAIL_FOV_ON\) \{([\s\S]*?)\n  \}\n/);
  assert.ok(block, "construction block gated on RETAIL_FOV_ON");
  assert.ok(block[1].includes("applyRetailFov(camera, _retailGameFovDeg)"));
  assert.ok(block[1].includes("window.__setGameFov = "));
  assert.match(
    indexSrc,
    /camera\.aspect = newW \/ newH;[\s\S]{0,300}?if \(RETAIL_FOV_ON\) applyRetailFov\(camera, _retailGameFovDeg\);\s*camera\.updateProjectionMatrix\(\);/,
    "resize handler re-derives fovY only under RETAIL_FOV_ON (skipped under =off)",
  );
  const calls = indexSrc.match(/applyRetailFov\(/g) || [];
  assert.equal(calls.length, 3, "construction + setter + resize only");
  const setters = indexSrc.match(/__setGameFov\s*=/g) || [];
  assert.equal(setters.length, 1);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
