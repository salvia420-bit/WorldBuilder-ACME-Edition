// camset.mjs — park the debug camera (?camDebug=on) at an AC-world eye/target, screenshot, release.
//   node camset.mjs ex ey ez tx ty tz out.jpg [keep]
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const { chromium } = require("/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules/playwright-core");
const a = process.argv.slice(2); const nums = a.slice(0, 6).map(Number); const out = a[6]; const keep = a[7] === "keep";
const browser = await chromium.connectOverCDP("http://127.0.0.1:9333");
const pg = browser.contexts()[0].pages().find((p) => p.url().includes("holtburger-web"));
const url = await pg.evaluate(async ({ nums, keep }) => {
  window.__cam.set(...nums);
  await new Promise((r) => setTimeout(r, 400));
  const r = window.liveScene3d.renderer, orig = r.render, cv = r.domElement; let last = null;
  r.render = function (...x) { const ret = orig.apply(this, x); if (r.getRenderTarget() === null) { try { last = cv.toDataURL("image/jpeg", 0.85); } catch (e) { last = String(e); } } return ret; };
  await new Promise((res) => { let n = 0; const f = () => (++n >= 3 || last) ? res() : requestAnimationFrame(f); requestAnimationFrame(f); setTimeout(res, 4000); });
  r.render = orig; if (!keep) window.__cam.release(); return last;
}, { nums, keep });
writeFileSync(out, Buffer.from(url.split(",")[1], "base64")); console.log("->", out);
process.exit(0);
