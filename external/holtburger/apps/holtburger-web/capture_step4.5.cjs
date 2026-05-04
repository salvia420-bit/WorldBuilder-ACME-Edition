// Playwright + Chromium screenshot capture for Phase 3 step 4.5.
// Mirrors capture_step3.cjs: --use-gl=swiftshader for reliable WebGL on
// Linux headless. Captures the full page so the new "Real colours: N
// of M" stage-info row shows alongside the rendered scene.
//
// Usage: `node capture_step4.5.cjs <out.png>` from `apps/holtburger-web/`.
// Assumes a python http server is up at http://127.0.0.1:8989/ rooted
// at `external/holtburger/`.

const { chromium } = require("/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules/playwright");

const out = process.argv[2] || "step4.5.png";
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
    await page.waitForFunction(
        () => {
            const el = document.getElementById("render-status");
            return el && (el.textContent.includes("[OK]") || el.textContent.includes("[FAIL]"));
        },
        { timeout: 30000 }
    );
    await page.waitForTimeout(750);

    await page.screenshot({ path: out, fullPage: true });
    console.log("captured", out);

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
