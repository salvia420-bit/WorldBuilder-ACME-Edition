// scene3d/vehicle/warehouse_manager.js — Scriptable Intermodal Warehouse Hub Runtime & Bridge.
//
// Coordinates:
//   - Zones A-D layout (`buildDefaultHubLayout`) mounted on a single `hubRoot` inside `liveScene3d.worldRoot`
//   - 4-tier selective steel racking (`buildRackRow`), P&D Transfer Stands (`buildTransferStandGroup`),
//     Floor-to-AMR Scissor Lift Tables (`buildScissorLiftTable`), Charging Docks (`buildChargingDockGroup`),
//     and flush z=+0.004m concrete apron (`buildConcreteApron`)
//   - Autonomous Guided Forklifts (`stepAgfKinematics` + `buildAgfForklift`) & Underride AMRs (`stepAmrKinematics` + `buildAmrUnderride`)
//   - Deterministic Promise-based FIFO task queues settled purely via `tick(dt, cameraPos)` (zero `setTimeout`)
//   - 2D spatial reservation (`SpatialReservationGrid` with stopDistM=1.45 >= 1.35) + right-hand aisle lane routing
//   - Live container (`entry.slots` + `syncSlots` / `sh().vehicleContainerAction`), ground deployables, and Player Pallet Jack bridge

import {
  AGF_SPECS,
  AMR_SPECS,
  CHARGER_SPECS,
  CONTAINER_ENVELOPE_SPECS,
  LIFT_TABLE_SPECS,
  NE_FLATLAND_SITE,
  PALLET_ENVELOPE_SPECS,
  RACK_SPECS,
  STAND_SPECS,
  WAREHOUSE_WCID,
  buildDefaultHubLayout,
  computeRackSlotLocalPose,
  headingForward,
  headingRight,
  localToWorld2D,
} from "./warehouse_specs.js";
import {
  SpatialReservationGrid,
  stepAgfKinematics,
  stepAmrKinematics,
  stepLiftTable,
  wrapHeading,
  wrapPi,
} from "./warehouse_kinematics.js";
import { buildRackRow } from "./warehouse_rack_model.js";
import { buildAgfForklift } from "./agf_forklift_model.js";
import { buildAmrUnderride } from "./amr_underride_model.js";
import {
  buildChargingDockGroup,
  buildConcreteApron,
  buildScissorLiftTable,
  buildTransferStandGroup,
} from "./warehouse_infra_model.js";
import {
  PALLET_JACK_SPECS,
  findNearestForkEngageTarget,
  isSlotReachableForLoad,
  isSlotReachableForUnload,
  resolveContainerLogisticsSpec,
} from "./container_logistics.js";
import { buildDeployable, buildPallet } from "./deployable_models.js";
import { buildDeployedRadar } from "./radar_model.js";

const ALL_CARGO_WCIDS = Object.freeze([
  4000002,
  4000010,
  4000011,
  4000012,
  4000013,
  4000014,
  4000015,
  4000016,
  4000017,
]);

const CONTAINER_ACTION = Object.freeze({
  OpenDoors: 1,
  CloseDoors: 2,
  Load: 3,
  Pack: 4,
  Unpack: 5,
  UnpackAll: 6,
});

const HIGHLIGHT_COLORS = Object.freeze({
  reachable: 0x22d3ee,
  target: 0x22c55e,
  blocked: 0xef4444,
});

const AGF_CARRIED_FORK_CLEARANCE_M = 0.063;
const AGF_CARRIED_TRANSIT_FORK_Z = 0.085;
const AGF_EMPTY_TRANSIT_FORK_Z = AGF_SPECS.forkMinZ;
const AGF_HULL_CORNERS = Object.freeze([
  Object.freeze([-0.57, -1.93]),
  Object.freeze([0.57, -1.93]),
  Object.freeze([-0.57, 0.15]),
  Object.freeze([0.57, 0.15]),
  Object.freeze([-0.34, 1.30]),
  Object.freeze([0.34, 1.30]),
]);
const DEFAULT_GRID_OPTS = Object.freeze({
  cellSizeM: 1.0,
  stopDistM: 1.45,
  slowDistM: 2.6,
  defaultRadiusM: 0.65,
});

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function finiteOr(v, fb) {
  return typeof v === "number" && Number.isFinite(v) ? v : fb;
}

function containerWorldPos(cEntry) {
  const p = cEntry?.model?.root?.position;
  if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) {
    return [p.x, p.y, Number.isFinite(p.z) ? p.z : 0];
  }
  const rp = cEntry?.rawPos;
  if (Array.isArray(rp) && rp.length >= 3) {
    return [finiteOr(rp[0], 0), finiteOr(rp[1], 0), finiteOr(rp[2], 0)];
  }
  return [0, 0, 0];
}

function isContainerTrailerMounted(cEntry) {
  if (!cEntry) return false;
  if (cEntry.mountedOnTrailerGuid && (cEntry.mountedOnTrailerGuid >>> 0) !== 0) return true;
  const pos = containerWorldPos(cEntry);
  return pos[2] > 0.5;
}

function isContainerDoorOpen(cEntry) {
  if (!cEntry) return false;
  if (Number.isFinite(cEntry.currentDoorProgress)) return cEntry.currentDoorProgress >= 0.5;
  if (Number.isFinite(cEntry.last?.doorProgress)) return cEntry.last.doorProgress >= 0.5;
  if (cEntry.last?.doorState === 2) return true;
  if (Number.isFinite(cEntry.targetDoorProgress)) return cEntry.targetDoorProgress >= 0.5;
  return false;
}

function worldToLocalPoint(wx, wy, cx, cy, heading = 0) {
  const dx = wx - cx;
  const dy = wy - cy;
  const c = Math.cos(heading);
  const s = Math.sin(heading);
  return {
    x: dx * c - dy * s,
    y: dx * s + dy * c,
  };
}

function resolveContainerEnvelopeSpec(cEntry) {
  const wcid = cEntry?.wcid ?? (cEntry?.kind === 10 ? 4000020 : cEntry?.kind === 12 ? 4000022 : cEntry?.kind === 11 ? 4000021 : 0);
  const env = CONTAINER_ENVELOPE_SPECS[wcid];
  if (env) {
    return { halfExtW: env.extW * 0.5, halfExtL: env.extL * 0.5 };
  }
  const spec = resolveContainerLogisticsSpec(cEntry?.kind);
  return {
    halfExtW: (spec?.interior?.halfW ?? 1.176) + 0.043,
    halfExtL: (spec?.interior?.halfL ?? 6.016) + 0.080,
  };
}

function mountStowedCargoModel(THREE, wcid, csmState) {
  if (!THREE || !wcid) return null;
  if (wcid === 4000002) {
    return buildDeployedRadar(THREE, { csmState, stowed: true });
  }
  if (wcid >= 4000010 && wcid <= 4000017) {
    return buildDeployable(THREE, wcid, { csmState, stowed: true });
  }
  return buildPallet(THREE, "standard", { csmState });
}

function disposeObjectSubtree(root) {
  if (!root) return;
  const geoms = new Set();
  const mats = new Set();
  if (typeof root.traverse === "function") {
    root.traverse((o) => {
      if (o.geometry) geoms.add(o.geometry);
      const ml = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
      for (const m of ml) {
        if (m) mats.add(m);
      }
      if (o.isInstancedMesh && typeof o.dispose === "function") {
        try { o.dispose(); } catch (_) {}
      }
    });
  }
  for (const g of geoms) {
    try { g.dispose?.(); } catch (_) {}
  }
  for (const m of mats) {
    try { m.dispose?.(); } catch (_) {}
  }
}

function segmentIntersectsAabb2D(ax, ay, bx, by, box, pad = 0) {
  const minX = box.x0 - pad;
  const maxX = box.x1 + pad;
  const minY = box.y0 - pad;
  const maxY = box.y1 + pad;
  const dx = bx - ax;
  const dy = by - ay;
  let t0 = 0;
  let t1 = 1;
  const checks = [
    [-dx, ax - minX],
    [dx, maxX - ax],
    [-dy, ay - minY],
    [dy, maxY - ay],
  ];
  for (let i = 0; i < 4; i++) {
    const p = checks[i][0];
    const q = checks[i][1];
    if (Math.abs(p) < 1e-9) {
      if (q < 0) return false;
    } else {
      const r = q / p;
      if (p < 0) {
        if (r > t1) return false;
        if (r > t0) t0 = r;
      } else {
        if (r < t0) return false;
        if (r < t1) t1 = r;
      }
    }
  }
  return t0 <= t1;
}

function pointToObstacleDist(px, py, b) {
  if (b.obb) {
    const o = b.obb;
    const lp = worldToLocalPoint(px, py, o.cx, o.cy, o.heading);
    const cx = clamp(lp.x, -o.halfW, o.halfW);
    const cy = clamp(lp.y, -o.halfL, o.halfL);
    return Math.hypot(lp.x - cx, lp.y - cy);
  }
  const cx = clamp(px, b.x0, b.x1);
  const cy = clamp(py, b.y0, b.y1);
  return Math.hypot(px - cx, py - cy);
}

function segmentIntersectsObstacle2D(ax, ay, bx, by, b, pad = 0) {
  if (b.obb) {
    const o = b.obb;
    const la = worldToLocalPoint(ax, ay, o.cx, o.cy, o.heading);
    const lb = worldToLocalPoint(bx, by, o.cx, o.cy, o.heading);
    return segmentIntersectsAabb2D(
      la.x, la.y, lb.x, lb.y,
      { x0: -o.halfW, x1: o.halfW, y0: -o.halfL, y1: o.halfL },
      pad,
    );
  }
  return segmentIntersectsAabb2D(ax, ay, bx, by, b, pad);
}

function pointToSegDist2D(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  if (l2 <= 1e-9) return Math.hypot(px - ax, py - ay);
  const t = clamp(((px - ax) * dx + (py - ay) * dy) / l2, 0, 1);
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

const AMR_HALF_W = AMR_SPECS.widthM * 0.5;
const AMR_HALF_L = AMR_SPECS.lengthM * 0.5;
const AMR_STAND_RADIUS = Math.hypot(AMR_HALF_W, AMR_HALF_L) + 0.01;

function satOverlap2D(ax, ay, ah, ahw, ahl, bx, by, bh, bhw, bhl) {
  const aUx = Math.cos(ah);
  const aUy = -Math.sin(ah);
  const aVx = Math.sin(ah);
  const aVy = Math.cos(ah);
  const bUx = Math.cos(bh);
  const bUy = -Math.sin(bh);
  const bVx = Math.sin(bh);
  const bVy = Math.cos(bh);
  const dx = bx - ax;
  const dy = by - ay;
  const axes = [
    [aUx, aUy],
    [aVx, aVy],
    [bUx, bUy],
    [bVx, bVy],
  ];
  for (let i = 0; i < 4; i++) {
    const nx = axes[i][0];
    const ny = axes[i][1];
    const dist = Math.abs(dx * nx + dy * ny);
    const rA = ahw * Math.abs(aUx * nx + aUy * ny) + ahl * Math.abs(aVx * nx + aVy * ny);
    const rB = bhw * Math.abs(bUx * nx + bUy * ny) + bhl * Math.abs(bVx * nx + bVy * ny);
    if (dist >= rA + rB - 1e-4) return false;
  }
  return true;
}

const AMR_PALLET_HALF_W = 0.55;
const AMR_PALLET_HALF_L = 0.55;
const AMR_PALLET_RADIUS = Math.hypot(AMR_PALLET_HALF_W, AMR_PALLET_HALF_L);

function isAmrPoseClear(
  wx,
  wy,
  heading,
  obstacles,
  margin = 0.004,
  ignoreId = null,
  carriedWcid = 0,
  turntableYawRad = 0,
  liftHeightM = AMR_SPECS.loweredHeightM,
) {
  const hw = AMR_HALF_W + margin;
  const hl = AMR_HALF_L + margin;
  const hasPallet = Boolean(carriedWcid);
  const ph = hasPallet ? wrapHeading(heading + (turntableYawRad || 0)) : 0;
  const phw = AMR_PALLET_HALF_W + margin;
  const phl = AMR_PALLET_HALF_L + margin;
  const palletAboveStand = hasPallet && finiteOr(liftHeightM, AMR_SPECS.loweredHeightM) > STAND_SPECS.railHeightM + 0.005;
  const hasIgnore = ignoreId !== null && ignoreId !== undefined;
  const ignoreNum = typeof ignoreId === "number" ? (ignoreId >>> 0) : null;
  for (let i = 0; i < obstacles.length; i++) {
    const b = obstacles[i];
    if (!b) continue;
    if (hasIgnore && (b.id === ignoreId || (ignoreNum !== null && typeof b.id === "number" && (b.id >>> 0) === ignoreNum))) {
      continue;
    }
    const checkPallet = hasPallet && !(palletAboveStand && (b.kind === "stand" || b.kind === "liftTable"));
    if (b.obb) {
      if (satOverlap2D(wx, wy, heading, hw, hl, b.obb.cx, b.obb.cy, b.obb.heading, b.obb.halfW, b.obb.halfL)) {
        return false;
      }
      if (checkPallet && satOverlap2D(wx, wy, ph, phw, phl, b.obb.cx, b.obb.cy, b.obb.heading, b.obb.halfW, b.obb.halfL)) {
        return false;
      }
    } else {
      const bcx = (b.x0 + b.x1) * 0.5;
      const bcy = (b.y0 + b.y1) * 0.5;
      const bhw = (b.x1 - b.x0) * 0.5;
      const bhl = (b.y1 - b.y0) * 0.5;
      if (satOverlap2D(wx, wy, heading, hw, hl, bcx, bcy, 0, bhw, bhl)) {
        return false;
      }
      if (checkPallet && satOverlap2D(wx, wy, ph, phw, phl, bcx, bcy, 0, bhw, bhl)) {
        return false;
      }
    }
  }
  return true;
}

function isAmrSweptClear(
  ax,
  ay,
  bx,
  by,
  heading,
  obstacles,
  margin = 0.004,
  ignoreId = null,
  carriedWcid = 0,
  turntableYawRad = 0,
  liftHeightM = AMR_SPECS.loweredHeightM,
) {
  const dist = Math.hypot(bx - ax, by - ay);
  const steps = Math.max(4, Math.ceil(dist / 0.08));
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const x = ax + (bx - ax) * t;
    const y = ay + (by - ay) * t;
    if (!isAmrPoseClear(x, y, heading, obstacles, margin, ignoreId, carriedWcid, turntableYawRad, liftHeightM)) return false;
  }
  return true;
}

const OBS_META_CACHE = new WeakMap();
const EMPTY_ARC_CTX = Object.freeze({});
const AGF_CORNER_LX = new Float64Array([-0.57, 0.57, -0.57, 0.57, -0.34, 0.34]);
const AGF_CORNER_LY = new Float64Array([-1.93, -1.93, 0.15, 0.15, 1.30, 1.30]);

function buildObsMeta(obstacles) {
  if (!Array.isArray(obstacles)) return [];
  let cached = OBS_META_CACHE.get(obstacles);
  if (cached) return cached;
  const n = obstacles.length;
  const meta = new Array(n);
  for (let i = 0; i < n; i++) {
    const b = obstacles[i];
    if (!b) { meta[i] = null; continue; }
    if (b.obb) {
      const o = b.obb;
      const c = Math.cos(o.heading);
      const s = Math.sin(o.heading);
      const ac = Math.abs(c);
      const asv = Math.abs(s);
      const rx = o.halfW * ac + o.halfL * asv;
      const ry = o.halfW * asv + o.halfL * ac;
      const rawHw = finiteOr(o.rawHalfW, o.halfW);
      const rawHl = finiteOr(o.rawHalfL, o.halfL);
      const hasRawBounds = rawHw < o.halfW - 1e-6 || rawHl < o.halfL - 1e-6;
      const obMaxZ = finiteOr(
        b.maxZ,
        b.kind === "rack"
          ? RACK_SPECS.uprightHeightM
          : (b.kind === "stand" || b.kind === "liftTable")
            ? STAND_SPECS.railHeightM
            : b.kind === "charger"
              ? CHARGER_SPECS.heightM
              : b.kind === "container"
                ? 2.896
                : Infinity,
      );
      let rawMeta = null;
      if (hasRawBounds) {
        const rawRx = rawHw * ac + rawHl * asv;
        const rawRy = rawHw * asv + rawHl * ac;
        rawMeta = {
          isObb: true,
          id: b.id,
          cx: o.cx,
          cy: o.cy,
          h: o.heading,
          hw: rawHw,
          hl: rawHl,
          uX: c,
          uY: -s,
          vX: s,
          vY: c,
          minX: o.cx - rawRx,
          maxX: o.cx + rawRx,
          minY: o.cy - rawRy,
          maxY: o.cy + rawRy,
          kind: b.kind,
          maxZ: obMaxZ,
        };
      }
      meta[i] = {
        isObb: true,
        id: b.id,
        cx: o.cx,
        cy: o.cy,
        h: o.heading,
        hw: o.halfW,
        hl: o.halfL,
        uX: c,
        uY: -s,
        vX: s,
        vY: c,
        minX: o.cx - rx,
        maxX: o.cx + rx,
        minY: o.cy - ry,
        maxY: o.cy + ry,
        kind: b.kind,
        maxZ: obMaxZ,
        rawMeta,
      };
    } else {
      const obMaxZ = finiteOr(
        b.maxZ,
        b.kind === "rack"
          ? RACK_SPECS.uprightHeightM
          : (b.kind === "stand" || b.kind === "liftTable")
            ? STAND_SPECS.railHeightM
            : b.kind === "charger"
              ? CHARGER_SPECS.heightM
              : b.kind === "container"
                ? 2.896
                : Infinity,
      );
      meta[i] = {
        isObb: false,
        id: b.id,
        cx: (b.x0 + b.x1) * 0.5,
        cy: (b.y0 + b.y1) * 0.5,
        h: 0,
        hw: (b.x1 - b.x0) * 0.5,
        hl: (b.y1 - b.y0) * 0.5,
        uX: 1,
        uY: 0,
        vX: 0,
        vY: 1,
        minX: b.x0,
        maxX: b.x1,
        minY: b.y0,
        maxY: b.y1,
        kind: b.kind,
        maxZ: obMaxZ,
      };
    }
  }
  OBS_META_CACHE.set(obstacles, meta);
  return meta;
}

function pointToMetaDist(px, py, m) {
  if (!m.isObb) {
    const dx = px < m.minX ? m.minX - px : (px > m.maxX ? px - m.maxX : 0);
    const dy = py < m.minY ? m.minY - py : (py > m.maxY ? py - m.maxY : 0);
    return Math.hypot(dx, dy);
  }
  const dx = px - m.cx;
  const dy = py - m.cy;
  const lx = dx * m.uX + dy * m.uY;
  const ly = dx * m.vX + dy * m.vY;
  const clx = lx < -m.hw ? -m.hw : (lx > m.hw ? m.hw : lx);
  const cly = ly < -m.hl ? -m.hl : (ly > m.hl ? m.hl : ly);
  return Math.hypot(lx - clx, ly - cly);
}

function satOverlap2DPre(ax, ay, aUx, aUy, aVx, aVy, ahw, ahl, ob) {
  const dx = ob.cx - ax;
  const dy = ob.cy - ay;
  const bUx = ob.uX;
  const bUy = ob.uY;
  const bVx = ob.vX;
  const bVy = ob.vY;
  const bhw = ob.hw;
  const bhl = ob.hl;
  const dotAU_BU = Math.abs(aUx * bUx + aUy * bUy);
  const dotAU_BV = Math.abs(aUx * bVx + aUy * bVy);
  if (Math.abs(dx * aUx + dy * aUy) >= ahw + bhw * dotAU_BU + bhl * dotAU_BV - 1e-4) return false;
  const dotAV_BU = Math.abs(aVx * bUx + aVy * bUy);
  const dotAV_BV = Math.abs(aVx * bVx + aVy * bVy);
  if (Math.abs(dx * aVx + dy * aVy) >= ahl + bhw * dotAV_BU + bhl * dotAV_BV - 1e-4) return false;
  if (Math.abs(dx * bUx + dy * bUy) >= ahw * dotAU_BU + ahl * dotAV_BU + bhw - 1e-4) return false;
  if (Math.abs(dx * bVx + dy * bVy) >= ahw * dotAU_BV + ahl * dotAV_BV + bhl - 1e-4) return false;
  return true;
}

function isAgfPoseObbClear(
  wx,
  wy,
  heading,
  obstacles,
  margin = 0.002,
  obsMetaPre = null,
  carriedWcid = 0,
  forkHeightM = AGF_EMPTY_TRANSIT_FORK_Z,
  ignoreId = null,
) {
  const meta = obsMetaPre || buildObsMeta(obstacles);
  const s = Math.sin(heading);
  const c = Math.cos(heading);
  const chX = wx - 0.89 * s;
  const chY = wy - 0.89 * c;
  const fkX = wx + 0.725 * s;
  const fkY = wy + 0.725 * c;
  const hasPallet = Boolean(carriedWcid);
  const palX = hasPallet ? wx + AGF_SPECS.cargoCenterY * s : 0;
  const palY = hasPallet ? wy + AGF_SPECS.cargoCenterY * c : 0;
  const palZ = finiteOr(forkHeightM, hasPallet ? AGF_CARRIED_TRANSIT_FORK_Z : AGF_EMPTY_TRANSIT_FORK_Z);
  const aUx = c;
  const aUy = -s;
  const aVx = s;
  const aVy = c;
  const chHw = 0.57 + margin;
  const chHl = 1.04 + margin;
  const fkHw = 0.34 + margin;
  const fkHl = 0.575 + margin;
  const palHw = 0.55 + margin;
  const palHl = 0.55 + margin;
  const boundR = 2.02 + margin;
  const hasIgnore = ignoreId !== null && ignoreId !== undefined;
  const ignoreNum = typeof ignoreId === "number" ? (ignoreId >>> 0) : null;
  for (let i = 0; i < meta.length; i++) {
    const ob = meta[i];
    if (!ob) continue;
    if (hasIgnore && (ob.id === ignoreId || (ignoreNum !== null && typeof ob.id === "number" && (ob.id >>> 0) === ignoreNum))) {
      continue;
    }
    if (wx + boundR < ob.minX || wx - boundR > ob.maxX || wy + boundR < ob.minY || wy - boundR > ob.maxY) continue;
    if (satOverlap2DPre(chX, chY, aUx, aUy, aVx, aVy, chHw, chHl, ob)) return false;
    if (satOverlap2DPre(fkX, fkY, aUx, aUy, aVx, aVy, fkHw, fkHl, ob)) return false;
    if (
      hasPallet &&
      palZ <= (ob.maxZ ?? Infinity) + 0.005
    ) {
      const palOb = (ob.kind === "container" && ob.rawMeta) ? ob.rawMeta : ob;
      const palExtra = (ob.kind === "container" && ob.rawMeta) ? 0.004 : 0;
      if (satOverlap2DPre(palX, palY, aUx, aUy, aVx, aVy, palHw + palExtra, palHl + palExtra, palOb)) {
        return false;
      }
    }
  }
  return true;
}

function closestPointOnObstacle2D(px, py, b) {
  if (b.obb) {
    const o = b.obb;
    const lp = worldToLocalPoint(px, py, o.cx, o.cy, o.heading);
    const lx = clamp(lp.x, -o.halfW, o.halfW);
    const ly = clamp(lp.y, -o.halfL, o.halfL);
    const [wx, wy] = localToWorld2D(lx, ly, o.cx, o.cy, o.heading);
    return { x: wx, y: wy, d: Math.hypot(lp.x - lx, lp.y - ly) };
  }
  const cx = clamp(px, b.x0, b.x1);
  const cy = clamp(py, b.y0, b.y1);
  return { x: cx, y: cy, d: Math.hypot(px - cx, py - cy) };
}

export function createWarehouseManager(deps = {}) {
  const THREE = deps.THREE ?? null;
  const liveScene3d = deps.liveScene3d ?? null;
  const containers = deps.containers ?? new Map();
  const deployables = deps.deployables ?? new Map();
  const palletJacks = deps.palletJacks ?? new Map();
  const trailers = deps.trailers ?? new Map();
  const logisticsAudio = deps.logisticsAudio ?? null;
  const sh = typeof deps.sh === "function"
    ? deps.sh
    : () => liveScene3d?.sessionHandle ?? null;

  let disposed = false;
  let built = false;
  let layout = null;
  let hubRoot = null;
  let apronModel = null;
  let standGroup = null;
  let chargerGroup = null;
  let nextOwnedDeployableId = 1;

  const grid = new SpatialReservationGrid(DEFAULT_GRID_OPTS);
  const racks = new Map();
  const stands = new Map();
  const liftTables = new Map();
  const chargers = new Map();
  const stagingBays = new Map();
  const agfEntries = new Map();
  const amrEntries = new Map();
  const agfs = new Map();
  const amrs = new Map();
  const ownedDeployableGuids = new Set();

  let playerJackPose = null;
  let highlightedLiftTableId = null;
  let highlightedStagingBayId = null;

  let activeScenario = null; // { name, stopped, resolve, reject, state }
  let simTimeSec = 0;
  let tickCount = 0;

  function csmStateOf() {
    return liveScene3d?.csmState ?? null;
  }

  function worldRootOf() {
    return liveScene3d?.worldRoot ?? null;
  }

  function ensureHubRoot() {
    if (!THREE) return null;
    if (!hubRoot) {
      hubRoot = new THREE.Group();
      hubRoot.name = "WarehouseHubRoot";
    }
    const wr = worldRootOf();
    if (wr && hubRoot.parent !== wr) {
      wr.add(hubRoot);
    }
    return hubRoot;
  }

  function detachHubRoot() {
    if (hubRoot && hubRoot.parent) {
      hubRoot.parent.remove(hubRoot);
    }
    hubRoot = null;
  }

  function rejectPendingList(list, reason) {
    if (!Array.isArray(list)) return;
    const err = reason instanceof Error ? reason : new Error(String(reason));
    while (list.length > 0) {
      const item = list.shift();
      try { item?.reject?.(err); } catch (_) {}
    }
  }

  function getStaticObstacles(opts = {}) {
    const boxes = [];
    for (const r of racks.values()) {
      const b = r.worldBounds;
      if (b) boxes.push({ x0: b.minX, x1: b.maxX, y0: b.minY, y1: b.maxY, kind: "rack", id: r.id, maxZ: RACK_SPECS.uprightHeightM });
    }
    if (opts.includeStands !== false) {
      for (const st of stands.values()) {
        const hw = STAND_SPECS.outerWidthM * 0.5;
        const hd = STAND_SPECS.outerDepthM * 0.5;
        if (Math.abs(Math.sin(st.heading)) > 0.7) {
          boxes.push({ x0: st.pos[0] - hd, x1: st.pos[0] + hd, y0: st.pos[1] - hw, y1: st.pos[1] + hw, kind: "stand", id: st.id, maxZ: STAND_SPECS.railHeightM });
        } else {
          boxes.push({ x0: st.pos[0] - hw, x1: st.pos[0] + hw, y0: st.pos[1] - hd, y1: st.pos[1] + hd, kind: "stand", id: st.id, maxZ: STAND_SPECS.railHeightM });
        }
      }
    }
    if (opts.includeLiftTables !== false) {
      for (const lt of liftTables.values()) {
        const hw = LIFT_TABLE_SPECS.outerWidthM * 0.5;
        const hd = LIFT_TABLE_SPECS.outerDepthM * 0.5;
        boxes.push({
          x0: lt.x - hw,
          x1: lt.x + hw,
          y0: lt.y - hd,
          y1: lt.y + hd,
          kind: "liftTable",
          id: lt.id,
          maxZ: LIFT_TABLE_SPECS.raisedZ,
        });
      }
    }
    if (opts.includeChargers !== false) {
      for (const ch of chargers.values()) {
        const cw = finiteOr(CHARGER_SPECS.widthM, 1.24);
        const cd = finiteOr(CHARGER_SPECS.depthM, 0.90);
        boxes.push({
          x0: ch.pos[0] - cw * 0.5,
          x1: ch.pos[0] + cw * 0.5,
          y0: ch.pos[1] - cd * 0.5,
          y1: ch.pos[1] + cd * 0.5,
          kind: "charger",
          id: ch.id,
          maxZ: finiteOr(CHARGER_SPECS.heightM, 0.65),
        });
      }
    }
    if (opts.includeContainers !== false) {
      const ignoreGuid = opts.ignoreContainerGuid != null ? (opts.ignoreContainerGuid >>> 0) : null;
      for (const cEntry of containers.values()) {
        const cGuid = cEntry.guid >>> 0;
        if (ignoreGuid !== null && cGuid === ignoreGuid) continue;
        const spec = resolveContainerLogisticsSpec(cEntry.kind);
        if (!spec) continue;
        const env = resolveContainerEnvelopeSpec(cEntry);
        const wcid = cEntry?.wcid ?? (cEntry?.kind === 10 ? 4000020 : cEntry?.kind === 12 ? 4000022 : cEntry?.kind === 11 ? 4000021 : 0);
        const roofZ = finiteOr(CONTAINER_ENVELOPE_SPECS[wcid]?.roofZ, 2.896);
        const pos = containerWorldPos(cEntry);
        const h = cEntry.heading || 0;
        const hw = env.halfExtW + 0.04;
        const hl = env.halfExtL + 0.04;
        const ch = Math.abs(Math.cos(h));
        const shv = Math.abs(Math.sin(h));
        const rx = hw * ch + hl * shv;
        const ry = hw * shv + hl * ch;
        boxes.push({
          x0: pos[0] - rx,
          x1: pos[0] + rx,
          y0: pos[1] - ry,
          y1: pos[1] + ry,
          kind: "container",
          id: cGuid,
          maxZ: roofZ,
          obb: { cx: pos[0], cy: pos[1], heading: h, halfW: hw, halfL: hl, rawHalfW: env.halfExtW, rawHalfL: env.halfExtL },
        });
      }
    }
    return boxes;
  }

  function minDistanceToObstacles(px, py, obstacles, ignoreId = null) {
    let minDist = Infinity;
    const hasIgnore = ignoreId !== null && ignoreId !== undefined;
    const ignoreNum = typeof ignoreId === "number" ? (ignoreId >>> 0) : null;
    for (let i = 0; i < obstacles.length; i++) {
      const b = obstacles[i];
      if (!b) continue;
      if (hasIgnore && (b.id === ignoreId || (ignoreNum !== null && typeof b.id === "number" && (b.id >>> 0) === ignoreNum))) {
        continue;
      }
      const d = pointToObstacleDist(px, py, b);
      if (d < minDist) minDist = d;
    }
    return minDist;
  }

  function resolveStaticObstaclePushout(wx, wy, radius, obstacles, ignoreId = null, standRadius = 0, overrideObsId = null, overrideObsR = 0) {
    if (!Array.isArray(obstacles) || obstacles.length === 0) {
      return { x: wx, y: wy, hit: false, hitBox: null };
    }
    const r = Math.max(0.05, finiteOr(radius, 0.5));
    const sr = standRadius > 0 ? Math.max(r, finiteOr(standRadius, r)) : 0;
    const hasIgnore = ignoreId !== null && ignoreId !== undefined;
    const ignoreNum = typeof ignoreId === "number" ? (ignoreId >>> 0) : null;
    const hasOverride = overrideObsId !== null && overrideObsId !== undefined && overrideObsR > 0;
    const overrideNum = typeof overrideObsId === "number" ? (overrideObsId >>> 0) : null;
    let x = wx;
    let y = wy;
    let hit = false;
    let hitBox = null;

    for (let pass = 0; pass < 3; pass++) {
      let any = false;
      for (let i = 0; i < obstacles.length; i++) {
        const b = obstacles[i];
        if (!b || (b.kind !== "rack" && b.kind !== "charger" && b.kind !== "container" && b.kind !== "liftTable" && !(sr > 0 && b.kind === "stand"))) continue;
        if (hasIgnore && (b.id === ignoreId || (ignoreNum !== null && typeof b.id === "number" && (b.id >>> 0) === ignoreNum))) {
          continue;
        }
        const isOverridden = hasOverride && (b.id === overrideObsId || (overrideNum !== null && typeof b.id === "number" && (b.id >>> 0) === overrideNum));
        const boxR = isOverridden
          ? overrideObsR
          : ((b.kind === "stand" || b.kind === "liftTable") ? (sr > 0 ? sr : r) : r);
        if (b.obb) {
          const o = b.obb;
          const lp = worldToLocalPoint(x, y, o.cx, o.cy, o.heading);
          const cx = clamp(lp.x, -o.halfW, o.halfW);
          const cy = clamp(lp.y, -o.halfL, o.halfL);
          const ldx = lp.x - cx;
          const ldy = lp.y - cy;
          const d2 = ldx * ldx + ldy * ldy;
          if (d2 >= boxR * boxR) continue;
          any = true;
          hit = true;
          if (!hitBox) hitBox = b;
          let nlx = lp.x;
          let nly = lp.y;
          if (d2 > 1e-9) {
            const d = Math.sqrt(d2);
            const push = boxR - d;
            nlx += (ldx / d) * push;
            nly += (ldy / d) * push;
          } else {
            const dLeft = Math.abs(lp.x - (-o.halfW));
            const dRight = Math.abs(o.halfW - lp.x);
            const dBot = Math.abs(lp.y - (-o.halfL));
            const dTop = Math.abs(o.halfL - lp.y);
            const m = Math.min(dLeft, dRight, dBot, dTop);
            if (m === dLeft) nlx = -o.halfW - boxR;
            else if (m === dRight) nlx = o.halfW + boxR;
            else if (m === dBot) nly = -o.halfL - boxR;
            else nly = o.halfL + boxR;
          }
          const [wxOut, wyOut] = localToWorld2D(nlx, nly, o.cx, o.cy, o.heading);
          x = wxOut;
          y = wyOut;
          continue;
        }
        const cx = clamp(x, b.x0, b.x1);
        const cy = clamp(y, b.y0, b.y1);
        const dx = x - cx;
        const dy = y - cy;
        const d2 = dx * dx + dy * dy;
        if (d2 >= boxR * boxR) continue;

        any = true;
        hit = true;
        if (!hitBox) hitBox = b;
        if (d2 > 1e-9) {
          const d = Math.sqrt(d2);
          const push = boxR - d;
          x += (dx / d) * push;
          y += (dy / d) * push;
        } else {
          const dLeft = Math.abs(x - b.x0);
          const dRight = Math.abs(b.x1 - x);
          const dBot = Math.abs(y - b.y0);
          const dTop = Math.abs(b.y1 - y);
          const m = Math.min(dLeft, dRight, dBot, dTop);
          if (m === dLeft) x = b.x0 - boxR;
          else if (m === dRight) x = b.x1 + boxR;
          else if (m === dBot) y = b.y0 - boxR;
          else y = b.y1 + boxR;
        }
      }
      if (!any) break;
    }

    return { x, y, hit, hitBox };
  }

  function maybeInsertCornerBypass(st, item, cmd, wpIdx, pushOut, selfRadius, obstacles) {
    if (!pushOut?.hit || !pushOut.hitBox || !item?.data || !Array.isArray(cmd?.waypoints)) return false;
    if (item.phase !== "drive" && item.phase !== "route") return false;
    const b = pushOut.hitBox;
    const curWp = cmd.waypoints[wpIdx];
    if (!curWp || curWp._cornerBypassFor === b.id || curWp._directSeg) return false;
    const checkPad = (b.kind === "stand" || b.kind === "liftTable") ? Math.max(selfRadius, 0.66) : selfRadius * 0.5;
    if (wpIdx === cmd.waypoints.length - 1 && pointToObstacleDist(curWp.x, curWp.y, b) <= Math.max(selfRadius + 0.18, checkPad + 0.05)) {
      return false;
    }
    if (!segmentIntersectsObstacle2D(st.x, st.y, curWp.x, curWp.y, b, checkPad)) return false;

    const m = (b.kind === "stand" || b.kind === "liftTable") ? Math.max(selfRadius + 0.16, 0.72) : selfRadius + 0.16;
    let nw, ne, sw, se;
    if (b.obb) {
      const o = b.obb;
      const [nwx, nwy] = localToWorld2D(-o.halfW - m, o.halfL + m, o.cx, o.cy, o.heading);
      const [nex, ney] = localToWorld2D(o.halfW + m, o.halfL + m, o.cx, o.cy, o.heading);
      const [swx, swy] = localToWorld2D(-o.halfW - m, -o.halfL - m, o.cx, o.cy, o.heading);
      const [sex, sey] = localToWorld2D(o.halfW + m, -o.halfL - m, o.cx, o.cy, o.heading);
      nw = { x: nwx, y: nwy };
      ne = { x: nex, y: ney };
      sw = { x: swx, y: swy };
      se = { x: sex, y: sey };
    } else {
      nw = { x: b.x0 - m, y: b.y1 + m };
      ne = { x: b.x1 + m, y: b.y1 + m };
      sw = { x: b.x0 - m, y: b.y0 - m };
      se = { x: b.x1 + m, y: b.y0 - m };
    }
    const seqs = [
      [nw], [ne], [sw], [se],
      [nw, sw], [sw, nw], [ne, se], [se, ne],
      [nw, ne], [ne, nw], [sw, se], [se, sw],
    ];
    const isAmr = selfRadius <= 0.58;
    const agfStartDist = !isAmr ? minDistanceToObstacles(st.x, st.y, obstacles) : 0;
    const agfArcMinClear = !isAmr ? Math.min(selfRadius, agfStartDist) : selfRadius;
    if (!isAmr) {
      const curTail = cmd.waypoints.slice(wpIdx, wpIdx + 3);
      if (isAgfArcClear(st, curTail, obstacles, agfArcMinClear, agfStartDist, {
        maxSteps: 180,
        checkSatObb: true,
        initSpeed: st.speed,
      })) {
        return false;
      }
    }
    const cornerClearMin = isAmr ? selfRadius + 0.12 : selfRadius + 0.10;
    let best = null;
    let bestScore = Infinity;
    for (let i = 0; i < seqs.length; i++) {
      const seq = seqs[i];
      let ok = minDistanceToObstacles(seq[0].x, seq[0].y, obstacles) >= cornerClearMin &&
        !segmentIntersectsObstacle2D(st.x, st.y, seq[0].x, seq[0].y, b, selfRadius * 0.5);
      if (ok && seq.length === 2) {
        ok = minDistanceToObstacles(seq[1].x, seq[1].y, obstacles) >= cornerClearMin &&
          !segmentIntersectsObstacle2D(seq[0].x, seq[0].y, seq[1].x, seq[1].y, b, selfRadius + 0.02);
      }
      if (!ok) continue;
      const last = seq[seq.length - 1];
      if (segmentIntersectsObstacle2D(last.x, last.y, curWp.x, curWp.y, b, checkPad * 0.85)) continue;
      if (isAmr) {
        let hitsNearbyGap = false;
        for (let oi = 0; oi < obstacles.length; oi++) {
          const ob = obstacles[oi];
          if (!ob || ob === b) continue;
          if (pointToObstacleDist(last.x, last.y, ob) <= 2.2 && segmentIntersectsObstacle2D(last.x, last.y, curWp.x, curWp.y, ob, selfRadius + 0.06)) {
            hitsNearbyGap = true;
            break;
          }
        }
        if (hitsNearbyGap) continue;
      } else {
        const candTail = [
          ...seq.map((p) => ({ x: p.x, y: p.y, skipTol: 0.45, _cornerBypassFor: b.id })),
          ...cmd.waypoints.slice(wpIdx, wpIdx + 2),
        ];
        if (!isAgfArcClear(st, candTail, obstacles, agfArcMinClear, agfStartDist, {
          maxSteps: 180,
          checkSatObb: true,
          initSpeed: st.speed,
        })) {
          continue;
        }
      }
      let len = Math.hypot(seq[0].x - st.x, seq[0].y - st.y);
      if (seq.length === 2) len += Math.hypot(seq[1].x - seq[0].x, seq[1].y - seq[0].y);
      len += Math.hypot(curWp.x - last.x, curWp.y - last.y);
      // Small preference for paths whose exit segment also avoids other racks/chargers
      if (!pathIsClear(last.x, last.y, curWp.x, curWp.y, obstacles, selfRadius)) len += isAmr ? 60.0 : 6.0;
      if (len < bestScore) {
        bestScore = len;
        best = seq;
      }
    }
    if (!best) return false;
    const inserted = best.map((p) => ({ x: p.x, y: p.y, skipTol: 0.45, _cornerBypassFor: b.id }));
    const tail = cmd.waypoints.slice(wpIdx);
    const nextWps = [...inserted, ...tail];
    if (item.task?.type === "driveTo") item.data.waypoints = nextWps;
    else if (item.phase === "route") item.data.route = nextWps;
    item.data.waypointIndex = 0;
    return true;
  }

  function routeAroundSolidObstacles(st, wps, selfRadius, mode, opts = {}) {
    if (!Array.isArray(wps) || wps.length === 0) return wps;
    if (wps.length > 1) {
      if (mode === "agf") {
        const staticObs = getStaticObstacles();
        const carriedWcid = st.carriedWcid ?? 0;
        const loaded = Boolean(st.loaded || carriedWcid);
        const coalesceShortAgfDriveWps = (rawList, minGapM = 0.30) => {
          const out = rawList.filter(Boolean).map((w) => ({ ...w }));
          let changed = true;
          while (changed && out.length > 1) {
            changed = false;
            for (let i = 0; i < out.length - 1; i++) {
              const cur = out[i];
              const next = out[i + 1];
              const prevX = i === 0 ? st.x : out[i - 1].x;
              const prevY = i === 0 ? st.y : out[i - 1].y;
              if (
                !cur.docking &&
                !cur.reverse &&
                !Number.isFinite(cur.heading) &&
                Math.hypot(cur.x - prevX, cur.y - prevY) <= minGapM
              ) {
                out.splice(i, 1);
                changed = true;
                break;
              }
              if (
                !cur.docking &&
                !cur.reverse &&
                !next.reverse &&
                Math.hypot(next.x - cur.x, next.y - cur.y) <= minGapM
              ) {
                if (!Number.isFinite(cur.heading) || i + 1 === out.length - 1 || next.docking || Number.isFinite(next.heading)) {
                  out.splice(i, 1);
                  changed = true;
                  break;
                }
                if (i + 1 < out.length - 1 && !next.docking && !Number.isFinite(next.heading)) {
                  out.splice(i + 1, 1);
                  changed = true;
                  break;
                }
              }
            }
          }
          return out;
        };
        const buildCombined = (forceStopAtLegs = false, legWps = wps) => {
          const combined = [];
          let curX = st.x;
          let curY = st.y;
          let curHeading = Number.isFinite(st.heading) ? st.heading : 0;
          for (let i = 0; i < legWps.length; i++) {
            const dst = legWps[i];
            if (!dst) continue;
            let nextDst = null;
            for (let j = i + 1; j < legWps.length; j++) {
              if (legWps[j]) { nextDst = legWps[j]; break; }
            }
            const isLast = !nextDst;
            const legDist = Math.hypot(dst.x - curX, dst.y - curY);
            const allowDirectDock = Boolean(dst.docking) && isLast && legDist <= 1.65;
            let leg;
            if (dst.reverse || allowDirectDock || legDist <= 0.05) {
              leg = [{ ...dst }];
            } else {
              const fp = findPath([curX, curY], [dst.x, dst.y], "agf", {
                heading: curHeading,
                carriedWcid,
                loaded,
                _rejectOnFail: true,
              });
              if (
                fp.length === 0 ||
                (fp.length === 1 &&
                  Math.hypot(fp[0].x - curX, fp[0].y - curY) <= 0.05 &&
                  legDist > 0.5)
              ) {
                throw new Error(`AGF route unreachable from (${curX.toFixed(2)}, ${curY.toFixed(2)}) to (${dst.x.toFixed(2)}, ${dst.y.toFixed(2)})`);
              }
              if (fp.length > 1 || Math.hypot(fp[0].x - dst.x, fp[0].y - dst.y) <= 0.5) {
                const lastLeg = fp[fp.length - 1];
                fp[fp.length - 1] = lastLeg._clampedClearTarget
                  ? { ...dst, ...lastLeg, x: lastLeg.x, y: lastLeg.y }
                  : { ...lastLeg, ...dst };
                leg = fp;
              } else {
                throw new Error(`AGF route unreachable from (${curX.toFixed(2)}, ${curY.toFixed(2)}) to (${dst.x.toFixed(2)}, ${dst.y.toFixed(2)})`);
              }
            }
            if (!forceStopAtLegs && combined.length > 0 && leg.length > 0) {
              const prevJ = combined[combined.length - 1];
              const nextFirst = leg[0];
              const nextLegDist = Math.hypot(nextFirst.x - prevJ.x, nextFirst.y - prevJ.y);
              const nextOutH = nextLegDist > 1e-4
                ? (nextFirst.reverse
                  ? wrapHeading(Math.atan2(prevJ.x - nextFirst.x, prevJ.y - nextFirst.y))
                  : wrapHeading(Math.atan2(nextFirst.x - prevJ.x, nextFirst.y - prevJ.y)))
                : curHeading;
              const turnAngle = nextLegDist > 1e-4 ? Math.abs(wrapPi(nextOutH - curHeading)) : 0;
              const nearObs = minDistanceToObstacles(prevJ.x, prevJ.y, staticObs) < 1.8;
              const dirFlip = Boolean(prevJ.reverse) !== Boolean(nextFirst.reverse);
              if (dirFlip || nextFirst.reverse || turnAngle > 0.35 || nearObs) {
                const capSpeed = dirFlip ? 0.45 : (nextFirst.reverse ? 0.65 : 0.90);
                const capSkip = dirFlip ? 0.05 : 0.35;
                combined[combined.length - 1] = {
                  ...prevJ,
                  skipTol: Math.min(prevJ.skipTol ?? 0.45, capSkip),
                  speedLimit: Math.min(prevJ.speedLimit ?? Infinity, capSpeed),
                  _noSubdivideSpeed: true,
                  ...(dirFlip ? { _stopAtWaypoint: true } : {}),
                };
                if (combined.length >= 2) {
                  const prevPrev = combined[combined.length - 2];
                  if (Math.hypot(prevJ.x - prevPrev.x, prevJ.y - prevPrev.y) < 1.5) {
                    combined[combined.length - 2] = {
                      ...prevPrev,
                      speedLimit: Math.min(prevPrev.speedLimit ?? Infinity, 1.25),
                      _noSubdivideSpeed: true,
                    };
                  }
                }
              }
            }
            const nextLegShortMerge = Boolean(
              nextDst &&
              !dst.reverse &&
              !dst.docking &&
              !nextDst.reverse &&
              !nextDst.docking &&
              Math.hypot(nextDst.x - dst.x, nextDst.y - dst.y) <= 0.30,
            );
            if (forceStopAtLegs && !isLast && !nextLegShortMerge && leg.length > 0) {
              const endIdx = leg.length - 1;
              leg[endIdx] = {
                ...leg[endIdx],
                skipTol: Math.min(leg[endIdx].skipTol ?? 0.35, 0.25),
                speedLimit: Math.min(leg[endIdx].speedLimit ?? Infinity, 0.90),
                _noSubdivideSpeed: true,
                _stopAtWaypoint: true,
              };
            }
            const endWp = leg[leg.length - 1];
            const prevPt = leg.length >= 2 ? leg[leg.length - 2] : { x: curX, y: curY };
            let arrX = endWp.x;
            let arrY = endWp.y;
            let arrHeading = curHeading;
            if (!isLast && ((forceStopAtLegs && !nextLegShortMerge) || leg[0]?.reverse)) {
              let sim = {
                x: curX,
                y: curY,
                heading: curHeading,
                speed: 0,
                steerAngleRad: 0,
                forkHeightM: st.forkHeightM ?? AGF_EMPTY_TRANSIT_FORK_Z,
                sideShiftM: 0,
                mastTiltRad: 0,
                wheelSpinRad: 0,
                lidarSpinRad: 0,
                carriedWcid,
                loaded,
              };
              let legTotalLen = 0;
              let lpx = curX;
              let lpy = curY;
              for (let li = 0; li < leg.length; li++) {
                legTotalLen += Math.hypot(leg[li].x - lpx, leg[li].y - lpy);
                lpx = leg[li].x;
                lpy = leg[li].y;
              }
              const maxSimSteps = Math.min(6000, Math.max(900, Math.ceil(legTotalLen * 150)));
              let wpIdxSim = 0;
              for (let s = 0; s < maxSimSteps; s++) {
                const curW = leg[wpIdxSim];
                const isStop = Boolean(curW?._stopAtWaypoint);
                const legCmd = isStop
                  ? {
                      targetPose: {
                        x: curW.x,
                        y: curW.y,
                        ...(Number.isFinite(curW.heading) ? { heading: curW.heading } : {}),
                      },
                      reverse: curW.reverse,
                      docking: curW.docking,
                      speedLimit: curW.speedLimit,
                      targetForkHeightM: sim.forkHeightM,
                    }
                  : { waypoints: leg, waypointIndex: wpIdxSim, targetForkHeightM: sim.forkHeightM };
                sim = stepAgfKinematics(sim, legCmd, 1 / 60, EMPTY_ARC_CTX);
                if (isStop) {
                  if (sim.arrived) break;
                } else {
                  wpIdxSim = sim.waypointIndex;
                  while (wpIdxSim < leg.length - 1) {
                    const w = leg[wpIdxSim];
                    if (w?._stopAtWaypoint) break;
                    const sk = Number.isFinite(w?.skipTol) ? w.skipTol : (w?.speedLimit ? 0.50 : 1.25);
                    if (w && Math.hypot(w.x - sim.x, w.y - sim.y) <= sk && !w.docking) wpIdxSim++;
                    else break;
                  }
                  if (sim.arrived) break;
                }
              }
              if (sim.arrived) {
                if (forceStopAtLegs && !nextLegShortMerge) {
                  arrX = sim.x;
                  arrY = sim.y;
                }
                arrHeading = sim.heading;
              } else if (Math.hypot(endWp.x - prevPt.x, endWp.y - prevPt.y) > 1e-4) {
                arrHeading = endWp.reverse
                  ? wrapHeading(Math.atan2(prevPt.x - endWp.x, prevPt.y - endWp.y))
                  : wrapHeading(Math.atan2(endWp.x - prevPt.x, endWp.y - prevPt.y));
              }
            } else if (Math.hypot(endWp.x - prevPt.x, endWp.y - prevPt.y) > 1e-4) {
              arrHeading = endWp.reverse
                ? wrapHeading(Math.atan2(prevPt.x - endWp.x, prevPt.y - endWp.y))
                : wrapHeading(Math.atan2(endWp.x - prevPt.x, endWp.y - prevPt.y));
            }
            combined.push(...leg);
            curX = arrX;
            curY = arrY;
            curHeading = arrHeading;
          }
          return combined;
        };
        const isCombinedClear = (routeWps) => {
          if (!Array.isArray(routeWps) || routeWps.length === 0) return false;
          const startMinDist = minDistanceToObstacles(st.x, st.y, staticObs);
          const lastCombined = routeWps[routeWps.length - 1];
          const endMinDist = lastCombined ? minDistanceToObstacles(lastCombined.x, lastCombined.y, staticObs) : Infinity;
          let totalLen = 0;
          let px = st.x;
          let py = st.y;
          for (let i = 0; i < routeWps.length; i++) {
            totalLen += Math.hypot(routeWps[i].x - px, routeWps[i].y - py);
            px = routeWps[i].x;
            py = routeWps[i].y;
          }
          const maxSteps = Math.min(18000, Math.max(900, Math.ceil(totalLen * 150)));
          return isAgfArcClear(
            st,
            routeWps,
            staticObs,
            AGF_SPECS.hullRadiusM,
            startMinDist,
            { maxSteps, speedScales: [1.0], requireArrival: true, endMinDist, checkSatObb: true },
          );
        };
        const combined = buildCombined(false, wps);
        if (isCombinedClear(combined)) return combined;
        const stoppedCombined = buildCombined(true, wps);
        if (isCombinedClear(stoppedCombined)) return stoppedCombined;
        const coalescedWps = coalesceShortAgfDriveWps(wps, 0.30);
        if (coalescedWps.length > 0 && coalescedWps.length < wps.length) {
          if (coalescedWps.length === 1) {
            const dst = coalescedWps[0];
            const legDist = Math.hypot(dst.x - st.x, dst.y - st.y);
            const singleLeg = (dst.reverse || dst.docking || legDist <= 0.05)
              ? [{ ...dst }]
              : findStrictAgfPath([st.x, st.y], [dst.x, dst.y], {
                  heading: st.heading,
                  carriedWcid,
                  loaded,
                });
            if (Array.isArray(singleLeg) && singleLeg.length > 0) {
              const lastSingle = singleLeg[singleLeg.length - 1];
              singleLeg[singleLeg.length - 1] = lastSingle._clampedClearTarget
                ? { ...dst, ...lastSingle, x: lastSingle.x, y: lastSingle.y }
                : { ...lastSingle, ...dst };
            }
            if (isCombinedClear(singleLeg)) return singleLeg;
          } else {
            const coalCombined = buildCombined(false, coalescedWps);
            if (isCombinedClear(coalCombined)) return coalCombined;
            const coalStopped = buildCombined(true, coalescedWps);
            if (isCombinedClear(coalStopped)) return coalStopped;
          }
        }
        const lastDst = wps[wps.length - 1];
        throw new Error(`AGF route unreachable from (${st.x.toFixed(2)}, ${st.y.toFixed(2)}) to (${finiteOr(lastDst?.x, st.x).toFixed(2)}, ${finiteOr(lastDst?.y, st.y).toFixed(2)})`);
      }
      const combined = [];
      let cur = { x: st.x, y: st.y, heading: Number.isFinite(st.heading) ? st.heading : 0 };
      for (let i = 0; i < wps.length; i++) {
        const dst = wps[i];
        if (!dst) continue;
        const isLast = i === wps.length - 1;
        const legDist = Math.hypot(dst.x - cur.x, dst.y - cur.y);
        const allowDirectDock = Boolean(dst.docking) && isLast && legDist <= 1.65;
        let leg = (dst.reverse || allowDirectDock || legDist <= 0.05)
          ? [{ ...dst }]
          : routeAroundSolidObstacles(cur, [dst], selfRadius, mode, isLast ? opts : {});
        if (!Array.isArray(leg) || leg.length === 0) leg = [{ ...dst }];
        const endWp = leg[leg.length - 1];
        if (!isLast) {
          leg[leg.length - 1] = { ...endWp, skipTol: Math.min(endWp.skipTol ?? 0.35, 0.35) };
        }
        const prevPt = leg.length >= 2 ? leg[leg.length - 2] : cur;
        let arrHeading = cur.heading;
        if (Math.hypot(endWp.x - prevPt.x, endWp.y - prevPt.y) > 1e-4) {
          arrHeading = endWp.reverse
            ? wrapHeading(Math.atan2(prevPt.x - endWp.x, prevPt.y - endWp.y))
            : wrapHeading(Math.atan2(endWp.x - prevPt.x, endWp.y - prevPt.y));
        }
        combined.push(...leg);
        cur = { x: endWp.x, y: endWp.y, heading: arrHeading };
      }
      return combined;
    }
    const dst = wps[0];
    if (dst.reverse) return wps;
    if (dst.docking && Math.hypot(dst.x - st.x, dst.y - st.y) <= 1.65) {
      if (mode !== "agf") return wps;
      const dockObs = getStaticObstacles();
      const dockStartD = minDistanceToObstacles(st.x, st.y, dockObs);
      const dockH = Number.isFinite(dst.heading) ? wrapHeading(dst.heading) : (Number.isFinite(st.heading) ? st.heading : 0);
      if (
        minDistanceToObstacles(dst.x, dst.y, dockObs) >= AGF_SPECS.hullRadiusM + 0.05 &&
        isAgfPoseObbClear(dst.x, dst.y, dockH, dockObs, 0.002, null, st.carriedWcid, st.forkHeightM) &&
        isAgfArcClear(st, [dst], dockObs, AGF_SPECS.hullRadiusM, dockStartD, { maxSteps: 900, speedScales: [1.0], requireArrival: true, checkSatObb: true })
      ) {
        return wps;
      }
    }
    if (mode === "agf") {
      const fp = findPath([st.x, st.y], [dst.x, dst.y], "agf", {
        heading: st.heading,
        carriedWcid: st.carriedWcid ?? 0,
        loaded: Boolean(st.loaded || st.carriedWcid),
        targetHeading: dst.heading,
        targetDocking: Boolean(dst.docking),
        ...(Array.isArray(opts?.extraObstacles) && opts.extraObstacles.length > 0 ? { extraObstacles: opts.extraObstacles } : {}),
      });
      if (fp.length > 0) {
        if (fp.length > 1 || Math.hypot(fp[0].x - dst.x, fp[0].y - dst.y) <= 0.5) {
          fp[fp.length - 1] = { ...fp[fp.length - 1], ...dst };
        }
        return fp;
      }
      return wps;
    }
    const pad = selfRadius + 0.12;
    const includeStands = true;
    const includeLiftTables = true;

    const rawSolid = getStaticObstacles({ includeStands, includeLiftTables, includeContainers: true });
    const solid = rawSolid.filter((b) => {
      if (b && (b.kind === "stand" || b.kind === "liftTable")) {
        if (pointToObstacleDist(st.x, st.y, b) < AMR_HALF_W || pointToObstacleDist(dst.x, dst.y, b) < AMR_HALF_W) {
          return false;
        }
      }
      return true;
    });
    if (solid.length === 0) return wps;
    const segClearWithEndpoints = (ax, ay, bx, by, isFirst, isLast) => {
      for (let i = 0; i < solid.length; i++) {
        const b = solid[i];
        let effPad = pad;
        if (isFirst) {
          const da = pointToObstacleDist(ax, ay, b);
          if (da < effPad) effPad = Math.min(effPad, Math.max(0.02, da - 0.01));
        }
        if (isLast) {
          const db = pointToObstacleDist(bx, by, b);
          if (db < effPad) effPad = Math.min(effPad, Math.max(0.02, db - 0.01));
        }
        if (segmentIntersectsObstacle2D(ax, ay, bx, by, b, effPad)) return false;
      }
      return true;
    };
    if (segClearWithEndpoints(st.x, st.y, dst.x, dst.y, true, true)) return wps;

    const pushBoxCorners = (b, m, outArr) => {
      if (b.obb) {
        const o = b.obb;
        for (const [lx, ly] of [
          [-o.halfW - m, -o.halfL - m],
          [o.halfW + m, -o.halfL - m],
          [-o.halfW - m, o.halfL + m],
          [o.halfW + m, o.halfL + m],
        ]) {
          const [wx, wy] = localToWorld2D(lx, ly, o.cx, o.cy, o.heading);
          outArr.push({ x: wx, y: wy });
        }
      } else {
        outArr.push(
          { x: b.x0 - m, y: b.y0 - m },
          { x: b.x1 + m, y: b.y0 - m },
          { x: b.x0 - m, y: b.y1 + m },
          { x: b.x1 + m, y: b.y1 + m },
        );
      }
    };

    const m = selfRadius + 0.30;
    const cornerPts = [];
    let uMinX = Infinity, uMaxX = -Infinity, uMinY = Infinity, uMaxY = -Infinity;
    let anyHit = false;
    for (let i = 0; i < solid.length; i++) {
      const b = solid[i];
      const hitsDirect = segmentIntersectsObstacle2D(st.x, st.y, dst.x, dst.y, b, pad);
      const nearEnd = !hitsDirect && (pointToObstacleDist(dst.x, dst.y, b) <= 8.0 || pointToObstacleDist(st.x, st.y, b) <= 8.0);
      if (!hitsDirect && !nearEnd) continue;
      if (hitsDirect) {
        anyHit = true;
        if (b.x0 < uMinX) uMinX = b.x0;
        if (b.x1 > uMaxX) uMaxX = b.x1;
        if (b.y0 < uMinY) uMinY = b.y0;
        if (b.y1 > uMaxY) uMaxY = b.y1;
      }
      pushBoxCorners(b, m, cornerPts);
    }
    if (anyHit) {
      cornerPts.push(
        { x: uMinX - m, y: uMinY - m },
        { x: uMaxX + m, y: uMinY - m },
        { x: uMinX - m, y: uMaxY + m },
        { x: uMaxX + m, y: uMaxY + m },
      );
    }

    let bestSeq = null;
    let bestScore = Infinity;
    const scorePts = (seq) => {
      const pts = [{ x: st.x, y: st.y }, ...seq, { x: dst.x, y: dst.y }];
      for (let i = 0; i < pts.length - 1; i++) {
        if (!segClearWithEndpoints(pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y, i === 0, i === pts.length - 2)) return Infinity;
      }
      let len = 0;
      for (let i = 0; i < pts.length - 1; i++) {
        len += Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y);
      }
      return len;
    };

    for (let i = 0; i < cornerPts.length; i++) {
      const p1 = cornerPts[i];
      if (minDistanceToObstacles(p1.x, p1.y, solid) < pad) continue;
      const sc1 = scorePts([p1]);
      if (sc1 < bestScore) {
        bestScore = sc1;
        bestSeq = [p1];
      }
      for (let j = 0; j < cornerPts.length; j++) {
        if (i === j) continue;
        const p2 = cornerPts[j];
        if (minDistanceToObstacles(p2.x, p2.y, solid) < pad) continue;
        const sc2 = scorePts([p1, p2]);
        if (sc2 < bestScore) {
          bestScore = sc2;
          bestSeq = [p1, p2];
        }
      }
    }

    if (bestSeq) {
      const out = bestSeq.map((p) => ({ x: p.x, y: p.y, skipTol: 0.35 }));
      out.push(dst);
      return out;
    }

    // Multi-hop A* visibility graph over all clear obstacle corners (prevents impassable < 1.36 m gaps & multi-obstacle traps)
    const vgNodes = [{ x: st.x, y: st.y }];
    for (let i = 0; i < solid.length; i++) {
      const tmp = [];
      pushBoxCorners(solid[i], m, tmp);
      for (let k = 0; k < tmp.length; k++) {
        if (minDistanceToObstacles(tmp[k].x, tmp[k].y, solid) >= pad) {
          vgNodes.push(tmp[k]);
        }
      }
    }
    const goalIdx = vgNodes.length;
    vgNodes.push({ x: dst.x, y: dst.y });
    const nVg = vgNodes.length;
    const gScore = new Float64Array(nVg).fill(Infinity);
    const fScore = new Float64Array(nVg).fill(Infinity);
    const parent = new Int32Array(nVg).fill(-1);
    const closed = new Uint8Array(nVg);
    gScore[0] = 0;
    fScore[0] = Math.hypot(dst.x - st.x, dst.y - st.y);
    while (true) {
      let u = -1;
      let uBest = Infinity;
      for (let i = 0; i < nVg; i++) {
        if (!closed[i] && fScore[i] < uBest) {
          uBest = fScore[i];
          u = i;
        }
      }
      if (u === -1 || u === goalIdx) break;
      closed[u] = 1;
      const nu = vgNodes[u];
      for (let v = 1; v < nVg; v++) {
        if (closed[v] || v === u) continue;
        const nv = vgNodes[v];
        const edgeLen = Math.hypot(nv.x - nu.x, nv.y - nu.y);
        const alt = gScore[u] + edgeLen;
        if (alt >= gScore[v]) continue;
        if (!segClearWithEndpoints(nu.x, nu.y, nv.x, nv.y, u === 0, v === goalIdx)) continue;
        gScore[v] = alt;
        fScore[v] = alt + Math.hypot(dst.x - nv.x, dst.y - nv.y);
        parent[v] = u;
      }
    }
    if (parent[goalIdx] !== -1) {
      const chain = [];
      let cur = parent[goalIdx];
      while (cur > 0) {
        chain.unshift({ x: vgNodes[cur].x, y: vgNodes[cur].y, skipTol: 0.35 });
        cur = parent[cur];
      }
      chain.push(dst);
      return chain;
    }

    const fp = findPath([st.x, st.y], [dst.x, dst.y], mode, {
      obstaclePad: pad,
      ignoreStandObstacles: !includeStands,
      ignoreLiftTableObstacles: !includeLiftTables,
      ignoreContainerObstacles: false,
    });
    if (fp.length > 0) {
      fp[fp.length - 1] = { ...fp[fp.length - 1], ...dst };
      return fp;
    }
    return wps;
  }

  function isAgfArcClear(st, targetWps, obstacles, minArcClear, startMinDist, opts = {}) {
    const checkCorners = opts.checkCorners !== false;
    const wps = Array.isArray(targetWps) ? targetWps.filter(Boolean) : (targetWps ? [targetWps] : []);
    if (wps.length === 0) return true;
    const nObs = Array.isArray(obstacles) ? obstacles.length : 0;
    const obsMeta = nObs > 0 ? buildObsMeta(obstacles) : null;
    const cornerCount = AGF_HULL_CORNERS.length;
    const checkSatObb = checkCorners && opts.checkSatObb !== false && nObs > 0;
    const startCornerFloor = (checkCorners && nObs > 0) ? new Float64Array(nObs * cornerCount) : null;
    const startCornerObsCleared = (checkCorners && nObs > 0) ? new Uint8Array(nObs) : null;
    const startCornerZeroObs = (checkCorners && nObs > 0) ? new Uint8Array(nObs) : null;
    const rawStartCornerClear = (checkCorners && nObs > 0) ? new Uint8Array(nObs * cornerCount) : null;
    const rawStartSatClear = (checkSatObb && nObs > 0) ? new Uint8Array(nObs) : null;
    let initAllCornersCleared = true;
    if (startCornerFloor) {
      const s0 = Math.sin(st.heading);
      const c0 = Math.cos(st.heading);
      var tightStartObs = new Uint8Array(nObs);
      for (let oi = 0; oi < nObs; oi++) {
        const ob = obsMeta[oi];
        if (!ob || st.x + 2.06 < ob.minX || st.x - 2.06 > ob.maxX || st.y + 2.06 < ob.minY || st.y - 2.06 > ob.maxY) {
          const base = oi * cornerCount;
          for (let ci = 0; ci < cornerCount; ci++) {
            startCornerFloor[base + ci] = 0.01;
            if (ob?.rawMeta) rawStartCornerClear[base + ci] = 1;
          }
          startCornerObsCleared[oi] = 1;
          continue;
        }
        let all01 = true;
        const base = oi * cornerCount;
        const rawOb = ob.rawMeta;
        const obTight = pointToMetaDist(st.x, st.y, ob) < (ob.kind === "rack" ? 0.70 : (checkSatObb ? 0.75 : AGF_SPECS.hullRadiusM + 0.06));
        const flCap = obTight ? 0.004 : 0.01;
        let minDc0 = Infinity;
        for (let ci = 0; ci < cornerCount; ci++) {
          const lx = AGF_CORNER_LX[ci];
          const ly = AGF_CORNER_LY[ci];
          const wx0 = st.x + lx * c0 + ly * s0;
          const wy0 = st.y - lx * s0 + ly * c0;
          const dc0 = pointToMetaDist(wx0, wy0, ob);
          if (dc0 < minDc0) minDc0 = dc0;
          if (dc0 <= 1e-4) startCornerZeroObs[oi] = 1;
          if (rawOb && pointToMetaDist(wx0, wy0, rawOb) > 1e-4) {
            rawStartCornerClear[base + ci] = 1;
            if (dc0 <= 0.04) startCornerZeroObs[oi] = 1;
          }
          const fl0 = (rawOb && dc0 <= 0.04) ? 0 : (dc0 > 0.015 ? flCap : dc0 > 0.004 ? Math.min(0.005, dc0 * 0.5) : 0);
          startCornerFloor[base + ci] = fl0;
          if (fl0 < flCap) all01 = false;
        }
        if (obTight || (checkSatObb && minDc0 < 0.12)) tightStartObs[oi] = 1;
        if (all01) startCornerObsCleared[oi] = 1;
        else initAllCornersCleared = false;
      }
    }
    let startSatOverlapObs = null;
    let startSatStraddleObs = null;
    let anyStartSatOverlap = false;
    if (checkSatObb) {
      startSatOverlapObs = new Uint8Array(nObs);
      startSatStraddleObs = new Uint8Array(nObs);
      const s0 = Math.sin(st.heading);
      const c0 = Math.cos(st.heading);
      const chX0 = st.x - 0.89 * s0;
      const chY0 = st.y - 0.89 * c0;
      const fkX0 = st.x + 0.725 * s0;
      const fkY0 = st.y + 0.725 * c0;
      const stCarried = Boolean(st.carriedWcid || st.loaded);
      const stForkZ = finiteOr(st.forkHeightM, stCarried ? AGF_CARRIED_TRANSIT_FORK_Z : AGF_EMPTY_TRANSIT_FORK_Z);
      const palX0 = st.x + AGF_SPECS.cargoCenterY * s0;
      const palY0 = st.y + AGF_SPECS.cargoCenterY * c0;
      for (let oi = 0; oi < nObs; oi++) {
        const ob = obsMeta[oi];
        if (!ob) continue;
        const rawOb = ob.rawMeta;
        const palOb0 = (ob.kind === "container" && rawOb) ? rawOb : ob;
        const palPad0 = (ob.kind === "container" && rawOb) ? 0.556 : 0.55;
        const palHit0 = stCarried && stForkZ <= (ob.maxZ ?? Infinity) + 0.005 && satOverlap2DPre(palX0, palY0, c0, -s0, s0, c0, palPad0, palPad0, palOb0);
        if (
          !(st.x + 2.02 < ob.minX || st.x - 2.02 > ob.maxX || st.y + 2.02 < ob.minY || st.y - 2.02 > ob.maxY) &&
          (satOverlap2DPre(chX0, chY0, c0, -s0, s0, c0, 0.57, 1.04, ob) ||
           satOverlap2DPre(fkX0, fkY0, c0, -s0, s0, c0, 0.34, 0.575, ob) ||
           palHit0)
        ) {
          startSatOverlapObs[oi] = 1;
          anyStartSatOverlap = true;
          if (
            rawOb &&
            !satOverlap2DPre(chX0, chY0, c0, -s0, s0, c0, 0.57, 1.04, rawOb) &&
            !satOverlap2DPre(fkX0, fkY0, c0, -s0, s0, c0, 0.34, 0.575, rawOb) &&
            !(stCarried && stForkZ <= (rawOb.maxZ ?? Infinity) + 0.005 && satOverlap2DPre(palX0, palY0, c0, -s0, s0, c0, 0.55, 0.55, rawOb))
          ) {
            rawStartSatClear[oi] = 1;
          } else if (
            ob.kind === "stand" &&
            (pointToMetaDist(chX0, chY0, ob) === 0 || pointToMetaDist(fkX0, fkY0, ob) === 0)
          ) {
            startSatStraddleObs[oi] = 1;
          }
        } else if (rawOb) {
          rawStartSatClear[oi] = 1;
          if (
            !(st.x + 2.04 < ob.minX || st.x - 2.04 > ob.maxX || st.y + 2.04 < ob.minY || st.y - 2.04 > ob.maxY) &&
            !satOverlap2DPre(chX0, chY0, c0, -s0, s0, c0, 0.57, 1.04, rawOb) &&
            !satOverlap2DPre(fkX0, fkY0, c0, -s0, s0, c0, 0.34, 0.575, rawOb) &&
            !(stCarried && stForkZ <= (rawOb.maxZ ?? Infinity) + 0.005 && satOverlap2DPre(palX0, palY0, c0, -s0, s0, c0, 0.55, 0.55, rawOb)) &&
            (satOverlap2DPre(chX0, chY0, c0, -s0, s0, c0, 0.61, 1.08, ob) ||
             satOverlap2DPre(fkX0, fkY0, c0, -s0, s0, c0, 0.38, 0.615, ob) ||
             (stCarried && stForkZ <= (ob.maxZ ?? Infinity) + 0.005 && satOverlap2DPre(palX0, palY0, c0, -s0, s0, c0, 0.59, 0.59, ob)))
          ) {
            startSatOverlapObs[oi] = 1;
            anyStartSatOverlap = true;
          }
        }
      }
    }
    const lastWpTarget = wps[wps.length - 1];
    let endMinDist = Infinity;
    if (Number.isFinite(opts.endMinDist)) {
      endMinDist = opts.endMinDist;
    } else if (lastWpTarget && nObs > 0) {
      for (let oi = 0; oi < nObs; oi++) {
        const ob = obsMeta[oi];
        if (!ob) continue;
        const dEnd = pointToMetaDist(lastWpTarget.x, lastWpTarget.y, ob);
        if (dEnd < endMinDist) endMinDist = dEnd;
      }
    }
    const effMinArcClear =
      (minArcClear === AGF_SPECS.hullRadiusM &&
        startMinDist >= AGF_SPECS.hullRadiusM + 0.003 &&
        endMinDist >= AGF_SPECS.hullRadiusM + 0.003)
        ? AGF_SPECS.hullRadiusM + 0.003
        : minArcClear;
    const rawTightWindow = effMinArcClear + 0.05;
    let hasRawPaddedTightStart = false;
    if (nObs > 0 && startMinDist < rawTightWindow) {
      for (let oi = 0; oi < nObs; oi++) {
        const ob = obsMeta[oi];
        if (!ob?.rawMeta) continue;
        const dPad = pointToMetaDist(st.x, st.y, ob);
        if (dPad >= rawTightWindow) continue;
        const rawClear = rawStartSatClear
          ? rawStartSatClear[oi] === 1
          : pointToMetaDist(st.x, st.y, ob.rawMeta) >= 0.568;
        if (rawClear) {
          hasRawPaddedTightStart = true;
          break;
        }
      }
    }
    const tightStart = startMinDist < effMinArcClear || hasRawPaddedTightStart || (checkSatObb && startMinDist < 0.70);
    const veryTightStart = startMinDist < 0.55 || (tightStart && hasRawPaddedTightStart);
    const startTightObs = nObs > 0 ? new Uint8Array(nObs) : null;
    let anyStartTightObs = false;
    if (startTightObs && tightStart && (startMinDist >= 0.572 || hasRawPaddedTightStart)) {
      for (let oi = 0; oi < nObs; oi++) {
        const ob = obsMeta[oi];
        if (!ob) continue;
        const dOb = pointToMetaDist(st.x, st.y, ob);
        if (
          (dOb < effMinArcClear && (startMinDist >= 0.572 || rawStartSatClear?.[oi] === 1)) ||
          (checkSatObb && dOb < 0.70 && startMinDist >= 0.572) ||
          (dOb < rawTightWindow && ob.rawMeta && rawStartSatClear?.[oi] === 1)
        ) {
          startTightObs[oi] = 1;
          anyStartTightObs = true;
        }
      }
    }
    const startTightClearFloor = hasRawPaddedTightStart
      ? Math.max(0.532, startMinDist - 0.008)
      : (checkSatObb && startMinDist >= 0.572 ? 0.572 : Math.max(0.568, startMinDist - 0.055));
    const allowFloor = startMinDist < 0.36
      ? Math.max(0, startMinDist - 0.055)
      : veryTightStart
        ? Math.max(0.36, startMinDist - 0.055)
        : (tightStart
          ? (checkSatObb && startMinDist >= 0.572
            ? 0.572
            : Math.min(effMinArcClear, Math.max(0.42, startMinDist - 0.055)))
          : effMinArcClear);
    const clearTimeFloor = (veryTightStart || tightStart) ? 1.85 : 0.30;
    const firstIsReverse = Boolean(wps[0]?.reverse);
    const horizon = Number.isFinite(opts.maxSteps) ? opts.maxSteps : 270;
    const speedScales = Array.isArray(opts.speedScales) && opts.speedScales.length > 0
      ? opts.speedScales
      : [1.0];
    const checkReverseLocY = Boolean(opts.checkReverseLocY);
    const checkTurnRunout = Boolean(opts.checkTurnRunout);
    const simRuns = speedScales.map((s) => ({ speedScale: s, pauseWindow: null }));
    if (checkTurnRunout) {
      simRuns.push({ speedScale: 1.0, pauseWindow: [45, 52] });
    }
    const proxR = Math.max(2.06, effMinArcClear + 0.05);
    const nearObsIdx = nObs > 0 ? new Int32Array(nObs) : null;
    const cornerWx = new Float64Array(cornerCount);
    const cornerWy = new Float64Array(cornerCount);
    const stopCtx = {
      agentId: st.agentId ?? "agf-sim",
      grid: { queryProximity: () => ({ yieldLevel: "stop", stop: true, slow: false, speedScale: 0 }) },
    };
    for (const dtSim of [1 / 60, 1 / 30]) {
      for (const { speedScale, pauseWindow } of simRuns) {
        const maxSteps = Math.ceil((dtSim < 0.025 ? horizon : Math.ceil(horizon * 0.5)) / Math.max(speedScale, 0.45));
        const cornerFloor = startCornerFloor ? new Float64Array(startCornerFloor) : null;
        const cornerObsCleared = startCornerObsCleared ? new Uint8Array(startCornerObsCleared) : null;
        let allCornersCleared = initAllCornersCleared;
        const satClearedObs = anyStartSatOverlap ? new Uint8Array(nObs) : null;
        let allSatCleared = !anyStartSatOverlap;
        const runStartTightObs = anyStartTightObs ? new Uint8Array(startTightObs) : null;
        let anyRunStartTight = anyStartTightObs;
        let arrivedThisRun = false;
        let sim = {
          agentId: st.agentId ?? "agf-sim",
          x: st.x,
          y: st.y,
          heading: st.heading,
          speed: Number.isFinite(opts.initSpeed) ? opts.initSpeed : 0,
          steerAngleRad: st.steerAngleRad ?? 0,
          forkHeightM: st.forkHeightM ?? AGF_EMPTY_TRANSIT_FORK_Z,
          sideShiftM: st.sideShiftM ?? 0,
          mastTiltRad: st.mastTiltRad ?? 0,
          wheelSpinRad: st.wheelSpinRad ?? 0,
          lidarSpinRad: st.lidarSpinRad ?? 0,
          carriedWcid: st.carriedWcid ?? 0,
          loaded: Boolean(st.loaded || st.carriedWcid),
        };
        const slowCtx = speedScale < 1.0
          ? {
            agentId: sim.agentId,
            grid: { queryProximity: () => ({ yieldLevel: "slow", stop: false, slow: true, speedScale }) },
          }
          : EMPTY_ARC_CTX;
        const simCmd = {
          waypoints: wps,
          waypointIndex: 0,
          targetForkHeightM: st.forkHeightM,
        };
        const pStart = pauseWindow ? (dtSim < 0.025 ? pauseWindow[0] : Math.floor(pauseWindow[0] * 0.5)) : -1;
        const pEnd = pauseWindow ? (dtSim < 0.025 ? pauseWindow[1] : Math.ceil(pauseWindow[1] * 0.5)) : -1;
        let wpIdx = 0;
        for (let step = 0; step < maxSteps; step++) {
          const paused = pauseWindow !== null && step >= pStart && step <= pEnd;
          const simContext = paused ? stopCtx : slowCtx;
          if (checkReverseLocY) {
            const activeWp = wps[wpIdx];
            if (activeWp?.reverse && !activeWp?.docking) {
              const locY = (activeWp.x - sim.x) * Math.sin(sim.heading) + (activeWp.y - sim.y) * Math.cos(sim.heading);
              const revTol = Math.max(activeWp.skipTol ?? 0.45, 0.45);
              if (locY > 0.15 && Math.hypot(activeWp.x - sim.x, activeWp.y - sim.y) > revTol) {
                return false;
              }
            }
          }
          const curSimWp = wps[wpIdx];
          const isStopWp = Boolean(curSimWp?._stopAtWaypoint && wpIdx < wps.length - 1);
          const effSimCmd = isStopWp
            ? {
                targetPose: {
                  x: curSimWp.x,
                  y: curSimWp.y,
                  ...(Number.isFinite(curSimWp.heading) ? { heading: curSimWp.heading } : {}),
                },
                reverse: curSimWp.reverse,
                docking: curSimWp.docking,
                speedLimit: curSimWp.speedLimit,
                targetForkHeightM: st.forkHeightM,
              }
            : (simCmd.waypointIndex = wpIdx, simCmd);
          sim = stepAgfKinematics(sim, effSimCmd, dtSim, simContext);
          if (isStopWp) {
            if (sim.arrived) {
              sim.speed = 0;
              wpIdx++;
            }
          } else {
            wpIdx = sim.waypointIndex;
            while (wpIdx < wps.length - 1) {
              const wp = wps[wpIdx];
              if (wp?._stopAtWaypoint) break;
              const skipTol = Number.isFinite(wp?.skipTol) ? wp.skipTol : (wp?.speedLimit ? 0.50 : 1.25);
              if (wp && Math.hypot(wp.x - sim.x, wp.y - sim.y) <= skipTol && !wp.docking) {
                wpIdx++;
              } else {
                break;
              }
            }
          }
          let d = Infinity;
          let dNonStartTight = Infinity;
          let nearCount = 0;
          if (nObs > 0) {
            const sx = sim.x;
            const sy = sim.y;
            for (let oi = 0; oi < nObs; oi++) {
              const ob = obsMeta[oi];
              if (!ob) continue;
              if (sx + proxR < ob.minX || sx - proxR > ob.maxX || sy + proxR < ob.minY || sy - proxR > ob.maxY) {
                if (anyRunStartTight && runStartTightObs[oi]) runStartTightObs[oi] = 0;
                continue;
              }
              nearObsIdx[nearCount++] = oi;
              const dOi = pointToMetaDist(sx, sy, ob);
              if (dOi < d) d = dOi;
              if (anyRunStartTight && runStartTightObs[oi]) {
                if (dOi >= effMinArcClear) {
                  runStartTightObs[oi] = 0;
                }
              }
              if (!(anyRunStartTight && runStartTightObs[oi]) && dOi < dNonStartTight) {
                dNonStartTight = dOi;
              }
            }
          }
          if (nearCount > 0) {
            let onAlignedFinalTight = false;
            if (
              endMinDist >= 0.572 &&
              endMinDist < effMinArcClear &&
              lastWpTarget &&
              wps.length >= 2 &&
              Math.hypot(lastWpTarget.x - sim.x, lastWpTarget.y - sim.y) <= 7.2
            ) {
              const segTo = wps[wpIdx];
              const segFrom = wps[Math.max(0, wpIdx - 1)];
              const segLen = segTo && segFrom ? Math.hypot(segTo.x - segFrom.x, segTo.y - segFrom.y) : 0;
              if (segLen >= 1.0) {
                const ux = (segTo.x - segFrom.x) / segLen;
                const uy = (segTo.y - segFrom.y) / segLen;
                const lat = Math.abs((sim.x - segTo.x) * uy - (sim.y - segTo.y) * ux);
                const tgtLat = Math.abs((lastWpTarget.x - segTo.x) * uy - (lastWpTarget.y - segTo.y) * ux);
                const tgtAlong = (lastWpTarget.x - sim.x) * ux + (lastWpTarget.y - sim.y) * uy;
                const segH = Math.atan2(ux, uy);
                if (lat <= 0.08 && tgtLat <= 0.08 && tgtAlong >= -0.25 && Math.abs(wrapPi(sim.heading - segH)) <= 0.06) {
                  onAlignedFinalTight = true;
                }
              }
            }
            const nearTightEnd = (endMinDist < effMinArcClear &&
              lastWpTarget &&
              Math.hypot(lastWpTarget.x - sim.x, lastWpTarget.y - sim.y) <= 2.35) || onAlignedFinalTight;
            const stepAllowFloor = nearTightEnd ? Math.min(allowFloor, Math.max(0.42, endMinDist - 0.015)) : allowFloor;
            const stepMinClear = nearTightEnd ? Math.min(effMinArcClear, Math.max(0.42, endMinDist - 0.015)) : effMinArcClear;
            if (d < stepAllowFloor) { if (opts._failInfo) { opts._failInfo.x = sim.x; opts._failInfo.y = sim.y; opts._failInfo.step = step; opts._failInfo.wpIdx = wpIdx; } return false; }
            if ((step + 1) * dtSim >= clearTimeFloor) {
              if (dNonStartTight < stepMinClear) { if (opts._failInfo) { opts._failInfo.x = sim.x; opts._failInfo.y = sim.y; opts._failInfo.step = step; opts._failInfo.wpIdx = wpIdx; } return false; }
              if (anyRunStartTight && d < Math.min(stepMinClear, startTightClearFloor)) { if (opts._failInfo) { opts._failInfo.x = sim.x; opts._failInfo.y = sim.y; opts._failInfo.step = step; opts._failInfo.wpIdx = wpIdx; } return false; }
            }
          }
          if (nearCount === 0) {
            if (anyRunStartTight) {
              runStartTightObs.fill(0);
              anyRunStartTight = false;
            }
            if (cornerFloor && !allCornersCleared) {
              for (let oi = 0; oi < nObs; oi++) {
                if (!cornerObsCleared[oi]) {
                  const base = oi * cornerCount;
                  for (let ci = 0; ci < cornerCount; ci++) {
                    if (cornerFloor[base + ci] < 0.01) cornerFloor[base + ci] = 0.01;
                  }
                  cornerObsCleared[oi] = 1;
                }
              }
              allCornersCleared = true;
            }
            if (satClearedObs && !allSatCleared) {
              for (let oi = 0; oi < nObs; oi++) {
                if (startSatOverlapObs[oi]) satClearedObs[oi] = 1;
              }
              allSatCleared = true;
            }
          } else if (cornerFloor || checkSatObb) {
            const sH = Math.sin(sim.heading);
            const cH = Math.cos(sim.heading);
            if (cornerFloor) {
              for (let ci = 0; ci < cornerCount; ci++) {
                const lx = AGF_CORNER_LX[ci];
                const ly = AGF_CORNER_LY[ci];
                cornerWx[ci] = sim.x + lx * cH + ly * sH;
                cornerWy[ci] = sim.y - lx * sH + ly * cH;
              }
              const withinStartTime = (step + 1) * dtSim < 1.85;
              if (!allCornersCleared) {
                let remainingUnclear = false;
                for (let oi = 0; oi < nObs; oi++) {
                  if (cornerObsCleared[oi]) continue;
                  const ob = obsMeta[oi];
                  if (!ob || sim.x + 2.06 < ob.minX || sim.x - 2.06 > ob.maxX || sim.y + 2.06 < ob.minY || sim.y - 2.06 > ob.maxY) {
                    const base = oi * cornerCount;
                    for (let ci = 0; ci < cornerCount; ci++) {
                      if (cornerFloor[base + ci] < 0.01) cornerFloor[base + ci] = 0.01;
                    }
                    cornerObsCleared[oi] = 1;
                  } else {
                    remainingUnclear = true;
                  }
                }
                if (!remainingUnclear) allCornersCleared = true;
              }
              for (let k = 0; k < nearCount; k++) {
                const oi = nearObsIdx[k];
                const ob = obsMeta[oi];
                const base = oi * cornerCount;
                const exemptZero = withinStartTime && (startCornerZeroObs[oi] || (startSatStraddleObs && startSatStraddleObs[oi] && ob.kind !== "rack"));
                const flCap = tightStartObs && tightStartObs[oi] ? 0.004 : 0.01;
                let obsClearedNow = cornerObsCleared[oi] === 1;
                let all01 = true;
                const rawObC = ob.rawMeta;
                for (let ci = 0; ci < cornerCount; ci++) {
                  const idx = base + ci;
                  if (rawObC && rawStartCornerClear[idx] && pointToMetaDist(cornerWx[ci], cornerWy[ci], rawObC) <= 1e-4) {
                    if (opts._failInfo) { opts._failInfo.x = sim.x; opts._failInfo.y = sim.y; opts._failInfo.step = step; opts._failInfo.wpIdx = wpIdx; }
                    return false;
                  }
                  const fl = cornerFloor[idx];
                  const dc = pointToMetaDist(cornerWx[ci], cornerWy[ci], ob);
                  if (fl === 0) {
                    if (!firstIsReverse && ob.kind === "rack" && dc <= 0.005) {
                      if (opts._failInfo) { opts._failInfo.x = sim.x; opts._failInfo.y = sim.y; opts._failInfo.step = step; opts._failInfo.wpIdx = wpIdx; }
                      return false;
                    }
                    if (dc > 0.04) cornerFloor[idx] = flCap;
                    else all01 = false;
                  } else {
                    const effFl = (tightStartObs && tightStartObs[oi] && checkSatObb && (step + 1) * dtSim <= 1.25) ? Math.min(fl, ob.kind === "rack" ? 0.0055 : 0.0015) : fl;
                    if (!exemptZero && dc <= effFl) { if (opts._failInfo) { opts._failInfo.x = sim.x; opts._failInfo.y = sim.y; opts._failInfo.step = step; opts._failInfo.wpIdx = wpIdx; } return false; }
                    if (fl < flCap) {
                      if (dc > 0.04) cornerFloor[idx] = flCap;
                      else all01 = false;
                    }
                  }
                }
                if (!obsClearedNow && all01) cornerObsCleared[oi] = 1;
              }
            }
            if (checkSatObb) {
              if (d >= 2.02) {
                if (satClearedObs && !allSatCleared) {
                  for (let oi = 0; oi < nObs; oi++) {
                    if (startSatOverlapObs[oi]) satClearedObs[oi] = 1;
                  }
                  allSatCleared = true;
                }
              } else {
                const chX = sim.x - 0.89 * sH;
                const chY = sim.y - 0.89 * cH;
                const fkX = sim.x + 0.725 * sH;
                const fkY = sim.y + 0.725 * cH;
                const exitWindow = 5.0;
                if (satClearedObs && !allSatCleared) {
                  let anyRem = false;
                  for (let oi = 0; oi < nObs; oi++) {
                    if (startSatOverlapObs[oi] && !satClearedObs[oi]) {
                      const ob = obsMeta[oi];
                      if (!ob || sim.x + 2.02 < ob.minX || sim.x - 2.02 > ob.maxX || sim.y + 2.02 < ob.minY || sim.y - 2.02 > ob.maxY) {
                        satClearedObs[oi] = 1;
                      } else {
                        anyRem = true;
                      }
                    }
                  }
                  if (!anyRem) allSatCleared = true;
                }
                for (let k = 0; k < nearCount; k++) {
                  const oi = nearObsIdx[k];
                  const ob = obsMeta[oi];
                  const nearObs = !(sim.x + 2.02 < ob.minX || sim.x - 2.02 > ob.maxX || sim.y + 2.02 < ob.minY || sim.y - 2.02 > ob.maxY);
                  const simCarried = Boolean(sim.carriedWcid || sim.loaded);
                  const simForkZ = finiteOr(sim.forkHeightM, simCarried ? AGF_CARRIED_TRANSIT_FORK_Z : AGF_EMPTY_TRANSIT_FORK_Z);
                  const palX = sim.x + AGF_SPECS.cargoCenterY * sH;
                  const palY = sim.y + AGF_SPECS.cargoCenterY * cH;
                  const rawObS = ob.rawMeta;
                  if (
                    nearObs && rawObS && rawStartSatClear[oi] &&
                    !(sim.x + 2.02 < rawObS.minX || sim.x - 2.02 > rawObS.maxX || sim.y + 2.02 < rawObS.minY || sim.y - 2.02 > rawObS.maxY) &&
                    (satOverlap2DPre(chX, chY, cH, -sH, sH, cH, 0.57, 1.04, rawObS) ||
                     satOverlap2DPre(fkX, fkY, cH, -sH, sH, cH, 0.34, 0.575, rawObS) ||
                     (simCarried && simForkZ <= (rawObS.maxZ ?? Infinity) + 0.005 && satOverlap2DPre(palX, palY, cH, -sH, sH, cH, 0.55, 0.55, rawObS)))
                  ) {
                    if (opts._failInfo) { opts._failInfo.x = sim.x; opts._failInfo.y = sim.y; opts._failInfo.step = step; opts._failInfo.wpIdx = wpIdx; }
                    return false;
                  }
                  const palOb = (ob.kind === "container" && rawObS) ? rawObS : ob;
                  const palPad = (ob.kind === "container" && rawObS) ? 0.556 : 0.55;
                  const palHit = simCarried && nearObs && simForkZ <= (ob.maxZ ?? Infinity) + 0.005 &&
                    satOverlap2DPre(palX, palY, cH, -sH, sH, cH, palPad, palPad, palOb);
                  const hitSat = nearObs && (
                    satOverlap2DPre(chX, chY, cH, -sH, sH, cH, 0.57, 1.04, ob) ||
                    satOverlap2DPre(fkX, fkY, cH, -sH, sH, cH, 0.34, 0.575, ob) ||
                    palHit
                  );
                  if (!hitSat) {
                    if (satClearedObs && startSatOverlapObs[oi] && (!rawObS || pointToMetaDist(sim.x, sim.y, ob) >= effMinArcClear)) {
                      satClearedObs[oi] = 1;
                    }
                  } else {
                    const obsExitWindow = (rawStartSatClear && rawStartSatClear[oi] ? 9.5 : exitWindow) / Math.max(speedScale, 0.45);
                    const exempt = satClearedObs && startSatOverlapObs[oi] && !satClearedObs[oi] && (step + 1) * dtSim < obsExitWindow;
                    if (!exempt) { if (opts._failInfo) { opts._failInfo.x = sim.x; opts._failInfo.y = sim.y; opts._failInfo.step = step; opts._failInfo.wpIdx = wpIdx; } return false; }
                  }
                }
              }
            }
          }
          const lastWp = wps[wps.length - 1];
          const midTurnFast = checkTurnRunout && Math.abs(sim.speed) > 1.2 && Math.abs(sim.steerAngleRad) > 0.25;
          if (
            !isStopWp &&
            !midTurnFast &&
            (sim.arrived ||
              (!opts.requireArrival &&
                wpIdx >= wps.length - 1 &&
                Math.hypot(lastWp.x - sim.x, lastWp.y - sim.y) <= Math.min(lastWp.skipTol ?? 0.35, 0.25)))
          ) {
            arrivedThisRun = true;
            break;
          }
        }
        if (opts.requireArrival && !arrivedThisRun) { if (opts._failInfo) { opts._failInfo.x = sim.x; opts._failInfo.y = sim.y; opts._failInfo.step = maxSteps; opts._failInfo.wpIdx = wpIdx; } return false; }
      }
    }
    return true;
  }

  function pathIsClear(ax, ay, bx, by, obstacles, pad = 0.75, ignoreSet = null, cornerTransitPad = 0) {
    for (let i = 0; i < obstacles.length; i++) {
      const b = obstacles[i];
      if (ignoreSet && ignoreSet.has(b)) continue;
      let effPad = pad;
      if (cornerTransitPad > pad && (b.kind === "rack" || b.kind === "charger" || b.kind === "stand")) {
        if (b.kind === "charger" && ay <= b.y0 - 0.85 && by <= b.y0 - 0.85) {
          effPad = pad;
        } else if (b.kind === "stand") {
          const da = pointToObstacleDist(ax, ay, b);
          const db = pointToObstacleDist(bx, by, b);
          effPad = (da >= 1.30 && db >= 1.30)
            ? Math.min(cornerTransitPad, Math.max(pad, Math.min(da, db) - 0.15))
            : cornerTransitPad;
        } else {
          const da = pointToObstacleDist(ax, ay, b);
          const db = pointToObstacleDist(bx, by, b);
          effPad = Math.min(cornerTransitPad, Math.max(pad, Math.min(da, db) - 0.15));
        }
      }
      if (segmentIntersectsObstacle2D(ax, ay, bx, by, b, effPad)) {
        if (effPad <= 0.05 || effPad > 0.76) return false;
        let laX = ax, laY = ay, lbX = bx, lbY = by;
        let x0 = b.x0, x1 = b.x1, y0 = b.y0, y1 = b.y1;
        if (b.obb) {
          const o = b.obb;
          const pa = worldToLocalPoint(ax, ay, o.cx, o.cy, o.heading);
          const pb = worldToLocalPoint(bx, by, o.cx, o.cy, o.heading);
          laX = pa.x; laY = pa.y; lbX = pb.x; lbY = pb.y;
          x0 = -o.halfW; x1 = o.halfW; y0 = -o.halfL; y1 = o.halfL;
        }
        const inCapA = (laX < x0 || laX > x1) && (laY < y0 || laY > y1) && pointToObstacleDist(ax, ay, b) > effPad;
        const inCapB = (lbX < x0 || lbX > x1) && (lbY < y0 || lbY > y1) && pointToObstacleDist(bx, by, b) > effPad;
        if (!inCapA && !inCapB) return false;
        const hitCross =
          segmentIntersectsAabb2D(laX, laY, lbX, lbY, { x0: x0 - effPad, x1: x1 + effPad, y0, y1 }, 0) ||
          segmentIntersectsAabb2D(laX, laY, lbX, lbY, { x0, x1, y0: y0 - effPad, y1: y1 + effPad }, 0);
        if (hitCross) return false;
        if (
          pointToSegDist2D(x0, y0, laX, laY, lbX, lbY) <= effPad ||
          pointToSegDist2D(x1, y0, laX, laY, lbX, lbY) <= effPad ||
          pointToSegDist2D(x0, y1, laX, laY, lbX, lbY) <= effPad ||
          pointToSegDist2D(x1, y1, laX, laY, lbX, lbY) <= effPad
        ) {
          return false;
        }
      }
    }
    return true;
  }

  function subdivideWaypoints(fx, fy, wps, maxSeg = 4.5) {
    const sub = [];
    let prevX = fx;
    let prevY = fy;
    for (let i = 0; i < wps.length; i++) {
      const w = wps[i];
      const segD = Math.hypot(w.x - prevX, w.y - prevY);
      if (segD > maxSeg + 0.5) {
        const steps = Math.ceil(segD / maxSeg);
        for (let s = 1; s < steps; s++) {
          const frac = s / steps;
          sub.push({
            x: prevX + (w.x - prevX) * frac,
            y: prevY + (w.y - prevY) * frac,
            ...(w.reverse !== undefined ? { reverse: w.reverse } : {}),
            ...(!(w._turnThrottle || w._noSubdivideSpeed) && Number.isFinite(w.speedLimit) ? { speedLimit: w.speedLimit } : {}),
          });
        }
      }
      sub.push(w);
      prevX = w.x;
      prevY = w.y;
    }
    return sub;
  }

  function findPath(fromPos, toPos, mode = "agf", opts = {}) {
    const fx = finiteOr(fromPos?.[0] ?? fromPos?.x, 0);
    const fy = finiteOr(fromPos?.[1] ?? fromPos?.y, 0);
    const tx = finiteOr(toPos?.[0] ?? toPos?.x, 0);
    const ty = finiteOr(toPos?.[1] ?? toPos?.y, 0);
    const distDirect = Math.hypot(tx - fx, ty - fy);
    if (distDirect <= 0.05) return [{ x: tx, y: ty }];

    const rawStaticObs = getStaticObstacles({
      includeStands: opts.ignoreStandObstacles !== true,
      includeLiftTables: opts.ignoreLiftTableObstacles !== true,
      includeContainers: opts.ignoreContainerObstacles !== true,
      ignoreContainerGuid: opts.ignoreContainerGuid ?? null,
    });
    const obstacles = (Array.isArray(opts.extraObstacles) && opts.extraObstacles.length > 0)
      ? [...rawStaticObs, ...opts.extraObstacles]
      : rawStaticObs;
    const pad = opts.obstaclePad ?? (mode === "amr" ? 0.42 : 0.72);
    const cornerTransitPad = (mode === "agf" && opts.obstaclePad == null) ? 1.55 : pad;
    const pointInsideObs = (px, py, b) => pointToObstacleDist(px, py, b) <= pad;
    const startObs = new Set();
    const endObs = new Set();
    for (let i = 0; i < obstacles.length; i++) {
      const b = obstacles[i];
      if (pointInsideObs(fx, fy, b) || (mode === "agf" && segmentIntersectsObstacle2D(fx, fy, fx, fy, b, pad))) startObs.add(b);
      if (pointInsideObs(tx, ty, b)) endObs.add(b);
    }
    const ox = layout?.origin?.[0] ?? NE_FLATLAND_SITE.origin[0];
    const oy = layout?.origin?.[1] ?? NE_FLATLAND_SITE.origin[1];
    const zoneCStandBarrier = (mode === "agf" && opts.ignoreStandObstacles !== true && stands.size >= 6)
      ? { x0: ox + 13.43, x1: ox + 14.57, y0: oy - 10.84, y1: oy + 4.84 }
      : null;
    const barrierClearAtEndpoints = zoneCStandBarrier &&
      pointToObstacleDist(fx, fy, zoneCStandBarrier) > pad &&
      pointToObstacleDist(tx, ty, zoneCStandBarrier) > pad;
    let isZoneDStandTarget = false;
    if (
      mode === "agf" &&
      opts.ignoreStandObstacles !== true &&
      stands.size >= 18 &&
      ty <= oy - 20.5 &&
      ty >= oy - 23.5
    ) {
      for (const st of stands.values()) {
        if (st.zone === "zoneD" && st.agfApproachPos && Math.hypot(tx - st.agfApproachPos[0], ty - st.agfApproachPos[1]) <= 0.50) {
          isZoneDStandTarget = true;
          break;
        }
      }
    }
    let isZoneCStandTarget = false;
    if (
      mode === "agf" &&
      opts.ignoreStandObstacles !== true &&
      stands.size >= 6 &&
      tx >= ox + 10.5 &&
      tx <= ox + 12.055 &&
      ty >= oy - 11.5 &&
      ty <= oy + 5.5
    ) {
      for (const st of stands.values()) {
        if (st.zone === "zoneC" && st.agfApproachPos && Math.hypot(tx - st.agfApproachPos[0], ty - st.agfApproachPos[1]) <= 0.50) {
          isZoneCStandTarget = true;
          break;
        }
      }
    }
    const isZoneDStandStart =
      mode === "agf" &&
      opts.ignoreStandObstacles !== true &&
      stands.size >= 18 &&
      fy <= oy - 20.5 &&
      fy >= oy - 23.45 &&
      fx >= ox - 18.0 &&
      fx <= ox + 18.0;
    const isZoneDTarget =
      mode === "agf" &&
      ty < oy - 23.5 &&
      !isZoneDStandTarget;
    const zoneDHwyY = oy - 29.0;
    const isSouthOfChargers =
      isZoneDTarget &&
      (ty < oy - 39.5 ||
        (ty < oy - 38.5 &&
          Math.abs(tx - ox) <= 18.0 &&
          !pathIsClear(tx, zoneDHwyY, tx, ty, obstacles, 0.72, null, 0.72)));
    const isSouthOfChargersStart =
      mode === "agf" &&
      fy < oy - 38.5 &&
      Math.abs(fx - ox) <= 18.0;
    const zoneDStandApproachBand =
      mode === "agf" && opts.ignoreStandObstacles !== true && stands.size >= 18
        ? { x0: ox - 17.5, x1: ox + 17.5, y0: oy - 24.6, y1: oy - 20.2 }
        : null;
    const zoneDStartClearOrValid =
      !zoneDStandApproachBand || isZoneDStandStart || pointToObstacleDist(fx, fy, zoneDStandApproachBand) > 0.05;
    const zoneDTargetClearOrValid =
      !zoneDStandApproachBand || isZoneDStandTarget || pointToObstacleDist(tx, ty, zoneDStandApproachBand) > 0.05;
    let standDepartInfo = null;
    const bandPathClear = (x0, y0, x1, y1) => {
      let ig = null;
      if (startObs.size > 0 && Math.hypot(x0 - fx, y0 - fy) < 0.15) {
        ig = new Set();
        for (const b of startObs) {
          if (!pointInsideObs(x1, y1, b)) ig.add(b);
        }
        for (const b of ig) {
          if (pointToObstacleDist(x0, y0, b) > 0.05 && pointToObstacleDist(x1, y1, b) > 0.05 && segmentIntersectsObstacle2D(x0, y0, x1, y1, b, 0.05)) {
            return false;
          }
        }
      }
      return pathIsClear(x0, y0, x1, y1, obstacles, ig ? Math.min(pad, 0.55) : pad, ig && ig.size > 0 ? ig : null);
    };
    const checkZoneDBandSeg = (ax, ay, bx, by) => {
      if (!zoneDStandApproachBand || !zoneDStartClearOrValid || !zoneDTargetClearOrValid) return true;
      if (!segmentIntersectsAabb2D(ax, ay, bx, by, zoneDStandApproachBand, 0.05)) return true;
      const isVerticalStartLeg =
        isZoneDStandStart &&
        ay >= oy - 23.45 &&
        by >= oy - 23.45 &&
        ((Math.abs(ax - fx) < 0.15 && Math.abs(bx - fx) < 0.15) ||
          (Math.hypot(ax - fx, ay - fy) < 0.15 &&
            by > ay + 0.15 &&
            Math.abs(bx - fx) <= Math.max(0.25, (by - ay) * 2.5) &&
            bandPathClear(ax, ay, bx, by)) ||
          (standDepartInfo &&
            Math.hypot(ax - fx, ay - fy) < 0.15 &&
            ((by >= ay - 0.10 && Math.hypot(bx - ax, by - ay) <= 4.5) ||
              (Math.abs(by - ay) <= 0.15 && Math.hypot(bx - ax, by - ay) <= 2.25) ||
              Math.hypot(bx - ax, by - ay) <= 1.65) &&
            bandPathClear(ax, ay, bx, by)) ||
          (standDepartInfo &&
            ay >= oy - 23.45 &&
            by >= ay + 0.15 &&
            Math.abs(bx - ax) <= Math.max(1.5, (by - ay) * 4.0) &&
            bandPathClear(ax, ay, bx, by)) ||
          (Math.abs(bx - ax) < 0.15 &&
            by >= oy - 19.0 &&
            by > ay + 0.2 &&
            bandPathClear(ax, ay, bx, by)));
      const isSouthboundStartLeg =
        isZoneDStandStart &&
        ((ay >= oy - 23.45 && by < ay - 0.15 && Math.hypot(ax - fx, ay - fy) < 0.15 && Math.abs(bx - ax) <= Math.max(0.45, (ay - by) * 1.25)) ||
          (ay <= oy - 23.45 && by < ay - 0.15 && Math.abs(bx - ax) <= Math.max(0.45, (ay - by) * 1.25))) &&
        bandPathClear(ax, ay, bx, by);
      const isZoneDCloseTarget =
        isZoneDStandTarget &&
        minDistanceToObstacles(tx, ty, obstacles) < 1.35 &&
        ay >= oy - 23.1 &&
        by >= oy - 23.1;
      const isVerticalTargetLeg =
        isZoneDStandTarget &&
        Math.abs(ax - tx) < 0.15 &&
        Math.abs(bx - tx) < 0.15 &&
        ay >= oy - 23.1 &&
        by >= oy - 23.1;
      const isHorizontalCloseTargetLeg =
        isZoneDCloseTarget &&
        Math.abs(ay - ty) < 0.15 &&
        Math.abs(by - ty) < 0.15 &&
        pathIsClear(ax, ay, bx, by, obstacles, Math.min(pad, Math.max(0.55, minDistanceToObstacles(tx, ty, obstacles) - 0.02)));
      const isOffsetDropCloseTargetLeg =
        isZoneDCloseTarget &&
        Math.abs(ax - bx) < 0.15 &&
        Math.abs(bx - tx) >= 2.0 &&
        bandPathClear(ax, ay, bx, by);
      return isVerticalStartLeg || isSouthboundStartLeg || isVerticalTargetLeg || isHorizontalCloseTargetLeg || isOffsetDropCloseTargetLeg;
    };
    const segClearCache = new Map();
    const checkSegClear = (ax, ay, bx, by, isFirst, isLast) => {
      const sKey = `${ax.toFixed(3)},${ay.toFixed(3)},${bx.toFixed(3)},${by.toFixed(3)},${isFirst ? 1 : 0},${isLast ? 1 : 0}`;
      if (segClearCache.has(sKey)) return segClearCache.get(sKey);
      const res = (() => {
        if (barrierClearAtEndpoints && !pathIsClear(ax, ay, bx, by, [zoneCStandBarrier], pad)) {
          return false;
        }
        if (!checkZoneDBandSeg(ax, ay, bx, by)) {
          return false;
        }
        if (!isFirst && !isLast) {
          const departingStandNorth =
            standDepartInfo &&
            ((isZoneDStandStart && ay >= oy - 23.1 && ay <= oy - 21.2 && by > ay + 0.3) ||
              (fy <= oy - 20.5 && ay <= oy - 23.45 && by < ay - 0.1));
          const departingChargerHorizMid =
            mode === "agf" &&
            fy <= oy - 36.5 &&
            fy >= oy - 39.25 &&
            Math.abs(fx - ox) <= 18.0 &&
            ay >= oy - 40.5 &&
            by >= oy - 40.5 &&
            ay <= oy - 34.4 &&
            by <= oy - 34.4;
          return pathIsClear(ax, ay, bx, by, obstacles, pad, null, (departingStandNorth || departingChargerHorizMid) ? pad : cornerTransitPad);
        }
        let ignore = null;
        if (isFirst && startObs.size > 0) {
          ignore = new Set();
          for (const b of startObs) {
            if (!pointInsideObs(bx, by, b)) ignore.add(b);
          }
        }
        if (isLast && endObs.size > 0) {
          if (!ignore) ignore = new Set();
          for (const b of endObs) {
            if (!pointInsideObs(ax, ay, b)) ignore.add(b);
          }
        }
        if (ignore && ignore.size > 0) {
          for (const b of ignore) {
            if (
              pointToObstacleDist(ax, ay, b) > 0.05 &&
              pointToObstacleDist(bx, by, b) > 0.05 &&
              segmentIntersectsObstacle2D(ax, ay, bx, by, b, 0.05)
            ) {
              return false;
            }
          }
        }
        const isChargerRowHorizExit =
          mode === "agf" &&
          Math.abs(fx - ox) <= 18.0 &&
          startMinDist >= 0.572 &&
          ((fy <= oy - 36.5 && fy >= oy - 37.05 && ay <= oy - 36.0 && by <= oy - 36.0 && ay >= oy - 37.05 && by >= oy - 37.05 && Math.hypot(bx - ax, by - ay) <= 5.0) ||
           (fy <= oy - 38.85 && fy >= oy - 39.25 && ay >= oy - 40.0 && by >= oy - 40.0 && ay <= oy - 38.85 && by <= oy - 38.85) ||
           (isFirst && fy > oy - 38.5 && fy <= oy - 36.5 && Math.abs(ax - bx) <= 0.05 && Math.abs(headingForward(opts.heading)[1]) >= 0.85));
        const segPad = isChargerRowHorizExit ? Math.min(pad, Math.max(0.57, startMinDist - 0.004)) : pad;
        const segCornerPad = (isFirst && (standDepartInfo || startMinDist < 2.2)) || (isLast && (needCloseTargetAlign || isSouthOfChargers)) ? segPad : cornerTransitPad;
        return pathIsClear(ax, ay, bx, by, obstacles, segPad, ignore && ignore.size > 0 ? ignore : null, segCornerPad);
      })();
      segClearCache.set(sKey, res);
      return res;
    };

    // Fast direct corridor bypass candidates (avoids outer-perimeter detours when only 1-2 obstacles intervene)
    let rackMinX = Infinity;
    let rackMaxX = -Infinity;
    let rackMinY = Infinity;
    let rackMaxY = -Infinity;
    for (const r of racks.values()) {
      const b = r.worldBounds;
      if (!b) continue;
      if (b.minX < rackMinX) rackMinX = b.minX;
      if (b.maxX > rackMaxX) rackMaxX = b.maxX;
      if (b.minY < rackMinY) rackMinY = b.minY;
      if (b.maxY > rackMaxY) rackMaxY = b.maxY;
    }
    const hasRackBounds = rackMinX < Infinity && rackMaxX > -Infinity && rackMinY < Infinity && rackMaxY > -Infinity;
    const westX = hasRackBounds ? rackMinX - 5.0 : ox - 21.0;
    const eastX = hasRackBounds ? rackMaxX + 4.20 : ox + 10.70;
    const northY = hasRackBounds ? rackMaxY + 2.1 : oy + 8.0;
    const southY = hasRackBounds ? rackMinY - 2.6 : oy - 14.5;
    const zoneDBufY = oy - 18.5;
    const eastBypassX = hasRackBounds ? Math.max(eastX + 8.8, ox + 19.5) : ox + 19.5;
    const aisleList = layout?.aisles?.length
      ? layout.aisles
      : [{ y: oy + 3.0 }, { y: oy - 3.0 }, { y: oy - 9.0 }];

    let targetAisleY = null;
    if (
      mode === "agf" &&
      hasRackBounds &&
      tx >= rackMinX - 0.5 &&
      tx <= rackMaxX + 0.5 &&
      ty >= rackMinY &&
      ty <= rackMaxY
    ) {
      let bestDy = (tx >= rackMinX && tx <= rackMaxX) ? 1.51 : 0.35;
      for (let i = 0; i < aisleList.length; i++) {
        const dy = Math.abs(ty - aisleList[i].y);
        if (dy < bestDy) {
          bestDy = dy;
          targetAisleY = aisleList[i].y;
        }
      }
    }
    const enteringAisleFromOutside =
      targetAisleY !== null &&
      !(fx >= rackMinX - 2.0 && fx <= rackMaxX + 2.0 && Math.abs(fy - targetAisleY) <= 1.5);
    let mouthAisleY = targetAisleY;
    if (
      mouthAisleY === null &&
      mode === "agf" &&
      hasRackBounds &&
      ty >= rackMinY &&
      ty <= rackMaxY &&
      ((tx >= rackMaxX - 0.5 && tx <= eastX - 0.2) || (tx >= westX + 0.2 && tx <= rackMinX + 0.5))
    ) {
      let bestMouthDy = 1.51;
      for (let i = 0; i < aisleList.length; i++) {
        const dy = Math.abs(ty - aisleList[i].y);
        if (dy < bestMouthDy) {
          bestMouthDy = dy;
          mouthAisleY = aisleList[i].y;
        }
      }
    }
    const isEastMouthTarget =
      mode === "agf" &&
      hasRackBounds &&
      !enteringAisleFromOutside &&
      mouthAisleY !== null &&
      tx >= rackMaxX - 0.5 &&
      tx <= eastX - 0.2;
    const isWestMouthTarget =
      mode === "agf" &&
      hasRackBounds &&
      !enteringAisleFromOutside &&
      mouthAisleY !== null &&
      tx >= westX + 0.2 &&
      tx <= rackMinX + 0.5;
    const isNearRackEndAisleEntry =
      targetAisleY !== null &&
      hasRackBounds &&
      Math.abs(fy - targetAisleY) <= 1.5 &&
      ((fx < rackMinX - 0.5 && tx > fx + 2.0) || (fx > rackMaxX + 0.5 && tx < fx - 2.0));

    const checkAgfDeparture = mode === "agf" && Number.isFinite(opts.heading);
    const directTurn = checkAgfDeparture
      ? Math.abs(wrapPi(Math.atan2(tx - fx, ty - fy) - opts.heading))
      : 0;
    const startMinDist = checkAgfDeparture ? minDistanceToObstacles(fx, fy, obstacles) : Infinity;
    const nearContainerStart =
      checkAgfDeparture &&
      obstacles.some((b) => b.kind === "container" && pointToObstacleDist(fx, fy, b) < 3.6);
    const nearContainerSideStart =
      nearContainerStart &&
      fy > oy + 25.0 &&
      Math.abs(wrapPi(opts.heading)) > 0.35 &&
      Math.abs(wrapPi(opts.heading - Math.PI)) > 0.35;
    const needArcCheck =
      checkAgfDeparture &&
      (startMinDist < 3.6 ||
        enteringAisleFromOutside ||
        isNearRackEndAisleEntry ||
        (startMinDist < 6.5 && directTurn > 0.35));
    const arcCache = new Map();
    const arcFailedFirstWp = new Set();
    const arcClearFor = (wpsOrWp, multiWp = false) => {
      if (!needArcCheck || !wpsOrWp) return true;
      const list = Array.isArray(wpsOrWp) ? wpsOrWp.filter(Boolean) : [wpsOrWp];
      if (list.length === 0) return true;
      const arcMaxSteps = list[0]?._rackPivot ? (list.length === 1 ? 240 : 600) : list[0]?._standPivot ? (list.length === 1 ? 240 : 420) : (standDepartInfo || multiWp) ? 420 : 270;
      const rawCheckList =
        (multiWp || standDepartInfo || (list.length >= 2 && (list[0].reverse || list[0]._rackPivot || list[0]._standPivot)))
          ? list.slice(0, 6)
          : [list[0]];
      const checkList = [rawCheckList[0]];
      if (rawCheckList.length > 1) {
        const reachDist = (arcMaxSteps / 60) * 2.8 + 1.5;
        let cumD = Math.hypot(rawCheckList[0].x - fx, rawCheckList[0].y - fy);
        for (let ci = 1; ci < rawCheckList.length; ci++) {
          if (ci >= 2 && cumD >= reachDist) break;
          cumD += Math.hypot(rawCheckList[ci].x - rawCheckList[ci - 1].x, rawCheckList[ci].y - rawCheckList[ci - 1].y);
          checkList.push(rawCheckList[ci]);
        }
      }
      const isChargerRowRev = Boolean(list[0]?.reverse && mode === "agf" && ((fy <= oy - 36.5 && fy >= oy - 37.05) || (fy <= oy - 38.85 && fy >= oy - 39.25)) && Math.abs(fx - ox) <= 18.0);
      const moveHeading = isChargerRowRev ? wrapPi(opts.heading + Math.PI) : opts.heading;
      const firstTurn = Math.abs(wrapPi(Math.atan2(list[0].x - fx, list[0].y - fy) - moveHeading));
      const tightTurnCheck = !list[0]?._rackPivot && !list[0]?._standPivot && startMinDist < 2.8 && ((isChargerRowRev ? firstTurn > 1.2 : (directTurn > 1.2 || firstTurn > 1.2)) || nearContainerSideStart);
      const wp0 = checkList[0];
      const firstWpKey = `${tightTurnCheck ? "T:" : ""}${wp0?._rackPivot ? "P:" : ""}${wp0?._standPivot ? "S:" : ""}${wp0.x.toFixed(3)},${wp0.y.toFixed(3)},${wp0.reverse ? 1 : 0},${wp0.skipTol ?? ""},${wp0.speedLimit ?? ""}`;
      if (checkList.length > 1 && arcFailedFirstWp.has(firstWpKey)) return false;
      const key = `${multiWp ? "M:" : ""}${tightTurnCheck ? "T:" : ""}${list[0]?._rackPivot ? "P:" : ""}${list[0]?._standPivot ? "S:" : ""}` + checkList
        .map((w) => `${w.x.toFixed(3)},${w.y.toFixed(3)},${w.reverse ? 1 : 0},${w.skipTol ?? ""},${w.speedLimit ?? ""}`)
        .join("|");
      if (arcCache.has(key)) return arcCache.get(key);
      const arcSimState = {
        x: fx,
        y: fy,
        heading: opts.heading,
        speed: 0,
        steerAngleRad: 0,
        forkHeightM: AGF_EMPTY_TRANSIT_FORK_Z,
        sideShiftM: 0,
        mastTiltRad: 0,
        wheelSpinRad: 0,
        lidarSpinRad: 0,
        carriedWcid: opts.carriedWcid ?? 0,
        loaded: Boolean(opts.loaded || opts.carriedWcid),
      };
      const arcMinClear = startMinDist < AGF_SPECS.hullRadiusM + 0.04 ? AGF_SPECS.hullRadiusM : AGF_SPECS.hullRadiusM + 0.04;
      const arcFail = checkList.length > 1 ? { x: fx, y: fy, step: 0, wpIdx: -1 } : null;
      let ok = isAgfArcClear(arcSimState, checkList, obstacles, arcMinClear, startMinDist, {
        maxSteps: arcMaxSteps,
        speedScales: [1.0],
        ...(arcFail ? { _failInfo: arcFail } : {}),
      });
      if (!ok && arcFail && arcFail.wpIdx === 0 && Math.hypot(wp0.x - arcFail.x, wp0.y - arcFail.y) > 1.30 && Math.hypot(wp0.x - fx, wp0.y - fy) > 1.30) {
        arcFailedFirstWp.add(firstWpKey);
      }
      if (ok && tightTurnCheck) {
        const arcFailT = checkList.length > 1 ? { x: fx, y: fy, step: 0, wpIdx: -1 } : null;
        ok = isAgfArcClear(arcSimState, checkList, obstacles, arcMinClear, startMinDist, {
          maxSteps: Math.min(arcMaxSteps, 180),
          speedScales: [0.45],
          checkTurnRunout: true,
          ...(arcFailT ? { _failInfo: arcFailT } : {}),
        });
        if (!ok && arcFailT && arcFailT.wpIdx === 0 && Math.hypot(wp0.x - arcFailT.x, wp0.y - arcFailT.y) > 1.30 && Math.hypot(wp0.x - fx, wp0.y - fy) > 1.30) {
          arcFailedFirstWp.add(firstWpKey);
        }
      }
      arcCache.set(key, ok);
      return ok;
    };

    let rackDepartInfo = null;
    let aisleAxisExitInfo = null;
    if (checkAgfDeparture && hasRackBounds && fx >= rackMinX - 0.8 && fx <= rackMaxX + 0.8) {
      let closestAisleY = null;
      let bestAisleDy = 1.75;
      for (let i = 0; i < aisleList.length; i++) {
        const dy = Math.abs(fy - aisleList[i].y);
        if (dy < bestAisleDy) {
          bestAisleDy = dy;
          closestAisleY = aisleList[i].y;
        }
      }
      if (closestAisleY !== null) {
        const [fHx, fHy] = headingForward(opts.heading);
        const facingNorthRack = fHy > 0.70;
        const facingSouthRack = fHy < -0.70;
        if (facingNorthRack || facingSouthRack) {
          let faceDist = Infinity;
          for (const r of racks.values()) {
            const b = r.worldBounds;
            if (!b || fx < b.minX - 0.8 || fx > b.maxX + 0.8) continue;
            if (facingNorthRack && b.minY >= fy - 0.35) {
              faceDist = Math.min(faceDist, b.minY - fy);
            } else if (facingSouthRack && b.maxY <= fy + 0.35) {
              faceDist = Math.min(faceDist, fy - b.maxY);
            }
          }
          if (faceDist < 2.65) {
            rackDepartInfo = {
              aisleY: closestAisleY,
              fHx,
              fHy,
              faceDist,
              facingNorthRack,
            };
          }
        } else if (
          bestAisleDy <= 1.65 &&
          fx >= rackMinX - 0.5 &&
          fx <= rackMaxX + 0.5 &&
          Math.abs(fHx) > 0.65 &&
          (targetAisleY !== closestAisleY || (fHx > 0 ? tx < fx - 0.5 : tx > fx + 0.5))
        ) {
          const isEast = fHx > 0;
          const exitX = isEast ? eastX : westX;
          const oppExitX = isEast ? westX : eastX;
          const leadX = isEast ? Math.min(eastX - 1.2, fx + 2.2) : Math.max(westX + 1.5, fx - 2.2);
          const oppLeadX = isEast ? Math.max(westX + 1.5, fx - 2.2) : Math.min(eastX - 1.2, fx + 2.2);
          const dyAxisExit = isEast && Math.abs(ty - closestAisleY) > 1.5 ? (ty < closestAisleY ? -1.2 : 1.2) : 0;
          const axisEnd = isEast
            ? [
              { x: eastX - 1.2, y: closestAisleY, skipTol: 0.35, speedLimit: 0.90, _turnThrottle: true },
              { x: eastX, y: closestAisleY, skipTol: 0.25, speedLimit: 0.70, _turnThrottle: true },
              ...(dyAxisExit !== 0 ? [{ x: eastX, y: closestAisleY + dyAxisExit, skipTol: 0.35, speedLimit: 0.95, _turnThrottle: true }] : []),
            ]
            : [
              { x: westX + 1.5, y: closestAisleY, skipTol: 0.35, speedLimit: 1.1 },
              { x: westX, y: closestAisleY, skipTol: 0.35, speedLimit: 1.0 },
            ];
          const oppAxisEnd = isEast
            ? [
              { x: westX + 1.5, y: closestAisleY, reverse: true, skipTol: 0.35, speedLimit: 0.85 },
              { x: westX, y: closestAisleY, reverse: true, skipTol: 0.35, speedLimit: 0.85 },
            ]
            : [
              { x: eastX - 1.2, y: closestAisleY, reverse: true, skipTol: 0.35, speedLimit: 0.85 },
              { x: eastX, y: closestAisleY, reverse: true, skipTol: 0.35, speedLimit: 0.85 },
            ];
          const skewedAislePrefix = [];
          const altPrefixes = [];
          if (Math.abs(fy - closestAisleY) > 0.40 && startMinDist < 0.65) {
            const oppEdgeX = isEast ? rackMinX - 0.5 : rackMaxX + 0.5;
            const oppEaseY = fy + (closestAisleY - fy) * 0.28;
            altPrefixes.push(
              [{ x: exitX, y: fy, skipTol: 0.35, speedLimit: 1.35, _turnThrottle: true }, { x: exitX, y: closestAisleY, skipTol: 0.35, speedLimit: 1.0, _turnThrottle: true }],
              [{ x: oppExitX, y: fy, reverse: true, skipTol: 0.35, speedLimit: 1.0 }, { x: oppExitX, y: closestAisleY, skipTol: 0.35, speedLimit: 1.0 }],
              [{ x: oppEdgeX, y: oppEaseY, reverse: true, skipTol: 0.35, speedLimit: 0.85 }, { x: oppExitX, y: closestAisleY, reverse: true, skipTol: 0.35, speedLimit: 0.85 }],
            );
          }
          if (Math.abs(fHy) > 0.25 || Math.abs(fy - closestAisleY) > 0.25) {
            const rx = fx - fHx * 0.90;
            const ry = fy - fHy * 0.90;
            if (Math.abs(ry - closestAisleY) <= 0.85 && pathIsClear(fx, fy, rx, ry, obstacles, 0.55)) {
              skewedAislePrefix.push({ x: rx, y: ry, reverse: true, skipTol: 0.18, speedLimit: 0.35 });
            }
            skewedAislePrefix.push({ x: leadX, y: closestAisleY, skipTol: 0.25, speedLimit: 0.45 });
            const wideLeadX = isEast ? Math.min(eastX - 1.2, fx + 4.2) : Math.max(westX + 1.5, fx - 4.2);
            for (const dRev of [0.45, 0.70, 1.05, 1.55]) {
              const rx2 = fx - fHx * dRev;
              const ry2 = fy - fHy * dRev;
              if (pathIsClear(fx, fy, rx2, ry2, obstacles, 0.50)) {
                altPrefixes.push([
                  { x: rx2, y: ry2, reverse: true, skipTol: 0.18, speedLimit: 0.35 },
                  { x: leadX, y: closestAisleY, skipTol: 0.25, speedLimit: 0.45 },
                  ...axisEnd,
                ]);
                if (dRev >= 1.0 && Math.abs(wideLeadX - leadX) > 0.6) {
                  altPrefixes.push([
                    { x: rx2, y: ry2, reverse: true, skipTol: 0.22, speedLimit: 0.45 },
                    { x: wideLeadX, y: closestAisleY, skipTol: 0.30, speedLimit: 0.65 },
                    ...axisEnd,
                  ]);
                }
                if (Math.abs(fHy) > 0.25) {
                  altPrefixes.push([
                    { x: rx2, y: ry2, reverse: true, skipTol: 0.22, speedLimit: 0.55 },
                    { x: oppLeadX, y: closestAisleY, reverse: true, skipTol: 0.30, speedLimit: 0.75 },
                    ...oppAxisEnd,
                  ]);
                }
              }
            }
            const sgnY = fHy >= 0 ? 1 : -1;
            const sideSign = isEast ? 1 : -1;
            const turnSign = sideSign * sgnY;
            const revAlignX2 = isEast ? Math.min(eastX - 0.6, fx + 2.80) : Math.max(westX + 0.6, fx - 2.80);
            const pivAlignX2 = isEast ? Math.min(eastX - 0.6, fx + 4.0) : Math.max(westX + 0.6, fx - 4.0);
            if (Math.abs(fy - closestAisleY) > 0.40) {
              const curveX = isEast ? Math.min(eastX - 1.2, fx + 3.8) : Math.max(westX + 1.5, fx - 3.8);
              altPrefixes.push([
                { x: curveX, y: closestAisleY, skipTol: 0.35, speedLimit: 0.75, _rackPivot: true },
                ...axisEnd,
              ]);
              const curveMidX = isEast ? Math.min(eastX - 1.2, fx + 1.6) : Math.max(westX + 1.5, fx - 1.6);
              altPrefixes.push([
                { x: curveMidX, y: (fy + closestAisleY) * 0.5, skipTol: 0.25, speedLimit: 0.55, _rackPivot: true },
                { x: curveX, y: closestAisleY, skipTol: 0.35, speedLimit: 0.85 },
                ...axisEnd,
              ]);
              for (const dRevAxis of [1.6, 2.4, 3.2]) {
                const arx = fx - fHx * dRevAxis;
                const ary = clamp(fy - fHy * dRevAxis + (closestAisleY - fy) * 0.25, Math.min(fy, closestAisleY), Math.max(fy, closestAisleY));
                if (pathIsClear(fx, fy, arx, ary, obstacles, 0.52)) {
                  altPrefixes.push([
                    { x: arx, y: ary, reverse: true, skipTol: 0.25, speedLimit: 0.55, _rackPivot: true },
                    { x: curveX, y: closestAisleY, skipTol: 0.35, speedLimit: 0.75 },
                    ...axisEnd,
                  ]);
                }
              }
            }
            altPrefixes.push([
              { x: fx - sideSign * 0.55, y: fy - sgnY * 0.02, reverse: true, skipTol: 0.25, speedLimit: 0.14, _rackPivot: true },
              { x: fx + sideSign * 1.20, y: fy - sgnY * 0.02, skipTol: 0.25, speedLimit: 0.40 },
              { x: revAlignX2, y: closestAisleY, skipTol: 0.35, speedLimit: 0.70 },
              ...axisEnd,
            ]);
            for (const [dPiv, angPiv] of [[0.85, 0.75], [0.55, 0.85], [0.65, 1.10], [0.55, 1.35], [0.45, 0.55], [0.45, -0.55]]) {
              altPrefixes.push([
                {
                  x: fx + Math.sin(opts.heading + turnSign * angPiv) * dPiv,
                  y: fy + Math.cos(opts.heading + turnSign * angPiv) * dPiv,
                  skipTol: 0.18,
                  speedLimit: 0.35,
                  _rackPivot: true,
                },
                { x: leadX, y: closestAisleY, skipTol: 0.30, speedLimit: 0.55 },
                ...(Math.abs(pivAlignX2 - leadX) > 0.6 ? [{ x: pivAlignX2, y: closestAisleY, skipTol: 0.35, speedLimit: 0.85 }] : []),
                ...axisEnd,
              ]);
            }
          }
          aisleAxisExitInfo = {
            aisleY: closestAisleY,
            isEast,
            fHx,
            exitX,
            prefix: [
              ...skewedAislePrefix,
              ...axisEnd,
            ],
            altPrefixes,
          };
        }
      }
    }
    const buildRackDepartPrefixes = () => {
      const aisleY = rackDepartInfo.aisleY;
      const sgn = Math.sign(rackDepartInfo.fHy);
      const rackFaceY = fy + sgn * rackDepartInfo.faceDist;
      const anchorY = rackDepartInfo.faceDist < 1.38
        ? rackFaceY - sgn * 1.40
        : fy;
      const revBase = rackDepartInfo.faceDist < 1.38
        ? [{ x: fx, y: anchorY, reverse: true, skipTol: 0.15, speedLimit: 0.45 }]
        : [];
      const wp0Y = rackDepartInfo.faceDist < 1.38 ? anchorY - sgn * 0.02 : anchorY;
      const westPrefix = [
        ...revBase,
        { x: fx + 0.55, y: wp0Y, reverse: true, skipTol: 0.25, speedLimit: 0.14 },
        { x: fx - 1.20, y: anchorY - sgn * 0.02, skipTol: 0.25, speedLimit: 0.40 },
      ];
      const eastPrefix = [
        ...revBase,
        { x: fx - 0.55, y: wp0Y, reverse: true, skipTol: 0.25, speedLimit: 0.14 },
        { x: fx + 1.20, y: anchorY - sgn * 0.02, skipTol: 0.25, speedLimit: 0.40 },
      ];
      const dyExit = Math.abs(ty - aisleY) > 1.5 ? (ty < aisleY ? -1.2 : 1.2) : 0;
      const westAisleExit = [{ x: westX, y: aisleY, skipTol: 0.45, speedLimit: 1.35, _turnThrottle: true }];
      const eastAisleExit = dyExit !== 0
        ? [
          { x: eastX - 0.9, y: aisleY, skipTol: 0.35, speedLimit: 1.0, _turnThrottle: true },
          { x: eastX, y: aisleY + dyExit, skipTol: 0.45, speedLimit: 1.1, _turnThrottle: true },
        ]
        : [{ x: eastX, y: aisleY, skipTol: 0.45, speedLimit: 1.35, _turnThrottle: true }];
      const obliquePrefixes = [];
      const sideSigns = Math.abs(rackDepartInfo.fHx) > 0.20
        ? [rackDepartInfo.fHx >= 0 ? 1 : -1]
        : (rackDepartInfo.faceDist >= 1.38 ? [1, -1] : []);
      if (fx < rackMinX + 0.25 && rackDepartInfo.facingNorthRack && rackDepartInfo.fHx <= 0.05) {
        const fwdClr = { x: fx + rackDepartInfo.fHx * 4.0, y: fy + rackDepartInfo.fHy * 4.0, skipTol: 0.35, speedLimit: 1.0 };
        obliquePrefixes.push({
          side: "west",
          pref: [fwdClr],
          revOppExit: [{ x: westX, y: northY, skipTol: 0.45 }],
        });
      }
      if (fx > rackMaxX - 0.25 && rackDepartInfo.facingNorthRack && rackDepartInfo.fHx >= -0.05) {
        const fwdClr = { x: fx + rackDepartInfo.fHx * 4.0, y: fy + rackDepartInfo.fHy * 4.0, skipTol: 0.35, speedLimit: 1.0 };
        obliquePrefixes.push({
          side: "east",
          pref: [fwdClr],
          revOppExit: [{ x: eastX, y: northY, skipTol: 0.45 }],
        });
      }
      if (fx < rackMinX + 0.25 && !rackDepartInfo.facingNorthRack && rackDepartInfo.fHx <= 0.05) {
        const fwdClr = { x: fx + rackDepartInfo.fHx * 4.0, y: fy + rackDepartInfo.fHy * 4.0, skipTol: 0.35, speedLimit: 1.0 };
        obliquePrefixes.push({
          side: "west",
          pref: [fwdClr],
          revOppExit: [{ x: westX, y: southY, skipTol: 0.45 }],
        });
      }
      if (fx > rackMaxX - 0.25 && !rackDepartInfo.facingNorthRack && rackDepartInfo.fHx >= -0.05) {
        const fwdClr = { x: fx + rackDepartInfo.fHx * 4.0, y: fy + rackDepartInfo.fHy * 4.0, skipTol: 0.35, speedLimit: 1.0 };
        obliquePrefixes.push({
          side: "east",
          pref: [fwdClr],
          revOppExit: [{ x: eastX, y: southY, skipTol: 0.45 }],
        });
      }
      for (const sideSign of sideSigns) {
        const turnSign = sideSign * sgn;
        const h0 = opts.heading;
        const alignX1 = sideSign > 0 ? Math.min(eastX - 1.2, fx + 1.5) : Math.max(westX + 1.2, fx - 1.5);
        const alignX2 = sideSign > 0 ? Math.min(eastX - 0.6, fx + 3.2) : Math.max(westX + 0.6, fx - 3.2);
        const align1Y = Math.abs(rackDepartInfo.fHx) <= 0.20 ? fy + sgn * 0.15 : aisleY;
        for (const dRev of [0.85, 1.35, 2.10, 2.70]) {
          const rx = fx - rackDepartInfo.fHx * dRev;
          const ry = fy - rackDepartInfo.fHy * dRev;
          if (Math.abs(ry - aisleY) <= 1.55 && pathIsClear(fx, fy, rx, ry, obstacles, 0.50)) {
            const revWp = { x: rx, y: ry, reverse: true, skipTol: 0.20, speedLimit: 0.45, _rackPivot: true };
            obliquePrefixes.push({
              side: sideSign > 0 ? "east" : "west",
              pref: [
                revWp,
                { x: alignX1, y: aisleY, skipTol: 0.25, speedLimit: 0.45 },
                ...(Math.abs(alignX2 - alignX1) > 0.6 ? [{ x: alignX2, y: aisleY, skipTol: 0.35, speedLimit: 0.75 }] : []),
              ],
              revOppExit: sideSign > 0
                ? [{ x: westX, y: aisleY, reverse: true, skipTol: 0.45, speedLimit: 0.90 }]
                : [{ x: eastX, y: aisleY, reverse: true, skipTol: 0.45, speedLimit: 0.90 }],
            });
            obliquePrefixes.push({
              side: sideSign > 0 ? "west" : "east",
              pref: [revWp],
              revOppExit: sideSign > 0
                ? [{ x: westX, y: aisleY, reverse: true, skipTol: 0.45, speedLimit: 0.90 }]
                : [{ x: eastX, y: aisleY, reverse: true, skipTol: 0.45, speedLimit: 0.90 }],
            });
          }
        }
        for (const [dPiv, angPiv] of [[0.42, 1.25], [0.55, 1.45], [0.70, 1.30], [0.65, 1.40]]) {
          const pivWp = {
            x: fx + Math.sin(h0 + turnSign * angPiv) * dPiv,
            y: fy + Math.cos(h0 + turnSign * angPiv) * dPiv,
            skipTol: 0.15,
            speedLimit: 0.25,
            _rackPivot: true,
          };
          const fwdPref = [
            pivWp,
            { x: alignX1, y: align1Y, skipTol: 0.25, speedLimit: 0.40 },
            ...(Math.abs(alignX2 - alignX1) > 0.6 ? [{ x: alignX2, y: aisleY, skipTol: 0.35, speedLimit: 0.75 }] : []),
          ];
          obliquePrefixes.push({
            side: sideSign > 0 ? "east" : "west",
            pref: fwdPref,
            revOppExit: sideSign > 0
              ? [{ x: westX, y: aisleY, reverse: true, skipTol: 0.45, speedLimit: 1.0 }]
              : [{ x: eastX, y: aisleY, reverse: true, skipTol: 0.45, speedLimit: 1.0 }],
          });
        }
      }
      return { aisleY, westPrefix, eastPrefix, westAisleExit, eastAisleExit, obliquePrefixes };
    };

    if (checkAgfDeparture && !rackDepartInfo) {
      const [fHx, fHy] = headingForward(opts.heading);
      let minStandDist = 1.85;
      for (let i = 0; i < obstacles.length; i++) {
        const b = obstacles[i];
        if (!b || b.kind !== "stand") continue;
        const dStand = pointToObstacleDist(fx, fy, b);
        if (dStand >= minStandDist) continue;
        const scx = (b.x0 + b.x1) * 0.5;
        const scy = (b.y0 + b.y1) * 0.5;
        const sd = Math.hypot(scx - fx, scy - fy);
        const dot = sd > 1e-4 ? ((scx - fx) * fHx + (scy - fy) * fHy) / sd : 0;
        minStandDist = dStand;
        standDepartInfo = { fHx, fHy, faceDist: dStand, dot };
      }
    }

    const crossAisleY = oy + 20.0;
    const isZoneAPadApproachTarget =
      mode === "agf" &&
      ty >= oy + 20.5 &&
      ty <= oy + 24.85 &&
      tx >= ox - 45.0 &&
      tx <= ox - 4.0 &&
      !obstacles.some((b) => b?.kind === "container" && pointToObstacleDist(tx, ty, b) <= 1.35);
    const isAlignedZoneASouthApproach =
      isZoneAPadApproachTarget &&
      Math.abs(fx - tx) <= 0.35 &&
      fy <= ty &&
      fy >= crossAisleY - 1.5;

    let isLiftTableAgfTarget = false;
    if (mode === "agf" && opts.ignoreLiftTableObstacles !== true) {
      for (const lt of liftTables.values()) {
        if (lt.agfApproachPos && Math.hypot(tx - lt.agfApproachPos[0], ty - lt.agfApproachPos[1]) <= 0.15) {
          isLiftTableAgfTarget = true;
          break;
        }
      }
    }
    let closeTargetObs = null;
    let closeTargetDist = Infinity;
    const minTargetObsDist = (mode === "agf" && opts.docking !== true) ? minDistanceToObstacles(tx, ty, obstacles) : Infinity;
    const offCenterCloseAisle = targetAisleY !== null && Math.abs(ty - targetAisleY) > 0.40 && minTargetObsDist < 1.35;
    const hasTargetHeading = mode === "agf" && Number.isFinite(opts.targetHeading);
    const hasTargetDocking = mode === "agf" && Boolean(opts.targetDocking);
    const closeAlignMaxDist = (hasTargetHeading && hasTargetDocking) ? 2.15 : 2.08;
    if (
      mode === "agf" &&
      opts.docking !== true &&
      (targetAisleY === null || offCenterCloseAisle) &&
      ((hasTargetHeading && hasTargetDocking) ||
        ((!isSouthOfChargers || minTargetObsDist < 1.35) &&
          (!isZoneDStandTarget || minTargetObsDist < 1.32) &&
          (!isZoneCStandTarget || minTargetObsDist < 1.32))) &&
      !isLiftTableAgfTarget &&
      (!enteringAisleFromOutside || offCenterCloseAisle) &&
      !isZoneAPadApproachTarget
    ) {
      for (let i = 0; i < obstacles.length; i++) {
        const b = obstacles[i];
        if (!b) continue;
        const dObs = pointToObstacleDist(tx, ty, b);
        if (dObs < closeTargetDist) {
          closeTargetDist = dObs;
          closeTargetObs = b;
        }
      }
    }
    const needCloseTargetAlign = Boolean(closeTargetObs && closeTargetDist >= 0.42 && closeTargetDist <= closeAlignMaxDist);
    const isMidAisleBehind =
      mode === "agf" &&
      checkAgfDeparture &&
      targetAisleY !== null &&
      hasRackBounds &&
      fx >= rackMinX - 0.5 &&
      fx <= rackMaxX + 0.5 &&
      Math.abs(fy - targetAisleY) <= 1.2 &&
      Math.abs(ty - fy) <= 0.5 &&
      directTurn > 2.0 &&
      checkSegClear(fx, fy, tx, ty, true, true);
    if (isMidAisleBehind) {
      const revSub = subdivideWaypoints(fx, fy, [{ x: tx, y: ty, reverse: true }], 4.5);
      const midSteps = Math.min(2400, Math.max(600, Math.ceil(distDirect * 150)));
      const midClear = (wps) => {
        const sub = subdivideWaypoints(fx, fy, wps, 4.5);
        for (let i = 0; i < sub.length; i++) {
          const a = i === 0 ? { x: fx, y: fy } : sub[i - 1];
          const b = sub[i];
          if (!checkSegClear(a.x, a.y, b.x, b.y, i === 0, i === sub.length - 1)) return false;
        }
        return isAgfArcClear(
          {
            x: fx,
            y: fy,
            heading: opts.heading,
            speed: 0,
            steerAngleRad: 0,
            forkHeightM: AGF_EMPTY_TRANSIT_FORK_Z,
            sideShiftM: 0,
            mastTiltRad: 0,
            wheelSpinRad: 0,
            lidarSpinRad: 0,
            carriedWcid: opts.carriedWcid ?? 0,
            loaded: Boolean(opts.loaded || opts.carriedWcid),
          },
          sub,
          obstacles,
          AGF_SPECS.hullRadiusM,
          startMinDist,
          { maxSteps: midSteps + 600, speedScales: [1.0], requireArrival: true },
        );
      };
      if (Math.abs(ty - fy) <= 0.08 && midClear(revSub)) {
        return revSub;
      }
      const [fHxMid] = headingForward(opts.heading);
      const aisleDirX = Math.abs(fHxMid) >= 0.35 ? Math.sign(fHxMid) : Math.sign(fx - tx || 1);
      const midCands = [];
      for (const dShift of [2.6, 3.2, 3.8]) {
        midCands.push([
          { x: tx - aisleDirX * dShift, y: targetAisleY, reverse: true, skipTol: 0.25, speedLimit: 0.85 },
          { x: tx, y: ty, speedLimit: 0.85 },
        ]);
        midCands.push([
          { x: tx + aisleDirX * dShift, y: targetAisleY, skipTol: 0.25, speedLimit: 0.90 },
          { x: tx, y: ty, reverse: true, speedLimit: 0.85 },
        ]);
      }
      if (midClear(revSub)) return revSub;
      for (const mc of midCands) {
        if (midClear(mc)) {
          return subdivideWaypoints(fx, fy, mc, 4.5);
        }
      }
    }
    const [fHxDirect, fHyDirect] = checkAgfDeparture ? headingForward(opts.heading) : [0, 0];
    const isAlignedSouthCharger =
      isSouthOfChargersStart &&
      isSouthOfChargers &&
      Math.abs(ty - fy) < 0.25 &&
      (!checkAgfDeparture || (Math.abs(fHyDirect) < 0.25 && (tx - fx) * fHxDirect > 0));
    const directSub = mode === "agf" ? subdivideWaypoints(fx, fy, [{ x: tx, y: ty }], 4.5) : [{ x: tx, y: ty }];
    const needDirectArrivalCheck = Boolean(
      checkAgfDeparture &&
      distDirect <= 3.0 &&
      (Number.isFinite(opts.targetHeading) || opts.targetDocking || distDirect <= 1.5 || startMinDist < 2.2),
    );
    const directArcSub = needDirectArrivalCheck && directSub.length > 0 && (Number.isFinite(opts.targetHeading) || opts.targetDocking)
      ? [
          ...directSub.slice(0, -1),
          {
            ...directSub[directSub.length - 1],
            ...(Number.isFinite(opts.targetHeading) ? { heading: opts.targetHeading } : {}),
            ...(opts.targetDocking ? { docking: true } : {}),
          },
        ]
      : directSub;
    if (
      !needCloseTargetAlign &&
      !isZoneCStandTarget &&
      !(isZoneAPadApproachTarget && !isAlignedZoneASouthApproach) &&
      !(enteringAisleFromOutside && directTurn > 0.35) &&
      !(isNearRackEndAisleEntry && directTurn > 0.35) &&
      !(rackDepartInfo && directTurn > 0.35) &&
      !(standDepartInfo && directTurn > 0.35) &&
      !(isSouthOfChargers && !isAlignedSouthCharger) &&
      !(isSouthOfChargersStart && fy > oy - 41.5 && ty > oy - 39.0) &&
      checkSegClear(fx, fy, tx, ty, true, true) &&
      arcClearFor(directSub.slice(0, 6), true) &&
      (!checkAgfDeparture ||
        opts.validateFullRoute === false ||
        isAgfArcClear(
          {
            x: fx,
            y: fy,
            heading: opts.heading,
            speed: 0,
            steerAngleRad: 0,
            forkHeightM: AGF_EMPTY_TRANSIT_FORK_Z,
            sideShiftM: 0,
            mastTiltRad: 0,
            wheelSpinRad: 0,
            lidarSpinRad: 0,
            carriedWcid: opts.carriedWcid ?? 0,
            loaded: Boolean(opts.loaded || opts.carriedWcid),
          },
          directArcSub,
          obstacles,
          AGF_SPECS.hullRadiusM + 0.02,
          startMinDist,
          {
            maxSteps: needDirectArrivalCheck
              ? Math.min(2400, Math.max(600, Math.ceil(distDirect * 150)))
              : Math.min(2400, Math.max(420, Math.ceil(distDirect * 32))),
            speedScales: [1.0],
            ...(needDirectArrivalCheck ? { requireArrival: true } : {}),
          },
        ))
    ) {
      return directSub;
    }

    const buildAisleEntrySuffix = (side, arrX, arrY) => {
      const isWest = side === "west";
      const spineX = isWest ? westX : eastX;
      const aisleTurnSpeedLimit = 1.15;
      const turnExitX = isWest ? spineX + 1.25 : spineX - 1.25;
      const rawMouthX = isWest
        ? (hasRackBounds ? rackMinX - 1.6 : ox - 17.6)
        : (hasRackBounds ? rackMaxX + 1.1 : ox + 7.6);
      const mouthX = isWest ? Math.min(rawMouthX, tx) : Math.max(rawMouthX, tx);
      const pts = [];
      if (!isWest) {
        if (arrY > targetAisleY + 7.5 && Math.abs(arrX - spineX) > 1.5) {
          const highY = Math.min(arrY - 1.5, Math.max(northY + 3.0, targetAisleY + 6.5));
          if (highY > targetAisleY + 3.8) {
            pts.push({ x: spineX, y: highY, skipTol: 0.75 });
          }
        }
        if (arrY < targetAisleY - 3.2) {
          pts.push({ x: spineX, y: targetAisleY - 3.0, skipTol: 0.45 });
        } else if (arrY <= targetAisleY - 1.0) {
          pts.push({ x: spineX, y: targetAisleY - 2.6, skipTol: 0.45 });
        } else if (arrY > targetAisleY + 3.2) {
          pts.push({ x: spineX, y: targetAisleY + 3.0, skipTol: 0.45 });
        } else if (arrY >= targetAisleY + 1.0) {
          pts.push({ x: spineX, y: targetAisleY + 2.6, skipTol: 0.45 });
        }
      } else if (
        arrX < westX - 4.0 ||
        arrX > eastX + 4.0 ||
        arrY < southY - 2.0
      ) {
        if (arrY < targetAisleY - 3.2) {
          pts.push({ x: spineX, y: targetAisleY - 3.0, skipTol: 0.45 });
        } else if (arrY < targetAisleY - 1.2 && Math.abs(arrX - spineX) > 2.0) {
          pts.push({ x: spineX, y: targetAisleY - 2.6, skipTol: 0.45 });
        } else if (arrY > targetAisleY + 3.2) {
          pts.push({ x: spineX, y: targetAisleY + 3.0, skipTol: 0.45 });
        } else if (arrY > targetAisleY + 1.2 && Math.abs(arrX - spineX) > 2.0) {
          pts.push({ x: spineX, y: targetAisleY + 2.6, skipTol: 0.45 });
        }
      }
      const aisleNavY = targetAisleY;
      if ((!isWest && arrY <= aisleNavY - 1.0) || (isWest && arrY < aisleNavY - 1.2)) {
        pts.push({ x: spineX, y: aisleNavY - 0.85, skipTol: 0.35 });
      } else if ((!isWest && arrY >= aisleNavY + 1.0) || (isWest && arrY > aisleNavY + 1.2)) {
        pts.push({ x: spineX, y: aisleNavY + 0.85, skipTol: 0.35 });
      } else if (isWest && arrX < spineX - 1.2) {
        pts.push({ x: spineX - 0.85, y: aisleNavY, skipTol: 0.35 });
      } else if (!isWest && arrX > spineX + 1.2) {
        pts.push({ x: spineX + 0.85, y: aisleNavY, skipTol: 0.35 });
      }
      pts.push({ x: spineX, y: aisleNavY, skipTol: 0.30, speedLimit: aisleTurnSpeedLimit });
      if (!offCenterCloseAisle || (isWest ? tx - turnExitX >= 3.8 : turnExitX - tx >= 3.8)) {
        pts.push({ x: turnExitX, y: aisleNavY, skipTol: 0.35, speedLimit: isWest ? 1.15 : 1.20 });
      }
      if (!offCenterCloseAisle || (isWest ? tx - mouthX >= 3.8 : mouthX - tx >= 3.8)) {
        const mouthNearTgt = Math.hypot(mouthX - tx, aisleNavY - ty) < 0.85;
        pts.push({
          x: mouthX,
          y: aisleNavY,
          skipTol: mouthNearTgt ? 0.20 : 0.40,
          speedLimit: mouthNearTgt ? 0.75 : 1.25,
        });
      }
      if (isWest ? tx > mouthX + 1.5 : tx < mouthX - 1.5) {
        const alignBack = offCenterCloseAisle
          ? ((isWest ? tx - 5.4 > mouthX + 1.8 : tx + 5.4 < mouthX - 1.8) ? 5.4 : 3.6)
          : 0;
        const alignInX = offCenterCloseAisle
          ? (isWest
            ? Math.min(tx - alignBack, hasRackBounds ? rackMaxX - 1.2 : tx - alignBack)
            : Math.max(tx + alignBack, hasRackBounds ? rackMinX + 1.2 : tx + alignBack))
          : (isWest
            ? Math.min(tx, hasRackBounds ? rackMinX + 0.2 : ox - 15.8)
            : Math.max(tx, hasRackBounds ? rackMaxX - 0.2 : ox + 6.3));
        if (
          (isWest ? (alignInX > mouthX + 0.5 && alignInX < tx - 0.35) : (alignInX < mouthX - 0.5 && alignInX > tx + 0.35)) &&
          (!offCenterCloseAisle || Math.abs(alignInX - mouthX) >= 1.8)
        ) {
          pts.push({ x: alignInX, y: targetAisleY, skipTol: offCenterCloseAisle ? 0.35 : 0.45, speedLimit: offCenterCloseAisle ? 1.15 : 1.95 });
        }
      }
      return pts;
    };

    const rankedShortcuts = [];
    let bestShortcut = null;
    let bestShortcutScore = Infinity;
    let bestCorridorScore = Infinity;
    let corridorShortcutCount = 0;
    const [fHxStart, fHyStart] = checkAgfDeparture ? headingForward(opts.heading) : [0, 0];
    const useMultiWpArc = Boolean(
      (!nearContainerStart || nearContainerSideStart || (isZoneAPadApproachTarget && fy > oy + 23.0)) &&
        (enteringAisleFromOutside ||
          isNearRackEndAisleEntry ||
          isSouthOfChargersStart ||
          nearContainerSideStart ||
          (isZoneAPadApproachTarget && fy > oy + 23.0) ||
          (startMinDist < 2.8 && directTurn > 1.2))
    );
    const scoreSeqCache = new Map();
    const scoreSeq = (seq) => {
      const filteredSeq = [];
      for (let i = 0; i < seq.length; i++) {
        const p = seq[i];
        if (!p) continue;
        const dStart = Math.hypot(p.x - fx, p.y - fy);
        if ((p.reverse ? dStart > 0.05 : dStart > 0.35) && Math.hypot(p.x - tx, p.y - ty) > 0.35) {
          filteredSeq.push(p);
        }
      }
      const pts = [{ x: fx, y: fy }, ...filteredSeq, { x: tx, y: ty }];
      const seqKey = filteredSeq.map((w) => `${w.x.toFixed(2)},${w.y.toFixed(2)},${w.reverse ? 1 : 0},${w.skipTol ?? ""},${w.speedLimit ?? ""}`).join("|");
      if (scoreSeqCache.has(seqKey)) return scoreSeqCache.get(seqKey);
      for (let i = 0; i < pts.length - 1; i++) {
        if (!checkSegClear(pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y, i === 0, i === pts.length - 2)) {
          scoreSeqCache.set(seqKey, Infinity);
          return Infinity;
        }
      }
      if ((rackDepartInfo || standDepartInfo) && !pts[1]?.reverse && !pts[1]?._rackPivot && !pts[1]?._standPivot) {
        const firstTurn = Math.abs(wrapPi(Math.atan2(pts[1].x - fx, pts[1].y - fy) - opts.heading));
        if (firstTurn > 0.35) {
          scoreSeqCache.set(seqKey, Infinity);
          return Infinity;
        }
      }
      if (aisleAxisExitInfo && !pts[1]?.reverse && !(pts[1]?._rackPivot && Math.abs(fy - aisleAxisExitInfo.aisleY) > 0.40 && startMinDist < 0.65)) {
        const firstTurn = Math.abs(wrapPi(Math.atan2(pts[1].x - fx, pts[1].y - fy) - opts.heading));
        if (firstTurn > 0.35 || (pts[1].x > rackMinX - 0.5 && pts[1].x < rackMaxX + 0.5 && Math.abs(pts[1].y - aisleAxisExitInfo.aisleY) > 0.40)) {
          scoreSeqCache.set(seqKey, Infinity);
          return Infinity;
        }
      }
      let d = 0;
      for (let i = 0; i < pts.length - 1; i++) {
        d += Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y);
      }
      if (pts[1]?.reverse) {
        d += 2.5;
      } else if (Number.isFinite(opts.heading)) {
        const firstTurn = Math.abs(wrapPi(Math.atan2(pts[1].x - fx, pts[1].y - fy) - opts.heading));
        d += firstTurn * 3.0;
      }
      if (
        mode === "agf" &&
        !isZoneCStandTarget &&
        stands.size >= 6 &&
        tx > ox + 14.57 &&
        ty >= oy - 10.84 &&
        ty <= oy + 4.84 &&
        fx <= ox + 13.43
      ) {
        const lastWp = pts[pts.length - 2];
        if (lastWp && lastWp.x < ox + 14.0) {
          d += 25.0;
        }
      }
      if (isEastMouthTarget && fx < rackMinX - 0.5 && Math.abs(ty - mouthAisleY) > 0.35) {
        const entersFromEast = pts.slice(1, -1).some((p) => p.x >= rackMaxX + 2.0);
        if (!entersFromEast) d += 18.0;
      }
      if (isWestMouthTarget && fx > rackMaxX + 0.5 && Math.abs(ty - mouthAisleY) > 0.35) {
        const entersFromWest = pts.slice(1, -1).some((p) => p.x <= rackMinX - 2.0);
        if (!entersFromWest) d += 18.0;
      }
      if (
        mode === "agf" &&
        needCloseTargetAlign &&
        closeTargetObs?.kind === "rack" &&
        closeTargetDist < 0.62 &&
        pts.length >= 4 &&
        Math.abs((pts[pts.length - 2]?.y ?? 0) - ty) < 0.25 &&
        Math.abs((pts[pts.length - 2]?.x ?? 0) - tx) > 6.0 &&
        Math.abs((pts[pts.length - 3]?.y ?? 0) - ty) > 1.5
      ) {
        d += 10.0;
      }
      const keepEastApronBypass =
        mode === "agf" &&
        !isZoneCStandTarget &&
        tx >= ox + 13.4 &&
        ty >= oy - 13.0 &&
        ty <= oy + 7.5 &&
        pts.some((p) => p.x >= ox + 17.0);
      const isZoneACloseContainerFlank =
        mode === "agf" &&
        fy > oy + 38.5 &&
        ty > oy + 24.0 &&
        needCloseTargetAlign &&
        closeTargetObs?.kind === "container" &&
        ty <= closeTargetObs.y1;
      const keepZoneABypass = isZoneACloseContainerFlank && pts.some((p) => Math.abs(p.y - crossAisleY) <= 0.5);
      if (isZoneACloseContainerFlank && !keepZoneABypass) {
        d += 45.0;
      } else if (
        keepZoneABypass &&
        (opts.carriedWcid || opts.loaded) &&
        pts.some((p) => Math.abs(p.y - (crossAisleY + 5.7)) <= 0.25)
      ) {
        d = Math.max(1.0, d - 28.0);
      }
      const isZoneANorthContainer =
        mode === "agf" &&
        ty > oy + 38.0 &&
        needCloseTargetAlign &&
        closeTargetObs?.kind === "container" &&
        ty > closeTargetObs.y1;
      const usesZoneANorthCorridor = isZoneANorthContainer && pts.some((p) => p.y >= oy + 40.0 && p.y <= oy + 42.5);
      if (isZoneANorthContainer && !usesZoneANorthCorridor) {
        d += 20.0;
      }
      const keepShortContainerStage =
        mode === "agf" &&
        distDirect < 8.0 &&
        fy > oy + 24.0 &&
        fy <= oy + 38.5 &&
        ty > oy + 24.0 &&
        needCloseTargetAlign &&
        closeTargetObs?.kind === "container" &&
        closeTargetDist < 0.85 &&
        pts.some((p) => Math.abs(p.y - crossAisleY) <= 0.5 || Math.abs(p.y - (oy + 40.5)) <= 0.5);
      if (usesZoneANorthCorridor) {
        if (corridorShortcutCount >= 10 && Number.isFinite(bestCorridorScore) && d >= bestCorridorScore * 1.45) {
          scoreSeqCache.set(seqKey, Infinity);
          return Infinity;
        }
      } else if (!keepEastApronBypass && !keepZoneABypass && !keepShortContainerStage && rankedShortcuts.length >= 20 && Number.isFinite(bestShortcutScore) && d >= bestShortcutScore * 1.45) {
        scoreSeqCache.set(seqKey, Infinity);
        return Infinity;
      }
      if (
        needArcCheck &&
        !arcClearFor(
          subdivideWaypoints(fx, fy, pts.slice(1), 4.5).slice(0, useMultiWpArc ? 6 : 4),
          useMultiWpArc,
        )
      ) {
        scoreSeqCache.set(seqKey, Infinity);
        return Infinity;
      }
      if (usesZoneANorthCorridor) {
        corridorShortcutCount++;
        if (d < bestCorridorScore) bestCorridorScore = d;
      }
      scoreSeqCache.set(seqKey, d);
      return d;
    };

    if (mode === "amr") {
      const amrGapX = Math.max(ox - 15.0, Math.min(ox + 15.0, Math.round((fx - (ox - 16.5)) / 3) * 3 + (ox - 16.5) + 1.5));
      const cands = [
        [{ x: fx, y: oy - 11.8 }, { x: ox - 18.2, y: oy - 20.5 }],
        [{ x: ox + 15.6, y: oy - 11.8 }, { x: ox - 18.2, y: oy - 20.5 }],
        [{ x: fx, y: oy - 20.5 }],
        [{ x: fx, y: oy - 20.5 }, { x: tx, y: oy - 20.5 }],
        [{ x: ox + 16.2, y: oy - 20.5 }],
        [{ x: fx, y: oy - 20.5 }, { x: ox + 16.2, y: oy - 20.5 }],
        [{ x: amrGapX, y: oy - 20.5 }, { x: tx, y: oy - 20.5 }],
        [{ x: amrGapX, y: oy - 20.5 }, { x: ox + 16.2, y: oy - 20.5 }],
        [{ x: fx, y: oy - 26.5 }, { x: ox + 18.5, y: oy - 26.5 }, { x: ox + 18.5, y: ty }],
        [{ x: fx, y: oy - 27.5 }, { x: ox + 17.5, y: oy - 27.5 }],
      ];
      for (const seq of cands) {
        const sc = scoreSeq(seq);
        if (sc < bestShortcutScore) {
          bestShortcutScore = sc;
          bestShortcut = seq;
        }
      }
    } else if (mode === "agf") {
      const zoneDBufTarget = { x: tx, y: zoneDBufY, skipTol: 0.35 };
      const zoneAPadPre = { x: tx, y: crossAisleY, skipTol: 0.45, speedLimit: 1.5 };
      const padFromSouth = fy < crossAisleY - 4.5;
      const northWestTurnY = hasRackBounds ? Math.max(northY, oy + 8.65) : oy + 8.65;
      const southChargerLaneY = isSouthOfChargers ? Math.min(ty, (needCloseTargetAlign && ty > oy - 39.25) ? oy - 39.85 : oy - 39.45) : ty;
      const zoneDHwyPullOff = (needCloseTargetAlign && closeTargetDist < 0.85) ? 7.5 : 3.8;
      const westZoneDTail = isSouthOfChargers
        ? (tx <= ox - 13.5 && needCloseTargetAlign && Math.abs(ty - (oy - 39.03)) <= 0.35
          ? [
            { x: westX, y: ty, skipTol: 0.30, speedLimit: 0.85, _noSubdivideSpeed: true },
            { x: ox - 17.5, y: ty, skipTol: 0.20, speedLimit: 0.70, _noSubdivideSpeed: true },
          ]
          : [
          { x: westX, y: southChargerLaneY + 3.0, skipTol: 0.45 },
          { x: westX, y: southChargerLaneY + 1.8, skipTol: 0.30, speedLimit: 0.85, _noSubdivideSpeed: true },
          { x: westX, y: southChargerLaneY, skipTol: 0.22, speedLimit: 0.60, _noSubdivideSpeed: true },
          ...(tx > ox - 18.5 && (!(southChargerLaneY < ty - 0.05 && needCloseTargetAlign) || ox - 18.5 <= tx - 3.6) ? [{ x: ox - 18.5, y: southChargerLaneY, skipTol: 0.22, speedLimit: 0.75, _noSubdivideSpeed: true }] : []),
          ...(tx > ox - 16.0 && (!(southChargerLaneY < ty - 0.05 && needCloseTargetAlign) || ox - 16.2 <= tx - 3.6) ? [{ x: ox - 16.2, y: southChargerLaneY, skipTol: 0.25, speedLimit: 1.0, _noSubdivideSpeed: true }] : []),
          ...(southChargerLaneY < ty - 0.05
            ? (needCloseTargetAlign
              ? (tx - 4.2 > westX + 0.5 ? [{ x: tx - 4.2, y: southChargerLaneY, skipTol: 0.30, speedLimit: 0.85, _noSubdivideSpeed: true }] : [])
              : [{ x: tx, y: southChargerLaneY, skipTol: 0.30, speedLimit: 0.85, _noSubdivideSpeed: true }])
            : []),
        ])
        : (ty >= oy - 38.5 && ty <= oy - 36.75 && Math.abs(tx - ox) <= 18.0)
          ? (tx <= ox - 13.5
            ? [
              { x: westX, y: zoneDHwyY, skipTol: 0.45 },
              { x: westX, y: oy - 34.5, skipTol: 0.45 },
              { x: ox - 17.5, y: oy - 34.5, skipTol: 0.30, speedLimit: 0.85, _noSubdivideSpeed: true },
              { x: ox - 17.5, y: ty, skipTol: 0.20, speedLimit: 0.70, _noSubdivideSpeed: true },
            ]
            : tx >= ox + 13.5
              ? [
                { x: westX, y: zoneDHwyY, skipTol: 0.45 },
                { x: westX, y: oy - 34.5, skipTol: 0.45 },
                { x: ox + 17.5, y: oy - 34.5, skipTol: 0.30, speedLimit: 0.85, _noSubdivideSpeed: true },
                { x: ox + 17.5, y: ty, skipTol: 0.20, speedLimit: 0.70, _noSubdivideSpeed: true },
              ]
              : [
                { x: westX, y: zoneDHwyY, skipTol: 0.45 },
                { x: westX, y: oy - 32.0, skipTol: 0.30, speedLimit: 0.80, _noSubdivideSpeed: true },
                { x: westX, y: oy - 34.5, skipTol: 0.16, speedLimit: 0.60, _noSubdivideSpeed: true },
                { x: tx - 5.2 >= westX ? tx - 5.2 : westX, y: oy - 34.5, skipTol: 0.18, speedLimit: 0.65, _noSubdivideSpeed: true },
              ])
          : [
            { x: westX, y: zoneDHwyY, skipTol: 0.45 },
            { x: (needCloseTargetAlign && Math.abs(tx - ox) <= 18.0 && ty > oy - 29.0 && ty < oy - 24.6) ? Math.max(westX + 0.5, tx - zoneDHwyPullOff) : tx, y: zoneDHwyY, skipTol: 0.45 },
          ];
      const eastZoneDTail = isSouthOfChargers
        ? (tx >= ox + 13.5 && needCloseTargetAlign && Math.abs(ty - (oy - 39.03)) <= 0.35
          ? [
            { x: eastX, y: zoneDBufY, skipTol: 0.45 },
            { x: eastBypassX, y: zoneDBufY, skipTol: 0.45 },
            { x: eastBypassX, y: ty, skipTol: 0.30, speedLimit: 0.85, _noSubdivideSpeed: true },
            { x: ox + 17.5, y: ty, skipTol: 0.20, speedLimit: 0.70, _noSubdivideSpeed: true },
          ]
          : [
          { x: eastX, y: zoneDBufY, skipTol: 0.45 },
          { x: eastBypassX, y: zoneDBufY, skipTol: 0.45 },
          { x: eastBypassX, y: southChargerLaneY + 3.0, skipTol: 0.45 },
          { x: eastBypassX, y: southChargerLaneY + 1.8, skipTol: 0.30, speedLimit: 0.85, _noSubdivideSpeed: true },
          { x: eastBypassX, y: southChargerLaneY, skipTol: 0.22, speedLimit: 0.60, _noSubdivideSpeed: true },
          ...(tx < ox + 17.5 && (!(southChargerLaneY < ty - 0.05 && needCloseTargetAlign) || ox + 17.8 >= tx + 3.6) ? [{ x: ox + 17.8, y: southChargerLaneY, skipTol: 0.22, speedLimit: 0.75, _noSubdivideSpeed: true }] : []),
          ...(tx < ox + 16.0 && (!(southChargerLaneY < ty - 0.05 && needCloseTargetAlign) || ox + 16.2 >= tx + 3.6) ? [{ x: ox + 16.2, y: southChargerLaneY, skipTol: 0.25, speedLimit: 1.0, _noSubdivideSpeed: true }] : []),
          ...(southChargerLaneY < ty - 0.05
            ? (needCloseTargetAlign
              ? (tx + 4.2 < eastBypassX - 0.5 ? [{ x: tx + 4.2, y: southChargerLaneY, skipTol: 0.30, speedLimit: 0.85, _noSubdivideSpeed: true }] : [])
              : [{ x: tx, y: southChargerLaneY, skipTol: 0.30, speedLimit: 0.85, _noSubdivideSpeed: true }])
            : []),
        ])
        : (ty >= oy - 38.5 && ty <= oy - 36.75 && Math.abs(tx - ox) <= 18.0)
          ? (tx >= ox + 13.5
            ? [
              { x: eastX, y: zoneDBufY, skipTol: 0.45 },
              { x: eastBypassX, y: zoneDBufY, skipTol: 0.45 },
              { x: eastBypassX, y: oy - 34.5, skipTol: 0.45 },
              { x: ox + 17.5, y: oy - 34.5, skipTol: 0.30, speedLimit: 0.85, _noSubdivideSpeed: true },
              { x: ox + 17.5, y: ty, skipTol: 0.20, speedLimit: 0.70, _noSubdivideSpeed: true },
            ]
            : [
              { x: eastX, y: zoneDBufY, skipTol: 0.45 },
              { x: eastBypassX, y: zoneDBufY, skipTol: 0.45 },
              { x: eastBypassX, y: oy - 32.0, skipTol: 0.30, speedLimit: 0.80, _noSubdivideSpeed: true },
              { x: eastBypassX, y: oy - 34.5, skipTol: 0.16, speedLimit: 0.60, _noSubdivideSpeed: true },
              { x: tx + 5.2 <= eastBypassX ? tx + 5.2 : eastBypassX, y: oy - 34.5, skipTol: 0.18, speedLimit: 0.65, _noSubdivideSpeed: true },
            ])
          : [
            { x: eastX, y: zoneDBufY, skipTol: 0.45 },
            { x: eastBypassX, y: zoneDBufY, skipTol: 0.45 },
            { x: eastBypassX, y: zoneDHwyY, skipTol: 0.45 },
            { x: (needCloseTargetAlign && Math.abs(tx - ox) <= 18.0 && ty > oy - 29.0 && ty < oy - 24.6) ? Math.min(eastBypassX - 0.5, tx + zoneDHwyPullOff) : tx, y: zoneDHwyY, skipTol: 0.45 },
          ];
      const isTightNorthRackFlank = hasRackBounds && needCloseTargetAlign && closeTargetObs?.kind === "rack" && closeTargetDist < 0.85 && ty > rackMaxY && ty <= northY;
      const isTightSouthRackFlank = hasRackBounds && needCloseTargetAlign && closeTargetObs?.kind === "rack" && closeTargetDist < 0.85 && ty < rackMinY && ty >= southY;
      const isZoneDNorthBandNonApproach = !isZoneDStandTarget && !isZoneDTarget && stands.size >= 18 && ty >= oy - 23.45 && ty <= oy - 20.2 && Math.abs(tx - ox) <= 18.0;
      const westTargetSeq = isZoneDStandTarget
        ? [{ x: westX, y: zoneDBufY, skipTol: 0.45 }, zoneDBufTarget]
        : isZoneCStandTarget
          ? [{ x: westX, y: northY, skipTol: 0.45 }, { x: eastX, y: northY, skipTol: 0.35, speedLimit: 1.35 }, { x: eastX, y: ty, skipTol: 0.35, speedLimit: 1.5 }]
        : isZoneDTarget
          ? westZoneDTail
          : isZoneDNorthBandNonApproach
            ? [{ x: westX, y: zoneDBufY, skipTol: 0.45 }, { x: tx, y: zoneDBufY, skipTol: 0.35 }]
          : isZoneAPadApproachTarget
            ? [
              ...(padFromSouth ? [{ x: westX, y: crossAisleY - 4.0, skipTol: 0.45 }] : []),
              { x: westX, y: crossAisleY, skipTol: 0.45, speedLimit: 1.5 },
              zoneAPadPre,
            ]
            : isTightNorthRackFlank && tx > westX + 6.0
              ? [{ x: westX, y: northY, skipTol: 0.45 }, { x: Math.max(westX + 2.0, tx - 6.5), y: northY, skipTol: 0.35, speedLimit: 1.0 }]
              : isTightSouthRackFlank && tx > westX + 6.0
                ? [{ x: westX, y: southY, skipTol: 0.45 }, { x: Math.max(westX + 2.0, tx - 6.5), y: southY, skipTol: 0.35, speedLimit: 1.0 }]
                : (hasRackBounds && tx > rackMaxX && tx < eastX && ty > southY && ty < northY)
                  ? [{ x: westX, y: southY, skipTol: 0.45 }, { x: eastX, y: southY, skipTol: 0.35, speedLimit: 1.25 }, { x: eastX, y: ty, skipTol: 0.35 }]
                  : [{ x: westX, y: ty }];
      const eastTargetSeq = isZoneDStandTarget
        ? [{ x: eastX, y: zoneDBufY, skipTol: 0.45 }, zoneDBufTarget]
        : isZoneCStandTarget
          ? [{ x: eastX, y: ty, skipTol: 0.35, speedLimit: 1.5 }]
        : isZoneDTarget
          ? eastZoneDTail
          : isZoneDNorthBandNonApproach
            ? [{ x: eastX, y: zoneDBufY, skipTol: 0.45 }, { x: tx, y: zoneDBufY, skipTol: 0.35 }]
          : isZoneAPadApproachTarget
            ? [
              ...(padFromSouth ? [{ x: eastX, y: crossAisleY - 4.0, skipTol: 0.45 }] : []),
              { x: eastX, y: crossAisleY, skipTol: 0.45, speedLimit: 1.5 },
              zoneAPadPre,
            ]
            : isTightNorthRackFlank && tx < eastX - 6.0
              ? [{ x: eastX, y: northY, skipTol: 0.45 }, { x: Math.min(eastX - 2.0, tx + 6.5), y: northY, skipTol: 0.35, speedLimit: 1.0 }]
              : isTightSouthRackFlank && tx < eastX - 6.0
                ? [{ x: eastX, y: southY, skipTol: 0.45 }, { x: Math.min(eastX - 2.0, tx + 6.5), y: southY, skipTol: 0.35, speedLimit: 1.0 }]
                : [{ x: eastX, y: ty }];
      const nearSideRevSeqs = [];
      if (nearContainerSideStart) {
        if (fHyStart > 0.35) {
          for (const northEscY of [oy + 40.5, oy + 41.5]) {
            const dNorth = (northEscY - fy) / fHyStart;
            if (dNorth > 0.5 && dNorth < 20.0) {
              const nxEsc = fx + fHxStart * dNorth;
              if (checkSegClear(fx, fy, nxEsc, northEscY, true, false)) {
                const fwdNorthPt = { x: nxEsc, y: northEscY, skipTol: 0.45 };
                if (isZoneAPadApproachTarget) {
                  nearSideRevSeqs.push(
                    [fwdNorthPt, { x: westX, y: northEscY, skipTol: 0.45 }, ...westTargetSeq],
                    [fwdNorthPt, { x: eastBypassX, y: northEscY, skipTol: 0.45 }, ...eastTargetSeq],
                  );
                } else {
                  nearSideRevSeqs.push(
                    [fwdNorthPt, { x: westX, y: northEscY, skipTol: 0.45 }, ...westTargetSeq],
                    [fwdNorthPt, { x: eastBypassX, y: northEscY, skipTol: 0.45 }, ...eastTargetSeq],
                    ...(isZoneDTarget ? [
                      [fwdNorthPt, { x: eastBypassX, y: northEscY, skipTol: 0.45 }, { x: eastBypassX, y: crossAisleY, skipTol: 0.45 }, { x: westX, y: crossAisleY, skipTol: 0.45 }, ...westTargetSeq],
                      [fwdNorthPt, { x: eastBypassX, y: northEscY, skipTol: 0.45 }, { x: eastX, y: zoneDBufY, skipTol: 0.45 }, { x: westX, y: zoneDBufY, skipTol: 0.45 }, ...westTargetSeq],
                    ] : []),
                    [fwdNorthPt, { x: westX, y: northEscY, skipTol: 0.45 }, { x: westX, y: ty }],
                    [fwdNorthPt, { x: eastX, y: northEscY, skipTol: 0.45 }, { x: eastX, y: ty }],
                  );
                }
              }
            }
          }
        }
        for (const revDist of [2.8, 3.6, 2.2]) {
          const revPt = { x: fx - fHxStart * revDist, y: fy - fHyStart * revDist, reverse: true, skipTol: 0.35 };
          if (!pathIsClear(fx, fy, revPt.x, revPt.y, obstacles, pad)) continue;
          if (isZoneAPadApproachTarget) {
            nearSideRevSeqs.push(
              [revPt, { x: revPt.x, y: crossAisleY, skipTol: 0.45 }, zoneAPadPre],
              [revPt, zoneAPadPre],
              [revPt, ...westTargetSeq],
              [revPt, ...eastTargetSeq],
            );
          } else {
            const eastApronStageSeqs = [];
            if (tx >= ox + 13.4 && ty >= oy - 13.0 && ty <= oy + 7.5 && !isZoneCStandTarget) {
              const targetEdgeX = Math.max(tx + 1.4, ox + 17.5);
              const standN = Math.max(northY, oy + 8.6);
              const standS = Math.min(southY, oy - 14.5);
              for (const sy of [standN, standS]) {
                for (const ex of [targetEdgeX, eastBypassX]) {
                  if (ty + 4.8 <= northY - 0.5) {
                    eastApronStageSeqs.push([revPt, { x: revPt.x, y: crossAisleY, skipTol: 0.45 }, { x: eastX, y: sy, skipTol: 0.45 }, { x: ex, y: sy, skipTol: 0.35, speedLimit: 1.35 }, { x: ex, y: ty + 4.8, skipTol: 0.35, speedLimit: 1.25 }]);
                  }
                  if (ty - 4.8 >= southY + 0.5) {
                    eastApronStageSeqs.push([revPt, { x: revPt.x, y: crossAisleY, skipTol: 0.45 }, { x: eastX, y: sy, skipTol: 0.45 }, { x: ex, y: sy, skipTol: 0.35, speedLimit: 1.35 }, { x: ex, y: ty - 4.8, skipTol: 0.35, speedLimit: 1.25 }]);
                  }
                }
              }
            }
            nearSideRevSeqs.push(
              ...eastApronStageSeqs,
              [revPt, { x: revPt.x, y: crossAisleY, skipTol: 0.45 }, { x: tx, y: crossAisleY, skipTol: 0.45 }],
              ...(fy > oy + 35.0 ? [[revPt, { x: revPt.x, y: fy - 2.5, skipTol: 0.35, speedLimit: 1.0 }, { x: revPt.x, y: crossAisleY, skipTol: 0.45, speedLimit: 1.25 }, { x: tx, y: crossAisleY, skipTol: 0.45 }]] : []),
              [revPt, { x: westX, y: revPt.y, skipTol: 0.45 }, { x: westX, y: ty }],
              [revPt, { x: eastX, y: revPt.y, skipTol: 0.45 }, { x: eastX, y: ty }],
              ...(isZoneDTarget ? [
                [revPt, { x: revPt.x, y: crossAisleY, skipTol: 0.45 }, { x: westX, y: crossAisleY, skipTol: 0.45 }, ...westTargetSeq],
                [revPt, { x: revPt.x, y: crossAisleY, skipTol: 0.45 }, { x: eastX, y: crossAisleY, skipTol: 0.45 }, ...eastTargetSeq],
              ] : []),
              [revPt, ...westTargetSeq],
              [revPt, ...eastTargetSeq],
            );
          }
        }
      } else if (nearContainerStart && fy > oy + 23.0 && fHyStart > 0.35 && ty < fy + 0.5) {
        if (Math.abs(wrapPi(opts.heading)) <= 0.35) {
          for (const northEscY of [oy + 40.5, oy + 41.5]) {
            const dNorth = (northEscY - fy) / fHyStart;
            if (dNorth > 0.5 && dNorth < 20.0) {
              const nxEsc = fx + fHxStart * dNorth;
              if (checkSegClear(fx, fy, nxEsc, northEscY, true, false)) {
                const fwdNorthPt = { x: nxEsc, y: northEscY, skipTol: 0.45 };
                nearSideRevSeqs.push(
                  [fwdNorthPt, { x: westX, y: northEscY, skipTol: 0.45 }, ...westTargetSeq],
                  [fwdNorthPt, { x: eastBypassX, y: northEscY, skipTol: 0.45 }, ...eastTargetSeq],
                  [fwdNorthPt, { x: westX, y: northEscY, skipTol: 0.45 }, { x: westX, y: ty }],
                  [fwdNorthPt, { x: eastX, y: northEscY, skipTol: 0.45 }, { x: eastX, y: ty }],
                );
              }
            }
          }
        }
        if (isZoneAPadApproachTarget) {
          nearSideRevSeqs.push(
            [{ x: fx, y: crossAisleY, reverse: true, skipTol: 0.45 }, zoneAPadPre],
          );
          for (const revDist of [4.5, 6.0, 3.2]) {
            const revPt = { x: fx - fHxStart * revDist, y: fy - fHyStart * revDist, reverse: true, skipTol: 0.45 };
            if (!pathIsClear(fx, fy, revPt.x, revPt.y, obstacles, pad)) continue;
            nearSideRevSeqs.push(
              [revPt, zoneAPadPre],
              [revPt, { x: revPt.x, y: crossAisleY, skipTol: 0.45 }, zoneAPadPre],
            );
          }
        } else {
          nearSideRevSeqs.push(
            [{ x: fx, y: crossAisleY, reverse: true, skipTol: 0.45 }, { x: tx, y: crossAisleY, skipTol: 0.45 }],
          );
          for (const revDist of [4.5, 6.0]) {
            const revPt = { x: fx - fHxStart * revDist, y: fy - fHyStart * revDist, reverse: true, skipTol: 0.45 };
            if (!checkSegClear(fx, fy, revPt.x, revPt.y, true, false)) continue;
            nearSideRevSeqs.push([revPt, { x: revPt.x, y: crossAisleY, skipTol: 0.45 }]);
          }
        }
      }
      const isChargerCloseFlank = checkAgfDeparture && Math.abs(fx - ox) <= 18.0 && ((fy <= oy - 36.5 && fy >= oy - 37.05) || (fy <= oy - 38.85 && fy >= oy - 39.25)) && Math.abs(fHxStart) > 0.35;
      const needEastLimit = Math.abs(fx - eastX) > 2.0;
      const cands = isSouthOfChargersStart
        ? []
        : enteringAisleFromOutside
        ? [
          ...(nearContainerSideStart ? [
            [{ x: fx, y: crossAisleY, skipTol: 0.45 }, ...buildAisleEntrySuffix("west", fx, crossAisleY)],
            [{ x: fx, y: crossAisleY, skipTol: 0.45 }, ...buildAisleEntrySuffix("east", fx, crossAisleY)],
            [{ x: fx - Math.sin(opts.heading) * 2.8, y: fy - Math.cos(opts.heading) * 2.8, reverse: true, skipTol: 0.35 }, { x: fx - Math.sin(opts.heading) * 2.8, y: crossAisleY, skipTol: 0.45 }, ...buildAisleEntrySuffix("west", fx - Math.sin(opts.heading) * 2.8, crossAisleY)],
            [{ x: fx - Math.sin(opts.heading) * 2.8, y: fy - Math.cos(opts.heading) * 2.8, reverse: true, skipTol: 0.35 }, { x: fx - Math.sin(opts.heading) * 2.8, y: crossAisleY, skipTol: 0.45 }, ...buildAisleEntrySuffix("east", fx - Math.sin(opts.heading) * 2.8, crossAisleY)],
          ] : []),
          buildAisleEntrySuffix("west", fx, fy),
          buildAisleEntrySuffix("east", fx, fy),
          ...(!(nearContainerStart && fy > oy + 25.0) ? [
            [{ x: westX, y: fy, skipTol: 0.45 }, ...buildAisleEntrySuffix("west", westX, fy)],
            [{ x: eastX, y: fy, skipTol: 0.45 }, ...buildAisleEntrySuffix("east", eastX, fy)],
          ] : []),
          ...(Math.abs(fy - targetAisleY) <= 1.5 ? [
            [{ x: westX, y: targetAisleY + 2.2, skipTol: 0.45, speedLimit: 1.15 }, ...buildAisleEntrySuffix("west", westX, targetAisleY + 2.2)],
            [{ x: westX, y: targetAisleY - 2.2, skipTol: 0.45, speedLimit: 1.15 }, ...buildAisleEntrySuffix("west", westX, targetAisleY - 2.2)],
            [{ x: westX - 2.2, y: targetAisleY, skipTol: 0.45, speedLimit: 1.15 }, ...buildAisleEntrySuffix("west", westX - 2.2, targetAisleY)],
            [{ x: eastX, y: targetAisleY + 2.2, skipTol: 0.45, speedLimit: 1.15 }, ...buildAisleEntrySuffix("east", eastX, targetAisleY + 2.2)],
            [{ x: eastX, y: targetAisleY - 2.2, skipTol: 0.45, speedLimit: 1.15 }, ...buildAisleEntrySuffix("east", eastX, targetAisleY - 2.2)],
            [{ x: eastX + 2.2, y: targetAisleY, skipTol: 0.45, speedLimit: 1.15 }, ...buildAisleEntrySuffix("east", eastX + 2.2, targetAisleY)],
          ] : []),
          [{ x: westX, y: northY, skipTol: 0.45 }, ...buildAisleEntrySuffix("west", westX, northY)],
          [{ x: eastX, y: northY, skipTol: 0.45 }, ...buildAisleEntrySuffix("east", eastX, northY)],
          [{ x: westX, y: southY, skipTol: 0.45 }, ...buildAisleEntrySuffix("west", westX, southY)],
          [{ x: eastX, y: southY, skipTol: 0.45 }, ...buildAisleEntrySuffix("east", eastX, southY)],
        ]
        : isZoneDStandTarget
          ? [
            ...(minDistanceToObstacles(tx, ty, obstacles) < 1.35 ? [
              [{ x: westX, y: fy, skipTol: 0.45 }, { x: westX, y: ty, skipTol: 0.45 }],
              [{ x: eastBypassX, y: fy, skipTol: 0.45 }, { x: eastBypassX, y: ty, skipTol: 0.45 }],
              [{ x: eastBypassX, y: zoneDBufY, skipTol: 0.45 }, { x: eastBypassX, y: ty, skipTol: 0.45 }],
              [{ x: westX, y: zoneDBufY, skipTol: 0.45 }, { x: westX, y: ty, skipTol: 0.45 }],
              ...(tx - 3.5 >= westX ? [[{ x: tx - 3.5, y: zoneDBufY, skipTol: 0.45 }, { x: tx - 3.5, y: ty, skipTol: 0.45 }]] : []),
              ...(tx + 3.5 <= eastBypassX ? [[{ x: tx + 3.5, y: zoneDBufY, skipTol: 0.45 }, { x: tx + 3.5, y: ty, skipTol: 0.45 }]] : []),
            ] : []),
            ...(isZoneDStandStart
              ? [[{ x: fx, y: zoneDBufY, skipTol: 0.45 }, zoneDBufTarget]]
              : []),
            [zoneDBufTarget],
            [{ x: westX, y: fy, skipTol: 0.45 }, ...westTargetSeq],
            [{ x: eastX, y: fy, skipTol: 0.45 }, ...eastTargetSeq],
            [{ x: eastBypassX, y: fy, skipTol: 0.45 }, { x: eastBypassX, y: zoneDBufY, skipTol: 0.45 }, zoneDBufTarget],
            westTargetSeq,
            eastTargetSeq,
            [{ x: eastBypassX, y: zoneDBufY, skipTol: 0.45 }, zoneDBufTarget],
            [{ x: westX, y: northY, skipTol: 0.45, speedLimit: 1.5 }, { x: westX, y: northY - 2.5, skipTol: 0.45 }, ...westTargetSeq],
            [{ x: eastX, y: northY, skipTol: 0.45, speedLimit: 1.5 }, { x: eastX, y: northY - 2.5, skipTol: 0.45 }, ...eastTargetSeq],
            [{ x: westX, y: southY, skipTol: 0.45 }, ...westTargetSeq],
            [{ x: eastX, y: southY, skipTol: 0.45 }, ...eastTargetSeq],
          ]
        : isZoneCStandTarget
          ? [
            ...nearSideRevSeqs,
            ...(fy > crossAisleY ? [
              [{ x: fx, y: crossAisleY, skipTol: 0.45 }, { x: eastX, y: crossAisleY, skipTol: 0.35, speedLimit: 1.35 }, ...eastTargetSeq],
              [{ x: fx, y: crossAisleY, skipTol: 0.45 }, { x: westX, y: crossAisleY, skipTol: 0.45 }, ...westTargetSeq],
            ] : []),
            [{ x: eastX, y: fy, skipTol: 0.35, ...(needEastLimit ? { speedLimit: 1.35 } : {}) }, ...eastTargetSeq],
            eastTargetSeq,
            [{ x: eastX, y: northY, skipTol: 0.35, ...(needEastLimit ? { speedLimit: 1.35 } : {}) }, ...eastTargetSeq],
            [{ x: eastX, y: southY, skipTol: 0.35, ...(needEastLimit ? { speedLimit: 1.35 } : {}) }, ...eastTargetSeq],
            [{ x: westX, y: fy, skipTol: 0.45 }, ...westTargetSeq],
            westTargetSeq,
            [{ x: westX, y: southY, skipTol: 0.45 }, { x: eastX, y: southY, skipTol: 0.35, speedLimit: 1.35 }, ...eastTargetSeq],
          ]
          : isZoneDTarget
            ? [
              ...nearSideRevSeqs,
              ...(fy > oy + 38.5 ? (() => {
                const zoneDExits = [];
                const corrXsD = [ox - 45.0, ox - 32.0, ox - 16.0, ox + 0.0, eastBypassX];
                for (const lx of corrXsD) {
                  if (Math.abs(lx - fx) <= 22.0) {
                    const outA = [{ x: lx, y: fy, skipTol: 0.45 }, { x: lx, y: crossAisleY, skipTol: 0.45 }];
                    if (lx >= eastBypassX - 0.5) {
                      zoneDExits.push([...outA, ...eastTargetSeq.slice(1)]);
                    } else {
                      zoneDExits.push([...outA, { x: westX, y: crossAisleY, skipTol: 0.45 }, { x: westX, y: northWestTurnY, skipTol: 0.45, speedLimit: 1.5 }, ...westTargetSeq]);
                    }
                  }
                }
                return zoneDExits;
              })() : []),
              ...(fy > crossAisleY ? [
                [{ x: fx, y: crossAisleY, skipTol: 0.45 }, { x: westX, y: crossAisleY, skipTol: 0.45 }, { x: westX, y: northWestTurnY, skipTol: 0.45, speedLimit: 1.5 }, ...westTargetSeq],
                [{ x: fx, y: crossAisleY, skipTol: 0.45 }, { x: eastX, y: crossAisleY, skipTol: 0.45, speedLimit: 1.5 }, ...eastTargetSeq],
              ] : []),
              [{ x: westX, y: northWestTurnY, skipTol: 0.45, speedLimit: 1.5 }, ...westTargetSeq],
              [{ x: eastX, y: northWestTurnY, skipTol: 0.45, speedLimit: 1.5 }, ...eastTargetSeq],
              ...(isChargerCloseFlank ? [] : [
                [{ x: westX, y: fy, skipTol: 0.45 }, ...westTargetSeq],
                ...(fy > oy + 3.5 ? [
                  [{ x: eastX - 1.5, y: fy, skipTol: 0.25, speedLimit: 0.95 }, { x: eastX - 1.5, y: oy + 2.0, skipTol: 0.35, speedLimit: 1.2 }, ...eastTargetSeq],
                  [{ x: eastX, y: northY, skipTol: 0.35, speedLimit: 1.0 }, ...eastTargetSeq],
                ] : []),
                [{ x: eastX, y: fy, skipTol: fy > oy + 3.5 ? 0.25 : 0.35, ...(fy > oy + 3.5 ? { speedLimit: 0.90 } : (needEastLimit ? { speedLimit: 1.35 } : {})) }, ...eastTargetSeq],
              ]),
              [{ x: westX, y: zoneDBufY, skipTol: 0.45 }, ...westTargetSeq],
              ...(fx > westX + 1.0 ? [
                [{ x: eastX, y: zoneDBufY, skipTol: 0.45 }, { x: westX, y: zoneDBufY, skipTol: 0.45 }, ...westTargetSeq],
                ...(fx >= rackMaxX - 0.5 && fy > oy - 18.0 ? [
                  [{ x: fx, y: zoneDBufY, skipTol: 0.45 }, { x: westX, y: zoneDBufY, skipTol: 0.45 }, ...westTargetSeq],
                  [{ x: eastX, y: fy, skipTol: 0.35, speedLimit: 1.0 }, { x: eastX, y: zoneDBufY, skipTol: 0.45 }, { x: westX, y: zoneDBufY, skipTol: 0.45 }, ...westTargetSeq],
                  ...(fy > oy + 3.5 ? [
                    [{ x: eastX, y: oy + 2.0, skipTol: 0.35, speedLimit: 1.0 }, { x: eastX, y: zoneDBufY, skipTol: 0.45 }, { x: westX, y: zoneDBufY, skipTol: 0.45 }, ...westTargetSeq],
                  ] : []),
                ] : []),
              ] : []),
              westTargetSeq,
              eastTargetSeq,
              [{ x: westX, y: southY, skipTol: 0.45 }, ...westTargetSeq],
              [{ x: eastX, y: southY, skipTol: 0.35, ...(needEastLimit ? { speedLimit: 1.35 } : {}) }, ...eastTargetSeq],
              ...(tx > ox + 14.2 && !isSouthOfChargers ? (() => {
                const eastOuterX = Math.max(eastBypassX + 2.5, tx + 4.5);
                return [
                  ...(fy > oy - 14.0 ? [
                    [{ x: eastX, y: fy, skipTol: 0.45 }, { x: eastX, y: zoneDBufY, skipTol: 0.45 }, { x: eastBypassX, y: zoneDBufY, skipTol: 0.45 }, { x: eastBypassX, y: ty, skipTol: 0.45 }],
                    [{ x: eastX, y: fy, skipTol: 0.45 }, { x: eastX, y: zoneDBufY, skipTol: 0.45 }, { x: eastOuterX, y: zoneDBufY, skipTol: 0.45 }, { x: eastOuterX, y: ty, skipTol: 0.45 }],
                    [{ x: eastBypassX, y: northWestTurnY, skipTol: 0.45 }, { x: eastBypassX, y: ty, skipTol: 0.45 }],
                    [{ x: eastOuterX, y: northWestTurnY, skipTol: 0.45 }, { x: eastOuterX, y: ty, skipTol: 0.45 }],
                    ...(fy <= northWestTurnY + 0.5 ? [
                      [{ x: eastBypassX, y: fy, skipTol: 0.45 }, { x: eastBypassX, y: ty, skipTol: 0.45 }],
                      [{ x: eastOuterX, y: fy, skipTol: 0.45 }, { x: eastOuterX, y: ty, skipTol: 0.45 }],
                    ] : []),
                  ] : []),
                  [{ x: eastX, y: zoneDBufY, skipTol: 0.45 }, { x: eastBypassX, y: zoneDBufY, skipTol: 0.45 }, { x: eastBypassX, y: ty, skipTol: 0.45 }],
                  [{ x: eastX, y: zoneDBufY, skipTol: 0.45 }, { x: eastOuterX, y: zoneDBufY, skipTol: 0.45 }, { x: eastOuterX, y: ty, skipTol: 0.45 }],
                  [{ x: eastOuterX, y: zoneDBufY, skipTol: 0.45 }, { x: eastOuterX, y: ty, skipTol: 0.45 }],
                ];
              })() : []),
              ...(!isSouthOfChargers && ty <= oy - 37.3 && Math.abs(tx - ox) <= 18.0 && closeTargetObs?.kind === "charger" && (tx <= closeTargetObs.x0 - 0.35 || tx >= closeTargetObs.x1 + 0.35) ? (() => {
                const obsCx = (closeTargetObs.x0 + closeTargetObs.x1) * 0.5;
                const dirX = tx >= obsCx ? 1 : -1;
                const gapX = tx + dirX * 0.78;
                const gapTail = [
                  { x: gapX, y: zoneDHwyY, skipTol: 0.25, speedLimit: 0.95 },
                  { x: gapX, y: oy - 32.2, skipTol: 0.22, speedLimit: 0.80 },
                  { x: tx, y: oy - 34.0, skipTol: 0.18, speedLimit: 0.65 },
                  { x: tx, y: oy - 35.8, skipTol: 0.14, speedLimit: 0.55 },
                ];
                let nearRackAisleY = null;
                if (hasRackBounds && fy >= rackMinY - 1.0 && fy <= rackMaxY + 1.0) {
                  let bestDy = Infinity;
                  for (const al of aisleList) {
                    const dy = Math.abs(fy - al.y);
                    if (dy < bestDy) { bestDy = dy; nearRackAisleY = al.y; }
                  }
                }
                return [
                  [{ x: westX, y: northWestTurnY, skipTol: 0.45, speedLimit: 1.5 }, { x: westX, y: zoneDHwyY, skipTol: 0.45 }, ...gapTail],
                  [{ x: eastX, y: northWestTurnY, skipTol: 0.45, speedLimit: 1.5 }, { x: eastX, y: zoneDBufY, skipTol: 0.45 }, { x: eastBypassX, y: zoneDBufY, skipTol: 0.45 }, { x: eastBypassX, y: zoneDHwyY, skipTol: 0.45 }, ...gapTail],
                  [{ x: westX, y: fy, skipTol: 0.45 }, { x: westX, y: zoneDHwyY, skipTol: 0.45 }, ...gapTail],
                  ...(nearRackAisleY !== null ? [
                    [{ x: westX, y: nearRackAisleY, skipTol: 0.45 }, { x: westX, y: zoneDHwyY, skipTol: 0.45 }, ...gapTail],
                    [{ x: eastX, y: nearRackAisleY, skipTol: 0.45 }, { x: eastX, y: zoneDBufY, skipTol: 0.45 }, { x: eastBypassX, y: zoneDBufY, skipTol: 0.45 }, { x: eastBypassX, y: zoneDHwyY, skipTol: 0.45 }, ...gapTail],
                  ] : []),
                  [{ x: westX, y: southY, skipTol: 0.45 }, { x: westX, y: zoneDHwyY, skipTol: 0.45 }, ...gapTail],
                  [{ x: westX, y: zoneDHwyY, skipTol: 0.45 }, ...gapTail],
                  [{ x: eastX, y: zoneDBufY, skipTol: 0.45 }, { x: eastBypassX, y: zoneDBufY, skipTol: 0.45 }, { x: eastBypassX, y: zoneDHwyY, skipTol: 0.45 }, ...gapTail],
                  [{ x: eastBypassX, y: zoneDHwyY, skipTol: 0.45 }, ...gapTail],
                ];
              })() : []),
              ...(ty >= oy - 24.6 && Math.abs(tx - ox) <= 18.0 ? [
                [{ x: eastX, y: zoneDBufY, skipTol: 0.45 }, { x: tx, y: zoneDBufY, skipTol: 0.35 }],
                [{ x: westX, y: zoneDBufY, skipTol: 0.45 }, { x: tx, y: zoneDBufY, skipTol: 0.35 }],
                [{ x: eastBypassX, y: zoneDBufY, skipTol: 0.45 }, { x: tx, y: zoneDBufY, skipTol: 0.35 }],
              ] : []),
              ...(ty < oy - 29.5 && ty > oy - 37.5 && Math.abs(tx - ox) <= 18.0 ? [
                [{ x: eastBypassX, y: ty + 3.0, skipTol: 0.45 }, { x: eastBypassX, y: ty, skipTol: 0.35, speedLimit: 1.0 }],
                [{ x: westX, y: ty + 3.0, skipTol: 0.45 }, { x: westX, y: ty, skipTol: 0.35, speedLimit: 1.0 }],
              ] : []),
              ...(isSouthOfChargers
                ? [[
                  { x: eastBypassX, y: zoneDBufY, skipTol: 0.45 },
                  { x: eastBypassX, y: southChargerLaneY + 3.0, skipTol: 0.45 },
                  { x: eastBypassX, y: southChargerLaneY + 1.8, skipTol: 0.45, speedLimit: 1.0, _noSubdivideSpeed: true },
                  { x: eastBypassX, y: southChargerLaneY, skipTol: 0.45, speedLimit: 0.70, _noSubdivideSpeed: true },
                  ...(tx < ox + 17.5 && (!(southChargerLaneY < ty - 0.05 && needCloseTargetAlign) || ox + 17.8 >= tx + 3.6) ? [{ x: ox + 17.8, y: southChargerLaneY, skipTol: 0.35, speedLimit: 0.85, _noSubdivideSpeed: true }] : []),
                  ...(tx < ox + 16.0 && (!(southChargerLaneY < ty - 0.05 && needCloseTargetAlign) || ox + 16.2 >= tx + 3.6) ? [{ x: ox + 16.2, y: southChargerLaneY, skipTol: 0.35, speedLimit: 1.35, _noSubdivideSpeed: true }] : []),
                  ...(southChargerLaneY < ty - 0.05
                    ? (needCloseTargetAlign
                      ? (tx + 4.2 < eastBypassX - 0.5 ? [{ x: tx + 4.2, y: southChargerLaneY, skipTol: 0.30, speedLimit: 0.85, _noSubdivideSpeed: true }] : [])
                      : [{ x: tx, y: southChargerLaneY, skipTol: 0.30, speedLimit: 0.85, _noSubdivideSpeed: true }])
                    : []),
                ]]
                : [[{ x: eastBypassX, y: zoneDHwyY, skipTol: 0.45 }, { x: tx, y: zoneDHwyY, skipTol: 0.45 }]]),
              ...(fx < westX - 0.5 && fy > oy - 29.0 ? [
                ...(!checkAgfDeparture || fHyStart <= 0.35 ? [
                  [{ x: fx, y: isSouthOfChargers ? southChargerLaneY + 3.0 : zoneDHwyY, skipTol: 0.45 }, ...westZoneDTail],
                  ...(isSouthOfChargers ? [[{ x: fx, y: zoneDHwyY, skipTol: 0.45 }, ...westZoneDTail]] : []),
                ] : []),
                ...(checkAgfDeparture && fHyStart > 0.35 && fy > oy - 24.0 ? [
                  [{ x: fx - fHxStart * 3.0, y: fy - fHyStart * 3.0, reverse: true, skipTol: 0.35 }, { x: fx, y: zoneDHwyY, skipTol: 0.45 }, ...westZoneDTail],
                  [{ x: fx, y: fy + 3.0, skipTol: 0.45 }, { x: westX, y: fy + 3.0, skipTol: 0.45 }, ...westZoneDTail],
                ] : []),
              ] : []),
            ]
          : isZoneAPadApproachTarget
            ? [
              ...nearSideRevSeqs,
              [{ x: fx, y: crossAisleY, skipTol: 0.45 }, zoneAPadPre],
              [zoneAPadPre],
              [{ x: westX, y: fy, skipTol: 0.45 }, ...westTargetSeq],
              [{ x: eastX, y: fy, skipTol: 0.45 }, ...eastTargetSeq],
              westTargetSeq,
              eastTargetSeq,
              [{ x: westX, y: northY, skipTol: 0.45 }, ...westTargetSeq],
              [{ x: eastX, y: northY, skipTol: 0.45 }, ...eastTargetSeq],
              [{ x: westX, y: southY, skipTol: 0.45 }, ...westTargetSeq],
              [{ x: eastX, y: southY, skipTol: 0.45 }, ...eastTargetSeq],
              ...(hasRackBounds && fx >= eastX - 1.0 && tx <= westX + 1.0
                ? [
                  ...aisleList.map((a) => [{ x: eastX, y: a.y, skipTol: 0.45 }, { x: westX, y: a.y, skipTol: 0.45 }, ...westTargetSeq]),
                  [{ x: eastX, y: northY, skipTol: 0.45 }, { x: westX, y: northY, skipTol: 0.45 }, ...westTargetSeq],
                  [{ x: eastX, y: southY, skipTol: 0.45 }, { x: westX, y: southY, skipTol: 0.45 }, ...westTargetSeq],
                ]
                : []),
            ]
            : [
              ...nearSideRevSeqs,
              ...(isChargerCloseFlank
                ? []
                : [
                  [{ x: westX, y: fy }],
                  [{ x: eastX, y: fy, skipTol: 0.35, ...(needEastLimit ? { speedLimit: 1.35 } : {}) }],
                  [{ x: westX, y: fy }, { x: westX, y: ty }],
                  [{ x: eastX, y: fy, skipTol: 0.35, ...(needEastLimit ? { speedLimit: 1.35 } : {}) }, { x: eastX, y: ty }],
                  ...(checkAgfDeparture && !rackDepartInfo && startMinDist < 0.65 && hasRackBounds && fx >= rackMinX - 0.5 && fx <= rackMaxX + 0.5 && Math.abs(fHxStart) > 0.65 ? (() => {
                    const eastMidX = Math.min(eastX - 1.2, rackMaxX + 2.7);
                    return fHxStart > 0 ? [
                      [{ x: eastMidX, y: fy, skipTol: 0.30, speedLimit: 0.90 }, { x: eastMidX, y: northY, skipTol: 0.35, speedLimit: 1.15 }, ...(tx < eastX - 6.0 && ty >= northY - 3.5 && ty <= northY ? [{ x: Math.min(eastX - 2.0, tx + 6.5), y: northY, skipTol: 0.35, speedLimit: 1.0 }] : eastTargetSeq)],
                      [{ x: eastMidX, y: fy, skipTol: 0.30, speedLimit: 0.90 }, { x: eastMidX, y: northY, skipTol: 0.35, speedLimit: 1.15 }],
                      [{ x: eastMidX, y: fy, skipTol: 0.30, speedLimit: 0.90 }, { x: eastMidX, y: southY, skipTol: 0.35, speedLimit: 1.15 }, ...(tx < eastX - 6.0 && ty >= southY && ty <= southY + 3.5 ? [{ x: Math.min(eastX - 2.0, tx + 6.5), y: southY, skipTol: 0.35, speedLimit: 1.0 }] : eastTargetSeq)],
                      [{ x: eastMidX, y: fy, skipTol: 0.30, speedLimit: 0.90 }, { x: eastMidX, y: southY, skipTol: 0.35, speedLimit: 1.15 }],
                      [{ x: eastMidX, y: fy, skipTol: 0.30, speedLimit: 0.90 }, { x: eastMidX, y: ty, skipTol: 0.35, speedLimit: 1.0 }],
                      [{ x: eastX, y: fy, skipTol: 0.35, speedLimit: 1.35 }, { x: eastX, y: northY, skipTol: 0.45 }, ...eastTargetSeq],
                      [{ x: eastX, y: fy, skipTol: 0.35, speedLimit: 1.35 }, { x: eastX, y: northY, skipTol: 0.45 }, { x: tx, y: northY, skipTol: 0.45 }],
                      ...(tx < eastX - 6.0 && ty >= northY - 3.5 && ty <= northY ? [
                        [{ x: eastX, y: fy, skipTol: 0.35, speedLimit: 1.35 }, { x: eastX, y: northY, skipTol: 0.35, speedLimit: 1.25 }, { x: Math.min(eastX - 2.0, tx + 6.5), y: northY, skipTol: 0.35, speedLimit: 1.0 }],
                      ] : []),
                      [{ x: eastX, y: fy, skipTol: 0.35, speedLimit: 1.35 }, { x: eastX, y: northY, skipTol: 0.45 }, { x: westX, y: northY, skipTol: 0.45 }, ...westTargetSeq],
                      [{ x: eastX, y: fy, skipTol: 0.35, speedLimit: 1.35 }, { x: eastX, y: southY, skipTol: 0.45 }, ...eastTargetSeq],
                      ...(tx < eastX - 6.0 && ty >= southY && ty <= southY + 3.5 ? [
                        [{ x: eastX, y: fy, skipTol: 0.35, speedLimit: 1.35 }, { x: eastX, y: southY, skipTol: 0.35, speedLimit: 1.25 }],
                        [{ x: eastX, y: fy, skipTol: 0.35, speedLimit: 1.35 }, { x: eastX, y: southY, skipTol: 0.35, speedLimit: 1.25 }, { x: Math.min(eastX - 2.0, tx + 6.5), y: southY, skipTol: 0.35, speedLimit: 1.0 }],
                      ] : []),
                      [{ x: eastX, y: fy, skipTol: 0.35, speedLimit: 1.35 }, { x: eastX, y: southY, skipTol: 0.45 }, { x: westX, y: southY, skipTol: 0.45 }, ...westTargetSeq],
                      ...(tx <= rackMaxX || tx >= eastX ? [[{ x: eastX, y: fy, skipTol: 0.35, speedLimit: 1.35 }, { x: eastX, y: southY, skipTol: 0.45 }, { x: tx, y: southY, skipTol: 0.45 }]] : []),
                      [{ x: westX, y: fy, reverse: true, skipTol: 0.35, speedLimit: 1.0 }],
                      [{ x: westX, y: fy, reverse: true, skipTol: 0.35, speedLimit: 1.0 }, ...westTargetSeq],
                    ] : [
                      [{ x: westX, y: fy, skipTol: 0.35, speedLimit: 1.35 }, { x: westX, y: northY, skipTol: 0.45 }, ...westTargetSeq],
                      [{ x: westX, y: fy, skipTol: 0.35, speedLimit: 1.35 }, { x: westX, y: northY, skipTol: 0.45 }, { x: tx, y: northY, skipTol: 0.45 }],
                      ...(tx > westX + 6.0 && ty >= northY - 3.5 && ty <= northY ? [
                        [{ x: westX, y: fy, skipTol: 0.35, speedLimit: 1.35 }, { x: westX, y: northY, skipTol: 0.35, speedLimit: 1.25 }, { x: Math.max(westX + 2.0, tx - 6.5), y: northY, skipTol: 0.35, speedLimit: 1.0 }],
                      ] : []),
                      [{ x: westX, y: fy, skipTol: 0.35, speedLimit: 1.35 }, { x: westX, y: northY, skipTol: 0.45 }, { x: eastX, y: northY, skipTol: 0.45 }, ...eastTargetSeq],
                      [{ x: westX, y: fy, skipTol: 0.35, speedLimit: 1.35 }, { x: westX, y: southY, skipTol: 0.45 }, ...westTargetSeq],
                      ...(tx > westX + 6.0 && ty >= southY && ty <= southY + 3.5 ? [
                        [{ x: westX, y: fy, skipTol: 0.35, speedLimit: 1.35 }, { x: westX, y: southY, skipTol: 0.35, speedLimit: 1.25 }],
                        [{ x: westX, y: fy, skipTol: 0.35, speedLimit: 1.35 }, { x: westX, y: southY, skipTol: 0.35, speedLimit: 1.25 }, { x: Math.max(westX + 2.0, tx - 6.5), y: southY, skipTol: 0.35, speedLimit: 1.0 }],
                      ] : []),
                      [{ x: westX, y: fy, skipTol: 0.35, speedLimit: 1.35 }, { x: westX, y: southY, skipTol: 0.45 }, { x: eastX, y: southY, skipTol: 0.45 }, ...eastTargetSeq],
                      [{ x: westX, y: fy, skipTol: 0.35, speedLimit: 1.35 }, { x: westX, y: southY, skipTol: 0.45 }, { x: tx, y: southY, skipTol: 0.45 }],
                      [{ x: eastX, y: fy, reverse: true, skipTol: 0.35, speedLimit: 1.0 }],
                      [{ x: eastX, y: fy, reverse: true, skipTol: 0.35, speedLimit: 1.0 }, ...eastTargetSeq],
                    ];
                  })() : []),
                ]),
              ...(fx > rackMaxX + 0.5 && ty > oy - 23.5 ? [
                [{ x: eastBypassX, y: fy, skipTol: 0.35 }, { x: eastBypassX, y: ty, skipTol: 0.35, speedLimit: 1.25 }],
              ] : []),
              ...(ty > oy + 24.0 ? (() => {
                const zoneANorthY = (ty > oy + 38.0 && needCloseTargetAlign && closeTargetObs?.kind === "container" && ty > closeTargetObs.y1)
                  ? Math.max(oy + 40.5, ty + 1.95)
                  : oy + 40.5;
                const zoneBSpineX = ox - 45.0;
                const corrXs = [];
                if (tx < ox - 39.0 || ty > oy + 38.0) corrXs.push(zoneBSpineX);
                if (tx >= ox - 41.0 && tx <= ox - 23.0) corrXs.push(ox - 32.0);
                if (tx >= ox - 25.0 && tx <= ox - 7.0) corrXs.push(ox - 16.0);
                if (tx >= ox - 9.0) corrXs.push(ox + 0.0, eastX);
                if (ty > oy + 38.0) corrXs.push(westX, eastBypassX);
                const crossPrefixes = [];
                if (fy >= oy + 15.0 && fy <= oy + 24.5) {
                  crossPrefixes.push([]);
                } else if (fy > oy + 24.5) {
                  const sCx = fx < ox - 41.0 ? zoneBSpineX : fx < ox - 24.0 ? ox - 32.0 : fx < ox - 8.0 ? ox - 16.0 : ox + 0.0;
                  crossPrefixes.push([{ x: sCx, y: crossAisleY, skipTol: 0.45 }]);
                  if (fx > ox - 7.0) crossPrefixes.push([{ x: eastBypassX, y: crossAisleY, skipTol: 0.45 }]);
                  if (fy > oy + 38.5) {
                    for (const lx of [zoneBSpineX, ox - 32.0, ox - 16.0, ox + 0.0, eastBypassX]) {
                      if (Math.abs(lx - fx) <= 22.0 || Math.abs(lx - tx) <= 22.0) {
                        crossPrefixes.push([{ x: lx, y: fy, skipTol: 0.45 }, { x: lx, y: crossAisleY, skipTol: 0.45 }]);
                      }
                    }
                  }
                } else if (fx > ox + 14.2) {
                  crossPrefixes.push([{ x: eastBypassX, y: crossAisleY, skipTol: 0.45 }]);
                  if (fy < oy - 23.5) {
                    crossPrefixes.push([{ x: eastBypassX, y: zoneDBufY, skipTol: 0.45 }, { x: eastBypassX, y: crossAisleY, skipTol: 0.45 }]);
                  }
                  crossPrefixes.push([{ x: fx, y: crossAisleY, skipTol: 0.45 }]);
                } else {
                  if (fx <= ox - 40.0 && fy >= oy - 12.0) {
                    crossPrefixes.push([{ x: zoneBSpineX, y: crossAisleY, skipTol: 0.45 }]);
                  }
                  crossPrefixes.push([{ x: westX, y: crossAisleY, skipTol: 0.45 }]);
                  crossPrefixes.push([{ x: eastX, y: crossAisleY, skipTol: 0.45 }]);
                  if (fy < oy - 20.0) {
                    crossPrefixes.push([{ x: westX, y: zoneDBufY, skipTol: 0.45 }, { x: westX, y: crossAisleY, skipTol: 0.45 }]);
                    crossPrefixes.push([{ x: eastX, y: zoneDBufY, skipTol: 0.45 }, { x: eastX, y: crossAisleY, skipTol: 0.45 }]);
                  }
                }
                const outZoneA = [];
                if (fx <= ox - 40.0 && fy >= oy - 12.0 && tx < ox - 41.0) {
                  outZoneA.push([{ x: zoneBSpineX, y: ty, skipTol: 0.45 }]);
                }
                for (const cp of crossPrefixes) {
                  for (const cx of corrXs) {
                    outZoneA.push([...cp, { x: cx, y: crossAisleY, skipTol: 0.45 }, { x: cx, y: ty, skipTol: 0.45 }]);
                    if (!(needCloseTargetAlign && closeTargetObs?.kind === "container" && ty <= closeTargetObs.y1)) {
                      outZoneA.push([...cp, { x: cx, y: crossAisleY, skipTol: 0.45 }, { x: cx, y: zoneANorthY, skipTol: 0.45 }, { x: tx, y: zoneANorthY, skipTol: 0.45 }]);
                    }
                  }
                  if (Math.abs(tx - ox) <= 50.0) {
                    if (needCloseTargetAlign && closeTargetObs?.kind === "container") {
                      const offX = tx < closeTargetObs.x0 ? -1.5 : (tx > closeTargetObs.x1 ? 1.5 : 0);
                      if (offX !== 0) {
                        outZoneA.push([...cp, { x: tx + offX, y: crossAisleY, skipTol: 0.45 }]);
                      }
                    }
                    if (needCloseTargetAlign && closeTargetObs?.kind === "container") {
                      const sideOffX = tx < closeTargetObs.x0 ? -1 : (tx > closeTargetObs.x1 ? 1 : 0);
                      if (sideOffX !== 0 && (opts.carriedWcid || opts.loaded) && ty > crossAisleY + 6.5 && ty <= closeTargetObs.y1) {
                        outZoneA.push([
                          ...cp,
                          { x: tx + sideOffX * 1.4, y: crossAisleY, skipTol: 0.40, speedLimit: 0.85 },
                          { x: tx + sideOffX * 0.25, y: crossAisleY + 2.7, skipTol: 0.35, speedLimit: 0.70 },
                          { x: tx, y: crossAisleY + 5.7, skipTol: 0.35, speedLimit: 0.65 },
                        ]);
                      }
                      outZoneA.push([...cp, { x: tx, y: crossAisleY, skipTol: 0.18, speedLimit: 0.65 }, { x: tx, y: crossAisleY + 2.5, skipTol: 0.25, speedLimit: 0.85 }]);
                    }
                    outZoneA.push([...cp, { x: tx, y: crossAisleY, skipTol: 0.45 }]);
                  }
                }
                if (fy > oy + 24.5 && !(needCloseTargetAlign && closeTargetObs?.kind === "container" && ty <= closeTargetObs.y1)) {
                  outZoneA.push([{ x: zoneBSpineX, y: zoneANorthY, skipTol: 0.45 }, { x: tx, y: zoneANorthY, skipTol: 0.45 }]);
                  outZoneA.push([{ x: eastBypassX, y: zoneANorthY, skipTol: 0.45 }, { x: tx, y: zoneANorthY, skipTol: 0.45 }]);
                }
                if (fy > oy + 24.0 && needCloseTargetAlign && closeTargetObs?.kind === "container" && closeTargetDist < 0.85) {
                  const outOffX = fx < closeTargetObs.x0 ? -0.4 : (fx > closeTargetObs.x1 ? 0.4 : 0);
                  const stageX = fx + outOffX;
                  outZoneA.push(
                    [{ x: stageX, y: crossAisleY, skipTol: 0.35, speedLimit: 1.15 }, { x: tx, y: crossAisleY, skipTol: 0.25, speedLimit: 0.85 }, { x: tx, y: crossAisleY + 2.5, skipTol: 0.25, speedLimit: 0.85 }],
                    [{ x: stageX, y: crossAisleY, reverse: true, skipTol: 0.35, speedLimit: 0.90 }, { x: tx, y: crossAisleY, skipTol: 0.25, speedLimit: 0.85 }, { x: tx, y: crossAisleY + 2.5, skipTol: 0.25, speedLimit: 0.85 }],
                    [{ x: stageX, y: zoneANorthY, skipTol: 0.35, speedLimit: 1.15 }, { x: tx, y: zoneANorthY, skipTol: 0.25, speedLimit: 0.85 }],
                    [{ x: stageX, y: zoneANorthY, reverse: true, skipTol: 0.35, speedLimit: 0.90 }, { x: tx, y: zoneANorthY, skipTol: 0.25, speedLimit: 0.85 }],
                  );
                }
                return outZoneA;
              })() : []),
              ...(ty < oy - 19.0 && ty >= oy - 24.5 ? [
                [{ x: eastX, y: zoneDBufY, skipTol: 0.45 }, { x: tx, y: zoneDBufY, skipTol: 0.35 }],
                [{ x: westX, y: zoneDBufY, skipTol: 0.45 }, { x: tx, y: zoneDBufY, skipTol: 0.35 }],
              ] : []),
              ...(tx < rackMinX - 0.5 || ty > rackMaxY + 0.5 ? [
                [{ x: eastX, y: southY, skipTol: 0.45 }, { x: westX, y: southY, skipTol: 0.45 }],
              ] : []),
              ...(fx > rackMaxX + 0.5 && fx < eastX ? [
                [{ x: ox + 12.2, y: fy, skipTol: 0.35 }, { x: ox + 12.2, y: ty, skipTol: 0.35, speedLimit: 1.25 }],
                [{ x: ox + 12.2, y: southY, skipTol: 0.35 }, { x: ox + 12.2, y: ty, skipTol: 0.35, speedLimit: 1.25 }],
              ] : []),
              ...(isZoneDNorthBandNonApproach ? [
                westTargetSeq,
                eastTargetSeq,
                [{ x: westX, y: northY }, ...westTargetSeq],
                [{ x: eastX, y: northY, skipTol: 0.35, ...(needEastLimit ? { speedLimit: 1.35 } : {}) }, ...eastTargetSeq],
              ] : [
                [{ x: westX, y: ty }],
                [{ x: eastX, y: ty }],
                [{ x: westX, y: northY }, { x: westX, y: ty }],
              ]),
              ...(tx > eastX && needCloseTargetAlign && closeTargetDist < 0.85 ? [
                [{ x: eastX, y: northY, skipTol: 0.35, speedLimit: 1.25 }],
                [{ x: eastX, y: southY, skipTol: 0.35, speedLimit: 1.25 }],
              ] : []),
              ...(isZoneDNorthBandNonApproach ? [] : [
                [{ x: eastX, y: northY, skipTol: 0.35, ...(needEastLimit ? { speedLimit: 1.35 } : {}) }, { x: eastX, y: ty }],
                [{ x: eastX, y: northY, skipTol: 0.25, speedLimit: 0.85 }, { x: eastX, y: ty, skipTol: 0.25, speedLimit: 0.85 }],
              ]),
              [{ x: westX, y: northY }, { x: tx, y: northY }],
              [{ x: eastX, y: northY, skipTol: 0.35, ...(needEastLimit ? { speedLimit: 1.35 } : {}) }, { x: tx, y: northY }],
              [{ x: westX, y: southY }, { x: westX, y: ty }],
              [{ x: eastX, y: southY, skipTol: 0.35, ...(needEastLimit ? { speedLimit: 1.35 } : {}) }, { x: eastX, y: ty }],
              ...(tx <= rackMaxX || tx >= eastX
                ? [[{ x: westX, y: southY }, { x: tx, y: southY, skipTol: 0.35, speedLimit: 1.25 }]]
                : [[{ x: westX, y: southY, skipTol: 0.45 }, { x: eastX, y: southY, skipTol: 0.35, speedLimit: 1.25 }, { x: eastX, y: ty, skipTol: 0.35 }]]),
              [{ x: eastX, y: southY, skipTol: 0.35, ...(needEastLimit ? { speedLimit: 1.35 } : {}) }, { x: tx, y: southY, skipTol: 0.35, speedLimit: 1.25 }],
              ...(tx < eastX - 6.0 && ty >= southY && ty <= southY + 3.5 ? [
                [{ x: eastX, y: northY, skipTol: 0.35, ...(needEastLimit ? { speedLimit: 1.35 } : {}) }, { x: eastX, y: southY, skipTol: 0.35, speedLimit: 1.25 }, { x: Math.min(eastX - 2.0, tx + 6.5), y: southY, skipTol: 0.35, speedLimit: 1.0 }],
                [{ x: eastX, y: southY, skipTol: 0.35, ...(needEastLimit ? { speedLimit: 1.35 } : {}) }, { x: Math.min(eastX - 2.0, tx + 6.5), y: southY, skipTol: 0.35, speedLimit: 1.0 }],
              ] : []),
              ...(tx > westX + 6.0 && ty >= southY && ty <= southY + 3.5 ? [
                [{ x: westX, y: northY }, { x: westX, y: southY, skipTol: 0.35, speedLimit: 1.25 }, { x: Math.max(westX + 2.0, tx - 6.5), y: southY, skipTol: 0.35, speedLimit: 1.0 }],
                [{ x: westX, y: southY }, { x: Math.max(westX + 2.0, tx - 6.5), y: southY, skipTol: 0.35, speedLimit: 1.0 }],
              ] : []),
              ...(tx < eastX - 6.0 && ty >= northY - 3.5 && ty <= northY ? [
                [{ x: eastX, y: southY, skipTol: 0.35, ...(needEastLimit ? { speedLimit: 1.35 } : {}) }, { x: eastX, y: northY, skipTol: 0.35, speedLimit: 1.25 }, { x: Math.min(eastX - 2.0, tx + 6.5), y: northY, skipTol: 0.35, speedLimit: 1.0 }],
                [{ x: eastX, y: northY, skipTol: 0.35, ...(needEastLimit ? { speedLimit: 1.35 } : {}) }, { x: Math.min(eastX - 2.0, tx + 6.5), y: northY, skipTol: 0.35, speedLimit: 1.0 }],
              ] : []),
              ...(tx > westX + 6.0 && ty >= northY - 3.5 && ty <= northY ? [
                [{ x: westX, y: southY }, { x: westX, y: northY, skipTol: 0.35, speedLimit: 1.25 }, { x: Math.max(westX + 2.0, tx - 6.5), y: northY, skipTol: 0.35, speedLimit: 1.0 }],
                [{ x: westX, y: northY }, { x: Math.max(westX + 2.0, tx - 6.5), y: northY, skipTol: 0.35, speedLimit: 1.0 }],
              ] : []),
              [{ x: eastX, y: northY, skipTol: 0.35, ...(needEastLimit ? { speedLimit: 1.35 } : {}) }, { x: eastX, y: southY - 1.5, skipTol: 0.35, speedLimit: 1.25 }, { x: tx, y: southY - 1.5, skipTol: 0.35, speedLimit: 1.25 }],
              [{ x: westX, y: northY }, { x: westX, y: southY - 1.5, skipTol: 0.35, speedLimit: 1.25 }, { x: tx, y: southY - 1.5, skipTol: 0.35, speedLimit: 1.25 }],
              ...(hasRackBounds && tx > rackMaxX && fx <= rackMaxX ? [
                ...(fy > southY + 0.5 ? [[{ x: westX, y: fy, skipTol: 0.45 }, { x: westX, y: southY, skipTol: 0.45 }, { x: eastX, y: southY, skipTol: 0.35, speedLimit: 1.25 }, { x: eastX, y: ty, skipTol: 0.35, speedLimit: 1.0 }]] : []),
                [{ x: westX, y: southY, skipTol: 0.45 }, { x: eastX, y: southY, skipTol: 0.35, speedLimit: 1.25 }, { x: eastX, y: ty, skipTol: 0.35, speedLimit: 1.0 }],
              ] : []),
              ...(hasRackBounds && tx < rackMinX && fx >= ox + 4.0 ? [
                ...(fy > southY + 0.5 ? [[{ x: eastX, y: fy, skipTol: 0.45 }, { x: eastX, y: southY, skipTol: 0.45 }, { x: westX, y: southY, skipTol: 0.35, speedLimit: 1.25 }, { x: westX, y: ty, skipTol: 0.35, speedLimit: 1.0 }]] : []),
                [{ x: eastX, y: southY, skipTol: 0.45 }, { x: westX, y: southY, skipTol: 0.35, speedLimit: 1.25 }, { x: westX, y: ty, skipTol: 0.35, speedLimit: 1.0 }],
              ] : []),
              ...(tx >= eastX - 1.0 && (fx <= westX + 1.0 || (aisleAxisExitInfo && !aisleAxisExitInfo.isEast)) ? [
                ...(fy <= oy - 19.0 ? [[{ x: westX, y: fy, skipTol: 0.45 }, { x: westX, y: southY, skipTol: 0.45 }, { x: eastX, y: southY, skipTol: 0.35, speedLimit: 1.25 }, { x: eastX, y: ty, skipTol: 0.25, speedLimit: 0.85 }]] : []),
                [{ x: westX, y: southY, skipTol: 0.45 }, { x: eastX, y: southY, skipTol: 0.35, speedLimit: 1.25 }, { x: eastX, y: ty, skipTol: 0.25, speedLimit: 0.85 }],
                ...(tx > eastX && needCloseTargetAlign && closeTargetDist < 0.85 ? [
                  [{ x: westX, y: northY, skipTol: 0.45 }, { x: eastX, y: northY, skipTol: 0.35, speedLimit: 1.25 }],
                  [{ x: westX, y: southY, skipTol: 0.45 }, { x: eastX, y: southY, skipTol: 0.35, speedLimit: 1.25 }],
                ] : []),
                ...(hasRackBounds ? aisleList.map((a) => [{ x: westX, y: a.y, skipTol: 0.45 }, { x: eastX, y: a.y, skipTol: 0.45 }, { x: eastX, y: ty, skipTol: 0.25, speedLimit: 0.85 }]) : []),
              ] : []),
              ...(isEastMouthTarget ? [
                [{ x: eastX, y: zoneDBufY, skipTol: 0.45 }, { x: eastX, y: mouthAisleY, skipTol: 0.35, speedLimit: 1.15 }, { x: eastX - 1.2, y: mouthAisleY, skipTol: 0.35, speedLimit: 1.0 }],
                [{ x: westX, y: zoneDBufY, skipTol: 0.45 }, { x: eastX, y: zoneDBufY, skipTol: 0.45 }, { x: eastX, y: mouthAisleY, skipTol: 0.35, speedLimit: 1.15 }, { x: eastX - 1.2, y: mouthAisleY, skipTol: 0.35, speedLimit: 1.0 }],
                [{ x: westX, y: southY, skipTol: 0.45 }, { x: eastX, y: southY, skipTol: 0.45 }, { x: eastX, y: mouthAisleY, skipTol: 0.35, speedLimit: 1.15 }, { x: eastX - 1.2, y: mouthAisleY, skipTol: 0.35, speedLimit: 1.0 }],
                [{ x: westX, y: northY, skipTol: 0.45 }, { x: eastX, y: northY, skipTol: 0.45 }, { x: eastX, y: mouthAisleY, skipTol: 0.35, speedLimit: 1.15 }, { x: eastX - 1.2, y: mouthAisleY, skipTol: 0.35, speedLimit: 1.0 }],
                [{ x: eastX, y: fy, skipTol: 0.45 }, { x: eastX, y: mouthAisleY, skipTol: 0.35, speedLimit: 1.15 }, { x: eastX - 1.2, y: mouthAisleY, skipTol: 0.35, speedLimit: 1.0 }],
                [{ x: eastX, y: southY, skipTol: 0.45 }, { x: eastX, y: mouthAisleY, skipTol: 0.35, speedLimit: 1.15 }, { x: eastX - 1.2, y: mouthAisleY, skipTol: 0.35, speedLimit: 1.0 }],
                [{ x: eastX, y: northY, skipTol: 0.45 }, { x: eastX, y: mouthAisleY, skipTol: 0.35, speedLimit: 1.15 }, { x: eastX - 1.2, y: mouthAisleY, skipTol: 0.35, speedLimit: 1.0 }],
              ] : []),
              ...(isWestMouthTarget ? [
                [{ x: westX, y: zoneDBufY, skipTol: 0.45 }, { x: westX, y: mouthAisleY, skipTol: 0.35, speedLimit: 1.15 }, { x: westX + 1.2, y: mouthAisleY, skipTol: 0.35, speedLimit: 1.0 }],
                [{ x: eastX, y: zoneDBufY, skipTol: 0.45 }, { x: westX, y: zoneDBufY, skipTol: 0.45 }, { x: westX, y: mouthAisleY, skipTol: 0.35, speedLimit: 1.15 }, { x: westX + 1.2, y: mouthAisleY, skipTol: 0.35, speedLimit: 1.0 }],
                [{ x: eastX, y: southY, skipTol: 0.45 }, { x: westX, y: southY, skipTol: 0.45 }, { x: westX, y: mouthAisleY, skipTol: 0.35, speedLimit: 1.15 }, { x: westX + 1.2, y: mouthAisleY, skipTol: 0.35, speedLimit: 1.0 }],
                [{ x: eastX, y: northY, skipTol: 0.45 }, { x: westX, y: northY, skipTol: 0.45 }, { x: westX, y: mouthAisleY, skipTol: 0.35, speedLimit: 1.15 }, { x: westX + 1.2, y: mouthAisleY, skipTol: 0.35, speedLimit: 1.0 }],
                [{ x: westX, y: fy, skipTol: 0.45 }, { x: westX, y: mouthAisleY, skipTol: 0.35, speedLimit: 1.15 }, { x: westX + 1.2, y: mouthAisleY, skipTol: 0.35, speedLimit: 1.0 }],
                [{ x: westX, y: southY, skipTol: 0.45 }, { x: westX, y: mouthAisleY, skipTol: 0.35, speedLimit: 1.15 }, { x: westX + 1.2, y: mouthAisleY, skipTol: 0.35, speedLimit: 1.0 }],
                [{ x: westX, y: northY, skipTol: 0.45 }, { x: westX, y: mouthAisleY, skipTol: 0.35, speedLimit: 1.15 }, { x: westX + 1.2, y: mouthAisleY, skipTol: 0.35, speedLimit: 1.0 }],
              ] : []),
              ...(isNearRackEndAisleEntry ? [
                ...(fx < rackMinX - 0.5 ? [
                  [{ x: westX, y: fy, skipTol: 0.45 }, ...buildAisleEntrySuffix("west", westX, fy)],
                  [{ x: westX, y: targetAisleY + 2.2, skipTol: 0.45, speedLimit: 1.15 }, ...buildAisleEntrySuffix("west", westX, targetAisleY + 2.2)],
                  [{ x: westX, y: targetAisleY - 2.2, skipTol: 0.45, speedLimit: 1.15 }, ...buildAisleEntrySuffix("west", westX, targetAisleY - 2.2)],
                  [{ x: westX - 2.2, y: targetAisleY, skipTol: 0.45, speedLimit: 1.15 }, ...buildAisleEntrySuffix("west", westX - 2.2, targetAisleY)],
                ] : []),
                ...(fx > rackMaxX + 0.5 ? [
                  [{ x: eastX, y: fy, skipTol: 0.45 }, ...buildAisleEntrySuffix("east", eastX, fy)],
                  [{ x: eastX, y: targetAisleY + 2.2, skipTol: 0.45, speedLimit: 1.15 }, ...buildAisleEntrySuffix("east", eastX, targetAisleY + 2.2)],
                  [{ x: eastX, y: targetAisleY - 2.2, skipTol: 0.45, speedLimit: 1.15 }, ...buildAisleEntrySuffix("east", eastX, targetAisleY - 2.2)],
                  [{ x: eastX + 2.2, y: targetAisleY, skipTol: 0.45, speedLimit: 1.15 }, ...buildAisleEntrySuffix("east", eastX + 2.2, targetAisleY)],
                ] : []),
              ] : []),
              ...(hasRackBounds && fx >= eastX - 1.0 && tx <= westX + 1.0
                ? [
                  ...aisleList.map((a) => [{ x: eastX, y: a.y, skipTol: 0.45 }, { x: westX, y: a.y, skipTol: 0.45 }]),
                  [{ x: eastX, y: northY, skipTol: 0.45 }, { x: westX, y: northY, skipTol: 0.45 }],
                  [{ x: eastX, y: southY, skipTol: 0.45 }, { x: westX, y: southY, skipTol: 0.45 }],
                ]
                : []),
            ];
      if (fy < oy - 23.5) {
        const westPrefs = isSouthOfChargersStart
          ? []
          : [[{ x: fx, y: zoneDHwyY, skipTol: 0.45 }, { x: westX, y: zoneDHwyY, skipTol: 0.45 }]];
        const eastPrefs = isSouthOfChargersStart
          ? []
          : [[
            { x: fx, y: zoneDHwyY, skipTol: 0.45 },
            { x: eastBypassX, y: zoneDHwyY, skipTol: 0.45 },
            { x: eastBypassX, y: zoneDBufY, skipTol: 0.45 },
          ]];
        if (isSouthOfChargersStart) {
          const [fHx, fHy] = checkAgfDeparture ? headingForward(opts.heading) : [0, 0];
          const isChargerRowTarget = ty >= oy - 38.5 && ty <= oy - 36.75 && Math.abs(tx - ox) <= 18.0;
          const addWestFrom = (prefix, curY) => {
            if (isChargerRowTarget) {
              westPrefs.push([...prefix, { x: westX, y: curY, skipTol: 0.45, speedLimit: 1.0 }, { x: westX, y: oy - 34.5, skipTol: 0.35, speedLimit: 0.90 }]);
            }
            westPrefs.push([...prefix, { x: westX, y: curY, skipTol: 0.45, speedLimit: 1.0 }, { x: westX, y: zoneDHwyY, skipTol: 0.45 }]);
          };
          const addEastFrom = (prefix, curY) => {
            if (isChargerRowTarget) {
              eastPrefs.push([...prefix, { x: eastBypassX, y: curY, skipTol: 0.35, speedLimit: 0.90 }, { x: eastBypassX, y: oy - 36.2, skipTol: 0.25, speedLimit: 0.70 }, { x: eastBypassX, y: oy - 34.5, skipTol: 0.25, speedLimit: 0.75 }]);
              eastPrefs.push([...prefix, { x: eastBypassX, y: curY, skipTol: 0.35, speedLimit: 0.90 }, { x: eastBypassX, y: oy - 36.2, skipTol: 0.25, speedLimit: 0.70 }, { x: eastBypassX, y: zoneDHwyY, skipTol: 0.25, speedLimit: 0.70 }]);
            }
            eastPrefs.push([...prefix, { x: eastBypassX, y: curY, skipTol: 0.45, speedLimit: 1.0 }, { x: eastBypassX, y: zoneDBufY, skipTol: 0.45 }]);
            if (ty < oy - 23.5) {
              eastPrefs.push([...prefix, { x: eastBypassX, y: curY, skipTol: 0.45, speedLimit: 1.0 }, { x: eastBypassX, y: zoneDHwyY, skipTol: 0.45 }]);
            }
          };
          if (fy <= oy - 41.5) {
            addWestFrom([], fy);
            addEastFrom([], fy);
          } else {
            if (checkAgfDeparture && Math.abs(fx - ox) <= 18.0 && fy >= oy - 39.25 && Math.abs(fHx) > 0.35 && Math.abs(fHy) < 0.45) {
              const dirSign = fHx >= 0 ? 1 : -1;
              const gapCx = clamp(ox + Math.round((fx - ox) / 4) * 4, ox - 12.0, ox + 12.0);
              const pivS = { x: clamp(fx + dirSign * 0.21, ox - 17.5, ox + 17.5), y: fy - 0.55, skipTol: 0.12, speedLimit: 0.45, _standPivot: true };
              const revGap = { x: gapCx, y: oy - 37.5, reverse: true, skipTol: 0.25, speedLimit: 0.65 };
              const clearGapS = { x: gapCx, y: oy - 41.5, skipTol: 0.35, speedLimit: 1.0 };
              if (pathIsClear(fx, fy, pivS.x, pivS.y, obstacles, pad) && pathIsClear(pivS.x, pivS.y, revGap.x, revGap.y, obstacles, pad)) {
                addWestFrom([pivS, revGap, clearGapS], clearGapS.y);
                addEastFrom([pivS, revGap, clearGapS], clearGapS.y);
              }
              for (const [dxS, yS] of [[1.1, oy - 40.35], [1.5, oy - 40.35], [1.6, oy - 39.85], [2.2, oy - 40.35]]) {
                const fwdSouth = { x: clamp(fx + dirSign * dxS, ox - 17.5, ox + 17.5), y: yS, skipTol: 0.25, speedLimit: 0.55 };
                if (pathIsClear(fx, fy, fwdSouth.x, fwdSouth.y, obstacles, pad)) {
                  addWestFrom([fwdSouth], fwdSouth.y);
                  addEastFrom([fwdSouth], fwdSouth.y);
                }
              }
              for (const dPullS of [1.0, 1.6, 2.4]) {
                const revSX = clamp(fx - dirSign * dPullS, ox - 18.0, ox + 18.0);
                const revSY = oy - 39.65;
                const revS1 = { x: revSX, y: revSY, reverse: true, skipTol: 0.30, speedLimit: 0.75 };
                if (pathIsClear(fx, fy, revSX, revSY, obstacles, pad)) {
                  const sClearS = { x: revSX, y: oy - 40.5, skipTol: 0.40, speedLimit: 0.90 };
                  addWestFrom([revS1], revSY);
                  addEastFrom([revS1], revSY);
                  addWestFrom([revS1, sClearS], sClearS.y);
                  addEastFrom([revS1, sClearS], sClearS.y);
                }
              }
              for (const dPull of [2.0, 2.5, 3.0, 1.5, 3.5]) {
                const revX = fx - dirSign * dPull;
                const revY = Math.max(oy - 39.32, fy - 0.25);
                const outY = oy - 39.85;
                const outX = dirSign > 0 ? ox - 17.5 : ox + 17.5;
                const rev1 = { x: revX, y: revY, reverse: true, skipTol: 0.35, speedLimit: 1.2 };
                const sClear = { x: revX, y: oy - 40.5, skipTol: 0.40, speedLimit: 0.90 };
                if ((Math.abs(revX - ox) < 14.5 || Math.abs(revX - ox) >= 17.5) && pathIsClear(revX, revY, sClear.x, sClear.y, obstacles, pad)) {
                  addWestFrom([rev1, sClear], sClear.y);
                  addEastFrom([rev1, sClear], sClear.y);
                }
                const rev2 = { x: outX, y: outY, reverse: true, skipTol: 0.40, speedLimit: 1.2 };
                if (dirSign > 0) {
                  if (isChargerRowTarget) {
                    westPrefs.push([rev1, rev2, { x: westX, y: outY, skipTol: 0.45 }, { x: westX, y: oy - 34.5, skipTol: 0.35, speedLimit: 0.90 }]);
                  }
                  westPrefs.push([rev1, rev2, { x: westX, y: outY, skipTol: 0.45 }, { x: westX, y: zoneDHwyY, skipTol: 0.45 }]);
                  eastPrefs.push([rev1, rev2, { x: westX, y: outY, skipTol: 0.45 }, { x: westX, y: zoneDHwyY, skipTol: 0.45 }, { x: eastBypassX, y: zoneDHwyY, skipTol: 0.45 }, { x: eastBypassX, y: zoneDBufY, skipTol: 0.45 }]);
                } else {
                  if (isChargerRowTarget) {
                    eastPrefs.push([rev1, rev2, { x: eastBypassX, y: outY, skipTol: 0.45 }, { x: eastBypassX, y: oy - 34.5, skipTol: 0.35, speedLimit: 0.90 }]);
                    westPrefs.push([rev1, rev2, { x: westX, y: outY, skipTol: 0.45, speedLimit: 1.0 }, { x: westX, y: oy - 34.5, skipTol: 0.35, speedLimit: 0.90 }]);
                  }
                  eastPrefs.push([rev1, rev2, { x: eastBypassX, y: outY, skipTol: 0.45 }, { x: eastBypassX, y: zoneDBufY, skipTol: 0.45 }]);
                  westPrefs.push([rev1, rev2, { x: eastBypassX, y: outY, skipTol: 0.45 }, { x: eastBypassX, y: zoneDHwyY, skipTol: 0.45 }, { x: westX, y: zoneDHwyY, skipTol: 0.45 }]);
                }
              }
            }
            if (!(checkAgfDeparture && Math.abs(fx - ox) <= 18.0 && fy >= oy - 39.25 && Math.abs(fHx) > 0.35 && Math.abs(fHy) < 0.35) && (!checkAgfDeparture || fHx >= 0.45)) {
              const outEY = (checkAgfDeparture && fHy > 0.05 && fy > oy - 39.85) ? oy - 39.85 : fy;
              const outE = { x: ox + 16.8, y: outEY, skipTol: 0.35, speedLimit: 1.35 };
              const bypE = { x: eastBypassX, y: outEY, skipTol: 0.35, speedLimit: 1.0 };
              eastPrefs.push([outE, bypE, { x: eastBypassX, y: zoneDBufY, skipTol: 0.45 }]);
              if (ty < oy - 23.5) {
                eastPrefs.push([outE, bypE, { x: eastBypassX, y: zoneDHwyY, skipTol: 0.45 }]);
              }
              westPrefs.push([outE, bypE, { x: eastBypassX, y: zoneDHwyY, skipTol: 0.45 }, { x: westX, y: zoneDHwyY, skipTol: 0.45 }]);
              const revW = { x: ox - 16.8, y: fy, reverse: true, skipTol: 0.35, speedLimit: 1.0 };
              if (pathIsClear(fx, fy, revW.x, revW.y, obstacles, pad)) {
                westPrefs.push([revW, { x: westX, y: fy, reverse: true, skipTol: 0.35, speedLimit: 1.0 }, { x: westX, y: zoneDHwyY, skipTol: 0.45 }]);
              }
            }
            if (!(checkAgfDeparture && Math.abs(fx - ox) <= 18.0 && fy >= oy - 39.25 && Math.abs(fHx) > 0.35 && Math.abs(fHy) < 0.35) && (!checkAgfDeparture || fHx <= -0.45)) {
              const outWY = (checkAgfDeparture && fHy > 0.05 && fy > oy - 39.85) ? oy - 39.85 : fy;
              const outW = { x: ox - 16.8, y: outWY, skipTol: 0.35, speedLimit: 1.35 };
              const bypW = { x: westX, y: outWY, skipTol: 0.35, speedLimit: 1.0 };
              westPrefs.push([outW, bypW, { x: westX, y: zoneDHwyY, skipTol: 0.45 }]);
              eastPrefs.push([outW, bypW, { x: westX, y: zoneDHwyY, skipTol: 0.45 }, { x: eastBypassX, y: zoneDHwyY, skipTol: 0.45 }, { x: eastBypassX, y: zoneDBufY, skipTol: 0.45 }]);
              const revE = { x: ox + 16.8, y: fy, reverse: true, skipTol: 0.35, speedLimit: 1.0 };
              if (pathIsClear(fx, fy, revE.x, revE.y, obstacles, pad)) {
                eastPrefs.push([revE, { x: eastBypassX, y: fy, reverse: true, skipTol: 0.35, speedLimit: 1.0 }, { x: eastBypassX, y: zoneDBufY, skipTol: 0.45 }]);
                if (ty < oy - 23.5) {
                  eastPrefs.push([revE, { x: eastBypassX, y: fy, reverse: true, skipTol: 0.35, speedLimit: 1.0 }, { x: eastBypassX, y: zoneDHwyY, skipTol: 0.45 }]);
                }
              }
            }
            if (!checkAgfDeparture || fHy <= -0.30) {
              const sDist = Math.min(6.5, Math.max(1.8, (fy - (oy - 42.0)) / Math.max(-fHy, 0.35)));
              const pullS = { x: fx + fHx * sDist, y: fy + fHy * sDist, skipTol: 0.35, speedLimit: 1.0 };
              if (pullS.y >= oy - 44.2 && checkSegClear(fx, fy, pullS.x, pullS.y, true, false)) {
                addWestFrom([pullS], pullS.y);
                addEastFrom([pullS], pullS.y);
              }
            }
            if (!checkAgfDeparture || fHy >= 0.30) {
              const revD = Math.min(6.5, Math.max(1.8, (fy - (oy - 42.2)) / Math.max(fHy, 0.35)));
              for (const revDist of [2.6, 3.6, revD]) {
                const revS = { x: fx - fHx * revDist, y: fy - fHy * revDist, reverse: true, skipTol: 0.25, speedLimit: 0.85 };
                if (revS.y >= oy - 44.2 && checkSegClear(fx, fy, revS.x, revS.y, true, false)) {
                  addWestFrom([revS], revS.y);
                  addEastFrom([revS], revS.y);
                }
              }
            }
            if (checkAgfDeparture) {
              const pivDists = (westPrefs.length > 0 && eastPrefs.length > 0) ? [0.45] : [0.45, 0.90, 1.50];
              for (const revFlag of [true, false]) {
                for (const dPiv of pivDists) {
                  for (const ang of [0, -0.75, 0.75, -1.25, 1.25]) {
                    const dir = revFlag ? opts.heading + Math.PI + ang : opts.heading + ang;
                    const piv = {
                      x: fx + Math.sin(dir) * dPiv,
                      y: fy + Math.cos(dir) * dPiv,
                      ...(revFlag ? { reverse: true } : {}),
                      skipTol: 0.25,
                      speedLimit: dPiv < 0.7 ? 0.50 : 0.80,
                      _standPivot: true,
                    };
                    if (minDistanceToObstacles(piv.x, piv.y, obstacles) < 0.66 || !checkSegClear(fx, fy, piv.x, piv.y, true, false) || !arcClearFor([piv], false)) continue;
                    const clearS = { x: piv.x, y: oy - 42.0, skipTol: 0.35, speedLimit: 1.0 };
                    addWestFrom([piv], piv.y);
                    addEastFrom([piv], piv.y);
                    if (pathIsClear(piv.x, piv.y, clearS.x, clearS.y, obstacles, pad)) {
                      addWestFrom([piv, clearS], clearS.y);
                      addEastFrom([piv, clearS], clearS.y);
                    }
                  }
                }
              }
            }
          }
        } else if (fy < oy - 30.0) {
          if (fy <= oy - 36.5 && Math.abs(fx - ox) <= 18.0) {
            const [fHxG, fHyG] = checkAgfDeparture ? headingForward(opts.heading) : [0, 0];
            const laneY = oy - 34.5;
            const gapEdgePad = (checkAgfDeparture && startMinDist >= 0.572 && Math.abs(fHyG) >= 0.85) ? Math.min(pad, Math.max(0.57, startMinDist - 0.004)) : pad;
            if (!checkAgfDeparture || fHyG <= -0.35) {
              const sDist = Math.min(6.5, Math.max(1.8, (fy - (oy - 41.8)) / Math.max(-fHyG, 0.5)));
              const pullS = { x: fx + fHxG * sDist, y: fy + fHyG * sDist, skipTol: 0.35, speedLimit: 1.1 };
              if (pathIsClear(fx, fy, pullS.x, pullS.y, obstacles, gapEdgePad)) {
                westPrefs.push([pullS, { x: westX, y: pullS.y, skipTol: 0.45, speedLimit: 1.0 }, { x: westX, y: zoneDHwyY, skipTol: 0.45 }]);
                eastPrefs.push([pullS, { x: eastBypassX, y: pullS.y, skipTol: 0.45, speedLimit: 1.0 }, { x: eastBypassX, y: zoneDBufY, skipTol: 0.45 }]);
              }
              const rLane = Math.min(5.5, Math.max(1.4, (laneY - fy) / Math.max(-fHyG, 0.35)));
              const revN = { x: fx - fHxG * rLane, y: fy - fHyG * rLane, reverse: true, skipTol: 0.35, speedLimit: 0.90 };
              if (pathIsClear(fx, fy, revN.x, revN.y, obstacles, gapEdgePad)) {
                westPrefs.push([revN, { x: westX, y: revN.y, skipTol: 0.45 }, { x: westX, y: zoneDHwyY, skipTol: 0.45 }]);
                eastPrefs.push([revN, { x: eastBypassX, y: revN.y, skipTol: 0.45 }, { x: eastBypassX, y: zoneDBufY, skipTol: 0.45 }]);
              }
            }
            if (!checkAgfDeparture || fHyG >= 0.35) {
              for (const rDist of [1.6, 2.4, Math.min(6.5, Math.max(1.8, (fy - (oy - 41.8)) / Math.max(fHyG, 0.5)))]) {
                const revS = { x: fx - fHxG * rDist, y: fy - fHyG * rDist, reverse: true, skipTol: 0.35, speedLimit: 0.90 };
                if (revS.y >= oy - 44.2 && pathIsClear(fx, fy, revS.x, revS.y, obstacles, gapEdgePad)) {
                  const sLaneY = Math.min(revS.y, oy - 39.8);
                  const stepS = sLaneY < revS.y - 0.1 ? [{ x: revS.x, y: sLaneY, reverse: true, skipTol: 0.35, speedLimit: 0.90 }] : [];
                  westPrefs.push([revS, ...stepS, { x: westX, y: sLaneY, skipTol: 0.45, speedLimit: 1.0 }, { x: westX, y: zoneDHwyY, skipTol: 0.45 }]);
                  eastPrefs.push([revS, ...stepS, { x: eastBypassX, y: sLaneY, skipTol: 0.45, speedLimit: 1.0 }, { x: eastBypassX, y: zoneDBufY, skipTol: 0.45 }]);
                }
              }
              const fLane = Math.min(5.5, Math.max(1.4, (laneY - fy) / Math.max(fHyG, 0.35)));
              const fwdN = { x: fx + fHxG * fLane, y: fy + fHyG * fLane, skipTol: 0.35, speedLimit: 1.0 };
              if (pathIsClear(fx, fy, fwdN.x, fwdN.y, obstacles, gapEdgePad)) {
                westPrefs.push([fwdN, { x: westX, y: fwdN.y, skipTol: 0.45 }, { x: westX, y: zoneDHwyY, skipTol: 0.45 }]);
                eastPrefs.push([fwdN, { x: eastBypassX, y: fwdN.y, skipTol: 0.45 }, { x: eastBypassX, y: zoneDBufY, skipTol: 0.45 }]);
              }
            }
            if ((!checkAgfDeparture || fHyG >= -0.35) && pathIsClear(fx, fy, fx, laneY, obstacles, gapEdgePad)) {
              westPrefs.push([{ x: fx, y: laneY, skipTol: 0.45 }, { x: westX, y: laneY, skipTol: 0.45 }, { x: westX, y: zoneDHwyY, skipTol: 0.45 }]);
              eastPrefs.push([{ x: fx, y: laneY, skipTol: 0.45 }, { x: eastBypassX, y: laneY, skipTol: 0.45 }, { x: eastBypassX, y: zoneDBufY, skipTol: 0.45 }]);
            }
            if ((!checkAgfDeparture || fHyG <= -0.35) && pathIsClear(fx, fy, fx, laneY, obstacles, gapEdgePad)) {
              westPrefs.push([{ x: fx, y: laneY, reverse: true, skipTol: 0.45, speedLimit: 1.0 }, { x: westX, y: laneY, skipTol: 0.45 }, { x: westX, y: zoneDHwyY, skipTol: 0.45 }]);
              eastPrefs.push([{ x: fx, y: laneY, reverse: true, skipTol: 0.45, speedLimit: 1.0 }, { x: eastBypassX, y: laneY, skipTol: 0.45 }, { x: eastBypassX, y: zoneDBufY, skipTol: 0.45 }]);
            }
            if (Math.abs(fHxG) > 0.35 || !checkAgfDeparture) {
              if (checkAgfDeparture && Math.abs(fHxG) > 0.35) {
                const dirSign = fHxG >= 0 ? 1 : -1;
                if (Math.abs(fHyG) < 0.35) {
                  for (const dPull of [2.0, 2.5, 3.0, 3.5, 1.5]) {
                    const revX = fx - dirSign * dPull;
                    const revY = Math.min(laneY, fy + 0.25);
                    const outY = Math.min(laneY, Math.max(fy + 0.45, oy - 36.15));
                    const outX = dirSign > 0 ? ox - 17.5 : ox + 17.5;
                    const rev1 = { x: revX, y: revY, reverse: true, skipTol: 0.35, speedLimit: 1.2 };
                    if ((Math.abs(revX - ox) < 14.5 || Math.abs(revX - ox) >= 17.5) && pathIsClear(revX, revY, revX, laneY, obstacles, pad)) {
                      const pLane = { x: revX, y: laneY, skipTol: 0.40, speedLimit: 0.90 };
                      westPrefs.push([rev1, pLane, { x: westX, y: laneY, skipTol: 0.45 }, { x: westX, y: zoneDHwyY, skipTol: 0.45 }]);
                      eastPrefs.push([rev1, pLane, { x: eastBypassX, y: laneY, skipTol: 0.45 }, { x: eastBypassX, y: zoneDBufY, skipTol: 0.45 }]);
                    }
                    const rev2 = { x: outX, y: outY, reverse: true, skipTol: 0.40, speedLimit: 1.2 };
                    if (dirSign > 0) {
                      westPrefs.push([rev1, rev2, { x: westX, y: laneY, skipTol: 0.45 }, { x: westX, y: zoneDHwyY, skipTol: 0.45 }]);
                      eastPrefs.push([rev1, rev2, { x: westX, y: laneY, skipTol: 0.45 }, { x: westX, y: zoneDHwyY, skipTol: 0.45 }, { x: eastBypassX, y: zoneDHwyY, skipTol: 0.45 }, { x: eastBypassX, y: zoneDBufY, skipTol: 0.45 }]);
                    } else {
                      eastPrefs.push([rev1, rev2, { x: eastBypassX, y: laneY, skipTol: 0.45 }, { x: eastBypassX, y: zoneDBufY, skipTol: 0.45 }]);
                      westPrefs.push([rev1, rev2, { x: eastBypassX, y: laneY, skipTol: 0.45 }, { x: eastBypassX, y: zoneDHwyY, skipTol: 0.45 }, { x: westX, y: zoneDHwyY, skipTol: 0.45 }]);
                    }
                  }
                } else {
                  for (const dPull of [1.8, 2.5, 3.2]) {
                    const isFwdN = fHyG > 0;
                    const pX = isFwdN ? fx + fHxG * dPull : fx - fHxG * dPull;
                    const pY = isFwdN ? fy + fHyG * dPull : fy - fHyG * dPull;
                    if (pathIsClear(pX, pY, pX, laneY, obstacles, pad)) {
                      const pGap = { x: pX, y: pY, ...(isFwdN ? {} : { reverse: true }), skipTol: 0.30, speedLimit: 0.90 };
                      const pLane = { x: pX, y: laneY, skipTol: 0.40, speedLimit: 0.95 };
                      westPrefs.push([pGap, pLane, { x: westX, y: laneY, skipTol: 0.45 }, { x: westX, y: zoneDHwyY, skipTol: 0.45 }]);
                      eastPrefs.push([pGap, pLane, { x: eastBypassX, y: laneY, skipTol: 0.45 }, { x: eastBypassX, y: zoneDBufY, skipTol: 0.45 }]);
                    }
                  }
                }
              }
              if (!(checkAgfDeparture && fy >= oy - 37.05 && Math.abs(fHxG) > 0.35)) {
                westPrefs.push([{ x: westX, y: fy, skipTol: 0.45 }, { x: westX, y: zoneDHwyY, skipTol: 0.45 }]);
                eastPrefs.push([{ x: eastBypassX, y: fy, skipTol: 0.45 }, { x: eastBypassX, y: zoneDBufY, skipTol: 0.45 }]);
              }
            }
          } else {
            westPrefs.push([{ x: westX, y: fy, skipTol: 0.45 }, { x: westX, y: zoneDHwyY, skipTol: 0.45 }]);
            eastPrefs.push([{ x: eastBypassX, y: fy, skipTol: 0.45 }, { x: eastBypassX, y: zoneDBufY, skipTol: 0.45 }]);
          }
        } else if (fy >= oy - 30.0) {
          westPrefs.push([{ x: westX, y: fy, skipTol: 0.45 }]);
          westPrefs.push([{ x: fx, y: zoneDHwyY, skipTol: 0.45 }, { x: westX, y: zoneDHwyY, skipTol: 0.45 }]);
          eastPrefs.push([{ x: eastBypassX, y: fy, skipTol: 0.45 }, { x: eastBypassX, y: zoneDBufY, skipTol: 0.45 }]);
          eastPrefs.push([{ x: fx, y: zoneDHwyY, skipTol: 0.45 }, { x: eastBypassX, y: zoneDHwyY, skipTol: 0.45 }, { x: eastBypassX, y: zoneDBufY, skipTol: 0.45 }]);
        }
        for (const wp of westPrefs) {
          if (enteringAisleFromOutside) {
            cands.push([...wp, { x: westX, y: southY, skipTol: 0.45 }, ...buildAisleEntrySuffix("west", westX, southY)]);
          } else if (isZoneDStandTarget) {
            cands.push([...wp, ...westTargetSeq]);
          } else if (isZoneCStandTarget) {
            cands.push(
              [...wp, { x: westX, y: southY, skipTol: 0.45 }, { x: eastX, y: southY, skipTol: 0.35, speedLimit: 1.35 }, ...eastTargetSeq],
              [...wp, ...westTargetSeq],
            );
          } else if (isZoneAPadApproachTarget) {
            cands.push(
              [...wp, ...westTargetSeq],
              [...wp, { x: westX, y: northY, skipTol: 0.45 }, ...westTargetSeq],
            );
          } else if (isSouthOfChargers) {
            cands.push([...wp, ...westZoneDTail]);
          } else if (isZoneDTarget) {
            const wHwyEndX = (needCloseTargetAlign && Math.abs(tx - ox) <= 18.0 && ty > oy - 29.0) ? Math.max(westX + 0.5, tx - zoneDHwyPullOff) : tx;
            cands.push(
              ...(ty >= oy - 38.5 && ty <= oy - 36.75 && Math.abs(tx - ox) <= 18.0 ? [
                ...(wp.some((p) => Math.abs(p.y - (oy - 34.5)) < 0.25) ? [
                  [...wp, ...westZoneDTail.slice(2)],
                  ...(closeTargetObs?.kind === "charger" ? [
                    [...wp, { x: closeTargetObs.x1 + 2.5, y: closeTargetObs.y1 + 2.5, skipTol: 0.35, speedLimit: 1.25 }],
                    [...wp, { x: closeTargetObs.x0 - 2.5, y: closeTargetObs.y1 + 2.5, skipTol: 0.35, speedLimit: 1.25 }],
                  ] : []),
                ] : [[...wp, ...westZoneDTail]]),
              ] : []),
              [...wp, { x: wHwyEndX, y: zoneDHwyY, skipTol: 0.45 }],
              ...(wHwyEndX !== tx ? [[...wp, { x: tx, y: zoneDHwyY, skipTol: 0.45 }]] : []),
              [...wp, { x: westX, y: ty }],
            );
          } else {
            cands.push(
              [...wp, { x: westX, y: ty }],
              [...wp, { x: westX, y: zoneDBufY }, { x: tx, y: zoneDBufY }],
              [...wp, { x: westX, y: northY }, { x: tx, y: northY }],
              ...(isEastMouthTarget ? [[...wp, { x: westX, y: zoneDBufY, skipTol: 0.45 }, { x: eastX, y: zoneDBufY, skipTol: 0.45 }, { x: eastX, y: mouthAisleY, skipTol: 0.35, speedLimit: 1.15 }, { x: eastX - 1.2, y: mouthAisleY, skipTol: 0.35, speedLimit: 1.0 }]] : []),
            );
          }
        }
        for (const ep of eastPrefs) {
          if (enteringAisleFromOutside) {
            cands.push(
              [...ep, { x: eastX, y: zoneDBufY, skipTol: 0.45 }, { x: eastX, y: southY, skipTol: 0.45 }, ...buildAisleEntrySuffix("east", eastX, southY)],
              [...ep, { x: eastX, y: zoneDBufY, skipTol: 0.45 }, ...buildAisleEntrySuffix("east", eastX, zoneDBufY)],
              ...(isSouthOfChargersStart ? [
                [...ep, { x: eastBypassX, y: zoneDHwyY, skipTol: 0.45 }, { x: westX, y: zoneDHwyY, skipTol: 0.45 }, { x: westX, y: southY, skipTol: 0.45 }, ...buildAisleEntrySuffix("west", westX, southY)],
              ] : []),
            );
          } else if (isZoneDStandTarget) {
            cands.push([...ep, zoneDBufTarget]);
          } else if (isZoneCStandTarget) {
            cands.push([...ep, { x: eastX, y: zoneDBufY, skipTol: 0.45 }, ...eastTargetSeq]);
          } else if (isZoneAPadApproachTarget) {
            cands.push(
              [...ep, { x: eastX, y: zoneDBufY, skipTol: 0.45 }, ...eastTargetSeq],
              [...ep, { x: eastX, y: zoneDBufY, skipTol: 0.45 }, { x: eastX, y: northY, skipTol: 0.45 }, ...eastTargetSeq],
              ...(isSouthOfChargersStart ? [
                [...ep, { x: eastBypassX, y: zoneDHwyY, skipTol: 0.45 }, { x: westX, y: zoneDHwyY, skipTol: 0.45 }, ...westTargetSeq],
              ] : []),
            );
          } else if (isSouthOfChargers) {
            cands.push(
              [...ep, ...eastZoneDTail.slice(2)],
              ...(isSouthOfChargersStart ? [
                [...ep, { x: eastBypassX, y: zoneDHwyY, skipTol: 0.45 }, { x: westX, y: zoneDHwyY, skipTol: 0.45 }, ...westZoneDTail],
              ] : []),
            );
          } else {
            cands.push(
              [...ep, { x: eastX, y: zoneDBufY }, { x: eastX, y: ty }],
              [...ep, { x: eastX, y: zoneDBufY }, { x: eastX, y: northY }, { x: tx, y: northY }],
              [...ep, { x: tx, y: zoneDBufY }],
              ...(tx >= ox + 13.4 ? [[...ep, { x: eastBypassX, y: ty, skipTol: 0.45 }]] : []),
              ...(ty < oy - 23.5 ? (() => {
                const eHwyEndX = (needCloseTargetAlign && Math.abs(tx - ox) <= 18.0 && ty > oy - 29.0) ? Math.min(eastBypassX - 0.5, tx + zoneDHwyPullOff) : tx;
                return [
                  [...ep, { x: eastBypassX, y: zoneDHwyY, skipTol: 0.45 }, { x: eHwyEndX, y: zoneDHwyY, skipTol: 0.45 }],
                  ...(eHwyEndX !== tx ? [[...ep, { x: eastBypassX, y: zoneDHwyY, skipTol: 0.45 }, { x: tx, y: zoneDHwyY, skipTol: 0.45 }]] : []),
                ];
              })() : []),
              ...(isEastMouthTarget ? [[...ep, { x: eastX, y: zoneDBufY, skipTol: 0.45 }, { x: eastX, y: mouthAisleY, skipTol: 0.35, speedLimit: 1.15 }, { x: eastX - 1.2, y: mouthAisleY, skipTol: 0.35, speedLimit: 1.0 }]] : []),
              ...(ty >= oy - 38.5 && ty <= oy - 36.75 && Math.abs(tx - ox) <= 18.0 ? [
                ...(ep[ep.length - 1]?.y === zoneDHwyY ? [[...ep.slice(0, -1), { x: eastBypassX, y: oy - 36.2, skipTol: 0.28, speedLimit: 0.75 }, ...eastZoneDTail.slice(3)]] : []),
                ...(Math.abs((ep[ep.length - 1]?.y ?? 0) - (oy - 34.5)) < 0.25 ? [
                  [...ep, ...eastZoneDTail.slice(4)],
                  ...(closeTargetObs?.kind === "charger" ? [
                    [...ep, { x: closeTargetObs.x0 - 2.5, y: closeTargetObs.y1 + 2.5, skipTol: 0.35, speedLimit: 1.25 }],
                    [...ep, { x: closeTargetObs.x1 + 2.5, y: closeTargetObs.y1 + 2.5, skipTol: 0.35, speedLimit: 1.25 }],
                  ] : []),
                ] : []),
                ...(ep[ep.length - 1]?.y <= oy - 39.2 ? [
                  [...ep, { x: eastBypassX, y: oy - 34.5, skipTol: 0.35, speedLimit: 0.95 }, ...eastZoneDTail.slice(4)],
                  ...(closeTargetObs?.kind === "charger" ? [
                    [...ep, { x: eastBypassX, y: oy - 34.5, skipTol: 0.35, speedLimit: 0.95 }, { x: closeTargetObs.x0 - 2.5, y: closeTargetObs.y1 + 2.5, skipTol: 0.35, speedLimit: 1.25 }],
                    [...ep, { x: eastBypassX, y: oy - 34.5, skipTol: 0.35, speedLimit: 0.95 }, { x: closeTargetObs.x1 + 2.5, y: closeTargetObs.y1 + 2.5, skipTol: 0.35, speedLimit: 1.25 }],
                  ] : []),
                ] : []),
                [...ep, ...eastZoneDTail.slice(2)],
              ] : []),
              ...(isSouthOfChargersStart ? [
                ...(ty >= oy - 38.5 && ty <= oy - 36.75 && Math.abs(tx - ox) <= 18.0 ? [
                  [...ep, { x: eastBypassX, y: zoneDHwyY, skipTol: 0.45 }, ...westZoneDTail],
                  ...(ep[ep.length - 1]?.y <= oy - 39.2 ? [
                    [...ep, { x: westX, y: ep[ep.length - 1].y, skipTol: 0.35, speedLimit: 0.95 }, { x: westX, y: oy - 34.5, skipTol: 0.35, speedLimit: 0.95 }, ...westZoneDTail.slice(2)],
                  ] : []),
                ] : []),
                [...ep, { x: eastBypassX, y: zoneDHwyY, skipTol: 0.45 }, { x: westX, y: zoneDHwyY, skipTol: 0.45 }, { x: westX, y: ty }],
                [...ep, { x: eastBypassX, y: zoneDHwyY, skipTol: 0.45 }, { x: westX, y: zoneDHwyY, skipTol: 0.45 }, ...westTargetSeq],
              ] : []),
            );
          }
        }
        if (isSouthOfChargers && !isSouthOfChargersStart) {
          const eastTailDirect = eastZoneDTail.slice(2);
          cands.push(
            eastTailDirect,
            [{ x: eastBypassX, y: fy, skipTol: 0.45 }, ...eastTailDirect],
            westZoneDTail,
            [{ x: westX, y: fy, skipTol: 0.45 }, ...westZoneDTail],
            [{ x: fx, y: zoneDHwyY, skipTol: 0.45 }, { x: eastBypassX, y: zoneDHwyY, skipTol: 0.45 }, ...eastTailDirect],
          );
        }
        if (ty < oy - 23.5 && !isSouthOfChargers && !isSouthOfChargersStart && fy <= oy - 36.5 && Math.abs(fx - ox) <= 18.0) {
          const laneY = oy - 34.5;
          const [fHxG, fHyG] = checkAgfDeparture ? headingForward(opts.heading) : [0, 0];
          const gapEntry = (!checkAgfDeparture || fHyG >= -0.35)
            ? [{ x: fx, y: laneY, skipTol: 0.45 }]
            : [{ x: fx, y: laneY, reverse: true, skipTol: 0.45, speedLimit: 1.0 }];
          const hwyXWest = (needCloseTargetAlign && Math.abs(tx - ox) <= 18.0 && ty > oy - 29.0) ? Math.max(westX + 0.5, tx - zoneDHwyPullOff) : tx;
          const hwyXEast = (needCloseTargetAlign && Math.abs(tx - ox) <= 18.0 && ty > oy - 29.0) ? Math.min(eastBypassX - 0.5, tx + zoneDHwyPullOff) : tx;
          const gapPadN = (checkAgfDeparture && startMinDist >= 0.572) ? Math.min(pad, Math.max(0.57, startMinDist - 0.004)) : pad;
          if (pathIsClear(fx, fy, fx, laneY, obstacles, gapPadN)) {
            cands.push(
              ...((ty >= oy - 37.1 && ty <= oy - 36.75 && Math.abs(tx - ox) <= 18.0) ? [
                ...(tx <= ox - 13.5 ? [[...gapEntry, { x: ox - 17.5, y: laneY, skipTol: 0.30, speedLimit: 0.85 }, { x: ox - 17.5, y: ty, skipTol: 0.20, speedLimit: 0.70 }]] : []),
                ...(tx >= ox + 13.5 ? [[...gapEntry, { x: ox + 17.5, y: laneY, skipTol: 0.30, speedLimit: 0.85 }, { x: ox + 17.5, y: ty, skipTol: 0.20, speedLimit: 0.70 }]] : []),
                ...(tx - 5.2 >= westX ? [[...gapEntry, { x: tx - 5.2, y: laneY, skipTol: 0.22, speedLimit: 0.75 }]] : []),
                ...(tx + 5.2 <= eastBypassX ? [[...gapEntry, { x: tx + 5.2, y: laneY, skipTol: 0.22, speedLimit: 0.75 }]] : []),
                ...(tx - 3.5 >= westX ? [[...gapEntry, { x: tx - 3.5, y: laneY, skipTol: 0.35, speedLimit: 1.0 }]] : []),
                ...(tx + 3.5 <= eastBypassX ? [[...gapEntry, { x: tx + 3.5, y: laneY, skipTol: 0.35, speedLimit: 1.0 }]] : []),
              ] : []),
              [...gapEntry, { x: hwyXWest, y: zoneDHwyY, skipTol: 0.45 }],
              [...gapEntry, { x: hwyXEast, y: zoneDHwyY, skipTol: 0.45 }],
              [...gapEntry, { x: fx, y: zoneDHwyY, skipTol: 0.45 }, { x: hwyXWest, y: zoneDHwyY, skipTol: 0.45 }],
              [...gapEntry, { x: fx, y: zoneDHwyY, skipTol: 0.45 }, { x: hwyXEast, y: zoneDHwyY, skipTol: 0.45 }],
            );
          }
        }
        if (ty < oy - 23.5 && !isSouthOfChargers && !isSouthOfChargersStart) {
          cands.push([{ x: fx, y: zoneDHwyY, skipTol: 0.45 }, { x: tx, y: zoneDHwyY, skipTol: 0.45 }]);
          if (ty <= oy - 37.3 && Math.abs(tx - ox) <= 18.0 && closeTargetObs?.kind === "charger" && (tx <= closeTargetObs.x0 - 0.35 || tx >= closeTargetObs.x1 + 0.35)) {
            const obsCx = (closeTargetObs.x0 + closeTargetObs.x1) * 0.5;
            const dirX = tx >= obsCx ? 1 : -1;
            const gapX = tx + dirX * 0.78;
            cands.push([
              { x: fx, y: zoneDHwyY, skipTol: 0.45 },
              { x: gapX, y: zoneDHwyY, skipTol: 0.25, speedLimit: 0.95 },
              { x: gapX, y: oy - 32.2, skipTol: 0.22, speedLimit: 0.80 },
              { x: tx, y: oy - 34.0, skipTol: 0.18, speedLimit: 0.65 },
              { x: tx, y: oy - 35.8, skipTol: 0.14, speedLimit: 0.55 },
            ]);
          }
        }
      }
      if (fx > ox + 14.2 && fy >= oy - 13.0 && fy <= oy + 7.5) {
        const standN = tx <= ox + 10.5 ? Math.max(northY, oy + 8.6) : oy + 6.8;
        const standS = tx <= ox + 10.5 ? Math.min(southY, oy - 14.5) : oy - 12.8;
        const edgeX = Math.max(fx, ox + 16.5);
        const wideEdgeX = Math.max(fx + 1.8, ox + 18.0);
        const standBypassStarts = [
          [{ x: fx, y: standN, skipTol: 0.45 }],
          [{ x: fx, y: standS, skipTol: 0.45 }],
          ...(Math.abs(edgeX - fx) > 0.25 ? [
            [{ x: edgeX, y: standN, skipTol: 0.45 }],
            [{ x: edgeX, y: standS, skipTol: 0.45 }],
          ] : []),
          [{ x: wideEdgeX, y: standN, skipTol: 0.45 }],
          [{ x: wideEdgeX, y: standS, skipTol: 0.45 }],
        ];
        for (const sb of standBypassStarts) {
          const sy = sb[0].y;
          if (enteringAisleFromOutside) {
            cands.push([...sb, { x: eastX, y: sy, skipTol: 0.45 }, ...buildAisleEntrySuffix("east", eastX, sy)]);
          } else if (isZoneDStandTarget) {
            cands.push(
              [...sb, { x: eastX, y: sy, skipTol: 0.45 }, ...eastTargetSeq],
              [...sb, { x: eastBypassX, y: zoneDBufY, skipTol: 0.45 }, zoneDBufTarget],
              [...sb, { x: tx, y: sy, skipTol: 0.45 }, zoneDBufTarget],
            );
          } else if (isZoneCStandTarget) {
            cands.push([...sb, { x: eastX, y: sy, skipTol: 0.35, speedLimit: 1.35 }, ...eastTargetSeq]);
          } else if (isZoneDTarget) {
            cands.push(
              [...sb, { x: eastBypassX, y: sy, skipTol: 0.45 }, ...eastTargetSeq.slice(1)],
              [...sb, { x: eastBypassX, y: zoneDHwyY, skipTol: 0.45 }, { x: tx, y: zoneDHwyY, skipTol: 0.45 }],
            );
          } else if (isZoneAPadApproachTarget) {
            cands.push(
              [...sb, { x: eastX, y: sy, skipTol: 0.45 }, ...eastTargetSeq],
              [...sb, { x: westX, y: sy, skipTol: 0.45 }, ...westTargetSeq],
            );
          } else if (isWestMouthTarget) {
            cands.push(
              [...sb, { x: westX, y: sy, skipTol: 0.45 }, { x: westX, y: mouthAisleY, skipTol: 0.35, speedLimit: 1.15 }, { x: westX + 1.2, y: mouthAisleY, skipTol: 0.35, speedLimit: 1.0 }],
              [...sb, { x: eastX, y: sy, skipTol: 0.45 }, { x: westX, y: sy, skipTol: 0.45 }, { x: westX, y: mouthAisleY, skipTol: 0.35, speedLimit: 1.15 }, { x: westX + 1.2, y: mouthAisleY, skipTol: 0.35, speedLimit: 1.0 }],
            );
          } else if (isEastMouthTarget) {
            cands.push(
              [...sb, { x: eastX, y: sy, skipTol: 0.45 }, { x: eastX, y: mouthAisleY, skipTol: 0.35, speedLimit: 1.15 }, { x: eastX - 1.2, y: mouthAisleY, skipTol: 0.35, speedLimit: 1.0 }],
            );
          } else if (isZoneDNorthBandNonApproach) {
            cands.push(
              [...sb, { x: eastX, y: sy, skipTol: 0.45 }, ...eastTargetSeq],
              [...sb, { x: westX, y: sy, skipTol: 0.45 }, ...westTargetSeq],
            );
          } else {
            cands.push(
              [...sb, { x: eastX, y: sy, skipTol: 0.45 }, { x: eastX, y: ty }],
              [...sb, { x: tx, y: sy, skipTol: 0.35, ...(Math.abs(tx - fx) > 4.0 ? { speedLimit: 1.35 } : {}) }],
            );
          }
        }
      }
      if (tx >= ox + 13.4 && ty >= oy - 13.0 && ty <= oy + 7.5 && !isZoneCStandTarget) {
        const standN = Math.max(northY, oy + 8.6);
        const standS = Math.min(southY, oy - 14.5);
        const targetEdgeX = Math.max(tx + 1.4, ox + 17.5);
        const stageYs = [];
        if (ty + 4.8 <= northY - 0.5) stageYs.push(ty + 4.8);
        if (ty - 4.8 >= southY + 0.5) stageYs.push(ty - 4.8);
        for (const sy of [standN, standS]) {
          for (const ex of [targetEdgeX, eastBypassX]) {
            for (const stgY of stageYs) {
              cands.push(
                ...(fy > crossAisleY + 2.0 ? [
                  [{ x: fx, y: crossAisleY, skipTol: 0.45 }, { x: eastX, y: sy, skipTol: 0.45 }, { x: ex, y: sy, skipTol: 0.35, speedLimit: 1.35 }, { x: ex, y: stgY, skipTol: 0.35, speedLimit: 1.25 }],
                  [{ x: ox - 16.0, y: crossAisleY, skipTol: 0.45 }, { x: eastX, y: sy, skipTol: 0.45 }, { x: ex, y: sy, skipTol: 0.35, speedLimit: 1.35 }, { x: ex, y: stgY, skipTol: 0.35, speedLimit: 1.25 }],
                ] : []),
                [{ x: eastX, y: sy, skipTol: 0.45 }, { x: ex, y: sy, skipTol: 0.35, speedLimit: 1.35 }, { x: ex, y: stgY, skipTol: 0.35, speedLimit: 1.25 }],
                [{ x: westX, y: sy, skipTol: 0.45 }, { x: ex, y: sy, skipTol: 0.35, speedLimit: 1.35 }, { x: ex, y: stgY, skipTol: 0.35, speedLimit: 1.25 }],
                [{ x: ex, y: sy, skipTol: 0.35, speedLimit: 1.35 }, { x: ex, y: stgY, skipTol: 0.35, speedLimit: 1.25 }],
              );
            }
            cands.push(
              ...(fy > crossAisleY + 2.0 ? [
                [{ x: fx, y: crossAisleY, skipTol: 0.45 }, { x: eastX, y: sy, skipTol: 0.45 }, { x: ex, y: sy, skipTol: 0.35, speedLimit: 1.35 }, { x: ex, y: ty, skipTol: 0.35, speedLimit: 1.25 }],
                [{ x: ox - 16.0, y: crossAisleY, skipTol: 0.45 }, { x: eastX, y: sy, skipTol: 0.45 }, { x: ex, y: sy, skipTol: 0.35, speedLimit: 1.35 }, { x: ex, y: ty, skipTol: 0.35, speedLimit: 1.25 }],
              ] : []),
              [{ x: eastX, y: sy, skipTol: 0.45 }, { x: ex, y: sy, skipTol: 0.35, speedLimit: 1.35 }, { x: ex, y: ty, skipTol: 0.35, speedLimit: 1.25 }],
              [{ x: westX, y: sy, skipTol: 0.45 }, { x: ex, y: sy, skipTol: 0.35, speedLimit: 1.35 }, { x: ex, y: ty, skipTol: 0.35, speedLimit: 1.25 }],
              [{ x: ex, y: sy, skipTol: 0.35, speedLimit: 1.35 }, { x: ex, y: ty, skipTol: 0.35, speedLimit: 1.25 }],
            );
          }
        }
      }
      if (fy >= oy - 21.0 && fy <= southY + 0.5) {
        if (enteringAisleFromOutside) {
          cands.push(
            [{ x: westX, y: zoneDBufY, skipTol: 0.45 }, { x: westX, y: southY, skipTol: 0.45 }, ...buildAisleEntrySuffix("west", westX, southY)],
            [{ x: eastX, y: zoneDBufY, skipTol: 0.45 }, { x: eastX, y: southY, skipTol: 0.45 }, ...buildAisleEntrySuffix("east", eastX, southY)],
          );
        } else if (isZoneCStandTarget) {
          cands.push([{ x: eastX, y: zoneDBufY, skipTol: 0.45 }, ...eastTargetSeq]);
        } else if (isZoneAPadApproachTarget) {
          cands.push(
            [{ x: westX, y: zoneDBufY, skipTol: 0.45 }, ...westTargetSeq],
            [{ x: eastX, y: zoneDBufY, skipTol: 0.45 }, ...eastTargetSeq],
          );
        } else if (!isZoneDStandTarget) {
          cands.push(
            [{ x: westX, y: zoneDBufY, skipTol: 0.45 }, { x: westX, y: ty }],
            [{ x: eastX, y: zoneDBufY, skipTol: 0.45 }, { x: eastX, y: ty }],
          );
        }
      }
      if (fy < southY - 4.0) {
        const pullY = Math.min(fy + 4.0, southY - 2.2);
        if (enteringAisleFromOutside) {
          cands.push(
            [{ x: fx, y: pullY, skipTol: 0.45 }, { x: westX, y: southY, skipTol: 0.45, speedLimit: 1.2 }, ...buildAisleEntrySuffix("west", westX, southY)],
            [{ x: fx, y: pullY, skipTol: 0.45 }, { x: eastX, y: southY, skipTol: 0.45, speedLimit: 1.2 }, ...buildAisleEntrySuffix("east", eastX, southY)],
          );
        } else if (isZoneCStandTarget) {
          cands.push([{ x: fx, y: pullY, skipTol: 0.45 }, { x: eastX, y: southY, skipTol: 0.35, speedLimit: 1.2 }, ...eastTargetSeq]);
        } else if (isZoneAPadApproachTarget) {
          cands.push(
            [{ x: fx, y: pullY, skipTol: 0.45 }, { x: westX, y: southY, skipTol: 0.45, speedLimit: 1.2 }, ...westTargetSeq],
            [{ x: fx, y: pullY, skipTol: 0.45 }, { x: eastX, y: southY, skipTol: 0.45, speedLimit: 1.2 }, ...eastTargetSeq],
          );
        } else if (!isZoneDStandTarget) {
          cands.push(
            [{ x: fx, y: pullY, skipTol: 0.45 }, { x: westX, y: southY, skipTol: 0.45, speedLimit: 1.2 }, { x: westX, y: ty }],
            [{ x: fx, y: pullY, skipTol: 0.45 }, { x: eastX, y: southY, skipTol: 0.45, speedLimit: 1.2 }, { x: eastX, y: ty }],
          );
        }
      }
      if (fy > northY + 4.0 && enteringAisleFromOutside) {
        cands.push(
          [{ x: fx, y: fy - 4.0 }, { x: westX, y: northY }, ...buildAisleEntrySuffix("west", westX, northY)],
          [{ x: fx, y: fy - 4.0 }, { x: eastX, y: northY }, ...buildAisleEntrySuffix("east", eastX, northY)],
        );
      }
      for (let i = 0; i < obstacles.length; i++) {
        const b = obstacles[i];
        if (!segmentIntersectsObstacle2D(fx, fy, tx, ty, b, pad) && b.kind !== "container") continue;
        if (
          (enteringAisleFromOutside || isZoneDStandTarget || isZoneCStandTarget || isZoneDTarget || isZoneAPadApproachTarget) &&
          (b.kind === "rack" ||
            (isZoneDTarget && (fy >= oy - 23.5 || ty > oy - 36.5 || isSouthOfChargers) && b.kind === "charger") ||
            (isZoneAPadApproachTarget && fy < oy - 23.5 && b.kind === "stand"))
        ) {
          continue;
        }
        if (isSouthOfChargersStart) {
          continue;
        }
        if (
          b.kind === "rack" &&
          hasRackBounds &&
          Math.min(fx, tx) >= rackMaxX - 1.0 &&
          Math.max(fx, tx) <= rackMaxX + 2.5 &&
          Math.abs(ty - fy) > 1.5
        ) {
          continue;
        }
        const m = b.kind === "container"
          ? (Number.isFinite(opts.containerCornerPad) ? opts.containerCornerPad : (enteringAisleFromOutside ? 1.6 : 2.05))
          : b.kind === "stand"
            ? 2.05
            : (!enteringAisleFromOutside && (b.kind === "rack" || b.kind === "charger"))
              ? 2.5
              : 1.6;
        const cornerSpeedOpts = (!enteringAisleFromOutside && (b.kind === "rack" || b.kind === "charger"))
          ? { skipTol: 0.35, speedLimit: 1.35, _turnThrottle: true }
          : {};
        const cornerW = (lx, ly) => {
          if (b.obb) {
            const [wx, wy] = localToWorld2D(lx, ly, b.obb.cx, b.obb.cy, b.obb.heading);
            return { x: wx, y: wy, ...cornerSpeedOpts };
          }
          return { x: lx, y: ly, ...cornerSpeedOpts };
        };
        const minLx = b.obb ? -b.obb.halfW - m : b.x0 - m;
        const maxLx = b.obb ? b.obb.halfW + m : b.x1 + m;
        const minLy = b.obb ? -b.obb.halfL - m : b.y0 - m;
        const maxLy = b.obb ? b.obb.halfL + m : b.y1 + m;
        const cNW = cornerW(minLx, maxLy);
        const cNE = cornerW(maxLx, maxLy);
        const cSW = cornerW(minLx, minLy);
        const cSE = cornerW(maxLx, minLy);
        const allowMidCorner =
          b.obb ||
          ((fy >= (b.y0 ?? 0) - 4.0 && fy <= (b.y1 ?? 0) + 4.0) &&
            !(hasRackBounds && minLx >= rackMinX - 3.5 && maxLx <= rackMaxX + 3.5 && fy >= rackMinY - 2.0 && fy <= rackMaxY + 3.2));
        const cWmid = b.obb ? cornerW(minLx, 0) : { x: minLx, y: fy, skipTol: 0.45, speedLimit: 1.35, _turnThrottle: true };
        const cEmid = b.obb ? cornerW(maxLx, 0) : { x: maxLx, y: fy, skipTol: 0.45, speedLimit: 1.35, _turnThrottle: true };
        const cNWwide = cornerW(minLx - 0.6, maxLy - 1.6);
        const cNEwide = cornerW(maxLx + 0.6, maxLy - 1.6);
        if (enteringAisleFromOutside) {
          const cSWs = { ...cSW, skipTol: 0.90 };
          const cSEs = { ...cSE, skipTol: 0.90 };
          const cNWs = { ...cNW, skipTol: 0.90 };
          const cNEs = { ...cNE, skipTol: 0.90 };
          cands.push(
            [cSWs, cNWs, ...buildAisleEntrySuffix("west", cNW.x, cNW.y)],
            [cSEs, cNEs, ...buildAisleEntrySuffix("west", cNE.x, cNE.y)],
            [cSWs, cNWs, ...buildAisleEntrySuffix("east", cNW.x, cNW.y)],
            [cSEs, cNEs, ...buildAisleEntrySuffix("east", cNE.x, cNE.y)],
            [cSWs, cNWs, { x: westX, y: northY, skipTol: 0.45 }, ...buildAisleEntrySuffix("west", westX, northY)],
            [cSEs, cNEs, { x: westX, y: northY, skipTol: 0.45 }, ...buildAisleEntrySuffix("west", westX, northY)],
            [cSWs, cNWs, { x: eastX, y: northY, skipTol: 0.45 }, ...buildAisleEntrySuffix("east", eastX, northY)],
            [cSEs, cNEs, { x: eastX, y: northY, skipTol: 0.45 }, ...buildAisleEntrySuffix("east", eastX, northY)],
            [cNWs, cSWs, ...buildAisleEntrySuffix("west", cSW.x, cSW.y)],
            [cNEs, cSEs, ...buildAisleEntrySuffix("east", cSE.x, cSE.y)],
            [cNWs, cSWs, ...buildAisleEntrySuffix("east", cSW.x, cSW.y)],
            [cNEs, cSEs, ...buildAisleEntrySuffix("west", cSE.x, cSE.y)],
            [{ ...cSW, skipTol: 1.05 }, ...buildAisleEntrySuffix("west", cSW.x, cSW.y)],
            [{ ...cSE, skipTol: 1.05 }, ...buildAisleEntrySuffix("east", cSE.x, cSE.y)],
            [{ ...cSW, skipTol: 1.05 }, ...buildAisleEntrySuffix("east", cSW.x, cSW.y)],
            [{ ...cSE, skipTol: 1.05 }, ...buildAisleEntrySuffix("west", cSE.x, cSE.y)],
            [cNWs, ...buildAisleEntrySuffix("west", cNW.x, cNW.y)],
            [cNEs, ...buildAisleEntrySuffix("east", cNE.x, cNE.y)],
            [cNWs, ...buildAisleEntrySuffix("east", cNW.x, cNW.y)],
            [cNEs, ...buildAisleEntrySuffix("west", cNE.x, cNE.y)],
          );
          if (b.kind === "container") {
            const cSWwide = cornerW(minLx - 0.6, minLy + 1.6);
            const cSEwide = cornerW(maxLx + 0.6, minLy + 1.6);
            const cSWout = { ...cornerW(minLx - 0.5, minLy + 1.5), skipTol: 0.90 };
            const cSEout = { ...cornerW(maxLx + 0.5, minLy + 1.5), skipTol: 0.90 };
            cands.push(
              [cNWwide, cSW, { x: westX, y: northY }, ...buildAisleEntrySuffix("west", westX, northY)],
              [cNEwide, cSE, { x: eastX, y: northY }, ...buildAisleEntrySuffix("east", eastX, northY)],
              [cSEwide, cNE, ...buildAisleEntrySuffix("west", cNE.x, cNE.y)],
              [cSWwide, cNW, ...buildAisleEntrySuffix("west", cNW.x, cNW.y)],
              [cSEout, ...buildAisleEntrySuffix("west", cSEout.x, cSEout.y)],
              [cSWout, ...buildAisleEntrySuffix("east", cSWout.x, cSWout.y)],
              [cSEout, cNE, ...buildAisleEntrySuffix("west", cNE.x, cNE.y)],
              [cSWout, cNW, ...buildAisleEntrySuffix("east", cNW.x, cNW.y)],
            );
          }
          continue;
        }
        const padEnd = isZoneAPadApproachTarget ? [zoneAPadPre] : [];
        cands.push(
          [cNW, ...padEnd],
          [cNE, ...padEnd],
          [cSW, ...padEnd],
          [cSE, ...padEnd],
          [cNW, cSW, ...padEnd],
          [cNE, cSE, ...padEnd],
          [cSW, cNW, ...padEnd],
          [cSE, cNE, ...padEnd],
          ...(allowMidCorner ? [
            [cWmid, cSW, ...padEnd],
            [cEmid, cSE, ...padEnd],
            [cWmid, cNW, ...padEnd],
            [cEmid, cNE, ...padEnd],
          ] : []),
          [cSW, cNW, { x: westX, y: northY }, ...westTargetSeq],
          [cSE, cNE, { x: westX, y: northY }, ...westTargetSeq],
          [cSW, cNW, { x: eastX, y: northY }, ...eastTargetSeq],
          [cSE, cNE, { x: eastX, y: northY }, ...eastTargetSeq],
          [{ x: westX, y: fy }, cSW, ...padEnd],
          [{ x: westX, y: fy }, cSE, ...padEnd],
          [{ x: eastX, y: fy }, cSW, ...padEnd],
          [{ x: eastX, y: fy }, cSE, ...padEnd],
          ...(b.kind !== "rack" ? [
            [{ x: westX, y: northY }, cSW, ...padEnd],
            [{ x: westX, y: northY }, cSE, ...padEnd],
            [{ x: westX, y: northY }, cNW, ...padEnd],
            [{ x: westX, y: northY }, cNE, ...padEnd],
            [{ x: eastX, y: northY }, cSW, ...padEnd],
            [{ x: eastX, y: northY }, cSE, ...padEnd],
            [{ x: eastX, y: northY }, cNW, ...padEnd],
            [{ x: eastX, y: northY }, cNE, ...padEnd],
          ] : []),
          [cNW, cSW, ...westTargetSeq],
          [cNE, cSE, ...westTargetSeq],
          [cSW, cNW, ...westTargetSeq],
          [cSE, cNE, ...westTargetSeq],
          [cNW, cSW, ...eastTargetSeq],
          [cNE, cSE, ...eastTargetSeq],
          [cSW, cNW, ...eastTargetSeq],
          [cSE, cNE, ...eastTargetSeq],
          [{ x: westX, y: fy }, cSW, cNW, ...padEnd],
          [{ x: westX, y: fy }, cSE, cNE, ...padEnd],
          [{ x: eastX, y: fy }, cSW, cNW, ...padEnd],
          [{ x: eastX, y: fy }, cSE, cNE, ...padEnd],
        );
        if (b.kind === "container") {
          cands.push(
            [cNWwide, cSW, { x: westX, y: northY }, ...westTargetSeq],
            [cNEwide, cSE, { x: eastX, y: northY }, ...eastTargetSeq],
            [cNW, cSW, { x: westX, y: northY }, ...westTargetSeq],
            [cNE, cSE, { x: eastX, y: northY }, ...eastTargetSeq],
            [{ x: westX, y: northY }, cNE, cSE, ...padEnd],
            [{ x: westX, y: northY }, cNW, cSW, ...padEnd],
            [{ x: eastX, y: northY }, cNE, cSE, ...padEnd],
            [{ x: eastX, y: northY }, cNW, cSW, ...padEnd],
          );
          if (b.obb) {
            cands.push(
              [{ ...cSW, skipTol: 0.45, speedLimit: 1.25 }, { ...cSE, skipTol: 0.45, speedLimit: 1.25 }, ...padEnd],
              [{ ...cSE, skipTol: 0.45, speedLimit: 1.25 }, { ...cSW, skipTol: 0.45, speedLimit: 1.25 }, ...padEnd],
              [{ ...cNW, skipTol: 0.45, speedLimit: 1.25 }, { ...cNE, skipTol: 0.45, speedLimit: 1.25 }, ...padEnd],
              [{ ...cNE, skipTol: 0.45, speedLimit: 1.25 }, { ...cNW, skipTol: 0.45, speedLimit: 1.25 }, ...padEnd],
            );
            if (checkAgfDeparture && pointToObstacleDist(fx, fy, b) < 0.75) {
              const dEnd = b.obb.halfL + 1.8;
              const [fHxC, fHyC] = headingForward(opts.heading);
              const fwdEnd = { x: fx + fHxC * dEnd, y: fy + fHyC * dEnd, skipTol: 0.35, speedLimit: 1.15 };
              const revEnd = { x: fx - fHxC * dEnd, y: fy - fHyC * dEnd, reverse: true, skipTol: 0.35, speedLimit: 0.90 };
              const c1SW = { ...cSW, skipTol: 0.45, speedLimit: 1.25 };
              const c1SE = { ...cSE, skipTol: 0.45, speedLimit: 1.25 };
              const c1NW = { ...cNW, skipTol: 0.45, speedLimit: 1.25 };
              const c1NE = { ...cNE, skipTol: 0.45, speedLimit: 1.25 };
              const tails = fy < oy - 18.5
                ? [
                  padEnd,
                  [{ x: westX, y: zoneDBufY, skipTol: 0.45 }],
                  [{ x: eastBypassX, y: zoneDHwyY, skipTol: 0.45 }, { x: eastBypassX, y: zoneDBufY, skipTol: 0.45 }],
                  westTargetSeq,
                  eastTargetSeq,
                ]
                : [padEnd, westTargetSeq, eastTargetSeq];
              for (const endPt of [fwdEnd, revEnd]) {
                for (const cPt of [c1SW, c1SE, c1NW, c1NE]) {
                  for (const tl of tails) {
                    cands.push([endPt, cPt, ...tl]);
                  }
                }
                cands.push(
                  [endPt, c1SW, c1SE, ...padEnd],
                  [endPt, c1SE, c1SW, ...padEnd],
                  [endPt, c1NW, c1NE, ...padEnd],
                  [endPt, c1NE, c1NW, ...padEnd],
                );
              }
            }
          }
        }
      }
      for (const seq of cands) {
        const sc = scoreSeq(seq);
        if (sc < Infinity) rankedShortcuts.push({ seq, score: sc });
        if (sc < bestShortcutScore) {
          bestShortcutScore = sc;
          bestShortcut = seq;
        }
      }
      if (aisleAxisExitInfo) {
        const { aisleY, isEast, exitX, prefix, altPrefixes = [] } = aisleAxisExitInfo;
        const oppExitX = isEast ? westX : eastX;
        const allAxisPrefixes = [prefix, ...altPrefixes];
        const validAxisPrefixes = [];
        for (const ap of allAxisPrefixes) {
          const ptsAp = [{ x: fx, y: fy }, ...ap];
          if (aisleAxisExitInfo && !ap[0]?.reverse && !(ap[0]?._rackPivot && Math.abs(fy - aisleY) > 0.40 && startMinDist < 0.65)) {
            const ft = Math.abs(wrapPi(Math.atan2(ap[0].x - fx, ap[0].y - fy) - opts.heading));
            if (ft > 0.35 || (ap[0].x > rackMinX - 0.5 && ap[0].x < rackMaxX + 0.5 && Math.abs(ap[0].y - aisleY) > 0.40)) {
              continue;
            }
          }
          let segOk = true;
          for (let i = 0; i < ptsAp.length - 1; i++) {
            if (!checkSegClear(ptsAp[i].x, ptsAp[i].y, ptsAp[i + 1].x, ptsAp[i + 1].y, i === 0, false)) {
              segOk = false;
              break;
            }
          }
          if (!segOk) continue;
          if (needArcCheck && !arcClearFor(subdivideWaypoints(fx, fy, ap, 4.5).slice(0, useMultiWpArc ? 6 : 4), useMultiWpArc)) {
            continue;
          }
          let apLen = 0;
          for (let i = 0; i < ptsAp.length - 1; i++) apLen += Math.hypot(ptsAp[i + 1].x - ptsAp[i].x, ptsAp[i + 1].y - ptsAp[i].y);
          validAxisPrefixes.push({ ap, len: apLen, opp: ap.some((p) => Math.abs(p.x - oppExitX) < 0.5) });
        }
        const pickedAxis = validAxisPrefixes.map((itemAp) => itemAp.ap);
        const axisExtras = [];
        for (const ap of pickedAxis) {
          const exitedOpp = ap.some((p) => Math.abs(p.x - oppExitX) < 0.5);
          const sameSeq = isEast ? eastTargetSeq : westTargetSeq;
          const oppSeq = isEast ? westTargetSeq : eastTargetSeq;
          axisExtras.push(
            [...ap, ...sameSeq],
            ...(exitedOpp ? [[...ap, ...oppSeq]] : []),
            [...ap, { x: exitX, y: northY, skipTol: 0.45 }, ...sameSeq],
            [...ap, { x: exitX, y: southY, skipTol: 0.45 }, ...sameSeq],
            ...(isZoneDTarget ? [
              [...ap, { x: exitX, y: zoneDBufY, skipTol: 0.45 }, ...(isEast ? eastTargetSeq.slice(1) : westTargetSeq)],
              [...ap, { x: exitX, y: southY, skipTol: 0.45 }, ...oppSeq],
              [...ap, { x: exitX, y: northWestTurnY, skipTol: 0.45, speedLimit: 1.5 }, ...westTargetSeq],
            ] : []),
            ...(isZoneDTarget && ty >= oy - 24.6 && Math.abs(tx - ox) <= 18.0 ? [
              [...ap, { x: exitX, y: zoneDBufY, skipTol: 0.45 }, { x: tx, y: zoneDBufY, skipTol: 0.35 }],
              [...ap, { x: oppExitX, y: zoneDBufY, skipTol: 0.45 }, { x: tx, y: zoneDBufY, skipTol: 0.35 }],
            ] : []),
            ...(isZoneAPadApproachTarget ? [[...ap, { x: exitX, y: crossAisleY, skipTol: 0.45, speedLimit: 1.5 }, { x: tx, y: crossAisleY, skipTol: 0.45, speedLimit: 1.5 }]] : []),
            ...(enteringAisleFromOutside ? [
              [...ap, ...buildAisleEntrySuffix(isEast ? "east" : "west", exitX, aisleY)],
              ...(exitedOpp ? [[...ap, ...buildAisleEntrySuffix(isEast ? "west" : "east", oppExitX, aisleY)]] : []),
            ] : []),
          );
        }
        for (const ap of pickedAxis) {
          for (const seq of cands) {
            const comb = [...ap, ...seq];
            const sc = scoreSeq(comb);
            if (sc < Infinity) rankedShortcuts.push({ seq: comb, score: sc });
            if (sc < bestShortcutScore) {
              bestShortcutScore = sc;
              bestShortcut = comb;
            }
          }
        }
        for (const seq of axisExtras) {
          const sc = scoreSeq(seq);
          if (sc < Infinity) rankedShortcuts.push({ seq, score: sc });
          if (sc < bestShortcutScore) {
            bestShortcutScore = sc;
            bestShortcut = seq;
          }
        }
      }
      if (rackDepartInfo) {
        const { aisleY, westPrefix, eastPrefix, westAisleExit, eastAisleExit, obliquePrefixes } = buildRackDepartPrefixes();
        const westTail = enteringAisleFromOutside
          ? buildAisleEntrySuffix("west", westX, aisleY)
          : westTargetSeq;
        const eastTail = enteringAisleFromOutside
          ? buildAisleEntrySuffix("east", eastX, eastAisleExit[eastAisleExit.length - 1].y)
          : eastTargetSeq;
        const departExtra = isZoneAPadApproachTarget
          ? [
            [...westPrefix, ...westAisleExit, ...westTail],
            [...eastPrefix, ...eastAisleExit, ...eastTail],
          ]
          : [
            ...(tx <= fx + 1.0 ? [westPrefix, [...westPrefix, ...westAisleExit], [...westPrefix, ...westAisleExit, ...westTail]] : []),
            ...(tx >= fx - 1.0 ? [eastPrefix, [...eastPrefix, ...eastAisleExit], [...eastPrefix, ...eastAisleExit, ...eastTail]] : []),
            ...(tx >= ox + 13.4 && ty >= oy - 13.0 && ty <= oy + 7.5 && !isZoneCStandTarget ? [
              [...westPrefix, ...westAisleExit, { x: westX, y: southY, skipTol: 0.45 }, { x: eastBypassX, y: southY, skipTol: 0.45 }, ...(ty - 4.8 >= southY + 0.5 ? [{ x: eastBypassX, y: ty - 4.8, skipTol: 0.35, speedLimit: 1.25 }] : []), { x: eastBypassX, y: ty, skipTol: 0.45 }],
              [...westPrefix, ...westAisleExit, { x: westX, y: northY, skipTol: 0.45 }, { x: eastBypassX, y: northY, skipTol: 0.45 }, ...(ty + 4.8 <= northY - 0.5 ? [{ x: eastBypassX, y: ty + 4.8, skipTol: 0.35, speedLimit: 1.25 }] : []), { x: eastBypassX, y: ty, skipTol: 0.45 }],
            ] : []),
            [...westPrefix, ...westAisleExit, ...westTail],
            [...eastPrefix, ...eastAisleExit, ...eastTail],
          ];
        for (const ob of obliquePrefixes) {
          const sameSideExit = ob.side === "east" ? eastAisleExit : westAisleExit;
          const sameSideTail = ob.side === "east" ? eastTail : westTail;
          const oppSideTail = ob.side === "east" ? westTail : eastTail;
          departExtra.push(
            ob.pref,
            [...ob.pref, ...sameSideExit],
            [...ob.pref, ...sameSideExit, ...sameSideTail],
            [...ob.pref, ...ob.revOppExit],
            [...ob.pref, ...ob.revOppExit, ...oppSideTail],
            ...(tx >= ox + 13.4 && ty >= oy - 13.0 && ty <= oy + 7.5 && !isZoneCStandTarget ? [
              [...ob.pref, ...sameSideExit, { x: westX, y: southY, skipTol: 0.45 }, { x: eastBypassX, y: southY, skipTol: 0.45 }, ...(ty - 4.8 >= southY + 0.5 ? [{ x: eastBypassX, y: ty - 4.8, skipTol: 0.35, speedLimit: 1.25 }] : [{ x: eastBypassX, y: ty, skipTol: 0.45 }])],
              [...ob.pref, ...sameSideExit, { x: westX, y: northY, skipTol: 0.45 }, { x: eastBypassX, y: northY, skipTol: 0.45 }, ...(ty + 4.8 <= northY - 0.5 ? [{ x: eastBypassX, y: ty + 4.8, skipTol: 0.35, speedLimit: 1.25 }] : [{ x: eastBypassX, y: ty, skipTol: 0.45 }])],
              [...ob.pref, ...sameSideExit, { x: westX, y: southY, skipTol: 0.45 }, { x: eastBypassX, y: southY, skipTol: 0.45 }, { x: Math.max(tx + 1.4, ox + 17.5), y: southY, skipTol: 0.45 }, ...(ty - 4.8 >= southY + 0.5 ? [{ x: Math.max(tx + 1.4, ox + 17.5), y: ty - 4.8, skipTol: 0.35, speedLimit: 1.25 }] : [])],
              [...ob.pref, ...sameSideExit, { x: westX, y: northY, skipTol: 0.45 }, { x: eastBypassX, y: northY, skipTol: 0.45 }, { x: Math.max(tx + 1.4, ox + 17.5), y: northY, skipTol: 0.45 }, ...(ty + 4.8 <= northY - 0.5 ? [{ x: Math.max(tx + 1.4, ox + 17.5), y: ty + 4.8, skipTol: 0.35, speedLimit: 1.25 }] : [])],
            ] : []),
          );
        }
        for (const seq of departExtra) {
          const sc = scoreSeq(seq);
          if (sc < Infinity) rankedShortcuts.push({ seq, score: sc });
          if (sc < bestShortcutScore) {
            bestShortcutScore = sc;
            bestShortcut = seq;
          }
        }
        for (const seq of cands) {
          const firstPt = seq[0];
          const prefs = !firstPt
            ? [westPrefix, eastPrefix]
            : firstPt.x < fx - 0.5
              ? [westPrefix]
              : firstPt.x > fx + 0.5
                ? [eastPrefix]
                : [westPrefix, eastPrefix];
          for (const pref of prefs) {
            const comb = [...pref, ...seq];
            const sc = scoreSeq(comb);
            if (sc < Infinity) rankedShortcuts.push({ seq: comb, score: sc });
            if (sc < bestShortcutScore) {
              bestShortcutScore = sc;
              bestShortcut = comb;
            }
          }
          for (const ob of obliquePrefixes) {
            const sameSideExit = ob.side === "east" ? eastAisleExit : westAisleExit;
            const obCombs = (!firstPt || (ob.side === "east" ? firstPt.x >= fx - 0.5 : firstPt.x <= fx + 0.5))
              ? [[...ob.pref, ...sameSideExit, ...seq], [...ob.pref, ...ob.revOppExit, ...seq]]
              : [[...ob.pref, ...ob.revOppExit, ...seq], [...ob.pref, ...sameSideExit, ...seq]];
            for (const comb of obCombs) {
              const sc = scoreSeq(comb);
              if (sc < Infinity) rankedShortcuts.push({ seq: comb, score: sc });
              if (sc < bestShortcutScore) {
                bestShortcutScore = sc;
                bestShortcut = comb;
              }
            }
          }
        }
      }
      if (standDepartInfo) {
        const { fHx, fHy, dot = 1 } = standDepartInfo;
        const escCands = [];
        if (dot <= 0.70 || (isZoneDStandStart && fy > oy - 23.2)) {
          if (isZoneDStandStart && fHy > 0.35) {
            const fwdToBuf = (zoneDBufY - fy) / fHy;
            if (fwdToBuf >= 1.2 && fwdToBuf <= 5.5) {
              escCands.push({ x: fx + fHx * fwdToBuf, y: zoneDBufY, reverse: false, skipTol: 0.25, speedLimit: 0.85 });
            }
          }
          for (const fwdDist of [1.50, 1.85, 2.55, 3.20, 1.40, 0.90]) {
            escCands.push({ x: fx + fHx * fwdDist, y: fy + fHy * fwdDist, reverse: false, skipTol: 0.25, speedLimit: 0.85 });
          }
        }
        if (isZoneDStandStart) {
          const gapCenterX = clamp(ox - 18.0 + Math.round((fx - (ox - 18.0)) / 3.0) * 3.0, ox - 18.0, ox + 18.0);
          const northRev = fHy < -0.25;
          escCands.push(
            { x: gapCenterX, y: oy - 20.0, reverse: northRev, skipTol: 0.25, speedLimit: 0.85 },
            { x: gapCenterX, y: zoneDBufY, reverse: northRev, skipTol: 0.25, speedLimit: 0.85 },
            { x: fx, y: oy - 20.0, reverse: northRev, skipTol: 0.25, speedLimit: 0.85 },
            { x: fx, y: zoneDBufY, reverse: northRev, skipTol: 0.25, speedLimit: 0.85 },
            { x: gapCenterX, y: zoneDHwyY, reverse: fHy > 0.25, skipTol: 0.25, speedLimit: 0.85 },
            ...(fHy <= 0.05 ? [
              { x: fx, y: zoneDBufY, reverse: true, skipTol: 0.25, speedLimit: 0.8 },
              { x: fx, y: oy - 20.0, reverse: true, skipTol: 0.25, speedLimit: 0.8 },
            ] : []),
          );
        }
        for (const revDist of [2.80, 4.50, 5.00, 2.15, 1.65, 1.95, 2.45, 3.20, 4.00, 1.45, 0.95]) {
          escCands.push({ x: fx - fHx * revDist, y: fy - fHy * revDist, reverse: true, skipTol: 0.20, speedLimit: (!isZoneDStandStart && standDepartInfo.faceDist >= 0.90) ? 1.15 : 0.8 });
        }
        if (isZoneDStandStart && Math.abs(fHy) < 0.50) {
          for (const dAng of [-0.10, 0.10]) {
            const hRevN = opts.heading + Math.PI + dAng;
            if (Math.cos(hRevN) > 0.05) {
              escCands.push({
                x: fx + Math.sin(hRevN) * 1.85,
                y: fy + Math.cos(hRevN) * 1.85,
                reverse: true,
                skipTol: 0.25,
                speedLimit: 0.80,
                _standPivot: true,
              });
            }
          }
        }
        for (const ang of [-0.40, 0.40, -0.80, 0.80, -1.10, 1.10, -1.20, 1.20]) {
          for (const dPiv of (fy < oy - 24.5 ? [0.45, 0.85, 1.15, 1.85] : [0.45, 0.85, 1.15])) {
            const hPiv = opts.heading + ang;
            escCands.push({
              x: fx + Math.sin(hPiv) * dPiv,
              y: fy + Math.cos(hPiv) * dPiv,
              reverse: false,
              skipTol: 0.20,
              speedLimit: dPiv < 0.6 ? 0.55 : (dPiv > 1.5 ? 0.80 : 0.25),
              _standPivot: true,
            });
          }
        }
        for (const ang of [-0.40, 0.40, -0.85, 0.85, -1.15, 1.15]) {
          for (const dPiv of [0.55, 0.95, 1.35]) {
            const hPiv = opts.heading + Math.PI + ang;
            escCands.push({
              x: fx + Math.sin(hPiv) * dPiv,
              y: fy + Math.cos(hPiv) * dPiv,
              reverse: true,
              skipTol: 0.20,
              speedLimit: 0.45,
              _standPivot: true,
            });
          }
        }
        const recordStandSeq = (seq) => {
          const sc = scoreSeq(seq);
          if (sc < Infinity) rankedShortcuts.push({ seq, score: sc });
          if (sc < bestShortcutScore) {
            bestShortcutScore = sc;
            bestShortcut = seq;
          }
          return sc < Infinity;
        };
        let standPivotSuccesses = 0;
        let zoneDRevSuccesses = 0;
        for (const revPt of escCands) {
          if (revPt._standPivot && standPivotSuccesses >= 1 && bestShortcut) continue;
          if (!checkSegClear(fx, fy, revPt.x, revPt.y, true, false)) continue;
          let foundForRevPt = false;
          if (distDirect <= 3.5) {
            if (recordStandSeq([revPt])) foundForRevPt = true;
          }
          if (!isZoneDStandStart && distDirect <= 4.5 && Math.abs(revPt.y - fy) >= 1.8) {
            if (recordStandSeq([revPt, { x: tx, y: revPt.y, skipTol: 0.35 }])) foundForRevPt = true;
            const sideOutX = fx + (tx >= fx ? 2.0 : -2.0);
            if (recordStandSeq([revPt, { x: sideOutX, y: revPt.y, skipTol: 0.35 }])) foundForRevPt = true;
          }
          const bufPts = revPt._standPivot
            ? [
                ...(revPt.reverse && revPt.y > fy ? [[
                  { x: revPt.x, y: zoneDBufY, reverse: true, skipTol: 0.25, speedLimit: 0.80 },
                ]] : []),
                [
                  { x: revPt.x, y: zoneDBufY, skipTol: 0.45 },
                ],
                [
                  { x: revPt.x, y: revPt.y + 1.2, skipTol: 0.30, speedLimit: 0.65 },
                  { x: revPt.x, y: zoneDBufY, skipTol: 0.45 },
                ],
                [
                  {
                    x: revPt.x + Math.sign(revPt.x - fx || -1) * 1.4,
                    y: revPt.y + 0.45,
                    skipTol: 0.30,
                    speedLimit: 0.45,
                  },
                  {
                    x: revPt.x + Math.sign(revPt.x - fx || -1) * 1.4,
                    y: zoneDBufY,
                    skipTol: 0.45,
                  },
                ],
              ]
            : (Math.abs(revPt.x - fx) > 0.1
              ? [[{ x: revPt.x, y: zoneDBufY, skipTol: 0.45 }], [{ x: fx, y: zoneDBufY, skipTol: 0.45 }]]
              : [[{ x: fx, y: zoneDBufY, skipTol: 0.45 }]]);
          if (enteringAisleFromOutside) {
            const stepY = Math.abs(targetAisleY - fy) > 2.5 ? (targetAisleY > fy ? 2.2 : -2.2) : 0;
            const standAisleSeqs = isZoneDStandStart
              ? bufPts.flatMap((startBuf) => [
                [revPt, ...startBuf, ...buildAisleEntrySuffix("east", startBuf[startBuf.length - 1].x, zoneDBufY)],
                [revPt, ...startBuf, ...buildAisleEntrySuffix("west", startBuf[startBuf.length - 1].x, zoneDBufY)],
                [revPt, ...startBuf, { x: eastX, y: zoneDBufY, skipTol: 0.45 }, ...buildAisleEntrySuffix("east", eastX, zoneDBufY)],
                [revPt, ...startBuf, { x: westX, y: zoneDBufY, skipTol: 0.45 }, ...buildAisleEntrySuffix("west", westX, zoneDBufY)],
              ])
              : [
                ...(stepY !== 0 ? [
                  [revPt, { x: eastX, y: revPt.y + stepY, skipTol: 0.45, speedLimit: 0.85 }, ...buildAisleEntrySuffix("east", eastX, revPt.y + stepY)],
                  [revPt, { x: westX, y: revPt.y + stepY, skipTol: 0.45, speedLimit: 0.85 }, ...buildAisleEntrySuffix("west", westX, revPt.y + stepY)],
                ] : []),
                [revPt, ...buildAisleEntrySuffix("east", revPt.x, revPt.y)],
                [revPt, ...buildAisleEntrySuffix("west", revPt.x, revPt.y)],
                [revPt, { x: eastX, y: revPt.y, skipTol: 0.45 }, ...buildAisleEntrySuffix("east", eastX, revPt.y)],
                [revPt, { x: westX, y: revPt.y, skipTol: 0.45 }, ...buildAisleEntrySuffix("west", westX, revPt.y)],
              ];
            for (const seq of standAisleSeqs) {
              if (recordStandSeq(seq)) foundForRevPt = true;
            }
          } else if (isZoneDStandTarget) {
            const stepY = Math.abs(ty - fy) > 2.5 ? (ty > fy ? 1.8 : -1.8) : 0;
            const zSpineSeqs = [
              ...(isZoneDStandStart
                ? bufPts.map((startBuf) => [revPt, ...startBuf, zoneDBufTarget])
                : []),
              ...(stepY !== 0 && !isZoneDStandStart ? [
                [revPt, { x: eastX, y: revPt.y + stepY, skipTol: 0.45, speedLimit: 1.2 }, ...eastTargetSeq],
                [revPt, { x: westX, y: revPt.y + stepY, skipTol: 0.45, speedLimit: 1.2 }, ...westTargetSeq],
              ] : []),
              [revPt, ...eastTargetSeq],
              [revPt, ...westTargetSeq],
            ];
            for (const spinePt of zSpineSeqs) {
              if (recordStandSeq(spinePt)) foundForRevPt = true;
            }
          } else if (isZoneDStandStart) {
            const zoneANorthY = (ty > oy + 38.0 && needCloseTargetAlign && closeTargetObs?.kind === "container" && ty > closeTargetObs.y1)
              ? Math.max(oy + 40.5, ty + 1.95)
              : oy + 40.5;
            let bufHitForRevPt = false;
            for (const startBuf of bufPts) {
              let thisBufHit = false;
              for (const spinePt of [
                [revPt, ...startBuf, { x: tx, y: zoneDBufY, skipTol: 0.45 }],
                [revPt, ...startBuf, { x: eastX, y: zoneDBufY, skipTol: 0.45 }, { x: eastX, y: ty, skipTol: 0.45 }],
                [revPt, ...startBuf, { x: westX, y: zoneDBufY, skipTol: 0.45 }, { x: westX, y: ty, skipTol: 0.45 }],
                ...(ty > oy + 38.0 && !(needCloseTargetAlign && closeTargetObs?.kind === "container" && ty <= closeTargetObs.y1) ? [
                  ...(Math.abs(tx - westX) <= 4.5 ? [[revPt, ...startBuf, { x: westX, y: zoneDBufY, skipTol: 0.45 }, { x: westX, y: zoneANorthY, skipTol: 0.45 }]] : []),
                  [revPt, ...startBuf, { x: westX, y: zoneDBufY, skipTol: 0.45 }, { x: westX, y: zoneANorthY, skipTol: 0.45 }, { x: tx, y: zoneANorthY, skipTol: 0.45 }],
                  [revPt, ...startBuf, { x: eastBypassX, y: zoneDBufY, skipTol: 0.45 }, { x: eastBypassX, y: zoneANorthY, skipTol: 0.45 }, { x: tx, y: zoneANorthY, skipTol: 0.45 }],
                  [revPt, ...startBuf, { x: eastX, y: zoneDBufY, skipTol: 0.45 }, { x: eastX, y: zoneANorthY, skipTol: 0.45 }, { x: tx, y: zoneANorthY, skipTol: 0.45 }],
                ] : []),
                ...(ty >= northY - 3.5 && ty <= northY ? [
                  [revPt, ...startBuf, { x: eastX, y: zoneDBufY, skipTol: 0.45 }, { x: eastX, y: northY, skipTol: 0.45 }, ...(tx < eastX - 6.0 ? [{ x: Math.min(eastX - 2.0, tx + 6.5), y: northY, skipTol: 0.35, speedLimit: 1.0 }] : [])],
                  [revPt, ...startBuf, { x: westX, y: zoneDBufY, skipTol: 0.45 }, { x: westX, y: northY, skipTol: 0.45 }, ...(tx > westX + 6.0 ? [{ x: Math.max(westX + 2.0, tx - 6.5), y: northY, skipTol: 0.35, speedLimit: 1.0 }] : [])],
                ] : []),
                ...(ty >= southY && ty <= southY + 3.5 ? [
                  [revPt, ...startBuf, { x: eastX, y: zoneDBufY, skipTol: 0.45 }, { x: eastX, y: southY, skipTol: 0.45 }, ...(tx < eastX - 6.0 ? [{ x: Math.min(eastX - 2.0, tx + 6.5), y: southY, skipTol: 0.35, speedLimit: 1.0 }] : [])],
                  [revPt, ...startBuf, { x: westX, y: zoneDBufY, skipTol: 0.45 }, { x: westX, y: southY, skipTol: 0.45 }, ...(tx > westX + 6.0 ? [{ x: Math.max(westX + 2.0, tx - 6.5), y: southY, skipTol: 0.35, speedLimit: 1.0 }] : [])],
                ] : []),
                [revPt, ...startBuf, { x: eastBypassX, y: zoneDBufY, skipTol: 0.45 }, { x: eastBypassX, y: ty, skipTol: 0.45 }],
                ...(tx >= ox + 13.4 && ty >= oy - 13.0 && ty <= oy + 7.5 && !isZoneCStandTarget ? [
                  [revPt, ...startBuf, { x: Math.max(tx + 1.4, ox + 17.5), y: zoneDBufY, skipTol: 0.45 }, ...(ty - 4.8 >= southY + 0.5 ? [{ x: Math.max(tx + 1.4, ox + 17.5), y: ty - 4.8, skipTol: 0.35, speedLimit: 1.25 }] : []), { x: Math.max(tx + 1.4, ox + 17.5), y: ty, skipTol: 0.45 }],
                ] : []),
                ...(hasRackBounds && tx > rackMaxX && tx < eastX && ty > southY && ty < northY ? [
                  [revPt, ...startBuf, ...westTargetSeq],
                  [revPt, ...startBuf, ...eastTargetSeq],
                ] : []),
                ...(ty < oy - 23.5 ? [
                  ...(isSouthOfChargers ? [
                    [revPt, ...startBuf, { x: westX, y: zoneDBufY, skipTol: 0.45 }, ...westZoneDTail],
                    [revPt, ...startBuf, ...eastZoneDTail],
                  ] : [
                    [revPt, ...startBuf, ...westZoneDTail],
                    [revPt, ...startBuf, ...eastZoneDTail],
                    [revPt, ...startBuf, { x: westX, y: zoneDBufY, skipTol: 0.45 }, { x: westX, y: zoneDHwyY, skipTol: 0.45 }, { x: tx, y: zoneDHwyY, skipTol: 0.45 }],
                    [revPt, ...startBuf, { x: eastBypassX, y: zoneDBufY, skipTol: 0.45 }, { x: eastBypassX, y: zoneDHwyY, skipTol: 0.45 }, { x: tx, y: zoneDHwyY, skipTol: 0.45 }],
                  ]),
                ] : []),
              ]) {
                if (recordStandSeq(spinePt)) {
                  thisBufHit = true;
                  bufHitForRevPt = true;
                  foundForRevPt = true;
                }
              }
              if (thisBufHit && bufHitForRevPt) break;
            }
            if (revPt.y < fy - 0.15) {
              const southEscPts = [
                [revPt, { x: revPt.x, y: zoneDHwyY, skipTol: 0.45 }, { x: eastBypassX, y: zoneDHwyY, skipTol: 0.45 }, { x: eastBypassX, y: ty, skipTol: 0.45 }],
                [revPt, { x: revPt.x, y: zoneDHwyY, skipTol: 0.45 }, { x: westX, y: zoneDHwyY, skipTol: 0.45 }, { x: westX, y: ty, skipTol: 0.45 }],
                [revPt, { x: revPt.x, y: zoneDHwyY, skipTol: 0.45 }, { x: eastBypassX, y: zoneDHwyY, skipTol: 0.45 }, { x: eastBypassX, y: zoneDBufY, skipTol: 0.45 }, { x: eastX, y: zoneDBufY, skipTol: 0.45 }, ...eastTargetSeq],
                [revPt, { x: revPt.x, y: zoneDHwyY, skipTol: 0.45 }, { x: westX, y: zoneDHwyY, skipTol: 0.45 }, { x: westX, y: zoneDBufY, skipTol: 0.45 }, ...westTargetSeq],
                ...(tx >= ox + 13.4 && ty >= oy - 13.0 && ty <= oy + 7.5 && !isZoneCStandTarget ? [
                  [revPt, { x: revPt.x, y: zoneDHwyY, skipTol: 0.45 }, { x: eastBypassX, y: zoneDHwyY, skipTol: 0.45 }, { x: eastBypassX, y: ty, skipTol: 0.45 }],
                  [revPt, { x: revPt.x, y: zoneDHwyY, skipTol: 0.45 }, { x: eastBypassX, y: zoneDHwyY, skipTol: 0.45 }, { x: Math.max(tx + 1.4, ox + 17.5), y: zoneDHwyY, skipTol: 0.45 }, { x: Math.max(tx + 1.4, ox + 17.5), y: ty, skipTol: 0.45 }],
                ] : []),
              ];
              for (const sSeq of southEscPts) {
                if (recordStandSeq(sSeq)) foundForRevPt = true;
              }
            }
          } else if (isZoneAPadApproachTarget) {
            const stepY = Math.abs(crossAisleY - fy) > 2.5 ? (crossAisleY > fy ? 1.8 : -1.8) : 0;
            for (const spinePt of [
              ...(stepY !== 0 ? [
                [revPt, { x: eastX, y: revPt.y + stepY, skipTol: 0.45, speedLimit: 1.2 }, ...eastTargetSeq],
                [revPt, { x: westX, y: revPt.y + stepY, skipTol: 0.45, speedLimit: 1.2 }, ...westTargetSeq],
              ] : []),
              [revPt, ...eastTargetSeq],
              [revPt, ...westTargetSeq],
            ]) {
              if (recordStandSeq(spinePt)) foundForRevPt = true;
            }
          } else if (isZoneCStandTarget) {
            const stepY = Math.abs(ty - fy) > 2.5 ? (ty > fy ? 1.8 : -1.8) : 0;
            for (const spinePt of [
              ...(stepY !== 0 ? [
                [revPt, { x: eastX, y: revPt.y + stepY, skipTol: 0.35, speedLimit: 1.2 }, ...eastTargetSeq],
              ] : []),
              [revPt, ...eastTargetSeq],
              [revPt, ...westTargetSeq],
            ]) {
              if (recordStandSeq(spinePt)) foundForRevPt = true;
            }
          } else if (isZoneDTarget) {
            const stepY = Math.abs(zoneDBufY - fy) > 2.5 ? (zoneDBufY > fy ? 1.8 : -1.8) : 0;
            for (const spinePt of [
              ...(fx > ox + 14.2 ? [
                [revPt, { x: eastBypassX, y: revPt.y, skipTol: 0.45 }, ...eastTargetSeq.slice(1)],
                [revPt, { x: eastBypassX, y: zoneDHwyY, skipTol: 0.45 }, { x: tx, y: zoneDHwyY, skipTol: 0.45 }],
              ] : []),
              ...(stepY !== 0 ? [
                [revPt, { x: eastX, y: revPt.y + stepY, skipTol: 0.45, speedLimit: 1.2 }, ...eastTargetSeq],
                [revPt, { x: westX, y: revPt.y + stepY, skipTol: 0.45, speedLimit: 1.2 }, ...westTargetSeq],
              ] : []),
              [revPt, ...eastTargetSeq],
              [revPt, ...westTargetSeq],
              [revPt, { x: eastX, y: southY, skipTol: 0.45 }, { x: westX, y: southY, skipTol: 0.45 }, ...westTargetSeq],
              [revPt, { x: eastX, y: northWestTurnY, skipTol: 0.45 }, { x: westX, y: northWestTurnY, skipTol: 0.45, speedLimit: 1.5 }, ...westTargetSeq],
            ]) {
              if (recordStandSeq(spinePt)) foundForRevPt = true;
            }
          } else {
            const stepY = Math.abs(ty - fy) > 2.5 ? (ty > fy ? 1.8 : -1.8) : 0;
            for (const spinePt of [
              ...(fy < oy - 24.5 ? [
                [revPt, { x: revPt.x, y: zoneDHwyY, skipTol: 0.45 }, { x: westX, y: zoneDHwyY, skipTol: 0.45 }, { x: westX, y: ty, skipTol: 0.45 }],
                [revPt, { x: revPt.x, y: zoneDHwyY, skipTol: 0.45 }, { x: eastBypassX, y: zoneDHwyY, skipTol: 0.45 }, { x: eastBypassX, y: ty, skipTol: 0.45 }],
                [revPt, { x: westX, y: zoneDHwyY, skipTol: 0.45 }, { x: westX, y: ty, skipTol: 0.45 }],
                [revPt, { x: eastBypassX, y: zoneDHwyY, skipTol: 0.45 }, { x: eastBypassX, y: ty, skipTol: 0.45 }],
                ...(tx >= ox + 13.4 && ty >= oy - 13.0 && ty <= oy + 7.5 && !isZoneCStandTarget ? [
                  [revPt, { x: revPt.x, y: zoneDHwyY, skipTol: 0.45 }, { x: eastBypassX, y: zoneDHwyY, skipTol: 0.45 }, { x: Math.max(tx + 1.4, ox + 17.5), y: zoneDHwyY, skipTol: 0.45 }, { x: Math.max(tx + 1.4, ox + 17.5), y: ty, skipTol: 0.45 }],
                ] : []),
              ] : []),
              ...(fHy < -0.25 && fx > ox + 8.0 ? [
                [revPt, { x: eastX, y: zoneDBufY, skipTol: 0.45 }, { x: eastBypassX, y: zoneDBufY, skipTol: 0.45 }, { x: eastBypassX, y: ty, skipTol: 0.45 }],
                [revPt, { x: eastX, y: southY, skipTol: 0.45 }, { x: westX, y: southY, skipTol: 0.45 }, { x: westX, y: ty, skipTol: 0.45 }],
              ] : []),
              ...(ty > oy + 24.0 ? [
                [revPt, { x: eastX, y: revPt.y, skipTol: 0.45 }, { x: eastX, y: crossAisleY, skipTol: 0.45 }, { x: tx, y: crossAisleY, skipTol: 0.45 }],
                [revPt, { x: eastX, y: revPt.y, skipTol: 0.45 }, { x: eastX, y: crossAisleY, skipTol: 0.45 }, { x: eastBypassX, y: crossAisleY, skipTol: 0.45 }, { x: eastBypassX, y: oy + 40.5, skipTol: 0.45 }, { x: tx, y: oy + 40.5, skipTol: 0.45 }],
                [revPt, { x: eastX, y: crossAisleY, skipTol: 0.45 }, { x: tx, y: crossAisleY, skipTol: 0.45 }],
                [revPt, { x: eastX, y: crossAisleY, skipTol: 0.45 }, { x: eastBypassX, y: crossAisleY, skipTol: 0.45 }, { x: eastBypassX, y: oy + 40.5, skipTol: 0.45 }, { x: tx, y: oy + 40.5, skipTol: 0.45 }],
                [revPt, { x: eastX, y: northY, skipTol: 0.45 }, { x: westX, y: northY, skipTol: 0.45 }, { x: westX, y: crossAisleY, skipTol: 0.45 }, { x: tx, y: crossAisleY, skipTol: 0.45 }],
              ] : []),
              ...(stepY !== 0 ? [
                [revPt, { x: eastX, y: revPt.y + stepY, skipTol: 0.45, speedLimit: 1.2 }, { x: eastX, y: ty, skipTol: 0.45 }],
                [revPt, { x: westX, y: revPt.y + stepY, skipTol: 0.45, speedLimit: 1.2 }, { x: westX, y: ty, skipTol: 0.45 }],
              ] : []),
              ...(tx >= ox + 13.4 && ty >= oy - 13.0 && ty <= oy + 7.5 && !isZoneCStandTarget ? (() => {
                const eastApronEx = Math.max(tx + 1.4, ox + 17.5);
                const eastApronSeqs = [];
                for (const ex of [eastBypassX, eastApronEx]) {
                  if (ty - 4.8 >= southY + 0.5) {
                    eastApronSeqs.push(
                      [revPt, { x: ex, y: revPt.y, skipTol: 0.45 }, { x: ex, y: ty - 4.8, skipTol: 0.35, speedLimit: 1.25 }],
                      [revPt, { x: ex, y: zoneDBufY, skipTol: 0.45 }, { x: ex, y: ty - 4.8, skipTol: 0.35, speedLimit: 1.25 }],
                    );
                  }
                  if (ty + 4.8 <= northY - 0.5) {
                    eastApronSeqs.push(
                      [revPt, { x: ex, y: revPt.y, skipTol: 0.45 }, { x: ex, y: ty + 4.8, skipTol: 0.35, speedLimit: 1.25 }],
                      [revPt, { x: ex, y: zoneDBufY, skipTol: 0.45 }, { x: ex, y: ty + 4.8, skipTol: 0.35, speedLimit: 1.25 }],
                    );
                  }
                  eastApronSeqs.push(
                    [revPt, { x: ex, y: revPt.y, skipTol: 0.45 }, { x: ex, y: ty, skipTol: 0.45 }],
                    [revPt, { x: ex, y: zoneDBufY, skipTol: 0.45 }, { x: ex, y: ty, skipTol: 0.45 }],
                  );
                }
                return eastApronSeqs;
              })() : []),
              [revPt, ...eastTargetSeq],
              [revPt, ...westTargetSeq],
              [revPt, { x: eastX, y: ty, skipTol: 0.45 }],
              [revPt, { x: westX, y: ty, skipTol: 0.45 }],
            ]) {
              if (recordStandSeq(spinePt)) foundForRevPt = true;
            }
          }
          if (!revPt._standPivot && !opts._noRescue && (!isZoneDStandStart || !foundForRevPt)) {
            for (const seq of cands) {
              if (recordStandSeq([revPt, ...seq])) foundForRevPt = true;
            }
          }
          if (foundForRevPt && revPt._standPivot) standPivotSuccesses++;
          if (foundForRevPt && isZoneDStandStart && !revPt._standPivot) zoneDRevSuccesses++;
          if (bestShortcut && (opts._noRescue || dot > 0.70 || (!revPt.reverse && !revPt._standPivot && rankedShortcuts.length >= 6) || (isZoneDStandStart && zoneDRevSuccesses >= 3 && rankedShortcuts.length >= 10))) break;
        }
      } else if (needArcCheck && !rackDepartInfo) {
        const [fHx, fHy] = headingForward(opts.heading);
        const isTightOuterRackFlank = hasRackBounds && startMinDist < 1.0 && fx >= rackMinX - 1.5 && fx <= rackMaxX + 1.5 && (fy > rackMaxY || fy < rackMinY);
        const revDists = isSouthOfChargersStart
          ? [1.8, 2.3, 2.8]
          : isTightOuterRackFlank
            ? [2.5, 3.2, 4.0, 4.8, 1.8, 1.2, 0.8]
            : (startMinDist < 0.72
              ? [2.2, 1.8, 2.5, 1.2, 3.2, 0.8]
              : (targetAisleY === null && directTurn > 1.5 && startMinDist < 2.8 && fx < rackMinX - 0.5 && Math.abs(tx - fx) < 2.0 ? [1.2, 1.8, 2.5, 3.2, 0.8] : [0.8, 1.2, 1.8, 2.5, 3.2]));
        for (const revDist of revDists) {
          const revPt = { x: fx - fHx * revDist, y: fy - fHy * revDist, reverse: true, skipTol: 0.35 };
          if (!checkSegClear(fx, fy, revPt.x, revPt.y, true, false)) continue;
          if (!(isSouthOfChargersStart && isSouthOfChargers && !isAlignedSouthCharger)) {
            const revDirect = scoreSeq([revPt]);
            if (revDirect < bestShortcutScore) {
              bestShortcutScore = revDirect;
              bestShortcut = [revPt];
            }
          }
          if (isSouthOfChargersStart && revPt.y <= oy - 41.5) {
            const safeSouthY = revPt.y;
            const wCorridor = [
              revPt,
              { x: westX, y: safeSouthY, skipTol: 0.35, speedLimit: 1.0 },
              { x: westX, y: zoneDHwyY, skipTol: 0.45 },
            ];
            const eCorridor = [
              revPt,
              { x: eastBypassX, y: safeSouthY, skipTol: 0.35, speedLimit: 1.0 },
              { x: eastBypassX, y: zoneDBufY, skipTol: 0.45 },
            ];
            const revCorridors = enteringAisleFromOutside
              ? [
                [...wCorridor, { x: westX, y: southY, skipTol: 0.45 }, ...buildAisleEntrySuffix("west", westX, southY)],
                [...eCorridor, { x: eastX, y: zoneDBufY, skipTol: 0.45 }, { x: eastX, y: southY, skipTol: 0.45 }, ...buildAisleEntrySuffix("east", eastX, southY)],
                [...eCorridor, { x: eastBypassX, y: zoneDHwyY, skipTol: 0.45 }, { x: westX, y: zoneDHwyY, skipTol: 0.45 }, { x: westX, y: southY, skipTol: 0.45 }, ...buildAisleEntrySuffix("west", westX, southY)],
              ]
              : isZoneAPadApproachTarget
                ? [
                  [...wCorridor, ...westTargetSeq],
                  [...wCorridor, { x: westX, y: northY, skipTol: 0.45 }, ...westTargetSeq],
                  [...eCorridor, { x: eastX, y: zoneDBufY, skipTol: 0.45 }, ...eastTargetSeq],
                  [...eCorridor, { x: eastBypassX, y: zoneDHwyY, skipTol: 0.45 }, { x: westX, y: zoneDHwyY, skipTol: 0.45 }, ...westTargetSeq],
                ]
                : isZoneDStandTarget
                  ? [
                    [...wCorridor, ...westTargetSeq],
                    [...eCorridor, zoneDBufTarget],
                  ]
                  : isZoneCStandTarget
                    ? [
                      [...wCorridor, { x: westX, y: southY, skipTol: 0.45 }, { x: eastX, y: southY, skipTol: 0.35, speedLimit: 1.35 }, ...eastTargetSeq],
                      [...wCorridor, ...westTargetSeq],
                      [...eCorridor, { x: eastX, y: zoneDBufY, skipTol: 0.45 }, ...eastTargetSeq],
                    ]
                  : isSouthOfChargers
                    ? [
                      [...wCorridor, ...westZoneDTail],
                      [...eCorridor, ...eastZoneDTail.slice(2)],
                      [...eCorridor, { x: eastBypassX, y: zoneDHwyY, skipTol: 0.45 }, { x: westX, y: zoneDHwyY, skipTol: 0.45 }, ...westZoneDTail],
                    ]
                    : [
                      ...(ty >= oy - 37.1 && ty <= oy - 36.75 && Math.abs(tx - ox) <= 18.0 ? [
                        [...wCorridor, ...westZoneDTail],
                        [...eCorridor, ...eastZoneDTail.slice(2)],
                        [...eCorridor, { x: eastBypassX, y: zoneDHwyY, skipTol: 0.45 }, ...westZoneDTail],
                      ] : []),
                      [...wCorridor, { x: westX, y: ty }],
                      [...wCorridor, { x: westX, y: northY }, { x: tx, y: northY }],
                      [...eCorridor, { x: eastX, y: zoneDBufY }, { x: eastX, y: ty }],
                      [...eCorridor, { x: eastBypassX, y: zoneDHwyY, skipTol: 0.45 }, { x: westX, y: zoneDHwyY, skipTol: 0.45 }, { x: westX, y: ty }],
                    ];
            for (const rc of revCorridors) {
              const sc = scoreSeq(rc);
              if (sc < Infinity) rankedShortcuts.push({ seq: rc, score: sc });
              if (sc < bestShortcutScore) {
                bestShortcutScore = sc;
                bestShortcut = rc;
              }
            }
          }
          if (!isSouthOfChargersStart) {
            for (const seq of cands) {
              const sc = scoreSeq([revPt, ...seq]);
              if (sc < Infinity) rankedShortcuts.push({ seq: [revPt, ...seq], score: sc });
              if (sc < bestShortcutScore) {
                bestShortcutScore = sc;
                bestShortcut = [revPt, ...seq];
              }
            }
          }
          if (bestShortcut && rankedShortcuts.length >= 6 && (startMinDist >= 0.72 || revDist >= 2.4)) break;
        }
        if (Array.isArray(opts.extraObstacles) && opts.extraObstacles.length > 0) {
          for (const fwdDist of [1.2, 1.8, 2.5]) {
            const fwdPt = { x: fx + fHx * fwdDist, y: fy + fHy * fwdDist, skipTol: 0.35 };
            if (!checkSegClear(fx, fy, fwdPt.x, fwdPt.y, true, false)) continue;
            const fwdSc = scoreSeq([fwdPt]);
            if (fwdSc < Infinity) rankedShortcuts.push({ seq: [fwdPt], score: fwdSc });
            if (fwdSc < bestShortcutScore) {
              bestShortcutScore = fwdSc;
              bestShortcut = [fwdPt];
            }
          }
        }
      }
    }

    if (!layout?.graph?.nodes?.length) {
      return [{ x: tx, y: ty }];
    }

    const modeNodes = new Map();
    const adj = new Map();
    for (const n of layout.graph.nodes) {
      if (Array.isArray(n.allowedModes) && n.allowedModes.includes(mode)) {
        modeNodes.set(n.id, n);
        adj.set(n.id, []);
      }
    }
    for (const e of layout.graph.edges) {
      if (!Array.isArray(e.allowedModes) || !e.allowedModes.includes(mode)) continue;
      if (!modeNodes.has(e.from) || !modeNodes.has(e.to)) continue;
      adj.get(e.from).push({ to: e.to, len: e.lengthM, laneWidthM: e.laneWidthM });
      adj.get(e.to).push({ to: e.from, len: e.lengthM, laneWidthM: e.laneWidthM });
    }

    let startId = null;
    let startBest = Infinity;
    let endId = null;
    let endBest = Infinity;
    const isZoneCStandStart =
      mode === "agf" &&
      opts.ignoreStandObstacles !== true &&
      stands.size >= 6 &&
      fx >= ox + 10.5 &&
      fx <= ox + 13.5 &&
      fy >= oy - 11.5 &&
      fy <= oy + 5.5;
    const skipAisleStart =
      mode === "agf" &&
      !enteringAisleFromOutside &&
      hasRackBounds &&
      (fx < rackMinX - 0.5 || fx > rackMaxX + 0.5);
    const skipAisleEnd =
      mode === "agf" &&
      !enteringAisleFromOutside &&
      hasRackBounds &&
      (tx < rackMinX - 0.5 || tx > rackMaxX + 0.5);
    for (const n of modeNodes.values()) {
      const ds = Math.hypot(n.x - fx, n.y - fy);
      const de = Math.hypot(n.x - tx, n.y - ty);
      const bandOkStart = checkZoneDBandSeg(fx, fy, n.x, n.y);
      const bandOkEnd = checkZoneDBandSeg(n.x, n.y, tx, ty);
      const clearStart = pathIsClear(fx, fy, n.x, n.y, obstacles, 0.55) && bandOkStart;
      const clearEnd = pathIsClear(n.x, n.y, tx, ty, obstacles, 0.55) && bandOkEnd;
      const skipAmrStart =
        mode === "amr" &&
        (n.kind === "charger" || (n.kind === "stand_amr" && ds > 0.55));
      const skipAmrEnd =
        mode === "amr" &&
        (n.kind === "charger" || (n.kind === "stand_amr" && de > 0.55));
      const skipStartStand =
        mode === "agf" &&
        n.kind === "stand_agf" &&
        ((n.zone === "zoneD" && !isZoneDStandStart) || (n.zone === "zoneC" && !isZoneCStandStart));
      const skipEndStand =
        mode === "agf" &&
        n.kind === "stand_agf" &&
        ((n.zone === "zoneD" && !isZoneDStandTarget) || (n.zone === "zoneC" && !isZoneCStandTarget));
      if (!skipAmrStart && !skipStartStand && !(skipAisleStart && n.kind === "aisle")) {
        const scoreStart = ds + (clearStart ? 0 : bandOkStart ? 80 : 500);
        if (scoreStart < startBest) {
          startBest = scoreStart;
          startId = n.id;
        }
      }
      if (!skipAmrEnd && !skipEndStand && !(skipAisleEnd && n.kind === "aisle")) {
        const scoreEnd = de + (clearEnd ? 0 : bandOkEnd ? 80 : 500);
        if (scoreEnd < endBest) {
          endBest = scoreEnd;
          endId = n.id;
        }
      }
    }

    if (!startId || !endId) return [{ x: tx, y: ty }];

    const dist = new Map();
    const prev = new Map();
    const unvisited = new Set(modeNodes.keys());
    for (const id of unvisited) dist.set(id, Infinity);
    dist.set(startId, 0);

    while (unvisited.size > 0) {
      let u = null;
      let uDist = Infinity;
      for (const id of unvisited) {
        const d = dist.get(id);
        if (d < uDist) {
          uDist = d;
          u = id;
        }
      }
      if (u === null || u === endId || !Number.isFinite(uDist)) break;
      unvisited.delete(u);

      const neighbors = adj.get(u) || [];
      for (let i = 0; i < neighbors.length; i++) {
        const nb = neighbors[i];
        if (!unvisited.has(nb.to)) continue;
        const alt = uDist + nb.len;
        if (alt < dist.get(nb.to)) {
          dist.set(nb.to, alt);
          prev.set(nb.to, u);
        }
      }
    }

    const nodePath = [];
    let cur = endId;
    while (cur) {
      nodePath.unshift(modeNodes.get(cur));
      if (cur === startId) break;
      cur = prev.get(cur);
    }
    if (nodePath.length === 0 || nodePath[0].id !== startId) {
      return [{ x: tx, y: ty }];
    }

    const eastGraphX = ox + 10.0;
    const isAisleEntryNode = (pt) =>
      enteringAisleFromOutside &&
      Math.abs(pt.y - targetAisleY) < 0.25 &&
      (Math.abs(pt.x - westX) < 0.25 || Math.abs(pt.x - eastX) < 0.25 || Math.abs(pt.x - eastGraphX) < 0.25);
    const isZoneDBufNode = (pt) =>
      ((isZoneDStandTarget && Math.abs(pt.x - tx) < 0.25) ||
        (isZoneDStandStart && Math.abs(pt.x - fx) < 0.25)) &&
      Math.abs(pt.y - zoneDBufY) < 0.25;
    const isZoneAPadCrossNode = (pt) =>
      isZoneAPadApproachTarget &&
      Math.abs(pt.x - tx) < 0.25 &&
      Math.abs(pt.y - crossAisleY) < 0.25;
    const isZoneDHwyNode = (pt) =>
      isZoneDTarget &&
      Math.abs(pt.x - westX) < 0.25 &&
      Math.abs(pt.y - zoneDHwyY) < 0.25;

    const isZoneCStandPreNode = (pt) =>
      isZoneCStandTarget &&
      Math.abs(pt.x - eastX) < 0.25 &&
      Math.abs(pt.y - ty) < 0.25;
    const closeAlignMemo = new Map();
    const applyCloseTargetAlign = (rawIn, alignOpts = null) => {
      const useSweep32 = Boolean(opts._candSweep32 || alignOpts?._candSweep32);
      const route = rawIn.map((w) => ({ ...w }));
      if (needCloseTargetAlign && closeTargetObs && route.length >= 1) {
        const prevIdxMemo = route.length - 2;
        const prevPtMemo = prevIdxMemo >= 0 ? route[prevIdxMemo] : { x: fx, y: fy };
        const prev2Memo = prevIdxMemo >= 1 ? route[prevIdxMemo - 1] : { x: fx, y: fy };
        const dPrev2Memo = Math.hypot(prevPtMemo.x - prev2Memo.x, prevPtMemo.y - prev2Memo.y);
        const tailHMemo = prevIdxMemo >= 0 && dPrev2Memo > 0.05
          ? Math.atan2(prevPtMemo.x - prev2Memo.x, prevPtMemo.y - prev2Memo.y)
          : (Number.isFinite(opts.heading) ? opts.heading : 0);
        const memoKey = `${prevIdxMemo >= 0 ? 1 : 0}|${prevPtMemo.x.toFixed(2)},${prevPtMemo.y.toFixed(2)}|${tailHMemo.toFixed(2)}|${dPrev2Memo >= 4.0 ? 1 : 0}|${useSweep32 ? 1 : 0}|${alignOpts?._altAlign ? 1 : 0}`;
        const excludeTailKeys = alignOpts?._excludeTailKeys || null;
        const allowMemo = !excludeTailKeys && !alignOpts?._forcePullBack;
        if (allowMemo && closeAlignMemo.has(memoKey)) {
          const cached = closeAlignMemo.get(memoKey);
          if (!cached) return route;
          if (cached.adjPrev && prevIdxMemo >= 0) {
            route[prevIdxMemo] = { ...route[prevIdxMemo], ...cached.adjPrev };
          }
          if (cached.insertPts?.length) {
            route.splice(route.length - 1, 0, ...cached.insertPts.map((p) => ({ ...p })));
          }
          if (cached.revFinal) {
            route[route.length - 1] = { ...route[route.length - 1], reverse: true };
          }
          return route;
        }
        let cx = clamp(tx, closeTargetObs.x0, closeTargetObs.x1);
        let cy = clamp(ty, closeTargetObs.y0, closeTargetObs.y1);
        if (closeTargetObs.obb) {
          const o = closeTargetObs.obb;
          const lp = worldToLocalPoint(tx, ty, o.cx, o.cy, o.heading);
          const lx = clamp(lp.x, -o.halfW, o.halfW);
          const ly = clamp(lp.y, -o.halfL, o.halfL);
          const [wx, wy] = localToWorld2D(lx, ly, o.cx, o.cy, o.heading);
          cx = wx;
          cy = wy;
        }
        const dClose = Math.hypot(tx - cx, ty - cy);
        if (dClose > 1e-4) {
          const nx = (tx - cx) / dClose;
          const ny = (ty - cy) / dClose;
          const prevIdx = route.length - 2;
          const prevPt = prevIdx >= 0 ? route[prevIdx] : { x: fx, y: fy };
          const incomingH = Math.atan2(tx - prevPt.x, ty - prevPt.y);
          const reqTargetH = Number.isFinite(opts.targetHeading) ? wrapHeading(opts.targetHeading) : null;
          const rawCandHeadings = reqTargetH !== null
            ? [
              reqTargetH,
              Math.atan2(-ny, nx),
              Math.atan2(ny, -nx),
              0,
              Math.PI * 0.5,
              Math.PI,
              -Math.PI * 0.5,
            ]
            : [
              Math.atan2(-ny, nx),
              Math.atan2(ny, -nx),
              0,
              Math.PI * 0.5,
              Math.PI,
              -Math.PI * 0.5,
            ];
          if (dClose >= 1.38) rawCandHeadings.push(Math.atan2(-nx, -ny));
          const arrivalCheckPts = [
            ...AGF_HULL_CORNERS,
            [-0.57, -0.90], [0.57, -0.90],
            [-0.45, 0.72], [0.45, 0.72],
            [0, -1.93], [0, 1.30],
          ];
          const isArrivalPoseClear = (hTest) => {
            for (let ci = 0; ci < arrivalCheckPts.length; ci++) {
              const [lx, ly] = arrivalCheckPts[ci];
              const [wx, wy] = localToWorld2D(lx, ly, tx, ty, hTest);
              const cTol = dClose < 0.65 ? 0.002 : (dClose < 0.72 ? 0.010 : 0.02);
              if (minDistanceToObstacles(wx, wy, obstacles) <= cTol) return false;
            }
            if (!isAgfPoseObbClear(tx, ty, hTest, obstacles, 0.002, null, opts.carriedWcid ?? 0, AGF_CARRIED_TRANSIT_FORK_Z)) return false;
            return true;
          };
          let candHeadings = (reqTargetH !== null && isArrivalPoseClear(reqTargetH) && !useSweep32)
            ? [reqTargetH]
            : rawCandHeadings.filter(isArrivalPoseClear);
          if (candHeadings.length === 0) {
            candHeadings = [Math.PI * 0.25, -Math.PI * 0.25, Math.PI * 0.75, -Math.PI * 0.75].filter(isArrivalPoseClear);
          }
          if ((candHeadings.length === 0 || useSweep32) && dClose < 0.85) {
            for (let ai = 0; ai < 32; ai++) {
              const ah = -Math.PI + (ai / 32) * Math.PI * 2;
              if (isArrivalPoseClear(ah) && !candHeadings.some((h0) => Math.abs(wrapPi(h0 - ah)) < 0.15)) {
                candHeadings.push(ah);
              }
            }
          } else if (dClose < 0.72) {
            for (let ai = 0; ai < 32; ai++) {
              const ah = -Math.PI + (ai / 32) * Math.PI * 2;
              if (isArrivalPoseClear(ah) && !candHeadings.some((h0) => Math.abs(wrapPi(h0 - ah)) < 0.35)) {
                candHeadings.push(ah);
              }
            }
          }
          if (dClose < 0.85) {
            const basePar = [Math.atan2(-ny, nx), Math.atan2(ny, -nx)];
            for (const hb of basePar) {
              for (const dAng of [-0.09, 0.09, -0.14, 0.14]) {
                const ah = wrapPi(hb + dAng);
                if (isArrivalPoseClear(ah) && !candHeadings.some((h0) => Math.abs(wrapPi(h0 - ah)) < 0.05)) {
                  candHeadings.push(ah);
                }
              }
            }
          }
          const noClearArrivalHeading = candHeadings.length === 0;
          if (noClearArrivalHeading && dClose >= 0.572) candHeadings = rawCandHeadings;
          const preMinPad = Math.min(0.72, Math.max(0.43, Math.min(AGF_SPECS.hullRadiusM - 0.01, dClose * 0.82)));
          const segTargetPad = dClose < 1.30 ? Math.min(pad, Math.max(0.32, dClose * 0.64)) : pad;
          const closeSegClear = (ax, ay, bx, by) => {
            if (!checkZoneDBandSeg(ax, ay, bx, by)) return false;
            if (pathIsClear(ax, ay, bx, by, obstacles, pad)) return true;
            if (dClose >= 1.30) return false;
            if (!pathIsClear(ax, ay, bx, by, obstacles, segTargetPad)) return false;
            const bothLocal = Math.hypot(ax - tx, ay - ty) <= 4.5 && Math.hypot(bx - tx, by - ty) <= 4.5;
            for (let i = 0; i < obstacles.length; i++) {
              const ob = obstacles[i];
              if (!ob) continue;
              const dOb = pointToObstacleDist(tx, ty, ob);
              const obPad = dOb < 1.30
                ? Math.min(pad, Math.max(0.32, dOb * 0.64, segTargetPad))
                : (bothLocal ? Math.min(pad, Math.max(0.58, dClose * 0.90)) : pad);
              if (segmentIntersectsObstacle2D(ax, ay, bx, by, ob, obPad)) return false;
            }
            return true;
          };
          const preCands = [];
          if (ty < oy - 20.2 && ty > oy - 24.6 && tx >= ox - 18.0 && tx <= ox + 18.0 && isArrivalPoseClear(Math.PI)) {
            preCands.push({ preX: tx, preY: Math.max(ty + 1.50, oy - 20.65), hSafe: Math.PI, penalty: -2.0 });
            preCands.push({ preX: tx, preY: Math.max(ty + 1.50, oy - 20.35), hSafe: Math.PI, penalty: -1.5 });
            preCands.push({ preX: tx, preY: zoneDBufY, hSafe: Math.PI, penalty: -1.0 });
          }
          const hasParallelClear = dClose < 0.72 && (isArrivalPoseClear(Math.atan2(-ny, nx)) || isArrivalPoseClear(Math.atan2(ny, -nx)));
          const preDistsClose = reqTargetH !== null ? [1.85, 1.40, 1.05, 0.75] : [1.85, 1.40, 1.05];
          for (const preDist of preDistsClose) {
            for (const hSafe of candHeadings) {
              const parDot = hasParallelClear ? Math.abs(Math.sin(hSafe) * nx + Math.cos(hSafe) * ny) : 0;
              const parPen = parDot > 0.10 ? parDot * 3.0 : 0;
              preCands.push({
                preX: tx - Math.sin(hSafe) * preDist,
                preY: ty - Math.cos(hSafe) * preDist,
                hSafe,
                penalty: (preDist < 1.3 ? (dClose < 0.85 ? 0.5 : 2.5) : (preDist < 1.8 ? 0.2 : 0)) + parPen,
              });
              if (dClose < 0.90 && preDist <= 1.45 && dClose >= 0.635) {
                preCands.push({
                  preX: tx - Math.sin(hSafe) * preDist + nx * 0.08,
                  preY: ty - Math.cos(hSafe) * preDist + ny * 0.08,
                  hSafe,
                  penalty: (preDist < 1.3 ? 2.5 : 0.5) + 0.2,
                  nudgeSlow: true,
                });
              } else if (dClose < 0.635 && preDist === 1.85 && parDot <= 0.10) {
                const isCloseStandOut = closeTargetObs.kind === "stand";
                preCands.push({
                  preX: tx - Math.sin(hSafe) * preDist + nx * (isCloseStandOut ? 0.03 : 0.05),
                  preY: ty - Math.cos(hSafe) * preDist + ny * (isCloseStandOut ? 0.03 : 0.05),
                  hSafe,
                  penalty: (isCloseStandOut ? 0.05 : 1.5) + parPen,
                  outNudge: isCloseStandOut ? 0.06 : 0.05,
                });
              }
            }
          }
          if (reqTargetH !== null && isArrivalPoseClear(reqTargetH)) {
            for (const preDist of [1.85, 1.40, 1.05]) {
              preCands.push({
                preX: tx + Math.sin(reqTargetH) * preDist,
                preY: ty + Math.cos(reqTargetH) * preDist,
                hSafe: reqTargetH,
                penalty: 1.8,
                revFinal: true,
              });
            }
          }
          const validPres = [];
          const seenPreKey = new Set();
          for (const { preX, preY, hSafe, penalty, nudgeSlow, outNudge, revFinal } of preCands) {
            if (minDistanceToObstacles(preX, preY, obstacles) < preMinPad) continue;
            const segToTargetOk = dClose < 1.30
              ? closeSegClear(preX, preY, tx, ty)
              : checkSegClear(preX, preY, tx, ty, false, true);
            if (!segToTargetOk) continue;
            const dPrevToPre = Math.hypot(preX - prevPt.x, preY - prevPt.y);
            const entryInH = dPrevToPre > 0.10
              ? Math.atan2(preX - prevPt.x, preY - prevPt.y)
              : (Number.isFinite(opts.heading) ? opts.heading : incomingH);
            const turnDelta = Math.abs(wrapPi(hSafe - entryInH));
            const leadSeqs = [];
            if (!revFinal && (turnDelta > 0.30 || dPrevToPre > 3.5 || dClose < 1.0)) {
              const leadDists = dClose < 1.0 ? [1.20, 2.20, 3.60] : [1.65, 3.40, 5.40];
              for (const ld of leadDists) {
                const lx = preX - Math.sin(hSafe) * ld;
                const ly = preY - Math.cos(hSafe) * ld;
                if (minDistanceToObstacles(lx, ly, obstacles) >= preMinPad && closeSegClear(lx, ly, preX, preY)) {
                  leadSeqs.push([{
                    x: lx,
                    y: ly,
                    skipTol: dClose < 1.0 ? 0.20 : 0.30,
                    speedLimit: dClose < 1.0 ? 0.70 : 1.0,
                  }]);
                  if (
                    ty < oy - 20.2 && ty > oy - 24.6 && tx >= ox - 18.0 && tx <= ox + 18.0 &&
                    Math.abs(Math.sin(hSafe)) > 0.7 && Math.abs(lx - tx) >= 2.0 &&
                    minDistanceToObstacles(lx, zoneDBufY, obstacles) >= 0.72 &&
                    closeSegClear(lx, zoneDBufY, lx, ly)
                  ) {
                    leadSeqs.push([
                      { x: lx, y: zoneDBufY, skipTol: 0.25, speedLimit: 0.85 },
                      { x: lx, y: ly, skipTol: dClose < 1.0 ? 0.20 : 0.30, speedLimit: dClose < 1.0 ? 0.70 : 0.85 },
                    ]);
                  }
                }
                if (dClose < 1.0) {
                  for (const lat of [0.65, 1.35]) {
                    const oxL = lx + nx * lat;
                    const oyL = ly + ny * lat;
                    if (minDistanceToObstacles(oxL, oyL, obstacles) >= 0.72 && closeSegClear(oxL, oyL, preX, preY)) {
                      leadSeqs.push([{ x: oxL, y: oyL, skipTol: 0.20, speedLimit: 0.70 }]);
                    }
                  }
                }
              }
              if (ty < oy - 20.2 && ty > oy - 24.6 && tx >= ox - 18.0 && tx <= ox + 18.0 && Math.abs(wrapPi(hSafe - Math.PI)) < 0.15) {
                const lxZ = tx;
                const lyZ = Math.max(preY + 1.0, oy - 19.60);
                if (minDistanceToObstacles(lxZ, lyZ, obstacles) >= 0.72 && closeSegClear(lxZ, lyZ, preX, preY)) {
                  leadSeqs.push([{ x: lxZ, y: lyZ, skipTol: 0.16, speedLimit: 0.55, _zoneDStandLead: true }]);
                  if (minDistanceToObstacles(lxZ, zoneDBufY, obstacles) >= 0.72 && closeSegClear(lxZ, zoneDBufY, lxZ, lyZ)) {
                    leadSeqs.push([
                      { x: lxZ, y: zoneDBufY, skipTol: 0.14, speedLimit: 0.60 },
                      { x: lxZ, y: lyZ, skipTol: 0.16, speedLimit: 0.55 },
                    ]);
                  }
                  if (minDistanceToObstacles(lxZ, zoneDBufY + 2.0, obstacles) >= 0.72 && closeSegClear(lxZ, zoneDBufY + 2.0, lxZ, lyZ)) {
                    leadSeqs.push([
                      { x: lxZ, y: zoneDBufY + 2.0, skipTol: 0.20, speedLimit: 0.65 },
                      { x: lxZ, y: lyZ, skipTol: 0.16, speedLimit: 0.50 },
                    ]);
                  }
                }
              }
              if (dClose <= 1.65 && !nudgeSlow) {
                const preBack = Math.hypot(preX - tx, preY - ty);
                const fSx = Math.sin(hSafe);
                const fSy = Math.cos(hSafe);
                if (preBack >= 0.9 && preBack <= 1.95) {
                  const ax = tx - fSx * 2.20 + nx * (outNudge || 0);
                  const ay = ty - fSy * 2.20 + ny * (outNudge || 0);
                  if (minDistanceToObstacles(ax, ay, obstacles) >= preMinPad && closeSegClear(ax, ay, preX, preY)) {
                    for (const gLat of [0.0, 0.22, 0.60]) {
                      const gx = tx - fSx * 3.85 + nx * gLat;
                      const gy = ty - fSy * 3.85 + ny * gLat;
                      const gxMinPad = (dClose < 0.65 && gLat === 0.0 && isAgfPoseObbClear(gx, gy, hSafe, obstacles, 0.002, null, opts.carriedWcid ?? 0, AGF_CARRIED_TRANSIT_FORK_Z))
                        ? Math.min(0.66, preMinPad + 0.08)
                        : 0.66;
                      if (minDistanceToObstacles(gx, gy, obstacles) >= gxMinPad && closeSegClear(gx, gy, ax, ay)) {
                        leadSeqs.push([
                          { x: gx, y: gy, skipTol: 0.22, speedLimit: 0.65, _alignedTangent: true },
                          { x: ax, y: ay, skipTol: 0.16, speedLimit: 0.55, _alignedTangent: true },
                        ]);
                      }
                    }
                    for (const [stFwd, stLat, swFwd, swLat] of [
                      [6.2, 2.2, 4.0, 0.45],
                      [5.6, 1.8, 3.6, 0.35],
                      [7.8, 2.5, 4.8, 0.55],
                      [4.8, 1.5, 3.2, 0.25],
                      [2.4, 2.0, 4.3, 0.25],
                      [2.4, 2.0, 4.4, 0.70],
                      [1.0, 2.3, 4.1, 0.45],
                      [0.6, 2.5, 3.9, 1.15],
                      [1.8, 1.5, 3.8, 0.15],
                      [3.1, 0.65, 2.45, 0.12],
                      [3.3, 0.78, 2.6, 0.30],
                      [4.8, 0.75, 3.2, 0.12],
                      [3.8, 0.78, 2.5, 0.20],
                      ...(closeTargetObs?.kind === "stand" ? [[4.8, 1.6, 3.1, 0.15]] : []),
                      [4.8, 0.78, 3.2, 0.18],
                    ]) {
                      const sx2 = tx - fSx * stFwd + nx * stLat;
                      const sy2 = ty - fSy * stFwd + ny * stLat;
                      const wx2 = tx - fSx * swFwd + nx * swLat;
                      const wy2 = ty - fSy * swFwd + ny * swLat;
                      if (
                        minDistanceToObstacles(sx2, sy2, obstacles) >= 0.72 &&
                        minDistanceToObstacles(wx2, wy2, obstacles) >= 0.66 &&
                        closeSegClear(sx2, sy2, wx2, wy2) &&
                        closeSegClear(wx2, wy2, ax, ay)
                      ) {
                        leadSeqs.push([
                          { x: sx2, y: sy2, skipTol: 0.30, speedLimit: 0.85, _alignedTangent: true },
                          { x: wx2, y: wy2, skipTol: 0.22, speedLimit: 0.65, _alignedTangent: true },
                          { x: ax, y: ay, skipTol: 0.16, speedLimit: 0.55, _alignedTangent: true },
                        ]);
                      }
                    }
                    const isCornerYTurn = prevIdx >= 0 && dClose < 0.65 && dPrevToPre < 16.0 && Math.abs(wrapPi(hSafe - tailHMemo)) > 0.75;
                    if ((dPrevToPre < 10.5 && turnDelta > 0.75 && prevIdx < 0) || isCornerYTurn) {
                      for (const [fArm, fOut] of (isCornerYTurn ? [[11.0, 3.6], [7.2, 2.8]] : [
                        [5.8, 2.6],
                        [7.2, 2.8],
                        [11.0, 3.6],
                        [9.0, 3.8],
                      ])) {
                        const pxF = tx - fSx * fArm + nx * fOut;
                        const pyF = ty - fSy * fArm + ny * fOut;
                        const gxF = tx - fSx * 3.85 + nx * 0.22;
                        const gyF = ty - fSy * 3.85 + ny * 0.22;
                        if (
                          minDistanceToObstacles(pxF, pyF, obstacles) >= 0.75 &&
                          minDistanceToObstacles(gxF, gyF, obstacles) >= 0.72 &&
                          pathIsClear(prevPt.x, prevPt.y, pxF, pyF, obstacles, pad) &&
                          pathIsClear(pxF, pyF, gxF, gyF, obstacles, pad) &&
                          closeSegClear(gxF, gyF, ax, ay)
                        ) {
                          leadSeqs.push([
                            { x: pxF, y: pyF, skipTol: 0.45, speedLimit: 1.25, ...(!isCornerYTurn ? { _alignedTangent: true, _yTurn: true } : {}) },
                            { x: gxF, y: gyF, skipTol: 0.22, speedLimit: 0.65, ...(!isCornerYTurn ? { _alignedTangent: true } : {}) },
                            { x: ax, y: ay, skipTol: 0.16, speedLimit: 0.55, ...(!isCornerYTurn ? { _alignedTangent: true } : {}) },
                          ]);
                        }
                      }
                    }
                  }
                }
              }
              if (dClose <= 1.65 && turnDelta > 0.45) {
                const preBack = Math.hypot(preX - tx, preY - ty);
                for (const standLat of [2.10, 1.45, 0.95]) {
                  const sx1 = preX - Math.sin(hSafe) * 2.9 + nx * standLat;
                  const sy1 = preY - Math.cos(hSafe) * 2.9 + ny * standLat;
                  const lx1 = preX - Math.sin(hSafe) * 1.35 + nx * 0.14;
                  const ly1 = preY - Math.cos(hSafe) * 1.35 + ny * 0.14;
                  if (
                    preBack >= 0.9 &&
                    minDistanceToObstacles(sx1, sy1, obstacles) >= 0.72 &&
                    minDistanceToObstacles(lx1, ly1, obstacles) >= preMinPad &&
                    closeSegClear(sx1, sy1, lx1, ly1) &&
                    closeSegClear(lx1, ly1, preX, preY)
                  ) {
                    leadSeqs.push([
                      { x: sx1, y: sy1, skipTol: 0.30, speedLimit: 0.85 },
                      { x: lx1, y: ly1, skipTol: 0.20, speedLimit: 0.65 },
                    ]);
                  }
                }
              }
            }
            leadSeqs.push([]);
            for (const leadList of leadSeqs) {
              const entryPt = leadList.length > 0 ? leadList[0] : { x: preX, y: preY };
              const prevClear = closeSegClear(prevPt.x, prevPt.y, entryPt.x, entryPt.y);
              const chargerSouthDivePenalty =
                closeTargetObs.kind === "charger" && ty >= closeTargetObs.y1 && (preY < ty - 0.10 || leadList.some((lp) => lp.y < ty - 0.10))
                  ? 20
                  : 0;
              const noLeadPenalty = (leadList.length === 0 && turnDelta > 0.45) ? 2.5 : 0;
              const alignedBonus = leadList.some((lp) => lp._alignedTangent) ? (dClose < 0.85 ? -4.0 : -1.2) : 0;
              const twoStageBonus = leadList.length === 2 ? -0.4 : 0;
              const sc = (prevClear ? 0 : 100) + penalty + chargerSouthDivePenalty + noLeadPenalty + twoStageBonus + alignedBonus + turnDelta;
              const pushCand = (skipTol, speedLimit, extraSc) => {
                const key = `${preX.toFixed(2)},${preY.toFixed(2)},${speedLimit},${revFinal ? 1 : 0}|${leadList.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(";")}`;
                if (seenPreKey.has(key)) return;
                seenPreKey.add(key);
                validPres.push({
                  prePt: revFinal
                    ? { x: preX, y: preY, heading: hSafe, _stopAtWaypoint: true, skipTol: 0.16, speedLimit: 0.70 }
                    : { x: preX, y: preY, skipTol, speedLimit },
                  leadList,
                  leadPt: leadList[0] ?? null,
                  hSafe,
                  prevClear,
                  revFinal: Boolean(revFinal),
                  sc: sc + extraSc,
                });
              };
              pushCand(nudgeSlow ? 0.16 : (dClose < 0.85 ? 0.16 : 0.25), nudgeSlow ? 0.55 : (dClose < 0.85 ? 0.60 : 0.85), 0);
              if (dClose < 0.90 && leadList.length !== 1) {
                pushCand(0.12, 0.45, 1.5);
              }
            }
          }
          validPres.sort((a, b) => a.sc - b.sc);
          if (validPres.length > 8) {
            const byBucket = new Map();
            for (const v of validPres) {
              const bkTag = v.leadList.some((lp) => lp._yTurn) ? "Y" : (v.leadList.some((lp) => lp._alignedTangent) ? "A" : v.leadList.length);
              const bk = `${Math.round(v.hSafe * 2)}_${bkTag}_${v.prevClear ? 1 : 0}`;
              if (!byBucket.has(bk)) byBucket.set(bk, []);
              byBucket.get(bk).push(v);
            }
            const diverse = [];
            if (dClose < 0.85) {
              const topYTurn = validPres.filter((v) => v.prevClear && v.leadList.some((lp) => lp._yTurn)).slice(0, 4);
              for (const v of topYTurn) diverse.push(v);
              const topAligned = validPres.filter((v) => v.prevClear && v.leadList.some((lp) => lp._alignedTangent)).slice(0, 8);
              for (const v of topAligned) diverse.push(v);
            }
            const seenDiv = new Set(diverse);
            let added = true;
            let round = 0;
            while (added) {
              added = false;
              for (const arr of byBucket.values()) {
                if (round < arr.length) {
                  if (!seenDiv.has(arr[round])) {
                    diverse.push(arr[round]);
                    seenDiv.add(arr[round]);
                  }
                  added = true;
                }
              }
              round++;
            }
            validPres.splice(0, validPres.length, ...diverse);
          }
          const targetEndWp = {
            x: tx,
            y: ty,
            ...(Number.isFinite(opts.targetHeading) ? { heading: opts.targetHeading } : {}),
            ...(opts.targetDocking ? { docking: true } : {}),
          };
          const tailMaxStepsFor = (sx, sy, tailWps) => {
            let len = 0;
            let px = sx;
            let py = sy;
            for (const w of tailWps) {
              len += Math.hypot(w.x - px, w.y - py);
              px = w.x;
              py = w.y;
            }
            return Math.min(2200, Math.max(900, Math.ceil(len * 190)));
          };
            const isAgfTailObbClear = (sx, sy, sh, sSpeed, tailWps, maxS) => {
              if (dClose >= 0.85 && !(Number.isFinite(opts.targetHeading) && opts.targetDocking)) return true;
              const tailObsMeta = buildObsMeta(obstacles);
              for (const dtSim of [1 / 60, 1 / 30]) {
                let sim = {
                  agentId: "agf-tail-obb",
                  x: sx, y: sy, heading: sh, speed: sSpeed, steerAngleRad: 0,
                  forkHeightM: AGF_EMPTY_TRANSIT_FORK_Z, sideShiftM: 0, mastTiltRad: 0,
                  wheelSpinRad: 0, lidarSpinRad: 0,
                  carriedWcid: opts.carriedWcid ?? 0,
                  loaded: Boolean(opts.loaded || opts.carriedWcid),
                };
                let wpIdx = 0;
                const stepsLim = dtSim < 0.025 ? maxS : Math.ceil(maxS * 0.5);
                for (let s = 0; s < stepsLim; s++) {
                  const curTailWp = tailWps[wpIdx];
                  const isStopTailWp = Boolean(curTailWp?._stopAtWaypoint && wpIdx < tailWps.length - 1);
                  const effTailCmd = isStopTailWp
                    ? {
                        targetPose: {
                          x: curTailWp.x,
                          y: curTailWp.y,
                          ...(Number.isFinite(curTailWp.heading) ? { heading: curTailWp.heading } : {}),
                        },
                        reverse: curTailWp.reverse,
                        docking: curTailWp.docking,
                        speedLimit: curTailWp.speedLimit,
                        targetForkHeightM: AGF_EMPTY_TRANSIT_FORK_Z,
                      }
                    : { waypoints: tailWps, waypointIndex: wpIdx, targetForkHeightM: AGF_EMPTY_TRANSIT_FORK_Z };
                  sim = stepAgfKinematics(sim, effTailCmd, dtSim, {});
                  if (isStopTailWp) {
                    if (sim.arrived) {
                      sim.speed = 0;
                      wpIdx++;
                    }
                  } else {
                    wpIdx = sim.waypointIndex;
                    while (wpIdx < tailWps.length - 1) {
                      const wp = tailWps[wpIdx];
                      if (wp?._stopAtWaypoint) break;
                      const sk = Number.isFinite(wp?.skipTol) ? wp.skipTol : (wp?.speedLimit ? 0.50 : 1.25);
                      if (wp && Math.hypot(wp.x - sim.x, wp.y - sim.y) <= sk && !wp.docking) wpIdx++;
                      else break;
                    }
                  }
                  if (!isAgfPoseObbClear(sim.x, sim.y, sim.heading, obstacles, 0.001, tailObsMeta, sim.carriedWcid, sim.forkHeightM)) return false;
                  if (!isStopTailWp && sim.arrived) break;
                }
              }
              return true;
            };
          let chosen = null;
          let chosenAdjPrev = null;
          if (validPres.length > 0) {
            const prev2 = prevIdx >= 1 ? route[prevIdx - 1] : { x: fx, y: fy };
            const tailH = prevIdx >= 0 && Math.hypot(prevPt.x - prev2.x, prevPt.y - prev2.y) > 0.05
              ? Math.atan2(prevPt.x - prev2.x, prevPt.y - prev2.y)
              : (Number.isFinite(opts.heading) ? opts.heading : incomingH);
            const tailStartMin = prevIdx < 0
              ? startMinDist
              : Math.min(AGF_SPECS.hullRadiusM, Math.max(0.05, minDistanceToObstacles(prevPt.x, prevPt.y, obstacles) - 0.02));

            const loop1PrevSpeed = prevIdx >= 0 ? (dClose < 1.0 ? 0.95 : 1.25) : 0;
            const isZoneDStandBufTurn = prevIdx >= 0 &&
              ty < oy - 20.2 && ty > oy - 24.6 && tx >= ox - 18.0 && tx <= ox + 18.0 &&
              Math.abs(prevPt.y - zoneDBufY) < 0.25 && Math.abs(prevPt.x - tx) < 0.35 &&
              Math.hypot(prevPt.x - prev2.x, prevPt.y - prev2.y) >= 2.2 &&
              Math.abs(wrapPi(Math.atan2(tx - prevPt.x, ty - prevPt.y) - tailH)) > 0.45;
            if (isZoneDStandBufTurn) {
              const bufTurnX = tx + Math.sign(prev2.x - prevPt.x) * 1.10;
              if (minDistanceToObstacles(bufTurnX, zoneDBufY, obstacles) >= 0.72 && pathIsClear(prev2.x, prev2.y, bufTurnX, zoneDBufY, obstacles, pad)) {
                const zdCand = validPres.find((c) => c.leadList.some((lp) => lp._zoneDStandLead));
                const zdTail = zdCand ? [...zdCand.leadList, zdCand.prePt, targetEndWp] : null;
                const okZd = zdTail && isAgfArcClear(
                  {
                    x: bufTurnX, y: zoneDBufY, heading: tailH, speed: 0.65, steerAngleRad: 0,
                    forkHeightM: AGF_EMPTY_TRANSIT_FORK_Z, sideShiftM: 0, mastTiltRad: 0,
                    wheelSpinRad: 0, lidarSpinRad: 0, carriedWcid: opts.carriedWcid ?? 0,
                    loaded: Boolean(opts.loaded || opts.carriedWcid),
                  },
                  zdTail, obstacles, AGF_SPECS.hullRadiusM,
                  Math.min(AGF_SPECS.hullRadiusM, Math.max(0.05, minDistanceToObstacles(bufTurnX, zoneDBufY, obstacles) - 0.02)),
                  { maxSteps: tailMaxStepsFor(bufTurnX, zoneDBufY, zdTail), speedScales: [1.0], requireArrival: true, endMinDist: dClose },
                );
                if (okZd) {
                  chosenAdjPrev = { x: bufTurnX, y: zoneDBufY, speedLimit: 0.65, skipTol: 0.16, _turnThrottle: true };
                  route[prevIdx] = { ...route[prevIdx], ...chosenAdjPrev };
                  chosen = { ...zdCand, prevClear: true };
                }
              }
            }
            const maxLoop1 = alignOpts?._altAlign ? 10 : 24;
            let loop1Tried = 0;
            for (let vi = 0; !alignOpts?._forcePullBack && !chosen && vi < validPres.length && loop1Tried < maxLoop1; vi++) {
              const cand = validPres[vi];
              if (!cand.prevClear) continue;
              const candTailKey = [...cand.leadList, cand.prePt].map((w) => `${w.x.toFixed(2)},${w.y.toFixed(2)}`).join("|");
              if (excludeTailKeys && excludeTailKeys.has(candTailKey)) continue;
              loop1Tried++;
              const tailWps = [...cand.leadList, cand.prePt, cand.revFinal ? { ...targetEndWp, reverse: true } : targetEndWp];
              const entry0 = tailWps[0];
              const dToEntry0 = Math.hypot(entry0.x - prevPt.x, entry0.y - prevPt.y);
              let simX = prevPt.x;
              let simY = prevPt.y;
              let simH = tailH;
              let simMin = tailStartMin;
              const trimThresh = useSweep32 ? 12.5 : 6.5;
              const trimBack = useSweep32 ? 10.5 : 5.5;
              if (dToEntry0 > trimThresh) {
                const uxE = (entry0.x - prevPt.x) / dToEntry0;
                const uyE = (entry0.y - prevPt.y) / dToEntry0;
                simX = entry0.x - uxE * trimBack;
                simY = entry0.y - uyE * trimBack;
                simH = Math.atan2(uxE, uyE);
                simMin = Math.min(AGF_SPECS.hullRadiusM, Math.max(0.05, minDistanceToObstacles(simX, simY, obstacles) - 0.02));
              }
              const tailSteps = tailMaxStepsFor(simX, simY, tailWps);
              if (isAgfArcClear(
                {
                  x: simX,
                  y: simY,
                  heading: simH,
                  speed: loop1PrevSpeed,
                  steerAngleRad: 0,
                  forkHeightM: AGF_EMPTY_TRANSIT_FORK_Z,
                  sideShiftM: 0,
                  mastTiltRad: 0,
                  wheelSpinRad: 0,
                  lidarSpinRad: 0,
                  carriedWcid: opts.carriedWcid ?? 0,
                  loaded: Boolean(opts.loaded || opts.carriedWcid),
                },
                tailWps,
                obstacles,
                AGF_SPECS.hullRadiusM,
                simMin,
                { maxSteps: tailSteps, speedScales: [1.0], requireArrival: true, endMinDist: dClose },
              ) && isAgfTailObbClear(simX, simY, simH, loop1PrevSpeed, tailWps, tailSteps)) {
                chosen = cand;
                break;
              }
            }
          }
          if (!chosen && validPres.length > 0 && prevIdx >= 0 && (!alignOpts?._altAlign || dClose < 0.80)) {
            const prev2 = prevIdx >= 1 ? route[prevIdx - 1] : { x: fx, y: fy };
            const dPrev2 = Math.hypot(prevPt.x - prev2.x, prevPt.y - prev2.y);
            const tailH = dPrev2 > 0.05
              ? Math.atan2(prevPt.x - prev2.x, prevPt.y - prev2.y)
              : (Number.isFinite(opts.heading) ? opts.heading : incomingH);
            const ux = Math.sin(tailH);
            const uy = Math.cos(tailH);
            const loop2Limit = Math.min(validPres.length, dClose < 0.85 ? 6 : 4);
            const pullBacks = [1.05, 2.4, 4.8, -2.2];
            for (const pullBack of pullBacks) {
              if (pullBack > 0 && dPrev2 < pullBack + 1.0) continue;
              const adjX = prevPt.x - ux * pullBack;
              const adjY = prevPt.y - uy * pullBack;
              if (minDistanceToObstacles(adjX, adjY, obstacles) < 0.72) continue;
              if (!pathIsClear(prev2.x, prev2.y, adjX, adjY, obstacles, pad) || !checkZoneDBandSeg(prev2.x, prev2.y, adjX, adjY)) continue;
              const adjStartMin = Math.min(AGF_SPECS.hullRadiusM, Math.max(0.05, minDistanceToObstacles(adjX, adjY, obstacles) - 0.02));
              for (let vi = 0; vi < loop2Limit; vi++) {
                const cand = validPres[vi];
                const entryPt = cand.leadList[0] || cand.prePt;
                const candTailKey2 = [...cand.leadList, cand.prePt].map((w) => `${w.x.toFixed(2)},${w.y.toFixed(2)}`).join("|");
                if (excludeTailKeys && excludeTailKeys.has(candTailKey2)) continue;
                const dToEntry = Math.hypot(entryPt.x - prevPt.x, entryPt.y - prevPt.y);
                const leadVariants = [];
                if (closeSegClear(adjX, adjY, entryPt.x, entryPt.y)) {
                  leadVariants.push([]);
                }
                if (dClose < 0.85 && pullBack > 0 && dToEntry > 5.0) {
                  const uEx = (entryPt.x - prevPt.x) / dToEntry;
                  const uEy = (entryPt.y - prevPt.y) / dToEntry;
                  const m1 = { x: prevPt.x + uEx * 1.4 + nx * 0.55, y: prevPt.y + uEy * 1.4 + ny * 0.55, skipTol: 0.22, speedLimit: 0.60 };
                  const m2 = { x: prevPt.x + uEx * 3.4 + nx * 0.14, y: prevPt.y + uEy * 3.4 + ny * 0.14, skipTol: 0.22, speedLimit: 0.65 };
                  const m3 = { x: prevPt.x + uEx * 5.6 + nx * 0.10, y: prevPt.y + uEy * 5.6 + ny * 0.10, skipTol: 0.25, speedLimit: 0.75 };
                  if (
                    minDistanceToObstacles(m1.x, m1.y, obstacles) >= 0.72 &&
                    minDistanceToObstacles(m2.x, m2.y, obstacles) >= 0.66 &&
                    minDistanceToObstacles(m3.x, m3.y, obstacles) >= 0.66 &&
                    closeSegClear(adjX, adjY, m1.x, m1.y) &&
                    closeSegClear(m1.x, m1.y, m2.x, m2.y) &&
                    closeSegClear(m2.x, m2.y, m3.x, m3.y) &&
                    closeSegClear(m3.x, m3.y, entryPt.x, entryPt.y)
                  ) {
                    leadVariants.unshift([m1, m2, m3]);
                  }
                }
                for (const extraLeads of leadVariants) {
                  const tailWps = [...extraLeads, ...cand.leadList, cand.prePt, cand.revFinal ? { ...targetEndWp, reverse: true } : targetEndWp];
                  const adjSpeed = extraLeads.length > 0 ? 0.65 : 0.90;
                  if (isAgfArcClear(
                    {
                      x: adjX,
                      y: adjY,
                      heading: tailH,
                      speed: adjSpeed,
                      steerAngleRad: 0,
                      forkHeightM: AGF_EMPTY_TRANSIT_FORK_Z,
                      sideShiftM: 0,
                      mastTiltRad: 0,
                      wheelSpinRad: 0,
                      lidarSpinRad: 0,
                      carriedWcid: opts.carriedWcid ?? 0,
                      loaded: Boolean(opts.loaded || opts.carriedWcid),
                    },
                    tailWps,
                    obstacles,
                    AGF_SPECS.hullRadiusM,
                    adjStartMin,
                    { maxSteps: tailMaxStepsFor(adjX, adjY, tailWps), speedScales: [1.0], requireArrival: true, endMinDist: dClose },
                  ) && isAgfTailObbClear(adjX, adjY, tailH, adjSpeed, tailWps, tailMaxStepsFor(adjX, adjY, tailWps))) {
                    chosenAdjPrev = {
                      x: adjX,
                      y: adjY,
                      speedLimit: extraLeads.length > 0 ? 0.65 : 0.90,
                      skipTol: extraLeads.length > 0 ? 0.20 : 0.25,
                      _turnThrottle: true,
                    };
                    route[prevIdx] = { ...route[prevIdx], ...chosenAdjPrev };
                    chosen = { ...cand, leadList: [...extraLeads, ...cand.leadList], prevClear: true };
                    break;
                  }
                }
                if (chosen) break;
              }
              if (chosen) break;
            }
          }
          if (chosen) {
            const { prePt: bestPre, leadList: bestLeadList, prevClear: bestPrevClear } = chosen;
            const insertPts = [...bestLeadList, bestPre].map((p) => (
              Number.isFinite(p.speedLimit) ? { ...p, _noSubdivideSpeed: true } : p
            ));
            const firstIns = insertPts[0];
            const prev2 = prevIdx >= 1 ? route[prevIdx - 1] : { x: fx, y: fy };
            const turnAtPrev = prevIdx >= 0
              ? Math.abs(wrapPi(Math.atan2(firstIns.x - prevPt.x, firstIns.y - prevPt.y) - Math.atan2(prevPt.x - prev2.x, prevPt.y - prev2.y)))
              : 0;
            if (prevIdx >= 0 && (Math.hypot(tx - prevPt.x, ty - prevPt.y) <= 10.0 || turnAtPrev > 0.35)) {
              const isZoneDStandEntry = ty < oy - 20.2 && ty > oy - 24.6 && tx >= ox - 18.0 && tx <= ox + 18.0 && turnAtPrev > 0.35;
              const prevCap = isZoneDStandEntry ? 0.65 : (dClose < 1.0 ? 0.95 : 1.25);
              const capPatch = {
                speedLimit: Math.min(route[prevIdx].speedLimit ?? Infinity, prevCap),
                skipTol: Math.min(route[prevIdx].skipTol ?? 0.45, isZoneDStandEntry ? 0.14 : 0.25),
                _noSubdivideSpeed: true,
              };
              chosenAdjPrev = chosenAdjPrev ? { ...chosenAdjPrev, ...capPatch } : capPatch;
              route[prevIdx] = { ...route[prevIdx], ...capPatch };
            }
            if (!bestPrevClear && Math.hypot(firstIns.x - prevPt.x, firstIns.y - prevPt.y) > 0.5) {
              const bridge = findPath([prevPt.x, prevPt.y], [firstIns.x, firstIns.y], "agf", {
                docking: true,
                validateFullRoute: false,
                obstaclePad: pad,
              });
              if (bridge.length > 0) {
                bridge[bridge.length - 1] = { ...bridge[bridge.length - 1], skipTol: firstIns.skipTol, speedLimit: firstIns.speedLimit };
                const finalIns = [...bridge, ...insertPts.slice(1)];
                if (allowMemo) closeAlignMemo.set(memoKey, { adjPrev: chosenAdjPrev, insertPts: finalIns, revFinal: Boolean(chosen.revFinal) });
                route.splice(route.length - 1, 0, ...finalIns);
              } else {
                if (allowMemo) closeAlignMemo.set(memoKey, { adjPrev: chosenAdjPrev, insertPts, revFinal: Boolean(chosen.revFinal) });
                route.splice(route.length - 1, 0, ...insertPts);
              }
            } else {
              if (allowMemo) closeAlignMemo.set(memoKey, { adjPrev: chosenAdjPrev, insertPts, revFinal: Boolean(chosen.revFinal) });
              route.splice(route.length - 1, 0, ...insertPts);
            }
            if (chosen.revFinal) {
              route[route.length - 1] = { ...route[route.length - 1], reverse: true };
            }
            route._tailKey = insertPts.map((w) => `${w.x.toFixed(2)},${w.y.toFixed(2)}`).join("|");
          } else {
            if (allowMemo) closeAlignMemo.set(memoKey, null);
          }
        }
      }
      return route;
    };
    const finalizeAgfRoute = (rawOut) => {
      if (mode !== "agf") return rawOut;
      if (checkAgfDeparture && opts.validateFullRoute !== false && opts.docking !== true && !opts._returnEmptyOnFail && minDistanceToObstacles(tx, ty, obstacles) < 0.40) {
        if (opts._rejectOnFail) {
          throw new Error(`AGF route unreachable from (${fx.toFixed(2)}, ${fy.toFixed(2)}) to (${tx.toFixed(2)}, ${ty.toFixed(2)})`);
        }
        return [{ x: fx, y: fy }];
      }
      const tryTargetEdgeNudge = () => {
        if (mode !== "agf" || opts.docking === true || opts._noRescue || opts._fromEdgeNudge) return null;
        const endObsDist = minDistanceToObstacles(tx, ty, obstacles);
        if (endObsDist < 0.40 || endObsDist >= 0.625) return null;
        let bestOb = null;
        let bestD = Infinity;
        for (let i = 0; i < obstacles.length; i++) {
          const b = obstacles[i];
          if (!b) continue;
          const d = pointToObstacleDist(tx, ty, b);
          if (d < bestD) { bestD = d; bestOb = b; }
        }
        if (!bestOb) return null;
        let cx = tx;
        let cy = ty;
        if (bestOb.obb) {
          const { cx: ocx, cy: ocy, heading: oh, halfW, halfL } = bestOb.obb;
          const padO = bestOb.pad ?? 0;
          const dx = tx - ocx;
          const dy = ty - ocy;
          const sh = Math.sin(oh);
          const ch = Math.cos(oh);
          const lx = dx * ch - dy * sh;
          const ly = dx * sh + dy * ch;
          const clx = Math.max(-(halfW + padO), Math.min(halfW + padO, lx));
          const cly = Math.max(-(halfL + padO), Math.min(halfL + padO, ly));
          [cx, cy] = localToWorld2D(clx, cly, ocx, ocy, oh);
        } else {
          cx = Math.max(bestOb.x0, Math.min(bestOb.x1, tx));
          cy = Math.max(bestOb.y0, Math.min(bestOb.y1, ty));
        }
        const dN = Math.hypot(tx - cx, ty - cy);
        if (dN <= 1e-4) return null;
        const edgeGoalD = (opts.carriedWcid || opts.loaded) ? 0.650 : 0.605;
        const pushD = dN < edgeGoalD
          ? Math.min(0.132, Math.max(0.02, edgeGoalD - dN))
          : Math.min(0.132, Math.max(0.04, 0.680 - dN));
        const ntx = tx + ((tx - cx) / dN) * pushD;
        const nty = ty + ((ty - cy) / dN) * pushD;
        const nudgePlan = findPath([fx, fy], [ntx, nty], "agf", {
          ...opts,
          validateFullRoute: true,
          _fromEdgeNudge: true,
          _candSweep32: true,
          _returnEmptyOnFail: true,
        });
        if (
          nudgePlan.length > 0 &&
          Math.hypot(nudgePlan[nudgePlan.length - 1].x - ntx, nudgePlan[nudgePlan.length - 1].y - nty) <= 0.05 &&
          isAgfArcClear(
            {
              x: fx, y: fy, heading: opts.heading, speed: 0, steerAngleRad: 0,
              forkHeightM: AGF_EMPTY_TRANSIT_FORK_Z, sideShiftM: 0, mastTiltRad: 0,
              wheelSpinRad: 0, lidarSpinRad: 0,
              carriedWcid: opts.carriedWcid ?? 0,
              loaded: Boolean(opts.loaded || opts.carriedWcid),
            },
            nudgePlan, obstacles, AGF_SPECS.hullRadiusM, startMinDist,
            { maxSteps: 14000, speedScales: [1.0], requireArrival: true, endMinDist: minDistanceToObstacles(ntx, nty, obstacles) },
          )
        ) {
          nudgePlan[nudgePlan.length - 1] = { ...nudgePlan[nudgePlan.length - 1], _clampedClearTarget: true };
          return nudgePlan;
        }
        return null;
      };
      if (checkAgfDeparture && opts.validateFullRoute !== false && opts.docking !== true && !(Number.isFinite(opts.targetHeading) && opts.targetDocking) && (!opts._noRescue || opts._allowTargetRescues)) {
        const endObsD = minDistanceToObstacles(tx, ty, obstacles);
        if (endObsD >= 0.40 && endObsD < 0.575) {
          let anyObbClear = false;
          for (let ai = 0; ai < 32; ai++) {
            const ah = -Math.PI + (ai / 32) * Math.PI * 2;
            if (isAgfPoseObbClear(tx, ty, ah, obstacles, 0.002, null, opts.carriedWcid ?? 0, AGF_CARRIED_TRANSIT_FORK_Z)) {
              anyObbClear = true;
              break;
            }
          }
          if (!anyObbClear) {
            const nudged = tryTargetEdgeNudge();
            if (nudged) return nudged;
          }
        }
      }
      const route = opts._skipCloseAlign ? rawOut : applyCloseTargetAlign(rawOut);
      if (!checkAgfDeparture || opts.validateFullRoute === false) {
        return opts._skipSubdivide ? route : subdivideWaypoints(fx, fy, route, 4.5);
      }
      const seenFullKeys = new Set();
      let lastFullFailInfo = null;
      const isFullRouteClear = (wps) => {
        const sub = subdivideWaypoints(fx, fy, wps, 4.5);
        if (sub.length > 0 && (Number.isFinite(opts.targetHeading) || opts.targetDocking)) {
          const lastSub = sub[sub.length - 1];
          sub[sub.length - 1] = {
            ...lastSub,
            ...(Number.isFinite(opts.targetHeading) ? { heading: opts.targetHeading } : {}),
            ...(opts.targetDocking ? { docking: true } : {}),
          };
        }
        const fKey = sub.map((w) => `${w.x.toFixed(2)},${w.y.toFixed(2)},${w.reverse ? 1 : 0},${Number.isFinite(w.speedLimit) ? w.speedLimit.toFixed(2) : ""},${w.skipTol ?? ""}`).join("|");
        if (seenFullKeys.has(fKey)) return false;
        seenFullKeys.add(fKey);
        let totalLen = 0;
        let px = fx;
        let py = fy;
        for (let i = 0; i < sub.length; i++) {
          totalLen += Math.hypot(sub[i].x - px, sub[i].y - py);
          px = sub[i].x;
          py = sub[i].y;
        }
        const maxSteps = Math.min(14000, Math.max(600, Math.ceil(totalLen * 150)));
        const failInfo = { x: fx, y: fy, step: 0 };
        const ok = isAgfArcClear(
          {
            x: fx,
            y: fy,
            heading: opts.heading,
            speed: 0,
            steerAngleRad: 0,
            forkHeightM: AGF_EMPTY_TRANSIT_FORK_Z,
            sideShiftM: 0,
            mastTiltRad: 0,
            wheelSpinRad: 0,
            lidarSpinRad: 0,
            carriedWcid: opts.carriedWcid ?? 0,
            loaded: Boolean(opts.loaded || opts.carriedWcid),
          },
          sub,
          obstacles,
          AGF_SPECS.hullRadiusM,
          startMinDist,
          { maxSteps, speedScales: [1.0], requireArrival: true, endMinDist: minDistanceToObstacles(tx, ty, obstacles), _failInfo: failInfo },
        );
        if (!ok) lastFullFailInfo = failInfo;
        return ok;
      };
      const throttleTurns = (wps, turnSpeed = 1.25, turnSkipTol = 0.35) => {
        const throttled = wps.map((w) => ({ ...w }));
        for (let i = 0; i < throttled.length - 1; i++) {
          const pCur = throttled[i];
          if (pCur.reverse) continue;
          const pPrev = i === 0 ? { x: fx, y: fy } : throttled[i - 1];
          const pNext = throttled[i + 1];
          const hIn = (i === 0 && Number.isFinite(opts.heading))
            ? opts.heading
            : Math.atan2(pCur.x - pPrev.x, pCur.y - pPrev.y);
          const hOut = Math.atan2(pNext.x - pCur.x, pNext.y - pCur.y);
          if (Math.abs(wrapPi(hOut - hIn)) > 0.35) {
            pCur.speedLimit = Math.min(pCur.speedLimit ?? Infinity, turnSpeed);
            pCur.skipTol = Math.min(pCur.skipTol ?? 0.45, turnSkipTol);
            pCur._turnThrottle = true;
          }
        }
        return throttled;
      };
      if (isFullRouteClear(route)) {
        return subdivideWaypoints(fx, fy, route, 4.5);
      }
      const throttled = throttleTurns(route, 1.25, 0.35);
      if (isFullRouteClear(throttled)) {
        return subdivideWaypoints(fx, fy, throttled, 4.5);
      }
      const tightThrottled = throttleTurns(route, 0.80, 0.25);
      if (isFullRouteClear(tightThrottled)) {
        return subdivideWaypoints(fx, fy, tightThrottled, 4.5);
      }
      if (mode === "agf" && opts.docking !== true && !(Number.isFinite(opts.targetHeading) && opts.targetDocking) && (!opts._noRescue || opts._allowTargetRescues)) {
        const endObsD = minDistanceToObstacles(tx, ty, obstacles);
        if (endObsD >= 0.40 && endObsD < 0.595) {
          const nudged = tryTargetEdgeNudge();
          if (nudged) return nudged;
        }
      }
      if (needCloseTargetAlign && rawOut.length > 1 && checkSegClear(fx, fy, tx, ty, true, true)) {
        const directAligned = applyCloseTargetAlign([{ x: tx, y: ty }], { _candSweep32: true });
        if (isFullRouteClear(directAligned)) {
          return subdivideWaypoints(fx, fy, directAligned, 4.5);
        }
        const directAlignedTight = throttleTurns(directAligned, 0.80, 0.25);
        if (isFullRouteClear(directAlignedTight)) {
          return subdivideWaypoints(fx, fy, directAlignedTight, 4.5);
        }
      }
      const failedNearStartGate = lastFullFailInfo && Math.hypot(lastFullFailInfo.x - fx, lastFullFailInfo.y - fy) < 4.5 && Math.hypot(lastFullFailInfo.x - tx, lastFullFailInfo.y - ty) > 12.0;
      const tailReachR = Math.max(8.0, (route.length >= 2 ? Math.hypot(route[route.length - 2].x - tx, route[route.length - 2].y - ty) : 0) + 4.0);
      if (!failedNearStartGate && needCloseTargetAlign && lastFullFailInfo && (closeTargetDist < 0.85 || Math.hypot(lastFullFailInfo.x - tx, lastFullFailInfo.y - ty) < tailReachR) && (!opts._noRescue || opts._allowTargetRescues)) {
        const excludeTailKeys = new Set();
        for (let retry = 0; retry < (closeTargetDist < 0.90 ? 1 : 4); retry++) {
          const prevTail = route._tailKey || route.slice(Math.max(0, route.length - 4), -1).map((w) => `${w.x.toFixed(2)},${w.y.toFixed(2)}`).join("|");
          if (prevTail) excludeTailKeys.add(prevTail);
          const altTailRoute = applyCloseTargetAlign(rawOut, { _candSweep32: true, _excludeTailKeys: excludeTailKeys, ...(closeTargetDist < 0.85 && retry === 0 ? { _forcePullBack: true } : {}) });
          const newTail = altTailRoute._tailKey || altTailRoute.slice(Math.max(0, altTailRoute.length - 4), -1).map((w) => `${w.x.toFixed(2)},${w.y.toFixed(2)}`).join("|");
          if (!newTail || excludeTailKeys.has(newTail)) break;
          excludeTailKeys.add(newTail);
          if (isFullRouteClear(altTailRoute)) return subdivideWaypoints(fx, fy, altTailRoute, 4.5);
          const altTailTight = throttleTurns(altTailRoute, 0.80, 0.25);
          if (isFullRouteClear(altTailTight)) return subdivideWaypoints(fx, fy, altTailTight, 4.5);
        }
      }
      const nearTargetAltRaws = [];
      const failedStartSeqs = new Set();
      if (rankedShortcuts.length > 1) {
        const sorted = [...rankedShortcuts].sort((a, b) => a.score - b.score);
        const seenAlt = new Set();
        const tailCounts = new Map();
        let tried = 0;
        for (let ri = 0; ri < sorted.length && tried < ((needCloseTargetAlign && closeTargetDist < 0.85 && nearTargetAltRaws.length >= 2 && !opts._candSweep32) ? 6 : 24); ri++) {
          const seq = sorted[ri].seq;
          if (seq === bestShortcut) continue;
          const tailKey = seq.slice(-2).map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join("|");
          if ((tailCounts.get(tailKey) ?? 0) >= 2) continue;
          const altRaw = [];
          for (const p of seq) {
            const dStart = Math.hypot(p.x - fx, p.y - fy);
            if ((p.reverse ? dStart > 0.05 : dStart > 0.35) && Math.hypot(p.x - tx, p.y - ty) > 0.35) {
              altRaw.push({
                x: p.x,
                y: p.y,
                skipTol: p.skipTol ?? 0.45,
                ...(p.reverse !== undefined ? { reverse: p.reverse } : {}),
                ...(Number.isFinite(p.speedLimit) ? { speedLimit: p.speedLimit } : {}),
                ...(p._turnThrottle ? { _turnThrottle: true } : {}),
                ...(p._noSubdivideSpeed ? { _noSubdivideSpeed: true } : {}),
              });
            }
          }
          altRaw.push({ x: tx, y: ty });
          if (needArcCheck && !arcClearFor(subdivideWaypoints(fx, fy, altRaw, 4.5).slice(0, useMultiWpArc ? 6 : 4), useMultiWpArc)) {
            failedStartSeqs.add(seq);
            continue;
          }
          const altOut = applyCloseTargetAlign(altRaw, { _altAlign: true });
          const altKey = altOut.map((w) => `${w.x.toFixed(2)},${w.y.toFixed(2)},${w.reverse ? 1 : 0}`).join("|");
          if (seenAlt.has(altKey)) continue;
          seenAlt.add(altKey);
          tailCounts.set(tailKey, (tailCounts.get(tailKey) ?? 0) + 1);
          tried++;
          if (isFullRouteClear(altOut)) {
            return subdivideWaypoints(fx, fy, altOut, 4.5);
          }
          const altTight = throttleTurns(altOut, 0.80, 0.25);
          if (isFullRouteClear(altTight)) {
            return subdivideWaypoints(fx, fy, altTight, 4.5);
          }
          if (lastFullFailInfo) {
            const dFStart = Math.hypot(lastFullFailInfo.x - fx, lastFullFailInfo.y - fy);
            const dFTgt = Math.hypot(lastFullFailInfo.x - tx, lastFullFailInfo.y - ty);
            if (dFStart < 4.5 && dFTgt > 12.0) {
              failedStartSeqs.add(seq);
            } else if (dFTgt < 12.0 && nearTargetAltRaws.length < 4) {
              nearTargetAltRaws.push({ seq, altRaw });
            }
          }
          if (needCloseTargetAlign && closeTargetDist < 0.65 && !opts._noRescue && tried <= 6 && altOut._tailKey) {
            const exAlt = new Set([altOut._tailKey]);
            for (let ar = 0; ar < 2; ar++) {
              const altRetry = applyCloseTargetAlign(altRaw, { _altAlign: true, _excludeTailKeys: exAlt });
              if (!altRetry._tailKey || exAlt.has(altRetry._tailKey)) break;
              exAlt.add(altRetry._tailKey);
              if (isFullRouteClear(altRetry)) return subdivideWaypoints(fx, fy, altRetry, 4.5);
              const altRetryTight = throttleTurns(altRetry, 0.80, 0.25);
              if (isFullRouteClear(altRetryTight)) return subdivideWaypoints(fx, fy, altRetryTight, 4.5);
            }
          }
        }
      }
      const failedNearStartOnly = lastFullFailInfo && Math.hypot(lastFullFailInfo.x - fx, lastFullFailInfo.y - fy) < 4.5 && Math.hypot(lastFullFailInfo.x - tx, lastFullFailInfo.y - ty) > 12.0;
      if (!failedNearStartOnly && needCloseTargetAlign && mode === "agf" && opts.docking !== true && (!opts._noRescue || opts._allowTargetRescues) && !opts._candSweep32) {
        if (!failedNearStartGate) {
          const sweepRoute = applyCloseTargetAlign(rawOut, { _candSweep32: true });
          if (isFullRouteClear(sweepRoute)) {
            return subdivideWaypoints(fx, fy, sweepRoute, 4.5);
          }
          const sweepTight = throttleTurns(sweepRoute, 0.80, 0.25);
          if (isFullRouteClear(sweepTight)) {
            return subdivideWaypoints(fx, fy, sweepTight, 4.5);
          }
        }
        const triedSeqs = new Set();
        let triedSw = 0;
        for (let ti = 0; ti < nearTargetAltRaws.length && triedSw < 4; ti++) {
          const { seq, altRaw } = nearTargetAltRaws[ti];
          triedSeqs.add(seq);
          triedSw++;
          const swAlt = applyCloseTargetAlign(altRaw, { _candSweep32: true, _altAlign: true });
          if (isFullRouteClear(swAlt)) {
            return subdivideWaypoints(fx, fy, swAlt, 4.5);
          }
          const swAltTight = throttleTurns(swAlt, 0.80, 0.25);
          if (isFullRouteClear(swAltTight)) {
            return subdivideWaypoints(fx, fy, swAltTight, 4.5);
          }
        }
        if (rankedShortcuts.length > 1 && triedSw < 4) {
          const sortedSw = [...rankedShortcuts].sort((a, b) => a.score - b.score);
          for (let ri = 0; ri < sortedSw.length && triedSw < 4; ri++) {
            const seq = sortedSw[ri].seq;
            if (seq === bestShortcut || triedSeqs.has(seq) || failedStartSeqs.has(seq)) continue;
            const altRaw = [];
            for (const p of seq) {
              const dStart = Math.hypot(p.x - fx, p.y - fy);
              if ((p.reverse ? dStart > 0.05 : dStart > 0.35) && Math.hypot(p.x - tx, p.y - ty) > 0.35) {
                altRaw.push({
                  x: p.x,
                  y: p.y,
                  skipTol: p.skipTol ?? 0.45,
                  ...(p.reverse !== undefined ? { reverse: p.reverse } : {}),
                  ...(Number.isFinite(p.speedLimit) ? { speedLimit: p.speedLimit } : {}),
                  ...(p._turnThrottle ? { _turnThrottle: true } : {}),
                  ...(p._noSubdivideSpeed ? { _noSubdivideSpeed: true } : {}),
                });
              }
            }
            altRaw.push({ x: tx, y: ty });
            if (needArcCheck && !arcClearFor(subdivideWaypoints(fx, fy, altRaw, 4.5).slice(0, useMultiWpArc ? 6 : 4), useMultiWpArc)) {
              continue;
            }
            triedSw++;
            const swAlt = applyCloseTargetAlign(altRaw, { _candSweep32: true, _altAlign: true });
            if (isFullRouteClear(swAlt)) {
              return subdivideWaypoints(fx, fy, swAlt, 4.5);
            }
            const swAltTight = throttleTurns(swAlt, 0.80, 0.25);
            if (isFullRouteClear(swAltTight)) {
              return subdivideWaypoints(fx, fy, swAltTight, 4.5);
            }
          }
        }
      }
      if (mode === "agf" && opts.docking !== true && !(Number.isFinite(opts.targetHeading) && opts.targetDocking) && (!opts._noRescue || opts._allowTargetRescues)) {
        const endObsD2 = minDistanceToObstacles(tx, ty, obstacles);
        if (endObsD2 >= 0.40 && endObsD2 < 0.625) {
          const nudged = tryTargetEdgeNudge();
          if (nudged) return nudged;
        }
      }
      if (!opts._noRescue) {
        let rescueVerifyCount = 0;
        const MAX_RESCUE_VERIFY = 20;
        if (needCloseTargetAlign && startMinDist >= 1.5 && arcClearFor(subdivideWaypoints(fx, fy, route, 4.5).slice(0, 3), true)) {
          const shiftedStarts = [];
          if (fy > oy + 24.0 && ty > oy + 24.0 && closeTargetObs?.kind === "container") {
            shiftedStarts.push(
              { sx: fx, sy: crossAisleY, reverse: fHyStart > 0, shiftH: fHyStart > 0 ? 0 : Math.PI },
              { sx: fx, sy: oy + 40.5, reverse: fHyStart < 0, shiftH: fHyStart < 0 ? Math.PI : 0 },
            );
          }
          for (const dBack of [2.2, 3.6, 5.5]) {
            shiftedStarts.push(
              { sx: fx - fHxStart * dBack, sy: fy - fHyStart * dBack, reverse: true, shiftH: opts.heading },
              { sx: fx + dBack, sy: fy, reverse: false, shiftH: Math.PI * 0.5 },
              { sx: fx - dBack, sy: fy, reverse: false, shiftH: -Math.PI * 0.5 },
              { sx: fx, sy: fy + dBack, reverse: false, shiftH: 0 },
              { sx: fx, sy: fy - dBack, reverse: false, shiftH: Math.PI },
            );
          }
          let shiftedTried = 0;
          for (const { sx, sy, reverse, shiftH } of shiftedStarts) {
            if (shiftedTried >= 8) break;
            if (minDistanceToObstacles(sx, sy, obstacles) < 0.72) continue;
            if (!pathIsClear(fx, fy, sx, sy, obstacles, pad) || !checkZoneDBandSeg(fx, fy, sx, sy)) continue;
            const shiftPt = {
              x: sx,
              y: sy,
              ...(reverse ? { reverse: true } : {}),
              skipTol: 0.30,
              speedLimit: reverse ? 0.8 : 1.0,
            };
            if (!arcClearFor([shiftPt], false)) continue;
            shiftedTried++;
            const subPlan = findPath([sx, sy], [tx, ty], "agf", {
              ...opts,
              heading: shiftH,
              validateFullRoute: false,
              _skipCloseAlign: true,
              _skipSubdivide: true,
              _noRescue: true,
            });
            const alignedShift = applyCloseTargetAlign([shiftPt, ...subPlan]);
            if (isFullRouteClear(alignedShift)) {
              return subdivideWaypoints(fx, fy, alignedShift, 4.5);
            }
            const alignedShiftTight = throttleTurns(alignedShift, 1.0, 0.25);
            if (isFullRouteClear(alignedShiftTight)) {
              return subdivideWaypoints(fx, fy, alignedShiftTight, 4.5);
            }
            if (needCloseTargetAlign && closeTargetDist < 0.85 && !opts._candSweep32) {
              const alignedShiftSw = applyCloseTargetAlign([shiftPt, ...subPlan], { _candSweep32: true });
              if (isFullRouteClear(alignedShiftSw)) {
                return subdivideWaypoints(fx, fy, alignedShiftSw, 4.5);
              }
              const alignedShiftSwTight = throttleTurns(alignedShiftSw, 0.80, 0.25);
              if (isFullRouteClear(alignedShiftSwTight)) {
                return subdivideWaypoints(fx, fy, alignedShiftSwTight, 4.5);
              }
            }
          }
        }
        const simEscapePose = (escWps, maxSBase = 600) => {
          let endPose = null;
          for (const dtSim of [1 / 60, 1 / 30]) {
            let sim = {
              agentId: "agf-esc",
              x: fx,
              y: fy,
              heading: opts.heading,
              speed: 0,
              steerAngleRad: 0,
              forkHeightM: AGF_EMPTY_TRANSIT_FORK_Z,
              sideShiftM: 0,
              mastTiltRad: 0,
              wheelSpinRad: 0,
              lidarSpinRad: 0,
              carriedWcid: opts.carriedWcid ?? 0,
              loaded: Boolean(opts.loaded || opts.carriedWcid),
            };
            let wpIdx = 0;
            let arrived = false;
            const maxS = dtSim < 0.025 ? maxSBase : Math.ceil(maxSBase * 0.5);
            for (let s = 0; s < maxS; s++) {
              sim = stepAgfKinematics(sim, { waypoints: escWps, waypointIndex: wpIdx, targetForkHeightM: AGF_EMPTY_TRANSIT_FORK_Z }, dtSim, {});
              wpIdx = sim.waypointIndex;
              while (wpIdx < escWps.length - 1 && Math.hypot(escWps[wpIdx].x - sim.x, escWps[wpIdx].y - sim.y) <= (escWps[wpIdx].skipTol ?? 0.25)) {
                wpIdx++;
              }
              if (sim.arrived) {
                arrived = true;
                break;
              }
            }
            if (!arrived) return null;
            endPose = { x: sim.x, y: sim.y, heading: sim.heading };
          }
          if (!endPose || minDistanceToObstacles(endPose.x, endPose.y, obstacles) < 0.66) return null;
          if (!isAgfArcClear(
            {
              x: fx, y: fy, heading: opts.heading, speed: 0, steerAngleRad: 0,
              forkHeightM: AGF_EMPTY_TRANSIT_FORK_Z, sideShiftM: 0, mastTiltRad: 0,
              wheelSpinRad: 0, lidarSpinRad: 0,
              carriedWcid: opts.carriedWcid ?? 0,
              loaded: Boolean(opts.loaded || opts.carriedWcid),
            },
            escWps,
            obstacles,
            AGF_SPECS.hullRadiusM,
            startMinDist,
            { maxSteps: Math.max(600, maxSBase), speedScales: [1.0], requireArrival: true },
          )) {
            return null;
          }
          return endPose;
        };
        const rescueSpecs = [];
        for (const dRev of [1.6, 2.4, 3.2, 0.90, 0.60]) {
          rescueSpecs.push({
            wp: {
              x: fx - fHxStart * dRev,
              y: fy - fHyStart * dRev,
              reverse: true,
              skipTol: 0.22,
              speedLimit: dRev < 1.0 ? 0.55 : 0.80,
            },
          });
        }
        for (const ang of [0, -0.40, 0.40, -0.75, 0.75, -0.95, 0.95, -1.15, 1.15]) {
          const hFwd = opts.heading + ang;
          const hRev = opts.heading + Math.PI + ang;
          for (const dSide of [0.60, 0.80, 1.35, 1.5, 2.2, 3.2]) {
            if (ang !== 0 || dSide >= 0.85) {
              rescueSpecs.push({
                wp: {
                  x: fx + Math.sin(hFwd) * dSide,
                  y: fy + Math.cos(hFwd) * dSide,
                  skipTol: dSide < 1.0 ? 0.22 : 0.32,
                  speedLimit: dSide < 1.0 ? 0.65 : 1.0,
                },
              });
            }
            if (ang !== 0) {
              rescueSpecs.push({
                wp: {
                  x: fx + Math.sin(hRev) * dSide,
                  y: fy + Math.cos(hRev) * dSide,
                  reverse: true,
                  skipTol: dSide < 1.0 ? 0.22 : 0.30,
                  speedLimit: dSide < 1.0 ? 0.50 : 0.80,
                },
              });
            }
          }
        }
        const rescueOverBudget = () => rescueVerifyCount >= MAX_RESCUE_VERIFY;
        const tryVerifiedCandFast = (candRaw) => {
          const cand = applyCloseTargetAlign(candRaw);
          if (isFullRouteClear(cand)) return subdivideWaypoints(fx, fy, cand, 4.5);
          const candTight = throttleTurns(cand, 0.80, 0.25);
          if (isFullRouteClear(candTight)) return subdivideWaypoints(fx, fy, candTight, 4.5);
          if (lastFullFailInfo && Math.hypot(lastFullFailInfo.x - fx, lastFullFailInfo.y - fy) < 4.5 && Math.hypot(lastFullFailInfo.x - tx, lastFullFailInfo.y - ty) > 12.0) {
            return null;
          }
          if (needCloseTargetAlign && closeTargetDist < 0.85 && !opts._candSweep32) {
            const candSw = applyCloseTargetAlign(candRaw, { _candSweep32: true });
            if (isFullRouteClear(candSw)) return subdivideWaypoints(fx, fy, candSw, 4.5);
            const candSwTight = throttleTurns(candSw, 0.80, 0.25);
            if (isFullRouteClear(candSwTight)) return subdivideWaypoints(fx, fy, candSwTight, 4.5);
          }
          return null;
        };
        const firstGoal = route[0] ?? { x: tx, y: ty };
        const goalBearH = Math.atan2(firstGoal.x - fx, firstGoal.y - fy);
        const tightClearStraightStart = startMinDist < 0.85;
        const rescueGoalScore = (wp) => {
          const d = Math.hypot(wp.x - fx, wp.y - fy);
          const dir = Math.atan2(wp.x - fx, wp.y - fy);
          const dObsWp = minDistanceToObstacles(wp.x, wp.y, obstacles);
          const isStraightFwd = !wp.reverse && Math.abs(wrapPi(dir - opts.heading)) < 0.05;
          const isStraightRev = Boolean(wp.reverse) && Math.abs(wrapPi(dir - (opts.heading + Math.PI))) < 0.05;
          const clearExitBonus = (tightClearStraightStart && (isStraightFwd || isStraightRev) && d >= 1.45 && d <= 3.25 && dObsWp >= 0.85)
            ? (isStraightFwd ? -250 : -240)
            : (standDepartInfo && !wp.reverse && d >= 2.0 && dObsWp >= 1.4)
              ? -25
              : (startMinDist < 0.85 && nearContainerStart && dObsWp < 1.25 ? 105 : 0);
          return Math.round(d * 10) * 10 + clearExitBonus + (wp.reverse ? 3.5 : 0) + Math.abs(wrapPi(dir - goalBearH));
        };
        rescueSpecs.sort((a, b) => rescueGoalScore(a.wp) - rescueGoalScore(b.wp));
        const openStartSkip2Step = startMinDist >= 3.5 && arcClearFor(subdivideWaypoints(fx, fy, route, 4.5).slice(0, 4), true);
        const max1StepVerify = openStartSkip2Step ? 12 : 20;
        const seenEndPose1 = new Set();
        const seenSubKey = new Set();
        const valid1Step = [];
        let rescueFullSubCount = 0;
        for (const { wp: escWp } of rescueSpecs) {
          if (rescueOverBudget() || valid1Step.length >= max1StepVerify) break;
          if (minDistanceToObstacles(escWp.x, escWp.y, obstacles) < 0.64) continue;
          const escSegOk = startMinDist < 0.55
            ? checkSegClear(fx, fy, escWp.x, escWp.y, true, false)
            : (pathIsClear(fx, fy, escWp.x, escWp.y, obstacles, Math.min(pad, 0.55), startObs.size > 0 ? startObs : null) && checkZoneDBandSeg(fx, fy, escWp.x, escWp.y));
          if (!escSegOk) continue;
          const endPose = simEscapePose([escWp]);
          if (!endPose) continue;
          const poseKey1 = `${Math.round(endPose.x * 2)},${Math.round(endPose.y * 2)},${Math.round(wrapHeading(endPose.heading) * 4)}`;
          if (seenEndPose1.has(poseKey1)) continue;
          seenEndPose1.add(poseKey1);
          valid1Step.push({ escWp, endPose });
          const subPlan = findPath([endPose.x, endPose.y], [tx, ty], "agf", {
            ...opts,
            heading: endPose.heading,
            validateFullRoute: false,
            _skipCloseAlign: true,
            _skipSubdivide: needCloseTargetAlign,
            _noRescue: true,
          });
          const subKey = `${escWp.x.toFixed(1)},${escWp.y.toFixed(1)}|${subPlan.map((w) => `${w.x.toFixed(1)},${w.y.toFixed(1)}`).join(";")}`;
          if (seenSubKey.has(subKey)) continue;
          seenSubKey.add(subKey);
          rescueVerifyCount++;
          const verified = tryVerifiedCandFast([escWp, ...subPlan]);
          if (verified) return verified;
          const escDir = Math.atan2(escWp.x - fx, escWp.y - fy);
          const escDist = Math.hypot(escWp.x - fx, escWp.y - fy);
          const isClearStraightEsc = tightClearStraightStart &&
            escDist >= 1.45 &&
            escDist <= 3.25 &&
            Math.abs(wrapPi(escDir - (escWp.reverse ? opts.heading + Math.PI : opts.heading))) < 0.05 &&
            minDistanceToObstacles(escWp.x, escWp.y, obstacles) >= 0.85;
          if (
            rescueFullSubCount < 2 &&
            lastFullFailInfo &&
            (Math.hypot(lastFullFailInfo.x - fx, lastFullFailInfo.y - fy) >= 4.5 || isClearStraightEsc) &&
            (!needCloseTargetAlign || Math.hypot(lastFullFailInfo.x - tx, lastFullFailInfo.y - ty) < 20.0) &&
            !opts._candSweep32
          ) {
            rescueFullSubCount++;
            const fullSub = findPath([endPose.x, endPose.y], [tx, ty], "agf", {
              ...opts,
              heading: endPose.heading,
              validateFullRoute: true,
              _noRescue: true,
              _returnEmptyOnFail: true,
            });
            if (fullSub.length > 0) {
              const fullComb = [escWp, ...fullSub];
              if (isFullRouteClear(fullComb)) return subdivideWaypoints(fx, fy, fullComb, 4.5);
              const fullCombT = throttleTurns(fullComb, 0.80, 0.25);
              if (isFullRouteClear(fullCombT)) return subdivideWaypoints(fx, fy, fullCombT, 4.5);
            }
          }
        }
        if (!openStartSkip2Step && !rescueOverBudget()) {
          valid1Step.sort((a, b) => (a.escWp.reverse ? 0 : 1) - (b.escWp.reverse ? 0 : 1) || Math.hypot(a.escWp.x - fx, a.escWp.y - fy) - Math.hypot(b.escWp.x - fx, b.escWp.y - fy));
          const seenEndPose2 = new Set();
          for (let i = 0; i < Math.min(valid1Step.length, 5) && !rescueOverBudget(); i++) {
            const { escWp: w1, endPose: p1 } = valid1Step[i];
            for (const rev2 of [true, false]) {
              if (rescueOverBudget()) break;
              for (const ang2 of [0, -0.55, 0.55]) {
                if (rescueOverBudget()) break;
                const dir2 = rev2 ? p1.heading + Math.PI + ang2 : p1.heading + ang2;
                const w2 = {
                  x: p1.x + Math.sin(dir2) * 1.25,
                  y: p1.y + Math.cos(dir2) * 1.25,
                  ...(rev2 ? { reverse: true } : {}),
                  skipTol: 0.25,
                  speedLimit: 0.70,
                };
                if (minDistanceToObstacles(w2.x, w2.y, obstacles) < 0.72) continue;
                if (!pathIsClear(p1.x, p1.y, w2.x, w2.y, obstacles, Math.min(pad, 0.55)) || !checkZoneDBandSeg(p1.x, p1.y, w2.x, w2.y)) continue;
                const p2 = simEscapePose([w1, w2]);
                if (!p2) continue;
                const poseKey2 = `${Math.round(p2.x * 2)},${Math.round(p2.y * 2)},${Math.round(wrapHeading(p2.heading) * 4)}`;
                if (seenEndPose2.has(poseKey2)) continue;
                seenEndPose2.add(poseKey2);
                const subPlan2 = findPath([p2.x, p2.y], [tx, ty], "agf", {
                  ...opts,
                  heading: p2.heading,
                  validateFullRoute: false,
                  _skipCloseAlign: true,
                  _skipSubdivide: needCloseTargetAlign,
                  _noRescue: true,
                });
                const subKey2 = `${w1.x.toFixed(1)},${w1.y.toFixed(1)}|${w2.x.toFixed(1)},${w2.y.toFixed(1)}|${subPlan2.map((w) => `${w.x.toFixed(1)},${w.y.toFixed(1)}`).join(";")}`;
                if (seenSubKey.has(subKey2)) continue;
                seenSubKey.add(subKey2);
                rescueVerifyCount++;
                const verified2 = tryVerifiedCandFast([w1, w2, ...subPlan2]);
                if (verified2) return verified2;
              }
            }
          }
        }
        for (const revFine of [false, true]) {
          for (const angFine of [-0.10, 0.10, -0.20, 0.20]) {
            for (const dFine of [0.80, 1.35, 1.85]) {
              const hFine = revFine ? (opts.heading + Math.PI + angFine) : (opts.heading + angFine);
              const escWp = {
                x: fx + Math.sin(hFine) * dFine,
                y: fy + Math.cos(hFine) * dFine,
                ...(revFine ? { reverse: true } : {}),
                skipTol: dFine < 1.0 ? 0.22 : 0.30,
                speedLimit: revFine ? 0.80 : (dFine < 1.0 ? 0.65 : 0.90),
              };
              if (minDistanceToObstacles(escWp.x, escWp.y, obstacles) < 0.64) continue;
              const escSegOk = startMinDist < 0.55
                ? checkSegClear(fx, fy, escWp.x, escWp.y, true, false)
                : (pathIsClear(fx, fy, escWp.x, escWp.y, obstacles, Math.min(pad, 0.55), startObs.size > 0 ? startObs : null) && checkZoneDBandSeg(fx, fy, escWp.x, escWp.y));
              if (!escSegOk) continue;
              const endPose = simEscapePose([escWp]);
              if (!endPose) continue;
              const subPlan = findPath([endPose.x, endPose.y], [tx, ty], "agf", {
                ...opts,
                heading: endPose.heading,
                validateFullRoute: false,
                _skipCloseAlign: true,
                _skipSubdivide: needCloseTargetAlign,
                _noRescue: true,
              });
              const verified = tryVerifiedCandFast([escWp, ...subPlan]);
              if (verified) return verified;
            }
          }
        }
        if (checkAgfDeparture && startMinDist < 0.72 && !opts._noStandDrift) {
          const [rxS, ryS] = headingRight(opts.heading);
          const standDriftSeqs = [
            [{ x: fx - fHxStart * 2.6, y: fy - fHyStart * 2.6, reverse: true, skipTol: 0.15, speedLimit: 0.70, _stopAtWaypoint: true }],
            [{ x: fx - fHxStart * 3.0, y: fy - fHyStart * 3.0, reverse: true, skipTol: 0.15, speedLimit: 0.75, _stopAtWaypoint: true }],
          ];
          for (const latSign of [1, -1]) {
            standDriftSeqs.push([
              { x: fx - fHxStart * 2.6 + rxS * latSign * 0.05, y: fy - fHyStart * 2.6 + ryS * latSign * 0.05, reverse: true, skipTol: 0.15, speedLimit: 0.70, _stopAtWaypoint: true },
            ]);
            standDriftSeqs.push([
              { x: fx - fHxStart * 2.0 + rxS * latSign * 0.05, y: fy - fHyStart * 2.0 + ryS * latSign * 0.05, reverse: true, skipTol: 0.25, speedLimit: 0.70 },
              { x: fx - fHxStart * 4.0 + rxS * latSign * 0.30, y: fy - fHyStart * 4.0 + ryS * latSign * 0.30, reverse: true, skipTol: 0.25, speedLimit: 0.70 },
              { x: fx - fHxStart * 5.6 + rxS * latSign * 1.00, y: fy - fHyStart * 5.6 + ryS * latSign * 1.00, reverse: true, skipTol: 0.25, speedLimit: 0.80 },
            ]);
            standDriftSeqs.push([
              { x: fx - fHxStart * 2.0, y: fy - fHyStart * 2.0, reverse: true, skipTol: 0.20, speedLimit: 0.70 },
              { x: fx - fHxStart * 3.0, y: fy - fHyStart * 3.0, reverse: true, skipTol: 0.25, speedLimit: 0.70 },
              { x: fx - fHxStart * 3.6 + rxS * latSign * 1.30, y: fy - fHyStart * 3.6 + ryS * latSign * 1.30, reverse: true, skipTol: 0.25, speedLimit: 0.80 },
            ]);
          }
          for (let di = 0; di < standDriftSeqs.length; di++) {
            const seqD = standDriftSeqs[di];
            let segOk = true;
            let pxD = fx;
            let pyD = fy;
            for (let wi = 0; wi < seqD.length; wi++) {
              const wp = seqD[wi];
              if (minDistanceToObstacles(wp.x, wp.y, obstacles) < (wi === 0 ? 0.575 : 0.68)) {
                segOk = false;
                break;
              }
              const segClearD = wi === 0
                ? pathIsClear(pxD, pyD, wp.x, wp.y, obstacles, Math.min(pad, 0.55), startObs.size > 0 ? startObs : null)
                : pathIsClear(pxD, pyD, wp.x, wp.y, obstacles, Math.min(pad, 0.575));
              if (!segClearD) {
                segOk = false;
                break;
              }
              pxD = wp.x;
              pyD = wp.y;
            }
            if (!segOk) continue;
            const endPose = simEscapePose(seqD, 1000);
            if (!endPose) continue;
            const subPlan = findPath([endPose.x, endPose.y], [tx, ty], "agf", {
              ...opts,
              heading: endPose.heading,
              validateFullRoute: false,
              _skipCloseAlign: true,
              _skipSubdivide: needCloseTargetAlign,
              _noRescue: true,
              _allowTargetRescues: true,
            });
            const verified = tryVerifiedCandFast([...seqD, ...subPlan]);
            if (verified) return verified;
            const fullSub = findPath([endPose.x, endPose.y], [tx, ty], "agf", {
              ...opts,
              heading: endPose.heading,
              validateFullRoute: true,
              _noRescue: opts._noRescue || seqD.length > 1,
              _noStandDrift: true,
              _allowTargetRescues: true,
              _returnEmptyOnFail: true,
            });
            if (fullSub.length > 0) {
              const comb = [...seqD, ...fullSub];
              if (isFullRouteClear(comb)) return subdivideWaypoints(fx, fy, comb, 4.5);
              const combT = throttleTurns(comb, 0.80, 0.25);
              if (isFullRouteClear(combT)) return subdivideWaypoints(fx, fy, combT, 4.5);
            }
          }
        }
      }
      for (const fbCand of [tightThrottled, throttled, route]) {
        const fbSub = subdivideWaypoints(fx, fy, fbCand, 4.5);
        if (fbSub.length > 0 && (Number.isFinite(opts.targetHeading) || opts.targetDocking)) {
          const lastFb = fbSub[fbSub.length - 1];
          fbSub[fbSub.length - 1] = {
            ...lastFb,
            ...(Number.isFinite(opts.targetHeading) ? { heading: opts.targetHeading } : {}),
            ...(opts.targetDocking ? { docking: true } : {}),
          };
        }
        if (isAgfArcClear(
          {
            x: fx, y: fy, heading: opts.heading, speed: 0, steerAngleRad: 0,
            forkHeightM: AGF_EMPTY_TRANSIT_FORK_Z, sideShiftM: 0, mastTiltRad: 0,
            wheelSpinRad: 0, lidarSpinRad: 0,
            carriedWcid: opts.carriedWcid ?? 0,
            loaded: Boolean(opts.loaded || opts.carriedWcid),
          },
          fbSub, obstacles, AGF_SPECS.hullRadiusM, startMinDist,
          { maxSteps: 14000, speedScales: [1.0], requireArrival: true, endMinDist: minDistanceToObstacles(tx, ty, obstacles) },
        )) {
          return fbSub;
        }
      }
      if (!needCloseTargetAlign && mode === "agf" && opts.docking !== true && !opts._noRescue && !opts._candSweep32) {
        const sweepPlan = findPath([fx, fy], [tx, ty], "agf", {
          ...opts,
          validateFullRoute: true,
          _noRescue: true,
          _candSweep32: true,
          _returnEmptyOnFail: true,
        });
        if (sweepPlan.length > 0) return sweepPlan;
      }
      const nudged = tryTargetEdgeNudge();
      if (nudged) return nudged;
      if (!opts._rejectOnFail || opts._returnEmptyOnFail) return [];
      throw new Error(`AGF route unreachable from (${fx.toFixed(2)}, ${fy.toFixed(2)}) to (${tx.toFixed(2)}, ${ty.toFixed(2)})`);
    };

    // String-pull / shortcut clear corners from start and end
    let startIdx = 0;
    while (
      startIdx + 1 < nodePath.length &&
      !isAisleEntryNode(nodePath[startIdx]) &&
      !isZoneDBufNode(nodePath[startIdx]) &&
      !isZoneAPadCrossNode(nodePath[startIdx]) &&
      !isZoneDHwyNode(nodePath[startIdx]) &&
      !isZoneCStandPreNode(nodePath[startIdx]) &&
      checkZoneDBandSeg(fx, fy, nodePath[startIdx + 1].x, nodePath[startIdx + 1].y) &&
      pathIsClear(fx, fy, nodePath[startIdx + 1].x, nodePath[startIdx + 1].y, obstacles, pad, null, cornerTransitPad)
    ) {
      startIdx++;
    }
    let endIdx = nodePath.length - 1;
    while (
      endIdx - 1 >= startIdx &&
      !isAisleEntryNode(nodePath[endIdx]) &&
      !isZoneDBufNode(nodePath[endIdx]) &&
      !isZoneAPadCrossNode(nodePath[endIdx]) &&
      !isZoneDHwyNode(nodePath[endIdx]) &&
      !isZoneCStandPreNode(nodePath[endIdx]) &&
      checkZoneDBandSeg(nodePath[endIdx - 1].x, nodePath[endIdx - 1].y, tx, ty) &&
      pathIsClear(nodePath[endIdx - 1].x, nodePath[endIdx - 1].y, tx, ty, obstacles, pad, null, cornerTransitPad)
    ) {
      endIdx--;
    }

    const trimmed = nodePath.slice(startIdx, endIdx + 1);

    // Compare Dijkstra path length vs direct shortcut
    if (bestShortcut) {
      const dijkPts = [{ x: fx, y: fy }, ...trimmed.map((n) => ({ x: n.x, y: n.y })), { x: tx, y: ty }];
      let dijkLen = 0;
      for (let i = 0; i < dijkPts.length - 1; i++) {
        dijkLen += Math.hypot(dijkPts[i + 1].x - dijkPts[i].x, dijkPts[i + 1].y - dijkPts[i].y);
      }
      if (dijkPts.length >= 2 && Number.isFinite(opts.heading)) {
        const dijkTurn = Math.abs(wrapPi(Math.atan2(dijkPts[1].x - fx, dijkPts[1].y - fy) - opts.heading));
        dijkLen += dijkTurn * 3.0;
      }
      if (
        needArcCheck &&
        dijkPts.length >= 2 &&
        !arcClearFor(
          subdivideWaypoints(fx, fy, dijkPts.slice(1), 4.5).slice(0, useMultiWpArc ? 6 : 2),
          useMultiWpArc,
        )
      ) {
        dijkLen += 100.0;
      }
      if (enteringAisleFromOutside && trimmed.some(isAisleEntryNode)) {
        dijkLen += 2.5;
      }
      if (
        bestShortcutScore <= dijkLen ||
        trimmed.length === 0 ||
        !checkZoneDBandSeg(fx, fy, trimmed[0].x, trimmed[0].y) ||
        !checkZoneDBandSeg(trimmed[trimmed.length - 1].x, trimmed[trimmed.length - 1].y, tx, ty) ||
        !pathIsClear(fx, fy, trimmed[0].x, trimmed[0].y, obstacles, pad, null, cornerTransitPad) ||
        !pathIsClear(trimmed[trimmed.length - 1].x, trimmed[trimmed.length - 1].y, tx, ty, obstacles, pad, null, cornerTransitPad)
      ) {
        const scOut = [];
        for (let bi = 0; bi < bestShortcut.length; bi++) {
          const p = bestShortcut[bi];
          const dStart = Math.hypot(p.x - fx, p.y - fy);
          if ((p.reverse ? dStart > 0.05 : dStart > 0.35) && Math.hypot(p.x - tx, p.y - ty) > 0.35) {
            scOut.push({
              x: p.x,
              y: p.y,
              skipTol: p.skipTol ?? 0.45,
              ...(p.reverse !== undefined ? { reverse: p.reverse } : {}),
              ...(Number.isFinite(p.speedLimit) ? { speedLimit: p.speedLimit } : {}),
              ...(p._turnThrottle && Number.isFinite(p.speedLimit) ? { _turnThrottle: true } : {}),
              ...(p._noSubdivideSpeed && Number.isFinite(p.speedLimit) ? { _noSubdivideSpeed: true } : {}),
            });
          }
        }
        if (mode === "agf" && opts.laneOffset !== false && scOut.length >= 2) {
          for (let si = 0; si < scOut.length - 1; si++) {
            const a = scOut[si];
            const b = scOut[si + 1];
            if (
              Math.abs(a.x - westX) < 0.25 &&
              Math.abs(b.x - westX) < 0.25 &&
              !Number.isFinite(a.speedLimit) &&
              !Number.isFinite(b.speedLimit) &&
              a.y >= northY &&
              b.y >= northY &&
              Math.abs(b.y - a.y) > 4.0
            ) {
              const dir = b.y < a.y ? -1 : +1; // southbound -> west (-0.75), northbound -> east (+0.75)
              const shiftedX = westX + dir * 0.75;
              if (
                pathIsClear(si === 0 ? fx : scOut[si - 1].x, si === 0 ? fy : scOut[si - 1].y, shiftedX, a.y, obstacles, 0.55, null, cornerTransitPad) &&
                pathIsClear(shiftedX, a.y, shiftedX, b.y, obstacles, 0.55, null, cornerTransitPad)
              ) {
                a.x = shiftedX;
                if (!enteringAisleFromOutside) b.x = shiftedX;
              }
            }
          }
        }
        for (let si = 0; si < scOut.length; si++) {
          const p = scOut[si];
          if (p._turnThrottle && !p.reverse && Number.isFinite(p.speedLimit) && p.speedLimit >= 1.25) {
            const pA = si === 0 ? { x: fx, y: fy } : scOut[si - 1];
            const pB = si + 1 < scOut.length ? scOut[si + 1] : { x: tx, y: ty };
            const l1 = Math.hypot(p.x - pA.x, p.y - pA.y);
            const l2 = Math.hypot(pB.x - p.x, pB.y - p.y);
            if (l1 > 0.25 && l2 > 0.25) {
              const tr = Math.abs(wrapPi(Math.atan2(pB.x - p.x, pB.y - p.y) - Math.atan2(p.x - pA.x, p.y - pA.y)));
              if (tr < 0.45 && (si + 1 < scOut.length || l2 > 2.5)) {
                delete p.speedLimit;
                delete p._turnThrottle;
              }
            }
          }
        }
        scOut.push({ x: tx, y: ty });
        return finalizeAgfRoute(scOut);
      }
    }

    // Prepend 1- or 2-point corner-clearance bypass if first segment from (fx, fy) intersects an obstacle
    const rawPts = [{ x: fx, y: fy }];
    if (trimmed.length > 0 && !pathIsClear(fx, fy, trimmed[0].x, trimmed[0].y, obstacles, 0.55)) {
      const targetPt = trimmed[0];
      for (let i = 0; i < obstacles.length; i++) {
        const b = obstacles[i];
        if (!segmentIntersectsObstacle2D(fx, fy, targetPt.x, targetPt.y, b, 0.55)) continue;
        const margin = (mode === "agf" && (b.kind === "rack" || b.kind === "charger")) ? 2.4 : 1.6;
        const wideX = (mode === "agf" && (b.kind === "rack" || b.kind === "charger")) ? 2.8 : 2.4;
        const curH = Number.isFinite(opts.heading) ? opts.heading : null;
        const cw = (lx, ly) => (b.obb ? (() => { const [wx, wy] = localToWorld2D(lx, ly, b.obb.cx, b.obb.cy, b.obb.heading); return { x: wx, y: wy }; })() : { x: lx, y: ly });
        const xL = b.obb ? -b.obb.halfW : b.x0;
        const xR = b.obb ? b.obb.halfW : b.x1;
        const yB = b.obb ? -b.obb.halfL : b.y0;
        const yT = b.obb ? b.obb.halfL : b.y1;
        const singleCands = [
          [ cw(xL - margin, yB - margin) ],
          [ cw(xR + margin, yB - margin) ],
          [ cw(xL - margin, yT + margin) ],
          [ cw(xR + margin, yT + margin) ],
          [ cw(xL - wideX, yT - 1.2), cw(xL - margin, yB - margin) ],
          [ cw(xR + wideX, yT - 1.2), cw(xR + margin, yB - margin) ],
          [ cw(xL - wideX, yB + 1.2), cw(xL - margin, yT + margin) ],
          [ cw(xR + wideX, yB + 1.2), cw(xR + margin, yT + margin) ],
          [ cw(xL - margin, yT + margin), cw(xL - margin, yB - margin) ],
          [ cw(xR + margin, yT + margin), cw(xR + margin, yB - margin) ],
        ];
        let bestSeq = null;
        let bestScore = Infinity;
        const fallbackPad = Math.min(pad, 0.62);
        for (const seq of singleCands) {
          let ok = pathIsClear(fx, fy, seq[0].x, seq[0].y, obstacles, fallbackPad);
          if (ok && seq.length === 2) {
            ok = pathIsClear(seq[0].x, seq[0].y, seq[1].x, seq[1].y, obstacles, fallbackPad) &&
              pathIsClear(seq[1].x, seq[1].y, targetPt.x, targetPt.y, obstacles, fallbackPad);
          } else if (ok) {
            ok = pathIsClear(seq[0].x, seq[0].y, targetPt.x, targetPt.y, obstacles, fallbackPad);
          }
          if (!ok) continue;
          let len = Math.hypot(seq[0].x - fx, seq[0].y - fy);
          if (seq.length === 2) len += Math.hypot(seq[1].x - seq[0].x, seq[1].y - seq[0].y);
          const last = seq[seq.length - 1];
          len += Math.hypot(targetPt.x - last.x, targetPt.y - last.y);
          if (curH !== null) {
            const turn = Math.abs(wrapPi(Math.atan2(seq[0].x - fx, seq[0].y - fy) - curH));
            len += turn * 4.0;
          }
          if (len < bestScore) {
            bestScore = len;
            bestSeq = seq;
          }
        }
        if (bestSeq) {
          for (let si = 0; si < bestSeq.length; si++) {
            const pt = bestSeq[si];
            const dPt = Math.hypot(pt.x - fx, pt.y - fy);
            if (dPt > 0.6) {
              const turnFromStart = si === 0 && curH !== null
                ? Math.abs(wrapPi(Math.atan2(pt.x - fx, pt.y - fy) - curH))
                : 0;
              rawPts.push(dPt < 3.8 && turnFromStart > 1.1 ? { ...pt, speedLimit: 1.2 } : pt);
            }
          }
          break;
        }
      }
    }
    for (const n of trimmed) rawPts.push({ x: n.x, y: n.y });
    if (
      isZoneDTarget &&
      trimmed.length > 0 &&
      isZoneDHwyNode(trimmed[trimmed.length - 1]) &&
      Math.abs(tx - trimmed[trimmed.length - 1].x) > 0.35
    ) {
      if (isSouthOfChargers) {
        rawPts.push({ x: trimmed[trimmed.length - 1].x, y: ty, skipTol: 0.45 });
      } else {
        rawPts.push({ x: tx, y: zoneDHwyY, skipTol: 0.45 });
      }
    }
    if (rawPts.length > 1) {
      const endFrom = rawPts[rawPts.length - 1];
      if (!pathIsClear(endFrom.x, endFrom.y, tx, ty, obstacles, 0.55)) {
        for (let i = 0; i < obstacles.length; i++) {
          const b = obstacles[i];
          if (endObs.has(b)) continue;
          if (!segmentIntersectsObstacle2D(endFrom.x, endFrom.y, tx, ty, b, 0.55)) continue;
          const margin = (mode === "agf" && (b.kind === "rack" || b.kind === "charger")) ? 2.4 : 1.6;
          const wideX = (mode === "agf" && (b.kind === "rack" || b.kind === "charger")) ? 2.8 : 2.4;
          const cw = (lx, ly) => (b.obb ? (() => { const [wx, wy] = localToWorld2D(lx, ly, b.obb.cx, b.obb.cy, b.obb.heading); return { x: wx, y: wy }; })() : { x: lx, y: ly });
          const xL = b.obb ? -b.obb.halfW : b.x0;
          const xR = b.obb ? b.obb.halfW : b.x1;
          const yB = b.obb ? -b.obb.halfL : b.y0;
          const yT = b.obb ? b.obb.halfL : b.y1;
          const endCands = [
            [ cw(xL - margin, yB - margin) ],
            [ cw(xR + margin, yB - margin) ],
            [ cw(xL - margin, yT + margin) ],
            [ cw(xR + margin, yT + margin) ],
            [ cw(xL - wideX, yT - 1.2), cw(xL - margin, yB - margin) ],
            [ cw(xR + wideX, yT - 1.2), cw(xR + margin, yB - margin) ],
            [ cw(xL - wideX, yB + 1.2), cw(xL - margin, yT + margin) ],
            [ cw(xR + wideX, yB + 1.2), cw(xR + margin, yT + margin) ],
            [ cw(xL - margin, yT + margin), cw(xL - margin, yB - margin) ],
            [ cw(xR + margin, yT + margin), cw(xR + margin, yB - margin) ],
          ];
          let bestEndSeq = null;
          let bestEndScore = Infinity;
          const fallbackPad = Math.min(pad, 0.62);
          for (const seq of endCands) {
            let ok = pathIsClear(endFrom.x, endFrom.y, seq[0].x, seq[0].y, obstacles, fallbackPad);
            if (ok && seq.length === 2) {
              ok = pathIsClear(seq[0].x, seq[0].y, seq[1].x, seq[1].y, obstacles, fallbackPad) &&
                pathIsClear(seq[1].x, seq[1].y, tx, ty, obstacles, fallbackPad);
            } else if (ok) {
              ok = pathIsClear(seq[0].x, seq[0].y, tx, ty, obstacles, fallbackPad);
            }
            if (!ok) continue;
            let len = Math.hypot(seq[0].x - endFrom.x, seq[0].y - endFrom.y);
            if (seq.length === 2) len += Math.hypot(seq[1].x - seq[0].x, seq[1].y - seq[0].y);
            const last = seq[seq.length - 1];
            len += Math.hypot(tx - last.x, ty - last.y);
            if (len < bestEndScore) {
              bestEndScore = len;
              bestEndSeq = seq;
            }
          }
          if (bestEndSeq) {
            for (const pt of bestEndSeq) {
              if (Math.hypot(pt.x - endFrom.x, pt.y - endFrom.y) > 0.6 && Math.hypot(tx - pt.x, ty - pt.y) > 0.6) {
                rawPts.push(pt);
              }
            }
            break;
          }
        }
      }
    }
    rawPts.push({ x: tx, y: ty });
    // String-pull intermediate vertices to eliminate unnecessary zig-zags while staying clear of obstacles
    for (let iter = 0; iter < rawPts.length; iter++) {
      let removed = false;
      for (let i = 1; i < rawPts.length - 1; i++) {
        if (isAisleEntryNode(rawPts[i]) || isZoneDBufNode(rawPts[i]) || isZoneAPadCrossNode(rawPts[i]) || isZoneDHwyNode(rawPts[i]) || isZoneCStandPreNode(rawPts[i])) continue;
        if (i === 1 && needArcCheck && !arcClearFor(rawPts.slice(2, 4))) continue;
        if (
          checkZoneDBandSeg(rawPts[i - 1].x, rawPts[i - 1].y, rawPts[i + 1].x, rawPts[i + 1].y) &&
          pathIsClear(rawPts[i - 1].x, rawPts[i - 1].y, rawPts[i + 1].x, rawPts[i + 1].y, obstacles, pad, null, cornerTransitPad)
        ) {
          rawPts.splice(i, 1);
          removed = true;
          break;
        }
      }
      if (!removed) break;
    }
    if (enteringAisleFromOutside) {
      for (let i = 1; i < rawPts.length - 1; i++) {
        if (!isAisleEntryNode(rawPts[i])) continue;
        const side = Math.abs(rawPts[i].x - westX) < 0.25 ? "west" : "east";
        const suffix = buildAisleEntrySuffix(side, rawPts[i - 2]?.x ?? rawPts[i - 1].x, rawPts[i - 1].y);
        const chain = [rawPts[i - 1], ...suffix, rawPts[i + 1]];
        let ok = true;
        for (let ci = 0; ci < chain.length - 1; ci++) {
          if (!checkSegClear(chain[ci].x, chain[ci].y, chain[ci + 1].x, chain[ci + 1].y, i - 1 === 0 && ci === 0, i + 1 === rawPts.length - 1 && ci === chain.length - 2)) {
            ok = false;
            break;
          }
        }
        if (ok) {
          rawPts[i - 1] = { ...rawPts[i - 1], skipTol: rawPts[i - 1].skipTol ?? 0.45 };
          rawPts.splice(i, 1, ...suffix);
          i += suffix.length - 1;
        }
      }
    }
    if (
      needArcCheck &&
      rawPts.length >= 2 &&
      !arcClearFor(
        subdivideWaypoints(fx, fy, rawPts.slice(1), 4.5).slice(0, useMultiWpArc ? 6 : 2),
        useMultiWpArc,
      )
    ) {
      if (rackDepartInfo) {
        const { westPrefix: westPref, eastPrefix: eastPref, westAisleExit, eastAisleExit, obliquePrefixes } = buildRackDepartPrefixes();
        const prefPairs = rawPts[1].x < fx - 0.5
          ? [[westPref, westAisleExit]]
          : rawPts[1].x > fx + 0.5
            ? [[eastPref, eastAisleExit]]
            : [[westPref, westAisleExit], [eastPref, eastAisleExit]];
        for (const ob of obliquePrefixes) {
          const sameSideExit = ob.side === "east" ? eastAisleExit : westAisleExit;
          if (ob.side === "east" ? rawPts[1].x < fx - 0.5 : rawPts[1].x > fx + 0.5) {
            prefPairs.push([ob.pref, ob.revOppExit], [ob.pref, sameSideExit]);
          } else {
            prefPairs.push([ob.pref, sameSideExit], [ob.pref, ob.revOppExit]);
          }
        }
        for (const [pref, aisleExit] of prefPairs) {
          const last = pref[pref.length - 1];
          if (!pathIsClear(fx, fy, pref[0].x, pref[0].y, obstacles, pad)) continue;
          if (
            pathIsClear(last.x, last.y, rawPts[1].x, rawPts[1].y, obstacles, pad) &&
            arcClearFor([...pref, rawPts[1]])
          ) {
            rawPts.splice(1, 0, ...pref);
            break;
          }
          const exitChain = [last, ...aisleExit, rawPts[1]];
          let exitClear = true;
          for (let ei = 0; ei < exitChain.length - 1; ei++) {
            if (!pathIsClear(exitChain[ei].x, exitChain[ei].y, exitChain[ei + 1].x, exitChain[ei + 1].y, obstacles, pad)) {
              exitClear = false;
              break;
            }
          }
          if (exitClear && arcClearFor([...pref, ...aisleExit, rawPts[1]])) {
            rawPts.splice(1, 0, ...pref, ...aisleExit);
            break;
          }
        }
      } else {
        const [fHx, fHy] = headingForward(opts.heading);
        for (const revDist of [1.8, 2.5, 1.2]) {
          const revPt = { x: fx - fHx * revDist, y: fy - fHy * revDist, reverse: true, skipTol: 0.35 };
          if (
            pathIsClear(fx, fy, revPt.x, revPt.y, obstacles, pad) &&
            checkSegClear(revPt.x, revPt.y, rawPts[1].x, rawPts[1].y, false, rawPts.length <= 2) &&
            arcClearFor([revPt, rawPts[1]])
          ) {
            rawPts.splice(1, 0, revPt);
            break;
          }
        }
      }
    }
    // Apply subtle right-hand lane offset on long multi-edge corridors (> 8 m from destination) to prevent head-on deadlocks
    const out = [];
    for (let i = 1; i < rawPts.length - 1; i++) {
      const pPrev = rawPts[i - 1];
      const pCur = rawPts[i];
      const pNext = rawPts[i + 1];
      const segLen = Math.hypot(pNext.x - pPrev.x, pNext.y - pPrev.y);
      const distToDest = Math.hypot(tx - pCur.x, ty - pCur.y);
      let px = pCur.x;
      let py = pCur.y;
      const keepOnEntrySpine = enteringAisleFromOutside && (
        Number.isFinite(pNext.speedLimit) ||
        (Math.abs(pCur.y - targetAisleY) <= 5.5 && Math.abs(pCur.x - pNext.x) < 0.25 && (Math.abs(pCur.x - westX) < 0.25 || Math.abs(pCur.x - eastX) < 0.25))
      );
      if (
        segLen > 4.0 &&
        distToDest > 8.0 &&
        opts.laneOffset !== false &&
        !Number.isFinite(pCur.speedLimit) &&
        !pCur.reverse &&
        !keepOnEntrySpine &&
        !isZoneAPadCrossNode(pCur) &&
        !(isSouthOfChargers && (Math.abs(pCur.y - ty) < 0.35 || Math.abs(pCur.x - westX) < 0.5 || Math.abs(pCur.x - eastBypassX) < 0.5)) &&
        !(isSouthOfChargersStart && (pCur.y <= oy - 38.5 || Math.abs(pCur.x - westX) < 0.5 || Math.abs(pCur.x - eastBypassX) < 0.5))
      ) {
        const h = Math.atan2(pNext.x - pPrev.x, pNext.y - pPrev.y);
        const [rx, ry] = headingRight(h);
        const offset = mode === "agf" ? 0.75 : 0.55;
        const cx = px + rx * offset;
        const cy = py + ry * offset;
        if (
          pathIsClear(pPrev.x, pPrev.y, cx, cy, obstacles, 0.55, null, cornerTransitPad) &&
          pathIsClear(cx, cy, pNext.x, pNext.y, obstacles, 0.55, null, cornerTransitPad)
        ) {
          px = cx;
          py = cy;
        }
      }
      const dStartOut = Math.hypot(px - fx, py - fy);
      if ((pCur.reverse ? dStartOut > 0.05 : dStartOut > 0.35) && Math.hypot(px - tx, py - ty) > 0.35) {
        const padTurnLimit = isZoneAPadCrossNode(pCur) ? 1.5 : pCur.speedLimit;
        out.push({
          x: px,
          y: py,
          skipTol: pCur.skipTol ?? 0.45,
          ...(pCur.reverse !== undefined ? { reverse: pCur.reverse } : {}),
          ...(Number.isFinite(padTurnLimit) ? { speedLimit: padTurnLimit } : {}),
          ...(pCur._turnThrottle && Number.isFinite(padTurnLimit) ? { _turnThrottle: true } : {}),
          ...(pCur._noSubdivideSpeed && Number.isFinite(padTurnLimit) ? { _noSubdivideSpeed: true } : {}),
        });
      }
    }
    for (let oi = 0; oi < out.length; oi++) {
      const p = out[oi];
      if (p._turnThrottle && !p.reverse && Number.isFinite(p.speedLimit) && p.speedLimit >= 1.25) {
        const pPrevOut = oi === 0 ? { x: fx, y: fy } : out[oi - 1];
        const pNextOut = oi + 1 < out.length ? out[oi + 1] : { x: tx, y: ty };
        const l1 = Math.hypot(p.x - pPrevOut.x, p.y - pPrevOut.y);
        const l2 = Math.hypot(pNextOut.x - p.x, pNextOut.y - p.y);
        if (l1 > 0.25 && l2 > 0.25) {
          const tr = Math.abs(wrapPi(Math.atan2(pNextOut.x - p.x, pNextOut.y - p.y) - Math.atan2(p.x - pPrevOut.x, p.y - pPrevOut.y)));
          if (tr < 0.45 && (oi + 1 < out.length || l2 > 2.5)) {
            delete p.speedLimit;
            delete p._turnThrottle;
          }
        }
      }
    }
    out.push({ x: tx, y: ty });

    // Subdivide segments > 5 m so pure-pursuit lookahead stays <= 5 m and turns tightly around corners
    if (mode === "agf") {
      return finalizeAgfRoute(out);
    }
    return out;
  }

  function normalizeWaypointsInput(waypoints) {
    if (!Array.isArray(waypoints) || waypoints.length === 0) return null;
    const out = [];
    for (let i = 0; i < waypoints.length; i++) {
      const w = waypoints[i];
      if (Array.isArray(w) && w.length >= 2 && Number.isFinite(w[0]) && Number.isFinite(w[1])) {
        out.push({ x: w[0], y: w[1] });
      } else if (w && typeof w === "object" && Number.isFinite(w.x) && Number.isFinite(w.y)) {
        out.push({
          x: w.x,
          y: w.y,
          ...(Number.isFinite(w.heading) ? { heading: w.heading } : {}),
          ...(w.reverse !== undefined ? { reverse: w.reverse } : {}),
          ...(w.docking !== undefined ? { docking: w.docking } : {}),
          ...(Number.isFinite(w.speedLimit) ? { speedLimit: w.speedLimit } : {}),
          ...(w._turnThrottle ? { _turnThrottle: true } : {}),
          ...(w._noSubdivideSpeed ? { _noSubdivideSpeed: true } : {}),
        });
      } else {
        return null;
      }
    }
    return out.length > 0 ? out : null;
  }

  function resolveStandOrLift(standId) {
    if (stands.has(standId)) return { kind: "stand", handle: stands.get(standId) };
    if (liftTables.has(standId)) return { kind: "liftTable", handle: liftTables.get(standId) };
    return null;
  }

  function createOwnedGroundDeployable(wcid, pos, heading = 0) {
    const g = (0x79000000 + nextOwnedDeployableId++) >>> 0;
    const rootParent = worldRootOf();
    let model = null;
    if (THREE && rootParent) {
      model = mountStowedCargoModel(THREE, wcid, csmStateOf());
      if (model?.root) {
        model.root.position.set(pos[0], pos[1], pos[2] ?? 0);
        model.root.rotation.z = -heading;
        rootParent.add(model.root);
      }
    } else if (THREE) {
      const group = new THREE.Group();
      group.position.set(pos[0], pos[1], pos[2] ?? 0);
      group.rotation.z = -heading;
      model = { root: group, dispose() {} };
    }
    const entry = {
      guid: g,
      wcid,
      model,
      rawPos: [pos[0], pos[1], pos[2] ?? 0],
      last: { stowed: true, heading },
      lastSeenAt: simTimeSec,
      lastMsgAt: simTimeSec,
      standInHidden: false,
      seenInEm: false,
      localOnly: true,
    };
    deployables.set(g, entry);
    ownedDeployableGuids.add(g);
    return entry;
  }

  function removeDeployableEntryLocal(guid) {
    const g = guid >>> 0;
    const dEntry = deployables.get(g);
    if (!dEntry) return false;
    try {
      if (dEntry.model?.root?.parent) {
        dEntry.model.root.parent.remove(dEntry.model.root);
      }
      dEntry.model?.dispose?.();
    } catch (_) {}
    deployables.delete(g);
    ownedDeployableGuids.delete(g);
    return true;
  }

  function setStagingBayCargo(bayId, wcid) {
    const bay = stagingBays.get(bayId);
    if (!bay) return false;
    const nextWcid = Number.isFinite(wcid) && wcid > 0 ? Math.trunc(wcid) : 0;
    if (bay.visualModel) {
      try {
        if (bay.visualModel.root?.parent) bay.visualModel.root.parent.remove(bay.visualModel.root);
        bay.visualModel.dispose?.();
      } catch (_) {}
      bay.visualModel = null;
    }
    bay.carriedWcid = nextWcid;
    bay.occupied = nextWcid !== 0;
    if (nextWcid !== 0 && THREE) {
      const hr = ensureHubRoot();
      const model = mountStowedCargoModel(THREE, nextWcid, csmStateOf());
      if (model?.root) {
        model.root.position.set(bay.pos[0], bay.pos[1], bay.pos[2] ?? 0);
        model.root.rotation.z = -bay.heading;
        if (hr) hr.add(model.root);
        bay.visualModel = model;
      }
    }
    return true;
  }

  function setStagingBayHighlighted(bayId, state = null) {
    const bay = stagingBays.get(bayId);
    if (!bay) return false;
    const nextState = state && HIGHLIGHT_COLORS[state] ? state : null;
    if (bay.highlightState === nextState && (nextState === null ? !bay.highlightMesh : Boolean(bay.highlightMesh))) {
      return true;
    }
    bay.highlightState = nextState;
    if (bay.highlightMesh) {
      if (bay.highlightMesh.parent) bay.highlightMesh.parent.remove(bay.highlightMesh);
      disposeObjectSubtree(bay.highlightMesh);
      bay.highlightMesh = null;
    }
    if (!nextState || !THREE) {
      return true;
    }
    const hr = ensureHubRoot();
    if (!hr) return true;
    const geo = new THREE.BoxGeometry(PALLET_ENVELOPE_SPECS.width + 0.14, PALLET_ENVELOPE_SPECS.depth + 0.14, 0.08);
    const mat = new THREE.MeshBasicMaterial({
      color: HIGHLIGHT_COLORS[nextState],
      transparent: true,
      opacity: 0.35,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(bay.pos[0], bay.pos[1], (bay.pos[2] ?? 0) + 0.045);
    mesh.rotation.z = -bay.heading;
    hr.add(mesh);
    bay.highlightMesh = mesh;
    return true;
  }

  function clearHighlights() {
    if (highlightedLiftTableId) {
      const lt = liftTables.get(highlightedLiftTableId);
      try { lt?.setHighlighted?.(null); } catch (_) {}
      highlightedLiftTableId = null;
    }
    if (highlightedStagingBayId) {
      setStagingBayHighlighted(highlightedStagingBayId, null);
      highlightedStagingBayId = null;
    }
  }

  function buildHub(options = {}) {
    if (disposed) return null;
    if (built) clearHub();

    const origin = Array.isArray(options.origin) && options.origin.length >= 3
      ? options.origin
      : NE_FLATLAND_SITE.origin;
    const bayCount = Number.isInteger(options.bayCount) && options.bayCount > 0 ? options.bayCount : 8;

    layout = buildDefaultHubLayout(origin, { bayCount, includeRackRowSlots: true });
    const hr = ensureHubRoot();
    const csmState = csmStateOf();

    if (THREE && hr) {
      apronModel = buildConcreteApron(THREE, layout, { csmState });
      hr.add(apronModel.root);

      standGroup = buildTransferStandGroup(THREE, layout.stands, { origin: layout.origin, csmState });
      hr.add(standGroup.root);

      chargerGroup = buildChargingDockGroup(THREE, layout.chargers, { origin: layout.origin, csmState });
      hr.add(chargerGroup.root);
    }

    // Racks
    for (const rowDef of layout.rackRows) {
      let rowModel = null;
      if (THREE && hr) {
        rowModel = buildRackRow(THREE, { ...rowDef, csmState }, { csmState });
        rowModel.root.position.set(rowDef.pos[0], rowDef.pos[1], rowDef.pos[2]);
        rowModel.root.rotation.z = -rowDef.heading;
        hr.add(rowModel.root);
      }
      const localSlotFallback = new Map();
      const handle = {
        id: rowDef.id,
        rowId: rowDef.id,
        bayCount: rowDef.bayCount,
        tiers: rowDef.tiers,
        doubleSided: rowDef.doubleSided,
        faces: rowDef.faces,
        pos: [...rowDef.pos],
        heading: rowDef.heading,
        bounds: rowModel ? rowModel.bounds : rowDef.localBounds,
        worldBounds: rowDef.bounds,
        root: rowModel?.root ?? null,
        loadedSlots: rowModel ? rowModel.loadedSlots : localSlotFallback,
        loadSlot(bay, tier, side = 0, slotInBay = 0, wcid = 0) {
          if (rowModel) return rowModel.loadSlot(bay, tier, side, slotInBay, wcid);
          const sSide = rowDef.doubleSided && side === 1 ? 1 : 0;
          const key = `${sSide}:${bay}:${tier}:${slotInBay}`;
          if (!wcid) { localSlotFallback.delete(key); return null; }
          localSlotFallback.set(key, { bay, tier, side: sSide, slotInBay, wcid });
          return localSlotFallback.get(key);
        },
        unloadSlot(bay, tier, side = 0, slotInBay = 0) {
          if (rowModel) return rowModel.unloadSlot(bay, tier, side, slotInBay);
          const sSide = rowDef.doubleSided && side === 1 ? 1 : 0;
          return localSlotFallback.delete(`${sSide}:${bay}:${tier}:${slotInBay}`);
        },
        setHighlightedSlot(bay, tier, side = 0, slotInBay = 0, state = null) {
          return rowModel?.setHighlightedSlot?.(bay, tier, side, slotInBay, state) ?? null;
        },
        setCargoLodDistance(camPos) {
          return rowModel?.setCargoLodDistance?.(camPos);
        },
        getSlotWorldPos(bay, tier, side = 0, slotInBay = 0, outVec = null) {
          if (rowModel) return rowModel.getSlotWorldPos(bay, tier, side, slotInBay, outVec);
          const lp = computeRackSlotLocalPose(bay, tier, slotInBay, RACK_SPECS, { side, doubleSided: rowDef.doubleSided });
          const [wx, wy] = localToWorld2D(lp.x, lp.y, rowDef.pos[0], rowDef.pos[1], rowDef.heading);
          const wz = rowDef.pos[2] + lp.z;
          return outVec?.set ? outVec.set(wx, wy, wz) : { x: wx, y: wy, z: wz };
        },
        dispose() {
          rowModel?.dispose?.();
          localSlotFallback.clear();
        },
      };
      racks.set(rowDef.id, handle);
    }

    // Stands
    for (const stDef of layout.stands) {
      let carriedWcid = 0;
      const handle = {
        id: stDef.id,
        zone: stDef.zone,
        pos: [...stDef.pos],
        heading: stDef.heading,
        agfApproachPos: [...stDef.agfApproachPos],
        amrApproachPos: [...stDef.amrApproachPos],
        agfNodeId: stDef.agfNodeId,
        amrNodeId: stDef.amrNodeId,
        get carriedWcid() { return carriedWcid; },
        get cargoWcid() { return carriedWcid; },
        get wcid() { return carriedWcid; },
        setCargoWcid(nextWcid = 0) {
          const w = Number.isFinite(nextWcid) && nextWcid > 0 ? Math.trunc(nextWcid) : 0;
          carriedWcid = w;
          standGroup?.setSlotCargo?.(stDef.id, w);
          return w;
        },
        setHighlighted(state = null) {
          standGroup?.setHighlighted?.(stDef.id, state);
        },
      };
      stands.set(stDef.id, handle);
    }

    // Chargers
    for (const chDef of layout.chargers) {
      let mode = "ready";
      const handle = {
        id: chDef.id,
        pos: [...chDef.pos],
        heading: chDef.heading,
        dockPos: [...chDef.dockPos],
        approachPos: [...chDef.approachPos],
        dockNodeId: chDef.dockNodeId,
        get mode() { return mode; },
        setDockState(nextMode = "ready") {
          mode = String(nextMode || "ready");
          chargerGroup?.setDockState?.(chDef.id, mode);
        },
      };
      chargers.set(chDef.id, handle);
    }

    // Lift Tables
    for (const ltDef of layout.liftTables) {
      let ltModel = null;
      if (THREE && hr) {
        ltModel = buildScissorLiftTable(THREE, { csmState, heightM: 0.0, carriedWcid: 0, statusMode: "idle" });
        ltModel.root.position.set(ltDef.pos[0], ltDef.pos[1], ltDef.pos[2]);
        ltModel.root.rotation.z = -ltDef.heading;
        hr.add(ltModel.root);
      }
      const st = {
        id: ltDef.id,
        pos: [...ltDef.pos],
        x: ltDef.pos[0],
        y: ltDef.pos[1],
        z: ltDef.pos[2],
        heading: ltDef.heading,
        agfApproachPos: [ltDef.pos[0], ltDef.pos[1] + 2.05, ltDef.pos[2]],
        amrApproachPos: [ltDef.pos[0], ltDef.pos[1] - 1.65, ltDef.pos[2]],
        heightM: 0.0,
        targetHeightM: 0.0,
        moving: false,
        interlockBlocked: false,
        interlockReason: null,
        carriedWcid: 0,
        autoMode: false,
        autoPhase: "idle",
        statusMode: "idle",
        highlightState: null,
        jackNodeId: ltDef.jackNodeId,
        amrNodeId: ltDef.amrNodeId,
        pending: null, // { targetH, resolve, reject }
      };
      const handle = {
        id: st.id,
        pos: st.pos,
        x: st.x,
        y: st.y,
        z: st.z,
        heading: st.heading,
        agfApproachPos: st.agfApproachPos,
        amrApproachPos: st.amrApproachPos,
        model: ltModel,
        _state: st,
        get heightM() { return st.heightM; },
        set heightM(h) { handle.setHeightImmediate(h); },
        get carriedWcid() { return st.carriedWcid; },
        get cargoWcid() { return st.carriedWcid; },
        get autoMode() { return st.autoMode; },
        setHeightImmediate(h) {
          if (!Number.isFinite(h)) return st.heightM;
          const clamped = clamp(h, LIFT_TABLE_SPECS.loweredZ, LIFT_TABLE_SPECS.raisedZ);
          st.heightM = clamped;
          st.targetHeightM = clamped;
          st.moving = false;
          if (st.pending) {
            const p = st.pending;
            st.pending = null;
            if (Math.abs(clamped - p.targetH) <= 0.005) p.resolve(handle);
            else p.reject(new Error("Lift table overridden"));
          }
          ltModel?.update?.({ heightM: clamped });
          return clamped;
        },
        setCargoWcid(wcid = 0) {
          const w = Number.isFinite(wcid) && wcid > 0 ? Math.trunc(wcid) : 0;
          st.carriedWcid = w;
          if (st.autoMode) {
            st.autoPhase = w !== 0 ? "wait_jack_clear" : "wait_amr_clear";
          }
          ltModel?.setCargoWcid?.(w);
          return w;
        },
        setHighlighted(state = null) {
          const nextState = state ?? null;
          if (st.highlightState === nextState) return;
          st.highlightState = nextState;
          ltModel?.setHighlighted?.(nextState);
        },
        setAutoMode(v) {
          st.autoMode = Boolean(v);
          if (!st.autoMode) st.autoPhase = "idle";
          else if (st.carriedWcid !== 0 && st.heightM < LIFT_TABLE_SPECS.raisedZ - 0.005) st.autoPhase = "wait_jack_clear";
          else if (st.carriedWcid === 0 && st.heightM > 0.005) st.autoPhase = "wait_amr_clear";
        },
        raise() {
          if (disposed || !built) return Promise.reject(new Error("Warehouse hub not built"));
          if (st.heightM >= LIFT_TABLE_SPECS.raisedZ - 0.005) {
            st.targetHeightM = LIFT_TABLE_SPECS.raisedZ;
            return Promise.resolve(handle);
          }
          if (st.pending) {
            st.pending.reject(new Error("Lift table command superseded"));
            st.pending = null;
          }
          return new Promise((resolve, reject) => {
            st.targetHeightM = LIFT_TABLE_SPECS.raisedZ;
            st.pending = { targetH: LIFT_TABLE_SPECS.raisedZ, resolve, reject };
          });
        },
        lower() {
          if (disposed || !built) return Promise.reject(new Error("Warehouse hub not built"));
          if (st.heightM <= LIFT_TABLE_SPECS.loweredZ + 0.005) {
            st.targetHeightM = LIFT_TABLE_SPECS.loweredZ;
            return Promise.resolve(handle);
          }
          if (st.pending) {
            st.pending.reject(new Error("Lift table command superseded"));
            st.pending = null;
          }
          return new Promise((resolve, reject) => {
            st.targetHeightM = LIFT_TABLE_SPECS.loweredZ;
            st.pending = { targetH: LIFT_TABLE_SPECS.loweredZ, resolve, reject };
          });
        },
      };
      liftTables.set(ltDef.id, handle);
    }

    // Staging Bays
    for (const sb of layout.stagingBays) {
      stagingBays.set(sb.id, {
        id: sb.id,
        row: sb.row,
        col: sb.col,
        pos: [...sb.pos],
        x: sb.pos[0],
        y: sb.pos[1],
        z: sb.pos[2],
        heading: sb.heading,
        width: sb.width,
        depth: sb.depth,
        approachNodeId: sb.approachNodeId,
        occupied: false,
        carriedWcid: 0,
        visualModel: null,
        highlightMesh: null,
        highlightState: null,
      });
    }

    if (options.populateDemoCargo) {
      const r0 = racks.get("R1");
      if (r0) {
        for (let i = 0; i < ALL_CARGO_WCIDS.length; i++) {
          r0.loadSlot(i % r0.bayCount, Math.floor(i / r0.bayCount) % 4, 0, i % 2, ALL_CARGO_WCIDS[i]);
        }
      }
    }

    built = true;
    return layout;
  }

  function removeAgf(id) {
    const entry = agfEntries.get(id);
    if (!entry) return;
    rejectPendingList(entry.queue, `AGF ${id} removed`);
    grid.release(`agf:${id}`);
    try { logisticsAudio?.updateAgvHum?.(id, { active: false }); } catch (_) {}
    try { logisticsAudio?.mastHydraulicWhine?.(id, { active: false }); } catch (_) {}
    if (entry.model) {
      try {
        if (entry.model.root?.parent) entry.model.root.parent.remove(entry.model.root);
        entry.model.dispose?.();
      } catch (_) {}
    }
    agfEntries.delete(id);
    agfs.delete(id);
  }

  function removeAmr(id) {
    const entry = amrEntries.get(id);
    if (!entry) return;
    rejectPendingList(entry.queue, `AMR ${id} removed`);
    grid.release(`amr:${id}`);
    try { logisticsAudio?.updateAgvHum?.(id, { active: false }); } catch (_) {}
    if (entry.model) {
      try {
        if (entry.model.root?.parent) entry.model.root.parent.remove(entry.model.root);
        entry.model.dispose?.();
      } catch (_) {}
    }
    amrEntries.delete(id);
    amrs.delete(id);
  }

  function clearHub() {
    stopScenarios();
    clearHighlights();

    for (const id of [...agfEntries.keys()]) removeAgf(id);
    for (const id of [...amrEntries.keys()]) removeAmr(id);

    for (const lt of liftTables.values()) {
      if (lt._state?.pending) {
        try { lt._state.pending.reject(new Error("Hub cleared")); } catch (_) {}
        lt._state.pending = null;
      }
      try { lt.model?.dispose?.(); } catch (_) {}
    }
    liftTables.clear();

    for (const sb of stagingBays.values()) {
      setStagingBayCargo(sb.id, 0);
      setStagingBayHighlighted(sb.id, null);
    }
    stagingBays.clear();

    for (const r of racks.values()) {
      try { r.dispose?.(); } catch (_) {}
    }
    racks.clear();
    stands.clear();
    chargers.clear();

    try { standGroup?.dispose?.(); } catch (_) {}
    standGroup = null;
    try { chargerGroup?.dispose?.(); } catch (_) {}
    chargerGroup = null;
    try { apronModel?.dispose?.(); } catch (_) {}
    apronModel = null;

    for (const g of [...ownedDeployableGuids]) {
      removeDeployableEntryLocal(g);
    }
    ownedDeployableGuids.clear();

    if (hubRoot) {
      disposeObjectSubtree(hubRoot);
      detachHubRoot();
    }

    grid.clear();
    layout = null;
    built = false;
  }

  function spawnAgf(id, options = {}) {
    if (disposed) return null;
    const key = String(id);
    if (agfs.has(key)) removeAgf(key);

    const hr = ensureHubRoot();
    const ox = layout?.origin?.[0] ?? NE_FLATLAND_SITE.origin[0];
    const oy = layout?.origin?.[1] ?? NE_FLATLAND_SITE.origin[1];
    const pos = Array.isArray(options.pos) ? options.pos : [ox, oy + 18, 0];
    const heading = finiteOr(options.heading, 0);
    const carriedWcid = Number.isFinite(options.carriedWcid) && options.carriedWcid > 0 ? Math.trunc(options.carriedWcid) : 0;
    const supportSurfaceZ = finiteOr(options.supportSurfaceZ, 0);
    const minCarriedForkZ = supportSurfaceZ + AGF_CARRIED_FORK_CLEARANCE_M;
    const forkHeightM = Number.isFinite(options.forkHeightM)
      ? (carriedWcid ? Math.max(options.forkHeightM, minCarriedForkZ) : options.forkHeightM)
      : (carriedWcid ? Math.max(AGF_CARRIED_TRANSIT_FORK_Z, minCarriedForkZ) : AGF_EMPTY_TRANSIT_FORK_Z);

    let model = null;
    if (THREE) {
      model = buildAgfForklift(THREE, {
        csmState: csmStateOf(),
        bodyHex: options.bodyHex ?? 0xe85a10,
        forkHeightM,
        carriedWcid,
        supportSurfaceZ,
        statusMode: "idle",
      });
      model.root.position.set(finiteOr(pos[0], ox), finiteOr(pos[1], oy), finiteOr(pos[2], 0));
      model.root.rotation.z = -heading;
      if (hr) hr.add(model.root);
    }

    const st = {
      agentId: `agf:${key}`,
      x: finiteOr(pos[0], ox),
      y: finiteOr(pos[1], oy),
      z: finiteOr(pos[2], 0),
      heading: wrapHeading(heading),
      speed: 0,
      steerAngleRad: 0,
      forkHeightM,
      sideShiftM: 0,
      mastTiltRad: 0,
      wheelSpinRad: 0,
      lidarSpinRad: 0,
      carriedWcid,
      loaded: carriedWcid !== 0,
      supportSurfaceZ,
      waypointIndex: 0,
      statusMode: "idle",
      yieldStopped: false,
      yieldSlowed: false,
      stuckTime: 0,
      prevStatusMode: "idle",
    };

    grid.claim(st.agentId, { x: st.x, y: st.y, heading: st.heading, radius: AGF_SPECS.hullRadiusM, kind: "agf" });

    const entry = {
      id: key,
      state: st,
      model,
      queue: [],
    };

    const handle = {
      id: key,
      model,
      root: model?.root ?? null,
      get x() { return st.x; },
      get y() { return st.y; },
      get z() { return st.z; },
      get pos() { return [st.x, st.y, st.z]; },
      get heading() { return st.heading; },
      get forkHeightM() { return st.forkHeightM; },
      get carriedWcid() { return st.carriedWcid; },
      get statusMode() { return st.statusMode; },
      get queueLength() { return entry.queue.length; },
      enqueue(task) {
        if (disposed) return Promise.reject(new Error("WarehouseManager disposed"));
        if (!task || typeof task !== "object" || !task.type) {
          return Promise.reject(new Error("Invalid AGF task"));
        }
        return new Promise((resolve, reject) => {
          entry.queue.push({
            task: { ...task },
            resolve,
            reject,
            initialized: false,
            phase: "init",
            data: null,
          });
        });
      },
    };
    entry.handle = handle;
    agfEntries.set(key, entry);
    agfs.set(key, handle);
    return handle;
  }

  function spawnAmr(id, options = {}) {
    if (disposed) return null;
    const key = String(id);
    if (amrs.has(key)) removeAmr(key);

    const hr = ensureHubRoot();
    const ox = layout?.origin?.[0] ?? NE_FLATLAND_SITE.origin[0];
    const oy = layout?.origin?.[1] ?? NE_FLATLAND_SITE.origin[1];
    const pos = Array.isArray(options.pos) ? options.pos : [ox, oy - 24, 0];
    const heading = finiteOr(options.heading, 0);
    const carriedWcid = Number.isFinite(options.carriedWcid) && options.carriedWcid > 0 ? Math.trunc(options.carriedWcid) : 0;
    const liftHeightM = Number.isFinite(options.liftHeightM)
      ? clamp(options.liftHeightM, AMR_SPECS.loweredHeightM, AMR_SPECS.raisedHeightM)
      : (carriedWcid ? AMR_SPECS.raisedHeightM : AMR_SPECS.loweredHeightM);

    let model = null;
    if (THREE) {
      model = buildAmrUnderride(THREE, {
        csmState: csmStateOf(),
        hullHex: options.hullHex ?? 0x3e454e,
        liftHeightM,
        carriedWcid,
        statusMode: "idle",
      });
      model.root.position.set(finiteOr(pos[0], ox), finiteOr(pos[1], oy), finiteOr(pos[2], 0));
      model.root.rotation.z = -heading;
      if (hr) hr.add(model.root);
    }

    const st = {
      agentId: `amr:${key}`,
      x: finiteOr(pos[0], ox),
      y: finiteOr(pos[1], oy),
      z: finiteOr(pos[2], 0),
      heading: wrapHeading(heading),
      speed: 0,
      omega: 0,
      liftHeightM,
      turntableYawRad: 0,
      heldCargoHeading: wrapHeading(heading),
      wheelSpinL: 0,
      wheelSpinR: 0,
      carriedWcid,
      loaded: carriedWcid !== 0,
      waypointIndex: 0,
      statusMode: "idle",
      charging: false,
      dockedChargerId: null,
      yieldStopped: false,
      yieldSlowed: false,
      stuckTime: 0,
      prevStatusMode: "idle",
    };

    grid.claim(st.agentId, { x: st.x, y: st.y, heading: st.heading, radius: AMR_SPECS.hullRadiusM, kind: "amr" });

    const entry = {
      id: key,
      state: st,
      model,
      queue: [],
    };

    const handle = {
      id: key,
      model,
      root: model?.root ?? null,
      get x() { return st.x; },
      get y() { return st.y; },
      get z() { return st.z; },
      get pos() { return [st.x, st.y, st.z]; },
      get heading() { return st.heading; },
      get liftHeightM() { return st.liftHeightM; },
      get turntableYawRad() { return st.turntableYawRad; },
      get carriedWcid() { return st.carriedWcid; },
      get statusMode() { return st.statusMode; },
      get queueLength() { return entry.queue.length; },
      enqueue(task) {
        if (disposed) return Promise.reject(new Error("WarehouseManager disposed"));
        if (!task || typeof task !== "object" || !task.type) {
          return Promise.reject(new Error("Invalid AMR task"));
        }
        return new Promise((resolve, reject) => {
          entry.queue.push({
            task: { ...task },
            resolve,
            reject,
            initialized: false,
            phase: "init",
            data: null,
          });
        });
      },
    };
    entry.handle = handle;
    amrEntries.set(key, entry);
    amrs.set(key, handle);
    return handle;
  }

  function buildContainerApproachRoute(agfState, cEntry, slotLocalX = 0) {
    const pos = containerWorldPos(cEntry);
    const ch = cEntry.heading || 0;
    const spec = resolveContainerLogisticsSpec(cEntry.kind);
    const env = resolveContainerEnvelopeSpec(cEntry);
    const doorApproachLocal = [slotLocalX, -(spec.interior.halfL + 0.85)];
    const [dx, dy] = localToWorld2D(doorApproachLocal[0], doorApproachLocal[1], pos[0], pos[1], ch);
    const preDoorLocal = [slotLocalX, -(env.halfExtL + 2.55)];
    const [pdx, pdy] = localToWorld2D(preDoorLocal[0], preDoorLocal[1], pos[0], pos[1], ch);

    const doorApproachWp = { x: dx, y: dy, heading: wrapHeading(ch) };
    const preDoorWp = { x: pdx, y: pdy, skipTol: 0.35 };
    const otherObstacles = getStaticObstacles({ ignoreContainerGuid: cEntry.guid });
    const allObstacles = getStaticObstacles();
    const startOtherDist = minDistanceToObstacles(agfState.x, agfState.y, otherObstacles);
    const startAllDist = minDistanceToObstacles(agfState.x, agfState.y, allObstacles);

    const hullCorners = AGF_HULL_CORNERS;
    let startMinExtWall = Infinity;
    for (let i = 0; i < hullCorners.length; i++) {
      const [wx, wy] = localToWorld2D(hullCorners[i][0], hullCorners[i][1], agfState.x, agfState.y, agfState.heading);
      const cl = worldToLocalPoint(wx, wy, pos[0], pos[1], ch);
      const cx = clamp(cl.x, -env.halfExtW, env.halfExtW);
      const cy = clamp(cl.y, -env.halfExtL, env.halfExtL);
      const d = Math.hypot(cl.x - cx, cl.y - cy);
      if (d < startMinExtWall) startMinExtWall = d;
    }

    const routeForkTargetZ = agfState.carriedWcid
      ? Math.max(AGF_CARRIED_TRANSIT_FORK_Z, spec.interior.floorZ + AGF_CARRIED_FORK_CLEARANCE_M)
      : 0.227;

    const validateWorldRoute = (worldWps, { checkPathClear = true, maxDockYawRad = Infinity } = {}) => {
      if (!Array.isArray(worldWps) || worldWps.length === 0) return null;
      if (checkPathClear) {
        const checkPts = [{ x: agfState.x, y: agfState.y }, ...worldWps, doorApproachWp];
        const otherPad = Math.min(0.72, Math.max(0.15, startOtherDist - 0.02));
        for (let i = 0; i < checkPts.length - 1; i++) {
          const segPad = i === 0 ? otherPad : 0.72;
          if (!pathIsClear(checkPts[i].x, checkPts[i].y, checkPts[i + 1].x, checkPts[i + 1].y, otherObstacles, segPad)) {
            return null;
          }
        }
      }
      const rollRoute = [...worldWps, doorApproachWp];
      const rollWps = subdivideWaypoints(agfState.x, agfState.y, rollRoute, 4.5);
      let steps60 = 0;
      for (const dtSim of [1 / 60, 1 / 30]) {
        const maxSteps = dtSim < 0.025 ? 4500 : 2250;
        let sim = {
          x: agfState.x,
          y: agfState.y,
          heading: agfState.heading,
          speed: 0,
          steerAngleRad: agfState.steerAngleRad ?? 0,
          forkHeightM: agfState.forkHeightM ?? AGF_EMPTY_TRANSIT_FORK_Z,
          sideShiftM: agfState.sideShiftM ?? 0,
          mastTiltRad: agfState.mastTiltRad ?? 0,
          wheelSpinRad: agfState.wheelSpinRad ?? 0,
          lidarSpinRad: agfState.lidarSpinRad ?? 0,
          carriedWcid: agfState.carriedWcid ?? 0,
          loaded: Boolean(agfState.carriedWcid),
        };
        let wpIdx = 0;
        let clearedAll = startAllDist >= AGF_SPECS.hullRadiusM + 0.04;
        const minAllowStart = Math.max(0.05, Math.min(startAllDist - 0.02, AGF_SPECS.hullRadiusM + 0.04));
        let arrived = false;
        for (let step = 0; step < maxSteps; step++) {
          const simCmd = {
            waypoints: rollWps,
            waypointIndex: wpIdx,
            targetForkHeightM: routeForkTargetZ,
          };
          sim = stepAgfKinematics(sim, simCmd, dtSim, {});
          wpIdx = sim.waypointIndex;
          while (wpIdx < rollWps.length - 1) {
            const wp = rollWps[wpIdx];
            const skipTol = Number.isFinite(wp?.skipTol) ? wp.skipTol : (wp?.speedLimit ? 0.50 : 1.25);
            if (wp && Math.hypot(wp.x - sim.x, wp.y - sim.y) <= skipTol && !wp.docking) {
              wpIdx++;
            } else {
              break;
            }
          }
          if (
            Number.isFinite(maxDockYawRad) &&
            wpIdx >= rollWps.length - 1 &&
            Math.hypot(doorApproachWp.x - sim.x, doorApproachWp.y - sim.y) <= 1.20 &&
            Math.abs(wrapPi(sim.heading - ch)) > maxDockYawRad
          ) {
            return null;
          }
          if (
            agfState.carriedWcid &&
            wpIdx >= rollWps.length - 1 &&
            Math.hypot(doorApproachWp.x - sim.x, doorApproachWp.y - sim.y) <= 1.50
          ) {
            const cLoc = worldToLocalPoint(sim.x, sim.y, pos[0], pos[1], ch);
            if (
              cLoc.y >= -(env.halfExtL + 2.20) &&
              (Math.abs(cLoc.x) + AMR_PALLET_HALF_W >= spec.interior.halfW - 0.02 || Math.abs(wrapPi(sim.heading - ch)) >= 0.12)
            ) {
              return null;
            }
          }
          const dAll = minDistanceToObstacles(sim.x, sim.y, allObstacles);
          if (dAll >= AGF_SPECS.hullRadiusM + 0.04) clearedAll = true;
          if (dAll < (clearedAll ? AGF_SPECS.hullRadiusM + 0.04 : minAllowStart)) return null;
          for (let ci = 0; ci < hullCorners.length; ci++) {
            const [wx, wy] = localToWorld2D(hullCorners[ci][0], hullCorners[ci][1], sim.x, sim.y, sim.heading);
            if (startMinExtWall > 0.02) {
              const cl = worldToLocalPoint(wx, wy, pos[0], pos[1], ch);
              if (Math.abs(cl.x) < env.halfExtW && Math.abs(cl.y) < env.halfExtL) {
                const isForkTip = ci >= 4;
                const onFinalDoorLeg = wpIdx >= rollWps.length - 1;
                const inOpenDoorway =
                  Math.abs(cl.x) < spec.interior.halfW - 0.12 &&
                  cl.y < -env.halfExtL + 0.90 &&
                  Math.abs(wrapPi(sim.heading - ch)) < 0.10;
                if (!(isForkTip && onFinalDoorLeg && inOpenDoorway)) {
                  return null;
                }
              }
            }
            for (let oi = 0; oi < otherObstacles.length; oi++) {
              const ob = otherObstacles[oi];
              if (ob?.kind === "container" && ob.obb) {
                const ol = worldToLocalPoint(wx, wy, ob.obb.cx, ob.obb.cy, ob.obb.heading);
                if (Math.abs(ol.x) < ob.obb.halfW - 0.04 && Math.abs(ol.y) < ob.obb.halfL - 0.04) {
                  return null;
                }
              }
            }
          }
          if (sim.arrived) {
            arrived = true;
            if (dtSim < 0.025) steps60 = step + 1;
            break;
          }
        }
        if (!arrived) return null;
      }
      return { worldWps, steps: steps60 };
    };

    const validateCandidateRoute = (localWps) => {
      if (!Array.isArray(localWps) || localWps.length === 0) return null;
      const worldWps = localWps.map((w) => {
        const [wx, wy] = localToWorld2D(w.x, w.y, pos[0], pos[1], ch);
        return {
          x: wx,
          y: wy,
          skipTol: w.skipTol ?? 0.35,
          ...(w.reverse !== undefined ? { reverse: w.reverse } : {}),
          ...(Number.isFinite(w.speedLimit) ? { speedLimit: w.speedLimit } : {}),
          ...(w._turnThrottle ? { _turnThrottle: true } : {}),
          ...(w._noSubdivideSpeed ? { _noSubdivideSpeed: true } : {}),
        };
      });
      return validateWorldRoute(worldWps, { checkPathClear: true, maxDockYawRad: 0.087 });
    };

    const outerAlign34Local = [slotLocalX, -(env.halfExtL + 3.4)];
    const [oa34x, oa34y] = localToWorld2D(outerAlign34Local[0], outerAlign34Local[1], pos[0], pos[1], ch);
    const outerAlign44Local = [slotLocalX, -(env.halfExtL + 4.4)];
    const [oa44x, oa44y] = localToWorld2D(outerAlign44Local[0], outerAlign44Local[1], pos[0], pos[1], ch);
    const outerAlign54Local = [slotLocalX, -(env.halfExtL + 5.4)];
    const [oa54x, oa54y] = localToWorld2D(outerAlign54Local[0], outerAlign54Local[1], pos[0], pos[1], ch);
    const gateAlignLocal = [slotLocalX, -(env.halfExtL + 1.65)];
    const [gax, gay] = localToWorld2D(gateAlignLocal[0], gateAlignLocal[1], pos[0], pos[1], ch);
    const buildAlignedFindPathRoute = () => {
      const fastVariants = [];
      const slowVariants = [];
      const fpOpts = { heading: agfState.heading, containerCornerPad: 2.05 };
      const fp34 = findPath([agfState.x, agfState.y], [oa34x, oa34y], "agf", fpOpts);
      if (fp34.length > 0) {
        const w34Fast = fp34.slice();
        w34Fast[w34Fast.length - 1] = { ...w34Fast[w34Fast.length - 1], skipTol: 0.25 };
        w34Fast.push({ x: pdx, y: pdy, skipTol: 0.20 });
        fastVariants.push(w34Fast);

        const w34Med = fp34.slice();
        w34Med[w34Med.length - 1] = { ...w34Med[w34Med.length - 1], skipTol: 0.25 };
        w34Med.push(
          { x: pdx, y: pdy, skipTol: 0.20 },
          { x: gax, y: gay, skipTol: 0.25, speedLimit: 0.9 },
        );
        slowVariants.push(w34Med);

        const w34Slow = fp34.slice();
        w34Slow[w34Slow.length - 1] = { ...w34Slow[w34Slow.length - 1], skipTol: 0.20 };
        w34Slow.push(
          { x: pdx, y: pdy, skipTol: 0.15 },
          { x: gax, y: gay, skipTol: 0.25, speedLimit: 0.45 },
        );
        slowVariants.push(w34Slow);
      }
      const locAgfPre = worldToLocalPoint(agfState.x, agfState.y, pos[0], pos[1], ch);
      const sidePreSign = locAgfPre.x >= 0 ? 1 : -1;
      for (const [latOff, fwdOff, vOa, vPd, vGa] of [
        [0.95, 3.70, 2.4, 1.6, 1.00],
        [1.15, 3.80, 2.3, 1.5, 0.95],
        [1.50, 4.00, 2.1, 1.4, 0.85],
      ]) {
        const [preX, preY] = localToWorld2D(slotLocalX + sidePreSign * latOff, -(env.halfExtL + fwdOff), pos[0], pos[1], ch);
        const fpPre = findPath([agfState.x, agfState.y], [preX, preY], "agf", fpOpts);
        if (fpPre.length > 0) {
          const wPre = fpPre.slice();
          wPre[wPre.length - 1] = { ...wPre[wPre.length - 1], skipTol: 0.32 };
          wPre.push(
            { x: oa34x, y: oa34y, skipTol: 0.25, speedLimit: vOa },
            { x: pdx, y: pdy, skipTol: 0.20, speedLimit: vPd },
            { x: gax, y: gay, skipTol: 0.14, speedLimit: vGa },
          );
          slowVariants.push(wPre);
        }
      }
      const fp44 = findPath([agfState.x, agfState.y], [oa44x, oa44y], "agf", fpOpts);
      if (fp44.length > 0) {
        const w44Fast = fp44.slice();
        w44Fast[w44Fast.length - 1] = { ...w44Fast[w44Fast.length - 1], skipTol: 0.25 };
        w44Fast.push(
          { x: oa34x, y: oa34y, skipTol: 0.25 },
          { x: pdx, y: pdy, skipTol: 0.20 },
        );
        fastVariants.push(w44Fast);

        const w44Med = fp44.slice();
        w44Med[w44Med.length - 1] = { ...w44Med[w44Med.length - 1], skipTol: 0.30 };
        w44Med.push(
          { x: oa34x, y: oa34y, skipTol: 0.25, speedLimit: 1.2 },
          { x: pdx, y: pdy, skipTol: 0.25, speedLimit: 0.9 },
          { x: gax, y: gay, skipTol: 0.25, speedLimit: 0.65 },
        );
        slowVariants.push(w44Med);

        const w44Aligned = fp44.slice();
        w44Aligned[w44Aligned.length - 1] = { ...w44Aligned[w44Aligned.length - 1], skipTol: 0.30 };
        w44Aligned.push(
          { x: oa34x, y: oa34y, skipTol: 0.25, speedLimit: 0.8 },
          { x: pdx, y: pdy, skipTol: 0.25, speedLimit: 0.6 },
          { x: gax, y: gay, skipTol: 0.25, speedLimit: 0.45 },
        );
        slowVariants.push(w44Aligned);

        const w44Slow = fp44.slice();
        w44Slow[w44Slow.length - 1] = { ...w44Slow[w44Slow.length - 1], skipTol: 0.20 };
        w44Slow.push(
          { x: oa34x, y: oa34y, skipTol: 0.20 },
          { x: pdx, y: pdy, skipTol: 0.15 },
          { x: gax, y: gay, skipTol: 0.25, speedLimit: 0.45 },
        );
        slowVariants.push(w44Slow);
      }
      const fp54 = findPath([agfState.x, agfState.y], [oa54x, oa54y], "agf", fpOpts);
      if (fp54.length > 0) {
        const w54Med = fp54.slice();
        w54Med[w54Med.length - 1] = { ...w54Med[w54Med.length - 1], skipTol: 0.35 };
        w54Med.push(
          { x: oa44x, y: oa44y, skipTol: 0.30, speedLimit: 1.6 },
          { x: oa34x, y: oa34y, skipTol: 0.25, speedLimit: 1.2 },
          { x: pdx, y: pdy, skipTol: 0.25, speedLimit: 0.9 },
          { x: gax, y: gay, skipTol: 0.25, speedLimit: 0.65 },
        );
        slowVariants.push(w54Med);

        const w54Aligned = fp54.slice();
        w54Aligned[w54Aligned.length - 1] = { ...w54Aligned[w54Aligned.length - 1], skipTol: 0.35 };
        w54Aligned.push(
          { x: oa44x, y: oa44y, skipTol: 0.30, speedLimit: 1.0 },
          { x: oa34x, y: oa34y, skipTol: 0.25, speedLimit: 0.8 },
          { x: pdx, y: pdy, skipTol: 0.25, speedLimit: 0.6 },
          { x: gax, y: gay, skipTol: 0.25, speedLimit: 0.45 },
        );
        slowVariants.push(w54Aligned);
      }
      const fpPd = findPath([agfState.x, agfState.y], [pdx, pdy], "agf", fpOpts);
      if (fpPd.length > 0) {
        const wPdFast = fpPd.slice();
        wPdFast[wPdFast.length - 1] = { ...wPdFast[wPdFast.length - 1], skipTol: 0.20 };
        fastVariants.push(wPdFast);

        const wPdSlow = fpPd.slice();
        wPdSlow[wPdSlow.length - 1] = { ...wPdSlow[wPdSlow.length - 1], skipTol: 0.15 };
        wPdSlow.push(
          { x: gax, y: gay, skipTol: 0.25, speedLimit: 0.45 },
        );
        slowVariants.push(wPdSlow);
      }
      if (fp34.length > 0) {
        const w34Rev = fp34.slice();
        w34Rev[w34Rev.length - 1] = { ...w34Rev[w34Rev.length - 1], reverse: true, skipTol: 0.35 };
        w34Rev.push(
          { x: pdx, y: pdy, skipTol: 0.15 },
          { x: gax, y: gay, skipTol: 0.25, speedLimit: 0.45 },
        );
        slowVariants.push(w34Rev);
      }
      for (const wps of [...fastVariants, ...slowVariants]) {
        const res = validateWorldRoute(wps, { checkPathClear: false, maxDockYawRad: 0.087 });
        if (res) return [...res.worldWps, doorApproachWp];
      }
      const locCur = worldToLocalPoint(agfState.x, agfState.y, pos[0], pos[1], ch);
      const prefSign = locCur.x >= 0 ? 1 : -1;
      const revX = agfState.x - Math.sin(agfState.heading) * 1.6;
      const revY = agfState.y - Math.cos(agfState.heading) * 1.6;
      const revValid = pathIsClear(agfState.x, agfState.y, revX, revY, allObstacles, 0.55);
      const wrapPrefixes = revValid
        ? [[{ x: revX, y: revY, reverse: true, skipTol: 0.25, speedLimit: 0.8 }], []]
        : [[]];
      const wrapCands = [];
      for (const sSign of [prefSign, -prefSign]) {
        for (const latOff of [1.78, 2.35, 2.95]) {
          const sx = sSign * (env.halfExtW + latOff);
          const [n1x, n1y] = localToWorld2D(sx, env.halfExtL + 3.6, pos[0], pos[1], ch);
          const [n2x, n2y] = localToWorld2D(sx, env.halfExtL + 1.2, pos[0], pos[1], ch);
          const [s1x, s1y] = localToWorld2D(sx, -(env.halfExtL + 3.4), pos[0], pos[1], ch);
          for (const pref of wrapPrefixes) {
            const prefStart = pref.length > 0 ? pref[pref.length - 1] : agfState;
            const n1Bridge = pathIsClear(prefStart.x, prefStart.y, n1x, n1y, allObstacles, 0.65)
              ? [{ x: n1x, y: n1y, skipTol: 0.45 }]
              : findPath(
                [prefStart.x, prefStart.y],
                [n1x, n1y],
                "agf",
                pref.length > 0 ? { containerCornerPad: 2.05 } : fpOpts,
              ).map((w, idx, arr) => (idx === arr.length - 1 ? { ...w, skipTol: 0.45 } : w));
            if (n1Bridge.length === 0) continue;
            const candsWrap = [
              [
                ...pref,
                ...n1Bridge,
                { x: n2x, y: n2y, skipTol: 0.45 },
                { x: s1x, y: s1y, skipTol: 0.45 },
                { x: oa44x, y: oa44y, skipTol: 0.30, speedLimit: 1.0 },
                { x: oa34x, y: oa34y, skipTol: 0.25, speedLimit: 0.8 },
                { x: pdx, y: pdy, skipTol: 0.25, speedLimit: 0.6 },
                { x: gax, y: gay, skipTol: 0.25, speedLimit: 0.45 },
              ],
              [
                ...pref,
                ...n1Bridge,
                { x: n2x, y: n2y, skipTol: 0.45 },
                { x: s1x, y: s1y, skipTol: 0.45 },
                { x: oa34x, y: oa34y, skipTol: 0.25, speedLimit: 0.8 },
                { x: pdx, y: pdy, skipTol: 0.25, speedLimit: 0.6 },
                { x: gax, y: gay, skipTol: 0.25, speedLimit: 0.45 },
              ],
            ];
            for (const wps of candsWrap) {
              wrapCands.push(wps);
              const res = validateWorldRoute(wps, { checkPathClear: false, maxDockYawRad: 0.087 });
              if (res) return [...res.worldWps, doorApproachWp];
            }
          }
        }
      }
      for (const wps of [...fastVariants, ...slowVariants, ...wrapCands]) {
        const res = validateWorldRoute(wps, { checkPathClear: false });
        if (res) return [...res.worldWps, doorApproachWp];
      }
      throw new Error(`No collision-free aligned approach route found for container ${cEntry.guid}`);
    };

    const loc = worldToLocalPoint(agfState.x, agfState.y, pos[0], pos[1], ch);
    const locH = wrapPi(agfState.heading - ch);
    let rawRoute = null;

    if (loc.y <= -(env.halfExtL + 0.75)) {
      // Region A: In front of door
      if (
        Math.abs(loc.x - slotLocalX) <= 0.15 &&
        loc.y >= -(env.halfExtL + 2.65) &&
        Math.abs(locH) <= 0.15 &&
        pathIsClear(agfState.x, agfState.y, dx, dy, otherObstacles, 0.55)
      ) {
        rawRoute = [doorApproachWp];
      } else {
        let chosen = null;
        if (loc.y >= -(env.halfExtL + 6.0) && Math.abs(loc.x) <= env.halfExtW + 2.5) {
          const revBackX = loc.x - Math.sin(locH) * 2.2;
          const revBackY = Math.min(loc.y - Math.cos(locH) * 2.2, -(env.halfExtL + 3.4));
          const fwdCand = [
            { x: slotLocalX, y: -(env.halfExtL + 3.4), skipTol: 0.25 },
            { x: slotLocalX, y: -(env.halfExtL + 2.55), skipTol: 0.20 },
            { x: slotLocalX, y: -(env.halfExtL + 1.65), skipTol: 0.25, speedLimit: 0.5 },
          ];
          const revCands = [
            [
              { x: slotLocalX, y: -(env.halfExtL + 3.4), reverse: true, skipTol: 0.25 },
              { x: slotLocalX, y: -(env.halfExtL + 2.55), skipTol: 0.20 },
              { x: slotLocalX, y: -(env.halfExtL + 1.65), skipTol: 0.25, speedLimit: 0.5 },
            ],
            [
              { x: slotLocalX, y: -(env.halfExtL + 3.9), reverse: true, skipTol: 0.35 },
              { x: slotLocalX, y: -(env.halfExtL + 2.55), skipTol: 0.25 },
              { x: slotLocalX, y: -(env.halfExtL + 1.65), skipTol: 0.25, speedLimit: 0.5 },
            ],
            [
              { x: slotLocalX, y: -(env.halfExtL + 4.2), reverse: true, skipTol: 0.25 },
              { x: slotLocalX, y: -(env.halfExtL + 3.4), skipTol: 0.25 },
              { x: slotLocalX, y: -(env.halfExtL + 2.55), skipTol: 0.20 },
              { x: slotLocalX, y: -(env.halfExtL + 1.65), skipTol: 0.25, speedLimit: 0.5 },
            ],
            [
              { x: revBackX, y: revBackY, reverse: true, skipTol: 0.25 },
              { x: slotLocalX, y: -(env.halfExtL + 4.2), reverse: true, skipTol: 0.25 },
              { x: slotLocalX, y: -(env.halfExtL + 3.4), skipTol: 0.25 },
              { x: slotLocalX, y: -(env.halfExtL + 2.55), skipTol: 0.20 },
              { x: slotLocalX, y: -(env.halfExtL + 1.65), skipTol: 0.25, speedLimit: 0.5 },
            ],
            [
              { x: slotLocalX + (loc.x >= slotLocalX ? 0.5 : -0.5), y: -(env.halfExtL + 4.8), reverse: true, skipTol: 0.35 },
              { x: slotLocalX, y: -(env.halfExtL + 5.6), reverse: true, skipTol: 0.35 },
              { x: slotLocalX, y: -(env.halfExtL + 3.4), skipTol: 0.25 },
              { x: slotLocalX, y: -(env.halfExtL + 2.55), skipTol: 0.25, speedLimit: 0.7 },
              { x: slotLocalX, y: -(env.halfExtL + 1.65), skipTol: 0.25, speedLimit: 0.5 },
            ],
          ];
          const regionACands = loc.y <= -(env.halfExtL + 3.5) ? [fwdCand, ...revCands] : revCands;
          for (const cand of regionACands) {
            const res = validateCandidateRoute(cand);
            if (res) {
              chosen = res;
              break;
            }
          }
        }
        rawRoute = chosen ? [...chosen.worldWps, doorApproachWp] : buildAlignedFindPathRoute();
      }
    } else if (loc.y > env.halfExtL + 0.2 && Math.abs(loc.x) < env.halfExtW + 1.8) {
      // Region B: Behind closed rear wall
      const s1Ys = [Math.max(loc.y, env.halfExtL + 2.45), Math.max(loc.y, env.halfExtL + 1.85)];
      const needRevPrefix = Math.cos(locH) < -0.2 && loc.y < env.halfExtL + 3.5;
      const revY = Math.max(loc.y + 1.8, env.halfExtL + 2.8);
      const prefixes = needRevPrefix
        ? [[{ x: loc.x, y: revY, reverse: true, skipTol: 0.35 }], []]
        : [[]];
      const prefSign = loc.x >= 0 ? 1 : -1;
      const sideXs = [
        prefSign * 2.85, -prefSign * 2.85,
        prefSign * 2.50, -prefSign * 2.50,
        prefSign * 2.10, -prefSign * 2.10,
        prefSign * 3.5, -prefSign * 3.5,
      ];
      let chosen = null;
      for (const prefix of prefixes) {
        const yOpts = prefix.length > 0 ? [Math.max(revY, s1Ys[0])] : s1Ys;
        for (const s1Y of yOpts) {
          for (const sx of sideXs) {
            const cands = [
              [
                ...prefix,
                { x: sx, y: s1Y, skipTol: 0.35 },
                { x: sx, y: 0, skipTol: 0.45 },
                { x: sx, y: -(env.halfExtL + 3.4), skipTol: 0.35 },
                { x: slotLocalX, y: -(env.halfExtL + 3.4), skipTol: 0.20, speedLimit: 1.0 },
                { x: preDoorLocal[0], y: preDoorLocal[1], skipTol: 0.15, speedLimit: 0.7 },
                { x: slotLocalX, y: -(env.halfExtL + 1.65), skipTol: 0.15, speedLimit: 0.5 },
              ],
              [
                ...prefix,
                { x: sx, y: s1Y, skipTol: 0.35 },
                { x: sx, y: 0, skipTol: 0.45 },
                { x: sx, y: -(env.halfExtL + 2.55), skipTol: 0.35 },
                { x: preDoorLocal[0], y: preDoorLocal[1], skipTol: 0.20 },
              ],
              [
                ...prefix,
                { x: sx, y: s1Y, skipTol: 0.35 },
                { x: sx, y: 0, skipTol: 0.45 },
                { x: sx, y: -(env.halfExtL + 3.4), skipTol: 0.35 },
                { x: slotLocalX, y: -(env.halfExtL + 3.4), skipTol: 0.25 },
                { x: preDoorLocal[0], y: preDoorLocal[1], skipTol: 0.20 },
              ],
            ];
            for (const cand of cands) {
              const res = validateCandidateRoute(cand);
              if (res && (!chosen || res.steps < chosen.steps)) {
                chosen = res;
              }
            }
          }
          if (chosen) break;
        }
        if (chosen) break;
      }
      if (chosen) {
        rawRoute = [...chosen.worldWps, doorApproachWp];
      } else {
        rawRoute = buildAlignedFindPathRoute();
      }
    } else if (Math.abs(loc.x) >= env.halfExtW + 0.5 && loc.y > -(env.halfExtL + 0.75) && loc.y <= env.halfExtL + 3.5) {
      // Region C: Beside container
      const sideSign = loc.x >= 0 ? 1 : -1;
      let chosen = null;
      if (Math.cos(locH - Math.PI) > 0.30) {
        const sxs = [...new Set([sideSign * Math.max(2.6, Math.abs(loc.x)), sideSign * Math.abs(loc.x)])];
        for (const sx of sxs) {
          const cands = [
            [
              { x: sx, y: -(env.halfExtL + 2.55), skipTol: 0.45 },
              { x: preDoorLocal[0], y: preDoorLocal[1], skipTol: 0.20 },
            ],
            [
              { x: sx, y: -(env.halfExtL + 3.4), skipTol: 0.35 },
              { x: slotLocalX, y: -(env.halfExtL + 3.4), skipTol: 0.25 },
              { x: preDoorLocal[0], y: preDoorLocal[1], skipTol: 0.20 },
            ],
            [
              { x: sx, y: -(env.halfExtL + 3.8), skipTol: 0.35 },
              { x: slotLocalX, y: -(env.halfExtL + 3.8), skipTol: 0.25 },
              { x: preDoorLocal[0], y: preDoorLocal[1], skipTol: 0.20 },
              { x: slotLocalX, y: -(env.halfExtL + 1.65), skipTol: 0.25, speedLimit: 0.9 },
            ],
            [
              { x: sx, y: -(env.halfExtL + 4.2), skipTol: 0.35 },
              { x: slotLocalX, y: -(env.halfExtL + 4.2), skipTol: 0.25 },
              { x: slotLocalX, y: -(env.halfExtL + 3.4), skipTol: 0.25 },
              { x: preDoorLocal[0], y: preDoorLocal[1], skipTol: 0.20 },
              { x: slotLocalX, y: -(env.halfExtL + 1.65), skipTol: 0.25, speedLimit: 0.5 },
            ],
          ];
          for (const cand of cands) {
            const res = validateCandidateRoute(cand);
            if (res) {
              chosen = res;
              break;
            }
          }
          if (chosen) break;
        }
      } else {
        const flareX = sideSign * Math.max(3.6, Math.abs(loc.x) + 1.1);
        const flareY = Math.min(loc.y + 4.5, env.halfExtL + 2.0);
        const candidates = [
          [
            { x: flareX, y: flareY, skipTol: 0.45 },
            { x: flareX, y: -(env.halfExtL + 2.55), skipTol: 0.45 },
            { x: preDoorLocal[0], y: preDoorLocal[1], skipTol: 0.20 },
          ],
        ];
        const revXs = [...new Set([sideSign * Math.abs(loc.x), sideSign * Math.max(2.5, Math.abs(loc.x))])];
        for (const revX of revXs) {
          candidates.push([
            { x: revX, y: -(env.halfExtL + 3.9), reverse: true, skipTol: 0.35 },
            { x: slotLocalX, y: -(env.halfExtL + 5.0), reverse: true, skipTol: 0.35 },
            { x: slotLocalX, y: -(env.halfExtL + 3.4), skipTol: 0.25 },
            { x: preDoorLocal[0], y: preDoorLocal[1], skipTol: 0.20 },
          ]);
          candidates.push([
            { x: revX, y: -(env.halfExtL + 3.7), reverse: true, skipTol: 0.35 },
            { x: slotLocalX - sideSign * 1.5, y: -(env.halfExtL + 3.7), reverse: true, skipTol: 0.35 },
            { x: slotLocalX, y: -(env.halfExtL + 3.1), skipTol: 0.25 },
            { x: preDoorLocal[0], y: preDoorLocal[1], skipTol: 0.20 },
          ]);
          candidates.push([
            { x: revX, y: -(env.halfExtL + 3.7), reverse: true, skipTol: 0.35 },
            { x: slotLocalX - sideSign * 1.5, y: -(env.halfExtL + 3.7), reverse: true, skipTol: 0.35 },
            { x: preDoorLocal[0], y: preDoorLocal[1], skipTol: 0.35 },
          ]);
        }
        if (Math.cos(locH) > 0.0) {
          const safeXs = [...new Set([sideSign * Math.max(2.5, Math.abs(loc.x)), sideSign * Math.abs(loc.x)])];
          for (const safeX of safeXs) {
            candidates.push([
              { x: safeX, y: env.halfExtL + 2.45, skipTol: 0.35 },
              { x: -safeX, y: env.halfExtL + 2.45, skipTol: 0.35 },
              { x: -safeX, y: 0, skipTol: 0.45 },
              { x: -safeX, y: -(env.halfExtL + 2.55), skipTol: 0.45 },
              { x: preDoorLocal[0], y: preDoorLocal[1], skipTol: 0.20 },
            ]);
          }
        }
        for (const cand of candidates) {
          const res = validateCandidateRoute(cand);
          if (res) {
            chosen = res;
            break;
          }
        }
      }
      if (chosen) {
        rawRoute = [...chosen.worldWps, doorApproachWp];
      } else {
        rawRoute = buildAlignedFindPathRoute();
      }
    } else {
      rawRoute = buildAlignedFindPathRoute();
    }

    if (Array.isArray(rawRoute) && rawRoute.length > 0) {
      rawRoute[rawRoute.length - 1] = { ...rawRoute[rawRoute.length - 1], heading: wrapHeading(ch) };
    } else {
      throw new Error(`AGF route unreachable to container ${cEntry.guid}`);
    }
    const route = subdivideWaypoints(agfState.x, agfState.y, rawRoute, 4.5);
    route[route.length - 1] = { ...route[route.length - 1], heading: wrapHeading(ch) };
    return { route, doorApproach: { x: dx, y: dy, heading: wrapHeading(ch) }, cPos: pos, cHeading: ch, spec };
  }

  function applyContainerSlotMutation(cEntry, op, slotIndex, wcid, serverDispatch) {
    const slots = Array.isArray(cEntry.slots) ? cEntry.slots : [];
    const dispatchNeeded = Boolean(serverDispatch) && !cEntry.localOnly;
    if (dispatchNeeded) {
      const h = sh();
      if (!h || typeof h.vehicleContainerAction !== "function") {
        throw new Error("SessionHandle missing vehicleContainerAction for serverDispatch");
      }
      const act = op === "load" ? CONTAINER_ACTION.Load : CONTAINER_ACTION.Unpack;
      h.vehicleContainerAction(cEntry.guid >>> 0, act, slotIndex | 0, 0, wcid | 0);
    }
    if (op === "unload") {
      const nextSlots = slots.filter((s) => Math.trunc(s.slotIndex ?? s.SlotIndex) !== slotIndex);
      cEntry.slots = nextSlots;
      try { cEntry.model?.syncSlots?.(nextSlots); } catch (_) {}
    } else {
      const nextSlots = [
        ...slots.filter((s) => Math.trunc(s.slotIndex ?? s.SlotIndex) !== slotIndex),
        { slotIndex, palletSize: "full", cargoWcid: wcid },
      ];
      cEntry.slots = nextSlots;
      try { cEntry.model?.syncSlots?.(nextSlots); } catch (_) {}
    }
  }

  function obbListOverlap(obbsA, obbsB) {
    for (let i = 0; i < obbsA.length; i++) {
      const a = obbsA[i];
      for (let j = 0; j < obbsB.length; j++) {
        const b = obbsB[j];
        if (satOverlap2D(a.cx, a.cy, a.heading, a.halfW, a.halfL, b.cx, b.cy, b.heading, b.halfW, b.halfL)) {
          return true;
        }
      }
    }
    return false;
  }

  function makeCorridorObb(ax, ay, bx, by, halfW, padBack = 0, padFront = 0) {
    const dx = bx - ax;
    const dy = by - ay;
    const dist = Math.hypot(dx, dy);
    const h = dist > 1e-4 ? wrapHeading(Math.atan2(dx, dy)) : 0;
    const s = Math.sin(h);
    const c = Math.cos(h);
    const shift = (padFront - padBack) * 0.5;
    return {
      cx: (ax + bx) * 0.5 + s * shift,
      cy: (ay + by) * 0.5 + c * shift,
      heading: h,
      halfW,
      halfL: dist * 0.5 + (padBack + padFront) * 0.5,
    };
  }

  function buildAmrBayObbs(appPos, targetPos, bayHeading, includePallet = false) {
    const halfW = AMR_HALF_W + 0.04;
    const halfL = AMR_HALF_L;
    const turnR = AMR_SPECS.hullRadiusM + 0.02;
    const chassis = [
      makeCorridorObb(appPos[0], appPos[1], targetPos[0], targetPos[1], halfW, halfL, halfL),
      { cx: appPos[0], cy: appPos[1], heading: bayHeading, halfW: turnR, halfL: turnR },
    ];
    if (!includePallet) return chassis;
    const pallet = [
      makeCorridorObb(appPos[0], appPos[1], targetPos[0], targetPos[1], 0.56, 0.55, 0.55),
    ];
    chassis._palletObbs = pallet;
    return chassis;
  }

  function getAmrWorldObbs(x, y, heading, carriedWcid = 0, turntableYawRad = 0) {
    return {
      isAgf: false,
      chassis: [{ cx: x, cy: y, heading, halfW: AMR_HALF_W, halfL: AMR_HALF_L }],
      pallet: carriedWcid
        ? [{ cx: x, cy: y, heading: wrapHeading(heading + turntableYawRad), halfW: 0.55, halfL: 0.55 }]
        : [],
    };
  }

  function getAgfWorldObbs(x, y, heading, carriedWcid = 0) {
    const s = Math.sin(heading);
    const c = Math.cos(heading);
    return {
      isAgf: true,
      chassis: [
        { cx: x - 0.89 * s, cy: y - 0.89 * c, heading, halfW: 0.57, halfL: 1.04 },
        { cx: x + 0.725 * s, cy: y + 0.725 * c, heading, halfW: 0.34, halfL: 0.575 },
      ],
      pallet: carriedWcid
        ? [{ cx: x + AGF_SPECS.cargoCenterY * s, cy: y + AGF_SPECS.cargoCenterY * c, heading, halfW: 0.55, halfL: 0.55 }]
        : [],
    };
  }

  function getEntryWorldObbs(entry, isAgf, poseOverride = null) {
    const s = entry.state;
    const x = poseOverride?.x ?? s.x;
    const y = poseOverride?.y ?? s.y;
    const h = poseOverride?.heading ?? s.heading;
    const carried = poseOverride?.carriedWcid ?? s.carriedWcid ?? 0;
    if (isAgf) return getAgfWorldObbs(x, y, h, carried);
    const tt = poseOverride?.turntableYawRad ?? s.turntableYawRad ?? 0;
    return getAmrWorldObbs(x, y, h, carried, tt);
  }

  function vehiclesSatOverlap2D(a, b, pad = 0.002) {
    for (let i = 0; i < a.chassis.length; i++) {
      const ac = a.chassis[i];
      for (let j = 0; j < b.chassis.length; j++) {
        const bc = b.chassis[j];
        if (satOverlap2D(ac.cx, ac.cy, ac.heading, ac.halfW + pad, ac.halfL + pad, bc.cx, bc.cy, bc.heading, bc.halfW, bc.halfL)) {
          return true;
        }
      }
    }
    if (a.pallet.length > 0 && b.pallet.length > 0) {
      for (let i = 0; i < a.pallet.length; i++) {
        const ap = a.pallet[i];
        for (let j = 0; j < b.pallet.length; j++) {
          const bp = b.pallet[j];
          if (satOverlap2D(ap.cx, ap.cy, ap.heading, ap.halfW + pad, ap.halfL + pad, bp.cx, bp.cy, bp.heading, bp.halfW, bp.halfL)) {
            return true;
          }
        }
      }
    }
    if ((a.isAgf || b.isAgf) && b.pallet.length > 0) {
      for (let i = 0; i < a.chassis.length; i++) {
        const ac = a.chassis[i];
        for (let j = 0; j < b.pallet.length; j++) {
          const bp = b.pallet[j];
          if (satOverlap2D(ac.cx, ac.cy, ac.heading, ac.halfW + pad, ac.halfL + pad, bp.cx, bp.cy, bp.heading, bp.halfW, bp.halfL)) {
            return true;
          }
        }
      }
    }
    if ((a.isAgf || b.isAgf) && a.pallet.length > 0) {
      for (let i = 0; i < a.pallet.length; i++) {
        const ap = a.pallet[i];
        for (let j = 0; j < b.chassis.length; j++) {
          const bc = b.chassis[j];
          if (satOverlap2D(ap.cx, ap.cy, ap.heading, ap.halfW + pad, ap.halfL + pad, bc.cx, bc.cy, bc.heading, bc.halfW, bc.halfL)) {
            return true;
          }
        }
      }
    }
    return false;
  }

  function extractDriveToSpeedLimit(task) {
    if (!task) return Infinity;
    let minSp = Number.isFinite(task.speedLimit) && task.speedLimit >= 0 ? task.speedLimit : Infinity;
    if (Array.isArray(task.waypoints)) {
      for (let i = 0; i < task.waypoints.length; i++) {
        const wp = task.waypoints[i];
        if (wp && typeof wp === "object" && !Array.isArray(wp) && Number.isFinite(wp.speedLimit) && wp.speedLimit >= 0) {
          if (wp.speedLimit < minSp) minSp = wp.speedLimit;
        }
      }
    }
    return minSp;
  }

  function buildIdleVehicleObstacles(excludeEntry, selfLoaded = false) {
    const out = [];
    for (const other of amrEntries.values()) {
      if (other === excludeEntry || other.queue.length > 0) continue;
      const s = other.state;
      const ch = Math.abs(Math.cos(s.heading));
      const shv = Math.abs(Math.sin(s.heading));
      const rx = AMR_HALF_W * ch + AMR_HALF_L * shv;
      const ry = AMR_HALF_W * shv + AMR_HALF_L * ch;
      out.push({
        id: s.agentId,
        kind: "vehicle",
        x0: s.x - rx,
        x1: s.x + rx,
        y0: s.y - ry,
        y1: s.y + ry,
        obb: { cx: s.x, cy: s.y, heading: s.heading, halfW: AMR_HALF_W, halfL: AMR_HALF_L },
      });
      if (selfLoaded && s.carriedWcid) {
        const ph = wrapHeading(s.heading + (s.turntableYawRad ?? 0));
        const pc = Math.abs(Math.cos(ph));
        const ps = Math.abs(Math.sin(ph));
        const prx = 0.55 * (pc + ps);
        out.push({
          id: `${s.agentId}:pallet`,
          kind: "vehicle",
          isPallet: true,
          x0: s.x - prx,
          x1: s.x + prx,
          y0: s.y - prx,
          y1: s.y + prx,
          obb: { cx: s.x, cy: s.y, heading: ph, halfW: 0.55, halfL: 0.55 },
        });
      }
    }
    for (const other of agfEntries.values()) {
      if (other === excludeEntry || other.queue.length > 0) continue;
      const obbs = getAgfWorldObbs(other.state.x, other.state.y, other.state.heading, other.state.carriedWcid);
      const allBoxes = [...obbs.chassis, ...obbs.pallet];
      for (let i = 0; i < allBoxes.length; i++) {
        const o = allBoxes[i];
        const ch = Math.abs(Math.cos(o.heading));
        const shv = Math.abs(Math.sin(o.heading));
        const rx = o.halfW * ch + o.halfL * shv;
        const ry = o.halfW * shv + o.halfL * ch;
        out.push({
          id: `${other.state.agentId}:${i}`,
          kind: "vehicle",
          isAgf: true,
          x0: o.cx - rx,
          x1: o.cx + rx,
          y0: o.cy - ry,
          y1: o.cy + ry,
          obb: { cx: o.cx, cy: o.cy, heading: o.heading, halfW: o.halfW, halfL: o.halfL },
        });
      }
    }
    return out;
  }

  function isAmrPoseClearOfIdleVehicles(wx, wy, heading, excludeEntry, carriedWcid = 0, turntableYawRad = 0, pad = 0.002) {
    const selfObbs = getAmrWorldObbs(wx, wy, heading, carriedWcid, turntableYawRad);
    for (const other of amrEntries.values()) {
      if (other === excludeEntry || other.queue.length > 0) continue;
      if (vehiclesSatOverlap2D(selfObbs, getEntryWorldObbs(other, false), pad)) return false;
    }
    for (const other of agfEntries.values()) {
      if (other === excludeEntry || other.queue.length > 0) continue;
      if (vehiclesSatOverlap2D(selfObbs, getEntryWorldObbs(other, true), pad)) return false;
    }
    return true;
  }

  function buildAgfBayObbs(startPose, endPose, bayHeading) {
    const [fwdX, fwdY] = headingForward(bayHeading);
    return [
      makeCorridorObb(
        startPose.x - fwdX * 0.89,
        startPose.y - fwdY * 0.89,
        endPose.x - fwdX * 0.89,
        endPose.y - fwdY * 0.89,
        0.57 + 0.04,
        1.04 + 0.02,
        1.04 + 0.02,
      ),
      makeCorridorObb(
        startPose.x + fwdX * 0.725,
        startPose.y + fwdY * 0.725,
        endPose.x + fwdX * 0.725,
        endPose.y + fwdY * 0.725,
        0.34 + 0.04,
        0.575 + 0.02,
        0.575 + 0.02,
      ),
    ];
  }

  function getVehicleBlockingObbs(otherEntry, isAgf) {
    const active = otherEntry.queue?.[0];
    let pose = null;
    if (!active) {
      pose = {
        x: otherEntry.state.x,
        y: otherEntry.state.y,
        heading: otherEntry.state.heading,
        unheaded: false,
      };
    } else if (active.task?.type === "driveTo") {
      if (active.data?.finalApproach) {
        const fa = active.data.finalApproach;
        pose = {
          x: fa.dstX,
          y: fa.dstY,
          heading: Number.isFinite(fa.dstHeading) ? fa.dstHeading : fa.heading,
          unheaded: !Number.isFinite(fa.dstHeading) && !Number.isFinite(fa.heading),
        };
      } else {
        const wps = active.data?.waypoints || normalizeWaypointsInput(active.task.waypoints);
        if (Array.isArray(wps) && wps.length > 0) {
          const last = wps[wps.length - 1];
          const prev = wps.length >= 2 ? wps[wps.length - 2] : otherEntry.state;
          const legLen = Math.hypot(last.x - prev.x, last.y - prev.y);
          const h = Number.isFinite(last.heading)
            ? wrapHeading(last.heading)
            : (legLen > 0.05
              ? (last.reverse ? wrapHeading(Math.atan2(prev.x - last.x, prev.y - last.y)) : wrapHeading(Math.atan2(last.x - prev.x, last.y - prev.y)))
              : otherEntry.state.heading);
          pose = {
            x: last.x,
            y: last.y,
            heading: h,
            unheaded: !Number.isFinite(last.heading),
          };
        }
      }
    } else {
      return null;
    }
    if (!pose || !Number.isFinite(pose.x) || !Number.isFinite(pose.y)) return null;
    if (!isAgf) {
      if (pose.unheaded) {
        return [{ cx: pose.x, cy: pose.y, heading: 0, halfW: AMR_SPECS.hullRadiusM, halfL: AMR_SPECS.hullRadiusM }];
      }
      return [{ cx: pose.x, cy: pose.y, heading: pose.heading, halfW: AMR_HALF_W, halfL: AMR_HALF_L }];
    }
    const s = Math.sin(pose.heading);
    const c = Math.cos(pose.heading);
    return [
      { cx: pose.x - 0.89 * s, cy: pose.y - 0.89 * c, heading: pose.heading, halfW: 0.57, halfL: 1.04 },
      { cx: pose.x + 0.725 * s, cy: pose.y + 0.725 * c, heading: pose.heading, halfW: 0.34, halfL: 0.575 },
    ];
  }

  function isZoneBlockedByOtherVehicles(bayObbs, excludeAgfEntry = null, excludeAmrEntry = null) {
    const palletBayObbs = bayObbs?._palletObbs || null;
    for (const other of agfEntries.values()) {
      if (other === excludeAgfEntry) continue;
      const blockerObbs = getVehicleBlockingObbs(other, true);
      if (blockerObbs && obbListOverlap(blockerObbs, bayObbs)) return true;
      if (palletBayObbs && blockerObbs && obbListOverlap(blockerObbs, palletBayObbs)) return true;
      const active = other.queue?.[0];
      if (active?.task?.type === "driveTo" && extractDriveToSpeedLimit(active.task) < 0.25) {
        const curObbs = getEntryWorldObbs(other, true);
        if (obbListOverlap(curObbs.chassis, bayObbs)) return true;
      }
    }
    for (const other of amrEntries.values()) {
      if (other === excludeAmrEntry) continue;
      const blockerObbs = getVehicleBlockingObbs(other, false);
      if (blockerObbs && obbListOverlap(blockerObbs, bayObbs)) return true;
      if (palletBayObbs && other.state.carriedWcid) {
        const curObbs = getEntryWorldObbs(other, false);
        if (obbListOverlap(curObbs.pallet, palletBayObbs)) return true;
      }
      const active = other.queue?.[0];
      if (active?.task?.type === "driveTo" && extractDriveToSpeedLimit(active.task) < 0.25) {
        const curObbs = getEntryWorldObbs(other, false);
        if (obbListOverlap(curObbs.chassis, bayObbs)) return true;
        if (palletBayObbs && curObbs.pallet.length > 0 && obbListOverlap(curObbs.pallet, palletBayObbs)) return true;
      }
    }
    return false;
  }

  function findStrictAgfPath(fromPos, toPos, opts = {}) {
    const fx = finiteOr(fromPos?.[0] ?? fromPos?.x, 0);
    const fy = finiteOr(fromPos?.[1] ?? fromPos?.y, 0);
    const tx = finiteOr(toPos?.[0] ?? toPos?.x, 0);
    const ty = finiteOr(toPos?.[1] ?? toPos?.y, 0);
    const legDist = Math.hypot(tx - fx, ty - fy);
    const fp = findPath([fx, fy], [tx, ty], "agf", { ...opts, _rejectOnFail: true });
    if (
      !Array.isArray(fp) ||
      fp.length === 0 ||
      (fp.length === 1 && Math.hypot(fp[0].x - fx, fp[0].y - fy) <= 0.05 && legDist > 0.5)
    ) {
      throw new Error(`AGF route unreachable from (${fx.toFixed(2)}, ${fy.toFixed(2)}) to (${tx.toFixed(2)}, ${ty.toFixed(2)})`);
    }
    if (fp.length === 1 && Math.hypot(fp[0].x - tx, fp[0].y - ty) > 0.5 && !fp[0]._clampedClearTarget) {
      throw new Error(`AGF route unreachable from (${fx.toFixed(2)}, ${fy.toFixed(2)}) to (${tx.toFixed(2)}, ${ty.toFixed(2)})`);
    }
    return fp;
  }

  function buildIdleAmrObstaclesForAgf() {
    const out = [];
    for (const m of amrEntries.values()) {
      if (m.queue.length > 0) continue;
      const s = m.state;
      const obbs = getAmrWorldObbs(s.x, s.y, s.heading, s.carriedWcid, s.turntableYawRad);
      const boxes = [...obbs.chassis, ...obbs.pallet];
      for (let i = 0; i < boxes.length; i++) {
        const o = boxes[i];
        const ch = Math.abs(Math.cos(o.heading));
        const shv = Math.abs(Math.sin(o.heading));
        const rx = o.halfW * ch + o.halfL * shv;
        const ry = o.halfW * shv + o.halfL * ch;
        out.push({
          id: `${s.agentId}:amr:${i}`,
          kind: "vehicle",
          isAmr: true,
          x0: o.cx - rx,
          x1: o.cx + rx,
          y0: o.cy - ry,
          y1: o.cy + ry,
          obb: { cx: o.cx, cy: o.cy, heading: o.heading, halfW: o.halfW, halfL: o.halfL },
          _amrEntry: m,
        });
      }
    }
    return out;
  }

  function agfRouteHitsIdleAmrs(st, wps, idleAmrObs) {
    if (!Array.isArray(wps) || wps.length === 0 || !Array.isArray(idleAmrObs) || idleAmrObs.length === 0) return false;
    const amrEntriesList = [];
    const seen = new Set();
    for (let i = 0; i < idleAmrObs.length; i++) {
      const m = idleAmrObs[i]._amrEntry;
      if (m && !seen.has(m)) {
        seen.add(m);
        amrEntriesList.push({ entry: m, obbs: getEntryWorldObbs(m, false) });
      }
    }
    let totalLen = 0;
    let px = st.x;
    let py = st.y;
    for (let i = 0; i < wps.length; i++) {
      totalLen += Math.hypot(wps[i].x - px, wps[i].y - py);
      px = wps[i].x;
      py = wps[i].y;
    }
    const maxSteps = Math.min(4000, Math.max(360, Math.ceil(totalLen * 120)));
    let sim = {
      agentId: st.agentId ?? "agf-amr-sim",
      x: st.x,
      y: st.y,
      heading: st.heading,
      speed: 0,
      steerAngleRad: st.steerAngleRad ?? 0,
      forkHeightM: st.forkHeightM ?? AGF_EMPTY_TRANSIT_FORK_Z,
      sideShiftM: st.sideShiftM ?? 0,
      mastTiltRad: st.mastTiltRad ?? 0,
      wheelSpinRad: st.wheelSpinRad ?? 0,
      lidarSpinRad: st.lidarSpinRad ?? 0,
      carriedWcid: st.carriedWcid ?? 0,
      loaded: Boolean(st.loaded || st.carriedWcid),
    };
    let wpIdx = 0;
    for (let step = 0; step < maxSteps; step++) {
      sim = stepAgfKinematics(sim, { waypoints: wps, waypointIndex: wpIdx, targetForkHeightM: sim.forkHeightM }, 1 / 60, EMPTY_ARC_CTX);
      wpIdx = sim.waypointIndex;
      while (wpIdx < wps.length - 1) {
        const wp = wps[wpIdx];
        const sk = Number.isFinite(wp?.skipTol) ? wp.skipTol : (wp?.speedLimit ? 0.50 : 1.25);
        if (wp && Math.hypot(wp.x - sim.x, wp.y - sim.y) <= sk && !wp.docking) wpIdx++;
        else break;
      }
      const selfObbs = getAgfWorldObbs(sim.x, sim.y, sim.heading, sim.carriedWcid);
      for (let mi = 0; mi < amrEntriesList.length; mi++) {
        const mItem = amrEntriesList[mi];
        if (Math.hypot(mItem.entry.state.x - sim.x, mItem.entry.state.y - sim.y) > 4.2) continue;
        if (vehiclesSatOverlap2D(selfObbs, mItem.obbs, 0.04)) return true;
      }
      if (sim.arrived) break;
    }
    return false;
  }

  function maybeOrthogonalizeAgfTerminalRoute(startPose, wps, selfEntry = null) {
    if (!Array.isArray(wps) || wps.length === 0) return wps;
    const dst = wps[wps.length - 1];
    if (!dst || !Number.isFinite(dst.x) || !Number.isFinite(dst.y)) return wps;
    if (Number.isFinite(dst.heading) || dst.reverse || dst.docking || dst._clampedClearTarget) return wps;

    const selfId = selfEntry?.state?.agentId ?? startPose?.agentId ?? null;
    const peers = [];
    for (const other of agfEntries.values()) {
      if (other === selfEntry || (selfId && other.state?.agentId === selfId)) continue;
      const os = other.state;
      const oActive = other.queue?.[0] || null;
      let px = NaN;
      let py = NaN;
      let idle = false;
      if (!oActive) {
        px = os.x;
        py = os.y;
        idle = true;
      } else if (oActive.task?.type === "driveTo") {
        const owps = oActive.data?.waypoints || normalizeWaypointsInput(oActive.task.waypoints);
        const olast = Array.isArray(owps) && owps.length > 0 ? owps[owps.length - 1] : null;
        if (olast && !olast.docking && !olast.reverse && Number.isFinite(olast.x) && Number.isFinite(olast.y)) {
          px = olast.x;
          py = olast.y;
        }
      }
      if (!Number.isFinite(px) || !Number.isFinite(py)) continue;
      const d = Math.hypot(px - dst.x, py - dst.y);
      if (d >= 1.25 && d <= 3.45) {
        peers.push({ entry: other, isAgf: true, x: px, y: py, d, idle });
      }
    }
    for (const other of amrEntries.values()) {
      const os = other.state;
      const oActive = other.queue?.[0] || null;
      let px = NaN;
      let py = NaN;
      let idle = false;
      if (!oActive) {
        px = os.x;
        py = os.y;
        idle = true;
      } else if (oActive.task?.type === "driveTo") {
        const owps = oActive.data?.waypoints || normalizeWaypointsInput(oActive.task.waypoints);
        const olast = Array.isArray(owps) && owps.length > 0 ? owps[owps.length - 1] : null;
        if (olast && !olast.docking && !olast.reverse && Number.isFinite(olast.x) && Number.isFinite(olast.y)) {
          px = olast.x;
          py = olast.y;
        }
      }
      if (!Number.isFinite(px) || !Number.isFinite(py)) continue;
      const d = Math.hypot(px - dst.x, py - dst.y);
      if (d >= 1.00 && d <= 3.00) {
        peers.push({ entry: other, isAgf: false, x: px, y: py, d, idle });
      }
    }
    if (peers.length === 0) return wps;
    peers.sort((a, b) => a.d - b.d);

    const p0 = peers[0];
    const basePrefix = wps.slice(0, -1);
    const prev = basePrefix.length > 0 ? basePrefix[basePrefix.length - 1] : startPose;
    const curDx = dst.x - prev.x;
    const curDy = dst.y - prev.y;
    const curLen = Math.hypot(curDx, curDy);
    const [curDirX, curDirY] = curLen > 1e-4
      ? [curDx / curLen, curDy / curLen]
      : headingForward(finiteOr(startPose?.heading, 0));
    const ux = (p0.x - dst.x) / p0.d;
    const uy = (p0.y - dst.y) / p0.d;
    const dot = Math.abs(curDirX * ux + curDirY * uy);
    if (dot <= 0.45) return wps;
    if (!p0.idle && ((dst.x - p0.x) * curDirX + (dst.y - p0.y) * curDirY) <= 0.2) {
      return wps;
    }

    const staticObs = getStaticObstacles();
    if (minDistanceToObstacles(dst.x, dst.y, staticObs) < AGF_SPECS.hullRadiusM + 0.08) {
      return wps;
    }

    const idleVehs = [];
    for (const other of agfEntries.values()) {
      if (other === selfEntry || (selfId && other.state?.agentId === selfId) || other.queue.length > 0) continue;
      const os = other.state;
      if (Math.hypot(os.x - dst.x, os.y - dst.y) > 6.5) continue;
      idleVehs.push({ isAgf: true, x: os.x, y: os.y, obbs: getEntryWorldObbs(other, true) });
    }
    for (const other of amrEntries.values()) {
      if (other.queue.length > 0) continue;
      const os = other.state;
      if (Math.hypot(os.x - dst.x, os.y - dst.y) > 6.5) continue;
      idleVehs.push({ isAgf: false, x: os.x, y: os.y, obbs: getEntryWorldObbs(other, false) });
    }

    let rackMinX = Infinity;
    let rackMaxX = -Infinity;
    let rackMinY = Infinity;
    let rackMaxY = -Infinity;
    for (const r of racks.values()) {
      const b = r.worldBounds;
      if (!b) continue;
      if (b.minX < rackMinX) rackMinX = b.minX;
      if (b.maxX > rackMaxX) rackMaxX = b.maxX;
      if (b.minY < rackMinY) rackMinY = b.minY;
      if (b.maxY > rackMaxY) rackMaxY = b.maxY;
    }
    const hasRackBounds = rackMinX < Infinity && rackMaxX > -Infinity && rackMinY < Infinity && rackMaxY > -Infinity;

    const hA = wrapHeading(Math.atan2(-uy, ux));
    const hB = wrapHeading(Math.atan2(uy, -ux));
    const candHeadings = [hA, hB].sort((ha, hb) => {
      const da = Math.sin(ha) * curDirX + Math.cos(ha) * curDirY;
      const db = Math.sin(hb) * curDirX + Math.cos(hb) * curDirY;
      return db - da;
    });

    const selfCarried = selfEntry?.state?.carriedWcid ?? startPose?.carriedWcid ?? 0;
    const selfForkZ = selfEntry?.state?.forkHeightM ?? startPose?.forkHeightM ?? (selfCarried ? AGF_CARRIED_TRANSIT_FORK_Z : AGF_EMPTY_TRANSIT_FORK_Z);
    const pathPad = AGF_SPECS.hullRadiusM + 0.06;
    const obsPad = AGF_SPECS.hullRadiusM + 0.14;

    const preAnchor = basePrefix.length > 0 ? basePrefix[basePrefix.length - 1] : startPose;
    for (const candH of candHeadings) {
      if (!isAgfPoseObbClear(dst.x, dst.y, candH, staticObs, 0.02, null, selfCarried, selfForkZ)) continue;
      const dstObbs = getAgfWorldObbs(dst.x, dst.y, candH, selfCarried);
      if (idleVehs.some((v) => vehiclesSatOverlap2D(dstObbs, v.obbs, 0.02))) {
        continue;
      }
      const [fhx, fhy] = headingForward(candH);
      const [rxC, ryC] = headingRight(candH);
      const peerSide = (p0.x - dst.x) * rxC + (p0.y - dst.y) * ryC;
      const awaySign = peerSide >= 0 ? -1 : 1;
      const sharpAnchorTurn = Math.abs(wrapPi(candH - (curLen > 1e-4 ? Math.atan2(curDirX, curDirY) : finiteOr(preAnchor?.heading, 0)))) > 0.70;
      const dPreList = sharpAnchorTurn ? [4.2, 4.6, 3.4, 2.8, 2.2] : [3.4, 2.8, 2.2];
      for (const dPre of dPreList) {
        const preX = dst.x - fhx * dPre;
        const preY = dst.y - fhy * dPre;
        const midX = dst.x - fhx * (dPre * 0.48);
        const midY = dst.y - fhy * (dPre * 0.48);
        if (peers.some((p) => {
          const minClr = p.idle ? (p.isAgf ? 1.26 : 1.15) : (p.isAgf ? 1.44 : 1.25);
          const minSegClr = p.idle ? (p.isAgf ? 1.26 : 1.15) : (p.isAgf ? 1.42 : 1.22);
          return Math.hypot(p.x - preX, p.y - preY) < minClr ||
            Math.hypot(p.x - midX, p.y - midY) < minClr ||
            pointToSegDist2D(p.x, p.y, preX, preY, dst.x, dst.y) < minSegClr;
        })) {
          continue;
        }
        let idleVehNearPre = false;
        for (let vi = 0; vi < idleVehs.length; vi++) {
          const v = idleVehs[vi];
          const minClr = v.isAgf ? 1.26 : 1.15;
          if (
            Math.hypot(v.x - preX, v.y - preY) < minClr ||
            Math.hypot(v.x - midX, v.y - midY) < minClr ||
            pointToSegDist2D(v.x, v.y, preX, preY, dst.x, dst.y) < minClr
          ) {
            idleVehNearPre = true;
            break;
          }
        }
        if (idleVehNearPre) continue;
        if (idleVehs.length > 0) {
          const preObbs = getAgfWorldObbs(preX, preY, candH, selfCarried);
          const midObbs = getAgfWorldObbs(midX, midY, candH, selfCarried);
          if (idleVehs.some((v) => vehiclesSatOverlap2D(preObbs, v.obbs, 0.02) || vehiclesSatOverlap2D(midObbs, v.obbs, 0.02))) {
            continue;
          }
        }
        if (
          minDistanceToObstacles(preX, preY, staticObs) < obsPad ||
          minDistanceToObstacles(midX, midY, staticObs) < obsPad ||
          !isAgfPoseObbClear(preX, preY, candH, staticObs, 0.02, null, selfCarried, selfForkZ) ||
          !isAgfPoseObbClear(midX, midY, candH, staticObs, 0.02, null, selfCarried, selfForkZ) ||
          !pathIsClear(preX, preY, dst.x, dst.y, staticObs, pathPad)
        ) {
          continue;
        }

        const anchor = basePrefix.length > 0 ? basePrefix[basePrefix.length - 1] : startPose;
        let prefix = basePrefix;
        if (hasRackBounds && dst.y >= rackMinY && dst.y <= rackMaxY && anchor.y >= rackMinY && anchor.y <= rackMaxY) {
          const crossesWestMouth = anchor.x > rackMinX - 0.5 && dst.x < rackMinX - 1.5;
          const crossesEastMouth = anchor.x < rackMaxX + 0.5 && dst.x > rackMaxX + 1.5;
          if (crossesWestMouth || crossesEastMouth) {
            const mouthX = crossesWestMouth ? rackMinX - 1.0 : rackMaxX + 1.0;
            if (Math.hypot(anchor.x - mouthX, anchor.y - dst.y) > 0.35 && pathIsClear(anchor.x, anchor.y, mouthX, dst.y, staticObs, pathPad)) {
              prefix = [...basePrefix, { x: mouthX, y: dst.y, skipTol: 0.45 }];
            }
          }
        }
        const tailAnchor = prefix.length > 0 ? prefix[prefix.length - 1] : startPose;
        const inPreDx = preX - tailAnchor.x;
        const inPreDy = preY - tailAnchor.y;
        const inPreLen = Math.hypot(inPreDx, inPreDy);
        const inPreH = inPreLen > 1e-4 ? Math.atan2(inPreDx, inPreDy) : candH;
        const turnAtPre = Math.abs(wrapPi(candH - inPreH));
        const sharpPreTurn = turnAtPre > 0.70;
        const tailSegCands = [];
        if (pathIsClear(tailAnchor.x, tailAnchor.y, preX, preY, staticObs, pathPad)) {
          tailSegCands.push([
            { x: preX, y: preY, skipTol: sharpPreTurn ? 0.35 : 0.45, speedLimit: 1.05 },
            { x: midX, y: midY, skipTol: 0.35, speedLimit: 0.90 },
            { ...dst, heading: candH, _autoOrthoHeading: true, speedLimit: 0.85 },
          ]);
        }
        if ((sharpAnchorTurn || sharpPreTurn) && Math.hypot(dst.x - tailAnchor.x, dst.y - tailAnchor.y) >= 2.2) {
          const s1X = dst.x - fhx * Math.max(1.8, dPre - 1.2) + rxC * awaySign * 2.6;
          const s1Y = dst.y - fhy * Math.max(1.8, dPre - 1.2) + ryC * awaySign * 2.6;
          const s2X = dst.x - fhx * (dPre + 1.2) + rxC * awaySign * 1.8;
          const s2Y = dst.y - fhy * (dPre + 1.2) + ryC * awaySign * 1.8;
          const sPreX = preX + rxC * awaySign * 0.2;
          const sPreY = preY + ryC * awaySign * 0.2;
          if (
            minDistanceToObstacles(s1X, s1Y, staticObs) >= obsPad &&
            minDistanceToObstacles(s2X, s2Y, staticObs) >= obsPad &&
            minDistanceToObstacles(sPreX, sPreY, staticObs) >= obsPad &&
            pathIsClear(tailAnchor.x, tailAnchor.y, s1X, s1Y, staticObs, pathPad) &&
            pathIsClear(s1X, s1Y, s2X, s2Y, staticObs, pathPad) &&
            pathIsClear(s2X, s2Y, sPreX, sPreY, staticObs, pathPad) &&
            pathIsClear(sPreX, sPreY, midX, midY, staticObs, pathPad) &&
            !idleVehs.some((v) => {
              const minClr = v.isAgf ? 1.50 : 1.35;
              return (
                Math.hypot(v.x - s1X, v.y - s1Y) < minClr ||
                Math.hypot(v.x - s2X, v.y - s2Y) < minClr ||
                pointToSegDist2D(v.x, v.y, s1X, s1Y, s2X, s2Y) < minClr ||
                pointToSegDist2D(v.x, v.y, s2X, s2Y, sPreX, sPreY) < minClr
              );
            })
          ) {
            tailSegCands.push([
              { x: s1X, y: s1Y, skipTol: 0.45, speedLimit: 0.90 },
              { x: s2X, y: s2Y, skipTol: 0.40, speedLimit: 0.85 },
              { x: sPreX, y: sPreY, skipTol: 0.30, speedLimit: 0.80 },
              { x: midX, y: midY, skipTol: 0.30, speedLimit: 0.80 },
              { ...dst, heading: candH, _autoOrthoHeading: true, speedLimit: 0.80 },
            ]);
          }
        }
        if (tailSegCands.length === 0) continue;

        const prevAnchor = prefix.length >= 2
          ? prefix[prefix.length - 2]
          : (prefix.length === 1 ? startPose : null);
        let simH = prevAnchor
          ? wrapHeading(Math.atan2(tailAnchor.x - prevAnchor.x, tailAnchor.y - prevAnchor.y))
          : finiteOr(startPose?.heading, 0);
        if (prevAnchor && tailAnchor.reverse) {
          simH = wrapHeading(simH + Math.PI);
        }
        const simFrom = {
          agentId: selfId ?? "agf-ortho-sim",
          x: tailAnchor.x,
          y: tailAnchor.y,
          heading: simH,
          speed: 0,
          steerAngleRad: 0,
          forkHeightM: startPose?.forkHeightM ?? AGF_EMPTY_TRANSIT_FORK_Z,
          carriedWcid: selfCarried,
          loaded: Boolean(selfCarried || startPose?.loaded),
        };
        const startObsDist = minDistanceToObstacles(simFrom.x, simFrom.y, staticObs);
        for (const tailSeg of tailSegCands) {
          if (!isAgfArcClear(simFrom, tailSeg, staticObs, AGF_SPECS.hullRadiusM + 0.02, startObsDist, { maxSteps: 1200, speedScales: [1.0], requireArrival: true })) {
            continue;
          }
          if (idleVehs.length > 0) {
            let simVehOk = true;
            const startOverlap = idleVehs.map((v) => vehiclesSatOverlap2D(getAgfWorldObbs(simFrom.x, simFrom.y, simFrom.heading, selfCarried), v.obbs, 0.02));
            for (const dtSim of [1 / 60, 1 / 30]) {
              const maxStepsV = dtSim < 0.025 ? 1200 : 600;
              let simV = { ...simFrom, sideShiftM: 0, mastTiltRad: 0, wheelSpinRad: 0, lidarSpinRad: 0 };
              let wpIdxV = 0;
              for (let step = 0; step < maxStepsV; step++) {
                simV = stepAgfKinematics(simV, { waypoints: tailSeg, waypointIndex: wpIdxV, targetForkHeightM: simV.forkHeightM }, dtSim, EMPTY_ARC_CTX);
                wpIdxV = simV.waypointIndex;
                while (wpIdxV < tailSeg.length - 1) {
                  const wp = tailSeg[wpIdxV];
                  const sk = Number.isFinite(wp?.skipTol) ? wp.skipTol : 0.45;
                  if (wp && Math.hypot(wp.x - simV.x, wp.y - simV.y) <= sk && !wp.docking) wpIdxV++;
                  else break;
                }
                const curObbsV = getAgfWorldObbs(simV.x, simV.y, simV.heading, selfCarried);
                const nearTailAlign = wpIdxV >= tailSeg.length - 2 || Math.hypot(dst.x - simV.x, dst.y - simV.y) <= 2.5;
                const navTgtV = wpIdxV >= tailSeg.length - 1 ? dst : tailSeg[wpIdxV];
                const distToNavV = navTgtV ? Math.hypot(navTgtV.x - simV.x, navTgtV.y - simV.y) : Infinity;
                const distToDstV = Math.hypot(dst.x - simV.x, dst.y - simV.y);
                const maxFwdV = Math.min(0.90, distToDstV);
                const navYawErrV = distToNavV > 0.15
                  ? wrapPi(Math.atan2(navTgtV.x - simV.x, navTgtV.y - simV.y) - simV.heading)
                  : wrapPi(candH - simV.heading);
                const s1V = Math.min(0.24, maxFwdV);
                const s2V = Math.min(0.52, maxFwdV);
                const s3V = Math.min(0.85, maxFwdV);
                const h2V = wrapHeading(simV.heading + clamp(navYawErrV, -0.10, 0.10));
                const h3V = wrapHeading(simV.heading + clamp(navYawErrV, -0.18, 0.18));
                for (let vi = 0; vi < idleVehs.length; vi++) {
                  if (startOverlap[vi]) continue;
                  const iv = idleVehs[vi];
                  if (Math.hypot(iv.x - simV.x, iv.y - simV.y) > 4.5) continue;
                  if (vehiclesSatOverlap2D(curObbsV, iv.obbs, 0.03)) {
                    simVehOk = false;
                    break;
                  }
                  if (nearTailAlign && s1V > 0.02) {
                    const s1Clear = !vehiclesSatOverlap2D(getAgfWorldObbs(simV.x + Math.sin(simV.heading) * s1V, simV.y + Math.cos(simV.heading) * s1V, simV.heading, selfCarried), iv.obbs, 0.02);
                    const s2Clear = s2V <= s1V + 0.02 ? s1Clear : !vehiclesSatOverlap2D(getAgfWorldObbs(simV.x + Math.sin(h2V) * s2V, simV.y + Math.cos(h2V) * s2V, h2V, selfCarried), iv.obbs, 0.02);
                    const s3Clear = s3V <= s2V + 0.02 ? s2Clear : !vehiclesSatOverlap2D(getAgfWorldObbs(simV.x + Math.sin(h3V) * s3V, simV.y + Math.cos(h3V) * s3V, h3V, selfCarried), iv.obbs, 0.02);
                    if (!s1Clear || !s2Clear || !s3Clear) {
                      simVehOk = false;
                      break;
                    }
                  }
                }
                if (!simVehOk || simV.arrived) break;
              }
              if (!simVehOk || !simV.arrived) {
                simVehOk = false;
                break;
              }
            }
            if (!simVehOk) continue;
          }
          return [...prefix, ...tailSeg];
        }
      }
    }
    return wps;
  }

  function initAgfTask(entry, item) {
    const st = entry.state;
    const t = item.task;
    const type = t.type;

    if (type === "driveTo") {
      const rawWps = normalizeWaypointsInput(t.waypoints);
      if (!rawWps) throw new Error("driveTo requires non-empty waypoints");
      let wps = rawWps;
      const taskDocking = Boolean(t.docking);
      if (!t.reverse) {
        if (rawWps.length === 1) {
          const dst = rawWps[0];
          const dstDocking = Boolean(dst.docking || taskDocking);
          const legDist = Math.hypot(dst.x - st.x, dst.y - st.y);
          const dstStaticObs = dstDocking && legDist <= 1.65 ? getStaticObstacles() : null;
          const dstH = Number.isFinite(dst.heading) ? wrapHeading(dst.heading) : st.heading;
          const dstClearForStrict = !dstStaticObs || (
            minDistanceToObstacles(dst.x, dst.y, dstStaticObs) >= AGF_SPECS.hullRadiusM + 0.05 &&
            isAgfPoseObbClear(
              dst.x,
              dst.y,
              dstH,
              dstStaticObs,
              0.002,
              null,
              st.carriedWcid,
              st.forkHeightM,
            )
          );
          if (dstDocking && legDist <= 1.65 && !dstClearForStrict) {
            throw new Error(`AGF route unreachable from (${st.x.toFixed(2)}, ${st.y.toFixed(2)}) to (${dst.x.toFixed(2)}, ${dst.y.toFixed(2)})`);
          }
          if (!dst.reverse && dstDocking && legDist <= 1.65 && dstClearForStrict) {
            const startMinD = minDistanceToObstacles(st.x, st.y, dstStaticObs);
            const directDockOk = isAgfArcClear(st, [{ ...dst, ...(dstDocking ? { docking: true } : {}) }], dstStaticObs, AGF_SPECS.hullRadiusM, startMinD, {
              maxSteps: 900,
              speedScales: [1.0],
              requireArrival: true,
              checkSatObb: true,
            });
            let dockRoute = directDockOk ? [{ ...dst, ...(dstDocking ? { docking: true } : {}) }] : null;
            if (!dockRoute) {
              const turnCands = [];
              const [dfx, dfy] = headingForward(dstH);
              const [sfx, sfy] = headingForward(st.heading);
              const oxD = layout?.origin?.[0] ?? NE_FLATLAND_SITE.origin[0];
              const oyD = layout?.origin?.[1] ?? NE_FLATLAND_SITE.origin[1];
              const aisleYs = layout?.aisles?.length ? layout.aisles.map((a) => a.y) : [oyD + 3.0, oyD - 3.0, oyD - 9.0];
              let inAisleY = null;
              for (const ay of aisleYs) {
                if (Math.abs(st.y - ay) <= 1.6) { inAisleY = ay; break; }
              }
              if (inAisleY !== null) {
                if (Math.abs(wrapPi(dstH - st.heading)) <= 0.45 && Math.abs(dfx) > 0.7) {
                  turnCands.push([
                    { x: dst.x - dfx * 2.6, y: st.y, reverse: true, skipTol: 0.35, speedLimit: 0.90 },
                    { ...dst },
                  ]);
                  turnCands.push([
                    { x: dst.x - dfx * 3.4, y: inAisleY, reverse: true, skipTol: 0.35, speedLimit: 0.90 },
                    { ...dst },
                  ]);
                }
                const westMouthX = oxD - 21.0;
                const eastMouthX = oxD + 11.2;
                const loopY = inAisleY > oyD ? oyD + 8.5 : oyD - 14.5;
                if (sfx < -0.5) {
                  turnCands.push([
                    { x: westMouthX, y: inAisleY, skipTol: 0.45, speedLimit: 1.35 },
                    { x: westMouthX, y: loopY, skipTol: 0.45, speedLimit: 1.35 },
                    { x: westMouthX - 3.5, y: loopY, skipTol: 0.45, speedLimit: 1.35 },
                    { x: westMouthX - 3.5, y: inAisleY, skipTol: 0.45, speedLimit: 1.35 },
                    { x: westMouthX, y: inAisleY, skipTol: 0.45, speedLimit: 1.35 },
                    { x: dst.x - dfx * 2.2, y: dst.y, skipTol: 0.30, speedLimit: 0.9 },
                    { ...dst },
                  ]);
                } else if (sfx > 0.5) {
                  turnCands.push([
                    { x: eastMouthX, y: inAisleY, skipTol: 0.45, speedLimit: 1.35 },
                    { x: eastMouthX, y: loopY, skipTol: 0.45, speedLimit: 1.35 },
                    { x: eastMouthX + 3.5, y: loopY, skipTol: 0.45, speedLimit: 1.35 },
                    { x: eastMouthX + 3.5, y: inAisleY, skipTol: 0.45, speedLimit: 1.35 },
                    { x: eastMouthX, y: inAisleY, skipTol: 0.45, speedLimit: 1.35 },
                    { x: dst.x - dfx * 2.2, y: dst.y, skipTol: 0.30, speedLimit: 0.9 },
                    { ...dst },
                  ]);
                }
              } else {
                const preX = dst.x - dfx * 2.4;
                const preY = dst.y - dfy * 2.4;
                try {
                  const subPre = findStrictAgfPath([st.x, st.y], [preX, preY], {
                    heading: st.heading,
                    carriedWcid: st.carriedWcid,
                    loaded: st.loaded,
                  });
                  turnCands.push([...subPre, { ...dst }]);
                } catch (_) {}
              }
              for (const rawCand of turnCands) {
                const subCand = subdivideWaypoints(st.x, st.y, rawCand, 4.5);
                subCand[subCand.length - 1] = { ...subCand[subCand.length - 1], ...dst, ...(dstDocking ? { docking: true } : {}) };
                let segOk = true;
                let px = st.x;
                let py = st.y;
                for (let ci = 0; ci < subCand.length; ci++) {
                  const wp = subCand[ci];
                  const minD = minDistanceToObstacles(wp.x, wp.y, dstStaticObs);
                  if (minD < AGF_SPECS.hullRadiusM + 0.04 || !pathIsClear(px, py, wp.x, wp.y, dstStaticObs, AGF_SPECS.hullRadiusM + 0.04)) {
                    segOk = false;
                    break;
                  }
                  px = wp.x;
                  py = wp.y;
                }
                if (!segOk) continue;
                let totL = 0;
                let lx = st.x;
                let ly = st.y;
                for (const wp of subCand) { totL += Math.hypot(wp.x - lx, wp.y - ly); lx = wp.x; ly = wp.y; }
                const maxS = Math.min(8000, Math.max(900, Math.ceil(totL * 150)));
                if (isAgfArcClear(st, subCand, dstStaticObs, AGF_SPECS.hullRadiusM, startMinD, { maxSteps: maxS, speedScales: [1.0], requireArrival: true, checkSatObb: true })) {
                  dockRoute = subCand;
                  break;
                }
              }
            }
            if (!dockRoute) {
              throw new Error(`AGF route unreachable from (${st.x.toFixed(2)}, ${st.y.toFixed(2)}) to (${dst.x.toFixed(2)}, ${dst.y.toFixed(2)})`);
            }
            wps = dockRoute;
            const idleAmrObs = buildIdleAmrObstaclesForAgf();
            if (idleAmrObs.length > 0 && agfRouteHitsIdleAmrs(st, wps, idleAmrObs)) {
              throw new Error(`AGF route unreachable from (${st.x.toFixed(2)}, ${st.y.toFixed(2)}) to (${dst.x.toFixed(2)}, ${dst.y.toFixed(2)})`);
            }
          } else if (!dst.reverse && dstClearForStrict && legDist > 0.05) {
            const pathOpts = {
              heading: st.heading,
              carriedWcid: st.carriedWcid,
              loaded: st.loaded,
              targetHeading: dst.heading,
              targetDocking: dstDocking,
            };
            const planned = findStrictAgfPath([st.x, st.y], [dst.x, dst.y], pathOpts);
            if (planned) {
              wps = planned;
              const lastWp = wps[wps.length - 1];
              wps[wps.length - 1] = lastWp._clampedClearTarget
                ? { ...dst, ...lastWp, x: lastWp.x, y: lastWp.y }
                : { ...lastWp, ...dst };
              const idleAmrObs = buildIdleAmrObstaclesForAgf();
              if (idleAmrObs.length > 0 && agfRouteHitsIdleAmrs(st, wps, idleAmrObs)) {
                const dstClearOfIdleAmr = idleAmrObs.every((b) => {
                  const m = b._amrEntry;
                  const d = Math.hypot(m.state.x - dst.x, m.state.y - dst.y);
                  if (d > 4.2) return true;
                  if (Number.isFinite(dst.heading)) {
                    return !vehiclesSatOverlap2D(getAgfWorldObbs(dst.x, dst.y, wrapHeading(dst.heading), st.carriedWcid), getEntryWorldObbs(m, false), 0.02);
                  }
                  return d >= 1.85;
                });
                if (dstClearOfIdleAmr) {
                  try {
                    const replan = findStrictAgfPath([st.x, st.y], [dst.x, dst.y], { ...pathOpts, extraObstacles: idleAmrObs });
                    const lastRe = replan[replan.length - 1];
                    replan[replan.length - 1] = lastRe._clampedClearTarget
                      ? { ...dst, ...lastRe, x: lastRe.x, y: lastRe.y }
                      : { ...lastRe, ...dst };
                    if (!agfRouteHitsIdleAmrs(st, replan, idleAmrObs)) {
                      wps = replan;
                    }
                  } catch (_) {}
                }
              }
              wps = maybeOrthogonalizeAgfTerminalRoute(st, wps, entry);
            }
          } else if (dst.reverse && legDist > 0.05) {
            const staticObsRev = getStaticObstacles();
            const startMinDRev = minDistanceToObstacles(st.x, st.y, staticObsRev);
            const revMaxS = Math.min(6000, Math.max(600, Math.ceil(legDist * 150)));
            const directRevOk = isAgfArcClear(st, [dst], staticObsRev, AGF_SPECS.hullRadiusM, startMinDRev, {
              maxSteps: revMaxS,
              speedScales: [1.0],
              requireArrival: true,
              checkSatObb: true,
            });
            if (!directRevOk) {
              const idleAmrObsRev = buildIdleAmrObstaclesForAgf();
              let adjX = dst.x;
              let adjY = dst.y;
              let minDAdj = minDistanceToObstacles(adjX, adjY, staticObsRev);
              if (minDAdj < AGF_SPECS.hullRadiusM + 0.02) {
                let bestOb = null;
                let bestD = Infinity;
                for (let oi = 0; oi < staticObsRev.length; oi++) {
                  const ob = staticObsRev[oi];
                  if (!ob) continue;
                  const dOb = pointToObstacleDist(adjX, adjY, ob);
                  if (dOb < bestD) { bestD = dOb; bestOb = ob; }
                }
                if (bestOb) {
                  const cx = clamp(adjX, bestOb.x0, bestOb.x1);
                  const cy = clamp(adjY, bestOb.y0, bestOb.y1);
                  const dn = Math.hypot(adjX - cx, adjY - cy);
                  if (dn > 1e-4) {
                    const pushR = Math.min(0.10, (AGF_SPECS.hullRadiusM + 0.04) - dn);
                    if (pushR > 0) {
                      adjX += ((adjX - cx) / dn) * pushR;
                      adjY += ((adjY - cy) / dn) * pushR;
                      minDAdj = minDistanceToObstacles(adjX, adjY, staticObsRev);
                    }
                  }
                }
              }
              const [fHxRev, fHyRev] = headingForward(st.heading);
              const pullStarts = [{ x: st.x, y: st.y, h: st.heading, prefix: [] }];
              for (const dPull of [2.2, 1.5]) {
                const px = st.x - fHxRev * dPull;
                const py = st.y - fHyRev * dPull;
                const pWp = { x: px, y: py, reverse: true, skipTol: 0.30, speedLimit: 0.90 };
                if (
                  minDistanceToObstacles(px, py, staticObsRev) >= AGF_SPECS.hullRadiusM + 0.05 &&
                  isAgfArcClear(st, [pWp], staticObsRev, AGF_SPECS.hullRadiusM, startMinDRev, { maxSteps: 600, speedScales: [1.0], requireArrival: true, checkSatObb: true }) &&
                  (idleAmrObsRev.length === 0 || !agfRouteHitsIdleAmrs(st, [pWp], idleAmrObsRev))
                ) {
                  pullStarts.unshift({ x: px, y: py, h: st.heading, prefix: [pWp] });
                  break;
                }
              }
              let plannedRev = null;
              outerRev: for (const ps of pullStarts) {
                for (const [axOff, ayOff] of [[1.8, 0.04], [-1.8, 0.04], [0.04, 1.8], [0.04, -1.8]]) {
                  const preX = adjX + axOff;
                  const preY = adjY + ayOff;
                  if (minDistanceToObstacles(preX, preY, staticObsRev) < AGF_SPECS.hullRadiusM + 0.12) continue;
                  try {
                    const sub = findStrictAgfPath([ps.x, ps.y], [preX, preY], {
                      heading: ps.h,
                      carriedWcid: st.carriedWcid,
                      loaded: st.loaded,
                      extraObstacles: idleAmrObsRev,
                    });
                    const cand = [
                      ...ps.prefix,
                      ...sub.map((w, idx) => (idx === sub.length - 1 ? { ...w, skipTol: 0.25, speedLimit: 0.85 } : w)),
                      { ...dst, x: adjX, y: adjY, reverse: true, _clampedClearTarget: true },
                    ];
                    const okStatic = isAgfArcClear(st, cand, staticObsRev, AGF_SPECS.hullRadiusM, startMinDRev, {
                      maxSteps: 6000,
                      speedScales: [1.0],
                      requireArrival: true,
                      endMinDist: minDAdj,
                      checkSatObb: true,
                    });
                    if (okStatic && (idleAmrObsRev.length === 0 || !agfRouteHitsIdleAmrs(st, cand, idleAmrObsRev))) {
                      plannedRev = cand;
                      break outerRev;
                    }
                  } catch (_) {}
                }
              }
              if (plannedRev) {
                wps = plannedRev;
              }
            }
          }
        } else {
          wps = routeAroundSolidObstacles(st, rawWps, AGF_SPECS.hullRadiusM, "agf");
          const idleAmrObs = buildIdleAmrObstaclesForAgf();
          if (idleAmrObs.length > 0 && agfRouteHitsIdleAmrs(st, wps, idleAmrObs)) {
            try {
              const replan = routeAroundSolidObstacles(st, rawWps, AGF_SPECS.hullRadiusM, "agf", { extraObstacles: idleAmrObs });
              if (!agfRouteHitsIdleAmrs(st, replan, idleAmrObs)) {
                wps = replan;
              }
            } catch (_) {}
          }
          const orthoWps = maybeOrthogonalizeAgfTerminalRoute(st, wps, entry);
          if (orthoWps !== wps) {
            const staticObs = getStaticObstacles();
            const startMinDist = minDistanceToObstacles(st.x, st.y, staticObs);
            const lastOrtho = orthoWps[orthoWps.length - 1];
            const endMinDist = lastOrtho ? minDistanceToObstacles(lastOrtho.x, lastOrtho.y, staticObs) : Infinity;
            let totalLen = 0;
            let px = st.x;
            let py = st.y;
            for (let i = 0; i < orthoWps.length; i++) {
              totalLen += Math.hypot(orthoWps[i].x - px, orthoWps[i].y - py);
              px = orthoWps[i].x;
              py = orthoWps[i].y;
            }
            const maxSteps = Math.min(18000, Math.max(900, Math.ceil(totalLen * 150)));
            if (
              isAgfArcClear(st, orthoWps, staticObs, AGF_SPECS.hullRadiusM, startMinDist, {
                maxSteps,
                speedScales: [1.0],
                requireArrival: true,
                endMinDist,
                checkSatObb: true,
              }) &&
              (idleAmrObs.length === 0 || !agfRouteHitsIdleAmrs(st, orthoWps, idleAmrObs))
            ) {
              wps = orthoWps;
            }
          }
        }
      }
      if (taskDocking && wps.length > 0) {
        const lastIdx = wps.length - 1;
        wps = wps.slice();
        wps[lastIdx] = { ...wps[lastIdx], docking: true };
      }
      item.phase = "drive";
      item.data = {
        waypoints: wps,
        waypointIndex: 0,
        reverse: t.reverse,
        docking: t.docking,
        speedLimit: t.speedLimit,
      };
      return;
    }

    if (type === "placeInRack" || type === "pickFromRack") {
      const row = racks.get(t.rackId);
      if (!row) throw new Error(`Unknown rackId: ${t.rackId}`);
      const bay = t.bay;
      const tier = t.tier;
      const side = t.side ?? 0;
      const slotInBay = t.slotInBay ?? 0;
      const maxSide = row.doubleSided ? 1 : 0;
      if (
        !Number.isInteger(bay) || bay < 0 || bay >= row.bayCount ||
        !Number.isInteger(tier) || tier < 0 || tier >= RACK_SPECS.tierCount ||
        !Number.isInteger(side) || side < 0 || side > maxSide ||
        (slotInBay !== 0 && slotInBay !== 1)
      ) {
        throw new Error(`Invalid rack coordinates (${t.rackId}, ${bay}, ${tier}, ${side}, ${slotInBay})`);
      }

      const slotKey = `${side}:${bay}:${tier}:${slotInBay}`;
      if (type === "placeInRack") {
        if (!st.carriedWcid) throw new Error("AGF is not carrying cargo for placeInRack");
        if (row.loadedSlots.has(slotKey)) throw new Error(`Rack slot ${t.rackId}:${slotKey} is occupied`);
      } else {
        if (st.carriedWcid) throw new Error("AGF already carrying cargo for pickFromRack");
        if (!row.loadedSlots.has(slotKey)) throw new Error(`Rack slot ${t.rackId}:${slotKey} is empty`);
      }
      for (const other of agfEntries.values()) {
        if (other === entry) continue;
        const active = other.queue?.[0];
        if (
          active?.initialized &&
          (active.task?.type === "placeInRack" || active.task?.type === "pickFromRack") &&
          active.task?.rackId === t.rackId
        ) {
          if (active.task?.type === type && active.data?.slotKey === slotKey) {
            throw new Error(
              type === "placeInRack"
                ? `Rack slot ${t.rackId}:${slotKey} is occupied (reserved)`
                : `Rack slot ${t.rackId}:${slotKey} is empty (reserved)`,
            );
          }
          const otherSide = active.data?.side ?? active.task?.side ?? 0;
          const otherBay = active.data?.bay ?? active.task?.bay;
          if (otherSide === side && otherBay === bay) {
            throw new Error(`Rack bay ${t.rackId}:${side}:${bay} is reserved by another AGF`);
          }
        }
      }

      const lp = computeRackSlotLocalPose(bay, tier, slotInBay, RACK_SPECS, { side, doubleSided: row.doubleSided });
      const [sx, sy] = localToWorld2D(lp.x, lp.y, row.pos[0], row.pos[1], row.heading);
      const [ax, ay] = localToWorld2D(lp.approachX, lp.approachY, row.pos[0], row.pos[1], row.heading);
      const ah = wrapHeading(row.heading + lp.approachHeading);
      const [fwdX, fwdY] = headingForward(ah);
      const insertX = sx - fwdX * AGF_SPECS.cargoCenterY;
      const insertY = sy - fwdY * AGF_SPECS.cargoCenterY;
      const retractPose = { x: ax - fwdX * 0.17, y: ay - fwdY * 0.17, heading: ah, reverse: true };
      const bayObbs = buildAgfBayObbs(retractPose, { x: insertX, y: insertY }, ah);
      if (isZoneBlockedByOtherVehicles(bayObbs, entry, null)) {
        throw new Error(`Rack slot ${t.rackId}:${slotKey} is blocked`);
      }

      const route = findStrictAgfPath([st.x, st.y], [ax, ay], { heading: st.heading, carriedWcid: st.carriedWcid, loaded: st.loaded });
      route[route.length - 1] = { ...route[route.length - 1], heading: ah };

      item.phase = "route";
      item.data = {
        row,
        bay,
        tier,
        side,
        slotInBay,
        slotKey,
        tierZ: lp.z,
        approachPose: { x: ax, y: ay, heading: ah },
        insertPose: { x: insertX, y: insertY, heading: ah, docking: true },
        retractPose,
        route,
        waypointIndex: 0,
      };
      return;
    }

    if (type === "pickFromContainer" || type === "loadIntoContainer") {
      const cGuid = t.containerGuid >>> 0;
      const cEntry = containers.get(cGuid);
      if (!cEntry) throw new Error(`Container ${cGuid} not found`);
      if (isContainerTrailerMounted(cEntry)) throw new Error(`Container ${cGuid} is trailer-mounted or elevated`);
      if (!isContainerDoorOpen(cEntry)) throw new Error(`Container ${cGuid} doors are closed`);
      if (t.serverDispatch && !cEntry.localOnly) {
        const h = sh();
        if (!h || typeof h.vehicleContainerAction !== "function") {
          throw new Error("SessionHandle missing vehicleContainerAction for serverDispatch");
        }
      }

      const slotIndex = t.slotIndex;
      if (!Number.isInteger(slotIndex)) throw new Error(`Invalid container slotIndex: ${slotIndex}`);

      if (type === "pickFromContainer") {
        if (st.carriedWcid) throw new Error("AGF already carrying cargo");
        const check = isSlotReachableForUnload(cEntry.kind, cEntry.slots, slotIndex, 0);
        if (!check.reachable) throw new Error(`Slot ${slotIndex} unreachable for unload: ${check.reason}`);
      } else {
        if (!st.carriedWcid) throw new Error("AGF not carrying cargo");
        const check = isSlotReachableForLoad(cEntry.kind, cEntry.slots, slotIndex, 0, "full");
        if (!check.reachable) throw new Error(`Slot ${slotIndex} unreachable for load: ${check.reason}`);
      }
      for (const other of agfEntries.values()) {
        if (other === entry) continue;
        const active = other.queue?.[0];
        if (
          active?.initialized &&
          (active.task?.type === "pickFromContainer" || active.task?.type === "loadIntoContainer") &&
          ((active.data?.cGuid ?? (active.task?.containerGuid >>> 0)) === cGuid)
        ) {
          throw new Error(`Container ${cGuid} is reserved by another AGF`);
        }
      }

      const specPre = resolveContainerLogisticsSpec(cEntry.kind);
      const slotDefPre = specPre?.slots?.[slotIndex];
      const envPre = resolveContainerEnvelopeSpec(cEntry);
      const cPosPre = containerWorldPos(cEntry);
      const cHeadingPre = wrapHeading(cEntry.heading || 0);
      const preDoorLocalX = slotDefPre?.x ?? 0;
      const preDoorLocalY = -(envPre.halfExtL + 2.55);
      const slotLocalYPre = Math.min(
        (slotDefPre?.y ?? 0) - AGF_SPECS.cargoCenterY,
        (specPre?.interior?.halfL ?? envPre.halfExtL) - AGF_SPECS.forkTipY - 0.03,
      );
      const [preDoorWX, preDoorWY] = localToWorld2D(preDoorLocalX, preDoorLocalY, cPosPre[0], cPosPre[1], cHeadingPre);
      const [slotWX, slotWY] = localToWorld2D(preDoorLocalX, slotLocalYPre, cPosPre[0], cPosPre[1], cHeadingPre);
      const containerBayObbs = buildAgfBayObbs({ x: preDoorWX, y: preDoorWY }, { x: slotWX, y: slotWY }, cHeadingPre);
      if (isZoneBlockedByOtherVehicles(containerBayObbs, entry, null)) {
        throw new Error(`Container ${cGuid} is blocked`);
      }

      const info = buildContainerApproachRoute(st, cEntry, slotDefPre?.x ?? 0);
      const slotDef = info.spec.slots[slotIndex];
      const alignLocalY = -(info.spec.interior.halfL + 0.4);
      const maxForkSafeY = info.spec.interior.halfL - AGF_SPECS.forkTipY - 0.03;
      const slotLocalY = Math.min(slotDef.y - AGF_SPECS.cargoCenterY, maxForkSafeY);
      const [alignX, alignY] = localToWorld2D(slotDef.x, alignLocalY, info.cPos[0], info.cPos[1], info.cHeading);
      const [slotX, slotY] = localToWorld2D(slotDef.x, slotLocalY, info.cPos[0], info.cPos[1], info.cHeading);
      const enterWaypoints = [{ x: alignX, y: alignY, speedLimit: AGF_SPECS.vContainerMps }];
      if (slotLocalY - alignLocalY > 0.7) {
        const [preX, preY] = localToWorld2D(slotDef.x, slotLocalY - 0.35, info.cPos[0], info.cPos[1], info.cHeading);
        enterWaypoints.push({ x: preX, y: preY, speedLimit: AGF_SPECS.vContainerMps, skipTol: 0.25 });
      }
      enterWaypoints.push({ x: slotX, y: slotY, heading: wrapHeading(info.cHeading), docking: true });
      const exitClearDist = 3.25;
      const exitTargetDist = 3.45;
      const [slotExitClearX, slotExitClearY] = localToWorld2D(slotDef.x, -(info.spec.interior.halfL + exitClearDist), info.cPos[0], info.cPos[1], info.cHeading);
      const [slotExitX, slotExitY] = localToWorld2D(slotDef.x, -(info.spec.interior.halfL + exitTargetDist), info.cPos[0], info.cPos[1], info.cHeading);

      item.phase = "route";
      item.data = {
        cEntry,
        cGuid,
        slotIndex,
        serverDispatch: Boolean(t.serverDispatch),
        floorZ: info.spec.interior.floorZ,
        route: info.route,
        waypointIndex: 0,
        enterWaypoints,
        exitWaypoints: [
          { x: slotExitX, y: slotExitY, heading: info.doorApproach.heading, reverse: true, speedLimit: AGF_SPECS.vContainerMps },
        ],
        doorApproach: { x: slotExitClearX, y: slotExitClearY, heading: info.doorApproach.heading },
      };
      return;
    }

    if (type === "placeOnStand" || type === "pickFromStand") {
      const target = resolveStandOrLift(t.standId);
      if (!target) throw new Error(`Unknown standId: ${t.standId}`);
      if (type === "placeOnStand") {
        if (!st.carriedWcid) throw new Error("AGF not carrying cargo");
        if (target.handle.carriedWcid !== 0) throw new Error(`Stand ${t.standId} already occupied`);
      } else {
        if (st.carriedWcid) throw new Error("AGF already carrying cargo");
        if (target.handle.carriedWcid === 0) throw new Error(`Stand ${t.standId} is empty`);
      }
      for (const other of agfEntries.values()) {
        if (other === entry) continue;
        const active = other.queue?.[0];
        if (
          active?.initialized &&
          active.task?.type === type &&
          active.task?.standId === t.standId
        ) {
          throw new Error(
            type === "placeOnStand"
              ? `Stand ${t.standId} already occupied (reserved)`
              : `Stand ${t.standId} is empty (reserved)`,
          );
        }
      }
      for (const other of amrEntries.values()) {
        const active = other.queue?.[0];
        if (
          active?.initialized &&
          (active.task?.type === "placeOnStand" || active.task?.type === "pickFromStand") &&
          active.task?.standId === t.standId &&
          (active.task?.type === type ||
            active.phase === "enter" ||
            active.phase === "actuate" ||
            active.phase === "exit" ||
            active.phase === "abort_exit")
        ) {
          throw new Error(
            active.task?.type === type
              ? (type === "placeOnStand"
                ? `Stand ${t.standId} already occupied (reserved)`
                : `Stand ${t.standId} is empty (reserved)`)
              : `Stand ${t.standId} is blocked (reserved)`,
          );
        }
      }
      const sPos = target.handle.pos;
      const app = target.handle.agfApproachPos;
      const ah = wrapHeading(Math.atan2(sPos[0] - app[0], sPos[1] - app[1]));
      const [fwdX, fwdY] = headingForward(ah);
      const insertX = sPos[0] - fwdX * AGF_SPECS.cargoCenterY;
      const insertY = sPos[1] - fwdY * AGF_SPECS.cargoCenterY;
      const retractPose = { x: app[0] - fwdX * 0.20, y: app[1] - fwdY * 0.20, heading: ah, reverse: true };
      const bayObbs = buildAgfBayObbs(retractPose, { x: insertX, y: insertY }, ah);
      if (isZoneBlockedByOtherVehicles(bayObbs, entry, null)) {
        throw new Error(`Stand ${t.standId} is blocked`);
      }
      const surfaceZ = target.kind === "stand" ? STAND_SPECS.railHeightM : target.handle.heightM;

      const route = findStrictAgfPath([st.x, st.y], app, { heading: st.heading, carriedWcid: st.carriedWcid, loaded: st.loaded });
      route[route.length - 1] = { ...route[route.length - 1], heading: ah };

      item.phase = "route";
      item.data = {
        target,
        surfaceZ,
        approachPose: { x: app[0], y: app[1], heading: ah },
        insertPose: { x: insertX, y: insertY, heading: ah, docking: true },
        retractPose,
        route,
        waypointIndex: 0,
      };
      return;
    }

    if (type === "pickGroundDeployable") {
      const dGuid = t.deployableGuid >>> 0;
      const dEntry = deployables.get(dGuid);
      if (!dEntry) throw new Error(`Deployable ${dGuid} not found`);
      const dp = dEntry.model?.root?.position;
      const wp = Array.isArray(dEntry.rawPos)
        ? dEntry.rawPos
        : (Array.isArray(dEntry.worldPos) ? dEntry.worldPos : null);
      const tx = dp ? dp.x : finiteOr(wp?.[0] ?? dEntry.worldPos?.x ?? dEntry.rawPos?.x, 0);
      const ty = dp ? dp.y : finiteOr(wp?.[1] ?? dEntry.worldPos?.y ?? dEntry.rawPos?.y, 0);
      if (st.carriedWcid) throw new Error("AGF already carrying cargo");
      for (const other of agfEntries.values()) {
        if (other === entry) continue;
        const active = other.queue?.[0];
        if (
          active?.initialized &&
          active.task?.type === "pickGroundDeployable" &&
          ((active.data?.dGuid ?? (active.task?.deployableGuid >>> 0)) === dGuid)
        ) {
          throw new Error(`Deployable ${dGuid} is reserved by another AGF`);
        }
      }

      const appX = tx;
      const appY = ty - 1.8;
      const ah = 0;
      const insertX = tx;
      const insertY = ty - AGF_SPECS.cargoCenterY;
      const groundPickObbs = buildAgfBayObbs({ x: appX, y: appY }, { x: insertX, y: insertY }, ah);
      const groundPickZoneObbs = [
        ...groundPickObbs,
        { cx: tx, cy: ty, heading: ah, halfW: 0.63, halfL: 0.63 },
      ];
      for (const other of agfEntries.values()) {
        if (other === entry) continue;
        const active = other.queue?.[0];
        if (
          active?.initialized &&
          (active.task?.type === "dropToGround" || active.task?.type === "pickGroundDeployable") &&
          Array.isArray(active.data?.groundZoneObbs) &&
          obbListOverlap(groundPickZoneObbs, active.data.groundZoneObbs)
        ) {
          throw new Error(`Deployable ${dGuid} is reserved by another AGF`);
        }
      }
      if (isZoneBlockedByOtherVehicles(groundPickZoneObbs, entry, null)) {
        throw new Error(`Deployable ${dGuid} is blocked`);
      }
      const staticObs = getStaticObstacles();
      if (
        minDistanceToObstacles(tx, ty, staticObs) < 0.40 ||
        !isAgfPoseObbClear(insertX, insertY, ah, staticObs, 0.002, null, st.carriedWcid, AGF_CARRIED_TRANSIT_FORK_Z) ||
        !pathIsClear(appX, appY, insertX, insertY, staticObs, 0.05)
      ) {
        throw new Error(`AGF route unreachable for pickGroundDeployable at (${tx.toFixed(2)}, ${ty.toFixed(2)})`);
      }
      const route = findStrictAgfPath([st.x, st.y], [appX, appY], { heading: st.heading, carriedWcid: st.carriedWcid, loaded: st.loaded });
      route[route.length - 1] = { ...route[route.length - 1], heading: ah };

      item.phase = "route";
      item.data = {
        dGuid,
        dEntry,
        groundZoneObbs: groundPickZoneObbs,
        approachPose: { x: appX, y: appY, heading: ah },
        insertPose: { x: insertX, y: insertY, heading: ah, docking: true },
        retractPose: { x: appX, y: appY, heading: ah, reverse: true },
        route,
        waypointIndex: 0,
      };
      return;
    }

    if (type === "dropToGround") {
      if (!Array.isArray(t.pos) || t.pos.length < 2 || !Number.isFinite(t.pos[0]) || !Number.isFinite(t.pos[1])) {
        throw new Error("dropToGround requires valid pos");
      }
      if (!st.carriedWcid) throw new Error("AGF not carrying cargo for dropToGround");
      const targetH = wrapHeading(finiteOr(t.heading, 0));
      const [fwdX, fwdY] = headingForward(targetH);
      const px = t.pos[0];
      const py = t.pos[1];
      const pz = finiteOr(t.pos[2], 0);
      const appX = px - fwdX * 1.8;
      const appY = py - fwdY * 1.8;
      const insertX = px - fwdX * AGF_SPECS.cargoCenterY;
      const insertY = py - fwdY * AGF_SPECS.cargoCenterY;
      const groundDropObbs = buildAgfBayObbs({ x: appX, y: appY }, { x: insertX, y: insertY }, targetH);
      const groundDropZoneObbs = [
        ...groundDropObbs,
        { cx: px, cy: py, heading: targetH, halfW: 0.63, halfL: 0.63 },
      ];
      for (const other of agfEntries.values()) {
        if (other === entry) continue;
        const active = other.queue?.[0];
        if (
          active?.initialized &&
          (active.task?.type === "dropToGround" || active.task?.type === "pickGroundDeployable") &&
          Array.isArray(active.data?.groundZoneObbs) &&
          obbListOverlap(groundDropZoneObbs, active.data.groundZoneObbs)
        ) {
          throw new Error(`Drop target (${px.toFixed(2)}, ${py.toFixed(2)}) is reserved by another AGF`);
        }
      }
      if (isZoneBlockedByOtherVehicles(groundDropZoneObbs, entry, null)) {
        throw new Error(`Drop target (${px.toFixed(2)}, ${py.toFixed(2)}) is blocked`);
      }
      const staticObs = getStaticObstacles();
      if (
        minDistanceToObstacles(px, py, staticObs) < 0.40 ||
        !isAgfPoseObbClear(insertX, insertY, targetH, staticObs, 0.002, null, st.carriedWcid, AGF_CARRIED_TRANSIT_FORK_Z) ||
        !pathIsClear(appX, appY, insertX, insertY, staticObs, 0.05)
      ) {
        throw new Error(`AGF route unreachable for dropToGround at (${px.toFixed(2)}, ${py.toFixed(2)})`);
      }

      const route = findStrictAgfPath([st.x, st.y], [appX, appY], { heading: st.heading, carriedWcid: st.carriedWcid, loaded: st.loaded });
      route[route.length - 1] = { ...route[route.length - 1], heading: targetH };

      item.phase = "route";
      item.data = {
        dropPos: [px, py, pz],
        dropHeading: targetH,
        groundZoneObbs: groundDropZoneObbs,
        approachPose: { x: appX, y: appY, heading: targetH },
        insertPose: { x: insertX, y: insertY, heading: targetH, docking: true },
        retractPose: { x: appX, y: appY, heading: targetH, reverse: true },
        route,
        waypointIndex: 0,
      };
      return;
    }

    throw new Error(`Unknown AGF task type: ${type}`);
  }

  function queryLiveProximity(agentId, selfRadius, x, y, heading = 0.0, options = {}, activeCmd = null) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return {
        yieldLevel: "clear",
        stop: false,
        slow: false,
        speedScale: 1.0,
        nearestDist: Infinity,
        nearestAgentId: null,
        blockingAgent: null,
      };
    }

    const selfIsAgf = typeof agentId === "string" && agentId.startsWith("agf:");
    const selfEntry = typeof agentId === "string"
      ? (selfIsAgf ? agfEntries.get(agentId.slice(4)) : (agentId.startsWith("amr:") ? amrEntries.get(agentId.slice(4)) : null))
      : null;
    const baseStopDist = Number.isFinite(options?.stopDistM) ? options.stopDistM : DEFAULT_GRID_OPTS.stopDistM;
    const baseSlowDist = Number.isFinite(options?.slowDistM) ? options.slowDistM : DEFAULT_GRID_OPTS.slowDistM;
    const h = Number.isFinite(heading) ? heading : 0.0;
    const physHeading = selfEntry ? selfEntry.state.heading : h;
    const motionHeading = (!selfIsAgf && Number.isFinite(activeCmd?.speed) && activeCmd.speed < -0.02)
      ? wrapHeading(physHeading + Math.PI)
      : h;
    const fx = Math.sin(motionHeading);
    const fy = Math.cos(motionHeading);

    const activeWp = Array.isArray(activeCmd?.waypoints)
      ? activeCmd.waypoints[activeCmd.waypointIndex ?? 0]
      : null;
    const escapePeers = activeWp?._escapePeers instanceof Set ? activeWp._escapePeers : null;
    const isEscaping = Boolean(activeWp?._deadlockEscape);
    const cmdTarget = activeCmd?.targetPose || activeCmd?.reverseTargetPose || (
      Array.isArray(activeCmd?.waypoints) && (activeCmd.waypointIndex ?? 0) >= activeCmd.waypoints.length - 1
        ? activeCmd.waypoints[activeCmd.waypoints.length - 1]
        : null
    );
    const distToCmdTarget = (cmdTarget && Number.isFinite(cmdTarget.x) && Number.isFinite(cmdTarget.y))
      ? Math.hypot(cmdTarget.x - x, cmdTarget.y - y)
      : Infinity;

    let minDist = Infinity;
    let nearestId = null;
    let mustStop = false;
    let mustSlow = false;
    let blockingAgent = null;
    let blockingDist = Infinity;

    const considerAgent = (otherId, otherRadius, ox, oy, oHeading, oSpeed, oYieldStopped, otherEntry = null) => {
      if (otherId === agentId) return;
      if (!Number.isFinite(ox) || !Number.isFinite(oy)) return;
      const dx = ox - x;
      const dy = oy - y;
      const d = Math.hypot(dx, dy);
      const minAllowed = selfRadius + otherRadius;
      const otherIsAgf = typeof otherId === "string" && otherId.startsWith("agf:");
      const otherIsAmr = typeof otherId === "string" && otherId.startsWith("amr:");
      const isAmrPair = selfRadius <= 0.58 && otherRadius <= 0.58;
      const isMixedAgfAmr = Boolean(selfEntry && otherEntry && ((selfIsAgf && otherIsAmr) || (!selfIsAgf && otherIsAgf)));
      const isAgfPair = Boolean(selfEntry && otherEntry && selfIsAgf && otherIsAgf);
      const useAgfSat = Boolean(isMixedAgfAmr || isAgfPair);
      const bothLoaded = Boolean(isAmrPair && selfEntry?.state?.carriedWcid && otherEntry?.state?.carriedWcid);
      const forwardCos = d > 1e-6 ? (dx * fx + dy * fy) / d : 1.0;
      const isEscapePeer = Boolean(activeWp && (activeWp._escapeFrom === otherId || (escapePeers && escapePeers.has(otherId))));
      const escapingPass = Boolean(isEscapePeer && Math.abs(forwardCos) < 0.65);
      const nominalStop = isAmrPair
        ? (bothLoaded ? Math.max(1.60, minAllowed + 0.48) : Math.max(1.32, minAllowed + 0.20))
        : Math.max(baseStopDist, minAllowed + 0.22);
      const stopThresh = escapingPass
        ? (bothLoaded ? Math.max(1.56, minAllowed + 0.44) : (minAllowed + 0.08))
        : nominalStop;
      const slowThresh = Math.max(baseSlowDist, stopThresh + 0.90);

      const ofx = Math.sin(finiteOr(oHeading, 0));
      const ofy = Math.cos(finiteOr(oHeading, 0));
      const otherForwardCos = d > 1e-6 ? ((-dx) * ofx + (-dy) * ofy) / d : 1.0;
      const otherMoving = Math.abs(finiteOr(oSpeed, 0)) > 0.05 && !oYieldStopped;

      let movingAway = forwardCos < -0.25;
      const wpYawErr = (isAmrPair && isEscaping && activeWp && Number.isFinite(activeWp.x) && Number.isFinite(activeWp.y))
        ? Math.abs(wrapPi(Math.atan2(activeWp.x - x, activeWp.y - y) - motionHeading))
        : 0;
      let amrEscapingPivot = Boolean(
        isAmrPair &&
        isEscaping &&
        wpYawErr > 0.25 &&
        (!otherMoving ? (d > minAllowed + 0.04 || (selfEntry && otherEntry)) : d > minAllowed + 0.08),
      );
      if (!movingAway && activeWp && Number.isFinite(activeWp.x) && Number.isFinite(activeWp.y)) {
        if (isAmrPair && isEscaping && (d > minAllowed + 0.04 || (!otherMoving && selfEntry && otherEntry))) {
          const ex = activeWp.x - x;
          const ey = activeWp.y - y;
          const eLen = Math.hypot(ex, ey);
          const escDot = eLen > 1e-4 ? (ex * dx + ey * dy) / (eLen * Math.max(d, 1e-4)) : 1.0;
          if ((isEscapePeer && escDot <= 0.25) || (!otherMoving && escDot <= 0.45 && (d > minAllowed + 0.06 || (selfEntry && otherEntry)))) {
            movingAway = true;
          }
        } else if (isEscapePeer && (d >= minAllowed + 0.05 || (useAgfSat && d >= minAllowed))) {
          const ex = activeWp.x - x;
          const ey = activeWp.y - y;
          const eLen = Math.hypot(ex, ey);
          const escDot = eLen > 1e-4 ? (ex * dx + ey * dy) / (eLen * Math.max(d, 1e-4)) : 1.0;
          const maxDot = d < minAllowed + 0.05
            ? -0.10
            : d <= minAllowed + 0.08
              ? ((!otherMoving && d > minAllowed + 0.065) ? 0.05 : -0.05)
              : 0.25;
          if (escDot <= maxDot) {
            movingAway = true;
          }
        }
      }

      const otherApproaching = otherMoving && otherForwardCos > 0.15;

      // Early deterministic right-of-way yield when two moving vehicles approach a crossing head-on/90 deg
      const yieldWaitDist = isAmrPair ? stopThresh + 0.35 : Math.max(stopThresh + 0.65, 2.15);
      const bothApproaching = isAmrPair
        ? (forwardCos > 0.45 && otherForwardCos > 0.45 && otherMoving)
        : (forwardCos >= -0.05 && otherForwardCos >= -0.05 && otherMoving);
      const lowerPriorityYield = bothApproaching && (
        forwardCos > otherForwardCos + 0.18 ||
        (Math.abs(forwardCos - otherForwardCos) <= 0.18 && String(agentId) > String(otherId))
      );

      let agentStop = false;
      let agentSlow = false;
      let parallelSideClear = false;
      let terminalTargetPoseClear = false;

      if (isAmrPair && d <= stopThresh && selfEntry && otherEntry) {
        const otherObbs = getEntryWorldObbs(otherEntry, false);
        const selfCarried = selfEntry.state.carriedWcid ?? 0;
        const selfTt = selfEntry.state.turntableYawRad ?? 0;
        const isSelfPoseClear = (px, py, ph, pad = 0.012) =>
          !vehiclesSatOverlap2D(getAmrWorldObbs(px, py, ph, selfCarried, selfTt), otherObbs, pad);
        const isSelfRotClear = (px, py, hFrom, hTo, pad = 0.012) => {
          if (!isSelfPoseClear(px, py, hFrom, pad) || !isSelfPoseClear(px, py, hTo, pad)) return false;
          const diff = wrapPi(hTo - hFrom);
          const steps = Math.max(1, Math.ceil(Math.abs(diff) / 0.14));
          for (let s = 1; s < steps; s++) {
            if (!isSelfPoseClear(px, py, wrapHeading(hFrom + diff * (s / steps)), pad)) return false;
          }
          return true;
        };
        const isSelfSegClear = (ax, ay, bx, by, ph, pad = 0.012) => {
          const segLen = Math.hypot(bx - ax, by - ay);
          const steps = Math.max(2, Math.ceil(segLen / 0.15));
          for (let s = 1; s <= steps; s++) {
            const t = s / steps;
            if (!isSelfPoseClear(ax + (bx - ax) * t, ay + (by - ay) * t, ph, pad)) return false;
          }
          return true;
        };

        if (amrEscapingPivot && activeWp) {
          const escBear = Math.atan2(activeWp.x - x, activeWp.y - y);
          if (!isSelfRotClear(x, y, physHeading, escBear, 0.004)) {
            amrEscapingPivot = false;
          }
        }
        if (movingAway) {
          if (isSelfPoseClear(x, y, physHeading, 0.004) && activeWp && Number.isFinite(activeWp.x) && Number.isFinite(activeWp.y) && !(Number.isFinite(activeCmd?.speed) && activeCmd.speed < -0.02)) {
            const dWp = Math.hypot(activeWp.x - x, activeWp.y - y);
            if (dWp > AMR_SPECS.dockPosTolM) {
              const bear = Math.atan2(activeWp.x - x, activeWp.y - y);
              if (Math.abs(wrapPi(bear - physHeading)) > 0.25 && !isSelfRotClear(x, y, physHeading, bear, 0.004)) {
                movingAway = false;
              }
            }
          }
        }

        if (!otherMoving) {
          if (cmdTarget && distToCmdTarget <= 0.85) {
            if (distToCmdTarget <= AMR_SPECS.dockPosTolM) {
              terminalTargetPoseClear = Number.isFinite(cmdTarget.heading)
                ? isSelfRotClear(x, y, physHeading, cmdTarget.heading, 0.003)
                : isSelfPoseClear(x, y, physHeading, 0.003);
            } else if (Number.isFinite(activeCmd?.speed) && activeCmd.speed < -0.02) {
              terminalTargetPoseClear = isSelfPoseClear(x, y, physHeading, 0.003) &&
                isSelfSegClear(x, y, cmdTarget.x, cmdTarget.y, physHeading, 0.003);
            } else {
              const bear = Math.atan2(cmdTarget.x - x, cmdTarget.y - y);
              terminalTargetPoseClear =
                isSelfRotClear(x, y, physHeading, bear, 0.003) &&
                isSelfSegClear(x, y, cmdTarget.x, cmdTarget.y, bear, 0.003) &&
                (!Number.isFinite(cmdTarget.heading) || isSelfRotClear(cmdTarget.x, cmdTarget.y, bear, cmdTarget.heading, 0.003));
            }
          }

          if (!terminalTargetPoseClear && Math.abs(dx * (-fy) + dy * fx) >= (isMixedAgfAmr ? 1.20 : 1.00) && isSelfPoseClear(x, y, physHeading, 0.012)) {
            if (Number.isFinite(activeCmd?.speed) && activeCmd.speed < -0.02) {
              parallelSideClear = isSelfSegClear(x, y, x + fx * 0.55, y + fy * 0.55, physHeading, 0.012);
            } else if (distToCmdTarget > 0.45 && (activeCmd?.targetPose || activeWp)) {
              const navTgt = activeCmd?.targetPose || activeWp;
              const nDist = (navTgt && Number.isFinite(navTgt.x) && Number.isFinite(navTgt.y))
                ? Math.hypot(navTgt.x - x, navTgt.y - y)
                : 0;
              if (nDist > AMR_SPECS.dockPosTolM) {
                const nBear = Math.atan2(navTgt.x - x, navTgt.y - y);
                const stepD = Math.min(nDist, 0.55);
                parallelSideClear =
                  isSelfRotClear(x, y, physHeading, nBear, 0.012) &&
                  isSelfSegClear(x, y, x + Math.sin(nBear) * stepD, y + Math.cos(nBear) * stepD, nBear, 0.012);
              }
            } else if (distToCmdTarget > 0.45 && forwardCos <= 0.35) {
              parallelSideClear = true;
            }
          }
        }
      }

      let satHandled = false;
      const anyAmrLoaded = Boolean(isAmrPair && (selfEntry?.state?.carriedWcid || otherEntry?.state?.carriedWcid));
      if (isAmrPair && anyAmrLoaded && selfEntry && otherEntry && d <= (bothLoaded ? 1.65 : 1.48) && !movingAway && !amrEscapingPivot && !parallelSideClear && !terminalTargetPoseClear) {
        const amrOtherObbs = getEntryWorldObbs(otherEntry, false);
        const selfC = selfEntry.state.carriedWcid ?? 0;
        const selfTt = selfEntry.state.turntableYawRad ?? 0;
        const amrCurOk = !vehiclesSatOverlap2D(getAmrWorldObbs(x, y, physHeading, selfC, selfTt), amrOtherObbs, 0.015);
        const d1 = Math.min(0.24, distToCmdTarget);
        const amrS1Ok = d1 <= 0.02 ? amrCurOk : !vehiclesSatOverlap2D(getAmrWorldObbs(x + fx * d1, y + fy * d1, physHeading, selfC, selfTt), amrOtherObbs, 0.015);
        const amrOtherActive = Boolean(otherEntry?.activeCmd || (otherEntry?.queue?.length ?? 0) > 0);
        const amrYieldLookahead = !amrOtherActive
          ? true
          : otherMoving
            ? (lowerPriorityYield || (forwardCos > otherForwardCos + 0.12))
            : (oYieldStopped
              ? (Boolean(selfEntry?.state?.yieldStopped) && String(agentId) > String(otherId))
              : (otherEntry?.state?.statusMode === "lifting" || String(agentId) > String(otherId)));
        if (!amrCurOk || (!amrS1Ok && amrYieldLookahead)) {
          agentStop = true;
          satHandled = true;
        } else if (!amrOtherActive && d > minAllowed + 0.08 && d <= stopThresh) {
          const navTgtAmr = cmdTarget || activeWp;
          const hasNavTgtAmr = Boolean(navTgtAmr && Number.isFinite(navTgtAmr.x) && Number.isFinite(navTgtAmr.y));
          const nDistAmr = hasNavTgtAmr
            ? Math.hypot(navTgtAmr.x - x, navTgtAmr.y - y)
            : Infinity;
          const isRevAmr = Number.isFinite(activeCmd?.speed) && activeCmd.speed < -0.02;
          const moveBear = (hasNavTgtAmr && !isRevAmr && nDistAmr > AMR_SPECS.dockPosTolM)
            ? Math.atan2(navTgtAmr.x - x, navTgtAmr.y - y)
            : physHeading;
          const moveFx = isRevAmr ? fx : Math.sin(moveBear);
          const moveFy = isRevAmr ? fy : Math.cos(moveBear);
          const hasActiveMoveAmr = hasNavTgtAmr || Math.abs(finiteOr(activeCmd?.speed, 0)) > 0.02;
          const d2 = hasActiveMoveAmr ? Math.min(0.55, nDistAmr) : 0;
          let pathSatClear =
            !vehiclesSatOverlap2D(getAmrWorldObbs(x, y, physHeading, selfC, selfTt), amrOtherObbs, 0.04) &&
            (d2 <= 0.02 || !vehiclesSatOverlap2D(getAmrWorldObbs(x + moveFx * d2, y + moveFy * d2, moveBear, selfC, selfTt), amrOtherObbs, 0.04));
          if (pathSatClear && !isRevAmr && Math.abs(wrapPi(moveBear - physHeading)) > 0.20) {
            const diff = wrapPi(moveBear - physHeading);
            const steps = Math.max(2, Math.ceil(Math.abs(diff) / 0.25));
            for (let s = 1; s < steps; s++) {
              if (vehiclesSatOverlap2D(getAmrWorldObbs(x, y, wrapHeading(physHeading + diff * (s / steps)), selfC, selfTt), amrOtherObbs, 0.04)) {
                pathSatClear = false;
                break;
              }
            }
          }
          if (pathSatClear) {
            agentSlow = true;
            satHandled = true;
          }
        }
      }
      if (useAgfSat && d <= (isAgfPair ? 4.25 : 2.85)) {
        const otherObbs = getEntryWorldObbs(otherEntry, otherIsAgf);
        const isSelfSatClear = (px, py, ph, pad = 0.025) =>
          !vehiclesSatOverlap2D(getEntryWorldObbs(selfEntry, selfIsAgf, { x: px, y: py, heading: ph }), otherObbs, pad);
        const navTgt = cmdTarget || activeWp;
        const distToNav = (navTgt && Number.isFinite(navTgt.x) && Number.isFinite(navTgt.y))
          ? Math.hypot(navTgt.x - x, navTgt.y - y)
          : Infinity;
        const stopAtNav = (cmdTarget || activeWp?._stopAtWaypoint || activeWp?.docking || (activeWp && (!Array.isArray(activeCmd?.waypoints) || (activeCmd.waypointIndex ?? 0) >= activeCmd.waypoints.length - 1) && Number.isFinite(activeWp.heading))) ? distToNav : Infinity;
        const maxFwd = Number.isFinite(distToCmdTarget) ? Math.min(0.90, distToCmdTarget) : Math.min(0.90, stopAtNav);
        const isSelfReversing = Boolean(selfIsAgf && Math.abs(wrapPi(motionHeading - physHeading)) > 1.5);
        let navYawErr = 0;
        if (navTgt && Number.isFinite(navTgt.x) && Number.isFinite(navTgt.y) && distToNav > 0.15) {
          let bear = Math.atan2(navTgt.x - x, navTgt.y - y);
          if (isSelfReversing) bear = wrapHeading(bear + Math.PI);
          navYawErr = wrapPi(bear - physHeading);
        } else if (cmdTarget && Number.isFinite(cmdTarget.heading)) {
          navYawErr = wrapPi(cmdTarget.heading - physHeading);
        }
        const isAmrPivot = Boolean(!selfIsAgf && Math.abs(navYawErr) > 0.35 && !(Number.isFinite(activeCmd?.speed) && activeCmd.speed < -0.02));
        const amrNavBear = isAmrPivot ? wrapHeading(physHeading + navYawErr) : physHeading;
        const steerFrac = clamp(Math.abs(navYawErr), 0, 0.55);
        const dAng2 = selfIsAgf ? clamp(navYawErr, -0.10, 0.10) : 0;
        const dAng3 = selfIsAgf ? clamp(navYawErr, -0.18, 0.18) : 0;
        const h2Phys = isAmrPivot ? amrNavBear : wrapHeading(physHeading + dAng2);
        const h3Phys = isAmrPivot ? amrNavBear : wrapHeading(physHeading + dAng3);
        const h2Move = isAmrPivot ? amrNavBear : wrapHeading(motionHeading + dAng2);
        const h3Move = isAmrPivot ? amrNavBear : wrapHeading(motionHeading + dAng3);
        const s1 = Math.min(0.24, maxFwd);
        const s2 = Math.min(0.52, maxFwd);
        const s3 = Math.min(0.85, maxFwd);
        const curClear = isSelfSatClear(x, y, physHeading, movingAway ? 0.0 : 0.02);
        const s1Fx = isAmrPivot ? Math.sin(amrNavBear) : fx;
        const s1Fy = isAmrPivot ? Math.cos(amrNavBear) : fy;
        const step1Clear = s1 <= 0.02 ? curClear : isSelfSatClear(x + s1Fx * s1, y + s1Fy * s1, isAmrPivot ? amrNavBear : physHeading, movingAway ? 0.002 : 0.02);
        const step2Clear = s2 <= s1 + 0.02 ? step1Clear : isSelfSatClear(x + Math.sin(h2Move) * s2, y + Math.cos(h2Move) * s2, h2Phys, 0.02);
        const step3Clear = s3 <= s2 + 0.02 ? step2Clear : isSelfSatClear(x + Math.sin(h3Move) * s3, y + Math.cos(h3Move) * s3, h3Phys, 0.02);
        let rotStepClear = true;
        if (isAmrPivot) {
          const steps = Math.max(2, Math.ceil(Math.abs(navYawErr) / 0.20));
          for (let s = 1; s <= steps; s++) {
            if (!isSelfSatClear(x, y, wrapHeading(physHeading + navYawErr * (s / steps)), 0.02)) {
              rotStepClear = false;
              break;
            }
          }
        } else if (Math.abs(navYawErr) > 0.08 && steerFrac > 0.02) {
          for (const frac of [0.14, 0.30]) {
            const dAng = clamp(navYawErr, -frac, frac);
            const rhPhys = wrapHeading(physHeading + dAng);
            const rhMove = wrapHeading(motionHeading + dAng);
            const adv = (selfIsAgf && distToNav > 0.02) ? Math.min(frac * 0.95, maxFwd) : 0.0;
            if (!isSelfSatClear(x + Math.sin(rhMove) * adv, y + Math.cos(rhMove) * adv, rhPhys, 0.02)) {
              rotStepClear = false;
              break;
            }
          }
        }
        const amrPullTarget = (!selfIsAgf && !isAmrPivot && Number.isFinite(activeCmd?.speed) && Math.abs(activeCmd.speed) > 0.02 && Math.abs(finiteOr(activeCmd?.omega, 0)) < 0.05 && !activeCmd?.waypoints && !activeCmd?.targetPose)
          ? (selfEntry?.queue?.[0]?.data?.deadlockPull || selfEntry?.queue?.[0]?.data?.departPull || null)
          : null;
        const pullCheckD = amrPullTarget
          ? Math.min(0.45, Math.max(0.15, Math.hypot(amrPullTarget.x - x, amrPullTarget.y - y)))
          : Math.min(0.45, maxFwd);
        const isAmrStraightPull = Boolean(
          amrPullTarget &&
          !otherMoving &&
          isSelfSatClear(x, y, physHeading, 0.0) &&
          isSelfSatClear(x + s1Fx * Math.min(s1, pullCheckD), y + s1Fy * Math.min(s1, pullCheckD), physHeading, 0.002) &&
          isSelfSatClear(x + s1Fx * pullCheckD, y + s1Fy * pullCheckD, physHeading, 0.015),
        );
        const safeMovingAway = (movingAway && step1Clear && (
          curClear ||
          isSelfSatClear(x + fx * Math.min(0.45, maxFwd), y + fy * Math.min(0.45, maxFwd), physHeading, 0.002)
        )) || isAmrStraightPull;
        const otherActive = Boolean(otherEntry?.activeCmd || (otherEntry?.queue?.length ?? 0) > 0);
        const selfYieldStopped = Boolean(selfEntry?.state?.yieldStopped);
        const yieldOnLookahead = !otherActive
          ? true
          : otherMoving
            ? (lowerPriorityYield || (forwardCos > otherForwardCos + 0.12))
            : (oYieldStopped
              ? (selfYieldStopped && String(agentId) > String(otherId))
              : (otherEntry?.state?.statusMode === "lifting" || String(agentId) > String(otherId)));
        if (!curClear || !step1Clear) {
          if (!safeMovingAway) agentStop = true;
          else agentSlow = true;
          satHandled = true;
        } else if (((!safeMovingAway && (!step2Clear || !step3Clear)) || (!rotStepClear && !(safeMovingAway && (isEscaping || Math.abs(navYawErr) <= 0.45)))) && yieldOnLookahead) {
          agentStop = true;
          satHandled = true;
        } else if (
          d <= slowThresh && (
            !isSelfSatClear(x, y, physHeading, 0.24) ||
            !isSelfSatClear(x + Math.sin(h2Move) * s2, y + Math.cos(h2Move) * s2, h2Phys, 0.18) ||
            !step2Clear || !step3Clear || !rotStepClear
          )
        ) {
          agentSlow = true;
        }
        const minSatLatSep = (selfEntry?.state?.carriedWcid || otherEntry?.state?.carriedWcid) ? 1.32 : 1.22;
        const movingAwayFromOther =
          Math.hypot((x + fx * 0.24) - ox, (y + fy * 0.24) - oy) > d + 0.01 &&
          Math.hypot((x + fx * 0.60) - ox, (y + fy * 0.60) - oy) > d + 0.02;
        if (
          isAgfPair &&
          !agentStop &&
          d >= minAllowed + 0.06 &&
          Math.abs(dx * (-fy) + dy * fx) >= minSatLatSep &&
          step2Clear && step3Clear && rotStepClear
        ) {
          satHandled = true;
        } else if (
          isMixedAgfAmr &&
          !agentStop &&
          ((d >= minAllowed + 0.04 && (!otherMoving || Math.abs(dx * (-fy) + dy * fx) >= 1.15)) ||
            (!selfIsAgf && !otherMoving && (isAmrStraightPull || (isEscaping && movingAwayFromOther)))) &&
          curClear && step1Clear && (isAmrStraightPull || (step2Clear && step3Clear && rotStepClear)) &&
          (selfIsAgf || Math.abs(navYawErr) <= 0.30 || (() => {
            const steps = Math.max(2, Math.ceil(Math.abs(navYawErr) / 0.25));
            for (let s = 1; s <= steps; s++) {
              if (!isSelfSatClear(x, y, wrapHeading(physHeading + navYawErr * (s / steps)), 0.02)) return false;
            }
            return true;
          })())
        ) {
          satHandled = true;
        }
      }

      if (satHandled) {
        // Handled by exact SAT-OBB AGF/AMR & AGF/AGF check above
      } else if (d <= minAllowed + 0.08) {
        if (amrEscapingPivot || parallelSideClear || terminalTargetPoseClear) {
          agentSlow = true;
        } else if (!movingAway || (otherApproaching && d <= minAllowed + 0.04)) {
          agentStop = true;
        } else {
          agentSlow = true;
        }
      } else if (d <= stopThresh) {
        if (amrEscapingPivot || parallelSideClear || terminalTargetPoseClear) {
          agentSlow = true;
        } else if (!movingAway || (otherApproaching && d <= minAllowed + 0.16)) {
          agentStop = true;
        } else {
          agentSlow = true;
        }
      } else if (!escapingPass && !isEscaping && d <= yieldWaitDist && lowerPriorityYield) {
        agentStop = true;
      } else if (d <= slowThresh) {
        if (forwardCos >= -0.35 || otherApproaching) {
          agentSlow = true;
        }
      }

      if (agentStop || agentSlow) {
        if (d < minDist) {
          minDist = d;
          nearestId = otherId;
        }
      }
      if (agentStop) {
        mustStop = true;
        if (d < blockingDist) {
          blockingDist = d;
          blockingAgent = { id: otherId, x: ox, y: oy, radius: otherRadius, d, forwardCos };
        }
      } else if (agentSlow) {
        mustSlow = true;
      }
    };

    for (const a of agfEntries.values()) {
      const s = a.state;
      considerAgent(s.agentId, AGF_SPECS.hullRadiusM, s.x, s.y, s.heading, s.speed, s.yieldStopped, a);
    }
    for (const m of amrEntries.values()) {
      const s = m.state;
      considerAgent(s.agentId, AMR_SPECS.hullRadiusM, s.x, s.y, s.heading, s.speed, s.yieldStopped, m);
    }
    for (const [otherId, other] of grid._agents.entries()) {
      if (otherId === agentId) continue;
      if (otherId.startsWith("agf:") && agfEntries.has(otherId.slice(4))) continue;
      if (otherId.startsWith("amr:") && amrEntries.has(otherId.slice(4))) continue;
      considerAgent(otherId, finiteOr(other.radius, DEFAULT_GRID_OPTS.defaultRadiusM), other.x, other.y, other.heading, 0, false);
    }

    const slow = !mustStop && mustSlow;
    return {
      yieldLevel: mustStop ? "stop" : slow ? "slow" : "clear",
      stop: mustStop,
      slow,
      speedScale: mustStop ? 0.0 : slow ? 0.45 : 1.0,
      nearestDist: minDist,
      nearestAgentId: nearestId,
      blockingAgent,
    };
  }

  function makeProximityGridFor(selfRadius, activeCmd) {
    return {
      queryProximity(agentId, x, y, heading, options) {
        return queryLiveProximity(agentId, selfRadius, x, y, heading, options, activeCmd);
      },
      claim(...args) { return grid.claim(...args); },
      release(...args) { return grid.release(...args); },
    };
  }

  function applyDeadlockBreaker(st, selfRadius, item, cmd, dt, isAgf, obstacles = null) {
    if (st.yieldStopped) {
      st.stuckTime += dt;
    } else {
      st.stuckTime = 0;
      st._dlRetryAt = null;
      st._dlFailCount = 0;
      if (st._dlRepeatCount && Math.hypot(st.x - (st._lastDlX ?? st.x), st.y - (st._lastDlY ?? st.y)) > 7.5) {
        st._dlRepeatCount = 0;
        st._lastDlEscapes = [];
      }
      if (st._dlOscCount && Math.hypot(st.x - (st._dlAnchorX ?? st.x), st.y - (st._dlAnchorY ?? st.y)) > 3.2) {
        st._dlOscCount = 0;
        st._dlAnchorX = st.x;
        st._dlAnchorY = st.y;
      }
    }
    if (item?.phase !== "drive" && item?.phase !== "route") return cmd;
    const dataWps = (item?.phase === "drive" && Array.isArray(item?.data?.waypoints))
      ? item.data.waypoints
      : (item?.phase === "route" && Array.isArray(item?.data?.route))
        ? item.data.route
        : null;
    const dataWpIdx = item?.data?.waypointIndex ?? 0;
    const activeDataWp = dataWps ? dataWps[dataWpIdx] : null;
    const stopWpFallback = Boolean(
      isAgf &&
      !cmd.waypoints &&
      cmd.targetPose &&
      dataWps &&
      activeDataWp?._stopAtWaypoint &&
      !activeDataWp?.docking &&
      !cmd.docking &&
      dataWpIdx < dataWps.length - 1,
    );
    const dlCmd = stopWpFallback
      ? (() => { const c = { ...cmd, waypoints: dataWps, waypointIndex: dataWpIdx }; delete c.targetPose; return c; })()
      : cmd;
    if (!dlCmd.waypoints || dlCmd.targetPose) return cmd;

    const activeWp = Array.isArray(dlCmd.waypoints) ? dlCmd.waypoints[dlCmd.waypointIndex ?? 0] : null;
    const isReversingCmd = Boolean(activeWp?.reverse || dlCmd.reverse);
    const queryH = isReversingCmd ? wrapHeading(st.heading + Math.PI) : st.heading;
    const curProx = queryLiveProximity(st.agentId, selfRadius, st.x, st.y, queryH, {}, dlCmd);
    const blk = curProx.blockingAgent;
    let effBlk = blk;
    let effBlkDist = blk ? blk.d : Infinity;
    const nearbyPeers = [];
    const nearbyPeerIds = new Set();
    const recordNearbyPeer = (otherId, otherRadius, ox, oy, otherEntry = null, otherIsAgf = false) => {
      if (otherId === st.agentId || !Number.isFinite(ox) || !Number.isFinite(oy)) return;
      const d = Math.hypot(ox - st.x, oy - st.y);
      if (d <= 2.4) {
        nearbyPeers.push({ id: otherId, x: ox, y: oy, radius: otherRadius, d });
        nearbyPeerIds.add(otherId);
      }
      if (!blk && d <= selfRadius + otherRadius + 0.24 && d < effBlkDist) {
        effBlkDist = d;
        effBlk = { id: otherId, x: ox, y: oy, radius: otherRadius, d };
      } else if (
        isAgf &&
        !blk &&
        st.statusMode === "blocked" &&
        otherEntry &&
        d <= (otherIsAgf ? 4.30 : 3.10) &&
        d < effBlkDist &&
        vehiclesSatOverlap2D(getAgfWorldObbs(st.x, st.y, st.heading, st.carriedWcid), getEntryWorldObbs(otherEntry, otherIsAgf), 0.16)
      ) {
        effBlkDist = d;
        effBlk = { id: otherId, x: ox, y: oy, radius: otherRadius, d };
      }
    };
    for (const a of agfEntries.values()) {
      const s = a.state;
      recordNearbyPeer(s.agentId, AGF_SPECS.hullRadiusM, s.x, s.y, a, true);
    }
    for (const m of amrEntries.values()) {
      const s = m.state;
      recordNearbyPeer(s.agentId, AMR_SPECS.hullRadiusM, s.x, s.y, m, false);
    }
    const waitThresh = effBlk && String(st.agentId) < String(effBlk.id) ? 0.40 : 0.85;
    if (st.stuckTime <= waitThresh) return cmd;
    if (Number.isFinite(st._dlRetryAt) && st.stuckTime < st._dlRetryAt) return cmd;

    const staticObs = obstacles || getStaticObstacles();
    const minClear = selfRadius + 0.12;
    const arcClear = selfRadius + 0.02;
    const startMinDist = minDistanceToObstacles(st.x, st.y, staticObs);
    let startObs = null;
    for (let i = 0; i < staticObs.length; i++) {
      const b = staticObs[i];
      if (!b) continue;
      const cx = clamp(st.x, b.x0, b.x1);
      const cy = clamp(st.y, b.y0, b.y1);
      if (Math.hypot(st.x - cx, st.y - cy) < minClear) {
        if (!startObs) startObs = new Set();
        startObs.add(b);
      }
    }

    const [rx, ry] = headingRight(st.heading);
    const [fx, fy] = headingForward(st.heading);
    const lat = isAgf ? 0.80 : 0.95;
    let rackMinX = Infinity;
    let rackMaxX = -Infinity;
    let rackMinY = Infinity;
    let rackMaxY = -Infinity;
    if (isAgf) {
      for (const r of racks.values()) {
        const b = r.worldBounds;
        if (!b) continue;
        if (b.minX < rackMinX) rackMinX = b.minX;
        if (b.maxX > rackMaxX) rackMaxX = b.maxX;
        if (b.minY < rackMinY) rackMinY = b.minY;
        if (b.maxY > rackMaxY) rackMaxY = b.maxY;
      }
    }
    const hasRackBounds = rackMinX < Infinity && rackMaxX > -Infinity && rackMinY < Infinity && rackMaxY > -Infinity;
    const inNarrowRackAisle = isAgf && hasRackBounds &&
      st.x >= rackMinX - 1.2 && st.x <= rackMaxX + 1.2 &&
      st.y >= rackMinY && st.y <= rackMaxY;
    let aisleCenterY = null;
    if (inNarrowRackAisle) {
      const oyAisle = layout?.origin?.[1] ?? NE_FLATLAND_SITE.origin[1];
      const aisleSet = layout?.aisles?.length
        ? layout.aisles
        : [{ y: oyAisle + 3.0 }, { y: oyAisle - 3.0 }, { y: oyAisle - 9.0 }];
      let bestDy = 1.6;
      for (let i = 0; i < aisleSet.length; i++) {
        const dy = Math.abs(st.y - aisleSet[i].y);
        if (dy < bestDy) {
          bestDy = dy;
          aisleCenterY = aisleSet[i].y;
        }
      }
    }
    const aisleClampScurves = [];
    const aisleExitPulloutCands = [];
    const inAisleX = aisleCenterY !== null && Math.abs(fx) > 0.7;
    const effBlkEntry = effBlk ? [...agfEntries.values()].find((a) => a.state.agentId === effBlk.id) : null;
    const effBlkIdle = Boolean(effBlkEntry && effBlkEntry.queue.length === 0 && (effBlkEntry.state._idleSec ?? 0) >= 0.25);
    const effBlkOpposite = Boolean(effBlkEntry && (Math.sin(effBlkEntry.state.heading) * fx + Math.cos(effBlkEntry.state.heading) * fy) < -0.35);
    if (inAisleX) {
      const prefTgtY = fx > 0 ? aisleCenterY - 0.88 : aisleCenterY + 0.88;
      const oppTgtY = fx > 0 ? aisleCenterY + 0.88 : aisleCenterY - 0.88;
      const laneTargets = [prefTgtY, oppTgtY, aisleCenterY];
      const alreadySeparatedOpposite = Boolean(
        effBlk &&
        effBlkOpposite &&
        Math.abs(effBlk.x - st.x) < 5.5 &&
        (st.y - aisleCenterY) * (oppTgtY - aisleCenterY) > 0.25 &&
        (effBlk.y - aisleCenterY) * (prefTgtY - aisleCenterY) > 0.25,
      );
      if (effBlk && (alreadySeparatedOpposite || (!effBlkOpposite && Math.abs(effBlk.y - prefTgtY) < 0.45 && Math.abs(effBlk.x - st.x) < 4.0))) {
        laneTargets[0] = oppTgtY;
        laneTargets[1] = prefTgtY;
      }
      const finalDstInAisle = Array.isArray(dlCmd.waypoints) && dlCmd.waypoints.length > 0
        ? dlCmd.waypoints[dlCmd.waypoints.length - 1]
        : null;
      if (effBlkIdle && finalDstInAisle && Math.abs(finalDstInAisle.y - aisleCenterY) <= 0.35 && (finalDstInAisle.x - st.x) * fx < 1.5) {
        aisleClampScurves.push([
          { x: st.x - fx * 3.6, y: aisleCenterY, reverse: true, skipTol: 0.25, speedLimit: 0.85 },
        ]);
      }
      for (const tgtY of laneTargets) {
        const effLat = (tgtY - st.y) * ry;
        if (Math.abs(effLat) >= 0.18 || (tgtY === laneTargets[0] && Math.abs(tgtY - st.y) < 0.25)) {
          aisleClampScurves.push([
            { x: st.x - fx * 2.2 + rx * (effLat * 0.5), y: st.y - fy * 2.2 + ry * (effLat * 0.5), reverse: true, skipTol: 0.45 },
            { x: st.x - fx * 4.4 + rx * effLat, y: st.y - fy * 4.4 + ry * effLat, reverse: true, skipTol: 0.45 },
            { x: st.x - fx * 5.8 + rx * effLat, y: st.y - fy * 5.8 + ry * effLat, reverse: true, skipTol: 0.35 },
          ]);
        }
      }
      const exitXList = fx > 0
        ? [rackMinX - 5.0, rackMinX - 2.6, rackMinX - 1.8]
        : [rackMaxX + 4.20, rackMaxX + 2.4, rackMaxX + 1.6];
      for (const exX of exitXList) {
        if (Math.abs(st.x - exX) > 1.8) {
          aisleExitPulloutCands.push([{ x: exX, y: aisleCenterY, reverse: true, skipTol: 0.45, _aisleExitPullout: true }]);
        }
      }
      if (fx > 0) {
        const mouthX = rackMinX + 0.5;
        const midX = rackMinX - 1.0;
        const outX = rackMinX - 4.1;
        if (st.x > outX + 1.5) {
          for (const dy of [2.8, -2.8]) {
            aisleExitPulloutCands.push([
              ...(st.x > mouthX + 0.6 ? [{ x: mouthX, y: aisleCenterY, reverse: true, skipTol: 0.45 }] : []),
              { x: midX, y: aisleCenterY + Math.sign(dy) * 1.1, reverse: true, skipTol: 0.45 },
              { x: outX, y: aisleCenterY + dy, reverse: true, skipTol: 0.45, _aisleExitPullout: true },
            ]);
          }
        }
        const nearX = rackMinX - 1.8;
        if (st.x > nearX + 1.2) {
          for (const dy of [1.2, -1.2]) {
            aisleExitPulloutCands.push([
              ...(st.x > mouthX + 0.6 ? [{ x: mouthX, y: aisleCenterY, reverse: true, skipTol: 0.45 }] : []),
              { x: nearX, y: aisleCenterY + dy, reverse: true, skipTol: 0.45, _aisleExitPullout: true },
            ]);
          }
        }
        const mouthWingX = rackMinX - 1.8;
        if (effBlkIdle && st.x > mouthWingX + 1.2 && st.x < rackMinX + 4.5) {
          for (const dy of [2.8, -2.8]) {
            aisleExitPulloutCands.push([
              { x: Math.max(st.x + 2.3, rackMinX + 2.5), y: aisleCenterY - Math.sign(dy) * 0.45, skipTol: 0.40 },
              { x: rackMinX - 0.8, y: aisleCenterY + Math.sign(dy) * 0.85, reverse: true, skipTol: 0.45 },
              { x: mouthWingX, y: aisleCenterY + dy, reverse: true, skipTol: 0.45, _aisleExitPullout: true },
            ]);
          }
        }
        if (st.x < rackMinX + 1.5 && st.x > outX + 1.5) {
          for (const dy of [2.8, -2.8]) {
            aisleExitPulloutCands.push([
              { x: rackMinX + 1.8, y: aisleCenterY, skipTol: 0.45 },
              { x: mouthX, y: aisleCenterY, reverse: true, skipTol: 0.45 },
              { x: midX, y: aisleCenterY + Math.sign(dy) * 1.1, reverse: true, skipTol: 0.45 },
              { x: outX, y: aisleCenterY + dy, reverse: true, skipTol: 0.45, _aisleExitPullout: true },
            ]);
          }
        }
      } else {
        const mouthX = rackMaxX - 0.5;
        const midX = rackMaxX + 1.0;
        const outX = rackMaxX + 4.1;
        if (st.x < outX - 1.5) {
          for (const dy of [-2.8, 2.8]) {
            aisleExitPulloutCands.push([
              ...(st.x < mouthX - 0.6 ? [{ x: mouthX, y: aisleCenterY, reverse: true, skipTol: 0.45 }] : []),
              { x: midX, y: aisleCenterY + Math.sign(dy) * 1.1, reverse: true, skipTol: 0.45 },
              { x: outX, y: aisleCenterY + dy, reverse: true, skipTol: 0.45, _aisleExitPullout: true },
            ]);
          }
        }
        const nearX = rackMaxX + 1.6;
        if (st.x < nearX - 1.2) {
          for (const dy of [1.2, -1.2]) {
            aisleExitPulloutCands.push([
              ...(st.x < mouthX - 0.6 ? [{ x: mouthX, y: aisleCenterY, reverse: true, skipTol: 0.45 }] : []),
              { x: nearX, y: aisleCenterY + dy, reverse: true, skipTol: 0.45, _aisleExitPullout: true },
            ]);
          }
        }
        const mouthWingX = rackMaxX + 1.8;
        if (effBlkIdle && st.x < mouthWingX - 1.2 && st.x > rackMaxX - 4.5) {
          for (const dy of [-2.8, 2.8]) {
            aisleExitPulloutCands.push([
              { x: Math.min(st.x - 2.3, rackMaxX - 2.5), y: aisleCenterY - Math.sign(dy) * 0.45, skipTol: 0.40 },
              { x: rackMaxX + 0.8, y: aisleCenterY + Math.sign(dy) * 0.85, reverse: true, skipTol: 0.45 },
              { x: mouthWingX, y: aisleCenterY + dy, reverse: true, skipTol: 0.45, _aisleExitPullout: true },
            ]);
          }
        }
        if (st.x > rackMaxX - 1.5 && st.x < outX - 1.5) {
          for (const dy of [-2.8, 2.8]) {
            aisleExitPulloutCands.push([
              { x: rackMaxX - 1.8, y: aisleCenterY, skipTol: 0.45 },
              { x: mouthX, y: aisleCenterY, reverse: true, skipTol: 0.45 },
              { x: midX, y: aisleCenterY + Math.sign(dy) * 1.1, reverse: true, skipTol: 0.45 },
              { x: outX, y: aisleCenterY + dy, reverse: true, skipTol: 0.45, _aisleExitPullout: true },
            ]);
          }
        }
      }
      if (fx < 0 && finalDstInAisle && finalDstInAisle.x < rackMinX - 0.5 && st.x > rackMinX + 0.5) {
        const fMidX = rackMinX - 0.5;
        const fOutX = rackMinX - 4.1;
        for (const dy of [2.8, -2.8]) {
          const laneY = aisleCenterY + Math.sign(dy) * 1.18;
          const step1X = Math.max(rackMinX + 2.5, st.x - 2.4);
          aisleExitPulloutCands.push([
            ...(st.x > rackMinX + 3.2 ? [{ x: step1X, y: aisleCenterY + Math.sign(dy) * 0.62, skipTol: 0.45 }] : []),
            { x: rackMinX + 0.5, y: laneY, skipTol: 0.45 },
            { x: fMidX, y: aisleCenterY + Math.sign(dy) * 1.25, skipTol: 0.45 },
            { x: fOutX, y: aisleCenterY + dy, skipTol: 0.45, _aisleExitPullout: true },
          ]);
        }
      } else if (fx > 0 && finalDstInAisle && finalDstInAisle.x > rackMaxX + 0.5 && st.x < rackMaxX - 0.5) {
        const fMidX = rackMaxX + 0.5;
        const fOutX = rackMaxX + 4.1;
        for (const dy of [-2.8, 2.8]) {
          const laneY = aisleCenterY + Math.sign(dy) * 1.18;
          const step1X = Math.min(rackMaxX - 2.5, st.x + 2.4);
          aisleExitPulloutCands.push([
            ...(st.x < rackMaxX - 3.2 ? [{ x: step1X, y: aisleCenterY + Math.sign(dy) * 0.62, skipTol: 0.45 }] : []),
            { x: rackMaxX - 0.5, y: laneY, skipTol: 0.45 },
            { x: fMidX, y: aisleCenterY + Math.sign(dy) * 1.25, skipTol: 0.45 },
            { x: fOutX, y: aisleCenterY + dy, skipTol: 0.45, _aisleExitPullout: true },
          ]);
        }
      }
    }
    const aisleMouthReverseCands = [];
    if (isAgf && hasRackBounds && !inNarrowRackAisle && st.y >= rackMinY && st.y <= rackMaxY && st.x > rackMaxX + 0.5 && st.x <= rackMaxX + 2.0 && fx > 0.5) {
      const oyAisle = layout?.origin?.[1] ?? NE_FLATLAND_SITE.origin[1];
      const aisleSet = layout?.aisles?.length
        ? layout.aisles
        : [{ y: oyAisle + 3.0 }, { y: oyAisle - 3.0 }, { y: oyAisle - 9.0 }];
      let mouthAisleY = null;
      let bestMouthDy = 1.2;
      for (let i = 0; i < aisleSet.length; i++) {
        const dy = Math.abs(st.y - aisleSet[i].y);
        if (dy < bestMouthDy) {
          bestMouthDy = dy;
          mouthAisleY = aisleSet[i].y;
        }
      }
      if (mouthAisleY !== null) {
        aisleMouthReverseCands.push([
          { x: rackMaxX, y: mouthAisleY, reverse: true, skipTol: 0.45 },
          { x: rackMaxX - 2.2, y: mouthAisleY, reverse: true, skipTol: 0.35 },
        ]);
      }
    }
    const cands = isAgf
      ? [
        ...(isReversingCmd ? [
          ...(inAisleX ? [[{ x: st.x + fx * 2.2, y: aisleCenterY, skipTol: 0.35 }]] : []),
          [{ x: st.x + fx * 2.2, y: st.y + fy * 2.2, skipTol: 0.35 }],
          [
            { x: st.x + fx * 1.3 + rx * 0.40, y: st.y + fy * 1.3 + ry * 0.40, skipTol: 0.45 },
            { x: st.x + fx * 2.6 + rx * 0.80, y: st.y + fy * 2.6 + ry * 0.80, skipTol: 0.35 },
          ],
          [
            { x: st.x + fx * 1.3 - rx * 0.40, y: st.y + fy * 1.3 - ry * 0.40, skipTol: 0.45 },
            { x: st.x + fx * 2.6 - rx * 0.80, y: st.y + fy * 2.6 - ry * 0.80, skipTol: 0.35 },
          ],
        ] : (inNarrowRackAisle && aisleCenterY !== null && !effBlk && st.statusMode === "blocked" ? (() => {
          const aisleDirX = fx >= 0 ? 1 : -1;
          return [
            [{ x: st.x + aisleDirX * 2.4, y: aisleCenterY, skipTol: 0.35, speedLimit: 0.85, _aisleStaticUnpin: true }],
            [{ x: st.x - aisleDirX * 2.4, y: aisleCenterY, reverse: true, skipTol: 0.35, speedLimit: 0.85, _aisleStaticUnpin: true }],
            [
              { x: st.x + aisleDirX * 1.8, y: aisleCenterY, skipTol: 0.35, speedLimit: 0.80, _aisleStaticUnpin: true },
              { x: st.x - aisleDirX * 1.2, y: aisleCenterY, reverse: true, skipTol: 0.35, speedLimit: 0.80, _aisleStaticUnpin: true },
            ],
          ];
        })() : (!inNarrowRackAisle && st.statusMode === "blocked" && (effBlk?.id?.startsWith("amr:") || effBlk?.id?.startsWith("agf:")) ? [
          [{ x: st.x + fx * 1.6, y: st.y + fy * 1.6, skipTol: 0.35 }],
          [{ x: st.x + fx * 2.4, y: st.y + fy * 2.4, skipTol: 0.35 }],
          ...(effBlk?.id?.startsWith("amr:") ? [
            [{ x: st.x + fx * 1.8 - rx * 0.50, y: st.y + fy * 1.8 - ry * 0.50, skipTol: 0.35 }],
            [{ x: st.x + fx * 1.8 + rx * 0.50, y: st.y + fy * 1.8 + ry * 0.50, skipTol: 0.35 }],
            [{ x: st.x + fx * 1.8 - rx * 1.15, y: st.y + fy * 1.8 - ry * 1.15, skipTol: 0.35 }],
            [{ x: st.x + fx * 1.8 + rx * 1.15, y: st.y + fy * 1.8 + ry * 1.15, skipTol: 0.35 }],
            [{ x: st.x - fx * 1.8 - rx * 0.50, y: st.y - fy * 1.8 - ry * 0.50, reverse: true, skipTol: 0.35 }],
            [{ x: st.x - fx * 1.8 + rx * 0.50, y: st.y - fy * 1.8 + ry * 0.50, reverse: true, skipTol: 0.35 }],
          ] : []),
          [
            { x: st.x + fx * 1.2, y: st.y + fy * 1.2, skipTol: 0.45 },
            { x: st.x + fx * 2.2 - rx * 1.8, y: st.y + fy * 2.2 - ry * 1.8, skipTol: 0.35 },
          ],
          [
            { x: st.x + fx * 1.2, y: st.y + fy * 1.2, skipTol: 0.45 },
            { x: st.x + fx * 2.2 + rx * 1.8, y: st.y + fy * 2.2 + ry * 1.8, skipTol: 0.35 },
          ],
          ...(effBlk?.id?.startsWith("agf:") ? (() => {
            const effLat = (effBlk.x - st.x) * rx + (effBlk.y - st.y) * ry;
            const awaySide = effLat >= 0 ? -1 : 1;
            return [
              [{ x: st.x + fx * 1.8 + rx * awaySide * 0.55, y: st.y + fy * 1.8 + ry * awaySide * 0.55, skipTol: 0.35 }],
              [{ x: st.x + fx * 1.8 - rx * awaySide * 0.55, y: st.y + fy * 1.8 - ry * awaySide * 0.55, skipTol: 0.35 }],
              [{ x: st.x + fx * 2.4 + rx * awaySide * 0.75, y: st.y + fy * 2.4 + ry * awaySide * 0.75, skipTol: 0.35 }],
              [{ x: st.x + fx * 2.4 - rx * awaySide * 0.75, y: st.y + fy * 2.4 - ry * awaySide * 0.75, skipTol: 0.35 }],
            ];
          })() : []),
        ] : []))),
        ...(inAisleX && (effBlkIdle || isReversingCmd) ? aisleExitPulloutCands : []),
        ...(inAisleX ? aisleClampScurves : []),
        ...(effBlk?.id?.startsWith("agf:") && effBlk.d <= 3.2 && ((st._dlFailCount ?? 0) >= 1 || (st._dlOscCount ?? 0) >= 2) && !inAisleX && !inNarrowRackAisle && startMinDist > 3.0 ? [
          [
            { x: st.x - fx * 1.4, y: st.y - fy * 1.4, reverse: true, skipTol: 0.40 },
            { x: st.x - fx * 3.4 + rx * lat, y: st.y - fy * 3.4 + ry * lat, reverse: true, skipTol: 0.40 },
            { x: st.x - fx * 5.2 + rx * lat, y: st.y - fy * 5.2 + ry * lat, reverse: true, skipTol: 0.35 },
          ],
          [
            { x: st.x - fx * 1.4, y: st.y - fy * 1.4, reverse: true, skipTol: 0.40 },
            { x: st.x - fx * 3.4 - rx * lat, y: st.y - fy * 3.4 - ry * lat, reverse: true, skipTol: 0.40 },
            { x: st.x - fx * 5.2 - rx * lat, y: st.y - fy * 5.2 - ry * lat, reverse: true, skipTol: 0.35 },
          ],
        ] : []),
        // Prioritize 3-point straightened S-curve reverse lane-shifts (safe inside 3.6 m rack aisles with full 6-corner clearance)
        [
          { x: st.x - fx * 2.2 + rx * (lat * 0.5), y: st.y - fy * 2.2 + ry * (lat * 0.5), reverse: true, skipTol: 0.45 },
          { x: st.x - fx * 4.4 + rx * lat, y: st.y - fy * 4.4 + ry * lat, reverse: true, skipTol: 0.45 },
          { x: st.x - fx * 5.8 + rx * lat, y: st.y - fy * 5.8 + ry * lat, reverse: true, skipTol: 0.35 },
        ],
        ...(startMinDist < 1.50
          ? [[{ x: st.x - fx * 3.0, y: st.y - fy * 3.0, reverse: true, skipTol: 0.35 }]]
          : []),
        [
          { x: st.x - fx * 2.2 - rx * (lat * 0.5), y: st.y - fy * 2.2 - ry * (lat * 0.5), reverse: true, skipTol: 0.45 },
          { x: st.x - fx * 4.4 - rx * lat, y: st.y - fy * 4.4 - ry * lat, reverse: true, skipTol: 0.45 },
          { x: st.x - fx * 5.8 - rx * lat, y: st.y - fy * 5.8 - ry * lat, reverse: true, skipTol: 0.35 },
        ],
        ...(inAisleX ? [] : aisleClampScurves),
        [
          { x: st.x - fx * 2.0 + rx * 0.36, y: st.y - fy * 2.0 + ry * 0.36, reverse: true, skipTol: 0.45 },
          { x: st.x - fx * 4.0 + rx * 0.72, y: st.y - fy * 4.0 + ry * 0.72, reverse: true, skipTol: 0.35 },
        ],
        [
          { x: st.x - fx * 2.0 - rx * 0.36, y: st.y - fy * 2.0 - ry * 0.36, reverse: true, skipTol: 0.45 },
          { x: st.x - fx * 4.0 - rx * 0.72, y: st.y - fy * 4.0 - ry * 0.72, reverse: true, skipTol: 0.35 },
        ],
        ...(!inNarrowRackAisle ? [
          [
            { x: st.x + fx * 1.1 + rx * 1.1, y: st.y + fy * 1.1 + ry * 1.1, skipTol: 0.45 },
            { x: st.x + fx * 1.4 + rx * 2.4, y: st.y + fy * 1.4 + ry * 2.4, skipTol: 0.35 },
          ],
          [
            { x: st.x + fx * 1.1 - rx * 1.1, y: st.y + fy * 1.1 - ry * 1.1, skipTol: 0.45 },
            { x: st.x + fx * 1.4 - rx * 2.4, y: st.y + fy * 1.4 - ry * 2.4, skipTol: 0.35 },
          ],
          [
            { x: st.x - fx * 1.4 + rx * 0.45, y: st.y - fy * 1.4 + ry * 0.45, reverse: true, skipTol: 0.45 },
            { x: st.x - fx * 2.8 + rx * 0.90, y: st.y - fy * 2.8 + ry * 0.90, reverse: true, skipTol: 0.35 },
          ],
          [
            { x: st.x - fx * 1.4 - rx * 0.45, y: st.y - fy * 1.4 - ry * 0.45, reverse: true, skipTol: 0.45 },
            { x: st.x - fx * 2.8 - rx * 0.90, y: st.y - fy * 2.8 - ry * 0.90, reverse: true, skipTol: 0.35 },
          ],
        ] : []),
        [{ x: st.x + fx * 2.2 + rx * lat, y: st.y + fy * 2.2 + ry * lat, skipTol: 0.35 }],
        [{ x: st.x + fx * 2.2 - rx * lat, y: st.y + fy * 2.2 - ry * lat, skipTol: 0.35 }],
        [{ x: st.x - fx * 1.80, y: st.y - fy * 1.80, reverse: true, skipTol: 0.35 }],
        [{ x: st.x - 1.45, y: st.y, reverse: fx > 0.5, skipTol: 0.35 }],
        [{ x: st.x + 1.45, y: st.y, reverse: fx < -0.5, skipTol: 0.35 }],
        [{ x: st.x, y: st.y - 1.45, reverse: fy > 0.5, skipTol: 0.35 }],
        [{ x: st.x, y: st.y + 1.45, reverse: fy < -0.5, skipTol: 0.35 }],
        ...(inAisleX && !effBlkIdle ? aisleExitPulloutCands : []),
        ...aisleMouthReverseCands,
      ]
      : [
        [{ x: st.x + rx * lat, y: st.y + ry * lat, skipTol: 0.35 }],
        [{ x: st.x - rx * lat, y: st.y - ry * lat, skipTol: 0.35 }],
        [{ x: st.x, y: st.y + lat, skipTol: 0.35 }],
        [{ x: st.x, y: st.y - lat, skipTol: 0.35 }],
        [{ x: st.x + lat, y: st.y, skipTol: 0.35 }],
        [{ x: st.x - lat, y: st.y, skipTol: 0.35 }],
        [{ x: st.x - fx * 0.65 + rx * lat, y: st.y - fy * 0.65 + ry * lat, skipTol: 0.35 }],
        [{ x: st.x - fx * 0.65 - rx * lat, y: st.y - fy * 0.65 - ry * lat, skipTol: 0.35 }],
        [{ x: st.x - fx * 1.35, y: st.y - fy * 1.35, skipTol: 0.35 }],
      ];

    const tail = dlCmd.waypoints.slice(dlCmd.waypointIndex ?? 0);
    while (tail.length > 1 && tail[0] && (tail[0]._deadlockEscape || tail[0]._escapeFrom !== undefined)) {
      tail.shift();
    }
    if (!isAgf) {
      const selfEntryAmr = amrEntries.get(st.agentId?.startsWith("amr:") ? st.agentId.slice(4) : st.agentId) || null;
      const allAgents = [];
      for (const a of agfEntries.values()) {
        const s = a.state;
        if (s.agentId === st.agentId) continue;
        allAgents.push({ id: s.agentId, x: s.x, y: s.y, radius: AGF_SPECS.hullRadiusM, speed: s.speed, stuckTime: s.stuckTime, escaping: false, isAgf: true, entry: a });
      }
      for (const m of amrEntries.values()) {
        const s = m.state;
        if (s.agentId === st.agentId) continue;
        const mItem = m.queue[0];
        const mWps = mItem?.task?.type === "driveTo" ? mItem.data?.waypoints : mItem?.data?.route;
        const mWp = Array.isArray(mWps) ? mWps[mItem.data?.waypointIndex ?? 0] : null;
        allAgents.push({
          id: s.agentId,
          x: s.x,
          y: s.y,
          radius: AMR_SPECS.hullRadiusM,
          speed: s.speed,
          stuckTime: s.stuckTime,
          escaping: Boolean(mWp?._deadlockEscape),
          isAgf: false,
          entry: m,
        });
      }
      const clusterPeers = [];
      let sumX = st.x;
      let sumY = st.y;
      let curMinAgentDist = Infinity;
      let peerMovingEscape = false;
      let peerHigherPriority = false;
      for (let i = 0; i < allAgents.length; i++) {
        const a = allAgents[i];
        const d = Math.hypot(a.x - st.x, a.y - st.y);
        if (d < curMinAgentDist) curMinAgentDist = d;
        if (d <= (a.isAgf ? 2.9 : 2.4)) {
          clusterPeers.push({ ...a, d });
          sumX += a.x;
          sumY += a.y;
          if (d <= 1.85) {
            if (a.escaping && Math.abs(a.speed) > 0.05) peerMovingEscape = true;
            if (a.stuckTime > 0.20 && a.stuckTime < 1.0 && String(a.id) < String(st.agentId)) peerHigherPriority = true;
          }
        }
      }
      if (st.stuckTime <= 0.75 && (peerMovingEscape || peerHigherPriority)) {
        return cmd;
      }
      const cx = sumX / (clusterPeers.length + 1);
      const cy = sumY / (clusterPeers.length + 1);
      const centDistBefore = Math.hypot(st.x - cx, st.y - cy);
      let bestEsc = null;
      let bestEscScore = -Infinity;
      const radii = [1.2, 1.8, 2.5, 3.3];
      const angleCount = 24;
      for (let ri = 0; ri < radii.length; ri++) {
        const rad = radii[ri];
        for (let ai = 0; ai < angleCount; ai++) {
          const ang = (ai / angleCount) * Math.PI * 2;
          const ex = st.x + Math.sin(ang) * rad;
          const ey = st.y + Math.cos(ang) * rad;
          if (minDistanceToObstacles(ex, ey, staticObs) < minClear) continue;
          if (!pathIsClear(st.x, st.y, ex, ey, staticObs, minClear, startObs)) continue;
          let segOk = true;
          let endMinAgentDist = Infinity;
          for (let i = 0; i < allAgents.length; i++) {
            const a = allAgents[i];
            const curD = Math.hypot(a.x - st.x, a.y - st.y);
            const segD = pointToSegDist2D(a.x, a.y, st.x, st.y, ex, ey);
            const bothLoaded = !a.isAgf && Boolean(st.carriedWcid && a.entry.state.carriedWcid);
            const reqD = bothLoaded ? 1.60 : (a.isAgf ? 1.38 : 1.32);
            if (segD < Math.min(curD - 0.03, reqD)) {
              segOk = false;
              break;
            }
            const agfCheckR = a.isAgf ? 3.2 : (bothLoaded ? 2.6 : 2.2);
            const agfEndR = a.isAgf ? 2.85 : 2.2;
            if (curD <= agfCheckR || Math.hypot(a.x - ex, a.y - ey) <= agfEndR) {
              const otherObbs = getEntryWorldObbs(a.entry, a.isAgf);
              const tCheckSteps = a.isAgf ? [0.25, 0.5, 0.75, 1.0] : [0.5, 1.0];
              for (let ts = 0; ts < tCheckSteps.length; ts++) {
                const tVal = tCheckSteps[ts];
                if (vehiclesSatOverlap2D(getAmrWorldObbs(st.x + (ex - st.x) * tVal, st.y + (ey - st.y) * tVal, ang, st.carriedWcid, st.turntableYawRad), otherObbs, 0.02)) {
                  segOk = false;
                  break;
                }
              }
              if (!segOk) break;
              if (curD <= (a.isAgf ? 2.85 : 1.65)) {
                const rotDiff = wrapPi(ang - st.heading);
                const rotSteps = Math.max(4, Math.ceil(Math.abs(rotDiff) / 0.04));
                for (let rs = 1; rs <= rotSteps; rs++) {
                  const rh = wrapHeading(st.heading + rotDiff * (rs / rotSteps));
                  if (vehiclesSatOverlap2D(getAmrWorldObbs(st.x, st.y, rh, st.carriedWcid, st.turntableYawRad), otherObbs, a.isAgf ? 0.02 : 0.006)) {
                    segOk = false;
                    break;
                  }
                }
                if (!segOk) break;
              }
            }
            const endD = Math.hypot(a.x - ex, a.y - ey);
            if (endD < endMinAgentDist) endMinAgentDist = endD;
          }
          if (!segOk) continue;
          if (blk && Math.hypot(blk.x - ex, blk.y - ey) < blk.d + 0.05) continue;
          const minTargetSep = st.stuckTime > 1.5
            ? Math.min(1.30, Math.max(curMinAgentDist + 0.04, selfRadius + 0.60))
            : Math.min(1.38, Math.max(curMinAgentDist + 0.08, selfRadius + 0.62));
          if (endMinAgentDist < minTargetSep) continue;
          const centGain = Math.hypot(ex - cx, ey - cy) - centDistBefore;
          const turnErr = Math.abs(wrapPi(ang - st.heading));
          const sc = (endMinAgentDist >= 1.48 ? 20.0 : 0.0) +
            Math.min(endMinAgentDist, 2.5) * 4.0 +
            centGain * 2.5 -
            rad * 0.6 -
            turnErr * 0.4;
          if (sc > bestEscScore) {
            bestEscScore = sc;
            bestEsc = { x: ex, y: ey };
          }
        }
      }
      if (!bestEsc) {
        if (item?.data && !item.data.deadlockPull) {
          for (const dir of [-1, 1]) {
            for (const dPull of [0.85, 0.55, 0.35]) {
              const px = st.x + dir * fx * dPull;
              const py = st.y + dir * fy * dPull;
              if (minDistanceToObstacles(px, py, staticObs) < minClear) continue;
              if (!pathIsClear(st.x, st.y, px, py, staticObs, minClear, startObs)) continue;
              let pullOk = true;
              for (let i = 0; i < allAgents.length && pullOk; i++) {
                const a = allAgents[i];
                if (Math.hypot(a.x - st.x, a.y - st.y) > 2.6) continue;
                const otherObbs = getEntryWorldObbs(a.entry, a.isAgf);
                for (const tStep of [0.35, 0.70, 1.0]) {
                  const sx = st.x + (px - st.x) * tStep;
                  const sy = st.y + (py - st.y) * tStep;
                  if (vehiclesSatOverlap2D(getAmrWorldObbs(sx, sy, st.heading, st.carriedWcid, st.turntableYawRad), otherObbs, 0.004)) {
                    pullOk = false;
                    break;
                  }
                }
                if (blk && a.id === blk.id && Math.hypot(a.x - px, a.y - py) <= Math.hypot(a.x - st.x, a.y - st.y) + 0.05) {
                  pullOk = false;
                }
              }
              if (pullOk) {
                item.data.deadlockPull = { x: px, y: py, dir, heading: st.heading, _blockedSec: 0 };
                st.stuckTime = 0;
                return {
                  speed: dir * 0.85,
                  omega: 0,
                  ...(item.task?.type === "driveTo" ? { keepCargoHeading: item.data.keepCargoHeading, heldCargoHeading: item.data.heldCargoHeading } : {}),
                  targetLiftHeightM: st.liftHeightM,
                };
              }
            }
          }
        }
        return cmd;
      }
      const peerSet = new Set(clusterPeers.map((p) => p.id));
      const escMeta = {
        skipTol: 0.35,
        _deadlockEscape: true,
        _escapePeers: peerSet,
        ...(blk ? { _escapeFrom: blk.id } : {}),
      };
      const escWp = { x: bestEsc.x, y: bestEsc.y, ...escMeta };
      const finalDst = tail[tail.length - 1] || null;
      let detourWp = null;
      let tailWps = [];
      if (finalDst && Number.isFinite(finalDst.x) && Number.isFinite(finalDst.y)) {
        if (Math.hypot(finalDst.x - bestEsc.x, finalDst.y - bestEsc.y) > 0.5) {
          let lastPt = bestEsc;
          if (clusterPeers.length > 0 && pointToSegDist2D(cx, cy, bestEsc.x, bestEsc.y, finalDst.x, finalDst.y) < 1.55) {
            const sdx = finalDst.x - bestEsc.x;
            const sdy = finalDst.y - bestEsc.y;
            const slen = Math.hypot(sdx, sdy);
            if (slen > 1e-4) {
              let px = -sdy / slen;
              let py = sdx / slen;
              if ((bestEsc.x - cx) * px + (bestEsc.y - cy) * py < 0) {
                px = -px;
                py = -py;
              }
              const dx = bestEsc.x + px * 2.2;
              const dy = bestEsc.y + py * 2.2;
              if (minDistanceToObstacles(dx, dy, staticObs) >= minClear && pathIsClear(bestEsc.x, bestEsc.y, dx, dy, staticObs, minClear, startObs)) {
                detourWp = { x: dx, y: dy, ...escMeta };
                lastPt = detourWp;
              }
            }
          }
          const fa = item?.data?.finalApproach;
          const dockCh = item.task?.type === "dockCharge" ? item.data?.ch : null;
          const dockH = dockCh
            ? wrapHeading(Math.atan2(dockCh.pos[0] - dockCh.approachPos[0], dockCh.pos[1] - dockCh.approachPos[1]))
            : null;
          const targetTail = fa
            ? [{ x: fa.preX, y: fa.preY, heading: fa.heading }]
            : dockCh
              ? [{ x: dockCh.approachPos[0], y: dockCh.approachPos[1], heading: dockH }]
              : [{ ...finalDst }];
          const idlePeerObs = buildIdleVehicleObstacles(selfEntryAmr, Boolean(st.carriedWcid)).filter((b) => {
            const dL = pointToObstacleDist(lastPt.x, lastPt.y, b);
            const dT = pointToObstacleDist(targetTail[0].x, targetTail[0].y, b);
            const minEnd = b.isPallet ? 0.56 : 0.40;
            return dL >= minEnd && dT >= minEnd && (dL < 12.0 || dT < 12.0);
          });
          const tailSolid = idlePeerObs.length > 0 ? [...staticObs, ...idlePeerObs] : null;
          tailWps = routeAmrAroundSolidObstacles(
            { x: lastPt.x, y: lastPt.y, heading: Math.atan2(targetTail[0].x - lastPt.x, targetTail[0].y - lastPt.y) },
            targetTail,
            selfRadius,
            tailSolid,
          );
          if (dockCh && tailWps.length > 0) {
            tailWps.push({ x: dockCh.dockPos[0], y: dockCh.dockPos[1], heading: dockH });
          }
        } else {
          tailWps = [{ ...finalDst }];
        }
      }
      const nextWps = [escWp, ...(detourWp ? [detourWp] : []), ...tailWps];
      if (item?.data) {
        if (item.task?.type === "driveTo") item.data.waypoints = nextWps;
        else if (item.phase === "route") item.data.route = nextWps;
        item.data.waypointIndex = 0;
      }
      st.stuckTime = 0;
      return {
        ...cmd,
        waypoints: nextWps,
        waypointIndex: 0,
      };
    }

    const isRouteBlockedByIdleOrMouthAgf = (sx, sy, wps) => {
      if (!isAgf || !Array.isArray(wps) || wps.length === 0) return false;
      let px = sx;
      let py = sy;
      const reqDist = selfRadius + AGF_SPECS.hullRadiusM + 0.24;
      for (let wi = 0; wi < wps.length; wi++) {
        const w = wps[wi];
        if (!w || !Number.isFinite(w.x) || !Number.isFinite(w.y)) continue;
        const sdx = w.x - px;
        const sdy = w.y - py;
        for (const a of agfEntries.values()) {
          const os = a.state;
          if (os.agentId === st.agentId) continue;
          if (a.queue.length !== 0 || (os._idleSec ?? 0) < 0.25) continue;
          if (sdx * (os.x - px) + sdy * (os.y - py) <= 0) continue;
          if (pointToSegDist2D(os.x, os.y, px, py, w.x, w.y) < reqDist) return true;
        }
        px = w.x;
        py = w.y;
      }
      return false;
    };

    const oppRouteMemo = new Map();
    const reenterMemo = new Map();
    const reenterIdleMemo = new Map();
    let dlFindPathBudget = 4;
    let cachedIdleAgfObs = null;
    const getIdleAgfObs = () => {
      if (cachedIdleAgfObs !== null) return cachedIdleAgfObs;
      const obs = [];
      for (const a of agfEntries.values()) {
        const as = a.state;
        if (as.agentId === st.agentId || a.queue.length !== 0 || (as._idleSec ?? 0) < 0.25) continue;
        const aobbs = getEntryWorldObbs(a, true);
        for (const o of [...aobbs.chassis, ...aobbs.pallet]) {
          const ch = Math.abs(Math.cos(o.heading));
          const shv = Math.abs(Math.sin(o.heading));
          const rxo = o.halfW * ch + o.halfL * shv;
          const ryo = o.halfW * shv + o.halfL * ch;
          obs.push({ id: `${as.agentId}:dlidle`, kind: "vehicle", isAgf: true, x0: o.cx - rxo, x1: o.cx + rxo, y0: o.cy - ryo, y1: o.cy + ryo, obb: o });
        }
      }
      cachedIdleAgfObs = obs;
      return obs;
    };

    const bypassIdleAgfSegment = (sx, sy, list) => {
      if (!Array.isArray(list) || list.length === 0) return null;
      const reqDist = selfRadius + AGF_SPECS.hullRadiusM + 0.24;
      let effList = list;
      while (effList.length > 1) {
        const w0 = effList[0];
        let w0Blocked = false;
        if (w0 && !w0.reverse && Number.isFinite(w0.x) && Number.isFinite(w0.y)) {
          for (const a of agfEntries.values()) {
            const os = a.state;
            if (os.agentId === st.agentId || a.queue.length !== 0 || (os._idleSec ?? 0) < 0.25) continue;
            const dW0 = Math.hypot(os.x - w0.x, os.y - w0.y);
            const w1 = effList[1];
            if (dW0 < reqDist * 0.85 || (!inNarrowRackAisle && dW0 < reqDist + 0.45 && w1 && !w1.reverse && Number.isFinite(w1.x) && Number.isFinite(w1.y) && Math.hypot(os.x - w1.x, os.y - w1.y) > dW0 + 0.5 && pathIsClear(sx, sy, w1.x, w1.y, staticObs, minClear, startObs))) {
              w0Blocked = true;
              break;
            }
          }
          if (!w0Blocked && (st._dlRepeatCount ?? 0) >= 1 && !inAisleX && effBlk?.id?.startsWith("amr:")) {
            for (const m of amrEntries.values()) {
              const os = m.state;
              if (m.queue.length !== 0 || (os._idleSec ?? 0) < 0.25) continue;
              if (Math.hypot(os.x - w0.x, os.y - w0.y) < 1.8) {
                w0Blocked = true;
                break;
              }
            }
          }
        }
        if (!w0Blocked) break;
        effList = effList.slice(1);
      }
      const nextPt = effList[0];
      if (!nextPt || !Number.isFinite(nextPt.x) || !Number.isFinite(nextPt.y)) return null;
      const segDx = nextPt.x - sx;
      const segDy = nextPt.y - sy;
      const segLen = Math.hypot(segDx, segDy);
      if (segLen <= 1e-4) return null;
      const ux = segDx / segLen;
      const uy = segDy / segLen;
      let blocker = null;
      let bestProj = Infinity;
      for (const a of agfEntries.values()) {
        const os = a.state;
        if (os.agentId === st.agentId || a.queue.length !== 0 || (os._idleSec ?? 0) < 0.25) continue;
        const proj = (os.x - sx) * ux + (os.y - sy) * uy;
        if (proj <= 0 || proj >= segLen + reqDist * 0.6) continue;
        if (pointToSegDist2D(os.x, os.y, sx, sy, nextPt.x, nextPt.y) < reqDist && proj < bestProj) {
          bestProj = proj;
          blocker = os;
        }
      }
      if (!blocker) {
        if (effList.length < list.length && pathIsClear(sx, sy, nextPt.x, nextPt.y, staticObs, minClear, startObs) && !isRouteBlockedByIdleOrMouthAgf(sx, sy, effList)) {
          return effList;
        }
        return null;
      }
      const px = -uy;
      const py = ux;
      const sidePref = ((sx - blocker.x) * px + (sy - blocker.y) * py) >= 0 ? 1 : -1;
      for (const side of [sidePref, -sidePref]) {
        for (const off of [2.8, 3.6]) {
          const bx = blocker.x + side * px * off;
          const by = blocker.y + side * py * off;
          if (minDistanceToObstacles(bx, by, staticObs) < minClear) continue;
          if (!pathIsClear(sx, sy, bx, by, staticObs, minClear, startObs)) continue;
          if (!pathIsClear(bx, by, nextPt.x, nextPt.y, staticObs, minClear, startObs)) continue;
          const candList = [{ x: bx, y: by, skipTol: 0.45, _deadlockEscape: true }, ...effList];
          if (!isRouteBlockedByIdleOrMouthAgf(sx, sy, candList)) {
            return candList;
          }
        }
      }
      return null;
    };

    const findPathCached = (px, py, fxDst, fyDst, headingVal) => {
      const mKey = `${Math.round(px * 4)},${Math.round(py * 4)},${Math.round(wrapPi(headingVal) * 8)},${Math.round(fxDst * 4)},${Math.round(fyDst * 4)}`;
      if (reenterMemo.has(mKey)) return reenterMemo.get(mKey);
      if (dlFindPathBudget <= 0) return null;
      dlFindPathBudget--;
      const res = findPath([px, py], [fxDst, fyDst], "agf", { heading: headingVal });
      reenterMemo.set(mKey, res);
      return res;
    };

    const findPathIdleAvoidCached = (px, py, fxDst, fyDst, headingVal) => {
      const idleObs = getIdleAgfObs();
      if (idleObs.length === 0) return findPathCached(px, py, fxDst, fyDst, headingVal);
      const mKey = `${Math.round(px * 4)},${Math.round(py * 4)},${Math.round(wrapPi(headingVal) * 8)},${Math.round(fxDst * 4)},${Math.round(fyDst * 4)}`;
      if (reenterIdleMemo.has(mKey)) return reenterIdleMemo.get(mKey);
      if (dlFindPathBudget <= 0) return null;
      dlFindPathBudget--;
      const res = findPath([px, py], [fxDst, fyDst], "agf", { heading: headingVal, extraObstacles: idleObs });
      reenterIdleMemo.set(mKey, res);
      return res;
    };

    const buildSameSideMouthBypassRoute = (sx, sy, sHeading, finalDst, targetAisleY) => {
      if (!isAgf || !hasRackBounds || !finalDst) return null;
      const onEast = sx >= rackMaxX + 0.5 && finalDst.x > rackMaxX + 0.3 && finalDst.x <= rackMaxX + 6.0;
      const onWest = sx <= rackMinX - 0.5 && finalDst.x < rackMinX - 0.3 && finalDst.x >= rackMinX - 6.0;
      if (!onEast && !onWest) return null;
      const simH = Number.isFinite(sHeading) ? sHeading : Math.atan2(finalDst.x - sx, finalDst.y - sy);
      const spineX = onEast
        ? clamp(Math.max(sx, finalDst.x + 2.4, rackMaxX + 3.8), rackMaxX + 3.2, rackMaxX + 4.2)
        : clamp(Math.min(sx, finalDst.x - 2.4, rackMinX - 3.8), rackMinX - 5.2, rackMinX - 3.2);
      const entryX = onEast
        ? Math.max(rackMaxX + 1.0, finalDst.x + 0.8)
        : Math.min(rackMinX - 1.0, finalDst.x - 0.8);
      const detourYs = [targetAisleY + 2.2, targetAisleY - 2.2, targetAisleY + 2.6, targetAisleY - 2.6];
      const revToSpine = (spineX - sx) * Math.sin(simH) < -0.25;
      for (const detourY of detourYs) {
        const candsRoute = [];
        const cleanDst = finalDst.docking ? { ...finalDst } : { ...finalDst, reverse: false };
        if (Math.abs(sx - spineX) > 0.45) {
          candsRoute.push([
            { x: spineX, y: sy, ...(revToSpine ? { reverse: true } : {}), skipTol: 0.45, speedLimit: revToSpine ? 0.95 : 1.15 },
            { x: spineX, y: detourY, skipTol: 0.35, speedLimit: 1.05 },
            { x: entryX, y: detourY, skipTol: 0.35, speedLimit: 0.95 },
            cleanDst,
          ]);
        }
        candsRoute.push([
          { x: sx, y: detourY, skipTol: 0.35, speedLimit: 1.05 },
          { x: entryX, y: detourY, skipTol: 0.35, speedLimit: 0.95 },
          cleanDst,
        ]);
        for (const rawR of candsRoute) {
          const subRoute = subdivideWaypoints(sx, sy, rawR, 4.5);
          let px = sx;
          let py = sy;
          let segOk = true;
          for (let ri = 0; ri < subRoute.length; ri++) {
            if (minDistanceToObstacles(subRoute[ri].x, subRoute[ri].y, staticObs) < minClear ||
                !pathIsClear(px, py, subRoute[ri].x, subRoute[ri].y, staticObs, minClear, startObs)) {
              segOk = false;
              break;
            }
            px = subRoute[ri].x;
            py = subRoute[ri].y;
          }
          if (!segOk) continue;
          if (isRouteBlockedByIdleOrMouthAgf(sx, sy, subRoute)) continue;
          if (isAgfArcClear(
            { ...st, x: sx, y: sy, heading: simH, speed: 0, steerAngleRad: 0 },
            subRoute,
            staticObs,
            arcClear,
            minDistanceToObstacles(sx, sy, staticObs),
            { maxSteps: 1800, speedScales: [1.0], requireArrival: false },
          )) {
            return subRoute;
          }
        }
      }
      return null;
    };

    const selfAgfEntry = isAgf
      ? (agfEntries.get(st.agentId?.startsWith("agf:") ? st.agentId.slice(4) : st.agentId) || null)
      : null;

    const buildOppositeMouthRoute = (sx, sy, sHeading, rawFinalDst) => {
      const finalDst = (rawFinalDst && rawFinalDst._autoOrthoHeading)
        ? (() => { const c = { ...rawFinalDst }; delete c.heading; delete c._autoOrthoHeading; return c; })()
        : rawFinalDst;
      if (!isAgf || !hasRackBounds || !finalDst || !Number.isFinite(finalDst.x) || !Number.isFinite(finalDst.y)) return null;
      if (finalDst.y < rackMinY - 1.5 || finalDst.y > rackMaxY + 1.5) return null;
      const oppKey = `${Math.round(sx * 4)},${Math.round(sy * 4)},${Math.round(wrapPi(sHeading) * 8)},${Math.round(finalDst.x * 4)},${Math.round(finalDst.y * 4)}`;
      if (oppRouteMemo.has(oppKey)) return oppRouteMemo.get(oppKey);
      const oxA = layout?.origin?.[0] ?? NE_FLATLAND_SITE.origin[0];
      const oyA = layout?.origin?.[1] ?? NE_FLATLAND_SITE.origin[1];
      const aisleSet = layout?.aisles?.length ? layout.aisles : [{ y: oyA + 3.0 }, { y: oyA - 3.0 }, { y: oyA - 9.0 }];
      let targetAisleY = null;
      let bestDy = 1.6;
      for (let i = 0; i < aisleSet.length; i++) {
        const dy = Math.abs(finalDst.y - aisleSet[i].y);
        if (dy < bestDy) {
          bestDy = dy;
          targetAisleY = aisleSet[i].y;
        }
      }
      if (targetAisleY === null) {
        oppRouteMemo.set(oppKey, null);
        return null;
      }
      const sameSide = buildSameSideMouthBypassRoute(sx, sy, sHeading, finalDst, targetAisleY);
      if (sameSide) {
        oppRouteMemo.set(oppKey, sameSide);
        return sameSide;
      }
      const westSpineX = rackMinX - 5.0;
      const eastSpineX = rackMaxX + 3.90;
      const northPerimY = rackMaxY + 2.6;
      const southPerimY = rackMinY - 2.9;
      const blockedWest = sx <= rackMinX - 0.5 && finalDst.x > rackMinX - 4.0;
      const blockedEast = sx >= rackMaxX + 0.5 && finalDst.x < rackMaxX + 4.0;
      if (!blockedWest && !blockedEast) {
        oppRouteMemo.set(oppKey, null);
        return null;
      }

      const bypassXCands = [];
      const oppSpineXCands = [];
      if (blockedWest) {
        let minBlockerX = westSpineX + 2.0;
        for (const a of agfEntries.values()) {
          const os = a.state;
          if (os.agentId === st.agentId) continue;
          if (os.y >= rackMinY - 2.0 && os.y <= rackMaxY + 2.0 && os.x <= rackMinX + 4.5) {
            if (os.x < minBlockerX) minBlockerX = os.x;
          }
        }
        const outerBypassX = Math.max(oxA - 36.0, Math.min(westSpineX - 1.5, minBlockerX - 4.8));
        bypassXCands.push(outerBypassX);
        if (sx > minBlockerX + 1.25 && sx <= rackMinX - 1.2) {
          bypassXCands.push(sx);
        }
        if (rackMinX - 1.8 > minBlockerX + 1.25) {
          bypassXCands.push(rackMinX - 1.8);
        }
        const primaryEastSpineX = Math.min(rackMaxX + 4.20, Math.max(eastSpineX, finalDst.x + 1.0));
        oppSpineXCands.push(primaryEastSpineX);
        if (finalDst.x > rackMaxX + 1.0 && finalDst.x < rackMaxX + 3.5) {
          oppSpineXCands.push(rackMaxX + 1.6);
        }
      } else {
        let maxBlockerX = eastSpineX - 2.0;
        for (const a of agfEntries.values()) {
          const os = a.state;
          if (os.agentId === st.agentId) continue;
          if (os.y >= rackMinY - 2.0 && os.y <= rackMaxY + 2.0 && os.x >= rackMaxX - 4.5) {
            if (os.x > maxBlockerX) maxBlockerX = os.x;
          }
        }
        const outerBypassX = Math.min(oxA + 11.2, Math.max(eastSpineX, maxBlockerX + 4.8));
        if (rackMaxX + 3.40 >= maxBlockerX + 1.25) {
          bypassXCands.push(rackMaxX + 3.40);
        }
        if (eastSpineX >= maxBlockerX + 1.25) {
          bypassXCands.push(eastSpineX);
        }
        bypassXCands.push(outerBypassX);
        if (sx < maxBlockerX - 1.25 && sx >= rackMaxX + 1.2) {
          bypassXCands.push(sx);
        }
        if (rackMaxX + 1.6 < maxBlockerX - 1.25) {
          bypassXCands.push(rackMaxX + 1.6);
        }
        oppSpineXCands.push(westSpineX);
        if (minDistanceToObstacles(westSpineX, northPerimY, staticObs) < minClear) {
          oppSpineXCands.push(rackMinX - 9.0);
        }
        if (finalDst.x < rackMinX - 1.0 && finalDst.x > westSpineX + 1.2) {
          oppSpineXCands.push(rackMinX - 2.3);
        }
      }

      const perimScore = (pY, bx) => {
        let sc = Math.abs(finalDst.y - pY);
        if (effBlk && Math.abs(bx - effBlk.x) < 2.2) {
          const crossesBlkY = (sy - effBlk.y) * (pY - effBlk.y) <= 0;
          if (crossesBlkY) sc += 100.0;
        }
        return sc;
      };
      const seenBypass = new Set();
      for (const bypassX of bypassXCands) {
        const bKey = bypassX.toFixed(2);
        if (seenBypass.has(bKey)) continue;
        seenBypass.add(bKey);
        const perimCands = perimScore(northPerimY, bypassX) <= perimScore(southPerimY, bypassX)
          ? [northPerimY, southPerimY]
          : [southPerimY, northPerimY];
        const simH = Number.isFinite(sHeading) ? sHeading : Math.atan2(bypassX - sx, perimCands[0] - sy);
        const revToBypass = (bypassX - sx) * Math.sin(simH) < -0.25;
        for (const perimY of perimCands) {
          const preTurnY = perimY > targetAisleY ? targetAisleY + 2.6 : targetAisleY - 2.6;
          const alignY = perimY > targetAisleY ? targetAisleY + 0.85 : targetAisleY - 0.85;
          for (const oppSpineX of oppSpineXCands) {
            const oppPreCornerX = blockedWest ? (oppSpineX - 2.2) : (oppSpineX + 2.2);
            const oppTurnX = blockedWest ? (oppSpineX - 1.25) : (oppSpineX + 1.25);
            const oppMouthX = blockedWest ? Math.max(rackMaxX + 1.1, finalDst.x) : Math.min(rackMinX - 1.6, finalDst.x);
            const route = [];
            if (Math.abs(sx - bypassX) > 0.35) {
              route.push({ x: bypassX, y: sy, ...(revToBypass ? { reverse: true } : {}), skipTol: 0.45, speedLimit: revToBypass ? 1.0 : 1.35 });
            }
            route.push(
              { x: bypassX, y: perimY, skipTol: 0.45, speedLimit: 2.0 },
              { x: oppPreCornerX, y: perimY, skipTol: 0.35, speedLimit: 2.0 },
              { x: oppSpineX, y: perimY, skipTol: 0.25, speedLimit: 0.80 },
              { x: oppSpineX, y: preTurnY, skipTol: 0.40, speedLimit: 1.75 },
              { x: oppSpineX, y: alignY, skipTol: 0.30, speedLimit: 1.05 },
            );
            if (Math.abs(oppSpineX - finalDst.x) >= 1.0) {
              route.push({ x: oppSpineX, y: targetAisleY, skipTol: 0.25, speedLimit: 0.90 });
            }
            if (blockedWest ? (oppTurnX > finalDst.x + 0.35) : (oppTurnX < finalDst.x - 0.35)) {
              route.push({ x: oppTurnX, y: targetAisleY, skipTol: 0.35, speedLimit: 1.15 });
            }
            if (
              (blockedWest ? (oppMouthX > finalDst.x + 0.4 && oppMouthX < oppTurnX - 0.4) : (oppMouthX < finalDst.x - 0.4 && oppMouthX > oppTurnX + 0.4))
            ) {
              route.push({ x: oppMouthX, y: targetAisleY, skipTol: 0.40, speedLimit: 1.25 });
            }
            const approachDirX = blockedWest ? -1 : 1;
            const hasPeerPastFinal = Number.isFinite(finalDst.heading) && Math.abs(Math.cos(finalDst.heading)) > 0.70 && [...agfEntries.values()].some((a) => {
              const os = a.state;
              if (os.agentId === st.agentId) return false;
              const dxPeer = (os.x - finalDst.x) * approachDirX;
              return dxPeer > -0.5 && dxPeer < 3.2 && Math.abs(os.y - targetAisleY) <= 1.8;
            });
            let usedZigZag = false;
            if (hasPeerPastFinal) {
              const cosH = Math.cos(finalDst.heading);
              const facingSouth = cosH < 0;
              // Keep zig-zag inside the 3.6m aisle's OBB-feasible band (shifted toward the facing rack
              // because the AGF rear chassis overhang 1.93m > carried pallet overhang 1.25m).
              // Reverse legs pull straight back at finalDst.heading (dx = 0) so the 1.93m rear never
              // swings past finalDst.heading toward a peer parked just past finalDst.x.
              const yRev = facingSouth ? targetAisleY - 0.24 : targetAisleY + 0.24;
              const yFwd = facingSouth ? targetAisleY - 0.35 : targetAisleY + 0.35;
              const startZigX = finalDst.x - approachDirX * 1.30;
              if (blockedWest ? (startZigX < oppMouthX) : (startZigX > oppMouthX)) {
                const zigEntryX = startZigX - approachDirX * 2.50;
                const zigSuffix = [];
                const midZigX = finalDst.x - approachDirX * 0.50;
                const preFinalX = finalDst.x - approachDirX * 0.02;
                const cycleXs = [];
                for (let k = 1; k <= 10; k++) cycleXs.push(startZigX + (midZigX - startZigX) * (k / 10));
                for (let k = 1; k <= 16; k++) cycleXs.push(midZigX + (preFinalX - midZigX) * (k / 16));
                const hFirst = wrapHeading(Math.atan2(cycleXs[0] - startZigX, yFwd - yRev));
                zigSuffix.push({ x: startZigX, y: yRev, heading: hFirst, _stopAtWaypoint: true, speedLimit: 0.70 });
                let prevCx = startZigX;
                for (let ci = 0; ci < cycleXs.length; ci++) {
                  const cx = cycleXs[ci];
                  const hFwd = wrapHeading(Math.atan2(cx - prevCx, yFwd - yRev));
                  zigSuffix.push({ x: cx, y: yFwd, reverse: false, heading: hFwd, _stopAtWaypoint: true, speedLimit: 0.65 });
                  if (ci < cycleXs.length - 1) {
                    zigSuffix.push({ x: cx, y: yRev, reverse: true, heading: finalDst.heading, _stopAtWaypoint: true, speedLimit: 0.65 });
                  }
                  prevCx = cx;
                }
                zigSuffix.push({ ...finalDst, speedLimit: 0.55 });
                const zigH = approachDirX > 0 ? Math.PI * 0.5 : -Math.PI * 0.5;
                if (isAgfArcClear(
                  { ...st, x: zigEntryX, y: yRev, heading: zigH, speed: 0, steerAngleRad: 0 },
                  zigSuffix,
                  staticObs,
                  arcClear,
                  minDistanceToObstacles(zigEntryX, yRev, staticObs),
                  { maxSteps: 4800, speedScales: [1.0], requireArrival: true, checkSatObb: true },
                )) {
                  usedZigZag = true;
                  route.push({ x: zigEntryX, y: yRev, skipTol: 0.20, speedLimit: 0.90 });
                  for (let zi = 0; zi < zigSuffix.length - 1; zi++) route.push(zigSuffix[zi]);
                }
              }
            }
            route.push(usedZigZag ? { ...finalDst, speedLimit: 0.55 } : { ...finalDst });
            const subRoute = subdivideWaypoints(sx, sy, route, 4.5);
            let px = sx;
            let py = sy;
            let segOk = true;
            for (let ri = 0; ri < subRoute.length; ri++) {
              if (minDistanceToObstacles(subRoute[ri].x, subRoute[ri].y, staticObs) < minClear ||
                  !pathIsClear(px, py, subRoute[ri].x, subRoute[ri].y, staticObs, minClear, startObs)) {
                segOk = false;
                break;
              }
              px = subRoute[ri].x;
              py = subRoute[ri].y;
            }
            if (!segOk) continue;
            if (isRouteBlockedByIdleOrMouthAgf(sx, sy, subRoute)) continue;
            let totalLen = 0;
            let lx = sx;
            let ly = sy;
            for (let ri = 0; ri < subRoute.length; ri++) {
              totalLen += Math.hypot(subRoute[ri].x - lx, subRoute[ri].y - ly);
              lx = subRoute[ri].x;
              ly = subRoute[ri].y;
            }
            const oppMaxSteps = Math.min(4800, Math.max(700, Math.ceil(totalLen * 70) + (usedZigZag ? 2000 : 0)));
            if (!isAgfArcClear(
              {
                ...st,
                x: sx,
                y: sy,
                heading: simH,
                speed: 0,
                steerAngleRad: 0,
              },
              subRoute,
              staticObs,
              arcClear,
              minDistanceToObstacles(sx, sy, staticObs),
              { maxSteps: oppMaxSteps, speedScales: [1.0], requireArrival: false },
            )) {
              continue;
            }
            oppRouteMemo.set(oppKey, subRoute);
            return subRoute;
          }
        }
      }
      oppRouteMemo.set(oppKey, null);
      return null;
    };

    const nextTail = tail[0] || null;
    if (
      isAgf &&
      hasRackBounds &&
      !inNarrowRackAisle &&
      nextTail &&
      (st.x <= rackMinX - 0.5 || st.x >= rackMaxX + 0.5) &&
      (isRouteBlockedByIdleOrMouthAgf(st.x, st.y, tail) || (st._dlFailCount ?? 0) >= 1 || (st._dlRepeatCount ?? 0) >= 2)
    ) {
      const directDst = tail[tail.length - 1];
      let directOpp = buildOppositeMouthRoute(st.x, st.y, st.heading, directDst);
      if (!directOpp && isRouteBlockedByIdleOrMouthAgf(st.x, st.y, tail)) {
        const candBypass = bypassIdleAgfSegment(st.x, st.y, tail);
        if (candBypass && candBypass.length > 0) {
          const checkSlice = candBypass.slice(0, 3);
          let bLen = 0, bpx = st.x, bpy = st.y;
          for (let bi = 0; bi < checkSlice.length; bi++) {
            bLen += Math.hypot(checkSlice[bi].x - bpx, checkSlice[bi].y - bpy);
            bpx = checkSlice[bi].x;
            bpy = checkSlice[bi].y;
          }
          const bSteps = Math.min(2400, Math.max(900, Math.ceil(bLen * 85)));
          if (isAgfArcClear(st, checkSlice, staticObs, arcClear, startMinDist, { maxSteps: bSteps, speedScales: [1.0, 0.45], checkReverseLocY: true, requireArrival: false })) {
            directOpp = candBypass;
          }
        }
      }
      if (directOpp && directOpp.length > 0) {
        if (item?.task?.type === "driveTo") {
          directOpp = maybeOrthogonalizeAgfTerminalRoute(st, directOpp, selfAgfEntry);
        }
        const escMetaDirect = {
          _deadlockEscape: true,
          ...(nearbyPeerIds.size > 0 ? { _escapePeers: nearbyPeerIds } : {}),
          ...(effBlk ? { _escapeFrom: effBlk.id } : {}),
        };
        const directWps = directOpp.map((pt, idx) => (idx < 2 ? { ...pt, ...escMetaDirect } : { ...pt }));
        const dirH = directWps[0]?.reverse ? wrapHeading(st.heading + Math.PI) : st.heading;
        const dirProx = effBlk ? queryLiveProximity(st.agentId, selfRadius, st.x, st.y, dirH, {}, { waypoints: directWps, waypointIndex: 0 }) : { stop: false };
        if (!dirProx.stop) {
          if (item?.data) {
            if (item.task?.type === "driveTo") item.data.waypoints = directWps;
            else if (item.phase === "route") item.data.route = directWps;
            item.data.waypointIndex = 0;
          }
          st.stuckTime = 0;
          st._dlRetryAt = null;
          st._dlFailCount = 0;
          return {
            ...dlCmd,
            waypoints: directWps,
            waypointIndex: 0,
          };
        }
      }
    }
    const computeTailAfterPass = (passPt, fromPullout = false) => {
      if (!tail.length) return { list: tail, reentered: false };
      let ti = 0;
      while (ti < tail.length - 1) {
        const w = tail[ti];
        const wn = tail[ti + 1];
        if (!w || w.reverse || w.docking || Number.isFinite(w.speedLimit)) break;
        if (Math.hypot(w.x - passPt.x, w.y - passPt.y) > 4.5) break;
        const segDx = wn.x - w.x;
        const segDy = wn.y - w.y;
        const segLen = Math.hypot(segDx, segDy);
        if (segLen > 1e-4 && ((segDx * fx + segDy * fy) / segLen) <= 0.35) break;
        const proj = (w.x - passPt.x) * fx + (w.y - passPt.y) * fy;
        if (proj >= 3.2) break;
        if (!pathIsClear(passPt.x, passPt.y, wn.x, wn.y, staticObs, minClear, startObs)) break;
        ti++;
      }
      const sliced = tail.slice(ti);
      if (
        isAgf &&
        hasRackBounds &&
        sliced.length > 0 &&
        (passPt.x < rackMinX - 0.5 || passPt.x > rackMaxX + 0.5) &&
        sliced[0].y >= rackMinY &&
        sliced[0].y <= rackMaxY &&
        ((sliced[0].x >= rackMinX - 0.5 && sliced[0].x <= rackMaxX + 0.5) ||
          Math.hypot(sliced[0].x - passPt.x, sliced[0].y - passPt.y) > 4.0)
      ) {
        const finalDst = sliced[sliced.length - 1];
        if (finalDst && Number.isFinite(finalDst.x) && Number.isFinite(finalDst.y)) {
          const pulloutHasAislePeer = Boolean(
            fromPullout &&
            ((passPt.x > rackMaxX + 0.5 && finalDst.x < rackMinX + 4.0) || (passPt.x < rackMinX - 0.5 && finalDst.x > rackMaxX - 4.0)) &&
            [...agfEntries.values()].some((a) => {
              const os = a.state;
              if (os.agentId === st.agentId) return false;
              return os.x >= rackMinX - 2.5 && os.x <= rackMaxX + 2.5 && Math.abs(os.y - passPt.y) <= 3.6;
            }),
          );
          if (pulloutHasAislePeer || isRouteBlockedByIdleOrMouthAgf(passPt.x, passPt.y, [{ x: finalDst.x, y: finalDst.y }])) {
            const opp = buildOppositeMouthRoute(passPt.x, passPt.y, st.heading, finalDst);
            if (opp) return { list: opp, reentered: true };
          }
          const reenter = findPathCached(passPt.x, passPt.y, finalDst.x, finalDst.y, st.heading);
          if (reenter && reenter.length > 0) {
            const reenterCopy = reenter.map((w) => ({ ...w }));
            reenterCopy[reenterCopy.length - 1] = { ...reenterCopy[reenterCopy.length - 1], ...finalDst };
            if (isRouteBlockedByIdleOrMouthAgf(passPt.x, passPt.y, reenterCopy)) {
              const opp = buildOppositeMouthRoute(passPt.x, passPt.y, st.heading, finalDst);
              if (opp) return { list: opp, reentered: true };
            }
            return { list: reenterCopy, reentered: true };
          }
        }
      }
      if (isAgf && hasRackBounds && isRouteBlockedByIdleOrMouthAgf(passPt.x, passPt.y, sliced)) {
        const finalDst = sliced[sliced.length - 1];
        const opp = buildOppositeMouthRoute(passPt.x, passPt.y, st.heading, finalDst);
        if (opp) return { list: opp, reentered: true };
        const bypassed = bypassIdleAgfSegment(passPt.x, passPt.y, sliced);
        if (bypassed) return { list: bypassed, reentered: true };
      }
      return { list: sliced, reentered: false };
    };

    let chosenSeq = null;
    let chosenPassPts = null;
    let chosenTail = tail;
    for (let i = 0; i < cands.length; i++) {
      const seq = cands[i];
      if (!inNarrowRackAisle && (st._dlRepeatCount ?? 0) >= 1 && Array.isArray(st._lastDlEscapes) && st._lastDlEscapes.some((prev) =>
        Math.hypot(st.x - prev.sx, st.y - prev.sy) < 0.45 &&
        Math.hypot(seq[0].x - prev.x, seq[0].y - prev.y) < 0.20 &&
        Math.hypot(seq[seq.length - 1].x - prev.lx, seq[seq.length - 1].y - prev.ly) < 0.25
      )) {
        continue;
      }
      if (isAgf && seq.length === 1 && !seq[0]._aisleStaticUnpin) {
        const dx0 = seq[0].x - st.x;
        const dy0 = seq[0].y - st.y;
        const dFwd0 = dx0 * fx + dy0 * fy;
        const dRight0 = dx0 * rx + dy0 * ry;
        const dLen0 = Math.hypot(dx0, dy0);
        if (
          (!seq[0].reverse && dFwd0 < 0.25) ||
          (seq[0].reverse && dFwd0 > -0.25) ||
          Math.abs(dRight0) > Math.abs(dFwd0) * 0.65 ||
          (dLen0 < 1.6 && Math.abs(dRight0) > 0.35)
        ) {
          continue;
        }
      }
      let valid = true;
      let px = st.x;
      let py = st.y;
      for (let j = 0; j < seq.length; j++) {
        const pt = seq[j];
        if (minDistanceToObstacles(pt.x, pt.y, staticObs) < minClear || !pathIsClear(px, py, pt.x, pt.y, staticObs, minClear, startObs)) {
          valid = false;
          break;
        }
        px = pt.x;
        py = pt.y;
      }
      if (!valid) continue;
      const isAislePullout = Boolean(isAgf && (seq[0]?._aisleExitPullout || seq[seq.length - 1]?._aisleExitPullout));
      const lastPt = seq[seq.length - 1];
      const escMetaAgf = {
        _deadlockEscape: true,
        ...(nearbyPeerIds.size > 0 ? { _escapePeers: nearbyPeerIds } : {}),
        ...(effBlk ? { _escapeFrom: effBlk.id } : {}),
      };
      const taggedSeq = seq.map((pt) => ({ ...pt, ...escMetaAgf }));
      if (isAgf && nearbyPeers.length > 0) {
        let peerSegOk = true;
        let sxp = st.x;
        let syp = st.y;
        for (let si = 0; si < seq.length; si++) {
          const sp = seq[si];
          for (let pi = 0; pi < nearbyPeers.length; pi++) {
            const p = nearbyPeers[pi];
            const reqD = Math.min(p.d - 0.02, selfRadius + p.radius + 0.06);
            if (pointToSegDist2D(p.x, p.y, sxp, syp, sp.x, sp.y) < reqD) {
              peerSegOk = false;
              break;
            }
          }
          if (!peerSegOk) break;
          sxp = sp.x;
          syp = sp.y;
        }
        if (!peerSegOk) continue;
      }
      if (effBlk) {
        const newDist = Math.hypot(effBlk.x - lastPt.x, effBlk.y - lastPt.y);
        const allowPulloutPastBlk = Boolean(
          isAislePullout &&
          newDist >= selfRadius + effBlk.radius + 0.45 &&
          pointToSegDist2D(effBlk.x, effBlk.y, st.x, st.y, lastPt.x, lastPt.y) >= selfRadius + effBlk.radius + 0.15,
        );
        const allowAmrSideBypass = Boolean(
          isAgf &&
          !isAislePullout &&
          !inAisleX &&
          !lastPt.reverse &&
          effBlk.id?.startsWith("amr:") &&
          ((lastPt.x - st.x) * fx + (lastPt.y - st.y) * fy) > 0 &&
          newDist >= selfRadius + effBlk.radius + 0.48 &&
          pointToSegDist2D(effBlk.x, effBlk.y, st.x, st.y, lastPt.x, lastPt.y) >= selfRadius + effBlk.radius + 0.25,
        );
        if (!allowPulloutPastBlk && !allowAmrSideBypass && newDist < effBlk.d + 0.05) continue;
        if (isAgf) {
          const escH = seq[0]?.reverse ? wrapHeading(st.heading + Math.PI) : st.heading;
          const escProx = queryLiveProximity(st.agentId, selfRadius, st.x, st.y, escH, {}, { waypoints: taggedSeq, waypointIndex: 0 });
          if (escProx.stop) continue;
        }
      }
      if (isAgf) {
        const arcSeqCheck = isAislePullout ? subdivideWaypoints(st.x, st.y, seq, 4.5) : seq;
        const arcHorizon = isAislePullout
          ? Math.min(2400, Math.max(480, Math.ceil(Math.hypot(lastPt.x - st.x, lastPt.y - st.y) * 90)))
          : (seq.length > 1 ? 360 : 270);
        if (!isAgfArcClear(st, arcSeqCheck, staticObs, arcClear, startMinDist, { maxSteps: arcHorizon, speedScales: [1.0, 0.45], checkReverseLocY: true })) continue;
        if (amrEntries.size > 0) {
          const nearbyAmrObs = [];
          for (const m of amrEntries.values()) {
            const ms = m.state;
            if (Math.hypot(ms.x - st.x, ms.y - st.y) > 6.5) continue;
            const mobbs = getEntryWorldObbs(m, false);
            for (const o of [...mobbs.chassis, ...mobbs.pallet]) {
              const ch = Math.abs(Math.cos(o.heading));
              const shv = Math.abs(Math.sin(o.heading));
              const rx = o.halfW * ch + o.halfL * shv;
              const ry = o.halfW * shv + o.halfL * ch;
              nearbyAmrObs.push({ id: `${ms.agentId}:dl`, kind: "vehicle", isAmr: true, x0: o.cx - rx, x1: o.cx + rx, y0: o.cy - ry, y1: o.cy + ry, obb: o });
            }
          }
          if (nearbyAmrObs.length > 0 && !isAgfArcClear(st, arcSeqCheck, nearbyAmrObs, 0.0, 0.0, { maxSteps: arcHorizon, speedScales: [1.0, 0.45], checkReverseLocY: true, checkCorners: false })) continue;
        }
        if (agfEntries.size > 1) {
          const nearbyAgfObs = [];
          for (const a of agfEntries.values()) {
            const as = a.state;
            if (as.agentId === st.agentId) continue;
            if (a.queue.length > 0) continue;
            if (Math.hypot(as.x - st.x, as.y - st.y) > ((isAislePullout && effBlkIdle) ? 10.5 : 6.5)) continue;
            const aobbs = getEntryWorldObbs(a, true);
            for (const o of [...aobbs.chassis, ...aobbs.pallet]) {
              const ch = Math.abs(Math.cos(o.heading));
              const shv = Math.abs(Math.sin(o.heading));
              const rx = o.halfW * ch + o.halfL * shv;
              const ry = o.halfW * shv + o.halfL * ch;
              nearbyAgfObs.push({ id: `${as.agentId}:dl`, kind: "vehicle", isAgf: true, x0: o.cx - rx, x1: o.cx + rx, y0: o.cy - ry, y1: o.cy + ry, obb: o });
            }
          }
          if (nearbyAgfObs.length > 0 && !isAgfArcClear(st, arcSeqCheck, nearbyAgfObs, 0.0, 0.0, { maxSteps: arcHorizon, speedScales: [1.0, 0.45], checkReverseLocY: true })) continue;
        }
      }
      const signedLat = (lastPt.x - st.x) * rx + (lastPt.y - st.y) * ry;
      const latOffset = Math.abs(signedLat);
      let candidatePassPts = null;
      let candidateTail = tail;
      if (!isAislePullout && (!lastPt.reverse || (isAgf && (latOffset > 0.35 || inAisleX)))) {
        const fwdAlong = (lastPt.x - st.x) * fx + (lastPt.y - st.y) * fy;
        const fwdList = lastPt.reverse ? [7.6, 9.6, 5.6, 3.8] : [2.2];
        for (const fwdDist of fwdList) {
          const totalFwd = fwdAlong + fwdDist;
          if (lastPt.reverse && totalFwd < 0.5) continue;
          const rawPassY = st.y + fy * totalFwd + ry * signedLat;
          const passPt = {
            x: st.x + fx * totalFwd + rx * signedLat,
            y: inAisleX ? clamp(rawPassY, aisleCenterY - 0.90, aisleCenterY + 0.90) : rawPassY,
            skipTol: 0.45,
            ...escMetaAgf,
          };
          const passDistObs = minDistanceToObstacles(passPt.x, passPt.y, staticObs);
          if (
            passDistObs < minClear ||
            !pathIsClear(lastPt.x, lastPt.y, passPt.x, passPt.y, staticObs, minClear, startObs)
          ) {
            continue;
          }
          if ((st._dlFailCount ?? 0) === 0 && !inAisleX && effBlk) {
            const minPassPeer = (effBlkIdle && effBlk.id?.startsWith("agf:"))
              ? ((st._dlRepeatCount ?? 0) >= 1 ? 3.4 : 2.8)
              : (selfRadius + effBlk.radius + 0.25);
            if (
              Math.hypot(passPt.x - effBlk.x, passPt.y - effBlk.y) < minPassPeer ||
              pointToSegDist2D(effBlk.x, effBlk.y, lastPt.x, lastPt.y, passPt.x, passPt.y) < minPassPeer
            ) {
              continue;
            }
          }
            if ((st._dlFailCount ?? 0) === 0 && !inAisleX && isAgf && agfEntries.size > 1) {
            let passHitsIdleAgf = false;
            for (const a of agfEntries.values()) {
              const as = a.state;
              if (as.agentId === st.agentId || a.queue.length > 0 || (as._idleSec ?? 0) < 0.25) continue;
              if (
                Math.hypot(passPt.x - as.x, passPt.y - as.y) < 2.6 ||
                pointToSegDist2D(as.x, as.y, lastPt.x, lastPt.y, passPt.x, passPt.y) < 2.2
              ) {
                passHitsIdleAgf = true;
                break;
              }
            }
            if (passHitsIdleAgf) continue;
          }
          const oyAisle = layout?.origin?.[1] ?? NE_FLATLAND_SITE.origin[1];
          const aisleSet = layout?.aisles?.length
            ? layout.aisles
            : [{ y: oyAisle + 3.0 }, { y: oyAisle - 3.0 }, { y: oyAisle - 9.0 }];
          const lastAlignedWithAisle =
            Math.abs(fy) < 0.35 &&
            Math.abs(passPt.y - lastPt.y) <= 1.0 &&
            aisleSet.some((a) => Math.abs(lastPt.y - a.y) <= 1.2);
          if (
            isAgf &&
            hasRackBounds &&
            !lastAlignedWithAisle &&
            (lastPt.x < rackMinX - 0.5 || lastPt.x > rackMaxX + 0.5) &&
            segmentIntersectsAabb2D(
              lastPt.x,
              lastPt.y,
              passPt.x,
              passPt.y,
              { x0: rackMinX - 1.5, x1: rackMaxX + 1.5, y0: rackMinY - 1.0, y1: rackMaxY + 1.0 },
              0,
            )
          ) {
            continue;
          }
          const passList = [passPt];
          if (isAgf && isRouteBlockedByIdleOrMouthAgf(lastPt.x, lastPt.y, passList)) {
            continue;
          }
          const { list: rawPostTail, reentered } = computeTailAfterPass(passPt);
          const postTail = rawPostTail.map((w) => (w ? { ...w } : w));
          const postNext = postTail[0] || null;
          if (isAgf && isRouteBlockedByIdleOrMouthAgf(passPt.x, passPt.y, postTail)) {
            continue;
          }
          if (!reentered && postNext && (postNext.x - passPt.x) * fx + (postNext.y - passPt.y) * fy < 0.4) {
            continue;
          }
          if (isAgf && postNext && !postNext.reverse && !pathIsClear(passPt.x, passPt.y, postNext.x, postNext.y, staticObs, minClear, startObs)) {
            continue;
          }
          const nearRackEnd = isAgf && hasRackBounds &&
            passPt.y >= rackMinY - 2.5 && passPt.y <= rackMaxY + 2.5 &&
            ((passPt.x >= rackMinX - 4.5 && passPt.x <= rackMinX + 2.0) ||
              (passPt.x >= rackMaxX - 2.0 && passPt.x <= rackMaxX + 7.5));
          const postTurn = postNext
            ? Math.abs(wrapPi(Math.atan2(postNext.x - passPt.x, postNext.y - passPt.y) - st.heading))
            : 0;
          if (isAgf && nearRackEnd && postTurn > 0.35 && passDistObs < selfRadius + (passPt.x > rackMaxX + 4.5 ? 1.25 : 0.90)) {
            continue;
          }
          if (
            isAgf &&
            hasRackBounds &&
            passPt.x >= rackMinX - 0.5 && passPt.x <= rackMaxX + 0.5 &&
            passPt.y >= rackMinY && passPt.y <= rackMaxY &&
            postNext && !postNext.reverse && postTurn > 1.2
          ) {
            continue;
          }
          if (isAgf && nearRackEnd && postTurn > 0.35) {
            passPt.speedLimit = Math.min(passPt.speedLimit ?? Infinity, 1.25);
            if (postNext && !postNext.reverse) {
              postNext.speedLimit = Math.min(postNext.speedLimit ?? Infinity, 1.35);
            }
          }
          let arcSeq = [...taggedSeq, ...passList];
          let finalPostTail = postTail;
          if (isAgf && postNext) {
            const postSub = subdivideWaypoints(passPt.x, passPt.y, postTail.slice(0, 3), 4.5);
            arcSeq = [...arcSeq, ...postSub.slice(0, 5)];
            if (!postNext.reverse) {
              const dPassNext = Math.hypot(postNext.x - passPt.x, postNext.y - passPt.y);
              if (dPassNext > 5.0 || Number.isFinite(postNext.speedLimit)) {
                finalPostTail = [...subdivideWaypoints(passPt.x, passPt.y, [postNext], 4.5), ...postTail.slice(1)];
              }
            }
          }
          let arcLen = 0;
          let axp = st.x;
          let ayp = st.y;
          for (let ai = 0; ai < arcSeq.length; ai++) {
            arcLen += Math.hypot(arcSeq[ai].x - axp, arcSeq[ai].y - ayp);
            axp = arcSeq[ai].x;
            ayp = arcSeq[ai].y;
          }
          const passArcMaxSteps = Math.max(postNext?.reverse ? 1400 : 720, Math.min(2400, Math.ceil(arcLen * 65)));
          if (!isAgf || isAgfArcClear(st, arcSeq, staticObs, arcClear, startMinDist, { maxSteps: passArcMaxSteps, speedScales: [1.0, 0.45], checkReverseLocY: true, checkTurnRunout: true })) {
            candidatePassPts = passList;
            candidateTail = finalPostTail;
            break;
          }
        }
      }

      if (isAgf && !candidatePassPts && nextTail) {
        let effTail = tail.map((w) => (w ? { ...w } : w));
        let reOk = false;
        const canUseEffTail = (candTail) => {
          const effNext = candTail[0];
          if (!effNext) return false;
          if (!isAislePullout && effBlk) {
            const segPeerDist = pointToSegDist2D(effBlk.x, effBlk.y, lastPt.x, lastPt.y, effNext.x, effNext.y);
            if (segPeerDist < selfRadius + effBlk.radius + 0.06) return false;
            const amrMinOff = (st._dlOscCount ?? 0) >= 2 ? 2.15 : 1.55;
            if (isAgf && !inNarrowRackAisle && ((st._dlRepeatCount ?? 0) >= 1 || (st._dlOscCount ?? 0) >= 2) && effBlk.id?.startsWith("amr:") && !effNext.docking && (segPeerDist < amrMinOff || Math.hypot(effNext.x - effBlk.x, effNext.y - effBlk.y) < amrMinOff)) {
              return false;
            }
            if (!inNarrowRackAisle && (lastPt.y - effBlk.y) * (effNext.y - effBlk.y) < 0 && segPeerDist < (effNext._deadlockEscape ? 2.6 : 3.2)) {
              return false;
            }
            if ((st._dlFailCount ?? 0) === 0 && (st._dlRepeatCount ?? 0) === 0 && !inNarrowRackAisle && lastPt.reverse && !effNext.reverse && effBlkIdle && effBlk.id?.startsWith("agf:")) {
              const seqLat = (lastPt.x - st.x) * rx + (lastPt.y - st.y) * ry;
              const passLat = (effNext.x - effBlk.x) * rx + (effNext.y - effBlk.y) * ry;
              if (Math.abs(seqLat) > 0.25 && Math.abs(passLat) > 0.5 && seqLat * passLat > 0) {
                return false;
              }
            }
          }
          if (effNext.reverse && !effNext.docking) {
            const revLocY = (effNext.x - lastPt.x) * fx + (effNext.y - lastPt.y) * fy;
            if (revLocY > 0.05) return false;
            if (effBlk && effBlkIdle && pointToSegDist2D(effBlk.x, effBlk.y, lastPt.x, lastPt.y, effNext.x, effNext.y) < 3.6) {
              return false;
            }
          } else if (!effNext.reverse) {
            if (!pathIsClear(lastPt.x, lastPt.y, effNext.x, effNext.y, staticObs, minClear, startObs)) return false;
            const narrowAisleLast = hasRackBounds &&
              lastPt.x >= rackMinX - 0.5 && lastPt.x <= rackMaxX + 0.5 &&
              lastPt.y >= rackMinY && lastPt.y <= rackMaxY;
            if (narrowAisleLast) {
              const lastH = lastPt._aisleStaticUnpin
                ? (lastPt.reverse
                  ? wrapHeading(Math.atan2(st.x - lastPt.x, st.y - lastPt.y))
                  : wrapHeading(Math.atan2(lastPt.x - st.x, lastPt.y - st.y)))
                : st.heading;
              const reTurn = Math.abs(wrapPi(Math.atan2(effNext.x - lastPt.x, effNext.y - lastPt.y) - lastH));
              if (reTurn > 1.2) return false;
            }
          }
          const reSub = subdivideWaypoints(lastPt.x, lastPt.y, candTail.slice(0, 5), 4.5);
          if (isAislePullout && reSub.length === 0) return false;
          const capLastEsc = Boolean(
            !isAislePullout &&
            !lastPt.reverse &&
            candTail.length === 1 &&
            Math.hypot(effNext.x - lastPt.x, effNext.y - lastPt.y) < 3.0,
          );
          const reSeq = isAislePullout
            ? subdivideWaypoints(st.x, st.y, taggedSeq, 4.5).map((pt) => ({ ...pt, ...escMetaAgf }))
            : (capLastEsc
              ? taggedSeq.map((pt, idx) => (idx === taggedSeq.length - 1
                ? { ...pt, speedLimit: Math.min(pt.speedLimit ?? Infinity, 0.85), skipTol: Math.min(pt.skipTol ?? 0.35, 0.25) }
                : pt))
              : taggedSeq);
          const reArc = [...reSeq, ...reSub.slice(0, 7)];
          let reLen = 0;
          let rpx = st.x;
          let rpy = st.y;
          for (let ri = 0; ri < reArc.length; ri++) {
            reLen += Math.hypot(reArc[ri].x - rpx, reArc[ri].y - rpy);
            rpx = reArc[ri].x;
            rpy = reArc[ri].y;
          }
          const reMaxSteps = Math.min(2800, Math.max(720, Math.ceil(reLen * 85)));
          const checkCloseArrival = Boolean(
            candTail.length <= 2 &&
            reSub.length <= 7 &&
            reLen <= 12.0 &&
            !candTail[candTail.length - 1]?._clampedClearTarget &&
            minDistanceToObstacles(candTail[candTail.length - 1].x, candTail[candTail.length - 1].y, staticObs) >= arcClear,
          );
          if (!isAgfArcClear(st, reArc, staticObs, arcClear, startMinDist, { maxSteps: reMaxSteps, speedScales: [1.0, 0.45], checkReverseLocY: true, checkTurnRunout: true, requireArrival: checkCloseArrival })) {
            return false;
          }
          if (capLastEsc && taggedSeq.length > 0) {
            const lastTagged = taggedSeq[taggedSeq.length - 1];
            lastTagged.speedLimit = Math.min(lastTagged.speedLimit ?? Infinity, 0.85);
            lastTagged.skipTol = Math.min(lastTagged.skipTol ?? 0.35, 0.25);
          }
          if ((st._dlFailCount ?? 0) === 0 && !inNarrowRackAisle && !isAislePullout && agfEntries.size > 1) {
            const reAgfObs = [];
            for (const a of agfEntries.values()) {
              const as = a.state;
              if (as.agentId === st.agentId || a.queue.length > 0 || (as._idleSec ?? 0) < 0.25) continue;
              if (Math.hypot(as.x - st.x, as.y - st.y) > 7.5) continue;
              const aobbs = getEntryWorldObbs(a, true);
              for (const o of [...aobbs.chassis, ...aobbs.pallet]) {
                const ch = Math.abs(Math.cos(o.heading));
                const shv = Math.abs(Math.sin(o.heading));
                const rxo = o.halfW * ch + o.halfL * shv;
                const ryo = o.halfW * shv + o.halfL * ch;
                reAgfObs.push({ id: `${as.agentId}:re`, kind: "vehicle", isAgf: true, x0: o.cx - rxo, x1: o.cx + rxo, y0: o.cy - ryo, y1: o.cy + ryo, obb: o });
              }
            }
            if (reAgfObs.length > 0 && !isAgfArcClear(st, reArc.slice(0, 4), reAgfObs, 0.05, 0.05, { maxSteps: reMaxSteps, speedScales: [1.0, 0.45], checkReverseLocY: true, requireArrival: false })) {
              return false;
            }
          }
          return true;
        };

        if (
          isReversingCmd &&
          nextTail.reverse &&
          !lastPt.reverse &&
          effTail.length >= 2 &&
          effBlk
        ) {
          const finalDstRev = effTail[effTail.length - 1];
          if (finalDstRev && Number.isFinite(finalDstRev.x) && Number.isFinite(finalDstRev.y)) {
            const lastPtHeading = Math.hypot(lastPt.x - st.x, lastPt.y - st.y) > 0.05
              ? wrapHeading(Math.atan2(lastPt.x - st.x, lastPt.y - st.y))
              : st.heading;
            const revEscapeReplan = findPathCached(lastPt.x, lastPt.y, finalDstRev.x, finalDstRev.y, lastPtHeading);
            if (
              revEscapeReplan &&
              revEscapeReplan.length > 0 &&
              !(revEscapeReplan[0].reverse && pointToSegDist2D(effBlk.x, effBlk.y, lastPt.x, lastPt.y, revEscapeReplan[0].x, revEscapeReplan[0].y) < 3.6)
            ) {
              const revCopy = revEscapeReplan.map((w) => ({ ...w }));
              revCopy[revCopy.length - 1] = { ...revCopy[revCopy.length - 1], ...finalDstRev };
              effTail = revCopy;
            }
          }
        }
        if (
          !nextTail.reverse &&
          hasRackBounds &&
          (lastPt.x < rackMinX - 0.5 || lastPt.x > rackMaxX + 0.5) &&
          ((nextTail.y >= rackMinY &&
            nextTail.y <= rackMaxY &&
            ((nextTail.x >= rackMinX - 0.5 && nextTail.x <= rackMaxX + 0.5) ||
              Math.hypot(nextTail.x - lastPt.x, nextTail.y - lastPt.y) > 4.0)) ||
            (isAislePullout && Math.hypot(nextTail.x - lastPt.x, nextTail.y - lastPt.y) > 4.0))
        ) {
          const finalDst = effTail[effTail.length - 1];
          if (finalDst && Number.isFinite(finalDst.x) && Number.isFinite(finalDst.y)) {
            const pulloutHasAislePeer = Boolean(
              isAislePullout &&
              ((lastPt.x > rackMaxX + 0.5 && finalDst.x < rackMinX + 4.0) || (lastPt.x < rackMinX - 0.5 && finalDst.x > rackMaxX - 4.0)) &&
              [...agfEntries.values()].some((a) => {
                const os = a.state;
                if (os.agentId === st.agentId) return false;
                return os.x >= rackMinX - 2.5 && os.x <= rackMaxX + 2.5 && Math.abs(os.y - lastPt.y) <= 3.6;
              }),
            );
            const escHOut = lastPt.reverse
              ? st.heading
              : (Math.hypot(lastPt.x - st.x, lastPt.y - st.y) > 0.25
                ? wrapHeading(Math.atan2(lastPt.x - st.x, lastPt.y - st.y))
                : st.heading);
            if (pulloutHasAislePeer || isRouteBlockedByIdleOrMouthAgf(lastPt.x, lastPt.y, [{ x: finalDst.x, y: finalDst.y }])) {
              const opp = buildOppositeMouthRoute(lastPt.x, lastPt.y, st.heading, finalDst);
              if (opp) {
                effTail = opp;
              } else {
                const reIdle = findPathIdleAvoidCached(lastPt.x, lastPt.y, finalDst.x, finalDst.y, escHOut);
                if (reIdle && reIdle.length > 0) {
                  const reIdleCopy = reIdle.map((w) => ({ ...w }));
                  reIdleCopy[reIdleCopy.length - 1] = { ...reIdleCopy[reIdleCopy.length - 1], ...finalDst };
                  if (!isRouteBlockedByIdleOrMouthAgf(lastPt.x, lastPt.y, reIdleCopy)) {
                    effTail = reIdleCopy;
                  }
                }
              }
            } else {
              const reenter = findPathCached(lastPt.x, lastPt.y, finalDst.x, finalDst.y, escHOut);
              if (reenter && reenter.length > 0) {
                const reenterCopy = reenter.map((w) => ({ ...w }));
                reenterCopy[reenterCopy.length - 1] = { ...reenterCopy[reenterCopy.length - 1], ...finalDst };
                if (isRouteBlockedByIdleOrMouthAgf(lastPt.x, lastPt.y, reenterCopy)) {
                  const opp = buildOppositeMouthRoute(lastPt.x, lastPt.y, st.heading, finalDst);
                  if (opp) {
                    effTail = opp;
                  } else {
                    const reIdle = findPathIdleAvoidCached(lastPt.x, lastPt.y, finalDst.x, finalDst.y, escHOut);
                    if (reIdle && reIdle.length > 0) {
                      const reIdleCopy = reIdle.map((w) => ({ ...w }));
                      reIdleCopy[reIdleCopy.length - 1] = { ...reIdleCopy[reIdleCopy.length - 1], ...finalDst };
                      effTail = isRouteBlockedByIdleOrMouthAgf(lastPt.x, lastPt.y, reIdleCopy) ? reenterCopy : reIdleCopy;
                    } else {
                      effTail = reenterCopy;
                    }
                  }
                } else {
                  effTail = reenterCopy;
                }
              }
            }
          }
        }
        let idleRouteBlk = false;
        if (item?.task?.type === "driveTo" && !inNarrowRackAisle) {
          const effStartH = Number.isFinite(lastPt.heading) ? lastPt.heading : st.heading;
          effTail = maybeOrthogonalizeAgfTerminalRoute({ ...st, x: lastPt.x, y: lastPt.y, heading: effStartH }, effTail, selfAgfEntry);
        }
        if (isRouteBlockedByIdleOrMouthAgf(lastPt.x, lastPt.y, effTail)) {
          const finalDstBlk = effTail[effTail.length - 1];
          const opp = buildOppositeMouthRoute(lastPt.x, lastPt.y, st.heading, finalDstBlk);
          if (opp) {
            effTail = opp;
            if (item?.task?.type === "driveTo" && !inNarrowRackAisle) {
              const effStartH = Number.isFinite(lastPt.heading) ? lastPt.heading : st.heading;
              effTail = maybeOrthogonalizeAgfTerminalRoute({ ...st, x: lastPt.x, y: lastPt.y, heading: effStartH }, effTail, selfAgfEntry);
            }
          } else {
            let resolvedIdle = null;
            if (isAislePullout && finalDstBlk && Number.isFinite(finalDstBlk.x) && Number.isFinite(finalDstBlk.y)) {
              const escHBlk = lastPt.reverse
                ? st.heading
                : (Math.hypot(lastPt.x - st.x, lastPt.y - st.y) > 0.25
                  ? wrapHeading(Math.atan2(lastPt.x - st.x, lastPt.y - st.y))
                  : st.heading);
              const reIdle = findPathIdleAvoidCached(lastPt.x, lastPt.y, finalDstBlk.x, finalDstBlk.y, escHBlk);
              if (reIdle && reIdle.length > 0) {
                const reIdleCopy = reIdle.map((w) => ({ ...w }));
                reIdleCopy[reIdleCopy.length - 1] = { ...reIdleCopy[reIdleCopy.length - 1], ...finalDstBlk };
                if (!isRouteBlockedByIdleOrMouthAgf(lastPt.x, lastPt.y, reIdleCopy)) {
                  resolvedIdle = reIdleCopy;
                }
              }
            }
            const bypassed = resolvedIdle || bypassIdleAgfSegment(lastPt.x, lastPt.y, effTail);
            if (bypassed) effTail = bypassed;
            else if (inNarrowRackAisle || (st._dlFailCount ?? 0) === 0) continue;
            else idleRouteBlk = true;
          }
        }
        if (inAisleX && effTail.length === 1 && Math.abs(effTail[0].y - aisleCenterY) <= 0.35 && Math.abs(lastPt.y - aisleCenterY) > 0.18 && Math.abs(effTail[0].x - lastPt.x) >= 2.2) {
          const alignStep = Math.min(2.2, Math.abs(effTail[0].x - lastPt.x) * 0.45);
          effTail = [
            { x: lastPt.x + Math.sign(effTail[0].x - lastPt.x) * alignStep, y: aisleCenterY, skipTol: 0.25, speedLimit: 0.90 },
            { ...effTail[0], speedLimit: 0.85 },
          ];
        }
        if (!idleRouteBlk && canUseEffTail(effTail)) {
          reOk = true;
        } else {
          const rawFinalDstDl = tail[tail.length - 1];
          const finalDst = (rawFinalDstDl && rawFinalDstDl._autoOrthoHeading)
            ? (() => { const c = { ...rawFinalDstDl }; delete c.heading; delete c._autoOrthoHeading; return c; })()
            : rawFinalDstDl;
          const blockedInsideSameAisle = Boolean(
            effBlkIdle &&
            hasRackBounds &&
            lastPt.x >= rackMinX - 0.5 && lastPt.x <= rackMaxX + 0.5 &&
            lastPt.y >= rackMinY && lastPt.y <= rackMaxY &&
            finalDst && Math.abs(finalDst.y - lastPt.y) <= 2.2
          );
          if (!blockedInsideSameAisle && finalDst && Number.isFinite(finalDst.x) && Number.isFinite(finalDst.y)) {
            const escH = lastPt.reverse ? st.heading : wrapHeading(Math.atan2(lastPt.x - st.x, lastPt.y - st.y));
            let oppDirect = buildOppositeMouthRoute(lastPt.x, lastPt.y, escH, finalDst);
            if (oppDirect && item?.task?.type === "driveTo" && !inNarrowRackAisle) {
              oppDirect = maybeOrthogonalizeAgfTerminalRoute({ ...st, x: lastPt.x, y: lastPt.y, heading: escH }, oppDirect, selfAgfEntry);
            }
            if (oppDirect && !isRouteBlockedByIdleOrMouthAgf(lastPt.x, lastPt.y, oppDirect) && canUseEffTail(oppDirect)) {
              effTail = oppDirect;
              reOk = true;
            } else {
              const reroute = findPathCached(lastPt.x, lastPt.y, finalDst.x, finalDst.y, escH);
              let candReroute = null;
              if (reroute && reroute.length > 0) {
                const rerouteCopy = reroute.map((w) => ({ ...w }));
                rerouteCopy[rerouteCopy.length - 1] = { ...rerouteCopy[rerouteCopy.length - 1], ...finalDst };
                candReroute = isRouteBlockedByIdleOrMouthAgf(lastPt.x, lastPt.y, rerouteCopy)
                  ? (buildOppositeMouthRoute(lastPt.x, lastPt.y, escH, finalDst) || bypassIdleAgfSegment(lastPt.x, lastPt.y, rerouteCopy))
                  : rerouteCopy;
                if (candReroute && item?.task?.type === "driveTo" && !inNarrowRackAisle) {
                  candReroute = maybeOrthogonalizeAgfTerminalRoute({ ...st, x: lastPt.x, y: lastPt.y, heading: escH }, candReroute, selfAgfEntry);
                }
              }
              if ((!candReroute || isRouteBlockedByIdleOrMouthAgf(lastPt.x, lastPt.y, candReroute) || !canUseEffTail(candReroute)) && isAislePullout) {
                const reIdle = findPathIdleAvoidCached(lastPt.x, lastPt.y, finalDst.x, finalDst.y, escH);
                if (reIdle && reIdle.length > 0) {
                  let reIdleCopy = reIdle.map((w) => ({ ...w }));
                  reIdleCopy[reIdleCopy.length - 1] = { ...reIdleCopy[reIdleCopy.length - 1], ...finalDst };
                  if (item?.task?.type === "driveTo" && !inNarrowRackAisle) {
                    reIdleCopy = maybeOrthogonalizeAgfTerminalRoute({ ...st, x: lastPt.x, y: lastPt.y, heading: escH }, reIdleCopy, selfAgfEntry);
                  }
                  if (!isRouteBlockedByIdleOrMouthAgf(lastPt.x, lastPt.y, reIdleCopy) && canUseEffTail(reIdleCopy)) {
                    candReroute = reIdleCopy;
                  }
                }
              }
              if (candReroute && !isRouteBlockedByIdleOrMouthAgf(lastPt.x, lastPt.y, candReroute) && canUseEffTail(candReroute)) {
                effTail = candReroute;
                reOk = true;
              } else if (reroute && reroute.length > 0 && !inNarrowRackAisle && dlFindPathBudget > 0 && !finalDst.reverse) {
                  dlFindPathBudget--;
                  const peerObs = [];
                  for (const a of agfEntries.values()) {
                    const as = a.state;
                    if (as.agentId === st.agentId) continue;
                    const isIdlePeer = a.queue.length === 0 && (as._idleSec ?? 0) >= 0.25;
                    const isEffPeer = effBlk && effBlk.id === `agf:${as.agentId}`;
                    if (!isIdlePeer && !(isEffPeer && ((st._dlFailCount ?? 0) >= 1 || (st._dlRepeatCount ?? 0) >= 1 || (st._dlOscCount ?? 0) >= 2))) continue;
                    const aobbs = getEntryWorldObbs(a, true);
                    for (const o of [...aobbs.chassis, ...aobbs.pallet]) {
                      const ch = Math.abs(Math.cos(o.heading));
                      const shv = Math.abs(Math.sin(o.heading));
                      const rxo = o.halfW * ch + o.halfL * shv;
                      const ryo = o.halfW * shv + o.halfL * ch;
                      peerObs.push({ id: `${as.agentId}:dlfp`, kind: "vehicle", isAgf: true, x0: o.cx - rxo, x1: o.cx + rxo, y0: o.cy - ryo, y1: o.cy + ryo, obb: o });
                    }
                  }
                  if (effBlk && effBlk.id?.startsWith("amr:") && ((st._dlFailCount ?? 0) >= 1 || (st._dlRepeatCount ?? 0) >= 1 || (st._dlOscCount ?? 0) >= 2)) {
                    const mEntry = amrEntries.get(effBlk.id.slice(4));
                    if (mEntry) {
                      const mobbs = getEntryWorldObbs(mEntry, false);
                      for (const o of [...mobbs.chassis, ...mobbs.pallet]) {
                        const ch = Math.abs(Math.cos(o.heading));
                        const shv = Math.abs(Math.sin(o.heading));
                        const rxo = o.halfW * ch + o.halfL * shv;
                        const ryo = o.halfW * shv + o.halfL * ch;
                        peerObs.push({ id: `${mEntry.state.agentId}:dlfp`, kind: "vehicle", isAmr: true, x0: o.cx - rxo, x1: o.cx + rxo, y0: o.cy - ryo, y1: o.cy + ryo, obb: o });
                      }
                    }
                  }
                  if (peerObs.length > 0) {
                    const dynReroute = findPath([lastPt.x, lastPt.y], [finalDst.x, finalDst.y], "agf", { heading: escH, extraObstacles: peerObs });
                    if (dynReroute && dynReroute.length > 0) {
                      let dynCopy = dynReroute.map((w) => ({ ...w }));
                      dynCopy[dynCopy.length - 1] = { ...dynCopy[dynCopy.length - 1], ...finalDst };
                      if (item?.task?.type === "driveTo") {
                        dynCopy = maybeOrthogonalizeAgfTerminalRoute({ ...st, x: lastPt.x, y: lastPt.y, heading: escH }, dynCopy, selfAgfEntry);
                      }
                      if (!isRouteBlockedByIdleOrMouthAgf(lastPt.x, lastPt.y, dynCopy) && canUseEffTail(dynCopy)) {
                        effTail = dynCopy;
                        reOk = true;
                      }
                    }
                  }
                }
            }
          }
        }
        if (!reOk) continue;
        candidateTail = effTail;
      }

      chosenSeq = isAislePullout
        ? subdivideWaypoints(st.x, st.y, taggedSeq, 4.5).map((pt) => ({ ...pt, ...escMetaAgf }))
        : taggedSeq;
      chosenPassPts = candidatePassPts;
      chosenTail = candidateTail;
      break;
    }
    if (!chosenSeq && isAgf && !inNarrowRackAisle && tail.length === 1) {
      const rawTailDst = tail[0];
      if (
        rawTailDst &&
        Number.isFinite(rawTailDst.x) &&
        Number.isFinite(rawTailDst.y) &&
        !rawTailDst.docking &&
        !rawTailDst.reverse &&
        Math.hypot(rawTailDst.x - st.x, rawTailDst.y - st.y) < 3.0
      ) {
        const cleanDst = rawTailDst._autoOrthoHeading
          ? (() => { const c = { ...rawTailDst }; delete c.heading; delete c._autoOrthoHeading; return c; })()
          : { ...rawTailDst };
        const dstList = rawTailDst._autoOrthoHeading ? [rawTailDst, cleanDst] : [cleanDst];
        const escMetaT = {
          _deadlockEscape: true,
          ...(nearbyPeerIds.size > 0 ? { _escapePeers: nearbyPeerIds } : {}),
          ...(effBlk ? { _escapeFrom: effBlk.id } : {}),
        };
        const sidePref = effBlk && ((effBlk.x - st.x) * rx + (effBlk.y - st.y) * ry) >= 0 ? -1 : 1;
        const turnCands = [];
        for (const dRev of [2.4, 3.0]) {
          for (const dDst of dstList) {
            turnCands.push([
              { x: st.x - fx * dRev, y: st.y - fy * dRev, reverse: true, skipTol: 0.35, speedLimit: 0.85, ...escMetaT },
              { ...dDst, speedLimit: Math.min(dDst.speedLimit ?? Infinity, 0.85) },
            ]);
          }
        }
        for (const sideSign of [sidePref, -sidePref]) {
          for (const dFwd of [2.6, 3.4]) {
            for (const dLat of [2.2, 2.8]) {
              const p1 = { x: st.x + fx * dFwd, y: st.y + fy * dFwd, skipTol: 0.45, speedLimit: 1.0, ...escMetaT };
              const p2 = { x: st.x + fx * (dFwd + 1.4) + rx * sideSign * dLat, y: st.y + fy * (dFwd + 1.4) + ry * sideSign * dLat, skipTol: 0.45, speedLimit: 0.95, ...escMetaT };
              const p3 = { x: cleanDst.x + fx * 0.6 + rx * sideSign * dLat, y: cleanDst.y + fy * 0.6 + ry * sideSign * dLat, skipTol: 0.40, speedLimit: 0.90 };
              for (const dDst of dstList) {
                turnCands.push([p1, p2, p3, { ...dDst, speedLimit: Math.min(dDst.speedLimit ?? Infinity, 0.85) }]);
              }
            }
          }
        }
        const nearVehObs = [];
        for (const a of agfEntries.values()) {
          const as = a.state;
          if (as.agentId === st.agentId || a.queue.length > 0) continue;
          if (Math.hypot(as.x - st.x, as.y - st.y) > 8.5) continue;
          const aobbs = getEntryWorldObbs(a, true);
          for (const o of [...aobbs.chassis, ...aobbs.pallet]) {
            const ch = Math.abs(Math.cos(o.heading));
            const shv = Math.abs(Math.sin(o.heading));
            const rxo = o.halfW * ch + o.halfL * shv;
            const ryo = o.halfW * shv + o.halfL * ch;
            nearVehObs.push({ id: `${as.agentId}:dlturn`, kind: "vehicle", isAgf: true, x0: o.cx - rxo, x1: o.cx + rxo, y0: o.cy - ryo, y1: o.cy + ryo, obb: o });
          }
        }
        for (const m of amrEntries.values()) {
          const ms = m.state;
          if (m.queue.length > 0) continue;
          if (Math.hypot(ms.x - st.x, ms.y - st.y) > 8.5) continue;
          const mobbs = getEntryWorldObbs(m, false);
          for (const o of [...mobbs.chassis, ...mobbs.pallet]) {
            const ch = Math.abs(Math.cos(o.heading));
            const shv = Math.abs(Math.sin(o.heading));
            const rxo = o.halfW * ch + o.halfL * shv;
            const ryo = o.halfW * shv + o.halfL * ch;
            nearVehObs.push({ id: `${ms.agentId}:dlturn`, kind: "vehicle", isAmr: true, x0: o.cx - rxo, x1: o.cx + rxo, y0: o.cy - ryo, y1: o.cy + ryo, obb: o });
          }
        }
        for (let ci = 0; ci < turnCands.length; ci++) {
          const candWps = turnCands[ci];
          let segOk = true;
          let px = st.x;
          let py = st.y;
          for (let wi = 0; wi < candWps.length; wi++) {
            const wp = candWps[wi];
            if (minDistanceToObstacles(wp.x, wp.y, staticObs) < minClear || !pathIsClear(px, py, wp.x, wp.y, staticObs, minClear, startObs)) {
              segOk = false;
              break;
            }
            px = wp.x;
            py = wp.y;
          }
          if (!segOk) continue;
          const firstH = candWps[0].reverse ? wrapHeading(st.heading + Math.PI) : st.heading;
          if (effBlk && queryLiveProximity(st.agentId, selfRadius, st.x, st.y, firstH, {}, { waypoints: candWps, waypointIndex: 0 }).stop) {
            continue;
          }
          if (!isAgfArcClear(st, candWps, staticObs, arcClear, startMinDist, { maxSteps: 1800, speedScales: [1.0, 0.45], checkReverseLocY: true, requireArrival: true })) {
            continue;
          }
          if (nearVehObs.length > 0 && !isAgfArcClear(st, candWps, nearVehObs, 0.02, 0.02, { maxSteps: 1800, speedScales: [1.0, 0.45], checkReverseLocY: true, requireArrival: false })) {
            continue;
          }
          chosenSeq = candWps.slice(0, -1);
          chosenPassPts = null;
          chosenTail = [candWps[candWps.length - 1]];
          break;
        }
      }
    }
    if (!chosenSeq) {
      st._dlFailCount = (st._dlFailCount ?? 0) + 1;
      st._dlRetryAt = st.stuckTime + Math.min(1.50, 0.25 * st._dlFailCount);
      return cmd;
    }

    const escapeSeq = chosenPassPts ? [...chosenSeq, ...chosenPassPts] : [...chosenSeq];
    const nextWps = [...escapeSeq, ...chosenTail];
    if (item?.data) {
      if (item.task?.type === "driveTo") item.data.waypoints = nextWps;
      else if (item.phase === "route") item.data.route = nextWps;
      item.data.waypointIndex = 0;
    }
    st.stuckTime = 0;
    st._dlRetryAt = null;
    st._dlFailCount = 0;
    if (Number.isFinite(st._lastDlX) && Math.hypot(st.x - st._lastDlX, st.y - st._lastDlY) < 0.75) {
      st._dlRepeatCount = (st._dlRepeatCount ?? 0) + 1;
    } else {
      st._dlRepeatCount = 0;
      st._lastDlEscapes = [];
    }
    if (Number.isFinite(st._dlAnchorX) && Math.hypot(st.x - st._dlAnchorX, st.y - st._dlAnchorY) < 2.2) {
      st._dlOscCount = (st._dlOscCount ?? 0) + 1;
    } else {
      st._dlOscCount = 0;
      st._dlAnchorX = st.x;
      st._dlAnchorY = st.y;
    }
    if (!Array.isArray(st._lastDlEscapes)) st._lastDlEscapes = [];
    if (chosenSeq?.[0]) {
      const lastEsc = chosenSeq[chosenSeq.length - 1];
      st._lastDlEscapes.push({ sx: st.x, sy: st.y, x: chosenSeq[0].x, y: chosenSeq[0].y, lx: lastEsc.x, ly: lastEsc.y });
      if (st._lastDlEscapes.length > 16) st._lastDlEscapes.shift();
    }
    st._lastDlX = st.x;
    st._lastDlY = st.y;
    return {
      ...dlCmd,
      waypoints: nextWps,
      waypointIndex: 0,
    };
  }

  function enforceMinSeparation(st, selfRadius, kin, isAgf, item = null) {
    const curX = st.x;
    const curY = st.y;
    const nextX = kin.x;
    const nextY = kin.y;
    const curH = st.heading;
    const nextH = kin.heading;
    const curTt = st.turntableYawRad ?? 0;
    const nextTt = kin.turntableYawRad ?? 0;
    if (isAgf) {
      const movedPos = nextX !== curX || nextY !== curY;
      const movedHeading = wrapPi(nextH - curH) !== 0;
      if (!movedPos && !movedHeading) return kin;
      let blocked = false;
      if (movedPos) {
        const checkOther = (otherId, otherRadius, ox, oy) => {
          if (otherId === st.agentId) return;
          if (!Number.isFinite(ox) || !Number.isFinite(oy)) return;
          const minSepReq = selfRadius + otherRadius + 0.06;
          const curDist = Math.hypot(ox - curX, oy - curY);
          const nextDist = Math.hypot(ox - nextX, oy - nextY);
          if (nextDist < minSepReq && nextDist < curDist) {
            blocked = true;
          }
        };
        for (const a of agfEntries.values()) checkOther(a.state.agentId, AGF_SPECS.hullRadiusM, a.state.x, a.state.y);
      }
      if (!blocked && (agfEntries.size > 1 || amrEntries.size > 0)) {
        const nextSelfObbs = getAgfWorldObbs(nextX, nextY, nextH, st.carriedWcid);
        let curSelfObbs = null;
        const checkSatPeer = (peerEntry, peerIsAgf) => {
          if (peerEntry.state.agentId === st.agentId) return false;
          const ox = peerEntry.state.x;
          const oy = peerEntry.state.y;
          if (!Number.isFinite(ox) || !Number.isFinite(oy)) return false;
          const nextD = Math.hypot(ox - nextX, oy - nextY);
          if (nextD > 4.35) return false;
          const otherObbs = getEntryWorldObbs(peerEntry, peerIsAgf);
          if (vehiclesSatOverlap2D(nextSelfObbs, otherObbs, 0.002)) {
            if (!curSelfObbs) curSelfObbs = getAgfWorldObbs(curX, curY, curH, st.carriedWcid);
            const curOverlap0 = vehiclesSatOverlap2D(curSelfObbs, otherObbs, 0);
            const nextOverlap0 = vehiclesSatOverlap2D(nextSelfObbs, otherObbs, 0);
            if (!curOverlap0 && nextOverlap0) return true;
            const curOverlap = vehiclesSatOverlap2D(curSelfObbs, otherObbs, 0.002);
            const curDist = Math.hypot(ox - curX, oy - curY);
            if (!curOverlap || nextD < curDist) {
              return true;
            }
          }
          return false;
        };
        for (const a of agfEntries.values()) {
          if (checkSatPeer(a, true)) {
            blocked = true;
            break;
          }
        }
        if (!blocked) {
          for (const m of amrEntries.values()) {
            if (checkSatPeer(m, false)) {
              blocked = true;
              break;
            }
          }
        }
      }
      if (!blocked) return kin;
      return {
        ...kin,
        x: curX,
        y: curY,
        speed: 0,
        heading: curH,
        steerAngleRad: Number.isFinite(kin.steerAngleRad) ? kin.steerAngleRad : st.steerAngleRad,
        wheelSpinRad: st.wheelSpinRad,
        arrived: false,
        yieldStopped: true,
        statusMode: "blocked",
      };
    }

    if (
      nextX === curX &&
      nextY === curY &&
      wrapPi(nextH - curH) === 0 &&
      wrapPi(nextTt - curTt) === 0
    ) {
      return kin;
    }

    const curSelfObbs = getAmrWorldObbs(curX, curY, curH, st.carriedWcid, curTt);
    const nextSelfObbs = getAmrWorldObbs(nextX, nextY, nextH, st.carriedWcid, nextTt);

    let blocked = false;
    const checkOther = (otherEntry, otherIsAgf) => {
      if (otherEntry.state.agentId === st.agentId) return;
      const ox = otherEntry.state.x;
      const oy = otherEntry.state.y;
      if (!Number.isFinite(ox) || !Number.isFinite(oy)) return;
      const maxReach = otherIsAgf ? 4.35 : 1.75;
      const nextDist = Math.hypot(ox - nextX, oy - nextY);
      if (nextDist > maxReach) return;

      const otherObbs = getEntryWorldObbs(otherEntry, otherIsAgf);
      if (vehiclesSatOverlap2D(nextSelfObbs, otherObbs, 0.002)) {
        const curOverlap0 = vehiclesSatOverlap2D(curSelfObbs, otherObbs, 0);
        const nextOverlap0 = vehiclesSatOverlap2D(nextSelfObbs, otherObbs, 0);
        if (!curOverlap0 && nextOverlap0) {
          blocked = true;
          return;
        }
        const curOverlap = vehiclesSatOverlap2D(curSelfObbs, otherObbs, 0.002);
        const curDist = Math.hypot(ox - curX, oy - curY);
        if (!curOverlap || nextDist < curDist) {
          blocked = true;
        }
      }
    };

    for (const a of agfEntries.values()) {
      checkOther(a, true);
      if (blocked) break;
    }
    if (!blocked) {
      for (const m of amrEntries.values()) {
        checkOther(m, false);
        if (blocked) break;
      }
    }
    if (!blocked) return kin;

    return {
      ...kin,
      x: curX,
      y: curY,
      heading: curH,
      speed: 0,
      omega: 0,
      turntableYawRad: curTt,
      heldCargoHeading: st.heldCargoHeading,
      wheelSpinL: st.wheelSpinL,
      wheelSpinR: st.wheelSpinR,
      arrived: false,
      yieldStopped: true,
      statusMode: "yield",
    };
  }

  function stepAgfEntry(entry, dt, staticObstacles = null) {
    const st = entry.state;
    const item = entry.queue[0] || null;

    if (item && !item.initialized) {
      item.initialized = true;
      try {
        initAgfTask(entry, item);
      } catch (err) {
        entry.queue.shift();
        item.reject(err);
        return stepAgfEntry(entry, 0, staticObstacles);
      }
    }

    let cmd = {
      targetForkHeightM: st.carriedWcid
        ? Math.max(AGF_CARRIED_TRANSIT_FORK_Z, st.supportSurfaceZ + AGF_CARRIED_FORK_CLEARANCE_M)
        : AGF_EMPTY_TRANSIT_FORK_Z,
      speed: 0,
    };
    let ignoreContainer = null;

    if (item) {
      const t = item.task;
      const d = item.data;

      if (t.type === "driveTo") {
        const wpIdx = d.waypointIndex ?? 0;
        const wpLen = Array.isArray(d.waypoints) ? d.waypoints.length : 0;
        const isLastLeg = wpLen <= 1 || wpIdx >= wpLen - 1;
        const curWp = wpLen > 0 ? d.waypoints[wpIdx] : null;
        const effTaskDock = (d.docking && isLastLeg) ? true : undefined;
        if (curWp?._stopAtWaypoint && wpIdx < wpLen - 1) {
          cmd = {
            targetPose: {
              x: curWp.x,
              y: curWp.y,
              ...(Number.isFinite(curWp.heading) ? { heading: curWp.heading } : {}),
            },
            reverse: curWp.reverse,
            docking: curWp.docking ?? effTaskDock,
            speedLimit: curWp.speedLimit ?? d.speedLimit,
            targetForkHeightM: st.carriedWcid ? AGF_CARRIED_TRANSIT_FORK_Z : AGF_EMPTY_TRANSIT_FORK_Z,
          };
        } else {
          cmd = {
            waypoints: d.waypoints,
            waypointIndex: wpIdx,
            reverse: d.reverse,
            docking: effTaskDock,
            speedLimit: d.speedLimit,
            targetForkHeightM: st.carriedWcid ? AGF_CARRIED_TRANSIT_FORK_Z : AGF_EMPTY_TRANSIT_FORK_Z,
          };
        }
      } else if (t.type === "placeInRack" || t.type === "pickFromRack") {
        const isPlace = t.type === "placeInRack";
        const liftTarget = Math.max(AGF_EMPTY_TRANSIT_FORK_Z, d.tierZ + (isPlace ? 0.12 : 0.02));
        const seatTarget = Math.max(AGF_EMPTY_TRANSIT_FORK_Z, d.tierZ + (isPlace ? 0.02 : 0.10));

        if (item.phase === "route") {
          const wpIdx = d.waypointIndex ?? 0;
          const curWp = d.route?.[wpIdx];
          const isStopWp = !!(curWp?._stopAtWaypoint && wpIdx < d.route.length - 1);
          const distToEnd = Math.hypot(d.approachPose.x - st.x, d.approachPose.y - st.y);
          const bearingToEnd = Math.atan2(d.approachPose.x - st.x, d.approachPose.y - st.y);
          const alignedToEnd = !isStopWp && (distToEnd <= 0.55 || Math.abs(wrapPi(bearingToEnd - st.heading)) <= 0.65);
          const facingRack = Math.abs(wrapPi(d.approachPose.heading - st.heading)) <= 0.70;
          const rawOverlapM = liftTarget > 0.50
            ? Math.min(8.0, ((liftTarget - 0.50) / AGF_SPECS.mastSpeedMps) * AGF_SPECS.vTipOverCappedMps)
            : 2.2;
          const overlapWindowM = (!facingRack && liftTarget <= 2.60) ? Math.min(rawOverlapM, 1.00) : rawOverlapM;
          const preForkZ = (alignedToEnd || st.forkHeightM > 0.50) && distToEnd <= overlapWindowM
            ? liftTarget
            : (distToEnd <= Math.max(2.2, overlapWindowM + 1.4) && alignedToEnd
              ? Math.min(liftTarget, 0.49)
              : (st.carriedWcid ? AGF_CARRIED_TRANSIT_FORK_Z : AGF_EMPTY_TRANSIT_FORK_Z));
          if (isStopWp) {
            cmd = {
              targetPose: {
                x: curWp.x,
                y: curWp.y,
                ...(Number.isFinite(curWp.heading) ? { heading: curWp.heading } : {}),
              },
              reverse: curWp.reverse,
              docking: curWp.docking,
              speedLimit: curWp.speedLimit,
              targetForkHeightM: preForkZ,
            };
          } else {
            cmd = {
              waypoints: d.route,
              waypointIndex: wpIdx,
              targetForkHeightM: preForkZ,
            };
          }
        } else if (item.phase === "raise") {
          cmd = { targetForkHeightM: liftTarget, speed: 0 };
        } else if (item.phase === "insert") {
          cmd = { targetPose: d.insertPose, targetForkHeightM: liftTarget, docking: true };
        } else if (item.phase === "actuate") {
          cmd = { targetForkHeightM: seatTarget, speed: 0 };
        } else if (item.phase === "retract") {
          cmd = { targetPose: d.retractPose, targetForkHeightM: seatTarget, reverse: true, speedLimit: 1.6 };
        } else if (item.phase === "abort_retract") {
          cmd = { targetPose: d.retractPose, targetForkHeightM: liftTarget, reverse: true, speedLimit: 1.6 };
        } else if (item.phase === "lower_transit") {
          cmd = { targetForkHeightM: 0.48, speed: 0 };
        } else if (item.phase === "abort_lower_transit") {
          cmd = {
            targetForkHeightM: st.carriedWcid ? AGF_CARRIED_TRANSIT_FORK_Z : AGF_EMPTY_TRANSIT_FORK_Z,
            speed: 0,
          };
        }
      } else if (t.type === "pickFromContainer" || t.type === "loadIntoContainer") {
        const isPick = t.type === "pickFromContainer";
        const enterForkZ = Math.max(d.floorZ + AGF_CARRIED_FORK_CLEARANCE_M, 0.227);
        const holdForkZ = d.floorZ + 0.095;
        const dropForkZ = d.floorZ + 0.02;

        if (item.phase === "route") {
          cmd = {
            waypoints: d.route,
            waypointIndex: d.waypointIndex,
            targetForkHeightM: isPick ? 0.227 : Math.max(AGF_CARRIED_TRANSIT_FORK_Z, enterForkZ),
          };
        } else if (item.phase === "lower_enter") {
          cmd = { targetForkHeightM: enterForkZ, speed: 0 };
        } else if (item.phase === "enter") {
          ignoreContainer = d.cEntry;
          cmd = {
            waypoints: d.enterWaypoints,
            waypointIndex: d.waypointIndex,
            targetForkHeightM: enterForkZ,
            speedLimit: AGF_SPECS.vContainerMps,
          };
        } else if (item.phase === "actuate") {
          cmd = { targetForkHeightM: isPick ? holdForkZ : dropForkZ, speed: 0 };
        } else if (item.phase === "exit" || item.phase === "abort_retract") {
          ignoreContainer = d.cEntry;
          const abortForkZ = st.carriedWcid ? Math.max(AGF_CARRIED_TRANSIT_FORK_Z, enterForkZ) : AGF_EMPTY_TRANSIT_FORK_Z;
          cmd = {
            waypoints: d.exitWaypoints,
            waypointIndex: d.waypointIndex,
            targetForkHeightM: item.phase === "abort_retract" ? abortForkZ : (isPick ? holdForkZ : AGF_EMPTY_TRANSIT_FORK_Z),
            reverse: true,
            speedLimit: AGF_SPECS.vContainerMps,
          };
        } else if (item.phase === "lower_transit") {
          cmd = { targetForkHeightM: AGF_CARRIED_TRANSIT_FORK_Z, speed: 0 };
        }
      } else if (t.type === "placeOnStand" || t.type === "pickFromStand") {
        const isPlace = t.type === "placeOnStand";
        if (d.target.kind === "liftTable" && (item.phase === "route" || item.phase === "raise")) {
          d.surfaceZ = d.target.handle.heightM;
        }
        const liftForkZ = Math.max(AGF_EMPTY_TRANSIT_FORK_Z, d.surfaceZ + (isPlace ? 0.085 : 0.02));
        const actForkZ = Math.max(AGF_EMPTY_TRANSIT_FORK_Z, d.surfaceZ + (isPlace ? 0.02 : 0.085));
        if (item.phase === "route") {
          cmd = {
            waypoints: d.route,
            waypointIndex: d.waypointIndex,
            targetForkHeightM: st.carriedWcid ? AGF_CARRIED_TRANSIT_FORK_Z : AGF_EMPTY_TRANSIT_FORK_Z,
          };
        } else if (item.phase === "raise") {
          cmd = { targetForkHeightM: liftForkZ, speed: 0 };
        } else if (item.phase === "insert") {
          cmd = { targetPose: d.insertPose, targetForkHeightM: liftForkZ, docking: true };
        } else if (item.phase === "actuate") {
          cmd = { targetForkHeightM: actForkZ, speed: 0 };
        } else if (item.phase === "retract") {
          cmd = { targetPose: d.retractPose, targetForkHeightM: actForkZ, reverse: true, speedLimit: 1.6 };
        } else if (item.phase === "abort_retract") {
          cmd = { targetPose: d.retractPose, targetForkHeightM: st.forkHeightM, reverse: true, speedLimit: 1.6 };
        }
      } else if (t.type === "pickGroundDeployable" || t.type === "dropToGround") {
        const isPick = t.type === "pickGroundDeployable";
        if (item.phase === "route") {
          cmd = {
            waypoints: d.route,
            waypointIndex: d.waypointIndex,
            targetForkHeightM: st.carriedWcid ? AGF_CARRIED_TRANSIT_FORK_Z : AGF_EMPTY_TRANSIT_FORK_Z,
          };
        } else if (item.phase === "insert") {
          cmd = {
            targetPose: d.insertPose,
            targetForkHeightM: isPick ? AGF_EMPTY_TRANSIT_FORK_Z : AGF_CARRIED_TRANSIT_FORK_Z,
            docking: true,
          };
        } else if (item.phase === "actuate") {
          cmd = {
            targetForkHeightM: isPick ? AGF_CARRIED_TRANSIT_FORK_Z : AGF_EMPTY_TRANSIT_FORK_Z,
            speed: 0,
          };
        } else if (item.phase === "retract") {
          cmd = {
            targetPose: d.retractPose,
            targetForkHeightM: isPick ? AGF_CARRIED_TRANSIT_FORK_Z : AGF_EMPTY_TRANSIT_FORK_Z,
            reverse: true,
            speedLimit: 1.6,
          };
        }
      }
    }

    const frameObstacles = staticObstacles || getStaticObstacles();
    // Check mutual yield deadlock breaker
    cmd = applyDeadlockBreaker(st, AGF_SPECS.hullRadiusM, item, cmd, dt, true, frameObstacles);
    if (item?.data && Array.isArray(cmd.waypoints) && (item.phase === "drive" || item.phase === "route")) {
      let curIdx = cmd.waypointIndex ?? 0;
      const [fHx, fHy] = headingForward(st.heading);
      while (curIdx < cmd.waypoints.length) {
        const curWp = cmd.waypoints[curIdx];
        if (curWp && curWp._deadlockEscape && curWp.reverse && !curWp.docking) {
          const locY = (curWp.x - st.x) * fHx + (curWp.y - st.y) * fHy;
          if (locY > 0.15) {
            if (curIdx < cmd.waypoints.length - 1) {
              curIdx++;
              continue;
            }
            curWp.reverse = false;
          }
        }
        break;
      }
      if (curIdx !== (cmd.waypointIndex ?? 0)) {
        cmd = { ...cmd, waypointIndex: curIdx };
        item.data.waypointIndex = curIdx;
      }
    }

    const containerList = [];
    if (ignoreContainer) {
      const p = containerWorldPos(ignoreContainer);
      containerList.push({
        x: p[0],
        y: p[1],
        heading: ignoreContainer.heading || 0,
        kind: ignoreContainer.kind,
      });
    }

    const kinRaw = stepAgfKinematics(st, cmd, dt, {
      agentId: st.agentId,
      grid: makeProximityGridFor(AGF_SPECS.hullRadiusM, cmd),
      containers: containerList,
    });
    let ignorePushoutId = null;
    if (item) {
      const tType = item.task.type;
      const ph = item.phase;
      if ((tType === "placeInRack" || tType === "pickFromRack") && (ph === "insert" || ph === "actuate" || ph === "retract" || ph === "abort_retract")) {
        ignorePushoutId = item.data.row.id;
      } else if ((tType === "pickFromContainer" || tType === "loadIntoContainer") && ph !== "route") {
        ignorePushoutId = item.data.cGuid;
      } else if ((tType === "placeOnStand" || tType === "pickFromStand") && (ph === "insert" || ph === "actuate" || ph === "retract" || ph === "abort_retract")) {
        ignorePushoutId = item.data.target.handle.id;
      }
    }
    if (item?.data && !item.data._startCloseObsInit) {
      item.data._startCloseObsInit = true;
      const sc = [];
      const startPushR = 0.70;
      for (let i = 0; i < frameObstacles.length; i++) {
        const b = frameObstacles[i];
        if (!b || (b.kind !== "rack" && b.kind !== "charger" && b.kind !== "container" && b.kind !== "liftTable")) continue;
        const dSt = pointToObstacleDist(st.x, st.y, b);
        const isRawCtr = b.kind === "container" && b.obb && Number.isFinite(b.obb.rawHalfW);
        const minValidD = isRawCtr ? 0.532 : 0.572;
        if (dSt >= minValidD && dSt < startPushR) {
          const evalObs = isRawCtr
            ? { ...b, obb: { ...b.obb, halfW: b.obb.rawHalfW, halfL: b.obb.rawHalfL } }
            : b;
          if (isAgfPoseObbClear(st.x, st.y, st.heading, [evalObs], 0.001, null, st.carriedWcid, st.forkHeightM)) {
            sc.push({ id: b.id, r: minValidD, isRawCtr });
          }
        }
      }
      item.data._startCloseObs = sc;
    }
    const ovMap = new Map();
    if (item && !ignorePushoutId) {
      if ((item.phase === "drive" || item.phase === "route") && Array.isArray(item.data?._startCloseObs) && item.data._startCloseObs.length > 0) {
        const keepSc = [];
        for (let i = 0; i < item.data._startCloseObs.length; i++) {
          const scEntry = item.data._startCloseObs[i];
          const b = frameObstacles.find((ob) => ob && ob.id === scEntry.id);
          if (!b) continue;
          const dKin = pointToObstacleDist(kinRaw.x, kinRaw.y, b);
          if (dKin >= 0.72) continue;
          keepSc.push(scEntry);
          if (dKin < AGF_SPECS.hullRadiusM + 0.004) {
            const evalObs = scEntry.isRawCtr && b.obb && Number.isFinite(b.obb.rawHalfW)
              ? { ...b, obb: { ...b.obb, halfW: b.obb.rawHalfW, halfL: b.obb.rawHalfL } }
              : b;
            if (isAgfPoseObbClear(kinRaw.x, kinRaw.y, kinRaw.heading, [evalObs], 0.001, null, st.carriedWcid, kinRaw.forkHeightM)) {
              ovMap.set(b.id, ovMap.has(b.id) ? Math.min(ovMap.get(b.id), scEntry.r) : scEntry.r);
            }
          }
        }
        item.data._startCloseObs = keepSc;
      }
      if (item.task?.type === "driveTo" && Array.isArray(cmd.waypoints) && cmd.waypoints.length > 0) {
        const finalWp = cmd.waypoints[cmd.waypoints.length - 1];
        if (finalWp && Math.hypot(finalWp.x - st.x, finalWp.y - st.y) <= 2.35) {
          let bestOb = null;
          let bestD = Infinity;
          for (let i = 0; i < frameObstacles.length; i++) {
            const b = frameObstacles[i];
            if (!b || (b.kind !== "rack" && b.kind !== "charger" && b.kind !== "container" && b.kind !== "liftTable")) continue;
            const d = pointToObstacleDist(finalWp.x, finalWp.y, b);
            if (d < bestD) { bestD = d; bestOb = b; }
          }
          const minValidD = (bestOb?.kind === "container" && bestOb?.obb?.rawHalfW != null) ? 0.532 : 0.572;
          if (bestOb && bestD >= minValidD && bestD < AGF_SPECS.hullRadiusM + 0.004) {
            const rVal = Math.min(AGF_SPECS.hullRadiusM + 0.002, Math.max(minValidD, bestD - 0.004));
            ovMap.set(bestOb.id, ovMap.has(bestOb.id) ? Math.min(ovMap.get(bestOb.id), rVal) : rVal);
          }
        }
        for (let i = 0; i < frameObstacles.length; i++) {
          const b = frameObstacles[i];
          if (!b || b.kind !== "container" || !b.obb || !Number.isFinite(b.obb.rawHalfW)) continue;
          if (ovMap.has(b.id)) continue;
          const dSt = pointToObstacleDist(st.x, st.y, b);
          if (dSt < AGF_SPECS.hullRadiusM + 0.004) {
            const rawObs = { ...b, obb: { ...b.obb, halfW: b.obb.rawHalfW, halfL: b.obb.rawHalfL } };
            if (isAgfPoseObbClear(kinRaw.x, kinRaw.y, kinRaw.heading, [rawObs], 0.001, null, st.carriedWcid, kinRaw.forkHeightM)) {
              ovMap.set(b.id, 0.532);
            }
          }
        }
      }
    } else if (!item && !ignorePushoutId) {
      const idlePushR = AGF_SPECS.hullRadiusM + 0.002;
      for (let i = 0; i < frameObstacles.length; i++) {
        const b = frameObstacles[i];
        if (!b || (b.kind !== "rack" && b.kind !== "charger" && b.kind !== "container" && b.kind !== "liftTable")) continue;
        const dCur = pointToObstacleDist(kinRaw.x, kinRaw.y, b);
        const isRawCtr = b.kind === "container" && b.obb && Number.isFinite(b.obb.rawHalfW);
        const minValidD = isRawCtr ? 0.532 : 0.572;
        if (dCur >= minValidD && dCur < idlePushR) {
          const evalObs = isRawCtr
            ? { ...b, obb: { ...b.obb, halfW: b.obb.rawHalfW, halfL: b.obb.rawHalfL } }
            : b;
          if (isAgfPoseObbClear(kinRaw.x, kinRaw.y, kinRaw.heading, [evalObs], 0.0001, null, st.carriedWcid, kinRaw.forkHeightM)) {
            ovMap.set(b.id, Math.max(minValidD, dCur - 0.001));
          }
        }
      }
    }
    let agfOverrideObsId = null;
    let agfOverrideObsR = 0;
    let agfExtraOverrides = null;
    if (ovMap.size > 0) {
      const ovEntries = Array.from(ovMap.entries());
      agfOverrideObsId = ovEntries[0][0];
      agfOverrideObsR = ovEntries[0][1];
      if (ovEntries.length > 1) {
        agfExtraOverrides = ovEntries.slice(1).map(([id, r]) => ({ id, r }));
      }
    }
    let pushOut;
    if (agfExtraOverrides && agfExtraOverrides.length > 0) {
      const extraMap = new Map();
      for (let i = 0; i < agfExtraOverrides.length; i++) extraMap.set(agfExtraOverrides[i].id, agfExtraOverrides[i].r);
      const baseObs = frameObstacles.filter((b) => b && !extraMap.has(b.id));
      const extraObsList = frameObstacles.filter((b) => b && extraMap.has(b.id));
      let px = kinRaw.x;
      let py = kinRaw.y;
      let hitAny = false;
      let hitBoxAny = null;
      for (let pass = 0; pass < 2; pass++) {
        const pBase = resolveStaticObstaclePushout(
          px, py, AGF_SPECS.hullRadiusM + 0.002, baseObs, ignorePushoutId, 0, agfOverrideObsId, agfOverrideObsR,
        );
        if (pBase.hit) { px = pBase.x; py = pBase.y; hitAny = true; if (!hitBoxAny) hitBoxAny = pBase.hitBox; }
        for (let ei = 0; ei < extraObsList.length; ei++) {
          const eb = extraObsList[ei];
          const er = extraMap.get(eb.id);
          const pEx = resolveStaticObstaclePushout(px, py, er, [eb], ignorePushoutId, 0);
          if (pEx.hit) { px = pEx.x; py = pEx.y; hitAny = true; if (!hitBoxAny) hitBoxAny = pEx.hitBox; }
        }
      }
      pushOut = { x: px, y: py, hit: hitAny, hitBox: hitBoxAny };
    } else {
      pushOut = resolveStaticObstaclePushout(
        kinRaw.x,
        kinRaw.y,
        AGF_SPECS.hullRadiusM + 0.002,
        frameObstacles,
        ignorePushoutId,
        0,
        agfOverrideObsId,
        agfOverrideObsR,
      );
    }
    const kinPushed = pushOut.hit ? { ...kinRaw, x: pushOut.x, y: pushOut.y } : kinRaw;
    let kinGuard = kinPushed;
    let kinGuardCtrStopGuid = null;
    if (
      item &&
      !ignorePushoutId &&
      (item.phase === "drive" || item.phase === "route") &&
      (kinPushed.x !== st.x || kinPushed.y !== st.y || wrapPi(kinPushed.heading - st.heading) !== 0)
    ) {
      const ctrTargetGuid = (item.task?.type === "pickFromContainer" || item.task?.type === "loadIntoContainer")
        ? (item.data?.cGuid >>> 0)
        : null;
      const ctrTargetEntry = ctrTargetGuid !== null ? containers.get(ctrTargetGuid) : null;
      const ctrTargetOpen = Boolean(ctrTargetEntry && !isContainerTrailerMounted(ctrTargetEntry) && isContainerDoorOpen(ctrTargetEntry));
      const ctrTargetSpec = ctrTargetOpen ? resolveContainerLogisticsSpec(ctrTargetEntry.kind) : null;
      const ctrTargetEnv = ctrTargetOpen ? resolveContainerEnvelopeSpec(ctrTargetEntry) : null;
      const ctrTargetPos = ctrTargetOpen ? containerWorldPos(ctrTargetEntry) : null;
      const ctrTargetH = ctrTargetOpen ? (ctrTargetEntry.heading || 0) : 0;
      let hitOb = null;
      for (let oi = 0; oi < frameObstacles.length; oi++) {
        const b = frameObstacles[oi];
        if (!b) continue;
        let evalB = b;
        if (b.kind === "container" && b.obb && Number.isFinite(b.obb.rawHalfW)) {
          evalB = { ...b, obb: { ...b.obb, halfW: b.obb.rawHalfW, halfL: b.obb.rawHalfL } };
        }
        if (
          ctrTargetGuid !== null &&
          b.kind === "container" &&
          (b.id >>> 0) === ctrTargetGuid &&
          ctrTargetOpen &&
          ctrTargetSpec &&
          ctrTargetEnv &&
          ctrTargetPos &&
          (cmd.waypointIndex ?? 0) >= Math.max(0, (cmd.waypoints?.length ?? 1) - 1) &&
          Math.abs(wrapPi(kinPushed.heading - ctrTargetH)) < 0.15
        ) {
          const cl = worldToLocalPoint(kinPushed.x, kinPushed.y, ctrTargetPos[0], ctrTargetPos[1], ctrTargetH);
          const halfSpan = st.carriedWcid ? AMR_PALLET_HALF_W : AGF_SPECS.forkWidthM * 0.5;
          if (
            Math.abs(cl.x) + halfSpan < ctrTargetSpec.interior.halfW - 0.015 &&
            cl.y <= -(ctrTargetEnv.halfExtL + 0.45) &&
            cl.y >= -(ctrTargetEnv.halfExtL + 2.20)
          ) {
            continue;
          }
        }
        if (
          isAgfPoseObbClear(st.x, st.y, st.heading, [evalB], 0.0, null, st.carriedWcid, st.forkHeightM) &&
          !isAgfPoseObbClear(kinPushed.x, kinPushed.y, kinPushed.heading, [evalB], 0.0, null, st.carriedWcid, kinPushed.forkHeightM)
        ) {
          hitOb = b;
          if (
            ctrTargetGuid !== null &&
            b.kind === "container" &&
            (b.id >>> 0) === ctrTargetGuid &&
            !ctrTargetOpen
          ) {
            kinGuardCtrStopGuid = ctrTargetGuid;
          }
          break;
        }
      }
      if (hitOb) {
        kinGuard = {
          ...kinPushed,
          x: st.x,
          y: st.y,
          speed: 0,
          heading: st.heading,
          steerAngleRad: st.steerAngleRad,
          wheelSpinRad: st.wheelSpinRad,
          arrived: false,
          yieldStopped: true,
          statusMode: "blocked",
        };
      }
    }
    const kin = enforceMinSeparation(st, AGF_SPECS.hullRadiusM, kinGuard, true, item);

    st.x = kin.x;
    st.y = kin.y;
    st.heading = kin.heading;
    st.speed = kin.speed;
    st.steerAngleRad = kin.steerAngleRad;
    if (kin.yieldStopped && st.stuckTime >= 0.15 && Math.abs(st.steerAngleRad) > 1e-4 && kin.x === st.x && kin.y === st.y && wrapPi(kin.heading - st.heading) === 0) {
      let rMinX = Infinity;
      let rMaxX = -Infinity;
      let rMinY = Infinity;
      let rMaxY = -Infinity;
      for (const r of racks.values()) {
        const b = r.worldBounds;
        if (!b) continue;
        if (b.minX < rMinX) rMinX = b.minX;
        if (b.maxX > rMaxX) rMaxX = b.maxX;
        if (b.minY < rMinY) rMinY = b.minY;
        if (b.maxY > rMaxY) rMaxY = b.maxY;
      }
      const inRackAisleBox = rMinX < Infinity && st.x >= rMinX - 1.2 && st.x <= rMaxX + 1.2 && st.y >= rMinY && st.y <= rMaxY;
      if (!inRackAisleBox) {
        const unwindStep = 3.2 * dt;
        st.steerAngleRad = Math.abs(st.steerAngleRad) <= unwindStep
          ? 0
          : st.steerAngleRad - Math.sign(st.steerAngleRad) * unwindStep;
      }
    }
    st.forkHeightM = kin.forkHeightM;
    st.sideShiftM = kin.sideShiftM;
    st.mastTiltRad = kin.mastTiltRad;
    st.wheelSpinRad = kin.wheelSpinRad;
    st.lidarSpinRad = kin.lidarSpinRad;
    st.statusMode = kin.statusMode;
    st.yieldStopped = kin.yieldStopped;
    st.yieldSlowed = kin.yieldSlowed;
    if (item?.data && Array.isArray(cmd.waypoints)) {
      let wpIdx = kin.waypointIndex;
      while (wpIdx < cmd.waypoints.length - 1) {
        const wp = cmd.waypoints[wpIdx];
        if (wp?._stopAtWaypoint) break;
        const skipTol = Number.isFinite(wp?.skipTol) ? wp.skipTol : (wp?.speedLimit ? 0.50 : 1.25);
        if (wp && Math.hypot(wp.x - st.x, wp.y - st.y) <= skipTol && !wp.docking) {
          wpIdx++;
        } else {
          break;
        }
      }
      item.data.waypointIndex = wpIdx;
      const curWpBypass = cmd.waypoints[wpIdx];
      const pushDist = pushOut?.hit ? Math.hypot(pushOut.x - kinRaw.x, pushOut.y - kinRaw.y) : 0;
      const dHitRaw = (pushOut?.hit && pushOut.hitBox) ? pointToObstacleDist(kinRaw.x, kinRaw.y, pushOut.hitBox) : Infinity;
      const skipMarginNudgeBypass = Boolean(
        pushOut?.hit &&
        pushOut.hitBox &&
        dHitRaw >= AGF_SPECS.hullRadiusM - 0.004 &&
        pushDist <= 0.006 &&
        isAgfPoseObbClear(kinRaw.x, kinRaw.y, kinRaw.heading, frameObstacles, 0.001, null, st.carriedWcid, kinRaw.forkHeightM)
      );
      const skipCloseFinalBypass = Boolean(
        item.task?.type === "driveTo" &&
        wpIdx >= cmd.waypoints.length - 1 &&
        pushOut?.hit &&
        pushOut.hitBox &&
        curWpBypass &&
        Math.hypot(curWpBypass.x - st.x, curWpBypass.y - st.y) <= 2.35 &&
        pointToObstacleDist(curWpBypass.x, curWpBypass.y, pushOut.hitBox) >= 0.570 &&
        pointToObstacleDist(curWpBypass.x, curWpBypass.y, pushOut.hitBox) < 0.80
      );
      if (!skipCloseFinalBypass && !skipMarginNudgeBypass) {
        maybeInsertCornerBypass(st, item, cmd, wpIdx, pushOut, AGF_SPECS.hullRadiusM, frameObstacles);
      }
    }

    grid.claim(st.agentId, { x: st.x, y: st.y, heading: st.heading, radius: AGF_SPECS.hullRadiusM, kind: "agf" });

    // Advance task state machine
    if (item) {
      const t = item.task;
      const d = item.data;

      if (t.type === "driveTo") {
        const curWpStop = Array.isArray(d.waypoints) ? d.waypoints[d.waypointIndex ?? 0] : null;
        if (curWpStop?._stopAtWaypoint && (d.waypointIndex ?? 0) < d.waypoints.length - 1) {
          if (kin.arrived) {
            st.speed = 0;
            d.waypointIndex = (d.waypointIndex ?? 0) + 1;
          }
        } else {
          const finalWp = Array.isArray(d.waypoints) ? d.waypoints[d.waypoints.length - 1] : null;
          const pushOutClampedAtTarget = Boolean(
            finalWp &&
            !finalWp._clampedClearTarget &&
            pushOut.hit &&
            minDistanceToObstacles(finalWp.x, finalWp.y, frameObstacles) < AGF_SPECS.hullRadiusM + 0.005 &&
            Math.hypot(finalWp.x - kin.x, finalWp.y - kin.y) <= 0.148 &&
            (Math.hypot(finalWp.x - kinRaw.x, finalWp.y - kinRaw.y) <= 0.03 ||
              (Math.hypot(kin.x - st.x, kin.y - st.y) < 0.002 &&
                Math.hypot(finalWp.x - kinRaw.x, finalWp.y - kinRaw.y) < Math.hypot(finalWp.x - st.x, finalWp.y - st.y)))
          );
          if (kin.arrived || pushOutClampedAtTarget) {
            st.speed = 0;
            d._orbitWatch = null;
            entry.queue.shift();
            item.resolve(entry.handle);
          } else if (
            finalWp &&
            (d.waypointIndex ?? 0) >= d.waypoints.length - 1 &&
            !finalWp.reverse &&
            !t.reverse &&
            (kin.statusMode === "docking" || (kin.statusMode === "blocked" && d._orbitWatch)) &&
            kin.distToTarget > AGF_SPECS.dockPosTolM &&
            kin.distToTarget < 0.85 &&
            (kin.statusMode === "blocked" || Math.abs(kin.speed) > 0.05)
          ) {
            if (!d._orbitWatch) {
              d._orbitWatch = { minDist: kin.distToTarget, elapsed: 0 };
            } else if (kin.statusMode === "docking" && kin.distToTarget < d._orbitWatch.minDist - 0.015) {
              d._orbitWatch.minDist = kin.distToTarget;
              d._orbitWatch.elapsed = 0;
            } else if (kin.statusMode === "docking") {
              d._orbitWatch.elapsed += dt * (kin.yieldSlowed ? 0.45 : 1.0);
            }
            if (d._orbitWatch.elapsed >= 2.2) {
              d._orbitWatch = null;
              const [fxO, fyO] = headingForward(st.heading);
              const [rxO, ryO] = headingRight(st.heading);
              const cleanDst = finalWp._autoOrthoHeading
                ? (() => { const c = { ...finalWp }; delete c.heading; delete c._autoOrthoHeading; return c; })()
                : { ...finalWp };
              const dstCands = finalWp._autoOrthoHeading ? [finalWp, cleanDst] : [cleanDst];
              const orbitRecCands = [];
              for (const dRev of [2.4, 3.0]) {
                for (const dDst of dstCands) {
                  orbitRecCands.push([
                    { x: st.x - fxO * dRev, y: st.y - fyO * dRev, reverse: true, skipTol: 0.35, speedLimit: 0.85 },
                    { ...dDst, speedLimit: Math.min(dDst.speedLimit ?? Infinity, 0.85) },
                  ]);
                }
              }
              for (const sideSign of [1, -1]) {
                for (const dFwd of [2.6, 3.4]) {
                  const p1 = { x: st.x + fxO * dFwd, y: st.y + fyO * dFwd, skipTol: 0.45, speedLimit: 1.0 };
                  const p2 = { x: st.x + fxO * (dFwd + 1.4) + rxO * sideSign * 2.2, y: st.y + fyO * (dFwd + 1.4) + ryO * sideSign * 2.2, skipTol: 0.45, speedLimit: 0.95 };
                  const p3 = { x: cleanDst.x + fxO * 0.6 + rxO * sideSign * 2.2, y: cleanDst.y + fyO * 0.6 + ryO * sideSign * 2.2, skipTol: 0.40, speedLimit: 0.90 };
                  for (const dDst of dstCands) {
                    orbitRecCands.push([p1, p2, p3, { ...dDst, speedLimit: Math.min(dDst.speedLimit ?? Infinity, 0.85) }]);
                  }
                }
              }
              const startMinD = minDistanceToObstacles(st.x, st.y, frameObstacles);
              const nearVehObsO = [];
              for (const a of agfEntries.values()) {
                if (a === entry || a.queue.length > 0) continue;
                const as = a.state;
                if (Math.hypot(as.x - st.x, as.y - st.y) > 8.5) continue;
                const aobbs = getEntryWorldObbs(a, true);
                for (const o of [...aobbs.chassis, ...aobbs.pallet]) {
                  const ch = Math.abs(Math.cos(o.heading));
                  const shv = Math.abs(Math.sin(o.heading));
                  const rxo = o.halfW * ch + o.halfL * shv;
                  const ryo = o.halfW * shv + o.halfL * ch;
                  nearVehObsO.push({ id: `${as.agentId}:orb`, kind: "vehicle", isAgf: true, x0: o.cx - rxo, x1: o.cx + rxo, y0: o.cy - ryo, y1: o.cy + ryo, obb: o });
                }
              }
              for (const m of amrEntries.values()) {
                if (m.queue.length > 0) continue;
                const ms = m.state;
                if (Math.hypot(ms.x - st.x, ms.y - st.y) > 8.5) continue;
                const mobbs = getEntryWorldObbs(m, false);
                for (const o of [...mobbs.chassis, ...mobbs.pallet]) {
                  const ch = Math.abs(Math.cos(o.heading));
                  const shv = Math.abs(Math.sin(o.heading));
                  const rxo = o.halfW * ch + o.halfL * shv;
                  const ryo = o.halfW * shv + o.halfL * ch;
                  nearVehObsO.push({ id: `${ms.agentId}:orb`, kind: "vehicle", isAmr: true, x0: o.cx - rxo, x1: o.cx + rxo, y0: o.cy - ryo, y1: o.cy + ryo, obb: o });
                }
              }
              for (let oi = 0; oi < orbitRecCands.length; oi++) {
                const candO = orbitRecCands[oi];
                let segOk = true;
                let px = st.x;
                let py = st.y;
                for (let wi = 0; wi < candO.length; wi++) {
                  if (minDistanceToObstacles(candO[wi].x, candO[wi].y, frameObstacles) < AGF_SPECS.hullRadiusM + 0.12 ||
                      !pathIsClear(px, py, candO[wi].x, candO[wi].y, frameObstacles, AGF_SPECS.hullRadiusM + 0.12)) {
                    segOk = false;
                    break;
                  }
                  px = candO[wi].x;
                  py = candO[wi].y;
                }
                if (!segOk) continue;
                if (!isAgfArcClear(st, candO, frameObstacles, AGF_SPECS.hullRadiusM + 0.02, startMinD, { maxSteps: 1800, speedScales: [1.0], checkReverseLocY: true, requireArrival: true })) {
                  continue;
                }
                if (nearVehObsO.length > 0 && !isAgfArcClear(st, candO, nearVehObsO, 0.02, 0.02, { maxSteps: 1800, speedScales: [1.0], checkReverseLocY: true, requireArrival: false })) {
                  continue;
                }
                d.waypoints = candO;
                d.waypointIndex = 0;
                break;
              }
            }
          } else {
            d._orbitWatch = null;
          }
        }
      } else if (t.type === "placeInRack" || t.type === "pickFromRack") {
        const isPlace = t.type === "placeInRack";
        const liftTarget = Math.max(AGF_EMPTY_TRANSIT_FORK_Z, d.tierZ + (isPlace ? 0.12 : 0.02));
        const seatTarget = Math.max(AGF_EMPTY_TRANSIT_FORK_Z, d.tierZ + (isPlace ? 0.02 : 0.10));

        if (item.phase === "route") {
          const wpIdx = d.waypointIndex ?? 0;
          const curWpStop = d.route?.[wpIdx];
          const isStopWp = !!(curWpStop?._stopAtWaypoint && wpIdx < d.route.length - 1);
          if (kin.arrived) {
            if (isStopWp) {
              st.speed = 0;
              d.waypointIndex = wpIdx + 1;
            } else {
              item.phase = "raise";
            }
          }
        } else if (item.phase === "raise" && Math.abs(st.forkHeightM - liftTarget) <= 0.005) {
          item.phase = "insert";
        } else if (item.phase === "insert" && kin.arrived) {
          if (isPlace) {
            if (d.row.loadedSlots.has(d.slotKey)) {
              if (isAgfPoseObbClear(st.x, st.y, st.heading, frameObstacles, 0.04)) {
                st.speed = 0;
                entry.queue.shift();
                item.reject(new Error(`Rack slot ${t.rackId}:${d.slotKey} became occupied`));
                return;
              }
              d.abortReason = `Rack slot ${t.rackId}:${d.slotKey} became occupied`;
              item.phase = "abort_retract";
              return;
            }
            d.row.loadSlot(d.bay, d.tier, d.side, d.slotInBay, st.carriedWcid);
            st.carriedWcid = 0;
            st.loaded = false;
            st.supportSurfaceZ = 0;
          } else {
            const slotObj = d.row.loadedSlots.get(d.slotKey);
            const wcid = slotObj?.wcid ?? 0;
            if (!slotObj || !wcid) {
              if (isAgfPoseObbClear(st.x, st.y, st.heading, frameObstacles, 0.04)) {
                st.speed = 0;
                entry.queue.shift();
                item.reject(new Error(`Rack slot ${t.rackId}:${d.slotKey} became empty`));
                return;
              }
              d.abortReason = `Rack slot ${t.rackId}:${d.slotKey} became empty`;
              item.phase = "abort_retract";
              return;
            }
            d.row.unloadSlot(d.bay, d.tier, d.side, d.slotInBay);
            st.carriedWcid = wcid;
            st.loaded = wcid !== 0;
            st.supportSurfaceZ = d.tierZ;
          }
          item.phase = "actuate";
        } else if (item.phase === "actuate" && Math.abs(st.forkHeightM - seatTarget) <= 0.005) {
          item.phase = "retract";
        } else if (item.phase === "retract" && Math.hypot(d.retractPose.x - st.x, d.retractPose.y - st.y) <= 0.28) {
          st.supportSurfaceZ = 0;
          st.speed = 0;
          if (!isPlace && d.tier >= 2 && st.forkHeightM > 0.50) {
            item.phase = "lower_transit";
          } else {
            entry.queue.shift();
            item.resolve(entry.handle);
          }
        } else if (
          item.phase === "abort_retract" &&
          Math.hypot(d.retractPose.x - st.x, d.retractPose.y - st.y) <= 0.28 &&
          isAgfPoseObbClear(st.x, st.y, st.heading, frameObstacles.filter((b) => b && b.id === d.row.id), 0.04)
        ) {
          st.supportSurfaceZ = 0;
          st.speed = 0;
          const transitForkZ = st.carriedWcid ? AGF_CARRIED_TRANSIT_FORK_Z : AGF_EMPTY_TRANSIT_FORK_Z;
          if (st.forkHeightM > transitForkZ + 0.02) {
            item.phase = "abort_lower_transit";
          } else {
            st.forkHeightM = transitForkZ;
            entry.queue.shift();
            item.reject(new Error(d.abortReason || `Rack slot ${t.rackId}:${d.slotKey} became empty`));
          }
        } else if (
          item.phase === "abort_lower_transit" &&
          Math.abs(st.forkHeightM - (st.carriedWcid ? AGF_CARRIED_TRANSIT_FORK_Z : AGF_EMPTY_TRANSIT_FORK_Z)) <= 0.005
        ) {
          st.supportSurfaceZ = 0;
          st.speed = 0;
          entry.queue.shift();
          item.reject(new Error(d.abortReason || `Rack slot ${t.rackId}:${d.slotKey} became empty`));
        } else if (item.phase === "lower_transit" && st.forkHeightM <= 0.50) {
          st.speed = 0;
          entry.queue.shift();
          item.resolve(entry.handle);
        }
      } else if (t.type === "pickFromContainer" || t.type === "loadIntoContainer") {
        const isPick = t.type === "pickFromContainer";
        const enterForkZ = Math.max(d.floorZ + AGF_CARRIED_FORK_CLEARANCE_M, 0.227);
        const holdForkZ = d.floorZ + 0.095;
        const dropForkZ = d.floorZ + 0.02;

        if (item.phase === "route" && (kin.arrived || (kinGuardCtrStopGuid !== null && kinGuardCtrStopGuid === d.cGuid))) {
          // Re-verify container state right before entering
          if (!containers.has(d.cGuid) || containers.get(d.cGuid) !== d.cEntry || isContainerTrailerMounted(d.cEntry) || !isContainerDoorOpen(d.cEntry)) {
            if (isAgfPoseObbClear(st.x, st.y, st.heading, frameObstacles, 0.04)) {
              st.speed = 0;
              st.supportSurfaceZ = 0;
              st.forkHeightM = st.carriedWcid ? AGF_CARRIED_TRANSIT_FORK_Z : AGF_EMPTY_TRANSIT_FORK_Z;
              entry.queue.shift();
              item.reject(new Error(`Container ${d.cGuid} unavailable on arrival`));
              return;
            }
            d.waypointIndex = 0;
            d.abortReason = `Container ${d.cGuid} unavailable on arrival`;
            item.phase = "abort_retract";
            return;
          }
          d.waypointIndex = 0;
          item.phase = "lower_enter";
        } else if (item.phase === "lower_enter") {
          if (!containers.has(d.cGuid) || containers.get(d.cGuid) !== d.cEntry || isContainerTrailerMounted(d.cEntry) || !isContainerDoorOpen(d.cEntry)) {
            if (isAgfPoseObbClear(st.x, st.y, st.heading, frameObstacles, 0.04)) {
              st.speed = 0;
              st.supportSurfaceZ = 0;
              st.forkHeightM = st.carriedWcid ? AGF_CARRIED_TRANSIT_FORK_Z : AGF_EMPTY_TRANSIT_FORK_Z;
              entry.queue.shift();
              item.reject(new Error(`Container ${d.cGuid} unavailable before entry`));
              return;
            }
            d.waypointIndex = 0;
            d.abortReason = `Container ${d.cGuid} unavailable before entry`;
            item.phase = "abort_retract";
            return;
          }
          if (Math.abs(st.forkHeightM - enterForkZ) <= 0.005) {
            item.phase = "enter";
          }
        } else if (item.phase === "enter") {
          if (!containers.has(d.cGuid) || containers.get(d.cGuid) !== d.cEntry || isContainerTrailerMounted(d.cEntry) || !isContainerDoorOpen(d.cEntry)) {
            if (isAgfPoseObbClear(st.x, st.y, st.heading, frameObstacles, 0.04)) {
              st.speed = 0;
              st.supportSurfaceZ = 0;
              st.forkHeightM = st.carriedWcid ? AGF_CARRIED_TRANSIT_FORK_Z : AGF_EMPTY_TRANSIT_FORK_Z;
              entry.queue.shift();
              item.reject(new Error(`Container ${d.cGuid} unavailable during entry`));
              return;
            }
            d.waypointIndex = 0;
            d.abortReason = `Container ${d.cGuid} unavailable during entry`;
            item.phase = "abort_retract";
            return;
          }
          if (kin.arrived) {
            try {
              if (isPick) {
                const check = isSlotReachableForUnload(d.cEntry.kind, d.cEntry.slots, d.slotIndex, 0);
                if (!check.reachable) throw new Error(`Slot ${d.slotIndex} blocked: ${check.reason}`);
                const slotRec = (d.cEntry.slots || []).find((s) => Math.trunc(s.slotIndex ?? s.SlotIndex) === d.slotIndex);
                const wcid = slotRec?.cargoWcid ?? slotRec?.CargoWcid ?? slotRec?.wcid ?? 4000010;
                applyContainerSlotMutation(d.cEntry, "unload", d.slotIndex, wcid, d.serverDispatch);
                st.carriedWcid = wcid;
                st.loaded = true;
                st.supportSurfaceZ = d.floorZ;
              } else {
                const check = isSlotReachableForLoad(d.cEntry.kind, d.cEntry.slots, d.slotIndex, 0, "full");
                if (!check.reachable) throw new Error(`Slot ${d.slotIndex} blocked: ${check.reason}`);
                applyContainerSlotMutation(d.cEntry, "load", d.slotIndex, st.carriedWcid, d.serverDispatch);
                st.carriedWcid = 0;
                st.loaded = false;
                st.supportSurfaceZ = 0;
              }
              d.waypointIndex = 0;
              item.phase = "actuate";
            } catch (err) {
              if (isAgfPoseObbClear(st.x, st.y, st.heading, frameObstacles, 0.04)) {
                st.speed = 0;
                st.supportSurfaceZ = 0;
                st.forkHeightM = st.carriedWcid ? AGF_CARRIED_TRANSIT_FORK_Z : AGF_EMPTY_TRANSIT_FORK_Z;
                entry.queue.shift();
                item.reject(err);
                return;
              }
              d.waypointIndex = 0;
              d.abortReason = err;
              item.phase = "abort_retract";
              return;
            }
          }
        } else if (item.phase === "actuate" && Math.abs(st.forkHeightM - (isPick ? holdForkZ : dropForkZ)) <= 0.005) {
          item.phase = "exit";
        } else if (
          item.phase === "exit" &&
          (kin.arrived || (d.waypointIndex >= d.exitWaypoints.length - 1 && Math.hypot(d.exitWaypoints[d.exitWaypoints.length - 1].x - st.x, d.exitWaypoints[d.exitWaypoints.length - 1].y - st.y) <= 0.35))
        ) {
          st.supportSurfaceZ = 0;
          st.speed = 0;
          if (isPick && st.carriedWcid && st.forkHeightM > AGF_CARRIED_TRANSIT_FORK_Z + 0.01) {
            item.phase = "lower_transit";
          } else {
            entry.queue.shift();
            item.resolve(entry.handle);
          }
        } else if (
          item.phase === "abort_retract" &&
          (kin.arrived || (d.waypointIndex >= d.exitWaypoints.length - 1 && Math.hypot(d.exitWaypoints[d.exitWaypoints.length - 1].x - st.x, d.exitWaypoints[d.exitWaypoints.length - 1].y - st.y) <= 0.35)) &&
          isAgfPoseObbClear(st.x, st.y, st.heading, frameObstacles, 0.04)
        ) {
          st.supportSurfaceZ = 0;
          st.speed = 0;
          st.forkHeightM = st.carriedWcid ? AGF_CARRIED_TRANSIT_FORK_Z : AGF_EMPTY_TRANSIT_FORK_Z;
          entry.queue.shift();
          item.reject(d.abortReason instanceof Error ? d.abortReason : new Error(d.abortReason || `Container ${d.cGuid} unavailable`));
        } else if (item.phase === "lower_transit" && Math.abs(st.forkHeightM - AGF_CARRIED_TRANSIT_FORK_Z) <= 0.005) {
          st.speed = 0;
          entry.queue.shift();
          item.resolve(entry.handle);
        }
      } else if (t.type === "placeOnStand" || t.type === "pickFromStand") {
        const isPlace = t.type === "placeOnStand";
        if (d.target.kind === "liftTable" && (item.phase === "route" || item.phase === "raise")) {
          d.surfaceZ = d.target.handle.heightM;
        }
        const liftForkZ = Math.max(AGF_EMPTY_TRANSIT_FORK_Z, d.surfaceZ + (isPlace ? 0.085 : 0.02));
        const actForkZ = Math.max(AGF_EMPTY_TRANSIT_FORK_Z, d.surfaceZ + (isPlace ? 0.02 : 0.085));
        const ltHandle = d.target.kind === "liftTable" ? d.target.handle : null;
        const ltMoving = Boolean(
          ltHandle && (
            ltHandle._state?.moving ||
            Math.abs((ltHandle._state?.targetHeightM ?? ltHandle.heightM) - ltHandle.heightM) > 0.005
          ),
        );

        if (item.phase === "route" && kin.arrived) {
          item.phase = "raise";
        } else if (item.phase === "raise" && !ltMoving && Math.abs(st.forkHeightM - liftForkZ) <= 0.005) {
          item.phase = "insert";
        } else if (item.phase === "insert") {
          if (ltHandle && (ltMoving || Math.abs(ltHandle.heightM - d.surfaceZ) > 0.015)) {
            if (isAgfPoseObbClear(st.x, st.y, st.heading, frameObstacles, 0.04)) {
              st.speed = 0;
              st.supportSurfaceZ = 0;
              st.forkHeightM = st.carriedWcid ? AGF_CARRIED_TRANSIT_FORK_Z : AGF_EMPTY_TRANSIT_FORK_Z;
              entry.queue.shift();
              item.reject(new Error(`Lift table ${t.standId} moved during insertion`));
              return;
            }
            d.abortReason = `Lift table ${t.standId} moved during insertion`;
            item.phase = "abort_retract";
            return;
          }
          if (kin.arrived) {
            if (isPlace) {
              if (d.target.handle.carriedWcid !== 0) {
                if (isAgfPoseObbClear(st.x, st.y, st.heading, frameObstacles, 0.04)) {
                  st.speed = 0;
                  st.supportSurfaceZ = 0;
                  st.forkHeightM = st.carriedWcid ? AGF_CARRIED_TRANSIT_FORK_Z : AGF_EMPTY_TRANSIT_FORK_Z;
                  entry.queue.shift();
                  item.reject(new Error(`Stand ${t.standId} became occupied`));
                  return;
                }
                d.abortReason = `Stand ${t.standId} became occupied`;
                item.phase = "abort_retract";
                return;
              }
              d.target.handle.setCargoWcid(st.carriedWcid);
              st.carriedWcid = 0;
              st.loaded = false;
              st.supportSurfaceZ = 0;
            } else {
              const wcid = d.target.handle.carriedWcid;
              if (!wcid) {
                if (isAgfPoseObbClear(st.x, st.y, st.heading, frameObstacles, 0.04)) {
                  st.speed = 0;
                  st.supportSurfaceZ = 0;
                  st.forkHeightM = st.carriedWcid ? AGF_CARRIED_TRANSIT_FORK_Z : AGF_EMPTY_TRANSIT_FORK_Z;
                  entry.queue.shift();
                  item.reject(new Error(`Stand ${t.standId} became empty`));
                  return;
                }
                d.abortReason = `Stand ${t.standId} became empty`;
                item.phase = "abort_retract";
                return;
              }
              d.target.handle.setCargoWcid(0);
              st.carriedWcid = wcid;
              st.loaded = true;
              st.supportSurfaceZ = ltHandle ? ltHandle.heightM : d.surfaceZ;
            }
            item.phase = "actuate";
          }
        } else if (item.phase === "actuate" && Math.abs(st.forkHeightM - actForkZ) <= 0.005) {
          item.phase = "retract";
        } else if (
          item.phase === "retract" &&
          Math.hypot(d.retractPose.x - st.x, d.retractPose.y - st.y) <= 0.10 &&
          isAgfPoseObbClear(st.x, st.y, st.heading, frameObstacles, 0.04)
        ) {
          st.supportSurfaceZ = 0;
          st.speed = 0;
          entry.queue.shift();
          item.resolve(entry.handle);
        } else if (
          item.phase === "abort_retract" &&
          Math.hypot(d.retractPose.x - st.x, d.retractPose.y - st.y) <= 0.10 &&
          isAgfPoseObbClear(st.x, st.y, st.heading, frameObstacles, 0.04)
        ) {
          st.supportSurfaceZ = 0;
          st.speed = 0;
          st.forkHeightM = st.carriedWcid ? AGF_CARRIED_TRANSIT_FORK_Z : AGF_EMPTY_TRANSIT_FORK_Z;
          entry.queue.shift();
          item.reject(new Error(d.abortReason || `Lift table ${t.standId} moved during insertion`));
        }
      } else if (t.type === "pickGroundDeployable" || t.type === "dropToGround") {
        const isPick = t.type === "pickGroundDeployable";
        if (item.phase === "route" && kin.arrived) {
          item.phase = "insert";
        } else if (item.phase === "insert" && kin.arrived) {
          if (isPick) {
            const cur = deployables.get(d.dGuid);
            if (!cur) {
              entry.queue.shift();
              item.reject(new Error(`Deployable ${d.dGuid} vanished`));
              return;
            }
            const wcid = cur.wcid;
            removeDeployableEntryLocal(d.dGuid);
            st.carriedWcid = wcid;
            st.loaded = true;
            st.supportSurfaceZ = 0;
          } else {
            createOwnedGroundDeployable(st.carriedWcid, d.dropPos, d.dropHeading);
            st.carriedWcid = 0;
            st.loaded = false;
            st.supportSurfaceZ = 0;
          }
          item.phase = "actuate";
        } else if (item.phase === "actuate" && Math.abs(st.forkHeightM - (isPick ? AGF_CARRIED_TRANSIT_FORK_Z : AGF_EMPTY_TRANSIT_FORK_Z)) <= 0.005) {
          item.phase = "retract";
        } else if (item.phase === "retract" && Math.hypot(d.retractPose.x - st.x, d.retractPose.y - st.y) <= 0.23) {
          st.speed = 0;
          entry.queue.shift();
          item.resolve(entry.handle);
        }
      }
    }

    // Clamp carried fork height to physical runner clearance
    const effectiveForkZ = st.carriedWcid
      ? Math.max(st.forkHeightM, st.supportSurfaceZ + AGF_CARRIED_FORK_CLEARANCE_M)
      : st.forkHeightM;

    if (entry.model) {
      entry.model.root.position.set(st.x, st.y, st.z);
      entry.model.root.rotation.z = -st.heading;
      entry.model.update({
        forkHeightM: effectiveForkZ,
        sideShiftM: st.sideShiftM,
        mastTiltRad: st.mastTiltRad,
        steerAngleRad: st.steerAngleRad,
        wheelSpinRad: st.wheelSpinRad,
        lidarSpinRad: st.lidarSpinRad,
        carriedWcid: st.carriedWcid,
        supportSurfaceZ: st.supportSurfaceZ,
        statusMode: st.statusMode,
      });
    }

    // Audio
    if (logisticsAudio) {
      try {
        const moving = Math.abs(st.speed) > 0.05;
        logisticsAudio.updateAgvHum?.(entry.id, { active: moving, speed: Math.abs(st.speed), pos: [st.x, st.y, st.z] });
        logisticsAudio.mastHydraulicWhine?.(entry.id, {
          active: st.statusMode === "lifting",
          speed: AGF_SPECS.mastSpeedMps,
          pos: [st.x, st.y, st.z],
        });
        if (st.statusMode === "blocked" && st.prevStatusMode !== "blocked") {
          logisticsAudio.safetyChime?.({ pos: [st.x, st.y, st.z] });
        }
      } catch (_) {}
    }
    st._idleSec = entry.queue.length === 0 && Math.abs(st.speed) < 0.02 ? (st._idleSec || 0) + dt : 0;
    st.prevStatusMode = st.statusMode;
  }

  function amrObsClearR(b, baseR, carriedWcid = 0, liftHeightM = AMR_SPECS.loweredHeightM) {
    if (!carriedWcid) return baseR;
    if (
      b &&
      (b.kind === "stand" || b.kind === "liftTable") &&
      finiteOr(liftHeightM, AMR_SPECS.loweredHeightM) > STAND_SPECS.railHeightM + 0.005
    ) {
      return baseR;
    }
    return Math.max(baseR, AMR_PALLET_RADIUS + 0.08);
  }

  function amrHasCloseObs(px, py, obsList, baseR, carriedWcid = 0, liftHeightM = AMR_SPECS.loweredHeightM, ignoreId = null) {
    const hasIgnore = ignoreId !== null && ignoreId !== undefined;
    const ignoreNum = typeof ignoreId === "number" ? (ignoreId >>> 0) : null;
    for (let i = 0; i < obsList.length; i++) {
      const b = obsList[i];
      if (!b) continue;
      if (hasIgnore && (b.id === ignoreId || (ignoreNum !== null && typeof b.id === "number" && (b.id >>> 0) === ignoreNum))) {
        continue;
      }
      if (pointToObstacleDist(px, py, b) < amrObsClearR(b, baseR, carriedWcid, liftHeightM)) return true;
    }
    return false;
  }

  function planAmrCloseDeparture(st, solid, prevDockedChargerId = null) {
    const carried = st.carriedWcid ?? 0;
    const tt = st.turntableYawRad ?? 0;
    const liftH = finiteOr(st.liftHeightM, carried ? AMR_SPECS.raisedHeightM : AMR_SPECS.loweredHeightM);
    let evalSolid = solid;
    const rawIds = [];
    const candSolid = solid.map((b) => {
      if (b && b.kind === "container" && b.obb && Number.isFinite(b.obb.rawHalfW) && pointToObstacleDist(st.x, st.y, b) < 0.435) {
        const u = unpadContainerObstacleForDst(b);
        if (pointToObstacleDist(st.x, st.y, u) >= 0.391) {
          rawIds.push(b.id);
          return u;
        }
      }
      return b;
    });
    if (rawIds.length > 0) evalSolid = candSolid;
    const dStart = minDistanceToObstacles(st.x, st.y, evalSolid);
    const needPalletDepart = Boolean(carried) && amrHasCloseObs(st.x, st.y, evalSolid, AMR_STAND_RADIUS + 0.08, carried, liftH);
    if (dStart >= AMR_STAND_RADIUS + 0.08 && !needPalletDepart) return null;
    let closeObs = null;
    let closeD = Infinity;
    for (let i = 0; i < evalSolid.length; i++) {
      const b = evalSolid[i];
      if (!b) continue;
      const d = pointToObstacleDist(st.x, st.y, b);
      if (d < closeD) {
        closeD = d;
        closeObs = b;
      }
    }
    const isCloseCharger = Boolean(
      closeObs &&
      closeObs.kind === "charger" &&
      (closeObs.id === prevDockedChargerId || closeD < AMR_HALF_W),
    );
    const ignoreDepartId = (
      closeObs &&
      (((closeObs.kind === "stand" || closeObs.kind === "liftTable") && closeD < AMR_HALF_W) || isCloseCharger)
    )
      ? closeObs.id
      : null;
    let chCx = 0;
    let chCy = 0;
    let startChDist = 0;
    if (isCloseCharger) {
      chCx = (closeObs.x0 + closeObs.x1) * 0.5;
      chCy = (closeObs.y0 + closeObs.y1) * 0.5;
      startChDist = Math.hypot(st.x - chCx, st.y - chCy);
    }
    const [fx, fy] = headingForward(st.heading);
    let best = null;
    for (const dPull of [0.20, 0.35, 0.55, 0.80, 1.10, 1.45, 1.85, 2.25]) {
      for (const dir of [1, -1]) {
        const px = st.x + dir * fx * dPull;
        const py = st.y + dir * fy * dPull;
        if (isCloseCharger) {
          const endChDist = Math.hypot(px - chCx, py - chCy);
          if (endChDist <= startChDist + 0.1) continue;
          if ((dir * fx) * (st.x - chCx) + (dir * fy) * (st.y - chCy) < -1e-6) continue;
        }
        if (minDistanceToObstacles(px, py, solid) < AMR_STAND_RADIUS + 0.08) continue;
        if (carried && amrHasCloseObs(px, py, solid, AMR_STAND_RADIUS + 0.08, carried, liftH)) continue;
        if (!isAmrSweptClear(st.x, st.y, px, py, st.heading, evalSolid, 0.0, ignoreDepartId, carried, tt, liftH)) continue;
        best = {
          x: px,
          y: py,
          dir,
          reverse: dir < 0,
          heading: st.heading,
          obsId: closeObs ? closeObs.id : null,
          obsKind: closeObs ? closeObs.kind : null,
          dStart: closeD,
          useRawContainerIds: rawIds.length > 0 ? rawIds : null,
        };
        break;
      }
      if (best) break;
    }
    return best;
  }

  function amrSegWithinObstacle2D(ax, ay, bx, by, b, r) {
    if (b.obb) {
      const o = b.obb;
      const la = worldToLocalPoint(ax, ay, o.cx, o.cy, o.heading);
      const lb = worldToLocalPoint(bx, by, o.cx, o.cy, o.heading);
      if (segmentIntersectsAabb2D(la.x, la.y, lb.x, lb.y, { x0: -o.halfW - r, x1: o.halfW + r, y0: -o.halfL, y1: o.halfL }, 0)) return true;
      if (segmentIntersectsAabb2D(la.x, la.y, lb.x, lb.y, { x0: -o.halfW, x1: o.halfW, y0: -o.halfL - r, y1: o.halfL + r }, 0)) return true;
      return (
        pointToSegDist2D(-o.halfW, -o.halfL, la.x, la.y, lb.x, lb.y) < r ||
        pointToSegDist2D(o.halfW, -o.halfL, la.x, la.y, lb.x, lb.y) < r ||
        pointToSegDist2D(-o.halfW, o.halfL, la.x, la.y, lb.x, lb.y) < r ||
        pointToSegDist2D(o.halfW, o.halfL, la.x, la.y, lb.x, lb.y) < r
      );
    }
    if (segmentIntersectsAabb2D(ax, ay, bx, by, { x0: b.x0 - r, x1: b.x1 + r, y0: b.y0, y1: b.y1 }, 0)) return true;
    if (segmentIntersectsAabb2D(ax, ay, bx, by, { x0: b.x0, x1: b.x1, y0: b.y0 - r, y1: b.y1 + r }, 0)) return true;
    return (
      pointToSegDist2D(b.x0, b.y0, ax, ay, bx, by) < r ||
      pointToSegDist2D(b.x1, b.y0, ax, ay, bx, by) < r ||
      pointToSegDist2D(b.x0, b.y1, ax, ay, bx, by) < r ||
      pointToSegDist2D(b.x1, b.y1, ax, ay, bx, by) < r
    );
  }

  function routeAmrAroundSolidObstacles(st, wps, selfRadius = AMR_SPECS.hullRadiusM, solidOverride = null, opts = {}) {
    const rejectOnFail = Boolean(opts?.rejectOnFail);
    if (!Array.isArray(wps) || wps.length === 0) return wps;
    if (wps.length > 1) {
      const combined = [];
      let cur = { x: st.x, y: st.y, heading: Number.isFinite(st.heading) ? st.heading : 0 };
      for (let i = 0; i < wps.length; i++) {
        const dst = wps[i];
        if (!dst) continue;
        const isLast = i === wps.length - 1;
        let leg = (dst.reverse || dst._directSeg || Math.hypot(dst.x - cur.x, dst.y - cur.y) <= 0.05)
          ? [{ ...dst }]
          : routeAmrAroundSolidObstacles(cur, [dst], selfRadius, solidOverride, opts);
        if (rejectOnFail && leg === null) return null;
        if (!Array.isArray(leg) || leg.length === 0) {
          leg = [{ ...dst }];
        }
        const endWp = leg[leg.length - 1];
        if (!isLast) {
          leg[leg.length - 1] = {
            ...endWp,
            skipTol: Math.min(endWp.skipTol ?? 0.35, 0.35),
          };
        }
        const prevPt = leg.length >= 2 ? leg[leg.length - 2] : cur;
        let arrHeading = cur.heading;
        if (Math.hypot(endWp.x - prevPt.x, endWp.y - prevPt.y) > 1e-4) {
          arrHeading = endWp.reverse
            ? wrapHeading(Math.atan2(prevPt.x - endWp.x, prevPt.y - endWp.y))
            : wrapHeading(Math.atan2(endWp.x - prevPt.x, endWp.y - prevPt.y));
        }
        combined.push(...leg);
        cur = { x: endWp.x, y: endWp.y, heading: arrHeading };
      }
      return combined;
    }
    const baseRoute = routeAroundSolidObstacles(st, wps, selfRadius, "amr");
    if (wps[0].reverse) return baseRoute;
    const dst = wps[0];
    const pad = selfRadius + 0.12;
    const selfLoaded = Boolean(opts?.selfLoaded ?? st.carriedWcid);
    const selfCarried = selfLoaded ? (st.carriedWcid || 1) : 0;
    const selfLiftH = finiteOr(st.liftHeightM, selfLoaded ? AMR_SPECS.raisedHeightM : AMR_SPECS.loweredHeightM);
    const rawSolid = solidOverride || getStaticObstacles({ includeStands: true, includeLiftTables: true, includeContainers: true });
    const solid = rawSolid.reduce((acc, b) => {
      if (!b) return acc;
      if (b.kind === "stand" || b.kind === "liftTable") {
        if (pointToObstacleDist(st.x, st.y, b) < AMR_HALF_W || pointToObstacleDist(dst.x, dst.y, b) < AMR_HALF_W) {
          return acc;
        }
      } else if (
        b.kind === "container" &&
        b.obb &&
        Number.isFinite(b.obb.rawHalfW) &&
        (pointToObstacleDist(dst.x, dst.y, b) < 0.435 || pointToObstacleDist(st.x, st.y, b) < 0.435)
      ) {
        const u = unpadContainerObstacleForDst(b);
        if (pointToObstacleDist(dst.x, dst.y, u) >= 0.391 && pointToObstacleDist(st.x, st.y, u) >= 0.391) {
          acc.push(u);
          return acc;
        }
      }
      acc.push(b);
      return acc;
    }, []);
    if (solid.length === 0) return baseRoute;
    const segClearExact = (ax, ay, bx, by, isFirst, isLast) => {
      for (let i = 0; i < solid.length; i++) {
        const b = solid[i];
        let effPad = b.kind === "vehicle" ? pad : amrObsClearR(b, pad, selfCarried, selfLiftH);
        if (b.kind === "vehicle") {
          const vehPad = b.isAgf ? (opts?.selfLoaded ? 0.80 : pad) : 0.85;
          if (vehPad > effPad) {
            const daV = pointToObstacleDist(ax, ay, b);
            const dbV = pointToObstacleDist(bx, by, b);
            if (daV >= 0.88 && dbV >= 0.88) effPad = vehPad;
          }
        }
        if (isFirst) {
          const da = pointToObstacleDist(ax, ay, b);
          if (da < effPad) effPad = Math.min(effPad, Math.max(0.02, da - 0.01));
        }
        if (isLast) {
          const db = pointToObstacleDist(bx, by, b);
          const minEndPad = (b.kind === "stand" || b.kind === "liftTable")
            ? 0.02
            : (b.kind === "vehicle" && b.isPallet)
              ? 0.552
              : (selfLoaded ? 0.552 : (AMR_HALF_W - 0.005));
          if (db < effPad) effPad = Math.min(effPad, Math.max(minEndPad, db - 0.01));
        }
        if (amrSegWithinObstacle2D(ax, ay, bx, by, b, effPad)) return false;
      }
      return true;
    };
    const ptsCheck = [{ x: st.x, y: st.y }, ...baseRoute];
    let baseValid = ptsCheck.length >= 2;
    for (let i = 0; i < ptsCheck.length - 1 && baseValid; i++) {
      if (!segClearExact(ptsCheck[i].x, ptsCheck[i].y, ptsCheck[i + 1].x, ptsCheck[i + 1].y, i === 0, i === ptsCheck.length - 2)) {
        baseValid = false;
      }
    }
    if (baseValid) return baseRoute;

    if (segClearExact(st.x, st.y, dst.x, dst.y, true, true)) return wps;
    const vgNodes = [{ x: st.x, y: st.y }];
    for (let i = 0; i < solid.length; i++) {
      const b = solid[i];
      const bPad = b.kind === "vehicle" ? pad : amrObsClearR(b, pad, selfCarried, selfLiftH);
      const m = (bPad > pad ? AMR_PALLET_RADIUS : selfRadius) + 0.30;
      const candCorners = [];
      if (b.obb) {
        const o = b.obb;
        for (const [lx, ly] of [
          [-o.halfW - m, -o.halfL - m],
          [o.halfW + m, -o.halfL - m],
          [-o.halfW - m, o.halfL + m],
          [o.halfW + m, o.halfL + m],
        ]) {
          const [wx, wy] = localToWorld2D(lx, ly, o.cx, o.cy, o.heading);
          candCorners.push({ x: wx, y: wy });
        }
      } else {
        candCorners.push(
          { x: b.x0 - m, y: b.y0 - m },
          { x: b.x1 + m, y: b.y0 - m },
          { x: b.x0 - m, y: b.y1 + m },
          { x: b.x1 + m, y: b.y1 + m },
        );
      }
      for (let k = 0; k < candCorners.length; k++) {
        const cx = candCorners[k].x;
        const cy = candCorners[k].y;
        let cornerOk = true;
        for (let oi = 0; oi < solid.length; oi++) {
          const ob = solid[oi];
          if (!ob) continue;
          const reqC = ob.kind === "vehicle" ? pad : amrObsClearR(ob, pad, selfCarried, selfLiftH);
          if (pointToObstacleDist(cx, cy, ob) < reqC) {
            cornerOk = false;
            break;
          }
        }
        if (cornerOk) {
          vgNodes.push(candCorners[k]);
        }
      }
    }
    const goalIdx = vgNodes.length;
    vgNodes.push({ x: dst.x, y: dst.y });
    const nVg = vgNodes.length;
    const gScore = new Float64Array(nVg).fill(Infinity);
    const fScore = new Float64Array(nVg).fill(Infinity);
    const parent = new Int32Array(nVg).fill(-1);
    const closed = new Uint8Array(nVg);
    gScore[0] = 0;
    fScore[0] = Math.hypot(dst.x - st.x, dst.y - st.y);
    while (true) {
      let u = -1;
      let uBest = Infinity;
      for (let i = 0; i < nVg; i++) {
        if (!closed[i] && fScore[i] < uBest) {
          uBest = fScore[i];
          u = i;
        }
      }
      if (u === -1 || u === goalIdx) break;
      closed[u] = 1;
      const nu = vgNodes[u];
      for (let v = 1; v < nVg; v++) {
        if (closed[v] || v === u) continue;
        const nv = vgNodes[v];
        const edgeLen = Math.hypot(nv.x - nu.x, nv.y - nu.y);
        const alt = gScore[u] + edgeLen;
        if (alt >= gScore[v]) continue;
        if (!segClearExact(nu.x, nu.y, nv.x, nv.y, u === 0, v === goalIdx)) continue;
        gScore[v] = alt;
        fScore[v] = alt + Math.hypot(dst.x - nv.x, dst.y - nv.y);
        parent[v] = u;
      }
    }
    if (parent[goalIdx] !== -1) {
      const chain = [];
      let cur = parent[goalIdx];
      while (cur > 0) {
        chain.unshift({ x: vgNodes[cur].x, y: vgNodes[cur].y, skipTol: 0.35 });
        cur = parent[cur];
      }
      chain.push(dst);
      return chain;
    }
    if (rejectOnFail) return null;
    return baseRoute;
  }

  function unpadContainerObstacleForDst(b) {
    if (!b || b.kind !== "container" || !b.obb || !Number.isFinite(b.obb.rawHalfW) || !Number.isFinite(b.obb.rawHalfL)) {
      return b;
    }
    const o = b.obb;
    const ch = Math.abs(Math.cos(o.heading));
    const shv = Math.abs(Math.sin(o.heading));
    const rx = o.rawHalfW * ch + o.rawHalfL * shv;
    const ry = o.rawHalfW * shv + o.rawHalfL * ch;
    return {
      ...b,
      x0: o.cx - rx,
      x1: o.cx + rx,
      y0: o.cy - ry,
      y1: o.cy + ry,
      obb: { ...o, halfW: o.rawHalfW, halfL: o.rawHalfL },
    };
  }

  function planAmrCloseApproach(dst, solid, fromPos, carriedWcid = 0, turntableYawRad = 0, liftHeightM = AMR_SPECS.loweredHeightM) {
    const dDst = minDistanceToObstacles(dst.x, dst.y, solid);
    const hasPalletClose = Boolean(carriedWcid) && amrHasCloseObs(dst.x, dst.y, solid, AMR_STAND_RADIUS + 0.08, carriedWcid, liftHeightM);
    if (dDst >= AMR_STAND_RADIUS + 0.08 && !hasPalletClose) return null;
    let closeObs = null;
    let closeD = Infinity;
    for (let i = 0; i < solid.length; i++) {
      const b = solid[i];
      if (!b) continue;
      const d = pointToObstacleDist(dst.x, dst.y, b);
      if (d < closeD) {
        closeD = d;
        closeObs = b;
      }
    }
    if (!closeObs) return null;
    let evalSolid = solid;
    let useRawContainerIds = null;
    const hasExplicitH = Number.isFinite(dst.heading);
    const rawIds = [];
    const candSolid = solid.map((b) => {
      if (b && b.kind === "container" && b.obb && Number.isFinite(b.obb.rawHalfW) && pointToObstacleDist(dst.x, dst.y, b) < 0.435) {
        const u = unpadContainerObstacleForDst(b);
        if (pointToObstacleDist(dst.x, dst.y, u) >= 0.391) {
          rawIds.push(b.id);
          return u;
        }
      }
      return b;
    });
    if (rawIds.length > 0 && (!hasExplicitH || !isAmrPoseClear(dst.x, dst.y, wrapHeading(dst.heading), solid, 0.002, null, carriedWcid, turntableYawRad, liftHeightM))) {
      if (!hasExplicitH || isAmrPoseClear(dst.x, dst.y, wrapHeading(dst.heading), candSolid, 0.002, null, carriedWcid, turntableYawRad, liftHeightM)) {
        evalSolid = candSolid;
        useRawContainerIds = rawIds;
      }
    }
    const cp = closestPointOnObstacle2D(dst.x, dst.y, closeObs);
    const nx = cp.d > 1e-5 ? (dst.x - cp.x) / cp.d : 0;
    const ny = cp.d > 1e-5 ? (dst.y - cp.y) / cp.d : 1;
    const rawHeads = [];
    if (hasExplicitH) {
      rawHeads.push(wrapHeading(dst.heading));
    } else {
      const t1 = wrapHeading(Math.atan2(-ny, nx));
      const t2 = wrapHeading(Math.atan2(ny, -nx));
      rawHeads.push(t1, t2, 0, Math.PI * 0.5, Math.PI, -Math.PI * 0.5);
      if (closeD >= 0.53) {
        rawHeads.push(wrapHeading(Math.atan2(nx, ny)), wrapHeading(Math.atan2(-nx, -ny)));
      }
      for (const th of [t1, t2]) {
        for (const alpha of [0.04, 0.08, 0.13, 0.19, 0.27, 0.38]) {
          for (const sg of [1, -1]) {
            const hCand = wrapHeading(th + sg * alpha);
            const [fxC, fyC] = headingForward(hCand);
            if (fxC * nx + fyC * ny < -0.01) rawHeads.push(hCand);
          }
        }
      }
    }
    const heads = [];
    for (let i = 0; i < rawHeads.length; i++) {
      const h = rawHeads[i];
      if (!heads.some((eh) => Math.abs(wrapPi(eh - h)) < 0.02)) heads.push(h);
    }
    let best = null;
    let bestScore = Infinity;
    const idealClear = closeD < 0.55 ? 1.15 : 0.90;
    const tryPre = (h, fx, fy, dPre, reverseSlide = false) => {
      const dir = reverseSlide ? 1 : -1;
      const preX = dst.x + dir * fx * dPre;
      const preY = dst.y + dir * fy * dPre;
      if (!isAmrPoseClear(preX, preY, h, evalSolid, 0.002, null, carriedWcid, turntableYawRad, liftHeightM)) return "blocked";
      const dPreClear = minDistanceToObstacles(preX, preY, solid);
      if (dPreClear < AMR_STAND_RADIUS + 0.08) return "near";
      if (carriedWcid && amrHasCloseObs(preX, preY, solid, AMR_STAND_RADIUS + 0.08, carriedWcid, liftHeightM)) return "near";
      const clearPen = (dPreClear < idealClear ? 4.0 : 0.0) + (closeD < 0.55 && dPre < 0.90 ? 2.5 : 0.0);
      const sc = Math.hypot(preX - fromPos.x, preY - fromPos.y) + dPre + clearPen + (reverseSlide ? 100.0 : 0.0);
      if (sc >= bestScore) return "ok";
      const sweptOk = reverseSlide
        ? isAmrSweptClear(dst.x, dst.y, preX, preY, h, evalSolid, 0.002, null, carriedWcid, turntableYawRad, liftHeightM)
        : isAmrSweptClear(preX, preY, dst.x, dst.y, h, evalSolid, 0.002, null, carriedWcid, turntableYawRad, liftHeightM);
      if (!sweptOk) return "blocked";
      bestScore = sc;
      best = {
        preX,
        preY,
        heading: h,
        dstX: dst.x,
        dstY: dst.y,
        dstHeading: hasExplicitH ? wrapHeading(dst.heading) : null,
        obsId: closeObs.id,
        dDst: closeD,
        reverseSlide,
        useRawContainerIds,
      };
      return dPreClear >= idealClear ? "ideal" : "ok";
    };

    for (let hi = 0; hi < heads.length; hi++) {
      const h = heads[hi];
      if (!isAmrPoseClear(dst.x, dst.y, h, evalSolid, 0.002, null, carriedWcid, turntableYawRad, liftHeightM)) continue;
      const [fx, fy] = headingForward(h);
      for (const dPre of [0.45, 0.70, 0.95, 1.30, 1.65, 2.00, 2.70, 3.60, 4.80, 6.20]) {
        tryPre(h, fx, fy, dPre, false);
      }
      if (!best || (closeD < 0.55 && minDistanceToObstacles(best.preX, best.preY, solid) < idealClear)) {
        for (let dPre = 6.70; dPre <= 34.0; dPre += 0.50) {
          const stRes = tryPre(h, fx, fy, dPre, false);
          if (stRes === "blocked" || stRes === "ideal") break;
        }
      }
      if (!best && hasExplicitH) {
        for (const dPost of [0.95, 1.30, 1.65, 2.00, 2.70, 3.60, 4.80, 6.20]) {
          const stRes = tryPre(h, fx, fy, dPost, true);
          if (stRes === "blocked" || stRes === "ideal") break;
        }
        if (!best) {
          for (let dPost = 6.70; dPost <= 34.0; dPost += 0.50) {
            const stRes = tryPre(h, fx, fy, dPost, true);
            if (stRes === "blocked" || stRes === "ideal") break;
          }
        }
      }
    }
    if (best) {
      const closeObsOverrides = [];
      const segSteps = Math.max(8, Math.ceil(Math.hypot(best.dstX - best.preX, best.dstY - best.preY) / 0.10));
      for (let oi = 0; oi < evalSolid.length; oi++) {
        const b = evalSolid[oi];
        if (!b) continue;
        let minD = Infinity;
        for (let s = 0; s <= segSteps; s++) {
          const t = s / segSteps;
          const sx = best.preX + (best.dstX - best.preX) * t;
          const sy = best.preY + (best.dstY - best.preY) * t;
          const d = pointToObstacleDist(sx, sy, b);
          if (d < minD) minD = d;
        }
        if (minD < AMR_STAND_RADIUS + 0.01) {
          closeObsOverrides.push({
            id: b.id,
            r: Math.min(AMR_STAND_RADIUS, Math.max(0.391, minD - 0.003)),
          });
        }
      }
      best.closeObsOverrides = closeObsOverrides;
    }
    return best;
  }

  function findDockedChargerIdForPose(st) {
    if (st.dockedChargerId) return st.dockedChargerId;
    const padHalfW = Math.max(0.48, (CHARGER_SPECS.padWidthM ?? 0.90) * 0.5 + 0.03);
    const standOff = finiteOr(CHARGER_SPECS.dockStandOffM, 0.62);
    for (const chItem of chargers.values()) {
      if (Math.hypot(st.x - chItem.dockPos[0], st.y - chItem.dockPos[1]) <= 0.25) {
        return chItem.id;
      }
      const lp = worldToLocalPoint(st.x, st.y, chItem.pos[0], chItem.pos[1], chItem.heading);
      const dyDock = lp.y - standOff;
      if (Math.abs(lp.x) <= padHalfW && dyDock >= -0.25 && dyDock <= 0.42) {
        return chItem.id;
      }
    }
    return null;
  }

  function assertAmrStartNotTrapped(st, amrSolid, startChargerId, dstPos = null, minClearDist = AMR_HALF_W - 0.02) {
    for (let i = 0; i < amrSolid.length; i++) {
      const b = amrSolid[i];
      if (!b) continue;
      if (b.kind === "stand" || b.kind === "liftTable") continue;
      if (b.kind === "charger" && b.id === startChargerId) continue;
      if (pointToObstacleDist(st.x, st.y, b) < minClearDist) {
        const tx = finiteOr(dstPos?.[0] ?? dstPos?.x, st.x);
        const ty = finiteOr(dstPos?.[1] ?? dstPos?.y, st.y);
        throw new Error(`AMR route unreachable from trapped pose (${st.x.toFixed(2)}, ${st.y.toFixed(2)}) to (${tx.toFixed(2)}, ${ty.toFixed(2)})`);
      }
    }
  }

  function initAmrTask(entry, item) {
    const st = entry.state;
    const t = item.task;
    const type = t.type;
    const prevDockedChargerId = findDockedChargerIdForPose(st);
    const commitUndockAndParkClear = () => {
      st._parkedRawCtrIds = null;
      if (st.dockedChargerId) {
        const ch = chargers.get(st.dockedChargerId);
        ch?.setDockState?.("ready");
        st.dockedChargerId = null;
        st.charging = false;
      }
    };

    if (type === "driveTo") {
      const rawWps = normalizeWaypointsInput(t.waypoints);
      if (!rawWps) throw new Error("AMR driveTo requires non-empty waypoints");
      const amrSolid = getStaticObstacles({ includeStands: true, includeLiftTables: true, includeContainers: true });
      const lastRawWp = rawWps[rawWps.length - 1];
      assertAmrStartNotTrapped(st, amrSolid, prevDockedChargerId, lastRawWp, 0.05);
      if (Number.isFinite(lastRawWp.heading)) {
        if (!isAmrPoseClearOfIdleVehicles(lastRawWp.x, lastRawWp.y, wrapHeading(lastRawWp.heading), entry, st.carriedWcid, st.turntableYawRad, 0.002)) {
          throw new Error(`AMR route unreachable: target pose (${lastRawWp.x.toFixed(2)}, ${lastRawWp.y.toFixed(2)}) blocked by vehicle`);
        }
      } else {
        let anyHeadClear = false;
        for (let k = 0; k < 16; k++) {
          if (isAmrPoseClearOfIdleVehicles(lastRawWp.x, lastRawWp.y, (k * Math.PI) / 8, entry, st.carriedWcid, st.turntableYawRad, 0.002)) {
            anyHeadClear = true;
            break;
          }
        }
        if (!anyHeadClear) {
          throw new Error(`AMR route unreachable: target pose (${lastRawWp.x.toFixed(2)}, ${lastRawWp.y.toFixed(2)}) blocked by vehicle`);
        }
      }
      const movingFromStart = Math.hypot(lastRawWp.x - st.x, lastRawWp.y - st.y) > 0.35;
      let departPull = rawWps.length >= 1 && ((!rawWps[0].reverse && !rawWps[0].docking) || (prevDockedChargerId && movingFromStart))
        ? planAmrCloseDeparture(st, amrSolid, prevDockedChargerId)
        : null;
      if (prevDockedChargerId && !departPull && movingFromStart) {
        throw new Error(`AMR route unreachable from charger ${prevDockedChargerId} (${st.x.toFixed(2)}, ${st.y.toFixed(2)})`);
      }
      let routeFrom = departPull
        ? { x: departPull.x, y: departPull.y, heading: st.heading }
        : st;
      const idleVehObsAll = buildIdleVehicleObstacles(entry, Boolean(st.carriedWcid));
      const idleVehObsForRoute = idleVehObsAll.filter((b) => {
        const minEnd = b.isPallet ? 0.552 : (AMR_HALF_W - 0.005);
        return pointToObstacleDist(routeFrom.x, routeFrom.y, b) >= minEnd && pointToObstacleDist(lastRawWp.x, lastRawWp.y, b) >= minEnd;
      });
      const prevApproachPos = rawWps.length > 1 ? rawWps[rawWps.length - 2] : routeFrom;
      const rawCtrIdsForLast = [];
      const amrSolidForLast = amrSolid.map((b) => {
        if (b && b.kind === "container" && b.obb && Number.isFinite(b.obb.rawHalfW) && pointToObstacleDist(lastRawWp.x, lastRawWp.y, b) < 0.435) {
          const u = unpadContainerObstacleForDst(b);
          if (pointToObstacleDist(lastRawWp.x, lastRawWp.y, u) >= 0.391) {
            rawCtrIdsForLast.push(b.id);
            return u;
          }
        }
        return b;
      });
      const dLastObs = minDistanceToObstacles(lastRawWp.x, lastRawWp.y, amrSolidForLast);
      const dStartObs = minDistanceToObstacles(st.x, st.y, amrSolid);
      const travelHLast = Math.hypot(lastRawWp.x - prevApproachPos.x, lastRawWp.y - prevApproachPos.y) > 0.05
        ? Math.atan2(lastRawWp.x - prevApproachPos.x, lastRawWp.y - prevApproachPos.y)
        : st.heading;
      const unheadedApproachTight =
        !Number.isFinite(lastRawWp.heading) &&
        (!isAmrPoseClear(lastRawWp.x, lastRawWp.y, travelHLast + 0.25, amrSolidForLast, 0.002, null, st.carriedWcid, st.turntableYawRad, st.liftHeightM) ||
          !isAmrPoseClear(lastRawWp.x, lastRawWp.y, travelHLast - 0.25, amrSolidForLast, 0.002, null, st.carriedWcid, st.turntableYawRad, st.liftHeightM));
      const startCloseSkewed =
        rawWps.length === 1 &&
        (dStartObs < AMR_STAND_RADIUS + 0.08 || (st.carriedWcid && amrHasCloseObs(st.x, st.y, amrSolid, AMR_STAND_RADIUS + 0.08, st.carriedWcid, st.liftHeightM))) &&
        Math.abs(wrapPi(travelHLast - st.heading)) > 0.05;
      const lastHasPalletClose = Boolean(st.carriedWcid) && amrHasCloseObs(lastRawWp.x, lastRawWp.y, amrSolidForLast, AMR_STAND_RADIUS + 0.08, st.carriedWcid, st.liftHeightM);
      const needCloseDockApproach =
        Boolean(lastRawWp.docking) &&
        !lastRawWp.reverse &&
        dLastObs >= 0.391 &&
        (dLastObs < AMR_STAND_RADIUS + 0.08 || lastHasPalletClose) &&
        (!isAmrPoseClear(lastRawWp.x, lastRawWp.y, travelHLast, amrSolidForLast, 0.002, null, st.carriedWcid, st.turntableYawRad, st.liftHeightM) ||
          (Number.isFinite(lastRawWp.heading) && Math.abs(wrapPi(lastRawWp.heading - travelHLast)) > 0.05) ||
          unheadedApproachTight ||
          startCloseSkewed);
      const finalApproach = !lastRawWp.reverse && (!lastRawWp.docking || needCloseDockApproach)
        ? planAmrCloseApproach(lastRawWp, amrSolid, prevApproachPos, st.carriedWcid, st.turntableYawRad, st.liftHeightM)
        : null;
      const expandedPrefix = [];
      for (let i = 0; i < rawWps.length - 1; i++) {
        const w = rawWps[i];
        if (!w) continue;
        if (w.docking && !w.reverse) {
          const midSolid = amrSolid.map((b) => {
            if (b && b.kind === "container" && b.obb && Number.isFinite(b.obb.rawHalfW) && pointToObstacleDist(w.x, w.y, b) < 0.435) {
              const u = unpadContainerObstacleForDst(b);
              if (pointToObstacleDist(w.x, w.y, u) >= 0.391) {
                rawCtrIdsForLast.push(b.id);
                return u;
              }
            }
            return b;
          });
          const dMidObs = minDistanceToObstacles(w.x, w.y, midSolid);
          if (dMidObs >= 0.391 && dMidObs < AMR_STAND_RADIUS + 0.08) {
            const prevMidPos = expandedPrefix.length > 0 ? expandedPrefix[expandedPrefix.length - 1] : routeFrom;
            const explicitMidH = Number.isFinite(w.heading) ? wrapHeading(w.heading) : null;
            const dxMid = w.x - prevMidPos.x;
            const dyMid = w.y - prevMidPos.y;
            const distMid = Math.hypot(dxMid, dyMid);
            const candMidH = explicitMidH !== null
              ? explicitMidH
              : (distMid > 0.05 ? wrapHeading(Math.atan2(dxMid, dyMid)) : null);
            const isAmrRotationClear = (wx, wy, fromH, toH) => {
              if (!Number.isFinite(fromH) || !Number.isFinite(toH)) return true;
              const diff = wrapPi(toH - fromH);
              const steps = Math.max(2, Math.ceil(Math.abs(diff) / 0.04));
              for (let s = 1; s <= steps; s++) {
                const h = wrapHeading(fromH + diff * (s / steps));
                if (!isAmrPoseClear(wx, wy, h, midSolid, 0.002)) return false;
              }
              return true;
            };
            let alignedDirectDock = false;
            if (candMidH !== null) {
              const [fxDir, fyDir] = headingForward(candMidH);
              const [rxDir, ryDir] = headingRight(candMidH);
              const alongMid = dxMid * fxDir + dyMid * fyDir;
              const crossMid = Math.abs(dxMid * rxDir + dyMid * ryDir);
              if (
                alongMid > 0.05 &&
                crossMid <= 0.04 &&
                isAmrPoseClear(prevMidPos.x, prevMidPos.y, candMidH, midSolid, 0.002) &&
                isAmrSweptClear(prevMidPos.x, prevMidPos.y, w.x, w.y, candMidH, midSolid, 0.002) &&
                isAmrRotationClear(prevMidPos.x, prevMidPos.y, prevMidPos.heading, candMidH)
              ) {
                alignedDirectDock = true;
              }
            }
            let midPull = null;
            if (
              !alignedDirectDock &&
              i === 0 &&
              !departPull &&
              minDistanceToObstacles(st.x, st.y, midSolid) < AMR_STAND_RADIUS + 0.08
            ) {
              midPull = planAmrCloseDeparture(st, midSolid);
            }
            const midFrom = midPull ? { x: midPull.x, y: midPull.y, heading: st.heading } : prevMidPos;
            const midApp = alignedDirectDock ? null : planAmrCloseApproach(w, amrSolid, midFrom);
            if (alignedDirectDock || (midApp && !midApp.reverseSlide)) {
              if (midApp && Array.isArray(midApp.useRawContainerIds)) {
                for (const cid of midApp.useRawContainerIds) {
                  if (!rawCtrIdsForLast.includes(cid)) rawCtrIdsForLast.push(cid);
                }
              }
              const dockH = alignedDirectDock ? candMidH : (explicitMidH !== null ? explicitMidH : midApp.heading);
              if (midPull) {
                departPull = midPull;
                routeFrom = { x: midPull.x, y: midPull.y, heading: st.heading };
              }
              if (!alignedDirectDock && midApp) {
                expandedPrefix.push({
                  x: midApp.preX,
                  y: midApp.preY,
                  heading: midApp.heading,
                  skipTol: 0.25,
                  speedLimit: 0.75,
                });
              }
              expandedPrefix.push({
                ...w,
                heading: dockH,
                skipTol: 0.12,
                speedLimit: 0.75,
                _directSeg: true,
                _alignBeforeMove: alignedDirectDock,
              });
              if (dMidObs < AMR_SPECS.hullRadiusM + 0.08) {
                const [fxDock, fyDock] = headingForward(dockH);
                for (const dOut of [0.95, 1.30, 1.65, 2.10, 2.50]) {
                  const postX = w.x + fxDock * dOut;
                  const postY = w.y + fyDock * dOut;
                  const skipCheckX = postX - fxDock * Math.min(0.35, dOut * 0.5);
                  const skipCheckY = postY - fyDock * Math.min(0.35, dOut * 0.5);
                  if (
                    minDistanceToObstacles(postX, postY, midSolid) >= AMR_STAND_RADIUS + 0.08 &&
                    minDistanceToObstacles(skipCheckX, skipCheckY, midSolid) >= AMR_STAND_RADIUS + 0.08 &&
                    isAmrSweptClear(w.x, w.y, postX, postY, dockH, midSolid, 0.002)
                  ) {
                    expandedPrefix.push({
                      x: postX,
                      y: postY,
                      heading: dockH,
                      skipTol: 0.25,
                      speedLimit: 0.75,
                      _directSeg: true,
                    });
                    break;
                  }
                }
              }
              continue;
            }
          }
        }
        expandedPrefix.push({ ...w });
      }
      let targetWps;
      if (finalApproach) {
        if (rawWps.length === 1) {
          targetWps = [{ x: finalApproach.preX, y: finalApproach.preY, heading: finalApproach.heading }];
        } else {
          targetWps = [
            ...expandedPrefix,
            { x: finalApproach.preX, y: finalApproach.preY, heading: finalApproach.heading },
          ];
        }
      } else {
        targetWps = [...expandedPrefix, { ...lastRawWp }];
        if (targetWps.length >= 2 && lastRawWp.docking && dLastObs < AMR_STAND_RADIUS + 0.09) {
          const penIdx = targetWps.length - 2;
          targetWps[penIdx] = {
            ...targetWps[penIdx],
            skipTol: Math.min(targetWps[penIdx].skipTol ?? 1.25, 0.25),
            speedLimit: Math.min(targetWps[penIdx].speedLimit ?? Infinity, 0.75),
          };
        }
      }
      let finalApproachUsed = finalApproach;
      const solidNonTunnelTooClose = amrSolidForLast.some(
        (b) => b && b.kind !== "stand" && b.kind !== "liftTable" && pointToObstacleDist(lastRawWp.x, lastRawWp.y, b) < AMR_HALF_W - 0.005,
      );
      const explicitPoseHitsStatic =
        Number.isFinite(lastRawWp.heading) &&
        dLastObs >= AMR_HALF_W - 0.005 &&
        !isAmrPoseClear(lastRawWp.x, lastRawWp.y, wrapHeading(lastRawWp.heading), amrSolidForLast, 0.002, null, st.carriedWcid, st.turntableYawRad, st.liftHeightM);
      if (!lastRawWp.reverse && !finalApproachUsed && (solidNonTunnelTooClose || explicitPoseHitsStatic)) {
        throw new Error(`AMR route unreachable from (${st.x.toFixed(2)}, ${st.y.toFixed(2)}) to (${lastRawWp.x.toFixed(2)}, ${lastRawWp.y.toFixed(2)})`);
      }
      let wps = routeAmrAroundSolidObstacles(routeFrom, targetWps, AMR_SPECS.hullRadiusM, amrSolid, { rejectOnFail: true, selfLoaded: Boolean(st.carriedWcid) });
      if (wps === null) {
        throw new Error(`AMR route unreachable from (${st.x.toFixed(2)}, ${st.y.toFixed(2)}) to (${lastRawWp.x.toFixed(2)}, ${lastRawWp.y.toFixed(2)})`);
      }
      if (!lastRawWp.reverse && idleVehObsForRoute.length > 0) {
        let hitsIdle = false;
        let px = routeFrom.x;
        let py = routeFrom.y;
        for (let wi = 0; wi < wps.length && !hitsIdle; wi++) {
          const wp = wps[wi];
          for (let oi = 0; oi < idleVehObsForRoute.length; oi++) {
            const b = idleVehObsForRoute[oi];
            const minReq = b.isPallet ? 0.56 : 0.42;
            const db = wi === wps.length - 1 ? pointToObstacleDist(wp.x, wp.y, b) : Infinity;
            const da = wi === 0 ? pointToObstacleDist(px, py, b) : Infinity;
            const maxVehPad = b.isAgf ? (st.carriedWcid ? 0.80 : AMR_SPECS.hullRadiusM + 0.12) : 0.85;
            const effP = Math.min(maxVehPad, Math.max(minReq, Math.min(da, db) - 0.01));
            if (amrSegWithinObstacle2D(px, py, wp.x, wp.y, b, effP)) {
              hitsIdle = true;
              break;
            }
          }
          px = wp.x;
          py = wp.y;
        }
        if (hitsIdle) {
          const rerouted = routeAmrAroundSolidObstacles(routeFrom, targetWps, AMR_SPECS.hullRadiusM, [...amrSolid, ...idleVehObsForRoute], { rejectOnFail: true, selfLoaded: Boolean(st.carriedWcid) });
          if (rerouted !== null) wps = rerouted;
        }
      }
      if (!finalApproachUsed && lastRawWp.docking && !lastRawWp.reverse && wps.length >= 2 && dLastObs >= 0.391 && dLastObs < AMR_STAND_RADIUS + 0.08) {
        const penWp = wps[wps.length - 2];
        const travelHPen = Math.hypot(lastRawWp.x - penWp.x, lastRawWp.y - penWp.y) > 0.05
          ? Math.atan2(lastRawWp.x - penWp.x, lastRawWp.y - penWp.y)
          : st.heading;
        const unheadedTightPen = !Number.isFinite(lastRawWp.heading) &&
          (!isAmrPoseClear(lastRawWp.x, lastRawWp.y, travelHPen + 0.25, amrSolidForLast, 0.002, null, st.carriedWcid, st.turntableYawRad, st.liftHeightM) ||
            !isAmrPoseClear(lastRawWp.x, lastRawWp.y, travelHPen - 0.25, amrSolidForLast, 0.002, null, st.carriedWcid, st.turntableYawRad, st.liftHeightM));
        const needPenDock =
          !isAmrPoseClear(lastRawWp.x, lastRawWp.y, travelHPen, amrSolidForLast, 0.002, null, st.carriedWcid, st.turntableYawRad, st.liftHeightM) ||
          (Number.isFinite(lastRawWp.heading) && Math.abs(wrapPi(lastRawWp.heading - travelHPen)) > 0.05) ||
          unheadedTightPen;
        if (needPenDock) {
          finalApproachUsed = planAmrCloseApproach(lastRawWp, amrSolid, penWp, st.carriedWcid, st.turntableYawRad, st.liftHeightM);
          if (finalApproachUsed) {
            const tailSeg = routeAmrAroundSolidObstacles(
              { x: penWp.x, y: penWp.y, heading: st.heading },
              [{ x: finalApproachUsed.preX, y: finalApproachUsed.preY, heading: finalApproachUsed.heading }],
              AMR_SPECS.hullRadiusM,
              amrSolid,
              { rejectOnFail: true, selfLoaded: Boolean(st.carriedWcid) },
            );
            if (tailSeg === null) {
              throw new Error(`AMR route unreachable from (${st.x.toFixed(2)}, ${st.y.toFixed(2)}) to (${lastRawWp.x.toFixed(2)}, ${lastRawWp.y.toFixed(2)})`);
            }
            wps = [...wps.slice(0, -1), ...tailSeg];
          }
        }
        if (!finalApproachUsed) {
          const penIdx = wps.length - 2;
          wps[penIdx] = {
            ...wps[penIdx],
            skipTol: Math.min(wps[penIdx].skipTol ?? 1.25, 0.25),
            speedLimit: Math.min(wps[penIdx].speedLimit ?? Infinity, 0.75),
          };
        }
      }
      if (!finalApproachUsed && !lastRawWp.reverse && idleVehObsAll.length > 0 && wps.length >= 1) {
        const hasNearIdle = idleVehObsAll.some((b) => pointToObstacleDist(lastRawWp.x, lastRawWp.y, b) < 1.35);
        if (hasNearIdle) {
          const penWp = wps.length >= 2 ? wps[wps.length - 2] : routeFrom;
          const travelH = Math.hypot(lastRawWp.x - penWp.x, lastRawWp.y - penWp.y) > 0.05
            ? Math.atan2(lastRawWp.x - penWp.x, lastRawWp.y - penWp.y)
            : st.heading;
          const isRotClearIdle = (wx, wy, hA, hB) => {
            if (!isAmrPoseClearOfIdleVehicles(wx, wy, hA, entry, st.carriedWcid, st.turntableYawRad, 0.002)) return false;
            const diff = wrapPi(hB - hA);
            const steps = Math.max(1, Math.ceil(Math.abs(diff) / 0.14));
            for (let s = 1; s <= steps; s++) {
              if (!isAmrPoseClearOfIdleVehicles(wx, wy, wrapHeading(hA + diff * (s / steps)), entry, st.carriedWcid, st.turntableYawRad, 0.002)) return false;
            }
            return true;
          };
          const arrOk = isAmrPoseClearOfIdleVehicles(lastRawWp.x, lastRawWp.y, travelH, entry, st.carriedWcid, st.turntableYawRad, 0.002) &&
            (!Number.isFinite(lastRawWp.heading) || isRotClearIdle(lastRawWp.x, lastRawWp.y, travelH, wrapHeading(lastRawWp.heading)));
          if (!arrOk) {
            const targetHExplicit = Number.isFinite(lastRawWp.heading) ? wrapHeading(lastRawWp.heading) : null;
            const candHeads = targetHExplicit !== null
              ? [targetHExplicit, 0, Math.PI * 0.5, Math.PI, -Math.PI * 0.5, travelH]
              : [0, Math.PI * 0.5, Math.PI, -Math.PI * 0.5, travelH, Math.PI * 0.25, -Math.PI * 0.25, Math.PI * 0.75, -Math.PI * 0.75];
            let foundFa = null;
            for (let hi = 0; hi < candHeads.length && !foundFa; hi++) {
              const chH = wrapHeading(candHeads[hi]);
              if (!isAmrPoseClearOfIdleVehicles(lastRawWp.x, lastRawWp.y, chH, entry, st.carriedWcid, st.turntableYawRad, 0.002)) continue;
              if (!isAmrPoseClear(lastRawWp.x, lastRawWp.y, chH, amrSolidForLast, 0.002, null, st.carriedWcid, st.turntableYawRad, st.liftHeightM)) continue;
              if (targetHExplicit !== null && !isRotClearIdle(lastRawWp.x, lastRawWp.y, chH, targetHExplicit)) continue;
              const [fxH, fyH] = headingForward(chH);
              for (const dPre of [0.65, 0.95, 1.30, 1.70]) {
                const preX = lastRawWp.x - fxH * dPre;
                const preY = lastRawWp.y - fyH * dPre;
                if (minDistanceToObstacles(preX, preY, amrSolid) < AMR_STAND_RADIUS + 0.05) continue;
                if (st.carriedWcid && amrHasCloseObs(preX, preY, amrSolid, AMR_STAND_RADIUS + 0.05, st.carriedWcid, st.liftHeightM)) continue;
                if (!isAmrPoseClearOfIdleVehicles(preX, preY, chH, entry, st.carriedWcid, st.turntableYawRad, 0.003)) continue;
                let segClear = true;
                const steps = Math.max(4, Math.ceil(dPre / 0.15));
                for (let s = 1; s <= steps; s++) {
                  const tStep = s / steps;
                  const sx = preX + (lastRawWp.x - preX) * tStep;
                  const sy = preY + (lastRawWp.y - preY) * tStep;
                  if (!isAmrPoseClear(sx, sy, chH, amrSolidForLast, 0.002, null, st.carriedWcid, st.turntableYawRad, st.liftHeightM) || !isAmrPoseClearOfIdleVehicles(sx, sy, chH, entry, st.carriedWcid, st.turntableYawRad, 0.002)) {
                    segClear = false;
                    break;
                  }
                }
                if (!segClear) continue;
                foundFa = {
                  preX,
                  preY,
                  heading: chH,
                  dstX: lastRawWp.x,
                  dstY: lastRawWp.y,
                  dstHeading: targetHExplicit,
                  obsId: null,
                  dDst: dLastObs,
                  reverseSlide: false,
                  useRawContainerIds: rawCtrIdsForLast.length > 0 ? rawCtrIdsForLast : null,
                };
                break;
              }
            }
            if (foundFa) {
              const faWps = routeAmrAroundSolidObstacles(
                routeFrom,
                [...expandedPrefix, { x: foundFa.preX, y: foundFa.preY, heading: foundFa.heading }],
                AMR_SPECS.hullRadiusM,
                [...amrSolid, ...idleVehObsForRoute],
                { rejectOnFail: true },
              );
              if (faWps !== null) {
                wps = faWps;
                finalApproachUsed = foundFa;
              }
            } else if (lastRawWp.docking) {
              throw new Error(`AMR route unreachable: target pose (${lastRawWp.x.toFixed(2)}, ${lastRawWp.y.toFixed(2)}) blocked by vehicle`);
            }
          }
        }
      }
      commitUndockAndParkClear();
      item.phase = departPull ? "depart_pull" : "drive";
      item.data = {
        waypoints: wps,
        waypointIndex: 0,
        departPull,
        departIgnorePushoutId: prevDockedChargerId || (departPull && departPull.dStart < AMR_HALF_W ? departPull.obsId : null),
        finalApproach: finalApproachUsed,
        useRawContainerIds: rawCtrIdsForLast.length > 0 ? rawCtrIdsForLast : null,
        keepCargoHeading: Boolean(t.keepCargoHeading),
        heldCargoHeading: Number.isFinite(t.heldCargoHeading) ? t.heldCargoHeading : wrapHeading(st.heading + st.turntableYawRad),
        speedLimit: t.speedLimit,
      };
      return;
    }

    const planAndValidateAmrApproachRoute = (dstPos, amrSolid, extraIdleObs = null) => {
      const amrPad = AMR_SPECS.hullRadiusM + 0.12;
      const departPull = planAmrCloseDeparture(st, amrSolid, prevDockedChargerId);
      if (prevDockedChargerId && !departPull && Math.hypot(dstPos[0] - st.x, dstPos[1] - st.y) > 0.35) {
        throw new Error(`AMR route unreachable from charger ${prevDockedChargerId} (${st.x.toFixed(2)}, ${st.y.toFixed(2)})`);
      }
      const routeFrom = departPull ? { x: departPull.x, y: departPull.y, heading: st.heading } : st;
      const isRouteClear = (pts, checkObstacles) => {
        if (!Array.isArray(pts) || pts.length === 0) return false;
        let px = routeFrom.x;
        let py = routeFrom.y;
        for (let ri = 0; ri < pts.length; ri++) {
          const pt = pts[ri];
          if (!pt || !Number.isFinite(pt.x) || !Number.isFinite(pt.y)) return false;
          for (let oi = 0; oi < checkObstacles.length; oi++) {
            const b = checkObstacles[oi];
            if (!b) continue;
            if (ri === 0 && (b.kind === "stand" || b.kind === "liftTable") && pointToObstacleDist(px, py, b) < AMR_HALF_W) continue;
            let effPad = b.kind === "vehicle" ? amrPad : amrObsClearR(b, amrPad, st.carriedWcid, st.liftHeightM);
            if (b.kind === "vehicle") {
              const vehPad = b.isAgf ? (st.carriedWcid ? 0.80 : amrPad) : 0.85;
              if (vehPad > effPad) {
                const daV = pointToObstacleDist(px, py, b);
                const dbV = pointToObstacleDist(pt.x, pt.y, b);
                if (daV >= 0.88 && dbV >= 0.88) effPad = vehPad;
              }
            }
            if (ri === 0) {
              const da = pointToObstacleDist(px, py, b);
              if (da < effPad) effPad = Math.min(effPad, Math.max(0.02, da - 0.01));
            }
            if (ri === pts.length - 1) {
              const db = pointToObstacleDist(pt.x, pt.y, b);
              const minEnd = (b.kind === "vehicle" && b.isPallet) ? 0.552 : 0.02;
              if (db < effPad) effPad = Math.min(effPad, Math.max(minEnd, db - 0.01));
            }
            if (amrSegWithinObstacle2D(px, py, pt.x, pt.y, b, effPad)) return false;
          }
          px = pt.x;
          py = pt.y;
        }
        return Math.hypot(px - dstPos[0], py - dstPos[1]) <= 0.10;
      };
      const filteredIdle = Array.isArray(extraIdleObs) && extraIdleObs.length > 0
        ? extraIdleObs.filter((b) => {
          const minEnd = b.isPallet ? 0.552 : (AMR_HALF_W - 0.005);
          return pointToObstacleDist(routeFrom.x, routeFrom.y, b) >= minEnd && pointToObstacleDist(dstPos[0], dstPos[1], b) >= minEnd;
        })
        : [];
      const combinedObs = filteredIdle.length > 0 ? [...amrSolid, ...filteredIdle] : amrSolid;
      let route = findPath([routeFrom.x, routeFrom.y], dstPos, "amr");
      if (!isRouteClear(route, combinedObs)) {
        const routed = routeAmrAroundSolidObstacles(routeFrom, [{ x: dstPos[0], y: dstPos[1] }], AMR_SPECS.hullRadiusM, combinedObs, { rejectOnFail: true, selfLoaded: Boolean(st.carriedWcid) });
        if (routed === null) {
          if (filteredIdle.length === 0 || !isRouteClear(route, amrSolid)) {
            const routedStatic = filteredIdle.length > 0
              ? routeAmrAroundSolidObstacles(routeFrom, [{ x: dstPos[0], y: dstPos[1] }], AMR_SPECS.hullRadiusM, amrSolid, { rejectOnFail: true })
              : null;
            if (routedStatic === null) {
              throw new Error(`AMR route unreachable from (${st.x.toFixed(2)}, ${st.y.toFixed(2)}) to (${dstPos[0].toFixed(2)}, ${dstPos[1].toFixed(2)})`);
            }
            route = routedStatic;
          }
        } else {
          route = routed;
        }
      }
      if (!isRouteClear(route, amrSolid)) {
        throw new Error(`AMR route unreachable from (${st.x.toFixed(2)}, ${st.y.toFixed(2)}) to (${dstPos[0].toFixed(2)}, ${dstPos[1].toFixed(2)})`);
      }
      return { route, departPull };
    };

    if (type === "pickFromStand" || type === "placeOnStand") {
      const target = resolveStandOrLift(t.standId);
      if (!target) throw new Error(`Unknown standId: ${t.standId}`);
      if (type === "pickFromStand") {
        if (st.carriedWcid) throw new Error("AMR already carrying cargo");
        if (target.handle.carriedWcid === 0) throw new Error(`Stand ${t.standId} is empty`);
        if (target.kind === "liftTable" && target.handle.heightM < LIFT_TABLE_SPECS.raisedZ - LIFT_TABLE_SPECS.raisedToleranceM) {
          throw new Error(`Lift table ${t.standId} is not raised (${target.handle.heightM})`);
        }
      } else {
        if (!st.carriedWcid) throw new Error("AMR not carrying cargo");
        if (target.handle.carriedWcid !== 0) throw new Error(`Stand ${t.standId} is occupied`);
        if (target.kind === "liftTable" && target.handle.heightM < LIFT_TABLE_SPECS.raisedZ - LIFT_TABLE_SPECS.raisedToleranceM) {
          throw new Error(`Lift table ${t.standId} is not raised (${target.handle.heightM})`);
        }
      }
      const sPos = target.handle.pos;
      const app = target.handle.amrApproachPos;
      const ah = wrapHeading(Math.atan2(sPos[0] - app[0], sPos[1] - app[1]));
      const bayObbs = buildAmrBayObbs(app, sPos, ah, st.carriedWcid !== 0 || type === "pickFromStand");
      for (const other of amrEntries.values()) {
        if (other === entry) continue;
        const active = other.queue?.[0];
        if (
          active?.initialized &&
          (active.task?.type === "pickFromStand" || active.task?.type === "placeOnStand") &&
          active.task?.standId === t.standId &&
          (active.task?.type === type ||
            active.phase === "enter" ||
            active.phase === "actuate" ||
            active.phase === "exit" ||
            active.phase === "abort_exit")
        ) {
          throw new Error(
            active.task?.type === type
              ? (type === "pickFromStand"
                ? `Stand ${t.standId} is empty (reserved)`
                : `Stand ${t.standId} is occupied (reserved)`)
              : `Stand ${t.standId} is blocked (reserved)`,
          );
        }
      }
      for (const other of agfEntries.values()) {
        const active = other.queue?.[0];
        if (
          active?.initialized &&
          (active.task?.type === "pickFromStand" || active.task?.type === "placeOnStand") &&
          active.task?.standId === t.standId &&
          (active.task?.type === type ||
            active.phase === "insert" ||
            active.phase === "actuate" ||
            active.phase === "retract" ||
            active.phase === "abort_retract")
        ) {
          throw new Error(
            active.task?.type === type
              ? (type === "pickFromStand"
                ? `Stand ${t.standId} is empty (reserved)`
                : `Stand ${t.standId} is occupied (reserved)`)
              : `Stand ${t.standId} is blocked (reserved)`,
          );
        }
      }
      if (isZoneBlockedByOtherVehicles(bayObbs, null, entry)) {
        throw new Error(`Stand ${t.standId} is blocked`);
      }

      const amrSolid = getStaticObstacles({ includeStands: true, includeLiftTables: true, includeContainers: true });
      assertAmrStartNotTrapped(st, amrSolid, prevDockedChargerId, app);
      if (
        !isAmrPoseClear(app[0], app[1], ah, amrSolid, 0.002) ||
        minDistanceToObstacles(app[0], app[1], amrSolid) < AMR_HALF_W + 0.05
      ) {
        throw new Error(`AMR route unreachable to stand ${t.standId} approach (${app[0].toFixed(2)}, ${app[1].toFixed(2)})`);
      }
      if (!isAmrSweptClear(app[0], app[1], sPos[0], sPos[1], ah, amrSolid, 0.002, target.handle.id)) {
        throw new Error(`AMR route unreachable to stand ${t.standId} under-pose (${sPos[0].toFixed(2)}, ${sPos[1].toFixed(2)})`);
      }
      const standIdleObs = buildIdleVehicleObstacles(entry, Boolean(st.carriedWcid));
      const { route, departPull } = planAndValidateAmrApproachRoute(app, amrSolid, standIdleObs);
      route[route.length - 1] = { ...route[route.length - 1], heading: ah };

      commitUndockAndParkClear();
      item.phase = departPull ? "depart_pull" : "route";
      item.data = {
        target,
        departPull,
        departIgnorePushoutId: prevDockedChargerId || (departPull && departPull.dStart < AMR_HALF_W ? departPull.obsId : null),
        approachPose: { x: app[0], y: app[1], heading: ah },
        exitPose: { x: app[0], y: app[1] },
        underPose: { x: sPos[0], y: sPos[1], heading: ah },
        route,
        waypointIndex: 0,
      };
      return;
    }

    if (type === "dockCharge") {
      const ch = chargers.get(t.chargerId);
      if (!ch) throw new Error(`Unknown chargerId: ${t.chargerId}`);
      const dockHeading = wrapHeading(Math.atan2(ch.pos[0] - ch.approachPos[0], ch.pos[1] - ch.approachPos[1]));
      const bayObbs = buildAmrBayObbs(ch.approachPos, ch.dockPos, dockHeading, st.carriedWcid !== 0);
      for (const other of amrEntries.values()) {
        if (other === entry) continue;
        const active = other.queue?.[0];
        const otherDepartingViaDriveTo = active?.task?.type === "driveTo";
        if (
          (active?.initialized && active.task?.type === "dockCharge" && active.task?.chargerId === t.chargerId) ||
          (!otherDepartingViaDriveTo && other.state.dockedChargerId === t.chargerId) ||
          (other.queue.length === 0 && findDockedChargerIdForPose(other.state) === t.chargerId)
        ) {
          throw new Error(`Charger ${t.chargerId} is reserved`);
        }
        if (
          otherDepartingViaDriveTo &&
          (other.state.dockedChargerId === t.chargerId ||
            findDockedChargerIdForPose(other.state) === t.chargerId ||
            obbListOverlap(getEntryWorldObbs(other, false).chassis, bayObbs))
        ) {
          const depSpeed = extractDriveToSpeedLimit(active.task);
          const destObbs = getVehicleBlockingObbs(other, false);
          if (depSpeed < 0.25 || (destObbs && obbListOverlap(destObbs, bayObbs))) {
            throw new Error(`Charger ${t.chargerId} is blocked`);
          }
        }
      }
      if (isZoneBlockedByOtherVehicles(bayObbs, null, entry)) {
        throw new Error(`Charger ${t.chargerId} is blocked`);
      }
      const amrSolid = getStaticObstacles({ includeStands: true, includeLiftTables: true, includeContainers: true });
      assertAmrStartNotTrapped(st, amrSolid, prevDockedChargerId, ch.approachPos);
      if (
        !isAmrPoseClear(ch.approachPos[0], ch.approachPos[1], dockHeading, amrSolid, 0.002) ||
        minDistanceToObstacles(ch.approachPos[0], ch.approachPos[1], amrSolid) < AMR_HALF_W + 0.05
      ) {
        throw new Error(`AMR route unreachable to charger ${t.chargerId} approach (${ch.approachPos[0].toFixed(2)}, ${ch.approachPos[1].toFixed(2)})`);
      }
      if (!isAmrSweptClear(ch.approachPos[0], ch.approachPos[1], ch.dockPos[0], ch.dockPos[1], dockHeading, amrSolid, 0.002, ch.id)) {
        throw new Error(`AMR route unreachable to charger ${t.chargerId} dock (${ch.dockPos[0].toFixed(2)}, ${ch.dockPos[1].toFixed(2)})`);
      }
      const chIdleObs = buildIdleVehicleObstacles(entry, Boolean(st.carriedWcid));
      const hasNearIdleCh = chIdleObs.some((b) => pointToObstacleDist(ch.approachPos[0], ch.approachPos[1], b) < 2.2);
      let approachGoal = ch.approachPos;
      let usedPreDock = false;
      if (hasNearIdleCh) {
        const [dfx, dfy] = headingForward(dockHeading);
        const preDock = [ch.approachPos[0] - dfx * 1.25, ch.approachPos[1] - dfy * 1.25];
        if (
          minDistanceToObstacles(preDock[0], preDock[1], amrSolid) >= AMR_STAND_RADIUS + 0.05 &&
          isAmrPoseClearOfIdleVehicles(preDock[0], preDock[1], dockHeading, entry, st.carriedWcid, st.turntableYawRad, 0.05) &&
          isAmrSweptClear(preDock[0], preDock[1], ch.approachPos[0], ch.approachPos[1], dockHeading, amrSolid, 0.002)
        ) {
          let segIdleOk = true;
          for (let s = 1; s <= 8; s++) {
            const tStep = s / 8;
            if (!isAmrPoseClearOfIdleVehicles(
              preDock[0] + (ch.approachPos[0] - preDock[0]) * tStep,
              preDock[1] + (ch.approachPos[1] - preDock[1]) * tStep,
              dockHeading,
              entry,
              st.carriedWcid,
              st.turntableYawRad,
              0.002,
            )) {
              segIdleOk = false;
              break;
            }
          }
          if (segIdleOk) {
            approachGoal = preDock;
            usedPreDock = true;
          }
        }
      }
      const { route, departPull } = planAndValidateAmrApproachRoute(approachGoal, amrSolid, chIdleObs);
      if (usedPreDock) {
        route.push({ x: ch.approachPos[0], y: ch.approachPos[1], heading: dockHeading, skipTol: 0.25 });
      }
      route.push({ x: ch.dockPos[0], y: ch.dockPos[1], heading: dockHeading });
      commitUndockAndParkClear();
      item.phase = departPull ? "depart_pull" : "route";
      item.data = {
        ch,
        bayObbs,
        departPull,
        departIgnorePushoutId: prevDockedChargerId || (departPull && departPull.dStart < AMR_HALF_W ? departPull.obsId : null),
        route,
        waypointIndex: 0,
      };
      return;
    }

    throw new Error(`Unknown AMR task type: ${type}`);
  }

  function stepAmrEntry(entry, dt, staticObstacles = null) {
    const st = entry.state;
    const item = entry.queue[0] || null;

    if (item && !item.initialized) {
      item.initialized = true;
      try {
        initAmrTask(entry, item);
      } catch (err) {
        entry.queue.shift();
        item.reject(err);
        return stepAmrEntry(entry, 0, staticObstacles);
      }
    }

    let cmd = {
      targetLiftHeightM: st.liftHeightM,
      charging: st.charging,
      speed: 0,
      omega: 0,
    };

    let isPreAlignStep = false;
    let preAlignWp = null;
    if (item) {
      const t = item.task;
      const d = item.data;

      if (d.deadlockPull) {
        const dp = d.deadlockPull;
        const rem = Math.hypot(dp.x - st.x, dp.y - st.y);
        cmd = {
          speed: dp.dir * clamp(Math.max(rem, 0.15) * 3.0, 0.30, 0.95),
          omega: 0,
          ...(t.type === "driveTo" ? { keepCargoHeading: d.keepCargoHeading, heldCargoHeading: d.heldCargoHeading } : {}),
          targetLiftHeightM: st.liftHeightM,
        };
      } else if (item.phase === "depart_pull" && d.departPull) {
        const dp = d.departPull;
        const rem = Math.hypot(dp.x - st.x, dp.y - st.y);
        cmd = {
          speed: dp.dir * clamp(Math.max(rem, 0.15) * 3.0, 0.30, 1.0),
          omega: 0,
          ...(t.type === "driveTo" ? { keepCargoHeading: d.keepCargoHeading, heldCargoHeading: d.heldCargoHeading } : {}),
          targetLiftHeightM: st.liftHeightM,
        };
      } else if (t.type === "driveTo") {
        if (item.phase === "final_approach" && d.finalApproach) {
          const fa = d.finalApproach;
          const distToFaDst = Math.hypot(fa.dstX - st.x, fa.dstY - st.y);
          const [fx, fy] = headingForward(fa.heading);
          if (fa.reverseSlide) {
            const [rx, ry] = headingRight(fa.heading);
            const dx = fa.dstX - st.x;
            const dy = fa.dstY - st.y;
            const along = -(dx * fx + dy * fy);
            const cross = dx * rx + dy * ry;
            const nearClear = minDistanceToObstacles(st.x, st.y, staticObstacles || getStaticObstacles()) >= 0.70;
            const trimLim = nearClear ? 0.06 : 0.008;
            const desiredH = wrapHeading(fa.heading - clamp(cross * 1.0, -trimLim, trimLim));
            const yawErr = wrapPi(desiredH - st.heading);
            const speedCap = Math.min(d.speedLimit ?? Infinity, distToFaDst > 2.2 ? 1.50 : 0.75);
            const revSpeed = distToFaDst <= AMR_SPECS.dockPosTolM
              ? 0
              : along >= 0
                ? -clamp(Math.sqrt(2.0 * 3.5 * along), 0.10, speedCap)
                : clamp(Math.sqrt(2.0 * 3.5 * (-along)), 0.10, 0.35);
            cmd = {
              speed: revSpeed,
              omega: clamp(yawErr * 6.0, -AMR_SPECS.omegaMaxRadSec, AMR_SPECS.omegaMaxRadSec),
              keepCargoHeading: d.keepCargoHeading,
              heldCargoHeading: d.heldCargoHeading,
              targetLiftHeightM: st.liftHeightM,
            };
          } else {
            const alongRem = (fa.dstX - st.x) * fx + (fa.dstY - st.y) * fy;
            const useCarrot = alongRem > 0.85;
            const carrotX = useCarrot ? fa.dstX - fx * (alongRem - 0.80) : fa.dstX;
            const carrotY = useCarrot ? fa.dstY - fy * (alongRem - 0.80) : fa.dstY;
            const faSpeedCap = distToFaDst > 2.2 ? 1.50 : 0.75;
            cmd = {
              targetPose: {
                x: carrotX,
                y: carrotY,
                ...(!useCarrot && Number.isFinite(fa.dstHeading) ? { heading: fa.dstHeading } : {}),
              },
              keepCargoHeading: d.keepCargoHeading,
              heldCargoHeading: d.heldCargoHeading,
              speedLimit: Math.min(d.speedLimit ?? Infinity, faSpeedCap),
              targetLiftHeightM: st.liftHeightM,
            };
          }
        } else {
          const curDriveWp = d.waypoints?.[d.waypointIndex];
          if (
            curDriveWp?._alignBeforeMove &&
            !curDriveWp._aligned &&
            Number.isFinite(curDriveWp.heading) &&
            Math.hypot(curDriveWp.x - st.x, curDriveWp.y - st.y) > 0.12 &&
            Math.abs(wrapPi(curDriveWp.heading - st.heading)) > 0.025
          ) {
            isPreAlignStep = true;
            preAlignWp = curDriveWp;
            cmd = {
              targetPose: { x: st.x, y: st.y, heading: curDriveWp.heading },
              keepCargoHeading: d.keepCargoHeading,
              heldCargoHeading: d.heldCargoHeading,
              targetLiftHeightM: st.liftHeightM,
            };
          } else {
            if (curDriveWp?._alignBeforeMove) curDriveWp._aligned = true;
            const effSpeedLimit = Number.isFinite(curDriveWp?.speedLimit)
              ? Math.min(d.speedLimit ?? Infinity, curDriveWp.speedLimit)
              : d.speedLimit;
            cmd = {
              waypoints: d.waypoints,
              waypointIndex: d.waypointIndex,
              keepCargoHeading: d.keepCargoHeading,
              heldCargoHeading: d.heldCargoHeading,
              speedLimit: effSpeedLimit,
              targetLiftHeightM: st.liftHeightM,
            };
          }
        }
      } else if (t.type === "pickFromStand" || t.type === "placeOnStand") {
        const isPick = t.type === "pickFromStand";
        const preLift = isPick ? AMR_SPECS.loweredHeightM : AMR_SPECS.raisedHeightM;
        const postLift = isPick ? AMR_SPECS.raisedHeightM : AMR_SPECS.loweredHeightM;

        if (item.phase === "route") {
          cmd = { waypoints: d.route, waypointIndex: d.waypointIndex, targetLiftHeightM: preLift };
        } else if (item.phase === "prepare_lift") {
          cmd = { targetLiftHeightM: preLift, speed: 0, omega: 0 };
        } else if (item.phase === "enter") {
          cmd = { targetPose: d.underPose, targetLiftHeightM: preLift };
        } else if (item.phase === "actuate") {
          cmd = { targetLiftHeightM: postLift, speed: 0, omega: 0 };
        } else if (item.phase === "exit" || item.phase === "abort_exit") {
          const liftTarget = item.phase === "exit" ? postLift : preLift;
          const [fx, fy] = headingForward(d.underPose.heading);
          const [rx, ry] = headingRight(d.underPose.heading);
          const dx = d.exitPose.x - st.x;
          const dy = d.exitPose.y - st.y;
          const along = -(dx * fx + dy * fy);
          const cross = dx * rx + dy * ry;
          const rem = Math.hypot(dx, dy);
          const desiredH = wrapHeading(d.underPose.heading - clamp(cross * 1.0, -0.04, 0.04));
          const yawErr = wrapPi(desiredH - st.heading);
          const revSpeed = rem <= AMR_SPECS.dockPosTolM
            ? 0
            : along >= 0
              ? -clamp(Math.sqrt(2.0 * 3.5 * along), 0.10, 1.20)
              : clamp(Math.sqrt(2.0 * 3.5 * (-along)), 0.10, 0.35);
          cmd = {
            speed: revSpeed,
            omega: clamp(yawErr * 6.0, -AMR_SPECS.omegaMaxRadSec, AMR_SPECS.omegaMaxRadSec),
            reverseTargetPose: d.exitPose,
            targetLiftHeightM: liftTarget,
          };
        }
      } else if (t.type === "dockCharge") {
        if (item.phase === "route") {
          let holdOutsideBay = false;
          if (d.bayObbs && Math.hypot(d.ch.approachPos[0] - st.x, d.ch.approachPos[1] - st.y) <= 2.2) {
            const selfInBay = obbListOverlap(getEntryWorldObbs(entry, false).chassis, d.bayObbs);
            if (!selfInBay) {
              for (const other of amrEntries.values()) {
                if (other === entry) continue;
                if (obbListOverlap(getEntryWorldObbs(other, false).chassis, d.bayObbs)) {
                  holdOutsideBay = true;
                  break;
                }
              }
            }
          }
          const chargeLiftH = st.carriedWcid ? Math.max(st.liftHeightM, AMR_SPECS.raisedHeightM) : AMR_SPECS.loweredHeightM;
          cmd = holdOutsideBay
            ? { targetLiftHeightM: chargeLiftH, speed: 0, omega: 0 }
            : {
              waypoints: d.route,
              waypointIndex: d.waypointIndex,
              targetLiftHeightM: chargeLiftH,
            };
        }
      }
    }

    const rawFrameObstacles = staticObstacles || getStaticObstacles();
    let rawCtrIds = null;
    if (item?.phase === "final_approach") {
      rawCtrIds = item.data?.finalApproach?.useRawContainerIds;
    } else if (item?.phase === "depart_pull") {
      rawCtrIds = item.data?.departPull?.useRawContainerIds;
    } else if (item?.phase === "drive" && item.data?.useRawContainerIds?.length > 0) {
      const wpsDrive = item.data.waypoints;
      const wpIdxDrive = item.data.waypointIndex ?? 0;
      const dstDrive = wpsDrive?.[wpsDrive.length - 1];
      const curDrive = wpsDrive?.[wpIdxDrive];
      const prevDrive = wpIdxDrive > 0 ? wpsDrive?.[wpIdxDrive - 1] : null;
      if (
        (!item.data?.finalApproach && dstDrive && (wpIdxDrive >= wpsDrive.length - 1 || Math.hypot(dstDrive.x - st.x, dstDrive.y - st.y) <= 1.65)) ||
        (curDrive && curDrive !== dstDrive && Math.hypot(curDrive.x - st.x, curDrive.y - st.y) <= 1.65) ||
        (prevDrive && prevDrive.docking && Math.hypot(prevDrive.x - st.x, prevDrive.y - st.y) <= 1.65)
      ) {
        rawCtrIds = item.data.useRawContainerIds;
      }
    } else if (!item) {
      rawCtrIds = st._parkedRawCtrIds;
    }
    const frameObstacles = (Array.isArray(rawCtrIds) && rawCtrIds.length > 0)
      ? rawFrameObstacles.map((b) => (b && b.kind === "container" && rawCtrIds.includes(b.id) ? unpadContainerObstacleForDst(b) : b))
      : rawFrameObstacles;
    cmd = applyDeadlockBreaker(st, AMR_SPECS.hullRadiusM, item, cmd, dt, false, frameObstacles);

    const kinRaw = stepAmrKinematics(st, cmd, dt, {
      agentId: st.agentId,
      grid: makeProximityGridFor(AMR_SPECS.hullRadiusM, cmd),
    });
    let ignorePushoutId = st.dockedChargerId || (!item ? findDockedChargerIdForPose(st) : null);
    if (item) {
      const tType = item.task.type;
      const ph = item.phase;
      if (ph === "depart_pull" && (item.data?.departIgnorePushoutId || (item.data?.departPull?.obsId != null && item.data.departPull.dStart < AMR_HALF_W))) {
        ignorePushoutId = item.data.departIgnorePushoutId || item.data.departPull.obsId;
      } else if ((tType === "pickFromStand" || tType === "placeOnStand") && (ph === "enter" || ph === "actuate" || ph === "exit" || ph === "abort_exit")) {
        ignorePushoutId = item.data.target.handle.id;
      } else if (tType === "dockCharge") {
        if (
          ph === "route" &&
          (item.data.waypointIndex ?? 0) >= (item.data.route?.length ?? 1) - 1 &&
          Math.hypot(item.data.ch.dockPos[0] - st.x, item.data.ch.dockPos[1] - st.y) <= 1.25
        ) {
          ignorePushoutId = item.data.ch.id;
        }
      } else if (item.data?.departIgnorePushoutId) {
        const depId = item.data.departIgnorePushoutId;
        const depObs = rawFrameObstacles.find((b) => b && b.id === depId);
        if (depObs && pointToObstacleDist(st.x, st.y, depObs) < amrObsClearR(depObs, AMR_STAND_RADIUS + 0.05, st.carriedWcid, st.liftHeightM)) {
          ignorePushoutId = depId;
        } else {
          item.data.departIgnorePushoutId = null;
        }
      }
    }
    const amrStandRadius = AMR_STAND_RADIUS;
    let edgeStandRadius = amrStandRadius;
    let overrideObsId = null;
    let overrideObsR = 0;
    let extraOverrides = null;
    if (item?.task?.type === "driveTo" && !ignorePushoutId) {
      if (item.phase === "depart_pull" && item.data?.departPull?.obsId != null) {
        if (item.data.departPull.dStart < AMR_HALF_W) {
          ignorePushoutId = item.data.departPull.obsId;
        } else {
          overrideObsId = item.data.departPull.obsId;
          overrideObsR = Math.min(amrStandRadius, Math.max(0.391, item.data.departPull.dStart - 0.003));
        }
      } else if (item.phase === "final_approach" && item.data?.finalApproach?.obsId != null) {
        const fa = item.data.finalApproach;
        const ovs = fa.closeObsOverrides;
        if (Array.isArray(ovs) && ovs.length > 0) {
          overrideObsId = ovs[0].id;
          overrideObsR = ovs[0].r;
          if (ovs.length > 1) extraOverrides = ovs.slice(1);
        } else {
          overrideObsId = fa.obsId;
          overrideObsR = Math.min(amrStandRadius, Math.max(0.391, fa.dDst - 0.003));
        }
      } else if (Array.isArray(item.data?.waypoints) && item.data.waypoints.length > 0) {
        const wps = item.data.waypoints;
        const wpIdxCur = item.data.waypointIndex ?? 0;
        const dstWp = wps[wps.length - 1];
        const curTargetWp = wps[wpIdxCur];
        const prevPassedWp = wpIdxCur > 0 ? wps[wpIdxCur - 1] : null;
        const refEntries = [];
        if (dstWp && !item.data?.finalApproach && (wpIdxCur >= wps.length - 1 || Math.hypot(dstWp.x - st.x, dstWp.y - st.y) <= 1.65)) {
          refEntries.push({ wp: dstWp, departing: false });
        }
        if (curTargetWp && curTargetWp !== dstWp && curTargetWp.docking && Math.hypot(curTargetWp.x - st.x, curTargetWp.y - st.y) <= 1.65) {
          refEntries.push({ wp: curTargetWp, departing: false });
        }
        if (prevPassedWp && prevPassedWp !== dstWp && prevPassedWp.docking && Math.hypot(prevPassedWp.x - st.x, prevPassedWp.y - st.y) <= 1.65) {
          refEntries.push({ wp: prevPassedWp, departing: true });
        }
        if (refEntries.length > 0) {
          const closeOvs = [];
          const seenOvIds = new Set();
          for (let ri = 0; ri < refEntries.length && !ignorePushoutId; ri++) {
            const { wp: refWp, departing: isDepartingCloseWp } = refEntries[ri];
            const headingDiff = Number.isFinite(refWp.heading) ? Math.abs(wrapPi(refWp.heading - kinRaw.heading)) : 0;
            const curHeadingAligned = headingDiff <= 0.05;
            const curHeadingDockClear = headingDiff <= 0.25;
            const travelH = Math.hypot(refWp.x - st.x, refWp.y - st.y) > 0.05
              ? Math.atan2(refWp.x - st.x, refWp.y - st.y)
              : kinRaw.heading;
            for (let i = 0; i < frameObstacles.length; i++) {
              const b = frameObstacles[i];
              if (!b) continue;
              const dDst = pointToObstacleDist(refWp.x, refWp.y, b);
              if ((b.kind === "stand" || b.kind === "liftTable") && dDst < AMR_HALF_W) {
                ignorePushoutId = b.id;
                break;
              } else if (dDst >= 0.391 && dDst < amrStandRadius && (isDepartingCloseWp || curHeadingAligned || (refWp.docking && curHeadingDockClear))) {
                const curPoseClear = isAmrPoseClear(kinRaw.x, kinRaw.y, kinRaw.heading, [b], 0.002);
                let dstPoseClear = false;
                if (Number.isFinite(refWp.heading)) {
                  dstPoseClear = isAmrPoseClear(refWp.x, refWp.y, refWp.heading, [b], 0.001);
                } else {
                  for (const hCand of [kinRaw.heading, travelH, 0, Math.PI * 0.5]) {
                    if (isAmrPoseClear(refWp.x, refWp.y, hCand, [b], 0.001)) {
                      dstPoseClear = true;
                      break;
                    }
                  }
                }
                if (curPoseClear && dstPoseClear) {
                  if (!seenOvIds.has(b.id)) {
                    seenOvIds.add(b.id);
                    closeOvs.push({ id: b.id, r: Math.min(amrStandRadius, Math.max(0.391, dDst - 0.003)) });
                  }
                } else if (b.kind === "stand" || b.kind === "liftTable") {
                  edgeStandRadius = Math.min(edgeStandRadius, Math.max(AMR_SPECS.hullRadiusM, dDst - 0.015));
                }
              } else if ((b.kind === "stand" || b.kind === "liftTable") && dDst < amrStandRadius) {
                edgeStandRadius = Math.min(edgeStandRadius, Math.max(AMR_SPECS.hullRadiusM, dDst - 0.015));
              }
            }
          }
          if (!ignorePushoutId && closeOvs.length > 0) {
            overrideObsId = closeOvs[0].id;
            overrideObsR = closeOvs[0].r;
            if (closeOvs.length > 1) extraOverrides = closeOvs.slice(1);
          }
        }
      }
    } else if (!item && !ignorePushoutId) {
      const parkedOvs = [];
      const idlePushR = AMR_SPECS.hullRadiusM + 0.002;
      for (let i = 0; i < frameObstacles.length; i++) {
        const b = frameObstacles[i];
        if (!b) continue;
        const dCur = pointToObstacleDist(kinRaw.x, kinRaw.y, b);
        if (dCur >= 0.391 && dCur < idlePushR && isAmrPoseClear(kinRaw.x, kinRaw.y, kinRaw.heading, [b], 0.001)) {
          parkedOvs.push({ id: b.id, r: Math.max(0.391, dCur - 0.001) });
        }
      }
      if (parkedOvs.length > 0) {
        overrideObsId = parkedOvs[0].id;
        overrideObsR = parkedOvs[0].r;
        if (parkedOvs.length > 1) extraOverrides = parkedOvs.slice(1);
      }
    }
    let effectiveStandRadius = item ? edgeStandRadius : 0;
    const amrPushRadius = item && !ignorePushoutId ? edgeStandRadius : (AMR_SPECS.hullRadiusM + 0.002);
    let pushOut;
    if (extraOverrides && extraOverrides.length > 0) {
      const extraMap = new Map();
      for (let i = 0; i < extraOverrides.length; i++) extraMap.set(extraOverrides[i].id, extraOverrides[i].r);
      const baseObs = frameObstacles.filter((b) => b && !extraMap.has(b.id));
      const extraObsList = frameObstacles.filter((b) => b && extraMap.has(b.id));
      let px = kinRaw.x;
      let py = kinRaw.y;
      let hitAny = false;
      let hitBoxAny = null;
      for (let pass = 0; pass < 2; pass++) {
        const pBase = resolveStaticObstaclePushout(
          px, py, amrPushRadius, baseObs, ignorePushoutId, effectiveStandRadius, overrideObsId, overrideObsR,
        );
        if (pBase.hit) { px = pBase.x; py = pBase.y; hitAny = true; if (!hitBoxAny) hitBoxAny = pBase.hitBox; }
        for (let ei = 0; ei < extraObsList.length; ei++) {
          const eb = extraObsList[ei];
          const er = extraMap.get(eb.id);
          const pEx = resolveStaticObstaclePushout(px, py, er, [eb], ignorePushoutId, er);
          if (pEx.hit) { px = pEx.x; py = pEx.y; hitAny = true; if (!hitBoxAny) hitBoxAny = pEx.hitBox; }
        }
      }
      pushOut = { x: px, y: py, hit: hitAny, hitBox: hitBoxAny };
    } else {
      pushOut = resolveStaticObstaclePushout(
        kinRaw.x,
        kinRaw.y,
        amrPushRadius,
        frameObstacles,
        ignorePushoutId,
        effectiveStandRadius,
        overrideObsId,
        overrideObsR,
      );
    }
    const kinPushed = pushOut.hit ? { ...kinRaw, x: pushOut.x, y: pushOut.y } : kinRaw;
    let kinGuard = kinPushed;
    if (
      st.carriedWcid &&
      item &&
      (item.phase === "drive" || item.phase === "route" || item.phase === "final_approach" || item.phase === "depart_pull") &&
      (kinPushed.x !== st.x || kinPushed.y !== st.y || wrapPi(kinPushed.heading - st.heading) !== 0 || wrapPi(kinPushed.turntableYawRad - st.turntableYawRad) !== 0)
    ) {
      const ovIds = new Set();
      if (overrideObsId != null) ovIds.add(overrideObsId);
      if (Array.isArray(extraOverrides)) {
        for (let ei = 0; ei < extraOverrides.length; ei++) ovIds.add(extraOverrides[ei].id);
      }
      let hitAmrPal = false;
      for (let oi = 0; oi < frameObstacles.length; oi++) {
        const b = frameObstacles[oi];
        if (!b || ovIds.has(b.id) || (ignorePushoutId != null && (b.id === ignorePushoutId || (typeof ignorePushoutId === "number" && typeof b.id === "number" && (b.id >>> 0) === (ignorePushoutId >>> 0))))) continue;
        if (
          isAmrPoseClear(st.x, st.y, st.heading, [b], 0.0, ignorePushoutId, st.carriedWcid, st.turntableYawRad, st.liftHeightM) &&
          !isAmrPoseClear(kinPushed.x, kinPushed.y, kinPushed.heading, [b], 0.0, ignorePushoutId, st.carriedWcid, kinPushed.turntableYawRad, kinPushed.liftHeightM)
        ) {
          hitAmrPal = true;
          break;
        }
      }
      if (hitAmrPal) {
        if (
          (kinPushed.x !== st.x || kinPushed.y !== st.y) &&
          isAmrPoseClear(kinPushed.x, kinPushed.y, st.heading, frameObstacles, 0.0, ignorePushoutId, st.carriedWcid, st.turntableYawRad, kinPushed.liftHeightM)
        ) {
          kinGuard = {
            ...kinPushed,
            heading: st.heading,
            turntableYawRad: st.turntableYawRad,
            omega: 0,
          };
        } else {
          kinGuard = {
            ...kinPushed,
            x: st.x,
            y: st.y,
            heading: st.heading,
            turntableYawRad: st.turntableYawRad,
            speed: 0,
            omega: 0,
            arrived: false,
            yieldStopped: true,
            statusMode: "blocked",
          };
        }
      }
    }
    const kin = enforceMinSeparation(st, AMR_SPECS.hullRadiusM, kinGuard, false);

    st.x = kin.x;
    st.y = kin.y;
    st.heading = kin.heading;
    st.speed = kin.speed;
    st.omega = kin.omega;
    st.liftHeightM = kin.liftHeightM;
    st.turntableYawRad = kin.turntableYawRad;
    st.heldCargoHeading = kin.heldCargoHeading;
    st.wheelSpinL = kin.wheelSpinL;
    st.wheelSpinR = kin.wheelSpinR;
    st.statusMode = kin.statusMode;
    st.yieldStopped = kin.yieldStopped;
    st.yieldSlowed = kin.yieldSlowed;
    if (item?.data && Array.isArray(cmd.waypoints)) {
      let wpIdx = kin.waypointIndex;
      while (wpIdx < cmd.waypoints.length - 1) {
        const wp = cmd.waypoints[wpIdx];
        if (wp?._stopAtWaypoint) break;
        const skipTol = Number.isFinite(wp?.skipTol) ? wp.skipTol : (wp?.speedLimit ? 0.50 : 1.25);
        if (wp && Math.hypot(wp.x - st.x, wp.y - st.y) <= skipTol && !wp.docking) {
          wpIdx++;
        } else {
          break;
        }
      }
      item.data.waypointIndex = wpIdx;
      maybeInsertCornerBypass(st, item, cmd, wpIdx, pushOut, AMR_SPECS.hullRadiusM, frameObstacles);
    }

    grid.claim(st.agentId, { x: st.x, y: st.y, heading: st.heading, radius: AMR_SPECS.hullRadiusM, kind: "amr" });

    if (item) {
      const t = item.task;
      const d = item.data;

      if (d.deadlockPull) {
        const rem = Math.hypot(d.deadlockPull.x - st.x, d.deadlockPull.y - st.y);
        d.deadlockPull._blockedSec = st.yieldStopped ? (d.deadlockPull._blockedSec || 0) + dt : 0;
        if (rem <= 0.08 || d.deadlockPull._blockedSec > 0.45) {
          d.deadlockPull = null;
          st.speed = 0;
        }
      } else if (item.phase === "depart_pull" && d.departPull) {
        const dp = d.departPull;
        const rem = Math.hypot(dp.x - st.x, dp.y - st.y);
        const departObsId = d.departIgnorePushoutId ?? dp.obsId;
        const departObs = departObsId != null ? frameObstacles.find((b) => b && b.id === departObsId) : null;
        const clearObsNow = !departObs || pointToObstacleDist(st.x, st.y, departObs) >= amrObsClearR(departObs, AMR_STAND_RADIUS + 0.07, st.carriedWcid, st.liftHeightM);
        const clearNow = minDistanceToObstacles(st.x, st.y, frameObstacles) >= AMR_STAND_RADIUS + 0.07 &&
          !(st.carriedWcid && amrHasCloseObs(st.x, st.y, frameObstacles, AMR_STAND_RADIUS + 0.07, st.carriedWcid, st.liftHeightM, departObsId));
        const pullDone = t.type === "driveTo"
          ? (clearNow && clearObsNow)
          : ((clearNow && clearObsNow && rem <= 0.12) || (rem <= 0.04 && clearObsNow));
        if (pullDone) {
          st.speed = 0;
          d.departIgnorePushoutId = null;
          if (t.type === "driveTo") {
            item.phase = "drive";
            if (d.finalApproach && d.waypoints.length <= 1) {
              item.data.waypoints = routeAmrAroundSolidObstacles(
                st,
                [{ x: d.finalApproach.preX, y: d.finalApproach.preY, heading: d.finalApproach.heading }],
                AMR_SPECS.hullRadiusM,
                frameObstacles,
                { selfLoaded: Boolean(st.carriedWcid) },
              );
            } else if (d.waypoints.length >= 1) {
              item.data.waypoints = routeAmrAroundSolidObstacles(
                st,
                d.waypoints,
                AMR_SPECS.hullRadiusM,
                frameObstacles,
                { selfLoaded: Boolean(st.carriedWcid) },
              );
            }
            item.data.waypointIndex = 0;
          } else {
            item.phase = "route";
            item.data.waypointIndex = 0;
          }
        }
      } else if (t.type === "driveTo") {
        if (item.phase === "drive" && isPreAlignStep) {
          if (kin.arrived && preAlignWp) {
            preAlignWp._aligned = true;
          }
        } else if (item.phase === "drive" && kin.arrived) {
          if (d.finalApproach) {
            item.phase = "final_approach";
          } else {
            st.speed = 0;
            st.omega = 0;
            st._parkedRawCtrIds = d.useRawContainerIds || null;
            entry.queue.shift();
            item.resolve(entry.handle);
          }
        } else if (item.phase === "final_approach" && ((kin.arrived && Math.hypot(d.finalApproach.dstX - st.x, d.finalApproach.dstY - st.y) <= AMR_SPECS.dockPosTolM) || (
          d.finalApproach?.reverseSlide &&
          Math.hypot(d.finalApproach.dstX - st.x, d.finalApproach.dstY - st.y) <= AMR_SPECS.dockPosTolM &&
          Math.abs(wrapPi(d.finalApproach.heading - st.heading)) <= AMR_SPECS.dockYawTolRad
        ))) {
          st.speed = 0;
          st.omega = 0;
          st._parkedRawCtrIds = d.finalApproach?.useRawContainerIds || null;
          entry.queue.shift();
          item.resolve(entry.handle);
        }
      } else if (t.type === "pickFromStand" || t.type === "placeOnStand") {
        const isPick = t.type === "pickFromStand";
        const preLift = isPick ? AMR_SPECS.loweredHeightM : AMR_SPECS.raisedHeightM;
        const postLift = isPick ? AMR_SPECS.raisedHeightM : AMR_SPECS.loweredHeightM;
        const minRaisedH = LIFT_TABLE_SPECS.raisedZ - LIFT_TABLE_SPECS.raisedToleranceM;

        if (d.target.kind === "liftTable" && (item.phase === "route" || item.phase === "prepare_lift" || item.phase === "enter")) {
          const ltHandle = d.target.handle;
          const ltTargetH = ltHandle._state?.targetHeightM ?? ltHandle.heightM;
          const ltInterlocked = Boolean(ltHandle._state?.interlockBlocked);
          const physicallyLowered = ltHandle.heightM < minRaisedH;
          const halfD = LIFT_TABLE_SPECS.outerDepthM * 0.5;
          const loweringBeforeEntry = (
            item.phase === "route" ||
            item.phase === "prepare_lift" ||
            (!ltInterlocked && Math.hypot(st.x - ltHandle.x, st.y - ltHandle.y) >= halfD + AMR_HALF_L + 0.05)
          ) && ltTargetH < minRaisedH;
          if (physicallyLowered || loweringBeforeEntry) {
            st.speed = 0;
            st.omega = 0;
            entry.queue.shift();
            item.reject(new Error(`Lift table ${t.standId} is not raised (${ltHandle.heightM.toFixed(3)} m)`));
            return;
          }
        }

        if (item.phase === "route" && kin.arrived) {
          item.phase = "prepare_lift";
        } else if (item.phase === "prepare_lift" && Math.abs(st.liftHeightM - preLift) <= 0.002) {
          item.phase = "enter";
        } else if (item.phase === "enter" && kin.arrived) {
          if (d.target.kind === "liftTable" && d.target.handle.heightM < minRaisedH) {
            st.speed = 0;
            st.omega = 0;
            entry.queue.shift();
            item.reject(new Error(`Lift table ${t.standId} is not raised (${d.target.handle.heightM.toFixed(3)} m)`));
            return;
          }
          if (isPick) {
            const wcid = d.target.handle.carriedWcid;
            if (!wcid) {
              d.abortReason = `Stand ${t.standId} became empty`;
              item.phase = "abort_exit";
              return;
            }
            d.target.handle.setCargoWcid(0);
            st.carriedWcid = wcid;
            st.loaded = true;
          } else {
            if (d.target.handle.carriedWcid !== 0) {
              d.abortReason = `Stand ${t.standId} became occupied`;
              item.phase = "abort_exit";
              return;
            }
            d.target.handle.setCargoWcid(st.carriedWcid);
            st.carriedWcid = 0;
            st.loaded = false;
          }
          item.phase = "actuate";
        } else if (item.phase === "actuate" && Math.abs(st.liftHeightM - postLift) <= 0.002) {
          item.phase = "exit";
        } else if (item.phase === "exit" && Math.hypot(d.exitPose.x - st.x, d.exitPose.y - st.y) <= 0.025) {
          st.speed = 0;
          st.omega = 0;
          entry.queue.shift();
          item.resolve(entry.handle);
        } else if (item.phase === "abort_exit" && Math.hypot(d.exitPose.x - st.x, d.exitPose.y - st.y) <= 0.025) {
          st.speed = 0;
          st.omega = 0;
          entry.queue.shift();
          item.reject(new Error(d.abortReason || `Stand ${t.standId} unavailable`));
        }
      } else if (t.type === "dockCharge") {
        if (item.phase === "route" && kin.arrived) {
          st.speed = 0;
          st.omega = 0;
          st.charging = true;
          st.statusMode = "charging";
          st.dockedChargerId = d.ch.id;
          d.ch.setDockState("charging");
          entry.queue.shift();
          item.resolve(entry.handle);
        }
      }
    }

    if (entry.model) {
      entry.model.root.position.set(st.x, st.y, st.z);
      entry.model.root.rotation.z = -st.heading;
      entry.model.update({
        liftHeightM: st.liftHeightM,
        turntableYawRad: st.turntableYawRad,
        wheelSpinL: st.wheelSpinL,
        wheelSpinR: st.wheelSpinR,
        statusMode: st.statusMode,
        carriedWcid: st.carriedWcid,
      });
    }

    if (logisticsAudio) {
      try {
        const moving = Math.abs(st.speed) > 0.05 || Math.abs(st.omega) > 0.05;
        logisticsAudio.updateAgvHum?.(entry.id, { active: moving, speed: Math.abs(st.speed), pos: [st.x, st.y, st.z] });
        if (st.statusMode === "yield" && st.prevStatusMode !== "yield") {
          logisticsAudio.safetyChime?.({ pos: [st.x, st.y, st.z] });
        }
      } catch (_) {}
    }
    st._idleSec = entry.queue.length === 0 && Math.abs(st.speed) < 0.02 ? (st._idleSec || 0) + dt : 0;
    st.prevStatusMode = st.statusMode;
  }

  function collectActivePalletJacksList() {
    const out = [];
    const seen = new Set();
    if (playerJackPose && Number.isFinite(playerJackPose.x) && Number.isFinite(playerJackPose.y)) {
      out.push(playerJackPose);
      seen.add(playerJackPose.id);
    }
    for (const pj of palletJacks.values()) {
      if (!pj || seen.has(pj.guid)) continue;
      const p = pj.model?.root?.position;
      const x = p ? p.x : pj.worldPos?.[0];
      const y = p ? p.y : pj.worldPos?.[1];
      if (Number.isFinite(x) && Number.isFinite(y)) {
        out.push({ id: pj.guid, x, y, heading: finiteOr(pj.heading, 0) });
      }
    }
    return out;
  }

  function stepLiftTables(dt) {
    const amrList = [];
    for (const a of amrEntries.values()) {
      amrList.push({ x: a.state.x, y: a.state.y, heading: a.state.heading });
    }
    const jackList = collectActivePalletJacksList();
    const ltHalfW = LIFT_TABLE_SPECS.outerWidthM * 0.5;
    const ltHalfD = LIFT_TABLE_SPECS.outerDepthM * 0.5;
    const agfProbePts = [
      [-0.34, AGF_SPECS.forkTipY],
      [0.0, AGF_SPECS.forkTipY],
      [0.34, AGF_SPECS.forkTipY],
      [-0.34, AGF_SPECS.cargoCenterY],
      [0.0, AGF_SPECS.cargoCenterY],
      [0.34, AGF_SPECS.cargoCenterY],
      [-0.57, AGF_SPECS.frontChassisY],
      [0.57, AGF_SPECS.frontChassisY],
    ];

    for (const lt of liftTables.values()) {
      const st = lt._state;
      let agfOnTable = false;
      for (const a of agfEntries.values()) {
        const active = a.queue?.[0];
        if (
          active &&
          (active.task?.type === "placeOnStand" || active.task?.type === "pickFromStand") &&
          active.data?.target?.kind === "liftTable" &&
          active.data?.target?.handle?.id === lt.id &&
          (active.phase === "insert" || active.phase === "actuate" || active.phase === "retract" || active.phase === "abort_retract")
        ) {
          agfOnTable = true;
          break;
        }
        const ast = a.state;
        for (let pi = 0; pi < agfProbePts.length; pi++) {
          const [wx, wy] = localToWorld2D(agfProbePts[pi][0], agfProbePts[pi][1], ast.x, ast.y, ast.heading);
          const loc = worldToLocalPoint(wx, wy, lt.x, lt.y, lt.heading);
          if (Math.abs(loc.x) < ltHalfW && Math.abs(loc.y) < ltHalfD) {
            agfOnTable = true;
            break;
          }
        }
        if (agfOnTable) break;
      }

      let cmd = { targetHeightM: st.targetHeightM };

      if (st.autoMode && !st.pending) {
        if (st.carriedWcid !== 0 && st.heightM < LIFT_TABLE_SPECS.raisedZ - 0.005) {
          cmd = "raise";
        } else if (st.carriedWcid === 0 && st.heightM > 0.005) {
          cmd = "lower";
        }
      }

      const desiredTargetH = cmd === "raise"
        ? LIFT_TABLE_SPECS.raisedZ
        : cmd === "lower"
          ? LIFT_TABLE_SPECS.loweredZ
          : clamp(finiteOr(cmd.targetHeightM, st.heightM), LIFT_TABLE_SPECS.loweredZ, LIFT_TABLE_SPECS.raisedZ);
      const agfBlockedMove = agfOnTable && Math.abs(desiredTargetH - st.heightM) > 1e-5;

      const next = stepLiftTable(
        st,
        agfBlockedMove ? { targetHeightM: st.heightM } : cmd,
        dt,
        {
          amrs: amrList,
          palletJacks: jackList,
        },
      );

      st.heightM = next.heightM;
      st.targetHeightM = agfBlockedMove ? desiredTargetH : next.targetHeightM;
      st.moving = agfBlockedMove ? false : next.moving;
      st.interlockBlocked = agfBlockedMove ? true : next.interlockBlocked;
      st.interlockReason = agfBlockedMove ? "agf_forks_on_deck" : next.interlockReason;
      st.statusMode = st.interlockBlocked
        ? "blocked"
        : st.moving
          ? "lifting"
          : (st.heightM >= LIFT_TABLE_SPECS.raisedZ - 0.005 ? "ready" : "idle");

      lt.model?.update?.({
        heightM: st.heightM,
        carriedWcid: st.carriedWcid,
        highlightState: st.highlightState,
        statusMode: st.statusMode,
      });

      if (st.pending) {
        const p = st.pending;
        if (Math.abs(st.heightM - p.targetH) <= 0.005) {
          st.pending = null;
          p.resolve(lt);
        } else if (st.interlockBlocked && !st.autoMode) {
          // In manual mode, wait for interlock to clear unless overridden; in autoMode, keep waiting
        }
      }
    }
  }

  function stepScenario(dt) {
    if (!activeScenario || activeScenario.stopped) return;
    const sc = activeScenario;
    if (sc.name === "full-intermodal-loop") {
      for (const a of agfEntries.values()) {
        if (a.queue.length === 0) {
          const s = a.state;
          if (s.carriedWcid) {
            const freeStand = [...stands.values()].find((st) => st.carriedWcid === 0);
            if (freeStand) {
              a.handle.enqueue({ type: "placeOnStand", standId: freeStand.id }).catch(() => {});
            }
          } else {
            const ox = layout.origin[0];
            const oy = layout.origin[1];
            const tgt = sc.state.toggle ? [ox - 10, oy + 18] : [ox + 6, oy + 18];
            sc.state.toggle = !sc.state.toggle;
            a.handle.enqueue({ type: "driveTo", waypoints: [tgt] }).catch(() => {});
          }
        }
      }
      for (const m of amrEntries.values()) {
        if (m.queue.length === 0) {
          const ox = layout.origin[0];
          const oy = layout.origin[1];
          const idx = sc.state.amrIdx++ % 8;
          const tgtX = ox - 14 + idx * 4;
          const tgtY = (idx % 2 === 0) ? oy - 29 : oy - 31.5;
          m.handle.enqueue({ type: "driveTo", waypoints: [[tgtX, tgtY]] }).catch(() => {});
        }
      }
    } else if (sc.name === "scale-stress") {
      for (const a of agfEntries.values()) {
        if (a.queue.length === 0) {
          const ox = layout.origin[0];
          const oy = layout.origin[1];
          const idx = sc.state.agfTick++ % 3;
          const aisleY = oy + (idx === 0 ? 3.0 : idx === 1 ? -3.0 : -9.0);
          const endX = (sc.state.agfTick % 2 === 0) ? ox - 18 : ox + 8;
          a.handle.enqueue({ type: "driveTo", waypoints: [[endX, aisleY]] }).catch(() => {});
        }
      }
      for (const m of amrEntries.values()) {
        if (m.queue.length === 0) {
          const ox = layout.origin[0];
          const oy = layout.origin[1];
          const idx = sc.state.amrTick++ % 16;
          const tx = ox - 20 + (idx % 8) * 5;
          const ty = oy - 26 - Math.floor(idx / 8) * 6;
          m.handle.enqueue({ type: "driveTo", waypoints: [[tx, ty]] }).catch(() => {});
        }
      }
    }
  }

  function tick(dt = 1 / 60, cameraPos = null) {
    if (disposed || !built) return;
    if (!Number.isFinite(dt) || dt <= 0) return;
    const stepDt = Math.min(dt, 0.1);
    simTimeSec += stepDt;
    tickCount++;

    stepScenario(stepDt);
    stepLiftTables(stepDt);

    const frameObstacles = getStaticObstacles();
    for (const entry of agfEntries.values()) {
      stepAgfEntry(entry, stepDt, frameObstacles);
    }
    for (const entry of amrEntries.values()) {
      stepAmrEntry(entry, stepDt, frameObstacles);
    }

    if (cameraPos !== null && cameraPos !== undefined) {
      for (const row of racks.values()) {
        try { row.setCargoLodDistance?.(cameraPos); } catch (_) {}
      }
    }
  }

  function runScenario(name, options = {}) {
    if (disposed) return Promise.reject(new Error("WarehouseManager disposed"));
    if (name !== "full-intermodal-loop" && name !== "scale-stress") {
      return Promise.reject(new Error(`Unknown scenario: ${name}`));
    }
    stopScenarios();
    if (!built) buildHub(options);

    const [ox, oy] = layout.origin;

    if (name === "full-intermodal-loop") {
      for (let i = 0; i < 4; i++) {
        spawnAgf(`loop-agf-${i + 1}`, {
          pos: [ox - 18 + i * 10, oy + 20, 0],
          heading: 0,
        });
      }
      for (let i = 0; i < 8; i++) {
        spawnAmr(`loop-amr-${i + 1}`, {
          pos: [ox - 16 + i * 4.5, oy - 29, 0],
          heading: Math.PI * 0.5,
        });
      }
    } else if (name === "scale-stress") {
      // Populate >= 256 racked pallets
      let loaded = 0;
      for (const row of racks.values()) {
        const sides = row.doubleSided ? 2 : 1;
        for (let b = 0; b < row.bayCount && loaded < 256; b++) {
          for (let t = 0; t < 4 && loaded < 256; t++) {
            for (let s = 0; s < sides && loaded < 256; s++) {
              for (let sl = 0; sl < 2 && loaded < 256; sl++) {
                const key = `${s}:${b}:${t}:${sl}`;
                if (!row.loadedSlots.has(key)) {
                  row.loadSlot(b, t, s, sl, ALL_CARGO_WCIDS[loaded % ALL_CARGO_WCIDS.length]);
                }
                loaded++;
              }
            }
          }
        }
      }
      for (let i = 0; i < 8; i++) {
        const aisleIdx = i % 3;
        const aisleY = oy + (aisleIdx === 0 ? 3.0 : aisleIdx === 1 ? -3.0 : -9.0);
        const xOff = -16 + Math.floor(i / 3) * 10;
        spawnAgf(`stress-agf-${i + 1}`, {
          pos: [ox + xOff, aisleY, 0],
          heading: i % 2 === 0 ? Math.PI * 0.5 : -Math.PI * 0.5,
        });
      }
      for (let i = 0; i < 16; i++) {
        const row = Math.floor(i / 8);
        const col = i % 8;
        spawnAmr(`stress-amr-${i + 1}`, {
          pos: [ox - 20 + col * 5.2, oy - 27 - row * 4.0, 0],
          heading: Math.PI * 0.5,
        });
      }
    }

    let resFn = null;
    let rejFn = null;
    const promise = new Promise((resolve, reject) => {
      resFn = resolve;
      rejFn = reject;
    });
    activeScenario = {
      name,
      stopped: false,
      resolve: resFn,
      reject: rejFn,
      promise,
      state: { toggle: false, amrIdx: 0, agfTick: 0, amrTick: 0 },
    };
    return promise;
  }

  function stopScenarios() {
    if (!activeScenario) return;
    const sc = activeScenario;
    activeScenario = null;
    sc.stopped = true;
    for (const a of agfEntries.values()) {
      rejectPendingList(a.queue, "Scenario stopped");
    }
    for (const m of amrEntries.values()) {
      rejectPendingList(m.queue, "Scenario stopped");
    }
    try { sc.resolve({ stopped: true, name: sc.name }); } catch (_) {}
  }

  function getObstacleBoxes() {
    if (!built) return [];
    const boxes = [];
    for (const r of racks.values()) {
      const b = r.worldBounds;
      if (b) boxes.push({ x0: b.minX, x1: b.maxX, y0: b.minY, y1: b.maxY, kind: "rack", id: r.id });
    }
    // P&D stand side rails (two rails leaving central AMR underride tunnel open, blocking jack forks/body)
    for (const st of stands.values()) {
      const hw = STAND_SPECS.outerWidthM * 0.5;
      const hd = STAND_SPECS.outerDepthM * 0.5;
      const railW = (STAND_SPECS.outerWidthM - STAND_SPECS.tunnelWidthM) * 0.5;
      const [cx, cy] = st.pos;
      if (Math.abs(Math.sin(st.heading)) > 0.7) {
        boxes.push({ x0: cx - hd, x1: cx + hd, y0: cy - hw, y1: cy - hw + railW, kind: "standRail", id: `${st.id}_L` });
        boxes.push({ x0: cx - hd, x1: cx + hd, y0: cy + hw - railW, y1: cy + hw, kind: "standRail", id: `${st.id}_R` });
      } else {
        boxes.push({ x0: cx - hw, x1: cx - hw + railW, y0: cy - hd, y1: cy + hd, kind: "standRail", id: `${st.id}_L` });
        boxes.push({ x0: cx + hw - railW, x1: cx + hw, y0: cy - hd, y1: cy + hd, kind: "standRail", id: `${st.id}_R` });
      }
    }
    // Raised lift tables block pallet jack entry
    for (const lt of liftTables.values()) {
      if (lt.heightM > LIFT_TABLE_SPECS.loweredToleranceM) {
        const hw = LIFT_TABLE_SPECS.outerWidthM * 0.5;
        const hd = LIFT_TABLE_SPECS.outerDepthM * 0.5;
        boxes.push({ x0: lt.x - hw, x1: lt.x + hw, y0: lt.y - hd, y1: lt.y + hd, kind: "liftTable", id: lt.id });
      }
    }
    // Charger cabinets
    for (const ch of chargers.values()) {
      const cw = finiteOr(CHARGER_SPECS.widthM, 1.24);
      const cd = finiteOr(CHARGER_SPECS.depthM, 0.90);
      boxes.push({
        x0: ch.pos[0] - cw * 0.5,
        x1: ch.pos[0] + cw * 0.5,
        y0: ch.pos[1] - cd * 0.5,
        y1: ch.pos[1] + cd * 0.5,
        kind: "charger",
        id: ch.id,
      });
    }
    return boxes;
  }

  function findLoweredLiftTableTarget(jackPose, opts = {}) {
    if (!built || !jackPose) return null;
    const targets = [];
    for (const lt of liftTables.values()) {
      if (lt.heightM > LIFT_TABLE_SPECS.loweredToleranceM) continue;
      if (opts.forDrop && lt.carriedWcid !== 0) continue;
      if (opts.forPick && lt.carriedWcid === 0) continue;
      targets.push({
        id: lt.id,
        kind: "liftTable",
        x: lt.x,
        y: lt.y,
        z: lt.z,
        heading: lt.heading,
        heightM: lt.heightM,
        carriedWcid: lt.carriedWcid,
        fourWay: true,
        reachable: true,
      });
    }
    if (targets.length === 0) return null;
    const match = findNearestForkEngageTarget(jackPose, targets, {
      forkOffset: opts.forkOffset ?? PALLET_JACK_SPECS.cargoCenterY,
      maxDist: opts.maxDist ?? PALLET_JACK_SPECS.assistMaxDistM,
      maxYawRad: opts.maxYawRad ?? PALLET_JACK_SPECS.assistMaxYawRad,
      fourWay: true,
      includeBlocked: Boolean(opts.includeBlocked),
    });
    if (!match) return null;
    return {
      ...match,
      id: match.target.id,
      kind: "liftTable",
      carriedWcid: match.target.carriedWcid,
      heightM: match.target.heightM,
    };
  }

  function findStagingBayTarget(jackPose, opts = {}) {
    if (!built || !jackPose) return null;
    const targets = [];
    for (const sb of stagingBays.values()) {
      if (opts.forDrop && sb.occupied) continue;
      if (opts.forPick && !sb.occupied) continue;
      targets.push({
        id: sb.id,
        kind: "stagingBay",
        x: sb.x,
        y: sb.y,
        z: sb.z,
        heading: sb.heading,
        occupied: sb.occupied,
        carriedWcid: sb.carriedWcid,
        fourWay: true,
        reachable: true,
      });
    }
    if (targets.length === 0) return null;
    const match = findNearestForkEngageTarget(jackPose, targets, {
      forkOffset: opts.forkOffset ?? PALLET_JACK_SPECS.cargoCenterY,
      maxDist: opts.maxDist ?? PALLET_JACK_SPECS.assistMaxDistM,
      maxYawRad: opts.maxYawRad ?? PALLET_JACK_SPECS.assistMaxYawRad,
      fourWay: true,
      includeBlocked: Boolean(opts.includeBlocked),
    });
    if (!match) return null;
    return {
      ...match,
      id: match.target.id,
      kind: "stagingBay",
      occupied: match.target.occupied,
      carriedWcid: match.target.carriedWcid,
    };
  }

  function updateJackHighlight(jackState) {
    if (!built || !jackState) {
      clearHighlights();
      return;
    }
    const carrying = Boolean(jackState.carriedWcid);
    const ltHit = findLoweredLiftTableTarget(jackState, {
      forDrop: carrying,
      forPick: !carrying,
    });
    if (ltHit) {
      if (highlightedStagingBayId) {
        setStagingBayHighlighted(highlightedStagingBayId, null);
        highlightedStagingBayId = null;
      }
      if (highlightedLiftTableId && highlightedLiftTableId !== ltHit.id) {
        liftTables.get(highlightedLiftTableId)?.setHighlighted?.(null);
      }
      highlightedLiftTableId = ltHit.id;
      liftTables.get(ltHit.id)?.setHighlighted?.(ltHit.canEngage ? "target" : "reachable");
      return;
    }

    const sbHit = findStagingBayTarget(jackState, {
      forDrop: carrying,
      forPick: !carrying,
    });
    if (sbHit) {
      if (highlightedLiftTableId) {
        liftTables.get(highlightedLiftTableId)?.setHighlighted?.(null);
        highlightedLiftTableId = null;
      }
      if (highlightedStagingBayId && highlightedStagingBayId !== sbHit.id) {
        setStagingBayHighlighted(highlightedStagingBayId, null);
      }
      highlightedStagingBayId = sbHit.id;
      setStagingBayHighlighted(sbHit.id, sbHit.canEngage ? "target" : "reachable");
      return;
    }

    clearHighlights();
  }

  function tryJackPick(jackState, jackEntry) {
    if (!built || !jackState || jackState.carriedWcid) return false;
    const ltHit = findLoweredLiftTableTarget(jackState, { forPick: true });
    if (ltHit && ltHit.canEngage) {
      const lt = liftTables.get(ltHit.id);
      if (lt && lt.carriedWcid !== 0) {
        const wcid = lt.carriedWcid;
        lt.setCargoWcid(0);
        jackState.carriedWcid = wcid;
        jackState.carriedPalletSize = 2;
        jackState.loaded = true;
        jackState._localWarehouseCarryWcid = wcid;
        if (jackEntry) {
          jackEntry.carriedWcid = wcid;
          jackEntry.carriedPalletSize = 2;
          jackEntry._localWarehouseCarryWcid = wcid;
          jackEntry._localWarehouseDroppedWcid = 0;
        }
        clearHighlights();
        return true;
      }
    }
    const sbHit = findStagingBayTarget(jackState, { forPick: true });
    if (sbHit && sbHit.canEngage) {
      const sb = stagingBays.get(sbHit.id);
      if (sb && sb.occupied && sb.carriedWcid !== 0) {
        const wcid = sb.carriedWcid;
        setStagingBayCargo(sb.id, 0);
        jackState.carriedWcid = wcid;
        jackState.carriedPalletSize = 2;
        jackState.loaded = true;
        jackState._localWarehouseCarryWcid = wcid;
        if (jackEntry) {
          jackEntry.carriedWcid = wcid;
          jackEntry.carriedPalletSize = 2;
          jackEntry._localWarehouseCarryWcid = wcid;
          jackEntry._localWarehouseDroppedWcid = 0;
        }
        clearHighlights();
        return true;
      }
    }
    return false;
  }

  function tryJackDrop(jackState, jackEntry) {
    if (!built || !jackState || !jackState.carriedWcid) return false;
    const wcid = jackState.carriedWcid;
    const ltHit = findLoweredLiftTableTarget(jackState, { forDrop: true });
    if (ltHit && ltHit.canEngage) {
      const lt = liftTables.get(ltHit.id);
      if (lt && lt.carriedWcid === 0) {
        lt.setCargoWcid(wcid);
        jackState.carriedWcid = 0;
        jackState.carriedPalletSize = 0;
        jackState.loaded = false;
        jackState._localWarehouseCarryWcid = 0;
        if (jackEntry) {
          jackEntry.carriedWcid = 0;
          jackEntry.carriedPalletSize = 0;
          jackEntry._localWarehouseCarryWcid = 0;
        }
        clearHighlights();
        return true;
      }
    }
    const sbHit = findStagingBayTarget(jackState, { forDrop: true });
    if (sbHit && sbHit.canEngage) {
      const sb = stagingBays.get(sbHit.id);
      if (sb && !sb.occupied) {
        setStagingBayCargo(sb.id, wcid);
        jackState.carriedWcid = 0;
        jackState.carriedPalletSize = 0;
        jackState.loaded = false;
        jackState._localWarehouseCarryWcid = 0;
        if (jackEntry) {
          jackEntry.carriedWcid = 0;
          jackEntry.carriedPalletSize = 0;
          jackEntry._localWarehouseCarryWcid = 0;
        }
        clearHighlights();
        return true;
      }
    }
    return false;
  }

  function updatePlayerJackPose(pose) {
    if (pose && Number.isFinite(pose.x) && Number.isFinite(pose.y)) {
      playerJackPose = {
        id: pose.id ?? "player-jack",
        x: pose.x,
        y: pose.y,
        heading: finiteOr(pose.heading, 0),
      };
    } else {
      playerJackPose = null;
    }
  }

  function getState() {
    const rackState = {};
    for (const [id, r] of racks.entries()) {
      rackState[id] = {
        id,
        bayCount: r.bayCount,
        doubleSided: r.doubleSided,
        occupiedCount: r.loadedSlots.size,
      };
    }
    const standState = {};
    for (const [id, s] of stands.entries()) {
      standState[id] = {
        id,
        pos: [...s.pos],
        heading: s.heading,
        carriedWcid: s.carriedWcid,
      };
    }
    const liftState = {};
    for (const [id, l] of liftTables.entries()) {
      liftState[id] = {
        id,
        pos: [...l.pos],
        heightM: l.heightM,
        carriedWcid: l.carriedWcid,
        autoMode: l.autoMode,
        statusMode: l._state.statusMode,
        interlockBlocked: l._state.interlockBlocked,
      };
    }
    const chargerState = {};
    for (const [id, c] of chargers.entries()) {
      chargerState[id] = {
        id,
        pos: [...c.pos],
        mode: c.mode,
      };
    }
    const bayState = {};
    for (const [id, b] of stagingBays.entries()) {
      bayState[id] = {
        id,
        pos: [...b.pos],
        heading: b.heading,
        occupied: b.occupied,
        carriedWcid: b.carriedWcid,
      };
    }
    const agfState = {};
    for (const [id, a] of agfEntries.entries()) {
      const s = a.state;
      agfState[id] = {
        id,
        x: s.x,
        y: s.y,
        z: s.z,
        pos: [s.x, s.y, s.z],
        heading: s.heading,
        speed: s.speed,
        forkHeightM: s.forkHeightM,
        carriedWcid: s.carriedWcid,
        statusMode: s.statusMode,
        queueLength: a.queue.length,
      };
    }
    const amrState = {};
    for (const [id, m] of amrEntries.entries()) {
      const s = m.state;
      amrState[id] = {
        id,
        x: s.x,
        y: s.y,
        z: s.z,
        pos: [s.x, s.y, s.z],
        heading: s.heading,
        speed: s.speed,
        liftHeightM: s.liftHeightM,
        turntableYawRad: s.turntableYawRad,
        carriedWcid: s.carriedWcid,
        statusMode: s.statusMode,
        queueLength: m.queue.length,
      };
    }

    return {
      built,
      disposed,
      origin: layout ? [...layout.origin] : null,
      simTimeSec,
      tickCount,
      scenario: activeScenario ? activeScenario.name : null,
      racks: rackState,
      stands: standState,
      liftTables: liftState,
      chargers: chargerState,
      stagingBays: bayState,
      agfs: agfState,
      amrs: amrState,
    };
  }

  function dispose() {
    if (disposed) return;
    clearHub();
    disposed = true;
    playerJackPose = null;
  }

  return {
    buildHub,
    clearHub,
    spawnAgf,
    spawnAmr,
    agfs,
    amrs,
    racks,
    stands,
    liftTables,
    chargers,
    runScenario,
    stopScenarios,
    getState,
    get stats() {
      let rackedSlots = 0;
      for (const r of racks.values()) rackedSlots += r.loadedSlots.size;
      return {
        built,
        disposed,
        simTimeSec,
        tickCount,
        agfCount: agfs.size,
        amrCount: amrs.size,
        rackCount: racks.size,
        rackedSlots,
        standCount: stands.size,
        liftTableCount: liftTables.size,
        chargerCount: chargers.size,
        stagingBayCount: stagingBays.size,
        reservation: grid.getStats(),
        scenario: activeScenario ? activeScenario.name : null,
      };
    },
    getObstacleBoxes,
    findLoweredLiftTableTarget,
    findStagingBayTarget,
    updateJackHighlight,
    tryJackPick,
    tryJackDrop,
    clearHighlights,
    updatePlayerJackPose,
    setStagingBayCargo,
    tick,
    dispose,
  };
}
