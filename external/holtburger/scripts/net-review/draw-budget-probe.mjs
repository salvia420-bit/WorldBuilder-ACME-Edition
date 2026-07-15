// draw-budget-probe — WHERE do the ~2,150 draws/frame at Holtburg actually go?
//
// The particle double-submit fix (8806e130) took k from 2.01 to 1.00 and bought
// +21% fps, but the floor it exposed is the real story: with EVERY particle
// hidden, Holtburg still draws ~1,917 calls/frame at ~20 fps on a GTX 1070.
// That is draw-call bound, and particles are no longer the dominant term — so
// the next lever has to be chosen from evidence, not from where the last three
// sessions happened to be looking.
//
// METHOD — attribution by DIFFERENCE, inside ONE page load (§6 rule 1 of
// HANDOFF-perf-doubleside-twopass: never attribute draws with a per-object
// hook; three calls onBeforeRender ONCE and can issue TWO draw calls, so hooks
// lie). Hide one subtree, measure the drop, restore, repeat. What a subtree
// costs IS what disappears when it stops rendering. Also censuses the scene by
// object type, because 2,266 individual THREE.Mesh nodes and 2,266 instances
// inside a BatchedMesh cost wildly different numbers of draw calls, and the
// difference between them is the size of the batching prize.
//
// A/B/A on every subtree: the baseline is re-measured at the END, so drift is
// visible rather than assumed.
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
    console.error(`[db] ${msg}`);
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
  console.error(`[db] GPU: ${gpu}`);
  if (!/GTX 1070/.test(gpu || "")) await bail(`not the 1070 GPU (${gpu})`, 5);

  const s = await settleAt(page, process.env.POI || "Holtburg",
    { log: (m) => console.error(`[db] ${m}`), pinPose: process.env.PIN_POSE || null });
  if (!s.settled) await bail("not settled; abort", 4);

  await page.evaluate(() => {
    const ls = window.liveScene3d, r = ls.renderer;
    if (r?.info) r.info.autoReset = false;
    const D = window.__db = { raf: 0, buf: [], last: -1, hidden: [] };
    const loop = (now) => {
      D.raf++;
      if (D.last >= 0) { const dt = now - D.last; if (dt > 0 && dt < 60000) D.buf.push(dt); }
      D.last = now;
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
    D.mark = () => ({ raf: D.raf, calls: r.info.render.calls, tris: r.info.render.triangles });
    // Hide a subtree by pinning `visible` to false through an accessor that
    // swallows writes — the per-frame cullers (cullStaticsGroup,
    // tickEntityRenderVisibility, RP6) would otherwise re-assert it and the arm
    // would silently measure nothing.
    D.hide = (obj) => {
      const own = Object.getOwnPropertyDescriptor(obj, "visible");
      obj.__dbPrev = own && "value" in own ? own.value : true;
      Object.defineProperty(obj, "visible", { configurable: true, enumerable: true, get() { return false; }, set(_v) {} });
      D.hidden.push(obj);
    };
    D.restore = () => {
      for (const o of D.hidden) {
        delete o.visible;
        Object.defineProperty(o, "visible", { configurable: true, enumerable: true, writable: true, value: o.__dbPrev !== false });
        delete o.__dbPrev;
      }
      D.hidden.length = 0;
    };
  });

  // Census by object type — the batching prize is the gap between "meshes" and
  // "draw calls they could cost if batched".
  const census = await page.evaluate(() => {
    const ls = window.liveScene3d;
    const byGroup = {};
    const walk = (root, label) => {
      const c = { meshes: 0, batched: 0, batchedInstances: 0, instanced: 0, instancedCount: 0, hiddenMeshes: 0, materials: new Set() };
      root.traverse((o) => {
        if (o.visible === false) { if (o.isMesh) c.hiddenMeshes++; return; }
        if (o.isBatchedMesh) { c.batched++; c.batchedInstances += o._geometryCount ?? o._instanceInfo?.length ?? 0; }
        else if (o.isInstancedMesh) { c.instanced++; c.instancedCount += o.count | 0; }
        else if (o.isMesh) {
          c.meshes++;
          const ms = Array.isArray(o.material) ? o.material : [o.material];
          for (const m of ms) if (m) c.materials.add(m.uuid);
        }
      });
      byGroup[label] = { ...c, materials: c.materials.size };
      return byGroup[label];
    };
    for (const ch of ls.scene.children) walk(ch, ch.name || ch.type);
    return byGroup;
  });
  console.error(`[db] --- scene census (visible only) ---`);
  for (const [k, v] of Object.entries(census)) {
    if (!v.meshes && !v.batched && !v.instanced) continue;
    console.error(`[db]   ${k.padEnd(22)} plainMesh=${String(v.meshes).padStart(5)} uniqMat=${String(v.materials).padStart(4)}  batched=${v.batched}(${v.batchedInstances} inst)  instanced=${v.instanced}(${v.instancedCount})`);
  }

  const ARM_S = +(process.env.ARM_S || 14);
  const arm = async (label, hideNames) => {
    await page.evaluate((names) => {
      const D = window.__db, ls = window.liveScene3d;
      D.restore();
      for (const n of names) {
        const o = ls.scene.getObjectByName(n);
        if (o) D.hide(o);
      }
      return D.hidden.length;
    }, hideNames);
    await sleep(1500);
    const a = await page.evaluate(() => { window.__db.buf.length = 0; return window.__db.mark(); });
    await sleep(ARM_S * 1000);
    const b = await page.evaluate(() => {
      const D = window.__db, m = D.mark();
      const dts = D.buf.slice().sort((x, y) => x - y);
      const sum = dts.reduce((x, y) => x + y, 0);
      return { ...m, fps: sum ? +(dts.length * 1000 / sum).toFixed(2) : null, p50: dts.length ? +dts[Math.floor(dts.length / 2)].toFixed(1) : null };
    });
    const dRaf = b.raf - a.raf;
    const o = { label, hidden: hideNames, drawsPerFrame: +((b.calls - a.calls) / dRaf).toFixed(1), fps: b.fps, p50: b.p50 };
    console.error(`[db] ${label.padEnd(24)} draws/f=${String(o.drawsPerFrame).padStart(7)}  fps=${String(o.fps).padStart(6)}  p50=${o.p50}ms`);
    return o;
  };

  const base = await arm("A-baseline", []);
  const results = [];
  for (const name of (process.env.GROUPS || "statics,entities,terrain,worldRoot").split(",")) {
    results.push(await arm(`hide:${name}`, [name]));
  }
  const base2 = await arm("A2-baseline", []);

  console.error(`[db] ==========================================================`);
  console.error(`[db] baseline ${base.drawsPerFrame} draws @ ${base.fps} fps; A2 ${base2.drawsPerFrame} @ ${base2.fps} (drift ${(base2.drawsPerFrame - base.drawsPerFrame).toFixed(1)} draws)`);
  for (const r of results) {
    const cost = +(base.drawsPerFrame - r.drawsPerFrame).toFixed(1);
    const fpsGain = r.fps != null && base.fps ? +(100 * (r.fps - base.fps) / base.fps).toFixed(1) : null;
    console.error(`[db]   ${r.label.padEnd(22)} costs ${String(cost).padStart(7)} draws/f (${(100 * cost / base.drawsPerFrame).toFixed(1)}% of budget)  -> hiding it gives ${fpsGain}% fps`);
  }

  fs.writeFileSync(process.env.OUT || "/mnt/wbterminal2/tmp/draw-budget.json",
    JSON.stringify({ poi: process.env.POI || "Holtburg", gpu, settle: s, census, base, base2, results }, null, 2));
  await page.close();
  process.exit(0);
})();
