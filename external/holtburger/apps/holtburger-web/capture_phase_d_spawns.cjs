// Phase D.1.d — capture script for the synthetic ACE entity-spawn
// injector.
//
// Boots the renderer at `?renderer=3d&quality=high` against the v2
// production bake at `/mnt/wbterminal1/holtburger-dist-v2/` (which
// now also serves the staged spawns dir under
// `dist/spawns/0xXXXX.spawns.jsonl`), drives init3D, then fires the
// lazy LB-entry hook for Holtburg (LB 0xA9B4) + a sample
// neighbouring LB (0xA9B0 South Holtburg Outpost) so the injector
// pulls spawns for both.
//
// Assertions (`liveScene3d.entitiesGroup.children.length`):
//   - Holtburg spawn count >= 100 (106 records; some may placeholder
//     or skip due to wasm fetch failures — floor at 100).
//   - 0xA9B0 spawn count >= 1 (13 records per staging stats).
//   - Per-LB AC-world positions for 0xA9B4 spawns land inside that
//     LB's 192x192 m bounds (cx*192 ≤ wx < (cx+1)*192).
//   - placeholder-vs-real-model split is reported in the diag log
//     (we expect 0 placeholders for the 13×13 ring, since all 193
//     ring wcids resolve to a setupDid via the staged
//     wcid_to_setup.json).
//
// Screenshot:
//   /mnt/wbterminal1/tmp/claude-scratch/scenery-bake/d1/holtburg-with-npcs.png
//   (1920×1080, hilltop oblique angle)
//
// PASS/FAIL contract:
//   - All hard assertions PASS → exit 0 (capture-script smoke gate).
//   - Any hard assertion FAIL → exit 1 with the assertion log printed.
//   - init3D timeout → exit 2 with the elapsed time printed.
//
// Run:
//   NODE_PATH=/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules \
//     node capture_phase_d_spawns.cjs
//
// Mirrors capture_world_expand_e2e.cjs's dev-server pattern.

const path = require("node:path");
const fs = require("node:fs");
const http = require("node:http");

// =====================================================================
// Playwright discovery — mirror the world-expand capture.
// =====================================================================

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
      "FAIL: playwright not found in NODE_PATH or " +
        PLAYWRIGHT_CACHE +
        "\n" +
        "Set NODE_PATH or PLAYWRIGHT_CACHE to a valid playwright install."
    );
    process.exit(2);
  }
}

// =====================================================================
// Self-hosted dev server. Mirrors the world-expand capture exactly.
// =====================================================================

const APP_ROOT = "/home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger";
const DIST_V2 = process.env.HOLTBURGER_DIST || process.env.HOLTBURGER_DIST_V2 || "/mnt/wbterminal2/holtburger-dist";

if (!fs.existsSync(path.join(APP_ROOT, "apps/holtburger-web/index.html"))) {
  console.error(`FAIL: index.html missing at ${APP_ROOT}/apps/holtburger-web/index.html`);
  process.exit(2);
}
if (!fs.existsSync(path.join(DIST_V2, "manifest.json"))) {
  console.error(`FAIL: dist v2 manifest missing at ${DIST_V2}/manifest.json`);
  process.exit(2);
}
if (!fs.existsSync(path.join(DIST_V2, "spawns/source.sha256"))) {
  console.error(
    `FAIL: spawns dir missing at ${DIST_V2}/spawns. Re-run:\n` +
    `  python3 ${APP_ROOT}/scripts/world-completeness/stage-ring-spawns.py`
  );
  process.exit(2);
}

function contentTypeFor(filePath) {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (filePath.endsWith(".mjs")) return "text/javascript; charset=utf-8";
  if (filePath.endsWith(".json")) return "application/json; charset=utf-8";
  if (filePath.endsWith(".wasm")) return "application/wasm";
  if (filePath.endsWith(".png")) return "image/png";
  if (filePath.endsWith(".jsonl")) return "application/jsonl; charset=utf-8";
  return "application/octet-stream";
}

function makeServer() {
  return http.createServer((req, res) => {
    let url;
    try {
      url = decodeURIComponent(req.url.split("?")[0]);
    } catch (e) {
      res.writeHead(400).end();
      return;
    }
    const stripped = url.replace(/^\/+/, "");
    let filePath;
    if (stripped.startsWith("dist/")) {
      filePath = path.join(DIST_V2, stripped.slice("dist/".length));
      if (!filePath.startsWith(DIST_V2)) {
        res.writeHead(403).end();
        return;
      }
    } else {
      filePath = path.join(APP_ROOT, stripped);
      if (!filePath.startsWith(APP_ROOT)) {
        res.writeHead(403).end();
        return;
      }
    }
    res.setHeader("Connection", "close");
    res.setHeader("Cache-Control", "no-cache");
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, {
        "content-type": contentTypeFor(filePath),
        "content-length": data.length,
      });
      res.end(data);
    });
  });
}

// =====================================================================
// Main capture.
// =====================================================================

(async () => {
  const SMOKE_TIMEOUT_MS = Number(process.env.PHASE_D_SMOKE_TIMEOUT_MS || 60_000);
  const INIT_TIMEOUT_MS = Number(process.env.PHASE_D_INIT_TIMEOUT_MS || 180_000);
  const SPAWN_SETTLE_MS = Number(process.env.PHASE_D_SPAWN_SETTLE_MS || 25_000);
  const SPAWN_POLL_TIMEOUT_MS = Number(process.env.PHASE_D_SPAWN_POLL_TIMEOUT_MS || 90_000);

  const SCRATCH_DIR =
    process.env.PHASE_D_SCRATCH_DIR ||
    "/mnt/wbterminal1/tmp/claude-scratch/scenery-bake/d1";
  try {
    fs.mkdirSync(SCRATCH_DIR, { recursive: true });
  } catch (_) {}
  const SCREENSHOT_PATH = path.join(SCRATCH_DIR, "holtburg-with-npcs.png");
  const DIAG_LOG_PATH = path.join(
    SCRATCH_DIR,
    `phase-d-spawns-${Date.now()}-diag.json`
  );

  const server = makeServer();
  server.keepAliveTimeout = 0;
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const PAGE_URL = `http://127.0.0.1:${port}/apps/holtburger-web/index.html?renderer=3d&quality=high`;
  console.log(`dev server: http://127.0.0.1:${port}`);
  console.log(`page URL: ${PAGE_URL}`);

  let browser;
  let exitCode = 0;
  const verdict = {
    smokePass: false,
    initResolved: false,
    initElapsedMs: null,
    assertions: [],
    failures: 0,
    sceneSummary: null,
    spawnDiag: null,
    consoleErrors: [],
  };

  function check(name, ok, detail) {
    const status = ok ? "OK" : "FAIL";
    console.log(`  [${status}] ${name}${detail ? " — " + detail : ""}`);
    verdict.assertions.push({ name, ok, detail });
    if (!ok) verdict.failures += 1;
  }

  try {
    browser = await chromium.launch({
      args: ["--use-gl=swiftshader"],
    });
    const context = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
    });
    const page = await context.newPage();

    page.on("console", (msg) => {
      const text = msg.text();
      if (msg.type() === "error") {
        verdict.consoleErrors.push(text);
        if (verdict.consoleErrors.length <= 12) {
          console.log(`[browser error] ${text.slice(0, 240)}`);
        }
      } else if (/scene3d\.spawns|phase-d|fetch_landblock_spawns|world-expand|init3D/i.test(text)) {
        const trimmed = text.slice(0, 240);
        if (
          trimmed.startsWith("[scene3d.spawns]") ||
          trimmed.startsWith("[phase-d]") ||
          /scene3d\.spawns|fetch_landblock_spawns|spawn_chain|spawn_diag/.test(trimmed)
        ) {
          console.log(`[browser log] ${trimmed}`);
        }
      }
    });
    page.on("pageerror", (err) => {
      verdict.consoleErrors.push(`pageerror: ${err.message}`);
      console.error(`[pageerror] ${err.message}`);
    });

    await page.goto(PAGE_URL, { waitUntil: "domcontentloaded" });

    // Stage 1: wait for the in-page smoke panel to PASS — confirms
    // wasm + manifest loaded.
    try {
      await page.waitForFunction(
        () => {
          const r = document.getElementById("results");
          return r && /PASS/.test(r.innerHTML);
        },
        { timeout: SMOKE_TIMEOUT_MS }
      );
      verdict.smokePass = true;
      console.log("[stage 1] in-page smoke panel: PASS");
    } catch (e) {
      const html = await page
        .locator("#results")
        .innerHTML()
        .catch(() => "(no #results)");
      console.error(
        `FAIL: in-page smoke panel never reached PASS within ${SMOKE_TIMEOUT_MS}ms`
      );
      console.error(`  first 400 chars: ${html.slice(0, 400)}`);
      check("in-page smoke panel reaches PASS", false, `timeout ${SMOKE_TIMEOUT_MS}ms`);
      throw new Error("smoke-timeout");
    }

    // Stage 2: drive init3D directly. Mirrors capture_world_expand_e2e.cjs
    // but adds `init_spawns_base_url` + `fetch_landblock_spawns` to the
    // wasmExports payload.
    console.log(
      `[stage 2] driving init3D directly (timeout ${INIT_TIMEOUT_MS}ms)`
    );
    const tInitStart = Date.now();
    let initProbe;
    try {
      initProbe = await page.evaluate(async (timeoutMs) => {
        const out = { steps: [] };
        try {
          const canvas =
            document.getElementById("scene") || document.querySelector("canvas");
          if (!canvas) {
            out.error = "no canvas in page";
            return out;
          }
          out.steps.push(`canvas: ${canvas.width}x${canvas.height}`);

          const wasmMod = await import("./pkg/holtburger_web.js?v=h3-e1");
          // wasm-bindgen --target web: the named exports are inert until the
          // default init (__wbg_init) instantiates the module — the page does
          // `await init()` (index.html). Without it the internal `wasm` binding
          // is undefined and any export throws "reading 'has_resource_source'".
          if (typeof wasmMod.default === "function") {
            await wasmMod.default();
          }
          // The fetch_* exports read a GLOBAL ManifestResourceSource that
          // init_resource_source() sets up — the page calls this before init3D.
          if (typeof wasmMod.init_resource_source === "function"
              && !(typeof wasmMod.has_resource_source === "function" && wasmMod.has_resource_source())) {
            await wasmMod.init_resource_source("../../dist/manifest.json");
          }
          out.steps.push(
            `wasm loaded: has_resource_source=${typeof wasmMod.has_resource_source === "function" ? wasmMod.has_resource_source() : "n/a"}, ` +
              `fetch_landblock_spawns=${typeof wasmMod.fetch_landblock_spawns}`
          );

          const scene3d = await import("./scene3d/index.js");
          out.steps.push(`scene3d module: init3D=${typeof scene3d.init3D}`);

          // Full wasm exports payload — match index.html's init3D
          // call site. We MUST include fetch_landblock_spawns +
          // init_spawns_base_url for the Phase D path to fire.
          const wasmExports = {
            fetch_landblock_heightmaps: wasmMod.fetch_landblock_heightmaps,
            fetch_subdivided_landblock: wasmMod.fetch_subdivided_landblock,
            fetch_subdivided_landblocks: wasmMod.fetch_subdivided_landblocks,
            fetch_terrain_textures: wasmMod.fetch_terrain_textures,
            fetch_landblock_objects: wasmMod.fetch_landblock_objects,
            fetch_landblock_spawns: wasmMod.fetch_landblock_spawns,
            init_spawns_base_url: wasmMod.init_spawns_base_url,
            fetch_model_meshes: wasmMod.fetch_model_meshes,
            fetch_surfaces_pixels: wasmMod.fetch_surfaces_pixels,
            fetchEntityModelRender: wasmMod.fetchEntityModelRender,
            fetchEntityCycleFrames: wasmMod.fetchEntityCycleFrames,
            fetchEntityAnimationKeyframes: wasmMod.fetchEntityAnimationKeyframes,
            fetchEntitySurfacesPixels: wasmMod.fetchEntitySurfacesPixels,
            fetchBuildingPlacement: wasmMod.fetchBuildingPlacement,
            fetchSetupModelLights: wasmMod.fetchSetupModelLights,
            populateBuildingAabbsForLandblock: wasmMod.populateBuildingAabbsForLandblock,
            fetchEnvCellsInLandblock: wasmMod.fetchEnvCellsInLandblock,
            fetchPhysicsScript: wasmMod.fetchPhysicsScript,
            fetchParticleEmitter: wasmMod.fetchParticleEmitter,
            fetchWave: wasmMod.fetchWave,
            fetchSoundTable: wasmMod.fetchSoundTable,
            fetchRegion: wasmMod.fetchRegion,
          };

          const tStart = performance.now();
          const live = await Promise.race([
            scene3d.init3D(canvas, null, wasmExports),
            new Promise((_, rej) =>
              setTimeout(
                () => rej(new Error("init3D timeout")),
                timeoutMs
              )
            ),
          ]);
          const tElapsed = (performance.now() - tStart) | 0;
          out.steps.push(`init3D resolved in ${tElapsed} ms`);
          out.elapsedMs = tElapsed;
          out.hasLiveScene3d = !!window.liveScene3d;
          out.hasLoadSpawnsHook =
            typeof window.liveScene3d?.loadSpawnsForLandblock === "function";
          out.hasScene3dEntityHook =
            typeof window.__scene3dEntityHook === "function";
        } catch (e) {
          out.error = String(e?.message ?? e);
          out.errorStack = String(e?.stack ?? "").slice(0, 800);
        }
        return out;
      }, INIT_TIMEOUT_MS);
      verdict.initElapsedMs = Date.now() - tInitStart;
      console.log("[stage 2] init3D probe:", JSON.stringify(initProbe, null, 2));
      if (initProbe.error) {
        check("init3D resolves", false, `error: ${initProbe.error}`);
        throw new Error("init-error");
      }
      verdict.initResolved = true;
      check(
        "init3D exposes window.liveScene3d.loadSpawnsForLandblock",
        initProbe.hasLoadSpawnsHook === true,
        `got=${initProbe.hasLoadSpawnsHook}`
      );
      check(
        "init3D installs shared drain hook (window.__scene3dEntityHook)",
        initProbe.hasScene3dEntityHook === true,
        `got=${initProbe.hasScene3dEntityHook}`
      );
    } catch (e) {
      verdict.initElapsedMs = verdict.initElapsedMs ?? Date.now() - tInitStart;
      console.error(`FAIL: init3D failed: ${e?.message ?? e}`);
      check("init3D resolves", false, `error after ${verdict.initElapsedMs}ms`);
      throw new Error("init-failed");
    }

    // Stage 3: trigger Phase D.1 spawn injection for Holtburg + a
    // sample neighbouring LB. The loadSpawnsForLandblock hook
    // dedupes per LB so two-call here mirrors what the lazy
    // handlePositionUpdate would do on player crossing the LB
    // boundary.
    console.log("[stage 3] firing loadSpawnsForLandblock for 0xA9B4 + 0xA9B0");
    const injectProbe = await page.evaluate(async () => {
      const out = { steps: [], results: {} };
      try {
        const live = window.liveScene3d;
        if (!live || typeof live.loadSpawnsForLandblock !== "function") {
          out.error = "loadSpawnsForLandblock missing on liveScene3d";
          return out;
        }
        // 0xA9B4 = Holtburg (106 records).
        out.results.holtburg = await live.loadSpawnsForLandblock(0xa9, 0xb4);
        // 0xA9B0 = South Holtburg Outpost (13 records).
        out.results.south = await live.loadSpawnsForLandblock(0xa9, 0xb0);
        // 0xA9B2 = wilderness LB that USED to 404 to zero spawns; after the
        // empty-world fix it stages encounter fauna (anchor 5150 "Harmless
        // Aluvian Generator" + FNV-scattered child 2566 "Black Rabbit").
        // This is the PROBE-WILD positive case (was injectedCount==0 before).
        out.results.wild = await live.loadSpawnsForLandblock(0xa9, 0xb2);
        // Re-fire Holtburg — verifies idempotency.
        out.results.holtburgAgain = await live.loadSpawnsForLandblock(0xa9, 0xb4);
        out.steps.push(
          `holtburg: ${JSON.stringify(out.results.holtburg)}`
        );
        out.steps.push(
          `south: ${JSON.stringify(out.results.south)}`
        );
      } catch (e) {
        out.error = String(e?.message ?? e);
        out.errorStack = String(e?.stack ?? "").slice(0, 800);
      }
      return out;
    });
    console.log("[stage 3] inject probe:", JSON.stringify(injectProbe, null, 2));
    if (injectProbe.error) {
      check("loadSpawnsForLandblock invocation succeeds", false, injectProbe.error);
    } else {
      check(
        "0xA9B4 fetch returns >= 100 records (Holtburg, expect 106)",
        injectProbe.results?.holtburg?.fetched >= 100,
        `fetched=${injectProbe.results?.holtburg?.fetched}`
      );
      check(
        "0xA9B0 fetch returns >= 1 record (South Outpost, expect 13)",
        injectProbe.results?.south?.fetched >= 1,
        `fetched=${injectProbe.results?.south?.fetched}`
      );
      check(
        "0xA9B2 wilderness now returns encounter fauna (>0, was 0 pre-fix)",
        injectProbe.results?.wild?.fetched > 0
          && (injectProbe.results?.wild?.placeholdersCount ?? 0) === 0,
        `fetched=${injectProbe.results?.wild?.fetched}, ` +
          `placeholders=${injectProbe.results?.wild?.placeholdersCount}`
      );
      check(
        "Re-firing 0xA9B4 is idempotent",
        injectProbe.results?.holtburgAgain?.idempotent === true,
        `result=${JSON.stringify(injectProbe.results?.holtburgAgain)}`
      );
    }

    // Stage 4: settle. Spawns are async — em.spawn(meta) kicks
    // `fetchEntityAnimationKeyframes`, which awaits the wasm-side
    // mesh fetch (which may itself await several shard fetches).
    // At 100+ entities the chain ripples through several seconds.
    // Settle path: short initial wait, then poll until
    // entitiesGroup.children.length stabilises (spawnInFlight
    // drains to 0 OR no growth for 4 consecutive polls).
    console.log(
      `[stage 4] initial settle ${SPAWN_SETTLE_MS}ms, then poll up to ` +
        `${SPAWN_POLL_TIMEOUT_MS}ms for spawn chain to drain`
    );
    await page.waitForTimeout(SPAWN_SETTLE_MS);
    const pollStart = Date.now();
    let lastChildren = -1;
    let stableCount = 0;
    while (Date.now() - pollStart < SPAWN_POLL_TIMEOUT_MS) {
      const snap = await page.evaluate(() => {
        const s = window.liveScene3d;
        return {
          children: s?.entitiesGroup?.children?.length ?? 0,
          inFlight: s?.entityManager?.spawnInFlight?.size ?? 0,
        };
      });
      console.log(
        `[stage 4] poll: children=${snap.children}, inFlight=${snap.inFlight}`
      );
      if (snap.inFlight === 0) {
        console.log("[stage 4] spawnInFlight drained to 0");
        break;
      }
      if (snap.children === lastChildren) {
        stableCount += 1;
        if (stableCount >= 4) {
          console.log("[stage 4] children count stable for 4 polls; settling");
          break;
        }
      } else {
        stableCount = 0;
      }
      lastChildren = snap.children;
      await page.waitForTimeout(3000);
    }

    // Stage 5: scrape the spawn-side scene summary.
    const summary = await page.evaluate((HOLTBURG_LB_HIGH) => {
      const out = {
        entitiesGroupChildren: 0,
        entityManagerSize: 0,
        spawnCount: 0,
        spawnsSummary: null,
        spawnsByLbKeys: [],
        spawnsInFlight: 0,
        placeholderCount: 0,
        realModelCount: 0,
        // Per-LB position validity for Holtburg's expected guids only.
        holtburgExpectedGuids: 0,
        holtburgFoundGuids: 0,
        holtburgPositionsInBounds: 0,
        holtburgPositionsOutOfBounds: 0,
        holtburgSamplePositions: [],
        sampleNames: [],
      };
      try {
        const s = window.liveScene3d;
        if (!s) return { ...out, error: "no liveScene3d" };
        out.entitiesGroupChildren = s.entitiesGroup?.children?.length ?? 0;
        out.entityManagerSize = s.entityManager?.entityMap?.size ?? 0;
        out.spawnCount = s.entityManager?.spawnCount ?? 0;
        out.spawnsInFlight = s.entityManager?.spawnInFlight?.size ?? 0;
        out.spawnsSummary = s.spawnsSummary
          ? { ...s.spawnsSummary }
          : null;
        if (s.spawnsByLb instanceof Map) {
          out.spawnsByLbKeys = [...s.spawnsByLb.keys()].map((k) =>
            `0x${((k >>> 16) & 0xffff).toString(16).toUpperCase().padStart(4, "0")}`
          );
        }
        // Pull the Holtburg-specific guid set so the position-validity
        // check filters to ONLY Holtburg entities (South Outpost's 13
        // entities sit ~768m away and would falsely register
        // out-of-bounds otherwise).
        const holtburgLbKey = HOLTBURG_LB_HIGH;
        const holtburgEntry = s.spawnsByLb?.get(holtburgLbKey);
        const holtburgGuids = new Set(holtburgEntry?.guids ?? []);
        out.holtburgExpectedGuids = holtburgGuids.size;
        // Walk entityMap once: count placeholder-vs-real, gather
        // sample positions for Holtburg. Rigs store AC world coords
        // directly on root.position (see scene3d/entities.js:698-701).
        const HOLTBURG_X0 = 0xa9 * 192.0;
        const HOLTBURG_X1 = (0xa9 + 1) * 192.0;
        const HOLTBURG_Y0 = 0xb4 * 192.0;
        const HOLTBURG_Y1 = (0xb4 + 1) * 192.0;
        for (const [guid, inst] of (s.entityManager?.entityMap ?? new Map())) {
          const meta = inst?.meta;
          if (!meta) continue;
          if (meta.__placeholder) {
            out.placeholderCount += 1;
          } else {
            out.realModelCount += 1;
          }
          // Only do position-validity check for guids we injected
          // for Holtburg specifically. South Outpost / wilderness
          // entities live in different LBs.
          const isHoltburgGuid = holtburgGuids.has(guid);
          if (isHoltburgGuid) out.holtburgFoundGuids += 1;
          // Holtburg position check via root world position.
          // Rigs store AC world coords directly on root.position
          // (see scene3d/entities.js:698-701: wx = lbX*192 + meta.x,
          // wy = lbY*192 + meta.y, wz = meta.z).
          // worldRoot rotation handles AC→three transform at group
          // level, not per-entity, so AC bounds check is correct.
          // Holtburg LB envelope: x ∈ [0xA9*192, 0xAA*192) = [32448, 32640).
          //                       y ∈ [0xB4*192, 0xB5*192) = [34560, 34752).
          const root = inst.root;
          if (isHoltburgGuid && root && typeof root.position?.x === "number") {
            const px = root.position.x;
            const py = root.position.y;
            if (out.holtburgSamplePositions.length < 5) {
              out.holtburgSamplePositions.push({
                guid: `0x${guid.toString(16).padStart(8, "0").toUpperCase()}`,
                pos: { x: px, y: py, z: root.position.z },
                modelId: meta.modelId
                  ? `0x${(meta.modelId >>> 0).toString(16).padStart(8, "0").toUpperCase()}`
                  : null,
                placeholder: !!meta.__placeholder,
                name: meta.name || "",
              });
            }
            if (
              px >= HOLTBURG_X0 && px < HOLTBURG_X1 &&
              py >= HOLTBURG_Y0 && py < HOLTBURG_Y1
            ) {
              out.holtburgPositionsInBounds += 1;
            } else {
              out.holtburgPositionsOutOfBounds += 1;
            }
          }
          if (meta.name && out.sampleNames.length < 8) {
            out.sampleNames.push(meta.name);
          }
        }
      } catch (e) {
        out.error = String(e?.message ?? e);
        out.errorStack = String(e?.stack ?? "").slice(0, 600);
      }
      return out;
    }, 0xa9b40000 >>> 0);

    verdict.spawnDiag = summary;
    console.log("[stage 5] spawn summary:", JSON.stringify(summary, null, 2));

    if (summary.error) {
      check("spawn summary readable", false, summary.error);
    } else {
      // Main assertion — Phase D.1's "did the renderer accept the
      // synthetic spawns?" floor.
      check(
        "liveScene3d.entitiesGroup.children.length >= 100 (Holtburg-spawn floor)",
        summary.entitiesGroupChildren >= 100,
        `got=${summary.entitiesGroupChildren}`
      );

      // entityManager.entityMap size should track too. The
      // EntityManager.spawn path is async + may fail per-spawn (e.g.
      // a wcid with no setup_did → fallback to placeholder; an
      // animation fetch that throws → silent reject); we still
      // expect the floor.
      check(
        "entityManager.entityMap.size >= 100",
        summary.entityManagerSize >= 100,
        `got=${summary.entityManagerSize}, spawnCount=${summary.spawnCount}`
      );

      // Per-LB summary: scene3d.spawnsByLb should have entries for
      // both LBs we injected.
      check(
        "scene3d.spawnsByLb has entries for 0xA9B4 + 0xA9B0",
        summary.spawnsByLbKeys.includes("0xA9B4") &&
          summary.spawnsByLbKeys.includes("0xA9B0"),
        `keys=${JSON.stringify(summary.spawnsByLbKeys)}`
      );

      // spawnsSummary aggregate counts.
      check(
        "scene3d.spawnsSummary.recordCount >= 100",
        (summary.spawnsSummary?.recordCount ?? 0) >= 100,
        `recordCount=${summary.spawnsSummary?.recordCount}`
      );

      // Placement bounds — at least most Holtburg spawns should
      // land inside the LB envelope.
      check(
        "Holtburg spawns land within 200m of LB centre (position validity)",
        summary.holtburgPositionsInBounds > 0 &&
          summary.holtburgPositionsOutOfBounds === 0,
        `inBounds=${summary.holtburgPositionsInBounds}, ` +
          `outOfBounds=${summary.holtburgPositionsOutOfBounds}`
      );

      // Placeholder split — now a HARD gate (HARNESS-FIX). With WEENIE-1's
      // wcid_to_setup.json staged, every resolved spawn must map to a real
      // setup; any placeholder (the 0x0200016F fallback) means a wcid was
      // absent from the map — a staging regression, not a render quirk.
      check(
        "placeholderCount === 0 after WEENIE-1 (no unresolved-setup placeholders)",
        (summary.placeholderCount ?? 0) === 0,
        `${summary.placeholderCount} placeholder / ${summary.realModelCount} real-model`
      );
    }

    // Stage 6: position the camera for a hilltop oblique screenshot
    // of Holtburg with the freshly-injected entities visible.
    console.log("[stage 6] camera + screenshot");
    try {
      await page.evaluate(() => {
        const s = window.liveScene3d;
        if (!s) return;
        // Holtburg centre in three.js frame. The worldRoot rotates
        // -π/2 about X so AC (x, y, z) → three (x, z, -y). The
        // camera lives OUTSIDE worldRoot's transform, so position
        // it in the FINAL three.js frame.
        const HOLTBURG_AC_X = 0xa9 * 192.0 + 96.0;
        const HOLTBURG_AC_Y = 0xb4 * 192.0 + 96.0;
        const HOLTBURG_AC_Z = 80.0;  // approx ground level
        // acToThree(ax,ay,az) = (ax, az, -ay).
        const target = {
          x: HOLTBURG_AC_X,
          y: HOLTBURG_AC_Z,
          z: -HOLTBURG_AC_Y,
        };
        const cam = s.cameraSwitcher?.activeCamera ?? s.camera;
        if (cam) {
          // 100m east, 80m above target — hilltop oblique.
          cam.position.set(target.x + 100, target.y + 80, target.z + 100);
          cam.lookAt(target.x, target.y, target.z);
          cam.updateProjectionMatrix();
        }
      });
      await page.waitForTimeout(1500);
      // Canvas-only screenshot via toDataURL + fs.writeFile. Playwright's
      // page.screenshot timed out on font-load on this build; the
      // canvas itself can be read out of WebGLRenderer.preserveDrawingBuffer
      // (three.js handles this via the render-target swap chain). One
      // .evaluate() + .toDataURL("image/png") + fs.writeFileSync is
      // the bare-minimum path with no Playwright element interactions.
      const dataUrl = await page.evaluate(() => {
        const canvas = document.getElementById("canvas")
          || document.querySelector("canvas");
        if (!canvas) return null;
        // Force one more render so the canvas has the freshest
        // entity-spawn pose. WebGLRenderer with antialias creates
        // a multi-sample render-target; toDataURL pulls from the
        // resolved buffer.
        try {
          const live = window.liveScene3d;
          if (live?.renderer && live?.scene) {
            const cam = live.cameraSwitcher?.activeCamera ?? live.camera;
            if (cam) live.renderer.render(live.scene, cam);
          }
        } catch (_) {}
        try {
          return canvas.toDataURL("image/png");
        } catch (e) {
          return null;
        }
      });
      if (dataUrl && dataUrl.startsWith("data:image/png;base64,")) {
        const b64 = dataUrl.slice("data:image/png;base64,".length);
        fs.writeFileSync(SCREENSHOT_PATH, Buffer.from(b64, "base64"));
        console.log(`[stage 6] screenshot saved to ${SCREENSHOT_PATH}`);
      } else {
        console.warn(
          `[stage 6] canvas.toDataURL returned empty — screenshot skipped`
        );
      }
    } catch (e) {
      console.warn(`[stage 6] screenshot failed: ${e?.message ?? e}`);
      // Non-fatal — the assertion gates are what matter.
    }
  } catch (e) {
    console.error(`FAIL: capture aborted: ${e?.message ?? e}`);
    exitCode = exitCode || 1;
  } finally {
    if (browser) await browser.close().catch(() => {});
    server.close();
  }

  // =====================================================================
  // Verdict.
  // =====================================================================

  console.log("");
  console.log("====================================");
  console.log("Phase D.1 capture verdict");
  console.log("====================================");
  console.log(`smokePass:    ${verdict.smokePass}`);
  console.log(`initResolved: ${verdict.initResolved}`);
  console.log(`initElapsed:  ${verdict.initElapsedMs}ms`);
  console.log(`assertions:   ${verdict.assertions.length} (${verdict.failures} FAIL)`);
  console.log(`entitiesGroupChildren: ${verdict.spawnDiag?.entitiesGroupChildren ?? "n/a"}`);
  console.log(`entityManagerSize:     ${verdict.spawnDiag?.entityManagerSize ?? "n/a"}`);
  console.log(`placeholderCount:      ${verdict.spawnDiag?.placeholderCount ?? "n/a"}`);
  console.log(`realModelCount:        ${verdict.spawnDiag?.realModelCount ?? "n/a"}`);
  console.log(`sampleNames: ${JSON.stringify(verdict.spawnDiag?.sampleNames ?? [])}`);

  fs.writeFileSync(DIAG_LOG_PATH, JSON.stringify(verdict, null, 2));
  console.log(`diag log: ${DIAG_LOG_PATH}`);

  exitCode = exitCode || (verdict.failures > 0 ? 1 : 0);
  process.exit(exitCode);
})();
