// Phase 4 step 2b capture script — drives the bundle through login →
// CharacterCreate (if needed) → spawn → @telepoi Holtburg, then waits
// for the ObjectCreate / UpdatePosition flurry that follows
// EnteredWorld so the live entity layer populates. Screenshots the
// PIXI canvas with the rendered local player + any nearby entities
// visible at Holtburg town centre.
//
// Pre-reqs (same as step 2a; see `docs/ace-local-setup.md`):
// - ACE running headless on UDP 127.0.0.1:9000 (login) / 9001 (world).
// - holtburger-wsbridge running on ws://127.0.0.1:8080/.
// - python3 -m http.server 8765 from external/holtburger/.
// - Manifest+shards baked under dist/ (the index.html consumes them
//   via init_resource_source).
// - The test account needs accessLevel = 4 for `@telepoi`. Promote
//   with: `mariadb -uace -pace -e "UPDATE ace_auth.account SET
//   accessLevel = 4 WHERE accountName LIKE 'phase4demo%'"`.
//
// Run: `node capture_phase4_step2b.cjs` from `apps/holtburger-web/`.
// Outputs `docs/images/phase-4-step-2b-entities.png`.

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
        "../../../../docs/images/phase-4-step-2b-entities.png"
    );
    const CHAR_NAME = process.env.PHASE4_CHAR_NAME
        || `WasmDemo${Date.now().toString(36).slice(-6)}`;
    const CREATE_TIMEOUT_MS = Number(process.env.PHASE4_CREATE_TIMEOUT_MS || 15_000);
    const SPAWN_TIMEOUT_MS = Number(process.env.PHASE4_SPAWN_TIMEOUT_MS || 15_000);
    // Time to wait after teleport for ACE to dispatch the
    // ObjectCreate / UpdatePosition flurry that populates the entity
    // map. Empirically a few seconds covers Holtburg town centre's
    // ~20-50 nearby entities (NPCs, vendors, town guards). Bump if
    // running against a denser zone.
    const ENTITY_DRAIN_MS = Number(process.env.PHASE4_ENTITY_DRAIN_MS || 4_000);

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

    // Mirror step 2a.5: populate the account if it's empty.
    const initialButtonCount = await page.locator('#character-ul button[data-id]').count();
    if (initialButtonCount === 0) {
        const createFormVisible = await page.locator("#create-form:not([hidden])").count() > 0;
        if (!createFormVisible) {
            console.error("Create-character form is hidden. Check that the manifest is reachable + has CharGen/SkillTable.");
            await page.screenshot({ path: OUT_PATH, fullPage: false });
            await browser.close();
            process.exit(1);
        }
        console.log(`creating character "${CHAR_NAME}"`);
        await page.fill('#create-form input[name="char_name"]', CHAR_NAME);
        await page.click('#create-button');
        await page.waitForFunction(() => {
            const s = document.getElementById("create-status");
            return s && /Created\b/.test(s.innerText);
        }, { timeout: CREATE_TIMEOUT_MS });
        await page.waitForFunction(() => {
            return document.querySelectorAll('#character-ul button[data-id]').length > 0;
        }, { timeout: 10_000 });
    }

    const spawnButtons = page.locator('#character-ul button[data-id]');
    if ((await spawnButtons.count()) === 0) {
        console.error("No spawnable characters — bailing.");
        await page.screenshot({ path: OUT_PATH, fullPage: false });
        await browser.close();
        process.exit(1);
    }

    await spawnButtons.first().click();
    console.log("clicked first Spawn button");

    await page.waitForFunction(() => {
        const s = document.getElementById("login-status");
        return s && /InWorld|Spawned/.test(s.innerText);
    }, { timeout: SPAWN_TIMEOUT_MS });
    console.log("Spawned/InWorld status reached");

    const TELEPORT_TIMEOUT_MS = Number(process.env.PHASE4_TELEPORT_TIMEOUT_MS || 5_000);
    try {
        await page.waitForSelector("#post-spawn:not([hidden])", { timeout: TELEPORT_TIMEOUT_MS });
        console.log("Teleport block unhid");
    } catch (e) {
        console.warn("Teleport block never unhid — capturing without teleport.");
    }

    const teleportVisible = await page.locator("#post-spawn:not([hidden])").count() > 0;
    if (teleportVisible) {
        console.log("clicking Teleport to Holtburg button");
        await page.click("#teleport-button");
        // ACE doesn't ack `@telepoi`; we just wait for the resulting
        // ObjectCreate / UpdatePosition flurry to populate the entity
        // map. ENTITY_DRAIN_MS is the wait window.
        console.log(`waiting ${ENTITY_DRAIN_MS}ms for entity drain`);
        await page.waitForTimeout(ENTITY_DRAIN_MS);
    } else {
        // Even without teleport, a few entities at the spawn area
        // (Training Academy) usually populate. Wait a shorter time.
        await page.waitForTimeout(1500);
    }

    // Probe the entity map size from JS — the page exposes
    // `window.entityMap` only via `entityMap` in module scope, but
    // `page.evaluate` runs in the page's window so a global isn't
    // accessible directly. Instead read DOM-observable counters: the
    // entityContainer has `children.length` mirroring the entity sprite
    // count. The PIXI app handle is on the canvas.__pixiApp via PIXI's
    // own debug hooks, but since we don't expose it, fall back to a
    // simple "did the canvas render anything new" sanity check.
    const sceneSummary = await page.evaluate(() => {
        // entityMap is in module scope; expose it for inspection if not
        // already on window. The script tag is a module, so we can't
        // reach in directly — surface via the existing `liveScene`
        // module-scope state. This is a debugging-only path.
        const liveScene = window.liveScene || null;
        if (!liveScene || !liveScene.entityContainer) {
            return { hasScene: false, entityCount: 0 };
        }
        return {
            hasScene: true,
            entityCount: liveScene.entityContainer.children.length,
        };
    });
    console.log(`scene: ${JSON.stringify(sceneSummary)}`);

    // Scroll to the canvas so the screenshot frames the rendered scene.
    // Step 2a's screenshot framed the login + selection UI; this one
    // shows the live entity layer in the world.
    await page.evaluate(() => {
        const canvasElem = document.getElementById("canvas");
        if (canvasElem) canvasElem.scrollIntoView({ block: "start" });
    });
    await page.waitForTimeout(200);
    await page.screenshot({ path: OUT_PATH, fullPage: false });
    console.log(`saved ${OUT_PATH}`);

    await browser.close();
})().catch((err) => {
    console.error("capture failed:", err);
    process.exit(1);
});
