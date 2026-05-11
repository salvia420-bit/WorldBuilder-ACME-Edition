// Phase 7.5 capture script — drives `init3D` against real Holtburg
// wasm exports and asserts the CameraSwitcher + camera-relative WASD
// + 2D drainEvents-to-3D entity-hook forwarding.
//
// Mirrors Phase 7.4b mode 1 (standalone init3D, no login required) —
// the live-ACE round-trip is intentionally NOT required because the
// Phase 7.4b mode 2 hit a 60s login timeout in CI on the previous
// run, and the camera-math validation doesn't need a real wire
// stream. The synthetic ESM test (`test_phase7_5_camera.mjs`) is the
// load-bearing math proof; this capture closes the loop by:
//
//   1. Spinning init3D against real wasm exports.
//   2. Verifying liveScene3d.cameraSwitcher is present + mode='follow'
//      + activeCamera === liveScene3d.camera.
//   3. Programmatically switching the camera via
//      window.liveScene3d.cameraSwitcher.switchMode('orbit') →
//      switchMode('topDown') → switchMode('follow') and asserting the
//      activeCamera flips between persp and ortho on each switch.
//   4. Replacing sessionHandle.setMovementInput with a recording
//      stub, simulating a WASD keydown, and verifying the next tick
//      forwards the camera-relative call.
//   5. Verifying window.__scene3dEntityHook is installed and accepts
//      both a single update and an array (the 2D forward wires the
//      array form).
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
//   node capture_phase7_5_camera.cjs

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
    process.env.PHASE75_PAGE_URL ||
    "http://100.116.47.66:8765/apps/holtburger-web/index.html?renderer=3d";
  const SMOKE_TIMEOUT_MS = Number(
    process.env.PHASE75_SMOKE_TIMEOUT_MS || 60_000
  );
  const BUILD_TIMEOUT_MS = Number(
    process.env.PHASE75_BUILD_TIMEOUT_MS || 180_000
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
    if (msg.type() === "error") {
      consoleErrors += 1;
      const text = msg.text();
      console.log(`[browser error] ${text}`);
      if (consoleErrorMessages.length < 10) consoleErrorMessages.push(text);
    } else if (msg.type() === "log") {
      const text = msg.text();
      if (
        /\[phase7\.5|cameraSwitcher|7\.5/.test(text)
      ) {
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
    cameraSwitcherPresent: false,
    initialMode: null,
    initialActiveIsPersp: false,
    orbitSwitchOk: false,
    topDownSwitchOk: false,
    topDownActiveIsOrtho: false,
    followSwitchOk: false,
    setMovementInputCallCount: 0,
    setMovementInputCallSample: null,
    entityHookPresent: false,
    entityHookAcceptsArray: false,
    entityHookAcceptsSingle: false,
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

    console.log("--- standalone init3D + CameraSwitcher ---");
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
        out.steps.push(
          `wasm loaded; kf=${typeof wasmMod.fetchEntityAnimationKeyframes}, ` +
          `mr=${typeof wasmMod.fetchEntityModelRender}`
        );

        const scene3d = await import("./scene3d/index.js");
        out.steps.push(`scene3d: init3D=${typeof scene3d.init3D}`);

        // Build a recording sessionHandle mock. The CameraSwitcher
        // calls `setMovementInput` whenever the keystate-derived
        // signature changes. We pre-seed it on window so the camera
        // switcher captures the calls.
        window.__phase75_calls = [];
        const mockSession = {
          setMovementInput(forward, strafe, turn, run) {
            window.__phase75_calls.push({ forward, strafe, turn, run });
          },
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
            setTimeout(
              () => rej(new Error("init3D timeout")),
              BUILD_TIMEOUT
            )
          ),
        ]);
        const tElapsed = (performance.now() - tStart) | 0;
        out.steps.push(`init3D resolved in ${tElapsed} ms`);

        // Assertion 1: cameraSwitcher present + initial mode
        out.cameraSwitcherPresent = !!live.cameraSwitcher;
        out.initialMode = live.cameraSwitcher?.mode;
        out.initialActiveIsPersp =
          live.cameraSwitcher?.activeCamera === live.camera;
        out.steps.push(
          `cameraSwitcher: ${!!live.cameraSwitcher}, mode=${live.cameraSwitcher?.mode}, active===camera=${live.cameraSwitcher?.activeCamera === live.camera}`
        );

        // Assertion 2: programmatic mode switches
        try {
          live.cameraSwitcher.switchMode("orbit");
          out.orbitSwitchOk =
            live.cameraSwitcher.mode === "orbit" &&
            live.cameraSwitcher.activeCamera === live.camera; // orbit uses persp too
          out.steps.push(
            `after switchMode('orbit'): mode=${live.cameraSwitcher.mode}, active===camera=${live.cameraSwitcher.activeCamera === live.camera}`
          );

          live.cameraSwitcher.switchMode("topDown");
          out.topDownSwitchOk = live.cameraSwitcher.mode === "topDown";
          out.topDownActiveIsOrtho =
            live.cameraSwitcher.activeCamera === live.orthoCamera;
          out.steps.push(
            `after switchMode('topDown'): mode=${live.cameraSwitcher.mode}, active===ortho=${live.cameraSwitcher.activeCamera === live.orthoCamera}`
          );

          live.cameraSwitcher.switchMode("follow");
          out.followSwitchOk =
            live.cameraSwitcher.mode === "follow" &&
            live.cameraSwitcher.activeCamera === live.camera;
          out.steps.push(
            `after switchMode('follow'): mode=${live.cameraSwitcher.mode}, active===camera=${live.cameraSwitcher.activeCamera === live.camera}`
          );
        } catch (e) {
          out.modeSwitchError = String(e?.message ?? e).slice(0, 200);
        }

        // Assertion 3: drive a synthetic WASD keystate → setMovementInput
        // forwards camera-relative directions. We DON'T use real
        // keyboard events here (focus on canvas may not be guaranteed
        // in headless); instead poke keys directly + tick the switcher
        // manually, the same way the real rAF loop does.
        window.__phase75_calls.length = 0;
        live.cameraSwitcher.followYaw = 0;
        live.cameraSwitcher.keys.w = true;
        live.cameraSwitcher.lastInputSig = "STALE"; // force re-fire
        live.cameraSwitcher.tick(0.016);
        const yaw0Call = window.__phase75_calls[window.__phase75_calls.length - 1];

        window.__phase75_calls.length = 0;
        live.cameraSwitcher.followYaw = Math.PI / 2;
        live.cameraSwitcher.lastInputSig = "STALE";
        live.cameraSwitcher.tick(0.016);
        const yawPi2Call = window.__phase75_calls[window.__phase75_calls.length - 1];

        // Clear W (so the tick after this doesn't keep firing).
        live.cameraSwitcher.keys.w = false;

        out.setMovementInputCallCount = window.__phase75_calls.length + 2; // 2 captured above + remaining
        out.setMovementInputCallSample = {
          yaw0: yaw0Call,
          yawPi2: yawPi2Call,
        };
        out.steps.push(
          `setMovementInput at yaw=0:    ${JSON.stringify(yaw0Call)}`
        );
        out.steps.push(
          `setMovementInput at yaw=π/2:  ${JSON.stringify(yawPi2Call)}`
        );

        // Assertion 4: __scene3dEntityHook is installed + accepts
        // both array and single-event forms.
        out.entityHookPresent = typeof window.__scene3dEntityHook === "function";
        if (out.entityHookPresent) {
          // Single-event form: synthetic kind=2 REMOVE (cheapest dispatch).
          try {
            window.__scene3dEntityHook({ kind: 2, guid: 0xdeadbeef });
            out.entityHookAcceptsSingle = true;
          } catch (e) {
            out.entityHookAcceptsSingle = false;
            out.entityHookSingleErr = String(e?.message ?? e).slice(0, 160);
          }
          // Array form: synthetic 2-element array.
          try {
            window.__scene3dEntityHook([
              { kind: 2, guid: 0xdeadbeee },
              { kind: 2, guid: 0xdeadbeed },
            ]);
            out.entityHookAcceptsArray = true;
          } catch (e) {
            out.entityHookAcceptsArray = false;
            out.entityHookArrayErr = String(e?.message ?? e).slice(0, 160);
          }
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
  console.log("Phase 7.5 capture result:", JSON.stringify(result, null, 2));
  console.log("=========================");

  let failures = 0;
  function check(name, ok, detail) {
    const status = ok ? "OK" : "FAIL";
    console.log(`  [${status}] ${name}${detail ? " — " + detail : ""}`);
    if (!ok) failures += 1;
  }

  check(
    "Phase 7.5: init3D() resolved without error",
    result.initOk,
    result.error ? `error=${result.error}` : ""
  );
  check(
    "Phase 7.5: liveScene3d.cameraSwitcher present",
    result.cameraSwitcherPresent
  );
  check(
    "Phase 7.5: initial mode is 'follow'",
    result.initialMode === "follow",
    `mode=${result.initialMode}`
  );
  check(
    "Phase 7.5: initial activeCamera is the PerspectiveCamera",
    result.initialActiveIsPersp
  );
  check(
    "Phase 7.5: switchMode('orbit') flips state",
    result.orbitSwitchOk
  );
  check(
    "Phase 7.5: switchMode('topDown') flips state",
    result.topDownSwitchOk
  );
  check(
    "Phase 7.5: top-down active camera === OrthographicCamera",
    result.topDownActiveIsOrtho
  );
  check(
    "Phase 7.5: switchMode('follow') restores PerspectiveCamera",
    result.followSwitchOk
  );

  // Camera-relative WASD math — the load-bearing assertion. At yaw=0,
  // W should produce forward=+1, strafe=0. At yaw=π/2, W should
  // produce forward=0, strafe=+1.
  const yaw0 = result.setMovementInputCallSample?.yaw0;
  const yawPi2 = result.setMovementInputCallSample?.yawPi2;
  check(
    "Phase 7.5: W + yaw=0 → setMovementInput(forward=+1, strafe=0, ...)",
    yaw0 && yaw0.forward === 1 && yaw0.strafe === 0,
    `call=${JSON.stringify(yaw0)}`
  );
  check(
    "Phase 7.5: W + yaw=π/2 → setMovementInput(forward=0, strafe=+1, ...) (camera-east = world-east strafe)",
    yawPi2 && yawPi2.forward === 0 && yawPi2.strafe === 1,
    `call=${JSON.stringify(yawPi2)}`
  );

  check(
    "Phase 7.5: window.__scene3dEntityHook installed",
    result.entityHookPresent
  );
  check(
    "Phase 7.5: __scene3dEntityHook accepts single-event form (legacy)",
    result.entityHookAcceptsSingle
  );
  check(
    "Phase 7.5: __scene3dEntityHook accepts array form (Phase 7.5 wire)",
    result.entityHookAcceptsArray
  );

  check(
    "Phase 7.5: zero browser console errors",
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
    console.log("PASS: all Phase 7.5 capture checks green.");
    process.exit(0);
  }
})().catch((err) => {
  console.error("capture failed:", err);
  process.exit(1);
});
