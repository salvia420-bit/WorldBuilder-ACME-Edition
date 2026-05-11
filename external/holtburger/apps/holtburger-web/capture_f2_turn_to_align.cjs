// Follow-on #2 (2026-05-10) capture — drives `init3D` against real
// Holtburg wasm exports and verifies the turn-to-align math under
// the live CameraSwitcher (not just the synthetic ESM test). Mirrors
// the Phase 7.5 capture's mode-1 standalone pattern: mocks
// `sessionHandle.setMovementInput`, programmatically primes the
// CameraSwitcher with a known (followYaw, playerHeading), pokes WASD,
// ticks one frame, asserts the recorded turn value.
//
// We can't drive the player heading via wire packets in mode-1 (the
// EntityManager.getLocalPlayerHeading reads from `inst.root.quaternion`,
// which only changes after a Spawn lands). Instead we install a mock
// `getPlayerHeading` override on the CameraSwitcher instance so the
// test is fully controllable.
//
// Pre-reqs:
//   - Live HTTP server on tailnet1:8765 (or override via FOLLOWON2_PAGE_URL).
//   - Manifest + shards baked under dist/.
//   - Playwright in NODE_PATH or the npx cache.
//
// Run from `apps/holtburger-web/`:
//   NODE_PATH=/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules \
//     node capture_f2_turn_to_align.cjs

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
    process.env.FOLLOWON2_PAGE_URL ||
    "http://100.116.47.66:8765/apps/holtburger-web/index.html?renderer=3d";
  const SMOKE_TIMEOUT_MS = Number(
    process.env.FOLLOWON2_SMOKE_TIMEOUT_MS || 60_000
  );
  const BUILD_TIMEOUT_MS = Number(
    process.env.FOLLOWON2_BUILD_TIMEOUT_MS || 180_000
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
      if (/\[F#2|turn-to-align|cameraSwitcher/.test(text)) {
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
    samples: null,
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

    console.log("--- standalone init3D + turn-to-align probe ---");
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
          `wasm loaded; kf=${typeof wasmMod.fetchEntityAnimationKeyframes}`
        );

        const scene3d = await import("./scene3d/index.js");
        out.steps.push(`scene3d: init3D=${typeof scene3d.init3D}`);

        window.__f2_calls = [];
        const mockSession = {
          setMovementInput(forward, strafe, turn, run) {
            window.__f2_calls.push({ forward, strafe, turn, run });
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

        const sw = live.cameraSwitcher;
        if (!sw) {
          out.error = "no cameraSwitcher on liveScene3d";
          return out;
        }

        // Override the heading source with a controllable mock so we
        // can drive the test without needing a real player spawn.
        let mockHeading = 0;
        sw.getPlayerHeading = () => mockHeading;

        // Reset keystate.
        for (const k of Object.keys(sw.keys)) sw.keys[k] = false;

        function drive(keys, yaw, heading) {
          for (const k of Object.keys(sw.keys)) sw.keys[k] = false;
          Object.assign(sw.keys, keys);
          sw.followYaw = yaw;
          mockHeading = heading;
          sw.lastInputSig = "STALE";
          window.__f2_calls.length = 0;
          sw.tick(0.016);
          return window.__f2_calls[window.__f2_calls.length - 1] || null;
        }

        const samples = {
          aligned: drive({ w: true }, 0, 0),
          rotateCW: drive({ w: true }, Math.PI / 2, 0),
          rotateCCW: drive({ w: true }, 0, Math.PI / 2),
          idle: drive({}, Math.PI / 2, 0),
          deadZone: drive({ w: true }, 0.02, 0),
          wrapShortCW: drive({ w: true }, -Math.PI + 0.5, Math.PI),
          wrapShortCCW: drive({ w: true }, Math.PI, -Math.PI + 0.5),
          qOverride: drive({ w: true, q: true }, Math.PI / 2, 0),
        };

        // Clear keystate before exiting so future ticks don't keep
        // firing the recorded session handle.
        for (const k of Object.keys(sw.keys)) sw.keys[k] = false;

        out.samples = samples;
        out.steps.push(`samples=${JSON.stringify(samples)}`);
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
  console.log("F#2 capture result:", JSON.stringify(result, null, 2));
  console.log("=========================");

  let failures = 0;
  function check(name, ok, detail) {
    const status = ok ? "OK" : "FAIL";
    console.log(`  [${status}] ${name}${detail ? " — " + detail : ""}`);
    if (!ok) failures += 1;
  }

  const s = result.samples ?? {};
  check(
    "F#2: init3D() resolved without error",
    result.initOk,
    result.error ? `error=${result.error}` : ""
  );
  check(
    "F#2: aligned (heading=yaw=0) + W → turn=0",
    s.aligned && s.aligned.turn === 0,
    `call=${JSON.stringify(s.aligned)}`
  );
  check(
    "F#2: heading=0, yaw=+π/2, W → turn=+1 (CW to align)",
    s.rotateCW && s.rotateCW.turn === 1,
    `call=${JSON.stringify(s.rotateCW)}`
  );
  check(
    "F#2: heading=+π/2, yaw=0, W → turn=-1 (CCW to align)",
    s.rotateCCW && s.rotateCCW.turn === -1,
    `call=${JSON.stringify(s.rotateCCW)}`
  );
  check(
    "F#2: no WASD held + heading mismatch → turn=0 (no auto-turn when idle)",
    s.idle && s.idle.turn === 0,
    `call=${JSON.stringify(s.idle)}`
  );
  check(
    "F#2: within dead zone (0.02 rad) → turn=0 (auto-turn released)",
    s.deadZone && s.deadZone.turn === 0,
    `call=${JSON.stringify(s.deadZone)}`
  );
  check(
    "F#2: wrap-around (heading=π, yaw=-π+0.5) → turn=+1 (short way CW)",
    s.wrapShortCW && s.wrapShortCW.turn === 1,
    `call=${JSON.stringify(s.wrapShortCW)}`
  );
  check(
    "F#2: wrap-around reverse (heading=-π+0.5, yaw=π) → turn=-1 (short way CCW)",
    s.wrapShortCCW && s.wrapShortCCW.turn === -1,
    `call=${JSON.stringify(s.wrapShortCCW)}`
  );
  check(
    "F#2: W+Q with autoTurn=+1 → turn=0 (Q cancels auto-turn; user wins)",
    s.qOverride && s.qOverride.turn === 0,
    `call=${JSON.stringify(s.qOverride)}`
  );

  check(
    "F#2: zero browser console errors",
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
    console.log("PASS: all F#2 turn-to-align capture checks green.");
    process.exit(0);
  }
})().catch((err) => {
  console.error("capture failed:", err);
  process.exit(1);
});
