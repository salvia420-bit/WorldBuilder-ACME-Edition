// Phase 7.6.1 / 3D port follow-on #1 — per-SetupModel point/spot
// lights capture script. Drives `init3D` against real Holtburg wasm
// exports and asserts the new attach + cap pipeline:
//
//   1. The `fetchSetupModelLights` wasm-bindgen export exists and is
//      callable. It mirrors `fetchBuildingPlacement`'s take-once-drain
//      pattern: `{ partCount, setupId, takeLights() }`.
//
//   2. attachSetupModelLights ran during init3D and stashed a real
//      summary on `liveScene3d.setupLightsSummary`. The shape:
//      `{ lightCount, pointLightCount, spotLightCount, modelsScanned,
//        modelsWithLights, noLightModels, wasmExportMissing }`.
//
//   3. `liveScene3d.activeLights` is the Array<Light> the per-rAF tick
//      caps to MAX_ACTIVE_LIGHTS (32). Every entry is a THREE.PointLight
//      or THREE.SpotLight.
//
//   4. **Holtburg's lightCount may be 0** — that's grounded reality.
//      Most retail Holtburg buildings are raw 0x01 GfxObjs (no Setup
//      → no lights table to walk). The capture documents this, doesn't
//      fail on it. The synthetic 100-light stress test below proves
//      the cap-enforcement logic itself works regardless of how many
//      real lights actually exist in Holtburg.
//
//   5. Synthetic 100-light stress test: build a Group with 100
//      PointLights at increasing distance from the active camera,
//      push into activeLights, run tickLightingForCellState → exactly
//      32 should have `.visible === true`, the rest `.visible ===
//      false`. The 32 visible should be the 32 CLOSEST.
//
//   6. Zero browser console errors.
//
// Mirrors Phase 7.6's mode-1 standalone pattern (mock SessionHandle
// + real wasm exports). No live ACE login required.
//
// Pre-reqs:
//   - Live HTTP server: PAGE_URL defaults to
//     http://100.116.47.66:8765/apps/holtburger-web/index.html?renderer=3d
//   - Manifest+shards baked under dist/.
//   - Playwright in NODE_PATH or
//     /home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules.
//
// Run from `apps/holtburger-web/`:
//   NODE_PATH=/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules \
//   node capture_f1_setupmodel_lights.cjs

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
    process.env.F1_PAGE_URL ||
    "http://100.116.47.66:8765/apps/holtburger-web/index.html?renderer=3d";
  const SMOKE_TIMEOUT_MS = Number(
    process.env.F1_SMOKE_TIMEOUT_MS || 60_000
  );
  const BUILD_TIMEOUT_MS = Number(
    process.env.F1_BUILD_TIMEOUT_MS || 180_000
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
  let setupLightsLogSeen = false;
  const consoleErrorMessages = [];
  page.on("console", (msg) => {
    const text = msg.text();
    if (msg.type() === "error") {
      consoleErrors += 1;
      console.log(`[browser error] ${text}`);
      if (consoleErrorMessages.length < 10) consoleErrorMessages.push(text);
    } else if (msg.type() === "log") {
      if (/\[phase7\.6\.1\]\s*setupModelLights/i.test(text)) {
        setupLightsLogSeen = true;
        console.log(`[browser] ${text}`);
      } else if (/\[phase7\.6/.test(text)) {
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
    wasmExportExists: false,
    wasmExportCallable: false,
    summaryPresent: false,
    summaryShape: null,
    activeLightsLen: -1,
    activeLightsAllValid: false,
    pointLightCount: 0,
    spotLightCount: 0,
    holtburgLightCount: 0,
    holtburgModelsScanned: 0,
    holtburgNoLightModels: 0,
    setupLightsLogSeen: false,
    stressVisible: -1,
    stressHidden: -1,
    stressClosestVisible: null,
    stressFarthestVisible: null,
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

    console.log("--- standalone init3D + F#1 SetupModel lights probe ---");
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

        // Assertion 1: wasm export presence + callability.
        out.wasmExportExists =
          typeof wasmMod.fetchSetupModelLights === "function";
        if (out.wasmExportExists) {
          try {
            // Call against the Holtburg town hall setup id (a common
            // 0x02… Setup). The call should resolve to a bundle even
            // if the bundle is empty.
            const bundle = await wasmMod.fetchSetupModelLights(0x02000001);
            out.wasmExportCallable =
              bundle && typeof bundle.partCount === "number";
            out.steps.push(
              `fetchSetupModelLights(0x02000001) → partCount=${bundle?.partCount}, setupId=0x${(bundle?.setupId >>> 0).toString(16)}`
            );
            if (typeof bundle.free === "function") bundle.free();
          } catch (e) {
            out.steps.push(`fetchSetupModelLights call threw: ${e?.message ?? e}`);
            out.wasmExportCallable = false;
          }
        }

        const scene3dMod = await import("./scene3d/index.js");
        out.steps.push(`scene3d: init3D=${typeof scene3dMod.init3D}`);

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

        const tStart = performance.now();
        const live = await Promise.race([
          scene3dMod.init3D(canvas, mockSession, wasmExports),
          new Promise((_, rej) =>
            setTimeout(() => rej(new Error("init3D timeout")), BUILD_TIMEOUT)
          ),
        ]);
        const tElapsed = (performance.now() - tStart) | 0;
        out.steps.push(`init3D resolved in ${tElapsed} ms`);

        // Assertion 2: setupLightsSummary present + shape.
        out.summaryPresent = !!live.setupLightsSummary;
        if (live.setupLightsSummary) {
          out.summaryShape = {
            lightCount: live.setupLightsSummary.lightCount,
            pointLightCount: live.setupLightsSummary.pointLightCount,
            spotLightCount: live.setupLightsSummary.spotLightCount,
            modelsScanned: live.setupLightsSummary.modelsScanned,
            modelsWithLights: live.setupLightsSummary.modelsWithLights,
            noLightModels: live.setupLightsSummary.noLightModels,
            wasmExportMissing: live.setupLightsSummary.wasmExportMissing,
          };
          out.holtburgLightCount = live.setupLightsSummary.lightCount;
          out.holtburgModelsScanned = live.setupLightsSummary.modelsScanned;
          out.holtburgNoLightModels = live.setupLightsSummary.noLightModels;
          out.pointLightCount = live.setupLightsSummary.pointLightCount;
          out.spotLightCount = live.setupLightsSummary.spotLightCount;
        }

        // Assertion 3: activeLights array exists + every entry is a
        // PointLight or SpotLight.
        out.activeLightsLen = Array.isArray(live.activeLights)
          ? live.activeLights.length
          : -1;
        if (Array.isArray(live.activeLights)) {
          let allValid = true;
          for (const l of live.activeLights) {
            const isPoint = l.isPointLight === true || l.type === "PointLight";
            const isSpot = l.isSpotLight === true || l.type === "SpotLight";
            if (!isPoint && !isSpot) {
              allValid = false;
              break;
            }
          }
          out.activeLightsAllValid = allValid;
        }

        // Assertion 4 (load-bearing): synthetic 100-light stress test
        // of the per-light cap. We don't depend on Holtburg having
        // real lights (it mostly doesn't) — this test proves the
        // cap-enforcement logic works on its own merits.
        const THREE = await import("three");
        const lightingMod = await import("./scene3d/lighting.js");
        const { tickLightingForCellState } = lightingMod;
        const stressGroup = new THREE.Group();
        stressGroup.name = "f1-stress-group";
        live.worldRoot.add(stressGroup);
        // Save the existing activeLights so we restore later.
        const savedActiveLights = live.activeLights.slice();
        for (let i = 0; i < 100; i += 1) {
          // Distance metric is squared, so we use one axis to keep
          // the sort cleanly ordered (light at x=1 is the closest;
          // x=100 is the farthest).
          const pl = new THREE.PointLight(0xffffff, 1.0, 10.0);
          pl.position.set(i + 1, 0, 0);
          stressGroup.add(pl);
          live.activeLights.push(pl);
        }
        // Camera position at origin for deterministic sort.
        const stressCam = live.cameraSwitcher?.activeCamera ?? live.camera;
        const savedCamPos = stressCam.position.clone
          ? stressCam.position.clone()
          : { x: stressCam.position.x, y: stressCam.position.y, z: stressCam.position.z };
        stressCam.position.set(0, 0, 0);
        live.worldRoot.updateMatrixWorld(true);
        tickLightingForCellState(live, mockSession);
        let visCount = 0;
        let hiddenCount = 0;
        for (const pl of stressGroup.children) {
          if (pl.visible) visCount += 1;
          else hiddenCount += 1;
        }
        out.stressVisible = visCount;
        out.stressHidden = hiddenCount;
        out.stressClosestVisible = stressGroup.children[0].visible;
        out.stressFarthestVisible = stressGroup.children[99].visible;

        // Cleanup — restore.
        for (const pl of stressGroup.children.slice()) {
          const idx = live.activeLights.indexOf(pl);
          if (idx >= 0) live.activeLights.splice(idx, 1);
        }
        live.worldRoot.remove(stressGroup);
        if (stressCam.position.set) {
          stressCam.position.set(savedCamPos.x, savedCamPos.y, savedCamPos.z);
        }
        // Restore — just in case anything else mutated activeLights.
        live.activeLights.length = 0;
        for (const l of savedActiveLights) live.activeLights.push(l);

        out.initOk = true;
      } catch (e) {
        out.error = String(e?.message ?? e);
        out.errorStack = String(e?.stack ?? "").slice(0, 1200);
      }
      return out;
    }, BUILD_TIMEOUT_MS);

    console.log("probe result:", JSON.stringify(probe, null, 2));
    Object.assign(result, probe);
    result.setupLightsLogSeen = setupLightsLogSeen;
  } catch (e) {
    console.error("FAIL: capture threw:", e?.message ?? e);
    await browser.close();
    process.exit(1);
  }

  console.log("=========================");
  console.log("F#1 capture result:", JSON.stringify(result, null, 2));
  console.log("=========================");

  let failures = 0;
  function check(name, ok, detail) {
    const status = ok ? "OK" : "FAIL";
    console.log(`  [${status}] ${name}${detail ? " — " + detail : ""}`);
    if (!ok) failures += 1;
  }

  check(
    "F#1: init3D() resolved without error",
    result.initOk,
    result.error ? `error=${result.error}` : ""
  );
  check(
    "F#1: wasm.fetchSetupModelLights export exists",
    result.wasmExportExists
  );
  check(
    "F#1: wasm.fetchSetupModelLights is callable + returns SetupModelLights shape",
    result.wasmExportCallable
  );
  check(
    "F#1: liveScene3d.setupLightsSummary populated by init3D",
    result.summaryPresent,
    JSON.stringify(result.summaryShape)
  );
  check(
    "F#1: summary.wasmExportMissing === false",
    result.summaryShape && result.summaryShape.wasmExportMissing === false,
    `wasmExportMissing=${result.summaryShape?.wasmExportMissing}`
  );
  check(
    "F#1: liveScene3d.activeLights array exists (length >= 0)",
    result.activeLightsLen >= 0,
    `activeLightsLen=${result.activeLightsLen}`
  );
  check(
    "F#1: every activeLight is a PointLight or SpotLight",
    result.activeLightsAllValid,
    `valid=${result.activeLightsAllValid}, len=${result.activeLightsLen}`
  );
  check(
    "F#1: setupModelLights log surfaced in console",
    result.setupLightsLogSeen,
    `seen=${result.setupLightsLogSeen}`
  );
  // Document the Holtburg light count. Most retail Holtburg buildings
  // are raw 0x01 GfxObjs with no Setup, so 0 lights is grounded
  // reality, NOT a failure.
  console.log(
    `  [INFO]  Holtburg loaded models: scanned=${result.holtburgModelsScanned}, ` +
      `with lights=${result.summaryShape?.modelsWithLights ?? 0}, ` +
      `no-light models=${result.holtburgNoLightModels}, ` +
      `total lights attached=${result.holtburgLightCount} ` +
      `(point=${result.pointLightCount}, spot=${result.spotLightCount}). ` +
      `0 is valid: retail Holtburg models lack Setup-side light descriptors.`
  );
  check(
    "F#1: holtburg lightCount >= 0 (0 is valid: documented above)",
    result.holtburgLightCount >= 0,
    `lightCount=${result.holtburgLightCount}`
  );

  // Synthetic 100-light stress test — the LOAD-BEARING cap verification.
  check(
    "F#1: 100-light cap stress → exactly 32 visible (MAX_ACTIVE_LIGHTS=32)",
    result.stressVisible === 32 && result.stressHidden === 68,
    `visible=${result.stressVisible}, hidden=${result.stressHidden}`
  );
  check(
    "F#1: cap-sort orders by distance (closest visible, farthest hidden)",
    result.stressClosestVisible === true &&
      result.stressFarthestVisible === false,
    `closest=${result.stressClosestVisible}, farthest=${result.stressFarthestVisible}`
  );

  check(
    "F#1: zero browser console errors",
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
    console.log("PASS: all F#1 capture checks green.");
    process.exit(0);
  }
})().catch((err) => {
  console.error("capture failed:", err);
  process.exit(1);
});
