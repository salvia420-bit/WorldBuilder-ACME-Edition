// Phase 6 step D capture script — drives the bundle through login →
// CharacterCreate (if needed) → spawn → @pk pk → @telepoi Holtburg →
// (optional /godly to dodge the persistent fall-damage bug) → walk up
// the town hall stairs and verify that active-cell tracking flips the
// visible cell set: the lower floor falls out of `window.__renderSet`,
// the upper floor pops in, and at least one cellContainer's `visible`
// flag toggles from true → false as the player crosses the stairwell
// portal.
//
// Phase D's contract (per docs/phase-6-buildings-and-interiors.md §5):
//   1. `WorldState::current_cell(pos: &WorldPosition) -> CellId` —
//      outdoor: derive from landblock + 8x8 grid; indoor: 3D AABB
//      containment across cached EnvCells. Stairs are EnvCell
//      portal connections between Z-stacked cells; the player
//      crosses a portal => current_cell shifts.
//   2. `WorldState::render_set(current: CellId, depth: u8)
//      -> HashSet<CellId>` — BFS across `cell_portal_graph`,
//      default depth=1.
//   3. JS-side surface (placeholder names):
//        - `window.__currentCellId: u32` — the cell the player is in,
//          updated each rAF tick from a wasm getter.
//        - `window.__renderSet: Set<u32>` — the cell ids currently
//          visible (current cell + portal-neighbours).
//      Phase D DROPS the simpler `window.__cellRenderEnabled` global
//      flag from Phase C — visibility is now driven by render-set
//      membership rather than a single boolean.
//   4. Per frame: `cellContainers.get(cid).visible =
//      renderSet.has(cid)` — walking up the stairs flips lower-floor
//      containers off and upper-floor containers on.
//
// Sibling tests:
//   - capture_phase6_step_a_geometry.cjs   — Phase A (per-part
//     building geometry; soft prerequisite — without buildings the
//     visual screenshots aren't meaningful, but Phase D's logic is
//     EnvCell-driven not building-driven).
//   - capture_phase6_step_b_collision.cjs  — Phase B (AABB collision;
//     hard prerequisite for the WALK part of the test — without
//     collision the player would drift off into the void without
//     touching the stairs at all).
//   - capture_phase6_step_c_envcells.cjs   — Phase C (cellContainers
//     registry; hard prerequisite — Phase D toggles `.visible` on
//     containers Phase C registers).
//   - capture_phase4_step3.cjs             — keyboard input pattern
//     (page.keyboard.down/up + WASD via document keydown listener).
//
// IMPORTANT — Phase D is not yet implemented at the time this capture
// script lands. The implementation agent will wire `current_cell`,
// `render_set`, the wasm getters, and the rAF visibility-toggle in a
// follow-up commit. Until that lands, this script will fail with a
// specific "Phase D not yet implemented" detail message rather than a
// generic null-deref. That's the intended behaviour — we're locking
// the contract before the implementation arrives.
//
// Pre-reqs (same as `capture_phase6_step_c_envcells.cjs`):
// - Live ACE on Tailscale 100.116.47.66 UDP 9000 (login) / 9001 (world).
// - holtburger-wsbridge running on ws://127.0.0.1:8080/.
// - python3 -m http.server 8765 from external/holtburger/.
// - Manifest+shards baked under dist/ (the index.html consumes them
//   via init_resource_source).
// - The test account needs accessLevel >= 4 for `@telepoi`, `@pk`,
//   and `/godly` (or whatever ACE's god-mode incantation turns out
//   to be — see PHASE6_GODMODE_CHAT below).
//
// Run: `node capture_phase6_step_d_floors.cjs` from
// `apps/holtburger-web/`. Outputs
// `docs/images/phase-6-step-d-floors-pre.png` (player at foot of
// stairs) and `docs/images/phase-6-step-d-floors-post.png` (player on
// upper floor, lower floor culled). Prints PASS / FAIL based on the
// currentCellId / renderSet / cellContainer.visible / Z-delta
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
    const OUT_PRE_PATH = path.resolve(
        __dirname,
        "../../../../docs/images/phase-6-step-d-floors-pre.png"
    );
    const OUT_POST_PATH = path.resolve(
        __dirname,
        "../../../../docs/images/phase-6-step-d-floors-post.png"
    );
    const CHAR_NAME = process.env.PHASE6_CHAR_NAME
        || `Phase6D${Date.now().toString(36).slice(-6)}`;
    const CREATE_TIMEOUT_MS = Number(process.env.PHASE4_CREATE_TIMEOUT_MS || 15_000);
    const SPAWN_TIMEOUT_MS = Number(process.env.PHASE4_SPAWN_TIMEOUT_MS || 15_000);
    const ENTITY_DRAIN_MS = Number(process.env.PHASE4_ENTITY_DRAIN_MS || 6_000);
    const TELEPORT_TIMEOUT_MS = Number(process.env.PHASE4_TELEPORT_TIMEOUT_MS || 5_000);
    // EnvCell prefetch + bake settle (mirrors step C's value). Phase D
    // depends on Phase C having populated `cellContainers` for the
    // visible Holtburg neighbourhood by the time we sample.
    const ENVCELL_BAKE_MS = Number(process.env.PHASE6_ENVCELL_BAKE_MS || 4_000);
    // How long we hold W to walk up the stairs. The town hall stairwell
    // is roughly 3-4 m of horizontal travel from the foot of the stairs
    // to the top step at retail walk speed (1.0 m/s); 3 s gives margin
    // and the integrator will push past the top step into the upper
    // landing. Tunable via env if a different building gets picked.
    const WALK_HOLD_MS = Number(process.env.PHASE6_STAIR_WALK_MS || 3_000);
    // Settle time after key release for the final PublicUpdatePosition
    // echo to land + the rAF tick to redraw with the new render set.
    // Phase D's render set is recomputed per frame, so a single rAF
    // (~16 ms at 60 Hz) is enough — but ACE's echo is the slow path.
    const SETTLE_MS = Number(process.env.PHASE4_SETTLE_MS || 1_500);
    // Optional second strafe: some Holtburg houses have stairs
    // arranged such that pure W doesn't trace the stairwell — Q (left
    // strafe) or E (right strafe) may be needed to track the
    // stairwell axis. Default empty (W-only); set to "q" or "e" to
    // hold an additional key during the W-walk.
    const STAIR_STRAFE_KEY = process.env.PHASE6_STAIR_STRAFE_KEY || "";
    // God-mode chat command. ACE's exact incantation is
    // unconfirmed — likely candidates per the
    // project_holtburger_godmode_falldamage memory: `/god`, `/godly`,
    // `@god`, `/buff godmode`. We try the listed default first; if
    // ACE rejects (no echo / unrecognized), it's harmless — the test
    // proceeds without god mode. See the memory entry for context.
    const GODMODE_CHAT = process.env.PHASE6_GODMODE_CHAT || "/godly";
    // Whether to attempt god-mode at all. Off by default because the
    // exact command is unconfirmed; turn on once the right command is
    // verified (or set PHASE6_GODMODE_CHAT to "" to disable explicitly).
    const ENABLE_GODMODE = process.env.PHASE6_ENABLE_GODMODE !== "0";
    // Minimum Z-delta (metres) between pre-stair and post-stair sample
    // that proves the player walked UP rather than (a) wandering on
    // ground level or (b) being teleported to a different ground-level
    // room. AC's interior floor heights are ~3-4 m in retail; 1.5 m is
    // a conservative floor that any real second-storey traversal will
    // clear, while ruling out terrain noise (~10 cm).
    const MIN_Z_DELTA_M = Number(process.env.PHASE6_MIN_Z_DELTA_M || 1.5);

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
        // Surface anything that looks load-bearing for Phase D
        // (current-cell / render-set / portal-cross / visibility-toggle
        // trace lines) alongside the standard error / warn channels.
        if (
            msg.type() === "error"
            || msg.type() === "warning"
            || /\[step|current.?cell|render.?set|portal|visible|cell.?graph|stair|floor/i.test(text)
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
    // server_host (matches steps A/B/C; step 3's server_ip selector is
    // stale).
    await page.fill('input[name="server_host"]', SERVER_IP);
    await page.fill('input[name="server_port"]', SERVER_PORT);
    console.log(`submitting login as ${ACCOUNT}`);

    await page.click('#login-form button[type=submit]');
    await page.waitForSelector("#selection:not([hidden])", { timeout: 30_000 });
    console.log("Selection visible");
    await page.waitForTimeout(500);

    const initialButtonCount = await page.locator('#character-ul button[data-id]').count();
    if (initialButtonCount === 0) {
        const createFormVisible = await page.locator("#create-form:not([hidden])").count() > 0;
        if (!createFormVisible) {
            console.error("Create-character form is hidden — bailing.");
            await page.screenshot({ path: OUT_PRE_PATH, fullPage: false });
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
        await page.screenshot({ path: OUT_PRE_PATH, fullPage: false });
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
        await page.screenshot({ path: OUT_PRE_PATH, fullPage: false });
        await browser.close();
        process.exit(1);
    }

    // Helper to send chat through the session handle. Same pattern as
    // every other Phase 6 capture (steps A/B/C and Phase 4 step 3).
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

    // `@pk pk` enables FastTick — Phase D's render-set logic runs on
    // EVERY frame regardless of FastTick (it's purely client-side cell
    // graph BFS), but the WALK part of the test needs FastTick because
    // ACE's authoritative physics has to echo PublicUpdatePosition for
    // the local sprite to actually move up the stairs. Without
    // FastTick the sprite would freeze at the foot of the stairs and
    // both pre-stair and post-stair samples would read the same
    // currentCellId, indistinguishable from "Phase D not implemented."
    console.log("sending '@pk pk' to enable FastTick (server-side physics)");
    const pkResult = await sendChat("@pk pk");
    console.log(`@pk pk dispatch: ${pkResult}`);
    await page.waitForTimeout(2000);

    // Try god-mode to dodge the persistent fall-damage bug — see
    // memory: project_holtburger_godmode_falldamage. Walking on
    // indoor terrain (flat floors + step-shape stairs) is less
    // affected than outdoor slopes, but the test ends with the
    // player traversing several metres of vertical change and the
    // integrator can over-cap velocity in the meantime. If the
    // command is unrecognized, ACE just echoes "Unknown command" and
    // we proceed normally — harmless.
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

    // Allow Phase C's EnvCell prefetch + bake to settle. Phase D
    // depends on cellContainers being populated for the visible
    // Holtburg neighbourhood before we read currentCellId / renderSet.
    console.log(`waiting ${ENVCELL_BAKE_MS}ms for Phase C EnvCell prefetch + bake (Phase D dependency)`);
    await page.waitForTimeout(ENVCELL_BAKE_MS);

    // === Phase C presence guard =========================================
    //
    // Phase D's contract is "render set membership drives container
    // visibility"; that requires Phase C's cellContainers registry to
    // exist. If it doesn't, fail with a dedicated message rather than
    // letting the Phase D check report a false positive.
    const phaseCPresent = await page.evaluate(() => {
        let cellContainers = null;
        let source = null;
        if (window.cellContainers && typeof window.cellContainers.entries === "function") {
            cellContainers = window.cellContainers;
            source = "window.cellContainers";
        } else if (
            window.liveScene
            && window.liveScene.cellContainers
            && typeof window.liveScene.cellContainers.entries === "function"
        ) {
            cellContainers = window.liveScene.cellContainers;
            source = "window.liveScene.cellContainers";
        }
        if (!cellContainers) return { ok: false, reason: "cellContainers map missing", source: null };
        let n = 0;
        for (const _ of cellContainers.entries()) n += 1;
        return { ok: n > 0, reason: n === 0 ? "cellContainers empty" : null, source, count: n };
    });
    if (!phaseCPresent.ok) {
        console.error(
            `FAIL (phase-C-not-present): ${phaseCPresent.reason}. `
            + `Phase D (active-cell tracking) cannot be validated until Phase C `
            + `(EnvCell render path) is live — see `
            + `docs/phase-6-buildings-and-interiors.md §5 phase C.`
        );
        await page.screenshot({ path: OUT_PRE_PATH, fullPage: false });
        console.log(`saved ${OUT_PRE_PATH}`);
        await browser.close();
        process.exit(1);
    }
    console.log(`phase C guard OK: ${phaseCPresent.source} has ${phaseCPresent.count} cells`);

    // === Position at the foot of the stairs =============================
    //
    // We tried two approaches for positioning at the foot of the
    // Holtburg town hall stairs:
    //
    //   1. `@teleloc` with a known indoor cell id. ACE's @teleloc
    //      accepts landblock-format positions; indoor cells use the
    //      0xA9B40100+ convention. Risk per plan §6.2: ACE may reject
    //      indoor cell ids. NOT taken — we don't have a verified
    //      stairwell coord today and the spec said "if exact coords
    //      are known; otherwise teleport to spawn and walk". We did
    //      the latter.
    //
    //   2. `@telepoi Holtburg` to spawn (which the post-spawn block
    //      already does), then walk W into the town hall. This is
    //      what we do here. It mirrors step C's "walk into the
    //      doorway" pattern — Phase C's visual screenshot already
    //      relies on the spawn pose facing the town hall.
    //
    // Approach 2 has an explicit risk: if the implementation agent
    // picks a different multi-floor building (e.g. one of the
    // outbuildings), this script's W-walk won't track the stairs.
    // That's acceptable because the contract (currentCellId changes,
    // renderSet flips, Z increases) is portable across any
    // multi-floor target.
    //
    // Walk path:
    //   - the @telepoi spawn faces the town hall.
    //   - W for ~3 s pushes us through the front double doors and onto
    //     the entry hall.
    //   - W for another ~3 s should track up the stairwell to the
    //     upper landing.
    //   - The PRE sample is taken between those two walks — at the
    //     foot of the stairs.
    //
    // (Two-stage walk is only needed because the @telepoi spawn isn't
    // already inside the building. We do it as one continuous W hold
    // with a sample just before the stair traversal.)

    await page.evaluate(() => {
        if (document.activeElement && typeof document.activeElement.blur === "function") {
            document.activeElement.blur();
        }
    });
    await page.locator("#canvas").click({ position: { x: 256, y: 256 }, force: true });

    // Stage 1: walk into the building (W for ~3 s gets us through the
    // doorway and into the entry hall, hopefully near the foot of the
    // stairs). This stage doesn't sample anything — we just need to be
    // INSIDE for the pre-stair sample to be meaningful. Phase B's
    // collision (when live) will block walls but not the doorway.
    console.log("=================================================================");
    console.log(`STAGE 1: walking into Holtburg town hall (W for 3s through doorway)`);
    console.log("=================================================================");
    await page.keyboard.down("w");
    await page.waitForTimeout(3_000);
    await page.keyboard.up("w");
    await page.waitForTimeout(SETTLE_MS);

    // === Pre-stair sample =================================================
    //
    // At this point the player should be inside the town hall at the
    // foot of the stairs. Read currentCellId, renderSet, the chosen
    // cell's container.visible, and the local player's Z.
    async function probeActiveCell(label) {
        return page.evaluate((lbl) => {
            const out = {
                label: lbl,
                phaseDNotShipped: false,
                reason: null,
                currentCellId: null,
                currentCellHex: null,
                renderSet: null,
                renderSetHex: null,
                renderSetSize: 0,
                currentCellVisible: null,
                playerZ: null,
                visibleContainerCount: 0,
                hiddenContainerCount: 0,
                containerCount: 0,
                containerVisibilityByCell: {},
            };

            // Resolve cellContainers (try both placeholder shapes).
            let cellContainers = null;
            if (window.cellContainers && typeof window.cellContainers.entries === "function") {
                cellContainers = window.cellContainers;
            } else if (
                window.liveScene
                && window.liveScene.cellContainers
                && typeof window.liveScene.cellContainers.entries === "function"
            ) {
                cellContainers = window.liveScene.cellContainers;
            }
            if (!cellContainers) {
                out.phaseDNotShipped = true;
                out.reason = "Phase C not present — cellContainers missing";
                return out;
            }

            // Phase D placeholder reads. Try multiple shapes to give
            // the impl agent flexibility:
            //   1. window.__currentCellId (top-level u32, simplest).
            //   2. window.liveScene.currentCellId.
            //   3. window.__sessionHandle.getCurrentCellId() if the
            //      impl agent picks a method-style accessor.
            // Same fan-out for renderSet.
            let currentCellId = null;
            if (typeof window.__currentCellId === "number") {
                currentCellId = window.__currentCellId >>> 0;
            } else if (
                window.liveScene
                && typeof window.liveScene.currentCellId === "number"
            ) {
                currentCellId = window.liveScene.currentCellId >>> 0;
            } else if (
                window.__sessionHandle
                && typeof window.__sessionHandle.getCurrentCellId === "function"
            ) {
                try {
                    const v = window.__sessionHandle.getCurrentCellId();
                    if (typeof v === "number" || typeof v === "bigint") {
                        currentCellId = Number(v) >>> 0;
                    }
                } catch (_) {}
            }

            if (currentCellId === null) {
                out.phaseDNotShipped = true;
                out.reason =
                    "Phase D not yet implemented — none of "
                    + "window.__currentCellId / window.liveScene.currentCellId / "
                    + "window.__sessionHandle.getCurrentCellId() returned a u32. "
                    + "Expected one of these accessors per "
                    + "docs/phase-6-buildings-and-interiors.md §5 phase D step 1.";
                return out;
            }
            out.currentCellId = currentCellId;
            out.currentCellHex = `0x${currentCellId.toString(16).toUpperCase().padStart(8, "0")}`;

            // Phase D render set probe.
            let renderSet = null;
            if (window.__renderSet && typeof window.__renderSet.has === "function") {
                renderSet = window.__renderSet;
            } else if (
                window.liveScene
                && window.liveScene.renderSet
                && typeof window.liveScene.renderSet.has === "function"
            ) {
                renderSet = window.liveScene.renderSet;
            } else if (
                window.__sessionHandle
                && typeof window.__sessionHandle.getRenderSet === "function"
            ) {
                try {
                    const arr = window.__sessionHandle.getRenderSet();
                    if (Array.isArray(arr) || arr instanceof Uint32Array) {
                        renderSet = new Set();
                        for (const v of arr) renderSet.add((Number(v) >>> 0));
                    }
                } catch (_) {}
            }

            if (!renderSet) {
                out.phaseDNotShipped = true;
                out.reason =
                    "Phase D render set not exposed — none of "
                    + "window.__renderSet / window.liveScene.renderSet / "
                    + "window.__sessionHandle.getRenderSet() returned a Set / array. "
                    + "Expected one of these accessors per "
                    + "docs/phase-6-buildings-and-interiors.md §5 phase D step 2.";
                return out;
            }

            // Materialize render set as an array of hex strings for
            // logging + as a JS Set for membership checks downstream.
            const rsArr = [];
            for (const cid of renderSet) {
                rsArr.push(`0x${(Number(cid) >>> 0).toString(16).toUpperCase().padStart(8, "0")}`);
            }
            out.renderSet = Array.from(renderSet, (cid) => Number(cid) >>> 0);
            out.renderSetHex = rsArr;
            out.renderSetSize = rsArr.length;

            // Current cell's container visibility.
            const currentContainer = cellContainers.get(currentCellId);
            if (currentContainer) {
                out.currentCellVisible = !!currentContainer.visible;
            } else {
                // currentCellId may be an outdoor cell that doesn't
                // have an entry in cellContainers; that's fine — we
                // just record null. The renderSet check below is the
                // load-bearing assertion.
                out.currentCellVisible = null;
            }

            // Tally visible / hidden containers AND record visibility
            // by cell so we can diff pre vs post.
            for (const [key, container] of cellContainers.entries()) {
                if (!container || typeof container !== "object") continue;
                const k = (Number(key) >>> 0);
                const v = !!container.visible;
                out.containerCount += 1;
                if (v) out.visibleContainerCount += 1;
                else out.hiddenContainerCount += 1;
                out.containerVisibilityByCell[k] = v;
            }

            // Local player Z. The local-player guid isn't directly
            // identifiable from JS (closure-private), but we can read
            // the camera height. Fall back: scan entityMap for an
            // entry that looks like the local player. The camera path
            // is preferred — `liveScene.cameraContainer` translates
            // its world origin to the player position, so the
            // negative camera Z is the player Z (when the impl
            // exposes it). If neither is available, leave null and
            // the Z-delta assertion will skip-warn.
            const cam = window.liveScene && window.liveScene.cameraContainer;
            if (cam && typeof cam.zone === "number") {
                out.playerZ = cam.zone;
            } else if (cam && typeof cam.__playerZ === "number") {
                out.playerZ = cam.__playerZ;
            } else if (window.__sessionHandle && typeof window.__sessionHandle.getPlayerZ === "function") {
                try {
                    out.playerZ = Number(window.__sessionHandle.getPlayerZ());
                } catch (_) {}
            } else {
                // Heuristic last resort: pick the entity with the
                // highest tick-rate update — the local player. Skip
                // for now; if the assertion fails we'll log a hint.
                out.playerZ = null;
            }

            return out;
        }, label);
    }

    const preStair = await probeActiveCell("pre-stair");
    if (preStair.phaseDNotShipped) {
        console.error(`FAIL (phase-D-not-shipped, pre-stair): ${preStair.reason}`);
        await page.screenshot({ path: OUT_PRE_PATH, fullPage: false });
        console.log(`saved ${OUT_PRE_PATH}`);
        await browser.close();
        process.exit(1);
    }
    console.log(
        `pre-stair: currentCellId=${preStair.currentCellHex}, `
        + `renderSet={${preStair.renderSetHex.join(", ")}}, `
        + `currentCellVisible=${preStair.currentCellVisible}, `
        + `playerZ=${preStair.playerZ?.toFixed?.(2) ?? "(unknown)"}, `
        + `containerCount=${preStair.containerCount} `
        + `(${preStair.visibleContainerCount} visible / ${preStair.hiddenContainerCount} hidden)`
    );

    // Pre-stair screenshot.
    await page.evaluate(() => {
        const canvasElem = document.getElementById("canvas");
        if (canvasElem) canvasElem.scrollIntoView({ block: "start" });
    });
    await page.waitForTimeout(200);
    await page.screenshot({ path: OUT_PRE_PATH, fullPage: false });
    console.log(`saved ${OUT_PRE_PATH}`);

    // === Stage 2: walk up the stairs =====================================
    //
    // Continue holding W (and optionally a strafe key) for WALK_HOLD_MS.
    // The integrator + terrain following + Phase B collision (when live)
    // will track the stair shape, lifting Z as the player crosses each
    // step's portal boundary into the upper-floor cell.
    console.log("=================================================================");
    console.log(`STAGE 2: walking up stairs (W${STAIR_STRAFE_KEY ? " + " + STAIR_STRAFE_KEY : ""} for ${WALK_HOLD_MS}ms)`);
    console.log("=================================================================");
    await page.keyboard.down("w");
    if (STAIR_STRAFE_KEY) await page.keyboard.down(STAIR_STRAFE_KEY);
    await page.waitForTimeout(WALK_HOLD_MS);
    if (STAIR_STRAFE_KEY) await page.keyboard.up(STAIR_STRAFE_KEY);
    await page.keyboard.up("w");
    console.log(`releasing keys; settling ${SETTLE_MS}ms for final echo + rAF tick`);
    await page.waitForTimeout(SETTLE_MS);

    // === Post-stair sample ===============================================
    const postStair = await probeActiveCell("post-stair");
    if (postStair.phaseDNotShipped) {
        // Should be impossible — pre-stair would have caught it. Guard
        // against a wasm reload race.
        console.error(`FAIL (phase-D-not-shipped, post-stair): ${postStair.reason}`);
        await page.screenshot({ path: OUT_POST_PATH, fullPage: false });
        await browser.close();
        process.exit(1);
    }
    console.log(
        `post-stair: currentCellId=${postStair.currentCellHex}, `
        + `renderSet={${postStair.renderSetHex.join(", ")}}, `
        + `currentCellVisible=${postStair.currentCellVisible}, `
        + `playerZ=${postStair.playerZ?.toFixed?.(2) ?? "(unknown)"}, `
        + `containerCount=${postStair.containerCount} `
        + `(${postStair.visibleContainerCount} visible / ${postStair.hiddenContainerCount} hidden)`
    );

    // Post-stair screenshot.
    await page.evaluate(() => {
        const canvasElem = document.getElementById("canvas");
        if (canvasElem) canvasElem.scrollIntoView({ block: "start" });
    });
    await page.waitForTimeout(200);
    await page.screenshot({ path: OUT_POST_PATH, fullPage: false });
    console.log(`saved ${OUT_POST_PATH}`);

    // === Verdict =========================================================
    console.log("=========================");

    // (1) currentCellId changed (player crossed a portal).
    const cellChanged = preStair.currentCellId !== postStair.currentCellId;
    console.log(
        `assertion 1 — currentCellId changed: `
        + `pre=${preStair.currentCellHex} post=${postStair.currentCellHex} → ${cellChanged}`
    );
    if (!cellChanged) {
        console.error(
            `FAIL: active-cell tracking not detecting player crossing portal. `
            + `currentCellId stayed ${preStair.currentCellHex} after walking up the stairs. `
            + `Either the player didn't actually traverse a portal (test-target building has `
            + `no second floor / spawn pose mis-aligned / collision blocked the walk early) or `
            + `WorldState::current_cell isn't running per-tick / isn't switching on the indoor `
            + `AABB-containment crossover. See `
            + `docs/phase-6-buildings-and-interiors.md §5 phase D step 1.`
        );
        await browser.close();
        process.exit(1);
    }

    // (2) Pre-stair currentCellId is no longer in the post-stair render
    //     set (lower floor was culled).
    const lowerCulled = !postStair.renderSet.includes(preStair.currentCellId);
    console.log(
        `assertion 2 — pre-stair cell ${preStair.currentCellHex} removed from post render set: ${lowerCulled}`
    );
    if (!lowerCulled) {
        console.error(
            `FAIL: pre-stair cell ${preStair.currentCellHex} still appears in the `
            + `post-stair render set (${postStair.renderSetHex.join(", ")}). The lower floor `
            + `was NOT culled when the player walked up the stairs — Phase D's render-set BFS `
            + `is including too much (depth too high, or the lower floor is portal-reachable from `
            + `the upper floor and depth=1 is including it). See `
            + `docs/phase-6-buildings-and-interiors.md §5 phase D step 2 — default depth=1.`
        );
        await browser.close();
        process.exit(1);
    }

    // (3) Post-stair currentCellId IS in the post-stair render set
    //     (upper floor visible).
    const upperVisible = postStair.renderSet.includes(postStair.currentCellId);
    console.log(
        `assertion 3 — post-stair cell ${postStair.currentCellHex} in post render set: ${upperVisible}`
    );
    if (!upperVisible) {
        console.error(
            `FAIL: post-stair cell ${postStair.currentCellHex} is NOT in its own render set `
            + `(${postStair.renderSetHex.join(", ")}). render_set(current, depth=1) MUST include `
            + `the current cell — this is a logic bug in WorldState::render_set's seed step.`
        );
        await browser.close();
        process.exit(1);
    }

    // (4) At least one cellContainer flipped from visible=true to
    //     visible=false. We diff containerVisibilityByCell pre vs post.
    let flippedToHidden = 0;
    let flippedToVisible = 0;
    const flippedHiddenCells = [];
    const flippedVisibleCells = [];
    for (const [k, postV] of Object.entries(postStair.containerVisibilityByCell)) {
        const preV = preStair.containerVisibilityByCell[k];
        if (preV === true && postV === false) {
            flippedToHidden += 1;
            flippedHiddenCells.push(`0x${(Number(k) >>> 0).toString(16).toUpperCase().padStart(8, "0")}`);
        }
        if (preV === false && postV === true) {
            flippedToVisible += 1;
            flippedVisibleCells.push(`0x${(Number(k) >>> 0).toString(16).toUpperCase().padStart(8, "0")}`);
        }
    }
    console.log(
        `assertion 4 — containers flipped pre→post: `
        + `${flippedToHidden} true→false [${flippedHiddenCells.join(", ")}], `
        + `${flippedToVisible} false→true [${flippedVisibleCells.join(", ")}]`
    );
    if (flippedToHidden < 1) {
        console.error(
            `FAIL: no cellContainer flipped from visible=true to visible=false between `
            + `pre-stair and post-stair samples. The render set changed (${preStair.currentCellHex} `
            + `→ ${postStair.currentCellHex}) but PIXI containers' visibility flags did not — the `
            + `JS-side rAF tick is reading the render set but not toggling container.visible. See `
            + `docs/phase-6-buildings-and-interiors.md §5 phase D step 3 ("Toggle `
            + `cellContainers.get(cid).visible based on membership").`
        );
        await browser.close();
        process.exit(1);
    }

    // (5) Player Z higher post-stair (proves walked up, not teleported
    //     to a different ground-level room). Skip-warn if Z reads
    //     unavailable — this is a SUPPORTING assertion, not the core
    //     contract.
    if (preStair.playerZ === null || postStair.playerZ === null) {
        console.warn(
            `[skipped] assertion 5 — playerZ unavailable. Add window.__sessionHandle.getPlayerZ() `
            + `or expose camera.zone (current Z) to make this assertion live. Continuing — the `
            + `core contract (assertions 1-4) is met without it.`
        );
    } else {
        const dz = postStair.playerZ - preStair.playerZ;
        console.log(
            `assertion 5 — playerZ delta: ${preStair.playerZ.toFixed(2)} → `
            + `${postStair.playerZ.toFixed(2)} = ${dz.toFixed(2)} m (>= ${MIN_Z_DELTA_M}? ${dz >= MIN_Z_DELTA_M})`
        );
        if (dz < MIN_Z_DELTA_M) {
            console.error(
                `FAIL: player Z delta ${dz.toFixed(2)} m is below ${MIN_Z_DELTA_M} m floor. The `
                + `currentCellId / renderSet changed, but the player did NOT actually walk UP — `
                + `they crossed into a different ground-level cell instead. The test-target building `
                + `may not actually have stairs at the spawn-relative path; pick a different multi-floor `
                + `target via PHASE6_STAIR_STRAFE_KEY or by overriding the spawn flow.`
            );
            await browser.close();
            process.exit(1);
        }
    }

    console.log(
        `PASS: Phase D active-cell tracking + Z-culling active. `
        + `Player crossed ${preStair.currentCellHex} → ${postStair.currentCellHex}; `
        + `lower floor (${preStair.currentCellHex}) culled from render set; `
        + `upper floor (${postStair.currentCellHex}) visible; `
        + `${flippedToHidden} containers flipped to hidden, `
        + `${flippedToVisible} containers flipped to visible; `
        + (preStair.playerZ !== null && postStair.playerZ !== null
            ? `Z delta ${(postStair.playerZ - preStair.playerZ).toFixed(2)} m confirms vertical traversal.`
            : `Z assertion skipped (playerZ unavailable).`)
    );
    await browser.close();
    process.exit(0);
})().catch((err) => {
    console.error("capture failed:", err);
    process.exit(1);
});
