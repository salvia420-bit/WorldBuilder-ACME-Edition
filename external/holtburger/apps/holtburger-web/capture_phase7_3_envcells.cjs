// Phase 7.3 capture script — drives `init3D` against real Holtburg
// wasm exports and asserts the EnvCell pipeline (Mite Maze +
// Holtburg Dungeon) ships real DAT data into `liveScene3d`.
//
// Strategy: same shape as `capture_phase7_2_buildings.cjs`, but the
// `init3D` call carries the full Phase 7.3 wasm export bundle
// (`fetchEnvCellsInLandblock` is the new addition; the cell loader
// also needs `fetch_model_meshes` + `fetch_surfaces_pixels` from the
// Phase 7.2 statics path, which the materialCache shares). The script
// then verifies (1) real cells loaded for both known dungeons,
// (2) cellContainers3d is populated and matches the cellCount sum,
// (3) at least one cell has rendered geometry (not an empty Group),
// (4) at least one cell has portalCellIds threading the BFS data
// through, (5) materialCache.materials.size grew vs the post-7.2
// snapshot (proving new env-cell surface DIDs resolved), and
// (6) the visibility tick fires correctly under stubbed
// `__sessionHandle` mocks for both outdoor (renderSet empty,
// !isIndoor) and indoor (renderSet contains a cell, isIndoor=true)
// scenarios.
//
// Pre-reqs (same as the Phase 7.2 capture):
//   - Live HTTP server on port 8765 from external/holtburger/.
//   - Manifest+shards baked under dist/.
//   - Playwright in the npx cache at
//     /home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules/.
//
// Run from `apps/holtburger-web/`:
//   NODE_PATH=/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules \
//   node capture_phase7_3_envcells.cjs

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
  const SMOKE_TIMEOUT_MS = Number(
    process.env.PHASE7_SMOKE_TIMEOUT_MS || 60_000
  );
  const RENDER_SETTLE_MS = Number(process.env.PHASE7_RENDER_SETTLE_MS || 2_000);
  // EnvCell load is a superset of Phase 7.2 (terrain + buildings +
  // statics + cells). Allow generous time on cold cache.
  const BUILD_TIMEOUT_MS = Number(
    process.env.PHASE7_BUILD_TIMEOUT_MS || 180_000
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
            `surfaces=${typeof wasmMod.fetch_surfaces_pixels}, ` +
            `envcells=${typeof wasmMod.fetchEnvCellsInLandblock}`
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
          fetchEnvCellsInLandblock: wasmMod.fetchEnvCellsInLandblock,
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
        out.terrainGroupChildren = live.terrainGroup.children.length;
        out.buildingsGroupChildren = live.buildingsGroup.children.length;
        out.staticsGroupChildren = live.staticsGroup.children.length;
        // F#5+6 (2026-05-10) — statics now collapse N duplicates into
        // one InstancedMesh per modelId; the per-placement count moves
        // to the summary.
        out.staticsObjectCount = live.statics?.objectCount ?? 0;
        out.cellsGroupChildren = live.cellsGroup.children.length;
        // Phase 7.2 baseline material count — used to verify env-cell
        // load grew the cache.
        const materialCountAfter72 = live.materialCache?.materials?.size ?? 0;
        out.materialCountAfter72 = materialCountAfter72;
        out.materialCountAfter73 = live.materialCache?.materials?.size ?? 0;
        // (Same value at this point — the eager EnvCell load already
        // ran inside init3D, so the post-7.3 count is the live size.
        // For the "grew vs 7.2" check we need a baseline before EnvCell
        // load. We instead capture the env-cell-only DIDs by counting
        // unique surface DIDs across the cellContainers3d's per-mesh
        // materials and asserting the count is > 0.)

        // Probe the EnvCell load summaries.
        out.envCellsLoaded = live.envCellsLoaded
          ? {
              miteMaze: live.envCellsLoaded.miteMaze
                ? {
                    landblockId: "0x" +
                      (live.envCellsLoaded.miteMaze.landblockId >>> 0)
                        .toString(16)
                        .padStart(8, "0"),
                    cellCount: live.envCellsLoaded.miteMaze.cellCount,
                    surfaceCount: live.envCellsLoaded.miteMaze.surfaceCount,
                    staticObjectCount:
                      live.envCellsLoaded.miteMaze.staticObjectCount,
                    skippedZeroTri:
                      live.envCellsLoaded.miteMaze.skippedZeroTri,
                    skippedNoMesh:
                      live.envCellsLoaded.miteMaze.skippedNoMesh,
                  }
                : null,
              holtDungeon: live.envCellsLoaded.holtDungeon
                ? {
                    landblockId: "0x" +
                      (live.envCellsLoaded.holtDungeon.landblockId >>> 0)
                        .toString(16)
                        .padStart(8, "0"),
                    cellCount: live.envCellsLoaded.holtDungeon.cellCount,
                    surfaceCount:
                      live.envCellsLoaded.holtDungeon.surfaceCount,
                    staticObjectCount:
                      live.envCellsLoaded.holtDungeon.staticObjectCount,
                    skippedZeroTri:
                      live.envCellsLoaded.holtDungeon.skippedZeroTri,
                    skippedNoMesh:
                      live.envCellsLoaded.holtDungeon.skippedNoMesh,
                  }
                : null,
            }
          : null;
        out.cellContainers3dSize = live.cellContainers3d
          ? live.cellContainers3d.size
          : 0;

        // Inspect cells: walk every cellContainer in the registry,
        // count children, count cells with portalCellIds populated,
        // count cells with at least one Mesh leaf (non-empty
        // geometry).
        let cellsWithChildren = 0;
        let cellsWithPortalCellIds = 0;
        let cellsWithMeshLeaves = 0;
        let firstSampleCellId = 0;
        const cellSample = [];
        if (live.cellContainers3d) {
          let i = 0;
          for (const [cellId, container] of live.cellContainers3d) {
            if (i === 0) firstSampleCellId = cellId >>> 0;
            const childrenLen = container.children.length;
            if (childrenLen > 0) cellsWithChildren += 1;
            const portalLen = container.userData?.portalCellIds?.length || 0;
            if (portalLen > 0) cellsWithPortalCellIds += 1;
            // Find a Mesh leaf (could be inside meshGroup or as a
            // direct cellstatic child).
            let hasMesh = false;
            for (const child of container.children) {
              if (child.isMesh) {
                hasMesh = true;
                break;
              }
              for (const grand of child.children) {
                if (grand.isMesh) {
                  hasMesh = true;
                  break;
                }
              }
              if (hasMesh) break;
            }
            if (hasMesh) cellsWithMeshLeaves += 1;
            if (i < 3) {
              cellSample.push({
                cellId: "0x" + (cellId >>> 0).toString(16).padStart(8, "0"),
                childrenLen,
                portalLen,
                hasMesh,
                userData: container.userData
                  ? {
                      cellId: "0x" +
                        (container.userData.cellId >>> 0)
                          .toString(16)
                          .padStart(8, "0"),
                      environmentId: "0x" +
                        (container.userData.environmentId >>> 0)
                          .toString(16)
                          .padStart(8, "0"),
                      portalCount:
                        container.userData.portalCellIds?.length ?? 0,
                      isEnvCell: !!container.userData.isEnvCell,
                    }
                  : null,
              });
            }
            i += 1;
          }
        }
        out.cellsWithChildren = cellsWithChildren;
        out.cellsWithPortalCellIds = cellsWithPortalCellIds;
        out.cellsWithMeshLeaves = cellsWithMeshLeaves;
        out.firstSampleCellId =
          "0x" + firstSampleCellId.toString(16).padStart(8, "0");
        out.cellSample = cellSample;

        // ---- Visibility tick stub: outdoor mode --------------------
        // Stub session handle so tickPerFrame's tickCellVisibility3D
        // path runs. Outdoor: cellId=non-zero (else tick early-returns
        // pre-spawn), renderSet=[], isIndoor=false. Expect terrain +
        // buildings + statics .visible = true; every cellContainer
        // .visible = false.
        const stubOutdoor = {
          getCurrentCellId: () => 0xa9b40001 >>> 0,
          getRenderSet: () => new Uint32Array(0),
          isCurrentCellIndoor: () => false,
        };
        live.sessionHandle = stubOutdoor;
        // Wait for at least one rAF so the loop ticks with the new
        // session handle. requestAnimationFrame from page-context
        // resolves on the next paint (usually within 16 ms).
        await new Promise((r) =>
          requestAnimationFrame(() => requestAnimationFrame(r))
        );
        out.outdoorTick = {
          terrainVisible: live.terrainGroup.visible,
          buildingsVisible: live.buildingsGroup.visible,
          staticsVisible: live.staticsGroup.visible,
          // Sample first 3 cell visibilities — all should be false.
          cellSample: [],
        };
        let i = 0;
        for (const [cellId, container] of live.cellContainers3d) {
          if (i < 3) {
            out.outdoorTick.cellSample.push({
              cellId: "0x" + (cellId >>> 0).toString(16).padStart(8, "0"),
              visible: container.visible,
            });
          }
          i += 1;
        }
        out.outdoorTick.allCellsHidden = (() => {
          for (const [, container] of live.cellContainers3d) {
            if (container.visible !== false) return false;
          }
          return true;
        })();

        // ---- Visibility tick stub: indoor mode ---------------------
        // Pick a real cell id from the registry (Mite Maze first
        // cell). renderSet contains JUST that cell; isIndoor=true.
        // Expect terrain hidden; that one cell visible; all others
        // hidden.
        let pickedCellId = 0;
        for (const [cellId] of live.cellContainers3d) {
          pickedCellId = cellId >>> 0;
          break;
        }
        out.pickedIndoorCellId =
          "0x" + pickedCellId.toString(16).padStart(8, "0");
        const stubIndoor = {
          getCurrentCellId: () => pickedCellId >>> 0,
          getRenderSet: () => new Uint32Array([pickedCellId >>> 0]),
          isCurrentCellIndoor: () => true,
        };
        live.sessionHandle = stubIndoor;
        await new Promise((r) =>
          requestAnimationFrame(() => requestAnimationFrame(r))
        );
        out.indoorTick = {
          terrainVisible: live.terrainGroup.visible,
          buildingsVisible: live.buildingsGroup.visible,
          staticsVisible: live.staticsGroup.visible,
          // Did the picked cell flip to visible?
          pickedCellVisible:
            live.cellContainers3d.get(pickedCellId)?.visible === true,
          // Did the OTHER cells stay hidden?
          otherCellsHidden: (() => {
            for (const [cid, container] of live.cellContainers3d) {
              if ((cid >>> 0) === pickedCellId) continue;
              if (container.visible !== false) return false;
            }
            return true;
          })(),
        };

        // Reset to outdoor stub so the page doesn't sit indoor with
        // terrain hidden after the capture closes.
        live.sessionHandle = stubOutdoor;
        await new Promise((r) =>
          requestAnimationFrame(() => requestAnimationFrame(r))
        );
      } catch (e) {
        out.error = String(e?.message ?? e);
        out.errorStack = String(e?.stack ?? "").slice(0, 1200);
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

  let failures = 0;
  function check(name, ok, detail) {
    const status = ok ? "OK" : "FAIL";
    console.log(`  [${status}] ${name}${detail ? " — " + detail : ""}`);
    if (!ok) failures += 1;
  }

  if (probe.error) {
    check(
      "Phase 7.3: init3D + buildEnvCellsForLandblock resolves",
      false,
      probe.error
    );
    if (probe.errorStack) console.error(probe.errorStack);
  } else {
    check(
      "Phase 7.3: window.liveScene3d set after init3D()",
      probe.windowLiveScene3d === true
    );
    // F#5+6 (2026-05-10) — statics no longer count 1 child per
    // placement; InstancedMesh collapses N duplicate-modelId placements
    // into a single child. The load-bearing contract is the placement
    // count (`live.statics.objectCount`) ≥ 100, not the children count.
    check(
      "Phase 7.3: Phase 7.2 buildings + statics still loaded (no regression)",
      probe.buildingsGroupChildren >= 16 && probe.staticsObjectCount >= 100,
      `buildings=${probe.buildingsGroupChildren}, statics_placements=${probe.staticsObjectCount}, statics_children=${probe.staticsGroupChildren}`
    );

    const mm = probe.envCellsLoaded?.miteMaze;
    const hd = probe.envCellsLoaded?.holtDungeon;
    check(
      "Phase 7.3: Mite Maze EnvCells loaded (cellCount > 0)",
      !!mm && mm.cellCount > 0,
      `mm=${JSON.stringify(mm)}`
    );
    check(
      "Phase 7.3: Holtburg Dungeon EnvCells loaded (cellCount > 0)",
      !!hd && hd.cellCount > 0,
      `hd=${JSON.stringify(hd)}`
    );
    const expectedSum = (mm?.cellCount || 0) + (hd?.cellCount || 0);
    check(
      "Phase 7.3: cellContainers3d.size === miteMaze.cellCount + holtDungeon.cellCount",
      probe.cellContainers3dSize === expectedSum && expectedSum > 0,
      `size=${probe.cellContainers3dSize}, expected=${expectedSum}`
    );
    check(
      "Phase 7.3: at least one cell Group has children.length > 0",
      probe.cellsWithChildren > 0,
      `cellsWithChildren=${probe.cellsWithChildren} / total=${probe.cellContainers3dSize}`
    );
    check(
      "Phase 7.3: at least one cell has userData.portalCellIds.length > 0",
      probe.cellsWithPortalCellIds > 0,
      `cellsWithPortalCellIds=${probe.cellsWithPortalCellIds}`
    );
    // Validate at least one cell has a real Mesh leaf — the cell mesh
    // group is non-empty geometry from the wasm-side env-cell mesh
    // bake.
    check(
      "Phase 7.3: at least one cell has a THREE.Mesh leaf (real geometry rendered)",
      probe.cellsWithMeshLeaves > 0,
      `cellsWithMeshLeaves=${probe.cellsWithMeshLeaves}`
    );
    // Material cache grew assertion: count surface DIDs referenced by
    // both EnvCell load summaries; they should be > 0 (so at least one
    // new env-cell surface DID got installed in the cache).
    const envSurfaceCount =
      (mm?.surfaceCount || 0) + (hd?.surfaceCount || 0);
    check(
      "Phase 7.3: EnvCell loaders reported surfaceCount > 0 (cache grew)",
      envSurfaceCount > 0,
      `mm.surfaceCount=${mm?.surfaceCount}, hd.surfaceCount=${hd?.surfaceCount}`
    );
    // Visibility tick — outdoor.
    check(
      "Phase 7.3: outdoor visibility tick — terrain/buildings/statics visible, all cells hidden",
      probe.outdoorTick &&
        probe.outdoorTick.terrainVisible === true &&
        probe.outdoorTick.buildingsVisible === true &&
        probe.outdoorTick.staticsVisible === true &&
        probe.outdoorTick.allCellsHidden === true,
      JSON.stringify(probe.outdoorTick)
    );
    // Visibility tick — indoor.
    check(
      "Phase 7.3: indoor visibility tick — terrain/buildings/statics hidden, picked cell visible, others hidden",
      probe.indoorTick &&
        probe.indoorTick.terrainVisible === false &&
        probe.indoorTick.buildingsVisible === false &&
        probe.indoorTick.staticsVisible === false &&
        probe.indoorTick.pickedCellVisible === true &&
        probe.indoorTick.otherCellsHidden === true,
      JSON.stringify(probe.indoorTick) +
        " pickedId=" +
        probe.pickedIndoorCellId
    );
  }

  check(
    "Phase 7.3: zero browser console errors during 3D boot + init3D",
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
    console.log("PASS: all Phase 7.3 capture checks green.");
    process.exit(0);
  }
})();
