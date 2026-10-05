// tests/portal_seal_retail_order.test.mjs
//
// The indoor portal SEAL in retail order (2026-10-05 round 2, `?sealLogDepth`).
// Retail PView::DrawCells (acclient.c:461450-461560):
//   LScape::draw (ALL outdoor content) → Clear(Z) → DrawPortalPolyInternal(
//   portal, 0) for the other_cell_id == -1 portals of the REACHED cells, only
//   when outside_view.view_count != 0 → the cells.
//
//   R1  DRAW ORDER (behavioural, not regex). A fake renderer rasterises one
//       doorway pixel through the real composer sequence: world pass (layer 0)
//       → depth clear → the real PortalPunchPass("seal").render → cells pass
//       (layer 1). The player-landblock outdoor static cells.js relayers onto
//       layer 1 and an entity in an outdoor landcell must be drawn BEFORE the
//       stamp and stay visible through the doorway; an EnvCell, an indoor
//       entity and an interior particle beyond the wall must not.
//       Fails on the old seal pass (no pre-draw): the tree is drawn only by the
//       cells pass, after the wall, and is rejected.
//   R2  the pre-draw restores everything it touches (visibility, camera mask,
//       scene.background, shadow auto-update), and `?sealLogDepth=off` skips it.
//   R3  LOG-DEPTH MODEL: the seal's depth statements are three's own
//       logdepthbuf chunk statements, and evaluated at the same point they give
//       the value a MeshBasicMaterial fragment writes there (and the old
//       perspective seal does not).
//   R4  FEED (cells.js tickPortalSeal): apertures come from the PView walk's
//       outside view (wasm getPViewOutsidePortals), not from every
//       frustum-visible EnvCell; a mouthless dungeon (empty outside view)
//       stamps nothing; a stale pkg falls back to the unrestricted export.
//       Fails on the old feed (always the unrestricted export).
//   R5  markOutdoorEntities flags outdoor-landcell entities, never the player.
//
// Run: node tests/portal_seal_retail_order.test.mjs

import * as THREE from "three";
import assert from "node:assert/strict";

globalThis.location = { search: "" };
const { PortalPunchPass, collectOutdoorRemainderHidden } = await import("../scene3d/portal_punch.js");
const { tickPortalSeal, markOutdoorEntities } = await import("../scene3d/cells.js");

let groups = 0;
async function t(name, fn) {
  await fn();
  groups++;
  console.log("  ok ", name);
}

const WORLD_ONLY = 1 << 0;
const INDOOR_ONLY = 1 << 1;

// ---------------------------------------------------------------------------
// One-pixel rasteriser. Every mesh carries `userData.px` = its depth at the
// doorway pixel (undefined = does not cover it). Normal materials: LessEqual +
// depth write. The seal material (depthFunc Always) writes the wall depth.
function makePixelRenderer(wallDepth) {
  const px = { color: "clear", depth: 1.0 };
  const log = [];
  const renderer = {
    autoClear: true,
    shadowMap: { autoUpdate: true },
    _target: null,
    getRenderTarget() { return this._target; },
    setRenderTarget(t) { this._target = t; },
    clearStencil() {},
    clearDepth() { px.depth = 1.0; },
    render(scene, cam) {
      scene.traverseVisible((o) => {
        if (!o.isMesh || !o.layers.test(cam.layers)) return;
        if (o.material?.name === "portal-seal") {
          log.push("SEAL");
          px.depth = wallDepth;
          return;
        }
        log.push(o.name);
        const d = o.userData.px;
        if (d === undefined) return;
        if (d <= px.depth) { px.depth = d; px.color = o.name; }
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
  // Doorway pixel, wall at 0.30. Terrain far away behind everything.
  terrainGroup.add(mesh("terrain", 0, 0.9));
  // Player-landblock outdoor content, relayered onto layer 1 by cells.js.
  staticsGroup.add(mesh("tree", 1, 0.5, { __splitLayer: 1, landblockId: 0xa9b40000 }));
  buildingsGroup.add(mesh("shell", 1, undefined, { __splitLayer: 1, landblockId: 0xa9b40000 }));
  // Another landblock's house: stays on layer 0, drawn by the world pass.
  buildingsGroup.add(mesh("otherLbHouse", 0, 0.7, { landblockId: 0xaab40000 }));
  // Interior-anchored particle: layer 1 at emission, NOT relayered.
  staticsGroup.add(mesh("interiorParticle", 1, 0.35));
  // An EnvCell surface beyond the wall (another building's room).
  cellsGroup.add(mesh("envcell", 1, 0.6));
  // Entities.
  entitiesGroup.add(mesh("npcOutdoor", 1, 0.45, { __splitOutdoor: true }));
  entitiesGroup.add(mesh("npcIndoorFar", 1, 0.4));
  entitiesGroup.add(mesh("playerInRoom", 1, undefined));
  return { scene, worldRoot, buildingsGroup, staticsGroup, cellsGroup, entitiesGroup };
}

function makeSeal(world, opts = {}) {
  const pass = new PortalPunchPass(null, null, "seal", opts);
  // One doorway quad (AC coords; the fake rasteriser ignores geometry).
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

// The composer's armed indoor sequence (atmosphere_pipeline.js preFrameSkySync
// `indoorSplitArmed && isIndoor`): worldMask → world → depthClear → seal →
// cellsMask → cells → restore mask.
function runIndoorFrame(world, seal, wallDepth) {
  const cam = new THREE.PerspectiveCamera();
  const { renderer, px, log } = makePixelRenderer(wallDepth);
  const target = { isFakeTarget: true, scissor: new THREE.Vector4(), scissorTest: false, samples: 0, width: 4, height: 4 };
  cam.layers.mask = WORLD_ONLY;
  renderer.render(world.scene, cam);
  log.push("CLEAR");
  renderer.clearDepth();
  seal.camera = cam;
  seal.render(renderer, target);
  cam.layers.mask = INDOOR_ONLY;
  renderer.render(world.scene, cam);
  cam.layers.mask = WORLD_ONLY | INDOOR_ONLY;
  return { px, log, cam, renderer };
}

console.log("portal seal — retail order");

await t("R1 outdoor remainder is drawn before the stamp and survives it", () => {
  const world = makeWorld();
  const seal = makeSeal(world, { logDepth: true });
  const { px, log } = runIndoorFrame(world, seal, 0.3);
  const sealAt = log.indexOf("SEAL");
  const clearAt = log.indexOf("CLEAR");
  assert.ok(sealAt > clearAt, "seal after the depth clear");
  const before = log.slice(clearAt + 1, sealAt);
  for (const n of ["tree", "shell", "npcOutdoor"]) {
    assert.ok(before.includes(n), `${n} must be drawn between the clear and the stamp; got ${before.join(",")}`);
  }
  for (const n of ["envcell", "npcIndoorFar", "interiorParticle", "playerInRoom", "terrain", "otherLbHouse"]) {
    assert.ok(!before.includes(n), `${n} must NOT be drawn before the stamp`);
  }
  // The nearest OUTDOOR thing in the doorway wins: the outdoor NPC (0.45) in
  // front of the tree (0.5); the indoor NPC (0.40) and the EnvCell (0.60) lie
  // beyond the wall (0.30) and are rejected.
  assert.equal(px.color, "npcOutdoor");
});

await t("R1b without the outdoor entity, the relayered tree is what shows", () => {
  const world = makeWorld();
  world.entitiesGroup.children.find((c) => c.name === "npcOutdoor").userData.__splitOutdoor = false;
  const seal = makeSeal(world, { logDepth: true });
  const { px } = runIndoorFrame(world, seal, 0.3);
  assert.equal(px.color, "tree");
});

await t("R2 the pre-draw restores visibility, mask, background and shadow auto-update", () => {
  const world = makeWorld();
  const bg = world.scene.background;
  const seal = makeSeal(world, { logDepth: true });
  const visBefore = [];
  world.scene.traverse((o) => visBefore.push(o.visible));
  const { cam, renderer } = runIndoorFrame(world, seal, 0.3);
  const visAfter = [];
  world.scene.traverse((o) => visAfter.push(o.visible));
  assert.deepEqual(visAfter, visBefore);
  assert.equal(world.scene.background, bg);
  assert.equal(renderer.shadowMap.autoUpdate, true);
  assert.equal(cam.layers.mask, WORLD_ONLY | INDOOR_ONLY);
  assert.equal(seal.remainderDraws, 1);
  const hidden = collectOutdoorRemainderHidden(seal.outdoorRemainder);
  assert.deepEqual(hidden.map((o) => o.name || o.type).sort(),
    ["Group", "Group", "interiorParticle", "npcIndoorFar", "playerInRoom"].sort(),
    "terrain + cells groups, the interior particle and the non-outdoor entities");
});

await t("R2b ?sealLogDepth=off (logDepth false) skips the pre-draw: the old frame", () => {
  const world = makeWorld();
  const seal = makeSeal(world, { logDepth: false });
  const { log } = runIndoorFrame(world, seal, 0.3);
  const before = log.slice(log.indexOf("CLEAR") + 1, log.indexOf("SEAL"));
  assert.deepEqual(before, []);
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
  assert.equal(norm(sealFrag), norm(chunkFrag), "same fragment statement as MeshBasic's chunk");
  assert.equal(norm(sealVert), norm(chunkVert), "same vertex statement as MeshBasic's chunk");

  // Evaluate both at a doorway point 5 m in front of the renderer's camera.
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
  assert.ok(Math.abs(sealDepth - basicDepth) < 1e-12, `${sealDepth} vs ${basicDepth}`);
  assert.ok(Math.abs(sealDepth - Math.log2(1 + 5) / Math.log2(1 + 5000)) < 1e-9);
  // The old perspective seal wrote gl_FragCoord.z: ~0.98 here, i.e. kilometres
  // away in the log buffer — the wall rejected almost nothing.
  assert.ok(glFragCoordZ - sealDepth > 0.5, `perspective ${glFragCoordZ} vs log ${sealDepth}`);
});

// ---------------------------------------------------------------------------
// R4: the feed.
function quadAt(y, x0, x1) {
  // AC coords (Z-up): a 2x2 m doorway quad facing the camera at AC y = `y`.
  return [4, x0, y, 0, x1, y, 0, x1, y, 2, x0, y, 2];
}
function makeFeedScene3d() {
  const world = makeWorld();
  const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 5000);
  // three Y-up; worldRoot maps AC (x, y, z) → three (x, z, -y) (index.js).
  world.worldRoot.rotation.x = -Math.PI / 2;
  world.worldRoot.updateMatrixWorld(true);
  camera.position.set(0, 1, 0);
  camera.lookAt(0, 1, -10); // = AC +y
  camera.updateMatrixWorld(true);
  const seal = new PortalPunchPass(null, null, "seal", { logDepth: true });
  return {
    ...world,
    camera,
    _indoorSplitArmed: true,
    atmospherePipeline: { portalSealPass: seal },
    seal,
  };
}

await t("R4 the seal is fed from the PView outside view, not every visible EnvCell", () => {
  const s3 = makeFeedScene3d();
  const sh = {
    getPViewOutsidePortals: () => Float32Array.from([1, ...quadAt(5, -1, 1)]),
    getVisiblePortalApertures: () => Float32Array.from([2, ...quadAt(5, -1, 1), ...quadAt(8, 2, 4)]),
  };
  tickPortalSeal(s3, sh);
  assert.equal(s3.seal.hasApertures, true);
  assert.equal(s3.seal._apertureCount, 1, "only the reached cell's outdoor portal");
  assert.equal(s3._portalSealDiag.source, "pview-outside");
  assert.ok(s3.seal.outdoorRemainder && s3.seal.outdoorRemainder.worldRoot === s3.worldRoot);
});

await t("R4b mouthless dungeon: empty outside view → no stamp, no pre-draw", () => {
  const s3 = makeFeedScene3d();
  const sh = {
    getPViewOutsidePortals: () => Float32Array.from([0]),
    // The unrestricted export still sees the surface buildings of the loaded
    // neighbour landblocks — the 0x01D90100 report.
    getVisiblePortalApertures: () => Float32Array.from([2, ...quadAt(5, -1, 1), ...quadAt(8, 2, 4)]),
  };
  tickPortalSeal(s3, sh);
  assert.equal(s3.seal.hasApertures, false);
  assert.equal(s3.seal.outdoorRemainder, null);
});

await t("R4c stale pkg (no getPViewOutsidePortals) falls back to the unrestricted export", () => {
  const s3 = makeFeedScene3d();
  const sh = {
    getVisiblePortalApertures: () => Float32Array.from([2, ...quadAt(5, -1, 1), ...quadAt(8, 2, 4)]),
  };
  tickPortalSeal(s3, sh);
  assert.equal(s3.seal._apertureCount, 2);
  assert.equal(s3._portalSealDiag.source, "frustum-unrestricted");
});

await t("R4d disarmed split clears apertures and the remainder", () => {
  const s3 = makeFeedScene3d();
  const sh = { getPViewOutsidePortals: () => Float32Array.from([1, ...quadAt(5, -1, 1)]) };
  tickPortalSeal(s3, sh);
  s3._indoorSplitArmed = false;
  tickPortalSeal(s3, sh);
  assert.equal(s3.seal.hasApertures, false);
  assert.equal(s3.seal.outdoorRemainder, null);
});

await t("R5 markOutdoorEntities: outdoor landcell → flagged; EnvCell, unknown, player → not", () => {
  const mk = () => ({ root: { userData: {} } });
  const a = { ...mk(), _wireCellIdx: 0x0021 };
  const b = { ...mk(), _wireCellIdx: 0x0105 };
  const c = { ...mk(), _outdoorCellIdx: 0x0003 };
  const d = mk();
  const self = { ...mk(), _outdoorCellIdx: 0x0010 };
  const entityMap = new Map([[1, a], [2, b], [3, c], [4, d], [99, self]]);
  const n = markOutdoorEntities({ entityManager: { entityMap, _localPlayerGuid: () => 99 } });
  assert.equal(n, 2);
  assert.equal(a.root.userData.__splitOutdoor, true);
  assert.equal(b.root.userData.__splitOutdoor, false);
  assert.equal(c.root.userData.__splitOutdoor, true);
  assert.equal(d.root.userData.__splitOutdoor, false);
  assert.equal(self.root.userData.__splitOutdoor, false);
});

console.log(`portal seal retail order: ${groups} groups ok`);
