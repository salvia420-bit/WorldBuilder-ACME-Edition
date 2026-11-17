#!/usr/bin/env node
// harness/ingame-driver.mjs — persistent logged-in holtburger-web session (ultra + clouds, headless EGL GPU) with a
// tiny local control API, so in-game shots can be staged iteratively without re-logging in.
//   POST http://127.0.0.1:8799/eval   body = JS expression/async IIFE source  -> JSON result
//   GET  http://127.0.0.1:8799/shot?name=foo                                -> writes OUT/foo.png
//   GET  http://127.0.0.1:8799/chat                                         -> last chat panel lines
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { createRequire } from "node:module";

const OUT = process.env.OUT || "/workspace/wb/trailer-shots/ingame";
const W = 1920, H = 1080;
const PW = process.env.HB_PLAYWRIGHT_CORE || "/workspace/wb/mnt1/ac-refs/webac/node_modules/playwright-core";
const CHROME = process.env.HB_CHROME || "/workspace/wb/ms-playwright/chromium-1254/chrome-linux64/chrome";
const { chromium } = createRequire(import.meta.url)(PW);
fs.mkdirSync(OUT, { recursive: true });
const q = new URLSearchParams({
  nosw: "1", autoLogin: "1", account: process.env.ACCOUNT || "tailnet1", password: process.env.PASSWORD || "tailnet1",
  autoSpawn: "first", bridge_url: "ws://127.0.0.1:8080/", server_host: "127.0.0.1", server_port: "9000",
  quality: "ultra", clouds: "on", camDebug: "on", vehicles: "on", skytime: process.env.SKYTIME || "10",
  cloudCoverage: process.env.COVERAGE || "0.45", adaptiveRes: "off",
});
const browser = await chromium.launch({
  executablePath: CHROME, headless: true,
  args: ["--headless=new", "--use-gl=angle", "--use-angle=gl-egl", "--ignore-gpu-blocklist", "--enable-gpu-rasterization",
    "--mute-audio", "--window-position=-32000,-32000", "--disable-renderer-backgrounding",
    "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", `--window-size=${W},${H}`],
});
const page = await browser.newPage({ viewport: { width: W, height: H } });
const clog = fs.createWriteStream(path.join(OUT, "driver-console.log"));
page.on("console", (m) => clog.write(`[${m.type()}] ${m.text()}\n`));
page.on("pageerror", (e) => clog.write(`[pageerror] ${e.stack || e}\n`));
const LOGIN_URL = `http://127.0.0.1:8765/apps/holtburger-web/index.html?${q}`;
let inWorld = false;
for (let attempt = 1; attempt <= 4 && !inWorld; attempt++) {
  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 120000 });
  const t0 = Date.now();
  while (Date.now() - t0 < 180000) {
    const st = await page.evaluate(() => ({ s: window.__bootState, w: (window.__bootStateHistory || []).some((x) => x.state === "in-world") && !!window.liveScene3d })).catch(() => ({}));
    if (st.w) { inWorld = true; break; }
    if (st.s === "error") { console.log(`[driver] login attempt ${attempt} failed; retrying in 8 s`); await new Promise((r) => setTimeout(r, 8000)); break; }
    await new Promise((r) => setTimeout(r, 1000));
  }
}
if (!inWorld) { console.log("[driver] could not get in-world"); await browser.close(); process.exit(1); }
console.log("[driver] in-world");

http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  const send = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
  try {
    if (u.pathname === "/eval") {
      let body = ""; for await (const c of req) body += c;
      const r = await page.evaluate(`(async () => { ${body} })()`);
      return send(200, { ok: true, r });
    }
    if (u.pathname === "/shot") {
      const f = path.join(OUT, `${u.searchParams.get("name") || "shot"}.png`);
      await page.screenshot({ path: f, type: "png" });
      return send(200, { ok: true, f });
    }
    if (u.pathname === "/chat") {
      const r = await page.evaluate(() => [...document.querySelectorAll("#chat-panel *, .chat-line, .chat-message")].map((e) => e.textContent).filter(Boolean).slice(-40));
      return send(200, { ok: true, r });
    }
    if (u.pathname === "/profile") {
      // CPU profile of the page main thread for N seconds; returns the top self-time functions.
      const secs = Number(u.searchParams.get("s") || 6);
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Profiler.enable");
      await cdp.send("Profiler.setSamplingInterval", { interval: 500 });
      await cdp.send("Profiler.start");
      await new Promise((r) => setTimeout(r, secs * 1000));
      const { profile } = await cdp.send("Profiler.stop");
      await cdp.detach();
      const dt = new Map(); const byId = new Map(profile.nodes.map((n) => [n.id, n]));
      for (let i = 0; i < profile.samples.length; i++) {
        const n = byId.get(profile.samples[i]); const cf = n.callFrame;
        const k = `${cf.functionName || "(anon)"} ${cf.url.split("/").slice(-2).join("/")}:${cf.lineNumber + 1}`;
        dt.set(k, (dt.get(k) || 0) + (profile.timeDeltas[i] || 0));
      }
      const tot = [...dt.values()].reduce((a, b) => a + b, 0);
      const top = [...dt.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([k, v]) => `${(100 * v / tot).toFixed(1)}%  ${k}`);
      return send(200, { ok: true, top });
    }
    if (u.pathname === "/quit") { send(200, { ok: true }); await browser.close(); process.exit(0); }
    send(404, { ok: false });
  } catch (e) { send(500, { ok: false, err: String(e && e.stack || e) }); }
}).listen(8799, "127.0.0.1", () => console.log("[driver] control on http://127.0.0.1:8799"));
