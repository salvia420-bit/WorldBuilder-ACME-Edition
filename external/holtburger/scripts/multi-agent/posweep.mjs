import { chromium } from "playwright";
import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync } from "fs";
import { totalmem } from "os";
import { diffObjects } from "./posdiff.mjs";
// ============================================================================
// posweep.mjs (v2) — robust positional world-verify.
//
// Per landblock, compare RENDERED positions (placements.walk + cellContainers3d)
// vs DAT/DB ground truth. Flags objects placed on roofs (rendered Z >4m above
// expected), misplaced objects, and interiors that don't fully render.
//
// v2 rewrite — merges verify-sweep.mjs's hard-won stability into posweep's
// positional diff. Fixes the v1 stall + false-positive regressions:
//   * single process, N agent pages on a SHARED in-memory queue (natural load
//     balance; a slow/dead page doesn't starve a static shard)
//   * per-page RECYCLE every N LBs -> bounds ACE session age -> fewer drops
//     (v1's one-session-per-shard aged out and ACE timed it out ~46% in)
//   * per-evaluate WALL-CLOCK TIMEOUT + page recreation -> a hung/crashed page
//     never freezes an agent forever (v1's #1 blocker: page.evaluate has no
//     timeout)
//   * per-LB try/catch + uncaughtException teardown -> one bad LB or crash
//     never kills the run or orphans chrome
//   * DON'T-PERSIST-TRANSIENT: a not-arrived (MISS) or 0-cell interior
//     (build starved under load) result is retried, NOT written as a hard
//     verdict (v1 persisted these -> 207 false INT_DRIFT + 39 false MISS that
//     resume then skipped forever). After --maxattempts honest tries a still-
//     failing LB IS recorded (suffix _HARD) as a real finding.
//   * content-based ARRIVAL (walk>0 / cells>0 / camera-in-LB): __diag.pvs
//     .currentCell() returns null in this harness, so don't depend on it
//   * 1:1 nearest-3D object matching -> stacked same-model objects (building
//     floors) pair with their true-Z partner instead of producing false
//     ROOF/MISPLACED (v1 used XY-only nearest with no 1:1 removal)
//   * SKIP outdoor pass when an LB has no surface objects, skip interior wait
//     when it has no cells -> ~half the teleports, much shorter run
//
// Outdoor teleport + eagerDungeons loads the FULL interior cell graph (verified
// 2026-06-14: 200f 2468/2468, b1 2160/2160 in isolation) — no interior-cell
// teleport needed for cell counts; the v1 0-cell dungeons were starvation, not
// a teleport-target bug.
//
// Usage:
//   node posweep.mjs --agents=8 --label=posworld            (recommended)
//   node posweep.mjs --agents=8 --label=posworld --fresh    (ignore prior state)
//   node posweep.mjs --shard=0/4 --agents=4 --label=posworld (one slice; for
//                                          running >1 box/process if ever needed)
// State: /home/wbterminal/out/sweep-state-<label>/<lbHex>.json  (RESUMABLE).
// ============================================================================
const A = process.argv.slice(2);
const arg = (k, d) => { const m = A.find(a => a.startsWith(`--${k}=`)); return m ? m.slice(k.length + 3) : d; };
const flag = (k) => A.includes(`--${k}`);
const label = arg("label", "posweep");
const acctBase = (arg("account", "") || ("pw" + label)).replace(/[^a-z0-9]/gi, "").slice(0, 12);
let AGENTS = Math.max(1, parseInt(arg("agents", "8")) || 8);
const RECYCLE = Math.max(0, parseInt(arg("recycle", "40")) || 0);
const limit = parseInt(arg("limit", "0")) || 0;
const [si, sn] = arg("shard", "0/1").split("/").map(Number);
const EVTIMEOUT = parseInt(arg("evtimeout", "15000")) || 15000;
const MAX_ATTEMPTS = parseInt(arg("maxattempts", "3")) || 3;
const FRESH = flag("fresh");

// RAM clamp (verify-sweep precedent): ~1.5GiB per agent page+renderer; on a
// small box >3 over-commits. Buildbox is 94GiB so this is a no-op there.
const _giB = totalmem() / 1024 ** 3;
if (_giB <= 9 && AGENTS > 3) { console.log(`[posweep] clamp agents ${AGENTS}->3 (${_giB.toFixed(1)}GiB)`); AGENTS = 3; }

const EXP_DIR = "/home/wbterminal/out/expected";
// Interior ground truth = LandblockInfo.NumCells (authoritative dungeon size; the client
// loads exactly NumCells). lb_numcells.json is regenerated from NumCells; lb_expected.json
// was a fallback that COUNTED PHYSICAL EnvCell RECORDS — it overcounts by orphaned cells on
// 38 LBs (e.g. 8603 2163 vs 568) and produced the entire false-INT_DRIFT population.
const CELLS_PATH = existsSync("/home/wbterminal/out/lb_numcells.json") ? "/home/wbterminal/out/lb_numcells.json" : "/home/wbterminal/out/lb_expected.json";
const CELLS = JSON.parse(readFileSync(CELLS_PATH, "utf8"));
const STATE = `/home/wbterminal/out/sweep-state-${label}`; if (!existsSync(STATE)) mkdirSync(STATE, { recursive: true });
const lbKey = (base) => ((parseInt(base, 16) >>> 16) & 0xffff).toString(16);
const pad4 = (h) => h.padStart(4, "0");
const done = FRESH ? new Set() : new Set(readdirSync(STATE).filter(f => f.endsWith(".json")).map(f => f.replace(/\.json$/, "")));
const lbsArg = arg("lbs", ""); // explicit comma list of lbHex (16-bit) for targeted re-verify
const all = lbsArg
  ? lbsArg.split(",").map(s => s.trim()).filter(Boolean).map(h => ((parseInt(h, 16) << 16) >>> 0).toString(16))
  : readFileSync("/home/wbterminal/out/sweep_queue.txt", "utf8").split("\n").map(s => s.trim()).filter(Boolean);
let queue = all.filter((_, i) => (sn > 1 ? i % sn === si : true)).filter(base => !done.has(lbKey(base)));
if (limit) queue = queue.slice(0, limit);
const attempts = new Map();
const tally = {};

const PRESET = "renderer=3d&wireframe=1&quality=low&agentic=low&eagerDungeons=on&hud=none&plugins=none&diag=1&nosw=1&renderOnDemand=1&autoLogin=1&autoSpawn=first&server_host=127.0.0.1&server_port=9000&bridge_url=ws://127.0.0.1:8080/";
const urlFor = (acct) => `http://127.0.0.1:8765/apps/holtburger-web/index.html?${PRESET}&account=${acct}&password=${acct}`;

// Wall-clock guard around any page.evaluate: a wedged/crashed page can hang
// evaluate forever (no built-in timeout). On timeout the caller recreates the page.
function withTimeout(promise, ms, tag) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("TIMEOUT:" + tag)), ms);
    promise.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}
const isDeadPageErr = (m) => /TIMEOUT|crash|closed|Target|detached|Execution context|Navigation/i.test(String(m));

const browser = await chromium.launch({ headless: true, args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", "--disable-dev-shm-usage"] });
let _closing = false;
const teardown = async (code) => { if (_closing) return; _closing = true; try { await browser.close(); } catch {} if (code !== undefined) process.exit(code); };
process.on("SIGINT", () => teardown(130));
process.on("SIGTERM", () => teardown(143));
process.on("uncaughtException", (e) => { console.error("[posweep] uncaught:", e && e.message); teardown(1); });
process.on("unhandledRejection", (e) => { console.error("[posweep] unhandledRejection:", e && (e.message || e)); teardown(1); });

async function openAndLogin(acct) {
  let page;
  try { page = await browser.newPage(); await page.goto(urlFor(acct), { waitUntil: "domcontentloaded", timeout: 60000 }); }
  catch (e) { try { await page?.close(); } catch {} return null; }
  const dl = Date.now() + 150000;
  while (Date.now() < dl) {
    const s = await withTimeout(page.evaluate(() => window.__bootState), 10000, "boot").catch(() => null);
    const ent = await withTimeout(page.evaluate(() => (window.liveScene3d?.entitiesGroup?.children?.length || 0) > 0), 10000, "ent").catch(() => false);
    if (["ready", "in-world"].includes(s) && ent) break;
    if (s === "error" || s === "ready") {
      await page.evaluate((nm) => { try { window.__sessionHandle.createTestCharacter(nm); } catch {} }, "P" + acct.slice(-4) + Date.now().toString().slice(-4)).catch(() => {});
      await page.waitForTimeout(8000);
      await page.evaluate(() => { try { window.__runAutonomousLogin({ autoSpawn: "first" }); } catch {} }).catch(() => {});
    }
    await page.waitForTimeout(2500);
  }
  await page.evaluate(() => { try { window.__sessionHandle.sendChat("@god"); } catch {} }).catch(() => {});
  await page.waitForTimeout(1500);
  return page;
}
async function recyclePage(oldPage, acct) {
  try { if (oldPage && !oldPage.isClosed()) await oldPage.close(); } catch {}
  await new Promise((r) => setTimeout(r, 1500)); // let ACE reap the old session before reconnect
  return await openAndLogin(acct);
}

// Ground truth for the OBJECT/CELL axis: DAT surface objects + interior cell count.
// 1008/5346 queue LBs have neither (DB-spawn/NPC-only landblocks) — those are not
// checkable here and must be skipped (NO_GT), not teleported-then-flagged MISS.
function readGT(base) {
  const lbHex = lbKey(base);
  let exp = []; try { exp = JSON.parse(readFileSync(`${EXP_DIR}/${pad4(lbHex)}.json`, "utf8")); } catch {}
  const expCells = (CELLS[pad4(lbHex)] || {}).cells || 0;
  return { lbHex, exp, expCells };
}

// Teleport to outdoor center (god, high-Z) and settle until objects + interior
// cells plateau. eagerDungeons loads the dungeon's full cell graph from outside.
async function visit(page, base, gt) {
  const lbId = parseInt(base, 16) >>> 0, lbHex = gt.lbHex, lbX = (lbId >>> 24) & 0xff, lbY = (lbId >>> 16) & 0xff;
  const exp = gt.exp, expCells = gt.expCells;
  const wantCells = expCells > 0 ? Math.ceil(expCells * 0.9) : 0;
  const ceil = expCells > 2000 ? 90000 : expCells > 1000 ? 60000 : expCells > 200 ? 40000 : expCells > 0 ? 25000 : 15000;
  let scene = { walk: [], cells: 0, cam: false }, arrived = false;
  for (let att = 1; att <= 2 && !(arrived && (expCells === 0 || scene.cells >= wantCells)); att++) {
    await withTimeout(page.evaluate((c) => { try { window.__sessionHandle.sendChat(`@teleloc ${c} 96.0 96.0 500.0`); } catch {} }, base), EVTIMEOUT, "tp");
    let pW = -1, pC = -1, stable = 0; const dl = Date.now() + ceil;
    while (Date.now() < dl) {
      await page.waitForTimeout(1700);
      await withTimeout(page.evaluate(() => { try { window.__renderOnce?.(); } catch {} }), EVTIMEOUT, "render").catch(() => {});
      scene = await withTimeout(page.evaluate(({ lbId, lbX, lbY }) => {
        const L = window.liveScene3d || {};
        let walk = []; try { const w = window.__diag?.placements?.walk?.(lbId); walk = Array.isArray(w) ? w.map((o) => ({ m: o.modelId >>> 0, p: o.position })) : []; } catch {}
        let cells = 0; const m = L.cellContainers3d; if (m instanceof Map) { const hi = lbId >>> 16; for (const cid of m.keys()) if (((cid >>> 0) >>> 16) === hi) cells++; }
        let cam = false; const c = L.camera?.position; if (c) cam = ((Math.floor(c.x / 192) & 0xff) === lbX) && ((Math.floor(c.y / 192) & 0xff) === lbY);
        return { walk, cells, cam };
      }, { lbId, lbX, lbY }), EVTIMEOUT, "read");
      if (scene.walk.length > 0 || scene.cells > 0 || scene.cam) arrived = true;
      const cellsDone = expCells === 0 || scene.cells >= wantCells;
      if (scene.walk.length === pW && scene.cells === pC) { stable++; if (arrived && ((stable >= 2 && cellsDone) || stable >= 5)) break; } else stable = 0;
      pW = scene.walk.length; pC = scene.cells;
    }
  }
  return { lbHex, lbId, exp, expCells, scene, arrived, wantCells };
}

function classify(v) {
  if (!v.arrived) return { verdict: "MISS", persist: false };              // transient — retry
  const { matched, nr, roof, moved } = diffObjects(v.exp, v.scene.walk);
  if (v.expCells > 0 && v.scene.cells === 0) return { verdict: "INT_STARVED", persist: false }; // build starved — retry
  const intDrift = v.expCells > 0 && v.scene.cells < v.wantCells;
  let verdict = "OK";
  if (roof.length) verdict = "ROOF";
  else if (moved.length) verdict = "MISPLACED";
  else if (intDrift) verdict = "INT_DRIFT";
  else if (v.exp.length > 0 && nr === v.exp.length) verdict = "NOT_RENDERED";
  const rec = { lb: v.lbHex, verdict, expObj: v.exp.length, rendObj: v.scene.walk.length, matched, roof: roof.length, misplaced: moved.length, notRendered: nr, cells: v.scene.cells, expCells: v.expCells, roofItems: roof.slice(0, 8), movedItems: moved.slice(0, 8) };
  // NOT_RENDERED with cells present is suspicious of a surface-load race -> retry first.
  const persist = !(verdict === "NOT_RENDERED");
  return { verdict, persist, rec };
}

async function agentLoop(idx) {
  let recycles = 0, onPage = 0;
  let page = await openAndLogin(`${acctBase}${idx}x${recycles}`);
  if (!page) { console.log(`agent[${idx}] initial login failed`); return; }
  while (queue.length) {
    const base = queue.shift(); if (base === undefined) break;
    const key = lbKey(base);
    // No DAT/cell ground truth -> not checkable by this axis; record + skip (no teleport).
    const gt = readGT(base);
    if (gt.exp.length === 0 && gt.expCells === 0) {
      writeFileSync(`${STATE}/${gt.lbHex}.json`, JSON.stringify({ lb: gt.lbHex, verdict: "NO_GT", expObj: 0, expCells: 0 }));
      tally.NO_GT = (tally.NO_GT || 0) + 1;
      continue;
    }
    const n = (attempts.get(key) || 0) + 1; attempts.set(key, n);
    const t0 = Date.now();
    try {
      const v = await visit(page, base, gt);
      let { verdict, persist, rec } = classify(v);
      if (!persist && n >= MAX_ATTEMPTS) {                 // out of retries -> record as a real finding
        verdict = (rec ? rec.verdict : verdict) + "_HARD"; persist = true;
        rec = rec || { lb: v.lbHex, verdict, expObj: v.exp.length, rendObj: v.scene.walk.length, cells: v.scene.cells, expCells: v.expCells };
        rec.verdict = verdict; rec.hard = true;
      }
      if (persist) { writeFileSync(`${STATE}/${v.lbHex}.json`, JSON.stringify(rec || { lb: v.lbHex, verdict })); const k = verdict.replace(/_HARD$/, ""); tally[k] = (tally[k] || 0) + 1; }
      else queue.push(base);                               // retry later (back of queue)
      console.log(`agent[${idx}] ${v.lbHex} ${verdict} obj ${v.scene.walk.length}/${v.exp.length} cells ${v.scene.cells}/${v.expCells} (${Date.now() - t0}ms)${persist ? "" : " retry#" + n}`);
    } catch (e) {
      const msg = String(e && e.message || e);
      console.log(`agent[${idx}] ${key} ERR ${msg.slice(0, 80)}`);
      queue.push(base);                                    // errors are transient -> retry
      if (isDeadPageErr(msg)) { recycles++; page = await recyclePage(page, `${acctBase}${idx}x${recycles}`); onPage = 0; if (!page) { console.log(`agent[${idx}] cannot recover page; exit`); return; } continue; }
    }
    if (RECYCLE && ++onPage >= RECYCLE) { recycles++; const np = await recyclePage(page, `${acctBase}${idx}x${recycles}`); if (np) { page = np; onPage = 0; } }
  }
}

const t0 = Date.now();
console.log(`[posweep] ${queue.length} LBs · ${AGENTS} agents · label=${label} · recycle=${RECYCLE || "off"} · ${done.size} already done`);
await Promise.all(Array.from({ length: AGENTS }, (_, i) => agentLoop(i)));

// Aggregate ALL persisted state (this run + prior).
const recs = readdirSync(STATE).filter(f => f.endsWith(".json")).map(f => { try { return JSON.parse(readFileSync(`${STATE}/${f}`, "utf8")); } catch { return null; } }).filter(Boolean);
const T = {}; for (const r of recs) { const k = (r.verdict || "?").replace(/_HARD$/, ""); T[k] = (T[k] || 0) + 1; }
const secs = Math.round((Date.now() - t0) / 1000);
console.log(`[posweep] DONE ${secs}s · this-run ${JSON.stringify(tally)}`);
console.log(`[posweep] STATE TOTAL ${recs.length}/${all.length}: ${JSON.stringify(T)}`);
await teardown(0);
