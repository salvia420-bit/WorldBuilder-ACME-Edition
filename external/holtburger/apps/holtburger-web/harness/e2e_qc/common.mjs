// harness/e2e_qc/common.mjs — Shared infrastructure for the 98-check 4-tier
// Requirement-Driven Opaque-Box E2E QC Suite (harness/e2e-qc-vehicles.mjs).
//
// Authoritative contracts: PROJECT.md § Feature Inventory #1–#15 & Interface Contracts 1–5.
// Reuses tested wire codecs, math helpers, and PNG/Playwright patterns from e2e_logistics/common.mjs.

import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import net from "node:net";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  AC_C2S_FRAME,
  AC_S2C_FRAME,
  ALL_9_DEPLOYABLES,
  APP_ROOT,
  ACE_ROOT,
  DEPLOYABLE_KIND,
  DERICOST_Y_OFFSET,
  FORK_STATE,
  HALF_PALLET_WCIDS,
  HARNESS_ROOT,
  HBV1_TAG,
  HBV1_VERSION_V6,
  HBV1_VERSION_V7,
  HOLTBURGER_ROOT,
  LOGISTICS_SPEC,
  LogisticsWorldSimulator,
  ONLINE_FLAGS,
  OPCODES,
  PALLET_JACK_ACTION_KIND,
  PALLET_JACK_FLAGS,
  PINWHEEL_SLOTS_20,
  PINWHEEL_SLOTS_40,
  PROTOCOL_DIR,
  REPO_ROOT,
  SIDELIFT_FLAGS,
  SIDELIFT_PHASE,
  TRAILER_ACTION_KIND,
  TRAILER_FLAGS,
  TWO_PI,
  VEHICLE_EVENT_KIND,
  acquireHeavyLock,
  angleDiff,
  assert,
  countDrawCalls,
  countLights,
  createFakeWebGL2,
  decodeContainerAction,
  decodeDeployableState,
  decodeHeader,
  decodePalletJackAction,
  decodePalletJackState,
  decodeTrailerAction,
  decodeTrailerState,
  decodeVehicleEvent,
  encodeContainerAction,
  encodeDeployableState,
  encodeHeader,
  encodePalletJackAction,
  encodePalletJackState,
  encodeTrailerAction,
  encodeTrailerState,
  encodeVehicleEvent,
  fakeCanvas,
  filterErrors,
  getThree,
  installFakeAudio,
  makeLogisticsLiveEnv,
  near,
  oracleCheckSlopeCorners,
  oracleCheckSlopeFromCos,
  oracleComputeCraneSpanY,
  oracleComputeReachableLoadSlots,
  oracleComputeReachableUnloadSlots,
  oracleEvaluateContainerLocalPose,
  oracleStepPalletJack,
  oracleWireStatsTrack,
  parsePngDimensionsAndEntropy,
  readProtocolFixtures,
  readXmlProtocol,
  toCellLocal,
  toGlobal,
  tryImportVehicle,
  tryLoadWasmPkg,
  wrapHeading,
  wrapPi,
} from "../e2e_logistics/common.mjs";

export {
  AC_C2S_FRAME,
  AC_S2C_FRAME,
  ALL_9_DEPLOYABLES,
  APP_ROOT,
  ACE_ROOT,
  DEPLOYABLE_KIND,
  DERICOST_Y_OFFSET,
  FORK_STATE,
  HALF_PALLET_WCIDS,
  HARNESS_ROOT,
  HBV1_TAG,
  HBV1_VERSION_V6,
  HBV1_VERSION_V7,
  HOLTBURGER_ROOT,
  LOGISTICS_SPEC,
  ONLINE_FLAGS,
  OPCODES,
  PALLET_JACK_ACTION_KIND,
  PALLET_JACK_FLAGS,
  PINWHEEL_SLOTS_20,
  PINWHEEL_SLOTS_40,
  PROTOCOL_DIR,
  REPO_ROOT,
  SIDELIFT_FLAGS,
  SIDELIFT_PHASE,
  TRAILER_ACTION_KIND,
  TRAILER_FLAGS,
  TWO_PI,
  VEHICLE_EVENT_KIND,
  acquireHeavyLock,
  angleDiff,
  assert,
  countDrawCalls,
  countLights,
  createFakeWebGL2,
  decodeContainerAction,
  decodeDeployableState,
  decodeHeader,
  decodePalletJackAction,
  decodePalletJackState,
  decodeTrailerAction,
  decodeTrailerState,
  decodeVehicleEvent,
  encodeContainerAction,
  encodeDeployableState,
  encodeHeader,
  encodePalletJackAction,
  encodePalletJackState,
  encodeTrailerAction,
  encodeTrailerState,
  encodeVehicleEvent,
  fakeCanvas,
  filterErrors,
  getThree,
  installFakeAudio,
  near,
  oracleCheckSlopeCorners,
  oracleCheckSlopeFromCos,
  oracleComputeCraneSpanY,
  oracleComputeReachableLoadSlots,
  oracleComputeReachableUnloadSlots,
  oracleEvaluateContainerLocalPose,
  oracleStepPalletJack,
  oracleWireStatsTrack,
  parsePngDimensionsAndEntropy,
  readProtocolFixtures,
  readXmlProtocol,
  toCellLocal,
  toGlobal,
  tryImportVehicle,
  tryLoadWasmPkg,
  wrapHeading,
  wrapPi,
};

export const CONTAINER_ACTION_KIND = Object.freeze({
  OpenDoors: 1,
  CloseDoors: 2,
  Load: 3,
  Pack: 4,
  Unpack: 5,
  UnpackAll: 6,
});

export const IFF_STANDING = Object.freeze({
  Unknown: 0,
  Friendly: 1,
  Neutral: 2,
  Hostile: 3,
});

export const DEPLOYABLE_WEAPON_KIND = Object.freeze({
  None: 0,
  SAM: 1,
  Mortar: 2,
  Laser: 3,
});

export const DERICOS_FLAT_SITE = Object.freeze({
  cellHex: "0xA6908025",
  cell: 0xa6908025,
  adjacentCellHex: "0xA7908025",
  adjacentCell: 0xa7908025,
  lx: 96.0,
  ly: 96.0,
  z: 278.0,
  gx: 166 * 192.0 + 96.0, // 31968
  gy: DERICOST_Y_OFFSET + 144 * 192.0 + 96.0, // 96672
});

export const ALL_RESERVED_WCIDS = Object.freeze([
  4000001, // Vehicles (hellcat/jeep/semi)
  4000002, // RadarStation
  4000010, // FluxPod
  4000011, // SolarPanels
  4000012, // PowerGenerator
  4000013, // BatteryUnit
  4000014, // MissileTurret
  4000015, // GroundRadar
  4000016, // MortarTurret
  4000017, // HeavyLaserTurret
  4000020, // IsoContainer20
  4000021, // IsoContainer40
  4000022, // IsoContainer40HC
  4000030, // TrailerChassis20
  4000031, // TrailerChassis40
  4000032, // TrailerSidelifter40
  4000035, // PalletJack
]);

/**
 * Authoritative AC Compass Heading Transform (Contract #5):
 * Heading 0 = +Y (North), +pi/2 = +X (East), clockwise.
 * Local (lx, ly) -> World (px + lx*cosH + ly*sinH, py - lx*sinH + ly*cosH).
 */
export function acHeadingTransform(px, py, lx, ly, heading = 0) {
  const cosH = Math.cos(heading);
  const sinH = Math.sin(heading);
  return [
    px + lx * cosH + ly * sinH,
    py - lx * sinH + ly * cosH,
  ];
}

/**
 * ISO 6346 Modulo-11 container check digit calculation.
 */
export function computeIso6346CheckDigit(ownerAndCat, serial6) {
  if (typeof ownerAndCat !== "string" || !/^[A-Z]{4}$/.test(ownerAndCat)) {
    throw new Error(`Invalid ISO 6346 owner/category prefix: "${ownerAndCat}"`);
  }
  const s = String(serial6).padStart(6, "0");
  if (!/^\d{6}$/.test(s)) {
    throw new Error(`Invalid ISO 6346 serial number: "${serial6}"`);
  }
  const letterValues = {
    A: 10, B: 12, C: 13, D: 14, E: 15, F: 16, G: 17, H: 18, I: 19, J: 20, K: 21,
    L: 23, M: 24, N: 25, O: 26, P: 27, Q: 28, R: 29, S: 30, T: 31, U: 32,
    V: 34, W: 35, X: 36, Y: 37, Z: 38,
  };
  let sum = 0;
  const code = ownerAndCat + s;
  for (let i = 0; i < 10; i++) {
    const ch = code[i];
    const val = i < 4 ? letterValues[ch] : Number(ch);
    sum += val * (1 << i);
  }
  return (sum % 11) % 10;
}

// =============================================================================
// Additional HBV1 v7 Binary Wire Codecs (0x0900, 0x0904, 0x090A, 0x090C, 0x090D, 0x090E)
// =============================================================================

class BinWriter {
  constructor(cap = 128) {
    this.buf = new Uint8Array(cap);
    this.dv = new DataView(this.buf.buffer);
    this.pos = 0;
  }
  _grow(need) {
    if (this.pos + need <= this.buf.length) return;
    let next = this.buf.length * 2;
    while (next < this.pos + need) next *= 2;
    const nb = new Uint8Array(next);
    nb.set(this.buf);
    this.buf = nb;
    this.dv = new DataView(this.buf.buffer);
  }
  u8(v) { this._grow(1); this.dv.setUint8(this.pos, v & 0xff); this.pos += 1; }
  u16(v) { this._grow(2); this.dv.setUint16(this.pos, v & 0xffff, true); this.pos += 2; }
  u32(v) { this._grow(4); this.dv.setUint32(this.pos, v >>> 0, true); this.pos += 4; }
  f32(v) { this._grow(4); this.dv.setFloat32(this.pos, v ?? 0, true); this.pos += 4; }
  vec3(v) {
    const x = Array.isArray(v) ? v[0] : (v?.X ?? v?.x ?? 0);
    const y = Array.isArray(v) ? v[1] : (v?.Y ?? v?.y ?? 0);
    const z = Array.isArray(v) ? v[2] : (v?.Z ?? v?.z ?? 0);
    this.f32(x); this.f32(y); this.f32(z);
  }
  finish() { return this.buf.slice(0, this.pos); }
}

class BinReader {
  constructor(bytes) {
    this.buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    this.dv = new DataView(this.buf.buffer, this.buf.byteOffset, this.buf.byteLength);
    this.pos = 0;
  }
  remaining() { return this.buf.byteLength - this.pos; }
  _need(n) { if (this.pos + n > this.buf.byteLength) throw new Error("truncated HBV1 buffer"); }
  u8() { this._need(1); const v = this.dv.getUint8(this.pos); this.pos += 1; return v; }
  u16() { this._need(2); const v = this.dv.getUint16(this.pos, true); this.pos += 2; return v; }
  u32() { this._need(4); const v = this.dv.getUint32(this.pos, true); this.pos += 4; return v; }
  f32() { this._need(4); const v = this.dv.getFloat32(this.pos, true); this.pos += 4; return v; }
  vec3() { return { X: this.f32(), Y: this.f32(), Z: this.f32() }; }
}

export function encodeClientCapabilities(flags = 3, version = HBV1_VERSION_V7) {
  const w = new BinWriter(12);
  encodeHeader(w, { Version: version });
  w.u32(flags >>> 0);
  return w.finish();
}

export function decodeCapabilitiesAck(bytes) {
  const r = new BinReader(bytes);
  const Header = decodeHeader(r);
  if (!Header || r.remaining() < 8) return null;
  return {
    Header,
    Granted: r.u32(),
    SimHz: r.u16(),
    Reserved: r.u16(),
    _bytesConsumed: r.pos,
  };
}

export function encodeVehicleSeat(fields = {}, version = HBV1_VERSION_V7) {
  const w = new BinWriter(28);
  encodeHeader(w, { Version: version });
  w.u32(fields.Vehicle ?? 0);
  w.u32(fields.Seat ?? 0);
  w.u32(fields.Occupant ?? 0);
  w.u32(fields.State ?? 0);
  w.u32(fields.Reason ?? 0);
  return w.finish();
}

export function decodeVehicleSeat(bytes) {
  const r = new BinReader(bytes);
  const Header = decodeHeader(r);
  if (!Header || r.remaining() < 20) return null;
  return {
    Header,
    Vehicle: r.u32(),
    Seat: r.u32(),
    Occupant: r.u32(),
    State: r.u32(),
    Reason: r.u32(),
    _bytesConsumed: r.pos,
  };
}

export function encodeDeployableFire(fields = {}, version = HBV1_VERSION_V7) {
  const w = new BinWriter(72);
  encodeHeader(w, { Version: version });
  w.u32(fields.DeployableGuid ?? 0);
  w.u32(fields.WeaponKind ?? 0);
  w.u32(fields.Step ?? 0);
  w.u32(fields.TargetGuid ?? 0);
  w.u32(fields.Cell ?? 0);
  w.vec3(fields.Muzzle ?? { X: 0, Y: 0, Z: 0 });
  w.vec3(fields.TargetPos ?? { X: 0, Y: 0, Z: 0 });
  w.vec3(fields.Velocity ?? { X: 0, Y: 0, Z: 0 });
  w.f32(fields.EnergyJoules ?? 0);
  w.u16(fields.BurstCount ?? 1);
  w.u16(fields.Reserved ?? 0);
  return w.finish();
}

export function decodeDeployableFire(bytes) {
  const r = new BinReader(bytes);
  const Header = decodeHeader(r);
  if (!Header || r.remaining() < 64) return null;
  return {
    Header,
    DeployableGuid: r.u32(),
    WeaponKind: r.u32(),
    Step: r.u32(),
    TargetGuid: r.u32(),
    Cell: r.u32(),
    Muzzle: r.vec3(),
    TargetPos: r.vec3(),
    Velocity: r.vec3(),
    EnergyJoules: r.f32(),
    BurstCount: r.u16(),
    Reserved: r.u16(),
    _bytesConsumed: r.pos,
  };
}

export function encodeGroundContacts(fields = {}, version = HBV1_VERSION_V7) {
  const contacts = Array.isArray(fields.Contacts) ? fields.Contacts : [];
  const w = new BinWriter(40 + contacts.length * 24);
  encodeHeader(w, { Version: version });
  w.u32(fields.RadarGuid ?? 0);
  w.u32(fields.ParentVehicle ?? 0);
  w.f32(fields.RadarX ?? 0);
  w.f32(fields.RadarY ?? 0);
  w.f32(fields.RadarZ ?? 0);
  w.f32(fields.RangeM ?? 600);
  w.f32(fields.SweepAngleRad ?? 0);
  w.u32(contacts.length);
  for (const c of contacts) {
    w.u32(c.TargetGuid ?? 0);
    w.f32(c.DxM ?? 0);
    w.f32(c.DyM ?? 0);
    w.f32(c.DzM ?? 0);
    w.u8(c.Kind ?? 2);
    w.u8(c.Standing ?? 3);
    w.u8(c.HeadingU8 ?? 0);
    w.u8(c.SpeedMpsU8 ?? 0);
    w.u8(c.Flags ?? 0);
    w.u8(0);
    w.u8(0);
    w.u8(0);
  }
  return w.finish();
}

export function decodeGroundContacts(bytes) {
  const r = new BinReader(bytes);
  const Header = decodeHeader(r);
  if (!Header || r.remaining() < 32) return null;
  const out = {
    Header,
    RadarGuid: r.u32(),
    ParentVehicle: r.u32(),
    RadarX: r.f32(),
    RadarY: r.f32(),
    RadarZ: r.f32(),
    RangeM: r.f32(),
    SweepAngleRad: r.f32(),
    ContactCount: r.u32(),
    Contacts: [],
  };
  if (r.remaining() < out.ContactCount * 24) return null;
  for (let i = 0; i < out.ContactCount; i++) {
    out.Contacts.push({
      TargetGuid: r.u32(),
      DxM: r.f32(),
      DyM: r.f32(),
      DzM: r.f32(),
      Kind: r.u8(),
      Standing: r.u8(),
      HeadingU8: r.u8(),
      SpeedMpsU8: r.u8(),
      Flags: r.u8(),
      Reserved0: r.u8(),
      Reserved1: r.u8(),
      Reserved2: r.u8(),
    });
  }
  out._bytesConsumed = r.pos;
  return out;
}

export function encodeContainerState(fields = {}, version = HBV1_VERSION_V7) {
  const slots = Array.isArray(fields.Slots) ? fields.Slots : [];
  const w = new BinWriter(56 + slots.length * 8);
  encodeHeader(w, { Version: version });
  w.u32(fields.ContainerGuid ?? 0);
  w.u32(fields.ContainerKind ?? DEPLOYABLE_KIND.IsoContainer20);
  w.u8(fields.DoorState ?? 0);
  w.u8(fields.LiveryId ?? 0);
  w.u8(fields.MaxFullSlots ?? 10);
  w.u8(fields.Flags ?? 0);
  w.u32(fields.OwnerGuid ?? 0);
  w.u32(fields.Cell ?? 0);
  w.vec3(fields.Position ?? { X: 0, Y: 0, Z: 0 });
  w.f32(fields.Heading ?? 0);
  w.f32(fields.DoorProgress ?? 0);
  w.u32(fields.SerialNumber ?? 1);
  w.u32(slots.length);
  for (const s of slots) {
    w.u8(s.SlotIndex ?? 0);
    w.u8(s.PalletSize ?? 2);
    w.u8(s.SubSlot ?? 0);
    w.u8(s.Reserved ?? 0);
    w.u32(s.CargoWcid ?? 0);
  }
  return w.finish();
}

export function decodeContainerState(bytes) {
  const r = new BinReader(bytes);
  const Header = decodeHeader(r);
  if (!Header || r.remaining() < 48) return null;
  const out = {
    Header,
    ContainerGuid: r.u32(),
    ContainerKind: r.u32(),
    DoorState: r.u8(),
    LiveryId: r.u8(),
    MaxFullSlots: r.u8(),
    Flags: r.u8(),
    OwnerGuid: r.u32(),
    Cell: r.u32(),
    Position: r.vec3(),
    Heading: r.f32(),
    DoorProgress: r.f32(),
    SerialNumber: r.u32(),
    SlotCount: r.u32(),
    Slots: [],
  };
  if (r.remaining() < out.SlotCount * 8) return null;
  for (let i = 0; i < out.SlotCount; i++) {
    out.Slots.push({
      SlotIndex: r.u8(),
      PalletSize: r.u8(),
      SubSlot: r.u8(),
      Reserved: r.u8(),
      CargoWcid: r.u32(),
    });
  }
  out._bytesConsumed = r.pos;
  return out;
}

// =============================================================================
// Extended QC World Simulator (Multi-seat, Idle Despawn, Security, MicroGrid, Dericost)
// =============================================================================

export class QcWorldSimulator extends LogisticsWorldSimulator {
  constructor() {
    super();
    this.fireEvents = [];
    this.nowSec = 0;
  }

  spawnSemiWithSeats({ x = 100, y = 100, z = 10, liveryId = 0 } = {}) {
    const tGuid = this.allocGuid();
    this.tractors.set(tGuid, {
      guid: tGuid,
      x,
      y,
      z,
      heading: 0,
      speed: 0,
      liveryId: liveryId >= 0 && liveryId <= 5 ? liveryId : 0,
      seats: [0, 0],
      hitchedTrailerGuid: 0,
      towMassMul: 1.0,
      emptySinceSec: null,
      isDestroyed: false,
      headlights: false,
    });
    return tGuid;
  }

  boardVehicle(vGuid, playerGuid, seat = 0, { distM = 2.0, hasCapPilot = true, isDead = false, teleporting = false } = {}) {
    const v = this.tractors.get(vGuid);
    if (!v || v.isDestroyed) return { ok: false, reason: 7 };
    if (!hasCapPilot) return { ok: false, reason: 6 };
    if (isDead || teleporting) return { ok: false, reason: 7 };
    if (distM > 16.0) return { ok: false, reason: 1 };
    if (Math.abs(v.speed) > 1.5) return { ok: false, reason: 3 };
    if (!Array.isArray(v.seats)) v.seats = [0, 0];
    if (seat < 0 || seat >= v.seats.length) return { ok: false, reason: 2 };
    if (v.seats[seat] && v.seats[seat] !== playerGuid) return { ok: false, reason: 2 };
    for (let i = 0; i < v.seats.length; i++) {
      if (v.seats[i] === playerGuid) v.seats[i] = 0;
    }
    v.seats[seat] = playerGuid;
    v.emptySinceSec = null; // Contract #4 / PROJECT.md #4: refresh on any board
    return { ok: true, seat };
  }

  exitVehicle(vGuid, playerGuid) {
    const v = this.tractors.get(vGuid);
    if (!v || !Array.isArray(v.seats)) return { ok: false };
    for (let i = 0; i < v.seats.length; i++) {
      if (v.seats[i] === playerGuid) v.seats[i] = 0;
    }
    if (v.seats[0] === 0 && Math.abs(v.speed) > 0.25) {
      v.speed = 0; // auto-handbrake on driver exit
    }
    const anyOccupied = v.seats.some((s) => s !== 0);
    v.emptySinceSec = anyOccupied ? null : this.nowSec;
    return { ok: true, anyOccupied };
  }

  advanceTime(dtSec) {
    this.nowSec += dtSec;
    for (const v of this.tractors.values()) {
      if (v.isDestroyed) continue;
      const anyOccupied = Array.isArray(v.seats) && v.seats.some((s) => s !== 0);
      if (anyOccupied) {
        v.emptySinceSec = null;
        continue;
      }
      if (v.emptySinceSec === null) {
        v.emptySinceSec = this.nowSec;
      } else if (this.nowSec - v.emptySinceSec >= 600.0) {
        v.isDestroyed = true;
        if (v.hitchedTrailerGuid) {
          const tr = this.trailers.get(v.hitchedTrailerGuid);
          if (tr) tr.coupledTractorGuid = 0;
          v.hitchedTrailerGuid = 0;
        }
      }
    }
  }

  hitchTrailer(vGuid, trGuid, { distM = 2.0, angleDeg = 5.0 } = {}) {
    const v = this.tractors.get(vGuid);
    const tr = this.trailers.get(trGuid);
    if (!v || !tr) return { ok: false, reason: "missing entity" };
    if (tr.sideliftPhase !== SIDELIFT_PHASE.Idle) {
      return { ok: false, reason: "ISO 3874: Complete or retract sidelifter before hitching." };
    }
    if (distM > 3.5) return { ok: false, reason: "Too far from fifth-wheel (> 3.5m)." };
    if (Math.abs(angleDeg) > 60.0) return { ok: false, reason: "Alignment angle exceeds 60 deg." };
    v.hitchedTrailerGuid = trGuid;
    tr.coupledTractorGuid = vGuid;
    return { ok: true };
  }

  unhitchTrailer(vGuid, trGuid) {
    const v = this.tractors.get(vGuid);
    const tr = this.trailers.get(trGuid);
    if (!v || !tr) return { ok: false, reason: "missing entity" };
    if (Math.abs(v.speed) > 0.25) {
      return { ok: false, reason: "Stop tractor before unhitching trailer." };
    }
    if (tr.sideliftPhase !== SIDELIFT_PHASE.Idle) {
      return { ok: false, reason: "ISO 3874: Complete or retract sidelifter before unhitching." };
    }
    v.hitchedTrailerGuid = 0;
    tr.coupledTractorGuid = 0;
    return { ok: true };
  }

  containerAction(cGuid, action, { slotIndex = 0, subSlot = 0, cargoWcid = 0, accessLevel = 5, hasCapPilot = true, isDead = false, teleporting = false, isSeated = false, distM = 2.0 } = {}) {
    const c = this.containers.get(cGuid);
    if (!c) return { ok: false, reason: "missing container" };
    if (!hasCapPilot || isDead || teleporting || isSeated) {
      return { ok: false, reason: "Action refused by player capability/state guard" };
    }
    if (distM > 15.0) return { ok: false, reason: "Too far from container (> 15m)" };
    if (action === CONTAINER_ACTION_KIND.Load) {
      if (accessLevel < 4) {
        return { ok: false, reason: "AccessLevel >= Developer required for VehicleContainerAction.Load" };
      }
      if (c.doorProgress < 0.8) {
        return { ok: false, reason: "Open container doors before loading" };
      }
      const isHalf = HALF_PALLET_WCIDS.has(cargoWcid);
      c.slots.push({ slotIndex, subSlot: isHalf ? subSlot : 0, cargoWcid, palletSize: isHalf ? 1 : 2, cargoState: {} });
      return { ok: true };
    }
    if (action === CONTAINER_ACTION_KIND.OpenDoors) return this.openContainerDoors(cGuid, true);
    if (action === CONTAINER_ACTION_KIND.CloseDoors) return this.openContainerDoors(cGuid, false);
    if (action === CONTAINER_ACTION_KIND.Unpack) {
      if (c.doorProgress < 0.8) return { ok: false, reason: "Open container doors before unpacking" };
      const idx = c.slots.findIndex((s) => s.slotIndex === slotIndex && (s.subSlot ?? 0) === subSlot);
      if (idx < 0) return { ok: false, reason: "Slot empty" };
      const slot = c.slots.splice(idx, 1)[0];
      const spec = LOGISTICS_SPEC.containers[c.kind] || LOGISTICS_SPEC.containers[10];
      const halfL = spec.extL / 2;
      const [wx, wy] = acHeadingTransform(c.x, c.y, 0, -(halfL + 0.85 + 1.5), c.heading || 0);
      const dGuid = this.allocGuid();
      const dSpec = ALL_9_DEPLOYABLES.find((d) => d.wcid === slot.cargoWcid) || ALL_9_DEPLOYABLES[0];
      this.deployables.set(dGuid, {
        guid: dGuid,
        wcid: slot.cargoWcid,
        kind: dSpec.kind,
        x: wx,
        y: wy,
        z: c.z,
        heading: c.heading || 0,
        isStowed: false,
        onlineFlags: ONLINE_FLAGS.Active,
        cargoState: { ...(slot.cargoState || {}) },
      });
      this.recomputeMicroGrid();
      return { ok: true, dGuid, pos: [wx, wy, c.z] };
    }
    if (action === CONTAINER_ACTION_KIND.Pack) {
      const d = this.deployables.get(cargoWcid);
      if (!d || d.isDestroyed || d._packed) {
        return { ok: false, reason: "Deployable already packed or destroyed" };
      }
      if (Math.hypot(d.x - c.x, d.y - c.y) > 15.0) {
        return { ok: false, reason: "Deployable too far to pack" };
      }
      d._packed = true;
      d.isDestroyed = true;
      this.deployables.delete(cargoWcid);
      c.slots.push({ slotIndex, subSlot, cargoWcid: d.wcid, palletSize: HALF_PALLET_WCIDS.has(d.wcid) ? 1 : 2, cargoState: { ...(d.cargoState || {}) } });
      this.recomputeMicroGrid();
      return { ok: true };
    }
    return { ok: false, reason: "unsupported container action" };
  }

  recomputeMicroGrid() {
    const activeFlux = [...this.deployables.values()].filter((d) => d.wcid === 4000010 && !d.isStowed);
    let totalGenW = 0;
    let totalBatteryJ = 0;
    for (const d of this.deployables.values()) {
      if (d.isStowed) continue;
      if (d.wcid === 4000011) totalGenW += 12000;
      if (d.wcid === 4000012 && (d.cargoState?.fuel ?? 0) > 0) totalGenW += 45000;
      if (d.wcid === 4000013) totalBatteryJ += (d.cargoState?.energy ?? 0);
    }
    for (const d of this.deployables.values()) {
      const spec = ALL_9_DEPLOYABLES.find((x) => x.wcid === d.wcid) || { powerW: 0 };
      if (d.isStowed) {
        d.onlineFlags = ONLINE_FLAGS.Stowed;
        d.powerWatts = 0;
        continue;
      }
      // ±75m cube containment check (MicroGrid.cs)
      const inFlux = activeFlux.some((f) => Math.abs(f.x - d.x) <= 75.0 && Math.abs(f.y - d.y) <= 75.0);
      const hasPower = spec.powerW >= 0 || (inFlux && (totalGenW > 0 || totalBatteryJ > 0));
      d.onlineFlags = (hasPower ? ONLINE_FLAGS.Powered : 0) | (inFlux ? ONLINE_FLAGS.InFluxRange : 0) | ONLINE_FLAGS.Active;
      d.powerWatts = hasPower ? spec.powerW : 0;
    }
  }

  tickAirDefenseFire(turretGuid, targetGuid, targetPos, { standing = IFF_STANDING.Hostile, aglM = 50, distM = 200, isAir = false, occluded = false } = {}) {
    const tur = this.deployables.get(turretGuid);
    if (!tur || tur.isStowed || !(tur.onlineFlags & ONLINE_FLAGS.Powered)) {
      return { ok: false, reason: "Turret unpowered or stowed" };
    }
    if (standing !== IFF_STANDING.Hostile) {
      return { ok: false, reason: "Target IFF is not Hostile" };
    }
    if (tur.wcid === 4000014) {
      if (!isAir || aglM < 8.0 || aglM > 1550.0 || distM > 32187.0 || occluded) {
        return { ok: false, reason: "RadarStation envelope check excluded target" };
      }
      if ((tur.cargoState?.ammo ?? 0) <= 0) return { ok: false, reason: "Out of SAM ammo" };
      const burst = Math.min(4, tur.cargoState.ammo);
      tur.cargoState.ammo -= burst;
      const evt = { deployableGuid: turretGuid, weaponKind: DEPLOYABLE_WEAPON_KIND.SAM, targetGuid, targetPos, burstCount: burst, energyJoules: 0 };
      this.fireEvents.push(evt);
      return { ok: true, evt };
    }
    if (tur.wcid === 4000017) {
      const bat = [...this.deployables.values()].find((d) => d.wcid === 4000013 && !d.isStowed && (d.cargoState?.energy ?? 0) >= 120000);
      if (!bat) return { ok: false, reason: "Insufficient BatteryUnit energy (< 120 kJ)" };
      bat.cargoState.energy -= 120000;
      const evt = { deployableGuid: turretGuid, weaponKind: DEPLOYABLE_WEAPON_KIND.Laser, targetGuid, targetPos, burstCount: 1, energyJoules: 120000 };
      this.fireEvents.push(evt);
      return { ok: true, evt };
    }
    if (tur.wcid === 4000016) {
      const evt = { deployableGuid: turretGuid, weaponKind: DEPLOYABLE_WEAPON_KIND.Mortar, targetGuid, targetPos, burstCount: 1, energyJoules: 0 };
      this.fireEvents.push(evt);
      return { ok: true, evt };
    }
    return { ok: false, reason: "Not a firing turret" };
  }
}

export async function makeQcLiveEnv(opts = {}) {
  return await makeLogisticsLiveEnv(opts);
}

// =============================================================================
// QcSuiteCollector (supports runCheck [always], runDual, and checkLive)
// =============================================================================

export class QcSuiteCollector {
  constructor(ctx) {
    this.ctx = ctx; // { mode, strict, filter, bail, quiet, liveSession, outDir }
    this.results = [];
  }

  get mode() { return this.ctx.mode; }
  get liveSession() { return this.ctx.liveSession; }

  _matchesFilter(id, feature) {
    if (!this.ctx.filter) return true;
    const f = this.ctx.filter.toLowerCase();
    return id.toLowerCase().includes(f) || feature.toLowerCase().includes(f);
  }

  _record(entry) {
    this.results.push(entry);
    if (!this.ctx.quiet) {
      const suffix = entry.detail ? ` — ${entry.detail}` : "";
      console.log(`  [${entry.status}] T${entry.tier} ${entry.id} (${entry.feature})${suffix}`);
    }
  }

  async _emitLiveDiag(id) {
    if (this.ctx.mode !== "live" || !this.ctx.liveSession || this.ctx.quiet) return;
    try {
      const diag = await this.ctx.liveSession.evalInPage(`
        const v = window.__vehicles;
        const sh = window.__sessionHandle;
        const pose = sh?.getLocalPlayerPose?.();
        return {
          bootState: window.__bootState,
          pose: pose ? { cell: pose.landblockId, x: pose.x, y: pose.y, z: pose.z } : null,
          vehicles: (v?.vehicles?.() || []).length,
          trailers: (v?.trailers?.list?.() || []).map((t) => ({ g: t.guid, ph: t.sideliftPhase, side: t.sideliftSide, mc: t.mountedContainerGuid })),
          containers: (v?.containers?.list?.() || []).map((c) => ({ g: c.guid, dp: c.doorProgress })),
          pjs: (v?.palletJacks?.list?.() || []).map((p) => ({ g: p.guid, op: p.operatorGuid, st: p.stowedOnTrailerGuid })),
          deps: (v?.deployables?.list?.() || []).map((d) => ({ g: d.guid, w: d.wcid, fl: d.last?.onlineFlags })),
          unhandled: window.__e2eUnhandled || [],
        };
      `).catch(() => null);
      const chats = await this.ctx.liveSession.getChatLines().catch(() => []);
      console.error(`[DIAG ${id}]`, JSON.stringify({ diag, chats: chats.slice(-6) }));
    } catch (_) {}
  }

  async runCheck(id, tier, feature, fn) {
    if (!this._matchesFilter(id, feature)) return;
    if (this.ctx.bail && this.results.some((r) => r.status === "FAIL")) return;
    const t0 = Date.now();
    try {
      await fn(this.ctx);
      this._record({ id, tier, feature, mode: "offline", status: "PASS", durationMs: Date.now() - t0, detail: "" });
    } catch (err) {
      this._record({ id, tier, feature, mode: "offline", status: "FAIL", durationMs: Date.now() - t0, detail: err?.message || String(err) });
    }
  }

  async runDual(id, tier, feature, offlineFn, liveFn) {
    if (!this._matchesFilter(id, feature)) return;
    if (this.ctx.bail && this.results.some((r) => r.status === "FAIL")) return;
    const t0 = Date.now();
    const isLive = this.ctx.mode === "live";
    if (isLive && !this.ctx.liveSession) {
      this._record({ id, tier, feature, mode: "live", status: "FAIL", durationMs: 0, detail: "LiveSession not initialized" });
      return;
    }
    try {
      if (isLive) await liveFn(this.ctx.liveSession, this.ctx);
      else await offlineFn(this.ctx);
      this._record({ id, tier, feature, mode: isLive ? "live" : "offline", status: "PASS", durationMs: Date.now() - t0, detail: "" });
    } catch (err) {
      await this._emitLiveDiag(id);
      this._record({ id, tier, feature, mode: isLive ? "live" : "offline", status: "FAIL", durationMs: Date.now() - t0, detail: err?.message || String(err) });
    }
  }

  async checkLive(id, tier, feature, liveFn) {
    if (!this._matchesFilter(id, feature)) return;
    if (this.ctx.bail && this.results.some((r) => r.status === "FAIL")) return;
    const t0 = Date.now();
    if (this.ctx.mode !== "live") {
      const mustFail = Boolean(this.ctx.strict);
      this._record({
        id,
        tier,
        feature,
        mode: "live",
        status: mustFail ? "FAIL" : "PENDING",
        durationMs: 0,
        detail: mustFail ? "Live-only scenario requires --mode live under --strict" : "Requires --mode live (ACE + wsbridge + serve.py + EGL Chromium)",
      });
      return;
    }
    if (!this.ctx.liveSession) {
      this._record({ id, tier, feature, mode: "live", status: "FAIL", durationMs: 0, detail: "LiveSession not initialized" });
      return;
    }
    try {
      await liveFn(this.ctx.liveSession, this.ctx);
      this._record({ id, tier, feature, mode: "live", status: "PASS", durationMs: Date.now() - t0, detail: "" });
    } catch (err) {
      await this._emitLiveDiag(id);
      this._record({ id, tier, feature, mode: "live", status: "FAIL", durationMs: Date.now() - t0, detail: err?.message || String(err) });
    }
  }
}

// =============================================================================
// Platform-Aware QcLiveSession (Dericost Teleport, Multi-Context, Cleanup)
// =============================================================================

async function checkTcpReachable(host, port, timeoutMs = 2500) {
  return await new Promise((resolve) => {
    const sock = net.createConnection({ host, port });
    const timer = setTimeout(() => { sock.destroy(); resolve(false); }, timeoutMs);
    sock.on("connect", () => { clearTimeout(timer); sock.end(); resolve(true); });
    sock.on("error", () => { clearTimeout(timer); resolve(false); });
  });
}

function resolvePlaywrightCore() {
  const candidates = [
    process.env.HB_PLAYWRIGHT_CORE,
    "/workspace/wb/mnt1/ac-refs/webac/node_modules/playwright-core",
  ].filter(Boolean);
  const req = createRequire(import.meta.url);
  for (const p of candidates) {
    if (existsSync(p)) return req(p);
  }
  try { return req("playwright-core"); } catch (_) {}
  try { return req("playwright"); } catch (_) {}
  throw new Error("PLAYWRIGHT_MISSING: unable to locate playwright-core (set HB_PLAYWRIGHT_CORE)");
}

function resolveChromeExecutable() {
  const candidates = [
    process.env.HB_CHROME,
    "/workspace/wb/ms-playwright/chromium-1254/chrome-linux64/chrome",
  ].filter(Boolean);
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return undefined;
}

function buildChromeLaunchArgs() {
  const common = [
    "--mute-audio",
    "--window-position=-32000,-32000",
    "--disable-renderer-backgrounding",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--window-size=1920,1080",
  ];
  if (process.platform === "win32") {
    return [
      `--user-data-dir=${process.env.HB_USER_DATA_DIR || "C:\\tmp\\hbbench\\e2e-qc"}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-features=CalculateNativeWinOcclusion",
      ...common,
    ];
  }
  return [
    "--headless=new",
    "--use-gl=angle",
    "--use-angle=gl-egl",
    "--ignore-gpu-blocklist",
    "--enable-gpu-rasterization",
    ...common,
  ];
}

export class QcLiveSession {
  constructor({ driverUrl = null, pageUrl = null, outDir = "/tmp/e2e-qc-live" } = {}) {
    this.driverUrl = driverUrl ? driverUrl.replace(/\/$/, "") : null;
    this.pageUrl = pageUrl;
    this.httpUrl = null;
    this.outDir = outDir;
    this.browser = null;
    this.context = null;
    this.page = null;
    this.extraContexts = [];
    this.extraBrowsers = [];
    this.heavyHold = null;
    this.consoleMessages = [];
    this.pageErrors = [];
    this._warnMessages = [];
  }

  _defaultPageUrl(account = process.env.ACCOUNT || "tailnet1", password = process.env.PASSWORD || "tailnet1", extra = {}) {
    const q = new URLSearchParams({
      nosw: "1",
      autoLogin: "1",
      account,
      password,
      autoSpawn: "first",
      bridge_url: "ws://127.0.0.1:8080/",
      server_host: "127.0.0.1",
      server_port: "9000",
      quality: extra.quality || "ultra",
      clouds: extra.clouds || "on",
      camDebug: "on",
      vehicles: "on",
      skytime: process.env.SKYTIME || "0.5",
      cloudCoverage: process.env.COVERAGE || "0.45",
      adaptiveRes: "off",
      portalSpace: "off",
      atmosphereLut: "load",
    });
    return `http://127.0.0.1:8765/apps/holtburger-web/index.html?${q}`;
  }

  async _attachPageObservers(page) {
    page.on("console", (m) => {
      if (m.type() === "warning" && /threw|error|exception/i.test(m.text())) {
        this._warnMessages.push(m.text());
      }
      if (m.type() === "error") {
        const text = m.text();
        const locUrl = m.location?.()?.url || "";
        const isOptionalProbe404 =
          text === "Failed to load resource: the server responded with a status of 404 (File not found)" &&
          /(?:\/dist\/events\/index\.bin|\/scene3d\/assets\/(?:terrain_bc7\/t(?:1024|512|256)|pbr_terrain)\/manifest\.json)$/.test(locUrl);
        if (!isOptionalProbe404) this.consoleMessages.push(text);
      }
    });
    page.on("pageerror", (e) => {
      this.pageErrors.push(String(e?.stack || e));
    });
  }

  async _bootPageInWorld(page, url, charName = "TailnetOne") {
    let inWorld = false;
    let createdTestChar = false;
    for (let attempt = 1; attempt <= 4 && !inWorld; attempt++) {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120000 });
      const t0 = Date.now();
      while (Date.now() - t0 < 180000) {
        const st = await page
          .evaluate(() => ({
            s: window.__bootState,
            w: (window.__bootStateHistory || []).some((x) => x.state === "in-world") &&
              (window.__bootState === "ready" || !!window.__sceneReadyEverFired) &&
              !!window.liveScene3d &&
              window.__sessionHandle?.getLocalPlayerPose?.() !== undefined,
          }))
          .catch(() => ({}));
        if (st.w) {
          inWorld = true;
          break;
        }
        if ((st.s === "char-list-ready" || st.s === "error") && !createdTestChar) {
          const charInfo = await page
            .evaluate(() => ({
              len: window.__sessionHandle?.characterList?.()?.length ?? -1,
              canCreate: !!window.__sessionHandle?.canCreateCharacter,
            }))
            .catch(() => ({}));
          if (charInfo.len === 0 && charInfo.canCreate) {
            createdTestChar = true;
            await page
              .evaluate((nm) => window.__sessionHandle?.createTestCharacter?.(nm), charName)
              .catch(() => {});
            const c0 = Date.now();
            while (Date.now() - c0 < 10000) {
              const n = await page
                .evaluate(() => window.__sessionHandle?.characterList?.()?.length ?? 0)
                .catch(() => 0);
              if (n > 0) break;
              await new Promise((r) => setTimeout(r, 250));
            }
            break;
          }
        }
        if (st.s === "error") {
          await new Promise((r) => setTimeout(r, 8000));
          break;
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    if (!inWorld) {
      throw new Error(`LIVE_BOOT_TIMEOUT: failed to reach in-world state for ${charName}`);
    }
    if (/[?&]vehicles=on\b/i.test(url)) {
      const vt0 = Date.now();
      let vReady = false;
      let lastStatus = null;
      while (Date.now() - vt0 < 15000) {
        lastStatus = await page
          .evaluate(() => window.__vehicles?.status?.() || null)
          .catch(() => null);
        if (lastStatus && lastStatus.caps && (lastStatus.caps.granted & 0x03) === 0x03) {
          vReady = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 150));
      }
      if (!vReady) {
        throw new Error(`LIVE_VEHICLES_TIMEOUT: window.__vehicles.status().caps (0x03) unavailable after 15000ms for ${charName} (granted=${lastStatus?.caps?.granted ?? "none"})`);
      }
    }
  }

  async _installContextInitScript(ctx) {
    await ctx.addInitScript(() => {
      window.__e2eUnhandled = [];
      window.addEventListener("unhandledrejection", (e) => {
        window.__e2eUnhandled.push(String(e?.reason?.stack || e?.reason || e));
      });
      const origGetContext = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (type, attrs) {
        if (type === "webgl" || type === "webgl2") {
          attrs = { ...(attrs || {}), preserveDrawingBuffer: true };
        }
        return origGetContext.call(this, type, attrs);
      };
    });
  }

  async connect() {
    mkdirSync(this.outDir, { recursive: true });
    if (this.driverUrl) {
      const res = await fetch(`${this.driverUrl}/chat`).catch((e) => {
        throw new Error(`DRIVER_UNREACHABLE: ${this.driverUrl} (${e.message})`);
      });
      if (!res.ok) throw new Error(`DRIVER_UNREACHABLE: ${this.driverUrl} returned ${res.status}`);
      this.httpUrl = this.pageUrl || this._defaultPageUrl();
      await this.evalInPage(`
        if (!window.__e2eErrors) {
          window.__e2eErrors = [];
          window.addEventListener("error", (e) => window.__e2eErrors.push(String(e?.error?.stack || e?.message || e)));
          window.addEventListener("unhandledrejection", (e) => window.__e2eErrors.push(String(e?.reason?.stack || e?.reason || e)));
        }
        if (!window.__e2eConsoleWrapped && typeof console !== "undefined" && typeof console.error === "function") {
          window.__e2eConsoleWrapped = true;
          const origErr = console.error.bind(console);
          console.error = (...args) => {
            try { window.__e2eErrors.push(args.map((a) => (a && a.stack) ? a.stack : String(a)).join(" ")); } catch (_) {}
            return origErr(...args);
          };
        }
        return true;
      `);
      if (/[?&]vehicles=on\b/i.test(this.httpUrl)) {
        await this.waitUntil(
          async () => await this.evalInPage(`const st = window.__vehicles?.status?.(); return !!(st?.caps && (st.caps.granted & 0x03) === 0x03);`),
          15000,
          150,
          "driver window.__vehicles caps 0x03"
        ).catch(() => {});
      }
      return;
    }

    this.httpUrl = this.pageUrl || this._defaultPageUrl();
    const u = new URL(this.httpUrl);
    const httpPort = Number(u.port || (u.protocol === "https:" ? 443 : 80));
    if (!(await checkTcpReachable(u.hostname, httpPort, 2500))) {
      throw new Error(`SERVER_DOWN: serve.py / HTTP server unreachable at ${u.hostname}:${httpPort}`);
    }
    const bridgeUrl = u.searchParams.get("bridge_url") || "ws://127.0.0.1:8080/";
    const bu = new URL(bridgeUrl);
    const wsPort = Number(bu.port || (bu.protocol === "wss:" ? 443 : 80));
    if (!(await checkTcpReachable(bu.hostname, wsPort, 2500))) {
      throw new Error(`SERVER_DOWN: wsbridge unreachable at ${bu.hostname}:${wsPort}`);
    }

    this.heavyHold = await acquireHeavyLock({ label: "e2e-qc-vehicles-live" });
    const { chromium } = resolvePlaywrightCore();
    const executablePath = resolveChromeExecutable();
    this.browser = await chromium.launch({
      ...(executablePath ? { executablePath } : {}),
      headless: true,
      args: buildChromeLaunchArgs(),
    });
    this.context = await this.browser.newContext();
    await this._installContextInitScript(this.context);
    this.page = await this.context.newPage();
    await this.page.setViewportSize({ width: 1920, height: 1080 });
    await this._attachPageObservers(this.page);

    try {
      await this._bootPageInWorld(this.page, this.httpUrl, "TailnetOne");
    } catch (err) {
      await this.close();
      throw err;
    }
    await this.ensureOutdoorFlatSite();
  }

  async openSecondContext(account, password, charName = "TailnetTwo") {
    let browser = this.browser;
    if (!browser) {
      const { chromium } = resolvePlaywrightCore();
      const executablePath = resolveChromeExecutable();
      browser = await chromium.launch({
        ...(executablePath ? { executablePath } : {}),
        headless: true,
        args: buildChromeLaunchArgs(),
      });
      this.extraBrowsers.push(browser);
    }
    const ctx = await browser.newContext();
    this.extraContexts.push(ctx);
    await this._installContextInitScript(ctx);
    const page = await ctx.newPage();
    await page.setViewportSize({ width: 1280, height: 720 });
    await this._attachPageObservers(page);

    const u = new URL(this.httpUrl || this._defaultPageUrl());
    u.searchParams.set("account", account);
    u.searchParams.set("password", password);
    u.searchParams.set("autoLogin", "1");
    u.searchParams.set("autoSpawn", "first");
    u.searchParams.set("quality", "medium");
    u.searchParams.set("netDrainHz", "30");
    u.searchParams.set("clouds", "off");
    u.searchParams.set("renderOnDemand", "1");
    u.searchParams.set("nullRender", "1");
    await this._bootPageInWorld(page, u.toString(), charName);

    return {
      page,
      ctx,
      evalInPage: async (body) => await page.evaluate(`(async () => { ${body} })()`),
      sendChat: async (cmd) => await page.evaluate(`window.__sessionHandle.sendChat(${JSON.stringify(cmd)})`),
      getPlayerGlobalPose: async () => await page.evaluate(() => {
        const p = window.__sessionHandle?.getLocalPlayerPose?.();
        if (!p) return null;
        const c = p.landblockId >>> 0;
        const lbX = (c >>> 24) & 0xff;
        const lbY = (c >>> 16) & 0xff;
        const isD = ((c >>> 15) & 1) === 1;
        const rawYaw = Number(p.heading);
        const compassHeading = Number.isFinite(rawYaw)
          ? ((((-rawYaw) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)) || 0
          : 0;
        return {
          landblockId: c,
          cellInLb: c & 0xffff,
          lx: p.x,
          ly: p.y,
          gx: lbX * 192 + p.x,
          gy: (isD ? 68928 : 0) + lbY * 192 + p.y,
          z: p.z,
          heading: compassHeading,
          isDericost: isD,
        };
      }),
      close: async () => { await ctx.close().catch(() => {}); },
    };
  }

  async closeSecondContexts() {
    while (this.extraContexts.length > 0) {
      const ctx = this.extraContexts.pop();
      await ctx.close().catch(() => {});
    }
    while (this.extraBrowsers.length > 0) {
      const b = this.extraBrowsers.pop();
      await b.close().catch(() => {});
    }
  }

  async evalInPage(body) {
    if (this.driverUrl) {
      const res = await fetch(`${this.driverUrl}/eval`, { method: "POST", body });
      const json = await res.json();
      if (!json.ok) throw new Error(json.err || "driver /eval failed");
      return json.r;
    }
    return await this.page.evaluate(`(async () => { ${body} })()`);
  }

  async getChatLines() {
    const readDom = `
      const hasPanel = !!document.querySelector("#hb-chat-panel .hb-chat-log, #hb-chat-panel, #chat-log");
      const items = [...document.querySelectorAll("#hb-chat-panel .hb-chat-log .hb-chat-line, #chat-log li:not(.empty), .chat-line, .chat-message")]
        .map((e) => (e.textContent || "").trim())
        .filter(Boolean);
      if (!hasPanel && items.length === 0) return null;
      return items;
    `;
    if (this.driverUrl) {
      const fromDom = await this.evalInPage(readDom).catch(() => null);
      if (Array.isArray(fromDom)) return fromDom;
      const res = await fetch(`${this.driverUrl}/chat`);
      const json = await res.json();
      return (json.r || []).map((s) => String(s).trim()).filter(Boolean);
    }
    return await this.page.evaluate(() =>
      [...document.querySelectorAll("#hb-chat-panel .hb-chat-log .hb-chat-line, #chat-log li:not(.empty), .chat-line, .chat-message")]
        .map((e) => (e.textContent || "").trim())
        .filter(Boolean)
    );
  }

  async sendChat(cmd) {
    await this.evalInPage(`window.__sessionHandle.sendChat(${JSON.stringify(cmd)}); return true;`);
  }

  async sendChatAndWait(cmd, pattern, timeoutMs = 8000) {
    const before = await this.getChatLines();
    await this.sendChat(cmd);
    const re = pattern instanceof RegExp ? pattern : new RegExp(pattern, "i");
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const lines = await this.getChatLines();
      let fresh;
      if (before.length === 0) {
        fresh = lines;
      } else if (lines.length >= before.length && before.every((v, i) => lines[i] === v)) {
        fresh = lines.slice(before.length);
      } else {
        const anchorLen = Math.min(3, before.length);
        const anchor = before.slice(-anchorLen);
        let cut = -1;
        for (let i = lines.length - anchorLen; i >= 0; i--) {
          if (anchor.every((v, k) => lines[i + k] === v)) { cut = i + anchorLen; break; }
        }
        fresh = cut >= 0 ? lines.slice(cut) : lines;
      }
      const hit = fresh.find((l) => re.test(l));
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`Chat command "${cmd}" timed out waiting for ${re}`);
  }

  async dispatchKey(code, { key = code.replace(/^Key/, "").toLowerCase(), shiftKey = false, blurActive = true } = {}) {
    return await this.evalInPage(`
      if (${JSON.stringify(blurActive)} && document.activeElement && document.activeElement !== document.body && typeof document.activeElement.blur === "function") {
        document.activeElement.blur();
      }
      const down = new KeyboardEvent("keydown", { key: ${JSON.stringify(key)}, code: ${JSON.stringify(code)}, shiftKey: ${Boolean(shiftKey)}, bubbles: true, cancelable: true });
      const up = new KeyboardEvent("keyup", { key: ${JSON.stringify(key)}, code: ${JSON.stringify(code)}, shiftKey: ${Boolean(shiftKey)}, bubbles: true, cancelable: true });
      window.dispatchEvent(down);
      window.dispatchEvent(up);
      return { defaultPrevented: down.defaultPrevented };
    `);
  }

  async waitUntil(fn, timeoutMs = 12000, intervalMs = 200, label = "condition") {
    const t0 = Date.now();
    let lastErr = null;
    while (Date.now() - t0 < timeoutMs) {
      try {
        const r = await fn();
        if (r) return r;
      } catch (e) { lastErr = e; }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    throw new Error(`Timed out after ${timeoutMs}ms waiting for ${label}${lastErr ? `: ${lastErr.message}` : ""}`);
  }

  async hideHud() {
    await this.evalInPage(`
      let st = document.getElementById("__e2e_hide_hud");
      if (!st) {
        st = document.createElement("style");
        st.id = "__e2e_hide_hud";
        st.textContent = "[id^=hb-]{visibility:hidden!important}";
        document.head.appendChild(st);
      }
      return true;
    `);
  }

  async showHud() {
    await this.evalInPage(`document.getElementById("__e2e_hide_hud")?.remove(); return true;`);
  }

  async orbitCam(x, y, z, dist, az, el) {
    await this.evalInPage(`window.__cam?.orbit?.(${x}, ${y}, ${z}, ${dist}, ${az}, ${el}); return true;`);
  }

  async getPlayerGlobalPose() {
    return await this.evalInPage(`
      const p = window.__sessionHandle?.getLocalPlayerPose?.();
      if (!p) return null;
      const c = p.landblockId >>> 0;
      const lbX = (c >>> 24) & 0xff;
      const lbY = (c >>> 16) & 0xff;
      const isD = ((c >>> 15) & 1) === 1;
      const rawYaw = Number(p.heading);
      const compassHeading = Number.isFinite(rawYaw)
        ? ((((-rawYaw) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)) || 0
        : 0;
      return {
        landblockId: c,
        cellInLb: c & 0xffff,
        isDericost: isD,
        lx: p.x,
        ly: p.y,
        gx: lbX * 192 + p.x,
        gy: (isD ? 68928 : 0) + lbY * 192 + p.y,
        z: p.z,
        heading: compassHeading,
      };
    `);
  }

  async ensureOutdoorFlatSite() {
    if (this.driverUrl) return;
    const p0 = await this.getPlayerGlobalPose().catch(() => null);
    const needsTele =
      !p0 ||
      p0.isDericost ||
      p0.cellInLb >= 0x0100 ||
      ((p0.landblockId >>> 16) & 0xffff) !== 0xa9b3 ||
      Math.hypot(p0.gx - 32467.2, p0.gy - 34392.0) > 4.0;
    if (needsTele) {
      if (!p0 || p0.isDericost || ((p0.landblockId >>> 16) & 0xffff) !== 0xa9b3) {
        await this.sendChatAndWait("@tele 41.35N 33.33E", /Position:\s*\[Cell:/i, 12000).catch(() => {});
      }
      await this.sendChat("@teleloc 0xA9B30002 19.20 24.00 94.00");
    }
    await this.waitUntil(async () => {
      return await this.evalInPage(`
        const sh = window.__sessionHandle;
        const p = sh?.getLocalPlayerPose?.();
        if (!p) return false;
        const c = p.landblockId >>> 0;
        if (((c >>> 15) & 1) !== 0) return false;
        if (((c >>> 16) & 0xffff) !== 0xa9b3) return false;
        const gx = ((c >>> 24) & 0xff) * 192 + p.x;
        const gy = ((c >>> 16) & 0xff) * 192 + p.y;
        const tz = sh.terrainHeightAt?.(gx, gy);
        return Number.isFinite(tz) && Math.hypot(gx - 32467.2, gy - 34392.0) <= 4.0;
      `);
    }, 15000, 200, "Dereth 0xA9B30002 flat terrain ready");
  }

  async ensureDericostFlatSite(site = DERICOS_FLAT_SITE) {
    await this.sendChat(`@teleloc ${site.cellHex} ${site.lx.toFixed(2)} ${site.ly.toFixed(2)} ${site.z.toFixed(2)}`);
    return await this.waitUntil(async () => {
      return await this.evalInPage(`
        const sh = window.__sessionHandle;
        const p = sh?.getLocalPlayerPose?.();
        if (!p) return null;
        const c = p.landblockId >>> 0;
        if (((c >>> 15) & 1) !== 1) return null;
        const gx = ((c >>> 24) & 0xff) * 192 + p.x;
        const gy = 68928 + ((c >>> 16) & 0xff) * 192 + p.y;
        const tz = sh.terrainHeightAt?.(gx, gy);
        if (!Number.isFinite(tz)) return null;
        if (Math.hypot(gx - ${site.gx}, gy - ${site.gy}) > 6.0) return null;
        return { landblockId: c, gx, gy, z: p.z, tz };
      `);
    }, 20000, 250, `Dericost ${site.cellHex} flat terrain ready`);
  }

  async movePlayerNear(worldPos, offset = [0, -1.5, 0]) {
    const tx = worldPos[0] + (offset[0] ?? 0);
    const ty = worldPos[1] + (offset[1] ?? 0);
    const tz = worldPos[2] + (offset[2] ?? 0);
    const cl = toCellLocal(tx, ty, tz);
    await this.sendChat(`@teleloc 0x${cl.cell.toString(16)} ${cl.x.toFixed(2)} ${cl.y.toFixed(2)} ${cl.z.toFixed(2)}`);
    await this.waitUntil(async () => {
      const p = await this.getPlayerGlobalPose();
      return p && Math.hypot(p.gx - tx, p.gy - ty) <= 2.5 ? p : null;
    }, 8000, 150, "player moved near target");
  }

  async captureAndVerifyShot(name) {
    let filePath;
    if (this.driverUrl) {
      const res = await fetch(`${this.driverUrl}/shot?name=${encodeURIComponent(name)}`);
      const json = await res.json();
      if (!json.ok) throw new Error(json.err || "driver /shot failed");
      filePath = json.f;
    } else {
      filePath = path.join(this.outDir, `${name}.png`);
      await this.page.screenshot({ path: filePath, type: "png" });
    }
    assert(existsSync(filePath), `Screenshot missing: ${filePath}`);
    const st = statSync(filePath);
    assert(st.size > 10 * 1024, `Screenshot ${filePath} too small (${st.size}B <= 10KB)`);
    const info = parsePngDimensionsAndEntropy(readFileSync(filePath));
    assert(info.valid, `Screenshot ${filePath} invalid or uniform: ${JSON.stringify(info)}`);
    return { path: filePath, bytes: st.size, ...info };
  }

  async getTrailer(tGuid) {
    return await this.evalInPage(`
      const t = window.__vehicles?.trailers?.list?.()?.find((x) => (x.guid >>> 0) === (${tGuid} >>> 0));
      return t || null;
    `);
  }

  async getContainer(cGuid) {
    return await this.evalInPage(`
      const c = window.__vehicles?.containers?.list?.()?.find((x) => (x.guid >>> 0) === (${cGuid} >>> 0));
      const raw = window.__vehicles?.containers?.get?.(${cGuid} >>> 0);
      if (!c && !raw) return null;
      return {
        guid: ${cGuid} >>> 0,
        kind: c?.kind ?? raw?.kind ?? 10,
        pos: c?.pos ?? null,
        doorProgress: c?.doorProgress ?? raw?.currentDoorProgress ?? 0,
        doorOpen: c?.doorOpen ?? false,
        heading: raw?.heading ?? raw?.last?.heading ?? 0,
        slots: raw?.slots ?? raw?.last?.slots ?? [],
        mountedOnTrailerGuid: raw?.mountedOnTrailerGuid ?? raw?.last?.mountedOnTrailerGuid ?? 0,
      };
    `);
  }

  async cleanupWorld() {
    await this.closeSecondContexts().catch(() => {});
    await this.evalInPage(`
      try { window.__vehicles?.exit?.(0); } catch (_) {}
      try { window.__vehicles?.palletJacks?.release?.(); } catch (_) {}
      return true;
    `).catch(() => {});
    await this.sendChat("@vehicle despawn all").catch(() => {});
    await this.sendChat("@trailer despawn all").catch(() => {});
    await this.sendChat("@container despawn all").catch(() => {});
    await this.sendChat("@deployable despawn all").catch(() => {});
    await this.sendChat("@palletjack despawn all").catch(() => {});
    await this.waitUntil(() => this.evalInPage(`
      const a = window.__vehicles;
      if (!a) return true;
      return a.vehicles().length === 0 &&
        a.trailers.list().length === 0 &&
        a.containers.list().length === 0 &&
        a.palletJacks.list().length === 0 &&
        a.deployables.list().length === 0;
    `), 2500, 100, "world cleanup").catch(() => {});
  }

  async checkConsoleErrors() {
    let all = [...this.consoleMessages, ...this.pageErrors];
    if (this.driverUrl) {
      const errs = await this.evalInPage(`return window.__e2eErrors || [];`).catch(() => []);
      all = all.concat(errs);
    }
    return filterErrors(all);
  }

  async close() {
    await this.closeSecondContexts().catch(() => {});
    try { await this.browser?.close(); } catch (_) {}
    this.browser = null;
    try { this.heavyHold?.release(); } catch (_) {}
    this.heavyHold = null;
  }
}
