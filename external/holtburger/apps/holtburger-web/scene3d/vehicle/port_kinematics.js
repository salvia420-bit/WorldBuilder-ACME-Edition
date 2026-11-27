/**
 * Pure deterministic kinematic, anti-collision, routing, and ISO 9711 yard-stack
 * engine for the Marine Container Terminal:
 *   - Ship-to-Shore (STS) 5-DOF gantry crane kinematics & shared-rail interlock
 *   - Rail-Mounted (RMG) & Rubber-Tyred (RTG, 90° steering bogies) yard crane kinematics
 *   - Autonomous Terminal Tractor Shuttle kinematics, A* road routing & 2D reservation grid
 *   - ISO 9711 Container Yard stack store (parity + top-clear + structural support rules)
 *
 * 1:1 parity contract for future ACE C# promotion.
 * Imports ONLY `./port_specs.js`.
 */

import {
  PORT_ORIGIN,
  QUAY_SPECS,
  STS_CRANE_SPECS,
  YARD_CRANE_SPECS,
  YARD_BLOCK_SPECS,
  SHUTTLE_SPECS,
  PORT_LIVERY_KEYS,
  resolvePortContainerSpec,
  formatIso6346Bic,
  formatBrtCode,
  isEvenBay,
  yardOddPairForEvenBay,
  yardEvenBayForOddBay,
  validateYardPlacement,
  computeYardSlotWorldPose,
  quayRampZ,
  quayRampPitch,
} from "./port_specs.js";

const TAU = Math.PI * 2.0;

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function finiteOr(v, fb) {
  return Number.isFinite(v) ? v : fb;
}

export function wrapHeading(h) {
  if (!Number.isFinite(h)) return 0.0;
  let a = h % TAU;
  if (a < 0.0) a += TAU;
  if (a >= TAU) a -= TAU;
  return a;
}

export function wrapPi(a) {
  if (!Number.isFinite(a)) return 0.0;
  let d = a - TAU * Math.floor((a + Math.PI) / TAU);
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}

export function angleDiff(target, current) {
  return wrapPi(finiteOr(target, 0.0) - finiteOr(current, 0.0));
}

export function moveToward(cur, target, maxDelta) {
  if (!Number.isFinite(maxDelta) || maxDelta <= 0.0) return cur;
  const diff = target - cur;
  if (Math.abs(diff) <= maxDelta) return target;
  return cur + Math.sign(diff) * maxDelta;
}

// ---------------------------------------------------------------------------
// 1. Ship-to-Shore (STS) Gantry Crane Kinematics & Shared-Rail Interlock
// ---------------------------------------------------------------------------

export const STS_PHASE = Object.freeze({
  IDLE: "IDLE",
  DEPLOY_BOOM: "DEPLOY_BOOM",
  MOVE_TO_PICK: "MOVE_TO_PICK",
  LOWER_TO_PICK: "LOWER_TO_PICK",
  LOCK_TWISTLOCKS: "LOCK_TWISTLOCKS",
  HOIST_CLEAR: "HOIST_CLEAR",
  MOVE_TO_PLACE: "MOVE_TO_PLACE",
  LOWER_TO_PLACE: "LOWER_TO_PLACE",
  UNLOCK_TWISTLOCKS: "UNLOCK_TWISTLOCKS",
  HOIST_SAFE: "HOIST_SAFE",
  COMPLETE: "COMPLETE",
});

// Crane-local trolleyY limits relative to crane root at quayY + STS_CRANE_SPECS.railCenterLocalY (-14.5):
//   landside rail = -10.0, backreach tip = -26.0
//   waterside rail = +10.0, outreach tip = +38.0
export const STS_TROLLEY_MIN_Y = -(STS_CRANE_SPECS.railGaugeM * 0.5 + STS_CRANE_SPECS.backreachM); // -26.0
export const STS_TROLLEY_MAX_Y = +(STS_CRANE_SPECS.railGaugeM * 0.5 + STS_CRANE_SPECS.outreachM);  // +38.0
export const STS_TROLLEY_PARK_MAX_Y = 8.0; // must park trolley inside portal before stowing boom

export function createStsCraneState(opts = {}) {
  const origin = Array.isArray(opts.origin) ? opts.origin : PORT_ORIGIN;
  const ox = finiteOr(origin[0], PORT_ORIGIN[0]);
  const oy = finiteOr(origin[1], PORT_ORIGIN[1]);
  const oz = finiteOr(origin[2], PORT_ORIGIN[2]);

  const railMinX = finiteOr(opts.railMinX, ox + STS_CRANE_SPECS.railMinLocalX);
  const railMaxX = finiteOr(opts.railMaxX, ox + STS_CRANE_SPECS.railMaxLocalX);
  const x = clamp(finiteOr(opts.x, ox + finiteOr(opts.localX, -80.0)), railMinX, railMaxX);
  const y = finiteOr(opts.y, oy + STS_CRANE_SPECS.railCenterLocalY);
  const z = finiteOr(opts.z, oz + STS_CRANE_SPECS.railZ);
  const boomStowed = Boolean(opts.boomStowed);
  const boomAngle = boomStowed ? STS_CRANE_SPECS.boomStowedAngleRad : 0.0;
  const trolleyY = clamp(finiteOr(opts.trolleyY, 0.0), STS_TROLLEY_MIN_Y, boomStowed ? STS_TROLLEY_PARK_MAX_Y : STS_TROLLEY_MAX_Y);
  const spreaderZ = clamp(finiteOr(opts.spreaderZ, STS_CRANE_SPECS.spreaderSafeZ), STS_CRANE_SPECS.spreaderMinZ, STS_CRANE_SPECS.spreaderMaxZ);
  const spreaderLen = finiteOr(opts.spreaderLen, STS_CRANE_SPECS.spreaderLen40M);

  return {
    id: String(opts.id || "STS-1"),
    berthId: opts.berthId || null,
    x,
    y,
    z,
    railMinX,
    railMaxX,
    targetX: x,
    boomAngle,
    targetBoomAngle: boomAngle,
    boomStowed,
    trolleyY,
    targetTrolleyY: trolleyY,
    spreaderZ,
    targetSpreaderZ: spreaderZ,
    spreaderLen,
    targetSpreaderLen: spreaderLen,
    twistlockAngle: 0.0,
    targetTwistlockAngle: 0.0,
    twistlocksLocked: false,
    carriedContainer: null,
    phase: STS_PHASE.IDLE,
    gantryVel: 0.0,
    trolleyVel: 0.0,
    hoistVel: 0.0,
    active: false,
    spreaderWorldPos: [x, y + trolleyY, spreaderZ],
  };
}

/**
 * Convert world Y coordinate into STS crane-local trolleyY.
 */
export function worldYToStsTrolleyY(worldY, craneState) {
  return clamp(worldY - craneState.y, STS_TROLLEY_MIN_Y, STS_TROLLEY_MAX_Y);
}

/**
 * Enforce minimum shared-rail separation (`minSep = 26.0 m`) across all STS cranes.
 * Clamps both `targetX` and current `x` safely without ever reversing rail order.
 */
export function enforceStsRailAntiCollision(cranes, minSep = STS_CRANE_SPECS.minCraneSeparationM) {
  if (!Array.isArray(cranes) || cranes.length < 2) {
    return { clamped: false, minGapM: Infinity };
  }
  const sorted = [...cranes].sort((a, b) => a.x - b.x);
  let clamped = false;
  let minGapM = Infinity;

  // Forward pass on targets
  for (let i = 1; i < sorted.length; i++) {
    const left = sorted[i - 1];
    const right = sorted[i];
    if (right.targetX < left.targetX + minSep) {
      const mid = 0.5 * (left.targetX + right.targetX);
      const half = 0.5 * minSep;
      let newL = clamp(mid - half, left.railMinX, left.railMaxX - minSep);
      let newR = clamp(newL + minSep, right.railMinX + minSep, right.railMaxX);
      newL = clamp(newR - minSep, left.railMinX, left.railMaxX);
      left.targetX = newL;
      right.targetX = newR;
      clamped = true;
    }
    const gap = right.x - left.x;
    if (gap < minGapM) minGapM = gap;
  }

  // Hard separation guard on current positions
  for (let i = 1; i < sorted.length; i++) {
    const left = sorted[i - 1];
    const right = sorted[i];
    const gap = right.x - left.x;
    if (gap < minSep) {
      const push = 0.5 * (minSep - gap);
      left.x = clamp(left.x - push, left.railMinX, left.railMaxX);
      right.x = clamp(right.x + push, right.railMinX, right.railMaxX);
      if (right.x - left.x < minSep) {
        right.x = Math.min(right.railMaxX, left.x + minSep);
      }
      clamped = true;
    }
    const finalGap = right.x - left.x;
    if (finalGap < minGapM) minGapM = finalGap;
  }

  return { clamped, minGapM };
}

/**
 * Advance a single STS gantry crane by `dt` seconds with physical interlocks:
 *  - Trolley cannot move waterside beyond portal while boom is stowed (> 0.05 rad)
 *  - Boom cannot raise to stowed until trolley is parked inside portal, spreader >= 18 m, and unloaded
 */
export function stepStsCrane(state, cmd = null, dt = 1 / 30) {
  const stepDt = clamp(finiteOr(dt, 0.0), 0.0, 0.25);
  if (cmd && typeof cmd === "object") {
    if (Number.isFinite(cmd.targetX)) state.targetX = clamp(cmd.targetX, state.railMinX, state.railMaxX);
    if (Number.isFinite(cmd.targetTrolleyY)) state.targetTrolleyY = clamp(cmd.targetTrolleyY, STS_TROLLEY_MIN_Y, STS_TROLLEY_MAX_Y);
    if (Number.isFinite(cmd.targetSpreaderZ)) state.targetSpreaderZ = clamp(cmd.targetSpreaderZ, STS_CRANE_SPECS.spreaderMinZ, STS_CRANE_SPECS.spreaderMaxZ);
    if (Number.isFinite(cmd.targetSpreaderLen)) state.targetSpreaderLen = clamp(cmd.targetSpreaderLen, STS_CRANE_SPECS.spreaderLen20M, STS_CRANE_SPECS.spreaderLen40M);
    if (typeof cmd.boomStowed === "boolean") {
      state.boomStowed = cmd.boomStowed;
      state.targetBoomAngle = cmd.boomStowed ? STS_CRANE_SPECS.boomStowedAngleRad : 0.0;
    } else if (Number.isFinite(cmd.targetBoomAngle)) {
      state.targetBoomAngle = clamp(cmd.targetBoomAngle, 0.0, STS_CRANE_SPECS.boomStowedAngleRad);
      state.boomStowed = state.targetBoomAngle > 0.1;
    }
    if (typeof cmd.lockTwistlocks === "boolean") {
      state.targetTwistlockAngle = cmd.lockTwistlocks ? Math.PI * 0.5 : 0.0;
    }
  }

  const prevX = state.x;
  const prevTY = state.trolleyY;
  const prevSZ = state.spreaderZ;

  // Gantry travel along quay rails
  state.x = moveToward(state.x, clamp(state.targetX, state.railMinX, state.railMaxX), STS_CRANE_SPECS.gantrySpeedMps * stepDt);

  // Boom & trolley interlock
  const wantBoomUp = state.targetBoomAngle > 0.05;
  const trolleyLimitY = state.boomAngle > 0.05 ? STS_TROLLEY_PARK_MAX_Y : STS_TROLLEY_MAX_Y;
  const effTargetTrolleyY = wantBoomUp
    ? Math.min(state.targetTrolleyY, STS_TROLLEY_PARK_MAX_Y)
    : clamp(state.targetTrolleyY, STS_TROLLEY_MIN_Y, trolleyLimitY);

  state.trolleyY = moveToward(state.trolleyY, effTargetTrolleyY, STS_CRANE_SPECS.trolleySpeedMps * stepDt);

  const hoistRate = state.carriedContainer ? STS_CRANE_SPECS.hoistSpeedLoadedMps : STS_CRANE_SPECS.hoistSpeedEmptyMps;
  const effTargetSpreaderZ = wantBoomUp ? Math.max(state.targetSpreaderZ, 19.0) : state.targetSpreaderZ;
  state.spreaderZ = moveToward(state.spreaderZ, clamp(effTargetSpreaderZ, STS_CRANE_SPECS.spreaderMinZ, STS_CRANE_SPECS.spreaderMaxZ), hoistRate * stepDt);

  // Boom raises ONLY when unloaded, trolley parked inside portal, spreader safely hoisted
  const canRaiseBoom = !state.carriedContainer && state.trolleyY <= STS_TROLLEY_PARK_MAX_Y + 0.05 && state.spreaderZ >= 18.0;
  if (!wantBoomUp || canRaiseBoom) {
    state.boomAngle = moveToward(state.boomAngle, state.targetBoomAngle, STS_CRANE_SPECS.boomHoistRateRadSec * stepDt);
  }

  // Telescoping spreader only telescopes when unloaded & unlocked
  if (!state.carriedContainer && !state.twistlocksLocked) {
    state.spreaderLen = moveToward(state.spreaderLen, state.targetSpreaderLen, STS_CRANE_SPECS.telescopeSpeedMps * stepDt);
  }

  // Twistlocks 0 (unlocked) <-> PI/2 (locked)
  state.twistlockAngle = moveToward(state.twistlockAngle, state.targetTwistlockAngle, STS_CRANE_SPECS.twistlockRateRadSec * stepDt);
  state.twistlocksLocked = state.twistlockAngle >= Math.PI * 0.45;

  const invDt = stepDt > 1e-6 ? 1.0 / stepDt : 0.0;
  state.gantryVel = (state.x - prevX) * invDt;
  state.trolleyVel = (state.trolleyY - prevTY) * invDt;
  state.hoistVel = (state.spreaderZ - prevSZ) * invDt;
  state.active =
    Math.abs(state.gantryVel) > 1e-3 ||
    Math.abs(state.trolleyVel) > 1e-3 ||
    Math.abs(state.hoistVel) > 1e-3 ||
    state.phase !== STS_PHASE.IDLE;

  state.spreaderWorldPos[0] = state.x;
  state.spreaderWorldPos[1] = state.y + state.trolleyY;
  state.spreaderWorldPos[2] = state.spreaderZ;
  return state;
}

/**
 * Deterministic multi-phase STS container transfer cycle (ship <-> apron).
 * `job = { pickPos: [x,y,zTop], placePos: [x,y,zTop], container: { wcid, kind, sizeFt, ... }, safeZ? }`
 */
export function stepStsTransferCycle(state, job, dt = 1 / 30) {
  if (!job) {
    state.phase = STS_PHASE.IDLE;
    stepStsCrane(state, null, dt);
    return { done: true, phase: state.phase, pickedEvent: false, placedEvent: false };
  }

  const spec = resolvePortContainerSpec(job.container || "40ft");
  const wantLen = spec.sizeFt === 20 ? STS_CRANE_SPECS.spreaderLen20M : STS_CRANE_SPECS.spreaderLen40M;
  const safeZ = clamp(finiteOr(job.safeZ, STS_CRANE_SPECS.spreaderSafeZ), 12.0, STS_CRANE_SPECS.spreaderMaxZ);
  const pickX = clamp(job.pickPos[0], state.railMinX, state.railMaxX);
  const pickTY = worldYToStsTrolleyY(job.pickPos[1], state);
  const pickZ = clamp(job.pickPos[2], STS_CRANE_SPECS.spreaderMinZ, STS_CRANE_SPECS.spreaderMaxZ);
  const placeX = clamp(job.placePos[0], state.railMinX, state.railMaxX);
  const placeTY = worldYToStsTrolleyY(job.placePos[1], state);
  const placeZ = clamp(job.placePos[2], STS_CRANE_SPECS.spreaderMinZ, STS_CRANE_SPECS.spreaderMaxZ);

  if (state.phase === STS_PHASE.IDLE || state.phase === STS_PHASE.COMPLETE) {
    state.phase = state.boomAngle > 0.02 ? STS_PHASE.DEPLOY_BOOM : STS_PHASE.MOVE_TO_PICK;
  }

  let pickedEvent = false;
  let placedEvent = false;

  switch (state.phase) {
    case STS_PHASE.DEPLOY_BOOM:
      stepStsCrane(state, { boomStowed: false, targetSpreaderZ: safeZ }, dt);
      if (state.boomAngle <= 0.005) state.phase = STS_PHASE.MOVE_TO_PICK;
      break;

    case STS_PHASE.MOVE_TO_PICK:
      stepStsCrane(state, {
        boomStowed: false,
        targetX: pickX,
        targetTrolleyY: pickTY,
        targetSpreaderZ: safeZ,
        targetSpreaderLen: wantLen,
        lockTwistlocks: false,
      }, dt);
      if (
        Math.abs(state.x - pickX) <= 0.05 &&
        Math.abs(state.trolleyY - pickTY) <= 0.05 &&
        Math.abs(state.spreaderZ - safeZ) <= 0.15 &&
        Math.abs(state.spreaderLen - wantLen) <= 0.05
      ) {
        state.phase = STS_PHASE.LOWER_TO_PICK;
      }
      break;

    case STS_PHASE.LOWER_TO_PICK:
      stepStsCrane(state, { targetX: pickX, targetTrolleyY: pickTY, targetSpreaderZ: pickZ, lockTwistlocks: false }, dt);
      if (Math.abs(state.spreaderZ - pickZ) <= 0.04) state.phase = STS_PHASE.LOCK_TWISTLOCKS;
      break;

    case STS_PHASE.LOCK_TWISTLOCKS:
      stepStsCrane(state, { targetSpreaderZ: pickZ, lockTwistlocks: true }, dt);
      if (state.twistlocksLocked) {
        state.carriedContainer = { ...job.container, wcid: spec.wcid, kind: spec.kind, sizeFt: spec.sizeFt };
        pickedEvent = true;
        state.phase = STS_PHASE.HOIST_CLEAR;
      }
      break;

    case STS_PHASE.HOIST_CLEAR:
      stepStsCrane(state, { targetSpreaderZ: safeZ, lockTwistlocks: true }, dt);
      if (Math.abs(state.spreaderZ - safeZ) <= 0.08) state.phase = STS_PHASE.MOVE_TO_PLACE;
      break;

    case STS_PHASE.MOVE_TO_PLACE:
      stepStsCrane(state, { targetX: placeX, targetTrolleyY: placeTY, targetSpreaderZ: safeZ, lockTwistlocks: true }, dt);
      if (Math.abs(state.x - placeX) <= 0.05 && Math.abs(state.trolleyY - placeTY) <= 0.05) {
        state.phase = STS_PHASE.LOWER_TO_PLACE;
      }
      break;

    case STS_PHASE.LOWER_TO_PLACE:
      stepStsCrane(state, { targetX: placeX, targetTrolleyY: placeTY, targetSpreaderZ: placeZ, lockTwistlocks: true }, dt);
      if (Math.abs(state.spreaderZ - placeZ) <= 0.04) state.phase = STS_PHASE.UNLOCK_TWISTLOCKS;
      break;

    case STS_PHASE.UNLOCK_TWISTLOCKS:
      stepStsCrane(state, { targetSpreaderZ: placeZ, lockTwistlocks: false }, dt);
      if (state.twistlockAngle <= 0.05) {
        state.carriedContainer = null;
        placedEvent = true;
        state.phase = STS_PHASE.HOIST_SAFE;
      }
      break;

    case STS_PHASE.HOIST_SAFE:
      stepStsCrane(state, { targetSpreaderZ: safeZ, lockTwistlocks: false }, dt);
      if (Math.abs(state.spreaderZ - safeZ) <= 0.1) state.phase = STS_PHASE.COMPLETE;
      break;
  }

  return {
    done: state.phase === STS_PHASE.COMPLETE,
    phase: state.phase,
    pickedEvent,
    placedEvent,
  };
}

// ---------------------------------------------------------------------------
// 2. Yard Gantry Crane (RMG / RTG) Kinematics
// ---------------------------------------------------------------------------

export const YARD_CRANE_PHASE = Object.freeze({
  IDLE: "IDLE",
  MOVE_TO_PICK: "MOVE_TO_PICK",
  LOWER_TO_PICK: "LOWER_TO_PICK",
  LOCK_TWISTLOCKS: "LOCK_TWISTLOCKS",
  HOIST_CLEAR: "HOIST_CLEAR",
  MOVE_TO_PLACE: "MOVE_TO_PLACE",
  LOWER_TO_PLACE: "LOWER_TO_PLACE",
  UNLOCK_TWISTLOCKS: "UNLOCK_TWISTLOCKS",
  HOIST_SAFE: "HOIST_SAFE",
  COMPLETE: "COMPLETE",
});

export const YARD_TROLLEY_MIN_Y = -13.0;
export const YARD_TROLLEY_MAX_Y = +13.0;

export function createYardCraneState(opts = {}) {
  const type = String(opts.type || "RMG").toUpperCase() === "RTG" ? "RTG" : "RMG";
  const minX = finiteOr(opts.minX, PORT_ORIGIN[0] - 168.0);
  const maxX = finiteOr(opts.maxX, PORT_ORIGIN[0] - 12.0);
  const x = clamp(finiteOr(opts.x, 0.5 * (minX + maxX)), minX, maxX);
  const y = finiteOr(opts.y, PORT_ORIGIN[1] - 99.0);
  const z = finiteOr(opts.z, PORT_ORIGIN[2]);
  const trolleyY = clamp(finiteOr(opts.trolleyY, 0.0), YARD_TROLLEY_MIN_Y, YARD_TROLLEY_MAX_Y);
  const spreaderZ = clamp(finiteOr(opts.spreaderZ, YARD_CRANE_SPECS.spreaderSafeZ), YARD_CRANE_SPECS.spreaderMinZ, YARD_CRANE_SPECS.spreaderMaxZ);

  return {
    id: String(opts.id || (type === "RTG" ? "RTG-1" : "RMG-1")),
    type,
    blockIds: Array.isArray(opts.blockIds) ? [...opts.blockIds] : ["A1"],
    x,
    y,
    z,
    minX,
    maxX,
    targetX: x,
    targetY: y,
    trolleyY,
    targetTrolleyY: trolleyY,
    spreaderZ,
    targetSpreaderZ: spreaderZ,
    spreaderLen: STS_CRANE_SPECS.spreaderLen40M,
    targetSpreaderLen: STS_CRANE_SPECS.spreaderLen40M,
    twistlockAngle: 0.0,
    targetTwistlockAngle: 0.0,
    twistlocksLocked: false,
    wheelSteerRad: 0.0,
    targetWheelSteerRad: 0.0,
    wheelSpinRad: 0.0,
    carriedContainer: null,
    phase: YARD_CRANE_PHASE.IDLE,
    gantryVel: 0.0,
    active: false,
    spreaderWorldPos: [x, y + trolleyY, spreaderZ],
  };
}

export function enforceYardCraneSeparation(cranes, minSep = YARD_CRANE_SPECS.minCraneSeparationM) {
  if (!Array.isArray(cranes) || cranes.length < 2) return { clamped: false, minGapM: Infinity };
  // Group cranes sharing a runway (within 2 m in Y)
  let clamped = false;
  let minGapM = Infinity;
  const groups = [];
  for (const c of cranes) {
    let g = groups.find((arr) => Math.abs(arr[0].y - c.y) < 2.0);
    if (!g) { g = []; groups.push(g); }
    g.push(c);
  }
  for (const g of groups) {
    if (g.length < 2) continue;
    g.sort((a, b) => a.x - b.x);
    for (let i = 1; i < g.length; i++) {
      const l = g[i - 1];
      const r = g[i];
      if (r.targetX < l.targetX + minSep) {
        const mid = 0.5 * (l.targetX + r.targetX);
        l.targetX = clamp(mid - 0.5 * minSep, l.minX, l.maxX);
        r.targetX = clamp(l.targetX + minSep, r.minX, r.maxX);
        clamped = true;
      }
      const gap = r.x - l.x;
      if (gap < minSep) {
        const push = 0.5 * (minSep - gap);
        l.x = clamp(l.x - push, l.minX, l.maxX);
        r.x = clamp(r.x + push, r.minX, r.maxX);
        clamped = true;
      }
      if (r.x - l.x < minGapM) minGapM = r.x - l.x;
    }
  }
  return { clamped, minGapM };
}

export function stepYardCrane(state, cmd = null, dt = 1 / 30) {
  const stepDt = clamp(finiteOr(dt, 0.0), 0.0, 0.25);
  if (cmd && typeof cmd === "object") {
    if (Number.isFinite(cmd.targetX)) state.targetX = clamp(cmd.targetX, state.minX, state.maxX);
    if (Number.isFinite(cmd.targetY) && state.type === "RTG") state.targetY = cmd.targetY;
    if (Number.isFinite(cmd.targetTrolleyY)) state.targetTrolleyY = clamp(cmd.targetTrolleyY, YARD_TROLLEY_MIN_Y, YARD_TROLLEY_MAX_Y);
    if (Number.isFinite(cmd.targetSpreaderZ)) state.targetSpreaderZ = clamp(cmd.targetSpreaderZ, YARD_CRANE_SPECS.spreaderMinZ, YARD_CRANE_SPECS.spreaderMaxZ);
    if (Number.isFinite(cmd.targetSpreaderLen)) state.targetSpreaderLen = clamp(cmd.targetSpreaderLen, STS_CRANE_SPECS.spreaderLen20M, STS_CRANE_SPECS.spreaderLen40M);
    if (typeof cmd.lockTwistlocks === "boolean") state.targetTwistlockAngle = cmd.lockTwistlocks ? Math.PI * 0.5 : 0.0;
    if (Number.isFinite(cmd.targetWheelSteerRad) && state.type === "RTG") {
      state.targetWheelSteerRad = clamp(cmd.targetWheelSteerRad, 0.0, YARD_CRANE_SPECS.rtgWheelSteerMaxRad);
    }
  }

  const prevX = state.x;
  const prevY = state.y;

  // RTG 90° lateral crabbing interlock: wheels must align to 90° to shift Y, 0° to travel X
  if (state.type === "RTG" && Math.abs(state.targetY - state.y) > 0.05) {
    state.targetWheelSteerRad = YARD_CRANE_SPECS.rtgWheelSteerMaxRad;
    state.wheelSteerRad = moveToward(state.wheelSteerRad, state.targetWheelSteerRad, YARD_CRANE_SPECS.rtgWheelSteerRateRadSec * stepDt);
    if (Math.abs(state.wheelSteerRad - YARD_CRANE_SPECS.rtgWheelSteerMaxRad) <= 0.05) {
      state.y = moveToward(state.y, state.targetY, YARD_CRANE_SPECS.gantrySpeedMps * 0.5 * stepDt);
    }
  } else {
    if (state.type === "RTG") {
      state.targetWheelSteerRad = 0.0;
      state.wheelSteerRad = moveToward(state.wheelSteerRad, 0.0, YARD_CRANE_SPECS.rtgWheelSteerRateRadSec * stepDt);
    }
    if (state.type === "RMG" || state.wheelSteerRad <= 0.05) {
      state.x = moveToward(state.x, clamp(state.targetX, state.minX, state.maxX), YARD_CRANE_SPECS.gantrySpeedMps * stepDt);
    }
  }

  const travelDist = Math.hypot(state.x - prevX, state.y - prevY);
  state.wheelSpinRad = (state.wheelSpinRad + travelDist / 0.85) % TAU;

  state.trolleyY = moveToward(state.trolleyY, clamp(state.targetTrolleyY, YARD_TROLLEY_MIN_Y, YARD_TROLLEY_MAX_Y), YARD_CRANE_SPECS.trolleySpeedMps * stepDt);
  state.spreaderZ = moveToward(state.spreaderZ, clamp(state.targetSpreaderZ, YARD_CRANE_SPECS.spreaderMinZ, YARD_CRANE_SPECS.spreaderMaxZ), YARD_CRANE_SPECS.hoistSpeedMps * stepDt);

  if (!state.carriedContainer && !state.twistlocksLocked) {
    state.spreaderLen = moveToward(state.spreaderLen, state.targetSpreaderLen, YARD_CRANE_SPECS.telescopeSpeedMps * stepDt);
  }

  state.twistlockAngle = moveToward(state.twistlockAngle, state.targetTwistlockAngle, YARD_CRANE_SPECS.twistlockRateRadSec * stepDt);
  state.twistlocksLocked = state.twistlockAngle >= Math.PI * 0.45;

  const invDt = stepDt > 1e-6 ? 1.0 / stepDt : 0.0;
  state.gantryVel = (state.x - prevX) * invDt;
  state.active = travelDist > 1e-4 || state.phase !== YARD_CRANE_PHASE.IDLE;
  state.spreaderWorldPos[0] = state.x;
  state.spreaderWorldPos[1] = state.y + state.trolleyY;
  state.spreaderWorldPos[2] = state.spreaderZ;
  return state;
}

export function stepYardTransferCycle(state, job, dt = 1 / 30) {
  if (!job) {
    state.phase = YARD_CRANE_PHASE.IDLE;
    stepYardCrane(state, null, dt);
    return { done: true, phase: state.phase, pickedEvent: false, placedEvent: false };
  }
  const spec = resolvePortContainerSpec(job.container || "40ft");
  const wantLen = spec.sizeFt === 20 ? STS_CRANE_SPECS.spreaderLen20M : STS_CRANE_SPECS.spreaderLen40M;
  const safeZ = clamp(finiteOr(job.safeZ, YARD_CRANE_SPECS.spreaderSafeZ), 8.0, YARD_CRANE_SPECS.spreaderMaxZ);
  const pickX = clamp(job.pickPos[0], state.minX, state.maxX);
  const pickTY = clamp(job.pickPos[1] - state.y, YARD_TROLLEY_MIN_Y, YARD_TROLLEY_MAX_Y);
  const pickZ = clamp(job.pickPos[2], YARD_CRANE_SPECS.spreaderMinZ, YARD_CRANE_SPECS.spreaderMaxZ);
  const placeX = clamp(job.placePos[0], state.minX, state.maxX);
  const placeTY = clamp(job.placePos[1] - state.y, YARD_TROLLEY_MIN_Y, YARD_TROLLEY_MAX_Y);
  const placeZ = clamp(job.placePos[2], YARD_CRANE_SPECS.spreaderMinZ, YARD_CRANE_SPECS.spreaderMaxZ);

  if (state.phase === YARD_CRANE_PHASE.IDLE || state.phase === YARD_CRANE_PHASE.COMPLETE) {
    state.phase = YARD_CRANE_PHASE.MOVE_TO_PICK;
  }

  let pickedEvent = false;
  let placedEvent = false;

  switch (state.phase) {
    case YARD_CRANE_PHASE.MOVE_TO_PICK:
      stepYardCrane(state, { targetX: pickX, targetTrolleyY: pickTY, targetSpreaderZ: safeZ, targetSpreaderLen: wantLen, lockTwistlocks: false }, dt);
      if (Math.abs(state.x - pickX) <= 0.05 && Math.abs(state.trolleyY - pickTY) <= 0.05 && Math.abs(state.spreaderZ - safeZ) <= 0.12 && Math.abs(state.spreaderLen - wantLen) <= 0.05) {
        state.phase = YARD_CRANE_PHASE.LOWER_TO_PICK;
      }
      break;
    case YARD_CRANE_PHASE.LOWER_TO_PICK:
      stepYardCrane(state, { targetX: pickX, targetTrolleyY: pickTY, targetSpreaderZ: pickZ, lockTwistlocks: false }, dt);
      if (Math.abs(state.spreaderZ - pickZ) <= 0.04) state.phase = YARD_CRANE_PHASE.LOCK_TWISTLOCKS;
      break;
    case YARD_CRANE_PHASE.LOCK_TWISTLOCKS:
      stepYardCrane(state, { targetSpreaderZ: pickZ, lockTwistlocks: true }, dt);
      if (state.twistlocksLocked) {
        state.carriedContainer = { ...job.container, wcid: spec.wcid, kind: spec.kind, sizeFt: spec.sizeFt };
        pickedEvent = true;
        state.phase = YARD_CRANE_PHASE.HOIST_CLEAR;
      }
      break;
    case YARD_CRANE_PHASE.HOIST_CLEAR:
      stepYardCrane(state, { targetSpreaderZ: safeZ, lockTwistlocks: true }, dt);
      if (Math.abs(state.spreaderZ - safeZ) <= 0.08) state.phase = YARD_CRANE_PHASE.MOVE_TO_PLACE;
      break;
    case YARD_CRANE_PHASE.MOVE_TO_PLACE:
      stepYardCrane(state, { targetX: placeX, targetTrolleyY: placeTY, targetSpreaderZ: safeZ, lockTwistlocks: true }, dt);
      if (Math.abs(state.x - placeX) <= 0.05 && Math.abs(state.trolleyY - placeTY) <= 0.05) {
        state.phase = YARD_CRANE_PHASE.LOWER_TO_PLACE;
      }
      break;
    case YARD_CRANE_PHASE.LOWER_TO_PLACE:
      stepYardCrane(state, { targetX: placeX, targetTrolleyY: placeTY, targetSpreaderZ: placeZ, lockTwistlocks: true }, dt);
      if (Math.abs(state.spreaderZ - placeZ) <= 0.04) state.phase = YARD_CRANE_PHASE.UNLOCK_TWISTLOCKS;
      break;
    case YARD_CRANE_PHASE.UNLOCK_TWISTLOCKS:
      stepYardCrane(state, { targetSpreaderZ: placeZ, lockTwistlocks: false }, dt);
      if (state.twistlockAngle <= 0.05) {
        state.carriedContainer = null;
        placedEvent = true;
        state.phase = YARD_CRANE_PHASE.HOIST_SAFE;
      }
      break;
    case YARD_CRANE_PHASE.HOIST_SAFE:
      stepYardCrane(state, { targetSpreaderZ: safeZ, lockTwistlocks: false }, dt);
      if (Math.abs(state.spreaderZ - safeZ) <= 0.1) state.phase = YARD_CRANE_PHASE.COMPLETE;
      break;
  }

  return { done: state.phase === YARD_CRANE_PHASE.COMPLETE, phase: state.phase, pickedEvent, placedEvent };
}

// ---------------------------------------------------------------------------
// 3. Terminal Tractor Shuttle Kinematics, A* Road Routing & 2D Reservation
// ---------------------------------------------------------------------------

export function findRoadPath(graph, startId, goalId) {
  if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) return [];
  const nodeById = new Map();
  const adj = new Map();
  for (const n of graph.nodes) {
    nodeById.set(n.id, n);
    adj.set(n.id, []);
  }
  if (!nodeById.has(startId) || !nodeById.has(goalId)) return [];
  if (startId === goalId) {
    const n = nodeById.get(startId);
    return [{ id: n.id, x: n.x, y: n.y, z: n.z }];
  }
  for (const e of graph.edges) {
    if (adj.has(e.from) && adj.has(e.to)) {
      adj.get(e.from).push({ to: e.to, cost: e.lengthM });
      adj.get(e.to).push({ to: e.from, cost: e.lengthM });
    }
  }

  const goal = nodeById.get(goalId);
  const open = new Set([startId]);
  const cameFrom = new Map();
  const gScore = new Map([[startId, 0.0]]);
  const fScore = new Map([[startId, Math.hypot(goal.x - nodeById.get(startId).x, goal.y - nodeById.get(startId).y)]]);

  while (open.size > 0) {
    let cur = null;
    let bestF = Infinity;
    for (const id of open) {
      const f = fScore.get(id) ?? Infinity;
      if (f < bestF) { bestF = f; cur = id; }
    }
    if (cur === goalId) {
      const path = [];
      let k = cur;
      while (k) {
        const n = nodeById.get(k);
        path.push({ id: n.id, x: n.x, y: n.y, z: n.z });
        k = cameFrom.get(k);
      }
      path.reverse();
      return path;
    }
    open.delete(cur);
    const curG = gScore.get(cur) ?? Infinity;
    for (const nb of adj.get(cur)) {
      const tent = curG + nb.cost;
      if (tent < (gScore.get(nb.to) ?? Infinity)) {
        cameFrom.set(nb.to, cur);
        gScore.set(nb.to, tent);
        const nbNode = nodeById.get(nb.to);
        fScore.set(nb.to, tent + Math.hypot(goal.x - nbNode.x, goal.y - nbNode.y));
        open.add(nb.to);
      }
    }
  }
  return [];
}

export class PortReservationGrid {
  constructor(opts = {}) {
    this.stopDistM = finiteOr(opts.stopDistM, SHUTTLE_SPECS.stopDistM);
    this.slowDistM = finiteOr(opts.slowDistM, SHUTTLE_SPECS.slowDistM);
    this.agents = new Map();
  }

  updateAgent(id, x, y, heading = 0.0, speed = 0.0) {
    this.agents.set(id, { id, x, y, heading, speed });
  }

  removeAgent(id) {
    this.agents.delete(id);
  }

  clear() {
    this.agents.clear();
  }

  /**
   * Returns a speed multiplier in [0, 1] for agent `id` checking agents ahead within its forward cone.
   */
  speedFactorFor(id, x, y, heading) {
    const fx = Math.sin(heading);
    const fy = Math.cos(heading);
    let minFactor = 1.0;
    for (const [oid, o] of this.agents.entries()) {
      if (oid === id) continue;
      const dx = o.x - x;
      const dy = o.y - y;
      const dist = Math.hypot(dx, dy);
      if (dist < 1e-4) return 0.0;
      if (dist > this.slowDistM) continue;
      const fwdDot = (dx * fx + dy * fy) / dist;
      if (fwdDot < 0.35) continue; // not ahead
      if (dist <= this.stopDistM) return 0.0;
      const f = clamp((dist - this.stopDistM) / Math.max(0.5, this.slowDistM - this.stopDistM), 0.0, 1.0);
      if (f < minFactor) minFactor = f;
    }
    return minFactor;
  }
}

export function createShuttleState(opts = {}) {
  const origin = Array.isArray(opts.origin) ? opts.origin : PORT_ORIGIN;
  const x = finiteOr(opts.x, origin[0]);
  const y = finiteOr(opts.y, origin[1] - 127.0);
  const heading = wrapHeading(finiteOr(opts.heading, Math.PI * 0.5));
  const z = quayRampZ(y, origin);
  const pitch = quayRampPitch(y, heading, origin);
  return {
    id: String(opts.id || "TT-1"),
    x,
    y,
    z,
    heading,
    pitch,
    speed: 0.0,
    steerAngle: 0.0,
    wheelSpin: 0.0,
    cargo: opts.cargo || null,
    status: "IDLE",
    origin: [origin[0], origin[1], origin[2]],
  };
}

/**
 * Advance a Terminal Tractor Shuttle along a waypoint polyline with smooth ramp Z/pitch
 * and optional PortReservationGrid traffic yielding.
 */
export function stepShuttle(state, waypoints, dt = 1 / 30, opts = {}) {
  const stepDt = clamp(finiteOr(dt, 0.0), 0.0, 0.25);
  const origin = opts.origin || state.origin || PORT_ORIGIN;
  const grid = opts.reservationGrid || null;

  if (!Array.isArray(waypoints) || waypoints.length === 0) {
    state.speed = moveToward(state.speed, 0.0, SHUTTLE_SPECS.decelMps2 * stepDt);
    state.steerAngle = moveToward(state.steerAngle, 0.0, 2.5 * stepDt);
    state.z = quayRampZ(state.y, origin);
    state.pitch = quayRampPitch(state.y, state.heading, origin);
    state.status = "IDLE";
    if (grid) grid.updateAgent(state.id, state.x, state.y, state.heading, state.speed);
    return { arrived: true, waypointIndex: 0 };
  }

  let idx = Number.isInteger(opts.waypointIndex) ? clamp(opts.waypointIndex, 0, waypoints.length - 1) : 0;
  let target = waypoints[idx];
  let dx = target.x - state.x;
  let dy = target.y - state.y;
  let dist = Math.hypot(dx, dy);

  const tol = idx === waypoints.length - 1 ? finiteOr(opts.goalTolM, 0.6) : 2.5;
  while (dist <= tol && idx < waypoints.length - 1) {
    idx++;
    target = waypoints[idx];
    dx = target.x - state.x;
    dy = target.y - state.y;
    dist = Math.hypot(dx, dy);
  }

  if (idx === waypoints.length - 1 && dist <= finiteOr(opts.goalTolM, 0.6)) {
    state.x = target.x;
    state.y = target.y;
    state.speed = 0.0;
    state.steerAngle = 0.0;
    if (Number.isFinite(opts.finalHeading)) {
      state.heading = wrapHeading(state.heading + clamp(angleDiff(opts.finalHeading, state.heading), -2.0 * stepDt, 2.0 * stepDt));
    }
    state.z = quayRampZ(state.y, origin);
    state.pitch = quayRampPitch(state.y, state.heading, origin);
    state.status = "ARRIVED";
    if (grid) grid.updateAgent(state.id, state.x, state.y, state.heading, 0.0);
    return { arrived: true, waypointIndex: idx };
  }

  const desiredHeading = wrapHeading(Math.atan2(dx, dy));
  const hErr = angleDiff(desiredHeading, state.heading);
  const steerCmd = clamp(hErr * 1.4, -SHUTTLE_SPECS.maxSteerRad, SHUTTLE_SPECS.maxSteerRad);
  state.steerAngle = moveToward(state.steerAngle, steerCmd, 3.0 * stepDt);

  const onRamp = Math.abs(quayRampPitch(state.y, state.heading, origin)) > 0.01;
  let vMax = state.cargo ? SHUTTLE_SPECS.vMaxLoadedMps : SHUTTLE_SPECS.vMaxEmptyMps;
  if (onRamp) vMax = Math.min(vMax, SHUTTLE_SPECS.vRampMps);
  if (idx === waypoints.length - 1 && dist < 10.0) {
    vMax = Math.min(vMax, Math.max(SHUTTLE_SPECS.vDockingMps, dist * 0.5));
  }
  if (Math.abs(hErr) > 0.65) {
    vMax = Math.min(vMax, 2.4);
  }
  if (grid) {
    const sf = grid.speedFactorFor(state.id, state.x, state.y, state.heading);
    vMax *= sf;
  }

  const rate = vMax >= state.speed ? SHUTTLE_SPECS.accelMps2 : SHUTTLE_SPECS.decelMps2;
  state.speed = moveToward(state.speed, vMax, rate * stepDt);

  // Turn rate: bicycle kinematics + low-speed pivot assist for tight yard corners
  const yawRate = (state.speed / SHUTTLE_SPECS.wheelbaseM) * Math.tan(state.steerAngle);
  const clampedYaw = clamp(yawRate, -1.6, 1.6);
  state.heading = wrapHeading(state.heading + clampedYaw * stepDt);
  // Prevent overshoot on tight corners when nearly aligned
  const stepDist = Math.min(dist, state.speed * stepDt);
  state.x += Math.sin(state.heading) * stepDist;
  state.y += Math.cos(state.heading) * stepDist;
  state.wheelSpin = (state.wheelSpin + stepDist / SHUTTLE_SPECS.wheelRadiusM) % TAU;
  state.z = quayRampZ(state.y, origin);
  state.pitch = quayRampPitch(state.y, state.heading, origin);
  state.status = state.speed < 0.05 && vMax < 0.05 ? "YIELDING" : "TRANSIT";

  if (grid) grid.updateAgent(state.id, state.x, state.y, state.heading, state.speed);
  return { arrived: false, waypointIndex: idx };
}

// ---------------------------------------------------------------------------
// 4. Pure ISO 9711 Container Yard Stack Store
// ---------------------------------------------------------------------------

export function createYardStackStore(origin = PORT_ORIGIN) {
  const ox = finiteOr(origin[0], PORT_ORIGIN[0]);
  const oy = finiteOr(origin[1], PORT_ORIGIN[1]);
  const oz = finiteOr(origin[2], PORT_ORIGIN[2]);
  const storeOrigin = [ox, oy, oz];
  const entries = new Map(); // key = `${blockId}:${brt}` -> entry
  let nextSerial = 200001;

  function keyOf(blockId, bay, row, tier) {
    return `${blockId}:${formatBrtCode(bay, row, tier)}`;
  }

  function stackLookup(blockId) {
    return (bay, row, tier) => entries.get(keyOf(blockId, bay, row, tier)) ?? null;
  }

  function hasContainerAbove(blockId, bay, row, tier) {
    const block = YARD_BLOCK_SPECS[blockId];
    if (!block || tier >= block.maxTiers) return false;
    const aboveT = tier + 1;
    if (entries.has(keyOf(blockId, bay, row, aboveT))) return true;
    if (isEvenBay(bay)) {
      const [oW, oE] = yardOddPairForEvenBay(bay);
      return entries.has(keyOf(blockId, oW, row, aboveT)) || entries.has(keyOf(blockId, oE, row, aboveT));
    }
    const parentEven = yardEvenBayForOddBay(bay);
    return entries.has(keyOf(blockId, parentEven, row, aboveT));
  }

  function place(blockId, bay, row, tier, containerMeta = {}) {
    const kindOrWcid = containerMeta.wcid ?? containerMeta.kind ?? containerMeta.containerKind ?? (isEvenBay(bay) ? "40ft" : "20ft");
    const check = validateYardPlacement(blockId, bay, row, tier, kindOrWcid, entries);
    if (!check.ok) return { ok: false, reason: check.reason, entry: null };

    const pose = computeYardSlotWorldPose(blockId, bay, row, tier, check.spec.wcid, stackLookup(blockId), storeOrigin);
    const liveryId = Number.isInteger(containerMeta.liveryId)
      ? ((containerMeta.liveryId % PORT_LIVERY_KEYS.length) + PORT_LIVERY_KEYS.length) % PORT_LIVERY_KEYS.length
      : (nextSerial % PORT_LIVERY_KEYS.length);
    const bic = containerMeta.bic || formatIso6346Bic(nextSerial++);
    const key = keyOf(blockId, bay, row, tier);

    const entry = {
      key,
      id: containerMeta.id || key,
      blockId,
      bay,
      row,
      tier,
      brt: pose.brt,
      wcid: check.spec.wcid,
      kind: check.spec.kind,
      sizeFt: check.spec.sizeFt,
      teu: check.spec.teu,
      extW: check.spec.extW,
      extL: check.spec.extL,
      extH: check.spec.extH,
      x: pose.x,
      y: pose.y,
      z: pose.z,
      topZ: pose.z + check.spec.extH,
      heading: pose.heading,
      liveryId,
      bic,
      reefer: Boolean(containerMeta.reefer ?? YARD_BLOCK_SPECS[blockId]?.reefer),
      slots: Array.isArray(containerMeta.slots) ? containerMeta.slots : [],
    };
    entries.set(key, entry);
    return { ok: true, entry, reason: null };
  }

  function remove(blockId, bay, row, tier) {
    const key = keyOf(blockId, bay, row, tier);
    const entry = entries.get(key);
    if (!entry) return { ok: false, reason: `Empty slot ${key}`, entry: null };
    if (hasContainerAbove(blockId, bay, row, tier)) {
      return { ok: false, reason: `Cannot remove ${key}: container stacked above on tier ${tier + 1}`, entry: null };
    }
    entries.delete(key);
    return { ok: true, entry, reason: null };
  }

  function get(blockId, bay, row, tier) {
    return entries.get(keyOf(blockId, bay, row, tier)) ?? null;
  }

  function findFreeSlot(blockId, containerKindOrWcid = "40ft", opts = {}) {
    const block = YARD_BLOCK_SPECS[blockId];
    if (!block) return null;
    const spec = resolvePortContainerSpec(containerKindOrWcid);
    const is20 = spec.sizeFt === 20;
    const maxTier = clamp(finiteOr(opts.maxTier, block.maxTiers), 1, block.maxTiers);

    for (let tier = 1; tier <= maxTier; tier++) {
      for (let row = 1; row <= block.rowCount; row++) {
        for (let k = 0; k < block.evenBayCount; k++) {
          const bays = is20 ? [4 * k + 1, 4 * k + 3] : [(k + 1) * 2];
          for (const bay of bays) {
            const v = validateYardPlacement(blockId, bay, row, tier, spec.wcid, entries);
            if (v.ok) {
              const pose = computeYardSlotWorldPose(blockId, bay, row, tier, spec.wcid, stackLookup(blockId), storeOrigin);
              return { blockId, bay, row, tier, brt: v.brt, pose };
            }
          }
        }
      }
    }
    return null;
  }

  function findTopContainer(blockId = null, filterFn = null) {
    let best = null;
    for (const e of entries.values()) {
      if (blockId && e.blockId !== blockId) continue;
      if (hasContainerAbove(e.blockId, e.bay, e.row, e.tier)) continue;
      if (typeof filterFn === "function" && !filterFn(e)) continue;
      if (!best || e.tier > best.tier) best = e;
    }
    return best;
  }

  function list(blockId = null) {
    const out = [];
    for (const e of entries.values()) {
      if (!blockId || e.blockId === blockId) out.push(e);
    }
    return out;
  }

  function clear() {
    entries.clear();
  }

  return {
    place,
    remove,
    get,
    hasContainerAbove,
    findFreeSlot,
    findTopContainer,
    list,
    clear,
    count: () => entries.size,
    entries,
  };
}
