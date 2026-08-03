// R9 — DyeViewport must race-cancel superseded / post-dispose loads.
//
// Run with:
//   cd apps/holtburger-web/
//   node test_ac_dye_viewport_race.mjs
//
// `ui/ac_dye_viewport.js` loadDyedItem / loadPlayerMesh each `await` twice
// (animationCache.get, then wasmExports.fetchEntitySurfacesPixels) BEFORE they
// mutate `rigRoot` / `playerRigRoot` / `_ownedMaterials` / `_ownedTextures`,
// and `this._disposed` was only checked at function entry. Two consequences:
//
//   1. STALE RENDER. plugins/dye-preview.js calls loadDyedItem once per dye
//      swatch. If click #2's animationCache.get resolves first (cache hit) and
//      click #1's resolves second (cache miss + wasm decode), click #1 runs
//      LAST — `_clearRig()` wipes the newer rig and the tooltip shows the
//      OLDER dye. The sibling ui/ac_paperdoll_viewport.js already carries an
//      `_inflightLoadToken` for exactly this (Wave C / PR8, 2026-06-06);
//      this viewport never got one.
//   2. POST-DISPOSE ALLOCATION. `dispose()` drains _ownedTextures /
//      _ownedMaterials and force-loses the GL context, then is latched by
//      `_disposed`. A load still in flight resumes afterwards, builds fresh
//      THREE textures + materials, and pushes them into the drained arrays —
//      where nothing will ever dispose them. The tooltip is created and
//      destroyed on every hover, so this is a per-hover GPU leak.
//
// The tests below drive the two orderings directly with deferred fakes.

import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

let passed = 0, failed = 0;
function check(name, cond, detail = "") {
  if (cond) { passed++; console.log(`  [OK] ${name}`); }
  else { failed++; console.log(`  [FAIL] ${name} — ${detail}`); }
}

console.log("===========================================================");
console.log("R9 — DyeViewport race-cancel");
console.log("===========================================================");

// ── Harness ──────────────────────────────────────────────────────────────
// The real three.js is on the module path, so Group / Mesh / Box3 / Camera all
// work headlessly — only `new THREE.WebGLRenderer()` needs a DOM (it calls
// document.createElementNS). We therefore build the viewport with
// Object.create(prototype) and hand-initialise exactly the fields the two
// loaders touch, plus a renderer stub for dispose(). Every method under test
// (loadDyedItem / loadPlayerMesh / _clearRig / _frameRig / dispose) is the
// SHIPPED prototype method — nothing is mirrored.
import * as THREE from "three";

globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};
globalThis.window = {};

const { DyeViewport } = await import(
  "file://" + resolvePath(__dirname, "ui/ac_dye_viewport.js")
);

function makeViewport() {
  const vp = Object.create(DyeViewport.prototype);
  vp.size = { w: 360, h: 280 };
  vp.scene = new THREE.Scene();
  vp.camera = new THREE.PerspectiveCamera(35, 360 / 280, 0.05, 50);
  vp.rigRoot = new THREE.Group();
  vp.playerRigRoot = new THREE.Group();
  vp.scene.add(vp.rigRoot, vp.playerRigRoot);
  vp._ownedMaterials = [];
  vp._ownedTextures = [];
  vp._rafId = null;
  vp._rotation = 0;
  vp._disposed = false;
  vp._loadTokens = { dyed: 0, player: 0 };   // absent on the pre-fix build
  vp.renderer = {
    dispose() {}, forceContextLoss() {}, domElement: { parentNode: null },
  };
  return vp;
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

// A fake animEntry with one part / one group. `geometry` is opaque to the
// viewport (it only ever hands it to THREE.Mesh).
function fakeAnimEntry(tag) {
  return {
    tag,
    partGroups: [{ surfaceDids: [0x08000001], groups: [{ surfaceDid: 0x08000001, geometry: new THREE.BufferGeometry() }] }],
    restOrigins: new Float32Array([0, 0, 0]),
    restOrientations: new Float32Array([1, 0, 0, 0]),
  };
}

// ── 1. Out-of-order resolution: the OLDER load must not win ──────────────
{
  const vp = makeViewport();
  const dA = deferred();
  const dB = deferred();
  const seen = [];
  window.liveScene3d = {
    entityManager: {
      animationCache: {
        get: (setupId) => (setupId === 0xA ? dA.promise : dB.promise),
      },
      wasmExports: { fetchEntityAnimationKeyframes: () => {} },
      materialCache: { getCached: () => new THREE.MeshBasicMaterial() },
    },
  };
  // Instrument _clearRig so we can see which load actually rebuilt the rig.
  const origClear = vp._clearRig.bind(vp);
  vp._clearRig = () => { seen.push("clear"); origClear(); };

  const pA = vp.loadDyedItem(0xA, 0, 0, new Uint32Array(0)); // click #1 (old)
  const pB = vp.loadDyedItem(0xB, 0, 0, new Uint32Array(0)); // click #2 (new)

  // Click #2 resolves FIRST (cache hit), click #1 second (cache miss).
  dB.resolve(fakeAnimEntry("B"));
  await Promise.resolve();
  dA.resolve(fakeAnimEntry("A"));

  const okA = await pA;
  const okB = await pB;

  check("newer load (B) succeeds", okB === true, `okB=${okB}`);
  check("superseded load (A) is cancelled, not applied",
    okA === false, `okA=${okA} — the OLD dye overwrote the new one`);
  check("the rig was rebuilt exactly once (only by B)",
    seen.length === 1, `_clearRig calls=${seen.length}`);
}

// ── 2. dispose() mid-flight: no post-dispose allocation ──────────────────
{
  const vp = makeViewport();
  const d = deferred();
  window.liveScene3d = {
    entityManager: {
      animationCache: { get: () => d.promise },
      wasmExports: { fetchEntityAnimationKeyframes: () => {} },
      materialCache: { getCached: () => new THREE.MeshBasicMaterial() },
    },
  };
  const p = vp.loadDyedItem(0xC, 0, 0, new Uint32Array(0));
  vp.dispose();                       // tooltip hidden while the load is in flight
  d.resolve(fakeAnimEntry("C"));
  const ok = await p;

  check("load resolving after dispose() returns false", ok === false, `ok=${ok}`);
  check("nothing was mounted onto the disposed rig",
    (vp.rigRoot?.children?.length ?? 0) === 0,
    `rigRoot children=${vp.rigRoot?.children?.length}`);
  check("no part groups leaked onto the disposed viewport",
    (vp.rigRoot?.children?.length ?? 0) === 0 && vp._ownedMaterials.length === 0,
    `children=${vp.rigRoot?.children?.length} owned=${vp._ownedMaterials.length}`);
}

// ── 3. the two rigs must NOT cancel each other (separate counters) ────────
// plugins/dye-preview.js runs loadDyedItem then loadPlayerMesh back to back;
// a single shared token would make the second cancel the first.
{
  const vp = makeViewport();
  window.liveScene3d = {
    entityManager: {
      animationCache: { get: async () => fakeAnimEntry("X") },
      wasmExports: { fetchEntityAnimationKeyframes: () => {} },
      materialCache: { getCached: () => new THREE.MeshBasicMaterial() },
    },
  };
  const okItem = await vp.loadDyedItem(0xD, 0, 0, new Uint32Array(0));
  const okPlayer = await vp.loadPlayerMesh(0xE, 0, 0, new Uint32Array(0));
  check("armor load succeeds", okItem === true, `okItem=${okItem}`);
  check("player load succeeds after it (no cross-cancel)",
    okPlayer === true, `okPlayer=${okPlayer}`);
  check("both rigs are populated",
    vp.rigRoot.children.length === 1 && vp.playerRigRoot.children.length === 1,
    `dyed=${vp.rigRoot.children.length} player=${vp.playerRigRoot.children.length}`);
  vp.dispose();
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
