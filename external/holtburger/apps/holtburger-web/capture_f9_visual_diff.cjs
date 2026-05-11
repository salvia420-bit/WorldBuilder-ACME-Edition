// Follow-on #9 capture — WorldBuilder.Terminal visual ground-truth diff.
//
// Goal: produce a top-down ortho render of Holtburg (LB 0xA9B4) from the
// 3D path and compare it pixel-by-pixel to WorldBuilder.Terminal's
// `render-preview useSprites:true` output of the same region. The diff
// is a regression-detection signal — NOT a pass/fail gate (the Phase
// 7.7 audit already documented that the 3D path has known camera-fix
// issues, so a large diff is EXPECTED).
//
// Pre-reqs:
//   1. WB.Terminal render emitted at /tmp/wb_holtburg_ground_truth.png
//      via the recipe in `~/.claude/skills/worldbuilder-terminal/skill.md`.
//   2. Live HTTP server: PAGE_URL defaults to
//      http://100.116.47.66:8765/apps/holtburger-web/index.html?renderer=3d
//   3. Manifest+shards baked under dist/.
//   4. Playwright in NODE_PATH or
//      /home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules.
//   5. pixelmatch + pngjs available; we resolve them from
//      /home/wbterminal/.npm/node_modules (npm install --no-save was
//      run from that prefix during F#9 setup).
//
// Run from `apps/holtburger-web/`:
//   NODE_PATH=/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules \
//   node capture_f9_visual_diff.cjs
//
// Output artifacts:
//   /tmp/wb_holtburg_ground_truth.png  — WB.Terminal render (pre-existing)
//   /tmp/holtburger_3d_topdown.png     — 3D top-down screenshot from this run
//   /tmp/diff.png                      — pixelmatch diff visualization
//   /tmp/f9_diff_result.json           — diff numbers + notes for handoff

const path = require("node:path");
const fs = require("node:fs");

const PLAYWRIGHT_CACHE =
  process.env.PLAYWRIGHT_CACHE ||
  "/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules";

const PIXELMATCH_PREFIX =
  process.env.PIXELMATCH_PREFIX || "/home/wbterminal/.npm/node_modules";

let chromium;
try {
  ({ chromium } = require("playwright"));
} catch (_) {
  try {
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

let pixelmatch, PNG;
try {
  // pixelmatch v6 is ESM only — require its package dir + use dynamic
  // import in the async body. We just probe the install layout here so
  // the failure mode is a clear one-liner instead of an unhandled
  // promise rejection deep in the diff phase.
  const pkg = require(path.join(PIXELMATCH_PREFIX, "pixelmatch", "package.json"));
  if (!pkg || !pkg.version) throw new Error("missing pixelmatch package.json");
  // pngjs v7 is CJS-compatible.
  ({ PNG } = require(path.join(PIXELMATCH_PREFIX, "pngjs")));
} catch (e) {
  console.error(
    "FAIL: pixelmatch or pngjs not found under " +
      PIXELMATCH_PREFIX +
      "\nRun: cd " +
      PIXELMATCH_PREFIX +
      "/.. && npm install --no-save pixelmatch pngjs"
  );
  process.exit(2);
}

(async () => {
  // Late ESM import for pixelmatch v6.
  pixelmatch = (await import(
    path.join(PIXELMATCH_PREFIX, "pixelmatch", "index.js")
  )).default;

  const PAGE_URL =
    process.env.F9_PAGE_URL ||
    "http://100.116.47.66:8765/apps/holtburger-web/index.html?renderer=3d";
  const SMOKE_TIMEOUT_MS = Number(process.env.F9_SMOKE_TIMEOUT_MS || 60_000);
  const BUILD_TIMEOUT_MS = Number(process.env.F9_BUILD_TIMEOUT_MS || 180_000);

  const WB_PATH = "/tmp/wb_holtburg_ground_truth.png";
  const TD_PATH = "/tmp/holtburger_3d_topdown.png";
  const DIFF_PATH = "/tmp/diff.png";
  const RESULT_PATH = "/tmp/f9_diff_result.json";

  // The WB.Terminal render-preview emits resolution = (radius*2+1) * floor(N/(2r+1))
  // — for radius=1 + resolution=1024 the actual PNG is 1023×1023 (3 LBs ×
  // 341 px = 1023). We size the 3D capture to MATCH this so pixelmatch
  // can compare them directly without a resize pass.
  const CAPTURE_W = 1023;
  const CAPTURE_H = 1023;

  // Holtburg LB centre in AC coords. Each LB = 192 m. 9-LB neighbourhood
  // = 3 LBs × 192 m = 576 m across. The 3D path's `acToThree(x,y,z) =
  // (x, z, -y)` maps AC → three.js. Camera is OUTSIDE worldRoot so we
  // place it in three.js world coords directly (the cameraSwitcher's
  // topDown branch already applies acToThree internally; we'll drive
  // the ortho frustum dimensions to cover the same 3×3 LB region the
  // WB.Terminal render captures).
  const HCX = 0xa9 * 192 + 96; // 32544
  const HCY = 0xb4 * 192 + 96; // 34656
  // Frustum height = 3 LBs = 576 m so the ortho view covers exactly the
  // same neighbourhood the WB.Terminal radius=1 render captured.
  const FRUSTUM_M = 192 * 3;

  console.log(`launching chromium → ${PAGE_URL}`);

  if (!fs.existsSync(WB_PATH)) {
    console.error(
      `FAIL: WB.Terminal ground truth not at ${WB_PATH}.\n` +
        "Build it first with:\n" +
        '  export DOTNET_ROOT=/home/wbterminal/.dotnet && \\\n' +
        "  echo '{\"command\":\"render-preview\",\"lbX\":169,\"lbY\":180,\"radius\":1,\"resolution\":1024,\"useSprites\":true,\"includePng\":false,\"outputPath\":\"" +
        WB_PATH +
        "\"}' | \\\n" +
        '  $DOTNET_ROOT/dotnet /home/wbterminal/WorldBuilder-ACME-Edition/WorldBuilder.Terminal/bin/Release/net8.0/WorldBuilder.Terminal.dll --stdin \\\n' +
        '    --project /home/wbterminal/projects/RetailSmoke/RetailSmoke.wbproj'
    );
    process.exit(2);
  }

  const browser = await chromium.launch({ args: ["--use-gl=swiftshader"] });
  const context = await browser.newContext({
    viewport: { width: CAPTURE_W, height: CAPTURE_H },
  });
  const page = await context.newPage();

  let consoleErrors = 0;
  const consoleErrorMessages = [];
  page.on("console", (msg) => {
    const text = msg.text();
    if (msg.type() === "error") {
      consoleErrors += 1;
      console.log(`[browser error] ${text}`);
      if (consoleErrorMessages.length < 10) consoleErrorMessages.push(text);
    } else if (msg.type() === "log") {
      if (/\[f9|topDown|cameraSwitcher/i.test(text)) {
        console.log(`[browser] ${text}`);
      }
    }
  });
  page.on("pageerror", (err) => {
    consoleErrors += 1;
    console.error("[pageerror]", err.message);
    if (consoleErrorMessages.length < 10) consoleErrorMessages.push(err.message);
  });

  let result = {
    initOk: false,
    screenshotOk: false,
    captureWidth: CAPTURE_W,
    captureHeight: CAPTURE_H,
    holtburgCentre: { x: HCX, y: HCY },
    frustumMetres: FRUSTUM_M,
    error: null,
    errorStack: null,
  };

  try {
    await page.goto(PAGE_URL, { waitUntil: "domcontentloaded" });

    try {
      await page.waitForFunction(
        () => {
          const r = document.getElementById("results");
          return r && /PASS/.test(r.innerHTML);
        },
        { timeout: SMOKE_TIMEOUT_MS }
      );
      console.log("in-page smoke panel: PASS");
    } catch (e) {
      const html = await page
        .locator("#results")
        .innerHTML()
        .catch(() => "(no #results)");
      console.error(
        `FAIL: in-page smoke panel never reached PASS within ${SMOKE_TIMEOUT_MS}ms`
      );
      console.error(`results HTML: ${html.slice(0, 500)}`);
      await browser.close();
      process.exit(1);
    }

    console.log("--- standalone init3D + topDown render ---");
    const probe = await page.evaluate(
      async ({ BUILD_TIMEOUT, HCX_, HCY_, FRUSTUM_M_, CAPTURE_W_, CAPTURE_H_ }) => {
        const out = { steps: [] };
        try {
          const canvas =
            document.getElementById("scene") ||
            document.querySelector("canvas");
          if (!canvas) {
            out.error = "no canvas in page";
            return out;
          }

          // Resize the canvas to match the WB.Terminal output exactly so
          // the screenshot lands at 1023×1023 with no scaling artifact.
          // Both attribute size AND CSS size need to flip so the
          // WebGLRenderer's drawing buffer matches the screenshot dims.
          canvas.width = CAPTURE_W_;
          canvas.height = CAPTURE_H_;
          canvas.style.width = `${CAPTURE_W_}px`;
          canvas.style.height = `${CAPTURE_H_}px`;
          out.steps.push(`canvas resized to ${CAPTURE_W_}x${CAPTURE_H_}`);

          const wasmMod = await import("./pkg/holtburger_web.js");
          out.steps.push(`wasm loaded`);
          const scene3d = await import("./scene3d/index.js");
          out.steps.push(`scene3d: init3D=${typeof scene3d.init3D}`);

          // Mock session — minimal API surface. Important: place the
          // player AT the Holtburg centre so the cameraSwitcher's
          // top-down `_safePlayerPos()` returns this point and the
          // ortho camera centres on Holtburg. Pose-position is read
          // through the session handle's safePlayerPos path.
          const mockSession = {
            isCurrentCellIndoor() { return false; },
            getCurrentCellId() { return 0; },
            getRenderSet() { return new Uint32Array(0); },
            setMovementInput() {},
            pollEntityUpdates() { return []; },
            getPlayerPosition() {
              return { x: HCX_, y: HCY_, z: 80 };
            },
            getPlayerHeading() { return 0; },
          };

          const wasmExports = {
            fetch_landblock_heightmaps: wasmMod.fetch_landblock_heightmaps,
            fetch_terrain_textures: wasmMod.fetch_terrain_textures,
            fetch_landblock_objects: wasmMod.fetch_landblock_objects,
            fetch_model_meshes: wasmMod.fetch_model_meshes,
            fetch_surfaces_pixels: wasmMod.fetch_surfaces_pixels,
            fetchBuildingPlacement: wasmMod.fetchBuildingPlacement,
            fetchEnvCellsInLandblock: wasmMod.fetchEnvCellsInLandblock,
            fetchEntityAnimationKeyframes: wasmMod.fetchEntityAnimationKeyframes,
            fetchEntityModelRender: wasmMod.fetchEntityModelRender,
            fetchEntitySurfacesPixels: wasmMod.fetchEntitySurfacesPixels,
          };

          const tStart = performance.now();
          const live = await Promise.race([
            scene3d.init3D(canvas, mockSession, wasmExports),
            new Promise((_, rej) =>
              setTimeout(() => rej(new Error("init3D timeout")), BUILD_TIMEOUT)
            ),
          ]);
          const tElapsed = (performance.now() - tStart) | 0;
          out.steps.push(`init3D resolved in ${tElapsed} ms`);

          // Snapshot scene shape for the result report.
          out.terrainLbCount = live.terrainGroup?.children?.length ?? 0;
          out.buildingsChildCount = live.buildingsGroup?.children?.length ?? 0;
          out.envCellCount = live.cellContainers3d?.size ?? 0;

          if (!live.cameraSwitcher) {
            out.error = "live.cameraSwitcher missing";
            return out;
          }

          // Flip to top-down ortho mode.
          live.cameraSwitcher.switchMode("topDown");
          out.steps.push(
            `switched to topDown; activeCamera=${live.cameraSwitcher.activeCamera?.constructor?.name}`
          );

          // Stop the cameraSwitcher's per-tick override so our manual
          // camera placement actually sticks. The loop's tick() resets
          // ortho.position to _safePlayerPos() every frame; we want
          // explicit control.
          live.cameraSwitcher.tick = () => {};

          const renderer = live.renderer;
          if (!renderer) {
            out.error = "live.renderer missing";
            return out;
          }
          renderer.setSize(CAPTURE_W_, CAPTURE_H_, false);
          out.steps.push(
            `renderer.setSize → ${renderer.domElement.width}x${renderer.domElement.height}`
          );

          // Resize the ortho frustum to cover exactly 3×3 LBs (the same
          // span the WB.Terminal radius=1 render captures). The
          // cameraSwitcher's topDown ortho was constructed with a 100 m
          // frustum height; we resize it to 576 m so the 9-LB
          // neighbourhood fills the view.
          const ortho = live.cameraSwitcher.activeCamera; // OrthographicCamera
          if (!ortho.isOrthographicCamera) {
            out.error = `activeCamera is ${ortho.constructor.name}, expected OrthographicCamera`;
            return out;
          }
          const aspect = CAPTURE_W_ / CAPTURE_H_;
          const halfH = FRUSTUM_M_ / 2;
          const halfW = halfH * aspect;
          ortho.left = -halfW;
          ortho.right = halfW;
          ortho.top = halfH;
          ortho.bottom = -halfH;
          ortho.zoom = 1.0;
          ortho.updateProjectionMatrix();
          out.steps.push(
            `ortho frustum: ${halfW * 2}m × ${halfH * 2}m, zoom=1`
          );

          // Position the ortho camera directly above Holtburg centre,
          // looking straight down. The scene3d worldRoot carries
          // rotation.x = -π/2 so AC (HCX, HCY, hi) maps to three.js
          // (HCX, hi, -HCY). Match the cameraSwitcher.positionCamera
          // topDown branch's convention: use acToThree, and set
          // camera.up = (0, 0, -1) so AC north stays at the top of
          // the screen.
          //
          // We import acToThree here via the live scene's loaded
          // adapter module — but that's an ESM import already done in
          // camera.js; we re-derive the mapping inline since it's a
          // 3-line function:
          //   acToThree(ax, ay, az) = (ax, az, -ay)
          const camHi = 300; // metres above terrain
          ortho.position.set(HCX_, camHi, -HCY_);
          ortho.up.set(0, 0, -1);
          ortho.lookAt(HCX_, 0, -HCY_);
          ortho.updateMatrixWorld(true);
          out.steps.push(
            `ortho camera positioned at three.js (${HCX_}, ${camHi}, ${-HCY_})`
          );

          // Force one explicit render before screenshot, in addition to
          // the rAF loop's tick. autoReset=true zeroes counters at the
          // start of every render() so capturing info.render.calls AFTER
          // gives the latest frame's count.
          renderer.render(live.scene, ortho);
          out.draws = renderer.info.render.calls;
          out.tris = renderer.info.render.triangles;
          out.steps.push(`render: draws=${out.draws}, tris=${out.tris}`);

          // Wait one rAF so the WebGL backbuffer is fully flushed
          // before the screenshot is taken. We also issue a manual
          // render() in the rAF callback in case the loop's
          // cameraSwitcher.tick override (now a no-op) was racing.
          await new Promise((r) =>
            requestAnimationFrame(() => {
              renderer.render(live.scene, ortho);
              r();
            })
          );

          out.initOk = true;
        } catch (e) {
          out.error = String(e?.message ?? e);
          out.errorStack = String(e?.stack ?? "").slice(0, 1200);
        }
        return out;
      },
      {
        BUILD_TIMEOUT: BUILD_TIMEOUT_MS,
        HCX_: HCX,
        HCY_: HCY,
        FRUSTUM_M_: FRUSTUM_M,
        CAPTURE_W_: CAPTURE_W,
        CAPTURE_H_: CAPTURE_H,
      }
    );

    console.log("probe result:", JSON.stringify(probe, null, 2));
    Object.assign(result, probe);

    if (probe.initOk) {
      // Screenshot the canvas only (omit-background trims to canvas
      // pixels). The viewport is sized to match, but the canvas may sit
      // inside layout; screenshotting the element directly is safer.
      const canvasEl = page.locator("canvas").first();
      const buf = await canvasEl.screenshot({ path: TD_PATH, omitBackground: false });
      result.screenshotOk = buf && buf.length > 0;
      result.screenshotBytes = buf?.length || 0;
      console.log(
        `screenshot → ${TD_PATH} (${result.screenshotBytes} bytes)`
      );
    }
  } catch (e) {
    console.error("FAIL: capture threw:", e?.message ?? e);
    result.error = result.error || String(e?.message ?? e);
  }

  await browser.close();

  // ------ Diff phase ----------------------------------------------------

  let diffPixels = -1;
  let totalPixels = -1;
  let diffPercent = -1;
  let diffNotes = "";
  let diffOk = false;

  if (result.screenshotOk && fs.existsSync(WB_PATH) && fs.existsSync(TD_PATH)) {
    try {
      const wbPng = PNG.sync.read(fs.readFileSync(WB_PATH));
      const tdPng = PNG.sync.read(fs.readFileSync(TD_PATH));
      const w = Math.min(wbPng.width, tdPng.width);
      const h = Math.min(wbPng.height, tdPng.height);
      totalPixels = w * h;
      result.wbDims = `${wbPng.width}x${wbPng.height}`;
      result.tdDims = `${tdPng.width}x${tdPng.height}`;

      // If dimensions don't match exactly, pixelmatch needs identical
      // sizes. Crop both to (w, h) by allocating new buffers; the
      // WB.Terminal output is 1023×1023 and the 3D screenshot should be
      // CAPTURE_W × CAPTURE_H = 1023×1023 from the canvas resize above,
      // so cropping should be a no-op in the happy path.
      function cropToWH(src, srcW, srcH, w, h) {
        if (srcW === w && srcH === h) return Buffer.from(src);
        const dst = Buffer.alloc(w * h * 4);
        for (let y = 0; y < h; y += 1) {
          const srcOff = y * srcW * 4;
          const dstOff = y * w * 4;
          src.copy(dst, dstOff, srcOff, srcOff + w * 4);
        }
        return dst;
      }
      const wbBuf = cropToWH(wbPng.data, wbPng.width, wbPng.height, w, h);
      const tdBuf = cropToWH(tdPng.data, tdPng.width, tdPng.height, w, h);
      const diffPng = new PNG({ width: w, height: h });

      diffPixels = pixelmatch(wbBuf, tdBuf, diffPng.data, w, h, {
        threshold: 0.1,
        alpha: 0.3,
        diffColor: [255, 0, 255],
      });
      diffPercent = +((diffPixels / totalPixels) * 100).toFixed(2);
      fs.writeFileSync(DIFF_PATH, PNG.sync.write(diffPng));
      diffOk = true;

      // Heuristic notes about where the bulk of the diff lives.
      // Walk the diff PNG and bin pixels into 3×3 LB tiles to see
      // where differences cluster. Each LB = 192 m = 192/576 of the
      // frame = ~341 px tile at 1023 px frame.
      const TILE = 341;
      const tileBins = [];
      for (let ty = 0; ty < 3; ty += 1) {
        for (let tx = 0; tx < 3; tx += 1) {
          let cnt = 0;
          for (let y = ty * TILE; y < (ty + 1) * TILE && y < h; y += 1) {
            for (let x = tx * TILE; x < (tx + 1) * TILE && x < w; x += 1) {
              const off = (y * w + x) * 4;
              // pixelmatch writes RGBA with R=255 G=0 B=255 alpha=alpha
              // for diff pixels (we set diffColor above).
              if (diffPng.data[off] === 255 && diffPng.data[off + 2] === 255) {
                cnt += 1;
              }
            }
          }
          tileBins.push({ tx, ty, diffCount: cnt });
        }
      }
      const sortedBins = [...tileBins].sort((a, b) => b.diffCount - a.diffCount);
      const totalBinDiff = tileBins.reduce((s, b) => s + b.diffCount, 0);
      const maxBinDiff = sortedBins[0]?.diffCount || 0;
      const minBinDiff = sortedBins[sortedBins.length - 1]?.diffCount || 0;
      const spread = totalBinDiff > 0 ? maxBinDiff / totalBinDiff : 0;
      const uniformish = spread < 0.25; // any single tile contributes <25%
      diffNotes =
        `diff distribution across 3×3 LB grid: max=${maxBinDiff}, min=${minBinDiff}; ` +
        `topTile=(tx=${sortedBins[0].tx},ty=${sortedBins[0].ty})=${sortedBins[0].diffCount}; ` +
        (uniformish
          ? "uniformish — diff is spread roughly evenly (suggests a global rotation/colour-space/lighting mismatch, not a specific feature)"
          : "concentrated — diff clusters in one tile (suggests a specific feature mismatch in that LB)");
      result.tileBins = tileBins;
    } catch (e) {
      diffNotes = `diff threw: ${String(e?.message ?? e)}`;
      console.error("diff failed:", e);
    }
  } else {
    diffNotes =
      "diff skipped: " +
      (!result.screenshotOk
        ? "no 3D screenshot. "
        : "") +
      (!fs.existsSync(WB_PATH) ? "no WB.Terminal PNG. " : "") +
      (!fs.existsSync(TD_PATH) ? "no 3D PNG. " : "");
  }

  const diffResult = {
    wb_path: WB_PATH,
    "3d_path": TD_PATH,
    diff_path: DIFF_PATH,
    totalPixels,
    diffPixels,
    diffPercent,
    notes: diffNotes,
    captureWidth: CAPTURE_W,
    captureHeight: CAPTURE_H,
    frustumMetres: FRUSTUM_M,
    holtburgCentre: { x: HCX, y: HCY },
    initOk: result.initOk,
    screenshotOk: result.screenshotOk,
    wbDims: result.wbDims || null,
    tdDims: result.tdDims || null,
    terrainLbCount: result.terrainLbCount,
    buildingsChildCount: result.buildingsChildCount,
    envCellCount: result.envCellCount,
    draws: result.draws,
    tris: result.tris,
    consoleErrors,
    captureError: result.error,
    tileBins: result.tileBins,
  };
  fs.writeFileSync(RESULT_PATH, JSON.stringify(diffResult, null, 2));

  console.log("=========================");
  console.log("F#9 diff result:", JSON.stringify(diffResult, null, 2));
  console.log("=========================");

  let failures = 0;
  function check(name, ok, detail) {
    const status = ok ? "OK" : "FAIL";
    console.log(`  [${status}] ${name}${detail ? " — " + detail : ""}`);
    if (!ok) failures += 1;
  }

  // Diagnostic-style checks. The diff number itself is NOT a pass/fail
  // gate — the task brief says "pixel diff is the regression signal,
  // not a pass/fail gate". We assert only that the capture chain ran
  // end-to-end + the artifacts exist, so future regressions in the
  // pipeline are caught.
  check(
    "F#9: WB.Terminal ground truth PNG exists",
    fs.existsSync(WB_PATH),
    `path=${WB_PATH}`
  );
  check(
    "F#9: 3D top-down screenshot written",
    fs.existsSync(TD_PATH) && result.screenshotOk,
    `path=${TD_PATH}, bytes=${result.screenshotBytes || 0}`
  );
  check(
    "F#9: init3D resolved successfully",
    result.initOk,
    result.error ? `error=${result.error}` : ""
  );
  check(
    "F#9: pixelmatch ran end-to-end",
    diffOk,
    `diffPixels=${diffPixels}/${totalPixels} (${diffPercent}%)`
  );
  check(
    "F#9: diff result JSON written",
    fs.existsSync(RESULT_PATH),
    `path=${RESULT_PATH}`
  );

  if (failures > 0) {
    console.log(`FAIL: ${failures} check(s) failed.`);
    process.exit(1);
  } else {
    console.log("PASS: all F#9 capture checks green.");
    process.exit(0);
  }
})().catch((err) => {
  console.error("capture failed:", err);
  process.exit(1);
});
