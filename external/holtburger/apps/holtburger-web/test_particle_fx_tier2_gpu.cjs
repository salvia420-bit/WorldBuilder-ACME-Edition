#!/usr/bin/env node
// Tier-2 particle upgrade GPU smoke runner — serves apps/holtburger-web on a loopback
// port and drives test_particle_fx_tier2_gpu.html in ONE headless Chromium tab
// (SwiftShader WebGL2, small canvases — no game world, no server, no login).
// It is a HEAVY job under the laptop rules: check `free -m` first and run it
// inside the memory cap:
//   capped-build node test_particle_fx_tier2_gpu.cjs
// Exit 0 = every check passed and no shader/GL error.

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = __dirname;
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json" };

const server = http.createServer((req, res) => {
  const url = decodeURIComponent((req.url || "/").split("?")[0]);
  const file = path.normalize(path.join(ROOT, url));
  if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  });
});

(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const { chromium } = require("playwright-core");
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM || "/usr/bin/chromium",
    headless: true,
    args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--mute-audio", "--no-first-run",
      "--disable-extensions", "--js-flags=--max-old-space-size=512"],
  });
  let code = 1;
  try {
    const page = await browser.newPage({ viewport: { width: 200, height: 200 } });
    const logs = [];
    page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") logs.push(`${m.type()}: ${m.text()}`); });
    page.on("pageerror", (e) => logs.push(`pageerror: ${e.message}`));
    await page.goto(`http://127.0.0.1:${port}/test_particle_fx_tier2_gpu.html`);
    await page.waitForFunction(() => window.__result, null, { timeout: 180000 });
    const r = await page.evaluate(() => window.__result);
    for (const c of r.checks) console.log(`  [${c.ok ? "OK" : "FAIL"}] ${c.name}${c.detail ? " — " + c.detail : ""}`);
    for (const e of r.errors) console.log(`  ERROR ${e}`);
    for (const l of logs) console.log(`  console ${l}`);
    console.log(`  webgl2=${r.webgl2} logDepth=${r.logDepth} programs=${r.programs}`);
    console.log(`\n[test_particle_fx_tier2_gpu] ${r.ok ? "PASS" : "FAIL"} (${r.checks.filter((c) => c.ok).length}/${r.checks.length} checks)`);
    code = r.ok ? 0 : 1;
    await page.close();
  } catch (e) {
    console.error(e);
  } finally {
    await browser.close();
    server.close();
  }
  process.exit(code);
})();
