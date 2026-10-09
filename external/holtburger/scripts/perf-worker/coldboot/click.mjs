// click.mjs — real mouse click on a selector in the live page. node click.mjs 'selector' [dbl]
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require("/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules/playwright-core");
const [sel, mode] = process.argv.slice(2);
const browser = await chromium.connectOverCDP("http://127.0.0.1:9333");
const pg = browser.contexts()[0].pages().find((p) => p.url().includes("holtburger-web"));
const loc = pg.locator(sel).first();
if (mode === "dbl") await loc.dblclick({ timeout: 5000 }); else await loc.click({ timeout: 5000 });
console.log("clicked", sel, mode || "");
process.exit(0);
