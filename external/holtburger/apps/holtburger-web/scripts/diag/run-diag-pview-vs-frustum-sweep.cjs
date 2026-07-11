// Wire-agent harness — Phase 5 PView vs Phase 4 frustum-cull
// comparison sweep across 5 representative Holtburg poses × 8 yaws.
//
// PURPOSE
// =======
// This is an *observability* / *measurement* harness, not a regression
// gate. We invoke both `SessionHandle::getRenderSetWithFrustum(mvp)` and
// `SessionHandle::getRenderSetWithPView(mvp)` at the same camera pose
// and compute the over-render reduction percentage:
//
//   reduction_pct = (frustumCount - pviewCount) / frustumCount * 100
//
// Aggregates across (location, yaw) report:
//   - mean indoor reduction (the headline number — how much Phase 5
//     buys you on average inside cottages and dungeons)
//   - mean outdoor reduction (expected to look high because LandCell
//     PView returns just {current_cell} so raw reduction = (N-1)/N
//     for frustum size N; cells.js' production path UNIONs PView with
//     frustum when pview.length>1, so the "effective" renderset there
//     is just the frustum — this harness measures the RAW pview output,
//     which is the right metric for "how much over-render does Phase 5
//     eliminate IF we trusted PView alone")
//   - per-(location, yaw) raw rows + min/max
//
// LOCATIONS
// =========
//   1. Outdoor town square     0xA9B40019 (1.0, 1.0, 70.0)
//   2. Inside cottage A         0xA9B40100 (88, 131, 67)
//   3. Inside cottage B         0xA9B40111 (35, 159, 67)  [envId 0x0348]
//   4. Inside cottage C         0xA9B40116 (155, 132, 67) [envId 0x02FA]
//   5. Mite Maze entrance       0x01F801D4 (6.1, -101.6, 0)
//
// Cottage B/C entry cells (0x0111 / 0x0116) are the first cellStructure=0
// entry cells of each cottage per `get-dungeon-info lbX:169 lbY:180`.
// Their origins drive the safe interior teleloc coords above.
//
// At each location we cycle followYaw through {0, π/4, π/2, …, 7π/4}
// (8 angles, 45° each), settle 1 second per pose for rAF, compose the
// same MVP that `cells.js:tickCellVisibility3D` uses, and call both
// methods.
//
// MVP composition (mirrors cells.js:649–654):
//   mvp = projection · matrixWorldInverse · worldRoot.matrixWorld
//
// CAMERA YAW POKE
// ===============
// `liveScene3d.cameraSwitcher.followYaw` is the public yaw on the
// follow-mode controller. Setting it directly is supported — the
// per-tick `positionCamera(dt)` reads `this.followYaw` and recomputes
// the camera transform. After mutation we wait 1s for rAF to update
// `camera.matrixWorldInverse`. We do NOT touch `camera.rotation.y`
// because the follow-cam overwrites that each tick.
//
// SESSION-PER-LOCATION
// ====================
// Each location boots a fresh chromium session. Empirically ACE only
// reliably honours one @teleloc per session in this auto-spawn flow —
// the second consecutive @teleloc gets dropped (likely teleport-cooldown
// or stale teleport_sequence). Boot-time spawn position is sticky from
// the previous session's last position, so we have to: (a) @teleloc to
// the target location during the FIRST per-session teleloc, (b) verify
// the player landed in the expected landblock, (c) sweep yaws, (d) close.
// Tradeoff: ~30s boot × 5 locations = ~3 minutes total wall time, but
// gives us reliable per-location data.
//
// ACCEPTANCE (for diag-run-all)
// =============================
//   - Indoor mean reduction > 0% (Phase 5 working)
//   - All (location × yaw) probes return numeric counts (no errors)
//
// Exit codes:
//   0 = sweep completed, indoor reduction > 0%
//   1 = sweep completed but acceptance check failed
//   2 = setup error (boot failed, helper missing, all probes errored)
//
// Run from `apps/holtburger-web/`:
//   NODE_PATH=/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules \
//   node scripts/diag/run-diag-pview-vs-frustum-sweep.cjs

const path = require("node:path");
const { mkdir, writeFile } = require("node:fs/promises");

const PLAYWRIGHT_CACHE =
  process.env.PLAYWRIGHT_CACHE ||
  "/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules";

let chromium;
try {
  ({ chromium } = require("playwright"));
} catch (_) {
  try {
    ({ chromium } = require(path.join(PLAYWRIGHT_CACHE, "playwright")));
  } catch (e) {
    console.error(`FAIL: playwright not found in NODE_PATH or ${PLAYWRIGHT_CACHE}`);
    process.exit(2);
  }
}

const BASE_URL =
  process.env.HOLTBURGER_BASE_URL || "http://127.0.0.1:8765";
const URL =
  `${BASE_URL}/apps/holtburger-web/index.html?` +
  "autoLogin=1&account=acadmp1ge522&password=acadmp1ge522&autoSpawn=first" +
  "&renderer=3d&quality=low&agentic=low" +
  "&wireframe=1&hud=none&plugins=none&netDrainHz=30&diag=1&nosw=1";
const CHROME =
  process.env.CHROME_PATH ||
  "/home/wbterminal/.cache/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-linux64/chrome-headless-shell";
const OUT_ROOT =
  process.env.HOLTBURGER_DIAG_OUT ||
  "/mnt/wbterminal1/tmp/claude-scratch/holtburger-diag-runs";

// Cottage-A interior cell 0x0100 is "indoor" via isCurrentCellIndoor()
// because its idx >= 0x0100. Cottage-B entry 0x0111 and Cottage-C entry
// 0x0116 ditto. Mite Maze 0x01D4 is indoor. The town-square cell
// 0x0019 (idx < 0x100) is outdoor.
// Locations are ordered so each session's boot-spawn (carried from the
// previous session's last-known position) is GEOMETRICALLY plausible
// for the next @teleloc target. ACE empirically drops a same-landblock
// @teleloc that crosses an outdoor↔indoor boundary right after spawn,
// so we interleave outdoor and indoor across landblocks. The Mite Maze
// run is placed first because the character's DB-saved position from
// the previous sweep run will likely be 0x01F801D4 (the last location),
// giving the boot-spawn a clean indoor starting state.
const LOCATIONS = [
  {
    label: "cottage-A-interior",
    teleloc: "@teleloc 0xA9B40100 88.0 131.0 67.0",
    expectedIndoor: true,
    targetLandblock: 0xA9B40000,
    teleSettleMs: 12000,
  },
  {
    label: "mite-maze-entrance",
    teleloc: "@teleloc 0x01F801D4 6.1 -101.6 0.0",
    expectedIndoor: true,
    targetLandblock: 0x01F80000,
    teleSettleMs: 15000,
  },
  {
    label: "cottage-B-interior",
    teleloc: "@teleloc 0xA9B40111 35.0 159.0 67.0",
    expectedIndoor: true,
    targetLandblock: 0xA9B40000,
    teleSettleMs: 12000,
  },
  {
    label: "cottage-C-interior",
    teleloc: "@teleloc 0xA9B40116 155.0 132.0 67.0",
    expectedIndoor: true,
    targetLandblock: 0xA9B40000,
    teleSettleMs: 12000,
  },
  {
    label: "outdoor-town-square",
    teleloc: "@teleloc 0xA9B40019 1.0 1.0 70.0",
    expectedIndoor: false,
    targetLandblock: 0xA9B40000,
    teleSettleMs: 12000,
  },
];

const YAW_STEPS = 8; // 0°, 45°, 90°, …, 315°

async function probeOneLocation(loc) {
  const browser = await chromium.launch({
    executablePath: CHROME,
    headless: true,
    args: [
      "--use-gl=swiftshader",
      "--enable-unsafe-swiftshader",
      "--disable-gpu-sandbox",
      "--ignore-gpu-blocklist",
      "--no-sandbox",
    ],
  });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();
  const consoleLines = [];
  page.on("console", (msg) => consoleLines.push(`[${msg.type()}] ${msg.text()}`));
  page.on("pageerror", (e) => consoleLines.push(`[pageerror] ${e.message}`));

  try {
    console.log(`  [boot] navigating…`);
    await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 30000 });
    const bootDeadline = Date.now() + 60000;
    while (Date.now() < bootDeadline) {
      const s = await page.evaluate(() => window.__bootState).catch(() => null);
      if (s === "ready" || s === "in-world") break;
      await page.waitForTimeout(200);
    }
    await page.waitForTimeout(8000);

    const caps = await page.evaluate(() => {
      const live = window.liveScene3d;
      const handle = live?.sessionHandle ?? window.__sessionHandle ?? null;
      return {
        hasHandle: !!handle,
        hasFrustum: typeof handle?.getRenderSetWithFrustum === "function",
        hasPView: typeof handle?.getRenderSetWithPView === "function",
        hasCameraSwitcher: !!live?.cameraSwitcher,
        hasWorldRoot: !!live?.worldRoot,
      };
    });
    if (!caps.hasFrustum || !caps.hasPView ||
        !caps.hasCameraSwitcher || !caps.hasWorldRoot) {
      return { error: "missing capabilities: " + JSON.stringify(caps), consoleLines };
    }

    // Wait until the boot-time spawn settles (cell is non-zero).
    {
      const spawnDeadline = Date.now() + 10000;
      while (Date.now() < spawnDeadline) {
        const c = await page.evaluate(() => {
          const h = window.liveScene3d?.sessionHandle ?? window.__sessionHandle;
          return (h?.getCurrentCellId?.() >>> 0) ?? 0;
        });
        if (c !== 0) break;
        await page.waitForTimeout(500);
      }
    }
    const spawnCell = await page.evaluate(() => {
      const h = window.liveScene3d?.sessionHandle ?? window.__sessionHandle;
      return (h?.getCurrentCellId?.() >>> 0) ?? 0;
    });
    console.log(`  [boot] in-world. spawn cell=0x${spawnCell.toString(16).padStart(8, "0")}`);

    // ACE sometimes drops the first @teleloc when the player just
    // logged in / spawned. Retry up to TELE_RETRIES times until we
    // observe arrival at the target (right landblock, right
    // indoor/outdoor profile).
    const TELE_RETRIES = 3;
    const targetLb = loc.targetLandblock & 0xFFFF0000;
    let arrived = false;
    for (let attempt = 0; attempt < TELE_RETRIES; attempt++) {
      console.log(`  [chat${attempt > 0 ? `:retry ${attempt}` : ""}] ${loc.teleloc}`);
      await page.evaluate((cmd) => {
        const h = window.liveScene3d?.sessionHandle ?? window.__sessionHandle;
        if (h?.sendChat) h.sendChat(cmd);
      }, loc.teleloc);

      const teleDeadline = Date.now() + loc.teleSettleMs;
      while (Date.now() < teleDeadline) {
        const observed = await page.evaluate(() => {
          const h = window.liveScene3d?.sessionHandle ?? window.__sessionHandle;
          return (h?.getCurrentCellId?.() >>> 0) ?? 0;
        });
        const observedLb = observed & 0xFFFF0000;
        const observedIdx = observed & 0x0000FFFF;
        const observedIndoor = observedIdx >= 0x0100;
        if (observed !== 0 && observedLb === targetLb &&
            observedIndoor === loc.expectedIndoor) {
          arrived = true;
          break;
        }
        await page.waitForTimeout(500);
      }
      if (arrived) break;
      // If we didn't arrive, wait a beat before retrying.
      await page.waitForTimeout(2000);
    }
    await page.waitForTimeout(3000); // post-arrival settle for cell load + camera

    const cellInfo = await page.evaluate(() => {
      const h = window.liveScene3d?.sessionHandle ?? window.__sessionHandle;
      const live = window.liveScene3d;
      return {
        cellId: (h?.getCurrentCellId?.() >>> 0) ?? 0,
        isIndoor: !!h?.isCurrentCellIndoor?.(),
        loadedCells: (live?.cellContainers3d instanceof Map) ? live.cellContainers3d.size : 0,
      };
    });
    const cellHex = "0x" + (cellInfo.cellId >>> 0).toString(16).padStart(8, "0");
    console.log(`  [post-tele] cell=${cellHex} isIndoor=${cellInfo.isIndoor} loaded=${cellInfo.loadedCells}`);

    const rows = [];
    for (let i = 0; i < YAW_STEPS; i++) {
      const yawRad = (i * 2 * Math.PI) / YAW_STEPS;
      const yawDeg = Math.round((i * 360) / YAW_STEPS);

      await page.evaluate((y) => {
        const live = window.liveScene3d;
        if (live?.cameraSwitcher) live.cameraSwitcher.followYaw = y;
      }, yawRad);
      await page.waitForTimeout(1000);

      const probe = await page.evaluate(() => {
        const live = window.liveScene3d;
        const handle = live?.sessionHandle ?? window.__sessionHandle;
        const camera = live?.cameraSwitcher?.activeCamera ?? live?.camera;
        const worldRoot = live?.worldRoot;
        const out = {
          cellId: (handle?.getCurrentCellId?.() >>> 0) ?? 0,
          isIndoor: !!handle?.isCurrentCellIndoor?.(),
          frustumCount: null,
          pviewCount: null,
          frustumError: null,
          pviewError: null,
        };
        if (!handle || !camera || !worldRoot) {
          out.frustumError = "missing handle/camera/worldRoot";
          return out;
        }
        try {
          const M4 = camera.projectionMatrix.constructor;
          const m = new M4();
          m.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
          m.multiply(worldRoot.matrixWorld);
          const mvp = new Float32Array(16);
          for (let j = 0; j < 16; j++) mvp[j] = m.elements[j];
          try {
            const fr = handle.getRenderSetWithFrustum(mvp);
            out.frustumCount = fr?.length ?? 0;
            out.frustumSample = Array.from(fr ?? []).slice(0, 4)
              .map((v) => "0x" + (v >>> 0).toString(16).padStart(8, "0"));
          } catch (e) { out.frustumError = String(e?.message ?? e); }
          try {
            // Mirror cells.js: pass max_depth=0 (= default PVIEW_MAX_DEPTH=8).
            // Fallback to 1-arg call for older wasm builds.
            let pv;
            try { pv = handle.getRenderSetWithPView(mvp, 0); }
            catch (_) { pv = handle.getRenderSetWithPView(mvp); }
            out.pviewCount = pv?.length ?? 0;
            out.pviewSample = Array.from(pv ?? []).slice(0, 4)
              .map((v) => "0x" + (v >>> 0).toString(16).padStart(8, "0"));
          } catch (e) { out.pviewError = String(e?.message ?? e); }
        } catch (e) {
          out.frustumError = "mvp compose: " + String(e?.message ?? e);
        }
        return out;
      });

      let reductionPct = null;
      if (
        typeof probe.frustumCount === "number" &&
        typeof probe.pviewCount === "number" &&
        probe.frustumCount > 0
      ) {
        reductionPct = ((probe.frustumCount - probe.pviewCount) /
          probe.frustumCount) * 100;
      }

      const row = {
        location: loc.label,
        teleloc: loc.teleloc,
        expectedIndoor: loc.expectedIndoor,
        cellHex: "0x" + (probe.cellId >>> 0).toString(16).padStart(8, "0"),
        observedIndoor: probe.isIndoor,
        yawDeg,
        yawRad,
        frustumCount: probe.frustumCount,
        pviewCount: probe.pviewCount,
        reductionPct,
        frustumSample: probe.frustumSample ?? [],
        pviewSample: probe.pviewSample ?? [],
        frustumError: probe.frustumError,
        pviewError: probe.pviewError,
      };
      rows.push(row);
      const pctStr = reductionPct === null ? "  n/a" : `${reductionPct.toFixed(1).padStart(5)}%`;
      console.log(`    yaw=${String(yawDeg).padStart(3)}°  frustum=${String(row.frustumCount).padStart(3)}  pview=${String(row.pviewCount).padStart(3)}  reduction=${pctStr}`);
    }

    return {
      rows,
      consoleLines,
      spawnCell,
      observedCell: cellInfo.cellId,
      observedIndoor: cellInfo.isIndoor,
    };
  } finally {
    await browser.close();
  }
}

(async () => {
  const TS = new Date().toISOString().replace(/[:.]/g, "-");
  const OUT = path.join(OUT_ROOT, `pview-vs-frustum-sweep-${TS}`);
  await mkdir(OUT, { recursive: true });

  const allRows = [];
  const perLocConsoles = {};
  const perLocMeta = {};

  for (let i = 0; i < LOCATIONS.length; i++) {
    const loc = LOCATIONS[i];
    console.log(`\n[loc ${i + 1}/${LOCATIONS.length}] ${loc.label}  ${loc.teleloc}`);
    let result;
    try {
      result = await probeOneLocation(loc);
    } catch (e) {
      console.log(`  ERROR: ${String(e?.message ?? e)}`);
      result = { error: String(e?.message ?? e), consoleLines: [] };
    }
    perLocConsoles[loc.label] = result.consoleLines ?? [];
    perLocMeta[loc.label] = {
      spawnCell: result.spawnCell ?? null,
      observedCell: result.observedCell ?? null,
      observedIndoor: result.observedIndoor ?? null,
      error: result.error ?? null,
    };
    if (result.rows) {
      allRows.push(...result.rows);
    }
    // Between sessions, give ACE a moment to persist the character's
    // last-known position to its DB. Empirically a 3s pause helps the
    // next session boot-spawn at the previous session's @teleloc target
    // (which we don't NEED — we re-teleloc immediately — but a clean
    // DB-write avoids "is already in-game" handshake races).
    await new Promise((r) => setTimeout(r, 3000));
  }

  // ---- aggregate ----
  function aggregate(filter) {
    const subset = allRows.filter(filter).filter(
      (r) => typeof r.reductionPct === "number",
    );
    if (subset.length === 0) return { n: 0, mean: null, min: null, max: null };
    const reductions = subset.map((r) => r.reductionPct);
    const sum = reductions.reduce((a, b) => a + b, 0);
    return {
      n: subset.length,
      mean: sum / subset.length,
      min: Math.min(...reductions),
      max: Math.max(...reductions),
    };
  }
  const allAgg = aggregate(() => true);
  const indoorAgg = aggregate((r) => r.observedIndoor === true);
  const outdoorAgg = aggregate((r) => r.observedIndoor === false);
  const perLoc = {};
  for (const loc of LOCATIONS) {
    perLoc[loc.label] = aggregate((r) => r.location === loc.label);
  }

  const summary = {
    timestamp: TS,
    sampleCount: allRows.length,
    locations: LOCATIONS.map((l) => l.label),
    yawSteps: YAW_STEPS,
    perLocationMeta: perLocMeta,
    aggregates: { all: allAgg, indoor: indoorAgg, outdoor: outdoorAgg, perLocation: perLoc },
  };

  await writeFile(path.join(OUT, "raw.json"),
    JSON.stringify({ rows: allRows, summary }, null, 2));
  for (const [label, lines] of Object.entries(perLocConsoles)) {
    await writeFile(path.join(OUT, `${label}.console.log`), lines.join("\n"));
  }

  // ---- markdown report ----
  function fmtPct(v) {
    if (v === null || v === undefined || Number.isNaN(v)) return "n/a";
    return v.toFixed(1) + "%";
  }
  function fmtNum(v) {
    if (v === null || v === undefined) return "n/a";
    return String(v);
  }
  const md = [];
  md.push(`# Phase 5 PView vs Phase 4 Frustum-Cull Comparison Sweep`);
  md.push(``);
  md.push(`- **Timestamp:** ${TS}`);
  md.push(`- **Total samples:** ${allRows.length} (${LOCATIONS.length} locations × ${YAW_STEPS} yaws)`);
  md.push(``);
  md.push(`## Headline`);
  md.push(``);
  md.push(`| Cohort | n | Mean reduction | Min | Max |`);
  md.push(`|---|---:|---:|---:|---:|`);
  md.push(`| **All samples** | ${allAgg.n} | ${fmtPct(allAgg.mean)} | ${fmtPct(allAgg.min)} | ${fmtPct(allAgg.max)} |`);
  md.push(`| **Indoor only** | ${indoorAgg.n} | **${fmtPct(indoorAgg.mean)}** | ${fmtPct(indoorAgg.min)} | ${fmtPct(indoorAgg.max)} |`);
  md.push(`| **Outdoor only** | ${outdoorAgg.n} | ${fmtPct(outdoorAgg.mean)} | ${fmtPct(outdoorAgg.min)} | ${fmtPct(outdoorAgg.max)} |`);
  md.push(``);
  md.push(`The headline number is **indoor mean reduction**: it tells you how `
    + `much over-render Phase 5 PView eliminates vs Phase 4 frustum cull `
    + `from inside cottages and dungeons.`);
  md.push(``);
  md.push(`**On outdoor reduction:** LandCell PView returns just \`{current_cell}\` `
    + `(no portal walk available outdoors), so the raw outdoor reduction is `
    + `mechanically \`(frustum_count - 1) / frustum_count\` — high for any `
    + `frustum size > 1. This isn't the "effective" reduction \`cells.js\` `
    + `delivers though: the production path UNIONS the raw PView with the `
    + `frustum-cull whenever PView returned >1 cell, and falls back to the `
    + `frustum-cull alone when PView returned ≤1 cell. So outdoors, the `
    + `actual scene-rendering reduction \`cells.js\` enacts is 0% (frustum-cull `
    + `unchanged). The raw-PView outdoor numbers in this report tell you what `
    + `PView would give us if we trusted it alone outdoors — they're a hint `
    + `that landcell-rooted PView is the next thing to fix, not a real perf win.`);
  md.push(``);
  md.push(`## Per-location aggregate`);
  md.push(``);
  md.push(`| Location | n | Mean reduction | Min | Max | Observed cell |`);
  md.push(`|---|---:|---:|---:|---:|---|`);
  for (const loc of LOCATIONS) {
    const a = perLoc[loc.label];
    const m = perLocMeta[loc.label];
    const obs = (m?.observedCell != null)
      ? "0x" + (m.observedCell >>> 0).toString(16).padStart(8, "0")
      : "—";
    md.push(`| ${loc.label} | ${a.n} | ${fmtPct(a.mean)} | ${fmtPct(a.min)} | ${fmtPct(a.max)} | ${obs} |`);
  }
  md.push(``);
  md.push(`## Raw data`);
  md.push(``);
  md.push(`| Location | Cell | Indoor | Yaw° | Frustum | PView | Reduction |`);
  md.push(`|---|---|:---:|---:|---:|---:|---:|`);
  for (const r of allRows) {
    md.push(`| ${r.location} | ${r.cellHex} | ${r.observedIndoor ? "yes" : "no"} | ${r.yawDeg} | ${fmtNum(r.frustumCount)} | ${fmtNum(r.pviewCount)} | ${fmtPct(r.reductionPct)} |`);
  }
  md.push(``);
  md.push(`## Notes`);
  md.push(``);
  md.push(`- MVP composition mirrors \`scene3d/cells.js:tickCellVisibility3D\`: `);
  md.push(`  \`mvp = projection · matrixWorldInverse · worldRoot.matrixWorld\``);
  md.push(`- Camera yaw is set via \`liveScene3d.cameraSwitcher.followYaw\` `
    + `with a 1s rAF settle between probes.`);
  md.push(`- \`cells.js\` UNIONS PView with Frustum when PView produces >1 cell `
    + `(near-portal robustness). This report measures the RAW PView output, `
    + `not the union — that's the right comparison for "how much over-render `
    + `does Phase 5 eliminate".`);
  md.push(`- Each location spins up a fresh chromium session so the @teleloc `
    + `lands cleanly (ACE accepts the first per-session teleport reliably, `
    + `subsequent rapid teleports get dropped).`);
  md.push(``);

  await writeFile(path.join(OUT, "report.md"), md.join("\n"));

  // ---- console summary ----
  console.log("");
  console.log("=".repeat(72));
  console.log("PHASE 5 PVIEW VS PHASE 4 FRUSTUM SWEEP — RESULTS");
  console.log("=".repeat(72));
  console.log(`Samples: ${allRows.length}  (${LOCATIONS.length} locations × ${YAW_STEPS} yaws)`);
  console.log(`All:     n=${allAgg.n}  mean=${fmtPct(allAgg.mean)}  min=${fmtPct(allAgg.min)}  max=${fmtPct(allAgg.max)}`);
  console.log(`Indoor:  n=${indoorAgg.n}  mean=${fmtPct(indoorAgg.mean)}  min=${fmtPct(indoorAgg.min)}  max=${fmtPct(indoorAgg.max)}`);
  console.log(`Outdoor: n=${outdoorAgg.n}  mean=${fmtPct(outdoorAgg.mean)}  min=${fmtPct(outdoorAgg.min)}  max=${fmtPct(outdoorAgg.max)}`);
  console.log("");
  console.log("Per-location mean reduction:");
  for (const loc of LOCATIONS) {
    const a = perLoc[loc.label];
    const m = perLocMeta[loc.label];
    const obs = (m?.observedCell != null)
      ? "0x" + (m.observedCell >>> 0).toString(16).padStart(8, "0")
      : "—";
    console.log(`  ${loc.label.padEnd(28)} n=${a.n}  ${fmtPct(a.mean).padStart(7)}  observed=${obs}`);
  }
  console.log("");
  console.log(`OUT=${OUT}`);

  // Acceptance: indoor reduction must be > 0% (Phase 5 working).
  if (indoorAgg.n === 0) {
    console.error("FAIL: no indoor samples — every indoor probe errored or no indoor location was reached");
    process.exit(2);
  }
  const indoorMean = indoorAgg.mean ?? 0;
  const pass = indoorMean > 0;
  if (pass) {
    console.log(`VERDICT: PASS — indoor mean reduction ${fmtPct(indoorMean)} > 0%`);
    process.exit(0);
  } else {
    console.log(`VERDICT: FAIL — indoor mean reduction ${fmtPct(indoorMean)} <= 0%`);
    process.exit(1);
  }
})();
