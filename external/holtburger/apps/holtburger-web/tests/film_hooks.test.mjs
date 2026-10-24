// tests/film_hooks.test.mjs
//
// WHY (2026-10-13). Film mode (scene3d/film/SPEC.md, `?filmMode=on`, DEFAULT
// OFF; depth of field `?filmDof=on`, DEFAULT OFF) drives the camera, the frame
// clock and a few render-only hides from scene3d/film/. It reaches the engine
// ONLY through eight seams in existing hot files (SPEC §4 items 1–8). Every
// seam must be zero-cost and behaviour-identical when film mode is off, and
// must do exactly what the film runtime is coded against when it is on. This
// suite EXECUTES the shipped code of each seam:
//
//   H1  particle_fx.js       setFxTimeSource drives uFxTime (null restores
//                            performance.now); setFxNearFadeMin sets the
//                            uniform-only near-fade floor the patched shader reads.
//   H2  animated_scenery.js  setSceneryTimeSource feeds the private rAF clock
//                            (`_nowMs`) and re-bases its last-frame stamp.
//   H3  particle_manager.js  allParticleManagers / setParticleCullConfig (read
//                            live by the RP6 cull) / render-only emitter.filmHidden
//                            on the instanced and the per-mesh path; a rendered take
//                            (real take_player) runs recheckInterval 1 and restores it.
//   H4  entities.js          EntityManager.setFilmHidden / clearAllFilmHidden —
//                            the third term of the single visibility writer.
//   H5  cells.js             updateViewerCell honours `filmViewer.cell` (scene
//                            facade or window.liveScene3d) via tickCellVisibility3D.
//   H6  statics.js           cullStaticsGroup honours `userData.__filmHidden`.
//   H7  index.js             the init3D seams, lifted from the shipped source and
//                            run: scheduleNext holdLoop, _postRenderStreamSlot
//                            postRender, the preFrame call, __renderOnce(tsMs) +
//                            tick's dt clamp, the exact-match lazy film import
//                            (+ the resident particle_manager.js seams it injects).
//   H8  atmosphere_pipeline  `?filmDof=on` → one DepthOfFieldEffect + window.__dof
//                            on the REAL pipeline (legacy + split chains): idle is
//                            shader-identical to the flag off, enabled integrates,
//                            rack focus / autofocus / camera retarget work.
//
// Run from apps/holtburger-web/: node tests/film_hooks.test.mjs

import assert from "node:assert/strict";
import { register } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { importEdited } from "../harness/lib/import_edited.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(HERE, "..");
const v = (p) => pathToFileURL(path.join(APP, p)).href;

// index.html's import map for the vendored takram modules the pipeline imports
// (the same resolve hook tests/particles_over_clouds.test.mjs uses).
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

// Browser-ish globals BEFORE any app import (module-level flag readers read an
// empty search = every default; film mode is off unless a check turns it on).
globalThis.location = { search: "" };
globalThis.window = globalThis;
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};

const THREE = await import("three");
const cam = new THREE.PerspectiveCamera(60, 1.6, 0.1, 10000);
cam.updateMatrixWorld(true);
window.liveScene3d = { cameraSwitcher: { activeCamera: cam }, camera: cam };

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  [PASS] ${name}`);
  } catch (e) {
    failed += 1;
    console.log(`  [FAIL] ${name} — ${e && e.message ? e.message.split("\n")[0] : e}`);
  }
}
const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg ?? ""} ${a} vs ${b} (eps ${eps})`);

// ---------------------------------------------------------------------------
console.log("-- H1 particle_fx.js: film FX clock + near-fade floor --------------------");
const FX = await import("../scene3d/particles/particle_fx.js");
{
  const fxTime = () => FX.FX_UNIFORMS.uFxTime.value;
  await check("H1a default (no source): particleFxFrame() reads performance.now()", () => {
    const a = performance.now();
    FX.particleFxFrame();
    const b = performance.now();
    assert.ok(fxTime() >= (a / 1000) % 1024 - 1e-9 && fxTime() <= (b / 1000) % 1024 + 1e-9, `${fxTime()} not in [${a}, ${b}]/1000`);
  });
  await check("H1b setFxTimeSource(fn) drives uFxTime from the film clock", () => {
    let filmMs = 123456;
    FX.setFxTimeSource(() => filmMs);
    FX.particleFxFrame();
    near(fxTime(), 123.456, 1e-9);
    filmMs += 1000 / 30;
    FX.particleFxFrame();
    near(fxTime(), (123456 + 1000 / 30) / 1000, 1e-9, "one film frame later");
    // Paused film clock: the same stamp is idempotent (no change).
    FX.particleFxFrame();
    near(fxTime(), (123456 + 1000 / 30) / 1000, 1e-9, "paused");
  });
  await check("H1c an explicit finite nowMs still wins over the source (test seam unchanged)", () => {
    FX.setFxTimeSource(() => 999999);
    FX.particleFxFrame(5000);
    near(fxTime(), 5, 1e-12);
  });
  await check("H1d a throwing / non-finite source falls back to performance.now() for that frame", () => {
    FX.setFxTimeSource(() => { throw new Error("boom"); });
    let a = performance.now();
    FX.particleFxFrame();
    let b = performance.now();
    assert.ok(fxTime() >= (a / 1000) % 1024 - 1e-9 && fxTime() <= (b / 1000) % 1024 + 1e-9, "throwing source");
    FX.setFxTimeSource(() => NaN);
    a = performance.now();
    FX.particleFxFrame();
    b = performance.now();
    assert.ok(fxTime() >= (a / 1000) % 1024 - 1e-9 && fxTime() <= (b / 1000) % 1024 + 1e-9, "NaN source");
  });
  await check("H1e setFxTimeSource(null) restores performance.now(); a non-function throws", () => {
    FX.setFxTimeSource(() => 42);
    FX.particleFxFrame();
    near(fxTime(), 0.042, 1e-12);
    FX.setFxTimeSource(null);
    const a = performance.now();
    FX.particleFxFrame();
    const b = performance.now();
    assert.ok(fxTime() >= (a / 1000) % 1024 - 1e-9 && fxTime() <= (b / 1000) % 1024 + 1e-9, "restored");
    assert.throws(() => FX.setFxTimeSource("filmMs"), TypeError);
    assert.throws(() => FX.setFxTimeSource(12), TypeError);
  });
  await check("H1f uFxNearFadeMin defaults to 0; setFxNearFadeMin sets it, returns the previous floor, validates", () => {
    assert.equal(FX.FX_UNIFORMS.uFxNearFadeMin.value, 0);
    assert.equal(FX.setFxNearFadeMin(2.5), 0);
    assert.equal(FX.FX_UNIFORMS.uFxNearFadeMin.value, 2.5);
    for (const bad of [-0.1, NaN, Infinity, "1", null, undefined]) {
      assert.throws(() => FX.setFxNearFadeMin(bad), RangeError, String(bad));
    }
    assert.equal(FX.FX_UNIFORMS.uFxNearFadeMin.value, 2.5, "a rejected value changes nothing");
    assert.equal(FX.setFxNearFadeMin(0), 2.5);
    assert.equal(FX.FX_UNIFORMS.uFxNearFadeMin.value, 0);
  });
  await check("H1g the patched FX shader binds the SAME floor uniform and fades with max(row, floor)", () => {
    const shader = {
      vertexShader: THREE.ShaderLib.basic.vertexShader,
      fragmentShader: THREE.ShaderLib.basic.fragmentShader,
      uniforms: THREE.UniformsUtils.clone(THREE.ShaderLib.basic.uniforms),
    };
    assert.equal(FX.patchParticleFxShader(shader), true);
    assert.equal(shader.uniforms.uFxNearFadeMin, FX.FX_UNIFORMS.uFxNearFadeMin, "uniform-only: shared by identity");
    assert.match(shader.fragmentShader, /uniform float uFxNearFadeMin;/);
    assert.match(shader.fragmentShader, /float fxNf = max\( vFxD\.y, uFxNearFadeMin \);/);
    assert.match(shader.fragmentShader, /if \( fxNf > 0\.0 \) fxA \*= smoothstep\( 0\.35 \* fxNf, fxNf, vFxD\.w \);/);
    assert.ok(!/if \( vFxD\.y > 0\.0 \) fxA \*= smoothstep/.test(shader.fragmentShader), "the old row-only term is replaced, not duplicated");
  });
}

// ---------------------------------------------------------------------------
console.log("-- H2 animated_scenery.js: film scenery clock ------------------------------");
{
  // The shipped module with a probe export appended (importEdited: every
  // dependency stays the genuine module) — reads the private rAF clock.
  const AS = await importEdited("scene3d/animated_scenery.js",
    (src) => `${src}\nexport const __filmProbe = { now: () => _nowMs(), last: () => _rafLastMs };\n`, "film-hooks");
  await check("H2a default: the private rAF clock is performance.now()", () => {
    const a = performance.now();
    const t = AS.__filmProbe.now();
    const b = performance.now();
    assert.ok(t >= a && t <= b, `${t} not in [${a}, ${b}]`);
  });
  await check("H2b setSceneryTimeSource(fn) drives the clock and re-bases the last-frame stamp", () => {
    let filmMs = 42000;
    AS.setSceneryTimeSource(() => filmMs);
    assert.equal(AS.__filmProbe.now(), 42000);
    assert.equal(AS.__filmProbe.last(), 42000, "rebased: the first dt measures the film clock only");
    filmMs += 1000 / 30;
    assert.equal(AS.__filmProbe.now(), 42000 + 1000 / 30);
  });
  await check("H2c a throwing / NaN source falls back to performance.now()", () => {
    AS.setSceneryTimeSource(() => { throw new Error("x"); });
    let a = performance.now();
    let t = AS.__filmProbe.now();
    assert.ok(t >= a && t <= performance.now());
    AS.setSceneryTimeSource(() => NaN);
    a = performance.now();
    t = AS.__filmProbe.now();
    assert.ok(t >= a && t <= performance.now());
  });
  await check("H2d setSceneryTimeSource(null) restores performance.now() and re-bases; non-functions throw", () => {
    AS.setSceneryTimeSource(() => 5);
    AS.setSceneryTimeSource(null);
    const a = performance.now();
    const last = AS.__filmProbe.last();
    const t = AS.__filmProbe.now();
    assert.ok(t >= a, "clock back on performance.now()");
    assert.ok(last <= t && last > 1e-3 + 5, `stamp re-based on performance.now() (${last})`);
    assert.throws(() => AS.setSceneryTimeSource({}), TypeError);
  });
}

// ---------------------------------------------------------------------------
console.log("-- H3 particle_manager.js: registry, RP6 retune, emitter.filmHidden --------");
const { setCurrentTime, setRng } = await import("../scene3d/particles/time_rng.js");
const PM = await import("../scene3d/particles/particle_manager.js");
{
  let t = 1000;
  setCurrentTime(() => t);
  let seed = 1;
  setRng(() => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; });
  const tex = new THREE.DataTexture(new Uint8Array(4 * 4 * 4).fill(255), 4, 4);
  const additiveBase = () => {
    const m = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, side: THREE.DoubleSide });
    m.blending = THREE.AdditiveBlending;
    m.userData = { __cacheOwned: true, surfaceTypeFlags: 0x10000 };
    return m;
  };
  const quad = new THREE.PlaneGeometry(1, 1);
  const info = () => ({
    id: 0x3200fff1, emitterType: 1, particleType: 2, gfxObjId: 0, hwGfxObjId: 0x0100c001,
    birthrate: 0.03, maxParticles: 16, initialParticles: 3, totalParticles: 0, totalSeconds: 1000,
    lifespan: 0.45, lifespanRand: 0.2, offsetDirX: 0, offsetDirY: 0, offsetDirZ: 1,
    minOffset: 0, maxOffset: 0.5, aX: 0.3, aY: 1.2, aZ: 0.1, minA: 0.5, maxA: 1.5,
    bX: 0, bY: 0, bZ: 0, cX: 0, cY: 0, cZ: 0, scaleRand: 0.2, startScale: 0.5, finalScale: 1.5,
    transRand: 0.1, startTrans: 0.1, finalTrans: 0.9, isParentLocal: false, billboard: false,
  });
  const flush = () => new Promise((r) => setImmediate(r));
  async function arm({ instancing = true, z = -10 } = {}) {
    t = 1000;
    seed = 1;
    const group = new THREE.Group();
    const anchor = new THREE.Object3D();
    anchor.position.set(0, 0, z);
    group.add(anchor);
    group.updateMatrixWorld(true);
    const mgr = new PM.ParticleManager({ scene: group, instancing, geometryFactory: () => quad, materialFactory: () => additiveBase() });
    const id = await mgr.addEmitter({ emitterInfo: info(), parent: anchor });
    return { mgr, emitter: mgr.particleTable.get(id) };
  }
  async function ticks(a, n, each) {
    for (let i = 0; i < n; i += 1) {
      t += 0.05;
      a.mgr.tick();
      if (each) each(i);
      await flush();
    }
  }
  const instanceCount = (mgr) => { let n = 0; for (const b of mgr._instBuckets.values()) n += b.im.count | 0; return n; };
  const liveParts = (e) => e.parts.filter(Boolean);
  const simState = (e) => JSON.stringify({
    totalEmitted: e.totalEmitted, numParticles: e.numParticles, lastUpdateTime: e.lastUpdateTime,
    lifetimes: e.parts.map((m, i) => (m && e.particles[i] ? e.particles[i].lifetime : null)),
    pos: liveParts(e).map((m) => [m.position.x, m.position.y, m.position.z]),
  });

  await check("H3a allParticleManagers() lists every live manager as a COPY of the registry", async () => {
    const before = PM.allParticleManagers();
    assert.ok(Array.isArray(before));
    const a = await arm();
    const after = PM.allParticleManagers();
    assert.ok(after.includes(a.mgr), "a new manager is enumerated");
    assert.equal(after.length, before.length + 1);
    after.length = 0;
    assert.ok(PM.allParticleManagers().includes(a.mgr), "mutating the copy leaves the registry alone");
  });
  await check("H3b setParticleCullConfig returns the previous config; partial + invalid writes", () => {
    const p0 = PM.setParticleCullConfig({});
    assert.deepEqual(p0, { maxDistance: 220, recheckInterval: 6 }, "shipped RP6 defaults");
    assert.deepEqual(PM.setParticleCullConfig({ maxDistance: 900, recheckInterval: 1 }), p0);
    assert.deepEqual(PM.setParticleCullConfig({ maxDistance: 1500 }), { maxDistance: 900, recheckInterval: 1 });
    assert.deepEqual(PM.setParticleCullConfig({ recheckInterval: null }), { maxDistance: 1500, recheckInterval: 1 }, "null = keep");
    for (const bad of [{ maxDistance: 0 }, { maxDistance: -5 }, { maxDistance: NaN }, { maxDistance: "300" },
      { recheckInterval: 0 }, { recheckInterval: 2.5 }, { maxDistance: 300, recheckInterval: 0 }]) {
      assert.throws(() => PM.setParticleCullConfig(bad), RangeError, JSON.stringify(bad));
    }
    assert.deepEqual(PM.setParticleCullConfig({}), { maxDistance: 1500, recheckInterval: 1 }, "rejected writes changed nothing (atomic)");
    assert.deepEqual(PM.setParticleCullConfig({ maxDistance: Infinity }), { maxDistance: 1500, recheckInterval: 1 }, "Infinity accepted");
    PM.setParticleCullConfig(p0);
    assert.deepEqual(PM.setParticleCullConfig({}), p0, "restored");
  });
  await check("H3c the RP6 cull reads the retuned config LIVE (300 m emitter: culled at 220 m, live at 900 m)", async () => {
    const p0 = PM.setParticleCullConfig({ recheckInterval: 1 });
    try {
      const a = await arm({ z: -300 });
      await ticks(a, 2);
      assert.equal(a.emitter._rp6Culled, true, "beyond the shipped 220 m cap");
      PM.setParticleCullConfig({ maxDistance: 900 });
      await ticks(a, 1);
      assert.equal(a.emitter._rp6Culled, false, "the raised cap is honoured on the next recheck");
      PM.setParticleCullConfig({ maxDistance: 220 });
      await ticks(a, 1);
      assert.equal(a.emitter._rp6Culled, true, "and the restored cap culls again");
    } finally {
      PM.setParticleCullConfig(p0);
    }
  });
  await check("H3d instanced emitter.filmHidden: simulates, draws zero instances, back the next tick", async () => {
    const a = await arm({ instancing: true });
    const e = a.emitter;
    assert.ok(e._instKey !== null && e._instKey !== undefined, "precondition: instanced path");
    await ticks(a, 6);
    assert.ok(instanceCount(a.mgr) > 0, "precondition: draws");
    e.filmHidden = true;
    const emitted0 = e.totalEmitted;
    let maxCount = 0;
    let everCulled = false;
    await ticks(a, 20, () => { maxCount = Math.max(maxCount, instanceCount(a.mgr)); everCulled ||= e._rp6Culled === true; });
    assert.equal(maxCount, 0, "zero instances while hidden");
    assert.ok(e.totalEmitted > emitted0, "kept emitting");
    assert.equal(e.lastUpdateTime, t, "kept aging (updateParticles ran this tick)");
    assert.ok(!everCulled, "not routed through the RP6 cull");
    e.filmHidden = false;
    t += 0.05;
    a.mgr.tick();
    assert.ok(instanceCount(a.mgr) > 0, "instances back on the very next tick");
  });
  await check("H3e per-mesh emitter.filmHidden: occupied slots hidden every tick, shown again after", async () => {
    const a = await arm({ instancing: false });
    const e = a.emitter;
    assert.ok(e._instKey === null || e._instKey === undefined, "precondition: per-mesh path");
    await ticks(a, 6);
    assert.ok(liveParts(e).some((m) => m.visible === true), "precondition: visible slots");
    e.filmHidden = true;
    let visibleSeen = 0;
    await ticks(a, 12, () => { visibleSeen += liveParts(e).filter((m) => m.visible === true).length; });
    assert.equal(visibleSeen, 0, "no occupied slot visible after any tick");
    assert.ok(e.numParticles > 0, "particles alive underneath");
    e.filmHidden = false;
    t += 0.05;
    a.mgr.tick();
    assert.ok(liveParts(e).some((m) => m.visible === true), "the next live update re-shows the slots");
  });
  await check("H3f filmHidden is render-only: simulation byte-identical to an unhidden twin", async () => {
    const hidden = await arm();
    hidden.emitter.filmHidden = true;
    await ticks(hidden, 40);
    const sa = simState(hidden.emitter);
    const shown = await arm();
    await ticks(shown, 40);
    assert.ok(instanceCount(shown.mgr) > 0 && instanceCount(hidden.mgr) === 0, "precondition: one drew, one did not");
    assert.equal(sa, simState(shown.emitter));
  });
  await check("H3g (review seams-9) a rendered take runs the REAL RP6 cull every tick (recheckInterval 1) and restores it — also when the take fails", async () => {
    const TP = await import("../scene3d/film/runtime/take_player.js");
    const TR = await import("../scene3d/film/shots/trajectory.js");
    const p0 = PM.setParticleCullConfig({});
    assert.equal(p0.recheckInterval, 6, "precondition: the shipped interval");
    const a = await arm({ z: -10 });
    const seen = [];
    const post = [];
    const makeClock = (failAt = Infinity) => {
      let steps = 0;
      return {
        active: false,
        begin() { this.active = true; },
        step() {
          steps += 1;
          if (steps >= failAt) return Promise.reject(new Error("GPU lost"));
          seen.push(PM.setParticleCullConfig({}).recheckInterval); // {} reads without writing
          a.mgr.tick();
          for (const f of post) f();
          return Promise.resolve();
        },
        async end() { this.active = false; },
        stats: () => ({}),
      };
    };
    const cam = { owned: true, write: () => true, currentPose: () => null, onPostRender: (fn) => { post.push(fn); return () => post.splice(post.indexOf(fn), 1); } };
    const traj = TR.makeTrajectory({ id: "d", technique: "classic.dolly-in", family: "classic", duration: 1, positionAt: (s) => [0, s, 2], orientAt: { h: 0, p: 0, r: 0 } });
    const player = (clock) => TP.createTakePlayer({
      cameraOwner: cam, clock, window: {},
      safety: { clamp: (prev, p) => ({ pose: p, adjusted: false, hits: [] }) },
      particleCull: { setParticleCullConfig: PM.setParticleCullConfig, allParticleManagers: PM.allParticleManagers },
    });
    const ok = player(makeClock());
    ok.prepare({ trajectory: traj, capture: { fps: 10 } });
    const r = await ok.rehearse({ fps: 10 });
    assert.equal(r.frames, 10);
    assert.equal(seen.length, 16, "6 pre-roll + 10 take frames rendered");
    assert.ok(seen.every((x) => x === 1), `every rendered frame saw recheckInterval 1 (${seen.join(",")})`);
    assert.deepEqual(r.particleCull, { recheckInterval: 1, previous: 6, restored: true });
    assert.deepEqual(PM.setParticleCullConfig({}), p0, "the shipped RP6 config is back after the take");
    const dry = await ok.rehearse({ fps: 10, render: false });
    assert.equal(dry.particleCull, null, "an unrendered rehearsal leaves the cull alone");
    seen.length = 0;
    const bad = player(makeClock(9));
    bad.prepare({ trajectory: traj, capture: { fps: 10 } });
    await assert.rejects(bad.rehearse({ fps: 10 }), /GPU lost/);
    assert.ok(seen.length === 8 && seen.every((x) => x === 1));
    assert.deepEqual(PM.setParticleCullConfig({}), p0, "restored after a failed take too");
  });
}

// ---------------------------------------------------------------------------
console.log("-- H4 entities.js: EntityManager film hide -------------------------------");
const ENT = await import("../scene3d/entities.js");
{
  const P = 0x50000010, NPC = 0x80000abc, SWORD = 0x50000011;
  function setup() {
    const entitiesGroup = new THREE.Group();
    const em = new ENT.EntityManager({ entitiesGroup, materialCache: { fallbackMaterial: new THREE.MeshBasicMaterial(), getCached: () => null } }, {});
    const mk = (guid, x) => {
      const root = new THREE.Group();
      root.position.set(x, 0, 0);
      root.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial()));
      return { guid, root, parts: [], meta: { setupId: 0x02000001 }, _attachedParentGuid: null, _attachedChildren: null, dispose() {} };
    };
    const player = mk(P, 0);
    const npc = mk(NPC, 5);
    const sword = mk(SWORD, 0);
    sword._attachedParentGuid = P;
    player.root.add(sword.root);
    for (const i of [player, npc]) entitiesGroup.add(i.root);
    em.entityMap.set(P, player);
    em.entityMap.set(NPC, npc);
    em.entityMap.set(SWORD, sword);
    return { em, player, npc, sword };
  }
  const worldVisible = (o) => { for (let n = o; n; n = n.parent) if (!n.visible) return false; return true; };

  await check("H4a default: no film term (undefined) → visibility exactly the old composite", () => {
    const { player, npc } = setup();
    assert.equal(player._filmHidden, undefined);
    assert.equal(player.root.visible, true);
    assert.equal(npc.root.visible, true);
  });
  await check("H4b setFilmHidden(guid, true) hides the rig (and its wielded child), returns true; false shows it", () => {
    const { em, player, sword } = setup();
    assert.equal(em.setFilmHidden(P, true), true);
    assert.equal(player.root.visible, false);
    assert.equal(worldVisible(sword.root), false, "a wielded child goes with its root");
    assert.equal(sword.root.visible, true, "…without touching the child's own flag");
    assert.equal(em.setFilmHidden(P, false), true);
    assert.equal(player.root.visible, true);
  });
  await check("H4c the film term composes: it never un-hides a state-hidden or cull-hidden rig", async () => {
    const { em, npc } = setup();
    npc._stateVisible = false;
    em.setFilmHidden(NPC, true);
    em.setFilmHidden(NPC, false);
    assert.equal(npc.root.visible, false, "state-hidden stays hidden after the film hide clears");
    npc._stateVisible = true;
    // Real render-cull producer: in frustum → it re-applies the composite, and
    // the film term still wins.
    const scene3d = { entityManager: em };
    em.setFilmHidden(NPC, true);
    ENT.tickEntityRenderVisibility(scene3d, { valid: true, isSphereInFrustum: () => true, getDistanceSq: () => 0 });
    assert.equal(npc._renderCullHidden, false);
    assert.equal(npc.root.visible, false, "film-hidden survives the per-frame cull writer");
    ENT.tickEntityRenderVisibility(scene3d, { valid: true, isSphereInFrustum: () => false, getDistanceSq: () => 0 });
    em.setFilmHidden(NPC, false);
    assert.equal(npc.root.visible, false, "frustum-culled stays hidden after the film hide clears");
    ENT.tickEntityRenderVisibility(scene3d, { valid: true, isSphereInFrustum: () => true, getDistanceSq: () => 0 });
    assert.equal(npc.root.visible, true, "back in frustum, nothing hides it");
  });
  await check("H4d an unknown guid returns false but is remembered; clearAllFilmHidden returns the live count", () => {
    const { em, player, npc } = setup();
    assert.equal(em.setFilmHidden(0x12345678, true), false);
    assert.ok(em._filmHiddenGuids.has(0x12345678), "remembered for a later (re)spawn");
    em.setFilmHidden(P, true);
    em.setFilmHidden(NPC, true);
    assert.equal(em.clearAllFilmHidden(), 2);
    assert.equal(player.root.visible, true);
    assert.equal(npc.root.visible, true);
    assert.equal(em._filmHiddenGuids.size, 0, "memory cleared");
    assert.equal(em.clearAllFilmHidden(), 0, "idempotent");
  });
  await check("H4e film hide does not route through setVisibility (no PS_Hidden script, state untouched)", () => {
    const { em, npc } = setup();
    let scripted = 0;
    em.setVisibility = () => { scripted += 1; };
    em.setFilmHidden(NPC, true);
    assert.equal(scripted, 0);
    assert.equal(npc._stateVisible, undefined, "server/state visibility untouched");
  });
}

// ---------------------------------------------------------------------------
console.log("-- H5 cells.js: film viewer cell ----------------------------------------");
const vc = await import("../scene3d/viewer_cell.js");
const CELLS = await import("../scene3d/cells.js");
{
  const LB = 0xa4b40000;
  const OUTDOOR = (LB | 0x0024) >>> 0;
  const BARN = (LB | 0x010e) >>> 0;
  const ROOM = (LB | 0x0123) >>> 0;
  const makeScene3d = () => {
    const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 5000);
    camera.position.set(0, 5, 10);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld(true);
    const worldRoot = new THREE.Group();
    worldRoot.rotation.x = -Math.PI / 2;
    worldRoot.updateMatrixWorld(true);
    return {
      camera, worldRoot, cellContainers3d: new Map(),
      terrainGroup: { visible: true }, buildingsGroup: { visible: true, children: [] }, staticsGroup: { visible: true, children: [] },
    };
  };
  const makeSession = ({ playerCell, playerIndoor, viewer }) => {
    const calls = { setViewerCell: [], resolveArgs: null };
    return {
      calls,
      getCurrentCellId: () => playerCell,
      isCurrentCellIndoor: () => playerIndoor,
      isCurrentCellSeenOutside: () => playerIndoor,
      isCellSeenOutside: () => true,
      getRenderSet: () => [playerCell],
      getViewerRenderSet: () => [viewer],
      getLocalPlayerPose: () => ({ landblockId: playerCell, x: 60, y: 175, z: 96, free() {} }),
      terrainHeightAt: () => 96,
      resolveViewerCell: (...args) => { calls.resolveArgs = args; return viewer; },
      setViewerCell: (c) => calls.setViewerCell.push(c >>> 0),
    };
  };
  await check("H5a no film viewer → the player-head walk as before (resolveViewerCell called)", () => {
    const s3 = makeScene3d();
    const sh = makeSession({ playerCell: OUTDOOR, playerIndoor: false, viewer: BARN });
    CELLS.tickCellVisibility3D(s3, sh);
    assert.ok(sh.calls.resolveArgs, "walked");
    assert.equal(s3._viewerCell, BARN);
    assert.deepEqual(sh.calls.setViewerCell, [BARN]);
  });
  await check("H5b scene3d.filmViewer.cell wins: rooted, published and stamped like a walked cell", () => {
    const s3 = makeScene3d();
    s3.filmViewer = { cell: ROOM };
    // The walk would say BARN; the wasm render set follows the rooted cell.
    const sh = makeSession({ playerCell: OUTDOOR, playerIndoor: false, viewer: BARN });
    sh.getViewerRenderSet = () => [ROOM];
    CELLS.tickCellVisibility3D(s3, sh);
    assert.equal(sh.calls.resolveArgs, null, "no head→eye walk");
    assert.deepEqual(sh.calls.setViewerCell, [ROOM], "wasm walks rooted at the film cell");
    assert.equal(s3._viewerCell, ROOM);
    assert.equal(s3._viewerIndoor, true);
    assert.equal(vc.viewerState().cell, ROOM, "published to viewer_cell.js consumers");
    assert.equal(vc.viewerState().indoor, true);
    assert.equal(s3._indoorSplitArmed, true, "the camera's EnvCell arms the indoor split");
  });
  await check("H5c window.liveScene3d.filmViewer.cell is honoured too (facade the loop does not pass)", () => {
    const s3 = makeScene3d();
    window.liveScene3d.filmViewer = { cell: ROOM };
    try {
      const sh = makeSession({ playerCell: OUTDOOR, playerIndoor: false, viewer: BARN });
      CELLS.tickCellVisibility3D(s3, sh);
      assert.equal(s3._viewerCell, ROOM);
      assert.deepEqual(sh.calls.setViewerCell, [ROOM]);
    } finally {
      delete window.liveScene3d.filmViewer;
    }
  });
  await check("H5d film cell == player cell → override cleared (setViewerCell(0)); cell 0 → normal walk", () => {
    const s3 = makeScene3d();
    s3.filmViewer = { cell: BARN };
    const sh = makeSession({ playerCell: BARN, playerIndoor: true, viewer: OUTDOOR });
    CELLS.tickCellVisibility3D(s3, sh);
    assert.deepEqual(sh.calls.setViewerCell, [0]);
    assert.equal(s3._viewerCell, BARN);
    assert.equal(s3._viewerIndoor, true);
    const s3b = makeScene3d();
    s3b.filmViewer = { cell: 0 };
    const sh2 = makeSession({ playerCell: OUTDOOR, playerIndoor: false, viewer: BARN });
    CELLS.tickCellVisibility3D(s3b, sh2);
    assert.ok(sh2.calls.resolveArgs, "cell 0 = no film cell");
    assert.equal(s3b._viewerCell, BARN);
  });
  await check("H5e a stale pkg without resolveViewerCell still honours the film cell", () => {
    const s3 = makeScene3d();
    s3.filmViewer = { cell: ROOM };
    const sh = makeSession({ playerCell: OUTDOOR, playerIndoor: false, viewer: BARN });
    delete sh.resolveViewerCell;
    CELLS.tickCellVisibility3D(s3, sh);
    assert.equal(s3._viewerCell, ROOM);
    assert.deepEqual(sh.calls.setViewerCell, [ROOM]);
  });
}

// ---------------------------------------------------------------------------
console.log("-- H6 statics.js: cullStaticsGroup honours __filmHidden --------------------");
const STATICS = await import("../scene3d/statics.js");
{
  const culler = { valid: true, isSphereInFrustum: () => true, getDistanceSq: () => 0 };
  const box = () => new THREE.BoxGeometry(2, 2, 2);
  const mat = () => new THREE.MeshBasicMaterial();
  function group() {
    const g = new THREE.Group();
    const mesh = new THREE.Mesh(box(), mat());
    mesh.position.set(10, 10, 10);
    const inst = new THREE.InstancedMesh(box(), mat(), 2);
    inst.setMatrixAt(0, new THREE.Matrix4().makeTranslation(1, 2, 3));
    inst.setMatrixAt(1, new THREE.Matrix4().makeTranslation(4, 5, 6));
    const lod = new THREE.LOD();
    lod.addLevel(new THREE.Mesh(box(), mat()), 0);
    const lit = new THREE.Mesh(box(), mat());
    lit.add(new THREE.PointLight());
    const batched = new THREE.BatchedMesh(4, 64, 64, mat());
    g.add(mesh, inst, lod, lit, batched);
    g.updateMatrixWorld(true);
    return { g, mesh, inst, lod, lit, batched };
  }
  await check("H6a no marker: every node visible (baseline counts)", () => {
    const { g, mesh, inst, lod, batched } = group();
    const r = STATICS.cullStaticsGroup({ staticsGroup: g }, culler);
    assert.ok(mesh.visible && inst.visible && lod.visible && batched.visible);
    assert.equal(r.culled, 0);
  });
  await check("H6b __filmHidden hides Mesh / InstancedMesh / LOD (and a light owner), counted tested + culled", () => {
    const { g, mesh, inst, lod, lit } = group();
    const base = STATICS.cullStaticsGroup({ staticsGroup: g }, culler);
    for (const n of [mesh, inst, lod, lit]) n.userData.__filmHidden = true;
    const r = STATICS.cullStaticsGroup({ staticsGroup: g }, culler);
    assert.ok(!mesh.visible && !inst.visible && !lod.visible && !lit.visible);
    assert.equal(r.culled, 4);
    assert.equal(r.tested, base.tested + 1, "the light owner (normally untested) now counts too");
    // Re-asserted every frame: a stray writer cannot resurrect it.
    mesh.visible = true;
    STATICS.cullStaticsGroup({ staticsGroup: g }, culler);
    assert.equal(mesh.visible, false);
  });
  await check("H6c clearing the marker restores the node on the next pass", () => {
    const { g, mesh, inst } = group();
    mesh.userData.__filmHidden = true;
    inst.userData.__filmHidden = true;
    STATICS.cullStaticsGroup({ staticsGroup: g }, culler);
    delete mesh.userData.__filmHidden;
    inst.userData.__filmHidden = false;
    const r = STATICS.cullStaticsGroup({ staticsGroup: g }, culler);
    assert.ok(mesh.visible && inst.visible);
    assert.equal(r.culled, 0);
  });
  await check("H6d BatchedMesh nodes keep their behaviour (film hides their instances with setVisibleAt)", () => {
    const { g, batched } = group();
    batched.userData.__filmHidden = true;
    STATICS.cullStaticsGroup({ staticsGroup: g }, culler);
    assert.equal(batched.visible, true);
  });
}

// ---------------------------------------------------------------------------
console.log("-- H7 index.js: init3D seams (lifted from the shipped source and run) -------");
const INDEX_SRC = readFileSync(path.join(APP, "scene3d", "index.js"), "utf8");
/** The balanced `{…}` block whose head starts at `anchor` (strings/comments skipped). */
function liftBlock(src, anchor, from = 0) {
  const start = src.indexOf(anchor, from);
  if (start < 0) throw new Error(`anchor drifted: ${anchor}`);
  let i = src.indexOf("{", start + anchor.length - 1);
  let depth = 0;
  for (; i < src.length; i += 1) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") { i = src.indexOf("\n", i); continue; }
    if (c === "/" && src[i + 1] === "*") { i = src.indexOf("*/", i) + 1; continue; }
    if (c === '"' || c === "'" || c === "`") {
      for (i += 1; i < src.length && src[i] !== c; i += 1) if (src[i] === "\\") i += 1;
      continue;
    }
    if (c === "{") depth += 1;
    else if (c === "}" && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`unbalanced block at: ${anchor}`);
}
/** Run lifted statements in a scope object (sloppy `with`: free names resolve there first). */
function runLifted(code, scope, ret) {
  // eslint-disable-next-line no-new-func
  return new Function("__scope", `with (__scope) {\n${code}\n${ret ? `return ${ret};` : ""}\n}`)(scope);
}
const quietConsole = () => {
  const warns = [];
  return { warns, warn: (...a) => warns.push(a.map(String).join(" ")), log() {}, error: (...a) => warns.push(a.join(" ")) };
};
{
  const SCHEDULE = liftBlock(INDEX_SRC, "function scheduleNext() {");
  const scheduleScope = (liveScene3dRef, renderOnDemand = false) => {
    const s = {
      adaptiveGpuProbe: { ends: 0, frameEnd() { this.ends += 1; } }, renderOnDemand, liveScene3dRef,
      portalSpaceFrameIntervalMs: (x) => x, _frameIntervalMs: 0, pacerDelayMs: () => 0, lastFrameTs: 0,
      _schedTimeoutId: null, _schedRafId: null, tick() {}, rafs: 0, setTimeout: () => 1,
    };
    s.requestAnimationFrame = () => { s.rafs += 1; return 7; };
    return s;
  };
  await check("H7a scheduleNext: no film → re-arms the rAF (unchanged)", () => {
    const s = scheduleScope({});
    runLifted(SCHEDULE, s, "scheduleNext")();
    assert.equal(s.rafs, 1);
    assert.equal(s._schedRafId, 7);
    assert.equal(s.adaptiveGpuProbe.ends, 1);
    const s0 = scheduleScope(null);
    runLifted(SCHEDULE, s0, "scheduleNext")();
    assert.equal(s0.rafs, 1, "null facade (boot) re-arms too");
  });
  await check("H7b scheduleNext: film.holdLoop parks the loop like renderOnDemand (probe fence still runs)", () => {
    const s = scheduleScope({ film: { holdLoop: true } });
    runLifted(SCHEDULE, s, "scheduleNext")();
    assert.equal(s.rafs, 0);
    assert.equal(s.adaptiveGpuProbe.ends, 1);
    const s2 = scheduleScope({ film: { holdLoop: false } });
    runLifted(SCHEDULE, s2, "scheduleNext")();
    assert.equal(s2.rafs, 1, "cleared hold → normal re-arm");
    const s3 = scheduleScope({}, true);
    runLifted(SCHEDULE, s3, "scheduleNext")();
    assert.equal(s3.rafs, 0, "renderOnDemand unchanged");
  });

  const SLOT = liftBlock(INDEX_SRC, "function _postRenderStreamSlot() {");
  const slotScope = (liveScene3dRef) => {
    const order = [];
    return {
      order, liveScene3dRef, _frameWorkOn: false, console: quietConsole(),
      framePhaseCut: (n) => order.push(`cut${n}`), framePhaseCommit: () => order.push("commit"),
    };
  };
  await check("H7c _postRenderStreamSlot: film.postRender runs FIRST, then the slot as before", () => {
    const ls = { film: { postRender: () => s.order.push("film") } };
    const s = slotScope(ls);
    runLifted(SLOT, s, "_postRenderStreamSlot")();
    assert.deepEqual(s.order, ["film", "cut3", "cut4", "commit"]);
    const off = slotScope({});
    runLifted(SLOT, off, "_postRenderStreamSlot")();
    assert.deepEqual(off.order, ["cut3", "cut4", "commit"], "no film: unchanged");
    const nul = slotScope(null);
    runLifted(SLOT, nul, "_postRenderStreamSlot")();
    assert.deepEqual(nul.order, ["cut3", "cut4", "commit"], "null facade: unchanged");
  });
  await check("H7d a throwing postRender never skips the slot; one [film] warn", () => {
    const ls = { film: { postRender() { throw new Error("encoder gone"); } } };
    const s = slotScope(ls);
    const f = runLifted(SLOT, s, "_postRenderStreamSlot");
    f();
    f();
    assert.deepEqual(s.order, ["cut3", "cut4", "commit", "cut3", "cut4", "commit"]);
    assert.equal(s.console.warns.length, 1);
    assert.match(s.console.warns[0], /^\[film\] postRender threw/);
  });

  // The frame-time block of tick() that now carries the preFrame call.
  const ftAt = INDEX_SRC.indexOf("liveScene3dRef.frameTime = {");
  const PRE = liftBlock(INDEX_SRC, "if (liveScene3dRef) {", INDEX_SRC.lastIndexOf("if (liveScene3dRef) {", ftAt));
  const preScope = (ls) => {
    const order = [];
    return {
      order, ts: 2000.5, dt: 1 / 30, liveScene3dRef: ls, console: quietConsole(),
      tickPerFrame: (ref, sh, dt) => order.push(["tickPerFrame", ref === ls, dt]),
    };
  };
  await check("H7e tick: film.preFrame(ts, dt) runs after frameTime is stamped and BEFORE tickPerFrame", () => {
    let seen = null;
    const ls = { sessionHandle: {}, film: { preFrame: (ts, dt) => { seen = { ts, dt, ft: { ...ls.frameTime } }; s.order.push(["pre"]); } } };
    const s = preScope(ls);
    runLifted(PRE, s);
    assert.deepEqual(s.order, [["pre"], ["tickPerFrame", true, 1 / 30]]);
    assert.deepEqual(seen, { ts: 2000.5, dt: 1 / 30, ft: { tsMs: 2000.5, tsSec: 2000.5 * 0.001, dt: 1 / 30 } });
    const off = preScope({ sessionHandle: {} });
    runLifted(PRE, off);
    assert.deepEqual(off.order, [["tickPerFrame", true, 1 / 30]], "no film: unchanged");
  });
  await check("H7f a throwing preFrame never kills the frame; one [film] warn", () => {
    const ls = { sessionHandle: {}, film: { preFrame() { throw new Error("pose NaN"); } } };
    const s = preScope(ls);
    runLifted(PRE, s);
    runLifted(PRE, s);
    assert.equal(s.order.filter((o) => o[0] === "tickPerFrame").length, 2);
    assert.equal(s.console.warns.length, 1);
    assert.match(s.console.warns[0], /^\[film\] preFrame threw/);
  });

  const ONCE = `${liftBlock(INDEX_SRC, "window.__renderOnce = (tsMs) => {")};`;
  const onceScope = (ls) => {
    const s = { window: {}, liveScene3dRef: ls, ticks: [], cancels: 0, console: quietConsole() };
    s.tick = (ts) => s.ticks.push(ts);
    s._cancelSchedule = () => { s.cancels += 1; };
    runLifted(ONCE, s);
    return s;
  };
  await check("H7g __renderOnce(tsMs): an explicit finite timestamp reaches tick unchanged", () => {
    const s = onceScope({});
    assert.equal(s.window.__renderOnce(12345.678), true);
    assert.deepEqual(s.ticks, [12345.678]);
    assert.equal(s.cancels, 0, "no hold → nothing cancelled");
  });
  await check("H7h __renderOnce(): omitted / non-finite → performance.now() exactly as before", () => {
    const s = onceScope({});
    for (const arg of [undefined, NaN, Infinity, "5", null]) {
      const a = performance.now();
      s.window.__renderOnce(arg);
      const got = s.ticks[s.ticks.length - 1];
      assert.ok(got >= a && got <= performance.now(), `${String(arg)} → ${got}`);
    }
  });
  await check("H7i under film.holdLoop an explicit step cancels the pending re-arm; a bare call does not", () => {
    const s = onceScope({ film: { holdLoop: true } });
    s.window.__renderOnce(5000);
    assert.equal(s.cancels, 1);
    s.window.__renderOnce();
    assert.equal(s.cancels, 1, "the bare re-arm call is not a film step");
    const off = onceScope({ film: { holdLoop: false } });
    off.window.__renderOnce(5000);
    assert.equal(off.cancels, 0);
  });

  // tick()'s dt derivation, lifted verbatim, fed explicit film timestamps.
  const lift = (re) => { const m = re.exec(INDEX_SRC); if (!m) throw new Error(`anchor drifted: ${re}`); return m[0]; };
  const CONSTS = [
    lift(/const DT_RECOVERY_RAW_THRESHOLD_S = [^;]+;/),
    lift(/const DT_RECOVERY_FRAMES = [^;]+;/),
    lift(/const _dtRecoveryThresholdS = renderOnDemand[\s\S]*?;\n/),
  ].join("\n");
  const dtStart = INDEX_SRC.indexOf("const rawDt = lastFrameTs === null");
  const dtEnd = INDEX_SRC.indexOf("lastFrameTs = ts;", dtStart) + "lastFrameTs = ts;".length;
  if (!(dtStart > 0 && dtEnd > dtStart)) throw new Error("anchor drifted: tick() dt block");
  const DT_BLOCK = INDEX_SRC.slice(dtStart, dtEnd);
  // DT_NO_FREEZE (?dtNoFreeze, default ON 2026-10-24) replaces the freeze band
  // with the plain 0.1 s clamp; `false` is the `=off` arm (the old band).
  const makeStepper = ({ renderOnDemand, _frameIntervalMs = 0, DT_NO_FREEZE = false }) => {
    const s = { renderOnDemand, _frameIntervalMs, lastFrameTs: null, dtRecoveryFramesRemaining: 0, DT_NO_FREEZE };
    return runLifted(`${CONSTS}\nreturn (ts) => { ${DT_BLOCK}\n return dt; };`, s);
  };
  await check("H7j tick dt: strictly increasing base + k·1000/fps gives dt = 1/fps (fps ≥ 10)", () => {
    for (const fps of [24, 30, 60]) {
      for (const rod of [false, true]) {
        const step = makeStepper({ renderOnDemand: rod });
        const base = 987654.321;
        step(base);
        for (let k = 1; k <= 120; k += 1) near(step(base + (k * 1000) / fps), 1 / fps, 1e-9, `fps=${fps} k=${k}`);
      }
    }
    const slow = makeStepper({ renderOnDemand: true });
    slow(0);
    near(slow(125), 0.1, 1e-12, "fps 8 clamps to 0.1");
  });
  await check("H7k tick dt: recovery freeze only on a > 0.5 s gap from the LAST frame (off under renderOnDemand)", () => {
    const step = makeStepper({ renderOnDemand: false });
    step(1000);
    assert.equal(step(1000 + 2000), 0, "a held-loop gap freezes the first step…");
    for (let i = 1; i <= 10; i += 1) assert.equal(step(3000 + i * 33.25), 0, `…and the next 10 (${i})`);
    near(step(3000 + 11 * 33.25), 0.03325, 1e-12, "then 1/fps again");
    const rod = makeStepper({ renderOnDemand: true });
    rod(1000);
    near(rod(3000), 0.1, 1e-12, "renderOnDemand: clamp, no freeze");
  });
  await check("H7k2 ?dtNoFreeze (default): a > 0.5 s gap is just the 0.1 s clamp — the playheads keep pace with the wasm body", () => {
    const step = makeStepper({ renderOnDemand: false, DT_NO_FREEZE: true });
    step(1000);
    near(step(1000 + 2000), 0.1, 1e-12, "a held-loop gap clamps to 0.1…");
    for (let i = 1; i <= 10; i += 1) near(step(3000 + i * 33.25), 0.03325, 1e-12, `…and the next frames run at 1/fps (${i})`);
  });

  const INSTALL = liftBlock(INDEX_SRC, 'if (new URLSearchParams(window.location.search).get("filmMode") === "on") {');
  // The block's dynamic imports, pointed at a recording stub (film module + the resident particle_manager.js).
  const INSTALL_RUN = INSTALL.replace(/\bimport\(/g, "__import(");
  const PM_STUB = { setParticleCullConfig: () => ({ maxDistance: 220, recheckInterval: 6 }), allParticleManagers: () => [] };
  const installScope = (search, mod, pm = PM_STUB) => {
    const s = {
      window: { location: { search } }, console: quietConsole(), THREE: { tag: "THREE" },
      liveScene3d: { sessionHandle: { tag: "SH" }, wasmExports: { tag: "WX" } }, imports: [],
    };
    s.__import = (spec) => {
      s.imports.push(spec);
      const m = spec === "./particles/particle_manager.js" ? pm : mod;
      return m instanceof Error ? Promise.reject(m) : Promise.resolve(m);
    };
    return s;
  };
  await check("H7l ?filmMode=on (exact) lazily imports ./film/index.js + the resident particle_manager.js and installs with the injected deps (review seams-9)", async () => {
    assert.equal((INSTALL.match(/\bimport\(/g) || []).length, 2, "exactly two dynamic imports in the install block");
    let deps = null;
    const s = installScope("?agent=1&filmMode=on", { installFilmMode: (d) => { deps = d; } });
    runLifted(INSTALL_RUN, s);
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(s.imports, ["./film/index.js", "./particles/particle_manager.js"]);
    assert.ok(deps, "installFilmMode called");
    assert.equal(deps.liveScene3d, s.liveScene3d);
    assert.equal(deps.THREE, s.THREE);
    assert.equal(deps.sessionHandle, s.liveScene3d.sessionHandle);
    assert.equal(deps.wasmExports, s.liveScene3d.wasmExports);
    assert.equal(deps.particleCull.setParticleCullConfig, PM_STUB.setParticleCullConfig, "the particle cull retune seam is passed");
    assert.equal(deps.particleCull.allParticleManagers, PM_STUB.allParticleManagers, "the manager enumeration seam is passed");
    // The specifier resolves to the module entities.js / statics.js load (one instance, one RP6 config).
    const url = new URL("./particles/particle_manager.js", new URL("../scene3d/index.js", import.meta.url));
    assert.equal(url.href, new URL("../scene3d/particles/particle_manager.js", import.meta.url).href);
    const real = await import(url.href);
    assert.equal(real, PM, "the install block's specifier is the very module the H3 registry lives in");
  });
  await check("H7l a failed particle_manager.js load is the same single [film] warn (no install)", async () => {
    let called = false;
    const s = installScope("?filmMode=on", { installFilmMode() { called = true; } }, new Error("chunk 404"));
    runLifted(INSTALL_RUN, s);
    await new Promise((r) => setImmediate(r));
    assert.equal(called, false);
    assert.equal(s.console.warns.length, 1);
    assert.match(s.console.warns[0], /^\[film\] failed to load:/);
  });
  await check("H7m absent / =1 / =true / =ON / =off load nothing", async () => {
    for (const search of ["", "?filmMode=1", "?filmMode=true", "?filmMode=ON", "?filmMode=off", "?filmMode="]) {
      const s = installScope(search, { installFilmMode() { throw new Error("must not run"); } });
      runLifted(INSTALL_RUN, s);
      assert.deepEqual(s.imports, [], search);
    }
  });
  await check("H7n a failed film load is one [film] console.warn (never console.error)", async () => {
    const s = installScope("?filmMode=on", new Error("404"));
    runLifted(INSTALL_RUN, s);
    await new Promise((r) => setImmediate(r));
    assert.equal(s.console.warns.length, 1);
    assert.match(s.console.warns[0], /^\[film\] failed to load:/);
  });
  await check("H7o the film module is never imported statically (boot graph / modulepreload unchanged)", () => {
    assert.ok(!/^\s*import\s[^(;]*["']\.\/film\//m.test(INDEX_SRC));
  });
}

// ---------------------------------------------------------------------------
console.log("-- H8 atmosphere_pipeline.js: ?filmDof=on depth of field -------------------");
{
  const W = 1280, H = 720;
  const gl = new Proxy({ getContextAttributes: () => ({ alpha: false }), getExtension: () => null, getParameter: () => 0 }, {
    get(tgt, k) {
      if (k in tgt) return tgt[k];
      return typeof k === "string" && /^[A-Z_0-9]+$/.test(k) ? 1 : () => null;
    },
  });
  const renderer = {
    autoClear: true, outputColorSpace: THREE.SRGBColorSpace, toneMappingExposure: 1,
    shadowMap: { autoUpdate: true, needsUpdate: false },
    capabilities: { isWebGL2: true, maxSamples: 4, logarithmicDepthBuffer: true },
    info: { render: { frame: 0 }, autoReset: true },
    _target: null,
    getSize: (vv) => vv.set(W, H), getDrawingBufferSize: (vv) => vv.set(W, H), getPixelRatio: () => 1,
    setSize() {}, setOpaqueSort() {}, setTransparentSort() {}, getContext: () => gl,
    getRenderTarget() { return this._target; },
    setRenderTarget(rt) { this._target = rt ?? null; },
    render() {},
    clear() {}, clearDepth() {}, setClearColor() {}, getClearColor: (c) => c, getClearAlpha: () => 1, setClearAlpha() {},
    state: { buffers: { stencil: { setFunc() {} } } }, properties: { get: () => ({}) },
  };
  const { createAtmospherePipeline } = await import("../scene3d/atmosphere_pipeline.js");
  const { CloudOverlay } = await import("../scene3d/cloud_overlay.js");
  const PP = await import("postprocessing");
  const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 5000);
  camera.layers.enable(1);
  camera.updateMatrixWorld(true);
  const quiet = async (fn) => {
    const l = console.log, w = console.warn;
    console.log = () => {};
    console.warn = () => {};
    try { return await fn(); } finally { console.log = l; console.warn = w; }
  };
  const build = (opts = {}, { clouds = false } = {}) => quiet(() => {
    const skyScene = new THREE.Scene();
    skyScene.name = "sky";
    const skyCamera = new THREE.PerspectiveCamera();
    let cloudOverlay;
    if (clouds) {
      cloudOverlay = new CloudOverlay({ camera, proceduralTextures: true });
      cloudOverlay.attachToSkyScene(skyScene);
    }
    return createAtmospherePipeline(renderer, new THREE.Scene(), camera, {
      atmosphereRuntime: { textures: {} }, skyScene, skyCamera, bloom: true, vignette: false, msaa: 2,
      portalPunch: true, punchRetail: true, cloudOverlay, ...opts,
    });
  });
  const shaderSig = (pass) => pass ? JSON.stringify({
    f: pass.fullscreenMaterial.fragmentShader, v: pass.fullscreenMaterial.vertexShader,
    d: pass.fullscreenMaterial.defines, u: Object.keys(pass.fullscreenMaterial.uniforms).sort(),
  }) : null;
  const names = (pass) => pass.effects.map((e) => e.name);
  // Fragment samplers the driver links: the compound shader run through a
  // tiny #if/#ifdef preprocessor with the material's defines (pmndrs declares
  // the DoF colour buffers once per precision branch).
  const preprocess = (src, defines) => {
    const D = { ...defines };
    const stack = [];
    const out = [];
    const active = () => stack.every((f) => f.on);
    const evalIf = (e) => {
      let js = e.replace(/defined\s*\(\s*(\w+)\s*\)/g, (_, n) => (n in D ? "1" : "0")).replace(/defined\s+(\w+)/g, (_, n) => (n in D ? "1" : "0"));
      js = js.replace(/\b([A-Za-z_]\w*)\b/g, (_, n) => (n in D ? String(Number(D[n]) || (D[n] === true ? 1 : 0)) : "0"));
      // eslint-disable-next-line no-new-func
      try { return !!Function(`return (${js});`)(); } catch (_) { return false; }
    };
    for (const line of src.split("\n")) {
      const tl = line.trim();
      let m;
      if ((m = /^#ifdef\s+(\w+)/.exec(tl))) { const on = m[1] in D; stack.push({ on, done: on }); continue; }
      if ((m = /^#ifndef\s+(\w+)/.exec(tl))) { const on = !(m[1] in D); stack.push({ on, done: on }); continue; }
      if ((m = /^#if\s+(.*)/.exec(tl))) { const on = evalIf(m[1]); stack.push({ on, done: on }); continue; }
      if ((m = /^#elif\s+(.*)/.exec(tl))) { const f = stack[stack.length - 1]; f.on = !f.done && evalIf(m[1]); f.done ||= f.on; continue; }
      if (/^#else\b/.test(tl)) { const f = stack[stack.length - 1]; f.on = !f.done; f.done = true; continue; }
      if (/^#endif\b/.test(tl)) { stack.pop(); continue; }
      if ((m = /^#define\s+(\w+)\s*(.*)$/.exec(tl)) && active()) { D[m[1]] = m[2] || ""; continue; }
      if (active()) out.push(line);
    }
    return out.join("\n");
  };
  const samplers = (pass) => (preprocess(pass.fullscreenMaterial.fragmentShader, pass.fullscreenMaterial.defines || {})
    .match(/uniform\s+(?:\w+\s+)?sampler2D\s+\w+/g) || []).length;
  const passNames = (p) => p.composer.passes.map((x) => x.name).join(" | ");
  const spyDofPasses = (eff) => {
    const calls = [];
    for (const k of ["cocPass", "blurPass", "maskPass", "bokehNearBasePass", "bokehNearFillPass", "bokehFarBasePass", "bokehFarFillPass"]) {
      const pass = eff[k];
      const orig = pass.render.bind(pass);
      pass.render = (...a) => { calls.push(k); return orig(...a); };
    }
    return calls;
  };
  const skyDome = { _lastIsIndoor: false, _lastSkyBlocked: false, syncSkyCamera() {} };
  const frame = (p) => quiet(() => { p.preFrameSkySync(skyDome, camera); p.render(camera, 1 / 30); });

  await check("H8a flag off (absent): no DoF, no window.__dof, no filmDof key — the legacy pass is as before", async () => {
    delete globalThis.__dof;
    location.search = "";
    const p = await build();
    assert.equal(globalThis.__dof, undefined);
    assert.ok(!("filmDof" in p));
    assert.ok(!names(p.fxPass).includes("DepthOfFieldEffect"));
    p.dispose();
  });
  await check("H8b only the exact `?filmDof=on` builds it (=ON / =1 / =true / =off do not)", async () => {
    for (const search of ["?filmDof=ON", "?filmDof=1", "?filmDof=true", "?filmDof=off"]) {
      delete globalThis.__dof;
      location.search = search;
      const p = await build();
      assert.equal(globalThis.__dof, undefined, search);
      assert.ok(!names(p.fxPass).includes("DepthOfFieldEffect"), search);
      p.dispose();
    }
    delete globalThis.__dof;
    location.search = "?foo=1&filmDof=on";
    const p = await build();
    try {
      assert.ok(globalThis.__dof && globalThis.__dof.effect instanceof PP.DepthOfFieldEffect);
      assert.equal(p.filmDof, globalThis.__dof.effect);
      assert.ok(names(p.fxPass).includes("DepthOfFieldEffect"));
    } finally {
      p.dispose();
      location.search = "";
    }
    assert.equal(globalThis.__dof, undefined, "dispose drops the global handle");
  });

  for (const clouds of [false, true]) {
    const chain = clouds ? "split chain (?clouds=on)" : "legacy single pass";
    const off = await build({ filmDof: false }, { clouds });
    const sigOff = [shaderSig(off.fxPass), shaderSig(off.fxPostPass)];
    const passesOff = passNames(off);
    off.dispose();
    const p = await build({ filmDof: true }, { clouds });
    const dof = globalThis.__dof;
    const eff = dof.effect;
    const host = clouds ? p.fxPostPass : p.fxPass;
    await check(`H8c ${chain}: one DoF, idle = compound shaders + pass list byte-identical to the flag off`, () => {
      assert.equal(p.composer.passes.flatMap((x) => x.effects ?? []).filter((e) => e instanceof PP.DepthOfFieldEffect).length, 1);
      assert.equal(passNames(p), passesOff, "no pass added");
      assert.equal(shaderSig(p.fxPass), sigOff[0], "fxPass shader");
      assert.equal(shaderSig(p.fxPostPass), sigOff[1], "fxPostPass shader");
      assert.equal(dof.enabled, false);
      assert.equal(eff.blendMode.blendFunction, PP.BlendFunction.DST, "idle = left out of the shader");
    });
    await check(`H8d ${chain}: placed after the atmosphere, ahead of glow / bloom / tone mapping`, () => {
      const n = names(host);
      const i = n.indexOf("DepthOfFieldEffect");
      assert.ok(i >= 0, n.join(","));
      for (const later of ["FxGlowEffect", "BloomEffect", "VignetteEffect", "ToneMappingEffect", "ColorGradeEffect", "DitheringEffect"]) {
        if (n.includes(later)) assert.ok(n.indexOf(later) > i, `${later} after DoF: ${n.join(",")}`);
      }
      if (clouds) {
        assert.equal(i, 0, "first in the post half");
        assert.ok(names(p.fxPass).includes("AerialPerspectiveEffect"), "the atmosphere is upstream");
      } else {
        assert.ok(n.indexOf("AerialPerspectiveEffect") < i, "after aerial perspective");
      }
    });
    await check(`H8e ${chain}: idle costs no pass — update() skips the CoC / blur / mask / bokeh passes`, async () => {
      const calls = spyDofPasses(eff);
      await frame(p);
      assert.deepEqual(calls, []);
    });
    await check(`H8f ${chain}: enabled = one recompile that integrates the DoF (+4 samplers) and runs its passes in-frame`, async () => {
      const before = samplers(host);
      const sig0 = shaderSig(host);
      dof.enabled = true;
      assert.equal(eff.blendMode.blendFunction, PP.BlendFunction.NORMAL);
      assert.equal(eff.blendMode.opacity.value, 1);
      assert.notEqual(shaderSig(host), sig0, "recompiled");
      assert.equal(samplers(host), before + 4, `${before} → ${samplers(host)}`);
      assert.ok(samplers(host) <= 16, "within ANGLE/D3D11's 16 fragment samplers at these settings");
      let recompiles = 0;
      const rc = host.recompile.bind(host);
      host.recompile = () => { recompiles += 1; rc(); };
      dof.enabled = true;
      assert.equal(recompiles, 0, "a no-change write does not recompile");
      host.recompile = rc;
      eff.__calls = spyDofPasses(eff);
      await frame(p);
      assert.deepEqual(eff.__calls, ["cocPass", "blurPass", "maskPass", "bokehFarBasePass", "bokehFarFillPass", "bokehNearBasePass", "bokehNearFillPass"]);
    });
    await check(`H8g ${chain}: rack focus — focusDistance / focusRange / bokehScale reach the effect; bad values throw`, () => {
      dof.focusDistance = 3.5;
      assert.equal(eff.cocMaterial.uniforms.focusDistance.value, 3.5);
      dof.focusDistance = 42;
      assert.equal(dof.focusDistance, 42);
      dof.focusRange = 2;
      assert.equal(eff.cocMaterial.uniforms.focusRange.value, 2);
      dof.bokehScale = 3;
      assert.equal(eff.bokehScale, 3);
      assert.equal(eff.bokehNearBasePass.fullscreenMaterial.uniforms.scale.value, 3);
      for (const [k, bad] of [["focusDistance", -1], ["focusDistance", NaN], ["focusRange", 0], ["bokehScale", Infinity], ["focusRange", "2"]]) {
        assert.throws(() => { dof[k] = bad; }, RangeError, `${k}=${bad}`);
      }
      assert.equal(dof.focusDistance, 42, "a rejected value changes nothing");
    });
    await check(`H8h ${chain}: autofocus target (THREE world) sets the focus distance from the camera each enabled frame`, async () => {
      const tgt = new THREE.Vector3(0, 0, -25);
      dof.target = tgt;
      assert.equal(dof.target, tgt, "a Vector3 is kept by reference");
      await frame(p);
      near(eff.cocMaterial.focusDistance, 25, 1e-6);
      tgt.set(0, 0, -7);
      await frame(p);
      near(eff.cocMaterial.focusDistance, 7, 1e-6, "moved target followed");
      dof.target = [3, 4, 0];
      assert.ok(dof.target.isVector3 && dof.target.x === 3, "array copied into a Vector3");
      assert.throws(() => { dof.target = [1, 2]; }, TypeError);
      assert.throws(() => { dof.target = { x: 1, y: NaN, z: 0 }; }, TypeError);
      dof.target = null;
      assert.equal(eff.target, null);
    });
    await check(`H8i ${chain}: camera retarget (setCamera / render(cam)) re-points the DoF camera + CoC near/far`, async () => {
      const cam2 = new THREE.PerspectiveCamera(50, 16 / 9, 0.1, 3000);
      await quiet(() => p.setCamera(cam2));
      assert.equal(eff.camera, cam2);
      assert.equal(eff.cocMaterial.uniforms.cameraFar.value, 3000);
      const cam3 = new THREE.PerspectiveCamera(50, 16 / 9, 0.1, 4000);
      await quiet(() => p.render(cam3, 0));
      assert.equal(eff.camera, cam3);
      assert.equal(eff.cocMaterial.uniforms.cameraFar.value, 4000);
      await quiet(() => p.setCamera(camera));
      assert.equal(eff.camera, camera);
      assert.equal(eff.cocMaterial.uniforms.cameraFar.value, 5000);
    });
    await check(`H8j ${chain}: the CoC decodes the log depth buffer itself; disabling restores the idle shader`, async () => {
      assert.equal(eff.cocMaterial.defines.LOG_DEPTH, "1", "pmndrs LOG_DEPTH from renderer.capabilities");
      dof.enabled = false;
      assert.equal(eff.blendMode.blendFunction, PP.BlendFunction.DST);
      // GLSL back to the flag-off compound shader. pmndrs merges defines /
      // uniforms on every recompile and never prunes, so the DoF's renamed
      // keys linger UNUSED in the material (any recompile does that, e.g. a
      // `__horizonFade` toggle); every flag-off key keeps its flag-off value.
      const now = JSON.parse(shaderSig(host));
      const ref = JSON.parse(clouds ? sigOff[1] : sigOff[0]);
      assert.equal(now.f, ref.f, "fragment shader");
      assert.equal(now.v, ref.v, "vertex shader");
      for (const [k, val] of Object.entries(ref.d)) assert.equal(now.d[k], val, `define ${k}`);
      for (const k of Object.keys(now.d)) {
        if (k in ref.d) continue;
        const macro = k.split("(")[0]; // function-like macros: `e2ToneMapping(texel)`
        assert.ok(!new RegExp(`\\b${macro}\\b`).test(now.f), `stale define ${k} is unused`);
      }
      for (const k of ref.u) assert.ok(now.u.includes(k), `uniform ${k}`);
      const calls = spyDofPasses(eff);
      await frame(p);
      assert.deepEqual(calls, [], "idle again: no DoF passes");
    });
    p.dispose();
    await check(`H8k ${chain}: dispose drops window.__dof`, () => assert.equal(globalThis.__dof, undefined));
  }
}

// Leave the shared clocks as found.
FX.setFxTimeSource(null);
FX.setFxNearFadeMin(0);

console.log(`\nfilm_hooks: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
process.exit(0);
