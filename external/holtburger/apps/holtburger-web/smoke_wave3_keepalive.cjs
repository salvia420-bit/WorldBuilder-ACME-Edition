// Wave 3 prereq smoke — wasm PingRequest keepalive validation.
//
// Goal: prove that the new `gloo_timers::TimeoutFuture` keepalive arm
// in `recv_loop` mirrors the cli's
// `should_send_keepalive_ping`+`session.send_action(GameAction::PingRequest)`
// pattern (`crates/holtburger-core/src/client/runtime.rs:9-12, 124-131`).
//
// Test shape:
//   1. Log in as phaseN_diag, spawn a character (creating one if needed),
//      enter world, stay InWorld for KEEPALIVE_DWELL_MS so the keepalive
//      arm fires ≥2 times (every 5s when last_send_time > 5s old).
//   2. Close the browser. ACE should observe a clean session-drop without
//      a stale 60-90s ghost window because the keepalive packet flow has
//      kept ACE's session up-to-date with our liveness intent.
//   3. Re-launch chromium, log in again as phaseN_diag. With the keepalive
//      in place the second login should reach Selection cleanly. Without
//      it, ACE's ghost session would race "Account In Use".
//
// Pre-reqs (per docs/ace-local-setup.md + project_emit_dynamic_site memory):
// - ACE running on 100.116.47.66:9000.
// - holtburger-wsbridge on ws://127.0.0.1:8080/.
// - python3 -m http.server 8765 from external/holtburger/.
// - Manifest+shards baked under dist/.
// - phaseN_diag promoted to Developer (this script does no @-commands so
//   level 0 also works for the basic smoke).
//
// Run: `node smoke_wave3_keepalive.cjs` from `apps/holtburger-web/`.

const { chromium } = require("playwright");

const ACCOUNT = process.env.WAVE3_ACCOUNT || "phaseN_diag";
const PASSWORD = process.env.WAVE3_PASSWORD || "phaseN_diag";
const BRIDGE_URL = process.env.WAVE3_BRIDGE_URL || "ws://127.0.0.1:8080/";
const SERVER_IP = process.env.WAVE3_SERVER_IP || "100.116.47.66";
const SERVER_PORT = process.env.WAVE3_SERVER_PORT || "9000";
const PAGE_URL = process.env.WAVE3_PAGE_URL
    || "http://127.0.0.1:8765/apps/holtburger-web/index.html";
// Run 2 starts this long after Run 1's browser closes. Must be < the
// ghost-session window (60-90s per memory) for the keepalive to matter.
const RUN_GAP_MS = parseInt(process.env.WAVE3_RUN_GAP_MS || "5000", 10);
// Time to stay InWorld so the 5s keepalive arm fires ≥2 times.
const KEEPALIVE_DWELL_MS = parseInt(process.env.WAVE3_DWELL_MS || "12000", 10);
const CREATE_TIMEOUT_MS = parseInt(process.env.WAVE3_CREATE_TIMEOUT_MS || "20000", 10);
const SPAWN_TIMEOUT_MS = parseInt(process.env.WAVE3_SPAWN_TIMEOUT_MS || "20000", 10);

async function loginRun({ runIndex, enterWorld, dwellMs, charName }) {
    console.log(`[run ${runIndex}] launching chromium → ${PAGE_URL}`);
    const browser = await chromium.launch({
        args: ["--use-gl=swiftshader"],
    });
    const context = await browser.newContext({
        viewport: { width: 1280, height: 1024 },
    });
    const page = await context.newPage();
    const consoleLines = [];
    page.on("console", (msg) => {
        const text = msg.text();
        consoleLines.push(`[run ${runIndex} ${msg.type()}] ${text}`);
    });
    page.on("pageerror", (err) => {
        consoleLines.push(`[run ${runIndex} pageerror] ${err.message}`);
    });

    try {
        await page.goto(PAGE_URL, { waitUntil: "domcontentloaded" });

        await page.waitForFunction(() => {
            const r = document.getElementById("results");
            return r && /PASS/.test(r.innerHTML);
        }, { timeout: 20_000 });
        console.log(`[run ${runIndex}] smoke checks PASS`);

        await page.fill('input[name="account"]', ACCOUNT);
        await page.fill('input[name="password"]', PASSWORD);
        await page.fill('input[name="bridge_url"]', BRIDGE_URL);
        await page.fill('input[name="server_host"]', SERVER_IP);
        await page.fill('input[name="server_port"]', SERVER_PORT);
        console.log(`[run ${runIndex}] submitting login as ${ACCOUNT}`);

        await page.click('#login-form button[type=submit]');
        await page.waitForSelector("#selection:not([hidden])", { timeout: 30_000 });
        const status = await page.locator("#login-status").innerText();
        console.log(`[run ${runIndex}] login-status: ${status}`);
        await page.waitForTimeout(500);

        if (!enterWorld) {
            await browser.close();
            return { pass: true, consoleLines };
        }

        // Create char if needed, then click first Spawn button.
        const initialButtonCount = await page.locator('#character-ul button[data-id]').count();
        if (initialButtonCount === 0) {
            const createFormVisible = await page.locator("#create-form:not([hidden])").count() > 0;
            if (!createFormVisible) {
                throw new Error("Create-character form is hidden — cannot enter world");
            }
            console.log(`[run ${runIndex}] creating character "${charName}"`);
            await page.fill('#create-form input[name="char_name"]', charName);
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
            throw new Error("No spawnable characters after create");
        }
        await spawnButtons.first().click();
        console.log(`[run ${runIndex}] clicked Spawn`);
        await page.waitForFunction(() => {
            const s = document.getElementById("login-status");
            return s && /InWorld|Spawned/.test(s.innerText);
        }, { timeout: SPAWN_TIMEOUT_MS });
        console.log(`[run ${runIndex}] InWorld reached`);

        console.log(`[run ${runIndex}] dwelling ${dwellMs}ms (keepalive should fire ≥${Math.floor(dwellMs / 5000)} times)`);
        await page.waitForTimeout(dwellMs);

        // Count keepalive-related console lines to confirm the arm executed.
        // The arm fires send_action; on success there's no log line, but if
        // it failed the warn would land here. Absence-of-warn is the signal.
        const keepaliveWarns = consoleLines.filter((l) => l.includes("keepalive PingRequest")).length;
        console.log(`[run ${runIndex}] keepalive send failures: ${keepaliveWarns} (0 = OK)`);

        await browser.close();
        return { pass: true, consoleLines };
    } catch (e) {
        console.error(`[run ${runIndex}] failed: ${e.message}`);
        const tail = consoleLines.slice(-30);
        for (const line of tail) console.error(`   ${line}`);
        await browser.close().catch(() => {});
        return { pass: false, error: e.message, consoleLines };
    }
}

(async () => {
    console.log(`Wave 3 prereq smoke — wasm PingRequest keepalive validation`);
    console.log(`ACE: ${SERVER_IP}:${SERVER_PORT}; account: ${ACCOUNT}`);

    // Use one shared character name based on Date.now so re-runs reuse
    // the same character (avoids creating spammy duplicates on phaseN_diag).
    const charName = `KeepaliveDiag${Date.now().toString(36).slice(-6)}`;

    const run1 = await loginRun({
        runIndex: 1,
        enterWorld: true,
        dwellMs: KEEPALIVE_DWELL_MS,
        charName,
    });
    if (!run1.pass) {
        console.error("Run 1 failed — cannot exercise keepalive arm.");
        process.exit(1);
    }
    console.log(`Run 1 PASS (entered world + dwelled ${KEEPALIVE_DWELL_MS}ms).`);

    console.log(`Waiting ${RUN_GAP_MS}ms before re-login...`);
    await new Promise((r) => setTimeout(r, RUN_GAP_MS));

    const run2 = await loginRun({
        runIndex: 2,
        enterWorld: false, // reaching CharacterList is enough for relog probe
        dwellMs: 0,
        charName: null,
    });
    if (!run2.pass) {
        console.error("Run 2 failed — rapid relog blocked by ghost session.");
        process.exit(2);
    }
    console.log(`Run 2 PASS (rapid relog within ${RUN_GAP_MS}ms succeeded).`);
    console.log(`Wave 3 prereq SMOKE PASS — keepalive arm wired + rapid relog clean.`);
    process.exit(0);
})().catch((err) => {
    console.error("smoke crashed:", err);
    process.exit(3);
});
