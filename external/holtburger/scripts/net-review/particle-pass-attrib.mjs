// particle-pass-attrib — NAME the second pass that re-submits every particle.
//
// particle-k-probe settled that k=2.01/1.99 (A/B/A, one page load, drift 0.1%):
// every visible particle costs TWO draw calls per frame. It also showed
// renders/rAF = 19 — nineteen top-level renderer.render() calls per frame
// (three r184 increments info.render.frame once per render(), :17632) with NO
// composer and shadowMap DISABLED. So ~19 passes exist and exactly 2 of them
// draw particles. This probe says WHICH.
//
// METHOD — attribution by DIFFERENCE, not by hook. The prior session's ruling
// ("a second world render was ruled OUT") used a per-object onBeforeRender hook
// that it admitted mis-fired (attributed 118 of 1574 draws). So this does not
// trust any hook to fire: it wraps renderer.render(), buckets draw calls per
// PASS by diffing info.render.calls across each call, then runs the SAME
// particles-hidden arm as particle-k-probe. The passes whose per-frame draw
// count DROPS when particles are hidden are, by construction, the passes that
// were drawing particles — no hook, no assumption about traversal.
//
// Each pass is keyed by (scene, camera, render target) and stamped ONCE with
// the JS call-site stack, so the answer is a source location, not a uuid.
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
  const bail = async (msg, code) => { // §2 rule 7: every bail closes the page
    console.error(`[pa] ${msg}`);
    await page.close().catch(() => {});
    process.exit(code);
  };

  await page.goto(`http://127.0.0.1:8765/apps/holtburger-web/index.html?${q}`, { timeout: 60000 });
  for (let i = 0; i < 240; i++) {
    const bs = await page.evaluate(() => window.__bootState).catch(() => null);
    if (bs === "in-world" || bs === "ready") break;
    if (bs === "error") await bail("boot error (account still held?)", 3);
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
  console.error(`[pa] GPU: ${gpu}`);
  if (!/GTX 1070/.test(gpu || "")) await bail(`not the 1070 GPU (${gpu})`, 5);

  const s = await settleAt(page, process.env.POI || "Holtburg",
    { log: (m) => console.error(`[pa] ${m}`), pinPose: process.env.PIN_POSE || null });
  if (!s.settled) await bail("not settled; abort", 4);

  await page.evaluate(() => {
    const ls = window.liveScene3d, r = ls.renderer;
    if (r?.info) r.info.autoReset = false;
    const P = window.__pa = { passes: new Map(), raf: 0, depth: 0, pinning: false, pinned: new Set(), partSamples: [] };

    P.isParticle = (o) => o && o.isMesh && !o.isInstancedMesh && o.userData && o.userData.__particle === true;
    P.pin = (o) => {
      P.pinned.add(o);
      const own = Object.getOwnPropertyDescriptor(o, "visible");
      o.__paPrev = own && "value" in own ? own.value : true;
      try {
        Object.defineProperty(o, "visible", { configurable: true, enumerable: true, get() { return false; }, set(_v) {} });
      } catch (_) { P.pinned.delete(o); }
    };
    P.unpinAll = () => {
      for (const o of P.pinned) {
        try {
          delete o.visible;
          Object.defineProperty(o, "visible", { configurable: true, enumerable: true, writable: true, value: o.__paPrev !== false });
          delete o.__paPrev;
        } catch (_) {}
      }
      P.pinned.clear();
    };
    P.sweep = () => {
      let drawable = 0;
      ls.scene.traverse((o) => {
        if (!P.isParticle(o)) return;
        if (o.visible !== false) drawable++;
        if (P.pinning && !P.pinned.has(o)) P.pin(o);
      });
      P.partSamples.push(drawable);
    };
    setInterval(P.sweep, 500);

    // Wrap render(). Bucket draws per pass by DIFFING info.render.calls across
    // the call — nested render() (render-target passes) is handled by a depth
    // counter so an outer pass is not credited with an inner pass's draws.
    const orig = r.render.bind(r);
    r.render = function (scene, camera) {
      const rt = r.getRenderTarget();
      const key = `${scene?.name || "scene"}#${(scene?.uuid || "").slice(0, 6)}|cam:${camera?.name || camera?.type}#${(camera?.uuid || "").slice(0, 6)}|rt:${rt ? `${rt.width}x${rt.height}#${(rt.uuid || "").slice(0, 6)}` : "screen"}`;
      let e = P.passes.get(key);
      if (!e) {
        // Stamp the call site ONCE: a uuid is not an answer, a source line is.
        let stack = "";
        try { stack = new Error().stack.split("\n").slice(2, 7).join(" <- ").replace(/https?:\/\/[^/]+/g, ""); } catch (_) {}
        e = {
          key, stack, calls: 0, draws: 0, sceneName: scene?.name || null,
          sceneChildren: scene?.children?.length ?? null, camType: camera?.type || null,
          isMainScene: scene === ls.scene, nested: P.depth > 0,
        };
        P.passes.set(key, e);
      }
      const before = r.info.render.calls;
      P.depth++;
      try { return orig(scene, camera); }
      finally {
        P.depth--;
        const drew = r.info.render.calls - before;
        e.calls++;
        e.draws += drew;      // includes nested passes' draws; `nested` flags those
        if (P.window) { e.wCalls = (e.wCalls || 0) + 1; e.wDraws = (e.wDraws || 0) + drew; }
      }
    };

    P.raf = 0;
    const loop = () => { P.raf++; requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
    P.open = () => { P.window = true; P.raf0 = P.raf; for (const e of P.passes.values()) { e.wCalls = 0; e.wDraws = 0; } P.partSamples.length = 0; };
    P.close = () => {
      P.window = false;
      const frames = P.raf - P.raf0;
      const ps = P.partSamples;
      return {
        frames,
        parts: ps.length ? +(ps.reduce((a, b) => a + b, 0) / ps.length).toFixed(1) : null,
        passes: [...P.passes.values()].map((e) => ({
          key: e.key, stack: e.stack, sceneName: e.sceneName, sceneChildren: e.sceneChildren,
          camType: e.camType, isMainScene: e.isMainScene, nested: e.nested,
          callsPerFrame: +((e.wCalls || 0) / frames).toFixed(2),
          drawsPerFrame: +((e.wDraws || 0) / frames).toFixed(1),
        })).sort((a, b) => b.drawsPerFrame - a.drawsPerFrame),
      };
    };
  });

  const ARM_S = +(process.env.ARM_S || 20);
  const arm = async (label, pinning) => {
    await page.evaluate((p) => { window.__pa.pinning = p; if (p) window.__pa.sweep(); else window.__pa.unpinAll(); }, pinning);
    await sleep(1500);
    await page.evaluate(() => window.__pa.open());
    await sleep(ARM_S * 1000);
    const r = await page.evaluate(() => window.__pa.close());
    console.error(`[pa] ${label}: frames=${r.frames} parts=${r.parts}`);
    for (const p of r.passes) {
      if (p.drawsPerFrame < 0.05 && p.callsPerFrame < 0.05) continue;
      console.error(`[pa]    ${String(p.drawsPerFrame).padStart(8)} draws/f  ${String(p.callsPerFrame).padStart(5)} calls/f  ${p.nested ? "[nested] " : ""}${p.key}`);
    }
    return { label, ...r };
  };

  const A = await arm("A-baseline", false);
  const B = await arm("B-hidden", true);

  // The passes that LOST draws when particles were hidden ARE the particle
  // passes. No hook had to fire correctly for this to be true.
  const bByKey = new Map(B.passes.map((p) => [p.key, p]));
  const deltas = A.passes.map((p) => {
    const b = bByKey.get(p.key);
    return { key: p.key, stack: p.stack, sceneName: p.sceneName, camType: p.camType, nested: p.nested,
      aDraws: p.drawsPerFrame, bDraws: b ? b.drawsPerFrame : 0,
      lost: +((p.drawsPerFrame - (b ? b.drawsPerFrame : 0))).toFixed(1) };
  }).sort((x, y) => y.lost - x.lost);
  const partsDelta = +(A.parts - B.parts).toFixed(1);

  console.error(`[pa] ==========================================================`);
  console.error(`[pa] particles hidden: ${A.parts} -> ${B.parts}  (delta ${partsDelta})`);
  for (const d of deltas) {
    if (Math.abs(d.lost) < 1) continue;
    console.error(`[pa]  LOST ${String(d.lost).padStart(7)} draws/f (${(d.lost / partsDelta).toFixed(2)} per particle) ${d.nested ? "[nested] " : ""}${d.key}`);
    console.error(`[pa]        @ ${d.stack}`);
  }

  fs.writeFileSync(process.env.OUT || "/mnt/wbterminal2/tmp/particle-pass-attrib.json",
    JSON.stringify({ poi: process.env.POI || "Holtburg", gpu, settle: s, arms: { A, B }, deltas, partsDelta }, null, 2));
  await page.close();
  process.exit(0);
})();
