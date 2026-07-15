// culled-draw-probe.mjs — task #8. Which arm is right?
//
// The per-mesh arm spends ~2400 draws on particles; the instanced arm renders 9.
// _appendInstances never runs for RP6-culled emitters, so the question is simply:
// are the per-mesh arm's ~2400 drawn particles owned by CULLED emitters?
//
//   ~2400 culled-and-visible  => (a) the per-mesh path OVER-DRAWS. RP6's
//                                   visibility flip leaks; instancing is right,
//                                   but the win is a CULL fix, not batching.
//   ~0 culled-and-visible     => (b) instancing DROPS live visible particles.
//
// Runs on the per-mesh path (particleInstancing=off), one settled scene.
import fs from "node:fs";
import { settleAt, WEATHER_OFF } from "./settle.mjs";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  const hits = fs.readdirSync(`${process.env.HOME}/.npm/_npx`).map((d) => `${process.env.HOME}/.npm/_npx/${d}/node_modules/playwright-core`).filter((p) => fs.existsSync(p));
  const pw = require(hits[0]);
  const browser = await pw.chromium.connectOverCDP("http://127.0.0.1:9333");
  const ctx = browser.contexts()[0]; const page = await ctx.newPage();
  const q = new URLSearchParams({ renderer: "3d", autoLogin: "1", account: "tailnet1", password: "tailnet1",
    autoSpawn: "first", nosw: "1", buildingBatch: "off", particleInstancing: "off", ...WEATHER_OFF });
  await page.goto(`http://127.0.0.1:8765/apps/holtburger-web/index.html?${q}`, { timeout: 60000 });
  for (let i = 0; i < 240; i++) { const bs = await page.evaluate(() => window.__bootState).catch(() => null);
    if (bs === "in-world" || bs === "ready") break; if (bs === "error") { console.error("[cd] boot error"); process.exit(3); } await sleep(1000); }
  for (let i = 0; i < 90; i++) { if (await page.evaluate(() => !!(window.liveScene3d?.scene)).catch(() => false)) break; await sleep(1000); }

  const s = await settleAt(page, process.env.POI || "Cragstone",
    { log: (m) => console.error(`[cd] ${m}`), pinPose: process.env.PIN_POSE || null });
  if (!s.settled) { console.error("[cd] not settled; abort"); process.exit(4); }

  const r = await page.evaluate(() => {
    const ls = window.liveScene3d;
    const mgr = ls._staticParticleManager;
    const statics = ls.scene.getObjectByName("statics");
    let culledEmitters = 0, liveEmitters = 0;
    // parts[] meshes, split by the CULL STATE OF THEIR EMITTER
    let culled_inScene = 0, culled_visible = 0, culled_particles = 0;
    let live_inScene = 0, live_visible = 0, live_particles = 0;
    for (const [, e] of mgr.particleTable) {
      const isCulled = e._rp6Culled === true;
      if (isCulled) culledEmitters++; else liveEmitters++;
      for (const m of (e.parts || [])) {
        if (!m) continue;
        const inScene = m.parent === statics;
        const vis = m.visible !== false;
        if (isCulled) { culled_particles++; if (inScene) culled_inScene++; if (inScene && vis) culled_visible++; }
        else { live_particles++; if (inScene) live_inScene++; if (inScene && vis) live_visible++; }
      }
    }
    // ground truth: what three would actually draw from staticsGroup
    let drawableParticles = 0;
    statics.traverse((o) => { if (o.isMesh && !o.isInstancedMesh && o.userData?.__particle && o.visible !== false) drawableParticles++; });
    return { emitters: mgr.particleTable.size, culledEmitters, liveEmitters,
      culled_particles, culled_inScene, culled_visible,
      live_particles, live_inScene, live_visible, drawableParticles };
  });
  console.error(`[cd] emitters=${r.emitters}  culled=${r.culledEmitters}  notCulled=${r.liveEmitters}`);
  console.error(`[cd] parts of CULLED   emitters: total=${r.culled_particles} inScene=${r.culled_inScene} VISIBLE(=drawing)=${r.culled_visible}`);
  console.error(`[cd] parts of NOTCULLED emitters: total=${r.live_particles} inScene=${r.live_inScene} VISIBLE(=drawing)=${r.live_visible}`);
  console.error(`[cd] drawable particle meshes in staticsGroup (three's view) = ${r.drawableParticles}`);
  console.error(`[cd] ---`);
  if (r.culled_visible > 200) {
    console.error(`[cd] VERDICT (a): the PER-MESH path OVER-DRAWS — ${r.culled_visible} particles of RP6-CULLED emitters are visible and drawing.`);
    console.error(`[cd]   => RP6's visibility flip LEAKS. Instancing is CORRECT; its win is a CULL fix, not batching.`);
    console.error(`[cd]   => the same win should be obtainable by fixing the flip alone (no instancing).`);
  } else {
    console.error(`[cd] VERDICT (b): culled emitters draw ~nothing (${r.culled_visible}) — so instancing is DROPPING live visible particles.`);
    console.error(`[cd]   => ?particleInstancing is buggy; ${r.live_visible} particles of un-culled emitters should be instanced.`);
  }
  fs.writeFileSync("/mnt/wbterminal2/tmp/culled-draw.json", JSON.stringify({ settle: s, ...r }, null, 2));
  await page.close(); process.exit(0);
})();
