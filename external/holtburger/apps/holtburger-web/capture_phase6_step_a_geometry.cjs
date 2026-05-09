// Phase 6 step A capture script — drives the bundle through login →
// CharacterCreate (if needed) → spawn → @telepoi Holtburg → entity
// drain, then verifies that buildings render with leaf geometry
// (doors, windows, interior partitions) rather than the silhouette-
// only Phase 4-era path.
//
// Phase A's contract (per docs/phase-6-buildings-and-interiors.md §5):
//   1. Building Setup parsing walks every part (was: dropped at
//      `lib.rs:654-656`); each part becomes its own PIXI mesh.
//   2. The per-building PIXI.Container holding those parts is
//      addressable from JS via `window.buildingMap: Map<u64, PIXIContainer>`.
//   3. Aggregate triangle count per building grows ~order-of-magnitude
//      vs the silhouette baseline.
//
// IMPORTANT — Phase A is not yet implemented at the time this capture
// script lands. The implementation agent will add `window.buildingMap`
// (and the underlying wasm + JS plumbing) in a follow-up commit. Until
// that lands, this script will fail with a clear "Phase A not yet
// implemented" message rather than a generic null-deref. That's the
// intended behaviour — we're locking the contract before the
// implementation arrives.
//
// Pre-reqs (same as `capture_phase4_step3.cjs`; see docs/ace-local-setup.md):
// - Live ACE on Tailscale 100.116.47.66 UDP 9000 (login) / 9001 (world).
// - holtburger-wsbridge running on ws://127.0.0.1:8080/.
// - python3 -m http.server 8765 from external/holtburger/.
// - Manifest+shards baked under dist/ (the index.html consumes them
//   via init_resource_source).
// - The test account needs accessLevel ≥ 4 for `@telepoi` and `@pk`.
//   Tailnet creds `tailnet1/tailnet1` are pre-promoted to Developer.
//
// Run: `node capture_phase6_step_a_geometry.cjs` from `apps/holtburger-web/`.
// Outputs `docs/images/phase-6-step-a-geometry.png` and prints
// PASS / FAIL based on the buildingMap part-count + tri-count
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
    const OUT_PATH = path.resolve(
        __dirname,
        "../../../../docs/images/phase-6-step-a-geometry.png"
    );
    const CHAR_NAME = process.env.PHASE6_CHAR_NAME
        || `Phase6A${Date.now().toString(36).slice(-6)}`;
    const CREATE_TIMEOUT_MS = Number(process.env.PHASE4_CREATE_TIMEOUT_MS || 15_000);
    const SPAWN_TIMEOUT_MS = Number(process.env.PHASE4_SPAWN_TIMEOUT_MS || 15_000);
    const ENTITY_DRAIN_MS = Number(process.env.PHASE4_ENTITY_DRAIN_MS || 6_000);
    const TELEPORT_TIMEOUT_MS = Number(process.env.PHASE4_TELEPORT_TIMEOUT_MS || 5_000);
    // After Phase A's per-part walker lands, leaf-mesh bake has to
    // complete before buildingMap reads stable child counts. ~3 s is
    // a generous floor — bake-on-demand for ~50 Holtburg buildings
    // shouldn't exceed 1 s on the cached dat-shard path. Calibrate
    // post-implementation if needed.
    const GEOMETRY_BAKE_MS = Number(process.env.PHASE6_GEOMETRY_BAKE_MS || 3_000);
    // Minimum part count threshold per chosen building. **Holtburg
    // reality (verified 2026-05-09):** all 14 unique building model_ids
    // in the LB-0xa9b40000 ring are `0x01xxxxxx` raw GfxObjs, not
    // `0x02` SetupModels. By definition raw GfxObjs are 1-part each
    // (lib.rs:2622 `Some(vec![tris])`), so MIN_PARTS=1 is the realistic
    // floor for this dataset. Multi-part Setup correctness is pinned
    // separately by the `phase6.A.holtburg_townhall_part_count` smoke
    // check (synthetic 12-part fixture). What this capture validates
    // for real Holtburg data: the bake → wrap → addressable chain
    // produces a Container per building with at least one partWrapper
    // child (not a raw Sprite — door rotation needs the wrapper).
    const MIN_PARTS = Number(process.env.PHASE6_MIN_PARTS || 1);
    // Minimum aggregate triangle count for the chosen building.
    // 100 tris is "more than a flat shell" (flat shell = ~12 tris
    // for a box). Real Holtburg setups bake to thousands of tris;
    // this floor is chosen to be unmissable.
    // TODO: calibrate post-implementation against manual inspection.
    const MIN_TRI_COUNT = Number(process.env.PHASE6_MIN_TRI_COUNT || 100);

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
        // Surface anything that looks load-bearing for Phase A
        // (geometry / bake / building / triangulate trace lines)
        // alongside the standard error / warn channels.
        if (
            msg.type() === "error"
            || msg.type() === "warning"
            || /\[step|building|triangulate|bake|geometry|setup-walk/i.test(text)
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
    await page.fill('input[name="server_host"]', SERVER_IP);
    await page.fill('input[name="server_port"]', SERVER_PORT);
    console.log(`submitting login as ${ACCOUNT}`);

    await page.click('#login-form button[type=submit]');
    await page.waitForSelector("#selection:not([hidden])", { timeout: 30_000 });
    console.log("Selection visible");
    await page.waitForTimeout(500);

    // Mirror step 3 / step 5: populate the account if it's empty.
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

    // `@pk pk` enables FastTick (server-side physics) — harmless for
    // Phase A which only checks geometry, but kept here so the test
    // script is one-line-changeable to extend into Phase B's
    // collision assertions later. See step 3 for the full FastTick /
    // accessLevel rationale.
    console.log("sending '@pk pk' to enable FastTick (forward-compat for Phase B)");
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

    // Allow Phase A's leaf-bake to settle. The implementation walks
    // each building's Setup parts on first observation; subsequent
    // frames reuse the cache. ~3 s covers the visible Holtburg
    // neighbourhood at the cached dat-shard rate.
    console.log(`waiting ${GEOMETRY_BAKE_MS}ms for Phase A leaf-bake to settle`);
    await page.waitForTimeout(GEOMETRY_BAKE_MS);

    // === Phase A contract probe ==========================================
    //
    // Defensive read: `window.buildingMap` is a placeholder name —
    // the implementation agent may rename to something more idiomatic
    // (e.g. `window.liveScene.buildings` or `window.__buildings`). If
    // that renames lands, update the locator below and the smoke check
    // in `smoke_test.cjs` together.
    //
    // The probe collects, for each entry in buildingMap:
    //   - keyHex: building model_id as a hex string
    //   - childCount: number of child meshes (PIXI.Container.children.length)
    //   - triCount: aggregate triangle count across all children, as
    //     reported via `mesh.geometry.indexBuffer.data.length / 3` for
    //     PIXI Mesh / Graphics fallback `mesh.__triCount` if
    //     populated by the bake path. The bake path SHOULD attach
    //     `__triCount` to each child for precisely this reason — the
    //     implementation agent will need to hook this in lib.rs's
    //     PIXI emitter. If the convention differs, this probe falls
    //     through to childCount × 1 as a last resort.
    //   - x / y: container's world position (so we can pick the
    //     building closest to the local player).
    const probe = await page.evaluate(() => {
        const out = { phaseANotShipped: false, reason: null, entries: [], cameraX: null, cameraY: null };

        if (!window.buildingMap || typeof window.buildingMap.entries !== "function") {
            out.phaseANotShipped = true;
            out.reason =
                "window.buildingMap is undefined — Phase A (per-part building "
                + "geometry walker) has not yet shipped. See "
                + "docs/phase-6-buildings-and-interiors.md §5 phase A.";
            return out;
        }

        // Camera position — we use this as a proxy for "near the
        // player" since the local-player guid is closure-private.
        // The cameraContainer translation gives us the world-coord
        // origin the player is centred on.
        const cam = window.liveScene?.cameraContainer;
        if (cam) {
            out.cameraX = -cam.x;
            out.cameraY = -cam.y;
        }

        for (const [key, container] of window.buildingMap.entries()) {
            if (!container || typeof container !== "object") continue;
            const children = container.children || [];
            const childCount = children.length;

            let triCount = 0;
            // Phase 6 step E follow-up wraps each part sprite in an
            // inner Container (partWrapper) for hinge-pivoted rotation;
            // __triCount lives on the wrapper, not the inner sprite.
            // Fall through to the sprite's own __triCount for fused-
            // fallback containers that don't have wrappers.
            let wrappedChildren = 0;
            for (const child of children) {
                if (typeof child.__triCount === "number") {
                    triCount += child.__triCount;
                }
                // Recurse one level: partWrapper.children[0] is the
                // sprite, which may also carry __triCount on the
                // fallback path.
                for (const gc of child.children ?? []) {
                    if (typeof gc.__triCount === "number") {
                        triCount += gc.__triCount;
                    }
                }
                if (typeof child.__partIndex === "number") {
                    wrappedChildren += 1;
                }
            }

            // Display the model_id (set by the bake path), not the
            // map's string key — `Number("a9b4fffe_84.50_..._01001117")`
            // is NaN and produced misleading 0x00000000 logs.
            const modelId = container.__buildingId;
            const modelHex = typeof modelId === "number"
                ? `0x${(modelId >>> 0).toString(16).toUpperCase().padStart(8, "0")}`
                : "(no __buildingId)";

            out.entries.push({
                keyHex: modelHex,
                childCount,
                wrappedChildren,
                triCount,
                x: container.x ?? 0,
                y: container.y ?? 0,
            });
        }

        return out;
    });

    if (probe.phaseANotShipped) {
        console.error(`FAIL (phase-A-not-shipped): ${probe.reason}`);
        await page.screenshot({ path: OUT_PATH, fullPage: false });
        console.log(`saved ${OUT_PATH}`);
        await browser.close();
        process.exit(1);
    }

    if (!probe.entries || probe.entries.length === 0) {
        console.error(
            "FAIL: window.buildingMap exists but is empty — no building "
            + "placements were emitted from fetch_landblock_objects's building "
            + "branch. Phase A emitter may not be firing on the Holtburg "
            + "neighbourhood prefetch."
        );
        await page.screenshot({ path: OUT_PATH, fullPage: false });
        console.log(`saved ${OUT_PATH}`);
        await browser.close();
        process.exit(1);
    }

    console.log(`buildingMap: ${probe.entries.length} buildings`);
    console.log(`camera at: (${probe.cameraX?.toFixed(2)}, ${probe.cameraY?.toFixed(2)})`);

    // Pick the building closest to the camera (proxy for "near the
    // player / town hall"). If camera position isn't readable, fall
    // back to the building with the highest child count — the town
    // hall is the largest structure in Holtburg.
    let chosen = null;
    if (probe.cameraX !== null && probe.cameraY !== null) {
        let bestDist = Infinity;
        for (const e of probe.entries) {
            const dx = e.x - probe.cameraX;
            const dy = e.y - probe.cameraY;
            const d = Math.hypot(dx, dy);
            if (d < bestDist) {
                bestDist = d;
                chosen = e;
            }
        }
        console.log(
            `closest building to camera: ${chosen.keyHex} `
            + `at (${chosen.x.toFixed(2)}, ${chosen.y.toFixed(2)}), dist=${bestDist.toFixed(2)} m`
        );
    } else {
        // Largest by child count — likely the town hall.
        chosen = probe.entries.reduce(
            (acc, e) => (e.childCount > acc.childCount ? e : acc),
            probe.entries[0]
        );
        console.log(`(no camera) largest building by childCount: ${chosen.keyHex}`);
    }

    console.log(
        `chosen building: ${chosen.keyHex}, children=${chosen.childCount}, `
        + `triangles=${chosen.triCount}`
    );

    // Print top 5 buildings by child count for diagnostic context —
    // useful when the chosen building underperforms, lets us see if
    // a different one would have passed.
    const top5 = [...probe.entries]
        .sort((a, b) => b.childCount - a.childCount)
        .slice(0, 5);
    console.log("top 5 buildings by childCount:");
    for (const e of top5) {
        console.log(
            `    ${e.keyHex}: ${e.childCount} children, ${e.triCount} triangles, `
            + `(${e.x.toFixed(2)}, ${e.y.toFixed(2)})`
        );
    }

    // Frame + screenshot. We don't try to centre on the chosen
    // building (camera arithmetic mirrors step 3's deferred
    // approach); the screenshot is for visual regression alongside
    // the assertions, not for cropping precision.
    await page.evaluate(() => {
        const canvasElem = document.getElementById("canvas");
        if (canvasElem) canvasElem.scrollIntoView({ block: "start" });
    });
    await page.waitForTimeout(200);
    await page.screenshot({ path: OUT_PATH, fullPage: false });
    console.log(`saved ${OUT_PATH}`);

    const partsOk = chosen.childCount >= MIN_PARTS;
    const trisOk = chosen.triCount > MIN_TRI_COUNT;
    // Per-part wrapping correctness: each child should be a partWrapper
    // Container tagged with __partIndex (Phase 6E hinge-rotation
    // contract). A bare-Sprite child indicates the fallback fused path.
    // For Holtburg's all-`0x01` raw GfxObjs, partCount=1 — but the
    // single child must STILL be a wrapper so door rotation is
    // addressable. Falls back to "any child counts" for the fallback
    // fused path.
    const wrappingOk = chosen.wrappedChildren === chosen.childCount;

    console.log("=========================");
    console.log(`MIN_PARTS=${MIN_PARTS}, MIN_TRI_COUNT=${MIN_TRI_COUNT}`);
    console.log(`chosen.childCount=${chosen.childCount} (>= ${MIN_PARTS}? ${partsOk})`);
    console.log(`chosen.wrappedChildren=${chosen.wrappedChildren}/${chosen.childCount} (all wrapped? ${wrappingOk})`);
    console.log(`chosen.triCount=${chosen.triCount} (> ${MIN_TRI_COUNT}? ${trisOk})`);

    if (partsOk && trisOk && wrappingOk) {
        console.log(
            `PASS: building ${chosen.keyHex} has ${chosen.childCount} part(s) `
            + `(>= ${MIN_PARTS}), all wrapped in partWrappers, and `
            + `${chosen.triCount} aggregate triangles (> ${MIN_TRI_COUNT}). `
            + `Phase A per-part walker is live + Phase 6E hinge-wrapping in place.`
        );
        await browser.close();
        process.exit(0);
    } else if (!wrappingOk) {
        console.error(
            `FAIL: building ${chosen.keyHex} has ${chosen.childCount} children but `
            + `only ${chosen.wrappedChildren} are partWrappers. The remainder are `
            + `bare Sprites — Phase 6E hinge-rotation will not work for them. `
            + `Check buildBuildingsContainer's per-part path is taken (vs fallback).`
        );
        await browser.close();
        process.exit(1);
    } else if (!partsOk) {
        console.error(
            `FAIL: building ${chosen.keyHex} has only ${chosen.childCount} children `
            + `(< ${MIN_PARTS}). For Holtburg this should be ≥ 1 (all 0x01 raw `
            + `GfxObjs). Empty container indicates the bake → addChild chain broke.`
        );
        await browser.close();
        process.exit(1);
    } else {
        console.error(
            `FAIL: building ${chosen.keyHex} has ${chosen.childCount} children but only `
            + `${chosen.triCount} triangles (< ${MIN_TRI_COUNT}). Children may be `
            + `present as empty containers — verify the triangulator at `
            + `lib.rs:1520-1584 is being invoked per part.`
        );
        await browser.close();
        process.exit(1);
    }
})().catch((err) => {
    console.error("capture failed:", err);
    process.exit(1);
});
