// tests/particle_culled_lean.test.mjs — ?particleCulledLean (2026-10-17, default ON).
//
// RP6 re-asserts "culled ⇒ hidden" on every tick by walking each culled
// emitter's slot meshes (`_setPartsVisible(false)`). For an INSTANCED emitter
// those meshes are scene-detached transform carriers — the draw is the bucket
// instance `_appendInstances` writes, which a culled emitter never does — so
// the walk renders nothing (1070 profile: 82.6 ms of the 302 ms static tick,
// every static emitter instanced). Locks:
//   1. premise: an instanced emitter's slot meshes have no parent;
//   2. the bucket output (what is drawn) is identical tick for tick with the
//      flag on and off, through cull and re-entry;
//   3. a PER-MESH emitter is still hidden every tick with the flag on.
//
// Run from apps/holtburger-web/:  node tests/particle_culled_lean.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

globalThis.window ??= {};
globalThis.window.location ??= { search: "" };
globalThis.window.requestAnimationFrame ??= () => 0;
globalThis.window.cancelAnimationFrame ??= () => {};

const THREE = await import("three");
const { setCurrentTime, setRng } = await import("../scene3d/particles/time_rng.js");
const PM = await import("../scene3d/particles/particle_manager.js");

let t = 1000;
setCurrentTime(() => t);
let seed = 7;
setRng(() => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; });

const cam = new THREE.PerspectiveCamera(60, 1.6, 0.1, 10000);
window.liveScene3d = { cameraSwitcher: { activeCamera: cam }, camera: cam };
function camAt(z) {
  cam.position.set(0, 0, z);
  cam.lookAt(0, 0, z - 1);
  cam.updateMatrixWorld(true);
}

const info = () => ({
  id: 0x3200fff1, emitterType: 1, particleType: 1 /* Still */, gfxObjId: 0, hwGfxObjId: 0x010010f9,
  birthrate: 0.05, maxParticles: 8, initialParticles: 3, totalParticles: 0, totalSeconds: 0,
  lifespan: 1000, lifespanRand: 0, offsetDirX: 0, offsetDirY: 0, offsetDirZ: 0,
  minOffset: 0, maxOffset: 0, aX: 0, aY: 0, aZ: 0, minA: 0, maxA: 0,
  bX: 0, bY: 0, bZ: 0, cX: 0, cY: 0, cZ: 0, scaleRand: 0, startScale: 0.5, finalScale: 0.5,
  transRand: 0, startTrans: 0, finalTrans: 0, isParentLocal: false, billboard: false,
});

async function arm(lean, instancing) {
  PM.setParticleCulledLeanFlag(lean);
  t = 1000;
  seed = 7;
  const group = new THREE.Group();
  const anchor = new THREE.Object3D();
  anchor.position.set(0, 0, -10);
  group.add(anchor);
  group.updateMatrixWorld(true);
  const quad = new THREE.PlaneGeometry(1, 1);
  const mgr = new PM.ParticleManager({
    scene: group, instancing,
    geometryFactory: () => quad,
    materialFactory: () => new THREE.MeshBasicMaterial({ transparent: true, blending: THREE.AdditiveBlending }),
  });
  const id = await mgr.addEmitter({ emitterInfo: info(), parent: anchor });
  return { mgr, group, emitter: mgr.particleTable.get(id) };
}

const drawn = (mgr) => {
  let n = 0;
  for (const b of mgr._instBuckets.values()) n += b.im.count;
  return n;
};

// near (live) → 1500 m away (culled past the 220 m cap) → near again.
async function run(a) {
  const out = [];
  a.carriersShownWhileCulled = 0;
  const phases = [[0, 12], [1500, 18], [0, 12]];
  for (const [z, n] of phases) {
    camAt(z);
    for (let i = 0; i < n; i++) {
      t += 1 / 30;
      a.mgr.tick();
      out.push({ drawn: drawn(a.mgr), culled: a.emitter._rp6Culled === true });
      if (a.emitter._rp6Culled === true) {
        for (const m of a.emitter.parts) if (m && m.visible) a.carriersShownWhileCulled += 1;
      }
      await new Promise((r) => setImmediate(r));
    }
  }
  return out;
}

test("1+2. instanced: slots are detached; bucket output identical on/off", async () => {
  const on = await arm(true, true);
  assert.ok(on.emitter._instKey !== null && on.emitter._instKey !== undefined, "setup: emitter is instanced");
  const onRun = await run(on);
  for (const m of on.emitter.parts) if (m) assert.equal(m.parent, null, "slot mesh is scene-detached");
  const off = await arm(false, true);
  const offRun = await run(off);
  assert.ok(onRun.some((s) => s.culled) && onRun.some((s) => !s.culled && s.drawn > 0), "setup: cull + live phases hit");
  assert.deepEqual(onRun, offRun, "same drawn instances and cull state every tick");
  assert.ok(on.carriersShownWhileCulled > 0, "lean: the carrier walk was skipped while culled");
  assert.equal(off.carriersShownWhileCulled, 0, "legacy: the carriers were walked and hidden");
  // The skipped walk is visible only on the never-drawn carriers.
  const culledOnlyHidden = off.emitter.parts.filter(Boolean).every((m) => m.visible === true);
  assert.ok(culledOnlyHidden, "after re-entry both arms restore the carriers");
  PM.setParticleCulledLeanFlag(null);
});

test("3. per-mesh emitters are still hidden every culled tick", async () => {
  const a = await arm(true, false);
  assert.ok(a.emitter._instKey === null || a.emitter._instKey === undefined, "setup: per-mesh path");
  camAt(0);
  for (let i = 0; i < 12; i++) { t += 1 / 30; a.mgr.tick(); }
  camAt(1500);
  for (let i = 0; i < 18; i++) { t += 1 / 30; a.mgr.tick(); }
  assert.equal(a.emitter._rp6Culled, true);
  const parts = a.emitter.parts.filter(Boolean);
  assert.ok(parts.length > 0);
  for (const m of parts) m.visible = true; // a hostile writer
  t += 1 / 30; a.mgr.tick();
  assert.ok(parts.every((m) => m.visible === false), "re-hidden on the next tick");
  PM.setParticleCulledLeanFlag(null);
});
