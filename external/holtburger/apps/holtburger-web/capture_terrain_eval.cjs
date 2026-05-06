// One-shot capture for evaluating terrain quality. Drives the page
// through login + spawn + teleport, then crops the canvas region only
// at full pixel scale + zooms the camera in so the alpha-mask
// compositing is visible at the per-pixel level.

const { chromium } = require("playwright");
const path = require("node:path");

(async () => {
    const ACCOUNT = process.env.PHASE4_TEST_ACCOUNT || `terr_${Date.now()}`;
    const PASSWORD = process.env.PHASE4_TEST_PASSWORD || ACCOUNT;
    const BRIDGE_URL = "ws://127.0.0.1:8080/";
    const SERVER_IP = "127.0.0.1";
    const SERVER_PORT = "9000";
    const PAGE_URL = "http://127.0.0.1:8765/apps/holtburger-web/index.html";
    const OUT_PATH = path.resolve(
        __dirname,
        "../../../../docs/images/phase-3-step-3.6-tex-merge.png"
    );

    const browser = await chromium.launch({ args: ["--use-gl=swiftshader"] });
    const context = await browser.newContext({ viewport: { width: 1024, height: 1024 } });
    const page = await context.newPage();
    page.on("console", (msg) => {
        const text = msg.text();
        if (text.includes("[step3-trace]") || text.includes("WebGL") || text.includes("ERROR")) {
            console.log(`[browser ${msg.type()}] ${text}`);
        }
    });
    page.on("pageerror", (e) => console.error("[pageerror]", e.message));

    await page.goto(PAGE_URL, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => /PASS/.test(document.getElementById("results")?.innerHTML ?? ""), { timeout: 30000 });
    console.log("smoke PASS");

    await page.fill('input[name="account"]', ACCOUNT);
    await page.fill('input[name="password"]', PASSWORD);
    await page.fill('input[name="bridge_url"]', BRIDGE_URL);
    await page.fill('input[name="server_ip"]', SERVER_IP);
    await page.fill('input[name="server_port"]', SERVER_PORT);
    await page.click('#login-form button[type=submit]');
    await page.waitForSelector("#selection:not([hidden])", { timeout: 30000 });
    console.log("logged in");

    if ((await page.locator('#character-ul button[data-id]').count()) === 0) {
        await page.fill('#create-form input[name="char_name"]', `T${Date.now().toString(36).slice(-6)}`);
        await page.click('#create-button');
        await page.waitForFunction(() => /Created\b/.test(document.getElementById("create-status")?.innerText ?? ""), { timeout: 20000 });
        await page.waitForFunction(() => document.querySelectorAll('#character-ul button[data-id]').length > 0, { timeout: 10000 });
    }
    await page.locator('#character-ul button[data-id]').first().click();
    console.log("spawn click");
    await page.waitForFunction(() => /InWorld|Spawned/.test(document.getElementById("login-status")?.innerText ?? ""), { timeout: 30000 });
    try {
        await page.waitForSelector("#post-spawn:not([hidden])", { timeout: 10000 });
        await page.click("#teleport-button");
        console.log("teleport click");
        await page.waitForTimeout(8000);
    } catch (e) {
        console.warn("teleport block didn't unhide; capturing without teleport");
        await page.waitForTimeout(2000);
    }

    // Skip the camera zoom — multiplied scaling pushes us off-world.
    // The default fit-grid frame already shows terrain at a useful
    // density (~4 cells/cm); we just need the canvas pixels at native
    // resolution to evaluate alpha-mask compositing.
    await page.waitForTimeout(500);

    // Crop the canvas only.
    const handle = await page.locator("#canvas").elementHandle();
    if (handle) {
        await handle.screenshot({ path: OUT_PATH });
        console.log(`saved ${OUT_PATH}`);
    } else {
        console.error("no canvas found");
    }

    await browser.close();
    process.exit(0);
})().catch((e) => {
    console.error("failed:", e);
    process.exit(1);
});
