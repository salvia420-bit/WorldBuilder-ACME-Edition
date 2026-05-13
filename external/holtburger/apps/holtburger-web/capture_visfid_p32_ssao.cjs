// Visual-fidelity Phase 3.2 capture — A/B screenshot of Holtburg
// with SSAO off (?quality=mid) vs on (?quality=high&shadows=on).
//
// Single-frame screenshots only — laptop-safe. Per §7 hard rule we
// do NOT run a continuous capture with SSAO + POM + subdivision=8 +
// CSM. POM is not yet implemented; we drive quality=high (which
// enables SSAO + CSM flags) but only consume SSAO here.
//
// Run from `apps/holtburger-web/` against a local dev server
// (python3 -m http.server 8090 --directory ../..):
//   PHASE32_PAGE_BASE=http://127.0.0.1:8090/apps/holtburger-web/index.html \
//   PHASE32_OUT_DIR=/mnt/wbterminal1/tmp/claude-scratch/visual-fidelity/wave3-p32 \
//   NODE_PATH=/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules \
//   node capture_visfid_p32_ssao.cjs

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
      "FAIL: playwright not found in NODE_PATH or " + PLAYWRIGHT_CACHE
    );
    process.exit(2);
  }
}

const PAGE_BASE =
  process.env.PHASE32_PAGE_BASE ||
  "http://127.0.0.1:8090/apps/holtburger-web/index.html";
const OUT_DIR =
  process.env.PHASE32_OUT_DIR ||
  "/mnt/wbterminal1/tmp/claude-scratch/visual-fidelity/wave3-p32";
const SMOKE_TIMEOUT_MS = Number(process.env.PHASE32_SMOKE_TIMEOUT_MS || 90_000);
const BUILD_TIMEOUT_MS = Number(process.env.PHASE32_BUILD_TIMEOUT_MS || 180_000);
const RENDER_WAIT_MS = Number(process.env.PHASE32_RENDER_WAIT_MS || 6_000);

fs.mkdirSync(OUT_DIR, { recursive: true });

async function captureOne(ssaoOn) {
  const tag = ssaoOn ? "on" : "off";
  const fname = `holtburg_noon_ssao_${tag}.png`;
  const fpath = path.join(OUT_DIR, fname);

  // SSAO is gated by `quality.flags.ssao` (true at high+ultra; false
  // at low+mid). For the off baseline we use ?quality=mid (default
  // anyway, but explicit so the screenshot label matches the URL).
  // For the on case we use ?quality=high which flips ssao+shadows+
  // CSM+POM+hero flags. POM, CSM, and hero aren't shipped yet so the
  // effective on-state delta is SSAO + shadows.
  const pageUrl =
    `${PAGE_BASE}?renderer=3d&shadows=on` +
    (ssaoOn ? "&quality=high" : "&quality=mid");

  console.log(`[visfid-p32] launching chromium → ${pageUrl}`);

  const browser = await chromium.launch({
    args: ["--use-gl=swiftshader"],
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 1024 },
  });
  const page = await context.newPage();

  let consoleErrors = 0;
  const ssaoLogs = [];
  page.on("console", (msg) => {
    const text = msg.text();
    if (msg.type() === "error") {
      consoleErrors += 1;
      if (consoleErrors <= 10) console.log(`[browser error] ${text}`);
    } else if (/phase-3\.2|ssao|composer/i.test(text)) {
      ssaoLogs.push(text);
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
    console.log(`[visfid-p32] [${tag}] smoke panel PASS`);
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
  // capture_visfid_p02_detail.cjs. We need real Holtburg buildings
  // + terrain so SSAO has actual geometry to darken.
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
      out.preset = live.quality?.preset;
      out.ssaoFlag = live.quality?.flags?.ssao;
      out.ssaoPipelinePresent = !!live.ssaoPipeline;
      if (live.ssaoPipeline) {
        const pass = live.ssaoPipeline.ssaoPass;
        out.kernelRadius = pass.kernelRadius;
        out.minDistance = pass.minDistance;
        out.maxDistance = pass.maxDistance;
        out.composerPassCount = live.ssaoPipeline.composer.passes.length;
        out.skyRenderPassPresent = !!live.ssaoPipeline.skyRenderPass;
      }
      out.buildingsChildCount = live.buildingsGroup?.children?.length ?? 0;
      out.terrainChildCount = live.terrainGroup?.children?.length ?? 0;
      out.initOk = true;
    } catch (e) {
      out.error = String(e?.message ?? e);
      out.errorStack = String(e?.stack ?? "").slice(0, 1200);
    }
    return out;
  }, BUILD_TIMEOUT_MS);

  console.log(`[visfid-p32] [${tag}] probe:`, JSON.stringify(probe, null, 2));
  console.log(`[visfid-p32] [${tag}] ssao logs:`, ssaoLogs.slice(0, 3));

  if (!probe.initOk) {
    console.error(`FAIL [${tag}]: init3D failed: ${probe.error}`);
    if (probe.errorStack) console.error(probe.errorStack);
    await browser.close();
    return { ok: false, fpath: null, reason: probe.error, probe };
  }

  // Render a few frames so the AnimationMixer + lighting tick + sky
  // dome + composer converge to a stable image before the screenshot.
  await page.waitForTimeout(RENDER_WAIT_MS);

  // Drive the lighting tick once so the shadow camera frustum
  // recentres on Holtburg's LB centre — otherwise the shadow render
  // sits at world origin in the headless capture (mirrors Phase 0.1's
  // recentering hook).
  await page.evaluate(async () => {
    const live = window.liveScene3d;
    if (!live?.lighting?.sun?.castShadow) return;
    const lightingMod = await import("./scene3d/lighting.js");
    const { tickLightingForCellState } = lightingMod;
    for (let i = 0; i < 3; i += 1) {
      tickLightingForCellState(live, live.sessionHandle);
    }
  });

  await page.waitForTimeout(1500);

  const canvasHandle = await page.$("#scene, canvas");
  if (canvasHandle) {
    await canvasHandle.screenshot({ path: fpath, type: "png" });
  } else {
    await page.screenshot({ path: fpath, type: "png" });
  }

  console.log(`[visfid-p32] [${tag}] screenshot → ${fpath}`);
  await browser.close();
  return { ok: true, fpath, probe, consoleErrors };
}

(async () => {
  const offRes = await captureOne(false);
  const onRes = await captureOne(true);

  console.log("=========================");
  console.log("Phase 3.2 capture summary:");
  console.log("  ssao=off:", JSON.stringify({
    ok: offRes.ok,
    fpath: offRes.fpath,
    reason: offRes.reason,
    preset: offRes.probe?.preset,
    ssaoFlag: offRes.probe?.ssaoFlag,
    ssaoPipelinePresent: offRes.probe?.ssaoPipelinePresent,
  }));
  console.log("  ssao=on: ", JSON.stringify({
    ok: onRes.ok,
    fpath: onRes.fpath,
    reason: onRes.reason,
    preset: onRes.probe?.preset,
    ssaoFlag: onRes.probe?.ssaoFlag,
    ssaoPipelinePresent: onRes.probe?.ssaoPipelinePresent,
    kernelRadius: onRes.probe?.kernelRadius,
    minDistance: onRes.probe?.minDistance,
    maxDistance: onRes.probe?.maxDistance,
    composerPassCount: onRes.probe?.composerPassCount,
    skyRenderPassPresent: onRes.probe?.skyRenderPassPresent,
  }));

  let failures = 0;
  function check(name, ok, detail) {
    const status = ok ? "OK" : "FAIL";
    console.log(`  [${status}] ${name}${detail ? " — " + detail : ""}`);
    if (!ok) failures += 1;
  }

  check("ssao=off captured", offRes.ok);
  check("ssao=on captured", onRes.ok);
  check(
    "ssao=off → quality.flags.ssao === false",
    offRes.probe?.ssaoFlag === false,
    `actual=${offRes.probe?.ssaoFlag}`
  );
  check(
    "ssao=off → no ssaoPipeline on liveScene3d",
    offRes.probe?.ssaoPipelinePresent === false,
    `actual=${offRes.probe?.ssaoPipelinePresent}`
  );
  check(
    "ssao=on → quality.flags.ssao === true",
    onRes.probe?.ssaoFlag === true,
    `actual=${onRes.probe?.ssaoFlag}`
  );
  check(
    "ssao=on → ssaoPipeline constructed",
    onRes.probe?.ssaoPipelinePresent === true,
    `actual=${onRes.probe?.ssaoPipelinePresent}`
  );
  check(
    "ssao=on → kernelRadius in [2, 4] (AC scale)",
    (onRes.probe?.kernelRadius ?? 0) >= 2 && (onRes.probe?.kernelRadius ?? 0) <= 4,
    `kernelRadius=${onRes.probe?.kernelRadius}`
  );
  check(
    "ssao=on → composer has ≥4 passes (sky/world/SSAO/output)",
    (onRes.probe?.composerPassCount ?? 0) >= 4,
    `passes=${onRes.probe?.composerPassCount}`
  );
  check(
    "ssao=on → sky RenderPass wired into composer",
    onRes.probe?.skyRenderPassPresent === true,
    `actual=${onRes.probe?.skyRenderPassPresent}`
  );
  check(
    "ssao=on → buildings present (real Holtburg load)",
    (onRes.probe?.buildingsChildCount ?? 0) >= 1,
    `count=${onRes.probe?.buildingsChildCount}`
  );

  console.log("=========================");
  if (failures > 0) {
    console.log(`Phase 3.2 capture: FAIL (${failures} check(s) failed)`);
    process.exit(1);
  } else {
    console.log("Phase 3.2 capture: PASS");
  }
})().catch((e) => {
  console.error("FATAL:", e);
  process.exit(2);
});
