// scene3d/vehicle/trailer_kinematics.js — Deterministic 30 Hz Articulated Fifth-Wheel Trailer Kinematics
// SPECIFIED ONCE, IMPLEMENTED TWICE: Mirrors ~/ace-server/Source/ACE.Server/Vehicles/TrailerKinematics.cs
//
// AC World / Local Frame Convention:
//   +X = East / Right, +Y = North / Forward, +Z = Up
//   heading = compass radians (0 = +Y North, clockwise positive)
//   Orientation(heading, pitch, bank) = Rz(-heading) * Rx(pitch) * Ry(bank)
//
// Pure module: no DOM, no Three.js, no wall clocks.

import { orientation, rotate, wrapHeading } from "./flight_model.js";

export const SIM_HZ = 30;
export const DT = 1.0 / SIM_HZ;

const TWO_PI = 2.0 * Math.PI;

export const MAX_JACKKNIFE_RAD = (72.0 * Math.PI) / 180.0; // 1.2566370614359172 rad
export const MAX_TRAILER_PITCH_RAD = Math.PI / 4.0;
export const MAX_TRAILER_BANK_RAD = Math.PI / 4.0;
export const TRAILER_BOGIE_HALF_TRACK = 0.955; // Dual-tire midpoint (0.80..1.11 m)

export const TOW_MASS_MUL = Object.freeze({
  BOBTAIL: 1.0,
  EMPTY_CHASSIS: 0.72,
  LOADED_40FT: 0.58,
});

export const TRAILER_PHYSICS_SPECS = Object.freeze({
  "20ft": Object.freeze({
    kind: "20ft",
    kpY: 2.80,
    bogieY: -1.895,
    wheelbase: 4.695,
    deckZ: 1.32,
    kingpinZ: 0.96,
    slotOffsets: Object.freeze({ auto: 0.0, center: 0.0 }),
  }),
  "40ft": Object.freeze({
    kind: "40ft",
    kpY: 5.35,
    bogieY: -4.445,
    wheelbase: 9.795,
    deckZ: 1.32,
    kingpinZ: 0.96,
    slotOffsets: Object.freeze({ auto: -2.9295, rear: -2.9295, front: 2.9295, center: 0.0 }),
  }),
});

function clamp(v, lo, hi) {
  return v < lo ? lo : (v > hi ? hi : v);
}

/** Signed shortest angular difference wrapped to [-pi, pi]. */
export function wrapPi(a) {
  let d = a - TWO_PI * Math.floor((a + Math.PI) / TWO_PI);
  if (d > Math.PI) d -= TWO_PI;
  if (d < -Math.PI) d += TWO_PI;
  return d;
}

/** Resolve a trailer spec from string kind, WCID, DeployableKind, or explicit spec object. */
export function resolveTrailerSpec(specOrKind) {
  if (
    specOrKind === TRAILER_PHYSICS_SPECS["20ft"] ||
    specOrKind === TRAILER_PHYSICS_SPECS["40ft"]
  ) {
    return specOrKind;
  }
  if (
    specOrKind &&
    typeof specOrKind === "object" &&
    Number.isFinite(specOrKind.wheelbase) &&
    specOrKind.wheelbase > 0
  ) {
    const base = specOrKind.kind === "40ft" ? TRAILER_PHYSICS_SPECS["40ft"] : TRAILER_PHYSICS_SPECS["20ft"];
    return {
      ...base,
      ...specOrKind,
      kpY: Number.isFinite(specOrKind.kpY) ? specOrKind.kpY : base.kpY,
      bogieY: Number.isFinite(specOrKind.bogieY) ? specOrKind.bogieY : base.bogieY,
      deckZ: Number.isFinite(specOrKind.deckZ) ? specOrKind.deckZ : base.deckZ,
      kingpinZ: Number.isFinite(specOrKind.kingpinZ) ? specOrKind.kingpinZ : base.kingpinZ,
      slotOffsets: (specOrKind.slotOffsets && typeof specOrKind.slotOffsets === "object")
        ? specOrKind.slotOffsets
        : base.slotOffsets,
    };
  }
  if (
    specOrKind === "40ft" ||
    specOrKind === 40 ||
    specOrKind === "Chassis40ft" ||
    specOrKind === "TrailerChassis40" ||
    specOrKind === 4000031 ||
    specOrKind === 14
  ) {
    return TRAILER_PHYSICS_SPECS["40ft"];
  }
  return TRAILER_PHYSICS_SPECS["20ft"];
}

/** Query terrain Z from an optional oracle `(x, y, refZ) -> number | { z }`, returning NaN if unavailable. */
export function sampleTerrainZ(terrainOracle, x, y, refZ = 0.0) {
  if (typeof terrainOracle !== "function") return NaN;
  const res = terrainOracle(x, y, refZ);
  if (typeof res === "number") return Number.isFinite(res) ? res : NaN;
  if (res && typeof res === "object" && Number.isFinite(res.z)) return res.z;
  return NaN;
}

/** Compute the tractor fifth-wheel world coordinates `(x, y, z)` from tractor state. */
export function computeFifthWheelPose(tractorState, hitchOffsetY = -2.01, fifthWheelOffsetZ = 0.96) {
  const ts = tractorState || {};
  const h = Number.isFinite(ts.heading) ? ts.heading : 0.0;
  const p = Number.isFinite(ts.pitch) ? ts.pitch : 0.0;
  const tx = Number.isFinite(ts.x) ? ts.x : 0.0;
  const ty = Number.isFinite(ts.y) ? ts.y : 0.0;
  const tz = Number.isFinite(ts.z) ? ts.z : 0.0;
  return {
    x: tx + Math.sin(h) * hitchOffsetY,
    y: ty + Math.cos(h) * hitchOffsetY,
    z: tz + hitchOffsetY * Math.sin(p) + fifthWheelOffsetZ * Math.cos(p),
  };
}

/**
 * Advance coupled trailer kinematics for one deterministic step.
 * Mutates and returns `trailerState` (or allocates a new state object if omitted).
 */
export function stepCoupledTrailer(
  tractorState,
  trailerState,
  hitchOffsetY = -2.01,
  specIn = "20ft",
  terrainOracle = null,
  dt = DT,
) {
  const ts = tractorState || {};
  const spec = resolveTrailerSpec(specIn);

  const ht = Number.isFinite(ts.heading) ? ts.heading : 0.0;
  const vt = Number.isFinite(ts.speed) ? ts.speed : 0.0;
  const trPitch = Number.isFinite(ts.pitch) ? ts.pitch : 0.0;
  const tx = Number.isFinite(ts.x) ? ts.x : 0.0;
  const ty = Number.isFinite(ts.y) ? ts.y : 0.0;
  const tz = Number.isFinite(ts.z) ? ts.z : 0.0;
  const fwZ = Number.isFinite(ts.fifthWheelOffsetZ) ? ts.fifthWheelOffsetZ : spec.kingpinZ;

  // Tractor yaw rate: explicit field when supplied, else exact GroundModel bicycle-model formula.
  let omegaT = 0.0;
  if (Number.isFinite(ts.yawRate)) {
    omegaT = ts.yawRate;
  } else if (Number.isFinite(ts.wheelbase) && ts.wheelbase > 0 && Number.isFinite(ts.steerAngle)) {
    const muLat = Number.isFinite(ts.muLat) ? ts.muLat : 1.0;
    omegaT = (vt * Math.tan(ts.steerAngle) / ts.wheelbase) * muLat;
  }

  const sinHt = Math.sin(ht);
  const cosHt = Math.cos(ht);

  // World fifth-wheel hitch point & velocity (including lever arm from tractor yaw rate)
  const hx = tx + sinHt * hitchOffsetY;
  const hy = ty + cosHt * hitchOffsetY;
  const vxH = vt * sinHt + omegaT * hitchOffsetY * cosHt;
  const vyH = vt * cosHt - omegaT * hitchOffsetY * sinHt;

  const safeDt = (Number.isFinite(dt) && dt >= 0.0) ? dt : 0.0;

  // No-lateral-slip at trailer bogie: v_h . r(h_tr) = omega_tr * wheelbase
  const hTrPrev = Number.isFinite(trailerState?.heading) ? trailerState.heading : ht;
  const omegaTr = (vxH * Math.cos(hTrPrev) - vyH * Math.sin(hTrPrev)) / spec.wheelbase;

  const relPrev = wrapPi(ht - hTrPrev);
  const rel = clamp(relPrev - omegaTr * safeDt, -MAX_JACKKNIFE_RAD, MAX_JACKKNIFE_RAD);
  const hTr = wrapHeading(ht - rel);

  const sinTr = Math.sin(hTr);
  const cosTr = Math.cos(hTr);

  // Sample bogie terrain height & lateral slope around the horizontal bogie projection (wheelbase behind hitch)
  const bxSample = hx - sinTr * spec.wheelbase;
  const bySample = hy - cosTr * spec.wheelbase;

  // Vertical pitch & bank from hitch Z vs bogie terrain samples
  const hitchWorldZ = tz + hitchOffsetY * Math.sin(trPitch) + fwZ * Math.cos(trPitch);
  const kpGroundZ = hitchWorldZ - spec.kingpinZ;
  const rawBogieZ = sampleTerrainZ(terrainOracle, bxSample, bySample, kpGroundZ);
  const bogieZSample = Number.isFinite(rawBogieZ) ? rawBogieZ : kpGroundZ;

  const pitchTr = clamp(
    Math.atan2(kpGroundZ - bogieZSample, spec.wheelbase),
    -MAX_TRAILER_PITCH_RAD,
    MAX_TRAILER_PITCH_RAD,
  );

  // Lateral bank from left/right dual-tire bogie terrain samples
  const rx = cosTr;
  const ry = -sinTr;
  const zL = sampleTerrainZ(
    terrainOracle,
    bxSample - rx * TRAILER_BOGIE_HALF_TRACK,
    bySample - ry * TRAILER_BOGIE_HALF_TRACK,
    bogieZSample,
  );
  const zR = sampleTerrainZ(
    terrainOracle,
    bxSample + rx * TRAILER_BOGIE_HALF_TRACK,
    bySample + ry * TRAILER_BOGIE_HALF_TRACK,
    bogieZSample,
  );
  const bankTr = (Number.isFinite(zL) && Number.isFinite(zR))
    ? clamp(Math.atan2(zL - zR, 2.0 * TRAILER_BOGIE_HALF_TRACK), -MAX_TRAILER_BANK_RAD, MAX_TRAILER_BANK_RAD)
    : 0.0;

  // Place trailer origin so rotated 3D kingpin [0, kpY, kingpinZ] coincides exactly with world hitch (hx, hy, hitchWorldZ)
  const qTr = orientation(hTr, pitchTr, bankTr);
  const [kpOffX, kpOffY, kpOffZ] = rotate(qTr, [0.0, spec.kpY, spec.kingpinZ]);
  const xTr = hx - kpOffX;
  const yTr = hy - kpOffY;
  const zTr = hitchWorldZ - kpOffZ;

  // Derive 3D bogie axle XYZ from (xTr, yTr, zTr) + rotated [0, bogieY, 0]
  const [bgOffX, bgOffY, bgOffZ] = rotate(qTr, [0.0, spec.bogieY, 0.0]);
  const bx = xTr + bgOffX;
  const by = yTr + bgOffY;
  const bz = zTr + bgOffZ;

  const out = trailerState || {};
  out.x = xTr;
  out.y = yTr;
  out.z = zTr;
  out.heading = hTr;
  out.pitch = pitchTr;
  out.bank = bankTr;
  out.roll = bankTr;
  out.articulationRad = rel;
  out.hitchX = hx;
  out.hitchY = hy;
  out.hitchZ = hitchWorldZ;
  out.bogieX = bx;
  out.bogieY = by;
  out.bogieZ = bz;
  return out;
}

/**
 * Compute world pose `{ x, y, z, heading, pitch, bank, localY, localZ }` of an ISO container
 * mounted onto a trailer deck (`deckZ = 1.32`).
 */
export function computeMountedContainerPose(
  trailerPose,
  trailerKind,
  containerLength = 6.058,
  slot = "auto",
) {
  const tp = trailerPose || {};
  const spec = resolveTrailerSpec(trailerKind);

  const cLen = (typeof containerLength === "number" && Number.isFinite(containerLength) && containerLength > 0)
    ? containerLength
    : 6.058;
  let localY = 0.0;
  if (spec.kind === "40ft" && cLen < 7.0) {
    if (slot === "front" || slot === 1) {
      localY = 2.9295;
    } else if (slot === "center") {
      localY = 0.0;
    } else {
      localY = -2.9295;
    }
  }
  const localZ = spec.deckZ;

  const h = Number.isFinite(tp.heading) ? tp.heading : 0.0;
  const p = Number.isFinite(tp.pitch) ? tp.pitch : 0.0;
  const b = Number.isFinite(tp.bank) ? tp.bank : (Number.isFinite(tp.roll) ? tp.roll : 0.0);

  const q = orientation(h, p, b);
  const [dx, dy, dz] = rotate(q, [0.0, localY, localZ]);

  return {
    x: (Number.isFinite(tp.x) ? tp.x : 0.0) + dx,
    y: (Number.isFinite(tp.y) ? tp.y : 0.0) + dy,
    z: (Number.isFinite(tp.z) ? tp.z : 0.0) + dz,
    heading: h,
    pitch: p,
    bank: b,
    localY,
    localZ,
  };
}
