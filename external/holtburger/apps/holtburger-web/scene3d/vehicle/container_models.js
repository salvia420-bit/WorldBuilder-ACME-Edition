// scene3d/vehicle/container_models.js — ISO Shipping Container 3D Models & Walkable Scene Integration
// Conforms to ISO 668, ISO 1496-1, ISO 1161, ISO 6346, and ANSI MH1 / ISO 6780.
// Authentic 3D procedural models for 20ft Standard (1CC / 22G1), 40ft Standard (1AA / 42G1),
// and 40ft High Cube (1AAA / 45G1) containers with AGX HDR PBR MeshStandardMaterial,
// vertex-colored details, 270° twin cargo doors, fold-down walkable loading ramp,
// pinwheel GMA pallet bay with dynamic interior culling, and 3-cascade CSM shader patching.
// Strict GPU invariants: <= 8 base draw calls, 0 dynamic THREE.Light instances.

import * as THREE_DEFAULT from "three";
import { installCsmShaderPatch } from "../materials.js";
import {
  buildPallet,
  buildDeployable,
  GeomAcc,
  makeLampsMaterial,
  disposeRootResources,
} from "./deployable_models.js";
import { buildDeployedRadar } from "./radar_model.js";
import {
  ECONOMY_CONTAINER_WCID,
  ECONOMY_CONTAINER_KIND,
  SPECIALIZED_CONTAINER_SPECS,
  resolveEconomyWcid,
} from "./economy_specs.js";

// ---------------------------------------------------------------------------
// Authoritative Specifications & Identification Constants
// ---------------------------------------------------------------------------

export const CONTAINER_WCID = Object.freeze({
  IsoContainer20: 4000020,
  IsoContainer40: 4000021,
  IsoContainer40HC: 4000022,
  ...ECONOMY_CONTAINER_WCID,
});

export const DEPLOYABLE_KIND = Object.freeze({
  IsoContainer20: 10,
  IsoContainer40: 11,
  IsoContainer40HC: 12,
  ...ECONOMY_CONTAINER_KIND,
});
export const CONTAINER_KINDS = DEPLOYABLE_KIND;

export const ISO_CONTAINER_SPECS = Object.freeze({
  [CONTAINER_WCID.IsoContainer20]: Object.freeze({
    name: "20-ft Standard ISO Container (1CC / 22G1)",
    wcid: 4000020,
    kind: 10,
    isoGroup: "22G1",
    isoType: "1CC",
    external: Object.freeze({ width: 2.438, length: 6.058, height: 2.591 }),
    internal: Object.freeze({ width: 2.352, length: 5.898, height: 2.393 }),
    door: Object.freeze({ width: 2.340, height: 2.280 }),
    floorZ: 0.162,
    roofZ: 2.591,
    palletCapacity: Object.freeze({ full: 10, standard: 10 }),
    hasForkliftPockets: true,
    forkliftPockets: Object.freeze({ centerDistance: 2.050, width: 0.356, height: 0.115 }),
    hasGooseneckTunnel: false,
    hasHazardChevrons: false,
    cornerCastingsCenter: Object.freeze({ width: 2.259, length: 5.853 }),
  }),
  [CONTAINER_WCID.IsoContainer40]: Object.freeze({
    name: "40-ft Standard ISO Container (1AA / 42G1)",
    wcid: 4000021,
    kind: 11,
    isoGroup: "42G1",
    isoType: "1AA",
    external: Object.freeze({ width: 2.438, length: 12.192, height: 2.591 }),
    internal: Object.freeze({ width: 2.352, length: 12.032, height: 2.393 }),
    door: Object.freeze({ width: 2.340, height: 2.280 }),
    floorZ: 0.162,
    roofZ: 2.591,
    palletCapacity: Object.freeze({ full: 20, standard: 20 }),
    hasForkliftPockets: false, // Strictly prohibited per ISO 1496-1
    hasGooseneckTunnel: false,
    hasHazardChevrons: false,
    cornerCastingsCenter: Object.freeze({ width: 2.259, length: 11.985 }),
  }),
  [CONTAINER_WCID.IsoContainer40HC]: Object.freeze({
    name: "40-ft High-Cube ISO Container (1AAA / 45G1)",
    wcid: 4000022,
    kind: 12,
    isoGroup: "45G1",
    isoType: "1AAA",
    external: Object.freeze({ width: 2.438, length: 12.192, height: 2.896 }),
    internal: Object.freeze({ width: 2.352, length: 12.032, height: 2.698 }),
    door: Object.freeze({ width: 2.340, height: 2.585 }),
    floorZ: 0.162,
    roofZ: 2.896,
    palletCapacity: Object.freeze({ full: 20, standard: 20 }),
    hasForkliftPockets: false,
    hasGooseneckTunnel: true,
    gooseneckTunnel: Object.freeze({ length: 3.150, width: 1.020, height: 0.120 }),
    hasHazardChevrons: true, // Yellow/Black corner hazard chevrons per ISO 6346
    cornerCastingsCenter: Object.freeze({ width: 2.259, length: 11.985 }),
  }),
  ...SPECIALIZED_CONTAINER_SPECS,
});

export const CONTAINER_LIVERIES = Object.freeze({
  maritimeBlue: Object.freeze({ name: "Maritime Blue", hex: 0x0f385e, rgb: [15, 56, 94] }),
  cortenRed: Object.freeze({ name: "Corten Oxide Red", hex: 0x853826, rgb: [133, 56, 38] }),
  evergreen: Object.freeze({ name: "Evergreen", hex: 0x1a472a, rgb: [26, 71, 42] }),
  oliveDrab: Object.freeze({ name: "Olive Drab", hex: 0x4b5320, rgb: [75, 83, 32] }),
  desertTan: Object.freeze({ name: "Desert Tan", hex: 0xc2b280, rgb: [194, 178, 128] }),
  industrialAmber: Object.freeze({ name: "Industrial Amber", hex: 0xb87333, rgb: [184, 115, 51] }),
});

export const LIVERY_INDEX_MAP = Object.freeze([
  "maritimeBlue",
  "cortenRed",
  "evergreen",
  "oliveDrab",
  "desertTan",
  "industrialAmber",
]);

export function getLivery(idOrKey) {
  if (typeof idOrKey === "number") {
    const key = LIVERY_INDEX_MAP[idOrKey] || "maritimeBlue";
    return CONTAINER_LIVERIES[key] || CONTAINER_LIVERIES.maritimeBlue;
  }
  if (typeof idOrKey === "string" && CONTAINER_LIVERIES[idOrKey]) {
    return CONTAINER_LIVERIES[idOrKey];
  }
  return CONTAINER_LIVERIES.maritimeBlue;
}

const UNIFIED_PALLET_DIMS = Object.freeze({ width: 1.100, depth: 1.100, height: 0.145 });

export const GMA_PALLET_SPECS = Object.freeze({
  standard: UNIFIED_PALLET_DIMS,
  full: UNIFIED_PALLET_DIMS,
  deckZOffset: 0.307, // floorZ (0.162) + pallet height (0.145)
  stowedCeilingH: 2.05, // clears 2.28m door even when raised +0.077m on pallet jack forks
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

// 20-ft Reefer (22R1) 8-slot refrigerated bay (front bulkhead/machinery occupies +2.320 row)
export const CONTAINER_SLOTS_REEFER_20 = Object.freeze((() => {
  const rows = [+1.160, 0.000, -1.160, -2.320];
  const slots = [];
  for (let r = 0; r < rows.length; r++) {
    slots.push(
      Object.freeze({ slotIndex: r * 2 + 0, x: -0.575, y: rows[r], orient: "Y", dx: 1.100, dy: 1.100 }),
      Object.freeze({ slotIndex: r * 2 + 1, x: +0.575, y: rows[r], orient: "Y", dx: 1.100, dy: 1.100 })
    );
  }
  return slots;
})());

// 40-ft HC Reefer (45R1) 18-slot refrigerated bay (skips front machinery row r = 0)
export const CONTAINER_SLOTS_REEFER_40 = Object.freeze((() => {
  const slots = [];
  for (let r = 1; r < 10; r++) {
    const y = (4.5 - r) * 1.180;
    const idx = r - 1;
    slots.push(
      Object.freeze({ slotIndex: idx * 2 + 0, x: -0.575, y, orient: "Y", dx: 1.100, dy: 1.100 }),
      Object.freeze({ slotIndex: idx * 2 + 1, x: +0.575, y, orient: "Y", dx: 1.100, dy: 1.100 })
    );
  }
  return slots;
})());

export const PINWHEEL_SLOTS_20 = CONTAINER_SLOTS_20;
export const PINWHEEL_SLOTS_40 = CONTAINER_SLOTS_40;

function slotsForSpec(spec) {
  if (!spec) return CONTAINER_SLOTS_20;
  if (spec.kind === 30) return CONTAINER_SLOTS_REEFER_20;
  if (spec.kind === 31) return CONTAINER_SLOTS_REEFER_40;
  if (spec.kind === 32 || spec.kind === 33) return [];
  return spec.external.length < 7.0 ? CONTAINER_SLOTS_20 : CONTAINER_SLOTS_40;
}

// ---------------------------------------------------------------------------
// ISO 6346 Modulo-11 Check Digit Algorithm
// ---------------------------------------------------------------------------

export const ISO6346_LETTER_MAP = Object.freeze({
  A: 10, B: 12, C: 13, D: 14, E: 15, F: 16, G: 17, H: 18, I: 19, J: 20,
  K: 21, L: 23, M: 24, N: 25, O: 26, P: 27, Q: 28, R: 29, S: 30, T: 31,
  U: 32, V: 34, W: 35, X: 36, Y: 37, Z: 38,
});

export function computeIso6346CheckDigit(arg1, arg2, arg3) {
  let combined = "";
  if (arg3 !== undefined) {
    const s1 = String(arg1).trim();
    const s2 = String(arg2).trim();
    const s3 = String(arg3).trim();
    if (/[^A-Za-z]/.test(s1) || /[^A-Za-z]/.test(s2) || /[^0-9]/.test(s3)) {
      throw new Error(`Invalid ISO 6346 characters: "${arg1}", "${arg2}", "${arg3}"`);
    }
    if (s1.length !== 3 || s2.length !== 1 || s3.length !== 6) {
      throw new Error(`Invalid ISO 6346 format: "${arg1}" "${arg2}" "${arg3}"`);
    }
    combined = (s1 + s2).toUpperCase() + s3;
  } else if (arg2 !== undefined) {
    const s1 = String(arg1).trim();
    const s2 = String(arg2).trim();
    if (/[^A-Za-z]/.test(s1) || /[^0-9]/.test(s2)) {
      throw new Error(`Invalid ISO 6346 characters: "${arg1}", "${arg2}"`);
    }
    if (s1.length !== 4 || s2.length !== 6) {
      throw new Error(`Invalid ISO 6346 format: "${arg1}" "${arg2}"`);
    }
    combined = s1.toUpperCase() + s2;
  } else {
    const raw = String(arg1).trim();
    if (/[^A-Za-z0-9 -]/.test(raw)) {
      throw new Error(`Invalid ISO 6346 characters: "${raw}"`);
    }
    const cleaned = raw.toUpperCase().replace(/[\s-]/g, "");
    if (cleaned.length === 10) {
      combined = cleaned;
    } else if (cleaned.length === 11 && /^[A-Z]{4}\d{7}$/.test(cleaned)) {
      combined = cleaned.slice(0, 10);
    } else {
      throw new Error(`Invalid ISO 6346 input length (${cleaned.length}): "${cleaned}"`);
    }
  }

  const prefix = combined.slice(0, 4);
  const serial = combined.slice(4, 10);
  if (!/^[A-Z]{4}$/.test(prefix) || !/^\d{6}$/.test(serial)) {
    throw new Error(`Invalid ISO 6346 format: "${combined}"`);
  }

  let sum = 0;
  for (let i = 0; i < 10; i++) {
    const ch = combined[i];
    let val;
    if (ch >= "0" && ch <= "9") {
      val = parseInt(ch, 10);
    } else {
      val = ISO6346_LETTER_MAP[ch];
      if (val === undefined) throw new Error(`Invalid character: ${ch}`);
    }
    sum += val * Math.pow(2, i);
  }
  const remainder = sum % 11;
  return remainder % 10; // Remainder 10 wraps to 0 per ISO 6346 standard
}

// ---------------------------------------------------------------------------
// Linear Vertex-Colored Geometry Shading & Merging Helpers
// ---------------------------------------------------------------------------

function shadePart(t, rawGeom, hexColor, { rx = 0, ry = 0, rz = 0, tx = 0, ty = 0, tz = 0 } = {}) {
  const g = rawGeom.index ? rawGeom.toNonIndexed() : rawGeom.clone();
  rawGeom.dispose();
  if (rx) g.rotateX(rx);
  if (ry) g.rotateY(ry);
  if (rz) g.rotateZ(rz);
  if (tx || ty || tz) g.translate(tx, ty, tz);
  g.computeVertexNormals();

  for (const name of Object.keys(g.attributes)) {
    if (name !== "position" && name !== "normal") g.deleteAttribute(name);
  }

  const pos = g.getAttribute("position");
  const col = new Float32Array(pos.count * 3);
  const base = new t.Color(hexColor);

  for (let i = 0; i < pos.count; i++) {
    col[i * 3 + 0] = base.r;
    col[i * 3 + 1] = base.g;
    col[i * 3 + 2] = base.b;
  }
  g.setAttribute("color", new t.BufferAttribute(col, 3));
  return g;
}

function mergeParts(t, parts) {
  let totalVerts = 0;
  for (const p of parts) totalVerts += p.getAttribute("position").count;
  const posOut = new Float32Array(totalVerts * 3);
  const nrmOut = new Float32Array(totalVerts * 3);
  const colOut = new Float32Array(totalVerts * 3);
  let offset = 0;
  for (const p of parts) {
    const pa = p.getAttribute("position").array;
    const na = p.getAttribute("normal").array;
    const ca = p.getAttribute("color").array;
    posOut.set(pa, offset);
    nrmOut.set(na, offset);
    colOut.set(ca, offset);
    offset += pa.length;
    p.dispose();
  }
  const merged = new t.BufferGeometry();
  merged.setAttribute("position", new t.BufferAttribute(posOut, 3));
  merged.setAttribute("normal", new t.BufferAttribute(nrmOut, 3));
  merged.setAttribute("color", new t.BufferAttribute(colOut, 3));
  merged.computeBoundingBox();
  merged.computeBoundingSphere();
  return merged;
}

function zBox(t, dx, dy, dz, hex, x = 0, y = 0, z = 0, rot = {}) {
  return shadePart(t, new t.BoxGeometry(dx, dy, dz), hex, {
    rx: rot.rx || 0,
    ry: rot.ry || 0,
    rz: rot.rz || 0,
    tx: x,
    ty: y,
    tz: z,
  });
}

function zCyl(t, r, h, segs, hex, x = 0, y = 0, z = 0, rot = {}) {
  return shadePart(t, new t.CylinderGeometry(r, r, h, segs), hex, {
    rx: rot.rx || 0,
    ry: rot.ry || 0,
    rz: rot.rz || 0,
    tx: x,
    ty: y,
    tz: z,
  });
}

function resolveContainerWcid(typeOrWcid) {
  if (
    typeOrWcid === 4000020 ||
    typeOrWcid === 10 ||
    typeOrWcid === "20ft" ||
    typeOrWcid === "22G1" ||
    typeOrWcid === "1CC" ||
    typeOrWcid === "IsoContainer20"
  ) {
    return CONTAINER_WCID.IsoContainer20;
  }
  if (
    typeOrWcid === 4000021 ||
    typeOrWcid === 11 ||
    typeOrWcid === "40ft" ||
    typeOrWcid === "42G1" ||
    typeOrWcid === "1AA" ||
    typeOrWcid === "IsoContainer40"
  ) {
    return CONTAINER_WCID.IsoContainer40;
  }
  if (
    typeOrWcid === 4000022 ||
    typeOrWcid === 12 ||
    typeOrWcid === "40HC" ||
    typeOrWcid === "45G1" ||
    typeOrWcid === "1AAA" ||
    typeOrWcid === "IsoContainer40HC"
  ) {
    return CONTAINER_WCID.IsoContainer40HC;
  }
  if (typeof typeOrWcid === "number" && ISO_CONTAINER_SPECS[typeOrWcid]) {
    return typeOrWcid;
  }
  const ecoWcid = resolveEconomyWcid(typeOrWcid);
  if (ecoWcid && SPECIALIZED_CONTAINER_SPECS[ecoWcid]) {
    return ecoWcid;
  }
  return CONTAINER_WCID.IsoContainer20;
}

// ---------------------------------------------------------------------------
// ISO Container 3D Model Procedural Builder
// ---------------------------------------------------------------------------

export function buildIsoContainer(three, typeOrWcid = CONTAINER_WCID.IsoContainer20, options = {}) {
  const t = three || THREE_DEFAULT;
  const wcid = resolveContainerWcid(typeOrWcid);
  const spec = ISO_CONTAINER_SPECS[wcid];
  if (!spec) throw new Error(`Unknown container WCID: ${wcid}`);

  const hasExplicitLivery =
    options.livery !== undefined || options.liveryId !== undefined || options.liveryKey !== undefined;
  const liveryKey = options.livery ?? options.liveryId ?? options.liveryKey ?? "maritimeBlue";
  const livery = getLivery(liveryKey);
  const baseHex = !hasExplicitLivery && spec.defaultLiveryHex ? spec.defaultLiveryHex : livery.hex;
  const variant = spec.variant || "box";
  const is20Size = spec.external.length < 7.0;

  // Root container group
  const root = new t.Group();
  root.name = `iso-container-${spec.isoGroup}-root`;
  root.userData = { wcid, kind: spec.kind, spec, livery: livery.name };

  const W = spec.external.width;
  const L = spec.external.length;
  const H = spec.external.height;
  const halfW = W / 2;
  const halfL = L / 2;

  // =========================================================================
  // SUB-MESH 1: Container Outer Shell / Tank / Flat-Rack Frame & Pockets
  // =========================================================================
  const bodyParts = [];
  const wallThick = 0.043; // Corrugation peak-to-valley thickness
  const railH = 0.140;     // Bottom side rail height
  const topRailH = 0.060;  // Top side rail height
  const postW = 0.150;     // Corner post width
  const wallZ = spec.floorZ + spec.internal.height / 2;
  const wallH = spec.internal.height;
  const wallL = L - 0.16;
  const ribColor = new t.Color(baseHex).multiplyScalar(0.92).getHex();

  if (variant === "tank" || variant === "gasTank") {
    // ISO 1496-3 skeletal frame + cylindrical tank + saddle cradles + walkway
    const frameHex = variant === "gasTank" ? 0x2c363e : 0x2f4354;
    const tankLen = L - 0.55;
    const tankR = variant === "gasTank" ? 0.96 : 1.02;
    const tankZ = H * 0.52;
    bodyParts.push(zCyl(t, tankR, tankLen, 20, baseHex, 0, 0, tankZ));
    // End dome caps & top manway / relief valve housing
    bodyParts.push(zCyl(t, tankR * 0.72, 0.16, 16, baseHex, 0, tankLen * 0.5 + 0.08, tankZ));
    bodyParts.push(zCyl(t, tankR * 0.72, 0.16, 16, baseHex, 0, -tankLen * 0.5 - 0.08, tankZ));
    bodyParts.push(zCyl(t, 0.28, 0.16, 12, 0x7e8790, 0, 0.6, tankZ + tankR + 0.05, { rx: Math.PI * 0.5 }));
    if (variant === "gasTank") {
      // Sunshield upper canopy + dual relief manifold
      bodyParts.push(zBox(t, 1.50, tankLen * 0.85, 0.03, 0xf2f4f6, 0, 0, H - 0.06));
      bodyParts.push(zCyl(t, 0.18, 0.22, 10, 0xd99b18, 0, -0.7, tankZ + tankR + 0.06, { rx: Math.PI * 0.5 }));
    }
    // Top inspection walkway
    bodyParts.push(zBox(t, 0.42, L - 0.40, 0.025, 0x565c62, -0.35, 0, H - 0.09));
    // End portal frames & saddle cradles
    for (const sy of [-1.8, 1.8]) {
      bodyParts.push(zBox(t, 1.70, 0.16, 0.55, frameHex, 0, sy, 0.44));
    }
    for (const sy of [-halfL + 0.08, halfL - 0.08]) {
      bodyParts.push(zBox(t, W - 0.18, 0.10, 0.12, frameHex, 0, sy, H - 0.06));
      bodyParts.push(zBox(t, W - 0.18, 0.10, 0.14, frameHex, 0, sy, 0.07));
    }
  } else if (variant === "flatRack") {
    // 22P1 / 42P1 heavy steel I-beam deck + reinforced end bulkheads (no side walls/roof)
    bodyParts.push(zBox(t, W - 0.08, L - 0.16, spec.floorZ - 0.02, 0x353b40, 0, 0, (spec.floorZ - 0.02) * 0.5));
    for (const sy of [-halfL + 0.09, halfL - 0.09]) {
      bodyParts.push(zBox(t, W - 0.20, 0.12, wallH, baseHex, 0, sy, spec.floorZ + wallH * 0.5));
    }
  } else {
    // Box variants: standard, reefer (22R1/45R1), dryBulk (22B0), openTop (22U1)
    bodyParts.push(zBox(t, wallThick, wallL, wallH, baseHex, -halfW + wallThick / 2, 0, wallZ));
    bodyParts.push(zBox(t, wallThick, wallL, wallH, baseHex, halfW - wallThick / 2, 0, wallZ));
    if (variant !== "reefer") {
      const ribCount = is20Size ? 24 : 48;
      const ribStep = wallL / (ribCount + 1);
      for (let i = 1; i <= ribCount; i++) {
        const ry = -wallL / 2 + i * ribStep;
        bodyParts.push(zBox(t, 0.015, 0.035, wallH - 0.04, ribColor, -halfW + wallThick + 0.005, ry, wallZ));
        bodyParts.push(zBox(t, 0.015, 0.035, wallH - 0.04, ribColor, halfW - wallThick - 0.005, ry, wallZ));
      }
    }
    const frontY = halfL - wallThick / 2;
    bodyParts.push(zBox(t, spec.internal.width, wallThick, wallH, baseHex, 0, frontY, wallZ));
    if (variant === "reefer") {
      // Front +Y refrigeration machinery condenser/evaporator pack & bulkhead
      const macY = halfL - 0.26;
      bodyParts.push(zBox(t, 2.08, 0.44, wallH - 0.18, 0xced6de, 0, macY, wallZ));
      bodyParts.push(zBox(t, 1.56, 0.04, 0.72, 0x252a30, 0, halfL - 0.02, wallZ + 0.45));
      bodyParts.push(zBox(t, 1.48, 0.04, 0.52, 0x3b444d, 0, halfL - 0.02, wallZ - 0.45));
    } else {
      for (let j = -3; j <= 3; j++) {
        bodyParts.push(zBox(t, 0.04, 0.015, wallH - 0.05, ribColor, j * 0.28, frontY - 0.02, wallZ));
      }
    }

    if (variant === "openTop") {
      // 22U1 removable transverse tarpaulin bows instead of solid roof
      const bowCount = 6;
      for (let b = 0; b < bowCount; b++) {
        const by = -halfL + 0.65 + b * ((L - 1.3) / (bowCount - 1));
        bodyParts.push(zBox(t, W - 0.16, 0.045, 0.035, 0x7e8891, 0, by, spec.roofZ - 0.04));
      }
    } else {
      const roofThick = 0.035;
      bodyParts.push(zBox(t, W - 0.08, L - 0.10, roofThick, baseHex, 0, 0, spec.roofZ - roofThick / 2));
      if (variant === "dryBulk") {
        // 22B0 3 roof circular loading hatches
        for (const hy of [-1.65, 0, 1.65]) {
          bodyParts.push(zCyl(t, 0.34, 0.08, 12, 0x2b3136, 0, hy, spec.roofZ + 0.04, { rx: Math.PI * 0.5 }));
        }
      } else if (variant !== "reefer") {
        const roofRibs = is20Size ? 20 : 40;
        const roofStep = (L - 0.3) / roofRibs;
        for (let r = 0; r < roofRibs; r++) {
          const ry = -halfL + 0.15 + r * roofStep;
          bodyParts.push(zBox(t, W - 0.14, 0.04, 0.012, ribColor, 0, ry, spec.roofZ + 0.006));
        }
      }
    }
  }

  // 1d. Structural Corner Posts (4 posts)
  const postColor = new t.Color(baseHex).multiplyScalar(0.85).getHex();
  const postH = H - 0.118 * 2; // Spanning between top and bottom corner castings
  const postZ = H / 2;
  const postX = halfW - postW / 2;
  const postY = halfL - postW / 2;
  bodyParts.push(zBox(t, postW, postW, postH, postColor, -postX, -postY, postZ));
  bodyParts.push(zBox(t, postW, postW, postH, postColor, postX, -postY, postZ));
  bodyParts.push(zBox(t, postW, postW, postH, postColor, -postX, postY, postZ));
  bodyParts.push(zBox(t, postW, postW, postH, postColor, postX, postY, postZ));

  // 1e. Top and Bottom Side Longitudinal Rails & End Sills
  const railColor = new t.Color(baseHex).multiplyScalar(0.80).getHex();
  // Bottom side rails
  bodyParts.push(zBox(t, 0.08, L - 0.20, railH, railColor, -halfW + 0.04, 0, railH / 2));
  bodyParts.push(zBox(t, 0.08, L - 0.20, railH, railColor, halfW - 0.04, 0, railH / 2));
  // Front bottom sill
  bodyParts.push(zBox(t, W - 0.20, 0.08, railH, railColor, 0, halfL - 0.04, railH / 2));
  // Rear door bottom sill (walkable threshold z=0.162m)
  bodyParts.push(zBox(t, W - 0.20, 0.08, spec.floorZ, railColor, 0, -halfL + 0.04, spec.floorZ / 2));

  // Top side rails & roof end headers (omitted on flat-rack sides)
  const topRailZ = H - topRailH / 2;
  if (variant !== "flatRack") {
    bodyParts.push(zBox(t, 0.06, L - 0.20, topRailH, railColor, -halfW + 0.03, 0, topRailZ));
    bodyParts.push(zBox(t, 0.06, L - 0.20, topRailH, railColor, halfW - 0.03, 0, topRailZ));
    bodyParts.push(zBox(t, W - 0.20, 0.06, topRailH, railColor, 0, halfL - 0.03, topRailZ));
    bodyParts.push(zBox(t, W - 0.20, 0.06, topRailH, railColor, 0, -halfL + 0.03, topRailZ));
  }

  // 1f. ISO 1496-1 Forklift Pockets (Strictly on 20ft container only)
  if (spec.hasForkliftPockets && spec.forkliftPockets) {
    const pocketY0 = -spec.forkliftPockets.centerDistance / 2;
    const pocketY1 = spec.forkliftPockets.centerDistance / 2;
    const pW = spec.forkliftPockets.width;  // 0.356m
    const pH = spec.forkliftPockets.height; // 0.115m
    const pThick = 0.012;
    const pZ = pH / 2 + 0.015;

    for (const py of [pocketY0, pocketY1]) {
      // Top plate of forklift pocket tube
      bodyParts.push(zBox(t, W, pW, pThick, 0x1f2226, 0, py, pZ + pH / 2));
      // Bottom plate of forklift pocket tube
      bodyParts.push(zBox(t, W, pW, pThick, 0x1f2226, 0, py, pZ - pH / 2));
      // Side vertical walls of pocket
      bodyParts.push(zBox(t, W, pThick, pH, 0x1f2226, 0, py - pW / 2, pZ));
      bodyParts.push(zBox(t, W, pThick, pH, 0x1f2226, 0, py + pW / 2, pZ));
    }
  }

  // 1g. ISO 668 Annex C Gooseneck Tunnel (Strictly on 40HC container only)
  if (spec.hasGooseneckTunnel && spec.gooseneckTunnel) {
    const gtL = spec.gooseneckTunnel.length; // 3.150m
    const gtW = spec.gooseneckTunnel.width;  // 1.020m
    const gtH = spec.gooseneckTunnel.height; // 0.120m
    const gtY = halfL - gtL / 2;
    const gtZ = gtH / 2;
    // Gooseneck tunnel steel casing
    bodyParts.push(zBox(t, gtW, gtL, 0.012, 0x25282c, 0, gtY, gtH));
    bodyParts.push(zBox(t, 0.012, gtL, gtH, 0x25282c, -gtW / 2, gtY, gtZ));
    bodyParts.push(zBox(t, 0.012, gtL, gtH, 0x25282c, gtW / 2, gtY, gtZ));
  }

  const bodyGeom = mergeParts(t, bodyParts);
  const bodyMat = new t.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    roughness: 0.74,
    metalness: 0.26,
  });
  bodyMat.castShadow = true;
  bodyMat.receiveShadow = true;
  if (options.csmState) installCsmShaderPatch(bodyMat, options.csmState);

  const bodyMesh = new t.Mesh(bodyGeom, bodyMat);
  bodyMesh.name = "container-body";
  bodyMesh.castShadow = true;
  bodyMesh.receiveShadow = true;
  root.add(bodyMesh);

  // =========================================================================
  // SUB-MESH 2: Walkable 28mm Marine Hardwood Floor Deck (z = 0.162m)
  // =========================================================================
  const floorParts = [];
  const floorThick = 0.028;
  if (variant === "tank" || variant === "gasTank") {
    // Tanktainers have an open skeletal frame + rear valve drip tray instead of a full cargo deck
    floorParts.push(zBox(t, 0.90, 0.65, floorThick, 0x353b40, 0, -halfL + 0.45, 0));
  } else {
    const plankCount = 18;
    const plankW = spec.internal.width / plankCount;
    const plankL = spec.internal.length;
    const stdInternalLength = is20Size
      ? ISO_CONTAINER_SPECS[CONTAINER_WCID.IsoContainer20].internal.length
      : ISO_CONTAINER_SPECS[CONTAINER_WCID.IsoContainer40].internal.length;
    const plankOffsetY = variant === "reefer" ? -0.5 * (stdInternalLength - plankL) : 0;

    for (let p = 0; p < plankCount; p++) {
      const px = -spec.internal.width / 2 + plankW / 2 + p * plankW;
      const pColor = variant === "flatRack"
        ? (p % 2 === 0 ? 0x61442c : 0x553b26)
        : (p % 2 === 0 ? 0x8a5e38 : 0x7d5431);
      floorParts.push(zBox(t, plankW - 0.002, plankL, floorThick, pColor, px, plankOffsetY, 0));
    }

    // Subtle painted 2-wide bay corner guide brackets merged into floorMesh (0 extra draw calls)
    const floorSlots = slotsForSpec(spec);
    const bracketZ = floorThick / 2 + 0.001; // 0.015 m (1 mm proud of floor top)
    const bracketColor = 0xb5912e;
    const bArm = 0.12;
    const bWidth = 0.022;
    const bThick = 0.002;
    for (let i = 0; i < floorSlots.length; i++) {
      const sl = floorSlots[i];
      const hx = sl.dx * 0.5;
      const hy = sl.dy * 0.5;
      for (const sx of [-1, 1]) {
        for (const sy of [-1, 1]) {
          floorParts.push(
            zBox(t, bArm, bWidth, bThick, bracketColor, sl.x + sx * (hx - bArm * 0.5), sl.y + sy * (hy - bWidth * 0.5), bracketZ)
          );
          floorParts.push(
            zBox(t, bWidth, bArm - bWidth, bThick, bracketColor, sl.x + sx * (hx - bWidth * 0.5), sl.y + sy * (hy - bWidth - (bArm - bWidth) * 0.5), bracketZ)
          );
        }
      }
    }
  }

  const floorGeom = mergeParts(t, floorParts);
  const floorMat = new t.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    roughness: 0.85,
    metalness: 0.06,
  });
  floorMat.castShadow = true;
  floorMat.receiveShadow = true;
  if (options.csmState) installCsmShaderPatch(floorMat, options.csmState);

  const floorMesh = new t.Mesh(floorGeom, floorMat);
  floorMesh.name = "container-floor-deck";
  floorMesh.castShadow = true;
  floorMesh.receiveShadow = true;
  floorMesh.position.set(0, 0, spec.floorZ);
  root.add(floorMesh);

  // =========================================================================
  // SUB-MESH 3: 8× ISO 1161 Cast Steel Corner Castings
  // =========================================================================
  const castingParts = [];
  const cW = 0.178; // Length along Y
  const cL = 0.162; // Width along X
  const cH = 0.118; // Height along Z
  const castingColor = 0x2e3236;
  const apertureColor = 0x121416;

  const ccHalfX = spec.cornerCastingsCenter.width / 2;
  const ccHalfY = spec.cornerCastingsCenter.length / 2;
  const ccBotZ = cH / 2;
  const ccTopZ = H - cH / 2;

  const castingPositions = [
    [-ccHalfX, -ccHalfY, ccBotZ],
    [+ccHalfX, -ccHalfY, ccBotZ],
    [-ccHalfX, +ccHalfY, ccBotZ],
    [+ccHalfX, +ccHalfY, ccBotZ],
    [-ccHalfX, -ccHalfY, ccTopZ],
    [+ccHalfX, -ccHalfY, ccTopZ],
    [-ccHalfX, +ccHalfY, ccTopZ],
    [+ccHalfX, +ccHalfY, ccTopZ],
  ];

  for (const [cx, cy, cz] of castingPositions) {
    // Solid corner block
    castingParts.push(zBox(t, cL, cW, cH, castingColor, cx, cy, cz));
    // Elliptical top/bottom ISO hole aperture inset
    const isTop = cz > H / 2;
    const holeZ = isTop ? cz + cH / 2 - 0.002 : cz - cH / 2 + 0.002;
    castingParts.push(zBox(t, 0.063, 0.124, 0.005, apertureColor, cx, cy, holeZ));
    // Side apertures
    const sideX = cx > 0 ? cx + cL / 2 - 0.002 : cx - cL / 2 + 0.002;
    castingParts.push(zBox(t, 0.005, 0.080, 0.055, apertureColor, sideX, cy, cz));
  }

  const castingsGeom = mergeParts(t, castingParts);
  const castingsMat = new t.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    roughness: 0.65,
    metalness: 0.70,
  });
  castingsMat.castShadow = true;
  castingsMat.receiveShadow = true;
  if (options.csmState) installCsmShaderPatch(castingsMat, options.csmState);

  const castingsMesh = new t.Mesh(castingsGeom, castingsMat);
  castingsMesh.name = "container-corner-castings";
  castingsMesh.castShadow = true;
  castingsMesh.receiveShadow = true;
  root.add(castingsMesh);

  // =========================================================================
  // SUB-MESH 4 & 5: Animated 270° Twin Cargo Doors with Locking Bars & Cams
  // =========================================================================
  const doorW = spec.door.width / 2; // Width of single door leaf
  const doorH = spec.door.height;
  const doorThick = 0.050;
  const lockBarColor = 0x9fa4a9; // Galvanized steel
  const camColor = 0x6e7378;
  const gasketColor = 0x1b1c1e; // EPDM rubber weather gasket
  const cscPlateColor = 0xc0c4c8;
  const decalWhite = 0xededed;

  const hasCargoDoors = variant !== "flatRack" && variant !== "tank" && variant !== "gasTank";
  const pivotOutX = 0.052;
  const pivotX = halfW + pivotOutX;
  const panelY = doorThick / 2;
  const extY = panelY - doorThick / 2;
  const leftDoorPivot = new t.Group();
  leftDoorPivot.name = "door-pivot-left";
  leftDoorPivot.position.set(-pivotX, -halfL, spec.floorZ);
  root.add(leftDoorPivot);

  const rightDoorPivot = new t.Group();
  rightDoorPivot.name = "door-pivot-right";
  rightDoorPivot.position.set(pivotX, -halfL, spec.floorZ);
  root.add(rightDoorPivot);

  const rampPivot = new t.Group();
  rampPivot.name = "ramp-pivot";
  rampPivot.position.set(0, -halfL, spec.floorZ);
  root.add(rampPivot);

  if (hasCargoDoors) {
    const leftDoorParts = [];
    const leftCenterX = pivotX - doorW / 2;
    leftDoorParts.push(zBox(t, doorW, doorThick, doorH, baseHex, leftCenterX, panelY, doorH / 2));
    const strapLen = pivotX - doorW + 0.05;
    for (const hz of [0.25, doorH * 0.5, doorH - 0.25]) {
      leftDoorParts.push(zBox(t, 0.028, 0.028, 0.090, camColor, 0, extY - 0.012, hz));
      leftDoorParts.push(zBox(t, strapLen, 0.018, 0.055, camColor, strapLen / 2, extY - 0.009, hz));
    }
    leftDoorParts.push(zBox(t, doorW, 0.015, 0.025, gasketColor, leftCenterX, extY - 0.005, doorH / 2));
    leftDoorParts.push(zBox(t, 0.35, 0.005, 0.22, cscPlateColor, leftCenterX, extY - 0.005, doorH * 0.35));
    const bar1X = leftCenterX - doorW * 0.20;
    const bar2X = leftCenterX + doorW * 0.22;
    leftDoorParts.push(zBox(t, 0.038, 0.038, doorH + 0.04, lockBarColor, bar1X, extY - 0.022, doorH / 2));
    leftDoorParts.push(zBox(t, 0.038, 0.038, doorH + 0.04, lockBarColor, bar2X, extY - 0.022, doorH / 2));
    for (const bx of [bar1X, bar2X]) {
      leftDoorParts.push(zBox(t, 0.060, 0.060, 0.045, camColor, bx, extY - 0.022, 0.02));
      leftDoorParts.push(zBox(t, 0.060, 0.060, 0.045, camColor, bx, extY - 0.022, doorH - 0.02));
      leftDoorParts.push(zBox(t, 0.180, 0.025, 0.025, camColor, bx + 0.08, extY - 0.035, doorH * 0.42));
    }
    const leftDoorGeom = mergeParts(t, leftDoorParts);
    const leftDoorMat = new t.MeshStandardMaterial({
      color: 0xffffff,
      vertexColors: true,
      roughness: 0.70,
      metalness: 0.30,
    });
    leftDoorMat.castShadow = true;
    leftDoorMat.receiveShadow = true;
    if (options.csmState) installCsmShaderPatch(leftDoorMat, options.csmState);
    const leftDoorMesh = new t.Mesh(leftDoorGeom, leftDoorMat);
    leftDoorMesh.name = "door-leaf-left";
    leftDoorMesh.castShadow = true;
    leftDoorMesh.receiveShadow = true;
    leftDoorPivot.add(leftDoorMesh);

    const rightDoorParts = [];
    const rightCenterX = -pivotX + doorW / 2;
    rightDoorParts.push(zBox(t, doorW, doorThick, doorH, baseHex, rightCenterX, panelY, doorH / 2));
    for (const hz of [0.25, doorH * 0.5, doorH - 0.25]) {
      rightDoorParts.push(zBox(t, 0.028, 0.028, 0.090, camColor, 0, extY - 0.012, hz));
      rightDoorParts.push(zBox(t, strapLen, 0.018, 0.055, camColor, -strapLen / 2, extY - 0.009, hz));
    }
    rightDoorParts.push(zBox(t, doorW, 0.015, 0.025, gasketColor, rightCenterX, extY - 0.005, doorH / 2));
    rightDoorParts.push(zBox(t, 0.65, 0.005, 0.12, decalWhite, rightCenterX, extY - 0.005, doorH * 0.85));
    rightDoorParts.push(zBox(t, 0.30, 0.005, 0.08, decalWhite, rightCenterX, extY - 0.005, doorH * 0.70));
    rightDoorParts.push(zBox(t, 0.035, 0.016, doorH, 0x1f2226, rightCenterX - doorW / 2 + 0.015, extY - 0.008, doorH / 2));
    const rBar1X = rightCenterX - doorW * 0.22;
    const rBar2X = rightCenterX + doorW * 0.20;
    rightDoorParts.push(zBox(t, 0.038, 0.038, doorH + 0.04, lockBarColor, rBar1X, extY - 0.022, doorH / 2));
    rightDoorParts.push(zBox(t, 0.038, 0.038, doorH + 0.04, lockBarColor, rBar2X, extY - 0.022, doorH / 2));
    for (const bx of [rBar1X, rBar2X]) {
      rightDoorParts.push(zBox(t, 0.060, 0.060, 0.045, camColor, bx, extY - 0.022, 0.02));
      rightDoorParts.push(zBox(t, 0.060, 0.060, 0.045, camColor, bx, extY - 0.022, doorH - 0.02));
      rightDoorParts.push(zBox(t, 0.180, 0.025, 0.025, camColor, bx - 0.08, extY - 0.035, doorH * 0.42));
    }
    const rightDoorGeom = mergeParts(t, rightDoorParts);
    const rightDoorMat = new t.MeshStandardMaterial({
      color: 0xffffff,
      vertexColors: true,
      roughness: 0.70,
      metalness: 0.30,
    });
    rightDoorMat.castShadow = true;
    rightDoorMat.receiveShadow = true;
    if (options.csmState) installCsmShaderPatch(rightDoorMat, options.csmState);
    const rightDoorMesh = new t.Mesh(rightDoorGeom, rightDoorMat);
    rightDoorMesh.name = "door-leaf-right";
    rightDoorMesh.castShadow = true;
    rightDoorMesh.receiveShadow = true;
    rightDoorPivot.add(rightDoorMesh);

    const rampParts = [];
    const rampLength = 0.85;
    const rampWidth = 2.20;
    const rampThick = 0.020;
    const rampPlateColor = 0x4f545a;
    const rampBevelColor = 0x6e7378;
    rampParts.push(zBox(t, rampWidth, rampLength, rampThick, rampPlateColor, 0, -rampLength / 2, 0));
    rampParts.push(zBox(t, 0.045, rampLength, 0.040, rampBevelColor, -rampWidth / 2 + 0.022, -rampLength / 2, 0.015));
    rampParts.push(zBox(t, 0.045, rampLength, 0.040, rampBevelColor, rampWidth / 2 - 0.022, -rampLength / 2, 0.015));
    for (let k = -4; k <= 4; k++) {
      rampParts.push(zBox(t, 0.120, 0.045, 0.035, 0x2e3236, k * 0.24, -0.02, 0));
    }
    const rampGeom = mergeParts(t, rampParts);
    const rampMat = new t.MeshStandardMaterial({
      color: 0xffffff,
      vertexColors: true,
      roughness: 0.60,
      metalness: 0.45,
    });
    rampMat.castShadow = true;
    rampMat.receiveShadow = true;
    if (options.csmState) installCsmShaderPatch(rampMat, options.csmState);
    const rampMesh = new t.Mesh(rampGeom, rampMat);
    rampMesh.name = "container-ramp";
    rampMesh.castShadow = true;
    rampMesh.receiveShadow = true;
    rampPivot.add(rampMesh);
  }

  // =========================================================================
  // SUB-MESH 7: Markings, Exterior Side BIC Decals & 40HC Hazard Chevrons
  // =========================================================================
  const markingsParts = [];
  const decalBlack = 0x181818;
  const chevronYellow = 0xf5b000;

  // 7c. Exterior Side BIC Decals
  markingsParts.push(zBox(t, 0.005, 1.20, 0.16, decalWhite, halfW + 0.002, halfL - 1.20, spec.roofZ - 0.40));
  markingsParts.push(zBox(t, 0.005, 1.20, 0.16, decalWhite, -halfW - 0.002, halfL - 1.20, spec.roofZ - 0.40));

  // 7d. Yellow/Black High-Cube 9'6" / 2.9m Corner Hazard Chevrons (Strictly on 40HC outer corner posts)
  if (spec.hasHazardChevrons) {
    const chevH = 0.30;
    const chevW = 0.08;
    const chevL = 0.15;
    const topCornerZ = H - chevH / 2;
    // 4 top corner hazard bands (alternating yellow/black, strictly |x| >= spec.door.width / 2 - 0.05)
    for (const [cx, cy] of [[-halfW + chevW / 2, -halfL + chevL / 2], [halfW - chevW / 2, -halfL + chevL / 2], [-halfW + chevW / 2, halfL - chevL / 2], [halfW - chevW / 2, halfL - chevL / 2]]) {
      markingsParts.push(zBox(t, chevW + 0.004, chevL + 0.004, chevH * 0.5, chevronYellow, cx, cy, topCornerZ + chevH * 0.25));
      markingsParts.push(zBox(t, chevW + 0.004, chevL + 0.004, chevH * 0.5, decalBlack, cx, cy, topCornerZ - chevH * 0.25));
    }
  }

  const markingsGeom = mergeParts(t, markingsParts);
  const markingsMat = new t.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    roughness: 0.75,
    metalness: 0.20,
  });
  markingsMat.castShadow = true;
  markingsMat.receiveShadow = true;
  if (options.csmState) installCsmShaderPatch(markingsMat, options.csmState);

  const markingsMesh = new t.Mesh(markingsGeom, markingsMat);
  markingsMesh.name = "container-markings";
  markingsMesh.castShadow = true;
  markingsMesh.receiveShadow = true;
  root.add(markingsMesh);

  if (variant === "reefer") {
    const lampAcc = new GeomAcc();
    lampAcc.box(0.58, halfL + 0.004, wallZ + 0.35, 0.08, 0.015, 0.04, [0.22, 0.95, 0.45]);
    const lampsMat = makeLampsMaterial(t, { emissiveIntensity: 0.95, roughness: 0.25 });
    lampsMat.userData.__vfxSetKey = "lamps";
    if (options.csmState) installCsmShaderPatch(lampsMat, options.csmState);
    const reeferLampMesh = new t.Mesh(lampAcc.toBufferGeometry(t), lampsMat);
    reeferLampMesh.name = "container-reefer-status-lamp";
    reeferLampMesh.castShadow = false;
    reeferLampMesh.receiveShadow = false;
    root.add(reeferLampMesh);
  }

  // =========================================================================
  // SUB-MESH 8: Live GMA Pallet Bay (stowed deployables mount inside)
  // Dynamic Interior Culling: cargoBayGroup.visible = false when doors closed
  // =========================================================================
  const cargoBayGroup = new t.Group();
  cargoBayGroup.name = "cargoBayGroup";
  cargoBayGroup.visible = variant === "flatRack"; // vfx-lint-allow: interior bay culling when doors closed (flatRack open deck always visible)
  root.add(cargoBayGroup);

  // Lazy diegetic floor highlight outline for pinwheel pallet bay slots (attached only while active)
  function makeHighlightBorderGeom(w, d) {
    const bw = 0.035;
    const bh = 0.008;
    const hw = w / 2;
    const hd = d / 2;
    return mergeParts(t, [
      zBox(t, w, bw, bh, 0xffffff, 0, +hd - bw / 2, 0),
      zBox(t, w, bw, bh, 0xffffff, 0, -hd + bw / 2, 0),
      zBox(t, bw, Math.max(0.05, d - 2 * bw), bh, 0xffffff, -hw + bw / 2, 0, 0),
      zBox(t, bw, Math.max(0.05, d - 2 * bw), bh, 0xffffff, +hw - bw / 2, 0, 0),
    ]);
  }
  const fullSlotGeom = makeHighlightBorderGeom(1.100, 1.100);
  const highlightMat = new t.MeshStandardMaterial({
    color: 0x000000,
    emissive: 0x22dd66,
    emissiveIntensity: 1.4,
    roughness: 0.4,
    metalness: 0.1,
    transparent: true,
    opacity: 0.78,
    depthWrite: false,
    side: t.DoubleSide,
  });
  if (options.csmState) installCsmShaderPatch(highlightMat, options.csmState);

  const bayHighlightPivot = new t.Group();
  bayHighlightPivot.name = "bay-slot-highlight-pivot";
  const bayHighlightMesh = new t.Mesh(fullSlotGeom, highlightMat);
  bayHighlightMesh.name = "bay-slot-highlight";
  bayHighlightMesh.castShadow = false;
  bayHighlightMesh.receiveShadow = false;
  bayHighlightMesh.visible = false; // vfx-lint-allow: bay slot highlight visibility
  bayHighlightPivot.add(bayHighlightMesh);

  const loadedSlots = new Map(); // slotKey ("${slotIndex}") -> { slotIndex, subSlot, isHalf, slotKey, wcid, slotGroup, pallet, deployableModel }
  let currentDoorProgress = 0.0;

  function unloadSingle(slotKey) {
    const entry = loadedSlots.get(slotKey);
    if (!entry) return;
    if (entry.slotGroup && entry.slotGroup.parent) {
      entry.slotGroup.parent.remove(entry.slotGroup);
    }
    try {
      if (entry.pallet?.dispose) entry.pallet.dispose();
      if (entry.deployableModel?.dispose) entry.deployableModel.dispose();
      entry.slotGroup.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) {
          if (Array.isArray(o.material)) for (const m of o.material) m.dispose();
          else o.material.dispose();
        }
      });
    } catch (_) {}
    loadedSlots.delete(slotKey);
  }

  function unloadSlot(slotKeyOrIndex) {
    if (slotKeyOrIndex === undefined || slotKeyOrIndex === null) return;
    const str = String(slotKeyOrIndex);
    if (typeof slotKeyOrIndex === "number" || /^\d+$/.test(str)) {
      const idx = typeof slotKeyOrIndex === "number" ? slotKeyOrIndex : parseInt(str, 10);
      unloadSingle(`${idx}`);
    } else {
      unloadSingle(str);
    }
  }

  function loadSlot(slotIndex, cargoWcid, _slotOpts = {}) {
    const slotsDef = slotsForSpec(spec);
    const slotDef = slotsDef[slotIndex];
    if (!slotDef) return null;

    const slotKey = `${slotIndex}`;
    unloadSingle(slotKey);

    const slotGroup = new t.Group();
    slotGroup.name = `bay-slot-${slotIndex}`;
    slotGroup.position.set(slotDef.x, slotDef.y, spec.floorZ);
    slotGroup.rotation.z = 0;

    let pallet = null;
    let deployableModel = null;

    if (cargoWcid === 4000002) {
      deployableModel = buildDeployedRadar(t, { stowed: true, csmState: options.csmState });
    } else if ((cargoWcid >= 4000010 && cargoWcid <= 4000017) || (cargoWcid >= 4000070 && cargoWcid <= 4000074)) {
      deployableModel = buildDeployable(t, cargoWcid, { stowed: true, csmState: options.csmState });
    }

    if (deployableModel && deployableModel.root) {
      deployableModel.root.position.set(0, 0, 0);
      slotGroup.add(deployableModel.root);
    } else {
      // Empty pallet slot or generic fallback
      pallet = buildPallet(t, "standard", { stowed: true, csmState: options.csmState });
      if (pallet?.root) {
        pallet.root.position.set(0, 0, 0);
        slotGroup.add(pallet.root);
      } else if (pallet?.isObject3D) {
        pallet.position.set(0, 0, 0);
        slotGroup.add(pallet);
      }
    }

    cargoBayGroup.add(slotGroup);
    const entry = { slotIndex, subSlot: 0, isHalf: false, slotKey, wcid: cargoWcid, slotGroup, pallet, deployableModel };
    loadedSlots.set(slotKey, entry);
    return entry;
  }

  function syncSlots(slotsArray) {
    if (!Array.isArray(slotsArray)) return;
    if (loadedSlots.size === 0 && slotsArray.length === 0) return;
    const activeKeys = new Set();
    for (const s of slotsArray) {
      if (!s) continue;
      const slotIndex = s.slotIndex !== undefined ? s.slotIndex : s.SlotIndex;
      if (slotIndex === undefined) continue;
      const ps = s.palletSize !== undefined ? s.palletSize : s.PalletSize;
      if (ps === 0 || ps === "none" || ps === "None") continue;
      const cargoWcid = s.cargoWcid !== undefined ? s.cargoWcid : s.CargoWcid;
      const slotKey = `${slotIndex}`;
      activeKeys.add(slotKey);
      const existing = loadedSlots.get(slotKey);
      if (!existing || existing.wcid !== cargoWcid) {
        loadSlot(slotIndex, cargoWcid, { palletSize: "full", subSlot: 0 });
      }
    }
    const toDelete = [];
    for (const key of loadedSlots.keys()) {
      if (!activeKeys.has(key)) toDelete.push(key);
    }
    for (const key of toDelete) {
      unloadSingle(key);
    }
  }

  const HIGHLIGHT_STATES = {
    reachable: { hex: 0x22dd66, intensity: 1.4, opacity: 0.78 },
    blocked: { hex: 0xff4422, intensity: 1.5, opacity: 0.82 },
    target: { hex: 0x55ffbb, intensity: 2.6, opacity: 0.94 },
  };

  function setHighlightedSlot(slotIndex, _subSlot = null, state = null) {
    const style = state ? HIGHLIGHT_STATES[state] : null;
    if (slotIndex === null || slotIndex === undefined || !style) {
      bayHighlightMesh.visible = false; // vfx-lint-allow: bay slot highlight visibility
      if (bayHighlightPivot.parent) {
        bayHighlightPivot.parent.remove(bayHighlightPivot);
      }
      return false;
    }
    const slotsDef = slotsForSpec(spec);
    const idx = typeof slotIndex === "number" ? Math.trunc(slotIndex) : parseInt(String(slotIndex), 10);
    const slotDef = Number.isFinite(idx) ? slotsDef[idx] : null;
    if (!slotDef) {
      bayHighlightMesh.visible = false; // vfx-lint-allow: bay slot highlight visibility
      if (bayHighlightPivot.parent) {
        bayHighlightPivot.parent.remove(bayHighlightPivot);
      }
      return false;
    }

    bayHighlightMesh.geometry = fullSlotGeom;
    highlightMat.emissive.setHex(style.hex);
    highlightMat.emissiveIntensity = style.intensity;
    highlightMat.opacity = style.opacity;

    bayHighlightPivot.position.set(slotDef.x, slotDef.y, spec.floorZ + 0.016);
    bayHighlightPivot.rotation.z = 0;
    bayHighlightMesh.position.set(0, 0, 0);
    bayHighlightMesh.visible = true; // vfx-lint-allow: bay slot highlight visibility
    if (bayHighlightPivot.parent !== cargoBayGroup) {
      cargoBayGroup.add(bayHighlightPivot);
    }
    return true;
  }

  function setDoorProgress(p) {
    const prog = Number.isFinite(p) ? Math.max(0.0, Math.min(1.0, p)) : (p > 0 ? 1.0 : 0.0);
    currentDoorProgress = prog;

    // Twin doors swing outward up to 270° (-1.5π and +1.5π) with astragal sequencing:
    // Right door (with overlapping flange) leads on opening and trails on closing.
    const rightProg = Math.min(1.0, prog / 0.85);
    const leftProg = Math.max(0.0, (prog - 0.15) / 0.85);
    leftDoorPivot.rotation.z = -leftProg * 1.5 * Math.PI;
    rightDoorPivot.rotation.z = rightProg * 1.5 * Math.PI;

    // Loading ramp folds down ~11° (~0.1918 rad) from sill (z=0.162m) to ground (z=0.0m)
    rampPivot.rotation.x = prog * 0.1918;

    // Cargo bay dynamically culled when doors are closed (prog <= 0.01); flat-rack has no walls/doors so deck cargo stays visible
    cargoBayGroup.visible = variant === "flatRack" ? true : prog > 0.01; // vfx-lint-allow: interior bay culling when doors closed
  }

  // Initialize with initial door progress
  const initDoorProgress = Number.isFinite(options.doorProgress)
    ? options.doorProgress
    : (options.doorState === 2 ? 1.0 : 0.0);
  setDoorProgress(initDoorProgress);

  return {
    root,
    spec,
    leftDoorPivot,
    rightDoorPivot,
    rampPivot,
    cargoBayGroup,
    get doorProgress() {
      return currentDoorProgress;
    },
    set doorProgress(p) {
      setDoorProgress(p);
    },
    setDoorProgress,
    loadSlot,
    unloadSlot,
    syncSlots,
    setHighlightedSlot,
    bayHighlightPivot,
    bayHighlightMesh,
    update(dt = 0.033, state = {}) {
      if (state.doorProgress !== undefined) {
        setDoorProgress(state.doorProgress);
      }
      if (Array.isArray(state.slots)) {
        syncSlots(state.slots);
      }
    },
    dispose() {
      setHighlightedSlot(null, null, null);
      fullSlotGeom.dispose();
      highlightMat.dispose();
      for (const idx of [...loadedSlots.keys()]) {
        unloadSlot(idx);
      }
      disposeRootResources(root);
    },
  };
}

export const buildContainer = buildIsoContainer;
