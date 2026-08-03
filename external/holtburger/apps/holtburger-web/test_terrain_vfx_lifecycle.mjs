// test_terrain_vfx_lifecycle.mjs — the per-landblock terrain-VFX spine (Wave 0B).
//
// Locks (docs/2026-07-31-terrain-vfx-plan.md §2.2, §2.5, §5, §8 risks 4 and 8):
//   L1  `onLandblockReady` fires ONCE per landblock; `onLandblockGone` fires
//       once on evict.
//   L2  ⚠ THE PARK TRAP. Park does NOT fire `onLandblockGone` — it fires
//       `onLandblockPark`, and unpark restores WITHOUT re-scattering (the
//       provider is told to unpark, never to re-ready). Park REPLACES eviction
//       at LRU cap, so a provider hooked only to evict would leak on nearly
//       every landblock (`landblock_lru.js:1638` documents the omission).
//   L3  A `scope:"camera"` provider allocates its pool ONCE across 100
//       simulated moves and receives NO landblock callbacks at all — it is
//       immune to evict/park/rebake by construction.
//   L4  Hooks are installed on ALL THREE facades (`scene3d`,
//       `landblockLru.scene3d`, `liveScene3d`) — the dual-facade footgun
//       `terrain_batch.js:548` documents.
//   L5  ⚠ WE CHAIN, WE DO NOT CLOBBER. `terrain_batch.js` owns the same three
//       property names and re-installs its BARE function on every absorb. The
//       spine must wrap it (both run), survive a re-install by re-wrapping, and
//       never grow the chain.
//   L6  Rebake (`terrain.js::drainOneTerrainLodRebake` = evict-then-reload)
//       arrives as gone-then-ready, exactly once each.
//   L7  Family gating: a provider is only offered landblocks whose 81 codes
//       actually contain one of its families.
//   L8  `?terrainVfx=off` and `?wireframe=1` are hard, allocation-free no-ops
//       (plan §8 risk 8 — the wireframe guard lives HERE, once, not per family).
//   L9  Late registration replays the resident ring; a provider that registers
//       after the boot ring baked is not permanently blind.
//   L10 A throwing provider is contained: the tick, the lifecycle and the other
//       providers all keep running.
//   L11 Placement inputs are deterministic (§5.5) — no `Math.random` in source.
//   L12 The spine imports no three (THREE is injected), so this test needs no
//       stub loader.
//
// Run from apps/holtburger-web/:  node test_terrain_vfx_lifecycle.mjs

import fs from "node:fs";
import {
  registerTerrainVfx,
  unregisterTerrainVfx,
  initTerrainVfx,
  terrainVfxTick,
  terrainVfxStats,
  terrainVfxNoteLandblockMesh,
  terrainVfxLandblockPark,
  terrainVfxLandblockUnpark,
  terrainVfxLandblockGone,
  terrainVfxHookReport,
  terrainVfxOracleSelfTest,
  terrainVfxOracleSelfTestSync,
  installTerrainVfxHooks,
  lbKeyFromXY,
  lbKeyOf,
  familyCoverageOf,
  coverageMatches,
  wireframeActive,
  makeSeededRng,
  _resetTerrainVfx,
} from "./scene3d/terrain_vfx.js";
import { FAM_GRASS, FAM_SAND, FAM_WATER, FAM_VOLCANO } from "./scene3d/terrain_families.js";
import { _resetVfxFlags } from "./scene3d/vfx_flags.js";

let passed = 0, failed = 0;
function check(label, cond, extra = "") {
  if (cond) { passed++; console.log(`  [OK] ${label}`); }
  else { failed++; console.log(`  [FAIL] ${label} ${extra}`); }
}

// ---------------------------------------------------------------------------
// A minimal THREE stand-in — the spine only ever calls `new THREE.Group()` and
// `.add` / `.remove` / `.visible`. Injecting it is the whole point (L12).
// ---------------------------------------------------------------------------
let groupsMade = 0;
class FakeGroup {
  constructor() {
    groupsMade += 1;
    this.children = [];
    this.parent = null;
    this.name = "";
    this.visible = true;
  }
  add(c) { this.children.push(c); c.parent = this; return this; }
  remove(c) {
    const i = this.children.indexOf(c);
    if (i >= 0) { this.children.splice(i, 1); c.parent = null; }
    return this;
  }
}
const FakeTHREE = { Group: FakeGroup };

// A landblock mesh exactly as `terrain.js` stamps it (:4139 userData literal).
function makeLbMesh(lbX, lbY, fillCode = 1, patch) {
  const codes = new Uint8Array(81).fill(fillCode);
  if (patch) for (const [i, c] of patch) codes[i] = c;
  const heights = new Float32Array(81);
  return {
    name: `terrain-lb-${lbX.toString(16)}-${lbY.toString(16)}`,
    userData: {
      lbX, lbY,
      lbId: ((lbX << 24) | (lbY << 16) | 0xffff) >>> 0,
      terrainCodes: codes,
      heights,
      subdivLevel: 1,
    },
  };
}

function makeWorld() {
  const worldRoot = new FakeGroup();
  const terrainGroup = new FakeGroup();
  worldRoot.add(terrainGroup);
  const scene3d = { terrainGroup, quality: { flags: { terrainTrail: false } }, frameTime: { tsSec: 0, dt: 0 } };
  const lruFacade = {};
  scene3d.landblockLru = { scene3d: lruFacade };
  globalThis.window = { location: { search: "" }, liveScene3d: scene3d };
  return { worldRoot, terrainGroup, scene3d, lruFacade };
}

function recorder(id, extra = {}) {
  const log = [];
  const p = {
    id,
    ready: 0, park: 0, unpark: 0, gone: 0, updates: 0, allocs: 0,
    lastCtx: null,
    onLandblockReady(ctx) { p.ready += 1; p.lastCtx = ctx; log.push(["ready", ctx.lbKey]); },
    onLandblockPark(k) { p.park += 1; log.push(["park", k]); },
    onLandblockUnpark(k) { p.unpark += 1; log.push(["unpark", k]); },
    onLandblockGone(k) { p.gone += 1; log.push(["gone", k]); },
    update() { p.updates += 1; },
    dispose() { log.push(["dispose"]); },
    log,
    ...extra,
  };
  return p;
}

function fresh(search = "") {
  _resetTerrainVfx();
  _resetVfxFlags();
  const w = makeWorld();
  globalThis.window.location.search = search;
  // Count only groups the SPINE makes (makeWorld's worldRoot/terrainGroup are
  // the client's, not ours).
  groupsMade = 0;
  return w;
}

// ---------------------------------------------------------------------------
console.log("\n-- key helpers + coverage --");
check("lbKeyFromXY matches landblock_lru.js:348", lbKeyFromXY(0xab, 0xcd) === 0xabcd0000);
check("lbKeyOf masks the `| 0xffff` cell form off an lbId",
  lbKeyOf(((0xab << 24) | (0xcd << 16) | 0xffff) >>> 0) === 0xabcd0000);
check("lbKeyFromXY wraps bytes, never widens", lbKeyFromXY(0x1ab, 0x1cd) === 0xabcd0000);
{
  const cov = familyCoverageOf(new Uint8Array(81).fill(1)); // Grassland
  check("81 grass vertices ⇒ coverage[FAM_GRASS] === 81", cov[FAM_GRASS] === 81);
  const mixed = new Uint8Array(81).fill(1);
  mixed[0] = 10; // sand-yellow
  const cov2 = familyCoverageOf(mixed);
  check("a single sand vertex is visible in coverage",
    cov2[FAM_SAND] === 1 && cov2[FAM_GRASS] === 80);
  check("coverageMatches: empty families ⇒ every LB", coverageMatches(cov2, []) === true);
  check("coverageMatches: a present family matches", coverageMatches(cov2, [FAM_SAND]) === true);
  check("coverageMatches: an absent family does NOT", coverageMatches(cov2, [FAM_VOLCANO]) === false);
}

// ---------------------------------------------------------------------------
console.log("\n-- L11/L12: source-level invariants --");
{
  const src = fs.readFileSync(new URL("./scene3d/terrain_vfx.js", import.meta.url), "utf8");
  const code = src.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  check("no Math.random (deterministic placement, §5.5)", !/Math\.random\s*\(/.test(code));
  check("no argless Date.now (single clock, §2.3)", !/Date\.now\(\)/.test(code));
  check("no import of three (THREE is injected)", !/from\s+["']three["']/.test(code));
  check("never adds a light (§5.2)", !/PointLight|DirectionalLight|SpotLight/.test(code));
  check("never varies a per-instance program cache key (§5.4)",
    !/customProgramCacheKey/.test(code));
  check("does not import landblock_lru.js or fixed_grid.js (families never touch residency)",
    !/landblock_lru\.js|fixed_grid\.js/.test(code));
  const trail = fs.readFileSync(new URL("./scene3d/trail_map.js", import.meta.url), "utf8")
    .replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  check("trail_map.js: no Math.random / no light / no cache key",
    !/Math\.random\s*\(/.test(trail) && !/PointLight/.test(trail) && !/customProgramCacheKey/.test(trail));
}

// ---------------------------------------------------------------------------
console.log("\n-- L1/L2: ready once, park is NOT gone --");
{
  const { worldRoot, scene3d, terrainGroup } = fresh();
  initTerrainVfx({ THREE: FakeTHREE, scene3d, parent: worldRoot });
  const p = recorder("t.grass", { families: [FAM_GRASS], scope: "landblock" });
  registerTerrainVfx(p);

  const mesh = makeLbMesh(0x12, 0x34, 1);
  terrainGroup.add(mesh);
  terrainVfxNoteLandblockMesh(scene3d, mesh);
  check("onLandblockReady fired once", p.ready === 1);
  check("ctx carries the residency key + AC world origin",
    p.lastCtx.lbKey === lbKeyFromXY(0x12, 0x34)
    && p.lastCtx.originX === 0x12 * 192 && p.lastCtx.originY === 0x34 * 192);
  check("ctx carries a group parented OUTSIDE terrainGroup (LRU scans it!)",
    !!p.lastCtx.group && p.lastCtx.group.parent !== terrainGroup
    && p.lastCtx.group.parent.name === "terrainVfx");
  check("ctx carries the 81 codes and the coverage",
    p.lastCtx.codes.length === 81 && p.lastCtx.coverage[FAM_GRASS] === 81);
  check("ctx.oracle / ctx.trail are LIVE getters, not snapshots (both load on demand)",
    Object.getOwnPropertyDescriptor(p.lastCtx, "oracle")?.get !== undefined
    && Object.getOwnPropertyDescriptor(p.lastCtx, "trail")?.get !== undefined);

  // Re-noting the SAME mesh with no eviction is a rebake, not a second ready.
  terrainVfxNoteLandblockMesh(scene3d, mesh);
  check("L6: a re-note is a REBAKE — gone then ready, once each",
    p.gone === 1 && p.ready === 2, `gone=${p.gone} ready=${p.ready}`);

  // --- THE PARK TRAP ---
  const goneBefore = p.gone;
  terrainVfxLandblockPark(lbKeyFromXY(0x12, 0x34));
  check("park fires onLandblockPark", p.park === 1);
  check("⚠ park does NOT fire onLandblockGone", p.gone === goneBefore);
  check("park hides the provider's group (host module may touch .visible, §5.3)",
    p.lastCtx.group.visible === false);
  check("a parked LB is still TRACKED (survives for unpark)",
    terrainVfxStats().parked === 1 && terrainVfxStats().resident === 0);

  terrainVfxLandblockUnpark(lbKeyFromXY(0x12, 0x34));
  check("unpark fires onLandblockUnpark", p.unpark === 1);
  check("unpark does NOT re-fire ready (never re-scatter — hash stability §5.5)",
    p.ready === 2, String(p.ready));
  check("unpark restores group visibility", p.lastCtx.group.visible === true);

  // --- evict ---
  terrainVfxLandblockGone(lbKeyFromXY(0x12, 0x34), "evict");
  check("evict fires onLandblockGone", p.gone === goneBefore + 1);
  check("evict detaches the group from the scene", p.lastCtx.group.parent === null);
  check("evict drops the tracking entry", terrainVfxStats().tracked === 0);
  terrainVfxLandblockGone(lbKeyFromXY(0x12, 0x34), "evict");
  check("a second evict is idempotent", p.gone === goneBefore + 1);
}

// ---------------------------------------------------------------------------
console.log("\n-- L7: family gating --");
{
  const { worldRoot, scene3d } = fresh();
  initTerrainVfx({ THREE: FakeTHREE, scene3d, parent: worldRoot });
  const grass = recorder("t.grass", { families: [FAM_GRASS] });
  const volcano = recorder("t.volcano", { families: [FAM_VOLCANO] });
  const anyLb = recorder("t.any", { families: [] });
  registerTerrainVfx(grass);
  registerTerrainVfx(volcano);
  registerTerrainVfx(anyLb);

  terrainVfxNoteLandblockMesh(scene3d, makeLbMesh(1, 1, 1)); // all Grassland
  check("a grass LB reaches the grass provider", grass.ready === 1);
  check("a grass LB does NOT reach the volcano provider", volcano.ready === 0);
  check("families:[] means every LB", anyLb.ready === 1);

  // One ObsidianPlain vertex is enough — sparse effects care about presence.
  terrainVfxNoteLandblockMesh(scene3d, makeLbMesh(2, 2, 1, [[40, 6]]));
  check("a single volcano vertex opens the volcano provider", volcano.ready === 1);
  check("water-only landblocks are still offered (families filter, the plan's §3.8 rule is the provider's)",
    coverageMatches(familyCoverageOf(new Uint8Array(81).fill(17)), [FAM_WATER]) === true);
}

// ---------------------------------------------------------------------------
console.log("\n-- L3: camera scope is immune to landblock churn --");
{
  const { worldRoot, scene3d } = fresh();
  initTerrainVfx({ THREE: FakeTHREE, scene3d, parent: worldRoot });
  const cam = recorder("t.grassPool", { scope: "camera" });
  cam.update = () => { cam.updates += 1; if (cam.allocs === 0) cam.allocs = 1; };
  registerTerrainVfx(cam);

  for (let i = 0; i < 100; i += 1) {
    const m = makeLbMesh(i & 0xff, (i >> 4) & 0xff, 1);
    terrainVfxNoteLandblockMesh(scene3d, m);
    terrainVfxLandblockPark(lbKeyFromXY(i & 0xff, (i >> 4) & 0xff));
    terrainVfxLandblockUnpark(lbKeyFromXY(i & 0xff, (i >> 4) & 0xff));
    terrainVfxLandblockGone(lbKeyFromXY(i & 0xff, (i >> 4) & 0xff), "evict");
    terrainVfxTick(0.016, scene3d);
  }
  check("camera scope got ZERO landblock callbacks across 100 moves",
    cam.ready === 0 && cam.park === 0 && cam.unpark === 0 && cam.gone === 0);
  check("camera scope ticked every frame", cam.updates === 100);
  check("camera scope allocated its pool exactly once", cam.allocs === 1);
  check("no per-landblock group was created for a camera provider", groupsMade === 1,
    `groupsMade=${groupsMade} (1 = the shared terrainVfx root)`);
}

// ---------------------------------------------------------------------------
console.log("\n-- L4/L5: facade hooks — installed everywhere, CHAINED not clobbered --");
{
  const { worldRoot, scene3d, lruFacade } = fresh();
  initTerrainVfx({ THREE: FakeTHREE, scene3d, parent: worldRoot });
  const rep = terrainVfxHookReport(scene3d);
  check("hooks installed on scene3d", rep.scene3d === true);
  check("hooks installed on landblockLru.scene3d", rep["landblockLru.scene3d"] === true);
  check("hooks installed on liveScene3d", rep.liveScene3d === true);
  check("all three hook names present on the LRU's own facade",
    typeof lruFacade._evictTerrainBatchForLb === "function"
    && typeof lruFacade._parkTerrainBatchForLb === "function"
    && typeof lruFacade._unparkTerrainBatchForLb === "function");

  const p = recorder("t.chain", { families: [] });
  registerTerrainVfx(p);
  terrainVfxNoteLandblockMesh(scene3d, makeLbMesh(7, 7, 1));

  // Simulate terrain_batch.js already owning the hook.
  let batchCalls = 0;
  const batchFn = () => { batchCalls += 1; };
  scene3d._parkTerrainBatchForLb = batchFn;
  installTerrainVfxHooks(scene3d);
  check("an existing owner's function is WRAPPED, not replaced",
    scene3d._parkTerrainBatchForLb !== batchFn
    && scene3d._parkTerrainBatchForLb.__terrainVfxInner === batchFn);

  scene3d._parkTerrainBatchForLb(lbKeyFromXY(7, 7));
  check("BOTH run: terrain_batch's park fired", batchCalls === 1);
  check("BOTH run: the spine's park fired", p.park === 1);

  // terrain_batch re-installs its BARE function on every absorb (:760).
  scene3d._parkTerrainBatchForLb = batchFn;
  installTerrainVfxHooks(scene3d);
  installTerrainVfxHooks(scene3d);
  installTerrainVfxHooks(scene3d);
  check("a re-install by the other owner is re-wrapped",
    scene3d._parkTerrainBatchForLb.__terrainVfxInner === batchFn);
  check("repeated installs do NOT grow the chain (idempotent)",
    scene3d._parkTerrainBatchForLb.__terrainVfxInner === batchFn
    && scene3d._parkTerrainBatchForLb.__terrainVfxInner.__terrainVfxHook === undefined);

  // A throwing co-owner must not swallow our half.
  const parkBefore = p.park;
  scene3d._parkTerrainBatchForLb = () => { throw new Error("batch boom"); };
  installTerrainVfxHooks(scene3d);
  terrainVfxLandblockUnpark(lbKeyFromXY(7, 7));
  let threw = false;
  try { scene3d._parkTerrainBatchForLb(lbKeyFromXY(7, 7)); } catch (_) { threw = true; }
  check("a throwing co-owner is contained", threw === false);
  check("...and the spine still parked", p.park === parkBefore + 1);

  // The tick re-asserts the wrapping without an explicit install.
  scene3d._evictTerrainBatchForLb = batchFn;
  terrainVfxTick(0.016, scene3d);
  check("the per-frame tick re-asserts the hook chain",
    scene3d._evictTerrainBatchForLb.__terrainVfxHook === "_evictTerrainBatchForLb");

  // ⚠ REGRESSION (found LIVE 2026-07-31): the tick early-returns while the
  // spine is inert, so with no provider registered the wrappers decayed across
  // a whole session — 126 attaches, 0 parks, 0 gones. The ATTACH seam must
  // re-assert too, because an absorb (which re-installs terrain_batch's bare
  // function) is exactly what precedes every attach.
  unregisterTerrainVfx("t.chain");
  scene3d._parkTerrainBatchForLb = batchFn;
  scene3d._evictTerrainBatchForLb = batchFn;
  scene3d._unparkTerrainBatchForLb = batchFn;
  terrainVfxNoteLandblockMesh(scene3d, makeLbMesh(8, 8, 1));
  const rep2 = terrainVfxHookReport(scene3d);
  check("an ATTACH re-asserts the chain even with NO provider registered (inert tick)",
    rep2.scene3d === true && rep2["landblockLru.scene3d"] === true && rep2.liveScene3d === true,
    JSON.stringify(rep2));
}

// ---------------------------------------------------------------------------
console.log("\n-- L8: the two kill switches are allocation-free no-ops --");
{
  const w = fresh("?terrainVfx=off");
  const surface = initTerrainVfx({ THREE: FakeTHREE, scene3d: w.scene3d, parent: w.worldRoot });
  const p = recorder("t.off", { families: [] });
  registerTerrainVfx(p);
  terrainVfxNoteLandblockMesh(w.scene3d, makeLbMesh(3, 3, 1));
  terrainVfxTick(0.016, w.scene3d);
  check("?terrainVfx=off: no ready, no update", p.ready === 0 && p.updates === 0);
  check("?terrainVfx=off: no group allocated at all", groupsMade === 0);
  check("?terrainVfx=off: no hooks installed on any facade",
    w.scene3d._parkTerrainBatchForLb === undefined);
  check("?terrainVfx=off: stats still say WHY", surface.stats().disabledReason === "flag");

  const w2 = fresh("?wireframe=1");
  check("wireframeActive matches scene3d/index.js:698 (=== \"1\")",
    wireframeActive("?wireframe=1") === true && wireframeActive("?wireframe=0") === false
    && wireframeActive("") === false);
  const s2 = initTerrainVfx({ THREE: FakeTHREE, scene3d: w2.scene3d, parent: w2.worldRoot });
  const p2 = recorder("t.wire", { families: [] });
  registerTerrainVfx(p2);
  terrainVfxNoteLandblockMesh(w2.scene3d, makeLbMesh(3, 3, 1));
  terrainVfxTick(0.016, w2.scene3d);
  check("?wireframe=1: hard no-op (plan §8 risk 8, guarded ONCE here)",
    p2.ready === 0 && p2.updates === 0 && groupsMade === 0);
  check("?wireframe=1: stats say wireframe", s2.stats().disabledReason === "wireframe");

  const w3 = fresh("");
  const s3 = initTerrainVfx({ THREE: FakeTHREE, scene3d: w3.scene3d, parent: w3.worldRoot });
  check("bare default: the spine IS enabled (the kill switch is an opt-OUT)",
    s3.stats().enabled === true);
  terrainVfxTick(0.016, w3.scene3d);
  check("bare default with NO providers: the tick is inert (no counter moves)",
    s3.stats().counters.ticks === 0);
}

// ---------------------------------------------------------------------------
console.log("\n-- L9: late registration replays the resident ring --");
{
  const { worldRoot, scene3d } = fresh();
  initTerrainVfx({ THREE: FakeTHREE, scene3d, parent: worldRoot });
  for (let i = 0; i < 5; i += 1) terrainVfxNoteLandblockMesh(scene3d, makeLbMesh(i, 0, 1));
  terrainVfxLandblockPark(lbKeyFromXY(4, 0));

  const late = recorder("t.late", { families: [FAM_GRASS] });
  registerTerrainVfx(late);
  check("a provider registered after the ring baked sees the 4 RESIDENT LBs", late.ready === 4,
    String(late.ready));
  check("...and not the parked one (it gets it on unpark)", late.ready === 4);
  terrainVfxLandblockUnpark(lbKeyFromXY(4, 0));
  check("unparking an LB the provider never saw fires READY, not unpark",
    late.ready === 5 && late.unpark === 0);

  // Unregistering tears everything down.
  unregisterTerrainVfx("t.late");
  check("unregister fires onLandblockGone for every held LB", late.gone === 5);
  check("unregister calls dispose()", late.log[late.log.length - 1][0] === "dispose");
  check("unregister removes the provider", terrainVfxStats().providers.length === 0);
}

// ---------------------------------------------------------------------------
console.log("\n-- L10: a throwing provider is contained --");
{
  const { worldRoot, scene3d } = fresh();
  initTerrainVfx({ THREE: FakeTHREE, scene3d, parent: worldRoot });
  const bad = {
    id: "t.bad",
    families: [],
    onLandblockReady() { throw new Error("ready boom"); },
    update() { throw new Error("update boom"); },
  };
  const good = recorder("t.good", { families: [] });
  const realWarn = console.warn;
  console.warn = () => {};
  registerTerrainVfx(bad);
  registerTerrainVfx(good);
  let threw = false;
  try {
    terrainVfxNoteLandblockMesh(scene3d, makeLbMesh(9, 9, 1));
    terrainVfxTick(0.016, scene3d);
  } catch (_) { threw = true; }
  console.warn = realWarn;
  check("a throwing provider does not break the lifecycle", threw === false);
  check("the good provider still got its callbacks", good.ready === 1 && good.updates === 1);
  const st = terrainVfxStats();
  check("the failure is REPORTED, not swallowed silently",
    st.counters.providerErrors >= 2
    && st.providers.find((x) => x.id === "t.bad").errors >= 2);
}

// ---------------------------------------------------------------------------
console.log("\n-- registration guards + tier gating --");
{
  const { worldRoot, scene3d } = fresh();
  initTerrainVfx({ THREE: FakeTHREE, scene3d, parent: worldRoot });
  const t = (fn) => { try { fn(); return null; } catch (e) { return e.message; } };
  check("a provider with no id is rejected", !!t(() => registerTerrainVfx({})));
  check("an unknown scope is rejected", !!t(() => registerTerrainVfx({ id: "x", scope: "world" })));
  registerTerrainVfx({ id: "dup" });
  check("a duplicate id is rejected", !!t(() => registerTerrainVfx({ id: "dup" })));

  const tiered = recorder("t.low", { families: [], quality: () => null });
  registerTerrainVfx(tiered);
  terrainVfxNoteLandblockMesh(scene3d, makeLbMesh(5, 5, 1));
  check("quality() === null ⇒ disabled at this tier, no ready", tiered.ready === 0);

  const offFlag = recorder("t.flagoff", { families: [], enabled: () => false });
  registerTerrainVfx(offFlag);
  terrainVfxNoteLandblockMesh(scene3d, makeLbMesh(6, 6, 1));
  terrainVfxTick(0.016, scene3d);
  check("enabled() false ⇒ no ready and no update", offFlag.ready === 0 && offFlag.updates === 0);
}

// ---------------------------------------------------------------------------
console.log("\n-- the oracle seam (Wave 0A, late-bound) --");
{
  const { worldRoot, scene3d } = fresh();
  const surface = initTerrainVfx({ THREE: FakeTHREE, scene3d, parent: worldRoot });
  const st = terrainVfxOracleSelfTestSync({ samples: 4 });
  check("oracleSelfTest reports WHY it cannot run rather than throwing",
    st.pass === false && typeof st.reason === "string" && st.samples === 0, st.reason);
  check("the async oracleSelfTest pulls the oracle in itself (it is the one call that must)",
    terrainVfxOracleSelfTest({ samples: 2 }) instanceof Promise);
  check("stats expose the oracle state", ["idle", "loading", "ready", "absent"].includes(surface.stats().oracle));
  check("terrainVfx surface exposes stats + oracleSelfTest + ensureOracle",
    typeof surface.stats === "function"
    && typeof surface.oracleSelfTest === "function"
    && typeof surface.ensureOracle === "function");
  check("window.__terrainVfx is installed", globalThis.window.__terrainVfx === surface);
}
{
  // The self-test's sampler must be deterministic (§5.5).
  const a = makeSeededRng(1234); const b = makeSeededRng(1234);
  const sa = [a(), a(), a()]; const sb = [b(), b(), b()];
  check("the sampler RNG is seeded + reproducible", sa.every((v, i) => v === sb[i]));
  check("...and stays in [0,1)", sa.every((v) => v >= 0 && v < 1));
}

// Await the real oracle import if Wave 0A has landed, and report either way.
{
  const { worldRoot, scene3d } = fresh();
  const surface = initTerrainVfx({ THREE: FakeTHREE, scene3d, parent: worldRoot });
  registerTerrainVfx(recorder("t.needsOracle", { families: [] }));
  const oracle = await surface.ensureOracle();
  const state = surface.stats().oracle;
  check("ensureOracle resolves without throwing whether or not 0A has landed",
    state === "ready" || state === "absent");
  console.log(`  [info] terrain_oracle.js is ${state.toUpperCase()}${oracle ? " — the live path is wired" : " — running the documented stub path"}`);
  if (oracle) {
    terrainVfxNoteLandblockMesh(scene3d, makeLbMesh(2, 3, 1));
    const s = oracle.sample ? oracle.sample(2 * 192 + 72, 3 * 192 + 120) : null;
    check("0A LANDED: a noted landblock samples through the oracle", !!s && Number.isFinite(s.code), JSON.stringify(s));
    // Park survival — the whole reason §2.1.1 exists.
    scene3d.terrainGroup.children.length = 0;
    terrainVfxLandblockPark(lbKeyFromXY(2, 3));
    const s2 = oracle.sample ? oracle.sample(2 * 192 + 72, 3 * 192 + 120) : null;
    check("0A LANDED: PARK SURVIVAL — sample() still resolves with the mesh out of terrainGroup", !!s2);
    terrainVfxLandblockGone(lbKeyFromXY(2, 3), "evict");
    check("0A LANDED: evict invalidates the oracle cache",
      !(oracle.sample && oracle.sample(2 * 192 + 72, 3 * 192 + 120)));
  }
}

// ---------------------------------------------------------------------------
console.log("\n-- L13: the tick clock survives a frozen scene3d.frameTime --");
// `scene3d.frameTime` is stamped ONLY by the rAF tick (scene3d/index.js), and
// the `?netDrainHz=N` interval ALSO drives tickPerFrame while that loop idles
// under `?renderOnDemand=1` / `?nullRender=1`. The spine used to read tSec/dt
// straight off frameTime, so in exactly those bot sessions every terrain-VFX
// family's clock stopped: terrain_rock's 15 s retail light tick could never
// expire again, and terrain_dirt's footfall limiter (`tSec - last < interval`)
// rejected every step forever. loop.js now passes a LIVE monotonic stamp.
{
  const { worldRoot, scene3d } = fresh();
  initTerrainVfx({ THREE: FakeTHREE, scene3d, parent: worldRoot });
  const seen = [];
  const p = recorder("t.clockProbe", { scope: "camera" });
  p.update = (dt, ctx) => { seen.push({ dt, tSec: ctx.tSec }); };
  registerTerrainVfx(p);

  // A FROZEN frameTime — exactly what the net-drain path presents.
  scene3d.frameTime = { tsSec: 100, dt: 0.016 };

  // No live stamp: the legacy contract still works (back-compat for callers
  // that predate the third argument, and for direct test drivers).
  terrainVfxTick(0.016, scene3d);
  check("without a live stamp the frameTime clock is still used",
    seen.length === 1 && seen[0].tSec === 100);

  // With a live stamp, tSec must advance and dt must be derived from it.
  seen.length = 0;
  for (let i = 1; i <= 5; i += 1) terrainVfxTick(0.016, scene3d, 200 + i * 0.05);
  check("tSec advances from the LIVE stamp while frameTime stays frozen",
    seen.length === 5 && seen[0].tSec === 200.05
      && seen[4].tSec > seen[0].tSec && scene3d.frameTime.tsSec === 100,
    `first=${seen[0] && seen[0].tSec} last=${seen[4] && seen[4].tSec}`);
  check("dt is derived from successive live stamps, not the frozen frameTime.dt",
    seen.slice(1).every((s) => Math.abs(s.dt - 0.05) < 1e-9),
    seen.map((s) => s.dt.toFixed(4)).join(","));
  check("the first live tick reports dt 0 rather than a jump from nothing",
    seen[0].dt === 0, `dt=${seen[0].dt}`);

  // A long stall must not hand a provider a huge single step to integrate.
  seen.length = 0;
  terrainVfxTick(0.016, scene3d, 400);
  check("a long stall is clamped to MAX_TICK_DT_SEC",
    seen[0].dt <= 0.25 + 1e-9 && seen[0].dt > 0, `dt=${seen[0].dt}`);

  // A non-monotonic stamp must not produce a negative dt.
  seen.length = 0;
  terrainVfxTick(0.016, scene3d, 399);
  check("a backwards stamp yields dt 0, never negative", seen[0].dt === 0, `dt=${seen[0].dt}`);
  unregisterTerrainVfx("t.clockProbe");
}

_resetTerrainVfx();
delete globalThis.window;

console.log(`\nterrain-vfx lifecycle: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
