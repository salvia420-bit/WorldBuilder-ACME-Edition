#!/usr/bin/env node
// tn-teleport-freeze-probe.mjs — S2: stage-attributed 60s timeline of a
// Town Network teleport, for correlation with A08's timeline.
//
// TN ground truth (docs/sealed-dungeon-cull-2026-07-08.md): landblock 0x0007,
// spawn cell 0x00070143, pose 70 -60 0. @telepoi candidates then @teleloc.
//
// Laptop note: runs under ?nullRender=1 (mandatory headless), so
// renderer.info counters stay flat — the CPU-side signals (rAF gaps, long
// tasks, residency churn, bake/evict backlogs) are exactly S2's domain.
// On the 1070 (CDP) reuse the in-page recorder verbatim; see marketplace-ab-1070.md.
//
// Usage: node tn-teleport-freeze-probe.mjs [--record 60] [--baseline 10] [--out f.json]
// Output: JSON timeline + trailing "TN-PROBE SUMMARY: ..." line.

import { pathToFileURL } from "node:url";
import fs from "node:fs";

const BOOT_MJS = process.env.BOOT_MJS ||
  "/home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/apps/holtburger-web/harness/lib/boot.mjs";
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };
const RECORD_S = Number(arg("record", "60"));
const BASELINE_S = Number(arg("baseline", "10"));
const OUT = arg("out", "");
const TN_LB_HIGH16 = 0x0007;
const TELE_CANDIDATES = ["Town Network", "TN", "TownNetwork"];
const TELELOC_FALLBACK = "@teleloc 0x00070143 70 -60 0";

// In-page recorder: rAF deltas + longtasks + 500ms sampler of residency/renderer/diag.
const installRecorder = () => {
  if (window.__tnRec) return { ok: true, already: true };
  const rec = { t0: performance.now(), frames: [], lastRaf: null, buckets: [],
                longTasks: [], stopped: false, marks: [] };
  window.__tnRec = rec;
  const raf = (now) => {
    if (rec.stopped) return;
    if (rec.lastRaf != null) rec.frames.push(now - rec.lastRaf);
    rec.lastRaf = now;
    requestAnimationFrame(raf);
  };
  requestAnimationFrame(raf);
  try {
    rec.obs = new PerformanceObserver((list) => {
      for (const e of list.getEntries())
        rec.longTasks.push({ t: +(e.startTime - rec.t0).toFixed(0), ms: +e.duration.toFixed(0) });
    });
    rec.obs.observe({ entryTypes: ["longtask"] });
  } catch (_) { rec.obs = null; } // Chromium-only; feature-detected
  // renderer counters: flip autoReset off and diff (install-recorder.js convention)
  try {
    const r = window.liveScene3d && window.liveScene3d.renderer;
    if (r && r.info) { rec.prevAutoReset = r.info.autoReset; r.info.autoReset = false; }
  } catch (_) {}
  let framesSeen = 0, lastCalls = 0;
  rec.sampler = setInterval(() => {
    try {
      const t = +(performance.now() - rec.t0).toFixed(0);
      const s3 = window.liveScene3d; // may be transiently null mid-teleport
      const h = window.__sessionHandle;
      let pose = null; try { pose = h && h.getLocalPlayerPose(); } catch (_) {}
      const dts = rec.frames.slice(framesSeen);
      framesSeen = rec.frames.length;
      const r = s3 && s3.renderer, ri = r && r.info;
      const calls = ri ? ri.render.calls : 0;
      const b = {
        t,
        frames: dts.length,
        maxDt: dts.length ? +Math.max(...dts).toFixed(0) : null,
        lb: pose && pose.landblockId != null ? (pose.landblockId >>> 0) : null,
        indoor: (() => { try { return h ? h.isCurrentCellIndoor() : null; } catch (_) { return null; } })(),
        terrainLbs: s3 && s3.terrainBakedLbs ? s3.terrainBakedLbs.size : null,
        staticsLbs: s3 && s3.staticsBakedLbs ? s3.staticsBakedLbs.size : null,
        staticsChildren: s3 && s3.staticsGroup ? s3.staticsGroup.children.length : null,
        lru: s3 && s3.landblockLru && s3.landblockLru.entries ? s3.landblockLru.entries.size : null,
        fallbackHits: s3 && s3.materialCache ? (s3.materialCache.fallbackHits ?? null) : null,
        missingSurfaces: s3 && s3.materialCache && s3.materialCache.missingSurfaces
          ? s3.materialCache.missingSurfaces.size : null,
        programs: ri && Array.isArray(ri.programs) ? ri.programs.length : null,
        geometries: ri ? ri.memory.geometries : null,
        textures: ri ? ri.memory.textures : null,
        dCalls: ri ? calls - lastCalls : null,
        wireTotal: (() => { try { return window.__diag?.wire?.summary?.().total ?? null; } catch (_) { return null; } })(),
        pumpAgeMs: window.__lastPumpMs != null ? +(performance.now() - window.__lastPumpMs).toFixed(0) : null,
      };
      lastCalls = calls;
      rec.buckets.push(b);
    } catch (_) { /* never break the page */ }
  }, 500);
  return { ok: true };
};
const stopRecorder = () => {
  const rec = window.__tnRec;
  if (!rec) return null;
  rec.stopped = true;
  try { clearInterval(rec.sampler); } catch (_) {}
  try { rec.obs && rec.obs.disconnect(); } catch (_) {}
  try {
    const r = window.liveScene3d && window.liveScene3d.renderer;
    if (r && rec.prevAutoReset != null) r.info.autoReset = rec.prevAutoReset;
  } catch (_) {}
  return { buckets: rec.buckets, longTasks: rec.longTasks, marks: rec.marks,
           frameCount: rec.frames.length };
};

const boot = await import(pathToFileURL(BOOT_MJS).href);
const { page, helpers, inWorld } = await boot.launchAndEnter({ query: { nosw: "1" }, timeoutMs: 120_000 });
if (!inWorld) {
  console.log(JSON.stringify({ ok: false, reason: "boot-stalled" }));
  console.log("TN-PROBE SUMMARY: SKIP boot-stalled");
  await helpers.close(); process.exit(2);
}
for (let i = 0; i < 90; i++) {
  if (await helpers.evalInPage(() => !!(window.liveScene3d && window.liveScene3d.scene))) break;
  await page.waitForTimeout(1000);
}
await helpers.evalInPage(installRecorder);
await page.waitForTimeout(BASELINE_S * 1000);

// Teleport: mark, try @telepoi candidates until the landblock goes 0x0007.
const mark = (label) => helpers.evalInPage((l) =>
  { window.__tnRec.marks.push({ t: +(performance.now() - window.__tnRec.t0).toFixed(0), label: l }); }, label);
const curLbHigh = () => helpers.evalInPage(() => {
  try { const p = window.__sessionHandle.getLocalPlayerPose();
        return p && p.landblockId != null ? (p.landblockId >>> 16) & 0xFFFF : null; }
  catch (_) { return null; }
});
let landed = false, usedCmd = null;
for (const cand of [...TELE_CANDIDATES.map((c) => "@telepoi " + c), TELELOC_FALLBACK]) {
  await mark("teleport-sent:" + cand);
  await helpers.evalInPage((c) => { try { window.__sessionHandle.sendChat(c); } catch (_) {} }, cand);
  for (let i = 0; i < 20; i++) {           // up to 10s to land per candidate
    await page.waitForTimeout(500);
    if ((await curLbHigh()) === TN_LB_HIGH16) { landed = true; break; }
  }
  if (landed) { usedCmd = cand; await mark("landed"); break; }
}
await page.waitForTimeout(RECORD_S * 1000); // record the freeze window regardless
const raw = await helpers.evalInPage(stopRecorder);
const errors = helpers.consoleErrors();

// ── stage attribution (Node-side, for A08) ──
const buckets = (raw && raw.buckets) || [];
const tSent = (raw.marks.find((m) => m.label.startsWith("teleport-sent")) || {}).t ?? null;
const tLand = (raw.marks.find((m) => m.label === "landed") || {}).t ?? null;
const after = (t) => buckets.filter((b) => t != null && b.t >= t);
let tPeak = null, peak = -1;
for (const b of after(tLand)) if (b.lru != null && b.lru > peak) { peak = b.lru; tPeak = b.t; }
const tDrained = (after(tPeak).find((b) => b.lru != null && b.lru <= 3) || {}).t ?? null;
// recovered = first bucket after landing where this and the next 3 buckets all maxDt<50
let tRecovered = null;
const post = after(tLand);
for (let i = 0; i + 3 < post.length; i++) {
  if ([0, 1, 2, 3].every((k) => post[i + k].maxDt != null && post[i + k].maxDt < 50)) {
    tRecovered = post[i].t; break;
  }
}
const zeroFrameBuckets = post.filter((b) => b.frames === 0).length;
let worstGap = 0, gapRun = 0;
for (const b of post) { gapRun = b.frames === 0 ? gapRun + 500 : 0; worstGap = Math.max(worstGap, gapRun); }
const stages = {
  usedCmd, tSentMs: tSent, tLandedMs: tLand, tResidencyPeakMs: tPeak, residencyPeakLbs: peak,
  tEvictDrainedMs: tDrained, tFramesRecoveredMs: tRecovered,
  sustainedSlow: { zeroFrameBuckets, worstNoFrameGapMs: worstGap,
                   longTaskTotalMs: raw.longTasks.reduce((a, e) => a + e.ms, 0),
                   longTaskMaxMs: raw.longTasks.reduce((a, e) => Math.max(a, e.ms), 0) },
};
const payload = { ok: landed, landed, stages, timeline: buckets, longTasks: raw.longTasks,
                  marks: raw.marks, consoleErrorCount: errors.length,
                  consoleErrors: errors.slice(0, 20) };
const json = JSON.stringify(payload, null, 2);
if (OUT) fs.writeFileSync(OUT, json);
console.log(json);
console.log(`TN-PROBE SUMMARY: landed=${landed} via=${usedCmd} ` +
  `land→recovered=${tRecovered != null && tLand != null ? tRecovered - tLand : "NEVER"}ms ` +
  `lruPeak=${peak} drained@=${tDrained} worstNoFrameGap=${worstGap}ms ` +
  `longTaskMax=${stages.sustainedSlow.longTaskMaxMs}ms errors=${errors.length}`);
await helpers.close();
process.exit(landed ? 0 : 1);
