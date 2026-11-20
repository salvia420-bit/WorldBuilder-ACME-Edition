// scene3d/vehicle/semi_truck_model.js — Procedural Classic North American 6x4 Day-Cab Semi-Tractor ("Ironhorse 379")
//
// AC Z-up coordinate frame: +X = Right, +Y = Forward, +Z = Up, z = 0 ground.
// - Sculpted Peterbilt 379 / Kenworth W900-inspired 6x4 Day-Cab via GeomAcc:
//   long tapered hood, vertical-slat chrome radiator grille, Texas bumper, twin round headlight pods,
//   twin cowl air-cleaners, split flat windscreen, exterior sun visor, 5 ICC roof markers, dual air horns,
//   West Coast mirrors, clear rear cab window, dual vertical chrome exhaust stacks (z_top = 3.72 m),
//   twin aluminum saddle fuel tanks (r = 0.30 m), open headache rack with coiled red/blue glad-hand hoses,
//   JOST fifth-wheel rocking skid plate at (0, -2.01, 0.96), 2-seat cab interior, 4-spoke wheel,
//   Eaton-Fuller 10-speed floor shifter, animated speedometer needle, Alcoa 10-lug wheels (r = 0.505 m).
// - PBR MeshStandardMaterial stack calibrated for AGX HDR (exposure = 5.0) + CSM shadows (installCsmShaderPatch).
// - Strictly <= 16 draw calls, 0 THREE.Light instances (lightCountDelta === 0, pooled FxLightSource).

import * as THREE_DEFAULT from "three";
import { installCsmShaderPatch } from "../materials.js";
import { FxLightSource } from "../vfx/fx_lights.js";

export const SEMI_DIMENSIONS = Object.freeze({
  overallLength: 7.00,
  yMin: -3.45,
  yMax: 3.55,
  wheelbase: 4.66, // steer (+2.65) to tandem midpoint (-2.01)
  steerAxleY: 2.65,
  tandemFrontY: -1.35,
  tandemRearY: -2.67,
  tandemMidY: -2.01,
  trackWidth: 2.12, // front steer ±1.06
  dualInnerX: 0.80,
  dualOuterX: 1.11,
  wheelRadius: 0.505, // 11R22.5
  maxSteerLowSpeedRad: (38 * Math.PI) / 180, // 0.663225 rad
  maxSteerHighSpeedRad: (12 * Math.PI) / 180, // 0.209440 rad
  steeringGearRatio: 2.5,
  fifthWheelY: -2.01,
  fifthWheelZ: 0.96,
  cabRearY: -0.30,
  cabRoofZ: 3.05,
  exhaustStackX: 1.08,
  exhaustStackY: -0.44,
  exhaustStackTopZ: 3.72,
  fuelTankX: 1.02,
  fuelTankRadius: 0.30,
  seatDriver: Object.freeze([-0.52, 0.28, 1.72]),
  seatPassenger: Object.freeze([0.52, 0.28, 1.72]),
  steeringWheelCenter: Object.freeze([-0.52, 0.76, 1.98]),
  steeringWheelRadius: 0.24,
  maxDrawCalls: 16,
});

export const SEMI_LIVERY_INDEX = Object.freeze([
  "crimsonRed",
  "midnightBlue",
  "forestGreen",
  "oliveDrab",
  "arcticWhite",
  "obsidianBlack",
]);

const _LIVERY_ENTRIES = [
  Object.freeze({ id: 0, key: "crimsonRed", name: "Crimson Red", hex: 0x9b1b1f, darkHex: 0x621013, stripeHex: 0xe8d5b0 }),
  Object.freeze({ id: 1, key: "midnightBlue", name: "Midnight Blue", hex: 0x152b4e, darkHex: 0x0d1b32, stripeHex: 0xc8d0d8 }),
  Object.freeze({ id: 2, key: "forestGreen", name: "Forest Green", hex: 0x1b4628, darkHex: 0x102b18, stripeHex: 0xd9c28a }),
  Object.freeze({ id: 3, key: "oliveDrab", name: "Olive Drab", hex: 0x464f30, darkHex: 0x2e341f, stripeHex: 0xc2b280 }),
  Object.freeze({ id: 4, key: "arcticWhite", name: "Arctic White", hex: 0xe6eaee, darkHex: 0xb6bec6, stripeHex: 0x1c3d6e }),
  Object.freeze({ id: 5, key: "obsidianBlack", name: "Obsidian Black", hex: 0x191c20, darkHex: 0x0d0f12, stripeHex: 0xb02828 }),
];

const _liveriesObj = {};
for (let i = 0; i < _LIVERY_ENTRIES.length; i++) {
  const entry = _LIVERY_ENTRIES[i];
  _liveriesObj[entry.key] = entry;
  Object.defineProperty(_liveriesObj, i, { value: entry, enumerable: false });
}
export const SEMI_LIVERIES = Object.freeze(_liveriesObj);

export function getSemiLivery(idOrKey) {
  if (typeof idOrKey === "number" && Number.isFinite(idOrKey)) {
    const idx = Math.trunc(idOrKey);
    return _LIVERY_ENTRIES[idx >= 0 && idx < _LIVERY_ENTRIES.length ? idx : 0];
  }
  if (typeof idOrKey === "string") {
    const trimmed = idOrKey.trim();
    if (Object.prototype.hasOwnProperty.call(SEMI_LIVERIES, trimmed)) {
      return SEMI_LIVERIES[trimmed];
    }
    const parsed = Number(trimmed);
    if (trimmed !== "" && Number.isInteger(parsed) && parsed >= 0 && parsed < _LIVERY_ENTRIES.length) {
      return _LIVERY_ENTRIES[parsed];
    }
  }
  return SEMI_LIVERIES.crimsonRed;
}

export const SEMI_PALETTE = Object.freeze({
  chromeBright: 0xdce2e8,
  aluminumPolished: 0xc4ccd4,
  chassisSteel: 0x222529,
  frameDark: 0x17191c,
  radiatorCore: 0x121315,
  tireRubber: 0x17191c,
  treadShoulder: 0x111214,
  seatVinyl: 0x2c2926,
  seatBolster: 0x3b3530,
  dashCharcoal: 0x202226,
  glassClear: 0xa8c4c7,
  headlightLens: 0xfff5d8,
  amberMarker: 0xff9d00,
  rubyTail: 0xff2218,
  reverseWhite: 0xeef4ff,
  airRed: 0xc92a2a,
  airBlue: 0x1c6ec7,
  airBrakeYellow: 0xe6b800,
  needleWhite: 0xf4f6f8,
});

// ---------------------------------------------------------------------------
// Procedural Geometry Engine (GeomAcc)
// ---------------------------------------------------------------------------
function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
function vSub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function vAdd(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
function vScale(a, s) { return [a[0] * s, a[1] * s, a[2] * s]; }
function vCross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function vNorm(a) {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}
function cShade(c, f) {
  return c.length === 4 ? [c[0] * f, c[1] * f, c[2] * f, c[3]] : [c[0] * f, c[1] * f, c[2] * f];
}

function makePaletteLinear(THREE, livery) {
  const tmp = new THREE.Color();
  const lin = (hex) => {
    tmp.setHex(hex);
    return [tmp.r, tmp.g, tmp.b];
  };
  const out = {};
  for (const [k, hex] of Object.entries(SEMI_PALETTE)) out[k] = lin(hex);
  out.liveryPrimary = lin(livery.hex);
  out.liveryDark = lin(livery.darkHex);
  out.liveryStripe = lin(livery.stripeHex);
  return out;
}

class GeomAcc {
  constructor(colorChannels = 3) {
    this.cc = colorChannels;
    this.pos = [];
    this.nor = [];
    this.col = [];
  }

  pushVert(p, n, c) {
    this.pos.push(p[0], p[1], p[2]);
    this.nor.push(n[0], n[1], n[2]);
    if (this.cc === 4) {
      this.col.push(c[0], c[1], c[2], c[3] ?? 1);
    } else {
      this.col.push(c[0], c[1], c[2]);
    }
  }

  tri(p0, p1, p2, c0, c1 = c0, c2 = c0, n0 = null, n1 = null, n2 = null) {
    const fn = n0 || vNorm(vCross(vSub(p1, p0), vSub(p2, p0)));
    this.pushVert(p0, n0 || fn, c0);
    this.pushVert(p1, n1 || fn, c1);
    this.pushVert(p2, n2 || fn, c2);
  }

  quad(p0, p1, p2, p3, c0, c1 = c0, c2 = c0, c3 = c0, n0 = null, n1 = null, n2 = null, n3 = null) {
    const fn = n0 || vNorm(vCross(vSub(p1, p0), vSub(p2, p0)));
    this.tri(p0, p1, p2, c0, c1, c2, n0 || fn, n1 || fn, n2 || fn);
    this.tri(p0, p2, p3, c0, c2, c3, n0 || fn, n2 || fn, n3 || fn);
  }

  tube(p0, p1, r0, r1, segs, col0, col1 = col0, cap0 = true, cap1 = true) {
    const d = vSub(p1, p0);
    const len = Math.hypot(d[0], d[1], d[2]);
    if (len < 1e-6) return;
    const ax = vScale(d, 1 / len);
    const ref = Math.abs(ax[2]) < 0.85 ? [0, 0, 1] : [1, 0, 0];
    const u = vNorm(vCross(ref, ax));
    const v = vNorm(vCross(ax, u));
    const slope = (r0 - r1) / len;
    const pts0 = [];
    const pts1 = [];
    const nrs = [];
    for (let i = 0; i < segs; i++) {
      const a = (i / segs) * Math.PI * 2;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      const radial = [u[0] * ca + v[0] * sa, u[1] * ca + v[1] * sa, u[2] * ca + v[2] * sa];
      pts0.push(vAdd(p0, vScale(radial, r0)));
      pts1.push(vAdd(p1, vScale(radial, r1)));
      nrs.push(vNorm(vAdd(radial, vScale(ax, slope))));
    }
    for (let i = 0; i < segs; i++) {
      const j = (i + 1) % segs;
      this.quad(pts0[i], pts0[j], pts1[j], pts1[i], col0, col0, col1, col1, nrs[i], nrs[j], nrs[j], nrs[i]);
    }
    if (cap0 && r0 > 1e-4) {
      const nBack = vScale(ax, -1);
      for (let i = 1; i < segs - 1; i++) {
        this.tri(pts0[0], pts0[i + 1], pts0[i], col0, col0, col0, nBack, nBack, nBack);
      }
    }
    if (cap1 && r1 > 1e-4) {
      for (let i = 1; i < segs - 1; i++) {
        this.tri(pts1[0], pts1[i], pts1[i + 1], col1, col1, col1, ax, ax, ax);
      }
    }
  }

  box(cx, cy, cz, hx, hy, hz, colTop, colBot = cShade(colTop, 0.85), xf = null) {
    const corners = [
      [-hx, -hy, -hz], [hx, -hy, -hz], [hx, hy, -hz], [-hx, hy, -hz],
      [-hx, -hy, hz], [hx, -hy, hz], [hx, hy, hz], [-hx, hy, hz],
    ].map(([x, y, z]) => {
      const p = [cx + x, cy + y, cz + z];
      return xf ? xf(p) : p;
    });
    const faces = [
      [4, 5, 6, 7, colTop, colTop],
      [0, 3, 2, 1, colBot, colBot],
      [1, 2, 6, 5, colBot, colTop],
      [3, 0, 4, 7, colBot, colTop],
      [2, 3, 7, 6, colBot, colTop],
      [0, 1, 5, 4, colBot, colTop],
    ];
    for (const [a, b, c, d, cLo, cHi] of faces) {
      const cA = a >= 4 ? cHi : cLo;
      const cB = b >= 4 ? cHi : cLo;
      const cC = c >= 4 ? cHi : cLo;
      const cD = d >= 4 ? cHi : cLo;
      this.quad(corners[a], corners[b], corners[c], corners[d], cA, cB, cC, cD);
    }
  }

  cylinder(cx, cy, cz, radius, height, segs, col, axis = "y", cap0 = true, cap1 = true) {
    const halfH = height * 0.5;
    let p0;
    let p1;
    if (axis === "x") {
      p0 = [cx - halfH, cy, cz];
      p1 = [cx + halfH, cy, cz];
    } else if (axis === "z") {
      p0 = [cx, cy, cz - halfH];
      p1 = [cx, cy, cz + halfH];
    } else {
      p0 = [cx, cy - halfH, cz];
      p1 = [cx, cy + halfH, cz];
    }
    this.tube(p0, p1, radius, radius, segs, col, col, cap0, cap1);
  }

  toBufferGeometry(THREE) {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(this.pos), 3));
    g.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(this.nor), 3));
    g.setAttribute("color", new THREE.BufferAttribute(new Float32Array(this.col), this.cc));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

// ---------------------------------------------------------------------------
// 11R22.5 Heavy Truck Tire & Alcoa 10-Lug Wheel Builders (X-aligned, roll = rotation.x)
// ---------------------------------------------------------------------------
function addTruckTireAndRim(acc, centerX, sideSign, P) {
  const outerR = SEMI_DIMENSIONS.wheelRadius; // 0.505
  const beadR = 0.286; // 22.5" rim
  const halfW = 0.14;  // 0.28 m tire width
  const segs = 28;     // divisible by 4 -> exact z = -0.505 bottom contact

  for (let i = 0; i < segs; i++) {
    const a0 = (i / segs) * Math.PI * 2;
    const a1 = ((i + 1) / segs) * Math.PI * 2;
    const c0 = Math.cos(a0);
    const s0 = Math.sin(a0);
    const c1 = Math.cos(a1);
    const s1 = Math.sin(a1);

    const pT0L = [centerX - halfW, c0 * outerR, s0 * outerR];
    const pT1L = [centerX - halfW, c1 * outerR, s1 * outerR];
    const pT1R = [centerX + halfW, c1 * outerR, s1 * outerR];
    const pT0R = [centerX + halfW, c0 * outerR, s0 * outerR];
    acc.quad(pT0L, pT1L, pT1R, pT0R, P.tireRubber);

    const pB0R = [centerX + halfW * 0.82, c0 * beadR, s0 * beadR];
    const pB1R = [centerX + halfW * 0.82, c1 * beadR, s1 * beadR];
    acc.quad(pT0R, pT1R, pB1R, pB0R, P.tireRubber);

    const pB0L = [centerX - halfW * 0.82, c0 * beadR, s0 * beadR];
    const pB1L = [centerX - halfW * 0.82, c1 * beadR, s1 * beadR];
    acc.quad(pB0L, pB1L, pT1L, pT0L, P.tireRubber);

    // Shoulder traction ribs
    if (i % 2 === 0) {
      const shX = centerX + sideSign * (halfW + 0.008);
      const pL0 = [centerX + sideSign * halfW, c0 * (outerR - 0.01), s0 * (outerR - 0.01)];
      const pL1 = [centerX + sideSign * halfW, c1 * (outerR - 0.01), s1 * (outerR - 0.01)];
      const pLW1 = [shX, c1 * (outerR - 0.06), s1 * (outerR - 0.06)];
      const pLW0 = [shX, c0 * (outerR - 0.06), s0 * (outerR - 0.06)];
      if (sideSign > 0) {
        acc.quad(pL0, pL1, pLW1, pLW0, P.treadShoulder);
      } else {
        acc.quad(pLW0, pLW1, pL1, pL0, P.treadShoulder);
      }
    }

    // Alcoa deep-dish rim face facing outward
    const dishInnerR = 0.125;
    const faceX = centerX + sideSign * halfW * 0.82;
    const dishX = faceX - sideSign * 0.055;
    const pRim0 = [faceX, c0 * beadR, s0 * beadR];
    const pRim1 = [faceX, c1 * beadR, s1 * beadR];
    const pDish1 = [dishX, c1 * dishInnerR, s1 * dishInnerR];
    const pDish0 = [dishX, c0 * dishInnerR, s0 * dishInnerR];
    if (sideSign > 0) {
      acc.quad(pRim0, pRim1, pDish1, pDish0, P.aluminumPolished);
    } else {
      acc.quad(pRim1, pRim0, pDish0, pDish1, P.aluminumPolished);
    }
  }

  // Central hub & 10 Alcoa lug nuts on outward dish
  const hubX = centerX + sideSign * (halfW * 0.82 - 0.025);
  acc.cylinder(hubX, 0, 0, 0.075, 0.07, 12, P.chassisSteel, "x");
  const lugR = 0.11;
  const lugX = centerX + sideSign * (halfW * 0.82 - 0.045);
  for (let l = 0; l < 10; l++) {
    const la = (l / 10) * Math.PI * 2;
    acc.box(lugX, Math.cos(la) * lugR, Math.sin(la) * lugR, 0.012, 0.013, 0.013, P.chromeBright);
  }
}

function buildSteerWheelGeom(t, sideSign, P) {
  const acc = new GeomAcc();
  addTruckTireAndRim(acc, 0, sideSign, P);
  return acc.toBufferGeometry(t);
}

function buildTandemDualsGeom(t, P) {
  const acc = new GeomAcc();
  // Live drive axle beam + central hub flanges
  acc.cylinder(0, 0, 0, 0.07, 2.34, 12, P.chassisSteel, "x");
  // Inner and outer duals on left (-X) and right (+X)
  addTruckTireAndRim(acc, -SEMI_DIMENSIONS.dualInnerX, -1, P);
  addTruckTireAndRim(acc, -SEMI_DIMENSIONS.dualOuterX, -1, P);
  addTruckTireAndRim(acc, SEMI_DIMENSIONS.dualInnerX, 1, P);
  addTruckTireAndRim(acc, SEMI_DIMENSIONS.dualOuterX, 1, P);
  return acc.toBufferGeometry(t);
}

// ---------------------------------------------------------------------------
// Main Vehicle Assemblies (6 Merged PBR Meshes + Articulated Sub-Groups)
// ---------------------------------------------------------------------------
function buildBodyPaint(acc, P) {
  // 1. Long tapered hood (y: +1.05 .. +3.30, half-width 0.66 -> 0.56, z_top 2.08 -> 2.04)
  const cowlHW = 0.66;
  const noseHW = 0.56;
  const yCowl = 1.05;
  const yNose = 3.30;
  const zCowlTop = 2.08;
  const zNoseTop = 2.04;
  const zHoodBot = 1.32;

  // Hood top deck
  acc.quad(
    [-cowlHW, yCowl, zCowlTop],
    [cowlHW, yCowl, zCowlTop],
    [noseHW, yNose, zNoseTop],
    [-noseHW, yNose, zNoseTop],
    P.liveryPrimary,
  );
  // Left & right hood side panels
  acc.quad(
    [-cowlHW, yCowl, zCowlTop],
    [-noseHW, yNose, zNoseTop],
    [-noseHW, yNose, zHoodBot],
    [-cowlHW, yCowl, zHoodBot],
    P.liveryPrimary, P.liveryPrimary, P.liveryDark, P.liveryDark,
  );
  acc.quad(
    [noseHW, yNose, zNoseTop],
    [cowlHW, yCowl, zCowlTop],
    [cowlHW, yCowl, zHoodBot],
    [noseHW, yNose, zHoodBot],
    P.liveryPrimary, P.liveryPrimary, P.liveryDark, P.liveryDark,
  );
  // Hood side accent stripes
  for (const sx of [-1, 1]) {
    acc.quad(
      [sx * (cowlHW + 0.004), yCowl + 0.06, 1.88],
      [sx * (noseHW + 0.004), yNose - 0.08, 1.84],
      [sx * (noseHW + 0.004), yNose - 0.08, 1.76],
      [sx * (cowlHW + 0.004), yCowl + 0.06, 1.80],
      P.liveryStripe,
    );
  }
  // Radiator shell painted surround framing grille (y = +3.30..+3.36)
  acc.box(0.0, 3.33, 2.09, 0.58, 0.04, 0.05, P.liveryPrimary, P.liveryDark);

  // 2. Sculpted front fenders over steer tires (x: ±0.64..±1.22, y: +1.15..+3.28)
  for (const sx of [-1, 1]) {
    const fx = sx * 0.93;
    // Fender flat crown above tire
    acc.box(fx, 2.55, 1.36, 0.28, 0.52, 0.03, P.liveryPrimary, P.liveryDark);
    // Front curved apron down toward bumper
    acc.box(fx, 3.10, 1.12, 0.28, 0.14, 0.22, P.liveryPrimary, P.liveryDark, (p) => [
      p[0],
      p[1] + (p[2] - 1.12) * -0.25,
      p[2],
    ]);
    // Rear trailing fender skirt back to cowl
    acc.box(fx, 1.68, 1.12, 0.28, 0.48, 0.22, P.liveryPrimary, P.liveryDark);
    // Outer fender valance lip
    acc.box(sx * 1.205, 2.40, 1.24, 0.015, 0.72, 0.12, P.liveryDark);
  }

  // 3. Day-Cab body shell (y: -0.30 .. +1.05, x: ±0.98, z: 1.22 .. 3.05)
  // Cab floor outer sill
  acc.box(0.0, 0.375, 1.24, 0.98, 0.675, 0.03, P.liveryDark, P.liveryDark);
  // Cowl firewall below windshield (z: 1.25 .. 2.08)
  acc.box(0.0, 1.03, 1.665, 0.98, 0.03, 0.415, P.liveryPrimary, P.liveryDark);
  // Left & Right cab lower door panels (z: 1.25 .. 2.12)
  for (const sx of [-1, 1]) {
    acc.box(sx * 0.955, 0.375, 1.685, 0.025, 0.675, 0.435, P.liveryPrimary, P.liveryDark);
    // Door accent stripe
    acc.box(sx * 0.983, 0.375, 1.82, 0.005, 0.62, 0.04, P.liveryStripe, P.liveryStripe);
    // Front A-pillars
    acc.box(sx * 0.94, 0.99, 2.52, 0.04, 0.06, 0.44, P.liveryPrimary, P.liveryPrimary);
    // Rear B-pillars (leaving x: -0.76..+0.76 open for rear cab window)
    acc.box(sx * 0.87, -0.275, 2.48, 0.11, 0.025, 0.36, P.liveryPrimary, P.liveryPrimary);
    // Upper door window headers
    acc.box(sx * 0.94, 0.375, 2.93, 0.04, 0.675, 0.09, P.liveryPrimary, P.liveryPrimary);
  }
  // Windshield center mullion & upper windshield header
  acc.box(0.0, 0.985, 2.50, 0.03, 0.03, 0.45, P.liveryPrimary, P.liveryPrimary);
  acc.box(0.0, 0.96, 2.94, 0.98, 0.06, 0.10, P.liveryPrimary, P.liveryPrimary);
  // Solid lower rear cab wall (y = -0.30, z: 1.25 .. 2.12)
  acc.box(0.0, -0.275, 1.685, 0.98, 0.025, 0.435, P.liveryPrimary, P.liveryDark);
  // Upper rear cab header (z: 2.84 .. 3.02)
  acc.box(0.0, -0.275, 2.93, 0.98, 0.025, 0.09, P.liveryPrimary, P.liveryPrimary);
  // Cab roof cap (top at z = 3.05)
  acc.box(0.0, 0.36, 3.01, 0.98, 0.675, 0.04, P.liveryPrimary, P.liveryDark);
  // Exterior sun visor over windshield
  acc.box(0.0, 1.07, 2.96, 0.99, 0.15, 0.025, P.liveryPrimary, P.liveryDark);
}

function buildChromeTrim(acc, P) {
  // 1. Heavy Chrome Texas Bumper (y: +3.39 .. +3.55, x: ±1.20, z: 0.30 .. 0.72)
  acc.box(0.0, 3.47, 0.51, 1.20, 0.08, 0.21, P.chromeBright, P.aluminumPolished);
  // Chrome tow hooks on bumper
  for (const sx of [-1, 1]) {
    acc.box(sx * 0.45, 3.53, 0.42, 0.03, 0.02, 0.05, P.chromeBright);
  }

  // 2. Tall Vertical-Slat Chrome Radiator Grille (x: ±0.56, y: +3.30..+3.38, z: 0.80..2.08)
  acc.box(0.0, 3.35, 2.06, 0.57, 0.03, 0.04, P.chromeBright); // top grille frame
  acc.box(0.0, 3.35, 0.82, 0.57, 0.03, 0.04, P.chromeBright); // bottom grille frame
  acc.box(-0.55, 3.35, 1.44, 0.03, 0.03, 0.62, P.chromeBright); // left surround
  acc.box(0.55, 3.35, 1.44, 0.03, 0.03, 0.62, P.chromeBright);  // right surround
  const slatCount = 11;
  for (let i = 0; i < slatCount; i++) {
    const sx = -0.44 + (i * 0.88) / (slatCount - 1);
    acc.box(sx, 3.36, 1.44, 0.012, 0.02, 0.60, P.chromeBright);
  }
  // Hood center chrome spine trim + side louver vents + latches
  acc.tube([0, 1.05, 2.09], [0, 3.31, 2.05], 0.022, 0.018, 8, P.chromeBright);
  for (const sx of [-1, 1]) {
    acc.box(sx * 0.63, 1.45, 1.66, 0.01, 0.24, 0.14, P.aluminumPolished);
    acc.box(sx * 0.62, 1.20, 1.36, 0.02, 0.03, 0.04, P.chromeBright);
    acc.box(sx * 0.58, 3.12, 1.36, 0.02, 0.03, 0.04, P.chromeBright);
  }

  // 3. Twin Round Chrome Headlight Pods on Fenders
  for (const sx of [-1, 1]) {
    for (const hx of [0.88, 1.04]) {
      acc.cylinder(sx * hx, 3.18, 1.24, 0.085, 0.14, 16, P.chromeBright, "y");
    }
    // Twin external chrome air-cleaner cans flanking cowl
    acc.cylinder(sx * 1.04, 1.12, 1.85, 0.16, 0.80, 16, P.chromeBright, "z");
    acc.cylinder(sx * 1.04, 1.12, 2.26, 0.17, 0.04, 16, P.aluminumPolished, "z");
    acc.tube([sx * 0.96, 1.12, 1.90], [sx * 0.66, 1.15, 1.85], 0.05, 0.05, 8, P.chromeBright);
  }

  // 4. Dual Vertical Chrome Exhaust Stacks (x = ±1.08, y = -0.44, z_top = 3.72)
  for (const sx of [-1, 1]) {
    const ex = sx * SEMI_DIMENSIONS.exhaustStackX;
    const ey = SEMI_DIMENSIONS.exhaustStackY;
    // Lower elbow from under cab to stack base
    acc.tube([sx * 0.45, -0.35, 0.72], [ex, ey, 1.35], 0.058, 0.064, 10, P.chromeBright);
    // Main vertical stack pipe reaching exact top z = 3.72
    acc.tube([ex, ey, 1.35], [ex, ey, SEMI_DIMENSIONS.exhaustStackTopZ], 0.068, 0.068, 14, P.chromeBright);
    // Angled turnout tip (bounded below z = 3.72)
    acc.tube([ex, ey, 3.56], [ex + sx * 0.10, ey - 0.10, 3.63], 0.064, 0.064, 12, P.chromeBright);
    // Perforated heat shield
    acc.cylinder(ex, ey, 2.22, 0.095, 1.45, 14, P.aluminumPolished, "z");
  }

  // 5. Twin Cylindrical Aluminum Saddle Fuel Tanks (x = ±1.02, y: -0.95..+0.55, z = 0.68, r = 0.30)
  for (const sx of [-1, 1]) {
    acc.cylinder(sx * SEMI_DIMENSIONS.fuelTankX, -0.20, 0.68, SEMI_DIMENSIONS.fuelTankRadius, 1.50, 20, P.aluminumPolished, "y");
    // Entry steps on fuel tanks + cab entry grab handles
    acc.box(sx * 1.15, 0.35, 0.42, 0.10, 0.32, 0.02, P.aluminumPolished);
    acc.box(sx * 1.15, 0.35, 0.85, 0.10, 0.32, 0.02, P.aluminumPolished);
    acc.tube([sx * 1.00, 0.02, 1.35], [sx * 1.00, 0.02, 2.25], 0.015, 0.015, 8, P.chromeBright);
  }

  // 6. West Coast Rectangular Mirrors & Dual Roof Air Horns
  for (const sx of [-1, 1]) {
    // Mirror housing & glass backing
    acc.box(sx * 1.21, 0.88, 2.35, 0.03, 0.09, 0.22, P.chromeBright, P.aluminumPolished);
    // Upper & lower tubular mirror brackets
    acc.tube([sx * 0.98, 0.92, 2.62], [sx * 1.21, 0.88, 2.55], 0.012, 0.012, 6, P.chromeBright);
    acc.tube([sx * 0.98, 0.92, 2.08], [sx * 1.21, 0.88, 2.15], 0.012, 0.012, 6, P.chromeBright);
    // Dual roof air horns
    acc.tube([sx * 0.48, 0.25, 3.08], [sx * 0.48, 0.65, 3.08], 0.022, 0.048, 12, P.chromeBright);
  }

  // 7. Gauge bezels on interior dashboard
  for (const gx of [-0.62, -0.52, -0.42, -0.32]) {
    acc.cylinder(gx, 0.905, 1.98, 0.042, 0.014, 14, P.chromeBright, "y");
  }
}

function buildChassisSteel(acc, P) {
  // 1. Twin C-channel steel frame rails (x = ±0.43, y: -3.41 .. +3.45, z: 0.66 .. 0.92)
  for (const sx of [-1, 1]) {
    acc.box(sx * 0.43, 0.02, 0.79, 0.045, 3.43, 0.13, P.chassisSteel, P.frameDark);
  }
  // Frame crossmembers
  for (const cy of [-3.30, -2.67, -2.01, -1.35, -0.58, 0.50, 1.75, 2.65, 3.30]) {
    acc.box(0.0, cy, 0.78, 0.39, 0.06, 0.09, P.chassisSteel, P.frameDark);
  }
  // Rear tail-lamp bar (y = -3.41 -> min.y = -3.45)
  acc.box(0.0, -3.41, 0.78, 1.18, 0.04, 0.09, P.chassisSteel, P.frameDark);

  // 2. Recessed dark radiator core behind grille
  acc.box(0.0, 3.29, 1.44, 0.52, 0.03, 0.58, P.radiatorCore, P.radiatorCore);

  // 3. Front steer axle beam & tandem drive axle beams + diffs + air-ride bags
  acc.box(0.0, SEMI_DIMENSIONS.steerAxleY, 0.48, 0.86, 0.05, 0.05, P.chassisSteel, P.frameDark);
  for (const ay of [SEMI_DIMENSIONS.tandemFrontY, SEMI_DIMENSIONS.tandemRearY]) {
    acc.cylinder(0.0, ay, 0.505, 0.08, 1.35, 12, P.chassisSteel, "x");
    acc.cylinder(0.0, ay, 0.505, 0.18, 0.28, 14, P.chassisSteel, "y");
    for (const sx of [-1, 1]) {
      acc.cylinder(sx * 0.43, ay, 0.64, 0.11, 0.16, 10, P.frameDark, "z"); // air-ride bag
    }
  }
  // Driveshaft between cab & tandem
  acc.tube([0.0, 0.60, 0.62], [0.0, SEMI_DIMENSIONS.tandemRearY, 0.52], 0.05, 0.05, 10, P.chassisSteel);

  // 4. Rear quarter fenders over tandem lead tires
  for (const sx of [-1, 1]) {
    acc.box(sx * 0.96, -0.95, 1.08, 0.26, 0.32, 0.02, P.chassisSteel, P.frameDark, (p) => [
      p[0], p[1], p[2] - Math.max(0, (p[1] + 0.95)) * 0.25,
    ]);
  }

  // 5. Open Headache Rack behind cab (y = -0.43, open central window so rear cab sightline is unobstructed)
  for (const sx of [-1, 1]) {
    acc.box(sx * 0.88, -0.43, 1.96, 0.06, 0.025, 0.98, P.chassisSteel, P.frameDark);
    acc.box(sx * 0.79, -0.43, 1.99, 0.02, 0.02, 0.89, P.chassisSteel, P.frameDark); // side frame bar outside [-0.76, +0.76]
  }
  acc.box(0.0, -0.43, 1.04, 0.94, 0.025, 0.06, P.chassisSteel, P.frameDark); // lower rack bar
  acc.box(0.0, -0.43, 2.00, 0.94, 0.025, 0.03, P.chassisSteel, P.frameDark); // window-sill mid-rail (z <= 2.03)
  acc.box(0.0, -0.43, 2.91, 0.94, 0.025, 0.03, P.chassisSteel, P.frameDark); // upper cross-bar above window (z >= 2.88)
  for (const lx of [-0.60, -0.40, -0.20, 0.0, 0.20, 0.40, 0.60]) {
    acc.box(lx, -0.43, 1.535, 0.018, 0.02, 0.435, P.chassisSteel, P.frameDark); // lower louvers strictly below z = 2.04
  }

  // 6. Fifth-wheel slider base below fifthWheelPivot
  acc.box(0.0, SEMI_DIMENSIONS.fifthWheelY, 0.88, 0.48, 0.56, 0.04, P.chassisSteel, P.frameDark);

  // 7. Interior dash console & driver pedals
  acc.box(0.0, 0.88, 1.82, 0.90, 0.14, 0.22, P.dashCharcoal, P.frameDark);
  acc.box(-0.56, 0.90, 1.38, 0.04, 0.03, 0.06, P.chassisSteel); // brake pedal
  acc.box(-0.44, 0.90, 1.36, 0.03, 0.05, 0.04, P.chassisSteel); // throttle pedal
}

function buildInteriorAndRubber(acc, P) {
  // 1. 2 High-Back Air-Ride Seats (Driver [-0.52, +0.28, 1.72], Passenger [+0.52, +0.28, 1.72])
  for (const [sx, sy, sz] of [SEMI_DIMENSIONS.seatDriver, SEMI_DIMENSIONS.seatPassenger]) {
    // Air-ride pedestal base
    acc.box(sx, sy, sz - 0.28, 0.16, 0.18, 0.20, P.chassisSteel, P.frameDark);
    // Seat cushion (top at sz = 1.72)
    acc.box(sx, sy, sz - 0.06, 0.22, 0.24, 0.06, P.seatVinyl, P.seatBolster);
    // Side bolsters
    acc.box(sx - 0.20, sy, sz - 0.02, 0.03, 0.22, 0.05, P.seatBolster);
    acc.box(sx + 0.20, sy, sz - 0.02, 0.03, 0.22, 0.05, P.seatBolster);
    // High backrest + integrated headrest
    acc.box(sx, sy - 0.21, sz + 0.34, 0.21, 0.05, 0.36, P.seatVinyl, P.seatBolster);
    acc.box(sx, sy - 0.21, sz + 0.78, 0.13, 0.045, 0.10, P.seatBolster);
  }

  // 2. Cab floor mat & center engine doghouse
  acc.box(0.0, 0.38, 1.26, 0.88, 0.62, 0.02, P.frameDark);
  acc.box(0.0, 0.72, 1.38, 0.22, 0.30, 0.12, P.dashCharcoal);

  // 3. Yellow (tractor) & Red (trailer) air-brake dash knobs
  acc.box(-0.18, 0.74, 1.88, 0.022, 0.025, 0.022, P.airBrakeYellow);
  acc.box(-0.12, 0.74, 1.88, 0.022, 0.025, 0.022, P.airRed);

  // 4. Fuel tank mounting straps
  for (const sx of [-1, 1]) {
    for (const ty of [-0.70, 0.30]) {
      acc.cylinder(sx * SEMI_DIMENSIONS.fuelTankX, ty, 0.68, SEMI_DIMENSIONS.fuelTankRadius + 0.012, 0.05, 18, P.frameDark, "y");
    }
  }

  // 5. Rear mudflaps behind tandem rear axle (y = -3.28)
  for (const sx of [-1, 1]) {
    acc.box(sx * 0.93, -3.28, 0.56, 0.28, 0.015, 0.29, P.tireRubber);
  }
}

function buildCabGlass(acc, P) {
  // Split flat front windshield panes (left & right of center mullion)
  for (const sx of [-1, 1]) {
    acc.quad(
      [sx * 0.04, 1.00, 2.08],
      [sx * 0.90, 1.00, 2.08],
      [sx * 0.90, 0.92, 2.90],
      [sx * 0.04, 0.92, 2.90],
      P.glassClear,
    );
    // Side door windows
    acc.box(sx * 0.955, 0.375, 2.50, 0.008, 0.56, 0.34, P.glassClear);
  }
  // Clear rear cab window pane (y = -0.30, x: -0.76 .. +0.76, z: 2.12 .. 2.84)
  acc.box(0.0, -0.30, 2.48, 0.76, 0.008, 0.36, P.glassClear);
}

function buildLamps(acc, P) {
  // 4 Front headlight lenses + 2 bumper amber fogs
  for (const sx of [-1, 1]) {
    for (const hx of [0.88, 1.04]) {
      acc.cylinder(sx * hx, 3.255, 1.24, 0.072, 0.012, 14, P.headlightLens, "y");
    }
    acc.box(sx * 0.88, 3.55, 0.44, 0.06, 0.008, 0.035, P.amberMarker);
    // Fender-top turn markers
    acc.box(sx * 1.02, 2.65, 1.40, 0.04, 0.06, 0.025, P.amberMarker);
  }
  // 5 Amber ICC roof marker lamps (y = +0.95, z = 3.03)
  for (const mx of [-0.55, -0.25, 0.0, 0.25, 0.55]) {
    acc.box(mx, 0.95, 3.03, 0.035, 0.045, 0.02, P.amberMarker);
  }
  // Rear tail/brake & reverse lamp clusters (y = -3.445, stays within yMin = -3.45)
  for (const sx of [-1, 1]) {
    acc.box(sx * 0.82, -3.445, 0.78, 0.14, 0.005, 0.045, P.rubyTail);
    acc.box(sx * 1.05, -3.445, 0.78, 0.06, 0.005, 0.045, P.reverseWhite);
  }
}

function buildSteeringWheelGeom(t, P) {
  const acc = new GeomAcc();
  const rimR = SEMI_DIMENSIONS.steeringWheelRadius; // 0.24
  const rimTubeR = 0.018;
  const segs = 24;
  // Steering column shaft down toward floor
  acc.tube([0, -0.35, -0.58], [0, 0, 0], 0.028, 0.028, 10, P.chassisSteel);
  // Chrome center horn cap
  acc.cylinder(0, 0, 0, 0.055, 0.035, 14, P.chromeBright, "z");
  // 4-spoke Class 8 truck wheel
  for (let s = 0; s < 4; s++) {
    const ang = (s * Math.PI) / 2 + Math.PI / 4;
    acc.tube([0, 0, 0], [Math.cos(ang) * rimR, Math.sin(ang) * rimR, 0], 0.012, 0.012, 6, P.chromeBright);
  }
  // Outer rim torus
  for (let i = 0; i < segs; i++) {
    const a0 = (i / segs) * Math.PI * 2;
    const a1 = ((i + 1) / segs) * Math.PI * 2;
    acc.tube(
      [Math.cos(a0) * rimR, Math.sin(a0) * rimR, 0],
      [Math.cos(a1) * rimR, Math.sin(a1) * rimR, 0],
      rimTubeR,
      rimTubeR,
      8,
      P.tireRubber,
    );
  }
  return acc.toBufferGeometry(t);
}

function buildShifterGeom(t, P) {
  const acc = new GeomAcc();
  // Tall Eaton-Fuller 10-speed chrome cane from floor mount (-0.22, +0.58, 1.48)
  acc.tube([0, 0, 0], [0, -0.06, 0.56], 0.014, 0.012, 8, P.chromeBright);
  acc.cylinder(0, -0.06, 0.58, 0.026, 0.055, 12, P.tireRubber, "z"); // Eaton-Fuller range-splitter knob
  acc.box(0.018, -0.06, 0.585, 0.008, 0.014, 0.016, P.airRed); // splitter toggle
  return acc.toBufferGeometry(t);
}

function buildFifthWheelGeom(t, P) {
  const acc = new GeomAcc();
  // JOST-style fifth-wheel skid plate: top surface at local z = 0 (world z = 0.96 m)
  // Left & right rear V-throat prongs opening toward -Y
  acc.box(0.0, 0.16, -0.0225, 0.48, 0.36, 0.0225, P.chassisSteel, P.frameDark);
  acc.box(-0.30, -0.34, -0.0225, 0.18, 0.18, 0.0225, P.chassisSteel, P.frameDark);
  acc.box(0.30, -0.34, -0.0225, 0.18, 0.18, 0.0225, P.chassisSteel, P.frameDark);
  // Locking jaws collar & release handle
  acc.box(0.0, -0.04, -0.035, 0.10, 0.06, 0.015, P.aluminumPolished);
  acc.tube([0.12, 0.0, -0.03], [0.56, 0.0, -0.03], 0.012, 0.012, 6, P.chromeBright);
  return acc.toBufferGeometry(t);
}

function buildGladHandHosesGeom(t, P) {
  const acc = new GeomAcc();
  // Red emergency + blue service coiled air lines + black electrical pigtail hanging from headache rack
  for (const [hx, col] of [[-0.22, P.airRed], [0.0, P.frameDark], [0.22, P.airBlue]]) {
    const coils = 8;
    for (let i = 0; i < coils; i++) {
      const y0 = -(i / coils) * 0.45;
      const y1 = -((i + 1) / coils) * 0.45;
      const z0 = -0.18 - Math.sin((i / coils) * Math.PI) * 0.18;
      const z1 = -0.18 - Math.sin(((i + 1) / coils) * Math.PI) * 0.18;
      const dx0 = Math.sin(i * 1.8) * 0.03;
      const dx1 = Math.sin((i + 1) * 1.8) * 0.03;
      acc.tube([hx + dx0, y0, z0], [hx + dx1, y1, z1], 0.016, 0.016, 6, col);
    }
    acc.box(hx, -0.46, -0.18, 0.028, 0.028, 0.028, P.aluminumPolished);
  }
  return acc.toBufferGeometry(t);
}

// ---------------------------------------------------------------------------
// Main Factory: buildSemiTruck
// ---------------------------------------------------------------------------
export function buildSemiTruck(three, profile = {}, options = {}) {
  const t = three || THREE_DEFAULT;
  const prof = (profile && typeof profile === "object") ? profile : {};
  const opts = (options && typeof options === "object") ? options : {};
  const liveScene3d = opts.liveScene3d || { activeLights: [] };

  const liverySpec = getSemiLivery(opts.liveryId ?? opts.livery ?? prof.liveryId ?? prof.livery ?? 0);
  const P = makePaletteLinear(t, liverySpec);

  const root = new t.Group();
  root.name = "semi-379-root";
  root.userData = { profileKey: "semi-379", livery: liverySpec.key, vehicleClass: 3 };

  // ---- PBR Materials (color: 0xffffff + vertexColors: true + CSM shader patch) ----
  const matBody = new t.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.38,
    metalness: 0.32,
    vertexColors: true,
    side: t.DoubleSide,
  });
  matBody.castShadow = true;
  matBody.receiveShadow = true;
  if (opts.csmState) installCsmShaderPatch(matBody, opts.csmState);

  const matChrome = new t.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.16,
    metalness: 0.92,
    vertexColors: true,
  });
  matChrome.castShadow = true;
  matChrome.receiveShadow = true;
  if (opts.csmState) installCsmShaderPatch(matChrome, opts.csmState);

  const matChassis = new t.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.55,
    metalness: 0.45,
    vertexColors: true,
  });
  matChassis.castShadow = true;
  matChassis.receiveShadow = true;
  if (opts.csmState) installCsmShaderPatch(matChassis, opts.csmState);

  const matRubber = new t.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.84,
    metalness: 0.04,
    vertexColors: true,
  });
  matRubber.castShadow = true;
  matRubber.receiveShadow = true;
  if (opts.csmState) installCsmShaderPatch(matRubber, opts.csmState);

  const matGlass = new t.MeshStandardMaterial({
    color: 0x0e161a,
    roughness: 0.10,
    metalness: 0.12,
    opacity: 0.32,
    transparent: true,
    depthWrite: false,
    side: t.DoubleSide,
  });

  const matLamps = new t.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    emissive: 0xffffff,
    emissiveIntensity: 0.65,
    roughness: 0.25,
  });
  matLamps.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      "vec3 totalEmissiveRadiance = emissive;",
      "vec3 totalEmissiveRadiance = emissive * vColor.rgb;",
    );
  };

  const matEmissiveFx = new t.MeshStandardMaterial({
    color: 0xff6600,
    emissive: 0xff3300,
    emissiveIntensity: 0.85,
    roughness: 0.20,
    metalness: 0.50,
  });

  const matAdditive = new t.MeshBasicMaterial({
    color: 0xffe8b8,
    transparent: true,
    opacity: 0.0,
    blending: t.AdditiveBlending,
    depthWrite: false,
  });

  // ---- 1. Running Gear (Steer FL/FR + Tandem Front/Rear Duals = 4 draw calls) ----
  const suspFL = new t.Group();
  suspFL.name = "suspFL";
  suspFL.position.set(-1.06, SEMI_DIMENSIONS.steerAxleY, SEMI_DIMENSIONS.wheelRadius);
  const steerPivotFL = new t.Group();
  steerPivotFL.name = "steerPivotFL";
  suspFL.add(steerPivotFL);

  const wheelFL = new t.Mesh(buildSteerWheelGeom(t, -1, P), matRubber);
  wheelFL.name = "wheelFL";
  wheelFL.castShadow = true;
  wheelFL.receiveShadow = true;
  steerPivotFL.add(wheelFL);

  const suspFR = new t.Group();
  suspFR.name = "suspFR";
  suspFR.position.set(1.06, SEMI_DIMENSIONS.steerAxleY, SEMI_DIMENSIONS.wheelRadius);
  const steerPivotFR = new t.Group();
  steerPivotFR.name = "steerPivotFR";
  suspFR.add(steerPivotFR);

  const wheelFR = new t.Mesh(buildSteerWheelGeom(t, 1, P), matRubber);
  wheelFR.name = "wheelFR";
  wheelFR.castShadow = true;
  wheelFR.receiveShadow = true;
  steerPivotFR.add(wheelFR);

  const geomTandemDuals = buildTandemDualsGeom(t, P);

  const suspTandemFront = new t.Group();
  suspTandemFront.name = "suspTandemFront";
  suspTandemFront.position.set(0, SEMI_DIMENSIONS.tandemFrontY, SEMI_DIMENSIONS.wheelRadius);
  const wheelTandemFront = new t.Mesh(geomTandemDuals, matRubber);
  wheelTandemFront.name = "wheelTandemFront";
  wheelTandemFront.castShadow = true;
  wheelTandemFront.receiveShadow = true;
  suspTandemFront.add(wheelTandemFront);

  const suspTandemRear = new t.Group();
  suspTandemRear.name = "suspTandemRear";
  suspTandemRear.position.set(0, SEMI_DIMENSIONS.tandemRearY, SEMI_DIMENSIONS.wheelRadius);
  const wheelTandemRear = new t.Mesh(geomTandemDuals, matRubber);
  wheelTandemRear.name = "wheelTandemRear";
  wheelTandemRear.castShadow = true;
  wheelTandemRear.receiveShadow = true;
  suspTandemRear.add(wheelTandemRear);

  root.add(suspFL, suspFR, suspTandemFront, suspTandemRear);

  // ---- 2. Chassis Body Group (6 merged static meshes + 5 articulated interior/coupling meshes + beams) ----
  const chassisBodyGroup = new t.Group();
  chassisBodyGroup.name = "chassisBodyGroup";
  root.add(chassisBodyGroup);

  const accBody = new GeomAcc();
  buildBodyPaint(accBody, P);
  const bodyMesh = new t.Mesh(accBody.toBufferGeometry(t), matBody);
  bodyMesh.name = "semi-body-paint";
  bodyMesh.castShadow = true;
  bodyMesh.receiveShadow = true;
  chassisBodyGroup.add(bodyMesh);

  const accChrome = new GeomAcc();
  buildChromeTrim(accChrome, P);
  const chromeMesh = new t.Mesh(accChrome.toBufferGeometry(t), matChrome);
  chromeMesh.name = "semi-chrome-trim";
  chromeMesh.castShadow = true;
  chromeMesh.receiveShadow = true;
  chassisBodyGroup.add(chromeMesh);

  const accChassis = new GeomAcc();
  buildChassisSteel(accChassis, P);
  const chassisMesh = new t.Mesh(accChassis.toBufferGeometry(t), matChassis);
  chassisMesh.name = "semi-chassis-steel";
  chassisMesh.castShadow = true;
  chassisMesh.receiveShadow = true;
  chassisBodyGroup.add(chassisMesh);

  const accRubber = new GeomAcc();
  buildInteriorAndRubber(accRubber, P);
  const interiorRubberMesh = new t.Mesh(accRubber.toBufferGeometry(t), matRubber);
  interiorRubberMesh.name = "semi-interior-rubber";
  interiorRubberMesh.castShadow = true;
  interiorRubberMesh.receiveShadow = true;
  chassisBodyGroup.add(interiorRubberMesh);

  const accGlass = new GeomAcc();
  buildCabGlass(accGlass, P);
  const glassMesh = new t.Mesh(accGlass.toBufferGeometry(t), matGlass);
  glassMesh.name = "semi-cab-glass";
  chassisBodyGroup.add(glassMesh);

  const accLamps = new GeomAcc();
  buildLamps(accLamps, P);
  const lampsMesh = new t.Mesh(accLamps.toBufferGeometry(t), matLamps);
  lampsMesh.name = "semi-lamps";
  chassisBodyGroup.add(lampsMesh);

  // Articulated steering wheel
  const steeringWheelPivot = new t.Group();
  steeringWheelPivot.name = "steeringWheelPivot";
  steeringWheelPivot.position.set(
    SEMI_DIMENSIONS.steeringWheelCenter[0],
    SEMI_DIMENSIONS.steeringWheelCenter[1],
    SEMI_DIMENSIONS.steeringWheelCenter[2],
  );
  steeringWheelPivot.rotation.x = 30 * (Math.PI / 180);
  const steeringWheelMesh = new t.Mesh(buildSteeringWheelGeom(t, P), matChrome);
  steeringWheelMesh.name = "steering-wheel-mesh";
  steeringWheelMesh.castShadow = true;
  steeringWheelPivot.add(steeringWheelMesh);
  chassisBodyGroup.add(steeringWheelPivot);

  // Articulated Eaton-Fuller floor shifter
  const shifterPivot = new t.Group();
  shifterPivot.name = "shifterPivot";
  shifterPivot.position.set(-0.22, 0.58, 1.48);
  const shifterMesh = new t.Mesh(buildShifterGeom(t, P), matChrome);
  shifterMesh.name = "shifter-mesh";
  shifterMesh.castShadow = true;
  shifterPivot.add(shifterMesh);
  chassisBodyGroup.add(shifterPivot);

  // Articulated dash speedometer needle (rotated +90 deg X so rotation.z sweeps across X-Z dial face)
  const speedoNeedlePivot = new t.Group();
  speedoNeedlePivot.name = "speedoNeedlePivot";
  speedoNeedlePivot.position.set(-0.52, 0.915, 1.98);
  speedoNeedlePivot.rotation.x = Math.PI / 2;
  const accNeedle = new GeomAcc();
  accNeedle.box(0.0, 0.016, 0.0, 0.0025, 0.018, 0.002, P.needleWhite);
  const speedoNeedleMesh = new t.Mesh(accNeedle.toBufferGeometry(t), matEmissiveFx);
  speedoNeedleMesh.name = "speedo-needle-mesh";
  speedoNeedlePivot.add(speedoNeedleMesh);
  chassisBodyGroup.add(speedoNeedlePivot);

  // Articulated JOST fifth-wheel plate (top surface at local z = 0 -> truck z = 0.96 m)
  const fifthWheelPivot = new t.Group();
  fifthWheelPivot.name = "fifthWheelPivot";
  fifthWheelPivot.position.set(0, SEMI_DIMENSIONS.fifthWheelY, SEMI_DIMENSIONS.fifthWheelZ);
  const fifthWheelMesh = new t.Mesh(buildFifthWheelGeom(t, P), matChassis);
  fifthWheelMesh.name = "fifth-wheel-plate-mesh";
  fifthWheelMesh.castShadow = true;
  fifthWheelMesh.receiveShadow = true;
  fifthWheelPivot.add(fifthWheelMesh);
  chassisBodyGroup.add(fifthWheelPivot);

  // Articulated glad-hand coiled air lines
  const gladHandPivot = new t.Group();
  gladHandPivot.name = "gladHandPivot";
  gladHandPivot.position.set(0, -0.43, 2.05);
  const gladHandMesh = new t.Mesh(buildGladHandHosesGeom(t, P), matRubber);
  gladHandMesh.name = "glad-hand-hoses-mesh";
  gladHandMesh.castShadow = true;
  gladHandPivot.add(gladHandMesh);
  chassisBodyGroup.add(gladHandPivot);

  // Additive headlight beam cone (scaled down at rest so Box3 envelope stays exact 7.00 m)
  const headlightBeams = new t.Mesh(new t.ConeGeometry(0.65, 4.0, 12), matAdditive);
  headlightBeams.name = "headlightBeams";
  headlightBeams.position.set(0.0, 3.40, 1.24);
  headlightBeams.rotation.x = Math.PI;
  headlightBeams.scale.set(0.001, 0.001, 0.001);
  headlightBeams.visible = false; // vfx-lint-allow: additive beam mesh toggle initial
  chassisBodyGroup.add(headlightBeams);

  // ---- 3. Pooled FxLightSource Carrier (Strictly Zero THREE.Light) ----
  const pooledLight = new FxLightSource("emitter");
  pooledLight.color.setHex(0xffffea);
  pooledLight.distance = 32;
  pooledLight.intensity = 0;
  if (Array.isArray(liveScene3d.activeLights)) {
    liveScene3d.activeLights.push(pooledLight);
  }

  const lightOffset = new t.Vector3(0.0, 3.60, 1.24);
  const tmpLightVec = new t.Vector3();
  let wheelRollAngle = 0;
  let coupledState = false;
  let headlightsState = false;
  let attachedTrailer = null;

  const rollingWheels = [wheelFL, wheelFR, wheelTandemFront, wheelTandemRear];

  const pivots = Object.freeze({
    steerFL: steerPivotFL,
    steerFR: steerPivotFR,
    steerPivotFL,
    steerPivotFR,
    steeringWheel: steeringWheelPivot,
    steeringWheelPivot,
    speedoNeedle: speedoNeedlePivot,
    speedoNeedlePivot,
    shifter: shifterPivot,
    shifterPivot,
    fifthWheel: fifthWheelPivot,
    fifthWheelPivot,
    gladHand: gladHandPivot,
    gladHandPivot,
    suspFL,
    suspFR,
    suspTandemFront,
    suspTandemRear,
    suspRL: suspTandemFront,
    suspRR: suspTandemRear,
  });

  function applyCoupledPose(isCoupled) {
    coupledState = Boolean(isCoupled);
    if (coupledState) {
      gladHandPivot.position.set(0, -0.58, 2.04);
      gladHandPivot.rotation.x = 0.35;
    } else {
      gladHandPivot.position.set(0, -0.43, 2.05);
      gladHandPivot.rotation.x = 0.0;
    }
  }

  function detachTrailer() {
    if (!attachedTrailer) {
      applyCoupledPose(false);
      return null;
    }
    const prev = attachedTrailer;
    if (prev.root && prev.root.parent === root) {
      root.remove(prev.root);
    }
    prev.setLandingGearRetracted?.(false);
    attachedTrailer = null;
    applyCoupledPose(false);
    return prev;
  }

  return {
    root,
    group: root,
    chassisBodyGroup,
    suspFL,
    suspFR,
    suspTandemFront,
    suspTandemRear,
    suspRL: suspTandemFront,
    suspRR: suspTandemRear,
    steerPivotFL,
    steerPivotFR,
    steeringWheelPivot,
    speedoNeedlePivot,
    shifterPivot,
    fifthWheelPivot,
    gladHandPivot,
    pivots,
    maxDrawCalls: SEMI_DIMENSIONS.maxDrawCalls,
    dimensions: SEMI_DIMENSIONS,
    livery: liverySpec,
    wheels: rollingWheels,
    rollingWheels,
    headlightBeams,
    pooledLight,
    materials: {
      matBody,
      matChrome,
      matChassis,
      matRubber,
      matGlass,
      matLamps,
      matEmissiveFx,
      matAdditive,
    },
    get wheelRollAngle() { return wheelRollAngle; },
    get coupled() { return coupledState; },
    getFifthWheelWorldAnchor(outVec) {
      root.updateMatrixWorld(true);
      const target = outVec || new t.Vector3();
      fifthWheelPivot.getWorldPosition(target);
      return target;
    },
    attachTrailer(trailerModel, articulationRad = 0) {
      detachTrailer();
      if (!trailerModel || !trailerModel.root) return null;
      const kpY = Number.isFinite(trailerModel.kingpinY)
        ? trailerModel.kingpinY
        : (trailerModel.spec?.kingpinY ?? (trailerModel.spec ? trailerModel.spec.length / 2 - 0.9 : (trailerModel.kind === "20ft" ? 2.80 : 5.35)));
      const kpZ = Number.isFinite(trailerModel.kingpinZ)
        ? trailerModel.kingpinZ
        : (trailerModel.spec?.kingpinZ ?? 0.96);
      const art = Number.isFinite(articulationRad) ? articulationRad : 0;

      const x = kpY * Math.sin(art);
      const y = SEMI_DIMENSIONS.fifthWheelY - kpY * Math.cos(art);
      const z = SEMI_DIMENSIONS.fifthWheelZ - kpZ;

      trailerModel.root.position.set(x, y, z);
      trailerModel.root.rotation.set(0, 0, art);
      root.add(trailerModel.root);
      trailerModel.setLandingGearRetracted?.(true);
      attachedTrailer = trailerModel;
      applyCoupledPose(true);
      root.updateMatrixWorld(true);
      return trailerModel;
    },
    detachTrailer,
    update(state = {}, argDt) {
      const s = (state && typeof state === "object") ? state : {};
      const dt = Number.isFinite(s.dt) ? s.dt : (Number.isFinite(argDt) ? argDt : 0.0333);
      const speed = Number.isFinite(s.speed) ? s.speed : 0;

      // 1. Speed-tapered steer lock (38 deg <= 12 m/s -> 12 deg >= 27 m/s)
      let maxSteer = SEMI_DIMENSIONS.maxSteerLowSpeedRad;
      const absSpeed = Math.abs(speed);
      if (absSpeed > 12.0) {
        const frac = Math.min(1.0, (absSpeed - 12.0) / (27.0 - 12.0));
        maxSteer = SEMI_DIMENSIONS.maxSteerLowSpeedRad +
          (SEMI_DIMENSIONS.maxSteerHighSpeedRad - SEMI_DIMENSIONS.maxSteerLowSpeedRad) * frac;
      }
      const steerInput = Number.isFinite(s.steerAngle) ? s.steerAngle : 0;
      const clampedSteer = clamp(steerInput, -maxSteer, maxSteer);
      steerPivotFL.rotation.z = clampedSteer;
      steerPivotFR.rotation.z = clampedSteer;
      steeringWheelPivot.rotation.z = clamp(clampedSteer * SEMI_DIMENSIONS.steeringGearRatio, -1.745, 1.745);

      // 2. Rolling kinematics (all 4 wheel meshes = 6 axle stations)
      if (dt > 0 && absSpeed > 1e-6) {
        const dRoll = (speed * dt) / SEMI_DIMENSIONS.wheelRadius;
        if (Number.isFinite(dRoll)) {
          wheelRollAngle = (wheelRollAngle + dRoll) % (2 * Math.PI);
          if (wheelRollAngle < 0) wheelRollAngle += 2 * Math.PI;
          for (const w of rollingWheels) {
            w.rotation.x = wheelRollAngle;
          }
        }
      }

      // 3. Speedometer needle (0..40 m/s over 240 deg sweep)
      const speedClamped = clamp(absSpeed, 0, 40.0);
      const needleSweep = (speedClamped / 40.0) * (240 * (Math.PI / 180));
      speedoNeedlePivot.rotation.z = -(needleSweep - 120 * (Math.PI / 180));

      // 4. Eaton-Fuller floor shifter cane (-1, 0, 1..5)
      let gear = s.gear;
      if (gear === undefined) {
        if (speed < -0.1) gear = -1;
        else if (absSpeed < 0.1) gear = 0;
        else if (speed < 5.0) gear = 1;
        else if (speed < 10.0) gear = 2;
        else if (speed < 16.0) gear = 3;
        else if (speed < 22.0) gear = 4;
        else gear = 5;
      }
      if (gear === -1) {
        shifterPivot.rotation.x = -0.16;
        shifterPivot.rotation.y = -0.14;
      } else if (gear === 1) {
        shifterPivot.rotation.x = 0.16;
        shifterPivot.rotation.y = -0.14;
      } else if (gear === 2) {
        shifterPivot.rotation.x = -0.14;
        shifterPivot.rotation.y = 0.0;
      } else if (gear === 3) {
        shifterPivot.rotation.x = 0.16;
        shifterPivot.rotation.y = 0.0;
      } else if (gear === 4) {
        shifterPivot.rotation.x = -0.14;
        shifterPivot.rotation.y = 0.14;
      } else if (gear === 5) {
        shifterPivot.rotation.x = 0.16;
        shifterPivot.rotation.y = 0.14;
      } else {
        shifterPivot.rotation.x = 0.0;
        shifterPivot.rotation.y = 0.0;
      }

      // 5. Body squat/dive/roll & suspension offsets
      const accel = Number.isFinite(s.accel) ? s.accel : 0;
      const steerAcc = clampedSteer * speed;
      chassisBodyGroup.rotation.x = clamp(-accel * 0.004, -0.06, 0.06);
      chassisBodyGroup.rotation.y = clamp(steerAcc * 0.0025, -0.05, 0.05);
      if (Number.isFinite(s.suspensionFL)) suspFL.position.z = SEMI_DIMENSIONS.wheelRadius + s.suspensionFL;
      if (Number.isFinite(s.suspensionFR)) suspFR.position.z = SEMI_DIMENSIONS.wheelRadius + s.suspensionFR;
      if (Number.isFinite(s.suspensionRL)) suspTandemFront.position.z = SEMI_DIMENSIONS.wheelRadius + s.suspensionRL;
      if (Number.isFinite(s.suspensionRR)) suspTandemRear.position.z = SEMI_DIMENSIONS.wheelRadius + s.suspensionRR;

      // 6. Fifth-wheel pitch & glad-hand hose coupling pose
      const tPitch = Number.isFinite(s.trailerPitch) ? clamp(s.trailerPitch, -0.25, 0.25) : 0.0;
      fifthWheelPivot.rotation.x = tPitch;
      const hasCoupledState = Boolean(
        attachedTrailer ||
        s.coupled ||
        s.trailerHitched ||
        (Number.isFinite(s.hitchedTrailerGuid) && s.hitchedTrailerGuid !== 0),
      );
      applyCoupledPose(hasCoupledState);

      // 7. Lamps & pooled headlights (zero Vector3 allocs)
      const braking = Boolean(s.braking || s.brakeLights);
      const headlightsProvided = s.headlights !== undefined;
      if (headlightsProvided) {
        headlightsState = Boolean(s.headlights);
      }
      matLamps.emissiveIntensity = braking ? 2.2 : (headlightsState ? 1.2 : 0.65);

      if (headlightsProvided) {
        headlightBeams.visible = headlightsState; // vfx-lint-allow: additive beam mesh toggle
        if (headlightsState) {
          headlightBeams.scale.set(1, 1, 1);
          headlightBeams.position.set(0.0, 5.20, 1.24);
        } else {
          headlightBeams.scale.set(0.001, 0.001, 0.001);
          headlightBeams.position.set(0.0, 3.40, 1.24);
        }
        matAdditive.opacity = headlightsState ? 0.05 : 0.0;
        pooledLight.intensity = headlightsState ? 3.2 : 0.0;
      }
      if (headlightsState || headlightsProvided) {
        tmpLightVec.copy(lightOffset).applyQuaternion(root.quaternion);
        pooledLight.position.copy(root.position).add(tmpLightVec);
      }
    },
    dispose() {
      detachTrailer();
      const disposedGeoms = new Set();
      const disposedMats = new Set();
      root.traverse((obj) => {
        if (obj.geometry && !disposedGeoms.has(obj.geometry)) {
          obj.geometry.dispose();
          disposedGeoms.add(obj.geometry);
        }
        if (obj.material) {
          const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
          for (const m of mats) {
            if (m && !disposedMats.has(m)) {
              m.dispose();
              disposedMats.add(m);
            }
          }
        }
      });
      pooledLight.released = true;
      pooledLight.intensity = 0.0;
      if (Array.isArray(liveScene3d.activeLights)) {
        const idx = liveScene3d.activeLights.indexOf(pooledLight);
        if (idx !== -1) liveScene3d.activeLights.splice(idx, 1);
      }
    },
  };
}

export const manifest = Object.freeze({
  id: "vfx-semi-379-model",
  channel: "vehicleModel",
  deterministic: true,
  lightCountDelta: 0,
  cacheKeyScope: "set",
  reads: ["geometry", "serverPose", "clock"],
  writes: ["renderTransform", "partTransform", "lightIntensity"],
});
