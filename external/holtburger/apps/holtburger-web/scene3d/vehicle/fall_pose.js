// scene3d/vehicle/fall_pose.js — the bailed-out body's pose: retail Falling, a calmer canopy variant, a parachute pack
// (vehicles DESIGN.md decisions 54-61, §4.8). `?vehicleFallAnim` DEFAULT ON (`=off` / `0` / `false` / `no` escape).
//
// Owner, 2026-11-01: "when the guy jumps out of the balloon he should be in the falling or jumping animation (they are
// the same), although there can be a variation of that, a bit calmer and grabbing onto the parachute pack (which doesnt
// exist), it needs gender and starting race considerations (mild because its just a parachute pack on their back)".
//
// What a falling body does (the local faller AND observed players on this capable client):
//   * FREE FALL (Bail event): the retail airborne motion, MotionCommand Falling 0x40000015, through the rig's own
//     MotionTable (`setMotion`). Retail applies it to any body off the ground — CMotionInterp::apply_interpreted_movement
//     (acclient.c:344193) calls DoInterpretedMotion(0x40000015) when contact_allows_move (:343882) says no; jump and
//     fall share it. Every humanoid MotionTable (0x09000001 human / Penumbraen / Undead, 0x090001FF Umbraen,
//     0x0900020E/0C Gear Knight, 0x09000214/13 Tumerok, 0x09000216 Lugian, 0x0900020B/0A Empyrean) maps NonCombat
//     Falling to the loop 0x030004A9 behind the Ready->Falling link 0x030004AA (Empyreans prepend their hover link
//     0x03000C34); Olthoi tables map it to their own idle (DAT-verified: docs/vehicles-2026-11-01/fall-pose/).
//   * UNDER THE CANOPY (Chute event): a calmer variant built from those retail frames the way the drone builds its
//     gesture clips (scene3d/drone/gestures.js buildClip + the entities.js playLocalClip seam): the Falling loop with
//     its flutter damped toward the loop's mean pose and played at half speed, and the arm chains swung at the shoulder
//     and the elbow (two-bone, minimal rotation; every part keeps its retail orientation otherwise) so the wrists grip
//     the risers beside the head — the pack's straps running up to the canopy. A 0.47 s lead-in carries the arms
//     from the free-fall spread to the grip. Retail has no equivalent; only capable clients draw it.
//   * A PARACHUTE PACK (client-drawn; no DAT model exists) on the back from the bail until touchdown: parented to the
//     chest part (9) at the torso's back surface, sized and placed per Setup = per heritage x gender from the retail
//     DATs (CharGen 0x0E000002 scale + the torso / head GfxObjs, PACK_PROFILES below); the rig's root scale (the
//     CharGen Scale: Lugian 1.3 / 1.2, Gear Knight 1.2 / 1.1, Empyrean 1.2 / 1.15, Tumerok 1.1 / 1.0) scales it with
//     the body. It flattens when the canopy opens (it "empties into the canopy").
//   * TOUCHDOWN (or a teleport / seat / dispose): the canopy clip off the playhead, Ready (the MotionTable's
//     Falling->Ready landing link 0x030004A6), the pack removed — never on a death-held rig (drone DV-13).
// A held-motion watchdog (the drone's `watch`: at most once a second, a still-committing bake gets 2.5 s) keeps Falling
// on the rig in free fall, and the canopy clip stays on the playhead (re-played before its end, or after a cut);
// observed bodies end by themselves when their rig reaches the ground or stops descending (the Touchdown event only
// reaches sessions that still track the derelict vehicle), and a chute is inferred from the sink rate when the Chute
// event never arrives.
//
// Two halves (like drone/gestures.js): the pure half (no THREE / DOM / wasm; node tests in
// tests/vehicle_fall_pose.test.mjs) and `createFallPose(deps)`, the page driver (THREE, the EntityManager and the
// wasm are injected).

import { buildClip, loadAnim, readHoldingLocations, rigProfile } from "../drone/gestures.js";
import { FALL } from "./fall_model.js";

// ---------------------------------------------------------------------------
// Pure half
// ---------------------------------------------------------------------------

/** Motion commands (full 32-bit; ACE.Entity/Enum/MotionCommand.cs) and the stance the fall runs in. */
export const FALL_MOTION = Object.freeze({ FALLING: 0x40000015, READY: 0x41000003, NONCOMBAT: 0x8000003d });

/** Retail Animation DIDs behind NonCombat Falling in every humanoid MotionTable (fall-pose-fixtures.json). */
export const FALL_ANIMS = Object.freeze({ LOOP: 0x030004a9, READY_TO_FALLING: 0x030004aa, FALLING_TO_READY: 0x030004a6 });

/**
 * The 34-part humanoid rig every humanoid heritage shares (same default placement and animation frames; only the
 * part GfxObjs differ): chest 9 (parent of the arms and the head), head 16; arm chains upper / fore / hand with the
 * clothing overlay parts that ride the upper arms (27 -> 10, 28 -> 13: the Setup parent table). `upperLen` = the upper
 * arm's reach below the shoulder origin (GfxObj 0x01000055 local -z), `elbowUp` = the forearm's reach above its origin
 * (0x01000056 local +z): the elbow joint is the mean of the two ends. `chestRestQuat` = Setup 0x02000001's default
 * placement of part 9 (w-first) — the same in every humanoid Setup.
 */
export const HUMANOID_FALL_RIG = Object.freeze({
  parts: 34,
  chest: 9,
  head: 16,
  arms: Object.freeze([
    Object.freeze({ side: -1, upper: 10, fore: 11, hand: 12, overlays: Object.freeze([27]) }),
    Object.freeze({ side: 1, upper: 13, fore: 14, hand: 15, overlays: Object.freeze([28]) }),
  ]),
  upperLen: 0.325,
  elbowUp: 0.141,
  handGrip: 0.065,
  chestRestQuat: Object.freeze([-4.36333e-8, 2.6114e-9, 0.0597419, -0.998214]),
});

const HUMAN_LABEL = "Aluvian / Gharu'ndim / Sho / Viamontian";
// Torso (part 9) GfxObj measurements, part-local metres (+y = the back, +z = up): backY = the back surface over the
// pack's band, frontY = the chest front, top / bottom = the torso's z extent, halfW = the half width at chest height.
const T_HUMAN_M = Object.freeze({ backY: 0.115, frontY: -0.165788, top: 0.355, bottom: -0.11411, halfW: 0.213789 });
const T_HUMAN_F = Object.freeze({ backY: 0.101766, frontY: -0.183335, top: 0.374422, bottom: -0.0597636, halfW: 0.204888 });
const T_GEAR = Object.freeze({ backY: 0.26798, frontY: -0.198757, top: 0.492831, bottom: -0.15065, halfW: 0.235156 });
const T_TUMEROK_M = Object.freeze({ backY: 0.113959, frontY: -0.177246, top: 0.381052, bottom: -0.115311, halfW: 0.268693 });
const T_TUMEROK_F = Object.freeze({ backY: 0.120226, frontY: -0.193215, top: 0.381052, bottom: -0.115311, halfW: 0.268693 });
const T_LUGIAN_M = Object.freeze({ backY: 0.150577, frontY: -0.18357, top: 0.422974, bottom: -0.148082, halfW: 0.29704 });
const T_LUGIAN_F = Object.freeze({ backY: 0.155577, frontY: -0.19357, top: 0.422974, bottom: -0.148082, halfW: 0.29704 });
const T_UNDEAD = Object.freeze({ backY: 0.111691, frontY: -0.14566, top: 0.379412, bottom: -0.0785609, halfW: 0.184535 });

function humanoidRow(heritage, sex, scale, motionTable, torso, headHalfW) {
  return Object.freeze({ kind: "humanoid", heritage, sex, scale, motionTable, torso, headHalfW });
}
function noHandsRow(heritage, scale, motionTable, part, pos, quat) {
  return Object.freeze({
    kind: "no-hands", heritage, sex: "Male / Female", scale, motionTable,
    anchor: Object.freeze({ part, pos: Object.freeze(pos), quat: Object.freeze(quat) }),
  });
}

/**
 * The parachute pack's fit per Setup (= heritage x gender), from the retail DATs (generated by
 * docs/vehicles-2026-11-01/fall-pose/gen_fixtures.py; tests/vehicle_fall_pose.test.mjs pins this table to the
 * fixture). `scale` = CharGen 0x0E000002 Scale percent (the rig's root scale: ACE PlayerFactory sets DefaultScale =
 * Scale / 100); `torso` / `headHalfW` = the torso / head GfxObjs (humanoids); `anchor` = the part-local pack placement
 * on the two Olthoi rigs (no hands: no straps, no canopy clip). Keys: "0x" + 8 upper-case hex (the drone's tables).
 */
export const PACK_PROFILES = Object.freeze({
  "0x02000001": humanoidRow(HUMAN_LABEL, "Male", 100, "0x09000001", T_HUMAN_M, 0.0910624),
  "0x0200004E": humanoidRow(HUMAN_LABEL, "Female", 100, "0x09000001", T_HUMAN_F, 0.0910624),
  "0x0200196F": humanoidRow("Umbraen", "Male", 100, "0x090001FF", T_HUMAN_M, 0.0905215),
  "0x02001970": humanoidRow("Umbraen", "Female", 100, "0x090001FF", T_HUMAN_F, 0.0905215),
  "0x02001907": humanoidRow("Gear", "Male", 120, "0x0900020E", T_GEAR, 0.02502),
  "0x020019ED": humanoidRow("Gear", "Female", 110, "0x0900020C", T_GEAR, 0.02502),
  "0x02001A1A": humanoidRow("Tumerok", "Male", 110, "0x09000214", T_TUMEROK_M, 0.190458),
  "0x02001A14": humanoidRow("Tumerok", "Female", 100, "0x09000213", T_TUMEROK_F, 0.13178),
  "0x02001A18": humanoidRow("Lugian", "Male", 130, "0x09000216", T_LUGIAN_M, 0.114395),
  "0x02001A12": humanoidRow("Lugian", "Female", 120, "0x0900020E", T_LUGIAN_F, 0.114395),
  "0x02001A16": humanoidRow("Empyrean", "Male", 120, "0x0900020B", T_HUMAN_M, 0.0910624),
  "0x02001A10": humanoidRow("Empyrean", "Female", 115, "0x0900020A", T_HUMAN_F, 0.0910624),
  "0x0200196E": humanoidRow("Penumbraen", "Male", 100, "0x09000001", T_HUMAN_M, 0.0905215),
  "0x0200196D": humanoidRow("Penumbraen", "Female", 100, "0x09000001", T_HUMAN_F, 0.0905215),
  "0x02001A0E": humanoidRow("Undead", "Male", 100, "0x09000001", T_UNDEAD, 0.0900425),
  "0x02001A0C": humanoidRow("Undead", "Female", 100, "0x09000001", T_UNDEAD, 0.0900425),
  "0x02001A21": noHandsRow("Olthoi", 90, "0x09000206", 0, [0.0123491, 0.55208, -0.0245], [-0.999914, 0, 0, 0.01309]),
  "0x02001A20": noHandsRow("OlthoiAcid", 60, "0x09000205", 8, [-0.546965, -5.25882e-8, 1.00506],
    [-0.502611, -0.497375, -0.497375, -0.502611]),
});

/** An unknown humanoid rig (a 34-part Setup not in the table) takes the human male fit. */
export const HUMAN_FALLBACK_SETUP = "0x02000001";

/** Pack sizing rules (metres before the rig's root scale) and colours (sRGB hex). */
export const PACK = Object.freeze({
  widthOfTorso: 0.8, minW: 0.3, maxW: 0.46,
  heightOfTorso: 0.8, minH: 0.34, maxH: 0.5,
  depth: 0.15, depthPerHalfW: 0.1, minD: 0.14, maxD: 0.18,
  gap: 0.012, // off the back surface (clothing / armour sits a little proud of the base GfxObj)
  centreAt: 0.55, // of the torso height, from its bottom
  strapW: 0.045, strapT: 0.012, strapInset: 0.07,
  flatDepth: 0.4, flatHeight: 0.85, flatSec: 0.35,
  noHandsDims: Object.freeze({ w: 0.42, h: 0.4, d: 0.17 }),
  colors: Object.freeze({ body: 0x5b6236, flap: 0x474d2c, strap: 0x3a3826, buckle: 0x8a8462 }),
});

/** The canopy variant's knobs: wrist grip from the shoulder joint (object axes at the chest's rest orientation, x
 * mirrored per side: `out` away from the body, `fwd` forward, `up`), the elbow pole, the flutter damping, the slow-down
 * factor, the lead-in length and the loop clip's cycle count (re-played before it ends). */
export const CANOPY_POSE = Object.freeze({
  grip: Object.freeze({ out: 0.03, fwd: 0.08, up: 0.15 }),
  pole: Object.freeze([0.6, 0.5, -0.8]), // elbows out, forward and down (calm), not the goalpost of a raised arm
  headClear: 0.0910624, // the human head's half width (GfxObj 0x0100005A): wider heads (Tumerok, Lugian) spread the grip
  calm: 0.6,
  slow: 2,
  leadIn: 14,
  cycles: 6,
  fps: 30,
});

/** The local fall twin's last-resort bound (index.js): the real ends are Touchdown, a teleport, the seat, dispose. */
export const FALL_BOUND = Object.freeze({ minSec: 300, maxSec: 3600, marginM: 500, slackSec: 120 });

export const PHASE = Object.freeze({ IDLE: "idle", FREEFALL: "freefall", CANOPY: "canopy" });

/**
 * `?vehicleFallAnim` — DEFAULT ON; `off` / `0` / `false` / `no` (trimmed, any case) disable the fall pose, the canopy
 * clip and the pack (the body then keeps the old pose: Ready). Never throws.
 */
export function fallAnimEnabled(search) {
  try {
    const v = (new URLSearchParams(search || "").get("vehicleFallAnim") ?? "").trim().toLowerCase();
    return !(v === "off" || v === "0" || v === "false" || v === "no");
  } catch (_) {
    return true;
  }
}

/** "0x" + 8 upper-case hex (the drone's Setup key format). */
export function setupKey(id) {
  return `0x${((Number(id) || 0) >>> 0).toString(16).toUpperCase().padStart(8, "0")}`;
}

/**
 * The pack fit for a rig. A table hit wins when its kind matches the rig (a humanoid row needs the 34-part rig);
 * an unknown humanoid (34 parts, or `humanoid === true` from the drone's rigProfile) takes the human male fit; any
 * other rig gets no pack. Never throws.
 * @param {{setupId?: number, partCount?: number, humanoid?: boolean}} [rig]
 * @returns {{key: string, source: 'table'|'fallback-human'|'none', kind: 'humanoid'|'no-hands'|'none',
 *   profile: object|null}}
 */
export function resolvePackProfile(rig = {}) {
  const r = rig && typeof rig === "object" ? rig : {};
  const key = setupKey(r.setupId);
  const parts = Number.isFinite(r.partCount) ? r.partCount : 0;
  const hit = Object.prototype.hasOwnProperty.call(PACK_PROFILES, key) ? PACK_PROFILES[key] : null;
  if (hit && hit.kind === "humanoid" && parts === HUMANOID_FALL_RIG.parts) return { key, source: "table", kind: "humanoid", profile: hit };
  if (hit && hit.kind === "no-hands" && parts > hit.anchor.part) return { key, source: "table", kind: "no-hands", profile: hit };
  if (parts === HUMANOID_FALL_RIG.parts && r.humanoid !== false) {
    return { key, source: "fallback-human", kind: "humanoid", profile: PACK_PROFILES[HUMAN_FALLBACK_SETUP] };
  }
  return { key, source: "none", kind: "none", profile: null };
}

const clampN = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/**
 * Where the pack sits and how big it is, in the anchor part's local frame (metres before the root scale). The pack
 * root is the centre of the pack's FRONT face (against the body); the pack extends along its +y (away from the body),
 * +z is its top. Humanoid: chest part 9, front face `gap` off the torso's back surface, centred at 55 % of the torso
 * height (kept below the shoulders), width / height / depth from the torso (clamped: the differences stay mild); two
 * shoulder straps (polylines in pack coordinates) over the shoulders to the chest front. No-hands (Olthoi): the
 * table's anchor, a fixed size, no straps.
 * @returns {{kind: string, part: number, pos: number[], quat: number[], dims: {w:number,h:number,d:number},
 *   straps: number[][][]|null}|null}
 */
export function packPlacement(resolved) {
  const p = resolved && resolved.profile;
  if (!p) return null;
  if (p.kind === "no-hands") {
    return { kind: "no-hands", part: p.anchor.part, pos: p.anchor.pos.slice(), quat: p.anchor.quat.slice(), dims: { ...PACK.noHandsDims }, straps: null };
  }
  const t = p.torso;
  const w = clampN(PACK.widthOfTorso * 2 * t.halfW, PACK.minW, PACK.maxW);
  const h = clampN(PACK.heightOfTorso * (t.top - t.bottom), PACK.minH, PACK.maxH);
  const d = clampN(PACK.depth + PACK.depthPerHalfW * (t.halfW - T_HUMAN_M.halfW), PACK.minD, PACK.maxD);
  const y0 = t.backY + PACK.gap;
  const zc = Math.min(t.bottom + PACK.centreAt * (t.top - t.bottom), t.top - 0.02 - h / 2);
  // straps, pack coordinates: from the pack's top front over the shoulder down the chest front
  const sx = w / 2 - PACK.strapInset;
  const yFront = t.frontY - PACK.strapT - y0;
  const yMid = (t.frontY + t.backY) / 2 - y0;
  const zTop = t.top + PACK.strapT - zc;
  const strap = (x) => [
    [x, 0.004, h / 2 - 0.03],
    [x, yMid * 0.35, zTop],
    [x, yMid, zTop + 0.004],
    [x, yFront, t.top - 0.1 - zc],
    [x, yFront, -0.03],
  ];
  return { kind: "humanoid", part: HUMANOID_FALL_RIG.chest, pos: [0, y0, zc], quat: [1, 0, 0, 0], dims: { w, h, d }, straps: [strap(-sx), strap(sx)] };
}

function hexRgb(h) {
  return [((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255];
}

/**
 * Pack geometry (non-indexed triangles + per-vertex colours, pack coordinates): `body` = a chamfered box (front face
 * at y = 0) with its top flap — the part that flattens when the canopy opens —, `straps` = the two shoulder straps
 * (thin boxes along each polyline) or null. Pure (plain Float32Arrays).
 * @returns {{body: {positions: Float32Array, colors: Float32Array}, straps: {positions: Float32Array,
 *   colors: Float32Array}|null}}
 */
export function packGeometry(placement) {
  const { w, h, d } = placement.dims;
  const body = { pos: [], col: [] };
  const tri = (out, k, a, b, c) => { for (const v of [a, b, c]) { out.pos.push(v[0], v[1], v[2]); out.col.push(k[0], k[1], k[2]); } };
  const quad = (out, k, a, b, c, dd) => { tri(out, k, a, b, c); tri(out, k, a, c, dd); };
  const kb = hexRgb(PACK.colors.body), kf = hexRgb(PACK.colors.flap), ks = hexRgb(PACK.colors.strap);
  // body: a prism over the chamfered cross-section (x, y), from z = -h/2 to h/2
  const c = Math.min(0.035, d / 3);
  const sec = [[-w / 2, 0], [w / 2, 0], [w / 2, d - c], [w / 2 - c, d], [-w / 2 + c, d], [-w / 2, d - c]];
  const z0 = -h / 2, z1 = h / 2;
  for (let i = 0; i < sec.length; i++) {
    const a = sec[i], b = sec[(i + 1) % sec.length];
    quad(body, kb, [a[0], a[1], z0], [b[0], b[1], z0], [b[0], b[1], z1], [a[0], a[1], z1]);
  }
  for (const [z, flip] of [[z1, false], [z0, true]]) {
    for (let i = 1; i + 1 < sec.length; i++) {
      const a = [sec[0][0], sec[0][1], z], b = [sec[i][0], sec[i][1], z], e = [sec[i + 1][0], sec[i + 1][1], z];
      if (flip) tri(body, kb, a, e, b); else tri(body, kb, a, b, e);
    }
  }
  // the top flap: a thin slab over the upper back of the pack
  const fx = w / 2 - 0.03, fy0 = d - 0.002, fy1 = d + 0.02, fz0 = h / 2 - 0.17, fz1 = h / 2 - 0.01;
  boxInto(body, kf, [-fx, fy0, fz0], [fx, fy1, fz1], quad);
  // straps
  let straps = null;
  if (Array.isArray(placement.straps) && placement.straps.length) {
    const s = { pos: [], col: [] };
    for (const line of placement.straps) {
      for (let i = 0; i + 1 < line.length; i++) ribbonInto(s, ks, line[i], line[i + 1], PACK.strapW, PACK.strapT, quad);
    }
    straps = { positions: new Float32Array(s.pos), colors: new Float32Array(s.col) };
  }
  return { body: { positions: new Float32Array(body.pos), colors: new Float32Array(body.col) }, straps };
}

function boxInto(out, k, lo, hi, quad) {
  const [x0, y0, z0] = lo, [x1, y1, z1] = hi;
  const v = (x, y, z) => [x, y, z];
  quad(out, k, v(x0, y0, z0), v(x1, y0, z0), v(x1, y0, z1), v(x0, y0, z1)); // -y
  quad(out, k, v(x1, y1, z0), v(x0, y1, z0), v(x0, y1, z1), v(x1, y1, z1)); // +y
  quad(out, k, v(x0, y1, z0), v(x0, y0, z0), v(x0, y0, z1), v(x0, y1, z1)); // -x
  quad(out, k, v(x1, y0, z0), v(x1, y1, z0), v(x1, y1, z1), v(x1, y0, z1)); // +x
  quad(out, k, v(x0, y0, z1), v(x1, y0, z1), v(x1, y1, z1), v(x0, y1, z1)); // +z
  quad(out, k, v(x0, y1, z0), v(x1, y1, z0), v(x1, y0, z0), v(x0, y0, z0)); // -z
}

// a strap segment: a thin box from a to b, `wd` wide along x and `th` thick along the segment's normal in (y, z)
function ribbonInto(out, k, a, b, wd, th, quad) {
  const dy = b[1] - a[1], dz = b[2] - a[2];
  const L = Math.hypot(dy, dz) || 1;
  const ny = -dz / L, nz = dy / L; // the segment's normal in the y-z plane
  const hw = wd / 2, ht = th / 2;
  const P = (p, sx, sn) => [p[0] + sx * hw, p[1] + sn * ht * ny, p[2] + sn * ht * nz];
  const a00 = P(a, -1, -1), a10 = P(a, 1, -1), a11 = P(a, 1, 1), a01 = P(a, -1, 1);
  const b00 = P(b, -1, -1), b10 = P(b, 1, -1), b11 = P(b, 1, 1), b01 = P(b, -1, 1);
  quad(out, k, a00, a10, b10, b00);
  quad(out, k, a01, b01, b11, a11);
  quad(out, k, a00, b00, b01, a01);
  quad(out, k, a10, a11, b11, b10);
}

// ---- quaternion / vector helpers (w-first [w, x, y, z]; AC object space) ----
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mulS = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm3 = (a) => { const l = len(a); return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 1]; };
const lerp3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
function qmul(a, b) {
  return [
    a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
    a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
    a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
    a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
  ];
}
const qconj = (q) => [q[0], -q[1], -q[2], -q[3]];
function qnorm(q) {
  const n = Math.hypot(q[0], q[1], q[2], q[3]);
  return n > 1e-12 ? [q[0] / n, q[1] / n, q[2] / n, q[3] / n] : [1, 0, 0, 0];
}
function qrot(q, v) {
  const [w, x, y, z] = q;
  const tx = 2 * (y * v[2] - z * v[1]), ty = 2 * (z * v[0] - x * v[2]), tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)];
}
function qslerp(a, b, t) {
  let c = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  let bb = b;
  if (c < 0) { c = -c; bb = [-b[0], -b[1], -b[2], -b[3]]; }
  if (c > 0.9995) return qnorm([a[0] + (bb[0] - a[0]) * t, a[1] + (bb[1] - a[1]) * t, a[2] + (bb[2] - a[2]) * t, a[3] + (bb[3] - a[3]) * t]);
  const th = Math.acos(Math.min(1, c)), s = Math.sin(th);
  const k0 = Math.sin((1 - t) * th) / s, k1 = Math.sin(t * th) / s;
  return [a[0] * k0 + bb[0] * k1, a[1] * k0 + bb[1] * k1, a[2] * k0 + bb[2] * k1, a[3] * k0 + bb[3] * k1];
}
/** The minimal-arc rotation taking unit vector u onto unit vector v. */
function qFromTo(u, v) {
  const d = dot(u, v);
  if (d > 1 - 1e-12) return [1, 0, 0, 0];
  if (d < -1 + 1e-9) {
    let ax = cross([1, 0, 0], u);
    if (len(ax) < 1e-6) ax = cross([0, 1, 0], u);
    ax = norm3(ax);
    return [0, ax[0], ax[1], ax[2]];
  }
  const c = cross(u, v);
  return qnorm([1 + d, c[0], c[1], c[2]]);
}

/**
 * Two-bone solve: shoulder J0, elbow J1, wrist J2 (lengths from the current pose), wrist target T (clamped into
 * reach), elbow pole direction. Returns the elbow position and the reachable target.
 */
export function solveTwoBone(J0, J1, J2, T, pole) {
  const u = len(sub(J1, J0)), f = len(sub(J2, J1));
  const dv = sub(T, J0);
  const d = len(dv);
  const dh = d > 1e-9 ? mulS(dv, 1 / d) : [0, 0, 1];
  const dc = clampN(d, Math.abs(u - f) + 1e-4, u + f - 1e-4);
  const a = (u * u - f * f + dc * dc) / (2 * dc);
  const hh = Math.sqrt(Math.max(0, u * u - a * a));
  let pp = sub(pole, mulS(dh, dot(pole, dh)));
  if (len(pp) < 1e-9) pp = cross(dh, Math.abs(dh[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]);
  pp = norm3(pp);
  return { elbow: add(J0, add(mulS(dh, a), mulS(pp, hh))), target: add(J0, mulS(dh, dc)), upper: u, fore: f, reachable: d <= u + f - 1e-4 };
}

// frames: [{p:[3], q:[4]}] per part
function readFrames(anim) {
  const nf = anim.numFrames, np = anim.numParts, src = anim.frames;
  const out = [];
  for (let f = 0; f < nf; f++) {
    const fr = [];
    for (let i = 0; i < np; i++) {
      const b = (f * np + i) * 7;
      fr.push({ p: [+src[b], +src[b + 1], +src[b + 2]], q: qnorm([+src[b + 3], +src[b + 4], +src[b + 5], +src[b + 6]]) });
    }
    out.push(fr);
  }
  return out;
}
const cloneFrame = (fr) => fr.map((pt) => ({ p: pt.p.slice(), q: pt.q.slice() }));
const interpFrame = (a, b, t) => a.map((pt, i) => ({ p: lerp3(pt.p, b[i].p, t), q: qslerp(pt.q, b[i].q, t) }));

function armJoints(fr, arm) {
  const up = fr[arm.upper], fo = fr[arm.fore];
  const eUp = add(up.p, qrot(up.q, [0, 0, -HUMANOID_FALL_RIG.upperLen]));
  const eFo = add(fo.p, qrot(fo.q, [0, 0, HUMANOID_FALL_RIG.elbowUp]));
  return { J0: up.p.slice(), J1: lerp3(eUp, eFo, 0.5), J2: fr[arm.hand].p.slice() };
}
function rotateParts(fr, idx, pivot, R) {
  for (const i of idx) {
    const pt = fr[i];
    if (!pt) continue;
    pt.p = add(pivot, qrot(R, sub(pt.p, pivot)));
    pt.q = qnorm(qmul(R, pt.q));
  }
}
function swingArm(fr, arm, T, pole) {
  const { J0, J1, J2 } = armJoints(fr, arm);
  const s = solveTwoBone(J0, J1, J2, T, pole);
  const R1 = qFromTo(norm3(sub(J1, J0)), norm3(sub(s.elbow, J0)));
  rotateParts(fr, [arm.upper, ...arm.overlays, arm.fore, arm.hand], J0, R1);
  const W1 = add(J0, qrot(R1, sub(J2, J0)));
  const R2 = qFromTo(norm3(sub(W1, s.elbow)), norm3(sub(s.target, s.elbow)));
  rotateParts(fr, [arm.fore, arm.hand], s.elbow, R2);
  return s;
}

/** Wrist grip (out, fwd, up from the shoulder) for a profile: a wider head spreads the hands (mild, per heritage). */
export function canopyGripFor(profile) {
  const g = CANOPY_POSE.grip;
  const head = profile && Number.isFinite(profile.headHalfW) ? profile.headHalfW : CANOPY_POSE.headClear;
  return { out: g.out + Math.max(0, head - CANOPY_POSE.headClear), fwd: g.fwd, up: g.up };
}

function gripTargets(fr, grip) {
  const D = qmul(fr[HUMANOID_FALL_RIG.chest].q, qconj(HUMANOID_FALL_RIG.chestRestQuat));
  return HUMANOID_FALL_RIG.arms.map((arm) => {
    const J0 = fr[arm.upper].p;
    return {
      T: add(J0, qrot(D, [arm.side * grip.out, grip.fwd, grip.up])),
      pole: qrot(D, [arm.side * CANOPY_POSE.pole[0], CANOPY_POSE.pole[1], CANOPY_POSE.pole[2]]),
    };
  });
}

function packFrames(frames, np) {
  const out = new Float32Array(frames.length * np * 7);
  frames.forEach((fr, f) => {
    for (let i = 0; i < np; i++) {
      const b = (f * np + i) * 7, pt = fr[i];
      out[b] = pt.p[0]; out[b + 1] = pt.p[1]; out[b + 2] = pt.p[2];
      out[b + 3] = pt.q[0]; out[b + 4] = pt.q[1]; out[b + 5] = pt.q[2]; out[b + 6] = pt.q[3];
    }
  });
  return out;
}

/**
 * The canopy variant's frames from the retail Falling loop (AnimationJs shape `{numFrames, numParts: 34, frames}`):
 * calm (each part blended `calm` toward the loop's mean pose), slow (resampled `slow` x longer, cyclic), the arm
 * chains swung so the wrists reach the grip (`grip`, default CANOPY_POSE.grip); `enter` = a lead-in from the raw
 * Falling frame 0 (the arms' targets and poles eased from the free-fall pose to the grip) + one loop + a closing
 * frame = loop frame 0; `loop` = `cycles` loops + the closing frame (seamless re-play). null for a non-34-part anim or
 * a bad shape. Pure.
 * @returns {{enter: Float32Array, loop: Float32Array, numParts: number, enterFrames: number, loopFrames: number,
 *   cycleFrames: number, info: object}|null}
 */
export function buildCanopyFrames(anim, opts = {}) {
  if (!anim || typeof anim !== "object") return null;
  const nf = anim.numFrames, np = anim.numParts;
  if (!Number.isInteger(nf) || nf < 2 || np !== HUMANOID_FALL_RIG.parts) return null;
  if (!anim.frames || anim.frames.length !== nf * np * 7) return null;
  const o = opts && typeof opts === "object" ? opts : {};
  const grip = o.grip ?? CANOPY_POSE.grip;
  const calm = Number.isFinite(o.calm) ? clampN(o.calm, 0, 1) : CANOPY_POSE.calm;
  const slow = Number.isInteger(o.slow) && o.slow >= 1 ? o.slow : CANOPY_POSE.slow;
  const leadIn = Number.isInteger(o.leadIn) && o.leadIn >= 0 ? o.leadIn : CANOPY_POSE.leadIn;
  const cycles = Number.isInteger(o.cycles) && o.cycles >= 1 ? o.cycles : CANOPY_POSE.cycles;
  const src = readFrames(anim);
  // the loop's mean pose (positions averaged; quaternions summed in frame 0's hemisphere, normalised)
  const mean = src[0].map((_, i) => {
    let p = [0, 0, 0], q = [0, 0, 0, 0];
    const q0 = src[0][i].q;
    for (const fr of src) {
      p = add(p, fr[i].p);
      const s = q0[0] * fr[i].q[0] + q0[1] * fr[i].q[1] + q0[2] * fr[i].q[2] + q0[3] * fr[i].q[3] < 0 ? -1 : 1;
      q = [q[0] + s * fr[i].q[0], q[1] + s * fr[i].q[1], q[2] + s * fr[i].q[2], q[3] + s * fr[i].q[3]];
    }
    return { p: mulS(p, 1 / nf), q: qnorm(q) };
  });
  const calmed = src.map((fr) => interpFrame(fr, mean, calm));
  const m = nf * slow;
  const base = [];
  for (let k = 0; k < m; k++) {
    const s = k / slow, i0 = Math.floor(s) % nf, i1 = (i0 + 1) % nf;
    base.push(interpFrame(calmed[i0], calmed[i1], s - Math.floor(s)));
  }
  const loop = base.map((fr) => {
    const out = cloneFrame(fr);
    const tg = gripTargets(out, grip);
    HUMANOID_FALL_RIG.arms.forEach((arm, j) => swingArm(out, arm, tg[j].T, tg[j].pole));
    return out;
  });
  // lead-in: the body eases from the raw Falling frame 0 to the calm loop's frame 0; each arm's wrist target and elbow
  // pole ease from where the raw arm is (b = 0 reproduces it exactly) to the grip
  const enterLead = [];
  for (let k = 0; k < leadIn; k++) {
    const u = k / leadIn, b = u * u * (3 - 2 * u);
    const fr = interpFrame(src[0], base[0], b);
    const tg = gripTargets(fr, grip);
    HUMANOID_FALL_RIG.arms.forEach((arm, j) => {
      const jt = armJoints(fr, arm);
      const T = lerp3(jt.J2, tg[j].T, b);
      const pole = lerp3(norm3(sub(jt.J1, jt.J0)), norm3(tg[j].pole), b);
      swingArm(fr, arm, T, pole);
    });
    enterLead.push(fr);
  }
  const enterFrames = [...enterLead, ...loop, loop[0]];
  const loopFrames = [];
  for (let c = 0; c < cycles; c++) loopFrames.push(...loop);
  loopFrames.push(loop[0]);
  // info: the grip in object space (loop frame 0) — the canopy's riser points (chute.js) and the test's anchors
  const f0 = loop[0];
  const info = {
    grip: { ...grip },
    arms: HUMANOID_FALL_RIG.arms.map((arm) => {
      const jt = armJoints(f0, arm);
      const fingers = qrot(f0[arm.hand].q, [0, 0, -1]);
      return { side: arm.side, shoulder: jt.J0, elbow: jt.J1, wrist: jt.J2, gripPoint: add(jt.J2, mulS(fingers, HUMANOID_FALL_RIG.handGrip)), fingers };
    }),
    chest: f0[HUMANOID_FALL_RIG.chest].p.slice(),
  };
  return {
    enter: packFrames(enterFrames, np), loop: packFrames(loopFrames, np), numParts: np,
    enterFrames: enterFrames.length, loopFrames: loopFrames.length, cycleFrames: m, leadInFrames: leadIn, info,
  };
}

/**
 * The two canopy clip descriptors (entities.js playLocalClip shape, built by the drone's `buildClip` from the
 * frames above: one source range, no root motion, `posFrames: null`) + the info. null when the frames cannot be
 * built.
 */
export function buildCanopyClips(anim, opts = {}) {
  const fr = buildCanopyFrames(anim, opts);
  if (!fr) return null;
  const fps = Number.isFinite(opts?.fps) && opts.fps > 0 ? opts.fps : CANOPY_POSE.fps;
  const did = (anim.did >>> 0) || FALL_ANIMS.LOOP;
  const enter = buildClip({ numFrames: fr.enterFrames, numParts: fr.numParts, frames: fr.enter, did }, [{ from: 0, to: fr.enterFrames - 1 }], { fps });
  const loop = buildClip({ numFrames: fr.loopFrames, numParts: fr.numParts, frames: fr.loop, did }, [{ from: 0, to: fr.loopFrames - 1 }], { fps });
  if (!enter || !loop) return null;
  return { enter, loop, info: fr.info, cycleFrames: fr.cycleFrames, leadInFrames: fr.leadInFrames };
}

/**
 * The local fall twin's bound (s): the slowest possible descent from the bail height (the chute opened at once:
 * FALL.CHUTE_SINK) plus a terrain margin and slack, clamped to [5 min, 60 min]. A 5 km bail: ~20 min. Unknown terrain
 * counts as sea level (conservative).
 */
export function fallTimeoutSec(startZ, groundZ) {
  const z = Number.isFinite(startZ) ? startZ : 0;
  const g = Number.isFinite(groundZ) ? groundZ : 0;
  const sec = (Math.max(0, z - g) + FALL_BOUND.marginM) / FALL.CHUTE_SINK + FALL_BOUND.slackSec;
  return clampN(sec, FALL_BOUND.minSec, FALL_BOUND.maxSec);
}

/**
 * The per-body state machine (pure): idle -> freefall (bail) -> canopy (chute) -> idle (touchdown / teleport /
 * seated / gone / dispose). Every transition returns the actions the driver executes, in order:
 * `{type: 'motion', cmd}`, `{type: 'pack', mode: 'packed'|'flat'|'none'}`, `{type: 'clip', op: 'canopy'|'stop'}`.
 * A chute without a bail (the Bail event missed) starts the fall first; a repeated event is a no-op.
 */
export function createFallPoseMachine() {
  const bodies = new Map();
  const g32 = (g) => (Number(g) >>> 0);
  return {
    bail(guid, t = 0) {
      const g = g32(guid);
      if (!g) return [];
      const b = bodies.get(g);
      if (b && b.phase !== PHASE.IDLE) return [];
      bodies.set(g, { phase: PHASE.FREEFALL, since: t, bailAt: t, chuteAt: null });
      return [{ type: "pack", mode: "packed" }, { type: "motion", cmd: FALL_MOTION.FALLING }];
    },
    chute(guid, t = 0) {
      const g = g32(guid);
      if (!g) return [];
      const b = bodies.get(g);
      if (b && b.phase === PHASE.CANOPY) return [];
      const pre = b && b.phase === PHASE.FREEFALL ? [] : [{ type: "pack", mode: "packed" }, { type: "motion", cmd: FALL_MOTION.FALLING }];
      bodies.set(g, { phase: PHASE.CANOPY, since: t, bailAt: b ? b.bailAt : t, chuteAt: t });
      return [...pre, { type: "clip", op: "canopy" }, { type: "pack", mode: "flat" }];
    },
    end(guid, why = "touchdown") {
      const g = g32(guid);
      const b = bodies.get(g);
      if (!b) return [];
      bodies.delete(g);
      const acts = [];
      if (b.phase === PHASE.CANOPY) acts.push({ type: "clip", op: "stop" });
      // a body that is gone (despawned / out of range) has nothing to hand back; a seated one has the server's Sitting
      if (why !== "gone" && why !== "seated") acts.push({ type: "motion", cmd: FALL_MOTION.READY });
      acts.push({ type: "pack", mode: "none" });
      return acts;
    },
    phase(guid) { return bodies.get(g32(guid))?.phase ?? PHASE.IDLE; },
    get(guid) { const b = bodies.get(g32(guid)); return b ? { ...b } : null; },
    guids() { return [...bodies.keys()]; },
    get size() { return bodies.size; },
  };
}

// ---------------------------------------------------------------------------
// Page half
// ---------------------------------------------------------------------------

// Held-motion watchdog (drone gestures `watch`): Falling replaced after it took (a server motion, a stray Ready) is
// re-asserted at most once a second; one still committing (the MotionTable bake after setMotion) is given 2.5 s first,
// so a slow bake is never superseded by its own re-issue.
const WATCH = Object.freeze({ overrideSec: 1.0, commitSec: 2.5 });
const OBSERVED = Object.freeze({
  landAgl: 0.6, landSec: 0.75, stillVz: 0.3, stillSec: 4.0, goneSec: 2.0, rebuildSec: 5.0,
  chuteSink: 8, fastSink: 15, chuteSec: 1.5, chuteMinAgl: 5,
});

function noRaycast() {}

/**
 * The fall-pose driver for every falling body this client draws.
 * @param {{liveScene3d: object, THREE?: object, wasm?: object, wireframe?: boolean,
 *   ground?: (x: number, y: number) => number,
 *   onChute?: (guid: number) => void, onLanded?: (guid: number) => void,
 *   loadAnim?: (wasm: object, did: number) => Promise<object|null>, now?: () => number}} deps
 */
export function createFallPose(deps = {}) {
  const live = deps.liveScene3d ?? null;
  const THREE = deps.THREE ?? null;
  const em = () => live?.entityManager ?? null;
  const wasm = () => deps.wasm ?? live?.wasmExports ?? null;
  const ground = typeof deps.ground === "function" ? deps.ground : () => NaN;
  const fetchAnim = typeof deps.loadAnim === "function" ? deps.loadAnim : loadAnim;
  const nowSec = typeof deps.now === "function" ? deps.now : () => (typeof performance !== "undefined" ? performance.now() : Date.now()) / 1000;
  const machine = createFallPoseMachine();
  const bodies = new Map(); // guid -> body record (the driver's half of the state)
  const clips = new Map(); // setup key -> {clips} | {pending: Promise} | {failed: true}
  const geoms = new Map(); // placement key -> {body: BufferGeometry, straps: BufferGeometry|null}
  let mats = null;
  let disposed = false;
  const stats = {
    begun: 0, chutes: 0, ended: 0, motions: 0, reissued: 0, clipsPlayed: 0, clipReplays: 0, clipRefused: 0,
    clipBuilds: 0, clipBuildFailed: 0, packs: 0, rebinds: 0, inferredChutes: 0, landedByGround: 0, landedStill: 0, gone: 0,
    lastEnd: null,
  };

  const instOf = (g) => { try { return em()?.entityMap?.get?.(g >>> 0) ?? null; } catch (_) { return null; } };
  const deathHeld = (g) => { try { return em()?.isDeathHeld?.(g >>> 0) === true; } catch (_) { return false; } };
  const setupOf = (inst) => ((inst?.meta?.modelId ?? inst?.meta?.setupId ?? 0) >>> 0);

  function material() {
    if (mats || !THREE) return mats;
    // the canopy's exact program parameters (chute.js): one compiled program for the pack and the dome
    const m = deps.wireframe
      ? new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide })
      : new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, roughness: 0.95, metalness: 0 });
    mats = { m };
    return mats;
  }

  function geometryFor(pl) {
    const key = `${pl.kind}:${pl.dims.w.toFixed(3)}:${pl.dims.h.toFixed(3)}:${pl.dims.d.toFixed(3)}:${pl.pos.map((v) => v.toFixed(3)).join(",")}`;
    let g = geoms.get(key);
    if (g) return g;
    const raw = packGeometry(pl);
    const mk = (r) => {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(r.positions, 3));
      geo.setAttribute("color", new THREE.BufferAttribute(r.colors, 3));
      geo.computeVertexNormals();
      return geo;
    };
    g = { body: mk(raw.body), straps: raw.straps ? mk(raw.straps) : null };
    geoms.set(key, g);
    return g;
  }

  // ---- the pack ------------------------------------------------------------

  function buildPack(b) {
    if (!THREE || !b.placement || b.pack) return b.pack;
    const mat = material();
    const g = geometryFor(b.placement);
    if (!mat || !g) return null;
    const root = new THREE.Group();
    root.name = `vehicle-pack-${b.guid.toString(16)}`;
    const bodyGroup = new THREE.Group();
    bodyGroup.add(new THREE.Mesh(g.body, mat.m));
    root.add(bodyGroup);
    if (g.straps) root.add(new THREE.Mesh(g.straps, mat.m));
    // drone SPEC §6.11: tagged as an attached child (survives part-content swaps, pruned by the rig's dispose walk),
    // layer 1 (the entities indoor-layer invariant), no shadows, no-op raycast
    root.userData.__attachedChildOf = b.guid >>> 0;
    root.traverse((o) => { o.layers.set(1); o.castShadow = false; o.receiveShadow = false; if (o.isMesh) o.raycast = noRaycast; });
    const [x, y, z] = b.placement.pos;
    const q = b.placement.quat;
    root.position.set(x, y, z);
    root.quaternion.set(q[1], q[2], q[3], q[0]);
    b.pack = { root, bodyGroup, flat: 0, target: 0 };
    stats.packs++;
    return b.pack;
  }

  function attachPack(b) {
    const pk = buildPack(b);
    const part = b.inst?.parts?.[b.placement?.part];
    if (!pk || !part || part.isObject3D !== true) return false;
    if (pk.root.parent !== part) part.add(pk.root);
    pk.root.visible = true;
    return true;
  }

  function removePack(b) {
    if (!b.pack) return;
    try { b.pack.root.removeFromParent(); } catch (_) { /* gone */ }
    b.pack = null; // geometry / material are shared (geoms / mats) and freed on dispose
  }

  // ---- motions and the canopy clip ------------------------------------------

  function issue(b, cmd) {
    const e = em();
    if (!e || !b.inst || typeof e.setMotion !== "function") return false;
    if (cmd === FALL_MOTION.READY && deathHeld(b.guid)) return false; // DV-13: never stand a corpse up
    if (cmd === FALL_MOTION.FALLING && deathHeld(b.guid)) return false;
    try {
      const p = e.setMotion(b.guid, cmd >>> 0, FALL_MOTION.NONCOMBAT, 1.0); // DV-12: speed 1
      if (p && typeof p.then === "function") p.then(null, () => {});
    } catch (_) { return false; }
    b.lastIssue = nowSec();
    stats.motions++;
    return true;
  }

  function clipsFor(b) {
    const key = b.resolved?.key ?? "?";
    const hit = clips.get(key);
    if (hit) return hit;
    const entry = { pending: null, clips: null, risers: null, failed: false };
    clips.set(key, entry);
    stats.clipBuilds++;
    entry.pending = Promise.resolve()
      .then(() => fetchAnim(wasm(), FALL_ANIMS.LOOP))
      .then((anim) => {
        const c = anim ? buildCanopyClips(anim, { grip: canopyGripFor(b.resolved?.profile) }) : null;
        if (c) {
          entry.clips = c;
          // the canopy's riser grips (chute.js): one frozen array per rig fit, handed out by reference
          entry.risers = Object.freeze(c.info.arms.map((a) => Object.freeze({ grip: Object.freeze(a.gripPoint.slice()), shoulder: Object.freeze(a.shoulder.slice()) })));
        } else { entry.failed = true; stats.clipBuildFailed++; }
      })
      .catch(() => { entry.failed = true; stats.clipBuildFailed++; })
      .finally(() => { entry.pending = null; });
    return entry;
  }

  function playClip(b, which) {
    const e = em();
    const entry = clipsFor(b);
    if (!entry.clips || !b.inst || !e || typeof e.playLocalClip !== "function") return false;
    const desc = which === "loop" ? entry.clips.loop : entry.clips.enter;
    let ok = false;
    try { ok = e.playLocalClip(b.guid, desc, { holdFinal: true }) === true; } catch (_) { ok = false; }
    if (!ok) { stats.clipRefused++; b.clipRefusals++; b.clipRefusedAt = nowSec(); b.clip = null; return false; }
    b.clipRefusals = 0;
    b.clip = { rec: b.inst._unifiedSeq ?? null, desc, which, startedAt: nowSec() };
    if (which === "loop") stats.clipReplays++; else stats.clipsPlayed++;
    return true;
  }

  function stopClip(b) {
    const c = b.clip;
    b.clip = null;
    if (!c) return;
    const inst = instOf(b.guid);
    if (!inst || inst !== b.inst || inst._unifiedSeq !== c.rec) return; // not ours on the playhead any more
    try { em()?.stopLocalClip?.(b.guid); } catch (_) { /* gone */ }
  }

  function run(b, actions) {
    for (const a of actions) {
      if (a.type === "motion") issue(b, a.cmd);
      else if (a.type === "pack") {
        if (a.mode === "none") removePack(b);
        else {
          if (a.mode === "packed" && b.placement) attachPack(b);
          if (b.pack) b.pack.target = a.mode === "flat" ? 1 : 0;
        }
      } else if (a.type === "clip") {
        if (a.op === "stop") stopClip(b);
        else if (b.resolved?.kind === "humanoid") { b.wantClip = true; playClip(b, "enter"); }
      }
    }
  }

  // ---- bodies ----------------------------------------------------------------

  function resolveRig(b) {
    const inst = b.inst;
    if (!inst) return;
    const partCount = Array.isArray(inst.parts) ? inst.parts.length : 0;
    const sid = setupOf(inst);
    const r = resolvePackProfile({ setupId: sid, partCount });
    if (r.source === "fallback-human" && !b.rigChecked) {
      // an unknown 34-part Setup: confirm the humanoid hands the way the drone does (holding RightHand on 15,
      // LeftHand on 12) before fitting the human pack; until then, nothing
      b.rigChecked = true;
      b.resolved = { key: r.key, source: "pending", kind: "none", profile: null };
      readHoldingLocations(em(), sid).then((holding) => {
        if (bodies.get(b.guid) !== b) return;
        const prof = rigProfile({ partCount, holdingLocations: holding });
        b.resolved = resolvePackProfile({ setupId: sid, partCount, humanoid: prof.kind === "humanoid" });
        b.placement = packPlacement(b.resolved);
        if (b.placement && machine.phase(b.guid) !== PHASE.IDLE) {
          attachPack(b);
          if (b.pack) b.pack.target = machine.phase(b.guid) === PHASE.CANOPY ? 1 : 0;
          if (machine.phase(b.guid) === PHASE.CANOPY && b.resolved.kind === "humanoid") { b.wantClip = true; playClip(b, "enter"); }
        }
      }, () => {});
      return;
    }
    b.resolved = r;
    b.placement = packPlacement(r);
  }

  function body(guid, local) {
    const g = guid >>> 0;
    let b = bodies.get(g);
    if (!b) {
      b = {
        guid: g, local: !!local, inst: instOf(g), resolved: null, placement: null, pack: null, clip: null, wantClip: false,
        lastIssue: -1e9, sawFalling: false, rigChecked: false, goneSince: null, startedAt: nowSec(),
        clipRefusals: 0, clipRefusedAt: -1e9,
        obs: { lastZ: NaN, lastT: NaN, vz: 0, fast: false, slowSince: null, lowSince: null, stillSince: null },
      };
      bodies.set(g, b);
      resolveRig(b);
    } else if (local) b.local = true;
    return b;
  }

  function begin(guid, opts = {}) {
    if (disposed || !(guid >>> 0)) return false;
    const b = body(guid, opts.local);
    const acts = machine.bail(b.guid, nowSec());
    if (!acts.length) return false;
    stats.begun++;
    run(b, acts);
    if (b.resolved?.kind === "humanoid") clipsFor(b); // build the canopy clip during the free fall
    return true;
  }

  function chute(guid, opts = {}) {
    if (disposed || !(guid >>> 0)) return false;
    const b = body(guid, opts.local);
    const acts = machine.chute(b.guid, nowSec());
    if (!acts.length) return false;
    stats.chutes++;
    run(b, acts);
    return true;
  }

  function end(guid, why = "touchdown") {
    const g = guid >>> 0;
    const b = bodies.get(g);
    if (!b) return false;
    const inst = instOf(g);
    if (inst !== b.inst) b.inst = inst; // a rebuilt rig: hand the new one back
    run(b, machine.end(g, inst ? why : "gone"));
    removePack(b);
    b.wantClip = false;
    bodies.delete(g);
    stats.ended++;
    stats.lastEnd = { guid: g, why, local: b.local, sec: +(nowSec() - b.startedAt).toFixed(1) };
    return true;
  }

  function rebind(b, inst) {
    const prev = b.inst;
    b.inst = inst;
    stats.rebinds++;
    if (setupOf(prev) !== setupOf(inst) || (prev?.parts?.length ?? 0) !== (inst?.parts?.length ?? 0)) {
      removePack(b);
      b.rigChecked = false;
      resolveRig(b);
    }
    b.clip = null;
    b.sawFalling = false;
    const ph = machine.phase(b.guid);
    if (b.placement) attachPack(b);
    if (b.pack) b.pack.target = ph === PHASE.CANOPY ? 1 : 0;
    if (ph === PHASE.FREEFALL) issue(b, FALL_MOTION.FALLING);
    else if (ph === PHASE.CANOPY) {
      // Falling first (its setMotion pre-empts synchronously), then the clip: the arms are already up, no lead-in
      issue(b, FALL_MOTION.FALLING);
      if (b.resolved?.kind === "humanoid") { b.wantClip = true; playClip(b, "loop"); }
    }
  }

  function clipFrame(c) {
    try { return c.rec?.seq?.globalFrameIndex ?? -1; } catch (_) { return -1; }
  }

  function tickBody(b, dt, t) {
    const inst = instOf(b.guid);
    if (!inst) {
      if (b.goneSince === null) b.goneSince = t;
      const rebuilding = (() => { try { return em()?.spawnInFlight?.has?.(b.guid) === true; } catch (_) { return false; } })();
      const limit = rebuilding ? OBSERVED.rebuildSec : OBSERVED.goneSec;
      if (!b.local && t - b.goneSince > limit) { stats.gone++; end(b.guid, "gone"); }
      return;
    }
    b.goneSince = null;
    if (inst !== b.inst) rebind(b, inst);
    const ph = machine.phase(b.guid);
    // the pack: keep it on the rig (a part swap keeps it; a rebuilt rig re-attached above), ease the flattening
    if (b.pack) {
      if (!b.pack.root.parent && b.placement) attachPack(b);
      const pk = b.pack;
      pk.flat += (pk.target - pk.flat) * (1 - Math.exp(-Math.max(0, dt) / PACK.flatSec));
      pk.bodyGroup.scale.set(1, 1 - (1 - PACK.flatDepth) * pk.flat, 1 - (1 - PACK.flatHeight) * pk.flat);
    }
    // free fall (and a canopy without its clip: a no-hands rig, a failed build): Falling stays on the rig
    if (ph === PHASE.FREEFALL || (ph === PHASE.CANOPY && !b.clip && !b.wantClip)) {
      const low = ((inst.lastMotionCommand ?? 0) >>> 0) & 0xffff;
      if (low === (FALL_MOTION.FALLING & 0xffff)) b.sawFalling = true;
      else if (!deathHeld(b.guid) && t - b.lastIssue >= (b.sawFalling ? WATCH.overrideSec : WATCH.commitSec)) {
        if (issue(b, FALL_MOTION.FALLING)) { stats.reissued++; b.sawFalling = false; }
      }
    }
    // canopy: the clip on the playhead; the loop re-played before it ends (a holdFinal clip latches its last frame,
    // which equals the loop's first, so a late re-play never shows the Falling cycle under it)
    if (ph === PHASE.CANOPY && b.wantClip) {
      const entry = clipsFor(b);
      if (entry.failed || b.clipRefusals >= 3) b.wantClip = false; // the free-fall pose stays (watchdog above)
      else if (entry.clips) {
        if (!b.clip) { if (t - b.clipRefusedAt >= 1) playClip(b, "enter"); }
        else if (inst._unifiedSeq !== b.clip.rec) {
          if (!deathHeld(b.guid)) playClip(b, "loop"); else { b.clip = null; b.wantClip = false; }
        } else {
          const f = clipFrame(b.clip);
          const n = b.clip.desc.numFrames;
          const elapsed = (t - b.clip.startedAt) * CANOPY_POSE.fps;
          if (f >= n - 3 || (f < 0 && elapsed >= n - 3)) playClip(b, "loop");
        }
      }
    }
    if (!b.local) tickObserved(b, inst, dt, t, ph);
  }

  // observed bodies: the Touchdown / Chute events only reach sessions that still track the vehicle — end on the
  // ground, infer the chute from the sink rate
  function tickObserved(b, inst, dt, t, ph) {
    const p = inst.root?.position;
    if (!p) return;
    const o = b.obs;
    if (Number.isFinite(o.lastZ) && t > o.lastT) {
      const vz = (p.z - o.lastZ) / (t - o.lastT);
      o.vz += (vz - o.vz) * Math.min(1, (t - o.lastT) / 0.4);
    }
    o.lastZ = p.z;
    o.lastT = t;
    const g = ground(p.x, p.y);
    const agl = Number.isFinite(g) ? p.z - g : NaN;
    // landed: the feet on the terrain, or no longer descending (a roof, a floor above the terrain)
    if (Number.isFinite(agl) && agl < OBSERVED.landAgl) { if (o.lowSince === null) o.lowSince = t; } else o.lowSince = null;
    if (Math.abs(o.vz) < OBSERVED.stillVz) { if (o.stillSince === null) o.stillSince = t; } else o.stillSince = null;
    const onGround = o.lowSince !== null && t - o.lowSince >= OBSERVED.landSec;
    if (onGround || (o.stillSince !== null && t - o.stillSince >= OBSERVED.stillSec)) {
      if (onGround) stats.landedByGround++; else stats.landedStill++;
      try { deps.onLanded?.(b.guid); } catch (_) { /* cosmetic */ }
      end(b.guid, "landed");
      return;
    }
    if (ph === PHASE.FREEFALL) {
      if (-o.vz > OBSERVED.fastSink) o.fast = true;
      if (o.fast && -o.vz < OBSERVED.chuteSink && (!Number.isFinite(agl) || agl > OBSERVED.chuteMinAgl)) {
        if (o.slowSince === null) o.slowSince = t;
        if (t - o.slowSince >= OBSERVED.chuteSec) {
          stats.inferredChutes++;
          chute(b.guid);
          try { deps.onChute?.(b.guid); } catch (_) { /* cosmetic */ }
        }
      } else o.slowSince = null;
    }
  }

  function tick(dt, t = nowSec()) {
    if (disposed || bodies.size === 0) return;
    for (const b of bodies.values()) { // a Map iterator survives deleting the current entry (end)
      try { tickBody(b, dt, t); } catch (e) {
        if (!stats.tickError) { stats.tickError = String(e?.message ?? e); try { console.warn("[vehicles] fall pose tick:", e); } catch (_) { /* */ } }
      }
    }
  }

  /**
   * The canopy's riser points for a body under its canopy pose (body frame, rig units: x right, y forward, z up from
   * the feet; [left, right] x {grip, shoulder}) — the same frozen array every call — or null.
   */
  function risers(guid) {
    const b = bodies.get(guid >>> 0);
    if (!b || !b.clip || machine.phase(b.guid) !== PHASE.CANOPY || !b.wantClip) return null;
    return clips.get(b.resolved?.key ?? "?")?.risers ?? null;
  }

  function status() {
    return {
      enabled: true,
      bodies: [...bodies.values()].map((b) => {
        const inst = instOf(b.guid);
        const ph = machine.phase(b.guid);
        let frame = null;
        if (b.clip && inst && inst._unifiedSeq === b.clip.rec) frame = clipFrame(b.clip);
        return {
          guid: b.guid, local: b.local, phase: ph,
          setup: b.resolved?.key ?? null, fit: b.resolved?.source ?? null, kind: b.resolved?.kind ?? null,
          heritage: b.resolved?.profile?.heritage ?? null, sex: b.resolved?.profile?.sex ?? null,
          rootScale: inst?.root?.scale?.x ?? null,
          motion: inst ? `0x${(((inst.lastMotionCommand ?? 0) >>> 0)).toString(16)}` : null,
          pack: b.pack ? { attached: !!b.pack.root.parent, part: b.placement?.part ?? null, flat: +b.pack.flat.toFixed(2), dims: b.placement?.dims ?? null } : null,
          clip: b.clip ? { which: b.clip.which, frame, frames: b.clip.desc.numFrames, onPlayhead: !!(inst && inst._unifiedSeq === b.clip.rec) } : null,
          sec: +(nowSec() - b.startedAt).toFixed(1),
        };
      }),
      stats: { ...stats },
    };
  }

  function dispose() {
    if (disposed) return;
    for (const g of [...bodies.keys()]) end(g, "dispose");
    disposed = true;
    for (const g of geoms.values()) { try { g.body.dispose(); g.straps?.dispose(); } catch (_) { /* */ } }
    geoms.clear();
    if (mats) { try { mats.m.dispose(); } catch (_) { /* */ } mats = null; }
    clips.clear();
  }

  return {
    begin, chute, end, tick, risers, status, dispose,
    phase: (g) => machine.phase(g),
    has: (g) => bodies.has(g >>> 0),
    stats: () => ({ ...stats }),
  };
}
