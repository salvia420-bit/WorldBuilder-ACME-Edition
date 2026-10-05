// tests/portal_seal_retail_order.test.mjs
//
// The indoor portal SEAL in retail order (`?sealLogDepth`, round 3).
// Retail PView::DrawCells (acclient.c:461450-461560):
//   LScape::draw (ALL outdoor content, depth-tested together) → Clear(Z) →
//   DrawPortalPolyInternal(portal, 0) for the other_cell_id == -1 portals of
//   the REACHED cells (only when outside_view.view_count != 0) → the cells.
//
// A fake renderer rasterises a few named pixels through the REAL pass objects
// in the composer's armed indoor order (atmosphere_pipeline.js):
//   world (layer 0) → SealRemainderPass → SealDepthSavePass → depth clear →
//   seal → cells (layer 1) → SealDepthRestorePass.
//
//   R1  the outdoor remainder (relayered player-landblock statics, outdoor
//       entities) is drawn BEFORE the depth clear, against the world depth: a
//       layer-0 hill in front of an outdoor NPC still hides it (round 2 drew the
//       remainder after the clear and the NPC painted through the hill — this
//       group fails on that code); with no hill the NPC shows through the
//       doorway; EnvCells / indoor entities / interior particles beyond the
//       wall never do.
//   R2  everything the pre-draw touches is restored; `?sealLogDepth=off` skips
//       all three seal slots (the old frame).
//   R3  log-depth model: the seal's depth statements are three's own logdepthbuf
//       chunk lines and evaluate to MeshBasic's depth at the same point.
//   R4  feed (cells.js tickPortalSeal): reached cells only, dungeon → zero,
//       stale pkg → fallback + one console warning, rect published.
//   R5  the REAL landcell writer: loop.js dispatchEntityUpdate(KIND.POSITION)
//       updates the cell an entity stands in, so one that spawned indoors and
//       walked out is drawn before the wall (fails on the old loop.js: nothing
//       wrote `_wireCellIdx`).
//   R6  the pre-draw is narrowed to the doorway rect (camera view offset +
//       target viewport) and both are restored.
//   R7  depth restore: after the cells pass the sealed pixels carry the OUTDOOR
//       depth again (what the post effects read), except where interior
//       geometry won in front of the wall.
//
// Run: node tests/portal_seal_retail_order.test.mjs

import * as THREE from "three";
import assert from "node:assert/strict";

globalThis.location = { search: "" };
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};
globalThis.window = globalThis;

const pp = await import("../scene3d/portal_punch.js");
const {
  PortalPunchPass, collectOutdoorRemainderHidden, SealRemainderPass,
  SealDepthSavePass, SealDepthRestorePass, narrowCameraToRect, restoredDepth,
} = pp;
const { tickPortalSeal, markOutdoorEntities } = await import("../scene3d/cells.js");

let groups = 0;
let failures = 0;
async function t(name, fn) {
  try {
    await fn();
    groups++;
    console.log("  ok ", name);
  } catch (e) {
    failures++;
    console.log("  FAIL", name, "\n     ", String(e && e.message).split("\n").slice(0, 3).join("\n      "));
  }
}

const WORLD_ONLY = 1 << 0;
const INDOOR_ONLY = 1 << 1;
const WALL = 0.3;

// ---------------------------------------------------------------------------
// Multi-pixel rasteriser. Mesh `userData.px` = { pixelName: depth }. Normal
// materials: LessEqual + depth write. Special materials by name:
//   portal-seal                 — Always: every pixel's depth := WALL (one doorway covers all)
//   portal-seal-depth-copy      — snapshots every pixel's depth into the bound target
//   portal-seal-depth-restore   — depth := restoredDepth(cur, WALL, saved) per pixel
function makePixelRenderer(pixels) {
  const px = {};
  for (const p of pixels) px[p] = { color: "clear", depth: 1.0 };
  const copies = new Map(); // texture -> {pixel: depth}
  const log = [];
  const renderer = {
    autoClear: true,
    shadowMap: { autoUpdate: true },
    _target: null,
    getRenderTarget() { return this._target; },
    setRenderTarget(t) { this._target = t; },
    clearStencil() {},
    clearDepth() { for (const p of pixels) px[p].depth = 1.0; },
    render(scene, cam) {
      scene.traverseVisible((o) => {
        if (!o.isMesh || !o.layers.test(cam.layers)) return;
        const mname = o.material?.name;
        if (mname === "portal-seal") {
          log.push("SEAL");
          for (const p of pixels) px[p].depth = WALL;
          return;
        }
        if (mname === "portal-seal-depth-copy") {
          log.push("COPY");
          const snap = {};
          for (const p of pixels) snap[p] = px[p].depth;
          copies.set(this._target.texture, snap);
          return;
        }
        if (mname === "portal-seal-depth-restore") {
          log.push("RESTORE");
          const saved = copies.get(o.material.uniforms.tSaved.value);
          const cur = copies.get(o.material.uniforms.tCur.value);
          for (const p of pixels) px[p].depth = restoredDepth(cur[p], WALL, saved[p]);
          return;
        }
        log.push(o.name);
        const d = o.userData.px || {};
        for (const p of pixels) {
          if (d[p] === undefined) continue;
          if (d[p] <= px[p].depth) { px[p].depth = d[p]; px[p].color = o.name; }
        }
      });
    },
  };
  return { renderer, px, log };
}

function mesh(name, layer, px, ud = {}) {
  const m = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
  m.name = name;
  m.layers.set(layer);
  m.userData = { ...ud, px };
  return m;
}

// The live scene graph shape (index.js): scene → worldRoot → 5 groups.
// Pixel A: plain doorway view. Pixel B: a hill rises in front of the NPC.
// Pixel C: an interior chair stands in front of the doorway wall.
function makeWorld() {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x123456);
  const worldRoot = new THREE.Group();
  const terrainGroup = new THREE.Group();
  const buildingsGroup = new THREE.Group();
  const staticsGroup = new THREE.Group();
  const cellsGroup = new THREE.Group();
  const entitiesGroup = new THREE.Group();
  cellsGroup.layers.set(1);
  entitiesGroup.layers.set(1);
  worldRoot.add(terrainGroup, buildingsGroup, staticsGroup, cellsGroup, entitiesGroup);
  scene.add(worldRoot);
  terrainGroup.add(mesh("terrain", 0, { A: 0.9, B: 0.9, C: 0.9 }));
  terrainGroup.add(mesh("hill", 0, { B: 0.4 }));
  // Player-landblock outdoor content, relayered onto layer 1 by cells.js.
  staticsGroup.add(mesh("tree", 1, { A: 0.5, B: 0.5, C: 0.5 }, { __splitLayer: 1, landblockId: 0xa9b40000 }));
  buildingsGroup.add(mesh("shell", 1, {}, { __splitLayer: 1, landblockId: 0xa9b40000 }));
  buildingsGroup.add(mesh("otherLbHouse", 0, { A: 0.7 }, { landblockId: 0xaab40000 }));
  // Interior-anchored particle: layer 1 at emission, NOT relayered.
  staticsGroup.add(mesh("interiorParticle", 1, { A: 0.35 }));
  // EnvCells: one beyond the wall (another room), one chair in front of it.
  cellsGroup.add(mesh("envcellFar", 1, { A: 0.6, B: 0.6 }));
  cellsGroup.add(mesh("chair", 1, { C: 0.2 }));
  // Entities.
  entitiesGroup.add(mesh("npcOutdoor", 1, { A: 0.45, B: 0.45 }, { __splitOutdoor: true }));
  entitiesGroup.add(mesh("npcIndoorFar", 1, { A: 0.4 }));
  entitiesGroup.add(mesh("playerInRoom", 1, {}));
  return { scene, worldRoot, buildingsGroup, staticsGroup, cellsGroup, entitiesGroup };
}

function makeSeal(world, opts = {}) {
  const pass = new PortalPunchPass(null, null, "seal", opts);
  pass.setApertures([1, 4, 0, 5, 0, 1, 5, 0, 1, 5, 2, 0, 5, 2], null);
  pass.outdoorRemainder = {
    scene: world.scene,
    worldRoot: world.worldRoot,
    buildingsGroup: world.buildingsGroup,
    staticsGroup: world.staticsGroup,
    entitiesGroup: world.entitiesGroup,
  };
  return pass;
}

function fakeTarget() {
  return {
    isFakeTarget: true,
    width: 400, height: 200, samples: 0,
    scissor: new THREE.Vector4(), scissorTest: false,
    viewport: new THREE.Vector4(0, 0, 400, 200),
    depthTexture: { isFakeDepth: true },
  };
}

// The composer's armed indoor sequence, pass for pass, with the real
// PortalPunchPass + the three real seal slots (preFrameSkySync enables them
// exactly when the seal has apertures).
function runIndoorFrame(world, seal) {
  const cam = new THREE.PerspectiveCamera(60, 2, 0.1, 5000);
  cam.updateMatrixWorld();
  seal.camera = cam;
  const pixels = ["A", "B", "C"];
  const { renderer, px, log } = makePixelRenderer(pixels);
  const target = fakeTarget();
  const remainder = new SealRemainderPass(seal);
  const save = new SealDepthSavePass(seal);
  const restore = new SealDepthRestorePass(seal);
  cam.layers.mask = WORLD_ONLY;                 // worldMaskPass
  renderer.setRenderTarget(target);
  renderer.render(world.scene, cam);            // worldRenderPass
  log.push("WORLD_DONE");
  remainder.render(renderer, target);           // sealRemainderPass
  save.render(renderer, target);                // sealDepthSavePass
  log.push("CLEAR");
  renderer.clearDepth();                        // depthClearPass
  seal.render(renderer, target);                // portalSealPass
  cam.layers.mask = INDOOR_ONLY;                // cellsMaskPass
  renderer.setRenderTarget(target);
  renderer.render(world.scene, cam);            // cellsRenderPass
  restore.render(renderer, target);             // sealDepthRestorePass
  cam.layers.mask = WORLD_ONLY | INDOOR_ONLY;   // cellsPostMaskPass
  return { px, log, cam, renderer, target, restore };
}

console.log("portal seal — retail order");

await t("R1 outdoor remainder is drawn between the world pass and the clear, depth-tested", () => {
  const world = makeWorld();
  const seal = makeSeal(world, { logDepth: true });
  const { px, log } = runIndoorFrame(world, seal);
  const worldDone = log.indexOf("WORLD_DONE");
  const clearAt = log.indexOf("CLEAR");
  const sealAt = log.indexOf("SEAL");
  assert.ok(worldDone >= 0 && clearAt > worldDone && sealAt > clearAt, log.join(","));
  const pre = log.slice(worldDone + 1, clearAt);
  for (const n of ["tree", "shell", "npcOutdoor"]) {
    assert.ok(pre.includes(n), `${n} must be drawn after the world pass and BEFORE the clear; got ${pre.join(",")}`);
  }
  for (const n of ["envcellFar", "chair", "npcIndoorFar", "interiorParticle", "playerInRoom"]) {
    assert.ok(!pre.includes(n), `${n} must NOT be in the pre-draw`);
  }
  assert.ok(!log.slice(clearAt + 1, sealAt).some((n) => n !== "COPY"), "nothing outdoor drawn between clear and stamp");
  // A: nearest outdoor thing through the doorway is the outdoor NPC.
  assert.equal(px.A.color, "npcOutdoor");
  // B: the layer-0 hill (0.40) is in front of the NPC (0.45) and the tree
  //    (0.50) — LScape::draw depth-tests them together, so the hill wins.
  assert.equal(px.B.color, "hill");
  // C: the interior chair in front of the wall wins.
  assert.equal(px.C.color, "chair");
});

await t("R1b without the outdoor entity, the relayered tree is what shows at A", () => {
  const world = makeWorld();
  world.entitiesGroup.children.find((c) => c.name === "npcOutdoor").userData.__splitOutdoor = false;
  const seal = makeSeal(world, { logDepth: true });
  const { px } = runIndoorFrame(world, seal);
  assert.equal(px.A.color, "tree");
  assert.equal(px.B.color, "hill");
});

await t("R2 the pre-draw restores visibility, mask, background, shadow auto-update, autoClear", () => {
  const world = makeWorld();
  const bg = world.scene.background;
  const seal = makeSeal(world, { logDepth: true });
  const visBefore = [];
  world.scene.traverse((o) => visBefore.push(o.visible));
  const { cam, renderer } = runIndoorFrame(world, seal);
  const visAfter = [];
  world.scene.traverse((o) => visAfter.push(o.visible));
  assert.deepEqual(visAfter, visBefore);
  assert.equal(world.scene.background, bg);
  assert.equal(renderer.shadowMap.autoUpdate, true);
  assert.equal(renderer.autoClear, true);
  assert.equal(cam.layers.mask, WORLD_ONLY | INDOOR_ONLY);
  assert.equal(seal.remainderDraws, 1);
  const hidden = collectOutdoorRemainderHidden(seal.outdoorRemainder);
  assert.deepEqual(hidden.map((o) => o.name || o.type).sort(),
    ["Group", "Group", "interiorParticle", "npcIndoorFar", "playerInRoom"].sort());
});

await t("R2b ?sealLogDepth=off (logDepth false): no pre-draw, no depth save/restore", () => {
  const world = makeWorld();
  const seal = makeSeal(world, { logDepth: false });
  assert.equal(seal.wantsRemainder, false);
  assert.equal(seal.wantsDepthRestore, false);
  const { log } = runIndoorFrame(world, seal);
  const pre = log.slice(log.indexOf("WORLD_DONE") + 1, log.indexOf("CLEAR"));
  assert.deepEqual(pre, []);
  assert.ok(!log.includes("RESTORE"));
  assert.equal(seal.remainderDraws, 0);
});

await t("R3 seal depth == MeshBasic log depth at the same point", () => {
  const seal = new PortalPunchPass(null, null, "seal", { logDepth: true });
  const vs = seal._punchMat.vertexShader;
  const fs = seal._punchMat.fragmentShader;
  const norm = (x) => x.replace(/\s+/g, " ").trim();
  const chunkFrag = THREE.ShaderChunk.logdepthbuf_fragment.split("\n").find((l) => l.includes("gl_FragDepth ="));
  const chunkVert = THREE.ShaderChunk.logdepthbuf_vertex.split("\n").find((l) => l.includes("vFragDepth ="));
  const sealFrag = fs.split("\n").find((l) => l.includes("gl_FragDepth ="));
  const sealVert = vs.split("\n").find((l) => l.includes("vFragDepth ="));
  assert.ok(chunkFrag && chunkVert && sealFrag && sealVert);
  assert.equal(norm(sealFrag), norm(chunkFrag));
  assert.equal(norm(sealVert), norm(chunkVert));
  const cam = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 5000);
  cam.updateMatrixWorld();
  const clip = new THREE.Vector4(0.3, 0.2, -5, 1).applyMatrix4(cam.matrixWorldInverse).applyMatrix4(cam.projectionMatrix);
  const logDepthBufFC = 2.0 / (Math.log(cam.far + 1.0) / Math.LN2); // WebGLRenderer
  const glFragCoordZ = 0.5 * (clip.z / clip.w) + 0.5;
  const evalStmts = (vert, frag) => {
    const body =
      vert.replace(/gl_Position\.w/g, "glPositionW").trim() +
      frag.replace(/log2\(/g, "Math.log2(").replace(/gl_FragCoord\.z/g, "glFragCoordZ").trim() +
      " return gl_FragDepth;";
    // eslint-disable-next-line no-new-func
    return new Function("glPositionW", "glFragCoordZ", "logDepthBufFC", "vIsPerspective",
      "let vFragDepth, gl_FragDepth; " + body)(clip.w, glFragCoordZ, logDepthBufFC, 1.0);
  };
  const sealDepth = evalStmts(sealVert, sealFrag);
  const basicDepth = evalStmts(chunkVert, chunkFrag);
  assert.ok(Math.abs(sealDepth - basicDepth) < 1e-12);
  assert.ok(Math.abs(sealDepth - Math.log2(1 + 5) / Math.log2(1 + 5000)) < 1e-9);
  assert.ok(glFragCoordZ - sealDepth > 0.5);
});

// ---------------------------------------------------------------------------
function quadAt(y, x0, x1) {
  return [4, x0, y, 0, x1, y, 0, x1, y, 2, x0, y, 2];
}
function makeFeedScene3d() {
  const world = makeWorld();
  const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 5000);
  world.worldRoot.rotation.x = -Math.PI / 2;
  world.worldRoot.updateMatrixWorld(true);
  camera.position.set(0, 1, 0);
  camera.lookAt(0, 1, -10); // = AC +y
  camera.updateMatrixWorld(true);
  const seal = new PortalPunchPass(null, null, "seal", { logDepth: true });
  return { ...world, camera, _indoorSplitArmed: true, atmospherePipeline: { portalSealPass: seal }, seal };
}

await t("R4 the seal is fed from the PView outside view and publishes the doorway rect", () => {
  const s3 = makeFeedScene3d();
  const sh = {
    getPViewOutsidePortals: () => Float32Array.from([1, ...quadAt(5, -1, 1)]),
    getVisiblePortalApertures: () => Float32Array.from([2, ...quadAt(5, -1, 1), ...quadAt(8, 2, 4)]),
  };
  tickPortalSeal(s3, sh);
  assert.equal(s3.seal._apertureCount, 1);
  assert.equal(s3._portalSealDiag.source, "pview-outside");
  const r = s3.seal.remainderRect;
  assert.ok(r && r.x1 > r.x0 && r.y1 > r.y0 && r.x0 > 0 && r.x1 < 1, JSON.stringify(r));
});

await t("R4b mouthless dungeon: empty outside view → no stamp, no pre-draw", () => {
  const s3 = makeFeedScene3d();
  const sh = {
    getPViewOutsidePortals: () => Float32Array.from([0]),
    getVisiblePortalApertures: () => Float32Array.from([2, ...quadAt(5, -1, 1), ...quadAt(8, 2, 4)]),
  };
  tickPortalSeal(s3, sh);
  assert.equal(s3.seal.hasApertures, false);
  assert.equal(s3.seal.outdoorRemainder, null);
  assert.equal(s3.seal.wantsRemainder, false);
});

await t("R4c stale pkg falls back to the unrestricted export and warns ONCE", () => {
  const warns = [];
  const prevWarn = console.warn;
  console.warn = (...a) => warns.push(a.join(" "));
  try {
    const s3 = makeFeedScene3d();
    const sh = { getVisiblePortalApertures: () => Float32Array.from([2, ...quadAt(5, -1, 1), ...quadAt(8, 2, 4)]) };
    tickPortalSeal(s3, sh);
    tickPortalSeal(s3, sh);
    assert.equal(s3.seal._apertureCount, 2);
    assert.equal(s3._portalSealDiag.source, "frustum-unrestricted");
  } finally {
    console.warn = prevWarn;
  }
  assert.equal(warns.filter((w) => w.includes("getPViewOutsidePortals")).length, 1);
});

await t("R4d disarmed split clears apertures, remainder and rect", () => {
  const s3 = makeFeedScene3d();
  const sh = { getPViewOutsidePortals: () => Float32Array.from([1, ...quadAt(5, -1, 1)]) };
  tickPortalSeal(s3, sh);
  s3._indoorSplitArmed = false;
  tickPortalSeal(s3, sh);
  assert.equal(s3.seal.hasApertures, false);
  assert.equal(s3.seal.outdoorRemainder, null);
  assert.equal(s3.seal.remainderRect, null);
});

await t("R5 loop.js KIND.POSITION writes the current landcell; an entity that walks out is drawn before the wall", async () => {
  const { dispatchEntityUpdate } = await import("../scene3d/loop.js");
  const { KIND } = await import("../scene3d/entity_dispatch.js");
  globalThis.getLocalPlayerGuid = () => 99;
  const npc = { root: { userData: {} }, _outdoorCellIdx: 0x0105 }; // spawned in an EnvCell
  const self = { root: { userData: {} }, _outdoorCellIdx: 0x0010 };
  const entityMap = new Map([[7, npc], [99, self]]);
  // EntityManager._localPlayerGuid reads window.getLocalPlayerGuid (entities.js).
  const em = { entityMap, setPose() {}, _localPlayerGuid: () => globalThis.getLocalPlayerGuid() };
  const scene3d = { entityManager: em };
  markOutdoorEntities(scene3d);
  assert.equal(npc.root.userData.__splitOutdoor, false, "spawned indoors");
  // It walks out: ACE sends its new position in outdoor landcell 0x0021.
  dispatchEntityUpdate(scene3d, em, { kind: KIND.POSITION, guid: 7, landblockId: 0xa9b40021, x: 10, y: 20, z: 30 });
  assert.equal(npc._wireCellIdx, 0x0021);
  markOutdoorEntities(scene3d);
  assert.equal(npc.root.userData.__splitOutdoor, true, "now outdoors → drawn before the wall");
  // …and back inside.
  dispatchEntityUpdate(scene3d, em, { kind: KIND.POSITION, guid: 7, landblockId: 0xa9b40105, x: 10, y: 20, z: 30 });
  markOutdoorEntities(scene3d);
  assert.equal(npc.root.userData.__splitOutdoor, false);
  // The local player is never outdoor while the split is armed.
  dispatchEntityUpdate(scene3d, em, { kind: KIND.POSITION, guid: 99, landblockId: 0xa9b40021, x: 1, y: 1, z: 1 });
  markOutdoorEntities(scene3d);
  assert.equal(self.root.userData.__splitOutdoor, false);
});

await t("R6 the pre-draw is narrowed to the doorway rect and fully restored", () => {
  const world = makeWorld();
  const seal = makeSeal(world, { logDepth: true });
  seal.remainderRect = { x0: 0.25, y0: 0.1, x1: 0.5, y1: 0.6 };
  const cam = new THREE.PerspectiveCamera(60, 2, 0.1, 5000);
  cam.updateMatrixWorld();
  const projBefore = cam.projectionMatrix.clone();
  seal.camera = cam;
  const target = fakeTarget();
  let seen = null;
  const renderer = {
    autoClear: true, shadowMap: { autoUpdate: true }, _t: null,
    getRenderTarget() { return this._t; }, setRenderTarget(t) { this._t = t; },
    render(_s, c) {
      seen = { view: c.view ? { ...c.view } : null, viewport: target.viewport.clone(), proj: c.projectionMatrix.clone() };
    },
  };
  new SealRemainderPass(seal).render(renderer, target);
  assert.ok(seen && seen.view && seen.view.enabled, "camera view offset set during the draw");
  // 400x200 target: x 0.25→100-1=99 … 0.5→200+1=201; y (bottom-up) 0.1→20-1=19 … 0.6→120+1=121.
  assert.deepEqual([seen.viewport.x, seen.viewport.y, seen.viewport.z, seen.viewport.w], [99, 19, 102, 102]);
  assert.deepEqual([seen.view.fullWidth, seen.view.fullHeight, seen.view.offsetX, seen.view.offsetY, seen.view.width, seen.view.height],
    [400, 200, 99, 200 - 19 - 102, 102, 102]);
  assert.ok(!seen.proj.equals(projBefore), "projection narrowed");
  assert.equal(cam.view, null);
  assert.ok(cam.projectionMatrix.equals(projBefore));
  assert.deepEqual(target.viewport.toArray(), [0, 0, 400, 200]);
  assert.equal(seal.remainderNarrowed, 1);
  // Degenerate / full-frame rects do not narrow.
  assert.equal(narrowCameraToRect(renderer, cam, target, { x0: 0, y0: 0, x1: 1, y1: 1 }), null);
  assert.equal(narrowCameraToRect(renderer, cam, target, null), null);
});

await t("R7 after the cells pass the sealed pixels carry the OUTDOOR depth again", () => {
  const world = makeWorld();
  const seal = makeSeal(world, { logDepth: true });
  const { px, log } = runIndoorFrame(world, seal);
  assert.ok(log.includes("RESTORE"));
  assert.equal(seal.depthRestores, 1);
  // A: the post effects now read the outdoor NPC's distance, not the wall.
  assert.equal(px.A.depth, 0.45);
  // B: the hill.
  assert.equal(px.B.depth, 0.4);
  // C: the chair won in front of the wall and keeps its own depth.
  assert.equal(px.C.depth, 0.2);
  // The restore pass asks the composer to re-blit its stable depth copy.
  assert.equal(new SealDepthRestorePass(seal).needsDepthBlit, true);
  // The GLSL is restoredDepth(): same predicate, same seal depth expression.
  const mat = seal._restoreMat;
  assert.ok(mat, "restore material built");
  assert.match(mat.fragmentShader, /gl_FragDepth = abs\(cur - own\) <= 1\.0e-5 \? texelFetch\(tSaved, p, 0\)\.r : cur;/);
  const sealFrag = seal._punchMat.fragmentShader.split("\n").find((l) => l.includes("gl_FragDepth ="));
  const rhs = sealFrag.split("=").slice(1).join("=").trim();
  assert.ok(mat.fragmentShader.includes("float own = " + rhs), "own = the seal's log-depth expression");
  assert.equal(mat.depthFunc, THREE.AlwaysDepth);
  assert.equal(mat.colorWrite, false);
  assert.equal(restoredDepth(WALL, WALL, 0.9), 0.9);
  assert.equal(restoredDepth(0.2, WALL, 0.9), 0.2);
});

console.log(`portal seal retail order: ${groups} groups ok, ${failures} failed`);
process.exit(failures ? 1 : 0);
