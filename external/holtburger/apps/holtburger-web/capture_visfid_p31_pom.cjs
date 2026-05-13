// Visual-fidelity Phase 3.1 capture — drives index.html with
// `?renderer=3d&quality=high&forcePom=on` vs `?renderer=3d&quality=mid`,
// takes a single screenshot of each at close range to a Holtburg
// surface (cottage wall — Stone category), saves under
// /mnt/wbterminal1/tmp/claude-scratch/visual-fidelity/wave4-p31/.
//
// Note on `forcePom`: the high-quality preset enables POM globally for
// Stone/Brick/Tile category surfaces. Holtburg's cottage walls are
// classified as Stone, but to make the visual difference unmistakable
// in a single screenshot we use `?forcePom=on` which applies the
// parallax patch to EVERY textured material (subject to the height-
// map being non-empty). Without this we'd have to guarantee the
// camera is framing a specific Stone surface — see Phase 3.1 report.
//
// LAPTOP SAFETY: §7 hard rule — do NOT run a sustained capture with
// POM + SSAO + CSM + subdivision=8 active. This script renders ONE
// frame each for high+mid and exits. Defer perf to PK on live-ACE.
//
// Run from `apps/holtburger-web/`:
//   PHASE31_PAGE_BASE=http://127.0.0.1:8090/apps/holtburger-web/index.html \
//   PHASE31_OUT_DIR=/mnt/wbterminal1/tmp/claude-scratch/visual-fidelity/wave4-p31 \
//   NODE_PATH=/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules \
//   node capture_visfid_p31_pom.cjs

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
  process.env.PHASE31_PAGE_BASE ||
  "http://127.0.0.1:8090/apps/holtburger-web/index.html";
const OUT_DIR =
  process.env.PHASE31_OUT_DIR ||
  "/mnt/wbterminal1/tmp/claude-scratch/visual-fidelity/wave4-p31";
const SMOKE_TIMEOUT_MS = Number(process.env.PHASE31_SMOKE_TIMEOUT_MS || 90_000);
const BUILD_TIMEOUT_MS = Number(process.env.PHASE31_BUILD_TIMEOUT_MS || 180_000);
const RENDER_WAIT_MS = Number(process.env.PHASE31_RENDER_WAIT_MS || 4_000);

fs.mkdirSync(OUT_DIR, { recursive: true });

async function captureOne(quality, force) {
  const tag = `${quality}${force ? "_forcepom" : ""}`;
  const fname = `holtburg_close_pom_${tag}.png`;
  const fpath = path.join(OUT_DIR, fname);

  // `quality=high` flips POM on for Stone surfaces; `forcePom=on`
  // applies the patch to every textured material (use this to make
  // the effect unmistakable on whatever surface the camera frames).
  const params = [`renderer=3d`, `quality=${quality}`];
  if (force) params.push("forcePom=on");
  const pageUrl = `${PAGE_BASE}?${params.join("&")}`;

  console.log(`[visfid-p31] launching chromium → ${pageUrl}`);

  const browser = await chromium.launch({
    args: ["--use-gl=swiftshader"],
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 1024 },
  });
  const page = await context.newPage();

  let consoleErrors = 0;
  const pomLogs = [];
  page.on("console", (msg) => {
    const text = msg.text();
    if (msg.type() === "error") {
      consoleErrors += 1;
      if (consoleErrors <= 10) console.log(`[browser error] ${text}`);
    } else if (/phase-3.1|pom/i.test(text)) {
      pomLogs.push(text);
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
    console.log(`[visfid-p31] [${tag}] smoke panel PASS`);
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
      // Reuse the page's already-initialised module (same `?v=h3-e1`
      // suffix index.html uses); a different version would create a
      // separate module instance with its own uninitialised wasm
      // singleton, breaking every fetch_* export.
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
      out.qualityPom = !!live.quality?.flags?.pom;
      out.pomEnabledSceneFlag = !!live.pomEnabled;
      out.forcePomSceneFlag = !!live.forcePom;
      out.buildingsChildCount = live.buildingsGroup?.children?.length ?? 0;

      // Walk every mesh in the buildings group and count how many have
      // the Phase 3.1 POM patch wired (userData.pomEnabled === true).
      // Also tally per-surface-category so we can verify Stone surfaces
      // are the ones picked up under high quality (no forcePom).
      let materialsTotal = 0;
      let materialsWithPom = 0;
      let materialsStoneCategory = 0;
      let materialsStoneWithPom = 0;
      const pomStepCounts = {};
      const seen = new Set();
      live.buildingsGroup?.traverse((o) => {
        if (!o.isMesh || !o.material) return;
        if (seen.has(o.material.uuid)) return;
        seen.add(o.material.uuid);
        materialsTotal += 1;
        const cat = o.material.userData?.surfaceCategory;
        const isStone = cat === 0 || cat === 10 || cat === 11; // Stone/Brick/Tile
        if (isStone) materialsStoneCategory += 1;
        if (o.material.userData?.pomEnabled === true) {
          materialsWithPom += 1;
          if (isStone) materialsStoneWithPom += 1;
          const steps = o.material.userData.pomUniforms?.steps ?? -1;
          pomStepCounts[`${steps}`] = (pomStepCounts[`${steps}`] ?? 0) + 1;
        }
      });
      out.materialsTotal = materialsTotal;
      out.materialsWithPom = materialsWithPom;
      out.materialsStoneCategory = materialsStoneCategory;
      out.materialsStoneWithPom = materialsStoneWithPom;
      out.pomStepCounts = pomStepCounts;
      out.initOk = true;
    } catch (e) {
      out.error = String(e?.message ?? e);
      out.errorStack = String(e?.stack ?? "").slice(0, 1200);
    }
    return out;
  }, BUILD_TIMEOUT_MS);

  console.log(`[visfid-p31] [${tag}] probe:`, JSON.stringify(probe, null, 2));
  if (pomLogs.length) {
    console.log(`[visfid-p31] [${tag}] phase-3.1 console:`);
    for (const l of pomLogs) console.log(`    ${l}`);
  }

  if (!probe.initOk) {
    console.error(`FAIL [${tag}]: init3D failed: ${probe.error}`);
    console.error("stack:", probe.errorStack);
    await browser.close();
    return { ok: false, fpath: null, reason: probe.error, probe };
  }

  // Move the camera in close (~3m) so the POM ray-march has enough
  // angular extent to be visible. Look for a Stone-category mesh
  // specifically (per §Phase 3.1 — POM applies to Stone/Brick/Tile).
  // Fall back to the first textured mesh if no Stone mesh is found.
  // Position the camera head-on to the wall (not above it) so the
  // POM perturbed UV is visible.
  const closeUp = await page.evaluate(async () => {
    const live = window.liveScene3d;
    if (!live?.buildingsGroup || !live.camera) return null;
    let stoneMesh = null;
    let firstMesh = null;
    live.buildingsGroup.traverse((o) => {
      if (!o.isMesh) return;
      if (!firstMesh) firstMesh = o;
      if (!stoneMesh && o.material?.userData?.pomEnabled === true) {
        stoneMesh = o;
      }
    });
    const target = stoneMesh ?? firstMesh;
    if (!target) return null;
    const THREE = await import("three");
    const targetPos = new THREE.Vector3();
    target.getWorldPosition(targetPos);
    // Use the mesh's geometry to find a wall normal so we can point
    // the camera at the wall face. For simplicity, compute the wall
    // outward direction from the geometry's bounding-box.
    if (!target.geometry.boundingBox) target.geometry.computeBoundingBox();
    const bbox = target.geometry.boundingBox.clone();
    bbox.applyMatrix4(target.matrixWorld);
    const center = new THREE.Vector3();
    bbox.getCenter(center);
    const size = new THREE.Vector3();
    bbox.getSize(size);
    // Position the camera at an oblique angle to the wall (not
    // perpendicular). POM produces ZERO visible effect when viewed
    // head-on — the parallax shift is `view_xy / view_z * depth`, and
    // perpendicular view has view_xy ≈ 0. Grazing angles (~60° from
    // perpendicular) produce the strongest perceived depth.
    const offsetX = 2.0;
    const offsetZ = 2.0;
    const eyeHeight = 1.5;
    // Update BOTH `live.camera` AND the activeCamera if the camera
    // switcher routes the render to a different camera object. The
    // render loop uses `cameraSwitcher.activeCamera ?? camera`.
    const cams = [live.camera, live.cameraSwitcher?.activeCamera].filter(Boolean);
    for (const cam of cams) {
      cam.position.set(
        center.x + size.x / 2 + offsetX,
        Math.max(bbox.min.y + eyeHeight, center.y),
        center.z + size.z / 2 + offsetZ
      );
      cam.lookAt(center.x, center.y, center.z);
      cam.updateMatrixWorld();
    }
    return {
      pomMeshFound: !!stoneMesh,
      meshName: target.name ?? "(unnamed)",
      meshHasPom: target.material?.userData?.pomEnabled === true,
      meshCategory: target.material?.userData?.surfaceCategory,
      target: { x: center.x, y: center.y, z: center.z },
      camPos: {
        x: live.camera.position.x,
        y: live.camera.position.y,
        z: live.camera.position.z,
      },
      size: { x: size.x, y: size.y, z: size.z },
    };
  });
  console.log(`[visfid-p31] [${tag}] close-up:`, JSON.stringify(closeUp, null, 2));

  await page.waitForTimeout(RENDER_WAIT_MS);

  // Capture the on-screen canvas by calling live.renderer.render
  // synchronously then immediately reading the canvas backbuffer via
  // an OffscreenCanvas → toBlob → PNG bytes. Three's renderer uses
  // preserveDrawingBuffer=false by default so we render to the default
  // framebuffer (i.e. canvas) and read back via a chained gl context.
  //
  // Trick: after the synchronous render call the WebGL drawing buffer
  // is valid until the next composite swap. Reading via drawImage to
  // a 2D canvas immediately captures it.
  const dataUrl = await page.evaluate(async (camTarget) => {
    const live = window.liveScene3d;
    if (!live?.renderer || !live?.scene) {
      return null;
    }
    try {
      const THREE = await import("three");
      const canvas = live.renderer.domElement;
      // Build OUR OWN camera positioned at the target spot. The live
      // camera is reset every rAF by the CameraSwitcher's tick(); a
      // fresh PerspectiveCamera avoids that auto-revert.
      const myCam = new THREE.PerspectiveCamera(
        60, canvas.width / canvas.height, 0.1, 5000
      );
      myCam.position.set(camTarget.camPos.x, camTarget.camPos.y, camTarget.camPos.z);
      myCam.lookAt(camTarget.target.x, camTarget.target.y, camTarget.target.z);
      myCam.updateMatrixWorld();
      myCam.updateProjectionMatrix();
      // Synchronous render with OUR camera. Next rAF will overwrite
      // with the live one, so drawImage must happen in the same task.
      live.renderer.render(live.scene, myCam);
      const w = canvas.width;
      const h = canvas.height;
      const cv = document.createElement("canvas");
      cv.width = w;
      cv.height = h;
      const ctx = cv.getContext("2d");
      ctx.drawImage(canvas, 0, 0);
      return cv.toDataURL("image/png");
    } catch (e) {
      return "ERROR:" + (e?.message ?? e);
    }
  }, closeUp ?? { camPos: { x: 0, y: 0, z: 0 }, target: { x: 0, y: 0, z: 0 } });
  if (dataUrl && dataUrl.startsWith("data:image/png;base64,")) {
    const b64 = dataUrl.slice("data:image/png;base64,".length);
    fs.writeFileSync(fpath, Buffer.from(b64, "base64"));
  } else {
    console.error(`[visfid-p31] [${tag}] dataUrl readback failed: ${String(dataUrl).slice(0, 200)}`);
    try {
      await page.screenshot({ path: fpath, type: "png", timeout: 8000 });
    } catch (e) {
      console.error(`[visfid-p31] [${tag}] screenshot fallback failed:`, e?.message ?? e);
    }
  }

  console.log(`[visfid-p31] [${tag}] screenshot → ${fpath}`);
  await browser.close();
  return { ok: true, fpath, probe, consoleErrors, pomLogs };
}

(async () => {
  // High-quality (POM on for Stone) — with forcePom=on so the patch
  // applies to every surface the camera frames, making the difference
  // unmistakable in a single screenshot.
  const highRes = await captureOne("high", true);
  // Mid quality (POM off) — same camera position, baseline comparison.
  const midRes = await captureOne("mid", false);

  console.log("=========================");
  console.log("Phase 3.1 capture summary:");
  console.log(
    "  quality=high (POM on, forcePom):",
    JSON.stringify({
      ok: highRes.ok,
      fpath: highRes.fpath,
      reason: highRes.reason,
      preset: highRes.probe?.qualityPreset,
      pomEnabled: highRes.probe?.qualityPom,
      forcePom: highRes.probe?.forcePomSceneFlag,
      materialsWithPom: highRes.probe?.materialsWithPom,
      pomStepCounts: highRes.probe?.pomStepCounts,
    })
  );
  console.log(
    "  quality=mid (POM off):",
    JSON.stringify({
      ok: midRes.ok,
      fpath: midRes.fpath,
      reason: midRes.reason,
      preset: midRes.probe?.qualityPreset,
      pomEnabled: midRes.probe?.qualityPom,
      materialsWithPom: midRes.probe?.materialsWithPom,
    })
  );

  let failures = 0;
  function check(name, ok, detail) {
    const status = ok ? "OK" : "FAIL";
    console.log(`  [${status}] ${name}${detail ? " — " + detail : ""}`);
    if (!ok) failures += 1;
  }

  check("quality=high captured", highRes.ok);
  check("quality=mid captured", midRes.ok);
  check(
    "quality=high → quality.flags.pom=true",
    highRes.probe?.qualityPom === true,
    `pom=${highRes.probe?.qualityPom}`
  );
  check(
    "quality=mid → quality.flags.pom=false (gated)",
    midRes.probe?.qualityPom === false,
    `pom=${midRes.probe?.qualityPom}`
  );
  check(
    "quality=high+forcePom → ≥3 materials with POM patch (forced on textured surfaces)",
    (highRes.probe?.materialsWithPom ?? 0) >= 3,
    `materialsWithPom=${highRes.probe?.materialsWithPom}`
  );
  check(
    "quality=mid → 0 materials with POM patch (preset off)",
    (midRes.probe?.materialsWithPom ?? 0) === 0,
    `materialsWithPom=${midRes.probe?.materialsWithPom}`
  );
  check(
    "quality=high POM step count = 16 (high preset default)",
    Object.keys(highRes.probe?.pomStepCounts ?? {}).includes("16"),
    `steps=${JSON.stringify(highRes.probe?.pomStepCounts)}`
  );

  console.log("=========================");
  if (failures > 0) {
    console.log(`Phase 3.1 capture: FAIL (${failures} check(s) failed)`);
    process.exit(1);
  } else {
    console.log("Phase 3.1 capture: PASS");
    process.exit(0);
  }
})().catch((e) => {
  console.error("[visfid-p31] capture script threw:", e?.message ?? e);
  process.exit(2);
});
