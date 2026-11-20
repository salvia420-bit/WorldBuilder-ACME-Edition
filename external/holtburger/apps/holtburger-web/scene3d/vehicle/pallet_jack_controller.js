// scene3d/vehicle/pallet_jack_controller.js — ISO 3691-5 Walk-Behind Pedestrian Pallet Jack Controller (HBV1 v7).
//
// Features:
//   - Tricycle kinematics (wheelbase = 1.18 m, maxTillerRad = 1.65 rad / +-95 deg)
//   - Surface-aware speed caps (2.2 m/s unloaded, 1.6 m/s loaded, 1.1 m/s on ramp <= 12 deg)
//   - Terrain + container walkable surface probing (probeContainerSurface with roof exclusion)
//   - Container wall BSP pushout (resolveContainerPushout) + pure 2D occupied pinwheel bay OBB pushout
//   - GMA magnetic fork engagement assist (dist <= 0.55 m, |yawDelta| <= 28 deg)
//   - 15 Hz throttled Vehicle_PalletJackAction(UpdatePose) sync + setVehicleSeat / clearVehicleSeat locking
//   - 34-part humanoid arm IK onto articulated tiller grip + WALK/WALK_BACKWARDS/READY state transitions
//   - createCameraOwner over-the-shoulder walk-behind camera + V follow/interior toggle
//   - __inputFunnel isolation + cancelJumpCharge + window capture + restore-time key drain
//   - Procedural wheel roll & pump/release audio cues + container bay slot highlighting (subSlot=null for full!)

import * as FM from "./flight_model.js";
import { PALLET_JACK_SPECS } from "./pallet_jack_model.js";
import {
  HALF_PALLET_WCIDS,
  computeReachableLoadSlots,
  computeReachableUnloadSlots,
  findNearestForkEngageTarget,
  getSlotSubBox,
  resolveContainerLogisticsSpec,
} from "./container_logistics.js";
import { HUMANOID_FALL_RIG, resolvePackProfile, solveTwoBone } from "./fall_pose.js";
import { isTypingTarget } from "../drone/controls.js";
import { cancelJumpCharge, jumpChargePending, markEscapeConsumed } from "../../ui/escape_action.js";
import { createCameraOwner } from "../film/runtime/camera_owner.js";

export const PALLET_JACK_ACTION = Object.freeze({
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

export const PALLET_JACK_SPEED = Object.freeze({
  empty: 2.2,
  loaded: 1.6,
  ramp: 1.1,
});

export const PALLET_JACK_MAX_RAMP_DEG = 12.0;
export const PALLET_JACK_MAX_RAMP_COS = Math.cos((PALLET_JACK_MAX_RAMP_DEG * Math.PI) / 180.0);
export const POSE_SEND_HZ = 15;
export const POSE_SEND_INTERVAL_S = 1.0 / POSE_SEND_HZ;
export const OPERATOR_BACK_OFFSET_M = 0.62;
export const FORK_LIFT_RATE_MPS = 0.25;
export const JACK_HULL_RADIUS_M = 0.3425; // ISO 3691-5 half-width 0.685 / 2

export const PALLET_JACK_MOTION = Object.freeze({
  READY: 0x41000003,
  WALK: 0x45000005,
  WALK_BACKWARDS: 0x45000006,
  NONCOMBAT: 0x8000003d,
});

export const VEHICLE_JACK_CODES = Object.freeze([
  "KeyW", "KeyA", "KeyS", "KeyD",
  "Space", "KeyF", "KeyR", "KeyX", "KeyV", "Escape",
]);

const CAPTURE = Object.freeze({ capture: true });
const BUBBLE = Object.freeze({ capture: false });
const MODAL_SELECTOR = '[aria-modal="true"]';
const TWO_PI = Math.PI * 2.0;

function nowSec(nowFn) {
  if (typeof nowFn === "function") return nowFn();
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now() / 1000;
  }
  return 0;
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function wrapHeading(h) {
  if (!Number.isFinite(h)) return 0;
  let a = h % TWO_PI;
  if (a < 0) a += TWO_PI;
  return a;
}

function angleDiff(a, b) {
  let d = (Number.isFinite(a) ? a : 0) - (Number.isFinite(b) ? b : 0);
  while (d > Math.PI) d -= TWO_PI;
  while (d < -Math.PI) d += TWO_PI;
  return d;
}

function isVisibleConnectedModal(el, win) {
  if (!el || el.isConnected === false) return false;
  if (el.hidden === true) return false;
  try {
    if (typeof el.getAttribute === "function") {
      if (el.getAttribute("aria-hidden") === "true") return false;
      if (el.getAttribute("data-open") === "0") return false;
    }
  } catch (_) {}
  if (el.dataset && el.dataset.open === "0") return false;
  if (el.style && (el.style.display === "none" || el.style.visibility === "hidden")) return false;
  try {
    const w = win ?? el.ownerDocument?.defaultView ?? (typeof window !== "undefined" ? window : null);
    if (w && typeof w.getComputedStyle === "function") {
      const cs = w.getComputedStyle(el);
      if (cs && (cs.display === "none" || cs.visibility === "hidden")) return false;
    }
  } catch (_) {}
  return true;
}

function insideModal(el, win) {
  try {
    if (!el || typeof el.closest !== "function") return false;
    const modal = el.closest(MODAL_SELECTOR);
    return modal ? isVisibleConnectedModal(modal, win) : false;
  } catch (_) {
    return false;
  }
}

export function inOpenModal(ev, doc, win) {
  const w = win ?? doc?.defaultView ?? null;
  if (insideModal(ev ? ev.target : null, w)) return true;
  try {
    const el = doc ? doc.activeElement : null;
    if (el && el.isConnected !== false && insideModal(el, w)) return true;
    if (doc && typeof doc.querySelectorAll === "function") {
      const list = doc.querySelectorAll(MODAL_SELECTOR);
      if (list) {
        for (let i = 0; i < list.length; i++) {
          if (isVisibleConnectedModal(list[i], w)) return true;
        }
      }
    } else if (doc && typeof doc.querySelector === "function") {
      if (isVisibleConnectedModal(doc.querySelector(MODAL_SELECTOR), w)) return true;
    }
    return false;
  } catch (_) {
    return false;
  }
}

function readFault(f) {
  if (!f || typeof f !== "object") return null;
  try {
    if (typeof f.snapshot === "function") {
      const s = f.snapshot();
      if (s && "fault" in s) return s.fault;
    }
    if ("_fault" in f) return f._fault;
    if ("fault" in f) return f.fault;
  } catch (_) {}
  return null;
}

/**
 * Transform AC world XY into container-local XY (+X right, +Y front bulkhead, -Y rear doors/ramp).
 */
export function worldToContainerLocal(wx, wy, cx, cy, heading = 0) {
  const dx = wx - cx;
  const dy = wy - cy;
  const c = Math.cos(heading);
  const s = Math.sin(heading);
  return {
    x: dx * c - dy * s,
    y: dx * s + dy * c,
  };
}

/**
 * Transform a container-local 2D delta (px, py) back to AC world XY delta.
 */
export function containerLocalDeltaToWorld(lx, ly, heading = 0) {
  const c = Math.cos(heading);
  const s = Math.sin(heading);
  return {
    x: lx * c + ly * s,
    y: -lx * s + ly * c,
  };
}

/**
 * Pure 2D circle-vs-AABB pushout against occupied pinwheel bay boxes inside a container.
 */
export function resolveBayObbPushout(lx, ly, radius, occupiedBoxes, ignoreSlotKey = null) {
  if (!Array.isArray(occupiedBoxes) || occupiedBoxes.length === 0) {
    return { x: lx, y: ly, hit: false };
  }
  const r = Math.max(0.05, Number.isFinite(radius) ? radius : JACK_HULL_RADIUS_M);
  let x = lx;
  let y = ly;
  let hit = false;

  for (let pass = 0; pass < 3; pass++) {
    let any = false;
    for (let i = 0; i < occupiedBoxes.length; i++) {
      const b = occupiedBoxes[i];
      if (!b) continue;
      if (ignoreSlotKey && b.slotKey === ignoreSlotKey) continue;
      const cx = clamp(x, b.x0, b.x1);
      const cy = clamp(y, b.y0, b.y1);
      const dx = x - cx;
      const dy = y - cy;
      const d2 = dx * dx + dy * dy;
      if (d2 >= r * r) continue;

      any = true;
      hit = true;
      if (d2 > 1e-9) {
        const d = Math.sqrt(d2);
        const push = r - d;
        x += (dx / d) * push;
        y += (dy / d) * push;
      } else {
        // Center lies inside box — push out along shallowest axis
        const dLeft = Math.abs(x - b.x0);
        const dRight = Math.abs(b.x1 - x);
        const dBot = Math.abs(y - b.y0);
        const dTop = Math.abs(b.y1 - y);
        const m = Math.min(dLeft, dRight, dBot, dTop);
        if (m === dLeft) x = b.x0 - r;
        else if (m === dRight) x = b.x1 + r;
        else if (m === dBot) y = b.y0 - r;
        else y = b.y1 + r;
      }
    }
    if (!any) break;
  }

  return { x, y, hit };
}

/**
 * Detect surface type ("ramp" | "floor" | "terrain") from probeContainerSurface hit.
 */
export function detectJackSurface(surfaceHit, jackZ = 0) {
  if (surfaceHit && Number.isFinite(surfaceHit.z) && Math.abs(surfaceHit.z - jackZ) <= 0.28) {
    const nz = surfaceHit.normalZ ?? surfaceHit.normal?.z ?? 1.0;
    if (Number.isFinite(nz) && nz < 0.999) {
      return "ramp";
    }
    return "floor";
  }
  return "terrain";
}

/**
 * Pure ISO 3691-5 tricycle kinematics step for walk-behind pallet jack.
 * Convention:
 *   - AC compass heading: 0 = +Y (North), +pi/2 = +X (East), clockwise positive.
 *   - steerPivot.rotation.z = tillerAngle (+tillerAngle = left turn, -tillerAngle = right turn).
 *   - dHeading = -(v / wheelbase) * tan(tillerAngle) * dt so pressing D (right, steer > 0)
 *     drives tillerAngle negative and produces +dHeading (clockwise right turn) when moving forward.
 */
export function stepPalletJackKinematics(state, input = {}, dt = 1 / 60) {
  const s = state && typeof state === "object" ? state : {};
  const inp = input && typeof input === "object" ? input : {};
  const stepDt = Number.isFinite(dt) && dt > 0 ? Math.min(dt, 0.1) : 0;

  const loaded = Boolean(s.loaded || (s.carriedWcid && s.carriedWcid !== 0));
  const surface = s.surface === "ramp" ? "ramp" : "flat";
  const maxSpeed = surface === "ramp"
    ? PALLET_JACK_SPEED.ramp
    : (loaded ? PALLET_JACK_SPEED.loaded : PALLET_JACK_SPEED.empty);

  const throttle = clamp(Number.isFinite(inp.throttle) ? inp.throttle : 0, -1, 1);
  const steer = clamp(Number.isFinite(inp.steer) ? inp.steer : 0, -1, 1);

  let tillerAngle = Number.isFinite(s.tillerAngle) ? s.tillerAngle : 0;
  const maxTiller = PALLET_JACK_SPECS.maxTillerRad;
  if (Math.abs(steer) > 0.01) {
    // Pressing D (steer = +1) steers right => negative tillerAngle
    const targetTiller = -steer * maxTiller;
    const maxStep = 2.8 * stepDt;
    const diff = targetTiller - tillerAngle;
    tillerAngle += clamp(diff, -maxStep, maxStep);
  } else if (stepDt > 0) {
    const centerStep = 3.2 * stepDt;
    if (Math.abs(tillerAngle) <= centerStep) tillerAngle = 0;
    else tillerAngle -= Math.sign(tillerAngle) * centerStep;
  }
  tillerAngle = clamp(tillerAngle, -maxTiller, maxTiller);

  let speed = Number.isFinite(s.speed) ? s.speed : 0;
  const targetSpeed = throttle * maxSpeed;
  if (stepDt > 0) {
    const rate = Math.abs(targetSpeed) > Math.abs(speed) ? 5.5 : 8.5;
    const maxDv = rate * stepDt;
    speed += clamp(targetSpeed - speed, -maxDv, maxDv);
  } else {
    speed = targetSpeed;
  }
  if (Math.abs(throttle) < 0.01 && Math.abs(speed) < 0.02) speed = 0;
  speed = clamp(speed, -maxSpeed, maxSpeed);

  let heading = Number.isFinite(s.heading) ? s.heading : 0;
  if (stepDt > 0 && Math.abs(speed) > 1e-4 && Math.abs(tillerAngle) > 1e-4) {
    const effAngle = clamp(tillerAngle, -1.35, 1.35);
    const omega = -(speed / PALLET_JACK_SPECS.wheelbase) * Math.tan(effAngle);
    heading = wrapHeading(heading + omega * stepDt);
  }

  const x = (Number.isFinite(s.x) ? s.x : 0) + Math.sin(heading) * speed * stepDt;
  const y = (Number.isFinite(s.y) ? s.y : 0) + Math.cos(heading) * speed * stepDt;

  return {
    x,
    y,
    heading,
    speed,
    tillerAngle,
    maxSpeed,
  };
}

/**
 * Exact [left, right] tiller handle crossbar grip points in jack-local AC coordinates
 * matching `pallet_jack_model.js:239-256, 334-336`.
 */
export function computeTillerGripLocal(tillerAngle = 0, pumpStroke = 0) {
  const ta = clamp(Number.isFinite(tillerAngle) ? tillerAngle : 0, -PALLET_JACK_SPECS.maxTillerRad, PALLET_JACK_SPECS.maxTillerRad);
  const ps = clamp(Number.isFinite(pumpStroke) ? pumpStroke : 0, 0, 1);
  const tiltX = ps * 0.75;
  const cx = Math.cos(tiltX);
  const sx = Math.sin(tiltX);
  const cz = Math.cos(ta);
  const sz = Math.sin(ta);
  const pivotY = PALLET_JACK_SPECS.steerPivotY; // -0.52
  const pivotZ = 0.38;

  const toJackLocal = (gx, gy, gz) => {
    // 1. Rotate around +X by tiltX inside tillerPivot
    const y1 = gy * cx - gz * sx;
    const z1 = gy * sx + gz * cx + pivotZ;
    // 2. Rotate around +Z by tillerAngle inside steerPivot
    const x2 = gx * cz - y1 * sz;
    const y2 = gx * sz + y1 * cz + pivotY;
    return [x2, y2, z1];
  };

  return {
    left: toJackLocal(-0.085, 0, 0.823),
    right: toJackLocal(+0.085, 0, 0.823),
  };
}

/**
 * Operator standing pose behind the tiller pivot facing the pallet jack.
 */
export function computeOperatorPose(jackPose, tillerAngle = 0) {
  const jx = Number.isFinite(jackPose?.x) ? jackPose.x : 0;
  const jy = Number.isFinite(jackPose?.y) ? jackPose.y : 0;
  const jz = Number.isFinite(jackPose?.z) ? jackPose.z : 0;
  const jh = Number.isFinite(jackPose?.heading) ? jackPose.heading : 0;

  // Tiller pivot is at (0, -0.52) in jack-local; operator walks 0.62 m behind tiller pivot,
  // tracking tiller swing softly (+-35% of tillerAngle) so arms stay within reach.
  const ta = clamp(Number.isFinite(tillerAngle) ? tillerAngle : 0, -PALLET_JACK_SPECS.maxTillerRad, PALLET_JACK_SPECS.maxTillerRad);
  const swing = ta * 0.35;
  const localX = Math.sin(swing) * OPERATOR_BACK_OFFSET_M;
  const localY = PALLET_JACK_SPECS.steerPivotY - Math.cos(swing) * OPERATOR_BACK_OFFSET_M;
  const q = FM.orientation(jh, 0, 0);
  const worldOff = FM.rotate(q, [localX, localY, 0]);
  return {
    x: jx + worldOff[0],
    y: jy + worldOff[1],
    z: jz,
    heading: wrapHeading(jh - swing * 0.5),
  };
}

/**
 * Walk-behind over-the-shoulder camera pose ("follow" or "interior" close view).
 */
export function computeWalkBehindCamera(jackPose, operatorPose, viewMode = "follow", groundFn = null, dt = 1 / 60, camState = null) {
  const isClose = viewMode === "interior";
  const back = isClose ? 1.85 : 3.2;
  const up = isClose ? 1.55 : 1.85;
  const right = isClose ? 0.32 : 0.45;
  const pitch = isClose ? -0.18 : -0.22;
  const fov = isClose ? 72 : 64;

  const targetH = Number.isFinite(jackPose?.heading) ? jackPose.heading : (operatorPose?.heading ?? 0);
  let camH = targetH;
  if (camState && Number.isFinite(camState.heading)) {
    const alpha = dt > 0 ? 1 - Math.exp(-dt / 0.14) : 1;
    camH = wrapHeading(camState.heading + angleDiff(targetH, camState.heading) * alpha);
    camState.heading = camH;
  } else if (camState) {
    camState.heading = camH;
  }

  const refX = operatorPose?.x ?? jackPose?.x ?? 0;
  const refY = operatorPose?.y ?? jackPose?.y ?? 0;
  const refZ = operatorPose?.z ?? jackPose?.z ?? 0;

  const sinH = Math.sin(camH);
  const cosH = Math.cos(camH);
  const ex = refX - sinH * back + cosH * right;
  const ey = refY - cosH * back - sinH * right;
  let ez = refZ + up;

  if (typeof groundFn === "function") {
    const g = groundFn(ex, ey);
    if (Number.isFinite(g) && ez < g + 0.45) ez = g + 0.45;
  }
  return { pos: [ex, ey, ez], h: camH, p: pitch, r: 0, fov };
}

// ---- Vector / Quaternion Helpers for 34-Part Arm IK ----

function vSub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function vLen(a) { return Math.hypot(a[0], a[1], a[2]); }
function vDot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function vCross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function vNorm(a) {
  const l = vLen(a);
  return l > 1e-9 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, -1];
}
function qFromToWxyz(u, v) {
  const d = vDot(u, v);
  if (d > 1 - 1e-12) return [1, 0, 0, 0];
  if (d < -1 + 1e-9) {
    let ax = vCross([1, 0, 0], u);
    if (vLen(ax) < 1e-6) ax = vCross([0, 1, 0], u);
    ax = vNorm(ax);
    return [0, ax[0], ax[1], ax[2]];
  }
  const c = vCross(u, v);
  const q = [1 + d, c[0], c[1], c[2]];
  const n = Math.hypot(q[0], q[1], q[2], q[3]);
  return n > 1e-12 ? [q[0] / n, q[1] / n, q[2] / n, q[3] / n] : [1, 0, 0, 0];
}
function setPartPos(part, p) {
  if (!part) return;
  if (part.position && typeof part.position.set === "function") part.position.set(p[0], p[1], p[2]);
  else if (part.position && typeof part.position === "object") { part.position.x = p[0]; part.position.y = p[1]; part.position.z = p[2]; }
  else part.position = { x: p[0], y: p[1], z: p[2] };
}
function setPartQuatWxyz(part, q) {
  if (!part) return;
  if (part.quaternion && typeof part.quaternion.set === "function") part.quaternion.set(q[1], q[2], q[3], q[0]);
  else if (part.quaternion && typeof part.quaternion === "object") {
    part.quaternion.x = q[1]; part.quaternion.y = q[2]; part.quaternion.z = q[3]; part.quaternion.w = q[0];
  } else {
    part.quaternion = { x: q[1], y: q[2], z: q[3], w: q[0] };
  }
}

function applyArmIk(entityInst, jackPose, opPose, tillerAngle, pumpStroke) {
  const parts = entityInst?.parts;
  if (!Array.isArray(parts) || parts.length < HUMANOID_FALL_RIG.parts) return false;
  const setupId = entityInst.setupId ?? entityInst._setupId ?? entityInst.meta?.setupId ?? entityInst.meta?.modelId ?? 0x02000001;
  const prof = resolvePackProfile({ setupId, partCount: parts.length, humanoid: true });
  if (prof.kind === "no-hands" || prof.kind === "none") return false;

  const grips = computeTillerGripLocal(tillerAngle, pumpStroke);
  const qJack = FM.orientation(jackPose.heading || 0, jackPose.pitch || 0, jackPose.bank || 0);
  const qOp = FM.orientation(opPose.heading || 0, 0, 0);
  const qOpConj = [qOp[0], -qOp[1], -qOp[2], -qOp[3]];
  const scale = Number.isFinite(entityInst.root?.scale?.x) && entityInst.root.scale.x > 0.1
    ? entityInst.root.scale.x
    : 1.0;

  const toOpLocal = (jackLocalPt) => {
    const wOff = FM.rotate(qJack, jackLocalPt);
    const wx = jackPose.x + wOff[0];
    const wy = jackPose.y + wOff[1];
    const wz = jackPose.z + wOff[2];
    const rel = FM.rotate(qOpConj, [wx - opPose.x, wy - opPose.y, wz - opPose.z]);
    return [rel[0] / scale, rel[1] / scale, rel[2] / scale];
  };

  const targets = [toOpLocal(grips.left), toOpLocal(grips.right)];
  const poles = [[-0.35, 0.35, -0.55], [+0.35, 0.35, -0.55]];

  for (let i = 0; i < HUMANOID_FALL_RIG.arms.length; i++) {
    const arm = HUMANOID_FALL_RIG.arms[i];
    const pUp = parts[arm.upper];
    const pFo = parts[arm.fore];
    const pHa = parts[arm.hand];
    if (!pUp || !pFo || !pHa) continue;

    const readP = (pt, fallback) => (pt?.position && Number.isFinite(pt.position.x))
      ? [pt.position.x, pt.position.y, pt.position.z]
      : fallback;

    const J0 = readP(pUp, [arm.side * 0.19, 0.0, 1.38]);
    let J1 = readP(pFo, [J0[0], J0[1] + 0.04, J0[2] - HUMANOID_FALL_RIG.upperLen]);
    let J2 = readP(pHa, [J1[0], J1[1] + 0.06, J1[2] - 0.28]);
    if (vLen(vSub(J1, J0)) < 0.05) {
      J1 = [J0[0], J0[1] + 0.04, J0[2] - HUMANOID_FALL_RIG.upperLen];
      J2 = [J1[0], J1[1] + 0.06, J1[2] - 0.28];
    } else if (vLen(vSub(J2, J1)) < 0.05) {
      J2 = [J1[0], J1[1] + 0.06, J1[2] - 0.28];
    }

    const solved = solveTwoBone(J0, J1, J2, targets[i], poles[i]);
    const qUp = qFromToWxyz([0, 0, -1], vNorm(vSub(solved.elbow, J0)));
    const qFo = qFromToWxyz([0, 0, -1], vNorm(vSub(solved.target, solved.elbow)));

    setPartPos(pUp, J0);
    setPartQuatWxyz(pUp, qUp);
    for (const ov of arm.overlays) {
      if (parts[ov]) {
        setPartPos(parts[ov], J0);
        setPartQuatWxyz(parts[ov], qUp);
      }
    }
    setPartPos(pFo, solved.elbow);
    setPartQuatWxyz(pFo, qFo);
    setPartPos(pHa, solved.target);
    setPartQuatWxyz(pHa, qFo);
  }
  return true;
}

/**
 * Input funnel lock + capture blocker + restore-time drain for walk-behind pallet jack mode.
 */
export function createPalletJackControls(deps = {}) {
  const win = deps.window ?? (typeof window !== "undefined" ? window : null);
  const doc = deps.document ?? win?.document ?? null;
  const cs = deps.cameraSwitcher ?? null;
  const listeners = new Set();
  const down = Object.create(null);
  const drainCodes = new Set();

  let locked = false;
  let disposed = false;
  let listening = false;
  let drainListening = false;
  let savedFunnel = null;

  const block = (ev) => {
    try { ev.preventDefault?.(); } catch (_) {}
    try { ev.stopImmediatePropagation?.(); } catch (_) {}
  };

  const emitAction = (type) => {
    const evt = { type, source: "keyboard" };
    for (const fn of [...listeners]) {
      try { fn(evt); } catch (_) {}
    }
  };

  function clearDown() {
    for (const c of VEHICLE_JACK_CODES) down[c] = false;
  }

  function onKey(ev) {
    if (!locked || !ev) return;
    const code = typeof ev.code === "string" ? ev.code : "";
    if (!VEHICLE_JACK_CODES.includes(code)) return;
    if (ev.type === "keyup") {
      down[code] = false;
    }
    if (isTypingTarget(ev, doc) || inOpenModal(ev, doc, win)) return;
    if (ev.ctrlKey || ev.altKey || ev.metaKey) return;

    if (code === "Escape") {
      block(ev);
      markEscapeConsumed(ev);
      if (ev.type === "keydown" && !ev.repeat) {
        emitAction("release");
      }
      return;
    }

    block(ev);
    if (ev.type === "keydown") {
      const fresh = !down[code] && !ev.repeat;
      down[code] = true;
      if (fresh) {
        if (code === "Space") emitAction("raiseLower");
        else if (code === "KeyF") emitAction("engage");
        else if (code === "KeyR") emitAction("stow");
        else if (code === "KeyV") emitAction("toggleCamera");
        else if (code === "KeyX") emitAction("release");
      }
    } else if (ev.type === "keyup") {
      down[code] = false;
    }
  }

  function onBlur() {
    clearDown();
  }

  function onVisibility() {
    if (doc?.visibilityState === "hidden") clearDown();
  }

  function onDrainKey(ev) {
    if (!ev) return;
    const code = typeof ev.code === "string" ? ev.code : "";
    if (!drainCodes.has(code)) return;
    if (ev.type === "keyup") {
      drainCodes.delete(code);
      block(ev);
    } else if (ev.repeat === true) {
      block(ev);
    } else {
      drainCodes.delete(code);
    }
    if (drainCodes.size === 0) dropDrain();
  }

  function onDrainBlur() {
    dropDrain();
  }

  function startDrain() {
    for (const c of VEHICLE_JACK_CODES) {
      if (down[c] && c !== "Escape") drainCodes.add(c);
    }
    clearDown();
    if (drainCodes.size === 0 || !win || typeof win.addEventListener !== "function") {
      drainCodes.clear();
      return;
    }
    if (drainListening) return;
    win.addEventListener("keydown", onDrainKey, CAPTURE);
    win.addEventListener("keyup", onDrainKey, CAPTURE);
    win.addEventListener("blur", onDrainBlur, BUBBLE);
    drainListening = true;
  }

  function dropDrain() {
    drainCodes.clear();
    if (!drainListening || !win) return;
    drainListening = false;
    try { win.removeEventListener("keydown", onDrainKey, CAPTURE); } catch (_) {}
    try { win.removeEventListener("keyup", onDrainKey, CAPTURE); } catch (_) {}
    try { win.removeEventListener("blur", onDrainBlur, BUBBLE); } catch (_) {}
  }

  function addListeners() {
    if (listening || !win || typeof win.addEventListener !== "function") return;
    win.addEventListener("keydown", onKey, CAPTURE);
    win.addEventListener("keyup", onKey, CAPTURE);
    win.addEventListener("keypress", onKey, CAPTURE);
    win.addEventListener("blur", onBlur, BUBBLE);
    doc?.addEventListener?.("visibilitychange", onVisibility, BUBBLE);
    listening = true;
  }

  function removeListeners() {
    if (!listening) return;
    listening = false;
    try { win?.removeEventListener?.("keydown", onKey, CAPTURE); } catch (_) {}
    try { win?.removeEventListener?.("keyup", onKey, CAPTURE); } catch (_) {}
    try { win?.removeEventListener?.("keypress", onKey, CAPTURE); } catch (_) {}
    try { win?.removeEventListener?.("blur", onBlur, BUBBLE); } catch (_) {}
    try { doc?.removeEventListener?.("visibilitychange", onVisibility, BUBBLE); } catch (_) {}
  }

  function lock() {
    if (disposed) return { ok: false };
    if (locked) return { ok: true, already: true };
    dropDrain();
    clearDown();
    savedFunnel = null;

    const f = deps.funnel ?? win?.__inputFunnel ?? null;
    if (f && typeof f === "object") {
      const prevFault = readFault(f);
      if (prevFault !== "throw" && typeof f.releaseHeld === "function") {
        try { f.releaseHeld("palletJack"); } catch (_) {}
      }
      let didPoison = false;
      if (prevFault === null && typeof f.poison === "function") {
        try { f.poison("gate"); didPoison = true; } catch (_) {}
      }
      savedFunnel = { ref: f, didPoison };
    }

    const h = win?.__sessionHandle ?? null;
    try {
      if (jumpChargePending(win, h)) cancelJumpCharge(win, h, doc);
      if (typeof win?.cancelJumpCharge === "function") win.cancelJumpCharge();
      if (typeof f?.cancelJumpCharge === "function") f.cancelJumpCharge();
    } catch (_) {}

    if (cs) {
      try { cs._endFollowDrag?.(); } catch (_) {}
      if (cs.keys && typeof cs.keys === "object") {
        for (const k of Object.keys(cs.keys)) cs.keys[k] = false;
      }
    }

    addListeners();
    locked = true;
    return { ok: true, already: false };
  }

  function restore() {
    if (!locked) return { ok: true, wasLocked: false };
    removeListeners();
    startDrain();
    if (savedFunnel?.ref && savedFunnel.didPoison && readFault(savedFunnel.ref) === "gate") {
      try { savedFunnel.ref.unpoison?.(); } catch (_) {}
    }
    try { savedFunnel?.ref?.releaseHeld?.("palletJack"); } catch (_) {}
    savedFunnel = null;
    locked = false;
    return { ok: true, wasLocked: true };
  }

  function poll() {
    const fwd = (down.KeyW ? 1 : 0) - (down.KeyS ? 1 : 0);
    const steer = (down.KeyD ? 1 : 0) - (down.KeyA ? 1 : 0);
    return { throttle: fwd, steer };
  }

  return {
    lock,
    restore,
    poll,
    onAction(fn) {
      if (typeof fn !== "function") return () => {};
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    get locked() { return locked; },
    dispose() {
      disposed = true;
      restore();
      dropDrain();
      clearDown();
      listeners.clear();
    },
  };
}

/**
 * Runtime Walk-Behind Pedestrian Pallet Jack Controller.
 */
export function createPalletJackController(deps = {}) {
  const live = deps.liveScene3d ?? null;
  const THREE = deps.THREE ?? null;
  const win = deps.window ?? (typeof window !== "undefined" ? window : null);
  const sh = typeof deps.sh === "function" ? deps.sh : () => win?.__sessionHandle ?? live?.sessionHandle ?? null;
  const em = typeof deps.em === "function" ? deps.em : () => live?.entityManager ?? null;
  const localGuid = typeof deps.localGuid === "function" ? deps.localGuid : () => 0;
  const ground = typeof deps.ground === "function" ? deps.ground : () => NaN;
  const containers = deps.containers ?? new Map();
  const deployables = deps.deployables ?? new Map();
  const palletJacks = deps.palletJacks ?? new Map();
  const osd = deps.osd ?? null;
  const flashPrompt = typeof deps.flashPrompt === "function" ? deps.flashPrompt : (msg) => osd?.prompt?.(msg);
  const logisticsAudio = deps.logisticsAudio ?? null;
  const writeEntity = typeof deps.writeEntity === "function" ? deps.writeEntity : () => false;
  const nowFn = deps.nowSec ?? null;
  const cameraOwnerFactory = deps.cameraOwnerFactory ?? createCameraOwner;

  let active = null; // { guid, entry, controls, camera, unsub, state, viewMode, camState, lastSentAt, lastMotionKey, pumpTimer, highlightedContainerGuid }
  let lastControls = null;
  let disposed = false;

  function unfadeAvatar() {
    try {
      const cs = live?.cameraSwitcher;
      if (cs && typeof cs._applyCameraPlayerFade === "function") {
        cs._camFadeLastOpacity = undefined;
        cs._applyCameraPlayerFade(1);
      }
    } catch (_) {}
  }

  function clearHighlights() {
    if (!active || !active.highlightedContainerGuid) return;
    const prev = containers.get(active.highlightedContainerGuid);
    if (prev?.model && typeof prev.model.setHighlightedSlot === "function") {
      try { prev.model.setHighlightedSlot(null, null, null); } catch (_) {}
    }
    active.highlightedContainerGuid = 0;
  }

  function collectOccupiedBayBoxes(cEntry) {
    const spec = resolveContainerLogisticsSpec(cEntry.kind);
    if (!spec || !Array.isArray(cEntry.slots)) return [];
    const boxes = [];
    for (let i = 0; i < cEntry.slots.length; i++) {
      const s = cEntry.slots[i];
      if (!s) continue;
      const idx = s.slotIndex ?? s.SlotIndex;
      if (!Number.isFinite(idx) || idx < 0 || idx >= spec.slots.length) continue;
      const wcid = s.cargoWcid ?? s.CargoWcid ?? 0;
      const ps = s.palletSize ?? s.PalletSize;
      if (ps === 0 || ps === "none" || ps === "None") continue;
      const isHalf = ps === 1 || ps === "half" || ps === "Half" || HALF_PALLET_WCIDS.has(wcid);
      const sub = isHalf ? (((s.subSlot ?? s.SubSlot ?? 0) | 0) === 1 ? 1 : 0) : 0;
      const b = getSlotSubBox(spec.slots[Math.trunc(idx)], isHalf ? "half" : "full", sub);
      b.slotKey = isHalf ? `${idx}:${sub}` : `${idx}`;
      boxes.push(b);
    }
    return boxes;
  }

  function containerZOf(cEntry, fallbackZ = 0) {
    const cpZ = cEntry?.model?.root?.position?.z;
    if (Number.isFinite(cpZ)) return cpZ;
    const rpZ = cEntry?.rawPos?.[2];
    return Number.isFinite(rpZ) ? rpZ : fallbackZ;
  }

  function containerObbDistance(wx, wy, cEntry) {
    const cp = cEntry.model?.root?.position;
    const cx = cp ? cp.x : (cEntry.rawPos?.[0] ?? 0);
    const cy = cp ? cp.y : (cEntry.rawPos?.[1] ?? 0);
    const ch = cEntry.heading || 0;
    const spec = resolveContainerLogisticsSpec(cEntry.kind);
    const halfW = spec?.interior?.halfW ?? 1.176;
    const halfL = spec?.interior?.halfL ?? 2.949;
    const rampLen = 0.85;
    const loc = worldToContainerLocal(wx, wy, cx, cy, ch);
    const dx = Math.max(0, Math.abs(loc.x) - halfW);
    const dy = loc.y < -(halfL + rampLen)
      ? -(halfL + rampLen) - loc.y
      : (loc.y > halfL ? loc.y - halfL : 0);
    return {
      obbDist: Math.hypot(dx, dy),
      centerDist: Math.hypot(cx - wx, cy - wy),
    };
  }

  function nearestGroundedContainer(wx, wy, maxDistM = 12.0, refZ = null, maxDz = 1.2) {
    let best = null;
    let bestObb = maxDistM;
    let bestCenter = Infinity;
    const checkZ = Number.isFinite(refZ);
    for (const cEntry of containers.values()) {
      if (!cEntry || cEntry.mountedOnTrailerGuid) continue;
      if (checkZ && Math.abs(containerZOf(cEntry, refZ) - refZ) > maxDz) continue;
      const { obbDist, centerDist } = containerObbDistance(wx, wy, cEntry);
      if (obbDist < bestObb - 1e-6 || (Math.abs(obbDist - bestObb) <= 1e-6 && obbDist < maxDistM && centerDist < bestCenter)) {
        bestObb = obbDist;
        bestCenter = centerDist;
        best = cEntry;
      }
    }
    return best;
  }

  function findNearestGroundDeployable(wx, wy, wz, maxDistM = 3.5) {
    let best = null;
    let bestD = maxDistM;
    for (const dEntry of deployables.values()) {
      const p = dEntry?.model?.root?.position;
      if (!p) continue;
      const d = Math.hypot(p.x - wx, p.y - wy);
      if (d <= bestD && Math.abs(p.z - wz) <= 2.5) {
        bestD = d;
        best = dEntry;
      }
    }
    return best;
  }

  function buildWorldSlotTargets(cEntry, list) {
    const cp = cEntry.model?.root?.position;
    const cx = cp ? cp.x : (cEntry.rawPos?.[0] ?? 0);
    const cy = cp ? cp.y : (cEntry.rawPos?.[1] ?? 0);
    const ch = cEntry.heading || 0;
    const out = [];
    for (let i = 0; i < list.length; i++) {
      const item = list[i];
      const delta = containerLocalDeltaToWorld(item.x, item.y, ch);
      out.push({
        ...item,
        x: cx + delta.x,
        y: cy + delta.y,
        heading: item.orient === "Y" ? wrapHeading(ch + Math.PI * 0.5) : ch,
        fourWay: true,
      });
    }
    return out;
  }

  function handleAction(action) {
    if (!active) return;
    const actionType = typeof action === "string" ? action : action?.type;
    const st = active.state;
    const h = sh();
    const cl = FM.toCellLocal(st.x, st.y, st.z);

    if (actionType === "toggleCamera") {
      active.viewMode = active.viewMode === "follow" ? "interior" : "follow";
      flashPrompt(`Camera: ${active.viewMode === "interior" ? "Close Interior" : "Follow"}`, 1000);
      return;
    }

    if (actionType === "release") {
      try {
        h?.vehiclePalletJackAction?.(
          active.guid,
          PALLET_JACK_ACTION.Release,
          0, 0, 0, 0,
          cl.cell, cl.x, cl.y, cl.z,
          st.heading, st.tillerAngle
        );
      } catch (_) {}
      stop("user-release");
      return;
    }

    if (actionType === "stow") {
      const dEntry = findNearestGroundDeployable(st.x, st.y, st.z, 3.5);
      if (!dEntry) {
        flashPrompt("No deployable within 3.5 m to stow/unstow", 1200);
        return;
      }
      try {
        h?.vehiclePalletJackAction?.(
          active.guid,
          PALLET_JACK_ACTION.ToggleDeployableStow,
          0, 0, 0, dEntry.guid,
          cl.cell, cl.x, cl.y, cl.z,
          st.heading, st.tillerAngle
        );
      } catch (_) {}
      return;
    }

    if (actionType === "raiseLower") {
      const isLowered = st.forkHeightM < (PALLET_JACK_SPECS.forkLoweredZ + PALLET_JACK_SPECS.forkRaisedZ) * 0.5;
      if (isLowered) {
        st.targetForkHeightM = PALLET_JACK_SPECS.forkRaisedZ;
        active.pumpTimer = 0.35;
        try { logisticsAudio?.pumpRatchet?.({ pos: [st.x, st.y, st.z] }); } catch (_) {}
        if (!st.carriedWcid) {
          const engaged = tryEngageOrPick(false);
          if (engaged) return;
        }
        try {
          h?.vehiclePalletJackAction?.(
            active.guid, PALLET_JACK_ACTION.RaiseForks,
            0, 0, 0, 0, cl.cell, cl.x, cl.y, cl.z, st.heading, st.tillerAngle
          );
        } catch (_) {}
      } else {
        st.targetForkHeightM = PALLET_JACK_SPECS.forkLoweredZ;
        try { logisticsAudio?.releaseHiss?.({ pos: [st.x, st.y, st.z] }); } catch (_) {}
        if (st.carriedWcid) {
          const dropped = tryDropOrLoad(false);
          if (dropped) return;
        }
        try {
          h?.vehiclePalletJackAction?.(
            active.guid, PALLET_JACK_ACTION.LowerForks,
            0, 0, 0, 0, cl.cell, cl.x, cl.y, cl.z, st.heading, st.tillerAngle
          );
        } catch (_) {}
      }
      return;
    }

    if (actionType === "engage") {
      if (!st.carriedWcid) {
        if (!tryEngageOrPick(true)) {
          flashPrompt("Align forks within 0.55 m / 28° of a pallet or deployable to pick", 1500);
        }
      } else {
        tryDropOrLoad(true);
      }
    }
  }

  function tryEngageOrPick(explicit) {
    if (!active) return false;
    const st = active.state;
    const h = sh();
    const cl = FM.toCellLocal(st.x, st.y, st.z);

    // 1. Check nearby container unload slots
    const cEntry = nearestGroundedContainer(st.x, st.y, 10.0, st.z, 0.8);
    if (cEntry && (cEntry.currentDoorProgress >= 0.5 || cEntry.last?.doorState === 2)) {
      const unload = computeReachableUnloadSlots(cEntry.kind, cEntry.slots);
      const targets = buildWorldSlotTargets(cEntry, unload.all);
      const best = findNearestForkEngageTarget(
        { x: st.x, y: st.y, heading: st.heading },
        targets,
        { forkOffset: PALLET_JACK_SPECS.cargoCenterY, maxDist: 0.78, includeBlocked: explicit }
      );
      if (best) {
        if (best.target.reachable === false) {
          flashPrompt(`ISO 6780 LIFO: Slot ${best.target.slotIndex} blocked by slot ${best.target.blockedBySlotIndex}`, 2000);
          return true;
        }
        try {
          h?.vehiclePalletJackAction?.(
            active.guid,
            PALLET_JACK_ACTION.PickContainerSlot,
            best.target.slotIndex | 0,
            best.target.palletSize === "half" ? (best.target.subSlot | 0) : 0,
            0,
            cEntry.guid,
            cl.cell, cl.x, cl.y, cl.z,
            st.heading, st.tillerAngle
          );
        } catch (_) {}
        return true;
      }
    }

    // 2. Check ground deployables within GMA fork engage reach
    const dTargets = [];
    for (const dEntry of deployables.values()) {
      const p = dEntry?.model?.root?.position;
      if (!p || Math.abs(p.z - st.z) > 1.2) continue;
      dTargets.push({
        guid: dEntry.guid,
        x: p.x,
        y: p.y,
        heading: dEntry.last?.heading ?? 0,
        fourWay: true,
        reachable: true,
      });
    }
    const dBest = findNearestForkEngageTarget(
      { x: st.x, y: st.y, heading: st.heading },
      dTargets,
      { forkOffset: PALLET_JACK_SPECS.cargoCenterY }
    );
    if (dBest) {
      try {
        h?.vehiclePalletJackAction?.(
          active.guid,
          PALLET_JACK_ACTION.PickGroundDeployable,
          0, 0, 0,
          dBest.target.guid,
          cl.cell, cl.x, cl.y, cl.z,
          st.heading, st.tillerAngle
        );
      } catch (_) {}
      return true;
    }
    return false;
  }

  function tryDropOrLoad(explicit) {
    if (!active) return false;
    const st = active.state;
    const h = sh();
    const cl = FM.toCellLocal(st.x, st.y, st.z);

    // Check if inside or immediately adjacent to an open grounded container for LoadContainerSlot
    const cEntry = nearestGroundedContainer(st.x, st.y, 8.0, st.z, 0.8);
    if (cEntry && (cEntry.currentDoorProgress >= 0.5 || cEntry.last?.doorState === 2)) {
      const palletSize = (st.carriedPalletSize === 1 || HALF_PALLET_WCIDS.has(st.carriedWcid)) ? "half" : "full";
      const load = computeReachableLoadSlots(cEntry.kind, cEntry.slots, palletSize);
      const targets = buildWorldSlotTargets(cEntry, load.all);
      const best = findNearestForkEngageTarget(
        { x: st.x, y: st.y, heading: st.heading },
        targets,
        { forkOffset: PALLET_JACK_SPECS.cargoCenterY, maxDist: 0.75, maxYawRad: Math.PI, includeBlocked: explicit }
      );
      if (best) {
        if (best.target.reachable === false) {
          flashPrompt(`ISO 6780 LIFO: Target slot ${best.target.slotIndex} blocked by slot ${best.target.blockedBySlotIndex}`, 2000);
          return true;
        }
        try {
          h?.vehiclePalletJackAction?.(
            active.guid,
            PALLET_JACK_ACTION.LoadContainerSlot,
            best.target.slotIndex | 0,
            palletSize === "half" ? (best.target.subSlot | 0) : 0,
            0,
            cEntry.guid,
            cl.cell, cl.x, cl.y, cl.z,
            st.heading, st.tillerAngle
          );
        } catch (_) {}
        return true;
      }
    }

    if (explicit) {
      try {
        h?.vehiclePalletJackAction?.(
          active.guid,
          PALLET_JACK_ACTION.DropToGround,
          0, 0, 0, 0,
          cl.cell, cl.x, cl.y, cl.z,
          st.heading, st.tillerAngle
        );
      } catch (_) {}
      return true;
    }
    return false;
  }

  function start(entry) {
    if (disposed || !entry) return false;
    const g = entry.guid >>> 0;
    if (active && active.guid === g) return true;
    if (active) stop("switch");
    if (lastControls) {
      try { lastControls.dispose?.(); } catch (_) {}
      lastControls = null;
    }

    const controls = createPalletJackControls({
      window: win,
      document: win?.document ?? null,
      cameraSwitcher: live?.cameraSwitcher ?? null,
    });
    lastControls = controls;
    controls.lock();

    let camera = null;
    try {
      camera = cameraOwnerFactory({
        liveScene3d: live,
        THREE,
        window: win,
        get sessionHandle() { return sh(); },
      });
      camera.own();
      unfadeAvatar();
    } catch (_) {
      camera = null;
    }

    const wp = entry.worldPos || [
      entry.model?.root?.position?.x ?? 0,
      entry.model?.root?.position?.y ?? 0,
      entry.model?.root?.position?.z ?? 0,
    ];

    const state = {
      x: Number.isFinite(wp[0]) ? wp[0] : 0,
      y: Number.isFinite(wp[1]) ? wp[1] : 0,
      z: Number.isFinite(wp[2]) ? wp[2] : 0,
      heading: Number.isFinite(entry.heading) ? entry.heading : 0,
      tillerAngle: Number.isFinite(entry.tillerAngle) ? entry.tillerAngle : 0,
      forkHeightM: Number.isFinite(entry.forkHeightM) ? entry.forkHeightM : PALLET_JACK_SPECS.forkLoweredZ,
      targetForkHeightM: Number.isFinite(entry.forkHeightM) ? entry.forkHeightM : PALLET_JACK_SPECS.forkLoweredZ,
      carriedWcid: entry.carriedWcid ?? 0,
      carriedPalletSize: entry.carriedPalletSize ?? 0,
      loaded: Boolean(entry.carriedWcid),
      speed: 0,
      surface: "terrain",
      onContainer: Boolean((entry.flags ?? 0) & 0x02),
    };

    active = {
      guid: g,
      entry,
      controls,
      camera,
      unsub: null,
      state,
      viewMode: "follow",
      camState: { heading: state.heading },
      lastSentAt: -1e9,
      lastMotionKey: null,
      pumpTimer: 0,
      highlightedContainerGuid: 0,
    };

    active.unsub = controls.onAction(handleAction);
    return true;
  }

  function stop(why = "release") {
    if (!active) return false;
    const act = active;
    clearHighlights();
    active = null;

    try { logisticsAudio?.stopWheelRoll?.(act.guid); } catch (_) {}
    try { act.unsub?.(); } catch (_) {}
    const hardTeardown = why === "dispose" || why === "death" || why === "teleport" || why === "despawn" || why === "switch";
    try {
      if (hardTeardown) {
        act.controls?.dispose?.();
        if (lastControls === act.controls) lastControls = null;
      } else {
        act.controls?.restore?.();
      }
    } catch (_) {}
    try { act.camera?.release?.(); act.camera?.dispose?.(); } catch (_) {}
    try { sh()?.clearVehicleSeat?.(); } catch (_) {}
    const me = localGuid();
    if (why !== "death" && !(me && em()?.isDeathHeld?.(me))) {
      try { em()?.setMotion?.(me, PALLET_JACK_MOTION.READY, PALLET_JACK_MOTION.NONCOMBAT, 1.0); } catch (_) {}
    }
    osd?.palletJack?.(null);
    unfadeAvatar();
    return true;
  }

  function onServerState(msg, entry) {
    if (disposed || !msg) return;
    const g = (msg.palletJackGuid ?? entry?.guid ?? 0) >>> 0;
    const me = localGuid();
    const op = (msg.operatorGuid ?? 0) >>> 0;
    const stowed = Boolean((msg.stowedOnTrailerGuid ?? 0) !== 0 || ((msg.flags ?? 0) & 0x04));

    const dead = Boolean(me && em()?.isDeathHeld?.(me));

    if (me !== 0 && op === me && !stowed && !dead) {
      if (!active || active.guid !== g) {
        start(entry);
      }
      if (active && active.guid === g) {
        const st = active.state;
        st.carriedWcid = msg.carriedWcid ?? 0;
        st.carriedPalletSize = msg.carriedPalletSize ?? 0;
        st.loaded = Boolean(st.carriedWcid);
        if (Number.isFinite(msg.forkHeightM)) {
          st.targetForkHeightM = clamp(msg.forkHeightM, PALLET_JACK_SPECS.forkLoweredZ, PALLET_JACK_SPECS.forkRaisedZ);
        }
        // Reconcile server position only on large divergence (> 2.5 m)
        const pos = msg.position;
        if (Array.isArray(pos) && pos.length >= 3) {
          const wg = msg.cell ? FM.toGlobal(msg.cell, pos[0], pos[1], pos[2]) : pos;
          if (Math.hypot(wg[0] - st.x, wg[1] - st.y) > 2.5) {
            st.x = wg[0];
            st.y = wg[1];
            st.z = wg[2];
          }
        }
      }
    } else if (active && active.guid === g) {
      stop(dead ? "death" : "server-released");
    }
  }

  function tick(dt) {
    if (disposed || !active) return;
    const me = localGuid();
    try {
      if (me && em()?.isDeathHeld?.(me)) {
        stop("death");
        return;
      }
    } catch (_) {}

    const act = active;
    const st = act.state;
    const h = sh();
    const stepDt = Number.isFinite(dt) && dt > 0 ? Math.min(dt, 0.1) : 1 / 60;

    // 1. Poll WASD & step tricycle kinematics
    const inp = act.controls.poll();
    const kin = stepPalletJackKinematics(st, inp, stepDt);
    let nx = kin.x;
    let ny = kin.y;
    st.heading = kin.heading;
    st.speed = kin.speed;
    st.tillerAngle = kin.tillerAngle;

    // 2. Resolve container BSP wall pushout BEFORE bay OBB pushout (excluding roof via world_z >= floor + 0.20, Z-guarded)
    const preNearbyC = nearestGroundedContainer(nx, ny, 14.0, st.z, 0.5);
    const preBaseZ = preNearbyC ? containerZOf(preNearbyC, st.z) : st.z;
    const preSameZ = Boolean(preNearbyC) && Math.abs(st.z - preBaseZ) <= 0.5;
    const pushZ = preSameZ ? Math.max(st.z + 0.25, preBaseZ + 0.20) : (st.z + 0.25);
    try {
      const push = h?.resolveContainerPushout?.(
        nx,
        ny,
        pushZ,
        Math.max(JACK_HULL_RADIUS_M, 0.3425)
      );
      if (push && Number.isFinite(push.x) && Number.isFinite(push.y)) {
        nx += push.x;
        ny += push.y;
      }
    } catch (_) {}

    // 3. Resolve pure 2D occupied pinwheel bay OBB pushout when inside an open grounded container at matching Z
    const nearbyC = nearestGroundedContainer(nx, ny, 14.0, st.z, 0.5);
    const containerBaseZ = nearbyC ? containerZOf(nearbyC, st.z) : st.z;
    const sameZAsContainer = Boolean(nearbyC) && Math.abs(st.z - containerBaseZ) <= 0.5;
    if (sameZAsContainer && (nearbyC.currentDoorProgress >= 0.5 || nearbyC.last?.doorState === 2)) {
      const spec = resolveContainerLogisticsSpec(nearbyC.kind);
      const cp = nearbyC.model?.root?.position;
      const cx = cp ? cp.x : (nearbyC.rawPos?.[0] ?? 0);
      const cy = cp ? cp.y : (nearbyC.rawPos?.[1] ?? 0);
      const ch = nearbyC.heading || 0;
      if (spec) {
        const loc = worldToContainerLocal(nx, ny, cx, cy, ch);
        if (Math.abs(loc.x) <= spec.interior.halfW + 0.4 && Math.abs(loc.y) <= spec.interior.halfL + 0.4) {
          const boxes = collectOccupiedBayBoxes(nearbyC);
          let ignoreSlotKey = null;
          let ignoredBox = null;
          const localHeading = st.heading - ch;
          const lfx = Math.sin(localHeading);
          const lfy = Math.cos(localHeading);

          // When unloaded, allow forks to slide under an aligned reachable unload target from its facing side
          if (!st.carriedWcid) {
            const unload = computeReachableUnloadSlots(nearbyC.kind, nearbyC.slots);
            const rTargets = buildWorldSlotTargets(nearbyC, unload.reachable);
            const entryCand = findNearestForkEngageTarget(
              { x: nx, y: ny, heading: st.heading },
              rTargets,
              { forkOffset: PALLET_JACK_SPECS.cargoCenterY, maxDist: 0.90 }
            );
            if (entryCand) {
              const candKey = entryCand.target.palletSize === "half"
                ? `${entryCand.target.slotIndex}:${entryCand.target.subSlot}`
                : `${entryCand.target.slotIndex}`;
              const box = boxes.find((b) => b.slotKey === candKey);
              if (box) {
                const fwdDist = (box.x - loc.x) * lfx + (box.y - loc.y) * lfy;
                const latDist = Math.abs((loc.x - box.x) * (-lfy) + (loc.y - box.y) * lfx);
                if (fwdDist >= -0.05 && latDist <= 0.38) {
                  ignoreSlotKey = candKey;
                  ignoredBox = box;
                }
              }
            }
          }

          const pushed = resolveBayObbPushout(loc.x, loc.y, JACK_HULL_RADIUS_M, boxes, ignoreSlotKey);

          // Prevent forks/backrest from passing through the far side of the entered pallet
          if (ignoredBox) {
            const forkRefX = pushed.x + lfx * PALLET_JACK_SPECS.cargoCenterY;
            const forkRefY = pushed.y + lfy * PALLET_JACK_SPECS.cargoCenterY;
            const fwdPast = (forkRefX - ignoredBox.x) * lfx + (forkRefY - ignoredBox.y) * lfy;
            if (fwdPast > 0.05) {
              pushed.x -= lfx * (fwdPast - 0.05);
              pushed.y -= lfy * (fwdPast - 0.05);
              pushed.hit = true;
            }
          }

          // Clamp against container interior walls so bay pushout never ejects jack through a wall
          const rHull = JACK_HULL_RADIUS_M;
          const maxInsideX = Math.max(0.05, spec.interior.halfW - rHull);
          const maxInsideY = Math.max(0.05, spec.interior.halfL - rHull);
          const nearInterior = loc.y >= -spec.interior.halfL && loc.y <= spec.interior.halfL &&
            (Math.abs(loc.x) <= spec.interior.halfW + 0.08 || st.onContainer);
          const crossedWall = pushed.x > maxInsideX || pushed.x < -maxInsideX || pushed.y > maxInsideY;
          let revertedToPrev = false;

          if (nearInterior && crossedWall) {
            pushed.x = clamp(pushed.x, -maxInsideX, maxInsideX);
            pushed.y = Math.min(pushed.y, maxInsideY);
            pushed.hit = true;

            const isClearOfAll = (cx0, cy0) => {
              if (cx0 < -maxInsideX - 1e-6 || cx0 > maxInsideX + 1e-6 || cy0 > maxInsideY + 1e-6) return false;
              for (let j = 0; j < boxes.length; j++) {
                const ob = boxes[j];
                if (!ob || (ignoreSlotKey && ob.slotKey === ignoreSlotKey)) continue;
                const ocx = clamp(cx0, ob.x0, ob.x1);
                const ocy = clamp(cy0, ob.y0, ob.y1);
                const odx = cx0 - ocx;
                const ody = cy0 - ocy;
                if (odx * odx + ody * ody < rHull * rHull - 1e-5) return false;
              }
              return true;
            };

            if (!isClearOfAll(pushed.x, pushed.y)) {
              const xEdges = [pushed.x, -maxInsideX, maxInsideX];
              const yEdges = [pushed.y, maxInsideY];
              const cands = [];
              for (let i = 0; i < boxes.length; i++) {
                const b = boxes[i];
                if (!b || (ignoreSlotKey && b.slotKey === ignoreSlotKey)) continue;
                const bx0 = b.x0 - rHull;
                const bx1 = b.x1 + rHull;
                const by0 = b.y0 - rHull;
                const by1 = b.y1 + rHull;
                if (bx0 >= -maxInsideX - 1e-6 && bx0 <= maxInsideX + 1e-6) xEdges.push(bx0);
                if (bx1 >= -maxInsideX - 1e-6 && bx1 <= maxInsideX + 1e-6) xEdges.push(bx1);
                if (by0 <= maxInsideY + 1e-6) yEdges.push(by0);
                if (by1 <= maxInsideY + 1e-6) yEdges.push(by1);
                cands.push(
                  [bx0, pushed.y], [bx1, pushed.y], [pushed.x, by0], [pushed.x, by1],
                  [bx0, by0], [bx0, by1], [bx1, by0], [bx1, by1]
                );
              }
              for (let xi = 0; xi < xEdges.length; xi++) {
                for (let yi = 0; yi < yEdges.length; yi++) {
                  cands.push([xEdges[xi], yEdges[yi]]);
                }
              }
              let bestCand = null;
              let bestD2 = Infinity;
              for (let k = 0; k < cands.length; k++) {
                const [cx0, cy0] = cands[k];
                if (!isClearOfAll(cx0, cy0)) continue;
                const d2 = (cx0 - loc.x) * (cx0 - loc.x) + (cy0 - loc.y) * (cy0 - loc.y);
                if (d2 < bestD2) {
                  bestD2 = d2;
                  bestCand = cands[k];
                }
              }
              if (bestCand) {
                pushed.x = clamp(bestCand[0], -maxInsideX, maxInsideX);
                pushed.y = Math.min(bestCand[1], maxInsideY);
              } else {
                nx = st.x;
                ny = st.y;
                revertedToPrev = true;
              }
            }
          }

          if (!revertedToPrev && pushed.hit) {
            const wDelta = containerLocalDeltaToWorld(pushed.x - loc.x, pushed.y - loc.y, ch);
            nx += wDelta.x;
            ny += wDelta.y;
          }
        }
      }
    }

    // 4. Sample terrain & walkable container surface (ceiling_z = jackZ + 1.0 excludes container roof!)
    let surfHit = null;
    try {
      surfHit = h?.probeContainerSurface?.(nx, ny, st.z + 1.0) ?? null;
    } catch (_) {
      surfHit = null;
    }
    const terrZ = ground(nx, ny);
    let nextZ = Number.isFinite(terrZ) ? terrZ : st.z;
    let effectiveSurfHit = null;
    if (surfHit && Number.isFinite(surfHit.z) && surfHit.z <= st.z + 0.38) {
      if (!Number.isFinite(terrZ) || surfHit.z >= terrZ - 0.05) {
        const nz = surfHit.normalZ ?? surfHit.normal?.z ?? 1.0;
        if (Number.isFinite(nz) && nz < PALLET_JACK_MAX_RAMP_COS) {
          const baseTerr = Number.isFinite(terrZ) ? terrZ : st.z;
          if (surfHit.z > baseTerr + 0.02) {
            nx = st.x;
            ny = st.y;
            st.speed = 0;
            const prevTerr = ground(st.x, st.y);
            let prevSurf = null;
            try {
              prevSurf = h?.probeContainerSurface?.(st.x, st.y, st.z + 1.0) ?? null;
            } catch (_) {
              prevSurf = null;
            }
            const prevNz = prevSurf ? (prevSurf.normalZ ?? prevSurf.normal?.z ?? 1.0) : 0;
            if (
              prevSurf &&
              Number.isFinite(prevSurf.z) &&
              prevSurf.z <= st.z + 0.38 &&
              (!Number.isFinite(prevTerr) || prevSurf.z >= prevTerr - 0.05) &&
              Number.isFinite(prevNz) &&
              prevNz >= PALLET_JACK_MAX_RAMP_COS
            ) {
              nextZ = prevSurf.z;
              effectiveSurfHit = prevSurf;
            } else {
              nextZ = st.onContainer ? st.z : (Number.isFinite(prevTerr) ? prevTerr : st.z);
            }
          }
        } else {
          nextZ = surfHit.z;
          effectiveSurfHit = surfHit;
        }
      }
    }

    // 5. GMA magnetic fork engagement assist when unloaded and rolling gently near an aligned pallet
    if (!st.carriedWcid && sameZAsContainer && (nearbyC.currentDoorProgress >= 0.5 || nearbyC.last?.doorState === 2)) {
      const unload = computeReachableUnloadSlots(nearbyC.kind, nearbyC.slots);
      const targets = buildWorldSlotTargets(nearbyC, unload.reachable);
      const assist = findNearestForkEngageTarget(
        { x: nx, y: ny, heading: st.heading },
        targets,
        { forkOffset: PALLET_JACK_SPECS.cargoCenterY, maxDist: 0.80 }
      );
      if (assist && assist.canEngage && Math.abs(st.speed) > 0.05 && Math.abs(inp.steer) < 0.1) {
        const blend = clamp(stepDt * 3.5, 0, 0.25);
        st.heading = wrapHeading(st.heading + angleDiff(assist.alignedHeading, st.heading) * blend);
      }
    }

    st.x = nx;
    st.y = ny;
    st.z = nextZ;
    st.surface = detectJackSurface(effectiveSurfHit, st.z);
    st.onContainer = st.surface === "ramp" || st.surface === "floor";

    // 6. Smooth fork height & pump stroke animation
    if (Math.abs(st.targetForkHeightM - st.forkHeightM) > 1e-4) {
      const dz = clamp(st.targetForkHeightM - st.forkHeightM, -FORK_LIFT_RATE_MPS * stepDt, FORK_LIFT_RATE_MPS * stepDt);
      st.forkHeightM += dz;
    }
    if (act.pumpTimer > 0) {
      act.pumpTimer = Math.max(0, act.pumpTimer - stepDt);
    }
    const pumpStroke = act.pumpTimer > 0 ? Math.sin((act.pumpTimer / 0.35) * Math.PI) : 0;

    // 7. Update 3D jack model & entry
    const qJack = FM.orientation(st.heading, 0, 0);
    if (act.entry?.model) {
      try {
        act.entry.model.root.position.set(st.x, st.y, st.z);
        act.entry.model.root.quaternion.set(qJack[1], qJack[2], qJack[3], qJack[0]);
        act.entry.model.update({
          forkHeightM: st.forkHeightM,
          tillerAngle: st.tillerAngle,
          pumpStroke,
          carriedWcid: st.carriedWcid,
          stowed: false,
        });
      } catch (_) {}
      act.entry.worldPos = [st.x, st.y, st.z];
      act.entry.heading = st.heading;
      act.entry.tillerAngle = st.tillerAngle;
      act.entry.forkHeightM = st.forkHeightM;
    }
    writeEntity(act.guid, st.x, st.y, st.z, qJack, true);

    // 8. Lock operator avatar via setVehicleSeat + writeEntity + transition-only setMotion + 34-part arm IK
    const opPose = computeOperatorPose(st, st.tillerAngle);
    const clOp = FM.toCellLocal(opPose.x, opPose.y, opPose.z);
    try {
      const seatOk = h?.setVehicleSeat?.(act.guid, clOp.cell, clOp.x, clOp.y, clOp.z, opPose.heading);
      if (seatOk === false) {
        stop("seat-refused");
        return;
      }
    } catch (_) {}

    const qOp = FM.orientation(opPose.heading, 0, 0);
    writeEntity(me, opPose.x, opPose.y, opPose.z, qOp);

    const motionKey = st.speed > 0.12 ? "walk_fwd" : (st.speed < -0.12 ? "walk_back" : "idle");
    if (motionKey !== act.lastMotionKey) {
      act.lastMotionKey = motionKey;
      const cmd = motionKey === "walk_fwd"
        ? PALLET_JACK_MOTION.WALK
        : (motionKey === "walk_back" ? PALLET_JACK_MOTION.WALK_BACKWARDS : PALLET_JACK_MOTION.READY);
      const mSpd = motionKey === "idle" ? 1.0 : Math.max(0.4, Math.abs(st.speed));
      try { em()?.setMotion?.(me, cmd, PALLET_JACK_MOTION.NONCOMBAT, mSpd); } catch (_) {}
    }

    const opInst = em()?.entityMap?.get(me);
    if (opInst) {
      applyArmIk(opInst, st, opPose, st.tillerAngle, pumpStroke);
    }

    // 9. Update container bay slot highlight (CRITICAL: pass subSlot=null for full pallets!)
    if (nearbyC && (nearbyC.currentDoorProgress >= 0.5 || nearbyC.last?.doorState === 2)) {
      let slotIdx = null;
      let subArg = null;
      let hlState = null;

      if (st.carriedWcid) {
        const pSize = (st.carriedPalletSize === 1 || HALF_PALLET_WCIDS.has(st.carriedWcid)) ? "half" : "full";
        const load = computeReachableLoadSlots(nearbyC.kind, nearbyC.slots, pSize);
        if (load.reachable.length > 0) {
          const top = load.reachable[0];
          slotIdx = top.slotIndex;
          subArg = pSize === "half" ? top.subSlot : null;
          hlState = "target";
        } else if (load.blocked.length > 0) {
          const blk = load.blocked[0];
          slotIdx = blk.slotIndex;
          subArg = pSize === "half" ? blk.subSlot : null;
          hlState = "blocked";
        }
      } else {
        const unload = computeReachableUnloadSlots(nearbyC.kind, nearbyC.slots);
        const targets = buildWorldSlotTargets(nearbyC, unload.all);
        const near = findNearestForkEngageTarget(
          { x: st.x, y: st.y, heading: st.heading },
          targets,
          { forkOffset: PALLET_JACK_SPECS.cargoCenterY, maxDist: 1.2, maxYawRad: Math.PI, includeBlocked: true, includeMisaligned: true }
        );
        if (near) {
          slotIdx = near.target.slotIndex;
          subArg = near.target.palletSize === "half" ? near.target.subSlot : null;
          hlState = near.target.reachable === false ? "blocked" : (near.canEngage ? "target" : "reachable");
        } else if (unload.reachable.length > 0) {
          const shallow = unload.reachable[0];
          slotIdx = shallow.slotIndex;
          subArg = shallow.palletSize === "half" ? shallow.subSlot : null;
          hlState = "reachable";
        }
      }

      if (act.highlightedContainerGuid && act.highlightedContainerGuid !== nearbyC.guid) {
        clearHighlights();
      }
      if (slotIdx !== null && typeof nearbyC.model?.setHighlightedSlot === "function") {
        try {
          nearbyC.model.setHighlightedSlot(slotIdx, subArg, hlState);
          act.highlightedContainerGuid = nearbyC.guid;
        } catch (_) {}
      } else {
        clearHighlights();
      }
    } else {
      clearHighlights();
    }

    // 10. Camera + wheel roll audio + OSD
    if (act.camera && act.camera.owned) {
      const cam = computeWalkBehindCamera(st, opPose, act.viewMode, ground, stepDt, act.camState);
      try { act.camera.write(cam); } catch (_) {}
    }

    try {
      logisticsAudio?.updateWheelRoll?.(act.guid, {
        speed: Math.abs(st.speed),
        surface: st.surface,
        active: true,
        stowed: false,
        pos: [st.x, st.y, st.z],
        loaded: Boolean(st.carriedWcid),
      });
    } catch (_) {}

    osd?.palletJack?.({
      forkHeightM: st.forkHeightM,
      carriedWcid: st.carriedWcid,
      carriedPalletSize: st.carriedPalletSize,
      surface: st.surface,
      viewMode: act.viewMode,
    });

    // 11. 15 Hz throttled UpdatePose wire sync
    const tNow = nowSec(nowFn);
    if (tNow - act.lastSentAt >= POSE_SEND_INTERVAL_S) {
      act.lastSentAt = tNow;
      const clJack = FM.toCellLocal(st.x, st.y, st.z);
      const flags = (st.carriedWcid ? 0x01 : 0) | (st.onContainer ? 0x02 : 0);
      try {
        h?.vehiclePalletJackAction?.(
          act.guid,
          PALLET_JACK_ACTION.UpdatePose,
          0, 0, flags, 0,
          clJack.cell, clJack.x, clJack.y, clJack.z,
          st.heading, st.tillerAngle
        );
      } catch (_) {}
    }
  }

  return {
    isActive: () => active !== null,
    get activeGuid() { return active ? active.guid : 0; },
    get viewMode() { return active ? active.viewMode : "follow"; },
    get state() { return active ? { ...active.state } : null; },
    start,
    stop,
    release: stop,
    tick,
    onServerState,
    onTeleport() {
      if (active) stop("teleport");
    },
    dispose() {
      disposed = true;
      stop("dispose");
      try { lastControls?.dispose?.(); } catch (_) {}
      lastControls = null;
    },
  };
}
