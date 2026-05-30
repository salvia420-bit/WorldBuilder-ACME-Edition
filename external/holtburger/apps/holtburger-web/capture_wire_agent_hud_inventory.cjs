// One-shot capture: log in with wire-agent (?wireframe=1) but keep the
// HUD visible (strip the agent-mode CSS class after autoLogin reaches
// `ready`), open the inventory main-panel view, and snap a PNG.

const fs = require("node:fs");
const path = require("node:path");

const PLAYWRIGHT_CACHE =
  process.env.PLAYWRIGHT_CACHE ||
  "/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules";

let chromium;
try {
  ({ chromium } = require("playwright"));
} catch (_) {
  ({ chromium } = require(path.join(PLAYWRIGHT_CACHE, "playwright")));
}

const ACCOUNT = process.env.HB_ACCOUNT || "tailnet1";
const PASSWORD = process.env.HB_PASSWORD || "tailnet1";
const BASE = process.env.HB_BASE_URL || "http://127.0.0.1:7080";
const W = Number(process.env.HB_W || 1920);
const H = Number(process.env.HB_H || 1080);

const PAGE_URL =
  `${BASE}/apps/holtburger-web/index.html` +
  `?renderer=3d&wireframe=1` +
  `&autoLogin=1&account=${encodeURIComponent(ACCOUNT)}&password=${encodeURIComponent(PASSWORD)}` +
  `&autoSpawn=first&kickDance=1`;

const OUT = process.env.HB_OUT ||
  path.join(__dirname, "docs", "inventory-wire-agent-hud-2026-05-30.png");

(async () => {
  console.log(`[capture] URL: ${PAGE_URL}`);
  console.log(`[capture] OUT: ${OUT}`);

  const browser = await chromium.launch({
    headless: true,
    args: [
      `--window-size=${W},${H}`,
      "--disable-dev-shm-usage",
      "--no-sandbox",
      "--use-gl=angle",
      "--enable-webgl",
      "--ignore-gpu-blocklist",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--disable-backgrounding-occluded-windows",
    ],
  });
  const context = await browser.newContext({ viewport: { width: W, height: H } });
  const page = await context.newPage();

  page.on("console", (msg) => {
    const t = msg.text();
    if (msg.type() === "error" || /\[boot-state\]|\[wire-agent\]/i.test(t)) {
      console.log(`  [browser ${msg.type()}] ${t.slice(0, 240)}`);
    }
  });
  page.on("pageerror", (err) => console.log(`  [pageerror] ${err.message}`));

  await page.goto(PAGE_URL, { waitUntil: "domcontentloaded" });

  console.log("[capture] waiting for __bootState === 'ready' …");
  await page.waitForFunction(
    () => window.__bootState === "ready",
    { timeout: 120_000, polling: 500 },
  );
  console.log("[capture] ready.");

  // Keep `agent-mode` ON: it stretches #stage to the full viewport and
  // hides the bootstrap dev UI, while still allowlisting the real
  // `#hb-*` HUD (main-panel, vitals, radar, hotbar, etc). Removing it
  // would unstretch the canvas and bring back the smoke-check text.
  // Only `no-hud` (?hud=none) hides the HUD itself — we didn't pass it.

  // Give the HUD one frame to lay out, then open inventory.
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

  const opened = await page.evaluate(() => {
    if (typeof window.__mainPanel?.showView !== "function") return { ok: false, err: "no __mainPanel" };
    try {
      window.__mainPanel.showView("inventory");
      return { ok: true, currentViewId: window.__mainPanel.currentViewId?.() };
    } catch (e) {
      return { ok: false, err: String(e) };
    }
  });
  console.log(`[capture] open inventory → ${JSON.stringify(opened)}`);

  // Let icon-fetches + paint settle.
  await page.waitForTimeout(2500);

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  await page.screenshot({ path: OUT, fullPage: false });
  console.log(`[capture] wrote ${OUT}`);

  await browser.close();
})().catch((e) => {
  console.error("[capture] FAIL", e);
  process.exit(1);
});
