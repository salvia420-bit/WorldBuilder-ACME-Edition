// forcesinglepass-parity — is forceSinglePass=true PIXEL-IDENTICAL?
//
// THE PROBLEM WITH THE OBVIOUS TEST. Screenshot with the fix off, flip it,
// screenshot again, diff. That is what forcesinglepass-ab.mjs does and its
// answer is unusable: 16.3% of pixels differ — but the world ANIMATES between
// the two shots (entities, sky, clock-driven uniforms), so the diff is
// dominated by time passing, not by the render path. Freezing the particle sim
// is not enough; everything else still moves. A test whose noise floor is
// unknown and probably larger than its signal cannot answer anything.
//
// THE TEST THAT WORKS. Render the SAME scene TWICE inside ONE synchronous
// moment — no rAF, no tick, no clock advance between them:
//     render(scene) -> readRenderTargetPixels -> bufA
//     flip forceSinglePass (+needsUpdate)
//     render(scene) -> readRenderTargetPixels -> bufB
// Scene state is byte-identical by CONSTRUCTION, because no time passed. Every
// differing pixel is therefore caused by the render path and nothing else.
// A CONTROL pair (render twice with NO flip between) establishes the true noise
// floor — it should be exactly 0 differing pixels, and if it is not, the whole
// instrument is void and says so rather than quietly reporting a small number.
//
// This renders the scene directly rather than through the composer: it isolates
// the scene-submission path, which is the only thing forceSinglePass changes.
//
// PREDICTION UNDER TEST. Particle meshes are 6-vertex FLAT QUADS (census:
// 222/222, all transparent+DoubleSide). For a flat quad the two-pass
// (BackSide-then-FrontSide) and the single DoubleSide pass emit the SAME
// fragments — at any angle one of the two passes is fully face-culled, so the
// second draw call produces nothing. Prediction: particles-only diff == 0
// pixels, exactly. Scene-wide (451 non-particle transparent DoubleSide meshes,
// some of them CLOSED geometry where back-then-front ordering is real) is NOT
// predicted safe — that is the point of measuring them separately.
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
    console.error(`[par] ${msg}`);
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
  console.error(`[par] GPU: ${gpu}`);
  if (!/GTX 1070/.test(gpu || "")) await bail(`not the 1070 GPU (${gpu})`, 5);

  const s = await settleAt(page, process.env.POI || "Holtburg",
    { log: (m) => console.error(`[par] ${m}`), pinPose: process.env.PIN_POSE || null });
  if (!s.settled) await bail("not settled; abort", 4);

  const result = await page.evaluate(async () => {
    const ls = window.liveScene3d, r = ls.renderer;
    // three is not exposed as a global; import the SAME specifier the app's
    // importmap pins (index.html:951). It is already in the module registry, so
    // this returns the identical instance — importing three twice would give a
    // second copy whose classes fail every instanceof inside the renderer.
    const THREE = await import("https://cdn.jsdelivr.net/npm/three@0.184.0/build/three.module.js");
    const scene = ls.scene;
    const camera = ls.cameraSwitcher?.activeCamera ?? ls.camera;
    if (!THREE?.WebGLRenderTarget || !camera) return { error: `no THREE(${!!THREE?.WebGLRenderTarget})/camera(${!!camera}) handle` };

    const size = r.getDrawingBufferSize(new THREE.Vector2());
    const W = Math.min(size.x, 1280) | 0, H = Math.min(size.y, 720) | 0;
    const rt = new THREE.WebGLRenderTarget(W, H, { depthBuffer: true, stencilBuffer: false });
    const isParticle = (o) => o && o.isMesh && !o.isInstancedMesh && o.userData && o.userData.__particle === true;

    const matsOf = (which) => {
      const out = [];
      scene.traverse((o) => {
        if (!o.isMesh || o.visible === false) return;
        if (which === "particles" && !isParticle(o)) return;
        if (which === "nonparticles" && isParticle(o)) return;
        const ms = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of ms) if (m && m.transparent === true && m.side === 2) out.push(m);
      });
      return out;
    };
    const flip = (mats, v) => { let n = 0; for (const m of mats) { if (m.forceSinglePass !== v) { m.forceSinglePass = v; m.needsUpdate = true; n++; } } return n; };

    // One synchronous grab: render into rt, read it back. No await, no rAF, no
    // tick — the scene cannot change between two consecutive calls.
    const grab = () => {
      const prev = r.getRenderTarget();
      r.setRenderTarget(rt);
      r.clear();
      r.render(scene, camera);
      const buf = new Uint8Array(W * H * 4);
      r.readRenderTargetPixels(rt, 0, 0, W, H, buf);
      r.setRenderTarget(prev);
      return buf;
    };
    const diff = (a, b) => {
      let n = 0, n8 = 0, max = 0, sum = 0;
      for (let i = 0; i < a.length; i += 4) {
        const d = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]));
        if (d > 0) n++;
        if (d > 8) n8++;
        if (d > max) max = d;
        sum += d;
      }
      const px = a.length / 4;
      return { pixels: px, differing: n, differingPct: +(100 * n / px).toFixed(4), differingGt8: n8, maxDelta: max, meanDelta: +(sum / px).toFixed(4) };
    };

    const out = { W, H };
    const pMats = matsOf("particles");
    out.particleMatCount = pMats.length;

    // WARMUP. The FIRST render into a fresh target is not comparable to the
    // steady state: measured, grab#1 vs grab#2 differ on 6.0% of pixels
    // (max delta 22, mean 1.3) with NOTHING changed between them, while every
    // later pair is exactly 0 — the atmosphere/temporal state converges on the
    // first render. Discard it rather than let it masquerade as a noise floor
    // (a first cut of this probe declared itself VOID on exactly that).
    grab();

    // CONTROL: two renders, nothing changed between them. MUST be 0 differing.
    // If it is not, this instrument cannot resolve anything and every number
    // below is void — report it instead of quietly shipping a small diff.
    const c1 = grab(), c2 = grab();
    out.control = diff(c1, c2);

    // ARM 1 — particles only.
    flip(pMats, true);
    const p1 = grab();
    out.particlesOnly = diff(c2, p1);
    flip(pMats, false);
    const p2 = grab();
    out.particlesRestored = diff(c2, p2); // restoring must return to baseline

    // ARM 2 — scene-wide (particles + the 451 non-particle transparent
    // DoubleSide meshes, which are NOT predicted safe).
    const allMats = matsOf("all");
    out.allMatCount = allMats.length;
    flip(allMats, true);
    const a1 = grab();
    out.sceneWide = diff(c2, a1);
    flip(allMats, false);
    const a2 = grab();
    out.sceneWideRestored = diff(c2, a2);

    // ARM 3 — non-particles only, to attribute any scene-wide damage.
    const npMats = matsOf("nonparticles");
    out.nonParticleMatCount = npMats.length;
    flip(npMats, true);
    const n1 = grab();
    out.nonParticlesOnly = diff(c2, n1);
    flip(npMats, false);

    // TRAILING CONTROL: everything restored, one more render. Must still match
    // c2 exactly — proves determinism held for the WHOLE sequence, not just at
    // the start, so no arm's number can be drift that accumulated on the way.
    out.controlEnd = diff(c2, grab());

    rt.dispose();
    return out;
  });

  if (result.error) await bail(`in-page: ${result.error}`, 6);

  const line = (k, d) => console.error(`[par] ${k.padEnd(20)} differing ${String(d.differing).padStart(8)} px (${String(d.differingPct).padStart(8)}%)  >8: ${String(d.differingGt8).padStart(7)}  max ${String(d.maxDelta).padStart(3)}  mean ${d.meanDelta}`);
  console.error(`[par] buffer ${result.W}x${result.H}; particle mats ${result.particleMatCount}, non-particle ${result.nonParticleMatCount}, all ${result.allMatCount}`);
  line("CONTROL (must be 0)", result.control);
  line("particles only", result.particlesOnly);
  line("particles restored", result.particlesRestored);
  line("scene-wide", result.sceneWide);
  line("scene-wide restored", result.sceneWideRestored);
  line("non-particles only", result.nonParticlesOnly);
  line("CONTROL end (must be 0)", result.controlEnd);

  const controlClean = result.control.differing === 0 && result.controlEnd.differing === 0;
  console.error(`[par] ==========================================================`);
  if (!controlClean) {
    console.error(`[par] VOID: the control pair differs (${result.control.differing} px) — two identical renders`);
    console.error(`[par]       did not agree, so this instrument cannot resolve the arms. Do not quote.`);
  } else {
    console.error(`[par] control is EXACTLY 0 -> the instrument resolves a single pixel.`);
    console.error(`[par] particles-only  : ${result.particlesOnly.differing === 0 ? "PIXEL-IDENTICAL (prediction held)" : `${result.particlesOnly.differing} px DIFFER — prediction FAILED`}`);
    console.error(`[par] scene-wide      : ${result.sceneWide.differing === 0 ? "pixel-identical" : `${result.sceneWide.differing} px differ (${result.sceneWide.differingPct}%) — NOT safe to flip blind`}`);
  }

  fs.writeFileSync(process.env.OUT || "/mnt/wbterminal2/tmp/fsp-parity.json",
    JSON.stringify({ poi: process.env.POI || "Holtburg", gpu, settle: s, controlClean, ...result }, null, 2));
  await page.close();
  process.exit(0);
})();
