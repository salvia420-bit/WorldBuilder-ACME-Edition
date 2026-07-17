// walk-bake-probe.mjs — price the BAKE PATH while the player is actually walking.
//
// THE QUESTION. Measured on the 1070, same page load, same area:
//   STANDING 59.9 fps (16.7 ms, worst 33 ms)   WALKING 40.3 fps (24.8 ms, worst 1433 ms)
// Walking costs ~8 ms/frame + second-long stalls. Four candidate causes were priced
// and are DEAD or small (see walk.mjs's header): shadows 0.02 ms/frame
// (shadowMap.enabled === false), freezing staticsGroup's matrices = no win
// (19.21 vs a 19.12-19.53 baseline), renderer.sortObjects=false LOSES 0.9 ms, and
// the 196 MB static-atlas full-array re-upload costs only 0.12 ms/frame of CPU.
// What is left is the bake path: the profile buckets move OUT of three (66.5% ->
// 54.3%) and INTO app scene3d (12.6 -> 16.8), wasm (4.8 -> 7.3) and native/GC
// (14.7 -> 18.0) the moment you press W. This probe counts that directly.
//
// WHAT IT COUNTS (all four call sites verified in source, 2026-07-15):
//   adapter.js:707        meshToGeometryGroups   — per-triangle JS + boxed arrays,
//                         main thread even with the bake worker on (the worker
//                         only moves the DECODE: bake_worker_client.js:38).
//   static_atlas.js:354   _addGeometryGrow       — BatchedMesh setGeometrySize
//   static_batch_x.js:121 _addGeometryGrow         realloc + full re-upload
//   statics.js:1756       bakeStaticsForLandblock — the per-LB envelope
//
// HOW IT COUNTS. page.route() patches the module source IN MEMORY and fulfils the
// same URL (the npc-counter-probe.mjs trick — no vendored file, relative imports
// keep resolving). Each target is wrapped with a performance.now() delta into
// globalThis.__bake. A patch that fails to match would report a confident ZERO, so
// the probe ASSERTS every patch applied and refuses to run otherwise.
//
// READ walk.mjs's HEADER FIRST — it documents the four traps (abort-if-you-didn't-
// walk, stand-after-walk is the only fair control, fps can't score a steady win
// because standing is vsync-capped, and the 150 s single-login slot).
//
// USAGE
//   node walk-bake-probe.mjs                       # default: Holtburg, 30 s walk
//   POI=Arwic WALK_MS=45000 node walk-bake-probe.mjs
//   OUT=/mnt/wbterminal2/tmp/walk-bake.json node walk-bake-probe.mjs
// Needs the 1070 tunnel:
//   ssh -fN -L 9333:127.0.0.1:9333 -R 8765:127.0.0.1:8765 -R 8080:127.0.0.1:8080 young@100.127.215.75
// and chrome launched INTERACTIVE (real GPU): schtasks /run /tn HBFPS
// (C:\Temp\launch-wls-fps.bat = --use-angle=d3d11 --mute-audio, off-screen).
// A PERSON USES THAT BOX: kill test chrome by `cdpwb-wls` cmdline match only.

import fs from "node:fs";
import { assertRealGpu, installRenderCpuMeter, phase } from "./walk.mjs";

// playwright-core lives in the npx cache on this box (same resolution trick as
// npc-counter-probe.mjs — there is no node_modules in scripts/).
const { createRequire } = await import("node:module");
const require = createRequire(import.meta.url);
const _pwHits = fs.readdirSync(`${process.env.HOME}/.npm/_npx`)
  .map((d) => `${process.env.HOME}/.npm/_npx/${d}/node_modules/playwright-core`)
  .filter((p) => fs.existsSync(p));
if (!_pwHits.length) throw new Error("playwright-core not found under ~/.npm/_npx");
const { chromium } = require(_pwHits[0]);

const CDP = process.env.CDP || "http://127.0.0.1:9333";
const POI = process.env.POI || "Holtburg";
const WALK_MS = Number(process.env.WALK_MS || 30000);
const SETTLE_MS = Number(process.env.SETTLE_MS || 25000);
const OUT = process.env.OUT || "/mnt/wbterminal2/tmp/walk-bake.json";
const BASE = "http://127.0.0.1:8765/apps/holtburger-web/index.html";
const log = (...a) => console.error("[walk-bake]", ...a);

// ---- the patches. Each MUST match exactly once, or we abort. ----
const PATCHES = [
  {
    file: "adapter.js",
    url: "**/scene3d/adapter.js",
    needle: "export function meshToGeometryGroups(wasmMesh, opts) {",
    body: `export function meshToGeometryGroups(wasmMesh, opts) {
  const __t0 = performance.now();
  try { return __meshToGeometryGroups_orig(wasmMesh, opts); }
  finally { const __b = globalThis.__bake; if (__b) { __b.m2g.n++; __b.m2g.ms += performance.now() - __t0; } }
}
function __meshToGeometryGroups_orig(wasmMesh, opts) {`,
  },
  {
    file: "static_atlas.js",
    url: "**/scene3d/static_atlas.js",
    needle: "function _addGeometryGrow(bm, g, vcount) {",
    body: `function _addGeometryGrow(bm, g, vcount) {
  const __t0 = performance.now();
  const __before = bm.userData && bm.userData.maxVerts;
  try { return __addGeometryGrow_orig(bm, g, vcount); }
  finally {
    const __b = globalThis.__bake;
    if (__b) {
      __b.atlasGrow.n++; __b.atlasGrow.ms += performance.now() - __t0;
      if (bm.userData && bm.userData.maxVerts !== __before) __b.atlasGrow.reallocs++;
    }
  }
}
function __addGeometryGrow_orig(bm, g, vcount) {`,
  },
  {
    file: "static_batch_x.js",
    url: "**/scene3d/static_batch_x.js",
    needle: "function _addGeometryGrow(bm, g) {",
    body: `function _addGeometryGrow(bm, g) {
  const __t0 = performance.now();
  try { return __addGeometryGrow_orig(bm, g); }
  finally { const __b = globalThis.__bake; if (__b) { __b.chunkGrow.n++; __b.chunkGrow.ms += performance.now() - __t0; } }
}
function __addGeometryGrow_orig(bm, g) {`,
  },
  {
    file: "statics.js",
    url: "**/scene3d/statics.js",
    needle: "export async function bakeStaticsForLandblock(",
    body: `export async function bakeStaticsForLandblock(...__a) {
  const __t0 = performance.now();
  try { return await __bakeStaticsForLandblock_orig(...__a); }
  finally { const __b = globalThis.__bake; if (__b) { __b.lbBake.n++; __b.lbBake.ms += performance.now() - __t0; } }
}
async function __bakeStaticsForLandblock_orig(`,
  },
];

const browser = await chromium.connectOverCDP(CDP);
const page = await browser.contexts()[0].newPage();
const applied = new Map();

try {
  // counters must exist before any module runs
  await page.addInitScript(() => {
    globalThis.__bake = {
      m2g: { n: 0, ms: 0 },
      atlasGrow: { n: 0, ms: 0, reallocs: 0 },
      chunkGrow: { n: 0, ms: 0 },
      lbBake: { n: 0, ms: 0 },
    };
  });

  for (const p of PATCHES) {
    await page.route(p.url, async (route) => {
      const res = await route.fetch();
      const src = await res.text();
      const count = src.split(p.needle).length - 1;
      applied.set(p.file, count);
      if (count !== 1) return route.fulfill({ status: 200, contentType: "application/javascript; charset=utf-8", body: src });
      return route.fulfill({
        status: 200,
        contentType: "application/javascript; charset=utf-8",
        body: src.replace(p.needle, p.body),
      });
    });
  }

  const gpu = await (async () => { await page.goto("about:blank"); return assertRealGpu(page); })();
  log("GPU:", gpu);

  const url = `${BASE}?${new URLSearchParams({
    nosw: "1", autoLogin: "1", account: "phase4demo", password: "phase4demo",
    autoSpawn: "first", agent: "1",
    bridge_url: "ws://127.0.0.1:8080/", server_host: "127.0.0.1", server_port: "9000",
  })}`;
  log("boot", url);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForFunction(() => window.__sessionHandle && window.liveScene3d, null, { timeout: 120000, polling: 500 });

  // a patch that silently missed would report a confident zero — refuse.
  const missed = PATCHES.filter((p) => applied.get(p.file) !== 1);
  if (missed.length) {
    throw new Error(
      "PATCH ASSERT FAILED — needle matched != 1 time in: " +
      missed.map((p) => `${p.file}(${applied.get(p.file) ?? "never fetched"})`).join(", ") +
      ". The source moved; re-verify the signatures before trusting any number.",
    );
  }
  log("patches applied:", [...applied.entries()].map(([f, n]) => `${f}=${n}`).join(" "));

  await page.evaluate(async (poi) => {
    const h = window.__sessionHandle;
    h.sendChat(`@telepoi ${poi}`);
    const t0 = Date.now(); const lb0 = h.getLocalPlayerPose()?.landblockId;
    while (Date.now() - t0 < 30000) {
      await new Promise((r) => setTimeout(r, 500));
      if (h.getLocalPlayerPose()?.landblockId !== lb0) break;
    }
  }, POI);
  log(`settling ${SETTLE_MS} ms at ${POI}…`);
  await page.waitForTimeout(SETTLE_MS);

  const meter = await installRenderCpuMeter(page);
  log("renderer:", JSON.stringify(meter));

  const readBake = () => page.evaluate(() => JSON.parse(JSON.stringify(globalThis.__bake)));
  const diff = (a, b) => {
    const o = {};
    for (const k of Object.keys(b)) {
      o[k] = {};
      for (const kk of Object.keys(b[k])) o[k][kk] = +(b[k][kk] - a[k][kk]).toFixed(2);
    }
    return o;
  };

  // walk FIRST, then stand at the walk's end position (the only fair control)
  const b0 = await readBake();
  const walk = await phase(page, "walk", { walkMs: WALK_MS, log });
  const b1 = await readBake();
  const stand = await phase(page, "stand", { walkMs: WALK_MS, log });
  const b2 = await readBake();

  const bakeWalk = diff(b0, b1);
  const bakeStand = diff(b1, b2);
  const perFrame = (d, frames) => ({
    meshToGeometryGroups_ms_per_frame: +(d.m2g.ms / frames).toFixed(2),
    lbBake_ms_per_frame: +(d.lbBake.ms / frames).toFixed(2),
    atlasGrow_ms_per_frame: +(d.atlasGrow.ms / frames).toFixed(2),
    chunkGrow_ms_per_frame: +(d.chunkGrow.ms / frames).toFixed(2),
    bake_total_ms_per_frame: +((d.m2g.ms + d.atlasGrow.ms + d.chunkGrow.ms) / frames).toFixed(2),
  });

  const result = {
    gpu, poi: POI, walkMs: WALK_MS,
    renderer: meter,
    walk: { frame: walk, bake: bakeWalk, perFrame: perFrame(bakeWalk, walk.frames) },
    stand: { frame: stand, bake: bakeStand, perFrame: perFrame(bakeStand, stand.frames) },
    verdict: {
      walk_minus_stand_ms_per_frame: +(walk.frameMs_median - stand.frameMs_median).toFixed(2),
      bake_explains_ms_per_frame: perFrame(bakeWalk, walk.frames).bake_total_ms_per_frame,
      note: "If bake_explains << walk_minus_stand, the 8 ms is elsewhere (GC? wasm? entity spawn?) — say so, do not narrate.",
    },
  };

  console.log(JSON.stringify(result, null, 2));
  try { fs.writeFileSync(OUT, JSON.stringify(result, null, 2)); log("wrote", OUT); } catch (e) { log("write failed:", e.message); }
} finally {
  await page.close().catch(() => {});
  await browser.close().catch(() => {});   // detaches CDP; does NOT kill the box's chrome
}
