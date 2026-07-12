#!/usr/bin/env node
// portal-settle-probe.mjs — sealed-dungeon PORTAL-ENTRY complete-settlement
// probe (2026-07-11, TN-unresponsiveness investigation).
//
// Purpose: measure EVERYTHING from the moment the player enters a portal to a
// sealed hub dungeon (Town Network by default) until the client is COMPLETELY
// settled, with stage attribution fine enough to A/B rival hypotheses:
//   - H-decode:  cold decode/bake pipe (envcells + entity burst + worker queue)
//   - H-churn:   residency churn (sealed purge ↔ streamer, park/unpark, LRU)
//
// "Complete settlement" here is HONEST (the battery's scene-count settle
// false-settled at 19/205 TN cells): first time T >= landed where a 3 s window
// satisfies ALL of
//   - no long task > 100 ms                (main thread quiet)
//   - input-lag p95 < 50 ms                (chat would accept keystrokes)
//   - cellContainers3d growth == 0 AND envCellBuildInFlight == 0
//   - bake-worker request seq flat         (decode pipe drained)
//   - entity count flat (±1)               (spawn burst drained)
//   - park+unpark+evict deltas == 0        (residency quiet)
// Also reported separately: chatReadyMs (first sustained input-lag<100ms —
// the user's "when can I type" metric), framesRecoveredMs, cells100/205 times.
//
// Entry modes:
//   --entry telepoi   @telepoi <dest>            (repeatable, default)
//   --entry portal    teleport BESIDE a real portal then useObject(guid) —
//                     exercises the true portal path (portal-space VFX, fade).
//                     Default portal: Cragstone's "Portal to Town Network"
//                     (LSD spawnMap BC9F id 78, objcell 0xBC9F003C).
//
// Modes: --mode local (boot.mjs headless laptop) | --mode cdp (1070 recipe —
// connect to an ALREADY-RUNNING off-screen Chrome; NEVER browser.close()).
//
// Usage (local):
//   HARNESS_ACCOUNT=x HARNESS_PASSWORD=x node portal-settle-probe.mjs \
//     --accumulate "Rithwic,Eastham,Cragstone" --dwell 20 --record 90 \
//     --query "fixedGrid=off" --label gridoff --out run.json
// Usage (1070 cdp): node portal-settle-probe.mjs --mode cdp \
//     --cdp http://127.0.0.1:9333 --base http://localhost:7080 \
//     --account abmqzmbdv4a --render 1 --entry portal --out run.json
//
// Output: full JSON (marks, 250 ms buckets, long tasks w/ attribution,
// input-lag stats, net failures, console errors) + trailing
// "PORTAL-SETTLE SUMMARY: ..." single line for batch reducers.

import { pathToFileURL } from "node:url";
import fs from "node:fs";

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };
const MODE = arg("mode", "local");
const CDP_URL = arg("cdp", "http://127.0.0.1:9333");
const BASE = arg("base", "http://127.0.0.1:8765"); // cdp mode page origin
const ACCOUNT = arg("account", process.env.HARNESS_ACCOUNT || "");
const EXTRA_QUERY = arg("query", "");
const LABEL = arg("label", "run");
const OUT = arg("out", "");
const RECORD_S = Number(arg("record", "90"));
const BASELINE_S = Number(arg("baseline", "8"));
const ACCUMULATE = (arg("accumulate", "") || "").split(",").map((s) => s.trim()).filter(Boolean);
const DWELL_S = Number(arg("dwell", "20"));
const DEST = arg("dest", "Town Network");
const DEST_LB_HIGH = Number(arg("destLbHigh", String(0x0007)));
const DEST_TELELOC = arg("destTeleloc", "@teleloc 0x00070143 70 -60 0");
const ENTRY = arg("entry", "telepoi"); // telepoi | portal
const PORTAL_STAGE_TELELOC = arg("portalStage", "@teleloc 0xBC9F003C 176.5 77.5 32.3");
const PORTAL_NAME_NEEDLE = arg("portalName", "town network").toLowerCase();
const EXPECT_CELLS = Number(arg("expectCells", "205"));
const RENDER = arg("render", "") === "1"; // cdp: real render (no nullRender)

// ───────────────────────── in-page recorder ─────────────────────────
// Everything runs inside the page; Node only installs/stops/collects.
const installRecorder = () => {
  if (window.__psRec) return { ok: true, already: true };
  const rec = {
    t0: performance.now(), stopped: false,
    frames: [], lastRaf: null,
    buckets: [], marks: [], longTasks: [], inputLags: [],
    gcDrops: 0, _lastHeap: 0,
  };
  window.__psRec = rec;
  const raf = (now) => {
    if (rec.stopped) return;
    if (rec.lastRaf != null) rec.frames.push(now - rec.lastRaf);
    rec.lastRaf = now;
    requestAnimationFrame(raf);
  };
  requestAnimationFrame(raf);
  // Long tasks WITH attribution (container name/type when the browser gives it).
  try {
    rec.obs = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        let attr = null;
        try {
          const a = e.attribution && e.attribution[0];
          if (a) attr = `${a.containerType || ""}:${a.containerName || a.containerSrc || ""}`;
        } catch (_) {}
        rec.longTasks.push({ t: +(e.startTime - rec.t0).toFixed(0), ms: +e.duration.toFixed(0), attr });
      }
    });
    rec.obs.observe({ entryTypes: ["longtask"] });
  } catch (_) { rec.obs = null; }
  // Input-lag proxy: a 50 ms setTimeout chain measuring scheduling delay —
  // the same macrotask queue a keydown must clear. lag = observed - 50.
  let lastSched = performance.now();
  const inputTick = () => {
    if (rec.stopped) return;
    const now = performance.now();
    rec.inputLags.push({ t: +(now - rec.t0).toFixed(0), lag: +(now - lastSched - 50).toFixed(0) });
    lastSched = now;
    setTimeout(inputTick, 50);
  };
  setTimeout(inputTick, 50);
  // Renderer counters cumulative (only meaningful when actually rendering).
  try {
    const r = window.liveScene3d && window.liveScene3d.renderer;
    if (r && r.info) { rec.prevAutoReset = r.info.autoReset; r.info.autoReset = false; }
  } catch (_) {}
  let framesSeen = 0, lagSeen = 0, lastCalls = 0;
  const lruSnap = () => {
    try {
      const s = window.__landblockLru?.getStats?.() || {};
      // Field names match landblock_lru.js getStats() exactly (campaign
      // gap: evictedTotal/work don't exist there — evicted does, work is
      // the bake-worker seq sampled separately as bakeSeq).
      return {
        resident: window.liveScene3d?.landblockLru?.entries?.size ?? null,
        parked: s.parkedTotal ?? null, unparked: s.unparkedTotal ?? null,
        evicted: s.evicted ?? null,
        deferred: s.reclaimDeferredInFlight ?? null,
      };
    } catch (_) { return {}; }
  };
  rec.sampler = setInterval(() => {
    try {
      const t = +(performance.now() - rec.t0).toFixed(0);
      const s3 = window.liveScene3d;
      const h = window.__sessionHandle;
      let pose = null; try { pose = h && h.getLocalPlayerPose(); } catch (_) {}
      const dts = rec.frames.slice(framesSeen); framesSeen = rec.frames.length;
      const lags = rec.inputLags.slice(lagSeen).map((x) => x.lag); lagSeen = rec.inputLags.length;
      lags.sort((a, b) => a - b);
      const r = s3 && s3.renderer, ri = r && r.info;
      const calls = ri ? ri.render.calls : 0;
      const heap = (performance.memory && performance.memory.usedJSHeapSize) || 0;
      if (rec._lastHeap && heap < rec._lastHeap * 0.75) rec.gcDrops += 1;
      rec._lastHeap = heap;
      const b = {
        t,
        frames: dts.length,
        maxDt: dts.length ? +Math.max(...dts).toFixed(0) : null,
        lagP95: lags.length ? lags[Math.min(lags.length - 1, Math.floor(lags.length * 0.95))] : null,
        lagMax: lags.length ? lags[lags.length - 1] : null,
        lb: pose && pose.landblockId != null ? (pose.landblockId >>> 0) : null,
        indoor: (() => { try { return h ? h.isCurrentCellIndoor() : null; } catch (_) { return null; } })(),
        cells: s3?.cellContainers3d?.size ?? null,
        envInFlight: s3?.envCellBuildInFlight?.size ?? null,
        entities: s3?.entityManager?.entityMap?.size ?? null,
        terrainLbs: s3?.terrainBakedLbs?.size ?? null,
        staticsLbs: s3?.staticsBakedLbs?.size ?? null,
        staticsChildren: s3?.staticsGroup?.children?.length ?? null,
        cellsChildren: s3?.cellsGroup?.children?.length ?? null,
        lru: lruSnap(),
        grid: (() => { try { const g = window.__fixedGrid?.getStats?.(); return g ? { shifts: g.shifts ?? null, invalidates: g.invalidates ?? g.wholeGridInvalidates ?? null, parks: g.park?.parksIssued ?? null } : null; } catch (_) { return null; } })(),
        bakeSeq: (() => { try { return window.__bakeWorkerSeq?.() ?? null; } catch (_) { return null; } })(),
        wireTotal: (() => { try { return window.__diag?.wire?.summary?.().total ?? null; } catch (_) { return null; } })(),
        pumpAgeMs: window.__lastPumpMs != null ? +(performance.now() - window.__lastPumpMs).toFixed(0) : null,
        heapMB: heap ? Math.round(heap / 1048576) : null,
        programs: ri && Array.isArray(ri.programs) ? ri.programs.length : null,
        dCalls: ri ? calls - lastCalls : null,
        geometries: ri ? ri.memory.geometries : null,
        textures: ri ? ri.memory.textures : null,
      };
      lastCalls = calls;
      rec.buckets.push(b);
    } catch (_) { /* never break the page */ }
  }, 250);
  return { ok: true };
};

const stopRecorder = () => {
  const rec = window.__psRec;
  if (!rec) return null;
  rec.stopped = true;
  try { clearInterval(rec.sampler); } catch (_) {}
  try { rec.obs && rec.obs.disconnect(); } catch (_) {}
  try {
    const r = window.liveScene3d && window.liveScene3d.renderer;
    if (r && rec.prevAutoReset != null) r.info.autoReset = rec.prevAutoReset;
  } catch (_) {}
  return {
    buckets: rec.buckets, longTasks: rec.longTasks, marks: rec.marks,
    frameCount: rec.frames.length, gcDrops: rec.gcDrops,
    inputLagCount: rec.inputLags.length,
  };
};

// ───────────────────────── session bring-up ─────────────────────────
const netFailures = []; // node-side: non-2xx/failed requests (url, status, t)
const consoleErrs = [];
let page, helpers = null, closeFn = async () => {};
const t0Wall = Date.now();

if (MODE === "local") {
  const BOOT_MJS = process.env.BOOT_MJS ||
    "/home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/apps/holtburger-web/harness/lib/boot.mjs";
  const boot = await import(pathToFileURL(BOOT_MJS).href);
  const query = { nosw: "1" };
  if (RENDER) query.nullRender = "0";
  if (EXTRA_QUERY) for (const [k, v] of new URLSearchParams(EXTRA_QUERY)) query[k] = v;
  const r = await boot.launchAndEnter({ query, timeoutMs: 120_000 });
  if (!r.inWorld) {
    console.log(JSON.stringify({ ok: false, reason: "boot-stalled", label: LABEL }));
    console.log("PORTAL-SETTLE SUMMARY: SKIP boot-stalled");
    await r.helpers.close(); process.exit(2);
  }
  page = r.page; helpers = r.helpers; closeFn = () => helpers.close();
} else {
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  let pw;
  try { pw = require("playwright-core"); } catch (_) {
    const home = process.env.HOME;
    const hits = fs.readdirSync(`${home}/.npm/_npx`).map((d) => `${home}/.npm/_npx/${d}/node_modules/playwright-core`).filter((p) => fs.existsSync(p));
    if (!hits.length) { console.error("playwright-core not found"); process.exit(2); }
    pw = require(hits[0]);
  }
  if (!ACCOUNT) { console.error("--account required in cdp mode"); process.exit(2); }
  const browser = await pw.chromium.connectOverCDP(CDP_URL);
  const ctx = browser.contexts()[0] ?? (await browser.newContext());
  page = await ctx.newPage();
  const q = new URLSearchParams({
    renderer: "3d", autoLogin: "1", account: ACCOUNT, password: ACCOUNT,
    autoSpawn: "first", nosw: "1",
  });
  if (!RENDER) q.set("nullRender", "1");
  if (EXTRA_QUERY) for (const [k, v] of new URLSearchParams(EXTRA_QUERY)) q.set(k, v);
  await page.goto(`${BASE}/apps/holtburger-web/index.html?${q}`, { timeout: 60_000 });
  let inWorld = false;
  for (let i = 0; i < 240; i++) {
    const st = await page.evaluate(() => ({
      bs: window.__bootState,
      pose: (() => { try { return !!window.__sessionHandle?.getLocalPlayerPose(); } catch (_) { return false; } })(),
    })).catch(() => null);
    if (st && (st.bs === "in-world" || st.bs === "ready") && st.pose) { inWorld = true; break; }
    if (st && st.bs === "error") break;
    await page.waitForTimeout(500);
  }
  if (!inWorld) {
    console.log(JSON.stringify({ ok: false, reason: "boot-stalled", label: LABEL }));
    console.log("PORTAL-SETTLE SUMMARY: SKIP boot-stalled");
    try { await page.close(); } catch (_) {}
    process.exit(2);
  }
  closeFn = async () => { try { await page.close(); } catch (_) {} }; // NEVER browser.close()
}

// Uniform helpers over both modes.
const evalIn = (fn, a) => (helpers ? helpers.evalInPage(fn, a) : page.evaluate(fn, a));
page.on("response", (res) => {
  try { if (!res.ok() && res.status() !== 304) netFailures.push({ t: Date.now() - t0Wall, status: res.status(), url: res.url().slice(-120) }); } catch (_) {}
});
page.on("requestfailed", (req) => {
  try { netFailures.push({ t: Date.now() - t0Wall, status: "FAILED", url: req.url().slice(-120) }); } catch (_) {}
});
if (!helpers) page.on("console", (m) => { if (m.type() === "error") consoleErrs.push({ t: Date.now() - t0Wall, text: m.text().slice(0, 300) }); });

// liveScene3d attaches well after in-world.
for (let i = 0; i < 90; i++) {
  if (await evalIn(() => !!(window.liveScene3d && window.liveScene3d.scene))) break;
  await page.waitForTimeout(1000);
}

const sendChat = (c) => evalIn((cmd) => { try { window.__sessionHandle.sendChat(cmd); } catch (_) {} }, c);
const lbHigh = () => evalIn(() => {
  try { const p = window.__sessionHandle.getLocalPlayerPose();
        return p && p.landblockId != null ? (p.landblockId >>> 16) & 0xffff : null; }
  catch (_) { return null; }
});

// ── COLD-ENTRY PRE-FLIGHT (2026-07-11, arm-order confound fix) ──
// A character parked at the destination boots INSIDE the dungeon: the client
// builds all 205 EnvCells at boot, and under warm-park the built+parked state
// (baked marks) persists for the whole page session — the later "entry" is a
// warm pointer re-attach, not the user's cold portal entry. If we spawned in
// the destination LB, move the character OUT and RELOAD the page (a fresh
// client session is the only way to drop the marks), then re-enter world.
{
  const spawnLb = await lbHigh();
  if (spawnLb === DEST_LB_HIGH) {
    console.error("[portal-settle] pre-flight: spawned INSIDE dest — teleporting out + reloading for a cold client");
    await evalIn((c) => { try { window.__sessionHandle.sendChat(c); } catch (_) {} }, "@telepoi Rithwic");
    for (let i = 0; i < 24; i++) {
      await page.waitForTimeout(500);
      if ((await lbHigh()) !== DEST_LB_HIGH) break;
    }
    // Reconnect loop. ACE holds an in-world session through its logout
    // linger (observed >36 s: a reconnect inside it gets a silent connect
    // TIMEOUT, and the client only attempts login once per page load), so
    // park on about:blank to drop the connection, then re-navigate up to 5
    // times ~35 s apart — each navigation is one fresh login attempt, and
    // the loop converges as soon as ACE frees the account.
    const returnUrl = page.url();
    await page.goto("about:blank", { timeout: 30_000 });
    let back = false;
    for (let attempt = 0; attempt < 5 && !back; attempt++) {
      await page.waitForTimeout(35_000);
      await page.goto(returnUrl, { timeout: 60_000 });
      for (let i = 0; i < 90; i++) {
        const st = await evalIn(() => ({
          bs: window.__bootState,
          // SwiftShader real-render trap: 'scene-ready' 90 s timeout can set
          // __bootState='error' though in-world was reached — trust history.
          sawInWorld: Array.isArray(window.__bootStateHistory)
            && window.__bootStateHistory.some((h) => h && h.state === "in-world"),
          pose: (() => { try { return !!window.__sessionHandle?.getLocalPlayerPose(); } catch (_) { return false; } })(),
        })).catch(() => null);
        if (st && (st.bs === "in-world" || st.bs === "ready" || st.sawInWorld) && st.pose) { back = true; break; }
        if (st && st.bs === "error") break; // connect timeout — next attempt
        await page.waitForTimeout(500);
      }
      if (!back) {
        console.error(`[portal-settle] pre-flight reconnect attempt ${attempt + 1} failed; retrying`);
        await page.goto("about:blank", { timeout: 30_000 }).catch(() => {});
      }
    }
    if (!back) {
      console.log(JSON.stringify({ ok: false, reason: "preflight-reload-stalled", label: LABEL }));
      console.log("PORTAL-SETTLE SUMMARY: SKIP preflight-reload-stalled");
      await closeFn(); process.exit(2);
    }
    for (let i = 0; i < 90; i++) {
      if (await evalIn(() => !!(window.liveScene3d && window.liveScene3d.scene))) break;
      await page.waitForTimeout(1000);
    }
    const lbNow = await lbHigh();
    console.error(`[portal-settle] pre-flight reload complete; spawn LB high16=0x${(lbNow ?? 0).toString(16)}`);
    if (lbNow === DEST_LB_HIGH) {
      console.log(JSON.stringify({ ok: false, reason: "preflight-still-in-dest", label: LABEL }));
      console.log("PORTAL-SETTLE SUMMARY: SKIP preflight-still-in-dest (character did not persist outside dest)");
      await closeFn(); process.exit(2);
    }
  }
}

// ── accumulation leg (mature-session residency; the real player enters TN
// from a town after playing, not from a cold boot) ──
const accumStats = [];
for (const poi of ACCUMULATE) {
  const before = await lbHigh();
  await sendChat("@telepoi " + poi);
  let moved = false;
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(500);
    const now = await lbHigh();
    if (now != null && now !== before) { moved = true; break; }
  }
  if (moved) await page.waitForTimeout(DWELL_S * 1000);
  const lru = await evalIn(() => window.liveScene3d?.landblockLru?.entries?.size ?? null);
  accumStats.push({ poi, moved, lru });
}
if (ACCUMULATE.length) console.error(`[portal-settle] accumulate: ${accumStats.map((a) => `${a.poi}:${a.moved ? a.lru : "SKIP"}`).join(" ")}`);

// ── stage the portal-entry (portal mode): move beside the real portal NOW,
// BEFORE the recorder baseline, so the staging teleport isn't in the window ──
let portalGuid = null, portalEntityName = null;
if (ENTRY === "portal") {
  await sendChat(PORTAL_STAGE_TELELOC);
  await page.waitForTimeout(4000); // let the local area stream + entities spawn
  for (let i = 0; i < 20 && !portalGuid; i++) {
    const hit = await evalIn((needle) => {
      try {
        const em = window.liveScene3d?.entityManager;
        if (!em?.entityMap) return null;
        for (const [g, inst] of em.entityMap) {
          const n = (inst?.meta?.name || "").toLowerCase();
          if (n.includes(needle)) return { guid: g >>> 0, name: inst.meta.name };
        }
        return null;
      } catch (_) { return null; }
    }, PORTAL_NAME_NEEDLE);
    if (hit) { portalGuid = hit.guid; portalEntityName = hit.name; break; }
    await page.waitForTimeout(1000);
  }
  console.error(`[portal-settle] portal entity: ${portalEntityName ?? "NOT FOUND"} guid=${portalGuid ?? "-"}`);
}

// ── record ──
await evalIn(installRecorder);
await page.waitForTimeout(BASELINE_S * 1000);
const mark = (label) => evalIn((l) => { window.__psRec.marks.push({ t: +(performance.now() - window.__psRec.t0).toFixed(0), label: l }); }, label);

let landed = false, usedEntry = null;
if (ENTRY === "portal" && portalGuid) {
  await mark("portal-used");
  await evalIn((g) => { try { window.__sessionHandle.useObject(g >>> 0); } catch (_) {} }, portalGuid);
  for (let i = 0; i < 40; i++) { // portals have a use animation + delay; up to 20s
    await page.waitForTimeout(500);
    if ((await lbHigh()) === DEST_LB_HIGH) { landed = true; usedEntry = "portal:" + portalEntityName; break; }
  }
}
if (!landed) {
  for (const cand of ["@telepoi " + DEST, DEST_TELELOC]) {
    await mark("teleport-sent:" + cand);
    await sendChat(cand);
    for (let i = 0; i < 20; i++) {
      await page.waitForTimeout(500);
      if ((await lbHigh()) === DEST_LB_HIGH) { landed = true; usedEntry = cand; break; }
    }
    if (landed) break;
  }
}
if (landed) await mark("landed");
await page.waitForTimeout(RECORD_S * 1000);
const raw = await evalIn(stopRecorder);
const errors = helpers ? helpers.consoleErrors() : consoleErrs;

// ───────────────────────── settle computation ─────────────────────────
const buckets = (raw && raw.buckets) || [];
const marks = (raw && raw.marks) || [];
const tEntry = (marks.find((m) => m.label === "portal-used" || m.label.startsWith("teleport-sent")) || {}).t ?? null;
const tLand = (marks.find((m) => m.label === "landed") || {}).t ?? null;
const post = buckets.filter((b) => tLand != null && b.t >= tLand);
const lt = (raw && raw.longTasks) || [];
const ltIn = (a, b) => lt.filter((e) => e.t >= a && e.t < b);
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

// stage marks from the timeline
const firstWhere = (pred) => { const b = post.find(pred); return b ? b.t : null; };
const tIndoor = firstWhere((b) => b.indoor === true);
const cellsAtLand = num(post[0]?.cells) ?? 0;
const tFirstCell = firstWhere((b) => num(b.cells) != null && b.cells > cellsAtLand);
const cellsMax = Math.max(0, ...post.map((b) => num(b.cells) ?? 0));
// Absolute thresholds: cellContainers3d is a live Map that SHRINKS on evict
// (the sealed purge drops the origin town's cells), so a relative
// "cellsAtLand + N" target can be unreachable. TN's own 205 dominate the
// post-purge population; absolute readings are the honest completeness signal.
const tCellsHalf = EXPECT_CELLS > 0 ? firstWhere((b) => (num(b.cells) ?? 0) >= Math.floor(EXPECT_CELLS / 2)) : null;
const tCellsFull = EXPECT_CELLS > 0 ? firstWhere((b) => (num(b.cells) ?? 0) >= EXPECT_CELLS) : null;

// frames recovered: 4 consecutive buckets maxDt<50
let tFramesRecovered = null;
for (let i = 0; i + 3 < post.length; i++) {
  if ([0, 1, 2, 3].every((k) => post[i + k].maxDt != null && post[i + k].maxDt < 50)) { tFramesRecovered = post[i].t; break; }
}
// chat-ready: 8 consecutive 250ms buckets with lagMax<100 (2s of typeable UI)
let tChatReady = null;
for (let i = 0; i + 7 < post.length; i++) {
  if ([...Array(8).keys()].every((k) => post[i + k].lagMax != null && post[i + k].lagMax < 100)) { tChatReady = post[i].t; break; }
}
// complete settlement: 3s (12 buckets) window, all conditions
const winN = 12;
let tSettle = null, settleBlockers = {};
for (let i = 0; i + winN - 1 < post.length; i++) {
  const w = post.slice(i, i + winN);
  const a = w[0], z = w[w.length - 1];
  const blockers = [];
  if (ltIn(a.t, z.t + 250).some((e) => e.ms > 100)) blockers.push("longtask");
  if (!w.every((b) => b.lagP95 == null || b.lagP95 < 50)) blockers.push("inputLag");
  if (num(z.cells) != null && num(a.cells) != null && z.cells !== a.cells) blockers.push("cellsGrowing");
  if (w.some((b) => num(b.envInFlight) != null && b.envInFlight > 0)) blockers.push("envInFlight");
  if (num(z.bakeSeq) != null && num(a.bakeSeq) != null && z.bakeSeq !== a.bakeSeq) blockers.push("bakeQueue");
  if (num(z.entities) != null && num(a.entities) != null && Math.abs(z.entities - a.entities) > 1) blockers.push("entities");
  const dPark = (num(z.lru?.parked) ?? 0) - (num(a.lru?.parked) ?? 0);
  const dUnpark = (num(z.lru?.unparked) ?? 0) - (num(a.lru?.unparked) ?? 0);
  const dEvict = (num(z.lru?.evicted) ?? 0) - (num(a.lru?.evicted) ?? 0);
  if (dPark + dUnpark + dEvict > 0) blockers.push("lruChurn");
  if (blockers.length === 0) { tSettle = a.t; break; }
  for (const bl of blockers) settleBlockers[bl] = (settleBlockers[bl] || 0) + 1;
}
// late-freeze census: long tasks >500ms AFTER first settle (the "it froze
// again 30s later" class)
const lateFreezes = tSettle != null ? lt.filter((e) => e.t > tSettle && e.ms > 500) : [];

const stages = {
  label: LABEL, entry: usedEntry, tEntryMs: tEntry, tLandedMs: tLand,
  landToIndoorMs: tIndoor != null && tLand != null ? tIndoor - tLand : null,
  landToFirstCellMs: tFirstCell != null && tLand != null ? tFirstCell - tLand : null,
  landToCellsHalfMs: tCellsHalf != null && tLand != null ? tCellsHalf - tLand : null,
  landToCellsFullMs: tCellsFull != null && tLand != null ? tCellsFull - tLand : null,
  cellsMax, expectCells: EXPECT_CELLS,
  landToFramesRecoveredMs: tFramesRecovered != null && tLand != null ? tFramesRecovered - tLand : null,
  landToChatReadyMs: tChatReady != null && tLand != null ? tChatReady - tLand : null,
  landToSettleMs: tSettle != null && tLand != null ? tSettle - tLand : null,
  settleBlockerCensus: settleBlockers,
  lateFreezes: lateFreezes.slice(0, 20),
  longTask: {
    n: lt.length, totalMs: lt.reduce((s, e) => s + e.ms, 0),
    maxMs: lt.reduce((s, e) => Math.max(s, e.ms), 0),
    over500: lt.filter((e) => e.ms > 500).length,
  },
  gcDrops: raw?.gcDrops ?? null,
};

const payload = {
  ok: landed, label: LABEL, mode: MODE, render: RENDER, query: EXTRA_QUERY || null,
  account: ACCOUNT || "(boot.mjs default)", dest: DEST, entryMode: ENTRY,
  portalEntityName, accumulate: accumStats,
  stages, marks, timeline: buckets, longTasks: lt,
  netFailures: netFailures.slice(0, 200),
  consoleErrorCount: errors.length, consoleErrors: errors.slice(0, 30),
};
const json = JSON.stringify(payload, null, 1);
if (OUT) fs.writeFileSync(OUT, json);
else console.log(json);
console.log(`PORTAL-SETTLE SUMMARY: label=${LABEL} landed=${landed} entry=${usedEntry} ` +
  `land→chatReady=${stages.landToChatReadyMs}ms land→framesOk=${stages.landToFramesRecoveredMs}ms ` +
  `land→cellsFull=${stages.landToCellsFullMs}ms (cellsMax=${cellsMax}/${EXPECT_CELLS}) ` +
  `land→SETTLE=${stages.landToSettleMs}ms blockers=${JSON.stringify(settleBlockers)} ` +
  `lateFreezes=${lateFreezes.length} ltMax=${stages.longTask.maxMs}ms lt>500=${stages.longTask.over500} ` +
  `gcDrops=${stages.gcDrops} netFail=${netFailures.length} errors=${errors.length}`);
// Post-run courtesy: park the character OUTSIDE the destination so the NEXT
// run boots cold without needing the pre-flight reload (whose local-mode
// reload leg is unreliable — the teleport-out half is what matters).
try {
  if ((await lbHigh()) === DEST_LB_HIGH) {
    await sendChat("@telepoi Rithwic");
    for (let i = 0; i < 16; i++) {
      await page.waitForTimeout(500);
      if ((await lbHigh()) !== DEST_LB_HIGH) break;
    }
    await page.waitForTimeout(3000); // let ACE persist the position
  }
} catch (_) {}
await closeFn();
process.exit(landed ? 0 : 1);
