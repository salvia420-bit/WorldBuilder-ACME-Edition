/**
 * Pure deterministic ISO 668 / ISO 6780 / ISO 3691-5 container interior LIFO
 * pinwheel solver & GMA pallet-jack alignment assist.
 *
 * 1:1 parity twin of ACE `ContainerLogistics.cs`.
 * Zero external, DOM, Three.js, or `container_models.js` imports.
 */

export const GMA_PALLET_SPECS = Object.freeze({
  full: Object.freeze({ width: 1.2192, depth: 1.0160, height: 0.1397 }),
  half: Object.freeze({ width: 0.6096, depth: 1.0160, height: 0.1397 }),
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

export const HALF_PALLET_WCIDS = new Set([4000013, 4000015, 4000016, 4000017]);

const SPEC_20FT = Object.freeze({
  kind: 10,
  width: 2.352,
  length: 5.898,
  halfW: 1.176,
  halfL: 2.949,
  floorZ: 0.162,
  maxFull: 10,
  maxHalf: 20,
});

const SPEC_40FT = Object.freeze({
  kind: 11,
  width: 2.352,
  length: 12.032,
  halfW: 1.176,
  halfL: 6.016,
  floorZ: 0.162,
  maxFull: 21,
  maxHalf: 42,
});

const SPEC_40HC = Object.freeze({
  kind: 12,
  width: 2.352,
  length: 12.032,
  halfW: 1.176,
  halfL: 6.016,
  floorZ: 0.162,
  maxFull: 21,
  maxHalf: 42,
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

// Frozen copy of 20-ft Pinwheel Bay Floor Layout (10 Full GMA Slots)
export const PINWHEEL_SLOTS_20 = Object.freeze([
  Object.freeze({ slotIndex: 0, x: -0.5080, y: +2.3889, orient: "X", dx: 1.2192, dy: 1.0160 }),
  Object.freeze({ slotIndex: 1, x: +0.6096, y: +2.2873, orient: "Y", dx: 1.0160, dy: 1.2192 }),
  Object.freeze({ slotIndex: 2, x: +0.5080, y: +1.1697, orient: "X", dx: 1.2192, dy: 1.0160 }),
  Object.freeze({ slotIndex: 3, x: -0.6096, y: +1.2713, orient: "Y", dx: 1.0160, dy: 1.2192 }),
  Object.freeze({ slotIndex: 4, x: -0.5080, y: +0.1016, orient: "X", dx: 1.2192, dy: 1.0160 }),
  Object.freeze({ slotIndex: 5, x: +0.6096, y: -0.0000, orient: "Y", dx: 1.0160, dy: 1.2192 }),
  Object.freeze({ slotIndex: 6, x: +0.5080, y: -1.1176, orient: "X", dx: 1.2192, dy: 1.0160 }),
  Object.freeze({ slotIndex: 7, x: -0.6096, y: -1.0160, orient: "Y", dx: 1.0160, dy: 1.2192 }),
  Object.freeze({ slotIndex: 8, x: -0.5080, y: -2.2873, orient: "Y", dx: 1.0160, dy: 1.2192 }),
  Object.freeze({ slotIndex: 9, x: +0.5080, y: -2.2873, orient: "Y", dx: 1.0160, dy: 1.2192 }),
]);

// Frozen copy of 40-ft / 40HC Pinwheel Bay Floor Layout (21 Full GMA Slots)
export const PINWHEEL_SLOTS_40 = Object.freeze((() => {
  const slots = [];
  const quadCenters = [+4.8768, +2.6416, +0.4064, -1.8288];
  for (let q = 0; q < quadCenters.length; q++) {
    const yc = quadCenters[q];
    slots.push(
      Object.freeze({ slotIndex: 4 * q + 0, x: -0.5080, y: yc + 0.6096, orient: "X", dx: 1.2192, dy: 1.0160 }),
      Object.freeze({ slotIndex: 4 * q + 1, x: +0.6096, y: yc + 0.5080, orient: "Y", dx: 1.0160, dy: 1.2192 }),
      Object.freeze({ slotIndex: 4 * q + 2, x: +0.5080, y: yc - 0.6096, orient: "X", dx: 1.2192, dy: 1.0160 }),
      Object.freeze({ slotIndex: 4 * q + 3, x: -0.6096, y: yc - 0.5080, orient: "Y", dx: 1.0160, dy: 1.2192 })
    );
  }
  slots.push(
    Object.freeze({ slotIndex: 16, x: -0.5368, y: -3.4544, orient: "X", dx: 1.2192, dy: 1.0160 }),
    Object.freeze({ slotIndex: 17, x: -0.5368, y: -4.4704, orient: "X", dx: 1.2192, dy: 1.0160 }),
    Object.freeze({ slotIndex: 18, x: -0.5368, y: -5.4864, orient: "X", dx: 1.2192, dy: 1.0160 }),
    Object.freeze({ slotIndex: 19, x: +0.6384, y: -3.5560, orient: "Y", dx: 1.0160, dy: 1.2192 }),
    Object.freeze({ slotIndex: 20, x: +0.6384, y: -4.7752, orient: "Y", dx: 1.0160, dy: 1.2192 })
  );
  return Object.freeze(slots);
})());

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

function isHalfPalletSize(palletSize, cargoWcid = 0) {
  if (palletSize === "half" || palletSize === "Half" || palletSize === 1) {
    return true;
  }
  if (palletSize === "full" || palletSize === "Full" || palletSize === 2) {
    return false;
  }
  if (typeof cargoWcid === "number" && HALF_PALLET_WCIDS.has(Math.trunc(cargoWcid))) {
    return true;
  }
  return false;
}

export function getSlotSubBox(slotDef, palletSize = "full", subSlot = 0) {
  const half = isHalfPalletSize(palletSize, 0);
  if (!half) {
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

  const sub = Math.trunc(subSlot) === 1 ? 1 : 0;
  const off = sub === 1 ? 0.3048 : -0.3048;
  let cx;
  let cy;
  let dx;
  let dy;
  if (slotDef.orient === "Y") {
    // slotGroup.rotation.z = +pi/2 maps local (off, 0) -> (0, off)
    cx = slotDef.x;
    cy = slotDef.y + off;
    dx = GMA_PALLET_SPECS.half.depth; // 1.0160
    dy = GMA_PALLET_SPECS.half.width; // 0.6096
  } else {
    cx = slotDef.x + off;
    cy = slotDef.y;
    dx = GMA_PALLET_SPECS.half.width; // 0.6096
    dy = GMA_PALLET_SPECS.half.depth; // 1.0160
  }
  const hx = dx * 0.5;
  const hy = dy * 0.5;
  return {
    slotIndex: slotDef.slotIndex,
    subSlot: sub,
    palletSize: "half",
    x: cx,
    y: cy,
    dx,
    dy,
    orient: slotDef.orient,
    x0: cx - hx,
    x1: cx + hx,
    y0: cy - hy,
    y1: cy + hy,
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
    const cargoWcid = raw.cargoWcid ?? raw.CargoWcid ?? raw.wcid ?? 0;
    const rawSize = raw.palletSize ?? raw.PalletSize;
    if (rawSize === 0 || rawSize === "none" || rawSize === "None") {
      continue;
    }
    const half = isHalfPalletSize(rawSize, cargoWcid);
    const subSlot = half ? ((Math.trunc(raw.subSlot ?? raw.SubSlot ?? 0) === 1) ? 1 : 0) : 0;
    const key = `${slotIndex}:${half ? subSlot : "F"}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const box = getSlotSubBox(slots[slotIndex], half ? "half" : "full", subSlot);
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

function buildOccupancyIndex(occupied) {
  const fullSet = new Set();
  const halfMap = new Map();
  for (let i = 0; i < occupied.length; i++) {
    const o = occupied[i];
    if (o.palletSize === "full") {
      fullSet.add(o.slotIndex);
    } else {
      let subs = halfMap.get(o.slotIndex);
      if (!subs) {
        subs = new Set();
        halfMap.set(o.slotIndex, subs);
      }
      subs.add(o.subSlot);
    }
  }
  return { fullSet, halfMap };
}

export function computeReachableLoadSlots(containerKind, occupiedSlots, palletSize = "full") {
  const spec = resolveContainerLogisticsSpec(containerKind);
  if (!spec) {
    return { reachable: [], blocked: [], all: [] };
  }
  const occupied = normalizeOccupiedBoxes(spec.slots, occupiedSlots);
  const { fullSet, halfMap } = buildOccupancyIndex(occupied);
  const wantHalf = isHalfPalletSize(palletSize, 0);

  const candidates = [];
  for (let i = 0; i < spec.slots.length; i++) {
    const slotDef = spec.slots[i];
    if (fullSet.has(slotDef.slotIndex)) {
      continue;
    }
    const subs = halfMap.get(slotDef.slotIndex);
    if (!wantHalf) {
      if (subs && subs.size > 0) {
        continue;
      }
      candidates.push(getSlotSubBox(slotDef, "full", 0));
    } else {
      for (let sub = 0; sub <= 1; sub++) {
        if (subs && subs.has(sub)) {
          continue;
        }
        candidates.push(getSlotSubBox(slotDef, "half", sub));
      }
    }
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
  if (typeof slotIndex !== "number" || !Number.isFinite(slotIndex)) {
    return { reachable: false, blockedBySlotIndex: null, blockedBySubSlot: null, blockedBy: [], reason: "invalid_slot" };
  }
  const idx = Math.trunc(slotIndex);
  if (idx < 0 || idx >= spec.slots.length) {
    return { reachable: false, blockedBySlotIndex: null, blockedBySubSlot: null, blockedBy: [], reason: "invalid_slot" };
  }
  if (typeof subSlot !== "number" || !Number.isFinite(subSlot)) {
    return { reachable: false, blockedBySlotIndex: null, blockedBySubSlot: null, blockedBy: [], reason: "invalid_subslot" };
  }
  const rawSub = Math.trunc(subSlot);
  if (rawSub < 0 || rawSub > 1) {
    return { reachable: false, blockedBySlotIndex: null, blockedBySubSlot: null, blockedBy: [], reason: "invalid_subslot" };
  }
  const occupied = normalizeOccupiedBoxes(spec.slots, occupiedSlots);
  const slotMatches = occupied.filter((o) => o.slotIndex === idx);
  const fullTarget = slotMatches.find((o) => o.palletSize === "full");
  if (fullTarget) {
    if (rawSub !== 0) {
      return { reachable: false, blockedBySlotIndex: null, blockedBySubSlot: null, blockedBy: [], reason: "invalid_subslot" };
    }
    const res = evaluateCorridorFromDoor(fullTarget, occupied, spec.interior.halfW);
    return {
      ...res,
      reason: res.reachable ? null : "blocked",
    };
  }
  const target = slotMatches.find((o) => o.subSlot === rawSub);
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
  if (typeof slotIndex !== "number" || !Number.isFinite(slotIndex)) {
    return { reachable: false, blockedBySlotIndex: null, blockedBySubSlot: null, blockedBy: [], reason: "invalid_slot" };
  }
  const idx = Math.trunc(slotIndex);
  if (idx < 0 || idx >= spec.slots.length) {
    return { reachable: false, blockedBySlotIndex: null, blockedBySubSlot: null, blockedBy: [], reason: "invalid_slot" };
  }
  if (typeof subSlot !== "number" || !Number.isFinite(subSlot)) {
    return { reachable: false, blockedBySlotIndex: null, blockedBySubSlot: null, blockedBy: [], reason: "invalid_subslot" };
  }
  const rawSub = Math.trunc(subSlot);
  if (rawSub < 0 || rawSub > 1) {
    return { reachable: false, blockedBySlotIndex: null, blockedBySubSlot: null, blockedBy: [], reason: "invalid_subslot" };
  }
  const validPalletSize =
    palletSize === "full" ||
    palletSize === "Full" ||
    palletSize === 2 ||
    palletSize === "half" ||
    palletSize === "Half" ||
    palletSize === 1;
  if (!validPalletSize) {
    return { reachable: false, blockedBySlotIndex: null, blockedBySubSlot: null, blockedBy: [], reason: "invalid_pallet_size" };
  }
  const wantHalf = isHalfPalletSize(palletSize, 0);
  if (!wantHalf && rawSub !== 0) {
    return { reachable: false, blockedBySlotIndex: null, blockedBySubSlot: null, blockedBy: [], reason: "invalid_subslot" };
  }
  const sub = wantHalf ? rawSub : 0;
  const occupied = normalizeOccupiedBoxes(spec.slots, occupiedSlots);
  const { fullSet, halfMap } = buildOccupancyIndex(occupied);
  if (fullSet.has(idx)) {
    return { reachable: false, blockedBySlotIndex: idx, blockedBySubSlot: 0, blockedBy: [{ slotIndex: idx, subSlot: 0 }], reason: "slot_occupied" };
  }
  const subs = halfMap.get(idx);
  if (!wantHalf && subs && subs.size > 0) {
    const firstSub = Array.from(subs).sort()[0];
    return { reachable: false, blockedBySlotIndex: idx, blockedBySubSlot: firstSub, blockedBy: [{ slotIndex: idx, subSlot: firstSub }], reason: "slot_occupied" };
  }
  if (wantHalf && subs && subs.has(sub)) {
    return { reachable: false, blockedBySlotIndex: idx, blockedBySubSlot: sub, blockedBy: [{ slotIndex: idx, subSlot: sub }], reason: "slot_occupied" };
  }
  const cand = getSlotSubBox(spec.slots[idx], wantHalf ? "half" : "full", sub);
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
