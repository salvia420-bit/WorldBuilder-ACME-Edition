// Visual-fidelity Phase 0.2 capture — drives index.html with
// `?renderer=3d` and `?renderer=3d&forceDetail=on`, takes a single
// screenshot of each + the diff bookkeeping, saves under
// /mnt/wbterminal1/tmp/claude-scratch/visual-fidelity/wave2-p02/.
//
// Note on `forceDetail`: the retail portal.dat ships ZERO surfaces
// with the `Detail (0x20000)` bit set (verified by
// `apps/holtburger-tools/src/bin/scan-detail-surfaces.rs`, output at
// /mnt/wbterminal1/tmp/claude-scratch/visual-fidelity/wave2-p02/detail_scan.txt).
// To validate the rendering path end-to-end against real Holtburg
// surfaces we use `?forceDetail=on` which applies the composite to
// every textured material regardless of the bit. Without this we'd
// have nothing to compare against — see Phase 0.2 report.
//
// Run from `apps/holtburger-web/`:
//   PHASE02_PAGE_BASE=http://127.0.0.1:8090/apps/holtburger-web/index.html \
//   PHASE02_OUT_DIR=/mnt/wbterminal1/tmp/claude-scratch/visual-fidelity/wave2-p02 \
//   NODE_PATH=/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules \
//   node capture_visfid_p02_detail.cjs

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
  process.env.PHASE02_PAGE_BASE ||
  "http://127.0.0.1:8090/apps/holtburger-web/index.html";
const OUT_DIR =
  process.env.PHASE02_OUT_DIR ||
  "/mnt/wbterminal1/tmp/claude-scratch/visual-fidelity/wave2-p02";
const SMOKE_TIMEOUT_MS = Number(process.env.PHASE02_SMOKE_TIMEOUT_MS || 90_000);
const BUILD_TIMEOUT_MS = Number(process.env.PHASE02_BUILD_TIMEOUT_MS || 180_000);
const RENDER_WAIT_MS = Number(process.env.PHASE02_RENDER_WAIT_MS || 4_000);

fs.mkdirSync(OUT_DIR, { recursive: true });

async function captureOne(detailOn) {
  const tag = detailOn ? "on" : "off";
  const fname = `holtburg_close_detail_${tag}.png`;
  const fpath = path.join(OUT_DIR, fname);

  // `forceDetail=on` applies the Phase 0.2 composite to every textured
  // surface (since the retail DAT has no Detail-flagged surfaces).
  // `quality=mid` is the default, which has `detailFlag: true` — we
  // still need the URL param to pick up forceDetail.
  const pageUrl =
    `${PAGE_BASE}?renderer=3d` + (detailOn ? "&forceDetail=on" : "");

  console.log(`[visfid-p02] launching chromium → ${pageUrl}`);

  const browser = await chromium.launch({
    args: ["--use-gl=swiftshader"],
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 1024 },
  });
  const page = await context.newPage();

  let consoleErrors = 0;
  const detailLogs = [];
  page.on("console", (msg) => {
    const text = msg.text();
    if (msg.type() === "error") {
      consoleErrors += 1;
      if (consoleErrors <= 10) console.log(`[browser error] ${text}`);
    } else if (/phase-0.2|detail/i.test(text)) {
      detailLogs.push(text);
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
    console.log(`[visfid-p02] [${tag}] smoke panel PASS`);
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

      out.detailTileCacheSize = live.detailTileCache?.size ?? 0;
      out.forceDetail = !!live.forceDetail;
      out.qualityPreset = live.quality?.preset;
      out.qualityDetailFlag = !!live.quality?.flags?.detailFlag;
      out.buildingsChildCount = live.buildingsGroup?.children?.length ?? 0;

      // Walk every mesh in the buildings group and count how many have
      // the Phase 0.2 detail patch wired.
      let materialsTotal = 0;
      let materialsWithDetail = 0;
      const detailKeyCounts = {};
      const seen = new Set();
      live.buildingsGroup?.traverse((o) => {
        if (!o.isMesh || !o.material) return;
        if (seen.has(o.material.uuid)) return;
        seen.add(o.material.uuid);
        materialsTotal += 1;
        if (o.material.userData?.detailEnabled) {
          materialsWithDetail += 1;
          const k = o.material.userData.detailKey ?? "(?)";
          detailKeyCounts[k] = (detailKeyCounts[k] ?? 0) + 1;
        }
      });
      out.materialsTotal = materialsTotal;
      out.materialsWithDetail = materialsWithDetail;
      out.detailKeyCounts = detailKeyCounts;
      out.initOk = true;
    } catch (e) {
      out.error = String(e?.message ?? e);
      out.errorStack = String(e?.stack ?? "").slice(0, 1200);
    }
    return out;
  }, BUILD_TIMEOUT_MS);

  console.log(`[visfid-p02] [${tag}] probe:`, JSON.stringify(probe, null, 2));
  if (detailLogs.length) {
    console.log(`[visfid-p02] [${tag}] phase-0.2 console:`);
    for (const l of detailLogs) console.log(`    ${l}`);
  }

  if (!probe.initOk) {
    console.error(`FAIL [${tag}]: init3D failed: ${probe.error}`);
    await browser.close();
    return { ok: false, fpath: null, reason: probe.error, probe };
  }

  // Move the camera in close so the detail tile is visible at native
  // pixel scale. Target an arbitrary building part centre + ~3 m from
  // it. We do this AFTER init3D since the rAF loop is already running.
  const closeUp = await page.evaluate(async () => {
    const live = window.liveScene3d;
    if (!live?.buildingsGroup || !live.camera) return null;
    // Find the first mesh in the buildings group. Holtburg's LB centre
    // is at ~(0xa9*192+96, 0xb4*192+96, ~80) AC = (32,544, 34,656, 80).
    // We use the mesh's actual world position so the camera is always
    // pointed at something solid.
    let firstMesh = null;
    live.buildingsGroup.traverse((o) => {
      if (firstMesh) return;
      if (o.isMesh) firstMesh = o;
    });
    if (!firstMesh) return null;
    const target = new (await import("three")).Vector3();
    firstMesh.getWorldPosition(target);
    // Camera 3 m back + 0.5 m up in three.js coords (Y is up after the
    // worldRoot rotation).
    live.camera.position.set(target.x + 3, target.y + 0.5, target.z + 3);
    live.camera.lookAt(target.x, target.y, target.z);
    return {
      target: { x: target.x, y: target.y, z: target.z },
      camPos: {
        x: live.camera.position.x,
        y: live.camera.position.y,
        z: live.camera.position.z,
      },
      meshName: firstMesh.name ?? "(unnamed)",
    };
  });
  console.log(`[visfid-p02] [${tag}] close-up:`, JSON.stringify(closeUp, null, 2));

  await page.waitForTimeout(RENDER_WAIT_MS);

  const canvasHandle = await page.$("#scene, canvas");
  if (canvasHandle) {
    await canvasHandle.screenshot({ path: fpath, type: "png" });
  } else {
    await page.screenshot({ path: fpath, type: "png" });
  }

  console.log(`[visfid-p02] [${tag}] screenshot → ${fpath}`);
  await browser.close();
  return { ok: true, fpath, probe, consoleErrors, detailLogs };
}

(async () => {
  const offRes = await captureOne(false);
  const onRes = await captureOne(true);

  console.log("=========================");
  console.log("Phase 0.2 capture summary:");
  console.log(
    "  detail=off:",
    JSON.stringify({
      ok: offRes.ok,
      fpath: offRes.fpath,
      reason: offRes.reason,
      detailTileCacheSize: offRes.probe?.detailTileCacheSize,
      materialsWithDetail: offRes.probe?.materialsWithDetail,
    })
  );
  console.log(
    "  detail=on:",
    JSON.stringify({
      ok: onRes.ok,
      fpath: onRes.fpath,
      reason: onRes.reason,
      detailTileCacheSize: onRes.probe?.detailTileCacheSize,
      materialsWithDetail: onRes.probe?.materialsWithDetail,
      detailKeyCounts: onRes.probe?.detailKeyCounts,
    })
  );

  let failures = 0;
  function check(name, ok, detail) {
    const status = ok ? "OK" : "FAIL";
    console.log(`  [${status}] ${name}${detail ? " — " + detail : ""}`);
    if (!ok) failures += 1;
  }

  check("detail=off captured", offRes.ok);
  check("detail=on captured", onRes.ok);
  check(
    "detail=off → no materials with Detail patch (no Detail-flag surfaces in retail)",
    (offRes.probe?.materialsWithDetail ?? 0) === 0,
    `materialsWithDetail=${offRes.probe?.materialsWithDetail}`
  );
  check(
    "detail=on → forceDetail=true",
    onRes.probe?.forceDetail === true,
    `forceDetail=${onRes.probe?.forceDetail}`
  );
  check(
    "detail=on → all 5 tiles loaded",
    (onRes.probe?.detailTileCacheSize ?? 0) === 5,
    `cacheSize=${onRes.probe?.detailTileCacheSize}`
  );
  check(
    "detail=on → ≥3 materials with Detail patch wired",
    (onRes.probe?.materialsWithDetail ?? 0) >= 3,
    `materialsWithDetail=${onRes.probe?.materialsWithDetail}`
  );
  check(
    "detail=on → ≥2 distinct tile keys observed (category-aware picker working)",
    Object.keys(onRes.probe?.detailKeyCounts ?? {}).length >= 2,
    `keys=${JSON.stringify(onRes.probe?.detailKeyCounts)}`
  );

  console.log("=========================");
  if (failures > 0) {
    console.log(`Phase 0.2 capture: FAIL (${failures} check(s) failed)`);
    process.exit(1);
  } else {
    console.log("Phase 0.2 capture: PASS");
    process.exit(0);
  }
})().catch((e) => {
  console.error("[visfid-p02] capture script threw:", e?.message ?? e);
  process.exit(2);
});
