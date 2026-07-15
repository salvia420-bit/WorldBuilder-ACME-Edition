// town-fps probe — frame time + draws at a SETTLED, PINNED town-centre pose.
// The outdoor-run battery runs obstacle-free corridors >=40m from any static
// (its generator's contract), so it contains almost no default_script particle
// emitters and cannot see a particle fix at all (measured: ~260-310 draws/frame
// there vs ~1600 at a settled town centre). This probe stands where the
// particles are and samples frame times.
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
  // EVERY early exit must close the page first — tailnet1 is single-login, so a
  // page left open by a bail stays logged in and the next run boots into a
  // starved world or is rejected outright (__bootState==='error', which reads
  // like a boot bug and is not one). Both bails below leaked a page before.
  const bail = async (msg, code) => {
    console.error(`[tf] ${msg}`);
    await page.close().catch(() => {});
    process.exit(code);
  };

  await page.goto(`http://127.0.0.1:8765/apps/holtburger-web/index.html?${q}`, { timeout: 60000 });
  for (let i = 0; i < 240; i++) {
    const bs = await page.evaluate(() => window.__bootState).catch(() => null);
    if (bs === "in-world" || bs === "ready") break;
    if (bs === "error") await bail("boot error (account still held? wait for the login gap)", 3);
    await sleep(1000);
  }
  for (let i = 0; i < 90; i++) {
    if (await page.evaluate(() => !!(window.liveScene3d?.scene)).catch(() => false)) break;
    await sleep(1000);
  }

  const s = await settleAt(page, process.env.POI || "Cragstone",
    { log: (m) => console.error(`[tf] ${m}`), pinPose: process.env.PIN_POSE || null });
  // Measured what a leaked page does: emitters 563 / liveParticles 197 against
  // 1893 / 5764 at the SAME pinned pose — an abort that manufactures the next
  // abort.
  if (!s.settled) await bail("not settled; abort", 4);

  // frame-time sampler (rAF deltas), same shape as the battery's __fr hook
  await page.evaluate(() => {
    window.__tf = { buf: [], last: -1 };
    const loop = (now) => {
      const f = window.__tf;
      if (f.last >= 0) { const dt = now - f.last; if (dt > 0 && dt < 60000) f.buf.push(dt); }
      f.last = now;
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
    // renderer.info is cumulative only if autoReset is off (it defaults TRUE and
    // zeroes per frame) — pin it so cumCalls is diffable.
    const r = window.liveScene3d?.renderer;
    if (r?.info) r.info.autoReset = false;
  });
  await sleep(2000);
  await page.evaluate(() => { window.__tf.buf.length = 0; const r = window.liveScene3d?.renderer; if (r?.info) { r.info.reset?.(); } });

  const SAMPLE_S = +(process.env.SAMPLE_S || 40);
  await sleep(SAMPLE_S * 1000);

  const r = await page.evaluate(() => {
    const dts = window.__tf.buf.slice().sort((a, b) => a - b);
    const n = dts.length;
    const pct = (q) => (n ? +dts[Math.min(n - 1, Math.floor(q * n))].toFixed(1) : null);
    const sum = dts.reduce((a, b) => a + b, 0);
    const ls = window.liveScene3d;
    const info = ls?.renderer?.info;
    const mgr = ls._staticParticleManager;
    const statics = ls.scene.getObjectByName("statics");
    let culledVisible = 0, drawableParticles = 0;
    for (const [, e] of mgr.particleTable) {
      if (e._rp6Culled !== true) continue;
      for (const m of (e.parts || [])) if (m && m.parent === statics && m.visible !== false) culledVisible++;
    }
    statics.traverse((o) => { if (o.isMesh && !o.isInstancedMesh && o.userData?.__particle && o.visible !== false) drawableParticles++; });
    return {
      frames: n, fps: sum ? +(n * 1000 / sum).toFixed(2) : null,
      p50: pct(0.5), p95: pct(0.95), max: n ? +dts[n - 1].toFixed(1) : null,
      cumCalls: info?.render?.calls ?? null, cumFrames: info?.render?.frame ?? null,
      emitters: mgr.particleTable.size, culledVisible, drawableParticles,
    };
  });
  const drawsPerFrame = (r.cumCalls != null && r.frames) ? +(r.cumCalls / r.frames).toFixed(1) : null;
  console.error(`[tf] ${process.env.LABEL || "arm"} @${process.env.POI || "Cragstone"} settled=${!!s.settled}`);
  console.error(`[tf]   fps=${r.fps} p50=${r.p50}ms p95=${r.p95}ms worst=${r.max}ms frames=${r.frames}`);
  console.error(`[tf]   draws/frame~=${drawsPerFrame}  emitters=${r.emitters}  culledVisible=${r.culledVisible}  drawableParticles=${r.drawableParticles}`);
  fs.writeFileSync(process.env.OUT || "/mnt/wbterminal2/tmp/townfps.json",
    JSON.stringify({ label: process.env.LABEL, poi: process.env.POI, settle: s, ...r, drawsPerFrame }, null, 2));
  await page.close();
  process.exit(0);
})();
