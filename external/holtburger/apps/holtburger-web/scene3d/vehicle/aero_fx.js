// scene3d/vehicle/aero_fx.js — world-space aerodynamic & propwash VFX for capable vehicle clients.
//
// Zero PointLight / SpotLight (never relinks lit world programs), zero per-frame GC allocations:
//   1. Wingtip Condensation Vortices: twin world-space fading ribbons from [±6.52, 0.42, 2.82] in vehicle frame
//      during high-G / high-speed flight (mode === FLIGHT, speed > 46 m/s, gLoad > 1.55), fading over 0.45 s.
//   2. Radial Engine Startup Cough & WEP Soot Wisps: pooled billboard sprites (max 40) puffing gray-brown R-2800
//      startup smoke on PARKED -> TAKEOFF throttle-up and faint dark-gray WEP soot wisps under boost.
//   3. Low-Altitude Propwash Dust & Ocean Spray: pooled billboard sprites kicking up expanding tan dust over terrain
//      or white sea-spray mist over water (`opts.inOcean`) when `agl < 34 m` and `throttle > 0.22`.

import { MODE } from "./flight_model.js";
import { prewarmSubtree } from "../bake_prewarm.js";

export const AERO_FX = Object.freeze({
  vortexOffsets: Object.freeze([[-6.52, 0.42, 2.82], [6.52, 0.42, 2.82]]),
  exhaustOffsets: Object.freeze([[-0.76, 1.78, 2.48], [0.76, 1.78, 2.48]]),
  vortexMinSpeed: 46,
  vortexMinG: 1.55,
  vortexLifeSec: 0.45,
  maxVortexVehicles: 8,
  pointsPerTip: 40,
  maxSmokeSprites: 40,
  maxWashSprites: 32,
  propwashMaxAgl: 34,
  propwashMinThrottle: 0.22,
});

export function aeroFxEnabled(search) {
  try { return new URLSearchParams(search || "").get("vehicleAeroFx") !== "off"; } catch (_) { return true; }
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Rotate `[vx, vy, vz]` by AC quaternion `q = [w, x, y, z]` into scratch `out` without allocating. */
function rotateInto(out, q, vx, vy, vz) {
  const w = q ? q[0] : 1, x = q ? q[1] : 0, y = q ? q[2] : 0, z = q ? q[3] : 0;
  const tx = 2 * (y * vz - z * vy);
  const ty = 2 * (z * vx - x * vz);
  const tz = 2 * (x * vy - y * vx);
  out[0] = vx + w * tx + (y * tz - z * ty);
  out[1] = vy + w * ty + (z * tx - x * tz);
  out[2] = vz + w * tz + (x * ty - y * tx);
  return out;
}

/** Soft multi-octave cloud radial DataTexture (works headlessly in Node tests and in WebGL). */
function makeCloudTexture(THREE, n = 64) {
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
      data[k] = data[k + 1] = data[k + 2] = 255;
      data[k + 3] = Math.round(clamp(a, 0, 1) * 255);
    }
  }
  const tex = new THREE.DataTexture(data, n, n, THREE.RGBAFormat);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

function makeTipRing() {
  const N = AERO_FX.pointsPerTip;
  // Stride 9 floats per sample: [x, y, z, rx, ry, rz, age, strength, runId]
  return {
    data: new Float32Array(N * 9),
    head: 0,
    count: 0,
    runId: 1,
    wasActive: false,
  };
}

function pushTipPoint(ring, x, y, z, rx, ry, rz, strength) {
  const N = AERO_FX.pointsPerTip;
  // Skip near-duplicate sample if aircraft barely moved (< 0.12 m)
  if (ring.count > 0 && ring.wasActive) {
    const prevIdx = ((ring.head - 1 + N) % N) * 9;
    const dx = x - ring.data[prevIdx], dy = y - ring.data[prevIdx + 1], dz = z - ring.data[prevIdx + 2];
    if (dx * dx + dy * dy + dz * dz < 0.0144) {
      ring.data[prevIdx] = x;
      ring.data[prevIdx + 1] = y;
      ring.data[prevIdx + 2] = z;
      ring.data[prevIdx + 6] = 0;
      ring.data[prevIdx + 7] = strength;
      return false;
    }
  }
  if (!ring.wasActive) ring.runId++;
  ring.wasActive = true;
  const o = ring.head * 9;
  ring.data[o] = x;
  ring.data[o + 1] = y;
  ring.data[o + 2] = z;
  ring.data[o + 3] = rx;
  ring.data[o + 4] = ry;
  ring.data[o + 5] = rz;
  ring.data[o + 6] = 0;
  ring.data[o + 7] = strength;
  ring.data[o + 8] = ring.runId;
  ring.head = (ring.head + 1) % N;
  if (ring.count < N) ring.count++;
  return true;
}

/**
 * @param {{liveScene3d: object, THREE: object, ground?: (x:number, y:number)=>number}} deps
 */
export function createAeroFx(deps = {}) {
  const live = deps.liveScene3d ?? null;
  const THREE = deps.THREE ?? null;
  const ground = typeof deps.ground === "function" ? deps.ground : null;

  const tracks = new Map(); // guid → per-vehicle state & pre-allocated wingtip ring buffers
  const freeTipPairs = [];
  const smokePool = []; // pre-allocated length MAX_SMOKE_SPRITES
  const washPool = [];  // pre-allocated length MAX_WASH_SPRITES
  let smokeCursor = 0;
  let washCursor = 0;
  let rngState = 0x6d2b79f5;

  let root = null;
  let cloudTex = null;
  let vortexGeom = null;
  let vortexMat = null;
  let vortexMesh = null;
  let vortexDirty = false;
  let activeVortexSegments = 0;
  let disposed = false;

  const counters = {
    emittedVortex: 0,
    emittedSmoke: 0,
    emittedWep: 0,
    emittedPropwash: 0,
    emittedSpray: 0,
  };

  // Scratch vectors (zero per-frame heap allocation)
  const tmpTip = [0, 0, 0];
  const tmpRight = [1, 0, 0];
  const tmpFwd = [0, 1, 0];
  const tmpUp = [0, 0, 1];

  function rand01() {
    rngState = (rngState ^ (rngState << 13)) >>> 0;
    rngState = (rngState ^ (rngState >>> 17)) >>> 0;
    rngState = (rngState ^ (rngState << 5)) >>> 0;
    return (rngState >>> 8) * (1 / 16777216);
  }

  function ensure() {
    if (disposed) return false;
    if (root) return true;
    if (!THREE || !live || !live.worldRoot) return false;

    root = new THREE.Group();
    root.name = "vehicle-aero-fx";
    live.worldRoot.add(root);

    // 1. Single shared world-space ribbon mesh for all wingtip condensation vortices (1 draw call!)
    const maxSegs = AERO_FX.maxVortexVehicles * 2 * (AERO_FX.pointsPerTip - 1);
    const maxVerts = maxSegs * 6;
    vortexGeom = new THREE.BufferGeometry();
    vortexGeom.setAttribute("position", new THREE.BufferAttribute(new Float32Array(maxVerts * 3), 3));
    vortexGeom.setAttribute("color", new THREE.BufferAttribute(new Float32Array(maxVerts * 4), 4));
    vortexGeom.setDrawRange(0, 0);
    vortexMat = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    vortexMesh = new THREE.Mesh(vortexGeom, vortexMat);
    vortexMesh.frustumCulled = false;
    vortexMesh.renderOrder = 5;
    vortexMesh.visible = false;
    vortexMesh.name = "aero-wingtip-vortices";
    root.add(vortexMesh);

    // 2. Pooled billboard sprites for radial startup cough + WEP wisps (max 40) & low-AGL propwash/spray (max 32)
    cloudTex = makeCloudTexture(THREE, 64);
    const baseSpriteMat = new THREE.SpriteMaterial({
      map: cloudTex,
      color: 0xffffff,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });

    for (let i = 0; i < AERO_FX.maxSmokeSprites; i++) {
      const mat = i === 0 ? baseSpriteMat : baseSpriteMat.clone();
      const sprite = new THREE.Sprite(mat);
      sprite.visible = false;
      sprite.renderOrder = 5;
      root.add(sprite);
      smokePool.push({
        sprite, mat, active: false, t: 0, life: 1,
        x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0,
        s0: 1, s1: 2, op0: 0.3, drag: 1.5,
      });
    }

    for (let i = 0; i < AERO_FX.maxWashSprites; i++) {
      const mat = baseSpriteMat.clone();
      const sprite = new THREE.Sprite(mat);
      sprite.visible = false;
      sprite.renderOrder = 4;
      root.add(sprite);
      washPool.push({
        sprite, mat, active: false, t: 0, life: 1,
        x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0,
        s0: 2, s1: 7, op0: 0.35, drag: 1.8,
      });
    }

    for (let i = 0; i < AERO_FX.maxVortexVehicles; i++) {
      freeTipPairs.push([makeTipRing(), makeTipRing()]);
    }

    try {
      const warmGroup = new THREE.Group();
      warmGroup.add(new THREE.Mesh(vortexGeom, vortexMat));
      warmGroup.add(new THREE.Sprite(smokePool[0].mat));
      prewarmSubtree(live, warmGroup).catch(() => {});
    } catch (_) { /* best effort */ }

    return true;
  }

  function spawnFromPool(pool, isWash, x, y, z, vx, vy, vz, s0, s1, op0, life, colorHex, drag = 1.6) {
    const len = pool.length;
    if (!len) return;
    let slot = null;
    for (let i = 0; i < len; i++) {
      const idx = isWash ? ((washCursor + i) % len) : ((smokeCursor + i) % len);
      if (!pool[idx].active) {
        slot = pool[idx];
        if (isWash) washCursor = (idx + 1) % len;
        else smokeCursor = (idx + 1) % len;
        break;
      }
    }
    if (!slot) {
      const idx = isWash ? washCursor : smokeCursor;
      slot = pool[idx];
      if (isWash) washCursor = (idx + 1) % len;
      else smokeCursor = (idx + 1) % len;
    }
    slot.active = true;
    slot.t = 0;
    slot.life = Math.max(0.08, life);
    slot.x = x; slot.y = y; slot.z = z;
    slot.vx = vx; slot.vy = vy; slot.vz = vz;
    slot.s0 = s0; slot.s1 = s1;
    slot.op0 = op0;
    slot.drag = drag;
    slot.mat.color.setHex(colorHex);
    slot.mat.opacity = op0 * 0.35;
    slot.sprite.position.set(x, y, z);
    slot.sprite.scale.setScalar(s0);
    slot.sprite.visible = true;
  }

  function trackFor(guid) {
    const g = guid >>> 0;
    let tr = tracks.get(g);
    if (!tr) {
      const tips = freeTipPairs.length > 0 ? freeTipPairs.pop() : [makeTipRing(), makeTipRing()];
      tips[0].head = tips[0].count = 0; tips[0].wasActive = false;
      tips[1].head = tips[1].count = 0; tips[1].wasActive = false;
      tr = {
        guid: g,
        tips,
        prevMode: null,
        prevThrottle: 0,
        startupTimer: 0,
        startupAcc: 0,
        wepAcc: 0,
        washAcc: 0,
      };
      tracks.set(g, tr);
    }
    return tr;
  }

  function rebuildVortexGeometry() {
    if (!vortexGeom) return;
    const posArr = vortexGeom.getAttribute("position").array;
    const colArr = vortexGeom.getAttribute("color").array;
    const maxVerts = posArr.length / 3;
    let vi = 0;
    let segs = 0;
    const N = AERO_FX.pointsPerTip;
    const life = AERO_FX.vortexLifeSec;

    for (const tr of tracks.values()) {
      for (let ti = 0; ti < 2; ti++) {
        const ring = tr.tips[ti];
        if (ring.count < 2) continue;
        const start = (ring.head - ring.count + N) % N;
        for (let k = 0; k < ring.count - 1; k++) {
          if (vi + 6 > maxVerts) break;
          const i0 = ((start + k) % N) * 9;
          const i1 = ((start + k + 1) % N) * 9;
          // Do not bridge across Separate high-G turns
          if (ring.data[i0 + 8] !== ring.data[i1 + 8]) continue;
          const age0 = ring.data[i0 + 6], age1 = ring.data[i1 + 6];
          if (age0 >= life || age1 >= life) continue;

          const u0 = 1 - age0 / life;
          const u1 = 1 - age1 / life;
          // Taper ends smoothly to zero so ribbons never clip with hard edges
          const endFade0 = k === 0 ? 0 : 1;
          const endFade1 = k === ring.count - 2 && !ring.wasActive ? 0 : 1;
          const a0 = 0.50 * ring.data[i0 + 7] * u0 * u0 * endFade0;
          const a1 = 0.50 * ring.data[i1 + 7] * u1 * u1 * endFade1;
          if (a0 < 0.004 && a1 < 0.004) continue;

          const w0 = 0.055 + 0.16 * (1 - u0);
          const w1 = 0.055 + 0.16 * (1 - u1);
          const x0 = ring.data[i0], y0 = ring.data[i0 + 1], z0 = ring.data[i0 + 2];
          const rx0 = ring.data[i0 + 3] * w0, ry0 = ring.data[i0 + 4] * w0, rz0 = ring.data[i0 + 5] * w0;
          const x1 = ring.data[i1], y1 = ring.data[i1 + 1], z1 = ring.data[i1 + 2];
          const rx1 = ring.data[i1 + 3] * w1, ry1 = ring.data[i1 + 4] * w1, rz1 = ring.data[i1 + 5] * w1;

          // Quad vertices: A(p0-r0), B(p0+r0), C(p1+r1), D(p1-r1)
          const ax = x0 - rx0, ay = y0 - ry0, az = z0 - rz0;
          const bx = x0 + rx0, by = y0 + ry0, bz = z0 + rz0;
          const cx = x1 + rx1, cy = y1 + ry1, cz = z1 + rz1;
          const dx = x1 - rx1, dy = y1 - ry1, dz = z1 - rz1;

          const pBase = vi * 3;
          posArr[pBase] = ax; posArr[pBase + 1] = ay; posArr[pBase + 2] = az;
          posArr[pBase + 3] = bx; posArr[pBase + 4] = by; posArr[pBase + 5] = bz;
          posArr[pBase + 6] = cx; posArr[pBase + 7] = cy; posArr[pBase + 8] = cz;
          posArr[pBase + 9] = ax; posArr[pBase + 10] = ay; posArr[pBase + 11] = az;
          posArr[pBase + 12] = cx; posArr[pBase + 13] = cy; posArr[pBase + 14] = cz;
          posArr[pBase + 15] = dx; posArr[pBase + 16] = dy; posArr[pBase + 17] = dz;

          const cBase = vi * 4;
          const alphas = [a0, a0, a1, a0, a1, a1];
          for (let q = 0; q < 6; q++) {
            colArr[cBase + q * 4] = 0.94;
            colArr[cBase + q * 4 + 1] = 0.97;
            colArr[cBase + q * 4 + 2] = 1.0;
            colArr[cBase + q * 4 + 3] = alphas[q];
          }
          vi += 6;
          segs++;
        }
      }
    }

    activeVortexSegments = segs;
    vortexGeom.setDrawRange(0, vi);
    vortexGeom.getAttribute("position").needsUpdate = true;
    vortexGeom.getAttribute("color").needsUpdate = true;
    vortexMesh.visible = vi > 0;
    vortexDirty = false;
  }

  /**
   * Update aerodynamic & propwash emitters for one vehicle.
   * @param {number} guid
   * @param {{x:number,y:number,z:number,heading?:number,pitch?:number,bank?:number,speed?:number,mode:number}} pose
   * @param {number[]} q AC orientation quaternion `[w, x, y, z]`
   * @param {{dt?:number, throttle?:number, boost?:boolean, gLoad?:number, agl?:number|null, inOcean?:boolean}} [opts]
   */
  function updateVehicle(guid, pose, q, opts = {}) {
    if (!pose || !ensure()) return;
    const dt = clamp(Number.isFinite(opts.dt) ? opts.dt : 1 / 60, 0, 0.25);
    const thr = Number.isFinite(opts.throttle) ? clamp(opts.throttle, 0, 1) : (pose.mode === MODE.PARKED ? 0 : 0.65);
    const speed = Number.isFinite(pose.speed) ? pose.speed : 0;
    const tr = trackFor(guid);

    rotateInto(tmpRight, q, 1, 0, 0);
    rotateInto(tmpFwd, q, 0, 1, 0);
    rotateInto(tmpUp, q, 0, 0, 1);
    // Ribbon cross-axis tilted ~35° between spanwise and dorsal so ribbons read from both chase and side views
    const rx = tmpRight[0] * 0.8 + tmpUp[0] * 0.6;
    const ry = tmpRight[1] * 0.8 + tmpUp[1] * 0.6;
    const rz = tmpRight[2] * 0.8 + tmpUp[2] * 0.6;

    // ---- 1. Wingtip Condensation Vortices ----
    const gLoad = Number.isFinite(opts.gLoad)
      ? opts.gLoad
      : (1 / Math.max(0.35, Math.cos(pose.bank || 0)));
    const vortexOn = pose.mode === MODE.FLIGHT && speed > AERO_FX.vortexMinSpeed && gLoad > AERO_FX.vortexMinG;
    if (vortexOn) {
      const strength = clamp(((gLoad - AERO_FX.vortexMinG) / 1.6) * 0.75 + 0.35, 0.25, 1.0)
        * clamp((speed - AERO_FX.vortexMinSpeed) / 28, 0.25, 1.0);
      for (let ti = 0; ti < 2; ti++) {
        const off = AERO_FX.vortexOffsets[ti];
        rotateInto(tmpTip, q, off[0], off[1], off[2]);
        if (pushTipPoint(tr.tips[ti], pose.x + tmpTip[0], pose.y + tmpTip[1], pose.z + tmpTip[2], rx, ry, rz, strength)) {
          counters.emittedVortex++;
        }
      }
      vortexDirty = true;
    } else {
      tr.tips[0].wasActive = false;
      tr.tips[1].wasActive = false;
    }

    // ---- 2. Radial Engine Startup Cough & WEP Soot Wisps ----
    const throttledFromPark = (tr.prevMode === MODE.PARKED && pose.mode === MODE.TAKEOFF)
      || (pose.mode === MODE.PARKED && tr.prevThrottle < 0.08 && thr >= 0.20);
    if (throttledFromPark) {
      tr.startupTimer = 0.85;
      tr.startupAcc = 0.08; // emit first cough puff immediately
    }
    tr.prevMode = pose.mode;
    tr.prevThrottle = thr;

    if (tr.startupTimer > 0) {
      tr.startupTimer = Math.max(0, tr.startupTimer - dt);
      tr.startupAcc += dt;
      while (tr.startupAcc >= 0.065) {
        tr.startupAcc -= 0.065;
        const sideIdx = (counters.emittedSmoke & 1);
        const off = AERO_FX.exhaustOffsets[sideIdx];
        rotateInto(tmpTip, q, off[0], off[1], off[2]);
        const sgn = sideIdx === 0 ? -1 : 1;
        const vx = -tmpFwd[0] * 7.5 + tmpRight[0] * sgn * (1.8 + rand01() * 1.4) + (rand01() - 0.5) * 1.5;
        const vy = -tmpFwd[1] * 7.5 + tmpRight[1] * sgn * (1.8 + rand01() * 1.4) + (rand01() - 0.5) * 1.5;
        const vz = -tmpFwd[2] * 7.5 + 1.4 + rand01() * 1.2;
        const col = (counters.emittedSmoke % 2 === 0) ? 0x6b6054 : 0x4f473e;
        spawnFromPool(smokePool, false, pose.x + tmpTip[0], pose.y + tmpTip[1], pose.z + tmpTip[2], vx, vy, vz, 0.75, 3.2, 0.44, 0.88, col, 2.2);
        counters.emittedSmoke++;
      }
    }

    if (opts.boost && pose.mode !== MODE.PARKED) {
      tr.wepAcc += dt;
      while (tr.wepAcc >= 0.055) {
        tr.wepAcc -= 0.055;
        const sideIdx = (counters.emittedWep & 1);
        const off = AERO_FX.exhaustOffsets[sideIdx];
        rotateInto(tmpTip, q, off[0], off[1], off[2]);
        const vx = -tmpFwd[0] * 12 + (rand01() - 0.5) * 1.6;
        const vy = -tmpFwd[1] * 12 + (rand01() - 0.5) * 1.6;
        const vz = -tmpFwd[2] * 12 + 0.6 + (rand01() - 0.5) * 1.0;
        spawnFromPool(smokePool, false, pose.x + tmpTip[0], pose.y + tmpTip[1], pose.z + tmpTip[2], vx, vy, vz, 0.55, 2.1, 0.22, 0.38, 0x2c2a28, 2.6);
        counters.emittedSmoke++;
        counters.emittedWep++;
      }
    }

    // ---- 3. Low-Altitude Propwash Dust & Ocean Spray ----
    let agl = opts.agl;
    if (agl === undefined && ground) {
      const gz = ground(pose.x, pose.y);
      agl = Number.isFinite(gz) ? pose.z - gz : null;
    }
    if (agl !== null && Number.isFinite(agl) && agl >= -2 && agl < AERO_FX.propwashMaxAgl && thr > AERO_FX.propwashMinThrottle) {
      const nearGround = 1 - clamp(agl, 0, AERO_FX.propwashMaxAgl) / AERO_FX.propwashMaxAgl;
      const thrFactor = clamp((thr - AERO_FX.propwashMinThrottle) / (1 - AERO_FX.propwashMinThrottle), 0.18, 1);
      const intensity = nearGround * thrFactor;
      const interval = 0.045 + 0.075 * (1 - intensity);
      tr.washAcc += dt;
      while (tr.washAcc >= interval) {
        tr.washAcc -= interval;
        const fhLen = Math.hypot(tmpFwd[0], tmpFwd[1]) || 1;
        const fhx = tmpFwd[0] / fhLen, fhy = tmpFwd[1] / fhLen;
        const rhx = fhy, rhy = -fhx;
        const backDist = 4.5 + rand01() * 6.5;
        const lat = (rand01() - 0.5) * 4.4;
        const wx = pose.x - fhx * backDist + rhx * lat;
        const wy = pose.y - fhy * backDist + rhy * lat;
        const wz = pose.z - Math.max(0, agl) + 0.45;
        const blast = 7 + 12 * thr;
        const vx = -fhx * blast + rhx * lat * 1.9;
        const vy = -fhy * blast + rhy * lat * 1.9;
        const inOcean = !!opts.inOcean;
        if (inOcean) {
          const vz = 1.8 + rand01() * 2.6;
          const col = (counters.emittedSpray & 1) ? 0xf0f7ff : 0xd9ecfa;
          spawnFromPool(washPool, true, wx, wy, wz, vx, vy, vz, 2.0, 9.2, 0.40 * intensity + 0.08, 1.05, col, 1.9);
          counters.emittedSpray++;
        } else {
          const vz = 1.4 + rand01() * 2.1;
          const col = (counters.emittedPropwash & 1) ? 0xb59b74 : 0x9c825c;
          spawnFromPool(washPool, true, wx, wy, wz, vx, vy, vz, 1.8, 8.6, 0.36 * intensity + 0.07, 1.22, col, 1.7);
        }
        counters.emittedPropwash++;
      }
    }

    if (vortexDirty) rebuildVortexGeometry();
  }

  function stepPool(pool, dt) {
    let liveCount = 0;
    for (let i = 0; i < pool.length; i++) {
      const p = pool[i];
      if (!p.active) continue;
      p.t += dt;
      if (p.t >= p.life) {
        p.active = false;
        p.sprite.visible = false;
        continue;
      }
      const damp = Math.exp(-p.drag * dt);
      p.vx *= damp;
      p.vy *= damp;
      p.vz *= Math.exp(-0.8 * dt);
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      const u = p.t / p.life;
      const ease = 1 - (1 - u) * (1 - u);
      p.sprite.position.set(p.x, p.y, p.z);
      p.sprite.scale.setScalar(p.s0 + (p.s1 - p.s0) * ease);
      const fadeIn = Math.min(1, u / 0.14);
      const fadeOut = (1 - u) * (1 - u);
      p.mat.opacity = p.op0 * fadeIn * fadeOut;
      p.sprite.visible = p.mat.opacity > 0.004;
      liveCount++;
    }
    return liveCount;
  }

  function tick(dt) {
    if (!root || disposed) return;
    const stepDt = clamp(Number.isFinite(dt) ? dt : 1 / 60, 0, 0.25);
    const N = AERO_FX.pointsPerTip;
    const life = AERO_FX.vortexLifeSec;

    // Age wingtip vortex ribbon samples
    let anyVortexPts = false;
    for (const tr of tracks.values()) {
      for (let ti = 0; ti < 2; ti++) {
        const ring = tr.tips[ti];
        if (ring.count === 0) continue;
        anyVortexPts = true;
        let expired = 0;
        const start = (ring.head - ring.count + N) % N;
        for (let k = 0; k < ring.count; k++) {
          const o = ((start + k) % N) * 9;
          ring.data[o + 6] += stepDt;
          if (k === expired && ring.data[o + 6] >= life) expired++;
        }
        ring.count -= expired;
      }
    }
    if (anyVortexPts || vortexDirty || activeVortexSegments > 0) {
      rebuildVortexGeometry();
    }

    stepPool(smokePool, stepDt);
    stepPool(washPool, stepDt);
  }

  function forgetVehicle(guid) {
    const g = guid >>> 0;
    const tr = tracks.get(g);
    if (!tr) return false;
    tracks.delete(g);
    tr.tips[0].count = 0; tr.tips[0].wasActive = false;
    tr.tips[1].count = 0; tr.tips[1].wasActive = false;
    if (freeTipPairs.length < AERO_FX.maxVortexVehicles) freeTipPairs.push(tr.tips);
    rebuildVortexGeometry();
    return true;
  }

  function stats() {
    let activeSmoke = 0, activePropwash = 0;
    for (let i = 0; i < smokePool.length; i++) if (smokePool[i].active) activeSmoke++;
    for (let i = 0; i < washPool.length; i++) if (washPool[i].active) activePropwash++;
    return {
      vehicles: tracks.size,
      activeVortexSegments,
      activeVortices: activeVortexSegments,
      activeSmoke,
      activePropwash,
      ...counters,
    };
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    tracks.clear();
    freeTipPairs.length = 0;
    activeVortexSegments = 0;
    if (root) {
      try { root.parent?.remove(root); } catch (_) { /* gone */ }
    }
    try { vortexGeom?.dispose(); } catch (_) { /* */ }
    try { vortexMat?.dispose(); } catch (_) { /* */ }
    for (const p of smokePool) { try { p.mat.dispose(); } catch (_) { /* */ } }
    for (const p of washPool) { try { p.mat.dispose(); } catch (_) { /* */ } }
    try { cloudTex?.dispose(); } catch (_) { /* */ }
    smokePool.length = 0;
    washPool.length = 0;
    root = null;
    vortexGeom = null;
    vortexMat = null;
    vortexMesh = null;
    cloudTex = null;
  }

  return {
    warm() { ensure(); },
    updateVehicle,
    tick,
    forgetVehicle,
    stats,
    dispose,
  };
}
