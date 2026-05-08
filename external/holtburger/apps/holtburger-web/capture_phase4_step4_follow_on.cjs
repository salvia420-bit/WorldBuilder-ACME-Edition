// Phase 4 step 4 follow-on capture script — drives the bundle through
// login → CharacterCreate (if needed) → spawn → @telepoi Holtburg →
// waits for the canonical world-handler dispatcher to fire kind=8
// PlayerStatsUpdated + kind=11 InventoryUpdated events, verifies the
// vitals + inventory DOM panels populate, and screenshots both.
//
// Pre-reqs (see docs/ace-local-setup.md):
// - ACE running headless on UDP 127.0.0.1:9000.
// - holtburger-wsbridge running on ws://127.0.0.1:8080/.
// - python3 -m http.server 8765 from external/holtburger/.
// - Manifest+shards baked under dist/ (init_resource_source consumer).
// - Test account auto-created with accessLevel=4 (Config.js
//   DefaultAccessLevel = 4 covers this).
//
// Run: `node capture_phase4_step4_follow_on.cjs` from
// `apps/holtburger-web/`. Outputs deliverable PNGs to docs/images/.

const { chromium } = require("playwright");
const path = require("node:path");

(async () => {
    const ACCOUNT = process.env.PHASE4_TEST_ACCOUNT
        || `step4f_${Date.now().toString(36).slice(-6)}`;
    const PASSWORD = process.env.PHASE4_TEST_PASSWORD || ACCOUNT;
    const BRIDGE_URL = process.env.PHASE4_BRIDGE_URL || "ws://127.0.0.1:8080/";
    const SERVER_IP = process.env.PHASE4_SERVER_IP || "127.0.0.1";
    const SERVER_PORT = process.env.PHASE4_SERVER_PORT || "9000";
    const PAGE_URL = process.env.PHASE4_PAGE_URL
        || "http://127.0.0.1:8765/apps/holtburger-web/index.html";
    const PANELS_PATH = path.resolve(
        __dirname,
        "../../../../docs/images/phase-4-step-4-follow-on-panels.png"
    );
    const VITALS_PATH = path.resolve(
        __dirname,
        "../../../../docs/images/phase-4-step-4-follow-on-vitals.png"
    );
    const INVENTORY_PATH = path.resolve(
        __dirname,
        "../../../../docs/images/phase-4-step-4-follow-on-inventory.png"
    );
    const CHAR_NAME = process.env.PHASE4_CHAR_NAME
        || `Step4F${Date.now().toString(36).slice(-6)}`;
    const CREATE_TIMEOUT_MS = Number(process.env.PHASE4_CREATE_TIMEOUT_MS || 15_000);
    const SPAWN_TIMEOUT_MS = Number(process.env.PHASE4_SPAWN_TIMEOUT_MS || 15_000);
    const TELEPORT_TIMEOUT_MS = Number(process.env.PHASE4_TELEPORT_TIMEOUT_MS || 5_000);
    // Time to wait after teleport for PlayerDescription / vital
    // updates to land. ACE pushes these unprompted shortly after the
    // teleport completes (the new cell triggers a re-broadcast of
    // the player's full state). Empirically a couple of seconds is
    // enough; bump if running over Tailscale.
    const STATS_DRAIN_MS = Number(process.env.PHASE4_STATS_DRAIN_MS || 6_000);

    console.log(`launching chromium → ${PAGE_URL}`);
    console.log(`account: ${ACCOUNT}, character: ${CHAR_NAME}`);
    const browser = await chromium.launch({
        args: ["--use-gl=swiftshader"],
    });
    const context = await browser.newContext({
        viewport: { width: 1400, height: 1100 },
    });
    const page = await context.newPage();

    // Hook console for debug + capture event-kind traces.
    await page.addInitScript(() => {
        window.__step4FollowOnTraces = [];
        // Patch the Vec<ClientEvent> drainer once it's available so
        // we can count kind=8 / kind=11 events independently from
        // the DOM panels (proves the wire→event path, not just the
        // DOM render).
        window.__seenKind8 = 0;
        window.__seenKind11 = 0;
    });
    page.on("console", (msg) => {
        const text = msg.text();
        if (
            text.includes("[step")
            || text.includes("[s4f")
            || text.includes("[OK]")
            || text.includes("FAIL")
            || text.includes("kind=")
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

    // Wait for smoke checks (the page runs them inline before login
    // is enabled).
    try {
        await page.waitForFunction(() => {
            const r = document.getElementById("results");
            return r && /PASS/.test(r.innerHTML);
        }, { timeout: 30_000 });
        console.log("smoke checks PASS");
    } catch (e) {
        const html = await page.locator("#results").innerHTML();
        console.error("results panel content:", html.slice(0, 500));
        await browser.close();
        process.exit(1);
    }

    // Wire a kind=8 / kind=11 counter once the SessionHandle is
    // exposed (index.html stashes it on `window.__sessionHandle` for
    // debug). We monkeypatch poll_events from the JS side so we can
    // observe what flows through without waiting for ACE-specific
    // log lines.
    await page.exposeFunction("__step4FollowOnNote", (msg) => {
        console.log(`[capture] ${msg}`);
    });

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

    // Hook poll_events post-handle creation (the index.html closure
    // stashes `__sessionHandle` for debug).
    await page.evaluate(() => {
        const tryHook = () => {
            const h = window.__sessionHandle;
            if (!h || typeof h.poll_events !== "function") return false;
            const orig = h.poll_events.bind(h);
            h.poll_events = function () {
                const events = orig();
                for (const evt of events) {
                    if (evt.kind === 8) window.__seenKind8++;
                    if (evt.kind === 11) window.__seenKind11++;
                }
                return events;
            };
            window.__step4FollowOnNote && window.__step4FollowOnNote(
                "poll_events hook installed"
            );
            return true;
        };
        if (!tryHook()) {
            const t = setInterval(() => { if (tryHook()) clearInterval(t); }, 100);
            setTimeout(() => clearInterval(t), 30_000);
        }
    });

    // Populate the account if it's empty (auto-create accounts have 0
    // characters until CharacterCreate runs).
    const initialButtonCount = await page.locator('#character-ul button[data-id]').count();
    if (initialButtonCount === 0) {
        const createFormVisible = await page.locator("#create-form:not([hidden])").count() > 0;
        if (!createFormVisible) {
            console.error("Create-character form is hidden — bailing.");
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
        console.log("character created");
    }

    const spawnButtons = page.locator('#character-ul button[data-id]');
    if ((await spawnButtons.count()) === 0) {
        console.error("No spawnable characters — bailing.");
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

    try {
        await page.waitForSelector("#post-spawn:not([hidden])", { timeout: TELEPORT_TIMEOUT_MS });
        console.log("Teleport block unhid (kind=7 EnteredWorld)");
    } catch (e) {
        console.warn("Teleport block never unhid — kind=7 EnteredWorld didn't fire. Bailing.");
        await browser.close();
        process.exit(1);
    }

    console.log("clicking Teleport to Holtburg button");
    await page.click("#teleport-button");
    console.log(`waiting up to ${STATS_DRAIN_MS}ms for kind=8 / kind=11 events to flow`);

    // Wait for the vitals panel to become visible (first kind=8 fires
    // it). The recv loop coalesces a flurry of WorldEvents on
    // PlayerDescription into ONE kind=8, so the panel transition is
    // a reliable signal.
    let vitalsLanded = false;
    let inventoryLanded = false;
    try {
        await page.waitForSelector("#vitals-panel:not([hidden])", {
            timeout: STATS_DRAIN_MS,
        });
        vitalsLanded = true;
        console.log("[OK] vitals panel revealed (kind=8 fired)");
    } catch (e) {
        console.warn("vitals panel did NOT reveal within timeout");
    }

    // Inventory panel — a brand-new ACE character usually has no
    // starter items unless the world DB grants them, so this can
    // legitimately stay hidden. We treat its presence as a bonus
    // signal, not a hard requirement, but log it.
    try {
        await page.waitForSelector("#inventory-panel:not([hidden])", {
            timeout: 1_500,
        });
        inventoryLanded = true;
        console.log("[OK] inventory panel revealed (kind=11 fired)");
    } catch (e) {
        console.log("[INFO] inventory panel didn't reveal — fresh-character expected");
    }

    // Read panel content for verification.
    const panelState = await page.evaluate(() => {
        const v = document.getElementById("vitals-panel");
        const inv = document.getElementById("inventory-panel");
        const vbars = document.getElementById("vitals-bars");
        const attrTbody = document.querySelector("#attribute-table tbody");
        const skillTbody = document.querySelector("#skill-table tbody");
        const eqUl = document.getElementById("inv-equipped");
        const packUl = document.getElementById("inv-pack");
        return {
            vitalsHidden: v?.hidden,
            inventoryHidden: inv?.hidden,
            vitalsName: document.getElementById("vitals-name")?.textContent,
            vitalsLevel: document.getElementById("vitals-level")?.textContent,
            vitalRowCount: vbars?.querySelectorAll(".vital-row").length || 0,
            attributeRowCount: attrTbody?.querySelectorAll("tr").length || 0,
            skillRowCount: skillTbody?.querySelectorAll("tr").length || 0,
            equippedCount: eqUl?.querySelectorAll("li").length || 0,
            packCount: packUl?.querySelectorAll("li").length || 0,
            seenKind8: window.__seenKind8 || 0,
            seenKind11: window.__seenKind11 || 0,
        };
    });
    console.log("panel state:", JSON.stringify(panelState, null, 2));

    // Probe the wasm-side snapshot directly so we can assert on
    // shape even if the DOM render races.
    const snapshot = await page.evaluate(() => {
        const h = window.__sessionHandle;
        if (!h) return { error: "no SessionHandle" };
        try {
            const s = h.playerStats();
            const inv = h.playerInventory();
            return {
                name: s.name,
                vitalsLen: s.vitals?.length ?? 0,
                attributesLen: s.attributes?.length ?? 0,
                skillsLen: s.skills?.length ?? 0,
                levelInfo: Array.from(s.levelInfo || []),
                invCount: inv?.length ?? 0,
                invSample: inv?.slice(0, 3).map((i) => ({
                    guid: i.guid,
                    name: i.name,
                    itemType: i.itemType,
                    equipMask: i.equipMask,
                })) || [],
            };
        } catch (e) {
            return { error: e.message };
        }
    });
    console.log("snapshot:", JSON.stringify(snapshot, null, 2));

    // Wait a beat for the prediction loop to settle so the
    // screenshot captures stable bars rather than a transient frame.
    await page.waitForTimeout(500);

    // Scroll panels into view + screenshot. The post-spawn block
    // contains the panels; scrolling to it puts them in frame.
    await page.evaluate(() => {
        const v = document.getElementById("vitals-panel");
        v?.scrollIntoView({ block: "center" });
    });
    await page.waitForTimeout(200);
    await page.screenshot({ path: PANELS_PATH, fullPage: false });
    console.log(`saved ${PANELS_PATH}`);

    // Element-clipped screenshots of each panel.
    if (vitalsLanded) {
        const vEl = await page.locator("#vitals-panel").elementHandle();
        if (vEl) {
            await vEl.screenshot({ path: VITALS_PATH });
            console.log(`saved ${VITALS_PATH}`);
        }
    }
    if (inventoryLanded) {
        const iEl = await page.locator("#inventory-panel").elementHandle();
        if (iEl) {
            await iEl.screenshot({ path: INVENTORY_PATH });
            console.log(`saved ${INVENTORY_PATH}`);
        }
    }

    // Validation. Required: kind=8 fired AND vitals panel populated.
    // Optional: kind=11 fired (depends on ACE giving the test
    // character starter items).
    const requiredOk =
        vitalsLanded
        && panelState.vitalRowCount >= 1
        && panelState.attributeRowCount >= 1
        && panelState.seenKind8 >= 1;
    const optionalNote = inventoryLanded
        ? `kind=11 inventory panel populated (${panelState.equippedCount} equipped + ${panelState.packCount} pack)`
        : `kind=11 inventory: empty (fresh character — expected, not blocking)`;

    console.log("=========================");
    if (requiredOk) {
        console.log(
            `PASS: Phase 4 step 4 follow-on live wire round-trip closed.\n` +
            `  kind=8 PlayerStatsUpdated: ${panelState.seenKind8} events\n` +
            `  kind=11 InventoryUpdated: ${panelState.seenKind11} events\n` +
            `  vitals panel: name="${panelState.vitalsName}", ` +
            `level="${panelState.vitalsLevel}", ` +
            `${panelState.vitalRowCount} vital bars / ` +
            `${panelState.attributeRowCount} attribute rows / ` +
            `${panelState.skillRowCount} skill rows\n` +
            `  ${optionalNote}\n` +
            `  snapshot: ${snapshot.name}, vitals[${snapshot.vitalsLen}], ` +
            `attributes[${snapshot.attributesLen}], skills[${snapshot.skillsLen}]`
        );
        await browser.close();
        process.exit(0);
    } else {
        console.error(
            `FAIL: validation conditions not met.\n` +
            `  vitalsLanded=${vitalsLanded}, vitalRowCount=${panelState.vitalRowCount}, ` +
            `attributeRowCount=${panelState.attributeRowCount}, ` +
            `seenKind8=${panelState.seenKind8}\n` +
            `  Either PlayerDescription never arrived (check ACE log + ` +
            `wsbridge log for the session), the dispatcher routing skipped ` +
            `the message, or the kind=8 publish path tripped.`
        );
        await browser.close();
        process.exit(1);
    }
})().catch((err) => {
    console.error("capture failed:", err);
    process.exit(1);
});
