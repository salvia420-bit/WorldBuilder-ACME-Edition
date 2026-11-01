// 2026-11-01 — ?objRefire (scene3d/object_refire.js): the slot-grid arm's
// object-window refire. Unit checks + an integration run on the REAL slot grid,
// grid adapter, stream-bake guard and ?objRadius gate (mocked clock and bakes).
//
// Run:
//   cd apps/holtburger-web/
//   node tests/obj_refire.test.mjs

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  objRefireEnabled, createTravelTracker, noteTravel, travelDir, refireScore,
  collectObjectRefire, createObjectRefire, OBJ_REFIRE_MS, TRAVEL_MEMORY_MS,
} from "../scene3d/object_refire.js";
import * as rg from "../scene3d/residency_grid.js";
import { createStreamGuardState, guardedStreamBake } from "../scene3d/stream_bake_guard.js";
import { objectBakeAllowed, objRadiusSetting, __setObjRadiusForTest } from "../scene3d/object_radius.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(HERE, "..");
let passed = 0, failed = 0;
function check(label, cond, extra = "") {
  if (cond) { passed++; console.log(`  [OK] ${label}`); }
  else { failed++; console.log(`  [FAIL] ${label} ${extra}`); }
}
const K = (x, y) => (((x & 0xff) << 24) | ((y & 0xff) << 16)) >>> 0;

console.log("-- O1 flag grammar ----------------------------------------------------");
check("absent -> ON (default since the 2026-11-01 flip)", objRefireEnabled("") === true && objRefireEnabled("?x=1") === true);
check("on/1/true/yes/garbage -> ON", ["on", "1", "true", "yes", "ON", "maybe", ""].every((v) => objRefireEnabled(`?objRefire=${v}`)));
check("off/0/false/no -> OFF", ["off", "0", "false", "no", "OFF"].every((v) => !objRefireEnabled(`?objRefire=${v}`)));

console.log("-- O2 travel direction -------------------------------------------------");
{
  const tr = createTravelTracker();
  noteTravel(tr, 10, 10, 0);
  check("no crossing yet -> no direction", travelDir(tr, 0) === null);
  noteTravel(tr, 11, 10, 1000);
  noteTravel(tr, 12, 10, 2000);
  const d = travelDir(tr, 2000);
  check("two +x crossings -> (1, 0)", d && Math.abs(d.x - 1) < 1e-9 && Math.abs(d.y) < 1e-9, JSON.stringify(d));
  noteTravel(tr, 12, 11, 3000);
  const d2 = travelDir(tr, 3000);
  check("then a +y crossing -> blended toward +y", d2 && d2.x > 0.8 && d2.y > 0.3, JSON.stringify(d2));
  check("forgotten after TRAVEL_MEMORY_MS", travelDir(tr, 3000 + TRAVEL_MEMORY_MS + 1) === null);
  noteTravel(tr, 40, 40, 4000);
  check("a teleport (step > 2) drops the history", travelDir(tr, 4000) === null);
  noteTravel(tr, 40, 40, 5000);
  check("same LB is not a crossing", travelDir(tr, 5000) === null);
}

console.log("-- O3 ordering ----------------------------------------------------------");
{
  const dir = { x: 1, y: 0 };
  const s = (dx, dy) => refireScore(K(50 + dx, 50 + dy), 50, 50, dir);
  check("3 ahead outranks 2 abeam", s(3, 0) < s(0, 2));
  check("2 abeam outranks 2 behind", s(0, 2) < s(-2, 0));
  check("2 ahead outranks 1 behind", s(2, 0) < s(-1, 0));
  check("no direction -> plain Chebyshev", refireScore(K(53, 51), 50, 50, null) === 3);
  // collect: LIVE/STAGED only, radius, needs()
  const tiles = [rg.tileKeyOf(25, 25), rg.tileKeyOf(26, 25), rg.tileKeyOf(24, 25), rg.tileKeyOf(30, 30)];
  const state = new Map([[tiles[0], rg.SLOT_STATE.LIVE], [tiles[1], rg.SLOT_STATE.STAGED], [tiles[2], rg.SLOT_STATE.LIVE], [tiles[3], rg.SLOT_STATE.LIVE]]);
  const got = collectObjectRefire({
    windowTiles: tiles,
    stateOf: (t) => state.get(t),
    liveStates: new Set([rg.SLOT_STATE.LIVE, rg.SLOT_STATE.STAGED]),
    tileLbKeys: rg.tileLbKeys,
    playerLbKey: K(50, 50),
    radius: 3,
    needs: (k) => k !== K(51, 51),
    dir,
  });
  const xs = got.map((k) => (k >>> 24) & 0xff);
  check("far tile (radius) excluded", !got.some((k) => ((k >>> 24) & 0xff) >= 60));
  check("needs() false excluded", !got.includes(K(51, 51)));
  check("ahead (+x) before behind (-x) at equal distance", xs.indexOf(52) < xs.indexOf(48), xs.join(","));
  check("STAGED tile included", got.includes(K(52, 50)));
}

console.log("-- O4 tick throttle + errors --------------------------------------------");
{
  const fired = [];
  const grid = { windowTiles: [rg.tileKeyOf(25, 25)], stateOf: () => rg.SLOT_STATE.LIVE };
  const r = createObjectRefire({
    fireLb: (x, y) => fired.push(K(x, y)),
    needs: () => true,
    radius: () => 2,
    fallbackRadius: 5,
    liveStates: new Set([rg.SLOT_STATE.LIVE]),
    tileLbKeys: rg.tileLbKeys,
  });
  r.tick(grid, K(50, 50), 0);
  const n1 = fired.length;
  r.tick(grid, K(50, 50), OBJ_REFIRE_MS - 1);
  check("fires the window's 4 LBs once", n1 === 4, String(n1));
  check("throttled inside OBJ_REFIRE_MS", fired.length === n1);
  r.tick(grid, K(50, 50), OBJ_REFIRE_MS);
  check("fires again after OBJ_REFIRE_MS", fired.length === 2 * n1);
  check("null player -> no-op", r.tick(grid, null, 10_000) === 0);
  const bad = createObjectRefire({
    fireLb: () => { throw new Error("boom"); }, needs: () => true, radius: () => null, fallbackRadius: 5,
    liveStates: new Set([rg.SLOT_STATE.LIVE]), tileLbKeys: rg.tileLbKeys,
  });
  check("a throwing feed never escapes the tick", bad.tick(grid, K(50, 50), 0) === 0 && /boom/.test(bad.stats.lastError || ""));
}

console.log("-- O5 integration: real grid + adapter + guard + objRadius ---------------");
// A run at constant speed along +x with mocked bakes (latency + one serial
// worker). The legacy grid path re-fires a LIVE tile's objects only on a
// crossing; with the refire the object window fills between crossings.
async function runWalk({ refire, mps, seconds, radius = 3 }) {
  __setObjRadiusForTest(radius);
  const clock = { t: 0 };
  const now = () => clock.t;
  const pending = [];
  const sleep = (ms) => new Promise((res) => pending.push({ at: clock.t + ms, res }));
  let workerFreeAt = 0;
  const COST = { terrain: [40, 25], statics: [60, 90], buildings: [30, 8] };
  const baked = { terrain: new Set(), statics: new Set(), buildings: new Set() };
  const guard = createStreamGuardState();
  let rigLb = null;
  const cheb = (a, b) => Math.max(Math.abs(((a >>> 24) & 0xff) - ((b >>> 24) & 0xff)), Math.abs(((a >>> 16) & 0xff) - ((b >>> 16) & 0xff)));
  const load = (kind, k) => {
    if (baked[kind].has(k)) return;
    guardedStreamBake(guard, kind, k, async () => {
      const [lat, work] = COST[kind];
      await sleep(lat);
      const fin = Math.max(workerFreeAt, clock.t) + work;
      workerFreeAt = fin;
      await sleep(fin - clock.t);
      baked[kind].add(k);
    }, { urgent: rigLb != null && cheb(k, rigLb) <= 1, now, warn() {} });
  };
  let gridPlayerLbKey = null;
  const feeds = {
    fireLb(x, y) {
      const k = K(x, y);
      const objOk = gridPlayerLbKey == null || objectBakeAllowed([gridPlayerLbKey], k);
      load("terrain", k);
      if (objOk) { load("statics", k); load("buildings", k); }
    },
  };
  const grid = new rg.SlotGrid({ now });
  const adapter = new rg.GridResidencyAdapter({
    grid, feeds, now, warn() {}, packs: null,
    lru: { parkLb: () => true, unparkLb: () => true, isParkedLb: () => false, lbBytes: () => 0, disposeLb: () => true },
    bakedPredicate: (tile) => rg.tileLbKeys(tile).every((lb) => baked.terrain.has(lb)),
  });
  const orf = refire
    ? createObjectRefire({
        fireLb: (x, y) => feeds.fireLb(x, y),
        needs: (k) => !baked.statics.has(k) || !baked.buildings.has(k),
        radius: () => objRadiusSetting(),
        fallbackRadius: rg.R_LB,
        liveStates: new Set([rg.SLOT_STATE.LIVE, rg.SLOT_STATE.STAGED]),
        tileLbKeys: rg.tileLbKeys,
      })
    : null;
  let lastStaged = -Infinity;
  const fracs = [];
  for (let t = 0; t <= seconds * 1000; t += 50) {
    clock.t = t;
    pending.sort((a, b) => a.at - b.at);
    while (pending.length && pending[0].at <= t) {
      pending.shift().res();
      for (let i = 0; i < 6; i++) await Promise.resolve();
    }
    for (let i = 0; i < 6; i++) await Promise.resolve();
    const x = 100 * 192 + (mps * t) / 1000;
    const lbx = Math.floor(x / 192), lby = 120;
    rigLb = K(lbx, lby);
    const crossed = gridPlayerLbKey !== null && gridPlayerLbKey !== rigLb;
    gridPlayerLbKey = rigLb;
    if (orf) orf.notePlayer(rigLb, t);
    adapter.onUpdate(grid.update(lbx, lby));
    if (crossed) adapter.refireWindowFeeds();
    adapter.tickTeleportDrain();
    adapter.tickPromotions();
    if (t - lastStaged >= 250) { lastStaged = t; adapter.refireStagedFeeds(); }
    if (orf) orf.tick(grid, gridPlayerLbKey, t);
    if (t >= 20_000 && t % 1000 === 0) {
      let n = 0, b = 0;
      for (let dx = -radius; dx <= radius; dx++) for (let dy = -radius; dy <= radius; dy++) {
        n++;
        if (baked.statics.has(K(lbx + dx, lby + dy))) b++;
      }
      fracs.push(b / n);
    }
  }
  __setObjRadiusForTest(undefined);
  return fracs.reduce((a, v) => a + v, 0) / Math.max(1, fracs.length);
}
{
  const footBase = await runWalk({ refire: false, mps: 11, seconds: 120 });
  const footRef = await runWalk({ refire: true, mps: 11, seconds: 120 });
  const flyBase = await runWalk({ refire: false, mps: 111, seconds: 60 });
  const flyRef = await runWalk({ refire: true, mps: 111, seconds: 60 });
  const pct = (v) => (100 * v).toFixed(1) + "%";
  console.log(`     statics-baked share of the objRadius=3 window (after 20 s): on foot ${pct(footBase)} -> ${pct(footRef)}; 400 km/h ${pct(flyBase)} -> ${pct(flyRef)}`);
  check("baseline on foot leaves the window incomplete (the gap)", footBase < 0.9, pct(footBase));
  check("refire fills the window on foot (>= 95%)", footRef >= 0.95, pct(footRef));
  check("refire beats baseline at 400 km/h by >= 20 points", flyRef - flyBase >= 0.2, `${pct(flyBase)} -> ${pct(flyRef)}`);
}

console.log("-- O6 wiring (index.js) -------------------------------------------------");
{
  const src = readFileSync(path.join(APP, "scene3d/index.js"), "utf8");
  const iStaged = src.indexOf("adapter.refireStagedFeeds();\n");
  const iTick = src.indexOf("if (objRefire) objRefire.tick(grid, gridPlayerLbKey, t);");
  check("refire ticks after the staged refire", iStaged > 0 && iTick > iStaged);
  check("crossing memory fed on each grid tick", src.includes("if (objRefire) objRefire.notePlayer(lbOnly, now());"));
  check("module loaded only when the flag is on (not statically imported)",
    !/^import .*object_refire\.js/m.test(src) && src.includes('await import("./object_refire.js")'));
  check("feeds stay the objRadius-gated fireLb", src.includes("fireLb: (x, y) => feeds.fireLb(x, y),"));
  const flags = readFileSync(path.join(APP, "docs/url-flags.md"), "utf8");
  check("url-flags.md has an `objRefire` row", /^\| `objRefire` \|/m.test(flags));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
