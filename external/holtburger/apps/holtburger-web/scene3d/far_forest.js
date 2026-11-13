// scene3d/far_forest.js — FAR FORESTS (`?farForest`, flight experience Phase 2; design FAR-FORESTS.md).
//
// WHY. Trees exist only inside the object window (~0.8-1 km). From an aircraft the world beyond is bare: the
// 1070 tours measured 1-3 km tree coverage at 1-2 %. Retail never drew trees past its 3x3 (LScape), so this tier is
// beyond-retail by design ("retail = correctness oracle, renderer = modern GPU"): WHAT is placed is exactly the
// retail scenery placement the near tier draws (the shipped `dist/scenery-retail` bake, repacked by
// docs/flight-experience-2026-11-01/bench/bake_far_forest.py into `dist/farforest/`), HOW it is drawn is modern.
//
// WHAT.
//   * PLACEMENTS — per 8x8-landblock region, 20-byte records (x, y, z, scale, model, yaw) of the retail models
//     that read at a distance (mean height ≥ 4 m + the swaying-tree setups), streamed around the camera.
//   * IMPOSTORS — each model is built ONCE through the near tier's own decode (wasm fetchBuildingPlacement, the
//     material cache's textures) and rendered UNLIT from 8 azimuths into one atlas (an albedo bake — lighting is
//     applied live, the far ring's rule; unlit capture also means no new lit program variants are compiled).
//   * DRAW — ONE instanced draw: a camera-facing card per tree (cylindrical, so trunks stay vertical), the view
//     chosen by the camera's azimuth in the tree's own frame, alpha-tested, depth-writing, the shared range fog.
//   * HANDOVER — the exact complement of the near trees on the presence field (lb_presence.js R = the near
//     objects of that landblock are on screen), on the same 4x4 ordered dither: a pixel is drawn by exactly one
//     tier while a landblock fades. The object window's hide is deferred until the impostors have faded in
//     (object_radius.js), so a tree never blinks out at the window edge. A dithered fade at the far range end.
//
// RULES: one program, no per-instance program key, no light change, never touches statics/buildings/the LRU.
// `?farForest` absent (and no ?flightView): nothing is created or fetched.

import * as THREE from "three";
import { meshToGeometryGroups } from "./adapter.js";
import { surfacePixelsFetcher } from "./bake_worker_client.js";
import { lbFadeUniforms, lbFadeOn } from "./lb_presence.js";
import { rlogSetFarForestProbe } from "./residency_log.js";
import { flightViewFlag } from "./flight_view_flag.js";
import { withLogDepth } from "./shader_logdepth.js";
import { prewarmSubtree } from "./bake_prewarm.js";
import { geomBundlesActive, assembleModels as assembleGeomBundles, bundleToPartGroups } from "./geom_bundles.js";

const BASE_URL = "../../dist/farforest/";
const VIEWS = 8;
const CELL_PX = 128;
const ATLAS_COLS = 16;              // 2 models x 8 views per atlas row
const MAX_MODELS = 96;
const ATLAS_ROWS = Math.ceil((MAX_MODELS * VIEWS) / ATLAS_COLS);
const MAX_INSTANCES = 262144;
const MAX_REGIONS_RESIDENT = 220;
const REGION_M = 8 * 192;           // 1,536 m
const REC_BYTES = 20;

/** `?farForest` — DEV opt-in (implied by ?flightView): on / 1 / true / yes → ON; `=off` escapes. */
export function farForestEnabled(search) {
  try {
    const s = search !== undefined ? search : (globalThis.location?.search || "");
    const ps = new URLSearchParams(s);
    const v = (ps.get("farForest") || "").trim().toLowerCase();
    if (v === "on" || v === "1" || v === "true" || v === "yes") return true;
    if (v === "off" || v === "0" || v === "false" || v === "no") return false;
    // implied by ?flightView (default ON)
    return flightViewFlag(s);
  } catch (_) {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested: tests/far_forest.test.mjs)
// ---------------------------------------------------------------------------
/** Region key of an AC point. */
export function regionOf(x, y) { return [Math.floor(x / REGION_M), Math.floor(y / REGION_M)]; }
/** Regions whose square intersects the disc (cx, cy, r), nearest first. */
export function regionsInRange(cx, cy, r) {
  const out = [];
  const x0 = Math.max(0, Math.floor((cx - r) / REGION_M)), x1 = Math.min(31, Math.floor((cx + r) / REGION_M));
  const y0 = Math.max(0, Math.floor((cy - r) / REGION_M)), y1 = Math.min(31, Math.floor((cy + r) / REGION_M));
  for (let rx = x0; rx <= x1; rx += 1) {
    for (let ry = y0; ry <= y1; ry += 1) {
      const dx = Math.max(rx * REGION_M - cx, 0, cx - (rx + 1) * REGION_M);
      const dy = Math.max(ry * REGION_M - cy, 0, cy - (ry + 1) * REGION_M);
      const d = Math.hypot(dx, dy);
      if (d <= r) out.push({ rx, ry, d });
    }
  }
  out.sort((a, b) => a.d - b.d);
  return out;
}
/** Decode one region file into parallel arrays. */
export function decodeRegion(buf) {
  const n = Math.floor(buf.byteLength / REC_BYTES);
  const dv = new DataView(buf);
  const pos = new Float32Array(n * 3), sy = new Float32Array(n * 2), model = new Float32Array(n);
  const lbCount = new Map();
  for (let i = 0; i < n; i += 1) {
    const o = i * REC_BYTES;
    const x = dv.getFloat32(o, true), y = dv.getFloat32(o + 4, true), z = dv.getFloat32(o + 8, true);
    pos[i * 3] = x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = z;
    sy[i * 2] = dv.getFloat32(o + 12, true);
    sy[i * 2 + 1] = (dv.getUint8(o + 17) / 256) * Math.PI * 2;
    model[i] = dv.getUint8(o + 16);
    const k = ((((Math.floor(x / 192)) & 0xff) << 24) | (((Math.floor(y / 192)) & 0xff) << 16)) >>> 0;
    lbCount.set(k, (lbCount.get(k) || 0) + 1);
  }
  return { n, pos, sy, model, lbCount };
}
/** The atlas cell (column, row) of model m, view k. */
export function atlasCell(m, k) { const c = m * VIEWS + k; return [c % ATLAS_COLS, Math.floor(c / ATLAS_COLS)]; }
/** The bake camera's azimuth for view k (radians, counter-clockwise from +x, the model's own frame). */
export function viewAzimuth(k) { return (k / VIEWS) * Math.PI * 2; }
/** Distance-based instance decimation stride for distant far-forest regions. */
export function farForestRegionStride(distM) {
  if (!(distM > 3800)) return 1;
  if (distM <= 6000) return 2;
  if (distM <= 8200) return 3;
  return 4;
}

// ---------------------------------------------------------------------------
// GLSL
// ---------------------------------------------------------------------------
export const FF_VERTEX_GLSL = /* glsl */ `
precision highp float;
in vec3 iPos;          // AC metres (the placement's terrain-snapped z)
in vec2 iScaleYaw;     // scale, yaw (radians, about AC +z)
in float iModel;
uniform vec4 uModel[${MAX_MODELS}];   // (halfWidth, height, zMin, baked) per model at scale 1
uniform vec3 uCamAc;
uniform vec3 uCamForward;             // AC camera forward unit vector (zero = cone cull off)
uniform float uCamConeCos;            // cos(halfDiagFov + guardMargin)
uniform vec2 uRange;                  // (fade start, end) metres
uniform vec2 uAtlasGrid;              // (columns, rows)
out vec2 vUv;
out vec2 vUv1;        // the next view's cell (the two nearest azimuth views, cross-dithered in the fragment stage)
flat out float vViewF; // 0 = all view vUv, 1 = all view vUv1
out float vDist;
out float vFogDist;
flat out vec2 vLb;
void main() {
  int m = int(iModel + 0.5);
  if (m < 0 || m >= ${MAX_MODELS}) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; } // models past the baked set
  vec4 md = uModel[m];
  float s = iScaleYaw.x;
  vec2 d2 = uCamAc.xy - iPos.xy;
  float dist = length(d2);
  if (md.w < 0.5 || dist > uRange.y || dist < 1.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  if (dot(uCamForward, uCamForward) > 0.25) {
    vec3 treeCenter = vec3(iPos.xy, iPos.z + (md.z + 0.5 * md.y) * s);
    vec3 toBillboard = treeCenter - uCamAc;
    float guardR = max(md.x * 2.0, md.y) * s + 32.0;
    float dist3 = length(toBillboard);
    float fwdProj = dot(toBillboard, uCamForward);
    if (fwdProj < -guardR) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
    if (dist3 > guardR && (fwdProj + guardR) < uCamConeCos * dist3) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      return;
    }
  }
  vec2 dir = d2 / dist;
  vec2 right = vec2(-dir.y, dir.x);
  vec3 base = vec3(iPos.xy, iPos.z + md.z * s);
  vec3 p = base + vec3(right * (position.x * 2.0 * md.x * s), position.y * md.y * s);
  float rel = atan(dir.y, dir.x) - iScaleYaw.y;
  // the view as a continuous coordinate: the two nearest baked views and the fraction between them (a banked turn
  // or an orbit no longer flips a card 45 degrees at once; the fragment stage dithers between the two)
  float v = mod(rel / 6.2831853 * ${VIEWS}.0, ${VIEWS}.0);
  float k = floor(v);
  float k1 = mod(k + 1.0, ${VIEWS}.0);
  vViewF = v - k;
  vec2 corner = vec2(position.x + 0.5, position.y);
  float cell = float(m) * ${VIEWS}.0 + k;
  vec2 cxy = vec2(mod(cell, uAtlasGrid.x), floor(cell / uAtlasGrid.x));
  vUv = (cxy + corner) / uAtlasGrid;
  float cell1 = float(m) * ${VIEWS}.0 + k1;
  vec2 cxy1 = vec2(mod(cell1, uAtlasGrid.x), floor(cell1 / uAtlasGrid.x));
  vUv1 = (cxy1 + corner) / uAtlasGrid;
  vDist = dist;
  vLb = floor(iPos.xy / 192.0);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vFogDist = length(mv.xyz);
  gl_Position = projectionMatrix * mv;
}
`;

export const FF_FRAGMENT_GLSL = /* glsl */ `
precision highp float;
precision highp sampler2D;
in vec2 vUv;
in vec2 vUv1;
flat in float vViewF;
in float vDist;
in float vFogDist;
flat in vec2 vLb;
out vec4 fragColor;
uniform sampler2D uAtlas;
uniform vec2 uRange;
uniform vec3 uSunDir;
uniform vec3 uAcSunColor;
uniform vec3 uAcAmbColor;
uniform float uAcAmbLevel;
uniform float uGain;
#ifdef HB_FF_PRESENCE
uniform highp sampler2D hbLbPresence;
uniform vec2 hbLbPresenceOrigin;
#endif
#ifdef USE_FOG
uniform vec3 fogColor;
uniform float fogNear;
uniform float fogFar;
#endif
void main() {
  const float hbBayer[16] = float[16](0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0);
  // the two nearest views, both fetched in uniform control flow (correct mip derivatives), picked per pixel on an
  // ordered dither offset from the presence dither below (no correlated pattern between the two)
  vec4 tA = texture(uAtlas, vUv);
  vec4 tB = texture(uAtlas, vUv1);
  ivec2 hbV = (ivec2(gl_FragCoord.xy) + ivec2(2, 1)) & 3;
  vec4 t = ((hbBayer[hbV.y * 4 + hbV.x] + 0.5) / 16.0 < vViewF) ? tB : tA;
  if (t.a < 0.35) discard;
  // one dither: the near tier's complement (presence R) times the range-end fade
  float keep = 1.0 - smoothstep(uRange.x, uRange.y, vDist);
#ifdef HB_FF_PRESENCE
  ivec2 lb = ivec2(vLb) - ivec2(hbLbPresenceOrigin);
  if (lb.x >= 0 && lb.y >= 0 && lb.x < 64 && lb.y < 64) keep *= 1.0 - texelFetch(hbLbPresence, lb, 0).r;
#endif
  if (keep < 0.999) {
    ivec2 hbP = ivec2(gl_FragCoord.xy) & 3;
    if ((hbBayer[hbP.y * 4 + hbP.x] + 0.5) / 16.0 >= keep) discard;
  }
  // the atlas was cleared to transparent black, so mips carry premultiplied colour: un-premultiply
  vec3 albedo = t.rgb / max(t.a, 0.05);
  // live light, canopy-like: a mostly-up normal, the same retail sun / ambient the terrain uses
  float sunL = max(0.0, normalize(uSunDir).z) * 0.75 + 0.25;
  vec3 lit = albedo * min(vec3(1.25), uAcSunColor * sunL + uAcAmbColor * uAcAmbLevel) * uGain;
#ifdef USE_FOG
  lit = mix(lit, fogColor, smoothstep(fogNear, fogFar, vFogDist));
#endif
  fragColor = vec4(lit, 1.0);
}
`;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let _st = null;
const _diag = { enabled: false, models: 0, baked: 0, bakeFailed: 0, regionsLoaded: 0, regionsWanted: 0, instances: 0, rebuilds: 0, wanted: false, rangeM: 0, error: null };

export function farForestDiag() { return { ..._diag }; }

/** Create the tier (lazy data and bakes). A no-op without `?farForest` / `?flightView`. */
export function initFarForest(scene3d, { parent = null, renderer = null } = {}) {
  if (!farForestEnabled()) return null;
  _diag.enabled = true;
  if (_st) return _st;
  const group = new THREE.Group();
  group.name = "far-forest";
  (parent ?? scene3d.staticsGroup?.parent ?? scene3d.terrainGroup?.parent).add(group);
  _st = {
    scene3d, group, renderer: renderer ?? scene3d.renderer ?? null,
    index: null, models: null, regions: new Map(), loading: new Set(), wanted: false,
    mesh: null, geo: null, mat: null, atlas: null, bakeQueue: [], baking: false, modelData: new Float32Array(MAX_MODELS * 4),
    sig: null, rangeM: 4500,
  };
  if (typeof window !== "undefined") window.__farForest = () => farForestDiag();
  rlogSetFarForestProbe((k) => _ffDrawsLb(k));
  return _st;
}

function _ffDrawsLb(k) {
  const st = _st;
  if (!st || !st.mesh || !st.mesh.visible) return false;
  const x = ((k >>> 24) & 0xff) * 192 + 96, y = ((k >>> 16) & 0xff) * 192 + 96;
  const [rx, ry] = regionOf(x, y);
  const r = st.regions.get(`${rx}_${ry}`);
  if (!r || !r.data || !r.inUse) return false;
  return (r.data.lbCount.get(k >>> 0) || 0) > 0;
}

async function _loadIndex(st) {
  const [index, models] = await Promise.all([
    fetch(`${BASE_URL}index.json`).then((r) => { if (!r.ok) throw new Error(`farforest index: HTTP ${r.status}`); return r.json(); }),
    fetch(`${BASE_URL}models.json`).then((r) => { if (!r.ok) throw new Error(`farforest models: HTTP ${r.status}`); return r.json(); }),
  ]);
  st.index = index;
  st.models = models.slice(0, MAX_MODELS).map((m) => ({ id: parseInt(m.id, 16) >>> 0, placements: m.placements, retries: 0 }));
  _diag.models = st.models.length;
  const order = st.models.map((_, i) => i);
  if (geomBundlesActive() && st.models.length > 0) {
    try {
      const bRes = await assembleGeomBundles(st.models.map((m) => m.id));
      const byModel = bRes?.byModel || bRes;
      if (byModel && typeof byModel.has === "function") {
        const resident = [], missing = [];
        for (const i of order) {
          if (byModel.has(st.models[i].id)) resident.push(i);
          else missing.push(i);
        }
        st.bakeQueue = [...resident, ...missing];
        return;
      }
    } catch (_) { /* keep default order */ }
  }
  st.bakeQueue = order;
}

/** The far forest is wanted (flying): starts the index fetch + the impostor bakes on first call. */
export function setFarForestWanted(scene3d, wanted, { rangeM = null } = {}) {
  const st = _st || initFarForest(scene3d);
  if (!st) return;
  st.wanted = !!wanted;
  _diag.wanted = st.wanted;
  if (Number.isFinite(rangeM)) st.rangeM = rangeM;
  if (st.wanted && !st.index && !st.indexLoading) {
    st.indexLoading = true;
    _loadIndex(st).catch((e) => {
      _diag.error = String(e?.message ?? e);
      // eslint-disable-next-line no-console
      console.warn("[far_forest] placement pack unavailable (dist/farforest/ missing?) — the tier stays off:", e?.message ?? e);
    });
  }
}

// ---------------------------------------------------------------------------
// Impostor bake (one model at a time, off the critical path)
// ---------------------------------------------------------------------------
function _ensureAtlas(st) {
  if (st.atlas) return st.atlas;
  const rows = ATLAS_ROWS;
  const rt = new THREE.WebGLRenderTarget(ATLAS_COLS * CELL_PX, rows * CELL_PX, {
    type: THREE.UnsignedByteType, format: THREE.RGBAFormat, depthBuffer: true, stencilBuffer: false,
    generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter,
  });
  rt.texture.name = "far-forest-atlas";
  st.atlas = rt;
  st.atlasRows = rows;
  return rt;
}

async function _buildModelGroup(scene3d, setupId) {
  const wasm = scene3d.wasmExports;
  const mc = scene3d.materialCache;
  if (!mc) throw new Error("no material cache");
  const partsList = [];
  if (geomBundlesActive()) {
    try {
      const bRes = await assembleGeomBundles([setupId >>> 0]);
      const entry = bRes?.byModel ? bRes.byModel.get(setupId >>> 0) : bRes?.get?.(setupId >>> 0);
      if (entry) {
        const bpg = bundleToPartGroups(entry, bRes.buffer);
        if (Array.isArray(bpg)) {
          partsList.push({ groups: bpg, hinge: null });
        } else if (Array.isArray(bpg?.parts)) {
          for (const p of bpg.parts) partsList.push({ groups: p.groups || [], hinge: p.hinge || null });
        }
      }
    } catch (_) { /* fallback to wasm */ }
  }
  if (partsList.length === 0) {
    if (!wasm || typeof wasm.fetchBuildingPlacement !== "function") throw new Error("no wasm/material cache");
    const bundle = await wasm.fetchBuildingPlacement(setupId >>> 0, true);
    if (bundle && typeof bundle.partGroups === "function") {
      const groups = bundle.partGroups() || [];
      partsList.push({ groups, hinge: null });
      bundle.free?.();
    } else if (bundle) {
      const partCount = bundle.partCount | 0;
      const partMeshes = partCount ? bundle.takePartMeshes() : [];
      const hinge = typeof bundle.takePartHingeFrames === "function" ? bundle.takePartHingeFrames() : [];
      bundle.free?.();
      for (let i = 0; i < partCount; i += 1) {
        const wm = partMeshes[i];
        if (wm) {
          try {
            const { groups, surfaceDids } = meshToGeometryGroups(wm);
            partsList.push({ groups: groups || [], surfaceDids, hinge: hinge[i] || null });
          } catch (_) { /* skip part */ }
          wm.free?.();
        }
      }
    }
  }
  // the fetcher INSTANCE: surfacePixelsFetcher is a factory (bake_worker_client.js). Passing the factory itself made
  // every material-cache miss "fetch" a function, so the cache handed back its grey fallback: every tree whose
  // surfaces the near tier had not already loaded was baked as a grey card — white-ish in the desert sun (1070 film
  // shoot 2026-11-02; the atlas dump showed 60 of 64 models untextured at a desert login).
  const fetchPixels = surfacePixelsFetcher(wasm);
  const urgentFetch = (dids) => fetchPixels(dids, true);
  const isCached = (s) => (mc.materials instanceof Map ? mc.materials.has(s) : false);
  const missingSids = [];
  const seenSids = new Set();
  for (let p = 0; p < partsList.length; p += 1) {
    const groups = partsList[p].groups || [];
    const surfaceDids = partsList[p].surfaceDids;
    for (let g = 0; g < groups.length; g += 1) {
      const sid = Number(groups[g].surfaceDid || surfaceDids?.[g] || 0) >>> 0;
      if (sid && !isCached(sid) && !seenSids.has(sid)) {
        seenSids.add(sid);
        missingSids.push(sid);
      }
    }
  }
  if (missingSids.length > 0 && typeof mc.preload === "function") {
    try { await mc.preload(missingSids, urgentFetch); } catch (_) { /* best effort */ }
  }
  const group = new THREE.Group();
  const owned = [];
  let fallbackParts = 0;
  for (let i = 0; i < partsList.length; i += 1) {
    const pg = new THREE.Group();
    const h = partsList[i].hinge;
    if (h) { pg.position.set(h.x, h.y, h.z); pg.quaternion.set(h.qx, h.qy, h.qz, h.qw); }
    const groups = partsList[i].groups || [];
    const surfaceDids = partsList[i].surfaceDids;
    for (let g = 0; g < groups.length; g += 1) {
      const grp = groups[g];
      const sid = (grp.surfaceDid || surfaceDids?.[g] || 0) >>> 0;
      // eslint-disable-next-line no-await-in-loop
      const src = (isCached(sid) ? mc.materials.get(sid) : null) || await mc.get(sid, fetchPixels);
      if (!grp.geometry || !src) continue;
      // a surface the cache could not decode comes back as its grey fallback: leave the part out (no grey card)
      if (src === mc.fallbackMaterial) { fallbackParts += 1; continue; }
      // UNLIT albedo capture: a basic material over the surface's own texture (no lit program variants)
      const m = new THREE.MeshBasicMaterial({
        map: src.map ?? null, color: src.color ? src.color.clone() : new THREE.Color(1, 1, 1),
        alphaTest: Math.max(0.3, src.alphaTest || 0), transparent: false, side: THREE.DoubleSide,
      });
      owned.push(m);
      pg.add(new THREE.Mesh(grp.geometry, m));
    }
    group.add(pg);
  }
  if (fallbackParts) _diag.fallbackParts = (_diag.fallbackParts || 0) + fallbackParts;
  return { group, owned };
}

function _bakeViews(st, m, built) {
  const renderer = st.renderer;
  if (!renderer) return false;
  const group = built.group;
  group.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(group);
  if (box.isEmpty()) return false;
  const c = box.getCenter(new THREE.Vector3());
  const halfW = Math.max(box.max.x - c.x, c.x - box.min.x, box.max.y - c.y, c.y - box.min.y) * 1.05;
  const zMin = box.min.z, zMax = box.max.z;
  const h = (zMax - zMin) * 1.02;
  if (!(halfW > 0.05) || !(h > 0.1)) return false;
  const scene = new THREE.Scene();
  scene.add(group);
  const cam = new THREE.OrthographicCamera(-halfW, halfW, h, 0, 0.1, halfW * 8 + 10);
  cam.up.set(0, 0, 1);
  const rt = _ensureAtlas(st);
  const prev = {
    target: renderer.getRenderTarget(), autoClear: renderer.autoClear, scissorTest: renderer.getScissorTest(),
    clearColor: renderer.getClearColor(new THREE.Color()), clearAlpha: renderer.getClearAlpha(),
  };
  renderer.setRenderTarget(rt);
  renderer.autoClear = false;
  renderer.setScissorTest(true);
  renderer.setClearColor(0x000000, 0);
  for (let k = 0; k < VIEWS; k += 1) {
    const a = viewAzimuth(k);
    const dist = halfW * 4 + 5;
    cam.position.set(c.x + Math.cos(a) * dist, c.y + Math.sin(a) * dist, zMin);
    cam.lookAt(c.x, c.y, zMin);
    cam.updateMatrixWorld(true);
    const [col, row] = atlasCell(m, k);
    rt.texture.generateMipmaps = (k === VIEWS - 1) && (st.bakeQueue.length === 0 || ((_diag.baked + 1) % 8 === 0));
    renderer.setViewport(col * CELL_PX, row * CELL_PX, CELL_PX, CELL_PX);
    renderer.setScissor(col * CELL_PX, row * CELL_PX, CELL_PX, CELL_PX);
    renderer.clear(true, true, false);
    renderer.render(scene, cam);
  }
  renderer.setScissorTest(prev.scissorTest);
  renderer.setRenderTarget(prev.target);
  renderer.autoClear = prev.autoClear;
  renderer.setClearColor(prev.clearColor, prev.clearAlpha);
  const size = renderer.getSize(new THREE.Vector2());
  renderer.setViewport(0, 0, size.x, size.y);
  renderer.setScissor(0, 0, size.x, size.y);
  scene.remove(group);
  // the card at scale 1: half width, height, base offset from the placement's z
  st.modelData.set([halfW, h, zMin, 1], m * 4);
  st.atlasDirty = true;
  return true;
}

// The bake's own programs (MeshBasicMaterial with / without a map, alpha-tested, double-sided, drawn into the atlas
// target) are linked OFF the frame before the first bake, and two dummy materials keep them referenced for the
// session: rendering the first model would otherwise compile them synchronously (arm F, 1070: a 1.7 s frame at
// take-off), and disposing each model's materials would drop three's last reference to the program (WebGLPrograms
// releaseProgram destroys it at usedTimes 0), so every model could link it again.
function _precompileBake(st) {
  if (st.bakePrecompile) return st.bakePrecompile;
  const r = st.renderer;
  if (!r || typeof r.compile !== "function") {
    st.bakeReady = true;
    st.bakeCompilePending = false;
    st.bakePrecompile = Promise.resolve();
    return st.bakePrecompile;
  }
  const scene = new THREE.Scene();
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 1]), 3));
  geo.setAttribute("normal", new THREE.BufferAttribute(new Float32Array([0, -1, 0, 0, -1, 0, 0, -1, 0]), 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1]), 2));
  const tex = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  tex.needsUpdate = true;
  const mats = [
    new THREE.MeshBasicMaterial({ map: tex, alphaTest: 0.3, transparent: false, side: THREE.DoubleSide }),
    new THREE.MeshBasicMaterial({ alphaTest: 0.3, transparent: false, side: THREE.DoubleSide }),
  ];
  for (const m of mats) { const mesh = new THREE.Mesh(geo, m); mesh.frustumCulled = false; scene.add(mesh); }
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  st.bakeKeep = { geo, tex, mats }; // never disposed: they hold the two programs for the session
  st.bakeCompilePending = true;
  let p;
  try {
    const rt = _ensureAtlas(st);
    const prevTarget = typeof r.getRenderTarget === "function" ? r.getRenderTarget() : null;
    try {
      if (typeof r.setRenderTarget === "function") r.setRenderTarget(rt);
      r.compile(scene, cam, scene);
    } finally {
      try { if (typeof r.setRenderTarget === "function") r.setRenderTarget(prevTarget); } catch (_) {}
    }
    p = Promise.race([
      new Promise((resolve) => {
        const check = () => {
          let ready = true;
          try {
            for (const m of mats) {
              const prog = r.properties?.get?.(m)?.currentProgram;
              if (prog && typeof prog.isReady === "function" && !prog.isReady()) { ready = false; break; }
            }
          } catch (_) { ready = true; }
          if (ready) resolve(); else setTimeout(check, 10);
        };
        check();
      }),
      new Promise((res) => setTimeout(res, 1500)),
    ]);
  } catch (_) {
    p = null;
  }
  st.bakePrecompile = Promise.resolve(p).catch(() => {}).then(() => {
    st.bakeReady = true;
    st.bakeCompilePending = false;
  });
  return st.bakePrecompile;
}

async function _bakeNext(st) {
  if (st.baking || !st.bakeQueue.length || !st.models) return;
  if (!st.bakeReady) { _precompileBake(st); return; }
  st.baking = true;
  try {
    const m = st.bakeQueue.shift();
    if (m == null) return;
    const entry = st.models[m];
    const setupId = entry.id;
    let built = null;
    let timer = null;
    try {
      built = await Promise.race([
        _buildModelGroup(st.scene3d, setupId),
        new Promise((_, rej) => { timer = setTimeout(() => rej(new Error("bake timeout")), 10000); }),
      ]);
      if (built && _bakeViews(st, m, built)) _diag.baked += 1; else _diag.bakeFailed += 1;
    } catch (e) {
      entry.retries = (entry.retries || 0) + 1;
      if (entry.retries <= 2) {
        st.bakeQueue.push(m);
      } else {
        _diag.bakeFailed += 1;
        if (!_diag.error) _diag.error = `bake 0x${setupId.toString(16)}: ${e?.message ?? e}`;
      }
    } finally {
      if (timer) clearTimeout(timer);
      // the geometries belong to the meshes we built (not cached): dispose them with our basic materials
      try {
        built?.group?.traverse((o) => { if (o.isMesh) o.geometry?.dispose?.(); });
        for (const mat of built?.owned || []) mat.dispose();
      } catch (_) { /* best effort */ }
    }
  } finally {
    st.baking = false;
  }
}

// ---------------------------------------------------------------------------
// Draw
// ---------------------------------------------------------------------------
function _ensureMesh(st) {
  if (st.mesh) return;
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(new Float32Array([-0.5, 0, 0, 0.5, 0, 0, -0.5, 1, 0, 0.5, 1, 0]), 3));
  g.setIndex([0, 1, 2, 1, 3, 2]);
  const iPos = new THREE.InstancedBufferAttribute(new Float32Array(MAX_INSTANCES * 3), 3);
  const iSY = new THREE.InstancedBufferAttribute(new Float32Array(MAX_INSTANCES * 2), 2);
  const iM = new THREE.InstancedBufferAttribute(new Float32Array(MAX_INSTANCES), 1);
  for (const a of [iPos, iSY, iM]) a.setUsage(THREE.DynamicDrawUsage);
  g.setAttribute("iPos", iPos);
  g.setAttribute("iScaleYaw", iSY);
  g.setAttribute("iModel", iM);
  g.instanceCount = 0;
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(24480, 24480, 0), 1e6);
  const uModel = [];
  for (let i = 0; i < MAX_MODELS; i += 1) uModel.push(new THREE.Vector4(0, 0, 0, 0));
  const mat = new THREE.ShaderMaterial(withLogDepth({
    uniforms: {
      uAtlas: { value: _ensureAtlas(st).texture },
      uModel: { value: uModel },
      uCamAc: { value: new THREE.Vector3() },
      uCamForward: { value: new THREE.Vector3(0, 0, 0) },
      uCamConeCos: { value: -1.0 },
      uRange: { value: new THREE.Vector2(4000, 4500) },
      uAtlasGrid: { value: new THREE.Vector2(ATLAS_COLS, st.atlasRows) },
      uSunDir: { value: new THREE.Vector3(-0.4, -0.3, 1.0).normalize() },
      uAcSunColor: { value: new THREE.Color(1, 1, 1) },
      uAcAmbColor: { value: new THREE.Color(1, 1, 1) },
      uAcAmbLevel: { value: 0.35 },
      uGain: { value: 1.0 },
      fogColor: { value: new THREE.Color(0xc3c8dc) },
      fogNear: { value: 150 },
      fogFar: { value: 2400 },
    },
    vertexShader: FF_VERTEX_GLSL,
    fragmentShader: FF_FRAGMENT_GLSL,
    glslVersion: THREE.GLSL3,
    side: THREE.DoubleSide,
    transparent: false,
    depthWrite: true,
    fog: true,
  }));
  if (lbFadeOn()) {
    const pu = lbFadeUniforms(THREE);
    if (pu) {
      mat.defines = { ...(mat.defines || {}), HB_FF_PRESENCE: "" };
      mat.uniforms.hbLbPresence = pu.hbLbPresence;
      mat.uniforms.hbLbPresenceOrigin = pu.hbLbPresenceOrigin;
    }
  }
  mat.name = "far-forest";
  mat.userData.__asyncLink = true;
  const mesh = new THREE.Mesh(g, mat);
  mesh.name = "far-forest-cards";
  mesh.frustumCulled = false;
  mesh.matrixAutoUpdate = false;
  mesh.visible = true;
  st.mesh = mesh; st.geo = g; st.mat = mat;
  _compileAhead(st, mesh);
}

// Compile the program off the frame (KHR_parallel_shader_compile through three's compileAsync) and keep the mesh
// hidden until it is linked — a first-draw link is 0.5-1.7 s of FXC on the 1070, i.e. a visible stall mid-flight.
function _compileAhead(st, mesh) {
  st.compiled = false;
  const finish = () => {
    st.compiled = true;
    if (st.mesh) {
      st.mesh.visible = !!st.wanted;
      if (!st.mesh.parent) st.group.add(st.mesh);
    }
  };
  const r = st.renderer;
  const cam = st.scene3d?.camera;
  const scene = st.scene3d?.scene;
  if (!r || typeof r.compile !== "function" || !cam) { finish(); return; }
  try {
    const p = Promise.race([
      Promise.resolve(scene ? prewarmSubtree(st.scene3d, mesh) : r.compileAsync?.(mesh, cam, scene)),
      new Promise((res) => setTimeout(res, 1500)),
    ]);
    p.then(finish, finish);
  } catch (_) { finish(); }
}

function _copyLight(st) {
  const src = Array.isArray(st.scene3d?.terrainMaterials)
    ? st.scene3d.terrainMaterials.find((m) => m && m.uniforms && m.uniforms.uSunDir)
    : null;
  if (!src) return;
  const s = src.uniforms, u = st.mat.uniforms;
  if (s.uSunDir) u.uSunDir.value.copy(s.uSunDir.value);
  if (s.uAcSunColor) u.uAcSunColor.value.copy(s.uAcSunColor.value);
  if (s.uAcAmbColor) u.uAcAmbColor.value.copy(s.uAcAmbColor.value);
  if (s.uAcAmbLevel) u.uAcAmbLevel.value = s.uAcAmbLevel.value;
}

function _rebuildInstances(st, inRange, cx = 0, cy = 0) {
  const g = st.geo;
  const pos = g.getAttribute("iPos"), sy = g.getAttribute("iScaleYaw"), md = g.getAttribute("iModel");
  let n = 0;
  for (const r of st.regions.values()) r.inUse = false;
  for (const { rx, ry } of inRange) {
    const r = st.regions.get(`${rx}_${ry}`);
    if (!r || !r.data) continue;
    const d = r.data;
    const regCx = (rx * 8 + 4) * 192;
    const regCy = (ry * 8 + 4) * 192;
    const distM = Math.hypot(regCx - cx, regCy - cy);
    const stride = farForestRegionStride(distM);
    if (stride <= 1 && n + d.n <= MAX_INSTANCES) {
      pos.array.set(d.pos, n * 3);
      sy.array.set(d.sy, n * 2);
      md.array.set(d.model, n);
      n += d.n;
      r.inUse = true;
    } else {
      let added = 0;
      for (let i = 0; i < d.n && n < MAX_INSTANCES; i += stride) {
        const p3 = i * 3, n3 = n * 3;
        pos.array[n3] = d.pos[p3];
        pos.array[n3 + 1] = d.pos[p3 + 1];
        pos.array[n3 + 2] = d.pos[p3 + 2];
        const p2 = i * 2, n2 = n * 2;
        sy.array[n2] = d.sy[p2];
        sy.array[n2 + 1] = d.sy[p2 + 1];
        md.array[n] = d.model[i];
        n += 1;
        added += 1;
      }
      if (added > 0) r.inUse = true;
      if (n >= MAX_INSTANCES) break;
    }
  }
  for (const a of [pos, sy, md]) {
    if (typeof a.clearUpdateRanges === "function" && typeof a.addUpdateRange === "function") {
      a.clearUpdateRanges();
      if (n > 0) a.addUpdateRange(0, n * a.itemSize);
    }
    a.needsUpdate = true;
  }
  g.instanceCount = n;
  _diag.instances = n;
  _diag.rebuilds += 1;
}

function _fetchRegion(st, rx, ry) {
  const key = `${rx}_${ry}`;
  const name = `${rx.toString(16).toUpperCase().padStart(2, "0")}_${ry.toString(16).toUpperCase().padStart(2, "0")}`;
  if (!st.index?.regions?.[name]) { st.regions.set(key, { data: { n: 0, pos: new Float32Array(0), sy: new Float32Array(0), model: new Float32Array(0), lbCount: new Map() } }); return; }
  st.loading.add(key);
  fetch(`${BASE_URL}r_${name}.bin`).then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`HTTP ${r.status}`))))
    .then((buf) => { st.regions.set(key, { data: decodeRegion(buf) }); })
    .catch(() => { st.regions.set(key, { data: null }); })
    .finally(() => { st.loading.delete(key); });
}

/**
 * Idle prefetch (altitude_policy.js `?flightPrewarm`): the placement index, the card program and the bake programs
 * (all linked off the frame), then the impostors one model at a time while the tier is NOT wanted — at most one
 * bake start per PREFETCH_BAKE_MS, and only on a frame with headroom (`frameMs` under PREFETCH_FRAME_MS) — so the
 * atlas is complete before the first take-off instead of 64 bakes landing on it.
 */
const PREFETCH_BAKE_MS = 35;
const PREFETCH_FRAME_MS = 45;
export function prefetchFarForest(scene3d, { nowMs = 0, frameMs = 0 } = {}) {
  const st = _st || initFarForest(scene3d);
  if (!st) return;
  if (!st.index) {
    if (!st.indexLoading) {
      st.indexLoading = true;
      _loadIndex(st).catch((e) => { _diag.error = String(e?.message ?? e); });
    }
    return;
  }
  _ensureMesh(st);
  if (!st.wanted && st.mesh) st.mesh.visible = false;
  if (!st.bakeQueue.length || st.baking) return;
  if (frameMs > PREFETCH_FRAME_MS || nowMs - (st.lastPrefetchBakeMs || -1e9) < PREFETCH_BAKE_MS) return;
  st.lastPrefetchBakeMs = nowMs;
  _bakeNext(st);
}

/** Per frame: bakes (one model in flight at a time), region streaming, instance list, uniforms. */
export function tickFarForest(scene3d, camera) {
  const st = _st;
  if (!st) return;
  if (!st.wanted || !st.index || !camera) {
    if (st.mesh) st.mesh.visible = false;
    return;
  }
  _ensureMesh(st);
  const nowMs = (typeof performance !== "undefined") ? performance.now() : Date.now();
  if (!st.baking && st.bakeQueue.length && nowMs - (st.lastBakeMs || 0) >= 35) {
    st.lastBakeMs = nowMs;
    _bakeNext(st);
  }
  if (st.atlasDirty) {
    st.atlasDirty = false;
    const u = st.mat.uniforms.uModel.value;
    for (let i = 0; i < MAX_MODELS; i += 1) u[i].fromArray(st.modelData, i * 4);
  }
  const cp = camera.getWorldPosition ? camera.getWorldPosition(st._cp || (st._cp = new THREE.Vector3())) : camera.position;
  const cx = cp.x, cy = -cp.z;
  const range = st.rangeM;
  _diag.rangeM = range;
  const u = st.mat.uniforms;
  u.uCamAc.value.set(cx, cy, cp.y);
  if (typeof camera.getWorldDirection === "function") {
    const fw = camera.getWorldDirection(st._fw || (st._fw = new THREE.Vector3()));
    u.uCamForward.value.set(fw.x, -fw.z, fw.y);
    if (u.uCamForward.value.lengthSq() > 1e-6) u.uCamForward.value.normalize();
  } else if (camera.matrixWorld?.elements) {
    const me = camera.matrixWorld.elements;
    u.uCamForward.value.set(-me[8], me[10], -me[9]);
    if (u.uCamForward.value.lengthSq() > 1e-6) u.uCamForward.value.normalize();
  } else {
    u.uCamForward.value.set(0, 0, 0);
  }
  if (camera.isOrthographicCamera) {
    u.uCamConeCos.value = -1.0;
  } else {
    const vHalf = ((Number.isFinite(camera.fov) ? camera.fov : 65) * Math.PI) / 360;
    const aspect = Number.isFinite(camera.aspect) && camera.aspect > 0 ? camera.aspect : 1.78;
    const diagHalf = Math.atan(Math.tan(vHalf) * Math.hypot(1, aspect));
    u.uCamConeCos.value = Math.cos(Math.min(Math.PI, diagHalf + 0.20));
  }
  u.uRange.value.set(range * 0.82, range);
  _copyLight(st);
  st.mesh.visible = st.compiled !== false;
  // The region bookkeeping below (two 8 km disc scans, a sorted signature string) runs only when the camera has
  // moved to another region or every 250 ms, not per frame: at 400 km/h a region (1.5 km) takes ~14 s, and the
  // per-frame arrays and strings were garbage for the major GCs that stall a frame (1070 arm O: a 0.65 s GC at 5 km).
  const crx = Math.floor(cx / REGION_M), cry = Math.floor(cy / REGION_M);
  if (crx === st._lastRx && cry === st._lastRy && Math.abs(range - (st._lastRange || 0)) < 250 && nowMs - (st._lastScanMs || 0) < 250) return 0;
  st._lastRx = crx; st._lastRy = cry; st._lastRange = range; st._lastScanMs = nowMs;
  const inRange = regionsInRange(cx, cy, range);
  _diag.regionsWanted = inRange.length;
  let missing = 0;
  for (const { rx, ry } of inRange) {
    const key = `${rx}_${ry}`;
    if (!st.regions.has(key) && !st.loading.has(key)) {
      if (st.loading.size < 4) _fetchRegion(st, rx, ry);
      missing += 1;
    }
  }
  // drop regions far outside the range (memory), keep a margin
  if (st.regions.size > MAX_REGIONS_RESIDENT) {
    for (const [key] of st.regions) {
      const [rx, ry] = key.split("_").map(Number);
      const dx = Math.max(rx * REGION_M - cx, 0, cx - (rx + 1) * REGION_M);
      const dy = Math.max(ry * REGION_M - cy, 0, cy - (ry + 1) * REGION_M);
      if (Math.hypot(dx, dy) > range * 2) st.regions.delete(key);
    }
  }
  // Rebuild the instance list only when the set of LOADED regions in range changes, at most every 1.5 s (arm E
  // rebuilt 1,144 times in 160 s — every region crossing the disc edge, up to 4 MB per upload). Regions come into the
  // list with an 800 m margin quantized to 800 m steps so continuous climb/descent doesn't churn the region set.
  const listRange = Math.ceil((range + 800) / 800) * 800;
  const listed = regionsInRange(cx, cy, listRange);
  const sig = listed.filter((r) => st.regions.get(`${r.rx}_${r.ry}`)?.data).map((r) => `${r.rx}_${r.ry}`).sort().join(",");
  const minRebuildMs = st.loading.size > 0 && st.sig ? 2500 : 1500;
  if (sig !== st.sig && nowMs - (st.lastRebuildMs || 0) >= minRebuildMs) {
    st.sig = sig;
    st.lastRebuildMs = nowMs;
    _rebuildInstances(st, listed, cx, cy);
  }
  let inUse = 0;
  for (const r of st.regions.values()) if (r.inUse) inUse += 1;
  _diag.regionsLoaded = inUse;
  return missing;
}

export function disposeFarForest() {
  const st = _st;
  if (!st) return;
  try {
    st.group.parent?.remove(st.group);
    st.geo?.dispose(); st.mat?.dispose(); st.atlas?.dispose();
  } catch (_) { /* best effort */ }
  _st = null;
}
