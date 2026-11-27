// scene3d/vehicle/port_quay_model.js — Engineered Marine Container Terminal Quay,
// Caisson Seawall, Smooth 4.76 deg Approach Ramp, Yard Concrete Apron, Painted Markings,
// Quay STS & Yard RMG Rails, 17x T-Head Bollards, 25x Marine Cone Fenders,
// 3-Tier Galvanized Reefer Rack Gantries, Gatehouse / Port Ops Control Tower & High-Mast Floodlights.
//
// Strict GPU budgets:
//   - <= 16 draw calls total (target: 11 DC)
//   - 0 dynamic THREE.Light instances (emissive lamps only, lightCountDelta === 0)
//   - AGX HDR PBR MeshStandardMaterial + 3-cascade CSM shader patching
//   - AC Z-up coordinates (+X East, +Y North/Seaward, +Z Up), anchored at PORT_ORIGIN [44960, 47880, 0].

import * as THREE_DEFAULT from "three";
import { installCsmShaderPatch } from "../materials.js";
import {
  GeomAcc,
  makeLinearPalette,
  cShade,
  makeDeployablePbrMaterial,
  makeLampsMaterial,
} from "./deployable_models.js";
import {
  PORT_ORIGIN,
  PORT_SITE,
  PORT_WCID,
  QUAY_SPECS,
  STS_CRANE_SPECS,
  YARD_BLOCK_SPECS,
  YARD_CRANE_SPECS,
  BERTH_SPECS,
  buildPortLayout,
} from "./port_specs.js";

export const manifest = Object.freeze({
  id: "vfx-port-quay-model",
  channel: "vehicleModel",
  deterministic: true,
  lightCountDelta: 0,
  cacheKeyScope: "set",
  reads: Object.freeze(["geometry", "serverPose", "clock"]),
  writes: Object.freeze(["renderTransform", "partTransform", "materialUniform"]),
});

function addOutlineBox(acc, cx, cy, zBot, zTop, w, d, lineW, col) {
  const cz = 0.5 * (zBot + zTop);
  const hz = 0.5 * (zTop - zBot);
  const hw = w * 0.5;
  const hd = d * 0.5;
  const lw = lineW * 0.5;
  acc.box(cx, cy + hd - lw, cz, hw, lw, hz, col, col);
  acc.box(cx, cy - hd + lw, cz, hw, lw, hz, col, col);
  acc.box(cx - hw + lw, cy, cz, lw, Math.max(0.05, hd - lineW), hz, col, col);
  acc.box(cx + hw - lw, cy, cz, lw, Math.max(0.05, hd - lineW), hz, col, col);
}

function disposeObjectTree(root, extras = []) {
  const disposedG = new Set();
  const disposedM = new Set();
  const visit = (o) => {
    if (!o) return;
    if (o.geometry && !disposedG.has(o.geometry)) {
      disposedG.add(o.geometry);
      o.geometry.dispose();
    }
    if (o.material) {
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        if (m && !disposedM.has(m)) {
          disposedM.add(m);
          m.dispose();
        }
      }
    }
    if (o.isInstancedMesh && typeof o.dispose === "function") {
      o.dispose();
    }
  };
  if (root) root.traverse(visit);
  for (const ex of extras) visit(ex);
}

function buildBollardGeom(t, pal) {
  const acc = new GeomAcc(3);
  // Bolted octagonal baseplate (z in [0, 0.08])
  acc.bevelBox(0, 0, 0.04, 0.38, 0.34, 0.04, 0.08, pal.steelDark, cShade(pal.steelDark, 0.78));
  for (const sx of [-0.28, 0.28]) {
    for (const sy of [-0.24, 0.24]) {
      acc.cylinder(sx, sy, 0.095, 0.025, 0.03, 6, pal.galv, "z");
    }
  }
  // Flared cast-iron neck & barrel (z in [0.08, 0.62])
  acc.cone(0, 0, 0.35, 0.24, 0.19, 0.54, 12, pal.yellow, "z", true, true, cShade(pal.yellow, 0.80));
  // Heavy overhanging T-head mooring horn (z in [0.62, 0.84])
  acc.bevelBox(0, 0, 0.73, 0.42, 0.24, 0.11, 0.06, pal.yellow, cShade(pal.yellow, 0.84));
  // Horn retention ears along +/-X
  acc.cone(-0.42, 0, 0.73, 0.13, 0.17, 0.14, 10, pal.yellow, "x", true, true, cShade(pal.yellow, 0.82));
  acc.cone(+0.42, 0, 0.73, 0.17, 0.13, 0.14, 10, pal.yellow, "x", true, true, cShade(pal.yellow, 0.82));
  return acc.toBufferGeometry(t);
}

function buildFenderGeom(t, pal) {
  const acc = new GeomAcc(3);
  // Local origin at seawall face (y = 0, z = 1.0); protrudes seaward to y = +1.20 m
  // Steel mounting backing flange bolted to caisson wall (y in [0.0, 0.08])
  acc.box(0, 0.04, 0.0, 0.86, 0.04, 0.86, pal.steelDark, cShade(pal.steelDark, 0.78));
  // Heavy conical EPDM rubber compression body (y in [0.08, 0.92])
  acc.cone(0, 0.50, 0.0, 0.72, 0.44, 0.84, 14, pal.rubber, "y", true, true, cShade(pal.rubber, 0.75));
  // Frontal steel frame & UHMW-PE low-friction contact shield (y in [0.92, 1.20], face at y = +1.20 m)
  acc.bevelBox(0, 1.04, 0.0, 0.95, 0.12, 0.92, 0.08, pal.steelDark, cShade(pal.steelDark, 0.78));
  // Contact pad face (flush at y = +1.20 m)
  acc.box(0, 1.175, 0.0, 0.88, 0.025, 0.86, pal.rubberLight, pal.rubber);
  // High-visibility safety-yellow chamfer trim bars on top & bottom edges
  acc.box(0, 1.06, +0.88, 0.92, 0.08, 0.05, pal.yellow, cShade(pal.yellow, 0.84));
  acc.box(0, 1.06, -0.88, 0.92, 0.08, 0.05, pal.yellow, cShade(pal.yellow, 0.84));
  return acc.toBufferGeometry(t);
}

function buildFloodlightTowerGeom(t, pal) {
  const acc = new GeomAcc(3);
  const H = QUAY_SPECS.lightTowerHeightM; // 28.0 m
  // Concrete plinth pedestal
  acc.bevelBox(0, 0, 0.45, 0.85, 0.85, 0.45, 0.12, pal.concreteDark, cShade(pal.concreteDark, 0.82));
  // Tapered galvanized steel mast (z in [0.90, 27.60])
  acc.cone(0, 0, 14.25, 0.48, 0.22, H - 1.30, 8, pal.galv, "z", true, true, pal.galvDark);
  // Maintenance ladder cage spine along -Y face
  acc.box(0, -0.44, H * 0.5, 0.18, 0.04, H * 0.45, pal.steelDark, cShade(pal.steelDark, 0.8));
  // Top luminaire crown & maintenance catwalk ring (z = 26.8..28.0)
  acc.bevelBox(0, 0, H - 1.05, 1.45, 1.45, 0.10, 0.35, pal.galv, pal.galvDark);
  // 4-sided handrail around top crown
  addOutlineBox(acc, 0, 0, H - 0.15, H - 0.05, 2.80, 2.80, 0.06, pal.yellow);
  // Luminaire head frame bank angled downward toward yard & quay
  acc.box(0, +0.95, H - 0.35, 1.35, 0.35, 0.42, pal.steelDark, cShade(pal.steelDark, 0.8));
  acc.box(0, -0.95, H - 0.35, 1.35, 0.35, 0.42, pal.steelDark, cShade(pal.steelDark, 0.8));
  // Aviation obstruction mast finial
  acc.cylinder(0, 0, H + 0.55, 0.05, 1.10, 6, pal.red, "z");
  return acc.toBufferGeometry(t);
}

/**
 * Build the complete Marine Container Terminal civil & static infrastructure:
 * quay apron + caisson seawall + 4.76 deg ramp + yard concrete apron + painted markings +
 * STS/RMG crane rails + 17 T-head bollards + 25 marine cone fenders +
 * 3-tier galvanized Reefer Rack gantries + Port Ops Control Tower & Check-In Gatehouse +
 * 8 high-mast floodlight towers (emissive lamps only, 0 dynamic lights).
 */
export function buildPortQuay(three, layoutIn = null, options = {}) {
  const t = three || THREE_DEFAULT;
  const opts = options && typeof options === "object" ? options : {};
  const csmState = opts.csmState;
  const originIn = opts.origin || layoutIn?.origin || PORT_ORIGIN;
  const layout = layoutIn && typeof layoutIn === "object" && Array.isArray(layoutIn.bollards)
    ? layoutIn
    : buildPortLayout(originIn);

  const ox = Number.isFinite(layout.origin?.[0]) ? layout.origin[0] : PORT_ORIGIN[0];
  const oy = Number.isFinite(layout.origin?.[1]) ? layout.origin[1] : PORT_ORIGIN[1];
  const oz = Number.isFinite(layout.origin?.[2]) ? layout.origin[2] : PORT_ORIGIN[2];

  const minX = PORT_SITE.localMinX; // -180.0
  const maxX = PORT_SITE.localMaxX; // +220.0
  const centerX = 0.5 * (minX + maxX); // +20.0
  const halfW = 0.5 * (maxX - minX); // 200.0 (400 m E-W)
  const deckZ = QUAY_SPECS.deckZ; // +2.00 m
  const wallBotZ = QUAY_SPECS.seawallBottomZ; // -2.50 m
  const yardZ = PORT_SITE.yardVisualZ; // +0.004 m
  const apronMinY = -QUAY_SPECS.apronDepthM; // -46.0
  const rampMinY = apronMinY - QUAY_SPECS.rampLengthM; // -70.0
  const yardMinY = -210.0; // world Y = 47670.0 (flush with warehouse North edge)

  const pal = makeLinearPalette(t, {
    concreteQuay: 0x868b90,
    concreteQuayAlt: 0x7e8388,
    concreteDark: 0x5c6268,
    concreteSeawall: 0x676d73,
    tideMark: 0x2b3532,
    concreteYard: 0x7b8086,
    concreteJoint: 0x62676d,
    asphaltRoad: 0x4b5056,
    runwayConcrete: 0x8f9499,
    yellow: 0xe8ad18,
    white: 0xe2e6eb,
    amber: 0xde7a14,
    red: 0xc92c24,
    blueOps: 0x1a4876,
    opsWall: 0xd4d9de,
    opsTrim: 0x2f363e,
    railSteel: 0x4d545d,
    railCrown: 0x9aa2ab,
    steelDark: 0x262b31,
    galv: 0x969fa8,
    galvDark: 0x6d7680,
    rubber: 0x1a1d20,
    rubberLight: 0x2a2e33,
    cabinetBlue: 0x225a8c,
    lampWarm: 0xfff2cc,
    lampAmber: 0xffa818,
    lampRed: 0xff2820,
    lampGreen: 0x22e868,
    lampCyan: 0x66dcff,
  });

  const root = new t.Group();
  root.name = "port-quay-root";
  root.position.set(ox, oy, oz);
  root.userData = { portQuay: true, origin: [ox, oy, oz], maxDrawCalls: QUAY_SPECS.maxDrawCalls };

  // =========================================================================
  // DC 1: Engineered Concrete Quay Apron (400 x 46 m, z = +2.00 m),
  //       Caisson Seawall down to z = -2.50 m, Smooth 4.76 deg Approach Ramp
  // =========================================================================
  const quayAcc = new GeomAcc(3);

  // Solid caisson deck & seawall block: localX [-180..+220], localY [-46..0], z [-2.50..+2.00]
  // Subdivided along X in 25 m caisson bays for crisp architectural joint seams & shadow fidelity
  const caissonSegs = 16; // 16 x 25 m = 400 m
  const caissonStep = (maxX - minX) / caissonSegs;
  const fullH = deckZ - wallBotZ; // 4.50 m
  const fullCz = 0.5 * (deckZ + wallBotZ); // -0.25 m
  for (let i = 0; i < caissonSegs; i++) {
    const cx = minX + (i + 0.5) * caissonStep;
    const colTop = i % 2 === 0 ? pal.concreteQuay : pal.concreteQuayAlt;
    quayAcc.box(cx, 0.5 * apronMinY, fullCz, caissonStep * 0.5 - 0.03, QUAY_SPECS.apronDepthM * 0.5, fullH * 0.5, colTop, pal.concreteSeawall);
    // Caisson seawall vertical pilaster buttresses along seaward face (y = 0.0), strictly inside [minX, maxX]
    if (i > 0) {
      quayAcc.box(minX + i * caissonStep, -0.05, fullCz, 0.40, 0.14, fullH * 0.5 - 0.05, pal.concreteDark, pal.tideMark);
    }
  }
  quayAcc.box(minX + 0.40, -0.05, fullCz, 0.40, 0.14, fullH * 0.5 - 0.05, pal.concreteDark, pal.tideMark);
  quayAcc.box(maxX - 0.40, -0.05, fullCz, 0.40, 0.14, fullH * 0.5 - 0.05, pal.concreteDark, pal.tideMark);

  // Heavy concrete quay coping beam along North edge (y in [-0.85, 0.04], z in [1.65, 2.02])
  quayAcc.box(centerX, -0.40, 1.835, halfW, 0.44, 0.185, pal.concreteDark, pal.concreteSeawall);
  // Waterline dark bio-fouling tide mark strip along seaward seawall face (z in [-0.40, +0.42])
  quayAcc.box(centerX, 0.02, 0.01, halfW, 0.03, 0.41, pal.tideMark, cShade(pal.tideMark, 0.72));
  // Recessed stainless seawall safety rescue ladders (every 48 m between fenders)
  for (let lx = -160.0; lx <= 200.0; lx += 48.0) {
    quayAcc.box(lx - 0.22, 0.04, 0.90, 0.025, 0.04, 1.05, pal.galv, pal.galvDark);
    quayAcc.box(lx + 0.22, 0.04, 0.90, 0.025, 0.04, 1.05, pal.galv, pal.galvDark);
    for (let rz = 0.05; rz <= 1.80; rz += 0.35) {
      quayAcc.box(lx, 0.05, rz, 0.22, 0.02, 0.02, pal.yellow, cShade(pal.yellow, 0.82));
    }
  }

  // Smooth 4.76 deg Approach Ramp Wedge: localY in [-70.0, -46.0], z linearly 0.004 -> +2.000 m
  const zRampFoot = yardZ; // +0.004 m
  const zRampTop = deckZ;  // +2.000 m
  const zRampUnder = -0.35;
  // Top sloped concrete deck (divided into 8 E-W segments for subtle joint rhythm)
  const rampSegs = 8;
  const rampStepX = (maxX - minX) / rampSegs;
  for (let i = 0; i < rampSegs; i++) {
    const x0 = minX + i * rampStepX;
    const x1 = x0 + rampStepX;
    const cTop = i % 2 === 0 ? pal.concreteQuay : pal.concreteQuayAlt;
    const cBot = cShade(cTop, 0.90);
    // Outward normal points UP (+Z) & slightly South (-Y): quad CCW looking from +Z
    quayAcc.quad(
      [x0, rampMinY, zRampFoot],
      [x1, rampMinY, zRampFoot],
      [x1, apronMinY, zRampTop],
      [x0, apronMinY, zRampTop],
      cBot, cBot, cTop, cTop
    );
  }
  // West (-180) and East (+220) solid triangular cheek walls closing the ramp ends down to zRampUnder
  quayAcc.quad(
    [minX, apronMinY, zRampTop],
    [minX, apronMinY, zRampUnder],
    [minX, rampMinY, zRampUnder],
    [minX, rampMinY, zRampFoot],
    pal.concreteDark, pal.concreteSeawall, pal.concreteSeawall, pal.concreteDark
  );
  quayAcc.quad(
    [maxX, rampMinY, zRampFoot],
    [maxX, rampMinY, zRampUnder],
    [maxX, apronMinY, zRampUnder],
    [maxX, apronMinY, zRampTop],
    pal.concreteDark, pal.concreteSeawall, pal.concreteSeawall, pal.concreteDark
  );
  // Concrete safety side curbs along East & West outer edges of quay + ramp
  for (const sx of [minX + 0.35, maxX - 0.35]) {
    quayAcc.box(sx, 0.5 * apronMinY, deckZ + 0.14, 0.35, QUAY_SPECS.apronDepthM * 0.5, 0.14, pal.concreteDark, pal.concreteSeawall);
  }

  const quayMat = makeDeployablePbrMaterial(t, { roughness: 0.86, metalness: 0.05, csmState });
  const quayMesh = new t.Mesh(quayAcc.toBufferGeometry(t), quayMat);
  quayMesh.name = "port-quay-concrete-mesh";
  quayMesh.castShadow = true;
  quayMesh.receiveShadow = true;
  root.add(quayMesh);

  // =========================================================================
  // DC 2: Yard Concrete Apron (localX [-180..+220], localY [-210..-70], z = +0.004 m)
  //       Flush with immutable Warehouse North slab edge at Y = 47670 (localY = -210)
  // =========================================================================
  const yardAcc = new GeomAcc(3);
  const nxYard = 20; // 20 x 20 m tiles = 400 m
  const nyYard = 7;  // 7 x 20 m tiles = 140 m
  const stepX = (maxX - minX) / nxYard;
  const stepY = (rampMinY - yardMinY) / nyYard;
  for (let ix = 0; ix < nxYard; ix++) {
    for (let iy = 0; iy < nyYard; iy++) {
      const cx = minX + (ix + 0.5) * stepX;
      const cy = yardMinY + (iy + 0.5) * stepY;
      // Distinct road-corridor asphalt-concrete tint vs container-stack concrete pad tint
      const isRoadBand = cy < -184.0 || (cy > -138.0 && cy < -118.0) || cy > -82.0;
      const baseCol = isRoadBand ? pal.asphaltRoad : pal.concreteYard;
      const sf = (ix + iy) % 2 === 0 ? 1.0 : 0.96;
      yardAcc.box(
        cx, cy, yardZ * 0.5,
        stepX * 0.5 - 0.02, stepY * 0.5 - 0.02, yardZ * 0.5,
        cShade(baseCol, sf), cShade(pal.concreteJoint, sf)
      );
    }
  }
  // Reinforced RTG concrete wheel runway strips along South Yard Block B1/B2/REEFER
  for (const rwyY of [YARD_BLOCK_SPECS.B1.southRailLocalY, YARD_BLOCK_SPECS.B1.northRailLocalY]) {
    yardAcc.box(centerX - 10.0, rwyY, yardZ * 0.5 + 0.0005, 165.0, 1.35, yardZ * 0.5, pal.runwayConcrete, pal.concreteJoint);
  }
  // Perimeter border curb
  addOutlineBox(yardAcc, centerX, 0.5 * (yardMinY + rampMinY), 0.0, yardZ, maxX - minX, rampMinY - yardMinY, 0.40, pal.concreteDark);

  const yardMat = makeDeployablePbrMaterial(t, { roughness: 0.88, metalness: 0.04, csmState });
  yardMat.polygonOffset = true;
  yardMat.polygonOffsetFactor = -1;
  yardMat.polygonOffsetUnits = -1;
  const yardApronMesh = new t.Mesh(yardAcc.toBufferGeometry(t), yardMat);
  yardApronMesh.name = "port-yard-apron-mesh";
  yardApronMesh.castShadow = false;
  yardApronMesh.receiveShadow = true;
  root.add(yardApronMesh);

  // =========================================================================
  // DC 3: High-Visibility Painted Berth, Lane, Bay, Ramp & Safety Markings
  // =========================================================================
  const markAcc = new GeomAcc(3);
  const zQuayMark = deckZ + 0.004;
  const zYardMark = yardZ + 0.003;
  const hzMark = 0.0015;

  // 3a. Quay coping safety edge stripe & Berth 1 / Berth 2 limit markers
  markAcc.box(centerX, -0.55, zQuayMark, halfW - 1.0, 0.16, hzMark, pal.yellow, pal.yellow);
  for (const bid of ["B1", "B2"]) {
    const b = BERTH_SPECS[bid];
    // Berth boundary transverse ticks & center alignment arrow at coping
    markAcc.box(b.localXMin, -1.8, zQuayMark, 0.20, 1.40, hzMark, pal.white, pal.white);
    markAcc.box(b.localXMax, -1.8, zQuayMark, 0.20, 1.40, hzMark, pal.white, pal.white);
    markAcc.box(b.localX, -2.0, zQuayMark, 1.80, 0.25, hzMark, pal.amber, pal.amber);
    markAcc.box(b.localX, -1.3, zQuayMark, 0.30, 0.90, hzMark, pal.amber, pal.amber);
    // Backreach hatch-cover buffer pad outline
    addOutlineBox(markAcc, b.localX, QUAY_SPECS.hatchBufferLocalY, deckZ + 0.002, deckZ + 0.006, 46.0, 13.0, 0.18, pal.yellow);
  }

  // 3b. 4 under-portal truck transfer lanes (localY = -9, -13, -17, -21)
  for (const laneY of QUAY_SPECS.portalLaneLocalYs) {
    for (let lx = -168.0; lx <= 208.0; lx += 8.0) {
      markAcc.box(lx, laneY, zQuayMark, 2.2, 0.08, hzMark, pal.white, pal.white);
    }
  }
  markAcc.box(centerX, -7.0, zQuayMark, 192.0, 0.10, hzMark, pal.yellow, pal.yellow);
  markAcc.box(centerX, -23.0, zQuayMark, 192.0, 0.10, hzMark, pal.yellow, pal.yellow);

  // 3c. Ramp slope warning chevrons along the 3 shuttle ramp connectors (lx = -174, 0, +174)
  for (const rlx of [-174.0, 0.0, +174.0]) {
    for (let s = 0; s < 5; s++) {
      const f = (s + 0.5) / 5.0;
      const ry0 = rampMinY + f * QUAY_SPECS.rampLengthM - 0.55;
      const ry1 = ry0 + 1.10;
      const rz0 = zRampFoot + ((ry0 - rampMinY) / QUAY_SPECS.rampLengthM) * (zRampTop - zRampFoot) + 0.008;
      const rz1 = zRampFoot + ((ry1 - rampMinY) / QUAY_SPECS.rampLengthM) * (zRampTop - zRampFoot) + 0.008;
      markAcc.quad(
        [rlx - 1.6, ry0, rz0],
        [rlx + 1.6, ry0, rz0],
        [rlx + 1.6, ry1, rz1],
        [rlx - 1.6, ry1, rz1],
        pal.yellow, pal.yellow, pal.yellow, pal.yellow
      );
    }
  }

  // 3d. Container Yard Block perimeter boxes & row guide ticks (A1, A2, B1, B2, REEFER)
  for (const blk of Object.values(YARD_BLOCK_SPECS)) {
    const bw = blk.localMaxX - blk.localMinX;
    const bcx = 0.5 * (blk.localMinX + blk.localMaxX);
    const bd = (blk.rowCount - 1) * YARD_CRANE_SPECS.rowPitchM + 2.80;
    const bcy = blk.row0LocalY + 0.5 * (blk.rowCount - 1) * YARD_CRANE_SPECS.rowPitchM;
    const col = blk.reefer ? pal.amber : pal.yellow;
    addOutlineBox(markAcc, bcx, bcy, yardZ + 0.001, yardZ + 0.005, bw + 0.6, bd + 0.4, 0.16, col);
    // Bay boundary tick dashes along north & south edges of block
    for (let k = 1; k < blk.evenBayCount; k++) {
      const bx = blk.localMinX + k * YARD_CRANE_SPECS.bayPitch40M;
      markAcc.box(bx, bcy + bd * 0.5 - 0.5, zYardMark, 0.08, 0.5, hzMark, pal.white, pal.white);
      markAcc.box(bx, bcy - bd * 0.5 + 0.5, zYardMark, 0.08, 0.5, hzMark, pal.white, pal.white);
    }
  }

  // 3e. Yard shuttle lanes: North TTL (-88.5), Cross-Aisle (-127.0), South TTL (-146.5), Corridor (-196.0)
  for (const [laneY, col] of [[-88.5, pal.white], [-127.0, pal.yellow], [-146.5, pal.white], [-196.0, pal.yellow]]) {
    for (let lx = -170.0; lx <= 170.0; lx += 8.0) {
      markAcc.box(lx, laneY, zYardMark, 2.2, 0.09, hzMark, col, col);
    }
  }
  // Warehouse Zone A Drop Pad handoff lane spurs pointing South across Y = 47670 seam (lx = -40, -24, -8)
  for (const spurX of [-40.0, -24.0, -8.0]) {
    markAcc.box(spurX, -203.0, zYardMark, 0.14, 6.8, hzMark, pal.yellow, pal.yellow);
    markAcc.box(spurX - 1.5, -209.5, zYardMark, 0.10, 0.6, hzMark, pal.white, pal.white);
    markAcc.box(spurX + 1.5, -209.5, zYardMark, 0.10, 0.6, hzMark, pal.white, pal.white);
  }
  // West Semi-379 / Sidelifter Chassis Staging stalls (localX in [-170, -72], localY in [-206, -184])
  for (let sx = -164.0; sx <= -84.0; sx += 16.0) {
    addOutlineBox(markAcc, sx, -196.0, yardZ + 0.001, yardZ + 0.005, 13.5, 4.2, 0.12, pal.white);
  }

  const markMat = makeDeployablePbrMaterial(t, { roughness: 0.72, metalness: 0.08, csmState });
  markMat.polygonOffset = true;
  markMat.polygonOffsetFactor = -2;
  markMat.polygonOffsetUnits = -2;
  const markingsMesh = new t.Mesh(markAcc.toBufferGeometry(t), markMat);
  markingsMesh.name = "port-painted-markings-mesh";
  markingsMesh.castShadow = false;
  markingsMesh.receiveShadow = true;
  root.add(markingsMesh);

  // =========================================================================
  // DC 4: STS Quay Crane Rails (20 m gauge) & North Yard RMG Rails (30 m gauge)
  // =========================================================================
  const railAcc = new GeomAcc(3);
  const addRailRun = (x0, x1, y, baseZ) => {
    const cx = 0.5 * (x0 + x1);
    const hx = 0.5 * (x1 - x0);
    // Steel recessed rail channel soleplate
    railAcc.box(cx, y, baseZ + 0.010, hx, 0.24, 0.010, pal.steelDark, pal.steelDark);
    // Vignoles crane rail web + bright steel head crown
    railAcc.box(cx, y, baseZ + 0.045, hx, 0.045, 0.035, pal.railSteel, pal.steelDark);
    railAcc.box(cx, y, baseZ + 0.082, hx, 0.068, 0.016, pal.railCrown, pal.railSteel);
    // Hydraulic rail end-stop buffers at both ends
    for (const ex of [x0 + 0.45, x1 - 0.45]) {
      railAcc.box(ex, y, baseZ + 0.45, 0.45, 0.32, 0.45, pal.yellow, pal.steelDark);
      railAcc.box(ex, y, baseZ + 0.52, 0.48, 0.18, 0.14, pal.rubber, pal.rubber);
    }
  };
  // STS 20 m gauge rails at localY = -4.5 (waterside) & -24.5 (landside), z = +2.00 m
  addRailRun(STS_CRANE_SPECS.railMinLocalX - 4.0, STS_CRANE_SPECS.railMaxLocalX + 4.0, QUAY_SPECS.stsWatersideRailLocalY, deckZ);
  addRailRun(STS_CRANE_SPECS.railMinLocalX - 4.0, STS_CRANE_SPECS.railMaxLocalX + 4.0, QUAY_SPECS.stsLandsideRailLocalY, deckZ);
  // North Yard RMG 30 m gauge rails at localY = -114.0 & -84.0, z = +0.004 m
  addRailRun(YARD_BLOCK_SPECS.A1.localMinX - 4.0, YARD_BLOCK_SPECS.A2.localMaxX + 4.0, YARD_BLOCK_SPECS.A1.southRailLocalY, yardZ);
  addRailRun(YARD_BLOCK_SPECS.A1.localMinX - 4.0, YARD_BLOCK_SPECS.A2.localMaxX + 4.0, YARD_BLOCK_SPECS.A1.northRailLocalY, yardZ);

  const railMat = makeDeployablePbrMaterial(t, { roughness: 0.40, metalness: 0.72, csmState });
  const railsMesh = new t.Mesh(railAcc.toBufferGeometry(t), railMat);
  railsMesh.name = "port-crane-rails-mesh";
  railsMesh.castShadow = true;
  railsMesh.receiveShadow = true;
  root.add(railsMesh);

  // =========================================================================
  // DC 5: 17x T-Head Mooring Bollards (InstancedMesh)
  // =========================================================================
  const _m = new t.Matrix4();
  const _p = new t.Vector3();
  const _q = new t.Quaternion();
  const _s = new t.Vector3(1, 1, 1);

  const bollardGeom = buildBollardGeom(t, pal);
  const bollardMat = makeDeployablePbrMaterial(t, { roughness: 0.46, metalness: 0.52, csmState });
  const bollardDefs = layout.bollards;
  const bollardsInst = new t.InstancedMesh(bollardGeom, bollardMat, bollardDefs.length);
  bollardsInst.name = "port-bollards-instanced";
  bollardsInst.castShadow = true;
  bollardsInst.receiveShadow = true;
  bollardsInst.frustumCulled = false;
  for (let i = 0; i < bollardDefs.length; i++) {
    const lp = bollardDefs[i].localPos;
    _p.set(lp[0], lp[1], lp[2]);
    _m.compose(_p, _q, _s);
    bollardsInst.setMatrixAt(i, _m);
  }
  bollardsInst.instanceMatrix.needsUpdate = true;
  bollardsInst.computeBoundingBox();
  bollardsInst.computeBoundingSphere();
  root.add(bollardsInst);

  // =========================================================================
  // DC 6: 25x Marine Rubber Cone Fenders (InstancedMesh)
  // =========================================================================
  const fenderGeom = buildFenderGeom(t, pal);
  const fenderMat = makeDeployablePbrMaterial(t, { roughness: 0.76, metalness: 0.22, csmState });
  const fenderDefs = layout.fenders;
  const fendersInst = new t.InstancedMesh(fenderGeom, fenderMat, fenderDefs.length);
  fendersInst.name = "port-fenders-instanced";
  fendersInst.castShadow = true;
  fendersInst.receiveShadow = true;
  fendersInst.frustumCulled = false;
  for (let i = 0; i < fenderDefs.length; i++) {
    const lp = fenderDefs[i].localPos;
    _p.set(lp[0], lp[1], lp[2]);
    _m.compose(_p, _q, _s);
    fendersInst.setMatrixAt(i, _m);
  }
  fendersInst.instanceMatrix.needsUpdate = true;
  fendersInst.computeBoundingBox();
  fendersInst.computeBoundingSphere();
  root.add(fendersInst);

  // =========================================================================
  // DC 7: 3-Tier Galvanized Reefer Rack Gantries (Walkways, Ladders, 440V Cabinets)
  //       Positioned cleanly in the 0.808 m bay-end corridors of YARD_BLOCK_SPECS.REEFER
  //       (zero overlap with 40ft containers!) + East Reefer Substation Transformer Pad
  // =========================================================================
  const reeferAcc = new GeomAcc(3);
  const rBlk = YARD_BLOCK_SPECS.REEFER;
  const rMinY = rBlk.row0LocalY - 1.45;
  const rMaxY = rBlk.row0LocalY + (rBlk.rowCount - 1) * YARD_CRANE_SPECS.rowPitchM + 1.45;
  const rMidY = 0.5 * (rMinY + rMaxY);
  const rHalfY = 0.5 * (rMaxY - rMinY);
  const tierPlatformZs = [2.58, 5.18, 7.78]; // 3-tier access walkways matching container tiers 1..3
  const gantryH = 8.95;

  // 5 transverse galvanized rack towers at bay boundaries (+95.8, +109, +122, +135, +148.2)
  // Containers sit at [96.404..108.596], [109.404..121.596], [122.404..134.596], [135.404..147.596]
  const rackXs = [
    rBlk.localMinX - 0.20,
    rBlk.localMinX + 13.0,
    rBlk.localMinX + 26.0,
    rBlk.localMinX + 39.0,
    rBlk.localMaxX + 0.20,
  ];
  const lampAcc = new GeomAcc(3); // shared DC 11 emissive accumulator

  for (let gxIdx = 0; gxIdx < rackXs.length; gxIdx++) {
    const gx = rackXs[gxIdx];
    const halfWalkX = 0.34; // total 0.68 m wide, strictly inside 0.808 m bay gap
    // 4 vertical H-columns along Y
    for (let r = 0; r <= rBlk.rowCount; r++) {
      const cy = rBlk.row0LocalY - 1.42 + r * YARD_CRANE_SPECS.rowPitchM;
      reeferAcc.box(gx, cy, gantryH * 0.5, 0.08, 0.08, gantryH * 0.5, pal.galv, pal.galvDark);
      reeferAcc.box(gx, cy, 0.05, 0.16, 0.16, 0.05, pal.steelDark, pal.steelDark);
    }
    // 3 elevated steel grated catwalk decks + safety-yellow handrails + 440V plug cabinets
    for (const tz of tierPlatformZs) {
      // Catwalk deck grating
      reeferAcc.box(gx, rMidY, tz, halfWalkX, rHalfY, 0.045, pal.galv, pal.galvDark);
      // Handrails on both sides of top & intermediate walkways
      for (const sx of [-halfWalkX + 0.03, halfWalkX - 0.03]) {
        reeferAcc.box(gx + sx, rMidY, tz + 1.02, 0.025, rHalfY, 0.025, pal.yellow, cShade(pal.yellow, 0.82));
        reeferAcc.box(gx + sx, rMidY, tz + 0.55, 0.020, rHalfY, 0.020, pal.yellow, cShade(pal.yellow, 0.82));
      }
      // 440V Shore-Power Distribution Cabinets per row on each tier
      for (let r = 0; r < rBlk.rowCount; r++) {
        const ry = rBlk.row0LocalY + r * YARD_CRANE_SPECS.rowPitchM;
        reeferAcc.box(gx, ry, tz + 0.55, 0.18, 0.32, 0.30, pal.cabinetBlue, cShade(pal.cabinetBlue, 0.78));
        // Red 440V shore-power plug sockets
        reeferAcc.box(gx, ry - 0.12, tz + 0.45, 0.20, 0.06, 0.06, pal.red, pal.red);
        reeferAcc.box(gx, ry + 0.12, tz + 0.45, 0.20, 0.06, 0.06, pal.red, pal.red);
        // Green live shore-power status LED on cabinet face (emissive DC 11)
        lampAcc.box(gx, ry, tz + 0.76, 0.20, 0.08, 0.04, pal.lampGreen, pal.lampGreen);
      }
    }
    // Caged vertical access ladder at south end of each gantry (y = rMinY - 0.18)
    const ladY = rMinY - 0.14;
    reeferAcc.box(gx - 0.20, ladY, gantryH * 0.48, 0.025, 0.025, gantryH * 0.48, pal.galv, pal.galvDark);
    reeferAcc.box(gx + 0.20, ladY, gantryH * 0.48, 0.025, 0.025, gantryH * 0.48, pal.galv, pal.galvDark);
    for (let lz = 0.40; lz <= 8.20; lz += 0.42) {
      reeferAcc.box(gx, ladY, lz, 0.20, 0.02, 0.018, pal.yellow, pal.yellow);
    }
  }
  // Overhead steel cable tray connecting all 5 reefer gantries along south face (z = 8.45 m)
  reeferAcc.box(0.5 * (rackXs[0] + rackXs[rackXs.length - 1]), rMinY, 8.45, 26.8, 0.22, 0.14, pal.galv, pal.galvDark);

  // Reefer 440V Substation & Transformer Enclosure East of road (localX = +198, localY = -160)
  const subX = 198.0;
  const subY = -160.0;
  reeferAcc.bevelBox(subX, subY, 0.15, 6.5, 5.0, 0.15, 0.25, pal.concreteDark, pal.concreteSeawall);
  reeferAcc.box(subX - 2.2, subY, 1.85, 2.4, 2.8, 1.55, pal.galv, pal.galvDark);
  reeferAcc.box(subX + 2.4, subY - 1.5, 1.40, 1.6, 1.4, 1.15, pal.cabinetBlue, cShade(pal.cabinetBlue, 0.8));
  reeferAcc.box(subX + 2.4, subY + 1.5, 1.40, 1.6, 1.4, 1.15, pal.cabinetBlue, cShade(pal.cabinetBlue, 0.8));
  for (const ix of [-3.2, -2.2, -1.2]) {
    reeferAcc.cylinder(subX + ix, subY, 3.85, 0.12, 0.90, 8, pal.amber, "z");
  }

  const reeferMat = makeDeployablePbrMaterial(t, { roughness: 0.44, metalness: 0.64, csmState });
  const reeferRacksMesh = new t.Mesh(reeferAcc.toBufferGeometry(t), reeferMat);
  reeferRacksMesh.name = "port-reefer-racks-mesh";
  reeferRacksMesh.castShadow = true;
  reeferRacksMesh.receiveShadow = true;
  root.add(reeferRacksMesh);

  // =========================================================================
  // DC 8 & DC 9: East Port Ops Control Tower + Drive-Through Intermodal Gatehouse
  //              (Keeping shuttle boulevard localY = -196 & East road localX = +174 100% clear!)
  // =========================================================================
  const opsAcc = new GeomAcc(3);
  const glassAcc = new GeomAcc(3);
  const glassCol = [0.65, 0.82, 0.92];

  // 8a. Port Operations Control Tower at localX = +198.0, localY = -196.0 (16 m clear of road +174)
  const twX = 198.0;
  const twY = -196.0;
  // Base concrete admin block (12 x 10 x 7.5 m)
  opsAcc.bevelBox(twX, twY, 3.75, 6.0, 5.0, 3.75, 0.35, pal.opsWall, cShade(pal.opsWall, 0.85));
  opsAcc.box(twX, twY, 7.65, 6.2, 5.2, 0.25, pal.blueOps, cShade(pal.blueOps, 0.82));
  // Lower floor window recesses & maritime blue accent trim
  opsAcc.box(twX, twY + 5.04, 2.2, 4.4, 0.06, 0.95, pal.opsTrim, pal.opsTrim);
  glassAcc.box(twX, twY + 5.08, 2.2, 4.1, 0.04, 0.80, glassCol, glassCol);
  opsAcc.box(twX - 6.04, twY, 5.2, 0.06, 3.6, 0.95, pal.opsTrim, pal.opsTrim);
  glassAcc.box(twX - 6.08, twY, 5.2, 0.04, 3.3, 0.80, glassCol, glassCol);
  // Central tower shaft (6.2 x 5.4 m, z in [7.8, 12.6])
  opsAcc.bevelBox(twX, twY, 10.2, 3.1, 2.7, 2.4, 0.25, pal.concreteQuay, pal.concreteDark);
  // Cantilevered panoramic Port Control Deck (9.2 x 7.6 m, z in [12.6, 16.0])
  opsAcc.bevelBox(twX, twY, 13.05, 4.6, 3.8, 0.45, 0.35, pal.blueOps, cShade(pal.blueOps, 0.8));
  // Panoramic corner mullions + roof overhang cap (z = 15.65..16.25)
  for (const sx of [-4.2, 0.0, +4.2]) {
    for (const sy of [-3.4, +3.4]) {
      opsAcc.box(twX + sx, twY + sy, 14.55, 0.18, 0.18, 1.10, pal.opsTrim, pal.opsTrim);
    }
  }
  opsAcc.bevelBox(twX, twY, 15.95, 5.0, 4.2, 0.32, 0.35, pal.opsWall, pal.concreteDark);
  // 360 deg panoramic control-deck glass band (z in [13.55, 15.60])
  glassAcc.box(twX, twY, 14.55, 4.35, 3.55, 1.02, glassCol, glassCol);
  // Roof comms mast, VTS radar scanner bar & glowing roof beacon
  opsAcc.cylinder(twX, twY, 18.6, 0.18, 4.6, 8, pal.galv, "z");
  opsAcc.box(twX, twY, 20.6, 1.45, 0.14, 0.16, pal.white, pal.galv);
  lampAcc.cylinder(twX, twY, 21.15, 0.18, 0.28, 8, pal.lampRed, "z");
  lampAcc.box(twX, twY + 3.65, 13.25, 3.8, 0.08, 0.12, pal.lampCyan, pal.lampCyan);

  // 8b. Intermodal Check-In Gate Canopy straddling shuttle corridor at localX = +118.0, localY = -196.0
  //     Clear vertical headroom 6.20 m, clear portal Y span [-202.2, -189.8] (12.4 m wide!)
  const gtX = 118.0;
  const gtY = -196.0;
  for (const py of [-203.2, -188.8]) {
    opsAcc.box(gtX - 2.6, py, 3.15, 0.35, 0.35, 3.15, pal.blueOps, cShade(pal.blueOps, 0.8));
    opsAcc.box(gtX + 2.6, py, 3.15, 0.35, 0.35, 3.15, pal.blueOps, cShade(pal.blueOps, 0.8));
    // Yellow safety bumper sleeves at column bases
    opsAcc.box(gtX - 2.6, py, 0.65, 0.42, 0.42, 0.65, pal.yellow, cShade(pal.yellow, 0.84));
    opsAcc.box(gtX + 2.6, py, 0.65, 0.42, 0.42, 0.65, pal.yellow, cShade(pal.yellow, 0.84));
  }
  // Overhead gate canopy deck (z in [6.30, 7.25]) & yellow fascia trim
  opsAcc.bevelBox(gtX, gtY, 6.78, 3.6, 8.6, 0.48, 0.25, pal.opsWall, pal.concreteDark);
  opsAcc.box(gtX, gtY, 6.42, 3.72, 8.72, 0.12, pal.blueOps, pal.blueOps);
  // Security check-in booth tucked strictly south of corridor (localY = -205.5)
  opsAcc.bevelBox(gtX, -205.8, 1.55, 2.6, 1.6, 1.55, 0.15, pal.opsWall, pal.concreteDark);
  glassAcc.box(gtX, -204.16, 1.85, 2.0, 0.05, 0.65, glassCol, glassCol);
  // Gate canopy lane open green/amber signal lights (emissive DC 11)
  lampAcc.box(gtX - 3.75, gtY - 2.2, 6.75, 0.08, 0.45, 0.22, pal.lampGreen, pal.lampGreen);
  lampAcc.box(gtX - 3.75, gtY + 2.2, 6.75, 0.08, 0.45, 0.22, pal.lampGreen, pal.lampGreen);
  lampAcc.box(gtX + 3.75, gtY - 2.2, 6.75, 0.08, 0.45, 0.22, pal.lampAmber, pal.lampAmber);
  lampAcc.box(gtX + 3.75, gtY + 2.2, 6.75, 0.08, 0.45, 0.22, pal.lampAmber, pal.lampAmber);

  const opsMat = makeDeployablePbrMaterial(t, { roughness: 0.56, metalness: 0.28, csmState });
  const gatehouseMesh = new t.Mesh(opsAcc.toBufferGeometry(t), opsMat);
  gatehouseMesh.name = "port-gatehouse-ops-mesh";
  gatehouseMesh.castShadow = true;
  gatehouseMesh.receiveShadow = true;
  root.add(gatehouseMesh);

  const opsGlassMat = new t.MeshStandardMaterial({
    color: 0xaad6ee,
    vertexColors: true,
    roughness: 0.14,
    metalness: 0.68,
    transparent: true,
    opacity: 0.54,
  });
  opsGlassMat.userData.__vfxSetKey = "port-glass";
  if (csmState) installCsmShaderPatch(opsGlassMat, csmState);
  const opsGlassMesh = new t.Mesh(glassAcc.toBufferGeometry(t), opsGlassMat);
  opsGlassMesh.name = "port-ops-glass-mesh";
  opsGlassMesh.castShadow = false;
  opsGlassMesh.receiveShadow = true;
  root.add(opsGlassMesh);

  // =========================================================================
  // DC 10: 8x High-Mast Port Floodlight Towers (InstancedMesh, 28 m tall)
  //        Strictly outside all STS/RMG/RTG rails, blocks & shuttle roadways
  // =========================================================================
  const towerPositions = [
    // 4 along quay apron landside edge (localY = -44.2, z = +2.00; clear of STS backreach -40.5)
    [-176.0, -44.2, deckZ],
    [-32.0, -44.2, deckZ],
    [+46.0, -44.2, deckZ],
    [+214.0, -44.2, deckZ],
    // 4 along yard perimeter (z = yardZ)
    [-178.0, -127.0, yardZ],
    [+214.0, -127.0, yardZ],
    [-178.0, -207.0, yardZ],
    [+70.0, -207.0, yardZ],
  ];

  const towerGeom = buildFloodlightTowerGeom(t, pal);
  const towerMat = makeDeployablePbrMaterial(t, { roughness: 0.45, metalness: 0.62, csmState });
  const lightTowersInst = new t.InstancedMesh(towerGeom, towerMat, towerPositions.length);
  lightTowersInst.name = "port-floodlight-towers-instanced";
  lightTowersInst.castShadow = true;
  lightTowersInst.receiveShadow = true;
  lightTowersInst.frustumCulled = false;

  const H_TOWER = QUAY_SPECS.lightTowerHeightM;
  for (let i = 0; i < towerPositions.length; i++) {
    const [tx, ty, tz] = towerPositions[i];
    _p.set(tx, ty, tz);
    _m.compose(_p, _q, _s);
    lightTowersInst.setMatrixAt(i, _m);

    // Emissive warm-white floodlight lamp banks + red tip aviation beacon (merged in DC 11, 0 dynamic lights!)
    lampAcc.box(tx, ty + 1.15, tz + H_TOWER - 0.35, 1.24, 0.08, 0.32, pal.lampWarm, pal.lampWarm);
    lampAcc.box(tx, ty - 1.15, tz + H_TOWER - 0.35, 1.24, 0.08, 0.32, pal.lampWarm, pal.lampWarm);
    lampAcc.cylinder(tx, ty, tz + H_TOWER + 1.22, 0.16, 0.24, 8, pal.lampRed, "z");
  }
  lightTowersInst.instanceMatrix.needsUpdate = true;
  lightTowersInst.computeBoundingBox();
  lightTowersInst.computeBoundingSphere();
  root.add(lightTowersInst);

  // =========================================================================
  // DC 11: Unified Emissive Lamps (Floodlights, Aviation Beacons, Gate Signals, Reefer LEDs)
  //        0 dynamic THREE.Light instances!
  // =========================================================================
  const lampsMat = makeLampsMaterial(t, { emissiveIntensity: 1.15, roughness: 0.25 });
  lampsMat.userData.__vfxSetKey = "lamps";
  if (csmState) installCsmShaderPatch(lampsMat, csmState);
  const lampsMesh = new t.Mesh(lampAcc.toBufferGeometry(t), lampsMat);
  lampsMesh.name = "port-emissive-lamps-mesh";
  lampsMesh.castShadow = false;
  lampsMesh.receiveShadow = false;
  root.add(lampsMesh);

  function update(state = null) {
    if (!state || typeof state !== "object") return;
    const tSec = Number.isFinite(state.timeSec) ? state.timeSec : (Number.isFinite(state.clock) ? state.clock : 0);
    const nightBoost = Number.isFinite(state.nightFactor) ? Math.max(0, Math.min(1, state.nightFactor)) : 0;
    const pulse = 0.08 * Math.sin(tSec * 2.4);
    lampsMat.emissiveIntensity = 1.10 + nightBoost * 0.85 + pulse;
  }

  let disposed = false;
  function dispose() {
    if (disposed) return;
    disposed = true;
    disposeObjectTree(root);
  }

  return {
    root,
    quayMesh,
    yardApronMesh,
    markingsMesh,
    railsMesh,
    bollardsInst,
    fendersInst,
    reeferRacksMesh,
    gatehouseMesh,
    opsGlassMesh,
    lightTowersInst,
    lampsMesh,
    lampsMat,
    layout,
    bounds: layout.bounds,
    wcid: PORT_WCID.QuayBollard,
    maxDrawCalls: QUAY_SPECS.maxDrawCalls,
    bollardCount: bollardDefs.length,
    fenderCount: fenderDefs.length,
    lightTowerCount: towerPositions.length,
    update,
    dispose,
  };
}
