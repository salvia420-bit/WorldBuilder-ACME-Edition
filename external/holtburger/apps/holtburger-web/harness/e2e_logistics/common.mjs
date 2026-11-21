// harness/e2e_logistics/common.mjs — Shared opaque-box E2E infrastructure for
// ISO Intermodal Logistics Integration (HBV1 v7: Sidelifter 4000032, Walk-Behind Pallet Jack 4000035,
// ISO 3874/3691-5/6780/1161/668 safety interlocks, Pinwheel LIFO solver, Deployable IsStowed & CargoState).
//
// Derived strictly from ORIGINAL_REQUEST.md, PROJECT.md § Interface Contracts,
// iso_intermodal_logistics_plan.md, and vehicles.protocol.xml v7 specification.

import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import net from "node:net";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { inflateSync } from "node:zlib";

import { filterErrors } from "../lib/console_allowlist.mjs";
import { acquireHeavyLock } from "../lib/heavy_lock.mjs";
import { requireThree } from "../lib/locate_three.mjs";
import { createFakeWebGL2, fakeCanvas } from "../../tests/helpers/fake_webgl2.mjs";
import { installFakeAudio } from "../../tests/helpers/fake_audio_context.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const HARNESS_ROOT = path.resolve(HERE, "..");
export const APP_ROOT = path.resolve(HARNESS_ROOT, "..");
export const HOLTBURGER_ROOT = path.resolve(APP_ROOT, "..", "..");
export const REPO_ROOT = path.resolve(HOLTBURGER_ROOT, "..", "..");
export const PROTOCOL_DIR = path.join(APP_ROOT, "docs", "vehicles-2026-11-01", "protocol");
export const ACE_ROOT = process.env.ACE_SERVER_DIR || "/workspace/wb/home/ace-server";

export { createFakeWebGL2, fakeCanvas, installFakeAudio, filterErrors, acquireHeavyLock };

let cachedThree = null;
export async function getThree() {
  if (!cachedThree) {
    cachedThree = await requireThree("e2e-logistics-loop");
  }
  return cachedThree;
}

// =============================================================================
// Authoritative ISO & HBV1 v7 Specification Constants
// =============================================================================

export const DERICOST_Y_OFFSET = 68928.0; // 359 * 192.0
export const TWO_PI = 2.0 * Math.PI;
export const HBV1_TAG = 0x31564248; // "HBV1" LE u32
export const HBV1_VERSION_V6 = 6;
export const HBV1_VERSION_V7 = 7;
export const AC_C2S_FRAME = 0x0000f7b1;
export const AC_S2C_FRAME = 0x0000f7b0;

export const OPCODES = Object.freeze({
  Vehicle_ClientCapabilities: 0x0900,
  Vehicle_CapabilitiesAck: 0x0900,
  Vehicle_Profile: 0x0901,
  Vehicle_Board: 0x0902,
  Vehicle_Exit: 0x0903,
  Vehicle_Seat: 0x0904,
  Vehicle_Input: 0x0905,
  Vehicle_State: 0x0906,
  Vehicle_Fire: 0x0907,
  Vehicle_Event: 0x0908,
  Vehicle_Cargo: 0x0909,
  Vehicle_RadarContacts: 0x090a,
  Vehicle_DeployableState: 0x090b,
  Vehicle_DeployableFire: 0x090c,
  Vehicle_GroundContacts: 0x090d,
  Vehicle_ContainerAction: 0x090e,
  Vehicle_ContainerState: 0x090e,
  Vehicle_TrailerAction: 0x090f,
  Vehicle_TrailerState: 0x090f,
  Vehicle_PalletJackAction: 0x0910,
  Vehicle_PalletJackState: 0x0910,
});

export const DEPLOYABLE_KIND = Object.freeze({
  None: 0,
  RadarStation: 1,
  FluxPod: 2,
  SolarPanels: 3,
  PowerGenerator: 4,
  BatteryUnit: 5,
  MissileTurret: 6,
  GroundRadar: 7,
  MortarTurret: 8,
  HeavyLaserTurret: 9,
  IsoContainer20: 10,
  IsoContainer40: 11,
  IsoContainer40HC: 12,
  TrailerChassis20: 13,
  TrailerChassis40: 14,
  TrailerSidelifter40: 15,
  PalletJack: 16,
});

export const TRAILER_ACTION_KIND = Object.freeze({
  None: 0,
  Hitch: 1,
  Unhitch: 2,
  ToggleTwistlock: 3,
  MountContainer: 4,
  UnmountContainer: 5,
  DeployOutriggers: 6,
  RetractOutriggers: 7,
  SideliftOffload: 8,
  SideliftLoad: 9,
  StowPalletJack: 10,
  DeployPalletJack: 11,
  CancelSidelift: 12,
  AutoOffload: 13,
  AutoLoad: 14,
});

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

export const PALLET_JACK_ACTION_KIND = Object.freeze({
  None: 0,
  Grab: 1,
  Release: 2,
  UpdatePose: 3,
  RaiseForks: 4,
  LowerForks: 5,
  PickGroundDeployable: 6,
  DropToGround: 7,
  PickContainerSlot: 8,
  LoadContainerSlot: 9,
  ToggleDeployableStow: 10,
});

export const VEHICLE_EVENT_KIND = Object.freeze({
  Takeoff: 1,
  Landed: 2,
  Crashed: 3,
  Despawn: 4,
  Bail: 5,
  Chute: 6,
  Touchdown: 7,
  Hit: 8,
  BombRelease: 9,
  Explosion: 10,
  Rearmed: 11,
  Horn: 12,
  Headlights: 13,
  Scrape: 14,
  CargoDeployed: 15,
  CargoPacked: 16,
  RamHit: 17,
  RadarAlert: 18,
  TrailerHitched: 19,
  TrailerUnhitched: 20,
  TwistlockToggled: 21,
  SideliftStarted: 22,
  SideliftComplete: 23,
  SideliftRefused: 24,
  PalletJackEvent: 25,
});

export const TRAILER_FLAGS = Object.freeze({
  Coupled: 0x01,
  TwistlocksLocked: 0x02,
  GearRetracted: 0x04,
  BrakeLights: 0x08,
});

export const SIDELIFT_FLAGS = Object.freeze({
  IsSidelifter: 0x01,
  OutriggersPlanted: 0x02,
  CranesActive: 0x04,
  HasStowedPalletJack: 0x08,
  IsLoadDirection: 0x10,
});

export const PALLET_JACK_FLAGS = Object.freeze({
  Carrying: 0x01,
  OnContainerRampOrFloor: 0x02,
  Stowed: 0x04,
});

export const FORK_STATE = Object.freeze({
  Lowered: 0,
  Raising: 1,
  Raised: 2,
  Lowering: 3,
});

export const ONLINE_FLAGS = Object.freeze({
  Powered: 0x01,
  InFluxRange: 0x02,
  Active: 0x04,
  Elevated: 0x08,
  Stowed: 0x10,
});

export const LOGISTICS_SPEC = Object.freeze({
  sidelifter: Object.freeze({
    wcid: 4000032,
    deployableKind: 15,
    maxDrawCalls: 14,
    maxLights: 0,
    chassisDeckZ: 1.32,
    chassisKingpinZ: 0.96,
    kingpinY: 5.35,
    bogieY: -4.445,
    wheelbase: 9.795,
    outreachX: 3.85,
    outriggerReachX: 3.60,
    hoistClearanceZ: 0.45,
    maxSlopeDeg: 6.0,
    maxSlopeCos: 0.9945,
    parkedSpeedMax: 0.25,
    doorOpenThreshold: 0.01,
    craneSpanY20: 2.9265,
    craneSpanY40: 5.9925,
    rackLocalPos: Object.freeze([-0.95, -1.6, 0.55]),
    proximityRangeM: 12.0,
    phaseDurationsSec: Object.freeze({
      outriggers: 2.2,
      craneSlide: 1.5,
      latch: 0.8,
      hoist: 1.8,
      swing: 3.0,
      lower: 2.0,
      release: 0.7,
      stow: 1.5,
    }),
  }),
  palletJack: Object.freeze({
    wcid: 4000035,
    deployableKind: 16,
    standInSetup: 0x0200026b,
    maxDrawCalls: 6,
    maxLights: 0,
    forkLengthM: 1.150,
    forkSpreadM: 0.685,
    forkBladeWidthM: 0.160,
    forkLoweredM: 0.085,
    forkRaisedM: 0.200,
    forkPickupMaxM: 0.100,
    tillerHeightM: 1.22,
    maxTillerRad: 1.65, // ~95 deg
    wheelbaseM: 1.18,
    operatorBehindTillerM: 0.62,
    speedEmptyMps: 2.2,
    speedLoadedMps: 1.6,
    speedRampMps: 1.1,
    serverSpeedCapMps: 3.2,
    maxRampGradeDeg: 12.0,
    grabRangeM: 3.0,
    serverGrabRangeM: 3.5,
    groundPickRangeM: 1.6,
    slotPickRangeM: 1.8,
    elevMaxM: 0.02,
    assistMaxDistM: 0.55,
    assistMaxYawDeg: 28.0,
    assistMaxYawRad: (28.0 * Math.PI) / 180.0,
    poseSyncHz: 15,
  }),
  containers: Object.freeze({
    10: Object.freeze({ wcid: 4000020, kind: 10, key: "20ft", extW: 2.438, extL: 6.058, extH: 2.591, intW: 2.352, intL: 5.898, intH: 2.393, floorZ: 0.162, rampLen: 0.85, rampPitchRad: 0.1918, maxFull: 10, maxHalf: 10 }),
    11: Object.freeze({ wcid: 4000021, kind: 11, key: "40ft", extW: 2.438, extL: 12.192, extH: 2.591, intW: 2.352, intL: 12.032, intH: 2.393, floorZ: 0.162, rampLen: 0.85, rampPitchRad: 0.1918, maxFull: 20, maxHalf: 20 }),
    12: Object.freeze({ wcid: 4000022, kind: 12, key: "40hc", extW: 2.438, extL: 12.192, extH: 2.896, intW: 2.352, intL: 12.032, intH: 2.698, floorZ: 0.162, rampLen: 0.85, rampPitchRad: 0.1918, maxFull: 20, maxHalf: 20 }),
  }),
  trailers: Object.freeze({
    "20ft": Object.freeze({ wcid: 4000030, kind: 13, kpY: 2.80, bogieY: -1.895, wheelbase: 4.695, deckZ: 1.32, kingpinZ: 0.96 }),
    "40ft": Object.freeze({ wcid: 4000031, kind: 14, kpY: 5.35, bogieY: -4.445, wheelbase: 9.795, deckZ: 1.32, kingpinZ: 0.96 }),
    sidelifter: Object.freeze({ wcid: 4000032, kind: 15, kpY: 5.35, bogieY: -4.445, wheelbase: 9.795, deckZ: 1.32, kingpinZ: 0.96 }),
  }),
  towMassMul: Object.freeze({
    bobtail: 1.0,
    emptyChassis: 0.72,
    loaded40ft: 0.58,
  }),
  allDeployables: Object.freeze([
    Object.freeze({ wcid: 4000002, kind: 1, name: "RadarStation", pallet: "full", powerW: -800 }),
    Object.freeze({ wcid: 4000010, kind: 2, name: "FluxPod", pallet: "full", powerW: 0 }),
    Object.freeze({ wcid: 4000011, kind: 3, name: "SolarPanels", pallet: "full", powerW: 12000 }),
    Object.freeze({ wcid: 4000012, kind: 4, name: "PowerGenerator", pallet: "full", powerW: 45000 }),
    Object.freeze({ wcid: 4000013, kind: 5, name: "BatteryUnit", pallet: "full", powerW: 0 }),
    Object.freeze({ wcid: 4000014, kind: 6, name: "MissileTurret", pallet: "full", powerW: -2500 }),
    Object.freeze({ wcid: 4000015, kind: 7, name: "GroundRadar", pallet: "full", powerW: -1200 }),
    Object.freeze({ wcid: 4000016, kind: 8, name: "MortarTurret", pallet: "full", powerW: -1800 }),
    Object.freeze({ wcid: 4000017, kind: 9, name: "HeavyLaserTurret", pallet: "full", powerW: -15000 }),
  ]),
});

export const ALL_9_DEPLOYABLES = LOGISTICS_SPEC.allDeployables;
export const HALF_PALLET_WCIDS = Object.freeze(new Set());

export const CONTAINER_SLOTS_20 = Object.freeze((() => {
  const slots = [];
  const rowYs = [+2.320, +1.160, 0.000, -1.160, -2.320];
  for (let r = 0; r < rowYs.length; r++) {
    const y = rowYs[r];
    slots.push(
      Object.freeze({ slotIndex: 2 * r + 0, x: -0.575, y, orient: "Y", dx: 1.100, dy: 1.100 }),
      Object.freeze({ slotIndex: 2 * r + 1, x: +0.575, y, orient: "Y", dx: 1.100, dy: 1.100 })
    );
  }
  return Object.freeze(slots);
})());

export const CONTAINER_SLOTS_40 = Object.freeze((() => {
  const slots = [];
  for (let r = 0; r < 10; r++) {
    const y = Number(((4.5 - r) * 1.180).toFixed(3));
    slots.push(
      Object.freeze({ slotIndex: 2 * r + 0, x: -0.575, y, orient: "Y", dx: 1.100, dy: 1.100 }),
      Object.freeze({ slotIndex: 2 * r + 1, x: +0.575, y, orient: "Y", dx: 1.100, dy: 1.100 })
    );
  }
  return Object.freeze(slots);
})());

export const PINWHEEL_SLOTS_20 = CONTAINER_SLOTS_20;
export const PINWHEEL_SLOTS_40 = CONTAINER_SLOTS_40;

// =============================================================================
// Assertions & Coordinate Helpers
// =============================================================================

export function assert(cond, msg = "assertion failed") {
  if (!cond) throw new Error(msg);
}

export function near(actual, expected, eps = 1e-4, label = "value") {
  if (!Number.isFinite(actual) || Math.abs(actual - expected) > eps) {
    throw new Error(`${label}: expected ${expected} ± ${eps}, got ${actual} (diff ${Math.abs(actual - expected)})`);
  }
}

export function wrapHeading(h) {
  return h - TWO_PI * Math.floor(h / TWO_PI);
}

export function wrapPi(a) {
  let d = a;
  while (d > Math.PI) d -= TWO_PI;
  while (d < -Math.PI) d += TWO_PI;
  return d;
}

export function angleDiff(a, b) {
  return wrapPi(a - b);
}

export function toGlobal(cell, lx, ly, lz = 0, continent = ((cell >>> 15) & 1)) {
  const cont = continent != null ? continent : ((cell >>> 15) & 1);
  const isDericost = (cont & 1) === 1;
  const lbX = (cell >>> 24) & 0xff;
  const lbY = (cell >>> 16) & 0xff;
  return [
    lbX * 192.0 + lx,
    (isDericost ? DERICOST_Y_OFFSET : 0.0) + lbY * 192.0 + ly,
    lz,
  ];
}

export function toCellLocal(gx, gy, gz = 0) {
  const continent = gy >= DERICOST_Y_OFFSET ? 1 : 0;
  const localGy = continent === 1 ? gy - DERICOST_Y_OFFSET : gy;
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const lbX = clamp(Math.floor(gx / 192.0), 0, 254);
  const lbY = clamp(Math.floor(localGy / 192.0), 0, 254);
  const lx = clamp(Math.fround(gx - lbX * 192.0), 0, 191.999);
  const ly = clamp(Math.fround(localGy - lbY * 192.0), 0, 191.999);
  const cellX = Math.floor(lx / 24.0);
  const cellY = Math.floor(ly / 24.0);
  const cellIdx = (cellX * 8 + cellY + 1) & 0x7fff;
  const cell = ((lbX << 24) | (lbY << 16) | ((continent & 1) << 15) | cellIdx) >>> 0;
  return { cell, x: lx, y: ly, z: gz, continent };
}

export function countDrawCalls(root) {
  let calls = 0;
  root.traverse((o) => {
    if (o.isMesh || o.isLine || o.isSprite || o.isPoints) calls++;
  });
  return calls;
}

export function countLights(root) {
  let lights = 0;
  root.traverse((o) => {
    if (o.isLight) lights++;
  });
  return lights;
}

// =============================================================================
// Independent Opaque-Box HBV1 v6 / v7 Binary Wire Codec
// =============================================================================

class BinWriter {
  constructor(initialCap = 256) {
    this.buf = new Uint8Array(initialCap);
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
  i8(v) { this._grow(1); this.dv.setInt8(this.pos, v); this.pos += 1; }
  u16(v) { this._grow(2); this.dv.setUint16(this.pos, v & 0xffff, true); this.pos += 2; }
  i16(v) { this._grow(2); this.dv.setInt16(this.pos, v, true); this.pos += 2; }
  u32(v) { this._grow(4); this.dv.setUint32(this.pos, v >>> 0, true); this.pos += 4; }
  f32(v) { this._grow(4); this.dv.setFloat32(this.pos, v ?? 0, true); this.pos += 4; }
  vec3(v) {
    const x = Array.isArray(v) ? v[0] : (v?.X ?? v?.x ?? 0);
    const y = Array.isArray(v) ? v[1] : (v?.Y ?? v?.y ?? 0);
    const z = Array.isArray(v) ? v[2] : (v?.Z ?? v?.z ?? 0);
    this.f32(x); this.f32(y); this.f32(z);
  }
  bytes(arr) {
    this._grow(arr.length);
    this.buf.set(arr, this.pos);
    this.pos += arr.length;
  }
  finish() {
    return this.buf.slice(0, this.pos);
  }
}

class BinReader {
  constructor(bytes) {
    this.buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    this.dv = new DataView(this.buf.buffer, this.buf.byteOffset, this.buf.byteLength);
    this.pos = 0;
  }
  remaining() { return this.buf.byteLength - this.pos; }
  _need(n) {
    if (this.pos + n > this.buf.byteLength) {
      throw new Error(`truncated HBV1 buffer: need ${n}B at ${this.pos}, len ${this.buf.byteLength}`);
    }
  }
  u8() { this._need(1); const v = this.dv.getUint8(this.pos); this.pos += 1; return v; }
  i8() { this._need(1); const v = this.dv.getInt8(this.pos); this.pos += 1; return v; }
  u16() { this._need(2); const v = this.dv.getUint16(this.pos, true); this.pos += 2; return v; }
  i16() { this._need(2); const v = this.dv.getInt16(this.pos, true); this.pos += 2; return v; }
  u32() { this._need(4); const v = this.dv.getUint32(this.pos, true); this.pos += 4; return v; }
  f32() { this._need(4); const v = this.dv.getFloat32(this.pos, true); this.pos += 4; return v; }
  vec3() { return { X: this.f32(), Y: this.f32(), Z: this.f32() }; }
}

export function encodeHeader(w, header = {}) {
  const tag = (header.Tag ?? HBV1_TAG) >>> 0;
  const ver = (header.Version ?? HBV1_VERSION_V7) & 0xffff;
  const res = (header.Reserved ?? 0) & 0xffff;
  w.u32(tag);
  w.u16(ver);
  w.u16(res);
  return ver;
}

export function decodeHeader(r) {
  if (r.remaining() < 8) return null;
  const Tag = r.u32();
  const Version = r.u16();
  const Reserved = r.u16();
  if (Tag !== HBV1_TAG || Version === 0) return null;
  return { Tag, Version, Reserved };
}

export function encodeTrailerAction(fields = {}, versionOverride = null) {
  const w = new BinWriter(24);
  const version = versionOverride ?? fields.Header?.Version ?? HBV1_VERSION_V7;
  encodeHeader(w, { ...(fields.Header || {}), Version: version });
  w.u32(fields.TrailerGuid ?? 0);
  w.u32(fields.VehicleGuid ?? 0);
  w.u32(fields.ContainerGuid ?? 0);
  w.u8(fields.Action ?? 0);
  w.u8(fields.Slot ?? 0);
  w.u16(fields.Flags ?? 0);
  return w.finish();
}

export function decodeTrailerAction(bytes) {
  const r = new BinReader(bytes);
  const Header = decodeHeader(r);
  if (!Header || Header.Version < HBV1_VERSION_V6 || r.remaining() < 16) return null;
  const out = {
    Header,
    TrailerGuid: r.u32(),
    VehicleGuid: r.u32(),
    ContainerGuid: r.u32(),
    Action: r.u8(),
    Slot: r.u8(),
    Flags: r.u16(),
  };
  out._bytesConsumed = r.pos;
  out._bytesTotal = r.buf.byteLength;
  return out;
}

export function encodeTrailerState(fields = {}, versionOverride = null) {
  const version = versionOverride ?? fields.Header?.Version ?? HBV1_VERSION_V7;
  const w = new BinWriter(version >= 7 ? 84 : 60);
  encodeHeader(w, { ...(fields.Header || {}), Version: version });
  w.u32(fields.TrailerGuid ?? 0);
  w.u32(fields.Kind ?? DEPLOYABLE_KIND.TrailerSidelifter40);
  w.u32(fields.Cell ?? 0);
  w.vec3(fields.Position ?? { X: 0, Y: 0, Z: 0 });
  w.f32(fields.Heading ?? 0);
  w.f32(fields.Pitch ?? 0);
  w.f32(fields.Bank ?? 0);
  w.u32(fields.CoupledTractorGuid ?? 0);
  w.u32(fields.MountedContainerGuid ?? 0);
  w.u8(fields.ContainerSlot ?? 0);
  w.u8(fields.TrailerFlags ?? 0);
  w.u16(fields.Reserved ?? 0);
  w.u32(fields.OwnerGuid ?? 0);
  if (version >= 7) {
    w.u8(fields.SideliftPhase ?? 0);
    w.i8(fields.SideliftSide ?? 1);
    w.u8(fields.SideliftFlags ?? 0);
    w.u8(fields.Reserved7 ?? 0);
    w.f32(fields.SideliftProgress ?? 0);
    w.f32(fields.OutriggerProgress ?? 0);
    w.f32(fields.CraneSpanY ?? LOGISTICS_SPEC.sidelifter.craneSpanY40);
    w.u32(fields.StowedPalletJackGuid ?? 0);
    w.u32(fields.TransferContainerGuid ?? 0);
  }
  return w.finish();
}

export function decodeTrailerState(bytes) {
  const r = new BinReader(bytes);
  const Header = decodeHeader(r);
  if (!Header || Header.Version < HBV1_VERSION_V6 || r.remaining() < 52) return null;
  const out = {
    Header,
    TrailerGuid: r.u32(),
    Kind: r.u32(),
    Cell: r.u32(),
    Position: r.vec3(),
    Heading: r.f32(),
    Pitch: r.f32(),
    Bank: r.f32(),
    CoupledTractorGuid: r.u32(),
    MountedContainerGuid: r.u32(),
    ContainerSlot: r.u8(),
    TrailerFlags: r.u8(),
    Reserved: r.u16(),
    OwnerGuid: r.u32(),
  };
  if (Header.Version >= 7) {
    if (r.remaining() < 24) return null;
    out.SideliftPhase = r.u8();
    out.SideliftSide = r.i8();
    out.SideliftFlags = r.u8();
    out.Reserved7 = r.u8();
    out.SideliftProgress = r.f32();
    out.OutriggerProgress = r.f32();
    out.CraneSpanY = r.f32();
    out.StowedPalletJackGuid = r.u32();
    out.TransferContainerGuid = r.u32();
  } else {
    out.SideliftPhase = 0;
    out.SideliftSide = 1;
    out.SideliftFlags = 0;
    out.Reserved7 = 0;
    out.SideliftProgress = 0;
    out.OutriggerProgress = 0;
    out.CraneSpanY = LOGISTICS_SPEC.sidelifter.craneSpanY40;
    out.StowedPalletJackGuid = 0;
    out.TransferContainerGuid = 0;
  }
  out._bytesConsumed = r.pos;
  out._bytesTotal = r.buf.byteLength;
  return out;
}

export function encodePalletJackAction(fields = {}, versionOverride = null) {
  const w = new BinWriter(44);
  const version = versionOverride ?? fields.Header?.Version ?? HBV1_VERSION_V7;
  encodeHeader(w, { ...(fields.Header || {}), Version: version });
  w.u32(fields.PalletJackGuid ?? 0);
  w.u8(fields.Action ?? 0);
  w.u8(fields.SlotIndex ?? 0);
  w.u8(fields.SubSlot ?? 0);
  w.u8(fields.Flags ?? 0);
  w.u32(fields.TargetGuid ?? 0);
  w.u32(fields.Cell ?? 0);
  w.vec3(fields.Position ?? { X: 0, Y: 0, Z: 0 });
  w.f32(fields.Heading ?? 0);
  w.f32(fields.TillerAngle ?? 0);
  return w.finish();
}

export function decodePalletJackAction(bytes) {
  const r = new BinReader(bytes);
  const Header = decodeHeader(r);
  if (!Header || Header.Version < HBV1_VERSION_V7 || r.remaining() < 36) return null;
  const out = {
    Header,
    PalletJackGuid: r.u32(),
    Action: r.u8(),
    SlotIndex: r.u8(),
    SubSlot: r.u8(),
    Flags: r.u8(),
    TargetGuid: r.u32(),
    Cell: r.u32(),
    Position: r.vec3(),
    Heading: r.f32(),
    TillerAngle: r.f32(),
  };
  out._bytesConsumed = r.pos;
  out._bytesTotal = r.buf.byteLength;
  return out;
}

export function encodePalletJackState(fields = {}, versionOverride = null) {
  const w = new BinWriter(60);
  const version = versionOverride ?? fields.Header?.Version ?? HBV1_VERSION_V7;
  encodeHeader(w, { ...(fields.Header || {}), Version: version });
  w.u32(fields.PalletJackGuid ?? 0);
  w.u32(fields.OperatorGuid ?? 0);
  w.u32(fields.StowedOnTrailerGuid ?? 0);
  w.u32(fields.Cell ?? 0);
  w.vec3(fields.Position ?? { X: 0, Y: 0, Z: 0 });
  w.f32(fields.Heading ?? 0);
  w.f32(fields.TillerAngle ?? 0);
  w.f32(fields.ForkHeightM ?? LOGISTICS_SPEC.palletJack.forkLoweredM);
  w.u8(fields.ForkState ?? FORK_STATE.Lowered);
  w.u8(fields.CarriedPalletSize ?? 0);
  w.u8(fields.Flags ?? 0);
  w.u8(fields.Reserved ?? 0);
  w.u32(fields.CarriedWcid ?? 0);
  w.u32(fields.OwnerGuid ?? 0);
  return w.finish();
}

export function decodePalletJackState(bytes) {
  const r = new BinReader(bytes);
  const Header = decodeHeader(r);
  if (!Header || Header.Version < HBV1_VERSION_V7 || r.remaining() < 52) return null;
  const out = {
    Header,
    PalletJackGuid: r.u32(),
    OperatorGuid: r.u32(),
    StowedOnTrailerGuid: r.u32(),
    Cell: r.u32(),
    Position: r.vec3(),
    Heading: r.f32(),
    TillerAngle: r.f32(),
    ForkHeightM: r.f32(),
    ForkState: r.u8(),
    CarriedPalletSize: r.u8(),
    Flags: r.u8(),
    Reserved: r.u8(),
    CarriedWcid: r.u32(),
    OwnerGuid: r.u32(),
  };
  out._bytesConsumed = r.pos;
  out._bytesTotal = r.buf.byteLength;
  return out;
}

export function encodeDeployableState(fields = {}, versionOverride = null) {
  const w = new BinWriter(80);
  const version = versionOverride ?? fields.Header?.Version ?? HBV1_VERSION_V7;
  encodeHeader(w, { ...(fields.Header || {}), Version: version });
  w.u32(fields.DeployableGuid ?? 0);
  w.u32(fields.DeployableKind ?? 0);
  w.u8(fields.PalletSize ?? 0);
  w.u8(fields.OnlineFlags ?? 0);
  w.u16(fields.AmmoRemaining ?? 0);
  w.u32(fields.OwnerGuid ?? 0);
  w.u32(fields.ParentVehicle ?? 0);
  w.u32(fields.Cell ?? 0);
  w.vec3(fields.Position ?? { X: 0, Y: 0, Z: 0 });
  w.f32(fields.Heading ?? 0);
  w.f32(fields.PowerWatts ?? 0);
  w.f32(fields.EnergyStoredJoules ?? 0);
  w.f32(fields.EnergyCapacityJoules ?? 600000);
  w.f32(fields.FuelRemaining ?? 0);
  w.f32(fields.PitchRad ?? 0);
  w.f32(fields.YawRad ?? 0);
  w.f32(fields.RollRad ?? 0);
  w.f32(fields.ElevationM ?? 0);
  return w.finish();
}

export function decodeDeployableState(bytes) {
  const r = new BinReader(bytes);
  const Header = decodeHeader(r);
  if (!Header || r.remaining() < 72) return null;
  const out = {
    Header,
    DeployableGuid: r.u32(),
    DeployableKind: r.u32(),
    PalletSize: r.u8(),
    OnlineFlags: r.u8(),
    AmmoRemaining: r.u16(),
    OwnerGuid: r.u32(),
    ParentVehicle: r.u32(),
    Cell: r.u32(),
    Position: r.vec3(),
    Heading: r.f32(),
    PowerWatts: r.f32(),
    EnergyStoredJoules: r.f32(),
    EnergyCapacityJoules: r.f32(),
    FuelRemaining: r.f32(),
    PitchRad: r.f32(),
    YawRad: r.f32(),
    RollRad: r.f32(),
    ElevationM: r.f32(),
  };
  out._bytesConsumed = r.pos;
  out._bytesTotal = r.buf.byteLength;
  return out;
}

export function encodeVehicleEvent(fields = {}, versionOverride = null) {
  const w = new BinWriter(56);
  const version = versionOverride ?? fields.Header?.Version ?? HBV1_VERSION_V7;
  encodeHeader(w, { ...(fields.Header || {}), Version: version });
  w.u32(fields.Vehicle ?? 0);
  w.u32(fields.Kind ?? 0);
  w.u32(fields.Step ?? 0);
  w.u32(fields.Subject ?? 0);
  w.u32(fields.Cell ?? 0);
  w.vec3(fields.Position ?? { X: 0, Y: 0, Z: 0 });
  w.f32(fields.Value ?? 0);
  if (version >= 2) {
    w.u32(fields.Aux ?? 0);
    w.vec3(fields.Velocity ?? { X: 0, Y: 0, Z: 0 });
  }
  return w.finish();
}

export function decodeVehicleEvent(bytes) {
  const r = new BinReader(bytes);
  const Header = decodeHeader(r);
  if (!Header || r.remaining() < 36) return null;
  const out = {
    Header,
    Vehicle: r.u32(),
    Kind: r.u32(),
    Step: r.u32(),
    Subject: r.u32(),
    Cell: r.u32(),
    Position: r.vec3(),
    Value: r.f32(),
    Aux: 0,
    Velocity: { X: 0, Y: 0, Z: 0 },
  };
  if (Header.Version >= 2) {
    if (r.remaining() < 16) return null;
    out.Aux = r.u32();
    out.Velocity = r.vec3();
  }
  out._bytesConsumed = r.pos;
  out._bytesTotal = r.buf.byteLength;
  return out;
}

export function encodeContainerAction(fields = {}, versionOverride = null) {
  const w = new BinWriter(24);
  const version = versionOverride ?? fields.Header?.Version ?? HBV1_VERSION_V7;
  encodeHeader(w, { ...(fields.Header || {}), Version: version });
  w.u32(fields.Container ?? 0);
  w.u8(fields.Action ?? 0);
  w.u8(fields.SlotIndex ?? 0);
  w.u8(fields.SubSlot ?? 0);
  w.u8(fields.Reserved ?? 0);
  w.u32(fields.CargoWcid ?? 0);
  return w.finish();
}

export function decodeContainerAction(bytes) {
  const r = new BinReader(bytes);
  const Header = decodeHeader(r);
  if (!Header || r.remaining() < 12) return null;
  const out = {
    Header,
    Container: r.u32(),
    Action: r.u8(),
    SlotIndex: r.u8(),
    SubSlot: r.u8(),
    Reserved: r.u8(),
    CargoWcid: r.u32(),
  };
  out._bytesConsumed = r.pos;
  out._bytesTotal = r.buf.byteLength;
  return out;
}

export function wrapC2SFrame(sequence, opcode, payload) {
  const w = new BinWriter(12 + payload.length);
  w.u32(AC_C2S_FRAME);
  w.u32(sequence);
  w.u32(opcode);
  w.bytes(payload);
  return w.finish();
}

export function unwrapC2SFrame(bytes) {
  const r = new BinReader(bytes);
  if (r.remaining() < 12) return null;
  const frameTag = r.u32();
  if (frameTag !== AC_C2S_FRAME) return null;
  const sequence = r.u32();
  const opcode = r.u32();
  return { frameTag, sequence, opcode, payload: r.buf.slice(r.pos) };
}

export function wrapS2CFrame(targetGuid, sequence, opcode, payload) {
  const w = new BinWriter(16 + payload.length);
  w.u32(AC_S2C_FRAME);
  w.u32(targetGuid);
  w.u32(sequence);
  w.u32(opcode);
  w.bytes(payload);
  return w.finish();
}

export function unwrapS2CFrame(bytes) {
  const r = new BinReader(bytes);
  if (r.remaining() < 16) return null;
  const frameTag = r.u32();
  if (frameTag !== AC_S2C_FRAME) return null;
  const targetGuid = r.u32();
  const sequence = r.u32();
  const opcode = r.u32();
  return { frameTag, targetGuid, sequence, opcode, payload: r.buf.slice(r.pos) };
}

export function oracleWireStatsTrack(opcodes) {
  const received = new Uint32Array(32);
  let unknown = 0;
  for (const op of opcodes) {
    const idx = (op - 0x0900) | 0;
    if (idx >= 0 && idx < 32) {
      received[idx]++;
    } else {
      unknown++;
    }
  }
  return { received: Array.from(received), unknown };
}

// =============================================================================
// Independent Opaque-Box ISO 3874 / 3691-5 / 6780 Reference Oracles
// =============================================================================

function clamp01(v) {
  if (!Number.isFinite(v)) return v === Infinity ? 1 : 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function smoothstep(t) {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
}

export function oracleComputeCraneSpanY(containerKindOrWcid) {
  if (
    containerKindOrWcid === 10 ||
    containerKindOrWcid === 4000020 ||
    containerKindOrWcid === "20ft" ||
    containerKindOrWcid === "IsoContainer20"
  ) {
    return LOGISTICS_SPEC.sidelifter.craneSpanY20; // 2.9265
  }
  return LOGISTICS_SPEC.sidelifter.craneSpanY40; // 5.9925
}

export function oracleEvaluateContainerLocalPose(
  phase,
  progress,
  side = 1,
  direction = false,
  deckZ = LOGISTICS_SPEC.sidelifter.chassisDeckZ,
  groundLocalZ = 0,
  slotY = 0
) {
  const ph = typeof phase === "number" && Number.isFinite(phase) ? Math.trunc(phase) : 0;
  const p = clamp01(progress);
  const sp = smoothstep(p);
  const s =
    side === -1 ||
    side === "left" ||
    (typeof side === "number" && Number.isFinite(side) && side < 0)
      ? -1
      : 1;
  const isLoad =
    direction === true ||
    direction === 1 ||
    (typeof direction === "string" && direction.trim().toLowerCase() === "load");

  const deck = typeof deckZ === "number" && Number.isFinite(deckZ) ? deckZ : LOGISTICS_SPEC.sidelifter.chassisDeckZ;
  const gnd = typeof groundLocalZ === "number" && Number.isFinite(groundLocalZ) ? groundLocalZ : 0;
  const outX = s * LOGISTICS_SPEC.sidelifter.outreachX;
  const hoistTopZ = Math.max(deck, gnd) + LOGISTICS_SPEC.sidelifter.hoistClearanceZ;
  const minZ = Math.min(deck, gnd);
  const zSpan = Math.max(0.25, hoistTopZ - minZ);

  const startX = isLoad ? outX : 0;
  const endX = isLoad ? 0 : outX;
  const startZ = isLoad ? gnd : deck;
  const endZ = isLoad ? deck : gnd;

  let x = startX;
  let z = startZ;

  if (ph <= SIDELIFT_PHASE.CranesLatched) {
    x = startX;
    z = startZ;
  } else if (ph === SIDELIFT_PHASE.Hoisting) {
    x = startX;
    z = startZ + (hoistTopZ - startZ) * sp;
  } else if (ph === SIDELIFT_PHASE.Swinging) {
    x = startX + (endX - startX) * sp;
    // Gentle arc crest in Z during swing, strictly >= hoistTopZ
    z = hoistTopZ + Math.sin(Math.PI * sp) * 0.25;
  } else if (ph === SIDELIFT_PHASE.Lowering) {
    x = endX;
    z = hoistTopZ + (endZ - hoistTopZ) * sp;
  } else {
    x = endX;
    z = endZ;
  }

  const craneAt = (cx, cz) => {
    const reach = Math.abs(cx) / LOGISTICS_SPEC.sidelifter.outreachX;
    const liftRatio = clamp01((cz - minZ) / zSpan);
    const dropRatio = clamp01((hoistTopZ - cz) / zSpan);
    return {
      boom: s * (0.22 + 0.70 * reach - 0.08 * liftRatio),
      jib: s * (0.55 + 0.20 * reach - 0.15 * liftRatio),
      chain: 0.65 + 0.45 * dropRatio,
    };
  };

  let boomAngle = 0;
  let jibAngle = 0;
  let chainLen = 0;

  if (ph === SIDELIFT_PHASE.CranesPositioning) {
    const c = craneAt(startX, startZ);
    boomAngle = c.boom * sp;
    jibAngle = c.jib * sp;
    chainLen = c.chain * sp;
  } else if (ph >= SIDELIFT_PHASE.CranesLatched && ph <= SIDELIFT_PHASE.Releasing) {
    const c = craneAt(x, z);
    boomAngle = c.boom;
    jibAngle = c.jib;
    chainLen = c.chain;
  } else if (ph === SIDELIFT_PHASE.CranesStowing) {
    const c = craneAt(endX, endZ);
    const k = 1 - sp;
    boomAngle = c.boom * k;
    jibAngle = c.jib * k;
    chainLen = c.chain * k;
  }

  return {
    x,
    y: Number.isFinite(slotY) ? slotY : 0,
    z,
    roll: 0, // Level-lift invariant per ISO 3874 symmetric 4-corner casting hoist
    craneBoomAngle: boomAngle,
    craneJibAngle: jibAngle,
    chainLen,
  };
}

export function oracleCheckSlopeFromCos(cosTheta) {
  return typeof cosTheta === "number" && Number.isFinite(cosTheta) && cosTheta >= LOGISTICS_SPEC.sidelifter.maxSlopeCos;
}

export function oracleCheckSlopeCorners(corners, widthSpan = 2.44, lengthSpan = 11.985) {
  // corners: [frontLeft, frontRight, rearLeft, rearRight] heights in m
  if (
    !Array.isArray(corners) ||
    corners.length < 4 ||
    !corners.slice(0, 4).every((v) => typeof v === "number" && Number.isFinite(v)) ||
    typeof widthSpan !== "number" ||
    !Number.isFinite(widthSpan) ||
    widthSpan <= 0 ||
    typeof lengthSpan !== "number" ||
    !Number.isFinite(lengthSpan) ||
    lengthSpan <= 0
  ) {
    return { ok: false, minCos: 0, maxDeg: 90, reason: "missing or invalid terrain corners" };
  }
  const [zFL, zFR, zRL, zRR] = corners;
  const nx = -((zFR + zRR) - (zFL + zRL)) / (2.0 * widthSpan);
  const ny = -((zFL + zFR) - (zRL + zRR)) / (2.0 * lengthSpan);
  const planeCos = 1.0 / Math.hypot(nx, ny, 1.0);
  const frontCos = 1.0 / Math.hypot((zFR - zFL) / widthSpan, 1.0);
  const rearCos = 1.0 / Math.hypot((zRR - zRL) / widthSpan, 1.0);
  const leftCos = 1.0 / Math.hypot((zFL - zRL) / lengthSpan, 1.0);
  const rightCos = 1.0 / Math.hypot((zFR - zRR) / lengthSpan, 1.0);
  const cos = Math.min(planeCos, frontCos, rearCos, leftCos, rightCos);
  const deg = (Math.acos(clamp01(cos)) * 180) / Math.PI;
  return {
    ok: cos >= LOGISTICS_SPEC.sidelifter.maxSlopeCos,
    minCos: cos,
    maxDeg: deg,
    reason: cos >= LOGISTICS_SPEC.sidelifter.maxSlopeCos ? "" : "ISO 3874: Ground slope exceeds 6 deg sidelifter limit.",
  };
}

export function oracleCheckSideliftInterlocks({
  trailer,
  tractor = null,
  container = null,
  action,
  slopeCos = 1.0,
}) {
  if (!trailer?.isSidelifter) {
    return { ok: false, reason: "ISO 3874: Trailer is not a Sidelifter (WCID 4000032)." };
  }
  const rawSpeed = tractor?.speed ?? 0;
  if (typeof rawSpeed !== "number" || !Number.isFinite(rawSpeed) || Math.abs(rawSpeed) > LOGISTICS_SPEC.sidelifter.parkedSpeedMax) {
    return { ok: false, reason: "ISO 3874: Park tractor (<= 0.25 m/s) before operating sidelifter." };
  }
  if (!oracleCheckSlopeFromCos(slopeCos)) {
    return { ok: false, reason: "ISO 3874: Ground slope exceeds 6 deg sidelifter limit." };
  }
  if (
    action === TRAILER_ACTION_KIND.SideliftOffload ||
    action === TRAILER_ACTION_KIND.SideliftLoad ||
    action === TRAILER_ACTION_KIND.AutoOffload ||
    action === TRAILER_ACTION_KIND.AutoLoad
  ) {
    if (!container) {
      return { ok: false, reason: "ISO 3874: No target ISO container for sidelift." };
    }
    const doorProg = container.doorProgress ?? 0;
    if (typeof doorProg !== "number" || !Number.isFinite(doorProg) || doorProg > LOGISTICS_SPEC.sidelifter.doorOpenThreshold || (container.doorState ?? 0) !== 0) {
      return { ok: false, reason: "ISO 3874: Close and latch container doors before lifting." };
    }
  }
  if (action === TRAILER_ACTION_KIND.SideliftOffload || action === TRAILER_ACTION_KIND.SideliftLoad) {
    if (!trailer.outriggersPlanted && trailer.sideliftPhase !== SIDELIFT_PHASE.OutriggersPlanted) {
      return { ok: false, reason: "ISO 3874: Deploy stabilizing outriggers before crane lift." };
    }
  }
  if (action === TRAILER_ACTION_KIND.SideliftOffload) {
    if (trailer.twistlocksLocked) {
      return { ok: false, reason: "ISO 3874: Unlock chassis twistlocks before offloading." };
    }
  }
  if (action === TRAILER_ACTION_KIND.StowPalletJack) {
    if (trailer.stowedPalletJackGuid) {
      return { ok: false, reason: "ISO 3691-5: Sidelifter under-frame rack already occupied." };
    }
  }
  return { ok: true, reason: "" };
}

function resolveOracleContainer(containerKindOrWcid) {
  let key = containerKindOrWcid;
  if (containerKindOrWcid && typeof containerKindOrWcid === "object") {
    key =
      containerKindOrWcid.containerKind ??
      containerKindOrWcid.kind ??
      containerKindOrWcid.wcid ??
      containerKindOrWcid.type;
  }
  if (typeof key === "number" && Number.isFinite(key)) {
    const n = Math.trunc(key);
    if (n === 10 || n === 4000020 || n === 20) return { spec: LOGISTICS_SPEC.containers[10], slots: PINWHEEL_SLOTS_20 };
    if (n === 11 || n === 4000021 || n === 40) return { spec: LOGISTICS_SPEC.containers[11], slots: PINWHEEL_SLOTS_40 };
    if (n === 12 || n === 4000022) return { spec: LOGISTICS_SPEC.containers[12], slots: PINWHEEL_SLOTS_40 };
    return null;
  }
  if (typeof key === "string") {
    const s = key.trim().toLowerCase();
    if (s === "20" || s === "20ft" || s === "22g1" || s === "1cc" || s === "isocontainer20" || s === "4000020" || s === "10") {
      return { spec: LOGISTICS_SPEC.containers[10], slots: PINWHEEL_SLOTS_20 };
    }
    if (s === "40" || s === "40ft" || s === "42g1" || s === "1aa" || s === "isocontainer40" || s === "4000021" || s === "11") {
      return { spec: LOGISTICS_SPEC.containers[11], slots: PINWHEEL_SLOTS_40 };
    }
    if (s === "40hc" || s === "45g1" || s === "1aaa" || s === "isocontainer40hc" || s === "4000022" || s === "12") {
      return { spec: LOGISTICS_SPEC.containers[12], slots: PINWHEEL_SLOTS_40 };
    }
  }
  return null;
}

export function oracleGetPinwheelSlots(containerKindOrWcid) {
  const res = resolveOracleContainer(containerKindOrWcid);
  return res ? res.slots : PINWHEEL_SLOTS_40;
}

function getSlotAabb(slotDef, _isHalf = false, _subSlot = 0) {
  const cx = slotDef.x;
  const cy = slotDef.y;
  const dx = slotDef.dx || 1.100;
  const dy = slotDef.dy || 1.100;
  return {
    cx,
    cy,
    dx,
    dy,
    minX: cx - dx / 2,
    maxX: cx + dx / 2,
    minY: cy - dy / 2,
    maxY: cy + dy / 2,
  };
}

function evaluateCorridorFromDoorOracle(spec, obstacleBoxes, targetBox, targetSlotIndex = -1, targetSubSlot = -1) {
  const EPS = 1e-4;
  const halfW = spec.intW / 2; // 1.176
  const blockerMap = new Map();
  const addBlocker = (b) => {
    const k = `${b.slotIndex}:${b.subSlot}`;
    if (!blockerMap.has(k)) blockerMap.set(k, b);
  };

  const frontObstacles = [];
  for (let i = 0; i < obstacleBoxes.length; i++) {
    const b = obstacleBoxes[i];
    if (b.slotIndex === targetSlotIndex && b.subSlot === targetSubSlot) continue;
    if (b.minY < targetBox.minY - EPS) {
      frontObstacles.push(b);
      const overlapX = Math.min(targetBox.maxX, b.maxX) - Math.max(targetBox.minX, b.minX);
      if (overlapX > EPS) addBlocker(b);
    }
  }

  const requiredWidth = Math.max(targetBox.dx, LOGISTICS_SPEC.palletJack.forkSpreadM);
  for (let i = 0; i < frontObstacles.length; i++) {
    const b = frontObstacles[i];
    if (blockerMap.has(`${b.slotIndex}:${b.subSlot}`)) continue;
    let leftWall = -halfW;
    let rightWall = halfW;
    let leftBlocker = null;
    let rightBlocker = null;

    for (let j = 0; j < frontObstacles.length; j++) {
      const o = frontObstacles[j];
      const overlapY = Math.min(b.maxY, o.maxY) - Math.max(b.minY, o.minY);
      if (overlapY <= EPS) continue;
      if (o.maxX <= targetBox.minX + EPS && o.maxX > leftWall) {
        leftWall = o.maxX;
        leftBlocker = o;
      }
      if (o.minX >= targetBox.maxX - EPS && o.minX < rightWall) {
        rightWall = o.minX;
        rightBlocker = o;
      }
    }

    if (rightWall - leftWall < requiredWidth - EPS) {
      if (leftBlocker && rightBlocker) {
        const dLeft = targetBox.minX - leftBlocker.maxX;
        const dRight = rightBlocker.minX - targetBox.maxX;
        addBlocker(dLeft <= dRight ? leftBlocker : rightBlocker);
      } else if (leftBlocker) {
        addBlocker(leftBlocker);
      } else if (rightBlocker) {
        addBlocker(rightBlocker);
      } else {
        addBlocker(b);
      }
    }
  }

  const blockers = Array.from(blockerMap.values()).sort(
    (a, b) => (a.minY - b.minY) || (a.slotIndex - b.slotIndex) || (a.subSlot - b.subSlot)
  );
  return {
    reachable: blockers.length === 0,
    blockedBySlotIndex: blockers.length > 0 ? blockers[0].slotIndex : null,
    blockedBySubSlot: blockers.length > 0 ? blockers[0].subSlot : null,
  };
}

function normalizeOracleOccupiedSlots(slots, occupiedSlots) {
  if (!Array.isArray(occupiedSlots)) return [];
  const items = [];
  const seen = new Set();
  for (let i = 0; i < occupiedSlots.length; i++) {
    const s = occupiedSlots[i];
    if (!s || typeof s !== "object") continue;
    const rawIdx = s.slotIndex ?? s.SlotIndex;
    if (typeof rawIdx !== "number" || !Number.isFinite(rawIdx)) continue;
    const slotIndex = Math.trunc(rawIdx);
    if (slotIndex < 0 || slotIndex >= slots.length) continue;
    const slotDef = slots[slotIndex];
    if (!slotDef) continue;
    const rawSize = s.palletSize ?? s.PalletSize;
    if (rawSize === 0 || rawSize === "none" || rawSize === "None") continue;
    const cargoWcid = s.cargoWcid ?? s.CargoWcid ?? s.wcid ?? 0;
    // Unified ISO 6780 pallet: normalize any valid occupied slot to full (subSlot = 0).
    const isHalf = false;
    const subSlot = 0;
    const key = `${slotIndex}:F`;
    if (seen.has(key)) continue;
    seen.add(key);
    const box = getSlotAabb(slotDef, false, 0);
    items.push({ ...s, slotIndex, cargoWcid: typeof cargoWcid === "number" && Number.isFinite(cargoWcid) ? Math.trunc(cargoWcid) : 0, isHalf, subSlot, ...box });
  }
  return items;
}

export function oracleComputeReachableUnloadSlots(containerKind, occupiedSlots = []) {
  const resolved = resolveOracleContainer(containerKind);
  if (!resolved) return { reachable: [], blocked: [] };
  const { spec, slots } = resolved;
  const items = normalizeOracleOccupiedSlots(slots, occupiedSlots);

  const reachable = [];
  const blocked = [];
  for (let i = 0; i < items.length; i++) {
    const target = items[i];
    const res = evaluateCorridorFromDoorOracle(spec, items, target, target.slotIndex, target.subSlot);
    if (res.reachable) {
      reachable.push({
        slotIndex: target.slotIndex,
        subSlot: target.subSlot,
        cargoWcid: target.cargoWcid,
        palletSize: target.isHalf ? 1 : 2,
        x: target.cx,
        y: target.cy,
      });
    } else {
      blocked.push({
        slotIndex: target.slotIndex,
        subSlot: target.subSlot,
        blockedBySlotIndex: res.blockedBySlotIndex,
        blockedBySubSlot: res.blockedBySubSlot,
        y: target.cy,
      });
    }
  }
  const byShallowFirst = (a, b) => (a.y - b.y) || (a.slotIndex - b.slotIndex) || (a.subSlot - b.subSlot);
  reachable.sort(byShallowFirst);
  blocked.sort(byShallowFirst);
  for (const b of blocked) delete b.y;
  return { reachable, blocked };
}

export function oracleComputeReachableLoadSlots(containerKind, occupiedSlots = [], palletSize = "full") {
  const resolved = resolveOracleContainer(containerKind);
  if (!resolved) return [];
  const { spec, slots } = resolved;
  const isUnifiedFull = palletSize === "full" || palletSize === "Full" || palletSize === 2;
  if (!isUnifiedFull) return [];
  const occBySlot = new Set();
  const obstacles = normalizeOracleOccupiedSlots(slots, occupiedSlots);

  for (const item of obstacles) {
    occBySlot.add(item.slotIndex);
  }

  const candidates = [];
  for (const slotDef of slots) {
    if (occBySlot.has(slotDef.slotIndex)) continue;
    const box = getSlotAabb(slotDef, false, 0);
    const res = evaluateCorridorFromDoorOracle(spec, obstacles, box, -1, -1);
    if (res.reachable) {
      candidates.push({ slotIndex: slotDef.slotIndex, subSlot: 0, x: box.cx, y: box.cy });
    }
  }

  // Sort deepest-first (+Y -> -Y)
  candidates.sort((a, b) => (b.y - a.y) || (a.slotIndex - b.slotIndex) || (b.subSlot - a.subSlot));
  return candidates;
}

export function oracleFindNearestForkEngageTarget(jackPose, candidates = [], options = {}) {
  if (!jackPose || typeof jackPose !== "object" || !Array.isArray(candidates) || candidates.length === 0) {
    return null;
  }
  const jx = jackPose.x;
  const jy = jackPose.y;
  const jh = typeof jackPose.heading === "number" && Number.isFinite(jackPose.heading) ? jackPose.heading : 0;
  if (typeof jx !== "number" || !Number.isFinite(jx) || typeof jy !== "number" || !Number.isFinite(jy)) {
    return null;
  }

  const forkOffset = typeof options.forkOffset === "number" && Number.isFinite(options.forkOffset) ? options.forkOffset : 0;
  const refX = jx + Math.sin(jh) * forkOffset;
  const refY = jy + Math.cos(jh) * forkOffset;
  const maxDist = typeof options.maxDist === "number" && Number.isFinite(options.maxDist) ? options.maxDist : LOGISTICS_SPEC.palletJack.assistMaxDistM;
  const maxYawRad = typeof options.maxYawRad === "number" && Number.isFinite(options.maxYawRad) ? options.maxYawRad : LOGISTICS_SPEC.palletJack.assistMaxYawRad;
  const includeBlocked = Boolean(options.includeBlocked);
  const includeMisaligned = Boolean(options.includeMisaligned);

  let best = null;
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    if (!c || typeof c !== "object") continue;
    const cx = c.x ?? c.pos?.[0];
    const cy = c.y ?? c.pos?.[1];
    if (typeof cx !== "number" || !Number.isFinite(cx) || typeof cy !== "number" || !Number.isFinite(cy)) continue;
    if (c.reachable === false && !includeBlocked) continue;

    const dist = Math.hypot(cx - refX, cy - refY);
    if (dist > maxDist) continue;

    const th = typeof c.heading === "number" && Number.isFinite(c.heading) ? c.heading : 0;
    const isFourWay = c.fourWay !== false && options.fourWay !== false;
    let yawDelta;
    let alignedHeading;

    if (!isFourWay) {
      if (c.bidirectional) {
        const d0 = wrapPi(jh - th);
        const d1 = wrapPi(jh - (th + Math.PI));
        if (Math.abs(d0) <= Math.abs(d1)) {
          yawDelta = d0;
          alignedHeading = wrapHeading(th);
        } else {
          yawDelta = d1;
          alignedHeading = wrapHeading(th + Math.PI);
        }
      } else {
        yawDelta = wrapPi(jh - th);
        alignedHeading = wrapHeading(th);
      }
    } else {
      const rel = wrapPi(jh - th);
      const nearestCardinal = Math.round(rel / (Math.PI * 0.5)) * (Math.PI * 0.5);
      yawDelta = wrapPi(rel - nearestCardinal);
      alignedHeading = wrapHeading(th + nearestCardinal);
    }

    const absYawDelta = Math.abs(yawDelta);
    const aligned = absYawDelta <= maxYawRad;
    if (!aligned && !includeMisaligned) continue;

    if (
      !best ||
      dist < best.dist - 1e-6 ||
      (Math.abs(dist - best.dist) <= 1e-6 && absYawDelta < best.absYawDelta)
    ) {
      const canEngage = dist <= maxDist && aligned && c.reachable !== false;
      best = {
        target: c,
        index: i,
        dist,
        yawDelta,
        absYawDelta,
        alignedHeading,
        inRange: dist <= maxDist,
        aligned,
        canEngage,
        assisted: canEngage,
      };
    }
  }
  return best;
}

export function oracleStepPalletJack(state, input, dt = 1 / 30, surfaceProbe = null) {
  const s = { ...state };
  const carrying = Boolean(s.carriedWcid);
  const maxTiller = LOGISTICS_SPEC.palletJack.maxTillerRad;
  let tiller = Number.isFinite(input.tillerAngle) ? input.tillerAngle : (s.tillerAngle ?? 0);
  if (tiller > maxTiller) tiller = maxTiller;
  if (tiller < -maxTiller) tiller = -maxTiller;

  if (!s.operatorGuid) {
    // ISO 3691-5 dead-man brake
    s.speed = 0;
    s.tillerAngle = 0;
    return s;
  }

  const probe = typeof surfaceProbe === "function" ? surfaceProbe(s.x, s.y, s.z + 1.5) : null;
  const onRamp = probe?.zone === "ramp";
  const maxSpd = onRamp
    ? LOGISTICS_SPEC.palletJack.speedRampMps
    : (carrying ? LOGISTICS_SPEC.palletJack.speedLoadedMps : LOGISTICS_SPEC.palletJack.speedEmptyMps);

  const throttle = Math.max(-1, Math.min(1, input.throttle ?? 0));
  const steer = Math.max(-1, Math.min(1, input.steer ?? 0));
  tiller = Math.max(-maxTiller, Math.min(maxTiller, tiller + steer * 2.5 * dt));
  const v = throttle * maxSpd;
  const omega = (v / LOGISTICS_SPEC.palletJack.wheelbaseM) * Math.sin(tiller);
  const nextHeading = wrapHeading((s.heading ?? 0) + omega * dt);
  const nextX = (s.x ?? 0) + Math.sin(nextHeading) * v * dt;
  const nextY = (s.y ?? 0) + Math.cos(nextHeading) * v * dt;

  const afterProbe = typeof surfaceProbe === "function" ? surfaceProbe(nextX, nextY, (s.z ?? 0) + 1.5) : null;
  const nextZ = afterProbe ? afterProbe.z : (s.z ?? 0);

  return {
    ...s,
    x: nextX,
    y: nextY,
    z: nextZ,
    heading: nextHeading,
    tillerAngle: tiller,
    speed: v,
    onContainerRampOrFloor: Boolean(afterProbe),
  };
}

// =============================================================================
// Independent Opaque-Box End-to-End Logistics World Simulator (Offline Mode)
// =============================================================================

export class LogisticsWorldSimulator {
  constructor() {
    this.nextGuid = 0x800a0001;
    this.tractors = new Map();
    this.trailers = new Map();
    this.containers = new Map();
    this.palletJacks = new Map();
    this.deployables = new Map();
    this.events = [];
    this.wireOpcodes = [];
  }

  allocGuid() {
    return (this.nextGuid++) >>> 0;
  }

  spawnPreset(preset = "sidelifter40", { x = 100, y = 100, z = 10, slopeCos = 1.0 } = {}) {
    const tGuid = this.allocGuid();
    const trGuid = this.allocGuid();
    const cGuid = this.allocGuid();
    const pjGuid = this.allocGuid();

    const contKind = preset === "sidelifter20" ? 10 : preset === "sidelifter40hc" ? 12 : 11;
    const craneSpanY = oracleComputeCraneSpanY(contKind);

    this.tractors.set(tGuid, {
      guid: tGuid,
      x,
      y,
      z,
      heading: 0,
      speed: 0,
      hitchedTrailerGuid: trGuid,
      towMassMul: LOGISTICS_SPEC.towMassMul.loaded40ft,
    });

    this.trailers.set(trGuid, {
      guid: trGuid,
      kind: DEPLOYABLE_KIND.TrailerSidelifter40,
      wcid: LOGISTICS_SPEC.sidelifter.wcid,
      isSidelifter: true,
      x,
      y: y - 7.36,
      z,
      heading: 0,
      coupledTractorGuid: tGuid,
      mountedContainerGuid: cGuid,
      twistlocksLocked: true,
      outriggersPlanted: false,
      sideliftPhase: SIDELIFT_PHASE.Idle,
      sideliftSide: 1,
      sideliftProgress: 0,
      outriggerProgress: 0,
      craneSpanY,
      stowedPalletJackGuid: pjGuid,
      slopeCos,
    });

    const defaultSlots =
      preset === "sidelifter40hc"
        ? [
            { slotIndex: 0, subSlot: 0, cargoWcid: 4000010, palletSize: 2, cargoState: { ammo: 0, fuel: 0, energy: 0 } },
            { slotIndex: 2, subSlot: 0, cargoWcid: 4000013, palletSize: 2, cargoState: { ammo: 0, fuel: 0, energy: 240000 } },
            { slotIndex: 3, subSlot: 0, cargoWcid: 4000015, palletSize: 2, cargoState: { ammo: 0, fuel: 0, energy: 0 } },
            { slotIndex: 18, subSlot: 0, cargoWcid: 4000014, palletSize: 2, cargoState: { ammo: 4, fuel: 0, energy: 0 } },
            { slotIndex: 19, subSlot: 0, cargoWcid: 4000017, palletSize: 2, cargoState: { ammo: 0, fuel: 0, energy: 120000 } },
          ]
        : preset === "sidelifter20"
        ? [
            { slotIndex: 0, subSlot: 0, cargoWcid: 4000010, palletSize: 2, cargoState: { ammo: 0, fuel: 0, energy: 0 } },
            { slotIndex: 9, subSlot: 0, cargoWcid: 4000002, palletSize: 2, cargoState: { ammo: 0, fuel: 0, energy: 0 } },
          ]
        : [
            { slotIndex: 0, subSlot: 0, cargoWcid: 4000010, palletSize: 2, cargoState: { ammo: 0, fuel: 0, energy: 0 } },
            { slotIndex: 16, subSlot: 0, cargoWcid: 4000011, palletSize: 2, cargoState: { ammo: 0, fuel: 0, energy: 0 } },
            { slotIndex: 18, subSlot: 0, cargoWcid: 4000014, palletSize: 2, cargoState: { ammo: 4, fuel: 0, energy: 0 } },
            { slotIndex: 19, subSlot: 0, cargoWcid: 4000012, palletSize: 2, cargoState: { ammo: 0, fuel: 120, energy: 0 } },
          ];

    this.containers.set(cGuid, {
      guid: cGuid,
      kind: contKind,
      wcid: LOGISTICS_SPEC.containers[contKind].wcid,
      x,
      y: y - 7.36,
      z: z + LOGISTICS_SPEC.sidelifter.chassisDeckZ,
      heading: 0,
      mountedOnTrailerGuid: trGuid,
      doorState: 0,
      doorProgress: 0,
      slots: defaultSlots,
    });

    this.palletJacks.set(pjGuid, {
      guid: pjGuid,
      wcid: LOGISTICS_SPEC.palletJack.wcid,
      operatorGuid: 0,
      stowedOnTrailerGuid: trGuid,
      x,
      y: y - 7.36,
      z,
      heading: 0,
      tillerAngle: 0,
      forkHeightM: LOGISTICS_SPEC.palletJack.forkLoweredM,
      forkState: FORK_STATE.Lowered,
      carriedWcid: 0,
      carriedPalletSize: 0,
      carriedCargoState: { ammo: 0, fuel: 0, energy: 0 },
      onContainerRampOrFloor: false,
    });

    this.wireOpcodes.push(OPCODES.Vehicle_TrailerState, OPCODES.Vehicle_ContainerState, OPCODES.Vehicle_PalletJackState);
    return { tGuid, trGuid, cGuid, pjGuid };
  }

  canDriveTractor(tGuid) {
    const t = this.tractors.get(tGuid);
    if (!t) return { ok: false, reason: "missing tractor" };
    if (t.hitchedTrailerGuid) {
      const tr = this.trailers.get(t.hitchedTrailerGuid);
      if (tr && tr.sideliftPhase !== SIDELIFT_PHASE.Idle) {
        return { ok: false, reason: "ISO 3874: Retract sidelifter outriggers and cranes before driving." };
      }
    }
    return { ok: true, reason: "" };
  }

  trailerAction(trGuid, action, flags = 0) {
    const tr = this.trailers.get(trGuid);
    if (!tr) return { ok: false, reason: "missing trailer" };
    const tractor = tr.coupledTractorGuid ? this.tractors.get(tr.coupledTractorGuid) : null;
    const side = (flags & 0x01) ? -1 : 1;
    this.wireOpcodes.push(OPCODES.Vehicle_TrailerAction, OPCODES.Vehicle_TrailerState);

    if (action === TRAILER_ACTION_KIND.ToggleTwistlock) {
      tr.twistlocksLocked = !tr.twistlocksLocked;
      this.events.push({ kind: VEHICLE_EVENT_KIND.TwistlockToggled, aux: tr.twistlocksLocked ? 1 : 0 });
      return { ok: true, twistlocksLocked: tr.twistlocksLocked };
    }

    if (action === TRAILER_ACTION_KIND.DeployOutriggers) {
      const check = oracleCheckSideliftInterlocks({ trailer: tr, tractor, action, slopeCos: tr.slopeCos });
      if (!check.ok) {
        this.events.push({ kind: VEHICLE_EVENT_KIND.SideliftRefused, reason: check.reason });
        return check;
      }
      tr.outriggersPlanted = true;
      tr.outriggerProgress = 1.0;
      tr.sideliftPhase = SIDELIFT_PHASE.OutriggersPlanted;
      tr.sideliftSide = side;
      return { ok: true };
    }

    if (action === TRAILER_ACTION_KIND.RetractOutriggers) {
      if (tr.sideliftPhase !== SIDELIFT_PHASE.OutriggersPlanted && tr.sideliftPhase !== SIDELIFT_PHASE.Idle) {
        return { ok: false, reason: "ISO 3874: Crane operation in progress." };
      }
      tr.outriggersPlanted = false;
      tr.outriggerProgress = 0.0;
      tr.sideliftPhase = SIDELIFT_PHASE.Idle;
      return { ok: true };
    }

    if (action === TRAILER_ACTION_KIND.DeployPalletJack) {
      if (!tr.stowedPalletJackGuid) return { ok: false, reason: "No pallet jack stowed on rack." };
      const pj = this.palletJacks.get(tr.stowedPalletJackGuid);
      tr.stowedPalletJackGuid = 0;
      if (pj) {
        pj.stowedOnTrailerGuid = 0;
        pj.x = tr.x - 1.8;
        pj.y = tr.y - 1.6;
        pj.z = tr.z;
      }
      this.wireOpcodes.push(OPCODES.Vehicle_PalletJackState);
      return { ok: true, pjGuid: pj?.guid ?? 0 };
    }

    if (action === TRAILER_ACTION_KIND.StowPalletJack) {
      const pj = [...this.palletJacks.values()].find((p) => !p.stowedOnTrailerGuid && Math.hypot(p.x - tr.x, p.y - tr.y) <= 5.0);
      if (!pj) return { ok: false, reason: "No pallet jack within rack stowage range." };
      if (pj.operatorGuid !== 0) return { ok: false, reason: "ISO 3691-5: Release tiller before stowing pallet jack." };
      if (pj.carriedWcid !== 0) return { ok: false, reason: "ISO 3691-5: Drop cargo before stowing pallet jack." };
      pj.stowedOnTrailerGuid = tr.guid;
      tr.stowedPalletJackGuid = pj.guid;
      this.wireOpcodes.push(OPCODES.Vehicle_PalletJackState);
      return { ok: true };
    }

    if (
      action === TRAILER_ACTION_KIND.SideliftOffload ||
      action === TRAILER_ACTION_KIND.SideliftLoad ||
      action === TRAILER_ACTION_KIND.AutoOffload ||
      action === TRAILER_ACTION_KIND.AutoLoad
    ) {
      const isAuto = action === TRAILER_ACTION_KIND.AutoOffload || action === TRAILER_ACTION_KIND.AutoLoad;
      const isLoad = action === TRAILER_ACTION_KIND.SideliftLoad || action === TRAILER_ACTION_KIND.AutoLoad;
      let targetCont = null;
      if (!isLoad) {
        if (!tr.mountedContainerGuid) {
          const reason = "ISO 3874: No container mounted on trailer to offload.";
          this.events.push({ kind: VEHICLE_EVENT_KIND.SideliftRefused, reason });
          return { ok: false, reason };
        }
        targetCont = this.containers.get(tr.mountedContainerGuid) || null;
      } else {
        if (tr.mountedContainerGuid !== 0) {
          const reason = "ISO 3874: Trailer deck already occupied.";
          this.events.push({ kind: VEHICLE_EVENT_KIND.SideliftRefused, reason });
          return { ok: false, reason };
        }
        targetCont = [...this.containers.values()].find((c) => c.mountedOnTrailerGuid === 0 && Math.hypot(c.x - tr.x, c.y - tr.y) < 8) || null;
      }
      const check = oracleCheckSideliftInterlocks({ trailer: tr, tractor, container: targetCont, action, slopeCos: tr.slopeCos });
      if (!check.ok) {
        this.events.push({ kind: VEHICLE_EVENT_KIND.SideliftRefused, reason: check.reason });
        return check;
      }
      if (isAuto) {
        tr.outriggersPlanted = true;
        tr.outriggerProgress = 1.0;
        tr.twistlocksLocked = false;
      }
      tr.sideliftSide = side;
      this.events.push({ kind: VEHICLE_EVENT_KIND.SideliftStarted });
      if (!isLoad) {
        tr.mountedContainerGuid = 0;
        targetCont.mountedOnTrailerGuid = 0;
        targetCont.x = tr.x + side * LOGISTICS_SPEC.sidelifter.outreachX;
        targetCont.y = tr.y;
        targetCont.z = tr.z;
        if (tractor) tractor.towMassMul = LOGISTICS_SPEC.towMassMul.emptyChassis;
      } else {
        tr.mountedContainerGuid = targetCont.guid;
        targetCont.mountedOnTrailerGuid = tr.guid;
        targetCont.x = tr.x;
        targetCont.y = tr.y;
        targetCont.z = tr.z + LOGISTICS_SPEC.sidelifter.chassisDeckZ;
        tr.twistlocksLocked = true;
        if (tractor) tractor.towMassMul = LOGISTICS_SPEC.towMassMul.loaded40ft;
      }
      if (isAuto) {
        tr.outriggersPlanted = false;
        tr.outriggerProgress = 0;
        tr.sideliftPhase = SIDELIFT_PHASE.Idle;
      } else {
        tr.sideliftPhase = SIDELIFT_PHASE.OutriggersPlanted;
      }
      this.events.push({ kind: VEHICLE_EVENT_KIND.SideliftComplete });
      this.wireOpcodes.push(OPCODES.Vehicle_ContainerState);
      return { ok: true };
    }
    return { ok: false, reason: "unsupported trailer action" };
  }

  openContainerDoors(cGuid, open) {
    const c = this.containers.get(cGuid);
    if (!c) return { ok: false, reason: "missing container" };
    if (c.mountedOnTrailerGuid) {
      const tr = this.trailers.get(c.mountedOnTrailerGuid);
      const tractor = tr?.coupledTractorGuid ? this.tractors.get(tr.coupledTractorGuid) : null;
      if (tractor && Math.abs(tractor.speed) > 0.25) {
        return { ok: false, reason: "ISO 3874: Cannot open container doors while tractor is moving." };
      }
    }
    c.doorState = open ? 2 : 0;
    c.doorProgress = open ? 1.0 : 0.0;
    return { ok: true };
  }

  palletJackAction(pjGuid, action, opts = {}) {
    const { playerGuid = 1001, targetGuid = 0, slotIndex = 0, subSlot = 0 } = opts;
    const pj = this.palletJacks.get(pjGuid);
    if (!pj && action !== PALLET_JACK_ACTION_KIND.ToggleDeployableStow) {
      return { ok: false, reason: "missing pallet jack" };
    }
    this.wireOpcodes.push(OPCODES.Vehicle_PalletJackAction, OPCODES.Vehicle_PalletJackState);

    if (action === PALLET_JACK_ACTION_KIND.Grab) {
      if (pj.stowedOnTrailerGuid) return { ok: false, reason: "Unstow pallet jack from trailer rack first." };
      if (pj.operatorGuid && pj.operatorGuid !== playerGuid) return { ok: false, reason: "Pallet jack already operated." };
      pj.operatorGuid = playerGuid;
      return { ok: true };
    }
    if (action === PALLET_JACK_ACTION_KIND.Release) {
      pj.operatorGuid = 0;
      return { ok: true };
    }
    if (action === PALLET_JACK_ACTION_KIND.UpdatePose) {
      if (!pj.operatorGuid || pj.stowedOnTrailerGuid) {
        return { ok: false, reason: "ISO 3691-5: Grab unstowed pallet jack before steering." };
      }
      const nx = opts.x ?? pj.x;
      const ny = opts.y ?? pj.y;
      const nz = opts.z ?? pj.z;
      const dtSec = opts.dtSec ?? (1 / LOGISTICS_SPEC.palletJack.poseSyncHz);
      if (![nx, ny, nz, dtSec].every(Number.isFinite) || dtSec <= 0) {
        return { ok: false, reason: "Invalid pallet jack pose update." };
      }
      const stepDist = Math.hypot(nx - pj.x, ny - pj.y);
      const speedMps = stepDist / dtSec;
      if (speedMps > LOGISTICS_SPEC.palletJack.serverSpeedCapMps + 1e-6) {
        this.events.push({ kind: VEHICLE_EVENT_KIND.PalletJackEvent, reason: "ISO 3691-5: Speed exceeds 3.2 m/s anti-teleport cap." });
        return { ok: false, reason: "ISO 3691-5: Speed exceeds 3.2 m/s anti-teleport cap.", speedMps };
      }
      pj.x = nx;
      pj.y = ny;
      pj.z = nz;
      if (Number.isFinite(opts.heading)) pj.heading = wrapHeading(opts.heading);
      if (Number.isFinite(opts.tillerAngle)) {
        const maxT = LOGISTICS_SPEC.palletJack.maxTillerRad;
        pj.tillerAngle = Math.max(-maxT, Math.min(maxT, opts.tillerAngle));
      }
      return { ok: true, speedMps };
    }
    if (action === PALLET_JACK_ACTION_KIND.RaiseForks) {
      if (!pj.operatorGuid || pj.stowedOnTrailerGuid) {
        return { ok: false, reason: "ISO 3691-5: Grab unstowed pallet jack before operating forks." };
      }
      pj.forkHeightM = LOGISTICS_SPEC.palletJack.forkRaisedM;
      pj.forkState = FORK_STATE.Raised;
      return { ok: true };
    }
    if (action === PALLET_JACK_ACTION_KIND.LowerForks) {
      if (!pj.operatorGuid || pj.stowedOnTrailerGuid) {
        return { ok: false, reason: "ISO 3691-5: Grab unstowed pallet jack before operating forks." };
      }
      pj.forkHeightM = LOGISTICS_SPEC.palletJack.forkLoweredM;
      pj.forkState = FORK_STATE.Lowered;
      return { ok: true };
    }
    if (action === PALLET_JACK_ACTION_KIND.ToggleDeployableStow) {
      const d = this.deployables.get(targetGuid);
      if (!d) return { ok: false, reason: "missing deployable" };
      d.isStowed = !d.isStowed;
      if (d.isStowed) {
        d.onlineFlags = ONLINE_FLAGS.Stowed;
        d.elevationM = 0;
        d.powerWatts = 0;
      } else {
        d.onlineFlags = ONLINE_FLAGS.Powered | ONLINE_FLAGS.InFluxRange | ONLINE_FLAGS.Active;
      }
      this.recomputeMicroGrid();
      return { ok: true, isStowed: d.isStowed };
    }
    if (action === PALLET_JACK_ACTION_KIND.PickGroundDeployable) {
      if (!pj.operatorGuid || pj.stowedOnTrailerGuid) {
        return { ok: false, reason: "ISO 3691-5: Grab unstowed pallet jack before engaging pallet." };
      }
      if (pj.carriedWcid !== 0) return { ok: false, reason: "ISO 3691-5: Forks already carrying a pallet." };
      if (pj.forkHeightM > LOGISTICS_SPEC.palletJack.forkPickupMaxM) {
        return { ok: false, reason: "ISO 3691-5: Lower forks before engaging pallet." };
      }
      const d = this.deployables.get(targetGuid);
      if (!d) return { ok: false, reason: "missing deployable" };
      if (!d.isStowed || (d.onlineFlags & ONLINE_FLAGS.Stowed) === 0 || (d.elevationM ?? 0) > LOGISTICS_SPEC.palletJack.elevMaxM) {
        this.events.push({ kind: VEHICLE_EVENT_KIND.PalletJackEvent, reason: "ISO 3691-5: Deployable must be stowed and lowered before pickup." });
        return { ok: false, reason: "ISO 3691-5: Deployable must be stowed and lowered before pickup." };
      }
      pj.carriedWcid = d.wcid;
      pj.carriedPalletSize = 2;
      pj.carriedCargoState = { ...(d.cargoState || { ammo: 0, fuel: 0, energy: 0 }) };
      pj.forkHeightM = LOGISTICS_SPEC.palletJack.forkRaisedM;
      pj.forkState = FORK_STATE.Raised;
      this.deployables.delete(targetGuid);
      this.recomputeMicroGrid();
      return { ok: true };
    }
    if (action === PALLET_JACK_ACTION_KIND.DropToGround) {
      if (!pj.operatorGuid || pj.stowedOnTrailerGuid) {
        return { ok: false, reason: "ISO 3691-5: Grab unstowed pallet jack before dropping cargo." };
      }
      if (!pj.carriedWcid) return { ok: false, reason: "Nothing on forks to drop." };
      const dGuid = this.allocGuid();
      const spec = ALL_9_DEPLOYABLES.find((x) => x.wcid === pj.carriedWcid) || ALL_9_DEPLOYABLES[0];
      this.deployables.set(dGuid, {
        guid: dGuid,
        wcid: pj.carriedWcid,
        kind: spec.kind,
        x: pj.x,
        y: pj.y,
        z: pj.z,
        isStowed: true,
        onlineFlags: ONLINE_FLAGS.Stowed,
        elevationM: 0,
        powerWatts: 0,
        cargoState: { ...pj.carriedCargoState },
      });
      pj.carriedWcid = 0;
      pj.carriedPalletSize = 0;
      pj.carriedCargoState = { ammo: 0, fuel: 0, energy: 0 };
      pj.forkHeightM = LOGISTICS_SPEC.palletJack.forkLoweredM;
      pj.forkState = FORK_STATE.Lowered;
      return { ok: true, deployableGuid: dGuid };
    }
    if (action === PALLET_JACK_ACTION_KIND.PickContainerSlot) {
      if (!pj.operatorGuid || pj.stowedOnTrailerGuid) {
        return { ok: false, reason: "ISO 3691-5: Grab unstowed pallet jack before picking container slot." };
      }
      if (pj.carriedWcid !== 0) return { ok: false, reason: "ISO 3691-5: Forks already carrying a pallet." };
      if (pj.forkHeightM > LOGISTICS_SPEC.palletJack.forkPickupMaxM) {
        return { ok: false, reason: "ISO 3691-5: Lower forks before engaging pallet." };
      }
      const c = this.containers.get(targetGuid);
      if (!c) return { ok: false, reason: "missing container" };
      if (c.mountedOnTrailerGuid !== 0) {
        return { ok: false, reason: "ISO 3874: Offload container to ground before pallet jack entry." };
      }
      if (c.doorProgress < 0.95) {
        return { ok: false, reason: "ISO 3874: Open container doors before entering." };
      }
      const idx = c.slots.findIndex((s) => s.slotIndex === slotIndex && s.subSlot === subSlot);
      if (idx === -1) return { ok: false, reason: "Container slot is empty." };
      const lifo = oracleComputeReachableUnloadSlots(c.kind, c.slots);
      const hit = lifo.reachable.find((r) => r.slotIndex === slotIndex && r.subSlot === subSlot);
      if (!hit) {
        const blk = lifo.blocked.find((b) => b.slotIndex === slotIndex && b.subSlot === subSlot);
        return { ok: false, reason: `ISO 6780 LIFO: Slot ${slotIndex} blocked by outer slot ${blk?.blockedBySlotIndex ?? "?"}.`, blockedBySlotIndex: blk?.blockedBySlotIndex };
      }
      const [removed] = c.slots.splice(idx, 1);
      pj.carriedWcid = removed.cargoWcid;
      pj.carriedPalletSize = removed.palletSize;
      pj.carriedCargoState = { ...(removed.cargoState || { ammo: 0, fuel: 0, energy: 0 }) };
      pj.forkHeightM = LOGISTICS_SPEC.palletJack.forkRaisedM;
      pj.forkState = FORK_STATE.Raised;
      return { ok: true };
    }
    if (action === PALLET_JACK_ACTION_KIND.LoadContainerSlot) {
      if (!pj.operatorGuid || pj.stowedOnTrailerGuid) {
        return { ok: false, reason: "ISO 3691-5: Grab unstowed pallet jack before loading container slot." };
      }
      if (!pj.carriedWcid) return { ok: false, reason: "No pallet on forks to load." };
      const c = this.containers.get(targetGuid);
      if (!c) return { ok: false, reason: "missing container" };
      if (c.mountedOnTrailerGuid !== 0) {
        return { ok: false, reason: "ISO 3874: Offload container to ground before pallet jack entry." };
      }
      if (c.doorProgress < 0.95) {
        return { ok: false, reason: "ISO 3874: Open container doors before loading." };
      }
      if (pj.carriedPalletSize === 1) {
        return { ok: false, reason: "ISO 6780: Legacy half pallet size rejected; unified full pallet required." };
      }
      const reach = oracleComputeReachableLoadSlots(c.kind, c.slots, "full");
      const hit = reach.find((r) => r.slotIndex === slotIndex && r.subSlot === subSlot);
      if (!hit) {
        return { ok: false, reason: `ISO 6780: Slot ${slotIndex}:${subSlot} unavailable or blocked.` };
      }
      c.slots.push({
        slotIndex,
        subSlot: 0,
        cargoWcid: pj.carriedWcid,
        palletSize: 2,
        cargoState: { ...pj.carriedCargoState },
      });
      pj.carriedWcid = 0;
      pj.carriedPalletSize = 0;
      pj.carriedCargoState = { ammo: 0, fuel: 0, energy: 0 };
      pj.forkHeightM = LOGISTICS_SPEC.palletJack.forkLoweredM;
      pj.forkState = FORK_STATE.Lowered;
      return { ok: true };
    }
    return { ok: false, reason: "unsupported action" };
  }

  recomputeMicroGrid() {
    const activeFlux = [...this.deployables.values()].filter((d) => d.wcid === 4000010 && !d.isStowed);
    let totalGenW = 0;
    for (const d of this.deployables.values()) {
      if (d.isStowed) continue;
      const spec = ALL_9_DEPLOYABLES.find((x) => x.wcid === d.wcid);
      if (spec && spec.powerW > 0) totalGenW += spec.powerW;
      if (d.wcid === 4000013 && (d.cargoState?.energy ?? 0) > 0) totalGenW += 15000;
    }
    for (const d of this.deployables.values()) {
      const spec = ALL_9_DEPLOYABLES.find((x) => x.wcid === d.wcid);
      if (d.isStowed) {
        d.onlineFlags = ONLINE_FLAGS.Stowed;
        d.powerWatts = 0;
        continue;
      }
      const inFlux = activeFlux.some((f) => Math.hypot(f.x - d.x, f.y - d.y) <= 75.0);
      const hasPower = spec.powerW >= 0 || (inFlux && totalGenW > 0);
      d.onlineFlags = (hasPower ? ONLINE_FLAGS.Powered : 0) | (inFlux ? ONLINE_FLAGS.InFluxRange : 0) | ONLINE_FLAGS.Active;
      d.powerWatts = hasPower ? spec.powerW : 0;
    }
  }
}

// =============================================================================
// Dynamic Probing & Test Runner Framework
// =============================================================================

export async function tryImportVehicle(relPath) {
  const abs = path.join(APP_ROOT, "scene3d", "vehicle", relPath);
  if (!existsSync(abs)) {
    return { ok: false, path: abs, mod: null, reason: `Missing module scene3d/vehicle/${relPath}` };
  }
  try {
    const mod = await import(pathToFileURL(abs).href);
    return { ok: true, path: abs, mod, reason: null };
  } catch (err) {
    return { ok: false, path: abs, mod: null, reason: `Import failed for scene3d/vehicle/${relPath}: ${err?.message || err}` };
  }
}

export function readXmlProtocol() {
  const p = path.join(PROTOCOL_DIR, "vehicles.protocol.xml");
  return { path: p, exists: existsSync(p), text: existsSync(p) ? readFileSync(p, "utf8") : "" };
}

export function readProtocolFixtures() {
  const outPath = path.join(PROTOCOL_DIR, "vehicle-wire-fixtures.json");
  return {
    outputPath: outPath,
    output: existsSync(outPath) ? JSON.parse(readFileSync(outPath, "utf8")) : null,
  };
}

export async function tryLoadWasmPkg() {
  const jsPath = path.join(APP_ROOT, "pkg", "holtburger_web.js");
  const wasmPath = path.join(APP_ROOT, "pkg", "holtburger_web_bg.wasm");
  if (!existsSync(jsPath) || !existsSync(wasmPath)) {
    return { ok: false, reason: "pkg/holtburger_web.js or pkg/holtburger_web_bg.wasm not built" };
  }
  try {
    const ns = await import(pathToFileURL(jsPath).href);
    const bytes = readFileSync(wasmPath);
    if (typeof ns.default === "function") {
      await ns.default({ module_or_path: bytes });
    }
    return { ok: true, ns };
  } catch (err) {
    return { ok: false, reason: `WASM load failed: ${err?.message || err}` };
  }
}

export function aceFilePath(relPath) {
  return path.join(ACE_ROOT, relPath);
}

export class SuiteCollector {
  constructor(ctx) {
    this.ctx = ctx; // { mode, strict, filter, bail, quiet, liveSession, outDir }
    this.results = [];
  }

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

  async runDual(id, tier, feature, offlineFn, liveFn) {
    if (!this._matchesFilter(id, feature)) return;
    if (this.ctx.bail && this.results.some((r) => r.status === "FAIL")) return;
    const t0 = Date.now();
    const isLive = this.ctx.mode === "live";
    if (isLive && !this.ctx.liveSession) {
      this._record({
        id,
        tier,
        feature,
        mode: "live",
        status: "FAIL",
        durationMs: Date.now() - t0,
        detail: "LiveSession not initialized",
      });
      return;
    }
    try {
      if (isLive) {
        await liveFn(this.ctx.liveSession, this.ctx);
      } else {
        await offlineFn(this.ctx);
      }
      this._record({
        id,
        tier,
        feature,
        mode: isLive ? "live" : "offline",
        status: "PASS",
        durationMs: Date.now() - t0,
        detail: "",
      });
    } catch (err) {
      if (isLive && this.ctx.liveSession && !this.ctx.quiet) {
        try {
          const diag = await this.ctx.liveSession.evalInPage(`
            const v = window.__vehicles;
            const gl = document.querySelector("canvas")?.getContext("webgl2");
            return {
              gl: gl ? gl.getParameter(0x1F01) : null,
              glLost: gl ? gl.isContextLost() : null,
              bootState: window.__bootState,
              frameTime: window.liveScene3d?.frameTime || null,
              syncAgeMs: typeof window.__syncTickLastEnqueueMs === "number" ? Math.round(performance.now() - window.__syncTickLastEnqueueMs) : null,
              rafWorks: await new Promise((r) => { const tid = setTimeout(() => r(false), 500); requestAnimationFrame(() => { clearTimeout(tid); r(true); }); }),
              trailers: (v?.trailers?.list?.() || []).map(t => ({ g: t.guid, ph: t.sideliftPhase, mc: t.mountedContainerGuid, pj: t.stowedPalletJackGuid })),
              containers: (v?.containers?.list?.() || []).map(c => ({ g: c.guid, dp: c.doorProgress, ds: c.doorState })),
              pjs: (v?.palletJacks?.list?.() || []).map(p => ({ g: p.guid, op: p.operatorGuid, st: p.stowedOnTrailerGuid })),
              deps: (v?.deployables?.list?.() || []).map(d => ({ g: d.guid, w: d.wcid, fl: d.last?.onlineFlags, pw: d.last?.powerWatts })),
              st: v?.status?.()?.wire,
              stats: v?.status?.()?.stats,
              unhandled: window.__e2eUnhandled || [],
            };
          `).catch(() => null);
          const chats = await this.ctx.liveSession.getChatLines().catch(() => []);
          const warns = (this.ctx.liveSession._warnMessages || []).slice(-5);
          const errs = (this.ctx.liveSession.consoleMessages || []).concat(this.ctx.liveSession.pageErrors || []).slice(-5);
          console.error(`[DIAG ${id}]`, JSON.stringify({ diag, warns, errs, chats: chats.slice(-6) }));
        } catch (_) {}
      }
      this._record({
        id,
        tier,
        feature,
        mode: isLive ? "live" : "offline",
        status: "FAIL",
        durationMs: Date.now() - t0,
        detail: err?.message || String(err),
      });
    }
  }
}

// =============================================================================
// Corrected Headless Vehicle Integration Mock Environment (makeLogisticsLiveEnv)
// =============================================================================

export async function makeLogisticsLiveEnv({
  localGuid = 1001,
  vehGuid = 0x80099001,
  trailerGuid = 0x80099101,
  containerGuid = 0x80099201,
  terrainHeightAt = () => 10,
} = {}) {
  const THREE = await getThree();
  const { mod: idxMod, ok, reason } = await tryImportVehicle("index.js");
  if (!ok) throw new Error(reason);

  const byId = new Map();
  const addNodeListener = (map, evt, fn, opts) => {
    const cap = typeof opts === "boolean" ? opts : Boolean(opts?.capture);
    if (!map.has(evt)) map.set(evt, new Set());
    map.get(evt).add({ fn, cap });
  };
  const delNodeListener = (map, evt, fn, opts) => {
    const cap = typeof opts === "boolean" ? opts : Boolean(opts?.capture);
    const s = map.get(evt);
    if (!s) return;
    for (const item of s) {
      if (item.fn === fn && item.cap === cap) { s.delete(item); break; }
    }
  };
  const dispatchToMap = (map, type, baseEvent) => {
    const s = map.get(type);
    if (!s) return baseEvent;
    const entries = [...s];
    const ordered = [
      ...entries.filter((e) => e.cap),
      ...entries.filter((e) => !e.cap),
    ];
    for (const item of ordered) {
      if (baseEvent._stopImmediate) break;
      item.fn(baseEvent);
    }
    return baseEvent;
  };
  const dispatchPhase = (map, type, baseEvent, capFlag) => {
    const s = map.get(type);
    if (!s) return baseEvent;
    for (const item of [...s]) {
      if (item.cap !== capFlag) continue;
      if (baseEvent._stopImmediate) break;
      item.fn(baseEvent);
    }
    return baseEvent;
  };

  const mkNode = (tag) => {
    let txt = "";
    let cls = "";
    let id = "";
    const listeners = new Map();
    const classSet = new Set();
    const n = {
      tag,
      tagName: tag.toUpperCase(),
      children: [],
      attrs: {},
      dataset: {},
      style: new Proxy({}, { set(t, p, v) { t[p] = v; return true; } }),
      classList: {
        add(...xs) { xs.forEach((x) => classSet.add(x)); cls = [...classSet].join(" "); },
        remove(...xs) { xs.forEach((x) => classSet.delete(x)); cls = [...classSet].join(" "); },
        toggle(x, f) {
          if (f === undefined) { if (classSet.has(x)) classSet.delete(x); else classSet.add(x); }
          else if (f) classSet.add(x); else classSet.delete(x);
          cls = [...classSet].join(" ");
        },
        contains(x) { return classSet.has(x); },
      },
      get id() { return id; },
      set id(v) { id = v; if (v) byId.set(v, n); },
      get className() { return cls; },
      set className(v) { cls = v; },
      get textContent() { return txt; },
      set textContent(v) { txt = String(v); },
      setAttribute(k, v) { this.attrs[k] = String(v); },
      appendChild(child) { this.children.push(child); if (child.id) byId.set(child.id, child); return child; },
      remove() { if (id) byId.delete(id); },
      querySelector() { return null; },
      addEventListener(evt, fn, opts) { addNodeListener(listeners, evt, fn, opts); },
      removeEventListener(evt, fn, opts) { delNodeListener(listeners, evt, fn, opts); },
      dispatchEvent(ev) { return dispatchToMap(listeners, ev.type, ev); },
    };
    return n;
  };

  const docListeners = new Map();
  const canvasListeners = new Map();
  const canvas = {
    tagName: "CANVAS",
    clientWidth: 1280,
    clientHeight: 720,
    style: {},
    requestPointerLock() {},
    addEventListener(t, fn, opts) { addNodeListener(canvasListeners, t, fn, opts); },
    removeEventListener(t, fn, opts) { delNodeListener(canvasListeners, t, fn, opts); },
    dispatchEvent(ev) { return dispatchToMap(canvasListeners, ev.type, ev); },
  };
  const doc = {
    head: mkNode("head"),
    body: mkNode("body"),
    activeElement: null,
    pointerLockElement: null,
    getElementById: (id) => byId.get(id) ?? null,
    createElement: (tag) => mkNode(tag),
    querySelector: (sel) => (sel === "canvas" ? canvas : null),
    exitPointerLock() { doc.pointerLockElement = null; },
    addEventListener(t, fn, opts) { addNodeListener(docListeners, t, fn, opts); },
    removeEventListener(t, fn, opts) { delNodeListener(docListeners, t, fn, opts); },
    dispatchEvent(ev) { return dispatchToMap(docListeners, ev.type, ev); },
  };

  const winListeners = new Map();
  let localGuidVal = localGuid;
  const funnelCalls = { releaseHeld: 0, poison: [], unpoison: 0, cancelJumpCharge: 0 };
  const fakeWinObj = {
    location: { search: "?vehicles=on" },
    document: doc,
    navigator: { getGamepads: () => [] },
    innerWidth: 1280,
    innerHeight: 720,
    __inputFunnel: {
      _fault: null,
      releaseHeld() { funnelCalls.releaseHeld++; },
      poison(v) { this._fault = v; funnelCalls.poison.push(v); },
      unpoison() { this._fault = null; funnelCalls.unpoison++; },
      cancelJumpCharge() { funnelCalls.cancelJumpCharge++; },
    },
    getLocalPlayerGuid: () => localGuidVal,
    setLocalGuid: (g) => { localGuidVal = g; },
    addEventListener(t, fn, opts) { addNodeListener(winListeners, t, fn, opts); },
    removeEventListener(t, fn, opts) { delNodeListener(winListeners, t, fn, opts); },
    dispatch(type, props = {}) {
      const ev = {
        type,
        repeat: false,
        bubbles: true,
        cancelable: true,
        defaultPrevented: false,
        propagationStopped: false,
        _stopImmediate: false,
        target: doc.activeElement || canvas,
        stopPropagation() { this.propagationStopped = true; },
        stopImmediatePropagation() { this.propagationStopped = true; this._stopImmediate = true; },
        preventDefault() { if (this.cancelable) this.defaultPrevented = true; },
        ...props,
      };
      dispatchPhase(winListeners, type, ev, true);
      if (!ev.propagationStopped) dispatchPhase(docListeners, type, ev, true);
      if (!ev.propagationStopped && ev.bubbles !== false) {
        dispatchPhase(docListeners, type, ev, false);
        if (!ev.propagationStopped) dispatchPhase(winListeners, type, ev, false);
      }
      return ev;
    },
    dispatchCanvas(type, props = {}) {
      const ev = {
        type,
        cancelable: true,
        defaultPrevented: false,
        propagationStopped: false,
        _stopImmediate: false,
        preventDefault() { this.defaultPrevented = true; },
        stopPropagation() { this.propagationStopped = true; },
        stopImmediatePropagation() { this.propagationStopped = true; this._stopImmediate = true; },
        ...props,
      };
      dispatchToMap(canvasListeners, type, ev);
      return ev;
    },
  };

  const worldRoot = new THREE.Group();
  const entityMap = new Map();
  const mkEnt = (setupId = 0x0200026b) => {
    const root = new THREE.Group();
    const parts = [];
    for (let i = 0; i < 34; i++) {
      const p = new THREE.Group();
      root.add(p);
      parts.push(p);
    }
    return { root, parts, setupId, _filmHidden: false };
  };

  entityMap.set(vehGuid, mkEnt(0x0200026b));
  entityMap.set(trailerGuid, mkEnt(0x0200026b));
  entityMap.set(containerGuid, mkEnt(0x0200026b));
  entityMap.set(localGuid, mkEnt(0x02000001));

  const activeColliders = new Map();
  const inbox = [];
  const calls = {
    vehicleCapabilities: [],
    vehicleBoard: [],
    vehicleExit: [],
    vehicleInput: [],
    setVehicleSeat: [],
    clearVehicleSeat: [],
    vehicleContainerAction: [],
    vehicleTrailerAction: [],
    vehiclePalletJackAction: [],
    probeContainerSurface: [],
    upsertContainerCollider: [],
    removeContainerCollider: [],
    sendChat: [],
  };

  function analyticProbeContainerSurface(worldX, worldY, ceilingZ = Infinity) {
    calls.probeContainerSurface.push({ worldX, worldY, ceilingZ });
    if (!Number.isFinite(worldX) || !Number.isFinite(worldY) || Number.isNaN(ceilingZ)) {
      return null;
    }
    const maxZ = ceilingZ + 1e-3;
    let best = null;
    const consider = (z, normalX, normalY, normalZ, zone, guid) => {
      if (z <= maxZ && (!best || z > best.z)) {
        best = { z, normalX, normalY, normalZ, normal: [normalX, normalY, normalZ], zone, guid };
      }
    };
    for (const c of activeColliders.values()) {
      const spec = LOGISTICS_SPEC.containers[c.kind] || LOGISTICS_SPEC.containers[10];
      const [gx, gy, gz] = toGlobal(c.cell, c.x, c.y, c.z);
      const dx = worldX - gx;
      const dy = worldY - gy;
      const ch = Math.cos(c.heading || 0);
      const sh = Math.sin(c.heading || 0);
      const lx = dx * ch - dy * sh;
      const ly = dx * sh + dy * ch;
      const hw = spec.intW / 2;   // 1.176
      const hl = spec.intL / 2;   // 2.949 (20ft) / 6.016 (40ft/40HC)
      const extHw = spec.extW / 2; // 1.219
      const extHl = spec.extL / 2; // 3.029 / 6.096

      // 1. Interior floor (src/lib.rs:47457-47465)
      if (Math.abs(lx) <= hw && ly >= -hl && ly <= hl) {
        consider(gz + spec.floorZ, 0, 0, 1, "floor", c.guid);
      }
      // 2. Exterior roof (src/lib.rs:47467-47476)
      if (Math.abs(lx) <= extHw && ly >= -extHl && ly <= extHl) {
        consider(gz + spec.extH, 0, 0, 1, "roof", c.guid);
      }
      // 6. Fold-down loading ramp when doorOpen (src/lib.rs:47511-47525)
      if (c.doorOpen && Math.abs(lx) <= hw && ly >= -hl - spec.rampLen && ly < -hl) {
        const frac = (ly - (-hl - spec.rampLen)) / spec.rampLen; // 0 at toe -> 1 at sill
        const z = gz + spec.floorZ * Math.max(0, Math.min(1, frac));
        const rLen = Math.hypot(spec.rampLen, spec.floorZ);
        const nyLocal = -spec.floorZ / rLen;
        const nzLocal = spec.rampLen / rLen;
        consider(z, nyLocal * sh, nyLocal * ch, nzLocal, "ramp", c.guid);
      }
    }
    return best;
  }

  const mkAudioNode = () => ({ connect() { return this; }, disconnect() {} });
  const fakeParam = (v = 0) => ({
    value: v,
    setTargetAtTime(t) { this.value = t; },
    setValueAtTime(t) { this.value = t; },
    linearRampToValueAtTime() {},
    exponentialRampToValueAtTime() {},
    cancelScheduledValues() {},
  });
  const fakeCtx = {
    state: "running",
    currentTime: 1.0,
    sampleRate: 8000,
    createGain: () => ({ ...mkAudioNode(), gain: fakeParam(1) }),
    createOscillator: () => ({
      ...mkAudioNode(),
      type: "sine",
      frequency: fakeParam(110),
      detune: fakeParam(0),
      setPeriodicWave() {},
      start() {},
      stop() {},
      onended: null,
    }),
    createBiquadFilter: () => ({ ...mkAudioNode(), type: "lowpass", frequency: fakeParam(800), Q: fakeParam(1), gain: fakeParam(0) }),
    createWaveShaper: () => ({ ...mkAudioNode(), curve: null, oversample: "none" }),
    createPeriodicWave: (r, im) => ({ r, im }),
    createPanner: () => ({
      ...mkAudioNode(),
      panningModel: "HRTF",
      distanceModel: "inverse",
      refDistance: 18,
      maxDistance: 1800,
      rolloffFactor: 1,
      positionX: fakeParam(0),
      positionY: fakeParam(0),
      positionZ: fakeParam(0),
    }),
    createBuffer: (_ch, len, sr) => ({ sampleRate: sr, length: len, getChannelData: () => new Float32Array(len) }),
    createBufferSource: () => ({ ...mkAudioNode(), buffer: null, loop: false, playbackRate: fakeParam(1), start() {}, stop() {}, onended: null }),
  };
  const masterBusNode = fakeCtx.createGain();

  const live = {
    worldRoot,
    scene: worldRoot,
    camera: new THREE.PerspectiveCamera(70, 16 / 9, 0.5, 10000),
    renderer: { domElement: canvas },
    localPlayerGuid: localGuid,
    nullRender: false,
    audioManager: {
      getEffectBus: () => ({ ctx: fakeCtx, node: masterBusNode, sliderGain: () => 1.0 }),
      isActive: () => true,
      notifyUserGesture() {},
    },
    entityManager: {
      localPlayerGuid: localGuid,
      entityMap,
      setFilmHidden(guid, h) {
        const e = entityMap.get(guid);
        if (!e) return false;
        e._filmHidden = h;
        return true;
      },
      setMotion() {},
    },
    sessionHandle: {
      vehicleCapabilities(flags) { calls.vehicleCapabilities.push(flags); },
      drainVehicleMessages: () => { const out = JSON.stringify(inbox); inbox.length = 0; return out; },
      terrainHeightAt,
      setVehicleSeat(guid, cell, x, y, z, h) { calls.setVehicleSeat.push({ guid, cell, x, y, z, h }); },
      clearVehicleSeat(guid) { calls.clearVehicleSeat.push(guid); },
      vehicleInput(guid, input) { calls.vehicleInput.push({ guid, input }); },
      vehicleBoard(guid, seat) { calls.vehicleBoard.push({ guid, seat }); },
      vehicleExit(guid, mode) { calls.vehicleExit.push({ guid, mode }); },
      vehicleContainerAction(cGuid, action, slotIndex, subSlot, cargoWcid) {
        calls.vehicleContainerAction.push({ cGuid, action, slotIndex, subSlot, cargoWcid });
      },
      vehicleTrailerAction(tGuid, vGuid, cGuid, action, slot, flags = 0) {
        calls.vehicleTrailerAction.push({ tGuid, vGuid, cGuid, action, slot, flags });
      },
      vehiclePalletJackAction(jackGuid, action, slotIndex, subSlot, flags, targetGuid, cell, x, y, z, heading, tillerAngle) {
        calls.vehiclePalletJackAction.push({
          jackGuid, action, slotIndex, subSlot, flags, targetGuid, cell, x, y, z, heading, tillerAngle,
        });
      },
      probeContainerSurface: analyticProbeContainerSurface,
      upsertContainerCollider(guid, cell, x, y, z, heading, kind, doorOpen) {
        const rec = { guid, cell, x, y, z, heading, kind, doorOpen };
        calls.upsertContainerCollider.push(rec);
        activeColliders.set(guid, rec);
      },
      removeContainerCollider(guid) {
        calls.removeContainerCollider.push(guid);
        return activeColliders.delete(guid);
      },
      sendChat(msg) { calls.sendChat.push(msg); },
    },
  };

  const api = idxMod.installVehicles({ liveScene3d: live, THREE, window: fakeWinObj });

  return {
    THREE,
    doc,
    byId,
    canvas,
    fakeWinObj,
    funnelCalls,
    worldRoot,
    entityMap,
    mkEnt,
    inbox,
    calls,
    activeColliders,
    live,
    api,
    push(msg) { inbox.push(msg); },
    tick(tMs, dtMs = 33.333) {
      live.vehicles?.afterTick?.(tMs, dtMs);
    },
    dispose() {
      try { api.dispose(); } catch (_) {}
    },
  };
}

// =============================================================================
// Live Browser / Server Session (for --mode live)
// =============================================================================

async function checkTcpReachable(host, port, timeoutMs = 2000) {
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

function paethPredictor(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

export function parsePngDimensionsAndEntropy(buf) {
  if (!buf || buf.length < 33) return { valid: false, reason: "PNG too small (<33B)" };
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i++) {
    if (buf[i] !== sig[i]) return { valid: false, reason: "Invalid PNG magic header" };
  }
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  let hasIhdr = false;
  let hasIdat = false;
  let idatBytes = 0;
  const idatChunks = [];
  let offset = 8;
  while (offset + 12 <= buf.length) {
    const len = buf.readUInt32BE(offset);
    const type = buf.toString("ascii", offset + 4, offset + 8);
    const dataStart = offset + 8;
    if (dataStart + len + 4 > buf.length) break;
    if (offset === 8 && type === "IHDR" && len === 13) {
      hasIhdr = true;
      width = buf.readUInt32BE(dataStart);
      height = buf.readUInt32BE(dataStart + 4);
      bitDepth = buf[dataStart + 8];
      colorType = buf[dataStart + 9];
      interlace = buf[dataStart + 12];
    } else if (type === "IDAT") {
      hasIdat = true;
      idatBytes += len;
      idatChunks.push(buf.subarray(dataStart, dataStart + len));
    } else if (type === "IEND") {
      break;
    }
    offset = dataStart + len + 4;
  }
  if (!hasIhdr || !hasIdat || width < 320 || height < 240) {
    return { valid: false, width, height, idatBytes, distinctPixels: 0, distinctBytes: 0, reason: "Missing IHDR/IDAT or dimensions < 320x240" };
  }
  if (buf.length <= 10 * 1024) {
    return { valid: false, width, height, idatBytes, distinctPixels: 0, distinctBytes: 0, reason: `PNG size ${buf.length}B <= 10240B floor` };
  }
  const bppMap = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
  const bpp = bppMap[colorType];
  if (bitDepth !== 8 || !bpp || interlace !== 0) {
    return { valid: false, width, height, idatBytes, distinctPixels: 0, distinctBytes: 0, reason: `Unsupported PNG format (bitDepth=${bitDepth}, colorType=${colorType}, interlace=${interlace})` };
  }
  let inflated;
  try {
    inflated = inflateSync(Buffer.concat(idatChunks));
  } catch (err) {
    return { valid: false, width, height, idatBytes, distinctPixels: 0, distinctBytes: 0, reason: `IDAT inflate failed: ${err?.message || err}` };
  }
  const rowBytes = width * bpp;
  const stride = 1 + rowBytes;
  if (inflated.length < height * stride) {
    return { valid: false, width, height, idatBytes, distinctPixels: 0, distinctBytes: 0, reason: `Truncated IDAT scanlines (${inflated.length} < ${height * stride})` };
  }
  let prev = new Uint8Array(rowBytes);
  let curr = new Uint8Array(rowBytes);
  const stepY = Math.max(1, Math.floor(height / 64));
  const stepX = Math.max(1, Math.floor(width / 64));
  const distinctPixels = new Set();
  for (let y = 0; y < height; y++) {
    const rowOff = y * stride;
    const filterType = inflated[rowOff];
    if (filterType === 0) {
      curr.set(inflated.subarray(rowOff + 1, rowOff + 1 + rowBytes));
    } else if (filterType === 1) {
      for (let i = 0; i < rowBytes; i++) {
        curr[i] = (inflated[rowOff + 1 + i] + (i >= bpp ? curr[i - bpp] : 0)) & 0xff;
      }
    } else if (filterType === 2) {
      for (let i = 0; i < rowBytes; i++) {
        curr[i] = (inflated[rowOff + 1 + i] + prev[i]) & 0xff;
      }
    } else if (filterType === 3) {
      for (let i = 0; i < rowBytes; i++) {
        const a = i >= bpp ? curr[i - bpp] : 0;
        curr[i] = (inflated[rowOff + 1 + i] + ((a + prev[i]) >> 1)) & 0xff;
      }
    } else if (filterType === 4) {
      for (let i = 0; i < rowBytes; i++) {
        const a = i >= bpp ? curr[i - bpp] : 0;
        const b = prev[i];
        const c = i >= bpp ? prev[i - bpp] : 0;
        curr[i] = (inflated[rowOff + 1 + i] + paethPredictor(a, b, c)) & 0xff;
      }
    } else {
      return { valid: false, width, height, idatBytes, distinctPixels: 0, distinctBytes: 0, reason: `Invalid PNG scanline filter ${filterType} at row ${y}` };
    }
    if (y % stepY === 0 && distinctPixels.size < 32) {
      for (let x = 0; x < width; x += stepX) {
        const p = x * bpp;
        let key;
        if (bpp === 1) key = curr[p];
        else if (bpp === 2) key = (curr[p] << 8) | curr[p + 1];
        else if (bpp === 3) key = ((curr[p] << 16) | (curr[p + 1] << 8) | curr[p + 2]) >>> 0;
        else key = (((curr[p] << 24) | (curr[p + 1] << 16) | (curr[p + 2] << 8) | curr[p + 3]) >>> 0);
        distinctPixels.add(key);
        if (distinctPixels.size >= 32) break;
      }
    }
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }
  const valid = distinctPixels.size >= 16;
  return {
    valid,
    width,
    height,
    idatBytes,
    distinctPixels: distinctPixels.size,
    distinctBytes: distinctPixels.size,
    ...(valid ? {} : { reason: `Uniform/low-entropy PNG (${distinctPixels.size} distinct sampled colors < 16)` }),
  };
}

export class LiveSession {
  constructor({ driverUrl = null, pageUrl = null, outDir = "/tmp/e2e-logistics-live" } = {}) {
    this.driverUrl = driverUrl ? driverUrl.replace(/\/$/, "") : null;
    this.pageUrl = pageUrl;
    this.outDir = outDir;
    this.browser = null;
    this.context = null;
    this.page = null;
    this.heavyHold = null;
    this.consoleMessages = [];
    this.pageErrors = [];
  }

  async connect() {
    mkdirSync(this.outDir, { recursive: true });
    if (this.driverUrl) {
      const res = await fetch(`${this.driverUrl}/chat`).catch((e) => {
        throw new Error(`DRIVER_UNREACHABLE: ${this.driverUrl} (${e.message})`);
      });
      if (!res.ok) throw new Error(`DRIVER_UNREACHABLE: ${this.driverUrl} returned ${res.status}`);
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
            try {
              window.__e2eErrors.push(args.map((a) => (a && a.stack) ? a.stack : String(a)).join(" "));
            } catch (_) {}
            return origErr(...args);
          };
        }
        return true;
      `);
      await this.waitUntil(
        async () => await this.evalInPage(`const st = window.__vehicles?.status?.(); return !!(st?.caps && (st.caps.granted & 0x03) === 0x03);`),
        15000,
        150,
        "driver window.__vehicles caps 0x03"
      ).catch(() => {});
      return;
    }

    const httpUrl = this.pageUrl || (() => {
      const q = new URLSearchParams({
        nosw: "1",
        autoLogin: "1",
        account: process.env.ACCOUNT || "tailnet1",
        password: process.env.PASSWORD || "tailnet1",
        autoSpawn: "first",
        bridge_url: "ws://127.0.0.1:8080/",
        server_host: "127.0.0.1",
        server_port: "9000",
        quality: "ultra",
        clouds: "on",
        camDebug: "on",
        vehicles: "on",
        skytime: process.env.SKYTIME || "0.5",
        cloudCoverage: process.env.COVERAGE || "0.45",
        adaptiveRes: "off",
        portalSpace: "off",
        atmosphereLut: "load",
      });
      return `http://127.0.0.1:8765/apps/holtburger-web/index.html?${q}`;
    })();

    const u = new URL(httpUrl);
    const httpPort = Number(u.port || (u.protocol === "https:" ? 443 : 80));
    const httpUp = await checkTcpReachable(u.hostname, httpPort, 2500);
    if (!httpUp) {
      throw new Error(`SERVER_DOWN: serve.py / HTTP server unreachable at ${u.hostname}:${httpPort}`);
    }
    const bridgeUrl = u.searchParams.get("bridge_url") || "ws://127.0.0.1:8080/";
    const bu = new URL(bridgeUrl);
    const wsPort = Number(bu.port || (bu.protocol === "wss:" ? 443 : 80));
    const wsUp = await checkTcpReachable(bu.hostname, wsPort, 2500);
    if (!wsUp) {
      throw new Error(`SERVER_DOWN: wsbridge unreachable at ${bu.hostname}:${wsPort}`);
    }

    this.heavyHold = await acquireHeavyLock({ label: "e2e-logistics-live" });
    const { chromium } = resolvePlaywrightCore();
    const executablePath = resolveChromeExecutable();
    this.browser = await chromium.launch({
      ...(executablePath ? { executablePath } : {}),
      headless: true,
      args: [
        "--headless=new",
        "--use-gl=angle",
        "--use-angle=gl-egl",
        "--ignore-gpu-blocklist",
        "--enable-gpu-rasterization",
        "--mute-audio",
        "--window-position=-32000,-32000",
        "--disable-renderer-backgrounding",
        "--disable-background-timer-throttling",
        "--disable-backgrounding-occluded-windows",
        "--window-size=1920,1080",
      ],
    });
    this.context = await this.browser.newContext();
    await this.context.addInitScript(() => {
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
    this.page = await this.context.newPage();
    await this.page.setViewportSize({ width: 1920, height: 1080 });
    this.page.on("console", (m) => {
      if (m.type() === "warning" && /threw|error|exception/i.test(m.text())) {
        this._warnMessages = this._warnMessages || [];
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
    this.page.on("pageerror", (e) => {
      this.pageErrors.push(String(e?.stack || e));
    });

    let inWorld = false;
    let createdTestChar = false;
    for (let attempt = 1; attempt <= 4 && !inWorld; attempt++) {
      await this.page.goto(httpUrl, { waitUntil: "domcontentloaded", timeout: 120000 });
      const t0 = Date.now();
      while (Date.now() - t0 < 180000) {
        const st = await this.page
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
          const charInfo = await this.page
            .evaluate(() => ({
              len: window.__sessionHandle?.characterList?.()?.length ?? -1,
              canCreate: !!window.__sessionHandle?.canCreateCharacter,
            }))
            .catch(() => ({}));
          if (charInfo.len === 0 && charInfo.canCreate) {
            createdTestChar = true;
            await this.page
              .evaluate(() => window.__sessionHandle?.createTestCharacter?.("TailnetOne"))
              .catch(() => {});
            const c0 = Date.now();
            while (Date.now() - c0 < 10000) {
              const n = await this.page
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
      await this.close();
      throw new Error("LIVE_BOOT_TIMEOUT: failed to reach in-world state with liveScene3d");
    }
    if (/[?&]vehicles=on\b/i.test(httpUrl)) {
      const vt0 = Date.now();
      let vReady = false;
      let lastStatus = null;
      while (Date.now() - vt0 < 30000) {
        lastStatus = await this.page
          .evaluate(() => window.__vehicles?.status?.() || null)
          .catch(() => null);
        if (lastStatus && lastStatus.caps && (lastStatus.caps.granted & 0x03) === 0x03) {
          vReady = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 150));
      }
      if (!vReady) {
        await this.close();
        throw new Error(`LIVE_VEHICLES_TIMEOUT: window.__vehicles.status().caps (0x03) unavailable after 30000ms (granted=${lastStatus?.caps?.granted ?? "none"})`);
      }
    }
    await this.ensureOutdoorFlatSite();
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
          if (anchor.every((v, k) => lines[i + k] === v)) {
            cut = i + anchorLen;
            break;
          }
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
      } catch (e) {
        lastErr = e;
      }
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
      return {
        landblockId: c,
        cellInLb: c & 0xffff,
        lx: p.x,
        ly: p.y,
        gx: lbX * 192 + p.x,
        gy: (isD ? 68928 : 0) + lbY * 192 + p.y,
        z: p.z,
        heading: p.heading,
      };
    `);
  }

  async ensureOutdoorFlatSite() {
    if (this.driverUrl) return;
    const p0 = await this.getPlayerGlobalPose().catch(() => null);
    const needsTele =
      !p0 ||
      p0.cellInLb >= 0x0100 ||
      ((p0.landblockId >>> 16) & 0xffff) !== 0xa9b3 ||
      Math.hypot(p0.gx - 32467.2, p0.gy - 34392.0) > 4.0 ||
      Math.abs(p0.heading || 0) > 0.35;
    if (needsTele) {
      if (!p0 || ((p0.landblockId >>> 16) & 0xffff) !== 0xa9b3) {
        await this.sendChatAndWait("@tele 41.35N 33.33E", /Position:\s*\[Cell:/i, 12000);
      }
      await this.sendChat("@teleloc 0xA9B30002 19.20 24.00 94.00");
    }
    await this.waitUntil(async () => {
      return await this.evalInPage(`
        const sh = window.__sessionHandle;
        const p = sh?.getLocalPlayerPose?.();
        if (!p) return false;
        const c = p.landblockId >>> 0;
        if (((c >>> 16) & 0xffff) !== 0xa9b3) return false;
        if ((c & 0xffff) >= 0x0100) return false;
        const gx = ((c >>> 24) & 0xff) * 192 + p.x;
        const gy = ((((c >>> 15) & 1) === 1) ? 68928 : 0) + ((c >>> 16) & 0xff) * 192 + p.y;
        const tz = sh.terrainHeightAt?.(gx, gy);
        return Number.isFinite(tz) && Math.hypot(gx - 32467.2, gy - 34392.0) <= 4.0 && Math.abs(p.heading || 0) <= 0.35;
      `);
    }, 15000, 200, "outdoor 0xA9B3 flat terrain ready");
  }

  async movePlayerNear(worldPos, offset = [0, -1.5, 0]) {
    const tx = worldPos[0] + (offset[0] ?? 0);
    const ty = worldPos[1] + (offset[1] ?? 0);
    const tz = worldPos[2] + (offset[2] ?? 0);
    const cl = toCellLocal(tx, ty, tz);
    await this.sendChat(
      `@teleloc 0x${cl.cell.toString(16)} ${cl.x.toFixed(2)} ${cl.y.toFixed(2)} ${cl.z.toFixed(2)}`
    );
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
    assert(st.size > 10 * 1024, `Screenshot ${filePath} too small (${st.size} bytes <= 10 KB)`);
    const info = parsePngDimensionsAndEntropy(readFileSync(filePath));
    assert(info.valid, `Screenshot ${filePath} invalid or uniform: ${JSON.stringify(info)}`);
    return { path: filePath, bytes: st.size, ...info };
  }

  async getVehiclePose(vGuid) {
    return await this.evalInPage(`
      const g = (${vGuid}) >>> 0;
      const api = window.__vehicles;
      if (!api) return null;
      const st = api.status?.() || {};
      const vs = (st.vehicles || []).find((x) => (x.guid >>> 0) === g);
      const sm = (api.semi?.list?.() || []).find((x) => (x.guid >>> 0) === g);
      const raw = (api.vehicles?.() || []).find((x) => (x.guid >>> 0) === g);
      const p = vs?.pos ?? sm?.pos ?? null;
      const pos = p && typeof p.x === "number"
        ? [p.x, p.y, p.z]
        : (Array.isArray(p) ? p : (raw?.last && typeof raw.last.x === "number" ? [raw.last.x, raw.last.y, raw.last.z] : null));
      if (!pos) return null;
      return {
        guid: g,
        pos,
        speed: vs?.speed ?? p?.speed ?? raw?.last?.speed ?? 0,
        heading: p?.heading ?? raw?.last?.heading ?? 0,
        towMassMul: sm?.towMassMul ?? raw?.params?.towMassMul ?? 1.0,
      };
    `);
  }

  async getContainer(cGuid) {
    return await this.evalInPage(`
      const g = (${cGuid}) >>> 0;
      const api = window.__vehicles;
      if (!api) return null;
      const item = (api.containers?.list?.() || []).find((x) => (x.guid >>> 0) === g) || null;
      const raw = api.containers?.get?.(g) || null;
      if (!item && !raw) return null;
      const rootPos = raw?.model?.root?.position
        ? [raw.model.root.position.x, raw.model.root.position.y, raw.model.root.position.z]
        : null;
      const doorProgress = item?.doorProgress ?? raw?.currentDoorProgress ?? raw?.last?.doorProgress ?? 0;
      return {
        guid: g,
        kind: item?.kind ?? raw?.kind ?? 10,
        pos: item?.pos ?? rootPos ?? raw?.rawPos ?? null,
        doorProgress,
        doorOpen: item?.doorOpen ?? (doorProgress >= 0.5),
        slots: raw?.slots ?? raw?.last?.slots ?? item?.slots ?? [],
        heading: raw?.heading ?? raw?.last?.heading ?? 0,
        mountedOnTrailerGuid: raw?.mountedOnTrailerGuid ?? raw?.last?.mountedOnTrailerGuid ?? 0,
        cell: raw?.cell ?? raw?.last?.cell ?? 0,
        rawPos: raw?.rawPos ?? raw?.last?.position ?? null,
      };
    `);
  }

  async getTrailer(tGuid) {
    return await this.evalInPage(`
      const g = (${tGuid}) >>> 0;
      const api = window.__vehicles;
      if (!api) return null;
      const item = (api.trailers?.list?.() || []).find((x) => (x.guid >>> 0) === g) || null;
      const raw = api.trailers?.get?.(g) || null;
      if (!item && !raw) return null;
      const flags = raw?.trailerFlags ?? item?.trailerFlags ?? raw?.last?.trailerFlags ?? 0;
      return {
        guid: g,
        kind: item?.wireKind ?? raw?.kind ?? item?.kind ?? 0,
        wcid: item?.wcid ?? raw?.wcid ?? 0,
        pos: item?.pos ?? raw?.worldPos ?? null,
        heading: item?.heading ?? raw?.heading ?? 0,
        coupledTractorGuid: item?.coupledTractorGuid ?? raw?.coupledTractorGuid ?? raw?.last?.coupledTractorGuid ?? 0,
        mountedContainerGuid: item?.mountedContainerGuid ?? raw?.mountedContainerGuid ?? raw?.last?.mountedContainerGuid ?? 0,
        twistlocksLocked: raw?.twistlocksLocked ?? raw?.twistlockLocked ?? item?.twistlocksLocked ?? item?.twistlockLocked ?? Boolean(flags & 0x02),
        sideliftPhase: raw?.sideliftPhase ?? item?.sideliftPhase ?? raw?.last?.sideliftPhase ?? raw?.last?.SideliftPhase ?? 0,
        outriggerProgress: raw?.outriggerProgress ?? item?.outriggerProgress ?? raw?.last?.outriggerProgress ?? raw?.last?.OutriggerProgress ?? 0,
        sideliftProgress: raw?.sideliftProgress ?? item?.sideliftProgress ?? raw?.last?.sideliftProgress ?? raw?.last?.SideliftProgress ?? 0,
        craneSpanY: raw?.craneSpanY ?? item?.craneSpanY ?? raw?.last?.craneSpanY ?? raw?.last?.CraneSpanY ?? 0,
        stowedPalletJackGuid: raw?.stowedPalletJackGuid ?? item?.stowedPalletJackGuid ?? raw?.last?.stowedPalletJackGuid ?? raw?.last?.StowedPalletJackGuid ?? 0,
      };
    `);
  }

  async getPalletJack(pjGuid) {
    return await this.evalInPage(`
      const g = (${pjGuid}) >>> 0;
      const api = window.__vehicles;
      if (!api) return null;
      const item = (api.palletJacks?.list?.() || []).find((x) => (x.guid >>> 0) === g) || null;
      const raw = api.palletJacks?.get?.(g) || null;
      if (!item && !raw) return null;
      const rootPos = raw?.model?.root?.position
        ? [raw.model.root.position.x, raw.model.root.position.y, raw.model.root.position.z]
        : null;
      return {
        guid: g,
        pos: item?.pos ?? rootPos ?? raw?.worldPos ?? raw?.pos ?? null,
        rawPos: raw?.rawPos ?? raw?.last?.position ?? null,
        cell: raw?.cell ?? raw?.last?.cell ?? 0,
        heading: item?.heading ?? raw?.heading ?? raw?.last?.heading ?? 0,
        operatorGuid: item?.operatorGuid ?? raw?.operatorGuid ?? raw?.last?.operatorGuid ?? 0,
        stowedOnTrailerGuid: item?.stowedOnTrailerGuid ?? raw?.stowedOnTrailerGuid ?? raw?.last?.stowedOnTrailerGuid ?? 0,
        forkHeightM: item?.forkHeightM ?? raw?.forkHeightM ?? raw?.last?.forkHeightM ?? 0.085,
        forkState: item?.forkState ?? raw?.forkState ?? raw?.last?.forkState ?? 0,
        carriedWcid: item?.carriedWcid ?? raw?.carriedWcid ?? raw?.last?.carriedWcid ?? 0,
      };
    `);
  }

  async boardAndWait(vGuid, seat = 0) {
    await this.evalInPage(`window.__vehicles.board(${vGuid}, ${seat}); return true;`);
    await this.waitUntil(
      () => this.evalInPage(`return !!window.__vehicles?.piloting;`),
      6000,
      150,
      "piloting"
    );
  }

  async getSlotWorldPos(cGuid, slotIndex, subSlot = 0) {
    const c = await this.getContainer(cGuid);
    if (!c || !c.pos) throw new Error(`getSlotWorldPos: container ${cGuid} pose unavailable`);
    const slots = oracleGetPinwheelSlots(c.kind);
    const slotDef = slots[slotIndex];
    if (!slotDef) throw new Error(`getSlotWorldPos: invalid slotIndex ${slotIndex}`);
    const box = getSlotAabb(slotDef, false, 0);
    const h = c.heading || 0;
    const ch = Math.cos(h);
    const sh = Math.sin(h);
    return [
      c.pos[0] + box.cx * ch + box.cy * sh,
      c.pos[1] - box.cx * sh + box.cy * ch,
      c.pos[2] + 0.162,
    ];
  }

  async movePalletJackTo(pjGuid, targetWorldPos, { maxStepM = 0.24, stepMs = 100, stopDistM = 0.65, maxSteps = 80 } = {}) {
    const [tx, ty] = targetWorldPos;
    const initialPj = await this.getPalletJack(pjGuid);
    if (!initialPj || !initialPj.pos) throw new Error(`movePalletJackTo: pallet jack ${pjGuid} pose unavailable`);

    if ((initialPj.operatorGuid >>> 0) !== 0) {
      // Jack is currently grabbed -> drive genuinely via pallet_jack_controller WASD
      const containers = await this.evalInPage(`
        return (window.__vehicles?.containers?.list?.() || [])
          .filter((c) => !(c.last?.mountedOnTrailerGuid))
          .map((c) => ({
            guid: c.guid,
            kind: c.kind,
            pos: c.pos,
            heading: c.last?.heading ?? 0,
            halfW: 1.176,
            halfL: (c.kind === 11 || c.kind === 12) ? 6.016 : 2.949,
          }));
      `).catch(() => []);

      const toLocal = (c, wx, wy) => {
        const dx = wx - c.pos[0];
        const dy = wy - c.pos[1];
        const ch = c.heading || 0;
        const cosH = Math.cos(ch);
        const sinH = Math.sin(ch);
        return { lx: dx * cosH - dy * sinH, ly: dx * sinH + dy * cosH };
      };
      const toWorld = (c, lx, ly) => {
        const ch = c.heading || 0;
        const cosH = Math.cos(ch);
        const sinH = Math.sin(ch);
        return [c.pos[0] + lx * cosH + ly * sinH, c.pos[1] - lx * sinH + ly * cosH];
      };

      let cCur = null;
      let cCurLoc = null;
      let cTgt = null;
      let cTgtLoc = null;
      for (const c of containers) {
        if (!c.pos) continue;
        const lp = toLocal(c, initialPj.pos[0], initialPj.pos[1]);
        if (Math.abs(lp.lx) <= c.halfW + 0.45 && lp.ly >= -(c.halfL + 1.0) && lp.ly <= c.halfL + 0.45) {
          cCur = c;
          cCurLoc = lp;
        }
        const lt = toLocal(c, tx, ty);
        if (Math.abs(lt.lx) <= c.halfW + 0.45 && lt.ly >= -(c.halfL + 1.1) && lt.ly <= c.halfL + 0.45) {
          cTgt = c;
          cTgtLoc = lt;
        }
      }

      const waypoints = [];
      if (cCur && (!cTgt || cCur.guid !== cTgt.guid)) {
        const exitW = toWorld(cCur, 0, -(cCur.halfL + 2.8));
        waypoints.push({ x: exitW[0], y: exitW[1], stopDist: 0.7, reverse: true });
        if (!cTgt) {
          const lt = toLocal(cCur, tx, ty);
          if (lt.ly > -(cCur.halfL + 1.2) && Math.abs(lt.lx) > cCur.halfW + 0.5) {
            const stageX = (lt.lx >= 0 ? 1 : -1) * Math.max(Math.abs(lt.lx), 2.6);
            const stageW = toWorld(cCur, stageX, -(cCur.halfL + 3.2));
            waypoints.push({ x: stageW[0], y: stageW[1], stopDist: 0.7, reverse: false });
          }
        }
      }
      if (cTgt && (!cCur || cCur.guid !== cTgt.guid || (cCurLoc && cCurLoc.ly < -(cTgt.halfL + 0.6)))) {
        const startPos = waypoints.length ? [waypoints[waypoints.length - 1].x, waypoints[waypoints.length - 1].y] : initialPj.pos;
        const ls = toLocal(cTgt, startPos[0], startPos[1]);
        if (ls.ly > -(cTgt.halfL + 1.2) && Math.abs(ls.lx) > cTgt.halfW + 0.5) {
          const stageX = (ls.lx >= 0 ? 1 : -1) * Math.max(Math.abs(ls.lx), 2.4);
          const stageW = toWorld(cTgt, stageX, -(cTgt.halfL + 3.2));
          waypoints.push({ x: stageW[0], y: stageW[1], stopDist: 0.7, reverse: false });
        }
        const laneX = Math.max(-0.5, Math.min(0.5, cTgtLoc.lx));
        const apronW = toWorld(cTgt, laneX, -(cTgt.halfL + 3.8));
        const toeW = toWorld(cTgt, laneX, -(cTgt.halfL + 0.9));
        waypoints.push({ x: apronW[0], y: apronW[1], stopDist: 0.95, reverse: false });
        waypoints.push({ x: toeW[0], y: toeW[1], stopDist: 0.7, reverse: false });
      }
      const finalStopDist = cTgt ? Math.max(stopDistM, 0.65) : stopDistM;
      waypoints.push({ x: tx, y: ty, stopDist: finalStopDist, reverse: false });

      const timeoutMs = Math.max(28000, waypoints.length * 10000);
      await this.evalInPage(`
        try { window.__e2eSteerStop?.(); } catch (_) {}
        const pjGuid = ${pjGuid >>> 0};
        const wps = ${JSON.stringify(waypoints)};
        const keyMap = { KeyW: "w", KeyA: "a", KeyS: "s", KeyD: "d" };
        const held = new Set();
        const setKeys = (desired) => {
          for (const k of [...held]) {
            if (!desired.has(k)) {
              held.delete(k);
              window.dispatchEvent(new KeyboardEvent("keyup", { key: keyMap[k], code: k, bubbles: true }));
            }
          }
          for (const k of desired) {
            if (!held.has(k)) {
              held.add(k);
              window.dispatchEvent(new KeyboardEvent("keydown", { key: keyMap[k], code: k, bubbles: true }));
            }
          }
        };
        const angleDiff = (a, b) => {
          let d = a - b;
          while (d > Math.PI) d -= Math.PI * 2;
          while (d < -Math.PI) d += Math.PI * 2;
          return d;
        };
        const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
        let wpIdx = 0;
        let done = false;
        let cancelled = false;
        const t0 = performance.now();
        window.__e2eSteerStatus = () => ({ done, wpIdx, total: wps.length });
        window.__e2eSteerStop = () => { cancelled = true; done = true; setKeys(new Set()); };
        const step = () => {
          if (cancelled) return;
          try {
            const pj = window.__vehicles?.palletJacks?.get?.(pjGuid);
            if (!pj || !pj.pos || (pj.operatorGuid >>> 0) === 0 || wpIdx >= wps.length) {
              setKeys(new Set());
              done = true;
              return;
            }
            if (performance.now() - t0 > ${timeoutMs}) {
              setKeys(new Set());
              done = true;
              return;
            }
            while (wpIdx < wps.length) {
              const wp = wps[wpIdx];
              const d = Math.hypot(wp.x - pj.pos[0], wp.y - pj.pos[1]);
              if (d <= wp.stopDist) wpIdx++;
              else break;
            }
            if (wpIdx >= wps.length) {
              setKeys(new Set());
              done = true;
              return;
            }
            const wp = wps[wpIdx];
            const dx = wp.x - pj.pos[0];
            const dy = wp.y - pj.pos[1];
            const dist = Math.hypot(dx, dy);
            const heading = pj.heading ?? 0;
            const ta = pj.tillerAngle ?? 0;
            const desiredH = Math.atan2(dx, dy);
            const dH = angleDiff(desiredH, heading);
            const useReverse = Boolean(wp.reverse);
            const desired = new Set();
            let desiredTiller = 0;
            if (useReverse) {
              desired.add("KeyS");
              const desiredBackH = Math.atan2(-dx, -dy);
              const dHb = angleDiff(desiredBackH, heading);
              desiredTiller = clamp(dHb * 0.9, -1.1, 1.1);
            } else {
              desired.add("KeyW");
              desiredTiller = clamp(-dH * 1.15, -1.35, 1.35);
            }
            if (ta > desiredTiller + 0.08) desired.add("KeyD");
            else if (ta < desiredTiller - 0.08) desired.add("KeyA");
            setKeys(desired);
            requestAnimationFrame(step);
          } catch (_) {
            setKeys(new Set());
            done = true;
          }
        };
        requestAnimationFrame(step);
        return true;
      `);
      try {
        const pollStart = Date.now();
        while (Date.now() - pollStart < timeoutMs + 2000) {
          const st = await this.evalInPage(`return window.__e2eSteerStatus?.() || { done: true };`).catch(() => ({ done: true }));
          if (st.done) break;
          await new Promise((r) => setTimeout(r, 150));
        }
      } finally {
        await this.evalInPage(`window.__e2eSteerStop?.(); return true;`).catch(() => {});
      }
      await new Promise((r) => setTimeout(r, 250));
      return await this.waitUntil(async () => {
        const pj = await this.getPalletJack(pjGuid);
        if (!pj || !pj.pos) return null;
        return Math.hypot(pj.pos[0] - tx, pj.pos[1] - ty) <= Math.max(finalStopDist, 1.4) ? pj : null;
      }, 4000, 150, "pallet jack reach target");
    }

    for (let stepIdx = 0; stepIdx < maxSteps; stepIdx++) {
      const pj = await this.getPalletJack(pjGuid);
      if (!pj || !pj.pos) throw new Error(`movePalletJackTo: pallet jack ${pjGuid} pose unavailable`);
      const dx = tx - pj.pos[0];
      const dy = ty - pj.pos[1];
      const dist = Math.hypot(dx, dy);
      if (dist <= stopDistM) return pj;
      const step = Math.min(maxStepM, dist);
      const nx = pj.pos[0] + (dx / dist) * step;
      const ny = pj.pos[1] + (dy / dist) * step;
      const heading = Math.atan2(dx, dy);
      const cl = toCellLocal(nx, ny, pj.pos[2]);
      await this.evalInPage(`
        const sh = window.__sessionHandle;
        const surf = sh?.probeContainerSurface?.(${nx}, ${ny}, ${pj.pos[2] + 1.5});
        const nz = surf ? surf.z : (sh?.terrainHeightAt?.(${nx}, ${ny}) ?? ${pj.pos[2]});
        sh?.vehiclePalletJackAction?.(${pjGuid}, 3, 0, 0, 0, 0, ${cl.cell}, ${cl.x}, ${cl.y}, nz, ${heading}, 0);
        return true;
      `);
      await new Promise((r) => setTimeout(r, stepMs));
    }
    return await this.waitUntil(async () => {
      const pj = await this.getPalletJack(pjGuid);
      if (!pj || !pj.pos) return null;
      return Math.hypot(pj.pos[0] - tx, pj.pos[1] - ty) <= Math.max(stopDistM, 1.2) ? pj : null;
    }, 4000, 150, "pallet jack reach target");
  }

  async spawnDeployableNear(wcid, worldPos, pattern = /spawned/i) {
    const [wx, wy, wz] = worldPos;
    return await this.sendChatAndWait(
      `@deployable spawn ${wcid} ${wx.toFixed(2)} ${wy.toFixed(2)} ${wz.toFixed(2)}`,
      pattern,
      10000
    );
  }

  async cleanupWorld() {
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
    // Per-GUID fallback if @palletjack despawn expects an explicit hex GUID
    const jackGuids = await this.evalInPage(`
      return (window.__vehicles?.palletJacks?.list?.() || []).map((p) => p.guid);
    `).catch(() => []);
    if (Array.isArray(jackGuids)) {
      for (const g of jackGuids) {
        await this.sendChat(`@palletjack despawn 0x${(g >>> 0).toString(16)}`).catch(() => {});
      }
    }
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
    try { await this.browser?.close(); } catch (_) {}
    this.browser = null;
    try { this.heavyHold?.release(); } catch (_) {}
    this.heavyHold = null;
  }
}
