// harness/glsl_smoke/entity_batch_lib.mjs — the `?entityBatch` scenario
// (R3-4 stage A, scene3d/gpu_batch/entity_batch.js), shared by the node
// suites (tests/entity_batch_rig.mjs) and the SwiftShader smoke
// (entity_batch_page.html / entity_batch_smoke.mjs). Browser-safe: no node
// imports; THREE and the app modules are passed in.
//
// The rigs are 17-part humans shaped after the census (r3-4/human_detail.mjs:
// several distinct texture sizes, all Base1Image; a ClipMap; a translucency-1
// placeholder that renders nothing), spawned through the REAL EntityManager
// with a mock wasm whose surfaces and clip are synthetic but deterministic.
// The recolored path (paletteId != 0) composes per-(did, palette) pixels; two
// rigs with the same palette and different subpalette lists compose EQUAL
// bytes (the value-keyed layer case).

export const SETUP = 0x02000001;
export const READY = 0x41000003;
export const WALK = 0x45000005;

export const D = Object.freeze({
  A: 0x08000a01, B: 0x08000a02, C: 0x08000a03, E: 0x08000a04, H1: 0x08000a05, H2: 0x08000a06,
  CLIP: 0x08000a07, NOTHING: 0x08000015, TRANS: 0x08000a08, LUM: 0x08000a09, A2: 0x08000a0a,
});
export const SURF = Object.freeze({
  [D.A]: { w: 64, h: 64, flags: 0x2 },
  [D.A2]: { w: 64, h: 64, flags: 0x2 },
  [D.B]: { w: 64, h: 128, flags: 0x2 },
  [D.C]: { w: 32, h: 32, flags: 0x2 },
  [D.E]: { w: 128, h: 64, flags: 0x2 },
  [D.H1]: { w: 32, h: 64, flags: 0x2 },
  [D.H2]: { w: 64, h: 32, flags: 0x2 },
  [D.CLIP]: { w: 64, h: 64, flags: 0x4, hasPalette: true },
  [D.NOTHING]: { w: 4, h: 4, flags: 0x10, translucency: 1 },
  [D.TRANS]: { w: 32, h: 32, flags: 0x10, translucency: 0.4 },
  [D.LUM]: { w: 32, h: 32, flags: 0x2, luminosity: 0.6 },
});
/** Part -> its surfaces, 17 parts like the human (part 16 = the head: three surfaces). */
export const HUMAN_PARTS = Object.freeze([
  [D.A], [D.B], [D.B], [D.A], [D.C], [D.A], [D.B], [D.C], [D.E],
  [D.A, D.NOTHING], [D.B], [D.C], [D.E], [D.CLIP], [D.A2], [D.C], [D.H1, D.H2, D.A],
]);
/** The same rig with a translucent and a luminous surface (legacy-leaf arms). */
export const MIXED_PARTS = Object.freeze([
  [D.A], [D.B], [D.TRANS], [D.A], [D.C], [D.LUM], [D.B], [D.C], [D.E],
  [D.A], [D.B], [D.C], [D.E], [D.CLIP], [D.A2], [D.C], [D.H1, D.H2, D.A],
]);

export function pixelsFor(did, salt = 0) {
  const s = SURF[did >>> 0];
  const px = new Uint8Array(s.w * s.h * 4);
  for (let i = 0; i < px.length; i += 1) px[i] = (((i * 31) ^ (i >> 7)) + did * 7 + salt * 13) & 255;
  if (s.flags & 0x4) for (let i = 3; i < px.length; i += 4) px[i] = ((i >> 2) % 3 === 0) ? 40 : 255; // a cut-out
  return px;
}

/** Part meshes as the wasm hands them (triCount, positions, uvs, normals, per-triangle surface index). */
export function partMeshesFor(THREE, parts, frontParts = null) {
  return parts.map((dids, p) => {
    const n = dids.length * 2;
    const positions = new Float32Array(n * 9);
    const uvs = new Float32Array(n * 6);
    const normals = new Float32Array(n * 9);
    const sIdx = new Uint8Array(n);
    for (let t = 0; t < n; t += 1) {
      const x = 0.05 * p + 0.01 * t, z = 0.02 * t;
      positions.set([x - 0.15, 0, z, x + 0.15, 0, z, x, 0.02, z + 0.3], t * 9);
      uvs.set([0, 0, 1, 0, 0.5, 1], t * 6);
      const nz = new THREE.Vector3(0.01 * t, -1, 0.02 * p).normalize();
      normals.set([nz.x, nz.y, nz.z, nz.x, nz.y, nz.z, nz.x, nz.y, nz.z], t * 9);
      sIdx[t] = t >> 1;
    }
    const out = { triCount: n, positions, uvs, normals, surfaceIndices: sIdx, surfaces: Uint32Array.from(dids) };
    // ?perPolyCull: single-sided polygons (sides_type != 1) -> FrontSide groups.
    if (frontParts) out.sidesTypes = new Uint8Array(n).fill(frontParts.has(p) ? 0 : 1);
    return out;
  });
}

/**
 * A deterministic part clip: `nf` frames of (x, y, z, qw, qx, qy, qz) per
 * part — a body-like rest layout with a per-part wobble (no root motion).
 */
export function clipFor(THREE, pc, nf, seed = 1) {
  const out = new Float32Array(nf * pc * 7);
  const q = new THREE.Quaternion();
  const ax = new THREE.Vector3();
  for (let f = 0; f < nf; f += 1) {
    for (let p = 0; p < pc; p += 1) {
      const a = (f / nf) * Math.PI * 2 + p * 0.37 + seed;
      ax.set(0.2 + 0.01 * p, 0.3, 1).normalize();
      q.setFromAxisAngle(ax, 0.4 * Math.sin(a));
      const o = (f * pc + p) * 7;
      out[o] = 0.08 * ((p % 5) - 2); out[o + 1] = 0.05 * ((p % 3) - 1); out[o + 2] = 0.1 + 0.1 * p + 0.03 * Math.sin(a);
      out[o + 3] = q.w; out[o + 4] = q.x; out[o + 5] = q.y; out[o + 6] = q.z;
    }
  }
  return out;
}

/** The mock wasm exports `_spawnImpl` reads. */
export function wasmFor(THREE, parts = HUMAN_PARTS, frontParts = null) {
  const pc = parts.length;
  const clips = { [READY]: { nf: 12, frames: clipFor(THREE, pc, 12, 0.5) }, [WALK]: { nf: 30, frames: clipFor(THREE, pc, 30, 1.3) } };
  const calls = { surfaces: 0, anims: 0 };
  return {
    calls,
    async fetchEntityAnimationKeyframes(_s, _mc, _tc, _pal, _subs, _mt, cmd, stance, fromMotion) {
      calls.anims += 1;
      const c = (fromMotion >>> 0) ? null : clips[cmd >>> 0];
      const nf = c ? c.nf : 0;
      const meshes = partMeshesFor(THREE, parts, frontParts);
      return {
        partCount: pc, numFrames: nf, framerate: nf ? 30 : 0, duration: nf / 30,
        frameTimes: Float32Array.from({ length: nf }, (_, f) => f / 30),
        segmentStarts: nf ? Uint32Array.of(0) : new Uint32Array(0),
        segmentCounts: nf ? Uint32Array.of(nf) : new Uint32Array(0),
        resolvedStance: stance || 0x3d,
        partFrames: c ? c.frames : new Float32Array(0),
        takePartMeshes() { return meshes.splice(0); },
        takeHooks() { return []; },
      };
    },
    // The recolored path: per-(did, palette) pixels + the Surface state floats.
    // The subpalette list does not change the bytes (equal composites).
    async fetchEntitySurfacesPixels(dids, paletteId) {
      calls.surfaces += 1;
      return Array.from(dids, (did) => {
        const s = SURF[did >>> 0];
        return {
          pixels: pixelsFor(did >>> 0, paletteId & 0xff), width: s.w, height: s.h,
          surfaceType: s.flags, translucency: s.translucency ?? 0, luminosity: s.luminosity ?? 0,
          diffuse: 0, hasPalette: s.hasPalette, free() {},
        };
      });
    },
    async fetchSetupPlacementFrames() { return { takeFrames: () => [] }; },
  };
}

/**
 * A real MaterialCache whose plain surfaces were built by its own ladder
 * (`_materialFromFlags` over adapter.js textures), installed as getCached
 * would find them. `clamp`: install materials.js's light clamp the way the
 * cache's default patch set does (the cache-member chain).
 */
/**
 * A seam-height plane (POM arms): 255 = proud face, joints dip toward 0
 * (holtburger_dat::height_seam's convention), a brick bond per surface.
 */
export function heightPixelsFor(did) {
  const s = SURF[did >>> 0];
  const a = new Uint8Array(s.w * s.h);
  for (let y = 0; y < s.h; y += 1) {
    for (let x = 0; x < s.w; x += 1) {
      const joint = (y & 7) === 0 || (((x + ((y >> 3) & 1) * 8 + did) & 15) === 0);
      a[y * s.w + x] = joint ? 30 + ((x * 5 + y) & 15) : 235 + ((x + y + did) & 15);
    }
  }
  return a;
}

/**
 * The rigs' MaterialCache (cache path: every SURF installed). `opts.clamp`:
 * the retail light clamp chain on the plain ones. `opts.pom` (2026-10-31):
 * built the way the ultra preset builds it (`pomEnabled`), every surface with
 * a normal and a seam-height plane and the Stone category, so materials.js's
 * own `_materialFromFlags` installs its POM patch (+ the light clamp after it)
 * on every opaque / ClipMap surface.
 */
export function materialCacheFor(M, adapter, opts = {}) {
  const mc = new M.MaterialCache(opts.pom ? { pomEnabled: true } : undefined);
  for (const k of Object.keys(SURF)) {
    const did = Number(k) >>> 0;
    const s = SURF[did];
    const tex = adapter.surfacePixelsToTexture(pixelsFor(did), s.w, s.h);
    let ntex, htex, cat;
    if (opts.pom) {
      const n = new Uint8Array(s.w * s.h * 3);
      for (let i = 0; i < s.w * s.h; i += 1) { n[i * 3] = 118 + ((i * 7 + did) & 15); n[i * 3 + 1] = 120 + ((i * 3) & 15); n[i * 3 + 2] = 250; }
      ntex = adapter.surfacePixelsToNormalTexture(n, s.w, s.h);
      htex = adapter.surfacePixelsToHeightTexture(heightPixelsFor(did), s.w, s.h);
      cat = M.SURFACE_CATEGORY.Stone;
    }
    const m = mc._materialFromFlags(s.flags, tex, cat, ntex, undefined, htex,
      { translucency: s.translucency ?? 0, luminosity: s.luminosity ?? 0, diffuse: 1, hasPalette: s.hasPalette });
    m.userData = { ...(m.userData || {}), __cacheOwned: true };
    if (opts.clamp && typeof M.installLightClampShaderPatch === "function" && m.onBeforeCompile === Object.getPrototypeOf(m).onBeforeCompile) {
      M.installLightClampShaderPatch(m);
    }
    mc.materials.set(did, m);
  }
  mc.preload = async () => {};
  return mc;
}

export function spawnMeta(guid, x, y, z, opts = {}) {
  return {
    guid, modelId: SETUP, mtableId: 0x09000001,
    landblockId: opts.landblockId ?? 0xa9b40001, x, y, z, qw: 1, qx: 0, qy: 0, qz: 0,
    paletteId: opts.paletteId ?? 0, motionCommand: opts.motion ?? WALK, motionStance: 0, objScale: 1, name: "t",
    wcid: 1, itemType: 0x10, iconId: 0,
    modelChanges: new Uint32Array(0), textureChanges: new Uint32Array(0),
    subPalettes: opts.subPalettes ?? new Uint32Array(0),
  };
}

/** A minimal stand-in for the wasm MotionSequence (harness/lib/fake_motion_sequence.mjs, browser copy). */
export class SmokeMotionSequence {
  static fromDescriptor(numFrames, framerate, duration, _ft, _ss, _sc, cyclic) {
    const n = numFrames >>> 0;
    if (n === 0) return null;
    const s = new SmokeMotionSequence();
    s.numFrames = n; s.framerate = +framerate > 0 ? +framerate : 30; s.duration = +duration > 0 ? +duration : n / s.framerate;
    s.cyclic = !!cyclic; s.t = 0; s._done = false;
    return s;
  }
  advance(dt) { if (!(dt > 0) || this._done) return; this.t += dt; if (this.cyclic) this.t %= this.duration; else if (this.t >= this.duration) { this.t = this.duration; this._done = true; } }
  get globalFrameIndex() { return Math.max(0, Math.min(this.numFrames - 1, Math.floor(this.t * this.framerate))); }
  get done() { return this._done; }
  get phase() { return this.duration > 0 ? this.t / this.duration : 0; }
  seekPhase(p) { this.t = (((+p % 1) + 1) % 1) * this.duration; }
  reset() { this.t = 0; this._done = false; }
  free() { this.__wbg_ptr = 0; }
}
SmokeMotionSequence.prototype.__wbg_ptr = 1;

/**
 * The smoke's scene (both loads build it identically): a world root like the
 * app's (rotation.x = -pi/2), an entities group on layer 1, lights, a camera
 * aimed at the rigs. Returns { scene, camera, entitiesGroup, aim }.
 */
export function smokeScene(THREE, width = 192, height = 192) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x101418);
  const worldRoot = new THREE.Group();
  worldRoot.name = "worldRoot";
  worldRoot.rotation.x = -Math.PI / 2;
  scene.add(worldRoot);
  const entitiesGroup = new THREE.Group();
  entitiesGroup.name = "entities";
  entitiesGroup.layers.set(1);
  worldRoot.add(entitiesGroup);
  const amb = new THREE.AmbientLight(0xffffff, 0.6);
  amb.layers.enable(1);
  scene.add(amb);
  const sun = new THREE.DirectionalLight(0xffffff, 1.2);
  sun.position.set(3, 10, 4);
  sun.layers.enable(1);
  scene.add(sun);
  const camera = new THREE.PerspectiveCamera(50, width / height, 0.1, 500);
  camera.layers.enable(1);
  const aim = (root, dist = 3.2) => {
    scene.updateMatrixWorld();
    const p = new THREE.Vector3();
    root.getWorldPosition(p);
    camera.position.set(p.x + 0.9, p.y + 1.0, p.z + dist);
    camera.lookAt(p.x + 0.9, p.y + 0.8, p.z);
    camera.updateMatrixWorld();
  };
  return { scene, camera, entitiesGroup, worldRoot, aim };
}

// ===========================================================================
// The smoke arms (entity_batch_page.html; dry-run in node by
// tests/entity_batch_lifecycle.test.mjs). One arm = one page load; the
// runner loads each arm with the flag off and on and diffs the frames.
// ===========================================================================

/** Frames stepped before the measured frame (both loads: identical poses). */
export const SMOKE_FRAMES = 40;

/**
 * Build and step one arm. `mods`: { entities, entityBatch, kit, materials,
 * adapter, selectionLighting }. `arm`:
 *   humans    a plain human + two recolored ones whose composites are equal
 *             (paletted layers, value-keyed) + one of another palette;
 *             ClipMap paletted parts (alpha ref 100/255) included;
 *   clamp     cache materials carrying the retail light clamp (the chain);
 *   mixed     a translucent and a luminous surface: legacy leaves inside a
 *             batched rig;
 *   front     `?perPolyCull` FrontSide parts (a FrontSide class);
 *   flash     a selection-flashed rig (the demote arm: drawn legacy, lit);
 *   overlap   the frame drawn while batch and legacy leaves both draw;
 *   pom       (2026-10-31) cache materials carrying materials.js's POM patch
 *             (+ light clamp) on every opaque / ClipMap surface, the camera
 *             inside the POM LOD band (full strength below 5 m): POM classes
 *             (height layers + POM extension rows). `pom: true` gives any arm
 *             the POM cache (the layers arm's R8 readback).
 * Returns { scene, camera, em, stats, batchDraws, status }.
 */
export async function runEntityArm(THREE, renderer, mods, { arm = "humans", batch = false, frames = SMOKE_FRAMES, pause = async () => {}, readFrame = null, pom = false } = {}) {
  const w = globalThis.window;
  w.__hbWasm = { ...(w.__hbWasm || {}), MotionSequence: w.__hbWasm?.MotionSequence || SmokeMotionSequence };
  mods.kit.resetKit();
  mods.entityBatch.__setEntityBatchForTest(batch);
  const { scene, camera, entitiesGroup, aim } = smokeScene(THREE, renderer.domElement?.width || 192, renderer.domElement?.height || 192);
  let ts = 1000;
  w.liveScene3d = { renderer, camera, scene, frameTime: { tsMs: ts, tsSec: 1, dt: 0 } };
  const front = arm === "front" ? new Set([1, 2, 6, 10]) : null;
  if (front) globalThis.__perPolyCull = true;
  const mc = materialCacheFor(mods.materials, mods.adapter, { clamp: arm === "clamp", pom: pom || arm === "pom" });
  const parts = arm === "mixed" ? MIXED_PARTS : HUMAN_PARTS;
  const em = new mods.entities.EntityManager({ entitiesGroup, materialCache: mc }, wasmFor(THREE, parts, front));
  em._tweenClockMs = 1000;
  const rigs = [];
  const spawn = async (guid, x, o) => { const inst = await em.spawn(spawnMeta(guid, x, 10, 0, o)); rigs.push(inst); return inst; };
  try {
    await spawn(0x50001001, 10);
    if (arm === "humans" || arm === "overlap") {
      await spawn(0x50001002, 10.9, { paletteId: 0x04000a01, subPalettes: Uint32Array.of(0x0400aa01, 0, 8) });
      await spawn(0x50001003, 11.8, { paletteId: 0x04000a01, subPalettes: Uint32Array.of(0x0400bb02, 0, 8) });
      await spawn(0x50001004, 12.7, { paletteId: 0x04000a02, subPalettes: Uint32Array.of(0x0400aa01, 0, 8) });
    } else {
      await spawn(0x50001002, 10.9, { paletteId: 0x04000a01 });
    }
  } finally { if (front) globalThis.__perPolyCull = false; }
  // (pom: 2 rigs -> 3.8 m, inside the POM band; the march runs at full strength.)
  aim(rigs[Math.floor(rigs.length / 2)].root, 2.6 + 0.6 * rigs.length);
  const step = () => {
    ts += 16.7;
    w.liveScene3d.frameTime = { tsMs: ts, tsSec: ts / 1000, dt: 1 / 60 };
    em.tick(1 / 60);
    renderer.render(scene, camera);
  };
  const out = { scene, camera, em, rigs, step, overlap: null };
  if (arm === "overlap") {
    // The first frame every rig is built and at least one batch draws NEXT TO
    // its legacy leaves ("overlap"; the others may already be active): that
    // frame (A) against the same poses with the OVERLAP rigs' batch meshes
    // hidden (B: their legacy leaves alone).
    const st = (r) => (r._hbBatch ? r._hbBatch.status : "off");
    let n = 0;
    while (n < 300 && !(rigs.some((r) => st(r) === "overlap") && rigs.every((r) => st(r) === "overlap" || st(r) === "active"))) { step(); await pause(); n += 1; }
    const meshes = rigs.filter((r) => st(r) === "overlap").map((r) => r._hbBatch.mesh);
    renderer.render(scene, camera);
    const a = readFrame ? readFrame() : null;
    for (const m of meshes) m.visible = false;
    renderer.render(scene, camera);
    const b = readFrame ? readFrame() : null;
    for (const m of meshes) m.visible = true;
    out.overlap = { frames: n, overlapRigs: meshes.length, built: rigs.filter((r) => r._hbBatch && r._hbBatch.mesh).length, a, b };
  } else {
    for (let i = 0; i < frames; i += 1) { step(); await pause(); }
    if (arm === "flash") {
      const { LIGHTING_MODE } = mods.selectionLighting;
      em._applySelectionLighting(rigs[0].guid, LIGHTING_MODE.HIGH);
      step();
    }
  }
  const eb = em._entityBatch;
  out.status = rigs.map((r) => (r._hbBatch ? r._hbBatch.status : "off"));
  out.stats = eb ? eb.stats() : null;
  out.verify = eb ? eb.verify() : null;
  return out;
}

/**
 * Every layer the batch admitted, every level, read back next to the same
 * level of the legacy 2D texture three uploads for the member's map (the
 * value-keyed composites included: their layers came through the
 * admitPixels scratch, or (2026-10-31) straight from the resident legacy
 * texture's own levels via ArrayPages.admitAs). `pages`: kitPages(renderer).
 */
export function readbackLayers(eb, pages) {
  const out = { layers: 0, levels: 0, mismatched: 0, first: null, value: 0, pom: 0 };
  const seen = new Set();
  const cmp = (page, layer, tex, key) => {
    for (let l = 0; l < page.desc.levels; l += 1) {
      const a = pages.readLayer(page, layer, l);
      const t = pages.readTexture2D(tex, l);
      out.levels += 1;
      let same = a.length === t.length;
      for (let i = 0; same && i < a.length; i += 1) if (a[i] !== t[i]) same = false;
      if (!same) { out.mismatched += 1; if (!out.first) out.first = { key, level: l }; }
    }
  };
  for (const b of eb._records) {
    if (!b.plan) continue;
    for (const [m, row] of b.plan.memberRefs) {
      if (!seen.has(row.contentKey)) {
        seen.add(row.contentKey);
        out.layers += 1;
        if (row.contentKey.startsWith("pal:")) out.value += 1;
        cmp(row.page, row.layer, m.map, row.contentKey);
      }
      // POM parts (2026-10-31): the R8 height layer vs the 2D texture the
      // member's POM chain binds (both read back as RGBA8: (r, 0, 0, 255)).
      if (row.pomKey && !seen.has(row.pomKey)) {
        seen.add(row.pomKey);
        out.layers += 1;
        out.pom += 1;
        cmp(row.pomPage, row.pomLayer, row.pom.texture, row.pomKey);
      }
    }
  }
  return out;
}
