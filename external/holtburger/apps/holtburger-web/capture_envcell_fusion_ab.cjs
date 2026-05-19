#!/usr/bin/env node
// capture_envcell_fusion_ab.cjs (FU5, perf followon 2026-05-18)
//
// A/B harness for C1 (commit bd38a54) — flips `?envcellFusion=1` and
// compares the fused output against the baseline at fixed Academy
// waypoints. Pass: SSIM > 0.995 at every waypoint AND draw calls drop
// >= 3x on the fused side.
//
// Reference scripts this is modeled on:
//   - capture_academy_envcells.cjs  — boot/login/spawn/EnvCell-bake-wait
//   - capture_academy_tour.cjs      — `@teleloc` waypoint mechanism +
//                                     the 6 academy interior cell IDs
//                                     borrowed from its TOUR_STAGES.
//   - capture_phase6_step_c_envcells.cjs — CDP setup pattern (note: the
//                                     existing capture scripts use
//                                     Playwright, which is itself a
//                                     CDP wrapper; we follow the same
//                                     convention).
//   - capture_f9_visual_diff.cjs    — pixelmatch+pngjs probe pattern;
//                                     `renderer.info.render.calls`
//                                     sampling pattern.
//
// Run (with a 3D-renderer-capable browser and the dev pipeline running):
//   PHASE4_PAGE_URL=http://127.0.0.1:8765/apps/holtburger-web/index.html \
//   node capture_envcell_fusion_ab.cjs
//
// Output dir: /mnt/wbterminal1/tmp/claude-scratch/fps-followon/envcell-fusion-ab/
//   per memory `feedback_use_external_drives_for_scratch.md`. NEVER
//   writes to dist/ or any production output path.
//
// Pre-reqs (same as `capture_academy_envcells.cjs`):
//   - Live ACE on Tailscale 100.116.47.66 UDP 9000/9001.
//   - holtburger-wsbridge on ws://127.0.0.1:8080/.
//   - python3 -m http.server 8765 from external/holtburger/.
//   - Manifest+shards baked under dist/.
//   - Playwright in NODE_PATH or PLAYWRIGHT_CACHE.
//   - pngjs in PIXELMATCH_PREFIX (used for side-by-side grid + the
//     SSIM fallback's PNG read path).
//
// Exit code: 0 if PASS, 1 if FAIL.

const path = require("node:path");
const fs = require("node:fs");

const PLAYWRIGHT_CACHE =
  process.env.PLAYWRIGHT_CACHE ||
  "/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules";

const PIXELMATCH_PREFIX =
  process.env.PIXELMATCH_PREFIX || "/home/wbterminal/.npm/node_modules";

let chromium;
try {
  // eslint-disable-next-line global-require
  ({ chromium } = require("playwright"));
} catch (_) {
  try {
    // eslint-disable-next-line global-require
    ({ chromium } = require(path.join(PLAYWRIGHT_CACHE, "playwright")));
  } catch (e) {
    console.error(
      "FAIL: playwright not found in NODE_PATH or " +
        PLAYWRIGHT_CACHE +
        "\nSet NODE_PATH or PLAYWRIGHT_CACHE to a valid playwright install."
    );
    process.exit(2);
  }
}

// pngjs is required for the side-by-side grid and the SSIM fallback's
// PNG decode. ssim.js is preferred if present (per task brief).
let PNG;
try {
  ({ PNG } = require(path.join(PIXELMATCH_PREFIX, "pngjs")));
} catch (_) {
  try {
    ({ PNG } = require("pngjs"));
  } catch (e) {
    console.error(
      "FAIL: pngjs not found under " +
        PIXELMATCH_PREFIX +
        " or NODE_PATH.\n" +
        "Run: cd " +
        PIXELMATCH_PREFIX +
        "/.. && npm install --no-save pngjs"
    );
    process.exit(2);
  }
}

// Probe ssim.js. If present, use it; otherwise fall back to our inline
// luma-SSIM implementation (see computeSsim below).
let ssimJsModule = null;
try {
  ssimJsModule = require(path.join(PIXELMATCH_PREFIX, "ssim.js"));
} catch (_) {
  try {
    ssimJsModule = require("ssim.js");
  } catch (_) {
    ssimJsModule = null;
  }
}

// === Waypoint set =====================================================
//
// Six fixed Academy interior cells borrowed verbatim from
// `capture_academy_tour.cjs:185-192`. Each row is backed by an
// ace_world.landblock_instance entry, so the cell is guaranteed to be
// indoor-reachable and surrounded by real geometry. Driven by
// `@teleloc <cellHex> <localXYZ>` via the session handle's sendChat —
// matches the academy_tour mechanism exactly.
//
// Picking 6 cells (not 5–10) keeps the test reasonably quick while
// still hitting:
//   - Life Stone room
//   - Carpenter Wasp room (rare wasp cell)
//   - Training-arc hub (4 distinct wcids — high mesh variety)
//   - Thrungus room (rare creature cell)
//   - Guides-arc hub (4 distinct wcids)
//   - Interior probe (v1-validated cell)
//
// All six are inside LB 0x8602; cellLow >= 0x0100 → indoor cells per
// the `is_indoors()` predicate from
// crates/holtburger-common/src/position.rs.
const WAYPOINTS = [
  { id: "wp1", cellHex: "0x86020134", origin: "0 0 0", label: "Life Stone" },
  { id: "wp2", cellHex: "0x860201AE", origin: "0 0 0", label: "Carpenter Wasp room" },
  { id: "wp3", cellHex: "0x860201B6", origin: "0 0 0", label: "Hub (training arc)" },
  { id: "wp4", cellHex: "0x860201E8", origin: "0 0 0", label: "Thrungus room" },
  { id: "wp5", cellHex: "0x8602023C", origin: "0 0 0", label: "Hub (guides arc)" },
  { id: "wp6", cellHex: "0x86020280", origin: "0 0 0", label: "Interior probe" },
];

// Pass criteria.
const SSIM_THRESHOLD = 0.995;
const DRAW_CALL_RATIO_THRESHOLD = 3.0;

// Output dir (per memory `feedback_use_external_drives_for_scratch.md`).
const OUT_DIR = "/mnt/wbterminal1/tmp/claude-scratch/fps-followon/envcell-fusion-ab";

// === SSIM implementation =============================================
//
// Inline single-scale luma SSIM over 8x8 windows with a 0.01/0.03
// stabilization constant pair (Wang et al. 2004; the standard
// formulation). Per the task brief: prefer `ssim.js` if installed,
// otherwise this fallback. Both produce a scalar mean-SSIM in [-1, 1]
// where 1.0 = identical.
//
// We operate on RGBA buffers (the format `Page.captureScreenshot`
// hands back via pngjs). Luma conversion uses Rec.601 weights
// (Y = 0.299R + 0.587G + 0.114B) — the standard SSIM luma path.
//
// Why 8x8 windows: matches ssim.js's default window size; small enough
// to localize differences in mesh fusion (which affects per-pixel
// shading subtly), large enough that single-pixel anti-aliasing noise
// doesn't dominate.
function rgbaToLuma(rgba, w, h) {
  const luma = new Float32Array(w * h);
  for (let i = 0; i < w * h; i += 1) {
    const r = rgba[i * 4];
    const g = rgba[i * 4 + 1];
    const b = rgba[i * 4 + 2];
    luma[i] = (0.299 * r + 0.587 * g + 0.114 * b) / 255.0;
  }
  return luma;
}

function computeSsimFallback(rgbaA, rgbaB, w, h) {
  const lumaA = rgbaToLuma(rgbaA, w, h);
  const lumaB = rgbaToLuma(rgbaB, w, h);
  const win = 8;
  const C1 = 0.01 * 0.01;
  const C2 = 0.03 * 0.03;
  let sum = 0;
  let count = 0;
  for (let y = 0; y + win <= h; y += win) {
    for (let x = 0; x + win <= w; x += win) {
      let meanA = 0;
      let meanB = 0;
      const N = win * win;
      for (let dy = 0; dy < win; dy += 1) {
        for (let dx = 0; dx < win; dx += 1) {
          const idx = (y + dy) * w + (x + dx);
          meanA += lumaA[idx];
          meanB += lumaB[idx];
        }
      }
      meanA /= N;
      meanB /= N;
      let varA = 0;
      let varB = 0;
      let covAB = 0;
      for (let dy = 0; dy < win; dy += 1) {
        for (let dx = 0; dx < win; dx += 1) {
          const idx = (y + dy) * w + (x + dx);
          const dA = lumaA[idx] - meanA;
          const dB = lumaB[idx] - meanB;
          varA += dA * dA;
          varB += dB * dB;
          covAB += dA * dB;
        }
      }
      varA /= N;
      varB /= N;
      covAB /= N;
      const num = (2 * meanA * meanB + C1) * (2 * covAB + C2);
      const den = (meanA * meanA + meanB * meanB + C1) * (varA + varB + C2);
      sum += num / den;
      count += 1;
    }
  }
  return count > 0 ? sum / count : 0;
}

async function computeSsim(rgbaA, rgbaB, w, h) {
  if (ssimJsModule && typeof ssimJsModule.ssim === "function") {
    // ssim.js public API: ssim({ data, width, height }, { data, width, height })
    // → { mssim, performance } where mssim is the mean SSIM scalar.
    try {
      const a = { data: rgbaA, width: w, height: h };
      const b = { data: rgbaB, width: w, height: h };
      const out = ssimJsModule.ssim(a, b);
      if (out && typeof out.mssim === "number") return out.mssim;
    } catch (e) {
      console.warn(`  ssim.js threw (${e?.message ?? e}); falling back to inline SSIM`);
    }
  }
  return computeSsimFallback(rgbaA, rgbaB, w, h);
}

// === Side-by-side grid composition ==================================
//
// For each waypoint, render a row: [baseline | fused | diff]. diff is
// a per-pixel |a - b| image, useful as a visual sanity check beyond
// the SSIM number. Stacks all waypoints vertically.
function makeDiffRgba(rgbaA, rgbaB, w, h) {
  const out = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i += 1) {
    const dr = Math.abs(rgbaA[i * 4] - rgbaB[i * 4]);
    const dg = Math.abs(rgbaA[i * 4 + 1] - rgbaB[i * 4 + 1]);
    const db = Math.abs(rgbaA[i * 4 + 2] - rgbaB[i * 4 + 2]);
    // Amplify so subtle diffs are visible; clamp at 255.
    const amp = 4;
    out[i * 4] = Math.min(255, dr * amp);
    out[i * 4 + 1] = Math.min(255, dg * amp);
    out[i * 4 + 2] = Math.min(255, db * amp);
    out[i * 4 + 3] = 255;
  }
  return out;
}

function composeGridPng(rows, w, h) {
  // Each row: 3 panels side-by-side (3w wide, h tall).
  // Vertical stack of N rows → total height = N * h.
  const totalW = w * 3;
  const totalH = h * rows.length;
  const png = new PNG({ width: totalW, height: totalH });
  for (let r = 0; r < rows.length; r += 1) {
    const { baseline, fused, diff } = rows[r];
    const yBase = r * h;
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const srcIdx = (y * w + x) * 4;
        // baseline panel (col 0)
        let dstIdx = ((yBase + y) * totalW + x) * 4;
        png.data[dstIdx] = baseline[srcIdx];
        png.data[dstIdx + 1] = baseline[srcIdx + 1];
        png.data[dstIdx + 2] = baseline[srcIdx + 2];
        png.data[dstIdx + 3] = 255;
        // fused panel (col 1)
        dstIdx = ((yBase + y) * totalW + (w + x)) * 4;
        png.data[dstIdx] = fused[srcIdx];
        png.data[dstIdx + 1] = fused[srcIdx + 1];
        png.data[dstIdx + 2] = fused[srcIdx + 2];
        png.data[dstIdx + 3] = 255;
        // diff panel (col 2)
        dstIdx = ((yBase + y) * totalW + (2 * w + x)) * 4;
        png.data[dstIdx] = diff[srcIdx];
        png.data[dstIdx + 1] = diff[srcIdx + 1];
        png.data[dstIdx + 2] = diff[srcIdx + 2];
        png.data[dstIdx + 3] = 255;
      }
    }
  }
  return PNG.sync.write(png);
}

(async () => {
  const RUN_TAG = process.env.ACAD_RUN_TAG || `fab${Date.now().toString(36)}`;
  const ACCOUNT = process.env.PHASE4_TEST_ACCOUNT || RUN_TAG;
  const PASSWORD = process.env.PHASE4_TEST_PASSWORD || RUN_TAG;
  const CHAR_NAME = process.env.ACAD_CHAR_NAME || `Fab${RUN_TAG.slice(-6)}`;
  const BRIDGE_URL = process.env.PHASE4_BRIDGE_URL || "ws://127.0.0.1:8080/";
  const SERVER_IP = process.env.PHASE4_SERVER_IP || "100.116.47.66";
  const SERVER_PORT = process.env.PHASE4_SERVER_PORT || "9000";
  // Base PAGE_URL — we append `?renderer=3d` (baseline) and
  // `?renderer=3d&envcellFusion=1` (fused) per run. Override base via
  // PHASE4_PAGE_URL for non-default ports.
  const PAGE_URL_BASE =
    process.env.PHASE4_PAGE_URL ||
    "http://127.0.0.1:8765/apps/holtburger-web/index.html";
  const SMOKE_TIMEOUT_MS = Number(process.env.PHASE7_SMOKE_TIMEOUT_MS || 60_000);
  const SPAWN_TIMEOUT_MS = Number(process.env.ACAD_SPAWN_TIMEOUT_MS || 60_000);
  const CREATE_TIMEOUT_MS = Number(process.env.ACAD_CREATE_TIMEOUT_MS || 30_000);
  const POST_SPAWN_DRAIN_MS = Number(process.env.ACAD_POST_SPAWN_DRAIN_MS || 6000);
  const ENVCELL_BAKE_TIMEOUT_MS = Number(process.env.ACAD_ENVCELL_BAKE_TIMEOUT_MS || 120_000);
  // Per-waypoint settle after @teleloc — 500ms per the task brief.
  const WAYPOINT_SETTLE_MS = Number(process.env.FU5_WAYPOINT_SETTLE_MS || 500);
  // Frame-budget after settle for the draw-call counter to stabilize.
  const FRAME_SAMPLE_MS = Number(process.env.FU5_FRAME_SAMPLE_MS || 250);
  const VIEWPORT_W = Number(process.env.FU5_VIEWPORT_W || 1024);
  const VIEWPORT_H = Number(process.env.FU5_VIEWPORT_H || 768);
  const ACADEMY_LB_KEY = 0x86020000 >>> 0;

  // Make sure the output dir exists (best-effort — caller's
  // responsibility to mount the drive).
  try {
    fs.mkdirSync(OUT_DIR, { recursive: true });
  } catch (e) {
    console.error(
      `FAIL: could not create scratch dir ${OUT_DIR}: ${e?.message ?? e}\n` +
        "Per memory `feedback_use_external_drives_for_scratch.md`, /mnt/wbterminal1 " +
        "must be mounted before running this script."
    );
    process.exit(2);
  }

  console.log(`launching A/B harness for FU5 (envcell-fusion)`);
  console.log(`ssim engine: ${ssimJsModule ? "ssim.js (vendor)" : "inline luma-SSIM fallback"}`);
  console.log(`scratch dir: ${OUT_DIR}`);
  console.log(`waypoints:   ${WAYPOINTS.length} academy interior cells`);
  console.log(`thresholds:  SSIM > ${SSIM_THRESHOLD}, draws ratio >= ${DRAW_CALL_RATIO_THRESHOLD}x`);

  // === loadAndWalk(flag) ==============================================
  //
  // Returns: { screenshots: Buffer[], drawCalls: number[], counters: object[] }
  // arranged in waypoint order.
  //
  // Caller invokes once with flag=false (baseline) and once with
  // flag=true (fused). The two invocations are completely
  // independent — fresh browser, fresh ACE login, fresh account+char,
  // fresh in-game state. This isolates the fusion flag's effect
  // from any incidental warm-cache or render-state drift.
  async function loadAndWalk(envcellFusionFlag) {
    const url = envcellFusionFlag
      ? `${PAGE_URL_BASE}?renderer=3d&envcellFusion=1`
      : `${PAGE_URL_BASE}?renderer=3d`;
    const label = envcellFusionFlag ? "fused" : "baseline";

    // Per-run account so the character lands fresh in the academy
    // every time. Matches `capture_academy_envcells.cjs`'s pattern.
    const runAccount = `${ACCOUNT}-${label}`;
    const runPassword = `${PASSWORD}-${label}`;
    const runCharName = `${CHAR_NAME}${label === "fused" ? "F" : "B"}`;

    console.log(`\n=== loadAndWalk(${label}) → ${url} ===`);
    console.log(`account: ${runAccount}, character: ${runCharName}`);

    const browser = await chromium.launch({
      args: [
        ...(process.env.PLAYWRIGHT_GL_BACKEND === "none"
          ? []
          : [`--use-gl=${process.env.PLAYWRIGHT_GL_BACKEND || "swiftshader"}`]),
        "--disable-dev-shm-usage",
        "--no-sandbox",
        "--disable-gpu-sandbox",
        "--disable-features=PaintHoldingCrossOrigin,PaintHolding",
      ],
    });
    const context = await browser.newContext({
      viewport: { width: VIEWPORT_W, height: VIEWPORT_H },
    });
    const page = await context.newPage();

    let consoleErrors = 0;
    const errMsgs = [];
    page.on("console", (msg) => {
      const text = msg.text();
      if (msg.type() === "error") {
        consoleErrors += 1;
        if (errMsgs.length < 5) errMsgs.push(text);
        console.log(`  [browser error] ${text.slice(0, 200)}`);
      } else if (
        /\[fu5|envcell|fused|envcellFusion|loadEnvCellsForLandblock/i.test(text)
      ) {
        console.log(`  [browser ${msg.type()}] ${text.slice(0, 200)}`);
      }
    });
    page.on("pageerror", (err) => {
      consoleErrors += 1;
      if (errMsgs.length < 5) errMsgs.push(err.message);
      console.error(`  [pageerror] ${err.message}`);
    });

    // --- Boot ---------------------------------------------------------
    await page.goto(url, { waitUntil: "domcontentloaded" });
    try {
      await page.waitForFunction(
        () => {
          const r = document.getElementById("results");
          return r && /PASS/.test(r.innerHTML);
        },
        { timeout: SMOKE_TIMEOUT_MS }
      );
      console.log(`  in-page smoke PASS`);
    } catch (e) {
      const html = await page.locator("#results").innerHTML().catch(() => "(no #results)");
      console.error(`  FAIL: smoke never reached PASS: ${html.slice(0, 200)}`);
      await browser.close();
      throw new Error(`smoke fail in ${label} run`);
    }

    // --- Login -------------------------------------------------------
    await page.fill('input[name="account"]', runAccount);
    await page.fill('input[name="password"]', runPassword);
    await page.fill('input[name="bridge_url"]', BRIDGE_URL);
    await page.fill('input[name="server_host"]', SERVER_IP);
    await page.fill('input[name="server_port"]', SERVER_PORT);
    await page.click('#login-form button[type=submit]');
    await page.waitForSelector("#selection:not([hidden])", { timeout: 90_000 });
    console.log(`  logged in`);
    await page.waitForTimeout(500);

    // --- Create character if needed ----------------------------------
    const initialCount = await page.locator('#character-ul button[data-id]').count();
    if (initialCount === 0) {
      const createVisible =
        (await page.locator("#create-form:not([hidden])").count()) > 0;
      if (!createVisible) {
        console.error(`  FAIL: create-form hidden`);
        await browser.close();
        throw new Error(`create-form hidden in ${label} run`);
      }
      await page.fill('#create-form input[name="char_name"]', runCharName);
      await page.click('#create-button');
      await page.waitForFunction(
        () => {
          const s = document.getElementById("create-status");
          return s && /Created\b/.test(s.innerText);
        },
        { timeout: CREATE_TIMEOUT_MS }
      );
      await page.waitForFunction(
        () => document.querySelectorAll('#character-ul button[data-id]').length > 0,
        { timeout: 10_000 }
      );
      console.log(`  character "${runCharName}" created`);
    }

    // --- Spawn into academy ------------------------------------------
    const spawnButtons = page.locator('#character-ul button[data-id]');
    await spawnButtons.first().click();
    await page.waitForFunction(
      () => {
        const s = document.getElementById("login-status");
        return s && /InWorld|Spawned/.test(s.innerText);
      },
      { timeout: SPAWN_TIMEOUT_MS }
    );
    await page.waitForTimeout(POST_SPAWN_DRAIN_MS);

    // /godly to immune fall damage during teleport churn.
    const godResult = await page.evaluate(() => {
      const h = window.__sessionHandle;
      if (h && typeof h.sendChat === "function") {
        try {
          h.sendChat("/godly");
          return "sent";
        } catch (e) {
          return `err: ${e.message || e}`;
        }
      }
      return "no handle";
    });
    console.log(`  /godly dispatch: ${godResult}`);
    await page.waitForTimeout(1500);

    // --- Wait for academy EnvCell bake to plateau --------------------
    console.log(`  waiting up to ${ENVCELL_BAKE_TIMEOUT_MS}ms for academy EnvCell bake`);
    let bakeDone = false;
    let bakeProgress = { loaded: false, academyCells: 0 };
    const bakeDeadline = Date.now() + ENVCELL_BAKE_TIMEOUT_MS;
    let stableSince = 0;
    while (Date.now() < bakeDeadline) {
      const status = await page.evaluate((expectedKey) => {
        const ls = window.liveScene3d;
        if (!ls) return { ready: false };
        const loaded =
          ls.envCellLoadedLbs instanceof Set
            ? ls.envCellLoadedLbs.has(expectedKey >>> 0)
            : false;
        let academyCells = 0;
        if (ls.cellContainers3d instanceof Map) {
          const expectedHigh = (expectedKey >>> 16) & 0xffff;
          for (const cellId of ls.cellContainers3d.keys()) {
            if (((cellId >>> 16) & 0xffff) === expectedHigh) academyCells += 1;
          }
        }
        return { loaded, academyCells };
      }, ACADEMY_LB_KEY);

      if (
        status.academyCells !== bakeProgress.academyCells ||
        status.loaded !== bakeProgress.loaded
      ) {
        stableSince = Date.now();
        bakeProgress.loaded = status.loaded;
        bakeProgress.academyCells = status.academyCells;
      } else if (status.loaded && status.academyCells > 0 && stableSince > 0) {
        if (Date.now() - stableSince >= 2000) {
          bakeDone = true;
          break;
        }
      }
      await page.waitForTimeout(500);
    }
    console.log(
      `  academy bake ${bakeDone ? "plateaued" : "TIMED OUT"} ` +
        `(loaded=${bakeProgress.loaded}, academyCells=${bakeProgress.academyCells})`
    );

    // --- Probe fusion-mode + initial counter snapshot ----------------
    //
    // Per cells.js:333+, fused cells carry `mesh.userData.fused === true`
    // and `mesh.userData.fusedKind in {"opaque","transparent"}` on the
    // child meshes inside `meshGroup`. We classify by walking the
    // graph; this also doubles as our diagnostic counter source since
    // `buildEnvCellsForLandblock`'s return value isn't stashed on
    // liveScene3d, but the resulting scene-graph state IS observable.
    const fusionProbe = await page.evaluate((expectedKey) => {
      const ls = window.liveScene3d;
      if (!ls || !(ls.cellContainers3d instanceof Map)) {
        return { error: "no cellContainers3d" };
      }
      const expectedHigh = (expectedKey >>> 16) & 0xffff;
      let academyCells = 0;
      let fusedCellsWithTransparent = 0;
      let fusedCellsOpaqueOnly = 0;
      let unfusedCells = 0;
      for (const [cellId, container] of ls.cellContainers3d) {
        if (((cellId >>> 16) & 0xffff) !== expectedHigh) continue;
        academyCells += 1;
        let sawFusedOpaque = false;
        let sawFusedTransparent = false;
        let sawUnfusedSurface = false;
        // Walk meshGroup (first child) + any nested meshes.
        for (const child of container.children) {
          if (child.isMesh && child.userData?.fused) {
            if (child.userData.fusedKind === "transparent") sawFusedTransparent = true;
            else sawFusedOpaque = true;
          } else if (child.children && child.children.length) {
            for (const grand of child.children) {
              if (grand.isMesh && grand.userData?.fused) {
                if (grand.userData.fusedKind === "transparent") sawFusedTransparent = true;
                else sawFusedOpaque = true;
              } else if (grand.isMesh && grand.userData?.surfaceDid) {
                sawUnfusedSurface = true;
              }
            }
          }
        }
        if (sawFusedTransparent) fusedCellsWithTransparent += 1;
        else if (sawFusedOpaque) fusedCellsOpaqueOnly += 1;
        else if (sawUnfusedSurface) unfusedCells += 1;
      }
      return {
        academyCells,
        fusedCellsWithTransparent,
        fusedCellsOpaqueOnly,
        unfusedCells,
      };
    }, ACADEMY_LB_KEY);
    console.log(`  fusion probe: ${JSON.stringify(fusionProbe)}`);

    // --- Walk waypoints ----------------------------------------------
    const screenshots = [];
    const drawCalls = [];
    const counters = [];

    for (const wp of WAYPOINTS) {
      console.log(`  waypoint ${wp.id} (${wp.label}) → @teleloc ${wp.cellHex}`);

      // Teleport via @teleloc — same mechanism as
      // capture_academy_tour.cjs.
      const telelocResult = await page.evaluate((cmd) => {
        const h = window.__sessionHandle;
        if (h && typeof h.sendChat === "function") {
          try {
            h.sendChat(cmd);
            return "sent";
          } catch (e) {
            return `err: ${e.message || e}`;
          }
        }
        return "no handle";
      }, `@teleloc ${wp.cellHex} ${wp.origin}`);

      if (telelocResult !== "sent") {
        console.warn(`    teleloc dispatch failed: ${telelocResult}`);
      }

      // Settle for PVS expansion + draw-call counter to stabilize.
      await page.waitForTimeout(WAYPOINT_SETTLE_MS);

      // Reset the renderer info so the calls counter reflects the
      // sampled frame, not the rolling accumulator. three.js's
      // `renderer.info.autoReset` defaults to true (resets each frame),
      // but capture scripts in this repo explicitly read `.info.render.calls`
      // post-frame and trust the autoReset path. We follow that
      // convention; see `capture_phase7_7_frustum.cjs:309` for the
      // alternate explicit-reset pattern if a future revision needs it.
      await page.waitForTimeout(FRAME_SAMPLE_MS);

      const sample = await page.evaluate((expectedKey) => {
        const ls = window.liveScene3d;
        const out = { drawCalls: -1, error: null };
        if (!ls) {
          out.error = "no liveScene3d";
          return out;
        }
        const renderer = ls.renderer;
        if (!renderer || !renderer.info) {
          out.error = "no renderer.info";
          return out;
        }
        out.drawCalls = renderer.info.render.calls;
        out.triangles = renderer.info.render.triangles;
        out.programs = renderer.info.programs ? renderer.info.programs.length : -1;
        // Re-probe fusion state at this waypoint (in case PVS revealed
        // additional cells since the initial probe).
        const expectedHigh = (expectedKey >>> 16) & 0xffff;
        let visibleCellsAtWp = 0;
        let fusedAtWp = 0;
        let unfusedAtWp = 0;
        if (ls.cellContainers3d instanceof Map) {
          for (const [cellId, container] of ls.cellContainers3d) {
            if (((cellId >>> 16) & 0xffff) !== expectedHigh) continue;
            if (!container.visible) continue;
            visibleCellsAtWp += 1;
            for (const child of container.children) {
              if (child.isMesh && child.userData?.fused) {
                fusedAtWp += 1;
                break;
              }
              if (child.children) {
                let foundFused = false;
                for (const grand of child.children) {
                  if (grand.isMesh && grand.userData?.fused) {
                    fusedAtWp += 1;
                    foundFused = true;
                    break;
                  }
                }
                if (foundFused) break;
                // Otherwise check for unfused surfaces.
                for (const grand of child.children) {
                  if (grand.isMesh && grand.userData?.surfaceDid) {
                    unfusedAtWp += 1;
                    break;
                  }
                }
                break;
              }
            }
          }
        }
        out.visibleCellsAtWp = visibleCellsAtWp;
        out.fusedAtWp = fusedAtWp;
        out.unfusedAtWp = unfusedAtWp;
        // Current cell + indoor flag for context.
        try {
          const h = window.__sessionHandle;
          if (h) {
            out.currentCellId = h.getCurrentCellId ? (h.getCurrentCellId() >>> 0) : 0;
            out.isIndoor = h.isCurrentCellIndoor ? !!h.isCurrentCellIndoor() : false;
          }
        } catch (_) {}
        return out;
      }, ACADEMY_LB_KEY);

      // Screenshot via Playwright (the wrapper around CDP's
      // Page.captureScreenshot). RGBA8 buffer via pngjs decode below.
      const pngBuf = await page.screenshot({ fullPage: false, type: "png" });
      screenshots.push(pngBuf);
      drawCalls.push(sample.drawCalls);
      counters.push({
        waypoint: wp.id,
        label: wp.label,
        cellHex: wp.cellHex,
        ...sample,
        // Snapshot of the per-LB counters from the initial probe
        // (these don't change as the player walks — they're set at
        // bake time and are landblock-scoped).
        landblockFusedCellsWithTransparent: fusionProbe.fusedCellsWithTransparent ?? 0,
        landblockFusedCellsOpaqueOnly: fusionProbe.fusedCellsOpaqueOnly ?? 0,
        landblockUnfusedCells: fusionProbe.unfusedCells ?? 0,
      });
      console.log(
        `    drawCalls=${sample.drawCalls}, visibleCells=${sample.visibleCellsAtWp}, ` +
          `fused=${sample.fusedAtWp}, unfused=${sample.unfusedAtWp}, ` +
          `cell=0x${(sample.currentCellId ?? 0).toString(16).padStart(8, "0")}, ` +
          `indoor=${sample.isIndoor}`
      );
    }

    await browser.close();
    if (consoleErrors > 0) {
      console.warn(`  ${label} run had ${consoleErrors} console errors (continuing).`);
      console.warn(`  first: ${errMsgs.slice(0, 3).join(" | ")}`);
    }
    return { screenshots, drawCalls, counters, consoleErrors };
  }

  // === Execute baseline then fused =====================================
  let baseline;
  try {
    baseline = await loadAndWalk(false);
  } catch (e) {
    console.error(`FATAL: baseline run failed: ${e?.message ?? e}`);
    process.exit(1);
  }
  let fused;
  try {
    fused = await loadAndWalk(true);
  } catch (e) {
    console.error(`FATAL: fused run failed: ${e?.message ?? e}`);
    process.exit(1);
  }

  // === Compare ========================================================
  console.log(`\n=== compare ===`);
  const gridRows = [];
  const perWaypoint = [];
  let allPass = true;

  // Decode the first screenshot to get the canonical dimensions; all
  // subsequent screenshots from the same browser context share these
  // dims (we don't resize between waypoints).
  if (baseline.screenshots.length !== WAYPOINTS.length || fused.screenshots.length !== WAYPOINTS.length) {
    console.error(
      `FAIL: screenshot count mismatch (baseline=${baseline.screenshots.length}, ` +
        `fused=${fused.screenshots.length}, expected=${WAYPOINTS.length})`
    );
    process.exit(1);
  }

  for (let i = 0; i < WAYPOINTS.length; i += 1) {
    const wp = WAYPOINTS[i];
    const baselinePng = PNG.sync.read(baseline.screenshots[i]);
    const fusedPng = PNG.sync.read(fused.screenshots[i]);
    const w = baselinePng.width;
    const h = baselinePng.height;
    if (fusedPng.width !== w || fusedPng.height !== h) {
      console.error(
        `FAIL: dimension mismatch at ${wp.id}: ` +
          `baseline ${baselinePng.width}x${baselinePng.height} vs ` +
          `fused ${fusedPng.width}x${fusedPng.height}`
      );
      allPass = false;
      continue;
    }

    const ssim = await computeSsim(baselinePng.data, fusedPng.data, w, h);
    const baselineCalls = baseline.drawCalls[i];
    const fusedCalls = fused.drawCalls[i];
    const ratio = fusedCalls > 0 ? baselineCalls / fusedCalls : Infinity;
    const ssimPass = ssim > SSIM_THRESHOLD;
    const ratioPass = ratio >= DRAW_CALL_RATIO_THRESHOLD;
    const pass = ssimPass && ratioPass;
    if (!pass) allPass = false;

    perWaypoint.push({
      id: wp.id,
      label: wp.label,
      cellHex: wp.cellHex,
      ssim,
      ssimPass,
      baselineCalls,
      fusedCalls,
      drawCallRatio: ratio,
      ratioPass,
      pass,
      baselineCounters: baseline.counters[i],
      fusedCounters: fused.counters[i],
    });

    // Save per-waypoint baseline+fused PNGs alongside grid for
    // easier post-mortem.
    fs.writeFileSync(path.join(OUT_DIR, `${wp.id}-baseline.png`), baseline.screenshots[i]);
    fs.writeFileSync(path.join(OUT_DIR, `${wp.id}-fused.png`), fused.screenshots[i]);

    const diff = makeDiffRgba(baselinePng.data, fusedPng.data, w, h);
    gridRows.push({ baseline: baselinePng.data, fused: fusedPng.data, diff });
  }

  // === Compose grid + summary =========================================
  if (gridRows.length > 0) {
    const firstBaseline = PNG.sync.read(baseline.screenshots[0]);
    const gridBuf = composeGridPng(gridRows, firstBaseline.width, firstBaseline.height);
    fs.writeFileSync(path.join(OUT_DIR, "grid.png"), gridBuf);
    console.log(`  wrote ${path.join(OUT_DIR, "grid.png")}`);
  }

  const summary = {
    timestamp: new Date().toISOString(),
    commit: "bd38a54 (C1 — flag-gated EnvCell mesh fusion)",
    task: "FU5 (perf followon 2026-05-18)",
    thresholds: {
      ssim: SSIM_THRESHOLD,
      drawCallRatio: DRAW_CALL_RATIO_THRESHOLD,
    },
    ssimEngine: ssimJsModule ? "ssim.js" : "inline-luma-fallback",
    waypointCount: WAYPOINTS.length,
    perWaypoint,
    overallPass: allPass,
    baselineConsoleErrors: baseline.consoleErrors,
    fusedConsoleErrors: fused.consoleErrors,
  };
  fs.writeFileSync(path.join(OUT_DIR, "summary.json"), JSON.stringify(summary, null, 2));
  console.log(`  wrote ${path.join(OUT_DIR, "summary.json")}`);

  // === Console table ==================================================
  console.log(`\n=== per-waypoint results ===`);
  console.log(
    "id    label                       ssim     baselineDraws  fusedDraws  ratio   pass"
  );
  console.log(
    "----  --------------------------  -------  -------------  ----------  ------  ----"
  );
  for (const row of perWaypoint) {
    console.log(
      `${row.id.padEnd(4)}  ${row.label.padEnd(26).slice(0, 26)}  ` +
        `${row.ssim.toFixed(4)}   ${String(row.baselineCalls).padStart(13)}  ` +
        `${String(row.fusedCalls).padStart(10)}  ${row.drawCallRatio.toFixed(2).padStart(6)}  ${row.pass ? "OK" : "FAIL"}`
    );
  }

  console.log(
    `\n${allPass ? "PASS" : "FAIL"}: ` +
      `SSIM > ${SSIM_THRESHOLD} at all ${WAYPOINTS.length} waypoints AND ` +
      `baselineCalls / fusedCalls >= ${DRAW_CALL_RATIO_THRESHOLD} at all ${WAYPOINTS.length} waypoints.`
  );
  console.log(`outputs in: ${OUT_DIR}`);

  process.exit(allPass ? 0 : 1);
})().catch((err) => {
  console.error("capture failed:", err);
  if (err?.stack) console.error(err.stack);
  process.exit(1);
});
