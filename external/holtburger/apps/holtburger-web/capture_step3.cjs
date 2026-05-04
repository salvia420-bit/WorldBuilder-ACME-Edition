// Playwright + Chromium screenshot capture for Phase 3 step 3.
// Mirrors the step-1/step-2 capture pattern: --use-gl=swiftshader for
// reliable WebGL on Linux headless. Captures at 720×720 (smaller than
// the canvas's 512×512 because we want to see the full page chrome and
// stage-info panel alongside).
//
// Usage: `node capture_step3.cjs <out.png>` from `apps/holtburger-web/`.
// Assumes a python http server is up at http://127.0.0.1:8989/ rooted
// at `external/holtburger/`.

const { chromium } = require("/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules/playwright");

const out = process.argv[2] || "step3.png";
const url = process.argv[3] || "http://127.0.0.1:8989/apps/holtburger-web/index.html";

(async () => {
    const browser = await chromium.launch({
        args: ["--use-gl=swiftshader", "--enable-webgl"],
    });
    const ctx = await browser.newContext({ viewport: { width: 920, height: 1100 } });
    const page = await ctx.newPage();

    page.on("console", (msg) => {
        if (msg.type() === "error" || msg.type() === "warning") {
            console.error(`[browser ${msg.type()}]`, msg.text());
        }
    });
    page.on("pageerror", (err) => {
        console.error("[page error]", err.message);
        if (err.stack) console.error("[page stack]", err.stack);
    });

    await page.goto(url, { waitUntil: "networkidle" });
    // Wait until the renderer marks itself OK (or FAIL, in which case
    // we still capture for debugging).
    await page.waitForFunction(
        () => {
            const el = document.getElementById("render-status");
            return el && (el.textContent.includes("[OK]") || el.textContent.includes("[FAIL]"));
        },
        { timeout: 15000 }
    );

    // Settle one more frame so PixiJS has rendered.
    await page.waitForTimeout(500);

    await page.screenshot({ path: out, fullPage: true });
    console.log("captured", out);

    // Dump the visible status for the calling shell.
    const status = await page.evaluate(() => {
        const r = document.getElementById("render-status");
        return r ? r.innerText : "<no status element>";
    });
    console.log("render-status:", status);

    await browser.close();
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
