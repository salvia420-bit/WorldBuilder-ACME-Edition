// Phase 7.1 capture script — drives `init3D` against real Holtburg
// wasm exports and asserts the 9-LB terrain ring built into
// `liveScene3d.terrainGroup`.
//
// Strategy: same shape as `capture_phase7_0_hello_cube.cjs`, but the
// `init3D` call carries the real `fetch_landblock_heightmaps` +
// `fetch_terrain_textures` exports pulled from the same `pkg/` module
// the page itself loads. The page's main script already calls
// `init()` + `init_resource_source(MANIFEST_URL)` on boot — the
// in-page smoke `#results` PASS gate confirms both have completed.
// We then re-import the same module from page context (the second
// import resolves to the cached instance) and forward the exports
// into `init3D`.
//
// Assertions:
//   1. `liveScene3d.terrainGroup.children.length === 9` (Holtburg's
//      9-LB neighbourhood ring).
//   2. Each LB child is a `THREE.Mesh` with `geometry.attributes
//      .position.count === 81` (9×9 vertex grid per LB).
//   3. Per-LB heightMin / heightMax variation > 0 — terrain isn't
//      flat-zero, proving heights wired through (real Holtburg has
//      ~10–80 m elevation across the ring).
//   4. At least one LB has a road overlay child (Holtburg has roads
//      visible in the 2D `render-preview` baseline).
//   5. Browser console has no errors during boot + init3D.
//
// Pre-reqs (same as the Phase 7.0 capture):
//   - Live HTTP server on port 8765 from external/holtburger/.
//   - Manifest+shards baked under dist/.
//   - Playwright in the npx cache at
//     /home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules/.
//
// Run from `apps/holtburger-web/`:
//   NODE_PATH=/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules \
//   node capture_phase7_1_terrain.cjs

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
  const SMOKE_TIMEOUT_MS = Number(process.env.PHASE7_SMOKE_TIMEOUT_MS || 60_000);
  const RENDER_SETTLE_MS = Number(process.env.PHASE7_RENDER_SETTLE_MS || 2_000);
  const TERRAIN_BUILD_TIMEOUT_MS = Number(
    process.env.PHASE7_TERRAIN_BUILD_TIMEOUT_MS || 30_000
  );

  console.log(`launching chromium → ${PAGE_URL}`);

  const browser = await chromium.launch({
    args: ["--use-gl=swiftshader"],
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 1024 },
  });
  const page = await context.newPage();

  let consoleErrors = 0;
  const consoleErrorMessages = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") {
      consoleErrors += 1;
      const text = msg.text();
      console.log(`[browser error] ${text}`);
      if (consoleErrorMessages.length < 10) consoleErrorMessages.push(text);
    }
  });
  page.on("pageerror", (err) => {
    consoleErrors += 1;
    console.error("[pageerror]", err.message);
    if (consoleErrorMessages.length < 10) consoleErrorMessages.push(err.message);
  });

  let probe;
  try {
    await page.goto(PAGE_URL, { waitUntil: "domcontentloaded" });

    // Wait for the in-page #results smoke panel to PASS — confirms
    // wasm loaded + manifest source initialised. Larger timeout than
    // the 7.0 capture: we'll be making real DAT shard fetches.
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

    // Drive init3D with REAL wasm exports. The page's own bootstrap
    // already called `init()` + `init_resource_source(MANIFEST_URL)`,
    // so re-importing `./pkg/holtburger_web.js` from page context
    // returns the cached module instance — `fetch_landblock_heightmaps`
    // is ready to call.
    probe = await page.evaluate(async (TERRAIN_BUILD_TIMEOUT) => {
      const out = { steps: [] };
      try {
        const canvas =
          document.getElementById("scene") || document.querySelector("canvas");
        if (!canvas) {
          out.error = "no canvas in page";
          return out;
        }
        out.steps.push(`canvas: ${canvas.width}x${canvas.height}`);

        const wasmMod = await import("./pkg/holtburger_web.js");
        out.steps.push(
          `wasm module loaded: heightmaps=${typeof wasmMod.fetch_landblock_heightmaps}, textures=${typeof wasmMod.fetch_terrain_textures}`
        );

        const scene3d = await import("./scene3d/index.js");
        out.steps.push(`scene3d module: init3D=${typeof scene3d.init3D}`);

        // Real wasm exports payload — same shape the index.html
        // feature-flag branch passes at line ~4702 (only the four
        // currently used by Phase 7.1 + future-stub safety; later
        // phases extend this).
        const wasmExports = {
          fetch_landblock_heightmaps: wasmMod.fetch_landblock_heightmaps,
          fetch_terrain_textures: wasmMod.fetch_terrain_textures,
        };

        const tStart = performance.now();
        const live = await Promise.race([
          scene3d.init3D(canvas, null, wasmExports),
          new Promise((_, rej) =>
            setTimeout(
              () => rej(new Error("init3D timeout")),
              TERRAIN_BUILD_TIMEOUT
            )
          ),
        ]);
        const tElapsed = (performance.now() - tStart) | 0;
        out.steps.push(`init3D resolved in ${tElapsed} ms`);

        out.windowLiveScene3d = !!window.liveScene3d;
        out.terrainSummary = live.terrain
          ? {
              lbCount: live.terrain.lbCount,
              lbWithRoads: live.terrain.lbWithRoads,
              hasAtlasTexture: !!live.terrain.atlasTexture,
              hasRoadTexture: !!live.terrain.roadTexture,
            }
          : null;
        out.terrainGroupChildren = live.terrainGroup.children.length;

        // Per-LB introspection. We need to peek at each child's
        // geometry + userData without serialising the whole three
        // scene (PIXI/three objects don't survive JSON.stringify). So
        // build a small projection.
        const lbInfos = [];
        for (let i = 0; i < live.terrainGroup.children.length; i += 1) {
          const lb = live.terrainGroup.children[i];
          const isMesh = !!lb.isMesh;
          const positionCount = lb.geometry?.attributes?.position?.count ?? 0;
          const indexCount = lb.geometry?.index?.count ?? 0;
          const ud = lb.userData || {};
          // Detect a road-overlay child by name (set by the terrain
          // builder). Tolerate the camel-case or hyphen-case
          // variants — we set "road-overlay" in terrain.js.
          let hasRoadOverlay = false;
          for (const c of lb.children) {
            if (c.name === "road-overlay") {
              hasRoadOverlay = true;
              break;
            }
          }
          lbInfos.push({
            index: i,
            isMesh,
            name: lb.name,
            positionCount,
            indexCount,
            heightMin: ud.heightMin ?? null,
            heightMax: ud.heightMax ?? null,
            lbX: ud.lbX ?? null,
            lbY: ud.lbY ?? null,
            hasRoadOverlay,
            position: {
              x: lb.position.x,
              y: lb.position.y,
              z: lb.position.z,
            },
          });
        }
        out.lbInfos = lbInfos;
      } catch (e) {
        out.error = String(e?.message ?? e);
        out.errorStack = String(e?.stack ?? "").slice(0, 600);
      }
      return out;
    }, TERRAIN_BUILD_TIMEOUT_MS);
  } catch (e) {
    console.error("FAIL: page.evaluate threw:", e?.message ?? e);
    await browser.close();
    process.exit(1);
  }

  console.log("init3D probe:", JSON.stringify(probe, null, 2));

  await page.waitForTimeout(RENDER_SETTLE_MS);

  let failures = 0;
  function check(name, ok, detail) {
    const status = ok ? "OK" : "FAIL";
    console.log(`  [${status}] ${name}${detail ? " — " + detail : ""}`);
    if (!ok) failures += 1;
  }

  if (probe.error) {
    check(
      "Phase 7.1 init3D + buildHoltburgTerrain resolves without throwing",
      false,
      probe.error
    );
    if (probe.errorStack) console.error(probe.errorStack);
  } else {
    check(
      "Phase 7.1: window.liveScene3d set after init3D()",
      probe.windowLiveScene3d === true
    );
    check(
      "Phase 7.1: terrain summary populated (real wasm exports were used)",
      probe.terrainSummary !== null,
      probe.terrainSummary ? JSON.stringify(probe.terrainSummary) : "null"
    );
    check(
      "Phase 7.1: terrainGroup.children.length === 9 (Holtburg ring)",
      probe.terrainGroupChildren === 9,
      `count=${probe.terrainGroupChildren}`
    );

    // Per-LB checks roll up into single asserts — easier to read in
    // the capture log when 9 things either all pass or one fails.
    let allMeshes = true;
    let allHave81Verts = true;
    let allHaveHeightVariation = true;
    let anyHaveRoad = false;
    const lbInfos = probe.lbInfos || [];
    for (const lb of lbInfos) {
      if (!lb.isMesh) allMeshes = false;
      if (lb.positionCount !== 81) allHave81Verts = false;
      if (
        typeof lb.heightMin !== "number" ||
        typeof lb.heightMax !== "number" ||
        lb.heightMax - lb.heightMin <= 0
      ) {
        allHaveHeightVariation = false;
      }
      if (lb.hasRoadOverlay) anyHaveRoad = true;
    }

    check(
      "Phase 7.1: every terrainGroup child is a THREE.Mesh",
      allMeshes && lbInfos.length === 9,
      `meshes=${allMeshes}, lbCount=${lbInfos.length}`
    );
    check(
      "Phase 7.1: every LB has geometry.attributes.position.count === 81",
      allHave81Verts && lbInfos.length === 9,
      `pos81=${allHave81Verts}, lbCount=${lbInfos.length}`
    );
    check(
      "Phase 7.1: every LB has heightMax - heightMin > 0 (terrain isn't flat)",
      allHaveHeightVariation && lbInfos.length === 9,
      `heightVariation=${allHaveHeightVariation}, sample=` +
        JSON.stringify(
          lbInfos.slice(0, 3).map((lb) => ({
            name: lb.name,
            min: lb.heightMin,
            max: lb.heightMax,
          }))
        )
    );
    check(
      "Phase 7.1: at least one LB has a road overlay child (Holtburg has roads)",
      anyHaveRoad === true,
      `roadCount=${lbInfos.filter((l) => l.hasRoadOverlay).length}`
    );
  }

  check(
    "Phase 7.1: zero browser console errors during boot + init3D",
    consoleErrors === 0,
    `errors=${consoleErrors}` +
      (consoleErrorMessages.length
        ? `\n     first errors: ${JSON.stringify(consoleErrorMessages.slice(0, 3))}`
        : "")
  );

  await browser.close();

  if (failures > 0) {
    console.log(`FAIL: ${failures} check(s) failed.`);
    process.exit(1);
  } else {
    console.log("PASS: all Phase 7.1 capture checks green.");
    process.exit(0);
  }
})();
