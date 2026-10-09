// probe.mjs — read-only second CDP client: evaluate a snippet in the live holtburger page.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const { chromium } = require("/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules/playwright-core");
const browser = await chromium.connectOverCDP("http://127.0.0.1:9333");
const pg = browser.contexts()[0].pages().find((p) => p.url().includes("holtburger-web"));
const src = readFileSync(process.argv[2], "utf8");
const r = await pg.evaluate(`(async () => { ${src}\n })()`);
console.log(typeof r === "string" ? r : JSON.stringify(r, null, 1));
process.exit(0);
