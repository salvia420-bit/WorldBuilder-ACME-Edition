// ab2.mjs <applyOnJs> <applyOffJs> <outA> <outB> — two frames, ~2 frames apart.
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const { chromium } = require("/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules/playwright-core");
const [onJs, offJs, outA, outB] = process.argv.slice(2);
const browser = await chromium.connectOverCDP("http://127.0.0.1:9334");
const pg = browser.contexts()[0].pages().find((p) => p.url().includes("holtburger-web"));
const res = await pg.evaluate(async ({ onJs, offJs }) => {
  const r = window.liveScene3d.renderer, cv = r.domElement, orig = r.render;
  const on = new Function(onJs), off = new Function(offJs);
  on();
  await new Promise((res) => setTimeout(res, 400));
  const shots = [];
  let frame = 0;
  await new Promise((resolve) => {
    r.render = function (...a) {
      const ret = orig.apply(this, a);
      if (r.getRenderTarget() === null) {
        frame++;
        if (frame === 1) { shots.push(cv.toDataURL("image/jpeg", 0.92)); off(); }
        else if (frame === 4) { shots.push(cv.toDataURL("image/jpeg", 0.92)); r.render = orig; on(); resolve(); }
      }
      return ret;
    };
  });
  return shots;
}, { onJs, offJs });
writeFileSync(outA, Buffer.from(res[0].split(",")[1], "base64"));
writeFileSync(outB, Buffer.from(res[1].split(",")[1], "base64"));
console.log("ok");
process.exit(0);
