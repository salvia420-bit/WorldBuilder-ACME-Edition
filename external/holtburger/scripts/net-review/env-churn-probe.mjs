// env-churn-probe — does the SCENE swap something per frame that forces EVERY
// material to re-resolve its program?
//
// THE STATE OF THE SEARCH. `getParameters` is the #1 self-time item in the frame
// (10.2%, cpu-profile-probe) and has exactly ONE caller, `getProgram`
// (three.module.js:18098), which runs only when `needsProgramChange` (:18440).
// Two candidates are now DEAD, both by measurement:
//   (a) class thrash (batching/instancing flip):  B − P = 0.10ms  (material-declone-ab)
//   (b) per-frame material.version bump:          1.0 object/frame (version-churn-probe)
//       — and that one object is the known §5.1 residual double-submitted mesh,
//         written by three's own two-pass at :18068/:18072. Negligible.
//
// WHAT'S LEFT are the per-object conditions in setProgram's version-match branch:
//   :18364  } else if ( materialProperties.envMap !== envMap ) { needsProgramChange = true; }
//   :18366  } else if ( material.fog === true && materialProperties.fog !== fog ) { … }
//   …numClippingPlanes / vertexAlphas / vertexTangents / morph* / toneMapping /
//    lightProbeGrid / lights state version…
//
// ⭐ THE envMap ONE FITS EVERY FACT. getProgram does:
//     materialProperties.environment = scene.environment          (:18104)
//     materialProperties.envMap = environments.get( material.envMap || environment, … )
//   so if the atmosphere pipeline hands the scene a NEW environment texture each
//   frame (a dynamic PMREM sky), then `materialProperties.envMap !== envMap`
//   fires for EVERY material EVERY frame → getProgram → getParameters +
//   cache-key STRING BUILD, for every object drawn.
//   That predicts, without fitting: a cost that scales with OBJECT COUNT and not
//   with draws — which is exactly what was measured (?walkInInstance cut objects
//   and took getParameters 10.2% → 4.8%, while cutting TRUE draws 63% moved the
//   frame only 10.5%).
//
// This probe does not argue it. It samples, per rAF, the identity of everything
// in that condition list that the page can see — scene.environment, its
// rotation, fog, toneMapping, clipping — and counts CHANGES. A per-frame change
// in any of them is a whole-scene program re-resolve.
//
// If they are all stable, this is dead too and the remaining suspects are the
// per-OBJECT geometry-derived flags (vertexAlphas / vertexTangents / morph*),
// which vary by object, not by frame — instrument those next, do not guess.
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
    console.error(`[ec] ${msg}`);
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
  console.error(`[ec] GPU: ${gpu}`);
  if (!/GTX 1070/.test(gpu || "")) await bail(`not the 1070 GPU (${gpu})`, 5);

  const s = await settleAt(page, process.env.POI || "Holtburg",
    { log: (m) => console.error(`[ec] ${m}`), pinPose: process.env.PIN_POSE || null });
  if (!s.settled) await bail("not settled; abort", 4);

  await page.evaluate(() => {
    const ls = window.liveScene3d, r = ls.renderer, sc = ls.scene;
    const D = window.__ec = { raf: 0, counts: {}, samples: {}, last: {}, envUuids: new Set(), matEnvChanges: 0, matsSampled: 0 };
    const bump = (k, v) => {
      const prev = D.last[k];
      if (prev !== undefined && prev !== v) D.counts[k] = (D.counts[k] || 0) + 1;
      D.last[k] = v;
      D.samples[k] = v;
    };
    // a few materials to watch for per-frame envMap identity flips
    const watch = [];
    sc.traverse((o) => {
      if (watch.length >= 40) return;
      if (o.isMesh && o.visible !== false) {
        const m = Array.isArray(o.material) ? o.material[0] : o.material;
        if (m && !watch.includes(m)) watch.push(m);
      }
    });
    const lastEnv = new Map();
    const tick = () => {
      D.raf++;
      bump("scene.environment", sc.environment ? sc.environment.uuid : "null");
      if (sc.environment) D.envUuids.add(sc.environment.uuid);
      bump("scene.environmentIntensity", sc.environmentIntensity);
      bump("scene.environmentRotation", sc.environmentRotation ? `${sc.environmentRotation.x},${sc.environmentRotation.y},${sc.environmentRotation.z}` : "null");
      bump("scene.background", sc.background ? (sc.background.uuid || String(sc.background.getHex?.() ?? "bg")) : "null");
      bump("scene.fog", sc.fog ? `${sc.fog.constructor.name}:${sc.fog.near ?? ""},${sc.fog.far ?? ""},${sc.fog.density ?? ""},${sc.fog.color?.getHexString?.() ?? ""}` : "null");
      bump("renderer.toneMapping", r.toneMapping);
      bump("renderer.toneMappingExposure", r.toneMappingExposure);
      bump("renderer.clippingPlanes.n", (r.clippingPlanes || []).length);
      bump("renderer.outputColorSpace", r.outputColorSpace);
      // per-material envMap identity (the thing :18364 compares)
      for (const m of watch) {
        const cur = m.envMap ? m.envMap.uuid : (sc.environment ? sc.environment.uuid : "null");
        const prev = lastEnv.get(m);
        if (prev !== undefined && prev !== cur) D.matEnvChanges++;
        lastEnv.set(m, cur);
      }
      D.matsSampled = watch.length;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  await sleep(2000);
  await page.evaluate(() => { const D = window.__ec; D.counts = {}; D.raf = 0; D.matEnvChanges = 0; D.envUuids.clear(); });
  await sleep(+(process.env.ARM_S || 14) * 1000);
  const r = await page.evaluate(() => {
    const D = window.__ec;
    return { raf: D.raf, counts: D.counts, samples: D.samples, matEnvChanges: D.matEnvChanges, matsSampled: D.matsSampled, distinctEnvUuids: D.envUuids.size };
  });

  console.error(`[ec] ==========================================================`);
  console.error(`[ec] over ${r.raf} frames — CHANGES per key (a per-frame change = whole-scene program re-resolve):`);
  const keys = Object.keys(r.samples).sort();
  for (const k of keys) {
    const n = r.counts[k] || 0;
    const perF = (n / Math.max(1, r.raf));
    const flag = perF > 0.5 ? "  <-- ⭐ CHANGES EVERY FRAME" : n > 0 ? "  <- changes" : "";
    console.error(`[ec]   ${k.padEnd(30)} ${String(n).padStart(5)} changes (${perF.toFixed(2)}/frame)  now=${String(r.samples[k]).slice(0, 42)}${flag}`);
  }
  console.error(`[ec] distinct scene.environment textures seen: ${r.distinctEnvUuids}`);
  console.error(`[ec] watched materials: ${r.matsSampled}; their effective envMap identity changed ${r.matEnvChanges} times`);
  const churn = keys.filter((k) => (r.counts[k] || 0) / Math.max(1, r.raf) > 0.5);
  if (churn.length === 0 && r.matEnvChanges === 0) {
    console.error(`[ec] => NOTHING SCENE-WIDE CHURNS. This hypothesis is DEAD too.`);
    console.error(`[ec]    Remaining suspects are per-OBJECT geometry-derived flags (vertexAlphas /`);
    console.error(`[ec]    vertexTangents / morph*), which differ BETWEEN objects sharing a material`);
    console.error(`[ec]    rather than between frames. Instrument those; do not guess.`);
  }

  fs.writeFileSync(process.env.OUT || "/mnt/wbterminal2/tmp/env-churn.json",
    JSON.stringify({ poi: process.env.POI || "Holtburg", gpu, settle: s, ...r }, null, 2));
  await page.close();
  process.exit(0);
})();
