// tests/particle_tick_once.test.mjs — ?particleTickOnce (2026-10-17, default ON).
//
// statics.js loads as TWO module instances on the unbundled page
// (`./statics.js?v=phase7-par` from scene3d/index.js, `./statics.js` from
// loop.js / cells.js), and each arms its own `_spLoop` rAF that ticks the ONE
// shared static ParticleManager — two full ticks per frame (1070 profile:
// 196 + 143 ms of 7.25 s; live probe: 14 ticks in 7 frames). `tickFrame(ts)`
// drops the second driver of a frame. Locks:
//   1. same rAF timestamp → the second call is a no-op; a new timestamp ticks;
//   2. `?particleTickOnce=off` and a non-number timestamp tick every call;
//   3. RP6's re-check cadence in FRAMES is unchanged: an emitter coming back
//      into view is un-culled on the same frame as under the double tick.
//
// Run from apps/holtburger-web/:  node tests/particle_tick_once.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

globalThis.window ??= {};
globalThis.window.location ??= { search: "" };
globalThis.window.requestAnimationFrame ??= () => 0;
globalThis.window.cancelAnimationFrame ??= () => {};

const THREE = await import("three");
const { setCurrentTime } = await import("../scene3d/particles/time_rng.js");
const PM = await import("../scene3d/particles/particle_manager.js");

let t = 1000;
setCurrentTime(() => t);

function emitterPojo() {
  return {
    id: 0, emitterType: 1, particleType: 1 /* Still */, gfxObjId: 0, hwGfxObjId: 0x010010F9,
    birthrate: 0.1, maxParticles: 2, initialParticles: 1, totalParticles: 0, totalSeconds: 0,
    lifespan: 1000, lifespanRand: 0, offsetDirX: 0, offsetDirY: 0, offsetDirZ: 0,
    minOffset: 0, maxOffset: 0, aX: 0, aY: 0, aZ: 0, minA: 0, maxA: 0,
    bX: 0, bY: 0, bZ: 0, cX: 0, cY: 0, cZ: 0,
    scaleRand: 0, startScale: 0.45, finalScale: 0.45, transRand: 0,
    startTrans: 0, finalTrans: 0, isParentLocal: true, billboard: false,
  };
}

function quad() {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(new Float32Array([
    -0.1, 0, -0.1, 0.1, 0, -0.1, 0.1, 0, 0.1]), 3));
  return g;
}

const cam = new THREE.PerspectiveCamera(60, 1.6, 0.1, 10000);
window.liveScene3d = { cameraSwitcher: { activeCamera: cam }, camera: cam };
function look(z) {
  cam.position.set(0, 0, 0);
  cam.lookAt(0, 0, z);
  cam.updateMatrixWorld(true);
}

async function makeManager() {
  const geom = quad();
  const mgr = new PM.ParticleManager({
    scene: new THREE.Group(),
    geometryFactory: () => geom,
    materialFactory: () => new THREE.MeshBasicMaterial({ transparent: true }),
  });
  await mgr.addEmitter({
    emitterInfo: emitterPojo(),
    parent: { position: new THREE.Vector3(0, 0, -50), quaternion: new THREE.Quaternion() },
    partIndex: -1,
  });
  let emitter = null;
  for (const [, e] of mgr.particleTable) emitter = e;
  return { mgr, emitter };
}

test("1. one tick per rAF timestamp; a new frame ticks again", async () => {
  PM.setParticleTickOnceFlag(null);
  const { mgr } = await makeManager();
  const f0 = mgr._rp6Frame;
  assert.equal(mgr.tickFrame(16.6), true);
  assert.equal(mgr.tickFrame(16.6), false, "second driver of the same frame is dropped");
  assert.equal(mgr._rp6Frame - f0, 1);
  assert.equal(mgr._frameDupDrivers, true, "the duplicate driver was noticed");
  assert.equal(mgr.tickFrame(33.3), true);
  assert.equal(mgr._rp6Frame - f0, 2);
});

test("2. flag off / no timestamp: every call ticks (legacy)", async () => {
  PM.setParticleTickOnceFlag(false);
  const { mgr } = await makeManager();
  const f0 = mgr._rp6Frame;
  mgr.tickFrame(16.6);
  mgr.tickFrame(16.6);
  assert.equal(mgr._rp6Frame - f0, 2);
  assert.equal(mgr._frameDupDrivers, false);
  PM.setParticleTickOnceFlag(null);
  const { mgr: m2 } = await makeManager();
  const g0 = m2._rp6Frame;
  m2.tickFrame(undefined);
  m2.tickFrame(undefined);
  assert.equal(m2._rp6Frame - g0, 2, "no rAF timestamp → no dedupe");
});

// Two drivers per frame (the two statics.js instances). Returns the frame on
// which an emitter that was culled behind the camera is un-culled after the
// camera turns back to face it.
async function reentryFrame(flagOn) {
  PM.setParticleTickOnceFlag(flagOn);
  const { mgr, emitter } = await makeManager();
  let frame = 0;
  const step = () => {
    frame += 1;
    t += 1 / 30;
    const ts = frame * 33.3;
    mgr.tickFrame(ts);
    mgr.tickFrame(ts); // the second module instance's loop
  };
  look(-1);
  for (let i = 0; i < 12; i++) step();
  look(1); // turn away: the emitter at z=-50 is now behind the camera
  for (let i = 0; i < 12; i++) step();
  assert.equal(emitter._rp6Culled, true, "setup: culled while behind the camera");
  // Align both runs to the same phase of the frame counter before turning back.
  while (frame % 6 !== 0) step();
  look(-1);
  const turnedAt = frame;
  for (let i = 0; i < 12 && emitter._rp6Culled === true; i++) step();
  return frame - turnedAt;
}

test("3. RP6 re-entry latency (frames) is unchanged by the dedupe", async () => {
  const legacy = await reentryFrame(false);
  const once = await reentryFrame(true);
  assert.ok(legacy >= 1 && legacy <= 3, `legacy double tick re-checks every 3 frames (got ${legacy})`);
  assert.equal(once, legacy, `deduped manager un-culls on the same frame (legacy ${legacy}, once ${once})`);
  PM.setParticleTickOnceFlag(null);
});
