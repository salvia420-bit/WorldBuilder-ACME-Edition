// Phase 7.2 capture script — drives `init3D` against real Holtburg
// wasm exports and asserts the buildings + statics that landed in
// Phase 7.2.
//
// Strategy: same shape as `capture_phase7_1_terrain.cjs`, but the
// `init3D` call carries the full Phase 7.2 wasm export bundle
// (`fetch_landblock_objects`, `fetch_model_meshes`,
// `fetch_surfaces_pixels`, `fetchBuildingPlacement`).
//
// Assertions:
//   1. liveScene3d.buildingsGroup.children.length >= 16 (Holtburg's
//      16 buildings, per migration auto-memory).
//   2. Every building Group has children.length >= 1 (single-part
//      0x01 GfxObj is the expected case for Holtburg, but the
//      structure must still produce the per-part hinge wrapper).
//   3. Every building Group's first child (the hinge wrapper) has
//      at least one Mesh child (the per-surface geometry).
//   4. liveScene3d.materialCache.materials.size > 0 — at least one
//      surface DID resolved to a real DataTexture.
//   5. liveScene3d.statics.objectCount >= 100 placements rendered
//      (Holtburg has ~225 non-building statics; some models will fail
//      to fetch or have 0 triangles, so the floor is conservative).
//      Note: F#5+6 (2026-05-10) collapsed N duplicate-modelId
//      placements into a single InstancedMesh, so the per-child count
//      `staticsGroup.children.length` is now ~66 (unique modelIds);
//      the load-bearing contract is the placement count in the summary.
//   6. Browser console has zero errors during boot + init3D.
//
// We additionally re-load the page WITHOUT `?renderer=3d` and assert
// that `liveScene3d` is undefined — proving the 2D path is unaffected
// by anything in scene3d/.
//
// Pre-reqs (same as the Phase 7.0/7.1 captures):
//   - Live HTTP server on port 8765 from external/holtburger/.
//   - Manifest+shards baked under dist/.
//   - Playwright in the npx cache at
//     /home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules/.
//
// Run from `apps/holtburger-web/`:
//   NODE_PATH=/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules \
//   node capture_phase7_2_buildings.cjs

const path = require("node:path");

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
  const PAGE_URL_2D =
    process.env.PHASE7_PAGE_URL_2D ||
    "http://100.116.47.66:8765/apps/holtburger-web/index.html";
  const SMOKE_TIMEOUT_MS = Number(
    process.env.PHASE7_SMOKE_TIMEOUT_MS || 60_000
  );
  const RENDER_SETTLE_MS = Number(process.env.PHASE7_RENDER_SETTLE_MS || 2_000);
  // Buildings + statics fetch can be slow on cold cache (10–20 unique
  // model_ids × per-part bake × N surfaces). Generous default; the
  // wasm side caches shards in-memory after the first fetch.
  const BUILD_TIMEOUT_MS = Number(
    process.env.PHASE7_BUILD_TIMEOUT_MS || 120_000
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
    // wasm loaded + manifest source initialised.
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

    // Drive init3D with the FULL Phase 7.2 wasm export bundle.
    probe = await page.evaluate(async (BUILD_TIMEOUT) => {
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
          `wasm module loaded: ` +
            `objects=${typeof wasmMod.fetch_landblock_objects}, ` +
            `bake=${typeof wasmMod.fetchBuildingPlacement}, ` +
            `models=${typeof wasmMod.fetch_model_meshes}, ` +
            `surfaces=${typeof wasmMod.fetch_surfaces_pixels}`
        );

        const scene3d = await import("./scene3d/index.js");
        out.steps.push(`scene3d module: init3D=${typeof scene3d.init3D}`);

        const wasmExports = {
          fetch_landblock_heightmaps: wasmMod.fetch_landblock_heightmaps,
          fetch_terrain_textures: wasmMod.fetch_terrain_textures,
          fetch_landblock_objects: wasmMod.fetch_landblock_objects,
          fetch_model_meshes: wasmMod.fetch_model_meshes,
          fetch_surfaces_pixels: wasmMod.fetch_surfaces_pixels,
          fetchBuildingPlacement: wasmMod.fetchBuildingPlacement,
        };

        const tStart = performance.now();
        const live = await Promise.race([
          scene3d.init3D(canvas, null, wasmExports),
          new Promise((_, rej) =>
            setTimeout(
              () => rej(new Error("init3D timeout")),
              BUILD_TIMEOUT
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
            }
          : null;
        out.buildingsSummary = live.buildings || null;
        out.staticsSummary = live.statics || null;
        out.terrainGroupChildren = live.terrainGroup.children.length;
        out.buildingsGroupChildren = live.buildingsGroup.children.length;
        out.staticsGroupChildren = live.staticsGroup.children.length;
        out.materialCacheSize = live.materialCache?.materials?.size ?? 0;
        out.materialCacheRealHits = live.materialCache?.realHits ?? 0;
        out.materialCacheFallbackHits = live.materialCache?.fallbackHits ?? 0;
        out.windowBuildingMap3dSize = window.buildingMap3d?.size ?? 0;

        // Per-building topology snapshot. Walk every Group in
        // buildingsGroup, count its hinge-wrapper children + the
        // Mesh leaves under each. Keep the first 5 detailed for
        // diagnostics; just totals for the rest.
        const buildingChildren = live.buildingsGroup.children;
        const buildingTopology = [];
        let allHaveAtLeastOnePart = true;
        let allHaveMeshLeaves = true;
        let totalParts = 0;
        let totalMeshes = 0;
        for (let i = 0; i < buildingChildren.length; i += 1) {
          const bg = buildingChildren[i];
          const partCount = bg.children.length;
          let meshCount = 0;
          for (const part of bg.children) {
            for (const leaf of part.children) {
              if (leaf.isMesh) meshCount += 1;
            }
          }
          totalParts += partCount;
          totalMeshes += meshCount;
          if (partCount < 1) allHaveAtLeastOnePart = false;
          if (meshCount < 1) allHaveMeshLeaves = false;
          if (i < 5) {
            buildingTopology.push({
              name: bg.name,
              partCount,
              meshCount,
              modelId:
                bg.userData?.modelId !== undefined
                  ? "0x" + (bg.userData.modelId >>> 0).toString(16)
                  : null,
            });
          }
        }
        out.buildingTopologySample = buildingTopology;
        out.buildingTotalParts = totalParts;
        out.buildingTotalMeshes = totalMeshes;
        out.allHaveAtLeastOnePart = allHaveAtLeastOnePart;
        out.allHaveMeshLeaves = allHaveMeshLeaves;

        // Statics topology — sample a couple, just sanity-check
        // they are real renderables. F#5+6 (2026-05-10) added three
        // possible child types under staticsGroup:
        //   - THREE.Mesh (singleton placement; one instance of a model)
        //   - THREE.InstancedMesh (multi-instance; isMesh is true since
        //     InstancedMesh extends Mesh — included by the original check)
        //   - THREE.LOD (full + degraded variants; NOT a Mesh —
        //     descendants are Meshes/InstancedMeshes)
        const staticsChildren = live.staticsGroup.children;
        let staticsAreMeshes = true;
        const staticsSample = [];
        for (let i = 0; i < staticsChildren.length; i += 1) {
          const s = staticsChildren[i];
          // Accept Mesh (and InstancedMesh) OR LOD.
          if (!s.isMesh && !s.isLOD) staticsAreMeshes = false;
          if (i < 3) {
            staticsSample.push({
              name: s.name,
              hasGeometry: !!s.geometry,
              vertexCount: s.geometry?.attributes?.position?.count ?? 0,
              isInstancedMesh: !!s.isInstancedMesh,
              isLOD: !!s.isLOD,
            });
          }
        }
        out.staticsAreMeshes = staticsAreMeshes;
        out.staticsSample = staticsSample;
      } catch (e) {
        out.error = String(e?.message ?? e);
        out.errorStack = String(e?.stack ?? "").slice(0, 800);
      }
      return out;
    }, BUILD_TIMEOUT_MS);
  } catch (e) {
    console.error("FAIL: page.evaluate threw:", e?.message ?? e);
    await browser.close();
    process.exit(1);
  }

  console.log("init3D probe:", JSON.stringify(probe, null, 2));

  await page.waitForTimeout(RENDER_SETTLE_MS);

  // ----- 2D-path regression check ------------------------------------
  // Reload WITHOUT the `?renderer=3d` flag; assert the page boots
  // cleanly and `liveScene3d` is undefined (the 2D PIXI path doesn't
  // touch scene3d at all).
  let pathDProbe = null;
  try {
    const page2d = await context.newPage();
    let consoleErrors2D = 0;
    page2d.on("console", (msg) => {
      if (msg.type() === "error") {
        consoleErrors2D += 1;
        console.log(`[browser2d error] ${msg.text()}`);
      }
    });
    page2d.on("pageerror", (err) => {
      consoleErrors2D += 1;
      console.error("[pageerror2d]", err.message);
    });
    await page2d.goto(PAGE_URL_2D, { waitUntil: "domcontentloaded" });
    try {
      await page2d.waitForFunction(
        () => {
          const r = document.getElementById("results");
          return r && /PASS/.test(r.innerHTML);
        },
        { timeout: SMOKE_TIMEOUT_MS }
      );
    } catch (_) {
      // tolerated; we only need the page to load without errors
    }
    pathDProbe = await page2d.evaluate(() => ({
      hasLiveScene3d: typeof window.liveScene3d !== "undefined",
      hasLiveScenePixi: typeof window.liveScene !== "undefined",
    }));
    pathDProbe.consoleErrors2D = consoleErrors2D;
    await page2d.close();
  } catch (e) {
    console.error("WARN: 2D-path regression check failed:", e?.message ?? e);
  }

  let failures = 0;
  function check(name, ok, detail) {
    const status = ok ? "OK" : "FAIL";
    console.log(`  [${status}] ${name}${detail ? " — " + detail : ""}`);
    if (!ok) failures += 1;
  }

  if (probe.error) {
    check(
      "Phase 7.2 init3D + buildHoltburgBuildings + buildHoltburgStatics resolves",
      false,
      probe.error
    );
    if (probe.errorStack) console.error(probe.errorStack);
  } else {
    check(
      "Phase 7.2: window.liveScene3d set after init3D()",
      probe.windowLiveScene3d === true
    );
    check(
      "Phase 7.2: terrain still built (Phase 7.1 stays green under 7.2)",
      probe.terrainSummary !== null && probe.terrainGroupChildren === 9,
      `lbCount=${probe.terrainSummary?.lbCount}, ` +
        `terrainChildren=${probe.terrainGroupChildren}`
    );
    check(
      "Phase 7.2: at least 16 building Groups in buildingsGroup (Holtburg has 16)",
      probe.buildingsGroupChildren >= 16,
      `count=${probe.buildingsGroupChildren}, summary=${JSON.stringify(probe.buildingsSummary)}`
    );
    check(
      "Phase 7.2: every building Group has at least one part (hinge wrapper) child",
      probe.allHaveAtLeastOnePart === true && probe.buildingsGroupChildren >= 1,
      `allHaveAtLeastOnePart=${probe.allHaveAtLeastOnePart}, ` +
        `totalParts=${probe.buildingTotalParts}, ` +
        `sample=${JSON.stringify(probe.buildingTopologySample)}`
    );
    check(
      "Phase 7.2: every building Group has at least one Mesh leaf (per-surface geometry)",
      probe.allHaveMeshLeaves === true && probe.buildingsGroupChildren >= 1,
      `allHaveMeshLeaves=${probe.allHaveMeshLeaves}, ` +
        `totalMeshes=${probe.buildingTotalMeshes}`
    );
    check(
      "Phase 7.2: materialCache.materials.size > 0 (at least one surface texture chain succeeded)",
      probe.materialCacheSize > 0,
      `size=${probe.materialCacheSize}, ` +
        `realHits=${probe.materialCacheRealHits}, ` +
        `fallbackHits=${probe.materialCacheFallbackHits}`
    );
    check(
      "Phase 7.2: window.buildingMap3d mirrors buildingsGroup",
      probe.windowBuildingMap3dSize === probe.buildingsGroupChildren &&
        probe.windowBuildingMap3dSize >= 16,
      `mapSize=${probe.windowBuildingMap3dSize}, ` +
        `groupChildren=${probe.buildingsGroupChildren}`
    );
    // F#5+6 (2026-05-10) — statics now collapse N duplicate-modelId
    // placements into a single `THREE.InstancedMesh` group, so
    // `staticsGroup.children.length` is the count of unique-model
    // groups (~66 for Holtburg), not the per-placement count
    // (~222). The semantic contract — "at least 100 statics rendered"
    // — moves to the summary's `objectCount` (= placements rendered).
    check(
      "Phase 7.2: at least 100 static placements rendered (Holtburg has ~225)",
      (probe.staticsSummary?.objectCount ?? 0) >= 100,
      `objectCount=${probe.staticsSummary?.objectCount}, ` +
        `staticsGroupChildren=${probe.staticsGroupChildren}, ` +
        `summary=${JSON.stringify(probe.staticsSummary)}`
    );
    check(
      "Phase 7.2: every staticsGroup child is a THREE.Mesh OR THREE.InstancedMesh OR THREE.LOD (F#5+6)",
      probe.staticsAreMeshes === true,
      `staticsAreMeshes=${probe.staticsAreMeshes}, ` +
        `sample=${JSON.stringify(probe.staticsSample)}`
    );
  }

  check(
    "Phase 7.2: zero browser console errors during 3D boot + init3D",
    consoleErrors === 0,
    `errors=${consoleErrors}` +
      (consoleErrorMessages.length
        ? `\n     first errors: ${JSON.stringify(consoleErrorMessages.slice(0, 3))}`
        : "")
  );

  if (pathDProbe) {
    check(
      "Phase 7.2: 2D path (no ?renderer=3d) does NOT initialise scene3d",
      pathDProbe.hasLiveScene3d === false,
      `hasLiveScene3d=${pathDProbe.hasLiveScene3d}, ` +
        `consoleErrors2D=${pathDProbe.consoleErrors2D}`
    );
  } else {
    check(
      "Phase 7.2: 2D path (no ?renderer=3d) does NOT initialise scene3d",
      false,
      "regression check did not run"
    );
  }

  await browser.close();

  if (failures > 0) {
    console.log(`FAIL: ${failures} check(s) failed.`);
    process.exit(1);
  } else {
    console.log("PASS: all Phase 7.2 capture checks green.");
    process.exit(0);
  }
})();
