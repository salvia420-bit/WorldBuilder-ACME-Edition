// batchedmesh-flags-ab — is BatchedMesh's PER-FRAME INSTANCE WALK the 14ms?
//
// THE CHAIN THAT LEADS HERE (all Holtburg / 1070 / 2026-07-15):
//   draw-budget-cpu.mjs : statics = 27% of draws but 59% of render CPU;
//                         cells = 768 draws for 3.58ms (~5us/draw — that is
//                         what a draw ACTUALLY costs). So the frame is not
//                         draw-COUNT bound. HANDOFF §3.1's lever is refuted.
//   statics-cpu-probe.mjs: inside statics, the 508 BatchedMesh issue only 183
//                         draws/f but cost 13.93ms = 47.8% OF THE FRAME's
//                         render CPU (~76us/draw, reps 14.44/13.42). The 339
//                         plain meshes cost 3.48ms for 297 draws (~12us). The
//                         14 InstancedMesh cost -0.28ms (free — a control).
//
// So the single most expensive thing in the frame is the machinery we added to
// make it cheaper. THE MECHANISM, read from three r184 (not inferred):
//
//   three.core.js:27214  BatchedMesh.onBeforeRender()
//   :27218  if (!this._visibilityChanged && !this.perObjectFrustumCulled && !this.sortObjects) return;
//   :25907  this.perObjectFrustumCulled = true;   // DEFAULT ON
//   :25917  this.sortObjects = true;              // DEFAULT ON
//
// Both defaults are ON, so the early-out NEVER fires and every BatchedMesh
// walks EVERY instance EVERY frame: getMatrixAt (matrix rebuild) +
// getBoundingSphereAt + applyMatrix4 + frustum.intersectsSphere + a push into
// _renderList, then a sort. 508 batches over 2,786 instances, every frame.
//
// And our batching ratio makes it a bad trade twice over: 508 BatchedMesh hold
// 2,786 instances (5.5 each) and yield only 183 draws. We pay the full
// per-instance walk to save draws that cost ~5us each. static_batch_x.js's own
// header already recorded this shape for the v1 cross-LB batches ("a per-frame
// CPU walk over ~36k instances to build multidraw ranges", CLOSED-NEGATIVE) —
// the same tax is live in the DEFAULT config, at a smaller scale, unnoticed.
//
// BOTH FLAGS ARE PUBLIC AND RUNTIME-SETTABLE, so this needs no source change to
// measure — which is the point: measure before refactoring (HANDOFF §3.2).
//
// ARMS (one page load, A/B/C/D/A — every arm restores before the next):
//   A  baseline            both flags default-ON
//   B  sortObjects=false   drops the sort; walk still happens (cull still on)
//   C  perObjFrustum=false drops per-instance culling; walk still happens (sort on)
//   D  BOTH false          the early-out at :27218 fires -> whole walk skipped
//   A2 baseline restored   proves the flags really flip back (HANDOFF §6.4)
//
// B and C are the diagnostic arms and D is the prize; if D ~= 0 gain, the walk
// is not the cost and this whole reading is wrong. WATCH tris AND draws, not
// just renderCPU: perObjectFrustumCulled=false means instances outside the
// frustum now DRAW, so C and D can ADD GPU work. A CPU win that doubles tris is
// not a win — report both and let the numbers say it.
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
    console.error(`[bm] ${msg}`);
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
  console.error(`[bm] GPU: ${gpu}`);
  if (!/GTX 1070/.test(gpu || "")) await bail(`not the 1070 GPU (${gpu})`, 5);

  const s = await settleAt(page, process.env.POI || "Holtburg",
    { log: (m) => console.error(`[bm] ${m}`), pinPose: process.env.PIN_POSE || null });
  if (!s.settled) await bail("not settled; abort", 4);

  const setup = await page.evaluate(() => {
    const ls = window.liveScene3d, r = ls.renderer;
    if (r?.info) r.info.autoReset = false;
    const D = window.__bm = { raf: 0, buf: [], last: -1, renderMs: 0 };
    const loop = (now) => {
      D.raf++;
      if (D.last >= 0) { const dt = now - D.last; if (dt > 0 && dt < 60000) D.buf.push(dt); }
      D.last = now;
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
    const origRender = r.render.bind(r);
    r.render = function (sc, cam) {
      const t0 = performance.now();
      try { return origRender(sc, cam); }
      finally { D.renderMs += performance.now() - t0; }
    };
    D.mark = () => ({ raf: D.raf, calls: r.info.render.calls, tris: r.info.render.triangles, renderMs: D.renderMs });

    // Collect every live BatchedMesh and remember its ORIGINAL flags, so the
    // restore arm restores what was there rather than what I assume was there.
    D.batches = [];
    ls.scene.traverse((o) => {
      if (o.isBatchedMesh) {
        D.batches.push(o);
        o.__bmOrig = { pofc: o.perObjectFrustumCulled, sort: o.sortObjects };
      }
    });
    D.apply = (pofc, sort) => {
      for (const b of D.batches) {
        b.perObjectFrustumCulled = pofc === null ? b.__bmOrig.pofc : pofc;
        b.sortObjects = sort === null ? b.__bmOrig.sort : sort;
      }
      return D.batches.length;
    };
    // Report the defaults we actually found, rather than trusting the source read.
    const inst = D.batches.reduce((a, b) => a + (b._instanceInfo?.length ?? 0), 0);
    return { batches: D.batches.length, instances: inst, defaults: D.batches[0]?.__bmOrig ?? null };
  });
  console.error(`[bm] live BatchedMesh: ${setup.batches} batches / ${setup.instances} instances; defaults as found: ${JSON.stringify(setup.defaults)}`);

  const ARM_S = +(process.env.ARM_S || 14);
  const arm = async (label, pofc, sort) => {
    const n = await page.evaluate(({ p, s }) => window.__bm.apply(p, s), { p: pofc, s: sort });
    await sleep(1500);
    const a = await page.evaluate(() => { window.__bm.buf.length = 0; return window.__bm.mark(); });
    await sleep(ARM_S * 1000);
    const b = await page.evaluate(() => {
      const D = window.__bm, m = D.mark();
      const dts = D.buf.slice().sort((x, y) => x - y);
      const sum = dts.reduce((x, y) => x + y, 0);
      return { ...m, fps: sum ? +(dts.length * 1000 / sum).toFixed(2) : null, p50: dts.length ? +dts[Math.floor(dts.length / 2)].toFixed(1) : null };
    });
    const dRaf = b.raf - a.raf;
    const o = {
      label, pofc, sort, n,
      drawsPerFrame: +((b.calls - a.calls) / dRaf).toFixed(1),
      trisPerFrame: Math.round((b.tris - a.tris) / dRaf),
      renderMsPerFrame: +((b.renderMs - a.renderMs) / dRaf).toFixed(2),
      fps: b.fps, p50: b.p50,
    };
    console.error(`[bm] ${label.padEnd(28)} draws/f=${String(o.drawsPerFrame).padStart(7)}  tris/f=${String(o.trisPerFrame).padStart(7)}  renderCPU=${String(o.renderMsPerFrame).padStart(6)}ms  fps=${String(o.fps).padStart(6)}`);
    return o;
  };

  const REPS = +(process.env.REPS || 2);
  const rows = [];
  const bases = [];
  bases.push(await arm("A-baseline(defaults)", null, null));
  for (let rep = 1; rep <= REPS; rep++) {
    rows.push({ ...(await arm(`B-sortObjects=false#${rep}`, null, false)), tag: "B-nosort" });
    rows.push({ ...(await arm(`C-perObjFrustum=false#${rep}`, false, null)), tag: "C-nocull" });
    rows.push({ ...(await arm(`D-both=false#${rep}`, false, false)), tag: "D-both" });
    bases.push(await arm(`A-baseline#${rep + 1}`, null, null));
  }

  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const baseMs = mean(bases.map((b) => b.renderMsPerFrame));
  const baseDraws = mean(bases.map((b) => b.drawsPerFrame));
  const baseTris = mean(bases.map((b) => b.trisPerFrame));
  const spread = Math.max(...bases.map((b) => b.renderMsPerFrame)) - Math.min(...bases.map((b) => b.renderMsPerFrame));
  console.error(`[bm] ==========================================================`);
  console.error(`[bm] baseline mean ${baseDraws.toFixed(1)} draws / ${Math.round(baseTris)} tris / ${baseMs.toFixed(2)}ms  (n=${bases.length}, spread ${spread.toFixed(2)}ms = NOISE FLOOR)`);
  const byTag = {};
  for (const r of rows) (byTag[r.tag] ||= []).push(r);
  for (const [tag, rs] of Object.entries(byTag)) {
    const ms = rs.map((r) => +(baseMs - r.renderMsPerFrame).toFixed(2));
    const dTris = rs.map((r) => Math.round(r.trisPerFrame - baseTris));
    const dDraws = rs.map((r) => +(r.drawsPerFrame - baseDraws).toFixed(1));
    console.error(`[bm]   ${tag.padEnd(10)} saves ${mean(ms).toFixed(2)}ms CPU (${(100 * mean(ms) / baseMs).toFixed(1)}% of frame)  [reps: ${ms.join(", ")}]  tris ${mean(dTris) >= 0 ? "+" : ""}${Math.round(mean(dTris))} (${(100 * mean(dTris) / baseTris).toFixed(1)}%)  draws ${mean(dDraws) >= 0 ? "+" : ""}${mean(dDraws).toFixed(1)}`);
  }
  console.error(`[bm] NOTE fps is vsync-quantized (~8.3ms steps) — read renderCPU + tris.`);

  fs.writeFileSync(process.env.OUT || "/mnt/wbterminal2/tmp/bm-flags.json",
    JSON.stringify({ poi: process.env.POI || "Holtburg", gpu, settle: s, setup, bases, rows }, null, 2));
  await page.close();
  process.exit(0);
})();
