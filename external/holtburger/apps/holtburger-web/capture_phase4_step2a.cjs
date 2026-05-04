// Phase 4 step 2a/2a.5 capture script — drives the wasm bundle through
// the full AC login → CharacterList → CharacterCreate → spawn handshake
// against a real ACE and screenshots the resulting Spawned state.
//
// Pre-reqs (see `docs/ace-local-setup.md` and the Phase 1 wsbridge
// notes):
// - ACE running headless on UDP 127.0.0.1:9000 (login) / 9001 (world).
// - holtburger-wsbridge running on ws://127.0.0.1:8080/.
// - python3 -m http.server 8765 from external/holtburger/ so
//   `apps/holtburger-web/index.html` and `dats/assets.hba` are reachable.
// - dats/assets.hba built with `dat2hba --profile pruned` (or fuller)
//   so CharGen / SkillTable records are present — the wasm bundle's
//   character creation path needs both.
// - The test account is auto-created on first login. The script then
//   uses the in-browser Create-character form to populate ≥1
//   character before clicking Spawn, so live coverage of step 2a.5
//   (Phase 4 step 2a + character creation) lands in one capture.
//
// Run: `node capture_phase4_step2a.cjs` from `apps/holtburger-web/`.
// Outputs `docs/images/phase-4-step-2a-spawned.png`.

const { chromium } = require("playwright");
const path = require("node:path");

(async () => {
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
    const CHAR_NAME = process.env.PHASE4_CHAR_NAME
        || `WasmDemo${Date.now().toString(36).slice(-6)}`;
    const CREATE_TIMEOUT_MS = Number(process.env.PHASE4_CREATE_TIMEOUT_MS || 15_000);
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

    // Phase 4 step 2a.5 — populate the account if it's empty.
    const initialButtonCount = await page.locator('#character-ul button[data-id]').count();
    console.log(`initial spawn buttons: ${initialButtonCount}`);
    if (initialButtonCount === 0) {
        const createFormVisible = await page.locator("#create-form:not([hidden])").count() > 0;
        if (!createFormVisible) {
            console.error("Create-character form is hidden. Check that ASSET_URL is reachable + has CharGen/SkillTable.");
            await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(200);
    await page.screenshot({ path: OUT_PATH, fullPage: false });
            await browser.close();
            process.exit(1);
        }
        console.log(`creating character "${CHAR_NAME}"`);
        await page.fill('#create-form input[name="char_name"]', CHAR_NAME);
        await page.click('#create-button');
        try {
            await page.waitForFunction(() => {
                const s = document.getElementById("create-status");
                return s && /Created\b/.test(s.innerText);
            }, { timeout: CREATE_TIMEOUT_MS });
        } catch (e) {
            const status = await page.locator("#create-status").innerText();
            console.error(`create timeout — create-status was: ${status}`);
            await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(200);
    await page.screenshot({ path: OUT_PATH, fullPage: false });
            await browser.close();
            throw e;
        }
        const created = await page.locator("#create-status").innerText();
        console.log(`create-status: ${created}`);
        // Wait for the CharacterList re-fire to land + the JS rAF
        // poller to call renderCharacterList. ACE sends the
        // CharacterCreateResponse + the new CharacterList in close
        // succession, but they're separate packets — the kind=0 event
        // can lag the kind=5 by an animation frame or two. Wait for
        // the Spawn button to materialise.
        try {
            await page.waitForFunction(() => {
                return document.querySelectorAll('#character-ul button[data-id]').length > 0;
            }, { timeout: 10_000 });
        } catch (e) {
            console.error("Spawn button never appeared after Create — likely a CharacterList re-fire issue.");
            await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(200);
    await page.screenshot({ path: OUT_PATH, fullPage: false });
            await browser.close();
            throw e;
        }
    }

    const spawnButtons = page.locator('#character-ul button[data-id]');
    const buttonCount = await spawnButtons.count();
    console.log(`spawn buttons after create: ${buttonCount}`);
    if (buttonCount === 0) {
        console.error("No spawnable characters even after Create — capturing partial state.");
        await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(200);
    await page.screenshot({ path: OUT_PATH, fullPage: false });
        await browser.close();
        process.exit(1);
    }

    await spawnButtons.first().click();
    console.log("clicked first Spawn button");

    try {
        await page.waitForFunction(() => {
            const s = document.getElementById("login-status");
            return s && /Spawned/.test(s.innerText);
        }, { timeout: SPAWN_TIMEOUT_MS });
        console.log("Spawned status reached");
    } catch (e) {
        const status = await page.locator("#login-status").innerText();
        console.error(`spawn timeout — status was: ${status}`);
        await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(200);
    await page.screenshot({ path: OUT_PATH, fullPage: false });
        await browser.close();
        throw e;
    }

    await page.waitForTimeout(500);
    const finalStatus = await page.locator("#login-status").innerText();
    console.log(`final login-status: ${finalStatus}`);

    // Scroll to the Phase 4 step 1 + 2a heading so the screenshot
    // frames the login form + status line + Selection list +
    // Create form. The smoke checks above and the Phase 3 renderer
    // canvas below are deliberately cropped — they're covered by
    // earlier-step screenshots already.
    await page.evaluate(() => {
        const heading = document.querySelector('h2:has(+ p#login-status, + p > code)');
        const selectionH3 = document.querySelector("#selection h3");
        if (selectionH3) {
            selectionH3.scrollIntoView({ block: "start" });
            window.scrollBy(0, -260);
        } else {
            window.scrollTo(0, 280);
        }
    });
    await page.waitForTimeout(200);
    await page.screenshot({ path: OUT_PATH, fullPage: false });
    console.log(`saved ${OUT_PATH}`);

    await browser.close();
})().catch((err) => {
    console.error("capture failed:", err);
    process.exit(1);
});
