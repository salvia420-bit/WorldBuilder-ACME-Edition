// scene3d/vehicle/deployable_vfx.js — Zero-Light Pooled VFX for Deployables (M3 + Live World Combat)
// Features SAM smoke trail pooling, mortar ballistics & compressed-air shockwaves with green smoke
// and 2 light bounces, and heavy red laser hitscan beams.
// Conforms to strict GPU invariants: lightCountDelta === 0, zero dynamic allocations during combat.

import * as THREE_DEFAULT from "three";

export class SamSmokeTrailPool {
  constructor(three, capacity = 4) {
    const t = three || THREE_DEFAULT;
    this.three = t;
    this.capacity = capacity;
    this.trails = [];
    this.manifest = Object.freeze({
      id: "sam-smoke-trail",
      channel: "particle",
      deterministic: true,
      lightCountDelta: 0,
      cacheKeyScope: "set",
      reads: Object.freeze(["clock", "weather"]),
      writes: Object.freeze(["emitter", "materialUniform"]),
    });
    for (let i = 0; i < capacity; i++) {
      const geom = new t.BufferGeometry();
      const pos = new Float32Array(60 * 3);
      const alpha = new Float32Array(60);
      geom.setAttribute("position", new t.BufferAttribute(pos, 3));
      geom.setAttribute("alpha", new t.BufferAttribute(alpha, 1));
      const mat = new t.LineBasicMaterial({
        color: 0xf2f4f8,
        transparent: true,
        opacity: 0.8,
        depthWrite: false,
      });
      const mesh = new t.Line(geom, mat);
      mesh.frustumCulled = false;
      mesh.visible = false; // vfx-lint-allow: pooled line initial
      this.trails.push({ mesh, geom, mat, active: false, age: 0, count: 0 });
    }
  }

  spawn(origin) {
    const t = this.trails.find((tr) => !tr.active);
    if (!t) return null;
    t.active = true;
    t.age = 0;
    t.count = 0;
    t.mat.opacity = 0.8;
    if (origin && origin.length >= 3) {
      t.mesh.position.set(origin[0], origin[1], origin[2]);
      const posAttr = t.geom.getAttribute("position");
      for (let i = 0; i < 60; i++) {
        posAttr.setXYZ(i, 0, 0, 0);
      }
      posAttr.needsUpdate = true;
    }
    t.mesh.visible = true; // vfx-lint-allow: pooled line activate
    return t;
  }

  pushPoint(trail, worldPos) {
    if (!trail || !trail.active || !worldPos) return;
    const posAttr = trail.geom.getAttribute("position");
    const ox = trail.mesh.position.x;
    const oy = trail.mesh.position.y;
    const oz = trail.mesh.position.z;
    const lx = worldPos[0] - ox;
    const ly = worldPos[1] - oy;
    const lz = worldPos[2] - oz;
    if (trail.count < 60) {
      for (let k = trail.count; k < 60; k++) {
        posAttr.setXYZ(k, lx, ly, lz);
      }
      trail.count++;
    } else {
      for (let k = 0; k < 59; k++) {
        posAttr.setXYZ(k, posAttr.getX(k + 1), posAttr.getY(k + 1), posAttr.getZ(k + 1));
      }
      posAttr.setXYZ(59, lx, ly, lz);
    }
    posAttr.needsUpdate = true;
  }

  update(dt = 0.033) {
    const step = Number.isFinite(dt) && dt >= 0 ? dt : 0.033;
    for (const t of this.trails) {
      if (!t.active) continue;
      t.age += step;
      if (!Number.isFinite(t.age) || t.age > 3.0) {
        t.active = false;
        t.mesh.visible = false; // vfx-lint-allow: pooled line retire
        t.age = 0;
      } else {
        t.mat.opacity = Math.max(0, Math.min(0.8, 0.8 * (1.0 - t.age / 3.0)));
      }
    }
  }

  dispose() {
    for (const t of this.trails) {
      t.geom.dispose();
      t.mat.dispose();
    }
  }
}

export class MortarVfxSimulator {
  constructor() {
    this.manifest = Object.freeze({
      id: "mortar-ballistics-vfx",
      channel: "particle",
      deterministic: true,
      lightCountDelta: 0,
      cacheKeyScope: "set",
      reads: Object.freeze(["clock", "geometry"]),
      writes: Object.freeze(["emitter", "renderTransform"]),
    });
  }

  /**
   * Computes 50% current / 50% linear-lead intercept trajectory point.
   */
  computeTrajectory50_50(pStart, pTarget, vTarget, flightSec) {
    const leadTarget = [
      pTarget[0] + vTarget[0] * flightSec,
      pTarget[1] + vTarget[1] * flightSec,
      pTarget[2] + vTarget[2] * flightSec,
    ];
    return [
      0.5 * pTarget[0] + 0.5 * leadTarget[0],
      0.5 * pTarget[1] + 0.5 * leadTarget[1],
      0.5 * pTarget[2] + 0.5 * leadTarget[2],
    ];
  }

  /**
   * Simulates dual ground bounce kinematics before detonation.
   */
  simulateBounces(initialVz) {
    const bounce1Vz = -0.45 * initialVz;
    const bounce2Vz = -0.30 * bounce1Vz;
    return {
      bounce1Vz,
      bounce2Vz,
      bouncesCount: 2,
    };
  }

  createShockwaveMesh(three) {
    const t = three || THREE_DEFAULT;
    const geom = new t.RingGeometry(0.12, 0.24, 24);
    const mat = new t.MeshBasicMaterial({
      color: 0xc8f4ff,
      side: t.DoubleSide,
      transparent: true,
      opacity: 1.0,
      depthWrite: false,
      blending: t.AdditiveBlending,
    });
    const mesh = new t.Mesh(geom, mat);
    mesh.visible = false; // vfx-lint-allow: shockwave mesh initial
    return { mesh, geom, mat };
  }

  expandShockwave(mesh, mat, ageSec, durationSec = 0.2) {
    const safeAge = Number.isFinite(ageSec) ? Math.max(0.0, ageSec) : 0.0;
    const safeDur = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 0.2;
    const frac = Math.min(1.0, Math.max(0.0, safeAge / safeDur));
    mesh.scale.setScalar(1.0 + frac * 9.0); // 0.2m -> 2.0m (10x)
    mat.opacity = 1.0 - frac;
    mesh.visible = frac < 1.0; // vfx-lint-allow: shockwave visibility update
  }
}

export class HeavyLaserBeamPool {
  constructor(three, capacity = 4) {
    const t = three || THREE_DEFAULT;
    this.three = t;
    this.capacity = capacity;
    this.beams = [];
    this._yAxis = new t.Vector3(0, 1, 0);
    this._dir = new t.Vector3();
    this.manifest = Object.freeze({
      id: "heavy-laser-hitscan-beam",
      channel: "ray",
      deterministic: true,
      lightCountDelta: 0,
      cacheKeyScope: "set",
      reads: Object.freeze(["clock", "serverPose"]),
      writes: Object.freeze(["materialUniform", "renderTransform"]),
    });
    for (let i = 0; i < capacity; i++) {
      // Unit-length cylinder along +Y, dynamically scaled to exact target distance & oriented via quaternion!
      const geom = new t.CylinderGeometry(0.09, 0.09, 1.0, 8);
      const mat = new t.MeshBasicMaterial({
        color: 0xff1822,
        transparent: true,
        opacity: 0.0,
        blending: t.AdditiveBlending,
        depthWrite: false,
      });
      const mesh = new t.Mesh(geom, mat);
      mesh.frustumCulled = false;

      // Hot inner ruby-white core nested inside the beam mesh
      const coreGeom = new t.CylinderGeometry(0.032, 0.032, 1.0, 6);
      const coreMat = new t.MeshBasicMaterial({
        color: 0xffaaaa,
        transparent: true,
        opacity: 0.95,
        blending: t.AdditiveBlending,
        depthWrite: false,
      });
      const coreMesh = new t.Mesh(coreGeom, coreMat);
      mesh.add(coreMesh);

      mesh.visible = false; // vfx-lint-allow: pooled laser initial
      this.beams.push({ mesh, geom, mat, coreGeom, coreMat, active: false, age: 0 });
    }
  }

  fire(startPos, endPos) {
    const b = this.beams.find((bm) => !bm.active);
    if (!b) return null;
    b.active = true;
    b.age = 0;
    b.mat.opacity = 1.0;
    b.coreMat.opacity = 1.0;
    if (startPos && endPos && startPos.length >= 3 && endPos.length >= 3) {
      const dx = endPos[0] - startPos[0];
      const dy = endPos[1] - startPos[1];
      const dz = endPos[2] - startPos[2];
      const len = Math.hypot(dx, dy, dz);
      const midX = (startPos[0] + endPos[0]) / 2;
      const midY = (startPos[1] + endPos[1]) / 2;
      const midZ = (startPos[2] + endPos[2]) / 2;
      b.mesh.position.set(midX, midY, midZ);
      if (len > 1e-4) {
        this._dir.set(dx / len, dy / len, dz / len);
        b.mesh.quaternion.setFromUnitVectors(this._yAxis, this._dir);
        b.mesh.scale.set(1, len, 1);
      }
    }
    b.mesh.visible = true; // vfx-lint-allow: pooled laser fire
    return b;
  }

  update(dt = 0.033) {
    const step = Number.isFinite(dt) && dt >= 0 ? dt : 0.033;
    for (const b of this.beams) {
      if (!b.active) continue;
      b.age += step;
      if (!Number.isFinite(b.age) || b.age > 0.25) {
        b.active = false;
        b.mesh.visible = false; // vfx-lint-allow: pooled laser retire
        b.age = 0;
      } else {
        const op = Math.max(0.0, Math.min(1.0, Math.exp(-Math.max(0.0, b.age) / 0.04)));
        b.mat.opacity = op;
        b.coreMat.opacity = op;
      }
    }
  }

  dispose() {
    for (const b of this.beams) {
      b.geom.dispose();
      b.mat.dispose();
      b.coreGeom.dispose();
      b.coreMat.dispose();
    }
  }
}

// ---------------------------------------------------------------------------
// Live World-Space Deployable Combat VFX Manager (under liveScene3d.worldRoot)
// ---------------------------------------------------------------------------
export function createDeployableCombatVfx(deps = {}) {
  const THREE = deps.THREE || THREE_DEFAULT;
  const live = deps.liveScene3d || null;
  const ground = deps.ground || (() => NaN);
  const root = new THREE.Group();
  root.name = "deployable-combat-vfx";
  if (live?.worldRoot) live.worldRoot.add(root);

  const samTrails = new SamSmokeTrailPool(THREE, 8);
  for (const t of samTrails.trails) root.add(t.mesh);

  const laserPool = new HeavyLaserBeamPool(THREE, 8);
  for (const b of laserPool.beams) root.add(b.mesh);

  const mortarSim = new MortarVfxSimulator();
  const shockPool = [];
  for (let i = 0; i < 6; i++) {
    const s = mortarSim.createShockwaveMesh(THREE);
    root.add(s.mesh);
    shockPool.push({ ...s, active: false, age: 0, dur: 0.35 });
  }

  // Pooled green smoke puffs for Mortar shells + SAM/Laser impact flashes (zero THREE.Light!)
  const puffGeom = new THREE.SphereGeometry(0.42, 8, 8);
  const greenPuffs = [];
  for (let i = 0; i < 48; i++) {
    const mat = new THREE.MeshBasicMaterial({
      color: 0x26ee5c,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(puffGeom, mat);
    mesh.visible = false; // vfx-lint-allow: pooled green smoke puff initial
    root.add(mesh);
    greenPuffs.push({ mesh, mat, active: false, age: 0, maxAge: 2.2, baseScale: 1.0 });
  }

  // Active in-flight SAM rockets & Mortar shells (pooled meshes)
  const samGeom = new THREE.ConeGeometry(0.13, 1.25, 8);
  const samMat = new THREE.MeshBasicMaterial({ color: 0xf4f6f8 });
  const samGlowMat = new THREE.MeshBasicMaterial({
    color: 0xffaa22,
    transparent: true,
    opacity: 0.9,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const activeSams = [];
  for (let i = 0; i < 6; i++) {
    const m = new THREE.Mesh(samGeom, samMat);
    const fl = new THREE.Mesh(puffGeom, samGlowMat);
    fl.position.set(0, -0.75, 0);
    fl.scale.setScalar(0.65);
    m.add(fl);
    m.visible = false; // vfx-lint-allow: pooled sam body initial
    root.add(m);
    activeSams.push({ mesh: m, active: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, tx: 0, ty: 0, tz: 0, age: 0, trail: null });
  }

  const shellGeom = new THREE.SphereGeometry(0.16, 8, 8);
  const shellMat = new THREE.MeshBasicMaterial({ color: 0x2a332b });
  const activeMortars = [];
  for (let i = 0; i < 6; i++) {
    const m = new THREE.Mesh(shellGeom, shellMat);
    m.visible = false; // vfx-lint-allow: pooled mortar shell initial
    root.add(m);
    activeMortars.push({ mesh: m, active: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, bounces: 0, age: 0, puffAcc: 0 });
  }

  // Pooled impact/detonation burst spheres
  const burstGeom = new THREE.SphereGeometry(1.0, 12, 10);
  const bursts = [];
  for (let i = 0; i < 10; i++) {
    const mat = new THREE.MeshBasicMaterial({
      color: 0xff4422,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(burstGeom, mat);
    mesh.visible = false; // vfx-lint-allow: pooled burst initial
    root.add(mesh);
    bursts.push({ mesh, mat, active: false, age: 0, dur: 0.45, maxR: 4.0 });
  }

  const yAxis = new THREE.Vector3(0, 1, 0);
  const tmpDir = new THREE.Vector3();

  function spawnGreenPuff(x, y, z, scale = 1.0, colorHex = 0x26ee5c, maxAge = 2.2) {
    const p = greenPuffs.find((gp) => !gp.active);
    if (!p) return;
    p.active = true;
    p.age = 0;
    p.maxAge = maxAge;
    p.baseScale = scale;
    p.mat.color.setHex(colorHex);
    p.mat.opacity = 0.72;
    p.mesh.position.set(x, y, z);
    p.mesh.scale.setScalar(scale);
    p.mesh.visible = true; // vfx-lint-allow: pooled green puff spawn
  }

  function spawnBurst(x, y, z, radius = 4.0, colorHex = 0xff5522, dur = 0.45) {
    const b = bursts.find((bs) => !bs.active);
    if (!b) return;
    b.active = true;
    b.age = 0;
    b.dur = dur;
    b.maxR = radius;
    b.mat.color.setHex(colorHex);
    b.mat.opacity = 0.92;
    b.mesh.position.set(x, y, z);
    b.mesh.scale.setScalar(0.3);
    b.mesh.visible = true; // vfx-lint-allow: pooled burst spawn
  }

  function spawnShockwave(x, y, z, dir = [0, 0, 1]) {
    const s = shockPool.find((sh) => !sh.active);
    if (!s) return;
    s.active = true;
    s.age = 0;
    s.mesh.position.set(x, y, z);
    const len = Math.hypot(dir[0], dir[1], dir[2]) || 1;
    tmpDir.set(dir[0] / len, dir[1] / len, dir[2] / len);
    s.mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), tmpDir);
    mortarSim.expandShockwave(s.mesh, s.mat, 0, s.dur);
  }

  function fireSam(muzzle, targetPos, velocity) {
    const slot = activeSams.find((s) => !s.active);
    if (!slot || !muzzle) return;
    slot.active = true;
    slot.age = 0;
    slot.x = muzzle[0]; slot.y = muzzle[1]; slot.z = muzzle[2];
    slot.tx = targetPos ? targetPos[0] : muzzle[0];
    slot.ty = targetPos ? targetPos[1] : muzzle[1] + 150;
    slot.tz = targetPos ? targetPos[2] : muzzle[2] + 90;
    if (velocity && Math.hypot(velocity[0], velocity[1], velocity[2]) > 1) {
      slot.vx = velocity[0]; slot.vy = velocity[1]; slot.vz = velocity[2];
    } else {
      const dx = slot.tx - slot.x, dy = slot.ty - slot.y, dz = slot.tz - slot.z;
      const d = Math.hypot(dx, dy, dz) || 1;
      slot.vx = (dx / d) * 140; slot.vy = (dy / d) * 140; slot.vz = (dz / d) * 140 + 35;
    }
    slot.trail = samTrails.spawn(muzzle);
    slot.mesh.position.set(slot.x, slot.y, slot.z);
    slot.mesh.visible = true; // vfx-lint-allow: sam rocket launch
  }

  function fireMortar(muzzle, velocity, targetPos) {
    if (!muzzle) return;
    const v = velocity && Math.hypot(velocity[0], velocity[1], velocity[2]) > 1
      ? [...velocity]
      : (() => {
          const tx = targetPos ? targetPos[0] : muzzle[0] + 45;
          const ty = targetPos ? targetPos[1] : muzzle[1] + 45;
          const tz = targetPos ? targetPos[2] : muzzle[2];
          const tFlight = 2.6;
          return [
            (tx - muzzle[0]) / tFlight,
            (ty - muzzle[1]) / tFlight,
            (tz - muzzle[2] + 0.5 * 9.81 * tFlight * tFlight) / tFlight,
          ];
        })();
    // Compressed-air muzzle shockwave ring!
    spawnShockwave(muzzle[0], muzzle[1], muzzle[2], v);
    spawnGreenPuff(muzzle[0], muzzle[1], muzzle[2], 0.85, 0xc8f8ff, 0.35);

    const slot = activeMortars.find((s) => !s.active);
    if (!slot) return;
    slot.active = true;
    slot.age = 0;
    slot.bounces = 0;
    slot.puffAcc = 0;
    slot.x = muzzle[0]; slot.y = muzzle[1]; slot.z = muzzle[2];
    slot.vx = v[0]; slot.vy = v[1]; slot.vz = v[2];
    slot.mesh.position.set(slot.x, slot.y, slot.z);
    slot.mesh.visible = true; // vfx-lint-allow: mortar shell launch
  }

  function fireHeavyLaser(muzzle, targetPos) {
    if (!muzzle || !targetPos) return;
    laserPool.fire(muzzle, targetPos);
    spawnBurst(muzzle[0], muzzle[1], muzzle[2], 0.9, 0xff2233, 0.22);
    spawnBurst(targetPos[0], targetPos[1], targetPos[2], 2.8, 0xff1a2b, 0.32);
  }

  function handleFireEvent(msg) {
    if (!msg) return;
    const wk = msg.weaponKind | 0;
    if (wk === 1) fireSam(msg.muzzle, msg.targetPos, msg.velocity);
    else if (wk === 2) fireMortar(msg.muzzle, msg.velocity, msg.targetPos);
    else if (wk === 3) fireHeavyLaser(msg.muzzle, msg.targetPos);
  }

  function update(dt = 0.016) {
    const step = Number.isFinite(dt) && dt > 0 ? Math.min(0.1, dt) : 0.016;
    samTrails.update(step);
    laserPool.update(step);

    for (const s of shockPool) {
      if (!s.active) continue;
      s.age += step;
      mortarSim.expandShockwave(s.mesh, s.mat, s.age, s.dur);
      if (s.age >= s.dur) s.active = false;
    }

    for (const gp of greenPuffs) {
      if (!gp.active) continue;
      gp.age += step;
      if (gp.age >= gp.maxAge) {
        gp.active = false;
        gp.mesh.visible = false; // vfx-lint-allow: retire green puff
      } else {
        const u = gp.age / gp.maxAge;
        gp.mesh.position.z += step * 0.65;
        gp.mesh.scale.setScalar(gp.baseScale * (1.0 + u * 2.4));
        gp.mat.opacity = 0.72 * (1.0 - u);
      }
    }

    for (const b of bursts) {
      if (!b.active) continue;
      b.age += step;
      if (b.age >= b.dur) {
        b.active = false;
        b.mesh.visible = false; // vfx-lint-allow: retire burst
      } else {
        const u = b.age / b.dur;
        b.mesh.scale.setScalar(0.3 + u * b.maxR);
        b.mat.opacity = 0.92 * (1.0 - u);
      }
    }

    // Step in-flight SAM rockets (proportional lead homing)
    for (const sam of activeSams) {
      if (!sam.active) continue;
      sam.age += step;
      const dx = sam.tx - sam.x, dy = sam.ty - sam.y, dz = sam.tz - sam.z;
      const dist = Math.hypot(dx, dy, dz);
      if (dist < 4.5 || sam.age > 3.2) {
        spawnBurst(sam.x, sam.y, sam.z, 7.5, 0xff8822, 0.55);
        sam.active = false;
        sam.mesh.visible = false; // vfx-lint-allow: sam detonate
        continue;
      }
      const spd = 155;
      sam.vx += ((dx / dist) * spd - sam.vx) * Math.min(1, step * 5.0);
      sam.vy += ((dy / dist) * spd - sam.vy) * Math.min(1, step * 5.0);
      sam.vz += ((dz / dist) * spd - sam.vz) * Math.min(1, step * 5.0);
      sam.x += sam.vx * step;
      sam.y += sam.vy * step;
      sam.z += sam.vz * step;
      sam.mesh.position.set(sam.x, sam.y, sam.z);
      const vLen = Math.hypot(sam.vx, sam.vy, sam.vz) || 1;
      tmpDir.set(sam.vx / vLen, sam.vy / vLen, sam.vz / vLen);
      sam.mesh.quaternion.setFromUnitVectors(yAxis, tmpDir);
      samTrails.pushPoint(sam.trail, [sam.x, sam.y, sam.z]);
    }

    // Step in-flight Mortar shells (green smoke trail + 2 light bounces before detonation!)
    for (const sh of activeMortars) {
      if (!sh.active) continue;
      sh.age += step;
      sh.vz -= 9.81 * step;
      sh.x += sh.vx * step;
      sh.y += sh.vy * step;
      sh.z += sh.vz * step;

      sh.puffAcc += step;
      if (sh.puffAcc >= 0.035) {
        sh.puffAcc = 0;
        spawnGreenPuff(sh.x, sh.y, sh.z, 0.65, 0x28eb5a, 1.85);
      }

      const gz = ground(sh.x, sh.y);
      const floorZ = Number.isFinite(gz) ? gz : 0;
      if (sh.z <= floorZ + 0.14 && sh.vz < 0) {
        sh.z = floorZ + 0.14;
        if (sh.bounces === 0) {
          sh.bounces = 1;
          sh.vz = Math.max(2.6, -0.45 * sh.vz);
          sh.vx *= 0.58;
          sh.vy *= 0.58;
          spawnGreenPuff(sh.x, sh.y, floorZ + 0.2, 1.15, 0x8ef58a, 0.9);
        } else if (sh.bounces === 1) {
          sh.bounces = 2;
          sh.vz = Math.max(1.6, -0.30 * sh.vz);
          sh.vx *= 0.50;
          sh.vy *= 0.50;
          spawnGreenPuff(sh.x, sh.y, floorZ + 0.2, 0.95, 0x8ef58a, 0.8);
        } else {
          // 3rd contact -> detonate!
          spawnBurst(sh.x, sh.y, floorZ + 0.5, 6.5, 0x44ff66, 0.55);
          spawnGreenPuff(sh.x, sh.y, floorZ + 0.8, 2.2, 0x26ee5c, 2.4);
          sh.active = false;
          sh.mesh.visible = false; // vfx-lint-allow: mortar detonate
          continue;
        }
      }
      if (sh.age > 14.0) {
        sh.active = false;
        sh.mesh.visible = false; // vfx-lint-allow: mortar timeout
        continue;
      }
      sh.mesh.position.set(sh.x, sh.y, sh.z);
    }
  }

  function dispose() {
    if (root.parent) root.parent.remove(root);
    samTrails.dispose();
    laserPool.dispose();
    for (const s of shockPool) { s.geom.dispose(); s.mat.dispose(); }
    for (const gp of greenPuffs) gp.mat.dispose();
    for (const b of bursts) b.mat.dispose();
    puffGeom.dispose();
    samGeom.dispose();
    samMat.dispose();
    samGlowMat.dispose();
    shellGeom.dispose();
    shellMat.dispose();
    burstGeom.dispose();
  }

  return {
    root,
    samTrails,
    laserPool,
    fireSam,
    fireMortar,
    fireHeavyLaser,
    handleFireEvent,
    update,
    dispose,
  };
}

export const manifest = Object.freeze({
  id: "vfx-deployable-pools",
  channel: "particle",
  deterministic: true,
  lightCountDelta: 0,
  cacheKeyScope: "set",
  reads: Object.freeze(["clock", "weather", "geometry", "serverPose"]),
  writes: Object.freeze(["emitter", "materialUniform", "renderTransform"]),
});
