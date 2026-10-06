// gputrace.mjs — full-browser Chrome trace (GPU process incl.) across the FIRST street-level sweep after boot.
//   node gputrace.mjs out.json [categories]   (default gpu.angle,gpu,toplevel,blink.user_timing)
// gpu.angle shows ANGLE's own work (ShaderTranslateTaskD3D, D3DCompile in Get*ExecutableTask, MainLinkLoadEvent
// waits). Avoid disabled-by-default-gpu.service / gpu.decoder: they inflate GPU-process cost ~10x.
// Analyse: python3 angleattr.py out.json '<the printed result JSON>'.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require("/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules/playwright-core");
const out = process.argv[2];
const cats = (process.argv[3] || "gpu.angle,gpu,toplevel,blink.user_timing").split(",");
const browser = await chromium.connectOverCDP("http://127.0.0.1:9333");
const pg = browser.contexts()[0].pages().find((p) => p.url().includes("holtburger-web"));
await browser.startTracing(pg, { path: out, categories: cats });
const r = await pg.evaluate(async (ms) => {
  try { window.__cam.release(); } catch (_) {}
  const t0 = performance.now(); performance.mark("hbSweepStart"); const fr = [];
  await new Promise((res) => { const f = (now) => { fr.push(now); window.__cam.player(8, ((now - t0) / ms) * 360, 12, 1.5); if (now - t0 >= ms) return res(); requestAnimationFrame(f); }; requestAnimationFrame(f); });
  await new Promise((res) => setTimeout(res, 1500));
  const d = fr.slice(1).map((t, i) => [Math.round(t - fr[i]), Math.round(fr[i] - t0)]).sort((a, b) => b[0] - a[0]);
  const all = fr.slice(1).map((t, i) => t - fr[i]);
  return { frames: fr.length, fps: +(fr.length / (ms / 1000)).toFixed(1), over100: all.filter((x) => x > 100).length, over50: all.filter((x) => x > 50).length, jank: Math.round(all.filter((x) => x > 50).reduce((a, x) => a + x - 33.3, 0)), worst: d.slice(0, 8), t0 };
}, 12000);
await browser.stopTracing();
console.log(JSON.stringify(r));
process.exit(0);
