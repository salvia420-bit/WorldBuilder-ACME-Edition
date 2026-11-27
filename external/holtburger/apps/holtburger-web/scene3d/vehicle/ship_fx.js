// scene3d/vehicle/ship_fx.js — Pooled Zero-Allocation Maritime VFX (Kelvin Wake, Prop Wash, Thruster Jets)
//
// Strictly 0 dynamic THREE.Light instances (`lightCountDelta === 0`) and <= 4 draw calls total:
//   DC 1: Kelvin V-bow wake & hull shoulder foam sheets (InstancedMesh, 96 pooled quads)
//   DC 2: Stern propeller wash turbulent plume deflected by rudder (InstancedMesh, 64 pooled quads)
//   DC 3: Bow (+31 m) & Stern (-32 m) lateral tunnel thruster whitewater jets (InstancedMesh, 96 pooled quads)
//   DC 4: Bow wave spray & waterline foam puffs (InstancedMesh, 64 pooled puffs)
//
// Zero allocations during update() — preallocated typed state arrays & scratch THREE math objects.
// Deterministic seeded variation via mulberry32(hashString(...)) — zero Math.random().
// Phase-locked to exact AC ocean waterSwellLattice(x, y, t). Full dispose().

import * as THREE_DEFAULT from "three";
import { hashString, mulberry32 } from "../film/core/rng.js";
import { SHIP_SPECS, waterSwellLattice } from "./port_specs.js";

export const manifest = Object.freeze({
  id: "vfx-ship-maritime-fx",
  channel: "vehicleVfx",
  deterministic: true,
  lightCountDelta: 0,
  cacheKeyScope: "set",
  reads: Object.freeze(["geometry", "serverPose", "clock"]),
  writes: Object.freeze(["renderTransform", "materialUniform", "emitter"]),
});

export const SHIP_FX_LIMITS = Object.freeze({
  maxDrawCalls: 4,
  wakePool: 96,
  propPool: 64,
  thrusterPool: 96,
  sprayPool: 64,
});

const TWO_PI = Math.PI * 2.0;
const KELVIN_HALF_ANGLE = (19.47 * Math.PI) / 180.0; // classic deep-water Kelvin wake half-angle

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function fin(v) {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * Deterministic soft frothy whitewater foam DataTexture (works identically in headless Node & WebGL2).
 */
export function makeSeaFoamTexture(THREE, n = 64) {
  const data = new Uint8Array(n * n * 4);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const u = ((i + 0.5) / n) * 2 - 1;
      const v = ((j + 0.5) / n) * 2 - 1;
      const r = Math.hypot(u, v);
      const ang = Math.atan2(v, u);
      const froth = 0.85 + 0.15 * Math.sin(ang * 5 + r * 9) * Math.cos(ang * 3 - r * 7);
      const edge = Math.pow(Math.max(0, 1 - r), 1.55) * froth;
      const k = (j * n + i) * 4;
      data[k] = 242;
      data[k + 1] = 250;
      data[k + 2] = 255;
      data[k + 3] = Math.round(clamp(edge, 0, 1) * 255);
    }
  }
  const tex = new THREE.DataTexture(data, n, n, THREE.RGBAFormat);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Allocate a typed-array particle pool backing a single InstancedMesh (1 draw call, 0 runtime allocations).
 */
function createInstancedPool(t, name, capacity, geom, mat, renderOrder) {
  const mesh = new t.InstancedMesh(geom, mat, capacity);
  mesh.name = name;
  mesh.count = 0;
  mesh.frustumCulled = false;
  mesh.renderOrder = renderOrder;
  mesh.castShadow = false;
  mesh.receiveShadow = false;

  return {
    mesh,
    capacity,
    cursor: 0,
    activeCount: 0,
    active: new Uint8Array(capacity),
    age: new Float32Array(capacity),
    life: new Float32Array(capacity),
    x: new Float32Array(capacity),
    y: new Float32Array(capacity),
    z: new Float32Array(capacity),
    vx: new Float32Array(capacity),
    vy: new Float32Array(capacity),
    vz: new Float32Array(capacity),
    sx0: new Float32Array(capacity),
    sx1: new Float32Array(capacity),
    sy0: new Float32Array(capacity),
    sy1: new Float32Array(capacity),
    yaw: new Float32Array(capacity),
    drag: new Float32Array(capacity),
    r: new Float32Array(capacity),
    g: new Float32Array(capacity),
    b: new Float32Array(capacity),
  };
}

/**
 * Create the pooled zero-allocation maritime VFX system for a container ship.
 *
 * @param {object} [threeOrOpts]
 * @param {object} [rootOpt]
 * @param {object} [extraOpts]
 */
export function createShipFx(threeOrOpts, rootOpt, extraOpts) {
  let three;
  let root;
  let opts;
  if (threeOrOpts && (threeOrOpts.InstancedMesh || threeOrOpts.Group || threeOrOpts.DataTexture)) {
    three = threeOrOpts;
    root = rootOpt;
    opts = extraOpts || {};
  } else if (threeOrOpts && typeof threeOrOpts === "object") {
    opts = threeOrOpts;
    three = opts.three || opts.THREE;
    root = opts.root;
  } else {
    opts = {};
  }

  const t = three || THREE_DEFAULT;
  if (!root) {
    root = new t.Group();
    root.name = "ship-fx-root";
  }

  const rng = typeof opts.rng === "function" ? opts.rng : mulberry32(hashString("ship-maritime-fx-v1"));
  const S = SHIP_SPECS;

  const foamTex = makeSeaFoamTexture(t, 64);
  const quadGeom = new t.PlaneGeometry(1.0, 1.0); // lies in XY plane (Z-up surface normal!)

  const wakeMat = new t.MeshBasicMaterial({
    color: 0xffffff,
    map: foamTex,
    transparent: true,
    opacity: 0.72,
    depthWrite: false,
    side: t.DoubleSide,
  });
  const propMat = new t.MeshBasicMaterial({
    color: 0xe2f7ff,
    map: foamTex,
    transparent: true,
    opacity: 0.78,
    depthWrite: false,
    side: t.DoubleSide,
  });
  const thrusterMat = new t.MeshBasicMaterial({
    color: 0xf4fcff,
    map: foamTex,
    transparent: true,
    opacity: 0.88,
    depthWrite: false,
    side: t.DoubleSide,
  });
  const sprayMat = new t.MeshBasicMaterial({
    color: 0xffffff,
    map: foamTex,
    transparent: true,
    opacity: 0.62,
    depthWrite: false,
    side: t.DoubleSide,
  });

  const wakePool = createInstancedPool(t, "ship-fx-kelvin-wake", SHIP_FX_LIMITS.wakePool, quadGeom, wakeMat, 4);
  const propPool = createInstancedPool(t, "ship-fx-prop-wash", SHIP_FX_LIMITS.propPool, quadGeom, propMat, 5);
  const thrusterPool = createInstancedPool(t, "ship-fx-thruster-jets", SHIP_FX_LIMITS.thrusterPool, quadGeom, thrusterMat, 6);
  const sprayPool = createInstancedPool(t, "ship-fx-bow-spray", SHIP_FX_LIMITS.sprayPool, quadGeom, sprayMat, 7);

  root.add(wakePool.mesh, propPool.mesh, thrusterPool.mesh, sprayPool.mesh);

  // Preallocated zero-alloc scratch math objects
  const _mat4 = new t.Matrix4();
  const _pos = new t.Vector3();
  const _quat = new t.Quaternion();
  const _scale = new t.Vector3();
  const _axisZ = new t.Vector3(0, 0, 1);
  const _col = new t.Color();

  // Emission accumulators
  let wakeAccum = 0.25;
  let propAccum = 0.12;
  let bowThrAccum = 0.08;
  let sternThrAccum = 0.08;
  let sprayAccum = 0.15;
  let disposed = false;

  function spawnInPool(p, x, y, z, vx, vy, vz, sx0, sx1, sy0, sy1, yaw, life, drag, cr, cg, cb) {
    let idx = -1;
    for (let i = 0; i < p.capacity; i++) {
      const cand = (p.cursor + i) % p.capacity;
      if (p.active[cand] === 0) {
        idx = cand;
        p.cursor = (cand + 1) % p.capacity;
        break;
      }
    }
    if (idx < 0) {
      idx = p.cursor;
      p.cursor = (idx + 1) % p.capacity;
    }
    p.active[idx] = 1;
    p.age[idx] = 0;
    p.life[idx] = Math.max(0.1, life);
    p.x[idx] = x;
    p.y[idx] = y;
    p.z[idx] = z;
    p.vx[idx] = vx;
    p.vy[idx] = vy;
    p.vz[idx] = vz;
    p.sx0[idx] = sx0;
    p.sx1[idx] = sx1;
    p.sy0[idx] = sy0;
    p.sy1[idx] = sy1;
    p.yaw[idx] = yaw;
    p.drag[idx] = drag;
    p.r[idx] = cr;
    p.g[idx] = cg;
    p.b[idx] = cb;
  }

  function stepPool(p, dt, timeSec, trackSwell, zBias) {
    let writeIdx = 0;
    for (let i = 0; i < p.capacity; i++) {
      if (p.active[i] === 0) continue;
      p.age[i] += dt;
      if (p.age[i] >= p.life[i]) {
        p.active[i] = 0;
        continue;
      }
      const u = p.age[i] / p.life[i];
      const damp = Math.exp(-p.drag[i] * dt);
      p.vx[i] *= damp;
      p.vy[i] *= damp;
      p.vz[i] = (p.vz[i] - 1.8 * dt) * damp;
      p.x[i] += p.vx[i] * dt;
      p.y[i] += p.vy[i] * dt;
      p.z[i] += p.vz[i] * dt;

      const swellZ = trackSwell ? waterSwellLattice(p.x[i], p.y[i], timeSec) + zBias : Math.max(waterSwellLattice(p.x[i], p.y[i], timeSec) + 0.04, p.z[i]);
      const fade = (1.0 - u) * Math.min(1.0, u * 5.0);
      const sx = (p.sx0[i] + (p.sx1[i] - p.sx0[i]) * u) * (0.35 + 0.65 * Math.sqrt(Math.max(0.01, fade)));
      const sy = (p.sy0[i] + (p.sy1[i] - p.sy0[i]) * u) * (0.35 + 0.65 * Math.sqrt(Math.max(0.01, fade)));

      _pos.set(p.x[i], p.y[i], swellZ);
      _quat.setFromAxisAngle(_axisZ, -p.yaw[i]);
      _scale.set(sx, sy, 1.0);
      _mat4.compose(_pos, _quat, _scale);
      p.mesh.setMatrixAt(writeIdx, _mat4);

      const bright = 0.35 + 0.65 * fade;
      _col.setRGB(p.r[i] * bright, p.g[i] * bright, p.b[i] * bright);
      p.mesh.setColorAt(writeIdx, _col);
      writeIdx++;
    }

    p.activeCount = writeIdx;
    p.mesh.count = writeIdx;
    if (writeIdx > 0) {
      p.mesh.instanceMatrix.needsUpdate = true;
      if (p.mesh.instanceColor) p.mesh.instanceColor.needsUpdate = true;
    }
  }

  /**
   * Advance all maritime VFX pools (0 heap allocations).
   * Supports both `update(shipState, dt, timeSec)` and `update(id, shipState, dt, timeSec)`.
   */
  function update(arg1, arg2, arg3, arg4) {
    if (disposed) return;
    let st;
    let rawDt;
    let rawTime;
    if (arg1 && typeof arg1 === "object") {
      st = arg1;
      rawDt = arg2;
      rawTime = arg3;
    } else {
      st = arg2 && typeof arg2 === "object" ? arg2 : {};
      rawDt = arg3;
      rawTime = arg4;
    }

    const dt = fin(rawDt) ? clamp(rawDt, 0, 0.25) : 1 / 60;
    const timeSec = fin(rawTime) ? rawTime : (fin(st.timeSec) ? st.timeSec : 0);

    const px = fin(st.x) ? st.x : 0;
    const py = fin(st.y) ? st.y : 0;
    const heading = fin(st.heading) ? st.heading : 0;
    const surgeSpeed = fin(st.surgeSpeed) ? st.surgeSpeed : (fin(st.surgeU) ? st.surgeU : (fin(st.speed) ? st.speed : 0));
    const absSurge = Math.abs(surgeSpeed);
    const throttle = fin(st.throttle)
      ? clamp(st.throttle, -1, 1)
      : (fin(st.eotNotch) ? clamp(st.eotNotch / 3.0, -1, 1) : (fin(st.eot) ? clamp(st.eot / 3.0, -1, 1) : 0));
    const rudderRad = fin(st.rudderRad) ? st.rudderRad : (fin(st.rudderAngleRad) ? st.rudderAngleRad : 0);
    const bowThr = clamp(fin(st.bowThruster) ? st.bowThruster : 0, -1, 1);
    const sternThr = clamp(fin(st.sternThruster) ? st.sternThruster : 0, -1, 1);

    const sh = Math.sin(heading);
    const ch = Math.cos(heading);
    // Forward unit vector: [sh, ch]; Starboard unit vector: [ch, -sh]
    const fwdX = sh;
    const fwdY = ch;
    const stbdX = ch;
    const stbdY = -sh;

    // 1. Kelvin V-Bow Wake & Hull Shoulder Foam Sheets
    if (absSurge > 0.30) {
      wakeAccum += dt * (1.5 + absSurge * 1.4);
      if (wakeAccum >= 0.22) {
        wakeAccum = 0;
        const speedFrac = clamp(absSurge / 6.5, 0.15, 1.25);
        const dirSign = surgeSpeed >= 0 ? 1 : -1;
        const bowY = dirSign > 0 ? 35.5 : -36.5;

        for (let sIdx = 0; sIdx < 2; sIdx++) {
          const side = sIdx === 0 ? -1 : +1;
          const jitter = (rng() - 0.5) * 0.6;
          const lx = side * (3.2 + speedFrac * 1.8) + jitter * 0.3;
          const ly = bowY - dirSign * (2.5 + rng() * 3.5);
          const wx = px + lx * ch + ly * sh;
          const wy = py - lx * sh + ly * ch;

          // Outward Kelvin wave arm propagation at ~19.47 deg half-angle
          const outSpeed = (1.1 + absSurge * 0.38) * (0.9 + rng() * 0.2);
          const vx = stbdX * side * outSpeed - fwdX * dirSign * (absSurge * 0.12);
          const vy = stbdY * side * outSpeed - fwdY * dirSign * (absSurge * 0.12);
          const armYaw = heading + side * KELVIN_HALF_ANGLE * dirSign;

          spawnInPool(
            wakePool,
            wx, wy, 0.08,
            vx, vy, 0,
            2.4 * speedFrac, 8.8 * speedFrac,
            5.2 * speedFrac, 15.5 * speedFrac,
            armYaw,
            3.2 + speedFrac * 1.8,
            0.35,
            0.92, 0.98, 1.0
          );
        }
      }
    }

    // 2. Stern Propeller Wash Plume (scaled by |throttle| & |surgeSpeed|, deflected by rudderRad)
    const propPower = Math.max(Math.abs(throttle), clamp(absSurge / 6.2, 0, 1) * 0.65);
    if (propPower > 0.06) {
      propAccum += dt * (3.0 + propPower * 8.0);
      if (propAccum >= 0.14) {
        propAccum = 0;
        const wx = px + (S.propellerY - 2.6) * sh;
        const wy = py + (S.propellerY - 2.6) * ch;
        const jetAngle = heading + Math.PI - rudderRad * 0.65 + (rng() - 0.5) * 0.14;
        const jetSpd = (2.2 + propPower * 4.8) * (throttle < -0.05 ? 0.55 : 1.0);
        const vx = Math.sin(jetAngle) * jetSpd;
        const vy = Math.cos(jetAngle) * jetSpd;

        spawnInPool(
          propPool,
          wx + (rng() - 0.5) * 1.1,
          wy + (rng() - 0.5) * 1.1,
          0.07,
          vx, vy, 0,
          2.2 + propPower * 1.6,
          7.2 + propPower * 4.2,
          3.4 + propPower * 2.2,
          10.5 + propPower * 5.2,
          heading + (rng() - 0.5) * 0.25,
          2.4 + propPower * 1.6,
          0.55,
          0.84, 0.96, 0.98
        );
      }
    }

    // 3. Lateral Tunnel Thruster Whitewater Jets (Bow y = +31 m, Stern y = -32 m)
    // Newton's 3rd Law: thrusting starboard (+cmd) blasts whitewater out the PORT (-X) tunnel!
    const absBow = Math.abs(bowThr);
    if (absBow > 0.04) {
      bowThrAccum += dt * (4.0 + absBow * 14.0);
      if (bowThrAccum >= 0.12) {
        bowThrAccum = 0;
        const jetSide = bowThr > 0 ? -1 : +1; // opposite thrust direction
        const tunnelX = jetSide * (S.halfBeamM * 0.76);
        const wx = px + tunnelX * ch + S.bowThrusterY * sh;
        const wy = py - tunnelX * sh + S.bowThrusterY * ch;
        const jetSpd = 3.2 + absBow * 5.8;
        const vx = stbdX * jetSide * jetSpd + (rng() - 0.5) * 0.9;
        const vy = stbdY * jetSide * jetSpd + (rng() - 0.5) * 0.9;

        spawnInPool(
          thrusterPool,
          wx, wy, 0.11,
          vx, vy, 0,
          2.0 + absBow * 1.8,
          6.8 + absBow * 5.4,
          1.6 + absBow * 1.4,
          4.8 + absBow * 3.8,
          heading + (rng() - 0.5) * 0.4,
          1.6 + absBow * 1.0,
          0.95,
          0.95, 0.99, 1.0
        );
      }
    }

    const absStern = Math.abs(sternThr);
    if (absStern > 0.04) {
      sternThrAccum += dt * (4.0 + absStern * 14.0);
      if (sternThrAccum >= 0.12) {
        sternThrAccum = 0;
        const jetSide = sternThr > 0 ? -1 : +1;
        const tunnelX = jetSide * (S.halfBeamM * 0.72);
        const wx = px + tunnelX * ch + S.sternThrusterY * sh;
        const wy = py - tunnelX * sh + S.sternThrusterY * ch;
        const jetSpd = 3.0 + absStern * 5.2;
        const vx = stbdX * jetSide * jetSpd + (rng() - 0.5) * 0.9;
        const vy = stbdY * jetSide * jetSpd + (rng() - 0.5) * 0.9;

        spawnInPool(
          thrusterPool,
          wx, wy, 0.11,
          vx, vy, 0,
          1.9 + absStern * 1.6,
          6.2 + absStern * 4.8,
          1.5 + absStern * 1.3,
          4.4 + absStern * 3.4,
          heading + (rng() - 0.5) * 0.4,
          1.5 + absStern * 0.95,
          0.95,
          0.95, 0.99, 1.0
        );
      }
    }

    // 4. Bow Wave Spray & Waterline Foam Puffs
    if (absSurge > 0.8) {
      sprayAccum += dt * (2.0 + absSurge * 2.2);
      if (sprayAccum >= 0.18) {
        sprayAccum = 0;
        const speedFrac = clamp(absSurge / 6.2, 0.1, 1.2);
        const side = rng() < 0.5 ? -1 : +1;
        const lx = side * (1.2 + rng() * 1.4);
        const ly = 36.2 + (rng() - 0.5) * 3.0;
        const wx = px + lx * ch + ly * sh;
        const wy = py - lx * sh + ly * ch;

        spawnInPool(
          sprayPool,
          wx, wy, 0.35 + speedFrac * 0.45,
          stbdX * side * (1.4 + speedFrac * 1.8) + fwdX * (absSurge * 0.25),
          stbdY * side * (1.4 + speedFrac * 1.8) + fwdY * (absSurge * 0.25),
          0.8 + speedFrac * 1.2,
          1.2 * speedFrac, 3.6 * speedFrac,
          1.2 * speedFrac, 3.6 * speedFrac,
          rng() * TWO_PI,
          0.9 + speedFrac * 0.6,
          1.1,
          0.98, 0.99, 1.0
        );
      }
    }

    // Step all 4 pools & upload matrices
    stepPool(wakePool, dt, timeSec, true, 0.08);
    stepPool(propPool, dt, timeSec, true, 0.09);
    stepPool(thrusterPool, dt, timeSec, true, 0.12);
    stepPool(sprayPool, dt, timeSec, false, 0.14);
  }

  function reset() {
    for (const p of [wakePool, propPool, thrusterPool, sprayPool]) {
      p.active.fill(0);
      p.activeCount = 0;
      p.cursor = 0;
      p.mesh.count = 0;
    }
  }

  function getActiveCounts() {
    return {
      wake: wakePool.activeCount,
      propWash: propPool.activeCount,
      thrusters: thrusterPool.activeCount,
      spray: sprayPool.activeCount,
      total: wakePool.activeCount + propPool.activeCount + thrusterPool.activeCount + sprayPool.activeCount,
    };
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    reset();
    for (const p of [wakePool, propPool, thrusterPool, sprayPool]) {
      if (p.mesh.parent) p.mesh.parent.remove(p.mesh);
    }
    quadGeom.dispose();
    wakeMat.dispose();
    propMat.dispose();
    thrusterMat.dispose();
    sprayMat.dispose();
    foamTex.dispose();
  }

  return {
    root,
    lightCountDelta: 0,
    maxDrawCalls: SHIP_FX_LIMITS.maxDrawCalls,
    meshes: {
      wake: wakePool.mesh,
      propWash: propPool.mesh,
      thrusters: thrusterPool.mesh,
      spray: sprayPool.mesh,
    },
    update,
    reset,
    getActiveCounts,
    getTotalActiveCount: () => wakePool.activeCount + propPool.activeCount + thrusterPool.activeCount + sprayPool.activeCount,
    get disposed() { return disposed; },
    dispose,
  };
}
