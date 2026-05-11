// Phase 7.7 capture script — proves three.js frustum culling is
// actually doing useful work by sampling `renderer.info.render.calls`
// in two configurations:
//
//   A. Camera at Holtburg LB centre, +200 m up, looking down at the
//      heightfield. All 9 terrain LBs + 16 buildings + statics are in
//      view → many draw calls.
//
//   B. Camera teleported to (100_000, 100_000, 200) m looking at
//      (200_000, 200_000, 200) — far outside any landblock the scene
//      builders populated. NOTHING in `worldRoot` is inside the
//      frustum → three.js's per-Mesh boundingSphere check should
//      reject the vast majority of draw calls.
//
// Pass criteria: `awayCalls < holtCalls * 0.5` — a 50% reduction
// floor. In practice the reduction is much higher (closer to 95%+)
// because every culled `Mesh` is one fewer draw call AND most of the
// scene's meshes lie within a 600×600 m square around Holtburg, while
// the empty-space camera is 100 km away.
//
// If the reduction is < 50%, something is broken — likely a Mesh with
// `frustumCulled = false`, a missing `computeBoundingSphere()`, or a
// shader/material that's bypassing culling somehow. The capture
// reports both numbers so the human reading the output can see how
// far short we are if the assertion fails.
//
// Mirrors the Phase 7.6 mode-1 standalone pattern: mock SessionHandle,
// real wasm exports, no live ACE login required.
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
//   node capture_phase7_7_frustum.cjs

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
    process.env.PHASE77_PAGE_URL ||
    "http://100.116.47.66:8765/apps/holtburger-web/index.html?renderer=3d";
  const SMOKE_TIMEOUT_MS = Number(
    process.env.PHASE77_SMOKE_TIMEOUT_MS || 60_000
  );
  const BUILD_TIMEOUT_MS = Number(
    process.env.PHASE77_BUILD_TIMEOUT_MS || 180_000
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
  const consoleErrorMessages = [];
  page.on("console", (msg) => {
    const text = msg.text();
    if (msg.type() === "error") {
      consoleErrors += 1;
      console.log(`[browser error] ${text}`);
      if (consoleErrorMessages.length < 10) consoleErrorMessages.push(text);
    } else if (msg.type() === "log") {
      if (/\[phase7\.7|frustum/i.test(text)) {
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
    sceneMeshTotal: 0,
    holtCalls: 0,
    holtTriangles: 0,
    awayCalls: 0,
    awayTriangles: 0,
    reductionPct: 0,
    frustumCulledOnAllMeshes: false,
    meshesMissingBoundingSphere: -1,
    terrainLbCount: 0,
    buildingsChildCount: 0,
    envCellCount: 0,
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

    console.log("--- standalone init3D + frustum probe ---");
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

        // Mock session — minimum API surface scene3d touches during
        // init3D + per-frame tick (cell-visibility BFS, lighting,
        // camera, entity drain). Returning empty arrays / 0 is
        // sufficient: nothing here drives behaviour we measure.
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

        // Snapshot scene shape so the human reading the result can
        // compare against the Phase 7.6 / earlier-invariant numbers.
        out.terrainLbCount = live.terrainGroup?.children?.length ?? 0;
        out.buildingsChildCount = live.buildingsGroup?.children?.length ?? 0;
        out.envCellCount = live.cellContainers3d?.size ?? 0;

        // Walk the whole scene graph and confirm every Mesh has
        // frustumCulled=true (three.js default) AND every geometry has
        // a boundingSphere computed. This is the static audit half —
        // the numerical measurement below is the dynamic half.
        let meshTotal = 0;
        let withFrustumCulled = 0;
        let missingBoundingSphere = 0;
        const meshesMissingBoundingSphereSamples = [];
        live.scene.traverse((obj) => {
          if (obj.isMesh) {
            meshTotal += 1;
            if (obj.frustumCulled === true) withFrustumCulled += 1;
            const bs = obj.geometry?.boundingSphere;
            if (!bs || !Number.isFinite(bs.radius) || bs.radius === 0) {
              missingBoundingSphere += 1;
              if (meshesMissingBoundingSphereSamples.length < 5) {
                meshesMissingBoundingSphereSamples.push(
                  `${obj.name || "(unnamed)"} (geom.type=${obj.geometry?.type ?? "?"})`
                );
              }
            }
          }
        });
        out.sceneMeshTotal = meshTotal;
        out.frustumCulledOnAllMeshes =
          meshTotal > 0 && withFrustumCulled === meshTotal;
        out.meshesMissingBoundingSphere = missingBoundingSphere;
        out.meshesMissingBoundingSphereSamples = meshesMissingBoundingSphereSamples;
        out.steps.push(
          `scene mesh total=${meshTotal}, frustumCulled=${withFrustumCulled}/${meshTotal}, missingBoundingSphere=${missingBoundingSphere}`
        );

        // The renderer is the live one constructed by init3D. The rAF
        // loop is still running (we deliberately do NOT call
        // live.stop()) so the renderer's GL state stays warm. To stop
        // the cameraSwitcher's per-tick position override (which
        // resets the camera to "behind the player" every frame) we
        // override its `tick` to a no-op. The loop guards this with
        // typeof checks, so a no-op is safe.
        if (live.cameraSwitcher) {
          live.cameraSwitcher.tick = () => {};
        }
        await new Promise((r) => requestAnimationFrame(r));

        const perspCam = live.camera; // PerspectiveCamera
        if (!perspCam) {
          out.error = "live.camera missing";
          return out;
        }

        const renderer = live.renderer;
        if (!renderer || !renderer.info) {
          out.error = "live.renderer.info missing";
          return out;
        }
        // three.js defaults `renderer.info.autoReset = true` which
        // zeroes the counters at the START of every `render()` call —
        // so a post-frame read of `info.render.calls` reflects ONLY
        // the most recent render (which is the rAF-loop's render).
        // That's exactly what we want: each rAF, the loop runs
        // `renderer.render(scene, activeCam)`; after that completes,
        // `info.render.calls` is THAT frame's count. We just need to
        // wait for the loop to tick a few frames with the camera
        // pointed where we want.
        out.steps.push(
          `renderer: ${renderer.constructor.name}, autoReset=${renderer.info.autoReset}, domElement=${renderer.domElement.width}x${renderer.domElement.height}`
        );

        // Sanity: count visible meshes. cellsGroup defaults to hidden
        // (no cell BFS has run on a real cellId), so the visible
        // count is terrain (9) + buildings (~50) + statics (~280) +
        // hellocube (1).
        let visibleMeshes = 0;
        live.scene.traverse((o) => {
          if (o.isMesh && o.visible) {
            let p = o.parent;
            let hidden = false;
            while (p) { if (!p.visible) { hidden = true; break; } p = p.parent; }
            if (!hidden) visibleMeshes += 1;
          }
        });
        out.visibleMeshes = visibleMeshes;
        out.steps.push(`visible meshes (cell BFS not run): ${visibleMeshes}`);

        // Coordinate convention: `worldRoot` carries
        // `rotation.x = -π/2` (scene3d/index.js:51), converting child
        // local AC (x,y,z) → three.js world (x, z, -y). Cameras live
        // OUTSIDE worldRoot and use three.js world coords. To put the
        // camera at AC `(ax, ay, az)` looking at AC `(bx, by, bz)`,
        // map both to three.js world coords:
        //   cam.position.set(ax, az, -ay)
        //   cam.lookAt(bx, bz, -by)
        // This is the same rotation worldRoot applies to its children.
        function acToThree(ax, ay, az) {
          return [ax, az, -ay];
        }

        // Sanity: render directly using an ad-hoc camera at the
        // Holtburg centre, both with and without the AC→three.js
        // rotation, to verify the rotation is required.
        const HCX = 0xa9 * 192 + 96;
        const HCY = 0xb4 * 192 + 96;
        renderer.info.autoReset = false;

        // Naive (AC coords passed straight to three) — should fail.
        const naiveCam = perspCam.clone(true);
        naiveCam.position.set(HCX, HCY, 200);
        naiveCam.lookAt(HCX, HCY, 80);
        naiveCam.updateMatrixWorld(true);
        renderer.info.reset();
        renderer.render(live.scene, naiveCam);
        out.naiveCallsHolt = renderer.info.render.calls;

        // Correctly mapped via AC→three.js rotation.
        const properCam = perspCam.clone(true);
        const [px, py, pz] = acToThree(HCX, HCY, 200);
        const [tx, ty, tz] = acToThree(HCX, HCY, 80);
        properCam.position.set(px, py, pz);
        properCam.lookAt(tx, ty, tz);
        properCam.updateMatrixWorld(true);
        renderer.info.reset();
        renderer.render(live.scene, properCam);
        out.properCallsHolt = renderer.info.render.calls;
        out.properTrisHolt = renderer.info.render.triangles;
        out.steps.push(
          `naive AC-coords cam @ Holtburg: calls=${out.naiveCallsHolt} | ` +
          `properly mapped cam @ Holtburg three(${px.toFixed(0)},${py.toFixed(0)},${pz.toFixed(0)}): ` +
          `calls=${out.properCallsHolt}, tris=${out.properTrisHolt}`
        );
        renderer.info.autoReset = true;

        // Probe a real visible mesh's world position so the output
        // makes the worldRoot rotation visible to any future reader.
        let probeMesh = null;
        live.scene.traverse((o) => {
          if (probeMesh) return;
          if (o.isMesh && o.visible) {
            let p = o.parent;
            let hidden = false;
            while (p) { if (!p.visible) { hidden = true; break; } p = p.parent; }
            if (!hidden) probeMesh = o;
          }
        });
        if (probeMesh) {
          const worldPos = probeMesh.getWorldPosition(new perspCam.position.constructor());
          out.probeMeshWorldPos = { x: worldPos.x, y: worldPos.y, z: worldPos.z };
          out.steps.push(
            `probeMesh '${probeMesh.name}' world pos: (${worldPos.x.toFixed(1)}, ${worldPos.y.toFixed(1)}, ${worldPos.z.toFixed(1)}) — confirms worldRoot.rotation.x=-π/2 (AC y→three -z)`
          );
        }

        // === Sample A: camera at Holtburg LB centre, looking down. ===
        // Apply the AC→three.js worldRoot rotation when placing the
        // camera. AC (HCX, HCY, 200) → three.js (HCX, 200, -HCY).
        // Wait several rAF ticks so the loop's renderer.render runs
        // at THIS camera position; `info.render.calls` reflects the
        // most-recent frame (autoReset=true is on for the loop, so
        // each frame's count is fresh).
        const [holtPx, holtPy, holtPz] = acToThree(HCX, HCY, 200);
        const [holtTx, holtTy, holtTz] = acToThree(HCX, HCY, 80);
        for (let i = 0; i < 5; i += 1) {
          perspCam.position.set(holtPx, holtPy, holtPz);
          perspCam.lookAt(holtTx, holtTy, holtTz);
          await new Promise((r) => requestAnimationFrame(r));
        }
        out.holtCalls = renderer.info.render.calls;
        out.holtTriangles = renderer.info.render.triangles;
        out.steps.push(
          `Holtburg view three(${holtPx.toFixed(0)},${holtPy.toFixed(0)},${holtPz.toFixed(0)}) → calls=${out.holtCalls}, triangles=${out.holtTriangles}`
        );

        // === Sample B: camera at three.js world (100km, 100km, 100km),
        // looking at three.js world (200km, 200km, 200km). Both well
        // outside any landblock's three.js world position. The
        // far-plane is 5000 m (scene3d/index.js:90), and the entire
        // visible scene occupies ~600 m around three world
        // (~32500, ~50, ~-34600). 100 km away in three world is
        // definitively beyond the frustum for every Mesh.
        const AWAY_X = 100_000;
        const AWAY_Y = 100_000;
        const AWAY_Z = 100_000;
        for (let i = 0; i < 5; i += 1) {
          perspCam.position.set(AWAY_X, AWAY_Y, AWAY_Z);
          perspCam.lookAt(AWAY_X + 100_000, AWAY_Y + 100_000, AWAY_Z + 100_000);
          await new Promise((r) => requestAnimationFrame(r));
        }
        out.awayCalls = renderer.info.render.calls;
        out.awayTriangles = renderer.info.render.triangles;
        out.steps.push(
          `Away view three(${AWAY_X}, ${AWAY_Y}, ${AWAY_Z}) → calls=${out.awayCalls}, triangles=${out.awayTriangles}`
        );

        if (out.holtCalls > 0) {
          const reduction = 1 - out.awayCalls / out.holtCalls;
          out.reductionPct = +(reduction * 100).toFixed(1);
          out.steps.push(`reduction=${out.reductionPct}%`);
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
  } catch (e) {
    console.error("FAIL: capture threw:", e?.message ?? e);
    await browser.close();
    process.exit(1);
  }

  console.log("=========================");
  console.log("Phase 7.7 capture result:", JSON.stringify(result, null, 2));
  console.log("=========================");

  let failures = 0;
  function check(name, ok, detail) {
    const status = ok ? "OK" : "FAIL";
    console.log(`  [${status}] ${name}${detail ? " — " + detail : ""}`);
    if (!ok) failures += 1;
  }

  check(
    "Phase 7.7: init3D() resolved without error",
    result.initOk,
    result.error ? `error=${result.error}` : ""
  );
  check(
    "Phase 7.7 / earlier-invariant: terrainGroup has 9 LBs (Holtburg neighbourhood)",
    result.terrainLbCount === 9,
    `count=${result.terrainLbCount}`
  );
  check(
    "Phase 7.7 / earlier-invariant: buildingsGroup populated",
    result.buildingsChildCount > 0,
    `count=${result.buildingsChildCount}`
  );
  check(
    "Phase 7.7 / earlier-invariant: EnvCells loaded",
    result.envCellCount > 0,
    `count=${result.envCellCount}`
  );

  // Static audit half.
  check(
    "Phase 7.7: every Mesh in the scene graph has frustumCulled=true",
    result.frustumCulledOnAllMeshes,
    `total=${result.sceneMeshTotal}`
  );
  check(
    "Phase 7.7: every Mesh's BufferGeometry has a non-zero boundingSphere",
    result.meshesMissingBoundingSphere === 0,
    `missing=${result.meshesMissingBoundingSphere}` +
      (result.meshesMissingBoundingSphereSamples?.length
        ? ` samples=${JSON.stringify(result.meshesMissingBoundingSphereSamples)}`
        : "")
  );

  // Dynamic half — the actual numerical proof.
  check(
    "Phase 7.7: Holtburg view produces >0 draw calls",
    result.holtCalls > 0,
    `calls=${result.holtCalls}`
  );
  check(
    "Phase 7.7: away view produces fewer draw calls than Holtburg",
    result.awayCalls < result.holtCalls,
    `away=${result.awayCalls}, holt=${result.holtCalls}`
  );
  check(
    "Phase 7.7: away view culls >= 50% of draw calls vs Holtburg (frustum culling works)",
    result.holtCalls > 0 && result.awayCalls < result.holtCalls * 0.5,
    `away=${result.awayCalls}, holt=${result.holtCalls}, reduction=${result.reductionPct}%`
  );

  check(
    "Phase 7.7: zero browser console errors",
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
    console.log("PASS: all Phase 7.7 capture checks green.");
    process.exit(0);
  }
})().catch((err) => {
  console.error("capture failed:", err);
  process.exit(1);
});
