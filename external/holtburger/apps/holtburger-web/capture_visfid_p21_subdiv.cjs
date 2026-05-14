// Phase 2.1 capture — side-by-side Holtburg hillside screenshots at
// subdiv=1/2/4. Laptop-safe (per §7 hard rule, subdiv=4 single-LB +
// single-frame is fine; subdiv=8 + full Dereth is the OOM case and
// deferred to PK on live-ACE).
//
// Asserts via in-page probe:
//   - quality.flags.subdivLevel === requested value
//   - terrainGroup.children[0].userData.subdivLevel === expected
//     (centre LB picks full level; outer ring halves)
//   - terrain geometry vertex count matches (factor*8+1)²
//
// Run from `apps/holtburger-web/` against a local dev server:
//   PHASE21_PAGE_BASE=http://127.0.0.1:8090/apps/holtburger-web/index.html \
//   PHASE21_OUT_DIR=/mnt/wbterminal1/tmp/claude-scratch/visual-fidelity/wave5-p21 \
//   NODE_PATH=/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules \
//   node capture_visfid_p21_subdiv.cjs

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
    console.error("FAIL: playwright not found in NODE_PATH or " + PLAYWRIGHT_CACHE);
    process.exit(2);
  }
}

const PAGE_BASE =
  process.env.PHASE21_PAGE_BASE ||
  "http://127.0.0.1:8090/apps/holtburger-web/index.html";
const OUT_DIR =
  process.env.PHASE21_OUT_DIR ||
  "/mnt/wbterminal1/tmp/claude-scratch/visual-fidelity/wave5-p21";
const SMOKE_TIMEOUT_MS = Number(process.env.PHASE21_SMOKE_TIMEOUT_MS || 90_000);
const BUILD_TIMEOUT_MS = Number(process.env.PHASE21_BUILD_TIMEOUT_MS || 180_000);
const RENDER_WAIT_MS = Number(process.env.PHASE21_RENDER_WAIT_MS || 4_000);

fs.mkdirSync(OUT_DIR, { recursive: true });

const HOLTBURG_X = 0xa9;
const HOLTBURG_Y = 0xb4;

async function captureOne(level) {
  const fname = `holtburg_hillside_subdiv_${level}.png`;
  const fpath = path.join(OUT_DIR, fname);

  // Use ?subdivLevel=N to override the preset's default level via the
  // per-feature override path in scene3d/quality.js.
  const pageUrl =
    `${PAGE_BASE}?renderer=3d&quality=mid&subdivLevel=${level}`;

  console.log(`[visfid-p21] launching chromium → ${pageUrl}`);

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
      if (consoleErrors <= 6) console.log(`[browser error] ${text}`);
    } else if (/subdiv|terrain|phase-2\.1/i.test(text)) {
      // Only the most informative phase-related logs.
      if (text.length < 200) console.log(`[browser log] ${text.slice(0, 180)}`);
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
  } catch (e) {
    const html = await page.locator("#results").innerHTML().catch(() => "(no #results)");
    console.error(`FAIL: smoke panel never reached PASS within ${SMOKE_TIMEOUT_MS}ms`);
    console.error(`results HTML: ${html.slice(0, 500)}`);
    await browser.close();
    return { ok: false, fpath: null, reason: "smoke timeout" };
  }
  console.log(`[visfid-p21] [subdiv=${level}] smoke panel PASS`);

  // Drive init3D against real wasm exports.
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
        // Phase 2.1 — visual-only subdivided mesh.
        fetch_subdivided_landblock: wasmMod.fetch_subdivided_landblock,
        fetch_subdivided_landblocks: wasmMod.fetch_subdivided_landblocks,
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
      out.subdivLevel = live.quality?.flags?.subdivLevel;
      const tg = live.terrainGroup;
      const meshes = tg ? tg.children.filter((c) => c.userData?.lbX !== undefined) : [];
      out.terrainMeshCount = meshes.length;
      out.perLb = meshes.map((m) => {
        const geom = m.geometry;
        const vc = geom?.attributes?.position?.count ?? 0;
        return {
          lbX: m.userData.lbX,
          lbY: m.userData.lbY,
          subdivLevel: m.userData.subdivLevel,
          vertexCount: vc,
          indexCount: geom?.index?.count ?? 0,
          heightMin: m.userData.heightMin,
          heightMax: m.userData.heightMax,
        };
      });
      // Find the centre LB (Holtburg 0xA9 0xB4) for the per-vertex check.
      const centre = out.perLb.find((p) => p.lbX === 0xa9 && p.lbY === 0xb4);
      out.centre = centre;
      out.initOk = true;
    } catch (e) {
      out.error = String(e?.message ?? e);
      out.errorStack = String(e?.stack ?? "").slice(0, 1200);
    }
    return out;
  }, BUILD_TIMEOUT_MS);

  console.log(`[visfid-p21] [subdiv=${level}] probe:`, JSON.stringify(probe, null, 2));

  if (!probe.initOk) {
    console.error(`FAIL [subdiv=${level}]: init3D failed: ${probe.error}`);
    if (probe.errorStack) console.error(probe.errorStack);
    await browser.close();
    return { ok: false, fpath: null, reason: probe.error, probe };
  }

  // Camera flyover: aim at a Holtburg hillside. The cameraSwitcher's
  // per-tick positionCamera() overrides our manual placement on every
  // frame, so we monkey-patch the tick to a no-op so the screenshot
  // captures the camera we set. Restore semantics aren't needed because
  // the browser is torn down right after the screenshot.
  await page.evaluate(() => {
    const live = window.liveScene3d;
    if (!live) return;
    const acToThree = (x, y, z) => [x, z, -y];
    const M = 192;
    // Steep-LB corner: 0xAA, 0xB3 — has 50-116 m range per probe.
    const HILL_X = 0xaa;
    const HILL_Y = 0xb3;
    const fx = HILL_X * M + M / 2;
    const fy = HILL_Y * M + M / 2;
    const camera = live.cameraSwitcher?.activeCamera || live.camera;
    if (!camera) return;
    // Silence the per-tick camera updater.
    if (live.cameraSwitcher) {
      live.cameraSwitcher.positionCamera = () => {};
      live.cameraSwitcher.tick = () => {};
    }
    // Looking eastward at the hillside silhouette from a low,
    // off-LB vantage so the terrain ridge fills the viewport with no
    // foreground building occlusion. The 0xAA, 0xB3 LB has 66 m of
    // elevation across 192 m, the steepest hill in the visible ring.
    // Stand to the south-west of that LB at 100 m up and look NE.
    const eyeX = fx - 300;
    const eyeY = fy - 100;
    const eyeZ = 100;
    camera.position.set(...acToThree(eyeX, eyeY, eyeZ));
    camera.lookAt(...acToThree(fx, fy + 50, 80));
  });

  await page.waitForTimeout(RENDER_WAIT_MS);

  const canvasHandle = await page.$("#scene, canvas");
  if (canvasHandle) {
    await canvasHandle.screenshot({ path: fpath, type: "png" });
  } else {
    await page.screenshot({ path: fpath, type: "png" });
  }
  console.log(`[visfid-p21] [subdiv=${level}] screenshot → ${fpath}`);

  await browser.close();
  return { ok: true, fpath, probe, consoleErrors };
}

(async () => {
  const results = {};
  for (const level of [1, 2, 4]) {
    results[level] = await captureOne(level);
  }

  console.log("=========================");
  console.log("Phase 2.1 capture summary:");
  for (const level of [1, 2, 4]) {
    const r = results[level];
    console.log(
      `  subdiv=${level}: ok=${r.ok}, file=${r.fpath ? path.basename(r.fpath) : "(none)"}, ` +
        `subdivLevel=${r.probe?.subdivLevel}, ` +
        `centreVerts=${r.probe?.centre?.vertexCount}, ` +
        `centreSubdiv=${r.probe?.centre?.subdivLevel}, ` +
        `errors=${r.consoleErrors ?? 0}`
    );
  }

  let failures = 0;
  function check(name, ok, detail) {
    const status = ok ? "OK" : "FAIL";
    console.log(`  [${status}] ${name}${detail ? " — " + detail : ""}`);
    if (!ok) failures += 1;
  }

  check("subdiv=1 captured", results[1].ok);
  check("subdiv=2 captured", results[2].ok);
  check("subdiv=4 captured", results[4].ok);
  check(
    "subdiv=1 → subdivLevel === 1",
    results[1].probe?.subdivLevel === 1,
    `actual=${results[1].probe?.subdivLevel}`
  );
  check(
    "subdiv=2 → subdivLevel === 2",
    results[2].probe?.subdivLevel === 2,
    `actual=${results[2].probe?.subdivLevel}`
  );
  check(
    "subdiv=4 → subdivLevel === 4",
    results[4].probe?.subdivLevel === 4,
    `actual=${results[4].probe?.subdivLevel}`
  );
  // Centre LB vertex count: factor=1 → 81; factor=2 → 17²=289; factor=4 → 33²=1089.
  check(
    "subdiv=1 centre 81 verts (no subdivision path)",
    results[1].probe?.centre?.vertexCount === 81,
    `actual=${results[1].probe?.centre?.vertexCount}`
  );
  check(
    "subdiv=2 centre 289 verts (17² subdivided)",
    results[2].probe?.centre?.vertexCount === 289,
    `actual=${results[2].probe?.centre?.vertexCount}`
  );
  check(
    "subdiv=4 centre 1089 verts (33² subdivided)",
    results[4].probe?.centre?.vertexCount === 1089,
    `actual=${results[4].probe?.centre?.vertexCount}`
  );

  // LOD ramp: at subdiv=4, the centre LB has subdivLevel=4, the outer
  // ring LBs have subdivLevel=2 (max(1, 4/2)).
  if (results[4].ok && results[4].probe?.perLb) {
    const outer = results[4].probe.perLb.filter(
      (p) => !(p.lbX === 0xa9 && p.lbY === 0xb4)
    );
    const outerSubdivs = outer.map((p) => p.subdivLevel);
    const allOuterAre2 = outerSubdivs.every((s) => s === 2);
    check(
      "subdiv=4 outer ring LOD-ramped to subdiv=2",
      allOuterAre2,
      `outerSubdivs=${JSON.stringify(outerSubdivs)}`
    );
  }

  console.log(`Total failures: ${failures}`);
  process.exit(failures > 0 ? 1 : 0);
})().catch((e) => {
  console.error("CRASH:", e);
  process.exit(2);
});
