// capture_skybox_probe_sky_i_a.cjs — 2026-05-11
//
// Workstream Sky-I-A: live-browser per-frame state probe. Captures
// each visible SkyObject's native AABB, world matrix, world-space
// center, distance from camera, plus the camera + fog far-plane
// bounds — at four time-of-day overrides (t=0.05/0.5/0.75/0.0).
//
// One Chromium spawn (mirrors capture_skybox_demo.cjs). The ?skydebug=1
// URL flag activates SkyDome._buildSkyDebugDump per-tick; the script
// reads window.__skyDebugLastDump after a 2s settle at each override
// and writes JSON to /mnt/wbterminal1/holtburger-captures/sky-i-a-probe/.
//
// Pre-reqs:
// - Live ACE on Tailscale 100.116.47.66 UDP 9000.
// - holtburger-wsbridge on ws://127.0.0.1:8080/.
// - Web proxy on 127.0.0.1:7080.
//
// Run: NODE_PATH=/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules \
//      node capture_skybox_probe_sky_i_a.cjs

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

// One probe per time-of-day. The four cover:
//   - 0.05 = foredawn — sun (begin=0.04) + moon (begin=0) both up
//   - 0.50 = noon — sun mid-arc, no moon
//   - 0.75 = afternoon transitioning to dusk
//   - 0.00 = midnight — stars + base-shell only, no sun
const PROBES = [
    { name: "t0.05-foredawn", t: 0.05 },
    { name: "t0.50-noon",     t: 0.50 },
    { name: "t0.75-afternoon", t: 0.75 },
    { name: "t0.00-midnight", t: 0.00 },
];

(async () => {
    const RUN_TAG = process.env.PROBE_RUN_TAG || `probe${Date.now().toString(36)}`;
    const ACCOUNT = process.env.PHASE4_TEST_ACCOUNT || RUN_TAG;
    const PASSWORD = process.env.PHASE4_TEST_PASSWORD || RUN_TAG;
    const CHAR_NAME = process.env.PROBE_CHAR_NAME || `Probe${RUN_TAG.slice(-6)}`;
    const BRIDGE_URL = process.env.PHASE4_BRIDGE_URL || "ws://127.0.0.1:8080/";
    const SERVER_IP = process.env.PHASE4_SERVER_IP || "100.116.47.66";
    const SERVER_PORT = process.env.PHASE4_SERVER_PORT || "9000";
    const PAGE_URL = process.env.PROBE_PAGE_URL
        || "http://127.0.0.1:7080/apps/holtburger-web/index.html?renderer=3d&skydebug=1";
    const SETTLE_MS = Number(process.env.PROBE_SETTLE_MS || 2000);

    const OUT_DIR = "/mnt/wbterminal1/holtburger-captures/sky-i-a-probe";
    fs.mkdirSync(OUT_DIR, { recursive: true });

    console.log("=== Sky-I-A live probe ===");
    console.log(`account=${ACCOUNT}, character=${CHAR_NAME}, out=${OUT_DIR}`);

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
        if (/sky-i-a|sky-d|sky-c|error|fail|panic|exception/i.test(txt)) {
            console.log(`  page: ${msg.type()} ${txt.slice(0, 240)}`);
        }
    });

    try {
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

        console.log("[2/5] waiting for character selection / create");
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
        await page.waitForTimeout(3_000);

        try {
            await page.click('#teleport-button', { timeout: 5_000 });
            console.log("clicked Teleport to Holtburg");
            await page.waitForTimeout(3_000);
        } catch (e) {
            console.warn(`teleport-button click failed (continuing): ${e.message}`);
        }

        console.log("[4/5] waiting for init3D + Sky-D celestials");
        await page.waitForFunction(() => !!window.liveScene3d, { timeout: 90_000 });
        await page.waitForFunction(
            () => {
                const ls = window.liveScene3d;
                if (!ls) return false;
                // Sky-I-B: celestial bodies live in liveScene3d.skyDome.skyScene.
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

        try {
            await page.evaluate(() => {
                const h = window.__sessionHandle;
                if (h && typeof h.sendChat === "function") {
                    try { h.sendChat("/god"); } catch (_) { /* swallow */ }
                }
            });
            await page.waitForTimeout(500);
        } catch (_) { /* swallow */ }

        // ---- Probe each time-of-day ---------------------------------------
        console.log(`[5/5] probing ${PROBES.length} time-of-day points`);
        const allDumps = [];
        for (const probe of PROBES) {
            // Apply time override.
            await page.evaluate((t) => {
                const h = window.__sessionHandle;
                if (typeof h?.setSkyTimeOverride === "function") {
                    try { h.setSkyTimeOverride(t); } catch (_) {}
                }
            }, probe.t);
            await page.waitForTimeout(SETTLE_MS);

            // Read the freshest dump.
            const dump = await page.evaluate(() => {
                const d = window.__skyDebugLastDump;
                if (!d) return null;
                // Pull a few static scene-introspection bits too.
                const ls = window.liveScene3d;
                d._sceneObjectsTopLevel = ls?.scene?.children?.length ?? null;
                d._activeCameraName = ls?.cameraSwitcher?.activeCamera?.name || "perspective";
                d._sessionInWorld = !!ls?.sessionHandle;
                // Sky-C published sink — for cross-reference.
                try {
                    const ss = window.__sessionHandle?.getSkyState?.();
                    d._skyState = ss ? {
                        time_of_day_normalized: ss.time_of_day_normalized,
                        day_group_index: ss.day_group_index,
                        dir_heading: ss.dir_heading,
                        dir_pitch: ss.dir_pitch,
                        fog_min: ss.fog_min,
                        fog_max: ss.fog_max,
                        fog_color_argb: "0x" + (ss.fog_color_argb >>> 0).toString(16).padStart(8, "0"),
                    } : null;
                } catch (_) { d._skyState = null; }
                return d;
            });

            if (!dump) {
                console.warn(`  ${probe.name}: NO DUMP (window.__skyDebugLastDump is null)`);
                allDumps.push({ probe, dump: null });
                continue;
            }

            const out = path.join(OUT_DIR, `dump-${probe.name}.json`);
            fs.writeFileSync(out, JSON.stringify({ probe, dump }, null, 2));

            // Print a one-line summary for grep-ability.
            const visObjs = dump.objects.filter(o => o.mesh.visible);
            console.log(
                `  ${probe.name}: t=${probe.t} objects=${dump.objectCount} visible=${visObjs.length} ` +
                `indoor=${dump.isIndoor} camFar=${dump.camera.far} fogFar=${dump.fog?.far ?? "null"}`
            );
            for (const o of visObjs) {
                const wc = o.mesh.worldCenter;
                const d = o.mesh.distanceFromCamera;
                console.log(
                    `      ${o.id} visible worldCenter=(${wc.x.toFixed(1)},${wc.y.toFixed(1)},${wc.z.toFixed(1)}) ` +
                    `dist=${d.toFixed(1)} heading=${o.state?.headingDeg?.toFixed(1)}° pitch=${o.state?.pitchDeg?.toFixed(1)}°`
                );
            }
            allDumps.push({ probe, dump });
        }

        // Also save a single combined manifest for easy cross-reference.
        fs.writeFileSync(
            path.join(OUT_DIR, "all_probes.json"),
            JSON.stringify({ run_tag: RUN_TAG, dumps: allDumps }, null, 2)
        );

        await page.evaluate(() => {
            const h = window.__sessionHandle;
            try { h?.setSkyTimeOverride?.(Number.NaN); } catch (_) {}
        });

        console.log(`\nDONE. dumps in ${OUT_DIR}`);
    } catch (e) {
        console.error(`FAIL during probe: ${e.message}`);
        try {
            await page.screenshot({ path: path.join(OUT_DIR, "FAILURE.png"), fullPage: true });
        } catch (_) {}
        process.exitCode = 1;
    } finally {
        await browser.close();
    }
})();
