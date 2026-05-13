// Visual-fidelity Phase 0.1 capture — drives index.html with
// `?shadows=on` and `?shadows=off`, takes a single screenshot of
// each, saves under /mnt/wbterminal1/tmp/claude-scratch/visual-
// fidelity/wave1-p01/.
//
// Intended runs from a local dev server overlay; the live-ACE box
// at 100.116.47.66 doesn't have these changes until PK syncs the
// worktree (we don't push).
//
// Run from `apps/holtburger-web/`:
//   PHASE01_PAGE_BASE=http://127.0.0.1:8090/apps/holtburger-web/index.html \
//   PHASE01_OUT_DIR=/mnt/wbterminal1/tmp/claude-scratch/visual-fidelity/wave1-p01 \
//   NODE_PATH=/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules \
//   node capture_visfid_p01_shadows.cjs

const path = require("node:path");
const fs = require("node:fs");

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
        PLAYWRIGHT_CACHE
    );
    process.exit(2);
  }
}

const PAGE_BASE =
  process.env.PHASE01_PAGE_BASE ||
  "http://127.0.0.1:8090/apps/holtburger-web/index.html";
const OUT_DIR =
  process.env.PHASE01_OUT_DIR ||
  "/mnt/wbterminal1/tmp/claude-scratch/visual-fidelity/wave1-p01";
const SMOKE_TIMEOUT_MS = Number(process.env.PHASE01_SMOKE_TIMEOUT_MS || 90_000);
const BUILD_TIMEOUT_MS = Number(process.env.PHASE01_BUILD_TIMEOUT_MS || 180_000);
const RENDER_WAIT_MS = Number(process.env.PHASE01_RENDER_WAIT_MS || 4_000);

fs.mkdirSync(OUT_DIR, { recursive: true });

async function captureOne(shadowsOn) {
  const tag = shadowsOn ? "on" : "off";
  const fname = `holtburg_noon_shadows_${tag}.png`;
  const fpath = path.join(OUT_DIR, fname);

  // Noon = roughly the middle of AC's 7620s day. `skytime=accel` is
  // already wired (per sky_dome.js); we don't drive a specific time
  // because Phase 0.1 only needs SOMETHING to cast shadows. If you
  // want a controlled noon for visual diff, add `&skyhour=12` after
  // we wire that param (deferred to Phase X.1 preset gating).
  const pageUrl =
    `${PAGE_BASE}?renderer=3d` + (shadowsOn ? "&shadows=on" : "");

  console.log(`[visfid-p01] launching chromium → ${pageUrl}`);

  const browser = await chromium.launch({
    args: ["--use-gl=swiftshader"],
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 1024 },
  });
  const page = await context.newPage();

  let consoleErrors = 0;
  page.on("console", (msg) => {
    const text = msg.text();
    if (msg.type() === "error") {
      consoleErrors += 1;
      if (consoleErrors <= 10) console.log(`[browser error] ${text}`);
    } else if (msg.type() === "warning") {
      // Surface three.js's shadow-related warnings; we expect ZERO
      // if the material-flag check is doing its job.
      if (/shadow|castShadow/i.test(text)) {
        console.log(`[browser warn] ${text}`);
      }
    }
  });
  page.on("pageerror", (err) => {
    consoleErrors += 1;
    console.error("[pageerror]", err.message);
  });

  await page.goto(pageUrl, { waitUntil: "domcontentloaded" });

  // Wait for the in-page smoke panel to flip to PASS — that signals
  // the full bootstrap (wasm + manifest + boot pack) completed.
  try {
    await page.waitForFunction(
      () => {
        const r = document.getElementById("results");
        return r && /PASS/.test(r.innerHTML);
      },
      { timeout: SMOKE_TIMEOUT_MS }
    );
    console.log(`[visfid-p01] [${tag}] smoke panel PASS`);
  } catch (e) {
    const html = await page
      .locator("#results")
      .innerHTML()
      .catch(() => "(no #results)");
    console.error(
      `FAIL [${tag}]: smoke panel never reached PASS within ${SMOKE_TIMEOUT_MS}ms`
    );
    console.error(`results HTML: ${html.slice(0, 500)}`);
    await browser.close();
    return { ok: false, fpath: null, reason: "smoke timeout" };
  }

  // Drive init3D against real wasm exports — same pattern as
  // capture_phase7_6_lighting.cjs but without the lighting assertions.
  // We only need the scene to render so we can screenshot.
  const probe = await page.evaluate(async (BUILD_TIMEOUT) => {
    const out = { steps: [] };
    try {
      const canvas =
        document.getElementById("scene") || document.querySelector("canvas");
      if (!canvas) { out.error = "no canvas"; return out; }
      // Use the SAME URL the page used during bootstrap so the
      // ES-module loader returns the already-initialized instance
      // (init() was awaited in index.html's top-level <script type=module>).
      // Importing without the ?v=h3-e1 cache key produces a fresh,
      // uninitialized instance whose __wbindgen_malloc et al. throw.
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
      out.shadowsEnabled = !!live.shadowsEnabled;
      out.rendererShadowEnabled = !!live.renderer?.shadowMap?.enabled;
      out.shadowMapType = live.renderer?.shadowMap?.type ?? null;
      out.sunCastShadow = !!live.lighting?.sun?.castShadow;
      out.buildingsChildCount = live.buildingsGroup?.children?.length ?? 0;
      out.terrainChildCount = live.terrainGroup?.children?.length ?? 0;
      // Count meshes with castShadow + receiveShadow flags set,
      // segmented by group. Helps diagnose if the flag-propagation
      // path didn't reach a builder.
      const buildings = live.buildingsGroup;
      let buildingMeshes = 0, buildingCasters = 0, buildingReceivers = 0;
      if (buildings) {
        buildings.traverse((o) => {
          if (o.isMesh) {
            buildingMeshes += 1;
            if (o.castShadow) buildingCasters += 1;
            if (o.receiveShadow) buildingReceivers += 1;
          }
        });
      }
      out.buildingMeshes = buildingMeshes;
      out.buildingCasters = buildingCasters;
      out.buildingReceivers = buildingReceivers;

      const terrain = live.terrainGroup;
      let terrainMeshes = 0, terrainReceivers = 0;
      if (terrain) {
        terrain.traverse((o) => {
          if (o.isMesh) {
            terrainMeshes += 1;
            if (o.receiveShadow) terrainReceivers += 1;
          }
        });
      }
      out.terrainMeshes = terrainMeshes;
      out.terrainReceivers = terrainReceivers;
      out.initOk = true;
    } catch (e) {
      out.error = String(e?.message ?? e);
      out.errorStack = String(e?.stack ?? "").slice(0, 1200);
    }
    return out;
  }, BUILD_TIMEOUT_MS);

  console.log(`[visfid-p01] [${tag}] probe:`, JSON.stringify(probe, null, 2));

  if (!probe.initOk) {
    console.error(`FAIL [${tag}]: init3D failed: ${probe.error}`);
    await browser.close();
    return { ok: false, fpath: null, reason: probe.error, probe };
  }

  // Render a few frames so the AnimationMixer + lighting tick + sky
  // dome converge to a stable image before the screenshot.
  await page.waitForTimeout(RENDER_WAIT_MS);

  // Manually drive the lighting tick once so the shadow camera
  // frustum recentres on Holtburg's LB centre (the camera was framed
  // there at init3D time). Without this the headless capture's rAF
  // tick may not have fired yet and the shadow camera sits at world
  // origin (~32 km away from Holtburg) → empty shadow map.
  await page.evaluate(async () => {
    const live = window.liveScene3d;
    if (!live?.lighting?.sun?.castShadow) return;
    const lightingMod = await import("./scene3d/lighting.js");
    const { tickLightingForCellState } = lightingMod;
    // Tick a few times — the first tick lazies the sun-direction
    // cache; the second tick is the one that actually moves the
    // target to the recenter point.
    for (let i = 0; i < 3; i += 1) {
      tickLightingForCellState(live, live.sessionHandle);
    }
    // Stash diagnostic on window for the next probe.
    const sun = live.lighting.sun;
    window.__shadowDebug = {
      sunPos: { x: sun.position.x, y: sun.position.y, z: sun.position.z },
      target: { x: sun.target.position.x, y: sun.target.position.y, z: sun.target.position.z },
      camFrustum: {
        l: sun.shadow.camera.left, r: sun.shadow.camera.right,
        t: sun.shadow.camera.top, b: sun.shadow.camera.bottom,
        near: sun.shadow.camera.near, far: sun.shadow.camera.far,
      },
    };
  });

  // Wait another moment for the next rAF + shadow map render.
  await page.waitForTimeout(1500);

  const shadowDebug = await page.evaluate(() => window.__shadowDebug || null);
  console.log(`[visfid-p01] [${tag}] shadow debug:`, JSON.stringify(shadowDebug, null, 2));

  // Screenshot the canvas only (not the full page chrome) so the
  // image fairly represents the renderer output.
  const canvasHandle = await page.$("#scene, canvas");
  if (canvasHandle) {
    await canvasHandle.screenshot({ path: fpath, type: "png" });
  } else {
    await page.screenshot({ path: fpath, type: "png" });
  }

  console.log(`[visfid-p01] [${tag}] screenshot → ${fpath}`);
  await browser.close();
  return { ok: true, fpath, probe, consoleErrors };
}

(async () => {
  const offRes = await captureOne(false);
  const onRes = await captureOne(true);

  console.log("=========================");
  console.log("Phase 0.1 capture summary:");
  console.log("  shadows=off:", JSON.stringify({
    ok: offRes.ok,
    fpath: offRes.fpath,
    reason: offRes.reason,
    rendererShadowEnabled: offRes.probe?.rendererShadowEnabled,
    sunCastShadow: offRes.probe?.sunCastShadow,
    buildingsCasters: offRes.probe?.buildingCasters,
  }));
  console.log("  shadows=on: ", JSON.stringify({
    ok: onRes.ok,
    fpath: onRes.fpath,
    reason: onRes.reason,
    rendererShadowEnabled: onRes.probe?.rendererShadowEnabled,
    sunCastShadow: onRes.probe?.sunCastShadow,
    buildingsCasters: onRes.probe?.buildingCasters,
    buildingsReceivers: onRes.probe?.buildingReceivers,
    terrainReceivers: onRes.probe?.terrainReceivers,
  }));

  let failures = 0;
  function check(name, ok, detail) {
    const status = ok ? "OK" : "FAIL";
    console.log(`  [${status}] ${name}${detail ? " — " + detail : ""}`);
    if (!ok) failures += 1;
  }

  check("shadows=off captured", offRes.ok);
  check("shadows=on captured", onRes.ok);
  check(
    "shadows=off → renderer.shadowMap.enabled === false",
    offRes.probe?.rendererShadowEnabled === false,
    `actual=${offRes.probe?.rendererShadowEnabled}`
  );
  check(
    "shadows=off → sun.castShadow === false",
    offRes.probe?.sunCastShadow === false,
    `actual=${offRes.probe?.sunCastShadow}`
  );
  check(
    "shadows=on → renderer.shadowMap.enabled === true",
    onRes.probe?.rendererShadowEnabled === true,
    `actual=${onRes.probe?.rendererShadowEnabled}`
  );
  check(
    "shadows=on → sun.castShadow === true",
    onRes.probe?.sunCastShadow === true,
    `actual=${onRes.probe?.sunCastShadow}`
  );
  check(
    "shadows=on → buildings have ≥1 castShadow mesh",
    (onRes.probe?.buildingCasters ?? 0) >= 1,
    `casters=${onRes.probe?.buildingCasters}`
  );
  check(
    "shadows=on → terrain has receiveShadow=true on ≥1 mesh",
    (onRes.probe?.terrainReceivers ?? 0) >= 1,
    `receivers=${onRes.probe?.terrainReceivers}`
  );

  console.log("=========================");
  if (failures > 0) {
    console.log(`Phase 0.1 capture: FAIL (${failures} check(s) failed)`);
    process.exit(1);
  } else {
    console.log("Phase 0.1 capture: PASS");
    process.exit(0);
  }
})().catch((e) => {
  console.error("[visfid-p01] capture script threw:", e?.message ?? e);
  process.exit(2);
});
