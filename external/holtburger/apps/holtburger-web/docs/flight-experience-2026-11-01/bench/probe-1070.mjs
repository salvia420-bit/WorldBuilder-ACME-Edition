// probe-1070.mjs — attach to the RUNNING off-screen test Chrome on the 1070 (started by flight-1070.mjs --keep) and
// run a probe: evaluate expressions, place the free camera (?camDebug=on → window.__cam), take screenshots. Never
// closes the browser (process.exit only).
//   node probe-1070.mjs --out DIR [--eval "expr"]... [--shot name:ex,ey,ez,tx,ty,tz[:waitMs]]... [--release]
// Camera coordinates are AC metres (x east, y north, z up), as window.__cam.set takes them.
import { createRequire } from "node:module";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require("/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules/playwright-core");
const argv = process.argv.slice(2);
const all = (k) => argv.flatMap((a, i) => (a === k && i + 1 < argv.length ? [argv[i + 1]] : []));
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const OUT = opt("--out", "/mnt/wbterminal1/tmp/claude-scratch/flight-experience/probe");
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await chromium.connectOverCDP("http://127.0.0.1:9333");
const ctx = browser.contexts()[0];
const pg = ctx.pages().find((p) => p.url().includes("holtburger-web")) || ctx.pages()[0];
const cdp = await ctx.newCDPSession(pg);
const out = { evals: [], shots: [] };
for (const e of all("--eval")) {
  let v;
  try { v = await pg.evaluate(`(async () => { try { return JSON.parse(JSON.stringify(await (${e}))); } catch (err) { return { error: String(err && err.stack || err) }; } })()`); }
  catch (err) { v = { error: String(err) }; }
  out.evals.push({ expr: e, value: v });
  console.log(`== ${e}\n${JSON.stringify(v, null, 1).slice(0, 4000)}`);
}
for (const s of all("--shot")) {
  const [name, coords, wait] = s.split(":");
  const c = coords.split(",").map(Number);
  try {
    await pg.evaluate((a) => window.__cam.set(a[0], a[1], a[2], a[3], a[4], a[5]), c);
    await sleep(Number(wait || 4000));
    const r = await cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 90 });
    const file = join(OUT, `${name}.jpg`);
    writeFileSync(file, Buffer.from(r.data, "base64"));
    out.shots.push({ name, file, at: c });
    console.log("shot", file);
  } catch (err) { console.log("shot failed", name, String(err)); }
}
if (argv.includes("--release")) { try { await pg.evaluate(() => window.__cam.release()); } catch (_) { /* */ } }
writeFileSync(join(OUT, "probe.json"), JSON.stringify(out, null, 1));
process.exit(0);
