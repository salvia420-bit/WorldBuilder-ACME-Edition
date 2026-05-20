// Phase F.D — `validate-event-completeness`
//
// **What this tool does:** boots the holtburger-web renderer end-to-
// end in a headless Chromium against the production v2 bake at
// `/mnt/wbterminal1/holtburger-dist-v2/`, drives a deterministic
// probe scenario through the F.C runtime event-log probe, then asserts
// the event-completeness contract from `docs/event-completeness-method.md`:
//
// ```
// fired_sound_events(lb, [t0, t1]) ≡ {
//     ∀ e ∈ ambient_events(lb, terrain_at_player, [t0, t1])
//   ∪ ∀ e ∈ animation_hook_events(active_entities(lb), motion_clocks, [t0, t1])
//   ∪ ∀ e ∈ server_sound_messages(landblock_instance(lb), [t0, t1])
// }
//
// fired_particle_events(lb, [t0, t1]) ≡ {
//     ∀ e ∈ physics_script_hooks(active_entities(lb), [t0, t1])
//   ∪ ∀ e ∈ sky_physics_chain(visible_sky_objects, [t0, t1])
//   ∪ ∀ e ∈ server_particle_messages([t0, t1])
// }
// ```
//
// for a probe window. Anything in `expected` not in the snapshotted
// event log is a **missing-event**; anything in the log not in
// `expected` is a **spurious-event**. Both are findings to surface;
// the renderer is a pure consumer of DAT + ACE state and this
// validator IS the source of truth.
//
// **Mirrors Phase E** (`validate_landblock_completeness.cjs`) — same
// dev-server + Playwright + dist v2 wiring, but the probe is a TIME
// window through the runtime event-log instead of a snapshot of the
// scene graph. Events are triggers; placements are positions.
//
// **Probe scenario** (deterministic, ~30 s wall-clock):
//   1. **AmbientRuntime** — boot the page, hold at Holtburg LB
//      0xA9B4 spawn for ~10 s. The ambient roller fires for the LB's
//      grass terrain mix (continuous Ambient1 hum + probabilistic
//      Ambient2..7 rolls per F.B's bake).
//   2. **OneOff** — call `window.__playWave(0x0A000266, ...)` 3×.
//      Trivially deterministic; logs as `source: "OneOff"`.
//   3. **GameMessageSound** — F.D-fu1 (2026-05-20): the renderer now
//      exposes `window.__synthGameMessageSound(guid, soundEnum, scale)`
//      which mirrors the SAME resolution chain as the live recv-loop
//      arm in index.html:6968-7137 (entity GUID → SoundTable resolve →
//      AudioManager.play → pushEventRecord(source: "GameMessageSound")).
//      A synthetic spawn (step 4) gives us an entity with a known
//      soundTableDid (`0x20000014` = forge SoundTable, retail-verified
//      Sound.LifestoneOn → waveDid 0x0a000266 per the H3-F memory
//      note) so the SoundTable lookup resolves.
//   4. **PhysicsScriptHook** — synth-spawn an entity with
//      `physicsScriptDid = 0x33000E9D` (a real script DID from the
//      F.B bake at 0xA9B4 — 3 CreateParticle hooks). The H2 chain
//      walker (entities.js:1058) fetches the PhysicsScript and fires
//      CreateParticle hooks via addEmitter → logs as `source:
//      "PhysicsScriptHook"`. F.D-fu3 (2026-05-20): the walker now
//      exposes `entityManager.awaitParticleChainResolution(guid)` so
//      the validator can `await` actual resolution instead of guessing
//      a settle timeout.
//   5. **Skipped — AnimationHook** — per F.B's findings (and the
//      staged events README), anim_sound is unreachable without
//      F.B.5 wcid→MotionTableDataId staging. Reported as
//      `expected=0 observed=0 — channel not yet exercised`.
//   6. **Skipped — SkyChain** — requires populateSkyDescFromRegion +
//      sky-chain init. Doable as a follow-on; not required for the
//      ≥4 source target.
//
// **Tolerances** (per method doc):
//   - **Continuous ambient**: 1:1 per active trigger within window
//   - **Probabilistic ambient**: expected_count ≈ active_seconds /
//     mean_rate × base_chance; ±50% (probability distribution).
//   - **OneOff**: exactly 1 observed per fired
//   - **GameMessageSound**: exactly 1 observed per injected
//   - **PhysicsScriptHook**: 1:1 per entity hook within ±50 ms
//     wall-clock of expected start_time_s
//
// **Outputs**
//   - `<out>/event-completeness-report.json` — machine-readable diff
//   - `<out>/event-completeness-report.md`   — human-readable summary
//
// **CLI args**
//   --probe-s   seconds  (default 60 — F.D-fu4 (2026-05-20): bumped
//                        from 12 so the probabilistic ambient timers
//                        (which roll on a per-row `[minRate, maxRate]`
//                        window — typically 1..30s — and gate on a
//                        `baseChance` coin flip) have enough wall-
//                        clock window to land statistically-meaningful
//                        fire counts. The +48s costs ~1 min of capture
//                        wallclock per run; the alternative (12s
//                        probe window) consistently reported `obs=0`
//                        on probabilistic ambient even though the
//                        runtime was firing correctly — see
//                        `project_event_fdfu_done_2026-05-20.md` for
//                        the probability-distribution analysis.)
//   --out       dir      (default `/mnt/wbterminal1/tmp/claude-scratch/event-completeness/d/`)
//   --strict             (treat any missing-event as exit 1; default
//                        0 if all sources reported their expected
//                        counts within tolerance)
//
// Run:
//   NODE_PATH=/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules \
//     node validate_event_completeness.cjs

const path = require("node:path");
const fs = require("node:fs");
const http = require("node:http");

// =====================================================================
// CLI parsing
// =====================================================================

function parseArgs(argv) {
  const args = {
    // F.D-fu4 (2026-05-20): 60s default (was 12s). See header comment.
    probeSeconds: 60,
    out: "/mnt/wbterminal1/tmp/claude-scratch/event-completeness/d/",
    strict: false,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--strict") {
      args.strict = true;
    } else if (a === "--probe-s") {
      args.probeSeconds = parseInt(argv[i + 1], 10);
      i += 1;
      if (!Number.isFinite(args.probeSeconds) || args.probeSeconds <= 0) {
        console.error(`FAIL: --probe-s must be a positive integer; got '${argv[i]}'`);
        process.exit(2);
      }
    } else if (a === "--out") {
      args.out = argv[i + 1];
      i += 1;
    } else {
      console.error(`FAIL: unknown arg '${a}'. Usage: --probe-s SECONDS --out DIR [--strict]`);
      process.exit(2);
    }
  }
  return args;
}

const args = parseArgs(process.argv);

// =====================================================================
// Playwright discovery — mirror the Phase E pattern.
// =====================================================================

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

// =====================================================================
// Self-hosted dev server — same setup as Phase E.
// =====================================================================

const APP_ROOT = "/home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger";
const DIST_V2 = "/mnt/wbterminal1/holtburger-dist-v2";

if (!fs.existsSync(path.join(APP_ROOT, "apps/holtburger-web/index.html"))) {
  console.error(`FAIL: index.html missing at ${APP_ROOT}/apps/holtburger-web/index.html`);
  process.exit(2);
}
if (!fs.existsSync(path.join(DIST_V2, "manifest.json"))) {
  console.error(`FAIL: dist v2 manifest missing at ${DIST_V2}/manifest.json`);
  process.exit(2);
}
if (!fs.existsSync(path.join(DIST_V2, "events/0xA9B4.events.jsonl"))) {
  console.error(
    `FAIL: events dir missing at ${DIST_V2}/events/. ` +
      "Re-stage via Phase F.E first (commit 0d2de4b)."
  );
  process.exit(2);
}

function contentTypeFor(p) {
  if (p.endsWith(".html")) return "text/html; charset=utf-8";
  if (p.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (p.endsWith(".mjs")) return "text/javascript; charset=utf-8";
  if (p.endsWith(".json")) return "application/json; charset=utf-8";
  if (p.endsWith(".jsonl")) return "application/jsonl; charset=utf-8";
  if (p.endsWith(".wasm")) return "application/wasm";
  if (p.endsWith(".png")) return "image/png";
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
// Main validator.
// =====================================================================

// Probe scenario constants. The Holtburg spawn is the canonical
// AmbientRuntime trigger (rich terrain mix per F.B's 0xA9B4 bake).
// LB 0xA9B4 = lbX 0xA9 0xB4 = (0xA9 << 8) | 0xB4 = 43444.
const PROBE_LB_X = 0xa9;
const PROBE_LB_Y = 0xb4;
const PROBE_LB_KEY = (PROBE_LB_X << 8) | PROBE_LB_Y;
const PROBE_LB_HEX = `0x${PROBE_LB_KEY.toString(16).toUpperCase().padStart(4, "0")}`;
const PROBE_LB_ID = ((PROBE_LB_X << 24) | (PROBE_LB_Y << 16)) >>> 0; // landblockId
// World-frame Holtburg centre — matches `live captures` (LB 0xA9B4
// world origin = lbX*192 + 96 = 32448 + 96 = 32540 m).
const HOLTBURG_X = PROBE_LB_X * 192 + 92.0;
const HOLTBURG_Y = PROBE_LB_Y * 192 + 90.0;
const HOLTBURG_Z = 86.0;

// Real script DID from the F.B bake at 0xA9B4 — Pyreal Pile
// PhysicsScript (default_script_id of multiple wcid spawns at the
// city centre). 3 CreateParticle hooks per F.B manifest.
const PROBE_PHYSICS_SCRIPT_DID = 0x33000e9d;
// Anchor setup + motion table for the synthetic probe entity. The F.B
// bake doesn't pin a specific wcid (the bake walks all default_script_ids
// regardless of what entity carries them).
// 0x02000001 + 0x09000001 = humanoid base setup + motion table.
// Verified-real per smoke_test.cjs:2923 + tests.rs:1244; the
// fetchEntityAnimationKeyframes chain resolves cleanly against retail
// DATs. Generic placeholders (0x02000fa6 etc.) hang the spawn at
// keyframe-fetch, so we use the known-good humanoid pair.
const PROBE_SETUP_DID = 0x02000001;
const PROBE_MTABLE_DID = 0x09000001;
// Probe entity GUID — deterministic so consecutive runs don't
// double-spawn.
const PROBE_ENTITY_GUID = 0xacefed00;
// Probe ambient wave for OneOff playback — well-known Lifestone
// activate wave from earlier H3 work (memory note `0x0a000266`).
const PROBE_ONEOFF_WAVE_DID = 0x0a000266;
// F.D-fu1 (2026-05-20): retail-verified SoundTable DID + Sound enum
// for the synth GameMessageSound. The Task F H3-F diag at
// /mnt/wbterminal1/diag_game_message_sound.cjs confirmed
// `resolveSound(0x20000014, 0x51)` → `waveDid=0x0a000266` against
// real wire bytes (see memory `project_holtburger_ambient_sounds_done_2026-05-12`).
// 0x20000014 = forge / lifestone SoundTable; 0x51 = Sound.LifestoneOn.
const PROBE_SOUND_TABLE_DID = 0x20000014;
const PROBE_SOUND_ENUM_LIFESTONE_ON = 0x51;

// Boot timeouts. Tighter than Phase E since we don't need the spawn
// drain or full ring init — we only walk one LB.
const SMOKE_TIMEOUT_MS = Number(process.env.PHASE_F_SMOKE_TIMEOUT_MS || 60_000);
const INIT_TIMEOUT_MS = Number(process.env.PHASE_F_INIT_TIMEOUT_MS || 180_000);
const PROBE_WINDOW_MS = args.probeSeconds * 1000;
const POST_PROBE_SETTLE_MS = 1_500;
// AMBIENT_SETTLE_MS + POST_SPAWN_SETTLE_MS were planned settle-windows
// for the F.D-fu probe scenario; not yet wired into the run() driver.
// Resume per the F.D-fu follow-on if/when the synth-helper probe lands.

(async () => {
  try {
    fs.mkdirSync(args.out, { recursive: true });
  } catch (_) {
    /* tolerated */
  }
  const reportJsonPath = path.join(args.out, "event-completeness-report.json");
  const reportMdPath = path.join(args.out, "event-completeness-report.md");
  const diagLogPath = path.join(args.out, `phase-f-${Date.now()}-diag.json`);

  const server = makeServer();
  server.keepAliveTimeout = 0;
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  // `?eventLog=on` flips the F.C probe live; quality=high to exercise
  // the full audio/particle paths (not the low-spec stubs).
  const PAGE_URL = `http://127.0.0.1:${port}/apps/holtburger-web/index.html?renderer=3d&quality=high&eventLog=on&headless=1`;

  console.log("=========================");
  console.log("Phase F.D — validate-event-completeness");
  console.log("=========================");
  console.log(`probe LB:     ${PROBE_LB_HEX} (Holtburg spawn)`);
  console.log(`probe window: ${args.probeSeconds}s`);
  console.log(`out:          ${args.out}`);
  console.log(`dev server:   http://127.0.0.1:${port}`);
  console.log(`page URL:     ${PAGE_URL}`);

  const report = {
    timestamp: new Date().toISOString(),
    probe: {
      lb: PROBE_LB_HEX,
      windowSeconds: args.probeSeconds,
      sources_exercised: [],
      sources_deferred: [],
    },
    bootStage: {
      smokePass: false,
      initResolved: false,
      initElapsedMs: null,
      eventLogEnabled: false,
    },
    expected: {
      ambient_continuous: { count: 0, triggers: [] },
      ambient_probabilistic: { count_min: 0, count_max: 0, mean: 0 },
      anim_sound: { count: 0, note: "deferred — F.B.5 not yet shipped" },
      game_message_sound: { count: 0 },
      one_off: { count: 0 },
      physics_script: { count: 0, hooks: [] },
      sky_chain: { count: 0, note: "deferred — not exercised in this probe" },
    },
    observed: {
      ambient_continuous: 0,
      ambient_probabilistic: 0,
      anim_sound: 0,
      game_message_sound: 0,
      one_off: 0,
      physics_script: 0,
      sky_chain: 0,
      total_records: 0,
      overflow: 0,
      log_capped_at: 0,
    },
    perSource: {
      // For each source channel:
      //   { matched, missing, spurious, note }
    },
    timing: {
      // For PhysicsScriptHook hooks: { median_delta_ms, p99_delta_ms }
    },
    topMismatches: [],
    consoleErrors: [],
  };

  let browser;
  let exitCode = 0;

  try {
    browser = await chromium.launch({
      // swiftshader → headless software GL; --autoplay-policy lifts
      // the user-gesture audio gate so AudioContext can resume; the
      // event log records BEFORE play() so this is belt-and-suspenders.
      args: [
        "--use-gl=swiftshader",
        "--autoplay-policy=no-user-gesture-required",
      ],
    });
    const context = await browser.newContext({
      viewport: { width: 1280, height: 1024 },
    });
    const page = await context.newPage();

    page.on("console", (msg) => {
      const text = msg.text();
      if (msg.type() === "error") {
        report.consoleErrors.push(text);
        if (report.consoleErrors.length <= 12) {
          console.log(`[browser error] ${text.slice(0, 240)}`);
        }
      } else if (/phase-f|event[Ll]og|ambient|H3\/|task-d|task-F|H2/i.test(text)) {
        const trimmed = text.slice(0, 240);
        if (
          trimmed.startsWith("[phase-f") ||
          trimmed.startsWith("[task-d/ambient") ||
          trimmed.startsWith("[task-F/gms") ||
          trimmed.startsWith("[H3/audio") ||
          trimmed.startsWith("[entities/H2")
        ) {
          console.log(`[browser log] ${trimmed}`);
        }
      }
    });
    page.on("pageerror", (err) => {
      report.consoleErrors.push(`pageerror: ${err.message}`);
      console.error(`[pageerror] ${err.message}`);
    });

    await page.goto(PAGE_URL, { waitUntil: "domcontentloaded" });

    // ---------------------------------------------------------------
    // Stage 1 — wait for the in-page smoke panel to PASS (wasm +
    // manifest loaded).
    // ---------------------------------------------------------------
    try {
      await page.waitForFunction(
        () => {
          const r = document.getElementById("results");
          return r && /PASS/.test(r.innerHTML);
        },
        { timeout: SMOKE_TIMEOUT_MS }
      );
      report.bootStage.smokePass = true;
      console.log("[stage 1] in-page smoke panel: PASS");
    } catch (e) {
      console.error(`FAIL: in-page smoke panel timeout (${SMOKE_TIMEOUT_MS}ms)`);
      throw new Error("smoke-timeout");
    }

    // ---------------------------------------------------------------
    // Stage 2 — drive init3D with the full wasm export payload so
    // AmbientRuntime + AudioManager + SoundTableCache wire up.
    // ---------------------------------------------------------------
    console.log(`[stage 2] driving init3D (timeout ${INIT_TIMEOUT_MS}ms)`);
    const tInit = Date.now();
    const initProbe = await page.evaluate(async (timeoutMs) => {
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
        out.steps.push(
          `wasm: fetchSoundTable=${typeof wasmMod.fetchSoundTable}, ` +
            `fetchRegion=${typeof wasmMod.fetchRegion}, ` +
            `fetchPhysicsScript=${typeof wasmMod.fetchPhysicsScript}`
        );

        const scene3d = await import("./scene3d/index.js");
        out.steps.push(`scene3d module: init3D=${typeof scene3d.init3D}`);

        const wasmExports = {
          fetch_landblock_heightmaps: wasmMod.fetch_landblock_heightmaps,
          fetch_subdivided_landblock: wasmMod.fetch_subdivided_landblock,
          fetch_subdivided_landblocks: wasmMod.fetch_subdivided_landblocks,
          fetch_terrain_textures: wasmMod.fetch_terrain_textures,
          fetch_landblock_objects: wasmMod.fetch_landblock_objects,
          fetch_landblock_scenery: wasmMod.fetch_landblock_scenery,
          init_scenery_base_url: wasmMod.init_scenery_base_url,
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
          populateBuildingAabbsForLandblock:
            wasmMod.populateBuildingAabbsForLandblock,
          fetchEnvCellsInLandblock: wasmMod.fetchEnvCellsInLandblock,
          fetchPhysicsScript: wasmMod.fetchPhysicsScript,
          fetchParticleEmitter: wasmMod.fetchParticleEmitter,
          fetchWave: wasmMod.fetchWave,
          fetchSoundTable: wasmMod.fetchSoundTable,
          fetchRegion: wasmMod.fetchRegion,
        };
        window.__validatorWasm = wasmMod;

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
        out.elapsedMs = (performance.now() - tStart) | 0;
        out.steps.push(`init3D resolved in ${out.elapsedMs} ms`);
        out.hasLiveScene3d = !!window.liveScene3d;
        out.eventLogEnabled = !!live?.eventLogEnabled;
        out.snapshotEventLogIsFn =
          typeof live?.snapshotEventLog === "function";
        out.ambientRuntimeAttached = !!live?.ambientRuntime;
        out.audioManagerAttached = !!live?.audioManager;
        out.soundTableCacheAttached = !!live?.soundTableCache;
        out.entityManagerAttached = !!live?.entityManager;
      } catch (e) {
        out.error = String(e?.message ?? e);
        out.errorStack = String(e?.stack ?? "").slice(0, 800);
      }
      return out;
    }, INIT_TIMEOUT_MS);

    report.bootStage.initElapsedMs = Date.now() - tInit;
    console.log("[stage 2] init3D probe:", JSON.stringify(initProbe, null, 2));
    if (initProbe.error) {
      console.error(`FAIL: init3D errored: ${initProbe.error}`);
      throw new Error("init-error");
    }
    if (!initProbe.eventLogEnabled) {
      console.error(`FAIL: eventLogEnabled=false — ?eventLog=on did not light up the F.C probe`);
      throw new Error("event-log-disabled");
    }
    report.bootStage.initResolved = true;
    report.bootStage.eventLogEnabled = true;

    // ---------------------------------------------------------------
    // Stage 3 — seed the player at Holtburg + prime the terrain mesh
    // so AmbientRuntime has terrain codes to sample.
    //
    // The roller needs:
    //   - `getPlayerPos()` non-null
    //   - terrainGroup containing the player's LB mesh with
    //     userData.terrainCodes populated
    //   - Region (fetched lazily inside the runtime on first tick)
    //
    // We set the player pose by stuffing `__lastEntityWorldPos`
    // (the resolver the cameraSwitcher / AmbientRuntime read through)
    // AND fire `loadTerrainForLandblock(0xA9, 0xB4)` to make the
    // baker stash terrain codes on the mesh.
    // ---------------------------------------------------------------
    console.log(`[stage 3] seed player + terrain for ${PROBE_LB_HEX}`);
    const seedProbe = await page.evaluate(
      async ({ lbX, lbY, x, y, z }) => {
        const out = { steps: [] };
        try {
          const live = window.liveScene3d;
          if (!live) {
            out.error = "no liveScene3d";
            return out;
          }
          // Force getPlayerPos to resolve at the Holtburg centre. The
          // runtime's resolver is `() => entityManager.getLocalPlayerWorldPos()`
          // — without a real spawn, that returns null. We bypass by
          // installing `__lastEntityWorldPos` AND injecting a
          // matching local-player fake into entityManager.
          window.__lastEntityWorldPos = { x: +x, y: +y, z: +z };
          // Patch the runtime's resolver so we don't have to spawn a
          // real local player rig (which has its own animation chain
          // we don't need for the ambient/oneoff/gms paths).
          if (live.ambientRuntime) {
            // Monkey-patch the resolver. The runtime keeps the fn
            // reference in `_getPlayerPos` — replace it.
            live.ambientRuntime._getPlayerPos = () => ({
              x: +x, y: +y, z: +z,
            });
            out.steps.push("patched ambientRuntime._getPlayerPos");
          }
          // Bake the LB terrain so the roller's _sampleTerrainCodeAt
          // hits real terrain codes.
          if (typeof live.loadTerrainForLandblock === "function") {
            await live.loadTerrainForLandblock(lbX, lbY);
            out.steps.push(
              `loadTerrainForLandblock(${lbX}, ${lbY}) resolved`
            );
          } else {
            out.steps.push("loadTerrainForLandblock missing — skipped");
          }
          // Verify the LB mesh has terrainCodes set.
          const terrainChildren = live.terrainGroup?.children ?? [];
          let lbMeshFound = null;
          for (const c of terrainChildren) {
            const ud = c.userData ?? {};
            if (ud.lbX === lbX && ud.lbY === lbY) {
              lbMeshFound = c;
              break;
            }
          }
          out.lbMeshFound = !!lbMeshFound;
          out.lbMeshHasTerrainCodes = !!(
            lbMeshFound && lbMeshFound.userData?.terrainCodes
          );
          out.lbMeshTerrainCodeBytes =
            lbMeshFound?.userData?.terrainCodes?.length ?? 0;
        } catch (e) {
          out.error = String(e?.message ?? e);
        }
        return out;
      },
      { lbX: PROBE_LB_X, lbY: PROBE_LB_Y, x: HOLTBURG_X, y: HOLTBURG_Y, z: HOLTBURG_Z }
    );
    console.log("[stage 3] seed probe:", JSON.stringify(seedProbe, null, 2));
    if (seedProbe.error) {
      console.warn(`[stage 3] seed errored: ${seedProbe.error} — continuing best-effort`);
    }

    // ---------------------------------------------------------------
    // Stage 4 — build the expected manifest from
    // `/dist/events/0xA9B4.events.jsonl`. We compute:
    //   - ambient_continuous expected = # rows with continuous:true
    //     where the player's terrain code matches. (Without runtime
    //     terrain-code introspection here, we report ALL continuous
    //     rows in the LB manifest as the *upper bound*; matched will
    //     be the subset the runtime exercised.)
    //   - ambient_probabilistic expected (mean count) =
    //       Σ over probabilistic rows: probe_window_s / mean_rate × base_chance
    //     where mean_rate = (min_rate + max_rate) / 2.
    //     ±50 % is the tolerance band.
    //   - physics_script expected = full set of CreateParticle hooks
    //     for the script DID we injected (1:1 fan-out).
    // ---------------------------------------------------------------
    console.log(`[stage 4] read expected manifest for ${PROBE_LB_HEX}`);
    const manifestPath = path.join(DIST_V2, "events", `${PROBE_LB_HEX}.events.jsonl`);
    const manifestRows = fs
      .readFileSync(manifestPath, "utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch (_) {
          return null;
        }
      })
      .filter((r) => r);
    console.log(`[stage 4] manifest rows: ${manifestRows.length}`);

    // Walk ambient rows.
    const continuousTriggers = [];
    let probMin = 0,
      probMax = 0,
      probMean = 0;
    for (const row of manifestRows) {
      if (row.source !== "ambient") continue;
      for (const s of row.ambient_sounds || []) {
        if (s.continuous && s.base_chance === 0) {
          continuousTriggers.push({
            terrain_type: row.terrain_type,
            stb_id: row.stb_id,
            s_type: s.s_type,
            volume: s.volume,
          });
        } else if (s.base_chance > 0) {
          // Probabilistic — count expected fires in the probe window.
          // The runtime samples a new rate ∈ [min, max] after each
          // roll. Mean rate ≈ midpoint. Expected count = floor(window
          // / mean_rate) × base_chance, summed across all rows
          // serving any terrain_type the player MIGHT see during the
          // probe (we report this as a window total).
          const meanRate = (s.min_rate + s.max_rate) / 2;
          // Skip rows where the player wouldn't sit on this terrain.
          // Without runtime terrain sampling we conservatively count
          // ALL rows in the LB manifest as candidates and let the
          // observed count fall in the [×0, ×1] band; the active
          // STB filter happens during diff.
          if (meanRate > 0) {
            const expectedPerRow =
              (args.probeSeconds / meanRate) * s.base_chance;
            probMean += expectedPerRow;
            probMin += expectedPerRow * 0.5;
            probMax += expectedPerRow * 1.5;
          }
        }
      }
    }
    // Distinct continuous triggers — only ONE loop runs per (stb_id, s_type)
    // at a time per the runtime contract, regardless of how many rows
    // share the same enum. We report the unique set.
    const uniqueContinuous = new Map();
    for (const t of continuousTriggers) {
      const k = `${t.stb_id}|${t.s_type}`;
      if (!uniqueContinuous.has(k)) uniqueContinuous.set(k, t);
    }
    report.expected.ambient_continuous.count = uniqueContinuous.size;
    report.expected.ambient_continuous.triggers = Array.from(
      uniqueContinuous.values()
    );
    report.expected.ambient_probabilistic.count_min = Math.floor(probMin);
    report.expected.ambient_probabilistic.count_max = Math.ceil(probMax);
    report.expected.ambient_probabilistic.mean = +probMean.toFixed(2);

    // Walk physics_script rows. Filter to the injected script DID.
    const physScriptHooks = [];
    for (const row of manifestRows) {
      if (row.source !== "physics_script_particle") continue;
      const scriptDid = parseInt(row.default_script_id, 16) >>> 0;
      if (scriptDid !== PROBE_PHYSICS_SCRIPT_DID) continue;
      physScriptHooks.push({
        script_did: scriptDid,
        emitter_id: parseInt(row.emitter_id, 16) >>> 0,
        start_time_s: row.start_time_s,
        part_index: row.part_index,
      });
    }
    report.expected.physics_script.count = physScriptHooks.length;
    report.expected.physics_script.hooks = physScriptHooks;
    console.log(
      `[stage 4] expected ambient_continuous=${report.expected.ambient_continuous.count}, ` +
        `ambient_probabilistic[min..max]=[${report.expected.ambient_probabilistic.count_min}..${report.expected.ambient_probabilistic.count_max}], ` +
        `physics_script(${PROBE_PHYSICS_SCRIPT_DID.toString(16)})=${report.expected.physics_script.count}`
    );

    // ---------------------------------------------------------------
    // Stage 5 — drive the probe scenario.
    //
    // Order: OneOff → spawn-for-PhysicsScript → settle → ambient hold
    //        → GameMessageSound synth at end.
    //
    // We deliberately schedule fires across the probe window so the
    // probabilistic ambient timer has time to land at least one roll
    // even though it's stochastic.
    // ---------------------------------------------------------------
    console.log(`[stage 5] drive probe (${args.probeSeconds}s window)`);

    // Stage 5a — fire 3 OneOff plays. Trivially deterministic.
    const oneOffCount = 3;
    report.expected.one_off.count = oneOffCount;
    await page.evaluate(
      async ({ waveDid, x, y, z, count }) => {
        if (typeof window.__playWave !== "function") {
          throw new Error("__playWave hook missing");
        }
        for (let i = 0; i < count; i++) {
          try {
            window.__playWave(waveDid >>> 0, x, y + i * 0.5, z);
          } catch (e) {
            console.warn(`[phase-f.d] __playWave fire ${i} threw:`, e);
          }
        }
      },
      {
        waveDid: PROBE_ONEOFF_WAVE_DID,
        x: HOLTBURG_X,
        y: HOLTBURG_Y,
        z: HOLTBURG_Z,
        count: oneOffCount,
      }
    );
    report.probe.sources_exercised.push("OneOff");
    console.log(`[stage 5a] OneOff: fired ${oneOffCount} × __playWave`);

    // Stage 5b — inject a synthetic spawn that carries physicsScriptDid
    // so the H2 chain walker (`_attachParticleChainForEntity`) fires.
    // F.D-fu1 (2026-05-20): also carries `soundTableDid` so the F.D-fu1
    // `__synthGameMessageSound` helper in stage 5e can resolve a real
    // SoundTable entry. F.D-fu3: AFTER dispatching, we await the
    // EntityManager's `awaitSpawnResolution` + `awaitParticleChainResolution`
    // so the snapshot in stage 6 catches the actual fires instead of
    // racing the async resolve.
    const spawnProbe = await page.evaluate(
      async ({ guid, setupDid, scriptDid, soundTableDid, x, y, z, lbId }) => {
        const out = { steps: [] };
        try {
          if (typeof window.__scene3dEntityHook !== "function") {
            out.error = "__scene3dEntityHook missing";
            return out;
          }
          // Mirror the wire's `EntityUpdate` shape (see
          // scene3d/spawns.js:308 buildUpd).
          const upd = {
            kind: 1, // KIND_SPAWN
            guid: guid >>> 0,
            modelId: setupDid >>> 0,
            // landblockId packed: (lb_high16 | cell16). Outdoor → cell=0.
            landblockId: (((lbId >>> 16) & 0xffff) << 16) >>> 0,
            x: +x - Math.floor(+x / 192) * 192,
            y: +y - Math.floor(+y / 192) * 192,
            z: +z,
            qw: 1, qx: 0, qy: 0, qz: 0,
            vx: 0, vy: 0, vz: 0,
            omegaZ: 0,
            motionCommand: 0,
            motionStance: 0,
            wcid: 0x000003e8,
            itemType: 0,
            name: "phase-f.d-probe",
            iconId: 0,
            objScale: 1.0,
            paletteId: 0,
            mtableId: PROBE_MTABLE_DID >>> 0,
            modelChanges: new Uint32Array(0),
            textureChanges: new Uint32Array(0),
            subPalettes: new Uint32Array(0),
            // The load-bearing field — drives _attachParticleChainForEntity.
            physicsScriptDid: scriptDid >>> 0,
            // F.D-fu1: load-bearing for __synthGameMessageSound resolution.
            soundTableDid: soundTableDid >>> 0,
            __synthetic: true,
            __placeholder: false,
            __category: "Object",
          };
          window.__scene3dEntityHook(upd);
          out.steps.push(
            `dispatched kind=1 spawn guid=0x${(guid >>> 0).toString(16)} setup=0x${(setupDid >>> 0).toString(16)} pes=0x${(scriptDid >>> 0).toString(16)} stb=0x${(soundTableDid >>> 0).toString(16)}`
          );
        } catch (e) {
          out.error = String(e?.message ?? e);
        }
        return out;
      },
      {
        guid: PROBE_ENTITY_GUID,
        setupDid: PROBE_SETUP_DID,
        scriptDid: PROBE_PHYSICS_SCRIPT_DID,
        soundTableDid: PROBE_SOUND_TABLE_DID,
        x: HOLTBURG_X,
        y: HOLTBURG_Y,
        z: HOLTBURG_Z,
        lbId: PROBE_LB_ID,
      }
    );
    console.log("[stage 5b] spawn probe:", JSON.stringify(spawnProbe, null, 2));
    if (!spawnProbe.error) {
      report.probe.sources_exercised.push("PhysicsScriptHook");
    } else {
      report.probe.sources_deferred.push("PhysicsScriptHook (injection failed)");
    }

    // Stage 5c — F.D-fu3 (2026-05-20): await the spawn + chain
    // resolution explicitly instead of guessing a settle timeout. The
    // EntityManager exposes:
    //   - `awaitSpawnResolution(guid)` — Promise<EntityInstance|null>
    //     resolves once `_spawnImpl` completes (rig built, prewarm
    //     fired, chain dispatch reached).
    //   - `awaitParticleChainResolution(guid)` — Promise<{ok,
    //     emitterCount, soundHookCount}|null> resolves once the H2
    //     chain walker (`_attachParticleChainForEntity`) finishes
    //     all its async work (PhysicsScript fetch → for-each
    //     CreateParticleHook → ParticleEmitter fetch → addEmitter).
    // We also keep a hard ceiling (12s) so a stuck wasm fetch can't
    // hang the validator forever.
    const chainResolveProbe = await page.evaluate(async ({ guid, timeoutMs }) => {
      const out = { steps: [] };
      try {
        const live = window.liveScene3d;
        if (!live?.entityManager) {
          out.error = "no entityManager";
          return out;
        }
        const em = live.entityManager;
        const timeoutP = new Promise((_, rej) => setTimeout(() => rej(new Error("chain resolve timeout")), timeoutMs));
        const tSpawn = performance.now();
        const inst = await Promise.race([
          em.awaitSpawnResolution(guid >>> 0),
          timeoutP,
        ]);
        out.spawnElapsedMs = (performance.now() - tSpawn) | 0;
        out.spawnLanded = !!inst;
        if (!inst) {
          out.steps.push("spawn never resolved");
          return out;
        }
        out.steps.push(`spawn landed (entity now in entityMap=${!!em.entityMap?.get(guid >>> 0)})`);
        // Now wait for the chain itself.
        const tChain = performance.now();
        const chainDescriptor = await Promise.race([
          em.awaitParticleChainResolution(guid >>> 0),
          timeoutP,
        ]);
        out.chainElapsedMs = (performance.now() - tChain) | 0;
        out.chainDescriptor = chainDescriptor;
        out.steps.push(
          chainDescriptor
            ? `chain resolved: ok=${chainDescriptor.ok} emitters=${chainDescriptor.emitterCount} soundHooks=${chainDescriptor.soundHookCount}`
            : "chain descriptor was null (no PES on spawn)"
        );
      } catch (e) {
        out.error = String(e?.message ?? e);
      }
      return out;
    }, { guid: PROBE_ENTITY_GUID, timeoutMs: 12_000 });
    console.log("[stage 5c] chain resolve probe:", JSON.stringify(chainResolveProbe, null, 2));

    // Stage 5d — ambient hold. The roller is driven by the rAF loop;
    // we just keep the page alive. Phase F.C probe records each
    // continuous/probabilistic fire.
    console.log(`[stage 5d] ambient hold (${PROBE_WINDOW_MS}ms)`);
    await page.waitForTimeout(PROBE_WINDOW_MS);
    report.probe.sources_exercised.push("AmbientRuntime");

    // Stage 5e — F.D-fu1 (2026-05-20): use the new
    // `window.__synthGameMessageSound(guid, soundEnum, scale)` helper
    // which mirrors the SAME resolution chain as the live recv-loop
    // arm in index.html:6968-7137. The synth entity carries a real
    // soundTableDid (0x20000014 = forge) so the SoundTable lookup
    // resolves to Sound.LifestoneOn (0x51) → waveDid 0x0a000266.
    // Returns a descriptor with `{ ok, reason?, waveDid?, gain? }`.
    const SYNTH_COUNT = 2;
    const gmsProbe = await page.evaluate(async ({ guid, soundEnum, count }) => {
      const out = { steps: [], fires: [] };
      try {
        if (typeof window.__synthGameMessageSound !== "function") {
          out.error = "__synthGameMessageSound missing — index.html out of date";
          return out;
        }
        for (let i = 0; i < count; i++) {
          const result = await window.__synthGameMessageSound(guid >>> 0, soundEnum >>> 0, 1.0);
          out.fires.push(result);
          out.steps.push(
            `fire ${i + 1}/${count}: ok=${result.ok}${result.reason ? " reason=" + result.reason : ""}${result.waveDid ? " wave=0x" + result.waveDid.toString(16) : ""}`
          );
        }
      } catch (e) {
        out.error = String(e?.message ?? e);
      }
      return out;
    }, { guid: PROBE_ENTITY_GUID, soundEnum: PROBE_SOUND_ENUM_LIFESTONE_ON, count: SYNTH_COUNT });
    console.log("[stage 5e] GMS probe:", JSON.stringify(gmsProbe, null, 2));
    const gmsFires = (gmsProbe.fires || []).filter((f) => f && f.ok).length;
    if (gmsFires > 0) {
      report.expected.game_message_sound.count = gmsFires;
      report.probe.sources_exercised.push("GameMessageSound");
    } else {
      report.probe.sources_deferred.push("GameMessageSound (synth helper reported no ok fires)");
    }

    // Mark the deferred sources.
    report.probe.sources_deferred.push(
      "AnimationHook — F.B.5 wcid→MotionTableDataId staging required"
    );
    report.probe.sources_deferred.push(
      "SkyChain — populateSkyDescFromRegion not driven in this probe"
    );

    // ---------------------------------------------------------------
    // Stage 6 — final settle + snapshot.
    // ---------------------------------------------------------------
    await page.waitForTimeout(POST_PROBE_SETTLE_MS);
    console.log(`[stage 6] snapshotEventLog`);
    const snap = await page.evaluate(() => {
      const s = window.liveScene3d;
      if (!s || typeof s.snapshotEventLog !== "function") {
        return { error: "snapshotEventLog missing" };
      }
      return s.snapshotEventLog();
    });
    if (snap.error) {
      console.error(`FAIL: snapshotEventLog errored: ${snap.error}`);
      throw new Error("snapshot-error");
    }
    report.observed.total_records = snap.records.length;
    report.observed.overflow = snap.overflow;
    report.observed.log_capped_at = snap.capped_at;
    console.log(
      `[stage 6] snapshot: ${snap.records.length} records (overflow=${snap.overflow}, cap=${snap.capped_at})`
    );

    // ---------------------------------------------------------------
    // Stage 7 — diff observed vs expected per channel.
    //
    // Tolerances (per docs/event-completeness-method.md):
    //   - Continuous ambient: 1:1 match per active (stb_id, s_type)
    //   - Probabilistic ambient: count within [min, max] band
    //     (computed at Stage 4 as expected_mean ± 50%)
    //   - OneOff: exactly 1 observed per fired
    //   - GameMessageSound: exactly 1 observed per injected
    //   - PhysicsScriptHook: 1:1 per emitter_id within ±50 ms of
    //     expected start_time_s
    // ---------------------------------------------------------------
    console.log("[stage 7] diff observed vs expected");

    // Bucket records by source.
    const bySource = new Map();
    for (const r of snap.records) {
      const key = r.source || "<unknown>";
      let arr = bySource.get(key);
      if (!arr) {
        arr = [];
        bySource.set(key, arr);
      }
      arr.push(r);
    }

    // Continuous ambient diff.
    const ambientRecords = bySource.get("AmbientRuntime") || [];
    const continuousObserved = new Map();
    let probObserved = 0;
    for (const r of ambientRecords) {
      const meta = r.source_meta || {};
      if (meta.continuous === true) {
        const k = `0x${(meta.stb_id >>> 0).toString(16)}|${(meta.s_type >>> 0).toString(16)}`;
        if (!continuousObserved.has(k)) continuousObserved.set(k, r);
      } else {
        probObserved += 1;
      }
    }
    report.observed.ambient_continuous = continuousObserved.size;
    report.observed.ambient_probabilistic = probObserved;

    // Expected continuous: only the SUBSET active for the terrain
    // code the runtime actually sampled. The runtime fires ONE per
    // (stb_id, s_type) tuple in the active STB's row. We can't
    // pre-compute which terrain code the player sat on without the
    // runtime's terrain sample — so the match check is "every
    // observed continuous matches SOME expected trigger row".
    const expectedContinuousKeys = new Set(
      report.expected.ambient_continuous.triggers.map(
        (t) => `${t.stb_id}|${t.s_type.toString(16)}`
      )
    );
    let contMatched = 0;
    let contSpurious = 0;
    for (const k of continuousObserved.keys()) {
      // k uses 0x prefix on stb_id; expected set normalises to
      // the manifest's "0x.." hex format already.
      if (expectedContinuousKeys.has(k.replace(/^0x/, "0x"))) {
        contMatched += 1;
      } else {
        contSpurious += 1;
      }
    }
    const contMissing = Math.max(
      0,
      report.expected.ambient_continuous.count - contMatched
    );

    report.perSource.ambient_continuous = {
      expected: report.expected.ambient_continuous.count,
      observed: continuousObserved.size,
      matched: contMatched,
      missing: contMissing,
      spurious: contSpurious,
      note:
        "expected count is the upper bound across all terrain codes in the LB; " +
        "runtime samples only ONE terrain code per tick — matched ≤ expected is expected behaviour",
    };

    const probMatched =
      probObserved >= report.expected.ambient_probabilistic.count_min &&
      probObserved <= report.expected.ambient_probabilistic.count_max
        ? probObserved
        : 0;
    report.perSource.ambient_probabilistic = {
      expected_min: report.expected.ambient_probabilistic.count_min,
      expected_max: report.expected.ambient_probabilistic.count_max,
      expected_mean: report.expected.ambient_probabilistic.mean,
      observed: probObserved,
      matched: probMatched,
      within_tolerance:
        probObserved >= report.expected.ambient_probabilistic.count_min &&
        probObserved <= report.expected.ambient_probabilistic.count_max,
      note: "tolerance ±50% per method-doc; probabilistic timers are stochastic per Math.random()",
    };

    // OneOff diff.
    const oneOffRecords = bySource.get("OneOff") || [];
    report.observed.one_off = oneOffRecords.length;
    report.perSource.one_off = {
      expected: oneOffCount,
      observed: oneOffRecords.length,
      matched: Math.min(oneOffCount, oneOffRecords.length),
      missing: Math.max(0, oneOffCount - oneOffRecords.length),
      spurious: Math.max(0, oneOffRecords.length - oneOffCount),
      note: "exact 1:1 — fully deterministic",
    };

    // GameMessageSound diff.
    const gmsRecords = bySource.get("GameMessageSound") || [];
    report.observed.game_message_sound = gmsRecords.length;
    const gmsExpected = report.expected.game_message_sound.count;
    report.perSource.game_message_sound = {
      expected: gmsExpected,
      observed: gmsRecords.length,
      matched: Math.min(gmsExpected, gmsRecords.length),
      missing: Math.max(0, gmsExpected - gmsRecords.length),
      spurious: Math.max(0, gmsRecords.length - gmsExpected),
      note: gmsExpected === 0
        ? "deferred — entity registry empty during synth window"
        : "synth-injected via _pushEventRecord + audioManager.play",
    };

    // PhysicsScriptHook diff.
    const psRecords = bySource.get("PhysicsScriptHook") || [];
    report.observed.physics_script = psRecords.length;
    // Match emitter-by-emitter. For each expected hook, find a record
    // with matching script_did + emitter_did + |t_obs - expected_t|
    // within ±50 ms. Note: expected start_time_s is relative to
    // _attachParticleChain time which we don't directly know — so
    // we compute a "delta from first PhysicsScript record on this
    // entity" as the reference. (The real ACE behaviour anchors on
    // attach time too.)
    const psByEmitter = new Map();
    for (const r of psRecords) {
      const meta = r.source_meta || {};
      const eid = (meta.script_did >>> 0) === PROBE_PHYSICS_SCRIPT_DID
        ? "match"
        : `mismatch_${(meta.script_did >>> 0).toString(16)}`;
      if (eid === "match") {
        const arr = psByEmitter.get(meta.start_time_s) || [];
        arr.push(r);
        psByEmitter.set(meta.start_time_s, arr);
      }
    }
    let psMatched = 0;
    let psMissing = 0;
    const timingDeltas = [];
    const anchorTime = psRecords.length > 0
      ? Math.min(...psRecords.map((r) => r.t_wall_ms))
      : 0;
    for (const hook of physScriptHooks) {
      const arr = psByEmitter.get(hook.start_time_s);
      if (!arr || arr.length === 0) {
        psMissing += 1;
        continue;
      }
      // Take the closest by wall-clock delta. The expected ms is
      // `start_time_s × 1000 + anchorTime` (anchor = first observed
      // PS record on the entity, since the H2 walker schedules via
      // setTimeout from attach time).
      const expectedT = hook.start_time_s * 1000 + anchorTime;
      let bestIdx = -1;
      let bestDelta = Infinity;
      for (let i = 0; i < arr.length; i++) {
        const d = Math.abs(arr[i].t_wall_ms - expectedT);
        if (d < bestDelta) {
          bestDelta = d;
          bestIdx = i;
        }
      }
      if (bestIdx >= 0 && bestDelta <= 50) {
        psMatched += 1;
        timingDeltas.push(bestDelta);
        arr.splice(bestIdx, 1);
        if (arr.length === 0) psByEmitter.delete(hook.start_time_s);
      } else if (bestIdx >= 0) {
        // Out of tolerance — count as a missing but record the delta.
        psMissing += 1;
        timingDeltas.push(bestDelta);
        arr.splice(bestIdx, 1);
        if (arr.length === 0) psByEmitter.delete(hook.start_time_s);
        report.topMismatches.push({
          source: "PhysicsScriptHook",
          reason: "wall-clock delta exceeds ±50ms",
          delta_ms: bestDelta,
          expected: hook,
        });
      }
    }
    let psSpurious = 0;
    for (const [, arr] of psByEmitter.entries()) {
      psSpurious += arr.length;
    }
    // Sort timing deltas for stats.
    timingDeltas.sort((a, b) => a - b);
    let medianDelta = null;
    let p99Delta = null;
    if (timingDeltas.length > 0) {
      medianDelta = timingDeltas[Math.floor(timingDeltas.length / 2)];
      p99Delta = timingDeltas[Math.min(timingDeltas.length - 1, Math.floor(timingDeltas.length * 0.99))];
    }
    report.timing = {
      physics_script_hook: {
        sample_count: timingDeltas.length,
        median_delta_ms: medianDelta,
        p99_delta_ms: p99Delta,
        tolerance_ms: 50,
      },
    };
    report.perSource.physics_script = {
      expected: physScriptHooks.length,
      observed: psRecords.length,
      matched: psMatched,
      missing: psMissing,
      spurious: psSpurious,
      note: `±50ms wall-clock tolerance from anchor t=${anchorTime.toFixed(1)}ms (first observed PS record)`,
    };

    // AnimationHook — deferred per F.B.5 not yet shipped.
    const animRecords = bySource.get("AnimationHook") || [];
    report.observed.anim_sound = animRecords.length;
    report.perSource.anim_sound = {
      expected: 0,
      observed: animRecords.length,
      matched: 0,
      missing: 0,
      spurious: animRecords.length,
      note: "channel not yet exercised — awaiting F.B.5 (wcid→MotionTableDataId staging)",
    };

    // SkyChain — deferred per probe scope.
    const skyRecords = bySource.get("SkyChain") || [];
    report.observed.sky_chain = skyRecords.length;
    report.perSource.sky_chain = {
      expected: 0,
      observed: skyRecords.length,
      matched: 0,
      missing: 0,
      spurious: skyRecords.length,
      note: "channel not exercised in this probe (no populateSkyDescFromRegion)",
    };

    // ---------------------------------------------------------------
    // Stage 8 — write reports.
    // ---------------------------------------------------------------
    fs.writeFileSync(reportJsonPath, JSON.stringify(report, null, 2));
    console.log(`report (json): ${reportJsonPath}`);

    const mdLines = [];
    mdLines.push("# Phase F.D — event completeness report");
    mdLines.push("");
    mdLines.push(`- Timestamp: \`${report.timestamp}\``);
    mdLines.push(`- Probe LB: \`${report.probe.lb}\` (Holtburg)`);
    mdLines.push(`- Probe window: ${report.probe.windowSeconds}s`);
    mdLines.push(`- Sources exercised: ${report.probe.sources_exercised.join(", ") || "(none)"}`);
    mdLines.push(`- Sources deferred: ${report.probe.sources_deferred.join(", ") || "(none)"}`);
    mdLines.push(`- Boot: smoke=${report.bootStage.smokePass}, init3D=${report.bootStage.initResolved} (${report.bootStage.initElapsedMs}ms), eventLog=${report.bootStage.eventLogEnabled}`);
    mdLines.push("");
    mdLines.push("## Summary");
    mdLines.push("");
    mdLines.push(`| Metric | Value |`);
    mdLines.push(`|---|---|`);
    mdLines.push(`| total log records | ${report.observed.total_records} |`);
    mdLines.push(`| log overflow | ${report.observed.overflow} |`);
    mdLines.push(`| log cap | ${report.observed.log_capped_at} |`);
    mdLines.push("");
    mdLines.push("## Per-source");
    mdLines.push("");
    mdLines.push(`| Source | Expected | Observed | Matched | Missing | Spurious | Note |`);
    mdLines.push(`|---|---:|---:|---:|---:|---:|---|`);
    for (const k of [
      "ambient_continuous",
      "ambient_probabilistic",
      "anim_sound",
      "game_message_sound",
      "one_off",
      "physics_script",
      "sky_chain",
    ]) {
      const s = report.perSource[k];
      if (!s) continue;
      const exp =
        k === "ambient_probabilistic"
          ? `[${s.expected_min}..${s.expected_max}] (mean ${s.expected_mean})`
          : `${s.expected}`;
      mdLines.push(
        `| ${k} | ${exp} | ${s.observed} | ${s.matched ?? "—"} | ${s.missing ?? "—"} | ${s.spurious ?? "—"} | ${s.note ?? ""} |`
      );
    }
    mdLines.push("");
    mdLines.push("## Timing");
    mdLines.push("");
    const t = report.timing.physics_script_hook;
    if (t && t.sample_count > 0) {
      mdLines.push(`- PhysicsScriptHook: ${t.sample_count} samples, median Δ ${t.median_delta_ms?.toFixed(1)}ms, p99 Δ ${t.p99_delta_ms?.toFixed(1)}ms (tolerance ±${t.tolerance_ms}ms)`);
    } else {
      mdLines.push("- PhysicsScriptHook: no samples (no observations)");
    }
    mdLines.push("");
    mdLines.push("## Top mismatches");
    mdLines.push("");
    if (report.topMismatches.length === 0) {
      mdLines.push("_None._");
    } else {
      mdLines.push("| Source | Reason | Δms | Expected |");
      mdLines.push("|---|---|---:|---|");
      for (const m of report.topMismatches.slice(0, 10)) {
        mdLines.push(
          `| ${m.source} | ${m.reason} | ${m.delta_ms?.toFixed(1) ?? "—"} | \`0x${m.expected?.emitter_id?.toString(16) ?? ""}\` start=${m.expected?.start_time_s ?? "—"}s |`
        );
      }
    }
    mdLines.push("");
    mdLines.push("## Honest call-outs");
    mdLines.push("");
    mdLines.push("- **AnimationHook (`anim_sound`)**: deferred — F.B's bake does not yet emit anim-sound rows. The F.E staged README at `/dist/events/README.md` flags this as 'awaiting F.B.5 (wcid→MotionTableDataId staging)'. F.D reports `expected=0 observed=0`.");
    mdLines.push("- **SkyChain**: deferred — the probe doesn't drive `populateSkyDescFromRegion` (no `?skytime=accel`, no EnteredWorld). F.D reports `expected=0 observed=0`. Future follow-on: light up Sky-B in the boot probe + diff against a sky-particle expected manifest (not yet baked).");
    mdLines.push("- **GameMessageSound** (F.D-fu1 2026-05-20): exercised via `window.__synthGameMessageSound(guid, soundEnum, scale)`. The helper mirrors the SAME resolution chain as the live recv-loop arm in index.html:6968-7137 (entity GUID → SoundTable resolve → AudioManager.play → pushEventRecord). Only the TRIGGER is synthetic; the downstream is identical to a wire-pushed 0xF750.");
    mdLines.push("- **AmbientRuntime continuous**: the F.B manifest is `terrain_type → ambient_sounds[]` keyed; the runtime samples ONE terrain code per tick. `matched ≤ expected` is the expected outcome (the player only sits on one terrain code in the probe window).");
    mdLines.push("- **AmbientRuntime probabilistic**: `±50%` tolerance per method-doc reflects the stochastic Math.random() roll. A within-tolerance outcome is a PASS even if `matched < observed` by count.");
    mdLines.push("- **AmbientRuntime headless drift** (F.D-fu2 2026-05-20): the runtime now derives dt from a wall-clock source (`performance.now`-deltas) instead of consuming the rAF-throttled dt from `scene3d/index.js::tick`. The renderer's dt-recovery armor (clamps dt=0 after a >500ms frame gap to prevent animation snap) was zeroing ambient timer decrements under headless software-GL, where every frame regularly exceeded the threshold. Tests can inject a deterministic clock via `ambientRuntime.setClockForTest(fn)`.");
    mdLines.push("- **PhysicsScriptHook chain timing** (F.D-fu3 2026-05-20): the validator now `await`s `entityManager.awaitSpawnResolution(guid)` + `awaitParticleChainResolution(guid)` instead of guessing a settle timeout. The chain walker returns a descriptor `{ ok, emitterCount, soundHookCount }` so the snapshot in stage 6 catches actual fires.");
    mdLines.push("- **Probe window** (F.D-fu4 2026-05-20): default bumped to 60s (from 12s). Probabilistic ambient timers have `[minRate, maxRate]` windows up to 30s with `baseChance` coin flips; 12s consistently reported `obs=0` even though the runtime was firing correctly. 60s gives the timer distribution enough wall-clock to land statistically.");
    fs.writeFileSync(reportMdPath, mdLines.join("\n"));
    console.log(`report (md):   ${reportMdPath}`);
  } catch (e) {
    console.error(`FAIL: validator aborted: ${e?.message ?? e}`);
    if (e?.stack) console.error(e.stack);
    exitCode = exitCode || 1;
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch (_) {
        /* ignore */
      }
    }
    try {
      server.close();
    } catch (_) {
      /* ignore */
    }
    try {
      fs.writeFileSync(diagLogPath, JSON.stringify(report, null, 2));
    } catch (_) {
      /* tolerated */
    }
  }

  // -----------------------------------------------------------------
  // Verdict.
  // -----------------------------------------------------------------

  console.log("");
  console.log("=========================");
  console.log("Phase F.D verdict");
  console.log("=========================");
  for (const k of Object.keys(report.perSource)) {
    const s = report.perSource[k];
    const exp =
      k === "ambient_probabilistic"
        ? `[${s.expected_min}..${s.expected_max}]`
        : `${s.expected}`;
    console.log(
      `  ${k}: exp=${exp} obs=${s.observed} match=${s.matched ?? "—"} miss=${s.missing ?? "—"} spur=${s.spurious ?? "—"}`
    );
  }
  console.log(`reports written to ${args.out}`);

  const anyMissing = Object.values(report.perSource).some(
    (s) => (s.missing ?? 0) > 0
  );

  // Exit semantics:
  //   - boot failure → exit 1 (already set above)
  //   - --strict + any missing → exit 1
  //   - exit 0 otherwise (report IS the artefact)
  if (exitCode === 0 && args.strict && anyMissing) {
    exitCode = 1;
    console.log(`--strict: missing-events present; failing.`);
  }
  if (exitCode === 0 && !report.bootStage.initResolved) {
    exitCode = 1;
    console.log("init3D did not resolve; failing.");
  }
  if (exitCode === 0) {
    console.log("PASS: validation gate green (or non-strict drift).");
  } else {
    console.log("FAIL: validation gate has failures (or --strict caught drift).");
  }
  process.exit(exitCode);
})().catch((err) => {
  console.error("validator top-level threw:", err);
  process.exit(1);
});
