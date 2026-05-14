// Phase E — `validate-landblock-completeness`
//
// **What this tool does:** boots the holtburger-web renderer end-to-
// end in a headless Chromium against the production v2 bake at
// `/mnt/wbterminal1/holtburger-dist-v2/`, waits for the 13×13 ring
// (169 LBs) bake to settle, then asserts the load-bearing contract
// from `docs/hypotheticalmethod.md`:
//
// ```
// rendered_placements ≡ {
//   ∀ p ∈ LandblockInfo.objects        (DAT explicit, fetch_landblock_objects)
//   ∪ ∀ p ∈ scenery_bake[lb]            (DAT baked,    fetch_landblock_scenery)
//   ∪ ∀ p ∈ landblock_instance[lb]      (ACE explicit, fetch_landblock_spawns)
// }
// ```
//
// for every LB in a target ring. Anything in `expected` not in
// `rendered` is a **missing-render**; anything in `rendered` not in
// `expected` is an **invented placement** (worse, since the renderer
// would be making things up). Both are findings to surface, not paper
// over — the renderer is a pure consumer of placement data, and this
// validator IS the source of truth.
//
// **Why headless** — the contract is "what the renderer actually puts
// on screen". An offline JSON-vs-JSON diff would miss any drift that
// happens at the wasm→JS→three.js boundary (e.g. fetch errors silently
// dropping placements, geometry-failure dropping a mesh, the LB-key
// drift bug Phase B.4 caught, etc.). Running through real init3D walks
// the same data path the live page does.
//
// **InstancedMesh walk** — F#5+6 collapses N duplicate-modelId static
// placements into one `THREE.InstancedMesh` per modelId. So
// `staticsGroup.children.length ≠ placement count`. We walk via
// `obj.getMatrixAt(i)` for every `obj.isInstancedMesh === true`, and
// expand each instance matrix back to a placement. LODs are walked
// at their highest-detail child (index 0). Singleton `THREE.Mesh`
// nodes are taken at face value.
//
// **World-frame convention** — the brief warned about an `acToThree`
// inverse. In practice the three groups (`statics`, `buildings`,
// `entities`) ALL store their meshes' positions in AC-world frame
// directly — the only AC→three transform is `worldRoot.rotation.x =
// -π/2` applied at the group level. So `getMatrixAt(i).decompose(pos)`
// returns AC-world coords directly. `lb_x = floor(pos.x / 192)`,
// `lb_y = floor(pos.y / 192)`. No inverse needed. (See
// `scene3d/statics.js:486-490` `mesh.position.set(worldX, worldY, z)`
// and `scene3d/buildings.js:194-198` `placementGroup.position.set(...)`
// and `scene3d/entities.js:698-701` `inst.setPose(wx, wy, wz, ...)`.)
//
// **Match tolerance** — `(model_id_or_wcid, lb_x, lb_y, x ± 0.05m,
// y ± 0.05m, z ± 0.10m)`. Quaternion + scale are reported in the diff
// log but NOT used for match keying (a placement at the right slot but
// wrong orientation is still a worthwhile finding to surface, just at
// a different severity than a missing placement).
//
// **Outputs**
//   - `<out>/completeness-report.json` — machine-readable diff
//   - `<out>/completeness-report.md`   — human-readable summary
//
// **CLI args**
//   --ring   minLb..maxLb  (default `0xA3AE..0xAFBA`; the 13×13 ring)
//   --out    dir           (default `/mnt/wbterminal1/tmp/claude-scratch/scenery-bake/e/`)
//   --strict               (treat any drift as exit 1; default 0 if
//                           all matches and the ring bake completed)
//
// Run:
//   NODE_PATH=/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules \
//     node validate_landblock_completeness.cjs

const path = require("node:path");
const fs = require("node:fs");
const http = require("node:http");

// =====================================================================
// CLI parsing
// =====================================================================

function parseArgs(argv) {
  const args = {
    ring: { min: 0xa3ae, max: 0xafba },
    out: "/mnt/wbterminal1/tmp/claude-scratch/scenery-bake/e/",
    strict: false,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--strict") {
      args.strict = true;
    } else if (a === "--ring") {
      const v = argv[i + 1];
      i += 1;
      const m = /^0x([0-9a-fA-F]+)\.\.0x([0-9a-fA-F]+)$/.exec(v);
      if (!m) {
        console.error(`FAIL: --ring expects format 0xMINLB..0xMAXLB; got '${v}'`);
        process.exit(2);
      }
      args.ring.min = parseInt(m[1], 16);
      args.ring.max = parseInt(m[2], 16);
    } else if (a === "--out") {
      args.out = argv[i + 1];
      i += 1;
    } else {
      console.error(`FAIL: unknown arg '${a}'. Usage: --ring 0xAAAA..0xBBBB --out DIR [--strict]`);
      process.exit(2);
    }
  }
  return args;
}

const args = parseArgs(process.argv);

// Compose the LB list from the ring rectangle. The default ring
// 0xA3AE..0xAFBA corresponds to lbX ∈ {0xA3..0xAF} × lbY ∈ {0xAE..0xBA}
// = 13 × 13 = 169 LBs, the same ring the world-expand capture uses.
function ringLbList(min, max) {
  const minX = (min >> 8) & 0xff;
  const minY = min & 0xff;
  const maxX = (max >> 8) & 0xff;
  const maxY = max & 0xff;
  const out = [];
  for (let x = minX; x <= maxX; x += 1) {
    for (let y = minY; y <= maxY; y += 1) {
      out.push((x << 8) | y);
    }
  }
  return out;
}

const RING_LBS = ringLbList(args.ring.min, args.ring.max);

// =====================================================================
// Playwright discovery — mirror the world-expand capture pattern.
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
// Self-hosted dev server — same setup as `capture_world_expand_e2e.cjs`.
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
if (!fs.existsSync(path.join(DIST_V2, "spawns/source.sha256"))) {
  console.error(
    `FAIL: spawns dir missing at ${DIST_V2}/spawns. Re-stage via Phase D.1 first.`
  );
  process.exit(2);
}
if (!fs.existsSync(path.join(DIST_V2, "scenery"))) {
  console.error(
    `FAIL: scenery dir missing at ${DIST_V2}/scenery. Re-stage via Phase C.1 first.`
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

const SMOKE_TIMEOUT_MS = Number(process.env.PHASE_E_SMOKE_TIMEOUT_MS || 60_000);
const INIT_TIMEOUT_MS = Number(process.env.PHASE_E_INIT_TIMEOUT_MS || 240_000);
const SETTLE_MS = Number(process.env.PHASE_E_SETTLE_MS || 20_000);
const SPAWN_LOAD_TIMEOUT_MS = Number(
  process.env.PHASE_E_SPAWN_LOAD_TIMEOUT_MS || 180_000
);
const SPAWN_DRAIN_POLL_MS = Number(
  process.env.PHASE_E_SPAWN_DRAIN_POLL_MS || 90_000
);

// Match tolerance. Per the brief.
const POS_XY_TOLERANCE_M = 0.05;
const POS_Z_TOLERANCE_M = 0.10;
const METERS_PER_LANDBLOCK = 192.0;
const TOP_N_DIVERGENCES = 20;

// LB-key encoding helpers. The LB id is `0xXXYY0000` with XX = lbX
// byte, YY = lbY byte. Two encodings appear in the codebase:
//  - "LB key": top 16 bits packed into the high half of u32.
//  - "LandblockInfo cell id": `0xXXYYFFFE` (XX, YY, FFFE marker).
function lbKeyFromXY(lbX, lbY) {
  return ((lbX & 0xff) << 24) | ((lbY & 0xff) << 16);
}
function lbCellIdFromXY(lbX, lbY) {
  return lbKeyFromXY(lbX, lbY) | 0xfffe;
}
function hexLb(lbX, lbY) {
  return `0x${((lbX << 8) | lbY).toString(16).toUpperCase().padStart(4, "0")}`;
}
function hexU32(v) {
  return `0x${(v >>> 0).toString(16).toUpperCase().padStart(8, "0")}`;
}

(async () => {
  try {
    fs.mkdirSync(args.out, { recursive: true });
  } catch (_) {
    /* tolerated */
  }
  const reportJsonPath = path.join(args.out, "completeness-report.json");
  const reportMdPath = path.join(args.out, "completeness-report.md");
  const diagLogPath = path.join(args.out, `phase-e-${Date.now()}-diag.json`);

  const server = makeServer();
  server.keepAliveTimeout = 0;
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const PAGE_URL = `http://127.0.0.1:${port}/apps/holtburger-web/index.html?renderer=3d&quality=high`;

  console.log("=========================");
  console.log("Phase E — validate-landblock-completeness");
  console.log("=========================");
  console.log(`ring: ${RING_LBS.length} LBs (${hexLb(args.ring.min >> 8, args.ring.min & 0xff)}..${hexLb(args.ring.max >> 8, args.ring.max & 0xff)})`);
  console.log(`out:  ${args.out}`);
  console.log(`dev server: http://127.0.0.1:${port}`);
  console.log(`page URL: ${PAGE_URL}`);

  const report = {
    timestamp: new Date().toISOString(),
    ring: {
      min: hexLb(args.ring.min >> 8, args.ring.min & 0xff),
      max: hexLb(args.ring.max >> 8, args.ring.max & 0xff),
      lbCount: RING_LBS.length,
    },
    bootStage: {
      smokePass: false,
      initResolved: false,
      initElapsedMs: null,
    },
    perSource: {
      // For each {statics, buildings, entities}:
      //   { expected: int, rendered: int, matched: int, missingRender: int, inventedPlacement: int }
    },
    perLb: {
      // For each lbHex: same shape.
    },
    topDivergences: [],
    summary: {
      expectedTotal: 0,
      renderedTotal: 0,
      matchedTotal: 0,
      missingRenderTotal: 0,
      inventedPlacementTotal: 0,
    },
    consoleErrors: [],
  };

  let browser;
  let exitCode = 0;

  try {
    browser = await chromium.launch({
      args: ["--use-gl=swiftshader"],
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
      } else if (/phase-e|world-expand|init3D|bake/i.test(text)) {
        const trimmed = text.slice(0, 240);
        if (
          trimmed.startsWith("[phase-e]") ||
          trimmed.startsWith("[world-expand]") ||
          trimmed.startsWith("[phase7.2]")
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
      report.bootStage.smokePass = true;
      console.log("[stage 1] in-page smoke panel: PASS");
    } catch (e) {
      console.error(`FAIL: in-page smoke panel timeout`);
      throw new Error("smoke-timeout");
    }

    // Stage 2: drive init3D directly with the FULL wasm export payload
    // (including init_spawns_base_url + fetch_landblock_spawns so the
    // Phase D path can fire its loader hook).
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
          `wasm: fetch_landblock_objects=${typeof wasmMod.fetch_landblock_objects}, ` +
            `fetch_landblock_scenery=${typeof wasmMod.fetch_landblock_scenery}, ` +
            `fetch_landblock_spawns=${typeof wasmMod.fetch_landblock_spawns}`
        );
        // Follow-on Task 30: SoA bulk exports for Stage 3 throughput.
        out.steps.push(
          `wasm: fetch_landblock_objects_soa=${typeof wasmMod.fetch_landblock_objects_soa}, ` +
            `fetch_landblock_scenery_soa=${typeof wasmMod.fetch_landblock_scenery_soa}, ` +
            `fetch_landblock_spawns_soa=${typeof wasmMod.fetch_landblock_spawns_soa}`
        );

        const scene3d = await import("./scene3d/index.js");
        out.steps.push(`scene3d module: init3D=${typeof scene3d.init3D}`);

        // Hand init3D the canonical full export list. Same payload the
        // capture_phase_d_spawns.cjs / capture_world_expand_e2e.cjs
        // scripts use.
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

        // Stash on the window so the second-stage probes can use the
        // SAME bindings without re-importing (re-import would create a
        // SECOND module instance with a separate wasm-bindgen heap —
        // see the comment chain in capture_world_expand_e2e.cjs:418-425).
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
        out.terrainGroupChildren = live.terrainGroup?.children?.length ?? null;
        out.staticsGroupChildren = live.staticsGroup?.children?.length ?? null;
        out.buildingsGroupChildren = live.buildingsGroup?.children?.length ?? null;
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
    report.bootStage.initResolved = true;

    // Order rationale:
    //   - We do the **expected manifest fetch** (the canonical Phase E
    //     "what SHOULD be rendered") BEFORE the spawn injection because
    //     the spawn dispatch fires 400+ concurrent animation chains
    //     that gridlock the JS event loop. The wasm `fetch_landblock_*`
    //     calls don't depend on entity rigs being rendered — they read
    //     from the pure-DAT / pure-staged streams. Doing them first
    //     keeps the validator runtime bounded.
    //   - THEN we fire spawn injection across the ring.
    //   - THEN we drain.
    //   - THEN we walk the rendered scene.
    //
    // This means there's a small race window: a spawn that hasn't
    // finished its animation fetch by stage 6 won't show up in the
    // rendered walk. The drain poll in stage 4 is what bounds that
    // window — anything still in-flight after the drain timeout is
    // counted as a missing-render in the diff (a real Phase E
    // finding, NOT a flake).
    await page.waitForTimeout(SETTLE_MS);

    // ---------------------------------------------------------------
    // Stage 3 (REORDERED): build expected manifest from wasm fetches.
    //   - `fetch_landblock_objects([lbCellId])` per LB → DAT explicit
    //   - `fetch_landblock_scenery([lbCellId])` per LB → DAT baked
    //   - `fetch_landblock_spawns([lbCellId])` per LB → ACE spawns
    // The LB key encoding: each `lbCellId` is
    // `lbX << 24 | lbY << 16 | 0xFFFE` (LandblockInfo cell key).
    //
    // We do this BEFORE spawn injection so the wasm fetches don't
    // contend with the spawn animation chains for CPU time. The
    // expected manifest doesn't depend on entity rendering — it reads
    // from pure DAT and pure-staged JSONL streams via the wasm caches.
    // ---------------------------------------------------------------
    console.log(`[stage 3] build expected manifest from wasm fetches`);
    const expected = await page.evaluate(
      async ({ ringLbs, chunkSize }) => {
        const wasmMod = window.__validatorWasm;
        if (!wasmMod) return { error: "__validatorWasm not stashed" };
        // Bootstrap the spawns + scenery base URLs in wasm. The
        // renderer-side lazy-init paths (`ensureSpawnsInit` in
        // scene3d/spawns.js:78, `ensureSceneryInit` in
        // scene3d/statics.js:97) only fire when their respective
        // bakers run. Our direct wasm fetch here doesn't go through
        // those code paths, so we need to call the init exports
        // ourselves with the canonical URLs.
        if (typeof wasmMod.init_spawns_base_url === "function") {
          try {
            wasmMod.init_spawns_base_url("../../dist/spawns/");
          } catch (_) { /* tolerated */ }
        }
        if (typeof wasmMod.init_scenery_base_url === "function") {
          try {
            wasmMod.init_scenery_base_url("../../dist/scenery/");
          } catch (_) { /* tolerated */ }
        }
        const out = {
          // One array per source, with one entry per placement.
          // Shape: { source, modelOrWcid, lbX, lbY, x, y, z, qw, qx, qy, qz, scale, name }.
          // We keep positions in AC-local coords (LB-relative) AND in
          // AC-world coords. The world-coord is the load-bearing one
          // for the renderer-side match (since the renderer stores
          // world coords directly on mesh.position).
          statics: [],
          buildings: [],
          scenery: [],
          spawns: [],
          fetchErrors: [],
        };
        const tStart = performance.now();
        // Build LandblockInfo cell ids for the ring.
        const cellIds = ringLbs.map((lb) => {
          const lbX = (lb >> 8) & 0xff;
          const lbY = lb & 0xff;
          return ((lbX << 24) | (lbY << 16) | 0xfffe) >>> 0;
        });
        const cellU32All = new Uint32Array(cellIds);

        // Fetch all 3 streams in PARALLEL across the entire ring in
        // ONE call each — the wasm thread-local cache means subsequent
        // calls during stage 4 spawn injection hit the cache. The
        // wasm-side fetch loops are sequential internally, but the
        // three Promise.all'd top-level fetches run concurrently
        // across the async runtime.
        //
        // Follow-on Task 30 (Phase E throughput): switched from
        // per-record `fetch_landblock_{objects,scenery,spawns}` to the
        // SoA bulk variants `fetch_landblock_{...}_soa`. The per-record
        // path was ~145k wasm-boundary getter calls (each placement
        // record ≈ 10 cross-boundary calls × 14523 scenery records) and
        // pegged Stage 3 at >5 min wallclock. The SoA path pulls each
        // typed-array field (Uint32Array model_ids, Float32Array
        // positions, …) in ONE structured-clone per array — 21 arrays
        // total ⇒ <50 cross-boundary crossings for the whole ring.
        // We iterate the parallel arrays in pure JS at native typed-
        // array speed. The downstream diff logic (Stage 6) is
        // UNCHANGED — only the data-ingest path differs.
        //
        // The per-record exports are still in the bundle and used by
        // the renderer's per-LB code path (where readability of
        // `p.modelId` matters more than bulk throughput). The SoA
        // variants are the validator/CI-friendly parallel API.
        const tFetch = performance.now();
        out.steps = [];
        const useSoa =
          typeof wasmMod.fetch_landblock_objects_soa === "function" &&
          typeof wasmMod.fetch_landblock_scenery_soa === "function" &&
          typeof wasmMod.fetch_landblock_spawns_soa === "function";
        out.steps.push(`SoA bulk fetch path: ${useSoa ? "enabled" : "FALLBACK to per-record"}`);

        // Fallback to per-record getters when the SoA exports aren't
        // available (older bundle, hand-rolled wasm, etc.) — keeps the
        // validator usable across bundle revisions even if it's slower.
        const fetchObjects = (
          useSoa
            ? wasmMod.fetch_landblock_objects_soa(cellU32All)
            : wasmMod.fetch_landblock_objects(cellU32All)
        )
          .then((objects) => {
            const dt = ((performance.now() - tFetch) | 0);
            const n = useSoa ? objects.len : objects.length;
            out.steps.push(`fetch_landblock_objects${useSoa ? "_soa" : ""}: ${n} placements in ${dt}ms`);
            return objects;
          })
          .catch((e) => {
            out.fetchErrors.push(`fetch_landblock_objects${useSoa ? "_soa" : ""}: ${e?.message ?? e}`);
            return null;
          });
        const fetchScenery = (
          useSoa
            ? wasmMod.fetch_landblock_scenery_soa(cellU32All)
            : wasmMod.fetch_landblock_scenery(cellU32All)
        )
          .then((scenery) => {
            const dt = ((performance.now() - tFetch) | 0);
            const n = useSoa ? scenery.len : scenery.length;
            out.steps.push(`fetch_landblock_scenery${useSoa ? "_soa" : ""}: ${n} placements in ${dt}ms`);
            return scenery;
          })
          .catch((e) => {
            out.fetchErrors.push(`fetch_landblock_scenery${useSoa ? "_soa" : ""}: ${e?.message ?? e}`);
            return null;
          });
        const fetchSpawns = (
          useSoa
            ? wasmMod.fetch_landblock_spawns_soa(cellU32All)
            : wasmMod.fetch_landblock_spawns(cellU32All)
        )
          .then((spawns) => {
            const dt = ((performance.now() - tFetch) | 0);
            const n = useSoa ? spawns.len : spawns.length;
            out.steps.push(`fetch_landblock_spawns${useSoa ? "_soa" : ""}: ${n} placements in ${dt}ms`);
            return spawns;
          })
          .catch((e) => {
            out.fetchErrors.push(`fetch_landblock_spawns${useSoa ? "_soa" : ""}: ${e?.message ?? e}`);
            return null;
          });

        const [objects, scenery, spawns] = await Promise.all([
          fetchObjects,
          fetchScenery,
          fetchSpawns,
        ]);
        const tExtract = performance.now();

        // 1) DAT explicit (LandblockInfo objects + buildings).
        if (useSoa && objects) {
          // One structured-clone per typed array — 6 boundary crossings
          // for the entire ring (was len*7 in the per-record path).
          // Parallel arrays: i-th element across all arrays is one
          // placement (positions stride 3, quaternions stride 4).
          const modelIds = objects.modelIds;
          const landblockIds = objects.landblockIds;
          const positions = objects.positions;
          const quaternions = objects.quaternions;
          const isBuilding = objects.isBuilding;
          const n = objects.len;
          for (let i = 0; i < n; i++) {
            const lbId = landblockIds[i] >>> 0;
            const lbX = (lbId >>> 24) & 0xff;
            const lbY = (lbId >>> 16) & 0xff;
            const px = positions[i * 3];
            const py = positions[i * 3 + 1];
            const pz = positions[i * 3 + 2];
            const wx = lbX * 192.0 + px;
            const wy = lbY * 192.0 + py;
            const isB = isBuilding[i] === 1;
            const rec = {
              source: isB ? "buildings" : "statics",
              modelOrWcid: modelIds[i] >>> 0,
              lbX, lbY,
              x: wx, y: wy, z: pz,
              // SoA quaternions are already (qw, qx, qy, qz) — no
              // trig reconstruction needed (the per-record path used
              // cos/sin from yaw_rad; SoA emits the same yaw-only
              // quaternion shape directly).
              qw: quaternions[i * 4],
              qx: quaternions[i * 4 + 1],
              qy: quaternions[i * 4 + 2],
              qz: quaternions[i * 4 + 3],
              scale: 1,
              isBuilding: isB,
              originSource: "landblockinfo",
            };
            if (isB) out.buildings.push(rec);
            else out.statics.push(rec);
          }
          if (typeof objects.free === "function") objects.free();
          out.steps.push(
            `extract objects (soa): ${n} in ${(performance.now() - tExtract) | 0}ms`
          );
        } else if (objects) {
          // Per-record fallback path — unchanged from the original.
          for (const p of objects) {
            const lbId = p.landblockId >>> 0;
            const lbX = (lbId >>> 24) & 0xff;
            const lbY = (lbId >>> 16) & 0xff;
            const wx = lbX * 192.0 + p.x;
            const wy = lbY * 192.0 + p.y;
            const rec = {
              source: p.isBuilding ? "buildings" : "statics",
              modelOrWcid: p.modelId >>> 0,
              lbX, lbY,
              x: wx, y: wy, z: p.z,
              qw: Math.cos((p.rotationZ ?? 0) / 2),
              qx: 0, qy: 0,
              qz: Math.sin((p.rotationZ ?? 0) / 2),
              scale: 1,
              isBuilding: p.isBuilding,
              originSource: "landblockinfo",
            };
            if (p.isBuilding) out.buildings.push(rec);
            else out.statics.push(rec);
            if (typeof p.free === "function") p.free();
          }
          out.steps.push(
            `extract objects: ${objects.length} in ${(performance.now() - tExtract) | 0}ms`
          );
        }
        const tScenery = performance.now();
        // 2) DAT baked (scenery JSONL).
        if (useSoa && scenery) {
          const objIds = scenery.objIds;
          const landblockIds = scenery.landblockIds;
          const positions = scenery.positions;
          const quaternions = scenery.quaternions;
          const scales = scenery.scales;
          const n = scenery.len;
          for (let i = 0; i < n; i++) {
            const lbId = landblockIds[i] >>> 0;
            const lbX = (lbId >>> 24) & 0xff;
            const lbY = (lbId >>> 16) & 0xff;
            const wx = lbX * 192.0 + positions[i * 3];
            const wy = lbY * 192.0 + positions[i * 3 + 1];
            out.scenery.push({
              source: "statics",
              modelOrWcid: objIds[i] >>> 0,
              lbX, lbY,
              x: wx, y: wy, z: positions[i * 3 + 2],
              qw: quaternions[i * 4],
              qx: quaternions[i * 4 + 1],
              qy: quaternions[i * 4 + 2],
              qz: quaternions[i * 4 + 3],
              scale: scales[i],
              isBuilding: false,
              originSource: "scenery",
            });
          }
          if (typeof scenery.free === "function") scenery.free();
          out.steps.push(
            `extract scenery (soa): ${n} in ${(performance.now() - tScenery) | 0}ms`
          );
        } else if (scenery) {
          for (const p of scenery) {
            const lbId = p.landblockId >>> 0;
            const lbX = (lbId >>> 24) & 0xff;
            const lbY = (lbId >>> 16) & 0xff;
            const wx = lbX * 192.0 + p.x;
            const wy = lbY * 192.0 + p.y;
            out.scenery.push({
              source: "statics",
              modelOrWcid: p.objId >>> 0,
              lbX, lbY,
              x: wx, y: wy, z: p.z,
              qw: p.qw, qx: p.qx, qy: p.qy, qz: p.qz,
              scale: p.scale,
              isBuilding: false,
              originSource: "scenery",
            });
            if (typeof p.free === "function") p.free();
          }
          out.steps.push(
            `extract scenery: ${scenery.length} in ${(performance.now() - tScenery) | 0}ms`
          );
        }
        const tSpawns = performance.now();
        // 3) ACE spawns (synthetic JSONL).
        if (useSoa && spawns) {
          const wcids = spawns.wcids;
          const landblockIds = spawns.landblockIds;
          const positions = spawns.positions;
          const quaternions = spawns.quaternions;
          const isServerManaged = spawns.isServerManaged;
          const names = spawns.names; // JS Array<string>
          const n = spawns.len;
          for (let i = 0; i < n; i++) {
            const lbId = landblockIds[i] >>> 0;
            const lbX = (lbId >>> 24) & 0xff;
            const lbY = (lbId >>> 16) & 0xff;
            const wx = lbX * 192.0 + positions[i * 3];
            const wy = lbY * 192.0 + positions[i * 3 + 1];
            out.spawns.push({
              source: "entities",
              modelOrWcid: wcids[i] >>> 0,
              lbX, lbY,
              x: wx, y: wy, z: positions[i * 3 + 2],
              qw: quaternions[i * 4],
              qx: quaternions[i * 4 + 1],
              qy: quaternions[i * 4 + 2],
              qz: quaternions[i * 4 + 3],
              scale: 1,
              isBuilding: false,
              originSource: "spawns",
              name: names[i],
              isServerManaged: isServerManaged[i] === 1,
            });
          }
          if (typeof spawns.free === "function") spawns.free();
          out.steps.push(
            `extract spawns (soa): ${n} in ${(performance.now() - tSpawns) | 0}ms`
          );
        } else if (spawns) {
          for (const p of spawns) {
            const lbId = p.landblockId >>> 0;
            const lbX = (lbId >>> 24) & 0xff;
            const lbY = (lbId >>> 16) & 0xff;
            const wx = lbX * 192.0 + p.x;
            const wy = lbY * 192.0 + p.y;
            out.spawns.push({
              source: "entities",
              modelOrWcid: p.wcid >>> 0,
              lbX, lbY,
              x: wx, y: wy, z: p.z,
              qw: p.qw, qx: p.qx, qy: p.qy, qz: p.qz,
              scale: 1,
              isBuilding: false,
              originSource: "spawns",
              name: p.name,
              isServerManaged: p.isServerManaged,
            });
            if (typeof p.free === "function") p.free();
          }
          out.steps.push(
            `extract spawns: ${spawns.length} in ${(performance.now() - tSpawns) | 0}ms`
          );
        }

        out.elapsedMs = (performance.now() - tStart) | 0;
        return out;
      },
      { ringLbs: RING_LBS, chunkSize: 16 }
    );
    if (expected.error) {
      console.error(`FAIL: expected manifest fetch errored: ${expected.error}`);
      throw new Error("expected-fetch-error");
    }
    if ((expected.fetchErrors ?? []).length > 0) {
      console.warn(
        `[stage 3] fetch_landblock_* errors:\n  ${expected.fetchErrors.join("\n  ")}`
      );
    }
    if (Array.isArray(expected.steps)) {
      for (const step of expected.steps) {
        console.log(`[stage 3] ${step}`);
      }
    }
    console.log(
      `[stage 3] expected: statics=${expected.statics.length}, ` +
        `buildings=${expected.buildings.length}, scenery=${expected.scenery.length}, ` +
        `spawns=${expected.spawns.length}, elapsed=${expected.elapsedMs}ms`
    );

    // ---------------------------------------------------------------
    // Stage 4: fire spawn injection for every LB so the entitiesGroup
    // gets the ACE-source placements populated before we walk.
    //
    // Subtle: `loadSpawnsForLandblock` doesn't await individual entity-
    // rig creation; it awaits the wasm fetch + the synchronous spawn-
    // upd dispatch. The actual rig construction (mesh + animation
    // keyframes) is fire-and-forget inside EntityManager.spawn(meta),
    // and surfaces later as entitiesGroup.children count grows. We
    // wrap each call in a 30s per-LB timeout so a hung LB doesn't
    // block the rest (the wasm spawn cache + the per-LB dedup in
    // `_spawnsInjectedLbs` handles the concurrent dispatch safely).
    // ---------------------------------------------------------------
    console.log(
      `[stage 4] firing spawn injection across ${RING_LBS.length} LBs ` +
        `(timeout ${SPAWN_LOAD_TIMEOUT_MS}ms)`
    );
    const spawnInject = await page.evaluate(
      async ({ ringLbs, timeoutMs }) => {
        const out = { fired: 0, errors: 0, errorSamples: [] };
        const live = window.liveScene3d;
        if (!live || typeof live.loadSpawnsForLandblock !== "function") {
          return { error: "loadSpawnsForLandblock missing on liveScene3d" };
        }
        const tStart = performance.now();
        const overallTimeoutMs = timeoutMs;
        const overall = Promise.race([
          Promise.all(
            ringLbs.map((lb) => {
              const lbX = (lb >> 8) & 0xff;
              const lbY = lb & 0xff;
              return Promise.race([
                live
                  .loadSpawnsForLandblock(lbX, lbY)
                  .then(() => ({ ok: true }))
                  .catch((e) => ({ ok: false, err: String(e?.message ?? e) })),
                new Promise((resolve) =>
                  setTimeout(
                    () => resolve({ ok: false, err: "per-LB timeout 30s" }),
                    30_000
                  )
                ),
              ]);
            })
          ),
          new Promise((resolve) =>
            setTimeout(() => resolve(null), overallTimeoutMs)
          ),
        ]);
        const results = await overall;
        if (!results) {
          out.error = `overall stage-4 timeout ${overallTimeoutMs}ms`;
          out.elapsedMs = (performance.now() - tStart) | 0;
          return out;
        }
        for (const r of results) {
          if (r.ok) out.fired += 1;
          else {
            out.errors += 1;
            if (out.errorSamples.length < 8) out.errorSamples.push(r.err);
          }
        }
        out.elapsedMs = (performance.now() - tStart) | 0;
        return out;
      },
      { ringLbs: RING_LBS, timeoutMs: SPAWN_LOAD_TIMEOUT_MS - 5000 }
    );
    console.log("[stage 4] inject:", JSON.stringify(spawnInject, null, 2));

    // ---------------------------------------------------------------
    // Stage 5: poll until the spawn chain drains. Mirrors the pattern
    // in `capture_phase_d_spawns.cjs:431-457`. We break early on
    // (a) zero in-flight, or (b) children count stable for 4 polls.
    // ---------------------------------------------------------------
    console.log(`[stage 5] poll spawn drain up to ${SPAWN_DRAIN_POLL_MS}ms`);
    const pollStart = Date.now();
    let lastChildren = -1;
    let stableCount = 0;
    while (Date.now() - pollStart < SPAWN_DRAIN_POLL_MS) {
      const snap = await page.evaluate(() => {
        const s = window.liveScene3d;
        return {
          children: s?.entitiesGroup?.children?.length ?? 0,
          inFlight: s?.entityManager?.spawnInFlight?.size ?? 0,
        };
      });
      console.log(
        `[stage 5] poll: entitiesGroup.children=${snap.children}, inFlight=${snap.inFlight}`
      );
      if (snap.inFlight === 0) break;
      if (snap.children === lastChildren && snap.children > 0) {
        stableCount += 1;
        if (stableCount >= 4) break;
      } else {
        stableCount = 0;
      }
      lastChildren = snap.children;
      await page.waitForTimeout(3000);
    }

    // Stage 6: walk the rendered scene. This is the load-bearing
    // expansion of InstancedMesh → per-instance placements.
    console.log("[stage 6] walk rendered scene (statics + buildings + entities)");
    const rendered = await page.evaluate(() => {
      // Expand each three.js node graph into a flat list of
      // {source, modelId, x, y, z, qw, qx, qy, qz, scale, instanceIndex}.
      //
      // For InstancedMesh: expand via getMatrixAt(i) → decompose.
      // For LOD: walk highest-detail child (level 0).
      // For Mesh: take position/quaternion/scale directly.
      // For Group (or non-leaf): recurse into children.
      //
      // The world-frame position lands in AC-world coords directly —
      // see scene3d/statics.js:486-490 (`mesh.position.set(worldX,
      // worldY, placement.z)` where worldX = lbX*192 + p.x). Buildings
      // and entities follow the same convention.
      const THREE = window.THREE || window.three || null;
      // We don't have THREE in the page module namespace from here,
      // so do the decompose manually using a 16-element float64 array
      // matrix and quaternion math primitives.
      function decomposeMat4(m, outPos, outQuat, outScale) {
        const te = m;
        // Extract scale via column-magnitude.
        const sx = Math.hypot(te[0], te[1], te[2]);
        const sy = Math.hypot(te[4], te[5], te[6]);
        const sz = Math.hypot(te[8], te[9], te[10]);
        // Determinant for handedness.
        const det =
          te[0] * (te[5] * te[10] - te[9] * te[6]) -
          te[1] * (te[4] * te[10] - te[8] * te[6]) +
          te[2] * (te[4] * te[9] - te[8] * te[5]);
        const sxSigned = det < 0 ? -sx : sx;
        outPos.x = te[12];
        outPos.y = te[13];
        outPos.z = te[14];
        outScale.x = sxSigned;
        outScale.y = sy;
        outScale.z = sz;
        // Rotation matrix (normalized columns).
        const isxInv = 1 / sxSigned;
        const syInv = 1 / sy;
        const szInv = 1 / sz;
        const r00 = te[0] * isxInv, r01 = te[4] * syInv, r02 = te[8] * szInv;
        const r10 = te[1] * isxInv, r11 = te[5] * syInv, r12 = te[9] * szInv;
        const r20 = te[2] * isxInv, r21 = te[6] * syInv, r22 = te[10] * szInv;
        // Mat3 → quaternion (Shepperd's method).
        const trace = r00 + r11 + r22;
        if (trace > 0) {
          const s = 0.5 / Math.sqrt(trace + 1.0);
          outQuat.w = 0.25 / s;
          outQuat.x = (r21 - r12) * s;
          outQuat.y = (r02 - r20) * s;
          outQuat.z = (r10 - r01) * s;
        } else if (r00 > r11 && r00 > r22) {
          const s = 2.0 * Math.sqrt(1.0 + r00 - r11 - r22);
          outQuat.w = (r21 - r12) / s;
          outQuat.x = 0.25 * s;
          outQuat.y = (r01 + r10) / s;
          outQuat.z = (r02 + r20) / s;
        } else if (r11 > r22) {
          const s = 2.0 * Math.sqrt(1.0 + r11 - r00 - r22);
          outQuat.w = (r02 - r20) / s;
          outQuat.x = (r01 + r10) / s;
          outQuat.y = 0.25 * s;
          outQuat.z = (r12 + r21) / s;
        } else {
          const s = 2.0 * Math.sqrt(1.0 + r22 - r00 - r11);
          outQuat.w = (r10 - r01) / s;
          outQuat.x = (r02 + r20) / s;
          outQuat.y = (r12 + r21) / s;
          outQuat.z = 0.25 * s;
        }
      }

      const out = { statics: [], buildings: [], entities: [], skipped: 0 };
      const s = window.liveScene3d;
      if (!s) return { error: "no liveScene3d" };

      function visit(obj, source, ancestorModelId, ancestorLbId) {
        if (!obj) return;
        // Resolve the modelId / landblockId we'll attribute this leaf
        // placement to. userData propagates from parent groups (used
        // by buildings.placementGroup).
        const ud = obj.userData ?? {};
        const modelId = ud.modelId ?? ancestorModelId ?? null;
        const lbId = ud.landblockId ?? ancestorLbId ?? null;

        if (obj.isInstancedMesh) {
          // Expand to per-instance placements.
          const count = obj.count;
          const m = new Array(16);
          const pos = { x: 0, y: 0, z: 0 };
          const quat = { w: 1, x: 0, y: 0, z: 0 };
          const scale = { x: 1, y: 1, z: 1 };
          for (let i = 0; i < count; i += 1) {
            // three.js InstancedMesh stores matrices as a Float32Array.
            // We can read them via instanceMatrix.array.
            const off = i * 16;
            const arr = obj.instanceMatrix.array;
            for (let k = 0; k < 16; k += 1) m[k] = arr[off + k];
            decomposeMat4(m, pos, quat, scale);
            // Note: the InstancedMesh node itself may be parented under
            // an outer Group with its own transform. In practice
            // staticsGroup parents InstancedMesh nodes directly under
            // staticsGroup (which lives under worldRoot), so the
            // instanceMatrix IS the world-frame transform for the
            // mesh. Building placements use plain Mesh + per-placement
            // Group (no InstancedMesh on the buildings path today).
            out[source].push({
              source,
              modelOrWcid: modelId,
              landblockId: lbId,
              x: pos.x, y: pos.y, z: pos.z,
              qw: quat.w, qx: quat.x, qy: quat.y, qz: quat.z,
              scale: scale.x,
              instanceIndex: i,
              isInstance: true,
              uaSource: ud.source ?? null,
            });
          }
          return;
        }

        if (obj.isLOD) {
          // Walk the highest-detail child only (LOD index 0). Each
          // LOD child slot maps to obj.levels[i].object. We use
          // obj.children[0] which is the same node.
          if (obj.children && obj.children.length > 0) {
            visit(obj.children[0], source, modelId, lbId);
          }
          return;
        }

        if (obj.isMesh) {
          // Singleton mesh. Compose the world matrix; obj.position is
          // already in the parent group's frame, so for statics
          // (parented directly under staticsGroup → worldRoot) it's
          // AC-world frame. For buildings the placementGroup is the
          // ancestor that holds the world coord; meshes underneath
          // (per-part surface meshes) live in the placementGroup's
          // local frame and have offsets relative to it, so we walk
          // up to the placementGroup for buildings.
          //
          // The cleanest path is: if the immediate parent is the
          // placementGroup (userData.isBuilding === true), emit ONE
          // record per placementGroup (deduped via a Set in the
          // outer walker), using the placementGroup's own
          // (position, quaternion, scale). For statics the mesh IS
          // the placement.
          if (source === "buildings") {
            // We only emit at the placementGroup level — handled by
            // the Group branch below. Per-mesh (surface) leaves are
            // skipped here to avoid duplicating one placement N times.
            return;
          }
          out[source].push({
            source,
            modelOrWcid: modelId,
            landblockId: lbId,
            x: obj.position.x, y: obj.position.y, z: obj.position.z,
            qw: obj.quaternion.w, qx: obj.quaternion.x,
            qy: obj.quaternion.y, qz: obj.quaternion.z,
            scale: obj.scale.x,
            instanceIndex: 0,
            isInstance: false,
            uaSource: ud.source ?? null,
          });
          return;
        }

        // Group node. For buildings, each placementGroup is what we
        // want to emit. For other groups, recurse.
        if (source === "buildings" && ud.isBuilding === true) {
          out.buildings.push({
            source: "buildings",
            modelOrWcid: modelId,
            landblockId: lbId,
            x: obj.position.x, y: obj.position.y, z: obj.position.z,
            qw: obj.quaternion.w, qx: obj.quaternion.x,
            qy: obj.quaternion.y, qz: obj.quaternion.z,
            scale: obj.scale.x,
            instanceIndex: 0,
            isInstance: false,
            uaSource: ud.source ?? null,
          });
          return;
        }
        if (source === "entities") {
          // Entities are added via `entitiesGroup.add(root)` where the
          // root carries the world-frame pose. The entity root itself
          // is a Group with userData containing modelId info. Emit at
          // the root.
          //
          // The check: if this is a direct child of entitiesGroup
          // (and not the entitiesGroup itself), emit it.
          if (obj.parent === s.entitiesGroup) {
            out.entities.push({
              source: "entities",
              modelOrWcid: modelId,
              landblockId: lbId,
              x: obj.position.x, y: obj.position.y, z: obj.position.z,
              qw: obj.quaternion.w, qx: obj.quaternion.x,
              qy: obj.quaternion.y, qz: obj.quaternion.z,
              scale: obj.scale.x,
              instanceIndex: 0,
              isInstance: false,
              uaSource: ud.source ?? null,
              entityName: ud.name ?? null,
            });
            return;
          }
        }
        if (obj.children?.length) {
          for (const c of obj.children) visit(c, source, modelId, lbId);
        }
      }

      // Statics: under s.staticsGroup. Children are a mix of
      // InstancedMesh (≥2 placements per modelId, ring driver),
      // plain Mesh (1 placement per modelId, ring driver), and
      // LOD wrappers (when degraded geom exists).
      for (const child of s.staticsGroup?.children ?? []) {
        visit(child, "statics", null, null);
      }
      // Buildings: each child of buildingsGroup is a placementGroup
      // (per scene3d/buildings.js:189).
      for (const child of s.buildingsGroup?.children ?? []) {
        visit(child, "buildings", null, null);
      }
      // Entities: each child of entitiesGroup is one entity root.
      for (const child of s.entitiesGroup?.children ?? []) {
        visit(child, "entities", null, null);
      }
      return out;
    });

    if (rendered.error) {
      console.error(`FAIL: rendered walk errored: ${rendered.error}`);
      throw new Error("rendered-walk-error");
    }
    console.log(
      `[stage 6] rendered: statics=${rendered.statics.length}, ` +
        `buildings=${rendered.buildings.length}, ` +
        `entities=${rendered.entities.length}`
    );

    // =====================================================================
    // Diff. Match by (modelOrWcid, lbX, lbY, x ± 0.05, y ± 0.05, z ± 0.10).
    // =====================================================================

    // Build a multi-keyed bucket for fast lookup. Bucket key is
    // `${modelOrWcid}|${lbX}|${lbY}`. Inside each bucket we hold an
    // array of placements; matching does a linear scan within the
    // bucket and removes the matched entry to enforce 1:1 pairing.
    function bucketKey(p) {
      return `${(p.modelOrWcid >>> 0).toString(16)}|${p.lbX}|${p.lbY}`;
    }
    function lbXY(p) {
      // From AC world position. The renderer-side walk doesn't carry
      // (lbX, lbY) — derive from floor(world / 192).
      if (typeof p.lbX === "number" && typeof p.lbY === "number") return p;
      const lbX = Math.floor(p.x / METERS_PER_LANDBLOCK);
      const lbY = Math.floor(p.y / METERS_PER_LANDBLOCK);
      return { ...p, lbX, lbY };
    }
    function bucketOf(map, key) {
      let arr = map.get(key);
      if (!arr) {
        arr = [];
        map.set(key, arr);
      }
      return arr;
    }
    function tryMatch(arr, rendered) {
      for (let i = 0; i < arr.length; i += 1) {
        const e = arr[i];
        if (
          Math.abs(e.x - rendered.x) <= POS_XY_TOLERANCE_M &&
          Math.abs(e.y - rendered.y) <= POS_XY_TOLERANCE_M &&
          Math.abs(e.z - rendered.z) <= POS_Z_TOLERANCE_M
        ) {
          arr.splice(i, 1);
          return e;
        }
      }
      return null;
    }
    function distance(a, b) {
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      const dz = a.z - b.z;
      return Math.sqrt(dx * dx + dy * dy + dz * dz);
    }

    // Build expected buckets. The statics expected source is the
    // union of LandblockInfo objects (`expected.statics`) + scenery
    // (`expected.scenery`). Buildings expected = `expected.buildings`.
    // Entities expected = `expected.spawns`.
    const expectedStatics = [...expected.statics, ...expected.scenery];
    const expectedBuildings = expected.buildings;
    const expectedEntities = expected.spawns;

    const sources = [
      {
        key: "statics",
        expected: expectedStatics,
        rendered: rendered.statics.map(lbXY),
      },
      {
        key: "buildings",
        expected: expectedBuildings,
        rendered: rendered.buildings.map(lbXY),
      },
      {
        key: "entities",
        expected: expectedEntities,
        rendered: rendered.entities.map(lbXY),
      },
    ];

    const allMissing = [];
    const allInvented = [];

    for (const src of sources) {
      const bucketMap = new Map();
      for (const p of src.expected) bucketOf(bucketMap, bucketKey(p)).push(p);

      let matched = 0;
      let invented = 0;
      const inventedList = [];
      for (const r of src.rendered) {
        // Some placements have null modelOrWcid (couldn't resolve from
        // userData). Skip these from invented count — they're rendering
        // artefacts of the userData propagation pattern (e.g. an
        // InstancedMesh's individual instances don't carry per-instance
        // modelId — but the InstancedMesh itself does, which we
        // propagated as ancestorModelId).
        if (r.modelOrWcid == null) {
          invented += 1;
          inventedList.push({ ...r, reason: "no modelId resolved" });
          continue;
        }
        const arr = bucketMap.get(bucketKey(r));
        if (!arr) {
          invented += 1;
          inventedList.push({ ...r, reason: "no expected bucket" });
          continue;
        }
        const e = tryMatch(arr, r);
        if (e) {
          matched += 1;
          // Compute the position residual so we can rank divergence.
          const d = distance(e, r);
          if (d > 0.01) {
            allMissing.push({
              source: src.key,
              type: "matched-but-displaced",
              modelOrWcid: r.modelOrWcid,
              lbX: r.lbX, lbY: r.lbY,
              expected: { x: e.x, y: e.y, z: e.z },
              rendered: { x: r.x, y: r.y, z: r.z },
              distance: d,
              expectedOrigin: e.originSource,
            });
          }
        } else {
          invented += 1;
          inventedList.push({ ...r, reason: "bucket has no compatible position" });
        }
      }

      // Anything left in any bucket is missing-render.
      let missing = 0;
      const missingList = [];
      for (const [key, arr] of bucketMap.entries()) {
        for (const e of arr) {
          missing += 1;
          missingList.push({
            source: src.key,
            type: "missing-render",
            modelOrWcid: e.modelOrWcid,
            lbX: e.lbX, lbY: e.lbY,
            expected: { x: e.x, y: e.y, z: e.z },
            expectedOrigin: e.originSource,
            name: e.name,
          });
        }
      }

      report.perSource[src.key] = {
        expected: src.expected.length,
        rendered: src.rendered.length,
        matched,
        missingRender: missing,
        inventedPlacement: invented,
      };
      report.summary.expectedTotal += src.expected.length;
      report.summary.renderedTotal += src.rendered.length;
      report.summary.matchedTotal += matched;
      report.summary.missingRenderTotal += missing;
      report.summary.inventedPlacementTotal += invented;

      allMissing.push(...missingList);
      allInvented.push(...inventedList);
    }

    // Per-LB rollup.
    const perLbAgg = new Map();
    function aggKey(lbX, lbY) {
      return hexLb(lbX, lbY);
    }
    function getPerLb(lbX, lbY) {
      const k = aggKey(lbX, lbY);
      let v = perLbAgg.get(k);
      if (!v) {
        v = {
          lbX, lbY,
          expected: { statics: 0, buildings: 0, entities: 0 },
          rendered: { statics: 0, buildings: 0, entities: 0 },
        };
        perLbAgg.set(k, v);
      }
      return v;
    }
    for (const src of sources) {
      for (const e of src.expected) {
        getPerLb(e.lbX, e.lbY).expected[src.key] += 1;
      }
      for (const r of src.rendered) {
        getPerLb(r.lbX, r.lbY).rendered[src.key] += 1;
      }
    }
    for (const [k, v] of perLbAgg.entries()) {
      report.perLb[k] = {
        expected: v.expected,
        rendered: v.rendered,
        deltaStatics: v.rendered.statics - v.expected.statics,
        deltaBuildings: v.rendered.buildings - v.expected.buildings,
        deltaEntities: v.rendered.entities - v.expected.entities,
      };
    }

    // Top-N divergences. Rank missing-render by drift (a missing
    // render at lat 100m matters more than a missing one at 0m? no —
    // ALL missing renders matter the same; rank invented + displaced
    // by distance from the nearest expected). Simplest ranking: sort
    // by distance for matched-but-displaced, and for everything else
    // report by occurrence count.
    const displaced = allMissing
      .filter((m) => m.type === "matched-but-displaced")
      .sort((a, b) => b.distance - a.distance);
    report.topDivergences = displaced
      .slice(0, TOP_N_DIVERGENCES)
      .map((m) => ({
        source: m.source,
        modelOrWcid: hexU32(m.modelOrWcid),
        lb: hexLb(m.lbX, m.lbY),
        distance: m.distance,
        expected: m.expected,
        rendered: m.rendered,
        expectedOrigin: m.expectedOrigin,
      }));
    // Add top-N missing-render samples (no distance metric — just enumerate).
    report.topMissingRender = allMissing
      .filter((m) => m.type === "missing-render")
      .slice(0, TOP_N_DIVERGENCES)
      .map((m) => ({
        source: m.source,
        modelOrWcid: hexU32(m.modelOrWcid),
        lb: hexLb(m.lbX, m.lbY),
        expected: m.expected,
        expectedOrigin: m.expectedOrigin,
        name: m.name,
      }));
    report.topInventedPlacement = allInvented
      .slice(0, TOP_N_DIVERGENCES)
      .map((m) => ({
        source: m.source,
        modelOrWcid: m.modelOrWcid != null ? hexU32(m.modelOrWcid) : null,
        rendered: { x: m.x, y: m.y, z: m.z },
        reason: m.reason,
        isInstance: m.isInstance,
        uaSource: m.uaSource,
      }));

    // Categories: ranked drift groups.
    // 1. Missing scenery (DAT baked → not rendered).
    // 2. Missing LandblockInfo statics.
    // 3. Missing entities (ACE spawns).
    // 4. Invented placements without bucket.
    const categories = [];
    function pushCategory(label, count) {
      if (count > 0) categories.push({ label, count });
    }
    pushCategory(
      "Missing scenery (expected.scenery not in rendered.statics)",
      allMissing.filter(
        (m) =>
          m.type === "missing-render" &&
          m.source === "statics" &&
          m.expectedOrigin === "scenery"
      ).length
    );
    pushCategory(
      "Missing LandblockInfo statics (expected.statics not in rendered.statics)",
      allMissing.filter(
        (m) =>
          m.type === "missing-render" &&
          m.source === "statics" &&
          m.expectedOrigin === "landblockinfo"
      ).length
    );
    pushCategory(
      "Missing buildings (expected.buildings not in rendered.buildings)",
      allMissing.filter(
        (m) => m.type === "missing-render" && m.source === "buildings"
      ).length
    );
    pushCategory(
      "Missing entities (expected.spawns not in rendered.entities)",
      allMissing.filter(
        (m) => m.type === "missing-render" && m.source === "entities"
      ).length
    );
    pushCategory(
      "Invented placements (rendered with no matching expected bucket)",
      allInvented.filter((m) => m.reason === "no expected bucket").length
    );
    pushCategory(
      "Rendered placements with no resolvable modelId",
      allInvented.filter((m) => m.reason === "no modelId resolved").length
    );
    pushCategory(
      "Rendered placements in correct bucket but wrong (x,y,z) within tolerance",
      allInvented.filter(
        (m) => m.reason === "bucket has no compatible position"
      ).length
    );
    pushCategory(
      "Matched-but-displaced (paired with expected; position drift >1cm)",
      displaced.length
    );
    categories.sort((a, b) => b.count - a.count);
    report.driftCategories = categories;

    // -----------------------------------------------------------------
    // Write reports.
    // -----------------------------------------------------------------
    fs.writeFileSync(reportJsonPath, JSON.stringify(report, null, 2));
    console.log(`report (json): ${reportJsonPath}`);

    const mdLines = [];
    mdLines.push("# Phase E — landblock completeness report");
    mdLines.push("");
    mdLines.push(`- Timestamp: \`${report.timestamp}\``);
    mdLines.push(`- Ring: \`${report.ring.min}..${report.ring.max}\` (${report.ring.lbCount} LBs)`);
    mdLines.push(`- Boot: smoke=${report.bootStage.smokePass}, init3D=${report.bootStage.initResolved} (${report.bootStage.initElapsedMs}ms)`);
    mdLines.push("");
    mdLines.push("## Summary");
    mdLines.push("");
    mdLines.push(`| Metric | Value |`);
    mdLines.push(`|---|---|`);
    mdLines.push(`| expected total | ${report.summary.expectedTotal} |`);
    mdLines.push(`| rendered total | ${report.summary.renderedTotal} |`);
    mdLines.push(`| matched total | ${report.summary.matchedTotal} |`);
    mdLines.push(`| missing-render total | ${report.summary.missingRenderTotal} |`);
    mdLines.push(`| invented-placement total | ${report.summary.inventedPlacementTotal} |`);
    mdLines.push("");
    mdLines.push("## Per-source");
    mdLines.push("");
    mdLines.push(`| Source | Expected | Rendered | Matched | Missing | Invented |`);
    mdLines.push(`|---|---:|---:|---:|---:|---:|`);
    for (const k of ["statics", "buildings", "entities"]) {
      const s = report.perSource[k];
      mdLines.push(
        `| ${k} | ${s.expected} | ${s.rendered} | ${s.matched} | ${s.missingRender} | ${s.inventedPlacement} |`
      );
    }
    mdLines.push("");
    mdLines.push("## Drift categories");
    mdLines.push("");
    if (report.driftCategories.length === 0) {
      mdLines.push("_None — every expected placement matched a rendered placement within tolerance._");
    } else {
      for (const c of report.driftCategories) {
        mdLines.push(`- **${c.count.toLocaleString()}** ${c.label}`);
      }
    }
    mdLines.push("");
    mdLines.push("## Top 20 matched-but-displaced");
    mdLines.push("");
    if (report.topDivergences.length === 0) {
      mdLines.push("_None._");
    } else {
      mdLines.push(`| Source | Model/WCID | LB | Δm | Expected | Rendered |`);
      mdLines.push(`|---|---|---|---:|---|---|`);
      for (const t of report.topDivergences) {
        mdLines.push(
          `| ${t.source} | \`${t.modelOrWcid}\` | \`${t.lb}\` | ${t.distance.toFixed(3)} | ` +
            `${t.expected.x.toFixed(2)},${t.expected.y.toFixed(2)},${t.expected.z.toFixed(2)} | ` +
            `${t.rendered.x.toFixed(2)},${t.rendered.y.toFixed(2)},${t.rendered.z.toFixed(2)} |`
        );
      }
    }
    mdLines.push("");
    mdLines.push("## Top 20 missing-render samples");
    mdLines.push("");
    if ((report.topMissingRender ?? []).length === 0) {
      mdLines.push("_None._");
    } else {
      mdLines.push(`| Source | Model/WCID | LB | Origin | Expected (x,y,z) | Name |`);
      mdLines.push(`|---|---|---|---|---|---|`);
      for (const t of report.topMissingRender) {
        mdLines.push(
          `| ${t.source} | \`${t.modelOrWcid}\` | \`${t.lb}\` | ${t.expectedOrigin ?? ""} | ` +
            `${t.expected.x.toFixed(2)},${t.expected.y.toFixed(2)},${t.expected.z.toFixed(2)} | ` +
            `${t.name ?? ""} |`
        );
      }
    }
    mdLines.push("");
    mdLines.push("## Top 20 invented-placement samples");
    mdLines.push("");
    if ((report.topInventedPlacement ?? []).length === 0) {
      mdLines.push("_None._");
    } else {
      mdLines.push(`| Source | Model/WCID | Reason | Rendered (x,y,z) | isInstance | uaSource |`);
      mdLines.push(`|---|---|---|---|---|---|`);
      for (const t of report.topInventedPlacement) {
        mdLines.push(
          `| ${t.source} | \`${t.modelOrWcid ?? "null"}\` | ${t.reason} | ` +
            `${t.rendered.x.toFixed(2)},${t.rendered.y.toFixed(2)},${t.rendered.z.toFixed(2)} | ` +
            `${t.isInstance} | ${t.uaSource ?? ""} |`
        );
      }
    }
    mdLines.push("");
    mdLines.push("## Per-LB rollup");
    mdLines.push("");
    mdLines.push(
      `| LB | exp statics | rend statics | Δ | exp bldgs | rend bldgs | Δ | exp ents | rend ents | Δ |`
    );
    mdLines.push(`|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|`);
    const perLbKeys = Object.keys(report.perLb).sort();
    for (const k of perLbKeys) {
      const v = report.perLb[k];
      mdLines.push(
        `| \`${k}\` | ${v.expected.statics} | ${v.rendered.statics} | ${v.deltaStatics} | ` +
          `${v.expected.buildings} | ${v.rendered.buildings} | ${v.deltaBuildings} | ` +
          `${v.expected.entities} | ${v.rendered.entities} | ${v.deltaEntities} |`
      );
    }
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
  console.log("Phase E verdict");
  console.log("=========================");
  console.log(`expectedTotal:           ${report.summary.expectedTotal}`);
  console.log(`renderedTotal:           ${report.summary.renderedTotal}`);
  console.log(`matchedTotal:            ${report.summary.matchedTotal}`);
  console.log(`missingRenderTotal:      ${report.summary.missingRenderTotal}`);
  console.log(`inventedPlacementTotal:  ${report.summary.inventedPlacementTotal}`);
  for (const k of ["statics", "buildings", "entities"]) {
    const s = report.perSource[k];
    if (!s) continue;
    console.log(
      `  ${k}: exp=${s.expected} rend=${s.rendered} match=${s.matched} ` +
        `miss=${s.missingRender} inv=${s.inventedPlacement}`
    );
  }
  console.log(`reports written to ${args.out}`);

  const hasDrift =
    report.summary.missingRenderTotal > 0 ||
    report.summary.inventedPlacementTotal > 0;

  // Exit semantics:
  //   - boot failure → exit 1 (already set above)
  //   - --strict + any drift → exit 1
  //   - everything matched → exit 0
  //   - drift but not strict → exit 0 (report is the artefact)
  if (exitCode === 0 && args.strict && hasDrift) {
    exitCode = 1;
    console.log(
      `--strict: ${report.summary.missingRenderTotal + report.summary.inventedPlacementTotal} ` +
        `drift placements; failing.`
    );
  }
  if (exitCode === 0 && !report.bootStage.initResolved) {
    exitCode = 1;
    console.log("init3D did not resolve; failing.");
  }
  if (exitCode === 0) {
    console.log("PASS: validation gate green.");
  } else {
    console.log("FAIL: validation gate has failures (or --strict caught drift).");
  }
  process.exit(exitCode);
})().catch((err) => {
  console.error("validator top-level threw:", err);
  process.exit(1);
});
