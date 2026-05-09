// Phase 4 step 6 player validation: drive the live ACE stack, find
// the LOCAL player in entityMap (matched against window.getLocalPlayerGuid),
// probe substitution counts, capture close-up + walking strip.
//
// Goal: confirm Player.cs inherits Creature.CalculateObjDesc() so the
// same Phase A/B/C/Tier 2 pipeline fires for players as for NPCs +
// monsters — without any player-specific code in the browser. ACE
// ships ObjectCreate for the local player with the composed ObjDesc
// (per Player_Networking.cs:224 — `EnqueueSend(PlayerCreate(Guid),
// CreateObject(this))`); the recv loop's ObjectCreate arm already
// extracts model_changes/texture_changes/sub_palettes the same way.
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
    const CLOSEUP_PATH   = path.join(OUT_DIR, "phase-4-step-6-player.png");
    const OVERVIEW_PATH  = path.join(OUT_DIR, "phase-4-step-6-player-overview.png");
    const WALK_FRAME_DIR = path.join(OUT_DIR);
    const POST_TELEPORT_DRAIN_MS = 8_000;
    const SETTLE_MS = 6_000;
    const STRIP_FRAME_COUNT = 6;
    const STRIP_FRAME_INTERVAL_MS = 130;

    console.log(`[player-capture] launching → ${PAGE_URL}`);
    const browser = await chromium.launch({ args: ["--use-gl=swiftshader"] });
    const context = await browser.newContext({ viewport: { width: 1280, height: 1024 } });
    const page = await context.newPage();
    page.setDefaultTimeout(180_000);
    page.on("pageerror", (err) => console.error("[pageerror]", err.message));
    page.on("console", (msg) => {
        const t = msg.text();
        if (/walk-bake|error|warn/i.test(t)) console.log(`[browser ${msg.type()}] ${t}`);
    });

    await page.goto(PAGE_URL, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() =>
        /PASS/.test(document.getElementById("results")?.innerHTML || ""),
        { timeout: 60_000 });
    console.log("[player-capture] in-page smoke checks PASS");

    await page.fill('input[name="account"]', ACCOUNT);
    await page.fill('input[name="password"]', PASSWORD);
    await page.fill('input[name="bridge_url"]', BRIDGE_URL);
    await page.fill('input[name="server_host"]', SERVER_IP);
    await page.fill('input[name="server_port"]', SERVER_PORT);
    // Wait for the Connect button to enable (post-fbbe773 the button
    // is disabled+"Loading…" until the JS submit handler is wired).
    await page.waitForFunction(() => {
        const b = document.querySelector('#login-form button[type=submit]');
        return b && !b.disabled;
    }, { timeout: 30_000 });
    await page.click('#login-form button[type=submit]');
    await page.waitForSelector("#selection:not([hidden])", { timeout: 30_000 });
    await page.waitForTimeout(500);

    if ((await page.locator('#character-ul button[data-id]').count()) === 0) {
        const charName = `PlayDemo${Date.now().toString(36).slice(-6)}`;
        console.log(`[player-capture] creating character ${charName}`);
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
    console.log("[player-capture] EnteredWorld; waiting for liveScene to be ready");
    // liveScene only exists after renderHoltburg's renderNeighbourhood
    // completes. On a fresh boot that takes ~10s. Until then,
    // ensureEntitySprite returns null and Spawns are dropped — which
    // is the ROOT CAUSE of "local player not in entityMap": their
    // Spawn arrives before liveScene is set, and the JS-side drainer
    // can't add them to the map.
    await page.waitForFunction(
        () => Boolean(window.liveScene?.entityContainer),
        { timeout: 60_000 }
    );
    console.log("[player-capture] liveScene ready; waiting another 5s for any deferred local-player spawn");
    await page.waitForTimeout(5_000);

    // Dump entityMap state for debugging — what GUIDs are present
    // and is localPlayerGuid among them?
    const dump = await page.evaluate(() => {
        const lpg = window.getLocalPlayerGuid?.();
        const total = window.entityMap?.size ?? 0;
        const entries = [];
        if (window.entityMap) {
            for (const [guid, entry] of window.entityMap.entries()) {
                entries.push({
                    guid: `0x${guid.toString(16).toUpperCase().padStart(8, "0")}`,
                    wcid: entry.meta?.wcid,
                    name: entry.meta?.name,
                    kind: entry.kind,
                    mc: entry.meta?.modelChanges?.length || 0,
                    tc: entry.meta?.textureChanges?.length || 0,
                    sp: entry.meta?.subPalettes?.length || 0,
                });
            }
        }
        return {
            lpg: lpg ? `0x${lpg.toString(16).toUpperCase().padStart(8, "0")}` : null,
            total,
            entries,
        };
    });
    console.log(`[player-capture] entityMap dump (lpg=${dump.lpg}, total=${dump.total}):`);
    for (const e of dump.entries) {
        const star = e.guid === dump.lpg ? " ←LOCAL" : "";
        console.log(`    ${e.guid} wcid=${e.wcid} kind=${e.kind} mc=${e.mc} tc=${e.tc} sp=${e.sp} name="${e.name}"${star}`);
    }

    console.log("[player-capture] now teleporting to Holtburg");
    await page.click("#teleport-button");
    await page.waitForTimeout(POST_TELEPORT_DRAIN_MS);

    // Find the local player by guid match. localPlayerGuid is set by
    // the kind=1 PlayerSpawned handler at index.html:3032; expose
    // hook is window.getLocalPlayerGuid().
    const probe = await page.evaluate(() => {
        const lpg = window.getLocalPlayerGuid?.();
        if (lpg === null || lpg === undefined) return { error: "localPlayerGuid not set" };
        const entry = window.entityMap?.get(lpg >>> 0);
        if (!entry) return { error: `entityMap has no entry for guid 0x${lpg.toString(16)}`, lpg: `0x${lpg.toString(16)}`, entityMapSize: window.entityMap?.size };
        const m = entry.meta || {};
        return {
            guid: lpg,
            modelId: entry.modelId ? `0x${entry.modelId.toString(16).padStart(8, "0").toUpperCase()}` : null,
            kind: entry.kind,
            name: m.name,
            wcid: m.wcid,
            paletteId: m.paletteId ? `0x${m.paletteId.toString(16).padStart(8, "0").toUpperCase()}` : null,
            mtableId: m.mtableId ? `0x${m.mtableId.toString(16).padStart(8, "0").toUpperCase()}` : null,
            modelChangesCount: m.modelChanges?.length ?? 0,
            textureChangesCount: m.textureChanges?.length ?? 0,
            subPalettesCount: m.subPalettes?.length ?? 0,
            hasSubstitutions: m.hasSubstitutions,
            spritePos: entry.sprite ? { x: entry.sprite.x, y: entry.sprite.y } : null,
            objScale: m.objScale,
            itemType: m.itemType ? `0x${m.itemType.toString(16)}` : null,
        };
    });
    console.log("[player-capture] local-player probe:");
    console.log(JSON.stringify(probe, null, 2));

    if (probe.error) {
        console.error("[player-capture] bailing:", probe.error);
        await browser.close();
        process.exit(1);
    }

    // Wait for the on-demand model fetch + walk-frame bake. The
    // local player has full substitutions so will go through the
    // entity-render path same as a Royal Guard.
    console.log(`[player-capture] waiting up to ${SETTLE_MS}ms for sprite + walk frames...`);
    const ready = await page.evaluate(async ({ g, settleMs }) => {
        const t0 = performance.now();
        while (performance.now() - t0 < settleMs) {
            const e = window.entityMap?.get(g);
            if (e?.kind === "sprite") {
                // Force-kick the walk-bake so we can capture cycling.
                const cacheKey = window.computeEntitySpriteKey(e.modelId, e.meta);
                window.kickWalkFrameBakeIfNeeded(cacheKey, e.modelId, e.meta);
                e.speedMps = 5.0;
            }
            const re = window.liveScene?.liveSpriteMap?.get(
                window.computeEntitySpriteKey(window.entityMap.get(g).modelId, window.entityMap.get(g).meta)
            );
            if (re?.walkFrames?.length > 0) {
                return { ok: true, frameCount: re.walkFrames.length, took: Math.round(performance.now() - t0) };
            }
            await new Promise(r => setTimeout(r, 250));
        }
        return { ok: false };
    }, { g: probe.guid, settleMs: SETTLE_MS });
    console.log("[player-capture] readiness:", JSON.stringify(ready));

    // Close-up capture.
    console.log("[player-capture] resizing canvas + zooming on local player + hiding statics");
    await page.evaluate((g) => {
        const c = document.getElementById("canvas");
        c.width = 480; c.height = 480;
        if (window.liveScene?.app?.renderer) window.liveScene.app.renderer.resize(480, 480);
        const entry = window.entityMap?.get(g);
        if (!entry?.sprite || !window.liveScene?.cameraContainer) return;
        const wc = window.liveScene.worldContainer;
        if (wc) for (const child of wc.children) {
            if (child !== window.liveScene.entityContainer) child.visible = false;
        }
        const cam = window.liveScene.cameraContainer;
        cam.scale.set(100.0, 100.0);
        cam.position.set(240 - entry.sprite.x * 100.0, 240 + entry.sprite.y * 100.0);
    }, probe.guid);
    await page.waitForTimeout(500);
    await page.evaluate(() => window.updateNameplatePositions?.());
    await page.waitForTimeout(300);
    console.log(`[player-capture] writing close-up → ${CLOSEUP_PATH}`);
    await page.locator("#canvas").screenshot({ path: CLOSEUP_PATH });

    // Walk-cycle strip (only meaningful if walkFrames populated).
    if (ready.ok) {
        console.log(`[player-capture] capturing ${STRIP_FRAME_COUNT}-frame strip`);
        for (let i = 0; i < STRIP_FRAME_COUNT; i++) {
            await page.waitForTimeout(STRIP_FRAME_INTERVAL_MS);
            await page.evaluate(() => window.updateNameplatePositions?.());
            const p = path.join(WALK_FRAME_DIR, `phase-4-step-6-player-walking-f${i}.png`);
            await page.locator("#canvas").screenshot({ path: p });
            console.log(`[player-capture]   frame ${i}: ${p}`);
        }
    } else {
        console.warn("[player-capture] walk frames not ready in time; skipping strip");
    }

    // Overview at 8 px/m with statics restored.
    console.log("[player-capture] restoring static layer + overview");
    await page.evaluate((g) => {
        const c = document.getElementById("canvas");
        c.width = 1280; c.height = 1280;
        if (window.liveScene?.app?.renderer) window.liveScene.app.renderer.resize(1280, 1280);
        const wc = window.liveScene?.worldContainer;
        if (wc) for (const child of wc.children) child.visible = true;
        const entry = window.entityMap?.get(g);
        if (!entry?.sprite || !window.liveScene?.cameraContainer) return;
        const cam = window.liveScene.cameraContainer;
        cam.scale.set(8.0, 8.0);
        cam.position.set(640 - entry.sprite.x * 8.0, 640 + entry.sprite.y * 8.0);
    }, probe.guid);
    await page.waitForTimeout(400);
    await page.evaluate(() => window.updateNameplatePositions?.());
    await page.waitForTimeout(200);
    console.log(`[player-capture] writing overview → ${OVERVIEW_PATH}`);
    await page.locator("#canvas").screenshot({ path: OVERVIEW_PATH });

    await browser.close();
    console.log("[player-capture] done");
})().catch((err) => {
    console.error("[player-capture] failed:", err);
    process.exit(1);
});
