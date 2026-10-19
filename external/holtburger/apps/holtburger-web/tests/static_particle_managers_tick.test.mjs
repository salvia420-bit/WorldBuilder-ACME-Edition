// tests/static_particle_managers_tick.test.mjs — statics.js drives EVERY static
// ParticleManager (2026-10-18 review follow-up, §10.5 "Statics,
// `?eagerDungeons=on` only").
//
// A static manager lives on its scene object (`scene3d._staticParticleManager`).
// `?eagerDungeons=on` builds its dungeons on `scene3dForBuilders` while the
// per-LB loaders use the liveScene3d facade, so a session holds two. statics.js
// loaded as two module instances until 2026-10-18 and each copy's `_spLoop`
// ticked its own manager; with one instance the loop ticked only the LAST
// manager ensured, so the other one's emitters froze. Separately, two first
// attaches on ONE scene that overlapped built two managers, orphaning the
// first one's emitters (they froze the same way).
//   M1  default path (one manager, ensured over and over): the rAF loop ticks it
//       exactly once per frame
//   M2  two scenes (the eager dungeons): every frame ticks both, whichever was
//       ensured last
//   M3  overlapping first attaches on one scene share ONE manager (the real
//       construction path)
//   M4  `?particleClock=loop|sim` driver (tickStaticParticles): each live
//       manager once per call
//   M5  disposeStaticParticles drops its scene's manager from the drivers
//
// Drives the shipped attachSkyParticleChain (→ `_ensureStaticParticleManager`)
// and a fake browser rAF queue. Run from apps/holtburger-web/:
//   node tests/static_particle_managers_tick.test.mjs

import assert from "node:assert/strict";
import * as THREE from "three";

// A browser-like rAF queue: one `frame(ts)` runs every callback registered
// since the previous frame (statics.js arms its `_spLoop` at module load).
let rafQueue = new Map();
let rafId = 0;
globalThis.window ??= {};
globalThis.window.location ??= { search: "" };
globalThis.window.requestAnimationFrame = (cb) => { rafQueue.set(++rafId, cb); return rafId; };
globalThis.window.cancelAnimationFrame = (id) => { rafQueue.delete(id); };
function frame(ts) {
  const q = rafQueue;
  rafQueue = new Map();
  for (const cb of q.values()) {
    try { cb(ts); } catch (_) { /* another module's loop: not under test */ }
  }
}

const S = await import("../scene3d/statics.js");

let passed = 0;
let failed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log(`  [PASS] ${name}`); }
  catch (e) { failed++; console.log(`  [FAIL] ${name} — ${(e && e.stack) || e}`); }
}

// No hooks: the chain walk ends at once, after the manager is ensured.
const wasm = {
  fetchPhysicsScript: async () => ({ takeEntries: () => [], free() {} }),
  fetchBuildingPlacement: async () => ({ partCount: 0, free() {} }),
  fetch_surfaces_pixels: async () => [],
};
const PES = 0x33000001;
const ensure = (host) => S.attachSkyParticleChain(host, new THREE.Object3D(), PES, wasm);

/** Count a manager's driver calls per rAF timestamp (its real tick is not run). */
function counted(mgr) {
  const frames = new Map();
  mgr.tickFrame = (ts) => { frames.set(ts, (frames.get(ts) || 0) + 1); return true; };
  let ticks = 0;
  mgr.tick = () => { ticks += 1; };
  return { at: (ts) => frames.get(ts) || 0, ticks: () => ticks };
}
/** A host scene whose manager the real `_buildStaticParticleManager` builds. */
async function builtHost() {
  const host = { staticsGroup: new THREE.Group() };
  await ensure(host);
  assert.ok(host._staticParticleManager, "the real construction path built a manager");
  return host;
}

let ts = 0;
const nextTs = () => (ts += 16.6);

const A = await builtHost();
const a = counted(A._staticParticleManager);

await t("M1 one manager, ensured again and again: one tick per frame", async () => {
  for (let i = 0; i < 3; i++) {
    await ensure(A);
    const f = nextTs();
    frame(f);
    assert.equal(a.at(f), 1, `frame ${i}`);
  }
});

const B = await builtHost(); // the eager-dungeon scene
const b = counted(B._staticParticleManager);

await t("M2 two scenes' managers: both tick every frame, whichever was ensured last", async () => {
  assert.notEqual(A._staticParticleManager, B._staticParticleManager);
  for (const last of [B, A, B]) {
    await ensure(last);
    const f = nextTs();
    frame(f);
    assert.deepEqual([a.at(f), b.at(f)], [1, 1], `ensured last: ${last === A ? "A" : "B"}`);
  }
});

await t("M3 overlapping first attaches on one scene share one manager", async () => {
  const host = { staticsGroup: new THREE.Group() };
  const built = [];
  let cur;
  Object.defineProperty(host, "_staticParticleManager", {
    get: () => cur,
    set: (m) => { cur = m; built.push(m); },
    configurable: true,
  });
  await Promise.all([ensure(host), ensure(host), ensure(host)]);
  assert.equal(built.length, 1, `managers built for one scene: ${built.length}`);
  const c = counted(cur);
  const f = nextTs();
  frame(f);
  assert.equal(c.at(f), 1, "and the loop ticks it");
});

await t("M4 tickStaticParticles ticks each live manager once", () => {
  const before = [a.ticks(), b.ticks()];
  S.tickStaticParticles({}); // a facade without its own manager (falls back to the last ensured)
  assert.deepEqual([a.ticks() - before[0], b.ticks() - before[1]], [1, 1]);
  S.tickStaticParticles(A);
  assert.deepEqual([a.ticks() - before[0], b.ticks() - before[1]], [2, 2], "the scene's own manager is not ticked twice");
});

// LAST: disposeStaticParticles also latches this module's `_spLoop` off.
await t("M5 disposeStaticParticles drops its scene's manager from the drivers", () => {
  S.disposeStaticParticles(B);
  const before = [a.ticks(), b.ticks()];
  S.tickStaticParticles({});
  assert.deepEqual([a.ticks() - before[0], b.ticks() - before[1]], [1, 0], "the disposed manager is not ticked");
});

console.log(`\nstatic_particle_managers_tick: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
