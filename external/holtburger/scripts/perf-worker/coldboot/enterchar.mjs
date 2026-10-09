// enterchar.mjs — on the character screen (sess.mjs boot --spawn select): select the row whose text is
// exactly <name> (the "+" admin prefix ignored), ENTER, wait for in-world.   node enterchar.mjs <name>
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require("/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules/playwright-core");
const name = process.argv[2];
const browser = await chromium.connectOverCDP("http://127.0.0.1:9333");
const pg = browser.contexts()[0].pages().find((p) => p.url().includes("holtburger-web"));
const rows = pg.locator("#hb-charselect .hcs-row");
const n = await rows.count(); let hit = -1;
for (let i = 0; i < n; i++) { const t = (await rows.nth(i).textContent()).trim().replace(/^\+/, ""); if (t === name) { hit = i; break; } }
if (hit < 0) { console.log("no row", name); process.exit(1); }
await rows.nth(hit).click();
await pg.locator("#hb-charselect .hcs-enter").click();
const t0 = Date.now(); let ok = false;
while (Date.now() - t0 < 120000 && !ok) { ok = await pg.evaluate(() => window.__bootState === "in-world" || (window.__bootStateHistory || []).some((h) => h.state === "in-world")).catch(() => false); if (!ok) await new Promise((r) => setTimeout(r, 500)); }
console.log(ok ? `in-world as ${name} after ${(Date.now() - t0) / 1000}s` : "NOT in world");
process.exit(ok ? 0 : 1);
