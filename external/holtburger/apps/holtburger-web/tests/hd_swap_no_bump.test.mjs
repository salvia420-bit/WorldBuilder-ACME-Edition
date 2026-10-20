// tests/hd_swap_no_bump.test.mjs
//
// 2026-10-20 (improvement hunt streaming-hitch-4) — HD map swaps no longer bump
// `material.version` unless the swap can change the program.
//
// Every HD swap (bc7_textures.js `buildAndSwap`, pre + full; materials.js
// `_repointAlbedoForDid`, the clone / emissive-alias walk) used to set
// `needsUpdate`. A map-to-map swap cannot change a three r184 program, but the
// version bump made async_link_guard skip the material's draw for a frame (a
// deferred cache-hit compile + poll) on each of a surface's first two swaps.
// `?hdSwapBump=on` restores the always-bump behaviour.
//
//   H1  flag grammar (`hdSwapBumpAlways`): exact opt-in, memoised.
//   H2  `mapSwapChangesProgram` agrees with three r184's OWN program cache key
//       (WebGLPrograms.getParameters + getProgramCacheKey on a stub renderer):
//       RGBA8 DataTexture -> BC7 CompressedTexture is the same program; a map
//       appearing / disappearing or a uv-channel change is not.
//   H3  upgradeMaterialToBc7 (pre then full): map swapped, version unchanged,
//       onSwap still fires twice, stats tally the skips; `?hdSwapBump=on` bumps.
//   H4  MaterialCache._repointAlbedoForDid: every clone + the emissive alias is
//       re-pointed with its version unchanged; old texture disposed; a clone
//       whose slot was EMPTY (presence change) still bumps.
//   H5  THE BUG TRIGGER: under the async-link guard (three-like fake renderer),
//       a bumped swap skips the draw for a frame; the default swap draws
//       through the fast path in the very next frame.
//
// Run: node tests/hd_swap_no_bump.test.mjs

import * as THREE from "three";
import { WebGLPrograms } from "three/src/renderers/webgl/WebGLPrograms.js";
import {
  initBc7Source,
  upgradeMaterialToBc7,
  _setBc7SupportForTest,
  _resetBc7ForTest,
  bc7Stats,
  hdSwapBumpAlways,
  mapSwapChangesProgram,
  hdSwapNeedsUpdate,
} from "../scene3d/bc7_textures.js";
import { MaterialCache } from "../scene3d/materials.js";

let passed = 0, failed = 0;
function check(label, cond, extra = "") {
  if (cond) { passed++; console.log(`  [OK] ${label}`); }
  else { failed++; console.log(`  [FAIL] ${label} ${extra}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const setSearch = (s) => { globalThis.window = { location: { search: s } }; };
const clearWindow = () => { delete globalThis.window; };

// Synthetic HBC7 record (test_bc7_pre_phase.mjs shape): header + full chain.
const blocks = (n) => Math.ceil(n / 4);
function hbc7(w, h) {
  const lvls = [];
  let lw = w, lh = h;
  for (;;) {
    lvls.push(blocks(lw) * blocks(lh) * 16);
    if (lw === 1 && lh === 1) break;
    lw = Math.max(1, lw >> 1);
    lh = Math.max(1, lh >> 1);
  }
  const buf = new Uint8Array(20 + lvls.reduce((a, b) => a + b, 0));
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, 0x37434248, true);
  dv.setUint32(4, w, true);
  dv.setUint32(8, h, true);
  dv.setUint32(12, blocks(w), true);
  dv.setUint32(16, blocks(h), true);
  return buf;
}
const deferred = () => { let resolve; const promise = new Promise((r) => (resolve = r)); return { promise, resolve }; };
const rgba8 = () => {
  const t = new THREE.DataTexture(new Uint8Array([200, 150, 100, 255]), 1, 1);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
};
const bc7Tex = (w = 4) => {
  const t = new THREE.CompressedTexture([{ data: new Uint8Array(blocks(w) * blocks(w) * 16), width: w, height: w }], w, w, THREE.RGBA_BPTC_Format);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
};

// ---------------------------------------------------------------------------
console.log("\n-- H1 flag grammar ---------------------------------------------");
check("absent -> default (no forced bump)", hdSwapBumpAlways("") === false);
check("unrelated params -> default", hdSwapBumpAlways("?texPre=off&nosw=1") === false);
for (const on of ["on", "ON", "1", "true", "yes"]) check(`?hdSwapBump=${on} -> always bump`, hdSwapBumpAlways(`?hdSwapBump=${on}`) === true);
for (const off of ["off", "0", "banana", ""]) check(`?hdSwapBump=${off || "(empty)"} -> default`, hdSwapBumpAlways(`?hdSwapBump=${off}`) === false);
{
  _resetBc7ForTest();
  setSearch("?hdSwapBump=on");
  const a = hdSwapBumpAlways();
  setSearch("");
  const b = hdSwapBumpAlways();
  check("page read is memoised (one URL parse per page, not per swap)", a === true && b === true);
  _resetBc7ForTest();
  check("_resetBc7ForTest clears the memo", hdSwapBumpAlways() === false);
  clearWindow();
  _resetBc7ForTest();
}

// ---------------------------------------------------------------------------
console.log("\n-- H2 the predicate agrees with three r184's program key ---------");
const progs = new WebGLPrograms(
  {
    getRenderTarget: () => null,
    state: { buffers: { depth: { getReversed: () => false } } },
    toneMapping: THREE.NoToneMapping,
    outputColorSpace: THREE.SRGBColorSpace,
    shadowMap: { enabled: false, type: THREE.PCFShadowMap },
    localClippingEnabled: false,
  },
  { get: () => null },
  { has: () => false },
  { logarithmicDepthBuffer: false, reversedDepthBuffer: false, precision: "highp", getMaxPrecision: (p) => p, vertexTextures: true },
  {},
  { numPlanes: 0, numIntersection: 0 },
);
const LIGHTS = { directional: [1, 2], point: new Array(16).fill(1), spot: [1, 2], spotLightMap: [], rectArea: [], hemi: [1],
  directionalShadowMap: [], pointShadowMap: [], spotShadowMap: [], numSpotLightShadowsWithMaps: 0, numLightProbes: 0 };
const probeMesh = new THREE.Mesh(new THREE.BufferGeometry());
function programKey(m) {
  probeMesh.material = m;
  return progs.getProgramCacheKey(progs.getParameters(m, LIGHTS, [], { fog: null, environment: null }, probeMesh, []));
}
function keyCase(label, slot, mkMat, before, after, expectChange) {
  const m = mkMat();
  m[slot] = before;
  const k0 = programKey(m);
  m[slot] = after;
  const k1 = programKey(m);
  const threeSays = k0 !== k1;
  check(`${label}: three r184 ${threeSays ? "changes" : "keeps"} the program`, threeSays === expectChange);
  check(`${label}: mapSwapChangesProgram agrees`, mapSwapChangesProgram(before, after) === threeSays);
}
const std = () => new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0 });
keyCase("map RGBA8 -> BC7 pre", "map", std, rgba8(), bc7Tex(4), false);
keyCase("map BC7 pre -> BC7 full", "map", std, bc7Tex(4), bc7Tex(16), false);
keyCase("emissiveMap alias RGBA8 -> BC7", "emissiveMap", std, rgba8(), bc7Tex(4), false);
keyCase("map appears (null -> tex)", "map", std, null, bc7Tex(4), true);
keyCase("map disappears (tex -> null)", "map", std, rgba8(), null, true);
{
  const uv1 = bc7Tex(4); uv1.channel = 1;
  keyCase("uv channel 0 -> 1", "map", std, rgba8(), uv1, true);
}
keyCase("map on a Lambert material (RGBA8 -> BC7)", "map", () => new THREE.MeshLambertMaterial(), rgba8(), bc7Tex(4), false);
check("empty -> empty is not a change", mapSwapChangesProgram(null, undefined) === false);
{
  const fakeVideo = { isVideoTexture: true, channel: 0, colorSpace: THREE.SRGBColorSpace };
  check("a video texture on either side counts as a change (decodeVideoTexture)",
    mapSwapChangesProgram(rgba8(), fakeVideo) === true && mapSwapChangesProgram(fakeVideo, rgba8()) === true);
}

// ---------------------------------------------------------------------------
console.log("\n-- H3 upgradeMaterialToBc7: pre + full keep the version ----------");
async function upgradeRun(search) {
  _resetBc7ForTest();
  if (search !== null) setSearch(search); else clearWindow();
  _setBc7SupportForTest(true);
  const pre = deferred(), full = deferred();
  initBc7Source({ fetchImpl: () => full.promise, preFetchImpl: () => pre.promise });
  const mat = new THREE.MeshStandardMaterial({ map: rgba8() });
  const v0 = mat.version;
  const swaps = [];
  const p = upgradeMaterialToBc7(mat, 0x06001234, (res) => swaps.push(res.replaced));
  pre.resolve(hbc7(4, 4));
  await sleep(10);
  const afterPre = { version: mat.version, w: mat.map?.image?.width, compressed: mat.map?.isCompressedTexture === true };
  full.resolve(hbc7(16, 16));
  const res = await p;
  const out = { v0, afterPre, afterFull: { version: mat.version, w: mat.map?.image?.width }, swaps: swaps.length, res, stats: bc7Stats() };
  clearWindow();
  return out;
}
{
  const d = await upgradeRun(null);
  check("default: pre swapped in (4x4 BC7)", d.afterPre.w === 4 && d.afterPre.compressed);
  check("default: pre swap leaves material.version alone", d.afterPre.version === d.v0, `${d.v0} -> ${d.afterPre.version}`);
  check("default: full swapped in (16x16)", d.afterFull.w === 16 && d.res && d.res.swapped === true);
  check("default: full swap leaves material.version alone", d.afterFull.version === d.v0, `${d.v0} -> ${d.afterFull.version}`);
  check("default: onSwap still fires for both phases", d.swaps === 2);
  check("default: stats tally 2 skipped, 0 bumps", d.stats.swapBumpsSkipped === 2 && d.stats.swapBumps === 0,
    `${d.stats.swapBumpsSkipped}/${d.stats.swapBumps}`);
  check("default: preSwaps / singletonUpgrades unchanged in meaning", d.stats.preSwaps === 1 && d.stats.singletonUpgrades === 1);

  const e = await upgradeRun("?hdSwapBump=on");
  check("?hdSwapBump=on: pre swap bumps (pre-2026-10-20 behaviour)", e.afterPre.version === e.v0 + 1, `${e.v0} -> ${e.afterPre.version}`);
  check("?hdSwapBump=on: full swap bumps again", e.afterFull.version === e.v0 + 2, `${e.v0} -> ${e.afterFull.version}`);
  check("?hdSwapBump=on: stats tally 2 bumps", e.stats.swapBumps === 2 && e.stats.swapBumpsSkipped === 0);
  check("same final texture either way", e.afterFull.w === d.afterFull.w && e.swaps === d.swaps);
}
{
  // A material with NO map getting one is a key change: still bumps.
  _resetBc7ForTest();
  clearWindow();
  _setBc7SupportForTest(true);
  initBc7Source({ fetchImpl: () => Promise.resolve(hbc7(8, 8)), preFetchImpl: () => Promise.resolve(null) });
  const mat = new THREE.MeshStandardMaterial();
  const v0 = mat.version;
  await upgradeMaterialToBc7(mat, 0x06004321, () => {});
  check("a map that APPEARS still bumps (USE_MAP)", mat.map && mat.version === v0 + 1 && bc7Stats().swapBumps === 1);
  _resetBc7ForTest();
}

// ---------------------------------------------------------------------------
console.log("\n-- H4 _repointAlbedoForDid: clones + emissive alias ---------------");
function repointRun(search) {
  _resetBc7ForTest();
  if (search !== null) setSearch(search); else clearWindow();
  const D = 0x08000777;
  const cache = new MaterialCache({});
  const old = rgba8();
  let disposed = false;
  old.addEventListener("dispose", () => { disposed = true; });
  const base = new THREE.MeshStandardMaterial({ map: old });
  base.emissiveMap = old; // the Luminous alias (applyFloatLumDiffuse)
  cache.materials.set(D, base);
  const clones = [cache.getCachedFloorBias(D), cache.getCachedStaticBias(D), cache.getCachedCellBaked(D)];
  // a clone whose map slot is EMPTY: re-pointing it is a presence change
  const empty = new THREE.MeshStandardMaterial();
  cache.frontSideMaterials.set(D, empty);
  const v = (m) => m.version;
  const before = { base: v(base), clones: clones.map(v), empty: v(empty) };
  const tex = bc7Tex(16);
  base.map = tex; // the caller (buildAndSwap / onSwap) already moved base.map
  cache._repointAlbedoForDid(D, base, old);
  const out = {
    clonesRepointed: clones.every((c) => c.map === tex),
    aliasRepointed: base.emissiveMap === tex,
    clonesKept: clones.every((c, i) => c.version === before.clones[i]),
    baseKept: base.version === before.base,
    clonesBumped: clones.every((c, i) => c.version > before.clones[i]),
    baseBumped: base.version > before.base,
    disposed,
    distinctClones: new Set(clones).size === 3 && !clones.includes(base),
  };
  clearWindow();
  return out;
}
{
  const d = repointRun(null);
  check("premise: three distinct per-DID clones", d.distinctClones);
  check("default: every clone re-pointed to the new texture", d.clonesRepointed);
  check("default: the emissive alias re-pointed", d.aliasRepointed);
  check("default: no clone version moved", d.clonesKept);
  check("default: the alias re-point left the base version alone", d.baseKept);
  check("default: the old texture is still disposed", d.disposed);
  const e = repointRun("?hdSwapBump=on");
  check("?hdSwapBump=on: clones bump (old behaviour)", e.clonesRepointed && e.clonesBumped);
  check("?hdSwapBump=on: the alias re-point bumps the base", e.aliasRepointed && e.baseBumped);
}
{
  // presence change through the walk: old = null, a clone with an empty slot
  _resetBc7ForTest();
  clearWindow();
  const D = 0x08000778;
  const cache = new MaterialCache({});
  const base = new THREE.MeshStandardMaterial();
  cache.materials.set(D, base);
  const clone = new THREE.MeshStandardMaterial();
  cache.floorBiasMaterials.set(D, clone);
  const v0 = clone.version;
  base.map = bc7Tex(8);
  cache._repointAlbedoForDid(D, base, null);
  // (> not === v0 + 1: with old = null the walk also aliases the clone's empty
  // emissiveMap slot — a second presence change, pre-existing behaviour.)
  check("a slot that goes empty -> map still bumps (key change)", clone.map === base.map && clone.version > v0);
  check("hdSwapNeedsUpdate(null, tex) === true", hdSwapNeedsUpdate(null, base.map) === true);
}

// ---------------------------------------------------------------------------
console.log("\n-- H5 the async-link guard: bumped swap blinks, default draws -----");
// A three-like fake (tests/async_link_key_sig.test.mjs): per-material programs
// keyed by fingerprint + side; a draw whose key has no READY program links.
function makeRenderer(on) {
  const props = new WeakMap();
  const cache = new Map();
  const r = {
    syncLinks: 0, draws: 0, compiles: 0,
    properties: { get(m) { let p = props.get(m); if (!p) { p = {}; props.set(m, p); } return p; } },
    _prog(mp, key, ready) {
      if (!mp.programs) mp.programs = new Map();
      let p = mp.programs.get(key) || cache.get(key);
      if (!p) {
        let polls = 0;
        p = ready ? { isReady: () => true } : { isReady: () => ++polls > 1 };
        cache.set(key, p);
      }
      mp.programs.set(key, p);
      mp.currentProgram = p;
      mp.batching = false; mp.instancing = false; mp.skinning = false;
      return p;
    },
    renderBufferDirect(camera, sc, g, material) {
      r.draws++;
      const mp = r.properties.get(material);
      if (mp.__version !== material.version) {
        const key = on.materialKeySig(material) + "#" + material.side;
        const had = mp.programs?.get(key) || cache.get(key);
        if (!had || had.isReady() !== true) r.syncLinks++;
        r._prog(mp, key, true);
        mp.__version = material.version;
      }
    },
    compile(root) {
      r.compiles++;
      const set = new Set();
      root.traverse((o) => {
        const m = o.material; set.add(m);
        r._prog(r.properties.get(m), on.materialKeySig(m) + "#" + m.side, false);
      });
      return set;
    },
  };
  return r;
}
const guard = await import("../scene3d/async_link_guard.js");
async function guardRun(search) {
  _resetBc7ForTest();
  const renderer = makeRenderer(guard);
  const scene = { isScene: true };
  globalThis.window = search ? { location: { search } } : {};
  const api = guard.installAsyncLinkGuard(renderer, () => scene);
  const mat = new THREE.MeshStandardMaterial({ map: rgba8() });
  const obj = { name: "street-wall", material: mat };
  const frame = async () => { renderer.renderBufferDirect({}, scene, {}, mat, obj, null); await sleep(25); };
  // NOT prewarmed: the first draw is a real link, so it teaches no churn
  // trust. (A prewarmed material's first-draw compile is a no-op that counts
  // toward VERSION_NOOP_TRUST, and then only the PRE swap blinked under the
  // old behaviour — the full one drew trusted. Either way the default arm
  // defers nothing.)
  for (let i = 0; i < 4; i++) await frame(); // links + stamps the fast path
  // Production timing: the first-draw deferral and each HD swap are seconds
  // apart, so the VERSION_DEFER_MAX burst cap never exempts a swap.
  await sleep(guard.VERSION_DEFER_WINDOW_MS + 60);
  const d0 = api.stats.deferred, n0 = renderer.draws;
  // The HD pre swap lands through the production code path.
  _setBc7SupportForTest(true);
  const full = deferred();
  initBc7Source({ fetchImpl: () => full.promise, preFetchImpl: () => Promise.resolve(hbc7(4, 4)) });
  const p = upgradeMaterialToBc7(mat, 0x06005555, () => {});
  await sleep(5);
  const preSwapped = mat.map && mat.map.isCompressedTexture === true;
  await frame(); // the very next frame after the swap
  const firstFrame = { drew: renderer.draws - n0 === 1, deferred: api.stats.deferred - d0 };
  for (let i = 0; i < 3; i++) await frame(); // the deferred cache-hit compile settles
  await sleep(guard.VERSION_DEFER_WINDOW_MS + 60);
  full.resolve(hbc7(16, 16));
  await p;
  const n1 = renderer.draws, d1 = api.stats.deferred;
  await frame(); // the next frame after the FULL swap
  const fullFrame = { drew: renderer.draws - n1 === 1, deferred: api.stats.deferred - d1 };
  const out = { preSwapped, firstFrame, fullFrame, syncLinks: renderer.syncLinks };
  api.uninstall();
  delete globalThis.window;
  console.log(`    ${search || "(default)"}: ${JSON.stringify(out)}`);
  return out;
}
{
  const bump = await guardRun("?hdSwapBump=on");
  check("premise: the pre swap landed before the frame", bump.preSwapped);
  check("?hdSwapBump=on (old): the frame after the pre swap SKIPS the draw (deferred)",
    !bump.firstFrame.drew && bump.firstFrame.deferred === 1, JSON.stringify(bump.firstFrame));
  check("?hdSwapBump=on (old): the frame after the full swap skips it again",
    !bump.fullFrame.drew && bump.fullFrame.deferred === 1, JSON.stringify(bump.fullFrame));
  const def = await guardRun("");
  check("default: the frame after the pre swap DRAWS (fast path, nothing deferred)",
    def.firstFrame.drew && def.firstFrame.deferred === 0, JSON.stringify(def.firstFrame));
  check("default: the frame after the full swap draws too",
    def.fullFrame.drew && def.fullFrame.deferred === 0, JSON.stringify(def.fullFrame));
  check("no synchronous link either way", bump.syncLinks === 0 && def.syncLinks === 0);
}

_resetBc7ForTest();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
