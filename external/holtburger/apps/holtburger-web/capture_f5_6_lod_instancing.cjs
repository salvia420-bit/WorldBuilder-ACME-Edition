// F#5+6 capture — verifies the LOD + InstancedMesh perf optimizations
// landed in scene3d/statics.js (and the supporting Rust didDegrade
// wasm exports). The pre-fix Holtburg view recorded:
//
//   PRE-FIX baseline (2026-05-10, immediately before this commit):
//     holtCalls = 160
//     holtTriangles = 4162
//     terrainLbCount = 9
//     buildingsChildCount = 16
//     envCellCount = 1308
//     sceneMeshTotal = 5254
//     visibleMeshes (cell BFS not run) = 333
//
// The capture re-runs the same Holtburg-camera probe as
// `capture_phase7_7_frustum.cjs` and compares the post-fix `holtCalls`
// against this baseline. **Any reduction is a win** (the task is a
// perf optimization, not a hard contract); the script reports the
// percentage so the human reading the output sees the magnitude.
//
// **Expected Holtburg outcome (per F#1 agent's grounded inspection):**
//   - Statics: 222 placements / 66 unique modelIds → InstancedMesh
//     collapses ~222 draw calls to ~66 unique-model groups.
//   - Buildings: 14 unique / 16 placements → only 2 duplicates;
//     InstancedMesh for buildings is a no-op per the buildings.js
//     header (per-placement door-rotation state precludes simple
//     instancing). 0 reduction expected here.
//   - LOD: dependent on `did_degrade` chain presence in Holtburg
//     models. Most are simple props/buildings with no degrade
//     variant; the capture reports the count for honest measurement.
//
// Failure modes that the script catches:
//   - InstancedMesh not wired (statics still emit one Mesh per
//     placement): `staticsGroupChildren` will be ~222, not ~66.
//   - LOD wrapping breaks geometry: `holtCalls` could go UP, not down
//     (the assertion catches a regression).
//   - Wasm `didDegrade` field missing or always 0 when it shouldn't be:
//     `lodCount` will be 0; not a failure but reported.
//
// Pre-reqs:
//   - Live HTTP server: PAGE_URL defaults to
//     http://100.116.47.66:8765/apps/holtburger-web/index.html?renderer=3d
//   - Manifest+shards baked under dist/.
//   - Playwright in NODE_PATH or PLAYWRIGHT_CACHE env.
//
// Run from `apps/holtburger-web/`:
//   NODE_PATH=/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules \
//   node capture_f5_6_lod_instancing.cjs

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

// PRE-FIX baseline recorded against capture_phase7_7_frustum.cjs at
// the start of this commit (2026-05-10). Each post-fix run compares
// against these numbers and asserts `< baseline` for the calls count.
const BASELINE = {
  holtCalls: 160,
  holtTriangles: 4162,
  terrainLbCount: 9,
  buildingsChildCount: 16,
  visibleMeshes: 333,
};

(async () => {
  const PAGE_URL =
    process.env.F56_PAGE_URL ||
    "http://100.116.47.66:8765/apps/holtburger-web/index.html?renderer=3d";
  const SMOKE_TIMEOUT_MS = Number(process.env.F56_SMOKE_TIMEOUT_MS || 60_000);
  const BUILD_TIMEOUT_MS = Number(process.env.F56_BUILD_TIMEOUT_MS || 180_000);

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
    const text = msg.text();
    if (msg.type() === "error") {
      consoleErrors += 1;
      console.log(`[browser error] ${text}`);
      if (consoleErrorMessages.length < 10) consoleErrorMessages.push(text);
    } else if (msg.type() === "log") {
      if (/\[phase7\.2|F#5|F#6|instanced|LOD/i.test(text)) {
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
    sceneMeshTotal: 0,
    visibleMeshes: 0,
    holtCalls: 0,
    holtTriangles: 0,
    terrainLbCount: 0,
    buildingsChildCount: 0,
    staticsGroupChildren: 0,
    envCellCount: 0,
    instancedGroupCount: 0,
    singletonCount: 0,
    lodCount: 0,
    drawCallReductionEstimate: 0,
    buildingDidDegradeCount: 0,
    buildingDuplicateModelCount: 0,
    countInstancedMeshes: 0,
    countLODNodes: 0,
    reductionPctVsBaseline: 0,
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

    console.log("--- standalone init3D + F#5+6 LOD/Instancing probe ---");
    const probe = await page.evaluate(async (BUILD_TIMEOUT) => {
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
        out.steps.push(`wasm loaded`);

        const scene3d = await import("./scene3d/index.js");
        out.steps.push(`scene3d: init3D=${typeof scene3d.init3D}`);

        // F#5 — verify the new wasm export is present.
        out.fetchModelDidDegradesType = typeof wasmMod.fetchModelDidDegrades;
        out.steps.push(
          `fetchModelDidDegrades: ${out.fetchModelDidDegradesType}`
        );

        // Mock session — same as Phase 7.7.
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
          fetchEnvCellsInLandblock: wasmMod.fetchEnvCellsInLandblock,
          fetchEntityAnimationKeyframes: wasmMod.fetchEntityAnimationKeyframes,
          fetchEntityModelRender: wasmMod.fetchEntityModelRender,
          fetchEntitySurfacesPixels: wasmMod.fetchEntitySurfacesPixels,
          fetchModelDidDegrades: wasmMod.fetchModelDidDegrades,
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

        // Snapshot scene shape so the human reading the result can
        // compare against the pre-fix baseline.
        out.terrainLbCount = live.terrainGroup?.children?.length ?? 0;
        out.buildingsChildCount = live.buildingsGroup?.children?.length ?? 0;
        out.staticsGroupChildren = live.staticsGroup?.children?.length ?? 0;
        out.envCellCount = live.cellContainers3d?.size ?? 0;
        out.instancedGroupCount = live.statics?.instancedGroupCount ?? 0;
        out.singletonCount = live.statics?.singletonCount ?? 0;
        out.lodCount = live.statics?.lodCount ?? 0;
        out.drawCallReductionEstimate =
          live.statics?.drawCallReductionEstimate ?? 0;
        out.staticsObjectCount = live.statics?.objectCount ?? 0;
        out.staticsModelCount = live.statics?.modelCount ?? 0;
        out.buildingDidDegradeCount =
          live.buildings?.buildingDidDegradeCount ?? 0;
        out.buildingDuplicateModelCount =
          live.buildings?.buildingDuplicateModelCount ?? 0;
        out.steps.push(
          `staticsGroup children=${out.staticsGroupChildren} (was ~222 placements pre-fix), ` +
            `instancedGroups=${out.instancedGroupCount}, singletons=${out.singletonCount}, ` +
            `lodCount=${out.lodCount}`
        );

        // Walk the scene and count InstancedMesh + LOD nodes — proves
        // they're really in the graph, not just in the summary
        // counters.
        let countInstancedMeshes = 0;
        let countLODNodes = 0;
        live.scene.traverse((obj) => {
          if (obj.isInstancedMesh) countInstancedMeshes += 1;
          if (obj.isLOD) countLODNodes += 1;
        });
        out.countInstancedMeshes = countInstancedMeshes;
        out.countLODNodes = countLODNodes;
        out.steps.push(
          `scene traversal: InstancedMesh=${countInstancedMeshes}, LOD=${countLODNodes}`
        );

        let meshTotal = 0;
        let visibleMeshes = 0;
        live.scene.traverse((obj) => {
          if (obj.isMesh) {
            meshTotal += 1;
            if (obj.visible) {
              let p = obj.parent;
              let hidden = false;
              while (p) {
                if (!p.visible) {
                  hidden = true;
                  break;
                }
                p = p.parent;
              }
              if (!hidden) visibleMeshes += 1;
            }
          }
        });
        out.sceneMeshTotal = meshTotal;
        out.visibleMeshes = visibleMeshes;
        out.steps.push(`scene mesh total=${meshTotal}, visible=${visibleMeshes}`);

        // Stop the camera switcher's per-tick override so the probe's
        // camera positioning sticks (same as Phase 7.7).
        if (live.cameraSwitcher) {
          live.cameraSwitcher.tick = () => {};
        }
        await new Promise((r) => requestAnimationFrame(r));

        const perspCam = live.camera;
        const renderer = live.renderer;
        if (!perspCam || !renderer || !renderer.info) {
          out.error = "live.camera or live.renderer.info missing";
          return out;
        }

        // AC → three.js worldRoot rotation (matches Phase 7.7).
        function acToThree(ax, ay, az) {
          return [ax, az, -ay];
        }
        const HCX = 0xa9 * 192 + 96;
        const HCY = 0xb4 * 192 + 96;
        const [holtPx, holtPy, holtPz] = acToThree(HCX, HCY, 200);
        const [holtTx, holtTy, holtTz] = acToThree(HCX, HCY, 80);

        // Wait for the loop's render to land with the camera at the
        // Holtburg view position. autoReset=true (renderer default)
        // means `info.render.calls` reflects ONLY the most recent
        // frame, so we get a clean per-frame measurement.
        for (let i = 0; i < 5; i += 1) {
          perspCam.position.set(holtPx, holtPy, holtPz);
          perspCam.lookAt(holtTx, holtTy, holtTz);
          await new Promise((r) => requestAnimationFrame(r));
        }
        out.holtCalls = renderer.info.render.calls;
        out.holtTriangles = renderer.info.render.triangles;
        out.steps.push(
          `Holtburg view three(${holtPx.toFixed(0)},${holtPy.toFixed(0)},${holtPz.toFixed(0)}) → ` +
            `calls=${out.holtCalls}, triangles=${out.holtTriangles}`
        );

        out.initOk = true;
      } catch (e) {
        out.error = String(e?.message ?? e);
        out.errorStack = String(e?.stack ?? "").slice(0, 1200);
      }
      return out;
    }, BUILD_TIMEOUT_MS);

    console.log("probe result:", JSON.stringify(probe, null, 2));
    Object.assign(result, probe);
  } catch (e) {
    console.error("FAIL: capture threw:", e?.message ?? e);
    await browser.close();
    process.exit(1);
  }

  // Compute reduction vs baseline (any reduction is a win; we report
  // negative reduction as a regression).
  if (BASELINE.holtCalls > 0) {
    result.reductionPctVsBaseline = +(
      ((BASELINE.holtCalls - result.holtCalls) / BASELINE.holtCalls) *
      100
    ).toFixed(1);
  }

  console.log("=========================");
  console.log("F#5+6 capture result:", JSON.stringify(result, null, 2));
  console.log("=========================");
  console.log("PRE-FIX baseline:", JSON.stringify(BASELINE, null, 2));
  console.log("=========================");

  let failures = 0;
  function check(name, ok, detail) {
    const status = ok ? "OK" : "FAIL";
    console.log(`  [${status}] ${name}${detail ? " — " + detail : ""}`);
    if (!ok) failures += 1;
  }

  check(
    "F#5+6: init3D resolved with new wasm exports",
    result.initOk,
    result.error ? `error=${result.error}` : ""
  );
  check(
    "F#5+6: fetchModelDidDegrades wasm export wired",
    result.fetchModelDidDegradesType === "function",
    `type=${result.fetchModelDidDegradesType}`
  );
  check(
    "F#5+6: terrain still built (Phase 7.1 regression guard)",
    result.terrainLbCount === BASELINE.terrainLbCount,
    `count=${result.terrainLbCount} (baseline ${BASELINE.terrainLbCount})`
  );
  check(
    "F#5+6: buildings still built (Phase 7.2 regression guard)",
    result.buildingsChildCount === BASELINE.buildingsChildCount,
    `count=${result.buildingsChildCount} (baseline ${BASELINE.buildingsChildCount})`
  );
  check(
    "F#6: at least one InstancedMesh in scene graph (statics path collapsed duplicates)",
    result.countInstancedMeshes >= 1,
    `count=${result.countInstancedMeshes}, ` +
      `instancedGroups=${result.instancedGroupCount}, ` +
      `staticsObjectCount=${result.staticsObjectCount}, ` +
      `staticsModelCount=${result.staticsModelCount}`
  );
  check(
    "F#6: statics InstancedMesh saves >0 draw calls vs per-placement Mesh",
    result.drawCallReductionEstimate > 0,
    `reductionEstimate=${result.drawCallReductionEstimate} ` +
      `(=${result.staticsObjectCount} placements − ` +
      `(${result.instancedGroupCount} instanced + ${result.singletonCount} singletons))`
  );
  check(
    "F#5: LOD count reported (may be 0 if Holtburg models have no degrade chain)",
    typeof result.lodCount === "number",
    `lodCount=${result.lodCount} (0 is honest for Holtburg if no models carry did_degrade); ` +
      `buildingDidDegradeCount=${result.buildingDidDegradeCount}`
  );
  check(
    "F#5+6: Holtburg view produces >0 draw calls (rendering not broken)",
    result.holtCalls > 0,
    `calls=${result.holtCalls}`
  );
  // ANY reduction is a win (the task is a perf optimization, not a
  // hard contract). Mark a regression if calls went UP.
  check(
    "F#5+6: post-fix draw call count is NOT a regression vs pre-fix baseline",
    result.holtCalls <= BASELINE.holtCalls,
    `post=${result.holtCalls}, baseline=${BASELINE.holtCalls}, ` +
      `reductionPct=${result.reductionPctVsBaseline}%`
  );
  // Soft check: if InstancedMesh actually kicked in, draw calls should
  // be strictly less than baseline.
  if (result.countInstancedMeshes > 0) {
    check(
      "F#5+6: with InstancedMesh active, draw calls < baseline (instancing actually helps)",
      result.holtCalls < BASELINE.holtCalls,
      `post=${result.holtCalls}, baseline=${BASELINE.holtCalls}, ` +
        `reductionPct=${result.reductionPctVsBaseline}%`
    );
    if (result.reductionPctVsBaseline < 5) {
      console.log(
        `  [NOTE] reduction is <5% (${result.reductionPctVsBaseline}%) — ` +
          `Holtburg's per-frame visible-mesh set may not see the full ` +
          `instancing win when only a fraction of statics are in-frustum. ` +
          `The static audit (staticsGroupChildren=${result.staticsGroupChildren} ` +
          `vs ~222 pre-fix placements) is the load-bearing proof.`
      );
    }
  }
  check(
    "F#5+6: zero browser console errors",
    consoleErrors === 0,
    `errors=${consoleErrors}` +
      (consoleErrorMessages.length
        ? `\n     first: ${JSON.stringify(consoleErrorMessages.slice(0, 3))}`
        : "")
  );

  await browser.close();

  if (failures > 0) {
    console.log(`FAIL: ${failures} check(s) failed.`);
    process.exit(1);
  } else {
    console.log("PASS: all F#5+6 capture checks green.");
    process.exit(0);
  }
})().catch((err) => {
  console.error("capture failed:", err);
  process.exit(1);
});
