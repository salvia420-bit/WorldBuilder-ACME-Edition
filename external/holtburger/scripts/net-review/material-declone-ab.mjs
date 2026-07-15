// material-declone-ab — the decisive test for the program-thrash hypothesis,
// A/B/A INSIDE ONE PAGE LOAD, no source change.
//
// THE CLAIM (three r184 source + a live census, not a delta):
//   :18332  } else if ( object.isBatchedMesh && materialProperties.batching === false ) { needsProgramChange = true; }
//   :18336  } else if ( !object.isBatchedMesh && materialProperties.batching === true ) { needsProgramChange = true; }
//   :18440  if ( needsProgramChange === true ) program = getProgram( material, scene, object );
//   :18098  getProgram -> getParameters(...) + getProgramCacheKey(...)  — BOTH before the
//   :18127  "identical program" early-out.
// `materialProperties` is per MATERIAL. material-class-thrash-probe measured that
// 37 materials at a settled Holtburg are rendered by BOTH a BatchedMesh and a
// plain Mesh — 440 of 2,986 visible meshes (14.7%). Each such object flips
// `materialProperties.batching` and pays a full getParameters + cache-key STRING
// BUILD every frame for a program that never actually changes. The CPU profile
// independently puts `getParameters` at 10.2% self — the #1 item in the frame.
//
// THE TEST: give every BatchedMesh whose material is shared with a non-batched
// object its OWN CLONE. Same parameters => same programCacheKey => three's
// program cache hands back the SAME compiled WebGLProgram (no new shader), but
// now `materialProperties.batching` is stable per material object, so the
// early-out at :18127 fires and the per-frame getParameters disappears.
//
// If renderCPU drops, the hypothesis is confirmed AND the fix is named (clone
// the bucket material in static_batch_x.js `_getOrCreateBucket`). If it does
// not, the hypothesis is dead and the getParameters cost is elsewhere — another
// needsProgramChange trigger (envMap/fog/vertexAlphas/clipping/toneMapping/lights
// version) or a genuine per-frame `needsUpdate` writer.
//
// A/B/A with a PLACEBO arm (predecessor §6.2 / this chain's rule 4): arm P clones
// materials of batches that are NOT shared, which should change NOTHING — if P
// moves, the harness has a systematic bias and B cannot be trusted.
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
    console.error(`[dc] ${msg}`);
    await page.close().catch(() => {});
    process.exit(code);
  };

  await page.goto(`http://127.0.0.1:8765/apps/holtburger-web/index.html?${q}`, { timeout: 60000 });
  for (let i = 0; i < 240; i++) {
    const bs = await page.evaluate(() => window.__bootState).catch(() => null);
    if (bs === "in-world" || bs === "ready") break;
    if (bs === "error") await bail("boot error (account still held? wait 150s)", 3);
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
  console.error(`[dc] GPU: ${gpu}`);
  if (!/GTX 1070/.test(gpu || "")) await bail(`not the 1070 GPU (${gpu})`, 5);

  const s = await settleAt(page, process.env.POI || "Holtburg",
    { log: (m) => console.error(`[dc] ${m}`), pinPose: process.env.PIN_POSE || null });
  if (!s.settled) await bail("not settled; abort", 4);

  const setup = await page.evaluate(() => {
    const ls = window.liveScene3d, r = ls.renderer;
    if (r?.info) r.info.autoReset = false;
    const D = window.__dc = { raf: 0, buf: [], last: -1, renderMs: 0, swapped: [] };
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

    // classify every visible mesh's material by object class
    const classes = new Map(); // material -> Set(class)
    const batches = [];
    ls.scene.traverse((o) => {
      if (!o.isMesh || o.visible === false) return;
      const c = o.isBatchedMesh ? "batched" : o.isInstancedMesh ? "instanced" : "plain";
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        if (!m) continue;
        let set = classes.get(m);
        if (!set) { set = new Set(); classes.set(m, set); }
        set.add(c);
      }
      if (o.isBatchedMesh) batches.push(o);
    });
    D.sharedBatches = batches.filter((b) => {
      const m = Array.isArray(b.material) ? b.material[0] : b.material;
      return m && (classes.get(m)?.size || 0) > 1;
    });
    D.cleanBatches = batches.filter((b) => {
      const m = Array.isArray(b.material) ? b.material[0] : b.material;
      return m && (classes.get(m)?.size || 0) === 1;
    });
    D.clone = (list) => {
      let n = 0;
      for (const b of list) {
        if (b.__dcOrig) continue;
        const m = Array.isArray(b.material) ? b.material[0] : b.material;
        if (!m) continue;
        b.__dcOrig = b.material;
        const c = m.clone();
        c.name = (m.name || "") + "#batched";
        b.material = c;
        D.swapped.push(b);
        n++;
      }
      return n;
    };
    D.restore = () => {
      for (const b of D.swapped) {
        const c = Array.isArray(b.material) ? b.material[0] : b.material;
        b.material = b.__dcOrig;
        delete b.__dcOrig;
        try { c.dispose(); } catch (_) {}
      }
      D.swapped.length = 0;
    };
    return { batches: batches.length, shared: D.sharedBatches.length, clean: D.cleanBatches.length };
  });
  console.error(`[dc] ${setup.batches} BatchedMesh: ${setup.shared} share their material with a non-batched object, ${setup.clean} do not`);
  if (setup.shared === 0) await bail("no shared-material batches at this POI — nothing to test", 6);

  const ARM_S = +(process.env.ARM_S || 14);
  const arm = async (label, action) => {
    const n = await page.evaluate((act) => {
      const D = window.__dc;
      D.restore();
      if (act === "shared") return D.clone(D.sharedBatches);
      if (act === "clean") return D.clone(D.cleanBatches);
      return 0;
    }, action);
    await sleep(2500); // let the first-use program lookup settle out of the sample
    const a = await page.evaluate(() => { window.__dc.buf.length = 0; return window.__dc.mark(); });
    await sleep(ARM_S * 1000);
    const b = await page.evaluate(() => {
      const D = window.__dc, m = D.mark();
      const dts = D.buf.slice().sort((x, y) => x - y);
      const sum = dts.reduce((x, y) => x + y, 0);
      return { ...m, fps: sum ? +(dts.length * 1000 / sum).toFixed(2) : null };
    });
    const dRaf = b.raf - a.raf;
    const o = {
      label, cloned: n,
      drawsPerFrame: +((b.calls - a.calls) / dRaf).toFixed(1),
      trisPerFrame: Math.round((b.tris - a.tris) / dRaf),
      renderMsPerFrame: +((b.renderMs - a.renderMs) / dRaf).toFixed(2),
      fps: b.fps,
    };
    console.error(`[dc] ${label.padEnd(26)} cloned=${String(n).padStart(4)}  draws/f=${String(o.drawsPerFrame).padStart(7)}  tris/f=${String(o.trisPerFrame).padStart(7)}  renderCPU=${String(o.renderMsPerFrame).padStart(6)}ms  fps=${o.fps}`);
    return o;
  };

  const rows = [];
  const bases = [];
  bases.push(await arm("A-baseline#1", "none"));
  for (let rep = 1; rep <= +(process.env.REPS || 2); rep++) {
    rows.push({ ...(await arm(`B-declone-SHARED#${rep}`, "shared")), tag: "B-shared" });
    rows.push({ ...(await arm(`P-declone-CLEAN#${rep}`, "clean")), tag: "P-placebo" });
    bases.push(await arm(`A-baseline#${rep + 1}`, "none"));
  }

  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const baseMs = mean(bases.map((b) => b.renderMsPerFrame));
  const spread = Math.max(...bases.map((b) => b.renderMsPerFrame)) - Math.min(...bases.map((b) => b.renderMsPerFrame));
  console.error(`[dc] ==========================================================`);
  console.error(`[dc] baseline mean ${baseMs.toFixed(2)}ms (n=${bases.length}, spread ${spread.toFixed(2)}ms = NOISE FLOOR)`);
  const byTag = {};
  for (const r of rows) (byTag[r.tag] ||= []).push(r);
  for (const [tag, rs] of Object.entries(byTag)) {
    const ms = rs.map((r) => +(baseMs - r.renderMsPerFrame).toFixed(2));
    console.error(`[dc]   ${tag.padEnd(10)} cloned=${rs[0].cloned}  saves ${mean(ms).toFixed(2)}ms (${(100 * mean(ms) / baseMs).toFixed(1)}%)  [reps: ${ms.join(", ")}]`);
  }
  console.error(`[dc] VERDICT RULE (stated before the run): B counts only if it beats the baseline`);
  console.error(`[dc] spread AND the P placebo (which clones non-shared batches) stays ~0.`);

  fs.writeFileSync(process.env.OUT || "/mnt/wbterminal2/tmp/material-declone.json",
    JSON.stringify({ poi: process.env.POI || "Holtburg", gpu, extraQ: process.env.EXTRA_Q || "", settle: s, setup, bases, rows }, null, 2));
  await page.close();
  process.exit(0);
})();
