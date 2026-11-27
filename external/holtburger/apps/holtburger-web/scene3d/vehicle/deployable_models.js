// scene3d/vehicle/deployable_models.js — 8-Unit Modular Unified Pallet Deployable 3D Procedural Models
// Conforms to HBV1 v7 wire protocol, Unified ISO 6780 1.100 × 1.100 × 0.145 m 4-Way Block Pallet,
// AGX HDR PBR MeshStandardMaterial with 3-cascade CSM PCF shadow reception,
// shared GeomAcc procedural mesh builder (linear RGB + vertical AO shading),
// and strict GPU invariants (lightCountDelta === 0, draw calls <= 10, stowed |x|,|y| <= 0.550 m, z <= 2.05 m).
// Built in AC Z-up coordinates (+x east/right, +y north/forward, +z up).

import * as THREE_DEFAULT from "three";
import { installCsmShaderPatch } from "../materials.js";
import {
  PROSPECTING_WCID,
  PROSPECTING_KIND,
  INDUSTRIAL_SKID_WCID,
  INDUSTRIAL_SKID_KIND,
  CIVIC_WCID,
  CIVIC_KIND,
} from "./economy_specs.js";
import { buildProspectingDeployable } from "./prospecting_models.js";
import { buildIndustryDeployable } from "./industry_models.js";
import { buildCivicDeployable } from "./civic_models.js";

export const PALLET_SPECS = Object.freeze({
  standard: Object.freeze({
    width: 1.100,
    depth: 1.100,
    height: 0.145,
    deckUndersideZ: 0.123,
    tunnelMinZ: 0.018,
    tunnelMaxZ: 0.123,
    slots: 1,
    bboxMin: Object.freeze([-0.550, -0.550, 0.0]),
    bboxMax: Object.freeze([0.550, 0.550, 0.145]),
  }),
  // Backward-compatible alias (`full` points to `standard`; `half` retired)
  get full() {
    return this.standard;
  },
  mountOffsets: Object.freeze({
    fullBed: Object.freeze([0.0, -1.15, 0.72]),
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
  ...PROSPECTING_KIND,  // 38..42
  ...INDUSTRIAL_SKID_KIND, // 43..55
  ...CIVIC_KIND,        // 56..61
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
  ...PROSPECTING_WCID,  // 4000070..4000074
  ...INDUSTRIAL_SKID_WCID, // 4000075..4000087
  ...CIVIC_WCID,        // 4000090..4000095
});

export const GRID_SPECS = Object.freeze({
  halfExtentM: 75.0,
  batteryMaxJoules: 600000.0,
  laserDischargeJoules: 120000.0,
  generatorKw: 45.0,
  scarabBurnSec: 120.0,
});

// ---------------------------------------------------------------------------
// Shared Procedural Geometry Engine (GeomAcc — linear RGB + vertical AO)
// Matches semi_truck_model.js / jeep_model.js conventions
// ---------------------------------------------------------------------------
function vSub(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function vAdd(a, b) {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}
function vScale(a, s) {
  return [a[0] * s, a[1] * s, a[2] * s];
}
function vCross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function vNorm(a) {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}

export function cShade(c, f) {
  return c.length === 4 ? [c[0] * f, c[1] * f, c[2] * f, c[3]] : [c[0] * f, c[1] * f, c[2] * f];
}

export function makeLinearPalette(THREE, hexMap) {
  const tmp = new THREE.Color();
  const out = {};
  for (const [k, hex] of Object.entries(hexMap)) {
    tmp.setHex(hex);
    out[k] = [tmp.r, tmp.g, tmp.b];
  }
  return out;
}

export function makeDeployablePbrMaterial(THREE, { roughness = 0.55, metalness = 0.35, side, csmState } = {}) {
  const opts = {
    color: 0xffffff,
    vertexColors: true,
    roughness,
    metalness,
  };
  if (side !== undefined) opts.side = side;
  const mat = new THREE.MeshStandardMaterial(opts);
  mat.castShadow = true;
  mat.receiveShadow = true;
  if (csmState) installCsmShaderPatch(mat, csmState);
  return mat;
}

export function makeLampsMaterial(THREE, { emissiveIntensity = 0.65, roughness = 0.25 } = {}) {
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    emissive: 0xffffff,
    emissiveIntensity,
    roughness,
  });
  mat.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      "vec3 totalEmissiveRadiance = emissive;",
      "vec3 totalEmissiveRadiance = emissive * vColor.rgb;",
    );
  };
  return mat;
}

export class GeomAcc {
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

  /** Loft a sequence of rings `{ pts: [[x,y,z],...], cols: [[r,g,b],...] }` with smooth vertex normals. */
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
      const a = rings[s];
      const b = rings[s + 1];
      const na = nors[s];
      const nb = nors[s + 1];
      for (let i = 0; i < segCount; i++) {
        const j = (i + 1) % n;
        this.quad(
          a.pts[i], a.pts[j], b.pts[j], b.pts[i],
          a.cols[i], a.cols[j], b.cols[j], b.cols[i],
          na[i], na[j], nb[j], nb[i],
        );
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

  /** Chamfered octagonal-corner prism along Z with vertical AO shading. */
  bevelBox(cx, cy, cz, hx, hy, hz, bev, colTop, colBot = cShade(colTop, 0.85), xf = null) {
    const b = Math.min(bev, hx * 0.45, hy * 0.45);
    if (b <= 1e-5) {
      this.box(cx, cy, cz, hx, hy, hz, colTop, colBot, xf);
      return;
    }
    const ring = [
      [hx - b, -hy],
      [hx, -hy + b],
      [hx, hy - b],
      [hx - b, hy],
      [-hx + b, hy],
      [-hx, hy - b],
      [-hx, -hy + b],
      [-hx + b, -hy],
    ];
    const tx = (x, y, z) => {
      const p = [cx + x, cy + y, cz + z];
      return xf ? xf(p) : p;
    };
    const bot = ring.map(([x, y]) => tx(x, y, -hz));
    const top = ring.map(([x, y]) => tx(x, y, +hz));
    const botC = tx(0, 0, -hz);
    const topC = tx(0, 0, +hz);
    for (let i = 0; i < 8; i++) {
      const j = (i + 1) % 8;
      this.quad(bot[i], bot[j], top[j], top[i], colBot, colBot, colTop, colTop);
      this.tri(topC, top[i], top[j], colTop, colTop, colTop);
      this.tri(botC, bot[j], bot[i], colBot, colBot, colBot);
    }
  }

  /** Cylinder along arbitrary axis ("x", "y", "z"). */
  cylinder(cx, cy, cz, radius, height, segs, colTop, axis = "y", cap0 = true, cap1 = true, colBot = colTop) {
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
    this.tube(p0, p1, radius, radius, segs, colBot, colTop, cap0, cap1);
  }

  /** Tapered cylinder / frustum / cone along arbitrary axis. */
  cone(cx, cy, cz, rBot, rTop, height, segs, colTop, axis = "z", cap0 = true, cap1 = true, colBot = cShade(colTop, 0.85)) {
    const halfH = height * 0.5;
    let p0;
    let p1;
    if (axis === "x") {
      p0 = [cx - halfH, cy, cz];
      p1 = [cx + halfH, cy, cz];
    } else if (axis === "y") {
      p0 = [cx, cy - halfH, cz];
      p1 = [cx, cy + halfH, cz];
    } else {
      p0 = [cx, cy, cz - halfH];
      p1 = [cx, cy, cz + halfH];
    }
    this.tube(p0, p1, rBot, rTop, segs, colBot, colTop, cap0, cap1);
  }

  toBufferGeometry(THREE) {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(this.pos), 3));
    g.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(this.nor), 3));
    g.setAttribute("color", new THREE.BufferAttribute(new Float32Array(this.col), this.cc));
    if (this.withUv) {
      g.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(this.uv), 2));
    }
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

export function disposeRootResources(root, excludeMeshes = [], extraMaterials = []) {
  const skip = new Set(excludeMeshes);
  const geoms = new Set();
  const mats = new Set();
  root.traverse((obj) => {
    if (skip.has(obj)) return;
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
  for (const m of extraMaterials) {
    if (m && !mats.has(m)) {
      m.dispose();
      mats.add(m);
    }
  }
}

// ---------------------------------------------------------------------------
// Unified ISO 6780 Modular 4-Way Block Pallet (1.100 × 1.100 × 0.145 m)
// - 9 blocks (4 steel-armored corners + 4 edge mid-blocks + 1 center block)
// - True symmetric 4-way fork tunnels: x/y ∈ ±[0.090, 0.390], z ∈ [0.018, 0.123]
// - Bottom perimeter runners with load-wheel cutouts at ±[0.165, 0.360] (z ∈ [0.000, 0.018])
// - 7 staggered hardwood deck planks inside steel C-channel perimeter lip + yellow corner tabs + ISPM-15 stencil
// - Retractable corner leveling jacks (`levelingJacks` mesh): <= 2 total draw calls
// ---------------------------------------------------------------------------
export function buildPallet(three, size = "standard", options = {}) {
  const t = three || THREE_DEFAULT;
  const spec = PALLET_SPECS.standard;
  const normSize = "standard";
  const root = new t.Group();
  root.name = "pallet-standard-root";

  const P = makeLinearPalette(t, {
    oakLight: 0x8a6c4c,
    oakMid: 0x7b5e40,
    oakDark: 0x6b5035,
    oakBlock: 0x5c442d,
    steelArmor: 0x2f353b,
    steelChannel: 0x3b4248,
    safetyYellow: 0xe6aa18,
    hazardDark: 0x1b1e22,
    stencilBg: 0x1a1410,
    stencilInk: 0xc8bfa8,
    dRing: 0x9aa3ab,
  });

  const deckAcc = new GeomAcc();

  // 1. Bottom Perimeter Runners with load-wheel cutouts at ±[0.165, 0.360] (z ∈ [0.000, 0.018])
  const botCz = 0.009;
  const botHz = 0.009;
  const runW = 0.080; // half-width -> 0.160m wide perimeter strips at ±[0.390, 0.550]
  const edgeCenter = 0.470;
  // Perimeter corners + mid-bridges + center cross (zero obstruction in ±[0.165, 0.360])
  for (const sy of [-edgeCenter, edgeCenter]) {
    deckAcc.box(-0.455, sy, botCz, 0.095, runW, botHz, P.oakBlock, cShade(P.oakBlock, 0.78));
    deckAcc.box(0.0, sy, botCz, 0.165, runW, botHz, P.oakBlock, cShade(P.oakBlock, 0.78));
    deckAcc.box(0.455, sy, botCz, 0.095, runW, botHz, P.oakBlock, cShade(P.oakBlock, 0.78));
  }
  for (const sx of [-edgeCenter, edgeCenter]) {
    deckAcc.box(sx, 0.0, botCz, runW, 0.165, botHz, P.oakBlock, cShade(P.oakBlock, 0.78));
  }
  deckAcc.box(0.0, 0.0, botCz, 0.090, 0.390, botHz, P.oakBlock, cShade(P.oakBlock, 0.78));
  deckAcc.box(-0.240, 0.0, botCz, 0.150, 0.090, botHz, P.oakBlock, cShade(P.oakBlock, 0.78));
  deckAcc.box(0.240, 0.0, botCz, 0.150, 0.090, botHz, P.oakBlock, cShade(P.oakBlock, 0.78));

  // 2. 9 Structural Blocks (z ∈ [0.018, 0.123], cz = 0.0705, hz = 0.0525)
  // Leaves 4-way fork tunnels completely open in x/y ∈ ±[0.090, 0.390]
  const blkCz = 0.0705;
  const blkHz = 0.0525;
  // 4 Corner blocks with dark gunmetal steel corner armor + recessed tie-down D-rings
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      const cx = sx * 0.470;
      const cy = sy * 0.470;
      // Inner hardwood core block (0.156 × 0.156)
      deckAcc.box(cx, cy, blkCz, 0.078, 0.078, blkHz, P.oakDark, cShade(P.oakDark, 0.80));
      // Outer steel corner armor L-plates (flush at ±0.550)
      deckAcc.box(sx * 0.544, cy, blkCz, 0.006, 0.080, blkHz, P.steelArmor, cShade(P.steelArmor, 0.82));
      deckAcc.box(cx, sy * 0.544, blkCz, 0.080, 0.006, blkHz, P.steelArmor, cShade(P.steelArmor, 0.82));
      // Recessed tie-down D-ring bar on outer Y face (flush inside ±0.550)
      deckAcc.tube(
        [cx - 0.030, sy * 0.543, blkCz],
        [cx + 0.030, sy * 0.543, blkCz],
        0.005, 0.005, 6, P.dRing, P.dRing, true, true,
      );
    }
  }
  // 4 Edge mid-blocks (x/y ∈ [-0.090, +0.090] × ±[0.390, 0.550])
  for (const sy of [-edgeCenter, edgeCenter]) {
    deckAcc.box(0.0, sy, blkCz, 0.090, 0.080, blkHz, P.oakBlock, cShade(P.oakBlock, 0.82));
  }
  for (const sx of [-edgeCenter, edgeCenter]) {
    deckAcc.box(sx, 0.0, blkCz, 0.080, 0.090, blkHz, P.oakBlock, cShade(P.oakBlock, 0.82));
  }
  // 1 Center block ([-0.090, +0.090] × [-0.090, +0.090])
  deckAcc.box(0.0, 0.0, blkCz, 0.090, 0.090, blkHz, P.oakBlock, cShade(P.oakBlock, 0.80));

  // ISPM-15 HT stencil plate on -Y and +Y center blocks
  for (const sy of [-1, 1]) {
    deckAcc.box(0.0, sy * 0.548, blkCz, 0.055, 0.002, 0.022, P.stencilBg, P.stencilBg);
    deckAcc.box(0.0, sy * 0.549, blkCz, 0.044, 0.001, 0.014, P.stencilInk, P.stencilInk);
  }

  // 3. Top Deck (z ∈ [0.123, 0.145], cz = 0.134, hz = 0.011)
  // Dark steel C-channel perimeter rails stopping cleanly at ±0.478 before yellow corner tabs
  const topCz = 0.134;
  const topHz = 0.011;
  deckAcc.box(0.0, -0.538, topCz, 0.478, 0.012, topHz, P.steelChannel, cShade(P.steelChannel, 0.82));
  deckAcc.box(0.0, +0.538, topCz, 0.478, 0.012, topHz, P.steelChannel, cShade(P.steelChannel, 0.82));
  deckAcc.box(-0.538, 0.0, topCz, 0.012, 0.478, topHz, P.steelChannel, cShade(P.steelChannel, 0.82));
  deckAcc.box(+0.538, 0.0, topCz, 0.012, 0.478, topHz, P.steelChannel, cShade(P.steelChannel, 0.82));

  // Yellow corner alignment tabs (non-overlapping L-arms flush inside ±0.550, z ∈ [0.123, 0.145])
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      deckAcc.box(sx * 0.514, sy * 0.538, topCz, 0.036, 0.012, topHz, P.safetyYellow, cShade(P.safetyYellow, 0.85));
      deckAcc.box(sx * 0.538, sy * 0.502, topCz, 0.012, 0.024, topHz, P.safetyYellow, cShade(P.safetyYellow, 0.85));
    }
  }

  // 7 Staggered AO-shaded hardwood deck planks inside the steel C-channel (x ∈ [-0.526, +0.526])
  const plankSpec = [
    { y: -0.456, hy: 0.068, col: P.oakLight },
    { y: -0.308, hy: 0.056, col: P.oakMid },
    { y: -0.156, hy: 0.058, col: P.oakDark },
    { y:  0.000, hy: 0.064, col: P.oakLight },
    { y: +0.156, hy: 0.058, col: P.oakMid },
    { y: +0.308, hy: 0.056, col: P.oakDark },
    { y: +0.456, hy: 0.068, col: P.oakLight },
  ];
  for (const pl of plankSpec) {
    deckAcc.box(0.0, pl.y, topCz, 0.526, pl.hy, topHz, pl.col, cShade(pl.col, 0.84));
  }

  const geom = deckAcc.toBufferGeometry(t);
  const mat = makeDeployablePbrMaterial(t, { roughness: 0.66, metalness: 0.22, csmState: options.csmState });
  const mesh = new t.Mesh(geom, mat);
  mesh.name = "pallet-standard-deck";
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  root.add(mesh);

  // 4. Retractable Corner Leveling Jacks (single merged mesh, <= 2 pallet draw calls)
  // Built in deployed pose: outrigger arms & footpads at (±0.58, ±0.58), pad bottom resting at z = 0.000 m.
  // When stowed: scaled (0.92, 0.92, 0.72) + z = +0.032 -> fits inside |x|,|y| <= 0.534 (<= 0.550), z >= 0.032 (>= 0.020)!
  const jackAcc = new GeomAcc();
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      const jx = sx * 0.545;
      const jy = sy * 0.545;
      // Outrigger strut arm & screw housing
      jackAcc.box(sx * 0.510, sy * 0.510, 0.112, 0.040, 0.040, 0.024, P.steelArmor, cShade(P.steelArmor, 0.82));
      jackAcc.cylinder(jx, jy, 0.072, 0.024, 0.120, 8, P.safetyYellow, "z", true, true, P.hazardDark);
      // Hazard-striped stabilizer footpad resting flat at z = 0.000 m (z ∈ [0.000, 0.020])
      jackAcc.box(jx, jy, 0.010, 0.035, 0.035, 0.010, P.safetyYellow, P.hazardDark);
    }
  }
  const jackGeom = jackAcc.toBufferGeometry(t);
  const jackMat = makeDeployablePbrMaterial(t, { roughness: 0.45, metalness: 0.55, csmState: options.csmState });
  const levelingJacks = new t.Mesh(jackGeom, jackMat);
  levelingJacks.name = "pallet-leveling-jacks";
  levelingJacks.castShadow = true;
  levelingJacks.receiveShadow = true;
  root.add(levelingJacks);

  let isStowed = false;
  function setStowed(stowed) {
    isStowed = Boolean(stowed);
    if (isStowed) {
      levelingJacks.scale.set(0.92, 0.92, 0.72);
      levelingJacks.position.set(0, 0, 0.032);
    } else {
      levelingJacks.scale.set(1, 1, 1);
      levelingJacks.position.set(0, 0, 0);
    }
  }
  function setDeployed(deployed) {
    setStowed(!deployed);
  }
  setStowed(Boolean(options.stowed));

  return {
    root,
    mesh,
    levelingJacks,
    spec,
    size: normSize,
    get stowed() {
      return isStowed;
    },
    setStowed,
    setDeployed,
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
      jackGeom.dispose();
      jackMat.dispose();
    },
  };
}

// ---------------------------------------------------------------------------
// 1) Flux Pod (WCID 4000010, Standard Unified Pallet)
//    - Beveled concrete plinth + anchor bolts
//    - 4 chamfered columns with steel collars & hazard bands
//    - Containment glass + helical plasma coil & copper bus conduits
//    - 4-sided orange cornice with recessed directional strobe lenses (<= ±0.545 m)
//    - 4-tier dark-orange Incan stepped capstone
//    - 3 articulated corner emitter booms folding cleanly onto roof deck when stowed
//    - Draw calls: 10 (2 pallet + 8 unit) <= 10; 0 lights
// ---------------------------------------------------------------------------
export function buildFluxPod(three, options = {}) {
  const t = three || THREE_DEFAULT;
  const root = new t.Group();
  root.name = "flux-pod-root";
  const pallet = buildPallet(t, "standard", options);
  root.add(pallet.root);

  const P = makeLinearPalette(t, {
    concreteBase: 0x7b807a,
    concreteMid: 0x8a8f89,
    steelDark: 0x343a40,
    steelBolt: 0x9aa3ad,
    hazardYellow: 0xe6aa18,
    hazardBlack: 0x1e2226,
    orangeCornice: 0xff6a00,
    roofGray: 0x6b737a,
    roofPlate: 0x7d868e,
    incan1: 0x9e3408,
    incan2: 0xae3c0a,
    incan3: 0xbe450c,
    incan4: 0xcd5010,
    plasmaYellow: 0xffe433,
    plasmaCore: 0xffd000,
    copperBus: 0xc87a32,
    antMast: 0x96a0a8,
  });

  const stAcc = new GeomAcc();
  const deckZ = PALLET_SPECS.standard.height; // 0.145 m

  // A. Beveled concrete plinth + anchor bolts (max ±0.52 m)
  stAcc.bevelBox(0, 0, deckZ + 0.055, 0.52, 0.52, 0.055, 0.04, P.concreteBase, cShade(P.concreteBase, 0.80));
  stAcc.bevelBox(0, 0, deckZ + 0.145, 0.46, 0.46, 0.035, 0.03, P.concreteMid, cShade(P.concreteMid, 0.85));
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      stAcc.box(sx * 0.44, sy * 0.44, deckZ + 0.115, 0.045, 0.045, 0.012, P.steelDark);
      stAcc.cylinder(sx * 0.44, sy * 0.44, deckZ + 0.132, 0.014, 0.022, 6, P.steelBolt, "z");
    }
  }

  // B. 4 Chamfered corner columns with steel collars & hazard bands
  for (const cx of [-0.34, 0.34]) {
    for (const cy of [-0.34, 0.34]) {
      stAcc.bevelBox(cx, cy, 0.73, 0.075, 0.075, 0.40, 0.018, P.concreteMid, cShade(P.concreteMid, 0.82));
      stAcc.bevelBox(cx, cy, 0.36, 0.092, 0.092, 0.030, 0.018, P.steelDark);
      stAcc.bevelBox(cx, cy, 1.10, 0.092, 0.092, 0.030, 0.018, P.steelDark);
      stAcc.box(cx, cy, 0.43, 0.080, 0.080, 0.022, P.hazardYellow, P.hazardBlack);
      stAcc.box(cx, cy, 1.03, 0.080, 0.080, 0.022, P.hazardYellow, P.hazardBlack);
    }
  }
  // Armored glass mullions
  for (const side of [-0.34, 0.34]) {
    stAcc.box(0, side, 0.73, 0.28, 0.018, 0.020, P.steelDark);
    stAcc.box(side, 0, 0.73, 0.018, 0.28, 0.020, P.steelDark);
  }
  // 4 Vertical copper bus conduits inside frame
  for (const bx of [-0.21, 0.21]) {
    for (const by of [-0.21, 0.21]) {
      stAcc.cylinder(bx, by, 0.73, 0.016, 0.76, 8, P.copperBus, "z");
    }
  }

  // C. 4-sided bright-orange cornice (outer ±0.530 m, recessed light pockets)
  const ohZ = 1.20;
  const ohHz = 0.070;
  stAcc.box(0, 0.440, ohZ, 0.530, 0.090, ohHz, P.orangeCornice, cShade(P.orangeCornice, 0.82));
  stAcc.box(0, -0.440, ohZ, 0.530, 0.090, ohHz, P.orangeCornice, cShade(P.orangeCornice, 0.82));
  stAcc.box(0.440, 0, ohZ, 0.090, 0.350, ohHz, P.orangeCornice, cShade(P.orangeCornice, 0.82));
  stAcc.box(-0.440, 0, ohZ, 0.090, 0.350, ohHz, P.orangeCornice, cShade(P.orangeCornice, 0.82));
  // Central gray roof deck
  stAcc.bevelBox(0, 0, 1.21, 0.39, 0.39, 0.070, 0.025, P.roofGray, cShade(P.roofGray, 0.84));
  stAcc.bevelBox(0, 0, 1.30, 0.33, 0.33, 0.022, 0.020, P.roofPlate, cShade(P.roofPlate, 0.88));

  // Corner antenna pivot mounts on roof deck
  const antennaCorners = [
    { x: 0.43, y: 0.43, dirX: 1, dirY: 1, stowRot: [0, -Math.PI / 2, 0] },
    { x: -0.43, y: 0.43, dirX: -1, dirY: 1, stowRot: [Math.PI / 2, 0, 0] },
    { x: 0.43, y: -0.43, dirX: 1, dirY: -1, stowRot: [-Math.PI / 2, 0, 0] },
  ];
  for (const c of antennaCorners) {
    stAcc.bevelBox(c.x, c.y, 1.285, 0.050, 0.050, 0.050, 0.012, P.steelDark);
  }

  // D. 4-tier dark-orange Incan stepped capstone (z = 1.32..1.72)
  const incanTiers = [
    { hxy: 0.24, hz: 0.042, z: 1.36, col: P.incan1 },
    { hxy: 0.18, hz: 0.042, z: 1.44, col: P.incan2 },
    { hxy: 0.125, hz: 0.042, z: 1.52, col: P.incan3 },
    { hxy: 0.075, hz: 0.040, z: 1.60, col: P.incan4 },
  ];
  for (const tr of incanTiers) {
    stAcc.box(0, 0, tr.z, tr.hxy, tr.hxy, tr.hz, tr.col, cShade(tr.col, 0.84));
  }
  stAcc.cone(0, 0, 1.68, 0.058, 0.006, 0.08, 4, P.incan4, "z");

  const matStructure = makeDeployablePbrMaterial(t, { roughness: 0.65, metalness: 0.18, csmState: options.csmState });
  const structureMesh = new t.Mesh(stAcc.toBufferGeometry(t), matStructure);
  structureMesh.name = "flux-pod-structure";
  structureMesh.castShadow = true;
  structureMesh.receiveShadow = true;

  // Helical plasma coil + inner core (additive, 0 lights)
  const coreAcc = new GeomAcc();
  coreAcc.cylinder(0, 0, 0.73, 0.10, 0.70, 12, P.plasmaCore, "z");
  const coilSegs = 28;
  const turns = 3.0;
  for (let i = 0; i < coilSegs; i++) {
    const f0 = i / coilSegs;
    const f1 = (i + 1) / coilSegs;
    const a0 = f0 * turns * Math.PI * 2;
    const a1 = f1 * turns * Math.PI * 2;
    const z0 = 0.42 + f0 * 0.62;
    const z1 = 0.42 + f1 * 0.62;
    coreAcc.tube(
      [Math.cos(a0) * 0.16, Math.sin(a0) * 0.16, z0],
      [Math.cos(a1) * 0.16, Math.sin(a1) * 0.16, z1],
      0.018, 0.018, 6, P.plasmaYellow, P.plasmaYellow, i === 0, i === coilSegs - 1,
    );
  }
  const matCore = new t.MeshBasicMaterial({
    color: 0xffffff,
    vertexColors: true,
    transparent: true,
    opacity: 0.80,
    blending: t.AdditiveBlending,
    depthWrite: false,
  });
  const core = new t.Mesh(coreAcc.toBufferGeometry(t), matCore);
  core.name = "flux-pod-plasma-core";

  // Armored containment glass (strictly inside columns/collars ±0.248 m and enclosing copper conduits z ∈ [0.35, 1.11])
  const matGlass = new t.MeshBasicMaterial({
    color: 0x9ce2ff,
    transparent: true,
    opacity: 0.32,
    depthWrite: false,
  });
  const glassBox = new t.Mesh(new t.BoxGeometry(0.488, 0.488, 0.790), matGlass);
  glassBox.name = "flux-pod-glass";
  glassBox.position.set(0, 0, 0.73);

  // Recessed directional strobe lenses cleanly mounted outside cornice face (±0.530..±0.546 m <= ±0.550 m)
  const nsAcc = new GeomAcc();
  nsAcc.box(0, +0.539, ohZ, 0.15, 0.007, 0.028, P.plasmaYellow, P.plasmaYellow);
  nsAcc.box(0, -0.539, ohZ, 0.15, 0.007, 0.028, P.plasmaYellow, P.plasmaYellow);
  const ewAcc = new GeomAcc();
  ewAcc.box(+0.539, 0, ohZ, 0.007, 0.15, 0.028, P.plasmaYellow, P.plasmaYellow);
  ewAcc.box(-0.539, 0, ohZ, 0.007, 0.15, 0.028, P.plasmaYellow, P.plasmaYellow);

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
  const lightsNS = new t.Mesh(nsAcc.toBufferGeometry(t), matFlashNS);
  lightsNS.name = "flux-overhang-lights-ns";
  const lightsEW = new t.Mesh(ewAcc.toBufferGeometry(t), matFlashEW);
  lightsEW.name = "flux-overhang-lights-ew";

  // 3 articulated corner emitter booms (fold onto roof perimeter when stowed — zero column clipping!)
  const antAcc = new GeomAcc();
  antAcc.cylinder(0, 0, 0.25, 0.016, 0.50, 8, P.antMast, "z");
  antAcc.cylinder(0, 0, 0.34, 0.026, 0.05, 8, P.copperBus, "z");
  antAcc.box(0, 0, 0.38, 0.085, 0.010, 0.010, P.copperBus);
  antAcc.cone(0, 0, 0.52, 0.028, 0.008, 0.06, 6, P.orangeCornice, "z");
  const singleAntennaGeom = antAcc.toBufferGeometry(t);

  const antennaPivots = [];
  for (let ai = 0; ai < antennaCorners.length; ai++) {
    const c = antennaCorners[ai];
    const piv = new t.Group();
    piv.name = `flux-antenna-pivot-${ai}`;
    piv.position.set(c.x, c.y, 1.360);
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
    pallet.setStowed(isStowed);
    for (const { piv, c } of antennaPivots) {
      if (isStowed) {
        piv.rotation.set(c.stowRot[0], c.stowRot[1], c.stowRot[2]);
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
    get stowed() {
      return isStowed;
    },
    setStowed,
    setDeployed(deployed) {
      setStowed(!deployed);
    },
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
      disposeRootResources(root, [pallet.mesh, pallet.levelingJacks]);
    },
  };
}

// ---------------------------------------------------------------------------
// 2) Solar Panels (WCID 4000011, Standard Unified Pallet)
//    - Galvanized steel base frame + ribbed MPPT inverter + heat-sink fins + conduit loop + LED
//    - 4-leaf articulated folding solar wings:
//      Stowed: outer leaves fold 180° onto inner leaves and fold vertically inside <= 1.04×1.04×1.66 m
//      Deployed: unfolds into 2.45 × 0.96 m PV array with full azimuth/elevation sun tracking
//    - Draw calls: 9 (2 pallet + 7 unit) <= 10; 0 lights
// ---------------------------------------------------------------------------
export function buildSolarPanels(three, options = {}) {
  const t = three || THREE_DEFAULT;
  const root = new t.Group();
  root.name = "solar-panels-root";
  const pallet = buildPallet(t, "standard", options);
  root.add(pallet.root);

  const P = makeLinearPalette(t, {
    galvSteel: 0x6c757d,
    darkSteel: 0x3b4248,
    inverterBody: 0x343b42,
    heatFin: 0x525b64,
    conduit: 0x8b959e,
    frameSilver: 0xbac4ce,
    pvBlue: 0x1a4d99,
    busSilver: 0x9ec0e6,
    gridBlue: 0x7aa0ca,
    chromeRod: 0xd0d8e0,
  });

  const deckZ = PALLET_SPECS.standard.height; // 0.145 m
  const pedAcc = new GeomAcc();
  // Galvanized base frame (0.94 × 0.94 m)
  pedAcc.bevelBox(0, 0, deckZ + 0.032, 0.47, 0.47, 0.032, 0.03, P.galvSteel, cShade(P.galvSteel, 0.82));
  // Central pedestal mast (z = 0.21..1.02, rBot = 0.145, rTop = 0.100; clears deployed wings up to pi/2)
  pedAcc.cone(0, 0, 0.615, 0.145, 0.100, 0.81, 12, P.galvSteel, "z");
  pedAcc.cylinder(0, 0, 0.23, 0.18, 0.05, 12, P.darkSteel, "z");
  // Ribbed MPPT inverter cabinet at y = -0.25
  pedAcc.bevelBox(0, -0.25, 0.40, 0.20, 0.13, 0.18, 0.018, P.inverterBody, cShade(P.inverterBody, 0.82));
  for (let fx = -0.15; fx <= 0.151; fx += 0.05) {
    pedAcc.box(fx, -0.25, 0.40, 0.012, 0.142, 0.15, P.heatFin);
  }
  // Conduit loop from inverter into column (kept <= z = 0.606 so deployed wings at pi/2 [z >= 0.62] stay clear)
  pedAcc.tube([0.12, -0.18, 0.56], [0.06, -0.06, 0.59], 0.016, 0.016, 8, P.conduit);

  const matPedestal = makeDeployablePbrMaterial(t, { roughness: 0.46, metalness: 0.55, csmState: options.csmState });
  const pedestal = new t.Mesh(pedAcc.toBufferGeometry(t), matPedestal);
  pedestal.name = "solar-pedestal";
  pedestal.castShadow = true;
  pedestal.receiveShadow = true;

  const matStatusLed = new t.MeshStandardMaterial({
    color: 0x2fd866,
    emissive: 0x1db84e,
    emissiveIntensity: 0.85,
    roughness: 0.25,
    metalness: 0.2,
  });
  if (options.csmState) installCsmShaderPatch(matStatusLed, options.csmState);
  const statusLedMesh = new t.Mesh(new t.BoxGeometry(0.14, 0.024, 0.06), matStatusLed);
  statusLedMesh.name = "solar-status-led";
  statusLedMesh.position.set(0, -0.388, 0.43);
  statusLedMesh.castShadow = true;
  statusLedMesh.receiveShadow = true;

  const turntable = new t.Group();
  turntable.name = "azimuth-turntable";
  turntable.position.set(0, 0, 1.02);

  const trunnion = new t.Group();
  turntable.add(trunnion);
  trunnion.name = "elevation-trunnion";
  trunnion.position.set(0, 0, 0.08);

  // Trunnion yoke crossbar & actuator cylinder (z ∈ [-0.079, -0.029] clears wing rear rib z = -0.026; rod at z=1.00m meets taller mast)
  const actAcc = new GeomAcc();
  actAcc.box(0, 0, -0.054, 0.145, 0.12, 0.025, P.darkSteel);
  actAcc.cylinder(0, -0.12, -0.10, 0.026, 0.22, 8, P.chromeRod, "y");
  const matActuators = makeDeployablePbrMaterial(t, { roughness: 0.42, metalness: 0.60, csmState: options.csmState });
  const actuators = new t.Mesh(actAcc.toBufferGeometry(t), matActuators);
  actuators.castShadow = true;
  actuators.receiveShadow = true;
  trunnion.add(actuators);

  // Build 4-leaf folding PV panel (each leaf 0.55 m wide × 0.96 m tall; 4*0.55 + 0.25 = 2.45 × 0.96 m deployed)
  function makeLeafGeom(xStart, xEnd) {
    const cx = (xStart + xEnd) * 0.5;
    const w = Math.abs(xEnd - xStart);
    const hx = w * 0.5;
    const acc = new GeomAcc();
    // Anodized silver outer frame
    acc.box(cx, 0, 0, hx, 0.48, 0.014, P.frameSilver, cShade(P.frameSilver, 0.85));
    // Dark-blue monocrystalline PV surface
    acc.box(cx, 0, 0.002, hx - 0.020, 0.46, 0.015, P.pvBlue, cShade(P.pvBlue, 0.88));
    // Busbars & cell grid
    for (const frac of [-0.30, 0, 0.30]) {
      acc.box(cx + frac * w, 0, 0.004, 0.005, 0.45, 0.016, P.busSilver);
    }
    for (let gy = -0.36; gy <= 0.37; gy += 0.18) {
      acc.box(cx, gy, 0.004, hx - 0.025, 0.004, 0.016, P.gridBlue);
    }
    // Rear structural rib & hinge knuckles
    acc.box(cx, 0, -0.016, hx - 0.03, 0.035, 0.010, P.darkSteel);
    return acc.toBufferGeometry(t);
  }

  const matWing = makeDeployablePbrMaterial(t, { roughness: 0.20, metalness: 0.42, csmState: options.csmState });

  const leftInnerPivot = new t.Group();
  leftInnerPivot.name = "solar-left-inner-pivot";
  leftInnerPivot.position.set(-0.125, 0, 0);
  const leftWing = new t.Mesh(makeLeafGeom(-0.55, 0.0), matWing);
  leftWing.name = "solar-left-inner-wing";
  leftWing.castShadow = true;
  leftWing.receiveShadow = true;
  leftInnerPivot.add(leftWing);

  const leftOuterPivot = new t.Group();
  leftOuterPivot.name = "solar-left-outer-pivot";
  leftOuterPivot.position.set(-0.55, 0, 0.044);
  const leftOuterWing = new t.Mesh(makeLeafGeom(-0.55, 0.0), matWing);
  leftOuterWing.name = "solar-left-outer-wing";
  leftOuterWing.castShadow = true;
  leftOuterWing.receiveShadow = true;
  leftOuterPivot.add(leftOuterWing);
  leftInnerPivot.add(leftOuterPivot);

  const rightInnerPivot = new t.Group();
  rightInnerPivot.name = "solar-right-inner-pivot";
  rightInnerPivot.position.set(0.125, 0, 0);
  const rightWing = new t.Mesh(makeLeafGeom(0.0, 0.55), matWing);
  rightWing.name = "solar-right-inner-wing";
  rightWing.castShadow = true;
  rightWing.receiveShadow = true;
  rightInnerPivot.add(rightWing);

  const rightOuterPivot = new t.Group();
  rightOuterPivot.name = "solar-right-outer-pivot";
  rightOuterPivot.position.set(0.55, 0, 0.044);
  const rightOuterWing = new t.Mesh(makeLeafGeom(0.0, 0.55), matWing);
  rightOuterWing.name = "solar-right-outer-wing";
  rightOuterWing.castShadow = true;
  rightOuterWing.receiveShadow = true;
  rightOuterPivot.add(rightOuterWing);
  rightInnerPivot.add(rightOuterPivot);

  trunnion.add(leftInnerPivot, rightInnerPivot);
  root.add(pedestal, statusLedMesh, turntable);

  let isStowed = false;
  function setStowed(stowed) {
    isStowed = Boolean(stowed);
    pallet.setStowed(isStowed);
    if (isStowed) {
      turntable.rotation.z = 0;
      trunnion.rotation.x = 0;
      // Fold outer panels 180° onto inner panels and pitch inner wings vertically upward inside 1.04 × 1.04 × 1.66 m
      leftInnerPivot.rotation.y = 1.46;
      leftOuterPivot.rotation.y = Math.PI;
      rightInnerPivot.rotation.y = -1.46;
      rightOuterPivot.rotation.y = -Math.PI;
      matStatusLed.color.setHex(0xffaa22);
      matStatusLed.emissive.setHex(0xdd8800);
      matStatusLed.emissiveIntensity = 0.25;
    } else {
      leftInnerPivot.rotation.y = 0;
      leftOuterPivot.rotation.y = 0;
      rightInnerPivot.rotation.y = 0;
      rightOuterPivot.rotation.y = 0;
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
    leftInnerPivot,
    leftOuterPivot,
    rightInnerPivot,
    rightOuterPivot,
    pallet,
    wcid: DEPLOYABLE_WCID.SolarPanels,
    palletSize: "full",
    get stowed() {
      return isStowed;
    },
    setStowed,
    setDeployed(deployed) {
      setStowed(!deployed);
    },
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
      disposeRootResources(root, [pallet.mesh, pallet.levelingJacks]);
    },
  };
}

// ---------------------------------------------------------------------------
// 3) Power Generator (WCID 4000012, Standard Unified Pallet) — Burns Platinum Scarabs
//    - Acoustic frame, louvered radiator grille, exposed horizontal turbine with braided copper coils & fins
//    - Armored Platinum Scarab hopper with hinged brass lid & recessed cyan combustion sight-glass (no clipping glow box)
//    - Spoked flywheel inside protective shroud ring
//    - Telescoping vertical exhaust stack + hinged intake louver canopy (H_stowed ~ 1.38 m, H_deployed ~ 1.92 m)
//    - Draw calls: 7 (2 pallet + 5 unit) <= 10; 0 lights
// ---------------------------------------------------------------------------
export function buildPowerGenerator(three, options = {}) {
  const t = three || THREE_DEFAULT;
  const root = new t.Group();
  root.name = "power-generator-root";
  const pallet = buildPallet(t, "standard", options);
  root.add(pallet.root);

  const P = makeLinearPalette(t, {
    oliveDark: 0x384035,
    oliveMid: 0x4f584a,
    turbineSteel: 0x687066,
    coolingFin: 0x525a52,
    copperCoil: 0xc47835,
    hopperBody: 0x867a6c,
    brassLid: 0xb87632,
    exhaustDark: 0x2a2f2b,
    louverSlate: 0x303632,
    flywheelRim: 0x262a26,
    flywheelBrass: 0xd49b2a,
    cyanSight: 0x5ee8ff,
  });

  const deckZ = PALLET_SPECS.standard.height; // 0.145 m
  const bodyAcc = new GeomAcc();

  // Heavy acoustic skid frame (1.02 × 0.96 × 0.42 m -> ±0.51 × ±0.48)
  bodyAcc.bevelBox(0, 0, deckZ + 0.21, 0.51, 0.48, 0.21, 0.03, P.oliveDark, cShade(P.oliveDark, 0.80));
  // Louvered radiator grille on -Y face
  for (let lz = deckZ + 0.08; lz <= deckZ + 0.34; lz += 0.055) {
    bodyAcc.box(0, -0.484, lz, 0.36, 0.010, 0.014, P.louverSlate);
  }
  // Upper turbine housing block
  bodyAcc.bevelBox(-0.08, -0.04, 0.78, 0.38, 0.36, 0.20, 0.025, P.oliveMid, cShade(P.oliveMid, 0.84));
  // Exposed horizontal turbine casing along +Y with ribbed cooling fins & twin braided copper induction coils
  bodyAcc.cylinder(-0.12, 0.0, 0.84, 0.21, 0.74, 14, P.turbineSteel, "y");
  for (let fy = -0.32; fy <= 0.33; fy += 0.08) {
    bodyAcc.cylinder(-0.12, fy, 0.84, 0.23, 0.022, 14, P.coolingFin, "y");
  }
  for (const cy of [-0.18, 0.18]) {
    bodyAcc.cylinder(-0.12, cy, 0.84, 0.255, 0.075, 14, P.copperCoil, "y");
  }
  // Protective semicircular shroud around front flywheel
  for (let i = 0; i < 8; i++) {
    const a0 = -0.3 + (i / 8) * (Math.PI + 0.6);
    const a1 = -0.3 + ((i + 1) / 8) * (Math.PI + 0.6);
    const r = 0.245;
    bodyAcc.tube(
      [-0.12 + Math.cos(a0) * r, 0.425, 0.84 + Math.sin(a0) * r],
      [-0.12 + Math.cos(a1) * r, 0.425, 0.84 + Math.sin(a1) * r],
      0.018, 0.018, 6, P.exhaustDark,
    );
  }
  // Armored Platinum Scarab hopper + hinged brass lid (recessed bezel on +X face)
  bodyAcc.bevelBox(0.33, 0.14, 0.78, 0.15, 0.20, 0.22, 0.02, P.hopperBody, cShade(P.hopperBody, 0.82));
  bodyAcc.bevelBox(0.33, 0.14, 1.03, 0.17, 0.22, 0.03, 0.015, P.brassLid);
  // Sight-glass bezel frame on +X face of hopper
  bodyAcc.box(0.482, 0.14, 0.80, 0.008, 0.10, 0.12, P.exhaustDark);
  // Fixed lower exhaust sleeve
  bodyAcc.cylinder(-0.36, -0.30, 1.04, 0.075, 0.24, 10, P.exhaustDark, "z");

  const matBody = makeDeployablePbrMaterial(t, { roughness: 0.56, metalness: 0.38, csmState: options.csmState });
  const bodyMesh = new t.Mesh(bodyAcc.toBufferGeometry(t), matBody);
  bodyMesh.name = "generator-chassis-turbine";
  bodyMesh.castShadow = true;
  bodyMesh.receiveShadow = true;

  // Machined spoked flywheel
  const fwAcc = new GeomAcc();
  fwAcc.cylinder(0, 0, 0, 0.21, 0.05, 16, P.flywheelRim, "z");
  fwAcc.box(0, 0, 0, 0.19, 0.024, 0.028, P.flywheelBrass);
  fwAcc.box(0, 0, 0, 0.024, 0.19, 0.028, P.flywheelBrass);
  fwAcc.cylinder(0, 0, 0, 0.065, 0.068, 12, P.flywheelBrass, "z");
  const matFlywheel = makeDeployablePbrMaterial(t, { roughness: 0.34, metalness: 0.65, csmState: options.csmState });
  const flywheelPivot = new t.Group();
  flywheelPivot.position.set(-0.12, 0.425, 0.84);
  flywheelPivot.rotation.x = Math.PI / 2;
  const flywheel = new t.Mesh(fwAcc.toBufferGeometry(t), matFlywheel);
  flywheel.castShadow = true;
  flywheel.receiveShadow = true;
  flywheelPivot.add(flywheel);

  // Recessed cyan combustion sight-glass + turbine cooling slot glow (no clipping box!)
  const glowAcc = new GeomAcc();
  glowAcc.box(0.495, 0.14, 0.80, 0.004, 0.075, 0.095, P.cyanSight, P.cyanSight);
  glowAcc.box(-0.12, 0.0, 1.080, 0.08, 0.13, 0.005, P.cyanSight, P.cyanSight);
  const matArcaneGlow = new t.MeshBasicMaterial({
    color: 0x66eeff,
    transparent: true,
    opacity: 0.82,
    blending: t.AdditiveBlending,
    depthWrite: false,
  });
  const glowCore = new t.Mesh(glowAcc.toBufferGeometry(t), matArcaneGlow);
  glowCore.name = "generator-scarab-glow";

  // Telescoping vertical exhaust stack (stowed z=1.11 -> top 1.38 m; deployed z=1.65 -> top 1.92 m)
  const stackAcc = new GeomAcc();
  stackAcc.cylinder(0, 0, 0, 0.052, 0.54, 10, P.turbineSteel, "z");
  stackAcc.cylinder(0, 0, 0.25, 0.068, 0.04, 10, P.exhaustDark, "z");
  const exhaustStackMesh = new t.Mesh(stackAcc.toBufferGeometry(t), matBody);
  exhaustStackMesh.name = "generator-exhaust-stack";
  exhaustStackMesh.position.set(-0.36, -0.30, 1.65);
  exhaustStackMesh.castShadow = true;
  exhaustStackMesh.receiveShadow = true;

  // Hinged intake louver canopy on top of engine cowling (clears coils z <= 1.095 & exhaust sleeve/stack y <= -0.225)
  const canopyPivot = new t.Group();
  canopyPivot.name = "generator-intake-canopy";
  canopyPivot.position.set(-0.38, 0.06, 1.115);
  const canAcc = new GeomAcc();
  canAcc.bevelBox(0.24, 0, 0.025, 0.24, 0.24, 0.025, 0.012, P.oliveMid, P.louverSlate);
  const canopyMesh = new t.Mesh(canAcc.toBufferGeometry(t), matBody);
  canopyMesh.castShadow = true;
  canopyMesh.receiveShadow = true;
  canopyPivot.add(canopyMesh);

  root.add(bodyMesh, exhaustStackMesh, canopyPivot, flywheelPivot, glowCore);

  let flywheelAngle = 0;
  let isStowed = false;
  function setStowed(stowed) {
    isStowed = Boolean(stowed);
    pallet.setStowed(isStowed);
    if (isStowed) {
      exhaustStackMesh.position.z = 1.11; // top = 1.11 + 0.27 = 1.38 m
      canopyPivot.rotation.y = 0;
      flywheelAngle = 0;
      flywheel.rotation.z = 0;
      matArcaneGlow.color.setHex(0xffaa22);
      matArcaneGlow.opacity = 0.18;
    } else {
      exhaustStackMesh.position.z = 1.65; // top = 1.65 + 0.27 = 1.92 m
      canopyPivot.rotation.y = -0.58;
      matArcaneGlow.color.setHex(0x66eeff);
      matArcaneGlow.opacity = 0.82;
    }
  }
  setStowed(Boolean(options.stowed));

  return {
    root,
    flywheel,
    glowCore,
    exhaustStackMesh,
    canopyPivot,
    pallet,
    wcid: DEPLOYABLE_WCID.PowerGenerator,
    palletSize: "full",
    get flywheelAngle() {
      return flywheelAngle;
    },
    get stowed() {
      return isStowed;
    },
    setStowed,
    setDeployed(deployed) {
      setStowed(!deployed);
    },
    update(state = {}) {
      const s = state && typeof state === "object" ? state : {};
      if (s.stowed !== undefined) {
        setStowed(s.stowed);
      }
      if (isStowed) return;
      const dt = Number.isFinite(s.dt) && s.dt >= 0 ? s.dt : 0.0333;
      const onlineVal = s.online !== undefined ? s.online : s.running;
      const hasFuelKey = s.fuelSecondsRemaining !== undefined || s.fuelRemaining !== undefined || s.fuelPct !== undefined;
      const fuel = s.fuelSecondsRemaining !== undefined
        ? s.fuelSecondsRemaining
        : (s.fuelRemaining !== undefined ? s.fuelRemaining : s.fuelPct);
      const onlineOk = onlineVal === undefined ? true : Boolean(onlineVal);
      const fuelOk = hasFuelKey ? (Number.isFinite(fuel) && fuel > 0) : Boolean(onlineVal);
      const isRunning = onlineOk && fuelOk;
      if (isRunning) {
        flywheelAngle = (flywheelAngle + 25.0 * dt) % (2 * Math.PI);
        flywheel.rotation.z = flywheelAngle;
        matArcaneGlow.opacity = 0.82;
      } else {
        matArcaneGlow.opacity = 0.18;
      }
    },
    dispose() {
      pallet.dispose();
      disposeRootResources(root, [pallet.mesh, pallet.levelingJacks]);
    },
  };
}

// ---------------------------------------------------------------------------
// 4) Battery Unit (WCID 4000013, Standard Unified Pallet) — 600 kJ Capacitor Bank
//    - Full-skid tubular steel roll-cage
//    - 2×4 (8-cell) cylindrical blue capacitor bank + ceramic HV standoffs + gold-copper busbars
//    - Side cooling radiator fins + front armored diagnostic console with 5 SoC bars
//    - Hinged top armored thermal-louver weather hood: closes flat when stowed (H ~ 1.24 m), opens 70° deployed
//    - Draw calls: 9 (2 pallet + 7 unit) <= 10; 0 lights
// ---------------------------------------------------------------------------
export function buildBatteryUnit(three, options = {}) {
  const t = three || THREE_DEFAULT;
  const root = new t.Group();
  root.name = "battery-unit-root";
  const pallet = buildPallet(t, "standard", options);
  root.add(pallet.root);

  const P = makeLinearPalette(t, {
    skidDark: 0x2c3330,
    cageSteel: 0x3b4440,
    capBlue: 0x1b5496,
    ceramicWhite: 0xdce2e8,
    busGold: 0xd4a437,
    finSlate: 0x4b535a,
    consoleBlack: 0x161a18,
    hoodOlive: 0x424c44,
  });

  const deckZ = PALLET_SPECS.standard.height; // 0.145 m
  const bankAcc = new GeomAcc();

  // Base skid plinth (0.98 × 0.98 m, z = 0.145..0.285)
  bankAcc.bevelBox(0, 0, deckZ + 0.070, 0.49, 0.49, 0.070, 0.03, P.skidDark, cShade(P.skidDark, 0.80));
  // Tubular steel roll-cage (4 corner posts + top perimeter frame, z = 0.285..1.16)
  for (const sx of [-0.46, 0.46]) {
    for (const sy of [-0.46, 0.46]) {
      bankAcc.tube([sx, sy, 0.28], [sx, sy, 1.15], 0.025, 0.025, 8, P.cageSteel);
    }
  }
  bankAcc.tube([-0.46, -0.46, 1.15], [0.46, -0.46, 1.15], 0.024, 0.024, 8, P.cageSteel);
  bankAcc.tube([-0.46, 0.46, 1.15], [0.46, 0.46, 1.15], 0.024, 0.024, 8, P.cageSteel);
  bankAcc.tube([-0.46, -0.46, 1.15], [-0.46, 0.46, 1.15], 0.024, 0.024, 8, P.cageSteel);
  bankAcc.tube([0.46, -0.46, 1.15], [0.46, 0.46, 1.15], 0.024, 0.024, 8, P.cageSteel);

  // 2×4 (8-cell) cylindrical blue capacitor bank + ceramic HV standoffs + gold-copper busbars
  for (const cx of [-0.17, 0.17]) {
    bankAcc.box(cx, 0, 1.07, 0.035, 0.40, 0.020, P.busGold, cShade(P.busGold, 0.85));
    for (const cy of [-0.30, -0.10, 0.10, 0.30]) {
      bankAcc.cylinder(cx, cy, 0.62, 0.082, 0.68, 12, P.capBlue, "z", true, true, cShade(P.capBlue, 0.82));
      bankAcc.cylinder(cx, cy, 1.00, 0.042, 0.08, 10, P.ceramicWhite, "z");
      bankAcc.cylinder(cx, cy, 1.05, 0.024, 0.04, 8, P.busGold, "z");
    }
  }
  // Cross busbar tie
  bankAcc.box(0, 0, 1.08, 0.17, 0.032, 0.016, P.busGold);

  // Side cooling radiator fins along x = ±0.44
  for (const sx of [-0.44, 0.44]) {
    for (let fz = 0.38; fz <= 0.94; fz += 0.08) {
      bankAcc.box(sx, 0, fz, 0.025, 0.34, 0.014, P.finSlate);
    }
  }

  // Front armored diagnostic console bezel on +X/-Y side (at y = -0.45, facing -Y)
  bankAcc.bevelBox(0, -0.43, 0.72, 0.22, 0.05, 0.34, 0.015, P.consoleBlack);

  const matBank = makeDeployablePbrMaterial(t, { roughness: 0.48, metalness: 0.48, csmState: options.csmState });
  const bankMesh = new t.Mesh(bankAcc.toBufferGeometry(t), matBank);
  bankMesh.name = "battery-capacitor-bank";
  bankMesh.castShadow = true;
  bankMesh.receiveShadow = true;
  root.add(bankMesh);

  // Hinged top armored thermal-louver weather hood (hinges open 70° around rear +Y edge, clearing z = 1.174 m roll-cage)
  const hoodPivot = new t.Group();
  hoodPivot.name = "battery-weather-hood";
  hoodPivot.position.set(0, 0.46, 1.185);
  const hoodAcc = new GeomAcc();
  hoodAcc.bevelBox(0, -0.46, 0.030, 0.48, 0.46, 0.030, 0.02, P.hoodOlive, cShade(P.hoodOlive, 0.84));
  for (let ly = -0.78; ly <= -0.14; ly += 0.12) {
    hoodAcc.box(0, ly, 0.062, 0.34, 0.026, 0.012, P.finSlate);
  }
  const hoodMesh = new t.Mesh(hoodAcc.toBufferGeometry(t), matBank);
  hoodMesh.castShadow = true;
  hoodMesh.receiveShadow = true;
  hoodPivot.add(hoodMesh);
  root.add(hoodPivot);

  // 5 SoC LED bar segments (preserving unit.socBars[i].material.color.getHex() contract, sitting cleanly proud of consoleBlack)
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
  const barGeom = new t.BoxGeometry(0.26, 0.024, 0.075);
  for (let i = 0; i < 5; i++) {
    const barMesh = new t.Mesh(barGeom, matOff);
    barMesh.position.set(0, -0.496, 0.46 + i * 0.12);
    barMesh.castShadow = true;
    barMesh.receiveShadow = true;
    socBars.push(barMesh);
    root.add(barMesh);
  }

  let isStowed = false;
  let lastJoules = 0;
  let lastMaxJoules = GRID_SPECS.batteryMaxJoules;

  function applySocBars(safeJ, maxJ = lastMaxJoules) {
    const denom = Number.isFinite(maxJ) && maxJ > 0 ? maxJ : GRID_SPECS.batteryMaxJoules;
    const norm = Math.max(0, Math.min(1, safeJ / denom));
    const activeBars = Math.max(0, Math.min(5, Math.floor(norm * 5 + 1e-9)));
    for (let i = 0; i < 5; i++) {
      socBars[i].material = i < activeBars ? matOn : matOff;
    }
  }

  function setStowed(stowed) {
    isStowed = Boolean(stowed);
    pallet.setStowed(isStowed);
    if (isStowed) {
      hoodPivot.rotation.x = 0;
      socBars[0].material = matStandby;
      for (let i = 1; i < 5; i++) socBars[i].material = matOff;
    } else {
      hoodPivot.rotation.x = -1.22; // Opens ~70° upward around rear hinge
      applySocBars(lastJoules, lastMaxJoules);
    }
  }
  setStowed(Boolean(options.stowed));

  return {
    root,
    socBars,
    hoodPivot,
    pallet,
    wcid: DEPLOYABLE_WCID.BatteryUnit,
    palletSize: "full",
    get stowed() {
      return isStowed;
    },
    setStowed,
    setDeployed(deployed) {
      setStowed(!deployed);
    },
    update(state = {}) {
      const s = state && typeof state === "object" ? state : {};
      if (s.stowed !== undefined) {
        setStowed(s.stowed);
      }
      if (isStowed) return;
      const maxCand = s.maxCapacitorJoules !== undefined ? s.maxCapacitorJoules : s.capacityJoules;
      lastMaxJoules = Number.isFinite(maxCand) && maxCand > 0 ? maxCand : GRID_SPECS.batteryMaxJoules;
      const joules = s.capacitorJoules !== undefined ? s.capacitorJoules : s.energyJoules;
      if (joules !== undefined) {
        lastJoules = Number.isFinite(joules) ? joules : 0;
      } else if (Number.isFinite(s.chargePct)) {
        lastJoules = Math.max(0, Math.min(1, s.chargePct)) * lastMaxJoules;
      } else {
        lastJoules = 0;
      }
      applySocBars(lastJoules, lastMaxJoules);
    },
    dispose() {
      pallet.dispose();
      disposeRootResources(root, [pallet.mesh, pallet.levelingJacks], [matOff, matOn, matStandby]);
    },
  };
}

// ---------------------------------------------------------------------------
// 5) Autonomous Missile Turret (WCID 4000014, Standard Unified Pallet)
//    - Armored full-skid turret well + hydraulic riser column + 4 chrome guide rods
//    - Beveled blast shields + 2×2 quad-cell SAM canister pod (0.84 × 0.96 m)
//    - Roof EO/IR target director with amber optical dome
//    - 4 white/red-nose SAM missiles tucked completely inside |y| <= 0.52 m when stowed
//    - Draw calls: 10 (2 pallet + 8 unit) <= 10; 0 lights
// ---------------------------------------------------------------------------
export function buildMissileTurret(three, options = {}) {
  const t = three || THREE_DEFAULT;
  const root = new t.Group();
  root.name = "missile-turret-root";
  const pallet = buildPallet(t, "standard", options);
  root.add(pallet.root);

  const P = makeLinearPalette(t, {
    armorOlive: 0x3e4637,
    armorDark: 0x2d3428,
    armorLight: 0x54604a,
    sleeveOlive: 0x4b5344,
    ramSteel: 0x7b8288,
    chrome: 0xd8e0e8,
    eoHousing: 0x242923,
    amberOptic: 0xffaa22,
    missileWhite: 0xebeff2,
    noseRed: 0xd42c20,
    finDark: 0x383e42,
    louverDark: 0x1e221e,
  });

  const deckZ = PALLET_SPECS.standard.height; // 0.145 m
  const baseAcc = new GeomAcc();
  // Armored turret well + beveled blast shields (<= ±0.52 m)
  baseAcc.bevelBox(0, 0, deckZ + 0.08, 0.51, 0.51, 0.08, 0.03, P.armorOlive, cShade(P.armorOlive, 0.80));
  baseAcc.bevelBox(0, 0, deckZ + 0.19, 0.42, 0.42, 0.11, 0.025, P.armorDark, cShade(P.armorDark, 0.82));
  // Beveled perimeter blast shields
  baseAcc.box(0, 0.46, 0.33, 0.42, 0.035, 0.11, P.armorLight);
  baseAcc.box(0, -0.46, 0.33, 0.42, 0.035, 0.11, P.armorLight);
  baseAcc.box(0.46, 0, 0.33, 0.035, 0.42, 0.11, P.armorLight);
  baseAcc.box(-0.46, 0, 0.33, 0.035, 0.42, 0.11, P.armorLight);
  for (const px of [-0.34, 0.34]) {
    for (const py of [-0.32, 0.32]) {
      baseAcc.cylinder(px, py, 0.33, 0.075, 0.28, 10, P.sleeveOlive, "z");
    }
  }
  const matOutriggers = makeDeployablePbrMaterial(t, { roughness: 0.60, metalness: 0.34, csmState: options.csmState });
  const outriggers = new t.Mesh(baseAcc.toBufferGeometry(t), matOutriggers);
  outriggers.name = "sam-base-well";
  outriggers.castShadow = true;
  outriggers.receiveShadow = true;

  // Hydraulic riser group (turntable rises from 0.20 to 0.85; anchored piston scales from base well z=0.15 so there is zero air gap)
  const riserGroup = new t.Group();
  riserGroup.name = "pneumatic-riser";
  riserGroup.position.set(0, 0, 0.20);

  const pistAcc = new GeomAcc();
  pistAcc.cylinder(0, 0, 0.23, 0.13, 0.46, 12, P.ramSteel, "z");
  pistAcc.bevelBox(0, 0, 0.45, 0.38, 0.38, 0.030, 0.02, P.armorLight);
  pistAcc.cylinder(0, 0, 0.745001, 0.075, 0.530002, 12, P.armorLight, "z");
  for (const px of [-0.34, 0.34]) {
    for (const py of [-0.32, 0.32]) {
      pistAcc.cylinder(px, py, 0.23, 0.042, 0.46, 10, P.chrome, "z");
    }
  }
  const matPiston = makeDeployablePbrMaterial(t, { roughness: 0.24, metalness: 0.85, csmState: options.csmState });
  const piston = new t.Mesh(pistAcc.toBufferGeometry(t), matPiston);
  piston.name = "pneumatic-cylinders";
  piston.position.set(0, 0, 0.15);
  piston.castShadow = true;
  piston.receiveShadow = true;

  // 3-axis gimbal (turntable at z=1.00 so pitched canister clears piston column/plate and blast shields across pitch ∈ [-0.2..+1.57] even at deployElevation=0)
  const turntable = new t.Group();
  turntable.name = "turret-yaw";
  turntable.position.set(0, 0, 1.00);

  const gimbal = new t.Group();
  gimbal.name = "turret-pitch";

  // Armored 2×2 quad-cell SAM canister pod (0.84 × 0.96 m) + X-axis trunnion hub + raised neck + recessed launch tubes + rear exhaust louver doors + EO/IR director
  const podAcc = new GeomAcc();
  podAcc.cylinder(0, 0, 0.0, 0.04, 0.20, 12, P.armorLight, "x");
  podAcc.box(0, 0, 0.06, 0.060, 0.030, 0.06, P.armorLight);
  podAcc.bevelBox(0, 0, 0.36, 0.42, 0.48, 0.25, 0.025, P.armorOlive, cShade(P.armorOlive, 0.82));
  // Front armored launch bezel & recessed cell collars
  podAcc.bevelBox(0, 0.44, 0.36, 0.43, 0.04, 0.25, 0.02, P.armorLight);
  for (let i = 0; i < 4; i++) {
    const mx = -0.18 + (i % 2) * 0.36;
    const mz = 0.25 + Math.floor(i / 2) * 0.22;
    podAcc.cylinder(mx, 0.46, mz, 0.10, 0.04, 12, P.louverDark, "y");
  }
  // Rear exhaust louver doors
  podAcc.box(0, -0.47, 0.36, 0.36, 0.015, 0.20, P.louverDark);
  // Roof EO/IR target director with amber optical dome
  podAcc.bevelBox(0, 0.10, 0.69, 0.12, 0.14, 0.08, 0.018, P.eoHousing);
  podAcc.cylinder(0, 0.24, 0.69, 0.055, 0.06, 10, P.amberOptic, "y");

  const matLauncherPod = makeDeployablePbrMaterial(t, { roughness: 0.56, metalness: 0.36, csmState: options.csmState });
  const launcherPod = new t.Mesh(podAcc.toBufferGeometry(t), matLauncherPod);
  launcherPod.castShadow = true;
  launcherPod.receiveShadow = true;

  // 4 Individually visible SAM missiles tucked inside y ∈ [-0.40, +0.44] (zero overhang!)
  const misAcc = new GeomAcc();
  misAcc.cylinder(0, -0.04, 0, 0.060, 0.64, 10, P.missileWhite, "y");
  misAcc.cone(0, 0.36, 0, 0.060, 0.005, 0.16, 10, P.noseRed, "y");
  misAcc.box(0, -0.31, 0, 0.085, 0.055, 0.008, P.finDark);
  misAcc.box(0, -0.31, 0, 0.008, 0.055, 0.085, P.finDark);
  const singleMissileGeom = misAcc.toBufferGeometry(t);

  const matMissile = makeDeployablePbrMaterial(t, { roughness: 0.38, metalness: 0.22, csmState: options.csmState });
  const missiles = [];
  for (let i = 0; i < 4; i++) {
    const m = new t.Mesh(singleMissileGeom, matMissile);
    m.position.set(-0.18 + (i % 2) * 0.36, 0.02, 0.25 + Math.floor(i / 2) * 0.22);
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
  const statusLed = new t.Mesh(new t.BoxGeometry(0.12, 0.024, 0.05), matStatusLed);
  statusLed.name = "sam-status-led";
  statusLed.position.set(0, -0.495, 0.34);
  statusLed.castShadow = true;
  statusLed.receiveShadow = true;

  gimbal.add(launcherPod);
  turntable.add(gimbal);
  riserGroup.add(turntable);
  root.add(outriggers, statusLed, piston, riserGroup);

  let isStowed = false;
  const PISTON_DEPLOY_SCALE_Z = (1.810002 - 0.15) / 1.010002;
  function applyRise(riseNorm) {
    const rn = Math.min(1.0, Math.max(0.0, riseNorm));
    riserGroup.position.z = rn === 1 ? 0.85 : (rn === 0 ? 0.20 : 0.20 + rn * 0.65);
    piston.scale.z = 1.0 + rn * (PISTON_DEPLOY_SCALE_Z - 1.0);
  }
  function setStowed(stowed) {
    isStowed = Boolean(stowed);
    pallet.setStowed(isStowed);
    if (isStowed) {
      applyRise(0.0);
      turntable.rotation.z = 0;
      gimbal.rotation.x = 0;
      gimbal.rotation.y = 0;
      matStatusLed.color.setHex(0xffaa22);
      matStatusLed.emissive.setHex(0xdd8800);
      matStatusLed.emissiveIntensity = 0.25;
    } else {
      applyRise(1.0);
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
    get stowed() {
      return isStowed;
    },
    setStowed,
    setDeployed(deployed) {
      setStowed(!deployed);
    },
    update(state = {}) {
      const s = state && typeof state === "object" ? state : {};
      if (s.stowed !== undefined) {
        setStowed(s.stowed);
      }
      if (isStowed) return;
      if (s.deployElevation !== undefined || s.riseTimeSec !== undefined) {
        if (Number.isFinite(s.deployElevation)) {
          applyRise(s.deployElevation);
        } else if (Number.isFinite(s.riseTimeSec)) {
          applyRise(s.riseTimeSec / 0.35);
        }
      }
      const yaw = s.yawRad !== undefined ? s.yawRad : (s.azimuthRad !== undefined ? s.azimuthRad : s.yaw);
      const pitch = s.pitchRad !== undefined ? s.pitchRad : (s.elevationRad !== undefined ? s.elevationRad : s.pitch);
      if (Number.isFinite(yaw)) turntable.rotation.z = yaw;
      if (Number.isFinite(pitch)) gimbal.rotation.x = pitch;
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
      disposeRootResources(root, [pallet.mesh, pallet.levelingJacks]);
    },
  };
}

// ---------------------------------------------------------------------------
// 6) Ground Radar (WCID 4000015, Standard Unified Pallet) — 30 RPM Surface Surveillance
//    - Full-skid tactical transceiver shelter with beveled roof, rear louvers, side cable reel, console hood + amber PPI
//    - Articulated Z-folding 2-segment lattice mast (no scale.z squashing!)
//    - Wide 1.00 m slotted-waveguide radar bar folding cleanly onto roof cradle when stowed (H_stowed ~ 1.18 m, H_deployed ~ 2.08 m)
//    - Draw calls: 7 (2 pallet + 5 unit) <= 10; 0 lights
// ---------------------------------------------------------------------------
export function buildGroundRadar(three, options = {}) {
  const t = three || THREE_DEFAULT;
  const root = new t.Group();
  root.name = "ground-radar-root";
  const pallet = buildPallet(t, "standard", options);
  root.add(pallet.root);

  const P = makeLinearPalette(t, {
    shelterOlive: 0x455241,
    shelterDark: 0x313a2e,
    louverSlate: 0x252b26,
    reelSteel: 0x626a70,
    cableBlack: 0x1b1e20,
    mastSteel: 0x7c848a,
    collarSteel: 0x4f565c,
    waveguideOrange: 0xd9822b,
    slotDark: 0x262b30,
    transceiverGray: 0x5c646a,
    hornSteel: 0x8d959c,
  });

  const deckZ = PALLET_SPECS.standard.height; // 0.145 m
  const baseAcc = new GeomAcc();
  // Tactical transceiver shelter (0.94 × 0.96 m, z = 0.145..0.72)
  baseAcc.bevelBox(0, 0, deckZ + 0.275, 0.47, 0.48, 0.275, 0.03, P.shelterOlive, cShade(P.shelterOlive, 0.80));
  baseAcc.bevelBox(0, 0, 0.72, 0.42, 0.43, 0.035, 0.02, P.shelterDark);
  // Rear heat-exchanger louvers (y = +0.48)
  for (let lz = 0.26; lz <= 0.60; lz += 0.065) {
    baseAcc.box(0, 0.485, lz, 0.30, 0.010, 0.014, P.louverSlate);
  }
  // Side cable reel on -X (max |-X| = 0.50 <= 0.55)
  baseAcc.cylinder(-0.46, 0.04, 0.44, 0.16, 0.06, 12, P.reelSteel, "x");
  baseAcc.cylinder(-0.46, 0.04, 0.44, 0.11, 0.08, 12, P.cableBlack, "x");
  // Angled front console hood (y = -0.34, z = 0.72..0.88)
  baseAcc.bevelBox(0, -0.34, 0.80, 0.28, 0.12, 0.085, 0.018, P.shelterDark);
  // Deck travel-lock mast cradle at y = +0.18
  baseAcc.box(-0.14, 0.18, 0.80, 0.025, 0.06, 0.06, P.collarSteel);
  baseAcc.box(0.14, 0.18, 0.80, 0.025, 0.06, 0.06, P.collarSteel);

  const matBase = makeDeployablePbrMaterial(t, { roughness: 0.58, metalness: 0.36, csmState: options.csmState });
  const baseMesh = new t.Mesh(baseAcc.toBufferGeometry(t), matBase);
  baseMesh.name = "ground-radar-pedestal";
  baseMesh.castShadow = true;
  baseMesh.receiveShadow = true;

  // Glowing amber PPI tactical display (additive, 0 lights)
  const matScope = new t.MeshBasicMaterial({
    color: 0xffb833,
    transparent: true,
    opacity: 0.88,
    blending: t.AdditiveBlending,
    depthWrite: false,
  });
  const scopeMesh = new t.Mesh(new t.BoxGeometry(0.32, 0.024, 0.11), matScope);
  scopeMesh.name = "ground-radar-ppi-scope";
  scopeMesh.position.set(0, -0.462, 0.80);

  // Articulated Z-folding lattice mast (no scale.z distortion!)
  const mastPivot = new t.Group();
  mastPivot.name = "ground-radar-mast-pivot";
  mastPivot.position.set(0, 0.34, 0.812);

  const lowerAcc = new GeomAcc();
  for (const sx of [-0.045, 0.045]) {
    lowerAcc.tube([sx, -0.04, 0], [sx, -0.04, 0.625], 0.014, 0.014, 6, P.mastSteel);
    lowerAcc.tube([sx, 0.04, 0], [sx, 0.04, 0.625], 0.014, 0.014, 6, P.mastSteel);
  }
  for (let bz = 0.06; bz < 0.50; bz += 0.14) {
    lowerAcc.tube([-0.045, -0.04, bz], [0.045, 0.04, bz + 0.12], 0.008, 0.008, 6, P.collarSteel);
    lowerAcc.tube([0.045, -0.04, bz], [-0.045, 0.04, bz + 0.12], 0.008, 0.008, 6, P.collarSteel);
  }
  // Top collar + +Y hinge clevis ears & transverse pin at y = +0.072, z = 0.640
  lowerAcc.box(0, 0, 0.630, 0.075, 0.065, 0.015, P.collarSteel);
  for (const sx of [-0.052, 0.052]) {
    lowerAcc.box(sx, 0.068, 0.640, 0.012, 0.020, 0.018, P.collarSteel);
  }
  lowerAcc.cylinder(0, 0.072, 0.640, 0.010, 0.132, 8, P.mastSteel, "x");
  const lowerMastMesh = new t.Mesh(lowerAcc.toBufferGeometry(t), matBase);
  lowerMastMesh.name = "ground-radar-mast-lower";
  lowerMastMesh.castShadow = true;
  lowerMastMesh.receiveShadow = true;
  mastPivot.add(lowerMastMesh);

  // Offset hinge pin in +Y while keeping upper mast & antenna coaxial when deployed
  const HINGE_Y = 0.072;
  const upperMastPivot = new t.Group();
  upperMastPivot.name = "ground-radar-mast-upper-pivot";
  upperMastPivot.position.set(0, HINGE_Y, 0.64);

  const upperAcc = new GeomAcc();
  upperAcc.cylinder(0, -HINGE_Y, 0.254, 0.042, 0.492, 10, P.mastSteel, "z");
  upperAcc.cylinder(0, -HINGE_Y, 0.017, 0.056, 0.018, 10, P.collarSteel, "z");
  upperAcc.box(0, -0.036, 0.008, 0.028, 0.044, 0.014, P.collarSteel);
  upperAcc.cylinder(0, -HINGE_Y, 0.519, 0.085, 0.08, 12, P.collarSteel, "z");
  const upperMastMesh = new t.Mesh(upperAcc.toBufferGeometry(t), matBase);
  upperMastMesh.name = "ground-radar-mast-upper";
  upperMastMesh.castShadow = true;
  upperMastMesh.receiveShadow = true;
  upperMastPivot.add(upperMastMesh);
  mastPivot.add(upperMastPivot);

  // Rotating 1.00 m slotted-waveguide radar bar with feedhorn & counterweight
  const antennaGroup = new t.Group();
  antennaGroup.name = "slotted-array-antenna";
  antennaGroup.position.set(0, -HINGE_Y, 0.62);

  const antAcc = new GeomAcc();
  antAcc.bevelBox(0, 0, 0.04, 0.50, 0.065, 0.10, 0.015, P.waveguideOrange, cShade(P.waveguideOrange, 0.84));
  antAcc.box(0, 0.066, 0.04, 0.46, 0.012, 0.032, P.slotDark);
  antAcc.bevelBox(0, -0.07, 0.01, 0.12, 0.08, 0.065, 0.015, P.transceiverGray);
  antAcc.cone(0, 0.12, 0.04, 0.045, 0.015, 0.12, 8, P.hornSteel, "y");

  const matAntenna = makeDeployablePbrMaterial(t, { roughness: 0.44, metalness: 0.55, csmState: options.csmState });
  const antMesh = new t.Mesh(antAcc.toBufferGeometry(t), matAntenna);
  antMesh.castShadow = true;
  antMesh.receiveShadow = true;
  antennaGroup.add(antMesh);
  upperMastPivot.add(antennaGroup);

  root.add(baseMesh, scopeMesh, mastPivot);

  let isStowed = false;
  function setStowed(stowed) {
    isStowed = Boolean(stowed);
    pallet.setStowed(isStowed);
    if (isStowed) {
      mastPivot.rotation.x = 1.24;
      upperMastPivot.rotation.x = -2.72;
      antennaGroup.rotation.set(0, 0, 0);
      matScope.color.setHex(0xffaa22);
      matScope.opacity = 0.22;
    } else {
      mastPivot.rotation.x = 0;
      upperMastPivot.rotation.x = 0;
      matScope.color.setHex(0xffb833);
      matScope.opacity = 0.88;
    }
  }
  setStowed(Boolean(options.stowed));

  return {
    root,
    antennaGroup,
    mastPivot,
    upperMastPivot,
    pallet,
    wcid: DEPLOYABLE_WCID.GroundRadar,
    palletSize: "full",
    get stowed() {
      return isStowed;
    },
    setStowed,
    setDeployed(deployed) {
      setStowed(!deployed);
    },
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
      disposeRootResources(root, [pallet.mesh, pallet.levelingJacks]);
    },
  };
}

// ---------------------------------------------------------------------------
// 7) Mortar Turret (WCID 4000016, Standard Unified Pallet)
//    - Heavy steel recoil baseplate + twin low-profile compressed-air tanks + brass manifold/gauges
//    - Side autoloader drum + armored slewing ring & sculpted trunnion cheeks (pops up on deployment to clear base)
//    - Detailed pneumatic mortar tube (breech plenum, cooling flutes, green ID band, muzzle ring)
//    - Stowed: carriage lowers and barrel retracts/folds into travel-lock cradle inside y ∈ [-0.50, +0.50] (H_stowed ~ 0.89 m, ZERO overhang!)
//    - Draw calls: 7 (2 pallet + 5 unit) <= 10; 0 lights
// ---------------------------------------------------------------------------
export function buildMortarTurret(three, options = {}) {
  const t = three || THREE_DEFAULT;
  const root = new t.Group();
  root.name = "mortar-turret-root";
  const pallet = buildPallet(t, "standard", options);
  root.add(pallet.root);

  const P = makeLinearPalette(t, {
    baseDark: 0x353c34,
    ringOlive: 0x464e44,
    tankTeal: 0x3a6a5d,
    brassManifold: 0xb8862d,
    cheekOlive: 0x545f50,
    drumSteel: 0x3b423c,
    chrome: 0xc4ccd2,
    barrelDark: 0x262a27,
    chemGreen: 0x2ec85a,
    breechGray: 0x4b534e,
  });

  const deckZ = PALLET_SPECS.standard.height; // 0.145 m
  const baseAcc = new GeomAcc();
  // Heavy steel recoil baseplate (1.02 × 1.02 m <= ±0.51 m)
  baseAcc.bevelBox(0, 0, deckZ + 0.06, 0.51, 0.51, 0.06, 0.03, P.baseDark, cShade(P.baseDark, 0.80));
  baseAcc.cylinder(0, -0.06, deckZ + 0.145, 0.28, 0.09, 16, P.ringOlive, "z");
  // Twin compact compressed-air tanks at rear (-Y) + brass manifold & pressure gauges (z <= 0.545 m, clearing deployed carriage)
  baseAcc.tube([-0.26, -0.40, 0.27], [-0.22, -0.35, 0.46], 0.085, 0.085, 12, P.tankTeal, P.tankTeal);
  baseAcc.tube([0.26, -0.40, 0.27], [0.22, -0.35, 0.46], 0.085, 0.085, 12, P.tankTeal, P.tankTeal);
  baseAcc.bevelBox(0, -0.36, 0.49, 0.26, 0.055, 0.040, 0.012, P.brassManifold);
  baseAcc.cylinder(-0.08, -0.42, 0.50, 0.028, 0.03, 10, P.chrome, "y");
  baseAcc.cylinder(0.08, -0.42, 0.50, 0.028, 0.03, 10, P.chrome, "y");
  // Forward travel-lock cradle at y = +0.34 (supports stowed barrel cleanly inside y <= 0.50 m, z <= 0.554 m < barrel.min.z)
  baseAcc.box(-0.145, 0.34, 0.402, 0.025, 0.05, 0.152, P.ringOlive);
  baseAcc.box(0.145, 0.34, 0.402, 0.025, 0.05, 0.152, P.ringOlive);
  baseAcc.box(0, 0.34, 0.525, 0.118, 0.05, 0.025, P.baseDark);

  const matRecoilRing = makeDeployablePbrMaterial(t, { roughness: 0.60, metalness: 0.40, csmState: options.csmState });
  const recoilRing = new t.Mesh(baseAcc.toBufferGeometry(t), matRecoilRing);
  recoilRing.castShadow = true;
  recoilRing.receiveShadow = true;

  // Telescoping chrome hydraulic lift ram bridging slewing ring (0.345 m) to raised carriage (0.650 m)
  const ramAcc = new GeomAcc();
  ramAcc.cylinder(0, 0, 0.1515, 0.10, 0.303, 14, P.chrome, "z");
  const matRam = makeDeployablePbrMaterial(t, { roughness: 0.24, metalness: 0.85, csmState: options.csmState });
  const liftRam = new t.Mesh(ramAcc.toBufferGeometry(t), matRam);
  liftRam.name = "mortar-lift-ram";
  liftRam.position.set(0, -0.06, 0.346);
  liftRam.castShadow = true;
  liftRam.receiveShadow = true;

  const carriage = new t.Group();
  carriage.name = "mortar-carriage";
  carriage.position.set(0, -0.06, 0.66);

  const cheekAcc = new GeomAcc();
  cheekAcc.cylinder(0, 0, 0.04, 0.24, 0.10, 16, P.cheekOlive, "z");
  cheekAcc.bevelBox(-0.18, 0, 0.23, 0.04, 0.17, 0.19, 0.015, P.cheekOlive);
  cheekAcc.bevelBox(0.18, 0, 0.23, 0.04, 0.17, 0.19, 0.015, P.cheekOlive);
  // Side autoloader drum on -X cheek
  cheekAcc.cylinder(-0.30, -0.02, 0.23, 0.14, 0.14, 14, P.drumSteel, "x");
  cheekAcc.cylinder(-0.30, -0.02, 0.23, 0.05, 0.16, 10, P.brassManifold, "x");
  // Pneumatic elevation actuator housing (below cradle swing & max recoil envelope)
  cheekAcc.cylinder(0, -0.10, 0.095, 0.060, 0.09, 10, P.chrome, "z");

  const matCheek = makeDeployablePbrMaterial(t, { roughness: 0.52, metalness: 0.46, csmState: options.csmState });
  const cheekMesh = new t.Mesh(cheekAcc.toBufferGeometry(t), matCheek);
  cheekMesh.castShadow = true;
  cheekMesh.receiveShadow = true;

  const cradle = new t.Group();
  cradle.name = "mortar-cradle";
  cradle.position.set(0, 0, 0.34);
  cradle.rotation.x = -0.52;

  const matStatusLed = new t.MeshStandardMaterial({
    color: 0x22ff66,
    emissive: 0x11cc44,
    emissiveIntensity: 0.85,
    roughness: 0.25,
    metalness: 0.2,
  });
  if (options.csmState) installCsmShaderPatch(matStatusLed, options.csmState);
  const statusLed = new t.Mesh(new t.BoxGeometry(0.10, 0.024, 0.05), matStatusLed);
  statusLed.name = "mortar-status-led";
  statusLed.position.set(0, -0.495, 0.24);
  statusLed.castShadow = true;
  statusLed.receiveShadow = true;

  // Detailed pneumatic mortar tube (0.82 m long, z ∈ [-0.41, +0.41])
  const barAcc = new GeomAcc();
  barAcc.cone(0, 0, 0.0, 0.105, 0.088, 0.80, 14, P.barrelDark, "z");
  barAcc.cylinder(0, 0, -0.32, 0.132, 0.18, 14, P.breechGray, "z");
  for (let fz = -0.16; fz <= 0.12; fz += 0.07) {
    barAcc.cylinder(0, 0, fz, 0.112, 0.022, 14, P.breechGray, "z");
  }
  barAcc.cylinder(0, 0, 0.27, 0.105, 0.09, 14, P.chemGreen, "z");
  barAcc.cylinder(0, 0, 0.39, 0.115, 0.04, 14, P.breechGray, "z");

  const matBarrel = makeDeployablePbrMaterial(t, { roughness: 0.38, metalness: 0.62, csmState: options.csmState });
  const barrel = new t.Mesh(barAcc.toBufferGeometry(t), matBarrel);
  barrel.position.set(0, 0, 0.42);
  barrel.castShadow = true;
  barrel.receiveShadow = true;

  cradle.add(barrel);
  carriage.add(cheekMesh, cradle);
  root.add(recoilRing, statusLed, liftRam, carriage);

  function syncLiftRam() {
    const gap = carriage.position.z - 0.357;
    if (gap > 0.005) {
      liftRam.visible = true; // vfx-lint-allow: telescoping lift ram visibility when elevated
      liftRam.scale.z = gap / 0.303;
    } else {
      liftRam.visible = false; // vfx-lint-allow: retracted lift ram hidden when lowered
    }
  }

  let isStowed = false;
  function setStowed(stowed) {
    isStowed = Boolean(stowed);
    pallet.setStowed(isStowed);
    if (isStowed) {
      carriage.position.z = 0.35;
      carriage.rotation.z = 0;
      cradle.rotation.x = -Math.PI / 2;
      barrel.position.z = 0.04; // Retracts back into recoil cradle so barrel spans y ∈ [-0.43, +0.39]
      syncLiftRam();
      matStatusLed.color.setHex(0xffaa22);
      matStatusLed.emissive.setHex(0xdd8800);
      matStatusLed.emissiveIntensity = 0.25;
    } else {
      carriage.position.z = 0.66;
      cradle.rotation.x = -0.52;
      barrel.position.z = 0.42;
      syncLiftRam();
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
    palletSize: "full",
    get stowed() {
      return isStowed;
    },
    setStowed,
    setDeployed(deployed) {
      setStowed(!deployed);
    },
    update(state = {}) {
      const s = state && typeof state === "object" ? state : {};
      if (s.stowed !== undefined) {
        setStowed(s.stowed);
      }
      if (isStowed) return;
      if (Number.isFinite(s.deployElevation) && s.deployElevation > 0) {
        carriage.position.z = 0.58 + Math.min(1, s.deployElevation) * 0.08;
      } else {
        carriage.position.z = 0.66;
      }
      syncLiftRam();
      const yaw = s.yawRad !== undefined ? s.yawRad : (s.azimuthRad !== undefined ? s.azimuthRad : s.yaw);
      const pitch = s.pitchRad !== undefined ? s.pitchRad : (s.elevationRad !== undefined ? s.elevationRad : s.pitch);
      if (Number.isFinite(yaw)) carriage.rotation.z = yaw;
      if (Number.isFinite(pitch)) cradle.rotation.x = pitch;
      const safeRecoil = Number.isFinite(s.recoilSec) ? s.recoilSec : 0;
      const recoilKick = Math.min(0.14, Math.max(0, safeRecoil * 0.10));
      barrel.position.z = 0.42 - recoilKick;
    },
    dispose() {
      pallet.dispose();
      disposeRootResources(root, [pallet.mesh, pallet.levelingJacks]);
    },
  };
}

// ---------------------------------------------------------------------------
// 8) Heavy Laser Turret (WCID 4000017, Standard Unified Pallet)
//    - Armored full-skid base with radial copper-finned heat-exchangers & umbilical power conduits
//    - Octagonal slewing turret yoke + dual-mode optical fire-control director
//    - Twin faceted gunmetal laser emitter barrels with telescoping optical shrouds & crimson ruby lenses
//    - Stowed: shrouds retract cleanly into telescoping forward lock cradle inside y ∈ [-0.52, +0.52] (H_stowed ~ 1.45 m, ZERO overhang!)
//    - Draw calls: 8 (2 pallet + 6 unit) <= 10; 0 lights
// ---------------------------------------------------------------------------
export function buildHeavyLaserTurret(three, options = {}) {
  const t = three || THREE_DEFAULT;
  const root = new t.Group();
  root.name = "heavy-laser-turret-root";
  const pallet = buildPallet(t, "standard", options);
  root.add(pallet.root);

  const P = makeLinearPalette(t, {
    baseDark: 0x262a2d,
    pedSteel: 0x383f44,
    copperFin: 0xb24e28,
    umbilical: 0x1e2226,
    yokeGray: 0x4b5359,
    barrelDark: 0x202428,
    shroudSteel: 0x6a747c,
    directorGray: 0x4f5860,
    crimsonGlow: 0xff2233,
  });

  const deckZ = PALLET_SPECS.standard.height; // 0.145 m
  const pedAcc = new GeomAcc();
  // Armored full-skid base (1.02 × 1.02 m <= ±0.51 m) + octagonal pedestal
  pedAcc.bevelBox(0, 0, deckZ + 0.06, 0.51, 0.51, 0.06, 0.03, P.baseDark, cShade(P.baseDark, 0.80));
  pedAcc.cone(0, -0.04, 0.48, 0.28, 0.22, 0.44, 8, P.pedSteel, "z");
  // Radial copper-finned thermal heat-exchangers around pedestal
  for (let i = 0; i < 6; i++) {
    const a = -Math.PI * 0.85 + (i / 5) * Math.PI * 0.70; // Rear/side arc (-Y)
    const fx = Math.cos(a) * 0.28;
    const fy = -0.04 + Math.sin(a) * 0.28;
    pedAcc.box(fx, fy, 0.44, 0.045, 0.045, 0.16, P.copperFin, cShade(P.copperFin, 0.80));
  }
  // Armored power umbilical conduits
  for (const sx of [-1, 1]) {
    pedAcc.tube([sx * 0.38, -0.34, 0.26], [sx * 0.22, -0.18, 0.56], 0.026, 0.024, 8, P.umbilical);
  }
  // Flanking guide rails for telescoping forward travel-lock cradle at y = +0.42
  pedAcc.box(-0.205, 0.42, 0.505, 0.012, 0.055, 0.24, P.baseDark);
  pedAcc.box(0.205, 0.42, 0.505, 0.012, 0.055, 0.24, P.baseDark);

  const matPedestal = makeDeployablePbrMaterial(t, { roughness: 0.62, metalness: 0.38, csmState: options.csmState });
  const pedestal = new t.Mesh(pedAcc.toBufferGeometry(t), matPedestal);
  pedestal.castShadow = true;
  pedestal.receiveShadow = true;

  // Retractable armored forward travel-lock cradle (raises to z=1.16 when stowed, retracts to z<=0.686 when deployed)
  const lockAcc = new GeomAcc();
  lockAcc.box(-0.14, 0.42, 0.205, 0.038, 0.048, 0.205, P.pedSteel);
  lockAcc.box(0.14, 0.42, 0.205, 0.038, 0.048, 0.205, P.pedSteel);
  lockAcc.box(0, 0.42, 0.380, 0.175, 0.055, 0.025, P.baseDark);
  const lockCradle = new t.Mesh(lockAcc.toBufferGeometry(t), matPedestal);
  lockCradle.name = "laser-travel-lock-cradle";
  lockCradle.position.set(0, 0, 0.266);
  lockCradle.castShadow = true;
  lockCradle.receiveShadow = true;

  const turretHead = new t.Group();
  turretHead.name = "laser-head-yaw";
  turretHead.position.set(0, -0.04, 0.76);

  const yokeAcc = new GeomAcc();
  yokeAcc.cylinder(0, 0, 0.005, 0.24, 0.11, 8, P.yokeGray, "z");
  yokeAcc.bevelBox(-0.265, 0, 0.27, 0.038, 0.19, 0.27, 0.015, P.yokeGray);
  yokeAcc.bevelBox(0.265, 0, 0.27, 0.038, 0.19, 0.27, 0.015, P.yokeGray);
  const matYoke = makeDeployablePbrMaterial(t, { roughness: 0.48, metalness: 0.52, csmState: options.csmState });
  const yokeMesh = new t.Mesh(yokeAcc.toBufferGeometry(t), matYoke);
  yokeMesh.castShadow = true;
  yokeMesh.receiveShadow = true;

  const barrelGimbal = new t.Group();
  barrelGimbal.name = "laser-barrels-pitch";
  barrelGimbal.position.set(0, 0, 0.46);

  // Main breech housing + twin base barrels + top dual-mode optical fire-control director (stays inside y ∈ [-0.42, +0.44])
  const barAcc = new GeomAcc();
  barAcc.bevelBox(0, -0.04, 0, 0.20, 0.30, 0.15, 0.025, P.pedSteel, cShade(P.pedSteel, 0.82));
  barAcc.cylinder(-0.12, 0.16, 0.02, 0.070, 0.54, 10, P.barrelDark, "y");
  barAcc.cylinder(0.12, 0.16, 0.02, 0.070, 0.54, 10, P.barrelDark, "y");
  // Top dual-mode optical fire-control director
  barAcc.bevelBox(0, 0.02, 0.22, 0.10, 0.15, 0.065, 0.018, P.directorGray);
  barAcc.cylinder(-0.045, 0.17, 0.22, 0.028, 0.04, 8, P.shroudSteel, "y");
  barAcc.cylinder(0.045, 0.17, 0.22, 0.028, 0.04, 8, P.shroudSteel, "y");

  const matBarrel = makeDeployablePbrMaterial(t, { roughness: 0.34, metalness: 0.65, csmState: options.csmState });
  const barrelMesh = new t.Mesh(barAcc.toBufferGeometry(t), matBarrel);
  barrelMesh.castShadow = true;
  barrelMesh.receiveShadow = true;

  // Telescoping optical shrouds (local y ∈ [-0.08, +0.46]; stowed at y=0 -> world y ≤ +0.42 m; deployed +0.40 m -> +0.82 m)
  const shrAcc = new GeomAcc();
  shrAcc.cylinder(-0.12, 0.18, 0.02, 0.056, 0.50, 10, P.barrelDark, "y");
  shrAcc.cylinder(0.12, 0.18, 0.02, 0.056, 0.50, 10, P.barrelDark, "y");
  shrAcc.cylinder(-0.12, 0.42, 0.02, 0.078, 0.08, 10, P.shroudSteel, "y");
  shrAcc.cylinder(0.12, 0.42, 0.02, 0.078, 0.08, 10, P.shroudSteel, "y");
  const shroudMesh = new t.Mesh(shrAcc.toBufferGeometry(t), matBarrel);
  shroudMesh.name = "laser-telescoping-shrouds";
  shroudMesh.castShadow = true;
  shroudMesh.receiveShadow = true;

  // Glowing crimson capacitor rails & twin ruby focusing lenses (additive, 0 dynamic lights)
  const glowAcc = new GeomAcc();
  glowAcc.cylinder(-0.12, 0.47, 0.02, 0.046, 0.03, 10, P.crimsonGlow, "y");
  glowAcc.cylinder(0.12, 0.47, 0.02, 0.046, 0.03, 10, P.crimsonGlow, "y");
  glowAcc.box(0, 0.06, 0.02, 0.21, 0.18, 0.028, P.crimsonGlow);
  const matLaserGlow = new t.MeshBasicMaterial({
    color: 0xff2233,
    transparent: true,
    opacity: 0.90,
    blending: t.AdditiveBlending,
    depthWrite: false,
  });
  const glowMesh = new t.Mesh(glowAcc.toBufferGeometry(t), matLaserGlow);
  glowMesh.name = "laser-emitter-glow";

  barrelGimbal.add(barrelMesh, shroudMesh, glowMesh);
  turretHead.add(yokeMesh, barrelGimbal);
  root.add(pedestal, lockCradle, turretHead);

  let isStowed = false;
  function setStowed(stowed) {
    isStowed = Boolean(stowed);
    pallet.setStowed(isStowed);
    if (isStowed) {
      lockCradle.position.z = 0.75;
      turretHead.rotation.z = 0;
      barrelGimbal.rotation.x = 0;
      shroudMesh.position.y = 0.0;
      glowMesh.position.y = 0.0;
      matLaserGlow.color.setHex(0xffaa22);
      matLaserGlow.opacity = 0.22;
    } else {
      lockCradle.position.z = 0.266;
      shroudMesh.position.y = 0.40;
      glowMesh.position.y = 0.40;
      matLaserGlow.color.setHex(0xff2233);
      matLaserGlow.opacity = 0.90;
    }
  }
  setStowed(Boolean(options.stowed));

  return {
    root,
    turretHead,
    barrelGimbal,
    shroudMesh,
    pallet,
    wcid: DEPLOYABLE_WCID.HeavyLaserTurret,
    palletSize: "full",
    get stowed() {
      return isStowed;
    },
    setStowed,
    setDeployed(deployed) {
      setStowed(!deployed);
    },
    update(state = {}) {
      const s = state && typeof state === "object" ? state : {};
      if (s.stowed !== undefined) {
        setStowed(s.stowed);
      }
      if (isStowed) return;
      const yaw = s.yawRad !== undefined ? s.yawRad : (s.azimuthRad !== undefined ? s.azimuthRad : s.yaw);
      const pitch = s.pitchRad !== undefined ? s.pitchRad : (s.elevationRad !== undefined ? s.elevationRad : s.pitch);
      if (Number.isFinite(yaw)) turretHead.rotation.z = yaw;
      if (Number.isFinite(pitch)) barrelGimbal.rotation.x = pitch;
    },
    dispose() {
      pallet.dispose();
      disposeRootResources(root, [pallet.mesh, pallet.levelingJacks]);
    },
  };
}

const DEPLOYABLE_KIND_TO_WCID = new Map([
  [DEPLOYABLE_KINDS.FluxPod, DEPLOYABLE_WCID.FluxPod],
  [DEPLOYABLE_KINDS.SolarPanels, DEPLOYABLE_WCID.SolarPanels],
  [DEPLOYABLE_KINDS.PowerGenerator, DEPLOYABLE_WCID.PowerGenerator],
  [DEPLOYABLE_KINDS.BatteryUnit, DEPLOYABLE_WCID.BatteryUnit],
  [DEPLOYABLE_KINDS.MissileTurret, DEPLOYABLE_WCID.MissileTurret],
  [DEPLOYABLE_KINDS.GroundRadar, DEPLOYABLE_WCID.GroundRadar],
  [DEPLOYABLE_KINDS.MortarTurret, DEPLOYABLE_WCID.MortarTurret],
  [DEPLOYABLE_KINDS.HeavyLaserTurret, DEPLOYABLE_WCID.HeavyLaserTurret],
  [PROSPECTING_KIND.GprScanner, PROSPECTING_WCID.GprScanner],
  [PROSPECTING_KIND.VibroseisSeismic, PROSPECTING_WCID.VibroseisSeismic],
  [PROSPECTING_KIND.DiamondCoreDrill, PROSPECTING_WCID.DiamondCoreDrill],
  [PROSPECTING_KIND.MobileAssayLab, PROSPECTING_WCID.MobileAssayLab],
  [PROSPECTING_KIND.CoreSampleCrate, PROSPECTING_WCID.CoreSampleCrate],
  [INDUSTRIAL_SKID_KIND.BoreholeMiner, INDUSTRIAL_SKID_WCID.BoreholeMiner],
  [INDUSTRIAL_SKID_KIND.JawCrusher, INDUSTRIAL_SKID_WCID.JawCrusher],
  [INDUSTRIAL_SKID_KIND.Concentrator, INDUSTRIAL_SKID_WCID.Concentrator],
  [INDUSTRIAL_SKID_KIND.RotaryOilRig, INDUSTRIAL_SKID_WCID.RotaryOilRig],
  [INDUSTRIAL_SKID_KIND.PumpjackTree, INDUSTRIAL_SKID_WCID.PumpjackTree],
  [INDUSTRIAL_SKID_KIND.ThreePhaseSeparator, INDUSTRIAL_SKID_WCID.ThreePhaseSeparator],
  [INDUSTRIAL_SKID_KIND.AduRefinery, INDUSTRIAL_SKID_WCID.AduRefinery],
  [INDUSTRIAL_SKID_KIND.HdtVduDewaxer, INDUSTRIAL_SKID_WCID.HdtVduDewaxer],
  [INDUSTRIAL_SKID_KIND.PyroSmelter, INDUSTRIAL_SKID_WCID.PyroSmelter],
  [INDUSTRIAL_SKID_KIND.ContactAcidWorks, INDUSTRIAL_SKID_WCID.ContactAcidWorks],
  [INDUSTRIAL_SKID_KIND.BioProcessorTannery, INDUSTRIAL_SKID_WCID.BioProcessorTannery],
  [INDUSTRIAL_SKID_KIND.IndustrialGenset150kW, INDUSTRIAL_SKID_WCID.IndustrialGenset150kW],
  [INDUSTRIAL_SKID_KIND.IndustrialBess18MJ, INDUSTRIAL_SKID_WCID.IndustrialBess18MJ],
  [CIVIC_KIND.TownControlNode, CIVIC_WCID.TownControlNode],
  [CIVIC_KIND.TownDepotApron, CIVIC_WCID.TownDepotApron],
  [CIVIC_KIND.ForwardSiegeBeacon, CIVIC_WCID.ForwardSiegeBeacon],
  [CIVIC_KIND.TownMint, CIVIC_WCID.TownMint],
  [CIVIC_KIND.TownWorkshop, CIVIC_WCID.TownWorkshop],
  [CIVIC_KIND.PublicCommonsStarterHearth, CIVIC_WCID.PublicCommonsStarterHearth],
]);

const DEPLOYABLE_NAME_TO_WCID = new Map([
  ["fluxpod", DEPLOYABLE_WCID.FluxPod],
  ["solarpanels", DEPLOYABLE_WCID.SolarPanels],
  ["powergenerator", DEPLOYABLE_WCID.PowerGenerator],
  ["batteryunit", DEPLOYABLE_WCID.BatteryUnit],
  ["missileturret", DEPLOYABLE_WCID.MissileTurret],
  ["groundradar", DEPLOYABLE_WCID.GroundRadar],
  ["mortarturret", DEPLOYABLE_WCID.MortarTurret],
  ["heavylaserturret", DEPLOYABLE_WCID.HeavyLaserTurret],
  ["gprscanner", PROSPECTING_WCID.GprScanner],
  ["gpr", PROSPECTING_WCID.GprScanner],
  ["vibroseisseismic", PROSPECTING_WCID.VibroseisSeismic],
  ["diamondcoredrill", PROSPECTING_WCID.DiamondCoreDrill],
  ["mobileassaylab", PROSPECTING_WCID.MobileAssayLab],
  ["coresamplecrate", PROSPECTING_WCID.CoreSampleCrate],
  ["boreholeminer", INDUSTRIAL_SKID_WCID.BoreholeMiner],
  ["jawcrusher", INDUSTRIAL_SKID_WCID.JawCrusher],
  ["concentrator", INDUSTRIAL_SKID_WCID.Concentrator],
  ["rotaryoilrig", INDUSTRIAL_SKID_WCID.RotaryOilRig],
  ["pumpjacktree", INDUSTRIAL_SKID_WCID.PumpjackTree],
  ["threephaseseparator", INDUSTRIAL_SKID_WCID.ThreePhaseSeparator],
  ["adurefinery", INDUSTRIAL_SKID_WCID.AduRefinery],
  ["hdtvdudewaxer", INDUSTRIAL_SKID_WCID.HdtVduDewaxer],
  ["pyrosmelter", INDUSTRIAL_SKID_WCID.PyroSmelter],
  ["contactacidworks", INDUSTRIAL_SKID_WCID.ContactAcidWorks],
  ["bioprocessortannery", INDUSTRIAL_SKID_WCID.BioProcessorTannery],
  ["industrialgenset150kw", INDUSTRIAL_SKID_WCID.IndustrialGenset150kW],
  ["industrialbess18mj", INDUSTRIAL_SKID_WCID.IndustrialBess18MJ],
  ["towncontrolnode", CIVIC_WCID.TownControlNode],
  ["towndepotapron", CIVIC_WCID.TownDepotApron],
  ["forwardsiegebeacon", CIVIC_WCID.ForwardSiegeBeacon],
  ["townmint", CIVIC_WCID.TownMint],
  ["townworkshop", CIVIC_WCID.TownWorkshop],
  ["publiccommonsstarterhearth", CIVIC_WCID.PublicCommonsStarterHearth],
]);

export function buildDeployable(three, wcid, options = {}) {
  let resolvedWcid = wcid;
  if (typeof wcid === "string") {
    const trimmed = wcid.trim();
    if (/^\d+$/.test(trimmed)) {
      resolvedWcid = Number.parseInt(trimmed, 10);
    } else {
      resolvedWcid = DEPLOYABLE_NAME_TO_WCID.get(trimmed.toLowerCase());
    }
  } else if (typeof wcid === "number" && DEPLOYABLE_KIND_TO_WCID.has(wcid)) {
    resolvedWcid = DEPLOYABLE_KIND_TO_WCID.get(wcid);
  }
  switch (resolvedWcid) {
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
    default: {
      if (resolvedWcid >= 4000070 && resolvedWcid <= 4000074) {
        const built = buildProspectingDeployable(three, resolvedWcid, options);
        if (built) return built;
      } else if (resolvedWcid >= 4000075 && resolvedWcid <= 4000087) {
        const built = buildIndustryDeployable(three, resolvedWcid, options);
        if (built) return built;
      } else if (resolvedWcid >= 4000090 && resolvedWcid <= 4000095) {
        const built = buildCivicDeployable(three, resolvedWcid, options);
        if (built) return built;
      }
      throw new Error(`Unknown deployable WCID: ${wcid}`);
    }
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
