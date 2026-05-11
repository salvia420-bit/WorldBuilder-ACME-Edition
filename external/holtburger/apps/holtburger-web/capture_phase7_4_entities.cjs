// Phase 7.4b capture script — drives `init3D` against real Holtburg
// wasm exports and asserts the EntityManager pipeline.
//
// Two test modes, run sequentially in one Playwright session:
//
//   1. **Standalone init3D** (same shape as
//      capture_phase7_3_envcells.cjs): call init3D from a
//      page-evaluate WITHOUT going through the login flow. This
//      proves the EntityManager wires up correctly and can be
//      driven via the wasm exports against real DAT data. Asserts:
//        - liveScene3d.entityManager is present + has wasmExports.
//        - Direct call to em.spawn(meta) with a real Holtburg setup
//          builds a rig with parts > 0.
//        - em.tick(dt) advances mixer.time on at least one entity.
//        - em.setMotion(walk) installs walk action; setMotion(stop)
//          fades it out; entityMap stays consistent.
//
//   2. **Live ACE drain** (BEST EFFORT): try to login via the page's
//      form using the live tailnet1 stack. If login + spawn complete,
//      install a hook on `pollEntityUpdates` to forward each event
//      to `window.__scene3dEntityHook`, telepoi to Holtburg, drain
//      entities, and assert the EntityManager picked them up.
//      **If login fails, this mode reports SKIP — NOT FAIL.** The
//      pipeline-level proof comes from mode 1; mode 2 is the live-
//      coverage cherry on top.
//
// Pre-reqs:
//   - Live HTTP server: PAGE_URL defaults to
//     http://100.116.47.66:8765/apps/holtburger-web/index.html?renderer=3d
//   - Manifest+shards baked under dist/.
//   - Optional: holtburger-wsbridge + ACE for mode 2.
//   - Playwright in NODE_PATH or
//     /home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules.
//
// Run from `apps/holtburger-web/`:
//   NODE_PATH=/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules \
//   node capture_phase7_4_entities.cjs

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
    process.env.PHASE74_PAGE_URL ||
    "http://100.116.47.66:8765/apps/holtburger-web/index.html?renderer=3d";
  const SMOKE_TIMEOUT_MS = Number(
    process.env.PHASE74_SMOKE_TIMEOUT_MS || 60_000
  );
  const BUILD_TIMEOUT_MS = Number(
    process.env.PHASE74_BUILD_TIMEOUT_MS || 180_000
  );
  const ACCOUNT = process.env.PHASE74_ACCOUNT || "tailnet1";
  const PASSWORD = process.env.PHASE74_PASSWORD || "tailnet1";
  const BRIDGE_URL =
    process.env.PHASE74_BRIDGE_URL || "ws://100.116.47.66:8080/";
  const SERVER_HOST = process.env.PHASE74_SERVER_HOST || "127.0.0.1";
  const SERVER_PORT = process.env.PHASE74_SERVER_PORT || "9000";
  const CHAR_NAME =
    process.env.PHASE74_CHAR_NAME ||
    `Phase74${Date.now().toString(36).slice(-6)}`;
  const LOGIN_TIMEOUT_MS = Number(process.env.PHASE74_LOGIN_TIMEOUT_MS || 20_000);
  const CREATE_TIMEOUT_MS = Number(process.env.PHASE74_CREATE_TIMEOUT_MS || 15_000);
  const SPAWN_TIMEOUT_MS = Number(process.env.PHASE74_SPAWN_TIMEOUT_MS || 30_000);
  const ENTITY_DRAIN_MS = Number(process.env.PHASE74_ENTITY_DRAIN_MS || 12_000);
  const TELEPORT_TIMEOUT_MS = Number(process.env.PHASE74_TELEPORT_TIMEOUT_MS || 8_000);

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
        /\[phase7\.4|phase 7\.4|EntityManager|entity drain|spawn|telepoi|EnteredWorld|InWorld|Spawned/.test(
          text
        )
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

  let mode1 = {
    initOk: false,
    entityManagerPresent: false,
    spawned: false,
    entityRigParts: 0,
    motionSwitchOk: false,
    mixerAdvanced: false,
    error: null,
    errorStack: null,
    setupId: 0,
  };
  let mode2 = {
    skipped: false,
    skippedReason: "",
    loginOk: false,
    spawnOk: false,
    teleportOk: false,
    liveEntities: 0,
    entitiesGroupChildren: 0,
    captureQueueLen: 0,
    captureKindCounts: {},
    entitySample: [],
    entityWithMotion: 0,
    error: null,
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

    // === Mode 1: standalone init3D — same shape as Phase 7.3 capture =
    console.log("--- mode 1: standalone init3D + EntityManager ---");
    const mode1Probe = await page.evaluate(async (BUILD_TIMEOUT) => {
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
        out.steps.push(`wasm loaded; ` +
          `kf=${typeof wasmMod.fetchEntityAnimationKeyframes}, ` +
          `mr=${typeof wasmMod.fetchEntityModelRender}`);

        const scene3d = await import("./scene3d/index.js");
        out.steps.push(`scene3d: init3D=${typeof scene3d.init3D}`);

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
          scene3d.init3D(canvas, null, wasmExports),
          new Promise((_, rej) =>
            setTimeout(
              () => rej(new Error("init3D timeout")),
              BUILD_TIMEOUT
            )
          ),
        ]);
        const tElapsed = (performance.now() - tStart) | 0;
        out.steps.push(`init3D resolved in ${tElapsed} ms`);
        out.windowLiveScene3d = !!window.liveScene3d;
        out.entityManagerPresent = !!live.entityManager;

        // Pick a known-good entity setup that will exercise the
        // EntityManager pipeline end-to-end. The setup/mtable IDs
        // below come from the real LSD weenie JSON's `didStats`:
        //   - key 1 = PropertyDataId.Setup
        //   - key 2 = PropertyDataId.MotionTable
        // Decoded from the v0.9 LSD-Partial weenie dump under
        // `external/LSD-Partial-2025-02-23_16-15/weenies/`. Follow-on
        // #4 (3d-port-state doc) traced the original capture's IDs to
        // synthetic Rust unit-test fixtures (`0x02000099` is the
        // SetupModel ID used inside `triangulate_setup_model_with_*`
        // tests in `lib.rs`); those IDs do not exist in the real DAT.
        // Replaced 2026-05-10.
        //
        // The fallback chain below picks Sparring Golem first (21
        // parts, 60-frame walk @ 30 fps — exercises the full path).
        // Drudge Toiler is the secondary fallback (17 parts, 40-frame
        // walk). Mite Sentry is intentionally LAST: its mtable
        // 0x0900000B legitimately has no WALK_FORWARD cycle (only the
        // Ready idle), so it'd resolve with 0 frames + rest-pose
        // meshes only — fine for rig validation but doesn't exercise
        // the animation path. See `investigate_followon4.cjs` for
        // the cross-check.
        const TEST_GUID = 0xdeadbeef;
        const trySetups = [
          // wcid 12698 — Sparring Golem (real didStats from weenie JSON)
          { setupId: 0x020007cc, mtableId: 0x09000081, label: "SparringGolem" },
          // wcid 30649 — Drudge Toiler (real didStats from weenie JSON)
          { setupId: 0x020007dd, mtableId: 0x09000008, label: "DrudgeToiler" },
          // wcid 945 — Mite Sentry (real didStats; 0 walk frames is expected — see above)
          { setupId: 0x02001080, mtableId: 0x0900000b, label: "MiteSentry" },
        ];
        let pickedSetup = null;
        let spawnedInst = null;
        const WCID_BY_LABEL = {
          SparringGolem: 12698,
          DrudgeToiler: 30649,
          MiteSentry: 945,
        };
        for (const cand of trySetups) {
          const meta = {
            guid: TEST_GUID,
            modelId: cand.setupId,
            landblockId: 0xa9b40001 >>> 0,
            x: 96, y: 96, z: 80,
            qw: 1, qx: 0, qy: 0, qz: 0,
            paletteId: 0,
            mtableId: cand.mtableId,
            motionCommand: 0,
            motionStance: 0,
            objScale: 1.0,
            name: `Test_${cand.label}`,
            wcid: WCID_BY_LABEL[cand.label] ?? 0,
            itemType: 0x10,
            iconId: 0,
            modelChanges: new Uint32Array(0),
            textureChanges: new Uint32Array(0),
            subPalettes: new Uint32Array(0),
          };
          try {
            const inst = await live.entityManager.spawn(meta);
            if (inst && inst.parts && inst.parts.length > 0) {
              pickedSetup = cand;
              spawnedInst = inst;
              out.steps.push(
                `spawn(${cand.label}, setup=0x${cand.setupId.toString(16)}) ` +
                `→ parts=${inst.parts.length}`
              );
              break;
            } else {
              live.entityManager.remove(TEST_GUID);
              out.steps.push(
                `spawn(${cand.label}) returned no parts — trying next`
              );
            }
          } catch (e) {
            out.steps.push(
              `spawn(${cand.label}) threw: ${(e?.message ?? e).toString().slice(0, 80)}`
            );
            try { live.entityManager.remove(TEST_GUID); } catch (_) {}
          }
        }

        out.spawned = !!spawnedInst;
        out.setupId = pickedSetup ? "0x" + pickedSetup.setupId.toString(16) : "0";
        if (spawnedInst) {
          out.entityRigParts = spawnedInst.parts.length;
          out.rootName = spawnedInst.root.name;
          out.parentName = spawnedInst.root.parent?.name;
          out.actionsAfterSpawn = spawnedInst.actions.size;
          out.currentActionAfterSpawn = !!spawnedInst.currentAction;

          // Tick the mixer a few times — should advance time.
          const t0 = spawnedInst.mixer.time;
          for (let i = 0; i < 5; i += 1) {
            live.entityManager.tick(0.05);
          }
          out.mixerTimeAfterTicks = spawnedInst.mixer.time;
          out.mixerAdvanced = spawnedInst.mixer.time > t0;

          // Try motion switches.
          const WALK = 0x4500_0005;
          const RUN = 0x4400_0007;
          const STOP = 0x4500_0004;
          try {
            await live.entityManager.setMotion(TEST_GUID, WALK, 0x003d);
            out.actionsAfterWalk = spawnedInst.actions.size;
            out.currentActionAfterWalk = !!spawnedInst.currentAction;
            // Tick to let crossfade progress.
            for (let i = 0; i < 8; i += 1) {
              live.entityManager.tick(0.05);
            }
            out.actionTimeAfterWalkTicks = spawnedInst.currentAction?.time ?? 0;

            await live.entityManager.setMotion(TEST_GUID, RUN, 0x003d);
            for (let i = 0; i < 8; i += 1) {
              live.entityManager.tick(0.05);
            }
            out.actionsAfterRun = spawnedInst.actions.size;
            out.currentActionAfterRun = !!spawnedInst.currentAction;

            await live.entityManager.setMotion(TEST_GUID, STOP, 0x003d);
            for (let i = 0; i < 8; i += 1) {
              live.entityManager.tick(0.05);
            }
            out.currentActionAfterStop = !!spawnedInst.currentAction;
            out.motionSwitchCount = live.entityManager.motionSwitchCount;
            out.motionSwitchOk = true;
          } catch (e) {
            out.motionSwitchError = (e?.message ?? e).toString().slice(0, 200);
            out.motionSwitchOk = false;
          }
          // Cleanup so mode 2 starts clean.
          try { live.entityManager.remove(TEST_GUID); } catch (_) {}
        }

        // Capture stats.
        out.spawnCount = live.entityManager?.spawnCount ?? 0;
        out.removeCount = live.entityManager?.removeCount ?? 0;
        out.materialCacheSize = live.materialCache?.materials?.size ?? 0;
        out.entitiesGroupChildren = live.entitiesGroup.children.length;
        out.useSharedDrain = !!live.useSharedDrain;
      } catch (e) {
        out.error = String(e?.message ?? e);
        out.errorStack = String(e?.stack ?? "").slice(0, 1200);
      }
      return out;
    }, BUILD_TIMEOUT_MS);
    console.log("mode 1 probe:", JSON.stringify(mode1Probe, null, 2));
    mode1.initOk = !mode1Probe.error;
    mode1.entityManagerPresent = !!mode1Probe.entityManagerPresent;
    mode1.spawned = !!mode1Probe.spawned;
    mode1.entityRigParts = mode1Probe.entityRigParts ?? 0;
    mode1.motionSwitchOk = !!mode1Probe.motionSwitchOk;
    mode1.mixerAdvanced = !!mode1Probe.mixerAdvanced;
    mode1.setupId = mode1Probe.setupId;
    mode1.error = mode1Probe.error;
    mode1.errorStack = mode1Probe.errorStack;

    // === Mode 2: live ACE drain (best-effort) =========================
    console.log("--- mode 2: live ACE drain (best-effort) ---");
    try {
      // Reload to a fresh page so the 2D path's drainEvents is wired
      // alongside the (existing) 3D one. Mode 1 init3D-only mode
      // doesn't have the 2D drainEvents.
      await page.goto(PAGE_URL, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(
        () => {
          const r = document.getElementById("results");
          return r && /PASS/.test(r.innerHTML);
        },
        { timeout: SMOKE_TIMEOUT_MS }
      );

      // Attempt login. Bridge URL needs to point at the live wsbridge.
      // If 100.116.47.66:8080 isn't reachable from this Playwright
      // instance (NAT, firewall, etc.) the login will time out and
      // mode 2 reports SKIP.
      await page.fill('input[name="account"]', ACCOUNT);
      await page.fill('input[name="password"]', PASSWORD);
      await page.fill('input[name="bridge_url"]', BRIDGE_URL);
      await page.fill('input[name="server_host"]', SERVER_HOST);
      await page.fill('input[name="server_port"]', SERVER_PORT);
      await page.click('#login-form button[type=submit]');

      const loginOk = await page
        .waitForSelector("#selection:not([hidden])", {
          timeout: LOGIN_TIMEOUT_MS,
        })
        .then(() => true)
        .catch(() => false);
      mode2.loginOk = loginOk;

      if (!loginOk) {
        mode2.skipped = true;
        mode2.skippedReason =
          `login timed out after ${LOGIN_TIMEOUT_MS}ms — ACE/wsbridge ` +
          `at ${BRIDGE_URL} (${SERVER_HOST}:${SERVER_PORT}) unreachable`;
        console.log(`[mode 2] SKIP: ${mode2.skippedReason}`);
      } else {
        console.log("[mode 2] login OK; installing entity drain hook");
        // Hook entity drain.
        await page.evaluate(() => {
          window.__phase74_capture_queue = [];
          const tryInstall = () => {
            const h = window.__sessionHandle;
            if (!h || typeof h.pollEntityUpdates !== "function") return false;
            if (window.__phase74_install_done) return true;
            const orig = h.pollEntityUpdates.bind(h);
            h.pollEntityUpdates = function () {
              const events = orig();
              for (const upd of events) {
                try {
                  window.__phase74_capture_queue.push({
                    kind: upd.kind | 0,
                    guid: (upd.guid >>> 0),
                    modelId: (upd.modelId >>> 0),
                    landblockId: (upd.landblockId >>> 0),
                    motionCommand: (upd.motionCommand >>> 0),
                    motionStance: (upd.motionStance >>> 0),
                  });
                  if (typeof window.__scene3dEntityHook === "function") {
                    window.__scene3dEntityHook(upd);
                  }
                } catch (_) {}
              }
              return events;
            };
            window.__phase74_install_done = true;
            return true;
          };
          if (!tryInstall()) {
            const t = setInterval(() => {
              if (tryInstall()) clearInterval(t);
            }, 100);
            setTimeout(() => clearInterval(t), 30_000);
          }
        });

        // Character spawn flow.
        try {
          await page.waitForTimeout(500);
          const initialButtonCount = await page
            .locator("#character-ul button[data-id]")
            .count();
          if (initialButtonCount === 0) {
            await page.fill('#create-form input[name="char_name"]', CHAR_NAME);
            await page.click("#create-button");
            await page.waitForFunction(
              () => {
                const s = document.getElementById("create-status");
                return s && /Created\b/.test(s.innerText);
              },
              { timeout: CREATE_TIMEOUT_MS }
            );
            await page.waitForFunction(
              () =>
                document.querySelectorAll("#character-ul button[data-id]")
                  .length > 0,
              { timeout: 10_000 }
            );
          }
          await page
            .locator("#character-ul button[data-id]")
            .first()
            .click();
          await page.waitForFunction(
            () => {
              const s = document.getElementById("login-status");
              return s && /InWorld|Spawned/.test(s.innerText);
            },
            { timeout: SPAWN_TIMEOUT_MS }
          );
          await page.waitForSelector("#post-spawn:not([hidden])", {
            timeout: TELEPORT_TIMEOUT_MS,
          });
          mode2.spawnOk = true;
          console.log("[mode 2] InWorld + post-spawn block visible");
        } catch (e) {
          console.warn(`[mode 2] spawn failed: ${e?.message ?? e}`);
        }

        if (mode2.spawnOk) {
          try {
            await page.click("#teleport-button");
            mode2.teleportOk = true;
            console.log(
              `[mode 2] teleported; waiting ${ENTITY_DRAIN_MS}ms`
            );
            await page.waitForTimeout(ENTITY_DRAIN_MS);
          } catch (e) {
            console.warn(`[mode 2] teleport failed: ${e?.message ?? e}`);
          }
        }

        // Probe live state. Note: when ?renderer=3d is on AND login
        // succeeds, renderHoltburg() is called, which calls init3D(),
        // which builds liveScene3d.entityManager. The 2D drainEvents
        // forwards via window.__scene3dEntityHook (installed by
        // installSharedDrainHook). So the EntityManager should fill
        // up with real entities.
        const live2Probe = await page.evaluate(() => {
          const out = {};
          const live = window.liveScene3d;
          if (!live || !live.entityManager) {
            out.error = "no liveScene3d.entityManager — 3D path didn't boot";
            return out;
          }
          const em = live.entityManager;
          out.entityMapSize = em.entityMap.size;
          out.entitiesGroupChildren = live.entitiesGroup.children.length;
          out.spawnCount = em.spawnCount;
          out.removeCount = em.removeCount;
          out.motionSwitchCount = em.motionSwitchCount;
          out.captureQueueLen = (window.__phase74_capture_queue || []).length;
          out.captureKindCounts = {};
          for (const e of window.__phase74_capture_queue || []) {
            out.captureKindCounts[e.kind] =
              (out.captureKindCounts[e.kind] || 0) + 1;
          }
          let entityWithMotion = 0;
          const sample = [];
          let i = 0;
          for (const [guid, inst] of em.entityMap) {
            if (i < 5) {
              sample.push({
                guid: "0x" + (guid >>> 0).toString(16).padStart(8, "0"),
                rootName: inst.root?.name,
                partsCount: inst.parts?.length,
                actionsSize: inst.actions?.size,
                hasCurrentAction: !!inst.currentAction,
                metaModelId: "0x" +
                  ((inst.meta?.modelId ?? 0) >>> 0)
                    .toString(16)
                    .padStart(8, "0"),
                metaName: inst.meta?.name || "",
              });
            }
            if (inst.currentAction) entityWithMotion += 1;
            i += 1;
          }
          out.entitySample = sample;
          out.entityWithMotion = entityWithMotion;
          return out;
        });
        console.log("[mode 2] live probe:", JSON.stringify(live2Probe, null, 2));
        mode2.liveEntities = live2Probe.entityMapSize ?? 0;
        mode2.entitiesGroupChildren = live2Probe.entitiesGroupChildren ?? 0;
        mode2.captureQueueLen = live2Probe.captureQueueLen ?? 0;
        mode2.captureKindCounts = live2Probe.captureKindCounts ?? {};
        mode2.entitySample = live2Probe.entitySample ?? [];
        mode2.entityWithMotion = live2Probe.entityWithMotion ?? 0;
        if (live2Probe.error) {
          mode2.error = live2Probe.error;
        }
      }
    } catch (e) {
      mode2.error = String(e?.message ?? e);
      console.warn(`[mode 2] outer error: ${mode2.error}`);
    }
  } catch (e) {
    console.error("FAIL: capture threw:", e?.message ?? e);
    await browser.close();
    process.exit(1);
  }

  console.log("=========================");
  console.log("Phase 7.4b mode 1 (standalone init3D):", JSON.stringify(mode1, null, 2));
  console.log("Phase 7.4b mode 2 (live ACE drain):", JSON.stringify(mode2, null, 2));
  console.log("=========================");

  let failures = 0;
  function check(name, ok, detail) {
    const status = ok ? "OK" : "FAIL";
    console.log(`  [${status}] ${name}${detail ? " — " + detail : ""}`);
    if (!ok) failures += 1;
  }

  // Mode 1 assertions — these are the load-bearing ones.
  check(
    "Phase 7.4b mode 1: init3D() resolved without error",
    mode1.initOk,
    mode1.error ? `error=${mode1.error}` : ""
  );
  check(
    "Phase 7.4b mode 1: liveScene3d.entityManager present",
    mode1.entityManagerPresent
  );
  check(
    "Phase 7.4b mode 1: EntityManager.spawn() built a rig with parts > 0",
    mode1.spawned && mode1.entityRigParts > 0,
    `spawned=${mode1.spawned}, parts=${mode1.entityRigParts}, setup=${mode1.setupId}`
  );
  check(
    "Phase 7.4b mode 1: mixer.update(dt) advances mixer.time",
    mode1.mixerAdvanced
  );
  check(
    "Phase 7.4b mode 1: setMotion(WALK→RUN→STOP) round-trip without error",
    mode1.motionSwitchOk
  );

  // Mode 2 — live coverage. SKIP rather than FAIL when login times out
  // (the prerequisites are out of this capture's control).
  if (mode2.skipped) {
    console.log(
      `  [SKIP] Phase 7.4b mode 2: live ACE drain — ${mode2.skippedReason}`
    );
  } else if (!mode2.loginOk) {
    console.log(
      `  [SKIP] Phase 7.4b mode 2: login didn't complete — see [mode 2] logs`
    );
  } else {
    check(
      "Phase 7.4b mode 2: live login + spawn completed",
      mode2.loginOk && mode2.spawnOk
    );
    check(
      "Phase 7.4b mode 2: pollEntityUpdates queue captured >= 1 event",
      mode2.captureQueueLen >= 1,
      `queue=${mode2.captureQueueLen}, kinds=${JSON.stringify(mode2.captureKindCounts)}`
    );
    check(
      "Phase 7.4b mode 2: EntityManager.entityMap.size >= 1 after live drain",
      mode2.liveEntities >= 1,
      `liveEntities=${mode2.liveEntities}, ` +
      `entitiesGroupChildren=${mode2.entitiesGroupChildren}`
    );
    if (mode2.entityWithMotion > 0) {
      check(
        "Phase 7.4b mode 2: at least 1 entity has currentAction (motion event arrived)",
        true,
        `entityWithMotion=${mode2.entityWithMotion}`
      );
    } else {
      console.log(
        `  [INFO] mode 2: 0 entities currently animating ` +
        `(kind=5 motion may not have fired during capture window)`
      );
    }
  }

  check(
    "Phase 7.4b: zero browser console errors",
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
    console.log("PASS: all Phase 7.4b capture checks green.");
    process.exit(0);
  }
})().catch((err) => {
  console.error("capture failed:", err);
  process.exit(1);
});
