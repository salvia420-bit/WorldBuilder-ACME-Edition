// Phase 6 step C capture script — drives the bundle through login →
// CharacterCreate (if needed) → spawn → @telepoi Holtburg → entity
// drain, then teleports near the Holtburg town hall and walks
// inside, asserting that EnvCell interior geometry (walls, floor,
// ceiling, plus static objects like tables and chairs) actually
// renders in PIXI rather than the player walking into an empty
// black void.
//
// Phase C's contract (per docs/phase-6-buildings-and-interiors.md §5):
//   1. New wasm export `fetch_env_cells_in_landblock(lbid: u32) ->
//      JsValue` returning `Vec<EnvCellPlacement>`. Pulls EnvCells from
//      the manifest's `eor/cell` namespace for the requested
//      landblock prefix.
//   2. New struct `EnvCellPlacement` exposing cell_id,
//      environment_id, world cell_origin x/y/z, cell_orientation
//      quaternion, static_objects vec, portal_cell_ids vec — sibling
//      to ObjectPlacement.
//   3. JS-side: each visible EnvCell baked into a per-cell
//      PIXI.Container, registered in `window.cellContainers:
//      Map<CellId, PIXI.Container>`. Static objects inside reuse
//      `triangulate_setup_identity_placement`.
//   4. Lazy-fetch hook: on landblock entry (or @telepoi prefetch)
//      EnvCells for the player's neighbourhood populate
//      cellContainers without manual nudge.
//
// Sibling tests:
//   - capture_phase6_step_a_geometry.cjs     — Phase A (per-part
//     building geometry; not a hard prerequisite for Phase C since
//     the wall cull happens in Phase B, but the visual test screenshot
//     is meaningless without buildings rendered).
//   - capture_phase6_step_b_collision.cjs    — Phase B (AABB collision;
//     also not a hard prerequisite — Phase C only needs to render
//     interior geometry, not block the player against it).
//   - capture_phase4_step3.cjs               — keyboard input pattern
//     (page.keyboard.down/up + WASD via document keydown listener).
//
// IMPORTANT — Phase C is not yet implemented at the time this capture
// script lands. The implementation agent will wire EnvCell fetching,
// triangulation, and the cellContainers registry in a follow-up
// commit. Until that lands, the test SHOULD fail with a clear
// "Phase C not yet implemented" message rather than a generic
// null-deref. That's the intended behaviour — we're locking the
// contract before the implementation arrives.
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
// Run: `node capture_phase6_step_c_envcells.cjs` from `apps/holtburger-web/`.
// Outputs `docs/images/phase-6-step-c-envcells-interior.png` and
// prints PASS / FAIL based on the cellContainers populate +
// triangle floor + (optionally) static-object count assertions.

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
        "../../../../docs/images/phase-6-step-c-envcells-interior.png"
    );
    const CHAR_NAME = process.env.PHASE6_CHAR_NAME
        || `Phase6C${Date.now().toString(36).slice(-6)}`;
    const CREATE_TIMEOUT_MS = Number(process.env.PHASE4_CREATE_TIMEOUT_MS || 15_000);
    const SPAWN_TIMEOUT_MS = Number(process.env.PHASE4_SPAWN_TIMEOUT_MS || 15_000);
    const ENTITY_DRAIN_MS = Number(process.env.PHASE4_ENTITY_DRAIN_MS || 6_000);
    const TELEPORT_TIMEOUT_MS = Number(process.env.PHASE4_TELEPORT_TIMEOUT_MS || 5_000);
    // Phase C lazy-fetch hooks into the same prefetch pipeline as the
    // terrain neighbourhood load on @telepoi. Give it a generous
    // window — EnvCell loads are ~50 cells per landblock for the
    // visible neighbourhood; manifest source is local, so we're
    // mostly waiting for the wasm-side parse + triangulate to finish.
    const ENVCELL_BAKE_MS = Number(process.env.PHASE6_ENVCELL_BAKE_MS || 4_000);
    // After we walk through the door we need a moment for the
    // doorway crossing → indoor cell switch to settle. Phase D is
    // technically what wires the active-cell tracker, but Phase C
    // should still populate cellContainers eagerly enough that we
    // observe a populated map even before the player is fully inside.
    const INDOOR_SETTLE_MS = Number(process.env.PHASE6_INDOOR_SETTLE_MS || 2_500);
    // How long to hold W when walking into the town hall doorway. 3 s
    // at 1 m/s puts us ~3 m past the threshold, well into the
    // interior. Mirrors the wall-walk timing in step B but used
    // inversely — here we want to be INSIDE, so we need to clear the
    // doorway, not get blocked at it. (Phase B's collision will
    // block walls but doorways are AABB-free until Phase E adds door
    // state.)
    const WALK_HOLD_MS = Number(process.env.PHASE4_WALK_HOLD_MS || 3_000);
    // Settle time after key release. Same convention as step B.
    const SETTLE_MS = Number(process.env.PHASE4_SETTLE_MS || 1_500);

    // Holtburg town hall first interior cell. The Holtburg town
    // landblock is 0xA9B4; interior cells share the high word with
    // their parent landblock and use low-word ≥ 0x0100 (per
    // `crates/holtburger-common/src/position.rs:75-80` is_indoors).
    // The town hall's first interior cell — sometimes referenced as
    // 0xA9B40100 — is the entry just past the front double doors.
    // Exact cell id verified per the terminal exporter's envcell
    // dump (pipeline_data/reference/interior_support_objects_highconf.jsonl
    // filters on landblockId=0xA9B4 for the Holtburg interior set).
    //
    // TODO: confirm with the user / implementation agent the exact
    // outdoor coords nearest the town hall doorway. For now we rely
    // on @telepoi Holtburg's spawn pose (which faces the town hall
    // per step A's framing) plus a short W-walk to enter. If the
    // spawn pose changes, override via PHASE6_HOLTBURG_DOOR_X/Y env
    // vars (currently unused — left as a hook for future
    // calibration).
    const HOLTBURG_LANDBLOCK_PREFIX = 0xa9b4; // u16 high word
    const HOLTBURG_TOWNHALL_INTERIOR_CELL = 0xa9b40100; // first interior cell

    // PASS thresholds. These are deliberately conservative — Phase C
    // is "did anything render at all" rather than retail-precise:
    //   - At least 1 EnvCell registered in cellContainers after
    //     teleport + walk.
    //   - At least 1 EnvCell with non-empty geometry (childCount>0
    //     OR triCount>0).
    //   - Aggregate triangle floor across all EnvCells: 30 tris
    //     covers a 6-faced cube room (12 tris) + a single static
    //     object (most basic Setup parts have ≥ 4 tris). 30 is
    //     unmissable — a real town hall interior bakes to thousands.
    const MIN_CELLS = Number(process.env.PHASE6_MIN_CELLS || 1);
    const MIN_AGGREGATE_TRIS = Number(process.env.PHASE6_MIN_AGGREGATE_TRIS || 30);

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
        // Surface anything that looks load-bearing for Phase C
        // (envcell / interior / triangulate / portal trace lines)
        // alongside the standard error / warn channels.
        if (
            msg.type() === "error"
            || msg.type() === "warning"
            || /\[step|envcell|interior|triangulate|bake|portal|cell-container/i.test(text)
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
    // server_host (matches steps A/B; step 3's server_ip selector is
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

    // `@pk pk` enables FastTick — Phase C doesn't depend on
    // server-side physics directly, but the next Phase B/D work will
    // and keeping the toggle on means this script is one-line-changeable
    // forward to assert player→indoor-cell membership later.
    console.log("sending '@pk pk' to enable FastTick");
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
    await page.waitForTimeout(2000);

    console.log("clicking Teleport to Holtburg button");
    await page.click("#teleport-button");
    console.log(`waiting ${ENTITY_DRAIN_MS}ms for entity drain post-teleport`);
    await page.waitForTimeout(ENTITY_DRAIN_MS);

    // Allow Phase C's lazy-fetch to settle. EnvCells for the
    // Holtburg neighbourhood (~50 cells visible from spawn) should
    // be populated by the time this returns. Mirrors the
    // GEOMETRY_BAKE_MS pattern in steps A/B but stretched a bit
    // because EnvCell triangulation is heavier than building Setup
    // (more parts per cell, more static-object recursion).
    console.log(`waiting ${ENVCELL_BAKE_MS}ms for Phase C EnvCell prefetch + bake`);
    await page.waitForTimeout(ENVCELL_BAKE_MS);

    // === Phase C contract probe — pre-walk =============================
    //
    // Defensive read: `window.cellContainers` is a placeholder name —
    // the implementation agent may rename to something more idiomatic
    // (e.g. `window.liveScene.cellContainers`, `window.__envCells`,
    // or hang it off `window.entityMap`-like under a `cells` key).
    // If a rename lands, update the locator below + the smoke check
    // in `smoke_test.cjs` together.
    //
    // We do this probe BEFORE walking inside so we can distinguish:
    //   - cellContainers undefined → Phase C not implemented at all.
    //   - cellContainers empty after teleport+settle → fetch path
    //     not wired into the @telepoi prefetch.
    //   - cellContainers populated but no children → triangulator
    //     not emitting (or emitting empty containers).
    async function probeCellContainers(label) {
        return page.evaluate((lbl) => {
            const out = {
                label: lbl,
                phaseCNotShipped: false,
                reason: null,
                cellCount: 0,
                entries: [],
                aggregateTris: 0,
                aggregateChildCount: 0,
            };

            // Try multiple placeholder shapes — the impl agent picks
            // one and we key on whichever exists. Order: top-level
            // window.cellContainers (most idiomatic), then
            // liveScene.cellContainers (matches the
            // `liveScene.cameraContainer` pattern from step A).
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

            if (!cellContainers) {
                out.phaseCNotShipped = true;
                out.reason =
                    "neither window.cellContainers nor window.liveScene.cellContainers "
                    + "is a Map — Phase C (EnvCell fetch + triangulate + register) has "
                    + "not yet shipped. See docs/phase-6-buildings-and-interiors.md §5 "
                    + "phase C.";
                return out;
            }
            out.source = source;

            for (const [key, container] of cellContainers.entries()) {
                if (!container || typeof container !== "object") continue;
                const children = container.children || [];
                const childCount = children.length;

                let triCount = 0;
                for (const child of children) {
                    if (typeof child.__triCount === "number") {
                        triCount += child.__triCount;
                        continue;
                    }
                    const idx = child.geometry?.indexBuffer?.data;
                    if (idx && typeof idx.length === "number") {
                        triCount += Math.floor(idx.length / 3);
                        continue;
                    }
                    // Recurse one level for cells whose static
                    // objects are nested under a sub-container per
                    // object. `triangulate_setup_identity_placement`
                    // emits children-of-children sometimes.
                    if (child.children && child.children.length > 0) {
                        for (const grand of child.children) {
                            if (typeof grand.__triCount === "number") {
                                triCount += grand.__triCount;
                                continue;
                            }
                            const gidx = grand.geometry?.indexBuffer?.data;
                            if (gidx && typeof gidx.length === "number") {
                                triCount += Math.floor(gidx.length / 3);
                                continue;
                            }
                            triCount += 1;
                        }
                        continue;
                    }
                    triCount += 1;
                }

                const keyHex = typeof key === "bigint"
                    ? `0x${key.toString(16).toUpperCase().padStart(16, "0")}`
                    : `0x${(Number(key) >>> 0).toString(16).toUpperCase().padStart(8, "0")}`;

                out.entries.push({ keyHex, childCount, triCount });
                out.aggregateChildCount += childCount;
                out.aggregateTris += triCount;
            }
            out.cellCount = out.entries.length;
            return out;
        }, label);
    }

    const prePopulate = await probeCellContainers("post-teleport pre-walk");
    if (prePopulate.phaseCNotShipped) {
        console.error(`FAIL (phase-C-not-shipped): ${prePopulate.reason}`);
        await page.screenshot({ path: OUT_PATH, fullPage: false });
        console.log(`saved ${OUT_PATH}`);
        await browser.close();
        process.exit(1);
    }
    console.log(
        `pre-walk ${prePopulate.source}: cells=${prePopulate.cellCount}, `
        + `aggregateChildren=${prePopulate.aggregateChildCount}, `
        + `aggregateTris=${prePopulate.aggregateTris}`
    );

    // === Walk through the town hall doorway ============================
    //
    // The @telepoi Holtburg spawn faces the town hall (per step A's
    // framing). Walking W from spawn for 3 s at 1 m/s puts us through
    // the doorway and into the first interior cell (0xA9B40100). Phase
    // B's collision (when it lands) blocks walls; doorways stay open
    // until Phase E adds door-state-driven AABBs.
    await page.evaluate(() => {
        if (document.activeElement && typeof document.activeElement.blur === "function") {
            document.activeElement.blur();
        }
    });
    await page.locator("#canvas").click({ position: { x: 256, y: 256 }, force: true });

    console.log("=================================================================");
    console.log(`WALK INTO TOWN HALL: W held for ${WALK_HOLD_MS}ms toward doorway`);
    console.log("=================================================================");
    await page.keyboard.down("w");
    await page.waitForTimeout(WALK_HOLD_MS);
    await page.keyboard.up("w");
    console.log(`releasing W; settling ${SETTLE_MS}ms for final echo`);
    await page.waitForTimeout(SETTLE_MS);

    // Extra settle for Phase D's active-cell update (which Phase C
    // doesn't strictly need, but if D is also live a recently-entered
    // cell may still be triangulating its bake).
    console.log(`waiting ${INDOOR_SETTLE_MS}ms for indoor-cell render settle`);
    await page.waitForTimeout(INDOOR_SETTLE_MS);

    const postWalk = await probeCellContainers("post-walk indoors");
    if (postWalk.phaseCNotShipped) {
        // Should be impossible — the pre-walk probe already would
        // have caught this. But guard against a race where the
        // accessor was renamed mid-flight.
        console.error(`FAIL (phase-C-not-shipped, post-walk): ${postWalk.reason}`);
        await page.screenshot({ path: OUT_PATH, fullPage: false });
        await browser.close();
        process.exit(1);
    }
    console.log(
        `post-walk ${postWalk.source}: cells=${postWalk.cellCount}, `
        + `aggregateChildren=${postWalk.aggregateChildCount}, `
        + `aggregateTris=${postWalk.aggregateTris}`
    );

    // Print top 5 cells by tri count for diagnostic context — useful
    // when the assertion fails so we can see which cells DID populate
    // and which (presumably the town hall interior) didn't.
    const top5 = [...postWalk.entries]
        .sort((a, b) => b.triCount - a.triCount)
        .slice(0, 5);
    console.log("top 5 EnvCells by triangle count:");
    for (const e of top5) {
        console.log(
            `    ${e.keyHex}: ${e.childCount} children, ${e.triCount} triangles`
        );
    }

    // Frame + screenshot. Same framing convention as steps A/B —
    // we don't try to centre on the town hall door precisely; the
    // screenshot is for visual regression alongside the assertions.
    await page.evaluate(() => {
        const canvasElem = document.getElementById("canvas");
        if (canvasElem) canvasElem.scrollIntoView({ block: "start" });
    });
    await page.waitForTimeout(200);
    await page.screenshot({ path: OUT_PATH, fullPage: false });
    console.log(`saved ${OUT_PATH}`);

    // === Verdict =======================================================
    //
    // Several distinguishable failure modes — diagnose separately so
    // the implementation agent gets a useful pointer rather than a
    // blanket "Phase C broken".
    console.log("=========================");
    console.log(`MIN_CELLS=${MIN_CELLS}, MIN_AGGREGATE_TRIS=${MIN_AGGREGATE_TRIS}`);
    console.log(`postWalk.cellCount=${postWalk.cellCount} (>= ${MIN_CELLS}? ${postWalk.cellCount >= MIN_CELLS})`);
    console.log(`postWalk.aggregateTris=${postWalk.aggregateTris} (>= ${MIN_AGGREGATE_TRIS}? ${postWalk.aggregateTris >= MIN_AGGREGATE_TRIS})`);

    // Phase D awareness flag. Phase D wires the player→current_cell
    // tracker; if cellContainers populated but the player's outdoor
    // cell shows no neighbour-reachable indoor cells, that's a
    // separate issue that belongs to Phase D, not C. We note it but
    // do NOT fail Phase C on this — Phase D is downstream.
    //
    // We approximate "no neighbour-reachable indoor cells" by checking
    // whether any cell in the registered set has a low word ≥ 0x0100
    // (the `is_indoors()` predicate per
    // crates/holtburger-common/src/position.rs:75-80). Outdoor cells
    // share the high word with their landblock; indoor cells use the
    // 0x0100+ low-word convention.
    let indoorCount = 0;
    for (const e of postWalk.entries) {
        const cellId = parseInt(e.keyHex, 16);
        if ((cellId & 0xffff) >= 0x0100) indoorCount += 1;
    }
    console.log(`indoor cells in registry: ${indoorCount} / ${postWalk.cellCount}`);
    if (indoorCount === 0 && postWalk.cellCount > 0) {
        console.warn(
            "[phase D heads-up] cellContainers populated but no indoor cells "
            + "(low-word ≥ 0x0100) registered. Phase D's active-cell tracker "
            + "may also be missing — outdoor cells alone won't reveal interior "
            + "geometry on player crossover. NOT failing Phase C on this since "
            + "Phase D is downstream. See docs/phase-6-buildings-and-interiors.md §5 phase D."
        );
    }

    if (postWalk.cellCount === 0) {
        console.error(
            `FAIL: cellContainers populate path is dead — 0 EnvCells registered after `
            + `teleport + walk. Phase C's lazy-fetch hook on landblock entry isn't `
            + `firing, or fetch_env_cells_in_landblock() returned empty. See `
            + `docs/phase-6-buildings-and-interiors.md §5 phase C step 6 (lazy-fetch hook).`
        );
        await browser.close();
        process.exit(1);
    }

    if (postWalk.cellCount < MIN_CELLS) {
        console.error(
            `FAIL: cellContainers has ${postWalk.cellCount} cells but expected `
            + `at least ${MIN_CELLS}. EnvCell prefetch may be partially wired. `
            + `See top 5 list above for which cells did populate.`
        );
        await browser.close();
        process.exit(1);
    }

    if (postWalk.aggregateTris < MIN_AGGREGATE_TRIS) {
        console.error(
            `FAIL: cellContainers has ${postWalk.cellCount} cells but only `
            + `${postWalk.aggregateTris} aggregate triangles (< ${MIN_AGGREGATE_TRIS}). `
            + `Cells are registered but their triangulator is emitting empty children. `
            + `Verify the Environment DID (0x0D…) walker is wired in lib.rs's new `
            + `triangulator path. See docs/phase-6-buildings-and-interiors.md §5 phase C step 4.`
        );
        await browser.close();
        process.exit(1);
    }

    // Optional sanity: at least one cell has BOTH non-zero children
    // AND non-zero tris. Catches the "empty PIXI.Container per cell"
    // failure mode where the registry is populated but the bake is a
    // no-op.
    const richCells = postWalk.entries.filter(
        (e) => e.childCount > 0 && e.triCount > 0
    );
    if (richCells.length === 0) {
        console.error(
            `FAIL: ${postWalk.cellCount} cells registered but none have both `
            + `non-zero children AND non-zero triangles. Each cell may be an `
            + `empty PIXI.Container — the bake path is registering before `
            + `triangulating. Verify the call order in the lazy-fetch hook.`
        );
        await browser.close();
        process.exit(1);
    }

    console.log(
        `PASS: Phase C interior rendering active. ${postWalk.cellCount} EnvCells `
        + `registered (>= ${MIN_CELLS}), ${postWalk.aggregateTris} aggregate triangles `
        + `(>= ${MIN_AGGREGATE_TRIS}), ${richCells.length} cells have both children `
        + `and triangles. Walking into Holtburg town hall reveals interior geometry.`
    );
    await browser.close();
    process.exit(0);
})().catch((err) => {
    console.error("capture failed:", err);
    process.exit(1);
});
