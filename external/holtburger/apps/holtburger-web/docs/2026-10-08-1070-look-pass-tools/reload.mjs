// reload.mjs — same page URL (minus params listed in argv), wait for the ACE logout, navigate.
import { createRequire } from "node:module";
import { statSync, openSync, readSync, closeSync } from "node:fs";
const require = createRequire(import.meta.url);
const { chromium } = require("/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules/playwright-core");
const ACE_LOG = "/home/wbterminal/ace-server/Source/ACE.Server/bin/Release/net10.0/ACE_Log.txt";
const tail = () => { const size = statSync(ACE_LOG).size, fd = openSync(ACE_LOG, "r"); const n = Math.min(262144, size); const b = Buffer.alloc(n); readSync(fd, b, 0, n, size - n); closeSync(fd); return b.toString("utf8"); };
const lastEv = () => { const ev = tail().split("\n").filter((l) => /\[(LOGIN|LOGOUT)\] Account tailnet1 /.test(l)); return ev[ev.length - 1] || ""; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await chromium.connectOverCDP("http://127.0.0.1:9334");
const ctx = browser.contexts()[0];
const pg = ctx.pages().find((p) => p.url().includes("holtburger-web")) || ctx.pages()[0];
const u = new URL(pg.url());
for (const k of process.argv.slice(2)) {
  if (k.includes("=")) { const [a, b] = k.split("="); u.searchParams.set(a, b); } else u.searchParams.delete(k);
}
const keys = [...u.searchParams.keys()].filter((k) => !/pass/i.test(k));
console.log("params:", keys.join(","));
await pg.goto("about:blank").catch(() => {});
const t0 = Date.now();
while (Date.now() - t0 < 90000) { if (/\[LOGOUT\]/.test(lastEv())) break; await sleep(1500); }
console.log("logout seen after", Date.now() - t0, "ms");
await sleep(3000);
await pg.goto(u.toString(), { waitUntil: "domcontentloaded", timeout: 60000 });
console.log("navigated");
process.exit(0);
