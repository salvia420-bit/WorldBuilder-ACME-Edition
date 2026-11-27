// scene3d/vehicle/ship_model.js — High-Craft 78.0 m × 14.4 m Coastal Cellular Container Feeder
// (*M/V Dereth Feeder*, HLTB-FC-120, WCID 4000050)
//
// Features:
//   - Faired multi-station lofted hull with bulbous bow (+40.2 m), flared forecastle (z = +5.20 m),
//     oxide-red anti-fouling lower hull (-3.80..0 m), boot-top stripe (-0.35..+0.45 m), Plimsoll marks,
//     bow (+31 m) & stern (-32 m) lateral tunnel thruster recessed ports
//   - Open cellular cargo holds (Bays 02 / 04 / 06) with recessed tank-top at z = +0.45 m
//     (strictly above max +0.25 m AC ocean wave crest so water NEVER clips open holds!) + steel cell guides
//   - 3 articulated/removable pontoon hatch covers (z = +3.95 m) per bay + transverse lashing bridges
//   - Aft 4-deck white accommodation superstructure, glazed wheelhouse, full-beam port & starboard
//     Bridge Wings (z = +14.0 m, X = ±7.20 m), rotating radar scanner, emissive COLREG nav lights (0 lights),
//     company-livery exhaust funnel, stern free-fall lifeboat
//   - Rotating 4-blade CPP bronze propeller, articulated ±35° rudder, dynamic mooring hawser lines
//   - Internal instanced shipboard ISO container slot renderer (20ft / 40ft / 40HC across Hold 02 & Deck 82..88)
//
// Strict GPU budgets:
//   - Vessel draw calls: 13 <= 18
//   - Stowed container pool draw calls: 6 <= 6 (3 livery-tinted corrugated bodies + 3 castings/decals trim)
//   - 0 dynamic THREE.Light instances (lightCountDelta === 0)
//   - 3-cascade CSM PBR shading on all MeshStandardMaterials, full dispose(), lint_caps clean.

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
  PORT_WCID,
  SHIP_SPECS,
  SHIP_BAY_DEFS,
  SHIP_ROW_DEFS,
  ISO_CONTAINERS,
  PORT_CONTAINER_LIVERIES,
  PORT_LIVERY_KEYS,
  resolvePortContainerSpec,
  computeShipSlotLocalPose,
} from "./port_specs.js";

export const manifest = Object.freeze({
  id: "vfx-container-ship-model",
  channel: "vehicleModel",
  deterministic: true,
  lightCountDelta: 0,
  cacheKeyScope: "set",
  reads: Object.freeze(["geometry", "serverPose", "clock"]),
  writes: Object.freeze(["renderTransform", "partTransform", "materialUniform"]),
});

const TWO_PI = Math.PI * 2.0;
const MAX_STOWED_PER_SIZE = 128;
const MAX_MOORING_LINES = 12;

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function fin(v) {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * Evaluate faired half-beam at longitudinal station y (m) and vertical level z (m).
 * Produces an authentic coastal feeder hull: parallel midbody (y in [-16, +20]),
 * smooth bow entrance with sheer flare above waterline, and tapered stern run/skeg.
 */
function hullHalfBeamAt(y, z, halfB) {
  let beamFrac = 1.0;
  if (y > 23.0) {
    // Bow entrance: sleek underwater entry with dramatic upper forecastle flare
    const u = clamp((y - 23.0) / 16.0, 0, 1);
    const upperFrac = clamp((z - 1.2) / 4.0, 0, 1);
    const exp = 1.60 + upperFrac * 0.55;
    const powOut = 0.76 - upperFrac * 0.18;
    const fine = Math.pow(Math.max(0, 1 - Math.pow(u, exp)), powOut);
    const flare = upperFrac * 0.11 * Math.sin(u * Math.PI);
    beamFrac = Math.max(0.02, fine + flare);
    if (u > 0.97) beamFrac = Math.max(0.012, (1 - u) * 2.0);
  } else if (y < -22.0) {
    // Stern run: wide transom deck (accommodating mooring bitts at ±5.4 m), fine underwater skeg
    const u = clamp((-22.0 - y) / 17.0, 0, 1);
    const depthFrac = clamp((z - (-3.8)) / 7.2, 0, 1); // 0 at keel, 1 at main deck
    const sternMin = 0.08 + 0.72 * Math.pow(depthFrac, 0.72);
    beamFrac = 1.0 - (1.0 - sternMin) * Math.pow(u, 1.45);
  }

  // Bilge curve & flat-of-bottom near keel
  let section = 1.0;
  if (z < -2.4) {
    const bu = clamp((-2.4 - z) / 1.4, 0, 1);
    section = Math.sqrt(Math.max(0.02, 1 - bu * bu * 0.88));
  } else if (z < -1.0) {
    const bu = clamp((-1.0 - z) / 1.4, 0, 1);
    section = 1.0 - 0.06 * bu * bu;
  }

  return Math.max(0.06, halfB * beamFrac * section);
}

/**
 * Build reusable corrugated ISO container geometry for InstancedMesh rendering:
 *   - bodyGeom: neutral white vertex colors shaded with vertical AO + rib shading so
 *     InstancedMesh.setColorAt() cleanly tints each box to its exact CONTAINER_LIVERIES color.
 *   - trimGeom: non-tinted gunmetal ISO 1161 corner castings, galvanized door locking bars,
 *     white BIC decal panels, and 40HC yellow/black corner hazard chevrons.
 */
function buildInstancedContainerGeoms(t, spec) {
  const W = spec.extW;
  const L = spec.extL;
  const H = spec.extH;
  const hw = W * 0.5;
  const hl = L * 0.5;

  const bodyAcc = new GeomAcc(3);
  const baseTop = [1.0, 1.0, 1.0];
  const baseBot = [0.78, 0.78, 0.78];
  const ribTop = [0.88, 0.88, 0.88];
  const ribBot = [0.68, 0.68, 0.68];
  const railCol = [0.72, 0.72, 0.72];

  // Core corrugated box inset slightly inside castings
  bodyAcc.box(0, 0, H * 0.5, hw - 0.012, hl - 0.012, H * 0.5 - 0.008, baseTop, baseBot);
  // Top & bottom side rails
  bodyAcc.box(-hw + 0.025, 0, 0.08, 0.028, hl - 0.16, 0.075, railCol, cShade(railCol, 0.82));
  bodyAcc.box(+hw - 0.025, 0, 0.08, 0.028, hl - 0.16, 0.075, railCol, cShade(railCol, 0.82));
  bodyAcc.box(-hw + 0.025, 0, H - 0.04, 0.028, hl - 0.16, 0.040, railCol, cShade(railCol, 0.88));
  bodyAcc.box(+hw - 0.025, 0, H - 0.04, 0.028, hl - 0.16, 0.040, railCol, cShade(railCol, 0.88));

  // Side vertical corrugation ribs (crisp sunlight relief under CSM)
  const ribCount = spec.sizeFt === 20 ? 10 : 18;
  const ribSpan = L - 0.65;
  for (let i = 0; i < ribCount; i++) {
    const ry = -ribSpan * 0.5 + (i + 0.5) * (ribSpan / ribCount);
    bodyAcc.box(-hw + 0.004, ry, H * 0.5, 0.014, 0.095, H * 0.42, ribTop, ribBot);
    bodyAcc.box(+hw - 0.004, ry, H * 0.5, 0.014, 0.095, H * 0.42, ribTop, ribBot);
  }
  // Roof transverse corrugation ribs
  const roofRibs = spec.sizeFt === 20 ? 6 : 12;
  for (let i = 0; i < roofRibs; i++) {
    const ry = -ribSpan * 0.5 + (i + 0.5) * (ribSpan / roofRibs);
    bodyAcc.box(0, ry, H + 0.004, hw - 0.12, 0.08, 0.009, ribTop, ribTop);
  }

  // Hardware & decals (fixed realistic colors, NOT multiplied by container livery)
  const trimPal = makeLinearPalette(t, {
    casting: 0x2a2f35,
    lockBar: 0xa4acb4,
    decalWhite: 0xeceff2,
    chevronYellow: 0xf4b20c,
    chevronBlack: 0x16181c,
    gasket: 0x1c1e22,
  });
  const trimAcc = new GeomAcc(3);
  const ccX = spec.twistlockHalfX;
  const ccY = spec.twistlockHalfY;
  // 8 ISO 1161 corner castings
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      trimAcc.box(sx * ccX, sy * ccY, 0.060, 0.086, 0.094, 0.060, trimPal.casting, cShade(trimPal.casting, 0.78));
      trimAcc.box(sx * ccX, sy * ccY, H - 0.060, 0.086, 0.094, 0.060, trimPal.casting, cShade(trimPal.casting, 0.78));
    }
  }
  // Rear (-Y) twin door seam & 4 galvanized vertical locking rods
  trimAcc.box(0, -hl - 0.003, H * 0.5, 0.016, 0.008, H - 0.24, trimPal.gasket, trimPal.gasket);
  for (const bx of [-0.72, -0.34, +0.34, +0.72]) {
    trimAcc.box(bx, -hl - 0.012, H * 0.5, 0.018, 0.016, H - 0.22, trimPal.lockBar, cShade(trimPal.lockBar, 0.82));
  }
  // Side white ISO 6346 BIC markings
  for (const sx of [-1, 1]) {
    trimAcc.box(sx * (hw + 0.008), hl - 1.15, H - 0.42, 0.004, 0.85, 0.14, trimPal.decalWhite, trimPal.decalWhite);
    trimAcc.box(sx * (hw + 0.008), hl - 0.85, H - 0.64, 0.004, 0.42, 0.09, trimPal.decalWhite, trimPal.decalWhite);
  }
  // 40HC top corner yellow/black high-cube hazard chevrons
  if (spec.wcid === 4000022) {
    for (const sx of [-1, 1]) {
      for (const sy of [-1, 1]) {
        const cx = sx * (hw - 0.04);
        const cy = sy * (hl - 0.08);
        trimAcc.box(cx, cy, H - 0.11, 0.048, 0.085, 0.075, trimPal.chevronYellow, trimPal.chevronYellow);
        trimAcc.box(cx, cy, H - 0.26, 0.048, 0.085, 0.075, trimPal.chevronBlack, trimPal.chevronBlack);
      }
    }
  }

  return {
    bodyGeom: bodyAcc.toBufferGeometry(t),
    trimGeom: trimAcc.toBufferGeometry(t),
  };
}

function resolveLiveryHex(entry) {
  if (entry && fin(entry.colorHex)) return entry.colorHex;
  if (entry && typeof entry.livery === "string" && PORT_CONTAINER_LIVERIES[entry.livery]) {
    return PORT_CONTAINER_LIVERIES[entry.livery].hex;
  }
  if (entry && Number.isInteger(entry.liveryId)) {
    const idx = ((entry.liveryId % PORT_LIVERY_KEYS.length) + PORT_LIVERY_KEYS.length) % PORT_LIVERY_KEYS.length;
    return PORT_CONTAINER_LIVERIES[PORT_LIVERY_KEYS[idx]].hex;
  }
  return PORT_CONTAINER_LIVERIES.maritimeBlue.hex;
}

/**
 * Build the high-craft 78.0 m × 14.4 m coastal cellular container feeder (*M/V Dereth Feeder*).
 *
 * @param {object} [three] THREE namespace
 * @param {{
 *   csmState?: object|null,
 *   hullHex?: number,
 *   funnelHex?: number,
 *   name?: string,
 * }} [options]
 */
export function buildContainerShip(three, options = {}) {
  const t = three || THREE_DEFAULT;
  const opts = options && typeof options === "object" ? options : {};
  const csmState = opts.csmState ?? null;
  const S = SHIP_SPECS;

  const pal = makeLinearPalette(t, {
    hullNavy: opts.hullHex ?? 0x162b44,
    hullNavyDark: 0x0e1d30,
    antiFoulRed: 0x7c231c,
    antiFoulDark: 0x561611,
    bootTopWhite: 0xdbe2e8,
    bootTopDark: 0x1d232a,
    deckGreen: 0x355348,
    deckGray: 0x4b545e,
    holdTankTop: 0x38424c,
    holdWall: 0x45505c,
    cellGuideYellow: 0xe6a814,
    hatchSlate: 0x5c4134,
    hatchRib: 0x473127,
    whiteHouse: 0xe9eef2,
    whiteHouseShade: 0xc5ced6,
    bridgeRoof: 0x7a8590,
    glassDark: 0x112030,
    glassGlint: 0x264460,
    funnelAccent: opts.funnelHex ?? 0xc83e2b,
    funnelCap: 0x1e2228,
    lifeboatOrange: 0xe85a10,
    bronze: 0xb88636,
    steelDark: 0x2a3038,
    steelLight: 0x8e98a2,
    thrusterDark: 0x0d1218,
    navRed: 0xff2820,
    navGreen: 0x1ee656,
    navWhite: 0xfff8e6,
    deckFloodAmber: 0xffd27a,
    hawserTan: 0xc4b08a,
  });

  const root = new t.Group();
  root.name = "container-ship-root";
  root.rotation.order = "ZXY";
  root.userData = {
    wcid: PORT_WCID.ContainerShipFeeder,
    vesselName: opts.name || S.defaultName,
    loaM: S.loaM,
    beamM: S.beamM,
    draftM: S.draftM,
    holdTankTopZ: S.holdTankTopZ,
    hatchDeckZ: S.hatchDeckZ,
  };

  // =========================================================================
  // DC 1: Faired Main Hull, Bulbous Bow, Forecastle, Open Holds (z=+0.45 m),
  //       Plimsoll Marks & Tunnel Thruster Ports
  // =========================================================================
  const hullAcc = new GeomAcc(3);

  // 1a. Multi-station open U-section hull shell from stern (-39.0) to bow (+39.0)
  // Ring order: Starboard gunwale -> Stbd sheer -> Stbd boot -> Stbd bilge -> Keel -> Port bilge -> Port boot -> Port sheer -> Port gunwale
  // Advancing stern (-Y) -> bow (+Y) produces strictly outward-facing CCW faces & normals.
  const stations = [
    -39.0, -37.2, -34.0, -29.5, -24.0, -18.0, -10.0, 0.0, 10.0, 18.0, 24.0, 29.0, 33.5, 36.8, 39.0,
  ];
  const zProfile = [
    { z: 3.40, col: pal.hullNavy },       // stbd main sheer
    { z: 0.45, col: pal.hullNavyDark },   // stbd boot-top upper edge
    { z: 0.05, col: pal.bootTopWhite },   // stbd waterline white boot stripe
    { z: -0.35, col: pal.antiFoulRed },   // stbd anti-fouling top
    { z: -2.40, col: pal.antiFoulRed },   // stbd bilge
    { z: -3.80, col: pal.antiFoulDark },  // stbd flat bottom
    { z: -3.80, col: pal.antiFoulDark },  // keel centerline
    { z: -3.80, col: pal.antiFoulDark },  // port flat bottom
    { z: -2.40, col: pal.antiFoulRed },   // port bilge
    { z: -0.35, col: pal.antiFoulRed },   // port anti-fouling top
    { z: 0.05, col: pal.bootTopWhite },   // port waterline white boot stripe
    { z: 0.45, col: pal.hullNavyDark },   // port boot-top upper edge
    { z: 3.40, col: pal.hullNavy },       // port main sheer
  ];

  const hullRings = [];
  for (let si = 0; si < stations.length; si++) {
    const y = stations[si];
    const pts = [];
    const cols = [];
    const isForecastle = y >= S.forecastleMinY;
    const topZ = isForecastle
      ? S.mainDeckZ + clamp((y - S.forecastleMinY) / 4.0, 0, 1) * (S.forecastleZ - S.mainDeckZ)
      : S.mainDeckZ;

    for (let pi = 0; pi < zProfile.length; pi++) {
      const zp = zProfile[pi];
      const z = (pi === 0 || pi === zProfile.length - 1) ? topZ : zp.z;
      let x = 0;
      if (pi === 6) {
        x = 0; // keel center
      } else {
        const side = pi < 6 ? +1 : -1;
        const hb = hullHalfBeamAt(y, z, S.halfBeamM);
        const keelFactor = (pi === 5 || pi === 7) ? 0.52 : 1.0;
        x = side * hb * keelFactor;
      }
      pts.push([x, y, z]);
      cols.push(zp.col);
    }
    hullRings.push({ pts, cols });
  }
  hullAcc.loft(hullRings, false);

  // Stern transom cap at y = -39.0 (facing -Y)
  const aftRing = hullRings[0];
  const aftCenter = [0, -39.0, 0.2];
  for (let i = 0; i < aftRing.pts.length - 1; i++) {
    hullAcc.tri(aftCenter, aftRing.pts[i + 1], aftRing.pts[i], pal.hullNavyDark, aftRing.cols[i + 1], aftRing.cols[i]);
  }
  // Transom top deck cap (y = -39.0)
  hullAcc.tri(aftCenter, aftRing.pts[0], aftRing.pts[aftRing.pts.length - 1], pal.hullNavyDark, pal.hullNavy, pal.hullNavy);

  // Bow stem front cap at y = +39.0 (closes narrow stem strip cleanly with +Y normal)
  const bowRing = hullRings[hullRings.length - 1];
  const halfLen = (bowRing.pts.length - 1) >> 1;
  for (let i = 0; i < halfLen; i++) {
    const stbd0 = bowRing.pts[i];
    const stbd1 = bowRing.pts[i + 1];
    const port0 = bowRing.pts[bowRing.pts.length - 1 - i];
    const port1 = bowRing.pts[bowRing.pts.length - 2 - i];
    hullAcc.quad(port0, stbd0, stbd1, port1, bowRing.cols[i], bowRing.cols[i], bowRing.cols[i + 1], bowRing.cols[i + 1]);
  }

  // 1b. Bulbous Bow (smoothly lofted tear-drop bulb extending y = +35.0..+40.2 m, z = -3.45..-0.55 m)
  const bulbStations = [
    { y: 35.0, rx: 1.55, rz: 1.38, cz: -2.05 },
    { y: 36.8, rx: 1.48, rz: 1.32, cz: -2.02 },
    { y: 38.4, rx: 1.24, rz: 1.12, cz: -1.96 },
    { y: 39.5, rx: 0.78, rz: 0.74, cz: -1.92 },
    { y: 40.2, rx: 0.14, rz: 0.14, cz: -1.90 },
  ];
  const bulbSegs = 12;
  const bulbRings = [];
  for (const bs of bulbStations) {
    const pts = [];
    const cols = [];
    for (let i = 0; i < bulbSegs; i++) {
      // Clockwise viewed from aft looking +Y -> outward normals
      const a = -(i / bulbSegs) * TWO_PI;
      const x = Math.cos(a) * bs.rx;
      const z = bs.cz + Math.sin(a) * bs.rz;
      pts.push([x, bs.y, z]);
      cols.push(z > -0.45 ? pal.bootTopWhite : (z < -2.6 ? pal.antiFoulDark : pal.antiFoulRed));
    }
    bulbRings.push({ pts, cols });
  }
  hullAcc.loft(bulbRings, true);
  // Bulb tip nose cap
  const tipRing = bulbRings[bulbRings.length - 1];
  const tipApex = [0, 40.25, -1.90];
  for (let i = 0; i < bulbSegs; i++) {
    const j = (i + 1) % bulbSegs;
    hullAcc.tri(tipApex, tipRing.pts[i], tipRing.pts[j], pal.antiFoulRed, tipRing.cols[i], tipRing.cols[j]);
  }

  // 1c. Forecastle Deck (y = +27.0..+39.0, z = +5.20 m) & Forward Breakwater Wall (strictly faired inside hull beam)
  const fcStations = [27.0, 30.0, 33.5, 36.8, 39.0];
  for (let i = 0; i < fcStations.length - 1; i++) {
    const y0 = fcStations[i];
    const y1 = fcStations[i + 1];
    const z0 = S.mainDeckZ + clamp((y0 - 27.0) / 4.0, 0, 1) * (S.forecastleZ - S.mainDeckZ);
    const z1 = S.mainDeckZ + clamp((y1 - 27.0) / 4.0, 0, 1) * (S.forecastleZ - S.mainDeckZ);
    const w0 = hullHalfBeamAt(y0, z0, S.halfBeamM) - 0.04;
    const w1 = hullHalfBeamAt(y1, z1, S.halfBeamM) - 0.04;
    // Top walkable forecastle deck quad (+Z normal)
    hullAcc.quad(
      [-w0, y0, z0], [+w0, y0, z0], [+w1, y1, z1], [-w1, y1, z1],
      pal.deckGreen, pal.deckGreen, pal.deckGreen, pal.deckGreen
    );
  }
  // Forecastle aft bulkhead drop wall (y = 27.0) & angled sea-spray breakwater (y = 28.4)
  const fcWallHalfW = hullHalfBeamAt(27.0, 3.6, S.halfBeamM) - 0.14;
  const brkHalfW = hullHalfBeamAt(28.4, 5.2, S.halfBeamM) - 0.45;
  hullAcc.box(0, 27.0, 4.30, fcWallHalfW, 0.20, 0.90, pal.hullNavy, pal.hullNavyDark);
  hullAcc.box(0, 28.4, 5.75, brkHalfW, 0.22, 0.65, pal.hullNavy, pal.hullNavyDark);

  // 1d. Aft Poop Deck (y = -39.0..-18.0, z = +3.40 m) & Faired Side Wing-Tank Walk Decks
  const aftDeckY = [-39.0, -34.0, -29.5, -24.0, -18.0];
  for (let i = 0; i < aftDeckY.length - 1; i++) {
    const y0 = aftDeckY[i];
    const y1 = aftDeckY[i + 1];
    const w0 = hullHalfBeamAt(y0, S.mainDeckZ, S.halfBeamM) - 0.04;
    const w1 = hullHalfBeamAt(y1, S.mainDeckZ, S.halfBeamM) - 0.04;
    hullAcc.quad(
      [-w0, y0, S.mainDeckZ], [+w0, y0, S.mainDeckZ], [+w1, y1, S.mainDeckZ], [-w1, y1, S.mainDeckZ],
      pal.deckGreen, pal.deckGreen, pal.deckGreen, pal.deckGreen
    );
  }
  // Faired wing-tank side decks along cargo zone (y in [-18.0, +27.0], strictly tracking outer hull sheer!)
  const wingStationsY = [-18.0, -10.0, 0.0, 10.0, 18.0, 23.0, 25.0, 27.0];
  for (let i = 0; i < wingStationsY.length - 1; i++) {
    const y0 = wingStationsY[i];
    const y1 = wingStationsY[i + 1];
    const w0 = hullHalfBeamAt(y0, S.mainDeckZ, S.halfBeamM) - 0.04;
    const w1 = hullHalfBeamAt(y1, S.mainDeckZ, S.halfBeamM) - 0.04;
    // Starboard wing deck (+X)
    hullAcc.quad(
      [5.56, y0, S.mainDeckZ], [w0, y0, S.mainDeckZ], [w1, y1, S.mainDeckZ], [5.56, y1, S.mainDeckZ],
      pal.deckGreen, pal.deckGreen, pal.deckGreen, pal.deckGreen
    );
    // Port wing deck (-X)
    hullAcc.quad(
      [-w0, y0, S.mainDeckZ], [-5.56, y0, S.mainDeckZ], [-5.56, y1, S.mainDeckZ], [-w1, y1, S.mainDeckZ],
      pal.deckGreen, pal.deckGreen, pal.deckGreen, pal.deckGreen
    );
  }
  for (const sx of [-1, 1]) {
    // Wing tank inner vertical hold walls (x = ±5.56, z in [0.45, 3.60])
    hullAcc.box(sx * 5.56, 3.0, 2.025, 0.14, 21.6, 1.575, pal.holdWall, cShade(pal.holdWall, 0.78));
  }

  // 1e. Open Cellular Cargo Hold Tank-Top Deck (z = +0.45 m STRICTLY above max +0.25 m ocean swell!)
  // Spans all 3 bays (Bay 02: +16.4, Bay 04: +3.0, Bay 06: -10.4 -> y in [-17.5, +24.0])
  hullAcc.box(0, 3.0, S.holdTankTopZ - 0.08, 5.55, 21.0, 0.08, pal.holdTankTop, cShade(pal.holdTankTop, 0.76));

  // Transverse watertight bulkheads separating Hold 1 (02), Hold 2 (04), Hold 3 (06)
  for (const bhdY of [23.35, 9.70, -3.70, -17.35]) {
    hullAcc.box(0, bhdY, 2.025, 5.55, 0.34, 1.575, pal.holdWall, cShade(pal.holdWall, 0.78));
  }
  // Faired forward bridge deck between Bay 02 coaming (+23.35) and forecastle (+27.0)
  const fwdY = [23.35, 25.2, 27.0];
  for (let i = 0; i < fwdY.length - 1; i++) {
    const y0 = fwdY[i];
    const y1 = fwdY[i + 1];
    const w0 = hullHalfBeamAt(y0, S.mainDeckZ, S.halfBeamM) - 0.05;
    const w1 = hullHalfBeamAt(y1, S.mainDeckZ, S.halfBeamM) - 0.05;
    hullAcc.quad(
      [-w0, y0, S.mainDeckZ], [+w0, y0, S.mainDeckZ], [+w1, y1, S.mainDeckZ], [-w1, y1, S.mainDeckZ],
      pal.deckGreen, pal.deckGreen, pal.deckGreen, pal.deckGreen
    );
  }

  // 1f. Plimsoll Load-Line Marks & Draft Marks (port & starboard midships flanks x = ±7.22 m)
  for (const sx of [-1, 1]) {
    const px = sx * (S.halfBeamM + 0.025);
    // Plimsoll ring + horizontal bar at waterline z = +0.25 m
    hullAcc.cylinder(px, 0.0, 0.25, 0.22, 0.02, 12, pal.bootTopWhite, "x");
    hullAcc.box(px, 0.0, 0.25, 0.015, 0.38, 0.035, pal.bootTopWhite, pal.bootTopWhite);
    hullAcc.box(px, 0.52, 0.25, 0.015, 0.03, 0.28, pal.bootTopWhite, pal.bootTopWhite);
    for (const tz of [0.12, 0.25, 0.38]) {
      hullAcc.box(px, 0.62, tz, 0.015, 0.10, 0.025, pal.bootTopWhite, pal.bootTopWhite);
    }
    // Bow & stern tunnel thruster recessed apertures + yellow safety warning triangles
    hullAcc.cylinder(sx * (hullHalfBeamAt(S.bowThrusterY, S.bowThrusterZ, S.halfBeamM) + 0.01), S.bowThrusterY, S.bowThrusterZ, 0.72, 0.14, 14, pal.thrusterDark, "x");
    hullAcc.box(sx * (hullHalfBeamAt(S.bowThrusterY, 1.8, S.halfBeamM) + 0.025), S.bowThrusterY, 1.80, 0.02, 0.42, 0.42, pal.cellGuideYellow, pal.cellGuideYellow);
    hullAcc.cylinder(sx * (hullHalfBeamAt(S.sternThrusterY, S.sternThrusterZ, S.halfBeamM) + 0.01), S.sternThrusterY, S.sternThrusterZ, 0.65, 0.14, 14, pal.thrusterDark, "x");
    hullAcc.box(sx * (hullHalfBeamAt(S.sternThrusterY, 1.8, S.halfBeamM) + 0.025), S.sternThrusterY, 1.80, 0.02, 0.40, 0.40, pal.cellGuideYellow, pal.cellGuideYellow);
  }

  // Skeg / propeller bossing under stern
  hullAcc.box(0, -33.2, -2.55, 0.55, 4.40, 1.15, pal.antiFoulDark, cShade(pal.antiFoulDark, 0.8));

  const hullMat = makeDeployablePbrMaterial(t, { roughness: 0.52, metalness: 0.28, csmState });
  const hullMesh = new t.Mesh(hullAcc.toBufferGeometry(t), hullMat);
  hullMesh.name = "ship-hull-mesh";
  hullMesh.castShadow = true;
  hullMesh.receiveShadow = true;
  root.add(hullMesh);

  // =========================================================================
  // DC 2: Steel Cell Guides, Hatch Coamings, Transverse Lashing Bridges,
  //       Mooring Bitts, Anchor Windlass & Deck Bulwarks
  // =========================================================================
  const steelAcc = new GeomAcc(3);

  // 2a. Vertical steel cell guides inside Holds 1/2/3 framing all 4 rows (x = -3.90, -1.30, +1.30, +3.90)
  const guideXs = [-5.20, -2.60, 0.0, +2.60, +5.20];
  for (const bayDef of SHIP_BAY_DEFS.even40) {
    const by = bayDef.y;
    for (const gx of guideXs) {
      for (const dy of [-6.16, 0.0, +6.16]) {
        steelAcc.box(gx, by + dy, 2.02, 0.075, 0.075, 1.56, pal.cellGuideYellow, cShade(pal.cellGuideYellow, 0.82));
      }
    }
    // Raised perimeter hatch coaming lip (z = 3.40..3.60)
    steelAcc.box(-5.50, by, 3.50, 0.14, 6.42, 0.14, pal.steelDark, pal.steelDark);
    steelAcc.box(+5.50, by, 3.50, 0.14, 6.42, 0.14, pal.steelDark, pal.steelDark);
  }

  // 2b. Transverse Lashing Bridges between bays (y = +9.70, -3.70) + fore/aft catwalks
  for (const lbY of [9.70, -3.70]) {
    // Lower and upper lashing catwalk platforms
    steelAcc.box(0, lbY, 5.10, 5.85, 0.34, 0.08, pal.steelLight, pal.steelDark);
    steelAcc.box(0, lbY, S.lashingBridgeTopZ, 5.85, 0.34, 0.08, pal.steelLight, pal.steelDark);
    // Handrail bars
    steelAcc.box(0, lbY + 0.32, S.lashingBridgeTopZ + 0.55, 5.85, 0.03, 0.03, pal.cellGuideYellow, pal.cellGuideYellow);
    steelAcc.box(0, lbY - 0.32, S.lashingBridgeTopZ + 0.55, 5.85, 0.03, 0.03, pal.cellGuideYellow, pal.cellGuideYellow);
    // Vertical stanchion legs (5 across beam)
    for (const lx of [-5.55, -2.60, 0.0, +2.60, +5.55]) {
      steelAcc.box(lx, lbY, 5.05, 0.11, 0.14, 1.68, pal.steelDark, cShade(pal.steelDark, 0.8));
    }
  }

  // 2c. Mooring Bitts / Bollards matching SHIP_SPECS.mooringBitts (both port & stbd)
  for (const side of ["starboard", "port"]) {
    for (const bitt of S.mooringBitts[side]) {
      const [bx, by, bz] = bitt.pos;
      steelAcc.box(bx, by, bz - 0.12, 0.24, 0.52, 0.08, pal.steelDark, pal.steelDark);
      steelAcc.cylinder(bx, by - 0.24, bz + 0.10, 0.11, 0.36, 8, pal.steelLight, "z");
      steelAcc.cylinder(bx, by + 0.24, bz + 0.10, 0.11, 0.36, 8, pal.steelLight, "z");
    }
  }

  // 2d. Forecastle Anchor Windlass, Hawse Anchors & Forward Jackstaff Mast
  steelAcc.box(0, 32.8, 5.65, 1.45, 0.65, 0.45, pal.steelDark, cShade(pal.steelDark, 0.78));
  steelAcc.cylinder(0, 32.8, 5.75, 0.38, 2.20, 10, pal.steelLight, "x");
  // Twin stowed stockless bow anchors recessed on port & starboard bow cheeks
  for (const sx of [-1, 1]) {
    const ax = sx * (hullHalfBeamAt(35.0, 2.6, S.halfBeamM) + 0.08);
    steelAcc.box(ax, 35.0, 2.55, 0.14, 0.48, 0.68, pal.steelDark, pal.steelDark);
    steelAcc.box(ax, 35.0, 2.15, 0.16, 0.62, 0.16, pal.steelDark, pal.steelDark);
  }
  // Forward jackstaff mast (supports forward masthead light)
  steelAcc.cylinder(0, 37.2, 7.15, 0.08, 3.90, 8, pal.whiteHouse, "z");
  steelAcc.box(0, 37.2, 8.20, 0.95, 0.05, 0.05, pal.whiteHouse, pal.whiteHouse);

  // Gunwale safety railings along parallel wing decks (y in [-18, +23])
  for (const sx of [-1, 1]) {
    steelAcc.box(sx * 7.08, 2.5, 4.18, 0.04, 20.5, 0.04, pal.whiteHouse, pal.whiteHouseShade);
    for (let ry = -18; ry <= 22; ry += 4.0) {
      steelAcc.box(sx * 7.08, ry, 3.79, 0.035, 0.035, 0.40, pal.whiteHouse, pal.whiteHouseShade);
    }
  }

  const steelMat = makeDeployablePbrMaterial(t, { roughness: 0.46, metalness: 0.56, csmState });
  const steelMesh = new t.Mesh(steelAcc.toBufferGeometry(t), steelMat);
  steelMesh.name = "ship-deck-steel-mesh";
  steelMesh.castShadow = true;
  steelMesh.receiveShadow = true;
  root.add(steelMesh);

  // =========================================================================
  // DC 3, 4, 5: Animated/Removable Pontoon Hatch Covers (Bays 02, 04, 06)
  // Top face strictly at z = SHIP_SPECS.hatchDeckZ (+3.95 m) when closed (0.0)
  // =========================================================================
  const hatchMat = makeDeployablePbrMaterial(t, { roughness: 0.58, metalness: 0.36, csmState });
  const hatchCovers = {}; // bay -> { pivot, mesh, baseY, open }

  const hatchAcc = new GeomAcc(3);
  // Single reusable 40ft pontoon hatch cover geometry (width 11.10 m, length 12.60 m, height 0.35 m -> top at local z = +0.35)
  hatchAcc.box(0, 0, 0.175, 5.55, 6.30, 0.175, pal.hatchSlate, pal.hatchRib);
  // Stiffening transverse ribs & ISO container twistlock foundation pads for all 4 rows
  for (let ry = -5.6; ry <= 5.65; ry += 1.60) {
    hatchAcc.box(0, ry, 0.34, 5.45, 0.12, 0.025, pal.hatchRib, pal.hatchRib);
  }
  for (const rowDef of SHIP_ROW_DEFS) {
    for (const py of [-5.99, -0.22, +0.22, +5.99]) {
      hatchAcc.box(rowDef.x - 1.13, py, 0.345, 0.10, 0.10, 0.015, pal.cellGuideYellow, pal.cellGuideYellow);
      hatchAcc.box(rowDef.x + 1.13, py, 0.345, 0.10, 0.10, 0.015, pal.cellGuideYellow, pal.cellGuideYellow);
    }
  }
  const sharedHatchGeom = hatchAcc.toBufferGeometry(t);

  for (const bayDef of SHIP_BAY_DEFS.even40) {
    const piv = new t.Group();
    piv.name = `ship-hatch-pivot-${String(bayDef.bay).padStart(2, "0")}`;
    // Hinge sits at the forward bulkhead edge of the bay so opening lifts & folds hatch cleanly upright
    const hingeY = bayDef.y + 6.30;
    piv.position.set(0, hingeY, S.coamingTopZ); // z = 3.60; cover top at 3.60 + 0.35 = 3.95 m!
    const hMesh = new t.Mesh(sharedHatchGeom, hatchMat);
    hMesh.name = `ship-hatch-${String(bayDef.bay).padStart(2, "0")}`;
    hMesh.position.set(0, -6.30, 0);
    hMesh.castShadow = true;
    hMesh.receiveShadow = true;
    piv.add(hMesh);
    root.add(piv);
    hatchCovers[bayDef.bay] = { pivot: piv, mesh: hMesh, open: 0.0 };
  }

  // =========================================================================
  // DC 6: Aft 4-Deck White Accommodation Superstructure & Full-Beam Bridge Wings
  // =========================================================================
  const houseAcc = new GeomAcc(3);

  // Deck 1 (Poop / Main Accommodation: z = 3.40..6.20, y = -35.5..-22.0, width 12.2 m)
  houseAcc.bevelBox(0, -28.75, 4.80, 6.10, 6.75, 1.40, 0.35, pal.whiteHouse, pal.whiteHouseShade);
  // Deck 2 (Crew Quarters: z = 6.20..8.80, y = -34.2..-22.5, width 11.4 m)
  houseAcc.bevelBox(0, -28.35, 7.50, 5.70, 5.85, 1.30, 0.30, pal.whiteHouse, pal.whiteHouseShade);
  // Deck 3 (Officers Deck: z = 8.80..11.40, y = -33.0..-23.0, width 10.6 m)
  houseAcc.bevelBox(0, -28.00, 10.10, 5.30, 5.00, 1.30, 0.25, pal.whiteHouse, pal.whiteHouseShade);
  // Deck 4 (Captain's Deck: z = 11.40..14.00, y = -31.8..-23.5, width 9.6 m)
  houseAcc.bevelBox(0, -27.65, 12.70, 4.80, 4.15, 1.30, 0.25, pal.whiteHouse, pal.whiteHouseShade);

  // Navigation Bridge Deck (z = 14.00..16.40) + Full-Beam Port & Starboard Bridge Wings (X = ±7.20 m!)
  houseAcc.bevelBox(0, -26.20, 15.20, 4.90, 3.10, 1.20, 0.22, pal.whiteHouse, pal.whiteHouseShade);
  // Full-beam Bridge Wing cantilevered walkway deck & dodgers (X in [-7.20, +7.20], z = 14.00..15.15)
  houseAcc.box(0, -25.40, 14.12, S.bridgeWingX, 1.25, 0.14, pal.whiteHouse, pal.whiteHouseShade);
  houseAcc.box(-6.05, -25.40, 14.68, 1.15, 1.25, 0.45, pal.whiteHouse, pal.whiteHouseShade);
  houseAcc.box(+6.05, -25.40, 14.68, 1.15, 1.25, 0.45, pal.whiteHouse, pal.whiteHouseShade);
  // Wing-tip docking thruster control consoles
  houseAcc.box(-6.85, -25.00, 15.20, 0.22, 0.35, 0.25, pal.steelDark, pal.steelDark);
  houseAcc.box(+6.85, -25.00, 15.20, 0.22, 0.35, 0.25, pal.steelDark, pal.steelDark);
  // Support wing struts underneath bridge wings
  for (const sx of [-1, 1]) {
    houseAcc.tube([sx * 4.80, -25.40, 12.50], [sx * 6.80, -25.40, 14.00], 0.14, 0.12, 8, pal.whiteHouseShade, pal.whiteHouse);
  }

  // Compass deck roof (z = 16.40) & overhanging bridge brow sun-visor
  houseAcc.box(0, -26.00, 16.46, 5.15, 3.35, 0.10, pal.bridgeRoof, pal.whiteHouseShade);
  houseAcc.box(0, -22.85, 16.25, 5.15, 0.45, 0.08, pal.whiteHouse, pal.whiteHouseShade);

  // Exterior sloped accommodation stairways & life-raft canisters
  for (const sx of [-1, 1]) {
    houseAcc.box(sx * 5.85, -26.5, 6.20, 0.28, 2.20, 0.12, pal.steelLight, pal.steelDark);
    houseAcc.box(sx * 5.45, -26.5, 8.80, 0.28, 2.20, 0.12, pal.steelLight, pal.steelDark);
    // White cylindrical inflatable life-raft canisters on racks
    houseAcc.cylinder(sx * 5.95, -23.8, 6.75, 0.34, 1.10, 10, pal.whiteHouse, "y");
    houseAcc.cylinder(sx * 5.95, -25.2, 6.75, 0.34, 1.10, 10, pal.whiteHouse, "y");
  }

  // Compass Deck Lattice Radar Mast (z = 16.50..22.50) + Satcom radome
  houseAcc.box(0, -26.40, 19.35, 0.28, 0.36, 2.85, pal.whiteHouse, pal.whiteHouseShade);
  houseAcc.box(0, -26.40, 20.60, 2.60, 0.12, 0.12, pal.whiteHouse, pal.whiteHouseShade);
  houseAcc.box(0, -26.40, 18.80, 1.75, 0.10, 0.10, pal.whiteHouse, pal.whiteHouseShade);
  houseAcc.cylinder(-2.20, -27.60, 17.30, 0.58, 0.85, 12, pal.whiteHouse, "z"); // Satcom radome

  const houseMat = makeDeployablePbrMaterial(t, { roughness: 0.48, metalness: 0.16, csmState });
  const houseMesh = new t.Mesh(houseAcc.toBufferGeometry(t), houseMat);
  houseMesh.name = "ship-superstructure-mesh";
  houseMesh.castShadow = true;
  houseMesh.receiveShadow = true;
  root.add(houseMesh);

  // =========================================================================
  // DC 7: Glazed Wheelhouse Wraparound Windows & Cabin Portholes
  // =========================================================================
  const glassAcc = new GeomAcc(3);
  // Wraparound panoramic bridge forward & side windows (z = 14.9..16.05)
  glassAcc.box(0, -23.06, 15.50, 4.55, 0.08, 0.56, pal.glassGlint, pal.glassDark);
  glassAcc.box(-4.92, -25.20, 15.50, 0.08, 1.85, 0.56, pal.glassGlint, pal.glassDark);
  glassAcc.box(+4.92, -25.20, 15.50, 0.08, 1.85, 0.56, pal.glassGlint, pal.glassDark);
  // Bridge wing clear windscreens
  glassAcc.box(-6.05, -24.16, 15.32, 1.12, 0.05, 0.32, pal.glassGlint, pal.glassDark);
  glassAcc.box(+6.05, -24.16, 15.32, 1.12, 0.05, 0.32, pal.glassGlint, pal.glassDark);
  // Accommodation deck porthole rows (Decks 2, 3, 4 forward & flanks)
  for (const [dz, frontY, flankX] of [[7.65, -22.46, 5.72], [10.25, -22.96, 5.32], [12.85, -23.46, 4.82]]) {
    for (let wx = -3.4; wx <= 3.45; wx += 1.36) {
      glassAcc.box(wx, frontY, dz, 0.42, 0.06, 0.30, pal.glassDark, pal.glassDark);
    }
    for (let wy = -30.5; wy <= -24.5; wy += 2.0) {
      glassAcc.box(-flankX, wy, dz, 0.06, 0.46, 0.30, pal.glassDark, pal.glassDark);
      glassAcc.box(+flankX, wy, dz, 0.06, 0.46, 0.30, pal.glassDark, pal.glassDark);
    }
  }

  const glassMat = makeDeployablePbrMaterial(t, { roughness: 0.14, metalness: 0.78, csmState });
  const glassMesh = new t.Mesh(glassAcc.toBufferGeometry(t), glassMat);
  glassMesh.name = "ship-glass-mesh";
  glassMesh.castShadow = true;
  glassMesh.receiveShadow = true;
  root.add(glassMesh);

  // =========================================================================
  // DC 8: Funnel with Company Livery Bands & Stern Free-Fall Lifeboat
  // =========================================================================
  const funAcc = new GeomAcc(3);
  // Sculpted funnel casing (y = -31.5, z = 11.4..19.5 m)
  funAcc.bevelBox(0, S.funnelY, 13.8, 1.55, 2.35, 2.40, 0.45, pal.funnelAccent, cShade(pal.funnelAccent, 0.82));
  // Crisp white & navy company livery bands
  funAcc.bevelBox(0, S.funnelY, 16.6, 1.48, 2.15, 0.48, 0.40, pal.whiteHouse, pal.whiteHouseShade);
  funAcc.bevelBox(0, S.funnelY, 17.5, 1.44, 2.05, 0.45, 0.38, pal.hullNavy, pal.hullNavyDark);
  funAcc.bevelBox(0, S.funnelY, 18.45, 1.36, 1.90, 0.55, 0.36, pal.funnelCap, pal.funnelCap);
  // Twin exhaust uptake pipes protruding from funnel top
  funAcc.cylinder(-0.42, S.funnelY - 0.35, 19.25, 0.34, 0.90, 10, pal.steelDark, "z");
  funAcc.cylinder(+0.42, S.funnelY - 0.35, 19.25, 0.34, 0.90, 10, pal.steelDark, "z");

  // High-visibility International-Orange Stern Free-Fall Lifeboat on angled launch skid (y = -35.8, z = 8.4)
  funAcc.box(0, -35.4, 7.15, 1.25, 2.20, 0.14, pal.steelDark, pal.steelDark);
  funAcc.bevelBox(0, -35.8, 8.20, 1.15, 2.45, 0.72, 0.45, pal.lifeboatOrange, cShade(pal.lifeboatOrange, 0.82));
  funAcc.bevelBox(0, -35.5, 8.95, 0.88, 1.55, 0.32, 0.25, pal.lifeboatOrange, pal.lifeboatOrange);

  const funMat = makeDeployablePbrMaterial(t, { roughness: 0.44, metalness: 0.28, csmState });
  const funMesh = new t.Mesh(funAcc.toBufferGeometry(t), funMat);
  funMesh.name = "ship-funnel-lifeboat-mesh";
  funMesh.castShadow = true;
  funMesh.receiveShadow = true;
  root.add(funMesh);

  // =========================================================================
  // DC 9: Rotating Radar Scanner (S-band slotted waveguide atop compass mast)
  // =========================================================================
  const radarPivot = new t.Group();
  radarPivot.name = "ship-radar-pivot";
  radarPivot.position.set(0, -26.40, 21.55);
  root.add(radarPivot);

  const radAcc = new GeomAcc(3);
  radAcc.cylinder(0, 0, -0.18, 0.24, 0.36, 10, pal.whiteHouse, "z");
  radAcc.bevelBox(0, 0, 0.10, 1.55, 0.16, 0.10, 0.04, pal.whiteHouse, pal.whiteHouseShade);
  radAcc.box(0, +0.16, 0.10, 1.48, 0.02, 0.07, pal.cellGuideYellow, pal.cellGuideYellow);
  const radMat = makeDeployablePbrMaterial(t, { roughness: 0.35, metalness: 0.42, csmState });
  const radarMesh = new t.Mesh(radAcc.toBufferGeometry(t), radMat);
  radarMesh.name = "ship-radar-scanner";
  radarMesh.castShadow = true;
  radarMesh.receiveShadow = true;
  radarPivot.add(radarMesh);

  // =========================================================================
  // DC 10: Emissive COLREG Navigation & Deck Flood Lamps (0 dynamic lights!)
  // =========================================================================
  const lampAcc = new GeomAcc(3);
  // Port RED sidelight (left bridge wingtip)
  lampAcc.box(-S.bridgeWingX - 0.04, -24.75, 15.05, 0.10, 0.18, 0.22, pal.navRed, pal.navRed);
  // Starboard GREEN sidelight (right bridge wingtip)
  lampAcc.box(+S.bridgeWingX + 0.04, -24.75, 15.05, 0.10, 0.18, 0.22, pal.navGreen, pal.navGreen);
  // Forward masthead WHITE light (forecastle jackstaff)
  lampAcc.cylinder(0, 37.20, 8.95, 0.12, 0.26, 8, pal.navWhite, "z");
  // Aft main masthead WHITE light (compass mast top)
  lampAcc.cylinder(0, -26.40, 22.35, 0.14, 0.28, 8, pal.navWhite, "z");
  // Stern WHITE light
  lampAcc.box(0, -39.04, 4.10, 0.22, 0.08, 0.18, pal.navWhite, pal.navWhite);
  // Forward bridge brow working floodlight lenses (emissive only, 0 THREE.Light)
  for (const fx of [-3.6, -1.8, +1.8, +3.6]) {
    lampAcc.box(fx, -22.42, 16.22, 0.26, 0.06, 0.12, pal.deckFloodAmber, pal.deckFloodAmber);
  }

  const lampsMat = makeLampsMaterial(t, { emissiveIntensity: 1.15, roughness: 0.22 });
  lampsMat.userData.__vfxSetKey = "shipNavLamps";
  if (csmState) installCsmShaderPatch(lampsMat, csmState);
  lampsMat.castShadow = false;
  lampsMat.receiveShadow = false;
  const lampsMesh = new t.Mesh(lampAcc.toBufferGeometry(t), lampsMat);
  lampsMesh.name = "ship-nav-lights";
  root.add(lampsMesh);

  // =========================================================================
  // DC 11: Rotating 4-Blade Controllable-Pitch Bronze Propeller
  // =========================================================================
  const propellerPivot = new t.Group();
  propellerPivot.name = "ship-propeller-pivot";
  propellerPivot.position.set(0, S.propellerY, S.propellerZ);
  root.add(propellerPivot);

  const propAcc = new GeomAcc(3);
  propAcc.cone(0, -0.25, 0, 0.34, 0.12, 0.72, 12, pal.bronze, "y", true, true, cShade(pal.bronze, 0.78));
  const bladeR = S.propellerRadiusM;
  for (let b = 0; b < 4; b++) {
    const a = (b / 4) * TWO_PI;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const xf = ([x, y, z]) => [
      x * ca - z * sa,
      y + x * 0.28, // pitched hydrofoil twist
      x * sa + z * ca,
    ];
    propAcc.bevelBox(bladeR * 0.54, 0, 0, bladeR * 0.46, 0.055, 0.28, 0.04, pal.bronze, cShade(pal.bronze, 0.8), xf);
  }
  const propMat = makeDeployablePbrMaterial(t, { roughness: 0.30, metalness: 0.82, csmState });
  const propellerMesh = new t.Mesh(propAcc.toBufferGeometry(t), propMat);
  propellerMesh.name = "ship-propeller";
  propellerMesh.castShadow = true;
  propellerMesh.receiveShadow = true;
  propellerPivot.add(propellerMesh);

  // =========================================================================
  // DC 12: Articulated Flap Rudder (±35° around Z)
  // =========================================================================
  const rudderPivot = new t.Group();
  rudderPivot.name = "ship-rudder-pivot";
  rudderPivot.position.set(0, S.rudderY, S.rudderZ);
  root.add(rudderPivot);

  const rudAcc = new GeomAcc(3);
  // Rudder stock shaft + streamlined NACA-like hydrofoil blade extending aft from pivot
  rudAcc.cylinder(0, 0, 1.35, 0.16, 1.80, 10, pal.steelDark, "z");
  rudAcc.bevelBox(0, -0.75, -0.10, 0.22, 0.92, 1.45, 0.10, pal.antiFoulRed, pal.antiFoulDark);
  const rudMat = makeDeployablePbrMaterial(t, { roughness: 0.50, metalness: 0.35, csmState });
  const rudderMesh = new t.Mesh(rudAcc.toBufferGeometry(t), rudMat);
  rudderMesh.name = "ship-rudder";
  rudderMesh.castShadow = true;
  rudderMesh.receiveShadow = true;
  rudderPivot.add(rudderMesh);

  // =========================================================================
  // DC 13: Dynamic Mooring Hawser Lines (single InstancedMesh, count=0 when unmoored)
  // =========================================================================
  const hawserAcc = new GeomAcc(3);
  // Unit cylinder along +Z of length 1.0 m (z in [0, 1]) and radius 0.055 m (110 mm braided hawser)
  hawserAcc.cylinder(0, 0, 0.5, 0.055, 1.0, 6, pal.hawserTan, "z", true, true, cShade(pal.hawserTan, 0.85));
  const hawserGeom = hawserAcc.toBufferGeometry(t);
  const hawserMat = makeDeployablePbrMaterial(t, { roughness: 0.82, metalness: 0.05, csmState });
  const mooringLinesMesh = new t.InstancedMesh(hawserGeom, hawserMat, MAX_MOORING_LINES);
  mooringLinesMesh.name = "ship-mooring-hawsers";
  mooringLinesMesh.count = 0;
  mooringLinesMesh.frustumCulled = false;
  mooringLinesMesh.castShadow = false;
  mooringLinesMesh.receiveShadow = true;
  root.add(mooringLinesMesh);

  // =========================================================================
  // STOWED SHIPBOARD ISO CONTAINER POOL (6 Draw Calls <= 6 DC Budget!)
  //   3 livery-tinted corrugated body InstancedMeshes (20ft, 40ft, 40HC)
  //   3 non-tinted castings/locking-bars/decals trim InstancedMeshes (20ft, 40ft, 40HC)
  // =========================================================================
  const cargoGroup = new t.Group();
  cargoGroup.name = "ship-stowed-containers";
  root.add(cargoGroup);

  const containerBodyMat = makeDeployablePbrMaterial(t, { roughness: 0.72, metalness: 0.26, csmState });
  const containerTrimMat = makeDeployablePbrMaterial(t, { roughness: 0.58, metalness: 0.58, csmState });

  const containerPools = {};
  for (const [poolKey, wcid] of [["20ft", 4000020], ["40ft", 4000021], ["40hc", 4000022]]) {
    const spec = ISO_CONTAINERS[wcid];
    const { bodyGeom, trimGeom } = buildInstancedContainerGeoms(t, spec);

    const bodyInst = new t.InstancedMesh(bodyGeom, containerBodyMat, MAX_STOWED_PER_SIZE);
    bodyInst.name = `ship-containers-body-${poolKey}`;
    bodyInst.count = 0;
    bodyInst.frustumCulled = false;
    bodyInst.castShadow = true;
    bodyInst.receiveShadow = true;

    const trimInst = new t.InstancedMesh(trimGeom, containerTrimMat, MAX_STOWED_PER_SIZE);
    trimInst.name = `ship-containers-trim-${poolKey}`;
    trimInst.count = 0;
    trimInst.frustumCulled = false;
    trimInst.castShadow = true;
    trimInst.receiveShadow = true;

    cargoGroup.add(bodyInst, trimInst);
    containerPools[poolKey] = { bodyInst, trimInst, bodyGeom, trimGeom, count: 0 };
  }

  // Reusable zero-alloc scratch math objects for setContainers / setMooringLines
  const _mat4 = new t.Matrix4();
  const _invRoot = new t.Matrix4();
  const _pos = new t.Vector3();
  const _to = new t.Vector3();
  const _dir = new t.Vector3();
  const _quat = new t.Quaternion();
  const _euler = new t.Euler(0, 0, 0, "ZXY");
  const _scale = new t.Vector3(1, 1, 1);
  const _upZ = new t.Vector3(0, 0, 1);
  const _color = new t.Color();

  // Internal animated state
  let propSpinRad = 0.0;
  let radarSpinRad = 0.0;
  let rudderRad = 0.0;
  let activeContainerCount = 0;
  let activeMooringLineCount = 0;
  let disposed = false;

  function applyHatchOpen(bay, openFrac) {
    const rec = hatchCovers[bay];
    if (!rec) return;
    const f = clamp(fin(openFrac) ? openFrac : 0.0, 0.0, 1.0);
    rec.open = f;
    // Hinged hydraulic accordion lift: tilts cleanly forward +84° so open hold is fully clear for STS spreader!
    rec.pivot.rotation.x = f * 1.46;
    rec.pivot.position.z = S.coamingTopZ + f * 0.35;
  }

  function setHatchCover(bay, openFrac) {
    const b = Math.trunc(Number(bay));
    applyHatchOpen(b, openFrac);
  }

  /**
   * Update all articulated vessel parts: propeller, rudder, radar, hatch covers, and optional pose.
   */
  function update(state = {}) {
    if (disposed || !state || typeof state !== "object") return;
    const dt = fin(state.dt) ? clamp(state.dt, 0, 0.25) : 0;

    // Propeller rotation
    if (fin(state.propSpinRad)) {
      propSpinRad = state.propSpinRad % TWO_PI;
    } else if (dt > 0) {
      const thr = fin(state.throttle)
        ? state.throttle
        : (fin(state.eotNotch) ? state.eotNotch / 3.0 : (fin(state.eot) ? state.eot / 3.0 : 0));
      const spd = fin(state.surgeU) ? state.surgeU : (fin(state.surgeSpeed) ? state.surgeSpeed : 0);
      propSpinRad = (propSpinRad + (thr * 14.0 + spd * 1.2) * dt) % TWO_PI;
    }
    propellerPivot.rotation.y = propSpinRad;

    // Radar scanner rotation
    if (fin(state.radarSpinRad)) {
      radarSpinRad = state.radarSpinRad % TWO_PI;
    } else if (dt > 0) {
      radarSpinRad = (radarSpinRad + 1.8 * dt) % TWO_PI;
    }
    radarPivot.rotation.z = -radarSpinRad;

    // Articulated rudder (±35°)
    if (fin(state.rudderRad)) {
      rudderRad = clamp(state.rudderRad, -S.maxRudderRad, S.maxRudderRad);
    } else if (fin(state.rudderAngleRad)) {
      rudderRad = clamp(state.rudderAngleRad, -S.maxRudderRad, S.maxRudderRad);
    } else if (fin(state.rudder)) {
      rudderRad = clamp(state.rudder, -1, 1) * S.maxRudderRad;
    }
    // Positive rudder (starboard) swings trailing edge toward starboard (+X) => rotation.z = +rudderRad
    rudderPivot.rotation.z = rudderRad;

    // Hatch covers (supports { 2, 4, 6 } or { "02", "04", "06" })
    const hc = state.hatchCovers;
    if (hc && typeof hc === "object") {
      for (const b of [2, 4, 6]) {
        const keyPad = String(b).padStart(2, "0");
        const val = hc[b] !== undefined ? hc[b] : hc[keyPad];
        if (val !== undefined) {
          applyHatchOpen(b, typeof val === "boolean" ? (val ? 1.0 : 0.0) : val);
        }
      }
    }

    // Optional root pose sync if caller opts in
    if (state.applyRootPose === true && fin(state.x) && fin(state.y)) {
      root.position.set(state.x, state.y, fin(state.z) ? state.z : 0);
      root.rotation.set(
        fin(state.pitch) ? state.pitch : 0,
        fin(state.roll) ? state.roll : 0,
        -(fin(state.heading) ? state.heading : 0),
        "ZXY"
      );
    }
  }

  /**
   * Populate the internal instanced shipboard ISO container slot renderer (<= 6 DC).
   * Accepts Array<slot>, Map<brt, slot>, or cargoStore with .list().
   */
  function setContainers(slotsInput) {
    if (disposed) return 0;
    let list = [];
    if (Array.isArray(slotsInput)) list = slotsInput;
    else if (slotsInput instanceof Map) list = [...slotsInput.values()];
    else if (slotsInput && typeof slotsInput.list === "function") list = slotsInput.list();

    for (const pool of Object.values(containerPools)) {
      pool.count = 0;
    }

    let total = 0;
    for (let i = 0; i < list.length; i++) {
      const item = list[i];
      if (!item || typeof item !== "object") continue;

      const spec = resolvePortContainerSpec(item);
      const poolKey = spec.key === "40hc" ? "40hc" : (spec.sizeFt === 20 ? "20ft" : "40ft");
      const pool = containerPools[poolKey];
      if (!pool || pool.count >= MAX_STOWED_PER_SIZE) continue;

      let lx = item.localX ?? item.x;
      let ly = item.localY ?? item.y;
      let lz = item.localZ ?? item.z;
      if (!fin(lx) || !fin(ly) || !fin(lz)) {
        if (Number.isInteger(item.bay) && Number.isInteger(item.row) && Number.isInteger(item.tier)) {
          try {
            const p = computeShipSlotLocalPose(item.bay, item.row, item.tier, spec.wcid);
            lx = p.x;
            ly = p.y;
            lz = p.z;
          } catch (_) {
            continue;
          }
        } else {
          continue;
        }
      }

      const idx = pool.count++;
      _pos.set(lx, ly, lz);
      _quat.identity();
      if (fin(item.localHeading) && item.localHeading !== 0) {
        _quat.setFromAxisAngle(_upZ, -item.localHeading);
      }
      _scale.set(1, 1, 1);
      _mat4.compose(_pos, _quat, _scale);

      pool.bodyInst.setMatrixAt(idx, _mat4);
      pool.trimInst.setMatrixAt(idx, _mat4);
      _color.setHex(resolveLiveryHex(item));
      pool.bodyInst.setColorAt(idx, _color);
      total++;
    }

    for (const pool of Object.values(containerPools)) {
      pool.bodyInst.count = pool.count;
      pool.trimInst.count = pool.count;
      pool.bodyInst.instanceMatrix.needsUpdate = true;
      pool.trimInst.instanceMatrix.needsUpdate = true;
      if (pool.bodyInst.instanceColor) pool.bodyInst.instanceColor.needsUpdate = true;
    }

    activeContainerCount = total;
    return total;
  }

  /**
   * Render dynamic tensioned mooring hawser lines from vessel bitts to quay bollards.
   * Accepts world-space endpoints `{ from:[x,y,z], to:[x,y,z], tension }` (default from ship_kinematics.computeMooringLines)
   * or ship-local endpoints when `line.local === true`.
   */
  function setMooringLines(lines = [], shipPose = null) {
    if (disposed) return 0;
    const arr = Array.isArray(lines) ? lines : [];
    if (arr.length === 0) {
      mooringLinesMesh.count = 0;
      activeMooringLineCount = 0;
      return 0;
    }

    // Compute inverse transform from world -> ship-local
    if (shipPose && fin(shipPose.x) && fin(shipPose.y)) {
      _pos.set(shipPose.x, shipPose.y, fin(shipPose.z) ? shipPose.z : 0);
      _euler.set(
        fin(shipPose.pitch) ? shipPose.pitch : 0,
        fin(shipPose.roll) ? shipPose.roll : 0,
        -(fin(shipPose.heading) ? shipPose.heading : 0),
        "ZXY"
      );
      _quat.setFromEuler(_euler);
      _scale.set(1, 1, 1);
      _invRoot.compose(_pos, _quat, _scale).invert();
    } else {
      root.updateMatrixWorld(true);
      _invRoot.copy(root.matrixWorld).invert();
    }

    let count = 0;
    for (let i = 0; i < arr.length && count < MAX_MOORING_LINES; i++) {
      const ln = arr[i];
      if (!ln || !Array.isArray(ln.from) || !Array.isArray(ln.to)) continue;
      const tension = fin(ln.tension) ? clamp(ln.tension, 0, 1) : 1.0;
      if (tension <= 0.01) continue;

      _pos.set(ln.from[0], ln.from[1], ln.from[2]);
      _to.set(ln.to[0], ln.to[1], ln.to[2]);
      if (!ln.local) {
        _pos.applyMatrix4(_invRoot);
        _to.applyMatrix4(_invRoot);
      }

      _dir.subVectors(_to, _pos);
      const len = _dir.length();
      if (!(len > 0.05)) continue;
      _dir.divideScalar(len);

      _quat.setFromUnitVectors(_upZ, _dir);
      const thickness = 0.85 + tension * 0.35;
      _scale.set(thickness, thickness, len);
      _mat4.compose(_pos, _quat, _scale);
      mooringLinesMesh.setMatrixAt(count, _mat4);
      count++;
    }

    mooringLinesMesh.count = count;
    mooringLinesMesh.instanceMatrix.needsUpdate = true;
    activeMooringLineCount = count;
    return count;
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    const seenG = new Set();
    const seenM = new Set();
    root.traverse((o) => {
      if (o.geometry && !seenG.has(o.geometry)) {
        seenG.add(o.geometry);
        o.geometry.dispose();
      }
      if (o.material) {
        const list = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of list) {
          if (m && !seenM.has(m)) {
            seenM.add(m);
            m.dispose();
          }
        }
      }
    });
  }

  return {
    root,
    cargoGroup,
    propellerPivot,
    rudderPivot,
    radarPivot,
    hatchCovers,
    mooringLinesMesh,
    containerPools,
    lampsMat,
    spec: S,
    wcid: PORT_WCID.ContainerShipFeeder,
    maxDrawCalls: S.maxDrawCalls,
    stowedPoolMaxDrawCalls: S.stowedPoolMaxDrawCalls,
    get propSpinRad() { return propSpinRad; },
    get radarSpinRad() { return radarSpinRad; },
    get rudderRad() { return rudderRad; },
    get activeContainerCount() { return activeContainerCount; },
    get activeMooringLineCount() { return activeMooringLineCount; },
    get disposed() { return disposed; },
    update,
    setHatchCover,
    setContainers,
    setMooringLines,
    dispose,
  };
}
