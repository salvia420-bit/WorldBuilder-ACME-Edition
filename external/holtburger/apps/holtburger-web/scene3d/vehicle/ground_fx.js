// scene3d/vehicle/ground_fx.js — Pooled Zero-Allocation 3D Ground VFX Manager (Milestone 3 / Feature 13 / Feature 43)
// 4-wheel surface-tinted rooster-tails & dust plumes (Road, Dirt, Grass, Sand, Snow, ShallowFord water splash),
// handbrake skid & drift smoke, L134 tailpipe exhaust wisps ([+0.52, -1.62, 0.36]), and 4-wheel deformable ruts.
// Pure zero-allocation architecture during update() with lightCountDelta === 0.

import * as THREE_DEFAULT from "three";

export const POOL_SIZE = 64;

export const DEFORMABLE_SURFACES = Object.freeze(new Set([1, 2, 3, 4, 5, 6, 10])); // Dirt, Grass, Forest, Snow, Sand, Swamp, Ash

export const SURFACE_RUT_STRENGTH = Object.freeze({
  1: 0.65, // Dirt
  2: 0.45, // Grass
  3: 0.60, // Forest
  4: 0.85, // Snow
  5: 0.75, // Sand
  6: 0.95, // Swamp
  10: 0.70, // Ash
});

export const SURFACE_PARTICLE_COLORS = Object.freeze({
  0: 0x999999, // Road dust
  1: 0x8a6d4b, // Dirt brown
  2: 0x6e7845, // Grass/earth
  3: 0x544732, // Forest loam
  4: 0xf0f5ff, // Snow white
  5: 0xd4be8d, // Sand golden
  6: 0x3e3526, // Swamp mud
  7: 0xbbddee, // Shallow water spray
  10: 0x4f4f4f, // Volcanic ash
});

export const JEEP_DIMENSIONS = Object.freeze({
  wheelbase: 2.04,
  trackWidth: 1.48,
  tailpipeOffset: Object.freeze([0.52, -1.62, 0.36]), // Rear-right L134 tailpipe
  // 4-wheel contact offsets: FL, FR, RL, RR
  wheelOffsets: Object.freeze([
    Object.freeze([-0.74, 1.02]),  // FL
    Object.freeze([0.74, 1.02]),   // FR
    Object.freeze([-0.74, -1.02]), // RL
    Object.freeze([0.74, -1.02]),  // RR
  ]),
});

export const SEMI_FX_DIMENSIONS = Object.freeze({
  wheelbase: 4.66,
  trackWidth: 2.12,
  exhaustOffsets: Object.freeze([
    Object.freeze([-1.08, -0.44, 3.72]),
    Object.freeze([ 1.08, -0.44, 3.72]),
  ]),
  // 6-wheel contact offsets: Steer L/R (+2.65), Tandem Front L/R (-1.35), Tandem Rear L/R (-2.67)
  wheelOffsets: Object.freeze([
    Object.freeze([-1.06,  2.65]),
    Object.freeze([ 1.06,  2.65]),
    Object.freeze([-1.06, -1.35]),
    Object.freeze([ 1.06, -1.35]),
    Object.freeze([-1.06, -2.67]),
    Object.freeze([ 1.06, -2.67]),
  ]),
});

/**
 * Resolves surface color hex from either string name ("Grass", "Snow", etc.)
 * or numeric surface family ID.
 */
export function resolveSurfaceColor(surface) {
  if (typeof surface === "string") {
    const s = surface.toLowerCase();
    if (s.includes("road") || s.includes("stone") || s.includes("asphalt")) return 0x999999;
    if (s.includes("dirt") || s.includes("mud") || s.includes("earth")) return 0x8a6d4b;
    if (s.includes("grass")) return 0x6e7845;
    if (s.includes("sand")) return 0xd4be8d;
    if (s.includes("snow") || s.includes("ice")) return 0xf0f5ff;
    if (s.includes("shallow") || s.includes("water") || s.includes("ford") || s.includes("splash")) return 0xbbddee;
    if (s.includes("forest")) return 0x544732;
    if (s.includes("ash")) return 0x4f4f4f;
    return 0x8a6d4b;
  }
  if (typeof surface === "number") {
    return SURFACE_PARTICLE_COLORS[surface] || 0x8a6d4b;
  }
  return 0x8a6d4b;
}

/**
 * Generates a soft multi-octave radial cloud DataTexture.
 * Works headlessly in Node.js unit tests and WebGL canvas.
 */
export function makeCloudTexture(THREE, n = 64) {
  const data = new Uint8Array(n * n * 4);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = ((i + 0.5) / n) * 2 - 1;
      const y = ((j + 0.5) / n) * 2 - 1;
      const r = Math.hypot(x, y);
      const ang = Math.atan2(y, x);
      const wobble = 1 + 0.08 * Math.sin(ang * 3 + r * 4) + 0.05 * Math.cos(ang * 5 - r * 3);
      const a = Math.pow(Math.max(0, 1 - r * wobble), 1.75);
      const k = (j * n + i) * 4;
      data[k] = 255;
      data[k + 1] = 255;
      data[k + 2] = 255;
      data[k + 3] = Math.round(Math.max(0, Math.min(1, a)) * 255);
    }
  }
  const tex = new THREE.DataTexture(data, n, n, THREE.RGBAFormat);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Creates the high-performance pooled Ground VFX manager.
 * Supports both signatures: createGroundFx(opts) and createGroundFx(three, root, opts).
 */
export function createGroundFx(arg1, arg2, arg3) {
  let three, root, opts;
  if (arg1 && (arg1.Scene || arg1.Sprite || arg1.Vector3 || arg1.DataTexture)) {
    three = arg1;
    root = arg2;
    opts = arg3 || {};
  } else if (arg1 && typeof arg1 === "object") {
    opts = arg1;
    three = opts.three || opts.THREE;
    root = opts.root;
  } else {
    opts = {};
  }

  const t = three || THREE_DEFAULT;
  if (!root) {
    root = new t.Group();
    root.name = "groundFxRoot";
  }

  const cloudTex = makeCloudTexture(t, 64);
  const baseSpriteMat = new t.SpriteMaterial({
    map: cloudTex,
    transparent: true,
    opacity: 0.35,
    depthWrite: false,
  });

  // Preallocated sprite pool
  const pool = [];
  let poolCursor = 0;

  for (let i = 0; i < POOL_SIZE; i++) {
    const mat = baseSpriteMat.clone();
    const sprite = new t.Sprite(mat);
    sprite.visible = false;
    sprite.renderOrder = 4;
    root.add(sprite);

    pool.push({
      sprite,
      mat,
      active: false,
      t: 0,
      life: 1.0,
      x: 0, y: 0, z: 0,
      vx: 0, vy: 0, vz: 0,
      s0: 0.3, s1: 1.0,
      op0: 0.4,
      drag: 1.5,
      rise: 0.5,
    });
  }

  // Rut stamping memory (preallocated 6 slots for 4x4 and 6x4 rigs; zero allocations)
  const lastStamped = [
    { x: -Infinity, y: -Infinity },
    { x: -Infinity, y: -Infinity },
    { x: -Infinity, y: -Infinity },
    { x: -Infinity, y: -Infinity },
    { x: -Infinity, y: -Infinity },
    { x: -Infinity, y: -Infinity },
  ];

  // Zero-allocation timers (primed so first tick emits immediately)
  let exhaustTimer = 0.10;
  let wheelPlumeAccum = 0.8;
  let skidAccum = 0.05;

  function spawnParticle(x, y, z, vx, vy, vz, s0, s1, op0, life, colorHex, drag = 1.5, rise = 0.5) {
    let slot = null;
    for (let i = 0; i < POOL_SIZE; i++) {
      const idx = (poolCursor + i) % POOL_SIZE;
      if (!pool[idx].active) {
        slot = pool[idx];
        poolCursor = (idx + 1) % POOL_SIZE;
        break;
      }
    }
    if (!slot) {
      slot = pool[poolCursor];
      poolCursor = (poolCursor + 1) % POOL_SIZE;
    }

    slot.active = true;
    slot.t = 0;
    slot.life = Math.max(0.05, life);
    slot.x = x; slot.y = y; slot.z = z;
    slot.vx = vx; slot.vy = vy; slot.vz = vz;
    slot.s0 = s0; slot.s1 = s1;
    slot.op0 = op0;
    slot.drag = drag;
    slot.rise = rise;

    slot.mat.color.setHex(colorHex);
    slot.mat.opacity = op0;
    slot.sprite.position.set(x, y, z);
    slot.sprite.scale.setScalar(s0);
    slot.sprite.visible = true;
  }

  return {
    lightCountDelta: 0,
    root,
    pool,

    getActiveCount() {
      let count = 0;
      for (let i = 0; i < POOL_SIZE; i++) {
        if (pool[i].active) count++;
      }
      return count;
    },

    update(vehicleGuid, pose, kinematics, dt) {
      let p, k, deltaT;
      if (typeof vehicleGuid === "object" && vehicleGuid !== null) {
        p = vehicleGuid;
        k = vehicleGuid;
        deltaT = typeof pose === "number" ? pose : 1 / 60;
      } else {
        p = pose || {};
        k = kinematics || {};
        deltaT = typeof dt === "number" ? dt : 1 / 60;
      }

      const px = p.x ?? p.pos?.[0] ?? 0;
      const py = p.y ?? p.pos?.[1] ?? 0;
      const pz = p.z ?? p.pos?.[2] ?? 0;
      const heading = p.heading || 0;
      const speed = k.speed ?? p.speed ?? 0;
      const slip = k.slip ?? (k.wheelSpin != null ? Math.abs(k.wheelSpin - speed) : 0);
      const handbrake = !!(k.handbrake || (k.groundFlags && (k.groundFlags & 0x02)));
      const throttle = k.throttle ?? (speed > 1.0 ? 0.75 : 0.0);
      const surface = k.surfaceType ?? k.surfaceFamily ?? p.surfaceFamily ?? 1;
      const isBridge = !!(k.isBridge ?? p.isBridge);

      // 1. Advance existing active particles in the preallocated pool
      for (let i = 0; i < POOL_SIZE; i++) {
        const slot = pool[i];
        if (!slot.active) continue;

        slot.t += deltaT;
        if (slot.t >= slot.life) {
          slot.active = false;
          slot.sprite.visible = false;
          continue;
        }

        const u = slot.t / slot.life;
        const dFactor = Math.exp(-slot.drag * deltaT);
        slot.vx *= dFactor;
        slot.vy *= dFactor;
        slot.vz = (slot.vz + slot.rise * deltaT) * dFactor;

        slot.x += slot.vx * deltaT;
        slot.y += slot.vy * deltaT;
        slot.z += slot.vz * deltaT;

        slot.sprite.position.set(slot.x, slot.y, slot.z);
        const s = slot.s0 + (slot.s1 - slot.s0) * u;
        slot.sprite.scale.setScalar(s);
        slot.mat.opacity = Math.max(0, slot.op0 * (1.0 - u));
      }

      const cosH = Math.cos(heading);
      const sinH = Math.sin(heading);
      const isSemi = (
        k.vehicleClass === 3 ||
        p.vehicleClass === 3 ||
        k.profileKey === "semi-379" ||
        p.profileKey === "semi-379" ||
        opts.vehicleClass === 3 ||
        opts.profileKey === "semi-379"
      );
      const dims = isSemi ? SEMI_FX_DIMENSIONS : JEEP_DIMENSIONS;
      const wheelCount = dims.wheelOffsets.length;

      // 2. Wheel Surface-Tinted Rooster-Tails & Dust Plumes (4 wheels for Jeep, 6 wheels for Semi)
      const absSpeed = Math.abs(speed);
      const surfaceColor = resolveSurfaceColor(surface);
      if (absSpeed > 1.2 && !isBridge) {
        wheelPlumeAccum += deltaT * absSpeed;
        // Interval between emissions (e.g. every ~0.8m of travel)
        if (wheelPlumeAccum >= 0.8) {
          wheelPlumeAccum = 0.0;
          const plumeScale0 = (isSemi ? 0.34 : 0.25) + Math.min(absSpeed / 30.0, 0.45);
          const plumeScale1 = plumeScale0 * 2.8;
          const isWater = surfaceColor === 0xbbddee;
          const plumeLife = isWater ? 0.45 : 0.75;
          const plumeRise = isWater ? 1.4 : 0.6;
          const plumeOp = isWater ? 0.65 : 0.35;

          for (let w = 0; w < wheelCount; w++) {
            const [lx, ly] = dims.wheelOffsets[w];
            const wx = px + lx * cosH - ly * sinH;
            const wy = py + lx * sinH + ly * cosH;
            const wz = pz + 0.05;

            // Backward emission velocity countering vehicle travel direction
            const vx = -sinH * (speed * 0.18) + (Math.random() - 0.5) * 0.3;
            const vy = -cosH * (speed * 0.18) + (Math.random() - 0.5) * 0.3;
            const vz = plumeRise * 0.5 + (Math.random() - 0.5) * 0.2;

            spawnParticle(
              wx, wy, wz,
              vx, vy, vz,
              plumeScale0, plumeScale1,
              plumeOp, plumeLife,
              surfaceColor,
              1.4, plumeRise
            );
          }
        }
      }

      // 3. Handbrake Skid & Drift Smoke (rear wheels: 2..3 for Jeep, 2..5 tandem drive wheels for Semi)
      const isSkidding = (handbrake && absSpeed > 1.5) || Math.abs(slip) > 2.0;
      if (isSkidding && !isBridge) {
        skidAccum += deltaT;
        if (skidAccum >= 0.05) { // 20 Hz skid smoke emission
          skidAccum = 0.0;
          for (let w = 2; w < wheelCount; w++) {
            const [lx, ly] = dims.wheelOffsets[w];
            const wx = px + lx * cosH - ly * sinH;
            const wy = py + lx * sinH + ly * cosH;
            const wz = pz + 0.06;

            const vx = -sinH * (speed * 0.25) + (Math.random() - 0.5) * 0.5;
            const vy = -cosH * (speed * 0.25) + (Math.random() - 0.5) * 0.5;
            const vz = 0.8 + Math.random() * 0.4;

            spawnParticle(
              wx, wy, wz,
              vx, vy, vz,
              0.4, 1.8,
              0.55, 0.8,
              0xdddddd, // Skid tire smoke
              1.2, 1.0
            );
          }
        }
      }

      // 4. Exhaust Wisps / Dual Vertical Diesel Stacks
      exhaustTimer += deltaT;
      const isIdle = Math.abs(speed) < 1.0;
      const exhaustInterval = isIdle ? 0.10 : (0.04 + 0.04 * (1.0 - Math.min(1.0, throttle)));
      if (exhaustTimer >= exhaustInterval) {
        exhaustTimer = 0.0;
        if (isSemi) {
          const sootHex = throttle > 0.25 ? 0x3b3b3b : 0x525252;
          const puffScale0 = isIdle ? 0.15 : (0.20 + throttle * 0.16);
          const puffScale1 = isIdle ? 0.55 : (0.95 + throttle * 0.45);
          const puffOp = isIdle ? 0.24 : (0.42 + throttle * 0.20);
          const puffLife = isIdle ? 0.55 : 0.80;
          const backDrift = Math.max(0.4, Math.abs(speed) * 0.15);

          for (let e = 0; e < SEMI_FX_DIMENSIONS.exhaustOffsets.length; e++) {
            const [txOff, tyOff, tzOff] = SEMI_FX_DIMENSIONS.exhaustOffsets[e];
            const tx = px + txOff * cosH - tyOff * sinH;
            const ty = py + txOff * sinH + tyOff * cosH;
            const tz = pz + tzOff;

            const vx = -sinH * backDrift + (Math.random() - 0.5) * 0.15;
            const vy = -cosH * backDrift + (Math.random() - 0.5) * 0.15;
            const vz = 1.4 + throttle * 0.8 + (Math.random() - 0.5) * 0.15;

            spawnParticle(
              tx, ty, tz,
              vx, vy, vz,
              puffScale0, puffScale1,
              puffOp, puffLife,
              sootHex,
              1.6, 0.90
            );
          }
        } else {
          const [txOff, tyOff, tzOff] = JEEP_DIMENSIONS.tailpipeOffset;
          const tx = px + txOff * cosH - tyOff * sinH;
          const ty = py + txOff * sinH + tyOff * cosH;
          const tz = pz + tzOff;

          const puffScale0 = isIdle ? 0.12 : (0.16 + throttle * 0.12);
          const puffScale1 = isIdle ? 0.42 : (0.65 + throttle * 0.30);
          const puffOp = isIdle ? 0.22 : (0.35 + throttle * 0.15);
          const puffLife = isIdle ? 0.45 : 0.65;

          // Exhaust emerges backwards and gently up
          const vx = -sinH * 0.5 + (Math.random() - 0.5) * 0.15;
          const vy = -cosH * 0.5 + (Math.random() - 0.5) * 0.15;
          const vz = 0.35 + (Math.random() - 0.5) * 0.1;

          spawnParticle(
            tx, ty, tz,
            vx, vy, vz,
            puffScale0, puffScale1,
            puffOp, puffLife,
            0x555555, // Exhaust carbon wisp
            1.8, 0.45
          );
        }
      }

      // 5. Deformable Terrain Ruts (window.__terrainVfx.trail.stamp)
      const isDeformable = DEFORMABLE_SURFACES.has(surface) && !isBridge;
      if (isDeformable && typeof window !== "undefined" && window.__terrainVfx?.trail?.stamp) {
        const baseStrength = SURFACE_RUT_STRENGTH[surface] || 0.5;
        const strength = Math.min(1.0, baseStrength * (1.0 + slip * 0.4));

        for (let i = 0; i < wheelCount; i++) {
          const [lx, ly] = dims.wheelOffsets[i];
          const wx = px + lx * cosH - ly * sinH;
          const wy = py + lx * sinH + ly * cosH;

          const dist = Math.hypot(wx - lastStamped[i].x, wy - lastStamped[i].y);
          if (dist >= 0.40 || slip > 2.0) {
            window.__terrainVfx.trail.stamp(wx, wy, isSemi ? 0.42 : 0.32, strength);
            lastStamped[i].x = wx;
            lastStamped[i].y = wy;
          }
        }
      }
    },

    dispose() {
      for (let i = 0; i < pool.length; i++) {
        const slot = pool[i];
        slot.active = false;
        slot.sprite.visible = false;
        if (slot.sprite.parent) slot.sprite.parent.remove(slot.sprite);
        if (slot.mat) slot.mat.dispose();
      }
      pool.length = 0;
      if (cloudTex) cloudTex.dispose();
    },
  };
}
