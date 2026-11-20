// scene3d/vehicle/jeep_model.js — Procedural Willys MB 1/4-ton 4x4 Jeep (jeep-mb) 3D Model
// Implements visual parity with Grumman Hellcat (airframe.js):
// - Sculpted 1943 Willys MB geometry via GeomAcc (9-slot stamped grille, radiator, 7" headlights,
//   tapered hood with center ridge & 3D US Army invasion star appliqué, open 4-seat tub with
//   driver & shotgun bucket seats + 2-passenger rear bench, 30° raked column with 3-spoke wheel,
//   speedometer needle, T-84 shifter cane, transfer case lever, handbrake, pedals, grab-bar,
//   split folding windscreen, live leaf-spring axles, 5x 3D combat wheels, pioneer kit, jerrycan)
// - PBR MeshStandardMaterial stack calibrated for AGX HDR (exposure = 5.0) + Sun + IBL + CSM shadows
// - Decoupled cargo (rear bed dedicated to rear bench seat; dummy cargoCrateGroup for backward compat)
// - Exactly <= 16 draw calls, zero added light sources (lightCountDelta === 0)

import * as THREE_DEFAULT from "three";
import { FxLightSource } from "../vfx/fx_lights.js";

export const JEEP_PALETTE = Object.freeze({
  oliveDrab: 0x464f30,      // Authentic WWII US Army Lustreless Olive Drab [~0.27, 0.31, 0.19]
  oliveDrabDark: 0x323a22,  // Shaded olive drab underbody
  starWhite: 0xf2f5f8,      // US Army White Invasion Star stencil [~0.95, 0.96, 0.97]
  canvasKhaki: 0x787154,    // #8 Olive Khaki duck-canvas cushions
  tireRubber: 0x1c1e22,     // 6.00-16 NDT non-directional tire rubber
  treadLug: 0x141619,       // Combat shoulder tread lugs
  toolSteel: 0x3a3d40,      // Gunmetal / tool steel blades
  metalBright: 0x8a929a,    // Combat rim lug nuts & gauge bezels
  woodShaft: 0x6e4726,      // Pioneer axe/shovel wood handles
  glassClear: 0xa8c4c7,     // Dual windscreen panes
  glassAmber: 0xb58a22,     // Marker lenses
  rubyTail: 0xa81818,       // Ruby brake/tail lamps
  blackoutBlue: 0x1c2b3d,   // Fender blackout marker lamp
  radiatorCore: 0x181818,   // Recessed radiator cooling fins
  exhaustRust: 0x4a3b32,    // Muffler & tailpipe
});

export const JEEP_DIMENSIONS = Object.freeze({
  wheelbase: 2.04,          // 80 inches (2.032 m)
  trackWidth: 1.48,         // ~58 inches track width
  wheelRadius: 0.38,        // 6.00-16 NDT tire outer radius
  maxSteerLowSpeedRad: 0.69813, // 40 degrees steer lock at <= 12 m/s
  maxSteerHighSpeedRad: 0.20944, // 12 degrees steer lock at 29 m/s
  steeringGearRatio: 2.5,   // 2.5x steering wheel rotation multiplier
  turnRadiusMin: 2.43,      // 2.43 m turn radius at 40° lock
  maxDrawCalls: 16,         // GTX 1070 draw call ceiling
});

export const PALLET_MOUNT_OFFSETS = Object.freeze({
  fullBed: Object.freeze([0.0, -1.15, 0.72]),
  halfSlot0: Object.freeze([-0.3048, -1.15, 0.72]),
  halfSlot1: Object.freeze([0.3048, -1.15, 0.72]),
});

export function bridgeCargoLoaded(state = {}) {
  return Boolean((state.cargoMask || 0) !== 0 || (state.cargoSlot0Wcid || 0) !== 0);
}

// ---------------------------------------------------------------------------
// Procedural Geometry Engine (GeomAcc) — ported & adapted from airframe.js
// ---------------------------------------------------------------------------
function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
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

function makePaletteLinear(THREE) {
  const tmp = new THREE.Color();
  const lin = (hex) => {
    tmp.setHex(hex);
    return [tmp.r, tmp.g, tmp.b];
  };
  const out = {};
  for (const [k, hex] of Object.entries(JEEP_PALETTE)) out[k] = lin(hex);
  return out;
}

class GeomAcc {
  constructor(colorChannels = 3, withUv = false) {
    this.cc = colorChannels;
    this.withUv = withUv;
    this.pos = [];
    this.nor = [];
    this.col = [];
    this.uv = [];
  }

  pushVert(p, n, c, u = 0, v = 0) {
    this.pos.push(p[0], p[1], p[2]);
    this.nor.push(n[0], n[1], n[2]);
    if (this.cc === 4) {
      this.col.push(c[0], c[1], c[2], c[3] ?? 1);
    } else {
      this.col.push(c[0], c[1], c[2]);
    }
    if (this.withUv) this.uv.push(u, v);
  }

  tri(p0, p1, p2, c0, c1 = c0, c2 = c0, n0 = null, n1 = null, n2 = null, uv0 = null, uv1 = null, uv2 = null) {
    const fn = n0 || vNorm(vCross(vSub(p1, p0), vSub(p2, p0)));
    this.pushVert(p0, n0 || fn, c0, uv0 ? uv0[0] : 0, uv0 ? uv0[1] : 0);
    this.pushVert(p1, n1 || fn, c1, uv1 ? uv1[0] : 0, uv1 ? uv1[1] : 0);
    this.pushVert(p2, n2 || fn, c2, uv2 ? uv2[0] : 0, uv2 ? uv2[1] : 0);
  }

  quad(p0, p1, p2, p3, c0, c1 = c0, c2 = c0, c3 = c0, n0 = null, n1 = null, n2 = null, n3 = null) {
    const fn = n0 || vNorm(vCross(vSub(p1, p0), vSub(p2, p0)));
    this.tri(p0, p1, p2, c0, c1, c2, n0 || fn, n1 || fn, n2 || fn);
    this.tri(p0, p2, p3, c0, c2, c3, n0 || fn, n2 || fn, n3 || fn);
  }

  /** Loft a sequence of rings `{pts: [[x,y,z],...], cols: [[r,g,b],...]}` with smooth vertex normals. */
  loft(rings, closed = true) {
    const m = rings.length;
    if (m < 2) return;
    const n = rings[0].pts.length;
    const nors = rings.map(() => Array.from({ length: n }, () => [0, 0, 0]));
    for (let s = 0; s < m; s++) {
      const rCur = rings[s].pts;
      const rPrev = rings[Math.max(0, s - 1)].pts;
      const rNext = rings[Math.min(m - 1, s + 1)].pts;
      for (let i = 0; i < n; i++) {
        const iPrev = closed ? (i - 1 + n) % n : Math.max(0, i - 1);
        const iNext = closed ? (i + 1) % n : Math.min(n - 1, i + 1);
        const tCirc = vSub(rCur[iNext], rCur[iPrev]);
        const tLong = vSub(rNext[i], rPrev[i]);
        let vn = vCross(tCirc, tLong);
        const l = Math.hypot(vn[0], vn[1], vn[2]);
        if (l < 1e-7) vn = [0, 0, 1];
        else vn = [vn[0] / l, vn[1] / l, vn[2] / l];
        nors[s][i] = vn;
      }
    }
    const segCount = closed ? n : n - 1;
    for (let s = 0; s < m - 1; s++) {
      const a = rings[s], b = rings[s + 1];
      const na = nors[s], nb = nors[s + 1];
      for (let i = 0; i < segCount; i++) {
        const j = (i + 1) % n;
        this.quad(a.pts[i], a.pts[j], b.pts[j], b.pts[i], a.cols[i], a.cols[j], b.cols[j], b.cols[i], na[i], na[j], nb[j], nb[i]);
      }
    }
  }

  /** Tapered tube from p0 to p1 with arbitrary axis. */
  tube(p0, p1, r0, r1, segs, col0, col1 = col0, cap0 = true, cap1 = true) {
    const d = vSub(p1, p0);
    const len = Math.hypot(d[0], d[1], d[2]);
    if (len < 1e-6) return;
    const ax = vScale(d, 1 / len);
    const ref = Math.abs(ax[2]) < 0.85 ? [0, 0, 1] : [1, 0, 0];
    const u = vNorm(vCross(ref, ax));
    const v = vNorm(vCross(ax, u));
    const slope = (r0 - r1) / len;
    const pts0 = [], pts1 = [], nrs = [];
    for (let i = 0; i < segs; i++) {
      const a = (i / segs) * Math.PI * 2;
      const ca = Math.cos(a), sa = Math.sin(a);
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
      for (let i = 1; i < segs - 1; i++) this.tri(pts0[0], pts0[i + 1], pts0[i], col0, col0, col0, nBack, nBack, nBack);
    }
    if (cap1 && r1 > 1e-4) {
      for (let i = 1; i < segs - 1; i++) this.tri(pts1[0], pts1[i], pts1[i + 1], col1, col1, col1, ax, ax, ax);
    }
  }

  /** Axis-aligned or transformed box with outward CCW winding and vertical AO shading. */
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

  /** Cylinder along arbitrary axis. */
  cylinder(cx, cy, cz, radius, height, segs, col, axis = "y", cap0 = true, cap1 = true) {
    const halfH = height * 0.5;
    let p0, p1;
    if (axis === "x") {
      p0 = [cx - halfH, cy, cz]; p1 = [cx + halfH, cy, cz];
    } else if (axis === "z") {
      p0 = [cx, cy, cz - halfH]; p1 = [cx, cy, cz + halfH];
    } else {
      p0 = [cx, cy - halfH, cz]; p1 = [cx, cy + halfH, cz];
    }
    this.tube(p0, p1, radius, radius, segs, col, col, cap0, cap1);
  }

  toBufferGeometry(THREE) {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(this.pos), 3));
    g.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(this.nor), 3));
    g.setAttribute("color", new THREE.BufferAttribute(new Float32Array(this.col), this.cc));
    if (this.withUv) g.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(this.uv), 2));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

// ---------------------------------------------------------------------------
// 3D Geometry Appliqué US Army White Invasion Star (airframe.js pattern)
// ---------------------------------------------------------------------------
function addInvasionStar(acc, center, radius, P) {
  const lift = 0.0035; // 3.5 mm raised above hood surface
  // Hood slopes from cowl (y=0.48, z=0.88) to grille (y=1.38, z=0.84): dy=0.90, dz=-0.04
  const L = Math.hypot(0.90, -0.04);
  const u = [1, 0, 0];
  const v = [0, 0.90 / L, -0.04 / L];
  const n = [0, 0.04 / L, 0.90 / L];

  const pt = (du, dv) => [
    center[0] + u[0] * du + v[0] * dv + n[0] * lift,
    center[1] + u[1] * du + v[1] * dv + n[1] * lift,
    center[2] + u[2] * du + v[2] * dv + n[2] * lift,
  ];

  const cStar = pt(0, 0);
  const rInner = radius * 0.382;
  const starPts = [];
  for (let i = 0; i < 10; i++) {
    const ang = Math.PI * 0.5 + (i * Math.PI) / 5;
    const rr = i % 2 === 0 ? radius : rInner;
    starPts.push(pt(Math.cos(ang) * rr, Math.sin(ang) * rr));
  }
  for (let i = 0; i < 10; i++) {
    acc.tri(cStar, starPts[i], starPts[(i + 1) % 10], P.starWhite, P.starWhite, P.starWhite, n, n, n);
  }
}

// ---------------------------------------------------------------------------
// Sculpted 1943 Willys MB Tub, Chassis, Front Clip & Engine Hood
// ---------------------------------------------------------------------------
function buildTubAndChassis(acc, P) {
  // ---- 1. Chassis Frame, Front Channel Bumper & Rear Bumperettes ----
  // Longitudinal C-channel frame rails (left & right)
  acc.box(-0.42, 0.0, 0.34, 0.04, 1.50, 0.05, P.oliveDrabDark);
  acc.box(0.42, 0.0, 0.34, 0.04, 1.50, 0.05, P.oliveDrabDark);
  // Cross members
  acc.box(0.0, 1.44, 0.34, 0.40, 0.04, 0.04, P.oliveDrabDark);
  acc.box(0.0, 0.48, 0.32, 0.40, 0.04, 0.03, P.oliveDrabDark);
  acc.box(0.0, -1.02, 0.34, 0.40, 0.04, 0.04, P.oliveDrabDark);
  // Heavy front channel bumper
  acc.box(0.0, 1.52, 0.34, 0.76, 0.04, 0.07, P.oliveDrab);
  // Front tow shackles
  acc.box(-0.42, 1.57, 0.34, 0.03, 0.02, 0.04, P.toolSteel);
  acc.box(0.42, 1.57, 0.34, 0.03, 0.02, 0.04, P.toolSteel);
  // Rear bumperettes & central pintle hitch hook
  acc.box(-0.55, -1.58, 0.36, 0.16, 0.03, 0.06, P.oliveDrab);
  acc.box(0.55, -1.58, 0.36, 0.16, 0.03, 0.06, P.oliveDrab);
  acc.box(0.0, -1.61, 0.35, 0.04, 0.03, 0.05, P.toolSteel);
  // Underbody skid plate & transmission protection
  acc.box(0.0, -0.05, 0.26, 0.28, 0.32, 0.015, P.oliveDrabDark);
  // Exhaust system: muffler under passenger floor & rear tailpipe
  acc.cylinder(0.40, -0.85, 0.32, 0.07, 0.44, 12, P.exhaustRust, "y");
  acc.tube([0.40, -1.07, 0.32], [0.52, -1.62, 0.36], 0.022, 0.022, 8, P.exhaustRust);

  // ---- 2. Front & Rear Live Axles, Differentials & Leaf Spring Packs ----
  // Front live axle beam & differential pumpkin
  acc.cylinder(0.0, 1.02, 0.38, 0.035, 1.28, 12, P.oliveDrabDark, "x");
  acc.cylinder(0.14, 1.02, 0.38, 0.095, 0.16, 14, P.oliveDrabDark, "y");
  acc.cylinder(0.0, 0.94, 0.36, 0.018, 1.20, 8, P.toolSteel, "x"); // steering tie rod
  // Rear live axle beam & differential pumpkin
  acc.cylinder(0.0, -1.02, 0.38, 0.035, 1.28, 12, P.oliveDrabDark, "x");
  acc.cylinder(0.14, -1.02, 0.38, 0.095, 0.16, 14, P.oliveDrabDark, "y");
  // 4 Semi-elliptic leaf spring packs
  for (const sx of [-0.42, 0.42]) {
    // Front leaf spring pack
    acc.tube([sx, 0.65, 0.42], [sx, 1.02, 0.33], 0.03, 0.03, 8, P.oliveDrabDark);
    acc.tube([sx, 1.02, 0.33], [sx, 1.38, 0.42], 0.03, 0.03, 8, P.oliveDrabDark);
    // Rear leaf spring pack
    acc.tube([sx, -1.38, 0.42], [sx, -1.02, 0.33], 0.03, 0.03, 8, P.oliveDrabDark);
    acc.tube([sx, -1.02, 0.33], [sx, -0.65, 0.42], 0.03, 0.03, 8, P.oliveDrabDark);
  }

  // ---- 3. Front Clip: 9-Slot Vertical Stamped Grille, Radiator & Headlights ----
  // Radiator core (dark recessed fins behind grille)
  acc.box(0.0, 1.35, 0.64, 0.34, 0.02, 0.17, P.radiatorCore);
  // Grille sheet metal frame
  acc.box(0.0, 1.38, 0.44, 0.40, 0.015, 0.04, P.oliveDrab); // bottom chin
  acc.box(0.0, 1.38, 0.83, 0.40, 0.015, 0.03, P.oliveDrab); // top header
  acc.box(-0.36, 1.38, 0.64, 0.04, 0.015, 0.16, P.oliveDrab); // left outer frame
  acc.box(0.36, 1.38, 0.64, 0.04, 0.015, 0.16, P.oliveDrab); // right outer frame
  // Authentic 9 vertical stamped grille bars
  const barCount = 8; // 8 interior bars creating exactly 9 vertical slots
  for (let b = 0; b < barCount; b++) {
    const bx = -0.26 + (b * (0.52 / (barCount - 1)));
    acc.box(bx, 1.385, 0.64, 0.015, 0.012, 0.16, P.oliveDrab);
  }
  // 7" Round headlights (parabolic reflectors, chrome rings, ribbed glass)
  for (const sx of [-0.34, 0.34]) {
    acc.cylinder(sx, 1.39, 0.68, 0.088, 0.04, 16, P.metalBright, "y");
    acc.cylinder(sx, 1.41, 0.68, 0.078, 0.02, 16, P.glassClear, "y");
  }
  // Left fender blackout marker driving lamp (oval military housing)
  acc.box(-0.54, 1.15, 0.73, 0.045, 0.065, 0.035, P.oliveDrab);
  acc.box(-0.54, 1.185, 0.73, 0.035, 0.01, 0.025, P.blackoutBlue);

  // ---- 4. Sculpted Tapered Hood with Center Ridge, Latches & Invasion Star ----
  // Tapered hood top (cowl y=0.48, z=0.88 down to grille y=1.38, z=0.84)
  const hoodCowlHW = 0.44, hoodGrilleHW = 0.39;
  acc.quad(
    [-hoodCowlHW, 0.48, 0.88],
    [hoodCowlHW, 0.48, 0.88],
    [hoodGrilleHW, 1.38, 0.84],
    [-hoodGrilleHW, 1.38, 0.84],
    P.oliveDrab
  );
  // Hood side drop panels (left and right)
  acc.quad(
    [-hoodCowlHW, 0.48, 0.88],
    [-hoodGrilleHW, 1.38, 0.84],
    [-hoodGrilleHW, 1.38, 0.70],
    [-hoodCowlHW, 0.48, 0.70],
    P.oliveDrab
  );
  acc.quad(
    [hoodGrilleHW, 1.38, 0.84],
    [hoodCowlHW, 0.48, 0.88],
    [hoodCowlHW, 0.48, 0.70],
    [hoodGrilleHW, 1.38, 0.70],
    P.oliveDrab
  );
  // Center raised hinge ridge bead running along x=0
  acc.tube([0.0, 0.48, 0.885], [0.0, 1.38, 0.845], 0.008, 0.008, 6, P.oliveDrab);
  // Hood spring latches (T-catches)
  acc.box(-0.43, 0.72, 0.72, 0.015, 0.025, 0.025, P.metalBright);
  acc.box(0.43, 0.72, 0.72, 0.015, 0.025, 0.025, P.metalBright);
  acc.box(-0.41, 1.22, 0.72, 0.015, 0.025, 0.025, P.metalBright);
  acc.box(0.41, 1.22, 0.72, 0.015, 0.025, 0.025, P.metalBright);
  // US Army White Invasion Star appliqué (crisp 3D decal raised 3.5mm above hood)
  addInvasionStar(acc, [0.0, 0.90, 0.88 - (2 / 45) * (0.90 - 0.48)], 0.20, P);

  // ---- 5. Flat Front Fenders & Rolled Fender Aprons ----
  // Left flat fender top & front curved lip
  acc.box(-0.58, 0.92, 0.70, 0.15, 0.46, 0.015, P.oliveDrab);
  acc.box(-0.58, 1.40, 0.62, 0.15, 0.03, 0.08, P.oliveDrab); // curved front drop
  acc.box(-0.73, 0.92, 0.60, 0.01, 0.46, 0.10, P.oliveDrab); // outer side skirt
  // Right flat fender top & front curved lip
  acc.box(0.58, 0.92, 0.70, 0.15, 0.46, 0.015, P.oliveDrab);
  acc.box(0.58, 1.40, 0.62, 0.15, 0.03, 0.08, P.oliveDrab);
  acc.box(0.73, 0.92, 0.60, 0.01, 0.46, 0.10, P.oliveDrab);

  // ---- 6. Open 4-Seat Tub: Cowl, Curved Doorway Cutouts & Floor Tunnel ----
  // Cowl deck & dash firewall
  acc.box(0.0, 0.48, 0.68, 0.72, 0.02, 0.20, P.oliveDrab);
  // Dashboard panel with round gauge cluster bezels
  acc.box(0.0, 0.465, 0.80, 0.66, 0.01, 0.08, P.oliveDrab);
  acc.cylinder(-0.18, 0.46, 0.78, 0.036, 0.01, 16, P.metalBright, "y"); // speedometer bezel
  acc.cylinder(-0.08, 0.46, 0.81, 0.022, 0.01, 12, P.metalBright, "y"); // fuel gauge
  acc.cylinder(-0.08, 0.46, 0.75, 0.022, 0.01, 12, P.metalBright, "y"); // oil pressure
  acc.cylinder(0.02, 0.46, 0.81, 0.022, 0.01, 12, P.metalBright, "y");  // temp gauge
  acc.cylinder(0.02, 0.46, 0.75, 0.022, 0.01, 12, P.metalBright, "y");  // ammeter
  // Floor pan from firewall to rear bed
  acc.box(0.0, -0.52, 0.40, 0.72, 0.98, 0.018, P.oliveDrab);
  // Transmission / driveshaft floor tunnel
  acc.box(0.0, 0.02, 0.45, 0.11, 0.44, 0.05, P.oliveDrab);
  // 3 Floor pedals in driver footwell (clutch, brake, accelerator)
  acc.box(-0.32, 0.42, 0.43, 0.03, 0.02, 0.03, P.toolSteel);
  acc.box(-0.25, 0.42, 0.43, 0.03, 0.02, 0.03, P.toolSteel);
  acc.box(-0.18, 0.42, 0.42, 0.02, 0.04, 0.02, P.toolSteel);
  // Handbrake umbrella handle under dash
  acc.box(-0.26, 0.40, 0.68, 0.015, 0.08, 0.015, P.toolSteel);

  // Curved doorway cutouts with rolled gunwale lips (left & right sides)
  for (const sx of [-1, 1]) {
    const xEdge = sx * 0.73;
    // Front door post & rolled sill
    acc.box(xEdge, 0.40, 0.68, 0.015, 0.08, 0.20, P.oliveDrab);
    acc.box(xEdge, 0.14, 0.50, 0.015, 0.18, 0.08, P.oliveDrab); // low step sill
    acc.tube([xEdge, -0.05, 0.52], [xEdge, 0.35, 0.52], 0.02, 0.02, 8, P.oliveDrab); // rolled gunwale
    // Aft side wall of tub
    acc.box(xEdge, -0.85, 0.62, 0.015, 0.68, 0.20, P.oliveDrab);
  }

  // Rear wheel well boxes inside bed (flanking the rear bench)
  acc.box(-0.61, -1.02, 0.52, 0.11, 0.28, 0.12, P.oliveDrab);
  acc.box(0.61, -1.02, 0.52, 0.11, 0.28, 0.12, P.oliveDrab);

  // Seat riser structures
  acc.box(-0.38, -0.18, 0.48, 0.18, 0.18, 0.06, P.oliveDrabDark); // driver seat base
  acc.box(0.38, -0.18, 0.48, 0.18, 0.18, 0.06, P.oliveDrabDark);  // shotgun seat base
  acc.box(0.0, -0.96, 0.52, 0.48, 0.16, 0.08, P.oliveDrabDark);   // rear bench seat base

  // Rear ruby tail / brake lamps
  acc.cylinder(-0.58, -1.58, 0.44, 0.045, 0.03, 12, P.rubyTail, "y");
  acc.cylinder(0.58, -1.58, 0.44, 0.045, 0.03, 12, P.rubyTail, "y");
}

// ---------------------------------------------------------------------------
// 4-Seat Tub Interior Cushions: Driver, Shotgun & 2-Passenger Rear Bench
// ---------------------------------------------------------------------------
function buildCushions(acc, P) {
  // ---- Seat 0: Driver Bucket Seat Cushion & Backrest ----
  // Cushion top calibrated at (-0.38, -0.18, 0.62)
  acc.box(-0.38, -0.18, 0.57, 0.19, 0.19, 0.05, P.canvasKhaki);
  // Driver bucket backrest
  acc.box(-0.38, -0.37, 0.76, 0.19, 0.04, 0.14, P.canvasKhaki);

  // ---- Seat 1: Front Passenger Bucket Seat Cushion & Backrest ----
  // Cushion top calibrated at (+0.38, -0.18, 0.62)
  acc.box(0.38, -0.18, 0.57, 0.19, 0.19, 0.05, P.canvasKhaki);
  // Shotgun bucket backrest
  acc.box(0.38, -0.37, 0.76, 0.19, 0.04, 0.14, P.canvasKhaki);

  // ---- Seats 2 & 3: 2-Passenger Rear Bench Seat Cushion & Backrest ----
  // Spans full width between wheel wells (x = -0.50 .. +0.50)
  // Cushion top calibrated at (±0.36, -0.96, 0.68)
  acc.box(0.0, -0.96, 0.63, 0.50, 0.16, 0.05, P.canvasKhaki);
  // Rear bench seat backrest
  acc.box(0.0, -1.13, 0.79, 0.50, 0.035, 0.12, P.canvasKhaki);
}

// ---------------------------------------------------------------------------
// Authentic 6.00-16 NDT Military Combat Wheels (24-seg, lugs, split rim)
// ---------------------------------------------------------------------------
function buildCombatWheel(acc, P) {
  const outerR = 0.38;
  const beadR = 0.22;
  const halfW = 0.09;
  const segs = 24;

  // 1. 24-Segment non-directional military tire torus & sidewalls
  for (let i = 0; i < segs; i++) {
    const a0 = (i / segs) * Math.PI * 2;
    const a1 = ((i + 1) / segs) * Math.PI * 2;
    const c0 = Math.cos(a0), s0 = Math.sin(a0);
    const c1 = Math.cos(a1), s1 = Math.sin(a1);

    // Tread cap face (outer cylindrical tread)
    const pT0L = [-halfW, c0 * outerR, s0 * outerR];
    const pT1L = [-halfW, c1 * outerR, s1 * outerR];
    const pT1R = [halfW, c1 * outerR, s1 * outerR];
    const pT0R = [halfW, c0 * outerR, s0 * outerR];
    acc.quad(pT0L, pT1L, pT1R, pT0R, P.tireRubber);

    // Outer & inner sidewalls
    const pB0R = [halfW * 0.7, c0 * beadR, s0 * beadR];
    const pB1R = [halfW * 0.7, c1 * beadR, s1 * beadR];
    acc.quad(pT0R, pT1R, pB1R, pB0R, P.tireRubber);

    const pB0L = [-halfW * 0.7, c0 * beadR, s0 * beadR];
    const pB1L = [-halfW * 0.7, c1 * beadR, s1 * beadR];
    acc.quad(pB0L, pB1L, pT1L, pT0L, P.tireRubber);

    // Alternating shoulder traction lugs (even: outer shoulder, odd: inner shoulder)
    const lugSide = (i % 2 === 0) ? 1 : -1;
    const lugX = lugSide * (halfW + 0.012);
    const pL0 = [lugSide * halfW, c0 * (outerR + 0.012), s0 * (outerR + 0.012)];
    const pL1 = [lugSide * halfW, c1 * (outerR + 0.012), s1 * (outerR + 0.012)];
    const pLW1 = [lugX, c1 * (outerR - 0.04), s1 * (outerR - 0.04)];
    const pLW0 = [lugX, c0 * (outerR - 0.04), s0 * (outerR - 0.04)];
    acc.quad(pL0, pL1, pLW1, pLW0, P.treadLug);
  }

  // 2. Combat Split-Rim Dish (deep-dish pressed military rim center)
  const dishInnerR = 0.08;
  const dishDepth = 0.035;
  for (let i = 0; i < segs; i++) {
    const a0 = (i / segs) * Math.PI * 2;
    const a1 = ((i + 1) / segs) * Math.PI * 2;
    const c0 = Math.cos(a0), s0 = Math.sin(a0);
    const c1 = Math.cos(a1), s1 = Math.sin(a1);

    const pRim0 = [halfW * 0.7, c0 * beadR, s0 * beadR];
    const pRim1 = [halfW * 0.7, c1 * beadR, s1 * beadR];
    const pDish1 = [halfW * 0.7 - dishDepth, c1 * dishInnerR, s1 * dishInnerR];
    const pDish0 = [halfW * 0.7 - dishDepth, c0 * dishInnerR, s0 * dishInnerR];
    acc.quad(pRim0, pRim1, pDish1, pDish0, P.oliveDrab);
  }

  // 3. Central grease cap hub & 5 military wheel lug nuts
  acc.cylinder(halfW * 0.7 - dishDepth + 0.02, 0, 0, 0.045, 0.04, 12, P.oliveDrabDark, "x");
  const lugR = 0.065;
  for (let l = 0; l < 5; l++) {
    const la = (l / 5) * Math.PI * 2;
    const lx = halfW * 0.7 - dishDepth + 0.008;
    const ly = Math.cos(la) * lugR;
    const lz = Math.sin(la) * lugR;
    acc.box(lx, ly, lz, 0.008, 0.012, 0.012, P.metalBright);
  }
}

// ---------------------------------------------------------------------------
// Split Windscreen: Frame, Center Divider, Dual Panes & Wipers
// ---------------------------------------------------------------------------
function buildWindscreen(acc, P) {
  // Outer tubular frame
  acc.box(0.0, 0.0, 0.44, 0.68, 0.018, 0.018, P.oliveDrab); // top rail
  acc.box(0.0, 0.0, 0.02, 0.68, 0.018, 0.018, P.oliveDrab); // bottom rail
  acc.box(-0.67, 0.0, 0.23, 0.018, 0.018, 0.21, P.oliveDrab); // left frame
  acc.box(0.67, 0.0, 0.23, 0.018, 0.018, 0.21, P.oliveDrab);  // right frame
  // Center vertical divider bar
  acc.box(0.0, 0.0, 0.23, 0.018, 0.018, 0.21, P.oliveDrab);
  // Dual top wiper motors & wiper blades
  for (const sx of [-0.34, 0.34]) {
    acc.box(sx, 0.022, 0.43, 0.03, 0.02, 0.025, P.toolSteel); // motor housing
    acc.tube([sx, 0.02, 0.43], [sx + 0.10, 0.015, 0.20], 0.004, 0.004, 6, P.toolSteel); // arm
    acc.box(sx + 0.10, 0.012, 0.20, 0.01, 0.008, 0.09, P.tireRubber); // rubber blade
  }
  // Driver-side exterior round rear-view mirror
  acc.tube([-0.68, 0.0, 0.25], [-0.76, 0.06, 0.28], 0.006, 0.006, 6, P.toolSteel);
  acc.cylinder(-0.76, 0.07, 0.28, 0.045, 0.012, 12, P.metalBright, "y");
  // Dual clear glass panes
  acc.box(-0.34, 0.0, 0.23, 0.31, 0.006, 0.19, P.glassClear);
  acc.box(0.34, 0.0, 0.23, 0.31, 0.006, 0.19, P.glassClear);
}

// ---------------------------------------------------------------------------
// 3-Spoke Steering Wheel on 30° Raked Column
// ---------------------------------------------------------------------------
function buildSteeringWheel(acc, P) {
  const rimR = 0.18;
  const rimTubeR = 0.016;
  const segs = 20;
  // 30° Raked steering column tube extending down to floor
  acc.tube([0.0, -0.45, -0.78], [0.0, 0.0, 0.0], 0.022, 0.022, 10, P.oliveDrabDark);
  // Central horn button / hub
  acc.cylinder(0.0, 0.0, 0.0, 0.042, 0.028, 14, P.metalBright, "z");
  // 3 Spokes at 0°, 120°, 240°
  for (let s = 0; s < 3; s++) {
    const ang = (s * 120 * Math.PI) / 180;
    const px = Math.cos(ang) * rimR;
    const py = Math.sin(ang) * rimR;
    acc.tube([0, 0, 0], [px, py, 0], 0.009, 0.009, 6, P.toolSteel);
  }
  // Torus outer steering wheel rim
  for (let i = 0; i < segs; i++) {
    const a0 = (i / segs) * Math.PI * 2;
    const a1 = ((i + 1) / segs) * Math.PI * 2;
    const p0 = [Math.cos(a0) * rimR, Math.sin(a0) * rimR, 0];
    const p1 = [Math.cos(a1) * rimR, Math.sin(a1) * rimR, 0];
    acc.tube(p0, p1, rimTubeR, rimTubeR, 8, P.tireRubber);
  }
}

// ---------------------------------------------------------------------------
// Main Procedural Jeep Factory: buildProceduralJeep
// ---------------------------------------------------------------------------
export function buildProceduralJeep(three, profile = {}, options = {}) {
  const t = three || THREE_DEFAULT;
  const opts = options || {};
  const liveScene3d = opts.liveScene3d || { activeLights: [] };
  const root = new t.Group();
  root.name = "jeep-mb-root";

  const P = makePaletteLinear(t);

  // ---- PBR Material Stack (calibrated for AGX HDR exposure = 5.0) ----
  // Note: color MUST be 0xffffff when vertexColors: true so Three.js does not square linear albedo into black!
  const matBody = new t.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.62,
    metalness: 0.18,
    vertexColors: true,
    side: t.DoubleSide,
  });
  matBody.castShadow = true;
  matBody.receiveShadow = true;

  const matMetal = new t.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.36,
    metalness: 0.68,
    vertexColors: true,
  });
  matMetal.castShadow = true;
  matMetal.receiveShadow = true;

  const matRubberCanvas = new t.MeshStandardMaterial({
    color: 0xffffff, // unattenuated vertex colors: canvasKhaki vs tireRubber vs combat rim
    roughness: 0.84,
    metalness: 0.04,
    vertexColors: true,
  });
  matRubberCanvas.castShadow = true;
  matRubberCanvas.receiveShadow = true;

  const matGlass = new t.MeshStandardMaterial({
    color: 0x0e161a,
    roughness: 0.12,
    metalness: 0.10,
    opacity: 0.34,
    transparent: true,
    depthWrite: false,
    side: t.DoubleSide,
  });

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

  // ---- 1. Suspension Corner Groups & Rolling Wheels ----
  // suspFL & suspFR corner groups
  const suspFL = new t.Group();
  suspFL.name = "suspFL";
  suspFL.position.set(-0.74, 1.02, 0.38);

  const steerPivotFL = new t.Group();
  steerPivotFL.name = "steerPivotFL";
  suspFL.add(steerPivotFL);

  const accWheel = new GeomAcc();
  buildCombatWheel(accWheel, P);
  const geomCombatWheel = accWheel.toBufferGeometry(t);

  const wheelFL = new t.Mesh(geomCombatWheel, matRubberCanvas);
  wheelFL.name = "wheelFL";
  wheelFL.rotation.z = Math.PI / 2;
  wheelFL.castShadow = true;
  wheelFL.receiveShadow = true;
  steerPivotFL.add(wheelFL);

  const suspFR = new t.Group();
  suspFR.name = "suspFR";
  suspFR.position.set(0.74, 1.02, 0.38);

  const steerPivotFR = new t.Group();
  steerPivotFR.name = "steerPivotFR";
  suspFR.add(steerPivotFR);

  const wheelFR = new t.Mesh(geomCombatWheel, matRubberCanvas);
  wheelFR.name = "wheelFR";
  wheelFR.rotation.z = Math.PI / 2;
  wheelFR.castShadow = true;
  wheelFR.receiveShadow = true;
  steerPivotFR.add(wheelFR);

  // suspRL & suspRR rear corner groups
  const suspRL = new t.Group();
  suspRL.name = "suspRL";
  suspRL.position.set(-0.74, -1.02, 0.38);

  const wheelRL = new t.Mesh(geomCombatWheel, matRubberCanvas);
  wheelRL.name = "wheelRL";
  wheelRL.rotation.z = Math.PI / 2;
  wheelRL.castShadow = true;
  wheelRL.receiveShadow = true;
  suspRL.add(wheelRL);

  const suspRR = new t.Group();
  suspRR.name = "suspRR";
  suspRR.position.set(0.74, -1.02, 0.38);

  const wheelRR = new t.Mesh(geomCombatWheel, matRubberCanvas);
  wheelRR.name = "wheelRR";
  wheelRR.rotation.z = Math.PI / 2;
  wheelRR.castShadow = true;
  wheelRR.receiveShadow = true;
  suspRR.add(wheelRR);

  root.add(suspFL, suspFR, suspRL, suspRR);

  // ---- 2. Decoupled Dummy Cargo Groups (Backward Compatibility) ----
  const cargoCrateGroup = new t.Group();
  cargoCrateGroup.name = "cargoCrateGroup";
  cargoCrateGroup.position.set(0.0, -1.15, 0.72);
  root.add(cargoCrateGroup);

  const cargoSlotFull = new t.Group();
  cargoSlotFull.name = "cargoSlotFull";
  const cargoSlot0 = new t.Group();
  cargoSlot0.name = "cargoSlot0";
  const cargoSlot1 = new t.Group();
  cargoSlot1.name = "cargoSlot1";

  // ---- 3. Chassis Body Group (Squat, Dive, Roll) ----
  const chassisBodyGroup = new t.Group();
  chassisBodyGroup.name = "chassisBodyGroup";
  root.add(chassisBodyGroup);

  // 3.1 Tub, frame, grille, radiator, hood, invasion star mesh
  const accTub = new GeomAcc();
  buildTubAndChassis(accTub, P);
  const geomTub = accTub.toBufferGeometry(t);
  const tubMesh = new t.Mesh(geomTub, matBody);
  tubMesh.name = "tub-chassis";
  tubMesh.castShadow = true;
  tubMesh.receiveShadow = true;
  chassisBodyGroup.add(tubMesh);

  // 3.2 Interior cushions (Seat 0 Driver, Seat 1 Shotgun, Seats 2 & 3 Rear Bench)
  const accCushions = new GeomAcc();
  buildCushions(accCushions, P);
  const geomCushions = accCushions.toBufferGeometry(t);
  const cushionMesh = new t.Mesh(geomCushions, matRubberCanvas);
  cushionMesh.name = "interior-cushions";
  cushionMesh.castShadow = true;
  cushionMesh.receiveShadow = true;
  chassisBodyGroup.add(cushionMesh);

  // 3.3 Dash passenger grab-bar
  const grabBar = new t.Mesh(new t.CylinderGeometry(0.015, 0.015, 0.28), matMetal);
  grabBar.name = "dash-grabbar";
  grabBar.position.set(0.38, 0.42, 0.82);
  grabBar.rotation.z = Math.PI / 2;
  grabBar.castShadow = true;
  chassisBodyGroup.add(grabBar);

  // 3.4 Pioneer tools (shovel & axe batched)
  const accTools = new GeomAcc();
  // Shovel
  accTools.tube([-0.75, 0.40, 0.48], [-0.75, -0.40, 0.48], 0.018, 0.018, 8, P.woodShaft);
  accTools.box(-0.75, -0.50, 0.48, 0.02, 0.12, 0.10, P.toolSteel);
  // Axe
  accTools.tube([-0.75, 0.25, 0.52], [-0.75, -0.20, 0.52], 0.016, 0.016, 8, P.woodShaft);
  accTools.box(-0.75, -0.25, 0.52, 0.025, 0.06, 0.08, P.toolSteel);
  const toolsMesh = new t.Mesh(accTools.toBufferGeometry(t), matMetal);
  toolsMesh.name = "pioneer-tools";
  toolsMesh.castShadow = true;
  chassisBodyGroup.add(toolsMesh);

  // 3.5 Rear 5-gallon jerrycan
  const accJerrycan = new GeomAcc();
  accJerrycan.box(0, 0, 0, 0.09, 0.175, 0.23, P.oliveDrab); // main can body
  accJerrycan.box(0, 0, 0.24, 0.07, 0.14, 0.02, P.toolSteel); // 3-handle top
  accJerrycan.cylinder(0.04, 0.12, 0.25, 0.022, 0.03, 10, P.metalBright, "z"); // spout cap
  const jerrycan = new t.Mesh(accJerrycan.toBufferGeometry(t), matBody);
  jerrycan.name = "jerrycan";
  jerrycan.position.set(-0.55, -1.62, 0.65);
  jerrycan.castShadow = true;
  chassisBodyGroup.add(jerrycan);

  // 3.6 5th Combat Wheel (Spare Tire mounted on rear)
  const spareTire = new t.Mesh(geomCombatWheel, matRubberCanvas);
  spareTire.name = "spare-tire";
  spareTire.position.set(0.0, -1.65, 0.65);
  spareTire.rotation.x = Math.PI / 2;
  spareTire.castShadow = true;
  chassisBodyGroup.add(spareTire);

  // 3.7 Articulated Folding Windscreen
  const windscreenPivot = new t.Group();
  windscreenPivot.name = "windscreenPivot";
  windscreenPivot.position.set(0.0, 0.48, 0.88);
  const accWindscreen = new GeomAcc();
  buildWindscreen(accWindscreen, P);
  const glassMesh = new t.Mesh(accWindscreen.toBufferGeometry(t), matGlass);
  glassMesh.name = "windscreen-glass";
  windscreenPivot.add(glassMesh);
  chassisBodyGroup.add(windscreenPivot);

  // 3.8 Tailgate Pivot
  const tailgatePivot = new t.Group();
  tailgatePivot.name = "tailgatePivot";
  tailgatePivot.position.set(0.0, -1.58, 0.35);
  const accTailgate = new GeomAcc();
  accTailgate.box(0.0, 0.0, 0.23, 0.60, 0.015, 0.22, P.oliveDrab);
  accTailgate.box(0.0, -0.01, 0.23, 0.54, 0.008, 0.04, P.oliveDrabDark); // stamped stiffener rib
  const tailgateMesh = new t.Mesh(accTailgate.toBufferGeometry(t), matBody);
  tailgateMesh.name = "tailgate-mesh";
  tailgateMesh.castShadow = true;
  tailgatePivot.add(tailgateMesh);
  chassisBodyGroup.add(tailgatePivot);

  // 3.9 Steering Wheel Pivot (30° raked column)
  const steeringWheelPivot = new t.Group();
  steeringWheelPivot.name = "steeringWheelPivot";
  steeringWheelPivot.position.set(-0.38, 0.35, 0.88);
  steeringWheelPivot.rotation.x = 30 * (Math.PI / 180);
  const accWheelSteer = new GeomAcc();
  buildSteeringWheel(accWheelSteer, P);
  const steeringWheelMesh = new t.Mesh(accWheelSteer.toBufferGeometry(t), matMetal);
  steeringWheelMesh.name = "steering-wheel-mesh";
  steeringWheelMesh.castShadow = true;
  steeringWheelPivot.add(steeringWheelMesh);
  chassisBodyGroup.add(steeringWheelPivot);

  // 3.10 Dash Speedometer Needle Pivot
  const speedoNeedlePivot = new t.Group();
  speedoNeedlePivot.name = "speedoNeedlePivot";
  speedoNeedlePivot.position.set(-0.18, 0.468, 0.78);
  const accNeedle = new GeomAcc();
  accNeedle.box(0.0, 0.012, 0.0, 0.002, 0.014, 0.002, P.starWhite);
  const speedoNeedleMesh = new t.Mesh(accNeedle.toBufferGeometry(t), matEmissiveFx);
  speedoNeedleMesh.name = "speedo-needle-mesh";
  speedoNeedlePivot.add(speedoNeedleMesh);
  chassisBodyGroup.add(speedoNeedlePivot);

  // 3.11 T-84 Shifter Cane Pivot
  const shifterPivot = new t.Group();
  shifterPivot.name = "shifterPivot";
  shifterPivot.position.set(-0.08, 0.15, 0.45);
  const accShifter = new GeomAcc();
  accShifter.tube([0, 0, 0], [0, 0.05, 0.28], 0.012, 0.010, 8, P.toolSteel);
  accShifter.cylinder(0, 0.05, 0.29, 0.022, 0.03, 10, P.tireRubber, "z"); // round shift knob
  const shifterMesh = new t.Mesh(accShifter.toBufferGeometry(t), matMetal);
  shifterMesh.name = "shifter-mesh";
  shifterMesh.castShadow = true;
  shifterPivot.add(shifterMesh);
  chassisBodyGroup.add(shifterPivot);

  // 3.12 4WD Low Transfer Case Pivot
  const transferCasePivot = new t.Group();
  transferCasePivot.name = "transferCasePivot";
  transferCasePivot.position.set(0.04, 0.18, 0.45);
  chassisBodyGroup.add(transferCasePivot);

  // 3.13 Headlight Additive Beams Cone
  const headlightBeams = new t.Mesh(new t.ConeGeometry(0.45, 4.0, 12), matAdditive);
  headlightBeams.name = "headlightBeams";
  headlightBeams.position.set(0.0, 3.6, 0.68);
  headlightBeams.rotation.x = Math.PI;
  headlightBeams.visible = false; // vfx-lint-allow: headlight beam toggle initial
  chassisBodyGroup.add(headlightBeams);

  // ---- 4. Pooled FxLightSource Carrier (Strictly Zero Added THREE.Light) ----
  const pooledLight = new FxLightSource("emitter");
  pooledLight.color.setHex(0xffffea);
  pooledLight.distance = 25;
  pooledLight.intensity = 0;
  if (Array.isArray(liveScene3d.activeLights)) {
    liveScene3d.activeLights.push(pooledLight);
  }

  const lightOffset = new t.Vector3(0.0, 1.6, 0.65);
  const tmpLightVec = new t.Vector3();
  let headlightsState = false;
  let wheelRollAngle = 0;

  const rollingWheels = [wheelFL, wheelFR, wheelRL, wheelRR];
  const allWheels = [wheelFL, wheelFR, wheelRL, wheelRR, spareTire];

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
    transferCase: transferCasePivot,
    transferCasePivot,
    windscreen: windscreenPivot,
    windscreenPivot,
    tailgate: tailgatePivot,
    tailgatePivot,
    suspFL,
    suspFR,
    suspRL,
    suspRR,
  });

  return {
    root,
    chassisBodyGroup,
    suspFL,
    suspFR,
    suspRL,
    suspRR,
    steerPivotFL,
    steerPivotFR,
    steeringWheelPivot,
    speedoNeedlePivot,
    shifterPivot,
    transferCasePivot,
    windscreenPivot,
    tailgatePivot,
    pivots,
    maxDrawCalls: JEEP_DIMENSIONS.maxDrawCalls,
    wheels: allWheels,
    rollingWheels,
    wheelSpare: spareTire,
    spareTire,
    cargoCrateGroup,
    cargoSlotFull,
    cargoSlot0,
    cargoSlot1,
    cargoOffsets: PALLET_MOUNT_OFFSETS,
    headlightBeams,
    pooledLight,
    materials: {
      matBody,
      matMetal,
      matRubberCanvas,
      matGlass,
      matEmissiveFx,
      matAdditive,
    },
    get wheelRollAngle() { return wheelRollAngle; },
    update(state = {}, argDt) {
      const s = state || {};
      const dt = Number.isFinite(s.dt) ? s.dt : (Number.isFinite(argDt) ? argDt : 0.0333);
      const speed = Number.isFinite(s.speed) ? s.speed : 0;

      // 1. Steer angle & speed scheduling
      let maxSteer = JEEP_DIMENSIONS.maxSteerLowSpeedRad;
      if (Math.abs(speed) > 12.0) {
        const frac = Math.min(1.0, (Math.abs(speed) - 12.0) / (29.0 - 12.0));
        maxSteer = JEEP_DIMENSIONS.maxSteerLowSpeedRad +
          (JEEP_DIMENSIONS.maxSteerHighSpeedRad - JEEP_DIMENSIONS.maxSteerLowSpeedRad) * frac;
      }
      const steerInput = Number.isFinite(s.steerAngle) ? s.steerAngle : 0;
      const clampedSteer = Math.max(-maxSteer, Math.min(maxSteer, steerInput));

      steerPivotFL.rotation.z = clampedSteer;
      steerPivotFR.rotation.z = clampedSteer;

      // Steering wheel 2.5x ratio clamped to ±100° (1.745 rad)
      const swAngle = Math.max(-1.745, Math.min(1.745, clampedSteer * JEEP_DIMENSIONS.steeringGearRatio));
      steeringWheelPivot.rotation.z = swAngle;

      // 2. Wheel rolling kinematics
      if (dt > 0 && Math.abs(speed) > 1e-6) {
        const dRoll = (speed * dt) / JEEP_DIMENSIONS.wheelRadius;
        if (Number.isFinite(dRoll)) {
          wheelRollAngle = (wheelRollAngle + dRoll) % (2 * Math.PI);
          if (wheelRollAngle < 0) wheelRollAngle += 2 * Math.PI;
          for (const w of rollingWheels) {
            w.rotation.x = wheelRollAngle;
          }
        }
      }

      // 3. Speedometer needle animation (mapped 0..45 m/s over 240° dial sweep)
      const speedClamped = Math.max(0, Math.min(45.0, Math.abs(speed)));
      const needleSweep = (speedClamped / 45.0) * (240 * (Math.PI / 180));
      speedoNeedlePivot.rotation.z = -(needleSweep - (120 * (Math.PI / 180)));

      // 4. T-84 Transmission Shifter Cane Kinematics
      let gear = s.gear;
      if (gear === undefined) {
        if (speed < -0.1) gear = -1;
        else if (Math.abs(speed) < 0.1) gear = 0;
        else if (speed < 9.0) gear = 1;
        else if (speed < 18.0) gear = 2;
        else gear = 3;
      }
      if (gear === -1) {
        shifterPivot.rotation.x = -0.15;
        shifterPivot.rotation.y = -0.15;
      } else if (gear === 1) {
        shifterPivot.rotation.x = 0.18;
        shifterPivot.rotation.y = -0.15;
      } else if (gear === 2) {
        shifterPivot.rotation.x = -0.15;
        shifterPivot.rotation.y = 0.15;
      } else if (gear === 3) {
        shifterPivot.rotation.x = 0.18;
        shifterPivot.rotation.y = 0.15;
      } else {
        shifterPivot.rotation.x = 0.0;
        shifterPivot.rotation.y = 0.0;
      }

      // 5. 4WD Low Range Transfer Case Lever
      const is4WdLow = Boolean(s.boost || s.fourWheelLow);
      transferCasePivot.rotation.x = is4WdLow ? 0.22 : 0.0;

      // 6. Suspension corner compression & body squat/dive/roll
      const accel = Number.isFinite(s.accel) ? s.accel : 0;
      const steerAcc = clampedSteer * speed;
      chassisBodyGroup.rotation.x = Math.max(-0.08, Math.min(0.08, -accel * 0.005));
      chassisBodyGroup.rotation.y = Math.max(-0.06, Math.min(0.06, steerAcc * 0.003));

      if (Number.isFinite(s.suspensionFL)) suspFL.position.z = 0.38 + s.suspensionFL;
      if (Number.isFinite(s.suspensionFR)) suspFR.position.z = 0.38 + s.suspensionFR;
      if (Number.isFinite(s.suspensionRL)) suspRL.position.z = 0.38 + s.suspensionRL;
      if (Number.isFinite(s.suspensionRR)) suspRR.position.z = 0.38 + s.suspensionRR;

      // 7. Windscreen folding flat onto hood
      if (s.windscreenFolded !== undefined) {
        windscreenPivot.rotation.x = s.windscreenFolded ? Math.PI / 2 : 0;
      }

      // 8. Backward compatibility bridge for cargoCrateGroup
      if (s.cargoLoaded !== undefined) {
        cargoCrateGroup.visible = Boolean(s.cargoLoaded); // vfx-lint-allow: cargo visibility backward compatibility
      }

      // 9. Headlights (pooled carrier + HDR-calibrated subtle additive beam cone, zero light churn)
      const headlightsProvided = s.headlights !== undefined;
      if (headlightsProvided) {
        headlightsState = Boolean(s.headlights);
        headlightBeams.visible = headlightsState; // vfx-lint-allow: additive beam mesh toggle
        matAdditive.opacity = headlightsState ? 0.05 : 0.0;
        pooledLight.intensity = headlightsState ? 2.5 : 0.0;
      }
      if (headlightsState || headlightsProvided) {
        tmpLightVec.copy(lightOffset).applyQuaternion(root.quaternion);
        pooledLight.position.copy(root.position).add(tmpLightVec);
      }
    },
    dispose() {
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
  id: "vfx-jeep-mb-model",
  channel: "vehicleModel",
  deterministic: true,
  lightCountDelta: 0,
  cacheKeyScope: "set",
  reads: ["geometry", "serverPose", "clock"],
  writes: ["renderTransform", "partTransform", "lightIntensity"],
});
