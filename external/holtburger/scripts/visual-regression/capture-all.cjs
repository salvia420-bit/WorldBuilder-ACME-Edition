// Phase X.2 — visual regression capture script.
//
// Loads a single view (or every view) at a single quality preset (or
// every preset), positions the player via @teleloc when ACE is wired,
// and screenshots the renderer canvas to a date-versioned path under
// /mnt/wbterminal1/holtburger-goldens/.
//
// Two modes:
//
//   1. LAPTOP-SAFE (default): drives init3D directly with a mockSession,
//      same pattern as capture_visfid_p01_shadows.cjs. Captures the
//      Holtburg 9-LB default framing. Suitable for harness validation
//      and quality=low/mid captures. DO NOT run with --quality=ultra
//      locally — see §7 Hard rule.
//
//   2. LIVE-ACE: opt-in via `--live --account ... --password ...`. Logs
//      in, character-creates if needed, teleloc's to the view's cell,
//      waits for spawn to settle, then captures. Intended for PK to
//      run on the Tailscale box for the full 40-capture golden bake.
//
// Args:
//   --view <id>          Capture a single view (matches views.json id).
//   --quality <preset>   Use a single preset (low|mid|high|ultra).
//   --all                Capture every view × every preset (USE WITH CARE).
//   --live               Use live-ACE path (otherwise mockSession only).
//   --out <dir>          Override output root.
//   --views <path>       Override views.json path.
//
// Env:
//   VISREG_PAGE_BASE     Dev-server URL (default http://127.0.0.1:8765/apps/holtburger-web/index.html).
//   VISREG_SMOKE_TIMEOUT_MS, VISREG_BUILD_TIMEOUT_MS, VISREG_RENDER_WAIT_MS.
//
// Run from the worktree root or any cwd:
//   NODE_PATH=/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules \
//   node external/holtburger/scripts/visual-regression/capture-all.cjs \
//     --view holtburg_plaza_noon --quality low

const path = require("node:path");
const fs = require("node:fs");

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
    console.error(
      "FAIL: playwright not found in NODE_PATH or " + PLAYWRIGHT_CACHE
    );
    process.exit(2);
  }
}

const PAGE_BASE =
  process.env.VISREG_PAGE_BASE ||
  "http://127.0.0.1:8765/apps/holtburger-web/index.html";
const SMOKE_TIMEOUT_MS = Number(process.env.VISREG_SMOKE_TIMEOUT_MS || 90_000);
const BUILD_TIMEOUT_MS = Number(process.env.VISREG_BUILD_TIMEOUT_MS || 180_000);
const RENDER_WAIT_MS = Number(process.env.VISREG_RENDER_WAIT_MS || 4_000);
const GOLDENS_ROOT_DEFAULT = "/mnt/wbterminal1/holtburger-goldens";

function parseArgs(argv) {
  const args = {
    view: null,
    quality: null,
    all: false,
    live: false,
    out: GOLDENS_ROOT_DEFAULT,
    views: path.resolve(__dirname, "views.json"),
    account: process.env.VISREG_ACCOUNT || null,
    password: process.env.VISREG_PASSWORD || null,
    bridgeUrl: process.env.VISREG_BRIDGE_URL || null,
    serverHost: process.env.VISREG_SERVER_HOST || null,
    serverPort: process.env.VISREG_SERVER_PORT || null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case "--view": args.view = next(); break;
      case "--quality": args.quality = next(); break;
      case "--all": args.all = true; break;
      case "--live": args.live = true; break;
      case "--out": args.out = next(); break;
      case "--views": args.views = next(); break;
      case "--account": args.account = next(); break;
      case "--password": args.password = next(); break;
      case "--bridge-url": args.bridgeUrl = next(); break;
      case "--server-host": args.serverHost = next(); break;
      case "--server-port": args.serverPort = next(); break;
      case "--help":
      case "-h":
        printUsage();
        process.exit(0);
        break;
      default:
        if (a.startsWith("--")) {
          console.error(`unknown flag: ${a}`);
          process.exit(2);
        }
    }
  }
  return args;
}

function printUsage() {
  console.log(
    "Usage: capture-all.cjs [--view <id>] [--quality <preset>] [--all] [--live] [--out <dir>]"
  );
  console.log(
    "  --view <id>          single view from views.json"
  );
  console.log(
    "  --quality <preset>   single preset (low|mid|high|ultra)"
  );
  console.log(
    "  --all                every view × every preset (DEFER TO LIVE-ACE)"
  );
  console.log(
    "  --live               use ACE login/teleloc path (default: mockSession)"
  );
}

function todayStamp() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}_${hh}${mi}${ss}`;
}

function loadViews(viewsPath) {
  if (!fs.existsSync(viewsPath)) {
    console.error(`FAIL: views.json not found at ${viewsPath}`);
    process.exit(2);
  }
  const raw = fs.readFileSync(viewsPath, "utf8");
  let doc;
  try { doc = JSON.parse(raw); } catch (e) {
    console.error(`FAIL: views.json is not valid JSON: ${e.message}`);
    process.exit(2);
  }
  if (!Array.isArray(doc.views) || doc.views.length === 0) {
    console.error("FAIL: views.json has no `views` array");
    process.exit(2);
  }
  return doc;
}

function buildUrl(view, preset) {
  const base = PAGE_BASE;
  const qs = new URLSearchParams();
  qs.set("renderer", "3d");
  qs.set("quality", preset);
  if (view.skyhour !== undefined && view.skyhour !== null) {
    qs.set("skyhour", String(view.skyhour));
  }
  return `${base}?${qs.toString()}`;
}

async function captureMockSessionView(view, preset, outRoot) {
  const stamp = todayStamp();
  const viewDir = path.join(outRoot, view.id, preset);
  fs.mkdirSync(viewDir, { recursive: true });
  const fpath = path.join(viewDir, `${stamp}.png`);
  const pageUrl = buildUrl(view, preset);

  console.log(
    `[visfid-x2] view=${view.id} preset=${preset} url=${pageUrl}`
  );

  const browser = await chromium.launch({
    args: ["--use-gl=swiftshader"],
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 1024 },
  });
  const page = await context.newPage();

  let consoleErrors = 0;
  page.on("console", (msg) => {
    if (msg.type() === "error") {
      consoleErrors += 1;
      if (consoleErrors <= 5) console.log(`  [browser error] ${msg.text()}`);
    }
  });
  page.on("pageerror", (err) => {
    consoleErrors += 1;
    console.error(`  [pageerror] ${err.message}`);
  });

  await page.goto(pageUrl, { waitUntil: "domcontentloaded" });

  try {
    await page.waitForFunction(
      () => {
        const r = document.getElementById("results");
        return r && /PASS/.test(r.innerHTML);
      },
      { timeout: SMOKE_TIMEOUT_MS }
    );
  } catch (e) {
    const html = await page
      .locator("#results")
      .innerHTML()
      .catch(() => "(no #results)");
    console.error(
      `  FAIL: smoke panel never reached PASS within ${SMOKE_TIMEOUT_MS}ms`
    );
    console.error(`  results HTML: ${html.slice(0, 300)}`);
    await browser.close();
    return { ok: false, fpath: null, reason: "smoke timeout" };
  }

  const probe = await page.evaluate(async (BUILD_TIMEOUT) => {
    const out = {};
    try {
      const canvas =
        document.getElementById("scene") || document.querySelector("canvas");
      if (!canvas) { out.error = "no canvas"; return out; }
      const wasmMod = await import("./pkg/holtburger_web.js?v=h3-e1");
      const scene3d = await import("./scene3d/index.js");
      const mockSession = {
        isCurrentCellIndoor() { return false; },
        getCurrentCellId() { return 0; },
        getRenderSet() { return new Uint32Array(0); },
        setMovementInput() {},
        pollEntityUpdates() { return []; },
      };
      const wasmExports = {
        fetch_landblock_heightmaps: wasmMod.fetch_landblock_heightmaps,
        fetch_terrain_textures: wasmMod.fetch_terrain_textures,
        fetch_landblock_objects: wasmMod.fetch_landblock_objects,
        fetch_model_meshes: wasmMod.fetch_model_meshes,
        fetch_surfaces_pixels: wasmMod.fetch_surfaces_pixels,
        fetchBuildingPlacement: wasmMod.fetchBuildingPlacement,
        fetchSetupModelLights: wasmMod.fetchSetupModelLights,
        fetchEnvCellsInLandblock: wasmMod.fetchEnvCellsInLandblock,
        fetchEntityAnimationKeyframes: wasmMod.fetchEntityAnimationKeyframes,
        fetchEntityModelRender: wasmMod.fetchEntityModelRender,
        fetchEntitySurfacesPixels: wasmMod.fetchEntitySurfacesPixels,
      };
      const live = await Promise.race([
        scene3d.init3D(canvas, mockSession, wasmExports),
        new Promise((_, rej) =>
          setTimeout(() => rej(new Error("init3D timeout")), BUILD_TIMEOUT)
        ),
      ]);
      out.qualityPreset = live.quality?.preset ?? null;
      out.qualitySource = live.quality?.source ?? null;
      out.initOk = true;
    } catch (e) {
      out.error = String(e?.message ?? e);
    }
    return out;
  }, BUILD_TIMEOUT_MS);

  console.log(
    `  probe: initOk=${probe.initOk} quality=${probe.qualityPreset} source=${probe.qualitySource}`
  );

  if (!probe.initOk) {
    console.error(`  FAIL: init3D failed: ${probe.error}`);
    await browser.close();
    return { ok: false, fpath: null, reason: probe.error };
  }

  await page.waitForTimeout(RENDER_WAIT_MS);

  await page.evaluate(async () => {
    try {
      const live = window.liveScene3d;
      if (!live?.lighting?.sun?.castShadow) return;
      const lightingMod = await import("./scene3d/lighting.js");
      const { tickLightingForCellState } = lightingMod;
      for (let i = 0; i < 3; i += 1) {
        tickLightingForCellState(live, live.sessionHandle);
      }
    } catch (_) {}
  });

  await page.waitForTimeout(1500);

  const canvasHandle = await page.$("#scene, canvas");
  if (canvasHandle) {
    await canvasHandle.screenshot({ path: fpath, type: "png" });
  } else {
    await page.screenshot({ path: fpath, type: "png" });
  }

  console.log(`  screenshot -> ${fpath} (errors=${consoleErrors})`);
  await browser.close();
  return { ok: true, fpath, consoleErrors, qualityPreset: probe.qualityPreset };
}

async function captureLiveAceView(view, preset, outRoot, args) {
  // Skeleton implementation. PK runs this on the live-ACE box. The
  // mockSession path (above) doesn't drive @teleloc — it just shows
  // the default Holtburg 9-LB framing. The live path here would:
  //   1. Boot the page at PAGE_BASE.
  //   2. Fill login form (account, password, bridge_url, server_host,
  //      server_port) and submit.
  //   3. Pick a character (or create one) and enter world.
  //   4. Wait for player landblockId to stabilise.
  //   5. Dispatch `@teleloc <cellHex> <origin>` via window.__sessionHandle.sendChat
  //      to position the player at the view's cell + origin.
  //   6. Wait for cell load to settle.
  //   7. Drive the lighting tick + screenshot canvas.
  //
  // Reference patterns:
  //   - capture_academy_envcells.cjs lines 210–237 (login)
  //   - capture_academy_tour.cjs lines 347–360 (sendChat helper)
  //   - capture_academy_tour.cjs lines 583–620 (teleloc dispatch + wait)
  //
  // This function is intentionally a stub on the laptop. PK should
  // copy/adapt the academy_tour pattern when wiring it on hardware.
  console.error(
    "[visfid-x2] --live path is a stub on the laptop. PK: see comments + " +
      "capture_academy_tour.cjs for the login + teleloc pattern."
  );
  return {
    ok: false,
    fpath: null,
    reason: "--live path requires hardware (live-ACE on Tailscale 100.116.47.66)",
  };
}

async function captureOne(view, preset, args) {
  if (args.live) return captureLiveAceView(view, preset, args.out, args);
  return captureMockSessionView(view, preset, args.out);
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  const viewsDoc = loadViews(args.views);

  // Build (view, preset) work list.
  let viewList = viewsDoc.views;
  if (args.view) {
    viewList = viewList.filter((v) => v.id === args.view);
    if (viewList.length === 0) {
      console.error(`FAIL: view '${args.view}' not in views.json`);
      process.exit(2);
    }
  }

  const allPresets = ["low", "mid", "high", "ultra"];
  let presets;
  if (args.quality) {
    if (!allPresets.includes(args.quality)) {
      console.error(
        `FAIL: --quality '${args.quality}' not in ${allPresets.join(",")}`
      );
      process.exit(2);
    }
    presets = [args.quality];
  } else if (args.all) {
    presets = allPresets;
  } else {
    console.error(
      "FAIL: must pass --quality <preset> OR --all (refusing implicit-all to keep laptop safe)"
    );
    process.exit(2);
  }

  // Safety gate: refuse to capture quality=ultra without explicit
  // override. The §7 hard rule from the visual-fidelity plan says
  // ultra captures load full Dereth at high cost — defer to live-ACE.
  if (
    !args.live &&
    presets.includes("ultra") &&
    process.env.VISREG_ALLOW_LOCAL_ULTRA !== "1"
  ) {
    console.error(
      "FAIL: quality=ultra on a non-live capture path is laptop-unsafe per §7 hard rule."
    );
    console.error(
      "      Set VISREG_ALLOW_LOCAL_ULTRA=1 to override, or run on live-ACE with --live."
    );
    process.exit(2);
  }

  // Equivalent gate for --all on the laptop: 10 × 4 = 40 captures
  // is not what we want to run locally.
  if (args.all && !args.live) {
    console.error(
      "FAIL: --all on a non-live capture path is laptop-unsafe per §7 hard rule."
    );
    console.error(
      "      Use --view + --quality to run a small subset locally; --all is a live-ACE operation."
    );
    process.exit(2);
  }

  console.log(
    `[visfid-x2] plan: ${viewList.length} view(s) × ${presets.length} preset(s) ` +
      `= ${viewList.length * presets.length} capture(s); mode=${args.live ? "live-ACE" : "mockSession"}`
  );
  console.log(`[visfid-x2] out root: ${args.out}`);

  fs.mkdirSync(args.out, { recursive: true });

  const results = [];
  let failures = 0;
  for (const view of viewList) {
    for (const preset of presets) {
      const r = await captureOne(view, preset, args);
      results.push({ view: view.id, preset, ...r });
      if (!r.ok) failures += 1;
    }
  }

  // Emit summary JSON next to the captures.
  const summaryPath = path.join(
    args.out,
    `_summary-${todayStamp()}.json`
  );
  fs.writeFileSync(
    summaryPath,
    JSON.stringify(
      { viewsDoc: { version: viewsDoc.version, count: viewList.length }, results, failures },
      null,
      2
    )
  );

  console.log("=========================");
  console.log(`[visfid-x2] summary: ${results.length - failures}/${results.length} ok`);
  console.log(`[visfid-x2] summary written to ${summaryPath}`);
  if (failures > 0) {
    console.log(`[visfid-x2] FAIL (${failures} capture(s) failed)`);
    process.exit(1);
  }
  console.log("[visfid-x2] PASS");
  process.exit(0);
})().catch((e) => {
  console.error("[visfid-x2] capture script threw:", e?.message ?? e);
  console.error(e?.stack ?? "");
  process.exit(2);
});
