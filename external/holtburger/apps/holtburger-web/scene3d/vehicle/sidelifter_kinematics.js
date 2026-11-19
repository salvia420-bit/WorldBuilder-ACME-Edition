/**
 * Pure deterministic ISO 3874 / ISO 1161 sidelifter trailer kinematics (HBV1 v7).
 *
 * 1:1 parity twin of ACE `SidelifterKinematics.cs`.
 * Zero external, DOM, or Three.js dependencies.
 *
 * Coordinate convention (AC vehicle local frame):
 *   +X = right (curbside)
 *   +Y = forward (kingpin)
 *   +Z = up
 */

export const SIDELIFTER_OUTREACH_X = 3.85;
export const OUTRIGGER_REACH_X = 3.60;
export const HOIST_CLEARANCE_Z = 0.45;
export const SWING_ARC_CROWN_Z = 0.25;
export const MAX_SLOPE_COS = 0.9945; // cos(6.0 deg) ISO 3874 cross-slope ceiling
export const CHASSIS_DECK_Z = 1.32;
export const CRANE_SPAN_Y_20FT = 2.9265; // half of 5.853m ISO 1161 20ft corner-casting span
export const CRANE_SPAN_Y_40FT = 5.9925; // half of 11.985m ISO 1161 40ft/40HC span

export const SIDELIFT_PHASE = Object.freeze({
  Idle: 0,
  OutriggersDeploying: 1,
  OutriggersPlanted: 2,
  CranesPositioning: 3,
  CranesLatched: 4,
  Hoisting: 5,
  Swinging: 6,
  Lowering: 7,
  Releasing: 8,
  CranesStowing: 9,
  OutriggersRetracting: 10,
});

export const SIDELIFT_PHASE_NAMES = Object.freeze([
  "Idle",
  "OutriggersDeploying",
  "OutriggersPlanted",
  "CranesPositioning",
  "CranesLatched",
  "Hoisting",
  "Swinging",
  "Lowering",
  "Releasing",
  "CranesStowing",
  "OutriggersRetracting",
]);

export const SIDELIFT_PHASE_DURATIONS = Object.freeze({
  Idle: 0.0,
  OutriggersDeploying: 2.2,
  OutriggersPlanted: 0.0,
  CranesPositioning: 1.5,
  CranesLatched: 0.8,
  Hoisting: 1.8,
  Swinging: 3.0,
  Lowering: 2.0,
  Releasing: 0.7,
  CranesStowing: 1.5,
  OutriggersRetracting: 2.2,
});

export function clamp01(v) {
  if (typeof v !== "number" || Number.isNaN(v) || v <= 0.0) {
    return 0.0;
  }
  if (v >= 1.0) {
    return 1.0;
  }
  return v;
}

export function smoothstep(t) {
  const c = clamp01(t);
  return c * c * (3.0 - 2.0 * c);
}

export function getPhaseDuration(phase) {
  if (typeof phase === "string") {
    return Object.prototype.hasOwnProperty.call(SIDELIFT_PHASE_DURATIONS, phase)
      ? SIDELIFT_PHASE_DURATIONS[phase]
      : 0.0;
  }
  if (typeof phase === "number" && Number.isFinite(phase)) {
    const idx = Math.trunc(phase);
    if (idx >= 0 && idx < SIDELIFT_PHASE_NAMES.length) {
      return SIDELIFT_PHASE_DURATIONS[SIDELIFT_PHASE_NAMES[idx]] ?? 0.0;
    }
  }
  return 0.0;
}

export function computeCraneSpanY(containerKind) {
  let key = containerKind;
  if (containerKind && typeof containerKind === "object") {
    key = containerKind.kind ?? containerKind.containerKind ?? containerKind.wcid ?? containerKind.type;
  }
  if (typeof key === "number" && Number.isFinite(key)) {
    const n = Math.trunc(key);
    if (n === 10 || n === 4000020 || n === 20) {
      return CRANE_SPAN_Y_20FT;
    }
    return CRANE_SPAN_Y_40FT;
  }
  if (typeof key === "string") {
    const s = key.trim().toLowerCase();
    if (
      s === "20" ||
      s === "20ft" ||
      s === "22g1" ||
      s === "1cc" ||
      s === "isocontainer20" ||
      s === "4000020" ||
      s === "10"
    ) {
      return CRANE_SPAN_Y_20FT;
    }
  }
  return CRANE_SPAN_Y_40FT;
}

export function evaluateContainerLocalPose(
  phase,
  progress,
  side = 1,
  direction = "offload",
  deckZ = CHASSIS_DECK_Z,
  groundLocalZ = 0.0,
  containerSlotY = 0.0
) {
  const ph = typeof phase === "number" && Number.isFinite(phase) ? Math.trunc(phase) : 0;
  const p = clamp01(progress);
  const s = smoothstep(p);
  const sideSign =
    side === -1 ||
    side === "left" ||
    (typeof side === "number" && Number.isFinite(side) && side < 0)
      ? -1
      : 1;
  const isLoad =
    direction === true ||
    direction === 1 ||
    (typeof direction === "string" && direction.trim().toLowerCase() === "load");

  const deck = typeof deckZ === "number" && Number.isFinite(deckZ) ? deckZ : CHASSIS_DECK_Z;
  const gnd = typeof groundLocalZ === "number" && Number.isFinite(groundLocalZ) ? groundLocalZ : 0.0;
  const slotY = typeof containerSlotY === "number" && Number.isFinite(containerSlotY) ? containerSlotY : 0.0;

  const hoistZ = Math.max(deck, gnd) + HOIST_CLEARANCE_Z;
  const minZ = Math.min(deck, gnd);
  const zSpan = Math.max(0.25, hoistZ - minZ);

  const startX = isLoad ? sideSign * SIDELIFTER_OUTREACH_X : 0.0;
  const startZ = isLoad ? gnd : deck;
  const endX = isLoad ? 0.0 : sideSign * SIDELIFTER_OUTREACH_X;
  const endZ = isLoad ? deck : gnd;

  let x = startX;
  let z = startZ;

  if (ph <= SIDELIFT_PHASE.CranesLatched) {
    x = startX;
    z = startZ;
  } else if (ph === SIDELIFT_PHASE.Hoisting) {
    x = startX;
    z = startZ + (hoistZ - startZ) * s;
  } else if (ph === SIDELIFT_PHASE.Swinging) {
    x = startX + (endX - startX) * s;
    z = hoistZ + SWING_ARC_CROWN_Z * Math.sin(Math.PI * s);
  } else if (ph === SIDELIFT_PHASE.Lowering) {
    x = endX;
    z = hoistZ + (endZ - hoistZ) * s;
  } else {
    x = endX;
    z = endZ;
  }

  const craneAt = (cx, cz) => {
    const reach = Math.abs(cx) / SIDELIFTER_OUTREACH_X;
    const liftRatio = clamp01((cz - minZ) / zSpan);
    const dropRatio = clamp01((hoistZ - cz) / zSpan);
    return {
      boom: sideSign * (0.22 + 0.70 * reach - 0.08 * liftRatio),
      jib: sideSign * (0.55 + 0.20 * reach - 0.15 * liftRatio),
      chain: 0.65 + 0.45 * dropRatio,
    };
  };

  let craneBoomAngle = 0.0;
  let craneJibAngle = 0.0;
  let chainLen = 0.0;

  if (ph === SIDELIFT_PHASE.CranesPositioning) {
    const c = craneAt(startX, startZ);
    craneBoomAngle = c.boom * s;
    craneJibAngle = c.jib * s;
    chainLen = c.chain * s;
  } else if (ph >= SIDELIFT_PHASE.CranesLatched && ph <= SIDELIFT_PHASE.Releasing) {
    const c = craneAt(x, z);
    craneBoomAngle = c.boom;
    craneJibAngle = c.jib;
    chainLen = c.chain;
  } else if (ph === SIDELIFT_PHASE.CranesStowing) {
    const c = craneAt(endX, endZ);
    const k = 1.0 - s;
    craneBoomAngle = c.boom * k;
    craneJibAngle = c.jib * k;
    chainLen = c.chain * k;
  }

  return {
    x,
    y: slotY,
    z,
    roll: 0.0,
    craneBoomAngle,
    craneJibAngle,
    chainLen,
  };
}

export function isSlopeWithinLimit(cosTheta) {
  return typeof cosTheta === "number" && Number.isFinite(cosTheta) && cosTheta >= MAX_SLOPE_COS;
}

function normalizeCornerHeights(input) {
  if (Array.isArray(input) && input.length === 4) {
    const [zFL, zFR, zRL, zRR] = input;
    if (
      typeof zFL === "number" && Number.isFinite(zFL) &&
      typeof zFR === "number" && Number.isFinite(zFR) &&
      typeof zRL === "number" && Number.isFinite(zRL) &&
      typeof zRR === "number" && Number.isFinite(zRR)
    ) {
      return { zFL, zFR, zRL, zRR };
    }
    return null;
  }
  if (input && typeof input === "object" && !Array.isArray(input)) {
    const zFL = input.zFL ?? input.fl;
    const zFR = input.zFR ?? input.fr;
    const zRL = input.zRL ?? input.rl;
    const zRR = input.zRR ?? input.rr;
    if (
      typeof zFL === "number" && Number.isFinite(zFL) &&
      typeof zFR === "number" && Number.isFinite(zFR) &&
      typeof zRL === "number" && Number.isFinite(zRL) &&
      typeof zRR === "number" && Number.isFinite(zRR)
    ) {
      return { zFL, zFR, zRL, zRR };
    }
  }
  return null;
}

function normalCosTheta(v) {
  let x;
  let y;
  let z;
  if (Array.isArray(v) && v.length >= 3) {
    [x, y, z] = v;
  } else if (v && typeof v === "object") {
    x = v.x ?? v.normalX;
    y = v.y ?? v.normalY;
    z = v.z ?? v.normalZ;
  } else {
    return NaN;
  }
  if (
    typeof x !== "number" || !Number.isFinite(x) ||
    typeof y !== "number" || !Number.isFinite(y) ||
    typeof z !== "number" || !Number.isFinite(z)
  ) {
    return NaN;
  }
  const len = Math.hypot(x, y, z);
  if (!(len > 1e-6) || z <= 0.0) {
    return NaN;
  }
  return clamp01(z / len);
}

export function checkOutriggerSlope(zHeightsOrNormals, spanX = 2.44, spanY = 11.985) {
  const fail = { ok: false, cosTheta: 0.0, slopeDeg: 90.0 };
  if (typeof zHeightsOrNormals === "number") {
    if (!Number.isFinite(zHeightsOrNormals) || zHeightsOrNormals < -1.0 || zHeightsOrNormals > 1.0) {
      return fail;
    }
    const c = clamp01(zHeightsOrNormals);
    return {
      ok: c >= MAX_SLOPE_COS,
      cosTheta: c,
      slopeDeg: (Math.acos(c) * 180.0) / Math.PI,
    };
  }

  const corners = normalizeCornerHeights(zHeightsOrNormals);
  if (corners) {
    if (
      typeof spanX !== "number" || !Number.isFinite(spanX) || spanX <= 0.0 ||
      typeof spanY !== "number" || !Number.isFinite(spanY) || spanY <= 0.0
    ) {
      return fail;
    }
    const { zFL, zFR, zRL, zRR } = corners;
    const nx = -((zFR + zRR) - (zFL + zRL)) / (2.0 * spanX);
    const ny = -((zFL + zFR) - (zRL + zRR)) / (2.0 * spanY);
    const planeCos = 1.0 / Math.hypot(nx, ny, 1.0);
    const frontCos = 1.0 / Math.hypot((zFR - zFL) / spanX, 1.0);
    const rearCos = 1.0 / Math.hypot((zRR - zRL) / spanX, 1.0);
    const leftCos = 1.0 / Math.hypot((zFL - zRL) / spanY, 1.0);
    const rightCos = 1.0 / Math.hypot((zFR - zRR) / spanY, 1.0);
    const cosTheta = Math.min(planeCos, frontCos, rearCos, leftCos, rightCos);
    return {
      ok: cosTheta >= MAX_SLOPE_COS,
      cosTheta,
      slopeDeg: (Math.acos(clamp01(cosTheta)) * 180.0) / Math.PI,
    };
  }

  if (Array.isArray(zHeightsOrNormals)) {
    if (zHeightsOrNormals.length === 0) {
      return fail;
    }
    let minCos = 1.0;
    for (let i = 0; i < zHeightsOrNormals.length; i++) {
      const c = normalCosTheta(zHeightsOrNormals[i]);
      if (!Number.isFinite(c)) {
        return fail;
      }
      if (c < minCos) {
        minCos = c;
      }
    }
    return {
      ok: minCos >= MAX_SLOPE_COS,
      cosTheta: minCos,
      slopeDeg: (Math.acos(clamp01(minCos)) * 180.0) / Math.PI,
    };
  }

  if (zHeightsOrNormals && typeof zHeightsOrNormals === "object") {
    const c = normalCosTheta(zHeightsOrNormals);
    if (!Number.isFinite(c)) {
      return fail;
    }
    return {
      ok: c >= MAX_SLOPE_COS,
      cosTheta: c,
      slopeDeg: (Math.acos(clamp01(c)) * 180.0) / Math.PI,
    };
  }

  return fail;
}
