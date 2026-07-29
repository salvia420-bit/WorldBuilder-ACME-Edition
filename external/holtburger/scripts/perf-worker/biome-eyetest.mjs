import { chromium } from "playwright-core";
import fs from "node:fs";
const OUT = "./eyetest"; fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const URL = "http://127.0.0.1:8765/apps/holtburger-web/index.html?renderer=3d&quality=high&nosw=1&autoLogin=1&account=tailnet1&password=tailnet1&autoSpawn=first&kickDance=1&agent=1&pbrTerrain=on&ibl=on";
const SPOTS = [
  ["grass-holtburg", "@telepoi Holtburg"],
  ["snow-neydisa", "@telepoi Neydisa"],
  ["ice-stonehold", "@telepoi Stonehold"],
  ["blueice-fiun", "@telepoi Fiun"],
];
const b = await chromium.connectOverCDP("http://127.0.0.1:9333");
const ctx = b.contexts()[0];
for (const p of ctx.pages()) if (p.url().includes("holtburger")) await p.close();
await sleep(30000);
const page = await ctx.newPage();
page.setDefaultTimeout(180000);
await page.goto(URL, { waitUntil: "domcontentloaded" });
for (let a = 0; ; a++) {
  try { await page.waitForFunction(() => window.__bootState === "ready" || window.__bootState === "error", null, { timeout: 170000, polling: 2000 }); } catch {}
  const bs = await page.evaluate(() => window.__bootState);
  if (bs === "ready") break;
  if (a >= 2) { console.error("boot fail", bs); process.exit(3); }
  await sleep(30000); await page.reload({ waitUntil: "domcontentloaded" });
}
await page.waitForFunction(() => window.liveScene3d?.terrainBakedLbs?.size > 5, null, { timeout: 180000, polling: 3000 });
console.log("noon:", await page.evaluate(() => {
  const c = window.liveScene3d?.skyLightingController;
  if (!c || !c._lastState) return "no-controller";
  c.tick = () => {};
  c._lastState = Object.assign({}, c._lastState, {
    timeOfDayNormalized: 0.5, dirHeading: 90, dirPitch: 65,
    dirBright: 1.0, ambBright: 1.0,
    dirColorArgb: 0xffdcdcdc >>> 0, ambColorArgb: 0xffdcdcdc >>> 0,
  });
  return "noon-injected";
}));
await sleep(35000);
for (const [name, tele] of SPOTS) {
  await page.evaluate((t) => window.__sessionHandle?.sendChat(t), tele);
  await sleep(10000);
  let prev = -1, stable = 0;
  for (let i = 0; i < 30 && stable < 2; i++) {
    await sleep(2500);
    const n = await page.evaluate(() => window.liveScene3d?.terrainBakedLbs?.size ?? 0);
    stable = n === prev ? stable + 1 : 0; prev = n;
  }
  await sleep(4000);
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log(`shot ${name} lbs=${prev}`);
}
await page.close(); b.close(); console.log("DONE");
