// particle-k-probe — SETTLE the ⭐ open lead: is every visible particle
// submitted ONCE or TWICE per frame?
//
// WHY THIS EXISTS. HANDOFF-perf-particles-second-pass-2026-07-15 §3 fits three
// cross-page-load legs to `draws = k*particles + nonParticle` and gets k≈2.01,
// which would mean a whole second pass is re-submitting every particle. But
// three points against one free parameter is weak, and the k=1 arm's residual
// (~169 draws) is exactly the size of the thing being inferred. This probe
// measures k DIRECTLY, in ONE page load, so none of settle.mjs's four confounds
// (ramp, history bleed, pose, stochastic plateau) can reach it: the two arms are
// the SAME scene, seconds apart, with the same emitters and the same camera.
//
// METHOD. Settle at a pinned pose → sample draws/frame → force every particle
// mesh invisible IN-PAGE → re-sample → restore and re-sample (A/B/A, so drift
// is visible rather than assumed). k = Δdraws / Δparticles.
//
// HOW WE HIDE, and why not the obvious way. A plain `mesh.visible = false` is
// undone on the next tick by particle.js setTranslucency (:110 sets
// `visible = true` whenever translucency < 1) for every UN-culled emitter — the
// exact writer-race that caused the bug this probe follows up on. The handoff
// suggests stubbing ParticleManager.tick for the sample window; this instead
// redefines `visible` as an accessor that returns false and SWALLOWS writes.
// Two reasons: (1) it defeats EVERY writer, including ones we have not audited
// and any manager other than _staticParticleManager, so the arm cannot be
// silently voided by a resurrection we did not predict; (2) tick() keeps
// running, so the CPU work is IDENTICAL across arms and the delta is purely GPU
// submission — which is what k is about. Stubbing tick would also have removed
// the per-particle CPU walk, confounding frame time with draw count.
//
// SYMMETRY. The census/pin sweep runs at the SAME cadence in EVERY arm
// (including the ones where it pins nothing), so its cost cannot masquerade as
// the effect. New meshes born mid-arm are pinned by the same sweep.
//
// TOPOLOGY. Also snapshots the things that would EXPLAIN k>1 — composer passes,
// shadowMap/CSM cascades, and a castShadow census over the particle meshes —
// because "k≈2" with no named second pass is a number, not a finding.
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

  // §2 rule 7: EVERY bail closes the page. tailnet1 is single-login; a leaked
  // page stays logged in and the next run boots into a starved world (563
  // emitters vs 1893 at the same pose) or is rejected as __bootState==='error'
  // — an abort that manufactures the next abort.
  const bail = async (msg, code) => {
    console.error(`[k] ${msg}`);
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

  const gpu = await page.evaluate(() => {
    try {
      const c = document.createElement("canvas");
      const gl = c.getContext("webgl2") || c.getContext("webgl");
      const dbg = gl.getExtension("WEBGL_debug_renderer_info");
      return gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL);
    } catch (e) { return `err:${e.message}`; }
  }).catch(() => null);
  console.error(`[k] GPU: ${gpu}`);
  if (!/GTX 1070/.test(gpu || "")) await bail(`not the 1070 GPU (${gpu}) — refusing to publish draw numbers`, 5);

  const s = await settleAt(page, process.env.POI || "Holtburg",
    { log: (m) => console.error(`[k] ${m}`), pinPose: process.env.PIN_POSE || null });
  if (!s.settled) await bail("not settled; abort", 4);

  // ---- install the in-page harness -----------------------------------------
  await page.evaluate(() => {
    const ls = window.liveScene3d;
    const r = ls.renderer;
    if (r?.info) r.info.autoReset = false; // defaults TRUE and zeroes per frame

    const K = window.__k = {
      raf: 0, pinned: new Set(), pinning: false,
      partSamples: [], // drawable particle count, sampled by the sweep
    };

    // A particle mesh: stamped __particle, a real (non-instanced) mesh.
    K.isParticle = (o) => o && o.isMesh && !o.isInstancedMesh && o.userData && o.userData.__particle === true;

    // The sweep: census + (when pinning) pin any not-yet-pinned particle mesh.
    // Runs at the same cadence in EVERY arm so its cost is common-mode.
    K.sweep = () => {
      let drawable = 0, total = 0;
      ls.scene.traverse((o) => {
        if (!K.isParticle(o)) return;
        total++;
        if (o.visible !== false) drawable++;
        if (K.pinning && !K.pinned.has(o)) K.pin(o);
      });
      K.partSamples.push(drawable);
      K.lastTotal = total;
      return drawable;
    };

    // Redefine `visible` as an accessor that reads false and swallows writes.
    // Defeats every writer (setTranslucency, RP6, any unaudited one) without
    // changing the CPU work any of them do.
    K.pin = (o) => {
      const own = Object.getOwnPropertyDescriptor(o, "visible");
      // Stash whatever was there so restore is exact, not assumed.
      K.pinned.add(o);
      o.__kPrev = own && "value" in own ? own.value : true;
      try {
        Object.defineProperty(o, "visible", {
          configurable: true, enumerable: true,
          get() { return false; },
          set(_v) { /* swallowed: this is the arm */ },
        });
      } catch (_) { K.pinned.delete(o); }
    };
    K.unpinAll = () => {
      for (const o of K.pinned) {
        try {
          delete o.visible; // drop the accessor
          Object.defineProperty(o, "visible", {
            configurable: true, enumerable: true, writable: true, value: o.__kPrev !== false,
          });
          delete o.__kPrev;
        } catch (_) {}
      }
      K.pinned.clear();
    };

    // rAF counter + frame-time buffer (same shape as town-fps-probe's __tf).
    K.buf = []; K.last = -1;
    const loop = (now) => {
      K.raf++;
      if (K.last >= 0) { const dt = now - K.last; if (dt > 0 && dt < 60000) K.buf.push(dt); }
      K.last = now;
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
    setInterval(K.sweep, 500); // the symmetric sweep

    // Mark an arm boundary: snapshot the cumulative counters.
    K.mark = () => {
      const i = ls.renderer.info;
      return { raf: K.raf, calls: i.render.calls, tris: i.render.triangles, renders: i.render.frame, t: performance.now() };
    };
  });

  // ---- topology: the things that would EXPLAIN k>1 --------------------------
  const topo = await page.evaluate(() => {
    const ls = window.liveScene3d, r = ls.renderer, K = window.__k;
    let cast = 0, noCast = 0, particles = 0;
    ls.scene.traverse((o) => { if (K.isParticle(o)) { particles++; o.castShadow ? cast++ : noCast++; } });
    const passes = (ls.composer?.passes || []).map((p) => ({
      name: p.constructor?.name, enabled: p.enabled !== false, renderToScreen: !!p.renderToScreen,
    }));
    return {
      particles, particlesCastShadow: cast, particlesNoCastShadow: noCast,
      shadowMapEnabled: !!r?.shadowMap?.enabled,
      csmCascades: ls.csm?.cascades ?? ls.csm?.lights?.length ?? null,
      composerPasses: passes,
      autoClear: r?.autoClear, xrEnabled: !!r?.xr?.enabled,
    };
  });
  console.error(`[k] topology: ${JSON.stringify(topo)}`);

  const ARM_S = +(process.env.ARM_S || 20);
  const arm = async (label, pinning) => {
    await page.evaluate((p) => { window.__k.pinning = p; if (p) window.__k.sweep(); else window.__k.unpinAll(); }, pinning);
    await sleep(1500); // let the arm's state take hold before the window opens
    const a = await page.evaluate(() => { window.__k.partSamples.length = 0; window.__k.buf.length = 0; return window.__k.mark(); });
    await sleep(ARM_S * 1000);
    const b = await page.evaluate(() => {
      const K = window.__k, m = K.mark();
      const ps = K.partSamples.slice();
      const dts = K.buf.slice().sort((x, y) => x - y);
      const sum = dts.reduce((x, y) => x + y, 0);
      return {
        ...m,
        parts: ps.length ? +(ps.reduce((x, y) => x + y, 0) / ps.length).toFixed(1) : null,
        partsMin: ps.length ? Math.min(...ps) : null, partsMax: ps.length ? Math.max(...ps) : null,
        totalParticleMeshes: K.lastTotal,
        fps: sum ? +(dts.length * 1000 / sum).toFixed(2) : null,
        p50: dts.length ? +dts[Math.floor(dts.length / 2)].toFixed(1) : null,
      };
    });
    const dRaf = b.raf - a.raf;
    const out = {
      label, pinning, rafFrames: dRaf,
      drawsPerFrame: +((b.calls - a.calls) / dRaf).toFixed(1),
      trisPerFrame: Math.round((b.tris - a.tris) / dRaf),
      // renderer.info.render.frame counts renderer.render() CALLS and is NOT
      // reset by info.reset() — cumulative since page load. >1 per rAF means
      // more than one render() per frame, which is the direct form of the
      // question k is asking sideways.
      rendersPerRaf: +((b.renders - a.renders) / dRaf).toFixed(2),
      parts: b.parts, partsMin: b.partsMin, partsMax: b.partsMax,
      totalParticleMeshes: b.totalParticleMeshes, fps: b.fps, p50: b.p50,
    };
    console.error(`[k] ${label.padEnd(12)} draws/f=${String(out.drawsPerFrame).padStart(7)}  parts=${String(out.parts).padStart(6)} (${out.partsMin}..${out.partsMax})  renders/rAF=${out.rendersPerRaf}  fps=${out.fps}  p50=${out.p50}ms`);
    return out;
  };

  const A = await arm("A-baseline", false);
  const B = await arm("B-hidden", true);
  const A2 = await arm("A2-restored", false);

  // k from each A-vs-B pair. Report BOTH; if they disagree the scene drifted and
  // no single k is quotable.
  const kOf = (x, y) => (x.parts - y.parts) !== 0
    ? +((x.drawsPerFrame - y.drawsPerFrame) / (x.parts - y.parts)).toFixed(2) : null;
  const k1 = kOf(A, B), k2 = kOf(A2, B);
  const driftDraws = A2.drawsPerFrame - A.drawsPerFrame;
  const driftParts = +(A2.parts - A.parts).toFixed(1);

  console.error(`[k] ----------------------------------------------------------`);
  console.error(`[k] k(A vs B)  = ${k1}   k(A2 vs B) = ${k2}`);
  console.error(`[k] A/A2 drift: draws ${driftDraws.toFixed(1)}  parts ${driftParts}  (drift is the error bar on k)`);
  console.error(`[k] nonParticle draws implied: A ${(A.drawsPerFrame - k1 * A.parts).toFixed(1)}  B ${B.drawsPerFrame.toFixed(1)} (B is the direct floor)`);

  fs.writeFileSync(process.env.OUT || "/mnt/wbterminal2/tmp/particle-k.json",
    JSON.stringify({
      label: process.env.LABEL || null, poi: process.env.POI || "Holtburg",
      pinPose: process.env.PIN_POSE || null, extraQ: process.env.EXTRA_Q || null,
      gpu, settle: s, topology: topo, arms: { A, B, A2 },
      k: { aVsB: k1, a2VsB: k2 }, drift: { draws: driftDraws, parts: driftParts },
    }, null, 2));
  await page.close();
  process.exit(0);
})();
