// F.41 (2026-05-15) — Hudriffa-LB (0xA9B0) probe.
//
// Re-runs the F.37/F.40 verification pattern with the F.41 surfaces-
// batch landed. Boots the renderer + drives init3D + fires
// loadSpawnsForLandblock for 0xA9B0 (13 entities, Hudriffa the
// Shopkeeper among them) and measures how many of the 13 entities
// materialise within 60s.
//
// Targets (per F.41 brief):
//   - F.37 baseline: 6/13 entities, 0/5 hits.
//   - F.40 baseline: 10/13 entities (1 iter), 0/1 hit.
//   - F.41 target:   13/13 entities AND 5/5 Hudriffa hits.
//
// Runs 5 iterations (each a fresh browser context) and reports
// N/13 entities + Hudriffa hit-rate (whether the Hudriffa rig made
// it into entityManager.entityMap in time).
//
// PASS/FAIL:
//   - 5/5 Hudriffa hits → exit 0.
//   - <5/5 Hudriffa hits → exit 0 anyway (per brief: "if probe still
//     misses Hudriffa after F.41 lands and cargo green, COMMIT
//     anyway + surface the next-layer finding").
//   - init3D timeout / smoke fail → exit 2.

const path = require("node:path");
const fs = require("node:fs");
const http = require("node:http");

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
    console.error("FAIL: playwright not found");
    process.exit(2);
  }
}

const APP_ROOT = "/home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger";
const DIST_V2 = "/mnt/wbterminal1/holtburger-dist-v2";

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

// One probe iteration: boot, drive init3D, fire LB 0xA9B0 spawn, wait
// 60s, return { entityCount, hudriffaHit, elapsedMs }.
async function runProbeIteration(port, iter) {
  const PAGE_URL = `http://127.0.0.1:${port}/apps/holtburger-web/index.html?renderer=3d&quality=high`;
  const browser = await chromium.launch({ args: ["--use-gl=swiftshader"] });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await context.newPage();
    const consoleErrors = [];
    page.on("console", (msg) => {
      const text = msg.text();
      if (msg.type() === "error") {
        consoleErrors.push(text.slice(0, 200));
      } else if (/F\.41|F\.40|spawn|surface/.test(text)) {
        const t = text.slice(0, 240);
        if (
          t.startsWith("[scene3d.spawns]") ||
          /F\.41|F\.40/.test(t)
        ) {
          console.log(`[iter ${iter}] [browser] ${t}`);
        }
      }
    });

    await page.goto(PAGE_URL, { waitUntil: "domcontentloaded" });
    // Wait for smoke panel.
    await page.waitForFunction(
      () => {
        const r = document.getElementById("results");
        return r && /PASS/.test(r.innerHTML);
      },
      { timeout: 60_000 }
    );
    console.log(`[iter ${iter}] in-page smoke: PASS`);

    // Drive init3D.
    await page.evaluate(async () => {
      const canvas = document.getElementById("scene") || document.querySelector("canvas");
      const wasmMod = await import("./pkg/holtburger_web.js?v=h3-e1");
      const scene3d = await import("./scene3d/index.js");
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
        // F.40 + F.41 batched exports.
        fetchEntityAnimationKeyframesBatch: wasmMod.fetchEntityAnimationKeyframesBatch,
        fetchEntitySurfacesPixels: wasmMod.fetchEntitySurfacesPixels,
        fetchEntitySurfacesPixelsBatch: wasmMod.fetchEntitySurfacesPixelsBatch,
        collectSurfaceDidsForSetups: wasmMod.collectSurfaceDidsForSetups,
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
      await Promise.race([
        scene3d.init3D(canvas, null, wasmExports),
        new Promise((_, rej) => setTimeout(() => rej(new Error("init3D timeout")), 120_000)),
      ]);
    });
    console.log(`[iter ${iter}] init3D resolved`);

    // Fire spawn for 0xA9B0 (Hudriffa LB) — 13 entities.
    await page.evaluate(async () => {
      const live = window.liveScene3d;
      if (!live || typeof live.loadSpawnsForLandblock !== "function") {
        throw new Error("loadSpawnsForLandblock missing");
      }
      const result = await live.loadSpawnsForLandblock(0xa9, 0xb0);
      console.log(`[F.41 probe] loadSpawnsForLandblock 0xA9B0 result: ${JSON.stringify(result)}`);
    });

    // Wait 60s for spawn chain to drain.
    const tStart = Date.now();
    await page.waitForTimeout(60_000);
    const elapsedMs = Date.now() - tStart;

    // Scrape entity count + Hudriffa detection.
    const summary = await page.evaluate(() => {
      const out = {
        entityCount: 0,
        hudriffaHit: false,
        names: [],
        rigPartCounts: [],
      };
      const s = window.liveScene3d;
      if (!s) return out;
      const em = s.entityManager;
      if (!em || !em.entityMap) return out;
      const sk0 = (0xa9b00000 >>> 0);
      const sk1 = (0xa9b1ffff >>> 0); // generous bound
      for (const [guid, inst] of em.entityMap) {
        const meta = inst?.meta;
        if (!meta) continue;
        // Filter to spawns from 0xA9B0 specifically.
        const lbKey = (meta.landblockId >>> 0) & 0xffff0000;
        if ((lbKey >>> 0) !== (0xa9b00000 >>> 0)) continue;
        out.entityCount += 1;
        if (typeof meta.name === "string") {
          out.names.push(meta.name);
          if (/hudriffa/i.test(meta.name)) {
            out.hudriffaHit = true;
          }
        }
        // Did the rig actually have parts built (not a stub)?
        const parts = inst?.parts;
        out.rigPartCounts.push(Array.isArray(parts) ? parts.length : 0);
      }
      return out;
    });

    return {
      iter,
      entityCount: summary.entityCount,
      hudriffaHit: summary.hudriffaHit,
      names: summary.names,
      rigPartCounts: summary.rigPartCounts,
      elapsedMs,
      consoleErrors: consoleErrors.slice(0, 5),
    };
  } finally {
    try { await browser.close(); } catch (_) {}
  }
}

(async () => {
  const SCRATCH_DIR = "/mnt/wbterminal1/tmp/claude-scratch/f41";
  try { fs.mkdirSync(SCRATCH_DIR, { recursive: true }); } catch (_) {}

  if (!fs.existsSync(path.join(DIST_V2, "manifest.json"))) {
    console.error(`FAIL: dist v2 missing at ${DIST_V2}`);
    process.exit(2);
  }
  if (!fs.existsSync(path.join(DIST_V2, "spawns/0xA9B0.spawns.jsonl"))) {
    console.error(`FAIL: 0xA9B0 spawns missing`);
    process.exit(2);
  }

  const server = makeServer();
  server.keepAliveTimeout = 0;
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  console.log(`F.41 probe: server on port ${port}`);

  const N_ITERS = Number(process.env.F41_ITERS || 5);
  const results = [];
  let iterFailed = false;
  for (let i = 1; i <= N_ITERS; i += 1) {
    console.log(`\n=== F.41 iteration ${i}/${N_ITERS} ===`);
    try {
      const r = await runProbeIteration(port, i);
      results.push(r);
      console.log(
        `[iter ${i}] entityCount=${r.entityCount}/13, hudriffaHit=${r.hudriffaHit}, ` +
        `rigParts=${JSON.stringify(r.rigPartCounts)}, ` +
        `names=${JSON.stringify(r.names.slice(0, 6))}`
      );
    } catch (e) {
      console.error(`[iter ${i}] FAILED: ${e?.message ?? e}`);
      iterFailed = true;
      results.push({ iter: i, error: String(e?.message ?? e) });
    }
  }

  server.close();

  // Aggregate.
  const goodIters = results.filter((r) => !r.error);
  const totalIters = results.length;
  const hudriffaHits = goodIters.filter((r) => r.hudriffaHit).length;
  const avgEntityCount = goodIters.length > 0
    ? (goodIters.reduce((s, r) => s + r.entityCount, 0) / goodIters.length).toFixed(1)
    : "0";
  const maxEntityCount = goodIters.length > 0
    ? Math.max(...goodIters.map((r) => r.entityCount))
    : 0;

  console.log("\n=== F.41 probe summary ===");
  console.log(`Iterations: ${totalIters} (${goodIters.length} clean, ${totalIters - goodIters.length} error)`);
  console.log(`Hudriffa hits: ${hudriffaHits}/${totalIters}`);
  console.log(`Entity count avg: ${avgEntityCount}/13`);
  console.log(`Entity count max: ${maxEntityCount}/13`);
  console.log(`Per-iter: ${JSON.stringify(goodIters.map((r) => ({
    i: r.iter,
    n: r.entityCount,
    h: r.hudriffaHit ? "Y" : "N",
  })))}`);

  // Write diag.
  const diagPath = path.join(SCRATCH_DIR, `f41-hudriffa-${Date.now()}.json`);
  fs.writeFileSync(diagPath, JSON.stringify({
    summary: {
      totalIters,
      cleanIters: goodIters.length,
      hudriffaHits,
      avgEntityCount,
      maxEntityCount,
    },
    perIter: results,
  }, null, 2));
  console.log(`Diag written to: ${diagPath}`);

  // Per brief: even if probe misses Hudriffa, exit 0 + surface the
  // finding. Only init3D / smoke failures exit non-zero.
  if (iterFailed && goodIters.length === 0) {
    process.exit(2);
  }
  process.exit(0);
})();
