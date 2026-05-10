// Academy rubberband diagnostic capture — drives the bundle through
// login → CharacterCreate → academy spawn (NO @telepoi) → 5 s W-hold,
// and reports:
//   1. Whether the spawn cell is reported `isCurrentCellIndoor()=true`.
//   2. The pose trajectory from the existing `[step 3.6 tick #N]` log
//      (which we extended in lib.rs with `indoor=` + `force_seq=`).
//   3. The count + per-event detail of `[acad-diag rubberband]` lines —
//      these fire whenever `world.player.force_position_sequence`
//      changes mid-walk, i.e. whenever the server forced a reposition.
//
// The intent is DIAGNOSTIC, not pass/fail — we want to see what
// happens in the academy, since every existing capture script teleports
// to Holtburg first via `@telepoi` and so never exercises the indoor
// spawn that real new players hit.
//
// Pre-reqs (same as Phase 6 captures):
// - Live ACE on Tailscale 100.116.47.66 UDP 9000 (login) / 9001 (world).
// - holtburger-wsbridge on ws://127.0.0.1:8080/.
// - python3 -m http.server 8765 from external/holtburger/.
// - Manifest+shards baked under dist/.
// - ACCOUNT must be Developer-promoted *only if* PK_MODE=1 (default);
//   academy spawn itself works on any account.
//
// Run: `node capture_academy_rubberband.cjs` from `apps/holtburger-web/`.
// Outputs `docs/images/academy-rubberband.png` and prints a structured
// summary to stdout.
//
// Uniqueness — the account name carries a per-run timestamp suffix so
// every run lands on a fresh ACE account, which means a fresh
// CharacterCreate path and a fresh academy spawn (no carry-over of an
// already-teleported character). Override with PHASE4_TEST_ACCOUNT
// to pin to a specific account between runs.

const { chromium } = require("playwright");
const path = require("node:path");

(async () => {
    const RUN_TAG = process.env.ACAD_RUN_TAG || `acad${Date.now().toString(36)}`;
    const ACCOUNT = process.env.PHASE4_TEST_ACCOUNT || RUN_TAG;
    const PASSWORD = process.env.PHASE4_TEST_PASSWORD || RUN_TAG;
    const CHAR_NAME = process.env.ACAD_CHAR_NAME || `Acad${RUN_TAG.slice(-6)}`;
    const BRIDGE_URL = process.env.PHASE4_BRIDGE_URL || "ws://127.0.0.1:8080/";
    const SERVER_IP = process.env.PHASE4_SERVER_IP || "100.116.47.66";
    const SERVER_PORT = process.env.PHASE4_SERVER_PORT || "9000";
    const PAGE_URL = process.env.PHASE4_PAGE_URL
        || "http://127.0.0.1:8765/apps/holtburger-web/index.html";
    // PK_MODE=1 fires `@pk pk` post-spawn so ACE's FastTick
    // (Player_Tick.cs:178 — `IsPKType` gate) drives the server-side
    // physics that surfaces the rubberband. Memory: "Tester is PK"
    // so this matches the user's reproduction context. Set PK_MODE=0
    // to capture the non-PK path (which may show no rubberband if
    // ACE only force-repositions FastTick players).
    const PK_MODE = (process.env.PK_MODE || "1") === "1";
    // W-hold duration in ms. 5 s is enough to exercise the academy's
    // first ~10 m corridor without smashing into the far wall.
    const WALK_HOLD_MS = Number(process.env.ACAD_WALK_HOLD_MS || 5000);
    // Time budget for spawn / teleport blocks to unhide.
    const SPAWN_TIMEOUT_MS = Number(process.env.ACAD_SPAWN_TIMEOUT_MS || 60_000);
    const CREATE_TIMEOUT_MS = Number(process.env.ACAD_CREATE_TIMEOUT_MS || 30_000);
    // Settle window after EnteredWorld before we read the cell —
    // mirrors the entity-drain in capture_phase6_step_b_collision.cjs:211.
    const POST_SPAWN_DRAIN_MS = Number(process.env.ACAD_POST_SPAWN_DRAIN_MS || 3000);

    const OUT_PATH = path.resolve(
        __dirname,
        "../../../../docs/images/academy-rubberband.png"
    );

    console.log(`launching chromium → ${PAGE_URL}`);
    console.log(`target ACE: ${SERVER_IP}:${SERVER_PORT} via ${BRIDGE_URL}`);
    console.log(`account: ${ACCOUNT}, character: ${CHAR_NAME}, PK=${PK_MODE}`);

    const browser = await chromium.launch({ args: ["--use-gl=swiftshader"] });
    const context = await browser.newContext({ viewport: { width: 1280, height: 1024 } });
    const page = await context.newPage();

    // Collect every console line so we can post-process for
    // `[step 3.6 tick #N]` (the periodic pose log we extended) and
    // `[acad-diag rubberband]` (the per-force-seq-change marker).
    /** @type {Array<{ t: number, type: string, text: string }>} */
    const consoleLines = [];
    const t0 = Date.now();
    page.on("console", (msg) => {
        const text = msg.text();
        const entry = { t: Date.now() - t0, type: msg.type(), text };
        consoleLines.push(entry);
        // Diagnostic mode: surface EVERY browser line so we can see
        // any panic / unhandled rejection / unexpected drop. Filter
        // back later once the run is stable.
        console.log(`[browser ${msg.type()} +${entry.t}ms] ${text}`);
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
        }, { timeout: 30_000 });
        console.log("wasm-side smoke checks PASS");
    } catch (e) {
        const html = await page.locator("#results").innerHTML();
        console.error("results panel:", html.slice(0, 500));
        await browser.close();
        process.exit(1);
    }

    // Login.
    await page.fill('input[name="account"]', ACCOUNT);
    await page.fill('input[name="password"]', PASSWORD);
    await page.fill('input[name="bridge_url"]', BRIDGE_URL);
    await page.fill('input[name="server_host"]', SERVER_IP);
    await page.fill('input[name="server_port"]', SERVER_PORT);
    await page.click('#login-form button[type=submit]');
    try {
        await page.waitForSelector("#selection:not([hidden])", { timeout: 30_000 });
    } catch (e) {
        const status = await page.locator("#login-status").innerText().catch(() => "(unavailable)");
        console.error(`login timeout — login-status was: ${JSON.stringify(status)}`);
        await page.screenshot({ path: OUT_PATH, fullPage: false });
        await browser.close();
        process.exit(1);
    }
    await page.waitForTimeout(500);

    // Create a character if account is empty (which it always will be
    // for a fresh RUN_TAG).
    const initialCount = await page.locator('#character-ul button[data-id]').count();
    if (initialCount === 0) {
        const createVisible = await page.locator("#create-form:not([hidden])").count() > 0;
        if (!createVisible) {
            console.error("Create-character form hidden — bailing.");
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

    // Spawn into the academy.
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

    // INTENTIONALLY do NOT click `#teleport-button` — that's the
    // `@telepoi Holtburg` bypass every other capture uses to skip the
    // training academy. We want the academy.
    await page.waitForTimeout(POST_SPAWN_DRAIN_MS);

    // Confirm we're actually in the academy (indoor cell).
    const cellInfo = await page.evaluate(() => {
        const handle = window.__sessionHandle;
        const out = { available: false };
        if (handle) {
            try {
                if (typeof handle.getCurrentCellId === "function") {
                    out.cellId = handle.getCurrentCellId();
                }
                if (typeof handle.isCurrentCellIndoor === "function") {
                    out.indoor = handle.isCurrentCellIndoor();
                }
                out.available = true;
            } catch (e) {
                out.err = e.message || String(e);
            }
        }
        return out;
    });
    console.log(`spawn cell info: ${JSON.stringify(cellInfo)}`);

    // PK promotion if requested — matches Phase 6 step B's rationale at
    // capture_phase6_step_b_collision.cjs:213-219.
    if (PK_MODE) {
        const pkResult = await page.evaluate(() => {
            const h = window.__sessionHandle;
            if (h && typeof h.sendChat === "function") {
                try {
                    h.sendChat("@pk pk");
                    return "sent";
                } catch (e) {
                    return `err: ${e.message || e}`;
                }
            }
            return "no handle";
        });
        console.log(`@pk pk dispatch: ${pkResult}`);
        await page.waitForTimeout(2000);
    }

    // Move keyboard focus to the canvas so WASD reaches the bundle's
    // keydown listener. capture_phase4_step3.cjs:170-180 establishes
    // this is required — without click, the body has focus and W is
    // captured by the page-level handler instead of the canvas.
    const canvas = await page.locator("canvas").first();
    if ((await canvas.count()) > 0) {
        await canvas.click();
    }

    // Snapshot pose trajectory before walking, so we can baseline what
    // the integrator was already doing while idle (any rubberband at
    // rest is a much stronger signal than during walk).
    console.log("standing still for 2 s (pre-walk baseline)");
    await page.waitForTimeout(2000);

    // The actual W-hold.
    console.log(`pressing W for ${WALK_HOLD_MS}ms`);
    await page.keyboard.down("w");
    await page.waitForTimeout(WALK_HOLD_MS);
    await page.keyboard.up("w");
    console.log("released W; settling 1 s");
    await page.waitForTimeout(1000);

    // Final pose / cell sample.
    const finalCellInfo = await page.evaluate(() => {
        const handle = window.__sessionHandle;
        const out = {};
        if (handle) {
            if (typeof handle.getCurrentCellId === "function") {
                out.cellId = handle.getCurrentCellId();
            }
            if (typeof handle.isCurrentCellIndoor === "function") {
                out.indoor = handle.isCurrentCellIndoor();
            }
        }
        return out;
    });
    console.log(`final cell info: ${JSON.stringify(finalCellInfo)}`);

    await page.screenshot({ path: OUT_PATH, fullPage: false });
    console.log(`saved ${OUT_PATH}`);

    await browser.close();

    // === Post-process the captured console transcript ====================
    const tickLines = consoleLines.filter((c) => /\[step 3\.6 tick #/.test(c.text));
    const rubberLines = consoleLines.filter((c) => /\[acad-diag rubberband\]/.test(c.text));

    console.log("");
    console.log("======== ACADEMY RUBBERBAND CAPTURE SUMMARY ========");
    console.log(`run tag:    ${RUN_TAG}`);
    console.log(`account:    ${ACCOUNT}`);
    console.log(`PK mode:    ${PK_MODE}`);
    console.log(`spawn cell: ${JSON.stringify(cellInfo)}`);
    console.log(`final cell: ${JSON.stringify(finalCellInfo)}`);
    console.log(`tick lines: ${tickLines.length}`);
    console.log(`rubberband events: ${rubberLines.length}`);

    if (rubberLines.length > 0) {
        console.log("");
        console.log("--- rubberband events ---");
        for (const r of rubberLines) {
            console.log(`+${r.t}ms ${r.text}`);
        }
    }

    if (tickLines.length > 0) {
        console.log("");
        console.log("--- pose trajectory (every ~1 s) ---");
        for (const t of tickLines) {
            console.log(`+${t.t}ms ${t.text}`);
        }
    }

    // Indoor confirmation gate — if we never saw `indoor=true` we
    // didn't actually spawn in the academy and the diagnosis below
    // does not apply.
    const sawIndoorTick = tickLines.some((t) => /indoor=true/.test(t.text));
    console.log("");
    console.log(`indoor tick observed: ${sawIndoorTick}`);
    if (!sawIndoorTick) {
        console.warn(
            "WARNING: no `indoor=true` tick observed. Either the spawn "
            + "skipped the academy (heritage start area is outdoor on "
            + "this server build) or the cell-id derivation thinks the "
            + "spawn is outdoor. Check `cellInfo` above."
        );
    }

    // Surface the file path of the structured transcript so a follow-on
    // run can compare. Not load-bearing — kept short.
    console.log("====================================================");
})().catch((err) => {
    console.error("capture failed:", err);
    process.exit(1);
});
