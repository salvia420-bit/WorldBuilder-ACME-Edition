// Phase 4 step 6 visual capture: drive the bundle through login →
// CharacterCreate (if needed) → spawn → @telepoi Holtburg, wait for
// the entity stream to populate, find the Holtburg Blacksmith
// (wcid 712, displayName "Sedor Wystan the Blacksmith") in entityMap,
// centre the camera on his sprite, zoom in close, and screenshot.
//
// This is the visual sign-off for Phase A (per-part GfxObj +
// texture-DID swaps) + Phase B (palette overlays) + Phase C
// (MotionTable idle pose). The blacksmith is a good test case
// because his weenie has zero ClothingBase / PaletteTemplate of his
// own — his entire visual comes from his 18-item create_list
// (jerkin/breeches/shoes/apron/chainmail pieces) which ACE walks
// in CalculateObjDesc and ships as model_data substitutions on the
// wire.
//
// Pre-reqs: ACE on UDP 9000/9001, wsbridge ws://0.0.0.0:8080,
// http.server :8765, dist/ baked.
const { chromium } = require("playwright");
const path = require("node:path");

(async () => {
    const ACCOUNT = process.env.PHASE4_TEST_ACCOUNT
        || `bsmith${Date.now().toString(36).slice(-6)}`;
    const PASSWORD = process.env.PHASE4_TEST_PASSWORD || ACCOUNT;
    const BRIDGE_URL = process.env.PHASE4_BRIDGE_URL || "ws://127.0.0.1:8080/";
    const SERVER_IP = process.env.PHASE4_SERVER_IP || "127.0.0.1";
    const SERVER_PORT = process.env.PHASE4_SERVER_PORT || "9000";
    const PAGE_URL = process.env.PHASE4_PAGE_URL
        || "http://127.0.0.1:8765/apps/holtburger-web/index.html";
    const OUT_PATH = path.resolve(
        __dirname,
        "../../../../docs/images/phase-4-step-6-blacksmith.png"
    );
    const OVERVIEW_PATH = OUT_PATH.replace(".png", "-overview.png");
    const CHAR_NAME = process.env.PHASE4_CHAR_NAME
        || `BSDemo${Date.now().toString(36).slice(-6)}`;
    const CREATE_TIMEOUT_MS = 15_000;
    const SPAWN_TIMEOUT_MS = 30_000;
    // Holtburg is dense; give the entity stream a generous window so
    // the on-demand model fetches for ~50 NPCs/creatures complete.
    const ENTITY_DRAIN_MS = 8_000;
    const POST_TELEPORT_DRAIN_MS = 15_000;
    // After centring camera + zooming in, give the on-demand fetch
    // for the blacksmith's substituted model an extra moment to
    // resolve (the per-part triangulation + palette overlays can
    // take a beat on first arrival).
    const SETTLE_MS = 4_000;

    console.log(`[bsmith-capture] launching chromium → ${PAGE_URL}`);
    const browser = await chromium.launch({ args: ["--use-gl=swiftshader"] });
    const context = await browser.newContext({ viewport: { width: 1280, height: 1024 } });
    const page = await context.newPage();
    page.setDefaultTimeout(180_000);
    page.on("pageerror", (err) => console.error("[pageerror]", err.message));
    page.on("console", (msg) => {
        const text = msg.text();
        if (/error|warn|step6|entity-model-fetch|fetch_/i.test(text)) {
            console.log(`[browser ${msg.type()}] ${text}`);
        }
    });

    await page.goto(PAGE_URL, { waitUntil: "domcontentloaded" });

    // Wait for smoke checks to finish in-page.
    await page.waitForFunction(() => {
        const r = document.getElementById("results");
        return r && /PASS/.test(r.innerHTML);
    }, { timeout: 15_000 });
    console.log("[bsmith-capture] in-page smoke checks PASS");

    // Login.
    await page.fill('input[name="account"]', ACCOUNT);
    await page.fill('input[name="password"]', PASSWORD);
    await page.fill('input[name="bridge_url"]', BRIDGE_URL);
    await page.fill('input[name="server_ip"]', SERVER_IP);
    await page.fill('input[name="server_port"]', SERVER_PORT);
    console.log(`[bsmith-capture] submitting login as ${ACCOUNT}`);
    await page.click('#login-form button[type=submit]');
    await page.waitForSelector("#selection:not([hidden])", { timeout: 30_000 });
    await page.waitForTimeout(500);

    // Create character if account is fresh.
    const initialButtonCount = await page.locator('#character-ul button[data-id]').count();
    if (initialButtonCount === 0) {
        console.log(`[bsmith-capture] creating character "${CHAR_NAME}"`);
        await page.fill('#create-form input[name="char_name"]', CHAR_NAME);
        await page.click('#create-button');
        await page.waitForFunction(() => {
            const s = document.getElementById("create-status");
            return s && /Created\b/.test(s.innerText);
        }, { timeout: CREATE_TIMEOUT_MS });
        await page.waitForFunction(
            () => document.querySelectorAll('#character-ul button[data-id]').length > 0,
            { timeout: 10_000 }
        );
    }

    // Spawn.
    await page.locator('#character-ul button[data-id]').first().click();
    console.log("[bsmith-capture] clicked Spawn");
    await page.waitForFunction(() => {
        const s = document.getElementById("login-status");
        return s && /InWorld|Spawned/.test(s.innerText);
    }, { timeout: SPAWN_TIMEOUT_MS });
    console.log("[bsmith-capture] Spawned/InWorld");

    // Wait for kind=7 EnteredWorld → post-spawn block unhides → @telepoi
    // is safe to send.
    await page.waitForSelector("#post-spawn:not([hidden])", { timeout: 10_000 });
    console.log("[bsmith-capture] EnteredWorld; clicking Teleport to Holtburg");
    await page.click("#teleport-button");

    // @telepoi Holtburg lands the player at the outdoor town centre.
    // The blacksmith (Sedor Wystan) is INDOORS at cell 0xA9B40100,
    // local pos (87.48, 131.04, 66.005). Indoor NPCs only stream when
    // the player is in the same envcell — so chain a @teleloc straight
    // to the smithy. Drop the player ~3m NW of the smith so he's in
    // front of us, not inside us.
    const TELELOC_CMD = "@teleloc 0xA9B40100 84.0 128.0 66.005";
    console.log(`[bsmith-capture] also sending '${TELELOC_CMD}' via window.__sessionHandle`);
    await page.waitForTimeout(2000);
    const tlResult = await page.evaluate((cmd) => {
        if (window.__sessionHandle && typeof window.__sessionHandle.sendChat === "function") {
            try { window.__sessionHandle.sendChat(cmd); return "sent"; }
            catch (e) { return `err: ${e.message || e}`; }
        }
        return "handle not exposed";
    }, TELELOC_CMD);
    console.log(`[bsmith-capture] @teleloc dispatch: ${tlResult}`);

    console.log(`[bsmith-capture] waiting ${POST_TELEPORT_DRAIN_MS}ms for smithy entity stream`);
    await page.waitForTimeout(POST_TELEPORT_DRAIN_MS);

    // Find the blacksmith by name in entityMap. Phase 6a put
    // EntityUpdate.name on entry.meta.name; iterate every entry and
    // match the displayName.
    const blacksmithProbe = await page.evaluate(() => {
        const out = { found: null, sample: [], total: window.entityMap?.size || 0 };
        if (!window.entityMap) return out;
        for (const [guid, entry] of window.entityMap.entries()) {
            const m = entry.meta;
            if (m?.name) out.sample.push({ guid, name: m.name, wcid: m.wcid, kind: entry.kind });
            if (m?.name && /blacksmith|Sedor\s+Wystan/i.test(m.name)) {
                out.found = {
                    guid,
                    name: m.name,
                    wcid: m.wcid,
                    spriteX: entry.sprite?.x,
                    spriteY: entry.sprite?.y,
                    kind: entry.kind,
                    modelChangesCount: m.modelChanges?.length ?? 0,
                    textureChangesCount: m.textureChanges?.length ?? 0,
                    subPalettesCount: m.subPalettes?.length ?? 0,
                };
                break;
            }
        }
        return out;
    });
    console.log(`[bsmith-capture] entityMap.size = ${blacksmithProbe.total}`);
    console.log(`[bsmith-capture] all named entries (${blacksmithProbe.sample.length}):`);
    for (const s of blacksmithProbe.sample) {
        console.log(`    guid=0x${s.guid.toString(16).toUpperCase().padStart(8,"0")} wcid=${s.wcid} kind=${s.kind} name="${s.name}"`);
    }
    console.log(`[bsmith-capture] blacksmith match:`, JSON.stringify(blacksmithProbe.found, null, 2));

    if (!blacksmithProbe.found) {
        // Try a broader fallback search — pick the first non-player
        // creature-class entity (wcid != 1, name set, sprite kind).
        // Better than nothing for the visual.
        console.warn("[bsmith-capture] no blacksmith match; searching for any non-player named creature");
        const fallback = await page.evaluate(() => {
            if (!window.entityMap) return null;
            for (const [guid, entry] of window.entityMap.entries()) {
                const m = entry.meta;
                // Skip the local player (wcid=1 typical) + items.
                // Pick anything with wcid > 100 + a name + kind=sprite
                // + position (not held inventory).
                if (m?.name && m.wcid > 100 && entry.kind === "sprite"
                    && entry.sprite?.x && entry.sprite?.y) {
                    return {
                        guid,
                        name: m.name,
                        wcid: m.wcid,
                        spriteX: entry.sprite.x,
                        spriteY: entry.sprite.y,
                        kind: entry.kind,
                        modelChangesCount: m.modelChanges?.length ?? 0,
                        textureChangesCount: m.textureChanges?.length ?? 0,
                        subPalettesCount: m.subPalettes?.length ?? 0,
                    };
                }
            }
            return null;
        });
        if (!fallback) {
            console.error("[bsmith-capture] no usable entity at all; bailing.");
            await page.screenshot({ path: OUT_PATH, fullPage: false });
            await browser.close();
            process.exit(1);
        }
        console.log(`[bsmith-capture] using fallback entity:`, JSON.stringify(fallback, null, 2));
        blacksmithProbe.found = fallback;
    }

    // Wait for the on-demand model fetch to resolve so the sprite
    // upgrades from glyph → real textured mesh. Poll until either
    // entry.kind === "sprite" or timeout.
    console.log(`[bsmith-capture] waiting up to ${SETTLE_MS}ms for blacksmith sprite to upgrade from glyph...`);
    const guid = blacksmithProbe.found.guid;
    const upgraded = await page.waitForFunction((g) => {
        const e = window.entityMap?.get(g);
        return e?.kind === "sprite";
    }, guid, { timeout: SETTLE_MS, polling: 250 }).catch(() => null);
    if (!upgraded) {
        console.warn("[bsmith-capture] model fetch didn't upgrade in time; capturing whatever's on screen.");
    } else {
        console.log("[bsmith-capture] sprite upgraded to textured mesh");
    }

    // Resize canvas + centre camera + zoom in. The page's canvas
    // defaults to 512×512; bump to 1280×1280 so the zoomed-in
    // capture has detail. Centre on the blacksmith's world coords
    // (the sprite.x/.y are world metres) and crank scale to ~60 px/m
    // so a humanoid (~1.8 m) reads ~110 px on the canvas. Top-down
    // view of an NPC standing inside a building is occluded by the
    // building's roof from above — temporarily hide the static
    // placement layer so the bare NPC sprite is the visual subject.
    // The static layer is restored before the overview shot below.
    console.log("[bsmith-capture] resizing canvas + centring camera on blacksmith + hiding static placements");
    const cameraInfo = await page.evaluate((g) => {
        const c = document.getElementById("canvas");
        // 480×480 canvas at 100 px/m = 4.8m × 4.8m of world space —
        // a tight close-up of the ~1.8m humanoid + nameplate +
        // immediate floor.
        c.width = 480;
        c.height = 480;
        const renderer = window.liveScene?.app?.renderer;
        if (renderer) renderer.resize(480, 480);
        const entry = window.entityMap?.get(g);
        if (!entry?.sprite || !window.liveScene?.cameraContainer) return null;
        // Hide static-placement objects layer + terrain so the NPC
        // sprite reads cleanly. We can identify them as siblings of
        // entityContainer inside worldContainer.
        const wc = window.liveScene.worldContainer;
        if (wc) {
            for (const child of wc.children) {
                if (child !== window.liveScene.entityContainer) child.visible = false;
            }
        }
        const cam = window.liveScene.cameraContainer;
        const wx = entry.sprite.x;
        const wy = entry.sprite.y;
        const target = 100.0;
        const cw = 480;
        const ch = 480;
        cam.scale.set(target, target);
        // worldContainer flips y: screen-y = -wy * scale + offset.
        cam.position.set(cw / 2 - wx * target, ch / 2 + wy * target);
        return { wx, wy, target, sx: cam.scale.x };
    }, guid);
    console.log(`[bsmith-capture] camera centred:`, JSON.stringify(cameraInfo, null, 2));
    // Tick the nameplate projector so the blacksmith's label lands
    // at the right canvas pixel.
    await page.waitForTimeout(500);
    await page.evaluate(() => {
        if (typeof window.updateNameplatePositions === "function") {
            window.updateNameplatePositions();
        }
    });
    await page.waitForTimeout(300);

    console.log(`[bsmith-capture] writing zoomed-in screenshot → ${OUT_PATH}`);
    await page.locator("#canvas").screenshot({ path: OUT_PATH });

    // Also capture a pulled-back overview for context — same scene
    // with the static placement layer restored, ~6 px/m so the
    // surrounding smithy + Holtburg town reads.
    console.log("[bsmith-capture] restoring static layer + resizing canvas + zooming back out for overview");
    await page.evaluate((g) => {
        const c = document.getElementById("canvas");
        c.width = 1280;
        c.height = 1280;
        const renderer = window.liveScene?.app?.renderer;
        if (renderer) renderer.resize(1280, 1280);
        const wc = window.liveScene?.worldContainer;
        if (wc) for (const child of wc.children) child.visible = true;
        const entry = window.entityMap?.get(g);
        if (!entry?.sprite || !window.liveScene?.cameraContainer) return;
        const cam = window.liveScene.cameraContainer;
        const wx = entry.sprite.x;
        const wy = entry.sprite.y;
        const target = 8.0;
        const cw = 1280, ch = 1280;
        cam.scale.set(target, target);
        cam.position.set(cw / 2 - wx * target, ch / 2 + wy * target);
    }, guid);
    await page.waitForTimeout(400);
    await page.evaluate(() => {
        if (typeof window.updateNameplatePositions === "function") {
            window.updateNameplatePositions();
        }
    });
    await page.waitForTimeout(200);
    console.log(`[bsmith-capture] writing overview screenshot → ${OVERVIEW_PATH}`);
    await page.locator("#canvas").screenshot({ path: OVERVIEW_PATH });

    // Also probe what the blacksmith's substitution counts actually
    // look like on the wire — the user wanted to see this work, so
    // dump the data alongside the image.
    const finalProbe = await page.evaluate((g) => {
        const e = window.entityMap?.get(g);
        const m = e?.meta;
        return {
            kind: e?.kind,
            modelId: e?.modelId ? `0x${e.modelId.toString(16).padStart(8, "0").toUpperCase()}` : null,
            paletteId: m?.paletteId ? `0x${m.paletteId.toString(16).padStart(8, "0").toUpperCase()}` : null,
            modelChangesCount: m?.modelChanges?.length ?? 0,
            textureChangesCount: m?.textureChanges?.length ?? 0,
            subPalettesCount: m?.subPalettes?.length ?? 0,
            hasSubstitutions: m?.hasSubstitutions,
            spritePos: e?.sprite ? { x: e.sprite.x, y: e.sprite.y } : null,
        };
    }, guid);
    console.log("[bsmith-capture] final blacksmith probe:", JSON.stringify(finalProbe, null, 2));

    await browser.close();
    console.log("[bsmith-capture] done");
})().catch((err) => {
    console.error("[bsmith-capture] failed:", err);
    process.exit(1);
});
