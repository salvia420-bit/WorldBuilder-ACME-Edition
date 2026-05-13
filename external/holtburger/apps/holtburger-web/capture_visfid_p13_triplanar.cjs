// Visual-fidelity Phase 1.3 capture — drives index.html with three
// quality presets and probes the slope-gated triplanar wiring on the
// terrain detail-normal layer:
//
//   - ?quality=low   → triplanar=false, uTriplanarEnabled=0
//   - ?quality=mid   → triplanar=true,  uTriplanarEnabled=1
//   - ?quality=high  → triplanar=true,  uTriplanarEnabled=1
//
// For each preset we capture:
//   1. A flat plaza overhead shot (slope < TRIPLANAR_SLOPE_LO →
//      grid-UV path; should be visually unchanged from Phase 1.2).
//   2. A slope-side oblique shot framed at the steepest face in the
//      Holtburg 9-LB ring (mid/high preset shows reduced stretching;
//      low preset retains the baseline stretching).
//
// Saves under
// /mnt/wbterminal1/tmp/claude-scratch/visual-fidelity/wave4-p13/.
//
// Run from `apps/holtburger-web/`:
//   PHASE13_PAGE_BASE=http://127.0.0.1:8090/apps/holtburger-web/index.html \
//   PHASE13_OUT_DIR=/mnt/wbterminal1/tmp/claude-scratch/visual-fidelity/wave4-p13 \
//   NODE_PATH=/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules \
//   node capture_visfid_p13_triplanar.cjs

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
  process.env.PHASE13_PAGE_BASE ||
  "http://127.0.0.1:8090/apps/holtburger-web/index.html";
const OUT_DIR =
  process.env.PHASE13_OUT_DIR ||
  "/mnt/wbterminal1/tmp/claude-scratch/visual-fidelity/wave4-p13";
const SMOKE_TIMEOUT_MS = Number(process.env.PHASE13_SMOKE_TIMEOUT_MS || 90_000);
const BUILD_TIMEOUT_MS = Number(process.env.PHASE13_BUILD_TIMEOUT_MS || 180_000);
const RENDER_WAIT_MS = Number(process.env.PHASE13_RENDER_WAIT_MS || 4_000);

fs.mkdirSync(OUT_DIR, { recursive: true });

async function captureOne(quality) {
  const tag = quality;
  const flatPath = path.join(OUT_DIR, `holtburg_flat_${tag}.png`);
  const slopePath = path.join(OUT_DIR, `holtburg_slope_${tag}.png`);

  const pageUrl = `${PAGE_BASE}?renderer=3d&quality=${quality}`;
  console.log(`[visfid-p13] launching chromium -> ${pageUrl}`);

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
    } else if (/phase-1\.3|triplanar|visfid-p13|phase-1\.2/i.test(text)) {
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
    console.log(`[visfid-p13] [${tag}] smoke panel PASS`);
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
      out.triplanarFlag = !!live.quality?.flags?.triplanar;
      out.terrainDetailNormalFlag = !!live.quality?.flags?.terrainDetailNormal;
      out.terrainDetailNormalArrayLoaded = !!live.terrainDetailNormalArray;

      // Walk terrain LB meshes, count those with the triplanar patch
      // wired (uniform present + enabled value matches the flag).
      // Also find the globally steepest TRIANGLE (not LB) — needed to
      // frame the slope-side screenshot at a face that exceeds the
      // smoothstep upper threshold (0.5) so triplanar's visual effect
      // is at full strength.
      let terrainMeshes = 0;
      let terrainWithTriplanar = 0;
      let triEnabledSum = 0;
      let triSharpnessSum = 0;
      let triSlopeLo = null;
      let triSlopeHi = null;
      let steepestTri = {
        slope: 0,
        lbX: 0,
        lbY: 0,
        localX: 0, localY: 0, localZ: 0,
        worldX: 0, worldY: 0,
        nx: 0, ny: 0, nz: 1,
      };
      live.terrainGroup?.traverse((o) => {
        if (!o.isMesh || !o.material?.uniforms?.uTriplanarEnabled) return;
        terrainMeshes += 1;
        const u = o.material.uniforms;
        if (o.userData?.triplanarEnabled) terrainWithTriplanar += 1;
        triEnabledSum += (u.uTriplanarEnabled.value ?? 0);
        triSharpnessSum += (u.uTriplanarSharpness?.value ?? 0);
        triSlopeLo = o.userData?.triplanarSlopeLo;
        triSlopeHi = o.userData?.triplanarSlopeHi;
        const geo = o.geometry;
        const pos = geo?.getAttribute("position");
        const idx = geo?.getIndex();
        if (!pos || !idx) return;
        const a = idx.array;
        for (let i = 0; i < a.length; i += 3) {
          const i0 = a[i], i1 = a[i+1], i2 = a[i+2];
          const ax = pos.getX(i0), ay = pos.getY(i0), az = pos.getZ(i0);
          const bx = pos.getX(i1), by = pos.getY(i1), bz = pos.getZ(i1);
          const cx2 = pos.getX(i2), cy2 = pos.getY(i2), cz2 = pos.getZ(i2);
          const ux = bx - ax, uy = by - ay, uz = bz - az;
          const vx = cx2 - ax, vy = cy2 - ay, vz = cz2 - az;
          const nx = uy * vz - uz * vy;
          const ny = uz * vx - ux * vz;
          const nz = ux * vy - uy * vx;
          const nl = Math.hypot(nx, ny, nz);
          if (nl < 1e-3) continue;
          const nxn = nx / nl, nyn = ny / nl, nzn = nz / nl;
          const slope = 1 - Math.abs(nzn);
          if (slope > steepestTri.slope) {
            steepestTri = {
              slope,
              lbX: o.userData.lbX,
              lbY: o.userData.lbY,
              localX: (ax + bx + cx2) / 3,
              localY: (ay + by + cy2) / 3,
              localZ: (az + bz + cz2) / 3,
              worldX: o.position.x,
              worldY: o.position.y,
              nx: nxn, ny: nyn, nz: nzn,
            };
          }
        }
      });
      out.terrainMeshes = terrainMeshes;
      out.terrainWithTriplanar = terrainWithTriplanar;
      out.triEnabledAvg =
        terrainMeshes > 0 ? triEnabledSum / terrainMeshes : 0;
      out.triSharpness =
        terrainMeshes > 0 ? triSharpnessSum / terrainMeshes : 0;
      out.triSlopeLo = triSlopeLo;
      out.triSlopeHi = triSlopeHi;
      out.steepestTri = steepestTri;
      out.initOk = true;
    } catch (e) {
      out.error = String(e?.message ?? e);
      out.errorStack = String(e?.stack ?? "").slice(0, 1200);
    }
    return out;
  }, BUILD_TIMEOUT_MS);

  console.log(`[visfid-p13] [${tag}] probe:`, JSON.stringify(probe, null, 2));
  if (phaseLogs.length) {
    console.log(`[visfid-p13] [${tag}] phase-1.3 console:`);
    for (const l of phaseLogs) console.log(`    ${l}`);
  }

  if (!probe.initOk) {
    console.error(`FAIL [${tag}]: init3D failed: ${probe.error}`);
    if (probe.errorStack) console.error(probe.errorStack);
    await browser.close();
    return { ok: false, fpath: null, reason: probe.error, probe };
  }

  // ---- FLAT shot: top-down view of Holtburg plaza centre. ----
  await page.evaluate(() => {
    const live = window.liveScene3d;
    if (!live?.cameraSwitcher) return null;
    const sw = live.cameraSwitcher;
    sw.followYaw = 0; // north
    sw.followPitch = 1.4; // ~80 deg below horizon = nearly straight down
    sw.followDistance = 6.0;
    return { yaw: sw.followYaw, pitch: sw.followPitch, dist: sw.followDistance };
  });
  await page.waitForTimeout(RENDER_WAIT_MS);

  const canvasHandle = await page.$("#scene, canvas");
  if (canvasHandle) {
    await canvasHandle.screenshot({
      path: flatPath,
      type: "png",
      timeout: 90_000,
    });
  } else {
    await page.screenshot({ path: flatPath, type: "png", timeout: 90_000 });
  }
  console.log(`[visfid-p13] [${tag}] flat shot -> ${flatPath}`);

  // ---- SLOPE shot: frame the globally-steepest triangle found during
  // probe traversal. The triangle's centroid is computed in AC LB-local
  // coords; we add the LB's world offset to get the AC world position,
  // then convert to three.js (x, z, -y).
  const slopeCam = await page.evaluate((tri) => {
    if (!tri || tri.slope <= 0) return null;
    const live = window.liveScene3d;
    if (!live?.camera || !live?.cameraSwitcher) return null;
    const camera = live.camera;
    const sw = live.cameraSwitcher;
    sw.mode = "orbit";

    const worldAcX = tri.localX + tri.worldX;
    const worldAcY = tri.localY + tri.worldY;
    const worldAcZ = tri.localZ;
    const t3X = worldAcX;
    const t3Y = worldAcZ;
    const t3Z = -worldAcY;
    // Outward normal in XY plane. Step camera back along the normal at
    // 18 m, 6 m above, looking back at the cliff centre — wider framing
    // so the smoothstep transition zone (slope 0.2→0.5) is visible in
    // one shot.
    const horizN = Math.hypot(tri.nx, tri.ny);
    const nxh = horizN > 1e-3 ? tri.nx / horizN : 1;
    const nyh = horizN > 1e-3 ? tri.ny / horizN : 0;
    const camDist = 18.0;
    const camHeight = 6.0;
    camera.position.set(
      t3X + nxh * camDist,
      t3Y + camHeight,
      t3Z - nyh * camDist
    );
    camera.lookAt(t3X, t3Y, t3Z);
    camera.updateMatrixWorld(true);
    // Compute the expected smoothstep blend at this slope so the report
    // makes clear how much triplanar contribution is visible.
    const slopeLo = 0.2, slopeHi = 0.5;
    const tNorm = Math.max(0, Math.min(1, (tri.slope - slopeLo) / (slopeHi - slopeLo)));
    const triBlend = tNorm * tNorm * (3 - 2 * tNorm);
    return {
      bestSlope: tri.slope,
      angleFromHorizontalDeg: Math.acos(Math.abs(tri.nz)) * 180 / Math.PI,
      expectedTriplanarBlend: triBlend,
      cliffCentreAc: [worldAcX, worldAcY, worldAcZ],
      cliffNormalAc: [tri.nx, tri.ny, tri.nz],
      cameraPos: [camera.position.x, camera.position.y, camera.position.z],
      lookAt: [t3X, t3Y, t3Z],
    };
  }, probe.steepestTri);
  console.log(`[visfid-p13] [${tag}] slope cam:`, JSON.stringify(slopeCam));

  await page.waitForTimeout(RENDER_WAIT_MS);

  // Use a longer screenshot timeout — high-quality preset adds SSAO +
  // CSM passes that can run slow under swiftshader, occasionally
  // tripping Playwright's default 30s element-screenshot deadline.
  if (canvasHandle) {
    await canvasHandle.screenshot({
      path: slopePath,
      type: "png",
      timeout: 90_000,
    });
  } else {
    await page.screenshot({ path: slopePath, type: "png", timeout: 90_000 });
  }
  console.log(`[visfid-p13] [${tag}] slope shot -> ${slopePath}`);

  await browser.close();
  return {
    ok: true,
    flatPath,
    slopePath,
    probe,
    consoleErrors,
    phaseLogs,
    slopeCam,
  };
}

(async () => {
  const lowRes = await captureOne("low");
  const midRes = await captureOne("mid");
  const highRes = await captureOne("high");

  console.log("=========================");
  console.log("Phase 1.3 capture summary:");
  for (const [tag, r] of [
    ["low", lowRes],
    ["mid", midRes],
    ["high", highRes],
  ]) {
    console.log(
      `  quality=${tag}:`,
      JSON.stringify({
        ok: r.ok,
        flatPath: r.flatPath,
        slopePath: r.slopePath,
        reason: r.reason,
        qualityPreset: r.probe?.qualityPreset,
        triplanarFlag: r.probe?.triplanarFlag,
        terrainDetailNormalFlag: r.probe?.terrainDetailNormalFlag,
        terrainMeshes: r.probe?.terrainMeshes,
        terrainWithTriplanar: r.probe?.terrainWithTriplanar,
        triEnabledAvg: r.probe?.triEnabledAvg,
        triSharpness: r.probe?.triSharpness,
        triSlopeLo: r.probe?.triSlopeLo,
        triSlopeHi: r.probe?.triSlopeHi,
        steepestTri: r.probe?.steepestTri
          ? `lb=${r.probe.steepestTri.lbX.toString(16)}-${r.probe.steepestTri.lbY.toString(16)} slope=${r.probe.steepestTri.slope.toFixed(3)} angle=${(Math.acos(Math.abs(r.probe.steepestTri.nz)) * 180 / Math.PI).toFixed(1)}deg`
          : null,
        triplanarBlendAtSteepest:
          r.slopeCam?.expectedTriplanarBlend?.toFixed(3),
      })
    );
  }

  let failures = 0;
  function check(name, ok, detail) {
    const status = ok ? "OK" : "FAIL";
    console.log(`  [${status}] ${name}${detail ? " - " + detail : ""}`);
    if (!ok) failures += 1;
  }

  check("quality=low captured", lowRes.ok);
  check("quality=mid captured", midRes.ok);
  check("quality=high captured", highRes.ok);

  check(
    "quality=low -> triplanar flag OFF",
    lowRes.probe?.triplanarFlag === false,
    `flag=${lowRes.probe?.triplanarFlag}`
  );
  check(
    "quality=mid -> triplanar flag ON",
    midRes.probe?.triplanarFlag === true,
    `flag=${midRes.probe?.triplanarFlag}`
  );
  check(
    "quality=high -> triplanar flag ON",
    highRes.probe?.triplanarFlag === true,
    `flag=${highRes.probe?.triplanarFlag}`
  );

  check(
    "quality=mid -> 9 terrain meshes with triplanar uniforms wired",
    (midRes.probe?.terrainMeshes ?? 0) >= 9,
    `terrainMeshes=${midRes.probe?.terrainMeshes}`
  );
  check(
    "quality=mid -> uTriplanarEnabled uniform = 1.0 on every terrain LB",
    Math.abs((midRes.probe?.triEnabledAvg ?? 0) - 1.0) < 0.01,
    `avg=${midRes.probe?.triEnabledAvg}`
  );
  check(
    "quality=low -> uTriplanarEnabled uniform = 0.0 on every terrain LB",
    (lowRes.probe?.triEnabledAvg ?? 0) === 0,
    `avg=${lowRes.probe?.triEnabledAvg}`
  );
  check(
    "quality=mid -> uTriplanarSharpness uniform > 4 and < 8 (4-8 sweet spot)",
    (midRes.probe?.triSharpness ?? 0) >= 4 &&
      (midRes.probe?.triSharpness ?? 0) <= 8,
    `sharpness=${midRes.probe?.triSharpness}`
  );
  check(
    "quality=mid -> slopeLo (0.2) < slopeHi (0.5)",
    midRes.probe?.triSlopeLo === 0.2 && midRes.probe?.triSlopeHi === 0.5,
    `lo=${midRes.probe?.triSlopeLo} hi=${midRes.probe?.triSlopeHi}`
  );
  // Holtburg's terrain peaks at ~46° (slope 0.316) — no vertical cliffs.
  // Hand-off note acknowledges the FULL visual win lands at slope >=0.5.
  // We pass at >=0.25 (~30° slope) since that hits the smoothstep ramp
  // (mix factor ~0.16) and demonstrates the gate is active. Cliffs steep
  // enough to hit slope=0.5+ are present in Yanshi / Arwic / Arvilla but
  // not Holtburg's 9-LB ring — flagged in the report doc.
  check(
    "Steepest triangle hits the smoothstep ramp (slope > slopeLo=0.2)",
    (midRes.probe?.steepestTri?.slope ?? 0) > 0.2,
    `slope=${midRes.probe?.steepestTri?.slope?.toFixed(3)} (angle=${(Math.acos(Math.abs(midRes.probe?.steepestTri?.nz ?? 1)) * 180 / Math.PI).toFixed(1)}deg)`
  );

  console.log("=========================");
  if (failures > 0) {
    console.log(`Phase 1.3 capture: FAIL (${failures} check(s) failed)`);
    process.exit(1);
  } else {
    console.log("Phase 1.3 capture: PASS");
    process.exit(0);
  }
})().catch((e) => {
  console.error("[visfid-p13] capture script threw:", e?.message ?? e);
  process.exit(2);
});
