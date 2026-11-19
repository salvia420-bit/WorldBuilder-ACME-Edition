// scene3d/vehicle/deployable_models.js — 8-Unit Modular Full/Half Pallet Deployable 3D Procedural Models
// Conforms to HBV1 v5 wire protocol, ANSI MH1 / ISO 6780 North American GMA pallets,
// AGX HDR PBR MeshStandardMaterial with 3-cascade CSM PCF shadow reception,
// and strict GPU invariants (lightCountDelta === 0, draw calls <= 10).
// Built in AC Z-up coordinates (+x east/right, +y north/forward, +z up).

import * as THREE_DEFAULT from "three";
import { installCsmShaderPatch } from "../materials.js";

export const PALLET_SPECS = Object.freeze({
  full: Object.freeze({
    width: 1.2192,
    depth: 1.0160,
    height: 0.1397,
    slots: 2,
    bboxMin: Object.freeze([-0.6096, -0.5080, 0.0]),
    bboxMax: Object.freeze([0.6096, 0.5080, 0.1397]),
  }),
  half: Object.freeze({
    width: 0.6096,
    depth: 1.0160,
    height: 0.1397,
    slots: 1,
    bboxMin: Object.freeze([-0.3048, -0.5080, 0.0]),
    bboxMax: Object.freeze([0.3048, 0.5080, 0.1397]),
  }),
  mountOffsets: Object.freeze({
    fullBed: Object.freeze([0.0, -1.15, 0.72]),
    halfSlot0: Object.freeze([-0.3048, -1.15, 0.72]),
    halfSlot1: Object.freeze([0.3048, -1.15, 0.72]),
  }),
});

export const DEPLOYABLE_KINDS = Object.freeze({
  None: 0,
  RadarStation: 1,      // 4000002
  FluxPod: 2,           // 4000010
  SolarPanels: 3,       // 4000011
  PowerGenerator: 4,    // 4000012
  BatteryUnit: 5,       // 4000013
  MissileTurret: 6,     // 4000014
  GroundRadar: 7,       // 4000015
  MortarTurret: 8,      // 4000016
  HeavyLaserTurret: 9,  // 4000017
});

export const DEPLOYABLE_WCID = Object.freeze({
  FluxPod: 4000010,
  SolarPanels: 4000011,
  PowerGenerator: 4000012,
  BatteryUnit: 4000013,
  MissileTurret: 4000014,
  GroundRadar: 4000015,
  MortarTurret: 4000016,
  HeavyLaserTurret: 4000017,
});

export const GRID_SPECS = Object.freeze({
  halfExtentM: 75.0,
  batteryMaxJoules: 600000.0,
  laserDischargeJoules: 120000.0,
  generatorKw: 45.0,
  scarabBurnSec: 120.0,
});

// ---------------------------------------------------------------------------
// Linear Vertex-Colored Z-Up Geometry Helpers (PBR Ready, Direct Linear Albedo)
// ---------------------------------------------------------------------------
function shadePart(t, rawGeom, hexColor, { rx = 0, ry = 0, rz = 0, tx = 0, ty = 0, tz = 0 } = {}) {
  const g = rawGeom.index ? rawGeom.toNonIndexed() : rawGeom.clone();
  rawGeom.dispose();
  if (rx) g.rotateX(rx);
  if (ry) g.rotateY(ry);
  if (rz) g.rotateZ(rz);
  if (tx || ty || tz) g.translate(tx, ty, tz);
  g.computeVertexNormals();

  // Keep only position + normal so mergeGeometries always succeeds
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

/** Cylinder standing upright along +Z (Three.js CylinderGeometry defaults to +Y). */
function zCyl(t, rTop, rBot, height, segs, hex, x = 0, y = 0, z = 0) {
  return shadePart(t, new t.CylinderGeometry(rTop, rBot, height, segs), hex, {
    rx: Math.PI / 2,
    tx: x,
    ty: y,
    tz: z,
  });
}

/** Cylinder aligned along +Y (forward barrel/drum axis). */
function yCyl(t, rTop, rBot, height, segs, hex, x = 0, y = 0, z = 0) {
  return shadePart(t, new t.CylinderGeometry(rTop, rBot, height, segs), hex, {
    tx: x,
    ty: y,
    tz: z,
  });
}

/** Box in AC space (dx, dy, dz) centered at (x, y, z). */
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

// ---------------------------------------------------------------------------
// ANSI MH1 / ISO 6780 North American GMA Pallets:
// Full Pallet (48 × 40 × 5.5 in = 1.2192 × 1.0160 × 0.1397 m)
// Half Pallet (24 × 40 × 5.5 in = 0.6096 × 1.0160 × 0.1397 m)
// 4-way notched hardwood stringers, 7 top / 5 bottom deckboards, merged into 1 BufferGeometry (1 draw call).
// ---------------------------------------------------------------------------
export function buildPallet(three, size = "full", options = {}) {
  const t = three || THREE_DEFAULT;
  const spec = size === "half" ? PALLET_SPECS.half : PALLET_SPECS.full;
  const root = new t.Group();
  root.name = `pallet-${size}-root`;

  const W = spec.width;
  const D = spec.depth;
  const H = spec.height;
  const halfW = W / 2;
  const halfD = D / 2;
  const halfH = H / 2;

  const parts = [];
  const tDeck = 0.015; // Deckboard thickness (approx 0.59")
  const topZ = halfH - tDeck / 2;
  const botZ = -halfH + tDeck / 2;

  // 1. Top Deckboards (7 boards: 2 lead boards 5.5" [0.1397m] wide + 5 interior boards 3.5" [0.0889m] wide)
  const topBoards = [
    { y: -0.43815, w: 0.1397, col: 0x785e42 }, // South lead board (edge at -halfD = -0.5080)
    { y: -0.2752,  w: 0.0889, col: 0x6e5238 },
    { y: -0.1376,  w: 0.0889, col: 0x83674b },
    { y:  0.0000,  w: 0.0889, col: 0x73573c }, // Center deckboard
    { y:  0.1376,  w: 0.0889, col: 0x816549 },
    { y:  0.2752,  w: 0.0889, col: 0x6e5238 },
    { y:  0.43815, w: 0.1397, col: 0x785e42 }, // North lead board (edge at +halfD = +0.5080)
  ];
  for (const b of topBoards) {
    parts.push(zBox(t, W, b.w, tDeck, b.col, 0, b.y, topZ));
  }

  // 2. Bottom Deckboards (5 boards: 2 end boards 5.5" [0.1397m] wide + 3 interior boards 3.5" [0.0889m] wide)
  const botBoards = [
    { y: -0.43815, w: 0.1397, col: 0x654e36 }, // South end board
    { y: -0.2752,  w: 0.0889, col: 0x5d4732 },
    { y:  0.0000,  w: 0.0889, col: 0x654e36 }, // Center board
    { y:  0.2752,  w: 0.0889, col: 0x5d4732 },
    { y:  0.43815, w: 0.1397, col: 0x654e36 }, // North end board
  ];
  for (const b of botBoards) {
    parts.push(zBox(t, W, b.w, tDeck, b.col, 0, b.y, botZ));
  }

  // 3. 4-Way Notched Hardwood Stringers
  // Stringers run along X. Full: 3 stringers at y = [-0.4858, 0, +0.4858]. Half: 2 stringers at y = [-0.4858, +0.4858].
  const stringerW = 0.0445; // 1.75" width along Y
  const stringerH = H - 2 * tDeck; // 0.1097m
  const notchH = 0.0381; // 1.5" notch depth
  const beamH = stringerH - notchH; // 0.0716m top continuous beam
  const beamZ = halfH - tDeck - beamH / 2; // 0.01905m
  const footZ = -halfH + tDeck + notchH / 2; // -0.0358m

  const stringerY = size === "half" ? [-0.48575, 0.48575] : [-0.48575, 0.0, 0.48575];

  for (const sy of stringerY) {
    // Top continuous stringer beam across full pallet width W
    parts.push(zBox(t, W, stringerW, beamH, 0x54402d, 0, sy, beamZ));

    if (size === "full") {
      // Dual 9" × 1.5" (0.2286 × 0.0381 m) forklift notches centered at x = ±0.3048 m
      // Leaving 3 bottom foot blocks: outer feet (0.1905m) and center foot (0.3810m)
      const footOuterLen = 0.1905;
      const footCenterLen = 0.3810;
      parts.push(zBox(t, footOuterLen, stringerW, notchH, 0x4a3726, -halfW + footOuterLen / 2, sy, footZ));
      parts.push(zBox(t, footCenterLen, stringerW, notchH, 0x4a3726, 0.0, sy, footZ));
      parts.push(zBox(t, footOuterLen, stringerW, notchH, 0x4a3726, halfW - footOuterLen / 2, sy, footZ));
    } else {
      // Half Pallet (0.6096m wide): single 9" central notch centered at x = 0
      const footHalfLen = 0.1905;
      parts.push(zBox(t, footHalfLen, stringerW, notchH, 0x4a3726, -halfW + footHalfLen / 2, sy, footZ));
      parts.push(zBox(t, footHalfLen, stringerW, notchH, 0x4a3726, halfW - footHalfLen / 2, sy, footZ));
    }
  }

  // 4. Stencil ISPM-15 HT Heat Treatment Mark on Center/Side Stringer
  const htY = size === "full" ? -stringerW / 2 - 0.001 : -0.48575 + stringerW / 2 + 0.001;
  parts.push(zBox(t, 0.09, 0.002, 0.035, 0x221810, 0.0, htY, beamZ));

  const geom = mergeParts(t, parts);
  const mat = new t.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    roughness: 0.68,
    metalness: 0.16,
  });
  mat.castShadow = true;
  mat.receiveShadow = true;
  if (options.csmState) {
    installCsmShaderPatch(mat, options.csmState);
  }

  const mesh = new t.Mesh(geom, mat);
  mesh.name = `pallet-${size}-deck`;
  mesh.position.set(0, 0, spec.height / 2);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  root.add(mesh);

  return {
    root,
    mesh,
    spec,
    size,
    alignToNormal(normal) {
      const lenSq = normal?.lengthSq?.();
      if (!Number.isFinite(lenSq) || lenSq < 1e-6) return;
      const up = new t.Vector3(0, 0, 1);
      const n = normal.clone().normalize();
      const q = new t.Quaternion().setFromUnitVectors(up, n);
      root.quaternion.copy(q);
    },
    dispose() {
      geom.dispose();
      mat.dispose();
    },
  };
}

// ---------------------------------------------------------------------------
// 1) Flux Pod (WCID 4000010, Full Pallet)
//    - Concrete pad <= 1.18 × 0.98 m atop Full GMA Pallet
//    - Squarish structure with 4 concrete corner pillars & plasma-yellow behind glass
//    - Orange 4-sided overhang cornice (<= 1.18 × 0.98 m) abutting gray roof deck
//    - Flashing beacon lights on all 4 sides of the overhang
//    - 3 corner asymmetric antennas fold downward flush when stowed (H_stowed <= 2.14 m)
//    - Dark-orange Incan stepped pyramidal capstone atop central deck
// ---------------------------------------------------------------------------
export function buildFluxPod(three, options = {}) {
  const t = three || THREE_DEFAULT;
  const root = new t.Group();
  root.name = "flux-pod-root";
  const pallet = buildPallet(t, "full", options);
  root.add(pallet.root);

  const staticParts = [];

  // A. Concrete base atop Full GMA Pallet (pad <= 1.18 × 0.98 m, pallet deck at z = 0.1397 m)
  staticParts.push(zBox(t, 1.16, 0.96, 0.12, 0x7c807a, 0, 0, 0.20));
  staticParts.push(zBox(t, 1.04, 0.86, 0.08, 0x8a8e88, 0, 0, 0.30));

  // B. 4 Concrete corner columns framing core structure
  const colCX = [-0.36, 0.36];
  const colCY = [-0.34, 0.34];
  for (const cx of colCX) {
    for (const cy of colCY) {
      staticParts.push(zBox(t, 0.16, 0.16, 0.82, 0x868a84, cx, cy, 0.73));
      staticParts.push(zBox(t, 0.20, 0.20, 0.06, 0x6e726c, cx, cy, 0.35)); // Base collar
      staticParts.push(zBox(t, 0.20, 0.20, 0.06, 0x6e726c, cx, cy, 1.11)); // Capital collar
    }
  }
  // Dark window mullions framing the glass
  for (const side of [-0.35, 0.35]) {
    staticParts.push(zBox(t, 0.64, 0.03, 0.04, 0x35393c, 0, side, 0.73));
    staticParts.push(zBox(t, 0.03, 0.60, 0.04, 0x35393c, side, 0, 0.73));
  }

  // C. Bright orange 4-sided overhang cornice (outer bounds: 1.16 × 0.96 m <= 1.18 × 0.98 m)
  const ohZ = 1.18;
  const ohH = 0.14;
  staticParts.push(zBox(t, 1.16, 0.20, ohH, 0xff6a00, 0, 0.38, ohZ));  // North overhang
  staticParts.push(zBox(t, 1.16, 0.20, ohH, 0xff6a00, 0, -0.38, ohZ)); // South overhang
  staticParts.push(zBox(t, 0.20, 0.56, ohH, 0xff6a00, 0.48, 0, ohZ));  // East overhang
  staticParts.push(zBox(t, 0.20, 0.56, ohH, 0xff6a00, -0.48, 0, ohZ)); // West overhang

  // Central gray roof deck abutted by the bright orange overhang
  staticParts.push(zBox(t, 0.76, 0.56, 0.14, 0x6c737a, 0, 0, 1.20));
  staticParts.push(zBox(t, 0.66, 0.48, 0.04, 0x7c848c, 0, 0, 1.29));

  // D. Corner antenna mount brackets (animated folding booms added below as runtime-articulated pivots)
  const antennaCorners = [
    { x: 0.50, y: 0.40, dirX: 1, dirY: 1 },   // NE corner
    { x: -0.50, y: 0.40, dirX: -1, dirY: 1 }, // NW corner
    { x: 0.50, y: -0.40, dirX: 1, dirY: -1 }, // SE corner
  ];
  for (let ai = 0; ai < antennaCorners.length; ai++) {
    const c = antennaCorners[ai];
    staticParts.push(zBox(t, 0.10, 0.10, 0.10, 0x3b4046, c.x, c.y, 1.25));
  }

  // E. Dark-orange Incan stepped pyramidal centerpiece atop gray roof deck
  const incanTiers = [
    { w: 0.52, d: 0.40, h: 0.08, z: 1.35, col: 0xa83808 },
    { w: 0.38, d: 0.30, h: 0.08, z: 1.43, col: 0xb63f0a },
    { w: 0.26, d: 0.20, h: 0.08, z: 1.51, col: 0xc4470d },
  ];
  for (const tier of incanTiers) {
    staticParts.push(zBox(t, tier.w, tier.d, tier.h, tier.col, 0, 0, tier.z));
  }
  // Stepped Incan pyramidal capstone cone
  staticParts.push(shadePart(t, new t.ConeGeometry(0.12, 0.14, 4), 0xba410b, {
    rx: Math.PI / 2,
    rz: Math.PI / 4,
    tz: 1.62,
  }));

  const matStructure = new t.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    roughness: 0.68,
    metalness: 0.16,
  });
  matStructure.castShadow = true;
  matStructure.receiveShadow = true;
  if (options.csmState) {
    installCsmShaderPatch(matStructure, options.csmState);
  }

  const structureMesh = new t.Mesh(mergeParts(t, staticParts), matStructure);
  structureMesh.name = "flux-pod-structure";
  structureMesh.castShadow = true;
  structureMesh.receiveShadow = true;

  // Glowing plasma-yellow core & conduits visible behind glass
  const plasmaParts = [
    zCyl(t, 0.20, 0.20, 0.74, 12, 0xffe838, 0, 0, 0.73),
    zBox(t, 0.62, 0.54, 0.70, 0xffd000, 0, 0, 0.73),
  ];
  const matCore = new t.MeshBasicMaterial({
    color: 0xffe433,
    vertexColors: true,
    transparent: true,
    opacity: 0.8,
    blending: t.AdditiveBlending,
    depthWrite: false,
  });
  const core = new t.Mesh(mergeParts(t, plasmaParts), matCore);
  core.name = "flux-pod-plasma-core";

  // Containment glass panels
  const matGlass = new t.MeshBasicMaterial({
    color: 0x9ce2ff,
    transparent: true,
    opacity: 0.34,
    depthWrite: false,
  });
  const glassBox = new t.Mesh(new t.BoxGeometry(0.70, 0.62, 0.78), matGlass);
  glassBox.name = "flux-pod-glass";
  glassBox.position.set(0, 0, 0.73);

  // Flashing beacon lights on all 4 sides of the orange overhang
  const lightsNSGeom = mergeParts(t, [
    zBox(t, 0.30, 0.04, 0.06, 0xffffff, 0, 0.49, ohZ),
    zBox(t, 0.30, 0.04, 0.06, 0xffffff, 0, -0.49, ohZ),
  ]);
  const lightsEWGeom = mergeParts(t, [
    zBox(t, 0.04, 0.24, 0.06, 0xffffff, 0.59, 0, ohZ),
    zBox(t, 0.04, 0.24, 0.06, 0xffffff, -0.59, 0, ohZ),
  ]);
  const matFlashNS = new t.MeshBasicMaterial({
    color: 0xffee55,
    transparent: true,
    opacity: 0.95,
    blending: t.AdditiveBlending,
    depthWrite: false,
  });
  const matFlashEW = new t.MeshBasicMaterial({
    color: 0xffaa22,
    transparent: true,
    opacity: 0.35,
    blending: t.AdditiveBlending,
    depthWrite: false,
  });
  const lightsNS = new t.Mesh(lightsNSGeom, matFlashNS);
  const lightsEW = new t.Mesh(lightsEWGeom, matFlashEW);
  lightsNS.name = "flux-overhang-lights-ns";
  lightsEW.name = "flux-overhang-lights-ew";

  // 3 articulated corner antenna pivots (shared singleAntennaGeom + matStructure -> 9 total draw calls <= 10)
  const singleAntennaGeom = mergeParts(t, [
    zBox(t, 0.032, 0.032, 0.55, 0x9aa4ad, 0, 0, 0.275),
    zBox(t, 0.20, 0.02, 0.02, 0xd89b28, 0, 0, 0.40),
    zCyl(t, 0.035, 0.015, 0.08, 6, 0xff6a00, 0, 0, 0.57),
  ]);
  const antennaPivots = [];
  for (let ai = 0; ai < antennaCorners.length; ai++) {
    const c = antennaCorners[ai];
    const piv = new t.Group();
    piv.name = `flux-antenna-pivot-${ai}`;
    piv.position.set(c.x, c.y, 1.25);
    const antMesh = new t.Mesh(singleAntennaGeom, matStructure);
    antMesh.castShadow = true;
    antMesh.receiveShadow = true;
    piv.add(antMesh);
    antennaPivots.push({ piv, c });
    root.add(piv);
  }

  root.add(structureMesh, core, glassBox, lightsNS, lightsEW);

  let isStowed = false;
  function setStowed(stowed) {
    isStowed = Boolean(stowed);
    for (const { piv, c } of antennaPivots) {
      if (isStowed) {
        piv.rotation.set(Math.PI, 0, 0);
      } else {
        piv.rotation.set(-c.dirY * 0.45, c.dirX * 0.45, 0);
      }
    }
    if (isStowed) {
      matCore.opacity = 0.15;
      matFlashNS.color.setHex(0xffaa22);
      matFlashNS.opacity = 0.25;
      matFlashEW.color.setHex(0xffaa22);
      matFlashEW.opacity = 0.25;
    } else {
      matCore.opacity = 0.80;
      matFlashNS.color.setHex(0xffee55);
      matFlashNS.opacity = 0.95;
      matFlashEW.color.setHex(0xffaa22);
      matFlashEW.opacity = 0.35;
    }
  }
  setStowed(Boolean(options.stowed));

  return {
    root,
    core,
    lightsNS,
    lightsEW,
    pallet,
    wcid: DEPLOYABLE_WCID.FluxPod,
    palletSize: "full",
    get stowed() { return isStowed; },
    setStowed,
    update(state = {}) {
      const s = state && typeof state === "object" ? state : {};
      if (s.stowed !== undefined) {
        setStowed(s.stowed);
      }
      if (isStowed) return;
      const time = Number.isFinite(s.simTimeSec) ? s.simTimeSec : 0;
      matCore.opacity = 0.7 + 0.3 * Math.sin(4.0 * time);
      const wave = 0.5 + 0.5 * Math.sin(7.5 * time);
      matFlashNS.opacity = 0.2 + 0.8 * wave;
      matFlashEW.opacity = 0.2 + 0.8 * (1.0 - wave);
    },
    dispose() {
      pallet.dispose();
      const geoms = new Set();
      const mats = new Set();
      root.traverse((obj) => {
        if (obj === pallet.mesh) return;
        if (obj.geometry && !geoms.has(obj.geometry)) {
          obj.geometry.dispose();
          geoms.add(obj.geometry);
        }
        if (obj.material) {
          const list = Array.isArray(obj.material) ? obj.material : [obj.material];
          for (const m of list) {
            if (m && !mats.has(m)) {
              m.dispose();
              mats.add(m);
            }
          }
        }
      });
    },
  };
}

// ---------------------------------------------------------------------------
// 2) Solar Panels (WCID 4000011, Full Pallet)
//    - Fits Full GMA pad (<= 1.18 × 0.98 m)
//    - Wings fold flat horizontally atop pedestal when stowed (H_stowed <= 1.10 m, deployed ~1.95 m)
// ---------------------------------------------------------------------------
export function buildSolarPanels(three, options = {}) {
  const t = three || THREE_DEFAULT;
  const root = new t.Group();
  root.name = "solar-panels-root";
  const pallet = buildPallet(t, "full", options);
  root.add(pallet.root);

  // Upright steel pedestal, inverter cabinet & base collar
  const pedGeom = mergeParts(t, [
    zBox(t, 0.90, 0.80, 0.08, 0x4b5258, 0, 0, 0.18),
    zCyl(t, 0.10, 0.14, 0.48, 12, 0x626a72, 0, 0, 0.46),
    zBox(t, 0.36, 0.26, 0.32, 0x3b4248, 0, -0.25, 0.38), // Inverter box
  ]);
  const matStatusLed = new t.MeshStandardMaterial({
    color: 0x2fd866,
    emissive: 0x1db84e,
    emissiveIntensity: 0.85,
    roughness: 0.25,
    metalness: 0.2,
  });
  if (options.csmState) installCsmShaderPatch(matStatusLed, options.csmState);
  const statusLedMesh = new t.Mesh(new t.BoxGeometry(0.14, 0.03, 0.08), matStatusLed);
  statusLedMesh.name = "solar-status-led";
  statusLedMesh.position.set(0, -0.39, 0.42);
  statusLedMesh.castShadow = true;
  statusLedMesh.receiveShadow = true;
  const matPedestal = new t.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    roughness: 0.45,
    metalness: 0.55,
  });
  matPedestal.castShadow = true;
  matPedestal.receiveShadow = true;
  if (options.csmState) installCsmShaderPatch(matPedestal, options.csmState);

  const pedestal = new t.Mesh(pedGeom, matPedestal);
  pedestal.name = "solar-pedestal";
  pedestal.castShadow = true;
  pedestal.receiveShadow = true;

  const turntable = new t.Group();
  turntable.name = "azimuth-turntable";
  turntable.position.set(0, 0, 0.72);

  const trunnion = new t.Group();
  trunnion.name = "elevation-trunnion";
  trunnion.position.set(0, 0, 0.06);

  function makeSolarWingGeom(signX) {
    const cx = signX * 0.28;
    const parts = [
      // Silver anodized aluminum outer frame (0.48 × 0.92 m)
      zBox(t, 0.48, 0.92, 0.036, 0xb8c2cc, cx, 0, 0),
      // Rich monocrystalline silicon PV bed
      zBox(t, 0.44, 0.88, 0.042, 0x1b4f9c, cx, 0, 0),
    ];
    // Silver busbars & cell grid ribbons
    for (const bx of [-0.14, 0, 0.14]) {
      parts.push(zBox(t, 0.010, 0.86, 0.046, 0x9ec0e6, cx + bx, 0, 0));
    }
    for (let gy = -0.35; gy <= 0.36; gy += 0.18) {
      parts.push(zBox(t, 0.42, 0.008, 0.046, 0x7ca2cc, cx, gy, 0));
    }
    return mergeParts(t, parts);
  }

  const matWing = new t.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    roughness: 0.18,
    metalness: 0.42,
  });
  matWing.castShadow = true;
  matWing.receiveShadow = true;
  if (options.csmState) installCsmShaderPatch(matWing, options.csmState);

  const leftWing = new t.Mesh(makeSolarWingGeom(-1), matWing);
  const rightWing = new t.Mesh(makeSolarWingGeom(+1), matWing);
  leftWing.castShadow = true;
  leftWing.receiveShadow = true;
  rightWing.castShadow = true;
  rightWing.receiveShadow = true;

  const actGeom = mergeParts(t, [
    zBox(t, 0.18, 0.20, 0.10, 0x555d65, 0, 0, -0.04),
    zCyl(t, 0.03, 0.03, 0.24, 8, 0xc8d0d8, 0, -0.16, -0.12),
  ]);
  const matActuators = new t.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    roughness: 0.45,
    metalness: 0.55,
  });
  matActuators.castShadow = true;
  matActuators.receiveShadow = true;
  if (options.csmState) installCsmShaderPatch(matActuators, options.csmState);

  const actuators = new t.Mesh(actGeom, matActuators);
  actuators.castShadow = true;
  actuators.receiveShadow = true;

  trunnion.add(leftWing, rightWing, actuators);
  turntable.add(trunnion);
  root.add(pedestal, statusLedMesh, turntable);

  let isStowed = false;
  function setStowed(stowed) {
    isStowed = Boolean(stowed);
    if (isStowed) {
      turntable.rotation.z = 0;
      trunnion.rotation.x = 0;
      matStatusLed.color.setHex(0xffaa22);
      matStatusLed.emissive.setHex(0xdd8800);
      matStatusLed.emissiveIntensity = 0.25;
    } else {
      matStatusLed.color.setHex(0x2fd866);
      matStatusLed.emissive.setHex(0x1db84e);
      matStatusLed.emissiveIntensity = 0.85;
    }
  }
  setStowed(Boolean(options.stowed));

  return {
    root,
    turntable,
    trunnion,
    leftWing,
    rightWing,
    pallet,
    wcid: DEPLOYABLE_WCID.SolarPanels,
    palletSize: "full",
    get stowed() { return isStowed; },
    setStowed,
    update(state = {}) {
      const s = state && typeof state === "object" ? state : {};
      if (s.stowed !== undefined) {
        setStowed(s.stowed);
      }
      if (isStowed) return;
      const hdg = s.sunHeading !== undefined ? s.sunHeading : s.sunAzimuthRad;
      const pit = s.sunPitch !== undefined ? s.sunPitch : s.sunPitchRad;
      if (Number.isFinite(hdg)) turntable.rotation.z = hdg;
      if (Number.isFinite(pit)) {
        trunnion.rotation.x = pit > 0 ? Math.max(0, Math.min(Math.PI / 2, pit)) : 0;
      }
    },
    dispose() {
      pallet.dispose();
      const geoms = new Set();
      const mats = new Set();
      root.traverse((obj) => {
        if (obj === pallet.mesh) return;
        if (obj.geometry && !geoms.has(obj.geometry)) {
          obj.geometry.dispose();
          geoms.add(obj.geometry);
        }
        if (obj.material) {
          const list = Array.isArray(obj.material) ? obj.material : [obj.material];
          for (const m of list) {
            if (m && !mats.has(m)) {
              m.dispose();
              mats.add(m);
            }
          }
        }
      });
    },
  };
}

// ---------------------------------------------------------------------------
// 3) Power Generator (WCID 4000012, Full Pallet) — Burns Platinum Scarabs
//    - Housing <= 1.18 × 0.98 m atop Full GMA Pallet
//    - Exhaust stack stowed height <= 1.45 m
// ---------------------------------------------------------------------------
export function buildPowerGenerator(three, options = {}) {
  const t = three || THREE_DEFAULT;
  const root = new t.Group();
  root.name = "power-generator-root";
  const pallet = buildPallet(t, "full", options);
  root.add(pallet.root);

  const bodyParts = [
    // Heavy steel generator skid & louvered engine block (1.14 × 0.94 m <= 1.18 × 0.98 m)
    zBox(t, 1.14, 0.94, 0.50, 0x3b4238, 0, 0, 0.39),
    zBox(t, 0.96, 0.68, 0.38, 0x4f564b, -0.05, -0.05, 0.83),
    // Horizontal turbine barrel along +Y
    yCyl(t, 0.24, 0.24, 0.80, 14, 0x676e63, -0.10, 0.0, 0.88),
    // Copper/brass arcane induction coils
    yCyl(t, 0.27, 0.27, 0.10, 14, 0xc27a38, -0.10, -0.20, 0.88),
    yCyl(t, 0.27, 0.27, 0.10, 14, 0xc27a38, -0.10, 0.20, 0.88),
    // Platinum Scarab armored hopper & feed chute on starboard side
    zBox(t, 0.34, 0.38, 0.42, 0x8d7f70, 0.36, 0.20, 0.84),
    zBox(t, 0.38, 0.42, 0.06, 0xb87333, 0.36, 0.20, 1.08),
    // Fixed lower exhaust sleeve (stowed height <= 1.25 m)
    zCyl(t, 0.07, 0.08, 0.28, 10, 0x2c302c, -0.38, -0.30, 1.11),
  ];

  const matBody = new t.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    roughness: 0.58,
    metalness: 0.38,
  });
  matBody.castShadow = true;
  matBody.receiveShadow = true;
  if (options.csmState) installCsmShaderPatch(matBody, options.csmState);

  const bodyMesh = new t.Mesh(mergeParts(t, bodyParts), matBody);
  bodyMesh.name = "generator-chassis-turbine";
  bodyMesh.castShadow = true;
  bodyMesh.receiveShadow = true;

  // Spinning flywheel at front of turbine
  const fwGeom = mergeParts(t, [
    zCyl(t, 0.22, 0.22, 0.06, 16, 0x282c28, 0, 0, 0),
    zBox(t, 0.40, 0.05, 0.08, 0xd49b2a, 0, 0, 0),
    zBox(t, 0.05, 0.40, 0.08, 0xd49b2a, 0, 0, 0),
  ]);
  const matFlywheel = new t.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    roughness: 0.35,
    metalness: 0.65,
  });
  matFlywheel.castShadow = true;
  matFlywheel.receiveShadow = true;
  if (options.csmState) installCsmShaderPatch(matFlywheel, options.csmState);

  const flywheelPivot = new t.Group();
  flywheelPivot.position.set(-0.10, 0.44, 0.88);
  flywheelPivot.rotation.x = Math.PI / 2;
  const flywheel = new t.Mesh(fwGeom, matFlywheel);
  flywheel.castShadow = true;
  flywheel.receiveShadow = true;
  flywheelPivot.add(flywheel);

  // Platinum-cyan arcane scarab combustion chamber glow (additive, 0 dynamic lights)
  const matArcaneGlow = new t.MeshBasicMaterial({
    color: 0x66eeff,
    transparent: true,
    opacity: 0.82,
    blending: t.AdditiveBlending,
    depthWrite: false,
  });
  const glowGeom = mergeParts(t, [
    zBox(t, 0.24, 0.26, 0.28, 0x77f0ff, 0.36, 0.20, 0.88),
    yCyl(t, 0.16, 0.16, 0.54, 10, 0x55ddff, -0.10, 0, 0.88),
  ]);
  const glowCore = new t.Mesh(glowGeom, matArcaneGlow);
  glowCore.name = "generator-scarab-glow";

  const exhaustStackMesh = new t.Mesh(
    zCyl(t, 0.05, 0.05, 0.28, 10, 0x444844, 0, 0, 0),
    matBody,
  );
  exhaustStackMesh.name = "generator-exhaust-stack";
  exhaustStackMesh.position.set(-0.38, -0.30, 1.38);
  exhaustStackMesh.castShadow = true;
  exhaustStackMesh.receiveShadow = true;

  root.add(bodyMesh, exhaustStackMesh, flywheelPivot, glowCore);

  let flywheelAngle = 0;
  let isStowed = false;
  function setStowed(stowed) {
    isStowed = Boolean(stowed);
    if (isStowed) {
      exhaustStackMesh.position.z = 1.11;
      matArcaneGlow.color.setHex(0xffaa22);
      matArcaneGlow.opacity = 0.18;
    } else {
      exhaustStackMesh.position.z = 1.38;
      matArcaneGlow.color.setHex(0x66eeff);
      matArcaneGlow.opacity = 0.82;
    }
  }
  setStowed(Boolean(options.stowed));

  return {
    root,
    flywheel,
    glowCore,
    pallet,
    wcid: DEPLOYABLE_WCID.PowerGenerator,
    palletSize: "full",
    get flywheelAngle() { return flywheelAngle; },
    get stowed() { return isStowed; },
    setStowed,
    update(state = {}) {
      const s = state && typeof state === "object" ? state : {};
      if (s.stowed !== undefined) {
        setStowed(s.stowed);
      }
      if (isStowed) return;
      const dt = Number.isFinite(s.dt) && s.dt >= 0 ? s.dt : 0.0333;
      const fuel = s.fuelSecondsRemaining !== undefined ? s.fuelSecondsRemaining : s.fuelRemaining;
      const isFueled = Boolean((Number.isFinite(fuel) && fuel > 0) || s.online);
      if (isFueled) {
        flywheelAngle = (flywheelAngle + 25.0 * dt) % (2 * Math.PI);
        flywheel.rotation.z = flywheelAngle;
        matArcaneGlow.opacity = 0.82;
      } else {
        matArcaneGlow.opacity = 0.18;
      }
    },
    dispose() {
      pallet.dispose();
      const geoms = new Set();
      const mats = new Set();
      root.traverse((obj) => {
        if (obj === pallet.mesh) return;
        if (obj.geometry && !geoms.has(obj.geometry)) {
          obj.geometry.dispose();
          geoms.add(obj.geometry);
        }
        if (obj.material) {
          const list = Array.isArray(obj.material) ? obj.material : [obj.material];
          for (const m of list) {
            if (m && !mats.has(m)) {
              m.dispose();
              mats.add(m);
            }
          }
        }
      });
    },
  };
}

// ---------------------------------------------------------------------------
// 4) Battery Unit (WCID 4000013, Half Pallet) — 600 kJ Capacitor Bank
//    - Fits Half GMA pad (rack <= 0.57 × 0.98 m, height <= 1.35 m)
// ---------------------------------------------------------------------------
export function buildBatteryUnit(three, options = {}) {
  const t = three || THREE_DEFAULT;
  const root = new t.Group();
  root.name = "battery-unit-root";
  const pallet = buildPallet(t, "half", options);
  root.add(pallet.root);

  const bankParts = [
    // Half-pallet steel cage & base plinth (0.55 × 0.94 m <= 0.57 × 0.98 m)
    zBox(t, 0.55, 0.94, 0.16, 0x2c3330, 0, 0, 0.22),
    zBox(t, 0.53, 0.08, 0.82, 0x38403d, 0, -0.42, 0.71),
    zBox(t, 0.53, 0.08, 0.82, 0x38403d, 0, 0.42, 0.71),
    zBox(t, 0.54, 0.92, 0.06, 0x38403d, 0, 0, 1.15),
    // Heavy gold-copper top busbars
    zBox(t, 0.05, 0.78, 0.04, 0xd4a437, -0.14, 0, 1.10),
    zBox(t, 0.05, 0.78, 0.04, 0xd4a437, 0.14, 0, 1.10),
    // Bezel panel for the 5 SoC LED bars
    zBox(t, 0.04, 0.34, 0.64, 0x161a18, 0.26, 0, 0.70),
  ];
  // 6 upright +Z high-density blue cylindrical capacitor cells (2x3)
  for (const cx of [-0.14, 0.14]) {
    for (const cy of [-0.28, 0, 0.28]) {
      bankParts.push(zCyl(t, 0.10, 0.10, 0.68, 12, 0x1d5494, cx, cy, 0.68));
      bankParts.push(zCyl(t, 0.04, 0.04, 0.05, 8, 0xd4a437, cx, cy, 1.04));
    }
  }

  const matBank = new t.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    roughness: 0.52,
    metalness: 0.48,
  });
  matBank.castShadow = true;
  matBank.receiveShadow = true;
  if (options.csmState) installCsmShaderPatch(matBank, options.csmState);

  const bankMesh = new t.Mesh(mergeParts(t, bankParts), matBank);
  bankMesh.name = "battery-capacitor-bank";
  bankMesh.castShadow = true;
  bankMesh.receiveShadow = true;
  root.add(bankMesh);

  const socBars = [];
  const matOff = new t.MeshStandardMaterial({ color: 0x222222, roughness: 0.8, metalness: 0.1 });
  const matOn = new t.MeshStandardMaterial({
    color: 0x00ff66,
    emissive: 0x00dd55,
    emissiveIntensity: 0.85,
    roughness: 0.2,
    metalness: 0.2,
  });
  const matStandby = new t.MeshStandardMaterial({
    color: 0xffaa22,
    emissive: 0xdd8800,
    emissiveIntensity: 0.35,
    roughness: 0.25,
    metalness: 0.2,
  });
  if (options.csmState) {
    installCsmShaderPatch(matOff, options.csmState);
    installCsmShaderPatch(matOn, options.csmState);
    installCsmShaderPatch(matStandby, options.csmState);
  }
  for (let i = 0; i < 5; i++) {
    const barMesh = new t.Mesh(new t.BoxGeometry(0.04, 0.24, 0.08), matOff);
    barMesh.position.set(0.28, 0, 0.46 + i * 0.12);
    barMesh.castShadow = true;
    barMesh.receiveShadow = true;
    socBars.push(barMesh);
    root.add(barMesh);
  }

  let isStowed = false;
  let lastJoules = 0;

  function applySocBars(safeJ) {
    const activeBars = Math.max(0, Math.min(5, Math.floor(safeJ / 120000.0)));
    for (let i = 0; i < 5; i++) {
      socBars[i].material = i < activeBars ? matOn : matOff;
    }
  }

  function setStowed(stowed) {
    isStowed = Boolean(stowed);
    if (isStowed) {
      socBars[0].material = matStandby;
      for (let i = 1; i < 5; i++) socBars[i].material = matOff;
    } else {
      applySocBars(lastJoules);
    }
  }
  setStowed(Boolean(options.stowed));

  return {
    root,
    socBars,
    pallet,
    wcid: DEPLOYABLE_WCID.BatteryUnit,
    palletSize: "half",
    get stowed() { return isStowed; },
    setStowed,
    update(state = {}) {
      const s = state && typeof state === "object" ? state : {};
      if (s.stowed !== undefined) {
        setStowed(s.stowed);
      }
      if (isStowed) return;
      const joules = s.capacitorJoules !== undefined ? s.capacitorJoules : s.energyJoules;
      lastJoules = Number.isFinite(joules) ? joules : 0;
      applySocBars(lastJoules);
    },
    dispose() {
      pallet.dispose();
      bankMesh.geometry.dispose();
      bankMesh.material.dispose();
      for (const b of socBars) b.geometry.dispose();
      matOff.dispose();
      matOn.dispose();
      matStandby.dispose();
    },
  };
}

// ---------------------------------------------------------------------------
// 5) Autonomous Missile Turret (WCID 4000014, Full Pallet)
//    - Fits Full GMA pad (<= 1.18 × 0.98 m)
//    - Dual missile pods fold down horizontally to 0° elevation when stowed (H_stowed <= 1.85 m)
//    - Sudden 0.35s vertical rise on 4 pneumatic cylinders when deployed
// ---------------------------------------------------------------------------
export function buildMissileTurret(three, options = {}) {
  const t = three || THREE_DEFAULT;
  const root = new t.Group();
  root.name = "missile-turret-root";
  const pallet = buildPallet(t, "full", options);
  root.add(pallet.root);

  // Armored full-pallet base housing & 4 corner pneumatic sleeves (1.14 × 0.94 m <= 1.18 × 0.98 m)
  const baseParts = [
    zBox(t, 1.14, 0.94, 0.16, 0x3e4637, 0, 0, 0.22),
    zBox(t, 0.86, 0.76, 0.22, 0x31382c, 0, 0, 0.33),
  ];
  for (const px of [-0.34, 0.34]) {
    for (const py of [-0.28, 0.28]) {
      baseParts.push(zCyl(t, 0.08, 0.09, 0.34, 10, 0x4b5344, px, py, 0.36));
    }
  }
  const matOutriggers = new t.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    roughness: 0.62,
    metalness: 0.32,
  });
  matOutriggers.castShadow = true;
  matOutriggers.receiveShadow = true;
  if (options.csmState) installCsmShaderPatch(matOutriggers, options.csmState);

  const outriggers = new t.Mesh(mergeParts(t, baseParts), matOutriggers);
  outriggers.name = "sam-base-well";
  outriggers.castShadow = true;
  outriggers.receiveShadow = true;

  // Pneumatic riser group
  const riserGroup = new t.Group();
  riserGroup.name = "pneumatic-riser";
  riserGroup.position.set(0, 0, 0.20);

  const pistonParts = [
    zBox(t, 0.74, 0.68, 0.08, 0x464f3f, 0, 0, 0.60), // Riser top plate
    zCyl(t, 0.14, 0.16, 0.56, 12, 0x7b8288, 0, 0, 0.32), // Central hydraulic ram
  ];
  for (const px of [-0.34, 0.34]) {
    for (const py of [-0.28, 0.28]) {
      pistonParts.push(zCyl(t, 0.045, 0.045, 0.58, 10, 0xd8e0e8, px, py, 0.32)); // 4 bright chrome pneumatic rods
    }
  }
  const matPiston = new t.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    roughness: 0.25,
    metalness: 0.85,
  });
  matPiston.castShadow = true;
  matPiston.receiveShadow = true;
  if (options.csmState) installCsmShaderPatch(matPiston, options.csmState);

  const piston = new t.Mesh(mergeParts(t, pistonParts), matPiston);
  piston.name = "pneumatic-cylinders";
  piston.castShadow = true;
  piston.receiveShadow = true;

  // Agile 3-axis gimbal (Z yaw -> X pitch -> Y roll)
  const turntable = new t.Group();
  turntable.name = "turret-yaw";
  turntable.position.set(0, 0, 0.68);

  const gimbal = new t.Group();
  gimbal.name = "turret-pitch";

  // Squarish 4-cell armored SAM pod + electro-optical tracking dome
  const podGeom = mergeParts(t, [
    zCyl(t, 0.18, 0.20, 0.16, 12, 0x525a4b, 0, 0, -0.02),
    zBox(t, 0.74, 0.88, 0.50, 0x3b4434, 0, 0, 0.30),      // Armored launcher box
    zBox(t, 0.78, 0.10, 0.54, 0x56614c, 0, 0.42, 0.30),   // Front armored bezel
    zBox(t, 0.22, 0.26, 0.16, 0x282d26, 0, 0.12, 0.62),   // Top EO/IR sensor housing
    yCyl(t, 0.06, 0.06, 0.06, 10, 0xffaa22, 0, 0.26, 0.62), // Amber optics lens
  ]);
  const matLauncherPod = new t.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    roughness: 0.58,
    metalness: 0.35,
  });
  matLauncherPod.castShadow = true;
  matLauncherPod.receiveShadow = true;
  if (options.csmState) installCsmShaderPatch(matLauncherPod, options.csmState);

  const launcherPod = new t.Mesh(podGeom, matLauncherPod);
  launcherPod.castShadow = true;
  launcherPod.receiveShadow = true;

  // 4 Individually visible SAM missiles pointing forward (+Y) in 2x2 cells
  const singleMissileGeom = mergeParts(t, [
    yCyl(t, 0.065, 0.065, 0.82, 10, 0xebeff2, 0, 0.05, 0), // White rocket body
    shadePart(t, new t.ConeGeometry(0.065, 0.20, 10), 0xd42c20, { ty: 0.56 }), // Red seeker nosecone (+Y)
    zBox(t, 0.18, 0.12, 0.015, 0x383e42, 0, -0.28, 0), // Cruciform tail fins
    zBox(t, 0.015, 0.12, 0.18, 0x383e42, 0, -0.28, 0),
  ]);
  const matMissile = new t.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    roughness: 0.40,
    metalness: 0.20,
  });
  matMissile.castShadow = true;
  matMissile.receiveShadow = true;
  if (options.csmState) installCsmShaderPatch(matMissile, options.csmState);

  const missiles = [];
  for (let i = 0; i < 4; i++) {
    const m = new t.Mesh(singleMissileGeom, matMissile);
    m.position.set(-0.18 + (i % 2) * 0.36, 0.08, 0.18 + Math.floor(i / 2) * 0.24);
    m.castShadow = true;
    m.receiveShadow = true;
    m.visible = true; // vfx-lint-allow: SAM cell initial visibility
    missiles.push(m);
    launcherPod.add(m);
  }

  const matStatusLed = new t.MeshStandardMaterial({
    color: 0x22ff66,
    emissive: 0x11cc44,
    emissiveIntensity: 0.85,
    roughness: 0.25,
    metalness: 0.2,
  });
  if (options.csmState) installCsmShaderPatch(matStatusLed, options.csmState);
  const statusLed = new t.Mesh(new t.BoxGeometry(0.12, 0.03, 0.05), matStatusLed);
  statusLed.name = "sam-status-led";
  statusLed.position.set(0, -0.39, 0.34);
  statusLed.castShadow = true;
  statusLed.receiveShadow = true;

  gimbal.add(launcherPod);
  turntable.add(gimbal);
  riserGroup.add(piston, turntable);
  root.add(outriggers, statusLed, riserGroup);

  let isStowed = false;
  function setStowed(stowed) {
    isStowed = Boolean(stowed);
    if (isStowed) {
      riserGroup.position.z = 0.20;
      turntable.rotation.z = 0;
      gimbal.rotation.x = 0;
      gimbal.rotation.y = 0;
      matStatusLed.color.setHex(0xffaa22);
      matStatusLed.emissive.setHex(0xdd8800);
      matStatusLed.emissiveIntensity = 0.25;
    } else {
      matStatusLed.color.setHex(0x22ff66);
      matStatusLed.emissive.setHex(0x11cc44);
      matStatusLed.emissiveIntensity = 0.85;
    }
  }
  setStowed(Boolean(options.stowed));

  return {
    root,
    riserGroup,
    turntable,
    gimbal,
    missiles,
    pallet,
    wcid: DEPLOYABLE_WCID.MissileTurret,
    palletSize: "full",
    get stowed() { return isStowed; },
    setStowed,
    update(state = {}) {
      const s = state && typeof state === "object" ? state : {};
      if (s.stowed !== undefined) {
        setStowed(s.stowed);
      }
      if (isStowed) return;
      let riseNorm = 0;
      if (Number.isFinite(s.deployElevation)) {
        riseNorm = Math.min(1.0, Math.max(0.0, s.deployElevation));
      } else if (Number.isFinite(s.riseTimeSec)) {
        riseNorm = Math.min(1.0, Math.max(0.0, s.riseTimeSec / 0.35));
      }
      riserGroup.position.z = 0.20 + riseNorm * 0.65;
      if (Number.isFinite(s.yawRad)) turntable.rotation.z = s.yawRad;
      if (Number.isFinite(s.pitchRad)) gimbal.rotation.x = s.pitchRad;
      if (Number.isFinite(s.rollRad)) gimbal.rotation.y = s.rollRad;
      const ammo = s.ammoCount !== undefined ? s.ammoCount : s.ammoRemaining;
      if (ammo !== undefined && Number.isFinite(ammo)) {
        for (let i = 0; i < 4; i++) {
          missiles[i].visible = i < ammo; // vfx-lint-allow: ammo visibility update
        }
      }
    },
    dispose() {
      pallet.dispose();
      outriggers.geometry.dispose();
      outriggers.material.dispose();
      statusLed.geometry.dispose();
      statusLed.material.dispose();
      piston.geometry.dispose();
      piston.material.dispose();
      launcherPod.geometry.dispose();
      launcherPod.material.dispose();
      singleMissileGeom.dispose();
      matMissile.dispose();
    },
  };
}

// ---------------------------------------------------------------------------
// 6) Ground Radar (WCID 4000015, Half Pallet) — 30 RPM Surface Surveillance
//    - Fits Half GMA pad (<= 0.57 × 0.98 m)
//    - Slotted array folds flat to 0° horizontal when stowed (H_stowed <= 1.05 m, deployed ~1.95 m)
// ---------------------------------------------------------------------------
export function buildGroundRadar(three, options = {}) {
  const t = three || THREE_DEFAULT;
  const root = new t.Group();
  root.name = "ground-radar-root";
  const pallet = buildPallet(t, "half", options);
  root.add(pallet.root);

  const baseParts = [
    // Half-pallet pedestal cabinet (0.54 × 0.92 m <= 0.57 × 0.98 m)
    zBox(t, 0.54, 0.92, 0.46, 0x455241, 0, 0, 0.37),
    zBox(t, 0.46, 0.24, 0.16, 0x353f32, 0, -0.28, 0.66), // Angled console hood
  ];

  const matBase = new t.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    roughness: 0.60,
    metalness: 0.35,
  });
  matBase.castShadow = true;
  matBase.receiveShadow = true;
  if (options.csmState) installCsmShaderPatch(matBase, options.csmState);

  const baseMesh = new t.Mesh(mergeParts(t, baseParts), matBase);
  baseMesh.name = "ground-radar-pedestal";
  baseMesh.castShadow = true;
  baseMesh.receiveShadow = true;

  // Telescoping mast + rotary collar (built centered at local origin along Z so scale.z retracts cleanly)
  const mastGeom = mergeParts(t, [
    zCyl(t, 0.06, 0.09, 0.72, 10, 0x7c848a, 0, 0, 0),
    zCyl(t, 0.12, 0.12, 0.10, 12, 0x555c60, 0, 0, 0.39),
  ]);
  const mastMesh = new t.Mesh(mastGeom, matBase);
  mastMesh.name = "ground-radar-mast";
  mastMesh.position.set(0, 0.10, 0.96);
  mastMesh.castShadow = true;
  mastMesh.receiveShadow = true;

  // Glowing amber tactical scope screen (additive, 0 dynamic lights)
  const matScope = new t.MeshBasicMaterial({
    color: 0xffb833,
    transparent: true,
    opacity: 0.88,
    blending: t.AdditiveBlending,
    depthWrite: false,
  });
  const scopeMesh = new t.Mesh(new t.BoxGeometry(0.28, 0.03, 0.12), matScope);
  scopeMesh.position.set(0, -0.41, 0.66);

  const antennaGroup = new t.Group();
  antennaGroup.name = "slotted-array-antenna";
  antennaGroup.position.set(0, 0.10, 1.42);

  const antGeom = mergeParts(t, [
    zBox(t, 0.52, 0.12, 0.22, 0xd9822b, 0, 0, 0.04), // Slotted waveguide bar
    zBox(t, 0.50, 0.14, 0.06, 0x2b3036, 0, 0, 0.04), // Dark waveguide slot strip
    zBox(t, 0.16, 0.22, 0.14, 0x5e666c, 0, -0.06, -0.02), // Counterweight transceiver
    shadePart(t, new t.ConeGeometry(0.06, 0.16, 6), 0x8d959c, { ty: 0.14, tz: 0.04 }), // Forward feedhorn
  ]);
  const matAntenna = new t.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    roughness: 0.45,
    metalness: 0.55,
  });
  matAntenna.castShadow = true;
  matAntenna.receiveShadow = true;
  if (options.csmState) installCsmShaderPatch(matAntenna, options.csmState);

  const antMesh = new t.Mesh(antGeom, matAntenna);
  antMesh.castShadow = true;
  antMesh.receiveShadow = true;
  antennaGroup.add(antMesh);

  root.add(baseMesh, mastMesh, scopeMesh, antennaGroup);

  let isStowed = false;
  function setStowed(stowed) {
    isStowed = Boolean(stowed);
    if (isStowed) {
      mastMesh.scale.set(1, 1, 0.25);
      mastMesh.position.set(0, 0.10, 0.50);
      antennaGroup.position.set(0, 0.08, 0.66);
      antennaGroup.rotation.set(0, 0, 0);
      matScope.color.setHex(0xffaa22);
      matScope.opacity = 0.22;
    } else {
      mastMesh.scale.set(1, 1, 1);
      mastMesh.position.set(0, 0.10, 0.96);
      antennaGroup.position.set(0, 0.10, 1.42);
      matScope.color.setHex(0xffb833);
      matScope.opacity = 0.88;
    }
  }
  setStowed(Boolean(options.stowed));

  return {
    root,
    antennaGroup,
    pallet,
    wcid: DEPLOYABLE_WCID.GroundRadar,
    palletSize: "half",
    get stowed() { return isStowed; },
    setStowed,
    update(state = {}) {
      const s = state && typeof state === "object" ? state : {};
      if (s.stowed !== undefined) {
        setStowed(s.stowed);
      }
      if (isStowed) return;
      const time = Number.isFinite(s.simTimeSec) ? s.simTimeSec : 0;
      antennaGroup.rotation.z = (time * (30.0 * 2 * Math.PI / 60.0)) % (2 * Math.PI);
    },
    dispose() {
      pallet.dispose();
      baseMesh.geometry.dispose();
      mastMesh.geometry.dispose();
      baseMesh.material.dispose();
      scopeMesh.geometry.dispose();
      matScope.dispose();
      antMesh.geometry.dispose();
      antMesh.material.dispose();
    },
  };
}

// ---------------------------------------------------------------------------
// 7) Mortar Turret (WCID 4000016, Half Pallet)
//    - Fits Half GMA pad (<= 0.57 × 0.98 m)
//    - Barrel retracts to 0° horizontal cradle when stowed (H_stowed <= 1.15 m, deployed ~2.10 m)
// ---------------------------------------------------------------------------
export function buildMortarTurret(three, options = {}) {
  const t = three || THREE_DEFAULT;
  const root = new t.Group();
  root.name = "mortar-turret-root";
  const pallet = buildPallet(t, "half", options);
  root.add(pallet.root);

  // Heavy base plate & twin upright compressed-air pressure tanks (0.54 × 0.92 m <= 0.57 × 0.98 m)
  const baseGeom = mergeParts(t, [
    zBox(t, 0.54, 0.92, 0.14, 0x363d35, 0, 0, 0.21),
    zCyl(t, 0.24, 0.26, 0.12, 16, 0x454d43, 0, 0.12, 0.30), // Base recoil ring
    // Twin compressed-air tanks
    zCyl(t, 0.09, 0.09, 0.56, 12, 0x3d6b5e, -0.16, -0.32, 0.54),
    zCyl(t, 0.09, 0.09, 0.56, 12, 0x3d6b5e, 0.16, -0.32, 0.54),
    zBox(t, 0.38, 0.08, 0.08, 0xb8862d, 0, -0.32, 0.86), // Brass air manifold
  ]);
  const matRecoilRing = new t.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    roughness: 0.62,
    metalness: 0.38,
  });
  matRecoilRing.castShadow = true;
  matRecoilRing.receiveShadow = true;
  if (options.csmState) installCsmShaderPatch(matRecoilRing, options.csmState);

  const recoilRing = new t.Mesh(baseGeom, matRecoilRing);
  recoilRing.castShadow = true;
  recoilRing.receiveShadow = true;

  const carriage = new t.Group();
  carriage.name = "mortar-carriage";
  carriage.position.set(0, 0.12, 0.36);

  const cheekGeom = mergeParts(t, [
    zCyl(t, 0.20, 0.22, 0.10, 14, 0x4e574c, 0, 0, 0.04),
    zBox(t, 0.07, 0.30, 0.36, 0x556052, -0.16, 0, 0.22),
    zBox(t, 0.07, 0.30, 0.36, 0x556052, 0.16, 0, 0.22),
    zCyl(t, 0.07, 0.07, 0.24, 10, 0xc4ccd2, 0, -0.10, 0.18), // Pneumatic pop-up cylinder
  ]);
  const matCheek = new t.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    roughness: 0.55,
    metalness: 0.45,
  });
  matCheek.castShadow = true;
  matCheek.receiveShadow = true;
  if (options.csmState) installCsmShaderPatch(matCheek, options.csmState);

  const cheekMesh = new t.Mesh(cheekGeom, matCheek);
  cheekMesh.castShadow = true;
  cheekMesh.receiveShadow = true;

  const cradle = new t.Group();
  cradle.name = "mortar-cradle";
  cradle.position.set(0, 0, 0.32);
  cradle.rotation.x = -0.52;

  const matStatusLed = new t.MeshStandardMaterial({
    color: 0x22ff66,
    emissive: 0x11cc44,
    emissiveIntensity: 0.85,
    roughness: 0.25,
    metalness: 0.2,
  });
  if (options.csmState) installCsmShaderPatch(matStatusLed, options.csmState);
  const statusLed = new t.Mesh(new t.BoxGeometry(0.10, 0.03, 0.05), matStatusLed);
  statusLed.name = "mortar-status-led";
  statusLed.position.set(0, -0.45, 0.24);
  statusLed.castShadow = true;
  statusLed.receiveShadow = true;

  // Smoothbore pneumatic mortar tube + green chemical band
  const barrelGeom = mergeParts(t, [
    zCyl(t, 0.09, 0.11, 0.88, 14, 0x272b28, 0, 0, 0.0),
    zCyl(t, 0.11, 0.11, 0.09, 14, 0x2ec85a, 0, 0, 0.34), // Green mortar band
    zCyl(t, 0.13, 0.13, 0.18, 14, 0x4b534e, 0, 0, -0.37), // Breech plenum
  ]);
  const matBarrel = new t.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    roughness: 0.40,
    metalness: 0.60,
  });
  matBarrel.castShadow = true;
  matBarrel.receiveShadow = true;
  if (options.csmState) installCsmShaderPatch(matBarrel, options.csmState);

  const barrel = new t.Mesh(barrelGeom, matBarrel);
  barrel.position.set(0, 0, 0.42);
  barrel.castShadow = true;
  barrel.receiveShadow = true;

  cradle.add(barrel);
  carriage.add(cheekMesh, cradle);
  root.add(recoilRing, statusLed, carriage);

  let isStowed = false;
  function setStowed(stowed) {
    isStowed = Boolean(stowed);
    if (isStowed) {
      carriage.position.z = 0.36;
      carriage.rotation.z = 0;
      cradle.rotation.x = -Math.PI / 2;
      barrel.position.z = 0.42;
      matStatusLed.color.setHex(0xffaa22);
      matStatusLed.emissive.setHex(0xdd8800);
      matStatusLed.emissiveIntensity = 0.25;
    } else {
      cradle.rotation.x = -0.52;
      matStatusLed.color.setHex(0x22ff66);
      matStatusLed.emissive.setHex(0x11cc44);
      matStatusLed.emissiveIntensity = 0.85;
    }
  }
  setStowed(Boolean(options.stowed));

  return {
    root,
    carriage,
    cradle,
    barrel,
    pallet,
    wcid: DEPLOYABLE_WCID.MortarTurret,
    palletSize: "half",
    get stowed() { return isStowed; },
    setStowed,
    update(state = {}) {
      const s = state && typeof state === "object" ? state : {};
      if (s.stowed !== undefined) {
        setStowed(s.stowed);
      }
      if (isStowed) return;
      if (Number.isFinite(s.deployElevation)) {
        carriage.position.z = 0.36 + Math.min(1, Math.max(0, s.deployElevation)) * 0.24;
      }
      if (Number.isFinite(s.yawRad)) carriage.rotation.z = s.yawRad;
      if (Number.isFinite(s.pitchRad)) cradle.rotation.x = s.pitchRad;
      const safeRecoil = Number.isFinite(s.recoilSec) ? s.recoilSec : 0;
      const recoilKick = Math.max(0, safeRecoil * 0.10);
      barrel.position.z = 0.42 - recoilKick;
    },
    dispose() {
      pallet.dispose();
      recoilRing.geometry.dispose();
      recoilRing.material.dispose();
      statusLed.geometry.dispose();
      statusLed.material.dispose();
      cheekMesh.geometry.dispose();
      cheekMesh.material.dispose();
      barrel.geometry.dispose();
      barrel.material.dispose();
    },
  };
}

// ---------------------------------------------------------------------------
// 8) Heavy Laser Turret (WCID 4000017, Half Pallet)
//    - Fits Half GMA pad (<= 0.57 × 0.98 m)
//    - Emitters stow level at 0° when stowed (H_stowed <= 1.25 m)
// ---------------------------------------------------------------------------
export function buildHeavyLaserTurret(three, options = {}) {
  const t = three || THREE_DEFAULT;
  const root = new t.Group();
  root.name = "heavy-laser-turret-root";
  const pallet = buildPallet(t, "half", options);
  root.add(pallet.root);

  // Armored pedestal with copper thermal fins (0.54 × 0.92 m <= 0.57 × 0.98 m)
  const pedParts = [
    zBox(t, 0.54, 0.92, 0.14, 0x282c2e, 0, 0, 0.21),
    zCyl(t, 0.18, 0.24, 0.44, 12, 0x383e42, 0, 0, 0.48),
  ];
  for (let i = -2; i <= 2; i++) {
    pedParts.push(zBox(t, 0.46, 0.03, 0.26, 0xa84828, 0, -0.32 + i * 0.08, 0.42));
  }
  const matPedestal = new t.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    roughness: 0.65,
    metalness: 0.35,
  });
  matPedestal.castShadow = true;
  matPedestal.receiveShadow = true;
  if (options.csmState) installCsmShaderPatch(matPedestal, options.csmState);

  const pedestal = new t.Mesh(mergeParts(t, pedParts), matPedestal);
  pedestal.castShadow = true;
  pedestal.receiveShadow = true;

  const turretHead = new t.Group();
  turretHead.name = "laser-head-yaw";
  turretHead.position.set(0, 0, 0.72);

  const yokeGeom = mergeParts(t, [
    zCyl(t, 0.20, 0.20, 0.12, 12, 0x4c545a, 0, 0, 0.0),
    zBox(t, 0.08, 0.36, 0.36, 0x454c52, -0.22, 0, 0.18),
    zBox(t, 0.08, 0.36, 0.36, 0x454c52, 0.22, 0, 0.18),
  ]);
  const matYoke = new t.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    roughness: 0.50,
    metalness: 0.50,
  });
  matYoke.castShadow = true;
  matYoke.receiveShadow = true;
  if (options.csmState) installCsmShaderPatch(matYoke, options.csmState);

  const yokeMesh = new t.Mesh(yokeGeom, matYoke);
  yokeMesh.castShadow = true;
  yokeMesh.receiveShadow = true;

  const barrelGimbal = new t.Group();
  barrelGimbal.name = "laser-barrels-pitch";
  barrelGimbal.position.set(0, 0, 0.24);

  // Faceted twin gunmetal laser emitter barrels pointing forward along +Y
  const barrelGeom = mergeParts(t, [
    zBox(t, 0.38, 0.56, 0.30, 0x32373c, 0, -0.05, 0),
    yCyl(t, 0.065, 0.075, 0.98, 10, 0x202428, -0.12, 0.44, 0.02),
    yCyl(t, 0.065, 0.075, 0.98, 10, 0x202428, 0.12, 0.44, 0.02),
    // Focusing shroud rings
    yCyl(t, 0.085, 0.085, 0.08, 10, 0x6c757d, -0.12, 0.86, 0.02),
    yCyl(t, 0.085, 0.085, 0.08, 10, 0x6c757d, 0.12, 0.86, 0.02),
    // Top dual-mode optical director pod
    zBox(t, 0.18, 0.28, 0.12, 0x4f5860, 0, 0.05, 0.20),
  ]);
  const matBarrel = new t.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    roughness: 0.35,
    metalness: 0.65,
  });
  matBarrel.castShadow = true;
  matBarrel.receiveShadow = true;
  if (options.csmState) installCsmShaderPatch(matBarrel, options.csmState);

  const barrelMesh = new t.Mesh(barrelGeom, matBarrel);
  barrelMesh.castShadow = true;
  barrelMesh.receiveShadow = true;

  // Glowing crimson capacitor rails & twin ruby focusing lenses (additive, 0 dynamic lights)
  const glowGeom = mergeParts(t, [
    yCyl(t, 0.05, 0.05, 0.04, 10, 0xff2233, -0.12, 0.91, 0.02),
    yCyl(t, 0.05, 0.05, 0.04, 10, 0xff2233, 0.12, 0.91, 0.02),
    zBox(t, 0.40, 0.36, 0.06, 0xff1828, 0, -0.06, 0.02),
  ]);
  const matLaserGlow = new t.MeshBasicMaterial({
    color: 0xff2233,
    transparent: true,
    opacity: 0.9,
    blending: t.AdditiveBlending,
    depthWrite: false,
  });
  const glowMesh = new t.Mesh(glowGeom, matLaserGlow);

  barrelGimbal.add(barrelMesh, glowMesh);
  turretHead.add(yokeMesh, barrelGimbal);
  root.add(pedestal, turretHead);

  let isStowed = false;
  function setStowed(stowed) {
    isStowed = Boolean(stowed);
    if (isStowed) {
      turretHead.rotation.z = 0;
      barrelGimbal.rotation.x = 0;
      matLaserGlow.color.setHex(0xffaa22);
      matLaserGlow.opacity = 0.22;
    } else {
      matLaserGlow.color.setHex(0xff2233);
      matLaserGlow.opacity = 0.90;
    }
  }
  setStowed(Boolean(options.stowed));

  return {
    root,
    turretHead,
    barrelGimbal,
    pallet,
    wcid: DEPLOYABLE_WCID.HeavyLaserTurret,
    palletSize: "half",
    get stowed() { return isStowed; },
    setStowed,
    update(state = {}) {
      const s = state && typeof state === "object" ? state : {};
      if (s.stowed !== undefined) {
        setStowed(s.stowed);
      }
      if (isStowed) return;
      if (Number.isFinite(s.yawRad)) turretHead.rotation.z = s.yawRad;
      if (Number.isFinite(s.pitchRad)) barrelGimbal.rotation.x = s.pitchRad;
    },
    dispose() {
      pallet.dispose();
      pedestal.geometry.dispose();
      pedestal.material.dispose();
      yokeMesh.geometry.dispose();
      yokeMesh.material.dispose();
      barrelMesh.geometry.dispose();
      barrelMesh.material.dispose();
      glowMesh.geometry.dispose();
      matLaserGlow.dispose();
    },
  };
}

export function buildDeployable(three, wcid, options = {}) {
  switch (wcid) {
    case DEPLOYABLE_WCID.FluxPod:
      return buildFluxPod(three, options);
    case DEPLOYABLE_WCID.SolarPanels:
      return buildSolarPanels(three, options);
    case DEPLOYABLE_WCID.PowerGenerator:
      return buildPowerGenerator(three, options);
    case DEPLOYABLE_WCID.BatteryUnit:
      return buildBatteryUnit(three, options);
    case DEPLOYABLE_WCID.MissileTurret:
      return buildMissileTurret(three, options);
    case DEPLOYABLE_WCID.GroundRadar:
      return buildGroundRadar(three, options);
    case DEPLOYABLE_WCID.MortarTurret:
      return buildMortarTurret(three, options);
    case DEPLOYABLE_WCID.HeavyLaserTurret:
      return buildHeavyLaserTurret(three, options);
    default:
      throw new Error(`Unknown deployable WCID: ${wcid}`);
  }
}

export const manifest = Object.freeze({
  id: "vfx-deployable-models",
  channel: "vehicleModel",
  deterministic: true,
  lightCountDelta: 0,
  cacheKeyScope: "set",
  reads: Object.freeze(["geometry", "serverPose", "clock"]),
  writes: Object.freeze(["renderTransform", "partTransform", "materialUniform"]),
});
