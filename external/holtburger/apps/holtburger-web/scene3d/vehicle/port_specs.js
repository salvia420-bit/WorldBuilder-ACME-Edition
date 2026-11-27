/**
 * Pure zero-import deterministic specifications, Site A waterfront coordinates,
 * ISO 668 / 1161 / 3874 / 6346 / 6780 / 9711 dimensional tables & validators,
 * quay/ramp elevation profiles, exact terrain.js waterSwellAt parity, and
 * full container terminal + coastal feeder vessel layout builders.
 *
 * 1:1 parity contract for future ACE C# promotion (HBV1 v7 wire-compatible).
 * ZERO external imports.
 */

const TAU = Math.PI * 2.0;
const RAD_PER_DEG = Math.PI / 180.0;

// ---------------------------------------------------------------------------
// 1. Clean Reserved WCIDs, Deployable Kinds & Local Synthetic GUID Bases
//    (Disjoint from 4000001..4000045 and 0x76..0x78 harness blocks)
// ---------------------------------------------------------------------------

export const PORT_WCID = Object.freeze({
  ContainerShipFeeder: 4000050,
  StsGantryCrane: 4000051,
  RmgYardCrane: 4000052,
  RtgYardCrane: 4000053,
  TerminalTractorShuttle: 4000054,
  ReeferRackBay: 4000055,
  QuayBollard: 4000056,
  MarineFender: 4000057,
});

export const PORT_DEPLOYABLE_KIND = Object.freeze({
  StsGantryCrane: 23,
  RmgYardCrane: 24,
  RtgYardCrane: 25,
  TerminalTractorShuttle: 26,
  ReeferRackBay: 27,
  QuayBollard: 28,
  MarineFender: 29,
});

export const PORT_VEHICLE_CLASS = Object.freeze({
  ContainerShipFeeder: 4,
});

export const PORT_LOCOMOTION = Object.freeze({
  Marine: 3,
});

export const PORT_GUID_BASE = Object.freeze({
  entities: 0x79000001,
  handoffContainers: 0x79100001,
  ships: 0x79200001,
});

// ---------------------------------------------------------------------------
// 2. Site A Waterfront Coordinates (NE Flatland North Coast, 0xE8F8..0xEBF9)
//    Quay runs strictly East-West (bearing 090/270), Deep Sea North (+Y),
//    Untouched Automated Warehouse immediately South at z = 0.0 m.
// ---------------------------------------------------------------------------

export const PORT_ORIGIN = Object.freeze([44960.0, 47880.0, 0.0]);
export const WAREHOUSE_PORT_ORIGIN = Object.freeze([44960.0, 47625.0, 0.0]);

export const PORT_SITE = Object.freeze({
  name: "NE Flatland North Coast Marine Terminal (Site A)",
  landblocks: Object.freeze(["0xE8F8", "0xE9F8", "0xEAF8", "0xEBF8", "0xE8F9", "0xE9F9", "0xEAF9", "0xEBF9"]),
  teleYardCmd: "@tele 96.80N 85.33E",
  teleQuayCmd: "@tele 97.20N 85.33E",
  origin: PORT_ORIGIN,
  warehouseOrigin: WAREHOUSE_PORT_ORIGIN,
  // Terminal E-W footprint (400 m wide; clear of eastern inlet at X >= 45312)
  xMin: 44780.0,
  xMax: 45180.0,
  widthM: 400.0,
  localMinX: -180.0,
  localMaxX: +220.0,
  // N-S cross-section (South -> North)
  warehouseMinY: 47580.0,
  warehouseMaxY: 47670.0,
  corridorMinY: 47670.0,
  corridorMaxY: 47698.0,
  yardMinY: 47670.0,
  yardMaxY: 47810.0,
  rampMinY: 47810.0,
  rampMaxY: 47834.0,
  rampLengthM: 24.0,
  quayApronMinY: 47834.0,
  quayApronMaxY: 47880.0,
  quayApronDepthM: 46.0,
  quayY: 47880.0,
  fenderDepthM: 1.2,
  fenderFaceY: 47881.2,
  // Elevations
  groundZ: 0.0,
  yardVisualZ: 0.004,
  quayDeckZ: 2.0,
  seawallBottomZ: -2.5,
  rampSlopeRad: Math.atan2(2.0, 24.0), // ~4.7636 deg (cos = 0.9965 > 0.9945)
  // Water & chart bathymetry (AC terrain code 20 = WaterDeepSea at z = 0.0)
  waterLevelZ: 0.0,
  waterMaxSwellM: 0.25,
  waterDeepCode: 20,
  waterShallowCodes: Object.freeze([18, 19]),
  berthPocketDepthM: 14.0,
  fairwayDepthM: 25.0,
  // Dereth safe near-ring bounds
  bodyEdgeMin: 193.0,
  bodyEdgeMax: 48767.0,
  seaBasinMinX: 44680.0,
  seaBasinMaxX: 45280.0,
  seaBasinMaxY: 48680.0,
});

// Exact Zone A drop pads of the IMMUTABLE Automated Warehouse at WAREHOUSE_PORT_ORIGIN
export const WAREHOUSE_DROP_PADS = Object.freeze({
  C1: Object.freeze({
    id: "C1",
    containerKind: "40ft",
    wcid: 4000021,
    kind: 11,
    pos: Object.freeze([WAREHOUSE_PORT_ORIGIN[0] - 40.0, WAREHOUSE_PORT_ORIGIN[1] + 32.5, 0.0]),
    heading: 0.0,
  }),
  C2: Object.freeze({
    id: "C2",
    containerKind: "40HC",
    wcid: 4000022,
    kind: 12,
    pos: Object.freeze([WAREHOUSE_PORT_ORIGIN[0] - 24.0, WAREHOUSE_PORT_ORIGIN[1] + 32.5, 0.0]),
    heading: 0.0,
  }),
  C3: Object.freeze({
    id: "C3",
    containerKind: "20ft",
    wcid: 4000020,
    kind: 10,
    pos: Object.freeze([WAREHOUSE_PORT_ORIGIN[0] - 8.0, WAREHOUSE_PORT_ORIGIN[1] + 29.43, 0.0]),
    heading: 0.0,
  }),
});

// ---------------------------------------------------------------------------
// 3. Exact ISO 668 / 1161 / 1496-1 / 6346 / 6780 Container & Pallet Specs
//    Mirrors container_models.js & warehouse_specs.js verbatim (0 imports).
// ---------------------------------------------------------------------------

export const PORT_CONTAINER_WCID = Object.freeze({
  IsoContainer20: 4000020,
  IsoContainer40: 4000021,
  IsoContainer40HC: 4000022,
});

export const ISO_CONTAINERS = Object.freeze({
  4000020: Object.freeze({
    wcid: 4000020,
    kind: 10,
    key: "20ft",
    sizeFt: 20,
    teu: 1,
    isoGroup: "22G1",
    isoType: "1CC",
    extW: 2.438,
    extL: 6.058,
    extH: 2.591,
    intW: 2.352,
    intL: 5.898,
    intH: 2.393,
    doorW: 2.340,
    doorH: 2.280,
    floorZ: 0.162,
    roofZ: 2.591,
    rampLen: 0.850,
    castingSpanX: 2.259,
    castingSpanY: 5.853,
    twistlockHalfX: 1.1295,
    twistlockHalfY: 2.9265,
    palletSlots: 10,
    tareTonnes: 2.25,
    maxGrossTonnes: 30.48,
  }),
  4000021: Object.freeze({
    wcid: 4000021,
    kind: 11,
    key: "40ft",
    sizeFt: 40,
    teu: 2,
    isoGroup: "42G1",
    isoType: "1AA",
    extW: 2.438,
    extL: 12.192,
    extH: 2.591,
    intW: 2.352,
    intL: 12.032,
    intH: 2.393,
    doorW: 2.340,
    doorH: 2.280,
    floorZ: 0.162,
    roofZ: 2.591,
    rampLen: 0.850,
    castingSpanX: 2.259,
    castingSpanY: 11.985,
    twistlockHalfX: 1.1295,
    twistlockHalfY: 5.9925,
    palletSlots: 20,
    tareTonnes: 3.75,
    maxGrossTonnes: 32.5,
  }),
  4000022: Object.freeze({
    wcid: 4000022,
    kind: 12,
    key: "40hc",
    sizeFt: 40,
    teu: 2,
    isoGroup: "45G1",
    isoType: "1AAA",
    extW: 2.438,
    extL: 12.192,
    extH: 2.896,
    intW: 2.352,
    intL: 12.032,
    intH: 2.698,
    doorW: 2.340,
    doorH: 2.585,
    floorZ: 0.162,
    roofZ: 2.896,
    rampLen: 0.850,
    castingSpanX: 2.259,
    castingSpanY: 11.985,
    twistlockHalfX: 1.1295,
    twistlockHalfY: 5.9925,
    palletSlots: 20,
    tareTonnes: 3.95,
    maxGrossTonnes: 32.5,
  }),
});

export const PORT_CONTAINER_LIVERIES = Object.freeze({
  maritimeBlue: Object.freeze({ id: 0, key: "maritimeBlue", name: "Maritime Blue", hex: 0x0f385e, rgb: Object.freeze([15, 56, 94]) }),
  cortenRed: Object.freeze({ id: 1, key: "cortenRed", name: "Corten Oxide Red", hex: 0x853826, rgb: Object.freeze([133, 56, 38]) }),
  evergreen: Object.freeze({ id: 2, key: "evergreen", name: "Evergreen", hex: 0x1a472a, rgb: Object.freeze([26, 71, 42]) }),
  oliveDrab: Object.freeze({ id: 3, key: "oliveDrab", name: "Olive Drab", hex: 0x4b5320, rgb: Object.freeze([75, 83, 32]) }),
  desertTan: Object.freeze({ id: 4, key: "desertTan", name: "Desert Tan", hex: 0xc2b280, rgb: Object.freeze([194, 178, 128]) }),
  industrialAmber: Object.freeze({ id: 5, key: "industrialAmber", name: "Industrial Amber", hex: 0xb87333, rgb: Object.freeze([184, 115, 51]) }),
});

export const PORT_LIVERY_KEYS = Object.freeze([
  "maritimeBlue",
  "cortenRed",
  "evergreen",
  "oliveDrab",
  "desertTan",
  "industrialAmber",
]);

export const PORT_PALLET_SPECS = Object.freeze({
  width: 1.100,
  depth: 1.100,
  height: 0.145,
  deckUndersideZ: 0.123,
  deckZOffset: 0.307,
  stowedMaxHeightM: 2.050,
  cargoWcids: Object.freeze([
    4000002, 4000010, 4000011, 4000012, 4000013, 4000014, 4000015, 4000016, 4000017,
  ]),
});

export function resolvePortContainerSpec(kindOrWcid) {
  if (kindOrWcid && typeof kindOrWcid === "object") {
    return resolvePortContainerSpec(kindOrWcid.wcid ?? kindOrWcid.kind ?? kindOrWcid.containerKind ?? kindOrWcid.sizeFt);
  }
  if (kindOrWcid === 4000020 || kindOrWcid === 10 || kindOrWcid === 20) return ISO_CONTAINERS[4000020];
  if (kindOrWcid === 4000021 || kindOrWcid === 11 || kindOrWcid === 40) return ISO_CONTAINERS[4000021];
  if (kindOrWcid === 4000022 || kindOrWcid === 12) return ISO_CONTAINERS[4000022];
  if (typeof kindOrWcid === "string") {
    const s = kindOrWcid.trim().toLowerCase();
    if (s === "20" || s === "20ft" || s === "1cc" || s === "22g1" || s === "isocontainer20") return ISO_CONTAINERS[4000020];
    if (s === "40hc" || s === "40ft-hc" || s === "40fthc" || s === "1aaa" || s === "45g1" || s === "isocontainer40hc") return ISO_CONTAINERS[4000022];
    if (s === "40" || s === "40ft" || s === "1aa" || s === "42g1" || s === "isocontainer40") return ISO_CONTAINERS[4000021];
  }
  return ISO_CONTAINERS[4000021];
}

const ISO6346_LETTER_VALS = Object.freeze({
  A: 10, B: 12, C: 13, D: 14, E: 15, F: 16, G: 17, H: 18, I: 19, J: 20,
  K: 21, L: 23, M: 24, N: 25, O: 26, P: 27, Q: 28, R: 29, S: 30, T: 31,
  U: 32, V: 34, W: 35, X: 36, Y: 37, Z: 38,
});

export function formatIso6346Bic(serialInt = 100001, owner = "HLTB", category = "U") {
  const pref = (String(owner || "HLTB").toUpperCase().replace(/[^A-Z]/g, "") + "HLTB").slice(0, 3);
  const cat = (String(category || "U").toUpperCase().replace(/[^A-Z]/g, "") || "U")[0];
  const num = String(Math.abs(Math.trunc(Number.isFinite(serialInt) ? serialInt : 100001)) % 1000000).padStart(6, "0");
  const code10 = pref + cat + num;
  let sum = 0;
  for (let i = 0; i < 10; i++) {
    const ch = code10[i];
    const v = ch >= "0" && ch <= "9" ? parseInt(ch, 10) : (ISO6346_LETTER_VALS[ch] ?? 10);
    sum += v * (1 << i);
  }
  const check = (sum % 11) % 10;
  return `${pref} ${cat} ${num}-${check}`;
}

// ---------------------------------------------------------------------------
// 4. Coordinate Transforms, Quay Ramp Profile & Exact terrain.js Water Swell
// ---------------------------------------------------------------------------

export function headingForward(h) {
  const a = Number.isFinite(h) ? h : 0.0;
  return [Math.sin(a), Math.cos(a)];
}

export function headingRight(h) {
  const a = Number.isFinite(h) ? h : 0.0;
  return [Math.cos(a), -Math.sin(a)];
}

export function localToWorld2D(lx, ly, originX = 0.0, originY = 0.0, heading = 0.0) {
  const a = Number.isFinite(heading) ? heading : 0.0;
  const s = Math.sin(a);
  const c = Math.cos(a);
  return [originX + lx * c + ly * s, originY - lx * s + ly * c];
}

export function worldToLocal2D(wx, wy, originX = 0.0, originY = 0.0, heading = 0.0) {
  const a = Number.isFinite(heading) ? heading : 0.0;
  const dx = wx - originX;
  const dy = wy - originY;
  const s = Math.sin(a);
  const c = Math.cos(a);
  return [dx * c - dy * s, dx * s + dy * c];
}

/**
 * Engineered terminal ground/deck elevation at world Y (relative to origin[1] = quayY).
 *  - Yard & Warehouse (y <= rampMinY): oz + 0.0 m
 *  - Approach Ramp (rampMinY < y < rampMaxY): smooth linear 0.0 -> +2.0 m (4.76 deg)
 *  - Quay Apron (rampMaxY <= y <= quayY): oz + 2.0 m
 *  - Water (y > quayY): 0.0 m
 */
export function quayRampZ(wy, origin = PORT_ORIGIN) {
  const oy = Array.isArray(origin) && Number.isFinite(origin[1]) ? origin[1] : PORT_ORIGIN[1];
  const oz = Array.isArray(origin) && Number.isFinite(origin[2]) ? origin[2] : PORT_ORIGIN[2];
  const dyFromQuay = wy - oy; // 0 at quay coping, -46 at ramp top, -70 at ramp foot
  if (dyFromQuay > 0.0) return PORT_SITE.waterLevelZ;
  if (dyFromQuay >= -PORT_SITE.quayApronDepthM) return oz + PORT_SITE.quayDeckZ;
  const rampFootOffset = -(PORT_SITE.quayApronDepthM + PORT_SITE.rampLengthM); // -70.0
  if (dyFromQuay <= rampFootOffset) return oz;
  const t = (dyFromQuay - rampFootOffset) / PORT_SITE.rampLengthM;
  return oz + PORT_SITE.quayDeckZ * t;
}

/**
 * Signed pitch angle (rad, positive = nose up) for a vehicle at world Y moving on compass `heading`.
 */
export function quayRampPitch(wy, heading = 0.0, origin = PORT_ORIGIN) {
  const oy = Array.isArray(origin) && Number.isFinite(origin[1]) ? origin[1] : PORT_ORIGIN[1];
  const dyFromQuay = wy - oy;
  const rampTop = -PORT_SITE.quayApronDepthM; // -46.0
  const rampFoot = rampTop - PORT_SITE.rampLengthM; // -70.0
  if (dyFromQuay <= rampFoot || dyFromQuay >= rampTop) return 0.0;
  const h = Number.isFinite(heading) ? heading : 0.0;
  return Math.atan(Math.tan(PORT_SITE.rampSlopeRad) * Math.cos(h));
}

/**
 * Exact continuous water swell formula matching `scene3d/terrain.js:1604` (`waterSwellAt`).
 * Envelope: +-0.25 m (wavelengths ~140 m E-W and ~101 m N-S).
 */
export function waterSwellAt(x, y, t = 0.0) {
  const wx = Number.isFinite(x) ? x : 0.0;
  const wy = Number.isFinite(y) ? y : 0.0;
  const ts = Number.isFinite(t) ? t : 0.0;
  return Math.sin(ts * 0.5 + wx * 0.045) * 0.15 + Math.sin(ts * 0.7 + wy * 0.062) * 0.10;
}

/**
 * Exact 24 m bilinear lattice-locked swell matching `scene3d/terrain.js:1616` (`waterSwellLattice`).
 */
export function waterSwellLattice(x, y, t = 0.0) {
  const wx = Number.isFinite(x) ? x : 0.0;
  const wy = Number.isFinite(y) ? y : 0.0;
  const ts = Number.isFinite(t) ? t : 0.0;
  const c0x = Math.floor(wx / 24.0) * 24.0;
  const c0y = Math.floor(wy / 24.0) * 24.0;
  const fx = (wx - c0x) / 24.0;
  const fy = (wy - c0y) / 24.0;
  const s00 = waterSwellAt(c0x, c0y, ts);
  const s10 = waterSwellAt(c0x + 24.0, c0y, ts);
  const s01 = waterSwellAt(c0x, c0y + 24.0, ts);
  const s11 = waterSwellAt(c0x + 24.0, c0y + 24.0, ts);
  const s0 = s00 + (s10 - s00) * fx;
  const s1 = s01 + (s11 - s01) * fx;
  return s0 + (s1 - s0) * fy;
}

/**
 * Signed distance from the quay / shoreline north boundary (positive = open water North of quay face).
 * Accounts for the 400 m engineered quay wall protruding to `quayY` + natural shoreline South of `quayY - 48`.
 */
export function quayWallSdf(wx, wy, origin = PORT_ORIGIN) {
  const ox = Array.isArray(origin) && Number.isFinite(origin[0]) ? origin[0] : PORT_ORIGIN[0];
  const oy = Array.isArray(origin) && Number.isFinite(origin[1]) ? origin[1] : PORT_ORIGIN[1];
  const qMinX = ox + PORT_SITE.localMinX; // 44780
  const qMaxX = ox + PORT_SITE.localMaxX; // 45180
  const shorelineY = oy - 48.0; // 47832 dry shore outside quay width

  // Distance to the quay box [qMinX, qMaxX] x [-inf, oy]
  const dxBox = wx < qMinX ? qMinX - wx : (wx > qMaxX ? wx - qMaxX : 0.0);
  const dyQuay = wy - oy;
  const dQuay = dyQuay >= 0.0
    ? (dxBox > 0.0 ? Math.hypot(dxBox, dyQuay) : dyQuay)
    : (dxBox > 0.0 ? dxBox : dyQuay);

  // Distance to natural land south of shorelineY
  const dShore = wy - shorelineY;

  return Math.min(dQuay, dShore);
}

/**
 * Synthetic nautical chart depth (m) for UKC telemetry & grounding checks.
 * AC DATs have z = 0 for all ocean; deep sea is identified by terrain code 20 + offshore SDF.
 */
export function estimateChartDepthM(wx, wy, terrainCode = 20, origin = PORT_ORIGIN) {
  const sdf = quayWallSdf(wx, wy, origin);
  if (sdf <= 0.0) return 0.0;
  if (terrainCode !== undefined && terrainCode !== null && terrainCode !== 20 && terrainCode !== 18 && terrainCode !== 19) {
    return 0.0;
  }
  const shallowMul = (terrainCode === 18 || terrainCode === 19) ? 0.55 : 1.0;
  const t = Math.max(0.0, Math.min(1.0, (sdf - 12.0) / 140.0));
  const depth = PORT_SITE.berthPocketDepthM + (PORT_SITE.fairwayDepthM - PORT_SITE.berthPocketDepthM) * t;
  return depth * shallowMul;
}

// ---------------------------------------------------------------------------
// 5. Quay Infrastructure, Berths, Waypoints, Cranes, Yard Blocks & Shuttles
// ---------------------------------------------------------------------------

export const QUAY_SPECS = Object.freeze({
  lengthM: 400.0,
  apronDepthM: 46.0,
  deckZ: 2.0,
  seawallBottomZ: -2.5,
  rampLengthM: 24.0,
  // STS crane rails (local Y relative to quayY = 47880.0)
  stsWatersideRailLocalY: -4.5, // Y = 47875.5
  stsLandsideRailLocalY: -24.5, // Y = 47855.5
  stsRailGaugeM: 20.0,
  // 4 under-portal truck transfer lanes (local Y relative to quayY)
  portalLaneLocalYs: Object.freeze([-9.0, -13.0, -17.0, -21.0]), // Y = 47871, 47867, 47863, 47859
  // Backreach hatch-cover buffer pads (local Y = -34.0 -> Y = 47846.0)
  hatchBufferLocalY: -34.0,
  // Mooring bollards (17x @ 24 m spacing, set 1.2 m behind coping)
  bollardLocalY: -1.2, // Y = 47878.8
  bollardSpacingM: 24.0,
  bollardCount: 17,
  bollardFirstLocalX: -172.0, // X = 44788..45172
  // Marine cone/arch fenders (25x @ 16 m spacing along seaward wall face)
  fenderLocalY: 0.0,
  fenderDepthM: 1.2,
  fenderSpacingM: 16.0,
  fenderCount: 25,
  fenderFirstLocalX: -172.0, // X = 44788..45172
  // High-mast port floodlight towers (emissive lamps only, 0 dynamic lights)
  lightTowerHeightM: 28.0,
  maxDrawCalls: 16,
});

export const SHIP_SPECS = Object.freeze({
  wcid: PORT_WCID.ContainerShipFeeder,
  vehicleClass: PORT_VEHICLE_CLASS.ContainerShipFeeder,
  locomotion: PORT_LOCOMOTION.Marine,
  vesselClassName: "HLTB-FC-120 Coastal Cellular Feeder",
  defaultName: "M/V Dereth Feeder",
  maxDrawCalls: 18,
  stowedPoolMaxDrawCalls: 6,
  // Principal hull dimensions (ship-local: +Y bow, -Y stern, +X starboard, -X port, +Z up from waterline)
  loaM: 78.0,
  halfLoaM: 39.0,
  lbpM: 73.0,
  beamM: 14.4,
  halfBeamM: 7.2,
  mouldedDepthM: 7.2,
  draftM: 3.80,
  freeboardM: 3.40,
  keelZ: -3.80,
  bootTopMinZ: -0.35,
  bootTopMaxZ: 0.45,
  mainDeckZ: 3.40,
  // Hold floor sits at z = +0.45 m (> 0.25 m max ocean swell) so AC's opaque z=0 ocean NEVER clips open holds!
  holdTankTopZ: 0.45,
  coamingTopZ: 3.60,
  hatchDeckZ: 3.95,
  lashingBridgeTopZ: 6.65,
  forecastleMinY: 27.0,
  forecastleMaxY: 39.0,
  forecastleZ: 5.20,
  bulbousBowTipY: 40.2,
  // Aft accommodation superstructure & bridge wings
  superstructureMinY: -36.0,
  superstructureMaxY: -22.0,
  bridgeDeckZ: 14.0,
  bridgeEyeZ: 15.6,
  bridgeY: -25.5,
  bridgeWingX: 7.20,
  bridgeTopZ: 16.4,
  funnelY: -31.5,
  funnelTopZ: 19.5,
  radarMastTopZ: 22.5,
  airDraftM: 22.5,
  // Propulsion & maneuvering actuators
  propellerY: -35.8,
  propellerZ: -2.2,
  propellerRadiusM: 1.45,
  rudderY: -36.8,
  rudderZ: -2.1,
  maxRudderRad: 35.0 * RAD_PER_DEG,
  rudderRateRadSec: 18.0 * RAD_PER_DEG,
  bowThrusterY: 31.0,
  bowThrusterZ: -1.6,
  sternThrusterY: -31.0,
  sternThrusterZ: -1.8,
  // Hydrodynamics (30 Hz deterministic model — responsive coastal feeder feel)
  simHz: 30,
  massTonnes: 2600.0,
  massKg: 950000.0,
  yawInertiaKgM2: 1.8e8,
  maxAheadThrustN: 520000.0,
  maxAsternThrustN: 360000.0,
  bowThrusterMaxN: 270000.0,
  sternThrusterMaxN: 270000.0,
  maxSpeedMps: 6.2,       // ~12.05 knots realistic coastal feeder service speed
  demoMaxSpeedMps: 9.0,   // ~17.5 knots optional fast demo cruise
  maxReverseMps: -3.2,
  maxSwayMps: 1.8,
  maxYawRateRadSec: 0.24,
  surgeQuadDrag: 11800.0,
  surgeLinDrag: 10000.0,
  swayQuadDrag: 110000.0,
  swayLinDrag: 90000.0,
  yawQuadDrag: 2.0e8,
  yawLinDrag: 9.5e7,
  rudderLiftCoeff: 22000.0,
  propWashKickN: 160000.0,
  minUkcWarningM: 2.0,
  // Mooring chock positions (ship-local [x, y, z] for both starboard +X and port -X sides)
  mooringBitts: Object.freeze({
    starboard: Object.freeze([
      Object.freeze({ id: "head", pos: Object.freeze([5.2, 34.0, 5.25]) }),
      Object.freeze({ id: "fwdBreast", pos: Object.freeze([6.8, 25.0, 3.60]) }),
      Object.freeze({ id: "fwdSpring", pos: Object.freeze([7.0, 12.0, 3.60]) }),
      Object.freeze({ id: "aftSpring", pos: Object.freeze([7.0, -12.0, 3.60]) }),
      Object.freeze({ id: "aftBreast", pos: Object.freeze([6.8, -25.0, 3.60]) }),
      Object.freeze({ id: "stern", pos: Object.freeze([5.4, -35.5, 3.60]) }),
    ]),
    port: Object.freeze([
      Object.freeze({ id: "head", pos: Object.freeze([-5.2, 34.0, 5.25]) }),
      Object.freeze({ id: "fwdBreast", pos: Object.freeze([-6.8, 25.0, 3.60]) }),
      Object.freeze({ id: "fwdSpring", pos: Object.freeze([-7.0, 12.0, 3.60]) }),
      Object.freeze({ id: "aftSpring", pos: Object.freeze([-7.0, -12.0, 3.60]) }),
      Object.freeze({ id: "aftBreast", pos: Object.freeze([-6.8, -25.0, 3.60]) }),
      Object.freeze({ id: "stern", pos: Object.freeze([-5.4, -35.5, 3.60]) }),
    ]),
  }),
  // Camera anchor offsets (ship-local [x, y, z])
  cameraAnchors: Object.freeze({
    chase: Object.freeze({ back: 62.0, up: 22.0, lookAhead: 12.0, fov: 62 }),
    bridge: Object.freeze({ x: 0.0, y: -24.2, z: 15.6, fov: 72 }),
    wingStarboard: Object.freeze({ x: 7.0, y: -25.0, z: 15.2, fov: 68 }),
    wingPort: Object.freeze({ x: -7.0, y: -25.0, z: 15.2, fov: 68 }),
    overhead: Object.freeze({ up: 92.0, back: 10.0, fov: 56 }),
  }),
});

export const SHIP_EOT_NOTCHES = Object.freeze([
  Object.freeze({ notch: -3, code: "FA", label: "FULL ASTERN", throttle: -1.0 }),
  Object.freeze({ notch: -2, code: "HA", label: "HALF ASTERN", throttle: -0.5 }),
  Object.freeze({ notch: -1, code: "SA", label: "SLOW ASTERN", throttle: -0.25 }),
  Object.freeze({ notch: 0, code: "STOP", label: "ALL STOP", throttle: 0.0 }),
  Object.freeze({ notch: 1, code: "SAH", label: "SLOW AHEAD", throttle: 0.30 }),
  Object.freeze({ notch: 2, code: "HAH", label: "HALF AHEAD", throttle: 0.65 }),
  Object.freeze({ notch: 3, code: "FAH", label: "FULL AHEAD", throttle: 1.0 }),
]);

export const SHIP_CAMERA_MODES = Object.freeze(["chase", "bridge", "wing", "overhead"]);

// ISO 9711-1 Ship Bay / Row / Tier Definitions
export const SHIP_BAY_DEFS = Object.freeze({
  even40: Object.freeze([
    Object.freeze({ bay: 2, y: +16.40, oddPair: Object.freeze([1, 3]), holdLabel: "Hold 1 (Fwd)" }),
    Object.freeze({ bay: 4, y: +3.00, oddPair: Object.freeze([5, 7]), holdLabel: "Hold 2 (Mid)" }),
    Object.freeze({ bay: 6, y: -10.40, oddPair: Object.freeze([9, 11]), holdLabel: "Hold 3 (Aft/Reefer)", reeferPlugs: true }),
  ]),
  odd20: Object.freeze([
    Object.freeze({ bay: 1, parentEvenBay: 2, y: +16.40 + 3.15 }),
    Object.freeze({ bay: 3, parentEvenBay: 2, y: +16.40 - 3.15 }),
    Object.freeze({ bay: 5, parentEvenBay: 4, y: +3.00 + 3.15 }),
    Object.freeze({ bay: 7, parentEvenBay: 4, y: +3.00 - 3.15 }),
    Object.freeze({ bay: 9, parentEvenBay: 6, y: -10.40 + 3.15 }),
    Object.freeze({ bay: 11, parentEvenBay: 6, y: -10.40 - 3.15 }),
  ]),
});

// Even row count (4 rows): NO centerline 00; Starboard = odd (01, 03), Port = even (02, 04)
export const SHIP_ROW_DEFS = Object.freeze([
  Object.freeze({ row: 4, side: "port", x: -3.90 }),
  Object.freeze({ row: 2, side: "port", x: -1.30 }),
  Object.freeze({ row: 1, side: "starboard", x: +1.30 }),
  Object.freeze({ row: 3, side: "starboard", x: +3.90 }),
]);

export const SHIP_TIER_DEFS = Object.freeze({
  hold: Object.freeze([2]), // Under-deck hold tier 02 (tank-top z = +0.45 m, fits 2.591 m or 2.896 m under 3.60 m coaming)
  deck: Object.freeze([82, 84, 86, 88]), // On-deck tiers atop hatch cover (z = 3.95 m base)
});

// Berth clearance: fenderFaceY (47881.2) + halfBeam (7.20) + cushion (0.15) = 47888.55
export const BERTH_MOORED_OFFSET_Y = QUAY_SPECS.fenderDepthM + SHIP_SPECS.halfBeamM + 0.15; // +8.55 m north of quayY

export const BERTH_SPECS = Object.freeze({
  B1: Object.freeze({
    id: "B1",
    name: "Berth 1 (West Feeder Berth)",
    localX: -80.0, // world X = 44880.0
    localXMin: -170.0,
    localXMax: +10.0,
    lengthM: 180.0,
    center: Object.freeze([PORT_ORIGIN[0] - 80.0, PORT_ORIGIN[1] + BERTH_MOORED_OFFSET_Y, 0.0]),
    stagingPos: Object.freeze([PORT_ORIGIN[0] - 80.0, PORT_ORIGIN[1] + 60.0, 0.0]),
    // Heading +PI/2 = bow East, starboard side (+X ship = -Y world) against quay wall!
    // Heading -PI/2 (3*PI/2) = bow West, port side (-X ship = -Y world) against quay wall!
    defaultHeading: Math.PI * 0.5,
    alternateHeading: Math.PI * 1.5,
    primaryStsId: "STS-1",
    mooringTolerance: Object.freeze({
      maxLateralErrM: 3.0,
      maxLongErrM: 4.5,
      maxHeadingErrRad: 6.0 * RAD_PER_DEG,
      maxSpeedMps: 0.6,
    }),
  }),
  B2: Object.freeze({
    id: "B2",
    name: "Berth 2 (East Feeder Berth)",
    localX: +120.0, // world X = 45080.0
    localXMin: +30.0,
    localXMax: +210.0,
    lengthM: 180.0,
    center: Object.freeze([PORT_ORIGIN[0] + 120.0, PORT_ORIGIN[1] + BERTH_MOORED_OFFSET_Y, 0.0]),
    stagingPos: Object.freeze([PORT_ORIGIN[0] + 120.0, PORT_ORIGIN[1] + 60.0, 0.0]),
    defaultHeading: Math.PI * 0.5,
    alternateHeading: Math.PI * 1.5,
    primaryStsId: "STS-2",
    mooringTolerance: Object.freeze({
      maxLateralErrM: 3.0,
      maxLongErrM: 4.5,
      maxHeadingErrRad: 6.0 * RAD_PER_DEG,
      maxSpeedMps: 0.6,
    }),
  }),
});

export const OFFSHORE_WAYPOINTS = Object.freeze({
  WP_SEA: Object.freeze([44980.0, 48320.0, 0.0]),
  WP_TURN: Object.freeze([44980.0, 48060.0, 0.0]),
  WP_B1_STAGING: Object.freeze([44880.0, 47940.0, 0.0]),
  WP_B2_STAGING: Object.freeze([45080.0, 47940.0, 0.0]),
  WP_EXIT_W: Object.freeze([44500.0, 48200.0, 0.0]),
  WP_EXIT_E: Object.freeze([45460.0, 48200.0, 0.0]),
});

export const STS_CRANE_SPECS = Object.freeze({
  wcid: PORT_WCID.StsGantryCrane,
  kind: PORT_DEPLOYABLE_KIND.StsGantryCrane,
  maxDrawCalls: 14,
  railGaugeM: 20.0,
  railMinLocalX: -170.0, // world 44790.0
  railMaxLocalX: +210.0, // world 45170.0
  railCenterLocalY: -14.5, // midpoint of -4.5 (waterside) & -24.5 (landside) -> world 47865.5
  watersideRailLocalY: -4.5,
  landsideRailLocalY: -24.5,
  railZ: 2.0,
  portalClearanceM: 14.0,
  boomHeightAboveRailM: 28.0,
  liftHeightAboveRailM: 26.0,
  outreachM: 28.0,      // reaches +28 m north of waterside rail -> Y = 47903.5
  backreachM: 16.0,     // reaches -16 m south of landside rail -> Y = 47839.5
  trolleyMinLocalY: -40.5, // relative to quayY (backreach tip)
  trolleyMaxLocalY: +23.5, // relative to quayY (outreach tip)
  spreaderMinZ: 2.6,    // reaches ship hold tier 02 & apron shuttle deck
  spreaderMaxZ: 24.5,   // clears 4-high deck stacks safely
  spreaderSafeZ: 21.0,  // default transit clearance height
  spreaderLen20M: 6.058,
  spreaderLen40M: 12.192,
  spreaderBeamH: 0.65,
  boomStowedAngleRad: 80.0 * RAD_PER_DEG,
  minCraneSeparationM: 26.0,
  // Kinematic rates
  gantrySpeedMps: 1.8,
  trolleySpeedMps: 4.5,
  hoistSpeedEmptyMps: 2.4,
  hoistSpeedLoadedMps: 1.6,
  boomHoistRateRadSec: 0.22,
  telescopeSpeedMps: 2.5,
  twistlockRateRadSec: 3.5,
  defaultCranes: Object.freeze([
    Object.freeze({ id: "STS-1", localX: -80.0, berthId: "B1", boomStowed: false }),
    Object.freeze({ id: "STS-2", localX: +120.0, berthId: "B2", boomStowed: false }),
  ]),
});

export const YARD_CRANE_SPECS = Object.freeze({
  rmgWcid: PORT_WCID.RmgYardCrane,
  rtgWcid: PORT_WCID.RtgYardCrane,
  rmgKind: PORT_DEPLOYABLE_KIND.RmgYardCrane,
  rtgKind: PORT_DEPLOYABLE_KIND.RtgYardCrane,
  maxDrawCalls: 12,
  stackPoolMaxDrawCalls: 6,
  spanM: 30.0,
  liftHeightM: 14.5,
  spreaderMinZ: 1.32,
  spreaderMaxZ: 13.8,
  spreaderSafeZ: 12.8,
  maxTiers: 4,
  rowCount: 6,
  rowPitchM: 2.85,
  bayPitch20M: 6.50,
  bayPitch40M: 13.00,
  gantrySpeedMps: 2.6,
  trolleySpeedMps: 3.2,
  hoistSpeedMps: 1.8,
  telescopeSpeedMps: 2.5,
  twistlockRateRadSec: 3.5,
  rtgWheelSteerMaxRad: Math.PI * 0.5,
  rtgWheelSteerRateRadSec: 1.2,
  minCraneSeparationM: 22.0,
});

// Container Yard Blocks (all at z = 0.0 m dry flatland; containers oriented E-W heading = PI/2)
export const YARD_BLOCK_SPECS = Object.freeze({
  A1: Object.freeze({
    id: "A1",
    name: "Block A1 (North Quayside Import Buffer)",
    craneType: "RMG",
    craneId: "RMG-1",
    reefer: false,
    localMinX: -168.0, // world 44792
    localMaxX: -12.0,  // world 44948 (156 m = 12 x 40ft even bays 02..24 / 24 x 20ft odd bays 01..47)
    southRailLocalY: -114.0, // world 47766.0
    northRailLocalY: -84.0,  // world 47796.0 (span 30.0 m)
    row0LocalY: -110.0,      // world 47770.0 (+r * 2.85 -> 47770.0..47784.25)
    ttlLocalY: -88.5,        // world 47791.5 (shuttle transfer lane inside portal)
    evenBayCount: 12,        // even bays 2, 4, ..., 24; odd bays 1, 3, ..., 47
    rowCount: 6,
    maxTiers: 4,
    containerHeading: Math.PI * 0.5, // East-West parallel to quay
  }),
  A2: Object.freeze({
    id: "A2",
    name: "Block A2 (North Quayside Export Buffer)",
    craneType: "RMG",
    craneId: "RMG-2",
    reefer: false,
    localMinX: +8.0,   // world 44968
    localMaxX: +164.0, // world 45124
    southRailLocalY: -114.0,
    northRailLocalY: -84.0,
    row0LocalY: -110.0,
    ttlLocalY: -88.5,
    evenBayCount: 12,
    rowCount: 6,
    maxTiers: 4,
    containerHeading: Math.PI * 0.5,
  }),
  B1: Object.freeze({
    id: "B1",
    name: "Block B1 (South Warehouse-Interchange Staging)",
    craneType: "RTG",
    craneId: "RTG-1",
    reefer: false,
    localMinX: -168.0, // world 44792
    localMaxX: -12.0,  // world 44948
    southRailLocalY: -172.0, // world 47708.0
    northRailLocalY: -142.0, // world 47738.0 (span 30.0 m)
    row0LocalY: -168.0,      // world 47712.0 (+r * 2.85 -> 47712.0..47726.25)
    ttlLocalY: -146.5,       // world 47733.5
    evenBayCount: 12,
    rowCount: 6,
    maxTiers: 4,
    containerHeading: Math.PI * 0.5,
  }),
  B2: Object.freeze({
    id: "B2",
    name: "Block B2 (South Dry/Empty Staging)",
    craneType: "RTG",
    craneId: "RTG-1",
    reefer: false,
    localMinX: +8.0,   // world 44968
    localMaxX: +86.0,  // world 45046 (78 m = 6 x 40ft bays)
    southRailLocalY: -172.0,
    northRailLocalY: -142.0,
    row0LocalY: -168.0,
    ttlLocalY: -146.5,
    evenBayCount: 6,
    rowCount: 6,
    maxTiers: 4,
    containerHeading: Math.PI * 0.5,
  }),
  REEFER: Object.freeze({
    id: "REEFER",
    name: "Reefer Rack Block (440V Shore-Power Reefer Gantries)",
    craneType: "RTG",
    craneId: "RTG-1",
    reefer: true,
    localMinX: +96.0,  // world 45056
    localMaxX: +148.0, // world 45108 (52 m = 4 x 40ft bays)
    southRailLocalY: -172.0,
    northRailLocalY: -142.0,
    row0LocalY: -168.0,
    ttlLocalY: -146.5,
    evenBayCount: 4,
    rowCount: 4,
    maxTiers: 3,
    containerHeading: Math.PI * 0.5,
  }),
});

export const SHUTTLE_SPECS = Object.freeze({
  wcid: PORT_WCID.TerminalTractorShuttle,
  kind: PORT_DEPLOYABLE_KIND.TerminalTractorShuttle,
  maxDrawCalls: 10,
  tractorLengthM: 5.2,
  chassisLengthM: 12.4,
  overallLengthM: 15.2,
  widthM: 2.55,
  deckZ: 1.32, // Exact match to TRAILER_SPECS CHASSIS_DECK_Z
  wheelRadiusM: 0.51,
  wheelbaseM: 3.8,
  maxSteerRad: 0.65,
  vMaxEmptyMps: 8.5,
  vMaxLoadedMps: 6.5,
  vRampMps: 4.5,
  vDockingMps: 1.5,
  accelMps2: 2.4,
  decelMps2: 4.2,
  hullRadiusM: 2.8,
  stopDistM: 18.0,
  slowDistM: 26.0,
  defaultShuttles: Object.freeze([
    Object.freeze({ id: "TT-1", startNode: "quay_lane_b1" }),
    Object.freeze({ id: "TT-2", startNode: "yard_mid_w" }),
    Object.freeze({ id: "TT-3", startNode: "corridor_c2" }),
  ]),
});

// ---------------------------------------------------------------------------
// 6. ISO 9711 Bay-Row-Tier Utilities & Structural Stack Validators
// ---------------------------------------------------------------------------

export function formatBrtCode(bay, row, tier) {
  const b = String(Math.max(0, Math.trunc(bay))).padStart(2, "0");
  const r = String(Math.max(0, Math.trunc(row))).padStart(2, "0");
  const t = String(Math.max(0, Math.trunc(tier))).padStart(2, "0");
  return `${b}${r}${t}`;
}

export function parseBrtCode(code) {
  const s = String(code ?? "").trim().replace(/[^0-9]/g, "");
  if (s.length !== 6) return null;
  return {
    bay: parseInt(s.slice(0, 2), 10),
    row: parseInt(s.slice(2, 4), 10),
    tier: parseInt(s.slice(4, 6), 10),
    brt: s,
  };
}

export function isOddBay(bay) {
  return Number.isInteger(bay) && bay >= 1 && (bay % 2) === 1;
}

export function isEvenBay(bay) {
  return Number.isInteger(bay) && bay >= 2 && (bay % 2) === 0;
}

/** For an even 40ft bay `2k`, return its two constituent odd 20ft bays `[4k-3, 4k-1]` (ship) or `[2k-1, 2k+1]` (yard). */
export function shipOddPairForEvenBay(evenBay) {
  const def = SHIP_BAY_DEFS.even40.find((b) => b.bay === evenBay);
  return def ? def.oddPair : null;
}

export function shipEvenBayForOddBay(oddBay) {
  const def = SHIP_BAY_DEFS.odd20.find((b) => b.bay === oddBay);
  return def ? def.parentEvenBay : null;
}

/**
 * Yard bay indexing (ISO 9711 parity):
 *  - Even 40ft bay `e ∈ {2, 4, ..., 2*evenBayCount}` occupies slot index `k = e/2 - 1` (`0..evenBayCount-1`).
 *  - Its two odd 20ft sub-bays are `o1 = 4*k + 1` (west half) and `o2 = 4*k + 3` (east half),
 *    so odd bays `1,3` pair under even bay `2`, `5,7` under `4`, `9,11` under `6`, etc. (exact ISO 9711 pairing!).
 */
export function yardOddPairForEvenBay(evenBay) {
  if (!isEvenBay(evenBay)) return null;
  const k = evenBay / 2 - 1;
  return [4 * k + 1, 4 * k + 3];
}

export function yardEvenBayForOddBay(oddBay) {
  if (!isOddBay(oddBay)) return null;
  const k = Math.floor((oddBay - 1) / 4);
  return (k + 1) * 2;
}

function lookupSlot(occupiedMap, key) {
  if (!occupiedMap) return null;
  if (typeof occupiedMap.get === "function") return occupiedMap.get(key) ?? null;
  return occupiedMap[key] ?? null;
}

/**
 * Validate ISO 9711 container placement in a Container Yard block.
 * Enforces parity (odd=20ft, even=40ft/40HC), bounds, mutual exclusion between 20ft & 40ft bays,
 * and structural stack support (tier > 1 requires full corner-casting support directly underneath).
 */
export function validateYardPlacement(blockId, bay, row, tier, containerKindOrWcid, occupiedMap = null) {
  const block = YARD_BLOCK_SPECS[blockId];
  if (!block) return { ok: false, reason: `Unknown yard block: ${blockId}` };
  const spec = resolvePortContainerSpec(containerKindOrWcid);
  if (!Number.isInteger(row) || row < 1 || row > block.rowCount) {
    return { ok: false, reason: `Row ${row} out of range 1..${block.rowCount} for block ${blockId}` };
  }
  if (!Number.isInteger(tier) || tier < 1 || tier > block.maxTiers) {
    return { ok: false, reason: `Tier ${tier} out of range 1..${block.maxTiers} for block ${blockId}` };
  }

  const is20 = spec.sizeFt === 20;
  if (is20) {
    if (!isOddBay(bay)) return { ok: false, reason: `ISO 9711: 20ft container requires odd bay (got ${bay})` };
    const parentEven = yardEvenBayForOddBay(bay);
    if (parentEven > block.evenBayCount * 2) {
      return { ok: false, reason: `20ft bay ${bay} exceeds block ${blockId} capacity` };
    }
    if (lookupSlot(occupiedMap, `${blockId}:${formatBrtCode(bay, row, tier)}`)) {
      return { ok: false, reason: `Slot ${blockId}:${formatBrtCode(bay, row, tier)} already occupied` };
    }
    if (lookupSlot(occupiedMap, `${blockId}:${formatBrtCode(parentEven, row, tier)}`)) {
      return { ok: false, reason: `Slot blocked by 40ft container in bay ${parentEven}` };
    }
    if (tier > 1) {
      const below20 = lookupSlot(occupiedMap, `${blockId}:${formatBrtCode(bay, row, tier - 1)}`);
      if (!below20) {
        return { ok: false, reason: `ISO 3874: 20ft tier ${tier} requires 20ft container directly below in bay ${bay} (no unsupported overhang on 40ft)` };
      }
    }
    return { ok: true, brt: formatBrtCode(bay, row, tier), spec };
  }

  // 40ft / 40HC
  if (!isEvenBay(bay) || bay > block.evenBayCount * 2) {
    return { ok: false, reason: `ISO 9711: 40ft container requires even bay 2..${block.evenBayCount * 2} (got ${bay})` };
  }
  const [oddW, oddE] = yardOddPairForEvenBay(bay);
  if (lookupSlot(occupiedMap, `${blockId}:${formatBrtCode(bay, row, tier)}`)) {
    return { ok: false, reason: `Slot ${blockId}:${formatBrtCode(bay, row, tier)} already occupied` };
  }
  if (
    lookupSlot(occupiedMap, `${blockId}:${formatBrtCode(oddW, row, tier)}`) ||
    lookupSlot(occupiedMap, `${blockId}:${formatBrtCode(oddE, row, tier)}`)
  ) {
    return { ok: false, reason: `Slot blocked by 20ft container in sub-bays ${oddW}/${oddE}` };
  }
  if (tier > 1) {
    const below40 = lookupSlot(occupiedMap, `${blockId}:${formatBrtCode(bay, row, tier - 1)}`);
    const belowW = lookupSlot(occupiedMap, `${blockId}:${formatBrtCode(oddW, row, tier - 1)}`);
    const belowE = lookupSlot(occupiedMap, `${blockId}:${formatBrtCode(oddE, row, tier - 1)}`);
    if (!below40 && !(belowW && belowE)) {
      return { ok: false, reason: `ISO 3874: 40ft tier ${tier} requires a 40ft or dual-20ft base directly below` };
    }
    if (!below40 && belowW && belowE) {
      const hW = resolvePortContainerSpec(belowW).extH;
      const hE = resolvePortContainerSpec(belowE).extH;
      if (Math.abs(hW - hE) > 0.01) {
        return { ok: false, reason: `Dual-20ft base heights mismatched (${hW} vs ${hE})` };
      }
    }
  }
  return { ok: true, brt: formatBrtCode(bay, row, tier), spec };
}

/**
 * Compute world-space `[x, y, z, heading]` for a Container Yard bay-row-tier slot.
 * `stackLookupFn(bay, row, t)` returns occupied entry (for exact cumulative 2.591 / 2.896 m height).
 */
export function computeYardSlotWorldPose(
  blockId,
  bay,
  row,
  tier,
  containerKindOrWcid = "40ft",
  stackLookupFn = null,
  origin = PORT_ORIGIN
) {
  const block = YARD_BLOCK_SPECS[blockId];
  if (!block) throw new RangeError(`computeYardSlotWorldPose: unknown block ${blockId}`);
  const ox = Array.isArray(origin) && Number.isFinite(origin[0]) ? origin[0] : PORT_ORIGIN[0];
  const oy = Array.isArray(origin) && Number.isFinite(origin[1]) ? origin[1] : PORT_ORIGIN[1];
  const oz = Array.isArray(origin) && Number.isFinite(origin[2]) ? origin[2] : PORT_ORIGIN[2];
  const spec = resolvePortContainerSpec(containerKindOrWcid);

  let localX;
  if (isEvenBay(bay)) {
    const k = bay / 2 - 1;
    localX = block.localMinX + (k + 0.5) * YARD_CRANE_SPECS.bayPitch40M;
  } else {
    const parentEven = yardEvenBayForOddBay(bay);
    const k = parentEven / 2 - 1;
    const isEastHalf = ((bay - 1) % 4) === 2;
    const center40X = block.localMinX + (k + 0.5) * YARD_CRANE_SPECS.bayPitch40M;
    localX = center40X + (isEastHalf ? +3.15 : -3.15);
  }

  const localY = block.row0LocalY + (row - 1) * YARD_CRANE_SPECS.rowPitchM;

  // Exact cumulative stacking height from tiers 1..(tier-1)
  let z = oz + PORT_SITE.yardVisualZ;
  for (let t = 1; t < tier; t++) {
    let below = null;
    if (typeof stackLookupFn === "function") {
      below = stackLookupFn(bay, row, t);
      if (!below && isEvenBay(bay)) {
        const [ow] = yardOddPairForEvenBay(bay);
        below = stackLookupFn(ow, row, t);
      }
    }
    z += below ? resolvePortContainerSpec(below).extH : ISO_CONTAINERS[4000021].extH;
  }

  return {
    x: ox + localX,
    y: oy + localY,
    z,
    heading: block.containerHeading,
    blockId,
    bay,
    row,
    tier,
    brt: formatBrtCode(bay, row, tier),
    extW: spec.extW,
    extL: spec.extL,
    extH: spec.extH,
    wcid: spec.wcid,
    kind: spec.kind,
  };
}

/**
 * Validate ISO 9711-1 container placement on board M/V Dereth Feeder.
 */
export function validateShipPlacement(bay, row, tier, containerKindOrWcid, occupiedMap = null) {
  const spec = resolvePortContainerSpec(containerKindOrWcid);
  const rowDef = SHIP_ROW_DEFS.find((r) => r.row === row);
  if (!rowDef) return { ok: false, reason: `ISO 9711: invalid ship row ${row} (valid: 01, 02, 03, 04)` };

  const inHold = SHIP_TIER_DEFS.hold.includes(tier);
  const deckIdx = SHIP_TIER_DEFS.deck.indexOf(tier);
  if (!inHold && deckIdx < 0) {
    return { ok: false, reason: `ISO 9711: invalid ship tier ${tier} (valid hold: 02; deck: 82, 84, 86, 88)` };
  }

  const is20 = spec.sizeFt === 20;
  if (is20) {
    const bayDef = SHIP_BAY_DEFS.odd20.find((b) => b.bay === bay);
    if (!bayDef) return { ok: false, reason: `ISO 9711: 20ft ship slot requires odd bay 01..11 (got ${bay})` };
    if (lookupSlot(occupiedMap, formatBrtCode(bay, row, tier))) {
      return { ok: false, reason: `Ship slot ${formatBrtCode(bay, row, tier)} occupied` };
    }
    if (lookupSlot(occupiedMap, formatBrtCode(bayDef.parentEvenBay, row, tier))) {
      return { ok: false, reason: `Ship slot blocked by 40ft container in bay ${bayDef.parentEvenBay}` };
    }
    if (deckIdx > 0) {
      const belowTier = SHIP_TIER_DEFS.deck[deckIdx - 1];
      if (!lookupSlot(occupiedMap, formatBrtCode(bay, row, belowTier))) {
        return { ok: false, reason: `ISO 3874: 20ft deck tier ${tier} requires 20ft below at tier ${belowTier}` };
      }
    }
    return { ok: true, brt: formatBrtCode(bay, row, tier), inHold, hatchBay: bayDef.parentEvenBay, spec };
  }

  // 40ft / 40HC
  const bayDef = SHIP_BAY_DEFS.even40.find((b) => b.bay === bay);
  if (!bayDef) return { ok: false, reason: `ISO 9711: 40ft ship slot requires even bay 02, 04, 06 (got ${bay})` };
  const [oddF, oddA] = bayDef.oddPair;
  if (lookupSlot(occupiedMap, formatBrtCode(bay, row, tier))) {
    return { ok: false, reason: `Ship slot ${formatBrtCode(bay, row, tier)} occupied` };
  }
  if (
    lookupSlot(occupiedMap, formatBrtCode(oddF, row, tier)) ||
    lookupSlot(occupiedMap, formatBrtCode(oddA, row, tier))
  ) {
    return { ok: false, reason: `Ship slot blocked by 20ft container in sub-bays ${oddF}/${oddA}` };
  }
  if (deckIdx > 0) {
    const belowTier = SHIP_TIER_DEFS.deck[deckIdx - 1];
    const b40 = lookupSlot(occupiedMap, formatBrtCode(bay, row, belowTier));
    const bF = lookupSlot(occupiedMap, formatBrtCode(oddF, row, belowTier));
    const bA = lookupSlot(occupiedMap, formatBrtCode(oddA, row, belowTier));
    if (!b40 && !(bF && bA)) {
      return { ok: false, reason: `ISO 3874: 40ft deck tier ${tier} requires 40ft or dual-20ft support at tier ${belowTier}` };
    }
  }
  return { ok: true, brt: formatBrtCode(bay, row, tier), inHold, hatchBay: bay, spec };
}

/**
 * Compute ship-local `[x, y, z]` pose for an ISO 9711 ship bay-row-tier slot.
 */
export function computeShipSlotLocalPose(bay, row, tier, containerKindOrWcid = "40ft", stackLookupFn = null) {
  const spec = resolvePortContainerSpec(containerKindOrWcid);
  const rowDef = SHIP_ROW_DEFS.find((r) => r.row === row);
  if (!rowDef) throw new RangeError(`computeShipSlotLocalPose: invalid row ${row}`);

  let bayY;
  let hatchBay;
  if (isEvenBay(bay)) {
    const def = SHIP_BAY_DEFS.even40.find((b) => b.bay === bay);
    if (!def) throw new RangeError(`computeShipSlotLocalPose: invalid even bay ${bay}`);
    bayY = def.y;
    hatchBay = bay;
  } else {
    const def = SHIP_BAY_DEFS.odd20.find((b) => b.bay === bay);
    if (!def) throw new RangeError(`computeShipSlotLocalPose: invalid odd bay ${bay}`);
    bayY = def.y;
    hatchBay = def.parentEvenBay;
  }

  const inHold = SHIP_TIER_DEFS.hold.includes(tier);
  let z;
  if (inHold) {
    z = SHIP_SPECS.holdTankTopZ; // +0.45 m strictly above wave crests
  } else {
    const deckIdx = SHIP_TIER_DEFS.deck.indexOf(tier);
    if (deckIdx < 0) throw new RangeError(`computeShipSlotLocalPose: invalid tier ${tier}`);
    z = SHIP_SPECS.hatchDeckZ; // +3.95 m atop hatch covers
    for (let i = 0; i < deckIdx; i++) {
      const tBelow = SHIP_TIER_DEFS.deck[i];
      let below = null;
      if (typeof stackLookupFn === "function") {
        below = stackLookupFn(bay, row, tBelow);
        if (!below && isEvenBay(bay)) {
          const pair = shipOddPairForEvenBay(bay);
          if (pair) below = stackLookupFn(pair[0], row, tBelow);
        }
      }
      z += below ? resolvePortContainerSpec(below).extH : ISO_CONTAINERS[4000021].extH;
    }
  }

  return {
    x: rowDef.x,
    y: bayY,
    z,
    bay,
    row,
    tier,
    brt: formatBrtCode(bay, row, tier),
    inHold,
    hatchBay,
    extW: spec.extW,
    extL: spec.extL,
    extH: spec.extH,
    wcid: spec.wcid,
    kind: spec.kind,
  };
}

// ---------------------------------------------------------------------------
// 7. Complete Deterministic Terminal Layout & Road Waypoint Graph Builder
// ---------------------------------------------------------------------------

export function buildPortLayout(origin = PORT_ORIGIN) {
  const ox = Array.isArray(origin) && Number.isFinite(origin[0]) ? origin[0] : PORT_ORIGIN[0];
  const oy = Array.isArray(origin) && Number.isFinite(origin[1]) ? origin[1] : PORT_ORIGIN[1];
  const oz = Array.isArray(origin) && Number.isFinite(origin[2]) ? origin[2] : PORT_ORIGIN[2];

  // Bollards along coping
  const bollards = [];
  for (let i = 0; i < QUAY_SPECS.bollardCount; i++) {
    const lx = QUAY_SPECS.bollardFirstLocalX + i * QUAY_SPECS.bollardSpacingM;
    const ly = QUAY_SPECS.bollardLocalY;
    bollards.push({
      id: `BOL_${String(i + 1).padStart(2, "0")}`,
      wcid: PORT_WCID.QuayBollard,
      localPos: [lx, ly, QUAY_SPECS.deckZ],
      pos: [ox + lx, oy + ly, oz + QUAY_SPECS.deckZ],
    });
  }

  // Marine cone fenders along seawall face
  const fenders = [];
  for (let i = 0; i < QUAY_SPECS.fenderCount; i++) {
    const lx = QUAY_SPECS.fenderFirstLocalX + i * QUAY_SPECS.fenderSpacingM;
    fenders.push({
      id: `FND_${String(i + 1).padStart(2, "0")}`,
      wcid: PORT_WCID.MarineFender,
      localPos: [lx, 0.0, 1.0],
      pos: [ox + lx, oy, oz + 1.0],
    });
  }

  // Berths translated to origin
  const berths = {};
  for (const [bid, b] of Object.entries(BERTH_SPECS)) {
    berths[bid] = {
      ...b,
      xMin: ox + b.localXMin,
      xMax: ox + b.localXMax,
      center: [ox + b.localX, oy + BERTH_MOORED_OFFSET_Y, oz],
      stagingPos: [ox + b.localX, oy + 60.0, oz],
      fenderY: oy + QUAY_SPECS.fenderDepthM,
    };
  }

  // Yard blocks translated to origin
  const blocks = {};
  for (const [id, b] of Object.entries(YARD_BLOCK_SPECS)) {
    blocks[id] = {
      ...b,
      minX: ox + b.localMinX,
      maxX: ox + b.localMaxX,
      southRailY: oy + b.southRailLocalY,
      northRailY: oy + b.northRailLocalY,
      row0Y: oy + b.row0LocalY,
      ttlY: oy + b.ttlLocalY,
    };
  }

  // STS cranes
  const stsCranes = STS_CRANE_SPECS.defaultCranes.map((c) => ({
    ...c,
    x: ox + c.localX,
    y: oy + STS_CRANE_SPECS.railCenterLocalY,
    z: oz + STS_CRANE_SPECS.railZ,
    railMinX: ox + STS_CRANE_SPECS.railMinLocalX,
    railMaxX: ox + STS_CRANE_SPECS.railMaxLocalX,
  }));

  // Yard cranes (RMG-1, RMG-2, RTG-1)
  const yardCranes = [
    {
      id: "RMG-1",
      type: "RMG",
      wcid: PORT_WCID.RmgYardCrane,
      blockIds: ["A1"],
      x: ox - 90.0,
      y: oy + (YARD_BLOCK_SPECS.A1.southRailLocalY + YARD_BLOCK_SPECS.A1.northRailLocalY) * 0.5,
      z: oz,
      minX: ox + YARD_BLOCK_SPECS.A1.localMinX,
      maxX: ox + YARD_BLOCK_SPECS.A1.localMaxX,
    },
    {
      id: "RMG-2",
      type: "RMG",
      wcid: PORT_WCID.RmgYardCrane,
      blockIds: ["A2"],
      x: ox + 86.0,
      y: oy + (YARD_BLOCK_SPECS.A2.southRailLocalY + YARD_BLOCK_SPECS.A2.northRailLocalY) * 0.5,
      z: oz,
      minX: ox + YARD_BLOCK_SPECS.A2.localMinX,
      maxX: ox + YARD_BLOCK_SPECS.A2.localMaxX,
    },
    {
      id: "RTG-1",
      type: "RTG",
      wcid: PORT_WCID.RtgYardCrane,
      blockIds: ["B1", "B2", "REEFER"],
      x: ox - 90.0,
      y: oy + (YARD_BLOCK_SPECS.B1.southRailLocalY + YARD_BLOCK_SPECS.B1.northRailLocalY) * 0.5,
      z: oz,
      minX: ox + YARD_BLOCK_SPECS.B1.localMinX,
      maxX: ox + YARD_BLOCK_SPECS.REEFER.localMaxX,
    },
  ];

  // Warehouse drop pads shifted if origin differs from default PORT_ORIGIN
  const dxO = ox - PORT_ORIGIN[0];
  const dyO = oy - PORT_ORIGIN[1];
  const warehouseOrigin = [WAREHOUSE_PORT_ORIGIN[0] + dxO, WAREHOUSE_PORT_ORIGIN[1] + dyO, oz];
  const warehouseDropPads = {};
  for (const [pid, pad] of Object.entries(WAREHOUSE_DROP_PADS)) {
    warehouseDropPads[pid] = {
      ...pad,
      pos: [pad.pos[0] + dxO, pad.pos[1] + dyO, oz],
    };
  }

  // Connected bidirectional terminal shuttle road graph (Quay <-> Ramp <-> Yard Blocks <-> Warehouse Zone A)
  const nodes = [];
  const nodeMap = new Map();
  const edges = [];
  const edgeKeys = new Set();

  function addNode(id, lx, ly, zone, kind) {
    if (nodeMap.has(id)) return nodeMap.get(id);
    const wx = ox + lx;
    const wy = oy + ly;
    const wz = quayRampZ(wy, [ox, oy, oz]);
    const n = { id, x: wx, y: wy, z: wz, localPos: [lx, ly, wz - oz], zone, kind };
    nodes.push(n);
    nodeMap.set(id, n);
    return n;
  }

  function addEdge(aId, bId) {
    if (aId === bId) return;
    const a = nodeMap.get(aId);
    const b = nodeMap.get(bId);
    if (!a || !b) return;
    const key = aId < bId ? `${aId}__${bId}` : `${bId}__${aId}`;
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push({ id: `E_${aId}_${bId}`, from: aId, to: bId, lengthM: Math.hypot(b.x - a.x, b.y - a.y) });
  }

  function linkChain(ids) {
    for (let i = 0; i < ids.length - 1; i++) addEdge(ids[i], ids[i + 1]);
  }

  // 1. Quay under-portal transfer lane (localY = -13.0 -> world 47867.0, z = +2.00)
  const quayChain = [
    ["quay_w", -174.0, -13.0],
    ["quay_lane_b1", -80.0, -13.0],
    ["quay_mid", 0.0, -13.0],
    ["quay_lane_b2", +120.0, -13.0],
    ["quay_e", +174.0, -13.0],
  ];
  for (const [id, lx, ly] of quayChain) addNode(id, lx, ly, "quay", "portal_lane");
  linkChain(quayChain.map((n) => n[0]));

  // 2. Ramp connectors on West (lx = -174), Center (lx = 0), and East (lx = +174)
  for (const [tag, lx] of [["w", -174.0], ["mid", 0.0], ["e", +174.0]]) {
    addNode(`ramp_top_${tag}`, lx, -46.0, "ramp", "ramp_top");
    addNode(`ramp_bot_${tag}`, lx, -70.0, "ramp", "ramp_foot");
    addNode(`marshal_${tag}`, lx, -75.0, "marshalling", "junction");
    addNode(`yard_n_${tag}`, lx, -88.5, "yard_north", "ttl_junction");
    addNode(`yard_mid_${tag}`, lx, -127.0, "cross_aisle", "junction");
    addNode(`yard_s_${tag}`, lx, -146.5, "yard_south", "ttl_junction");
    addNode(`corridor_${tag}`, lx, -196.0, "corridor", "junction");
    const quayAnchor = tag === "w" ? "quay_w" : (tag === "mid" ? "quay_mid" : "quay_e");
    linkChain([quayAnchor, `ramp_top_${tag}`, `ramp_bot_${tag}`, `marshal_${tag}`, `yard_n_${tag}`, `yard_mid_${tag}`, `yard_s_${tag}`, `corridor_${tag}`]);
  }

  // 3. North Yard TTL (A1 & A2, localY = -88.5)
  addNode("ttl_A1_mid", -90.0, -88.5, "yard_north", "ttl");
  addNode("ttl_A2_mid", +86.0, -88.5, "yard_north", "ttl");
  linkChain(["yard_n_w", "ttl_A1_mid", "yard_n_mid", "ttl_A2_mid", "yard_n_e"]);

  // 4. Central Yard Cross-Aisle (localY = -127.0)
  linkChain(["yard_mid_w", "yard_mid_mid", "yard_mid_e"]);

  // 5. South Yard TTL (B1, B2, REEFER, localY = -146.5)
  addNode("ttl_B1_mid", -90.0, -146.5, "yard_south", "ttl");
  addNode("ttl_B2_mid", +47.0, -146.5, "yard_south", "ttl");
  addNode("ttl_REEFER_mid", +122.0, -146.5, "yard_south", "ttl");
  linkChain(["yard_s_w", "ttl_B1_mid", "yard_s_mid", "ttl_B2_mid", "ttl_REEFER_mid", "yard_s_e"]);

  // 6. Intermodal Warehouse Corridor (localY = -196.0 -> world 47684.0) & Zone A Drop Pad Branches
  addNode("corridor_c1", -40.0, -196.0, "corridor", "junction");
  addNode("corridor_c2", -24.0, -196.0, "corridor", "junction");
  addNode("corridor_c3", -8.0, -196.0, "corridor", "junction");
  addNode("corridor_wh_east", +30.0, -196.0, "corridor", "junction");
  linkChain(["corridor_w", "corridor_c1", "corridor_c2", "corridor_c3", "corridor_mid", "corridor_wh_east", "corridor_e"]);

  // Direct spurs into Warehouse Zone A Drop Pads C1, C2, C3 (localY = -222.5 / -225.57)
  addNode("wh_pad_C1", -40.0, -222.5, "warehouse_handoff", "drop_pad");
  addNode("wh_pad_C2", -24.0, -222.5, "warehouse_handoff", "drop_pad");
  addNode("wh_pad_C3", -8.0, -225.57, "warehouse_handoff", "drop_pad");
  addEdge("corridor_c1", "wh_pad_C1");
  addEdge("corridor_c2", "wh_pad_C2");
  addEdge("corridor_c3", "wh_pad_C3");

  return {
    origin: [ox, oy, oz],
    warehouseOrigin,
    bounds: {
      minX: ox + PORT_SITE.localMinX,
      maxX: ox + PORT_SITE.localMaxX,
      minY: oy - 210.0, // 47670.0 flush with warehouse North slab edge
      maxY: oy,         // 47880.0 quay coping edge
      quayDeckZ: oz + QUAY_SPECS.deckZ,
      yardZ: oz,
    },
    bollards,
    fenders,
    berths,
    blocks,
    stsCranes,
    yardCranes,
    warehouseDropPads,
    offshoreWaypoints: {
      WP_SEA: [OFFSHORE_WAYPOINTS.WP_SEA[0] + dxO, OFFSHORE_WAYPOINTS.WP_SEA[1] + dyO, oz],
      WP_TURN: [OFFSHORE_WAYPOINTS.WP_TURN[0] + dxO, OFFSHORE_WAYPOINTS.WP_TURN[1] + dyO, oz],
      WP_B1_STAGING: [OFFSHORE_WAYPOINTS.WP_B1_STAGING[0] + dxO, OFFSHORE_WAYPOINTS.WP_B1_STAGING[1] + dyO, oz],
      WP_B2_STAGING: [OFFSHORE_WAYPOINTS.WP_B2_STAGING[0] + dxO, OFFSHORE_WAYPOINTS.WP_B2_STAGING[1] + dyO, oz],
      WP_EXIT_W: [OFFSHORE_WAYPOINTS.WP_EXIT_W[0] + dxO, OFFSHORE_WAYPOINTS.WP_EXIT_W[1] + dyO, oz],
      WP_EXIT_E: [OFFSHORE_WAYPOINTS.WP_EXIT_E[0] + dxO, OFFSHORE_WAYPOINTS.WP_EXIT_E[1] + dyO, oz],
    },
    graph: { nodes, edges },
  };
}
