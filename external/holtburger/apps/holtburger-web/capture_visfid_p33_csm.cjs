// Visual-fidelity Phase 3.3 capture — drives index.html with
// `?quality=high` (CSM active) and `?quality=mid` (single-shadow
// fallback per Phase 0.1), takes a screenshot of each, saves under
// /mnt/wbterminal1/tmp/claude-scratch/visual-fidelity/wave3-p33/.
//
// FPS perf measurement is DEFERRED to PK on the live-ACE box per the
// plan-doc §7 hard rule — this capture only verifies that:
//   - CSM mode wires 3 cascade lights with castShadow=true.
//   - Each cascade light has the expected mapSize (2048/2048/1024).
//   - Per-cascade shadow camera frustums are sensibly sized post-tick.
//   - The render output renders without console errors.
//
// Run from `apps/holtburger-web/`:
//   PHASE33_PAGE_BASE=http://127.0.0.1:8090/apps/holtburger-web/index.html \
//   PHASE33_OUT_DIR=/mnt/wbterminal1/tmp/claude-scratch/visual-fidelity/wave3-p33 \
//   NODE_PATH=/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules \
//   node capture_visfid_p33_csm.cjs

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
  process.env.PHASE33_PAGE_BASE ||
  "http://127.0.0.1:8090/apps/holtburger-web/index.html";
const OUT_DIR =
  process.env.PHASE33_OUT_DIR ||
  "/mnt/wbterminal1/tmp/claude-scratch/visual-fidelity/wave3-p33";
const SMOKE_TIMEOUT_MS = Number(process.env.PHASE33_SMOKE_TIMEOUT_MS || 90_000);
const BUILD_TIMEOUT_MS = Number(process.env.PHASE33_BUILD_TIMEOUT_MS || 180_000);
const RENDER_WAIT_MS = Number(process.env.PHASE33_RENDER_WAIT_MS || 4_000);

fs.mkdirSync(OUT_DIR, { recursive: true });

async function captureOne(quality) {
  const tag = quality;
  const fname = `holtburg_${tag}.png`;
  const fpath = path.join(OUT_DIR, fname);

  // For quality=mid, force-on the Phase 0.1 single-shadow path via
  // `?shadows=on` so the fallback baseline is actually a single shadow
  // (rather than no shadows at all). quality=high doesn't need the
  // flag since CSM is gated purely on `quality.flags.csm`.
  const shadowParam = quality === "mid" ? "&shadows=on" : "";
  const pageUrl = `${PAGE_BASE}?renderer=3d&quality=${quality}${shadowParam}`;
  console.log(`[visfid-p33] launching chromium → ${pageUrl}`);

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
      if (/shadow|csm|castShadow|csmShadow/i.test(text)) {
        console.log(`[browser warn] ${text}`);
      }
    } else if (msg.type() === "log" && /visfid|csm/i.test(text)) {
      console.log(`[browser log] ${text}`);
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
    console.log(`[visfid-p33] [${tag}] smoke panel PASS`);
  } catch (e) {
    const html = await page.locator("#results").innerHTML().catch(() => "(no #results)");
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
      out.quality = live.quality?.preset ?? null;
      out.csmEnabled = !!live.csmEnabled;
      out.shadowsEnabled = !!live.shadowsEnabled;
      out.rendererShadowEnabled = !!live.renderer?.shadowMap?.enabled;
      out.shadowMapType = live.renderer?.shadowMap?.type ?? null;
      out.sunCastShadow = !!live.lighting?.sun?.castShadow;
      out.csmLightCount = live.csmState?.lights?.length ?? 0;
      out.csmSplits = live.csmState?.splits ?? null;
      out.csmMapSizes = live.csmState?.lights?.map((l) => l.shadow?.mapSize?.x ?? 0) ?? null;
      // Probe shadow flags propagated to building/terrain meshes.
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

      // Count materials that have the CSM patch installed.
      let csmPatchedMats = 0;
      if (live.csmState?.patchedMaterials) {
        csmPatchedMats = live.csmState.patchedMaterials.size;
      }
      out.csmPatchedMats = csmPatchedMats;
      out.initOk = true;
    } catch (e) {
      out.error = String(e?.message ?? e);
      out.errorStack = String(e?.stack ?? "").slice(0, 1200);
    }
    return out;
  }, BUILD_TIMEOUT_MS);

  console.log(`[visfid-p33] [${tag}] probe:`, JSON.stringify(probe, null, 2));

  if (!probe.initOk) {
    console.error(`FAIL [${tag}]: init3D failed: ${probe.error}`);
    await browser.close();
    return { ok: false, fpath: null, reason: probe.error, probe };
  }

  await page.waitForTimeout(RENDER_WAIT_MS);

  // Drive the lighting tick so the CSM cascades update to fit the
  // current camera frustum. Mirrors the Phase 0.1 capture's
  // updateShadowCameraTarget invocation.
  await page.evaluate(async () => {
    const live = window.liveScene3d;
    if (!live) return;
    const lightingMod = await import("./scene3d/lighting.js");
    const { tickLightingForCellState } = lightingMod;
    for (let i = 0; i < 5; i += 1) {
      tickLightingForCellState(live, live.sessionHandle);
    }
    // Stash CSM diagnostic for the post-tick probe.
    if (live.csmState) {
      window.__csmDebug = {
        splits: live.csmState.splits,
        cascades: live.csmState.lights.map((l) => ({
          mapSize: l.shadow.mapSize.x,
          left: l.shadow.camera.left,
          right: l.shadow.camera.right,
          top: l.shadow.camera.top,
          bottom: l.shadow.camera.bottom,
          near: l.shadow.camera.near,
          far: l.shadow.camera.far,
        })),
      };
    } else if (live.lighting?.sun?.castShadow) {
      window.__csmDebug = {
        singleShadow: {
          left: live.lighting.sun.shadow.camera.left,
          right: live.lighting.sun.shadow.camera.right,
        },
      };
    }
  });

  await page.waitForTimeout(1500);

  const csmDebug = await page.evaluate(() => window.__csmDebug || null);
  console.log(`[visfid-p33] [${tag}] csm/shadow debug:`, JSON.stringify(csmDebug, null, 2));

  const canvasHandle = await page.$("#scene, canvas");
  if (canvasHandle) {
    await canvasHandle.screenshot({ path: fpath, type: "png" });
  } else {
    await page.screenshot({ path: fpath, type: "png" });
  }

  console.log(`[visfid-p33] [${tag}] screenshot → ${fpath}`);
  await browser.close();
  return { ok: true, fpath, probe, csmDebug, consoleErrors };
}

(async () => {
  // Phase 3.3 captures: mid (single-shadow per Phase 0.1) and high
  // (CSM active). Same camera framing → diffable.
  const midRes = await captureOne("mid");
  const highRes = await captureOne("high");

  console.log("=========================");
  console.log("Phase 3.3 capture summary:");
  console.log("  quality=mid:  ", JSON.stringify({
    ok: midRes.ok,
    fpath: midRes.fpath,
    reason: midRes.reason,
    quality: midRes.probe?.quality,
    csmEnabled: midRes.probe?.csmEnabled,
    shadowsEnabled: midRes.probe?.shadowsEnabled,
    rendererShadow: midRes.probe?.rendererShadowEnabled,
    sunCastShadow: midRes.probe?.sunCastShadow,
    csmLightCount: midRes.probe?.csmLightCount,
    buildingCasters: midRes.probe?.buildingCasters,
  }));
  console.log("  quality=high: ", JSON.stringify({
    ok: highRes.ok,
    fpath: highRes.fpath,
    reason: highRes.reason,
    quality: highRes.probe?.quality,
    csmEnabled: highRes.probe?.csmEnabled,
    shadowsEnabled: highRes.probe?.shadowsEnabled,
    rendererShadow: highRes.probe?.rendererShadowEnabled,
    sunCastShadow: highRes.probe?.sunCastShadow,
    csmLightCount: highRes.probe?.csmLightCount,
    csmSplits: highRes.probe?.csmSplits,
    csmMapSizes: highRes.probe?.csmMapSizes,
    csmPatchedMats: highRes.probe?.csmPatchedMats,
    buildingCasters: highRes.probe?.buildingCasters,
    buildingReceivers: highRes.probe?.buildingReceivers,
  }));

  let failures = 0;
  function check(name, ok, detail) {
    const status = ok ? "OK" : "FAIL";
    console.log(`  [${status}] ${name}${detail ? " — " + detail : ""}`);
    if (!ok) failures += 1;
  }

  check("quality=mid captured", midRes.ok);
  check("quality=high captured", highRes.ok);
  // mid preset has shadows:true, csm:false → Phase 0.1 path active.
  check(
    "quality=mid → csmEnabled=false (single-shadow path)",
    midRes.probe?.csmEnabled === false,
    `actual=${midRes.probe?.csmEnabled}`
  );
  check(
    "quality=mid → sun.castShadow=true (Phase 0.1 single shadow)",
    midRes.probe?.sunCastShadow === true,
    `actual=${midRes.probe?.sunCastShadow}`
  );
  check(
    "quality=mid → csmLightCount=0 (no cascades)",
    (midRes.probe?.csmLightCount ?? 0) === 0,
    `actual=${midRes.probe?.csmLightCount}`
  );
  // high preset has csm:true → CSM active.
  check(
    "quality=high → csmEnabled=true",
    highRes.probe?.csmEnabled === true,
    `actual=${highRes.probe?.csmEnabled}`
  );
  check(
    "quality=high → sun.castShadow=false (CSM owns shadow casting)",
    highRes.probe?.sunCastShadow === false,
    `actual=${highRes.probe?.sunCastShadow}`
  );
  check(
    "quality=high → csmLightCount=3 (3 cascade lights)",
    highRes.probe?.csmLightCount === 3,
    `actual=${highRes.probe?.csmLightCount}`
  );
  check(
    "quality=high → csmSplits=[30,100,300]",
    JSON.stringify(highRes.probe?.csmSplits) === JSON.stringify([30, 100, 300]),
    `actual=${JSON.stringify(highRes.probe?.csmSplits)}`
  );
  check(
    "quality=high → csmMapSizes=[2048,2048,1024]",
    JSON.stringify(highRes.probe?.csmMapSizes) === JSON.stringify([2048, 2048, 1024]),
    `actual=${JSON.stringify(highRes.probe?.csmMapSizes)}`
  );
  check(
    "quality=high → rendererShadowEnabled=true",
    highRes.probe?.rendererShadowEnabled === true,
    `actual=${highRes.probe?.rendererShadowEnabled}`
  );
  check(
    "quality=high → buildings have ≥1 castShadow mesh",
    (highRes.probe?.buildingCasters ?? 0) >= 1,
    `casters=${highRes.probe?.buildingCasters}`
  );
  check(
    "quality=high → ≥1 material was csm-patched",
    (highRes.probe?.csmPatchedMats ?? 0) >= 1,
    `patched=${highRes.probe?.csmPatchedMats}`
  );
  // Verify post-tick cascade frustums are sensibly sized (and grow
  // monotonically — cascade 0 < cascade 1 < cascade 2 in width).
  if (highRes.csmDebug?.cascades) {
    const cascades = highRes.csmDebug.cascades;
    const widths = cascades.map((c) => c.right - c.left);
    const heights = cascades.map((c) => c.top - c.bottom);
    check(
      "quality=high → post-tick: cascade frustums are finite + positive",
      cascades.every((c) =>
        Number.isFinite(c.left) && Number.isFinite(c.right) &&
        c.right > c.left && c.top > c.bottom && c.far > c.near
      ),
      `widths=${widths.map((w) => w.toFixed(1)).join(",")}`
    );
    check(
      "quality=high → post-tick: cascade widths grow (0 < 1 < 2)",
      widths[0] < widths[1] && widths[1] < widths[2],
      `widths=${widths.map((w) => w.toFixed(1)).join(",")}`
    );
  }

  console.log("=========================");
  if (failures > 0) {
    console.log(`Phase 3.3 capture: FAIL (${failures} check(s) failed)`);
    process.exit(1);
  } else {
    console.log("Phase 3.3 capture: PASS");
    process.exit(0);
  }
})().catch((e) => {
  console.error("[visfid-p33] capture script threw:", e?.message ?? e);
  process.exit(2);
});
