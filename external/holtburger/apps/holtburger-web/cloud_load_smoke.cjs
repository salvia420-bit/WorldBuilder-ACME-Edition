// cloud_load_smoke.cjs — 2026-05-15
//
// Clouds-A foundation gate: confirm that @takram/three-clouds plus
// its pmndrs-postprocessing + @takram/three-atmosphere + three-geospatial
// peer deps all resolve through the importmap and bind without
// throwing in a swiftshader Chromium browser.
//
// This is NOT a render test — Clouds-A is module-load only. Render
// validation comes in Clouds-D.
//
// Pre-reqs:
// - Web proxy on 127.0.0.1:7080 (Python SimpleHTTPServer over the
//   WorldBuilder-ACME-Edition tree).
//
// Run: NODE_PATH=/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules \
//      node cloud_load_smoke.cjs
//
// Exit 0 on success, 1 otherwise. Prints per-step trace.

const path = require("node:path");

const PLAYWRIGHT_CACHE =
    process.env.PLAYWRIGHT_CACHE ||
    "/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules";
let chromium;
try {
    ({ chromium } = require("playwright"));
} catch (_) {
    ({ chromium } = require(path.join(PLAYWRIGHT_CACHE, "playwright")));
}

const PAGE_URL = process.env.CLOUD_SMOKE_URL
    || "http://127.0.0.1:7080/apps/holtburger-web/cloud_load_smoke.html";

(async () => {
    console.log("=== Clouds-A foundation — module load smoke ===");
    console.log(`page: ${PAGE_URL}`);

    // --use-gl=swiftshader matches the CI/capture pattern documented
    // in the handoff: clouds must boot under swiftshader so CI runs
    // can validate without a real GPU.
    const browser = await chromium.launch({
        headless: true,
        args: [
            "--use-gl=swiftshader",
            "--disable-background-timer-throttling",
        ],
    });
    const context = await browser.newContext({
        viewport: { width: 800, height: 600 },
    });
    const page = await context.newPage();

    const consoleErrors = [];
    const pageErrors = [];
    page.on("console", (msg) => {
        if (msg.type() === "error") {
            consoleErrors.push(msg.text());
        }
    });
    page.on("pageerror", (err) => {
        pageErrors.push(String(err));
    });

    let result;
    try {
        await page.goto(PAGE_URL, {
            waitUntil: "domcontentloaded",
            timeout: 30_000,
        });
        await page.waitForFunction(
            () => window.__cloudLoadSmoke && (window.__cloudLoadSmoke.ok === true || window.__cloudLoadSmoke.error),
            { timeout: 30_000 },
        );
        result = await page.evaluate(() => window.__cloudLoadSmoke);
    } catch (err) {
        result = { ok: false, error: `harness exception: ${err}` };
    } finally {
        await browser.close();
    }

    console.log("");
    console.log("--- result ---");
    if (result.threeRevision) console.log(`three.REVISION = ${result.threeRevision}`);
    if (result.postprocessingExportCount) {
        console.log(`postprocessing exports = ${result.postprocessingExportCount}`);
    }
    if (result.names && result.names.length) {
        console.log(`@takram/three-clouds exports (${result.names.length}):`);
        const cols = 3;
        for (let i = 0; i < result.names.length; i += cols) {
            console.log("  " + result.names.slice(i, i + cols).map(n => n.padEnd(28)).join(""));
        }
    }
    if (consoleErrors.length) {
        console.log(`\nconsole.error (${consoleErrors.length}):`);
        for (const e of consoleErrors) console.log("  " + e.slice(0, 300));
    }
    if (pageErrors.length) {
        console.log(`\npageerror (${pageErrors.length}):`);
        for (const e of pageErrors) console.log("  " + e.slice(0, 300));
    }
    console.log("");

    // Pass criteria: ok === true AND no pageerror AND no console.error
    // referencing a module-load failure. (Some console.errors are
    // benign WebGL noise under swiftshader; we only flag the
    // module-load-blocking ones.)
    const blockingConsole = consoleErrors.filter(e =>
        /Failed to (?:fetch|resolve|load|register).*module|Module (?:not found|specifier|resolution)|importmap/i.test(e),
    );

    if (result.ok && pageErrors.length === 0 && blockingConsole.length === 0) {
        console.log("PASS — Clouds-A foundation loads cleanly under swiftshader.");
        process.exit(0);
    } else {
        console.log("FAIL — Clouds-A foundation did not load.");
        if (result.error) console.log("  reason: " + result.error);
        process.exit(1);
    }
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
