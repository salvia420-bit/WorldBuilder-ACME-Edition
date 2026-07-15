// forcesinglepass-ab — the CAUSE of k=2, the SIZE of the fix, and whether the
// fix is pixel-identical.
//
// THE FINDING THIS TESTS. particle-k-probe measured k=2.01/1.99 (one page load,
// A/B/A, 0.1% drift): every visible particle costs TWO draw calls.
// particle-pass-attrib then localized it — NOT to a second pass. The main scene
// pass (the ONLY per-frame world render; composer=[] , shadowMap=false) loses
// 428 draws for 228 particles inside ONE render() call. three r184
// (three.module.js:18065, renderObject) submits a material TWICE — BackSide then
// FrontSide, with a `needsUpdate = true` program re-resolve between them — when
//     material.transparent === true && material.side === DoubleSide && material.forceSinglePass === false
// Particle materials are transparent (particle_manager.js:39) and DoubleSide
// (materials.js), and `forceSinglePass` appears NOWHERE in this repo, so it is
// false everywhere. k=2 is not a mystery pass; it is this three.js branch.
//
// WHY forceSinglePass IS SAFE FOR A FLAT QUAD (the thing to verify, not assume).
// The two-pass exists to order back faces before front faces WITHIN one
// transparent mesh. A billboard particle is a FLAT quad: it has no back-vs-front
// overlap, and at any camera angle one of the two passes is entirely
// face-culled — it submits a draw call that produces no fragments. So the second
// pass is pure waste and forceSinglePass=true should be pixel-identical. For a
// CLOSED transparent mesh it would NOT be. Hence the arms below are split
// (particles only vs scene-wide) and hence the frozen-scene pixel check.
//
// ARMS (all within ONE page load — no settle.mjs confound can reach them):
//   A  baseline · B  forceSinglePass on PARTICLE materials · C  scene-wide
//   A2 restored (drift = the error bar)
// then a FROZEN-scene pixel parity check: stub the particle sim so nothing
// moves, screenshot with and without the fix, compare. Particles are RNG/time
// driven, so freezing is what makes a screenshot diff mean anything at all.
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
  const bail = async (msg, code) => { // §2 rule 7
    console.error(`[fsp] ${msg}`);
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
  console.error(`[fsp] GPU: ${gpu}`);
  if (!/GTX 1070/.test(gpu || "")) await bail(`not the 1070 GPU (${gpu})`, 5);

  const s = await settleAt(page, process.env.POI || "Holtburg",
    { log: (m) => console.error(`[fsp] ${m}`), pinPose: process.env.PIN_POSE || null });
  if (!s.settled) await bail("not settled; abort", 4);

  await page.evaluate(() => {
    const ls = window.liveScene3d, r = ls.renderer;
    if (r?.info) r.info.autoReset = false;
    const F = window.__fsp = { raf: 0, buf: [], last: -1, touched: new Set() };
    F.isParticle = (o) => o && o.isMesh && !o.isInstancedMesh && o.userData && o.userData.__particle === true;
    const loop = (now) => {
      F.raf++;
      if (F.last >= 0) { const dt = now - F.last; if (dt > 0 && dt < 60000) F.buf.push(dt); }
      F.last = now;
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
    F.mats = (which) => {
      const out = [];
      ls.scene.traverse((o) => {
        if (!o.isMesh || o.visible === false) return;
        if (which === "particles" && !F.isParticle(o)) return;
        const ms = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of ms) if (m) out.push(m);
      });
      return out;
    };
    // Flip forceSinglePass; needsUpdate is REQUIRED or the program is not
    // re-resolved and the arm silently measures the old path.
    F.apply = (which, val) => {
      let n = 0;
      for (const m of F.mats(which)) {
        if (m.transparent === true && m.side === THREE_DOUBLE && m.forceSinglePass !== val) {
          m.forceSinglePass = val; m.needsUpdate = true; F.touched.add(m); n++;
        }
      }
      return n;
    };
    F.restore = () => { let n = 0; for (const m of F.touched) { if (m.forceSinglePass !== false) { m.forceSinglePass = false; m.needsUpdate = true; n++; } } F.touched.clear(); return n; };
    F.mark = () => ({ raf: F.raf, calls: r.info.render.calls, tris: r.info.render.triangles });
    // THREE.DoubleSide === 2; read it off a real material rather than importing.
    window.THREE_DOUBLE = 2;
  });

  // Census: what the fix could possibly touch, and is a particle a flat quad?
  const census = await page.evaluate(() => {
    const ls = window.liveScene3d, F = window.__fsp;
    const seen = new Set();
    let partMeshes = 0, partDblTrans = 0, otherMeshes = 0, otherDblTrans = 0;
    const vertHist = {};
    ls.scene.traverse((o) => {
      if (!o.isMesh || o.visible === false) return;
      const isP = F.isParticle(o);
      const ms = Array.isArray(o.material) ? o.material : [o.material];
      const dbl = ms.some((m) => m && m.transparent === true && m.side === 2);
      if (isP) {
        partMeshes++; if (dbl) partDblTrans++;
        const v = o.geometry?.attributes?.position?.count ?? -1;
        vertHist[v] = (vertHist[v] || 0) + 1;
      } else {
        otherMeshes++; if (dbl) otherDblTrans++;
        for (const m of ms) if (m && m.transparent === true && m.side === 2) seen.add(m.name || m.type);
      }
    });
    return { partMeshes, partDblTrans, otherMeshes, otherDblTrans, particleVertexHistogram: vertHist,
      nonParticleDoubleTransMaterialNames: [...seen].slice(0, 25) };
  });
  console.error(`[fsp] census: particles ${census.partDblTrans}/${census.partMeshes} are transparent+DoubleSide; ` +
    `non-particle ${census.otherDblTrans}/${census.otherMeshes}`);
  console.error(`[fsp] particle geometry vertex histogram: ${JSON.stringify(census.particleVertexHistogram)}`);

  const ARM_S = +(process.env.ARM_S || 20);
  const arm = async (label, which, val) => {
    const n = await page.evaluate(([w, v]) => (v === null ? window.__fsp.restore() : window.__fsp.apply(w, v)), [which, val]);
    await sleep(2000); // let recompiles land before the window opens
    const a = await page.evaluate(() => { window.__fsp.buf.length = 0; return window.__fsp.mark(); });
    await sleep(ARM_S * 1000);
    const b = await page.evaluate(() => {
      const F = window.__fsp, m = F.mark();
      const dts = F.buf.slice().sort((x, y) => x - y);
      const sum = dts.reduce((x, y) => x + y, 0);
      let parts = 0;
      window.liveScene3d.scene.traverse((o) => { if (F.isParticle(o) && o.visible !== false) parts++; });
      return { ...m, parts, fps: sum ? +(dts.length * 1000 / sum).toFixed(2) : null,
        p50: dts.length ? +dts[Math.floor(dts.length / 2)].toFixed(1) : null,
        p95: dts.length ? +dts[Math.floor(dts.length * 0.95)].toFixed(1) : null };
    });
    const dRaf = b.raf - a.raf;
    const out = { label, materialsFlipped: n, rafFrames: dRaf,
      drawsPerFrame: +((b.calls - a.calls) / dRaf).toFixed(1),
      trisPerFrame: Math.round((b.tris - a.tris) / dRaf),
      parts: b.parts, fps: b.fps, p50: b.p50, p95: b.p95 };
    console.error(`[fsp] ${label.padEnd(16)} mats=${String(n).padStart(4)}  draws/f=${String(out.drawsPerFrame).padStart(7)}  parts=${String(out.parts).padStart(4)}  fps=${String(out.fps).padStart(6)}  p50=${out.p50}ms  p95=${out.p95}ms`);
    return out;
  };

  const A = await arm("A-baseline", null, null);
  const B = await arm("B-particles-fsp", "particles", true);
  await arm("restore-1", null, null);
  const C = await arm("C-scenewide-fsp", "all", true);
  const A2 = await arm("A2-restored", null, null);

  // ---- frozen-scene pixel parity -------------------------------------------
  // Freeze the particle sim so the ONLY difference between the two shots is the
  // render path. Without this, particles move between shots and a pixel diff is
  // meaningless.
  console.error(`[fsp] --- frozen-scene pixel parity (particles only) ---`);
  await page.evaluate(() => {
    const mgr = window.liveScene3d._staticParticleManager;
    window.__fspTick = mgr.tick.bind(mgr);
    mgr.tick = () => {}; // freeze: no emission, no motion, no visibility writes
  });
  await sleep(1500);
  const shotA = await page.screenshot({ type: "png" });
  const flipped = await page.evaluate(() => window.__fsp.apply("particles", true));
  await sleep(1500);
  const shotB = await page.screenshot({ type: "png" });
  await page.evaluate(() => { window.__fsp.restore(); const m = window.liveScene3d._staticParticleManager; if (window.__fspTick) m.tick = window.__fspTick; });

  const dir = process.env.SHOT_DIR || "/mnt/wbterminal2/tmp";
  fs.writeFileSync(`${dir}/fsp-frozen-A-doubleside.png`, shotA);
  fs.writeFileSync(`${dir}/fsp-frozen-B-singlepass.png`, shotB);
  console.error(`[fsp] frozen shots: ${dir}/fsp-frozen-{A-doubleside,B-singlepass}.png (mats flipped: ${flipped})`);
  console.error(`[fsp] identical bytes: ${Buffer.compare(shotA, shotB) === 0}`);

  const gain = (x) => ({ dDraws: +(x.drawsPerFrame - A.drawsPerFrame).toFixed(1), dFps: +((x.fps - A.fps)).toFixed(2),
    pctDraws: +(100 * (x.drawsPerFrame - A.drawsPerFrame) / A.drawsPerFrame).toFixed(1),
    pctFps: +(100 * (x.fps - A.fps) / A.fps).toFixed(1) });
  const gB = gain(B), gC = gain(C), gA2 = gain(A2);
  console.error(`[fsp] ==========================================================`);
  console.error(`[fsp] B particles-only : draws ${gB.dDraws} (${gB.pctDraws}%)  fps ${gB.dFps} (${gB.pctFps}%)`);
  console.error(`[fsp] C scene-wide     : draws ${gC.dDraws} (${gC.pctDraws}%)  fps ${gC.dFps} (${gC.pctFps}%)`);
  console.error(`[fsp] A2 drift (should be ~0): draws ${gA2.dDraws}  fps ${gA2.dFps}  <- the error bar`);

  fs.writeFileSync(process.env.OUT || "/mnt/wbterminal2/tmp/fsp-ab.json",
    JSON.stringify({ poi: process.env.POI || "Holtburg", gpu, settle: s, census,
      arms: { A, B, C, A2 }, gains: { B: gB, C: gC, A2drift: gA2 },
      frozenShotsIdentical: Buffer.compare(shotA, shotB) === 0 }, null, 2));
  await page.close();
  process.exit(0);
})();
