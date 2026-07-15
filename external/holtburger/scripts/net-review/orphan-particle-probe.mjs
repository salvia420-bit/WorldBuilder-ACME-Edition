// orphan-particle-probe.mjs — who owns the drawable particle meshes that no
// emitter slot accounts for?
//
// After the RP6 cull-authority fix (2026-07-15), culled-draw-probe at a pinned
// Cragstone reported:
//     parts of CULLED    emitters VISIBLE = 0     (leak closed)
//     parts of NOTCULLED emitters VISIBLE = 15
//     drawable particle meshes in staticsGroup = 24
// 15 + 0 != 24. Before the fix the same probe reconciled exactly (140+12=152),
// so 9 drawable particle meshes belong to NO emitter's `parts[]`. Either they
// are free slots left visible, meshes of emitters already dropped from
// particleTable (orphans nothing will ever hide again), or another manager's
// (the entity/sky chain also parents into the scene).
//
// This probe classifies every drawable particle mesh by owner. It answers a
// question, it does not assert a verdict — read the counts.
import fs from "node:fs";
import { settleAt, WEATHER_OFF } from "./settle.mjs";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  const hits = fs.readdirSync(`${process.env.HOME}/.npm/_npx`)
    .map((d) => `${process.env.HOME}/.npm/_npx/${d}/node_modules/playwright-core`)
    .filter((p) => fs.existsSync(p));
  const pw = require(hits[0]);
  const browser = await pw.chromium.connectOverCDP("http://127.0.0.1:9333");
  const ctx = browser.contexts()[0];
  const page = await ctx.newPage();
  const q = new URLSearchParams({
    renderer: "3d", autoLogin: "1", account: "tailnet1", password: "tailnet1",
    autoSpawn: "first", nosw: "1", buildingBatch: "off", particleInstancing: "off", ...WEATHER_OFF,
  });
  await page.goto(`http://127.0.0.1:8765/apps/holtburger-web/index.html?${q}`, { timeout: 60000 });
  for (let i = 0; i < 240; i++) {
    const bs = await page.evaluate(() => window.__bootState).catch(() => null);
    if (bs === "in-world" || bs === "ready") break;
    if (bs === "error") { console.error("[op] boot error"); process.exit(3); }
    await sleep(1000);
  }
  for (let i = 0; i < 90; i++) {
    if (await page.evaluate(() => !!(window.liveScene3d?.scene)).catch(() => false)) break;
    await sleep(1000);
  }

  const s = await settleAt(page, process.env.POI || "Cragstone",
    { log: (m) => console.error(`[op] ${m}`), pinPose: process.env.PIN_POSE || null });
  if (!s.settled) { console.error("[op] not settled; abort"); process.exit(4); }

  const r = await page.evaluate(() => {
    const ls = window.liveScene3d;
    const mgr = ls._staticParticleManager;
    const statics = ls.scene.getObjectByName("statics");

    // Index every mesh the static manager knows about: occupied slot (parts) vs
    // merely allocated (partStorage).
    const inParts = new Set(), inStorage = new Set();
    for (const [, e] of mgr.particleTable) {
      for (const m of (e.parts || [])) if (m) inParts.add(m);
      for (const m of (e.partStorage || [])) if (m) inStorage.add(m);
    }

    const out = {
      drawable: 0, occupiedSlot: 0, freeSlotButVisible: 0, unknownOwner: 0,
      unknownSamples: [],
    };
    statics.traverse((o) => {
      if (!(o.isMesh && !o.isInstancedMesh && o.userData?.__particle && o.visible !== false)) return;
      out.drawable++;
      if (inParts.has(o)) out.occupiedSlot++;
      else if (inStorage.has(o)) out.freeSlotButVisible++;
      else {
        out.unknownOwner++;
        if (out.unknownSamples.length < 6) {
          out.unknownSamples.push({
            name: o.name || "(unnamed)",
            parentName: o.parent?.name || "(unnamed parent)",
            parentIsStatics: o.parent === statics,
            pos: [+o.position.x.toFixed(1), +o.position.y.toFixed(1), +o.position.z.toFixed(1)],
            hasMat: !!o.material, opacity: o.material?.opacity ?? null,
          });
        }
      }
    });
    out.emitters = mgr.particleTable.size;
    out.storageMeshes = inStorage.size;
    out.partsMeshes = inParts.size;
    return out;
  });

  console.error(`[op] emitters=${r.emitters} partsMeshes=${r.partsMeshes} storageMeshes=${r.storageMeshes}`);
  console.error(`[op] drawable particle meshes = ${r.drawable}`);
  console.error(`[op]   owned by an OCCUPIED slot (parts[])      = ${r.occupiedSlot}`);
  console.error(`[op]   a FREE slot left VISIBLE (partStorage)   = ${r.freeSlotButVisible}`);
  console.error(`[op]   NO owner in this manager (orphan/other)  = ${r.unknownOwner}`);
  for (const u of r.unknownSamples) console.error(`[op]     sample: ${JSON.stringify(u)}`);
  fs.writeFileSync("/mnt/wbterminal2/tmp/orphan-particle.json", JSON.stringify({ settle: s, ...r }, null, 2));
  await page.close();
  process.exit(0);
})();
