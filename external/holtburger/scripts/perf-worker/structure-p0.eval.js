// scripts/perf-worker/structure-p0.eval.js — the P0 STRUCTURE READ for the GPU-resident
// statics work (apps/holtburger-web/docs/HANDOFF-gpu-resident-statics-2026-10-22.md §7 P0).
// Page-side. Written 2026-10-22 as P0 preparation; first laptop runs the same day (the dated
// notes below), never yet on the 1070.
//
// WHY. P0's decisions turn on counts nobody has read in a town since ?batchedRuns landed
// (handoff §3, §5):
//   * how many multidraw ranges three asks for per frame and how many reach ANGLE
//     (`__batchedRuns.frame()`, `__diag.render.subDraws / issuedSubDraws`). `renderer.info`
//     counts a whole multidraw as ONE call (walls rows 82/83/118/206), so it cannot answer;
//   * which buckets could reach three's settled-frame early-out (`!perObjectFrustumCulled
//     && !sortObjects`, BatchedMesh.js onBeforeRender): the sorted vs unsorted split of the
//     chunk and atlas slots settles F4;
//   * whether an atlas bucket ever repeats a range (F2: every atlased placement was its own
//     geometry, so batchedRuns counted the bucket `noGain`). 2026-10-23: the F2 fix
//     (?atlasGeomDedup, P1a) went DEFAULT-ON on 10-22, so a bare URL now reads the FIXED
//     state — repeatFactor > 1 with census.atlas.geomDedupHits > 0 means P1a is live. F2's
//     own size comes from the `&atlasGeomDedup=off` arm (queue item P0-FLAGS-2026-10-22).
// These are STRUCTURAL counts. For one URL, pose and dist they come out the same on
// SwiftShader and on the 1070, so this one file serves both machines:
//   * 1070 (P0 arms 1-3, owner-run):
//       node scripts/perf-worker/hbsess.mjs eval scripts/perf-worker/structure-p0.eval.js
//     on the page `hbsess.mjs boot` left at Holtburg (no options needed: the defaults below
//     are the 1070's);
//   * laptop: scripts/perf-worker/laptop-structure-probe.mjs sets window.__structureP0Opts
//     and evaluates this same file the same way.
// No figure here is a timing claim. The path stops record rAF intervals because on the
// 1070 they are the "fixed @teleloc path" condition; on SwiftShader they mean nothing.
//
// FORMAT. The BODY of an async function: hbsess.mjs wraps the file as
// `(async () => { <file> })()` and prints the return value as JSON, and the laptop probe
// wraps it the same way. So: no static imports, top-level `return`, and the result is
// plain JSON (`plain` collapses Maps/Sets/typed arrays and drops functions).
//
// ONE RUN, per town in OPTS.towns (default Holtburg, then Linvak Tukal):
//   1. `@teleloc` to the town's settle point (window.__sessionHandle.sendChat), wait for
//      the landing and for the portal tunnel to end (every hop plays it), then SETTLE:
//      terrainBakedLbs.size, the LRU resident count, the statics / buildings / cells
//      subtree node counts and the BatchedMesh count and live instances, all unchanged for
//      quietMs, and 80% of the town's ring baked and not parked (capped at maxMs;
//      `quiet:false` is reported, never hidden).
//   2. Park the camera on the town's fixed orbit (`__cam.orbit`, AC world metres around the
//      landed pose; Holtburg's is hbsess.mjs's own __hbOrbit) and HOLD it for holdFrames
//      frames with renderer.info.autoReset off (left on, it zeroes the counts on every
//      render() call — the 2026-07-01 measurement trap), sampling __batchedRuns.frame() and
//      __diag.render every frame and diffing the cumulative walk / run counters.
//   3. CENSUS: __statBatchXStats() (per-bucket sorted/slots and the walk block),
//      __atlasStats(), __batchedRuns, __diag.render, __diag.pools(), the LRU, and every
//      BatchedMesh in the scene by kind (atlas / chunk / lbStatic / building / pool /
//      terrain / other) with sortObjects, perObjectFrustumCulled, frustumCulled, slots,
//      live and visible instances, geometries, DISTINCT RANGE STARTS over the visible
//      instances (the fewest runs the bucket could be drawn as) and the last multidraw's
//      range count and distinct starts. Plus the scene node census and the camera pose.
//   4. PATH (OPTS.path): release the camera to the chase cam and hop the town's fixed
//      @teleloc stops, dwelling dwellMs at each once its tunnel ended (rAF intervals +
//      per-frame range counts), with a lite census per stop; the last hop returns to the
//      settle point. Every census records the tunnel state around its hold, and a town's
//      `tunnelHeld` lists each census held while the tunnel ran (reject those). The page is
//      left parked on the town's orbit with window.__hbOrbit pointing at it, so
//      `hbsess.mjs orbit` / `profile` work on whichever town ran last.
//
// TOWN COORDINATES (every stop's outdoor cell is floor(x/24)*8 + floor(y/24) + 1, checked
// against ace_world's own cell ids for the NPC stops; the bench point keeps the cell word
// the drivers have always sent):
//   Holtburg settle 0xA9B40001 96 96 80 — the HOLT constant of hbprobe / hbsess / flag-bench
//     / hbbench, so P0 sits on the pose the 10-06 and 10-19 numbers came from.
//   Linvak Tukal settle 0xA21E001A 83 38 560.4 — ACE's own POI destination (ace_world
//     points_of_interest, scripts/net-review/poi-destinations.json; also the destination of
//     every "Portal to Linvak Tukal"), inside the south gate.
//   Path stops stand 1.5 m beside NPCs whose placements (ace_world landblock_instance) give
//   a ground z [M], +0.5 m so the landing drops onto the floor. No stop is near a portal:
//   ACE activates a portal on collision (Portal.OnCollideObject).
//
// OPTIONS: window.__structureP0Opts, merged over DEFAULTS (the 1070's). `tablesOnly: true`
// returns the tables without touching the page (the node test reads them that way).

const W = typeof window !== "undefined" ? window : globalThis;
const SCHEMA = "hb-structure-p0-v1";

const DEFAULTS = {
  towns: ["holtburg", "linvak"],
  // The 1070 numbers: hbprobe.mjs settles on 12 s quiet / 150 s cap after an 8 s wait.
  settle: { quietMs: 12000, maxMs: 150000, pollMs: 1000 },
  postTeleMs: 8000,
  telelocWaitMs: 20000,
  // After every landing, wait this long at most for the portal tunnel to end by itself
  // (2026-10-23: it holds >= 2 s past the landing, then 1 s out + 1 s world fade-in). 0 =
  // do not wait (the laptop, whose tunnel outlives any wait: endTunnelBeforeCensus).
  tunnelWaitMs: 15000,
  holdFrames: 30,
  holdMaxMs: 20000,
  path: true,
  dwellMs: 10000,
  // A settle per path stop (null = a fixed dwell only, so every arm spends the same time).
  pathSettle: null,
  liteHoldFrames: 3,
  // Per-bucket rows in the census. Off keeps the 1070 output small; the aggregates by kind
  // and __statBatchXStats().detail (sorted / slots per chunk bucket) are always there.
  detail: false,
  // Test seam: where to import scene3d/batched_runs.js from (default: next to index.html).
  batchedRunsModuleUrl: null,
  // Laptop only (2026-10-22): settle UNDER the @teleloc tunnel, then end it right before the
  // census. On SwiftShader the tunnel's per-frame clock outlives any wait, and rendering the
  // world while it streams pushed the renderer + GPU process past earlyoom; under the tunnel
  // the world submission is skipped (portal_space.js RENDER), so streaming and the first world
  // render no longer overlap. The 1070 never sets this (its tunnel ends by itself).
  endTunnelBeforeCensus: false,
  portalSpaceModuleUrl: null,
  tablesOnly: false,
};
const OPTS = {
  ...DEFAULTS,
  ...(W.__structureP0Opts || {}),
};
OPTS.settle = { ...DEFAULTS.settle, ...((W.__structureP0Opts || {}).settle || {}) };

const cellOf = (lb, x, y) => ((lb << 16) | (Math.floor(x / 24) * 8 + Math.floor(y / 24) + 1)) >>> 0;
const TOWNS = {
  holtburg: {
    name: "Holtburg",
    lb: 0xa9b4,
    settle: { cell: 0xa9b40001, x: 96, y: 96, z: 80, src: "bench point: HOLT in hbprobe/hbsess/flag-bench/hbbench" },
    orbit: { dist: 70, az: 45, el: 22, dz: 1.5, src: "hbsess.mjs boot __hbOrbit" },
    path: [
      { cell: 0xa9b40019, x: 84, y: 7.1, z: 94, src: "ACE POI 'Holtburg' (= @telepoi Holtburg): the hilltop Life Stone square" },
      { cell: cellOf(0xa9b4, 74.5, 138.4), x: 74.5, y: 138.4, z: 66.5, src: "lower terrace, 1.5 m east of NPC Dwennon (landblock_instance A9B4001E 73.0 138.4 66.00)" },
      { cell: cellOf(0xa9b4, 175.2, 106.4), x: 175.2, y: 106.4, z: 65.8, src: "east road, 1.5 m west of a Royal Guard (landblock_instance A9B4003D 176.7 106.4 65.28)" },
      { cell: 0xa9b40001, x: 96, y: 96, z: 80, src: "back to the settle point" },
    ],
  },
  linvak: {
    name: "Linvak Tukal",
    lb: 0xa21e,
    settle: { cell: 0xa21e001a, x: 83, y: 38, z: 560.4, src: "ACE POI 'Linvak Tukal' (points_of_interest; Portal to Linvak Tukal destination)" },
    // South-south-west of the south wall, above the walls (16-51 m) and most halls, looking
    // NNE over the fortress (film research town-linvak-tukal.json: footprint x 31104-31272,
    // y 5760-5928, towers to z 676). An orbit at Holtburg's 70 m / 22 deg sits inside it.
    orbit: { dist: 110, az: 200, el: 35, dz: 1.5, src: "chosen 2026-10-22 [D]: outside the south wall, above it" },
    path: [
      { cell: cellOf(0xa21e, 125.7, 49.7), x: 125.7, y: 49.7, z: 565.5, src: "1.5 m west of NPC Aurutis (landblock_instance A21E 127.2 49.7 565.01)" },
      { cell: cellOf(0xa21e, 97.9, 133.0), x: 97.9, y: 133.0, z: 569.5, src: "north court, 1.5 m west of NPC Neelic (landblock_instance A21E0026 99.4 133.0 569.01)" },
      { cell: cellOf(0xa21e, 87.7, 86.0), x: 87.7, y: 86.0, z: 611.5, src: "top of the central ramp, 1.5 m west of Lord Kresovus (landblock_instance A21E 89.2 86.0 611.05)" },
      { cell: 0xa21e001a, x: 83, y: 38, z: 560.4, src: "back to the settle point" },
    ],
  },
};
const hex8 = (n) => "0x" + (n >>> 0).toString(16).toUpperCase().padStart(8, "0");
const telelocCmd = (s) => `@teleloc ${hex8(s.cell)} ${s.x} ${s.y} ${s.z}`;

if (OPTS.tablesOnly) {
  const towns = {};
  for (const [k, t] of Object.entries(TOWNS)) {
    towns[k] = { ...t, settleCmd: telelocCmd(t.settle), pathCmds: t.path.map(telelocCmd) };
  }
  return { schema: SCHEMA, defaults: DEFAULTS, towns };
}

// ── small helpers ───────────────────────────────────────────────────────────────────────
const now = () => (typeof performance !== "undefined" && performance.now ? performance.now() : Date.now());
const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms | 0)));
const log = (...a) => { try { console.log("[structure-p0]", ...a); } catch (_) { /* no console */ } };
const errors = [];
const note = (where, e) => { errors.push(`${where}: ${String((e && e.message) || e).slice(0, 300)}`); };
const call = (where, f) => { try { return f(); } catch (e) { note(where, e); return null; } };

/** JSON-safe copy: Map -> object, Set -> {size}, typed array -> length, three objects ->
 *  a tag, no functions. A cycle is cut at the repeat ("[cycle]"); an object reached twice
 *  through different parents is NOT a cycle and is copied both times (the ancestor stack
 *  follows the replacer's `this`, json-stringify-safe's technique). Applied per seam dump
 *  as well as to the whole result, so one odd seam cannot blank the rest. */
function plain(v) {
  try {
    const stack = [];
    return JSON.parse(JSON.stringify(v, function (k, x) {
      if (typeof x === "bigint") return String(x);
      if (typeof x === "function") return undefined;
      if (x instanceof Set) return { size: x.size };
      if (ArrayBuffer.isView(x)) return { typedArray: x.constructor.name, length: x.length };
      if (x instanceof Map) x = Object.fromEntries([...x.entries()].slice(0, 500).map(([a, b]) => [String(a), b]));
      if (x && typeof x === "object") {
        if (x.isObject3D || x.isMaterial || x.isTexture || x.isBufferGeometry) return `[three ${x.type || "object"}]`;
        while (stack.length && stack[stack.length - 1] !== this) stack.pop();
        if (stack.includes(x)) return "[cycle]";
        stack.push(x);
      }
      return x;
    }));
  } catch (e) {
    return { plainError: String((e && e.message) || e) };
  }
}

function median(a) {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
}
function agg(rows, keys) {
  const out = {};
  for (const k of keys) {
    const v = rows.map((r) => r && r[k]).filter((x) => typeof x === "number");
    out[k] = v.length ? { median: median(v), min: Math.min(...v), max: Math.max(...v), last: v[v.length - 1] } : null;
  }
  out.samples = rows.length;
  return out;
}
function frameStats(dts) {
  if (!dts.length) return null;
  const s = [...dts].sort((a, b) => a - b);
  const q = (p) => +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(2);
  const sum = dts.reduce((a, b) => a + b, 0);
  return { frames: dts.length, fps: +(dts.length / (sum / 1000)).toFixed(1), p50: q(0.5), p95: q(0.95), p99: q(0.99),
    max: +s[s.length - 1].toFixed(1), mean: +(sum / dts.length).toFixed(2) };
}
/** Run `onStart()` on the next animation frame, then `perFrame(k)` on each of the n frames
 *  after it (k = 1..n), capped at maxMs. Snapshotting in `onStart` (not before the first
 *  frame) makes the span exactly n app renders whichever order the app's rAF callback and
 *  this one run in: both re-register every frame, so their order never changes. */
function eachFrame(n, maxMs, perFrame, onStart) {
  return new Promise((resolve) => {
    const raf = W.requestAnimationFrame ? W.requestAnimationFrame.bind(W) : (f) => setTimeout(() => f(now()), 16);
    const t0 = now();
    let k = 0;
    const tick = (ts) => {
      if (k === 0 && onStart) { try { onStart(ts); } catch (e) { note("onStart", e); } }
      if (k > 0 && perFrame) { try { perFrame(k, ts); } catch (e) { note("perFrame", e); } }
      if (k >= n || now() - t0 >= maxMs) { resolve({ frames: k, ms: Math.round(now() - t0) }); return; }
      k += 1;
      raf(tick);
    };
    raf(tick);
  });
}

function pose() {
  const h = W.__sessionHandle;
  if (!h || typeof h.getLocalPlayerPose !== "function") return null;
  let p = null;
  try {
    p = h.getLocalPlayerPose();
    if (!p) return null;
    return { lb: "0x" + ((p.landblockId >>> 0).toString(16).padStart(8, "0")), lbHi: (p.landblockId >>> 16) & 0xffff,
      x: +(+p.x).toFixed(2), y: +(+p.y).toFixed(2), z: +(+p.z).toFixed(2) };
  } catch (e) {
    note("pose", e);
    return null;
  } finally {
    // WASM-box lifetime: release after copying (camera.js world() does the same).
    try { p && p.free && p.free(); } catch (_) { /* already released */ }
  }
}

function cameraPose() {
  const out = { cam: null, three: null };
  if (W.__cam && typeof W.__cam.info === "function") out.cam = call("cam.info", () => W.__cam.info());
  const c = W.liveScene3d && (W.liveScene3d.cameraSwitcher?.activeCamera || W.liveScene3d.camera);
  if (c && c.matrixWorld) {
    const e = c.matrixWorld.elements;
    out.three = { pos: [e[12], e[13], e[14]].map((v) => +v.toFixed(2)), fov: c.fov ?? null, aspect: c.aspect != null ? +c.aspect.toFixed(4) : null,
      near: c.near ?? null, far: c.far ?? null, quat: c.quaternion ? [c.quaternion.x, c.quaternion.y, c.quaternion.z, c.quaternion.w].map((v) => +v.toFixed(5)) : null };
  }
  return out;
}

// ── BatchedMesh census ──────────────────────────────────────────────────────────────────
/** Which producer owns a BatchedMesh — read from the markers each one stamps (re-read
 *  2026-10-22): pool_registry `__drawPool`, static_atlas `__statAtlasCrossLb`,
 *  static_batch_x `__staticBatchCrossLb`, statics.js per-LB `__staticBatch`, buildings.js
 *  `__buildingBatch`, terrain_batch `__terrainBatchMesh` ("terrain-batch-x"). */
function kindOf(o) {
  const ud = (o && o.userData) || {};
  if (ud.__drawPool) return "pool";
  if (ud.__statAtlasCrossLb) return "atlas";
  if (ud.__staticBatchCrossLb) return "chunk";
  if (ud.__staticBatch) return "lbStatic";
  if (ud.__buildingBatch) return "building";
  if (ud.__terrainBatchMesh || o.name === "terrain-batch-x") return "terrain";
  return "other";
}
const startOf = (g) => (typeof g.start === "number" && g.start >= 0 ? g.start : g.indexStart >= 0 ? g.indexStart : g.vertexStart);
function visibleChain(o) {
  for (let n = o; n; n = n.parent) if (n.visible === false) return false;
  return true;
}
function bmRow(o, isMarked) {
  const ud = o.userData || {};
  const info = Array.isArray(o._instanceInfo) ? o._instanceInfo : [];
  const ginfo = Array.isArray(o._geometryInfo) ? o._geometryInfo : [];
  let live = 0, vis = 0;
  const gids = new Set(), starts = new Set();
  for (let i = 0; i < info.length; i++) {
    const it = info[i];
    if (!it || !it.active) continue;
    live += 1;
    if (!it.visible) continue;
    vis += 1;
    gids.add(it.geometryIndex);
    const g = ginfo[it.geometryIndex];
    if (g) starts.add(startOf(g));
  }
  let geoms = 0;
  for (const g of ginfo) if (g && g.active !== false) geoms += 1;
  const n = o._multiDrawCount | 0;
  const ms = o._multiDrawStarts;
  const lastStarts = new Set();
  if (ms) for (let k = 0; k < n && k < ms.length; k++) lastStarts.add(ms[k]);
  const mat = Array.isArray(o.material) ? o.material[0] : o.material;
  return {
    kind: kindOf(o),
    name: String(o.name || "").slice(0, 96),
    visible: o.visible !== false,
    visibleChain: visibleChain(o),
    sorted: !!o.sortObjects,
    perObjCulled: !!o.perObjectFrustumCulled,
    frustumCulled: !!o.frustumCulled,
    // three's onBeforeRender skips the per-instance walk only with both off (and no
    // visibility change) — the L0 / F4 condition.
    earlyOut: !o.perObjectFrustumCulled && !o.sortObjects,
    castShadow: !!o.castShadow,
    receiveShadow: !!o.receiveShadow,
    layers: o.layers ? o.layers.mask : null,
    slots: info.length,
    instances: live,
    visibleInstances: vis,
    geometries: geoms,
    geometrySlots: ginfo.length,
    distinctGeoms: gids.size,
    distinctStarts: starts.size,
    lastDraw: n,
    lastDistinctStarts: lastStarts.size,
    marked: isMarked ? isMarked(o) : null,
    dead: ud.__deadBatch === true,
    transparent: !!(mat && mat.transparent),
    alphaTest: mat && typeof mat.alphaTest === "number" ? mat.alphaTest : null,
    passClass: ud.passClass ?? null,
    matType: (mat && mat.type) || null,
  };
}
const SUM_KEYS = ["slots", "instances", "visibleInstances", "geometries", "distinctStarts", "lastDraw", "lastDistinctStarts"];
function aggregateKinds(rows) {
  const by = {};
  for (const r of rows) {
    const a = (by[r.kind] ||= {
      nodes: 0, visibleNodes: 0, sorted: 0, unsorted: 0, perObjCulledOn: 0, perObjCulledOff: 0,
      frustumCulledOn: 0, frustumCulledOff: 0, earlyOutEligible: 0, marked: 0, markedUnknown: 0, dead: 0,
      slots: 0, instances: 0, visibleInstances: 0, geometries: 0, distinctStarts: 0, lastDraw: 0, lastDistinctStarts: 0,
      sortedSlots: 0, unsortedSlots: 0, sortedInstances: 0, unsortedInstances: 0,
      lastDrawn: 0, lastNoRepeat: 0,
    });
    a.nodes += 1;
    if (r.visible && r.visibleChain) a.visibleNodes += 1;
    if (r.sorted) { a.sorted += 1; a.sortedSlots += r.slots; a.sortedInstances += r.instances; }
    else { a.unsorted += 1; a.unsortedSlots += r.slots; a.unsortedInstances += r.instances; }
    if (r.perObjCulled) a.perObjCulledOn += 1; else a.perObjCulledOff += 1;
    if (r.frustumCulled) a.frustumCulledOn += 1; else a.frustumCulledOff += 1;
    if (r.earlyOut) a.earlyOutEligible += 1;
    if (r.marked === true) a.marked += 1; else if (r.marked === null) a.markedUnknown += 1;
    if (r.dead) a.dead += 1;
    // Nodes whose last multidraw repeated no range: batchedRuns' unsorted noGain shape, per KIND
    // (its own `noGain` counter sums every marked kind).
    if (r.lastDraw > 0) { a.lastDrawn += 1; if (!r.sorted && r.lastDistinctStarts === r.lastDraw) a.lastNoRepeat += 1; }
    for (const k of SUM_KEYS) a[k] += r[k];
  }
  for (const a of Object.values(by)) {
    // Visible placements per distinct range: 1.0 = no range repeats (runs cannot help).
    a.repeatFactor = a.distinctStarts > 0 ? +(a.visibleInstances / a.distinctStarts).toFixed(3) : null;
  }
  return by;
}

/** markBatchedRuns lives in a WeakSet inside scene3d/batched_runs.js; importing the module
 *  by the URL the app loaded it from returns the SAME instance (module map). If any chunk
 *  or atlas bucket exists and none reads marked, the import was a second instance (or the
 *  marking regressed): marks are then reported unknown, never as "0 marked". */
async function markReader(rowsProbe) {
  let mod = null;
  try {
    const url = OPTS.batchedRunsModuleUrl || new URL("scene3d/batched_runs.js", W.location.href).href;
    mod = await import(url);
  } catch (e) {
    note("import batched_runs.js", e);
    return { readable: false, fn: null };
  }
  if (!mod || typeof mod.isBatchedRunsMarked !== "function") return { readable: false, fn: null };
  const markers = rowsProbe.filter((o) => { const k = kindOf(o); return k === "chunk" || k === "atlas"; });
  if (markers.length > 0 && !markers.some((o) => mod.isBatchedRunsMarked(o))) {
    return { readable: false, fn: null, why: `${markers.length} chunk/atlas buckets and none reads marked — a second module instance?` };
  }
  return { readable: true, fn: (o) => mod.isBatchedRunsMarked(o) };
}

function sceneCensus() {
  const s = W.liveScene3d;
  const out = { nodes: 0, byType: {}, visibleRenderables: 0, lights: 0, groups: {} };
  const bms = [];
  if (!s || !s.scene) return { out, bms };
  s.scene.traverse((o) => {
    out.nodes += 1;
    if (o.isLight) out.lights += 1;
    if (o.isMesh || o.isPoints || o.isLine || o.isSprite) {
      const k = o.isBatchedMesh ? "BatchedMesh" : o.isInstancedMesh ? "InstancedMesh" : o.type || "Mesh";
      out.byType[k] = (out.byType[k] || 0) + 1;
      if (o.visible) out.visibleRenderables += 1;
    }
    if (o.isBatchedMesh) bms.push(o);
  });
  const sub = (g) => { let n = 0; try { g && g.traverse(() => { n += 1; }); } catch (_) { /* fail-soft */ } return g ? n : null; };
  out.groups = { statics: sub(s.staticsGroup), buildings: sub(s.buildingsGroup), cells: sub(s.cellsGroup),
    terrain: sub(s.terrainGroup), entities: sub(s.entitiesGroup) };
  return { out, bms };
}

/** The settle fingerprint (task definition: terrain + static node / instance counts). */
function fingerprint() {
  const s = W.liveScene3d;
  if (!s || !s.scene) return null;
  const size = (x) => (x && typeof x.size === "number" ? x.size : -1);
  const sub = (g) => { let n = 0; try { g && g.traverse(() => { n += 1; }); } catch (_) { /* fail-soft */ } return n; };
  let bm = 0, inst = 0;
  try {
    s.scene.traverse((o) => {
      if (!o.isBatchedMesh) return;
      bm += 1;
      inst += typeof o.instanceCount === "number" ? o.instanceCount : 0;
    });
  } catch (_) { /* fail-soft */ }
  return [size(s.terrainBakedLbs), size(W.__landblockLru && W.__landblockLru.entries), sub(s.staticsGroup),
    sub(s.buildingsGroup), sub(s.cellsGroup), bm, inst].join("|");
}
// The quiet clock only runs once most of the PVS ring has baked terrain. 2026-10-22, first
// laptop run: after a long @teleloc hop the first bake landed ~90 s late on SwiftShader, and
// an absent terrainBakedLbs (-1) held still long enough to read as "quiet" — the census then
// counted a 9-of-25 ring. 80% of the ring's in-world LBs leaves room for LBs it never bakes.
// 2026-10-23 (review): count only the TOWN's ring, resident. terrainBakedLbs is global and
// warm-park keeps a parked LB's mark (landblock_lru.js park(): "KEPT deliberately ... baked
// marks"; only evict() drops one), so after the hop to the second town the first town's ~121
// marks met the target on the first poll. And ?slotGrid publishes _pvsEffectiveRingRadius =
// 0 (cells.js: the grid drives the ring), which made the target 0; the grid's window covers
// the residency_grid.js R_LB = 5 ring, so that arm gates on it.
const SLOT_GRID_R_LB = 5;
function ringGate(centreHi) {
  const s = W.liveScene3d;
  const r = s && s._slotGridDrivesRing === true ? SLOT_GRID_R_LB
    : s && Number.isFinite(s._pvsEffectiveRingRadius) ? s._pvsEffectiveRingRadius
      : s && Number.isFinite(s.pvsRingRadius) ? s.pvsRingRadius : 5;
  const cx = (centreHi >>> 8) & 0xff, cy = centreHi & 0xff;
  const span = (c) => Math.min(255, c + r) - Math.max(0, c - r) + 1;
  const target = Math.floor(0.8 * span(cx) * span(cy));
  const tb = s && s.terrainBakedLbs;
  const lru = W.__landblockLru;
  const parked = lru && lru.parkPool && typeof lru.parkPool.has === "function" ? lru.parkPool : null;
  let baked = -1, parkedInRing = 0;
  if (tb && typeof tb[Symbol.iterator] === "function") {
    baked = 0;
    for (const k of tb) {
      // terrain.js keys: (lbX << 24) | (lbY << 16).
      if (Math.max(Math.abs(((k >>> 24) & 0xff) - cx), Math.abs(((k >>> 16) & 0xff) - cy)) > r) continue;
      if (parked && parked.has(k)) { parkedInRing += 1; continue; }
      baked += 1;
    }
  }
  return { radius: r, target, baked, parkedInRing };
}
async function settle(o, centreHi) {
  const t0 = now();
  let last = null, since = now(), polls = 0;
  const fields = "terrainBaked|lruResident|staticsNodes|buildingsNodes|cellsNodes|batchedMeshes|batchedInstances";
  let g = ringGate(centreHi);
  const done = (quiet) => ({ quiet, ms: Math.round(now() - t0), polls, state: last, fields, ringCentre: "0x" + (centreHi & 0xffff).toString(16).padStart(4, "0"),
    ringRadius: g.radius, ringTarget: g.target, bakedInRing: g.baked, parkedInRing: g.parkedInRing });
  while (now() - t0 < o.maxMs) {
    const fp = fingerprint();
    polls += 1;
    g = ringGate(centreHi);
    if (fp !== last || g.baked < g.target) { last = fp; since = now(); }
    else if (now() - since >= o.quietMs) return done(true);
    await sleep(o.pollMs);
  }
  return done(false);
}

/** The portal tunnel right now (portal_space.js publishes both; null = not readable). */
function tunnelNow() {
  let active = null;
  try { active = typeof W.__isPortalSpaceActive === "function" ? W.__isPortalSpaceActive() === true : null; } catch (_) { active = null; }
  return { active, state: W.__portalSpace ? W.__portalSpace.state ?? null : null };
}
/** 2026-10-23 (review): every @teleloc plays the tunnel, same-landblock hops included
 *  (app/client_events.js), and it holds CONTINUE >= 2 s past the landing (portal_space.js
 *  MIN_CONTINUE), then a 1 s fade-out and a 1 s world fade-in, with the app loop paced to
 *  ?portalSpaceFps (30) meanwhile. A dwell started at the landing timed tunnel frames, and
 *  __batchedRuns.frame() kept returning the last world frame. Wait (bounded) for it to end. */
async function waitTunnel(maxMs) {
  const t0 = now();
  let s = tunnelNow();
  while (s.active === true && now() - t0 < maxMs) { await sleep(100); s = tunnelNow(); }
  return { waitedMs: Math.round(now() - t0), ...s };
}

async function teleloc(stop, town) {
  const cmd = telelocCmd(stop);
  const h = W.__sessionHandle;
  if (!h || typeof h.sendChat !== "function") throw new Error("window.__sessionHandle.sendChat missing");
  const t0 = now();
  h.sendChat(cmd);
  let p = null, ok = false;
  // pose.landblockId can lag the teleport (and freeze) while meshes re-stream: wait for the
  // target LB AND the target x/y, then move on regardless — `landedOk` records which.
  while (now() - t0 < OPTS.telelocWaitMs) {
    await sleep(250);
    p = pose();
    if (p && p.lbHi === town.lb && Math.hypot(p.x - stop.x, p.y - stop.y) < 8) { ok = true; break; }
  }
  const waitMs = Math.round(now() - t0);
  // `tunnel.active` still true = it outlived tunnelWaitMs (by design on the laptop).
  const tunnel = await waitTunnel(OPTS.tunnelWaitMs);
  return { cmd, landed: p, landedOk: ok, waitMs, tunnel, src: stop.src };
}

function orbitAround(town) {
  if (!W.__cam || typeof W.__cam.world !== "function" || typeof W.__cam.orbit !== "function") {
    note("camera", "window.__cam missing (needs ?camDebug=on)");
    return null;
  }
  const p = W.__cam.world();
  const o = { x: p.x, y: p.y, z: p.z + town.orbit.dz, dist: town.orbit.dist, az: town.orbit.az, el: town.orbit.el, degPerSec: 12 };
  W.__cam.orbit(o.x, o.y, o.z, o.dist, o.az, o.el);
  // hbsess.mjs `orbit` / `profile` read this; it now names the town that ran last.
  W.__hbOrbit = o;
  return o;
}

const statX = () => (typeof W.__statBatchXStats === "function" ? call("__statBatchXStats", () => W.__statBatchXStats()) : null);
const WALK_KEYS = ["calls", "hitsExact", "hitsSlack", "rebuilds", "rebuildsSlack", "instancesWalked", "instancesSkipped", "slotRestores", "slotEvicts"];
// + the ?batchedRunsSorted and ?batchedRunsStable counters (2026-10-22 flags, P0-FLAGS arms).
const RUN_KEYS = ["draws", "instances", "runs", "rebuilds", "uploads", "noGain", "fallbacks", "errors",
  "sortedDraws", "sortedInstances", "sortedRuns", "sortedNoGain", "stableSkips", "stablePoisons", "stableAuditFails"];
const FRAME_KEYS = ["batchedCalls", "subDraws", "issued", "sortedSubDraws", "sortedIssued"];
function perFrameDelta(a, b, keys, frames) {
  if (!a || !b || !frames) return null;
  const out = {};
  for (const k of keys) if (typeof a[k] === "number" && typeof b[k] === "number") out[k] = +((b[k] - a[k]) / frames).toFixed(2);
  return out;
}

const walkOf = (sx) => (sx && sx.walk ? { ...sx.walk, sphereWalks: sx.walk.sphere?.slotsWalked, sphereBuilt: sx.walk.sphere?.slotsBuilt } : null);
const infoSnap = (info) => ({ calls: info.render.calls, triangles: info.render.triangles, points: info.render.points,
  lines: info.render.lines, frame: info.render.frame });

/** Hold the camera still for n frames and read the per-frame structure of those frames. */
async function hold(n, maxMs) {
  const r = W.liveScene3d && W.liveScene3d.renderer;
  const info = r && r.info;
  const brFrames = [], diagFrames = [];
  let walk0 = null, runs0 = null, c0 = null;
  const prevAuto = info ? info.autoReset : null;
  // Off for the whole hold: with it on, three zeroes the counts at every render() call,
  // so a read sees only the last pass (the post composite) — the 2026-07-01 trap.
  if (info) info.autoReset = false;
  // Draws by owner (2026-10-22, first laptop baseline: renderer.info counted ~1,310 calls a
  // frame at Holtburg against 128 BatchedMesh calls — which groups own the rest?). The tally
  // wraps renderBufferDirect OUTSIDE batched_runs' wrapper for the held frames only; the owner
  // is the object's top-level group under worldRoot / the scene (or the scene's own name for
  // sky / composer / overlay renders), memoised per object.
  const tally = { calls: {}, ranges: {}, byType: {} };
  const ownerMemo = new WeakMap();
  const S = W.liveScene3d;
  const ownerOf = (o, scene) => {
    let g = ownerMemo.get(o);
    if (g !== undefined) return g;
    g = null;
    for (let q = o; q; q = q.parent) {
      if (q.parent && (q.parent === (S && S.worldRoot) || q.parent === (S && S.scene))) { g = q.name || q.type; break; }
    }
    if (g === null) g = `scene:${(scene && (scene.name || scene.type)) || "?"}`;
    ownerMemo.set(o, g);
    return g;
  };
  const rbdOrig = r && r.renderBufferDirect;
  const rbdTally = function (camera, scene, geometry, material, object) {
    try {
      const g = object ? ownerOf(object, scene) : "none";
      tally.calls[g] = (tally.calls[g] || 0) + 1;
      tally.ranges[g] = (tally.ranges[g] || 0) + (object && object.isBatchedMesh ? (object._multiDrawCount | 0) : 1);
      const t = object ? (object.isBatchedMesh ? "BatchedMesh" : object.isInstancedMesh ? "InstancedMesh" : object.type) : "none";
      tally.byType[t] = (tally.byType[t] || 0) + 1;
    } catch (_) { /* the census never breaks a draw */ }
    return rbdOrig.apply(this, arguments);
  };
  let res;
  try {
    res = await eachFrame(n, maxMs, () => {
      if (W.__batchedRuns && typeof W.__batchedRuns.frame === "function") brFrames.push(W.__batchedRuns.frame());
      const d = W.__diag && W.__diag.render;
      if (d) diagFrames.push({ batchedCalls: d.batchedCalls, subDraws: d.subDraws, issuedSubDraws: d.issuedSubDraws, sceneNodes: d.sceneNodes, meshNodes: d.meshNodes });
    }, () => {
      walk0 = walkOf(statX());
      runs0 = W.__batchedRuns && W.__batchedRuns.stats ? { ...W.__batchedRuns.stats } : null;
      if (info) c0 = infoSnap(info);
      if (rbdOrig) r.renderBufferDirect = rbdTally;
    });
  } finally {
    if (info) info.autoReset = prevAuto;
    if (rbdOrig && r.renderBufferDirect === rbdTally) r.renderBufferDirect = rbdOrig;
  }
  const f = Math.max(1, res.frames);
  const out = { framesRequested: n, frames: res.frames, ms: res.ms };
  if (info && c0) {
    const c1 = infoSnap(info);
    // Totals over every render() of the held frames (the composer makes several a frame).
    // A count that went DOWN means something else reset renderer.info mid-hold.
    out.renderInfoPerFrame = c1.frame < c0.frame || c1.calls < c0.calls
      ? { invalid: "renderer.info was reset during the hold by another caller" }
      : {
        calls: +((c1.calls - c0.calls) / f).toFixed(1),
        triangles: Math.round((c1.triangles - c0.triangles) / f),
        points: Math.round((c1.points - c0.points) / f),
        lines: Math.round((c1.lines - c0.lines) / f),
        renderCalls: +((c1.frame - c0.frame) / f).toFixed(2),
      };
  }
  const perF = (m) => Object.fromEntries(Object.entries(m).sort((x, y) => y[1] - x[1]).map(([k, v]) => [k, +(v / f).toFixed(1)]));
  out.drawsPerFrameByOwner = { calls: perF(tally.calls), ranges: perF(tally.ranges), byType: perF(tally.byType) };
  out.batchedRunsFrame = agg(brFrames, FRAME_KEYS);
  out.diagRenderFrames = agg(diagFrames, ["batchedCalls", "subDraws", "issuedSubDraws", "sceneNodes", "meshNodes"]);
  out.walkPerFrame = perFrameDelta(walk0, walkOf(statX()), [...WALK_KEYS, "sphereWalks", "sphereBuilt"], res.frames);
  out.batchedRunsPerFrame = perFrameDelta(runs0, W.__batchedRuns && W.__batchedRuns.stats, RUN_KEYS, res.frames);
  return out;
}

async function census({ lite = false } = {}) {
  const t0 = now();
  const camera = cameraPose();
  let parkedByCensus = false;
  if (W.__cam && typeof W.__cam.park === "function" && W.__cam.parked === false) { call("cam.park", () => W.__cam.park()); parkedByCensus = true; }
  const tunnelBefore = tunnelNow();
  const held = await hold(lite ? OPTS.liteHoldFrames : OPTS.holdFrames, OPTS.holdMaxMs);
  const tunnelAfter = tunnelNow();
  // Two frames with autoReset back on, so __diag.render below is one frame's, not the
  // hold's running total (its calls / triangles are the last pass only either way —
  // renderInfoPerFrame is the frame total).
  if (!lite) await eachFrame(2, OPTS.holdMaxMs, null);
  const { out: scene, bms } = sceneCensus();
  const marks = await markReader(bms);
  const rows = bms.map((o) => bmRow(o, marks.readable ? marks.fn : null));
  const byKind = aggregateKinds(rows);
  const out = { camera, parkedByCensus, hold: held, batched: { byKind, marks: { readable: marks.readable, why: marks.why || null } }, scene };
  // A hold the tunnel ran through counted tunnel frames, not the world (2026-10-22: 27
  // building ranges). Reject such a census; the town's `tunnelHeld` lists them.
  out.tunnel = { before: tunnelBefore, after: tunnelAfter };
  out.tunnelActive = tunnelBefore.active === true || tunnelAfter.active === true;
  const r = W.liveScene3d && W.liveScene3d.renderer;
  out.diagRender = W.__diag && W.__diag.render ? { ...W.__diag.render } : null;
  const br = W.__batchedRuns;
  out.batchedRuns = br ? { enabled: br.enabled, chunks: br.chunks, off: br.off, sortedEnabled: br.sortedEnabled ?? null,
    stableEnabled: br.stableEnabled ?? null, stableBroken: br.stableBroken ?? null,
    stats: { ...br.stats }, frame: call("__batchedRuns.frame", () => br.frame()) } : null;
  out.terrainBakedLbs = W.liveScene3d && W.liveScene3d.terrainBakedLbs ? W.liveScene3d.terrainBakedLbs.size : null;
  out.lru = W.__landblockLru ? { resident: W.__landblockLru.entries?.size ?? null, parked: W.__landblockLru.parkPool?.size ?? null } : null;
  out.memory = r && r.info ? { ...r.info.memory, programs: Array.isArray(r.info.programs) ? r.info.programs.length : null } : null;
  out.summary = summarize(byKind, held);
  if (!lite) {
    const pj = (x) => (x == null ? null : plain(x));
    out.statBatchX = pj(statX());
    out.atlas = typeof W.__atlasStats === "function" ? pj(call("__atlasStats", () => W.__atlasStats())) : null;
    out.pools = W.__diag && typeof W.__diag.pools === "function" ? pj(call("__diag.pools", () => W.__diag.pools())) : null;
    const bb = W.__buildingBatchStats;
    out.buildingBatch = typeof bb === "function" ? pj(call("__buildingBatchStats", () => bb())) : pj(bb);
    // The 2026-10-22 flags' own seams (?staticEarlyOut, ?terrainNoDrawId); their other reads
    // ride the dumps above (statBatchX walk.earlyOut / dedup, atlas geom*, pools runs).
    const eo = W.__staticEarlyOut;
    out.staticEarlyOut = eo && typeof eo.stats === "function" ? pj(call("__staticEarlyOut.stats", () => eo.stats())) : null;
    const tbx = W.__terrainBatch;
    out.terrainBatch = tbx && typeof tbx.stats === "function" ? {
      stats: pj(call("__terrainBatch.stats", () => tbx.stats())),
      verifyIids: typeof tbx.verifyIids === "function" ? pj(call("__terrainBatch.verifyIids", () => tbx.verifyIids())) : null,
    } : null;
    if (out.lru && typeof W.__landblockLru.getStats === "function") out.lru.stats = pj(call("lru.getStats", () => W.__landblockLru.getStats()));
    if (OPTS.detail) out.batched.detail = rows;
  }
  if (parkedByCensus) call("cam.release", () => W.__cam.release());
  out.ms = Math.round(now() - t0);
  return out;
}

/** The handful of numbers the §7 rules and F2 / F4 read, lifted out of the census. */
function summarize(byKind, held) {
  const k = (n) => byKind[n] || null;
  const ch = k("chunk"), at = k("atlas");
  const unsortedSlots = (ch ? ch.unsortedSlots : 0) + (at ? at.unsortedSlots : 0);
  const sortedSlots = (ch ? ch.sortedSlots : 0) + (at ? at.sortedSlots : 0);
  return {
    subDrawsPerFrame: held.batchedRunsFrame?.subDraws?.median ?? held.diagRenderFrames?.subDraws?.median ?? null,
    issuedPerFrame: held.batchedRunsFrame?.issued?.median ?? held.diagRenderFrames?.issuedSubDraws?.median ?? null,
    batchedCallsPerFrame: held.batchedRunsFrame?.batchedCalls?.median ?? null,
    renderInfoCallsPerFrame: held.renderInfoPerFrame?.calls ?? null,
    // F4: the chunk + atlas slots three walks per frame, by which of its two loops walks them.
    f4: { unsortedSlots, sortedSlots, unsortedShare: unsortedSlots + sortedSlots > 0 ? +(unsortedSlots / (unsortedSlots + sortedSlots)).toFixed(3) : null },
    // F2: atlas placements per distinct range (1.0 = every placement its own range). Since
    // 2026-10-22 ?atlasGeomDedup (P1a) is ON in a bare URL: > 1 with census.atlas.geomDedupHits
    // > 0 is the fix working; F2's size is the `&atlasGeomDedup=off` arm (~1.0 there).
    // noRepeatBuckets / drawnBuckets: atlas nodes whose last multidraw repeated no range.
    f2: at ? { visibleInstances: at.visibleInstances, distinctStarts: at.distinctStarts, repeatFactor: at.repeatFactor,
      drawnBuckets: at.lastDrawn, noRepeatBuckets: at.lastNoRepeat } : null,
    // 2026-10-23 (review): batchedRuns' `noGain` counts every marked unsorted draw — chunk,
    // atlas, building and pool buckets alike — so it is not an atlas figure (f2 above is).
    batchedRunsNoGainPerFrame: held.batchedRunsPerFrame ? held.batchedRunsPerFrame.noGain ?? null : null,
    earlyOutEligibleNodes: Object.fromEntries(Object.entries(byKind).map(([n, a]) => [n, a.earlyOutEligible])),
  };
}

async function dwell(ms) {
  const dts = [], br = [];
  let last = null;
  const raf = W.requestAnimationFrame ? W.requestAnimationFrame.bind(W) : (f) => setTimeout(() => f(now()), 16);
  const t0 = now();
  await new Promise((resolve) => {
    const tick = (ts) => {
      const t = typeof ts === "number" ? ts : now();
      if (last !== null) dts.push(t - last);
      last = t;
      if (W.__batchedRuns && typeof W.__batchedRuns.frame === "function") br.push(W.__batchedRuns.frame());
      if (now() - t0 >= ms) { resolve(); return; }
      raf(tick);
    };
    raf(tick);
  });
  return { ms: Math.round(now() - t0), frameMs: frameStats(dts), batchedRunsFrame: agg(br, FRAME_KEYS) };
}

/** End a still-running portal tunnel through the page's own portal_space.js instance. */
async function endTunnel() {
  const before = tunnelNow();
  if (before.active !== true) return { ended: false, before };
  try {
    const url = OPTS.portalSpaceModuleUrl || new URL("scene3d/portal_space.js", W.location.href).href;
    const mod = await import(url);
    mod.endPortalSpace();
  } catch (e) {
    note("endTunnel", e);
    return { ended: false, before, error: String(e && e.message || e) };
  }
  await eachFrame(3, OPTS.holdMaxMs, null);
  return { ended: true, before, after: tunnelNow() };
}

async function runTown(key) {
  const town = TOWNS[key];
  if (!town) throw new Error(`unknown town "${key}" (known: ${Object.keys(TOWNS).join(", ")})`);
  const out = { key, name: town.name, tunnelHeld: [] };
  log(`${town.name}: ${telelocCmd(town.settle)}`);
  out.arrive = await teleloc(town.settle, town);
  await sleep(OPTS.postTeleMs);
  // The ring is the town's (every stop sits in town.lb), not wherever a lagging pose reads.
  out.settle = await settle(OPTS.settle, town.lb);
  log(`${town.name}: settle ${out.settle.quiet ? "quiet" : "NOT quiet"} after ${out.settle.ms} ms (${out.settle.state}; ring ${out.settle.bakedInRing}/${out.settle.ringTarget})`);
  if (OPTS.endTunnelBeforeCensus) out.tunnel = await endTunnel();
  out.pose = pose();
  out.orbit = orbitAround(town);
  out.census = await census();
  if (out.census.tunnelActive) out.tunnelHeld.push("census");
  log(`${town.name}: census subDraws ${out.census.summary.subDrawsPerFrame} issued ${out.census.summary.issuedPerFrame} over ${out.census.hold.frames} frames`);
  if (OPTS.path) {
    out.path = [];
    call("cam.release", () => W.__cam && W.__cam.release && W.__cam.release());
    for (let i = 0; i < town.path.length; i++) {
      const stop = town.path[i];
      const row = { stop: i + 1 };
      try {
        row.tele = await teleloc(stop, town);
        row.dwell = await dwell(OPTS.dwellMs);
        if (OPTS.pathSettle) row.settle = await settle({ ...OPTS.settle, ...OPTS.pathSettle }, town.lb);
        // 2026-10-23 (review): the laptop ends the tunnel before EVERY census, path stops too.
        if (OPTS.endTunnelBeforeCensus) row.tunnelEnd = await endTunnel();
        const c = await census({ lite: true });
        row.camera = c.camera;
        row.hold = c.hold;
        row.byKind = c.batched.byKind;
        row.summary = c.summary;
        row.terrainBakedLbs = c.terrainBakedLbs;
        row.tunnel = c.tunnel;
        row.tunnelActive = c.tunnelActive;
        if (c.tunnelActive) out.tunnelHeld.push(`path ${i + 1}`);
      } catch (e) {
        row.error = String((e && e.message) || e);
      }
      out.path.push(row);
      log(`${town.name}: path stop ${i + 1}/${town.path.length} ${row.tele ? row.tele.cmd : ""} ${row.error ? "ERROR " + row.error : "ok"}`);
    }
    // The last hop is the settle point: park the same orbit again for whatever runs next.
    out.orbitAfterPath = orbitAround(town);
  }
  return out;
}

function env() {
  const r = W.liveScene3d && W.liveScene3d.renderer;
  let gpu = null;
  try {
    const gl = r && r.getContext && r.getContext();
    const ext = gl && gl.getExtension("WEBGL_debug_renderer_info");
    gpu = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null;
  } catch (e) { note("gpu string", e); }
  // 2026-10-23 (review): the frustum, hence per-frame range counts, follows the canvas aspect —
  // the 1070's 1280x720 window gives a 1280x633 canvas (docs/PERF-LOG-1070-2026-10-06.md).
  const cv = r && r.domElement;
  const viewport = { innerWidth: W.innerWidth ?? null, innerHeight: W.innerHeight ?? null, dpr: W.devicePixelRatio ?? null,
    canvas: cv ? [cv.width, cv.height] : null, canvasCss: cv && cv.clientWidth != null ? [cv.clientWidth, cv.clientHeight] : null };
  return {
    url: W.location ? W.location.href : null,
    gpu,
    viewport,
    quality: W.__quality?.preset ?? W.__quality ?? null,
    frameCap: typeof W.__frameCapState === "function" ? call("__frameCapState", () => W.__frameCapState()) : null,
    batchedRunsEnabled: W.__batchedRuns ? W.__batchedRuns.enabled : null,
    bootStates: Array.isArray(W.__bootStateHistory) ? W.__bootStateHistory.map((e) => e && (e.state || e)) : null,
    userAgent: W.navigator ? W.navigator.userAgent : null,
  };
}

async function main() {
  const out = { schema: SCHEMA, startedAt: new Date().toISOString(), opts: OPTS, env: env(), towns: {} };
  if (!W.liveScene3d || !W.liveScene3d.scene) throw new Error("window.liveScene3d not set yet (it lands ~35 s after in-world)");
  for (const key of OPTS.towns) {
    try {
      out.towns[key] = await runTown(key);
    } catch (e) {
      note(`town ${key}`, e);
      out.towns[key] = { key, error: String((e && e.message) || e) };
    }
  }
  out.endedAt = new Date().toISOString();
  out.errors = errors;
  return plain(out);
}

return await main();
