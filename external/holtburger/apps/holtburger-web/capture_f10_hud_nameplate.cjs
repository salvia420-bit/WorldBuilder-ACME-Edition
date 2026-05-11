// Follow-on #10 capture script — DOM-projected nameplate overlay.
//
// Mirrors the Phase 7.4 / 7.7 mode-1 standalone pattern: drives `init3D`
// against real Holtburg wasm exports inside a real browser, then spawns
// a real entity via EntityManager.spawn() with a real LSD-Partial weenie
// `didStats` setup ID + a name string. Verifies the DOM <div> was
// injected into the page AND that per-frame projection writes sensible
// pixel coordinates onto its style.
//
// Pass criteria:
//   - liveScene3d.nameplateLayer is present (init3D constructed it).
//   - #nameplate-layer-3d DOM div is overlaid on the canvas.
//   - After spawning a real entity with a name, the layer's `nodes` map
//     contains its GUID AND a per-GUID <div> is in the DOM tree with
//     `textContent === meta.name`.
//   - After ticking the rAF loop, the per-entity <div> has non-zero
//     `style.left` / `style.top` AND `display: block` (entity is in
//     camera view) — or `display: none` (behind camera). The test
//     positions the camera so the entity IS in view.
//   - Zero browser console errors during the run.
//
// Standalone mode-1 only — no live ACE login needed. Real wasm DAT
// data, real three.js, real DOM.
//
// Pre-reqs:
//   - Live HTTP server at http://100.116.47.66:8765
//   - Manifest+shards baked under dist/.
//   - Playwright in NODE_PATH or
//     /home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules.
//
// Run from `apps/holtburger-web/`:
//   NODE_PATH=/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules \
//   node capture_f10_hud_nameplate.cjs

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
    process.env.F10_PAGE_URL ||
    "http://100.116.47.66:8765/apps/holtburger-web/index.html?renderer=3d";
  const SMOKE_TIMEOUT_MS = Number(process.env.F10_SMOKE_TIMEOUT_MS || 60_000);
  const BUILD_TIMEOUT_MS = Number(process.env.F10_BUILD_TIMEOUT_MS || 180_000);

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
      if (/\[scene3d\]|nameplate|follow-on#10/i.test(text)) {
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
    layerPresent: false,
    overlayDivInDom: false,
    overlayDivOnCanvasParent: false,
    spawned: false,
    nameInMap: false,
    nameplateInDom: false,
    nameplateText: "",
    perFrameProjectedPixels: false,
    leftPx: -1,
    topPx: -1,
    displayAfterTick: "",
    hiddenWhenBehind: false,
    removedAfterRemove: false,
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

    console.log("--- standalone init3D + nameplate probe ---");
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

        // Real wasm exports — same set the Phase 7.4b capture uses.
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

        // Mock session — same shape Phase 7.7 mode-1 uses.
        const mockSession = {
          isCurrentCellIndoor() { return false; },
          getCurrentCellId() { return 0; },
          getRenderSet() { return new Uint32Array(0); },
          setMovementInput() {},
          pollEntityUpdates() { return []; },
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

        // === Step 1: layer + overlay DOM div =========================
        out.layerPresent = !!live.nameplateLayer;
        const overlayDiv = document.getElementById("nameplate-layer-3d");
        out.overlayDivInDom = !!overlayDiv;
        out.overlayDivOnCanvasParent =
          !!overlayDiv && overlayDiv.parentElement === canvas.parentElement;
        out.steps.push(
          `layerPresent=${out.layerPresent}, overlayInDom=${out.overlayDivInDom}, ` +
          `overlayOnCanvasParent=${out.overlayDivOnCanvasParent}`
        );

        // Stop the camera switcher's per-tick override so our manual
        // camera position survives across rAF ticks (the camera switcher
        // resets the camera every frame in follow mode).
        if (live.cameraSwitcher) {
          live.cameraSwitcher.tick = () => {};
        }
        await new Promise((r) => requestAnimationFrame(r));

        // === Step 2: spawn a real entity with a name ================
        // Use Sparring Golem — same setup the Phase 7.4 capture's
        // fallback chain picks first. Real LSD-Partial weenie didStats
        // IDs (setup 0x020007cc, mtable 0x09000081). 21 parts / 60-frame
        // walk @ 30 fps. Name comes from the LSD weenie name; using
        // "Sparring Golem" as a sensible default test string.
        const TEST_GUID = 0xdeadc0de;
        const TEST_NAME = "Sparring Golem";
        const meta = {
          guid: TEST_GUID,
          modelId: 0x020007cc,
          landblockId: 0xa9b40001 >>> 0,
          x: 96, y: 96, z: 80,
          qw: 1, qx: 0, qy: 0, qz: 0,
          paletteId: 0,
          mtableId: 0x09000081,
          motionCommand: 0,
          motionStance: 0,
          objScale: 1.0,
          name: TEST_NAME,
          wcid: 12698,
          itemType: 0x10,
          iconId: 0,
          modelChanges: new Uint32Array(0),
          textureChanges: new Uint32Array(0),
          subPalettes: new Uint32Array(0),
        };
        const spawnedInst = await live.entityManager.spawn(meta);
        out.spawned = !!(spawnedInst && spawnedInst.parts?.length > 0);
        out.steps.push(
          `spawn: parts=${spawnedInst?.parts?.length ?? 0}, ` +
          `rootName=${spawnedInst?.root?.name}`
        );

        // === Step 3: verify nameplate registered in layer.nodes + DOM
        const layer = live.nameplateLayer;
        out.nameInMap = layer && layer.nodes.has(TEST_GUID >>> 0);
        const nodeEntry = layer?.nodes.get(TEST_GUID >>> 0);
        out.nameplateInDom =
          !!nodeEntry?.el?.parentNode &&
          nodeEntry.el.parentNode.id === "nameplate-layer-3d";
        out.nameplateText = nodeEntry?.el?.textContent ?? "";
        out.steps.push(
          `nameInMap=${out.nameInMap}, nameplateInDom=${out.nameplateInDom}, ` +
          `text="${out.nameplateText}"`
        );

        // === Step 4: position the camera to look directly at the entity
        // so per-frame projection runs visible-side. AC world coords →
        // three.js world coords via the worldRoot.rotation.x = -π/2 map:
        //   ac (x, y, z) → three (x, z, -y)
        // The entity is at AC landblock 0xA9B40001 LB-local (96, 96, 80)
        // → world AC (0xA9*192 + 96, 0xB4*192 + 96, 80) = (32544, 34656,
        // 80). Three.js mapping: (32544, 80, -34656). Place the camera
        // 10 m south + 5 m up + 5 m east of that.
        const acX = 0xa9 * 192 + 96;
        const acY = 0xb4 * 192 + 96;
        const acZ = 80;
        // Match the spawn world position (also adjusted by entityManager
        // via landblockToWorldXY). spawnedInst.root.position is the
        // canonical world AC pos.
        const entAcX = spawnedInst.root.position.x;
        const entAcY = spawnedInst.root.position.y;
        const entAcZ = spawnedInst.root.position.z;
        out.steps.push(
          `entity AC pos = (${entAcX.toFixed(1)}, ${entAcY.toFixed(1)}, ${entAcZ.toFixed(1)})`
        );

        // Camera 10 m south of entity (lower AC Y), 5 m above terrain,
        // looking at entity head height.
        const camAcX = entAcX;
        const camAcY = entAcY - 10;
        const camAcZ = entAcZ + 5;
        // AC → three.js world coords.
        function acToThree(ax, ay, az) { return [ax, az, -ay]; }
        const [camTx, camTy, camTz] = acToThree(camAcX, camAcY, camAcZ);
        const [lookTx, lookTy, lookTz] = acToThree(entAcX, entAcY, entAcZ + 1.5);

        const persp = live.camera; // PerspectiveCamera
        for (let i = 0; i < 8; i += 1) {
          persp.position.set(camTx, camTy, camTz);
          persp.lookAt(lookTx, lookTy, lookTz);
          // Force the matrix update so the very next render uses the
          // freshly-positioned camera.
          persp.updateMatrixWorld(true);
          await new Promise((r) => requestAnimationFrame(r));
        }

        // === Step 5: read style.left / top after the loop's tick ran
        const elAfter = nodeEntry?.el;
        out.leftPx = elAfter ? parseFloat(elAfter.style.left) : -1;
        out.topPx = elAfter ? parseFloat(elAfter.style.top) : -1;
        out.displayAfterTick = elAfter?.style.display ?? "";
        out.perFrameProjectedPixels =
          Number.isFinite(out.leftPx) &&
          Number.isFinite(out.topPx) &&
          out.leftPx > 0 &&
          out.topPx > 0;
        out.steps.push(
          `after-tick: display=${out.displayAfterTick}, ` +
          `left=${elAfter?.style.left}, top=${elAfter?.style.top}, ` +
          `lastTickVisible=${layer?.lastTickVisibleCount}`
        );

        // === Step 6: move camera behind the entity → projection hides
        // Behind = AC north of entity, looking further north (away from
        // entity). Three.js: camera at three +(.z = -(entAcY+10)) looking
        // toward more -z. The Vector3.project for the entity should
        // come out with ndc.z > 1 → display flips to none.
        const behindAcX = entAcX;
        const behindAcY = entAcY + 10; // 10 m north of entity
        const behindAcZ = entAcZ + 5;
        const [bx, by, bz] = acToThree(behindAcX, behindAcY, behindAcZ);
        const [blx, bly, blz] = acToThree(
          entAcX, entAcY + 1000, entAcZ + 5,
        ); // looking even further north (away from entity)
        for (let i = 0; i < 5; i += 1) {
          persp.position.set(bx, by, bz);
          persp.lookAt(blx, bly, blz);
          persp.updateMatrixWorld(true);
          await new Promise((r) => requestAnimationFrame(r));
        }
        out.hiddenWhenBehind =
          (elAfter?.style.display ?? "") === "none" &&
          (layer?.lastTickHiddenBehindCount ?? 0) >= 1;
        out.steps.push(
          `behind-camera: display=${elAfter?.style.display}, ` +
          `hiddenBehindCount=${layer?.lastTickHiddenBehindCount}`
        );

        // === Step 7: remove the entity → nameplate detaches ==========
        live.entityManager.remove(TEST_GUID);
        out.removedAfterRemove =
          !layer?.nodes.has(TEST_GUID >>> 0) &&
          (elAfter ? !elAfter.parentNode || elAfter.parentNode.id !== "nameplate-layer-3d" : true);
        out.steps.push(
          `after-remove: inMap=${layer?.nodes.has(TEST_GUID >>> 0)}, ` +
          `stillChild=${elAfter?.parentNode?.id === "nameplate-layer-3d"}`
        );

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
  console.log("F#10 capture result:", JSON.stringify(result, null, 2));
  console.log("=========================");

  let failures = 0;
  function check(name, ok, detail) {
    const status = ok ? "OK" : "FAIL";
    console.log(`  [${status}] ${name}${detail ? " — " + detail : ""}`);
    if (!ok) failures += 1;
  }

  check(
    "F#10: init3D() resolved without error",
    result.initOk,
    result.error ? `error=${result.error}` : ""
  );
  check(
    "F#10: liveScene3d.nameplateLayer present",
    result.layerPresent
  );
  check(
    "F#10: #nameplate-layer-3d overlay <div> attached to canvas parent",
    result.overlayDivInDom && result.overlayDivOnCanvasParent,
    `inDom=${result.overlayDivInDom}, onCanvasParent=${result.overlayDivOnCanvasParent}`
  );
  check(
    "F#10: real-entity spawn built rig (parts > 0)",
    result.spawned
  );
  check(
    "F#10: nameplate registered in layer.nodes map for entity GUID",
    result.nameInMap
  );
  check(
    "F#10: per-entity nameplate <div> exists in DOM tree under overlay root",
    result.nameplateInDom,
    `text="${result.nameplateText}"`
  );
  check(
    "F#10: nameplate textContent matches entity name from spawn meta",
    result.nameplateText === "Sparring Golem",
    `got="${result.nameplateText}"`
  );
  check(
    "F#10: in-front-of-camera tick projected entity to visible pixel coords",
    result.perFrameProjectedPixels && result.displayAfterTick === "block",
    `display=${result.displayAfterTick}, left=${result.leftPx}, top=${result.topPx}`
  );
  check(
    "F#10: behind-camera tick hides nameplate (display='none', NDC z > 1)",
    result.hiddenWhenBehind,
    `displayAfterBehind=${result.displayAfterTick}`
  );
  check(
    "F#10: entityManager.remove() detaches the DOM nameplate",
    result.removedAfterRemove
  );
  check(
    "F#10: zero browser console errors",
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
    console.log("PASS: all F#10 capture checks green.");
    process.exit(0);
  }
})().catch((err) => {
  console.error("capture failed:", err);
  process.exit(1);
});
