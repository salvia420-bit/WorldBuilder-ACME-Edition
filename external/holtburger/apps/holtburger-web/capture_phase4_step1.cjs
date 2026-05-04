// Phase 4 step 1 capture script — drives the wasm bundle through a
// real AC login → CharacterList round-trip and screenshots the
// resulting Selection screen.
//
// Pre-reqs (see `docs/ace-local-setup.md` and the Phase 1 wsbridge
// notes):
// - ACE running headless on UDP 127.0.0.1:9000 (login) / 9001 (world).
// - holtburger-wsbridge running on ws://127.0.0.1:8080/.
// - python3 -m http.server 8765 from external/holtburger/ so
//   `apps/holtburger-web/index.html` and `dats/assets.hba` are reachable.
//
// Run: `node capture_phase4_step1.cjs` from `apps/holtburger-web/`.
// Outputs `docs/images/phase-4-step-1-character-list.png`.

const { chromium } = require("playwright");
const path = require("node:path");

(async () => {
    // The account name is uniqueified per run so we always exercise the
    // auto-create-account path on a clean ACE; the password is
    // pinned to the same string. If a future smoke wants to populate
    // characters first, run `holtburger-cli` against the same account
    // with the same password between this script's launch and capture.
    const ACCOUNT = process.env.PHASE4_TEST_ACCOUNT || "phase4demo";
    const PASSWORD = process.env.PHASE4_TEST_PASSWORD || "phase4demo";
    const BRIDGE_URL = process.env.PHASE4_BRIDGE_URL || "ws://127.0.0.1:8080/";
    const SERVER_IP = process.env.PHASE4_SERVER_IP || "127.0.0.1";
    const SERVER_PORT = process.env.PHASE4_SERVER_PORT || "9000";
    const PAGE_URL = process.env.PHASE4_PAGE_URL
        || "http://127.0.0.1:8765/apps/holtburger-web/index.html";
    // From `apps/holtburger-web/` go up 4 to reach the
    // `WorldBuilder-ACME-Edition/` repo root: apps → holtburger →
    // external → WorldBuilder-ACME-Edition.
    const OUT_PATH = path.resolve(
        __dirname,
        "../../../../docs/images/phase-4-step-1-character-list.png"
    );

    console.log(`launching chromium → ${PAGE_URL}`);
    const browser = await chromium.launch({
        args: ["--use-gl=swiftshader"],
    });
    const context = await browser.newContext({
        viewport: { width: 1280, height: 1024 },
    });
    const page = await context.newPage();
    page.on("console", (msg) => {
        const text = msg.text();
        console.log(`[browser ${msg.type()}] ${text}`);
    });
    page.on("pageerror", (err) => {
        console.error("[pageerror]", err.message);
        if (err.stack) console.error(err.stack);
    });

    await page.goto(PAGE_URL, { waitUntil: "domcontentloaded" });

    // Smoke checks at top of page should land first.
    try {
        await page.waitForFunction(() => {
            const r = document.getElementById("results");
            return r && /PASS/.test(r.innerHTML);
        }, { timeout: 15_000 });
        console.log("smoke checks PASS");
    } catch (e) {
        const html = await page.locator("#results").innerHTML();
        console.error("results panel content:", html.slice(0, 500));
        throw e;
    }

    // Fill the login form.
    await page.fill('input[name="account"]', ACCOUNT);
    await page.fill('input[name="password"]', PASSWORD);
    await page.fill('input[name="bridge_url"]', BRIDGE_URL);
    await page.fill('input[name="server_ip"]', SERVER_IP);
    await page.fill('input[name="server_port"]', SERVER_PORT);
    console.log(`submitting login as ${ACCOUNT}`);

    // Submit and wait for the Selection block to unhide. (Phase 4 step
    // 2a.5 added an asset_url 6th arg to start_session; the form's
    // existing five fields populate the first five, and JS hardcodes
    // ASSET_URL = "../../dats/assets.hba" for the 6th, so no change
    // needed here.)
    await page.click('#login-form button[type=submit]');
    await page.waitForSelector("#selection:not([hidden])", { timeout: 30_000 });
    console.log("Selection visible");

    // Give the panel a tick to populate, then capture.
    await page.waitForTimeout(500);
    const status = await page.locator("#login-status").innerText();
    console.log(`login-status: ${status}`);

    const charLines = await page.locator("#character-ul li").count();
    console.log(`character entries rendered: ${charLines}`);

    // Capture viewport (full body would also work, but viewport keeps
    // file size sane and matches the framing of earlier step-N images).
    await page.screenshot({ path: OUT_PATH, fullPage: false });
    console.log(`saved ${OUT_PATH}`);

    await browser.close();
})().catch((err) => {
    console.error("capture failed:", err);
    process.exit(1);
});
