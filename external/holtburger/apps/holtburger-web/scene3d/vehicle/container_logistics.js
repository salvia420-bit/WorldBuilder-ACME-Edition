/**
 * Pure deterministic ISO 668 / ISO 6780 / ISO 3691-5 container interior LIFO
 * 2-wide grid solver & pallet-jack alignment assist.
 *
 * 1:1 parity twin of ACE `ContainerLogistics.cs`.
 * Zero external, DOM, Three.js, or `container_models.js` imports.
 */

const UNIFIED_PALLET_DIMS = Object.freeze({ width: 1.100, depth: 1.100, height: 0.145 });

export const PALLET_SPECS = Object.freeze({
  standard: UNIFIED_PALLET_DIMS,
  full: UNIFIED_PALLET_DIMS,
});

export const GMA_PALLET_SPECS = Object.freeze({
  standard: UNIFIED_PALLET_DIMS,
  full: UNIFIED_PALLET_DIMS,
});

export const PALLET_JACK_SPECS = Object.freeze({
  width: 0.685,
  forkLength: 1.150,
  bladeWidth: 0.160,
  loweredZ: 0.085,
  raisedZ: 0.200,
  wheelbase: 1.18,
  maxTillerRad: 1.65,
  assistMaxDistM: 0.55,
  assistMaxYawDeg: 28.0,
  assistMaxYawRad: (28.0 * Math.PI) / 180.0,
});

export const HALF_PALLET_WCIDS = Object.freeze(new Set());

const SPEC_20FT = Object.freeze({
  kind: 10,
  width: 2.352,
  length: 5.898,
  halfW: 1.176,
  halfL: 2.949,
  floorZ: 0.162,
  maxFull: 10,
  maxHalf: 10,
});

const SPEC_40FT = Object.freeze({
  kind: 11,
  width: 2.352,
  length: 12.032,
  halfW: 1.176,
  halfL: 6.016,
  floorZ: 0.162,
  maxFull: 20,
  maxHalf: 20,
});

const SPEC_40HC = Object.freeze({
  kind: 12,
  width: 2.352,
  length: 12.032,
  halfW: 1.176,
  halfL: 6.016,
  floorZ: 0.162,
  maxFull: 20,
  maxHalf: 20,
});

export const CONTAINER_INTERIOR_SPECS = Object.freeze({
  "20ft": SPEC_20FT,
  "40ft": SPEC_40FT,
  "40HC": SPEC_40HC,
  10: SPEC_20FT,
  11: SPEC_40FT,
  12: SPEC_40HC,
  4000020: SPEC_20FT,
  4000021: SPEC_40FT,
  4000022: SPEC_40HC,
});

// 20-ft 2-Wide Grid Bay Floor Layout (2 x 5 = 10 Unified 1.100 x 1.100 m Slots)
export const CONTAINER_SLOTS_20 = Object.freeze((() => {
  const rows = [+2.320, +1.160, 0.000, -1.160, -2.320];
  const slots = [];
  for (let r = 0; r < rows.length; r++) {
    slots.push(
      Object.freeze({ slotIndex: r * 2 + 0, x: -0.575, y: rows[r], orient: "Y", dx: 1.100, dy: 1.100 }),
      Object.freeze({ slotIndex: r * 2 + 1, x: +0.575, y: rows[r], orient: "Y", dx: 1.100, dy: 1.100 })
    );
  }
  return slots;
})());

// 40-ft / 40HC 2-Wide Grid Bay Floor Layout (2 x 10 = 20 Unified 1.100 x 1.100 m Slots)
export const CONTAINER_SLOTS_40 = Object.freeze((() => {
  const slots = [];
  for (let r = 0; r < 10; r++) {
    const y = (4.5 - r) * 1.180;
    slots.push(
      Object.freeze({ slotIndex: r * 2 + 0, x: -0.575, y, orient: "Y", dx: 1.100, dy: 1.100 }),
      Object.freeze({ slotIndex: r * 2 + 1, x: +0.575, y, orient: "Y", dx: 1.100, dy: 1.100 })
    );
  }
  return slots;
})());

export const PINWHEEL_SLOTS_20 = CONTAINER_SLOTS_20;
export const PINWHEEL_SLOTS_40 = CONTAINER_SLOTS_40;

const EPS = 1e-4;
const TAU = Math.PI * 2.0;

function wrapHeading(h) {
  let a = h % TAU;
  if (a < 0.0) {
    a += TAU;
  }
  return a;
}

function wrapPi(a) {
  let d = (a + Math.PI) % TAU;
  if (d < 0.0) {
    d += TAU;
  }
  return d - Math.PI;
}

export function resolveContainerLogisticsSpec(containerKind) {
  let key = containerKind;
  if (containerKind && typeof containerKind === "object") {
    key =
      containerKind.containerKind ??
      containerKind.kind ??
      containerKind.wcid ??
      containerKind.type;
  }
  if (typeof key === "number" && Number.isFinite(key)) {
    const n = Math.trunc(key);
    if (n === 10 || n === 4000020 || n === 20) {
      return { interior: SPEC_20FT, slots: PINWHEEL_SLOTS_20 };
    }
    if (n === 11 || n === 4000021 || n === 40) {
      return { interior: SPEC_40FT, slots: PINWHEEL_SLOTS_40 };
    }
    if (n === 12 || n === 4000022) {
      return { interior: SPEC_40HC, slots: PINWHEEL_SLOTS_40 };
    }
    return null;
  }
  if (typeof key === "string") {
    const s = key.trim().toLowerCase();
    if (s === "20" || s === "20ft" || s === "22g1" || s === "1cc" || s === "isocontainer20" || s === "4000020" || s === "10") {
      return { interior: SPEC_20FT, slots: PINWHEEL_SLOTS_20 };
    }
    if (s === "40" || s === "40ft" || s === "42g1" || s === "1aa" || s === "isocontainer40" || s === "4000021" || s === "11") {
      return { interior: SPEC_40FT, slots: PINWHEEL_SLOTS_40 };
    }
    if (s === "40hc" || s === "45g1" || s === "1aaa" || s === "isocontainer40hc" || s === "4000022" || s === "12") {
      return { interior: SPEC_40HC, slots: PINWHEEL_SLOTS_40 };
    }
  }
  return null;
}

function isUnifiedFullPalletSize(palletSize) {
  return (
    palletSize === "full" ||
    palletSize === "Full" ||
    palletSize === "standard" ||
    palletSize === "Standard" ||
    palletSize === 2
  );
}

export function getSlotSubBox(slotDef, _palletSize = "full", _subSlot = 0) {
  const hx = slotDef.dx * 0.5;
  const hy = slotDef.dy * 0.5;
  return {
    slotIndex: slotDef.slotIndex,
    subSlot: 0,
    palletSize: "full",
    x: slotDef.x,
    y: slotDef.y,
    dx: slotDef.dx,
    dy: slotDef.dy,
    orient: slotDef.orient,
    x0: slotDef.x - hx,
    x1: slotDef.x + hx,
    y0: slotDef.y - hy,
    y1: slotDef.y + hy,
  };
}

function normalizeOccupiedBoxes(slots, occupiedSlots) {
  if (!Array.isArray(occupiedSlots)) {
    return [];
  }
  const boxes = [];
  const seen = new Set();
  for (let i = 0; i < occupiedSlots.length; i++) {
    const raw = occupiedSlots[i];
    if (!raw || typeof raw !== "object") {
      continue;
    }
    const slotIdxRaw = raw.slotIndex ?? raw.SlotIndex;
    if (typeof slotIdxRaw !== "number" || !Number.isFinite(slotIdxRaw)) {
      continue;
    }
    const slotIndex = Math.trunc(slotIdxRaw);
    if (slotIndex < 0 || slotIndex >= slots.length) {
      continue;
    }
    const rawSize = raw.palletSize ?? raw.PalletSize;
    if (rawSize === 0 || rawSize === "none" || rawSize === "None") {
      continue;
    }
    if (seen.has(slotIndex)) {
      continue;
    }
    seen.add(slotIndex);
    const cargoWcid = raw.cargoWcid ?? raw.CargoWcid ?? raw.wcid ?? 0;
    const box = getSlotSubBox(slots[slotIndex], "full", 0);
    box.cargoWcid = typeof cargoWcid === "number" && Number.isFinite(cargoWcid) ? Math.trunc(cargoWcid) : 0;
    boxes.push(box);
  }
  return boxes;
}

export function evaluateCorridorFromDoor(targetBox, obstacleBoxes, halfW = SPEC_40FT.halfW) {
  const blockerMap = new Map();
  const addBlocker = (b) => {
    const k = `${b.slotIndex}:${b.subSlot}`;
    if (!blockerMap.has(k)) {
      blockerMap.set(k, b);
    }
  };

  const frontObstacles = [];
  for (let i = 0; i < obstacleBoxes.length; i++) {
    const b = obstacleBoxes[i];
    if (b.slotIndex === targetBox.slotIndex && b.subSlot === targetBox.subSlot) {
      continue;
    }
    if (b.y0 < targetBox.y0 - EPS) {
      frontObstacles.push(b);
      const overlapX = Math.min(targetBox.x1, b.x1) - Math.max(targetBox.x0, b.x0);
      if (overlapX > EPS) {
        addBlocker(b);
      }
    }
  }

  // Step B: check that at every occupied Y-slice in front of targetBox.y0,
  // the clear transverse lane containing [targetBox.x0, targetBox.x1] is wide
  // enough for both the pallet and the 0.685m pallet jack.
  const requiredWidth = Math.max(targetBox.dx, PALLET_JACK_SPECS.width);
  for (let i = 0; i < frontObstacles.length; i++) {
    const b = frontObstacles[i];
    if (blockerMap.has(`${b.slotIndex}:${b.subSlot}`)) {
      continue;
    }
    let leftWall = -halfW;
    let rightWall = halfW;
    let leftBlocker = null;
    let rightBlocker = null;

    for (let j = 0; j < frontObstacles.length; j++) {
      const o = frontObstacles[j];
      const overlapY = Math.min(b.y1, o.y1) - Math.max(b.y0, o.y0);
      if (overlapY <= EPS) {
        continue;
      }
      if (o.x1 <= targetBox.x0 + EPS && o.x1 > leftWall) {
        leftWall = o.x1;
        leftBlocker = o;
      }
      if (o.x0 >= targetBox.x1 - EPS && o.x0 < rightWall) {
        rightWall = o.x0;
        rightBlocker = o;
      }
    }

    if (rightWall - leftWall < requiredWidth - EPS) {
      if (leftBlocker && rightBlocker) {
        const dLeft = targetBox.x0 - leftBlocker.x1;
        const dRight = rightBlocker.x0 - targetBox.x1;
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
    (a, b) => (a.y0 - b.y0) || (a.slotIndex - b.slotIndex) || (a.subSlot - b.subSlot)
  );
  return {
    reachable: blockers.length === 0,
    blockedBySlotIndex: blockers.length > 0 ? blockers[0].slotIndex : null,
    blockedBySubSlot: blockers.length > 0 ? blockers[0].subSlot : null,
    blockedBy: blockers.map((b) => ({ slotIndex: b.slotIndex, subSlot: b.subSlot })),
  };
}

export function computeReachableUnloadSlots(containerKind, occupiedSlots) {
  const spec = resolveContainerLogisticsSpec(containerKind);
  if (!spec) {
    return { reachable: [], blocked: [], all: [] };
  }
  const occupied = normalizeOccupiedBoxes(spec.slots, occupiedSlots);
  const all = [];
  const reachable = [];
  const blocked = [];

  for (let i = 0; i < occupied.length; i++) {
    const item = occupied[i];
    const res = evaluateCorridorFromDoor(item, occupied, spec.interior.halfW);
    const entry = {
      slotIndex: item.slotIndex,
      subSlot: item.subSlot,
      palletSize: item.palletSize,
      cargoWcid: item.cargoWcid,
      x: item.x,
      y: item.y,
      dx: item.dx,
      dy: item.dy,
      orient: item.orient,
      reachable: res.reachable,
      blockedBySlotIndex: res.blockedBySlotIndex,
      blockedBySubSlot: res.blockedBySubSlot,
      blockedBy: res.blockedBy,
    };
    all.push(entry);
    if (res.reachable) {
      reachable.push(entry);
    } else {
      blocked.push(entry);
    }
  }

  const byShallowFirst = (a, b) => (a.y - b.y) || (a.slotIndex - b.slotIndex) || (a.subSlot - b.subSlot);
  reachable.sort(byShallowFirst);
  blocked.sort(byShallowFirst);
  all.sort(byShallowFirst);
  return { reachable, blocked, all };
}

export function computeReachableLoadSlots(containerKind, occupiedSlots, palletSize = "full") {
  const spec = resolveContainerLogisticsSpec(containerKind);
  if (!spec || !isUnifiedFullPalletSize(palletSize)) {
    return { reachable: [], blocked: [], all: [] };
  }
  const occupied = normalizeOccupiedBoxes(spec.slots, occupiedSlots);
  const occupiedSet = new Set();
  for (let i = 0; i < occupied.length; i++) {
    occupiedSet.add(occupied[i].slotIndex);
  }

  const candidates = [];
  for (let i = 0; i < spec.slots.length; i++) {
    const slotDef = spec.slots[i];
    if (occupiedSet.has(slotDef.slotIndex)) {
      continue;
    }
    candidates.push(getSlotSubBox(slotDef, "full", 0));
  }

  const all = [];
  const reachable = [];
  const blocked = [];

  for (let i = 0; i < candidates.length; i++) {
    const cand = candidates[i];
    const res = evaluateCorridorFromDoor(cand, occupied, spec.interior.halfW);
    const entry = {
      slotIndex: cand.slotIndex,
      subSlot: cand.subSlot,
      palletSize: cand.palletSize,
      x: cand.x,
      y: cand.y,
      dx: cand.dx,
      dy: cand.dy,
      orient: cand.orient,
      reachable: res.reachable,
      blockedBySlotIndex: res.blockedBySlotIndex,
      blockedBySubSlot: res.blockedBySubSlot,
      blockedBy: res.blockedBy,
    };
    all.push(entry);
    if (res.reachable) {
      reachable.push(entry);
    } else {
      blocked.push(entry);
    }
  }

  // Deepest-first (+Y -> -Y) for back-to-front loading order
  const byDeepestFirst = (a, b) => (b.y - a.y) || (a.slotIndex - b.slotIndex) || (b.subSlot - a.subSlot);
  reachable.sort(byDeepestFirst);
  blocked.sort(byDeepestFirst);
  all.sort(byDeepestFirst);
  return { reachable, blocked, all };
}

export function isSlotReachableForUnload(containerKind, occupiedSlots, slotIndex, subSlot = 0) {
  const spec = resolveContainerLogisticsSpec(containerKind);
  if (!spec) {
    return { reachable: false, blockedBySlotIndex: null, blockedBySubSlot: null, blockedBy: [], reason: "invalid_container" };
  }
  if (!Number.isInteger(slotIndex)) {
    return { reachable: false, blockedBySlotIndex: null, blockedBySubSlot: null, blockedBy: [], reason: "invalid_slot" };
  }
  const idx = slotIndex;
  if (idx < 0 || idx >= spec.slots.length) {
    return { reachable: false, blockedBySlotIndex: null, blockedBySubSlot: null, blockedBy: [], reason: "invalid_slot" };
  }
  if (!Number.isInteger(subSlot) || subSlot !== 0) {
    return { reachable: false, blockedBySlotIndex: null, blockedBySubSlot: null, blockedBy: [], reason: "invalid_subslot" };
  }
  const occupied = normalizeOccupiedBoxes(spec.slots, occupiedSlots);
  const target = occupied.find((o) => o.slotIndex === idx);
  if (!target) {
    return { reachable: false, blockedBySlotIndex: null, blockedBySubSlot: null, blockedBy: [], reason: "slot_empty" };
  }
  const res = evaluateCorridorFromDoor(target, occupied, spec.interior.halfW);
  return {
    ...res,
    reason: res.reachable ? null : "blocked",
  };
}

export function isSlotReachableForLoad(
  containerKind,
  occupiedSlots,
  slotIndex,
  subSlot = 0,
  palletSize = "full"
) {
  const spec = resolveContainerLogisticsSpec(containerKind);
  if (!spec) {
    return { reachable: false, blockedBySlotIndex: null, blockedBySubSlot: null, blockedBy: [], reason: "invalid_container" };
  }
  if (!Number.isInteger(slotIndex)) {
    return { reachable: false, blockedBySlotIndex: null, blockedBySubSlot: null, blockedBy: [], reason: "invalid_slot" };
  }
  const idx = slotIndex;
  if (idx < 0 || idx >= spec.slots.length) {
    return { reachable: false, blockedBySlotIndex: null, blockedBySubSlot: null, blockedBy: [], reason: "invalid_slot" };
  }
  if (!Number.isInteger(subSlot) || subSlot !== 0) {
    return { reachable: false, blockedBySlotIndex: null, blockedBySubSlot: null, blockedBy: [], reason: "invalid_subslot" };
  }
  if (!isUnifiedFullPalletSize(palletSize)) {
    return { reachable: false, blockedBySlotIndex: null, blockedBySubSlot: null, blockedBy: [], reason: "invalid_pallet_size" };
  }
  const occupied = normalizeOccupiedBoxes(spec.slots, occupiedSlots);
  const existing = occupied.find((o) => o.slotIndex === idx);
  if (existing) {
    return {
      reachable: false,
      blockedBySlotIndex: idx,
      blockedBySubSlot: 0,
      blockedBy: [{ slotIndex: idx, subSlot: 0 }],
      reason: "slot_occupied",
    };
  }
  const cand = getSlotSubBox(spec.slots[idx], "full", 0);
  const res = evaluateCorridorFromDoor(cand, occupied, spec.interior.halfW);
  return {
    ...res,
    reason: res.reachable ? null : "blocked",
  };
}

export function findNearestForkEngageTarget(jackPose, targets, options = {}) {
  if (!jackPose || typeof jackPose !== "object" || !Array.isArray(targets) || targets.length === 0) {
    return null;
  }
  const jx = jackPose.x;
  const jy = jackPose.y;
  const jh = typeof jackPose.heading === "number" && Number.isFinite(jackPose.heading) ? jackPose.heading : 0.0;
  if (typeof jx !== "number" || !Number.isFinite(jx) || typeof jy !== "number" || !Number.isFinite(jy)) {
    return null;
  }

  const forkOffset =
    typeof options.forkOffset === "number" && Number.isFinite(options.forkOffset) ? options.forkOffset : 0.0;
  const refX = jx + Math.sin(jh) * forkOffset;
  const refY = jy + Math.cos(jh) * forkOffset;

  const maxDist =
    typeof options.maxDist === "number" && Number.isFinite(options.maxDist)
      ? options.maxDist
      : PALLET_JACK_SPECS.assistMaxDistM;
  const maxYawRad =
    typeof options.maxYawRad === "number" && Number.isFinite(options.maxYawRad)
      ? options.maxYawRad
      : PALLET_JACK_SPECS.assistMaxYawRad;
  const includeBlocked = Boolean(options.includeBlocked);
  const includeMisaligned = Boolean(options.includeMisaligned);

  let best = null;
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    if (!t || typeof t !== "object") {
      continue;
    }
    if (typeof t.x !== "number" || !Number.isFinite(t.x) || typeof t.y !== "number" || !Number.isFinite(t.y)) {
      continue;
    }
    if (t.reachable === false && !includeBlocked) {
      continue;
    }

    const dist = Math.hypot(t.x - refX, t.y - refY);
    if (dist > maxDist) {
      continue;
    }

    const th = typeof t.heading === "number" && Number.isFinite(t.heading) ? t.heading : 0.0;
    const isFourWay = t.fourWay !== false && options.fourWay !== false;
    let yawDelta;
    let alignedHeading;

    if (!isFourWay) {
      if (t.bidirectional) {
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
    if (!aligned && !includeMisaligned) {
      continue;
    }

    if (
      !best ||
      dist < best.dist - 1e-6 ||
      (Math.abs(dist - best.dist) <= 1e-6 && absYawDelta < best.absYawDelta)
    ) {
      best = {
        target: t,
        index: i,
        dist,
        yawDelta,
        absYawDelta,
        alignedHeading,
        inRange: dist <= maxDist,
        aligned,
        canEngage: dist <= maxDist && aligned && t.reachable !== false,
      };
    }
  }

  return best;
}
