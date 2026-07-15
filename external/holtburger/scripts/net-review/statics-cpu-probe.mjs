// statics-cpu-probe — WHERE inside `statics` do 16.6 of 28 ms of render CPU go?
//
// THE FINDING THIS EXISTS TO CHASE (draw-budget-cpu.mjs, Holtburg, 1070,
// 2026-07-15 — A2 drift 1.8 draws / 0.01 ms):
//
//   group      draws/f            renderCPU/f          us per draw
//   statics    521.4  (27.1%)     16.61ms  (59.3%)     ~32
//   cells      768.0  (39.9%)      3.58ms  (12.8%)     ~5
//   entities   612.7  (31.8%)      4.87ms  (17.4%)     ~8
//
// `cells` issues 47% MORE draws than `statics` and costs 4.6x LESS CPU. A draw
// is ~5us (cells is the control that establishes it). So the frame is NOT
// draw-call-count bound — HANDOFF §3.1's headline lever ("the next lever is
// draw-call COUNT") does not survive its own probe. Something about `statics`
// specifically costs ~6x per draw, and it is 59% of render CPU.
//
// statics' composition (visible, live): 326 plain Mesh (286 unique materials —
// nearly 1:1, no sharing), 511 BatchedMesh holding 2,786 instances (5.5 each —
// batched, but barely), 14 InstancedMesh holding 2,992.
//
// This probe partitions statics BY OBJECT CLASS and hides one class at a time,
// same instrument as draw-budget-cpu.mjs (hide-via-accessor so the per-frame
// cullers cannot re-assert `visible`; renderCPU = `render()` wall time, which
// returns at SUBMIT and is therefore CPU; A/B/A so drift is measured).
//
// The three classes are the three live hypotheses:
//   - batched  -> three's BatchedMesh does per-FRAME JS work per instance
//                 (per-instance frustum cull, sort, _multiDraw* rebuild). 511
//                 batches x 2,786 instances would be paid every frame.
//   - plain    -> 326 meshes with 286 unique materials; HANDOFF §3.2's
//                 needsUpdate -> program re-resolve tax would land here.
//   - instanced-> 14 InstancedMesh / 2,992 instances; should be ~free.
// Whichever owns the 16.6ms is the target. Do not guess between them — this is
// the same "measure the mechanism, do not narrate one from the deltas" rule
// (HANDOFF §6.3) that turned "the win is fill rate" into "95% is CPU submit".
//
// NOISE FLOOR, honestly: draw-budget-cpu's inadvertent placebo arm
// (hide:hello-cube — ONE cube, should cost ~1 draw and ~0ms) read -2.36ms.
// So a single arm can swing ~2.4ms even when A-vs-A2 drift is 0.01ms. Treat
// any per-arm result under ~3ms as noise; 16.6ms clears it by 7x. Each arm is
// repeated (REPS, default 2) here so the spread is visible rather than assumed.
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
    console.error(`[st] ${msg}`);
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
  console.error(`[st] GPU: ${gpu}`);
  if (!/GTX 1070/.test(gpu || "")) await bail(`not the 1070 GPU (${gpu})`, 5);

  const s = await settleAt(page, process.env.POI || "Holtburg",
    { log: (m) => console.error(`[st] ${m}`), pinPose: process.env.PIN_POSE || null });
  if (!s.settled) await bail("not settled; abort", 4);

  await page.evaluate(() => {
    const ls = window.liveScene3d, r = ls.renderer;
    if (r?.info) r.info.autoReset = false;
    const D = window.__st = { raf: 0, buf: [], last: -1, hidden: [], renderMs: 0 };
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
    D.hide = (obj) => {
      const own = Object.getOwnPropertyDescriptor(obj, "visible");
      obj.__stPrev = own && "value" in own ? own.value : true;
      Object.defineProperty(obj, "visible", { configurable: true, enumerable: true, get() { return false; }, set(_v) {} });
      D.hidden.push(obj);
    };
    D.restore = () => {
      for (const o of D.hidden) {
        delete o.visible;
        Object.defineProperty(o, "visible", { configurable: true, enumerable: true, writable: true, value: o.__stPrev !== false });
        delete o.__stPrev;
      }
      D.hidden.length = 0;
    };
    // Partition the target group by object class. `cls` is evaluated against a
    // live object, so this cannot drift from what three actually dispatches on.
    D.hideClass = (groupName, cls) => {
      const g = ls.scene.getObjectByName(groupName);
      let n = 0;
      g.traverse((o) => {
        if (o.visible === false) return;
        const isB = !!o.isBatchedMesh, isI = !!o.isInstancedMesh, isM = !!o.isMesh;
        const pick = cls === "batched" ? isB : cls === "instanced" ? isI : cls === "plain" ? (isM && !isB && !isI) : false;
        if (pick) { D.hide(o); n++; }
      });
      return n;
    };
  });

  const ARM_S = +(process.env.ARM_S || 14);
  const REPS = +(process.env.REPS || 2);
  const measure = async (label) => {
    await sleep(1500);
    const a = await page.evaluate(() => { window.__st.buf.length = 0; return window.__st.mark(); });
    await sleep(ARM_S * 1000);
    const b = await page.evaluate(() => {
      const D = window.__st, m = D.mark();
      const dts = D.buf.slice().sort((x, y) => x - y);
      const sum = dts.reduce((x, y) => x + y, 0);
      return { ...m, fps: sum ? +(dts.length * 1000 / sum).toFixed(2) : null, p50: dts.length ? +dts[Math.floor(dts.length / 2)].toFixed(1) : null };
    });
    const dRaf = b.raf - a.raf;
    const o = {
      label,
      drawsPerFrame: +((b.calls - a.calls) / dRaf).toFixed(1),
      renderMsPerFrame: +((b.renderMs - a.renderMs) / dRaf).toFixed(2),
      fps: b.fps, p50: b.p50,
    };
    console.error(`[st] ${label.padEnd(22)} draws/f=${String(o.drawsPerFrame).padStart(7)}  renderCPU=${String(o.renderMsPerFrame).padStart(6)}ms  fps=${String(o.fps).padStart(6)}`);
    return o;
  };
  const armClass = async (cls, rep) => {
    const n = await page.evaluate(({ g, c }) => { window.__st.restore(); return window.__st.hideClass(g, c); },
      { g: process.env.GROUP || "statics", c: cls });
    const o = await measure(`hide:${cls}#${rep} (n=${n})`);
    return { ...o, cls, rep, hiddenCount: n };
  };
  const armBase = async (label) => {
    await page.evaluate(() => window.__st.restore());
    return measure(label);
  };

  const rows = [];
  const bases = [];
  bases.push(await armBase("A-baseline#1"));
  for (let rep = 1; rep <= REPS; rep++) {
    for (const cls of ["batched", "plain", "instanced"]) rows.push(await armClass(cls, rep));
    bases.push(await armBase(`A-baseline#${rep + 1}`));
  }

  // Use the MEAN of the repeated baselines, and report the baselines' own
  // spread — that spread IS this run's noise floor, so every cost below can be
  // read against a number the run measured rather than one I asserted.
  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const baseMs = mean(bases.map((b) => b.renderMsPerFrame));
  const baseDraws = mean(bases.map((b) => b.drawsPerFrame));
  const baseSpread = Math.max(...bases.map((b) => b.renderMsPerFrame)) - Math.min(...bases.map((b) => b.renderMsPerFrame));
  console.error(`[st] ==========================================================`);
  console.error(`[st] baseline mean ${baseDraws.toFixed(1)} draws / ${baseMs.toFixed(2)}ms  (n=${bases.length}, renderCPU spread ${baseSpread.toFixed(2)}ms = THIS RUN'S NOISE FLOOR)`);
  const byCls = {};
  for (const r of rows) (byCls[r.cls] ||= []).push(r);
  for (const [cls, rs] of Object.entries(byCls)) {
    const costMs = rs.map((r) => +(baseMs - r.renderMsPerFrame).toFixed(2));
    const costDraws = rs.map((r) => +(baseDraws - r.drawsPerFrame).toFixed(1));
    const mMs = mean(costMs), mDraws = mean(costDraws);
    const usPer = mDraws > 0 ? Math.round(1000 * mMs / mDraws) : null;
    console.error(`[st]   ${cls.padEnd(10)} n=${String(rs[0].hiddenCount).padStart(4)} objs  costs ${mDraws.toFixed(1)} draws/f  ${mMs.toFixed(2)}ms CPU (${(100 * mMs / baseMs).toFixed(1)}% of frame)  ${usPer == null ? "" : `~${usPer}us/draw`}   [reps ms: ${costMs.join(", ")}]`);
  }
  console.error(`[st] NOTE fps is vsync-quantized (~8.3ms steps) — read draws + renderCPU.`);

  fs.writeFileSync(process.env.OUT || "/mnt/wbterminal2/tmp/statics-cpu.json",
    JSON.stringify({ poi: process.env.POI || "Holtburg", group: process.env.GROUP || "statics", gpu, settle: s, bases, rows }, null, 2));
  await page.close();
  process.exit(0);
})();
