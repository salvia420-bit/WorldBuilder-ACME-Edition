// shot.mjs — screenshots of the live page. node shot.mjs out.png [dom|3d] [clipSelector]
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const { chromium } = require("/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules/playwright-core");
const [out, mode = "dom", sel] = process.argv.slice(2);
const browser = await chromium.connectOverCDP("http://127.0.0.1:9333");
const pg = browser.contexts()[0].pages().find((p) => p.url().includes("holtburger-web"));
if (mode === "3d") {
  const url = await pg.evaluate(async () => {
    const r = window.liveScene3d.renderer, orig = r.render, cv = r.domElement; let last = null;
    r.render = function (...x) { const ret = orig.apply(this, x); if (r.getRenderTarget() === null) { try { last = cv.toDataURL("image/png"); } catch (e) { last = String(e); } } return ret; };
    await new Promise((res) => { let n = 0; const f = () => (++n >= 3 || last) ? res() : requestAnimationFrame(f); requestAnimationFrame(f); setTimeout(res, 4000); });
    r.render = orig; return last;
  });
  writeFileSync(out, Buffer.from(url.split(",")[1], "base64"));
} else if (sel) {
  await pg.locator(sel).first().screenshot({ path: out });
} else {
  await pg.screenshot({ path: out });
}
console.log("->", out);
process.exit(0);
