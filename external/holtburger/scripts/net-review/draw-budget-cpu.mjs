// draw-budget-cpu — draw-budget-probe.mjs, corrected and made CPU-honest.
//
// WHY A SECOND PROBE. The first run of draw-budget-probe.mjs (2026-07-15,
// Holtburg, 1070) was clean — GPU asserted, settled, A2 drift 0.2 draws — but
// it had two holes, and neither is visible from its own output:
//
//  1. ITS GROUP LIST WAS INCOMPLETE. The default `GROUPS=statics,entities,
//     terrain,worldRoot` misses TWO of worldRoot's five children:
//     `buildings` and `cells` (index.js:1162-1167 adds terrain, buildings,
//     statics, cells, entities). The arms summed to 1,133 draws against
//     worldRoot's 1,901 — ~768 draws/frame, 40% OF THE BUDGET, unattributed
//     and invisible unless you diff the arms against worldRoot. This probe
//     enumerates worldRoot's children AT RUNTIME instead of trusting a list.
//
//  2. IT REPORTS ONLY fps, AND fps HERE IS VSYNC-QUANTIZED. Every p50 in that
//     run was a multiple of ~8.3 ms (33.4 / 16.7 / 8.3 = 4 / 2 / 1 intervals
//     of a 120 Hz rAF). fps is therefore a STEP function of frame cost: the
//     statics arm reads "+96% fps" not because 520 draws are worth 26 fps but
//     because dropping them crosses a vsync step. HANDOFF §5.5 already says
//     to distrust fps; quantization is the mechanism, and it means an arm can
//     read +96% or +0% for the SAME ms saved depending on which side of a
//     step it lands. So: measure `renderer.render()` wall time per arm
//     (HANDOFF §6.3 — render() returns at SUBMIT, so its duration is CPU) and
//     attribute in MILLISECONDS. draws and renderCPU are the trustworthy
//     columns; fps is printed for continuity only.
//
// Everything else is draw-budget-probe.mjs's method, unchanged and credited:
// attribution by DIFFERENCE inside ONE page load, hide-via-accessor so the
// per-frame cullers cannot re-assert `visible`, and an A/B/A baseline so drift
// is measured rather than assumed.
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
    console.error(`[dbc] ${msg}`);
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
  console.error(`[dbc] GPU: ${gpu}`);
  if (!/GTX 1070/.test(gpu || "")) await bail(`not the 1070 GPU (${gpu})`, 5);

  const s = await settleAt(page, process.env.POI || "Holtburg",
    { log: (m) => console.error(`[dbc] ${m}`), pinPose: process.env.PIN_POSE || null });
  if (!s.settled) await bail("not settled; abort", 4);

  await page.evaluate(() => {
    const ls = window.liveScene3d, r = ls.renderer;
    if (r?.info) r.info.autoReset = false;
    const D = window.__dbc = { raf: 0, buf: [], last: -1, hidden: [], renderMs: 0 };
    const loop = (now) => {
      D.raf++;
      if (D.last >= 0) { const dt = now - D.last; if (dt > 0 && dt < 60000) D.buf.push(dt); }
      D.last = now;
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
    // HANDOFF §6.3: render() returns at SUBMIT, before the GPU executes, so its
    // wall time is CPU cost. This is the CPU-vs-GPU discriminator and the only
    // column here that is neither vsync-quantized nor drift-prone.
    const origRender = r.render.bind(r);
    r.render = function (sc, cam) {
      const t0 = performance.now();
      try { return origRender(sc, cam); }
      finally { D.renderMs += performance.now() - t0; }
    };
    D.mark = () => ({ raf: D.raf, calls: r.info.render.calls, tris: r.info.render.triangles, renderMs: D.renderMs });
    D.hide = (obj) => {
      const own = Object.getOwnPropertyDescriptor(obj, "visible");
      obj.__dbcPrev = own && "value" in own ? own.value : true;
      Object.defineProperty(obj, "visible", { configurable: true, enumerable: true, get() { return false; }, set(_v) {} });
      D.hidden.push(obj);
    };
    D.restore = () => {
      for (const o of D.hidden) {
        delete o.visible;
        Object.defineProperty(o, "visible", { configurable: true, enumerable: true, writable: true, value: o.__dbcPrev !== false });
        delete o.__dbcPrev;
      }
      D.hidden.length = 0;
    };
  });

  // Census PER GROUP, enumerated from the live graph. The batching prize is the
  // gap between "plain meshes" (~1 draw each) and what they would cost batched,
  // so the census has to say WHICH group owns the plain meshes.
  const census = await page.evaluate(() => {
    const ls = window.liveScene3d;
    const walk = (root) => {
      const c = { meshes: 0, batched: 0, batchedInstances: 0, instanced: 0, instancedCount: 0, hiddenMeshes: 0, mats: new Set(), geos: new Set() };
      root.traverse((o) => {
        if (o.visible === false) { if (o.isMesh) c.hiddenMeshes++; return; }
        if (o.isBatchedMesh) { c.batched++; c.batchedInstances += o._geometryCount ?? o._instanceInfo?.length ?? 0; }
        else if (o.isInstancedMesh) { c.instanced++; c.instancedCount += o.count | 0; }
        else if (o.isMesh) {
          c.meshes++;
          const ms = Array.isArray(o.material) ? o.material : [o.material];
          for (const m of ms) if (m) c.mats.add(m.uuid);
          if (o.geometry) c.geos.add(o.geometry.uuid);
        }
      });
      return { meshes: c.meshes, batched: c.batched, batchedInstances: c.batchedInstances, instanced: c.instanced, instancedCount: c.instancedCount, hiddenMeshes: c.hiddenMeshes, uniqMat: c.mats.size, uniqGeo: c.geos.size };
    };
    const out = { _groups: [] };
    const wr = ls.scene.getObjectByName("worldRoot");
    out.worldRoot = walk(wr);
    for (const ch of wr.children) {
      const n = ch.name || ch.type;
      out[n] = walk(ch);
      out._groups.push(n);
    }
    return out;
  });
  console.error(`[dbc] --- worldRoot children (runtime-enumerated): ${census._groups.join(",")} ---`);
  for (const k of ["worldRoot", ...census._groups]) {
    const v = census[k];
    if (!v) continue;
    console.error(`[dbc]   ${k.padEnd(12)} plainMesh=${String(v.meshes).padStart(5)} uniqMat=${String(v.uniqMat).padStart(4)} uniqGeo=${String(v.uniqGeo).padStart(4)}  batched=${v.batched}(${v.batchedInstances} inst)  instanced=${v.instanced}(${v.instancedCount})`);
  }

  const ARM_S = +(process.env.ARM_S || 14);
  const arm = async (label, hideNames) => {
    await page.evaluate((names) => {
      const D = window.__dbc, ls = window.liveScene3d;
      D.restore();
      for (const n of names) {
        const o = ls.scene.getObjectByName(n);
        if (o) D.hide(o);
      }
      return D.hidden.length;
    }, hideNames);
    await sleep(1500);
    const a = await page.evaluate(() => { window.__dbc.buf.length = 0; return window.__dbc.mark(); });
    await sleep(ARM_S * 1000);
    const b = await page.evaluate(() => {
      const D = window.__dbc, m = D.mark();
      const dts = D.buf.slice().sort((x, y) => x - y);
      const sum = dts.reduce((x, y) => x + y, 0);
      return { ...m, fps: sum ? +(dts.length * 1000 / sum).toFixed(2) : null, p50: dts.length ? +dts[Math.floor(dts.length / 2)].toFixed(1) : null };
    });
    const dRaf = b.raf - a.raf;
    const o = {
      label, hidden: hideNames,
      drawsPerFrame: +((b.calls - a.calls) / dRaf).toFixed(1),
      renderMsPerFrame: +((b.renderMs - a.renderMs) / dRaf).toFixed(2),
      fps: b.fps, p50: b.p50,
    };
    console.error(`[dbc] ${label.padEnd(18)} draws/f=${String(o.drawsPerFrame).padStart(7)}  renderCPU=${String(o.renderMsPerFrame).padStart(6)}ms  fps=${String(o.fps).padStart(6)}  p50=${o.p50}ms`);
    return o;
  };

  // Groups come from the live graph, not from a hardcoded list — the first
  // probe's 768 unattributed draws were exactly the two groups its list omitted.
  const groups = (process.env.GROUPS || census._groups.join(",")).split(",").filter(Boolean);
  const base = await arm("A-baseline", []);
  const results = [];
  for (const name of groups) results.push(await arm(`hide:${name}`, [name]));
  const wr = await arm("hide:worldRoot", ["worldRoot"]);
  const base2 = await arm("A2-baseline", []);

  const drift = +(base2.drawsPerFrame - base.drawsPerFrame).toFixed(1);
  const driftMs = +(base2.renderMsPerFrame - base.renderMsPerFrame).toFixed(2);
  console.error(`[dbc] ==========================================================`);
  console.error(`[dbc] baseline ${base.drawsPerFrame} draws / ${base.renderMsPerFrame}ms renderCPU; A2 ${base2.drawsPerFrame} / ${base2.renderMsPerFrame}ms (drift ${drift} draws, ${driftMs}ms)`);
  let sumDraws = 0, sumMs = 0;
  for (const r of [...results, wr]) {
    const cost = +(base.drawsPerFrame - r.drawsPerFrame).toFixed(1);
    const costMs = +(base.renderMsPerFrame - r.renderMsPerFrame).toFixed(2);
    if (r !== wr) { sumDraws += cost; sumMs += costMs; }
    const usPer = cost > 0 ? Math.round(1000 * costMs / cost) : null;
    console.error(`[dbc]   ${r.label.padEnd(18)} costs ${String(cost).padStart(7)} draws/f (${(100 * cost / base.drawsPerFrame).toFixed(1)}%)  ${String(costMs).padStart(6)}ms CPU (${(100 * costMs / base.renderMsPerFrame).toFixed(1)}%)  ${usPer == null ? "" : `~${usPer}us/draw`}`);
  }
  // The completeness check the first probe could not make: do the parts sum to
  // the whole? A gap here means a group is unattributed (or double-counted).
  const wrDraws = +(base.drawsPerFrame - wr.drawsPerFrame).toFixed(1);
  const wrMs = +(base.renderMsPerFrame - wr.renderMsPerFrame).toFixed(2);
  console.error(`[dbc] SUM(children) = ${sumDraws.toFixed(1)} draws / ${sumMs.toFixed(2)}ms  vs  worldRoot = ${wrDraws} draws / ${wrMs}ms  -> unattributed ${(wrDraws - sumDraws).toFixed(1)} draws / ${(wrMs - sumMs).toFixed(2)}ms`);
  console.error(`[dbc] NOTE fps/p50 are vsync-quantized (~8.3ms steps @120Hz rAF) — read draws + renderCPU, not fps.`);

  fs.writeFileSync(process.env.OUT || "/mnt/wbterminal2/tmp/draw-budget-cpu.json",
    JSON.stringify({ poi: process.env.POI || "Holtburg", gpu, settle: s, census, base, base2, results, worldRoot: wr }, null, 2));
  await page.close();
  process.exit(0);
})();
