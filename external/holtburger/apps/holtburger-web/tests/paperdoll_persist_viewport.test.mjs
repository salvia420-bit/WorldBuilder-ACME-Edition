// tests/paperdoll_persist_viewport.test.mjs — hud-audio-2 (2026-10-20,
// improvement hunt): one long-lived paperdoll viewport per consumer.
//
// Before: plugins/inventory.js built `new PaperdollViewport` (= a new
// THREE.WebGLRenderer = a new WebGL2 context + program cache + palette
// re-composite + texture uploads) on EVERY inventory open and
// dispose()+forceContextLoss()-ed it on every close; plugins/examine-target.js
// did the same per creature / player examine, and its onAppearanceRefresh
// disposed + re-created the doll for ANY entity's entityAppearanceChanged.
//
// Pinned here, with three r184's REAL WebGLRenderer over
// tests/helpers/fake_webgl2.mjs (construction + loseContext counters):
//   [1] inventory view mount → cleanup ×3 (the real plugins/inventory.js,
//       spliced as in inventory_dnd_dom): ONE renderer, no context loss, no
//       rebuild for an unchanged appearance, canvas re-parented each mount.
//   [2] creature examine (the real plugins/examine-target.js) ×3: ONE
//       renderer; an appearance event for ANOTHER guid → no rebuild, no
//       construction (the bug trigger: the old handler re-created the doll);
//       an event for the examined guid → loadPlayer on the SAME instance.
//   [3] pixel identity: a re-acquired viewport draws nothing until its first
//       loadPlayer (like a fresh instance), a same-key re-acquire draws the
//       identical draw/uniform stream without a rebuild, and a reused
//       viewport rebuilding rig A after rig B draws exactly what a fresh one
//       draws for rig A.
//   [4] a degraded build (placeholder material) re-loads on re-acquire.
//   [5] stale in-flight builds never land over a newer doll (the composite
//       race used to leave BOTH rigs in rigRoot — a double doll).
//   [6] a second concurrent acquire → transient viewport, disposed on release.
//   [7] `?paperdollPersist=off` → per-mount construct + dispose (today).
//   [8] context loss / pagehide / the parked-texture budget dispose.
//
// Run from apps/holtburger-web/:  node tests/paperdoll_persist_viewport.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as THREE from "three";
import { installFakeDom, FakeEvent } from "./helpers/fake_dom_items.mjs";
import { createFakeWebGL2 } from "./helpers/fake_webgl2.mjs";
import { spliceModule } from "../harness/lib/splice_module.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(HERE, "..");

globalThis.window = globalThis;
const { document } = installFakeDom(globalThis);

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log(`  [PASS] ${name}`); }
  catch (e) { failed++; console.log(`  [FAIL] ${name} — ${e.stack || e.message}`); }
}
const tick = () => new Promise((r) => setTimeout(r, 0));
async function settle() { for (let i = 0; i < 6; i++) await tick(); }
// three logs "Context Lost." through console.log; the doll logs every load.
const quietInfo = console.info;
console.info = () => {};

// ── the counting renderer factory (the seam the viewport builds through) ──
const pd = await import(pathToFileURL(path.join(APP, "ui", "ac_paperdoll_viewport.js")).href);
const counters = { renderers: 0, loseContext: 0 };
const glOf = new WeakMap(); // renderer → fake gl
const canvasOf = new WeakMap(); // renderer → canvas
function countingRenderer(opts) {
  counters.renderers += 1;
  const gl = createFakeWebGL2({ width: 224, height: 214 });
  const baseGetExtension = gl.getExtension;
  gl.getExtension = (name) => (name === "WEBGL_lose_context"
    ? { loseContext() { counters.loseContext += 1; }, restoreContext() {} }
    : baseGetExtension(name));
  const canvas = document.createElement("canvas");
  canvas.getContext = () => gl;
  try { gl.canvas = canvas; } catch (_) { /* proxy */ }
  const r = new THREE.WebGLRenderer({ ...opts, canvas, context: gl });
  glOf.set(r, gl);
  canvasOf.set(r, canvas);
  return r;
}
function resetPool(persist = true) {
  pd._configurePaperdollPoolForTests({ createRenderer: countingRenderer, persist });
  counters.renderers = 0;
  counters.loseContext = 0;
}
resetPool(true);

// ── stub world: animation cache + wasm compositor + material cache ───────
const S_SKIN = 0x08000101, S_SHIRT = 0x08000102, S_HELM = 0x08000103;
const geoA = new THREE.BoxGeometry(0.4, 1.0, 0.3);
const geoB = new THREE.BoxGeometry(0.3, 0.3, 0.3);
const rigs = new Map(); // setupId → animEntry (shared, like AnimationCache's)
function rigFor(setupId) {
  if (!rigs.has(setupId)) {
    const twoParts = (setupId & 1) === 1;
    const partGroups = [
      { surfaceDids: [S_SKIN, S_SHIRT], groups: [{ surfaceDid: S_SKIN, geometry: geoA }, { surfaceDid: S_SHIRT, geometry: geoB }] },
    ];
    const restOrigins = [0, 0, 0];
    const restOrientations = [1, 0, 0, 0];
    if (twoParts) {
      partGroups.push({ surfaceDids: [S_HELM], groups: [{ surfaceDid: S_HELM, geometry: geoB }] });
      restOrigins.push(0, 0, 1.6);
      restOrientations.push(1, 0, 0, 0);
    }
    rigs.set(setupId, { partGroups, restOrigins, restOrientations });
  }
  return rigs.get(setupId);
}
const stats = { animGets: 0, composites: 0 };
let animGate = null; // optional (setupId) => Promise, to hold a load mid-flight
let compositeGate = null;
const fallbackMaterial = new THREE.MeshStandardMaterial({ color: 0x777777 });
const sharedMats = new Map([
  [S_SKIN, new THREE.MeshStandardMaterial({ color: 0xc08060 })],
  [S_SHIRT, new THREE.MeshStandardMaterial({ color: 0x3050a0 })],
  [S_HELM, new THREE.MeshStandardMaterial({ color: 0xa0a0a0 })],
]);
const em = {
  entityMap: new Map(),
  animationCache: {
    async get(setupId) {
      stats.animGets += 1;
      if (animGate) await animGate(setupId);
      return rigFor(setupId);
    },
  },
  wasmExports: {
    fetchEntityAnimationKeyframes: () => null,
    async fetchEntitySurfacesPixels(dids, paletteId, subs) {
      stats.composites += 1;
      if (compositeGate) await compositeGate(paletteId);
      return Array.from(dids, (d) => ({
        width: 2, height: 2,
        pixels: new Uint8Array(16).fill((d + paletteId * 3 + (subs?.[0] ?? 0) * 7) & 0xff),
        free() {},
      }));
    },
    fetchSetupHoldingLocations: async () => ({ takeLocations: () => [] }),
  },
  materialCache: {
    fallbackMaterial,
    getCached: (did) => sharedMats.get(did >>> 0) ?? fallbackMaterial,
  },
};
globalThis.liveScene3d = { entityManager: em };

// draw/uniform stream of one render, normalised to first-seen program /
// texture order (as tests/uniform_bind_patch.test.mjs does).
function normalizeSnaps(snaps) {
  const progIds = new Map(), texIds = new Map();
  const norm = (v) => {
    if (typeof v === "string" && v.startsWith("tex#")) {
      if (!texIds.has(v)) texIds.set(v, `T${texIds.size}`);
      return texIds.get(v);
    }
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === "object" && typeof v.length === "number") return Array.from(v);
    return v;
  };
  return snaps.map((s) => {
    if (!progIds.has(s.program)) progIds.set(s.program, `P${progIds.size}`);
    const u = {};
    for (const k of Object.keys(s.uniforms).sort()) u[k] = norm(s.uniforms[k]);
    return { kind: s.kind, program: progIds.get(s.program), u };
  });
}
// What the stream cannot see: the texel bytes + material inputs per mesh.
function rigInputs(vp) {
  const out = [];
  vp.rigRoot.traverse((o) => {
    if (!o.isMesh) return;
    const m = o.material;
    out.push({
      geo: o.geometry.id, color: m.color?.getHex(), side: m.side,
      texels: m.map ? Array.from(m.map.image.data) : null,
      world: Array.from(o.matrixWorld.elements, (v) => +v.toFixed(6)),
    });
  });
  return out;
}
function drawStream(vp) {
  const gl = glOf.get(vp.renderer);
  gl.__fake.startSnapshots();
  vp.renderNow();
  return normalizeSnaps(gl.__fake.takeSnapshots() || []);
}

// ── [1] inventory: the real plugins/inventory.js view ────────────────────
console.log("\n[1] inventory view: open/close cycles share one WebGL context");
const ME = 0x50000001;
const SETUP_PLAYER = 0x02000001; // odd → two parts
const playerMeta = {
  modelId: SETUP_PLAYER, mtableId: 0x09000001, paletteId: 0x04000a01,
  subPalettes: new Uint32Array([0x04000b01, 0, 8]),
  modelChanges: new Uint32Array(0), textureChanges: new Uint32Array(0),
};
em.entityMap.set(ME, { meta: playerMeta });
const busL = new Map();
const bus = {
  on(n, f) { if (!busL.has(n)) busL.set(n, new Set()); busL.get(n).add(f); },
  off(n, f) { busL.get(n)?.delete(f); },
  // plugins/api.js: handlers receive CustomEvent{detail}.
  emit(n, detail) { for (const f of [...(busL.get(n) || [])]) f({ type: n, detail }); },
};
globalThis.__pluginClient = { events: bus, player: { stats: { name: "Tester" } } };
globalThis.__sessionHandle = {
  playerInventory: () => [],
  playerItemsCapacity: 102,
  playerContainersCapacity: 7,
  playerBurden: 0,
  playerAetheriaBits: 0,
  canUseWith: () => false,
  getObjectIconId: () => 0,
  objectIntProperty: () => 0,
  entityWieldedItems: () => [],
};
globalThis.getLocalPlayerGuid = () => ME;
globalThis.__mainPanel = { setTitle: () => true, currentViewId: () => "inventory", isOpen: () => true };
for (const id of ["inv-equipped", "inv-pack"]) {
  const ul = document.createElement("ul");
  ul.id = id;
  document.body.appendChild(ul);
}

const helpers = await import(pathToFileURL(path.join(APP, "plugins", "inventory_helpers.js")).href);
const drag = await import(pathToFileURL(path.join(APP, "plugins", "item_drag.js")).href);
const tcycle = await import(pathToFileURL(path.join(APP, "scene3d", "target_cycle.js")).href);
globalThis.__T = { ...helpers, ...drag, consumeUseThrottle: tcycle.consumeUseThrottle };
globalThis.__PD = pd;
const real = (names) => Object.fromEntries(names.map((n) => [n, `globalThis.__T.${n}`]));
const invSrc = readFileSync(path.join(APP, "plugins", "inventory.js"), "utf8");
const inventoryMod = new Function(spliceModule(invSrc, {
  label: "plugins/inventory.js",
  provided: [],
  stubs: {
    setAcText: "(el, t) => { if (el) el.textContent = String(t ?? ''); }",
    fetchIconDataUrlShared: "() => Promise.resolve(null)",
    getIconImmediate: "() => null",
    fetchItemIconDataUrl: "() => Promise.resolve(null)",
    getItemIconImmediate: "() => null",
    itemIconKey: "(m) => 'item:' + ((m && m.iconId) >>> 0)",
    PLAYER_PACK_ICON: "0x0600127E",
    ITEM_TYPE_CONTAINER: "0x200",
    uiEffectIconsEnabled: "() => false",
    uiEffectBadgesEnabled: "() => false",
    uiEffectIconsFor: "() => []",
    uiEffectTintCss: "() => null",
    // The REAL pooled class (the module the examine plugin imports too).
    PaperdollViewport: "globalThis.__PD.PaperdollViewport",
    ...real([
      "aetheriaSlotIsLocked", "formatBurdenText", "burdenMeterFraction", "computeInventoryTitle",
      "parseSlotsViewChecked", "canEquipInSlot", "buildPlayerEquipState", "formatAppraisalTooltip",
      "takeInventoryRows", "rowUsesPackSlot", "pickWieldSlotMask", "createPackOrder", "packCapacity",
      "mergeAmount", "DROP_TARGET", "MAIN_PACK_KEY", "PACKS_KEY", "decideItemDrop",
      "wieldEventTouchesLocal", "findAutoMergeTarget", "primaryUseAction", "defaultOnUrlFlag",
      "planWear", "planAmmoWield", "readySlotOccupant", "WEARABLE_LOCATIONS",
      "DEFAULT_PLAYER_ITEMS_CAPACITY", "DEFAULT_PLAYER_CONTAINERS_CAPACITY",
      "beginItemDrag", "registerDropZone", "resolveDropAction", "executeItemAction", "pendingOps",
      "showItemTooltip", "hideItemTooltip", "localPlayerGuid", "consumeUseThrottle",
    ]),
  },
}) + "\nreturn { view };")();

const panelBody = document.createElement("div");
panelBody.className = "hb-mp-body";
document.body.appendChild(panelBody);
const dollCanvas = () => document.querySelector("#hb-inventory .hb-inv-paperdoll-viewport canvas");

await check("3 open/close cycles: 1 renderer, 0 forceContextLoss, no rebuild after the first open", async () => {
  const canvases = [];
  let afterFirst = null;
  for (let i = 0; i < 3; i++) {
    const unmount = inventoryMod.view.mount(panelBody, {});
    await settle();
    const c = dollCanvas();
    assert.ok(c, `cycle ${i}: the doll canvas sits in .hb-inv-paperdoll-viewport`);
    canvases.push(c);
    // The first open builds (doMount's rebuild() + tryLoadViewport() both ask
    // for the doll — the second restarts the in-flight build, as before).
    if (i === 0) afterFirst = { ...stats };
    unmount();
    assert.equal(c.parentNode, null, `cycle ${i}: cleanup detaches the canvas`);
  }
  assert.equal(counters.renderers, 1, "one WebGLRenderer for every open (was one per open)");
  assert.equal(counters.loseContext, 0, "closing parks the context (was forceContextLoss per close)");
  assert.ok(canvases.every((c) => c === canvases[0]), "the same canvas is re-parented each open");
  assert.equal(afterFirst.composites, 1, "the first open composites the palette once");
  assert.deepEqual(stats, afterFirst, "unchanged appearance → reopening is a loadPlayer no-op (no animation fetch, no re-composite)");
  assert.equal(pd.paperdollPoolStats.reused, 2);
});

await check("an equip while closed rebuilds on the next open (same context)", async () => {
  const before = { ...stats };
  playerMeta.subPalettes = new Uint32Array([0x04000b02, 0, 8]);
  const unmount = inventoryMod.view.mount(panelBody, {});
  await settle();
  assert.ok(stats.animGets > before.animGets, "new key → rebuild");
  assert.equal(stats.composites, before.composites + 1, "the new palette composites once");
  assert.equal(counters.renderers, 1);
  const vp = [...document.querySelectorAll("canvas")].length; // sanity: one doll canvas in the tree
  assert.equal(vp, 1);
  unmount();
});

// ── [2] examine: the real plugins/examine-target.js ───────────────────────
console.log("\n[2] creature examine: one context, guid-filtered appearance refresh");
const exa = await import(pathToFileURL(path.join(APP, "plugins", "examine-target.js")).href);
const DRUDGE = 0x80001234, OTHER = 0x80005678;
const SETUP_DRUDGE = 0x02000a02; // even → one part
const drudgeMeta = {
  name: "Cragstone Drudge", setupId: SETUP_DRUDGE, mtableId: 0x09000a01, itemType: 0x10, level: 7,
  paletteId: 0x04000c01, subPalettes: new Uint32Array([0x04000c02, 0, 4]),
};
em.entityMap.set(DRUDGE, { meta: drudgeMeta });
em.entityMap.set(OTHER, { meta: { name: "Someone", setupId: 0x02000001, itemType: 0x10 } });
const examineRenderers0 = counters.renderers;

await check("3 creature examines: 1 new renderer, no context loss, 1 build", async () => {
  const g0 = stats.animGets;
  for (let i = 0; i < 3; i++) {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const cleanup = exa.mountExamineBody(host, { guid: DRUDGE, fromEntity: true });
    await settle();
    assert.ok(host.querySelector(".hb-exa-paperdoll-wrap canvas"), `examine ${i}: doll canvas mounted`);
    cleanup();
    host.remove();
  }
  assert.equal(counters.renderers - examineRenderers0, 1, "one examine context (was one per examine)");
  assert.equal(counters.loseContext, 0);
  assert.equal(stats.animGets - g0, 1, "re-examining the same creature is a loadPlayer no-op");
});

await check("appearance event for ANOTHER guid: no rebuild, no new context (bug trigger)", async () => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const cleanup = exa.mountExamineBody(host, { guid: DRUDGE, fromEntity: true });
  await settle();
  const canvas = host.querySelector(".hb-exa-paperdoll-wrap canvas");
  const r0 = counters.renderers, l0 = counters.loseContext, g0 = stats.animGets;
  bus.emit("entityAppearanceChanged", { guid: OTHER });
  bus.emit("entityAppearanceChanged", { guid: ME });
  await settle();
  assert.equal(counters.renderers, r0, "no WebGLRenderer built for someone else's equip");
  assert.equal(counters.loseContext, l0, "no context destroyed for someone else's equip");
  assert.equal(stats.animGets, g0, "no doll rebuild");
  assert.equal(host.querySelector(".hb-exa-paperdoll-wrap canvas"), canvas, "the doll canvas stays");

  // The examined creature's own change: same instance, loadPlayer rebuild.
  drudgeMeta.subPalettes = new Uint32Array([0x04000c03, 0, 4]);
  bus.emit("entityAppearanceChanged", { guid: DRUDGE });
  await settle();
  assert.equal(counters.renderers, r0, "own appearance change reuses the instance");
  assert.equal(counters.loseContext, l0);
  assert.equal(stats.animGets, g0 + 1, "the new substitutions rebuild the rig");
  assert.equal(host.querySelector(".hb-exa-paperdoll-wrap canvas"), canvas, "same canvas, not a new one");
  // An unchanged re-emit is a debounced no-op now (the old dispose+new never was).
  bus.emit("entityAppearanceChanged", { guid: DRUDGE });
  await settle();
  assert.equal(stats.animGets, g0 + 1, "unchanged → _lastLoadKey no-op");
  cleanup();
  host.remove();
});

await check("the entity leaving PVS on refresh releases the doll and shows the sentinel", async () => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const cleanup = exa.mountExamineBody(host, { guid: DRUDGE, fromEntity: true });
  await settle();
  const canvas = host.querySelector(".hb-exa-paperdoll-wrap canvas");
  assert.ok(canvas);
  const saved = em.entityMap.get(DRUDGE);
  em.entityMap.delete(DRUDGE);
  bus.emit("entityAppearanceChanged", { guid: DRUDGE });
  await settle();
  assert.equal(canvas.parentNode, null, "canvas detached");
  assert.match(host.querySelector(".hb-exa-paperdoll-empty")?.textContent ?? "", /too far away/);
  assert.equal(counters.loseContext, 0, "released (parked), not destroyed");
  em.entityMap.set(DRUDGE, saved);
  cleanup();
  host.remove();
});

// ── direct API arms ─────────────────────────────────────────────────────
const host = document.createElement("div");
document.body.appendChild(host);
const playerArgs = (setupId, pal = 0x04000a01, sub = 0x04000b01) => [
  setupId, 0x09000001, pal, new Uint32Array([sub, 0, 8]), [], 0,
  { modelChanges: new Uint32Array(0), textureChanges: new Uint32Array(0), heritage: 1 },
];

console.log("\n[3] pixel identity (draw/uniform stream over the fake GL)");
await check("re-acquire: nothing drawn until loadPlayer; same key = identical stream, no rebuild", async () => {
  resetPool(true);
  const vp = pd.PaperdollViewport.acquire("pix", { width: 224, height: 214 });
  host.appendChild(vp.dom);
  assert.equal(await vp.loadPlayer(...playerArgs(0x02000003)), true);
  const first = drawStream(vp);
  const firstInputs = rigInputs(vp);
  assert.ok(first.length >= 3, `the rig draws (${first.length} draws)`);

  vp.release();
  const again = pd.PaperdollViewport.acquire("pix", { width: 224, height: 214 });
  assert.equal(again, vp, "the parked instance comes back");
  host.appendChild(again.dom);
  assert.equal(drawStream(again).length, 0, "parked rig hidden until the consumer's load (a fresh instance draws nothing)");
  const g0 = stats.animGets, c0 = stats.composites;
  assert.equal(await again.loadPlayer(...playerArgs(0x02000003)), true);
  assert.equal(stats.animGets, g0, "same key → no rebuild");
  assert.equal(stats.composites, c0, "same key → no re-composite");
  assert.deepEqual(drawStream(again), first, "identical draw/uniform stream");
  assert.deepEqual(rigInputs(again), firstInputs, "the very same texels / materials");
  assert.equal(counters.renderers, 1);
  again.release();
});

await check("reused viewport rebuilding rig A after rig B draws exactly what a fresh one draws", async () => {
  resetPool(true);
  const vp = pd.PaperdollViewport.acquire("pix", { width: 224, height: 214 });
  await vp.loadPlayer(...playerArgs(0x02000006, 0x04000a07, 0x04000b07)); // rig B: one part, other palette
  const sB = drawStream(vp);
  const inB = rigInputs(vp);
  vp.release();
  const reused = pd.PaperdollViewport.acquire("pix", { width: 224, height: 214 });
  assert.equal(reused, vp);
  await reused.loadPlayer(...playerArgs(0x02000003)); // rig A: two parts
  const sReused = drawStream(reused);
  const fresh = new pd.PaperdollViewport({ width: 224, height: 214 });
  await fresh.loadPlayer(...playerArgs(0x02000003));
  const sFresh = drawStream(fresh);
  assert.ok(sFresh.length >= 3);
  assert.notDeepEqual(sB, sFresh, "control: the stream tells rig B from rig A");
  assert.notDeepEqual(inB.map((m) => m.texels), rigInputs(fresh).slice(0, inB.length).map((m) => m.texels),
    "control: the texel bytes tell palette B from palette A");
  assert.deepEqual(sReused, sFresh, "pooled rebuild == fresh-instance build (draws + uniforms)");
  assert.deepEqual(rigInputs(reused), rigInputs(fresh), "same texels, materials and transforms per mesh");
  assert.equal(reused.rigRoot.children.length, fresh.rigRoot.children.length, "no leftover parts from rig B");
  fresh.release(); // not pooled → disposed
  assert.equal(fresh._disposed, true);
  reused.release();
});

await check("a size change on acquire resizes the canvas + camera like a fresh instance", async () => {
  resetPool(true);
  const vp = pd.PaperdollViewport.acquire("pix", { width: 224, height: 214 });
  vp.release();
  const vp2 = pd.PaperdollViewport.acquire("pix", { width: 224, height: 178 });
  const fresh = new pd.PaperdollViewport({ width: 224, height: 178 });
  assert.equal(vp2, vp);
  assert.deepEqual([vp2.canvas.width, vp2.canvas.height, vp2.canvas.style.width, vp2.canvas.style.height],
    [fresh.canvas.width, fresh.canvas.height, fresh.canvas.style.width, fresh.canvas.style.height]);
  assert.equal(vp2.camera.aspect, fresh.camera.aspect);
  assert.deepEqual(vp2.camera.projectionMatrix.elements, fresh.camera.projectionMatrix.elements);
  fresh.release();
  vp2.release();
});

console.log("\n[4] degraded builds re-load on re-acquire");
await check("a placeholder material (surface not decoded yet) → rebuild on the next acquire", async () => {
  resetPool(true);
  const helm = sharedMats.get(S_HELM);
  sharedMats.delete(S_HELM); // not decoded yet → getCached hands back the shared fallback
  const vp = pd.PaperdollViewport.acquire("deg", {});
  // paletteId 0 + no subs → the shared-cache material path
  const args = [0x02000007, 0, 0, new Uint32Array(0), [], 0, null];
  await vp.loadPlayer(...args);
  assert.equal(vp._degraded, true);
  vp.release();
  sharedMats.set(S_HELM, helm);
  const g0 = stats.animGets;
  const vp2 = pd.PaperdollViewport.acquire("deg", {});
  await vp2.loadPlayer(...args);
  assert.equal(stats.animGets, g0 + 1, "degraded → re-load (a fresh instance would have)");
  assert.equal(vp2._degraded, false);
  vp2.release();
  const g1 = stats.animGets;
  const vp3 = pd.PaperdollViewport.acquire("deg", {});
  await vp3.loadPlayer(...args);
  assert.equal(stats.animGets, g1, "complete build → no-op");
  vp3.release();
});

console.log("\n[5] stale in-flight builds never land over a newer doll");
await check("composite race: the superseded build adds nothing (was a double doll)", async () => {
  resetPool(true);
  const vp = pd.PaperdollViewport.acquire("race", {});
  let releaseFirst;
  compositeGate = (pal) => (pal === 0x04000a11 ? new Promise((r) => { releaseFirst = r; }) : null);
  const p1 = vp.loadPlayer(...playerArgs(0x02000003, 0x04000a11)); // held in the composite
  await settle();
  const p2 = vp.loadPlayer(...playerArgs(0x02000005, 0x04000a12)); // newer, completes
  assert.equal(await p2, true);
  releaseFirst();
  assert.equal(await p1, false, "the superseded build bails");
  compositeGate = null;
  const fresh = new pd.PaperdollViewport({});
  await fresh.loadPlayer(...playerArgs(0x02000005, 0x04000a12));
  let meshes = 0, freshMeshes = 0;
  vp.rigRoot.traverse((o) => { if (o.isMesh) meshes++; });
  fresh.rigRoot.traverse((o) => { if (o.isMesh) freshMeshes++; });
  assert.equal(meshes, freshMeshes, `one rig's meshes (${meshes} vs ${freshMeshes})`);
  assert.deepEqual(drawStream(vp), drawStream(fresh));
  fresh.release();
  vp.release();
});

await check("a request for the built doll cancels a stale in-flight build", async () => {
  resetPool(true);
  const vp = pd.PaperdollViewport.acquire("race2", {});
  await vp.loadPlayer(...playerArgs(0x02000003)); // K0 built
  const k0 = vp._lastLoadKey;
  let releaseK1;
  animGate = (setupId) => (setupId === 0x02000005 ? new Promise((r) => { releaseK1 = r; }) : null);
  const p1 = vp.loadPlayer(...playerArgs(0x02000005)); // K1 in flight
  await settle();
  assert.equal(await vp.loadPlayer(...playerArgs(0x02000003)), true, "K0 again (e.g. unequip)");
  releaseK1();
  assert.equal(await p1, false, "K1 must not land over K0");
  animGate = null;
  assert.equal(vp._lastLoadKey, k0);
  vp.release();
});

console.log("\n[6] concurrent acquire of a held consumer");
await check("second acquire while held → transient viewport, disposed on release", async () => {
  resetPool(true);
  const a = pd.PaperdollViewport.acquire("examine", { width: 224, height: 178 });
  const b = pd.PaperdollViewport.acquire("examine", { width: 224, height: 178 });
  assert.notEqual(a, b);
  assert.equal(counters.renderers, 2);
  assert.equal(pd.paperdollPoolStats.transient, 1);
  b.release();
  assert.equal(b._disposed, true);
  assert.equal(counters.loseContext, 1, "the transient one is destroyed");
  a.release();
  assert.equal(a._disposed, false, "the pooled one parks");
  assert.equal(counters.loseContext, 1);
  assert.equal(pd.PaperdollViewport.acquire("examine", { width: 224, height: 178 }), a);
  a.release();
  a.release(); // idempotent
  assert.equal(a._disposed, false);
});

console.log("\n[7] ?paperdollPersist=off escape");
await check("paperdollPersistEnabled: default ON; off/0/false disable it", () => {
  assert.equal(pd.paperdollPersistEnabled(""), true);
  assert.equal(pd.paperdollPersistEnabled("?paperdollPersist=on"), true);
  assert.equal(pd.paperdollPersistEnabled("?paperdollPersist=off"), false);
  assert.equal(pd.paperdollPersistEnabled("?paperdollPersist=0"), false);
  assert.equal(pd.paperdollPersistEnabled("?x=1&paperdollPersist=false"), false);
});
await check("off: every acquire builds a renderer, every release destroys it (today's path)", async () => {
  resetPool(false);
  for (let i = 0; i < 3; i++) {
    const vp = pd.PaperdollViewport.acquire("inventory", {});
    await vp.loadPlayer(...playerArgs(0x02000003));
    vp.release();
    assert.equal(vp._disposed, true);
  }
  assert.equal(counters.renderers, 3);
  assert.equal(counters.loseContext, 3);
});

console.log("\n[8] context loss / pagehide / parked-texture budget");
await check("context lost while parked → destroyed, next acquire builds fresh", async () => {
  resetPool(true);
  const vp = pd.PaperdollViewport.acquire("inventory", {});
  vp.release();
  canvasOf.get(vp.renderer).dispatchEvent(new FakeEvent("webglcontextlost", { cancelable: true }));
  assert.equal(vp._disposed, true);
  assert.equal(counters.loseContext, 0, "a lost context is not force-lost again");
  const vp2 = pd.PaperdollViewport.acquire("inventory", {});
  assert.notEqual(vp2, vp);
  assert.equal(counters.renderers, 2);
  vp2.release();
});
await check("context lost while held → kept until release, then destroyed", async () => {
  resetPool(true);
  const vp = pd.PaperdollViewport.acquire("inventory", {});
  canvasOf.get(vp.renderer).dispatchEvent(new FakeEvent("webglcontextlost", { cancelable: true }));
  assert.equal(vp._disposed, false, "still on screen");
  vp.release();
  assert.equal(vp._disposed, true);
  assert.notEqual(pd.PaperdollViewport.acquire("inventory", {}), vp);
});
await check("pagehide destroys parked contexts; a held one goes on its release", async () => {
  resetPool(true);
  const parked = pd.PaperdollViewport.acquire("inventory", {});
  parked.release();
  const held = pd.PaperdollViewport.acquire("examine", {});
  globalThis.dispatchEvent(new FakeEvent("pagehide"));
  assert.equal(parked._disposed, true, "parked → destroyed on pagehide");
  assert.equal(held._disposed, false, "held → still mounted");
  held.release();
  assert.equal(held._disposed, true, "held → destroyed on release after pagehide");
  assert.equal(counters.loseContext, 2);
});
await check("a parked context over the texture budget is recycled on release", async () => {
  resetPool(true);
  const vp = pd.PaperdollViewport.acquire("examine", {});
  vp.renderer.info.memory.textures = pd.PAPERDOLL_PARK_MAX_TEXTURES + 1;
  vp.release();
  assert.equal(vp._disposed, true);
  assert.equal(pd.paperdollPoolStats.recycled, 1);
  const vp2 = pd.PaperdollViewport.acquire("examine", {});
  assert.notEqual(vp2, vp);
  vp2.release();
  assert.equal(vp2._disposed, false, "under budget → parked");
});

console.info = quietInfo;
host.remove();
console.log(`\npaperdoll_persist_viewport: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
