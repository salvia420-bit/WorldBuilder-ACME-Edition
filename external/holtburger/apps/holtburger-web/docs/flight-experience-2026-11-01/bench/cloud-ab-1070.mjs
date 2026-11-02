// cloud-ab-1070.mjs — live A/B of the cloud look from high up, on the KEPT off-screen test page of the 1070
// (flight-1070.mjs --keep). Each arm: a setup expression, a settle, a screenshot from the same free-camera view
// (5 km over the player, looking down the deck), then the arm's restore. Never closes the browser.
//   node cloud-ab-1070.mjs --out DIR [--storm on|off] [--alt 5000] [--arms base,noshafts,step,towersoft,notower]
import { createRequire } from "node:module";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require("/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules/playwright-core");
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const OUT = opt("--out", "/mnt/wbterminal1/tmp/claude-scratch/flight-experience/cloud-ab");
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await chromium.connectOverCDP("http://127.0.0.1:9333");
const ctx = browser.contexts()[0];
const pg = ctx.pages().find((p) => p.url().includes("holtburger-web")) || ctx.pages()[0];
const cdp = await ctx.newCDPSession(pg);
const ALT = Number(opt("--alt", "5000"));
const out = { arms: [] };

// the module instance the page itself uses (same URL incl. the ?v= query)
const LOOK = `(async () => { const u = performance.getEntriesByType("resource").map((e) => e.name).find((n) => n.includes("/scene3d/cloud_storm_look.js")); return u ? await import(u) : null; })()`;
const ARMS = {
  base: { setup: "true", restore: "true" },
  noshafts: { setup: "(window.__cloudOverlay.volume.effect.lightShafts = false, true)", restore: "(window.__cloudOverlay.volume.effect.lightShafts = true, true)" },
  step: {
    setup: "(() => { const c = window.__cloudOverlay.volume.effect.clouds; window.__abStep = [c.minStepSize, c.maxIterationCount]; c.minStepSize = 15; c.maxIterationCount = 900; return [c.minStepSize, c.maxIterationCount]; })()",
    restore: "(() => { const c = window.__cloudOverlay.volume.effect.clouds; [c.minStepSize, c.maxIterationCount] = window.__abStep; return true; })()",
  },
  towersoft: {
    setup: `(async () => { const m = await ${LOOK}; const L = m.STORM_LAYERS[3]; window.__abTower = JSON.stringify(L); L.coverageFilterWidth = 0.6; L.weatherExponent = 1.0; L.shapeAlteringBias = 0.7; delete L.densityProfile; return true; })()`,
    restore: `(async () => { const m = await ${LOOK}; const L = m.STORM_LAYERS[3]; const o = JSON.parse(window.__abTower); for (const k of Object.keys(L)) delete L[k]; Object.assign(L, o); return true; })()`,
  },
  notower: {
    setup: `(async () => { const m = await ${LOOK}; const L = m.STORM_LAYERS[3]; window.__abTowerD = L.densityScale; L.densityScale = 0.0001; return true; })()`,
    restore: `(async () => { const m = await ${LOOK}; m.STORM_LAYERS[3].densityScale = window.__abTowerD; return true; })()`,
  },
  // the cumulus deck (r / g) with the tower faded: rounder tops / softer coverage edges
  rgsab: {
    setup: `(async () => { const m = await ${LOOK}; const T = m.STORM_LAYERS[3]; window.__abTowerD2 = T.densityScale; T.densityScale = 0.0001; window.__abRG = [0, 1].map((i) => m.STORM_LAYERS[i].shapeAlteringBias); for (const i of [0, 1]) m.STORM_LAYERS[i].shapeAlteringBias = 0.7; return true; })()`,
    restore: `(async () => { const m = await ${LOOK}; m.STORM_LAYERS[3].densityScale = window.__abTowerD2; [0, 1].forEach((i, k) => { m.STORM_LAYERS[i].shapeAlteringBias = window.__abRG[k]; }); return true; })()`,
  },
  rgcfw: {
    setup: `(async () => { const m = await ${LOOK}; const T = m.STORM_LAYERS[3]; window.__abTowerD3 = T.densityScale; T.densityScale = 0.0001; window.__abRGc = [0, 1].map((i) => m.STORM_LAYERS[i].coverageFilterWidth); for (const i of [0, 1]) m.STORM_LAYERS[i].coverageFilterWidth = 0.5; return true; })()`,
    restore: `(async () => { const m = await ${LOOK}; m.STORM_LAYERS[3].densityScale = window.__abTowerD3; [0, 1].forEach((i, k) => { m.STORM_LAYERS[i].coverageFilterWidth = window.__abRGc[k]; }); return true; })()`,
  },
  rgwexp: {
    setup: `(async () => { const m = await ${LOOK}; const T = m.STORM_LAYERS[3]; window.__abTowerD4 = T.densityScale; T.densityScale = 0.0001; window.__abRGw = [0, 1].map((i) => m.STORM_LAYERS[i].shapeAmount); for (const i of [0, 1]) m.STORM_LAYERS[i].shapeAmount = 0.6; return true; })()`,
    restore: `(async () => { const m = await ${LOOK}; m.STORM_LAYERS[3].densityScale = window.__abTowerD4; [0, 1].forEach((i, k) => { m.STORM_LAYERS[i].shapeAmount = window.__abRGw[k]; }); return true; })()`,
  },
  shape: {
    setup: `(async () => { const m = await ${LOOK}; window.__abShape = m.STORM_LAYERS.map((l) => [l.shapeAmount, l.shapeDetailAmount]); for (const l of m.STORM_LAYERS) { l.shapeDetailAmount = Math.min(l.shapeDetailAmount, 0.5); } return true; })()`,
    restore: `(async () => { const m = await ${LOOK}; m.STORM_LAYERS.forEach((l, i) => { [l.shapeAmount, l.shapeDetailAmount] = window.__abShape[i]; }); return true; })()`,
  },
};
const ev = async (expr) => {
  try { return await pg.evaluate(`(async () => { try { return JSON.parse(JSON.stringify(await (${expr}))); } catch (e) { return { error: String(e && e.stack || e) }; } })()`); }
  catch (e) { return { error: String(e) }; }
};

// the view: from the player's position, ALT m up and 3 km back, looking 10 km ahead and down onto the deck
const view = await ev(`(() => { const w = window.__cam.info().world; const h = window.__sessionHandle; const g = (x, y) => { try { return h.terrainHeightAt(x, y) ?? 0; } catch (_) { return 0; } }; const ex = w.x - 1500, ey = w.y - 3000; const ez = g(ex, ey) + ${ALT}; return [ex, ey, ez, w.x + 4000, w.y + 8000, g(w.x, w.y)]; })()`);
out.view = view;
console.log("view", JSON.stringify(view));
if (opt("--storm", "on") === "on") console.log("storm", JSON.stringify(await ev("(window.__setWeather({ is_storm: true }), window.__getWeather().is_storm)")));
await ev(`window.__cam.set(${view.join(",")})`);
await sleep(Number(opt("--settle", "20000"))); // the look applies, the high band eases in, the march switches

for (const name of opt("--arms", "base,noshafts,step,towersoft,notower").split(",")) {
  const a = ARMS[name];
  if (!a) { console.log("unknown arm", name); continue; }
  const s = await ev(a.setup);
  await ev(`window.__cam.set(${view.join(",")})`);
  await sleep(name === "base" ? 3000 : 12000);
  const look = await ev("(() => { const d = window.__cloudStateDiag?.(); return d ? { storm: d.look?.stormLookApplied, applies: d.look?.applies, hb: globalThis.__hbCloudHighBand, band: window.__cloudHighBand?.() } : null; })()");
  const r = await cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 90 });
  const file = join(OUT, `${name}.jpg`);
  writeFileSync(file, Buffer.from(r.data, "base64"));
  const back = await ev(a.restore);
  out.arms.push({ name, setup: s, look, restore: back, file });
  console.log(name, JSON.stringify({ setup: s, look }), file);
  await sleep(4000);
}
writeFileSync(join(OUT, "ab.json"), JSON.stringify(out, null, 1));
process.exit(0);
