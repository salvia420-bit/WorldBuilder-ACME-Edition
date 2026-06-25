// Regression test for the camera-facing billboard fix (HANDOFF-phase3-particle
// -render Bug 3, 2026-06-24). Drives the REAL ParticleManager + ParticleEmitter
// + ParticleEmitterInfo (no replica) with a FLAT planar quad GfxObj (the shape
// every particle sprite actually is — sparkleStar 0x010010F9 is a 0.29 m quad,
// DAT-confirmed) and asserts:
//   1. A billboard:true emitter faces its live quad AT the camera from EVERY
//      azimuth — including the azimuth that renders edge-on (≈0 px) without the
//      fix (the exact symptom: live + ticked + positioned but no pixels).
//   2. A billboard:false (retail-faithful default) emitter does NOT reorient.
//   3. ?particleBillboard=off disables the fix even for billboard:true emitters.
//   4. gemSparkle's synthesized POJO carries billboard:true + scales that clear
//      the [0.1,10] getRandom*Scale clamp floor.
//
// Run from apps/holtburger-web/:  node test_particle_billboard.mjs
// (`three` resolves as a bare import via node_modules.)

import * as THREE from "three";

let passed = 0, failed = 0;
function check(name, ok, detail) {
  console.log(`  [${ok ? "OK" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
  if (ok) passed++; else failed++;
}

// ---- Flat quad in the LOCAL X-Z plane (normal = local +Y), like a sprite ----
function makeFlatQuad(half = 0.147) {
  const g = new THREE.BufferGeometry();
  // two triangles, all y=0
  const v = new Float32Array([
    -half, 0, -half,   half, 0, -half,   half, 0, half,
    -half, 0, -half,   half, 0,  half,  -half, 0, half,
  ]);
  g.setAttribute("position", new THREE.BufferAttribute(v, 3));
  g.computeVertexNormals();
  return g;
}

// World normal of a quad after its current matrixWorld (derive from positions,
// exactly like the probe / billboard helper do — independent of normal attr).
function worldNormalOf(mesh) {
  mesh.updateMatrixWorld(true);
  const p = mesh.geometry.getAttribute("position");
  const a = new THREE.Vector3().fromBufferAttribute(p, 0);
  const b = new THREE.Vector3().fromBufferAttribute(p, 1);
  const c = new THREE.Vector3().fromBufferAttribute(p, 2);
  const nLocal = new THREE.Vector3().crossVectors(b.sub(a), c.sub(a)).normalize();
  const q = new THREE.Quaternion();
  mesh.getWorldQuaternion(q);
  return nLocal.applyQuaternion(q).normalize();
}

async function buildManager(ParticleManager, sceneGroup) {
  const geom = makeFlatQuad();
  return new ParticleManager({
    scene: sceneGroup,
    geometryFactory: () => geom,
    materialFactory: () => new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, transparent: true }),
  });
}

// gemSparkle-style persistent Still emitter POJO.
function emitterPojo(billboard) {
  return {
    id: 0, emitterType: 1, particleType: 0 /* Still */, gfxObjId: 0, hwGfxObjId: 0x010010F9,
    birthrate: 0.1, maxParticles: 2, initialParticles: 1, totalParticles: 0, totalSeconds: 0,
    lifespan: 100, lifespanRand: 0, offsetDirX: 0, offsetDirY: 0, offsetDirZ: 0,
    minOffset: 0, maxOffset: 0, aX: 0, aY: 0, aZ: 0, minA: 0, maxA: 0,
    bX: 0, bY: 0, bZ: 0, cX: 0, cY: 0, cZ: 0,
    scaleRand: 0, startScale: 0.45, finalScale: 0.45, transRand: 0,
    startTrans: 0, finalTrans: 0, isParentLocal: true, billboard,
  };
}

function liveParts(mgr) {
  const out = [];
  for (const [, e] of mgr.particleTable) {
    for (const m of e.parts) if (m && m.visible) out.push(m);
  }
  return out;
}

async function run() {
  // ---- minimal browser-ish globals the manager reads ----
  globalThis.window = globalThis.window || {};
  window.location = { search: "" };            // billboard ENABLED (default)

  const { setCurrentTime } = await import("./scene3d/particles/time_rng.js");
  let t = 1000; setCurrentTime(() => t);

  const { ParticleManager } = await import("./scene3d/particles/particle_manager.js");

  // worldRoot-like parent: rotated -π/2 about X (AC Z-up → THREE Y-up). Exercises
  // the parent-space mapping in _billboardEmitter.
  const worldRoot = new THREE.Group();
  worldRoot.rotation.x = -Math.PI / 2;
  worldRoot.updateMatrixWorld(true);

  // Mock active camera the manager resolves via window.liveScene3d.
  const cam = new THREE.PerspectiveCamera(60, 1.6, 0.1, 1000);
  window.liveScene3d = { cameraSwitcher: { activeCamera: cam }, camera: cam };

  // ---------- Test 1: billboard faces the camera from every azimuth ----------
  {
    const mgr = await buildManager(ParticleManager, worldRoot);
    // Anchor the emitter at world origin (parent frame in scene-local space).
    await mgr.addEmitter({
      emitterInfo: emitterPojo(true),
      parent: { position: new THREE.Vector3(0, 0, 0), quaternion: new THREE.Quaternion() },
      partIndex: -1,
    });
    t += 0.05; mgr.tick();
    worldRoot.updateMatrixWorld(true);
    const parts = liveParts(mgr);
    check("billboard: a live part exists after tick", parts.length >= 1, `count=${parts.length}`);

    // The part's world position (anchored ~origin). Place camera at several
    // azimuths around it; after each tick the quad normal must point at the cam.
    const azimuths = [0, 45, 90, 135, 180, 270]; // degrees in the THREE XZ plane
    let worstDot = 1;
    for (const deg of azimuths) {
      const r = 8, a = (deg * Math.PI) / 180;
      cam.position.set(Math.cos(a) * r, 1.5, Math.sin(a) * r);
      cam.lookAt(0, 0, 0);
      cam.updateMatrixWorld(true);
      t += 0.05; mgr.tick();
      worldRoot.updateMatrixWorld(true);
      for (const m of liveParts(mgr)) {
        const partWorld = new THREE.Vector3(); m.getWorldPosition(partWorld);
        const toCam = cam.position.clone().sub(partWorld).normalize();
        const n = worldNormalOf(m);
        const dot = Math.abs(n.dot(toCam)); // DoubleSide → sign-agnostic; 1=face-on
        if (dot < worstDot) worstDot = dot;
      }
    }
    check("billboard: quad faces camera from ALL azimuths (|n·toCam|≈1)",
      worstDot > 0.999, `worst |dot|=${worstDot.toFixed(4)}`);
  }

  // ---------- Test 2: non-billboard (retail default) does NOT reorient ----------
  {
    const mgr = await buildManager(ParticleManager, worldRoot);
    await mgr.addEmitter({
      emitterInfo: emitterPojo(false),
      parent: { position: new THREE.Vector3(0, 0, 0), quaternion: new THREE.Quaternion() },
      partIndex: -1,
    });
    t += 0.05; mgr.tick();
    const m = liveParts(mgr)[0];
    const qBefore = m.quaternion.clone();
    // Move camera somewhere new + tick again; quaternion must be unchanged.
    cam.position.set(20, 5, 0); cam.lookAt(0, 0, 0); cam.updateMatrixWorld(true);
    t += 0.05; mgr.tick();
    const drift = m.quaternion.angleTo(qBefore);
    check("non-billboard: orientation untouched (retail-faithful)", drift < 1e-6,
      `Δangle=${drift.toExponential(2)} rad`);
  }

  // ---------- Test 3: ?particleBillboard=off disables it ----------
  {
    // Re-import the module under the off flag (fresh module registry via query).
    window.location = { search: "?particleBillboard=off" };
    const mod = await import("./scene3d/particles/particle_manager.js?off=1");
    const mgr = await buildManager(mod.ParticleManager, worldRoot);
    await mgr.addEmitter({
      emitterInfo: emitterPojo(true),
      parent: { position: new THREE.Vector3(0, 0, 0), quaternion: new THREE.Quaternion() },
      partIndex: -1,
    });
    t += 0.05; mgr.tick();
    const m = liveParts(mgr)[0];
    const qBefore = m.quaternion.clone();
    cam.position.set(0, 5, 20); cam.lookAt(0, 0, 0); cam.updateMatrixWorld(true);
    t += 0.05; mgr.tick();
    const drift = m.quaternion.angleTo(qBefore);
    check("?particleBillboard=off: orientation untouched (A/B escape)", drift < 1e-6,
      `Δangle=${drift.toExponential(2)} rad`);
    window.location = { search: "" };
  }

  // ---------- Test 4: gemSparkle POJO carries the fix ----------
  {
    const { gemSparkleEmitterInfo } = await import("./scene3d/vfx/components/gemSparkle.js");
    const info = gemSparkleEmitterInfo({}, {});
    check("gemSparkle: billboard:true", info.billboard === true, `billboard=${info.billboard}`);
    check("gemSparkle: startScale clears 0.1 clamp floor", info.startScale > 0.1, `startScale=${info.startScale}`);
    check("gemSparkle: finalScale clears 0.1 clamp floor", info.finalScale > 0.1, `finalScale=${info.finalScale}`);
    check("gemSparkle: startScale > finalScale (shrink preserved)", info.startScale > info.finalScale,
      `${info.startScale} > ${info.finalScale}`);
  }

  console.log(`\n[test_particle_billboard] ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
