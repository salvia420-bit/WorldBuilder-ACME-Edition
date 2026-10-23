// 2026-10-22 — P0 preparation for the GPU-resident statics work
// (docs/HANDOFF-gpu-resident-statics-2026-10-22.md §7 P0): the page-side STRUCTURE READ
// (scripts/perf-worker/structure-p0.eval.js, run on the 1070 through `hbsess.mjs eval` and
// on the laptop by scripts/perf-worker/laptop-structure-probe.mjs) and the P0 1070 queue
// entry (docs/reengineering/queue-1070/batch-P0-gpu-resident-2026-10-22.json).
//
// Neither the probe nor the read can run here (a browser on a real world is a heavy job),
// so this pins, without a GPU or a page:
//   * the probe's URL contract: the perf-worker boot params + renderDiag + ultra, the arm's
//     flags byte for byte, targetFps=0 once (lib/bench-url.mjs), and the refusals
//     (wireframe / nullRender / renderOnDemand, a base key with another value);
//   * the town tables: every derived @teleloc cell word against the outdoor-cell formula,
//     the settle points against the bench constant and ACE's POI table, no stop near a
//     portal (ACE activates portals on collision);
//   * the read itself, end to end, against a fake page built from REAL three r184
//     BatchedMesh buckets (atlas / chunk sorted + unsorted / building / pool / terrain /
//     per-LB): bucket kinds, distinct range starts, the early-out split, F4 / F2 summaries,
//     batchedRuns marks read through the app's own module instance (and refused for a
//     second instance), renderer.info per-frame totals exact whichever rAF order the app
//     runs in, autoReset restored, settle quiet / not-quiet reported, the fixed path's
//     commands in order, fail-soft with every optional seam missing;
//   * the queue entry: arm URLs exactly as hbsess.mjs builds them, the same @teleloc
//     commands as the read, the §7 rules copied verbatim from the handoff.
// 2026-10-23 (review) adds: the settle ring gate counts the TOWN's ring, resident (a stale
// first-town ring, parked LBs and the slotGrid arm's published radius 0 all failed it open);
// the portal tunnel (waited out after every hop on the 1070, ended before EVERY census on
// the laptop, recorded per census as tunnelHeld); the per-owner draw tally on a pre-wrapped
// renderBufferDirect, restored after the hold; the probe's 1280x633 viewport, per-town
// evaluate with a save after each, derived hard timeout and --eval check; the F2 reads under
// ?atlasGeomDedup default-ON; the P0-FLAGS-2026-10-22 arms and their lite options body.
//
// Run:
//   cd apps/holtburger-web/
//   node tests/structure_p0_probe.test.mjs

import * as THREE from "three";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { markBatchedRuns } from "../scene3d/batched_runs.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(HERE, "..");
const REPO = path.join(APP, "..", "..");
const PERF = path.join(REPO, "scripts", "perf-worker");
const { uncappedBenchUrl } = await import(pathToFileURL(path.join(PERF, "lib", "bench-url.mjs")).href);
const probe = await import(pathToFileURL(path.join(PERF, "laptop-structure-probe.mjs")).href);
const SRC = readFileSync(path.join(PERF, "structure-p0.eval.js"), "utf8");
const BR_URL = pathToFileURL(path.join(APP, "scene3d", "batched_runs.js")).href;
const AsyncFunction = (async () => {}).constructor;

let failed = 0, passed = 0;
function check(name, ok, detail) {
  console.log(`  [${ok ? "OK" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
  ok ? passed++ : failed++;
}
const throws = (f) => { try { f(); return false; } catch (_) { return true; } };

// --- the probe's URL contract ----------------------------------------------------------
console.log("\n— laptop-structure-probe.mjs: URL, flags, args");
{
  const u = probe.buildProbeUrl({});
  check("default URL: perf-worker boot params + agent + renderDiag + ultra, bot account, in this order",
    u === "http://127.0.0.1:8765/apps/holtburger-web/index.html?autoLogin=1&account=agentp10&password=agentp10&autoSpawn=first&agent=1&nosw=1&camDebug=on&adaptiveRes=off&renderDiag=on&quality=ultra", u);
  const final = uncappedBenchUrl(u);
  check("targetFps=0 appended once, last", final.endsWith("&targetFps=0") && final.split("targetFps").length === 2, final.slice(-40));
  check("never wireframe / nullRender / renderOnDemand in the default URL", !/wireframe|nullRender|renderOnDemand/.test(u));
  const chain = "packSource=on&geomBundles=on&texCompressedOnly=on&slotGrid=on&frameWork=on&drawPools=on&negFace=off";
  check("arm flags appended byte for byte (leading & tolerated)", probe.buildProbeUrl({ flags: "&" + chain }).endsWith("&quality=ultra&" + chain));
  for (const k of probe.REFUSED_FLAGS) check(`refuses --flags ${k}=1`, throws(() => probe.buildProbeUrl({ flags: `${k}=1` })));
  check("refuses a base key with another value (quality=low)", throws(() => probe.buildProbeUrl({ flags: "quality=low" })));
  check("drops a base key repeated with the same value (nosw=1)", probe.buildProbeUrl({ flags: "nosw=1&batchedRuns=off" }).endsWith("&quality=ultra&batchedRuns=off"));
  check("--account sets the password too unless --password", probe.buildProbeUrl({ account: "agentp07" }).includes("account=agentp07&password=agentp07"));
  check("normalizeFlags keeps an explicit targetFps (an arm that benches a cap)", probe.normalizeFlags("targetFps=30", {}) === "targetFps=30");

  const a = probe.parseArgs(["--town", "both", "--label", "x y", "--path", "--flags", "batchedRuns=off"]);
  check("parseArgs: --town both -> holtburg then linvak", JSON.stringify(a.towns) === '["holtburg","linvak"]');
  check("parseArgs: defaults (ultra, agentp10, 20 s quiet, 420 s cap, 6 frames)", a.quality === "ultra" && a.account === "agentp10" && a.quietSec === 20 && a.settleMaxSec === 420 && a.holdFrames === 6);
  check("parseArgs: --path switch, label sanitized, flags kept", a.path === true && a.label === "x_y" && a.flags === "batchedRuns=off");
  check("parseArgs: --town=linvak form", JSON.stringify(probe.parseArgs(["--town=linvak"]).towns) === '["linvak"]');
  check("parseArgs: unknown town refused", throws(() => probe.parseArgs(["--town", "nanto"])));
  const o = probe.laptopEvalOpts(a);
  check("laptopEvalOpts: seconds -> ms, path settle capped at 15 s quiet", o.settle.quietMs === 20000 && o.settle.maxMs === 420000 && o.pathSettle.quietMs === 15000 && o.path === true && o.towns.length === 2);
  check("laptopEvalOpts: no tunnel wait, the tunnel ended before each census", o.tunnelWaitMs === 0 && o.endTunnelBeforeCensus === true);
  // The 1070's 1280x720 window leaves a 1280x633 page (PERF-LOG-1070-2026-10-06.md).
  check("viewport = the 1070 page (1280x633, aspect 2.02)", probe.VIEWPORT.width === 1280 && probe.VIEWPORT.height === 633);
  const perfLog = readFileSync(path.join(APP, "docs", "PERF-LOG-1070-2026-10-06.md"), "utf8");
  check("…as the 1070 perf log records its canvas", perfLog.includes(`${probe.VIEWPORT.width}x${probe.VIEWPORT.height} canvas`));
  // Hard timeout: the worst case the options allow, not a fixed 30 min.
  const both = probe.parseArgs(["--town", "both"]);
  const oo = probe.laptopEvalOpts(both);
  const townMs = oo.telelocWaitMs + oo.tunnelWaitMs + oo.postTeleMs + oo.settle.maxMs + 3 * oo.holdMaxMs;
  const bootMs = 90000 + both.bootTimeoutSec * 1000 + both.loginRetries * 69000;
  check("default --timeout-min = boot + both towns' worst case, + 5 (> the old 30)", both.timeoutMin === Math.ceil((bootMs + 2 * townMs) / 60000) + 5 && both.timeoutMin > 46, String(both.timeoutMin));
  const withPath = probe.parseArgs(["--town", "both", "--path"]);
  check("…--path raises it by 4 stops per town", withPath.timeoutMin > both.timeoutMin + 90, String(withPath.timeoutMin));
  check("…an explicit --timeout-min wins", probe.parseArgs(["--timeout-min", "30"]).timeoutMin === 30);
  check("--eval without a path refused at parse time", throws(() => probe.parseArgs(["--eval"])) && throws(() => probe.parseArgs(["--eval", "--town", "both"])));
  check("--eval naming a missing file refused at parse time", throws(() => probe.parseArgs(["--eval", "/nonexistent/x.eval.js"])));
  check("--eval naming a real file resolves it", probe.parseArgs(["--eval", probe.EVAL_FILE]).evalFile === probe.EVAL_FILE);
  check("inBuildsCgroup: capped-build's cgroup", probe.inBuildsCgroup("0::/dev/builds\n") === true);
  check("inBuildsCgroup: a session scope is not capped", probe.inBuildsCgroup("0::/user.slice/user-1000.slice/session-c39.scope\n") === false);
  check("inBuildsCgroup: unknown without /proc", probe.inBuildsCgroup(null) === null);
  check("the probe evaluates the shared read file", probe.EVAL_FILE === path.join(PERF, "structure-p0.eval.js"));
}
{
  // One evaluate per town, saved after each: a renderer crash in the second town keeps the
  // first town's finished census in the out file (the single evaluate lost both).
  const result = { towns: {}, errors: [] };
  const saved = [];
  const rowOf = (key) => ({ schema: "hb-structure-p0-v1", startedAt: "t0", opts: { towns: [key], holdFrames: 6 }, env: { gpu: "SwiftShader" },
    towns: { [key]: { key, settle: { quiet: true }, tunnelHeld: [] } }, errors: ["cam.info: x"], endedAt: "t1" });
  let threw = null;
  try {
    await probe.evalTownByTown(["holtburg", "linvak"], async (key) => {
      if (key === "linvak") throw new Error("renderer crashed (PAGE CRASH)");
      return rowOf(key);
    }, result, () => saved.push(JSON.stringify(result)));
  } catch (e) { threw = e; }
  check("evalTownByTown: a crash in town 2 propagates", threw && /PAGE CRASH/.test(threw.message));
  check("…after town 1 was saved (out file holds Holtburg)", saved.length === 1 && JSON.parse(saved[0]).towns.holtburg.settle.quiet === true && !result.towns.linvak);
  check("…with the run's header from the first evaluate, all towns in opts, errors keyed by town",
    result.schema === "hb-structure-p0-v1" && JSON.stringify(result.opts.towns) === '["holtburg","linvak"]' && result.opts.holdFrames === 6 && result.errors[0] === "holtburg: cam.info: x");
  const full = { towns: {}, errors: [] };
  await probe.evalTownByTown(["holtburg", "linvak"], async (key) => rowOf(key), full, () => {});
  check("evalTownByTown: both towns merged", full.towns.holtburg && full.towns.linvak && full.errors.length === 2);
  const odd = { towns: {}, errors: [] };
  await probe.evalTownByTown(["holtburg"], async () => ({ something: 1 }), odd, () => {});
  check("…a body that returns no town row is recorded as an error, not dropped", /no row/.test(odd.towns.holtburg.error) && odd.towns.holtburg.raw.something === 1);
  const pr = probe.townProblems({ towns: { holtburg: { key: "holtburg", settle: { quiet: true }, tunnelHeld: ["census", "path 2"] }, linvak: { key: "linvak", settle: { quiet: false }, tunnelHeld: [] } } });
  check("townProblems: unsettled and tunnel-held towns flagged (exit 3)", JSON.stringify(pr.unsettledOrFailed) === '["linvak"]' && pr.tunnelHeld[0] === "holtburg: census, path 2");
}

// --- the town tables -------------------------------------------------------------------
console.log("\n— structure-p0.eval.js: town tables");
globalThis.__structureP0Opts = { tablesOnly: true };
const TABLES = await new AsyncFunction(SRC)();
delete globalThis.__structureP0Opts;
{
  check("tablesOnly returns the schema and both towns", TABLES.schema === "hb-structure-p0-v1" && TABLES.towns.holtburg && TABLES.towns.linvak);
  const outdoorCell = (lb, x, y) => ((lb << 16) | (Math.floor(x / 24) * 8 + Math.floor(y / 24) + 1)) >>> 0;
  for (const [k, t] of Object.entries(TABLES.towns)) {
    const stops = [t.settle, ...t.path];
    check(`${k}: every stop is in the town's landblock`, stops.every((s) => (s.cell >>> 16) === t.lb));
    // Every stop but the bench point, whose cell word (0x0001 at x/y 96,96) is the one the
    // drivers have always sent and ACE has always accepted.
    const formal = stops.filter((s) => s.cell !== 0xa9b40001);
    check(`${k}: every other stop carries the outdoor cell of its x/y`, formal.length >= 3 && formal.every((s) => s.cell === outdoorCell(t.lb, s.x, s.y)),
      formal.map((s) => s.cell.toString(16)).join(","));
    check(`${k}: the path ends back on the settle point`, JSON.stringify([t.path.at(-1).cell, t.path.at(-1).x, t.path.at(-1).y, t.path.at(-1).z]) === JSON.stringify([t.settle.cell, t.settle.x, t.settle.y, t.settle.z]));
    check(`${k}: one command per stop`, t.pathCmds.length === t.path.length && t.settleCmd.startsWith("@teleloc 0x"));
    check(`${k}: the probe's timeout budget counts this town's ${t.path.length} stops`, t.path.length === probe.PATH_STOPS);
  }
  check("tablesOnly defaults: the 1070 waits out the tunnel (15 s) after every hop", TABLES.defaults.tunnelWaitMs === 15000 && TABLES.defaults.endTunnelBeforeCensus === false);
  // The ACE-side cell ids the NPC stops were read from (ace_world landblock_instance, 2026-10-22).
  check("Dwennon's / Royal Guard's / Neelic's / Kresovus' cells", ["A9B4001E", "A9B4003D", "A21E0026", "A21E001C"].every((c) =>
    [...TABLES.towns.holtburg.pathCmds, ...TABLES.towns.linvak.pathCmds].some((cmd) => cmd.includes("0x" + c))));
  const hbsess = readFileSync(path.join(PERF, "hbsess.mjs"), "utf8");
  check("Holtburg settle = the HOLT bench point hbsess.mjs boots to", hbsess.includes('const HOLT = ["0xA9B40001", 96, 96, 80];') && TABLES.towns.holtburg.settleCmd === "@teleloc 0xA9B40001 96 96 80");
  const pois = JSON.parse(readFileSync(path.join(REPO, "scripts", "net-review", "poi-destinations.json"), "utf8"));
  const poi = (n) => pois.find((p) => p.name === n);
  const lv = poi("Linvak Tukal"), hb = poi("Holtburg");
  check("Linvak settle = ACE's POI destination", TABLES.towns.linvak.settleCmd === `@teleloc ${lv.cellHex} ${lv.x} ${lv.y} ${lv.z}`, TABLES.towns.linvak.settleCmd);
  check("Holtburg's first hop = ACE's POI destination (@telepoi Holtburg)", TABLES.towns.holtburg.pathCmds[0] === `@teleloc ${hb.cellHex} ${hb.x} ${hb.y} ${hb.z}`);
  // Portals in reach of a stop would fire on collision. LB-local positions from
  // docs/film-projects/dereth-town-tour/research/town-{holtburg,linvak-tukal}.json.
  const portals = { holtburg: [[14.4, 55.6], [27.3, 137.5]], linvak: [[111.7, 84.1]] };
  for (const [k, list] of Object.entries(portals)) {
    const t = TABLES.towns[k];
    const near = Math.min(...[t.settle, ...t.path].flatMap((s) => list.map(([x, y]) => Math.hypot(s.x - x, s.y - y))));
    check(`${k}: no stop within 10 m of a portal`, near > 10, `nearest ${near.toFixed(1)} m`);
  }
}

// --- the read, end to end, on a fake page -------------------------------------------------
console.log("\n— structure-p0.eval.js: the read on a fake page (real three BatchedMesh buckets)");

// tunnelMs: how long the portal tunnel runs after each @teleloc (Infinity: it never ends by
// itself, the SwiftShader case). Wall time, so it outlasts teleloc's 250 ms landing poll.
function makePage({ appFirst = true, streamForever = false, seams = true, tunnelMs = 0 } = {}) {
  const scene = new THREE.Scene();
  const root = new THREE.Group();
  scene.add(root);
  const groups = { staticsGroup: new THREE.Group(), buildingsGroup: new THREE.Group(), cellsGroup: new THREE.Group(), terrainGroup: new THREE.Group(), entitiesGroup: new THREE.Group() };
  for (const [k, g] of Object.entries(groups)) { g.name = k.replace(/Group$/, ""); root.add(g); }
  const sky = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
  sky.name = "sky";
  scene.add(sky);
  const opaque = new THREE.MeshBasicMaterial();
  const geo = [new THREE.BoxGeometry(1, 1, 1), new THREE.SphereGeometry(0.5, 8, 6), new THREE.ConeGeometry(0.5, 1, 8), new THREE.TorusGeometry(0.5, 0.2, 6, 8)];
  const m4 = new THREE.Matrix4();
  function bucket(userData, { geoms, placements, sorted = false, perObj = true, frustum = true, mark = false, transparent = false, name = "", cap = 64 }) {
    const bm = new THREE.BatchedMesh(cap, 8192, 16384, transparent ? new THREE.MeshBasicMaterial({ transparent: true }) : opaque);
    const gids = geoms.map((g) => bm.addGeometry(geo[g]));
    for (const p of placements) bm.setMatrixAt(bm.addInstance(gids[p]), m4);
    bm.sortObjects = sorted;
    bm.perObjectFrustumCulled = perObj;
    bm.frustumCulled = frustum;
    bm.userData = userData;
    bm.name = name;
    if (mark) markBatchedRuns(bm);
    return bm;
  }
  // atlas: every placement its own geometry (F2's shape) — 4 placements, 4 ranges; its last
  // multidraw repeated none (batchedRuns' noGain shape).
  const atlas = bucket({ __statAtlasCrossLb: true }, { geoms: [0, 1, 2, 3], placements: [0, 1, 2, 3], frustum: false, mark: true, name: "stat-atlas-x-k" });
  atlas._multiDrawCount = 4;
  for (let k = 0; k < 4; k++) atlas._multiDrawStarts[k] = k * 144;
  // unsorted chunk: 6 placements over 2 models, one hidden; last multidraw 3 ranges / 2 starts.
  const chunkU = bucket({ __staticBatchCrossLb: true }, { geoms: [0, 1], placements: [0, 0, 0, 1, 1, 1], mark: true, name: "static-batch-c-r1-s00000001-m1" });
  chunkU.setVisibleAt(5, false);
  chunkU._multiDrawCount = 3;
  chunkU._multiDrawStarts[0] = 0; chunkU._multiDrawStarts[1] = 0; chunkU._multiDrawStarts[2] = 144;
  const chunkS = bucket({ __staticBatchCrossLb: true }, { geoms: [0], placements: [0, 0], sorted: true, mark: true, transparent: true, name: "static-batch-c-r1-s00000002-m2" });
  const building = bucket({ __buildingBatch: true, landblockId: 0xa9b4ffff }, { geoms: [0], placements: [0, 0] });
  const pool = bucket({ __drawPool: true, passClass: "opaque" }, { geoms: [0, 1], placements: [0, 1, 0, 1], perObj: false });
  const terrain = bucket({ __terrainBatchMesh: true }, { geoms: [0], placements: [0, 0, 0], frustum: false, name: "terrain-batch-x" });
  // A per-LB batch the fake "streaming" feeds after each teleport.
  const lbStatic = bucket({ __staticBatch: true, landblockId: 1 }, { geoms: [0], placements: [0], cap: 128 });
  groups.staticsGroup.add(atlas, chunkU, chunkS, pool, lbStatic, new THREE.Mesh(geo[0], opaque));
  groups.buildingsGroup.add(building);
  groups.terrainGroup.add(terrain);

  const info = { autoReset: true, render: { calls: 0, triangles: 0, points: 0, lines: 0, frame: 0 }, memory: { geometries: 7, textures: 3 }, programs: [1, 2],
    reset() { this.render.calls = 0; this.render.triangles = 0; this.render.points = 0; this.render.lines = 0; } };
  const rbd = { drawn: 0 };
  const renderer = { info, getContext: () => null, domElement: { width: 1280, height: 633, clientWidth: 1280, clientHeight: 633 } };
  renderer.renderBufferDirect = function () { rbd.drawn += 1; };
  // batched_runs installs its own wrapper first; the hold's tally wraps OUTSIDE it and must
  // put exactly that wrapper back.
  const rbdInner = renderer.renderBufferDirect;
  renderer.renderBufferDirect = function (...args) { return rbdInner.apply(this, args); };
  rbd.wrap = renderer.renderBufferDirect;
  // pvsRingRadius 0: the settle ring target is floor(0.8 * 1) = 0, so the 3 baked LBs suffice
  // (the ring gate itself is checked separately below).
  const live = { scene, worldRoot: root, renderer, ...groups, pvsRingRadius: 0, terrainBakedLbs: new Set([1, 2, 3]), camera: new THREE.PerspectiveCamera(60, 1280 / 633, 0.1, 1000) };
  const st = { pose: { landblockId: 0x12340001, x: 10, y: 10, z: 5 }, chat: [], pending: 0, freed: 0, baked: 100, orbits: [] };
  const tun = { until: 0, ends: 0, active: () => performance.now() < tun.until };
  const brStats = { draws: 0, instances: 0, runs: 0, rebuilds: 0, uploads: 0, noGain: 0, fallbacks: 0, errors: 0,
    sortedDraws: 0, sortedInstances: 0, sortedRuns: 0, sortedNoGain: 0, stableSkips: 0, stablePoisons: 0, stableAuditFails: 0 };
  const walk = { calls: 0, hitsExact: 0, hitsSlack: 0, rebuilds: 0, rebuildsSlack: 0, instancesWalked: 0, instancesSkipped: 0, slotRestores: 0, slotEvicts: 0, sphere: { slotsWalked: 0, slotsBuilt: 0 } };
  const win = {
    location: { href: "http://127.0.0.1:8765/apps/holtburger-web/index.html?nosw=1" },
    innerWidth: 1280, innerHeight: 633, devicePixelRatio: 1,
    liveScene3d: live,
    __bootStateHistory: [{ state: "ready" }, { state: "in-world" }],
    __sessionHandle: {
      sendChat(cmd) {
        st.chat.push(cmd);
        const m = /^@teleloc 0x([0-9A-F]{8}) (\S+) (\S+) (\S+)$/.exec(cmd);
        // Every hop plays the tunnel, same-landblock hops included (app/client_events.js).
        if (m) { st.pose = { landblockId: parseInt(m[1], 16) >>> 0, x: +m[2], y: +m[3], z: +m[4] }; st.pending = 3; if (tunnelMs > 0) tun.until = performance.now() + tunnelMs; }
      },
      getLocalPlayerPose() { return { ...st.pose, free() { st.freed += 1; } }; },
    },
    __diag: { render: null },
  };
  win.__cam = {
    parked: false,
    world() { const lb = st.pose.landblockId >>> 0; return { x: ((lb >>> 24) & 0xff) * 192 + st.pose.x, y: ((lb >>> 16) & 0xff) * 192 + st.pose.y, z: st.pose.z }; },
    orbit(x, y, z, dist, az, el) { this.parked = true; st.orbits.push({ x, y, z, dist, az, el }); return this.info(); },
    park() { this.parked = true; return true; },
    release() { this.parked = false; return false; },
    info() { return { pos: [1, 2, 3], fov: 60, parked: this.parked }; },
  };
  if (seams) {
    // subDraws 999 marks a frame sampled while the tunnel ran (the real frame() then returns
    // the last WORLD frame, which no read could tell apart).
    win.__batchedRuns = { enabled: true, chunks: true, off: false, sortedEnabled: true, stableEnabled: false, stableBroken: false, stats: brStats,
      frame: () => ({ batchedCalls: 6, subDraws: tun.active() ? 999 : 20, issued: 9, sortedSubDraws: 4, sortedIssued: 2 }) };
    win.__isPortalSpaceActive = () => tun.active();
    win.__portalSpace = { get state() { return tun.active() ? 4 : 0; } };
    win.__fakeEndTunnel = () => { tun.until = 0; tun.ends += 1; };
    win.__staticEarlyOut = { enabled: false, stats: () => ({ applied: 0, reverted: 0, external: 0, off: false }) };
    win.__terrainBatch = { stats: () => ({ enabled: true, noDrawId: false, noDrawIdFallback: null, iidWriteFails: 0 }),
      verifyIids: () => ({ enabled: false, rows: 9, checked: 0, bad: 0, slotNeIid: 0 }) };
    win.__statBatchXStats = () => ({ buckets: 2, instances: 8, detail: [{ name: "u", sorted: false, slots: 6 }, { name: "s", sorted: true, slots: 2 }], walk: JSON.parse(JSON.stringify(walk)) });
    win.__atlasStats = () => {
      // A shared row reached twice (a DAG, kept both times), a real cycle (cut), a Map.
      const shared = { w: 256, h: 256 };
      const o = { bucketCount: 1, atlased: 4, layerHits: 2, buckets: [{ key: "k", dims: shared }, { key: "j", dims: shared }], byKey: new Map([[7, { n: 1 }]]) };
      o.self = o;
      return o;
    };
    win.__diag.pools = () => ({ enabled: false });
    win.__landblockLru = { entries: new Map([[0xa9b4, {}]]), parkPool: new Set(), getStats: () => ({ resident: 1 }) };
    win.__buildingBatchStats = () => ({ batches: 1 });
    win.__frameCapState = () => ({ fps: 0 });
  }
  // One app frame: three passes; three bumps `frame` and resets the counts per render()
  // while autoReset is on (WebGLRenderer.render), then recordRenderDiag publishes.
  function appFrame() {
    for (const [c, t] of [[50, 3000], [30, 1500], [20, 500]]) {
      info.render.frame += 1;
      if (info.autoReset) info.reset();
      info.render.calls += c;
      info.render.triangles += t;
    }
    brStats.draws += 2; brStats.instances += 20; brStats.runs += 9; brStats.noGain += 1; brStats.sortedDraws += 1; brStats.stableSkips += 2;
    walk.calls += 4; walk.instancesWalked += 10; walk.sphere.slotsWalked += 8;
    win.__diag.render = { calls: info.render.calls, triangles: info.render.triangles, batchedCalls: 6, subDraws: 20, issuedSubDraws: 9, sceneNodes: 40, meshNodes: 9 };
    // The draws themselves: the chunk bucket twice (colour + shadow), the sky once.
    renderer.renderBufferDirect(live.camera, scene, null, null, chunkU);
    renderer.renderBufferDirect(live.camera, scene, null, null, chunkU);
    renderer.renderBufferDirect(live.camera, scene, null, null, sky);
    if (st.pending > 0) { st.pending -= 1; lbStatic.setMatrixAt(lbStatic.addInstance(0), m4); }
    if (streamForever) live.terrainBakedLbs.add(st.baked++);
  }
  // rAF with browser semantics: a microtask checkpoint after every callback, so a hold
  // that resolves in its last callback reads BEFORE an app that renders after it.
  const queue = [];
  win.requestAnimationFrame = (cb) => { queue.push(cb); return queue.length; };
  const boundary = () => new Promise((r) => setImmediate(r));
  let running = true;
  (async () => {
    while (running) {
      await new Promise((r) => setTimeout(r, 1));
      const cbs = queue.splice(0);
      const ts = performance.now();
      if (appFirst) { appFrame(); await boundary(); }
      for (const cb of cbs) { cb(ts); await boundary(); }
      if (!appFirst) appFrame();
    }
  })();
  return { win, st, info, renderer, rbd, tun, live, stop: () => { running = false; } };
}
// The page's portal_space.js instance, stood in by a module whose endPortalSpace ends the
// fake page's tunnel (endTunnel imports it by OPTS.portalSpaceModuleUrl).
const PORTAL_STUB_URL = "data:text/javascript," + encodeURIComponent("export function endPortalSpace() { globalThis.window.__fakeEndTunnel(); }");
/** LB keys (terrain.js: (x << 24) | (y << 16)) of the (2r+1)^2 ring around lbHi. */
function ringKeys(lbHi, r) {
  const cx = (lbHi >> 8) & 0xff, cy = lbHi & 0xff, out = [];
  for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) out.push((((cx + dx) << 24) | ((cy + dy) << 16)) >>> 0);
  return out;
}

async function runRead(page, opts) {
  globalThis.window = page.win;
  page.win.__structureP0Opts = opts;
  try { return await new AsyncFunction(SRC)(); } finally { page.stop(); delete globalThis.window; }
}
const FAST = { settle: { quietMs: 30, maxMs: 3000, pollMs: 5 }, postTeleMs: 0, telelocWaitMs: 2000, holdFrames: 5, holdMaxMs: 5000, dwellMs: 15, liteHoldFrames: 2, batchedRunsModuleUrl: BR_URL };

let MAIN_CENSUS = null; // the full census the queue's reads are checked against (below)
{
  const page = makePage({ appFirst: true });
  const r = await runRead(page, { ...FAST, towns: ["holtburg", "linvak"], path: true, detail: true });
  const H = r.towns.holtburg, L = r.towns.linvak;
  MAIN_CENSUS = H.census;
  check("returns the schema, both towns, no errors", r.schema === "hb-structure-p0-v1" && H && L && r.errors.length === 0, JSON.stringify(r.errors));
  check("result is plain JSON", JSON.stringify(JSON.parse(JSON.stringify(r))) === JSON.stringify(r));
  const want = [TABLES.towns.holtburg.settleCmd, ...TABLES.towns.holtburg.pathCmds, TABLES.towns.linvak.settleCmd, ...TABLES.towns.linvak.pathCmds];
  check("@teleloc commands: settle then the fixed path, Holtburg then Linvak", JSON.stringify(page.st.chat) === JSON.stringify(want), page.st.chat.join(" | "));
  check("every landing recognised (target LB + x/y)", H.arrive.landedOk && L.arrive.landedOk && [...H.path, ...L.path].every((p) => p.tele.landedOk));
  check("settle: quiet after the streamed instances stopped", H.settle.quiet === true && L.settle.quiet === true, JSON.stringify(H.settle));
  check("the wasm pose boxes are freed after every read", page.st.freed > 10);
  check("orbit: Holtburg dist 70 az 45 el 22 around pose z + 1.5", H.orbit.dist === 70 && H.orbit.az === 45 && H.orbit.el === 22 && H.orbit.z === 80 + 1.5);
  check("window.__hbOrbit left on the last town (Linvak, dist 110) for hbsess orbit/profile", page.win.__hbOrbit.dist === 110 && page.win.__cam.parked === true);

  const k = H.census.batched.byKind;
  check("kinds: atlas / chunk / building / pool / terrain / lbStatic", ["atlas", "chunk", "building", "pool", "terrain", "lbStatic"].every((n) => k[n]) && !k.other, Object.keys(k).join(","));
  check("atlas: 4 visible placements over 4 distinct ranges -> repeatFactor 1 (F2 shape)", k.atlas.visibleInstances === 4 && k.atlas.distinctStarts === 4 && k.atlas.repeatFactor === 1);
  check("atlas: unsorted, per-instance culled, node never culled", k.atlas.unsorted === 1 && k.atlas.perObjCulledOn === 1 && k.atlas.frustumCulledOff === 1 && k.atlas.earlyOutEligible === 0);
  check("chunk: 1 sorted + 1 unsorted; slots split 6 / 2", k.chunk.sorted === 1 && k.chunk.unsorted === 1 && k.chunk.unsortedSlots === 6 && k.chunk.sortedSlots === 2);
  check("chunk: hidden instance excluded (7 visible of 8), 3 distinct starts", k.chunk.instances === 8 && k.chunk.visibleInstances === 7 && k.chunk.distinctStarts === 3);
  check("chunk: last multidraw 3 ranges over 2 starts", k.chunk.lastDraw === 3 && k.chunk.lastDistinctStarts === 2);
  check("pool: opaque early-out pair -> earlyOut-eligible", k.pool.earlyOutEligible === 1 && k.pool.perObjCulledOff === 1 && k.pool.repeatFactor === 2);
  check("batchedRuns marks read through the app's module instance: atlas 1, chunk 2, building 0", H.census.batched.marks.readable === true && k.atlas.marked === 1 && k.chunk.marked === 2 && k.building.marked === 0);
  const s = H.census.summary;
  check("F4 summary: chunk + atlas unsorted slots 10 of 12", s.f4.unsortedSlots === 10 && s.f4.sortedSlots === 2 && s.f4.unsortedShare === 0.833, JSON.stringify(s.f4));
  check("F2 summary: atlas repeat 1, its one drawn bucket repeated no range (from the atlas rows)",
    s.f2.repeatFactor === 1 && s.f2.drawnBuckets === 1 && s.f2.noRepeatBuckets === 1 && !("noGainPerFrame" in s.f2), JSON.stringify(s.f2));
  check("…batchedRuns' all-kinds noGain is its own summary key (1 per frame), not under f2", s.batchedRunsNoGainPerFrame === 1);
  check("…a chunk whose last multidraw repeated a range is not noRepeat", k.chunk.lastDrawn === 1 && k.chunk.lastNoRepeat === 0);
  check("ranges per frame from __batchedRuns.frame(): subDraws 20, issued 9, calls 6", s.subDrawsPerFrame === 20 && s.issuedPerFrame === 9 && s.batchedCallsPerFrame === 6);
  const hold = H.census.hold;
  check("hold: 5 frames, renderer.info totals exact per frame (100 calls, 5000 tris, 3 passes)", hold.frames === 5 && hold.renderInfoPerFrame.calls === 100 && hold.renderInfoPerFrame.triangles === 5000 && hold.renderInfoPerFrame.renderCalls === 3, JSON.stringify(hold.renderInfoPerFrame));
  check("autoReset restored after the hold", page.info.autoReset === true);
  check("__diag.render read after autoReset came back (last pass, not the hold's running total)", H.census.diagRender.calls === 20, String(H.census.diagRender.calls));
  check("walk counters as per-frame deltas (calls 4, walked 10, sphere 8)", hold.walkPerFrame.calls === 4 && hold.walkPerFrame.instancesWalked === 10 && hold.walkPerFrame.sphereWalks === 8, JSON.stringify(hold.walkPerFrame));
  check("batchedRuns stats as per-frame deltas (draws 2, runs 9)", hold.batchedRunsPerFrame.draws === 2 && hold.batchedRunsPerFrame.runs === 9);
  check("…+ the ?batchedRunsSorted / ?batchedRunsStable counters (sortedDraws 1, stableSkips 2)", hold.batchedRunsPerFrame.sortedDraws === 1 && hold.batchedRunsPerFrame.stableSkips === 2 && hold.batchedRunsPerFrame.stableAuditFails === 0);
  check("…and frame()'s sorted pair (sortedSubDraws 4, sortedIssued 2)", hold.batchedRunsFrame.sortedSubDraws.median === 4 && hold.batchedRunsFrame.sortedIssued.median === 2);
  const byOwner = hold.drawsPerFrameByOwner;
  check("draw tally per frame by owner: statics 2 calls / 6 ranges, sky 1", JSON.stringify(byOwner.calls) === '{"statics":2,"sky":1}' && byOwner.ranges.statics === 6 && byOwner.ranges.sky === 1, JSON.stringify(byOwner));
  check("…by type: BatchedMesh 2, Mesh 1", byOwner.byType.BatchedMesh === 2 && byOwner.byType.Mesh === 1);
  check("…the tally passed every draw through and put batched_runs' wrapper back", page.renderer.renderBufferDirect === page.rbd.wrap && page.rbd.drawn > 0);
  check("census: batchedRuns sorted / stable state", H.census.batchedRuns.sortedEnabled === true && H.census.batchedRuns.stableEnabled === false && H.census.batchedRuns.stableBroken === false);
  check("census: ?staticEarlyOut and ?terrainNoDrawId seams dumped", H.census.staticEarlyOut.applied === 0 && H.census.terrainBatch.stats.enabled === true && H.census.terrainBatch.verifyIids.rows === 9);
  check("env.viewport: page and canvas size (aspect = the frustum)", r.env.viewport.innerHeight === 633 && JSON.stringify(r.env.viewport.canvas) === "[1280,633]" && H.census.camera.three.aspect === +(1280 / 633).toFixed(4));
  check("no tunnel: every census held on world frames, tunnelHeld empty", H.census.tunnelActive === false && H.census.tunnel.before.active === false && H.tunnelHeld.length === 0 && L.tunnelHeld.length === 0 && H.arrive.tunnel.active === false);
  check("settle: ring centred on the town's LB", H.settle.ringCentre === "0xa9b4" && L.settle.ringCentre === "0xa21e" && H.settle.ringRadius === 0);
  check("seam dumps present: statBatchX detail, atlas, pools, LRU, building batch", H.census.statBatchX.detail.length === 2 && H.census.atlas.bucketCount === 1 && H.census.pools.enabled === false && H.census.lru.resident === 1 && H.census.lru.stats.resident === 1 && H.census.buildingBatch.batches === 1);
  const at = H.census.atlas;
  check("seam dumps: a shared row copied twice, a cycle cut, a Map flattened",
    at.buckets[0].dims.w === 256 && at.buckets[1].dims.w === 256 && at.self === "[cycle]" && at.byKey["7"].n === 1, JSON.stringify(at).slice(0, 160));
  check("scene census: groups and BatchedMesh count", H.census.scene.byType.BatchedMesh === 7 && H.census.scene.groups.statics >= 7 && H.census.scene.groups.terrain === 2);
  check("--detail rows: one per BatchedMesh", H.census.batched.detail.length === 7 && H.census.batched.detail.some((d) => d.name === "terrain-batch-x" && d.kind === "terrain"));
  check("path: 4 stops per town, each with frame stats and a lite census", H.path.length === 4 && L.path.length === 4 && [...H.path, ...L.path].every((p) => p.dwell && p.dwell.frameMs && p.summary && p.byKind && !p.error));
  check("the census parked nothing it did not release (orbit park kept)", H.census.parkedByCensus === false);
  check("env: frame cap and boot states recorded", r.env.frameCap.fps === 0 && r.env.bootStates.join(",") === "ready,in-world");
}

{
  // The ring gate: 3 baked LBs (none in Holtburg's ring) against a radius-1 ring (target
  // floor(0.8 * 9) = 7) never start the quiet clock, however still everything else holds.
  const page = makePage({ appFirst: true });
  page.win.liveScene3d.pvsRingRadius = 1;
  const r = await runRead(page, { ...FAST, towns: ["holtburg"] });
  const H = r.towns.holtburg;
  check("settle: an under-baked ring is NOT quiet (ringTarget 7, none baked in it)", H.settle.quiet === false && H.settle.ringTarget === 7 && H.settle.bakedInRing === 0, JSON.stringify(H.settle));
}

// The ring is the TOWN's, resident. Linvak (LB 0xA21E) at radius 5: 121 LBs, target 96.
const RING_FAST = { ...FAST, settle: { quietMs: 30, maxMs: 300, pollMs: 5 }, towns: ["linvak"], path: false };
async function ringCase({ baked, parked = [], radius = 5, slotGrid = false }) {
  const page = makePage();
  page.live.terrainBakedLbs = new Set(baked);
  page.live._pvsEffectiveRingRadius = radius;
  if (slotGrid) page.live._slotGridDrivesRing = true;
  page.win.__landblockLru.parkPool = new Set(parked);
  return (await runRead(page, RING_FAST)).towns.linvak.settle;
}
{
  const holt = ringKeys(0xa9b4, 5), linv = ringKeys(0xa21e, 5);
  // The second town of `--town both`: Holtburg's 121 marks are still baked (warm-park keeps
  // them; the LRU cap is 203), nothing of Linvak yet. The global .size (121) met the target.
  const stale = await ringCase({ baked: holt });
  check("ring gate: the first town's stale ring does NOT open the second town's gate", stale.quiet === false && stale.ringTarget === 96 && stale.bakedInRing === 0, JSON.stringify(stale));
  const ok = await ringCase({ baked: [...holt, ...linv] });
  check("…the town's own ring baked opens it (121 of 96)", ok.quiet === true && ok.bakedInRing === 121, JSON.stringify(ok));
  // Parked LBs inside the ring keep their baked mark but draw nothing until unparked.
  const parked = await ringCase({ baked: linv, parked: linv.slice(0, 30) });
  check("…parked LBs inside the ring do not count (91 resident < 96)", parked.quiet === false && parked.bakedInRing === 91 && parked.parkedInRing === 30, JSON.stringify(parked));
  // ?slotGrid: cells.js publishes radius 0 (the grid drives the ring); the gate must not read
  // that as a 1-LB ring.
  const grid = await ringCase({ baked: [linv[60]], radius: 0, slotGrid: true });
  check("…slotGrid's published radius 0: gated on the grid's R_LB ring (target 96), 1 LB is not quiet", grid.quiet === false && grid.ringRadius === 5 && grid.ringTarget === 96 && grid.bakedInRing === 1, JSON.stringify(grid));
  const { R_LB } = await import("../scene3d/residency_grid.js");
  check("…the eval's slotGrid radius is residency_grid.js R_LB", R_LB === 5 && SRC.includes(`const SLOT_GRID_R_LB = ${R_LB};`));
  const sealed = await ringCase({ baked: [linv[60]], radius: 0 });
  check("…a real radius 0 (sealed dungeon) without slotGrid is still a 1-LB ring", sealed.quiet === true && sealed.ringTarget === 0, JSON.stringify(sealed));
}

{
  // 1070: the tunnel ends by itself a few frames after each landing; the read waits it out,
  // so no dwell or census samples a tunnel frame (frame() reads subDraws 999 on those).
  const page = makePage({ tunnelMs: 400 });
  const r = await runRead(page, { ...FAST, towns: ["holtburg"], path: true, tunnelWaitMs: 3000 });
  const H = r.towns.holtburg;
  check("tunnel (1070): waited out after the settle hop and every path hop", H.arrive.tunnel.active === false && H.arrive.tunnel.waitedMs > 0 && H.path.every((p) => p.tele.tunnel.active === false && p.tele.tunnel.waitedMs > 0), JSON.stringify(H.arrive.tunnel));
  check("…no dwell sampled a tunnel frame", H.path.every((p) => p.dwell.batchedRunsFrame.subDraws.max === 20), H.path.map((p) => p.dwell.batchedRunsFrame.subDraws.max).join(","));
  check("…every census on world frames, tunnelHeld empty, nothing force-ended", H.census.tunnelActive === false && H.path.every((p) => p.tunnelActive === false) && H.tunnelHeld.length === 0 && page.tun.ends === 0);
}
{
  // Without the wait (the old read), the first path dwell DOES sample tunnel frames — the
  // check above can fail.
  const page = makePage({ tunnelMs: 400 });
  const r = await runRead(page, { ...FAST, towns: ["holtburg"], path: true, tunnelWaitMs: 0 });
  check("tunnel: with no wait a dwell samples tunnel frames (the regression the wait fixes)", r.towns.holtburg.path.some((p) => p.dwell.batchedRunsFrame.subDraws.max === 999));
}
{
  // A tunnel that never ends (SwiftShader) and no endTunnel: every census is held under it,
  // reported per census, never hidden.
  const page = makePage({ tunnelMs: Infinity });
  const r = await runRead(page, { ...FAST, towns: ["holtburg"], path: true, tunnelWaitMs: 40 });
  const H = r.towns.holtburg;
  check("tunnel stuck: tele.tunnel.active true after the bounded wait", H.arrive.tunnel.active === true && H.arrive.tunnel.waitedMs >= 40);
  check("…tunnelHeld lists the town census and all 4 path censuses", JSON.stringify(H.tunnelHeld) === '["census","path 1","path 2","path 3","path 4"]', JSON.stringify(H.tunnelHeld));
  check("…the probe flags it (exit 3)", probe.townProblems(r).tunnelHeld[0] === "holtburg: census, path 1, path 2, path 3, path 4");
}
{
  // Laptop: no wait, settle under the tunnel, end it before EVERY census (path stops too)
  // through the page's portal_space.js instance.
  const page = makePage({ tunnelMs: Infinity });
  const opts = { ...FAST, towns: ["holtburg"], path: true, tunnelWaitMs: 0, endTunnelBeforeCensus: true, portalSpaceModuleUrl: PORTAL_STUB_URL,
    pathSettle: { quietMs: 20, maxMs: 2000 } };
  const r = await runRead(page, opts);
  const H = r.towns.holtburg;
  check("tunnel (laptop): ended before the town census", H.tunnel.ended === true && H.tunnel.before.active === true && H.tunnel.after.active === false);
  check("…and before each path stop's lite census", H.path.length === 4 && H.path.every((p) => p.tunnelEnd && p.tunnelEnd.ended === true && p.tunnelActive === false), JSON.stringify(H.path.map((p) => p.tunnelEnd)));
  check("…5 ends, tunnelHeld empty", page.tun.ends === 5 && H.tunnelHeld.length === 0 && H.census.tunnelActive === false, `${page.tun.ends} ${JSON.stringify(H.tunnelHeld)}`);
}

{
  // The app renders AFTER this script's rAF callback: the per-frame totals must not change.
  const page = makePage({ appFirst: false });
  const r = await runRead(page, { ...FAST, towns: ["holtburg"], path: false });
  const h = r.towns.holtburg.census.hold;
  check("rAF order flipped: still exactly 100 calls / 3 passes per frame", h.renderInfoPerFrame.calls === 100 && h.renderInfoPerFrame.renderCalls === 3, JSON.stringify(h.renderInfoPerFrame));
  check("no path when path:false", r.towns.holtburg.path === undefined);
}

{
  // Streaming never stops: the settle is reported NOT quiet (never hidden) and the read goes on.
  const page = makePage({ streamForever: true });
  const r = await runRead(page, { ...FAST, settle: { quietMs: 40, maxMs: 250, pollMs: 5 }, towns: ["linvak"], path: false });
  const t = r.towns.linvak;
  check("unsettled town: quiet false, census still taken", t.settle.quiet === false && t.settle.ms >= 250 && t.census && t.census.summary, JSON.stringify(t.settle));
}

{
  // A second module instance (another URL for the same file) has an empty WeakSet: marks
  // must read UNKNOWN, never "0 marked".
  const page = makePage();
  const r = await runRead(page, { ...FAST, towns: ["holtburg"], path: false, batchedRunsModuleUrl: BR_URL + "?second-instance" });
  const c = r.towns.holtburg.census.batched;
  check("second batched_runs.js instance: marks unreadable, why given", c.marks.readable === false && /second module instance/.test(c.marks.why || ""));
  check("…and reported unknown per bucket", c.byKind.chunk.markedUnknown === 2 && c.byKind.chunk.marked === 0);
}

{
  // Every optional seam missing (no camDebug, an old build): fail-soft, nulls, noted.
  const page = makePage({ seams: false });
  delete page.win.__cam;
  const r = await runRead(page, { ...FAST, towns: ["holtburg"], path: true });
  const t = r.towns.holtburg;
  check("seams missing: no throw, census with nulls", !t.error && t.census && t.census.atlas === null && t.census.statBatchX === null && t.census.batchedRuns === null && t.census.lru === null && t.census.pools === null);
  check("…the missing camera is noted, not fatal", t.orbit === null && r.errors.some((e) => /__cam missing/.test(e)));
  check("…the path still hops all 4 stops", t.path.length === 4 && t.path.every((p) => p.tele && !p.error));
}

// --- the queue entry ---------------------------------------------------------------------
console.log("\n— queue-1070/batch-P0-gpu-resident-2026-10-22.json");
{
  const Q = JSON.parse(readFileSync(path.join(APP, "docs", "reengineering", "queue-1070", "batch-P0-gpu-resident-2026-10-22.json"), "utf8"));
  check("queue schema", Q.schema === "hb-1070-queue-v1");
  const p0 = Q.items.find((i) => i.id === "P0");
  check("three arms with the handoff's exact flags", p0 && JSON.stringify(p0.arms.map((a) => a.flags)) === JSON.stringify(["", "&batchedRuns=off",
    "&packSource=on&geomBundles=on&texCompressedOnly=on&slotGrid=on&frameWork=on&drawPools=on&negFace=off"]));
  const hbsess = readFileSync(path.join(PERF, "hbsess.mjs"), "utf8");
  check("hbsess.mjs still builds its boot URL the way the queue's URLs assume",
    hbsess.includes("?autoLogin=1&account=tailnet1&password=tailnet1&autoSpawn=first&nosw=1&camDebug=on&adaptiveRes=off&quality=${q}${flags ? \"&\" + flags : \"\"}"));
  for (const a of p0.arms) {
    const built = uncappedBenchUrl(`http://127.0.0.1:8765/apps/holtburger-web/index.html?autoLogin=1&account=tailnet1&password=tailnet1&autoSpawn=first&nosw=1&camDebug=on&adaptiveRes=off&quality=ultra&renderDiag=on${a.flags}`);
    check(`${a.arm}: URL = hbsess boot --quality ultra --flags 'renderDiag=on${a.flags}'`, a.url === built);
    check(`${a.arm}: nosw=1, renderDiag=on, ultra, targetFps=0, no wireframe`, /[?&]nosw=1&/.test(a.url) && a.url.includes("&renderDiag=on") && a.url.includes("quality=ultra") && a.url.endsWith("&targetFps=0") && !/wireframe/.test(a.url));
  }
  check("towns: the same settle commands as the read", p0.towns.holtburg.settle === TABLES.towns.holtburg.settleCmd && p0.towns.linvak.settle === TABLES.towns.linvak.settleCmd);
  check("towns: the same fixed @teleloc path as the read", JSON.stringify(p0.towns.holtburg.path) === JSON.stringify(TABLES.towns.holtburg.pathCmds) && JSON.stringify(p0.towns.linvak.path) === JSON.stringify(TABLES.towns.linvak.pathCmds));
  const norm = (s) => s.replace(/\s+/g, " ").trim();
  const handoff = norm(readFileSync(path.join(APP, "docs", "HANDOFF-gpu-resident-statics-2026-10-22.md"), "utf8"));
  const verbatim = [...p0.arms.flatMap((a) => a.handoffVerbatim), p0.decisionRules.writtenBeforeTheRun, p0.decisionRules.arm2, p0.decisionRules.arm3];
  const missing = verbatim.filter((v) => !handoff.includes(norm(v)));
  check(`the ${verbatim.length} §7 P0 lines are verbatim from the handoff`, missing.length === 0, missing.join(" || "));
  const mode = norm(JSON.stringify(Q.sessionRulesInline) + p0.boxMode);
  check("owner-run, off-screen, muted", /OWNER-RUN/.test(mode) && mode.includes("--mute-audio") && mode.includes("-32000,-32000"));
  check("fresh profile per arm stated", /FRESH profile per arm/i.test(mode) || /fresh profile per arm/i.test(p0.boxMode));
  check("the per-arm recipe runs the shared read through hbsess eval", p0.perArmRecipe.some((s) => s.includes("hbsess.mjs eval scripts/perf-worker/structure-p0.eval.js")));
  // 2026-10-23 (review): reads that match the code as it stands.
  check("reject rule names tunnelHeld", Q.sessionRulesInline.some((s) => s.startsWith("Reject, never average") && s.includes("tunnelHeld")) && p0.checklist[0].includes("tunnelHeld empty"));
  const f2Read = p0.reads["fromReadsJson (structure-p0.eval.js, per town)"].find((s) => s.startsWith("census.atlas"));
  check("F2 read: atlasGeomDedup default-ON named, baseline = the =off arm (no '1.0 = F2' for arm 1)", /atlasGeomDedup/.test(f2Read) && /DEFAULT-ON/.test(f2Read) && !/1\.0 = no atlas range repeats = F2/.test(f2Read));
  const rcpu = p0.perArmRecipe.find((s) => s.startsWith("3."));
  check("renderCPU recipe pinned to profile-split-render.mjs (by ancestor), which exists", rcpu.includes("node scripts/net-review/profile-split-render.mjs") && /ANCESTOR/.test(rcpu)
    && existsSync(path.join(REPO, "scripts", "net-review", "profile-split-render.mjs")));

  // The P0-FLAGS-2026-10-22 arms: a separate item, so the 3-arm verbatim pin above stands.
  const pf = Q.items.find((i) => i.id === "P0-FLAGS-2026-10-22");
  const wantFlags = {
    "arm3b-chain-poolRuns-off": p0.arms[2].flags + "&poolRuns=off",
    "arm4-atlasGeomDedup-off": "&atlasGeomDedup=off",
    "arm5-staticEarlyOut": "&staticEarlyOut=on",
    "arm6-staticEarlyOut-stable": "&staticEarlyOut=on&batchedRunsStable=on",
    "arm7-statGeomDedup": "&statGeomDedup=on",
    "arm8-batchedRunsSorted-off": "&batchedRunsSorted=off",
    "arm9-terrainNoDrawId": "&terrainNoDrawId=on",
  };
  check("P0-FLAGS: the seven 2026-10-22 flag arms, in order", pf && JSON.stringify(Object.fromEntries(pf.arms.map((a) => [a.arm, a.flags]))) === JSON.stringify(wantFlags));
  // Each flag is read under that exact name by the module the arm is about.
  const readers = { poolRuns: "pool_registry.js", atlasGeomDedup: "static_atlas.js", staticEarlyOut: "static_batch_x.js", batchedRunsStable: "batched_runs.js",
    statGeomDedup: "static_batch_x.js", batchedRunsSorted: "batched_runs.js", terrainNoDrawId: "terrain_batch.js" };
  for (const [flag, file] of Object.entries(readers)) {
    check(`P0-FLAGS: ?${flag} is read by scene3d/${file}`, readFileSync(path.join(APP, "scene3d", file), "utf8").includes(`get("${flag}")`));
  }
  const armNames = new Set([...p0.arms, ...pf.arms].map((a) => a.arm));
  for (const a of pf.arms) {
    const built = uncappedBenchUrl(`http://127.0.0.1:8765/apps/holtburger-web/index.html?autoLogin=1&account=tailnet1&password=tailnet1&autoSpawn=first&nosw=1&camDebug=on&adaptiveRes=off&quality=ultra&renderDiag=on${a.flags}`);
    check(`${a.arm}: URL = hbsess boot --quality ultra --flags 'renderDiag=on${a.flags}'`, a.url === built);
    check(`${a.arm}: compared against a queued arm; reads + rule written; marked NOT handoff-verbatim`,
      armNames.has(a.compareAgainst) && a.compareAgainst !== a.arm && a.reads.length > 0 && a.rule.length > 40 && /NOT handoff-verbatim/.test(a.ruleSource));
    check(`${a.arm}: tier ${a.tier} — tier 2 optional and lite, tier 1 the full recipe`, a.tier === 1 ? a.optional === false && !a.scope : a.tier === 2 && a.optional === true && /lite/.test(a.scope));
    // Every census.<key> an arm reads is a key the read produces (the fake page's full census).
    const keys = [...a.reads.join(" ").matchAll(/census\.([A-Za-z]+)/g)].map((m) => m[1]);
    const missing = keys.filter((k) => !(k in MAIN_CENSUS));
    check(`${a.arm}: every census.* it reads exists in the read's output`, keys.length > 0 && missing.length === 0, missing.join(","));
  }
  // Tier 2 runs the read lite through hbsess (which cannot pass options): an eval of the
  // options body first, then the read, on the same page.
  check("P0-FLAGS lite: the recipe writes exactly liteOptsBody", pf.recipe.tier2Lite.some((s) => s.includes(`printf '%s\\n' '${pf.liteOptsBody}'`)) && !pf.liteOptsBody.includes("'"));
  const page = makePage();
  globalThis.window = page.win;
  const liteOpts = await new AsyncFunction(pf.liteOptsBody)();
  delete globalThis.window;
  check("…the body leaves Holtburg-only, no-path options on the page", JSON.stringify(liteOpts) === '{"towns":["holtburg"],"path":false}' && page.win.__structureP0Opts === liteOpts);
  const lite = await runRead(page, { ...FAST, ...page.win.__structureP0Opts });
  check("…and the read then hops Holtburg's settle point only", JSON.stringify(page.st.chat) === JSON.stringify([TABLES.towns.holtburg.settleCmd]) && lite.towns.holtburg && !lite.towns.linvak && lite.towns.holtburg.path === undefined);
}

console.log(`\nstructure_p0_probe: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
