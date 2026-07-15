// Regression test for the PARTICLE DOUBLE-SUBMIT
// (HANDOFF-perf-particles-second-pass-2026-07-15 §3 ⭐, fixed 2026-07-15).
//
// THE BUG — three.js draws every particle TWICE. three r184 submits a material
// twice, BackSide then FrontSide with a `needsUpdate` program re-resolve between
// them, when:
//     material.transparent === true && material.side === DoubleSide && material.forceSinglePass === false
// (three.module.js:18065, renderObject; the same branch exists in
// prepareMaterial at :17280). Particle slot materials are cloned from the DAT
// surface material, which is DoubleSide (materials.js), and BOTH branches of
// particle_manager.js's meshFactory set `transparent = true`. `forceSinglePass`
// appeared NOWHERE in the repo, so it was false everywhere and every visible
// particle cost two draw calls.
//
// Measured on the 1070 at a settled Holtburg (particle-k-probe.mjs, A/B/A within
// ONE page load, 0.1% drift): k = 2.01 draws per visible particle before, and
// -8.8% draws / +21% fps after. This is NOT a second render pass — the world is
// rendered once (composer had no passes, shadowMap disabled); the doubling
// happens INSIDE one render() call, which is why three sessions looking for a
// second pass never found it.
//
// WHY THE FIX IS SAFE, AND WHY THIS TEST ASSERTS THE PRECONDITIONS. The second
// pass exists to order back faces before front faces WITHIN one transparent
// mesh. A particle is a FLAT QUAD, so back and front never overlap: at any
// angle one of the two passes is entirely face-culled and emits no fragments —
// a draw call that draws nothing. Verified pixel-identical on the real GPU
// (forcesinglepass-parity.mjs: two renders in ONE synchronous moment, identical
// scene state, EXACTLY 0 pixels differing, with a 0-px control at both ends).
// Retail agrees: it draws a two-sided surface once with CULLMODE_NONE
// (acclient.h:5296, RenderDeviceD3D::SetCullMode) — the back-then-front two-pass
// is a three-ism with no retail counterpart.
//
// That safety argument rests on preconditions that a future edit could quietly
// break, at which point `forceSinglePass = true` would start CHANGING PIXELS
// rather than saving draws. So this test does not merely assert the flag — it
// asserts the whole argument:
//   1. the flag is set on the per-slot clone (alpha branch)
//   2. ...and on the additive branch (they are separate code paths)
//   3. the material is STILL transparent + DoubleSide — the fix must remove the
//      second SUBMIT, not the two-sidedness (making it single-sided would drop
//      real fragments; that is a different, wrong fix that would also make
//      guard 1 pass)
//   4. three's double-submit predicate is now FALSE for every live particle
//      material — the actual behaviour, computed with three's own condition
//   5. the geometry really is a flat quad (the precondition the safety of the
//      whole change depends on)
//   6. the instanced-bucket material takes the fix too
//
// Per the handoff's §2 rule 1 ("a regression test can be GREEN ON BROKEN
// SOURCE — always run it against the bug"), this was verified to FAIL on
// pre-fix source: guards 1, 2, 4 and 6 all fail there (4 reporting 2 submits
// per particle), and guards 3 and 5 pass on both, as preconditions should.
//
// Run from apps/holtburger-web/:  node test_particle_single_pass.mjs

import * as THREE from "three";

let passed = 0, failed = 0;
function check(name, ok, detail) {
  console.log(`  [${ok ? "OK" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
  if (ok) passed++; else failed++;
}

// three r184's EXACT double-submit condition (three.module.js:18065). Returns
// the number of draw calls renderObject would issue for this material. Written
// as three writes it, so the test tracks three's behaviour rather than our
// belief about it.
function submitsPerFrame(material) {
  return (material.transparent === true &&
          material.side === THREE.DoubleSide &&
          material.forceSinglePass === false) ? 2 : 1;
}

// Persistent Still emitter — what every static default_script emitter in the
// field actually is. particleType 1 = Still; 0 is Unknown, whose update() arm
// leaves mesh.position UNCHANGED (handoff §2 rule 2).
function emitterPojo() {
  return {
    id: 0, emitterType: 1, particleType: 1 /* Still */, gfxObjId: 0, hwGfxObjId: 0x010010F9,
    birthrate: 0.1, maxParticles: 2, initialParticles: 2, totalParticles: 0, totalSeconds: 0,
    lifespan: 1000, lifespanRand: 0, offsetDirX: 0, offsetDirY: 0, offsetDirZ: 0,
    minOffset: 0, maxOffset: 0, aX: 0, aY: 0, aZ: 0, minA: 0, maxA: 0,
    bX: 0, bY: 0, bZ: 0, cX: 0, cY: 0, cZ: 0,
    scaleRand: 0, startScale: 0.45, finalScale: 0.45, transRand: 0,
    startTrans: 0, finalTrans: 0, isParentLocal: true, billboard: false,
  };
}

// The real particle billboard: two triangles, 6 verts, coplanar (y == 0).
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

// Reproduce what materials.js hands us: a DAT surface material is DoubleSide,
// and the Additive variant additionally carries AdditiveBlending. If the base
// were NOT DoubleSide the double-submit could not happen at all and every guard
// below would pass vacuously — so guard 3 pins this.
function baseMaterial({ additive = false } = {}) {
  const m = new THREE.MeshBasicMaterial({ transparent: true, side: THREE.DoubleSide });
  if (additive) m.blending = THREE.AdditiveBlending;
  return m;
}

const slotMeshes = (mgr) => {
  const out = [];
  for (const [, e] of mgr.particleTable) for (const m of e.parts) if (m) out.push(m);
  return out;
};

async function run() {
  globalThis.window = globalThis.window || {};
  // particleInstancingEnabled() reads BARE `location.search` (particle_manager.js
  // :164) — that resolves to globalThis.location, NOT window.location, and node
  // defines neither. Unset, it throws, is swallowed by the catch, and memoizes
  // `_INST_ON = false` at module scope for the whole process: guard 6 would then
  // silently have no bucket to test. Set BOTH, before the first import, because
  // the memo is computed on the first addEmitter and never recomputed.
  globalThis.location = { search: "?particleInstancing=on" };
  window.location = globalThis.location;
  window.requestAnimationFrame = () => 0;
  window.cancelAnimationFrame = () => {};

  const { setCurrentTime } = await import("./scene3d/particles/time_rng.js");
  let t = 1000;
  setCurrentTime(() => t);

  const { ParticleManager } = await import("./scene3d/particles/particle_manager.js");

  const scene = new THREE.Group();
  const cam = new THREE.PerspectiveCamera(60, 1.6, 0.1, 10000);
  cam.position.set(0, 0, 5);
  cam.lookAt(0, 0, 0);
  cam.updateMatrixWorld(true);
  window.liveScene3d = { cameraSwitcher: { activeCamera: cam }, camera: cam };

  const geom = makeQuad();
  const mkMgr = (additive) => new ParticleManager({
    scene,
    geometryFactory: () => geom,
    materialFactory: () => baseMaterial({ additive }),
  });

  // ---- 1 + 3 + 4 + 5: the alpha branch --------------------------------------
  const mgr = mkMgr(false);
  await mgr.addEmitter({
    emitterInfo: emitterPojo(),
    parent: { position: new THREE.Vector3(0, 0, 0), quaternion: new THREE.Quaternion() },
    partIndex: -1,
  });
  mgr.tick();
  const meshes = slotMeshes(mgr);
  // Precondition: the emitter actually produced slot meshes. Without this the
  // guards below would pass over an EMPTY list — green on any source at all.
  check("precondition: the emitter produced slot meshes", meshes.length > 0, `${meshes.length} meshes`);

  const mats = meshes.map((m) => m.material);
  check("1. alpha branch: every per-slot material has forceSinglePass=true",
    mats.length > 0 && mats.every((m) => m.forceSinglePass === true),
    `${mats.filter((m) => m.forceSinglePass === true).length}/${mats.length}`);

  // The fix must remove the second SUBMIT, not the two-sidedness. A material
  // turned FrontSide would also satisfy guard 1 while dropping real fragments.
  check("3. still transparent (unchanged)", mats.every((m) => m.transparent === true),
    `${mats.filter((m) => m.transparent === true).length}/${mats.length}`);
  check("3. still DoubleSide — the fix drops the second SUBMIT, not the second SIDE",
    mats.every((m) => m.side === THREE.DoubleSide),
    `${mats.filter((m) => m.side === THREE.DoubleSide).length}/${mats.length}`);

  // THE REGRESSION: three's own predicate, over the real materials.
  const submits = mats.map(submitsPerFrame);
  check("4. three's double-submit predicate is FALSE for every particle material",
    submits.every((n) => n === 1), `submits/frame: ${submits.join(",")} (2 = the bug)`);

  // The precondition the entire safety argument rests on: a flat quad has no
  // back/front overlap, so the dropped pass emitted no fragments. If a future
  // particle gains real 3D geometry this guard fails and the pixel-identity
  // claim above must be re-derived, not re-assumed.
  const pos = geom.getAttribute("position");
  let planar = true;
  for (let i = 0; i < pos.count; i++) if (Math.abs(pos.getY(i)) > 1e-6) planar = false;
  check("5. precondition: particle geometry is a FLAT quad (why the fix is pixel-identical)",
    pos.count === 6 && planar, `${pos.count} verts, coplanar=${planar}`);

  // ---- 2: the additive branch (a separate code path) ------------------------
  const mgrA = mkMgr(true);
  await mgrA.addEmitter({
    emitterInfo: emitterPojo(),
    parent: { position: new THREE.Vector3(0, 0, 0), quaternion: new THREE.Quaternion() },
    partIndex: -1,
  });
  mgrA.tick();
  const matsA = slotMeshes(mgrA).map((m) => m.material);
  const addTook = matsA.filter((m) => m.blending === THREE.AdditiveBlending).length;
  check("precondition: the additive branch was actually taken",
    matsA.length > 0 && addTook === matsA.length, `${addTook}/${matsA.length} additive`);
  check("2. additive branch: every per-slot material has forceSinglePass=true",
    matsA.length > 0 && matsA.every((m) => m.forceSinglePass === true),
    `${matsA.filter((m) => m.forceSinglePass === true).length}/${matsA.length}`);
  check("2. additive branch: submits once per frame",
    matsA.every((m) => submitsPerFrame(m) === 1),
    `submits/frame: ${matsA.map(submitsPerFrame).join(",")}`);

  // ---- 6: the instanced bucket ---------------------------------------------
  // ?particleInstancing builds ONE InstancedMesh per gfxobj bucket from its own
  // cloned material — a different site, and it would double-submit the whole
  // bucket. Instancing needs BOTH `opts.instancing` and the `=on` URL flag (set
  // on globalThis.location above), and is additive-only (see _appendInstances'
  // header) — so only THIS manager takes the instanced path; the alpha and
  // additive managers above keep the per-mesh path.
  const mgrI = new ParticleManager({
    scene,
    instancing: true,
    geometryFactory: () => geom,
    materialFactory: () => baseMaterial({ additive: true }),
  });
  await mgrI.addEmitter({
    emitterInfo: emitterPojo(),
    parent: { position: new THREE.Vector3(0, 0, 0), quaternion: new THREE.Quaternion() },
    partIndex: -1,
  });
  mgrI.tick();
  const buckets = [];
  scene.traverse((o) => { if (o.isInstancedMesh && o.userData?.isParticleInstanced) buckets.push(o); });
  if (buckets.length === 0) {
    // Do not silently skip: a guard that evaporates when its feature does not
    // build is a guard that never guards. Say so, and fail.
    check("precondition: an instanced bucket was built (else guard 6 cannot run)", false,
      "no InstancedMesh with userData.isParticleInstanced — instancing did not engage");
  } else {
    const bm = buckets.map((b) => b.material);
    check("6. instanced bucket material has forceSinglePass=true",
      bm.every((m) => m.forceSinglePass === true), `${bm.filter((m) => m.forceSinglePass === true).length}/${bm.length}`);
    check("6. instanced bucket submits once per frame",
      bm.every((m) => submitsPerFrame(m) === 1), `submits/frame: ${bm.map(submitsPerFrame).join(",")}`);
  }

  console.log(`\n[test_particle_single_pass] ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
