// harness/glsl_smoke/orb_canvas_parity_smoke.mjs — look parity of the vitals-orb
// vessel: the signed-off SVG renderer vs ?orbRender=canvas (2026-10-31,
// plugins/vitals-orbs.js; owner ask "make the orbs cheaper").
//
//   capped-build node harness/glsl_smoke/orb_canvas_parity_smoke.mjs [--png DIR] [--gpu]
//
// One headless Chromium tab (SwiftShader by default; --gpu drops the
// SwiftShader flags for a real-GPU box), orchestrator only (laptop rules).
// orb_canvas_parity_page.html mounts the REAL plugin twice per case — SVG,
// then canvas — at identical vitals, wave phase, slosh, ambient-loop time and
// glare time (__diag.vitalsOrbs.freeze), and this runner screenshots each
// vessel core (heraldry, glow and plaque hidden, so only the vessel is
// compared) over two backdrops (dark ground, noon sky) at DPR 1 and 2, then
// diffs the pair in-page. --png DIR writes, per case/kind/backdrop/DPR,
// `svg | canvas | |diff| x4` strips plus full-badge pairs for the owner glance.
//
// Cases: fill 0.15 / 0.5 / 0.95 (all three vitals), low health (fracture,
// glints, bloom, heartbeat), vitae (ceiling 0.85), a slosh (impulse 0.8), the
// damage glare at two flicker steps, the mana shimmer at three loop times;
// wave phases 0 / 1.3 / 2.9.
//
// 2026-10-31 look review (the canvas crack web read thinner / paler) adds:
//   registered     every vessel-only pair aligns best at a shift <= 0.25
//                  device px (the review measured a 0.3-0.7 px drift: Blink
//                  pixel-snaps a canvas box in the pane's pre-scale space);
//   crackEdgeHeld  per backdrop + DPR, the canvas/SVG luma-edge-energy ratio
//                  of low/hp is within 0.05 of fill50/hp's (the shared
//                  resampling cancels; a blurred or pale web drags it down);
//   and a dump: computed styles of the crack web + ancestors (SVG mode), the
//   CSS the canvas bake applies, and vessel-vs-core rects + backing sizes.
// PASS (exit 0) = the page ran with no console / page errors, every case
// mounted the requested renderer (svg: <svg>, canvas: <canvas>), every vessel
// drew, registered, crackEdgeHeld, and every vessel-only diff is within the PROVISIONAL bound below
// (mean |Δ| <= 3/255 per channel and 99th percentile <= 32/255). The bound is
// a first guess (not yet calibrated on a run): read the per-case numbers and
// the strips, then tighten it. Expected residuals: sprite resampling at
// fractional waterline offsets (blurred, so soft), the 240 px glass/caustic
// bitmaps resampled by drawImage instead of SVG <image>, gradient dithering.
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, "..", "..");
const require = createRequire(import.meta.url);
const { chromium } = require("/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules/playwright-core");
const PNG_DIR = (() => { const i = process.argv.indexOf("--png"); return i >= 0 ? process.argv[i + 1] : null; })();
const GPU = process.argv.includes("--gpu");
const BOUND = { mean: 3, p99: 32 };

const half = (k) => ({ hp: [150, 300], stam: [100, 200], mana: [50, 100] })[k];
const at = (f) => ({ hp: [Math.round(300 * f), 300], stam: [Math.round(200 * f), 200], mana: [Math.round(100 * f), 100] });
const mid = { hp: half("hp"), stam: half("stam"), mana: half("mana") };
const CASES = [
  { name: "fill15", vitals: at(0.15), phase: 0, animT: 0 },
  { name: "fill50", vitals: at(0.5), phase: 1.3, animT: 2600 },
  { name: "fill95", vitals: at(0.95), phase: 2.9, animT: 5200 },
  { name: "low", vitals: { ...mid, hp: [30, 300] }, phase: 1.3, animT: 1800 },
  { name: "vitae", vitals: { ...mid, hp: [265, 265, 312] }, phase: 0.7, animT: 3100 },
  { name: "slosh", vitals: mid, phase: 1.3, animT: 2600, impulse: 0.8 },
  { name: "glare30", vitals: mid, phase: 1.3, animT: 2600, glareT: 30 },
  { name: "glare100", vitals: mid, phase: 1.3, animT: 2600, glareT: 100 },
  { name: "shimmer0", vitals: mid, phase: 2.9, animT: 0 },
  { name: "shimmer1875", vitals: mid, phase: 2.9, animT: 1875 },
  { name: "shimmer3750", vitals: mid, phase: 2.9, animT: 3750 },
];
const BACKDROPS = { dark: "#1b1d22", sky: "#8fb3d9" };

const args = GPU ? ["--no-sandbox"] : ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox"];
const browser = await chromium.launch({ executablePath: "/usr/bin/chromium", headless: true, args });
const results = [];
const errors = [];
const pageErrors = [], consoleErrors = [], missing = [];
const shots = {};
const dumps = {};
try {
  for (const dpr of [1, 2]) {
    const context = await browser.newContext({ deviceScaleFactor: dpr, viewport: { width: 900, height: 260 } });
    const page = await context.newPage();
    page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 600)));
    page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 800)); });
    await page.route("http://smoke.test/**", (route) => {
      const u = new URL(route.request().url());
      let file, type = "text/javascript";
      if (u.pathname === "/page.html") { file = join(HERE, "orb_canvas_parity_page.html"); type = "text/html"; }
      else if (u.pathname === "/favicon.ico") return route.fulfill({ status: 200, contentType: "image/x-icon", body: "" });
      else if (u.pathname.startsWith("/app/")) {
        file = join(APP, u.pathname.slice(5));
        if (file.endsWith(".png")) type = "image/png";
      }
      if (!file) { missing.push(u.pathname); return route.fulfill({ status: 404, body: "" }); }
      try { return route.fulfill({ status: 200, contentType: type, body: readFileSync(file) }); }
      catch (e) { missing.push(u.pathname); return route.fulfill({ status: 404, body: String(e) }); }
    });
    // The plugin resolves its sprites against document.baseURI: serve the page
    // from /app/ so ./data/orb-sprites/*.png resolve like the client's.
    await page.route("http://smoke.test/app/page.html", (route) =>
      route.fulfill({ status: 200, contentType: "text/html", body: readFileSync(join(HERE, "orb_canvas_parity_page.html")) }));
    await page.goto("http://smoke.test/app/page.html");
    await page.waitForFunction(() => window.__orbParityReady, null, { timeout: 60000 });
    for (const c of CASES) {
      for (const [bgName, bg] of Object.entries(BACKDROPS)) {
        await page.evaluate((b) => window.__orbParity.setBackground(b), bg);
        const got = {};
        for (const mode of ["svg", "canvas"]) {
          const info = await page.evaluate(([m, cc]) => window.__orbParity.show(m, cc), [mode, c]);
          if (info.mode !== mode || (mode === "canvas" ? !(info.hasCanvas && !info.hasSvg) : !(info.hasSvg && !info.hasCanvas))) {
            errors.push(`${c.name}/${bgName}/dpr${dpr}: asked ${mode}, got ${JSON.stringify({ mode: info.mode, canvas: info.hasCanvas, svg: info.hasSvg })}`);
          }
          got[mode] = {};
          if (c.name === "low" && bgName === "dark") {
            dumps[`dpr${dpr}`] = dumps[`dpr${dpr}`] || {};
            dumps[`dpr${dpr}`][mode] = { fxStyles: info.fxStyles, bakeCss: info.bakeCss, geom: info.geom };
          }
          await page.evaluate(() => window.__orbParity.vesselOnly(true));
          for (const [k, r] of Object.entries(info.rects)) {
            const clip = { x: Math.floor(r.core.x) - 2, y: Math.floor(r.core.y) - 2, width: Math.ceil(r.core.w) + 5, height: Math.ceil(r.core.h) + 5 };
            got[mode][k] = "data:image/png;base64," + (await page.screenshot({ clip })).toString("base64");
          }
          if (PNG_DIR && bgName === "sky") {
            await page.evaluate(() => window.__orbParity.vesselOnly(false));
            await new Promise((r) => setTimeout(r, 150));
            for (const [k, r] of Object.entries(info.rects)) {
              const clip = { x: Math.floor(r.pane.x) - 4, y: Math.floor(r.pane.y) - 4, width: Math.ceil(r.pane.w) + 8, height: Math.ceil(r.pane.h) + 8 };
              shots[`badge_${c.name}_${k}_dpr${dpr}_${mode}`] = (await page.screenshot({ clip })).toString("base64");
            }
          }
        }
        for (const k of ["hp", "stam", "mana"]) {
          const d = await page.evaluate(([a, b, p]) => window.__orbParity.diff(a, b, p), [got.svg[k], got.canvas[k], !!PNG_DIR]);
          if (d.png) { shots[`diff_${c.name}_${k}_${bgName}_dpr${dpr}`] = d.png.split(",")[1]; delete d.png; }
          results.push({ case: c.name, kind: k, bg: bgName, dpr, ...d });
        }
      }
    }
    await page.evaluate(() => window.__orbParity.done());
    await context.close();
  }
} catch (e) {
  errors.push(String(e && e.stack || e).slice(0, 1200));
} finally {
  await browser.close();
}

if (PNG_DIR) {
  mkdirSync(PNG_DIR, { recursive: true });
  for (const [name, b64] of Object.entries(shots)) writeFileSync(join(PNG_DIR, `${name}.png`), Buffer.from(b64, "base64"));
}

const worst = results.reduce((w, r) => (r.mean > (w?.mean ?? -1) ? r : w), null);
const outOfBound = results.filter((r) => r.mean > BOUND.mean || r.p99 > BOUND.p99);
const edgeRatio = (r) => (r && r.edgeSvg > 0 ? r.edgeCanvas / r.edgeSvg : NaN);
const crack = [];
for (const bg of Object.keys(BACKDROPS)) for (const dpr of [1, 2]) {
  const pick = (c) => results.find((r) => r.case === c && r.kind === "hp" && r.bg === bg && r.dpr === dpr);
  const low = edgeRatio(pick("low")), ref = edgeRatio(pick("fill50"));
  crack.push({ bg, dpr, lowHp: +low.toFixed(3), fill50Hp: +ref.toFixed(3), held: low >= ref - 0.05 });
}
const misregistered = results.filter((r) => Math.hypot(r.shiftDx, r.shiftDy) > 0.25);
const checks = {
  pageRan: errors.length === 0 && results.length === CASES.length * 2 * 2 * 3,
  noConsoleErrors: pageErrors.length === 0 && consoleErrors.length === 0 && missing.length === 0,
  registered: results.length > 0 && misregistered.length === 0,
  crackEdgeHeld: crack.length === 4 && crack.every((c) => c.held),
  withinProvisionalBound: outOfBound.length === 0,
};
console.log("case        kind  bg    dpr  mean  p99  max  >8/255%  >24/255%  edge c/s  shift dx,dy  err0->best");
for (const r of results) {
  console.log(`${r.case.padEnd(11)} ${r.kind.padEnd(5)} ${r.bg.padEnd(5)} ${String(r.dpr).padEnd(4)} ${String(r.mean).padEnd(5)} ${String(r.p99).padEnd(4)} ${String(r.max).padEnd(4)} ${String(r.pctOver8).padEnd(8)} ${String(r.pctOver24).padEnd(9)} ${edgeRatio(r).toFixed(3).padEnd(9)} ${(r.shiftDx + "," + r.shiftDy).padEnd(12)} ${r.errUnshifted}->${r.errBestShift}`);
}
console.log("dumps (low case, dark backdrop):", JSON.stringify(dumps, null, 1));
console.log(JSON.stringify({ crack, misregistered: misregistered.map((r) => `${r.case}/${r.kind}/${r.bg}/dpr${r.dpr} (${r.shiftDx},${r.shiftDy})`), worst, outOfBound: outOfBound.map((r) => `${r.case}/${r.kind}/${r.bg}/dpr${r.dpr}`), errors, pageErrors, consoleErrors, missing, pngDir: PNG_DIR }, null, 1));
console.log("checks:", JSON.stringify(checks));
const pass = Object.values(checks).every(Boolean);
console.log(pass ? "PASS" : "FAIL");
process.exit(pass ? 0 : 1);
