#!/usr/bin/env node
// telepoi-bakewait-capture.mjs — rapid-telepoi bake-wait capture (session 8,
// 1115 §4 top item; kept for the owed worker-FIFO investigation, 1116 §4).
// Boots a nullRender bot, hops through distant towns FASTER than settle
// (~4s dwell vs ~15s settleMed) so each landing races the previous town's
// speculative ring. After each landing, snapshots:
//   - the current LB 3×3 guard wait-records (scene3d._streamGuardState.waitLog)
//     → pre-admission waitMs / skip attribution / urgentAsks engagement
//   - __diag.bakeWait() totals, __diag.bakeWorkerStats() (worker FIFO half)
//   - LRU stats (park churn correlation)
// Verdict question (1115 §1): does the current LB wait PRE-ADMISSION (guard
// cap; urgentAsks=0 ⇒ staleness reaches isNearPlayerLb) or IN-RUN (fetch
// semaphore / worker FIFO)? → choose flush vs priority.
import { pathToFileURL } from "node:url";
import { writeFileSync } from "node:fs";

const BOOT_MJS = process.env.BOOT_MJS ||
  "/home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/apps/holtburger-web/harness/lib/boot.mjs";
const OUT = process.env.OUT || "telepoi-bakewait.json";

const HOPS = [
  "Holtburg", "Rithwic", "Eastham", "Cragstone", "Arwic",
  "Glenden Wood", "Zaikhal", "Yaraq", "Samsur", "Nanto",
];

const boot = await import(pathToFileURL(BOOT_MJS).href);
const { page, helpers, inWorld } = await boot.launchAndEnter({
  query: { nosw: "1" }, timeoutMs: 120_000 });
if (!inWorld) { console.log("CAPTURE: SKIP boot-stalled"); await helpers.close(); process.exit(2); }
for (let i = 0; i < 90; i++) {
  if (await helpers.evalInPage(() => !!(window.liveScene3d && window.liveScene3d.scene))) break;
  await page.waitForTimeout(1000);
}

// One in-page probe: current lb + 3×3 guard recs + totals + worker + lru.
const snap = (label) => helpers.evalInPage((l) => {
  const s = window.liveScene3d;
  const now = performance.now();
  const cur = (() => { try { return s.landblockLru.getCurrentLbId() >>> 0; } catch (_) { return 0; } })();
  const curKey = (cur & 0xffff0000) >>> 0;
  const cx = (curKey >>> 24) & 0xff, cy = (curKey >>> 16) & 0xff;
  const near = [];
  const wl = s?._streamGuardState?.waitLog;
  if (wl instanceof Map) {
    for (const [gk, r] of wl) {
      const x = (r.lbKey >>> 24) & 0xff, y = (r.lbKey >>> 16) & 0xff;
      if (Math.max(Math.abs(x - cx), Math.abs(y - cy)) <= 1) {
        near.push({ gk, cheb: Math.max(Math.abs(x - cx), Math.abs(y - cy)),
          cycles: r.cycles, asks: r.asks, urgentAsks: r.urgentAsks,
          skipInFlight: r.skipInFlight, skipCooldown: r.skipCooldown, skipCap: r.skipCap,
          firstAskMs: Math.round(r.firstAskMs), lastAskMs: Math.round(r.lastAskMs),
          startMs: r.startMs == null ? null : Math.round(r.startMs),
          waitMs: r.waitMs == null ? null : Math.round(r.waitMs),
          durMs: r.durMs == null ? null : Math.round(r.durMs),
          inFlightAtStart: r.inFlightAtStart, ok: r.ok });
      }
    }
  }
  const bw = window.__diag?.bakeWait ? window.__diag.bakeWait({ top: 3 }) : null;
  const lru = s?.landblockLru?.getStats?.() ?? {};
  return {
    label: l, nowMs: Math.round(now),
    curLbHi16: (curKey >>> 16).toString(16).padStart(4, "0"),
    inFlightNow: s?._streamGuardState?.inFlight?.size ?? null,
    near,
    totals: bw?.totals ?? null, waitLogKeys: bw?.keys ?? null,
    worker: window.__diag?.bakeWorkerStats ? window.__diag.bakeWorkerStats() : null,
    lru: { resident: lru.resident, parked: lru.parked, parkedTotal: lru.parkedTotal,
      unparkedTotal: lru.unparkedTotal, evicted: lru.evicted,
      trackMergedWhileParked: lru.trackMergedWhileParked,
      reclaimDeferredInFlight: lru.reclaimDeferredInFlight },
    terrainMarks: s?.terrainBakedLbs?.size ?? null,
  };
}, label);

const chat = (c) => helpers.evalInPage((cmd) => { try { window.__sessionHandle.sendChat(cmd); } catch (_) {} }, c);

const out = { startedAt: new Date().toISOString(), hops: [] };
out.baseline = await snap("baseline");
console.log("baseline lb=" + out.baseline.curLbHi16 + " keys=" + out.baseline.waitLogKeys);

for (const poi of HOPS) {
  const before = (await snap("pre")).curLbHi16;
  const tSend = await helpers.evalInPage(() => Math.round(performance.now()));
  await chat("@telepoi " + poi);
  let landed = false, tLand = null;
  for (let i = 0; i < 60; i++) {
    await page.waitForTimeout(250);
    const cur = (await snap("poll")).curLbHi16;
    if (cur !== before && cur !== "0000") { landed = true; tLand = await helpers.evalInPage(() => Math.round(performance.now())); break; }
  }
  const hop = { poi, tSend, tLand, landed };
  if (landed) {
    await page.waitForTimeout(1000);
    hop.at1s = await snap(poi + "+1s");
    await page.waitForTimeout(3000);
    hop.at4s = await snap(poi + "+4s");
    console.log(`${poi}: lb=${hop.at4s.curLbHi16} near=${hop.at4s.near.length} ` +
      `urgent=${hop.at4s.near.reduce((a, r) => a + r.urgentAsks, 0)} ` +
      `skipCap(tot)=${hop.at4s.totals?.skipCap} inFlight=${hop.at4s.inFlightNow} ` +
      `workerPend=${hop.at4s.worker?.pendingNow}`);
  } else {
    console.log(`${poi}: NO LANDING (lb stayed ${before})`);
  }
  out.hops.push(hop);
}

// settle + final full summary
await page.waitForTimeout(30_000);
out.final = await snap("final");
out.finalSummary = await helpers.evalInPage(() => window.__diag.bakeWait({ top: 40 }));
out.consoleErrors = helpers.consoleErrors().filter((e) => !/404|Failed to load resource/.test(e.text)).map((e) => e.text).slice(0, 40);
writeFileSync(OUT, JSON.stringify(out, null, 1));
console.log("WROTE " + OUT);
await helpers.close();
