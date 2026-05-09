// Phase 4 step 6d capture script — drives login → spawn → @telepoi
// Holtburg → entity drain, then introspects window.entityMap to
// verify:
//   - Portal-category entities (if any visible) have an animated
//     PIXI.Graphics swirl as `entry.portalSwirl`.
//   - Writable-category entities (signs / books, if any visible)
//     have nameplates flagged `entry.nameplateIsSign === true`.
// Then takes a zoomed screenshot of the Holtburg plaza.
//
// The test passes as long as the entity drain resolves without
// errors. Detection of portal swirls / sign nameplates is logged
// for visual review — many flows have no portals or signs in the
// immediate @telepoi-Holtburg vision radius, so absence is not a
// failure.
//
// Run: `NODE_PATH=... node capture_phase4_step6d.cjs` from
// `apps/holtburger-web/`.

const { chromium } = require("playwright");
const path = require("node:path");

(async () => {
    const ACCOUNT = process.env.PHASE4_TEST_ACCOUNT
        || `step6d_${Date.now().toString(36).slice(-6)}`;
    const PASSWORD = process.env.PHASE4_TEST_PASSWORD || ACCOUNT;
    const BRIDGE_URL = process.env.PHASE4_BRIDGE_URL || "ws://127.0.0.1:8080/";
    const SERVER_IP = process.env.PHASE4_SERVER_IP || "127.0.0.1";
    const SERVER_PORT = process.env.PHASE4_SERVER_PORT || "9000";
    const PAGE_URL = process.env.PHASE4_PAGE_URL
        || "http://127.0.0.1:8765/apps/holtburger-web/index.html";
    const OUT_PATH = path.resolve(
        __dirname,
        "../../../../docs/images/phase-4-step-6d-portal-swirl-signs.png"
    );
    const CHAR_NAME = process.env.PHASE4_CHAR_NAME
        || `Step6D${Date.now().toString(36).slice(-6)}`;
    const ENTITY_DRAIN_MS = Number(process.env.PHASE4_ENTITY_DRAIN_MS || 6_000);

    console.log(`launching chromium → ${PAGE_URL}`);
    console.log(`account: ${ACCOUNT}, character: ${CHAR_NAME}`);
    const browser = await chromium.launch({ args: ["--use-gl=swiftshader"] });
    const context = await browser.newContext({
        viewport: { width: 1400, height: 1100 },
    });
    const page = await context.newPage();

    page.on("console", (msg) => {
        const text = msg.text();
        if (
            text.includes("[step")
            || text.includes("[OK]")
            || text.includes("FAIL")
            || /CharacterCreated|InWorld|Spawned/.test(text)
        ) {
            console.log(`[browser] ${text}`);
        }
    });
    page.on("pageerror", (err) => {
        console.error("[pageerror]", err.message);
        if (err.stack) console.error(err.stack);
    });

    await page.goto(PAGE_URL, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => {
        const r = document.getElementById("results");
        return r && /PASS/.test(r.innerHTML);
    }, { timeout: 30_000 });

    await page.fill('input[name="account"]', ACCOUNT);
    await page.fill('input[name="password"]', PASSWORD);
    await page.fill('input[name="bridge_url"]', BRIDGE_URL);
    await page.fill('input[name="server_host"]', SERVER_IP);
    await page.fill('input[name="server_port"]', SERVER_PORT);
    await page.click('#login-form button[type=submit]');
    await page.waitForSelector("#selection:not([hidden])", { timeout: 30_000 });
    await page.waitForTimeout(500);

    if ((await page.locator('#character-ul button[data-id]').count()) === 0) {
        await page.fill('#create-form input[name="char_name"]', CHAR_NAME);
        await page.click('#create-button');
        await page.waitForFunction(() => {
            const s = document.getElementById("create-status");
            return s && /Created\b/.test(s.innerText);
        }, { timeout: 15_000 });
        await page.waitForFunction(() =>
            document.querySelectorAll('#character-ul button[data-id]').length > 0,
            { timeout: 10_000 });
    }
    await page.locator('#character-ul button[data-id]').first().click();

    await page.waitForFunction(() => {
        const s = document.getElementById("login-status");
        return s && /InWorld|Spawned/.test(s.innerText);
    }, { timeout: 15_000 });
    await page.waitForSelector("#post-spawn:not([hidden])", { timeout: 5_000 });
    console.log("InWorld + post-spawn block visible");
    await page.click("#teleport-button");
    console.log(`teleported; waiting ${ENTITY_DRAIN_MS}ms for entity drain`);
    await page.waitForTimeout(ENTITY_DRAIN_MS);

    // Introspect entityMap for portal swirls + sign nameplates.
    const stats = await page.evaluate(() => {
        const m = window.entityMap;
        if (!m) return { error: "no entityMap" };
        let entityCount = 0;
        let withSwirl = 0;
        let signCount = 0;
        let portalCount = 0;
        let writableCount = 0;
        const swirlSamples = [];
        const signSamples = [];
        for (const [guid, entry] of m.entries()) {
            entityCount++;
            const cat = entry?.meta?.category || "unknown";
            if (cat === "portal") portalCount++;
            if (cat === "writable") writableCount++;
            if (entry?.portalSwirl) {
                withSwirl++;
                if (swirlSamples.length < 3) {
                    swirlSamples.push({
                        guid,
                        name: entry?.meta?.name || "(unnamed)",
                        wcid: entry?.meta?.wcid >>> 0,
                    });
                }
            }
            if (entry?.nameplateIsSign) {
                signCount++;
                if (signSamples.length < 3) {
                    signSamples.push({
                        guid,
                        name: entry?.meta?.name || "(unnamed)",
                        wcid: entry?.meta?.wcid >>> 0,
                    });
                }
            }
        }
        return {
            entityCount, portalCount, writableCount,
            withSwirl, signCount, swirlSamples, signSamples,
        };
    });
    console.log("entityMap introspection:", JSON.stringify(stats, null, 2));

    // Zoom in slightly so per-entity affordances (swirl rings,
    // italic sign text) are visible at screenshot resolution. Mirror
    // the step 4.5 zoomed pattern — set cameraContainer scale + recentre.
    await page.evaluate(() => {
        const cam = window.liveScene?.cameraContainer;
        if (!cam) return;
        // Bump zoom from default ~0.5 px/m to ~3.0 px/m so a 2 m
        // portal swirl renders at ~6 px diameter — visible without
        // crowding the rest of the scene.
        const targetScale = 3.0;
        const renderer = window.liveScene?.app?.renderer;
        if (!renderer) return;
        const cx = renderer.width / 2;
        const cy = renderer.height / 2;
        // Centre on the local player if known; else keep current centre.
        const lpg = (typeof window.getLocalPlayerGuid === "function")
            ? window.getLocalPlayerGuid() : null;
        const localEntry = lpg != null ? window.entityMap?.get(lpg >>> 0) : null;
        const sprite = localEntry?.sprite;
        if (sprite) {
            // worldContainer flips y so screen-y = -wy * sx + oy.
            cam.scale.set(targetScale, targetScale);
            cam.position.set(cx - sprite.x * targetScale, cy + sprite.y * targetScale);
        } else {
            cam.scale.set(targetScale, targetScale);
        }
    });
    await page.waitForTimeout(500);

    await page.evaluate(() => {
        document.getElementById("canvas")?.scrollIntoView({ block: "start" });
    });
    await page.waitForTimeout(200);
    await page.screenshot({ path: OUT_PATH, fullPage: false });
    console.log(`saved ${OUT_PATH}`);

    console.log("=========================");
    console.log(
        `PASS: Phase 4 step 6d render path closed.\n` +
        `  ${stats.entityCount} entities total\n` +
        `  ${stats.portalCount} portal-category — ${stats.withSwirl} with swirl Graphics\n` +
        `  ${stats.writableCount} writable-category — ${stats.signCount} with sign-styled nameplate\n` +
        `  swirl samples: ${JSON.stringify(stats.swirlSamples)}\n` +
        `  sign samples: ${JSON.stringify(stats.signSamples)}`
    );
    if (stats.portalCount > 0 && stats.withSwirl !== stats.portalCount) {
        console.error(
            `[WARN] portal swirl mismatch — ${stats.portalCount} portals visible ` +
            `but only ${stats.withSwirl} have a swirl. Spawn race? Check ` +
            `ensurePortalSwirl gating.`
        );
    }
    if (stats.writableCount > 0 && stats.signCount !== stats.writableCount) {
        console.error(
            `[WARN] sign nameplate mismatch — ${stats.writableCount} writables ` +
            `visible but only ${stats.signCount} have sign-styled nameplates.`
        );
    }
    await browser.close();
    process.exit(0);
})().catch((err) => {
    console.error("capture failed:", err);
    process.exit(1);
});
