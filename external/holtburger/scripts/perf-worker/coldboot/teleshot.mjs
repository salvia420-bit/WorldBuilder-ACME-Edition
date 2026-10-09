// teleshot.mjs — send an admin chat command, wait, take a 3D screenshot of the live page.
//   node teleshot.mjs "<@cmd ...>" out.jpg [waitMs=6000]
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const { chromium } = require("/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules/playwright-core");
const [cmd, out, waitArg = "6000"] = process.argv.slice(2);
const browser = await chromium.connectOverCDP("http://127.0.0.1:9333");
const pg = browser.contexts()[0].pages().find((p) => p.url().includes("holtburger-web"));
if (cmd && cmd !== "-") await pg.evaluate((m) => window.__sessionHandle.sendChat(m), cmd);
await new Promise((r) => setTimeout(r, +waitArg));
const url = await pg.evaluate(async () => {
  const r = window.liveScene3d.renderer, orig = r.render, cv = r.domElement; let last = null;
  r.render = function (...x) { const ret = orig.apply(this, x); if (r.getRenderTarget() === null) { try { last = cv.toDataURL("image/jpeg", 0.85); } catch (e) { last = String(e); } } return ret; };
  await new Promise((res) => { let n = 0; const f = () => (++n >= 3 || last) ? res() : requestAnimationFrame(f); requestAnimationFrame(f); setTimeout(res, 4000); });
  r.render = orig; return last;
});
writeFileSync(out, Buffer.from(url.split(",")[1], "base64"));
const st = await pg.evaluate(() => { const s = window.liveScene3d; let cell = null; try { const p = window.__sessionHandle.getLocalPlayerPose(); cell = [(p.landblockId >>> 0).toString(16), p.x.toFixed(1), p.y.toFixed(1), p.z.toFixed(1)].join(" "); p.free?.(); } catch (_) {} return { cell, kids: s.cellsGroup?.children?.length, pf: s.materialCache?.pendingFetches?.size }; });
console.log("->", out, JSON.stringify(st));
process.exit(0);
