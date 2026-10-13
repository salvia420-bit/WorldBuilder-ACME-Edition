// tests/paperdoll_held_flag.test.mjs — models-camera-7 (2026-10-13):
// `?paperdollHeld=off` drops held items (weapon / shield / torch) from the
// inventory + examine paperdoll. Retail's doll is a fresh object with no
// children: gmPaperDollUI::RedressCreature (acclient.c:220031) →
// CPhysicsObj::makeObject(player) → MorphToExistingObject (:316880, copies the
// part array + translucency, never the CHILDLIST). DEFAULT ON = the Wave C /
// PR8 wielded-children pass, unchanged (same key, same _attachWieldedChildren
// call).
//
// Run from apps/holtburger-web/:  node tests/paperdoll_held_flag.test.mjs

import assert from "node:assert/strict";
import * as THREE from "three";

globalThis.window = { location: { search: "" }, devicePixelRatio: 1 };
const pd = await import("../ui/ac_paperdoll_viewport.js");

let passed = 0, failed = 0;
const check = async (name, fn) => {
  try { await fn(); passed++; console.log(`  [PASS] ${name}`); }
  catch (e) { failed++; console.log(`  [FAIL] ${name} — ${e.message}`); }
};

const SETUP = 0x02000001;
const WIELDED = [
  { itemGuid: 0x80000101, parentLocation: 1, placement: 1, meta: { setupId: 0x02000a01 } },
  { itemGuid: 0x80000102, parentLocation: 3, placement: 2, meta: { setupId: 0x02000a02 } },
];
const WIELDED_SWAP = [
  { itemGuid: 0x80000201, parentLocation: 1, placement: 1, meta: { setupId: 0x02000b01 } },
];

// Stub entity manager: one empty body part, so loadPlayer reaches the
// wielded-children pass without wasm / textures.
let animGets = 0;
globalThis.window.liveScene3d = {
  entityManager: {
    animationCache: {
      get: async () => {
        animGets++;
        return { partGroups: [{ surfaceDids: [], groups: [] }], restOrigins: [0, 0, 0], restOrientations: [1, 0, 0, 0] };
      },
    },
    wasmExports: { fetchEntityAnimationKeyframes: () => null },
    materialCache: { getCached: () => null },
  },
};

/** A PaperdollViewport without the WebGL renderer (no GPU in node). */
function stubViewport() {
  const vp = Object.create(pd.PaperdollViewport.prototype);
  vp.size = { w: 224, h: 214 };
  vp.scene = new THREE.Scene();
  vp.camera = new THREE.PerspectiveCamera(pd.PAPERDOLL_FOV_DEG, 224 / 214, 0.05, 50);
  vp.dollRoot = new THREE.Group();
  vp.dollRoot.rotation.x = -Math.PI / 2;
  vp.scene.add(vp.dollRoot);
  vp.rigRoot = new THREE.Group();
  vp.dollRoot.add(vp.rigRoot);
  vp._ownedMaterials = [];
  vp._ownedTextures = [];
  vp._rafId = null;
  vp._disposed = false;
  vp._lastLoadKey = null;
  vp._inflightLoadToken = 0;
  vp._holdingLocCache = new Map();
  vp.renders = 0;
  vp.renderer = { render: () => { vp.renders++; } };
  vp.attachCalls = [];
  vp._attachWieldedChildren = async (...args) => { vp.attachCalls.push(args); };
  return vp;
}

const setSearch = (s) => { globalThis.location = { search: s }; };
const quiet = async (fn) => {
  const info = console.info;
  console.info = () => {};
  try { return await fn(); } finally { console.info = info; }
};

await check("paperdollHeldEnabled: default ON; off/0/false disable it", () => {
  assert.equal(pd.paperdollHeldEnabled(""), true);
  assert.equal(pd.paperdollHeldEnabled("?paperdollHeld=on"), true);
  assert.equal(pd.paperdollHeldEnabled("?foo=1"), true);
  assert.equal(pd.paperdollHeldEnabled("?paperdollHeld=off"), false);
  assert.equal(pd.paperdollHeldEnabled("?paperdollHeld=0"), false);
  assert.equal(pd.paperdollHeldEnabled("?x=1&paperdollHeld=false"), false);
  delete globalThis.location;
  assert.equal(pd.paperdollHeldEnabled(), true, "no location → default ON");
  setSearch("?paperdollHeld=off");
  assert.equal(pd.paperdollHeldEnabled(), false, "reads globalThis.location.search");
  delete globalThis.location;
});

await check("default: _attachWieldedChildren called exactly as today, key carries the held items", async () => {
  delete globalThis.location;
  const vp = stubViewport();
  const ok = await quiet(() => vp.loadPlayer(SETUP, 0x09000001, 0, new Uint32Array(0), WIELDED, 0x3c));
  assert.equal(ok, true);
  assert.equal(vp.attachCalls.length, 1, "one wielded-children pass");
  const [setupArg, itemsArg, tokenArg] = vp.attachCalls[0];
  assert.equal(setupArg, SETUP >>> 0);
  assert.equal(itemsArg, WIELDED, "the caller's array, untouched");
  assert.equal(tokenArg, 1);
  assert.equal(vp._lastLoadKey, vp._loadKey(SETUP, 0x09000001, 0, new Uint32Array(0), WIELDED, 0x3c, null),
    "key byte-identical to the pre-flag key");
  assert.match(vp._lastLoadKey, /\|w=2147483905-1-1;2147483906-3-2\|/);
  assert.equal(vp.renders, 1);
});

await check("default: a held-item swap reloads the doll", async () => {
  delete globalThis.location;
  const vp = stubViewport();
  await quiet(() => vp.loadPlayer(SETUP, 0, 0, new Uint32Array(0), WIELDED, 0));
  const gets = animGets;
  await quiet(() => vp.loadPlayer(SETUP, 0, 0, new Uint32Array(0), WIELDED_SWAP, 0));
  assert.equal(animGets, gets + 1, "reloaded");
  assert.equal(vp.attachCalls.length, 2);
  assert.equal(vp.attachCalls[1][1], WIELDED_SWAP);
});

await check("?paperdollHeld=off: no wielded-children pass, key ignores held items", async () => {
  setSearch("?paperdollHeld=off");
  const vp = stubViewport();
  const ok = await quiet(() => vp.loadPlayer(SETUP, 0x09000001, 0, new Uint32Array(0), WIELDED, 0x3c));
  assert.equal(ok, true, "the body still loads");
  assert.equal(vp.attachCalls.length, 0, "_attachWieldedChildren never called");
  assert.match(vp._lastLoadKey, /\|w=\|/, "empty wielded tuple in the key");
  assert.equal(vp._lastLoadKey, vp._loadKey(SETUP, 0x09000001, 0, new Uint32Array(0), [], 0x3c, null));
  assert.equal(vp.rigRoot.children.length, 1, "body part only");
  // A held-item swap is a no-op reload (same key → early return).
  const gets = animGets;
  const again = await quiet(() => vp.loadPlayer(SETUP, 0x09000001, 0, new Uint32Array(0), WIELDED_SWAP, 0x3c));
  assert.equal(again, true);
  assert.equal(animGets, gets, "no rebuild for a held-item change");
  assert.equal(vp.attachCalls.length, 0);
  delete globalThis.location;
});

console.log(`\npaperdoll_held_flag: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
