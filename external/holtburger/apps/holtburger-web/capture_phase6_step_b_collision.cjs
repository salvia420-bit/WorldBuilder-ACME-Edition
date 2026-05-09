// Phase 6 step B capture script — drives the bundle through login →
// CharacterCreate (if needed) → spawn → @telepoi Holtburg → entity
// drain, then HOLDS W for ~3 seconds INTO THE TOWN HALL WALL and
// verifies that the local player sprite STOPPED at the wall (delta
// less than 0.5 m). A control walk in a no-wall direction (S, into
// open ground from spawn) is captured first to confirm the input
// path itself is healthy and the threshold is calibrated against a
// real walk.
//
// Phase B's contract (per docs/phase-6-buildings-and-interiors.md §5):
//   1. `project_pose_by_velocity()` in
//      `crates/holtburger-world/src/spatial/physics.rs:308-319` sweeps
//      a player capsule against per-cell AABBs from `building_aabb_index`.
//   2. Walking into a wall clamps the proposed delta to first-hit.
//   3. Walking parallel to a wall (or in open ground) slides without
//      blocking — i.e. the integrator does NOT spuriously clamp when
//      no AABB lies on the proposed path.
//
// Sibling tests:
//   - capture_phase6_step_a_geometry.cjs     — Phase A (this script's
//     prerequisite; if Phase A's `window.buildingMap` is missing this
//     script bails with a clear "Phase A not present" message).
//   - capture_phase4_step3.cjs               — keyboard input pattern
//     (page.keyboard.down/up + WASD via document keydown listener).
//
// IMPORTANT — Phase B is not yet implemented at the time this capture
// script lands. The implementation agent will wire AABB collision into
// `project_pose_by_velocity` in a follow-up commit. Until that lands,
// the test SHOULD fail with the "Phase B collision not active —
// clipped through wall" detail message rather than a generic threshold
// miss. That's the intended behaviour — the contract is locked before
// the implementation arrives.
//
// Pre-reqs (same as `capture_phase6_step_a_geometry.cjs`):
// - Live ACE on Tailscale 100.116.47.66 UDP 9000 (login) / 9001 (world).
// - holtburger-wsbridge running on ws://127.0.0.1:8080/.
// - python3 -m http.server 8765 from external/holtburger/.
// - Manifest+shards baked under dist/ (the index.html consumes them
//   via init_resource_source).
// - The test account needs accessLevel ≥ 4 for `@telepoi` and `@pk`.
//   Tailnet creds `tailnet1/tailnet1` are pre-promoted to Developer.
//
// Run: `node capture_phase6_step_b_collision.cjs` from `apps/holtburger-web/`.
// Outputs `docs/images/phase-6-step-b-collision.png` (player against
// the wall after the 3 s W-hold) and prints PASS / FAIL based on the
// post-walk delta + control-walk delta + Phase A presence guard.

const { chromium } = require("playwright");
const path = require("node:path");

(async () => {
    // Default endpoint is the live tailnet ACE; tester credentials
    // (tailnet1/tailnet1) are Developer-promoted by the live-server
    // operator. Override via env for an alternate target.
    const ACCOUNT = process.env.PHASE4_TEST_ACCOUNT || "tailnet1";
    const PASSWORD = process.env.PHASE4_TEST_PASSWORD || "tailnet1";
    const BRIDGE_URL = process.env.PHASE4_BRIDGE_URL || "ws://127.0.0.1:8080/";
    const SERVER_IP = process.env.PHASE4_SERVER_IP || "100.116.47.66";
    const SERVER_PORT = process.env.PHASE4_SERVER_PORT || "9000";
    const PAGE_URL = process.env.PHASE4_PAGE_URL
        || "http://127.0.0.1:8765/apps/holtburger-web/index.html";
    const OUT_PATH = path.resolve(
        __dirname,
        "../../../../docs/images/phase-6-step-b-collision.png"
    );
    const CHAR_NAME = process.env.PHASE6_CHAR_NAME
        || `Phase6B${Date.now().toString(36).slice(-6)}`;
    const CREATE_TIMEOUT_MS = Number(process.env.PHASE4_CREATE_TIMEOUT_MS || 15_000);
    const SPAWN_TIMEOUT_MS = Number(process.env.PHASE4_SPAWN_TIMEOUT_MS || 15_000);
    const ENTITY_DRAIN_MS = Number(process.env.PHASE4_ENTITY_DRAIN_MS || 6_000);
    const TELEPORT_TIMEOUT_MS = Number(process.env.PHASE4_TELEPORT_TIMEOUT_MS || 5_000);
    // Step A's leaf-bake settle time — Phase B depends on Phase A's
    // building geometry having loaded so the AABB index has buildings
    // bucketed before the W-hold begins.
    const GEOMETRY_BAKE_MS = Number(process.env.PHASE6_GEOMETRY_BAKE_MS || 3_000);
    // How long to hold W. Walk speed is 1.0 m/s in retail; 3 seconds
    // would normally produce ~3 m of motion in open ground (matches
    // step 3's WALK_HOLD_MS). Phase B should clamp this to ~0 m when
    // walking into a wall.
    const WALK_HOLD_MS = Number(process.env.PHASE4_WALK_HOLD_MS || 3_000);
    // Settle time after key release for the final PublicUpdatePosition
    // echo to land. ACE keeps simulating for a tick or two after the
    // motion-state-clear arrives.
    const SETTLE_MS = Number(process.env.PHASE4_SETTLE_MS || 1_500);
    // Phase B PASS threshold — max distance the local player should
    // travel when walking straight at a wall. 0.5 m allows for a
    // single client tick of integration before the AABB sweep catches
    // it (60 Hz × 1.0 m/s = ~1.7 cm/tick; 0.5 m is ~30 ticks of slop).
    const WALL_BLOCK_THRESHOLD_M = Number(process.env.PHASE6_WALL_BLOCK_THRESHOLD_M || 0.5);
    // Phase B FAIL threshold — if the player walked further than this
    // into the wall, the collision is clearly NOT active and the
    // failure message should call that out distinctly from "delta a
    // bit too high" (which might be mis-calibrated wall heading).
    const WALL_CLIP_FAIL_THRESHOLD_M = Number(process.env.PHASE6_WALL_CLIP_FAIL_THRESHOLD_M || 1.0);
    // Control-walk threshold — the no-wall direction needs to confirm
    // the input path actually works at all. ≥ 2 m in 3 s is well clear
    // of NPC ambient drift (cm/s) and well clear of the WALL_BLOCK
    // threshold above; if this fails the test environment is broken,
    // not Phase B.
    const CONTROL_MIN_DELTA_M = Number(process.env.PHASE6_CONTROL_MIN_DELTA_M || 2.0);

    console.log(`launching chromium → ${PAGE_URL}`);
    console.log(`target ACE: ${SERVER_IP}:${SERVER_PORT} via ${BRIDGE_URL}`);
    console.log(`account: ${ACCOUNT}, character: ${CHAR_NAME}`);
    const browser = await chromium.launch({
        args: ["--use-gl=swiftshader"],
    });
    const context = await browser.newContext({
        viewport: { width: 1280, height: 1024 },
    });
    const page = await context.newPage();

    page.on("console", (msg) => {
        const text = msg.text();
        // Surface anything that looks load-bearing for Phase B
        // (collision / AABB / project_pose / sweep trace lines)
        // alongside the standard error / warn channels.
        if (
            msg.type() === "error"
            || msg.type() === "warning"
            || /\[step|collision|aabb|sweep|project_pose|building|clamp/i.test(text)
        ) {
            console.log(`[browser ${msg.type()}] ${text}`);
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
        }, { timeout: 30_000 });
        console.log("smoke checks PASS");
    } catch (e) {
        const html = await page.locator("#results").innerHTML();
        console.error("results panel content:", html.slice(0, 500));
        await browser.close();
        process.exit(1);
    }

    await page.fill('input[name="account"]', ACCOUNT);
    await page.fill('input[name="password"]', PASSWORD);
    await page.fill('input[name="bridge_url"]', BRIDGE_URL);
    // server_host (NOT server_ip — step 3's selector is stale; step A
    // uses the current name).
    await page.fill('input[name="server_host"]', SERVER_IP);
    await page.fill('input[name="server_port"]', SERVER_PORT);
    console.log(`submitting login as ${ACCOUNT}`);

    await page.click('#login-form button[type=submit]');
    await page.waitForSelector("#selection:not([hidden])", { timeout: 30_000 });
    console.log("Selection visible");
    await page.waitForTimeout(500);

    // Mirror step A: populate the account if it's empty.
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

    try {
        await page.waitForSelector("#post-spawn:not([hidden])", { timeout: TELEPORT_TIMEOUT_MS });
        console.log("Teleport block unhid");
    } catch (e) {
        console.warn("Teleport block never unhid — bailing.");
        await page.screenshot({ path: OUT_PATH, fullPage: false });
        await browser.close();
        process.exit(1);
    }

    console.log("clicking Teleport to Holtburg button");
    await page.click("#teleport-button");
    console.log(`waiting ${ENTITY_DRAIN_MS}ms for entity drain post-teleport`);
    await page.waitForTimeout(ENTITY_DRAIN_MS);

    // `@pk pk` enables FastTick — Phase B *requires* this because
    // ACE's server-side authoritative physics only simulates for PK
    // players (Player_Tick.cs:178). Without FastTick, ACE never
    // echoes PublicUpdatePosition, so the JS sprite never moves and
    // both the wall-walk and the control walk would silently zero
    // out, indistinguishable from a working collision clamp. See
    // capture_phase4_step3.cjs:170-189 for the full rationale.
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

    // Allow Phase A's leaf-bake to settle. We need the building
    // geometry — and therefore the AABB index Phase B builds from
    // it — to have populated for the visible Holtburg neighbourhood
    // before the W-hold begins. Same delay as step A.
    console.log(`waiting ${GEOMETRY_BAKE_MS}ms for Phase A leaf-bake (and Phase B AABB index) to settle`);
    await page.waitForTimeout(GEOMETRY_BAKE_MS);

    // === Phase A presence guard =========================================
    //
    // Phase B depends on Phase A: without per-part building geometry,
    // there's nothing for the AABB index to extract from. If
    // `window.buildingMap` is missing entirely, fail loudly with a
    // dedicated message rather than letting the collision check report
    // a false "no clamp" positive (open world, no walls because no
    // buildings).
    //
    // TODO: confirm with implementation agent — `window.buildingMap` is
    // a placeholder name from step A's contract. If Phase A renames to
    // `window.liveScene.buildings` or similar, update this guard, the
    // step A capture, and the smoke check together.
    const phaseAPresent = await page.evaluate(() => {
        if (!window.buildingMap || typeof window.buildingMap.entries !== "function") {
            return { ok: false, reason: "window.buildingMap missing" };
        }
        let n = 0;
        for (const _ of window.buildingMap.entries()) n += 1;
        return { ok: n > 0, reason: n === 0 ? "window.buildingMap empty" : null, count: n };
    });
    if (!phaseAPresent.ok) {
        console.error(
            `FAIL (phase-A-not-present): ${phaseAPresent.reason}. `
            + `Phase B (collision) cannot be validated until Phase A (per-part `
            + `building geometry) is live — see docs/phase-6-buildings-and-interiors.md §5.`
        );
        await page.screenshot({ path: OUT_PATH, fullPage: false });
        console.log(`saved ${OUT_PATH}`);
        await browser.close();
        process.exit(1);
    }
    console.log(`phase A guard OK: window.buildingMap has ${phaseAPresent.count} buildings`);

    // === Phase B optional symbol probe ===================================
    //
    // If Phase B exposes a wasm-side AABB-count getter for testing
    // (`window.__buildingAabbCount` or similar), surface it for the
    // diagnostic log. Not load-bearing — the behavioural assertion
    // below is what gates pass/fail. This is purely informational.
    //
    // TODO: confirm with implementation agent — placeholder window
    // accessor name. Likely candidates from §4.2 of the plan:
    //   - `window.__buildingAabbCount` — total AABBs across all cells.
    //   - `window.__buildingAabbIndexSize` — number of cell buckets.
    //   - A wasm export like `wasm.holtburg_townhall_aabb_count()`
    //     mirroring step A's `holtburg_townhall_max_parts`.
    const aabbProbe = await page.evaluate(() => {
        const out = { source: "none", value: null };
        if (typeof window.__buildingAabbCount === "number") {
            out.source = "window.__buildingAabbCount";
            out.value = window.__buildingAabbCount;
        } else if (typeof window.__buildingAabbIndexSize === "number") {
            out.source = "window.__buildingAabbIndexSize";
            out.value = window.__buildingAabbIndexSize;
        }
        return out;
    });
    if (aabbProbe.value !== null) {
        console.log(`phase B AABB probe: ${aabbProbe.source}=${aabbProbe.value}`);
    } else {
        console.log(
            "phase B AABB probe: no debug accessor exposed (window.__buildingAabbCount "
            + "/ __buildingAabbIndexSize). Behaviour-only validation will follow."
        );
    }

    // Pre-walk snapshot: every (guid → {x, y}) on window.entityMap.
    // Same shape as capture_phase4_step3.cjs:196-206 — entityMap is a
    // Map<u32, { sprite: PIXI.Container, modelId }>; each sprite
    // carries world-coord position via .x/.y in metres.
    async function snapshotEntities() {
        return page.evaluate(() => {
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
    }

    // Compute the largest pre→post delta across all entities. Step 3's
    // approach: the local player isn't directly identified (the guid
    // is closure-private), but it's the only entity walking >>1 m in
    // 3 seconds — NPCs ambient-drift on the cm-per-second floor.
    function maxDelta(pre, post) {
        let max = 0;
        let movedGuid = null;
        let movedFrom = null;
        let movedTo = null;
        for (const [guid, postPos] of Object.entries(post)) {
            const prePos = pre[guid];
            if (!prePos) continue;
            const dx = postPos.x - prePos.x;
            const dy = postPos.y - prePos.y;
            const d = Math.hypot(dx, dy);
            if (d > max) {
                max = d;
                movedGuid = guid;
                movedFrom = prePos;
                movedTo = postPos;
            }
        }
        return { max, movedGuid, movedFrom, movedTo };
    }

    // Move keyboard focus to the canvas so WASD goes through the
    // page-level keydown listener. Same pattern as step 3:218-227.
    await page.evaluate(() => {
        if (document.activeElement && typeof document.activeElement.blur === "function") {
            document.activeElement.blur();
        }
    });
    await page.locator("#canvas").click({ position: { x: 256, y: 256 }, force: true });
    const activeBefore = await page.evaluate(() => ({
        tag: document.activeElement?.tagName,
        id: document.activeElement?.id,
    }));
    console.log(`pre-walk: activeElement=${JSON.stringify(activeBefore)}`);

    // === Control walk: S held into open ground from spawn ================
    //
    // The Holtburg @telepoi spawn faces the town hall (W = into the
    // wall). Walking S from the same spawn goes AWAY from the town
    // hall into open ground — no buildings should be in the AABB
    // index along that path. Delta should be ≥ CONTROL_MIN_DELTA_M.
    //
    // Doing the control walk FIRST, before the wall walk, has two
    // benefits:
    //   1. Confirms the input path works before we invert the
    //      assertion (so a blanket "input broken" failure doesn't
    //      masquerade as "Phase B working").
    //   2. The wall walk re-teleports back to spawn before running,
    //      giving us a clean known-position starting point for the
    //      collision assertion.
    console.log("=================================================================");
    console.log("CONTROL WALK: S held for 3s into open ground (no AABBs expected)");
    console.log("=================================================================");
    const controlPre = await snapshotEntities();
    const controlPreCount = Object.keys(controlPre).length;
    console.log(`control pre-walk: ${controlPreCount} entities tracked`);

    console.log(`pressing S for ${WALK_HOLD_MS}ms (control direction)`);
    await page.keyboard.down("s");
    await page.waitForTimeout(WALK_HOLD_MS);
    await page.keyboard.up("s");
    console.log(`releasing S; settling ${SETTLE_MS}ms for final echo`);
    await page.waitForTimeout(SETTLE_MS);

    const controlPost = await snapshotEntities();
    const controlDelta = maxDelta(controlPre, controlPost);
    console.log(
        `control max delta: ${controlDelta.max.toFixed(2)} m `
        + `(guid ${controlDelta.movedGuid !== null
            ? `0x${Number(controlDelta.movedGuid).toString(16).toUpperCase().padStart(8, "0")}`
            : "(none)"})`
    );
    if (controlDelta.movedFrom && controlDelta.movedTo) {
        console.log(
            `    from (${controlDelta.movedFrom.x.toFixed(2)}, ${controlDelta.movedFrom.y.toFixed(2)}) `
            + `to (${controlDelta.movedTo.x.toFixed(2)}, ${controlDelta.movedTo.y.toFixed(2)})`
        );
    }

    // === Wall walk: W held straight at the town hall wall ================
    //
    // Re-teleport to Holtburg spawn so the wall walk starts from a
    // known position adjacent to the town hall. Without this, the
    // control walk above moved us several metres south, and the W
    // walk would no longer hit the wall.
    console.log("=================================================================");
    console.log("re-teleporting to Holtburg spawn for clean wall-walk start");
    console.log("=================================================================");
    await page.click("#teleport-button");
    console.log(`waiting ${ENTITY_DRAIN_MS}ms for re-teleport drain`);
    await page.waitForTimeout(ENTITY_DRAIN_MS);

    // Re-blur + re-focus the canvas after the teleport (the click on
    // #teleport-button moves focus to the button).
    await page.evaluate(() => {
        if (document.activeElement && typeof document.activeElement.blur === "function") {
            document.activeElement.blur();
        }
    });
    await page.locator("#canvas").click({ position: { x: 256, y: 256 }, force: true });

    console.log("=================================================================");
    console.log("WALL WALK: W held for 3s straight at Holtburg town hall wall");
    console.log("=================================================================");
    const wallPre = await snapshotEntities();
    const wallPreCount = Object.keys(wallPre).length;
    console.log(`wall pre-walk: ${wallPreCount} entities tracked`);
    if (wallPreCount === 0) {
        console.error("No entities in entityMap post-reteleport — bailing.");
        await page.screenshot({ path: OUT_PATH, fullPage: false });
        await browser.close();
        process.exit(1);
    }

    console.log(`pressing W for ${WALK_HOLD_MS}ms (into wall direction)`);
    await page.keyboard.down("w");
    await page.waitForTimeout(WALK_HOLD_MS);
    await page.keyboard.up("w");
    console.log(`releasing W; settling ${SETTLE_MS}ms for final echo`);
    await page.waitForTimeout(SETTLE_MS);

    const wallPost = await snapshotEntities();
    const wallDelta = maxDelta(wallPre, wallPost);
    console.log(
        `wall max delta: ${wallDelta.max.toFixed(2)} m `
        + `(guid ${wallDelta.movedGuid !== null
            ? `0x${Number(wallDelta.movedGuid).toString(16).toUpperCase().padStart(8, "0")}`
            : "(none)"})`
    );
    if (wallDelta.movedFrom && wallDelta.movedTo) {
        console.log(
            `    from (${wallDelta.movedFrom.x.toFixed(2)}, ${wallDelta.movedFrom.y.toFixed(2)}) `
            + `to (${wallDelta.movedTo.x.toFixed(2)}, ${wallDelta.movedTo.y.toFixed(2)})`
        );
    }

    // Screenshot at the end-of-walk position (player against wall, if
    // Phase B is working). Same framing convention as step A.
    await page.evaluate(() => {
        const canvasElem = document.getElementById("canvas");
        if (canvasElem) canvasElem.scrollIntoView({ block: "start" });
    });
    await page.waitForTimeout(200);
    await page.screenshot({ path: OUT_PATH, fullPage: false });
    console.log(`saved ${OUT_PATH}`);

    // === Verdict =========================================================
    //
    // Phase B PASS: control walked ≥ 2 m AND wall walked < 0.5 m.
    // Phase B FAIL with clipped-through-wall:
    //              control walked ≥ 2 m AND wall walked ≥ 1 m
    //              (collision clearly not active).
    // Phase B FAIL with marginal:
    //              control walked ≥ 2 m AND wall walked between
    //              0.5 m and 1 m (collision partially working but
    //              clamp threshold needs tightening).
    // Environment FAIL: control walked < 2 m
    //              (input path broken, NOT a Phase B verdict).
    console.log("=========================");
    console.log(`CONTROL_MIN_DELTA_M=${CONTROL_MIN_DELTA_M}, control walked ${controlDelta.max.toFixed(2)} m`);
    console.log(`WALL_BLOCK_THRESHOLD_M=${WALL_BLOCK_THRESHOLD_M}, wall walked ${wallDelta.max.toFixed(2)} m`);
    console.log(`WALL_CLIP_FAIL_THRESHOLD_M=${WALL_CLIP_FAIL_THRESHOLD_M}`);

    const controlOk = controlDelta.max >= CONTROL_MIN_DELTA_M;
    const wallBlocked = wallDelta.max < WALL_BLOCK_THRESHOLD_M;
    const wallClippedThroughHard = wallDelta.max >= WALL_CLIP_FAIL_THRESHOLD_M;

    if (!controlOk) {
        console.error(
            `FAIL (environment): control walk delta ${controlDelta.max.toFixed(2)} m `
            + `< ${CONTROL_MIN_DELTA_M} m. The input path itself isn't producing motion — `
            + `this is NOT a Phase B verdict. Check capture_phase4_step3.cjs first to `
            + `confirm WASD wire round-trip is healthy.`
        );
        await browser.close();
        process.exit(1);
    }

    if (controlOk && wallBlocked) {
        console.log(
            `PASS: Phase B collision active. Control walk delta `
            + `${controlDelta.max.toFixed(2)} m (>= ${CONTROL_MIN_DELTA_M} m, ` +
            `confirms input wire is healthy), wall walk delta `
            + `${wallDelta.max.toFixed(2)} m (< ${WALL_BLOCK_THRESHOLD_M} m, ` +
            `confirms project_pose_by_velocity clamps against the AABB index). ` +
            `Phase B contract met: walking into a wall stops the player; walking ` +
            `in open ground slides freely.`
        );
        await browser.close();
        process.exit(0);
    }

    if (controlOk && wallClippedThroughHard) {
        console.error(
            `FAIL: Phase B collision not active — clipped through wall. `
            + `Control walk delta ${controlDelta.max.toFixed(2)} m confirms input wire is healthy, `
            + `but wall walk delta ${wallDelta.max.toFixed(2)} m is >= `
            + `${WALL_CLIP_FAIL_THRESHOLD_M} m. The local player passed straight through `
            + `the town hall wall — project_pose_by_velocity is not consulting the AABB `
            + `index, or the index is empty for the current cell. See `
            + `crates/holtburger-world/src/spatial/physics.rs:308-319.`
        );
        await browser.close();
        process.exit(1);
    }

    // controlOk && !wallBlocked && !wallClippedThroughHard
    // — wall delta between 0.5 m and 1 m. Collision partially active.
    console.error(
        `FAIL: Phase B collision marginal. Control walk delta `
        + `${controlDelta.max.toFixed(2)} m confirms input wire is healthy, but wall `
        + `walk delta ${wallDelta.max.toFixed(2)} m is between ${WALL_BLOCK_THRESHOLD_M} m `
        + `and ${WALL_CLIP_FAIL_THRESHOLD_M} m. AABB sweep may be running but capsule `
        + `radius / clamp epsilon needs tuning. See physics.rs project_pose_by_velocity.`
    );
    await browser.close();
    process.exit(1);
})().catch((err) => {
    console.error("capture failed:", err);
    process.exit(1);
});
