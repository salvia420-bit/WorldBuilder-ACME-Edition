// tests/fx_distort_film_clock.test.mjs — distortion rings run on the FX clock
// (2026-10-18 systematic review, VFXAUDIO-5). scene3d/vfx/fx_distort.js.
//
// WHY: film mode (?filmMode=on, DEFAULT OFF) installs the film clock for a
// stepped take (film_clock.js → particle_fx.setFxTimeSource → fx_clock.js), and
// FxDistortEffect.update measures ring phase with fxNowMs(). fx_distort stamped
// t0 with performance.now(), so with the film clock behind wall time a ring's
// phase went negative, was never pruned, and the shader drew it as a frozen
// full-strength pinch instead of an expanding ring. The stamps now read
// fxNowMs() too; with no source installed that is performance.now(), as before.
//
// Run from apps/holtburger-web/: node tests/fx_distort_film_clock.test.mjs

import * as THREE from "three";

let passed = 0;
let failed = 0;
function check(name, ok, detail) {
  console.log(`  [${ok ? "OK" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
  if (ok) passed++; else failed++;
}

globalThis.window = globalThis.window || {};
globalThis.location = { search: "" };
window.location = globalThis.location;

const { fxNowMs, setFxClockSource } = await import("../scene3d/fx_clock.js");
const distort = await import("../scene3d/vfx/fx_distort.js");

const cam = new THREE.PerspectiveCamera(60, 1.6, 0.1, 5000);
cam.position.set(0, 1.5, 10); cam.lookAt(0, 1, 0); cam.updateMatrixWorld(true); cam.updateProjectionMatrix();
const out = [];
const rings = () => distort.collectFxDistortSources(cam, out, fxNowMs()).filter((s) => s.kind === distort.FX_DISTORT_KINDS.ring);

// a stepped take whose film clock runs a minute behind wall time
let film = performance.now() - 60000;
setFxClockSource(() => film);
distort._resetFxDistortForTest();
distort.spawnFxShockwave({ position: { x: 0, y: 1, z: 0 }, radius: 3, strength: 0.7, durationMs: 400 });
film += 100;
let r = rings();
check("5. a shockwave spawned in a take starts its ring at film time (phase ~0.25 after 100 film ms)",
  r.length === 1 && Math.abs(r[0].phase - 0.25) < 0.01, r.length ? `phase ${r[0].phase}` : "no ring");
film += 400;
r = rings();
check("5. …and is pruned once the film clock passes its duration", r.length === 0 && distort.fxDistortStats().sources === 0,
  r.length ? `phase ${r[0].phase}` : "");

distort._resetFxDistortForTest();
const burst = distort.addFxDistortSource({ resolvePosition: (o) => { o.set(1, 1, 0); return true; }, kind: distort.FX_DISTORT_KINDS.ring, strength: 0.6, radius: 2 });
film += 325;
r = rings();
check("5. an emitter-bound ring is stamped on the film clock too (phase 0.5 at 325 of 650 ms)",
  !!burst && r.length === 1 && Math.abs(r[0].phase - 0.5) < 0.01, r.length ? `phase ${r[0].phase}` : "no ring");

setFxClockSource(null);
distort._resetFxDistortForTest();
const live = distort.spawnFxShockwave({ position: { x: 0, y: 1, z: 0 }, durationMs: 400 });
const now = performance.now();
check("5. no source installed: the stamp is performance.now(), as before", !!live && live.t0 <= now && now - live.t0 < 50,
  live ? `t0 ${live.t0} vs ${now}` : "");
distort._resetFxDistortForTest();

console.log(`\n[fx_distort_film_clock] ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
