// capture_skybox_demo.cjs — 2026-05-11
//
// Demo capture for the skybox push. Single Chromium spawn (one
// init3D memory peak), then in-session cycle through ~10 demo
// shots showcasing time-of-day variation + DayGroup weather
// variation + (optionally) indoor flip.
//
// Output: /mnt/wbterminal1/holtburger-captures/skybox-demo-<run-tag>/
//
// Pre-reqs:
// - Live ACE on Tailscale 100.116.47.66 UDP 9000.
// - holtburger-wsbridge on ws://127.0.0.1:8080/.
// - Web proxy on 127.0.0.1:7080.
//
// Run: NODE_PATH=/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules \
//      node capture_skybox_demo.cjs

const path = require("node:path");
const fs = require("node:fs");

const PLAYWRIGHT_CACHE =
    process.env.PLAYWRIGHT_CACHE ||
    "/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules";
let chromium;
try {
    ({ chromium } = require("playwright"));
} catch (_) {
    ({ chromium } = require(path.join(PLAYWRIGHT_CACHE, "playwright")));
}

// ============================================================================
// Demo shot list.
//
// Each entry produces one screenshot. The capture loops through this
// list in order, applying the override per entry, settling for
// OVERRIDE_SETTLE_MS, then snapshotting the canvas.
//
// `t` = time-of-day [0, 1) per Sky-B's wasm. `day` + `year` are passed
// to setGameDayOverride if both are non-null, otherwise the default
// (real-world today via AC_LAUNCH_UNIX_EPOCH derivation) is used.
//
// Naming convention: NN-<time-label>-<weather-label>.png so the file
// listing sorts in viewing order.
// ============================================================================
const SHOTS = [
    // Time-of-day cycle, default day group (today's LCG selection).
    { name: "01-midnight-default",     t: 0.00, day: null, year: null,
      desc: "midnight — dim purple ambient, near-black fog, base sky shells only" },
    { name: "02-foredawn-sun-rising",  t: 0.05, day: null, year: null,
      desc: "foredawn t=0.05 — sun begin=0.04 window opens; moon (begin=0) still visible" },
    { name: "03-dawn",                 t: 0.18, day: null, year: null,
      desc: "dawn — sun arcing toward end_angle, dramatic horizon color" },
    { name: "04-mid-morning",          t: 0.35, day: null, year: null,
      desc: "mid-morning — sun + moon SkyObjects offscreen, lighting from SkyTimeOfDay only" },
    { name: "05-noon",                 t: 0.50, day: null, year: null,
      desc: "noon — brightest amb_color, light cyan-blue sky, fog pushed far" },
    { name: "06-afternoon",            t: 0.65, day: null, year: null,
      desc: "mid-afternoon — fog warming, ambient cooling toward dusk" },
    { name: "07-dusk",                 t: 0.80, day: null, year: null,
      desc: "dusk — warm orange/red horizon, fog close, stars about to engage" },
    { name: "08-late-evening",         t: 0.92, day: null, year: null,
      desc: "late evening — stars (begin=0.16 end=0.94) still visible, ambient deepening" },

    // DayGroup variation at noon. Sky-G's CalcPresentDayGroup LCG hash
    // maps (day, year) to one of Dereth's 20 DayGroups. 360-day probe
    // showed roughly uniform coverage across buckets. Sampling 3
    // disparate days should land us on 3 different weather profiles
    // (mix of Sunny / Rainy / Clear / Cloudy from the 20-group set).
    { name: "09-noon-dgA-day000",      t: 0.50, day: 0,   year: 10,
      desc: "noon, DayGroup via day=0,year=10 — alternative SkyObject set" },
    { name: "10-noon-dgB-day120",      t: 0.50, day: 120, year: 10,
      desc: "noon, DayGroup via day=120,year=10 — alternative weather" },
    { name: "11-noon-dgC-day240",      t: 0.50, day: 240, year: 10,
      desc: "noon, DayGroup via day=240,year=10 — alternative weather" },

    // Sky-I-C eye-test shots — explicit camera-look-up at sun-in-window
    // times. Sky-I-A's probe verified sun world pos `(34674, 96.8,
    // -36165)` at t=0.05 — distance 2676 from camera, well inside
    // skyCamera.far=50000. But the follow-camera looks ~horizontally
    // by default; sun is sky-up. These shots force the camera's
    // quaternion to look 30° up + 7° west of north so the sun's
    // compass-bearing arc passes through the center of the frame.
    //
    // Sun progression across the visible window (sun_visibility_probe
    // 2026-05-11):
    //   t=0.04 begin: NDC (1.44, 0.35) — off-screen RIGHT, just rising
    //   t=0.05:       NDC (0.87, 0.35) — on right edge of frame
    //   t=0.10:       NDC (-0.10, 0.35) — DIRECTLY OVERHEAD center
    //   t=0.15:       NDC (-1.83, 0.35) — off-screen LEFT, past zenith
    //   t=0.21 end:   sun out-of-window, becomes invisible
    //
    // t=0.07 sits at NDC ~0.4 — sun visible in upper-right, mid-rise.
    // t=0.10 sits at NDC ~-0.1 — sun directly overhead. Clearest shot.
    // t=0.13 sits at NDC ~-0.8 — sun in upper-left, late morning.
    { name: "12-sun-arc-rising-look-up", t: 0.07, day: null, year: null,
      lookUp: true,
      desc: "Sky-I-C eye-test: t=0.07 + camera tilt up 30° — sun visible upper-right at compass ~40° east of north" },
    { name: "13-sun-overhead-look-up",   t: 0.10, day: null, year: null,
      lookUp: true,
      desc: "Sky-I-C eye-test: t=0.10 + camera tilt up — sun directly overhead (NDC -0.1, 0.35); definitive sun-visible shot" },
    { name: "14-sun-arc-setting-look-up", t: 0.13, day: null, year: null,
      lookUp: true,
      desc: "Sky-I-C eye-test: t=0.13 + camera tilt up — sun upper-left passing through zenith" },
];

(async () => {
    const RUN_TAG = process.env.DEMO_RUN_TAG || `demo${Date.now().toString(36)}`;
    const ACCOUNT = process.env.PHASE4_TEST_ACCOUNT || RUN_TAG;
    const PASSWORD = process.env.PHASE4_TEST_PASSWORD || RUN_TAG;
    const CHAR_NAME = process.env.DEMO_CHAR_NAME || `Demo${RUN_TAG.slice(-6)}`;
    const BRIDGE_URL = process.env.PHASE4_BRIDGE_URL || "ws://127.0.0.1:8080/";
    const SERVER_IP = process.env.PHASE4_SERVER_IP || "100.116.47.66";
    const SERVER_PORT = process.env.PHASE4_SERVER_PORT || "9000";
    const PAGE_URL = process.env.DEMO_PAGE_URL
        || "http://127.0.0.1:7080/apps/holtburger-web/index.html?renderer=3d";
    const OVERRIDE_SETTLE_MS = Number(process.env.DEMO_SETTLE_MS || 500);

    const OUT_BASE = process.env.DEMO_OUT_DIR || "/mnt/wbterminal1/holtburger-captures";
    const OUT_DIR = path.join(OUT_BASE, `skybox-demo-${RUN_TAG}`);
    fs.mkdirSync(OUT_DIR, { recursive: true });

    console.log("=== Skybox demo capture ===");
    console.log(`account=${ACCOUNT}, character=${CHAR_NAME}`);
    console.log(`output=${OUT_DIR}`);
    console.log(`shots=${SHOTS.length}`);

    const browser = await chromium.launch({
        headless: true,
        args: [
            "--disable-background-timer-throttling",
            "--disable-renderer-backgrounding",
            "--disable-features=CalculateNativeWinOcclusion",
            "--disable-backgrounding-occluded-windows",
        ],
    });
    const context = await browser.newContext({
        viewport: { width: 1600, height: 900 },
    });
    const page = await context.newPage();

    page.on("console", (msg) => {
        const txt = msg.text();
        if (/error|fail|panic|exception/i.test(txt)) {
            console.log(`  page: ${msg.type()} ${txt.slice(0, 200)}`);
        }
    });

    try {
        // ---- Login + spawn (mirrors capture_skybox_e2e.cjs flow) -----------
        console.log("[1/5] navigating + filling login form");
        await page.goto(PAGE_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
        await page.waitForFunction(
            () => document.querySelector('input[name="server_host"]') !== null,
            { timeout: 30_000 }
        );
        await page.fill('input[name="account"]', ACCOUNT);
        await page.fill('input[name="password"]', PASSWORD);
        await page.fill('input[name="bridge_url"]', BRIDGE_URL);
        await page.fill('input[name="server_host"]', SERVER_IP);
        await page.fill('input[name="server_port"]', SERVER_PORT);
        await page.click('#login-form button[type=submit]');

        console.log("[2/5] waiting for character selection or create form");
        await page.waitForSelector("#selection:not([hidden])", { timeout: 30_000 });
        await page.waitForTimeout(500);
        const initialCount = await page.locator('#character-ul button[data-id]').count();
        if (initialCount === 0) {
            const createVisible = await page.locator("#create-form:not([hidden])").count() > 0;
            if (!createVisible) {
                throw new Error("Create-character form hidden");
            }
            console.log(`creating character "${CHAR_NAME}"`);
            await page.fill('#create-form input[name="char_name"]', CHAR_NAME);
            await page.click('#create-button');
            await page.waitForFunction(() => {
                const s = document.getElementById("create-status");
                return s && /Created\b/.test(s.innerText);
            }, { timeout: 30_000 });
            await page.waitForFunction(() => {
                return document.querySelectorAll('#character-ul button[data-id]').length > 0;
            }, { timeout: 10_000 });
        }
        await page.locator('#character-ul button[data-id]').first().click();

        console.log("[3/5] waiting for spawn (#login-status → InWorld|Spawned)");
        await page.waitForFunction(() => {
            const s = document.getElementById("login-status");
            return s && /InWorld|Spawned/.test(s.innerText);
        }, { timeout: 60_000 });
        await page.waitForTimeout(3_000); // post-spawn drain

        // Teleport to Holtburg outdoor (sky is meaningless inside Academy).
        //
        // Sky-I-C (2026-05-11): the prior 3-second post-teleport wait was
        // racing the LB transition. Click order: client clicks #teleport-button
        // → ACE processes server-side → UpdatePosition fires with the new
        // Holtburg landblockId → client's Phase 6 cell-graph publishes a
        // fresh cell snapshot with `is_indoor=false`. At 3s the player was
        // **still inside Academy** with the sky cell hidden by the indoor
        // flip, so every demo screenshot was an Academy interior shot —
        // explaining the "midnight looks like noon" report that motivated
        // the whole Sky-I correction.
        //
        // The right poll has two parts:
        //   (a) `getCurrentCellId() > 0` — proves the recv-loop has
        //       published at least one cell snapshot (pre-snapshot the
        //       snapshot defaults to `is_indoor=false` with `current_cell=0`,
        //       so reading `isCurrentCellIndoor()` alone passes vacuously).
        //   (b) `isCurrentCellIndoor() === false` — proves the published
        //       snapshot is outdoor (i.e. we're actually in Holtburg, not
        //       Academy).
        try {
            await page.click('#teleport-button', { timeout: 5_000 });
            console.log("clicked Teleport to Holtburg");
            const teleportStartMs = Date.now();
            await page.waitForFunction(
                () => {
                    const h = window.__sessionHandle;
                    try {
                        if (!h
                            || typeof h.getCurrentCellId !== "function"
                            || typeof h.isCurrentCellIndoor !== "function") {
                            return false;
                        }
                        const cellId = h.getCurrentCellId() >>> 0;
                        if (cellId === 0) return false;
                        return h.isCurrentCellIndoor() === false;
                    } catch (_) {
                        return false;
                    }
                },
                { timeout: 60_000 }
            );
            const teleportMs = Date.now() - teleportStartMs;
            const stateInfo = await page.evaluate(() => {
                const h = window.__sessionHandle;
                const cellId = h.getCurrentCellId() >>> 0;
                const pose = (typeof h.getLocalPlayerPose === "function")
                    ? h.getLocalPlayerPose() : null;
                return {
                    cellId: "0x" + cellId.toString(16).padStart(8, "0"),
                    lb: pose ? "0x" + ((pose.landblockId >>> 0) >>> 0).toString(16).padStart(8, "0") : null,
                };
            });
            console.log(`outdoor after ${teleportMs} ms (cellId=${stateInfo.cellId} lb=${stateInfo.lb})`);
        } catch (e) {
            console.warn(`teleport-button + outdoor-wait failed (continuing): ${e.message}`);
        }

        // Wait for init3D + Sky-D celestials.
        console.log("[4/5] waiting for init3D + Sky-D celestials");
        await page.waitForFunction(() => !!window.liveScene3d, { timeout: 90_000 });
        await page.waitForFunction(
            () => {
                const ls = window.liveScene3d;
                if (!ls) return false;
                // Sky-I-B: celestial bodies live in skyDome.skyScene.
                let n = 0;
                const walk = (root) => {
                    if (!root?.children) return;
                    for (const c of root.children) {
                        if (c.userData?.sky_object_id !== undefined) n += 1;
                        if (c.children?.length) {
                            for (const gc of c.children) {
                                if (gc.userData?.sky_object_id !== undefined) n += 1;
                            }
                        }
                    }
                };
                walk(ls.scene);
                walk(ls.skyDome?.skyScene);
                return n > 0;
            },
            { timeout: 60_000 }
        );

        // /god to prevent fall-damage death mid-capture.
        try {
            await page.evaluate(() => {
                const h = window.__sessionHandle;
                if (h && typeof h.sendChat === "function") {
                    try { h.sendChat("/god"); } catch (_) { /* swallow */ }
                }
            });
            await page.waitForTimeout(500);
        } catch (_) { /* swallow */ }

        // ---- Loop through demo shots --------------------------------------
        console.log(`[5/5] producing ${SHOTS.length} demo shots`);
        const manifest = [];
        for (const shot of SHOTS) {
            // Apply DayGroup override (if any) BEFORE time override, so
            // CalcPresentDayGroup picks the right keyframe set for the
            // time-of-day lerp.
            if (shot.day !== null && shot.year !== null) {
                await page.evaluate(({ d, y }) => {
                    const h = window.__sessionHandle;
                    if (typeof h?.setGameDayOverride === "function") {
                        try { h.setGameDayOverride(d, y); } catch (_) { /* swallow */ }
                    }
                }, { d: shot.day, y: shot.year });
            } else {
                // Clear any prior DayGroup override.
                await page.evaluate(() => {
                    const h = window.__sessionHandle;
                    if (typeof h?.setGameDayOverride === "function") {
                        try { h.setGameDayOverride(0xFFFFFFFF, 0xFFFFFFFF); } catch (_) { /* swallow */ }
                    }
                });
            }

            // Apply time override.
            await page.evaluate((t) => {
                const h = window.__sessionHandle;
                if (typeof h?.setSkyTimeOverride === "function") {
                    try { h.setSkyTimeOverride(t); } catch (_) { /* swallow */ }
                }
            }, shot.t);

            // Sky-I-C eye-test camera-look-up override (shots 12-14).
            // The follow-camera looks ~horizontally by default; the sun
            // is sky-up. For the explicit "sun visible" eye-test shots
            // we monkey-patch `renderer.render` to override the camera
            // quaternion JUST BEFORE the actual draw call — after the
            // camera-switcher's per-frame follow tick has written its
            // own quaternion. Bare rAF-end hooks fire after rendering
            // and get clobbered by the next tick's follow logic.
            await page.evaluate((lookUp) => {
                if (!lookUp) {
                    window.__skyDemoLookUp = false;
                    return;
                }
                window.__skyDemoLookUp = true;
                const ls = window.liveScene3d;
                if (ls?.renderer && !ls.__skyDemoRenderHook) {
                    ls.__skyDemoRenderHook = true;
                    const origRender = ls.renderer.render.bind(ls.renderer);
                    ls.renderer.render = function (scene, cam) {
                        if (window.__skyDemoLookUp && cam && cam.quaternion) {
                            const Euler = cam.rotation.constructor;
                            const Quat = cam.quaternion.constructor;
                            // Pitch up 30°, yaw 7° west of north.
                            const eul = new Euler(
                                Math.PI / 6,
                                -7 * Math.PI / 180,
                                0,
                                "YXZ"
                            );
                            const q = new Quat().setFromEuler(eul);
                            cam.quaternion.copy(q);
                            cam.updateMatrixWorld(true);
                        }
                        return origRender(scene, cam);
                    };
                }
            }, !!shot.lookUp);

            await page.waitForTimeout(OVERRIDE_SETTLE_MS);

            // Read current sky state for the manifest. Sky-I-C: wasm-bindgen
            // exports use camelCase (timeOfDayNormalized, dirColorArgb,
            // etc.), not snake_case. Prior captures wrote `state: null`
            // because the snake_case access returned `undefined`.
            const state = await page.evaluate(() => {
                const h = window.__sessionHandle;
                try {
                    const s = h?.getSkyState?.();
                    return s
                        ? {
                              t: s.timeOfDayNormalized,
                              dg: s.dayGroupIndex,
                              dir: "0x" + (s.dirColorArgb >>> 0).toString(16).padStart(8, "0"),
                              amb: "0x" + (s.ambColorArgb >>> 0).toString(16).padStart(8, "0"),
                              fog: "0x" + (s.fogColorArgb >>> 0).toString(16).padStart(8, "0"),
                              dirHeading: s.dirHeading,
                              dirPitch: s.dirPitch,
                          }
                        : null;
                } catch (_) {
                    return null;
                }
            });

            // Canvas-only screenshot (not full page — the HTML login
            // form sits above the canvas).
            const canvas = page.locator("canvas").first();
            const ssPath = path.join(OUT_DIR, `${shot.name}.png`);
            await canvas.screenshot({ path: ssPath });

            console.log(
                `  ${shot.name}: t=${shot.t} dg=${state?.dg ?? "?"} ` +
                `dir=${state?.dir ?? "?"} fog=${state?.fog ?? "?"}`
            );
            manifest.push({ ...shot, state, file: `${shot.name}.png` });
        }

        // Clear overrides at end (good citizenship).
        await page.evaluate(() => {
            const h = window.__sessionHandle;
            try { h?.setSkyTimeOverride?.(Number.NaN); } catch (_) {}
            try { h?.setGameDayOverride?.(0xFFFFFFFF, 0xFFFFFFFF); } catch (_) {}
        });

        // Write a manifest so the gallery is self-describing.
        fs.writeFileSync(
            path.join(OUT_DIR, "manifest.json"),
            JSON.stringify({ run_tag: RUN_TAG, account: ACCOUNT, char: CHAR_NAME, shots: manifest }, null, 2)
        );
        console.log(`\nDONE. ${SHOTS.length} shots in ${OUT_DIR}`);
        console.log(`manifest: ${path.join(OUT_DIR, "manifest.json")}`);
    } catch (e) {
        console.error(`FAIL during demo capture: ${e.message}`);
        try {
            await page.screenshot({ path: path.join(OUT_DIR, "FAILURE.png"), fullPage: true });
        } catch (_) { /* swallow */ }
        process.exitCode = 1;
    } finally {
        await browser.close();
    }
})();
