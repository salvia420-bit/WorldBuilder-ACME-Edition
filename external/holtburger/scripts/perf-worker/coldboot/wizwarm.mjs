// wizwarm.mjs — the first-time-player warm-up, end to end, on the live 1070 page.
// Precondition: `node sess.mjs boot --spawn select` (character screen up, fresh profile).
//   node wizwarm.mjs <label> <dwellMs> [charNameSubstring]
// Create Character → the wizard reports its start area → the academy loads behind it →
// dwell → × Close → select the academy character → ENTER → time to the academy's cells.
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const { chromium } = require("/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules/playwright-core");
const [label = "wiz", dwellArg = "60000", nameSub = "Eyetest"] = process.argv.slice(2);
const DWELL = +dwellArg;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await chromium.connectOverCDP("http://127.0.0.1:9333");
const pg = browser.contexts()[0].pages().find((p) => p.url().includes("holtburger-web"));
const sample = () => pg.evaluate(() => {
  const s = window.liveScene3d;
  const asArr = (v) => v instanceof Set ? Array.from(v).map((x) => (x >>> 0).toString(16)) : null;
  let cell = null; try { const p = window.__sessionHandle?.getLocalPlayerPose?.(); cell = p ? (p.landblockId >>> 0).toString(16) : null; p?.free?.(); } catch (_) {}
  return { open: document.getElementById("hb-charselect")?.dataset.open ?? null, wiz: !!document.getElementById("hb-charcreate"),
    preview: s?._spawnPreview ? (s._spawnPreview.cell >>> 0).toString(16) : null, kids: s?.cellsGroup?.children?.length ?? null,
    envIn: asArr(s?.envCellBuildInFlight), envLoaded: asArr(s?.envCellLoadedLbs), pf: s?.materialCache?.pendingFetches?.size ?? null,
    terr: s?.terrainBakedLbs?.size ?? null, cell, st: window.__bootState };
}).catch((e) => ({ err: String(e).slice(0, 80) }));
const tl = [];
const t0 = Date.now();
const log = (tag, s) => { const r = { t: Math.round((Date.now() - t0) / 100) / 10, tag, ...s }; tl.push(r); console.log(JSON.stringify(r)); };
log("screen", await sample());
await pg.locator("#hb-charselect .hcs-create").click();
let wizOpen = false;
for (let i = 0; i < 40 && !wizOpen; i++) { await sleep(250); wizOpen = (await sample()).wiz; }
log("wizard-open", await sample());
const tw = Date.now();
let last = "";
while (Date.now() - tw < DWELL) {
  await sleep(2000);
  const s = await sample();
  const k = JSON.stringify({ ...s, st: 0 });
  if (k !== last) { log("dwell", s); last = k; }
}
log("dwell-end", await sample());
await pg.locator("#hb-charcreate .hb-cc-close-btn").click();
await sleep(500);
const row = pg.locator("#hb-charselect .hcs-row", { hasText: nameSub }).first();
await row.click();
await sleep(400);
const atEnter = await sample();
log("enter", atEnter);
const te = Date.now();
await pg.locator("#hb-charselect .hcs-enter").click();
let inWorld = null, firstCells = null, done = null;
while (Date.now() - te < 180000) {
  await sleep(500);
  const s = await sample();
  const t = Date.now() - te;
  if (inWorld == null && s.open === "0" && s.cell) { inWorld = t; log("in-world", s); }
  if (firstCells == null && s.kids > 0 && s.cell) { firstCells = t; log("cells-visible", s); }
  if (inWorld != null && firstCells != null) { done = t; break; }
}
const out = { label, dwellMs: DWELL, atEnter, enterToInWorldMs: inWorld, enterToCellsMs: firstCells };
writeFileSync(`wizwarm-${label}.json`, JSON.stringify({ ...out, tl }, null, 1));
console.log("RESULT", JSON.stringify(out));
process.exit(0);
