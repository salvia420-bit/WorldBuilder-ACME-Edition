// Phase 4 step 6 monster validation: drive the bundle through login →
// spawn → @teleloc to a known monster spawn area → wait for the entity
// stream → find any creature (Banderling, Drudge, Mountain Rat, etc.)
// → centre camera + zoom in → screenshot.
//
// Goal: confirm Phase A/B/C generalizes to monsters with no new code.
// The substitution counts in the probe tell us:
// - non-zero model_changes/texture_changes/sub_palettes = ACE shipped
//   composition data and our pipeline applied it (same as the
//   blacksmith capture)
// - zero everywhere = ACE didn't compose for this monster (a naked
//   creature with no clothing/palette overrides — Phase A's
//   hasSubstitutions gate routes through the unsubstituted path,
//   which still renders correctly via fetch_model_meshes)
//
// Either outcome is a pass for "monsters render correctly". The
// distinction matters for the animation tier proposal that follows.
//
// Target: landblock 0xA0B5 (one south of Holtburg) outdoor cell
// 0xA0B50000, where the world DB has banderlingblade + ratmountain
// + drudgehighslave spawns within ~50m of each other.
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
    const OUT_PATH = path.resolve(
        __dirname,
        "../../../../docs/images/phase-4-step-6-monster.png"
    );
    const OVERVIEW_PATH = OUT_PATH.replace(".png", "-overview.png");
    const CHAR_NAME = process.env.PHASE4_CHAR_NAME
        || `MonDemo${Date.now().toString(36).slice(-6)}`;
    // 0xA0B50000 = outdoor surface cell of landblock 0xA0B5. Drop
    // the player at (110, 80, 76) — between the banderling cluster
    // at (~108, 60) and the rat spawn at (~171, 145).
    const TELELOC_TARGET = process.env.PHASE4_TELELOC_TARGET
        || "@teleloc 0xA0B50000 110 80 78.0";
    const POST_TELEPORT_DRAIN_MS = 15_000;
    const SETTLE_MS = 4_000;

    console.log(`[mon-capture] launching chromium → ${PAGE_URL}`);
    const browser = await chromium.launch({ args: ["--use-gl=swiftshader"] });
    const context = await browser.newContext({ viewport: { width: 1280, height: 1024 } });
    const page = await context.newPage();
    page.setDefaultTimeout(180_000);
    page.on("pageerror", (err) => console.error("[pageerror]", err.message));
    page.on("console", (msg) => {
        const text = msg.text();
        if (/error|warn|step6|entity-model-fetch/i.test(text)) {
            console.log(`[browser ${msg.type()}] ${text}`);
        }
    });

    await page.goto(PAGE_URL, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => {
        const r = document.getElementById("results");
        return r && /PASS/.test(r.innerHTML);
    }, { timeout: 15_000 });
    console.log("[mon-capture] in-page smoke checks PASS");

    await page.fill('input[name="account"]', ACCOUNT);
    await page.fill('input[name="password"]', PASSWORD);
    await page.fill('input[name="bridge_url"]', BRIDGE_URL);
    await page.fill('input[name="server_ip"]', SERVER_IP);
    await page.fill('input[name="server_port"]', SERVER_PORT);
    console.log(`[mon-capture] submitting login as ${ACCOUNT}`);
    await page.click('#login-form button[type=submit]');
    await page.waitForSelector("#selection:not([hidden])", { timeout: 30_000 });
    await page.waitForTimeout(500);

    const initialButtonCount = await page.locator('#character-ul button[data-id]').count();
    if (initialButtonCount === 0) {
        console.log(`[mon-capture] creating character "${CHAR_NAME}"`);
        await page.fill('#create-form input[name="char_name"]', CHAR_NAME);
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
    console.log("[mon-capture] clicked Spawn");
    await page.waitForFunction(() => {
        const s = document.getElementById("login-status");
        return s && /InWorld|Spawned/.test(s.innerText);
    }, { timeout: 30_000 });
    await page.waitForSelector("#post-spawn:not([hidden])", { timeout: 10_000 });
    console.log("[mon-capture] EnteredWorld; clicking Teleport to Holtburg first");
    await page.click("#teleport-button");
    await page.waitForTimeout(2000);

    console.log(`[mon-capture] sending '${TELELOC_TARGET}' to monster spawn area`);
    const tlResult = await page.evaluate((cmd) => {
        if (window.__sessionHandle?.sendChat) {
            try { window.__sessionHandle.sendChat(cmd); return "sent"; }
            catch (e) { return `err: ${e.message || e}`; }
        }
        return "handle not exposed";
    }, TELELOC_TARGET);
    console.log(`[mon-capture] @teleloc dispatch: ${tlResult}`);
    console.log(`[mon-capture] waiting ${POST_TELEPORT_DRAIN_MS}ms for monster entity stream`);
    await page.waitForTimeout(POST_TELEPORT_DRAIN_MS);

    // Find any monster — match against the canonical creature names.
    // Skip humanoid NPCs (which we already validated with the
    // blacksmith capture).
    // Pick the BEST monster by substitution-count score, not the
    // first match. NPCs from earlier landblocks are still in
    // entityMap (accumulated during teleport chain); we want the
    // monster with the richest model_data composition for a
    // visually-clear Phase A/B demo. Prefer Drudge Slave (mc=10
    // typically) over Banderling (mc=0); fall back to anything that
    // matches the monster pattern with sprite + position.
    const monsterProbe = await page.evaluate(() => {
        const out = { found: null, total: window.entityMap?.size || 0, all: [] };
        if (!window.entityMap) return out;
        const monsterPattern = /drudge|tumerok|banderling|tusker|olthoi|gromnie|skeleton|zombie|mosswart|reedshark|^rat\b|mountain rat|virindi|bunny|cow|chicken|pig|deer|wasp|monouga|carenzi|shallows|lugian|knath|grievver|ursuin|moarsman|niffis|aerbax|golem/i;
        let best = null;
        for (const [guid, entry] of window.entityMap.entries()) {
            const m = entry.meta;
            if (!m?.name) continue;
            const mc = m.modelChanges?.length || 0;
            const tc = m.textureChanges?.length || 0;
            const sp = m.subPalettes?.length || 0;
            out.all.push({ guid, name: m.name, wcid: m.wcid, kind: entry.kind, mc, tc, sp });
            if (!monsterPattern.test(m.name)) continue;
            if (!entry.sprite?.x || !entry.sprite?.y) continue;
            if (entry.kind !== "sprite") continue;
            const score = mc + tc + sp;
            if (!best || score > best.score) {
                best = {
                    guid, score,
                    name: m.name,
                    wcid: m.wcid,
                    spriteX: entry.sprite.x,
                    spriteY: entry.sprite.y,
                    kind: entry.kind,
                    modelChangesCount: mc,
                    textureChangesCount: tc,
                    subPalettesCount: sp,
                    paletteId: m.paletteId,
                    objScale: m.objScale,
                };
            }
        }
        out.found = best;
        return out;
    });
    console.log(`[mon-capture] entityMap.size = ${monsterProbe.total}`);
    console.log(`[mon-capture] all named entries (${monsterProbe.all.length}):`);
    for (const s of monsterProbe.all) {
        console.log(`    guid=0x${s.guid.toString(16).toUpperCase().padStart(8,"0")} wcid=${s.wcid} kind=${s.kind} mc=${s.mc} tc=${s.tc} sp=${s.sp} name="${s.name}"`);
    }
    console.log(`[mon-capture] monster match:`, JSON.stringify(monsterProbe.found, null, 2));

    if (!monsterProbe.found) {
        console.error("[mon-capture] no monster found in entityMap. Saving overview + bailing.");
        await page.locator("#canvas").screenshot({ path: OVERVIEW_PATH });
        await browser.close();
        process.exit(1);
    }

    const guid = monsterProbe.found.guid;
    console.log(`[mon-capture] waiting up to ${SETTLE_MS}ms for monster sprite to upgrade...`);
    const upgraded = await page.waitForFunction((g) => {
        const e = window.entityMap?.get(g);
        return e?.kind === "sprite";
    }, guid, { timeout: SETTLE_MS, polling: 250 }).catch(() => null);
    if (!upgraded) console.warn("[mon-capture] model fetch didn't upgrade in time");

    // Tight close-up: hide static layer, zoom 100 px/m on 480×480.
    console.log("[mon-capture] resizing canvas + centring camera + hiding statics");
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
        const wx = entry.sprite.x;
        const wy = entry.sprite.y;
        const target = 100.0;
        cam.scale.set(target, target);
        cam.position.set(240 - wx * target, 240 + wy * target);
        return { wx, wy, target };
    }, guid);
    console.log(`[mon-capture] camera:`, JSON.stringify(cameraInfo));
    await page.waitForTimeout(500);
    await page.evaluate(() => window.updateNameplatePositions?.());
    await page.waitForTimeout(300);
    console.log(`[mon-capture] writing close-up → ${OUT_PATH}`);
    await page.locator("#canvas").screenshot({ path: OUT_PATH });

    // Restore + overview at 8 px/m.
    console.log("[mon-capture] writing overview");
    await page.evaluate((g) => {
        const c = document.getElementById("canvas");
        c.width = 1280; c.height = 1280;
        if (window.liveScene?.app?.renderer) window.liveScene.app.renderer.resize(1280, 1280);
        const wc = window.liveScene?.worldContainer;
        if (wc) for (const child of wc.children) child.visible = true;
        const entry = window.entityMap?.get(g);
        if (!entry?.sprite || !window.liveScene?.cameraContainer) return;
        const cam = window.liveScene.cameraContainer;
        const target = 8.0;
        cam.scale.set(target, target);
        cam.position.set(640 - entry.sprite.x * target, 640 + entry.sprite.y * target);
    }, guid);
    await page.waitForTimeout(400);
    await page.evaluate(() => window.updateNameplatePositions?.());
    await page.waitForTimeout(200);
    await page.locator("#canvas").screenshot({ path: OVERVIEW_PATH });

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
        };
    }, guid);
    console.log("[mon-capture] final monster probe:", JSON.stringify(finalProbe, null, 2));

    await browser.close();
    console.log("[mon-capture] done");
})().catch((err) => {
    console.error("[mon-capture] failed:", err);
    process.exit(1);
});
