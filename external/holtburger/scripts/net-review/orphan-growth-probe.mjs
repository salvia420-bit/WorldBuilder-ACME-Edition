// orphan-growth-probe.mjs — do orphaned particle meshes ACCUMULATE with travel?
//
// orphan-particle-probe found 9 drawable particle meshes in staticsGroup that
// belong to NO emitter in `_staticParticleManager.particleTable` — not an
// occupied slot, not even a partStorage entry. Their emitter is gone; both
// teardown paths (tick()'s auto-finish removal and destroyParticleEmitter)
// detach only `e.parts` and walk `partStorage` for MATERIALS only, so any mesh
// parented into staticsGroup without a live `parts` entry is never detached.
// Nothing will ever hide them again, because after the RP6 cull-authority fix
// (2026-07-15) RP6 is the sole writer of particle visibility and RP6 only
// knows about emitters that still exist. Before that fix cullStaticsGroup was
// incidentally frustum-culling them, which is why they were invisible in the
// census that reconciled exactly (140+12=152).
//
// 9 immortal draws is a rounding error. 9 PER LANDBLOCK TOUR is a leak. Travel
// reaps emitters (handoff: 2582 -> 1577 -> 1108 over a tour), and every reap is
// an opportunity to orphan — so measure the count across a POI tour, in ONE
// page load (no re-login), and see whether it climbs.
//
// Reports the raw series. It does not print a verdict — read the numbers.
import fs from "node:fs";
import { settleAt, WEATHER_OFF } from "./settle.mjs";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const COUNT_FN = () => {
  const ls = window.liveScene3d;
  const mgr = ls._staticParticleManager;
  const statics = ls.scene.getObjectByName("statics");
  const inParts = new Set(), inStorage = new Set();
  for (const [, e] of mgr.particleTable) {
    for (const m of (e.parts || [])) if (m) inParts.add(m);
    for (const m of (e.partStorage || [])) if (m) inStorage.add(m);
  }
  let particleMeshesInGroup = 0, drawable = 0, orphanAll = 0, orphanDrawable = 0;
  statics.traverse((o) => {
    if (!(o.isMesh && !o.isInstancedMesh && o.userData?.__particle)) return;
    particleMeshesInGroup++;
    const vis = o.visible !== false;
    if (vis) drawable++;
    if (!inParts.has(o) && !inStorage.has(o)) {
      orphanAll++;
      if (vis) orphanDrawable++;
    }
  });
  return {
    emitters: mgr.particleTable.size,
    particleMeshesInGroup, drawable, orphanAll, orphanDrawable,
    staticsChildren: statics.children.length,
  };
};

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
    if (bs === "error") { console.error("[og] boot error"); process.exit(3); }
    await sleep(1000);
  }
  for (let i = 0; i < 90; i++) {
    if (await page.evaluate(() => !!(window.liveScene3d?.scene)).catch(() => false)) break;
    await sleep(1000);
  }

  // One page load, several POIs. Cross-POI DRAW counts would not be comparable
  // (pose dominates), but an ORPHAN count is a structural property of the scene
  // graph, not of where the camera looks — it can only go up as emitters are
  // reaped. That is what makes this tour readable despite the pose confound.
  const tour = (process.env.TOUR || "Cragstone,Holtburg,Shoushi,Cragstone").split(",");
  const series = [];
  for (const poi of tour) {
    const s = await settleAt(page, poi, { log: (m) => console.error(`[og] ${m}`) });
    const c = await page.evaluate(COUNT_FN);
    series.push({ poi, settled: !!s.settled, ...c });
    console.error(`[og] ${poi.padEnd(12)} settled=${s.settled ? "Y" : "N"} emitters=${String(c.emitters).padStart(5)} ` +
      `particleMeshes=${String(c.particleMeshesInGroup).padStart(6)} drawable=${String(c.drawable).padStart(4)} ` +
      `ORPHAN=${String(c.orphanAll).padStart(5)} orphanDrawable=${String(c.orphanDrawable).padStart(4)}`);
  }
  console.error(`[og] ---`);
  console.error(`[og] orphan series: ${series.map((x) => x.orphanAll).join(" -> ")}`);
  console.error(`[og] orphanDrawable: ${series.map((x) => x.orphanDrawable).join(" -> ")}`);
  fs.writeFileSync("/mnt/wbterminal2/tmp/orphan-growth.json", JSON.stringify(series, null, 2));
  await page.close();
  process.exit(0);
})();
