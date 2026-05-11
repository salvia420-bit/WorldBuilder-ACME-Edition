// Workstream Sky-F — end-to-end Playwright capture for the skybox push.
//
// Drives a *real* live ACE session through the ?renderer=3d code path,
// fires `setSkyTimeOverride` directly against the wasm session handle
// to step through midnight/dawn/noon/dusk, samples `getSkyState` +
// `getSkyObjectStates`, and asserts the Sky-B contract today plus
// Sky-C/Sky-D contracts that auto-engage as those workstreams land.
//
// Sky-B (LANDED, ef6f15d):
//   - `populateSkyDescFromRegion(0x13000000)` fires on kind=7 EnteredWorld
//   - `hasSkyDesc()` / `getSkyState()` / `getSkyObjectStates()` synchronous
//   - `setSkyTimeOverride(t)` drives a `[0.0, 1.0)` override; NaN clears
//
// Sky-C (pending) will drive THREE.DirectionalLight / AmbientLight / Fog
// from `getSkyState()` per rAF tick.
//
// Sky-D (pending) will mount a sky-dome group + per-SkyObject sprites/
// SetupModel children driven by `getSkyObjectStates()`.
//
// Sky-E (LANDED, b4893e6) provides the resolver Sky-D will consume —
// `scene3d/sky_assets.js` — but the renderer mounting is Sky-D's job.
//
// Per-bullet pass/fail with named workstream dependencies, same pattern
// as capture_3d_movement_e2e.cjs. Bullets 7-9 depend on Sky-C/Sky-D and
// auto-flip when those workstreams ship; default skip via
// `SKIP_BULLET_<N>=1` is OFF (the bullets run and FAIL today, which is
// the punch-list signal Sky-C/Sky-D's work needs).
//
// Bullet 12 (pixel-hue histogram) is reserved but skipped by default —
// Sky-D will flip the SKIP off once the dome renders.
//
// The 12 bullets (per the Sky-F prompt):
//   1. Boot Chromium with ?renderer=3d.
//   2. Login via input[name="server_host"]; fresh per-run account.
//   3. Spawn + /god post-spawn.
//   4. populateSkyDescFromRegion succeeded (hasSkyDesc() === true).
//   5. getSkyState() returns non-null.
//   6. day_group_index < 20 (Dereth has 20 DayGroups).
//   7. Four reference times (t = 0, 0.25, 0.5, 0.75) produce >=2
//      distinct fog_color_argb values (proves interpolation engages).
//   8. getSkyObjectStates().length === 7 (Dereth Sunny day group).
//   9. At least one SkyObject is 0x02xxxxxx prefix (proves
//      SetupModel-prefix dispatch). Expected 0x02000714.
//  10. [Sky-C] scene.fog.color.getHex() changes across reference times.
//  11. [Sky-D] scene.children has a "sky_dome" group.
//  12. [Sky-D] >0 children with userData.sky_object_id at t=0.05.
//  13. Screenshot per reference time to /mnt/wbterminal1/holtburger-
//      captures/skybox-{t}.png.
//  14. No `null pointer passed to rust` errors.
//  15. (RESERVED, SKIP today) Pixel-hue histogram per reference time.
//
// Pre-reqs:
// - Live ACE on Tailscale 100.116.47.66 UDP 9000.
// - holtburger-wsbridge on ws://127.0.0.1:8080/.
// - Web proxy on 127.0.0.1:7080 OR python3 -m http.server 8765.
// - Manifest+shards baked under dist/.
//
// Run: `node capture_skybox_e2e.cjs` from `apps/holtburger-web/`.
// Or:  NODE_PATH=/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules \
//      node capture_skybox_e2e.cjs

const path = require("node:path");
const fs = require("node:fs");

// Playwright resolution — same fallback as capture_3d_movement_e2e.cjs.
const PLAYWRIGHT_CACHE =
    process.env.PLAYWRIGHT_CACHE ||
    "/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules";
let chromium;
try {
    // eslint-disable-next-line global-require
    ({ chromium } = require("playwright"));
} catch (_) {
    try {
        // eslint-disable-next-line global-require
        ({ chromium } = require(path.join(PLAYWRIGHT_CACHE, "playwright")));
    } catch (e) {
        console.error(
            "FAIL: playwright not found in NODE_PATH or " +
                PLAYWRIGHT_CACHE +
                "\nSet NODE_PATH or PLAYWRIGHT_CACHE to a valid playwright install."
        );
        process.exit(2);
    }
}

// === Helpers ===============================================================
function skip(n) {
    return process.env[`SKIP_BULLET_${n}`] === "1";
}

function mkBullet(n, label, dependsOn) {
    return {
        n,
        label,
        dependsOn, // e.g. "Sky-B (landed)", "Sky-C (pending)", or null
        skipped: skip(n),
        passed: null,
        detail: "",
        error: null,
    };
}

function bulletStatus(b) {
    if (b.skipped) return "SKIP";
    if (b.passed === true) return "PASS";
    if (b.passed === false) return "FAIL";
    return "UNRUN";
}

function reportBullet(b) {
    const status = bulletStatus(b);
    const dep = b.dependsOn ? `  [depends on Workstream ${b.dependsOn}]` : "";
    const detail = b.detail ? ` — ${b.detail}` : "";
    console.log(`  [${status}] Bullet ${b.n}: ${b.label}${dep}${detail}`);
    if (b.error) {
        console.log(`         error: ${b.error}`);
    }
}

// Reference times — midnight, dawn, noon, dusk (per the Sky-B comment
// on `time_of_day_normalized`).
const REFERENCE_TIMES = [
    { t: 0.0,  label: "midnight" },
    { t: 0.25, label: "dawn" },
    { t: 0.5,  label: "noon" },
    { t: 0.75, label: "dusk" },
];

// Dawn-window time for bullet 12 (when the sun should be just above
// the horizon and visible). 0.05 is well after midnight but well
// before the dawn keyframe (0.25), so any "sun" SkyObject should be
// on the visible side of the dome regardless of the per-DayGroup
// keyframe spacing.
const DAWN_WINDOW_T = 0.05;

(async () => {
    // === Config ============================================================
    const RUN_TAG = process.env.SKYF_RUN_TAG || `sky${Date.now().toString(36)}`;
    const ACCOUNT = process.env.PHASE4_TEST_ACCOUNT || RUN_TAG;
    const PASSWORD = process.env.PHASE4_TEST_PASSWORD || RUN_TAG;
    const CHAR_NAME = process.env.SKYF_CHAR_NAME || `Sky${RUN_TAG.slice(-6)}`;
    const BRIDGE_URL = process.env.PHASE4_BRIDGE_URL || "ws://127.0.0.1:8080/";
    const SERVER_IP = process.env.PHASE4_SERVER_IP || "100.116.47.66";
    const SERVER_PORT = process.env.PHASE4_SERVER_PORT || "9000";
    // Default to the local proxy on 7080. ?renderer=3d is required —
    // the skybox lives in the 3D code path only.
    const PAGE_URL = process.env.SKYF_PAGE_URL
        || "http://127.0.0.1:7080/apps/holtburger-web/index.html?renderer=3d";
    const SPAWN_TIMEOUT_MS = Number(process.env.SKYF_SPAWN_TIMEOUT_MS || 60_000);
    const CREATE_TIMEOUT_MS = Number(process.env.SKYF_CREATE_TIMEOUT_MS || 30_000);
    const POST_SPAWN_DRAIN_MS = Number(process.env.SKYF_POST_SPAWN_DRAIN_MS || 3000);
    // Per-override settle: Sky-C's lighting tick reads `getSkyState`
    // once per rAF (~16ms). 300ms gives ~18 rAF ticks, generous even
    // under headless throttling (per `project_emit_dynamic_site`
    // memory — Playwright headless can throttle rAF to ~2.5 Hz, which
    // is still 0.75 ticks in 300ms).
    const OVERRIDE_SETTLE_MS = Number(process.env.SKYF_OVERRIDE_SETTLE_MS || 300);
    const SKY_DESC_WAIT_MS = Number(process.env.SKYF_SKY_DESC_WAIT_MS || 5000);
    // Screenshot output dir per memory `project_holtburger_bake_disk_trap`.
    // Workstream Sky-D writes into a `skybox-d/` subdir; env-overridable
    // for any future workstream that wants its own bucket.
    const PREFERRED_OUT_DIR =
        process.env.SKYF_OUT_DIR || "/mnt/wbterminal1/holtburger-captures";
    const FALLBACK_OUT_DIR = path.resolve(__dirname, "../../../../docs/images");
    let outDir = PREFERRED_OUT_DIR;
    try {
        if (!fs.existsSync(PREFERRED_OUT_DIR)) {
            fs.mkdirSync(PREFERRED_OUT_DIR, { recursive: true });
        }
    } catch (_) {
        outDir = FALLBACK_OUT_DIR;
    }
    if (!fs.existsSync(outDir)) {
        try { fs.mkdirSync(outDir, { recursive: true }); } catch (_) { /* swallow */ }
    }

    // === Bullet definitions ===============================================
    // dependsOn:
    //   - null            — unconditional
    //   - "Sky-B (landed)" — Sky-B sub-bullets; should pass today
    //   - "Sky-C (pending)" / "Sky-D (pending)" — auto-engage on land
    const bullets = {
        1:  mkBullet(1,  "Boot Chromium with ?renderer=3d",                   null),
        2:  mkBullet(2,  "Login + fresh per-run account; CharacterCreate",    null),
        3:  mkBullet(3,  "Spawn + /god post-spawn",                           null),
        4:  mkBullet(4,  "populateSkyDescFromRegion landed (hasSkyDesc true)", "Sky-B (landed)"),
        5:  mkBullet(5,  "getSkyState() returns non-null",                    "Sky-B (landed)"),
        6:  mkBullet(6,  "day_group_index < 20 (Dereth has 20 DayGroups)",    "Sky-B (landed)"),
        7:  mkBullet(7,  "Fog color varies across 4 reference times",         "Sky-B (landed)"),
        8:  mkBullet(8,  "getSkyObjectStates().length === 7 (Dereth Sunny)",  "Sky-B (landed)"),
        9:  mkBullet(9,  "At least one 0x02xxxxxx SkyObject (SetupModel)",    "Sky-B (landed)"),
        10: mkBullet(10, "scene.fog.color.getHex() changes across times",     "Sky-C (pending)"),
        11: mkBullet(11, "scene.children has a sky_dome group",               "Sky-D (pending)"),
        12: mkBullet(12, "scene.children with userData.sky_object_id > 0 at dawn", "Sky-D (pending)"),
        13: mkBullet(13, "Screenshot per reference time",                     null),
        14: mkBullet(14, "No `null pointer passed to rust` errors",           null),
        15: mkBullet(15, "Pixel-hue histogram per reference time (Sky-D wins)", "Sky-D (pending)"),
    };

    // Bullet 15 is reserved / skip-by-default — Sky-D-time work. The
    // pixel-extraction + histogram code IS implemented below; the
    // assertion just doesn't run until SKIP_BULLET_15=0.
    if (process.env.SKIP_BULLET_15 === undefined) {
        bullets[15].skipped = true;
    }

    console.log(`launching chromium → ${PAGE_URL}`);
    console.log(`target ACE: ${SERVER_IP}:${SERVER_PORT} via ${BRIDGE_URL}`);
    console.log(`account: ${ACCOUNT}, character: ${CHAR_NAME}`);
    console.log(`screenshots dir: ${outDir}`);
    console.log(`bullets to skip via env: ${Object.keys(bullets).filter((k) => bullets[k].skipped).join(",") || "(none)"}`);

    let browser;
    let consoleLines = [];
    let nullPointerErrors = [];
    let pageErrors = [];
    // Per-reference-time samples — populated during bullet 7 + reused
    // for bullets 8/9/10/11/12.
    /** @type {Array<{ t: number, label: string, skyState: any | null, objects: any[], threeFogHex: number | null, sceneSummary: any, screenshotPath: string | null }>} */
    let refSamples = [];

    try {
        // Same throttling-disable flags as capture_3d_movement_e2e.cjs.
        // They DON'T fully override Playwright's headless renderer-
        // process throttling, but they reduce it materially. Bullet 7
        // doesn't need rAF cadence — it drives the override
        // synchronously and reads the resulting state in the same
        // page.evaluate call.
        browser = await chromium.launch({
            args: [
                "--use-gl=swiftshader",
                "--disable-background-timer-throttling",
                "--disable-renderer-backgrounding",
                "--disable-backgrounding-occluded-windows",
                "--disable-features=CalculateNativeWinOcclusion",
            ],
        });
        const context = await browser.newContext({ viewport: { width: 1280, height: 1024 } });
        const page = await context.newPage();

        const t0 = Date.now();
        page.on("console", (msg) => {
            const text = msg.text();
            const entry = { t: Date.now() - t0, type: msg.type(), text };
            consoleLines.push(entry);
            if (/null pointer passed to rust/i.test(text)) {
                nullPointerErrors.push(entry);
            }
            if (msg.type() === "error" || msg.type() === "warning"
                || /Sky-[A-F]|populateSkyDescFromRegion|getSkyState|null pointer|spawn|EnteredWorld/i.test(text)) {
                console.log(`[browser ${msg.type()} +${entry.t}ms] ${text}`);
            }
        });
        page.on("pageerror", (err) => {
            const entry = { t: Date.now() - t0, message: err.message, stack: err.stack };
            pageErrors.push(entry);
            console.error(`[pageerror +${entry.t}ms]`, err.message);
            if (/null pointer passed to rust/i.test(err.message)) {
                nullPointerErrors.push({ t: entry.t, type: "pageerror", text: err.message });
            }
        });

        // --- Bullet 1: navigate with ?renderer=3d -------------------------
        if (!bullets[1].skipped) {
            try {
                await page.goto(PAGE_URL, { waitUntil: "domcontentloaded" });
                const rendererFlag = await page.evaluate(() => {
                    return new URL(window.location.href).searchParams.get("renderer");
                });
                bullets[1].passed = rendererFlag === "3d";
                bullets[1].detail = `renderer query param=${rendererFlag}`;
                if (!bullets[1].passed) {
                    bullets[1].error = `expected renderer=3d, got ${rendererFlag}`;
                }
            } catch (e) {
                bullets[1].passed = false;
                bullets[1].error = e.message;
            }
        }

        // Wait for in-page smoke PASS before continuing.
        try {
            await page.waitForFunction(() => {
                const r = document.getElementById("results");
                return r && /PASS/.test(r.innerHTML);
            }, { timeout: 60_000 });
            console.log("in-page smoke checks PASS");
        } catch (e) {
            const html = await page.locator("#results").innerHTML().catch(() => "(unavailable)");
            console.error("smoke panel never reached PASS — bailing.");
            console.error("results HTML:", html.slice(0, 500));
            for (const k of Object.keys(bullets)) {
                if (!bullets[k].skipped && bullets[k].passed === null) {
                    bullets[k].passed = false;
                    bullets[k].error = "in-page smoke never passed (pre-flight bailout)";
                }
            }
            throw new Error("smoke panel did not pass");
        }

        // --- Bullet 2: login + per-run account ----------------------------
        if (!bullets[2].skipped) {
            try {
                const hasServerHost = await page.locator('input[name="server_host"]').count() > 0;
                const hasStaleServerIp = await page.locator('input[name="server_ip"]').count() > 0;
                if (!hasServerHost) {
                    bullets[2].passed = false;
                    bullets[2].error = `input[name="server_host"] not found (hasStaleServerIp=${hasStaleServerIp})`;
                } else {
                    await page.fill('input[name="account"]', ACCOUNT);
                    await page.fill('input[name="password"]', PASSWORD);
                    await page.fill('input[name="bridge_url"]', BRIDGE_URL);
                    await page.fill('input[name="server_host"]', SERVER_IP);
                    await page.fill('input[name="server_port"]', SERVER_PORT);
                    await page.click('#login-form button[type=submit]');
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
                        }, { timeout: CREATE_TIMEOUT_MS });
                        await page.waitForFunction(() => {
                            return document.querySelectorAll('#character-ul button[data-id]').length > 0;
                        }, { timeout: 10_000 });
                    }
                    bullets[2].passed = true;
                    bullets[2].detail = `logged in as ${ACCOUNT}; character ${CHAR_NAME} present`;
                }
            } catch (e) {
                bullets[2].passed = false;
                bullets[2].error = e.message;
            }
        }

        if (bullets[2].passed === false) {
            for (const k of [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]) {
                if (!bullets[k].skipped && bullets[k].passed === null) {
                    bullets[k].passed = false;
                    bullets[k].error = "Bullet 2 failed; downstream cannot run";
                }
            }
        }

        // --- Bullet 3: spawn + /god post-spawn ----------------------------
        if (!bullets[3].skipped && bullets[2].passed) {
            try {
                const spawnButtons = page.locator('#character-ul button[data-id]');
                if ((await spawnButtons.count()) === 0) {
                    throw new Error("No spawnable characters");
                }
                await spawnButtons.first().click();
                await page.waitForFunction(() => {
                    const s = document.getElementById("login-status");
                    return s && /InWorld|Spawned/.test(s.innerText);
                }, { timeout: SPAWN_TIMEOUT_MS });
                await page.waitForTimeout(POST_SPAWN_DRAIN_MS);

                // Teleport to Holtburg so we're outdoor (the sky is
                // pointless inside the Academy). Same flow as the 3D
                // movement capture.
                try {
                    await page.click('#teleport-button', { timeout: 5_000 });
                    console.log("clicked Teleport to Holtburg");
                    await page.waitForTimeout(3_000);
                } catch (e) {
                    console.warn(`teleport-button click failed (continuing): ${e.message}`);
                }

                // Wait for init3D to fully resolve. init3D awaits the
                // Phase 7.3 EnvCell load (Mite Maze + Holtburg Dungeon
                // — ~30 s of wasm round-trips for the dungeon
                // geometry), the Phase 7.6.1 SetupModel-lights walker,
                // and finally publishes `window.liveScene3d`. Before
                // that point Sky-C's controller, Sky-D's dome, and
                // scene.fog don't exist — sampling bullets 10/11/12
                // returns null/false. Without this gate the capture
                // races init3D and fails them even when the code is
                // correct.
                try {
                    await page.waitForFunction(
                        () => !!window.liveScene3d,
                        { timeout: 90_000 }
                    );
                    console.log("init3D resolved; liveScene3d available");
                } catch (e) {
                    console.warn(
                        `init3D did not resolve within 90s; sampling will reflect partial state: ${e.message}`
                    );
                }
                // Then wait for Sky-D's lazy skyAssets resolve to land
                // celestial bodies on scene.children (the setInterval
                // poll fires at ~250 ms but the wasm-side
                // `fetchBuildingPlacement` for 7 SkyObjects + their
                // surfaces is another ~2-3 s on the shard-fetch path).
                try {
                    await page.waitForFunction(
                        () => {
                            const ls = window.liveScene3d;
                            if (!ls?.scene?.children) return false;
                            let n = 0;
                            for (const c of ls.scene.children) {
                                if (c.userData?.sky_object_id !== undefined) n += 1;
                            }
                            return n > 0;
                        },
                        { timeout: 60_000 }
                    );
                    console.log("Sky-D celestial bodies populated");
                } catch (e) {
                    console.warn(
                        `Sky-D celestial bodies never populated (bullet 12 will fail): ${e.message}`
                    );
                }

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

                bullets[3].passed = true;
                bullets[3].detail = `${ACCOUNT} / ${CHAR_NAME} spawned + teleport + /god`;
            } catch (e) {
                bullets[3].passed = false;
                bullets[3].error = e.message;
                for (const k of [4, 5, 6, 7, 8, 9, 10, 11, 12, 13]) {
                    if (!bullets[k].skipped && bullets[k].passed === null) {
                        bullets[k].passed = false;
                        bullets[k].error = "Bullet 3 failed; downstream cannot run";
                    }
                }
            }
        }

        // --- Bullet 4: populateSkyDescFromRegion landed -------------------
        // kind=7 EnteredWorld fires the populator asynchronously. Poll
        // for `hasSkyDesc() === true` for up to SKY_DESC_WAIT_MS.
        if (!bullets[4].skipped && bullets[3].passed) {
            try {
                await page.waitForFunction(() => {
                    const h = window.__sessionHandle;
                    if (!h || typeof h.hasSkyDesc !== "function") return false;
                    try { return !!h.hasSkyDesc(); } catch (_) { return false; }
                }, { timeout: SKY_DESC_WAIT_MS });
                bullets[4].passed = true;
                bullets[4].detail = `hasSkyDesc()===true within ${SKY_DESC_WAIT_MS}ms`;
            } catch (e) {
                bullets[4].passed = false;
                bullets[4].error = `hasSkyDesc() never returned true within ${SKY_DESC_WAIT_MS}ms (Sky-B kind=7 hook may not have fired, OR populator threw — check console for [Sky-B] lines)`;
                for (const k of [5, 6, 7, 8, 9, 10, 11, 12]) {
                    if (!bullets[k].skipped && bullets[k].passed === null) {
                        bullets[k].passed = false;
                        bullets[k].error = "Bullet 4 failed; SkyDesc unavailable";
                    }
                }
            }
        }

        // --- Bullet 5: getSkyState() returns non-null ---------------------
        let initialSkyState = null;
        if (!bullets[5].skipped && bullets[4].passed) {
            try {
                initialSkyState = await page.evaluate(() => {
                    const h = window.__sessionHandle;
                    const s = h.getSkyState();
                    if (!s) return null;
                    // SkyState is wasm-bindgen with getters — explicit
                    // property reads (spread / JSON.stringify won't see
                    // them).
                    return {
                        dirColorArgb: s.dirColorArgb,
                        dirBright: s.dirBright,
                        dirHeading: s.dirHeading,
                        dirPitch: s.dirPitch,
                        ambColorArgb: s.ambColorArgb,
                        ambBright: s.ambBright,
                        fogColorArgb: s.fogColorArgb,
                        fogMin: s.fogMin,
                        fogMax: s.fogMax,
                        worldFog: s.worldFog,
                        timeOfDayNormalized: s.timeOfDayNormalized,
                        dayGroupIndex: s.dayGroupIndex,
                    };
                });
                bullets[5].passed = initialSkyState !== null;
                if (bullets[5].passed) {
                    bullets[5].detail =
                        `tNorm=${initialSkyState.timeOfDayNormalized.toFixed(4)} ` +
                        `dayGroup=${initialSkyState.dayGroupIndex} ` +
                        `fog=0x${initialSkyState.fogColorArgb.toString(16).padStart(8, "0").toUpperCase()} ` +
                        `dir=0x${initialSkyState.dirColorArgb.toString(16).padStart(8, "0").toUpperCase()}`;
                } else {
                    bullets[5].error = "getSkyState() returned null/undefined despite hasSkyDesc()===true";
                }
            } catch (e) {
                bullets[5].passed = false;
                bullets[5].error = e.message;
            }
        }

        // --- Bullet 6: day_group_index < 20 -------------------------------
        if (!bullets[6].skipped && bullets[5].passed && initialSkyState) {
            const idx = initialSkyState.dayGroupIndex >>> 0;
            bullets[6].passed = idx < 20;
            bullets[6].detail = `day_group_index=${idx} (Dereth has 20 DayGroups)`;
            if (!bullets[6].passed) {
                bullets[6].error = `day_group_index=${idx} out of range (expected <20 — Dereth Region 0x13000000 has exactly 20 DayGroups per Sky-B's sky.rs comment)`;
            }
        }

        // --- Sweep through reference times --------------------------------
        // For each (t, label) in REFERENCE_TIMES, drive the override,
        // wait for the override to engage, sample getSkyState() +
        // getSkyObjectStates() + scene state, and take a screenshot.
        // This populates `refSamples` which bullets 7-13 + 15 read.
        if (bullets[4].passed) {
            try {
                for (const ref of REFERENCE_TIMES) {
                    const applied = await page.evaluate((t) => {
                        const h = window.__sessionHandle;
                        try { return !!h.setSkyTimeOverride(t); }
                        catch (e) { return { err: e.message }; }
                    }, ref.t);
                    if (applied !== true) {
                        console.warn(`setSkyTimeOverride(${ref.t}) returned ${JSON.stringify(applied)}`);
                    }
                    // Wait for Sky-C's lighting tick to read the new
                    // state. Under headless throttling rAF can be as
                    // slow as 0.4 Hz; 300ms still catches at least one
                    // tick under nominal throttling. Sky-B itself is
                    // synchronous — getSkyState() reflects the new
                    // override immediately — so the wait is purely for
                    // downstream (Sky-C/Sky-D) consumers.
                    await page.waitForTimeout(OVERRIDE_SETTLE_MS);

                    const sample = await page.evaluate((label) => {
                        const h = window.__sessionHandle;
                        let skyState = null;
                        try {
                            const s = h.getSkyState();
                            if (s) {
                                skyState = {
                                    dirColorArgb: s.dirColorArgb,
                                    dirBright: s.dirBright,
                                    dirHeading: s.dirHeading,
                                    dirPitch: s.dirPitch,
                                    ambColorArgb: s.ambColorArgb,
                                    ambBright: s.ambBright,
                                    fogColorArgb: s.fogColorArgb,
                                    fogMin: s.fogMin,
                                    fogMax: s.fogMax,
                                    worldFog: s.worldFog,
                                    timeOfDayNormalized: s.timeOfDayNormalized,
                                    dayGroupIndex: s.dayGroupIndex,
                                };
                            }
                        } catch (_) { /* swallow */ }

                        let objects = [];
                        try {
                            const arr = h.getSkyObjectStates();
                            for (let i = 0; i < arr.length; i++) {
                                const o = arr[i];
                                objects.push({
                                    gfxObjectId: o.gfxObjectId,
                                    heading: o.heading,
                                    pitch: o.pitch,
                                    texOffsetX: o.texOffsetX,
                                    texOffsetY: o.texOffsetY,
                                    transparent: o.transparent,
                                    luminosity: o.luminosity,
                                    maxBright: o.maxBright,
                                    visible: o.visible,
                                    properties: o.properties,
                                });
                            }
                        } catch (e) {
                            objects = { err: e.message };
                        }

                        // THREE scene state for Sky-C/Sky-D bullets.
                        let threeFogHex = null;
                        let sceneSummary = { hasScene: false, childCount: 0, hasSkyDome: false, skyObjectCount: 0 };
                        try {
                            const ls = window.liveScene3d;
                            if (ls && ls.scene) {
                                sceneSummary.hasScene = true;
                                sceneSummary.childCount = ls.scene.children?.length ?? 0;
                                if (ls.scene.fog && ls.scene.fog.color && typeof ls.scene.fog.color.getHex === "function") {
                                    threeFogHex = ls.scene.fog.color.getHex();
                                }
                                // Sky-D will mount a Group named "sky_dome"
                                // — check by name. (Some Sky-D designs use
                                // userData.sky_dome instead; check both.)
                                const children = ls.scene.children || [];
                                for (const c of children) {
                                    if (c.name === "sky_dome" || c.userData?.sky_dome === true) {
                                        sceneSummary.hasSkyDome = true;
                                    }
                                    if (c.userData?.sky_object_id !== undefined) {
                                        sceneSummary.skyObjectCount++;
                                    }
                                }
                            }
                        } catch (_) { /* swallow */ }

                        return { label, skyState, objects, threeFogHex, sceneSummary };
                    }, ref.label);

                    refSamples.push({
                        t: ref.t,
                        label: ref.label,
                        skyState: sample.skyState,
                        objects: sample.objects,
                        threeFogHex: sample.threeFogHex,
                        sceneSummary: sample.sceneSummary,
                        screenshotPath: null,
                    });

                    console.log(
                        `t=${ref.t.toFixed(2)} (${ref.label}): ` +
                        `fog=${sample.skyState ? "0x" + sample.skyState.fogColorArgb.toString(16).padStart(8, "0").toUpperCase() : "null"} ` +
                        `objects=${Array.isArray(sample.objects) ? sample.objects.length : "err"} ` +
                        `threeFog=${sample.threeFogHex !== null ? "0x" + sample.threeFogHex.toString(16).padStart(6, "0") : "null"} ` +
                        `skyDome=${sample.sceneSummary.hasSkyDome} ` +
                        `skyObjChildren=${sample.sceneSummary.skyObjectCount}`
                    );

                    // --- Bullet 13: screenshot per reference time -------
                    if (!bullets[13].skipped) {
                        const ssPath = path.join(outDir, `skybox-${ref.label}-${RUN_TAG}.png`);
                        try {
                            // Workstream Sky-D — screenshot the canvas
                            // element directly, NOT the viewport. The
                            // page lays out a 2D HTML form above the
                            // 3D canvas, so a viewport screenshot
                            // captures the form (white background)
                            // not the sky. `locator('canvas').screenshot`
                            // crops to the canvas's bounding rect.
                            // Fall back to full-viewport if canvas
                            // isn't present (shouldn't happen post-init3D).
                            const canvasLocator = page.locator("canvas").first();
                            const haveCanvas = await canvasLocator.count() > 0;
                            if (haveCanvas) {
                                await canvasLocator.scrollIntoViewIfNeeded();
                                await canvasLocator.screenshot({ path: ssPath });
                            } else {
                                await page.screenshot({ path: ssPath, fullPage: false });
                            }
                            refSamples[refSamples.length - 1].screenshotPath = ssPath;
                        } catch (e) {
                            console.warn(`screenshot ${ssPath} failed: ${e.message}`);
                        }
                    }
                }

                // Also sample at dawn-window t for bullet 12.
                if (!bullets[12].skipped) {
                    try {
                        await page.evaluate((t) => {
                            const h = window.__sessionHandle;
                            try { h.setSkyTimeOverride(t); } catch (_) { /* swallow */ }
                        }, DAWN_WINDOW_T);
                        await page.waitForTimeout(OVERRIDE_SETTLE_MS);
                        const dawnSample = await page.evaluate(() => {
                            const ls = window.liveScene3d;
                            let count = 0;
                            if (ls && ls.scene && ls.scene.children) {
                                for (const c of ls.scene.children) {
                                    if (c.userData?.sky_object_id !== undefined) count++;
                                }
                            }
                            return { count };
                        });
                        bullets[12].passed = dawnSample.count > 0;
                        bullets[12].detail = `${dawnSample.count} children with userData.sky_object_id at t=${DAWN_WINDOW_T}`;
                        if (!bullets[12].passed) {
                            bullets[12].error = `no sky-object-tagged children at dawn window (Sky-D hasn't mounted celestial bodies yet)`;
                        }
                    } catch (e) {
                        bullets[12].passed = false;
                        bullets[12].error = `dawn-window check threw: ${e.message}`;
                    }
                }

                // Clear the override so subsequent diagnostics see
                // wall-clock UTC again (NaN clears per the wasm
                // contract).
                try {
                    await page.evaluate(() => {
                        const h = window.__sessionHandle;
                        try { h.setSkyTimeOverride(Number.NaN); } catch (_) { /* swallow */ }
                    });
                } catch (_) { /* swallow */ }

                // --- Bullet 7: fog_color varies across times -----------
                if (!bullets[7].skipped) {
                    const fogColors = refSamples
                        .filter((s) => s.skyState)
                        .map((s) => s.skyState.fogColorArgb >>> 0);
                    const distinctFogs = new Set(fogColors);
                    bullets[7].passed = distinctFogs.size >= 2;
                    bullets[7].detail =
                        `${distinctFogs.size} distinct fog_color_argb across ${fogColors.length} sampled times: [` +
                        fogColors.map((c) => "0x" + c.toString(16).padStart(8, "0").toUpperCase()).join(", ") +
                        `]`;
                    if (!bullets[7].passed) {
                        bullets[7].error =
                            distinctFogs.size === 0
                            ? `no fog colors sampled — getSkyState() returned null for all reference times`
                            : `all reference times produced the same fog color — interpolation may be stuck or the override is being ignored`;
                    }
                }

                // --- Bullet 8: 7 SkyObjects --------------------------
                // Use the first sample where `objects` is an Array (the
                // count is invariant across time-of-day — only the
                // per-object state varies — but per-time SkyObjectReplace
                // overrides could in theory differ; we check the count
                // at every reference time and require all 4 to match
                // the expected 7).
                if (!bullets[8].skipped) {
                    const counts = refSamples
                        .filter((s) => Array.isArray(s.objects))
                        .map((s) => s.objects.length);
                    const allSeven = counts.length > 0 && counts.every((c) => c === 7);
                    bullets[8].passed = allSeven;
                    bullets[8].detail = `object-counts across reference times: [${counts.join(", ")}] (expected [7, 7, 7, 7])`;
                    if (!bullets[8].passed) {
                        bullets[8].error =
                            counts.length === 0
                            ? `getSkyObjectStates() threw at every reference time`
                            : `expected 7 SkyObjects per Dereth Sunny day group; got counts=[${counts.join(", ")}]`;
                    }
                }

                // --- Bullet 9: at least one 0x02xxxxxx SetupModel ----
                if (!bullets[9].skipped) {
                    const firstWithObjects = refSamples.find((s) => Array.isArray(s.objects) && s.objects.length > 0);
                    if (!firstWithObjects) {
                        bullets[9].passed = false;
                        bullets[9].error = `no SkyObject samples available; cannot check SetupModel prefix`;
                    } else {
                        const idList = firstWithObjects.objects.map((o) => o.gfxObjectId >>> 0);
                        const hasSetupModel = idList.some((id) => (id >>> 24) === 0x02);
                        bullets[9].passed = hasSetupModel;
                        bullets[9].detail =
                            `7 sky_object IDs: [${idList.map((id) => "0x" + id.toString(16).padStart(8, "0").toUpperCase()).join(", ")}] ` +
                            `(SetupModel-prefix-0x02 present: ${hasSetupModel})`;
                        if (!bullets[9].passed) {
                            bullets[9].error = `no 0x02xxxxxx SetupModel in SkyObject list — Sky-B's gfx_object_id surfacing may be dropping the SetupModel prefix`;
                        }
                    }
                }

                // --- Bullet 10: THREE.Fog.color changes --------------
                if (!bullets[10].skipped) {
                    const fogHexes = refSamples
                        .map((s) => s.threeFogHex)
                        .filter((h) => h !== null);
                    const distinctFogHexes = new Set(fogHexes);
                    bullets[10].passed = fogHexes.length === 4 && distinctFogHexes.size >= 2;
                    bullets[10].detail =
                        fogHexes.length === 0
                        ? `scene.fog never populated across any reference time (Sky-C hasn't installed a Fog yet)`
                        : `${distinctFogHexes.size} distinct hexes / ${fogHexes.length} samples: [${fogHexes.map((h) => "0x" + h.toString(16).padStart(6, "0")).join(", ")}]`;
                    if (!bullets[10].passed) {
                        if (fogHexes.length === 0) {
                            bullets[10].error = `Sky-C pending: scene.fog not installed yet`;
                        } else if (distinctFogHexes.size < 2) {
                            bullets[10].error = `Sky-C may be installed but isn't reading getSkyState() per-time — fog hex constant across all reference times`;
                        } else {
                            bullets[10].error = `only ${fogHexes.length}/4 samples had scene.fog populated — race condition?`;
                        }
                    }
                }

                // --- Bullet 11: sky_dome present ---------------------
                if (!bullets[11].skipped) {
                    const everSawDome = refSamples.some((s) => s.sceneSummary.hasSkyDome);
                    bullets[11].passed = everSawDome;
                    bullets[11].detail = `sky_dome group present at any reference time: ${everSawDome}`;
                    if (!bullets[11].passed) {
                        bullets[11].error = `Sky-D pending: no Group named "sky_dome" in scene.children`;
                    }
                }

                // --- Bullet 13: screenshots ---------------------------
                if (!bullets[13].skipped) {
                    const saved = refSamples.filter((s) => s.screenshotPath && fs.existsSync(s.screenshotPath));
                    bullets[13].passed = saved.length === REFERENCE_TIMES.length;
                    bullets[13].detail = `${saved.length}/${REFERENCE_TIMES.length} screenshots saved to ${outDir}`;
                    if (!bullets[13].passed) {
                        bullets[13].error = `only ${saved.length} screenshots persisted; expected ${REFERENCE_TIMES.length}`;
                    }
                }

                // --- Bullet 15 (RESERVED): pixel-hue histogram --------
                // Implemented but skipped by default. Sky-D will flip
                // SKIP_BULLET_15=0 once the dome renders. The histogram
                // works by:
                //   1. Loading each screenshot via PNG decode.
                //   2. Extracting the upper third (y < height/3).
                //   3. Computing a coarse hue histogram (12 bins,
                //      30° each).
                //   4. Picking the dominant bin.
                //   5. Asserting:
                //      - midnight (t=0.0):  bin ~7-8 (~220°, blue-black)
                //      - dawn    (t=0.25): bin ~0-1 (~0-60°, orange/red)
                //      - noon    (t=0.5):  bin ~6-7 (~180-210°, cyan-blue)
                //      - dusk    (t=0.75): bin ~0-1 (~0-60°, orange/red)
                if (!bullets[15].skipped) {
                    try {
                        // PNG decoding requires a dep; rather than
                        // pulling pngjs in for a single-use case, we
                        // shell out to ImageMagick's `convert` if it's
                        // available (the canonical bake/check tool on
                        // this host) — falling back to a no-op if not.
                        // Sky-D ships with the bin-check ON via
                        // SKIP_BULLET_15=0, at which point we either
                        // (a) standardise on pngjs, or (b) confirm
                        // ImageMagick is part of the base bake env.
                        const { execSync } = require("node:child_process");
                        let imHaveBin = false;
                        try {
                            execSync("which convert", { stdio: "pipe" });
                            imHaveBin = true;
                        } catch (_) { /* swallow */ }
                        if (!imHaveBin) {
                            bullets[15].passed = false;
                            bullets[15].error = `ImageMagick (convert) not on PATH; pixel-hue histogram requires either pngjs or ImageMagick`;
                        } else {
                            // Workstream Sky-D implementation. The host
                            // ships GraphicsMagick (gm-convert), which
                            // doesn't support `%[fx:mean.r]` formatters;
                            // we use `txt:-` output instead — a one-pixel
                            // resize that averages the upper-third sky
                            // region into a single RGB triple, then
                            // compute HSL in JS.
                            //
                            // Per workstream prompt: day-group varies
                            // day-to-day (today's is index 4 or 13); we
                            // don't bind specific hue values — just
                            // confirm the hue DIFFERENCES are real (>5°
                            // spread across the 4 times confirms the
                            // time-driven sky is visually responding).
                            function rgbToHsl(r, g, b) {
                                r /= 255; g /= 255; b /= 255;
                                const max = Math.max(r, g, b);
                                const min = Math.min(r, g, b);
                                const l = (max + min) / 2;
                                let h = 0, s = 0;
                                if (max !== min) {
                                    const d = max - min;
                                    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
                                    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
                                    else if (max === g) h = (b - r) / d + 2;
                                    else h = (r - g) / d + 4;
                                    h *= 60;
                                }
                                return { h, s, l };
                            }
                            const histograms = [];
                            for (const s of refSamples) {
                                if (!s.screenshotPath || !fs.existsSync(s.screenshotPath)) continue;
                                try {
                                    // Crop upper third → resize to 1×1 →
                                    // dump RGB triple as text.
                                    const cmd =
                                        `convert ${JSON.stringify(s.screenshotPath)} ` +
                                        `-crop 100%x33%+0+0 +repage -resize 1x1\\! txt:-`;
                                    const out = execSync(cmd, { encoding: "utf8" });
                                    // Output line shape: `0,0: (R, G, B) #RRGGBB`
                                    const m = out.match(/\((\s*\d+\s*,\s*\d+\s*,\s*\d+)\)/);
                                    if (!m) {
                                        throw new Error("could not parse txt: output: " + out.slice(0, 80));
                                    }
                                    const [r, g, b] = m[1].split(",").map((x) => parseInt(x.trim(), 10));
                                    const hsl = rgbToHsl(r, g, b);
                                    histograms.push({
                                        label: s.label,
                                        t: s.t,
                                        screenshotPath: s.screenshotPath,
                                        r, g, b,
                                        hueDeg: hsl.h,
                                        saturation: hsl.s,
                                        lightness: hsl.l,
                                    });
                                } catch (e) {
                                    histograms.push({
                                        label: s.label,
                                        t: s.t,
                                        screenshotPath: s.screenshotPath,
                                        hueDeg: NaN,
                                        error: e.message,
                                    });
                                }
                            }
                            // PASS criteria: 4 valid samples + the sky
                            // *visually changed*. We use lightness spread
                            // (max-min) as the primary signal because hue
                            // alone wraps at 360° and a near-grayscale dawn
                            // sky has unstable hue. Lightness spread >0.03
                            // (~3% on the 0..1 scale) indicates the dome
                            // is responding to time-of-day.
                            const validSamples = histograms.filter(
                                (h) => Number.isFinite(h.hueDeg)
                            );
                            const lightnessVals = validSamples.map((h) => h.lightness);
                            const hueVals = validSamples.map((h) => h.hueDeg);
                            const minL = lightnessVals.length > 0 ? Math.min(...lightnessVals) : NaN;
                            const maxL = lightnessVals.length > 0 ? Math.max(...lightnessVals) : NaN;
                            const minH = hueVals.length > 0 ? Math.min(...hueVals) : NaN;
                            const maxH = hueVals.length > 0 ? Math.max(...hueVals) : NaN;
                            const lSpread = Number.isFinite(maxL) && Number.isFinite(minL) ? maxL - minL : 0;
                            const hSpread = Number.isFinite(maxH) && Number.isFinite(minH) ? maxH - minH : 0;
                            const lThreshold = 0.03;
                            const hThreshold = 5.0;
                            const fourValid = validSamples.length === 4;
                            // PASS when EITHER the lightness varies (sky
                            // brightens at noon) OR the hue varies (sky
                            // shifts orange ↔ blue). Either alone is
                            // sufficient evidence the dome is responding.
                            bullets[15].passed =
                                fourValid && (lSpread >= lThreshold || hSpread >= hThreshold);
                            bullets[15].detail =
                                `histograms: ` +
                                histograms.map((h) =>
                                    `${h.label}=` +
                                    (Number.isFinite(h.hueDeg)
                                        ? `(${h.r},${h.g},${h.b}) h=${h.hueDeg.toFixed(1)}° l=${h.lightness.toFixed(3)}`
                                        : "NaN")
                                ).join("; ") +
                                ` | lSpread=${lSpread.toFixed(3)} hSpread=${hSpread.toFixed(1)}°`;
                            if (!bullets[15].passed) {
                                if (!fourValid) {
                                    bullets[15].error = `only ${validSamples.length}/4 valid hue samples; GraphicsMagick output may be unparseable`;
                                } else {
                                    bullets[15].error =
                                        `lightness spread ${lSpread.toFixed(3)} < ${lThreshold} ` +
                                        `AND hue spread ${hSpread.toFixed(1)}° < ${hThreshold}° — ` +
                                        `the dome may not be responding to time-of-day`;
                                }
                            }
                        }
                    } catch (e) {
                        bullets[15].passed = false;
                        bullets[15].error = `pixel-hue histogram threw: ${e.message}`;
                    }
                }
            } catch (e) {
                console.error(`reference-time sweep error: ${e.message}`);
                for (const k of [7, 8, 9, 10, 11, 12, 13, 15]) {
                    if (!bullets[k].skipped && bullets[k].passed === null) {
                        bullets[k].passed = false;
                        bullets[k].error = `reference-time sweep threw: ${e.message}`;
                    }
                }
            }
        }

        // --- Bullet 14: no `null pointer passed to rust` ------------------
        if (!bullets[14].skipped) {
            bullets[14].passed = nullPointerErrors.length === 0;
            bullets[14].detail = `${nullPointerErrors.length} null-pointer error(s) seen`;
            if (!bullets[14].passed) {
                bullets[14].error =
                    `null-pointer errors detected: ` +
                    nullPointerErrors.slice(0, 3).map((n) => `+${n.t}ms ${n.text.slice(0, 100)}`).join(" | ");
            }
        }
    } catch (topErr) {
        console.error(`capture top-level error: ${topErr.message}`);
        for (const k of Object.keys(bullets)) {
            if (!bullets[k].skipped && bullets[k].passed === null) {
                bullets[k].passed = false;
                bullets[k].error = `top-level threw before this bullet: ${topErr.message}`;
            }
        }
    } finally {
        if (browser) {
            try { await browser.close(); } catch (_) { /* swallow */ }
        }
    }

    // === Diagnostic summary ===============================================
    console.log("");
    console.log("======== WORKSTREAM SKY-F E2E SKYBOX CAPTURE ========");
    console.log(`run tag: ${RUN_TAG}`);
    console.log(`account: ${ACCOUNT}, character: ${CHAR_NAME}`);
    console.log(`page-errors: ${pageErrors.length}, null-pointer errors: ${nullPointerErrors.length}`);
    console.log("");
    if (refSamples.length > 0) {
        console.log("Reference-time samples:");
        for (const s of refSamples) {
            const sky = s.skyState;
            console.log(`  t=${s.t.toFixed(2).padEnd(4)} ${s.label.padEnd(9)} ` +
                `dayGroup=${sky ? sky.dayGroupIndex : "?"} ` +
                `fog=${sky ? "0x" + sky.fogColorArgb.toString(16).padStart(8, "0").toUpperCase() : "?"} ` +
                `dir=${sky ? "0x" + sky.dirColorArgb.toString(16).padStart(8, "0").toUpperCase() : "?"} ` +
                `dirBright=${sky ? sky.dirBright.toFixed(3) : "?"} ` +
                `objects=${Array.isArray(s.objects) ? s.objects.length : "err"} ` +
                `threeFog=${s.threeFogHex !== null ? "0x" + s.threeFogHex.toString(16).padStart(6, "0") : "null"}`);
        }
        const firstWithObjects = refSamples.find((s) => Array.isArray(s.objects) && s.objects.length > 0);
        if (firstWithObjects) {
            console.log("");
            console.log(`SkyObject IDs (from t=${firstWithObjects.t.toFixed(2)} ${firstWithObjects.label}):`);
            for (let i = 0; i < firstWithObjects.objects.length; i++) {
                const o = firstWithObjects.objects[i];
                const id = o.gfxObjectId >>> 0;
                const prefix = (id >>> 24) & 0xff;
                const kind = prefix === 0x01 ? "GfxObj    " : prefix === 0x02 ? "SetupModel" : "??        ";
                console.log(`  [${i}] 0x${id.toString(16).padStart(8, "0").toUpperCase()} ${kind} visible=${o.visible} props=0x${(o.properties >>> 0).toString(16).padStart(4, "0")}`);
            }
        }
        if (refSamples.some((s) => s.screenshotPath)) {
            console.log("");
            console.log("Screenshots:");
            for (const s of refSamples) {
                if (s.screenshotPath) {
                    console.log(`  t=${s.t.toFixed(2)} ${s.label}: ${s.screenshotPath}`);
                }
            }
        }
    }
    console.log("");
    console.log("Bullets:");
    let passed = 0;
    let failed = 0;
    let skipped = 0;
    for (const k of Object.keys(bullets)) {
        const b = bullets[k];
        reportBullet(b);
        if (b.skipped) skipped += 1;
        else if (b.passed) passed += 1;
        else failed += 1;
    }
    console.log("");
    const totalBullets = Object.keys(bullets).length;
    console.log(`SCORE: ${passed} pass / ${failed} fail / ${skipped} skip (of ${totalBullets})`);

    // === Exit code ========================================================
    // The capture passes only when every non-skipped bullet passed.
    // Skipped bullets are neutral (SKIP_BULLET_N=1 lets a downstream
    // workstream gate on a partial result).
    if (failed > 0) {
        console.log(`OVERALL: FAIL (${failed} non-skipped bullet${failed === 1 ? "" : "s"} failed)`);
        console.log("");
        console.log("Expected partial-green state per workstream:");
        console.log("  - Bullets 1-9, 13, 14 should be green today (Sky-B + Sky-E landed).");
        console.log("  - Bullet 10 unblocks when Sky-C drives THREE.Fog from getSkyState().");
        console.log("  - Bullets 11 + 12 unblock when Sky-D mounts a sky_dome group + ");
        console.log("    celestial-body children driven by getSkyObjectStates().");
        console.log("  - Bullet 15 is skipped today; Sky-D will flip SKIP_BULLET_15=0");
        console.log("    once the dome renders the expected hue per time-of-day.");
        console.log("======================================================");
        process.exit(1);
    } else {
        console.log("OVERALL: PASS");
        console.log("======================================================");
        process.exit(0);
    }
})().catch((err) => {
    console.error("capture failed:", err);
    process.exit(1);
});
