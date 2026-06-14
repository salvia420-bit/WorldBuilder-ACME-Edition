import { chromium } from "playwright";
import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync } from "fs";
import { totalmem } from "os";
// ============================================================================
// posnpc.mjs — NPC POSITIONAL verify (the 4th symptom: "NPCs in wrong spots").
//
// For each landblock with OUTDOOR NPCs, teleport in (adaptive multi-drop to beat
// ACE's PVS streaming), let the client's spawn tracker accumulate the wired
// spawns, then run the client's BUILT-IN diff: `__diag.setExpected({landblockId,
// npcs}) ; __diag.diff(lbId)`. That diff does global-greedy 1:1 wcid pairing by
// nearest-3D (handles multi-instance wcids like Door=412) with a 2 m tolerance,
// and classifies every expected NPC: good / succeeded-but-misplaced / spawn-failed
// / spawn-pending / wire-arrived-other-lb / wire-never-received.
//
// CONFIDENT bug verdicts (what the user asked for):
//   NPC_MISPLACED  — an NPC rendered >2 m from its DB spawn point (full coverage)
//   NPC_FAILED     — the spawn's mesh failed to load (real client bug)
//   NPC_WRONG_LB   — the NPC wired into a different landblock than the DB says
// Informational (PVS/generators confound these — NOT confident bugs):
//   NPC_PARTIAL    — saw some, not all expected (generators don't render; PVS gaps)
//
// SCOPE: OUTDOOR NPCs only (cell < 0x100). Interior NPCs (cell >= 0x100) need the
// EnvCell cell-local->world transform (the built-in diff only adds lbX*192) and are
// deferred — same follow-up as interior-object positional.
//
// Robustness is ported wholesale from posweep.mjs v2 (per-evaluate timeout + page
// recreation, per-LB try/catch, page recycle, don't-persist-transient + _HARD).
//
// Usage: node posnpc.mjs --agents=8 --label=npcworld   (resumable)
//        node posnpc.mjs --lbs=a9b4,200f --agents=2 --fresh --label=npctest
// State: /home/wbterminal/out/sweep-state-<label>/<lbHex>.json
// ============================================================================
const A = process.argv.slice(2);
const arg = (k, d) => { const m = A.find(a => a.startsWith(`--${k}=`)); return m ? m.slice(k.length + 3) : d; };
const flag = (k) => A.includes(`--${k}`);
const label = arg("label", "posnpc");
const acctBase = (arg("account", "") || ("np" + label)).replace(/[^a-z0-9]/gi, "").slice(0, 12);
let AGENTS = Math.max(1, parseInt(arg("agents", "8")) || 8);
const RECYCLE = Math.max(0, parseInt(arg("recycle", "30")) || 0);
const limit = parseInt(arg("limit", "0")) || 0;
const [si, sn] = arg("shard", "0/1").split("/").map(Number);
const EVTIMEOUT = parseInt(arg("evtimeout", "15000")) || 15000;
const MAX_ATTEMPTS = parseInt(arg("maxattempts", "3")) || 3;
const MAX_DROPS = Math.max(1, parseInt(arg("drops", "5")) || 5);
const MAX_CELLS = Math.max(1, parseInt(arg("cells", "16")) || 16);
const FRESH = flag("fresh");

const _giB = totalmem() / 1024 ** 3;
if (_giB <= 9 && AGENTS > 3) { console.log(`[posnpc] clamp agents ${AGENTS}->3 (${_giB.toFixed(1)}GiB)`); AGENTS = 3; }

const NPC = JSON.parse(readFileSync("/home/wbterminal/out/npc_expected.json", "utf8"));
// EnvCell frames {o:origin, q:orientation} per occupied interior cell — for EXACT
// cell-local drops into dungeons (cellLocal = Q^-1 * (npcLBlocal - O)). Absent -> fixed-offset fallback.
const FRAMES = existsSync("/home/wbterminal/out/envcell_frames.json") ? JSON.parse(readFileSync("/home/wbterminal/out/envcell_frames.json", "utf8")) : {};
const STATE = `/home/wbterminal/out/sweep-state-${label}`; if (!existsSync(STATE)) mkdirSync(STATE, { recursive: true });
// rotate vector v by quaternion q=[w,x,y,z]; conjugate for inverse rotation.
function qrot(q, v) {
  const w = q[0], x = q[1], y = q[2], z = q[3];
  const tx = 2 * (y * v[2] - z * v[1]), ty = 2 * (z * v[0] - x * v[2]), tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)];
}
function cellLocalDrop(frame, rep) { // exact cell-local coords of a representative NPC in the cell
  const d = [rep.x - frame.o[0], rep.y - frame.o[1], rep.z - frame.o[2]];
  return qrot([frame.q[0], -frame.q[1], -frame.q[2], -frame.q[3]], d);
}
const lbKey = (base) => ((parseInt(base, 16) >>> 16) & 0xffff).toString(16);
const done = FRESH ? new Set() : new Set(readdirSync(STATE).filter(f => f.endsWith(".json")).map(f => f.replace(/\.json$/, "")));

// Ground truth: ALL NPCs per LB. Coords are LB-local for BOTH outdoor (cell<0x100)
// AND interior (cell>=0x100) — verified 2026-06-14 (a9b4 interior 43/45 matched with
// coords as-is), so the built-in diff (which adds lbX*192) needs no EnvCell transform.
// npc_expected keys are UNPADDED lb hex ("1","a9b4","200f") = what lbKey() returns.
function lbNpcs(lbHexUnpadded) {
  const a = NPC[lbHexUnpadded] || [];
  const all = a.map(e => ({ wcid: e[0] >>> 0, x: e[1], y: e[2], z: e[3], cell: e[4] || 0 }));
  // cells = one representative NPC per occupied interior cell (for exact drop targeting).
  const byCell = new Map();
  for (const e of all) if (e.cell >= 0x100 && !byCell.has(e.cell)) byCell.set(e.cell, { cell: e.cell, x: e.x, y: e.y, z: e.z });
  return { all, outdoor: all.filter(e => e.cell < 0x100), cells: [...byCell.values()] };
}
// Queue = LBs with ANY NPC (outdoor or interior).
let allLbHex = Object.keys(NPC).filter(k => (NPC[k] || []).length > 0);
const lbsArg = arg("lbs", "");
if (lbsArg) allLbHex = lbsArg.split(",").map(s => s.trim()).filter(Boolean);
let queue = allLbHex
  .map(h => ((parseInt(h, 16) << 16) >>> 0).toString(16))
  .filter((_, i) => (sn > 1 ? i % sn === si : true))
  .filter(base => !done.has(lbKey(base)));
if (limit) queue = queue.slice(0, limit);
const attempts = new Map();
const tally = {};

const PRESET = "renderer=3d&wireframe=1&quality=low&agentic=low&eagerDungeons=on&hud=none&plugins=none&diag=1&nosw=1&renderOnDemand=1&autoLogin=1&autoSpawn=first&kickDance=1&server_host=127.0.0.1&server_port=9000&bridge_url=ws://127.0.0.1:8080/";
const urlFor = (acct) => `http://127.0.0.1:8765/apps/holtburger-web/index.html?${PRESET}&account=${acct}&password=${acct}`;
function withTimeout(promise, ms, tag) {
  return new Promise((resolve, reject) => { const t = setTimeout(() => reject(new Error("TIMEOUT:" + tag)), ms); promise.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); }); });
}
const isDeadPageErr = (m) => /TIMEOUT|crash|closed|Target|detached|Execution context|Navigation/i.test(String(m));

const browser = await chromium.launch({ headless: true, args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", "--disable-dev-shm-usage"] });
let _closing = false;
const teardown = async (code) => { if (_closing) return; _closing = true; try { await browser.close(); } catch {} if (code !== undefined) process.exit(code); };
process.on("SIGINT", () => teardown(130)); process.on("SIGTERM", () => teardown(143));
process.on("uncaughtException", (e) => { console.error("[posnpc] uncaught:", e && e.message); teardown(1); });
process.on("unhandledRejection", (e) => { console.error("[posnpc] unhandledRejection:", e && (e.message || e)); teardown(1); });

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
      await page.evaluate(() => { try { window.__runAutonomousLogin({ autoSpawn: "first", kickDance: 0 }); } catch {} }).catch(() => {});
    }
    await page.waitForTimeout(2500);
  }
  await page.evaluate(() => { try { window.__sessionHandle.sendChat("@god"); } catch {} }).catch(() => {});
  await page.waitForTimeout(1500);
  return page;
}
async function recyclePage(oldPage, acct) {
  try { if (oldPage && !oldPage.isClosed()) await oldPage.close(); } catch {}
  await new Promise((r) => setTimeout(r, 1500));
  return await openAndLogin(acct);
}

// Outdoor drop points (LB-local x,y); center first, then inset corners.
const DROPS = [[96, 96], [40, 40], [152, 40], [40, 152], [152, 152]];
// coverage = expected entries we OBSERVED as succeeded (good match) or failed/misplaced.
const covOf = (r) => (r.goodMatches || 0) + (r.missing || []).filter(m => m.classification === "succeeded-but-misplaced" || m.classification === "spawn-failed").length;

// Settle after a teleport: poll the built-in diff until coverage plateaus (spawns
// stream + meshes load asynchronously after a teleport).
async function settleDiff(page, lbId) {
  let r = {}, prev = -1, stable = 0; const dl = Date.now() + 12000;
  while (Date.now() < dl) {
    await page.waitForTimeout(1700);
    await withTimeout(page.evaluate(() => { try { window.__renderOnce?.(); } catch {} }), EVTIMEOUT, "render").catch(() => {});
    r = await withTimeout(page.evaluate((id) => { try { return window.__diag.diff(id); } catch (e) { return { error: String(e) }; } }, lbId), EVTIMEOUT, "diff");
    const c = covOf(r);
    if (c === prev) { stable++; if (stable >= 2) break; } else stable = 0;
    prev = c;
  }
  return r;
}

// Two-phase drop: (1) outdoor grid streams outdoor NPCs + town building-interiors;
// (2) interior cell drops (@teleloc into each occupied cell) stream pure-dungeon NPCs
// that don't wire from an outdoor-above drop. All comparison is LB-local via diff.
async function visit(page, base, gt) {
  const lbId = parseInt(base, 16) >>> 0, lbHex = lbKey(base);
  await withTimeout(page.evaluate(({ lbId, npcs }) => { try { window.__diag.setExpected({ landblockId: lbId, npcs }); } catch {} }, { lbId, npcs: gt.all }), EVTIMEOUT, "setexp");
  const expN = gt.all.length;
  let r = {}, dropsUsed = 0;
  if (gt.outdoor.length) {                              // Phase 1 — outdoor grid
    let prev = -1, plateau = 0;
    for (let d = 0; d < Math.min(MAX_DROPS, DROPS.length); d++) {
      const [dx, dy] = DROPS[d]; dropsUsed++;
      await withTimeout(page.evaluate(({ c, x, y }) => { try { window.__sessionHandle.sendChat(`@teleloc ${c} ${x} ${y} 500.0`); } catch {} }, { c: base, x: dx, y: dy }), EVTIMEOUT, "tp");
      r = await settleDiff(page, lbId);
      const c = covOf(r); if (c >= expN) return { lbHex, lbId, expN, r, dropsUsed };
      if (c === prev) { plateau++; if (plateau >= 2) break; } else plateau = 0; prev = c;
    }
  }
  if (gt.cells.length && covOf(r) < expN) {             // Phase 2 — interior cell drops
    // Select a spread of cells (evenly across the occupied set) so big dungeons get
    // PVS coverage from far-apart drops rather than the first N adjacent cells.
    let cellList = gt.cells;
    if (cellList.length > MAX_CELLS) { const stride = cellList.length / MAX_CELLS; cellList = Array.from({ length: MAX_CELLS }, (_, i) => cellList[Math.floor(i * stride)]); }
    const frames = FRAMES[lbHex] || {};
    let prev = covOf(r), plateau = 0;
    for (const rep of cellList) {
      dropsUsed++;
      const cellId = "0x" + ((lbId | (rep.cell & 0xffff)) >>> 0).toString(16).padStart(8, "0");
      const fr = frames[String(rep.cell)];
      // Exact cell-local drop at the representative NPC's position; fallback to a small offset.
      const [dx, dy, dz] = fr ? cellLocalDrop(fr, rep).map(n => +n.toFixed(2)) : [2, 2, 2];
      await withTimeout(page.evaluate(({ cid, x, y, z }) => { try { window.__sessionHandle.sendChat(`@teleloc ${cid} ${x} ${y} ${z}`); } catch {} }, { cid: cellId, x: dx, y: dy, z: dz }), EVTIMEOUT, "tpc");
      r = await settleDiff(page, lbId);
      const c = covOf(r); if (c >= expN) break;
      if (c === prev) { plateau++; if (plateau >= 3) break; } else plateau = 0; prev = c;
    }
  }
  return { lbHex, lbId, expN, r, dropsUsed };
}

function classify(v) {
  const r = v.r, expN = v.expN;
  const obs = r.observedCount || 0, good = r.goodMatches || 0;
  const miss = r.missing || [];
  // succeeded-but-misplaced is the ONLY confident bug: the diff pairs it against
  // observations IN THIS LB only (lbId-filtered), so it's robust to the global tracker.
  const misplaced = miss.filter(m => m.classification === "succeeded-but-misplaced");
  const failed = miss.filter(m => m.classification === "spawn-failed");
  // wire-arrived-other-lb is NOT confident here: the spawn tracker is GLOBAL across the
  // page session, so a common wcid seen in any LB we passed through trips it. Informational.
  const otherLb = miss.filter(m => m.classification === "wire-arrived-other-lb");
  const coverage = good + misplaced.length + failed.length;          // expected entries observed in THIS lb
  const fullCoverage = coverage >= expN;
  if (obs === 0 && good === 0) return { verdict: "MISS", persist: false };     // nothing wired — transient (retry/more drops)

  let verdict = "OK", conf = true;
  if (misplaced.length && fullCoverage) verdict = "NPC_MISPLACED";              // CONFIDENT wrong-spot
  else if (failed.length) verdict = "NPC_FAILED";                              // mesh failed to load for an in-LB spawn
  else if (misplaced.length) { verdict = "NPC_MISPLACED"; conf = false; }       // partial coverage -> pairing may be a PVS artifact
  else if (good >= expN) verdict = "OK";
  else verdict = "NPC_PARTIAL";                                                 // saw some, missing rest = generators/PVS (informational)

  const rec = {
    lb: v.lbHex, verdict, lowConf: !conf || undefined,
    expected: expN, good, observed: obs, drops: v.dropsUsed,
    misplaced: misplaced.slice(0, 8).map(m => ({ wcid: m.expected.wcid, exp: [m.expected.x, m.expected.y, m.expected.z], obs: m.detail?.observedPos, dist: +(m.detail?.distance ?? 0).toFixed(1) })),
    failed: failed.slice(0, 6).map(m => ({ wcid: m.expected.wcid, err: m.detail?.error })),
    otherLbCount: otherLb.length,   // informational only (global-tracker confound)
    summary: r.summary || {},
  };
  // PARTIAL persists on the FIRST pass: its coverage gap is a STABLE ceiling (non-
  // rendering generators + ACE PVS), not transient — retrying it ~triples runtime for
  // ~no gain. Only MISS (0 observed, early-returned with persist:false) retries, since
  // that can be a transient ACE hiccup. (Confident OK/MISPLACED/FAILED persist too.)
  const persist = true;
  return { verdict, persist, rec };
}

async function agentLoop(idx) {
  let recycles = 0, onPage = 0;
  let page = await openAndLogin(`${acctBase}${idx}x${recycles}`);
  if (!page) { console.log(`agent[${idx}] initial login failed`); return; }
  while (queue.length) {
    const base = queue.shift(); if (base === undefined) break;
    const key = lbKey(base);
    const gt = lbNpcs(key);
    if (!gt.all.length) { writeFileSync(`${STATE}/${key}.json`, JSON.stringify({ lb: key, verdict: "NO_NPC" })); tally.NO_NPC = (tally.NO_NPC || 0) + 1; continue; }
    const n = (attempts.get(key) || 0) + 1; attempts.set(key, n);
    const t0 = Date.now();
    try {
      const v = await visit(page, base, gt);
      let { verdict, persist, rec } = classify(v);
      if (!persist && n >= MAX_ATTEMPTS) { verdict = (rec ? rec.verdict : verdict) + "_HARD"; persist = true; rec = rec || { lb: v.lbHex, verdict }; rec.verdict = verdict; rec.hard = true; }
      if (persist) { writeFileSync(`${STATE}/${v.lbHex}.json`, JSON.stringify(rec || { lb: v.lbHex, verdict })); const k = verdict.replace(/_HARD$/, ""); tally[k] = (tally[k] || 0) + 1; }
      else queue.push(base);
      console.log(`agent[${idx}] ${v.lbHex} ${verdict} good ${v.r.goodMatches || 0}/${v.expN} obs ${v.r.observedCount || 0} drops ${v.dropsUsed}${rec && rec.misplaced && rec.misplaced.length ? " MIS:" + JSON.stringify(rec.misplaced.slice(0, 3)) : ""} (${Date.now() - t0}ms)${persist ? "" : " retry#" + n}`);
    } catch (e) {
      const msg = String(e && e.message || e);
      console.log(`agent[${idx}] ${key} ERR ${msg.slice(0, 80)}`);
      queue.push(base);
      if (isDeadPageErr(msg)) { recycles++; page = await recyclePage(page, `${acctBase}${idx}x${recycles}`); onPage = 0; if (!page) { console.log(`agent[${idx}] cannot recover; exit`); return; } continue; }
    }
    if (RECYCLE && ++onPage >= RECYCLE) { recycles++; const np = await recyclePage(page, `${acctBase}${idx}x${recycles}`); if (np) { page = np; onPage = 0; } }
  }
}

const t0 = Date.now();
console.log(`[posnpc] ${queue.length} LBs (outdoor NPCs) · ${AGENTS} agents · label=${label} · ${done.size} done`);
await Promise.all(Array.from({ length: AGENTS }, (_, i) => agentLoop(i)));
const recs = readdirSync(STATE).filter(f => f.endsWith(".json")).map(f => { try { return JSON.parse(readFileSync(`${STATE}/${f}`, "utf8")); } catch { return null; } }).filter(Boolean);
const T = {}; for (const r of recs) { const k = (r.verdict || "?").replace(/_HARD$/, ""); T[k] = (T[k] || 0) + 1; }
console.log(`[posnpc] DONE ${Math.round((Date.now() - t0) / 1000)}s · this-run ${JSON.stringify(tally)}`);
console.log(`[posnpc] STATE TOTAL ${recs.length}: ${JSON.stringify(T)}`);
await teardown(0);
