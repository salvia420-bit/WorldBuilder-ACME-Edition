// multidraw-truth-probe — renderer.info.render.calls LIES about BatchedMesh.
//
// WHY THIS EXISTS. statics-cpu-probe measured the 508 BatchedMesh at 183
// draws/f but 13.93ms — ~76us per "draw", vs ~5us for a cells draw. I guessed
// the gap was BatchedMesh.onBeforeRender's per-frame instance walk and A/B'd it
// (batchedmesh-flags-ab.mjs): killing the walk ENTIRELY saves ~1.6-2.3ms, well
// inside that run's noise. So the walk is NOT the cost. That hypothesis is dead
// and the ~76us is still unexplained.
//
// THE REMAINING EXPLANATION, read from three r184 (not inferred):
//   three.module.js:17253  renderer.renderMultiDraw(starts, counts, object._multiDrawCount)
//   three.module.js:4440   extension.multiDrawElementsWEBGL(mode, counts, 0, type, starts, 0, drawCount)
//   three.module.js:4449   info.update(elementCount, mode, 1)   // <-- literal 1
//
// A multiDraw of N ranges increments info.render.calls by ONE. So a BatchedMesh
// "draw" is really `_multiDrawCount` sub-draws, and ANGLE/D3D11 has no native
// multi-draw — it loops and issues them individually. That would make ~76us per
// counted call simply ~N real draws wearing one number's clothing, and it means
// EVERY draw number in this handoff chain (2,168 -> 1,924, "the frame is at
// ~1,920 draws") is an undercount of unknown size. The whole "draw-call COUNT
// is the lever" thesis was argued from a counter that cannot see the batches.
//
// So: measure the TRUE sub-draw count = sum(_multiDrawCount) over live
// BatchedMesh, per frame, and compare it to what info.calls reported. No arms,
// no hiding, no A/B — this is a census of a number, taken at the same settled
// Holtburg as every other run in this chain. It either explains the 76us or it
// does not.
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
    autoSpawn: "first", nosw: "1", particleInstancing: "off", ...WEATHER_OFF,
    ...(process.env.EXTRA_Q ? Object.fromEntries(new URLSearchParams(process.env.EXTRA_Q)) : {}),
  });
  const bail = async (msg, code) => {
    console.error(`[md] ${msg}`);
    await page.close().catch(() => {});
    process.exit(code);
  };

  await page.goto(`http://127.0.0.1:8765/apps/holtburger-web/index.html?${q}`, { timeout: 60000 });
  for (let i = 0; i < 240; i++) {
    const bs = await page.evaluate(() => window.__bootState).catch(() => null);
    if (bs === "in-world" || bs === "ready") break;
    if (bs === "error") await bail("boot error (account still held? wait 45-60s)", 3);
    await sleep(1000);
  }
  for (let i = 0; i < 90; i++) {
    if (await page.evaluate(() => !!(window.liveScene3d?.scene)).catch(() => false)) break;
    await sleep(1000);
  }
  const gpu = await page.evaluate(() => {
    try {
      const c = document.createElement("canvas");
      const gl = c.getContext("webgl2") || c.getContext("webgl");
      return gl.getParameter(gl.getExtension("WEBGL_debug_renderer_info").UNMASKED_RENDERER_WEBGL);
    } catch (e) { return `err:${e.message}`; }
  }).catch(() => null);
  console.error(`[md] GPU: ${gpu}`);
  if (!/GTX 1070/.test(gpu || "")) await bail(`not the 1070 GPU (${gpu})`, 5);
  const hasNativeMD = await page.evaluate(() => {
    const c = document.createElement("canvas");
    const gl = c.getContext("webgl2");
    return !!gl.getExtension("WEBGL_multi_draw");
  }).catch(() => null);
  console.error(`[md] WEBGL_multi_draw present: ${hasNativeMD}`);

  const s = await settleAt(page, process.env.POI || "Holtburg",
    { log: (m) => console.error(`[md] ${m}`), pinPose: process.env.PIN_POSE || null });
  if (!s.settled) await bail("not settled; abort", 4);

  // Sample AFTER render() returns, so _multiDrawCount holds what was actually
  // submitted this frame (onBeforeRender writes it during the render).
  await page.evaluate(() => {
    const ls = window.liveScene3d, r = ls.renderer;
    if (r?.info) r.info.autoReset = false;
    const D = window.__md = { raf: 0, frames: 0, subDraws: 0, activeBatches: 0, renderMs: 0, byGroup: {} };
    const groupOf = (o) => {
      let p = o;
      while (p) {
        if (["statics", "terrain", "cells", "entities", "buildings"].includes(p.name)) return p.name;
        p = p.parent;
      }
      return "(other)";
    };
    const origRender = r.render.bind(r);
    r.render = function (sc, cam) {
      const t0 = performance.now();
      try { return origRender(sc, cam); }
      finally {
        D.renderMs += performance.now() - t0;
        // only sample the main world pass (the one with the real batch counts)
        let sub = 0, active = 0;
        sc.traverse((o) => {
          if (!o.isBatchedMesh) return;
          const n = o._multiDrawCount | 0;
          if (n > 0) { active++; sub += n; }
          const g = groupOf(o);
          const b = (D.byGroup[g] ||= { sub: 0, active: 0, batches: 0 });
          b.sub += n; b.batches++; if (n > 0) b.active++;
        });
        D.subDraws += sub; D.activeBatches += active; D.frames++;
      }
    };
    D.mark = () => ({ raf: D.raf, calls: r.info.render.calls, tris: r.info.render.triangles, renderMs: D.renderMs, subDraws: D.subDraws, activeBatches: D.activeBatches, frames: D.frames, byGroup: JSON.parse(JSON.stringify(D.byGroup)) });
    const loop = () => { D.raf++; requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  });

  await sleep(2000);
  const a = await page.evaluate(() => window.__md.mark());
  await sleep(+(process.env.ARM_S || 12) * 1000);
  const b = await page.evaluate(() => window.__md.mark());

  const dRaf = b.raf - a.raf, dFrames = b.frames - a.frames;
  const countedDraws = (b.calls - a.calls) / dRaf;
  // PER rAF, NOT per render() call. There are ~19 render() calls per frame
  // (HANDOFF §3.4: sky_scene + an ortho downsample chain), and only the world
  // scene contains BatchedMesh — the other ~18 traverse a scene with none and
  // contribute 0. Dividing the sub-draw total by render() calls therefore
  // divides a per-frame quantity by 19 and understates it by that factor. The
  // first run of this probe did exactly that and printed "307 sub-draws,
  // undercount 1.15x" — the true figures are 19x larger. Everything else here
  // (info.calls, renderCPU) was already per-rAF, which is what made the
  // mismatch survivable: the sub-draw row simply disagreed with the CPU row.
  const subDraws = (b.subDraws - a.subDraws) / dRaf;
  const activeBatches = (b.activeBatches - a.activeBatches) / dRaf;
  const renderMs = (b.renderMs - a.renderMs) / dRaf;

  console.error(`[md] ==========================================================`);
  console.error(`[md] rAF frames=${dRaf}  render() calls sampled=${dFrames} (${(dFrames / dRaf).toFixed(1)} per frame — only the world scene holds batches)`);
  console.error(`[md] info.render.calls        = ${countedDraws.toFixed(1)} / frame   <-- what every number in this chain used`);
  console.error(`[md] BatchedMesh sub-draws    = ${subDraws.toFixed(1)} / frame  across ${activeBatches.toFixed(1)} active batches`);
  console.error(`[md] TRUE draw count          ~ ${(countedDraws - activeBatches + subDraws).toFixed(1)} / frame  (counted - 1/batch + its ranges)`);
  console.error(`[md] undercount factor        ~ ${((countedDraws - activeBatches + subDraws) / countedDraws).toFixed(2)}x`);
  console.error(`[md] renderCPU = ${renderMs.toFixed(2)}ms/frame`);
  for (const [g, v] of Object.entries(b.byGroup)) {
    const av = a.byGroup[g] || { sub: 0, active: 0 };
    const s2 = (v.sub - av.sub) / dRaf, ac = (v.active - av.active) / dRaf;
    if (s2 <= 0 && ac <= 0) continue;
    console.error(`[md]   ${g.padEnd(10)} ${ac.toFixed(1)} active batches -> ${s2.toFixed(1)} sub-draws/frame`);
  }

  fs.writeFileSync(process.env.OUT || "/mnt/wbterminal2/tmp/multidraw-truth.json",
    JSON.stringify({ poi: process.env.POI || "Holtburg", gpu, hasNativeMD, settle: s, a, b, countedDraws, subDraws, activeBatches, renderMs }, null, 2));
  await page.close();
  process.exit(0);
})();
