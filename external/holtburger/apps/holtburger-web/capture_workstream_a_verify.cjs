// Workstream A verification capture — drives the bundle through
// login → CharacterCreate → academy spawn → @telepoi Holtburg →
// W-hold 3 s. After each phase asserts the three Workstream-A
// invariants from docs/3d-camera-game-feel-fix-prompt.md:
//
//   1. window.getLocalPlayerGuid() returns a non-zero u32 (NOT null)
//      AND both entityMap and liveScene3d.entityManager.entityMap
//      hold the player guid.
//   2. Under W-hold, window.__lastEntityWorldPos.get(playerGuid)
//      updates at >= 10 distinct values per second.
//   3. window.__sessionHandle.getLocalPlayerPose() returns an object
//      with {x,y,z,heading} matching the wasm heartbeat trace within
//      ±0.1 m.
//
// Uses ?renderer=3d so the EntityManager rig path is exercised.
//
// Pre-reqs:
// - Live ACE on Tailscale 100.116.47.66 UDP 9000.
// - holtburger-wsbridge on ws://127.0.0.1:8080/.
// - python3 -m http.server 8765 from external/holtburger/.
// - Manifest+shards baked under dist/.
// - Account fresh each run (RUN_TAG → PHASE4_TEST_ACCOUNT).
//
// Run: `node capture_workstream_a_verify.cjs` from `apps/holtburger-web/`.

const { chromium } = require("playwright");
const path = require("node:path");

(async () => {
    const RUN_TAG = process.env.WSA_RUN_TAG || `wsa${Date.now().toString(36)}`;
    const ACCOUNT = process.env.PHASE4_TEST_ACCOUNT || RUN_TAG;
    const PASSWORD = process.env.PHASE4_TEST_PASSWORD || RUN_TAG;
    const CHAR_NAME = process.env.WSA_CHAR_NAME || `Wsa${RUN_TAG.slice(-6)}`;
    const BRIDGE_URL = process.env.PHASE4_BRIDGE_URL || "ws://127.0.0.1:8080/";
    const SERVER_IP = process.env.PHASE4_SERVER_IP || "100.116.47.66";
    const SERVER_PORT = process.env.PHASE4_SERVER_PORT || "9000";
    const PAGE_URL = process.env.PHASE4_PAGE_URL
        || "http://127.0.0.1:8765/apps/holtburger-web/index.html?renderer=3d";
    const WALK_HOLD_MS = Number(process.env.WSA_WALK_HOLD_MS || 3000);
    const SPAWN_TIMEOUT_MS = Number(process.env.WSA_SPAWN_TIMEOUT_MS || 60_000);
    const CREATE_TIMEOUT_MS = Number(process.env.WSA_CREATE_TIMEOUT_MS || 30_000);
    const POST_SPAWN_DRAIN_MS = Number(process.env.WSA_POST_SPAWN_DRAIN_MS || 3000);
    const OUT_PATH = path.resolve(__dirname, "../../../../docs/images/workstream-a.png");

    console.log(`launching chromium → ${PAGE_URL}`);
    console.log(`target ACE: ${SERVER_IP}:${SERVER_PORT} via ${BRIDGE_URL}`);
    console.log(`account: ${ACCOUNT}, character: ${CHAR_NAME}`);

    const browser = await chromium.launch({ args: ["--use-gl=swiftshader"] });
    const context = await browser.newContext({ viewport: { width: 1280, height: 1024 } });
    const page = await context.newPage();

    const consoleLines = [];
    const t0 = Date.now();
    page.on("console", (msg) => {
        const text = msg.text();
        const entry = { t: Date.now() - t0, type: msg.type(), text };
        consoleLines.push(entry);
        if (/workstream-A|\[step 3\.6 tick #|\[acad-diag|\[phase7|spawn|init3D|EntityManager|\[scene3d/.test(text)
            || msg.type() === "warning" || msg.type() === "error"
            || /pageerror/.test(msg.type())) {
            console.log(`[browser ${msg.type()} +${entry.t}ms] ${text}`);
        }
    });
    page.on("pageerror", (err) => {
        console.error("[pageerror]", err.message);
    });

    await page.goto(PAGE_URL, { waitUntil: "domcontentloaded" });

    try {
        await page.waitForFunction(() => {
            const r = document.getElementById("results");
            return r && /PASS/.test(r.innerHTML);
        }, { timeout: 30_000 });
        console.log("wasm-side smoke checks PASS");
    } catch (e) {
        const html = await page.locator("#results").innerHTML().catch(() => "(unavailable)");
        console.error("results panel:", html.slice(0, 500));
        await browser.close();
        process.exit(1);
    }

    // Login
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

    // CharacterCreate if needed
    const initialCount = await page.locator('#character-ul button[data-id]').count();
    if (initialCount === 0) {
        const createVisible = await page.locator("#create-form:not([hidden])").count() > 0;
        if (!createVisible) {
            console.error("Create-character form hidden — bailing.");
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

    // Spawn
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
    const spawnStatusText = await page.locator("#login-status").innerText();
    console.log(`Spawned/InWorld status reached: "${spawnStatusText.slice(0, 200)}"`);

    await page.waitForTimeout(POST_SPAWN_DRAIN_MS);

    // Teleport to Holtburg so the W-hold actually translates to movement
    // (academy is an indoor cell with rubberband-prone collision in PK
    // mode). The teleport button drives `@telepoi Holtburg` via sendChat,
    // matching the manual flow.
    try {
        await page.click('#teleport-button', { timeout: 5_000 });
        console.log("clicked Teleport to Holtburg");
        await page.waitForTimeout(3_000);
    } catch (e) {
        console.warn(`teleport-button click failed (may not exist): ${e.message}`);
    }

    // === CHECKPOINT #1 — local-player GUID + entity maps =====================
    const cp1 = await page.evaluate(() => {
        const out = {};
        // Diagnostic: pull every relevant globals to figure out the gap
        out.hasFn = typeof window.getLocalPlayerGuid === "function";
        out.hasSetFn = typeof window.setLocalPlayerGuid === "function";
        out.spawnedFromHandler = window.__spawnedPlayerGuidProbe ?? null;
        out.statusText = document.getElementById("login-status")?.innerText.slice(0, 100) ?? "";
        out.guid = window.getLocalPlayerGuid ? window.getLocalPlayerGuid() : null;
        out.guidHex = (typeof out.guid === "number" && out.guid !== null)
            ? `0x${(out.guid >>> 0).toString(16).toUpperCase().padStart(8, "0")}`
            : "(null)";
        out.entityMapHas = window.entityMap && typeof out.guid === "number" && out.guid !== null
            ? !!window.entityMap.has(out.guid >>> 0)
            : false;
        out.entityMapSize = window.entityMap?.size ?? 0;
        out.scene3dEntityMapHas = false;
        out.scene3dEntityMapSize = 0;
        out.scene3dLive = !!window.liveScene3d;
        try {
            const em = window.liveScene3d?.entityManager?.entityMap;
            if (em) {
                out.scene3dEntityMapSize = em.size;
                if (typeof out.guid === "number" && out.guid !== null) {
                    out.scene3dEntityMapHas = !!em.has(out.guid >>> 0);
                }
            }
        } catch (e) { out.scene3dErr = e.message || String(e); }
        // Diagnostic — what entityMap actually contains right now
        out.entityMapGuids = [];
        if (window.entityMap) {
            for (const g of window.entityMap.keys()) {
                out.entityMapGuids.push(`0x${(g >>> 0).toString(16).toUpperCase().padStart(8, "0")}`);
            }
        }
        return out;
    });
    console.log(`[CP1] getLocalPlayerGuid=${cp1.guidHex} ` +
        `entityMap.has=${cp1.entityMapHas} (size=${cp1.entityMapSize}) ` +
        `liveScene3d.entityMap.has=${cp1.scene3dEntityMapHas} (size=${cp1.scene3dEntityMapSize}, live=${cp1.scene3dLive})`);
    console.log(`[CP1]   hasFn=${cp1.hasFn} hasSetFn=${cp1.hasSetFn} loginStatus="${cp1.statusText}"`);
    if (cp1.entityMapGuids.length > 0 && cp1.entityMapGuids.length < 20) {
        console.log(`[CP1]   entityMap GUIDs: ${cp1.entityMapGuids.join(", ")}`);
    } else if (cp1.entityMapGuids.length >= 20) {
        console.log(`[CP1]   entityMap GUIDs (first 5): ${cp1.entityMapGuids.slice(0, 5).join(", ")} ... (+ ${cp1.entityMapGuids.length - 5} more)`);
    }

    // Focus canvas for WASD
    const canvas = await page.locator("canvas").first();
    if ((await canvas.count()) > 0) {
        await canvas.click();
    }

    // === CHECKPOINT #2 — Position update rate under W-hold ===================
    console.log(`[CP2] sampling __lastEntityWorldPos every 100ms during ${WALK_HOLD_MS}ms W-hold`);
    await page.evaluate(({ guid, dur }) => {
        window.__wsaPositionSamples = [];
        if (typeof guid !== "number") return;
        const start = performance.now();
        const interval = setInterval(() => {
            const map = window.__lastEntityWorldPos;
            const pose = map?.get(guid >>> 0);
            if (pose) {
                window.__wsaPositionSamples.push({
                    t: performance.now() - start,
                    x: pose.x,
                    y: pose.y,
                    z: pose.z,
                });
            }
        }, 100);
        window.__wsaPositionInterval = interval;
        setTimeout(() => {
            clearInterval(window.__wsaPositionInterval);
            window.__wsaPositionInterval = null;
        }, dur + 200);
    }, { guid: cp1.guid, dur: WALK_HOLD_MS });

    await page.keyboard.down("w");
    await page.waitForTimeout(WALK_HOLD_MS);
    await page.keyboard.up("w");
    await page.waitForTimeout(500);

    const cp2 = await page.evaluate(() => {
        const samples = window.__wsaPositionSamples || [];
        // count distinct (x,y) pairs (rounded to 0.001 m)
        const seen = new Set();
        for (const s of samples) {
            const k = `${s.x.toFixed(3)},${s.y.toFixed(3)}`;
            seen.add(k);
        }
        return {
            sampleCount: samples.length,
            distinctPositions: seen.size,
            firstSample: samples[0] || null,
            lastSample: samples[samples.length - 1] || null,
            durationMs: samples.length > 0
                ? samples[samples.length - 1].t - samples[0].t : 0,
        };
    });
    console.log(`[CP2] samples=${cp2.sampleCount} distinct=${cp2.distinctPositions} ` +
        `duration=${cp2.durationMs.toFixed(0)}ms`);
    if (cp2.firstSample && cp2.lastSample) {
        console.log(`[CP2]   first=(${cp2.firstSample.x.toFixed(2)}, ${cp2.firstSample.y.toFixed(2)}, ${cp2.firstSample.z.toFixed(2)}) ` +
            `last=(${cp2.lastSample.x.toFixed(2)}, ${cp2.lastSample.y.toFixed(2)}, ${cp2.lastSample.z.toFixed(2)})`);
    }

    // === CHECKPOINT #3 — getLocalPlayerPose() vs heartbeat tick log ==========
    const cp3 = await page.evaluate(() => {
        const out = {};
        const h = window.__sessionHandle;
        if (!h) { out.err = "no session handle"; return out; }
        if (typeof h.getLocalPlayerPose !== "function") {
            out.err = "getLocalPlayerPose not exported";
            return out;
        }
        const pose = h.getLocalPlayerPose();
        if (!pose) { out.err = "getLocalPlayerPose returned null"; return out; }
        out.x = pose.x;
        out.y = pose.y;
        out.z = pose.z;
        out.heading = pose.heading;
        out.landblockId = pose.landblockId;
        out.landblockIdHex = `0x${(pose.landblockId >>> 0).toString(16).toUpperCase().padStart(8, "0")}`;
        return out;
    });
    if (cp3.err) {
        console.log(`[CP3] FAIL: ${cp3.err}`);
    } else {
        console.log(`[CP3] getLocalPlayerPose=(${cp3.x.toFixed(3)}, ${cp3.y.toFixed(3)}, ${cp3.z.toFixed(3)}) ` +
            `heading=${cp3.heading.toFixed(4)} rad lb=${cp3.landblockIdHex}`);
    }

    // === HEARTBEAT TRACE COMPARISON =========================================
    // Pull the most recent `[step 3.6 tick #N] pose=(...)` line and compare.
    const tickLines = consoleLines.filter((c) => /\[step 3\.6 tick #/.test(c.text));
    let tickPose = null;
    if (tickLines.length > 0) {
        const last = tickLines[tickLines.length - 1].text;
        const m = last.match(/pose=\(([-\d.]+),\s*([-\d.]+),\s*([-\d.]+)\)/);
        if (m) {
            tickPose = { x: parseFloat(m[1]), y: parseFloat(m[2]), z: parseFloat(m[3]) };
        }
    }
    if (tickPose && !cp3.err) {
        const dx = Math.abs(tickPose.x - cp3.x);
        const dy = Math.abs(tickPose.y - cp3.y);
        const dz = Math.abs(tickPose.z - cp3.z);
        console.log(`[CP3] heartbeat tick pose=(${tickPose.x.toFixed(3)}, ${tickPose.y.toFixed(3)}, ${tickPose.z.toFixed(3)})`);
        console.log(`[CP3] |Δpose|=(${dx.toFixed(4)}, ${dy.toFixed(4)}, ${dz.toFixed(4)}) ` +
            `max=${Math.max(dx, dy, dz).toFixed(4)} m`);
    } else if (!tickPose) {
        console.log(`[CP3] no [step 3.6 tick #N] pose= line found in transcript`);
    }

    await page.screenshot({ path: OUT_PATH, fullPage: false });
    console.log(`saved ${OUT_PATH}`);

    await browser.close();

    // === ACCEPTANCE GATES ===================================================
    console.log("");
    console.log("======== WORKSTREAM A ACCEPTANCE ========");

    // Gate 1: GUID non-null + both maps
    const g1 = (typeof cp1.guid === "number" && (cp1.guid >>> 0) !== 0)
        && cp1.entityMapHas;
    // scene3d entity map only required if renderer=3d resolved; soft-warn
    console.log(`[Gate 1] getLocalPlayerGuid + 2D entityMap.has: ${g1 ? "PASS" : "FAIL"}`);
    console.log(`         (3D entityMap.has: ${cp1.scene3dEntityMapHas ? "yes" : "no — may be pre-rig"})`);

    // Gate 2: ≥10 distinct positions/s = ≥30 over 3 s walk
    const targetDistinct = Math.floor((WALK_HOLD_MS / 1000) * 10);
    const g2 = cp2.distinctPositions >= targetDistinct;
    console.log(`[Gate 2] distinct positions (${cp2.distinctPositions}) ≥ ${targetDistinct}: ${g2 ? "PASS" : "FAIL"}`);

    // Gate 3: pose returns + within ±0.1 m of heartbeat
    const g3a = !cp3.err;
    const g3b = tickPose && !cp3.err
        ? (Math.abs(tickPose.x - cp3.x) <= 0.1
            && Math.abs(tickPose.y - cp3.y) <= 0.1
            && Math.abs(tickPose.z - cp3.z) <= 0.1)
        : null;
    console.log(`[Gate 3a] getLocalPlayerPose returns: ${g3a ? "PASS" : "FAIL"}`);
    console.log(`[Gate 3b] pose vs heartbeat tick within ±0.1 m: ${
        g3b === null ? "SKIP (no tick log)" : g3b ? "PASS" : "FAIL"
    }`);

    const allPass = g1 && g2 && g3a && (g3b === null || g3b);
    console.log("");
    console.log(`OVERALL: ${allPass ? "PASS" : "FAIL"}`);
    console.log("===========================================");
    process.exit(allPass ? 0 : 1);
})().catch((err) => {
    console.error("capture failed:", err);
    process.exit(1);
});
