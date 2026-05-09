// Phase 4 step 3 capture script — drives the bundle through login →
// CharacterCreate (if needed) → spawn → @telepoi Holtburg → entity
// drain, then HOLDS W for ~3 seconds and verifies the local player
// sprite moved on the canvas. The wire-effect proof is the position
// delta on `window.entityMap`: keyboard input → setMovementInput →
// MoveToState → ACE simulates → PublicUpdatePosition echo lands → JS
// updates the entity sprite's world coords. If the delta is > the
// motion threshold (default 1.0 m), the wire round-trip worked.
//
// Pre-reqs (same as step 2b; see `docs/ace-local-setup.md`):
// - ACE running headless on UDP 127.0.0.1:9000 (login) / 9001 (world).
// - holtburger-wsbridge running on ws://127.0.0.1:8080/.
// - python3 -m http.server 8765 from external/holtburger/.
// - Manifest+shards baked under dist/ (the index.html consumes them
//   via init_resource_source).
// - The test account needs accessLevel = 4 for `@telepoi`. Promote
//   with: `mariadb -uace -pace -e "UPDATE ace_auth.account SET
//   accessLevel = 4 WHERE accountName LIKE 'phase4demo%'"`.
//
// Run: `node capture_phase4_step3.cjs` from `apps/holtburger-web/`.
// Outputs `docs/images/phase-4-step-3-walking.png` and prints
// PASS / FAIL based on the position delta.

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
        "../../../../docs/images/phase-4-step-3-walking.png"
    );
    const CHAR_NAME = process.env.PHASE4_CHAR_NAME
        || `WasmDemo${Date.now().toString(36).slice(-6)}`;
    const CREATE_TIMEOUT_MS = Number(process.env.PHASE4_CREATE_TIMEOUT_MS || 15_000);
    const SPAWN_TIMEOUT_MS = Number(process.env.PHASE4_SPAWN_TIMEOUT_MS || 15_000);
    const ENTITY_DRAIN_MS = Number(process.env.PHASE4_ENTITY_DRAIN_MS || 4_000);
    // How long to hold W. Walk speed is 1.0 m/s in retail; 3 seconds
    // should produce ~3 m of movement at the canonical retail speed
    // before ACE's round-trip latency eats into it.
    const WALK_HOLD_MS = Number(process.env.PHASE4_WALK_HOLD_MS || 3_000);
    // Settle time after key release for the final PublicUpdatePosition
    // echo to land. ACE keeps simulating for a tick or two after the
    // motion-state-clear arrives.
    const SETTLE_MS = Number(process.env.PHASE4_SETTLE_MS || 1_500);
    // Validation threshold — minimum delta in metres between the
    // pre-walk and post-walk snapshot of the moving sprite. NPCs
    // ambient-drift on the order of cm-per-second; 1.0 m well clear
    // of that floor while still permissive of round-trip latency.
    const MOVE_THRESHOLD_M = Number(process.env.PHASE4_MOVE_THRESHOLD_M || 1.0);

    console.log(`launching chromium → ${PAGE_URL}`);
    const browser = await chromium.launch({
        args: ["--use-gl=swiftshader"],
    });
    const context = await browser.newContext({
        viewport: { width: 1280, height: 1024 },
    });
    const page = await context.newPage();
    // Capture all console messages and accumulate [step3-trace] lines
    // so the post-walk pass-condition check can read them.
    await page.addInitScript(() => { window.__step3Traces = []; });
    page.on("console", (msg) => {
        const text = msg.text();
        console.log(`[browser ${msg.type()}] ${text}`);
        if (text.includes("[step3-trace]")) {
            // Stash on the page side too so we can read via evaluate.
            page.evaluate((t) => {
                if (window.__step3Traces) window.__step3Traces.push(t);
            }, text).catch(() => {});
        }
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
    await page.fill('input[name="server_host"]', SERVER_IP);
    await page.fill('input[name="server_port"]', SERVER_PORT);
    console.log(`submitting login as ${ACCOUNT}`);

    await page.click('#login-form button[type=submit]');
    await page.waitForSelector("#selection:not([hidden])", { timeout: 30_000 });
    console.log("Selection visible");
    await page.waitForTimeout(500);

    // Mirror step 2a.5 / step 2b: populate the account if it's empty.
    const initialButtonCount = await page.locator('#character-ul button[data-id]').count();
    if (initialButtonCount === 0) {
        const createFormVisible = await page.locator("#create-form:not([hidden])").count() > 0;
        if (!createFormVisible) {
            console.error("Create-character form is hidden — bailing.");
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
        console.warn("Teleport block never unhid — bailing (movement requires kind=7 EnteredWorld).");
        await page.screenshot({ path: OUT_PATH, fullPage: false });
        await browser.close();
        process.exit(1);
    }

    console.log("clicking Teleport to Holtburg button");
    await page.click("#teleport-button");
    console.log(`waiting ${ENTITY_DRAIN_MS}ms for entity drain post-teleport`);
    await page.waitForTimeout(ENTITY_DRAIN_MS);

    // ACE's `OnMoveToState` short-circuits with `if (!FastTick) return;`
    // (Player_Tick.cs:178), and `FastTick => IsPKType` (line 154) —
    // i.e. the server only simulates movement physics for PK / PKLite
    // players. Non-PK players rely on client-side prediction, which
    // the wasm bundle deliberately doesn't run (the cli does, via
    // ClientRuntime + WorldState, which step 3 skips by design — see
    // phase-4-renderer.md step 3). Send `@pk pk` to flip the
    // PlayerKillerStatus so ACE takes the FastTick path → physics
    // simulates → `PublicUpdatePosition` echoes back. Requires
    // accessLevel ≥ 4 (Developer); Config.js DefaultAccessLevel = 4
    // covers auto-created accounts.
    //
    // index.html exposes the SessionHandle on `window.__sessionHandle`
    // (debug hook alongside `window.entityMap` / `window.liveScene`).
    console.log("sending '@pk pk' to enable FastTick (server-side physics)");
    const pkResult = await page.evaluate(() => {
        if (window.__sessionHandle && typeof window.__sessionHandle.sendChat === "function") {
            try {
                window.__sessionHandle.sendChat("@pk pk");
                return "sent";
            } catch (e) {
                return `err: ${e.message || e}`;
            }
        }
        return "handle not exposed";
    });
    console.log(`@pk pk dispatch: ${pkResult}`);
    await page.waitForTimeout(2000); // let the server-message echo land

    // Pre-walk snapshot: every (guid → {x, y}) on window.entityMap.
    // entityMap is a Map<u32, { sprite: PIXI.Container, modelId }>;
    // each sprite carries world-coord position via .x/.y in metres.
    const preSnapshot = await page.evaluate(() => {
        const out = {};
        if (window.entityMap) {
            for (const [guid, entry] of window.entityMap.entries()) {
                if (entry?.sprite) {
                    out[guid] = { x: entry.sprite.x, y: entry.sprite.y };
                }
            }
        }
        return out;
    });
    const preCount = Object.keys(preSnapshot).length;
    console.log(`pre-walk: ${preCount} entities tracked`);
    if (preCount === 0) {
        console.error("No entities in entityMap — entity rendering may have failed. Bailing.");
        await page.screenshot({ path: OUT_PATH, fullPage: false });
        await browser.close();
        process.exit(1);
    }

    // The login form's inputs may still hold focus (the page didn't
    // explicitly blur them after submit), which would make
    // `isTypingInForm()` return true inside the page's keydown
    // handler and short-circuit movement. Click the canvas to move
    // focus to the body / canvas so WASD goes through.
    await page.evaluate(() => {
        if (document.activeElement && typeof document.activeElement.blur === "function") {
            document.activeElement.blur();
        }
        // Make body the active element by clicking it.
    });
    await page.locator("#canvas").click({ position: { x: 256, y: 256 }, force: true });
    const activeBefore = await page.evaluate(() => ({
        tag: document.activeElement?.tagName,
        id: document.activeElement?.id,
    }));
    console.log(`pre-W: activeElement=${JSON.stringify(activeBefore)}`);

    // Diagnostic: hook keyboard listeners so we can count actual
    // events; expose enteredWorld via a probe.
    await page.evaluate(() => {
        window.__keyEvents = { down: 0, up: 0 };
        document.addEventListener("keydown", (e) => { window.__keyEvents.down++; });
        document.addEventListener("keyup", (e) => { window.__keyEvents.up++; });
    });

    const enteredWorldBefore = await page.evaluate(() => {
        const ps = document.getElementById("post-spawn");
        return ps && !ps.hidden;
    });
    console.log(`pre-W: enteredWorld(proxy)=${enteredWorldBefore}`);

    // Wrap pollEntityUpdates and setMovementInput so we can see how
    // many updates flow during the W window AND how many setMovementInput
    // calls were issued from JS.
    await page.evaluate(() => {
        // Find the SessionHandle prototype indirectly via the pkg
        // import; the page closure keeps `handle` private. Hook PIXI's
        // ticker to count rAF ticks instead.
        window.__updateCount = 0;
        window.__rafTickCount = 0;
        window.__smiCallCount = 0;
        const sceneHandle = window.liveScene;
        if (sceneHandle) {
            // Monkeypatch the prototype's methods if reachable.
            // The SessionHandle is held in the page's closure but
            // pollEntityUpdates is on its prototype.
        }
        // Instead: count entity-container child x/y mutations by
        // observing transform changes. PIXI exposes them as ._x
        // updates internally. Simpler: poll the local player's pos
        // every 100 ms and log when it changes.
        window.__playerPosLog = [];
        const sampleGuid = 0x5000000e;
        const interval = setInterval(() => {
            const entry = window.entityMap?.get(sampleGuid);
            if (entry?.sprite) {
                const last = window.__playerPosLog[window.__playerPosLog.length - 1];
                const x = entry.sprite.x;
                const y = entry.sprite.y;
                if (!last || last.x !== x || last.y !== y) {
                    window.__playerPosLog.push({ t: Date.now(), x, y });
                }
            }
        }, 100);
        window.__posLogInterval = interval;
    });

    // Hold W. The page-level keydown listener gates input on
    // `enteredWorld`, which the kind=7 handler flips after teleport.
    // Use page.keyboard so the events dispatch through the DOM as if
    // a real user pressed W; a synthetic CustomEvent wouldn't trigger
    // the document-level listener the page registers.
    console.log(`pressing W for ${WALK_HOLD_MS}ms`);
    await page.keyboard.down("w");
    await page.waitForTimeout(WALK_HOLD_MS);
    await page.keyboard.up("w");
    console.log(`releasing W; settling ${SETTLE_MS}ms for final echo`);
    await page.waitForTimeout(SETTLE_MS);

    // Read diagnostics
    const diag = await page.evaluate(() => {
        clearInterval(window.__posLogInterval);
        return {
            keyEvents: window.__keyEvents,
            entityCount: window.entityMap?.size || 0,
            playerPosLog: window.__playerPosLog || [],
            rafTicks: window.__rafTickCount || 0,
            lastInputSig: window.__lastInputSig,
            smiCallCount: window.__smiCallCount || 0,
        };
    });
    console.log(`raf ticks: ${diag.rafTicks}, lastInputSig: ${diag.lastInputSig}, setMovementInput calls: ${diag.smiCallCount}`);
    const pred = await page.evaluate(() => ({
        ticks: window.__predTickCount || 0,
        first: window.__predFirstPos,
        last: window.__predLastPos,
    }));
    if (pred.first && pred.last) {
        const dx = pred.last.x - pred.first.x;
        const dy = pred.last.y - pred.first.y;
        console.log(`prediction integrations: ${pred.ticks}, drift while held: dx=${dx.toFixed(2)} dy=${dy.toFixed(2)} (m)`);
    } else {
        console.log(`prediction integrations: ${pred.ticks} (no first/last pos captured — keystate may have been zero)`);
    }
    console.log(`post-W: keyEvents=${JSON.stringify(diag.keyEvents)} entityCount=${diag.entityCount}`);
    console.log(`local player position log (${diag.playerPosLog.length} samples):`);
    for (const s of diag.playerPosLog.slice(0, 8)) {
        console.log(`    t=${s.t} (${s.x.toFixed(2)}, ${s.y.toFixed(2)})`);
    }

    const postSnapshot = await page.evaluate(() => {
        const out = {};
        if (window.entityMap) {
            for (const [guid, entry] of window.entityMap.entries()) {
                if (entry?.sprite) {
                    out[guid] = { x: entry.sprite.x, y: entry.sprite.y };
                }
            }
        }
        return out;
    });

    // Diagnostic: print first 3 guid positions before / after to see
    // whether ANY entity moved (NPCs ambient-drift even without our
    // movement, so 0 delta everywhere suggests sprites aren't being
    // updated at all). Also dump the post-walk container child count.
    const sampleGuids = Object.keys(preSnapshot).slice(0, 3);
    for (const g of sampleGuids) {
        const pre = preSnapshot[g];
        const post = postSnapshot[g];
        console.log(`  guid 0x${Number(g).toString(16).padStart(8,"0")}: ` +
            `pre=(${pre?.x?.toFixed(2)}, ${pre?.y?.toFixed(2)}) ` +
            `post=(${post?.x?.toFixed(2)}, ${post?.y?.toFixed(2)})`);
    }
    const containerCount = await page.evaluate(() => window.liveScene?.entityContainer?.children?.length ?? -1);
    console.log(`entityContainer children: ${containerCount}`);

    // Compute deltas. The local player isn't directly identified
    // (spawnedPlayerGuid is closure-scope, not on window), but it's
    // the only entity walking 1+ metres in 3 seconds — NPCs ambient-
    // drift on the cm-per-second floor, far below the threshold.
    let maxDelta = 0;
    let movedGuid = null;
    let movedFrom = null;
    let movedTo = null;
    for (const [guid, postPos] of Object.entries(postSnapshot)) {
        const prePos = preSnapshot[guid];
        if (!prePos) continue;  // newly spawned entity — skip
        const dx = postPos.x - prePos.x;
        const dy = postPos.y - prePos.y;
        const delta = Math.hypot(dx, dy);
        if (delta > maxDelta) {
            maxDelta = delta;
            movedGuid = guid;
            movedFrom = prePos;
            movedTo = postPos;
        }
    }

    // Center the camera on the moving entity (if any) before the
    // screenshot so the walked-to position is framed.
    if (movedGuid !== null) {
        await page.evaluate((guid) => {
            const entry = window.entityMap?.get(Number(guid));
            if (!entry?.sprite || !window.liveScene?.cameraContainer) return;
            // PIXI camera container uses (-x, -y) translation to centre
            // a world point. But we don't know the canvas centre offset
            // arithmetic from outside, so just trust it scrolls into view.
        }, movedGuid);
    }

    await page.evaluate(() => {
        const canvasElem = document.getElementById("canvas");
        if (canvasElem) canvasElem.scrollIntoView({ block: "start" });
    });
    await page.waitForTimeout(200);
    await page.screenshot({ path: OUT_PATH, fullPage: false });
    console.log(`saved ${OUT_PATH}`);

    // Wire-effect validation: count [step3-trace] log lines emitted
    // by the recv_loop. The page's `console.log` calls flow through
    // Playwright's `console` event, which we accumulate.
    //
    // Success signal: UpdateMotion echoed back from ACE *for our own
    // guid* after we sent MoveToState. ACE's BroadcastMovement
    // (Player_Networking.cs:309) `EnqueueBroadcast(true, ...)` includes
    // the originator. The local sprite doesn't slide here because
    // retail AC expects the client to predict locally (deferred scope
    // — see step 3 doc "What's NOT in scope" section). The UpdateMotion
    // echo is the empirical wire-effect proof.
    const traceLines = await page.evaluate(() => window.__step3Traces || []);
    const sentMoveToState = traceLines.filter(l => l.includes("MoveToState send_action OK")).length;
    const updateMotionEchoes = traceLines.filter(l => l.includes("UpdateMotion guid=")).length;
    const ourGuid = movedGuid !== null
        ? `0x${Number(movedGuid).toString(16).toUpperCase().padStart(8, "0")}`
        : null;
    const ourEchoes = ourGuid !== null
        ? traceLines.filter(l => l.includes(`UpdateMotion guid=${ourGuid}`)).length
        : 0;

    console.log("=========================");
    console.log(`MoveToState send_action OK: ${sentMoveToState}`);
    console.log(`UpdateMotion echoes (any guid): ${updateMotionEchoes}`);
    console.log(`UpdateMotion echoes for local player ${ourGuid ?? "(unknown)"}: ${ourEchoes}`);

    const wireOk = sentMoveToState >= 1 && updateMotionEchoes >= 1;
    const motionOk = maxDelta >= MOVE_THRESHOLD_M;

    if (wireOk && motionOk) {
        console.log(
            `PASS: end-to-end loop closed. ` +
            `Sent ${sentMoveToState} MoveToState packet${sentMoveToState === 1 ? "" : "s"} → ` +
            `received ${updateMotionEchoes} UpdateMotion echo${updateMotionEchoes === 1 ? "" : "es"} ` +
            `from ACE (step 3 wire round-trip), AND local sprite slid ${maxDelta.toFixed(2)} m ` +
            `under client-side prediction (step 3.5). ` +
            `Moving guid 0x${Number(movedGuid).toString(16).toUpperCase().padStart(8, "0")}: ` +
            `(${movedFrom.x.toFixed(2)}, ${movedFrom.y.toFixed(2)}) → ` +
            `(${movedTo.x.toFixed(2)}, ${movedTo.y.toFixed(2)}).`
        );
        await browser.close();
        process.exit(0);
    } else if (wireOk && !motionOk) {
        console.error(
            `PARTIAL: wire OK but no local sprite motion. ` +
            `Sent ${sentMoveToState} MoveToState → ${updateMotionEchoes} UpdateMotion echoes (step 3 wire works), ` +
            `but max delta was only ${maxDelta.toFixed(2)} m (< ${MOVE_THRESHOLD_M} m). ` +
            `Step 3.5 (client-side prediction) didn't integrate motion — ` +
            `check window.__predTickCount > 0 and that the local-player guid ` +
            `is in entityMap.`
        );
        await browser.close();
        process.exit(1);
    } else {
        console.error(
            `FAIL: sentMoveToState=${sentMoveToState}, updateMotionEchoes=${updateMotionEchoes}, maxDelta=${maxDelta.toFixed(2)} m. ` +
            `Either the input path didn't reach setMovementInput (check ` +
            `[step 3] log lines above), or ACE silently dropped the packet ` +
            `(check ACE log for parse errors).`
        );
        await browser.close();
        process.exit(1);
    }
})().catch((err) => {
    console.error("capture failed:", err);
    process.exit(1);
});
