// scene3d/vehicle/airframe.js — the vehicle's looks as data (vehicles DESIGN §5.1 rule 2, HBV1 v2 Parts + PartRoles),
// plus the procedural Grumman F6F-5 / F6F-6 Hellcat airframe for capable clients.
//
// Vehicle frame convention (shared by server & client):
//   +x right (starboard), +y forward (nose), +z up (dorsal); origin = ground under the main wheels when level.
//   ZC = 2.68 m thrust line, HUB = [0, 3.84, 2.68], SEAT = [0, -0.4, 2.34], MAIN_Y = 1.20 m main-wheel contact,
//   GEAR_PITCH = 11° tail-down ground stance.
//
// Retail composite mode decodes Asheron's Call Setup/GfxObj parts via resident HBG1 bundles or urgent wasm placement
// fetches and merges per (bucket, material). Procedural Hellcat mode (`?vehicleModel=auto|procedural|retail`, default
// `auto` for >= 30-part Hellcat profiles) builds an authentic vertex-colored Grumman F6F-5/F6F-6 Hellcat in ~15
// airframe draw calls (<= 24 including all 9 individual HVAR + bomb stations, down from 94) with articulated control
// surfaces, twist-and-turn retracting landing gear, speed-blended Hamilton Standard prop blur disc, sliding canopy,
// illuminated Mk 8 reflector sight, USN Star-and-Bars geometry insignia, and R-2800 exhaust flames (zero lights added).
//
// `?vehicleAirframe=off` (exact) draws the retail stand-in as before.

import { meshToGeometryGroups } from "../adapter.js";
import { surfacePixelsFetcher } from "../bake_worker_client.js";
import { materialCanCastShadow } from "../materials.js";
import { prewarmSubtree } from "../bake_prewarm.js";
import { geomBundlesActive, assembleModels as assembleGeomBundles, bundleToPartGroups } from "../geom_bundles.js";

export const PART_ROLE = Object.freeze({ STATIC: 0, PROPELLER: 1, GEAR: 2, CANOPY: 3, ORDNANCE: 4 });
export const GEAR_PITCH = (11 * Math.PI) / 180;
/** Parked stance blend time constant (s): the tail lifts as the take-off starts, settles on touchdown. */
export const GEAR_TAU = 0.35;
/** Twist-and-turn main gear retraction time constant (s) on procedural Hellcats. */
export const GEAR_DEPLOY_TAU = 0.42;
/** Propeller: rad/s at idle and the extra at full throttle (34°/frame at 60 fps: visibly spinning, not strobing). */
export const PROP = Object.freeze({ idle: 6, full: 30 });
const MODE_PARKED = 0, MODE_TAKEOFF = 1, MODE_FLIGHT = 2, MODE_LANDING = 3;
const DEG = Math.PI / 180;

/** 1944 USN WWII Tricolor Camouflage + ordnance/cockpit palette (sRGB hex). */
export const HELLCAT_PALETTE = Object.freeze({
  seaBlue: 0x1b2d42,
  intermediateBlue: 0x4c6885,
  insigniaWhite: 0xe6e9ec,
  insigniaBlue: 0x101d33,
  starWhite: 0xf2f5f8,
  antiGlare: 0x181a1d,
  chromateGreen: 0x3e5233,
  crankcaseGrey: 0x526273,
  cylinderGunmetal: 0x2c3036,
  silver: 0xc2cad2,
  exhaustBurnt: 0x43362f,
  propBlack: 0x17191c,
  propYellow: 0xf6c324,
  tireRubber: 0x1d1f23,
  oliveDrab: 0x4a5234,
  heYellow: 0xe8b923,
  reticleAmber: 0xffbe2e,
  navRed: 0xff281c,
  navGreen: 0x1cff4e,
  strobeWhite: 0xfff8e7,
});

export function airframeEnabled(search) {
  try { return new URLSearchParams(search || "").get("vehicleAirframe") !== "off"; } catch (_) { return true; }
}

/** `"procedural" | "retail" | "auto"` from `?vehicleModel=...` (default `"auto"`). */
export function vehicleModelMode(search) {
  try {
    const raw = search !== undefined ? search : (typeof globalThis !== "undefined" ? globalThis.location?.search : "");
    const v = (new URLSearchParams(raw || "").get("vehicleModel") || "").trim().toLowerCase();
    if (v === "procedural" || v === "retail") return v;
  } catch (_) { /* ignore */ }
  return "auto";
}

/**
 * Select procedural Grumman F6F Hellcat vs retail AC composite parts:
 *  - `"retail"` -> false
 *  - `"procedural"` -> `/^hellcat/i.test(profile?.profileKey || "")`
 *  - `"auto"` (default) -> `/^hellcat/i.test(profile?.profileKey || "") && (profile?.parts?.length ?? 0) >= 30`
 */
export function shouldUseProceduralHellcat(profile, search) {
  const mode = vehicleModelMode(search);
  if (mode === "retail") return false;
  const isHellcat = /^hellcat/i.test(profile?.profileKey || "");
  if (!isHellcat) return false;
  if (mode === "procedural") return true;
  return (profile?.parts?.length ?? 0) >= 30;
}

export const roleKind = (r) => (r >>> 0) & 0xffff;
export const roleWeapon = (r) => ((r >>> 0) >>> 16) & 0xff;

/** True when the profile carries a composite airframe (parts beyond the stand-in itself, with roles). */
export function hasComposite(profile) {
  const parts = profile?.parts;
  if (!Array.isArray(parts) || parts.length === 0) return false;
  if (parts.length === 1 && (parts[0].did >>> 0) === (profile.standInSetup >>> 0)) return false;
  return true;
}

/** {kind, ordinal}: the weapon's kind and its index among the profile's weapons of that kind. */
export function kindOrdinal(profile, weaponIndex) {
  const ws = profile?.weapons || [];
  const w = ws[weaponIndex];
  if (!w) return { kind: 0, ordinal: -1 };
  let ord = 0;
  for (let i = 0; i < weaponIndex; i++) if (ws[i] && ws[i].kind === w.kind) ord++;
  return { kind: w.kind, ordinal: ord };
}

/** Is weapon `w` loaded, by the state's masks (+ a local "fired" set the pilot marks before the next state)? */
export function weaponLoaded(profile, w, missileMask, bombMask, localSpent) {
  if (localSpent && localSpent.has(w)) return false;
  const { kind, ordinal } = kindOrdinal(profile, w);
  if (ordinal < 0) return true;
  if (kind === 2) return Number.isFinite(missileMask) ? ((missileMask >>> ordinal) & 1) === 1 : true;
  if (kind === 3) return Number.isFinite(bombMask) ? ((bombMask >>> ordinal) & 1) === 1 : true;
  return true;
}

/** The main wheels' contact line (y of the most forward Gear part), or null without gear. */
export function gearPivotY(profile) {
  const parts = profile?.parts || [];
  const roles = profile?.partRoles || [];
  let y = null;
  for (let i = 0; i < parts.length; i++) {
    if (roleKind(roles[i] ?? 0) !== PART_ROLE.GEAR) continue;
    const oy = parts[i].offset?.[1];
    if (Number.isFinite(oy) && (y === null || oy > y)) y = oy;
  }
  return y;
}

/** Gear stance target for a mode: 1 = sitting on its wheels (tail down), 0 = flying level. */
export function gearTarget(mode, agl) {
  if (mode === MODE_PARKED) return 1;
  if (mode === MODE_LANDING && Number.isFinite(agl) && agl < 1.5) return 1;
  return 0;
}

function _getCachedMat(mc, sid) {
  if (!mc || !sid) return null;
  if (mc.materials instanceof Map) {
    if (!mc.materials.has(sid)) return null;
    return typeof mc.getCached === "function" ? mc.getCached(sid) : mc.materials.get(sid);
  }
  if (typeof mc.getCached === "function") {
    const m = mc.getCached(sid);
    if (m && (!mc.fallbackMaterial || m !== mc.fallbackMaterial)) return m;
  }
  return null;
}

/**
 * Decode one retail model into [{geometry, material, doubleSided}] in the model's own frame (the Setup's placement
 * frames applied). Shared by the airframe and the quarrels. Returns [] when the client cannot decode (tests, no wasm).
 */
export async function decodeModel(live, THREE, did, preAssembled = null) {
  const wasm = live?.wasmExports;
  const mc = live?.materialCache;
  if (!THREE || !mc) return [];

  const modelDid = did >>> 0;
  let partList = null;

  // Fast path: try resident HBG1 geometry bundles first.
  if (geomBundlesActive()) {
    try {
      const bMap = preAssembled || (await assembleGeomBundles([modelDid]));
      const b = bMap?.byModel ? bMap.byModel.get(modelDid) : bMap?.get?.(modelDid);
      if (b) {
        const bpg = bundleToPartGroups(b, bMap?.buffer);
        if (bpg && Array.isArray(bpg.parts)) {
          partList = bpg.parts.map((pt) => ({
            hinge: pt.hinge || null,
            groups: (pt.groups || []).map((grp) => ({
              geometry:
                grp.geometry?.index && typeof grp.geometry.toNonIndexed === "function"
                  ? grp.geometry.toNonIndexed()
                  : grp.geometry,
              surfaceDid: Number(grp.surfaceDid ?? 0) >>> 0,
              doubleSided: !!grp.doubleSided,
            })),
          }));
        } else if (Array.isArray(bpg)) {
          partList = [
            {
              hinge: null,
              groups: bpg.map((grp) => ({
                geometry:
                  grp.geometry?.index && typeof grp.geometry.toNonIndexed === "function"
                    ? grp.geometry.toNonIndexed()
                    : grp.geometry,
                surfaceDid: Number(grp.surfaceDid ?? 0) >>> 0,
                doubleSided: !!grp.doubleSided,
              })),
            },
          ];
        }
      }
    } catch (_) { /* fall through to wasm placement fetch */ }
  }

  // Fallback: fetch placement via urgent lane so airframe decode isn't starved by background bakes.
  if (!partList) {
    if (!wasm || typeof wasm.fetchBuildingPlacement !== "function") return [];
    let placement = null;
    try {
      placement = await wasm.fetchBuildingPlacement(modelDid, true);
    } catch (_) {
      return [];
    }
    if (!placement) return [];
    if (typeof placement.partGroups === "function") {
      const groups = placement.partGroups() || [];
      try { placement.free?.(); } catch (_) { /* freed */ }
      partList = [
        {
          hinge: null,
          groups: groups.map((grp) => ({
            geometry: grp.geometry,
            surfaceDid: Number(grp.surfaceDid ?? 0) >>> 0,
            doubleSided: !!grp.doubleSided,
          })),
        },
      ];
    } else {
      const partCount = placement.partCount | 0;
      const partMeshes = partCount ? placement.takePartMeshes() : [];
      const hinge = typeof placement.takePartHingeFrames === "function" ? placement.takePartHingeFrames() : [];
      try { placement.free?.(); } catch (_) { /* freed */ }
      partList = [];
      for (let i = 0; i < partCount; i++) {
        const wm = partMeshes[i];
        if (!wm) continue;
        try {
          const { groups, surfaceDids } = meshToGeometryGroups(wm);
          const normGroups = [];
          for (let g = 0; g < (groups?.length || 0); g++) {
            const grp = groups[g];
            normGroups.push({
              geometry: grp.geometry,
              surfaceDid: Number(grp.surfaceDid || surfaceDids?.[g] || 0) >>> 0,
              doubleSided: !!grp.doubleSided,
            });
          }
          partList.push({ hinge: hinge[i] || null, groups: normGroups });
        } catch (_) { /* a part that does not build is left out */ }
        try { wm.free?.(); } catch (_) { /* freed */ }
      }
    }
  }

  const fetchPixels = surfacePixelsFetcher(wasm);
  const urgentFetchPixels = (dids) => fetchPixels(dids, true);

  // Batch preload all uncached surface textures for this model on the urgent lane.
  const missingSidsSet = new Set();
  for (let i = 0; i < partList.length; i++) {
    const groups = partList[i].groups || [];
    for (let g = 0; g < groups.length; g++) {
      const sid = Number(groups[g].surfaceDid) >>> 0;
      if (sid !== 0 && !_getCachedMat(mc, sid)) {
        missingSidsSet.add(sid);
      }
    }
  }
  const missingSids = [...missingSidsSet];
  if (missingSids.length > 0 && typeof mc.preload === "function") {
    try {
      await mc.preload(missingSids, urgentFetchPixels);
    } catch (_) { /* per-group get falls back cleanly */ }
  }

  const out = [];
  const m = new THREE.Matrix4();
  for (let i = 0; i < partList.length; i++) {
    const { hinge: h, groups } = partList[i];
    m.identity();
    if (h) m.compose(new THREE.Vector3(h.x, h.y, h.z), new THREE.Quaternion(h.qx, h.qy, h.qz, h.qw), new THREE.Vector3(1, 1, 1));
    try {
      for (let g = 0; g < (groups?.length || 0); g++) {
        const grp = groups[g];
        const sid = Number(grp.surfaceDid ?? 0) >>> 0;
        // eslint-disable-next-line no-await-in-loop
        const material = _getCachedMat(mc, sid) || (await mc.get(sid, urgentFetchPixels));
        if (!grp.geometry || !material) continue;
        if (h) grp.geometry.applyMatrix4(m);
        out.push({ geometry: grp.geometry, material, doubleSided: !!grp.doubleSided });
      }
    } catch (_) { /* a part that does not build is left out */ }
  }
  return out;
}

/** Merge non-indexed geometries (position / normal / uv) into one. */
export function mergeGeometries(THREE, geoms) {
  let n = 0;
  for (const g of geoms) n += g.attributes.position.count;
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), uv = new Float32Array(n * 2);
  let o = 0;
  for (const g of geoms) {
    const c = g.attributes.position.count;
    pos.set(g.attributes.position.array.subarray(0, c * 3), o * 3);
    if (g.attributes.normal) nor.set(g.attributes.normal.array.subarray(0, c * 3), o * 3);
    if (g.attributes.uv) uv.set(g.attributes.uv.array.subarray(0, c * 2), o * 2);
    o += c;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  out.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
  out.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  out.computeBoundingSphere();
  out.computeBoundingBox();
  return out;
}

// ============================================================================
// Procedural Grumman F6F-5 / F6F-6 Hellcat Builder
// ============================================================================

const F6F_ZC = 2.68;
const F6F_HUB = Object.freeze([0, 3.84, 2.68]);
const F6F_MAIN_Y = 1.20;
const F6F_WING_Z = 2.08;
const F6F_FOLD_X = 2.05;
const F6F_DIHEDRAL = 6.5 * DEG;
const F6F_SPAN_HALF = 6.55;

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function smoothstep(e0, e1, x) {
  const t = clamp((x - e0) / (e1 - e0 || 1), 0, 1);
  return t * t * (3 - 2 * t);
}

function angDiff(a, b) {
  let d = a - b;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

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
function cLerp(a, b, t) {
  const u = clamp(t, 0, 1);
  if (a.length === 4 || b.length === 4) {
    return [
      a[0] + (b[0] - a[0]) * u,
      a[1] + (b[1] - a[1]) * u,
      a[2] + (b[2] - a[2]) * u,
      (a[3] ?? 1) + ((b[3] ?? 1) - (a[3] ?? 1)) * u,
    ];
  }
  return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
}

function makePaletteLinear(THREE) {
  const tmp = new THREE.Color();
  const lin = (hex) => {
    tmp.setHex(hex);
    return [tmp.r, tmp.g, tmp.b];
  };
  const out = {};
  for (const [k, hex] of Object.entries(HELLCAT_PALETTE)) out[k] = lin(hex);
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

  /** Smoothly loft a sequence of rings `{pts: [[x,y,z],...], cols: [[r,g,b],...]}` with smooth vertex normals. */
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

  /** Axis-aligned or transformed box with subtle vertical AO. */
  box(cx, cy, cz, hx, hy, hz, colTop, colBot = cShade(colTop, 0.82), xf = null) {
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

function wingZAt(xAbs) {
  return xAbs <= F6F_FOLD_X ? F6F_WING_Z : F6F_WING_Z + (xAbs - F6F_FOLD_X) * Math.tan(F6F_DIHEDRAL);
}

/** 1944 USNTricolor camouflage color for a fuselage/fin vertex at `(x, y, z)` with normal `nz`. */
function fuselageTricolor(P, x, y, z, nz = 0) {
  // Matte-black anti-glare nose panel ahead of windscreen
  if (y > 0.52 && y < 3.66 && z > F6F_ZC + 0.50 && Math.abs(x) < 0.44) {
    return P.antiGlare;
  }
  const hi = smoothstep(F6F_ZC + 0.24, F6F_ZC + 0.44, z + nz * 0.08);
  const lo = smoothstep(F6F_ZC - 0.50, F6F_ZC - 0.26, z + nz * 0.08);
  const belly = cLerp(P.insigniaWhite, P.intermediateBlue, lo);
  return cLerp(belly, P.seaBlue, hi);
}

/**
 * Emit a crisp 1944 USN White Star-and-Bars geometry appliqué decal offset 3-4.4 mm above a curved skin surface.
 * Automatically enforces outward CCW triangle winding relative to `normal`, and optionally conforms via `conformFn`.
 */
function addStarAndBars(acc, center, uAxis, vAxis, normal, radius, P, conformFn = null) {
  let u = vNorm(uAxis);
  const v = vNorm(vAxis);
  const n = vNorm(normal);
  const cr = vCross(u, v);
  if (cr[0] * n[0] + cr[1] * n[1] + cr[2] * n[2] < 0) u = vScale(u, -1);

  const pt = (du, dv, lift) => {
    const raw = [
      center[0] + u[0] * du + v[0] * dv,
      center[1] + u[1] * du + v[1] * dv,
      center[2] + u[2] * du + v[2] * dv,
    ];
    const base = conformFn ? conformFn(raw) : raw;
    return [base[0] + n[0] * lift, base[1] + n[1] * lift, base[2] + n[2] * lift];
  };
  const blueLift = 0.0032;
  const whiteLift = 0.0046;
  const rBlue = radius * 1.12;
  const barW = radius * 1.88;
  const barH = radius * 0.54;
  const barBorder = radius * 0.11;

  // 1. Dark Insignia Blue rectangular bar backing (subdivided across span/chord so it hugs curved camber) + 20-gon disc
  const subU = 4, subV = 2;
  const uMin = -barW - barBorder, uMax = barW + barBorder;
  const vMin = -barH * 0.5 - barBorder, vMax = barH * 0.5 + barBorder;
  for (let iu = 0; iu < subU; iu++) {
    const aU = uMin + ((uMax - uMin) * iu) / subU;
    const bU = uMin + ((uMax - uMin) * (iu + 1)) / subU;
    for (let iv = 0; iv < subV; iv++) {
      const aV = vMin + ((vMax - vMin) * iv) / subV;
      const bV = vMin + ((vMax - vMin) * (iv + 1)) / subV;
      acc.quad(
        pt(aU, aV, blueLift),
        pt(bU, aV, blueLift),
        pt(bU, bV, blueLift),
        pt(aU, bV, blueLift),
        P.insigniaBlue, P.insigniaBlue, P.insigniaBlue, P.insigniaBlue, n, n, n, n
      );
    }
  }
  const discSegs = 20;
  const cDisc = pt(0, 0, blueLift + 0.0003);
  for (let i = 0; i < discSegs; i++) {
    const a0 = (i / discSegs) * Math.PI * 2;
    const a1 = ((i + 1) / discSegs) * Math.PI * 2;
    acc.tri(
      cDisc,
      pt(Math.cos(a0) * rBlue, Math.sin(a0) * rBlue, blueLift + 0.0003),
      pt(Math.cos(a1) * rBlue, Math.sin(a1) * rBlue, blueLift + 0.0003),
      P.insigniaBlue, P.insigniaBlue, P.insigniaBlue, n, n, n
    );
  }

  // 2. Port & Starboard Insignia White horizontal bars
  for (const s of [-1, 1]) {
    const x0 = s > 0 ? radius * 0.88 : -barW;
    const x1 = s > 0 ? barW : -radius * 0.88;
    const xm = 0.5 * (x0 + x1);
    for (const [xa, xb] of [[x0, xm], [xm, x1]]) {
      acc.quad(
        pt(xa, -barH * 0.5, whiteLift),
        pt(xb, -barH * 0.5, whiteLift),
        pt(xb, barH * 0.5, whiteLift),
        pt(xa, barH * 0.5, whiteLift),
        P.starWhite, P.starWhite, P.starWhite, P.starWhite, n, n, n, n
      );
    }
  }

  // 3. Crisp 5-point Insignia White star (top point straight along +vAxis)
  const rInner = radius * 0.382;
  const cStar = pt(0, 0, whiteLift + 0.0004);
  const starPts = [];
  for (let i = 0; i < 10; i++) {
    const ang = Math.PI * 0.5 + (i * Math.PI) / 5;
    const rr = i % 2 === 0 ? radius : rInner;
    starPts.push(pt(Math.cos(ang) * rr, Math.sin(ang) * rr, whiteLift + 0.0004));
  }
  for (let i = 0; i < 10; i++) {
    acc.tri(cStar, starPts[i], starPts[(i + 1) % 10], P.starWhite, P.starWhite, P.starWhite, n, n, n);
  }
}

/** Build fuselage, smiling cowling, 18-cyl R-2800 Double Wasp, wings, 6 guns, tailplane/fin, cockpit tub & USN decals. */
function buildStaticAirframe(acc, P, profile) {
  // ---- 1. Lofted Grumman Pear-Bellied Fuselage & Tall Oval "Smiling" Cowling (y = -6.40 .. +3.72) ----
  // Cross-section stations: [y, halfWidth, zTopAboveZC, zBotBelowZC, smileChin, cockpitDip]
  const stations = [
    [-6.40, 0.11, 0.30, 0.16, 0.00, 0.0],
    [-5.85, 0.24, 0.38, 0.28, 0.00, 0.0],
    [-4.95, 0.38, 0.48, 0.46, 0.00, 0.0],
    [-3.85, 0.52, 0.62, 0.64, 0.00, 0.0],
    [-2.65, 0.63, 0.78, 0.80, 0.00, 0.0],
    [-1.45, 0.70, 0.90, 0.92, 0.00, 0.0],
    [-1.08, 0.72, 0.72, 0.96, 0.00, 0.30], // aft cockpit sill
    [-0.35, 0.74, 0.68, 0.98, 0.00, 0.34], // mid cockpit tub
    [0.38,  0.75, 0.74, 0.98, 0.00, 0.18], // forward cockpit / firewall
    [0.95,  0.76, 0.77, 0.97, 0.04, 0.0],
    [1.45,  0.77, 0.76, 0.96, 0.10, 0.0],  // cowl gill ring
    [2.15,  0.76, 0.75, 0.96, 0.18, 0.0],  // main R-2800 cowling
    [2.95,  0.73, 0.72, 0.94, 0.24, 0.0],  // forward cowling taper
    [3.52,  0.66, 0.66, 0.88, 0.26, 0.0],  // rolled cowling lip outer
    [3.72,  0.56, 0.56, 0.76, 0.22, 0.0],  // cowling mouth rim
  ];
  const ringSegs = 28;
  const fuseRings = stations.map(([y, hw, zt, zb, chin, dip]) => {
    const pts = [];
    const cols = [];
    for (let i = 0; i < ringSegs; i++) {
      // Angle 0 at top (+z), clockwise around +y (+x at PI/2, -z at PI)
      const a = (i / ringSegs) * Math.PI * 2;
      const sa = Math.sin(a), ca = Math.cos(a);
      // Pear-bellied Grumman section: slightly broader lower cheeks + deep chin scoop forward
      const pear = 1 + 0.11 * Math.max(0, -ca) * (1 - Math.abs(sa) * 0.35);
      let rx = hw * sa * pear;
      let rz = ca >= 0 ? zt * Math.pow(ca, 0.88) : -zb * Math.pow(-ca, 0.86);
      // Cockpit open cutout dip along top crown
      if (dip > 0 && ca > 0.58) {
        rz -= dip * smoothstep(0.58, 0.92, ca);
      }
      // Signature Grumman "smiling" lower chin oil-cooler lobe forward of firewall
      if (chin > 0 && ca < -0.45) {
        const uChin = smoothstep(-0.45, -0.95, ca);
        rz -= chin * 0.36 * uChin * (1 - 0.32 * sa * sa);
        rx *= 1 + 0.08 * uChin;
      }
      // Subtle recessed exhaust trough along lower-mid cowling cheeks (y = 1.4..2.3)
      let ao = 1.0;
      if (y >= 1.35 && y <= 2.35 && Math.abs(ca + 0.18) < 0.22 && Math.abs(sa) > 0.85) {
        rx *= 0.93;
        ao = 0.72;
      }
      const pz = F6F_ZC + rz;
      pts.push([rx, y, pz]);
      const baseCol = fuselageTricolor(P, rx, y, pz, ca * 0.5);
      cols.push(cShade(baseCol, ao * (0.86 + 0.14 * (0.5 + 0.5 * ca))));
    }
    return { pts, cols };
  });
  acc.loft(fuseRings, true);

  // Rolled inward cowling mouth baffle + "smiling" lower chin oil-cooler intake scoop (y = 3.72 -> 3.34)
  const mouthRim = fuseRings[fuseRings.length - 1];
  const mouthInnerPts = [];
  const mouthInnerCols = [];
  for (let i = 0; i < ringSegs; i++) {
    const a = (i / ringSegs) * Math.PI * 2;
    const sa = Math.sin(a), ca = Math.cos(a);
    const rx = 0.44 * sa;
    const rz = ca >= 0 ? 0.44 * ca : -0.58 * (-ca);
    mouthInnerPts.push([rx, 3.36, F6F_ZC + rz]);
    mouthInnerCols.push(cShade(P.antiGlare, 0.65));
  }
  acc.loft([mouthRim, { pts: mouthInnerPts, cols: mouthInnerCols }], true);
  // Dark recessed backplate behind R-2800 cylinders (seals fuselage interior cleanly)
  const cBack = [0, 2.58, F6F_ZC - 0.04];
  const nFwd = [0, 1, 0];
  for (let i = 0; i < ringSegs; i++) {
    const pA = mouthInnerPts[i], pB = mouthInnerPts[(i + 1) % ringSegs];
    acc.tri(cBack, [pA[0] * 1.25, 2.58, pA[2]], [pB[0] * 1.25, 2.58, pB[2]], P.antiGlare, P.antiGlare, P.antiGlare, nFwd, nFwd, nFwd);
  }
  // Horizontal "smiling" chin splitter lip separating upper radial engine opening from lower oil-cooler grin
  for (let seg = -4; seg < 4; seg++) {
    const u0 = seg / 4, u1 = (seg + 1) / 4;
    const x0 = u0 * 0.48, x1 = u1 * 0.48;
    const z0 = F6F_ZC - 0.48 + 0.11 * u0 * u0;
    const z1 = F6F_ZC - 0.48 + 0.11 * u1 * u1;
    acc.quad([x0, 3.40, z0 - 0.03], [x1, 3.40, z1 - 0.03], [x1, 3.71, z1 + 0.02], [x0, 3.71, z0 + 0.02], P.insigniaWhite, P.insigniaWhite, P.intermediateBlue, P.intermediateBlue);
    acc.quad([x0, 3.71, z0 + 0.02], [x1, 3.71, z1 + 0.02], [x1, 3.40, z1 + 0.05], [x0, 3.40, z0 + 0.05], P.intermediateBlue, P.intermediateBlue, P.antiGlare, P.antiGlare);
  }
  // Flared cowl cooling gill flaps around y = 1.42..1.62
  for (const side of [-1, 1]) {
    for (let g = 0; g < 4; g++) {
      const a0 = (0.32 + g * 0.24) * Math.PI * side;
      const a1 = a0 + 0.19 * Math.PI * side;
      const rIn = 0.75, rOut = 0.80;
      const p0 = [Math.sin(a0) * rIn, 1.66, F6F_ZC + Math.cos(a0) * rIn];
      const p1 = [Math.sin(a1) * rIn, 1.66, F6F_ZC + Math.cos(a1) * rIn];
      const p2 = [Math.sin(a1) * rOut, 1.38, F6F_ZC + Math.cos(a1) * rOut];
      const p3 = [Math.sin(a0) * rOut, 1.38, F6F_ZC + Math.cos(a0) * rOut];
      const gc = fuselageTricolor(P, p0[0], 1.5, p0[2]);
      acc.quad(p0, p1, p2, p3, gc, gc, cShade(gc, 0.88), cShade(gc, 0.88));
    }
  }

  // ---- 2. 18-Cylinder Twin-Row Pratt & Whitney R-2800 Double Wasp Radial Engine ----
  // Domed grey-blue reduction gear crankcase nose + prop shaft
  acc.tube([0, 2.75, F6F_ZC], [0, 3.28, F6F_ZC], 0.25, 0.22, 14, P.crankcaseGrey, P.crankcaseGrey, false, false);
  acc.tube([0, 3.28, F6F_ZC], [0, 3.55, F6F_ZC], 0.22, 0.10, 14, P.crankcaseGrey, cShade(P.crankcaseGrey, 1.12), false, true);
  acc.tube([0, 3.52, F6F_ZC], [0, 3.84, F6F_ZC], 0.065, 0.06, 10, P.silver, P.silver, false, false);
  // Twin front magnetos on upper crankcase
  for (const sx of [-1, 1]) {
    acc.tube([sx * 0.11, 3.24, F6F_ZC + 0.12], [sx * 0.13, 3.44, F6F_ZC + 0.15], 0.055, 0.042, 8, P.silver, P.crankcaseGrey, false, true);
  }
  // 9 Front + 9 Staggered Rear Gunmetal Finned Cylinder Barrels + Silver Pushrod Tubes
  for (let row = 0; row < 2; row++) {
    const cy = row === 0 ? 3.12 : 2.84;
    const phase = row === 0 ? 0 : 20 * DEG;
    for (let k = 0; k < 9; k++) {
      const ang = phase + (k / 9) * Math.PI * 2;
      const dx = Math.sin(ang), dz = Math.cos(ang);
      const rBase = 0.21, rHead = 0.49;
      const b0 = [dx * rBase, cy, F6F_ZC + dz * rBase];
      const bMid = [dx * (rBase + 0.18), cy, F6F_ZC + dz * (rBase + 0.18)];
      const bHead = [dx * rHead, cy, F6F_ZC + dz * rHead];
      acc.tube(b0, bMid, 0.088, 0.094, 8, P.cylinderGunmetal, cShade(P.cylinderGunmetal, 1.18), false, false);
      acc.tube(bMid, bHead, 0.098, 0.082, 8, cShade(P.silver, 0.72), P.silver, false, true);
      // Twin silver pushrod tubes on front row
      if (row === 0) {
        const pxOff = Math.cos(ang) * 0.032, pzOff = -Math.sin(ang) * 0.032;
        for (const ps of [-1, 1]) {
          acc.tube(
            [dx * 0.20 + ps * pxOff, 3.28, F6F_ZC + dz * 0.20 + ps * pzOff],
            [dx * 0.45 + ps * pxOff, cy + 0.04, F6F_ZC + dz * 0.45 + ps * pzOff],
            0.012, 0.012, 5, P.silver, P.silver, false, false
          );
        }
      }
    }
  }
  // 6 Stub Exhaust Stacks (x = ±0.72, y = 1.60..2.10, z = 2.45..2.58)
  for (const side of [-1, 1]) {
    for (let idx = 0; idx < 3; idx++) {
      const ey = 2.10 - idx * 0.25;
      const ez = 2.57 - idx * 0.05;
      acc.tube(
        [side * 0.66, ey + 0.10, ez + 0.02],
        [side * 0.76, ey - 0.12, ez - 0.02],
        0.042, 0.036, 8, P.exhaustBurnt, cShade(P.exhaustBurnt, 0.7), false, true
      );
    }
  }

  // ---- 3. Cockpit Tub, Seat Bucket, Flight Stick & Armored Pilot Headrest ----
  // Chromate-green cockpit tub floor & side walls
  acc.box(0, -0.35, 2.18, 0.48, 0.74, 0.05, P.chromateGreen);
  for (const side of [-1, 1]) {
    acc.box(side * 0.52, -0.35, 2.72, 0.05, 0.72, 0.48, P.chromateGreen, cShade(P.chromateGreen, 0.75));
    // Throttle / radio side console
    acc.box(side * 0.44, -0.22, 2.76, 0.07, 0.45, 0.08, P.antiGlare);
  }
  // Pilot bucket seat at SEAT = [0, -0.40, 2.34]
  acc.box(0, -0.42, 2.32, 0.28, 0.24, 0.04, P.chromateGreen);
  acc.box(0, -0.64, 2.66, 0.27, 0.04, 0.34, P.chromateGreen);
  // Control stick ahead of seat
  acc.tube([0, -0.10, 2.22], [0, -0.06, 2.78], 0.022, 0.018, 6, P.chromateGreen, P.antiGlare, false, true);
  // Tall armored rear cockpit bulkhead & padded pilot headrest
  acc.box(0, -0.86, 3.16, 0.34, 0.05, 0.46, P.chromateGreen, cShade(P.chromateGreen, 0.8));
  acc.box(0, -0.80, 3.58, 0.15, 0.06, 0.14, P.antiGlare);
  // Lower instrument panel sill inside fuselage (below windscreen arch z = 3.42)
  acc.box(0, 0.36, 3.16, 0.44, 0.10, 0.24, P.antiGlare);

  // ---- 4. Broad Grumman Vertical Fin, Dorsal Fillet & Horizontal Tailplane ----
  // Fixed vertical stabilizer fin + dorsal strake (sweeps up from y = -4.35 to fin post y = -6.05, z = 2.98..4.62)
  const finStations = [
    { z: 2.98, yLead: -4.25, yTrail: -6.05, hw: 0.13 },
    { z: 3.35, yLead: -5.05, yTrail: -6.05, hw: 0.095 },
    { z: 3.85, yLead: -5.36, yTrail: -6.05, hw: 0.072 },
    { z: 4.35, yLead: -5.62, yTrail: -6.05, hw: 0.050 },
    { z: 4.62, yLead: -5.80, yTrail: -6.04, hw: 0.024 },
  ];
  const finRings = finStations.map(({ z, yLead, yTrail, hw }) => {
    const ym = 0.5 * (yLead + yTrail), hc = 0.5 * (yLead - yTrail);
    // Ordered so tCirc × tLong (+Z) points OUTWARD on both port (-X) and starboard (+X) faces
    const pts = [
      [0, yLead, z],
      [-hw * 0.85, ym + hc * 0.42, z],
      [-hw, ym - hc * 0.15, z],
      [-hw * 0.65, yTrail, z],
      [hw * 0.65, yTrail, z],
      [hw, ym - hc * 0.15, z],
      [hw * 0.85, ym + hc * 0.42, z],
    ];
    const c = z > 4.15 ? P.seaBlue : P.intermediateBlue;
    return { pts, cols: pts.map(() => c) };
  });
  acc.loft(finRings, true);
  // Rounded fin crown cap (outward +Z normal)
  const topR = finRings[finRings.length - 1].pts;
  for (let i = 1; i < topR.length - 1; i++) acc.tri(topR[0], topR[i], topR[i + 1], P.seaBlue);

  // Horizontal stabilizer tailplane (port & starboard fixed airfoil forward of elevator hinge y = -6.18)
  for (const side of [-1, 1]) {
    const hSpan = [
      { x: 0.12, yL: -5.32, yT: -6.18, th: 0.095, z: 2.92 },
      { x: 1.25, yL: -5.50, yT: -6.18, th: 0.078, z: 2.92 },
      { x: 2.22, yL: -5.68, yT: -6.18, th: 0.055, z: 2.92 },
      { x: 2.48, yL: -5.82, yT: -6.14, th: 0.024, z: 2.92 },
    ];
    const rings = hSpan.map(({ x, yL, yT, th, z }) => {
      const sx = side * x;
      const ym = 0.5 * (yL + yT), hc = 0.5 * (yL - yT);
      const pts = [
        [sx, yL, z],
        [sx, ym + hc * 0.35, z + th],
        [sx, ym - hc * 0.35, z + th * 0.72],
        [sx, yT, z],
        [sx, ym - hc * 0.35, z - th * 0.68],
        [sx, ym + hc * 0.35, z - th * 0.90],
      ];
      if (side < 0) pts.reverse();
      const cols = pts.map((p) => (p[2] >= z + 0.005 ? P.seaBlue : p[2] <= z - 0.005 ? P.insigniaWhite : P.intermediateBlue));
      return { pts, cols };
    });
    acc.loft(rings, true);
  }
  // Ventral tail skeg bumper + radio antenna mast + fin tip stub
  acc.box(0, -5.78, 2.44, 0.035, 0.24, 0.12, P.insigniaWhite);
  acc.tube([0, -1.82, 3.56], [0, -1.98, 4.34], 0.026, 0.010, 6, P.seaBlue, P.silver, false, true);
  acc.tube([0, -5.88, 4.58], [0, -5.94, 4.78], 0.016, 0.008, 5, P.seaBlue, P.silver, false, true);

  // ---- 5. Low-Mid Cranked Grumman Wing (13.1 m span, 6.5° outboard dihedral) & 6× .50-Cal Wing Guns ----
  // Airfoil cross-section helper around local chord [yTrail..yLead] at span x
  const airfoilRing = (side, xAbs, yLead, yTrail, zBase, thick, walkStrip = false, wellBay = false) => {
    const sx = side * xAbs;
    const chord = yLead - yTrail;
    // 10-point NACA-23015 inspired section (cambered upper, flatter lower)
    const uProf = [
      [1.00, 0.000],
      [0.92, 0.285],
      [0.72, 0.495],
      [0.44, 0.460],
      [0.16, 0.245],
      [0.00, 0.000],
      [0.16, -0.185],
      [0.44, -0.340],
      [0.72, -0.370],
      [0.92, -0.220],
    ];
    const pts = [];
    const cols = [];
    for (let i = 0; i < uProf.length; i++) {
      const [uf, zf] = uProf[i];
      const py = yTrail + uf * chord;
      const pz = zBase + zf * thick;
      pts.push([sx, py, pz]);
      let c;
      if (walkStrip && zf > 0.15 && uf > 0.20 && uf < 0.85) {
        c = P.antiGlare;
      } else if (wellBay && zf < -0.12 && uf > 0.35 && uf < 0.88) {
        c = cShade(P.chromateGreen, 0.68);
      } else if (zf > 0.05) {
        c = P.seaBlue;
      } else if (zf < -0.05) {
        c = P.insigniaWhite;
      } else {
        c = P.intermediateBlue;
      }
      cols.push(c);
    }
    if (side < 0) {
      pts.reverse();
      cols.reverse();
    }
    return { pts, cols };
  };

  for (const side of [-1, 1]) {
    // Wing stations from root fillet (x = 0.58) -> flat fold knuckle (2.05) -> 6.5° dihedral outer panel -> squared Grumman tip (6.55)
    // Note trailing edge is recessed slightly forward of flaps/ailerons (hinge line ~ -0.48..0.02) so control surfaces nest flush!
    const wingSpec = [
      [0.58, 1.98, -0.78, F6F_WING_Z + 0.05, 0.50, false, false],
      [0.80, 1.92, -0.52, F6F_WING_Z + 0.01, 0.43, true,  false],
      [1.14, 1.90, -0.52, F6F_WING_Z,        0.41, true,  true],
      [1.98, 1.88, -0.50, F6F_WING_Z,        0.39, false, true],
      [2.05, 1.87, -0.50, F6F_WING_Z,        0.38, false, false], // Sto-Wing fold seam
      [2.12, 1.87, -0.49, wingZAt(2.12),     0.38, false, false],
      [3.35, 1.74, -0.36, wingZAt(3.35),     0.32, false, false],
      [4.20, 1.62, -0.24, wingZAt(4.20),     0.27, false, false],
      [5.45, 1.44, -0.06, wingZAt(5.45),     0.21, false, false],
      [6.22, 1.28,  0.10, wingZAt(6.22),     0.15, false, false],
      [6.50, 1.08,  0.24, wingZAt(6.50),     0.09, false, false],
      [6.55, 0.88,  0.40, wingZAt(6.55),     0.04, false, false], // Squared-rounded Grumman tip
    ];
    const wRings = wingSpec.map(([x, yL, yT, zB, th, walk, well]) => {
      const r = airfoilRing(side, x, yL, yT, zB, th, walk, well);
      // Darken Sto-Wing fold seam slightly for crisp panel definition
      if (Math.abs(x - F6F_FOLD_X) < 0.01) r.cols = r.cols.map((c) => cShade(c, 0.78));
      return r;
    });
    acc.loft(wRings, true);
    // Cap wingtip cleanly
    const tipPts = wRings[wRings.length - 1].pts;
    const tipN = [side, 0, 0];
    for (let i = 1; i < tipPts.length - 1; i++) {
      acc.tri(tipPts[0], tipPts[i], tipPts[i + 1], P.seaBlue, P.seaBlue, P.intermediateBlue, tipN, tipN, tipN);
    }
    // Wingtip nav light lens cap (Port Red / Starboard Green)
    const navCol = side < 0 ? P.navRed : P.navGreen;
    acc.tube([side * 6.50, 0.78, wingZAt(6.50)], [side * 6.56, 0.68, wingZAt(6.55)], 0.032, 0.018, 6, navCol, navCol, true, true);
  }

  // Starboard L-shaped Pitot Mast under outer starboard wing
  acc.tube([5.32, 0.92, wingZAt(5.32) - 0.06], [5.32, 0.90, wingZAt(5.32) - 0.24], 0.016, 0.013, 6, P.insigniaWhite, P.seaBlue, false, true);
  acc.tube([5.32, 0.88, wingZAt(5.32) - 0.23], [5.32, 1.56, wingZAt(5.32) - 0.23], 0.013, 0.007, 6, P.silver, P.silver, true, true);

  // 6× Steel AN/M2 .50-cal Wing Gun Blast Barrels + Underside Shell-Ejection Chutes
  const gunXs = [-3.05, -2.75, -2.45, 2.45, 2.75, 3.05];
  for (let gi = 0; gi < 6; gi++) {
    const gx = gunXs[gi];
    const gz = wingZAt(Math.abs(gx)) + 0.015;
    const yLead = 1.84 - (Math.abs(gx) - 2.05) * 0.11;
    acc.tube([gx, yLead - 0.12, gz], [gx, yLead + 0.30, gz], 0.028, 0.024, 8, P.cylinderGunmetal, P.silver, false, true);
    // Underside shell-ejection slot
    acc.box(gx, 0.88, gz - 0.135, 0.022, 0.09, 0.008, P.antiGlare, P.antiGlare);
  }

  // Tailcone white strobe lens housing
  acc.tube([0, -6.34, 2.95], [0, -6.43, 2.96], 0.028, 0.016, 6, P.strobeWhite, P.strobeWhite, false, true);

  // Static ordnance pylons & bomb sway braces (stay on wing/belly after ordnance release)
  const ws = profile?.weapons || [];
  for (let wi = 0; wi < ws.length; wi++) {
    const w = ws[wi];
    if (!w || !Array.isArray(w.muzzle)) continue;
    const [mx, my, mz] = w.muzzle;
    if (w.kind === 2) {
      const wz = wingZAt(Math.abs(mx));
      acc.box(mx, my - 0.68, 0.5 * (wz + mz) + 0.04, 0.022, 0.24, Math.max(0.05, 0.5 * Math.abs(wz - mz)), P.insigniaWhite);
    } else if (w.kind === 3) {
      const zAttach = Math.abs(mx) < 0.5 ? F6F_ZC - 0.94 : wingZAt(Math.abs(mx)) - 0.12;
      acc.box(mx, my, 0.5 * (zAttach + mz) + 0.10, 0.035, 0.28, Math.max(0.06, 0.5 * Math.abs(zAttach - mz) - 0.08), P.insigniaWhite);
    }
  }

  // ---- 6. Four Authentic 1944 USN White Star-and-Bars Geometry Appliqué Insignia ----
  const cDih = Math.cos(F6F_DIHEDRAL), sDih = Math.sin(F6F_DIHEDRAL);
  const sampleProfile = (tbl, uf) => {
    const u = clamp(uf, 0, 1);
    for (let i = 0; i < tbl.length - 1; i++) {
      const [u0, z0] = tbl[i], [u1, z1] = tbl[i + 1];
      if (u <= u0 && u >= u1) return z1 + ((u - u1) / (u0 - u1 || 1)) * (z0 - z1);
    }
    return 0;
  };
  const upperTbl = [[1.0, 0], [0.92, 0.285], [0.72, 0.495], [0.44, 0.460], [0.16, 0.245], [0.0, 0]];
  const lowerTbl = [[1.0, 0], [0.92, -0.220], [0.72, -0.370], [0.44, -0.340], [0.16, -0.185], [0.0, 0]];
  const conformWing = (isUpper) => ([px, py]) => {
    const xa = clamp(Math.abs(px), 2.12, 6.22);
    const yL = xa <= 4.20 ? 1.87 - ((xa - 2.12) / 2.08) * 0.25 : 1.62 - ((xa - 4.20) / 2.02) * 0.34;
    const yT = xa <= 4.20 ? -0.49 + ((xa - 2.12) / 2.08) * 0.25 : -0.24 + ((xa - 4.20) / 2.02) * 0.34;
    const th = xa <= 4.20 ? 0.38 - ((xa - 2.12) / 2.08) * 0.11 : 0.27 - ((xa - 4.20) / 2.02) * 0.12;
    const uf = (py - yT) / (yL - yT || 1);
    const zf = sampleProfile(isUpper ? upperTbl : lowerTbl, uf);
    return [px, py, wingZAt(xa) + zf * th];
  };
  const conformFuse = (side) => ([, py, pz]) => {
    const yc = clamp(py, -4.95, -1.45);
    let hw = 0.50, zt = 0.60, zb = 0.62;
    for (let i = 0; i < stations.length - 1; i++) {
      if (yc >= stations[i][0] && yc <= stations[i + 1][0]) {
        const t = (yc - stations[i][0]) / (stations[i + 1][0] - stations[i][0] || 1);
        hw = stations[i][1] + (stations[i + 1][1] - stations[i][1]) * t;
        zt = stations[i][2] + (stations[i + 1][2] - stations[i][2]) * t;
        zb = stations[i][3] + (stations[i + 1][3] - stations[i][3]) * t;
        break;
      }
    }
    const rz = pz - F6F_ZC;
    const ca = rz >= 0 ? clamp(Math.pow(rz / (zt || 1), 1 / 0.88), 0, 0.96) : -clamp(Math.pow(-rz / (zb || 1), 1 / 0.86), 0, 0.96);
    const sa = Math.sqrt(Math.max(0.04, 1 - ca * ca));
    const pear = 1 + 0.11 * Math.max(0, -ca) * (1 - sa * 0.35);
    return [side * hw * sa * pear, py, pz];
  };

  // Port upper outer wing (x = -4.30, y = 0.68)
  addStarAndBars(acc, [-4.30, 0.68, wingZAt(4.30) + 0.12], [cDih, 0, -sDih], [0, 1, 0], [sDih, 0, cDih], 0.48, P, conformWing(true));
  // Starboard lower outer wing (x = +4.30, y = 0.68)
  addStarAndBars(acc, [4.30, 0.68, wingZAt(4.30) - 0.09], [cDih, 0, sDih], [0, 1, 0], [sDih, 0, -cDih], 0.48, P, conformWing(false));
  // Port aft fuselage side (y = -3.35, z = 2.74)
  addStarAndBars(acc, [-0.52, -3.35, 2.74], [0, 1, 0], [0, 0, 1], [-0.99, -0.12, 0.04], 0.34, P, conformFuse(-1));
  // Starboard aft fuselage side (y = -3.35, z = 2.74)
  addStarAndBars(acc, [0.52, -3.35, 2.74], [0, 1, 0], [0, 0, 1], [0.99, -0.12, 0.04], 0.34, P, conformFuse(1));
}

/** Fixed armored front windscreen + instrument coaming + illuminated Mk 8 Reflector Gunsight (RGBA vertex colors). */
function buildWindscreenAndSight(P) {
  const acc = new GeomAcc(4);
  const cGlass = [0.62, 0.79, 0.88, 0.24];
  const cCombiner = [0.66, 0.90, 0.80, 0.20];
  const cFrame = [P.seaBlue[0], P.seaBlue[1], P.seaBlue[2], 0.99];
  const cCoam = [P.antiGlare[0], P.antiGlare[1], P.antiGlare[2], 1.0];
  const cDial = [P.insigniaWhite[0], P.insigniaWhite[1], P.insigniaWhite[2], 1.0];
  const cAmber = [P.reticleAmber[0], P.reticleAmber[1], P.reticleAmber[2], 0.96];

  // 1. Tinted glass panels FIRST (painter's order inside transparent mesh)
  // Flat armored bulletproof front glass pane (spans z = 3.43..3.80 right across sightline z = 3.58!)
  const fbL = [-0.21, 0.56, 3.43], fbR = [0.21, 0.56, 3.43];
  const ftL = [-0.18, 0.06, 3.81], ftR = [0.18, 0.06, 3.81];
  acc.quad(fbL, fbR, ftR, ftL, cGlass);
  acc.quad(fbR, fbL, ftL, ftR, cGlass);
  // Port & starboard angled quarter windscreen panes
  for (const s of [-1, 1]) {
    const q0 = [s * 0.21, 0.56, 3.43], q1 = [s * 0.44, 0.20, 3.36];
    const q2 = [s * 0.38, 0.02, 3.66], q3 = [s * 0.18, 0.06, 3.81];
    if (s > 0) {
      acc.quad(q0, q1, q2, q3, cGlass);
      acc.quad(q1, q0, q3, q2, cGlass);
    } else {
      acc.quad(q1, q0, q3, q2, cGlass);
      acc.quad(q0, q1, q2, q3, cGlass);
    }
  }
  // Mk 8 Reflector Gunsight angled combiner glass centered at [0, 0.25, 3.58]
  const cg0 = [-0.055, 0.29, 3.53], cg1 = [0.055, 0.29, 3.53];
  const cg2 = [0.055, 0.21, 3.63], cg3 = [-0.055, 0.21, 3.63];
  acc.quad(cg0, cg1, cg2, cg3, cCombiner);
  acc.quad(cg1, cg0, cg3, cg2, cCombiner);

  // 2. Opaque coaming, flight instruments, Mk 8 sight body & armored Sea-Blue windscreen frame arches
  acc.box(0, 0.40, 3.36, 0.40, 0.16, 0.08, cCoam, cCoam);
  // 5 crisp flight instrument dials on rear face of coaming (y = 0.238)
  for (const [dx, dz, r] of [[-0.22, 3.36, 0.036], [-0.11, 3.38, 0.040], [0, 3.39, 0.044], [0.11, 3.38, 0.040], [0.22, 3.36, 0.036]]) {
    const nAft = [0, -1, 0];
    const c0 = [dx, 0.236, dz];
    for (let i = 0; i < 10; i++) {
      const a0 = (i / 10) * Math.PI * 2, a1 = ((i + 1) / 10) * Math.PI * 2;
      acc.tri(c0, [dx + Math.cos(a0) * r, 0.236, dz + Math.sin(a0) * r], [dx + Math.cos(a1) * r, 0.236, dz + Math.sin(a1) * r], cDial, cDial, cDial, nAft, nAft, nAft);
    }
  }
  // Mk 8 Reflector Sight projector body beneath combiner
  acc.box(0, 0.27, 3.47, 0.062, 0.075, 0.045, cCoam, cCoam);
  // Windscreen armored frame pillars & top brow arch
  for (const s of [-1, 1]) {
    acc.tube([s * 0.21, 0.56, 3.43], [s * 0.18, 0.06, 3.81], 0.020, 0.018, 6, cFrame, cFrame, true, true);
    acc.tube([s * 0.44, 0.20, 3.36], [s * 0.38, 0.02, 3.66], 0.018, 0.016, 6, cFrame, cFrame, true, true);
    acc.tube([s * 0.38, 0.02, 3.66], [s * 0.18, 0.06, 3.81], 0.016, 0.016, 6, cFrame, cFrame, false, false);
  }
  acc.tube([-0.19, 0.06, 3.81], [0.19, 0.06, 3.81], 0.019, 0.019, 6, cFrame, cFrame, true, true);
  acc.tube([-0.22, 0.56, 3.43], [0.22, 0.56, 3.43], 0.018, 0.018, 6, cFrame, cFrame, true, true);

  // 3. Illuminated Mk 8 Amber Reticle Ring + Pipper centered at [0, 0.25, 3.58] (pilot eye z ≈ 3.58 looks straight through!)
  const rc = [0, 0.246, 3.58];
  const rIn = 0.032, rOut = 0.037;
  const segs = 16;
  for (let i = 0; i < segs; i++) {
    const a0 = (i / segs) * Math.PI * 2, a1 = ((i + 1) / segs) * Math.PI * 2;
    const p0 = [Math.cos(a0) * rIn, rc[1] - Math.sin(a0) * 0.008, rc[2] + Math.sin(a0) * rIn];
    const p1 = [Math.cos(a0) * rOut, rc[1] - Math.sin(a0) * 0.009, rc[2] + Math.sin(a0) * rOut];
    const p2 = [Math.cos(a1) * rOut, rc[1] - Math.sin(a1) * 0.009, rc[2] + Math.sin(a1) * rOut];
    const p3 = [Math.cos(a1) * rIn, rc[1] - Math.sin(a1) * 0.008, rc[2] + Math.sin(a1) * rIn];
    acc.quad(p0, p1, p2, p3, cAmber);
    acc.quad(p1, p0, p3, p2, cAmber);
  }
  // Central amber pipper dot
  acc.box(0, rc[1], rc[2], 0.004, 0.002, 0.004, cAmber, cAmber);
  return acc;
}

/** Sliding glazed F6F-5 rear greenhouse/bubble canopy (RGBA vertex colors: glass 0.28 first, Sea-Blue arches 0.98 second). */
function buildSlidingCanopy(P) {
  const acc = new GeomAcc(4);
  const cGlass = [0.64, 0.80, 0.88, 0.28];
  const cFrame = [P.seaBlue[0], P.seaBlue[1], P.seaBlue[2], 0.98];

  // Canopy profile stations from forward arch (y = +0.04) back to turtledeck fairing (y = -1.14)
  const stations = [
    [0.04,  0.41, 3.36, 3.81],
    [-0.34, 0.42, 3.35, 3.83],
    [-0.74, 0.39, 3.36, 3.79],
    [-1.14, 0.31, 3.40, 3.68],
  ];
  const archPts = ([y, hw, zBase, zTop]) => {
    const out = [];
    const n = 9;
    for (let i = 0; i <= n; i++) {
      const u = (i / n) * Math.PI; // 0 (port sill) -> PI/2 (crown) -> PI (starboard sill)
      const x = -Math.cos(u) * hw;
      const z = zBase + Math.sin(u) * (zTop - zBase);
      out.push([x, y, z]);
    }
    return out;
  };
  const rings = stations.map((st) => {
    const pts = archPts(st);
    return { pts, cols: pts.map(() => cGlass) };
  });
  // Emit both outer and inner glass faces first
  acc.loft(rings, false);
  const revRings = rings.map((r) => ({ pts: [...r.pts].reverse(), cols: r.pts.map(() => cGlass) }));
  acc.loft(revRings, false);

  // Sea-Blue canopy frame arches + longitudinal waist & crown rails
  for (const r of rings) {
    for (let i = 0; i < r.pts.length - 1; i++) {
      acc.tube(r.pts[i], r.pts[i + 1], 0.015, 0.015, 5, cFrame, cFrame, false, false);
    }
  }
  for (const idx of [0, 2, 4, 5, 7, 9]) {
    for (let s = 0; s < rings.length - 1; s++) {
      acc.tube(rings[s].pts[idx], rings[s + 1].pts[idx], 0.015, 0.014, 5, cFrame, cFrame, true, true);
    }
  }
  return acc;
}

/** 3-Blade Hamilton Standard Paddle Propeller + Brushed Aluminum Dome Hub (in HUB-local frame). */
function buildPropellerSolid(P) {
  const acc = new GeomAcc(3);
  // Brushed aluminum hub dome + pitch collar
  acc.tube([0, -0.10, 0], [0, 0.08, 0], 0.19, 0.20, 14, cShade(P.silver, 0.80), P.silver, true, false);
  acc.tube([0, 0.08, 0], [0, 0.25, 0], 0.20, 0.09, 14, P.silver, cShade(P.silver, 1.08), false, true);
  acc.tube([0, 0.25, 0], [0, 0.31, 0], 0.09, 0.02, 10, P.silver, P.silver, false, true);

  // 3 Twisted Matte-Black Hamilton Standard Paddle Blades (120° spacing) with Insignia Yellow (#f6c324) Tips
  const bladeR = 1.96;
  const bladeStations = [
    [0.18, 0.055, 0.032, 36 * DEG, P.silver],
    [0.38, 0.115, 0.026, 33 * DEG, P.propBlack],
    [0.78, 0.168, 0.020, 28 * DEG, P.propBlack],
    [1.26, 0.176, 0.015, 22 * DEG, P.propBlack],
    [1.68, 0.148, 0.011, 17 * DEG, P.propBlack],
    [1.72, 0.142, 0.010, 16.5 * DEG, P.propYellow], // crisp yellow tip start
    [1.90, 0.105, 0.008, 15 * DEG, P.propYellow],
    [bladeR, 0.048, 0.005, 14 * DEG, P.propYellow],
  ];

  for (let b = 0; b < 3; b++) {
    const az = (b * 2 * Math.PI) / 3;
    const ca = Math.cos(az), sa = Math.sin(az);
    // Radial axis uR = [sa, 0, ca], tangential chord axis uT = [ca, 0, -sa], axial thrust +y = [0, 1, 0]
    const bRings = bladeStations.map(([r, halfChord, halfThick, twist, col]) => {
      const ct = Math.cos(twist), st = Math.sin(twist);
      const prof = [
        [1.0, 0.0],
        [0.35, 1.0],
        [-0.45, 0.85],
        [-1.0, 0.0],
        [-0.45, -0.65],
        [0.35, -0.75],
      ];
      const pts = prof.map(([uc, ut]) => {
        const cOff = uc * halfChord;
        const tOff = ut * halfThick;
        const tang = cOff * ct - tOff * st;
        const fwd = cOff * st + tOff * ct;
        return [sa * r + ca * tang, fwd, ca * r - sa * tang];
      });
      return { pts, cols: pts.map(() => col) };
    });
    acc.loft(bRings, true);
    const tip = bRings[bRings.length - 1].pts;
    for (let i = 1; i < tip.length - 1; i++) acc.tri(tip[0], tip[i], tip[i + 1], P.propYellow);
  }
  return acc;
}

/** Procedural RGBA DataTexture for the Hamilton Standard 3-blade prop blur disc (subtle 3-blade strobe + yellow tip arc). */
function makePropDiscTexture(THREE, n = 64) {
  const data = new Uint8Array(n * n * 4);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = ((i + 0.5) / n) * 2 - 1;
      const y = ((j + 0.5) / n) * 2 - 1;
      const r = Math.hypot(x, y);
      const k = (j * n + i) * 4;
      if (r < 0.11 || r > 1.0) {
        data[k] = data[k + 1] = data[k + 2] = data[k + 3] = 0;
        continue;
      }
      const ang = Math.atan2(y, x);
      const lobe = 0.62 + 0.38 * Math.cos(3 * ang);
      if (r >= 0.875) {
        // Vivid Insignia Yellow (#f6c324) outer tip arc
        const rim = smoothstep(1.0, 0.955, r) * smoothstep(0.865, 0.895, r);
        data[k] = 246;
        data[k + 1] = 195;
        data[k + 2] = 36;
        data[k + 3] = Math.round(clamp(rim * (0.72 + 0.28 * lobe), 0, 1) * 255);
      } else {
        // Soft dark 3-blade strobe wash
        const body = smoothstep(0.11, 0.22, r) * smoothstep(0.90, 0.72, r) * lobe;
        data[k] = 28;
        data[k + 1] = 31;
        data[k + 2] = 35;
        data[k + 3] = Math.round(clamp(body * 0.82, 0, 1) * 255);
      }
    }
  }
  const tex = new THREE.DataTexture(data, n, n, THREE.RGBAFormat);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

function makeRadialGlowTexture(THREE, n = 64) {
  const data = new Uint8Array(n * n * 4);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = ((i + 0.5) / n) * 2 - 1;
      const y = ((j + 0.5) / n) * 2 - 1;
      const r = Math.hypot(x, y);
      const a = Math.pow(Math.max(0, 1 - r), 1.85);
      const k = (j * n + i) * 4;
      data[k] = data[k + 1] = data[k + 2] = 255;
      data[k + 3] = Math.round(a * 255);
    }
  }
  const tex = new THREE.DataTexture(data, n, n, THREE.RGBAFormat);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

function buildPropDiscGeometry(THREE, radius = 1.96) {
  const acc = new GeomAcc(3, true);
  const w = [1, 1, 1];
  const n = [0, 1, 0];
  const p0 = [-radius, 0.02, -radius], p1 = [radius, 0.02, -radius];
  const p2 = [radius, 0.02, radius], p3 = [-radius, 0.02, radius];
  acc.tri(p0, p1, p2, w, w, w, n, n, n, [0, 0], [1, 0], [1, 1]);
  acc.tri(p0, p2, p3, w, w, w, n, n, n, [0, 0], [1, 1], [0, 1]);
  return acc.toBufferGeometry(THREE);
}

/** Build one Grumman Twist-and-Turn main gear leg in local pivot frame `[side * 1.92, 1.20, 2.02]` (axle at z = -1.55, tire r = 0.47 -> touches z = 0!). */
function buildMainGearLeg(P, side) {
  const acc = new GeomAcc(3);
  const zAxle = -1.55;
  const rTire = 0.47;
  // Upper Insignia White oleo strut + lower chromed shock piston
  acc.tube([0, 0, 0], [0, 0, -0.96], 0.056, 0.050, 10, P.insigniaWhite, P.insigniaWhite, true, true);
  acc.tube([0, 0, -0.94], [0, 0, zAxle], 0.038, 0.036, 10, P.silver, P.silver, false, true);
  // Diagonal drag brace & V-shaped torque-link scissors (aft of strut)
  acc.tube([-side * 0.34, -0.34, -0.10], [0, 0, -0.86], 0.028, 0.024, 6, P.insigniaWhite, P.insigniaWhite, true, true);
  acc.tube([0, -0.03, -0.88], [0, -0.19, -1.20], 0.020, 0.016, 6, P.insigniaWhite, P.insigniaWhite, true, true);
  acc.tube([0, -0.19, -1.20], [0, -0.03, -1.48], 0.016, 0.020, 6, P.insigniaWhite, P.insigniaWhite, true, true);
  // Axle stub
  acc.tube([0, 0, zAxle], [side * 0.22, 0, zAxle], 0.042, 0.040, 8, P.insigniaWhite, P.silver, true, true);

  // Grooved rubber Goodyear tire (torus-like multi-ring profile around X axis at [side * 0.14, 0, zAxle]) + Insignia White dished hub
  const wx = side * 0.14;
  const wHalf = 0.135;
  const wheelSegs = 18;
  const tireStations = [
    [-wHalf, 0.22, P.insigniaWhite],
    [-wHalf - 0.01, 0.25, P.tireRubber],
    [-wHalf * 0.72, rTire * 0.94, cShade(P.tireRubber, 0.88)],
    [0, rTire, P.tireRubber],
    [wHalf * 0.72, rTire * 0.94, cShade(P.tireRubber, 0.88)],
    [wHalf + 0.01, 0.25, P.tireRubber],
    [wHalf, 0.22, P.insigniaWhite],
  ];
  const wRings = tireStations.map(([dx, rad, col]) => {
    const pts = [];
    for (let i = 0; i < wheelSegs; i++) {
      const a = (i / wheelSegs) * Math.PI * 2;
      pts.push([wx + dx, Math.cos(a) * rad, zAxle + Math.sin(a) * rad]);
    }
    return { pts, cols: pts.map(() => col) };
  });
  acc.loft(wRings, true);
  // White wheel hub caps on both sides
  for (const sgn of [-1, 1]) {
    const hx = wx + sgn * wHalf;
    const hCenter = [hx + sgn * 0.018, 0, zAxle];
    const hNorm = [sgn, 0, 0];
    const ring = wRings[sgn < 0 ? 0 : wRings.length - 1].pts;
    for (let i = 0; i < wheelSegs; i++) {
      const pA = ring[i], pB = ring[(i + 1) % wheelSegs];
      if (sgn > 0) acc.tri(hCenter, pA, pB, P.insigniaWhite, P.insigniaWhite, P.silver, hNorm, hNorm, hNorm);
      else acc.tri(hCenter, pB, pA, P.insigniaWhite, P.insigniaWhite, P.silver, hNorm, hNorm, hNorm);
    }
  }

  // Captive outer main-gear fairing door
  acc.box(side * 0.09, 0.02, -0.68, 0.016, 0.21, 0.56, P.insigniaWhite, P.insigniaWhite);
  return acc;
}

/** Tailwheel strut + fork + tire in local pivot `[0, -5.65, 1.82]` (tire touches z = 1.37 at y = -5.85 -> flush with z_world = 0 at 11° pitch!). */
function buildTailGear(P) {
  const acc = new GeomAcc(3);
  acc.tube([0, 0, 0], [0, -0.20, -0.31], 0.028, 0.022, 8, P.insigniaWhite, P.silver, true, true);
  // Tailwheel tire (center [0, -0.20, -0.31], radius 0.14 -> bottom at z_local = -0.45 => z = 1.82 - 0.45 = 1.37!)
  acc.tube([-0.045, -0.20, -0.31], [0.045, -0.20, -0.31], 0.14, 0.14, 14, P.tireRubber, P.tireRubber, true, true);
  acc.tube([-0.052, -0.20, -0.31], [0.052, -0.20, -0.31], 0.065, 0.065, 10, P.insigniaWhite, P.insigniaWhite, true, true);
  return acc;
}

/** Articulated control surfaces (`aileronL`, `aileronR`, `elevator`, `rudder`, `flaps`, `tailhook`). */
function buildControlSurfaces(P) {
  // 1. Ailerons (in tilted 6.5°-dihedral hinge frame at [side * 5.18, -0.14, wingZAt(5.18)], span ±0.96, trailing edge aft -0.34)
  const makeAileron = (side) => {
    const acc = new GeomAcc(3);
    const spans = [-0.96, 0.96];
    const rings = spans.map((lx) => {
      const chord = side * lx > 0 ? 0.28 : 0.36;
      const th = side * lx > 0 ? 0.042 : 0.058;
      const pts = [
        [lx, 0.02, 0],
        [lx, -0.06, th],
        [lx, -chord, 0],
        [lx, -0.06, -th * 0.85],
      ];
      const cols = [P.intermediateBlue, P.seaBlue, P.seaBlue, P.insigniaWhite];
      return { pts, cols };
    });
    acc.loft(rings, true);
    for (const end of [0, 1]) {
      const p = rings[end].pts;
      if (end === 1) acc.quad(p[0], p[1], p[2], p[3], P.seaBlue);
      else acc.quad(p[3], p[2], p[1], p[0], P.seaBlue);
    }
    return acc;
  };

  // 2. Elevator (both port & starboard halves hinged at [0, -6.18, 2.92])
  const elevAcc = new GeomAcc(3);
  for (const side of [-1, 1]) {
    const xs = [0.14, 1.30, 2.18, 2.44];
    const rings = xs.map((x, idx) => {
      const sx = side * x;
      const ch = idx === 3 ? 0.24 : 0.48 - idx * 0.06;
      const th = idx === 3 ? 0.018 : 0.048 - idx * 0.009;
      const pts = [
        [sx, 0.02, 0],
        [sx, -0.08, th],
        [sx, -ch, 0],
        [sx, -0.08, -th],
      ];
      if (side < 0) pts.reverse();
      const cols = pts.map((pt) => (pt[2] > 0.004 ? P.seaBlue : pt[2] < -0.004 ? P.insigniaWhite : P.intermediateBlue));
      return { pts, cols };
    });
    elevAcc.loft(rings, true);
  }

  // 3. Rudder (hinged along vertical post [0, -6.05, 3.00], extending up to z_local = +1.60 and aft -0.62)
  const rudAcc = new GeomAcc(3);
  const rudSpec = [
    [0.00, 0.34, 0.050],
    [0.35, 0.56, 0.056],
    [0.85, 0.62, 0.048],
    [1.30, 0.52, 0.036],
    [1.60, 0.28, 0.018],
  ];
  const rudRings = rudSpec.map(([z, ch, hw]) => {
    const pts = [
      [0, 0.02, z],
      [-hw, -0.10, z],
      [0, -ch, z],
      [hw, -0.10, z],
    ];
    const c = z > 1.15 ? P.seaBlue : P.intermediateBlue;
    return { pts, cols: [c, c, c, c] };
  });
  rudAcc.loft(rudRings, true);
  const rt = rudRings[rudRings.length - 1].pts;
  rudAcc.quad(rt[0], rt[1], rt[2], rt[3], P.seaBlue);

  // 4. Slotted Flaps (port & starboard inboard + mid outer panels, hinged around [0, -0.46, 2.02])
  const flapAcc = new GeomAcc(3);
  for (const side of [-1, 1]) {
    const fStations = [
      [0.82, 0.04, 0.44, 0.062],
      [2.04, 0.04, 0.42, 0.058],
      [2.10, 0.05, 0.41, 0.056],
      [4.12, 0.28, 0.34, 0.046],
    ];
    const fRings = fStations.map(([x, dz, ch, th]) => {
      const sx = side * x;
      const pts = [
        [sx, 0.02, dz],
        [sx, -0.06, dz + th],
        [sx, -ch, dz - 0.02],
        [sx, -0.06, dz - th * 0.85],
      ];
      if (side < 0) pts.reverse();
      const cols = pts.map((pt) => (pt[2] > dz + 0.005 ? P.seaBlue : pt[2] < dz - 0.005 ? P.insigniaWhite : P.intermediateBlue));
      return { pts, cols };
    });
    flapAcc.loft(fRings, true);
  }

  // 5. Striped Carrier Arrestor Tailhook (hinged at [0, -5.42, 2.45], extending aft 1.02 m)
  const hookAcc = new GeomAcc(3);
  const stripes = 6;
  for (let i = 0; i < stripes; i++) {
    const y0 = -(i / stripes) * 0.94;
    const y1 = -((i + 1) / stripes) * 0.94;
    const col = i % 2 === 0 ? P.starWhite : P.antiGlare;
    hookAcc.tube([0, y0, 0], [0, y1, -0.03 * ((i + 1) / stripes)], 0.022, 0.020, 6, col, col, i === 0, false);
  }
  // Forged steel arrestor hook claw at tip
  hookAcc.tube([0, -0.94, -0.03], [0, -1.03, -0.10], 0.022, 0.018, 6, P.cylinderGunmetal, P.silver, false, true);
  hookAcc.tube([0, -1.03, -0.10], [0, -0.97, -0.14], 0.018, 0.012, 6, P.silver, P.silver, false, true);

  return {
    aileronL: makeAileron(-1),
    aileronR: makeAileron(1),
    elevator: elevAcc,
    rudder: rudAcc,
    flaps: flapAcc,
    tailhook: hookAcc,
  };
}

/** Build 1 merged 5-inch HVAR ("Holy Moses") rocket mesh at `muzzle` in vehicle frame. */
function buildHvarRocket(P, muzzle) {
  const acc = new GeomAcc(3);
  const [mx, my, mz] = muzzle;
  const r = 0.064;
  // Olive-drab ogive warhead with white identification band (tip at my + 0.16, body back to my - 1.48)
  acc.tube([mx, my + 0.04, mz], [mx, my + 0.18, mz], r * 0.55, 0.010, 10, P.oliveDrab, P.silver, false, true);
  acc.tube([mx, my - 0.16, mz], [mx, my + 0.04, mz], r, r * 0.55, 10, P.oliveDrab, P.oliveDrab, false, false);
  acc.tube([mx, my - 0.26, mz], [mx, my - 0.16, mz], r, r, 10, P.starWhite, P.starWhite, false, false);
  // Metallic 5-inch rocket motor body + nozzle
  acc.tube([mx, my - 1.42, mz], [mx, my - 0.26, mz], r * 0.96, r, 10, P.silver, cShade(P.silver, 0.88), true, false);
  acc.tube([mx, my - 1.50, mz], [mx, my - 1.42, mz], r * 0.72, r * 0.90, 8, P.exhaustBurnt, P.cylinderGunmetal, true, false);
  // 4 cruciform stamped aluminum tail fins
  for (let f = 0; f < 4; f++) {
    const a = (f * Math.PI) / 2 + Math.PI / 4;
    const dx = Math.cos(a), dz = Math.sin(a);
    const p0 = [mx + dx * (r * 0.85), my - 1.18, mz + dz * (r * 0.85)];
    const p1 = [mx + dx * 0.19, my - 1.28, mz + dz * 0.19];
    const p2 = [mx + dx * 0.19, my - 1.48, mz + dz * 0.19];
    const p3 = [mx + dx * (r * 0.85), my - 1.46, mz + dz * (r * 0.85)];
    acc.quad(p0, p1, p2, p3, P.silver);
    acc.quad(p1, p0, p3, p2, P.silver);
  }
  return acc;
}

/**
 * Build 1 merged AN-M66 (2,000 lb) or AN-M65 (1,000 lb) GP bomb mesh centered on `muzzle` (`+Y` nose forward so
 * `weapons.js:releaseBomb()` centers by `-muzzle` and aligns `+Y` along ballistic velocity).
 */
function buildBombOrdnance(P, muzzle, heavy) {
  const acc = new GeomAcc(3);
  const [mx, my, mz] = muzzle;
  const s = heavy ? 1.20 : 0.95;
  const R = 0.22 * s;
  const L = 1.56 * s;
  // Smooth teardrop bomb body stations along Y around my
  const prof = [
    [-0.50 * L, 0.34 * R, P.oliveDrab],
    [-0.32 * L, 0.72 * R, P.oliveDrab],
    [-0.10 * L, 0.98 * R, P.oliveDrab],
    [0.16 * L,  1.00 * R, P.oliveDrab],
    [0.26 * L,  0.92 * R, P.heYellow], // crisp yellow HE nose band
    [0.33 * L,  0.80 * R, P.heYellow],
    [0.42 * L,  0.52 * R, P.oliveDrab],
    [0.49 * L,  0.16 * R, P.silver],   // nose fuze vane
  ];
  const segs = 14;
  const rings = prof.map(([dy, rad, col]) => {
    const pts = [];
    for (let i = 0; i < segs; i++) {
      const a = (i / segs) * Math.PI * 2;
      pts.push([mx + Math.sin(a) * rad, my + dy, mz + Math.cos(a) * rad]);
    }
    return { pts, cols: pts.map(() => col) };
  });
  acc.loft(rings, true);
  // Nose fuze tip + aft cap
  acc.tube([mx, my + 0.48 * L, mz], [mx, my + 0.53 * L, mz], 0.14 * R, 0.03 * R, 8, P.silver, P.silver, false, true);
  acc.tube([mx, my - 0.56 * L, mz], [mx, my - 0.50 * L, mz], 0.30 * R, 0.34 * R, 10, P.oliveDrab, P.oliveDrab, true, false);
  // AN-M65/66 4 cruciform fins + box-fin shroud ring
  const fSpan = 1.38 * R;
  const yF0 = my - 0.34 * L, yF1 = my - 0.58 * L;
  for (let f = 0; f < 4; f++) {
    const a = (f * Math.PI) / 2;
    const dx = Math.cos(a), dz = Math.sin(a);
    const p0 = [mx + dx * (0.4 * R), yF0, mz + dz * (0.4 * R)];
    const p1 = [mx + dx * fSpan, yF0 - 0.08 * L, mz + dz * fSpan];
    const p2 = [mx + dx * fSpan, yF1, mz + dz * fSpan];
    const p3 = [mx + dx * (0.3 * R), yF1, mz + dz * (0.3 * R)];
    acc.quad(p0, p1, p2, p3, P.oliveDrab);
    acc.quad(p1, p0, p3, p2, P.oliveDrab);
  }
  // Outer box-tail stabilizer ring connecting fin tips
  for (let f = 0; f < 4; f++) {
    const a0 = (f * Math.PI) / 2, a1 = ((f + 1) * Math.PI) / 2;
    const q0 = [mx + Math.cos(a0) * fSpan, yF0 - 0.10 * L, mz + Math.sin(a0) * fSpan];
    const q1 = [mx + Math.cos(a1) * fSpan, yF0 - 0.10 * L, mz + Math.sin(a1) * fSpan];
    const q2 = [mx + Math.cos(a1) * fSpan, yF1, mz + Math.sin(a1) * fSpan];
    const q3 = [mx + Math.cos(a0) * fSpan, yF1, mz + Math.sin(a0) * fSpan];
    acc.quad(q0, q1, q2, q3, P.oliveDrab);
    acc.quad(q1, q0, q3, q2, P.oliveDrab);
  }
  return acc;
}

/**
 * Build the combined additive glow template data (Port Red + Starboard Green nav glows, Tailcone White Strobe, and
 * 6× crossed-fin R-2800 Exhaust Flame Plumes = 1 single draw call, zero PointLight/SpotLight!).
 */
function buildAdditiveFxSpec(P) {
  const acc = new GeomAcc(3, true);
  const nUp = [0, 0, 1];
  const emitCrossedGlow = (cx, cy, cz, r, col) => {
    // Horizontal + vertical crossed additive quads
    const quads = [
      [[cx - r, cy - r, cz], [cx + r, cy - r, cz], [cx + r, cy + r, cz], [cx - r, cy + r, cz]],
      [[cx, cy - r, cz - r], [cx, cy + r, cz - r], [cx, cy + r, cz + r], [cx, cy - r, cz + r]],
    ];
    for (const [p0, p1, p2, p3] of quads) {
      acc.tri(p0, p1, p2, col, col, col, nUp, nUp, nUp, [0, 0], [1, 0], [1, 1]);
      acc.tri(p0, p2, p3, col, col, col, nUp, nUp, nUp, [0, 0], [1, 1], [0, 1]);
    }
  };

  // Vertices 0..11: Port Wingtip Red (#ff281c)
  emitCrossedGlow(-6.55, 0.72, wingZAt(6.55), 0.22, P.navRed);
  // Vertices 12..23: Starboard Wingtip Green (#1cff4e)
  emitCrossedGlow(6.55, 0.72, wingZAt(6.55), 0.22, P.navGreen);
  // Vertices 24..35: Tailcone White Strobe (#fff8e7) — pulsed in pose()
  const strobeVertStart = acc.pos.length / 3;
  emitCrossedGlow(0, -6.44, 2.96, 0.28, P.strobeWhite);
  const strobeVertEnd = acc.pos.length / 3;

  // Vertices 36..107: 6× R-2800 Exhaust Stacks (3 port + 3 starboard, 12 verts each = 72 verts)
  const exhaustVertStart = acc.pos.length / 3;
  const exhaustStacks = [];
  for (const side of [-1, 1]) {
    for (let idx = 0; idx < 3; idx++) {
      const root = [side * 0.75, 2.02 - idx * 0.25, 2.55 - idx * 0.05];
      const dir = vNorm([side * 0.26, -0.96, -0.07]);
      const baseLen = 0.56;
      const halfW = 0.085;
      const vStart = acc.pos.length / 3;
      const tip = vAdd(root, vScale(dir, baseLen));
      // Fin 1 (horizontal-ish) & Fin 2 (vertical-ish)
      const u1 = [side, 0.26, 0];
      const u2 = [0, 0, 1];
      for (const u of [u1, u2]) {
        const p0 = vAdd(root, vScale(u, -halfW));
        const p1 = vAdd(root, vScale(u, halfW));
        const p2 = vAdd(tip, vScale(u, halfW * 0.35));
        const p3 = vAdd(tip, vScale(u, -halfW * 0.35));
        const zero = [0, 0, 0];
        acc.tri(p0, p1, p2, zero, zero, zero, nUp, nUp, nUp, [0.5, 0.15], [0.5, 0.85], [0.95, 0.5]);
        acc.tri(p0, p2, p3, zero, zero, zero, nUp, nUp, nUp, [0.5, 0.15], [0.95, 0.5], [0.95, 0.5]);
      }
      exhaustStacks.push({ root, dir, u1, u2, baseLen, halfW, vStart, vEnd: acc.pos.length / 3 });
    }
  }
  return { acc, strobeVertStart, strobeVertEnd, exhaustVertStart, exhaustStacks, strobeColor: P.strobeWhite };
}

/**
 * Build & optionally prewarm the complete procedural Grumman F6F-5/F6F-6 Hellcat template.
 * Exported so unit tests can directly construct & verify geometry, palette, draw-call count, and hierarchy.
 */
export function buildProceduralHellcatTemplate(THREE, profile, live = null) {
  const P = makePaletteLinear(THREE);
  const ownedGeometries = [];
  const ownedMaterials = [];
  const ownedTextures = [];
  const trackGeom = (g) => { ownedGeometries.push(g); return g; };
  const trackMat = (m) => { ownedMaterials.push(m); return m; };
  const trackTex = (t) => { ownedTextures.push(t); return t; };

  // Shared materials (4 materials total across the entire aircraft!)
  const matAirframe = trackMat(new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.44,
    metalness: 0.26,
  }));
  const matGlazing = trackMat(new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.18,
    metalness: 0.12,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  }));
  const propDiscTex = trackTex(makePropDiscTexture(THREE, 64));
  const matPropBlur = trackMat(new THREE.MeshBasicMaterial({
    map: propDiscTex,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    side: THREE.DoubleSide,
  }));
  const glowTex = trackTex(makeRadialGlowTexture(THREE, 64));
  const matAdditive = trackMat(new THREE.MeshBasicMaterial({
    map: glowTex,
    vertexColors: true,
    transparent: true,
    opacity: 1,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  }));

  // Build static + articulated geometries
  const staticAcc = new GeomAcc(3);
  buildStaticAirframe(staticAcc, P, profile);
  const geomStatic = trackGeom(staticAcc.toBufferGeometry(THREE));
  const geomWindscreen = trackGeom(buildWindscreenAndSight(P).toBufferGeometry(THREE));
  const geomCanopy = trackGeom(buildSlidingCanopy(P).toBufferGeometry(THREE));
  const geomPropSolid = trackGeom(buildPropellerSolid(P).toBufferGeometry(THREE));
  const geomPropBlur = trackGeom(buildPropDiscGeometry(THREE, 1.96));
  const geomGearL = trackGeom(buildMainGearLeg(P, -1).toBufferGeometry(THREE));
  const geomGearR = trackGeom(buildMainGearLeg(P, 1).toBufferGeometry(THREE));
  const geomGearTail = trackGeom(buildTailGear(P).toBufferGeometry(THREE));

  const surfAccs = buildControlSurfaces(P);
  const geomSurfaces = {
    aileronL: trackGeom(surfAccs.aileronL.toBufferGeometry(THREE)),
    aileronR: trackGeom(surfAccs.aileronR.toBufferGeometry(THREE)),
    elevator: trackGeom(surfAccs.elevator.toBufferGeometry(THREE)),
    rudder: trackGeom(surfAccs.rudder.toBufferGeometry(THREE)),
    flaps: trackGeom(surfAccs.flaps.toBufferGeometry(THREE)),
    tailhook: trackGeom(surfAccs.tailhook.toBufferGeometry(THREE)),
  };

  const fxSpec = buildAdditiveFxSpec(P);
  const geomFxTemplate = trackGeom(fxSpec.acc.toBufferGeometry(THREE));

  // Ordnance stations (1 merged mesh per rocket/bomb weapon station)
  const ordnanceGeoms = new Map();
  const ws = profile?.weapons || [];
  const ext = profile?.weaponExt || [];
  for (let wi = 0; wi < ws.length; wi++) {
    const w = ws[wi];
    if (!w) continue;
    const mz = Array.isArray(w.muzzle) ? w.muzzle : [0, 0.4, 1.2];
    if (w.kind === 2) {
      ordnanceGeoms.set(wi, trackGeom(buildHvarRocket(P, mz).toBufferGeometry(THREE)));
    } else if (w.kind === 3) {
      const heavy = (ext[wi]?.massKg ?? 0) >= 680 || (w.lb ?? 0) >= 1500 || (wi === 12 && Math.abs(mz[0]) < 0.2);
      ordnanceGeoms.set(wi, trackGeom(buildBombOrdnance(P, mz, heavy).toBufferGeometry(THREE)));
    }
  }

  // Compatible `buckets` summary for `templateBucket(profile, key)` & stats
  const buckets = [
    { key: "static", meshes: [{ geometry: geomStatic, material: matAirframe, cast: true }] },
    { key: "windscreen", meshes: [{ geometry: geomWindscreen, material: matGlazing, cast: false }] },
    { key: "canopy", meshes: [{ geometry: geomCanopy, material: matGlazing, cast: false }] },
    {
      key: "prop",
      meshes: [
        { geometry: geomPropSolid, material: matAirframe, cast: true },
        { geometry: geomPropBlur, material: matPropBlur, cast: false },
      ],
    },
    {
      key: "gear",
      meshes: [
        { geometry: geomGearL, material: matAirframe, cast: true },
        { geometry: geomGearR, material: matAirframe, cast: true },
        { geometry: geomGearTail, material: matAirframe, cast: true },
      ],
    },
    { key: "aileronL", meshes: [{ geometry: geomSurfaces.aileronL, material: matAirframe, cast: true }] },
    { key: "aileronR", meshes: [{ geometry: geomSurfaces.aileronR, material: matAirframe, cast: true }] },
    { key: "elevator", meshes: [{ geometry: geomSurfaces.elevator, material: matAirframe, cast: true }] },
    { key: "rudder", meshes: [{ geometry: geomSurfaces.rudder, material: matAirframe, cast: true }] },
    { key: "flaps", meshes: [{ geometry: geomSurfaces.flaps, material: matAirframe, cast: true }] },
    { key: "tailhook", meshes: [{ geometry: geomSurfaces.tailhook, material: matAirframe, cast: true }] },
    { key: "fx", meshes: [{ geometry: geomFxTemplate, material: matAdditive, cast: false }] },
  ];
  for (const [wi, g] of ordnanceGeoms) {
    buckets.push({ key: `ord:${wi}`, meshes: [{ geometry: g, material: matAirframe, cast: true }] });
  }

  let meshCount = 0;
  for (const b of buckets) meshCount += b.meshes.length;

  // Prewarm all shader programs & textures off-frame via prewarmSubtree
  if (live) {
    try {
      const prewarmRoot = new THREE.Group();
      for (const b of buckets) {
        for (const mm of b.meshes) {
          const m = new THREE.Mesh(mm.geometry, mm.material);
          m.castShadow = mm.cast;
          m.receiveShadow = mm.cast;
          prewarmRoot.add(m);
        }
      }
      prewarmSubtree(live, prewarmRoot).catch(() => {});
    } catch (_) { /* best effort */ }
  }

  return {
    procedural: true,
    buckets,
    hub: [...F6F_HUB],
    pivotY: F6F_MAIN_Y,
    meshCount,
    materials: { matAirframe, matGlazing, matPropBlur, matAdditive },
    geometries: {
      static: geomStatic,
      windscreen: geomWindscreen,
      canopy: geomCanopy,
      propSolid: geomPropSolid,
      propBlur: geomPropBlur,
      gearL: geomGearL,
      gearR: geomGearR,
      gearTail: geomGearTail,
      surfaces: geomSurfaces,
      fxTemplate: geomFxTemplate,
      ordnance: ordnanceGeoms,
    },
    fxSpec,
    ownedGeometries,
    ownedMaterials,
    ownedTextures,
  };
}

function updateProceduralExhaustAndStrobe(inst, pose, thr, boost, dt) {
  const fx = inst.fxData;
  if (!fx) return;
  inst.animTime = (inst.animTime || 0) + dt;
  const t = inst.animTime;

  // 1. Tailcone White Strobe pulsing in flight (double-flash ~1.35 Hz)
  const phase = (t * 1.35) % 1;
  const strobeActive = pose.mode !== MODE_PARKED && (phase < 0.09 || (phase > 0.18 && phase < 0.26));
  const strobeIntensity = strobeActive ? 1.0 : (pose.mode !== MODE_PARKED ? 0.12 : 0.0);
  if (strobeIntensity !== fx.lastStrobe) {
    fx.lastStrobe = strobeIntensity;
    const sc = fx.spec.strobeColor;
    const colArr = fx.colorAttr.array;
    for (let v = fx.spec.strobeVertStart; v < fx.spec.strobeVertEnd; v++) {
      colArr[v * 3] = sc[0] * strobeIntensity;
      colArr[v * 3 + 1] = sc[1] * strobeIntensity;
      colArr[v * 3 + 2] = sc[2] * strobeIntensity;
    }
    fx.colorAttr.needsUpdate = true;
  }

  // 2. Port & Starboard 3-stack R-2800 Exhaust Flame Plumes
  const active = thr >= 0.08 || !!boost;
  if (!active) {
    if (inst.exhaust.visible) {
      const colArr = fx.colorAttr.array;
      for (let v = fx.spec.exhaustVertStart * 3; v < colArr.length; v++) colArr[v] = 0;
      fx.colorAttr.needsUpdate = true;
      inst.exhaust.visible = false;
      inst.exhaust.scale = 0;
      inst.exhaust.intensity = 0;
      inst.exhaust.boost = false;
    }
    return;
  }

  const power = boost ? 1.38 : clamp((thr - 0.08) / 0.92, 0, 1);
  const baseScale = boost ? 1.78 : 0.35 + 0.95 * power;
  const baseIntensity = boost ? 1.0 : 0.24 + 0.58 * power;
  const posArr = fx.posAttr.array;
  const colArr = fx.colorAttr.array;
  const stacks = fx.spec.exhaustStacks;

  // Cruise: warm blue-amber; High throttle / WEP: roaring blue-white root + fiery orange-gold torch tip
  const rootCol = boost ? [0.78, 0.92, 1.0] : cLerp([0.28, 0.48, 0.95], [0.62, 0.80, 1.0], power);
  const tipCol = boost ? [1.0, 0.52, 0.14] : cLerp([0.85, 0.42, 0.12], [1.0, 0.58, 0.18], power);

  for (let k = 0; k < stacks.length; k++) {
    const st = stacks[k];
    const flick = 1 + 0.16 * Math.sin(t * 53 + k * 2.05) + 0.09 * Math.sin(t * 89 + k * 3.3);
    const len = st.baseLen * baseScale * flick;
    const hw = st.halfW * (boost ? 1.32 : 0.78 + 0.32 * power) * (0.94 + 0.08 * flick);
    const tip = vAdd(st.root, vScale(st.dir, len));
    const inten = baseIntensity * (0.86 + 0.14 * flick);
    const rc0 = rootCol[0] * inten, rc1 = rootCol[1] * inten, rc2 = rootCol[2] * inten;
    const tc0 = tipCol[0] * inten, tc1 = tipCol[1] * inten, tc2 = tipCol[2] * inten;

    let vi = st.vStart;
    for (const u of [st.u1, st.u2]) {
      const p0 = vAdd(st.root, vScale(u, -hw));
      const p1 = vAdd(st.root, vScale(u, hw));
      const p2 = vAdd(tip, vScale(u, hw * 0.32));
      const p3 = vAdd(tip, vScale(u, -hw * 0.32));
      const verts = [
        [p0, rc0, rc1, rc2], [p1, rc0, rc1, rc2], [p2, tc0, tc1, tc2],
        [p0, rc0, rc1, rc2], [p2, tc0, tc1, tc2], [p3, tc0, tc1, tc2],
      ];
      for (let q = 0; q < 6; q++, vi++) {
        const [pt, rC, gC, bC] = verts[q];
        posArr[vi * 3] = pt[0];
        posArr[vi * 3 + 1] = pt[1];
        posArr[vi * 3 + 2] = pt[2];
        colArr[vi * 3] = rC;
        colArr[vi * 3 + 1] = gC;
        colArr[vi * 3 + 2] = bC;
      }
    }
  }
  fx.posAttr.needsUpdate = true;
  fx.colorAttr.needsUpdate = true;
  inst.exhaust.visible = true;
  inst.exhaust.scale = baseScale;
  inst.exhaust.intensity = baseIntensity;
  inst.exhaust.boost = !!boost;
}

/**
 * The composite airframes of every vehicle this client draws.
 * @param {{liveScene3d: object, THREE: object, search?: string}} deps
 */
export function createAirframes(deps = {}) {
  const live = deps.liveScene3d;
  const THREE = deps.THREE;
  const getSearch = () => (deps.search !== undefined ? deps.search : (typeof globalThis !== "undefined" ? globalThis.location?.search ?? "" : ""));
  const templates = new Map(); // profileKey → template
  const instances = new Map(); // guid → instance
  const stats = { built: 0, failed: 0, instances: 0, buckets: 0, meshes: 0 };

  function templateKey(profile) {
    const proc = shouldUseProceduralHellcat(profile, getSearch());
    return `${proc ? "proc:" : ""}${profile.profileKey}|${(profile.parts || []).length}`;
  }

  async function buildTemplate(profile) {
    const parts = profile.parts || [];
    const roles = profile.partRoles || [];
    let preAssembled = null;
    if (geomBundlesActive() && parts.length > 0) {
      try {
        preAssembled = await assembleGeomBundles(parts.map((m) => m.did >>> 0));
      } catch (_) {
        preAssembled = null;
      }
    }
    const uniqueDids = [...new Set(parts.map((p) => p.did >>> 0))];
    const models = new Map(); // did → decoded pieces (shared geometry: cloned per placement below)
    await Promise.all(
      uniqueDids.map(async (did) => {
        models.set(did, await decodeModel(live, THREE, did, preAssembled));
      })
    );
    // hub = the first propeller part's offset (the spinner's / blades' common pivot)
    let hub = null;
    for (let i = 0; i < parts.length; i++) if (roleKind(roles[i] ?? 0) === PART_ROLE.PROPELLER) { hub = parts[i].offset; break; }
    const buckets = new Map(); // bucketKey → Map(material → [geoms])
    const m = new THREE.Matrix4();
    const pos = new THREE.Vector3(), quat = new THREE.Quaternion(), scl = new THREE.Vector3();
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      const role = roles[i] ?? 0;
      const kind = roleKind(role);
      const bucket = kind === PART_ROLE.PROPELLER ? "prop" : kind === PART_ROLE.GEAR ? "gear" : kind === PART_ROLE.CANOPY ? "canopy"
        : kind === PART_ROLE.ORDNANCE ? `ord:${roleWeapon(role)}` : "static";
      const o = p.offset || [0, 0, 0];
      // the propeller in the hub's frame (its group spins about the hub)
      pos.set(o[0] - (bucket === "prop" && hub ? hub[0] : 0), o[1] - (bucket === "prop" && hub ? hub[1] : 0), o[2] - (bucket === "prop" && hub ? hub[2] : 0));
      const r = p.rotation || [1, 0, 0, 0]; // W, X, Y, Z
      quat.set(r[1], r[2], r[3], r[0]).normalize();
      const s = Number.isFinite(p.scale) && p.scale > 0 ? p.scale : 1;
      scl.set(s, s, s);
      m.compose(pos, quat, scl);
      for (const piece of models.get(p.did >>> 0) || []) {
        const g = piece.geometry.clone();
        g.applyMatrix4(m);
        let byMat = buckets.get(bucket);
        if (!byMat) buckets.set(bucket, (byMat = new Map()));
        let list = byMat.get(piece.material);
        if (!list) byMat.set(piece.material, (list = []));
        list.push(g);
      }
    }
    // the decoded originals are no longer needed (each placement merged a transformed clone)
    for (const pieces of models.values()) for (const piece of pieces) { try { piece.geometry.dispose(); } catch (_) {} }
    const out = [];
    for (const [key, byMat] of buckets) {
      const meshes = [];
      for (const [material, geoms] of byMat) {
        const merged = mergeGeometries(THREE, geoms);
        for (const g of geoms) { try { g.dispose(); } catch (_) {} }
        meshes.push({ geometry: merged, material, cast: materialCanCastShadow(material) });
      }
      out.push({ key, meshes });
      stats.meshes += meshes.length;
    }
    stats.buckets += out.length;
    return { procedural: false, buckets: out, hub, pivotY: gearPivotY(profile) };
  }

  function templateFor(profile) {
    const key = templateKey(profile);
    let t = templates.get(key);
    if (!t) {
      if (shouldUseProceduralHellcat(profile, getSearch())) {
        try {
          const proc = buildProceduralHellcatTemplate(THREE, profile, live);
          t = { status: "ready", error: null, promise: Promise.resolve(), ...proc };
          templates.set(key, t);
          stats.built++;
          stats.buckets += proc.buckets.length;
          stats.meshes += proc.meshCount;
        } catch (e) {
          t = { status: "failed", buckets: [], hub: null, pivotY: null, error: String(e?.message || e), promise: Promise.resolve() };
          templates.set(key, t);
          stats.failed++;
        }
        return t;
      }

      t = { status: "building", procedural: false, buckets: null, hub: null, pivotY: null, error: null, promise: null };
      templates.set(key, t);
      t.promise = buildTemplate(profile).then((r) => {
        Object.assign(t, r);
        t.status = t.buckets.length ? "ready" : "failed";
        if (t.status === "ready") {
          stats.built++;
          try {
            const grp = new THREE.Group();
            for (const b of t.buckets) {
              for (const mm of b.meshes) {
                const m = new THREE.Mesh(mm.geometry, mm.material);
                m.castShadow = mm.cast;
                m.receiveShadow = true;
                grp.add(m);
              }
            }
            prewarmSubtree(live, grp).catch(() => {});
          } catch (_) { /* best effort */ }
        } else {
          stats.failed++;
        }
      }).catch((e) => {
        t.status = "failed";
        t.error = String(e && e.message ? e.message : e);
        stats.failed++;
        console.warn("[vehicles] airframe build failed (the stand-in stays):", t.error);
      });
    }
    return t;
  }

  function instantiateProcedural(guid, profile, t) {
    const root = new THREE.Group();
    root.name = `vehicle-airframe-${(guid >>> 0).toString(16)}`;
    const body = new THREE.Group();
    root.add(body);

    const groups = {
      static: body,
      windscreen: new THREE.Group(),
      gear: new THREE.Group(),
      canopy: new THREE.Group(),
      prop: new THREE.Group(),
    };
    body.add(groups.windscreen, groups.gear, groups.canopy, groups.prop);
    groups.prop.position.set(t.hub[0], t.hub[1], t.hub[2]);

    const ownedDisposables = [];

    // 1. Main static fuselage/wing/engine/tail mesh
    const staticMesh = new THREE.Mesh(t.geometries.static, t.materials.matAirframe);
    staticMesh.castShadow = true;
    staticMesh.receiveShadow = true;
    staticMesh.name = "airframe-static";
    body.add(staticMesh);

    // 2. Fixed armored windscreen + coaming + illuminated Mk 8 reflector sight
    const windscreenMesh = new THREE.Mesh(t.geometries.windscreen, t.materials.matGlazing);
    windscreenMesh.renderOrder = 2;
    windscreenMesh.name = "airframe-windscreen";
    groups.windscreen.add(windscreenMesh);

    // 3. Sliding glazed bubble/greenhouse rear canopy
    const canopyMesh = new THREE.Mesh(t.geometries.canopy, t.materials.matGlazing);
    canopyMesh.renderOrder = 3;
    canopyMesh.name = "airframe-canopy";
    groups.canopy.add(canopyMesh);

    // 4-5. 3-Blade Hamilton Standard Propeller + Speed-Blended Translucent Prop Blur Disc
    const propSolidMat = t.materials.matAirframe.clone();
    const propBlurMat = t.materials.matPropBlur.clone();
    ownedDisposables.push(propSolidMat, propBlurMat);

    const propSolidMesh = new THREE.Mesh(t.geometries.propSolid, propSolidMat);
    propSolidMesh.castShadow = true;
    propSolidMesh.receiveShadow = true;
    propSolidMesh.name = "airframe-prop-solid";
    const propBlurMesh = new THREE.Mesh(t.geometries.propBlur, propBlurMat);
    propBlurMesh.renderOrder = 4;
    propBlurMesh.visible = false;
    propBlurMesh.name = "airframe-prop-disc";
    groups.prop.add(propSolidMesh, propBlurMesh);

    // 6-8. Grumman Twist-and-Turn Retracting Main Gear + Tailwheel
    const gearLegL = new THREE.Group();
    gearLegL.position.set(-1.92, F6F_MAIN_Y, 2.02);
    gearLegL.rotation.order = "XZY";
    const meshGearL = new THREE.Mesh(t.geometries.gearL, t.materials.matAirframe);
    meshGearL.castShadow = true;
    meshGearL.receiveShadow = true;
    meshGearL.name = "airframe-gear-left";
    gearLegL.add(meshGearL);

    const gearLegR = new THREE.Group();
    gearLegR.position.set(1.92, F6F_MAIN_Y, 2.02);
    gearLegR.rotation.order = "XZY";
    const meshGearR = new THREE.Mesh(t.geometries.gearR, t.materials.matAirframe);
    meshGearR.castShadow = true;
    meshGearR.receiveShadow = true;
    meshGearR.name = "airframe-gear-right";
    gearLegR.add(meshGearR);

    const gearTail = new THREE.Group();
    gearTail.position.set(0, -5.65, 1.82);
    const meshGearTail = new THREE.Mesh(t.geometries.gearTail, t.materials.matAirframe);
    meshGearTail.castShadow = true;
    meshGearTail.receiveShadow = true;
    meshGearTail.name = "airframe-gear-tail";
    gearTail.add(meshGearTail);
    groups.gear.add(gearLegL, gearLegR, gearTail);

    // 9-14. Articulated Control Surfaces & Striped Carrier Arrestor Hook
    const makeSurface = (name, geom, pos, order = "XYZ") => {
      const grp = new THREE.Group();
      grp.position.set(pos[0], pos[1], pos[2]);
      grp.rotation.order = order;
      const mesh = new THREE.Mesh(geom, t.materials.matAirframe);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.name = `airframe-${name}`;
      grp.add(mesh);
      body.add(grp);
      return grp;
    };
    const surfaces = {
      aileronL: makeSurface("aileronL", t.geometries.surfaces.aileronL, [-5.18, -0.14, wingZAt(5.18)], "YXZ"),
      aileronR: makeSurface("aileronR", t.geometries.surfaces.aileronR, [5.18, -0.14, wingZAt(5.18)], "YXZ"),
      elevator: makeSurface("elevator", t.geometries.surfaces.elevator, [0, -6.18, 2.92]),
      rudder: makeSurface("rudder", t.geometries.surfaces.rudder, [0, -6.05, 3.00]),
      flaps: makeSurface("flaps", t.geometries.surfaces.flaps, [0, -0.46, 2.02]),
      tailhook: makeSurface("tailhook", t.geometries.surfaces.tailhook, [0, -5.42, 2.45]),
    };
    surfaces.aileronL.rotation.set(0, F6F_DIHEDRAL, 0);
    surfaces.aileronR.rotation.set(0, -F6F_DIHEDRAL, 0);

    // 15. Per-instance Additive Nav Lights, Strobe & 6-Stack R-2800 Exhaust Flame Plumes
    const fxGeom = t.geometries.fxTemplate.clone();
    ownedDisposables.push(fxGeom);
    const fxMesh = new THREE.Mesh(fxGeom, t.materials.matAdditive);
    fxMesh.renderOrder = 5;
    fxMesh.frustumCulled = false;
    fxMesh.name = "airframe-fx-glow";
    body.add(fxMesh);

    // 16+. Ordnance stations (1 merged mesh per HVAR rocket / AN-M65/66 bomb station)
    const ordnance = new Map();
    for (const [wi, geom] of t.geometries.ordnance) {
      const grp = new THREE.Group();
      const mesh = new THREE.Mesh(geom, t.materials.matAirframe);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.name = `airframe-ord:${wi}`;
      grp.add(mesh);
      body.add(grp);
      ordnance.set(wi, grp);
    }

    groups.canopy.position.y = -0.72; // parked open-canopy carrier deck stance initially
    live.worldRoot.add(root);
    stats.instances++;

    return {
      guid: guid >>> 0,
      procedural: true,
      profile,
      t,
      root,
      body,
      groups,
      gearParts: { left: gearLegL, right: gearLegR, tail: gearTail },
      propParts: { solid: propSolidMesh, blur: propBlurMesh },
      surfaces,
      ordnance,
      exhaust: { visible: false, scale: 0, intensity: 0, boost: false },
      fxData: {
        mesh: fxMesh,
        spec: t.fxSpec,
        posAttr: fxGeom.getAttribute("position"),
        colorAttr: fxGeom.getAttribute("color"),
        lastStrobe: -1,
      },
      ownedDisposables,
      propAngle: 0,
      propBlurOpacity: 0,
      gear: 1,
      gearDeploy: 1,
      canopySlide: -0.72,
      flapDeploy: 0,
      hookDeploy: 0,
      surfAngles: { roll: 0, pitch: 0, yaw: 0 },
      prevBank: null,
      prevPitch: null,
      prevHeading: null,
      animTime: 0,
      lastMode: null,
      visible: true,
    };
  }

  function instantiate(guid, profile, t) {
    if (t.procedural) return instantiateProcedural(guid, profile, t);
    const root = new THREE.Group();
    root.name = `vehicle-airframe-${(guid >>> 0).toString(16)}`;
    const body = new THREE.Group(); // tipped tail-down when parked (about the main wheels' contact line)
    root.add(body);
    const groups = { static: body, gear: new THREE.Group(), canopy: new THREE.Group(), prop: new THREE.Group() };
    body.add(groups.gear, groups.canopy, groups.prop);
    if (t.hub) groups.prop.position.set(t.hub[0], t.hub[1], t.hub[2]);
    const ordnance = new Map(); // weapon index → Group
    for (const b of t.buckets) {
      let parent = groups[b.key];
      if (!parent && b.key.startsWith("ord:")) {
        const w = Number(b.key.slice(4));
        parent = new THREE.Group();
        body.add(parent);
        ordnance.set(w, parent);
      }
      for (const mm of b.meshes) {
        const mesh = new THREE.Mesh(mm.geometry, mm.material);
        mesh.castShadow = mm.cast;
        mesh.receiveShadow = true;
        mesh.name = `airframe-${b.key}`;
        parent.add(mesh);
      }
    }
    live.worldRoot.add(root);
    stats.instances++;
    return { guid: guid >>> 0, procedural: false, profile, t, root, body, groups, ordnance, propAngle: 0, gear: 1, lastMode: null, visible: true };
  }

  return {
    /** The vehicle's airframe instance (built on first call; null while its template decodes or when it failed). */
    ensure(v) {
      if (!THREE || !live?.worldRoot || !v?.profile) return null;
      if (!hasComposite(v.profile) && !shouldUseProceduralHellcat(v.profile, getSearch())) return null;
      const g = v.guid >>> 0;
      let inst = instances.get(g);
      if (inst) return inst;
      const t = templateFor(v.profile);
      if (t.status !== "ready") return null;
      inst = instantiate(g, v.profile, t);
      instances.set(g, inst);
      return inst;
    },
    /** Is the template for this profile still decoding / failed / ready? */
    status(profile) { return profile ? (templates.get(templateKey(profile))?.status ?? "none") : "none"; },
    get(guid) { return instances.get(guid >>> 0) ?? null; },
    /**
     * Pose one airframe for this frame. pose = {x, y, z, heading, pitch, bank, speed?, mode};
     * o = {q: [w,x,y,z] orientation, dt, throttle, agl, cockpit, hideWindscreen, pitch, roll, yaw, boost, land,
     *      missileMask, bombMask, localSpent}.
     */
    pose(inst, pose, o = {}) {
      const r = inst.root;
      r.position.set(pose.x, pose.y, pose.z);
      if (o.q) r.quaternion.set(o.q[1], o.q[2], o.q[3], o.q[0]);
      // parked stance: tail down about the main wheels' contact line
      const dt = Math.max(0, Math.min(0.25, o.dt || 0));
      const target = gearTarget(pose.mode, o.agl);
      inst.gear += (target - inst.gear) * (1 - Math.exp(-dt / GEAR_TAU));
      if (Math.abs(target - inst.gear) < 1e-3) inst.gear = target;
      const tilt = inst.t.pivotY === null ? 0 : GEAR_PITCH * inst.gear;
      const b = inst.body;
      if (tilt !== inst.lastTilt) {
        inst.lastTilt = tilt;
        const py = inst.t.pivotY ?? 0;
        b.rotation.set(tilt, 0, 0);
        // rotate about (0, py, 0): position = pivot − R·pivot
        b.position.set(0, py - py * Math.cos(tilt), -py * Math.sin(tilt));
      }

      const thr = Number.isFinite(o.throttle) ? Math.max(0, Math.min(1, o.throttle)) : (pose.mode === MODE_PARKED ? 0 : 0.7);
      inst.propAngle = (inst.propAngle + (PROP.idle + PROP.full * thr) * dt) % (2 * Math.PI);
      inst.groups.prop.rotation.set(0, inst.propAngle, 0);
      inst.groups.canopy.visible = !o.cockpit;
      for (const [w, grp] of inst.ordnance) grp.visible = weaponLoaded(inst.profile, w, o.missileMask, o.bombMask, o.localSpent);

      if (!inst.procedural) {
        inst.groups.gear.visible = pose.mode === MODE_PARKED || pose.mode === MODE_TAKEOFF || pose.mode === MODE_LANDING;
        return tilt;
      }

      // ---- Procedural Grumman F6F-5 / F6F-6 Articulations & FX ----
      if (inst.groups.windscreen) inst.groups.windscreen.visible = !o.hideWindscreen;

      // 1. Sliding canopy: open aft (-0.72 m) when PARKED, closed forward (0) during TAKEOFF/FLIGHT/LANDING
      const canopyTarget = pose.mode === MODE_PARKED ? -0.72 : 0.0;
      inst.canopySlide += (canopyTarget - inst.canopySlide) * (1 - Math.exp(-dt / 0.30));
      if (Math.abs(canopyTarget - inst.canopySlide) < 1e-3) inst.canopySlide = canopyTarget;
      inst.groups.canopy.position.y = inst.canopySlide;

      // 2. Twist-and-turn landing gear deployment (1 in PARKED/TAKEOFF/LANDING, 0 in FLIGHT; tau = 0.42 s)
      const gearWant = (pose.mode === MODE_PARKED || pose.mode === MODE_TAKEOFF || pose.mode === MODE_LANDING) ? 1 : 0;
      inst.gearDeploy += (gearWant - inst.gearDeploy) * (1 - Math.exp(-dt / GEAR_DEPLOY_TAU));
      if (Math.abs(gearWant - inst.gearDeploy) < 1e-3) inst.gearDeploy = gearWant;
      const retract = 1 - inst.gearDeploy;
      const foldX = -retract * (Math.PI / 2);
      const twistZ = retract * (Math.PI / 2);
      inst.gearParts.left.rotation.set(foldX, 0, twistZ);
      inst.gearParts.right.rotation.set(foldX, 0, -twistZ);
      inst.gearParts.tail.rotation.set(-retract * 1.15, 0, 0);
      inst.groups.gear.visible = inst.gearDeploy > 0.01;

      // 3. Speed-blended translucent prop blur disc + solid paddle blade anti-strobe fade
      const speed = Number.isFinite(pose.speed) ? pose.speed : (pose.mode === MODE_PARKED ? 0 : 75);
      const speedNorm = clamp(speed / 95, 0, 1);
      const propDrive = pose.mode === MODE_PARKED && thr < 0.05 ? 0 : clamp(thr * 0.72 + speedNorm * 0.45 + (o.boost ? 0.25 : 0), 0, 1);
      const blurTarget = 0.40 * smoothstep(0.10, 0.85, propDrive);
      inst.propBlurOpacity += (blurTarget - inst.propBlurOpacity) * (1 - Math.exp(-dt / 0.14));
      if (Math.abs(blurTarget - inst.propBlurOpacity) < 1e-3) inst.propBlurOpacity = blurTarget;
      const blurMesh = inst.propParts.blur;
      const solidMesh = inst.propParts.solid;
      blurMesh.material.opacity = inst.propBlurOpacity;
      blurMesh.visible = inst.propBlurOpacity > 0.005;
      const hiSpin = clamp(inst.propBlurOpacity / 0.40, 0, 1);
      solidMesh.material.transparent = hiSpin > 0.03;
      solidMesh.material.opacity = 1 - 0.65 * hiSpin;

      // 4. Articulated Control Surfaces & Carrier Arrestor Hook
      let rollCmd = 0, pitchCmd = 0, yawCmd = 0;
      if (Number.isFinite(o.roll)) rollCmd = clamp(o.roll, -1, 1);
      else if (dt > 1e-4 && Number.isFinite(inst.prevBank) && Number.isFinite(pose.bank)) {
        rollCmd = clamp((pose.bank - inst.prevBank) / (dt * 1.6), -1, 1);
      }
      if (Number.isFinite(o.pitch)) pitchCmd = clamp(o.pitch, -1, 1);
      else if (dt > 1e-4 && Number.isFinite(inst.prevPitch) && Number.isFinite(pose.pitch)) {
        pitchCmd = clamp((pose.pitch - inst.prevPitch) / (dt * 1.1), -1, 1);
      }
      if (Number.isFinite(o.yaw)) yawCmd = clamp(o.yaw, -1, 1);
      else if (dt > 1e-4 && Number.isFinite(inst.prevHeading) && Number.isFinite(pose.heading)) {
        yawCmd = clamp((angDiff(pose.heading, inst.prevHeading) / (dt * 0.9)) * 0.45 + Math.sin(pose.bank || 0) * 0.25, -1, 1);
      }
      inst.prevBank = pose.bank;
      inst.prevPitch = pose.pitch;
      inst.prevHeading = pose.heading;

      const sAlpha = 1 - Math.exp(-dt / 0.08);
      inst.surfAngles.roll += (rollCmd - inst.surfAngles.roll) * sAlpha;
      inst.surfAngles.pitch += (pitchCmd - inst.surfAngles.pitch) * sAlpha;
      inst.surfAngles.yaw += (yawCmd - inst.surfAngles.yaw) * sAlpha;

      const ailRad = inst.surfAngles.roll * (20 * DEG);
      inst.surfaces.aileronL.rotation.set(ailRad, F6F_DIHEDRAL, 0);
      inst.surfaces.aileronR.rotation.set(-ailRad, -F6F_DIHEDRAL, 0);
      inst.surfaces.elevator.rotation.set(-inst.surfAngles.pitch * (22 * DEG), 0, 0);
      inst.surfaces.rudder.rotation.set(0, 0, inst.surfAngles.yaw * (25 * DEG));

      const flapWant = (pose.mode === MODE_TAKEOFF || pose.mode === MODE_LANDING || !!o.land) ? 1 : 0;
      inst.flapDeploy += (flapWant - inst.flapDeploy) * (1 - Math.exp(-dt / 0.32));
      if (Math.abs(flapWant - inst.flapDeploy) < 1e-3) inst.flapDeploy = flapWant;
      inst.surfaces.flaps.rotation.set(inst.flapDeploy * (34 * DEG), 0, 0);

      const hookWant = (pose.mode === MODE_LANDING || !!o.land) ? 1 : 0;
      inst.hookDeploy += (hookWant - inst.hookDeploy) * (1 - Math.exp(-dt / 0.26));
      if (Math.abs(hookWant - inst.hookDeploy) < 1e-3) inst.hookDeploy = hookWant;
      inst.surfaces.tailhook.rotation.set(inst.hookDeploy * (30 * DEG), 0, 0);

      // 5. Tail strobe & 6-stack R-2800 exhaust flames
      updateProceduralExhaustAndStrobe(inst, pose, thr, !!o.boost, dt);

      return tilt;
    },
    /** The parked tilt (radians, nose up) last applied to this vehicle (the seat follows it). */
    tiltOf(guid) { return instances.get(guid >>> 0)?.lastTilt ?? 0; },
    /** A station's ordnance meshes in the vehicle frame (the falling bomb is drawn with them). */
    ordnanceMeshes(guid, weapon) {
      const inst = instances.get(guid >>> 0);
      const grp = inst?.ordnance.get(weapon);
      return grp ? grp.children.filter((c) => c.isMesh) : [];
    },
    templateBucket(profile, key) {
      const t = templates.get(templateKey(profile));
      return t?.buckets?.find((b) => b.key === key) ?? null;
    },
    remove(guid) {
      const inst = instances.get(guid >>> 0);
      if (!inst) return false;
      instances.delete(guid >>> 0);
      try { inst.root.parent?.remove(inst.root); } catch (_) { /* gone */ }
      if (inst.ownedDisposables) {
        for (const d of inst.ownedDisposables) { try { d.dispose?.(); } catch (_) { /* gone */ } }
      }
      stats.instances--;
      return true;
    },
    stats: () => ({ ...stats, templates: [...templates.entries()].map(([k, t]) => ({ key: k, status: t.status, error: t.error })), live: instances.size }),
    dispose() {
      for (const g of [...instances.keys()]) this.remove(g);
      for (const t of templates.values()) {
        if (t.procedural) {
          for (const g of t.ownedGeometries || []) { try { g.dispose(); } catch (_) {} }
          for (const m of t.ownedMaterials || []) { try { m.dispose(); } catch (_) {} }
          for (const tx of t.ownedTextures || []) { try { tx.dispose(); } catch (_) {} }
        } else {
          for (const b of t.buckets || []) for (const mm of b.meshes) { try { mm.geometry.dispose(); } catch (_) {} }
        }
      }
      templates.clear();
    },
  };
}
