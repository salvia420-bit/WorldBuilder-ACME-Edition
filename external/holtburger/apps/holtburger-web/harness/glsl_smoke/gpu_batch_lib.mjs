// harness/glsl_smoke/gpu_batch_lib.mjs — the arms of gpu_batch_smoke.mjs
// (R3-3 GPU batch kit, docs/2026-10-29-round3-gpu-driven.md §R3-3 "Proof").
// Shared by gpu_batch_page.html (real WebGL2: headless Chromium, ANGLE /
// SwiftShader) and the node dry run (tests' fake WebGL2: the code paths run,
// the pixels are not real). Every arm takes `T` (three) and `mods` (the app
// modules, loaded by the caller) so the same text runs in both.
//
//   layers  — admit RGBA8 surface textures (adapter.js surfacePixelsToTexture,
//             the app's own upload path: driver mips) and normal maps into
//             kit pages; read every level of every layer back and compare
//             with the 2D texture's same level: BYTE-EQUAL. Also the scratch
//             path (admitPixels) against a legacy texture of the same pixels.
//   texel   — the real anim-scenery path (animated_scenery.js + the K3
//             consumer) over real MaterialCache materials, posed by a fixed
//             number of ticks; the caller renders it with ?animSceneryBatch
//             off and on and compares the frames: max channel diff 0. One
//             setup is BUNDLE-shaped (the ?geomBundles default: indexed part
//             groups sharing the model's vertex stream, served through the
//             real geom_bundles.js when the caller passes `mods.geomBundles`),
//             so the compacted, index-remapped merge is on screen too.
//   f32     — the kit's camera-relative composition (row texture redirect +
//             landblock origin row + mesh anchored at the camera) against
//             today's absolute instance matrices; the caller compares the two
//             frames of one page: max channel diff <= 1 (1/255) near the
//             origin; at x ~ 32.4 km the difference is reported (that is where
//             the legacy f32 matrix is the imprecise one).
//
// GLSL / page text: no backticks in shader strings.

export const CANVAS = 192;

/** Deterministic noise. */
export function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

export function readFrame(renderer, w = CANVAS, h = CANVAS) {
  const gl = renderer.getContext();
  const px = new Uint8Array(w * h * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
  return px;
}

export function frameDiff(a, b) {
  let maxDiff = 0, differing = 0, over1 = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (d) differing++;
    if (d > 1) over1++;
    if (d > maxDiff) maxDiff = d;
  }
  return { maxDiff, differing, over1 };
}

export function litPixels(px) {
  let n = 0;
  for (let i = 0; i < px.length; i += 4) if (px[i] + px[i + 1] + px[i + 2] > 24) n++;
  return n;
}

// ---------------------------------------------------------------------------
// HBG1 model bundles (the ?geomBundles shape, default on in the app)
// ---------------------------------------------------------------------------
/**
 * What the wasm `assemble_model_geometry` hands geom_bundles.js
 * (`{ buffer, descriptor }`, geom_bundles.js _parseBundle /
 * _entryAttributes): per model ONE shared vertex stream (pos f32x3 | normal
 * f32x3 | uv f32x2) and one 16-bit index; each part names index ranges
 * (subsets). bundleToPartGroups then gives every (part, surface) group the
 * WHOLE stream as its attributes and its own index — the indexed,
 * shared-attribute geometry animated scenery merges by default.
 * `models[i]`: `{ id, positions, normals, uvs, index, parts: [{ subsets:
 * [{ surfaceDid, firstIndex, indexCount, flags }], hinge? }] }`;
 * `missing`: ids the descriptor reports missing (runtime-decode fallback).
 */
export function makeBundleRaw(models, missing = []) {
  let off = 0;
  const lay = [];
  for (const m of models) {
    const V = m.positions.length / 3;
    const vtxOff = off;
    off += V * 32;
    const idxOff = off;
    off += (m.index.length * 2 + 3) & ~3;
    lay.push({ m, V, vtxOff, idxOff });
  }
  const buffer = new Uint8Array(Math.max(off, 4));
  const dv = new DataView(buffer.buffer);
  const entries = [];
  for (const { m, V, vtxOff, idxOff } of lay) {
    m.positions.forEach((v, i) => dv.setFloat32(vtxOff + i * 4, v, true));
    m.normals.forEach((v, i) => dv.setFloat32(vtxOff + V * 12 + i * 4, v, true));
    m.uvs.forEach((v, i) => dv.setFloat32(vtxOff + V * 24 + i * 4, v, true));
    m.index.forEach((v, i) => dv.setUint16(idxOff + i * 2, v, true));
    const parts = m.parts.map((p, k) => ({ partIndex: k, hinge: p.hinge || [0, 0, 0, 1, 0, 0, 0], subsets: p.subsets }));
    entries.push({ id: m.id, vtx: { off: vtxOff, count: V }, idx: { off: idxOff, count: m.index.length, width: 2 },
      parts, fused: { subsets: parts.flatMap((p) => p.subsets) } });
  }
  for (const id of missing) entries.push({ id, missing: true });
  return { buffer, descriptor: JSON.stringify({ models: entries, assembled: models.length, missing: missing.length, bytes: buffer.length }) };
}

/** A wasm-exports stand-in serving `byId` (setup id -> model) through geom_bundles.js (`_testArm`). */
export function bundleWasmExports(byId) {
  const serve = (ids) => {
    const have = [];
    const miss = [];
    for (const id of Array.from(ids)) (byId[id >>> 0] ? have : miss).push(byId[id >>> 0] || (id >>> 0));
    return makeBundleRaw(have, miss);
  };
  return { assemble_model_geometry: serve, assemble_model_geometry_relief: serve, assemble_envcell_geometry: () => null };
}

// ---------------------------------------------------------------------------
// Arm: layers
// ---------------------------------------------------------------------------
export function runLayersArm(T, renderer, mods) {
  const { ArrayPages } = mods.arrayPages;
  const { surfacePixelsToTexture, surfacePixelsToNormalTexture, setAdapterMaxAnisotropy } = mods.adapter;
  setAdapterMaxAnisotropy(renderer.capabilities.getMaxAnisotropy());
  const pages = new ArrayPages(renderer, { pageBytes: 96 * 1024, minLayers: 2, maxLayers: 3 });
  const r = rng(0x1a7e5);
  const out = { textures: 0, levels: 0, mismatchedLevels: 0, firstMismatch: null, pages: 0, scratch: 0, scratchMismatch: 0 };
  const compare = (label, a, b) => {
    out.levels++;
    if (a.length !== b.length) { out.mismatchedLevels++; out.firstMismatch = out.firstMismatch || `${label}: length ${a.length} vs ${b.length}`; return; }
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) { out.mismatchedLevels++; out.firstMismatch = out.firstMismatch || `${label}: byte ${i} ${a[i]} vs ${b[i]}`; return; }
    }
  };
  const sizes = [[64, 64], [64, 64], [32, 64], [128, 64], [16, 16], [3, 5], [1, 1], [64, 64], [64, 64], [200, 120]];
  sizes.forEach(([w, h], k) => {
    const px = new Uint8Array(w * h * 4);
    for (let i = 0; i < px.length; i++) px[i] = Math.floor(r() * 256);
    for (const normal of [false, true]) {
      let tex;
      if (normal) {
        const rgb = new Uint8Array(w * h * 3);
        for (let i = 0; i < rgb.length; i++) rgb[i] = Math.floor(r() * 256);
        tex = surfacePixelsToNormalTexture(rgb, w, h);
      } else {
        tex = surfacePixelsToTexture(px, w, h);
      }
      const ref = pages.admit(tex);
      if (!ref || ref.deferred) { out.firstMismatch = out.firstMismatch || `admit refused ${w}x${h}`; out.mismatchedLevels++; continue; }
      out.textures++;
      const levels = ref.page.desc.levels;
      for (let l = 0; l < levels; l++) {
        compare(`${normal ? "normal" : "albedo"} ${w}x${h} #${k} level ${l}`, pages.readTexture2D(tex, l), pages.readLayer(ref.page, ref.layer, l));
      }
    }
    // Scratch path: pixels with no texture, against a legacy texture of the same pixels.
    const ck = `scratch:${k}`;
    const sref = pages.admitPixels(px, w, h, { anisotropy: renderer.capabilities.getMaxAnisotropy() }, ck);
    if (sref && !sref.deferred) {
      out.scratch++;
      const legacy = surfacePixelsToTexture(px, w, h);
      for (let l = 0; l < sref.page.desc.levels; l++) {
        const a = pages.readTexture2D(legacy, l);
        const b = pages.readLayer(sref.page, sref.layer, l);
        let bad = a.length !== b.length;
        for (let i = 0; !bad && i < a.length; i++) if (a[i] !== b[i]) bad = true;
        if (bad) out.scratchMismatch++;
      }
    }
  });
  out.pages = pages.alloc.pages.length;
  out.summary = pages.summary();
  out.glError = renderer.getContext().getError();
  return out;
}

// ---------------------------------------------------------------------------
// Arm: texel (the K3 consumer, legacy vs batch across two page loads)
// ---------------------------------------------------------------------------
// The census case (insect cloud: an ARRAY draw for its two 64x64 surfaces
// plus a SAME draw for the 32x64 one), a ClipMap pair (an alpha-tested ARRAY
// draw whose slots carry the paletted 100/255 and the DDS 200/255 refs), a
// butterfly (one ClipMap surface: a SAME draw) and a translucent setup (stays
// legacy).
export const TEXEL_SETUPS = Object.freeze({ INSECTS: 0x020004b0, CLIPS: 0x02000888, BUTTERFLY: 0x02000493, GHOST: 0x02000777, BUNDLE: 0x02000b00 });
const { INSECTS, CLIPS, BUTTERFLY, GHOST, BUNDLE } = TEXEL_SETUPS;
const ANIM = { [INSECTS]: 0x03000700, [CLIPS]: 0x03000889, [BUTTERFLY]: 0x030006cb, [GHOST]: 0x03000778, [BUNDLE]: 0x03000b00 };
// Part -> surfaces of the bundle setup: A + B (64x64) share an ARRAY draw,
// C (32x64) a SAME draw; part 4 carries C and A over one grid whose middle
// row of vertices both surfaces' triangles use.
const BUNDLE_SURFS = [[0x08000b0a], [0x08000b0b], [0x08000b0a], [0x08000b0c], [0x08000b0c, 0x08000b0a]];
const PARTS = {
  [INSECTS]: [0x0800007a, 0x0800007b, 0x0800007b, 0x0800007c, 0x0800007b, 0x0800007b, 0x0800007c],
  [CLIPS]: [0x0800128c, 0x0800128d, 0x0800128c, 0x0800128d],
  [BUTTERFLY]: [0x0800128e, 0x0800128e],
  [GHOST]: [0x08000999, 0x08000999],
  [BUNDLE]: BUNDLE_SURFS.map((l) => l[0]), // part count (its geometry comes from the bundle)
};
const SURF = {
  0x0800007a: { w: 64, h: 64, flags: 0x2 },
  0x0800007b: { w: 32, h: 64, flags: 0x2 },
  0x0800007c: { w: 64, h: 64, flags: 0x2, diffuse: 0.55 },
  0x0800128c: { w: 128, h: 64, flags: 0x4, hasPalette: true },
  0x0800128d: { w: 128, h: 64, flags: 0x4, hasPalette: false },
  0x0800128e: { w: 64, h: 32, flags: 0x4, hasPalette: false },
  0x08000999: { w: 16, h: 16, flags: 0x10, translucency: 0.4 },
  0x08000b0a: { w: 64, h: 64, flags: 0x2 },
  0x08000b0b: { w: 64, h: 64, flags: 0x2, diffuse: 0.8 },
  0x08000b0c: { w: 32, h: 64, flags: 0x2 },
};
const PART_SPACING = 2.0;
const PART_HALF = 0.75;

/**
 * The bundle setup's HBG1 model: per part a 3x3 vertex grid (2x2 quads, the
 * texel arm's quad footprint and tilt, uv 0..2) in ONE shared stream of 45
 * vertices, a 16-bit index naming each part's own vertices (shared corners).
 */
export function texelBundleModel(T) {
  const positions = [], normals = [], uvs = [], index = [], parts = [];
  BUNDLE_SURFS.forEach((surfs, p) => {
    const base = positions.length / 3;
    const tilt = 0.25 * ((p % 3) - 1);
    const n = new T.Vector3(0, -2 * tilt / (2 * PART_HALF), 1).normalize();
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        const x = p * PART_SPACING - PART_HALF + c * PART_HALF;
        const y = -PART_HALF + r * PART_HALF;
        positions.push(x, y, -tilt + r * tilt);
        normals.push(n.x, n.y, n.z);
        uvs.push(c, r);
      }
    }
    const quads = (rows) => {
      const first = index.length;
      for (const r of rows) {
        for (let c = 0; c < 2; c++) {
          const a = base + r * 3 + c;
          index.push(a, a + 1, a + 4, a, a + 4, a + 3);
        }
      }
      return { firstIndex: first, indexCount: index.length - first };
    };
    const subsets = surfs.length === 1
      ? [{ surfaceDid: surfs[0], flags: 0, ...quads([0, 1]) }]
      : [{ surfaceDid: surfs[0], flags: 0, ...quads([0]) }, { surfaceDid: surfs[1], flags: 0, ...quads([1]) }];
    parts.push({ subsets });
  });
  return { id: BUNDLE, positions, normals, uvs, index, parts };
}

function animFrames(T, numParts, seed) {
  const out = [];
  for (let f = 0; f < 8; f++) {
    for (let p = 0; p < numParts; p++) {
      const a = (f / 8) * Math.PI * 2 + p * 0.37 + seed;
      // Small motion about the setup origin: part p (baked around x = p *
      // spacing) moves < 0.2 m, so parts never overlap each other.
      const q = new T.Quaternion().setFromAxisAngle(new T.Vector3(0.2, 0.3, 1).normalize(), 0.012 * Math.sin(a));
      out.push(0.05 * Math.sin(a), 0.08 * Math.cos(a), 0.1 * Math.sin(a), q.w, q.x, q.y, q.z);
    }
  }
  return new Float32Array(out);
}

function texelWasm(T) {
  const quad = (sid, p) => {
    const x0 = p * PART_SPACING - PART_HALF, x1 = p * PART_SPACING + PART_HALF;
    const y0 = -PART_HALF, y1 = PART_HALF;
    const tilt = 0.25 * ((p % 3) - 1);
    // Two triangles, uv 0..2 (exercises Repeat), a slight tilt per part.
    const pos = [x0, y0, -tilt, x1, y0, -tilt, x1, y1, tilt, x0, y0, -tilt, x1, y1, tilt, x0, y1, tilt];
    const uv = [0, 0, 2, 0, 2, 2, 0, 0, 2, 2, 0, 2];
    const n = new T.Vector3(0, -2 * tilt / (2 * PART_HALF), 1).normalize();
    return {
      triCount: 2,
      positions: new Float32Array(pos),
      uvs: new Float32Array(uv),
      normals: new Float32Array([n.x, n.y, n.z, n.x, n.y, n.z, n.x, n.y, n.z, n.x, n.y, n.z, n.x, n.y, n.z, n.x, n.y, n.z]),
      surfaceIndices: new Uint8Array([0, 0]),
      surfaces: new Uint32Array([sid]),
    };
  };
  return {
    async fetchAnimation(animId) {
      const setup = Number(Object.keys(ANIM).find((k) => ANIM[k] === (animId >>> 0)));
      const n = PARTS[setup].length;
      return { numParts: n, numFrames: 8, flags: 2, frames: animFrames(T, n, setup & 7), free() {} };
    },
    async fetchBuildingPlacement(setupId) {
      const parts = PARTS[setupId >>> 0];
      return {
        partCount: parts.length,
        takePartMeshes: () => parts.map((sid, p) => quad(sid, p)),
        takePartHingeFrames: () => parts.map(() => ({ x: 0, y: 0, z: 0, qw: 1, qx: 0, qy: 0, qz: 0 })),
        free() {},
      };
    },
    fetch_surfaces_pixels: async () => [],
  };
}

/**
 * Build + pose the census scene through the real modules; returns
 * `{ scene, camera, diag }` after `ticks` fixed ticks (awaiting `pause`
 * between ticks so async program links can complete).
 */
export async function runTexelArm(T, renderer, mods, { ticks = 24, pause = async () => {}, settleMs = 0, now = () => Date.now() } = {}) {
  const AS = mods.animatedScenery;
  const GPU = mods.animSceneryGpu;
  const M = mods.materials;
  const { surfacePixelsToTexture, surfacePixelsToNormalTexture, setAdapterMaxAnisotropy } = mods.adapter;
  setAdapterMaxAnisotropy(renderer.capabilities.getMaxAnisotropy());
  GPU.__setAnimSceneryGpuForTest(true);
  AS.__setAnimSceneryOmegaHzForTest(15);
  const scene = new T.Scene(); // black clear: litPixels counts the critters
  scene.add(new T.AmbientLight(0xffffff, 0.6));
  const sun = new T.DirectionalLight(0xffffff, 1.4);
  sun.position.set(0.3, -0.5, 1);
  scene.add(sun);
  const staticsGroup = new T.Group();
  scene.add(staticsGroup);
  const camera = new T.PerspectiveCamera(50, 1, 0.5, 500);
  camera.up.set(0, 0, 1);
  camera.position.set(8, -16, 20);
  camera.lookAt(8, 16, 0);
  camera.updateMatrixWorld(true);
  if (typeof window !== "undefined") window.liveScene3d = { renderer, camera, scene };
  const cache = new M.MaterialCache();
  const mats = new Map();
  const r = rng(0xbeef);
  const get = async (sid) => {
    if (mats.has(sid)) return mats.get(sid);
    const s = SURF[sid];
    const px = new Uint8Array(s.w * s.h * 4);
    for (let i = 0; i < px.length; i += 4) {
      px[i] = Math.floor(r() * 256); px[i + 1] = Math.floor(r() * 256); px[i + 2] = Math.floor(r() * 256);
      // Alpha: a real cutout pattern on the ClipMap surface, opaque elsewhere.
      px[i + 3] = s.flags === 0x4 ? (((i >> 2) % s.w) * 7 + ((i >> 2) / s.w | 0) * 3) % 255 : 255;
    }
    const nrm = new Uint8Array(s.w * s.h * 3);
    for (let i = 0; i < nrm.length; i += 3) { nrm[i] = 110 + Math.floor(r() * 40); nrm[i + 1] = 110 + Math.floor(r() * 40); nrm[i + 2] = 230; }
    const m = cache._materialFromFlags(s.flags, surfacePixelsToTexture(px, s.w, s.h), undefined,
      surfacePixelsToNormalTexture(nrm, s.w, s.h), undefined, null,
      { translucency: s.translucency ?? 0, luminosity: 0, diffuse: s.diffuse ?? 1, hasPalette: s.hasPalette });
    mats.set(sid, m);
    return m;
  };
  const placements = [];
  let i = 0;
  // The bundle setup only when the caller supplies geom_bundles.js (its
  // geometry is served as an HBG1 bundle, exactly as ?geomBundles does).
  const GB = mods.geomBundles || null;
  const setups = GB ? [INSECTS, CLIPS, BUTTERFLY, GHOST, BUNDLE] : [INSECTS, CLIPS, BUTTERFLY, GHOST];
  const rows = { [INSECTS]: 0, [CLIPS]: 1, [BUTTERFLY]: 2, [GHOST]: 3, [BUNDLE]: 4 };
  for (const setup of setups) {
    for (let k = 0; k < 2; k++) {
      const q = new T.Quaternion().setFromAxisAngle(new T.Vector3(0, 0, 1), 0.1 * (k - 0.5));
      placements.push({ objId: setup, defaultAnimationId: ANIM[setup], landblockId: 0, sourceObjIdx: ++i,
        x: k * 1.3 + rows[setup] * 0.9, y: 2 + 7 * rows[setup] + 3.2 * k, z: 1 + k * 0.6 + rows[setup] * 0.3,
        qw: q.w, qx: q.x, qy: q.y, qz: q.z, scale: 1 });
    }
  }
  if (GB) GB._testArm(bundleWasmExports({ [BUNDLE]: texelBundleModel(T) }));
  let res;
  try {
    res = await AS.attachAnimatedScenery({ staticsGroup, materialCache: { get } }, placements, texelWasm(T), {});
  } finally {
    if (GB) GB._testDisarm();
  }
  for (let k = 0; k < ticks; k++) {
    AS.tickAnimatedScenery(1 / 30);
    await pause();
  }
  // With the batch armed, let its class programs finish linking and its
  // overlap frames pass (the batch draws next to the legacy buckets until
  // three has drawn each class material once): zero-dt ticks change no pose,
  // and the renders in between are what ends the overlap.
  const t0 = now();
  const settled = () => {
    const b = AS.animatedSceneryDiag().batch;
    return !b || ((b.byStatus.active | 0) + (b.byStatus.legacy | 0)) === (b.groups | 0);
  };
  while (settleMs > 0 && !settled() && now() - t0 < settleMs) {
    AS.tickAnimatedScenery(0);
    scene.updateMatrixWorld(true);
    renderer.render(scene, camera);
    await pause();
  }
  scene.updateMatrixWorld(true);
  const diag = AS.animatedSceneryDiag();
  return { scene, camera, built: res.built, diag, bundle: GB ? bundleSummary(staticsGroup) : null };
}

/** The bundle setup's buckets and batch draws (premises for the smoke). */
function bundleSummary(group) {
  const tag = BUNDLE.toString(16);
  const legacy = group.children.filter((o) => o.isInstancedMesh && o.name.startsWith(`anim-inst-0x${tag}-`));
  const batch = group.children.filter((o) => o.isInstancedMesh && o.userData?.animSceneryBatch && o.name.startsWith(`anim-batch-0x${tag}-`));
  const streams = new Set(legacy.map((m) => m.geometry.attributes.position.array.buffer));
  return {
    buckets: legacy.length,
    sharedStream: legacy.length > 0 && streams.size === 1 && legacy.every((m) => m.geometry.attributes.position.count === 45),
    indexed: legacy.length > 0 && legacy.every((m) => !!m.geometry.index) && batch.every((m) => !!m.geometry.index),
    batchDraws: batch.length,
    referencedVertices: legacy.reduce((n, m) => n + new Set(m.geometry.index ? Array.from(m.geometry.index.array) : []).size, 0),
    mergedVertices: batch.length ? batch.reduce((n, m) => n + m.geometry.attributes.position.count, 0) : null,
  };
}

// ---------------------------------------------------------------------------
// Arm: f32 composition (legacy absolute instance matrices vs kit origin rows)
// ---------------------------------------------------------------------------
export function runF32Arm(T, renderer, mods, { baseX = 150, baseY = 120 } = {}) {
  const RT = mods.rowTexture;
  const r = rng(0xf32);
  const N = 48;
  const LB_ORIGIN = [Math.floor(baseX / 192) * 192, Math.floor(baseY / 192) * 192, 0];
  const tex = mods.adapter.surfacePixelsToTexture((() => {
    const px = new Uint8Array(64 * 64 * 4);
    for (let i = 0; i < px.length; i++) px[i] = (i & 3) === 3 ? 255 : Math.floor(r() * 256);
    return px;
  })(), 64, 64);
  const geo = new T.BoxGeometry(1.6, 1.6, 1.6);
  const mats = [];
  const abs = [];
  for (let k = 0; k < N; k++) {
    const q = new T.Quaternion().setFromEuler(new T.Euler(r() * 3, r() * 3, r() * 3));
    const p = new T.Vector3(baseX + (k % 8) * 3.1 + r(), baseY + Math.floor(k / 8) * 3.3 + r(), 2 + r() * 2);
    abs.push(new T.Matrix4().compose(p, q, new T.Vector3(1, 1, 1)));
  }
  const camera = new T.PerspectiveCamera(55, 1, 0.5, 400);
  camera.up.set(0, 0, 1);
  camera.position.set(baseX + 11, baseY - 14, 22);
  camera.lookAt(baseX + 11, baseY + 9, 2);
  camera.updateMatrixWorld(true);
  const lights = () => {
    const g = new T.Group();
    g.add(new T.AmbientLight(0xffffff, 0.5));
    const d = new T.DirectionalLight(0xffffff, 1.5);
    d.position.set(baseX + 0.4, baseY - 0.6, 1);
    d.target.position.set(baseX, baseY, 0);
    g.add(d, d.target);
    return g;
  };
  // Legacy: absolute f32 instance matrices.
  const sceneA = new T.Scene();
  sceneA.add(lights());
  const matA = new T.MeshStandardMaterial({ map: tex, roughness: 0.8 });
  mats.push(matA);
  const meshA = new T.InstancedMesh(geo, matA, N);
  abs.forEach((m, k) => meshA.setMatrixAt(k, m));
  meshA.frustumCulled = false;
  sceneA.add(meshA);
  // Kit: rows (LB-local matrix + origin row index), origin row = (origin - camera) in f64.
  const rows = new RT.RowTexture({ texelsPerRow: 5, rows: 64, name: "f32-rows" });
  const origins = new RT.OriginTable(rows);
  const slot = origins.acquire("lb", LB_ORIGIN[0], LB_ORIGIN[1], LB_ORIGIN[2]);
  const oRow = origins.rowOf(slot);
  const rowIdx = new Float32Array(N);
  abs.forEach((m, k) => {
    const row = rows.alloc();
    const local = m.clone();
    local.elements[12] -= LB_ORIGIN[0]; local.elements[13] -= LB_ORIGIN[1]; local.elements[14] -= LB_ORIGIN[2];
    rows.writeMat4(row, 0, local.elements);
    rows.writeVec4(row, 4, oRow, 0, 0, 0);
    rowIdx[k] = row;
  });
  origins.writeCameraRelative(camera.position.x, camera.position.y, camera.position.z);
  rows.flush();
  const geoB = geo.clone();
  geoB.setAttribute("hbRow", new T.InstancedBufferAttribute(rowIdx, 1));
  const matB = new T.MeshStandardMaterial({ map: tex, roughness: 0.8 });
  const chunk = RT.instanceRedirectChunk({ sampler: "hbRowTex", rowAttr: "hbRow", matrixTexel: 0, originTexel: 4 });
  matB.onBeforeCompile = (sh) => {
    sh.uniforms.hbRowTex = rows.uniform;
    RT.injectVertexHeader(sh, chunk, RT.ROW_REDIRECT_MARKER, "hbBatchRowSetup");
  };
  matB.customProgramCacheKey = () => "gpu-batch-f32-arm";
  mats.push(matB);
  const sceneB = new T.Scene();
  sceneB.add(lights());
  const meshB = new T.InstancedMesh(geoB, matB, N);
  for (let k = 0; k < N; k++) meshB.setMatrixAt(k, new T.Matrix4()); // replaced by the redirect
  meshB.frustumCulled = false;
  RT.anchorAtCamera(meshB, camera.position.x, camera.position.y, camera.position.z);
  sceneB.add(meshB);
  sceneA.updateMatrixWorld(true);
  sceneB.updateMatrixWorld(true);
  return { sceneA, sceneB, camera };
}
