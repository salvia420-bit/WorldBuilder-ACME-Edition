// Connect to the 1070's Chrome via CDP, replay the login, capture
// the wasm "memory access out of bounds" with full stack + the WS
// frame that triggered it.

const { chromium } = require("playwright");
const fs = require("node:fs");
const path = require("node:path");

const CDP_URL = process.env.K1_CDP_URL || "http://127.0.0.1:9223";
const PAGE_URL = process.env.K1_PAGE_URL
  || "http://localhost:7080/apps/holtburger-web/index.html";
const ACCOUNT = process.env.K1_ACCOUNT || "tailnet1";
const PASSWORD = process.env.K1_PASSWORD || "tailnet1";
const BRIDGE_URL = process.env.K1_BRIDGE_URL || "ws://127.0.0.1:8080/";
const SERVER_IP = process.env.K1_SERVER_IP || "127.0.0.1";
const SERVER_PORT = process.env.K1_SERVER_PORT || "9000";
const OUT_DIR = "/mnt/wbterminal1/tmp/claude-scratch/k1";

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log(`CDP: ${CDP_URL}`);
  const browser = await chromium.connectOverCDP(CDP_URL);
  const ctx = browser.contexts()[0];
  const pages = ctx.pages();
  console.log(`existing pages: ${pages.length}`);
  for (const p of pages) console.log(`  - ${p.url()}`);

  // Reuse the first page (Chrome was launched pointing at our URL).
  const page = pages[0] || (await ctx.newPage());

  const consoleLines = [];
  const pageErrors = [];
  page.on("console", (msg) => {
    const line = `[${msg.type()}] ${msg.text()}`;
    consoleLines.push(line);
    console.log(line);
  });
  page.on("pageerror", (err) => {
    const line = `[pageerror] ${err.message}\n${err.stack || ""}`;
    pageErrors.push(line);
    console.log(line);
  });

  const wsFrames = [];
  page.on("websocket", (ws) => {
    console.log(`[ws] open ${ws.url()}`);
    ws.on("framesent", ({ payload }) => {
      const buf = Buffer.from(payload);
      wsFrames.push({ dir: "send", len: buf.length, hex: buf.toString("hex"), t: Date.now() });
      const head = buf.toString("hex").slice(0, 160);
      console.log(`[ws send ${buf.length}b] ${head}${buf.length > 80 ? "..." : ""}`);
    });
    ws.on("framereceived", ({ payload }) => {
      const buf = Buffer.from(payload);
      wsFrames.push({ dir: "recv", len: buf.length, hex: buf.toString("hex"), t: Date.now() });
      const head = buf.toString("hex").slice(0, 160);
      console.log(`[ws recv ${buf.length}b] ${head}${buf.length > 80 ? "..." : ""}`);
    });
    ws.on("close", () => console.log("[ws] close"));
  });

  // First, snapshot the existing state (the user already attempted login).
  console.log("\n=== current page state ===");
  console.log("url:", page.url());
  const status = await page.locator("#login-status").innerText().catch(() => "(no #login-status)");
  console.log("#login-status:", status);
  const screenshot1 = path.join(OUT_DIR, "k1-1070-before-reload.png");
  await page.screenshot({ path: screenshot1, fullPage: false }).catch(() => null);
  console.log(`screenshot: ${screenshot1}`);

  // Now reload and replay the login while listeners are armed.
  console.log("\n=== reloading + replaying login ===");
  await page.goto(PAGE_URL, { waitUntil: "domcontentloaded" });
  // Wait briefly for smoke
  await page.waitForFunction(() => {
    const r = document.getElementById("results");
    return r && r.innerHTML.length > 0;
  }, { timeout: 20_000 }).catch(() => {
    console.log("smoke #results never populated");
  });
  await page.waitForTimeout(500);
  await page.fill('input[name="account"]', ACCOUNT);
  await page.fill('input[name="password"]', PASSWORD);
  await page.fill('input[name="bridge_url"]', BRIDGE_URL);
  await page.fill('input[name="server_host"]', SERVER_IP);
  await page.fill('input[name="server_port"]', SERVER_PORT);
  console.log(`submitting login: ${ACCOUNT} → ${SERVER_IP}:${SERVER_PORT} via ${BRIDGE_URL}`);
  await page.click("#login-form button[type=submit]", { noWaitAfter: true });

  // Watch for either CharacterList success or an error in login-status.
  await page.waitForTimeout(15_000);
  const status2 = await page.locator("#login-status").innerText().catch(() => "(no #login-status)");
  console.log("\n=== post-login #login-status ===");
  console.log(status2);

  const screenshot2 = path.join(OUT_DIR, "k1-1070-after-login.png");
  await page.screenshot({ path: screenshot2, fullPage: false }).catch(() => null);
  console.log(`screenshot: ${screenshot2}`);

  // Persist artifacts.
  const summary = {
    timestamp: new Date().toISOString(),
    cdp_url: CDP_URL,
    pageUrl: page.url(),
    loginStatus_before: status,
    loginStatus_after: status2,
    console_lines: consoleLines,
    pageErrors,
    wsFrames: wsFrames.map((f) => ({
      dir: f.dir,
      len: f.len,
      hex: f.hex.length > 400 ? f.hex.slice(0, 400) + "..." : f.hex,
      t: f.t,
    })),
    wsFramesTotal: wsFrames.length,
  };
  const sumPath = path.join(OUT_DIR, "k1-1070-summary.json");
  fs.writeFileSync(sumPath, JSON.stringify(summary, null, 2));
  console.log(`\nsummary: ${sumPath}`);
  // Also write full WS trace separately (raw hex).
  const tracePath = path.join(OUT_DIR, "k1-1070-ws-trace.txt");
  fs.writeFileSync(
    tracePath,
    wsFrames
      .map((f) => `${new Date(f.t).toISOString()} ${f.dir} ${f.len}b ${f.hex}`)
      .join("\n")
  );
  console.log(`ws trace: ${tracePath}`);
  console.log(`ws frames captured: ${wsFrames.length}`);
  console.log(`console lines: ${consoleLines.length}, pageerrors: ${pageErrors.length}`);

  await browser.close();
  process.exit(0);
})();
