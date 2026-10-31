// harness/glsl_smoke/interior_batch_smoke.mjs — R3-5 `?interiorBatch`, legacy
// vs batch in a real WebGL2 stack: local headless Chromium (ANGLE /
// SwiftShader), three r184 from node_modules, the app's own modules
// (scene3d/cells.js buildEnvCellsForLandblock + tickCellVisibility3D,
// materials.js, gpu_batch/*). Page: interior_batch_page.html; arm code:
// interior_batch_lib.mjs (dry-run in node by tests/interior_batch_smoke_lib.test.mjs).
// docs/2026-10-29-round3-gpu-driven.md §R3-5 "Proof" (HOW: SwiftShader smoke).
//
// PASS =
//   layers    every level of every admitted layer reads back BYTE-EQUAL to the
//             same level of the 2D texture three built for its member;
//   town      outdoors, the UNSPLIT frame: flag off vs on, at most 0.1% of the
//             pixels differ by more than 2/255 (LB-local f32 vertices vs the
//             legacy cell-local ones: rare edge-coverage flips), the scene is
//             on screen, the on load really batched (every batched legacy mesh
//             of a visible cell handed over to its batch object) with fewer
//             draw calls, the decoded DRAW bits equal the container set;
//   punch     outdoors, the PUNCH frame (world, the real PortalPunchPass fed by
//             the real cells.js tickPortalPunch, cells): same gates, the
//             doorway was punched, and in BOTH loads the interior shows
//             through the doorway (pixels inside its screen rect differ from
//             the world-only frame) and nowhere else (outside it the frame is
//             the world-only frame);
//   dungeon   indoors, the SPLIT frame (world, depth clear, cells): same gates;
//   sealed    indoors, no outdoor portal, the SEALED frame (empty world mask:
//             clear only, no wipe, cells): same gates;
//   shadow    indoors, interiors cast, the sun shadow map on (the alpha-tested
//             ClipMap prop casts its pattern): same gates on the shadowed frame;
//   shadowmap BasicShadowMap, the sun's shadow map read back: legacy vs batch
//             casters within 4 depth ulps (24-bit) on all but 0.1% of the
//             texels (edge coverage), and the map is not empty;
//   +pools    (realboot 2026-10-31) town, dungeon and shadowmap again with
//             the env-cell draw pools ARMED as scene3d/index.js arms them
//             (`&pools=1`, interior_batch_lib.mjs POOL_ARMS; the shipped
//             default): every gate above, plus both loads armed the pools
//             (the four page-dim shell surfaces pooled), the batch is NOT
//             disarmed and reads the pools (no split refused, no pool /
//             container divergence), and the pools read the same in both
//             loads (per-cell instances and PVS hides, every pool a
//             cellsGroup child on layer 1, none sentinelled);
//   +pom     (2026-10-31) `layers&pom=1` (every R8 height layer, every
//             level, byte-equal to the member's own 2D height texture, next to
//             the map / normal layers), then the pom (close indoor: camera
//             ~4 m off cell 0, the POM march at full strength) and shadowmap
//             arms on the POM material cache (`&pom=1`, interior_batch_lib.mjs
//             POM_ARMS: cells draw materials.js's real POM chain, props their
//             flag-only p1 clones): every gate above, plus the on load batched
//             the POM members (POM slots with height layers, every POM program
//             linked) — legacy vs batch at the same 2/255 on 0.1% bar;
//   +maps    (2026-10-31) `layers&maps=1` (every R8 AO and RGBA8 roughness
//             layer, every level, byte-equal to the member's own 2D plane,
//             next to the map / normal layers), then the town, dungeon and
//             shadowmap arms on the texchan + luminous material cache
//             (`&maps=1`, interior_batch_lib.mjs MAP_ARMS: materials.js's own
//             texchan attach, the luminous ladder's emissive alias): every
//             gate above, plus the on load batched the AO / roughness /
//             emissive members (map slots of both realboot sets, no member
//             refused for an extra map, no texture re-plan);
//   every program links; no GL, page or console error; no missing module;
//   the on load settled (the per-sync CPU budget spreads the set-up over
//   frames: the arm ticks until every chunk is active, at most 400 frames).
// Texels: the fixture's synthetic RGBA (real client_portal.dat SURFACE
// records are proven in node, tests/interior_batch_eligibility.test.mjs E5;
// RGBA texels of real RenderSurfaces exist only through the wasm decode of a
// served dist, which this page does not boot).
// NOT part of the node gate (it launches a browser — one heavy job at a time,
// run it under `capped-build`):
//
//   capped-build node harness/glsl_smoke/interior_batch_smoke.mjs
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const require = createRequire(import.meta.url);
const { chromium } = require("/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules/playwright-core");
const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, "..", "..");
const BASE = "noEnvcellTimeSlice=1&occlusionCull=off&interiorApertureCull=off";
const LIB = await import("./interior_batch_lib.mjs");

async function run(search) {
  const browser = await chromium.launch({ executablePath: "/usr/bin/chromium", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox"] });
  try {
    const page = await browser.newPage();
    const pageErrors = [];
    const missing = [];
    page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 300)));
    await page.route("http://smoke.test/**", (route) => {
      const u = new URL(route.request().url());
      let file, type = "text/javascript";
      if (u.pathname === "/page.html") { file = join(HERE, "interior_batch_page.html"); type = "text/html"; }
      else if (u.pathname.startsWith("/three-addons/")) file = join(APP, "node_modules/three/examples/jsm", u.pathname.slice(14));
      else if (u.pathname.startsWith("/three/")) file = join(APP, "node_modules/three/build", u.pathname.slice(7));
      else if (u.pathname.startsWith("/pp/")) file = join(APP, "node_modules/postprocessing/build", u.pathname.slice(4));
      else if (u.pathname.startsWith("/app/")) file = join(APP, u.pathname.slice(5));
      if (file && file.endsWith(".json")) type = "application/json";
      if (!file) { if (u.pathname !== "/favicon.ico") missing.push(u.pathname); return route.fulfill({ status: 404, body: "" }); }
      try { return route.fulfill({ status: 200, contentType: type, body: readFileSync(file) }); } catch (e) { missing.push(u.pathname); return route.fulfill({ status: 404, body: String(e) }); }
    });
    await page.goto(`http://smoke.test/page.html?${BASE}&${search}`);
    // Interval polling (2026-10-31): the page stubs requestAnimationFrame, so the default rAF polling never fires.
    await page.waitForFunction(() => window.__smoke, null, { timeout: 240000, polling: 250 });
    const r = await page.evaluate(() => window.__smoke);
    r.pageErrors = pageErrors;
    r.missing = missing;
    return r;
  } finally { await browser.close(); }
}

function diff(a, b, tol = 2) {
  let maxDiff = 0, over = 0, differing = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 4) {
    let d = 0;
    for (let c = 0; c < 4; c += 1) d = Math.max(d, Math.abs(a[i + c] - b[i + c]));
    if (d > 0) differing += 1;
    if (d > tol) over += 1;
    if (d > maxDiff) maxDiff = d;
  }
  return { maxDiff: a.length === b.length ? maxDiff : 255, over, differing, pixels: n / 4 };
}
const linked = (r) => Array.isArray(r.programs) && r.programs.length >= 1 && r.programs.every((p) => p.linked);
const clean = (r) => r.errors.length === 0 && r.pageErrors.length === 0 && r.glError === 0 && r.missing.length === 0;
const fails = [];
const check = (name, ok, detail) => { console.log(`  [${ok ? "OK" : "FAIL"}] ${name}${ok ? "" : " — " + detail}`); if (!ok) fails.push(name); };

// --- layers -------------------------------------------------------------------
const L = await run("arm=layers&interiorBatch=on");
console.log(`layers: ${JSON.stringify({ renderer: L.renderer, layers: L.layers, batch: L.batch && L.batch.chunks })}`);
check("layers: every admitted layer, every level, byte-equal to its 2D texture", L.layers && L.layers.layers >= 7 && L.layers.mismatched === 0,
  JSON.stringify(L.layers));
check("layers: clean, every program linked", clean(L) && linked(L), JSON.stringify({ errors: L.errors, pageErrors: L.pageErrors, glError: L.glError, missing: L.missing }));

// --- town / punch / dungeon / sealed / shadow / shadowmap ---------------------------
const f32of = (b64) => (b64 ? new Float32Array(new Uint8Array(Buffer.from(b64, "base64")).buffer) : null);
function gateArm(arm, off, on, name = arm) {
  const d = diff(on.frame || [], off.frame || []);
  console.log(`${name} off: ${JSON.stringify({ calls: off.calls, lit: off.lit, visible: off.visible, batch: off.batch })}`);
  console.log(`${name} on:  ${JSON.stringify({ calls: on.calls, lit: on.lit, visible: on.visible, ticks: on.ticks, settled: on.settled, batch: on.batch, bits: on.bits })}`);
  console.log(`${name} frame diff: ${JSON.stringify(d)}`);
  check(`${name}: the off load never armed the batch`, off.batch === null && off.bits === null, JSON.stringify({ batch: off.batch }));
  check(`${name}: the on load settled (every chunk active within the frame cap)`, on.settled === true, JSON.stringify({ ticks: on.ticks, batch: on.batch }));
  const cov = on.coverage;
  check(`${name}: the on load batched what is on screen (every batched mesh of a visible cell handed over; bits = containers)`,
    on.batch && cov && cov.chunks === 1 && cov.visibleMeshes > 0 && cov.suppressed === cov.visibleMeshes
    && on.bits && on.bits.cells > 0 && on.bits.bad === 0 && on.batch.bitMismatch === 0, JSON.stringify({ batch: on.batch, bits: on.bits, coverage: cov }));
  check(`${name}: same visible cell set in both loads`, JSON.stringify(on.visible) === JSON.stringify(off.visible), `${off.visible} vs ${on.visible}`);
  check(`${name}: fewer draw calls with the batch`, on.calls < off.calls, `${on.calls} vs ${off.calls}`);
  check(`${name}: the scene is on screen`, off.lit > 2000 && on.lit > 2000, `${off.lit} / ${on.lit} lit px`);
  check(`${name}: legacy vs batch: <= 0.1% of the pixels over 2/255`, d.over <= Math.floor(d.pixels * 0.001), JSON.stringify(d));
  check(`${name}: clean, every program linked`, clean(off) && clean(on) && linked(off) && linked(on),
    JSON.stringify({ off: { errors: off.errors, pageErrors: off.pageErrors, glError: off.glError, missing: off.missing },
      on: { errors: on.errors, pageErrors: on.pageErrors, glError: on.glError, missing: on.missing, unlinked: (on.programs || []).filter((p) => !p.linked) } }));
  if (arm === "punch") {
    // 2026-10-31 (orchestrator, first run): the fixture keeps cells 1-3 OUTSIDE the doorway on purpose, so the
    // interior also differs from the world-only frame outside the doorway in the LEGACY frame (off: inside 6552,
    // outside 58984). The absolute "nowhere else" claim cannot hold for this fixture; the batch is held to the
    // legacy footprint instead: punched, the interior shows through the doorway, and on == off exactly.
    const rds = {};
    for (const [name, r] of [["off", off], ["on", on]]) {
      const rd = r.worldFrame && r.doorway ? LIB.rectDiff(r.frame, r.worldFrame, r.doorway) : null;
      rds[name] = rd;
      console.log(`punch ${name}: punched ${r.punched}, doorway ${JSON.stringify(r.doorway)} over ${JSON.stringify(r.doorwayMeshes)}, vs world-only ${JSON.stringify(rd)}`);
      check(`punch ${name}: the doorway was punched and the interior shows through it`,
        r.punched === true && rd && rd.inside > 50, JSON.stringify({ punched: r.punched, rd }));
    }
    check("punch: the batch's punch footprint equals legacy's (inside and outside pixel counts)",
      rds.off && rds.on && rds.on.inside === rds.off.inside && rds.on.outside === rds.off.outside, JSON.stringify(rds));
  }
  if (arm === "shadowmap") {
    const a = f32of(off.shadowDepth), b = f32of(on.shadowDepth);
    const dd = a && b ? LIB.depthDiff(b, a, 4) : null;
    const covered = a ? a.filter((v) => v < 0.999999).length : 0;
    console.log(`${name} depth diff: ${JSON.stringify(dd)}, casters cover ${covered} texels`);
    check(`${name}: legacy vs batch shadow map within 4 depth ulps on all but 0.1% of the texels`,
      dd && dd.sameSize && covered > 1000 && dd.over <= Math.floor(dd.texels * 0.001), JSON.stringify({ dd, covered }));
  }
}

for (const arm of ["town", "punch", "dungeon", "sealed", "shadow", "shadowmap"]) {
  const off = await run(`arm=${arm}`);
  const on = await run(`arm=${arm}&interiorBatch=on`);
  gateArm(arm, off, on);
}

// --- +pools: the same arms with the env-cell draw pools armed (the shipped default) ---
for (const arm of LIB.POOL_ARMS) {
  const name = `${arm}+pools`;
  const off = await run(`arm=${arm}&pools=1`);
  const on = await run(`arm=${arm}&pools=1&interiorBatch=on`);
  gateArm(arm, off, on, name);
  console.log(`${name} pools off-load: ${JSON.stringify(off.pools)}`);
  console.log(`${name} pools on-load:  ${JSON.stringify(on.pools)}; batch.pools ${JSON.stringify(on.batch && on.batch.pools)}`);
  for (const [lbl, r] of [["off", off], ["on", on]]) {
    const p = r.pools;
    check(`${name} ${lbl}: the pools armed and took the page-dim shell surfaces`, r.poolsArmed === true && p && p.active === true && p.surfacesPooled === 4 && p.cells.length === 3,
      JSON.stringify(p));
    check(`${name} ${lbl}: every pool a cellsGroup child on layer 1, none sentinelled`, p && p.meshes.length > 0 && p.meshes.every((m) => m.cellsChild && m.mask === 2 && !m.sentinel),
      JSON.stringify(p && p.meshes));
  }
  check(`${name}: the batch is not disarmed and reads the pools (no split refused, no divergence)`,
    on.batch && JSON.stringify(on.batch.disarmed) === "{}" && on.batch.pools && on.batch.pools.active === true && on.batch.pools.cells === 3
    && on.batch.pools.partitionRefused === 0 && on.batch.pools.visDiverged === 0, JSON.stringify(on.batch && { disarmed: on.batch.disarmed, pools: on.batch.pools }));
  check(`${name}: the pools read the same in both loads (per-cell instances / hides, pool instances)`,
    off.pools && on.pools && JSON.stringify(off.pools.cells) === JSON.stringify(on.pools.cells)
    && JSON.stringify(off.pools.meshes) === JSON.stringify(on.pools.meshes), JSON.stringify({ off: off.pools, on: on.pools }));
}

// --- +pom: POM members (materials.js's own patch at pomEnabled; cells un-baked) ---
const LP = await run("arm=layers&pom=1&interiorBatch=on");
console.log(`layers+pom: ${JSON.stringify({ layers: LP.layers, batch: LP.batch && { chunks: LP.batch.chunks, slots: LP.batch.slots, pomSlots: LP.batch.pomSlots } })}`);
check("layers+pom: every admitted layer (the R8 height layers too), every level, byte-equal to its 2D texture",
  LP.layers && LP.layers.pomLayers >= 4 && LP.layers.mismatched === 0, JSON.stringify(LP.layers));
check("layers+pom: clean, every program linked", clean(LP) && linked(LP), JSON.stringify({ errors: LP.errors, pageErrors: LP.pageErrors, glError: LP.glError, missing: LP.missing }));
for (const arm of LIB.POM_ARMS) {
  const name = `${arm}+pom`;
  const off = await run(`arm=${arm}&pom=1`);
  const on = await run(`arm=${arm}&pom=1&interiorBatch=on`);
  gateArm(arm, off, on, name);
  // (Every program linked, the POM ones included, is gateArm's "clean" gate: three puts the custom key last in a
  // program cache key, past the page's 120 characters, so the POM programs are told apart by the batch diag.)
  check(`${name}: the POM members batched (real POM chains on height layers, no texture re-plan)`,
    on.batch && on.batch.pomSlots >= 4 && on.batch.slots > on.batch.pomSlots && on.batch.textureReplans === 0,
    JSON.stringify(on.batch && { pomSlots: on.batch.pomSlots, slots: on.batch.slots, unitReasons: on.batch.unitReasons, textureReplans: on.batch.textureReplans }));
}

// --- +maps: AO / roughness / emissive members (texchan planes + the luminous emissive alias) ---
const LM = await run("arm=layers&maps=1&interiorBatch=on");
console.log(`layers+maps: ${JSON.stringify({ layers: LM.layers, batch: LM.batch && { chunks: LM.batch.chunks, slots: LM.batch.slots, mapSlots: LM.batch.mapSlots } })}`);
check("layers+maps: every admitted layer (the AO and roughness layers too), every level, byte-equal to its 2D texture",
  LM.layers && LM.layers.mapLayers >= 10 && LM.layers.mismatched === 0, JSON.stringify(LM.layers));
check("layers+maps: clean, every program linked", clean(LM) && linked(LM), JSON.stringify({ errors: LM.errors, pageErrors: LM.pageErrors, glError: LM.glError, missing: LM.missing }));
for (const arm of LIB.MAP_ARMS) {
  const name = `${arm}+maps`;
  const off = await run(`arm=${arm}&maps=1`);
  const on = await run(`arm=${arm}&maps=1&interiorBatch=on`);
  gateArm(arm, off, on, name);
  const ms = on.batch && on.batch.mapSlots;
  check(`${name}: the AO / roughness / emissive members batched (both realboot sets, no extra-map refusal, no texture re-plan)`,
    on.batch && ms && ms.ao >= 5 && ms.roughness >= 5 && ms.emissive >= 2 && ms.sets["|xmar"] >= 1 && ms.sets["|xmare"] >= 1
    && JSON.stringify(on.batch.extraMaps) === "{}" && on.batch.textureReplans === 0,
    JSON.stringify(on.batch && { mapSlots: ms, extraMaps: on.batch.extraMaps, unitReasons: on.batch.unitReasons, textureReplans: on.batch.textureReplans }));
}

console.log(fails.length === 0 ? "PASS" : `FAIL (${fails.length}): ${fails.join("; ")}`);
process.exit(fails.length === 0 ? 0 : 1);
