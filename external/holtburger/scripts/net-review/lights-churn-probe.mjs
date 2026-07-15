// lights-churn-probe — does the LIGHT COUNT change per frame, forcing EVERY lit
// material to re-resolve its program?
//
// ⭐ THIS IS THE FIRST CONDITION IN setProgram, AND I MISSED IT TWICE — I read the
// branch starting from its MIDDLE and wrote two probes against the conditions I
// happened to see:
//   three.module.js:18321  if ( materialProperties.needsLights &&
//                               materialProperties.lightsStateVersion !== lights.state.version )
//                            needsProgramChange = true;      <-- FIRST condition
// and three bumps that version ONLY when a light COUNT changes:
//   :8792-8801  if ( hash.directionalLength !== directionalLength || pointLength || spotLength ||
//                    hemiLength || numDirectionalShadows || numPointShadows || numSpotShadows || … )
//   :8835         state.version = nextVersion ++;
// So ONE light appearing or disappearing in a frame re-resolves the program of
// EVERY lit material in the scene — every MeshStandardMaterial here. That cost
// scales with OBJECT COUNT and is invisible to draw counts, which is exactly the
// shape of every measurement in this chain (?walkInInstance cut objects and took
// getParameters 10.2% -> 4.8%; cutting TRUE draws 63% moved the frame 10.5%).
//
// MEMORY.md already warns "never change light count (relink freeze)" and the app
// runs a dynamic per-frame light system (lighting.js recordStatics, 1.4% self in
// the profile), so a churning count is plausible here rather than exotic.
//
// DEAD SO FAR (all by measurement, none by argument):
//   class thrash (batching/instancing flip)  B − P = 0.10ms   material-declone-ab
//   per-frame material.version bump          1.0 obj/frame    version-churn-probe
//   scene-wide env/fog/toneMapping/clipping  0 changes/339f   env-churn-probe
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

// ⚠ CRASH PATH: an uncaught throw in an earlier version left the page OPEN, which
// kept tailnet1 logged in and failed the NEXT TWO runs with "boot error (account
// still held?)" — a self-inflicted version of the §8 login confound. Any exit
// path must close the page. Orphans are recoverable with
// `curl http://127.0.0.1:9333/json/list` + `/json/close/<id>`.
let __page = null;
process.on("unhandledRejection", async (e) => {
  console.error(`[ec] CRASH: ${e && e.message}`);
  try { await __page?.close(); } catch (_) {}
  process.exit(1);
});
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
  __page = page;

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
    const ls = window.liveScene3d, sc = ls.scene;
    const D = window.__ec = { raf: 0, counts: {}, samples: {}, last: {}, seen: new Set(), matEnvChanges: 0, matsSampled: 0, distinctEnvUuids: 0 };
    const bump = (k, v) => {
      const prev = D.last[k];
      if (prev !== undefined && prev !== v) D.counts[k] = (D.counts[k] || 0) + 1;
      D.last[k] = v;
      D.samples[k] = v;
    };
    // three bumps lights.state.version ONLY when one of these COUNTS changes
    // (three.module.js:8792-8801 hash compare -> :8835 `state.version = nextVersion++`).
    // A bump makes EVERY material with needsLights re-resolve its program that
    // frame (:18321 is the FIRST needsProgramChange condition).
    const tick = () => {
      D.raf++;
      let dir = 0, point = 0, spot = 0, hemi = 0, rect = 0, probe = 0;
      let dShadow = 0, pShadow = 0, sShadow = 0;
      sc.traverse((o) => {
        if (!o.isLight || o.visible === false) return;
        if (o.isDirectionalLight) { dir++; if (o.castShadow) dShadow++; }
        else if (o.isPointLight) { point++; if (o.castShadow) pShadow++; }
        else if (o.isSpotLight) { spot++; if (o.castShadow) sShadow++; }
        else if (o.isHemisphereLight) hemi++;
        else if (o.isRectAreaLight) rect++;
        else if (o.isLightProbe) probe++;
      });
      bump("directionalLength", dir);
      bump("pointLength", point);
      bump("spotLength", spot);
      bump("hemiLength", hemi);
      bump("rectAreaLength", rect);
      bump("numLightProbes", probe);
      bump("numDirectionalShadows", dShadow);
      bump("numPointShadows", pShadow);
      bump("numSpotShadows", sShadow);
      const sig = `${dir}/${point}/${spot}/${hemi}/${rect}/${probe}/${dShadow}/${pShadow}/${sShadow}`;
      bump("LIGHT-COUNT SIGNATURE", sig);
      D.seen.add(sig);
      D.distinctEnvUuids = D.seen.size;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  await sleep(2000);
  await page.evaluate(() => { const D = window.__ec; D.counts = {}; D.raf = 0; D.matEnvChanges = 0; D.seen.clear(); D.last = {}; });
  await sleep(+(process.env.ARM_S || 14) * 1000);
  const r = await page.evaluate(() => {
    const D = window.__ec;
    return { raf: D.raf, counts: D.counts, samples: D.samples, matEnvChanges: D.matEnvChanges, matsSampled: D.matsSampled, distinctEnvUuids: D.seen.size, signatures: [...D.seen] };
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
  console.error(`[ec] distinct light-count signatures seen: ${r.distinctEnvUuids}  ${JSON.stringify((r.signatures || []).slice(0, 8))}`);
  console.error(`[ec]   (signature = dir/point/spot/hemi/rect/probe/dShadow/pShadow/sShadow)`);
  const churn = keys.filter((k) => (r.counts[k] || 0) / Math.max(1, r.raf) > 0.5);
  if (churn.length === 0) {
    console.error(`[ec] => LIGHT COUNTS ARE STABLE. This hypothesis is DEAD too, and with it every`);
    console.error(`[ec]    SCENE-WIDE trigger. What remains are the per-OBJECT geometry-derived flags`);
    console.error(`[ec]    (vertexAlphas / vertexTangents / morph*), which differ BETWEEN objects that`);
    console.error(`[ec]    SHARE a material — three stores them per MATERIAL, so two objects with one`);
    console.error(`[ec]    material and different vertex-colour/tangent attributes would flip the flag`);
    console.error(`[ec]    on each other every frame, exactly like the batching flip. Instrument that;`);
    console.error(`[ec]    do NOT guess. (three.module.js:18378 vertexAlphas / :18382 vertexTangents.)`);
  } else {
    console.error(`[ec] => ⭐ CONFIRMED: a light count changes per frame, so lights.state.version bumps`);
    console.error(`[ec]    (three:8835) and EVERY material with needsLights re-resolves its program`);
    console.error(`[ec]    that frame (:18321). That is a whole-scene cost that scales with OBJECT`);
    console.error(`[ec]    COUNT — the shape every measurement in this chain has been pointing at.`);
  }

  fs.writeFileSync(process.env.OUT || "/mnt/wbterminal2/tmp/lights-churn.json",
    JSON.stringify({ poi: process.env.POI || "Holtburg", gpu, settle: s, ...r }, null, 2));
  await page.close();
  process.exit(0);
})();
