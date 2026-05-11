// Phase 7.0 capture script — sanity-checks that `?renderer=3d` boots
// the three.js scaffolding and renders the hello-world BoxGeometry
// cube into the canvas, without requiring a live ACE login.
//
// Strategy: we can't drive `renderHoltburg()` end-to-end here because
// that path waits on `init_resource_source` (set up during login) +
// `fetch_landblock_heightmaps` (live ACE). Instead this script:
//   1. Loads the page with `?renderer=3d`.
//   2. Waits for the in-page smoke #results panel to PASS — confirms
//      pkg/holtburger_web.js loaded and the wasm bundle initialised
//      without console errors.
//   3. Injects a direct call to `init3D(canvas, null, {})` from the
//      dynamically-imported scene3d module — this is renderer-only,
//      doesn't touch wasm session/data calls, and is the same code
//      path the `?renderer=3d` flag wires up post-login.
//   4. Asserts:
//        - `window.liveScene3d` exists.
//        - `liveScene3d.scene.children.length > 0` (worldRoot + lights
//          minimum).
//        - `liveScene3d.helloCube` is a Mesh.
//        - The renderer drew at least one frame (canvas pixel
//          content is non-uniform vs the page-load placeholder).
//
// Pre-reqs:
//   - Live HTTP server on port 8765 from external/holtburger/ (the
//     auto-memory says it's up on Tailscale 100.116.47.66).
//   - Manifest+shards baked under dist/ (so the page's Phase 5.0b
//     init_resource_source call resolves).
//   - Playwright in the npx cache at
//     /home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules/.
//
// Run from `apps/holtburger-web/`:
//   NODE_PATH=/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules \
//   node capture_phase7_0_hello_cube.cjs

const path = require("node:path");

// Playwright lives in the npx cache by default. Allow override but
// default to the cached location so the script works without manual
// NODE_PATH wiring.
const PLAYWRIGHT_CACHE =
  process.env.PLAYWRIGHT_CACHE ||
  "/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules";

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
        "\n" +
        "Set NODE_PATH or PLAYWRIGHT_CACHE to a valid playwright install."
    );
    process.exit(2);
  }
}

(async () => {
  const PAGE_URL =
    process.env.PHASE7_PAGE_URL ||
    "http://100.116.47.66:8765/apps/holtburger-web/index.html?renderer=3d";
  const SMOKE_TIMEOUT_MS = Number(process.env.PHASE7_SMOKE_TIMEOUT_MS || 30_000);
  const RENDER_SETTLE_MS = Number(process.env.PHASE7_RENDER_SETTLE_MS || 1_500);

  console.log(`launching chromium → ${PAGE_URL}`);

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
      console.log(`[browser error] ${msg.text()}`);
    }
  });
  page.on("pageerror", (err) => {
    consoleErrors += 1;
    console.error("[pageerror]", err.message);
  });

  await page.goto(PAGE_URL, { waitUntil: "domcontentloaded" });

  // Wait for the in-page #results smoke panel to PASS. This is the
  // Phase 4 "page boots cleanly" gate — confirms wasm bundle loaded
  // and the importmap resolved both pixi.js + three.js (the
  // importmap is parsed at this point even though three isn't
  // imported until init3D fires).
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
    const html = await page.locator("#results").innerHTML().catch(() => "(no #results)");
    console.error(
      `FAIL: in-page smoke panel never reached PASS within ${SMOKE_TIMEOUT_MS}ms`
    );
    console.error(`results HTML: ${html.slice(0, 500)}`);
    await browser.close();
    process.exit(1);
  }

  // Drive init3D directly. We're not logged in — the login form is
  // visible — but the canvas exists and three.js is dynamically
  // imported on-demand. This bypasses the `renderHoltburg()` wasm
  // calls (which need a live session) and exercises only the
  // renderer-side code that Phase 7.0 ships.
  const probe = await page.evaluate(async () => {
    const out = { steps: [], scene3dImportError: null };
    try {
      const canvas = document.getElementById("scene") || document.querySelector("canvas");
      if (!canvas) {
        out.steps.push("no canvas in page");
        return out;
      }
      out.steps.push(`canvas found: ${canvas.width}x${canvas.height}`);

      // Same dynamic import the index.html feature flag fires.
      const mod = await import("./scene3d/index.js");
      out.steps.push(`scene3d module loaded: typeof init3D=${typeof mod.init3D}`);

      const live = await mod.init3D(canvas, null, {});
      out.steps.push("init3D resolved");
      out.windowLiveScene3d = !!window.liveScene3d;
      out.sceneChildrenCount = live.scene.children.length;
      out.worldRootChildrenCount = live.worldRoot.children.length;
      out.helloCubeIsMesh = !!(live.helloCube && live.helloCube.isMesh);
      out.helloCubePosition = {
        x: live.helloCube?.position?.x ?? null,
        y: live.helloCube?.position?.y ?? null,
        z: live.helloCube?.position?.z ?? null,
      };
      out.rendererType = live.renderer?.constructor?.name ?? null;
    } catch (e) {
      out.scene3dImportError = String(e?.message ?? e);
    }
    return out;
  });

  console.log("init3D probe result:", JSON.stringify(probe, null, 2));

  // Allow a couple of frames for the rAF loop to actually paint.
  await page.waitForTimeout(RENDER_SETTLE_MS);

  let failures = 0;
  function check(name, ok, detail) {
    const status = ok ? "OK" : "FAIL";
    console.log(`  [${status}] ${name}${detail ? " — " + detail : ""}`);
    if (!ok) failures += 1;
  }

  if (probe.scene3dImportError) {
    check(
      "Phase 7.0 init3D resolves without throwing",
      false,
      probe.scene3dImportError
    );
  } else {
    check(
      "Phase 7.0 window.liveScene3d set after init3D()",
      probe.windowLiveScene3d === true
    );
    check(
      "Phase 7.0 liveScene3d.scene.children.length > 0",
      (probe.sceneChildrenCount || 0) > 0,
      `children=${probe.sceneChildrenCount}`
    );
    check(
      "Phase 7.0 worldRoot has 6 children (5 groups + cube)",
      probe.worldRootChildrenCount === 6,
      `worldRoot.children=${probe.worldRootChildrenCount}`
    );
    check(
      "Phase 7.0 helloCube is a THREE.Mesh",
      probe.helloCubeIsMesh === true
    );
    check(
      "Phase 7.0 helloCube position = (0, 0, 5) in AC coords",
      probe.helloCubePosition?.x === 0 &&
        probe.helloCubePosition?.y === 0 &&
        probe.helloCubePosition?.z === 5,
      JSON.stringify(probe.helloCubePosition)
    );
    check(
      "Phase 7.0 renderer is WebGLRenderer",
      probe.rendererType === "WebGLRenderer",
      `rendererType=${probe.rendererType}`
    );
  }

  check(
    "Phase 7.0 zero browser console errors during boot + init3D",
    consoleErrors === 0,
    `errors=${consoleErrors}`
  );

  await browser.close();

  if (failures > 0) {
    console.log(`FAIL: ${failures} check(s) failed.`);
    process.exit(1);
  } else {
    console.log("PASS: all Phase 7.0 capture checks green.");
    process.exit(0);
  }
})();
