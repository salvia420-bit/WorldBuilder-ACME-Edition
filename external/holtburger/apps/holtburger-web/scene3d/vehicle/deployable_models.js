// scene3d/vehicle/deployable_models.js — 8-Unit Modular Full/Half Pallet Deployable 3D Procedural Models
// Conforms to HBV1 v4 wire protocol, PROJECT.md, and strict GPU invariants (lightCountDelta === 0, draw calls <= 10).
// Built in AC Z-up coordinates (+x east/right, +y north/forward, +z up) with baked directional vertex shading.

import * as THREE_DEFAULT from "three";

export const PALLET_SPECS = Object.freeze({
  full: Object.freeze({
    width: 2.40,
    depth: 2.40,
    height: 0.15,
    slots: 2,
    bboxMin: Object.freeze([-1.20, -1.20, 0.0]),
    bboxMax: Object.freeze([1.20, 1.20, 0.15]),
  }),
  half: Object.freeze({
    width: 1.20,
    depth: 2.40,
    height: 0.15,
    slots: 1,
    bboxMin: Object.freeze([-0.60, -1.20, 0.0]),
    bboxMax: Object.freeze([0.60, 1.20, 0.15]),
  }),
  mountOffsets: Object.freeze({
    fullBed: Object.freeze([0.0, -1.15, 0.72]),
    halfSlot0: Object.freeze([-0.60, -1.15, 0.72]),
    halfSlot1: Object.freeze([0.60, -1.15, 0.72]),
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
// Vertex-Colored Z-Up Geometry Helpers (Zero Lights, Crisp 3D Facet Shading)
// ---------------------------------------------------------------------------
const SUN_DIR = [0.44, -0.52, 0.73]; // Normalized AC Z-up sun vector for baked facet contrast

function shadePart(t, rawGeom, hexColor, { rx = 0, ry = 0, rz = 0, tx = 0, ty = 0, tz = 0 } = {}) {
  const g = rawGeom.index ? rawGeom.toNonIndexed() : rawGeom.clone();
  rawGeom.dispose();
  if (rx) g.rotateX(rx);
  if (ry) g.rotateY(ry);
  if (rz) g.rotateZ(rz);
  if (tx || ty || tz) g.translate(tx, ty, tz);
  g.computeVertexNormals();

  // Keep only position + normal + color so mergeGeometries always succeeds
  for (const name of Object.keys(g.attributes)) {
    if (name !== "position" && name !== "normal") g.deleteAttribute(name);
  }

  const pos = g.getAttribute("position");
  const nrm = g.getAttribute("normal");
  const col = new Float32Array(pos.count * 3);
  const base = new t.Color(hexColor);

  for (let i = 0; i < pos.count; i++) {
    const nx = nrm ? nrm.getX(i) : 0;
    const ny = nrm ? nrm.getY(i) : 0;
    const nz = nrm ? nrm.getZ(i) : 1;
    const ndotl = Math.max(0, nx * SUN_DIR[0] + ny * SUN_DIR[1] + nz * SUN_DIR[2]);
    const upBias = 0.5 + 0.5 * nz;
    const shade = 0.46 + 0.44 * ndotl + 0.14 * upBias;
    col[i * 3 + 0] = Math.min(1, base.r * shade);
    col[i * 3 + 1] = Math.min(1, base.g * shade);
    col[i * 3 + 2] = Math.min(1, base.b * shade);
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
// Industrial Full Pallet (2.40 x 2.40 x 0.15m) & Half Pallet (1.20 x 2.40 x 0.15m)
// Merged into a single 1-draw-call BufferGeometry with exact outer bounding box!
// ---------------------------------------------------------------------------
export function buildPallet(three, size = "full") {
  const t = three || THREE_DEFAULT;
  const spec = size === "half" ? PALLET_SPECS.half : PALLET_SPECS.full;
  const root = new t.Group();
  root.name = `pallet-${size}-root`;

  const W = spec.width;
  const D = spec.depth;
  const H = spec.height; // 0.15m, local z in [-H/2, +H/2] because mesh sits at z = H/2
  const halfW = W / 2;
  const halfD = D / 2;
  const halfH = H / 2;

  const parts = [];
  // 1. Three bottom steel runner skids (flush with z = -halfH and y = ±halfD)
  const skidW = size === "half" ? 0.12 : 0.16;
  const skidPositionsX = size === "half"
    ? [-halfW + skidW / 2, 0, halfW - skidW / 2]
    : [-halfW + skidW / 2, 0, halfW - skidW / 2];
  for (const sx of skidPositionsX) {
    parts.push(zBox(t, skidW, D, 0.028, 0x34383d, sx, 0, -halfH + 0.014));
  }

  // 2. Longitudinal steel stringer blocks (leaving 2 forklift pocket gaps along Y!)
  const blockY = [-halfD + 0.22, 0, halfD - 0.22];
  for (const sx of skidPositionsX) {
    for (const by of blockY) {
      parts.push(zBox(t, skidW, 0.44, 0.084, 0x454b52, sx, by, -halfH + 0.028 + 0.042));
    }
  }

  // 3. Seven treated hardwood slatted deck planks across Y (outer planks flush with ±halfW, ±halfD, +halfH)
  const nPlanks = 7;
  const plankDepth = 0.27;
  for (let i = 0; i < nPlanks; i++) {
    const py = -halfD + plankDepth / 2 + (i / (nPlanks - 1)) * (D - plankDepth);
    const woodTone = i % 2 === 0 ? 0x6b533b : 0x5d4732;
    parts.push(zBox(t, W, plankDepth, 0.038, woodTone, 0, py, halfH - 0.019));
  }

  // 4. Steel perimeter rub-rail corners (inset 1mm so exact bbox stays W x D x H)
  const cW = 0.14;
  for (const cx of [-halfW + cW / 2, halfW - cW / 2]) {
    for (const cy of [-halfD + cW / 2, halfD - cW / 2]) {
      parts.push(zBox(t, cW, cW, H * 0.96, 0xd4881c, cx, cy, 0));
    }
  }

  const geom = mergeParts(t, parts);
  const mat = new t.MeshBasicMaterial({ vertexColors: true });
  const mesh = new t.Mesh(geom, mat);
  mesh.name = `pallet-${size}-deck`;
  mesh.position.set(0, 0, spec.height / 2);
  root.add(mesh);

  return {
    root,
    mesh,
    spec,
    size,
    alignToNormal(normal) {
      if (!normal || normal.lengthSq() < 1e-6) return;
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
//    - Square concrete base atop pallet
//    - Squarish structure with 4 concrete corner pillars & plasma-yellow behind glass
//    - Gray square roof deck abutted by bright orange 4-sided overhang
//    - Flashing lights on all 4 sides of the overhang
//    - Strange asymmetric antennas jutting out from 3 corners of the overhang
//    - Dark-orange Incan stepped pyramidal "cone" at center of the gray square
// ---------------------------------------------------------------------------
export function buildFluxPod(three, options = {}) {
  const t = three || THREE_DEFAULT;
  const root = new t.Group();
  root.name = "flux-pod-root";
  const pallet = buildPallet(t, "full");
  root.add(pallet.root);

  const staticParts = [];

  // A. Square concrete base on top of the pallet (stepped chamfered concrete pad)
  staticParts.push(zBox(t, 2.24, 2.24, 0.22, 0x7c807a, 0, 0, 0.26));
  staticParts.push(zBox(t, 1.98, 1.98, 0.10, 0x8a8e88, 0, 0, 0.42));

  // B. 4 Concrete corner columns framing the squarish core structure under the overhang
  for (const cx of [-0.76, 0.76]) {
    for (const cy of [-0.76, 0.76]) {
      staticParts.push(zBox(t, 0.30, 0.30, 1.44, 0x868a84, cx, cy, 1.19));
      // Concrete column base & capital collars
      staticParts.push(zBox(t, 0.36, 0.36, 0.10, 0x6e726c, cx, cy, 0.52));
      staticParts.push(zBox(t, 0.36, 0.36, 0.10, 0x6e726c, cx, cy, 1.86));
    }
  }
  // Dark window mullions framing the glass & plasma yellow on all 4 faces
  for (const side of [-0.78, 0.78]) {
    staticParts.push(zBox(t, 1.24, 0.05, 0.06, 0x35393c, 0, side, 1.19));
    staticParts.push(zBox(t, 0.05, 1.24, 0.06, 0x35393c, side, 0, 1.19));
  }

  // C. Bright orange 4-sided overhang abutting the central gray square deck
  //    4 outer overhang beams forming a crisp 2.38m bright-orange perimeter cornice around the 1.66m gray square!
  const ohZ = 2.02;
  const ohH = 0.20;
  staticParts.push(zBox(t, 2.38, 0.38, ohH, 0xff6a00, 0, 1.00, ohZ));  // North overhang
  staticParts.push(zBox(t, 2.38, 0.38, ohH, 0xff6a00, 0, -1.00, ohZ)); // South overhang
  staticParts.push(zBox(t, 0.38, 1.62, ohH, 0xff6a00, 1.00, 0, ohZ));  // East overhang
  staticParts.push(zBox(t, 0.38, 1.62, ohH, 0xff6a00, -1.00, 0, ohZ)); // West overhang

  // Central gray square roof deck abutted on all 4 sides by the bright orange overhang
  staticParts.push(zBox(t, 1.66, 1.66, 0.22, 0x6c737a, 0, 0, 2.05));
  staticParts.push(zBox(t, 1.42, 1.42, 0.06, 0x7c848c, 0, 0, 2.19));

  // D. Strange asymmetric antennas jutting out from 3 corners of the overhang (NE, NW, SE; SW bare!)
  const antennaCorners = [
    { x: 1.08, y: 1.08, rx: -0.52, ry: 0.52, rz: 0.3 },   // NE corner
    { x: -1.08, y: 1.08, rx: -0.56, ry: -0.48, rz: -0.2 }, // NW corner
    { x: 1.08, y: -1.08, rx: 0.54, ry: 0.50, rz: 0.6 },   // SE corner
  ];
  for (let ai = 0; ai < antennaCorners.length; ai++) {
    const c = antennaCorners[ai];
    const dirX = Math.sign(c.x);
    const dirY = Math.sign(c.y);
    // Corner mount bracket
    staticParts.push(zBox(t, 0.18, 0.18, 0.14, 0x3b4046, c.x, c.y, 2.14));
    // Jutting main oblique boom
    staticParts.push(zBox(t, 0.045, 0.045, 0.92, 0x9aa4ad, c.x + dirX * 0.28, c.y + dirY * 0.28, 2.48, {
      rx: -dirY * 0.58,
      ry: dirX * 0.58,
    }));
    // Strange tuning forks / cross-dipoles / arcane induction rings along the boom
    staticParts.push(zBox(t, 0.42, 0.03, 0.03, 0xd89b28, c.x + dirX * 0.36, c.y + dirY * 0.36, 2.58, {
      rz: ai * 0.7 + 0.78,
    }));
    staticParts.push(zBox(t, 0.28, 0.025, 0.025, 0xc0cad4, c.x + dirX * 0.48, c.y + dirY * 0.48, 2.74, {
      rz: -ai * 0.5 + 0.4,
    }));
    staticParts.push(zCyl(t, 0.06, 0.02, 0.16, 6, 0xff6a00, c.x + dirX * 0.54, c.y + dirY * 0.54, 2.84));
  }

  // E. Dark-orange "cone", Incan stepped pyramidal centerpiece atop the gray square!
  const incanTiers = [
    { w: 1.12, h: 0.18, z: 2.31, col: 0xa83808 },
    { w: 0.88, h: 0.18, z: 2.49, col: 0xb63f0a },
    { w: 0.64, h: 0.18, z: 2.67, col: 0xc4470d },
    { w: 0.42, h: 0.18, z: 2.85, col: 0xd15012 },
  ];
  for (const tier of incanTiers) {
    staticParts.push(zBox(t, tier.w, tier.w, tier.h, tier.col, 0, 0, tier.z));
  }
  // Stepped Incan pyramidal capstone cone (4-sided upright pyramid along +Z)
  staticParts.push(shadePart(t, new t.ConeGeometry(0.24, 0.26, 4), 0xba410b, {
    rx: Math.PI / 2,
    rz: Math.PI / 4,
    tz: 3.07,
  }));

  const structureMesh = new t.Mesh(
    mergeParts(t, staticParts),
    new t.MeshBasicMaterial({ vertexColors: true })
  );
  structureMesh.name = "flux-pod-structure";

  // Glowing plasma-yellow core & corner-to-corner plasma conduits visible behind the glass!
  const plasmaParts = [
    zCyl(t, 0.42, 0.42, 1.32, 12, 0xffe838, 0, 0, 1.19),
    zBox(t, 1.46, 1.46, 1.26, 0xffd000, 0, 0, 1.19),
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

  // Containment glass panels between the concrete corners
  const matGlass = new t.MeshBasicMaterial({
    color: 0x9ce2ff,
    transparent: true,
    opacity: 0.34,
    depthWrite: false,
  });
  const glassBox = new t.Mesh(new t.BoxGeometry(1.58, 1.58, 1.38), matGlass);
  glassBox.name = "flux-pod-glass";
  glassBox.position.set(0, 0, 1.19);

  // Flashing beacon lights on ALL FOUR SIDES of the bright orange overhang (2 alternating pairs = 2 draw calls)
  const lightsNSGeom = mergeParts(t, [
    zBox(t, 0.46, 0.06, 0.08, 0xffffff, 0, 1.20, ohZ),
    zBox(t, 0.46, 0.06, 0.08, 0xffffff, 0, -1.20, ohZ),
    zBox(t, 0.16, 0.06, 0.08, 0xffffff, -0.68, 1.20, ohZ),
    zBox(t, 0.16, 0.06, 0.08, 0xffffff, 0.68, -1.20, ohZ),
  ]);
  const lightsEWGeom = mergeParts(t, [
    zBox(t, 0.06, 0.46, 0.08, 0xffffff, 1.20, 0, ohZ),
    zBox(t, 0.06, 0.46, 0.08, 0xffffff, -1.20, 0, ohZ),
    zBox(t, 0.06, 0.16, 0.08, 0xffffff, 1.20, 0.68, ohZ),
    zBox(t, 0.06, 0.16, 0.08, 0xffffff, -1.20, -0.68, ohZ),
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

  root.add(structureMesh, core, glassBox, lightsNS, lightsEW);

  return {
    root,
    core,
    lightsNS,
    lightsEW,
    pallet,
    wcid: DEPLOYABLE_WCID.FluxPod,
    palletSize: "full",
    update(state = {}) {
      const time = Number.isFinite(state.simTimeSec) ? state.simTimeSec : 0;
      matCore.opacity = 0.7 + 0.3 * Math.sin(4.0 * time);
      const wave = 0.5 + 0.5 * Math.sin(7.5 * time);
      matFlashNS.opacity = 0.2 + 0.8 * wave;
      matFlashEW.opacity = 0.2 + 0.8 * (1.0 - wave);
    },
    dispose() {
      pallet.dispose();
      root.traverse((obj) => {
        if (obj === pallet.mesh) return;
        if (obj.geometry) obj.geometry.dispose();
        if (obj.material) {
          if (Array.isArray(obj.material)) obj.material.forEach((m) => m.dispose());
          else obj.material.dispose();
        }
      });
    },
  };
}

// ---------------------------------------------------------------------------
// 2) Solar Panels (WCID 4000011, Full Pallet)
// ---------------------------------------------------------------------------
export function buildSolarPanels(three, options = {}) {
  const t = three || THREE_DEFAULT;
  const root = new t.Group();
  root.name = "solar-panels-root";
  const pallet = buildPallet(t, "full");
  root.add(pallet.root);

  // Upright +Z steel pedestal, inverter cabinet & base collar
  const pedGeom = mergeParts(t, [
    zBox(t, 1.30, 1.30, 0.12, 0x4b5258, 0, 0, 0.21),
    zCyl(t, 0.16, 0.24, 1.28, 12, 0x626a72, 0, 0, 0.88),
    zBox(t, 0.52, 0.36, 0.48, 0x3b4248, 0, -0.45, 0.50), // Inverter box
    zBox(t, 0.20, 0.04, 0.10, 0x2fd866, 0, -0.64, 0.58), // Status panel
  ]);
  const pedestal = new t.Mesh(pedGeom, new t.MeshBasicMaterial({ vertexColors: true }));
  pedestal.name = "solar-pedestal";

  const turntable = new t.Group();
  turntable.name = "azimuth-turntable";
  turntable.position.set(0, 0, 1.55);

  const trunnion = new t.Group();
  trunnion.name = "elevation-trunnion";

  function makeSolarWingGeom(signX) {
    const cx = signX * 0.62;
    const parts = [
      // Silver anodized aluminum outer frame
      zBox(t, 1.08, 2.16, 0.048, 0xb8c2cc, cx, 0, 0),
      // Rich monocrystalline silicon PV bed (visible on both top & tilted faces)
      zBox(t, 1.00, 2.08, 0.060, 0x1b4f9c, cx, 0, 0),
    ];
    // Silver busbars & cell grid ribbons
    for (const bx of [-0.30, 0, 0.30]) {
      parts.push(zBox(t, 0.020, 2.04, 0.068, 0x9ec0e6, cx + bx, 0, 0));
    }
    for (let gy = -0.80; gy <= 0.81; gy += 0.40) {
      parts.push(zBox(t, 0.98, 0.016, 0.068, 0x7ca2cc, cx, gy, 0));
    }
    return mergeParts(t, parts);
  }

  const matWing = new t.MeshBasicMaterial({ vertexColors: true });
  const leftWing = new t.Mesh(makeSolarWingGeom(-1), matWing);
  const rightWing = new t.Mesh(makeSolarWingGeom(+1), matWing.clone());

  const actGeom = mergeParts(t, [
    zBox(t, 0.26, 0.30, 0.14, 0x555d65, 0, 0, -0.06),
    zCyl(t, 0.045, 0.045, 0.62, 8, 0xc8d0d8, 0, -0.28, -0.26),
  ]);
  const actuators = new t.Mesh(actGeom, new t.MeshBasicMaterial({ vertexColors: true }));

  trunnion.add(leftWing, rightWing, actuators);
  turntable.add(trunnion);
  root.add(pedestal, turntable);

  return {
    root,
    turntable,
    trunnion,
    leftWing,
    rightWing,
    pallet,
    wcid: DEPLOYABLE_WCID.SolarPanels,
    palletSize: "full",
    update(state = {}) {
      const hdg = state.sunHeading !== undefined ? state.sunHeading : state.sunAzimuthRad;
      const pit = state.sunPitch !== undefined ? state.sunPitch : state.sunPitchRad;
      if (Number.isFinite(hdg)) turntable.rotation.z = hdg;
      if (Number.isFinite(pit)) {
        trunnion.rotation.x = pit > 0 ? Math.max(0, Math.min(Math.PI / 2, pit)) : 0;
      }
    },
    dispose() {
      pallet.dispose();
      root.traverse((obj) => {
        if (obj === pallet.mesh) return;
        if (obj.geometry) obj.geometry.dispose();
        if (obj.material) {
          if (Array.isArray(obj.material)) obj.material.forEach((m) => m.dispose());
          else obj.material.dispose();
        }
      });
    },
  };
}

// ---------------------------------------------------------------------------
// 3) Power Generator (WCID 4000012, Full Pallet) — Burns Platinum Scarabs
// ---------------------------------------------------------------------------
export function buildPowerGenerator(three, options = {}) {
  const t = three || THREE_DEFAULT;
  const root = new t.Group();
  root.name = "power-generator-root";
  const pallet = buildPallet(t, "full");
  root.add(pallet.root);

  const bodyParts = [
    // Heavy steel generator skid & louvered engine block
    zBox(t, 2.04, 1.96, 0.72, 0x3b4238, 0, 0, 0.51),
    zBox(t, 1.72, 1.18, 0.62, 0x4f564b, -0.08, -0.10, 1.12),
    // Horizontal turbine barrel along +Y
    yCyl(t, 0.42, 0.42, 1.38, 14, 0x676e63, -0.15, 0.0, 1.24),
    // Copper/brass arcane induction coils
    yCyl(t, 0.46, 0.46, 0.14, 14, 0xc27a38, -0.15, -0.32, 1.24),
    yCyl(t, 0.46, 0.46, 0.14, 14, 0xc27a38, -0.15, 0.32, 1.24),
    // Platinum Scarab armored hopper & feed chute on starboard side
    zBox(t, 0.62, 0.68, 0.74, 0x8d7f70, 0.64, 0.36, 1.16),
    zBox(t, 0.68, 0.74, 0.10, 0xb87333, 0.64, 0.36, 1.56),
    // Upright +Z exhaust stack + muffler cage
    zCyl(t, 0.11, 0.13, 0.95, 10, 0x2c302c, -0.68, -0.62, 1.34),
    zCyl(t, 0.08, 0.08, 0.48, 10, 0x444844, -0.68, -0.62, 1.98),
  ];
  const bodyMesh = new t.Mesh(mergeParts(t, bodyParts), new t.MeshBasicMaterial({ vertexColors: true }));
  bodyMesh.name = "generator-chassis-turbine";

  // Spinning flywheel at front of turbine (rotates about its axis via flywheel.rotation.z after rx=PI/2 group or yCyl)
  const fwGeom = mergeParts(t, [
    zCyl(t, 0.38, 0.38, 0.10, 16, 0x282c28, 0, 0, 0),
    zBox(t, 0.68, 0.08, 0.12, 0xd49b2a, 0, 0, 0),
    zBox(t, 0.08, 0.68, 0.12, 0xd49b2a, 0, 0, 0),
  ]);
  const flywheelPivot = new t.Group();
  flywheelPivot.position.set(-0.15, 0.76, 1.24);
  flywheelPivot.rotation.x = Math.PI / 2;
  const flywheel = new t.Mesh(fwGeom, new t.MeshBasicMaterial({ vertexColors: true }));
  flywheelPivot.add(flywheel);

  // Platinum-cyan arcane scarab combustion chamber glow
  const matArcaneGlow = new t.MeshBasicMaterial({
    color: 0x66eeff,
    transparent: true,
    opacity: 0.82,
    blending: t.AdditiveBlending,
    depthWrite: false,
  });
  const glowGeom = mergeParts(t, [
    zBox(t, 0.38, 0.42, 0.44, 0x77f0ff, 0.64, 0.36, 1.22),
    yCyl(t, 0.26, 0.26, 0.90, 10, 0x55ddff, -0.15, 0, 1.24),
  ]);
  const glowCore = new t.Mesh(glowGeom, matArcaneGlow);
  glowCore.name = "generator-scarab-glow";

  root.add(bodyMesh, flywheelPivot, glowCore);

  let flywheelAngle = 0;
  return {
    root,
    flywheel,
    glowCore,
    pallet,
    wcid: DEPLOYABLE_WCID.PowerGenerator,
    palletSize: "full",
    get flywheelAngle() { return flywheelAngle; },
    update(state = {}) {
      const dt = Number.isFinite(state.dt) && state.dt >= 0 ? state.dt : 0.0333;
      const fuel = state.fuelSecondsRemaining !== undefined ? state.fuelSecondsRemaining : state.fuelRemaining;
      const isFueled = Boolean((Number.isFinite(fuel) && fuel > 0) || state.online);
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
      root.traverse((obj) => {
        if (obj === pallet.mesh) return;
        if (obj.geometry) obj.geometry.dispose();
        if (obj.material) {
          if (Array.isArray(obj.material)) obj.material.forEach((m) => m.dispose());
          else obj.material.dispose();
        }
      });
    },
  };
}

// ---------------------------------------------------------------------------
// 4) Battery Unit (WCID 4000013, Half Pallet) — 600 kJ Capacitor Bank
// ---------------------------------------------------------------------------
export function buildBatteryUnit(three, options = {}) {
  const t = three || THREE_DEFAULT;
  const root = new t.Group();
  root.name = "battery-unit-root";
  const pallet = buildPallet(t, "half");
  root.add(pallet.root);

  const bankParts = [
    // Ruggedized half-pallet steel cage & base plinth
    zBox(t, 1.06, 2.18, 0.24, 0x2c3330, 0, 0, 0.27),
    zBox(t, 1.02, 0.12, 1.16, 0x38403d, 0, -1.00, 0.85),
    zBox(t, 1.02, 0.12, 1.16, 0x38403d, 0, 1.00, 0.85),
    zBox(t, 1.04, 2.14, 0.08, 0x38403d, 0, 0, 1.44),
    // Heavy gold-copper top busbars
    zBox(t, 0.08, 1.84, 0.06, 0xd4a437, -0.26, 0, 1.36),
    zBox(t, 0.08, 1.84, 0.06, 0xd4a437, 0.26, 0, 1.36),
    // Dark bezel panel for the 5 SoC LED bars
    zBox(t, 0.06, 0.48, 0.94, 0x161a18, 0.51, 0, 0.88),
  ];
  // 6 upright +Z high-density blue cylindrical capacitor cells (2x3)
  for (const cx of [-0.26, 0.26]) {
    for (const cy of [-0.62, 0, 0.62]) {
      bankParts.push(zCyl(t, 0.19, 0.19, 0.96, 12, 0x1d5494, cx, cy, 0.86));
      bankParts.push(zCyl(t, 0.07, 0.07, 0.08, 8, 0xd4a437, cx, cy, 1.36));
    }
  }
  const bankMesh = new t.Mesh(mergeParts(t, bankParts), new t.MeshBasicMaterial({ vertexColors: true }));
  bankMesh.name = "battery-capacitor-bank";
  root.add(bankMesh);

  const socBars = [];
  const matOff = new t.MeshBasicMaterial({ color: 0x222222 });
  const matOn = new t.MeshBasicMaterial({ color: 0x00ff66 });
  for (let i = 0; i < 5; i++) {
    const barMesh = new t.Mesh(new t.BoxGeometry(0.06, 0.36, 0.11), matOff);
    barMesh.position.set(0.53, 0, 0.54 + i * 0.17);
    socBars.push(barMesh);
    root.add(barMesh);
  }

  return {
    root,
    socBars,
    pallet,
    wcid: DEPLOYABLE_WCID.BatteryUnit,
    palletSize: "half",
    update(state = {}) {
      const joules = state.capacitorJoules !== undefined ? state.capacitorJoules : state.energyJoules;
      const safeJ = Number.isFinite(joules) ? joules : 0;
      const activeBars = Math.max(0, Math.min(5, Math.floor(safeJ / 120000.0)));
      for (let i = 0; i < 5; i++) {
        socBars[i].material = i < activeBars ? matOn : matOff;
      }
    },
    dispose() {
      pallet.dispose();
      bankMesh.geometry.dispose();
      bankMesh.material.dispose();
      for (const b of socBars) b.geometry.dispose();
      matOff.dispose();
      matOn.dispose();
    },
  };
}

// ---------------------------------------------------------------------------
// 5) Autonomous Missile Turret (WCID 4000014, Full Pallet)
//    - Sudden 0.35s vertical rise on 4 pneumatic cylinders
//    - Agile 3-axis (X, Y, Z) gimbal rotation beneath squarish 4-missile pod
// ---------------------------------------------------------------------------
export function buildMissileTurret(three, options = {}) {
  const t = three || THREE_DEFAULT;
  const root = new t.Group();
  root.name = "missile-turret-root";
  const pallet = buildPallet(t, "full");
  root.add(pallet.root);

  // Armored full-pallet base housing & 4 corner pneumatic outer sleeves
  const baseParts = [
    zBox(t, 2.24, 2.24, 0.22, 0x3e4637, 0, 0, 0.26),
    zBox(t, 1.64, 1.64, 0.36, 0x31382c, 0, 0, 0.46),
  ];
  for (const px of [-0.52, 0.52]) {
    for (const py of [-0.52, 0.52]) {
      baseParts.push(zCyl(t, 0.11, 0.12, 0.54, 10, 0x4b5344, px, py, 0.52));
    }
  }
  const outriggers = new t.Mesh(mergeParts(t, baseParts), new t.MeshBasicMaterial({ vertexColors: true }));
  outriggers.name = "sam-base-well";

  // Pneumatic riser group (suddenly rises +0.80m in 0.35s!)
  const riserGroup = new t.Group();
  riserGroup.name = "pneumatic-riser";
  riserGroup.position.set(0, 0, 0.25);

  const pistonParts = [
    zBox(t, 1.32, 1.32, 0.12, 0x464f3f, 0, 0, 0.92), // Riser top plate
    zCyl(t, 0.22, 0.26, 0.88, 12, 0x7b8288, 0, 0, 0.50), // Central hydraulic ram
  ];
  for (const px of [-0.52, 0.52]) {
    for (const py of [-0.52, 0.52]) {
      pistonParts.push(zCyl(t, 0.065, 0.065, 0.90, 10, 0xd8e0e8, px, py, 0.50)); // 4 bright chrome pneumatic rods
    }
  }
  const piston = new t.Mesh(mergeParts(t, pistonParts), new t.MeshBasicMaterial({ vertexColors: true }));
  piston.name = "pneumatic-cylinders";

  // Agile 3-axis gimbal (Z yaw -> X pitch -> Y roll)
  const turntable = new t.Group();
  turntable.name = "turret-yaw";
  turntable.position.set(0, 0, 1.06);

  const gimbal = new t.Group();
  gimbal.name = "turret-pitch";

  // Squarish 4-cell armored SAM pod + electro-optical tracking dome
  const podGeom = mergeParts(t, [
    zCyl(t, 0.28, 0.32, 0.24, 12, 0x525a4b, 0, 0, -0.02), // Spherical/wrist gimbal hub
    zBox(t, 1.18, 1.48, 0.78, 0x3b4434, 0, 0, 0.44),      // Squarish armored launcher box
    zBox(t, 1.24, 0.16, 0.84, 0x56614c, 0, 0.66, 0.44),   // Front armored bezel
    zBox(t, 0.34, 0.38, 0.24, 0x282d26, 0, 0.18, 0.92),   // Top EO/IR sensor housing
    yCyl(t, 0.09, 0.09, 0.08, 10, 0xffaa22, 0, 0.38, 0.92), // Amber optics lens
  ]);
  const launcherPod = new t.Mesh(podGeom, new t.MeshBasicMaterial({ vertexColors: true }));

  // 4 Individually visible SAM missiles pointing forward (+Y) in 2x2 cells
  const singleMissileGeom = mergeParts(t, [
    yCyl(t, 0.095, 0.095, 1.32, 10, 0xebeff2, 0, 0.10, 0), // White rocket body
    shadePart(t, new t.ConeGeometry(0.095, 0.32, 10), 0xd42c20, { ty: 0.92 }), // Red seeker nosecone (+Y)
    zBox(t, 0.28, 0.18, 0.02, 0x383e42, 0, -0.42, 0), // Cruciform tail fins
    zBox(t, 0.02, 0.18, 0.28, 0x383e42, 0, -0.42, 0),
  ]);
  const matMissile = new t.MeshBasicMaterial({ vertexColors: true });
  const missiles = [];
  for (let i = 0; i < 4; i++) {
    const m = new t.Mesh(singleMissileGeom, matMissile);
    m.position.set(-0.28 + (i % 2) * 0.56, 0.12, 0.26 + Math.floor(i / 2) * 0.36);
    m.visible = true; // vfx-lint-allow: SAM cell initial visibility
    missiles.push(m);
    launcherPod.add(m);
  }

  gimbal.add(launcherPod);
  turntable.add(gimbal);
  riserGroup.add(piston, turntable);
  root.add(outriggers, riserGroup);

  return {
    root,
    riserGroup,
    turntable,
    gimbal,
    missiles,
    pallet,
    wcid: DEPLOYABLE_WCID.MissileTurret,
    palletSize: "full",
    update(state = {}) {
      let riseNorm = 0;
      if (Number.isFinite(state.deployElevation)) {
        riseNorm = Math.min(1.0, Math.max(0.0, state.deployElevation));
      } else if (Number.isFinite(state.riseTimeSec)) {
        riseNorm = Math.min(1.0, Math.max(0.0, state.riseTimeSec / 0.35));
      }
      riserGroup.position.z = 0.25 + riseNorm * 0.8;
      if (Number.isFinite(state.yawRad)) turntable.rotation.z = state.yawRad;
      if (Number.isFinite(state.pitchRad)) gimbal.rotation.x = state.pitchRad;
      if (Number.isFinite(state.rollRad)) gimbal.rotation.y = state.rollRad;
      const ammo = state.ammoCount !== undefined ? state.ammoCount : state.ammoRemaining;
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
// ---------------------------------------------------------------------------
export function buildGroundRadar(three, options = {}) {
  const t = three || THREE_DEFAULT;
  const root = new t.Group();
  root.name = "ground-radar-root";
  const pallet = buildPallet(t, "half");
  root.add(pallet.root);

  const baseGeom = mergeParts(t, [
    zBox(t, 0.98, 1.84, 0.82, 0x455241, 0, 0, 0.56),
    zBox(t, 0.84, 0.44, 0.26, 0x353f32, 0, -0.58, 1.06), // Angled console hood
    zCyl(t, 0.09, 0.13, 1.24, 10, 0x7c848a, 0, 0.18, 1.56), // Upright +Z mast!
    zCyl(t, 0.18, 0.18, 0.14, 12, 0x555c60, 0, 0.18, 2.16), // Rotary slip-ring collar
  ]);
  const baseMesh = new t.Mesh(baseGeom, new t.MeshBasicMaterial({ vertexColors: true }));
  baseMesh.name = "ground-radar-pedestal";

  // Glowing amber tactical scope screen
  const matScope = new t.MeshBasicMaterial({
    color: 0xffb833,
    transparent: true,
    opacity: 0.88,
    blending: t.AdditiveBlending,
    depthWrite: false,
  });
  const scopeMesh = new t.Mesh(new t.BoxGeometry(0.46, 0.04, 0.18), matScope);
  scopeMesh.position.set(0, -0.81, 1.06);

  const antennaGroup = new t.Group();
  antennaGroup.name = "slotted-array-antenna";
  antennaGroup.position.set(0, 0.18, 2.28);

  const antGeom = mergeParts(t, [
    zBox(t, 1.86, 0.18, 0.38, 0xd9822b, 0, 0, 0.06), // High-vis amber/orange slotted waveguide bar
    zBox(t, 1.78, 0.21, 0.10, 0x2b3036, 0, 0, 0.06), // Dark waveguide slot strip
    zBox(t, 0.26, 0.34, 0.22, 0x5e666c, 0, -0.10, -0.04), // Counterweight transceiver
    shadePart(t, new t.ConeGeometry(0.09, 0.26, 6), 0x8d959c, { ty: 0.22, tz: 0.06 }), // Forward feedhorn
  ]);
  const antMesh = new t.Mesh(antGeom, new t.MeshBasicMaterial({ vertexColors: true }));
  antennaGroup.add(antMesh);

  root.add(baseMesh, scopeMesh, antennaGroup);

  return {
    root,
    antennaGroup,
    pallet,
    wcid: DEPLOYABLE_WCID.GroundRadar,
    palletSize: "half",
    update(state = {}) {
      const time = Number.isFinite(state.simTimeSec) ? state.simTimeSec : 0;
      antennaGroup.rotation.z = (time * (30.0 * 2 * Math.PI / 60.0)) % (2 * Math.PI);
    },
    dispose() {
      pallet.dispose();
      baseGeom.dispose();
      baseMesh.material.dispose();
      scopeMesh.geometry.dispose();
      matScope.dispose();
      antGeom.dispose();
      antMesh.material.dispose();
    },
  };
}

// ---------------------------------------------------------------------------
// 7) Mortar Turret (WCID 4000016, Half Pallet)
//    - Juts up & rotates; compressed-air accumulator tanks + heavy lob barrel
// ---------------------------------------------------------------------------
export function buildMortarTurret(three, options = {}) {
  const t = three || THREE_DEFAULT;
  const root = new t.Group();
  root.name = "mortar-turret-root";
  const pallet = buildPallet(t, "half");
  root.add(pallet.root);

  // Heavy base plate & twin upright compressed-air pressure tanks at rear
  const baseGeom = mergeParts(t, [
    zBox(t, 1.08, 2.20, 0.16, 0x363d35, 0, 0, 0.23),
    zCyl(t, 0.50, 0.54, 0.18, 16, 0x454d43, 0, 0.22, 0.38), // Base recoil ring (+Z upright!)
    // Twin high-pressure compressed-air tanks
    zCyl(t, 0.19, 0.19, 0.98, 12, 0x3d6b5e, -0.30, -0.72, 0.78),
    zCyl(t, 0.19, 0.19, 0.98, 12, 0x3d6b5e, 0.30, -0.72, 0.78),
    zBox(t, 0.72, 0.14, 0.12, 0xb8862d, 0, -0.72, 1.30), // Brass high-pressure air manifold
  ]);
  const recoilRing = new t.Mesh(baseGeom, new t.MeshBasicMaterial({ vertexColors: true }));

  const carriage = new t.Group();
  carriage.name = "mortar-carriage";
  carriage.position.set(0, 0.22, 0.46);

  const cheekGeom = mergeParts(t, [
    zCyl(t, 0.42, 0.44, 0.14, 14, 0x4e574c, 0, 0, 0.06),
    zBox(t, 0.12, 0.52, 0.56, 0x556052, -0.28, 0, 0.34),
    zBox(t, 0.12, 0.52, 0.56, 0x556052, 0.28, 0, 0.34),
    zCyl(t, 0.12, 0.12, 0.36, 10, 0xc4ccd2, 0, -0.18, 0.28), // Pneumatic pop-up cylinder
  ]);
  const cheekMesh = new t.Mesh(cheekGeom, new t.MeshBasicMaterial({ vertexColors: true }));

  const cradle = new t.Group();
  cradle.name = "mortar-cradle";
  cradle.position.set(0, 0, 0.48);
  cradle.rotation.x = -0.52; // Default 60-deg high-angle mortar lob stance when idle!

  // Upright +Z heavy smoothbore pneumatic mortar tube + green-band collar + breech chamber
  const barrelGeom = mergeParts(t, [
    zCyl(t, 0.15, 0.19, 1.38, 14, 0x272b28, 0, 0, 0.0),
    zCyl(t, 0.18, 0.18, 0.14, 14, 0x2ec85a, 0, 0, 0.54), // Green chemical/smoke mortar band!
    zCyl(t, 0.22, 0.22, 0.28, 14, 0x4b534e, 0, 0, -0.58), // Compressed-air breech plenum
  ]);
  const barrel = new t.Mesh(barrelGeom, new t.MeshBasicMaterial({ vertexColors: true }));
  barrel.position.set(0, 0, 0.65);

  cradle.add(barrel);
  carriage.add(cheekMesh, cradle);
  root.add(recoilRing, carriage);

  return {
    root,
    carriage,
    cradle,
    barrel,
    pallet,
    wcid: DEPLOYABLE_WCID.MortarTurret,
    palletSize: "half",
    update(state = {}) {
      if (Number.isFinite(state.deployElevation)) {
        carriage.position.z = 0.46 + Math.min(1, Math.max(0, state.deployElevation)) * 0.32;
      }
      if (Number.isFinite(state.yawRad)) carriage.rotation.z = state.yawRad;
      if (Number.isFinite(state.pitchRad)) cradle.rotation.x = state.pitchRad;
      const safeRecoil = Number.isFinite(state.recoilSec) ? state.recoilSec : 0;
      const recoilKick = Math.max(0, safeRecoil * 0.15);
      barrel.position.z = 0.65 - recoilKick;
    },
    dispose() {
      pallet.dispose();
      baseGeom.dispose();
      recoilRing.material.dispose();
      cheekGeom.dispose();
      cheekMesh.material.dispose();
      barrelGeom.dispose();
      barrel.material.dispose();
    },
  };
}

// ---------------------------------------------------------------------------
// 8) Heavy Laser Turret (WCID 4000017, Half Pallet)
//    - Air + Ground radar cued; twin heavy laser barrels & crimson capacitor core
// ---------------------------------------------------------------------------
export function buildHeavyLaserTurret(three, options = {}) {
  const t = three || THREE_DEFAULT;
  const root = new t.Group();
  root.name = "heavy-laser-turret-root";
  const pallet = buildPallet(t, "half");
  root.add(pallet.root);

  // Upright +Z armored pedestal with copper thermal radiator fins
  const pedParts = [
    zBox(t, 1.06, 2.08, 0.22, 0x282c2e, 0, 0, 0.26),
    zCyl(t, 0.34, 0.44, 0.68, 12, 0x383e42, 0, 0, 0.68),
  ];
  for (let i = -2; i <= 2; i++) {
    pedParts.push(zBox(t, 0.88, 0.05, 0.42, 0xa84828, 0, -0.68 + i * 0.14, 0.56));
  }
  const pedestal = new t.Mesh(mergeParts(t, pedParts), new t.MeshBasicMaterial({ vertexColors: true }));

  const turretHead = new t.Group();
  turretHead.name = "laser-head-yaw";
  turretHead.position.set(0, 0, 1.08);

  const yokeGeom = mergeParts(t, [
    zCyl(t, 0.36, 0.36, 0.16, 12, 0x4c545a, 0, 0, 0.0),
    zBox(t, 0.14, 0.54, 0.52, 0x454c52, -0.36, 0, 0.28),
    zBox(t, 0.14, 0.54, 0.52, 0x454c52, 0.36, 0, 0.28),
  ]);
  const yokeMesh = new t.Mesh(yokeGeom, new t.MeshBasicMaterial({ vertexColors: true }));

  const barrelGimbal = new t.Group();
  barrelGimbal.name = "laser-barrels-pitch";
  barrelGimbal.position.set(0, 0, 0.34);

  // Faceted twin gunmetal laser emitter barrels pointing forward along +Y
  const barrelGeom = mergeParts(t, [
    zBox(t, 0.58, 0.86, 0.44, 0x32373c, 0, -0.08, 0),
    yCyl(t, 0.095, 0.115, 1.54, 10, 0x202428, -0.18, 0.68, 0.04),
    yCyl(t, 0.095, 0.115, 1.54, 10, 0x202428, 0.18, 0.68, 0.04),
    // Focusing shroud rings
    yCyl(t, 0.125, 0.125, 0.12, 10, 0x6c757d, -0.18, 1.36, 0.04),
    yCyl(t, 0.125, 0.125, 0.12, 10, 0x6c757d, 0.18, 1.36, 0.04),
    // Top dual-mode Air/Ground optical director pod
    zBox(t, 0.28, 0.42, 0.18, 0x4f5860, 0, 0.08, 0.30),
  ]);
  const barrelMesh = new t.Mesh(barrelGeom, new t.MeshBasicMaterial({ vertexColors: true }));

  // Glowing crimson capacitor rails & twin ruby focusing lenses
  const glowGeom = mergeParts(t, [
    yCyl(t, 0.075, 0.075, 0.06, 10, 0xff2233, -0.18, 1.44, 0.04),
    yCyl(t, 0.075, 0.075, 0.06, 10, 0xff2233, 0.18, 1.44, 0.04),
    zBox(t, 0.62, 0.56, 0.10, 0xff1828, 0, -0.10, 0.04),
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

  return {
    root,
    turretHead,
    barrelGimbal,
    pallet,
    wcid: DEPLOYABLE_WCID.HeavyLaserTurret,
    palletSize: "half",
    update(state = {}) {
      if (Number.isFinite(state.yawRad)) turretHead.rotation.z = state.yawRad;
      if (Number.isFinite(state.pitchRad)) barrelGimbal.rotation.x = state.pitchRad;
    },
    dispose() {
      pallet.dispose();
      pedestal.geometry.dispose();
      pedestal.material.dispose();
      yokeGeom.dispose();
      yokeMesh.material.dispose();
      barrelGeom.dispose();
      barrelMesh.material.dispose();
      glowGeom.dispose();
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
