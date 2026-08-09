// harness/moving-bench.mjs — a REPEATABLE moving benchmark for one arm.
//
// THE PROBLEM IT REPLACES (2026-08-06)
// ------------------------------------
// The moving arm of the frame-cost investigation was unusable and the reason
// was mechanical, not statistical. The rig spun the camera with a per-frame
//     window.__cam.player(dist, az, el, dz)
// whose azimuth advanced on WALL CLOCK and whose centre was the LIVE player
// pose. A slower arm therefore swept a shorter arc from a slightly different
// place, so it streamed and frustum-culled a different amount:
//
//   ?statBatchMemo=slack, moving:  off [28.5, 33.6, 27.0]  slack [29.6, 19.0, 22.4]
//                                  delta 6.10 ms | control spread 6.60 ms
//
// The control was wider than the effect. Parked runs on the same box held
// 0.7-2.3 ms, so nothing about the box or the sampler was at fault — only how
// motion was produced. Two conclusions were lost to it.
//
// WHAT THIS DOES INSTEAD
// ----------------------
//  1. The camera path is a TABLE computed in node (`lib/moving_path.mjs`) and
//     indexed by FRAME NUMBER. Frame k gets pose k whether it took 12 ms or
//     40 ms, so two arms traverse identical geometry at different fps.
//  2. The run length is a FRAME COUNT, never a duration. A duration would put
//     the measured quantity back into the independent variable.
//  3. The anchor is PINNED on the command line, never read from the live pose.
//  4. A warm lap streams and compiles; the measure lap is the identical lap.
//  5. Every run reports what it would take to REJECT it: the intended path
//     checksum, the REALISED path checksum, resident-landblock churn, and the
//     per-frame draw/triangle spread. A run that diverged is thrown away, not
//     averaged in — the overnight census produced 42 runs of unusable data
//     because its baseline drifted 2.44x and nothing checked.
//
// It does NOT own Chrome. Chrome lifecycle (relaunch between arms — reusing one
// Chrome degrades it 2.44x over ~100 minutes) stays in the operator's existing
// flow; this connects to a CDP endpoint that is already up, runs ONE arm, and
// prints a JSON report. Interleave arms by invoking it repeatedly.
//
// INVOCATION
// ----------
//   node harness/moving-bench.mjs --cdp=http://127.0.0.1:9333 \
//        --anchor=25171,20344,42.0 --mode=orbit --frames=600 --laps=1 \
//        --account=tailnet1 --poi=Nanto \
//        --arm='statBatchSphere=on&statBatchMemo=off' \
//        --out=/tmp/mb-sphere-on.json
//
//   # the control arm is the same line with --arm='' (or --arm=default)
//
// Getting the anchor ONCE, then pinning it forever:
//   in the page, `@telepoi Nanto` then `__cam.world()` -> {x, y, z}
//   (or `@loc` and fold the landblock: x = ((cell>>>24)&0xff)*192 + localX).
//
// hop mode (the arm that deliberately DOES stream):
//   --mode=hop --hops=0x9722003a:80:80:42,0x9622003a:80:80:42 --dwell=120
//
// FLAGS THE RUN NEEDS ON THE PAGE (added automatically unless --url is given):
//   ?camDebug=on        installs window.__cam            (required)
//   ?vfxGauge=on        per-frame CPU time               (required for cpuMs)
//   ?renderOnDemand=1   one render per pose              (drive=ondemand)
//   ?renderDiag=on      draws/triangles/nodes
//   ?nosw=1             or the service worker serves a stale build
//   ?agent=1 &autoLogin ...  headless login

import { writeFileSync } from "node:fs";
import { poseTable } from "./lib/moving_path.mjs";
import { movingRigSource } from "./lib/moving_rig.mjs";
import { createReport } from "./lib/report.mjs";

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const hit = argv.find((a) => a === `--${k}` || a.startsWith(`--${k}=`));
  if (!hit) return d;
  const eq = hit.indexOf("=");
  return eq < 0 ? true : hit.slice(eq + 1);
};
const num = (k, d) => { const v = arg(k, null); return v == null ? d : Number(v); };

const CDP = String(arg("cdp", "") || "");
const OUT = String(arg("out", "/tmp/moving-bench.json"));
const MODE = String(arg("mode", "orbit"));
const ACCOUNT = String(arg("account", "tailnet1"));
const POI = String(arg("poi", "Nanto"));
const ARM = String(arg("arm", "") || "").replace(/^default$/, "");
const DRIVE = String(arg("drive", "ondemand"));
const SETTLE_MS = num("settle", 45000);
const BOOT_MS = num("bootTimeout", 160000);
const BASE = String(arg("base", "http://127.0.0.1:8765/apps/holtburger-web/index.html"));
// Repeatability budgets. A run outside them is REJECTED, not averaged in.
const CHURN_MAX = num("churnMax", MODE === "hop" ? 1e9 : 0);
const DRAW_SPREAD_MAX = num("drawSpreadMax", 0.05);

function parseAnchor(s) {
  if (!s || s === true) return null;
  const p = String(s).split(",").map(Number);
  if (p.length !== 3 || p.some((v) => !Number.isFinite(v))) throw new Error(`--anchor=x,y,z expected, got ${s}`);
  return { x: p[0], y: p[1], z: p[2] };
}
function parseHops(s) {
  if (!s || s === true) return null;
  return String(s).split(",").map((tok) => {
    const f = tok.split(":");
    if (f.length !== 4) throw new Error(`--hops entry must be cell:x:y:z, got ${tok}`);
    return { cell: Number(f[0]) >>> 0, x: Number(f[1]), y: Number(f[2]), z: Number(f[3]) };
  });
}

export function buildSpec() {
  return {
    mode: MODE,
    frames: num("frames", 600),
    anchor: parseAnchor(arg("anchor", null)),
    dist: num("dist", 26),
    el: num("el", 18),
    elAmp: num("elAmp", 0),
    az0: num("az0", 0),
    laps: num("laps", 1),
    dz: num("dz", 1.2),
    hops: parseHops(arg("hops", null)),
    dwell: num("dwell", 120),
  };
}

export function buildUrl(arm) {
  const explicit = arg("url", null);
  if (explicit && explicit !== true) return String(explicit);
  const flags = [
    "nosw=1", "quality=mid", "adaptiveRes=off", "renderScale=1",
    "renderDiag=on", "camDebug=on", "vfxGauge=on",
    `autoLogin=1&account=${ACCOUNT}&password=${ACCOUNT}&autoSpawn=first&agent=1`,
  ];
  if (DRIVE === "ondemand") flags.push("renderOnDemand=1", "netDrainHz=30");
  if (arm) flags.push(arm);
  return `${BASE}?${flags.join("&")}`;
}

const pct = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return +s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))].toFixed(2); };
const mean = (a) => (a.length ? +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(2) : null);
const stat = (a) => (a.length ? { n: a.length, p50: pct(a, 50), p95: pct(a, 95), p99: pct(a, 99), mean: mean(a), min: +Math.min(...a).toFixed(2), max: +Math.max(...a).toFixed(2) } : null);

/**
 * The verdict. A harness that cannot prove its own repeatability is worse than
 * none, so this is deliberately quick to say NO.
 */
export function judge(rep, opts) {
  const reasons = [];
  if (rep.realisedChecksum !== rep.pathChecksum) {
    reasons.push(`DIVERGED-PATH (realised ${rep.realisedChecksum} != intended ${rep.pathChecksum}) `
      + "— the camera did not go where it was told. Check that ?camDebug=on installed __cam and "
      + "that nothing released the park.");
  }
  if (rep.frames.measured !== rep.frames.requested) {
    reasons.push(`SHORT (${rep.frames.measured}/${rep.frames.requested} frames)`);
  }
  if (rep.lb.churnFrames > opts.churnMax) {
    reasons.push(`DIVERGED-STREAM (${rep.lb.churnFrames} frames changed the resident landblock set, budget ${opts.churnMax}) `
      + "— this run streamed. It is not comparable to a run that did not; raise --settle or pick a "
      + "quieter anchor, or use --mode=hop where streaming is the point.");
  }
  const d = rep.workload.draws;
  if (d && d.mean > 0) {
    const spread = (d.max - d.min) / d.mean;
    if (spread > opts.drawSpreadMax) {
      reasons.push(`DIVERGED-WORKLOAD (per-frame draw spread ${(spread * 100).toFixed(1)}% > ${(opts.drawSpreadMax * 100).toFixed(0)}%)`);
    }
  }
  if (rep.errors && rep.errors.length) reasons.push(`ERRORS (${rep.errors.length})`);
  if (rep.missedGauge > rep.frames.requested * 0.02) {
    reasons.push(`GAUGE-GAPS (${rep.missedGauge} frames had no vfxGauge sample — is ?vfxGauge=on set?)`);
  }
  return { ok: reasons.length === 0, verdict: reasons.length === 0 ? "USABLE" : "REJECT", reasons };
}

async function main() {
  if (!CDP) {
    console.error("moving-bench: --cdp=<endpoint> is required. This harness never picks an endpoint for you —\n"
      + "the operator owns the test box and its Chrome lifecycle.");
    process.exit(2);
  }
  const spec = buildSpec();
  const table = poseTable(spec);
  const url = buildUrl(ARM);
  console.log(`[moving-bench] mode=${spec.mode} frames=${table.rows.length} laps=${spec.laps} drive=${DRIVE}`);
  console.log(`[moving-bench] path checksum ${table.checksum}  (identical across arms by construction)`);
  console.log(`[moving-bench] arm=${ARM || "(default)"}`);
  console.log(`[moving-bench] url=${url}`);

  const { chromium } = await import("playwright-core");
  const browser = await chromium.connectOverCDP(CDP);
  const ctx = browser.contexts()[0];
  for (const p of ctx.pages()) { if (p.url() !== "about:blank") await p.close().catch(() => {}); }
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e.message).slice(0, 160)));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 160)); });

  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
  const t0 = Date.now();
  for (;;) {
    const s = await page.evaluate(() => window.__bootState).catch(() => null);
    if (s === "ready" || s === "in-world") break;
    if (s === "error") { console.error("[moving-bench] BOOT-FAIL"); process.exit(1); }
    if (Date.now() - t0 > BOOT_MS) { console.error("[moving-bench] BOOT-TIMEOUT"); process.exit(1); }
    await new Promise((r) => setTimeout(r, 700));
  }
  if (spec.mode !== "hop") {
    await page.evaluate((p) => window.__sessionHandle?.sendChat("@telepoi " + p), POI).catch(() => {});
  }
  // Settle: let the arrival stream finish BEFORE the warm lap, so the warm lap
  // is warming the path rather than paying for the teleport.
  await new Promise((r) => setTimeout(r, SETTLE_MS));

  await page.evaluate(movingRigSource());
  const install = await page.evaluate(
    (payload) => window.__mbench.install(payload),
    { spec: table.spec, rows: table.rows, events: table.events, warmFrames: table.rows.length, drive: DRIVE }
  );
  console.log(`[moving-bench] rig installed: ${JSON.stringify(install)} — warm lap, then measure lap`);

  const r = await page.evaluate(() => window.__mbench.run());
  await page.close().catch(() => {});

  const rep = {
    ts: new Date().toISOString(),
    arm: ARM || "(default)",
    url,
    spec: table.spec,
    pathChecksum: table.checksum,
    realisedChecksum: r.realisedChecksum,
    frames: { requested: table.rows.length, measured: r.frames, warm: r.warmFrames },
    cpuMs: stat(r.cpuMs),
    rafMs: stat(r.rafMs),
    missedGauge: r.missedGauge,
    workload: {
      // SUBMITTED per frame (renderer.info, differenced — autoReset is off).
      draws: stat(r.draws),
      ktris: stat(r.ktris),
      // RESIDENT, not submitted. Never price this as if it were drawn.
      residentInstances: r.census.instances,
      batchedMeshes: r.census.batched,
      staticBatchC: r.census.staticBatchC,
    },
    lb: { churnFrames: r.lb.churnFrames, countFirst: r.lb.counts[0], countLast: r.lb.counts[r.lb.counts.length - 1], hashFirst: r.lb.hashFirst, hashLast: r.lb.hashLast },
    walkDelta: deltaWalk(r.walk0, r.walk1),
    errors: errors.concat(r.errors || []).slice(0, 16),
  };
  const j = judge(rep, { churnMax: CHURN_MAX, drawSpreadMax: DRAW_SPREAD_MAX });
  rep.verdict = j.verdict;
  rep.rejectReasons = j.reasons;

  // RESULTS v2 (T01): same measurements, emitted through the shared report
  // writer — every figure now carries its mechanical @scale tag.
  writeFileSync(OUT, JSON.stringify(toResultsV2(rep, { series: { cpuMs: r.cpuMs, rafMs: r.rafMs, draws: r.draws } }), null, 2));
  console.log("\n" + "=".repeat(72));
  console.log(`  MOVING BENCH — ${rep.arm}`);
  console.log("=".repeat(72));
  console.log(`  verdict        : ${rep.verdict}`);
  for (const why of j.reasons) console.log(`      ! ${why}`);
  console.log(`  path checksum  : intended ${rep.pathChecksum}  realised ${rep.realisedChecksum}`);
  console.log(`  frames         : ${rep.frames.measured}/${rep.frames.requested} (warm ${rep.frames.warm})`);
  console.log(`  cpuMs          : ${JSON.stringify(rep.cpuMs)}`);
  console.log(`  rafMs          : ${JSON.stringify(rep.rafMs)}`);
  console.log(`  draws/frame    : ${JSON.stringify(rep.workload.draws)}   (SUBMITTED)`);
  console.log(`  ktris/frame    : ${JSON.stringify(rep.workload.ktris)}`);
  console.log(`  resident slots : ${rep.workload.residentInstances}  buckets ${rep.workload.staticBatchC}/${rep.workload.batchedMeshes}   (RESIDENT)`);
  console.log(`  lb churn       : ${rep.lb.churnFrames} frames  count ${rep.lb.countFirst} -> ${rep.lb.countLast}  hash ${rep.lb.hashFirst} -> ${rep.lb.hashLast}`);
  console.log(`  walk delta     : ${JSON.stringify(rep.walkDelta)}`);
  console.log(`  errors         : ${rep.errors.length}`);
  console.log(`\n  full JSON -> ${OUT}`);
  console.log("=".repeat(72));
  process.exit(j.ok ? 0 : 1);
}

/**
 * `getStatBatchXStats().walk` is CUMULATIVE since page load, so only the delta
 * across the measure lap describes the measure lap. Quoting the raw counter
 * would fold in the warm lap and the boot.
 */
export function deltaWalk(a, b) {
  if (!a || !b) return null;
  const keys = ["calls", "hitsExact", "hitsSlack", "rebuilds", "rebuildsSlack", "instancesWalked", "instancesSkipped", "errors"];
  const d = {};
  for (const k of keys) d[k] = (b[k] | 0) - (a[k] | 0);
  if (a.sphere && b.sphere) {
    d.sphere = {};
    for (const k of ["calls", "walks", "builds", "slotsBuilt", "slotsWalked", "ineligible", "errors", "lateActivations", "verifyFails"]) {
      d.sphere[k] = (b.sphere[k] | 0) - (a.sphere[k] | 0);
    }
    // The ONE ratio that says whether the cache is worth anything: slots read
    // from the cache per slot spent building it. Below ~1 the epoch is moving
    // faster than the cache can pay for itself.
    d.sphere.payback = d.sphere.slotsBuilt > 0 ? +(d.sphere.slotsWalked / d.sphere.slotsBuilt).toFixed(2) : null;
  }
  d.hitRate = (d.calls > 0) ? +((d.hitsExact + d.hitsSlack) / d.calls).toFixed(3) : null;
  return d;
}

/**
 * Fold one run's legacy rep into a RESULTS-v2 object (T01, pass-10 S12 —
 * "moving-bench's report is already ~this shape and converts first").
 * Behavior-preserving: the measurements are the same numbers judge() saw; the
 * emission path is the shared writer, which refuses untagged figures.
 *
 * Metric mapping (tags per pass-10 S1):
 *   rafMs  -> frameMs@moving   (the rAF interval IS the frame time; the arm
 *                               notes frameMsSource:"raf-interval")
 *   cpuMs  -> cpuMs@moving     (vfxGauge tick CPU)
 *   draws  -> draws@submitted  (renderer.info, differenced, autoReset off)
 *   ktris  -> ktris@submitted
 *   residentInstances/batchedMeshes/staticBatchC -> *@resident (RESIDENT,
 *                               never priced as if drawn — the founding wall)
 *
 * Everything else the old file carried (checksums, frames, lb churn,
 * walkDelta, errors, spec, series) rides along as aux fields on the arm, so
 * nothing an operator read from the legacy shape is lost.
 *
 * A judge() USABLE run lands verdict EXPLORATORY (a single arm is never a
 * scored budget by itself); a REJECT run lands INVALID and is kept on disk as
 * evidence, never scored (PR-10).
 */
export function toResultsV2(rep, { series } = {}) {
  const metrics = {};
  if (rep.rafMs) metrics["frameMs@moving"] = rep.rafMs;
  if (rep.cpuMs) metrics["cpuMs@moving"] = rep.cpuMs;
  if (rep.workload?.draws) metrics["draws@submitted"] = rep.workload.draws;
  if (rep.workload?.ktris) metrics["ktris@submitted"] = rep.workload.ktris;
  if (Number.isFinite(rep.workload?.residentInstances)) metrics["instances@resident"] = rep.workload.residentInstances;
  if (Number.isFinite(rep.workload?.batchedMeshes)) metrics["batchedMeshes@resident"] = rep.workload.batchedMeshes;
  if (Number.isFinite(rep.workload?.staticBatchC)) metrics["staticBatchBuckets@resident"] = rep.workload.staticBatchC;
  return createReport({
    bench: "MOVE-FIX",
    protocol: "PC-3",
    url: rep.url,
    ts: rep.ts,
    wasmProfile: "unknown", // PR-13 gate not wired here yet (T01 handoff)
  })
    .addArm({
      arm: rep.arm,
      verdict: rep.verdict === "USABLE" ? "USABLE" : "REJECT",
      rejectReasons: rep.rejectReasons || [],
      metrics,
      frameMsSource: "raf-interval",
      spec: rep.spec,
      pathChecksum: rep.pathChecksum,
      realisedChecksum: rep.realisedChecksum,
      frames: rep.frames,
      missedGauge: rep.missedGauge,
      lb: rep.lb,
      walkDelta: rep.walkDelta,
      errors: rep.errors,
      ...(series !== undefined ? { series } : {}),
    })
    .setVerdict(rep.verdict === "USABLE" ? "EXPLORATORY" : "INVALID")
    .toJSON();
}

// Importable for tests; only `main()` touches the network.
const isMain = process.argv[1] && process.argv[1].endsWith("moving-bench.mjs");
if (isMain) main().catch((e) => { console.error("[moving-bench] fatal:", e && e.stack ? e.stack : e); process.exit(1); });
