// g.mjs — graphics-session driver for the on-screen 1070 Chrome (CDP :9334 via the standing tunnel).
//   node g.mjs status
//   node g.mjs eval <file.js>        file = body of an async fn; return value printed as JSON
//   node g.mjs x '<js body>'         same, inline
//   node g.mjs snap <out.jpg> [q]    real 3D frame (read inside render(); page.screenshot is black)
//   node g.mjs fps <sec>             rAF fps + draw calls/frame over <sec>
//   node g.mjs console [n]           last n console lines captured by the in-page hook
// Never closes the browser (CDP disconnect only).
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const { chromium } = require("/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules/playwright-core");
const CDP = process.env.CDP || "http://127.0.0.1:9334";
const argv = process.argv.slice(2);
const cmd = argv[0];

async function page() {
  const browser = await chromium.connectOverCDP(CDP);
  const ctx = browser.contexts()[0];
  const pg = ctx.pages().find((p) => p.url().includes("holtburger-web")) || ctx.pages()[0];
  return { browser, ctx, pg };
}
const out = (r) => console.log(typeof r === "string" ? r : JSON.stringify(r, null, 1));

const { pg } = await page();
// Install a console ring once per page load (idempotent).
await pg.evaluate(() => {
  if (window.__gfxCon) return;
  window.__gfxCon = [];
  for (const k of ["log", "warn", "error", "info"]) {
    const o = console[k].bind(console);
    console[k] = (...a) => { try { window.__gfxCon.push(k[0] + " " + a.map((x) => (typeof x === "string" ? x : (() => { try { return JSON.stringify(x); } catch (_) { return String(x); } })())).join(" ").slice(0, 400)); if (window.__gfxCon.length > 400) window.__gfxCon.splice(0, 100); } catch (_) {} o(...a); };
  }
  window.addEventListener("error", (e) => window.__gfxCon.push("E " + e.message));
}).catch(() => {});

if (cmd === "status") {
  out(await pg.evaluate(() => {
    const h = window.__bootStateHistory || [];
    const r = window.liveScene3d?.renderer;
    return {
      url: location.href.slice(0, 200), boot: window.__bootState, hist: h.slice(-4).map((s) => (s.state || s) + (s.message ? ":" + String(s.message).slice(0, 80) : "")),
      scene: !!window.liveScene3d, lbs: window.__landblockLru?.entries?.size, geoms: r?.info?.memory?.geometries, tex: r?.info?.memory?.textures, programs: r?.info?.programs?.length,
      size: r ? [r.domElement.width, r.domElement.height, r.getPixelRatio?.()] : null, quality: window.__quality?.preset || window.__qualityPreset,
    };
  }));
  process.exit(0);
}
if (cmd === "eval" || cmd === "x") {
  const src = cmd === "eval" ? readFileSync(argv[1], "utf8") : argv[1];
  const r = await pg.evaluate(`(async () => { ${src}\n })()`);
  out(r);
  process.exit(0);
}
if (cmd === "snap") {
  const file = argv[1] || "snap.jpg", q = +(argv[2] || 0.88);
  const url = await pg.evaluate(async (q) => {
    const r = window.liveScene3d.renderer, orig = r.render, cv = r.domElement;
    let last = null;
    r.render = function (...a) { const ret = orig.apply(this, a); if (r.getRenderTarget() === null) { try { last = cv.toDataURL("image/jpeg", q); } catch (e) { last = String(e); } } return ret; };
    await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(res))));
    r.render = orig;
    return last;
  }, q);
  if (!url || !url.startsWith("data:")) { console.log("snap failed", String(url).slice(0, 200)); process.exit(1); }
  writeFileSync(file, Buffer.from(url.split(",")[1], "base64"));
  console.log("->", file);
  process.exit(0);
}
if (cmd === "fps") {
  const sec = +(argv[1] || 5);
  out(await pg.evaluate(async (ms) => {
    const r = window.liveScene3d?.renderer; const ar = r?.info?.autoReset;
    if (r) { r.info.autoReset = false; r.info.reset(); }
    const fr = []; const t0 = performance.now();
    await new Promise((res) => { const f = (now) => { fr.push(now); if (now - t0 >= ms) return res(); requestAnimationFrame(f); }; requestAnimationFrame(f); });
    const d = fr.slice(1).map((t, i) => t - fr[i]).sort((a, b) => a - b);
    const calls = r?.info?.render?.calls, tris = r?.info?.render?.triangles;
    if (r) { r.info.autoReset = ar; }
    const n = d.length;
    return { fps: +(n / ((fr[n] - fr[0]) / 1000)).toFixed(1), p50: +d[n >> 1].toFixed(1), p95: +d[Math.floor(n * 0.95)].toFixed(1), max: +d[n - 1].toFixed(1), callsPerFrame: calls ? Math.round(calls / n) : null, trisPerFrame: tris ? Math.round(tris / n) : null };
  }, sec * 1000));
  process.exit(0);
}
if (cmd === "console") {
  const n = +(argv[1] || 40);
  out(await pg.evaluate((n) => (window.__gfxCon || []).slice(-n), n));
  process.exit(0);
}
console.log("unknown cmd"); process.exit(2);
