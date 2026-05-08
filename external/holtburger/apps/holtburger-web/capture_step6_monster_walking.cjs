// Phase 4 step 6 Tier 2 capture: drive the live ACE stack, find a
// moving monster (Drudge / Banderling / Mountain Rat / Sparring
// Golem), zoom in, force its speedMps above the moving threshold so
// the walk-cycle bake fires + frame cycler kicks in, capture 6
// sequential frames as a strip. The frame variation between strip
// cells is the visible Tier 2 proof.
//
// Pre-reqs: ACE on UDP 9000/9001, wsbridge ws://0.0.0.0:8080,
// http.server :8765, dist/ baked, test account at access level 4.
const { chromium } = require("playwright");
const path = require("node:path");

(async () => {
    const ACCOUNT = process.env.PHASE4_TEST_ACCOUNT || "bsmithuw9f2d";
    const PASSWORD = process.env.PHASE4_TEST_PASSWORD || ACCOUNT;
    const BRIDGE_URL = process.env.PHASE4_BRIDGE_URL || "ws://127.0.0.1:8080/";
    const SERVER_IP = process.env.PHASE4_SERVER_IP || "127.0.0.1";
    const SERVER_PORT = process.env.PHASE4_SERVER_PORT || "9000";
    const PAGE_URL = process.env.PHASE4_PAGE_URL
        || "http://127.0.0.1:8765/apps/holtburger-web/index.html";
    const OUT_DIR = path.resolve(__dirname, "../../../../docs/images");
    const STRIP_PATH = path.join(OUT_DIR, "phase-4-step-6-monster-walking.png");
    const SINGLE_PATH = path.join(OUT_DIR, "phase-4-step-6-monster-walking-frame0.png");
    const TELELOC_TARGET = process.env.PHASE4_TELELOC_TARGET
        || "@teleloc 0xA0B50000 110 80 78.0";
    const POST_TELEPORT_DRAIN_MS = 25_000;
    const SETTLE_MS = 4_000;
    // Time-base for the 6-frame strip: rAF cycler runs at
    // WALK_FRAME_RATE = 12 fps inside the page, so a frame advances
    // every ~83 ms. Sample 6 frames at ~120 ms intervals to span
    // the whole cycle on a typical 8-frame walk Animation (cycle
    // duration ~660 ms at 12 fps).
    const STRIP_FRAME_COUNT = 6;
    const STRIP_FRAME_INTERVAL_MS = 130;

    console.log(`[walk-capture] launching chromium → ${PAGE_URL}`);
    const browser = await chromium.launch({ args: ["--use-gl=swiftshader"] });
    const context = await browser.newContext({ viewport: { width: 1280, height: 1024 } });
    const page = await context.newPage();
    page.setDefaultTimeout(180_000);
    page.on("pageerror", (err) => console.error("[pageerror]", err.message));
    page.on("console", (msg) => {
        const text = msg.text();
        if (/walk-bake|error|warn/i.test(text)) console.log(`[browser ${msg.type()}] ${text}`);
    });

    await page.goto(PAGE_URL, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() =>
        /PASS/.test(document.getElementById("results")?.innerHTML || ""),
        { timeout: 15_000 });

    await page.fill('input[name="account"]', ACCOUNT);
    await page.fill('input[name="password"]', PASSWORD);
    await page.fill('input[name="bridge_url"]', BRIDGE_URL);
    await page.fill('input[name="server_ip"]', SERVER_IP);
    await page.fill('input[name="server_port"]', SERVER_PORT);
    await page.click('#login-form button[type=submit]');
    await page.waitForSelector("#selection:not([hidden])", { timeout: 30_000 });
    await page.waitForTimeout(500);

    if ((await page.locator('#character-ul button[data-id]').count()) === 0) {
        const charName = `WalkDemo${Date.now().toString(36).slice(-6)}`;
        console.log(`[walk-capture] creating character ${charName}`);
        await page.fill('#create-form input[name="char_name"]', charName);
        await page.click('#create-button');
        await page.waitForFunction(
            () => /Created\b/.test(document.getElementById("create-status")?.innerText || ""),
            { timeout: 15_000 }
        );
        await page.waitForFunction(
            () => document.querySelectorAll('#character-ul button[data-id]').length > 0,
            { timeout: 10_000 }
        );
    }
    await page.locator('#character-ul button[data-id]').first().click();
    await page.waitForFunction(
        () => /InWorld|Spawned/.test(document.getElementById("login-status")?.innerText || ""),
        { timeout: 30_000 }
    );
    await page.waitForSelector("#post-spawn:not([hidden])", { timeout: 10_000 });
    console.log("[walk-capture] EnteredWorld; teleporting Holtburg → monster spawn area");
    await page.click("#teleport-button");
    // Wait longer for the @telepoi teleport to settle before
    // chaining @teleloc — ACE seems to need a few seconds for the
    // first teleport's position broadcast + landblock load to
    // complete, otherwise the second teleport gets dropped or
    // raced and the player stays at outdoor Holtburg.
    await page.waitForTimeout(8000);
    console.log("[walk-capture] sending @teleloc");
    await page.evaluate((cmd) => window.__sessionHandle?.sendChat?.(cmd), TELELOC_TARGET);
    console.log(`[walk-capture] waiting ${POST_TELEPORT_DRAIN_MS}ms for entity stream`);
    await page.waitForTimeout(POST_TELEPORT_DRAIN_MS);

    // Pick the highest-substitution-score *humanoid* (any entity
    // with a full ClothingTable composition — almost always uses
    // setup 0x02000001 = humanoid base). Tier 2 walk-cycle is
    // best demonstrated on a humanoid because (a) MotionTable
    // 0x09000001 is the standard humanoid table and definitely has
    // WALK_FORWARD, and (b) the limb composition makes the cycle
    // visually unambiguous. Most non-humanoid creatures (chickens,
    // rats) use restricted MotionTables that don't define a walk
    // cycle keyed on WALK_FORWARD.
    const probe = await page.evaluate(() => {
        if (!window.entityMap) return null;
        const candidates = [];
        let best = null;
        for (const [guid, entry] of window.entityMap.entries()) {
            const m = entry.meta;
            if (!m?.name) continue;
            if (entry.kind !== "sprite" || !entry.sprite?.x || !entry.sprite?.y) continue;
            // Skip the local player.
            if (m.wcid === 1) continue;
            const score = (m.modelChanges?.length || 0)
                        + (m.textureChanges?.length || 0)
                        + (m.subPalettes?.length || 0);
            // Score < 10 = trivial-substitution entity (chest,
            // door, raw item, single-mesh creature). Skip.
            if (score < 10) continue;
            const candidate = {
                guid, score, name: m.name, wcid: m.wcid,
                modelId: entry.modelId,
                spriteX: entry.sprite.x, spriteY: entry.sprite.y,
                mc: m.modelChanges?.length || 0,
                tc: m.textureChanges?.length || 0,
                sp: m.subPalettes?.length || 0,
            };
            candidates.push(candidate);
            if (!best || score > best.score) best = candidate;
        }
        return { best, monsters: candidates, total: window.entityMap.size };
    });
    console.log(`[walk-capture] entityMap.size=${probe?.total}, monster candidates:`);
    for (const m of probe?.monsters ?? []) {
        console.log(`    score=${m.score} guid=0x${m.guid.toString(16).toUpperCase()} wcid=${m.wcid} pos=(${m.spriteX.toFixed(0)},${m.spriteY.toFixed(0)}) name="${m.name}"`);
    }
    const target = probe?.best;
    if (!target) {
        console.error("[walk-capture] no monster found in entityMap. Bailing.");
        await browser.close();
        process.exit(1);
    }
    console.log("[walk-capture] target:", JSON.stringify(target, null, 2));

    // Force the walk-bake directly via the exposed kickWalk... fn,
    // bypassing the velocity-threshold gate. The bake itself runs
    // through fetchEntityCycleFrames against real DAT data — bakes
    // walk and run cycles together; only the trigger is
    // short-circuited.
    console.log(`[walk-capture] kicking walk-bake directly on guid=0x${target.guid.toString(16).toUpperCase()}`);
    const walkBakeOk = await page.evaluate(async ({ g }) => {
        const entry = window.entityMap?.get(g);
        if (!entry) return { ok: false, reason: "entry gone" };
        entry.speedMps = 5.0;
        const cacheKey = window.computeEntitySpriteKey(entry.modelId, entry.meta);
        const re0 = window.liveScene?.liveSpriteMap?.get(cacheKey);
        if (!re0) return { ok: false, reason: `no liveMap entry for cacheKey=${cacheKey}` };
        // Kick the bake directly — same call tickEntityAnimations
        // would have made on first detected motion. Bakes BOTH
        // walk and run cycles in one call (post-rename: the
        // function is kickCycleFrameBakeIfNeeded; old name kept
        // as an alias for capture-script compatibility).
        window.kickWalkFrameBakeIfNeeded(cacheKey, entry.modelId, entry.meta);
        // Wait up to 60s for walk OR run frames to populate. The
        // bake touches MotionTable + Animation + N×(SetupModel +
        // GfxObj parts + Surface chains) — first time for a
        // setup can take 5-15 s with the manifest-mode fetch
        // path. Subsequent entities sharing the same setup hit
        // the cache instantly. Some retail creatures have only
        // a RUN_FORWARD cycle in their MotionTable (no walk
        // entry); accept either as success.
        const t0 = performance.now();
        while (performance.now() - t0 < 60_000) {
            const re = window.liveScene?.liveSpriteMap?.get(cacheKey);
            const walkN = re?.walkFrames?.length ?? 0;
            const runN = re?.runFrames?.length ?? 0;
            const walkSettled = re?.walkFrames !== null && re?.walkFrames !== undefined;
            const runSettled = re?.runFrames !== null && re?.runFrames !== undefined;
            if (walkN > 0 || runN > 0) {
                return {
                    ok: true,
                    walkFrameCount: walkN,
                    runFrameCount: runN,
                    walkFramerate: re?.walkFramerate ?? 0,
                    runFramerate: re?.runFramerate ?? 0,
                    took: Math.round(performance.now() - t0),
                };
            }
            if (walkSettled && runSettled) {
                return { ok: false, reason: "no walk OR run cycle in MotionTable" };
            }
            await new Promise(r => setTimeout(r, 250));
        }
        const re = window.liveScene?.liveSpriteMap?.get(cacheKey);
        return {
            ok: false,
            reason: "timeout",
            cycleBakeStarted: re?.cycleBakeStarted,
            walkFramesType: typeof re?.walkFrames,
            runFramesType: typeof re?.runFrames,
        };
    }, { g: target.guid });
    console.log("[walk-capture] walk-bake result:", JSON.stringify(walkBakeOk, null, 2));

    // Camera close-up on monster + hide static layer.
    const cameraInfo = await page.evaluate((g) => {
        const c = document.getElementById("canvas");
        c.width = 480; c.height = 480;
        if (window.liveScene?.app?.renderer) window.liveScene.app.renderer.resize(480, 480);
        const entry = window.entityMap?.get(g);
        if (!entry?.sprite || !window.liveScene?.cameraContainer) return null;
        const wc = window.liveScene.worldContainer;
        if (wc) for (const child of wc.children) {
            if (child !== window.liveScene.entityContainer) child.visible = false;
        }
        const cam = window.liveScene.cameraContainer;
        const target = 100.0;
        cam.scale.set(target, target);
        cam.position.set(240 - entry.sprite.x * target, 240 + entry.sprite.y * target);
        return { wx: entry.sprite.x, wy: entry.sprite.y, target };
    }, target.guid);
    console.log("[walk-capture] camera:", JSON.stringify(cameraInfo));
    await page.waitForTimeout(500);

    // Single first-frame capture for the cleanest comparison shot.
    if (walkBakeOk.ok) {
        await page.evaluate(() => window.updateNameplatePositions?.());
        await page.waitForTimeout(150);
        await page.locator("#canvas").screenshot({ path: SINGLE_PATH });
        console.log(`[walk-capture] wrote single-frame: ${SINGLE_PATH}`);
    }

    // 6-frame strip: take a screenshot every STRIP_FRAME_INTERVAL_MS,
    // then composite via sharp if available, else just save
    // sequentially numbered files.
    console.log(`[walk-capture] capturing ${STRIP_FRAME_COUNT}-frame strip @ ${STRIP_FRAME_INTERVAL_MS}ms intervals`);
    const frameBuffers = [];
    for (let i = 0; i < STRIP_FRAME_COUNT; i++) {
        await page.evaluate(() => window.updateNameplatePositions?.());
        await page.waitForTimeout(STRIP_FRAME_INTERVAL_MS);
        const buf = await page.locator("#canvas").screenshot();
        frameBuffers.push(buf);
        console.log(`[walk-capture] captured frame ${i}, ${buf.length} bytes`);
    }

    // Try to composite with sharp; fall back to per-frame files.
    let sharp = null;
    try { sharp = require("sharp"); } catch (e) {}
    if (sharp) {
        try {
            const composites = frameBuffers.map((buf, i) => ({
                input: buf, top: 0, left: i * 480,
            }));
            await sharp({
                create: {
                    width: STRIP_FRAME_COUNT * 480,
                    height: 480,
                    channels: 4,
                    background: { r: 0, g: 0, b: 0, alpha: 1 },
                },
            }).composite(composites).png().toFile(STRIP_PATH);
            console.log(`[walk-capture] wrote strip via sharp: ${STRIP_PATH}`);
        } catch (e) {
            console.warn("[walk-capture] sharp compose failed:", e.message);
            sharp = null;
        }
    }
    if (!sharp) {
        // Save per-frame files as fallback. The user can stitch
        // manually or we can re-run with sharp installed later.
        const fs = require("node:fs");
        for (let i = 0; i < frameBuffers.length; i++) {
            const p = STRIP_PATH.replace(".png", `-f${i}.png`);
            fs.writeFileSync(p, frameBuffers[i]);
            console.log(`[walk-capture] wrote frame ${i}: ${p}`);
        }
    }

    await browser.close();
    console.log("[walk-capture] done");
})().catch((err) => {
    console.error("[walk-capture] failed:", err);
    process.exit(1);
});
