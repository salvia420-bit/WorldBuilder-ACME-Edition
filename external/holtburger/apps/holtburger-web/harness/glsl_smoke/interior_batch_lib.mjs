// harness/glsl_smoke/interior_batch_lib.mjs — the arms of the R3-5
// `?interiorBatch` SwiftShader smoke (interior_batch_smoke.mjs runs them in
// headless Chromium through interior_batch_page.html; tests/
// interior_batch_smoke_lib.test.mjs dry-runs them in node on the fake WebGL2).
//
// The world is the node suites' fixture (tests/interior_batch_rig.mjs: one
// landblock of four EnvCells and four props, members from the real
// MaterialCache ladders, built by the real cells.js buildEnvCellsForLandblock
// from a fake wasm; synthetic texels: see the runner's note), here on a REAL
// WebGL2 renderer, seen from close by, lit by an ambient term and a
// shadow-casting sun. `mods` carries the app modules the page imported (so
// the flag the page URL carries is the one cells.js read at module load).
//
// Arms (each loaded twice by the runner: flag off, then `&interiorBatch=on`).
// Every frame is the pipeline's pass order (scene3d/atmosphere_pipeline.js
// preFrameSkySync) with the camera layer masks it sets, driven pass by pass:
//   town      outdoors, the UNSPLIT frame (camera mask BOTH);
//   punch     outdoors, a layer-0 roof over the cells with one doorway: the
//             PUNCH frame — world pass (WORLD_ONLY), the real PortalPunchPass
//             fed by the real cells.js tickPortalPunch (session apertures ->
//             clipAperturesForPunch -> setApertures), cells pass (INDOOR_ONLY,
//             no clear) — plus the world-only frame, so the runner can check
//             the interior shows through the doorway and nowhere else;
//   dungeon   indoors in cell 0: the indoor split arms and narrows the set to
//             the portal walk (cells.js); SPLIT frame (world -> depth clear ->
//             cells);
//   sealed    indoors, a dungeon with no outdoor portal: the SEALED frame
//             (`?indoorLandscapeGate`: the world pass on the empty mask only
//             clears, no depth wipe, then the cells pass);
//   shadow    indoors (interiors cast), the sun shadow map on: the props'
//             shadows on the cell floors, incl. the alpha-tested ClipMap prop
//             surface (a grate: its alpha pattern is in the shadow);
//   shadowmap the shadow arm with three's BasicShadowMap (an unfiltered depth
//             texture), and the sun's shadow map read back (a depth blit into
//             a float target): legacy vs batch casters, texel by texel;
//   layers    flag on only: every admitted layer of every page, every level,
//             read back against the 2D texture three built for the member.
// POOLS (`&pools=1`, realboot 2026-10-31; POOL_ARMS): the same arm with the
// env-cell draw pools ARMED as scene3d/index.js arms them (rig.mjs armPools:
// the BatchedMesh colour-texture fix, initPoolWorld on the statics group,
// armEnvCellPoolGroups on cellsGroup / layer 1; stage A) over the rig's
// POOL_CELLS fixture (page-dim shell surfaces the pools take, the rest
// refused and fused as today): both loads draw the pools, the on load batches
// what they leave on the legacy producer.
// POM (`&pom=1`, 2026-10-31; POM_ARMS): the rig's POM material cache (the
// MaterialCache at `pomEnabled`: materials.js's own patch on every opaque /
// ClipMap surface, normal + seam-height planes) with the cells built
// un-baked, so the cell surfaces draw with the POM BASE materials (the real
// chain: height layers + POM extension rows in the batch) and the props with
// their static-bias clones (flag-only p1: batched as p0). `pom` is the close
// indoor arm (camera ~4 m off cell 0: the march at full strength, the LOD
// fade band around it); `layers&pom=1` reads every R8 height layer back.
// MAPS (`&maps=1`, 2026-10-31; MAP_ARMS): the rig's texchan + luminous
// material cache (rig.mjs materialCache `texchan` / `luminous`: the texchan
// AO + roughness planes attached by materials.js's own _attachRoughnessMap
// from texchan-shaped records, the luminous ladder's emissive alias on two
// surfaces), i.e. the realboot's AO + roughness (+ emissive) members: cells
// and props batch through the class map sets (AO from R8 page layers,
// roughness from RGBA8 linear layers, emissive from the map layer);
// `layers&maps=1` reads every AO / roughness layer back.
// Each arm reports the frame (RGBA bytes), lit pixels, draw calls of the
// frame, the batch diag, whether the decoded bits equal the container set,
// and the sync count the batch needed to settle (the per-sync CPU budget
// spreads its set-up over frames, so an arm ticks until it is live).

import * as R from "../../tests/interior_batch_rig.mjs";

export const CANVAS = 256;
export const SEARCH_BASE = "noEnvcellTimeSlice=1&occlusionCull=off&interiorApertureCull=off";

/** The world: scene3d shaped like index.js's, the fixture LB built on `renderer`. */
export async function smokeWorld(THREE, renderer, mods, opts = {}) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x203040);
  const worldRoot = new THREE.Group();
  worldRoot.name = "worldRoot";
  worldRoot.rotation.x = -Math.PI / 2;
  const groups = {};
  for (const n of ["terrain", "buildings", "statics", "cells", "entities"]) {
    const g = new THREE.Group();
    g.name = n;
    groups[n] = g;
    worldRoot.add(g);
  }
  groups.cells.layers.set(1);
  scene.add(worldRoot);
  worldRoot.updateMatrixWorld(true);
  const amb = new THREE.AmbientLight(0xffffff, 0.7);
  amb.layers.enableAll();
  scene.add(amb);
  const cx = R.LB_X + 106, cy = R.LB_Y + 86; // AC -> three: (x, z, -y)
  const sun = new THREE.DirectionalLight(0xfff0dd, 1.4);
  sun.castShadow = true;
  sun.layers.enableAll();
  sun.position.set(cx + 6, 60, -cy + 9);
  sun.target.position.set(cx, 10, -cy);
  sun.shadow.mapSize.set(512, 512);
  Object.assign(sun.shadow.camera, { left: -20, right: 20, top: 20, bottom: -20, near: 1, far: 200 });
  sun.shadow.camera.updateProjectionMatrix();
  scene.add(sun, sun.target);
  // A terrain receiver on layer 0 under the cells (the world pass draws it).
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), new THREE.MeshStandardMaterial({ color: 0x556644 }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(cx, 3.5, -cy);
  ground.receiveShadow = true;
  ground.name = "terrain-receiver";
  scene.add(ground);
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 500);
  if (opts.close) {
    // ~3.8 m off cell 0 (AC (100.5, 82.5, 16) -> (100, 81, 12.5)): inside the POM band.
    camera.position.set(R.LB_X + 100.5, 16.0, -(R.LB_Y + 82.5));
    camera.lookAt(R.LB_X + 100.0, 12.5, -(R.LB_Y + 81.0));
  } else {
    camera.position.set(cx, 26, -cy + 6);
    camera.lookAt(cx, 11, -cy);
  }
  camera.layers.enableAll();
  camera.updateMatrixWorld(true);
  // The punch arm: a building roof on layer 0 above the cells (AC z 16),
  // which hides them from the outdoor camera except through one doorway.
  let roof = null;
  if (opts.roof) {
    roof = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), new THREE.MeshStandardMaterial({ color: 0x8a7a66, side: THREE.DoubleSide }));
    roof.name = "smoke-roof";
    roof.position.set(R.LB_X + 106, R.LB_Y + 86, 16);
    groups.buildings.add(roof);
    worldRoot.updateMatrixWorld(true);
  }
  const mc = await R.materialCache(mods.M, mods.adapter, opts.pools ? { ...R.SURF, ...R.SURF_POOLED } : R.SURF, {
    pom: opts.pom === true, texchan: opts.maps === true, luminous: opts.maps === true ? R.LUMINOUS : null,
  });
  const scene3d = {
    scene, worldRoot, camera, renderer,
    terrainGroup: groups.terrain, buildingsGroup: groups.buildings, staticsGroup: groups.statics,
    cellsGroup: groups.cells, entitiesGroup: groups.entities,
    cellContainers3d: new Map(), envCellLoadedLbs: new Set(), materialCache: mc, shadowsEnabled: true,
    frameTime: { tsMs: 1000, tsSec: 1, dt: 0.016 },
    atmospherePipeline: { setIndoorSplitArmed() {}, setIndoorLandscapeSkip() {}, portalSealPass: { setApertures() {}, outdoorRemainder: null } },
  };
  // The draw pools are armed before any landblock builds (index.js: at boot).
  const pools = opts.pools ? await R.armPools({ scene3d }) : null;
  const quiet = console.log;
  console.log = () => {};
  let built;
  const wasmOpts = opts.pools ? { table: R.POOL_CELLS } : {};
  if (opts.pom) wasmOpts.baked = false; // cells draw the POM base materials (getCached), props their flag-only clones
  try { built = await mods.cells.buildEnvCellsForLandblock(scene3d, R.LB, R.fakeWasm(wasmOpts)); } finally { console.log = quiet; }
  let punch = null;
  if (opts.roof && mods.PP) {
    punch = new mods.PP.PortalPunchPass(null, camera, "punch", { stencil: false });
    scene3d._portalPunchPass = punch;
  }
  return { THREE, renderer, scene, camera, scene3d, mc, sun, ground, roof, punch, built, mods, worldRoot, pools };
}

/**
 * The pools' side of an arm (null when not armed): what they pooled, their
 * per-cell state (registry index: instances / PVS-hidden), the pool objects'
 * placement (parent, layer mask, own sphere) — both loads must read the same.
 */
export function poolsReport(w) {
  if (!w.pools) return null;
  const reg = w.pools.reg;
  const census = w.pools.envcells.envCellPoolCensus();
  return {
    active: w.pools.envcells.envCellPoolsActive(),
    surfacesPooled: census.surfacesPooled,
    cells: [...R.poolCellStates(reg)].sort((a, b) => a[0] - b[0]).map(([id, s]) => [id >>> 0, s.instances, s.hidden]),
    meshes: [...reg.pools.values()].map((p) => ({
      instances: p.instances, cellsChild: p.mesh.parent === w.scene3d.cellsGroup, mask: p.mesh.layers.mask,
      sentinel: !!p.mesh.boundingSphere && p.mesh.boundingSphere.radius === -Infinity, // the batch's hand-off sphere: never on a pool
    })),
  };
}

/**
 * The punch arm's doorway in the roof (AC world, z-up): one quad, the roof
 * plane under the screen rect (18..104, 44..112) of the punch camera, so
 * cell 0's walls and both of its props are seen through it (and cells 1 / 2
 * lie outside it, behind the roof).
 */
export const DOORWAY = [[R.LB_X + 101.35, R.LB_Y + 80.2, 16], [R.LB_X + 105.0, R.LB_Y + 80.2, 16], [R.LB_X + 104.85, R.LB_Y + 83.2, 16], [R.LB_X + 100.8, R.LB_Y + 83.2, 16]];
const doorwayFlat = () => Float32Array.from([1, 4, ...DOORWAY.flat()]);

/** Legacy interior meshes whose screen bounds overlap the doorway rect (what the punch must show). */
export function doorwayMeshes(w) {
  const THREE = w.THREE;
  const d = doorwayRect(w);
  const names = [];
  const v = new THREE.Vector3();
  w.scene.updateMatrixWorld(true);
  for (const c of w.scene3d.cellContainers3d.values()) {
    c.traverse((o) => {
      if (!o.isMesh || !o.geometry || !o.geometry.attributes.position) return;
      const pos = o.geometry.attributes.position;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let i = 0; i < pos.count; i += 1) {
        v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld).project(w.camera);
        const px = (v.x * 0.5 + 0.5) * CANVAS, py = (v.y * 0.5 + 0.5) * CANVAS;
        x0 = Math.min(x0, px); y0 = Math.min(y0, py); x1 = Math.max(x1, px); y1 = Math.max(y1, py);
      }
      if (x1 > d.x0 && x0 < d.x1 && y1 > d.y0 && y0 < d.y1) names.push(o.name);
    });
  }
  return names.sort();
}

/**
 * The screen rect (pixels, GL convention) a cell's meshes cover, clipped to
 * the canvas, and the share of the canvas it is (the pom arm's framing).
 */
export function cellScreenRect(w, cellId) {
  const THREE = w.THREE;
  const c = w.scene3d.cellContainers3d.get(cellId >>> 0);
  if (!c) return null;
  w.scene.updateMatrixWorld(true);
  const v = new THREE.Vector3();
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  c.traverse((o) => {
    if (!o.isMesh || !o.geometry || !o.geometry.attributes.position) return;
    const pos = o.geometry.attributes.position;
    for (let i = 0; i < pos.count; i += 1) {
      v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld).project(w.camera);
      if (v.z < -1 || v.z > 1) continue;
      const px = Math.min(CANVAS, Math.max(0, (v.x * 0.5 + 0.5) * CANVAS)), py = Math.min(CANVAS, Math.max(0, (v.y * 0.5 + 0.5) * CANVAS));
      x0 = Math.min(x0, px); y0 = Math.min(y0, py); x1 = Math.max(x1, px); y1 = Math.max(y1, py);
    }
  });
  if (!(x1 > x0 && y1 > y0)) return { x0: 0, y0: 0, x1: 0, y1: 0, share: 0 };
  return { x0, y0, x1, y1, share: ((x1 - x0) * (y1 - y0)) / (CANVAS * CANVAS) };
}

/** The doorway's screen rect in pixels (GL convention, y up), from the camera. */
export function doorwayRect(w) {
  const THREE = w.THREE;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of DOORWAY) {
    const v = new THREE.Vector3(p[0], p[1], p[2]).applyMatrix4(w.worldRoot.matrixWorld).project(w.camera);
    const px = (v.x * 0.5 + 0.5) * CANVAS, py = (v.y * 0.5 + 0.5) * CANVAS;
    x0 = Math.min(x0, px); y0 = Math.min(y0, py); x1 = Math.max(x1, px); y1 = Math.max(y1, py);
  }
  return { x0, y0, x1, y1 };
}

/** One app frame: the visibility tick (bits + batch sync) for `state`, then the punch feed. */
export function tick(w, state, arm = {}) {
  w.scene3d.frameTime = { tsMs: w.scene3d.frameTime.tsMs + 16.7, tsSec: 0, dt: 0.0167 };
  let sh = w.session;
  if (!sh) {
    sh = w.session = R.makeSession(w.sessionState = state);
    if (arm.sealed) { sh.currentDungeonHasOutdoorPortal = () => false; sh.isCurrentCellSeenOutside = () => false; sh.isCellSeenOutside = () => false; }
    if (arm.frame === "punch") sh.getVisiblePortalApertures = () => doorwayFlat();
  }
  Object.assign(w.sessionState, state);
  const quiet = console.log;
  console.log = () => {};
  try {
    w.mods.cells.tickCellVisibility3D(w.scene3d, sh);
    if (w.punch) w.mods.cells.tickPortalPunch(w.scene3d, sh);
  } finally { console.log = quiet; }
}

// atmosphere_pipeline.js CAM_LAYER_MASK_*.
const MASK_BOTH = 3, MASK_WORLD_ONLY = 1, MASK_INDOOR_ONLY = 2, MASK_NONE = 0;

/**
 * The frame as the pipeline structures it (preFrameSkySync):
 *   "unsplit" one pass, mask BOTH;
 *   "split"   world (WORLD_ONLY) -> depth wipe -> cells (INDOOR_ONLY);
 *   "sealed"  world on the EMPTY mask (clears only) -> no wipe -> cells;
 *   "punch"   world (WORLD_ONLY) -> PortalPunchPass -> cells (INDOOR_ONLY);
 *   "world"   the punch frame's world pass alone (the runner's reference).
 */
export function renderFrame(w, mode) {
  const r = w.renderer;
  r.shadowMap.enabled = true;
  r.shadowMap.autoUpdate = true;
  r.info.autoReset = false;
  r.info.reset();
  r.autoClear = true;
  const pass = (mask) => { w.camera.layers.mask = mask; r.render(w.scene, w.camera); };
  if (mode === "split" || mode === "sealed" || mode === "punch" || mode === "world") {
    pass(mode === "sealed" ? MASK_NONE : MASK_WORLD_ONLY);
    if (mode !== "world") {
      r.autoClear = false;
      if (mode === "split") r.clearDepth();
      if (mode === "punch" && w.punch) w.punch.render(r, null);
      pass(MASK_INDOOR_ONLY);
      r.autoClear = true;
    }
  } else {
    pass(MASK_BOTH);
  }
  w.camera.layers.mask = MASK_BOTH;
  return r.info.render.calls;
}

/**
 * The sun's shadow map (BasicShadowMap: an unfiltered depth texture) as
 * floats, through a depth blit into a float target. Null when there is none.
 */
export function readShadowDepth(w) {
  const THREE = w.THREE;
  const r = w.renderer;
  const map = w.sun.shadow.map;
  const tex = map && map.depthTexture;
  if (!tex) return null;
  const n = w.sun.shadow.mapSize.x | 0;
  const rt = new THREE.WebGLRenderTarget(n, n, { type: THREE.FloatType, format: THREE.RGBAFormat, depthBuffer: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
  const mat = new THREE.ShaderMaterial({
    uniforms: { tDepth: { value: tex } },
    vertexShader: "varying vec2 vUv;\nvoid main() {\n  vUv = uv;\n  gl_Position = vec4( position.xy, 0.0, 1.0 );\n}",
    fragmentShader: "precision highp float;\nuniform highp sampler2D tDepth;\nvarying vec2 vUv;\nvoid main() {\n  gl_FragColor = vec4( texture2D( tDepth, vUv ).r, 0.0, 0.0, 1.0 );\n}",
    depthTest: false, depthWrite: false,
  });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
  quad.frustumCulled = false;
  const sc = new THREE.Scene();
  sc.add(quad);
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const prevTarget = r.getRenderTarget();
  const prevAuto = r.shadowMap.autoUpdate;
  const out = new Float32Array(n * n * 4);
  try {
    r.shadowMap.autoUpdate = false;
    r.setRenderTarget(rt);
    r.render(sc, cam);
    r.readRenderTargetPixels(rt, 0, 0, n, n, out);
  } finally {
    r.setRenderTarget(prevTarget);
    r.shadowMap.autoUpdate = prevAuto;
    rt.dispose();
    mat.dispose();
    quad.geometry.dispose();
  }
  const depth = new Float32Array(n * n);
  for (let i = 0; i < n * n; i += 1) depth[i] = out[i * 4];
  return depth;
}

/** Texel-by-texel depth comparison (24-bit depth ulp = 1 / (2^24 - 1)). */
export function depthDiff(a, b, ulps = 4) {
  const ulp = 1 / (2 ** 24 - 1);
  let max = 0, over = 0, differing = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    const d = Math.abs(a[i] - b[i]);
    if (d > 0) differing += 1;
    if (d > ulps * ulp) over += 1;
    if (d > max) max = d;
  }
  return { texels: n, differing, over, maxUlps: max / ulp, sameSize: a.length === b.length };
}

/** Pixels where frames `a` and `b` differ, split by inside / outside `rect` (+ `margin` px). */
export function rectDiff(a, b, rect, margin = 2) {
  let inside = 0, outside = 0;
  for (let y = 0; y < CANVAS; y += 1) {
    for (let x = 0; x < CANVAS; x += 1) {
      const i = (y * CANVAS + x) * 4;
      let d = 0;
      for (let c = 0; c < 3; c += 1) d = Math.max(d, Math.abs(a[i + c] - b[i + c]));
      if (d <= 2) continue;
      const inRect = x >= rect.x0 - margin && x <= rect.x1 + margin && y >= rect.y0 - margin && y <= rect.y1 + margin;
      if (inRect) inside += 1; else outside += 1;
    }
  }
  return { inside, outside };
}

export function readFrame(renderer) {
  const gl = renderer.getContext();
  const out = new Uint8Array(CANVAS * CANVAS * 4);
  gl.readPixels(0, 0, CANVAS, CANVAS, gl.RGBA, gl.UNSIGNED_BYTE, out);
  return out;
}

export function litPixels(frame) {
  let n = 0;
  for (let i = 0; i < frame.length; i += 4) {
    // background 0x203040: count pixels that differ from it (scene content)
    if (Math.abs(frame[i] - 0x20) + Math.abs(frame[i + 1] - 0x30) + Math.abs(frame[i + 2] - 0x40) > 6) n += 1;
  }
  return n;
}

/** Pixels whose max channel difference is > `tol` and the max difference. */
export function frameDiff(a, b, tol = 2) {
  let maxDiff = 0, over = 0, differing = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 4) {
    let d = 0;
    for (let c = 0; c < 4; c += 1) d = Math.max(d, Math.abs(a[i + c] - b[i + c]));
    if (d > 0) differing += 1;
    if (d > tol) over += 1;
    if (d > maxDiff) maxDiff = d;
  }
  return { maxDiff: a.length === b.length ? maxDiff : 255, over, differing, pixels: n / 4 };
}

/** Decoded DRAW bits of every live chunk cell equal container.visible (null when no batch). */
export function bitsAgree(w) {
  const S = w.mods.IB.__interiorBatchStateForTest();
  if (!S || !S.bits) return null;
  let cells = 0, bad = 0;
  for (const rec of S.lbs.values()) {
    for (const ch of rec.chunks) {
      if (ch.status !== "active" && ch.status !== "overlap") continue;
      for (const b of ch.batches) {
        for (const e of b.entries) {
          const c = ch.cellPlans[e.cellIdx].cell.container;
          cells += 1;
          if ((w.mods.IB.ibBitOf(S.bits.data, e.code, 0) === 1) !== (c.visible === true)) bad += 1;
        }
      }
    }
  }
  return { cells, bad };
}

/**
 * The batch is live for what is ON SCREEN: every batched legacy mesh of a
 * visible cell inside the camera frustum is suppressed (its draw moved to a
 * batch object). A chunk with
 * a batch of hidden cells stays in overlap for that batch only (per-mesh
 * hand-off). Null when no batch.
 */
export function liveCoverage(w) {
  const S = w.mods.IB.__interiorBatchStateForTest();
  if (!S) return null;
  const THREE = w.THREE;
  const frustum = new THREE.Frustum().setFromProjectionMatrix(
    new THREE.Matrix4().multiplyMatrices(w.camera.projectionMatrix, w.camera.matrixWorldInverse));
  const sphere = new THREE.Sphere();
  let visibleMeshes = 0, suppressed = 0, chunks = 0;
  for (const rec of S.lbs.values()) {
    for (const ch of rec.chunks) {
      if (ch.status !== "active" && ch.status !== "overlap") continue;
      chunks += 1;
      for (const mi of ch.meshInfo) {
        let vis = false;
        for (let o = mi.mesh.parent; o; o = o.parent) if (o.userData && o.userData.isEnvCell) { vis = o.visible === true; break; }
        if (!vis) continue;
        // On screen = what the legacy draw would have drawn (its geometry
        // sphere: the mesh's own one is the sentinel once handed over).
        const g = mi.mesh.geometry;
        if (!g.boundingSphere) g.computeBoundingSphere();
        if (!frustum.intersectsSphere(sphere.copy(g.boundingSphere).applyMatrix4(mi.mesh.matrixWorld))) continue;
        visibleMeshes += 1;
        if (mi.suppressed) suppressed += 1;
      }
    }
  }
  return { chunks, visibleMeshes, suppressed };
}

/**
 * Flag on: every level of every admitted map / normal layer (and, POM
 * members, every R8 height layer: both sides read back as (r, 0, 0, 255);
 * AO / roughness members, every R8 AO and RGBA8 roughness layer) vs the 2D
 * texture three built for it.
 */
export function layerReadback(w) {
  const S = w.mods.IB.__interiorBatchStateForTest();
  const pages = w.mods.KIT.kitPages(w.renderer);
  let layers = 0, levels = 0, mismatched = 0, first = null, pomLayers = 0, mapLayers = 0;
  for (const e of S.slots.values()) {
    for (const [ref, tex, kind] of [[e.mapRef, e.map, "map"], [e.nrmRef, e.normalMap, "map"], [e.pomRef, e.pomTex, "pom"], [e.aoRef, e.aoTex, "extra"], [e.rghRef, e.rghTex, "extra"]]) {
      if (!ref || !tex || (ref.page.desc.format !== "rgba8" && ref.page.desc.format !== "r8")) continue;
      layers += 1;
      if (kind === "pom") pomLayers += 1;
      if (kind === "extra") mapLayers += 1;
      for (let l = 0; l < ref.page.desc.levels; l += 1) {
        const a = pages.readLayer(ref.page, ref.layer, l);
        const b = pages.readTexture2D(tex, l);
        levels += 1;
        let same = a.length === b.length;
        for (let i = 0; same && i < a.length; i += 1) if (a[i] !== b[i]) same = false;
        if (!same) { mismatched += 1; if (!first) first = { page: ref.page.id, layer: ref.layer, level: l }; }
      }
    }
  }
  return { layers, levels, mismatched, first, pomLayers, mapLayers };
}

const OUT = (R.LB | 0x31) >>> 0;
export const ARMS = {
  town: { frame: "unsplit", state: { player: OUT, indoor: false, frustum: [R.CELL(0), R.CELL(1), R.CELL(2)], walk: [], bfs: [] } },
  punch: { frame: "punch", roof: true, state: { player: OUT, indoor: false, frustum: R.CELL_IDS.slice(), walk: [], bfs: [] } },
  dungeon: { frame: "split", state: { player: R.CELL(0), indoor: true, frustum: R.CELL_IDS.slice(), walk: [R.CELL(0), R.CELL(1)], bfs: [R.CELL(2)] } },
  sealed: { frame: "sealed", sealed: true, state: { player: R.CELL(0), indoor: true, frustum: R.CELL_IDS.slice(), walk: [R.CELL(0), R.CELL(1), R.CELL(3)], bfs: [] } },
  shadow: { frame: "unsplit", state: { player: R.CELL(0), indoor: true, frustum: R.CELL_IDS.slice(), walk: R.CELL_IDS.slice(), bfs: [] } },
  shadowmap: { frame: "unsplit", basicShadows: true, state: { player: R.CELL(0), indoor: true, frustum: R.CELL_IDS.slice(), walk: R.CELL_IDS.slice(), bfs: [] } },
};
export const ARM_NAMES = ["layers", ...Object.keys(ARMS)];
/** The arms the runner also loads with the draw pools armed (`&pools=1`): unsplit, split, the shadow raster. */
export const POOL_ARMS = ["town", "dungeon", "shadowmap"];
/**
 * POM arms (`&pom=1`; header "POM"): the close indoor frame and the shadow
 * raster on the POM material cache (+ `layers&pom=1`, the R8 readback).
 */
export const POM_ARM_TABLE = {
  pom: { frame: "unsplit", close: true, state: { player: R.CELL(0), indoor: true, frustum: R.CELL_IDS.slice(), walk: R.CELL_IDS.slice(), bfs: [] } },
};
export const POM_ARMS = ["pom", "shadowmap"];
/**
 * AO / roughness / emissive arms (`&maps=1`; header "MAPS"): the unsplit and
 * the split frame and the shadow raster on the texchan + luminous material
 * cache (+ `layers&maps=1`, the AO / roughness readback).
 */
export const MAP_ARMS = ["town", "dungeon", "shadowmap"];

/**
 * Is the batch settled (flag on): every landblock planned, no chunk still
 * setting up (each one live — overlap / active — or legacy; a chunk with a
 * batch of hidden cells stays in overlap for that batch only), and every
 * on-screen batched mesh handed over?
 */
export function settled(w) {
  const d = w.mods.IB.interiorBatchDiag();
  if (!d) return true; // flag off: nothing to wait for
  const l = d.lbs || {};
  if ((l.pending || 0) + (l.planning || 0) > 0) return false;
  const c = d.chunks || {};
  const live = (c.active || 0) + (c.overlap || 0);
  const busy = Object.keys(c).some((k) => k !== "active" && k !== "overlap" && k !== "legacy" && c[k] > 0);
  const cov = liveCoverage(w);
  return !busy && live > 0 && !!cov && cov.visibleMeshes > 0 && cov.suppressed === cov.visibleMeshes;
}

/**
 * Run one arm: at least `ticks` app frames (tick + render), and on the flag-on
 * load until the batch has settled (at most `maxTicks`); then the measured
 * frame. `pause()` lets the browser link programs between frames (KHR
 * parallel compile); the batch keeps legacy on screen until its class
 * programs drew.
 */
export async function runArm(THREE, renderer, mods, armName, opts = {}) {
  const arm = ARMS[armName === "layers" ? "town" : armName] || POM_ARM_TABLE[armName];
  if (arm.basicShadows) renderer.shadowMap.type = THREE.BasicShadowMap;
  const w = await smokeWorld(THREE, renderer, mods, { roof: !!arm.roof, pools: opts.pools === true, pom: opts.pom === true, maps: opts.maps === true, close: !!arm.close });
  const ticks = opts.ticks ?? 12;
  const maxTicks = opts.maxTicks ?? 400;
  const pause = opts.pause || (async () => {});
  let f = 0;
  for (; f < maxTicks; f += 1) {
    tick(w, { ...arm.state }, arm);
    renderFrame(w, arm.frame);
    await pause();
    if (f + 1 >= ticks && settled(w)) break;
  }
  tick(w, { ...arm.state }, arm);
  const calls = renderFrame(w, arm.frame);
  const frame = readFrame(renderer);
  const diag = mods.IB.interiorBatchDiag();
  const out = {
    arm: armName, calls, lit: litPixels(frame), frame, ticks: f + 1, settled: settled(w),
    batch: diag ? {
      lbs: diag.lbs, chunks: diag.chunks, objects: diag.objects, drawnObjects: diag.drawnObjects, unitReasons: diag.unitReasons,
      legacyReasons: diag.legacyReasons, bitMismatch: diag.bitMismatch, maxSyncMs: diag.maxSyncMs, maxPlanMs: diag.maxPlanMs, maxMergeMs: diag.maxMergeMs,
      disarmed: diag.disarmed, pools: diag.pools, slots: diag.slots, pomSlots: diag.pomSlots, textureReplans: diag.textureReplans,
      extraMaps: diag.extraMaps, mapSlots: diag.mapSlots, mapArrivals: diag.mapArrivals,
    } : null,
    pools: poolsReport(w),
    bits: bitsAgree(w),
    coverage: liveCoverage(w),
    visible: [...w.scene3d.cellContainers3d].filter(([, c]) => c.visible).map(([id]) => id >>> 0).sort(),
  };
  if (armName === "layers") out.layers = diag ? layerReadback(w) : null;
  if (arm.close) out.cell0Rect = cellScreenRect(w, R.CELL(0));
  if (arm.frame === "punch") {
    out.punched = !!(w.punch && w.punch.hasApertures);
    out.doorway = doorwayRect(w);
    out.doorwayMeshes = doorwayMeshes(w);
    renderFrame(w, "world");
    out.worldFrame = readFrame(renderer);
  }
  if (arm.basicShadows) out.shadowDepth = readShadowDepth(w);
  return out;
}
