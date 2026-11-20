// harness/e2e_semi/common.mjs — Shared opaque-box E2E infrastructure, independent HBV1 v5/v6
// binary wire codecs, independent 30 Hz trailer kinematics oracle, dynamic capability probing,
// VehicleFakeCtx / makeSemiLiveEnv mock harness, and LiveSession EGL Chromium / ingame-driver manager.
//
// Derived strictly from PROJECT.md § Interface Contracts, implementation_plan.md, and
// docs/vehicles-2026-11-01/protocol/vehicles.protocol.xml — never imports internal code under test
// for oracle expectations.

import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import net from "node:net";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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
export const GROUND_DOCS_DIR = path.join(APP_ROOT, "docs", "vehicles-2026-11-01", "ground");
export const ACE_ROOT = process.env.ACE_SERVER_DIR || "/workspace/wb/home/ace-server";

export { createFakeWebGL2, fakeCanvas, installFakeAudio, filterErrors, acquireHeavyLock };

let cachedThree = null;
export async function getThree() {
  if (!cachedThree) {
    cachedThree = await requireThree("e2e-semi-trailer");
  }
  return cachedThree;
}

// =============================================================================
// Authoritative Requirement Constants (PROJECT.md § Interface Contracts)
// =============================================================================

export const DERICOST_Y_OFFSET = 68928.0; // 359 * 192.0
export const TWO_PI = 2.0 * Math.PI;

export const SEMI_SPEC = Object.freeze({
  profileKey: "semi-379",
  displayName: "Ironhorse 379",
  aliases: Object.freeze(["semi", "semi-379", "truck", "tractor", "379"]),
  locomotion: 2,
  vehicleClass: 3,
  standInSetup: 0x0200026b,
  wheelbase: 4.66,
  steerAxleY: 2.65,
  tandemAxleYs: Object.freeze([-1.35, -2.67]),
  tandemMidY: -2.01,
  trackWidth: 2.12,
  wheelRadius: 0.505,
  maxSteerDeg: 38,
  maxSteerRad: (38 * Math.PI) / 180,
  vMax: 27.0,
  reverseMax: -7.0,
  accel: 4.8,
  decel: 9.5,
  climbLimitCos: 0.788,
  fordDepthMax: 1.05,
  fifthWheelOffsetY: -2.01,
  fifthWheelOffsetZ: 0.96,
  overallLength: 7.0,
  maxDrawCalls: 16,
  seats: Object.freeze([
    Object.freeze([-0.52, 0.28, 1.72]),
    Object.freeze([0.52, 0.28, 1.72]),
  ]),
  steeringWheelCenter: Object.freeze([-0.52, 0.76, 1.98]),
  steeringWheelRadius: 0.24,
  exhaustTips: Object.freeze([
    Object.freeze([-1.08, -0.44, 3.72]),
    Object.freeze([1.08, -0.44, 3.72]),
  ]),
  liveries: Object.freeze([
    "crimsonRed",
    "midnightBlue",
    "forestGreen",
    "oliveDrab",
    "arcticWhite",
    "obsidianBlack",
  ]),
  chassisKingpinZ: 0.96,
  chassisDeckZ: 1.32,
  landingGearRetractDz: 0.45,
  trailers: Object.freeze({
    "20ft": Object.freeze({
      wcid: 4000030,
      deployableKind: 13,
      kpY: 2.80,
      bogieY: -1.895,
      wheelbase: 4.695,
      length: 7.40,
      containerLength: 6.058,
      deckZ: 1.32,
      kingpinZ: 0.96,
      twistlockCount: 4,
    }),
    "40ft": Object.freeze({
      wcid: 4000031,
      deployableKind: 14,
      kpY: 5.35,
      bogieY: -4.445,
      wheelbase: 9.795,
      length: 12.50,
      containerLength: 12.192,
      deckZ: 1.32,
      kingpinZ: 0.96,
      twistlockCount: 8,
      slots: Object.freeze({ front: 2.9295, rear: -2.9295, center: 0 }),
    }),
  }),
  containers: Object.freeze({
    "20ft": Object.freeze({ wcid: 4000020, deployableKind: 10, length: 6.058, height: 2.591 }),
    "40ft": Object.freeze({ wcid: 4000021, deployableKind: 11, length: 12.192, height: 2.591 }),
    "40hc": Object.freeze({ wcid: 4000022, deployableKind: 12, length: 12.192, height: 2.896, tunnelH: 0.120 }),
  }),
  maxJackknifeDeg: 72,
  maxJackknifeRad: (72 * Math.PI) / 180,
  hitchMaxDistM: 3.5,
  hitchMaxAngleDeg: 60,
  hitchMaxAngleRad: (60 * Math.PI) / 180,
  towMassMul: Object.freeze({
    bobtail: 1.0,
    emptyChassis: 0.72,
    loaded40ft: 0.58,
  }),
  camera: Object.freeze({
    chaseBack: 10.8,
    chaseUp: 3.8,
    chaseLookAhead: 12.0,
    chaseFov: 64,
    towed20Back: 17.5,
    towed40Back: 22.5,
    towed40Up: 5.6,
    cabEyes: Object.freeze([
      Object.freeze([-0.52, 0.28, 2.40]),
      Object.freeze([0.52, 0.28, 2.40]),
    ]),
    hoodEye: Object.freeze([0, 1.55, 2.18]),
  }),
});

// =============================================================================
// Assertions & Math Helpers
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

// =============================================================================
// Independent Opaque-Box HBV1 v5/v6 Binary Wire Codec
// =============================================================================

export const HBV1_TAG = 0x31564248; // "HBV1" LE u32
export const HBV1_VERSION_V6 = 6;
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
});

export const TRAILER_ACTION_KIND = Object.freeze({
  Hitch: 1,
  Unhitch: 2,
  ToggleTwistlock: 3,
  MountContainer: 4,
  UnmountContainer: 5,
});

export const TRAILER_FLAGS = Object.freeze({
  Coupled: 0x01,
  TwistlocksLocked: 0x02,
  GearRetracted: 0x04,
  BrakeLights: 0x08,
});

export function hexToBytes(hex) {
  const clean = String(hex).replace(/\s+/g, "");
  assert(clean.length % 2 === 0, `hexToBytes: odd length ${clean.length}`);
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    const b = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    assert(Number.isFinite(b), `hexToBytes: bad hex byte at ${i * 2}`);
    out[i] = b;
  }
  return out;
}

export function bytesToHex(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) {
    s += bytes[i].toString(16).padStart(2, "0");
  }
  return s;
}

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
  quat(q) {
    const w = q?.W ?? q?.w ?? 1;
    const x = q?.X ?? q?.x ?? 0;
    const y = q?.Y ?? q?.y ?? 0;
    const z = q?.Z ?? q?.z ?? 0;
    this.f32(w); this.f32(x); this.f32(y); this.f32(z);
  }
  string16L(str) {
    const s = String(str ?? "");
    // CP-1252 subset encoding (bytes 0..255 for single-byte chars)
    const raw = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) {
      const code = s.charCodeAt(i);
      raw[i] = code <= 0xff ? code : 0x3f;
    }
    if (raw.length >= 0xffff) {
      this.u16(0xffff);
      this.u32(raw.length);
      this._grow(raw.length);
      this.buf.set(raw, this.pos);
      this.pos += raw.length;
      const pad = (4 - ((6 + raw.length) % 4)) % 4;
      for (let i = 0; i < pad; i++) this.u8(0);
    } else {
      this.u16(raw.length);
      this._grow(raw.length);
      this.buf.set(raw, this.pos);
      this.pos += raw.length;
      const pad = (4 - ((2 + raw.length) % 4)) % 4;
      for (let i = 0; i < pad; i++) this.u8(0);
    }
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
      throw new Error(`truncated HBV1 buffer: need ${n}B at offset ${this.pos}, len ${this.buf.byteLength}`);
    }
  }
  u8() { this._need(1); const v = this.dv.getUint8(this.pos); this.pos += 1; return v; }
  i8() { this._need(1); const v = this.dv.getInt8(this.pos); this.pos += 1; return v; }
  u16() { this._need(2); const v = this.dv.getUint16(this.pos, true); this.pos += 2; return v; }
  i16() { this._need(2); const v = this.dv.getInt16(this.pos, true); this.pos += 2; return v; }
  u32() { this._need(4); const v = this.dv.getUint32(this.pos, true); this.pos += 4; return v; }
  f32() { this._need(4); const v = this.dv.getFloat32(this.pos, true); this.pos += 4; return v; }
  vec3() { return { X: this.f32(), Y: this.f32(), Z: this.f32() }; }
  quat() { return { W: this.f32(), X: this.f32(), Y: this.f32(), Z: this.f32() }; }
  string16L() {
    let len = this.u16();
    let headerBytes = 2;
    if (len === 0xffff) {
      len = this.u32();
      headerBytes = 6;
    }
    this._need(len);
    let out = "";
    for (let i = 0; i < len; i++) {
      out += String.fromCharCode(this.buf[this.pos + i]);
    }
    this.pos += len;
    const pad = (4 - ((headerBytes + len) % 4)) % 4;
    this._need(pad);
    this.pos += pad;
    return out;
  }
}

export function encodeHeader(w, header = {}) {
  const tag = (header.Tag ?? HBV1_TAG) >>> 0;
  const ver = (header.Version ?? HBV1_VERSION_V6) & 0xffff;
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

export function encodeVehicleProfile(fields = {}, versionOverride = null) {
  const w = new BinWriter(512);
  const version = versionOverride ?? fields.Header?.Version ?? HBV1_VERSION_V6;
  encodeHeader(w, { ...(fields.Header || {}), Version: version });
  w.u32(fields.Vehicle ?? 0);
  w.string16L(fields.ProfileKey ?? "");
  w.string16L(fields.DisplayName ?? "");
  w.u32(fields.Locomotion ?? 0);
  w.u32(fields.StandInSetup ?? 0);
  w.u16(fields.SimHz ?? 30);
  w.u16(fields.Reserved ?? 0);
  for (const k of [
    "VMin", "VCruise", "VMax", "SpeedCap", "Accel", "Decel",
    "MaxBank", "RollRate", "MaxPitch", "PitchRate", "YawRate",
    "ClimbMax", "SinkMax", "FloorAgl", "CeilingAgl", "TakeoffClimb",
    "LandingSpeed", "LeadSeconds",
  ]) {
    w.f32(fields[k] ?? 0);
  }
  w.u32(fields.ObjectRadius ?? 0);

  const seats = fields.Seats ?? [];
  w.u32(fields.SeatCount ?? seats.length);
  for (const s of seats) {
    w.u32(s.Role ?? 0);
    w.u32(s.Motion ?? 0);
    w.vec3(s.Offset ?? { X: 0, Y: 0, Z: 0 });
  }

  const weapons = fields.Weapons ?? [];
  w.u32(fields.WeaponCount ?? weapons.length);
  for (const wp of weapons) {
    w.u32(wp.Kind ?? 0);
    w.f32(wp.RoundsPerSecond ?? 0);
    w.f32(wp.Spread ?? 0);
    w.f32(wp.Range ?? 0);
    w.f32(wp.Damage ?? 0);
    w.u32(wp.Magazine ?? 0);
    w.vec3(wp.Muzzle ?? { X: 0, Y: 0, Z: 0 });
  }

  const parts = fields.Parts ?? [];
  w.u32(fields.PartCount ?? parts.length);
  for (const pt of parts) {
    w.u32(pt.Did ?? 0);
    w.vec3(pt.Offset ?? { X: 0, Y: 0, Z: 0 });
    w.quat(pt.Rotation ?? { W: 1, X: 0, Y: 0, Z: 0 });
    w.f32(pt.Scale ?? 1);
  }

  if (version >= 2) {
    const partRoles = fields.PartRoles ?? [];
    w.u32(fields.PartRoleCount ?? partRoles.length);
    for (const pr of partRoles) w.u32(pr);
    const weaponExt = fields.WeaponExt ?? [];
    w.u32(fields.WeaponExtCount ?? weaponExt.length);
    for (const wx of weaponExt) {
      w.f32(wx.MuzzleVelocity ?? 0);
      w.f32(wx.Convergence ?? 0);
      w.f32(wx.MassKg ?? 0);
      w.f32(wx.DragTerminal ?? 0);
      w.u32(wx.SpellId ?? 0);
    }
  }

  if (version >= 3) {
    w.f32(fields.Wheelbase ?? 0);
    w.f32(fields.TrackWidth ?? 0);
    w.f32(fields.WheelRadius ?? 0);
    w.f32(fields.MaxSteerRad ?? 0);
    w.f32(fields.ReverseMax ?? 0);
    w.f32(fields.ClimbLimitCos ?? 0);
    w.f32(fields.FordDepthMax ?? 0);
    w.u32(fields.CargoWcid ?? 0);
  }

  if (version >= 6) {
    w.f32(fields.FifthWheelOffsetY ?? 0);
    w.f32(fields.FifthWheelOffsetZ ?? 0);
    w.u8(fields.LiveryId ?? 0);
    w.u8(fields.VehicleClass ?? 0);
    w.u16(fields.Reserved4 ?? 0);
  }

  return w.finish();
}

export function decodeVehicleProfile(bytes) {
  const r = new BinReader(bytes);
  const Header = decodeHeader(r);
  if (!Header) return null;
  const v = Header.Version;
  const Vehicle = r.u32();
  const ProfileKey = r.string16L();
  const DisplayName = r.string16L();
  const Locomotion = r.u32();
  const StandInSetup = r.u32();
  const SimHz = r.u16();
  const Reserved = r.u16();
  const out = {
    Header,
    Vehicle,
    ProfileKey,
    DisplayName,
    Locomotion,
    StandInSetup,
    SimHz,
    Reserved,
    VMin: r.f32(),
    VCruise: r.f32(),
    VMax: r.f32(),
    SpeedCap: r.f32(),
    Accel: r.f32(),
    Decel: r.f32(),
    MaxBank: r.f32(),
    RollRate: r.f32(),
    MaxPitch: r.f32(),
    PitchRate: r.f32(),
    YawRate: r.f32(),
    ClimbMax: r.f32(),
    SinkMax: r.f32(),
    FloorAgl: r.f32(),
    CeilingAgl: r.f32(),
    TakeoffClimb: r.f32(),
    LandingSpeed: r.f32(),
    LeadSeconds: r.f32(),
    ObjectRadius: r.u32(),
  };

  const SeatCount = r.u32();
  const Seats = [];
  for (let i = 0; i < SeatCount; i++) {
    Seats.push({ Role: r.u32(), Motion: r.u32(), Offset: r.vec3() });
  }
  out.SeatCount = SeatCount;
  out.Seats = Seats;

  const WeaponCount = r.u32();
  const Weapons = [];
  for (let i = 0; i < WeaponCount; i++) {
    Weapons.push({
      Kind: r.u32(),
      RoundsPerSecond: r.f32(),
      Spread: r.f32(),
      Range: r.f32(),
      Damage: r.f32(),
      Magazine: r.u32(),
      Muzzle: r.vec3(),
    });
  }
  out.WeaponCount = WeaponCount;
  out.Weapons = Weapons;

  const PartCount = r.u32();
  const Parts = [];
  for (let i = 0; i < PartCount; i++) {
    Parts.push({ Did: r.u32(), Offset: r.vec3(), Rotation: r.quat(), Scale: r.f32() });
  }
  out.PartCount = PartCount;
  out.Parts = Parts;

  if (v >= 2) {
    out.PartRoleCount = r.u32();
    out.PartRoles = [];
    for (let i = 0; i < out.PartRoleCount; i++) out.PartRoles.push(r.u32());
    out.WeaponExtCount = r.u32();
    out.WeaponExt = [];
    for (let i = 0; i < out.WeaponExtCount; i++) {
      out.WeaponExt.push({
        MuzzleVelocity: r.f32(),
        Convergence: r.f32(),
        MassKg: r.f32(),
        DragTerminal: r.f32(),
        SpellId: r.u32(),
      });
    }
  } else {
    out.PartRoleCount = 0;
    out.PartRoles = [];
    out.WeaponExtCount = 0;
    out.WeaponExt = [];
  }

  if (v >= 3) {
    out.Wheelbase = r.f32();
    out.TrackWidth = r.f32();
    out.WheelRadius = r.f32();
    out.MaxSteerRad = r.f32();
    out.ReverseMax = r.f32();
    out.ClimbLimitCos = r.f32();
    out.FordDepthMax = r.f32();
    out.CargoWcid = r.u32();
  } else {
    out.Wheelbase = 0;
    out.TrackWidth = 0;
    out.WheelRadius = 0;
    out.MaxSteerRad = 0;
    out.ReverseMax = 0;
    out.ClimbLimitCos = 0;
    out.FordDepthMax = 0;
    out.CargoWcid = 0;
  }

  if (v >= 6) {
    out.FifthWheelOffsetY = r.f32();
    out.FifthWheelOffsetZ = r.f32();
    out.LiveryId = r.u8();
    out.VehicleClass = r.u8();
    out.Reserved4 = r.u16();
  } else {
    out.FifthWheelOffsetY = 0;
    out.FifthWheelOffsetZ = 0;
    out.LiveryId = 0;
    out.VehicleClass = 0;
    out.Reserved4 = 0;
  }

  // Forward-compat: v > 6 trailing bytes are ignored cleanly.
  out._bytesConsumed = r.pos;
  out._bytesTotal = r.buf.byteLength;
  return out;
}

export function encodeVehicleState(fields = {}, versionOverride = null) {
  const w = new BinWriter(128);
  const version = versionOverride ?? fields.Header?.Version ?? HBV1_VERSION_V6;
  encodeHeader(w, { ...(fields.Header || {}), Version: version });
  w.u32(fields.Vehicle ?? 0);
  w.u32(fields.Step ?? 0);
  w.u32(fields.AckInputSeq ?? 0);
  w.u32(fields.Cell ?? 0);
  w.vec3(fields.Position ?? { X: 0, Y: 0, Z: 0 });
  w.f32(fields.Heading ?? 0);
  w.f32(fields.Pitch ?? 0);
  w.f32(fields.Bank ?? 0);
  w.f32(fields.Speed ?? 0);
  w.f32(fields.VCap ?? 0);
  w.u16(fields.Ammo ?? 0);
  w.u8(fields.Mode ?? 0);
  w.u8(fields.Flags ?? 0);

  if (version >= 2) {
    w.u8(fields.MissileMask ?? 0);
    w.u8(fields.BombMask ?? 0);
    w.u16(fields.Reserved2 ?? 0);
  }
  if (version >= 3) {
    w.f32(fields.SteerAngle ?? 0);
    w.u8(fields.GroundFlags ?? 0);
    w.u8(fields.SurfaceFamily ?? 0);
    w.i16(fields.WheelSpinQ16 ?? 0);
  }
  if (version >= 4) {
    w.u8(fields.CargoMask ?? 0);
    w.u8(fields.PalletSize0 ?? 0);
    w.u8(fields.PalletSize1 ?? 0);
    w.u8(fields.Reserved3 ?? 0);
    w.u32(fields.CargoSlot0Wcid ?? 0);
    w.u32(fields.CargoSlot1Wcid ?? 0);
  }
  if (version >= 6) {
    w.u32(fields.HitchedTrailerGuid ?? 0);
    w.f32(fields.TrailerHeading ?? 0);
    w.f32(fields.TrailerPitch ?? 0);
    w.u8(fields.TrailerFlags ?? 0);
    w.u8(fields.Reserved4 ?? 0);
    w.u16(fields.Reserved5 ?? 0);
  }
  return w.finish();
}

export function decodeVehicleState(bytes) {
  const r = new BinReader(bytes);
  const Header = decodeHeader(r);
  if (!Header) return null;
  const v = Header.Version;
  const out = {
    Header,
    Vehicle: r.u32(),
    Step: r.u32(),
    AckInputSeq: r.u32(),
    Cell: r.u32(),
    Position: r.vec3(),
    Heading: r.f32(),
    Pitch: r.f32(),
    Bank: r.f32(),
    Speed: r.f32(),
    VCap: r.f32(),
    Ammo: r.u16(),
    Mode: r.u8(),
    Flags: r.u8(),
  };
  if (v >= 2) {
    out.MissileMask = r.u8();
    out.BombMask = r.u8();
    out.Reserved2 = r.u16();
  } else {
    out.MissileMask = 0;
    out.BombMask = 0;
    out.Reserved2 = 0;
  }
  if (v >= 3) {
    out.SteerAngle = r.f32();
    out.GroundFlags = r.u8();
    out.SurfaceFamily = r.u8();
    out.WheelSpinQ16 = r.i16();
  } else {
    out.SteerAngle = 0;
    out.GroundFlags = 0;
    out.SurfaceFamily = 0;
    out.WheelSpinQ16 = 0;
  }
  if (v >= 4) {
    out.CargoMask = r.u8();
    out.PalletSize0 = r.u8();
    out.PalletSize1 = r.u8();
    out.Reserved3 = r.u8();
    out.CargoSlot0Wcid = r.u32();
    out.CargoSlot1Wcid = r.u32();
  } else {
    out.CargoMask = 0;
    out.PalletSize0 = 0;
    out.PalletSize1 = 0;
    out.Reserved3 = 0;
    out.CargoSlot0Wcid = 0;
    out.CargoSlot1Wcid = 0;
  }
  if (v >= 6) {
    out.HitchedTrailerGuid = r.u32();
    out.TrailerHeading = r.f32();
    out.TrailerPitch = r.f32();
    out.TrailerFlags = r.u8();
    out.Reserved4 = r.u8();
    out.Reserved5 = r.u16();
  } else {
    out.HitchedTrailerGuid = 0;
    out.TrailerHeading = 0;
    out.TrailerPitch = 0;
    out.TrailerFlags = 0;
    out.Reserved4 = 0;
    out.Reserved5 = 0;
  }
  out._bytesConsumed = r.pos;
  out._bytesTotal = r.buf.byteLength;
  return out;
}

export function encodeTrailerAction(fields = {}, versionOverride = null) {
  const w = new BinWriter(24);
  const version = versionOverride ?? fields.Header?.Version ?? HBV1_VERSION_V6;
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
  if (!Header) return null;
  if (r.remaining() < 16) return null;
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
  const w = new BinWriter(60);
  const version = versionOverride ?? fields.Header?.Version ?? HBV1_VERSION_V6;
  encodeHeader(w, { ...(fields.Header || {}), Version: version });
  w.u32(fields.TrailerGuid ?? 0);
  w.u32(fields.Kind ?? DEPLOYABLE_KIND.TrailerChassis40);
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
  return w.finish();
}

export function decodeTrailerState(bytes) {
  const r = new BinReader(bytes);
  const Header = decodeHeader(r);
  if (!Header) return null;
  if (r.remaining() < 52) return null;
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

// =============================================================================
// Independent 30 Hz Fifth-Wheel Articulation & Container Pose Oracles
// =============================================================================

function readTerrainZ(terrainOracle, x, y, refZ = 0.0) {
  if (typeof terrainOracle !== "function") return NaN;
  const res = terrainOracle(x, y, refZ);
  if (typeof res === "number") return Number.isFinite(res) ? res : NaN;
  if (res && typeof res === "object" && Number.isFinite(res.z)) return res.z;
  return NaN;
}

function oracleRotate3D(h, p, b, x, y, z) {
  const cb = Math.cos(b), sb = Math.sin(b);
  const cp = Math.cos(p), sp = Math.sin(p);
  const ch = Math.cos(h), sh = Math.sin(h);
  // Ry(b) -> Rx(p) -> Rz(-h)
  const x1 = x * cb + z * sb;
  const y1 = y;
  const z1 = -x * sb + z * cb;
  const y2 = y1 * cp - z1 * sp;
  const z2 = y1 * sp + z1 * cp;
  return [
    x1 * ch + y2 * sh,
    -x1 * sh + y2 * ch,
    z2,
  ];
}

export function oracleStepCoupledTrailer(tractorState, trailerState, hitchOffsetY, spec, terrainOracle, dt = 1 / 30) {
  const ts = tractorState || {};
  const ht = Number.isFinite(ts.heading) ? ts.heading : 0.0;
  const htrPrev = Number.isFinite(trailerState?.heading) ? trailerState.heading : ht;
  const sinHt = Math.sin(ht);
  const cosHt = Math.cos(ht);
  const trPitch = Number.isFinite(ts.pitch) ? ts.pitch : 0.0;
  const kingpinZ = Number.isFinite(spec.kingpinZ) ? spec.kingpinZ : SEMI_SPEC.chassisKingpinZ;
  const fwZ = Number.isFinite(ts.fifthWheelOffsetZ) ? ts.fifthWheelOffsetZ : kingpinZ;

  // Hitch world XY
  const hx = (Number.isFinite(ts.x) ? ts.x : 0.0) + sinHt * hitchOffsetY;
  const hy = (Number.isFinite(ts.y) ? ts.y : 0.0) + cosHt * hitchOffsetY;

  // Hitch velocity (vx_h, vy_h)
  const spd = Number.isFinite(ts.speed) ? ts.speed : 0.0;
  let yawRate = 0.0;
  if (Number.isFinite(ts.yawRate)) {
    yawRate = ts.yawRate;
  } else if (Number.isFinite(ts.wheelbase) && ts.wheelbase > 0 && Number.isFinite(ts.steerAngle)) {
    const muLat = Number.isFinite(ts.muLat) ? ts.muLat : 1.0;
    yawRate = (spd * Math.tan(ts.steerAngle) / ts.wheelbase) * muLat;
  }
  const vx_h = spd * sinHt + hitchOffsetY * cosHt * yawRate;
  const vy_h = spd * cosHt - hitchOffsetY * sinHt * yawRate;

  const omegaTr = (vx_h * Math.cos(htrPrev) - vy_h * Math.sin(htrPrev)) / spec.wheelbase;
  let htrNext = wrapHeading(htrPrev + omegaTr * dt);

  // Clamp jackknife angle within ±72 deg
  const rel = wrapPi(ht - htrNext);
  const maxJk = SEMI_SPEC.maxJackknifeRad;
  if (rel > maxJk) htrNext = wrapHeading(ht - maxJk);
  else if (rel < -maxJk) htrNext = wrapHeading(ht + maxJk);

  const sinTr = Math.sin(htrNext);
  const cosTr = Math.cos(htrNext);
  const bxSample = hx - sinTr * spec.wheelbase;
  const bySample = hy - cosTr * spec.wheelbase;

  const fallbackKpZ = readTerrainZ(terrainOracle, hx, hy, 0.0);
  const tzBase = Number.isFinite(ts.z) ? ts.z : (Number.isFinite(fallbackKpZ) ? fallbackKpZ : 0.0);
  const hitchWorldZ = tzBase + hitchOffsetY * Math.sin(trPitch) + fwZ * Math.cos(trPitch);
  const kpGroundZ = hitchWorldZ - kingpinZ;
  const rawBogieZ = readTerrainZ(terrainOracle, bxSample, bySample, kpGroundZ);
  const bogieZ = Number.isFinite(rawBogieZ) ? rawBogieZ : kpGroundZ;

  const clampAngle = (v, lim) => (v < -lim ? -lim : v > lim ? lim : v);
  const pitch = clampAngle(Math.atan2(kpGroundZ - bogieZ, spec.wheelbase), Math.PI / 4);

  const halfTrack = 0.955;
  const rx = cosTr;
  const ry = -sinTr;
  const zL = readTerrainZ(terrainOracle, bxSample - rx * halfTrack, bySample - ry * halfTrack, bogieZ);
  const zR = readTerrainZ(terrainOracle, bxSample + rx * halfTrack, bySample + ry * halfTrack, bogieZ);
  const bank = (Number.isFinite(zL) && Number.isFinite(zR))
    ? clampAngle(Math.atan2(zL - zR, 2.0 * halfTrack), Math.PI / 4)
    : 0.0;

  const [kpOffX, kpOffY, kpOffZ] = oracleRotate3D(htrNext, pitch, bank, 0.0, spec.kpY, kingpinZ);
  const tx = hx - kpOffX;
  const ty = hy - kpOffY;
  const tz = hitchWorldZ - kpOffZ;

  const [bgOffX, bgOffY] = oracleRotate3D(htrNext, pitch, bank, 0.0, spec.bogieY, 0.0);
  const bx = tx + bgOffX;
  const by = ty + bgOffY;

  return {
    x: tx,
    y: ty,
    z: tz,
    heading: htrNext,
    pitch,
    bank,
    hitchX: hx,
    hitchY: hy,
    bogieX: bx,
    bogieY: by,
  };
}

export function oracleComputeMountedContainerPose(trailerPose, trailerKind, containerLength, slot = "auto") {
  const kind = trailerKind === "40ft" || trailerKind === 40 || trailerKind === 14 ? "40ft" : "20ft";
  let yOff = 0;
  if (kind === "40ft" && containerLength < 7) {
    if (slot === 1 || slot === "front") yOff = 2.9295;
    else if (slot === "center") yOff = 0;
    else yOff = -2.9295; // slot === 0, "auto", 2, or "rear"
  }
  const h = trailerPose.heading ?? 0;
  const pitch = trailerPose.pitch ?? 0;
  const bank = trailerPose.bank ?? trailerPose.roll ?? 0;
  const deckZ = SEMI_SPEC.chassisDeckZ;
  const [dx, dy, dz] = oracleRotate3D(h, pitch, bank, 0, yOff, deckZ);
  return {
    x: (trailerPose.x ?? 0) + dx,
    y: (trailerPose.y ?? 0) + dy,
    z: (trailerPose.z ?? 0) + dz,
    heading: h,
    pitch,
    bank,
    yOffsetLocal: yOff,
  };
}

// =============================================================================
// Dynamic Capability Probing & Test Execution Framework
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
  const inPath = path.join(PROTOCOL_DIR, "fixtures-input.json");
  const outPath = path.join(PROTOCOL_DIR, "vehicle-wire-fixtures.json");
  return {
    inputPath: inPath,
    outputPath: outPath,
    input: existsSync(inPath) ? JSON.parse(readFileSync(inPath, "utf8")) : null,
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

function scanCSharpCommentOrString(src, i) {
  const ch = src[i];
  const next = src[i + 1];
  if (ch === "/" && next === "/") {
    const nl = src.indexOf("\n", i + 2);
    return nl === -1 ? src.length : nl + 1;
  }
  if (ch === "/" && next === "*") {
    const end = src.indexOf("*/", i + 2);
    return end === -1 ? src.length : end + 2;
  }
  if (ch === "'") {
    i += 1;
    if (src[i] === "\\") i += 2;
    else i += 1;
    return src[i] === "'" ? i + 1 : i;
  }
  const isInterp = ch === "$" || (ch === "@" && next === "$");
  const isVerbatim = ch === "@" || (ch === "$" && next === "@");
  if (ch === '"' || ((ch === "@" || ch === "$") && (next === '"' || ((next === "@" || next === "$") && src[i + 2] === '"')))) {
    i += isInterp && isVerbatim ? 3 : isInterp || isVerbatim ? 2 : 1;
    while (i < src.length) {
      if (isInterp && src[i] === "{" && src[i + 1] === "{") { i += 2; continue; }
      if (isInterp && src[i] === "}" && src[i + 1] === "}") { i += 2; continue; }
      if (isInterp && src[i] === "{") {
        let d = 1;
        i += 1;
        while (i < src.length && d > 0) {
          if (src[i] === '"' || src[i] === "'" || (src[i] === "/" && (src[i + 1] === "/" || src[i + 1] === "*"))) {
            i = scanCSharpCommentOrString(src, i);
            continue;
          }
          if (src[i] === "{") d++;
          else if (src[i] === "}") d--;
          i++;
        }
        continue;
      }
      if (isVerbatim) {
        if (src[i] === '"' && src[i + 1] === '"') { i += 2; continue; }
        if (src[i] === '"') return i + 1;
        i++;
      } else {
        if (src[i] === "\\") { i += 2; continue; }
        if (src[i] === '"') return i + 1;
        i++;
      }
    }
    return src.length;
  }
  return -1;
}

export function stripCSharpComments(src) {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];
    if (ch === "/" && next === "/") {
      const nl = src.indexOf("\n", i + 2);
      if (nl === -1) break;
      out += "\n";
      i = nl + 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = src.indexOf("*/", i + 2);
      out += " ";
      if (end === -1) break;
      i = end + 2;
      continue;
    }
    const adv = scanCSharpCommentOrString(src, i);
    if (adv > i) {
      out += src.slice(i, adv);
      i = adv;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

export function extractCSharpMethods(src, methodName) {
  const sigRe = new RegExp(
    `(?:^|\\n)[^\\n;{}]*\\b${methodName}\\s*(?:<[^>]+>)?\\s*\\([^)]*\\)\\s*(?:where[^{;=>]+)?(?=\\{|=>)`,
    "g"
  );
  const bodies = [];
  let m;
  while ((m = sigRe.exec(src)) !== null) {
    let i = m.index + m[0].length;
    while (i < src.length && /\s/.test(src[i])) i++;
    if (src.slice(i, i + 2) === "=>") {
      i += 2;
      while (i < src.length && src[i] !== ";") {
        const adv = scanCSharpCommentOrString(src, i);
        if (adv > i) { i = adv; continue; }
        i++;
      }
      bodies.push(src.slice(m.index, i + 1));
      sigRe.lastIndex = i + 1;
    } else if (src[i] === "{") {
      let depth = 0;
      const start = m.index;
      while (i < src.length) {
        const adv = scanCSharpCommentOrString(src, i);
        if (adv > i) { i = adv; continue; }
        if (src[i] === "{") depth++;
        else if (src[i] === "}") {
          depth--;
          if (depth === 0) { i++; break; }
        }
        i++;
      }
      bodies.push(src.slice(start, i));
      sigRe.lastIndex = i;
    }
  }
  return { bodies, combined: bodies.join("\n") };
}

function stripCSharpCommentsAndStrings(src) {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const adv = scanCSharpCommentOrString(src, i);
    if (adv > i) {
      out += " ";
      i = adv;
      continue;
    }
    out += src[i];
    i++;
  }
  return out;
}

export function extractCSharpMethodScope(src, methodName, helperNameRe = null) {
  const { bodies, combined } = extractCSharpMethods(src, methodName);
  if (!combined) return { bodies: [], combined: "" };
  const extras = [];
  if (helperNameRe) {
    const callRe = /\b([A-Za-z_]\w*)\s*\(/g;
    const seen = new Set([methodName]);
    const queue = [combined];
    while (queue.length > 0) {
      const chunk = stripCSharpCommentsAndStrings(queue.shift());
      callRe.lastIndex = 0;
      let hm;
      while ((hm = callRe.exec(chunk)) !== null) {
        const fn = hm[1];
        if (!seen.has(fn) && helperNameRe.test(fn)) {
          seen.add(fn);
          const h = extractCSharpMethods(src, fn);
          if (h.combined) {
            extras.push(h.combined);
            queue.push(h.combined);
          }
        }
      }
    }
  }
  const fullText = [combined, ...extras].join("\n");
  const constRe = /\b(?:const|static\s+readonly)\s+[\w.<>?\[\]]+\s+(\w+)\s*=\s*([^;]+);/g;
  const constSrc = stripCSharpComments(src);
  let cm;
  const constExtras = [];
  while ((cm = constRe.exec(constSrc)) !== null) {
    if (new RegExp(`\\b${cm[1]}\\b`).test(fullText)) constExtras.push(cm[0]);
  }
  return { bodies, combined: [fullText, ...constExtras].join("\n") };
}

export function makeFakeControlsWin() {
  return {
    listeners: new Map(),
    document: { activeElement: null, pointerLockElement: null, body: {}, querySelector: () => null, addEventListener() {}, removeEventListener() {} },
    addEventListener(t, fn) {
      if (!this.listeners.has(t)) this.listeners.set(t, new Set());
      this.listeners.get(t).add(fn);
    },
    removeEventListener(t, fn) {
      this.listeners.get(t)?.delete(fn);
    },
    dispatchKey(code, type = "keydown") {
      const fns = this.listeners.get(type);
      if (!fns) return;
      const ev = {
        type,
        code,
        repeat: false,
        cancelable: true,
        target: this.document.body,
        stopImmediatePropagation() {},
        preventDefault() {},
      };
      for (const fn of [...fns]) fn(ev);
    },
  };
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
      const tag = entry.status;
      const suffix = entry.detail ? ` — ${entry.detail}` : "";
      console.log(`  [${tag}] T${entry.tier} ${entry.id} (${entry.feature})${suffix}`);
    }
  }

  async runCheck(id, tier, feature, testFn) {
    if (!this._matchesFilter(id, feature)) return;
    if (this.ctx.bail && this.results.some((r) => r.status === "FAIL")) return;
    const t0 = Date.now();
    try {
      await testFn(this.ctx);
      this._record({ id, tier, feature, mode: "offline", status: "PASS", durationMs: Date.now() - t0, detail: "" });
    } catch (err) {
      this._record({
        id,
        tier,
        feature,
        mode: "offline",
        status: "FAIL",
        durationMs: Date.now() - t0,
        detail: err?.message || String(err),
      });
    }
  }

  async checkFeature(id, tier, feature, requiresFn, testFn) {
    if (!this._matchesFilter(id, feature)) return;
    if (this.ctx.bail && this.results.some((r) => r.status === "FAIL")) return;
    const t0 = Date.now();
    let probe;
    try {
      probe = await requiresFn(this.ctx);
    } catch (err) {
      probe = { ok: false, reason: err?.message || String(err) };
    }
    if (!probe || probe.ok !== true) {
      const reason = probe?.reason || "capability not yet available";
      const mustFail = this.ctx.strict || this.ctx.mode === "live";
      this._record({
        id,
        tier,
        feature,
        mode: this.ctx.mode,
        status: mustFail ? "FAIL" : "PENDING",
        durationMs: Date.now() - t0,
        detail: mustFail ? `Required capability missing in strict/live mode: ${reason}` : reason,
      });
      return;
    }
    try {
      await testFn(probe, this.ctx);
      this._record({ id, tier, feature, mode: this.ctx.mode, status: "PASS", durationMs: Date.now() - t0, detail: "" });
    } catch (err) {
      this._record({
        id,
        tier,
        feature,
        mode: this.ctx.mode,
        status: "FAIL",
        durationMs: Date.now() - t0,
        detail: err?.message || String(err),
      });
    }
  }

  async checkLive(id, tier, feature, testFn) {
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
        durationMs: Date.now() - t0,
        detail: mustFail
          ? "Live-only scenario requires --mode live under --strict"
          : "Requires --mode live (ACE + wsbridge + serve.py + EGL Chromium)",
      });
      return;
    }
    if (!this.ctx.liveSession) {
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
      await testFn(this.ctx.liveSession, this.ctx);
      this._record({ id, tier, feature, mode: "live", status: "PASS", durationMs: Date.now() - t0, detail: "" });
    } catch (err) {
      this._record({
        id,
        tier,
        feature,
        mode: "live",
        status: "FAIL",
        durationMs: Date.now() - t0,
        detail: err?.message || String(err),
      });
    }
  }
}

// =============================================================================
// Headless Vehicle Integration Mock Environment (makeSemiLiveEnv)
// =============================================================================

export async function makeSemiLiveEnv({
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
  const mkNode = (tag) => {
    let txt = "";
    let cls = "";
    let id = "";
    const listeners = new Map();
    const n = {
      tag,
      children: [],
      attrs: {},
      style: new Proxy({}, { set(t, p, v) { t[p] = v; return true; } }),
      get id() { return id; },
      set id(v) { id = v; if (v) byId.set(v, n); },
      get className() { return cls; },
      set className(v) { cls = v; },
      get textContent() { return txt; },
      set textContent(v) { txt = String(v); },
      setAttribute(k, v) { this.attrs[k] = String(v); },
      appendChild(child) { this.children.push(child); if (child.id) byId.set(child.id, child); return child; },
      remove() { if (id) byId.delete(id); },
      addEventListener(evt, fn) { listeners.set(evt, fn); },
      removeEventListener(evt) { listeners.delete(evt); },
    };
    return n;
  };
  const docListeners = new Map();
  const canvas = { tagName: "CANVAS", requestPointerLock() {} };
  const doc = {
    head: mkNode("head"),
    body: mkNode("body"),
    activeElement: null,
    pointerLockElement: null,
    getElementById: (id) => byId.get(id) ?? null,
    createElement: (tag) => mkNode(tag),
    querySelector: (sel) => (sel === "canvas" ? canvas : null),
    addEventListener(t, fn) { docListeners.set(t, fn); },
    removeEventListener(t) { docListeners.delete(t); },
  };

  const winListeners = new Map();
  let localGuidVal = localGuid;
  const fakeWinObj = {
    location: { search: "?vehicles=on" },
    document: doc,
    navigator: { getGamepads: () => [] },
    innerWidth: 1280,
    innerHeight: 720,
    getLocalPlayerGuid: () => localGuidVal,
    setLocalGuid: (g) => { localGuidVal = g; },
    addEventListener(t, fn) {
      if (!winListeners.has(t)) winListeners.set(t, new Set());
      winListeners.get(t).add(fn);
    },
    removeEventListener(t, fn) { winListeners.get(t)?.delete(fn); },
    dispatch(type, props = {}) {
      const fns = winListeners.get(type);
      if (fns) {
        const ev = {
          type,
          repeat: false,
          cancelable: true,
          target: canvas,
          stopImmediatePropagation() {},
          preventDefault() {},
          ...props,
        };
        for (const fn of [...fns]) fn(ev);
      }
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
    upsertContainerCollider: [],
    removeContainerCollider: [],
    sendChat: [],
  };

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
    audioManager: {
      getEffectBus: () => ({ ctx: fakeCtx, node: masterBusNode, sliderGain: () => 1.0 }),
      isActive: () => true,
      notifyUserGesture() {},
    },
    entityManager: {
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
      vehicleTrailerAction(tGuid, vGuid, cGuid, action, slot) {
        calls.vehicleTrailerAction.push({ tGuid, vGuid, cGuid, action, slot });
      },
      upsertContainerCollider(guid, cell, x, y, z, heading, w, l, h, isOpen) {
        calls.upsertContainerCollider.push({ guid, cell, x, y, z, heading, w, l, h, isOpen });
      },
      removeContainerCollider(guid) { calls.removeContainerCollider.push(guid); },
      sendChat(msg) { calls.sendChat.push(msg); },
    },
  };

  const api = idxMod.installVehicles({ liveScene3d: live, THREE, window: fakeWinObj });

  return {
    THREE,
    doc,
    byId,
    fakeWinObj,
    worldRoot,
    entityMap,
    mkEnt,
    inbox,
    calls,
    live,
    api,
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
  try {
    return req("playwright-core");
  } catch (_) {}
  try {
    return req("playwright");
  } catch (_) {}
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
  return undefined; // let Playwright pick default if installed
}

function parsePngDimensionsAndEntropy(buf) {
  if (buf.length < 33) return { valid: false, reason: "PNG too small (<33B)" };
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i++) {
    if (buf[i] !== sig[i]) return { valid: false, reason: "Invalid PNG magic header" };
  }
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  const distinct = new Set();
  let hasIhdr = false;
  let hasIdat = false;
  let idatBytes = 0;
  let offset = 8;
  while (offset + 12 <= buf.length) {
    const len = buf.readUInt32BE(offset);
    const type = buf.toString("ascii", offset + 4, offset + 8);
    const dataStart = offset + 8;
    if (dataStart + len + 4 > buf.length) break;
    if (offset === 8 && type === "IHDR") hasIhdr = true;
    if (type === "IDAT") {
      hasIdat = true;
      idatBytes += len;
      if (distinct.size < 32) {
        const end = Math.min(dataStart + len, dataStart + 16384);
        for (let i = dataStart; i < end; i++) {
          distinct.add(buf[i]);
          if (distinct.size >= 32) break;
        }
      }
    }
    if (type === "IEND") break;
    offset = dataStart + len + 4;
  }
  return {
    valid: hasIhdr && hasIdat && width >= 320 && height >= 240 && distinct.size >= 16,
    width,
    height,
    idatBytes,
    distinctBytes: distinct.size,
  };
}

export class LiveSession {
  constructor({ driverUrl = null, pageUrl = null, outDir = "/tmp/e2e-semi-live" } = {}) {
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
      // Attach mode to ingame-driver.mjs (:8799)
      const res = await fetch(`${this.driverUrl}/chat`).catch((e) => {
        throw new Error(`DRIVER_UNREACHABLE: ${this.driverUrl} (${e.message})`);
      });
      if (!res.ok) throw new Error(`DRIVER_UNREACHABLE: ${this.driverUrl} returned ${res.status}`);
      // Install in-page error & console.error capture if not already installed
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

    // Verify serve.py (:8765) and wsbridge (:8080) reachability loudly
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

    this.heavyHold = await acquireHeavyLock({ label: "e2e-semi-trailer-live" });
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
      while (Date.now() - vt0 < 15000) {
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
        throw new Error(`LIVE_VEHICLES_TIMEOUT: window.__vehicles.status().caps (0x03) unavailable after 15000ms (granted=${lastStatus?.caps?.granted ?? "none"})`);
      }
    }
    await this.ensureOutdoorFlatSite();
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
        // Scrollback cap (200 lines) may evict head elements: anchor on trailing lines of `before`
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
    await this.sendChatAndWait("@palletjack despawn all", /despawned/i, 3000).catch(() => {});
    await this.waitUntil(() => this.evalInPage(`
      const a = window.__vehicles;
      if (!a) return true;
      return a.vehicles().length === 0 &&
        a.trailers.list().length === 0 &&
        a.containers.list().length === 0;
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
