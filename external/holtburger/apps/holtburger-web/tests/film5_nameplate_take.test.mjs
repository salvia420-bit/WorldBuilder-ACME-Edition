// tests/film5_nameplate_take.test.mjs — FILM-5 remainder (2026-10-18 review
// follow-up, §10.5 "FILM-5").
//
// The fix pass made film's clean frame hide nameplate and buff-badge sprites by
// taking them off every camera layer (`layers.mask = 0`), which the nameplate
// LOD loop does not touch. Two paths still put a sprite back into the footage
// during a clean take (`?filmMode=on` + `?nameplates=on`, no `hud=none`):
//   T1  an appearance hot-swap re-stamps the rig onto the indoor layer
//       (entities.js `_stampEntityIndoorLayer`), nameplate and badge included;
//   T2  a nameplate created mid-take (an entity spawns into the shot);
//   T3  a buff badge created mid-take (a buff lands on an entity);
//   T4  a wielded child re-stamped by its mount (attachChildToParent).
// Now the stamp writes the mask the sprite returns to (`__filmCleanMask`), and
// nameplate_sprite.js hides a sprite it creates while the take is flagged on the
// entity manager. T5: restore() puts every sprite on the layer it would have had
// without the take; T6: with no take, spawn / hot-swap / attach stamp exactly as
// before.
//
// Drives the REAL EntityManager (spawn, _applyAppearanceHotSwap,
// attachChildToParent), the REAL nameplate_sprite bakes + LOD and the REAL
// clean_frame, with fake wasm and a canvas stub.
// Run from apps/holtburger-web/:  node tests/film5_nameplate_take.test.mjs

import assert from "node:assert/strict";

// No `window` while the modules load: nameplate_sprite.js then leaves its
// browser-only blocks (rAF LOD loop, buffs-hud subscription) unarmed and its
// bakes enabled, as in the other headless nameplate suites.
const THREE = await import("three");
const { EntityManager } = await import("../scene3d/entities.js");
const NP = await import("../scene3d/nameplate_sprite.js");
const CF = await import("../scene3d/film/runtime/clean_frame.js");
const { installFakeMotionSequence } = await import("../harness/lib/fake_motion_sequence.mjs");
installFakeMotionSequence();

let passed = 0;
let failed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log(`  [PASS] ${name}`); }
  catch (e) { failed++; console.log(`  [FAIL] ${name} — ${(e && e.stack) || e}`); }
}
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 1)); };

// Canvas 2D stub: the system-font nameplate and the badge bakes only measure and draw.
const ctx2d = new Proxy({}, {
  get: (o, k) => (k in o ? o[k] : k === "measureText" ? () => ({ width: 60 }) : () => {}),
  set: (o, k, v) => { o[k] = v; return true; },
});
globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ctx2d }) };

const ME = 0x50000001;
const READY = 0x41000003;
const NONCOMBAT = 0x8000003d;
const PART_COUNT = 2;
const summaries = new Map(); // guid → buffs-hud summary
Object.assign(globalThis.window, {
  location: { search: "" },
  __playEffectVfxBound: true,
  __spellShapePreviewBound: true,
  __pluginClient: { events: { emit() {}, on() {} } },
  __sessionHandle: {
    getLocalPlayerPose: () => ({ x: 0, y: 0, z: 0, heading: 0, landblockId: 0xa9b40001 }),
    combatMode: () => 2,
  },
  getLocalPlayerGuid: () => ME,
  __buffsHudGetEntitySummary: (guid) => summaries.get(guid >>> 0) || { buffs: 0, debuffs: 0, cooldowns: 0 },
});

// The system-font bake waits for the AC font or a 5 s timeout: fire the timeout now.
{
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...a) => realSetTimeout(fn, ms >= 5000 ? 0 : ms, ...a);
  try {
    assert.equal(NP.createNameplateSprite("warmup"), null, "deferred behind the font gate");
    await settle();
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
  assert.ok(NP.createNameplateSprite("warmup"), "the gate is open: system-font bakes run");
}

function partMesh(p) {
  return {
    triCount: 1,
    positions: new Float32Array([p, 0, 0, p + 0.5, 0, 0, p + 0.25, 0.5, 0]),
    uvs: new Float32Array([0, 0, 1, 0, 0.5, 1]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    surfaceIndices: new Uint8Array([0]),
    surfaces: new Uint32Array([0x08001234]),
  };
}
const wasmExports = {
  async fetchEntityAnimationKeyframes(_s, _mc, _tc, _pal, _subs, _mt, _cmd, stance, fromMotion) {
    const n = 4;
    const partFrames = new Float32Array(n * PART_COUNT * 7);
    for (let i = 0; i < n * PART_COUNT; i += 1) partFrames[i * 7 + 3] = 1;
    const meshes = Array.from({ length: PART_COUNT }, (_, p) => partMesh(p));
    return {
      partCount: PART_COUNT, numFrames: n, framerate: 30,
      resolvedStance: (stance >>> 0) || NONCOMBAT, isLink: !!fromMotion, partFrames,
      takePartMeshes() { return meshes.splice(0); },
    };
  },
  async fetchMotionLinkKeyframes() { return undefined; },
  async fetch_surfaces_pixels(dids) {
    return dids.map(() => ({ pixels: new Uint8Array(16).fill(255), width: 2, height: 2 }));
  },
  async fetchSetupHoldingLocations() {
    return { takeLocations: () => [{ locationKey: 1, partId: 1, ox: 0, oy: 0, oz: 0, qw: 1, qx: 0, qy: 0, qz: 0 }] };
  },
};
const meta = (guid, name, extra = {}) => ({
  guid, modelId: 0x02000001, mtableId: 0x09000001,
  landblockId: 0xa9b40001, x: 10, y: 10, z: 0, qw: 1, qx: 0, qy: 0, qz: 0,
  paletteId: 0, motionCommand: READY, motionStance: NONCOMBAT, objScale: 1, name,
  wcid: 1, itemType: 0x10, iconId: 0,
  modelChanges: new Uint32Array(0), textureChanges: new Uint32Array(0), subPalettes: new Uint32Array(0),
  ...extra,
});
const redress = (inst) => ({ ...inst.meta, modelChanges: new Uint32Array([0, 0x01000abc]) });

/** A world: manager + live facade + a camera that draws layers 0 and 1, like the client's. */
async function world() {
  const entitiesGroup = new THREE.Group();
  const em = new EntityManager({ entitiesGroup, materialCache: null }, wasmExports);
  const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 5000);
  camera.layers.enable(1);
  const live = { entityManager: em, cameraSwitcher: { activeCamera: camera }, camera };
  globalThis.window.liveScene3d = live;
  const spawn = async (guid, name) => {
    const inst = await em.spawn(meta(guid, name));
    assert.ok(inst && inst._nameplateSprite, `0x${guid.toString(16)} spawned with a nameplate`);
    entitiesGroup.updateMatrixWorld(true);
    return inst;
  };
  const badge = (inst, buffs) => {
    summaries.set(inst.guid >>> 0, { buffs, debuffs: 0, cooldowns: 0 });
    const s = NP.refreshBuffBadgeForEntity(inst);
    assert.ok(s, "a badge sprite");
    return s;
  };
  /** The LOD's next animation frame, measured from beside the first rig. */
  const lod = () => {
    entitiesGroup.updateMatrixWorld(true);
    NP.tickNameplateLod(live);
  };
  const drawn = (s) => !!s && s.visible === true && s.layers.test(camera.layers);
  const aim = (inst) => {
    const p = new THREE.Vector3().setFromMatrixPosition(inst.root.matrixWorld);
    camera.position.set(p.x, p.y + 2, p.z + 5);
    camera.updateMatrixWorld(true);
  };
  const cf = CF.createCleanFrame({ document: null, window: null, liveScene3d: live });
  return { em, live, camera, spawn, badge, lod, drawn, aim, cf };
}

const G1 = 0x80006001, G2 = 0x80006002, G3 = 0x80006003, G4 = 0x80006004, G5 = 0x80006005;
const W = await world();
let e1, e1Badge, e2, e2Badge, child;

await t("T0 before the take: the nameplate and badge are drawn", async () => {
  e1 = await W.spawn(G1, "Drudge Skulker");
  W.aim(e1);
  e1Badge = W.badge(e1, 2);
  child = await W.spawn(G3, "Wakizashi");
  W.lod();
  assert.equal(W.drawn(e1._nameplateSprite), true);
  assert.equal(W.drawn(e1Badge), true);
  assert.equal(W.drawn(child._nameplateSprite), true);
  const r = W.cf.apply();
  assert.equal(r.steps.nameplates.ok, true);
  W.lod();
  assert.equal(W.drawn(e1._nameplateSprite), false, "the clean frame hides it");
});

await t("T1 an appearance hot-swap mid-take keeps the nameplate and badge out of the footage", async () => {
  assert.equal(await W.em._applyAppearanceHotSwap(e1, redress(e1), G1), true, "the hot-swap ran");
  W.lod();
  assert.equal(e1._nameplateSprite.visible, true, "the LOD re-shows the near plate");
  assert.equal(W.drawn(e1._nameplateSprite), false, "but the re-stamp did not put it back on a layer");
  assert.equal(W.drawn(e1Badge), false);
  const part = e1.parts[0].children.find((o) => o.isMesh);
  assert.equal(part.layers.mask, 1 << 1, "the rebuilt part meshes are on the indoor layer");
});

await t("T2 a nameplate created mid-take is hidden", async () => {
  e2 = await W.spawn(G2, "Mosswart Mudsoaker");
  W.lod();
  assert.equal(e2._nameplateSprite.visible, true, "the LOD shows it");
  assert.equal(W.drawn(e2._nameplateSprite), false, "off every layer: not in the footage");
});

await t("T3 a buff badge created mid-take is hidden", async () => {
  e2Badge = W.badge(e2, 3);
  W.lod();
  assert.equal(e2Badge.visible, true);
  assert.equal(W.drawn(e2Badge), false);
  const e1Badge2 = W.badge(e1, 4); // a changed count bakes a NEW badge sprite
  assert.notEqual(e1Badge2, e1Badge);
  e1Badge = e1Badge2;
  W.lod();
  assert.equal(W.drawn(e1Badge), false);
});

await t("T4 a child re-stamped by its mount mid-take stays hidden", async () => {
  await W.em.attachChildToParent(G3, G1, 1, 1);
  assert.equal(child.root.parent, e1.parts[1], "mounted on the wielder's part");
  W.lod();
  assert.equal(child._nameplateSprite.visible, true);
  assert.equal(W.drawn(child._nameplateSprite), false);
});

await t("T5 restore: every sprite back on the layer it would have had without the take", async () => {
  W.cf.restore();
  W.lod();
  assert.equal(W.em._filmCleanNameplates, undefined, "the take flag is gone");
  assert.equal(e1._nameplateSprite.layers.mask, 1 << 1, "re-stamped by the hot-swap: indoor layer");
  assert.equal(e1Badge.layers.mask, 1, "made mid-take, never stamped: layer 0");
  assert.equal(e2._nameplateSprite.layers.mask, 1);
  assert.equal(e2Badge.layers.mask, 1);
  assert.equal(child._nameplateSprite.layers.mask, 1 << 1, "re-stamped by the mount");
  for (const s of [e1._nameplateSprite, e1Badge, e2._nameplateSprite, e2Badge, child._nameplateSprite]) {
    assert.equal(s.__filmCleanMask, undefined, "no stash left behind");
    assert.equal(W.drawn(s), true, "drawn again; the LOD decides");
  }
});

await t("T6 no take: spawn, hot-swap, badge and mount stamp exactly as before", async () => {
  const e4 = await W.spawn(G4, "Banderling Scout");
  assert.equal(e4._nameplateSprite.layers.mask, 1, "a fresh plate sits on layer 0 (the spawn stamp ran before it)");
  assert.equal(await W.em._applyAppearanceHotSwap(e4, redress(e4), G4), true);
  assert.equal(e4._nameplateSprite.layers.mask, 1 << 1, "the hot-swap stamp moves it to the indoor layer");
  const b = W.badge(e4, 1);
  assert.equal(b.layers.mask, 1);
  const c = await W.spawn(G5, "Yumi");
  await W.em.attachChildToParent(G5, G4, 1, 1);
  assert.equal(c._nameplateSprite.layers.mask, 1 << 1, "the mount stamps the child's plate");
  for (const s of [e4._nameplateSprite, b, c._nameplateSprite]) assert.equal(s.__filmCleanMask, undefined);
});

console.log(`\nfilm5_nameplate_take: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
