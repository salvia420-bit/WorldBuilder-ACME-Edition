// Regression test for the RP6 particle VISIBILITY LEAK
// (HANDOFF-perf-particles-rp6-leak-2026-07-15 §3, fixed 2026-07-15).
//
// THE BUG — two writers, one `mesh.visible`:
//   `_staticParticleManager` is built with `scene: scene3d.staticsGroup`
//   (statics.js), so emitParticle() adds every per-slot particle mesh as a
//   DIRECT CHILD of staticsGroup. `cullStaticsGroup` walks `group.children`
//   and writes `node.visible = want` from a FRUSTUM-ONLY test, EVERY frame
//   (tickPerFrame). RP6 culls per EMITTER — frustum AND a distance cap
//   (`_RP6.maxDistance`) that the statics pass does not apply — but it used to
//   write visibility only on a cull TRANSITION, from its own rAF (`_spLoop`),
//   every `_RP6.recheckInterval` ticks. The per-frame writer therefore beat the
//   per-transition one and resurrected particles RP6 had culled: measured 140
//   of 152 drawn particles (92%) at a settled Cragstone.
//
// The leaking population is precisely the one the two tests disagree about:
// IN frustum, far beyond RP6's distance cap, frozen mid-air. Test 1 pins that
// exact case with the REAL manager + the REAL cullStaticsGroup — no replica,
// because the bug lived in the SEAM between them and a mock of either side
// would have asserted the seam away.
//
// Guards, in order:
//   1. cullStaticsGroup does not resurrect a distance-culled emitter's
//      particles (the 92% case). THE REGRESSION.
//   2. RP6's cull is authoritative PER TICK, not per transition: a hostile
//      per-frame writer is corrected on the next tick.
//   3. cullStaticsGroup still culls REAL statics (the skip is particle-scoped,
//      not a blanket early-out that would silently disable the statics cull).
//   4. Re-entry still restores particles (the cull stays reversible).
//
// Run from apps/holtburger-web/:  node test_particle_rp6_cull_authority.mjs

import * as THREE from "three";

let passed = 0, failed = 0;
function check(name, ok, detail) {
  console.log(`  [${ok ? "OK" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
  if (ok) passed++; else failed++;
}

// Persistent Still emitter: totalParticles==0 && totalSeconds==0 means it never
// auto-finishes, which is what every static default_script emitter measured in
// the field actually is (handoff §5.6) — so it exercises the `continue` path
// that skips updateParticles while culled.
function emitterPojo() {
  return {
    // particleType 1 = Still (ParticleType.Unknown is 0, and its update() arm
    // LEAVES mesh.position UNCHANGED — an emitter built with 0 parks every
    // particle at the local origin no matter where its anchor is, which
    // silently voids any test that depends on particle placement).
    id: 0, emitterType: 1, particleType: 1 /* Still */, gfxObjId: 0, hwGfxObjId: 0x010010F9,
    birthrate: 0.1, maxParticles: 2, initialParticles: 1, totalParticles: 0, totalSeconds: 0,
    lifespan: 1000, lifespanRand: 0, offsetDirX: 0, offsetDirY: 0, offsetDirZ: 0,
    minOffset: 0, maxOffset: 0, aX: 0, aY: 0, aZ: 0, minA: 0, maxA: 0,
    bX: 0, bY: 0, bZ: 0, cX: 0, cY: 0, cZ: 0,
    scaleRand: 0, startScale: 0.45, finalScale: 0.45, transRand: 0,
    startTrans: 0, finalTrans: 0, isParentLocal: true, billboard: false,
  };
}

function makeQuad(half = 0.147) {
  const g = new THREE.BufferGeometry();
  const v = new Float32Array([
    -half, 0, -half, half, 0, -half, half, 0, half,
    -half, 0, -half, half, 0, half, -half, 0, half,
  ]);
  g.setAttribute("position", new THREE.BufferAttribute(v, 3));
  g.computeVertexNormals();
  return g;
}

// Every occupied slot mesh of every emitter, and whether it would be submitted.
function partStates(mgr) {
  const out = [];
  for (const [, e] of mgr.particleTable) {
    for (const m of e.parts) if (m) out.push(m);
  }
  return out;
}
const visibleCount = (mgr) => partStates(mgr).filter((m) => m.visible).length;

async function run() {
  globalThis.window = globalThis.window || {};
  window.location = { search: "" };
  // statics.js arms self-managed rAF loops at module scope; stub them so the
  // import doesn't throw and no loop actually runs under the test.
  window.requestAnimationFrame = () => 0;
  window.cancelAnimationFrame = () => {};

  const { setCurrentTime } = await import("./scene3d/particles/time_rng.js");
  let t = 1000;
  setCurrentTime(() => t);

  const { ParticleManager } = await import("./scene3d/particles/particle_manager.js");
  const { cullStaticsGroup } = await import("./scene3d/statics.js");

  // staticsGroup stand-in: the REAL manager parents slot meshes here, and the
  // REAL cullStaticsGroup walks exactly this children list. That shared list is
  // the seam under test.
  const staticsGroup = new THREE.Group();
  const cam = new THREE.PerspectiveCamera(60, 1.6, 0.1, 10000);
  window.liveScene3d = { cameraSwitcher: { activeCamera: cam }, camera: cam };

  const geom = makeQuad();
  const mgr = new ParticleManager({
    scene: staticsGroup,
    geometryFactory: () => geom,
    materialFactory: () => new THREE.MeshBasicMaterial({ transparent: true }),
  });

  // A culler with the SAME contract loop.js passes in (culling.js FrustumCuller):
  // valid + isSphereInFrustum + getDistanceSq. Real frustum maths off the real
  // camera — only the plumbing is local.
  const _projScreen = new THREE.Matrix4();
  const _frustum = new THREE.Frustum();
  const culler = {
    valid: true,
    update() {
      cam.updateMatrixWorld(true);
      _projScreen.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
      _frustum.setFromProjectionMatrix(_projScreen);
    },
    isSphereInFrustum: (s) => _frustum.intersectsSphere(s),
    getDistanceSq: (x, y, z) => cam.position.distanceToSquared(new THREE.Vector3(x, y, z)),
  };

  // Reproduce the FIELD condition, in order — the leaking particle is one that
  // was emitted while on-screen and then abandoned:
  //   (1) camera NEXT TO the emitter so it ticks live and its slot meshes get
  //       POSITIONED at the anchor. This step is load-bearing: an emitter that
  //       is culled from birth never runs updateParticles, so its meshes sit at
  //       the local origin and the statics cull tests a sphere that has nothing
  //       to do with the anchor — an earlier draft of this test "passed" on
  //       BROKEN source for exactly that reason.
  //   (2) camera retreats to 1200 m — past RP6's 220 m cap — while keeping the
  //       anchor dead-centre of frustum (far=10000). RP6 culls on distance; the
  //       statics pass, which has NO distance horizon by default
  //       (CULL_DIST_SQ === Infinity), still says "in frustum".
  // That disagreement, over frozen mid-air particles, IS the leak.
  const anchor = new THREE.Vector3(0, 0, -1200);
  cam.position.set(0, 0, -1195);
  cam.lookAt(anchor);
  cam.updateMatrixWorld(true);

  await mgr.addEmitter({
    emitterInfo: emitterPojo(),
    parent: { position: anchor.clone(), quaternion: new THREE.Quaternion() },
    partIndex: -1,
  });

  // (1) tick live and near, so the particles are emitted AND positioned.
  for (let i = 0; i < 64; i++) { t += 0.05; mgr.tick(); }
  {
    let placed = 0;
    for (const m of partStates(mgr)) if (m.position.distanceTo(anchor) < 5) placed++;
    check("setup: particles were emitted AND positioned at the anchor",
      placed > 0 && placed === partStates(mgr).length,
      `placed=${placed}/${partStates(mgr).length}`);
  }

  // (2) retreat past the cap, anchor still dead ahead.
  cam.position.set(0, 0, 0);
  cam.lookAt(0, 0, -1);
  cam.updateMatrixWorld(true);
  culler.update();

  // Tick until RP6 has actually evaluated this emitter. The cull re-evaluates
  // only every _RP6.recheckInterval ticks, so a single tick can land between
  // rechecks and read as "not culled yet" — drive enough ticks to cross one.
  let emitter = null;
  for (const [, e] of mgr.particleTable) emitter = e;
  for (let i = 0; i < 64; i++) { t += 0.05; mgr.tick(); }

  check("setup: emitter has an occupied slot to leak", partStates(mgr).length >= 1,
    `parts=${partStates(mgr).length}`);
  check("setup: RP6 culled the emitter (1200 m ≫ 220 m cap)", emitter._rp6Culled === true,
    `_rp6Culled=${emitter._rp6Culled}`);
  check("setup: RP6 hid its particles", visibleCount(mgr) === 0,
    `visible=${visibleCount(mgr)}/${partStates(mgr).length}`);

  // LOAD-BEARING SANITY: the statics pass must genuinely WANT these visible,
  // or guard 1 below passes for the boring reason that nothing tried to
  // resurrect anything (the first draft of this test did exactly that, and was
  // green against broken source). Assert on the sphere cullStaticsGroup ACTUALLY
  // derives — centred on the MESH's own `node.position`, which is the thing the
  // emit+position step above put at the anchor — not on a sphere we invent.
  {
    let wanted = 0;
    for (const m of partStates(mgr)) {
      const bs = m.geometry.boundingSphere;
      const s = new THREE.Sphere(m.position.clone(), (bs?.radius ?? 0) + (bs?.center.length() ?? 0));
      if (culler.isSphereInFrustum(s)) wanted++;
    }
    check("setup: statics frustum test says 'in' for the REAL particle spheres (so it WOULD resurrect)",
      wanted === partStates(mgr).length, `wanted=${wanted}/${partStates(mgr).length}`);
  }

  // ---- 1. THE REGRESSION: the statics cull must not resurrect particles ----
  cullStaticsGroup({ staticsGroup }, culler);
  check("1. cullStaticsGroup does NOT resurrect distance-culled particles",
    visibleCount(mgr) === 0, `visible=${visibleCount(mgr)}/${partStates(mgr).length}`);

  // ...and not just on the first pass: it runs every frame, RP6 does not.
  for (let i = 0; i < 30; i++) cullStaticsGroup({ staticsGroup }, culler);
  check("1b. still hidden after 30 more statics-cull frames",
    visibleCount(mgr) === 0, `visible=${visibleCount(mgr)}/${partStates(mgr).length}`);

  // ---- 2. RP6 is authoritative PER TICK, not per transition ----
  // Simulate ANY hostile per-frame writer (this is what cullStaticsGroup used
  // to be). No transition occurs here — the emitter stays culled throughout —
  // so a per-transition cull can never correct this, and a per-tick one always
  // does. This guard is what makes the fix robust to the NEXT such writer.
  for (const m of partStates(mgr)) m.visible = true;
  check("2. precondition: hostile writer made them visible", visibleCount(mgr) > 0,
    `visible=${visibleCount(mgr)}`);
  t += 0.05; mgr.tick();
  check("2. one tick re-hides them with NO cull transition",
    visibleCount(mgr) === 0, `visible=${visibleCount(mgr)}/${partStates(mgr).length}`);

  // ---- 3. the skip is particle-scoped: real statics still cull ----
  // A static mesh far off to the side, outside the frustum → must be hidden.
  const realStatic = new THREE.Mesh(makeQuad(2), new THREE.MeshBasicMaterial());
  realStatic.position.set(5000, 0, 5000); // behind/beside the camera
  staticsGroup.add(realStatic);
  const inFrustumStatic = new THREE.Mesh(makeQuad(2), new THREE.MeshBasicMaterial());
  inFrustumStatic.position.set(0, 0, -50); // dead ahead
  staticsGroup.add(inFrustumStatic);
  const r = cullStaticsGroup({ staticsGroup }, culler);
  check("3. off-frustum REAL static is culled", realStatic.visible === false);
  check("3. in-frustum REAL static stays visible", inFrustumStatic.visible === true);
  check("3. statics cull still tests real statics (particles excluded from diag)",
    r.tested === 2 && r.culled === 1, `tested=${r.tested} culled=${r.culled}`);
  check("3. particles remained hidden through the real-statics pass",
    visibleCount(mgr) === 0, `visible=${visibleCount(mgr)}/${partStates(mgr).length}`);

  // ---- 4. the cull is still REVERSIBLE (re-entry restores) ----
  // Walk the camera to the emitter: RP6 must bring its particles back.
  cam.position.set(0, 0, -1195);
  cam.lookAt(0, 0, -1200);
  cam.updateMatrixWorld(true);
  culler.update();
  for (let i = 0; i < 64; i++) { t += 0.05; mgr.tick(); }
  check("4. re-entry: RP6 un-culls the emitter", emitter._rp6Culled === false,
    `_rp6Culled=${emitter._rp6Culled}`);
  check("4. re-entry: its particles are visible again", visibleCount(mgr) > 0,
    `visible=${visibleCount(mgr)}/${partStates(mgr).length}`);
  cullStaticsGroup({ staticsGroup }, culler);
  check("4. re-entry: the statics pass leaves un-culled particles alone",
    visibleCount(mgr) > 0, `visible=${visibleCount(mgr)}/${partStates(mgr).length}`);

  console.log(`\n[test_particle_rp6_cull_authority] ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

run().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
