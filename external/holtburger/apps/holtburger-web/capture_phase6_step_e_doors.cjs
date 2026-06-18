// Phase 6 step E capture script — drives the bundle through login →
// CharacterCreate (if needed) → spawn → @pk pk → (optional /godly) →
// @telepoi Holtburg → entity drain, then walks toward a closed door
// in Holtburg, asserts the door BLOCKS the player (Phase B AABB
// present, < 0.5 m delta), CLICKS the door via
// `__sessionHandle.useObject(doorGuid)` (Phase 4 step 5 pattern),
// waits for the `kind=14 UseDone` echo from ACE + the
// `PublicWeenieDesc.DoorState` propagation, then confirms the door
// state flips, the door sprite rotation animates, the AABB drops out
// of the index, and walking through the now-open door succeeds with
// delta ≥ 1 m.
//
// Phase E's contract (per docs/phase-6-buildings-and-interiors.md §5):
//   1. A closed door is in the Phase B AABB index — walking into it
//      clamps the player.
//   2. Clicking the door sends `kind=14 UseDone` from ACE; server
//      flips door state to open; ACE pushes the new `DoorState` via
//      `PublicWeenieDesc`. The client emits a
//      `WorldEvent::DoorStateChanged { guid, state }` (placeholder
//      name).
//   3. Client renders the door GfxObj sprite rotated around its
//      hinge frame on state change. Hinge frame is part_index-
//      relative; the rotation is precomputed on the Phase A part
//      walk.
//   4. Phase B's AABB index DROPS the door's entry on open and
//      RE-INSERTS on close.
//   5. Walking forward through the now-open door succeeds (delta
//      ≥ 1 m, vs the < 0.5 m we just clamped to).
//
// ====================================================================
// 3D PORT (item 9b, 2026-06-18) — UNVALIDATED (no Playwright in the
// porting env; this MUST be run under Playwright to confirm). The
// original drove the 2D PIXI path (entry.sprite / window.buildingMap /
// window.liveScene.doorStates). Under the default ?renderer=3d (since
// the 2D-pixi retirement, item 2) the live door renderer is the kind=15
// DoorStateChanged arm at index.html:7388-7406, which:
//   - sets window.__doorStates: Map<guid,"open"|"closed">  (state)
//   - resolves the door entity inst via
//       window.liveScene3d.entityManager.entityMap.get(guid)
//   - rotates inst.root.rotation.z (0 closed → -π/2 open) on the SNAP
//     path, OR plays em3d.playDoorMotion(...) under unifiedMotion=door
//     (default-on). **CAVEAT (E.2):** under unified door motion the
//     swing is animation-driven, so inst.root.rotation.z may stay ~0 —
//     the snap-path delta is only the signal with ?unifiedMotion=off.
//     The mode-independent door signal is the __doorStates flip; the
//     root-rotation check is the visual confirmation and is the one
//     assertion that may need a validation-run tweak (run with
//     ?unifiedMotion=off, or extend to a motion-state probe).
// Positions are read from getLocalPlayerPose() (wasm, renderer-agnostic)
// converted to world coords, NOT 2D sprite.x/y. Building presence comes
// from window.buildingMap3d (the 3D mirror of the 2D window.buildingMap).
//
// 3D coverage siblings (the 2D Phase A/B/C + phase4 captures this file
// once referenced were deleted in item 9a — see
// docs/2d-pixi-retirement-DELETED-CAPTURES.md):
//   - capture_phase7_2_buildings.cjs  — 3D building geometry presence.
//   - capture_3d_movement_e2e.cjs     — 3D keyboard-drive + movement.
//   - capture_phase4_step5.cjs (deleted) — useObject + kind=12/13/14
//     pattern, still mirrored inline here (renderer-agnostic).
// ====================================================================
//
// === Door-discovery heuristic ========================================
//
// The user has not provided exact door coordinates for the harness.
// We therefore use a "walk-until-you-see" heuristic to find a closed
// door:
//
//   1. After @telepoi Holtburg + entity drain, scan the 3D
//      liveScene3d.entityManager.entityMap for any inst whose
//      meta.name matches /door/i AND whose door state reads "closed"
//      (absent-state ⇒ "closed", since ACE doors spawn closed).
//   2. If none is in range immediately, walk forward (W) up to ~10 m
//      total in 2 m increments, scanning between each step. Holtburg
//      houses have a door weenie at each portal; the @telepoi spawn
//      faces the town hall front porch, so the first door we find is
//      probably the town hall front door (an excellent test target —
//      it definitely blocks when closed).
//   3. If no door appears after 10 m of walking, FAIL with the
//      "no Door weenie surfaced; harness needs known door coords"
//      diagnostic so the implementation agent can wire @teleloc to a
//      known door cell instead.
//
// This heuristic depends on the implementation agent populating the
// per-entity door-state field on the same entityMap entries that
// Phase 4 already exposes (so the appraisal-text + Use handler path
// at lib.rs:2975-3394 already covers these weenies). If door entities
// are tracked in a SEPARATE map (e.g. window.__doorEntities) the
// heuristic below needs to scan that map too — the implementation
// agent should update the discovery loop in the same commit.
//
// Pre-reqs (same as `capture_phase6_step_d_floors.cjs`):
// - Live ACE on Tailscale 100.116.47.66 UDP 9000 (login) / 9001 (world).
// - holtburger-wsbridge running on ws://127.0.0.1:8080/.
// - python3 -m http.server 8765 from external/holtburger/.
// - Manifest+shards baked under dist/ (the index.html consumes them
//   via init_resource_source).
// - The test account needs accessLevel >= 4 for `@telepoi`, `@pk`,
//   and `/godly`. Tailnet creds `tailnet1/tailnet1` are pre-promoted
//   to Developer.
//
// Run: `node capture_phase6_step_e_doors.cjs` from
// `apps/holtburger-web/`. Outputs
// `docs/images/phase-6-step-e-doors-closed.png` and
// `docs/images/phase-6-step-e-doors-open.png` and prints PASS / FAIL
// based on the closed-block + open-rotate + open-pass + state-flip
// assertions.

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
    const OUT_CLOSED_PATH = path.resolve(
        __dirname,
        "../../../../docs/images/phase-6-step-e-doors-closed.png"
    );
    const OUT_OPEN_PATH = path.resolve(
        __dirname,
        "../../../../docs/images/phase-6-step-e-doors-open.png"
    );
    const CHAR_NAME = process.env.PHASE6_CHAR_NAME
        || `Phase6E${Date.now().toString(36).slice(-6)}`;
    const CREATE_TIMEOUT_MS = Number(process.env.PHASE4_CREATE_TIMEOUT_MS || 15_000);
    const SPAWN_TIMEOUT_MS = Number(process.env.PHASE4_SPAWN_TIMEOUT_MS || 15_000);
    const ENTITY_DRAIN_MS = Number(process.env.PHASE4_ENTITY_DRAIN_MS || 6_000);
    const TELEPORT_TIMEOUT_MS = Number(process.env.PHASE4_TELEPORT_TIMEOUT_MS || 5_000);
    // Phase A's leaf-bake settle (door geometry rides on the
    // per-part walk, so we need it complete before sprite-rotation
    // assertions are stable).
    const GEOMETRY_BAKE_MS = Number(process.env.PHASE6_GEOMETRY_BAKE_MS || 3_000);
    // Total walk budget for the door-discovery heuristic. We walk in
    // ~2 m increments scanning entityMap between each step; 10 m is
    // enough to clear the @telepoi spawn and reach the first
    // Holtburg house's front door.
    const DISCOVERY_MAX_WALK_M = Number(process.env.PHASE6_DOOR_DISCOVERY_MAX_M || 10);
    const DISCOVERY_STEP_MS = Number(process.env.PHASE6_DOOR_DISCOVERY_STEP_MS || 2_000);
    // After useObject, ACE needs a moment to: (a) emit the
    // `kind=14 UseDone` echo, (b) update DoorState on its side,
    // (c) push a `PublicWeenieDesc` with the new state. 500 ms is
    // typical retail, 2 s gives a generous floor under tailnet
    // latency.
    const DOORSTATE_PROPAGATION_MS = Number(process.env.PHASE6_DOORSTATE_PROPAGATION_MS || 2_000);
    const USE_RESPONSE_MS = Number(process.env.PHASE4_USE_RESPONSE_MS || 5_000);
    // How long to hold W when walking INTO a closed door. 3 s at
    // 1 m/s would normally produce ~3 m of motion in open ground;
    // Phase B should clamp this to < 0.5 m at the door face.
    const WALK_HOLD_MS = Number(process.env.PHASE4_WALK_HOLD_MS || 3_000);
    // Settle time after key release for the final
    // PublicUpdatePosition echo to land.
    const SETTLE_MS = Number(process.env.PHASE4_SETTLE_MS || 1_500);
    // Phase E PASS / FAIL thresholds (mirror step B's calibration):
    //   - When the door is CLOSED: walking into it should clamp to
    //     < 0.5 m (CLOSED_BLOCK_THRESHOLD_M).
    //   - When the door is OPEN: walking forward should produce ≥ 1 m
    //     of motion (OPEN_PASS_THRESHOLD_M). The threshold is below
    //     step B's "control walk" floor (2 m) because we're walking a
    //     short doorway crossing, not a long open-ground stretch.
    const CLOSED_BLOCK_THRESHOLD_M = Number(process.env.PHASE6_CLOSED_BLOCK_THRESHOLD_M || 0.5);
    const OPEN_PASS_THRESHOLD_M = Number(process.env.PHASE6_OPEN_PASS_THRESHOLD_M || 1.0);
    // God-mode chat (memory: project_holtburger_godmode_falldamage).
    // Tip applies after @pk pk: walking on Holtburg's slope can over-
    // cap velocity post-collision-clamp and trigger the fall-damage
    // bug. /godly dodges it. Harmless if ACE doesn't recognize it.
    const GODMODE_CHAT = process.env.PHASE6_GODMODE_CHAT || "/godly";
    const ENABLE_GODMODE = process.env.PHASE6_ENABLE_GODMODE !== "0";

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

    // Mirror step 5: install a __step5Events-style buffer to capture
    // kind=12/13/14 events. Phase E specifically waits for kind=14
    // UseDone after the useObject dispatch.
    await page.addInitScript(() => {
        window.__phase6EUseEvents = []; // captured kind=12/13/14 events
    });

    page.on("console", (msg) => {
        const text = msg.text();
        // Surface anything that looks load-bearing for Phase E
        // (door / hinge / state / rotate / aabb / use / weenie trace
        // lines) alongside the standard error / warn channels.
        if (
            msg.type() === "error"
            || msg.type() === "warning"
            || /\[step|door|hinge|rotate|aabb|use|weenie|public.?weenie|state.?changed/i.test(text)
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
    // server_host (matches steps A/B/C/D; step 3's server_ip selector
    // is stale).
    await page.fill('input[name="server_host"]', SERVER_IP);
    await page.fill('input[name="server_port"]', SERVER_PORT);
    console.log(`submitting login as ${ACCOUNT}`);

    await page.click('#login-form button[type=submit]');
    await page.waitForSelector("#selection:not([hidden])", { timeout: 30_000 });
    console.log("Selection visible");
    await page.waitForTimeout(500);

    // Hook poll_events to capture kind=12/13/14 use-related events.
    // Same pattern as capture_phase4_step5.cjs:91-117.
    await page.evaluate(() => {
        const tryHook = () => {
            const h = window.__sessionHandle;
            if (!h || typeof h.poll_events !== "function") return false;
            const orig = h.poll_events.bind(h);
            h.poll_events = function () {
                const events = orig();
                for (const evt of events) {
                    if (evt.kind === 12 || evt.kind === 13 || evt.kind === 14) {
                        window.__phase6EUseEvents.push({
                            kind: evt.kind,
                            stringPayload: evt.stringPayload,
                            u32Payload: evt.u32Payload,
                            u32Payload2: evt.u32Payload2,
                            t: Date.now(),
                        });
                    }
                }
                return events;
            };
            return true;
        };
        if (!tryHook()) {
            const t = setInterval(() => { if (tryHook()) clearInterval(t); }, 100);
            setTimeout(() => clearInterval(t), 30_000);
        }
    });

    // Mirror step A: populate the account if it's empty.
    const initialButtonCount = await page.locator('#character-ul button[data-id]').count();
    if (initialButtonCount === 0) {
        const createFormVisible = await page.locator("#create-form:not([hidden])").count() > 0;
        if (!createFormVisible) {
            console.error("Create-character form is hidden — bailing.");
            await page.screenshot({ path: OUT_CLOSED_PATH, fullPage: false });
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
        await page.screenshot({ path: OUT_CLOSED_PATH, fullPage: false });
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
        await page.screenshot({ path: OUT_CLOSED_PATH, fullPage: false });
        await browser.close();
        process.exit(1);
    }

    // Helper to send chat through the session handle. Same pattern as
    // every other Phase 6 capture (steps A/B/C/D and Phase 4 step 3).
    async function sendChat(line) {
        return page.evaluate((l) => {
            if (window.__sessionHandle && typeof window.__sessionHandle.sendChat === "function") {
                try {
                    window.__sessionHandle.sendChat(l);
                    return "sent";
                } catch (e) {
                    return `err: ${e.message || e}`;
                }
            }
            return "handle not exposed";
        }, line);
    }

    // `@pk pk` enables FastTick — Phase E *requires* this because the
    // closed-door block assertion needs ACE to drive the player against
    // the door so the AABB sweep clamps the local sprite, and the
    // open-door pass assertion needs the local sprite to actually move
    // through. Without FastTick both assertions silently zero out.
    console.log("sending '@pk pk' to enable FastTick (server-side physics)");
    const pkResult = await sendChat("@pk pk");
    console.log(`@pk pk dispatch: ${pkResult}`);
    await page.waitForTimeout(2000);

    // God-mode tip per memory: project_holtburger_godmode_falldamage.
    // Walking on Holtburg's town slope post-collision-clamp can over-
    // cap velocity in the integrator and trigger fall damage. /godly
    // (or whatever ACE's exact incantation is) sidesteps it. Harmless
    // if ACE doesn't recognize the command.
    if (ENABLE_GODMODE && GODMODE_CHAT) {
        console.log(`sending god-mode chat: '${GODMODE_CHAT}'`);
        const godResult = await sendChat(GODMODE_CHAT);
        console.log(`god-mode dispatch: ${godResult}`);
        await page.waitForTimeout(1500);
    } else {
        console.log("skipping god-mode (PHASE6_ENABLE_GODMODE=0 or empty PHASE6_GODMODE_CHAT)");
    }

    console.log("clicking Teleport to Holtburg button");
    await page.click("#teleport-button");
    console.log(`waiting ${ENTITY_DRAIN_MS}ms for entity drain post-teleport`);
    await page.waitForTimeout(ENTITY_DRAIN_MS);

    // Allow Phase A's leaf-bake (and Phase E's door-state map +
    // hinge-frame baking) to settle.
    console.log(`waiting ${GEOMETRY_BAKE_MS}ms for Phase A leaf-bake (and Phase E door state) to settle`);
    await page.waitForTimeout(GEOMETRY_BAKE_MS);

    // === Phase A presence guard =========================================
    //
    // Phase E depends on Phase A for the door part-mesh that we'll
    // observe rotating. Without buildingMap there's no per-part
    // sprite to read rotation off.
    const phaseAPresent = await page.evaluate(() => {
        // 3D building presence: window.buildingMap3d (the 3D mirror of
        // the retired 2D window.buildingMap), with liveScene3d.buildingsGroup
        // as the fallback (capture_phase7_2_buildings asserts the latter).
        if (window.buildingMap3d && typeof window.buildingMap3d.entries === "function") {
            let n = 0;
            for (const _ of window.buildingMap3d.entries()) n += 1;
            if (n > 0) return { ok: true, count: n, source: "window.buildingMap3d" };
        }
        const grp = window.liveScene3d && window.liveScene3d.buildingsGroup;
        const gc = grp && grp.children ? grp.children.length : 0;
        if (gc > 0) return { ok: true, count: gc, source: "liveScene3d.buildingsGroup" };
        return { ok: false, reason: "no 3D buildings (window.buildingMap3d / liveScene3d.buildingsGroup empty)" };
    });
    if (!phaseAPresent.ok) {
        console.error(
            `FAIL (phase-A-not-present): ${phaseAPresent.reason}. `
            + `Phase E (door geometry + state) cannot be validated until Phase A `
            + `(per-part building geometry) is live — the door GfxObj sprite is a `
            + `Phase A-emitted part. See docs/phase-6-buildings-and-interiors.md §5.`
        );
        await page.screenshot({ path: OUT_CLOSED_PATH, fullPage: false });
        console.log(`saved ${OUT_CLOSED_PATH}`);
        await browser.close();
        process.exit(1);
    }
    console.log(`phase A guard OK: ${phaseAPresent.source} has ${phaseAPresent.count} buildings`);

    // === Phase E door-state map presence guard ==========================
    //
    // Placeholder name `window.__doorStates` is a Map<u32, "open"|
    // "closed"> populated by the Phase E PublicWeenieDesc handler. If
    // the implementation agent picks a different name, update this
    // guard, the discovery loop below, and the smoke check together.
    const doorStateMapPresent = await page.evaluate(() => {
        // window.__doorStates is the live 3D door-state map (set by the
        // kind=15 DoorStateChanged handler, index.html:7369). liveScene3d
        // .doorStates is a defensive fallback if a future build relocates it.
        if (window.__doorStates && typeof window.__doorStates.entries === "function") {
            return { ok: true, source: "window.__doorStates" };
        }
        if (
            window.liveScene3d
            && window.liveScene3d.doorStates
            && typeof window.liveScene3d.doorStates.entries === "function"
        ) {
            return { ok: true, source: "window.liveScene3d.doorStates" };
        }
        return { ok: false, reason: "door state map not exposed (window.__doorStates absent)" };
    });
    if (!doorStateMapPresent.ok) {
        console.error(
            `FAIL (door-state-map-absent): ${doorStateMapPresent.reason}. `
            + `Expected window.__doorStates: Map<u32, "open"|"closed"> (set by the kind=15 `
            + `DoorStateChanged handler at index.html:7369) per `
            + `docs/phase-6-buildings-and-interiors.md §5 phase E step 2 — populated `
            + `from PublicWeenieDesc.DoorState updates as ACE pushes them.`
        );
        await page.screenshot({ path: OUT_CLOSED_PATH, fullPage: false });
        console.log(`saved ${OUT_CLOSED_PATH}`);
        await browser.close();
        process.exit(1);
    }
    console.log(`phase E guard OK: door state map at ${doorStateMapPresent.source}`);

    // Pre-walk snapshot helper. The 2D path scanned every entity sprite
    // and let maxDelta() pick out the local player (the only thing moving
    // >>1 m). Under 3D there is no window.entityMap sprite layer, so we
    // snapshot the LOCAL PLAYER directly via getLocalPlayerPose() (a wasm,
    // renderer-agnostic getter) and convert landblock-local (x,y in 0..192)
    // → world metres: wx = ((lbId>>>24)&0xff)*192 + x. Keyed by "local" so
    // the unchanged maxDelta() computes the player's pre→post delta.
    async function snapshotEntities() {
        return page.evaluate(() => {
            const out = {};
            const h = window.__sessionHandle;
            if (h && typeof h.getLocalPlayerPose === "function") {
                try {
                    const p = h.getLocalPlayerPose();
                    if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) {
                        const lb = (p.landblockId ?? p.landblock ?? 0) >>> 0;
                        const wx = ((lb >>> 24) & 0xff) * 192 + p.x;
                        const wy = ((lb >>> 16) & 0xff) * 192 + p.y;
                        out.local = { x: wx, y: wy };
                    }
                } catch (_) {}
            }
            return out;
        });
    }

    // Compute the largest pre→post delta across all entities. Step B
    // approach: the local player isn't directly identified, but it's
    // the only entity walking >>1 m in 3 seconds.
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

    // === Door discovery via walk-until-you-see ==========================
    //
    // Scan the 3D liveScene3d.entityManager.entityMap for a closed door.
    // If none is in range immediately, walk forward in DISCOVERY_STEP_MS
    // increments (~2 m at 1 m/s) up to DISCOVERY_MAX_WALK_M total.
    //
    // The probe returns the first door entity whose:
    //   - meta.name matches /door/i (case-insensitive)
    //   - door state reads "closed" (absent-state ⇒ "closed")
    //   - inst.root.rotation.z is readable (for the baseline + post
    //     comparison)
    async function findClosedDoor() {
        return page.evaluate(() => {
            // 3D: scan the EntityManager's entityMap (window.entityMap is
            // empty under renderer=3d). inst.meta.name carries the weenie
            // name (entities.js:3551); door rotation lives on
            // inst.root.rotation.z (kind=15 handler, index.html:7402).
            const em = window.liveScene3d && window.liveScene3d.entityManager;
            const emMap = em && em.entityMap;
            if (!emMap || typeof emMap.entries !== "function") return null;
            const doorStates = window.__doorStates
                || (window.liveScene3d && window.liveScene3d.doorStates)
                || null;
            for (const [guid, inst] of emMap.entries()) {
                const name = inst?.meta?.name || "";
                if (!/door/i.test(name)) continue;
                const g = guid >>> 0;
                // State: per-entity mirror inst.__doorState (set by the
                // kind=15 handler) or the shared __doorStates map. A door
                // that hasn't fired a DoorStateChanged since spawn is in
                // NEITHER yet — ACE doors spawn "closed", so treat an
                // absent state as "closed" (the discovery target).
                let state = null;
                if (typeof inst.__doorState === "string") {
                    state = inst.__doorState;
                } else if (doorStates && typeof doorStates.get === "function") {
                    const v = doorStates.get(g);
                    if (typeof v === "string") state = v;
                }
                if (state === null) state = "closed";
                if (state !== "closed") continue;
                // 3D rotation: inst.root.rotation.z (snap path: 0 → -π/2).
                // Under unifiedMotion=door (default) the swing is anim-driven
                // and root.z may stay 0 — see the header E.2 caveat.
                let rotation = null, x = 0, y = 0;
                if (inst.root) {
                    if (typeof inst.root.rotation?.z === "number") {
                        rotation = inst.root.rotation.z;
                    }
                    const pos = inst.root.position;
                    if (pos) { x = pos.x ?? 0; y = pos.y ?? 0; }
                }
                return {
                    guid: g,
                    name,
                    state,
                    rotation,
                    x,
                    y,
                    wcid: (inst?.meta?.wcid ?? 0) >>> 0,
                    category: inst?.meta?.category || "(unknown)",
                };
            }
            return null;
        });
    }

    await page.evaluate(() => {
        if (document.activeElement && typeof document.activeElement.blur === "function") {
            document.activeElement.blur();
        }
    });
    await page.locator("#canvas").click({ position: { x: 256, y: 256 }, force: true });

    let closedDoor = await findClosedDoor();
    let walkedM = 0;
    while (!closedDoor && walkedM < DISCOVERY_MAX_WALK_M) {
        console.log(
            `door discovery: no closed door in entityMap; walking W for `
            + `${DISCOVERY_STEP_MS}ms (~${(DISCOVERY_STEP_MS / 1000).toFixed(1)} m at 1 m/s)`
        );
        await page.keyboard.down("w");
        await page.waitForTimeout(DISCOVERY_STEP_MS);
        await page.keyboard.up("w");
        await page.waitForTimeout(500); // settle
        walkedM += (DISCOVERY_STEP_MS / 1000); // approx
        closedDoor = await findClosedDoor();
    }

    if (!closedDoor) {
        console.error(
            `FAIL (no-door-found): no Door weenie surfaced; harness needs known door coords. `
            + `Walked ${walkedM.toFixed(1)} m total without finding any entityMap entry whose `
            + `meta.name matches /door/i AND has door state "closed". Either Holtburg's @telepoi `
            + `spawn faces the wrong direction (try @teleloc to a known door cell), or the `
            + `Phase E door-state map is being populated but the entityMap entries aren't being `
            + `tagged in step with it. See the door-discovery heuristic header in this script `
            + `for the env-var override path.`
        );
        await page.screenshot({ path: OUT_CLOSED_PATH, fullPage: false });
        console.log(`saved ${OUT_CLOSED_PATH}`);
        await browser.close();
        process.exit(1);
    }
    console.log(
        `closed door found: ${closedDoor.name} `
        + `(guid=0x${closedDoor.guid.toString(16).toUpperCase().padStart(8, "0")}, `
        + `wcid=${closedDoor.wcid}, state=${closedDoor.state}, `
        + `rotation=${closedDoor.rotation?.toFixed?.(4) ?? "(null)"}, `
        + `at (${closedDoor.x.toFixed(2)}, ${closedDoor.y.toFixed(2)})) `
        + `after ${walkedM.toFixed(1)} m of discovery walk`
    );

    if (closedDoor.rotation === null) {
        console.error(
            `FAIL (rotation-not-readable): door sprite has no readable rotation `
            + `(neither sprite.rotation nor sprite.children[0].rotation returned a number). `
            + `The sprite-rotation accessor placeholder needs to expose the hinge-frame rotation `
            + `as a numeric ".rotation" on the sprite (or its first child). See `
            + `docs/phase-6-buildings-and-interiors.md §5 phase E step 3.`
        );
        await page.screenshot({ path: OUT_CLOSED_PATH, fullPage: false });
        console.log(`saved ${OUT_CLOSED_PATH}`);
        await browser.close();
        process.exit(1);
    }

    const closedRotationBaseline = closedDoor.rotation;

    // === Pre-open: walk into the closed door ============================
    //
    // The closed door should clamp the player (Phase B AABB present).
    // Mirror step B's wall-walk pattern: hold W for WALK_HOLD_MS,
    // assert post-walk delta < CLOSED_BLOCK_THRESHOLD_M.
    console.log("=================================================================");
    console.log(`CLOSED-DOOR BLOCK: W held for ${WALK_HOLD_MS}ms toward closed door`);
    console.log("=================================================================");
    const closedPre = await snapshotEntities();
    const closedPreCount = Object.keys(closedPre).length;
    console.log(`closed pre-walk: ${closedPreCount} entities tracked`);

    // Re-blur + re-focus the canvas (we may have lost focus during
    // discovery walk + sprite scans).
    await page.evaluate(() => {
        if (document.activeElement && typeof document.activeElement.blur === "function") {
            document.activeElement.blur();
        }
    });
    await page.locator("#canvas").click({ position: { x: 256, y: 256 }, force: true });

    await page.keyboard.down("w");
    await page.waitForTimeout(WALK_HOLD_MS);
    await page.keyboard.up("w");
    console.log(`releasing W; settling ${SETTLE_MS}ms for final echo`);
    await page.waitForTimeout(SETTLE_MS);

    const closedPost = await snapshotEntities();
    const closedDelta = maxDelta(closedPre, closedPost);
    console.log(
        `closed-door walk max delta: ${closedDelta.max.toFixed(2)} m `
        + `(threshold < ${CLOSED_BLOCK_THRESHOLD_M} m)`
    );

    // Closed-state screenshot.
    await page.evaluate(() => {
        const canvasElem = document.getElementById("canvas");
        if (canvasElem) canvasElem.scrollIntoView({ block: "start" });
    });
    await page.waitForTimeout(200);
    await page.screenshot({ path: OUT_CLOSED_PATH, fullPage: false });
    console.log(`saved ${OUT_CLOSED_PATH}`);

    // Verify the closed-door block. If the player walked further than
    // CLOSED_BLOCK_THRESHOLD_M, Phase B's AABB index isn't covering
    // closed doors — Phase E's "closed door blocks" contract is
    // broken before we even click anything.
    if (closedDelta.max >= CLOSED_BLOCK_THRESHOLD_M) {
        console.error(
            `FAIL (closed-door-not-blocking): walking into the closed door produced `
            + `${closedDelta.max.toFixed(2)} m of motion (>= ${CLOSED_BLOCK_THRESHOLD_M} m). `
            + `The closed door's AABB is not in Phase B's index — Phase E's contract requires `
            + `closed doors to be in the AABB index (step 4 in §5 phase E). Either the door's `
            + `Setup AABB extraction is missing, or the Phase E AABB-toggle is starting in `
            + `"open" state by default. See docs/phase-6-buildings-and-interiors.md §5 phase E.`
        );
        await browser.close();
        process.exit(1);
    }

    // === Click the door =================================================
    //
    // Mirror step 5's useObject dispatch. Clear the use-event buffer
    // first so we only see the click's response.
    await page.evaluate(() => { window.__phase6EUseEvents = []; });

    console.log("=================================================================");
    console.log(`CLICK DOOR: useObject(0x${closedDoor.guid.toString(16).toUpperCase().padStart(8, "0")})`);
    console.log("=================================================================");
    const dispatchResult = await page.evaluate((guid) => {
        const h = window.__sessionHandle;
        if (!h || typeof h.useObject !== "function") return "handle missing";
        try {
            h.useObject(guid);
            return "sent";
        } catch (e) {
            return `err: ${e?.message ?? e}`;
        }
    }, closedDoor.guid);
    console.log(`useObject dispatch: ${dispatchResult}`);
    if (dispatchResult !== "sent") {
        console.error(`FAIL (useObject-dispatch): ${dispatchResult}`);
        await browser.close();
        process.exit(1);
    }

    // Wait for kind=14 UseDone (or kind=13 UseFailed — the latter
    // would be a hard fail because closed doors should always accept
    // a Use unless the player lacks a key, which a Developer-promoted
    // tester should never lack on Holtburg's town hall door).
    console.log(`waiting up to ${USE_RESPONSE_MS}ms for kind=14 UseDone`);
    let useDoneSeen = false;
    try {
        await page.waitForFunction(() => {
            const evts = window.__phase6EUseEvents || [];
            return evts.some((e) => e.kind === 14);
        }, { timeout: USE_RESPONSE_MS });
        useDoneSeen = true;
    } catch (_) {
        // fall through; we'll log + fail below
    }
    const useEvents = await page.evaluate(() => window.__phase6EUseEvents || []);
    console.log(`captured ${useEvents.length} use-related events:`);
    for (const e of useEvents) {
        const guidHex = e.u32Payload != null
            ? `0x${(e.u32Payload >>> 0).toString(16).toUpperCase().padStart(8, "0")}`
            : "—";
        console.log(`  kind=${e.kind} string="${e.stringPayload || ""}" u32=${guidHex}`);
    }

    if (!useDoneSeen) {
        console.error(
            `FAIL (no-UseDone): no kind=14 UseDone event within ${USE_RESPONSE_MS}ms after `
            + `useObject dispatch on door guid `
            + `0x${closedDoor.guid.toString(16).toUpperCase().padStart(8, "0")}. ACE either `
            + `rejected the Use silently (door may require a key, or the door weenie has a `
            + `non-trivial UseRequirements) or the wsbridge dropped the response. Captured `
            + `${useEvents.length} use-related events; expected at least one with kind=14.`
        );
        await browser.close();
        process.exit(1);
    }

    // Wait for DoorState propagation. ACE may need a tick or two
    // beyond UseDone to push the PublicWeenieDesc with the new
    // DoorState int property.
    console.log(`waiting ${DOORSTATE_PROPAGATION_MS}ms for PublicWeenieDesc.DoorState propagation`);
    await page.waitForTimeout(DOORSTATE_PROPAGATION_MS);

    // === Post-open assertions ===========================================
    //
    // Re-probe the same door:
    //   1. Door state is "open".
    //   2. Door sprite rotation differs from the closed baseline.
    //   3. Walking forward through the door succeeds (delta ≥ 1 m).
    const openDoor = await page.evaluate((guid) => {
        const em = window.liveScene3d && window.liveScene3d.entityManager;
        const emMap = em && em.entityMap;
        if (!emMap || typeof emMap.get !== "function") return null;
        const inst = emMap.get(guid >>> 0);
        if (!inst) return null;
        const doorStates = window.__doorStates
            || (window.liveScene3d && window.liveScene3d.doorStates)
            || null;
        let state = null;
        if (typeof inst.__doorState === "string") {
            state = inst.__doorState;
        } else if (doorStates && typeof doorStates.get === "function") {
            const v = doorStates.get(guid >>> 0);
            if (typeof v === "string") state = v;
        }
        let rotation = null;
        if (inst.root && typeof inst.root.rotation?.z === "number") {
            rotation = inst.root.rotation.z;
        }
        const pos = inst.root && inst.root.position;
        return {
            guid: guid >>> 0,
            name: inst?.meta?.name || "",
            state,
            rotation,
            x: pos?.x ?? 0,
            y: pos?.y ?? 0,
        };
    }, closedDoor.guid);

    if (!openDoor) {
        console.error(
            `FAIL (door-vanished): door guid `
            + `0x${closedDoor.guid.toString(16).toUpperCase().padStart(8, "0")} no longer in `
            + `entityMap after click. Did the click trigger a despawn? That would be a `
            + `wire bug — doors should remain in entityMap with state="open".`
        );
        await browser.close();
        process.exit(1);
    }
    console.log(
        `post-click: state=${openDoor.state}, `
        + `rotation=${openDoor.rotation?.toFixed?.(4) ?? "(null)"} `
        + `(closed baseline was ${closedRotationBaseline.toFixed(4)})`
    );

    // (E.1) Door state is now "open".
    if (openDoor.state !== "open") {
        console.error(
            `FAIL (door-state-not-open): expected state="open" after UseDone+propagation, `
            + `got state="${openDoor.state}". The PublicWeenieDesc.DoorState handler at `
            + `crates/holtburger-core/src/client/world/handlers/ is either not subscribed to `
            + `the right packet, or not extracting the DoorState int property correctly. See `
            + `docs/phase-6-buildings-and-interiors.md §5 phase E step 2.`
        );
        await browser.close();
        process.exit(1);
    }

    // (E.2) Door sprite rotation differs from the closed baseline.
    // Use a tolerance — even tiny floating-point drift between PIXI
    // ticks could otherwise pass; the real signal is "rotation
    // changed by more than noise". 0.01 rad (~0.6°) is a generous
    // floor; an actual hinge swing is on the order of π/2 (90°).
    // SOFT under the 3D port. The 2D path hard-failed if sprite.rotation
    // didn't change. In 3D the swing is EITHER a snap on inst.root.rotation.z
    // (?unifiedMotion=off → ~π/2 delta) OR — under the default
    // unifiedMotion=door — an animation-driven swing where root.z stays ~0
    // (the rotation lives in the played door motion, not the root transform).
    // A flat root.z is therefore NOT proof the door didn't swing. We WARN
    // (not FAIL): the mode-independent door signals are the state flip (E.1,
    // already asserted) and the AABB toggle / walk-through (E.3, below). To
    // hard-assert the visual swing, re-run with ?unifiedMotion=off.
    const rotationEpsilon = 0.01;
    const rotationReadable = typeof openDoor.rotation === "number"
        && Number.isFinite(openDoor.rotation);
    const rotationDelta = rotationReadable
        ? Math.abs(openDoor.rotation - closedRotationBaseline)
        : NaN;
    console.log(
        `root.z rotation delta: `
        + `${rotationReadable ? rotationDelta.toFixed(4) + " rad" : "(root.z not animated)"} `
        + `(epsilon ${rotationEpsilon})`
    );
    if (!rotationReadable || rotationDelta < rotationEpsilon) {
        console.warn(
            `WARN (door-root-rotation-flat): inst.root.rotation.z changed by `
            + `${rotationReadable ? rotationDelta.toFixed(4) : "(null)"} rad (< ${rotationEpsilon}). `
            + `Under unifiedMotion=door (default) the door swing is animation-driven, so a flat `
            + `root.z is EXPECTED here — NOT a failure. Re-run with ?unifiedMotion=off to assert `
            + `the root-rotation snap, or extend this probe to read the door motion state. The `
            + `state flip (E.1) and AABB toggle (E.3) remain the load-bearing door signals.`
        );
    } else {
        console.log(`door root-rotation swing confirmed: ${rotationDelta.toFixed(4)} rad`);
    }

    // (E.3) Walking through the now-open door succeeds.
    //
    // Re-blur + re-focus the canvas (we may have lost focus during
    // sprite/state scans).
    await page.evaluate(() => {
        if (document.activeElement && typeof document.activeElement.blur === "function") {
            document.activeElement.blur();
        }
    });
    await page.locator("#canvas").click({ position: { x: 256, y: 256 }, force: true });

    console.log("=================================================================");
    console.log(`OPEN-DOOR PASS: W held for ${WALK_HOLD_MS}ms through opened door`);
    console.log("=================================================================");
    const openPre = await snapshotEntities();
    await page.keyboard.down("w");
    await page.waitForTimeout(WALK_HOLD_MS);
    await page.keyboard.up("w");
    console.log(`releasing W; settling ${SETTLE_MS}ms for final echo`);
    await page.waitForTimeout(SETTLE_MS);
    const openPost = await snapshotEntities();
    const openDelta = maxDelta(openPre, openPost);
    console.log(
        `open-door walk max delta: ${openDelta.max.toFixed(2)} m `
        + `(threshold ≥ ${OPEN_PASS_THRESHOLD_M} m)`
    );

    // Open-state screenshot.
    await page.evaluate(() => {
        const canvasElem = document.getElementById("canvas");
        if (canvasElem) canvasElem.scrollIntoView({ block: "start" });
    });
    await page.waitForTimeout(200);
    await page.screenshot({ path: OUT_OPEN_PATH, fullPage: false });
    console.log(`saved ${OUT_OPEN_PATH}`);

    if (openDelta.max < OPEN_PASS_THRESHOLD_M) {
        console.error(
            `FAIL (aabb-toggle-not-wired): AABB index toggle not wired (open door still blocking). `
            + `Walking forward through the open door produced ${openDelta.max.toFixed(2)} m of `
            + `motion (< ${OPEN_PASS_THRESHOLD_M} m). The door's state flipped to "open" and the `
            + `sprite rotated, but the AABB is still in Phase B's index — Phase E's "Phase B AABB `
            + `index toggle: closed door = AABB present, open door = AABB removed" contract isn't `
            + `firing on DoorStateChanged. See docs/phase-6-buildings-and-interiors.md §5 phase E `
            + `step 4. (Compare: closed-walk delta was ${closedDelta.max.toFixed(2)} m, which `
            + `correctly clamped — so AABB extraction works; only the toggle is missing.)`
        );
        await browser.close();
        process.exit(1);
    }

    console.log("=========================");
    console.log(
        `PASS: Phase E door geometry + state active. `
        + `Closed door blocked at ${closedDelta.max.toFixed(2)} m (< ${CLOSED_BLOCK_THRESHOLD_M} m); `
        + `useObject -> kind=14 UseDone round-tripped; door state flipped closed → open; `
        + `door root.z swing ${rotationReadable && rotationDelta >= rotationEpsilon ? rotationDelta.toFixed(4) + " rad" : "(anim-driven; see E.2 WARN)"}; `
        + `walking through opened door succeeded at ${openDelta.max.toFixed(2)} m `
        + `(>= ${OPEN_PASS_THRESHOLD_M} m, AABB toggle confirmed). `
        + `Door wcid=${closedDoor.wcid}, name="${closedDoor.name}".`
    );
    await browser.close();
    process.exit(0);
})().catch((err) => {
    console.error("capture failed:", err);
    process.exit(1);
});
