// Probes whether the WebGL canvas actually has rendered content.
"use strict";
const path = require("path");
let chromium;
try { chromium = require("playwright").chromium; }
catch (_) {
  chromium = require(path.join(process.env.PLAYWRIGHT_CACHE, "playwright")).chromium;
}
(async () => {
  const browser = await chromium.launch({
    headless: false,
    args: [
      "--window-size=1920,1080",
      "--window-position=0,0",
      "--start-maximized",
      "--no-sandbox",
      "--disable-dev-shm-usage",
    ],
  });
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await ctx.newPage();
  await page.goto((process.env.PAGE_URL_BASE || "http://127.0.0.1:8765/apps/holtburger-web/index.html") + "?renderer=3d&quality=ultra&clouds=on");
  await page.waitForFunction(() => /PASS/.test(document.getElementById("results")?.innerHTML || ""), { timeout: 90_000 });
  console.log("smoke PASS");
  await page.fill('input[name="account"]', "tailnet1");
  await page.fill('input[name="password"]', "tailnet1");
  await page.fill('input[name="bridge_url"]', "ws://127.0.0.1:8080/");
  await page.fill('input[name="server_host"]', "100.116.47.66");
  await page.fill('input[name="server_port"]', "9000");
  for (let i = 0; i < 3; i++) {
    await page.click('#login-form button[type=submit]');
    try { await page.waitForSelector("#selection:not([hidden])", { timeout: 45_000 }); break; }
    catch (_) { await page.waitForTimeout(12_000); }
  }
  console.log("logged in");
  if ((await page.locator('#character-ul button[data-id]').count()) === 0) {
    await page.fill('#create-form input[name="char_name"]', `P${Date.now().toString(36).slice(-6)}`);
    await page.click('#create-button');
    await page.waitForFunction(() => /Created\b/.test(document.getElementById("create-status")?.innerText || ""), { timeout: 30_000 });
    await page.waitForFunction(() => document.querySelectorAll('#character-ul button[data-id]').length > 0, { timeout: 10_000 });
  }
  await page.locator('#character-ul button[data-id]').first().click();
  await page.waitForFunction(() => /InWorld|Spawned/.test(document.getElementById("login-status")?.innerText || ""), { timeout: 60_000 });
  await page.waitForTimeout(8000);
  await page.evaluate(() => { try { window.__sessionHandle?.sendChat?.("/godly"); } catch (_) {} });
  await page.waitForFunction(() => !!window.liveScene3d?.renderer?.domElement, { timeout: 180_000 });
  console.log("renderer ready");
  await page.waitForTimeout(5000);

  // Take screenshot of the page; sample center pixel via Playwright's API.
  const ss = await page.screenshot({ type: "png", clip: { x: 0, y: 0, width: 1920, height: 1080 } });
  require("fs").writeFileSync("D:/andrew/claudecode2/out/video/probe-screenshot.png", ss);
  console.log("screenshot size: " + ss.length);

  // Also probe the canvas itself for non-zero pixels.
  const probe = await page.evaluate(() => {
    const canvases = Array.from(document.querySelectorAll("canvas"));
    const cv = window.liveScene3d?.renderer?.domElement;
    const out = {
      canvasCount: canvases.length,
      rendererCanvasIndex: canvases.indexOf(cv),
      rendererCanvasRect: cv?.getBoundingClientRect(),
      rendererCanvasWidth: cv?.width,
      rendererCanvasHeight: cv?.height,
      rendererStyle: cv ? { display: cv.style.display, visibility: cv.style.visibility, position: cv.style.position, zIndex: cv.style.zIndex } : null,
      windowSize: { w: window.innerWidth, h: window.innerHeight },
    };
    // For each canvas, sample center pixel via gl.readPixels (WebGL) OR
    // a 2D context (fallback). Note: gl.readPixels only works on the
    // canvas's OWN gl context that Three.js owns.
    for (let i = 0; i < canvases.length; i++) {
      const c = canvases[i];
      const info = { i, w: c.width, h: c.height, cls: c.className, id: c.id };
      try {
        const gl = c.getContext("webgl2", { preserveDrawingBuffer: true })
                || c.getContext("webgl", { preserveDrawingBuffer: true });
        if (gl) {
          const px = new Uint8Array(4);
          gl.readPixels(c.width >> 1, c.height >> 1, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
          info.centerPixel_webgl = Array.from(px);
        }
      } catch (e) { info.webglErr = e?.message; }
      out["canvas_" + i] = info;
    }
    return out;
  });
  console.log("probe:", JSON.stringify(probe, null, 2));

  await browser.close();
  process.exit(0);
})().catch((e) => { console.error("FATAL:", e?.stack || e?.message); process.exit(2); });
