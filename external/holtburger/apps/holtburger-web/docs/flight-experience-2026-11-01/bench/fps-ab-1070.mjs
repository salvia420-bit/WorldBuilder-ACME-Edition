// fps-ab-1070.mjs — live frame-rate A/B of the cloud march on the 1070 test page (an uncapped run: ?targetFps=0).
// Each arm: a screenshot just before it, the setup, a screenshot ~0.7 s after (the chase view moves with the aircraft,
// so only shots taken close together compare), a settle, an rAF record of `sec` seconds (fps mean, p50 / p95 / p99 /
// max frame ms), the restore. Two ways to run it:
//   * in-process from flight-1070.mjs (`--ab ARMS --ab-agl M [--ab-fair ARMS]`): ONE node job, which is what the
//     laptop's one-heavy-job rule allows; the arms run mid-flight while the page's autopilot keeps flying;
//   * standalone on a KEPT page (flight-1070.mjs --keep):
//     node fps-ab-1070.mjs --out DIR [--sec 8] [--settle 4000] [--arms a,b,...] [--weather fair|storm] [--rehome]
import { createRequire } from "node:module";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// the cloud volume (cloud_volume.js) and its takram effect; the high-band tick re-asserts its march every frame, so the
// arms that change the march replace it with a no-op on the instance (restore = delete the own property)
// the look module instance the page itself uses (same URL incl. the ?v= query)
const LOOK = `(async () => { const u = performance.getEntriesByType("resource").map((e) => e.name).find((n) => n.includes("/scene3d/cloud_storm_look.js")); return u ? await import(u) : null; })()`;
const V = "window.__cloudOverlay.volume";
const E = `${V}.effect`;
const hold = (body) => `(() => { const v = ${V}, e = v.effect; v._tickHighBandMarch = () => {}; ${body}; return [e.temporalUpscale, e.resolutionScale]; })()`;
const unhold = `(() => { const v = ${V}, e = v.effect; delete v._tickHighBandMarch; v._hbFull = false; e.temporalUpscale = true; e.resolutionScale = Number.isFinite(v._hbBaseRes) ? v._hbBaseRes : 1; return true; })()`;
export const ARMS = {
  base: { setup: "true", restore: "true" },
  // the march as below the deck: temporal upscale at the base scale
  hboff: { setup: hold("e.temporalUpscale = true; e.resolutionScale = Number.isFinite(v._hbBaseRes) ? v._hbBaseRes : 1"), restore: unhold },
  // every pixel at 0.4 / 0.35 / 0.6 of the resolution
  res40: { setup: hold("e.temporalUpscale = false; e.resolutionScale = 0.4"), restore: unhold },
  res35: { setup: hold("e.temporalUpscale = false; e.resolutionScale = 0.35"), restore: unhold },
  res60: { setup: hold("e.temporalUpscale = false; e.resolutionScale = 0.6"), restore: unhold },
  // temporal upscale at half resolution (each frame marches 1/16 of a half-res buffer)
  tuhalf: { setup: hold("e.temporalUpscale = true; e.resolutionScale = 0.5"), restore: unhold },
  noshafts: { setup: `(${E}.lightShafts = false, true)`, restore: `(${E}.lightShafts = true, true)` },
  noshadow: {
    setup: `(() => { const e = ${E}; window.__abSh = e.shadow?.cascadeCount; if (e.shadow) e.shadow.cascadeCount = 1; return window.__abSh; })()`,
    restore: `(() => { const e = ${E}; if (e.shadow && window.__abSh) e.shadow.cascadeCount = window.__abSh; return true; })()`,
  },
  iter300: {
    setup: `(() => { const c = ${E}.clouds; window.__abIt = c.maxIterationCount; c.maxIterationCount = 300; return window.__abIt; })()`,
    restore: `(() => { ${E}.clouds.maxIterationCount = window.__abIt; return true; })()`,
  },
  iter150: {
    setup: `(() => { const c = ${E}.clouds; window.__abIt2 = c.maxIterationCount; c.maxIterationCount = 150; return window.__abIt2; })()`,
    restore: `(() => { ${E}.clouds.maxIterationCount = window.__abIt2; return true; })()`,
  },
  // uniforms only (no recompile): the secondary marches as the takram "low" preset (1 sun sample, no ground bounce)
  sun1: {
    setup: `(() => { const c = ${E}.clouds; window.__abSun = [c.maxIterationCountToSun, c.maxIterationCountToGround]; c.maxIterationCountToSun = 1; c.maxIterationCountToGround = 0; return window.__abSun; })()`,
    restore: `(() => { const c = ${E}.clouds; [c.maxIterationCountToSun, c.maxIterationCountToGround] = window.__abSun; return true; })()`,
  },
  // the light-shaft (shadow length) march capped at 100 steps
  shlen100: {
    setup: `(() => { const c = ${E}.clouds; window.__abSl = c.maxShadowLengthIterationCount; c.maxShadowLengthIterationCount = 100; return window.__abSl; })()`,
    restore: `(() => { ${E}.clouds.maxShadowLengthIterationCount = window.__abSl; return true; })()`,
  },
  // no ground-bounce samples (the deck's undersides are not in view from above), sun samples kept
  ground0: {
    setup: `(() => { const c = ${E}.clouds; window.__abG0 = c.maxIterationCountToGround; c.maxIterationCountToGround = 0; return window.__abG0; })()`,
    restore: `(() => { ${E}.clouds.maxIterationCountToGround = window.__abG0; return true; })()`,
  },
  // the light-shaft march with a coarser first step (it grows x1.01 per step): fewer steps over the same distance
  shstep200: {
    setup: `(() => { const c = ${E}.clouds; window.__abSs = c.minShadowLengthStepSize; c.minShadowLengthStepSize = 200; return window.__abSs; })()`,
    restore: `(() => { ${E}.clouds.minShadowLengthStepSize = window.__abSs; return true; })()`,
  },
  shstep400: {
    setup: `(() => { const c = ${E}.clouds; window.__abSs4 = c.minShadowLengthStepSize; c.minShadowLengthStepSize = 400; return window.__abSs4; })()`,
    restore: `(() => { ${E}.clouds.minShadowLengthStepSize = window.__abSs4; return true; })()`,
  },
  // ground0 + shstep400 together
  combo: {
    setup: `(() => { const c = ${E}.clouds; window.__abCo = [c.maxIterationCountToGround, c.minShadowLengthStepSize]; c.maxIterationCountToGround = 0; c.minShadowLengthStepSize = 400; return window.__abCo; })()`,
    restore: `(() => { const c = ${E}.clouds; [c.maxIterationCountToGround, c.minShadowLengthStepSize] = window.__abCo; return true; })()`,
  },
  // combo at 0.45 of the resolution (every pixel)
  combo45: {
    setup: hold("e.temporalUpscale = false; e.resolutionScale = 0.45; e.clouds.maxIterationCountToGround = 0; e.clouds.minShadowLengthStepSize = 400"),
    restore: `(() => { const v = ${V}, e = v.effect; e.clouds.maxIterationCountToGround = 3; e.clouds.minShadowLengthStepSize = 50; delete v._tickHighBandMarch; v._hbFull = false; e.temporalUpscale = true; e.resolutionScale = Number.isFinite(v._hbBaseRes) ? v._hbBaseRes : 1; return true; })()`,
  },
  // the 2026-11-02 high band's own parts, undone one at a time (the default now: shafts x0, no ground bounce)
  shaftson: {
    setup: `(() => { const v = ${V}; window.__abSh0 = v._hbShaftsOff; v._hbShaftsOff = false; return window.__abSh0; })()`,
    restore: `(() => { ${V}._hbShaftsOff = window.__abSh0; return true; })()`,
  },
  ground3: {
    setup: hold("window.__abG3 = e.clouds.maxIterationCountToGround; e.clouds.maxIterationCountToGround = 3"),
    restore: `(() => { const v = ${V}, e = v.effect; e.clouds.maxIterationCountToGround = window.__abG3; delete v._tickHighBandMarch; return true; })()`,
  },
  // the fair look's alto deck (3.5 km, 600 m, density 0.004) thinned while the aircraft is above it: x0.1 / x0.25
  noalto: {
    setup: `(async () => { const m = await ${LOOK}; const L = m.FAIR_LAYERS[3]; window.__abAlto = L.densityScale; L.densityScale = window.__abAlto * 0.1; return [window.__abAlto, L.densityScale]; })()`,
    restore: `(async () => { const m = await ${LOOK}; m.FAIR_LAYERS[3].densityScale = window.__abAlto; return true; })()`,
    shotDelay: 3500,
  },
  alto25: {
    setup: `(async () => { const m = await ${LOOK}; const L = m.FAIR_LAYERS[3]; window.__abAlto2 = L.densityScale; L.densityScale = window.__abAlto2 * 0.25; return [window.__abAlto2, L.densityScale]; })()`,
    restore: `(async () => { const m = await ${LOOK}; m.FAIR_LAYERS[3].densityScale = window.__abAlto2; return true; })()`,
    shotDelay: 3500,
  },
  // the fair cumulus deck's tops rounded as the storm deck's are from above (shapeAlteringBias 0.35 → 0.7), alto x0.1
  fairround: {
    setup: `(async () => { const m = await ${LOOK}; window.__abFr = [m.FAIR_LAYERS[3].densityScale, m.FAIR_LAYERS[0].shapeAlteringBias, m.FAIR_LAYERS[1].shapeAlteringBias];
      m.FAIR_LAYERS[3].densityScale *= 0.1; m.FAIR_LAYERS[0].shapeAlteringBias = 0.7; m.FAIR_LAYERS[1].shapeAlteringBias = 0.7; return window.__abFr; })()`,
    restore: `(async () => { const m = await ${LOOK}; [m.FAIR_LAYERS[3].densityScale, m.FAIR_LAYERS[0].shapeAlteringBias, m.FAIR_LAYERS[1].shapeAlteringBias] = window.__abFr; return true; })()`,
    shotDelay: 3500,
  },
  // earlier termination (the takram "low" preset thresholds)
  term: {
    setup: `(() => { const c = ${E}.clouds; window.__abTm = [c.minDensity, c.minExtinction, c.minTransmittance]; c.minDensity = 1e-4; c.minExtinction = 1e-4; c.minTransmittance = 0.05; return window.__abTm; })()`,
    restore: `(() => { const c = ${E}.clouds; [c.minDensity, c.minExtinction, c.minTransmittance] = window.__abTm; return true; })()`,
  },
  // no march steps at all (the floor: resolve, upscale, shadow maps and the rest of the frame)
  march0: {
    setup: `(() => { const c = ${E}.clouds; window.__abM0 = [c.maxIterationCount, c.maxShadowLengthIterationCount]; c.maxIterationCount = 0; c.maxShadowLengthIterationCount = 0; return window.__abM0; })()`,
    restore: `(() => { const c = ${E}.clouds; [c.maxIterationCount, c.maxShadowLengthIterationCount] = window.__abM0; return true; })()`,
  },
};
const evOn = (pg) => async (expr) => {
  try { return await pg.evaluate(`(async () => { try { return JSON.parse(JSON.stringify(await (${expr}))); } catch (e) { return { error: String(e && e.stack || e) }; } })()`); }
  catch (e) { return { error: String(e) }; }
};
const recordOn = (ev) => (sec) => ev(`new Promise((res) => { const dts = []; let last = performance.now(); const t0 = last;
  const f = (t) => { dts.push(t - last); last = t; if (t - t0 < ${sec * 1000}) requestAnimationFrame(f); else {
    dts.shift(); const s = [...dts].sort((a, b) => a - b); const q = (p) => +s[Math.min(s.length - 1, Math.round(p / 100 * (s.length - 1)))].toFixed(1);
    res({ n: dts.length, fps: +(1000 * dts.length / dts.reduce((a, b) => a + b, 0)).toFixed(1), p50: q(50), p95: q(95), p99: q(99), max: q(100) }); } };
  requestAnimationFrame(f); })`);

/** Run `arms` on the page; writes OUT/ab.json and the paired shots, returns { state, arms }. */
export async function runAb({ pg, cdp, out: OUT, arms, sec = 8, settle = 4000, weather = "", weatherSettle = 15000, log = console.log }) {
  mkdirSync(OUT, { recursive: true });
  const ev = evOn(pg), record = recordOn(ev);
  const out = { arms: [] };
  if (weather) {
    log("weather", JSON.stringify(await ev(`(window.__setWeather({ is_storm: ${weather === "storm"} }), window.__getWeather().is_storm)`)));
    await sleep(weatherSettle);
  }
  out.state = await ev(`(() => { const e = ${E}; const v = ${V}; return { tu: e.temporalUpscale, res: e.resolutionScale, shafts: e.lightShafts,
    iter: e.clouds?.maxIterationCount, toSun: e.clouds?.maxIterationCountToSun, toGround: e.clouds?.maxIterationCountToGround,
    shStep: e.clouds?.minShadowLengthStepSize, shaftRay: v.material?.uniforms?.maxShadowLengthRayDistance?.value ?? null,
    shaftsOff: v._hbShaftsOff ?? null, hbFull: v._hbFull, deck: globalThis.__hbCloudAboveDeck, hb: globalThis.__hbCloudHighBand,
    storm: window.__getWeather?.()?.is_storm ?? null, agl: window.__flightView?.()?.agl ?? null, size: [innerWidth, innerHeight, devicePixelRatio] }; })()`);
  log("ab state", JSON.stringify(out.state));
  for (const name of arms) {
    const a = ARMS[name];
    if (!a) { log("unknown arm", name); continue; }
    const shot = async (tag) => {
      const r = await cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 88 });
      const f = join(OUT, `${out.arms.length}-${name}-${tag}.jpg`);
      writeFileSync(f, Buffer.from(r.data, "base64"));
      return f;
    };
    const pre = await shot("A-before");
    const s = await ev(a.setup);
    await sleep(a.shotDelay ?? (name === "noshafts" ? 2500 : 700));
    const file = await shot("B-arm");
    await sleep(settle);
    const fr = await record(sec);
    const back = await ev(a.restore);
    out.arms.push({ name, setup: s, frames: fr, restore: back, pre, file });
    log(`ab ${name.padEnd(9)}`, JSON.stringify(fr), "setup", JSON.stringify(s));
    await sleep(1500);
  }
  writeFileSync(join(OUT, "ab.json"), JSON.stringify(out, null, 1));
  return out;
}

// ---- standalone (a kept page)
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const require = createRequire(import.meta.url);
  const { chromium } = require("/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules/playwright-core");
  const argv = process.argv.slice(2);
  const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
  const browser = await chromium.connectOverCDP("http://127.0.0.1:9333");
  const ctx = browser.contexts()[0];
  const pg = ctx.pages().find((p) => p.url().includes("holtburger-web")) || ctx.pages()[0];
  const cdp = await ctx.newCDPSession(pg);
  await runAb({ pg, cdp, out: opt("--out", "/mnt/wbterminal1/tmp/claude-scratch/flight-experience/fps-ab"),
    arms: opt("--arms", "base,hboff,noshafts,res40,iter300,base").split(","), sec: Number(opt("--sec", "8")),
    settle: Number(opt("--settle", "4000")), weather: opt("--weather", ""), weatherSettle: Number(opt("--weather-settle", "15000")) });
  // --rehome: despawn the aircraft and teleport the character back to Holtburg (a run kept in the air would otherwise
  // leave the body over the ocean when Chrome closes — see flight-1070.mjs)
  if (argv.includes("--rehome")) {
    const ev = evOn(pg);
    await ev(`window.__sessionHandle.sendChat("@vehicle despawn all")`); await sleep(2000);
    await ev(`window.__sessionHandle.sendChat("@teleloc 0xA9B40019 84 7.1 94")`); await sleep(5000);
    console.log("re-homed");
  }
  process.exit(0);
}
