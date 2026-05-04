// Phase 4 step 2a capture script — drives the wasm bundle through a
// real AC login → CharacterList → SelectCharacter → spawn handshake
// round-trip and screenshots the resulting Spawned state.
//
// Pre-reqs (see `docs/ace-local-setup.md` and the Phase 1 wsbridge
// notes):
// - ACE running headless on UDP 127.0.0.1:9000 (login) / 9001 (world).
// - holtburger-wsbridge running on ws://127.0.0.1:8080/.
// - python3 -m http.server 8765 from external/holtburger/ so
//   `apps/holtburger-web/index.html` and `dats/assets.hba` are reachable.
// - The test account must already have ≥1 character (auto-creates
//   give 0 characters; populate via the cli's interactive Create
//   Character flow before running this script).
//
// Run: `node capture_phase4_step2a.cjs` from `apps/holtburger-web/`.
// Outputs `docs/images/phase-4-step-2a-spawned.png`.

const { chromium } = require("playwright");
const path = require("node:path");

(async () => {
    // Default account is the one populated via the Phase 4 step 2a
    // setup recipe (see `docs/phase-4-renderer.md`'s step 2a section).
    // Override via env vars to point at any account that already has
    // ≥1 character.
    const ACCOUNT = process.env.PHASE4_TEST_ACCOUNT || "phase4demo";
    const PASSWORD = process.env.PHASE4_TEST_PASSWORD || "phase4demo";
    const BRIDGE_URL = process.env.PHASE4_BRIDGE_URL || "ws://127.0.0.1:8080/";
    const SERVER_IP = process.env.PHASE4_SERVER_IP || "127.0.0.1";
    const SERVER_PORT = process.env.PHASE4_SERVER_PORT || "9000";
    const PAGE_URL = process.env.PHASE4_PAGE_URL
        || "http://127.0.0.1:8765/apps/holtburger-web/index.html";
    const OUT_PATH = path.resolve(
        __dirname,
        "../../../../docs/images/phase-4-step-2a-spawned.png"
    );
    const SPAWN_TIMEOUT_MS = Number(process.env.PHASE4_SPAWN_TIMEOUT_MS || 15_000);

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

    await page.fill('input[name="account"]', ACCOUNT);
    await page.fill('input[name="password"]', PASSWORD);
    await page.fill('input[name="bridge_url"]', BRIDGE_URL);
    await page.fill('input[name="server_ip"]', SERVER_IP);
    await page.fill('input[name="server_port"]', SERVER_PORT);
    console.log(`submitting login as ${ACCOUNT}`);

    await page.click('#login-form button[type=submit]');
    await page.waitForSelector("#selection:not([hidden])", { timeout: 30_000 });
    console.log("Selection visible");

    await page.waitForTimeout(500);
    const initialStatus = await page.locator("#login-status").innerText();
    console.log(`login-status: ${initialStatus}`);

    const spawnButtons = page.locator('#character-ul button[data-id]');
    const buttonCount = await spawnButtons.count();
    console.log(`spawn buttons available: ${buttonCount}`);

    if (buttonCount === 0) {
        console.warn(
            "no characters on this account — capturing the empty-list "
            + "state. Populate via the cli's Create Character flow for a "
            + "richer step 2a screenshot."
        );
        await page.screenshot({ path: OUT_PATH, fullPage: false });
        console.log(`saved ${OUT_PATH}`);
        await browser.close();
        return;
    }

    // Click the first available Spawn button.
    await spawnButtons.first().click();
    console.log("clicked first Spawn button");

    // Wait for the status to flip to "Spawned".
    try {
        await page.waitForFunction(() => {
            const s = document.getElementById("login-status");
            return s && /Spawned/.test(s.innerText);
        }, { timeout: SPAWN_TIMEOUT_MS });
        console.log("Spawned status reached");
    } catch (e) {
        const status = await page.locator("#login-status").innerText();
        console.error(`spawn timeout — status was: ${status}`);
        await page.screenshot({ path: OUT_PATH, fullPage: false });
        console.log(`saved partial ${OUT_PATH}`);
        await browser.close();
        throw e;
    }

    await page.waitForTimeout(500);
    const finalStatus = await page.locator("#login-status").innerText();
    console.log(`final login-status: ${finalStatus}`);

    await page.screenshot({ path: OUT_PATH, fullPage: false });
    console.log(`saved ${OUT_PATH}`);

    await browser.close();
})().catch((err) => {
    console.error("capture failed:", err);
    process.exit(1);
});
