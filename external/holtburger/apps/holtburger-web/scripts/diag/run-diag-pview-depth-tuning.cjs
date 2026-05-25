// Wire-agent harness — PView depth tuning (2026-05-25).
//
// Measures the actual traversal depth reached by
// `getRenderSetWithPView` across realistic camera poses. Used to
// decide whether the `PVIEW_MAX_DEPTH = 8` hardcoded cap is
// appropriate, too tight, or too loose.
//
// Approach:
//   1. Boot wire-agent. Wait for `in-world` + non-zero cell.
//   2. Try a sequence of `@teleloc` commands to position the player
//      in different cells. ACE silently rejects @teleloc on
//      non-Developer accounts; we proceed regardless of whether the
//      teleport landed (the player's actual spawn cell is still
//      usable data).
//   3. At each "stop" (= post-teleport-and-settle), sample 8 yaws.
//      For each yaw, sweep `max_depth` ∈ {1, 2, 3, 4, 6, 8, 16} via
//      the new `getRenderSetWithPViewInstrumented(mvp, max_depth)`
//      export and record `(maxDepthReached, cellCount, cells[])`.
//   4. Also do a brief WASD walk between stops to add a 4th measurement
//      with the player physically having moved (different cell + view
//      angle vs the spawn cell).
//
// Decision rule:
//   - max-required ≤ 4 across all locations → could lower cap; report
//     KEEP (no downside to current 8) or LOWER (tighter).
//   - max-required ≤ 6 → cap of 8 has safety margin; KEEP.
//   - max-required ≥ 7 → at risk of clipping; raise cap to N+2.
//   - cap=16 returns more cells than cap=8 anywhere → strong evidence
//     of clipping; raise.
//
// Camera rotation:
//   `liveScene3d.cameraSwitcher.followYaw` is the canonical follow-cam
//   yaw (radians; CW from +Y north per `scene3d/camera.js:299`).
//   Setting it directly works because positionCamera() reads it every
//   rAF.
//
// Output:
//   - Per-(location, yaw, max_depth) row in results.json
//   - Markdown report at
//     /mnt/wbterminal1/tmp/claude-scratch/holtburger-diag-runs/pview-depth-tuning-report.md
//   - Console summary
//
// Exit codes:
//   0 = report produced. This harness MEASURES; the report contains
//       the engineering recommendation.
//   2 = harness couldn't reach the measurement (boot failure, missing
//       export, no in-world cell).
//
// Run from `apps/holtburger-web/`:
//   NODE_PATH=/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules \
//   node scripts/diag/run-diag-pview-depth-tuning.cjs

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
  "&renderer=3d&quality=low&kickDance=0&agentic=low" +
  "&wireframe=1&hud=none&plugins=none&netDrainHz=30&diag=1&nosw=1";
const CHROME =
  process.env.CHROME_PATH ||
  "/home/wbterminal/.cache/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-linux64/chrome-headless-shell";
const OUT_ROOT =
  process.env.HOLTBURGER_DIAG_OUT ||
  "/mnt/wbterminal1/tmp/claude-scratch/holtburger-diag-runs";

// Stops to probe. Each entry runs as: send `teleloc` command, wait
// for settle, then sample 8 yaws × 7 depth caps. Each is best-effort:
// if @teleloc silently fails, we still sample from wherever the
// player happens to be. The labels reflect the INTENT; the actual
// landed cell is recorded in the report.
const STOPS = [
  {
    label: "spawn-as-is",
    teleloc: null, // no teleport — sample from the autoSpawn position
    note: "Player's autoSpawn position (whatever cell ACE put them in)",
  },
  {
    label: "holtburg-cottage-A-attempt",
    teleloc: "@teleloc 0xA9B40100 88.0 131.0 67.0",
    note: "Attempt to enter Holtburg cottage A interior",
  },
  {
    label: "holtburg-cottage-B-attempt",
    teleloc: "@teleloc 0xA9B40102 88.0 131.0 67.0",
    note: "Attempt to enter Holtburg cottage B (neighbour)",
  },
  {
    label: "holtburg-cottage-C-attempt",
    teleloc: "@teleloc 0xA9B40110 88.0 131.0 67.0",
    note: "Attempt to enter Holtburg cottage C (3-portal-hop away)",
  },
  {
    label: "mite-maze-attempt",
    teleloc: "@teleloc 0x01F801D4 6.1 -101.6 0.0",
    note: "Attempt to enter Mite Maze entrance (multi-floor dungeon)",
  },
  {
    label: "post-walk-forward",
    teleloc: null,
    walkKey: "KeyW",
    walkMs: 3000,
    note: "Sample after walking forward 3s with W key (cell change attempt)",
  },
];

// Depth caps to sweep. 16 is well above the current 8, so if any
// cap=16 result returns MORE cells than cap=8, we have evidence that
// 8 is clipping. The lower values let us see how fast the visible
// set grows with depth.
const DEPTH_CAPS = [1, 2, 3, 4, 6, 8, 16];

// 8 yaw rotations across the unit circle.
const YAW_STEPS = 8;

(async () => {
  const TS = new Date().toISOString().replace(/[:.]/g, "-");
  const OUT = path.join(OUT_ROOT, `pview-depth-tuning-${TS}`);
  await mkdir(OUT, { recursive: true });

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

  console.log("[boot] navigating…");
  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 30000 });

  // Wait for the boot to fully complete: bootState=in-world AND
  // currentCell != 0. The autoSpawn dance signals `ready` (scene up)
  // BEFORE the player's first cell flips to non-zero, so anchor on
  // both. Pattern copied from `run-diag-pview-near-portal.cjs`.
  const bootDeadline = Date.now() + 120000;
  let initialCell = 0;
  while (Date.now() < bootDeadline) {
    const s = await page.evaluate(() => window.__bootState).catch(() => null);
    const cur = await page.evaluate(() => {
      const h = window.liveScene3d?.sessionHandle ?? window.__sessionHandle;
      try { return (h?.getCurrentCellId?.() >>> 0) ?? 0; } catch (_) { return 0; }
    }).catch(() => 0);
    if (s === "in-world" && cur !== 0) {
      initialCell = cur;
      break;
    }
    if (s === "ready" && cur !== 0) {
      initialCell = cur;
      break;
    }
    await page.waitForTimeout(500);
  }
  if (initialCell === 0) {
    console.error("FAIL: player never reached in-world (currentCell still 0 after 120s).");
    await writeFile(path.join(OUT, "console.log"), consoleLines.join("\n"));
    await browser.close();
    process.exit(2);
  }
  console.log(`[boot] in-world. initialCell=0x${initialCell.toString(16).padStart(8, "0")}.`);

  // Extra settle so all surrounding cells finish baking and the
  // portal-polygon snapshot is published.
  console.log("[boot] Settling 15s for cell snapshot + EnvCell hydration…");
  await page.waitForTimeout(15000);

  // Verify the new exports exist. If not, the wasm hasn't been
  // rebuilt and we should abort cleanly.
  const exportOk = await page.evaluate(() => {
    const h = window.liveScene3d?.sessionHandle ?? window.__sessionHandle;
    return {
      hasInstrumented: typeof h?.getRenderSetWithPViewInstrumented === "function",
      hasPview: typeof h?.getRenderSetWithPView === "function",
      hasFrustum: typeof h?.getRenderSetWithFrustum === "function",
      hasCameraSwitcher: !!window.liveScene3d?.cameraSwitcher,
      hasWorldRoot: !!window.liveScene3d?.worldRoot,
    };
  });
  console.log(`[caps] ${JSON.stringify(exportOk)}`);
  if (!exportOk.hasInstrumented) {
    console.error("FAIL: `getRenderSetWithPViewInstrumented` not exported — rebuild wasm first.");
    await writeFile(path.join(OUT, "console.log"), consoleLines.join("\n"));
    await browser.close();
    process.exit(2);
  }
  if (!exportOk.hasCameraSwitcher || !exportOk.hasWorldRoot) {
    console.error("FAIL: cameraSwitcher / worldRoot not in scene; cannot compose MVP.");
    await writeFile(path.join(OUT, "console.log"), consoleLines.join("\n"));
    await browser.close();
    process.exit(2);
  }

  // ===== Measurement loop =====
  // results[stop_label] = { cellInfo, yawResults: { [yawDeg]: rows[] } }
  const results = {};
  let lastCellSeen = initialCell;
  for (const stop of STOPS) {
    console.log(`\n[stop] ${stop.label} — ${stop.note}`);
    if (stop.teleloc) {
      console.log(`[chat] ${stop.teleloc}`);
      await page.evaluate((cmd) => {
        const h = window.liveScene3d?.sessionHandle ?? window.__sessionHandle;
        if (h?.sendChat) h.sendChat(cmd);
      }, stop.teleloc);
      await page.waitForTimeout(8000);
    } else if (stop.walkKey) {
      console.log(`[walk] hold ${stop.walkKey} for ${stop.walkMs}ms`);
      // Need to focus the page to receive keyboard events. Click
      // the centre of the viewport (which should be the rendered
      // canvas).
      await page.mouse.click(640, 360);
      await page.waitForTimeout(300);
      await page.keyboard.down(stop.walkKey);
      await page.waitForTimeout(stop.walkMs);
      await page.keyboard.up(stop.walkKey);
      await page.waitForTimeout(2000);
    } else {
      // spawn-as-is: just settle in place
      await page.waitForTimeout(2000);
    }

    const cellInfo = await page.evaluate(() => {
      const live = window.liveScene3d;
      const h = live?.sessionHandle ?? window.__sessionHandle;
      const cur = window.__diag?.pvs?.currentCell?.() ?? null;
      return {
        cell: cur,
        isIndoor: (() => {
          try { return !!h?.isCurrentCellIndoor?.(); } catch (_) { return null; }
        })(),
        cellsLoaded: (live?.cellContainers3d instanceof Map) ? live.cellContainers3d.size : 0,
      };
    });
    console.log(`[probe] cell=${cellInfo.cell?.cellHex} isIndoor=${cellInfo.isIndoor} cellsLoaded=${cellInfo.cellsLoaded}`);

    if (!cellInfo.cell || cellInfo.cell.cellId === 0) {
      console.warn(`  ! cell == 0; recording empty rows for ${stop.label}`);
      results[stop.label] = { unreachable: true, cellInfo };
      continue;
    }
    lastCellSeen = cellInfo.cell.cellId;

    const stopResults = {
      cellInfo,
      yawResults: {},
    };

    for (let s = 0; s < YAW_STEPS; s++) {
      const yawDeg = s * (360 / YAW_STEPS);
      const yawRad = yawDeg * Math.PI / 180;

      // Set followYaw; positionCamera() reads it next rAF.
      await page.evaluate((y) => {
        const cs = window.liveScene3d?.cameraSwitcher;
        if (cs) cs.followYaw = y;
      }, yawRad);
      await page.waitForTimeout(250);

      const measurements = await page.evaluate(async (caps) => {
        const live = window.liveScene3d;
        const h = live?.sessionHandle ?? window.__sessionHandle;
        if (!h) return { error: "sessionHandle not ready" };
        const camera = live?.cameraSwitcher?.activeCamera ?? live?.camera;
        const worldRoot = live?.worldRoot;
        if (!camera || !worldRoot) return { error: "camera/worldRoot missing" };
        // Match scene3d/cells.js:649-654 — fold worldRoot rotation
        // into MVP so the frustum lands in AC coords (Z-up). Pull
        // the THREE.Matrix4 constructor from an existing matrix
        // (THREE isn't exposed on `window`).
        const M4 = camera.projectionMatrix.constructor;
        const m = new M4();
        m.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
        m.multiply(worldRoot.matrixWorld);
        const mvp = new Float32Array(16);
        for (let i = 0; i < 16; i++) mvp[i] = m.elements[i];
        const rows = [];
        for (const cap of caps) {
          try {
            const r = h.getRenderSetWithPViewInstrumented(mvp, cap);
            // Wire shape: [max_depth_reached, count, c0..cN-1]
            if (!r || r.length < 2) {
              rows.push({ cap, error: "empty result" });
              continue;
            }
            const maxDepthReached = r[0];
            const cellCount = r[1];
            const cells = Array.from(r.slice(2));
            rows.push({
              cap,
              maxDepthReached,
              cellCount,
              cells: cells.map((c) =>
                "0x" + (c >>> 0).toString(16).padStart(8, "0")
              ),
            });
          } catch (e) {
            rows.push({ cap, error: String(e?.message ?? e) });
          }
        }
        return { rows };
      }, DEPTH_CAPS);

      if (measurements.error) {
        console.warn(`  yaw=${yawDeg}° error: ${measurements.error}`);
        stopResults.yawResults[yawDeg] = { error: measurements.error };
        continue;
      }

      stopResults.yawResults[yawDeg] = measurements.rows;

      // Compact log line
      const cap1Row = measurements.rows.find((r) => r.cap === 1);
      const cap8Row = measurements.rows.find((r) => r.cap === 8);
      const cap16Row = measurements.rows.find((r) => r.cap === 16);
      const cap1 = cap1Row ? `${cap1Row.cellCount}c@d${cap1Row.maxDepthReached}` : "?";
      const cap8 = cap8Row ? `${cap8Row.cellCount}c@d${cap8Row.maxDepthReached}` : "?";
      const cap16 = cap16Row ? `${cap16Row.cellCount}c@d${cap16Row.maxDepthReached}` : "?";
      console.log(`  yaw=${String(yawDeg).padStart(3)}° cap1=${cap1} cap8=${cap8} cap16=${cap16}`);
    }
    results[stop.label] = stopResults;
  }

  // ===== Analysis =====
  const analysis = {
    perStop: {},
    global: {
      maxDepthReached: 0,
      anyClippingDetected: false,
      clippingEvidence: [],
      indoorCellsVisited: new Set(),
      outdoorCellsVisited: new Set(),
    },
  };
  for (const [label, stopRes] of Object.entries(results)) {
    if (stopRes.unreachable) {
      analysis.perStop[label] = { unreachable: true };
      continue;
    }
    const ci = stopRes.cellInfo;
    if (ci.isIndoor) analysis.global.indoorCellsVisited.add(ci.cell.cellHex);
    else analysis.global.outdoorCellsVisited.add(ci.cell.cellHex);

    let maxReached = 0;
    let clippingDetected = false;
    const yawSummaries = [];
    for (const [yawDeg, rows] of Object.entries(stopRes.yawResults)) {
      if (!Array.isArray(rows)) continue;
      const cap8Row = rows.find((r) => r.cap === 8);
      const cap16Row = rows.find((r) => r.cap === 16);
      const cap16Reached = cap16Row?.maxDepthReached ?? 0;
      if (cap16Reached > maxReached) maxReached = cap16Reached;
      let clipFlag = false;
      if (cap8Row && cap16Row && !cap8Row.error && !cap16Row.error) {
        if (cap16Row.cellCount > cap8Row.cellCount) {
          clipFlag = true;
          clippingDetected = true;
          analysis.global.anyClippingDetected = true;
          analysis.global.clippingEvidence.push({
            stop: label,
            yaw: Number(yawDeg),
            cap8Count: cap8Row.cellCount,
            cap16Count: cap16Row.cellCount,
            cap16Depth: cap16Row.maxDepthReached,
          });
        }
      }
      yawSummaries.push({
        yawDeg: Number(yawDeg),
        cap16Count: cap16Row?.cellCount,
        cap16Depth: cap16Reached,
        cap8Count: cap8Row?.cellCount,
        cap8Depth: cap8Row?.maxDepthReached,
        clipFlag,
      });
    }
    analysis.perStop[label] = {
      cellHex: ci.cell?.cellHex,
      isIndoor: ci.isIndoor,
      maxDepthReached: maxReached,
      clippingDetected,
      yawSummaries,
    };
    if (maxReached > analysis.global.maxDepthReached) {
      analysis.global.maxDepthReached = maxReached;
    }
  }
  analysis.global.indoorCellsVisited = Array.from(analysis.global.indoorCellsVisited);
  analysis.global.outdoorCellsVisited = Array.from(analysis.global.outdoorCellsVisited);

  // Recommendation
  const maxReq = analysis.global.maxDepthReached;
  const indoorMeasured = analysis.global.indoorCellsVisited.length > 0;
  let recommendation;
  if (!indoorMeasured) {
    recommendation = {
      action: "incomplete",
      newCap: 8,
      reason:
        `No indoor cells were reached during measurement (player only visited outdoor LandCells; @teleloc commands silently failed — likely an account-permission issue or ACE state). Outdoor PView always returns just {current_cell} because LandCells have no portal-graph edges, so the depth metric for outdoor stops is trivially 0 and not informative. The harness cannot confirm whether PVIEW_MAX_DEPTH=8 is appropriate from outdoor data alone. RECOMMENDATION: re-run after manually placing the player indoors (e.g. via WB.Terminal scripted nav, or after a successful @teleloc landing). Until then, keep PVIEW_MAX_DEPTH=8 (no evidence to change it).`,
    };
  } else if (analysis.global.anyClippingDetected) {
    recommendation = {
      action: "raise",
      newCap: maxReq + 2,
      reason:
        `Clipping detected: at least one (stop, yaw) pose shows cap=16 returning more visible cells than cap=8. Max depth reached at cap=16 was ${maxReq}. Recommend PVIEW_MAX_DEPTH = ${maxReq + 2} (depth used + safety margin).`,
    };
  } else if (maxReq <= 4) {
    recommendation = {
      action: "keep",
      newCap: 8,
      reason:
        `Max depth reached across all measured indoor poses = ${maxReq}. Current cap of 8 has ${8 - maxReq} headroom. The cost of keeping 8 is negligible (BFS early-exits once view-poly clip kills branches, so cap=8 vs cap=4 only matters when very deep portal chains exist — which they don't in Holtburg). Recommendation: KEEP at 8.`,
    };
  } else if (maxReq <= 6) {
    recommendation = {
      action: "keep",
      newCap: 8,
      reason:
        `Max depth reached = ${maxReq}. Current cap of 8 has ${8 - maxReq} headroom — adequate safety margin. Recommendation: KEEP at 8.`,
    };
  } else {
    recommendation = {
      action: "raise",
      newCap: maxReq + 2,
      reason:
        `Max depth reached = ${maxReq}. Current cap of 8 has only ${8 - maxReq} headroom — at risk of clipping deep portal chains. Recommendation: RAISE to ${maxReq + 2}.`,
    };
  }
  analysis.recommendation = recommendation;

  // ===== Report =====
  const lines = [];
  lines.push("# PView depth-tuning measurement report");
  lines.push("");
  lines.push(`Date: ${new Date().toISOString()}`);
  lines.push(`Baseline commit: \`4b18fb69\` (modified: parametric \`max_depth\` arg + \`getRenderSetWithPViewInstrumented\` export)`);
  lines.push(`Default \`PVIEW_MAX_DEPTH\` constant: \`8\``);
  lines.push(`Depth caps swept: ${DEPTH_CAPS.join(", ")}`);
  lines.push(`Yaw rotations: ${YAW_STEPS} × 45° steps`);
  lines.push("");
  lines.push("## Recommendation");
  lines.push("");
  lines.push(`**Action: ${recommendation.action.toUpperCase()}** — ${recommendation.action === "keep" ? "leave at 8" : recommendation.action === "incomplete" ? "no change (data insufficient)" : `set PVIEW_MAX_DEPTH = ${recommendation.newCap}`}`);
  lines.push("");
  lines.push(recommendation.reason);
  lines.push("");
  lines.push("## Global summary");
  lines.push("");
  lines.push(`- Max depth reached across all measured poses: **${maxReq}**`);
  lines.push(`- Indoor cells visited: ${analysis.global.indoorCellsVisited.length} (\`${analysis.global.indoorCellsVisited.join("\`, \`") || "—"}\`)`);
  lines.push(`- Outdoor cells visited: ${analysis.global.outdoorCellsVisited.length} (\`${analysis.global.outdoorCellsVisited.join("\`, \`") || "—"}\`)`);
  lines.push(`- Clipping detected (cap=16 returns more than cap=8 anywhere): **${analysis.global.anyClippingDetected ? "YES" : "NO"}**`);
  if (analysis.global.anyClippingDetected) {
    lines.push("");
    lines.push("### Clipping evidence");
    lines.push("");
    lines.push("| Stop | Yaw | cap=8 cells | cap=16 cells | cap=16 depth |");
    lines.push("|---|---|---|---|---|");
    for (const e of analysis.global.clippingEvidence) {
      lines.push(`| ${e.stop} | ${e.yaw}° | ${e.cap8Count} | ${e.cap16Count} | ${e.cap16Depth} |`);
    }
  }
  lines.push("");
  lines.push("## Per-stop measurements");
  lines.push("");
  for (const [label, stopAnal] of Object.entries(analysis.perStop)) {
    lines.push(`### ${label}`);
    lines.push("");
    if (stopAnal.unreachable) {
      lines.push("Cell unreachable. No data.");
      lines.push("");
      continue;
    }
    lines.push(`- Cell: \`${stopAnal.cellHex}\` (indoor=${stopAnal.isIndoor})`);
    lines.push(`- Max depth reached: **${stopAnal.maxDepthReached}**`);
    lines.push(`- Clipping in any yaw: **${stopAnal.clippingDetected ? "YES" : "NO"}**`);
    lines.push("");
    lines.push("Per-yaw depth/cell-count table (cap=8 vs cap=16):");
    lines.push("");
    lines.push("| Yaw | cap=8 cells | cap=8 depth | cap=16 cells | cap=16 depth | Clipped? |");
    lines.push("|---|---|---|---|---|---|");
    for (const y of stopAnal.yawSummaries) {
      lines.push(`| ${y.yawDeg}° | ${y.cap8Count ?? "?"} | ${y.cap8Depth ?? "?"} | ${y.cap16Count ?? "?"} | ${y.cap16Depth ?? "?"} | ${y.clipFlag ? "**YES**" : "no"} |`);
    }
    lines.push("");
    // Full sweep table for the first yaw (informational)
    const stopRes = results[label];
    const firstYaw = Object.keys(stopRes.yawResults)[0];
    const firstRows = stopRes.yawResults[firstYaw];
    if (Array.isArray(firstRows)) {
      lines.push(`Cell-count curve at yaw=${firstYaw}° (depth cap → cell count):`);
      lines.push("");
      lines.push("| cap | cells | depth reached |");
      lines.push("|---|---|---|");
      for (const r of firstRows) {
        if (r.error) {
          lines.push(`| ${r.cap} | (error: ${r.error}) | — |`);
        } else {
          lines.push(`| ${r.cap} | ${r.cellCount} | ${r.maxDepthReached} |`);
        }
      }
      lines.push("");
    }
  }
  lines.push("## Methodology");
  lines.push("");
  lines.push("- Camera rotated by setting `liveScene3d.cameraSwitcher.followYaw` directly (radians; CW from +Y north per `scene3d/camera.js:299`).");
  lines.push("- MVP composed in JS as `projection · matrixWorldInverse · worldRoot.matrixWorld` to land the frustum in AC coords (matches `scene3d/cells.js:649-654`).");
  lines.push("- Depth instrumentation added to `apps/holtburger-web/src/lib.rs`:");
  lines.push("  - `getRenderSetWithPView(mvp, max_depth: u8)` — production path; `max_depth=0` uses the default 8.");
  lines.push("  - `getRenderSetWithPViewInstrumented(mvp, max_depth: u8)` — returns `[max_depth_reached, cell_count, cells...]`.");
  lines.push("- `@teleloc` commands sent via `sessionHandle.sendChat(...)` but the harness does NOT depend on them landing — it samples from whatever cell the player ends up in.");
  lines.push("");
  lines.push("## Raw data");
  lines.push("");
  lines.push("Full per-(stop, yaw, cap) JSON at `results.json` alongside this report.");
  lines.push("");

  const reportPath = path.join(OUT_ROOT, "pview-depth-tuning-report.md");
  await writeFile(reportPath, lines.join("\n"));
  await writeFile(path.join(OUT, "results.json"), JSON.stringify(results, null, 2));
  await writeFile(path.join(OUT, "analysis.json"), JSON.stringify(analysis, (k, v) => v instanceof Set ? Array.from(v) : v, 2));
  await writeFile(path.join(OUT, "console.log"), consoleLines.join("\n"));
  // Also write a copy of the report into the timestamped dir.
  await writeFile(path.join(OUT, "pview-depth-tuning-report.md"), lines.join("\n"));

  console.log("\n" + "=".repeat(72));
  console.log("PVIEW DEPTH TUNING — SUMMARY");
  console.log("=".repeat(72));
  console.log(`Max depth reached across all poses: ${maxReq}`);
  console.log(`Indoor cells visited: ${analysis.global.indoorCellsVisited.length}`);
  console.log(`Outdoor cells visited: ${analysis.global.outdoorCellsVisited.length}`);
  console.log(`Clipping detected (cap=8 < cap=16): ${analysis.global.anyClippingDetected}`);
  console.log(`Recommendation: ${recommendation.action.toUpperCase()} (newCap=${recommendation.newCap})`);
  console.log(`Reason: ${recommendation.reason}`);
  console.log("=".repeat(72));
  console.log(`Report: ${reportPath}`);
  console.log(`OUT: ${OUT}`);

  await browser.close();
  process.exit(0);
})();
