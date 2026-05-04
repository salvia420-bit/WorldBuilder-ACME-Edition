// Captures the centre Holtburg landblock at 3× zoom so building-tile
// per-poly colours are visible at near-atlas resolution. Used as the
// step 4.5 deliverable image.

const { chromium } = require("/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules/playwright");

const out = process.argv[2] || "step4.5-zoomed.png";
const url = process.argv[3] || "http://127.0.0.1:8989/apps/holtburger-web/index.html";

(async () => {
    const browser = await chromium.launch({
        args: ["--use-gl=swiftshader", "--enable-webgl"],
    });
    const ctx = await browser.newContext({ viewport: { width: 1024, height: 1024 } });
    const page = await ctx.newPage();
    page.on("pageerror", (err) => console.error("[page error]", err.message));

    await page.goto(url, { waitUntil: "networkidle" });
    await page.waitForFunction(
        () => {
            const el = document.getElementById("render-status");
            return el && (el.textContent.includes("[OK]") || el.textContent.includes("[FAIL]"));
        },
        { timeout: 30000 }
    );
    await page.waitForTimeout(750);

    // Zoom in 3× by dispatching wheel events centred on the canvas.
    const canvas = await page.locator("#canvas");
    const box = await canvas.boundingBox();
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    for (let i = 0; i < 12; i += 1) {
        await page.mouse.wheel(0, -100); // Negative deltaY = zoom in
        await page.waitForTimeout(40);
    }
    await page.waitForTimeout(400);

    // Crop screenshot to just the canvas.
    await canvas.screenshot({ path: out });
    console.log("captured", out);

    await browser.close();
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
