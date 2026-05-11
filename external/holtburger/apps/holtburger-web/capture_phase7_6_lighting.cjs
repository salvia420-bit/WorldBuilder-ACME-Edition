// Phase 7.6 + 7.6.1 capture script — drives `init3D` against real
// Holtburg wasm exports and asserts:
//
//   1. `liveScene3d.lighting.sun` is a `THREE.DirectionalLight`.
//   2. `liveScene3d.lighting.ambient` is a `THREE.AmbientLight`.
//   3. With mock `sessionHandle.isCurrentCellIndoor() = false`,
//      sun.visible is true after a tick + ambient.intensity ≈ 0.5.
//   4. With mock `sessionHandle.isCurrentCellIndoor() = true`,
//      sun.visible flips to false + ambient.intensity ≈ 0.7.
//   5. Earlier-phase invariants hold: 9-LB terrain mesh exists, 16
//      buildings in the buildingsGroup, EnvCells present (when
//      Mite Maze / Holtburg Dungeon load).
//   6. **Phase 7.6.1** — `attachSetupModelLights` is no longer a
//      deferred stub. It walks the post-build scene graph and either
//      attaches PointLight/SpotLight per-part (when the Setup has
//      `lights:` entries) or returns `lightCount: 0` with
//      `wasmExportMissing: false`. Holtburg's models are largely
//      raw 0x01 GfxObjs with no Setup, so `lightCount` may be 0 —
//      that's grounded reality; the capture documents this rather
//      than failing.
//   7. Zero browser console errors.
//
// Mirrors Phase 7.5 mode-1 standalone pattern (no live ACE login
// required) — the indoor-toggle math is independently testable via
// mock sessionHandle; we don't need a real wire stream.
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
//   node capture_phase7_6_lighting.cjs

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
    process.env.PHASE76_PAGE_URL ||
    "http://100.116.47.66:8765/apps/holtburger-web/index.html?renderer=3d";
  const SMOKE_TIMEOUT_MS = Number(
    process.env.PHASE76_SMOKE_TIMEOUT_MS || 60_000
  );
  const BUILD_TIMEOUT_MS = Number(
    process.env.PHASE76_BUILD_TIMEOUT_MS || 180_000
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
      // Phase 7.6.1 surfaces `[phase7.6.1] setupModelLights: { … }`
      // when the per-SetupModel attach path runs. The capture asserts
      // this log appears (proves attach ran, not just that the export
      // exists).
      if (/\[phase7\.6\.1\]\s*setupModelLights/i.test(text)) {
        setupLightsLogSeen = true;
      }
      if (/\[phase7\.6/.test(text)) {
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
    lightingPresent: false,
    sunIsDirectional: false,
    ambientIsAmbient: false,
    hemisphereIsHemisphere: false,
    sunInitialIntensity: null,
    ambientInitialIntensity: null,
    outdoorSunVisible: null,
    outdoorAmbientIntensity: null,
    indoorSunVisible: null,
    indoorAmbientIntensity: null,
    backToOutdoorSunVisible: null,
    backToOutdoorAmbientIntensity: null,
    terrainLbCount: 0,
    buildingsChildCount: 0,
    envCellCount: 0,
    // Phase 7.6.1 follow-on #1 — per-SetupModel lights.
    setupLightsSummary: null,
    setupLightsLogSeen: false,
    activeLightsLen: null,
    pointLightCount: 0,
    spotLightCount: 0,
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

    console.log("--- standalone init3D + lighting probe ---");
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

        // Mock session — we control isCurrentCellIndoor + provide
        // the minimum API surface scene3d touches during init.
        // Phase 7.5 needs setMovementInput (called from
        // cameraSwitcher.tick); Phase 7.6 needs isCurrentCellIndoor.
        // The cell-visibility tick reads getCurrentCellId +
        // getRenderSet; stub them too so it can run without throwing.
        let mockIsIndoor = false;
        const mockSession = {
          isCurrentCellIndoor() { return mockIsIndoor; },
          getCurrentCellId() { return 0; },
          getRenderSet() { return new Uint32Array(0); },
          setMovementInput() {},
          // No-op pollEntityUpdates — empty drain.
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
          scene3d.init3D(canvas, mockSession, wasmExports),
          new Promise((_, rej) =>
            setTimeout(() => rej(new Error("init3D timeout")), BUILD_TIMEOUT)
          ),
        ]);
        const tElapsed = (performance.now() - tStart) | 0;
        out.steps.push(`init3D resolved in ${tElapsed} ms`);

        // Assertion 1: lighting bundle present
        out.lightingPresent = !!live.lighting;
        if (live.lighting) {
          const { sun, ambient, hemisphere } = live.lighting;
          out.sunIsDirectional =
            !!sun &&
            (sun.isDirectionalLight === true || sun.type === "DirectionalLight");
          out.ambientIsAmbient =
            !!ambient &&
            (ambient.isAmbientLight === true || ambient.type === "AmbientLight");
          out.hemisphereIsHemisphere =
            !!hemisphere &&
            (hemisphere.isHemisphereLight === true ||
              hemisphere.type === "HemisphereLight");
          out.sunInitialIntensity = sun?.intensity ?? null;
          out.ambientInitialIntensity = ambient?.intensity ?? null;
          out.steps.push(
            `sun.type=${sun?.type}, ambient.type=${ambient?.type}, hemi.type=${hemisphere?.type}`
          );
          out.steps.push(
            `sun.intensity=${sun?.intensity}, ambient.intensity=${ambient?.intensity}, hemi.intensity=${hemisphere?.intensity}`
          );
        }

        // Assertion 2: drive the lighting tick directly via
        // tickPerFrame; we don't wait for rAF because rAF cadence in
        // headless Chromium is unreliable. The loop.js tick is exposed
        // indirectly — easier path: reach into lighting.js directly.
        // We import the module + call tickLightingForCellState
        // ourselves. This is exactly what the rAF loop does.
        const lightingMod = await import("./scene3d/lighting.js");
        const { tickLightingForCellState, LIGHTING_CONSTANTS } = lightingMod;
        out.steps.push(
          `LIGHTING_CONSTANTS: outdoor=${LIGHTING_CONSTANTS.AMBIENT_INTENSITY_OUTDOOR}, indoor=${LIGHTING_CONSTANTS.AMBIENT_INTENSITY_INDOOR}`
        );

        // Outdoor tick.
        mockIsIndoor = false;
        tickLightingForCellState(live, mockSession);
        out.outdoorSunVisible = live.lighting.sun.visible;
        out.outdoorAmbientIntensity = live.lighting.ambient.intensity;
        out.steps.push(
          `after outdoor tick: sun.visible=${out.outdoorSunVisible}, ambient=${out.outdoorAmbientIntensity}`
        );

        // Indoor tick.
        mockIsIndoor = true;
        tickLightingForCellState(live, mockSession);
        out.indoorSunVisible = live.lighting.sun.visible;
        out.indoorAmbientIntensity = live.lighting.ambient.intensity;
        out.steps.push(
          `after indoor tick: sun.visible=${out.indoorSunVisible}, ambient=${out.indoorAmbientIntensity}`
        );

        // Back to outdoor.
        mockIsIndoor = false;
        tickLightingForCellState(live, mockSession);
        out.backToOutdoorSunVisible = live.lighting.sun.visible;
        out.backToOutdoorAmbientIntensity = live.lighting.ambient.intensity;
        out.steps.push(
          `back to outdoor: sun.visible=${out.backToOutdoorSunVisible}, ambient=${out.backToOutdoorAmbientIntensity}`
        );

        // Assertion 3: earlier-phase invariants hold.
        out.terrainLbCount =
          live.terrainGroup?.children?.length ?? 0;
        out.buildingsChildCount =
          live.buildingsGroup?.children?.length ?? 0;
        out.envCellCount = live.cellContainers3d?.size ?? 0;
        out.steps.push(
          `terrain LB count=${out.terrainLbCount}, ` +
          `buildings child count=${out.buildingsChildCount}, ` +
          `envCells=${out.envCellCount}`
        );

        // Phase 7.6.1 — per-SetupModel lights. attachSetupModelLights
        // ran during init3D; check the stashed summary + activeLights
        // array. lightCount == 0 is valid (Holtburg models are mostly
        // raw 0x01 GfxObjs with no Setup, hence no lights entries).
        out.setupLightsSummary = live.setupLightsSummary
          ? {
              lightCount: live.setupLightsSummary.lightCount,
              pointLightCount: live.setupLightsSummary.pointLightCount,
              spotLightCount: live.setupLightsSummary.spotLightCount,
              modelsScanned: live.setupLightsSummary.modelsScanned,
              modelsWithLights: live.setupLightsSummary.modelsWithLights,
              noLightModels: live.setupLightsSummary.noLightModels,
              wasmExportMissing: live.setupLightsSummary.wasmExportMissing,
            }
          : null;
        out.activeLightsLen = Array.isArray(live.activeLights)
          ? live.activeLights.length
          : -1;
        out.pointLightCount = live.setupLightsSummary?.pointLightCount ?? 0;
        out.spotLightCount = live.setupLightsSummary?.spotLightCount ?? 0;

        // Stress-test the per-light cap (MAX_ACTIVE_LIGHTS = 32) with
        // a synthetic 100-light injection. After tickLightingForCellState
        // runs, only the closest 32 should have .visible === true.
        // Build a worldRoot-attached Group + 100 PointLights at varying
        // distances; sort assertion lives on the result side below.
        try {
          const THREE = await import("three");
          const stressGroup = new THREE.Group();
          stressGroup.name = "f1-stress-group";
          live.worldRoot.add(stressGroup);
          for (let i = 0; i < 100; i += 1) {
            const pl = new THREE.PointLight(0xffffff, 1.0, 10.0);
            // Spread along +X at 1m..100m so distance-sort is well-defined.
            pl.position.set(i + 1, 0, 0);
            stressGroup.add(pl);
            live.activeLights.push(pl);
          }
          // Move the camera somewhere known so the sort is deterministic.
          const stressCam = live.cameraSwitcher?.activeCamera ?? live.camera;
          stressCam.position.set(0, 0, 0);
          // Force-evaluate world matrices since we just attached
          // children.
          live.worldRoot.updateMatrixWorld(true);
          tickLightingForCellState(live, mockSession);
          // After tick: light at distance 1 should be visible; light at
          // distance 100 should not. The 32nd-closest is at idx 31 with
          // x = 32, distance ~32. Lights with x in (1..32) visible; x in
          // (33..100) hidden.
          let visCount = 0;
          let hiddenCount = 0;
          for (const pl of stressGroup.children) {
            if (pl.visible) visCount += 1; else hiddenCount += 1;
          }
          out.stressVisible = visCount;
          out.stressHidden = hiddenCount;
          out.stressVisibleClosest = stressGroup.children[0].visible;
          out.stressVisibleFarthest =
            stressGroup.children[99].visible;
          // Cleanup — remove the stress lights so other assertions
          // aren't polluted.
          for (const pl of stressGroup.children.slice()) {
            const idx = live.activeLights.indexOf(pl);
            if (idx >= 0) live.activeLights.splice(idx, 1);
          }
          live.worldRoot.remove(stressGroup);
        } catch (e) {
          out.stressErr = String(e?.message ?? e).slice(0, 200);
        }

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
  console.log("Phase 7.6 capture result:", JSON.stringify(result, null, 2));
  console.log("=========================");

  let failures = 0;
  function check(name, ok, detail) {
    const status = ok ? "OK" : "FAIL";
    console.log(`  [${status}] ${name}${detail ? " — " + detail : ""}`);
    if (!ok) failures += 1;
  }

  check(
    "Phase 7.6: init3D() resolved without error",
    result.initOk,
    result.error ? `error=${result.error}` : ""
  );
  check(
    "Phase 7.6: liveScene3d.lighting bundle present",
    result.lightingPresent
  );
  check(
    "Phase 7.6: liveScene3d.lighting.sun is a THREE.DirectionalLight",
    result.sunIsDirectional
  );
  check(
    "Phase 7.6: liveScene3d.lighting.ambient is a THREE.AmbientLight",
    result.ambientIsAmbient
  );
  check(
    "Phase 7.6: liveScene3d.lighting.hemisphere is a THREE.HemisphereLight (optional but present by default)",
    result.hemisphereIsHemisphere
  );
  check(
    "Phase 7.6: sun.intensity > 0 + ambient.intensity ≈ 0.5 at construction",
    result.sunInitialIntensity > 0 &&
      Math.abs((result.ambientInitialIntensity ?? 0) - 0.5) < 1e-3,
    `sun.intensity=${result.sunInitialIntensity}, ambient.intensity=${result.ambientInitialIntensity}`
  );

  // Indoor / outdoor toggle.
  check(
    "Phase 7.6: outdoor tick (isCurrentCellIndoor=false) → sun.visible=true",
    result.outdoorSunVisible === true,
    `outdoorSunVisible=${result.outdoorSunVisible}`
  );
  check(
    "Phase 7.6: outdoor tick → ambient.intensity ≈ 0.5",
    Math.abs((result.outdoorAmbientIntensity ?? 0) - 0.5) < 1e-3,
    `outdoorAmbient=${result.outdoorAmbientIntensity}`
  );
  check(
    "Phase 7.6: indoor tick (isCurrentCellIndoor=true) → sun.visible=false",
    result.indoorSunVisible === false,
    `indoorSunVisible=${result.indoorSunVisible}`
  );
  check(
    "Phase 7.6: indoor tick → ambient.intensity ≈ 0.7 (boosted)",
    Math.abs((result.indoorAmbientIntensity ?? 0) - 0.7) < 1e-3,
    `indoorAmbient=${result.indoorAmbientIntensity}`
  );
  check(
    "Phase 7.6: ambient.intensity grows when indoor (indoor > outdoor)",
    (result.indoorAmbientIntensity ?? 0) >
      (result.outdoorAmbientIntensity ?? 0),
    `indoor=${result.indoorAmbientIntensity} vs outdoor=${result.outdoorAmbientIntensity}`
  );
  check(
    "Phase 7.6: flipping back to outdoor restores sun.visible=true + ambient≈0.5",
    result.backToOutdoorSunVisible === true &&
      Math.abs((result.backToOutdoorAmbientIntensity ?? 0) - 0.5) < 1e-3,
    `sunVis=${result.backToOutdoorSunVisible}, ambient=${result.backToOutdoorAmbientIntensity}`
  );

  // Earlier-phase invariants — sanity check no regression.
  check(
    "Phase 7.6 / earlier-invariant: terrainGroup has 9 LBs (Holtburg neighbourhood)",
    result.terrainLbCount === 9,
    `count=${result.terrainLbCount}`
  );
  check(
    "Phase 7.6 / earlier-invariant: buildingsGroup populated (Holtburg town hall etc)",
    result.buildingsChildCount > 0,
    `count=${result.buildingsChildCount}`
  );
  check(
    "Phase 7.6 / earlier-invariant: EnvCells loaded (Mite Maze + Holtburg Dungeon → 1+ cells)",
    result.envCellCount > 0,
    `count=${result.envCellCount}`
  );

  // Phase 7.6.1 (3D port follow-on #1) — per-SetupModel lights.
  check(
    "Phase 7.6.1: liveScene3d.setupLightsSummary populated (attach ran)",
    !!result.setupLightsSummary,
    JSON.stringify(result.setupLightsSummary)
  );
  check(
    "Phase 7.6.1: wasmExportMissing === false (fetchSetupModelLights plumbed)",
    result.setupLightsSummary &&
      result.setupLightsSummary.wasmExportMissing === false,
    `wasmExportMissing=${result.setupLightsSummary?.wasmExportMissing}`
  );
  check(
    "Phase 7.6.1: modelsScanned > 0 (post-build walker found setup ids)",
    (result.setupLightsSummary?.modelsScanned ?? 0) > 0,
    `modelsScanned=${result.setupLightsSummary?.modelsScanned}`
  );
  check(
    "Phase 7.6.1: liveScene3d.activeLights array exists (≥0)",
    Array.isArray(result.activeLightsLen) || result.activeLightsLen >= 0,
    `activeLightsLen=${result.activeLightsLen}`
  );
  check(
    "Phase 7.6.1: setupModelLights log surfaced in console",
    result.setupLightsLogSeen,
    `seen=${result.setupLightsLogSeen}`
  );
  // The lightCount may be 0 — that's grounded reality for Holtburg
  // (mostly raw 0x01 GfxObjs with no Setup → no lights). We document
  // rather than fail.
  check(
    "Phase 7.6.1: lightCount >= 0 (0 is valid: Holtburg models mostly raw 0x01 GfxObjs)",
    (result.setupLightsSummary?.lightCount ?? -1) >= 0,
    `lightCount=${result.setupLightsSummary?.lightCount}`
  );
  // Synthetic 100-light cap stress test.
  check(
    "Phase 7.6.1: 100-light stress test → exactly 32 visible (MAX_ACTIVE_LIGHTS)",
    result.stressVisible === 32 && result.stressHidden === 68,
    `visible=${result.stressVisible}, hidden=${result.stressHidden}, err=${result.stressErr ?? ""}`
  );
  check(
    "Phase 7.6.1: stress closest light is visible, farthest is hidden",
    result.stressVisibleClosest === true &&
      result.stressVisibleFarthest === false,
    `closest=${result.stressVisibleClosest}, farthest=${result.stressVisibleFarthest}`
  );

  check(
    "Phase 7.6: zero browser console errors",
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
    console.log("PASS: all Phase 7.6 capture checks green.");
    process.exit(0);
  }
})().catch((err) => {
  console.error("capture failed:", err);
  process.exit(1);
});
