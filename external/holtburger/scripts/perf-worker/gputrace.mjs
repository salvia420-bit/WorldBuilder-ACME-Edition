// gputrace.mjs — full-browser Chrome trace (GPU process incl.) across the FIRST street-level sweep after boot.
//   node gputrace.mjs out.json [categories]   (default gpu.angle,gpu,toplevel,blink.user_timing)
// gpu.angle shows ANGLE's own work (ShaderTranslateTaskD3D, D3DCompile in Get*ExecutableTask, MainLinkLoadEvent
// waits). Avoid disabled-by-default-gpu.service / gpu.decoder: they inflate GPU-process cost ~10x.
// Analyse: python3 angleattr.py out.json '<the printed result JSON>'.
import { createRequire } from "node:module";
import { rawSession, rawTrace } from "./lib/cdp_raw.mjs";
const require = createRequire(import.meta.url);
const { chromium } = require("/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules/playwright-core");
const out = process.argv[2];
const cats = (process.argv[3] || "gpu.angle,gpu,toplevel,blink.user_timing").split(",");
// 2026-10-29: connectOverCDP hangs on the box's Chrome 156 once it lists `browser_ui` targets
// (lib/cdp_raw.mjs says why); after 15 s the trace and the sweep go over raw CDP instead.
const CDP = "http://127.0.0.1:9333";
const pw = chromium.connectOverCDP(CDP);
const browser = await Promise.race([pw, new Promise((r) => setTimeout(() => r(null), 15000))]);
let pg;
if (browser) {
  pg = browser.contexts()[0].pages().find((p) => p.url().includes("holtburger-web"));
} else {
  pw.catch(() => {});
  console.error("gputrace: connectOverCDP did not attach in 15 s: raw CDP (lib/cdp_raw.mjs)");
  ({ pg } = await rawSession(CDP));
}
const SWEEP = async (ms) => {
  try { window.__cam.release(); } catch (_) {}
  const t0 = performance.now(); performance.mark("hbSweepStart"); const fr = [];
  await new Promise((res) => { const f = (now) => { fr.push(now); window.__cam.player(8, ((now - t0) / ms) * 360, 12, 1.5); if (now - t0 >= ms) return res(); requestAnimationFrame(f); }; requestAnimationFrame(f); });
  await new Promise((res) => setTimeout(res, 1500));
  const d = fr.slice(1).map((t, i) => [Math.round(t - fr[i]), Math.round(fr[i] - t0)]).sort((a, b) => b[0] - a[0]);
  const all = fr.slice(1).map((t, i) => t - fr[i]);
  // 2026-10-20: the page's render-loop pace (`__frameCapState`). This script attaches to a page
  // another driver loaded; booted through lib/bench-url.mjs it reads fps 0 (pinned uncapped). A 60/30
  // here means the VTank frame cap paced the loop under this sweep, whose own rAF chain still counts
  // every vsync.
  let frameCap = null;
  try { frameCap = window.__frameCapState?.() ?? null; } catch (_) {}
  return { frames: fr.length, fps: +(fr.length / (ms / 1000)).toFixed(1), over100: all.filter((x) => x > 100).length, over50: all.filter((x) => x > 50).length, jank: Math.round(all.filter((x) => x > 50).reduce((a, x) => a + x - 33.3, 0)), worst: d.slice(0, 8), t0, frameCap };
};
let r;
if (browser) {
  await browser.startTracing(pg, { path: out, categories: cats });
  r = await pg.evaluate(SWEEP, 12000);
  await browser.stopTracing();
} else {
  r = await rawTrace(CDP, out, cats, () => pg.evaluate(SWEEP, 12000));
}
if (r.frameCap && r.frameCap.fps > 0) console.error(`gputrace: the render loop was capped at ${r.frameCap.fps} fps — boot the page with ?targetFps=0 (lib/bench-url.mjs)`);
console.log(JSON.stringify(r));
process.exit(0);
