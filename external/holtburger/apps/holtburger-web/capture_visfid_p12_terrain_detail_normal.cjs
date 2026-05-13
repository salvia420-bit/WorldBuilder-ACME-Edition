// Visual-fidelity Phase 1.2 capture — drives index.html with three
// quality presets and probes the terrain detail-normal wiring:
//
//   - ?quality=low   → terrainDetailNormal=false, uDetailNormalEnabled=0
//   - ?quality=mid   → terrainDetailNormal=true,  uDetailNormalEnabled=1
//   - ?quality=high  → terrainDetailNormal=true,  uDetailNormalEnabled=1
//
// One screenshot per preset at first-person camera height + the
// terrain-detail-array load summary + a close-up of the Holtburg
// neighbourhood. Saves under
// /mnt/wbterminal1/tmp/claude-scratch/visual-fidelity/wave3-p12/.
//
// Holtburg LB 0xA9B4 terrain types per `get-terrain-layers`:
//   3 LushGrass (42%), 1 Grassland (22%), 14 SemiBarrenRock (22%),
//   9 PatchyGrassland (14%) — so we exercise grass + stone slices.
// Sand is not present in Holtburg's 9-LB ring; the sand drift rotation
// is verified via shader inspection + slice presence rather than a
// live screenshot.
//
// Run from `apps/holtburger-web/`:
//   PHASE12_PAGE_BASE=http://127.0.0.1:8090/apps/holtburger-web/index.html \
//   PHASE12_OUT_DIR=/mnt/wbterminal1/tmp/claude-scratch/visual-fidelity/wave3-p12 \
//   NODE_PATH=/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules \
//   node capture_visfid_p12_terrain_detail_normal.cjs

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
  process.env.PHASE12_PAGE_BASE ||
  "http://127.0.0.1:8090/apps/holtburger-web/index.html";
const OUT_DIR =
  process.env.PHASE12_OUT_DIR ||
  "/mnt/wbterminal1/tmp/claude-scratch/visual-fidelity/wave3-p12";
const SMOKE_TIMEOUT_MS = Number(process.env.PHASE12_SMOKE_TIMEOUT_MS || 90_000);
const BUILD_TIMEOUT_MS = Number(process.env.PHASE12_BUILD_TIMEOUT_MS || 180_000);
const RENDER_WAIT_MS = Number(process.env.PHASE12_RENDER_WAIT_MS || 4_000);

fs.mkdirSync(OUT_DIR, { recursive: true });

async function captureOne(quality) {
  const tag = quality;
  const fname = `holtburg_grass_${tag}.png`;
  const fpath = path.join(OUT_DIR, fname);

  const pageUrl = `${PAGE_BASE}?renderer=3d&quality=${quality}`;
  console.log(`[visfid-p12] launching chromium → ${pageUrl}`);

  const browser = await chromium.launch({
    args: ["--use-gl=swiftshader"],
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 1024 },
  });
  const page = await context.newPage();

  let consoleErrors = 0;
  const phaseLogs = [];
  page.on("console", (msg) => {
    const text = msg.text();
    if (msg.type() === "error") {
      consoleErrors += 1;
      if (consoleErrors <= 10) console.log(`[browser error] ${text}`);
    } else if (/phase-1.2|terrain.*detail.*normal|visfid-p12/i.test(text)) {
      phaseLogs.push(text);
    }
  });
  page.on("pageerror", (err) => {
    consoleErrors += 1;
    console.error("[pageerror]", err.message);
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
    console.log(`[visfid-p12] [${tag}] smoke panel PASS`);
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

  const probe = await page.evaluate(async (BUILD_TIMEOUT) => {
    const out = { steps: [] };
    try {
      const canvas =
        document.getElementById("scene") || document.querySelector("canvas");
      if (!canvas) {
        out.error = "no canvas";
        return out;
      }
      const wasmMod = await import("./pkg/holtburger_web.js?v=h3-e1");
      const scene3d = await import("./scene3d/index.js");

      const mockSession = {
        isCurrentCellIndoor() {
          return false;
        },
        getCurrentCellId() {
          return 0;
        },
        getRenderSet() {
          return new Uint32Array(0);
        },
        setMovementInput() {},
        pollEntityUpdates() {
          return [];
        },
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

      out.qualityPreset = live.quality?.preset;
      out.terrainDetailNormalFlag = !!live.quality?.flags?.terrainDetailNormal;
      out.terrainDetailNormalArrayLoaded = !!live.terrainDetailNormalArray;
      out.terrainDetailNormalArrayDepth =
        live.terrainDetailNormalArray?.image?.depth ?? null;
      out.terrainDetailNormalArrayWidth =
        live.terrainDetailNormalArray?.image?.width ?? null;

      // Walk terrain LB meshes, count those with the detail-normal patch
      // wired (uniform present + enabled value matches the flag).
      let terrainMeshes = 0;
      let terrainWithDetail = 0;
      let enabledUniformOnSum = 0;
      let codeToSliceLen = 0;
      live.terrainGroup?.traverse((o) => {
        if (!o.isMesh || !o.material?.uniforms?.uDetailNormalEnabled) return;
        terrainMeshes += 1;
        const u = o.material.uniforms;
        if (o.userData?.detailNormalEnabled) terrainWithDetail += 1;
        enabledUniformOnSum += (u.uDetailNormalEnabled.value ?? 0);
        codeToSliceLen = u.uCodeToSlice?.value?.length ?? 0;
      });
      out.terrainMeshes = terrainMeshes;
      out.terrainWithDetail = terrainWithDetail;
      out.enabledUniformAvg =
        terrainMeshes > 0 ? enabledUniformOnSum / terrainMeshes : 0;
      out.codeToSliceLen = codeToSliceLen;
      out.initOk = true;
    } catch (e) {
      out.error = String(e?.message ?? e);
      out.errorStack = String(e?.stack ?? "").slice(0, 1200);
    }
    return out;
  }, BUILD_TIMEOUT_MS);

  console.log(`[visfid-p12] [${tag}] probe:`, JSON.stringify(probe, null, 2));
  if (phaseLogs.length) {
    console.log(`[visfid-p12] [${tag}] phase-1.2 console:`);
    for (const l of phaseLogs) console.log(`    ${l}`);
  }

  if (!probe.initOk) {
    console.error(`FAIL [${tag}]: init3D failed: ${probe.error}`);
    await browser.close();
    return { ok: false, fpath: null, reason: probe.error, probe };
  }

  // Drive the cameraSwitcher into "follow" mode at a tight follow-
  // distance + steep pitch so the camera ends up ~2 m above the
  // player's ground-plane position, looking nearly straight down on
  // grass. This is sturdier than setting camera.position directly:
  // the per-tick positionCamera() recomputes from followYaw/Pitch/
  // Distance so a one-shot camera.position.set() gets overwritten on
  // the next frame.
  const closeUp = await page.evaluate(async () => {
    const live = window.liveScene3d;
    if (!live?.cameraSwitcher) return null;
    const sw = live.cameraSwitcher;
    sw.followYaw = 0; // north
    // followPitch: positive means LOOK DOWN (per the camera.js inline
    // comment about followPitch convention).
    sw.followPitch = 1.1; // ~63° below horizontal
    sw.followDistance = 2.5; // 2.5 m back from the player
    return {
      mode: sw.mode,
      yaw: sw.followYaw,
      pitch: sw.followPitch,
      dist: sw.followDistance,
    };
  });
  console.log(
    `[visfid-p12] [${tag}] close-up cam state:`,
    JSON.stringify(closeUp)
  );

  await page.waitForTimeout(RENDER_WAIT_MS);

  const canvasHandle = await page.$("#scene, canvas");
  if (canvasHandle) {
    await canvasHandle.screenshot({ path: fpath, type: "png" });
  } else {
    await page.screenshot({ path: fpath, type: "png" });
  }
  console.log(`[visfid-p12] [${tag}] screenshot → ${fpath}`);

  // Overview shot: pull the follow camera back + raise it to a 3rd-
  // person elevated framing.
  const overviewPath = path.join(OUT_DIR, `holtburg_overview_${tag}.png`);
  await page.evaluate(() => {
    const live = window.liveScene3d;
    const sw = live?.cameraSwitcher;
    if (!sw) return;
    sw.followYaw = 0;
    sw.followPitch = 0.6;
    sw.followDistance = 40;
  });
  await page.waitForTimeout(1500);
  if (canvasHandle) {
    await canvasHandle.screenshot({ path: overviewPath, type: "png" });
    console.log(`[visfid-p12] [${tag}] overview → ${overviewPath}`);
  }

  await browser.close();
  return { ok: true, fpath, overviewPath, probe, consoleErrors, phaseLogs };
}

(async () => {
  const lowRes = await captureOne("low");
  const midRes = await captureOne("mid");
  const highRes = await captureOne("high");

  console.log("=========================");
  console.log("Phase 1.2 capture summary:");
  for (const [tag, r] of [
    ["low", lowRes],
    ["mid", midRes],
    ["high", highRes],
  ]) {
    console.log(
      `  quality=${tag}:`,
      JSON.stringify({
        ok: r.ok,
        fpath: r.fpath,
        reason: r.reason,
        qualityPreset: r.probe?.qualityPreset,
        terrainDetailNormalFlag: r.probe?.terrainDetailNormalFlag,
        terrainDetailNormalArrayLoaded:
          r.probe?.terrainDetailNormalArrayLoaded,
        terrainDetailNormalArrayDepth: r.probe?.terrainDetailNormalArrayDepth,
        terrainMeshes: r.probe?.terrainMeshes,
        terrainWithDetail: r.probe?.terrainWithDetail,
        enabledUniformAvg: r.probe?.enabledUniformAvg,
        codeToSliceLen: r.probe?.codeToSliceLen,
      })
    );
  }

  let failures = 0;
  function check(name, ok, detail) {
    const status = ok ? "OK" : "FAIL";
    console.log(`  [${status}] ${name}${detail ? " — " + detail : ""}`);
    if (!ok) failures += 1;
  }

  check("quality=low captured", lowRes.ok);
  check("quality=mid captured", midRes.ok);
  check("quality=high captured", highRes.ok);

  check(
    "quality=low → terrainDetailNormal flag OFF",
    lowRes.probe?.terrainDetailNormalFlag === false,
    `flag=${lowRes.probe?.terrainDetailNormalFlag}`
  );
  check(
    "quality=mid → terrainDetailNormal flag ON",
    midRes.probe?.terrainDetailNormalFlag === true,
    `flag=${midRes.probe?.terrainDetailNormalFlag}`
  );
  check(
    "quality=high → terrainDetailNormal flag ON",
    highRes.probe?.terrainDetailNormalFlag === true,
    `flag=${highRes.probe?.terrainDetailNormalFlag}`
  );

  check(
    "quality=mid → DataArrayTexture loaded with depth=5",
    midRes.probe?.terrainDetailNormalArrayLoaded === true &&
      midRes.probe?.terrainDetailNormalArrayDepth === 5,
    `loaded=${midRes.probe?.terrainDetailNormalArrayLoaded} depth=${midRes.probe?.terrainDetailNormalArrayDepth}`
  );
  check(
    "quality=mid → 9 terrain meshes with detail-normal uniforms wired",
    (midRes.probe?.terrainMeshes ?? 0) >= 9 &&
      midRes.probe?.codeToSliceLen === 32,
    `terrainMeshes=${midRes.probe?.terrainMeshes} codeToSliceLen=${midRes.probe?.codeToSliceLen}`
  );
  check(
    "quality=mid → uDetailNormalEnabled uniform = 1.0 on every terrain LB",
    Math.abs((midRes.probe?.enabledUniformAvg ?? 0) - 1.0) < 0.01,
    `avg=${midRes.probe?.enabledUniformAvg}`
  );
  check(
    "quality=low → uDetailNormalEnabled uniform = 0.0 on every terrain LB",
    (lowRes.probe?.enabledUniformAvg ?? 0) === 0,
    `avg=${lowRes.probe?.enabledUniformAvg}`
  );

  console.log("=========================");
  if (failures > 0) {
    console.log(`Phase 1.2 capture: FAIL (${failures} check(s) failed)`);
    process.exit(1);
  } else {
    console.log("Phase 1.2 capture: PASS");
    process.exit(0);
  }
})().catch((e) => {
  console.error("[visfid-p12] capture script threw:", e?.message ?? e);
  process.exit(2);
});
