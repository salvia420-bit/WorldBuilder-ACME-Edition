// Waterfall particle regression suite (2026-10-19) — the RP6 cull and draw
// state of the retail waterfall emitters, driven through the REAL
// ParticleEmitterInfo / Particle / ParticleManager (no replica).
//
//   A  particleTravelBound pins: the six retail waterfall emitters + one of each
//      special arm, and `sortingSphere` stays retail-exact (ACE InitEnd).
//   B  the bound holds for EVERY ParticleType against the real Particle.init /
//      update (random parameters, random anchor orientations, seeded RNG).
//   C  ?rp6TravelReach: every live sprite of every waterfall emitter lies inside
//      `rp6CullSphere`; with the flag off the tall falls (0x320004A2) do not.
//   D  a camera that sees only the lower falls / pool: culled (hidden + frozen)
//      with the flag off, live with it on.
//   E  ?rp6DegradeCap: a 392 m-degrade waterfall at 300 m is live (culled with
//      the flag off, past 220 m + reach); at 400 m it is culled either way; a
//      100 m-degrade emitter keeps its own distance.
//   F  particleFxSlotVelocity's teleport speed follows the emitter's own top
//      speed (`info.maxSpeed`), so the spray streaks (0x320004A3) keep their
//      stretch past 60 m/s; an emitter without one keeps the 60 m/s floor.
//   G  ?particleAlphaRetail (default ON): both states of the alpha bucket and
//      per-mesh slot material, and the alpha-before-additive bucket order.
//   H  the three URL readers (default / escape spellings).
//
// Run from apps/holtburger-web/:  node test_particle_waterfall_reach.mjs

import * as THREE from "three";

let passed = 0, failed = 0;
function check(name, ok, detail) {
  console.log(`  [${ok ? "OK" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
  if (ok) passed++; else failed++;
}
const near = (a, b, eps = 1e-3) => Math.abs(a - b) <= eps * Math.max(1, Math.abs(b));

// ---- retail ParticleEmitter records (client_portal.dat, tools/particle-fx/datcat.py) ----
function quad(x0, x1, z0, z1) {
  const g = new THREE.BufferGeometry();
  const v = new Float32Array([x0, 0, z1, x0, 0, z0, x1, 0, z0, x0, 0, z1, x1, 0, z0, x1, 0, z1]);
  g.setAttribute("position", new THREE.BufferAttribute(v, 3));
  g.setAttribute("uv", new THREE.BufferAttribute(new Float32Array([0, 0, 0, 1, 1, 1, 0, 0, 1, 1, 1, 0]), 2));
  g.computeVertexNormals();
  return g;
}
const SHEET = quad(-0.7, 0.75, -0.7, 0.7); // hw 0x0100109E (water sheet, alpha)
const STREAK = quad(-1, 1.05, 0, 2);       // hw 0x0100141C (spray / mist, additive; origin at the bottom edge)

const WATERFALL = {
  0x32000031: { emitterType: 1, particleType: 3, hw: 0x0100109E, birthrate: 0.2, maxParticles: 14, initialParticles: 2, lifespan: 2.2, lifespanRand: 0, off: [0, 0, 1], minOffset: 0, maxOffset: 4, A: [0, 17, 0.5], minA: 0.5, maxA: 0.5, B: [0, 0, -30], minB: 0.5, maxB: 0.5, C: [0, 0, 0], minC: 0.5, maxC: 1.5, startScale: 9, finalScale: 9, scaleRand: 1, startTrans: 0, finalTrans: 0 },
  0x320004A2: { emitterType: 1, particleType: 3, hw: 0x0100109E, birthrate: 0.18867924528301888, maxParticles: 25, initialParticles: 2, lifespan: 3.0, lifespanRand: 0, off: [0, 0, 1], minOffset: 0, maxOffset: 4, A: [0, 22.5, 0.5], minA: 0.5, maxA: 0.5, B: [0, 0, -40], minB: 0.5, maxB: 0.5, C: [0, 0, 0], minC: 0.5, maxC: 1.5, startScale: 6, finalScale: 9, scaleRand: 1, startTrans: 0, finalTrans: 0 },
  0x320004A3: { emitterType: 1, particleType: 3, hw: 0x0100141C, birthrate: 0.0970873786407767, maxParticles: 10, initialParticles: 3, lifespan: 3.0, lifespanRand: 0, off: [0, 0, 1], minOffset: 0, maxOffset: 11, A: [0, 21, 0.5], minA: 0.5, maxA: 0.5, B: [0, 0, -40], minB: 0.3, maxB: 0.7, C: [0, 0, 0], minC: 0.5, maxC: 1.5, startScale: 0.1, finalScale: 3.2, scaleRand: 2, startTrans: 1, finalTrans: 0.4 },
  0x320004A4: { emitterType: 1, particleType: 3, hw: 0x0100109E, birthrate: 0.18867924528301888, maxParticles: 20, initialParticles: 2, lifespan: 1.8, lifespanRand: 0, off: [0, 0, 1], minOffset: 0, maxOffset: 4, A: [0, 22.5, 0.5], minA: 0.5, maxA: 0.5, B: [0, 0, -32], minB: 0.5, maxB: 0.5, C: [0, 0, 0], minC: 0.5, maxC: 1.5, startScale: 6, finalScale: 9, scaleRand: 1, startTrans: 0, finalTrans: 0 },
  0x3200063B: { emitterType: 1, particleType: 3, hw: 0x0100109E, birthrate: 0.2, maxParticles: 14, initialParticles: 2, lifespan: 2.2, lifespanRand: 0, off: [0, 0, 1], minOffset: 0, maxOffset: 2, A: [0, 17, 0.5], minA: 0.5, maxA: 0.5, B: [0, 0, -30], minB: 0.5, maxB: 0.5, C: [0, 0, 0], minC: 0.5, maxC: 1.5, startScale: 4, finalScale: 9, scaleRand: 1, startTrans: 0, finalTrans: 0 },
  0x3200000C: { emitterType: 1, particleType: 2, hw: 0x0100141C, birthrate: 0.16666666666666666, maxParticles: 24, initialParticles: 0, lifespan: 2.75, lifespanRand: 0.25, off: [0, -1, 0], minOffset: 2, maxOffset: 4, A: [0, 0, -0.3], minA: 0.5, maxA: 1.5, B: [0, 0, -0.3], minB: 0.5, maxB: 1.5, C: [0, 0, 0], minC: 0.5, maxC: 1.5, startScale: 3, finalScale: 10, scaleRand: 0.5, startTrans: 0, finalTrans: 1 },
};
function pojo(id, e) {
  return {
    id, emitterType: e.emitterType, particleType: e.particleType, gfxObjId: 0, hwGfxObjId: e.hw,
    birthrate: e.birthrate, maxParticles: e.maxParticles, initialParticles: e.initialParticles, totalParticles: 0, totalSeconds: 0,
    lifespan: e.lifespan, lifespanRand: e.lifespanRand, offsetDirX: e.off[0], offsetDirY: e.off[1], offsetDirZ: e.off[2],
    minOffset: e.minOffset, maxOffset: e.maxOffset, aX: e.A[0], aY: e.A[1], aZ: e.A[2], minA: e.minA, maxA: e.maxA,
    bX: e.B[0], bY: e.B[1], bZ: e.B[2], minB: e.minB, maxB: e.maxB, cX: e.C[0], cY: e.C[1], cZ: e.C[2], minC: e.minC, maxC: e.maxC,
    scaleRand: e.scaleRand, startScale: e.startScale, finalScale: e.finalScale, transRand: 0,
    startTrans: e.startTrans, finalTrans: e.finalTrans, isParentLocal: false,
  };
}
const geoFor = (e) => (e.hw === 0x0100141C ? STREAK : SHEET);
const additiveFor = (e) => e.hw === 0x0100141C;

// Seeded RNG for the particle system (time_rng `setRng`).
let _seed = 0x2468ace1;
const lcg = () => ((_seed = (Math.imul(_seed, 1664525) + 1013904223) >>> 0) / 4294967296);

async function run() {
  globalThis.window = globalThis.window || {};
  window.location = { search: "" };
  globalThis.location = { search: "" };
  window.requestAnimationFrame = () => 0;
  window.cancelAnimationFrame = () => {};

  const tr = await import("./scene3d/particles/time_rng.js");
  let t = 1000;
  tr.setCurrentTime(() => t);
  tr.setRng(lcg);

  const info = await import("./scene3d/particles/particle_emitter_info.js");
  const { ParticleEmitterInfo, particleTravelBound } = info;
  const { Particle, ParticleType } = await import("./scene3d/particles/particle.js");
  const PM = await import("./scene3d/particles/particle_manager.js");
  const FX = await import("./scene3d/particles/particle_fx.js");

  // ---------------------------------------------------------------- A
  console.log("A — particleTravelBound pins");
  {
    const want = {
      // off + |A|·mA·T + ½·|B|·mB·T²   (T = lifespan + |lifespanRand|)
      0x32000031: { reach: 4 + Math.hypot(17, 0.5) * 0.5 * 2.2 + 0.5 * 15 * 2.2 * 2.2, sort: 4, speed: Math.hypot(17, 0.5) * 0.5 + 15 * 2.2 },
      0x320004A2: { reach: 4 + Math.hypot(22.5, 0.5) * 0.5 * 3 + 0.5 * 20 * 9, sort: 4, speed: Math.hypot(22.5, 0.5) * 0.5 + 20 * 3 },
      0x320004A3: { reach: 11 + Math.hypot(21, 0.5) * 0.5 * 3 + 0.5 * 28 * 9, sort: 11, speed: Math.hypot(21, 0.5) * 0.5 + 28 * 3 },
      0x320004A4: { reach: 4 + Math.hypot(22.5, 0.5) * 0.5 * 1.8 + 0.5 * 16 * 1.8 * 1.8, sort: 4, speed: Math.hypot(22.5, 0.5) * 0.5 + 16 * 1.8 },
      0x3200063B: { reach: 2 + Math.hypot(17, 0.5) * 0.5 * 2.2 + 0.5 * 15 * 2.2 * 2.2, sort: 2, speed: Math.hypot(17, 0.5) * 0.5 + 15 * 2.2 },
      // LocalVelocity: off + |A|·mA·T, T = 2.75 + 0.25
      0x3200000C: { reach: 4 + 0.3 * 1.5 * 3.0, sort: 4.125, speed: 0.3 * 1.5 },
    };
    for (const [id, e] of Object.entries(WATERFALL)) {
      const inf = new ParticleEmitterInfo(pojo(+id, e));
      const w = want[id];
      check(`0x${(+id).toString(16).toUpperCase()}: cullReach ${inf.cullReach.toFixed(2)} m, maxSpeed ${inf.maxSpeed.toFixed(1)} m/s; sortingSphere stays ${w.sort}`,
        near(inf.cullReach, w.reach) && near(inf.maxSpeed, w.speed) && near(inf.sortingSphere.radius, w.sort, 1e-6),
        `reach ${inf.cullReach} vs ${w.reach}, speed ${inf.maxSpeed} vs ${w.speed}, sort ${inf.sortingSphere.radius}`);
    }
    const base = { lifespan: 2, lifespanRand: 0.5, minOffset: 0, maxOffset: 1, minA: 1, maxA: 2, minB: 1, maxB: 1, minC: 1, maxC: 1,
      a: new THREE.Vector3(3, 0, 4), b: new THREE.Vector3(0, 0, -2), c: new THREE.Vector3(0.5, 0.25, 1) };
    const T = 2.5;
    const tb = (pt) => particleTravelBound({ ...base, particleType: pt });
    check("Still: the spawn offset only", near(tb(ParticleType.Still).reach, 1) && tb(ParticleType.Still).maxSpeed === 0);
    check("GlobalVelocity: off + |A|·T", near(tb(ParticleType.GlobalVelocity).reach, 1 + 10 * T));
    check("Swarm: off + |A|·T + |C| (the cos/sin amplitude)", near(tb(ParticleType.Swarm).reach, 1 + 10 * T + Math.hypot(0.5, 0.25, 1)));
    check("Explode: off + |B|·T² + (|A.x|+|A.z|)·T (C a unit direction)", near(tb(ParticleType.Explode).reach, 1 + 2 * T * T + (3 + 4) * 2 * T));
    check("Implode: 2·off·max|C_i| + |B|·T², offsetGain 2·max|C_i|",
      near(tb(ParticleType.Implode).reach, 2 * 1 * 1 + 2 * T * T) && near(tb(ParticleType.Implode).offsetGain, 2));
    check("Unknown type: offset only, no throw", near(tb(0).reach, 1));
    check("null / garbage input is safe", particleTravelBound(null).reach === 0
      && Number.isFinite(particleTravelBound({ particleType: 3, lifespan: NaN }).reach));
    const re = new ParticleEmitterInfo(pojo(0x320004A2, WATERFALL[0x320004A2]));
    re.lifespan = 1; re.initEnd();
    check("initEnd recomputes cullReach with the sorting sphere", near(re.cullReach, 4 + Math.hypot(22.5, 0.5) * 0.5 + 10) && re.sortingSphere.radius === 4);
  }

  // ---------------------------------------------------------------- B
  console.log("B — the bound holds for every ParticleType against the real Particle math");
  {
    const anchor = { position: new THREE.Vector3(5, -7, 30), quaternion: new THREE.Quaternion() };
    const poff = { position: new THREE.Vector3(0.4, -0.3, 0.6), quaternion: new THREE.Quaternion() };
    const mesh = { position: new THREE.Vector3(), quaternion: new THREE.Quaternion(), scale: new THREE.Vector3(1, 1, 1),
      userData: {}, material: { opacity: 1, userData: {} }, visible: true };
    const r = (lo, hi) => lo + (hi - lo) * lcg();
    let samples = 0, worst = -Infinity, worstType = 0;
    for (let pt = 1; pt <= 12; pt++) {
      for (let k = 0; k < 40; k++) {
        const inf = new ParticleEmitterInfo({
          id: 0, emitterType: 1, particleType: pt, hwGfxObjId: 1, birthrate: 0.1, maxParticles: 4, initialParticles: 0,
          totalParticles: 0, totalSeconds: 0, lifespan: r(0.2, 6), lifespanRand: r(-1, 1),
          offsetDirX: r(-1, 1), offsetDirY: r(-1, 1), offsetDirZ: r(-1, 1), minOffset: r(-2, 3), maxOffset: r(-2, 5),
          aX: r(-20, 20), aY: r(-20, 20), aZ: r(-20, 20), minA: r(-2, 2), maxA: r(-2, 2),
          bX: r(-30, 30), bY: r(-30, 30), bZ: r(-30, 30), minB: r(-2, 2), maxB: r(-2, 2),
          cX: r(-5, 5), cY: r(-5, 5), cZ: r(-5, 5), minC: r(-2, 2), maxC: r(-2, 2),
          scaleRand: 0, startScale: 1, finalScale: 1, transRand: 0, startTrans: 0, finalTrans: 0, isParentLocal: false,
        });
        const bound = inf.cullReach + poff.position.length() * Math.max(1, inf.cullOffsetGain);
        anchor.quaternion.setFromEuler(new THREE.Euler(r(0, 6.3), r(0, 6.3), r(0, 6.3)));
        const p = new Particle();
        t = 1000;
        p.init(inf, anchor, -1, poff, mesh, inf.getRandomOffset(), true, inf.getRandomA(), inf.getRandomB(), inf.getRandomC(),
          1, 1, 0, 0, anchor);
        for (let s = 1; s <= 30; s++) {
          t = 1000 + (p.lifespan * s) / 30;
          p.lastUpdateTime = 1000; p.lifetime = 0;
          p.update(pt, true, mesh, p.startFrame);
          const over = mesh.position.distanceTo(anchor.position) - bound;
          if (over > worst) { worst = over; worstType = pt; }
          samples++;
        }
      }
    }
    check(`${samples} particle samples over types 1-12 stay within cullReach + |parentOffset|·gain`,
      worst <= 1e-6, `worst overshoot ${worst.toExponential(2)} m (type ${worstType})`);
    t = 1000;
  }

  // shared scene for C-G: AC Z-up group under a −π/2-X world root, like statics.js
  const worldRoot = new THREE.Group(); worldRoot.rotation.x = -Math.PI / 2;
  const scene = new THREE.Group(); worldRoot.add(scene); worldRoot.updateMatrixWorld(true);
  const cam = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 5000);
  window.liveScene3d = { cameraSwitcher: { activeCamera: cam }, camera: cam };
  const toWorld = (v) => v.clone().applyMatrix4(scene.matrixWorld);
  const aimAt = (eyeAc, targetAc) => {
    cam.position.copy(toWorld(eyeAc)); cam.up.set(0, 1, 0); cam.lookAt(toWorld(targetAc)); cam.updateMatrixWorld(true);
  };
  const frustumOf = () => new THREE.Frustum().setFromProjectionMatrix(
    new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
  const tick = (mgr, n = 12) => { for (let i = 0; i < n; i++) { t += 1 / 60; mgr.tick(); } };
  // Slots grow lazily and asynchronously (particle_emitter.js `_growSlots`): give
  // the growth its turn between frames, as rAF does, so a long fill reaches the
  // emitter's real live count instead of stalling at the first 8 slots.
  const fill = async (mgr, n) => {
    for (let i = 0; i < n; i++) {
      t += 1 / 60; mgr.tick();
      if (i % 10 === 9) await new Promise((r) => setTimeout(r, 0));
    }
  };
  const matFor = (e) => () => new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, transparent: true,
    blending: additiveFor(e) ? THREE.AdditiveBlending : THREE.NormalBlending });
  // A static script anchor at a cliff lip, yaw −90° (throws along AC +X), like
  // Cragstone Falls' spouts (LB 0xB6A3, x = 5, yaw ≈ −90°).
  const makeAnchor = (z = 50) => {
    const a = new THREE.Group();
    a.position.set(1000, 1000, z);
    a.quaternion.set(0, 0, -Math.SQRT1_2, Math.SQRT1_2);
    scene.add(a); a.updateMatrixWorld(true);
    return a;
  };
  async function waterfall(id, { z = 50, parentOffset = null } = {}) {
    const e = WATERFALL[id];
    const mgr = new PM.ParticleManager({ scene, instancing: true, geometryFactory: () => geoFor(e), materialFactory: matFor(e) });
    const anchor = makeAnchor(z);
    await mgr.addEmitter({ emitterInfo: pojo(id, e), parent: anchor, partIndex: -1, parentOffset });
    const em = [...mgr.particleTable.values()][0];
    // fill: a wide camera 150 m above the lip sees the whole fall
    aimAt(anchor.position.clone().add(new THREE.Vector3(0, 0, 150)), anchor.position);
    await fill(mgr, 60 * Math.ceil(e.lifespan + 1));
    return { mgr, em, anchor, e };
  }
  const liveSprites = (em) => em.parts.filter(Boolean);
  const spriteReach = (em, m) => m.scale.x * (em._gfxOriginRadius ?? em._gfxRadius);

  // ---------------------------------------------------------------- C
  console.log("C — ?rp6TravelReach: every live sprite inside the cull sphere");
  {
    for (const id of Object.keys(WATERFALL)) {
      const { mgr, em } = await waterfall(+id, { parentOffset: +id === 0x3200000C
        ? { position: new THREE.Vector3(0, 0, 0.6), quaternion: new THREE.Quaternion() } : null });
      let worst = -Infinity, n = 0;
      for (let k = 0; k < 6; k++) {
        tick(mgr, 20);
        const c = new THREE.Vector3();
        const r = PM.rp6CullSphere(em, c);
        for (const m of liveSprites(em)) {
          const over = toWorld(m.position).distanceTo(c) + spriteReach(em, m) - r;
          if (over > worst) worst = over;
          n++;
        }
      }
      check(`0x${(+id).toString(16).toUpperCase()}: ${n} sprite samples inside rp6CullSphere`, n > 0 && worst <= 1e-3,
        `worst ${worst.toFixed(3)} m past the sphere`);
      for (const ek of [...mgr.particleTable.keys()]) mgr.destroyParticleEmitter(ek);
    }
    PM.setRp6TravelReachFlag(false);
    {
      const { mgr, em } = await waterfall(0x320004A2);
      tick(mgr, 30);
      const c = new THREE.Vector3();
      const r = PM.rp6CullSphere(em, c);
      const outside = liveSprites(em).filter((m) => toWorld(m.position).distanceTo(c) > r).length;
      check("flag off: the tall falls' sheets leave the retail-radius sphere (the old bug, pinned)",
        outside > 0, `${outside}/${liveSprites(em).length} sprites outside r = ${r.toFixed(1)} m`);
      for (const ek of [...mgr.particleTable.keys()]) mgr.destroyParticleEmitter(ek);
    }
    PM.setRp6TravelReachFlag(true);
  }

  // ---------------------------------------------------------------- D
  console.log("D — a camera on the lower falls / pool, the lip out of frame");
  {
    async function lowerView(flagOn) {
      PM.setRp6TravelReachFlag(flagOn);
      const { mgr, em, anchor } = await waterfall(0x320004A2, { z: 100 });
      // Standing 50 m in front of the fall plane, a little below the water it
      // looks at — the sheets more than 40 m below the lip — 45° lens.
      const low = liveSprites(em).filter((m) => m.position.z < anchor.position.z - 40);
      const target = new THREE.Vector3();
      for (const m of low) target.add(m.position);
      target.multiplyScalar(1 / Math.max(1, low.length));
      cam.fov = 45; cam.updateProjectionMatrix();
      aimAt(target.clone().add(new THREE.Vector3(0, -50, -10)), target);
      tick(mgr, 12);
      const fr = frustumOf();
      const anchorWorld = toWorld(anchor.position);
      const oldSphere = new THREE.Sphere(anchorWorld, em.info.sortingSphere.radius + (em._gfxRadius || 0) * 10);
      const water = liveSprites(em).filter((m) => fr.intersectsSphere(new THREE.Sphere(toWorld(m.position), m.scale.x))).length;
      const res = { culled: em._rp6Culled === true, anchorOut: !fr.intersectsSphere(oldSphere), water,
        visible: liveSprites(em).filter((m) => m.visible).length };
      cam.fov = 60; cam.updateProjectionMatrix();
      for (const ek of [...mgr.particleTable.keys()]) mgr.destroyParticleEmitter(ek);
      return res;
    }
    const off = await lowerView(false);
    check("precondition: the retail-radius sphere round the lip is out of frame, the water is in it",
      off.anchorOut && off.water >= 2, `anchorOut ${off.anchorOut}, water sprites in frame ${off.water}`);
    check("flag off: RP6 culls the whole fall although its water is on screen (the bug, pinned)", off.culled === true,
      `culled ${off.culled}`);
    const on = await lowerView(true);
    check("flag on: the fall stays live while its water is on screen", on.culled === false && on.water > 0,
      `culled ${on.culled}, water in frame ${on.water}`);
  }

  // ---------------------------------------------------------------- E
  console.log("E — ?rp6DegradeCap: distance");
  {
    PM._resetParticleDegradeForTest();
    PM.setParticleDegradeResolver(async (hw) => (hw === 0x0100109E ? 392 : 100));
    async function atDistance(id, dist, capOn) {
      PM.setRp6DegradeCapFlag(capOn);
      const { mgr, em, anchor } = await waterfall(id);
      await new Promise((r) => setTimeout(r, 0)); // the stamp resolves off a promise
      // camera `dist` metres away horizontally (−Y), looking at the lip
      aimAt(anchor.position.clone().add(new THREE.Vector3(0, -dist, 0)), anchor.position);
      tick(mgr, 12);
      const out = { culled: em._rp6Culled === true, degrade: em.degradeDistance, cap: PM.rp6DistanceCap(em) };
      for (const ek of [...mgr.particleTable.keys()]) mgr.destroyParticleEmitter(ek);
      return out;
    }
    const at300 = await atDistance(0x32000031, 300, true);
    check("the ?particleDegrade stamp carries the waterfall GfxObj's 392 m", at300.degrade === 392, `degradeDistance ${at300.degrade}`);
    check("flag on: the cap is the 392 m degrade distance", at300.cap === 392, `cap ${at300.cap}`);
    check("flag on: a waterfall 300 m away draws", at300.culled === false, `culled ${at300.culled}`);
    const at300off = await atDistance(0x32000031, 300, false);
    check("flag off: the flat 220 m cap (+ its reach) culls it at 300 m", at300off.culled === true && at300off.cap === 220,
      `culled ${at300off.culled}, cap ${at300off.cap}`);
    const at400 = await atDistance(0x32000031, 400, true);
    check("flag on: past its 392 m degrade distance it is culled", at400.culled === true, `culled ${at400.culled}`);
    const small = await atDistance(0x320004A3, 150, true); // streak quad → resolver 100 m
    check("a 100 m-degrade emitter keeps its own distance (cap 220, culled at 150 m)",
      small.cap === 220 && small.culled === true, `cap ${small.cap}, culled ${small.culled}`);
    window.location = { search: "?particleDegrade=off" };
    PM._resetParticleDegradeForTest();
    const noStamp = await atDistance(0x32000031, 300, true);
    check("?particleDegrade=off: no stamp, the flat cap", noStamp.cap === 220 && noStamp.culled === true,
      `cap ${noStamp.cap}, degrade ${noStamp.degrade}`);
    window.location = { search: "" };
    PM._resetParticleDegradeForTest();
    PM.setRp6DegradeCapFlag(null);
  }

  // ---------------------------------------------------------------- F
  console.log("F — the stretch teleport speed follows the emitter");
  {
    check("no info: the 60 m/s floor", FX.particleFxTeleportSpeedSq({}) === 3600 && FX.particleFxTeleportSpeedSq(null) === 3600);
    const spray = { parts: [1], info: new ParticleEmitterInfo(pojo(0x320004A3, WATERFALL[0x320004A3])) };
    const lim = Math.sqrt(FX.particleFxTeleportSpeedSq(spray));
    check("the spray streaks: 1.25 × their 94.5 m/s top speed", near(lim, 1.25 * spray.info.maxSpeed), `limit ${lim.toFixed(1)} m/s`);
    const plain = { parts: [1] };
    const e = new Float32Array(16);
    const out = [0, 0, 0];
    for (const em of [spray, plain]) {
      e[14] = 0; FX.particleFxSlotVelocity(em, 0, e, 0.25, 50, out);
      e[14] = -8; FX.particleFxSlotVelocity(em, 0, e, 0.25, 50.1, out); // 80 m/s down
    }
    // re-run each so `out` belongs to it
    e[14] = 0; FX.particleFxSlotVelocity(spray, 0, e, 0.5, 60, out);
    e[14] = -8; FX.particleFxSlotVelocity(spray, 0, e, 0.5, 60.1, out);
    check("an 80 m/s fall keeps its velocity on the spray emitter", near(out[2], -80), `vz ${out[2]}`);
    e[14] = 0; FX.particleFxSlotVelocity(plain, 0, e, 0.5, 70, out);
    e[14] = -8; FX.particleFxSlotVelocity(plain, 0, e, 0.5, 70.1, out);
    check("…and still reads as a teleport on an emitter without a top speed", out[2] === 0, `vz ${out[2]}`);
  }

  // ---------------------------------------------------------------- G
  console.log("G — ?particleAlphaRetail (default ON)");
  {
    const base = new THREE.MeshBasicMaterial({ transparent: true });
    PM.setParticleAlphaRetailFlag(null);
    check("default on", PM.particleAlphaRetailEnabled() === true);
    PM.setParticleAlphaRetailFlag(false);
    const def = PM._configureAlphaBucketMaterial(base.clone());
    check("off: alpha bucket keeps alphaTest 0.1 + depthWrite", def.alphaTest === 0.1 && def.depthWrite === true);
    PM.setParticleAlphaRetailFlag(true);
    const ret = PM._configureAlphaBucketMaterial(base.clone());
    check("on: alpha bucket alphaTest 1/255, no depth write", ret.alphaTest === PM.PARTICLE_ALPHA_RETAIL_TEST
      && ret.alphaTest > 0 && ret.alphaTest < 0.01 && ret.depthWrite === false);
    check("on: same program key (the alpha test variant is kept)", ret.customProgramCacheKey() === def.customProgramCacheKey());

    // Alpha buckets are SHARED across managers (`?particleSharedAlpha`) and keep
    // the state they were built with; the flag is read once per page load, so
    // start each arm from an empty registry.
    const resetShared = () => {
      for (const b of PM.sharedAlphaBuckets.buckets.values()) { try { b.im.parent?.remove(b.im); } catch (_) {} }
      PM.sharedAlphaBuckets.buckets.clear();
    };
    async function buckets(flag) {
      PM.setParticleAlphaRetailFlag(flag);
      resetShared();
      const host = new THREE.Group(); worldRoot.add(host); worldRoot.updateMatrixWorld(true);
      const mk = (e) => new PM.ParticleManager({ scene: host, instancing: true, geometryFactory: () => geoFor(e), materialFactory: matFor(e) });
      const mA = mk(WATERFALL[0x32000031]);
      const mS = mk(WATERFALL[0x320004A3]);
      const anchor = makeAnchor();
      await mA.addEmitter({ emitterInfo: pojo(0x32000031, WATERFALL[0x32000031]), parent: anchor, partIndex: -1 });
      await mS.addEmitter({ emitterInfo: pojo(0x320004A3, WATERFALL[0x320004A3]), parent: anchor, partIndex: -1 });
      aimAt(anchor.position.clone().add(new THREE.Vector3(0, 0, 150)), anchor.position);
      for (let i = 0; i < 30; i++) { t += 1 / 60; mA.tick(); mS.tick(); }
      const ims = [];
      host.traverse((o) => { if (o.isInstancedMesh && o.userData?.isParticleInstanced) ims.push(o); });
      for (const b of PM.sharedAlphaBuckets.buckets.values()) if (!ims.includes(b.im)) ims.push(b.im);
      const alpha = ims.filter((o) => o.userData.alpha === true);
      const add = ims.filter((o) => o.userData.alpha === false);
      const res = {
        alphaOrder: alpha.map((o) => o.renderOrder), addOrder: add.map((o) => o.renderOrder),
        alphaDepthWrite: alpha.map((o) => o.material.depthWrite), alphaTest: alpha.map((o) => o.material.alphaTest),
      };
      for (const m of [mA, mS]) for (const ek of [...m.particleTable.keys()]) m.destroyParticleEmitter(ek);
      worldRoot.remove(host);
      return res;
    }
    const bOff = await buckets(false);
    check("off: alpha + additive buckets at the default order 0, alpha bucket depthWrite",
      bOff.alphaOrder.length > 0 && bOff.addOrder.length > 0 && bOff.alphaOrder.every((o) => o === 0)
        && bOff.addOrder.every((o) => o === 0) && bOff.alphaDepthWrite.every(Boolean),
      JSON.stringify(bOff));
    const bOn = await buckets(true);
    check("on: alpha bucket drawn first (renderOrder −1), additive at 0, alpha bucket no depth write",
      bOn.alphaOrder.length > 0 && bOn.alphaOrder.every((o) => o === -1) && bOn.addOrder.every((o) => o === 0)
        && bOn.alphaDepthWrite.every((w) => w === false) && bOn.alphaTest.every((a) => a < 0.01),
      JSON.stringify(bOn));

    // per-mesh path (?particleInstancing=off analog: a manager without instancing)
    async function slot(flag) {
      PM.setParticleAlphaRetailFlag(flag);
      const host = new THREE.Group(); worldRoot.add(host); worldRoot.updateMatrixWorld(true);
      const mgr = new PM.ParticleManager({ scene: host, geometryFactory: () => SHEET, materialFactory: matFor(WATERFALL[0x32000031]) });
      const anchor = makeAnchor();
      await mgr.addEmitter({ emitterInfo: pojo(0x32000031, WATERFALL[0x32000031]), parent: anchor, partIndex: -1 });
      const em = [...mgr.particleTable.values()][0];
      const m = em.partStorage.find(Boolean);
      const res = { depthWrite: m.material.depthWrite, alphaTest: m.material.alphaTest, order: m.renderOrder };
      for (const ek of [...mgr.particleTable.keys()]) mgr.destroyParticleEmitter(ek);
      worldRoot.remove(host);
      return res;
    }
    const sOff = await slot(false);
    check("off: per-mesh alpha slot keeps alphaTest 0.1 + depthWrite, order 0",
      sOff.alphaTest === 0.1 && sOff.depthWrite === true && sOff.order === 0, JSON.stringify(sOff));
    const sOn = await slot(true);
    check("on: per-mesh alpha slot alphaTest 1/255, no depth write, order −1",
      sOn.alphaTest < 0.01 && sOn.depthWrite === false && sOn.order === -1, JSON.stringify(sOn));
    PM.setParticleAlphaRetailFlag(null);
  }

  // ---------------------------------------------------------------- H
  console.log("H — URL readers");
  {
    const readTravel = (s) => { globalThis.location = { search: s }; PM.setRp6TravelReachFlag(null); return PM.rp6TravelReachEnabled(); };
    const readCap = (s) => { globalThis.location = { search: s }; PM.setRp6DegradeCapFlag(null); return PM.rp6DegradeCapEnabled(); };
    check("rp6TravelReach: on by default, off/0/false/no escape",
      readTravel("") && readTravel("?rp6TravelReach=on") && !readTravel("?rp6TravelReach=off") && !readTravel("?rp6TravelReach=0")
        && !readTravel("?rp6TravelReach=false") && !readTravel("?rp6TravelReach=NO"));
    check("rp6DegradeCap: on by default, off/0/false/no escape",
      readCap("") && readCap("?rp6DegradeCap=1") && !readCap("?rp6DegradeCap=off") && !readCap("?rp6DegradeCap=0")
        && !readCap("?rp6DegradeCap=false") && !readCap("?rp6DegradeCap=no"));
    const R = PM.readParticleAlphaRetailFlag;
    check("particleAlphaRetail: on by default, off/0/false/no escape",
      R("") && R("?particleAlphaRetail=on") && R("?particleAlphaRetail=1") && !R("?particleAlphaRetail=off")
        && !R("?particleAlphaRetail=0") && !R("?particleAlphaRetail=FALSE") && !R("?particleAlphaRetail=no"));
    globalThis.location = { search: "" };
    PM.setRp6TravelReachFlag(null);
    PM.setRp6DegradeCapFlag(null);
  }

  console.log(`\n[test_particle_waterfall_reach] ${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
}

run().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
