/**
 * Pure deterministic kinematic & safety-interlock engine for the Intermodal
 * Automated Warehouse Hub (AGF 3-stage freelift mast & rear-steer Ackermann,
 * Underride AMR diff-drive & independent turntable, Scissor Lift Table
 * interlocks, and 2D SpatialReservationGrid).
 *
 * 1:1 parity contract for future ACE C# promotion.
 * Imports ONLY `./warehouse_specs.js` and `./container_logistics.js`.
 */

import {
  AGF_SPECS,
  AMR_SPECS,
  LIFT_TABLE_SPECS,
  CONTAINER_ENVELOPE_SPECS,
} from "./warehouse_specs.js";
import {
  resolveContainerLogisticsSpec,
  isSlotReachableForUnload,
  isSlotReachableForLoad,
} from "./container_logistics.js";

const TAU = Math.PI * 2.0;
const RAD_PER_DEG = Math.PI / 180.0;

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function finiteOr(v, fallback) {
  return Number.isFinite(v) ? v : fallback;
}

function moveToward(cur, target, maxDelta) {
  if (!Number.isFinite(maxDelta) || maxDelta <= 0.0) {
    return cur;
  }
  const diff = target - cur;
  if (Math.abs(diff) <= maxDelta) {
    return target;
  }
  return cur + Math.sign(diff) * maxDelta;
}

export function wrapHeading(h) {
  if (!Number.isFinite(h)) {
    return 0.0;
  }
  let a = h % TAU;
  if (a < 0.0) {
    a += TAU;
  }
  if (a >= TAU) {
    a -= TAU;
  }
  return a;
}

export function wrapPi(a) {
  if (!Number.isFinite(a)) {
    return 0.0;
  }
  let d = a - TAU * Math.floor((a + Math.PI) / TAU);
  if (d > Math.PI) {
    d -= TAU;
  }
  if (d < -Math.PI) {
    d += TAU;
  }
  return d;
}

export function worldToLocal2D(wx, wy, ox = 0.0, oy = 0.0, heading = 0.0) {
  const dx = wx - ox;
  const dy = wy - oy;
  const h = Number.isFinite(heading) ? heading : 0.0;
  const c = Math.cos(h);
  const s = Math.sin(h);
  return {
    x: dx * c - dy * s,
    y: dx * s + dy * c,
  };
}

export function localToWorld2D(lx, ly, ox = 0.0, oy = 0.0, heading = 0.0) {
  const h = Number.isFinite(heading) ? heading : 0.0;
  const c = Math.cos(h);
  const s = Math.sin(h);
  return {
    x: ox + lx * c + ly * s,
    y: oy - lx * s + ly * c,
  };
}

export function computeMastStages(forkHeightM) {
  const outerH = AGF_SPECS.collapsedMastHeightM;
  const forkMin = AGF_SPECS.forkMinZ;
  const freeliftMax = AGF_SPECS.freeliftMaxZ;
  const forkMax = AGF_SPECS.forkMaxZ;

  const raw = Number.isFinite(forkHeightM) ? forkHeightM : forkMin;
  const h = clamp(raw, forkMin, forkMax);
  const freeliftActive = h <= freeliftMax;
  const tele = freeliftActive ? 0.0 : h - freeliftMax;

  return {
    outerH,
    stage2Offset: 0.5 * tele,
    stage3Offset: tele,
    carriageOffset: h - forkMin,
    freeliftActive,
  };
}

function resolveContainerEnvelope(desc) {
  if (!desc || typeof desc !== "object") {
    return null;
  }
  if (Number.isFinite(desc.wcid) && CONTAINER_ENVELOPE_SPECS[desc.wcid]) {
    return CONTAINER_ENVELOPE_SPECS[desc.wcid];
  }
  if (desc.kind === 10 || desc.containerKind === "20ft") {
    return CONTAINER_ENVELOPE_SPECS[4000020];
  }
  if (desc.kind === 11 || desc.containerKind === "40ft") {
    return CONTAINER_ENVELOPE_SPECS[4000021];
  }
  if (desc.kind === 12 || desc.containerKind === "40HC") {
    return CONTAINER_ENVELOPE_SPECS[4000022];
  }
  const logSpec = resolveContainerLogisticsSpec(desc);
  if (logSpec && logSpec.wcid && CONTAINER_ENVELOPE_SPECS[logSpec.wcid]) {
    return CONTAINER_ENVELOPE_SPECS[logSpec.wcid];
  }
  return null;
}

function isPointInsideBounds(px, py, b) {
  return (
    Number.isFinite(px) &&
    Number.isFinite(py) &&
    px >= b.minX &&
    px <= b.maxX &&
    py >= b.minY &&
    py <= b.maxY
  );
}

function isAgfInsideContainer(x, y, heading, containerDesc) {
  if (!containerDesc || typeof containerDesc !== "object") {
    return false;
  }
  const tipDist = AGF_SPECS.forkTipY;
  const tipX = x + Math.sin(heading) * tipDist;
  const tipY = y + Math.cos(heading) * tipDist;
  const rearDist = AGF_SPECS.rearOverhangY;
  const rearX = x + Math.sin(heading) * rearDist;
  const rearY = y + Math.cos(heading) * rearDist;

  if (containerDesc.bounds) {
    const b = containerDesc.bounds;
    return (
      isPointInsideBounds(x, y, b) ||
      isPointInsideBounds(tipX, tipY, b) ||
      isPointInsideBounds(rearX, rearY, b)
    );
  }

  const cx = finiteOr(containerDesc.x, NaN);
  const cy = finiteOr(containerDesc.y, NaN);
  if (!Number.isFinite(cx) || !Number.isFinite(cy)) {
    return false;
  }
  const ch = finiteOr(containerDesc.heading, 0.0);
  const env = resolveContainerEnvelope(containerDesc);
  const logSpec = resolveContainerLogisticsSpec(containerDesc);
  const halfW = finiteOr(
    containerDesc.halfW,
    env ? env.intW * 0.5 : logSpec ? logSpec.interior.halfW : 1.176
  );
  const halfL = finiteOr(
    containerDesc.halfL,
    env ? env.intL * 0.5 : logSpec ? logSpec.interior.halfL : 2.949
  );

  const checkPt = (px, py) => {
    const loc = worldToLocal2D(px, py, cx, cy, ch);
    return (
      Math.abs(loc.x) <= halfW + 0.05 &&
      loc.y >= -(halfL + 0.10) &&
      loc.y <= halfL + 0.05
    );
  };

  return checkPt(x, y) || checkPt(tipX, tipY) || checkPt(rearX, rearY);
}

export function stepAgfKinematics(state = {}, cmd = {}, dt = 1 / 60, context = {}) {
  const s = state && typeof state === "object" ? state : {};
  const c = cmd && typeof cmd === "object" ? cmd : {};
  const ctx = context && typeof context === "object" ? context : {};

  const stepDt = Number.isFinite(dt) && dt > 0.0 ? Math.min(dt, 0.1) : 0.0;

  const wheelbase = AGF_SPECS.wheelbaseM;
  const maxSteer = AGF_SPECS.maxSteerRad;
  const forkMinZ = AGF_SPECS.forkMinZ;
  const forkMaxZ = AGF_SPECS.forkMaxZ;
  const containerMaxForkZ = AGF_SPECS.containerMaxForkHeightM;
  const mastSpeed = AGF_SPECS.mastSpeedMps;
  const sideShiftMax = AGF_SPECS.sideShiftMaxM;
  const tiltMin = AGF_SPECS.mastTiltFwdRad;
  const tiltMax = AGF_SPECS.mastTiltBackRad;
  const vMaxEmpty = AGF_SPECS.vMaxEmptyMps;
  const vMaxLoaded = AGF_SPECS.vMaxLoadedMps;
  const vContainer = AGF_SPECS.vContainerMps;
  const vDocking = AGF_SPECS.vDockingMps;
  const vTipOverCap = AGF_SPECS.vTipOverCappedMps;
  const tipOverForkZ = AGF_SPECS.tipOverForkHeightM;
  const dockPosTol = AGF_SPECS.dockPosTolM;
  const dockYawTol = AGF_SPECS.dockYawTolRad;
  const frontWheelRadius = AGF_SPECS.frontWheelRadiusM;

  const accel = 2.8;
  const decel = 5.0;
  const steerRate = 3.2;
  const sideShiftRate = 0.25;
  const tiltRate = 10.0 * RAD_PER_DEG;
  const lidarSpinRate = 4.0 * Math.PI;

  let x = finiteOr(s.x, 0.0);
  let y = finiteOr(s.y, 0.0);
  let heading = wrapHeading(finiteOr(s.heading, 0.0));
  let speed = finiteOr(s.speed, 0.0);
  let steerAngleRad = clamp(finiteOr(s.steerAngleRad, 0.0), -maxSteer, maxSteer);
  const curForkZ = clamp(finiteOr(s.forkHeightM, forkMinZ), forkMinZ, forkMaxZ);
  const curSideShift = clamp(finiteOr(s.sideShiftM, 0.0), -sideShiftMax, sideShiftMax);
  const curTilt = clamp(finiteOr(s.mastTiltRad, 0.0), tiltMin, tiltMax);
  let wheelSpinRad = finiteOr(s.wheelSpinRad, 0.0);
  let lidarSpinRad = wrapHeading(finiteOr(s.lidarSpinRad, 0.0));

  const isLoaded = Boolean(s.loaded || (s.carriedWcid && s.carriedWcid !== 0));
  let waypointIndex = Number.isInteger(c.waypointIndex)
    ? Math.max(0, c.waypointIndex)
    : Number.isInteger(s.waypointIndex)
      ? Math.max(0, s.waypointIndex)
      : 0;

  // 1. Container BBox Check
  let insideContainer = Boolean(ctx.insideContainer);
  if (!insideContainer) {
    const candidates = [];
    if (ctx.container) candidates.push(ctx.container);
    if (Array.isArray(ctx.containers)) {
      for (let i = 0; i < ctx.containers.length; i++) {
        if (ctx.containers[i]) candidates.push(ctx.containers[i]);
      }
    }
    for (let i = 0; i < candidates.length; i++) {
      if (isAgfInsideContainer(x, y, heading, candidates[i])) {
        insideContainer = true;
        break;
      }
    }
  }

  // 2. Roof-Strike Interlock & Mast / Carriage Slew
  const rawReqForkZ = c.targetForkHeightM ?? c.forkHeightM;
  const requestedForkZ = clamp(finiteOr(rawReqForkZ, curForkZ), forkMinZ, forkMaxZ);
  let roofStrikeBlocked = false;
  let effectiveTargetForkZ = requestedForkZ;
  if (insideContainer && requestedForkZ > containerMaxForkZ) {
    roofStrikeBlocked = true;
    effectiveTargetForkZ = containerMaxForkZ;
  }

  let forkHeightM = moveToward(curForkZ, effectiveTargetForkZ, mastSpeed * stepDt);
  if (insideContainer && forkHeightM > containerMaxForkZ) {
    forkHeightM = containerMaxForkZ;
    roofStrikeBlocked = true;
  }

  const reqSideShift = clamp(finiteOr(c.sideShiftM, curSideShift), -sideShiftMax, sideShiftMax);
  const sideShiftM = moveToward(curSideShift, reqSideShift, sideShiftRate * stepDt);

  const reqTilt = clamp(finiteOr(c.mastTiltRad, curTilt), tiltMin, tiltMax);
  const mastTiltRad = moveToward(curTilt, reqTilt, tiltRate * stepDt);

  // 3. Container LIFO Reachability Interlock
  let opDesc = c.containerOp ?? ctx.containerOperation ?? null;
  if (!opDesc && ctx.container && Number.isInteger(c.slotIndex)) {
    opDesc = {
      containerKind: ctx.container.containerKind ?? ctx.container.kind ?? ctx.container.wcid ?? ctx.container,
      occupiedSlots: ctx.container.slots ?? [],
      slotIndex: c.slotIndex,
      op: isLoaded ? "load" : "unload",
    };
  }
  let lifoBlocked = false;
  let lifoReason = null;
  let lifoBlockedBySlotIndex = null;
  if (opDesc && Number.isInteger(opDesc.slotIndex)) {
    const isLoad =
      opDesc.op === "load" ||
      opDesc.op === "place" ||
      (!opDesc.op && isLoaded);
    const containerRef = opDesc.containerKind ?? opDesc.container ?? ctx.container;
    const occ = Array.isArray(opDesc.occupiedSlots) ? opDesc.occupiedSlots : [];
    const res = isLoad
      ? isSlotReachableForLoad(containerRef, occ, opDesc.slotIndex, 0, "full")
      : isSlotReachableForUnload(containerRef, occ, opDesc.slotIndex, 0);
    if (!res.reachable) {
      lifoBlocked = true;
      lifoReason = res.reason ?? "blocked";
      lifoBlockedBySlotIndex = res.blockedBySlotIndex ?? null;
    }
  }

  // 4. Resolve Waypoints / TargetPose & Travel Direction before Proximity Query
  const hasWaypoints = Array.isArray(c.waypoints) && c.waypoints.length > 0;
  let activeTarget = null;
  let isLastTarget = true;

  if (hasWaypoints) {
    if (waypointIndex >= c.waypoints.length) {
      activeTarget = null;
    } else {
      while (waypointIndex < c.waypoints.length - 1) {
        const wp = c.waypoints[waypointIndex];
        if (!wp || !Number.isFinite(wp.x) || !Number.isFinite(wp.y)) {
          waypointIndex++;
          continue;
        }
        if (Math.hypot(wp.x - x, wp.y - y) <= 0.45) {
          waypointIndex++;
        } else {
          break;
        }
      }
      activeTarget = c.waypoints[waypointIndex] || null;
      isLastTarget = waypointIndex >= c.waypoints.length - 1;
    }
  } else if (c.targetPose && Number.isFinite(c.targetPose.x) && Number.isFinite(c.targetPose.y)) {
    activeTarget = c.targetPose;
    isLastTarget = true;
  }

  const targetLoc =
    activeTarget && Number.isFinite(activeTarget.x) && Number.isFinite(activeTarget.y)
      ? worldToLocal2D(activeTarget.x, activeTarget.y, x, y, heading)
      : null;
  const reverseSpec = activeTarget ? activeTarget.reverse ?? c.reverse : c.reverse;
  const targetIsReverse = Boolean(
    targetLoc && (reverseSpec === true || (reverseSpec === "auto" && targetLoc.y < -0.1))
  );
  let isReversing = false;
  if (hasWaypoints && waypointIndex >= c.waypoints.length) {
    isReversing = false;
  } else if (targetLoc) {
    isReversing = targetIsReverse;
  } else if (Number.isFinite(c.speed)) {
    isReversing = c.speed < 0.0 || (Math.abs(c.speed) <= 1e-6 && speed < -0.05);
  } else if (Number.isFinite(c.throttle)) {
    isReversing = c.throttle < 0.0 || (Math.abs(c.throttle) <= 1e-6 && speed < -0.05);
  } else {
    isReversing = speed < -0.05;
  }

  // 5. Speed Ceilings & Tip-Over + Spatial Proximity Interlocks
  let maxSpeed = isLoaded ? vMaxLoaded : vMaxEmpty;
  if (insideContainer) {
    maxSpeed = Math.min(maxSpeed, vContainer);
  }
  if (c.docking) {
    maxSpeed = Math.min(maxSpeed, vDocking);
  }
  if (Number.isFinite(c.speedLimit) && c.speedLimit >= 0.0) {
    maxSpeed = Math.min(maxSpeed, c.speedLimit);
  }

  const tipOverSpeedCapped = forkHeightM > tipOverForkZ || curForkZ > tipOverForkZ;
  if (tipOverSpeedCapped) {
    maxSpeed = Math.min(maxSpeed, vTipOverCap);
  }

  let yieldStopped = false;
  let yieldSlowed = false;
  const agentId = s.agentId ?? ctx.agentId ?? null;
  if (ctx.grid && agentId) {
    const travelHeading = isReversing ? wrapHeading(heading + Math.PI) : heading;
    const prox = ctx.grid.queryProximity(agentId, x, y, travelHeading, { directional: true });
    yieldStopped = Boolean(prox.stop);
    yieldSlowed = Boolean(prox.slow);
    if (yieldStopped) {
      maxSpeed = 0.0;
    } else if (yieldSlowed) {
      maxSpeed = Math.min(maxSpeed, Math.max(0.4, maxSpeed * 0.45));
    }
  }

  // 6. Guidance (Waypoints / TargetPose vs Direct Control)
  let arrived = false;
  let poseAligned = false;
  let distToTarget = 0.0;
  let yawDelta = 0.0;
  let steerTarget = 0.0;
  let vTarget = 0.0;
  let isDocking = Boolean(c.docking);
  let usedPrecisionCapture = false;

  if (hasWaypoints && waypointIndex >= c.waypoints.length) {
    arrived = true;
    poseAligned = true;
    speed = 0.0;
    steerTarget = 0.0;
  } else if (activeTarget && targetLoc) {
    distToTarget = Math.hypot(activeTarget.x - x, activeTarget.y - y);
    const loc = targetLoc;
    const isReverse = targetIsReverse;
    isDocking = Boolean(
      activeTarget.docking || c.docking || (isLastTarget && distToTarget <= 1.2)
    );
    let localMaxSpeed = maxSpeed;
    if (isDocking && isLastTarget) {
      localMaxSpeed = Math.min(localMaxSpeed, vDocking);
    }
    if (Number.isFinite(activeTarget.speedLimit) && activeTarget.speedLimit >= 0.0) {
      localMaxSpeed = Math.min(localMaxSpeed, activeTarget.speedLimit);
    }

    if (distToTarget <= dockPosTol && isLastTarget) {
      speed = 0.0;
      vTarget = 0.0;
      steerTarget = 0.0;
      usedPrecisionCapture = true;
      if (Number.isFinite(activeTarget.heading)) {
        yawDelta = wrapPi(activeTarget.heading - heading);
        if (Math.abs(yawDelta) <= dockYawTol) {
          arrived = true;
          poseAligned = true;
        } else if (!lifoBlocked && !yieldStopped) {
          const trimMax = 1.5 * stepDt;
          heading = wrapHeading(heading + clamp(yawDelta, -trimMax, trimMax));
          yawDelta = wrapPi(activeTarget.heading - heading);
          if (Math.abs(yawDelta) <= dockYawTol) {
            arrived = true;
            poseAligned = true;
          }
        }
      } else {
        arrived = true;
        poseAligned = true;
      }
    } else if (distToTarget <= 0.15 && isLastTarget) {
      usedPrecisionCapture = true;
      if (lifoBlocked || localMaxSpeed <= 0.0) {
        speed = 0.0;
      } else if (stepDt > 0.0) {
        const stepDist = Math.min(
          distToTarget,
          Math.max(0.10, distToTarget * 4.5) * stepDt,
          localMaxSpeed * stepDt
        );
        const ux = (activeTarget.x - x) / distToTarget;
        const uy = (activeTarget.y - y) / distToTarget;
        x += ux * stepDist;
        y += uy * stepDist;
        speed = (isReverse ? -stepDist : stepDist) / stepDt;
        if (Number.isFinite(activeTarget.heading)) {
          yawDelta = wrapPi(activeTarget.heading - heading);
          const trimMax = 2.0 * stepDt;
          heading = wrapHeading(heading + clamp(yawDelta, -trimMax, trimMax));
        }
        distToTarget = Math.hypot(activeTarget.x - x, activeTarget.y - y);
        yawDelta = Number.isFinite(activeTarget.heading)
          ? wrapPi(activeTarget.heading - heading)
          : 0.0;
        if (
          distToTarget <= dockPosTol &&
          (!Number.isFinite(activeTarget.heading) || Math.abs(yawDelta) <= dockYawTol)
        ) {
          arrived = true;
          poseAligned = true;
          speed = 0.0;
        }
      }
    } else {
      const ld = Math.max(distToTarget, 0.25);
      const kappa = (2.0 * loc.x) / (ld * ld);
      if (!isReverse && loc.y < 0.0) {
        steerTarget = (loc.x >= 0.0 ? 1.0 : -1.0) * maxSteer;
      } else if (isReverse && loc.y > 0.0) {
        steerTarget = (loc.x >= 0.0 ? 1.0 : -1.0) * maxSteer;
      } else {
        steerTarget = clamp(Math.atan(wheelbase * kappa), -maxSteer, maxSteer);
      }

      const vBrake = Math.sqrt(2.0 * decel * Math.max(0.0, distToTarget - 0.04));
      const turnFactor = clamp(
        1.0 - 0.55 * (Math.abs(steerTarget) / maxSteer),
        0.35,
        1.0
      );
      const vMag = Math.min(localMaxSpeed * turnFactor, vBrake);
      vTarget = isReverse ? -vMag : vMag;
    }
  } else {
    // Direct control
    const rawSteer = c.steerAngleRad ?? (Number.isFinite(c.steer) ? c.steer * maxSteer : 0.0);
    steerTarget = clamp(finiteOr(rawSteer, 0.0), -maxSteer, maxSteer);
    const rawSpeed = c.speed ?? (Number.isFinite(c.throttle) ? c.throttle * maxSpeed : 0.0);
    vTarget = clamp(finiteOr(rawSpeed, 0.0), -maxSpeed, maxSpeed);
  }

  // 6. Integrate Rear-Steer Ackermann (for non-precision-capture steps)
  if (!usedPrecisionCapture) {
    if (lifoBlocked || maxSpeed <= 0.0) {
      vTarget = 0.0;
      speed = 0.0;
    }
    steerAngleRad = clamp(
      moveToward(steerAngleRad, steerTarget, steerRate * stepDt),
      -maxSteer,
      maxSteer
    );
    const dvRate = Math.abs(vTarget) > Math.abs(speed) ? accel : decel;
    speed = clamp(moveToward(speed, vTarget, dvRate * stepDt), -maxSpeed, maxSpeed);
    if (lifoBlocked || maxSpeed <= 0.0) {
      speed = 0.0;
    }

    if (stepDt > 0.0) {
      const omega = (speed / wheelbase) * Math.tan(steerAngleRad);
      heading = wrapHeading(heading + omega * stepDt);
      x += Math.sin(heading) * speed * stepDt;
      y += Math.cos(heading) * speed * stepDt;

      if (activeTarget && Number.isFinite(activeTarget.x) && Number.isFinite(activeTarget.y)) {
        distToTarget = Math.hypot(activeTarget.x - x, activeTarget.y - y);
        if (hasWaypoints && !isLastTarget && distToTarget <= 0.45) {
          waypointIndex++;
        } else if (isLastTarget && distToTarget <= dockPosTol) {
          yawDelta = Number.isFinite(activeTarget.heading)
            ? wrapPi(activeTarget.heading - heading)
            : 0.0;
          if (!Number.isFinite(activeTarget.heading) || Math.abs(yawDelta) <= dockYawTol) {
            arrived = true;
            poseAligned = true;
            speed = 0.0;
          }
        }
      }
    }
  } else {
    steerAngleRad = clamp(
      moveToward(steerAngleRad, steerTarget, steerRate * stepDt),
      -maxSteer,
      maxSteer
    );
  }

  wheelSpinRad += (speed * stepDt) / frontWheelRadius;
  lidarSpinRad = wrapHeading(lidarSpinRad + lidarSpinRate * stepDt);

  const mastMoving = Math.abs(effectiveTargetForkZ - forkHeightM) > 1e-3;
  const statusMode =
    roofStrikeBlocked || lifoBlocked || yieldStopped
      ? "blocked"
      : mastMoving
        ? "lifting"
        : isDocking && !arrived
          ? "docking"
          : Math.abs(speed) > 0.02
            ? "transit"
            : "idle";

  return {
    ...s,
    x,
    y,
    heading,
    speed,
    steerAngleRad,
    forkHeightM,
    sideShiftM,
    mastTiltRad,
    wheelSpinRad,
    lidarSpinRad,
    waypointIndex,
    arrived,
    poseAligned,
    distToTarget,
    yawDelta,
    insideContainer,
    roofStrikeBlocked,
    tipOverSpeedCapped,
    lifoBlocked,
    lifoReason,
    lifoBlockedBySlotIndex,
    yieldStopped,
    yieldSlowed,
    statusMode,
  };
}

export function stepAmrKinematics(state = {}, cmd = {}, dt = 1 / 60, context = {}) {
  const s = state && typeof state === "object" ? state : {};
  const c = cmd && typeof cmd === "object" ? cmd : {};
  const ctx = context && typeof context === "object" ? context : {};

  const stepDt = Number.isFinite(dt) && dt > 0.0 ? Math.min(dt, 0.1) : 0.0;

  const vMaxEmpty = AMR_SPECS.vMaxEmptyMps;
  const vMaxLoaded = AMR_SPECS.vMaxLoadedMps;
  const omegaMax = AMR_SPECS.omegaMaxRadSec;
  const accelMax = AMR_SPECS.accelMaxMps2;
  const decelMax = 4.5;
  const alphaMax = 4.5;
  const liftMin = AMR_SPECS.loweredHeightM;
  const liftMax = AMR_SPECS.raisedHeightM;
  const liftSpeed = AMR_SPECS.liftSpeedMps;
  const halfTrack = AMR_SPECS.wheelTrackM * 0.5;
  const wheelRadius = AMR_SPECS.wheelRadiusM;
  const turntableMax = AMR_SPECS.turntableMaxRadSec;
  const dockPosTol = AMR_SPECS.dockPosTolM;
  const dockYawTol = AMR_SPECS.dockYawTolRad;
  const zeroTurnYawThreshold = 0.25;

  let x = finiteOr(s.x, 0.0);
  let y = finiteOr(s.y, 0.0);
  let heading = wrapHeading(finiteOr(s.heading, 0.0));
  let speed = finiteOr(s.speed, 0.0);
  let omega = finiteOr(s.omega, 0.0);
  const curLift = clamp(finiteOr(s.liftHeightM, liftMin), liftMin, liftMax);
  const curTurntable = wrapPi(finiteOr(s.turntableYawRad, 0.0));
  let wheelSpinL = finiteOr(s.wheelSpinL, 0.0);
  let wheelSpinR = finiteOr(s.wheelSpinR, 0.0);

  const isLoaded = Boolean(s.loaded || (s.carriedWcid && s.carriedWcid !== 0));
  let waypointIndex = Number.isInteger(c.waypointIndex)
    ? Math.max(0, c.waypointIndex)
    : Number.isInteger(s.waypointIndex)
      ? Math.max(0, s.waypointIndex)
      : 0;

  // 1. Scissor Lift Stroke & Movement Lock
  const targetLift = clamp(
    finiteOr(c.targetLiftHeightM ?? c.liftHeightM, curLift),
    liftMin,
    liftMax
  );
  const isLifting = Math.abs(targetLift - curLift) > 1e-5;
  const liftHeightM = moveToward(curLift, targetLift, liftSpeed * stepDt);
  const liftMoved = Math.abs(liftHeightM - curLift) > 1e-7;

  let yieldStopped = false;
  let yieldSlowed = false;
  let arrived = false;

  if (isLifting || liftMoved) {
    speed = 0.0;
    omega = 0.0;
  } else {
    let vMax = isLoaded ? vMaxLoaded : vMaxEmpty;
    if (Number.isFinite(c.speedLimit) && c.speedLimit >= 0.0) {
      vMax = Math.min(vMax, c.speedLimit);
    }

    let omegaMaxEff = omegaMax;
    const agentId = s.agentId ?? ctx.agentId ?? null;
    if (ctx.grid && agentId) {
      const prox = ctx.grid.queryProximity(agentId, x, y, heading, { directional: true });
      yieldStopped = Boolean(prox.stop);
      yieldSlowed = Boolean(prox.slow);
      if (yieldStopped) {
        vMax = 0.0;
        omegaMaxEff = 0.0;
      } else if (yieldSlowed) {
        vMax = Math.min(vMax, 0.75);
      }
    }

    const hasWaypoints = Array.isArray(c.waypoints) && c.waypoints.length > 0;
    let activeTarget = null;
    let isLastTarget = true;

    if (hasWaypoints) {
      if (waypointIndex < c.waypoints.length) {
        while (waypointIndex < c.waypoints.length - 1) {
          const wp = c.waypoints[waypointIndex];
          if (!wp || !Number.isFinite(wp.x) || !Number.isFinite(wp.y)) {
            waypointIndex++;
            continue;
          }
          if (Math.hypot(wp.x - x, wp.y - y) <= 0.35) {
            waypointIndex++;
          } else {
            break;
          }
        }
        activeTarget = c.waypoints[waypointIndex] || null;
        isLastTarget = waypointIndex >= c.waypoints.length - 1;
      }
    } else if (c.targetPose && Number.isFinite(c.targetPose.x) && Number.isFinite(c.targetPose.y)) {
      activeTarget = c.targetPose;
      isLastTarget = true;
    }

    let vTarget = 0.0;
    let omegaTarget = 0.0;
    let inPlaceTurnOnly = false;

    if (hasWaypoints && waypointIndex >= c.waypoints.length) {
      arrived = true;
      speed = 0.0;
      omega = 0.0;
    } else if (activeTarget && Number.isFinite(activeTarget.x) && Number.isFinite(activeTarget.y)) {
      const dist = Math.hypot(activeTarget.x - x, activeTarget.y - y);
      if (dist > dockPosTol) {
        const bearing = Math.atan2(activeTarget.x - x, activeTarget.y - y);
        const yawErr = wrapPi(bearing - heading);
        if (Math.abs(yawErr) > zeroTurnYawThreshold) {
          inPlaceTurnOnly = true;
          vTarget = 0.0;
          omegaTarget = clamp(yawErr * 3.5, -omegaMaxEff, omegaMaxEff);
        } else {
          omegaTarget = clamp(yawErr * 3.5, -omegaMaxEff, omegaMaxEff);
          const vBrake = Math.sqrt(2.0 * decelMax * dist);
          vTarget = Math.min(vMax * Math.max(0.2, Math.cos(yawErr)), vBrake);
        }
      } else {
        vTarget = 0.0;
        speed = 0.0;
        inPlaceTurnOnly = true;
        if (Number.isFinite(activeTarget.heading)) {
          const yawErr = wrapPi(activeTarget.heading - heading);
          if (Math.abs(yawErr) <= dockYawTol) {
            omegaTarget = 0.0;
            omega = 0.0;
            arrived = true;
          } else {
            omegaTarget = clamp(yawErr * 4.5, -omegaMaxEff, omegaMaxEff);
          }
        } else {
          omegaTarget = 0.0;
          omega = 0.0;
          arrived = true;
        }
      }
    } else {
      vTarget = clamp(finiteOr(c.speed, 0.0), -vMax, vMax);
      omegaTarget = clamp(finiteOr(c.omega, 0.0), -omegaMaxEff, omegaMaxEff);
    }

    if (yieldStopped) {
      speed = 0.0;
      omega = 0.0;
    } else {
      const dvRate = Math.abs(vTarget) > Math.abs(speed) ? accelMax : decelMax;
      speed = clamp(moveToward(speed, vTarget, dvRate * stepDt), -vMax, vMax);
      if (inPlaceTurnOnly && Math.abs(speed) <= 1e-4) {
        speed = 0.0;
      }
      omega = clamp(moveToward(omega, omegaTarget, alphaMax * stepDt), -omegaMaxEff, omegaMaxEff);

      if (stepDt > 0.0) {
        heading = wrapHeading(heading + omega * stepDt);
        x += Math.sin(heading) * speed * stepDt;
        y += Math.cos(heading) * speed * stepDt;

        if (activeTarget && Number.isFinite(activeTarget.x) && Number.isFinite(activeTarget.y)) {
          const postDist = Math.hypot(activeTarget.x - x, activeTarget.y - y);
          if (hasWaypoints && !isLastTarget && postDist <= 0.35) {
            waypointIndex++;
          } else if (isLastTarget && postDist <= dockPosTol) {
            if (
              !Number.isFinite(activeTarget.heading) ||
              Math.abs(wrapPi(activeTarget.heading - heading)) <= dockYawTol
            ) {
              arrived = true;
              speed = 0.0;
              omega = 0.0;
            }
          }
        }
      }
    }
  }

  // 2. Differential Wheel Spin
  const vL = speed + omega * halfTrack;
  const vR = speed - omega * halfTrack;
  wheelSpinL += (vL * stepDt) / wheelRadius;
  wheelSpinR += (vR * stepDt) / wheelRadius;

  // 3. Independent Turntable Controller
  let heldCargoHeading = Number.isFinite(c.heldCargoHeading)
    ? wrapHeading(c.heldCargoHeading)
    : Number.isFinite(s.heldCargoHeading)
      ? wrapHeading(s.heldCargoHeading)
      : wrapHeading(finiteOr(s.heading, 0.0) + curTurntable);

  let turntableYawRad;
  if (c.keepCargoHeading) {
    turntableYawRad = wrapPi(heldCargoHeading - heading);
  } else if (Number.isFinite(c.targetTurntableYawRad)) {
    const targetTt = wrapPi(c.targetTurntableYawRad);
    const diff = wrapPi(targetTt - curTurntable);
    const maxStep = turntableMax * stepDt;
    turntableYawRad = wrapPi(curTurntable + clamp(diff, -maxStep, maxStep));
    heldCargoHeading = wrapHeading(heading + turntableYawRad);
  } else {
    turntableYawRad = curTurntable;
    heldCargoHeading = wrapHeading(heading + turntableYawRad);
  }

  const statusMode = yieldStopped
    ? "yield"
    : isLifting || liftMoved
      ? "lifting"
      : c.charging
        ? "charging"
        : Math.abs(speed) > 0.02 || Math.abs(omega) > 0.02
          ? "transit"
          : "idle";

  return {
    ...s,
    x,
    y,
    heading,
    speed,
    omega,
    liftHeightM,
    turntableYawRad,
    heldCargoHeading,
    wheelSpinL,
    wheelSpinR,
    waypointIndex,
    arrived,
    isLifting: isLifting || liftMoved,
    yieldStopped,
    yieldSlowed,
    statusMode,
  };
}

export function stepLiftTable(state = {}, cmd = "hold", dt = 1 / 60, context = {}) {
  const s = state && typeof state === "object" ? state : {};
  const ctx = context && typeof context === "object" ? context : {};

  const minH = LIFT_TABLE_SPECS.loweredZ;
  const maxH = LIFT_TABLE_SPECS.raisedZ;
  const liftSpeed = LIFT_TABLE_SPECS.liftSpeedMps;
  const halfW = LIFT_TABLE_SPECS.outerWidthM * 0.5;
  const halfL = LIFT_TABLE_SPECS.outerDepthM * 0.5;
  const amrHalfW = AMR_SPECS.widthM * 0.5;
  const amrHalfL = AMR_SPECS.lengthM * 0.5;
  const jackRadius = 0.3425;
  const jackForkProbe = 0.55;

  const stepDt = Number.isFinite(dt) && dt > 0.0 ? Math.min(dt, 5.0) : 0.0;
  const curH = clamp(finiteOr(s.heightM, minH), minH, maxH);

  const action = typeof cmd === "string" ? cmd : cmd && cmd.action;
  let targetH;
  if (action === "raise") {
    targetH = maxH;
  } else if (action === "lower") {
    targetH = minH;
  } else if (cmd && typeof cmd === "object" && Number.isFinite(cmd.targetHeightM)) {
    targetH = clamp(cmd.targetHeightM, minH, maxH);
  } else {
    targetH = clamp(finiteOr(s.targetHeightM, curH), minH, maxH);
  }

  const tx = finiteOr(s.x ?? ctx.tablePose?.x, 0.0);
  const ty = finiteOr(s.y ?? ctx.tablePose?.y, 0.0);
  const th = wrapHeading(finiteOr(s.heading ?? ctx.tablePose?.heading, 0.0));

  // Interlock 1: Lowering blocked if an AMR occupies the underride footprint
  let amrUnderneath = Boolean(ctx.amrUnderneath);
  if (!amrUnderneath) {
    const amrs = [];
    if (ctx.amr) amrs.push(ctx.amr);
    if (Array.isArray(ctx.amrs)) {
      for (let i = 0; i < ctx.amrs.length; i++) {
        if (ctx.amrs[i]) amrs.push(ctx.amrs[i]);
      }
    }
    for (let i = 0; i < amrs.length; i++) {
      const a = amrs[i];
      if (!Number.isFinite(a.x) || !Number.isFinite(a.y)) continue;
      const loc = worldToLocal2D(a.x, a.y, tx, ty, th);
      const relH = wrapPi(finiteOr(a.heading, 0.0) - th);
      const projX = Math.abs(Math.cos(relH)) * amrHalfW + Math.abs(Math.sin(relH)) * amrHalfL;
      const projY = Math.abs(Math.sin(relH)) * amrHalfW + Math.abs(Math.cos(relH)) * amrHalfL;
      if (Math.abs(loc.x) < halfW + projX && Math.abs(loc.y) < halfL + projY) {
        amrUnderneath = true;
        break;
      }
    }
  }

  if (targetH < curH - 1e-5 && amrUnderneath) {
    return {
      ...s,
      x: tx,
      y: ty,
      heading: th,
      heightM: curH,
      targetHeightM: targetH,
      moving: false,
      interlockBlocked: true,
      interlockReason: "amr_underride_occupied",
    };
  }

  // Interlock 2: Raising blocked if a Pallet Jack overlaps the deck
  let jackOnDeck = Boolean(ctx.palletJackOnDeck);
  if (!jackOnDeck) {
    const jacks = [];
    if (ctx.palletJack) jacks.push(ctx.palletJack);
    if (Array.isArray(ctx.palletJacks)) {
      for (let i = 0; i < ctx.palletJacks.length; i++) {
        if (ctx.palletJacks[i]) jacks.push(ctx.palletJacks[i]);
      }
    }
    for (let i = 0; i < jacks.length; i++) {
      const j = jacks[i];
      if (!Number.isFinite(j.x) || !Number.isFinite(j.y)) continue;
      const jh = finiteOr(j.heading, 0.0);
      const pts = [
        [j.x, j.y],
        [j.x + Math.sin(jh) * jackForkProbe, j.y + Math.cos(jh) * jackForkProbe],
        [j.x - Math.sin(jh) * 0.52, j.y - Math.cos(jh) * 0.52],
      ];
      for (let p = 0; p < pts.length; p++) {
        const loc = worldToLocal2D(pts[p][0], pts[p][1], tx, ty, th);
        const dx = Math.max(0.0, Math.abs(loc.x) - halfW);
        const dy = Math.max(0.0, Math.abs(loc.y) - halfL);
        if (dx * dx + dy * dy < jackRadius * jackRadius) {
          jackOnDeck = true;
          break;
        }
      }
      if (jackOnDeck) break;
    }
  }

  if (targetH > curH + 1e-5 && jackOnDeck) {
    return {
      ...s,
      x: tx,
      y: ty,
      heading: th,
      heightM: curH,
      targetHeightM: targetH,
      moving: false,
      interlockBlocked: true,
      interlockReason: "pallet_jack_on_deck",
    };
  }

  const nextH = moveToward(curH, targetH, liftSpeed * stepDt);
  const moving = Math.abs(nextH - curH) > 1e-7;
  return {
    ...s,
    x: tx,
    y: ty,
    heading: th,
    heightM: nextH,
    targetHeightM: targetH,
    moving,
    interlockBlocked: false,
    interlockReason: null,
  };
}

export class SpatialReservationGrid {
  constructor({
    cellSizeM = 1.0,
    stopDistM = 0.8,
    slowDistM = 2.2,
    defaultRadiusM = 0.65,
  } = {}) {
    this.cellSizeM = Number.isFinite(cellSizeM) && cellSizeM > 0.1 ? cellSizeM : 1.0;
    this.stopDistM = Number.isFinite(stopDistM) && stopDistM >= 0.0 ? stopDistM : 0.8;
    this.slowDistM =
      Number.isFinite(slowDistM) && slowDistM >= this.stopDistM
        ? slowDistM
        : Math.max(2.2, this.stopDistM);
    this.defaultRadiusM =
      Number.isFinite(defaultRadiusM) && defaultRadiusM >= 0.05 ? defaultRadiusM : 0.65;
    this._cells = new Map();
    this._agentCells = new Map();
    this._agents = new Map();
  }

  claim(agentId, xOrOpts, y, radius) {
    const id = agentId != null ? String(agentId) : "";
    if (!id) {
      return {
        ok: false,
        conflict: true,
        blockedBy: null,
        conflictIds: [],
        cellsClaimed: 0,
      };
    }

    let cx;
    let cy;
    let r;
    let heading = 0.0;
    let kind = null;
    let replace = true;
    if (xOrOpts && typeof xOrOpts === "object") {
      cx = xOrOpts.x;
      cy = xOrOpts.y;
      r = finiteOr(xOrOpts.radius, this.defaultRadiusM);
      heading = finiteOr(xOrOpts.heading, 0.0);
      kind = xOrOpts.kind ?? null;
      replace = xOrOpts.replace !== false;
    } else {
      cx = xOrOpts;
      cy = y;
      r = finiteOr(radius, this.defaultRadiusM);
    }

    if (!Number.isFinite(cx) || !Number.isFinite(cy)) {
      return {
        ok: false,
        conflict: true,
        blockedBy: null,
        conflictIds: [],
        cellsClaimed: 0,
      };
    }
    r = Math.max(0.05, r);

    const inv = 1.0 / this.cellSizeM;
    const ix0 = Math.floor((cx - r) * inv);
    const ix1 = Math.floor((cx + r) * inv);
    const iy0 = Math.floor((cy - r) * inv);
    const iy1 = Math.floor((cy + r) * inv);

    const keys = [];
    const conflictSet = new Set();
    for (let ix = ix0; ix <= ix1; ix++) {
      for (let iy = iy0; iy <= iy1; iy++) {
        const key = `${ix},${iy}`;
        keys.push(key);
        const owner = this._cells.get(key);
        if (owner && owner !== id) {
          conflictSet.add(owner);
        }
      }
    }

    if (conflictSet.size > 0) {
      const conflictIds = Array.from(conflictSet);
      return {
        ok: false,
        conflict: true,
        blockedBy: conflictIds[0],
        conflictIds,
        cellsClaimed: 0,
      };
    }

    if (replace) {
      const oldKeys = this._agentCells.get(id);
      if (oldKeys) {
        for (let i = 0; i < oldKeys.length; i++) {
          if (this._cells.get(oldKeys[i]) === id) {
            this._cells.delete(oldKeys[i]);
          }
        }
      }
    }

    const mergedKeys = replace
      ? keys
      : Array.from(new Set([...(this._agentCells.get(id) || []), ...keys]));
    for (let i = 0; i < keys.length; i++) {
      this._cells.set(keys[i], id);
    }
    this._agentCells.set(id, mergedKeys);
    this._agents.set(id, { id, x: cx, y: cy, heading, radius: r, kind });

    return {
      ok: true,
      conflict: false,
      blockedBy: null,
      conflictIds: [],
      cellsClaimed: keys.length,
    };
  }

  release(agentId) {
    const id = agentId != null ? String(agentId) : "";
    if (!id) return 0;
    const keys = this._agentCells.get(id);
    let released = 0;
    if (keys) {
      for (let i = 0; i < keys.length; i++) {
        if (this._cells.get(keys[i]) === id) {
          this._cells.delete(keys[i]);
          released++;
        }
      }
      this._agentCells.delete(id);
    }
    this._agents.delete(id);
    return released;
  }

  queryProximity(agentId, x, y, heading = 0.0, options = {}) {
    const id = agentId != null ? String(agentId) : "";
    const stopDist = Number.isFinite(options?.stopDistM) ? options.stopDistM : this.stopDistM;
    const slowDist = Number.isFinite(options?.slowDistM) ? options.slowDistM : this.slowDistM;
    const directional = Boolean(options?.directional);

    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return {
        yieldLevel: "clear",
        stop: false,
        slow: false,
        speedScale: 1.0,
        nearestDist: Infinity,
        nearestAgentId: null,
      };
    }

    const h = Number.isFinite(heading) ? heading : 0.0;
    const fx = Math.sin(h);
    const fy = Math.cos(h);

    let minDist = Infinity;
    let nearestId = null;

    for (const [otherId, other] of this._agents.entries()) {
      if (otherId === id) continue;
      const dx = other.x - x;
      const dy = other.y - y;
      const d = Math.hypot(dx, dy);
      if (directional && d > stopDist * 0.5) {
        const forwardDot = dx * fx + dy * fy;
        if (forwardDot < -0.2) {
          continue;
        }
      }
      if (d < minDist) {
        minDist = d;
        nearestId = otherId;
      }
    }

    const stop = minDist <= stopDist;
    const slow = !stop && minDist <= slowDist;
    return {
      yieldLevel: stop ? "stop" : slow ? "slow" : "clear",
      stop,
      slow,
      speedScale: stop ? 0.0 : slow ? 0.45 : 1.0,
      nearestDist: minDist,
      nearestAgentId: nearestId,
    };
  }

  clear() {
    this._cells.clear();
    this._agentCells.clear();
    this._agents.clear();
  }

  getStats() {
    return {
      cellCount: this._cells.size,
      agentCount: this._agents.size,
    };
  }
}
