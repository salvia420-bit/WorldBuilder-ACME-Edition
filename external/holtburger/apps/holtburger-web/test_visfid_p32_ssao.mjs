// Visual-fidelity Phase 3.2 — SSAO pipeline standalone test.
//
// Run with (from this dir):
//   node test_visfid_p32_ssao.mjs
//
// EffectComposer needs a real WebGL context, so this test does NOT
// instantiate the pipeline — it asserts the static surface (exports,
// defaults, the `quality.flags.ssao` gate). The full E2E lives in
// `capture_visfid_p32_ssao.cjs` against a headless Chromium.

import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";
import { readFileSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));

let failed = 0;
let passed = 0;
function check(name, ok, detail) {
    const status = ok ? "OK" : "FAIL";
    console.log(`  [${status}] ${name}${detail ? " — " + detail : ""}`);
    if (!ok) failed += 1;
    else passed += 1;
}

console.log("=========================");
console.log("Phase 3.2 — SSAO pipeline static checks");
console.log("=========================");

// ---- Source file integrity (postprocess.js exists, exports the
//      surface index.js consumes) -----------------------------------
console.log("\nGroup 1: postprocess.js exports");
{
    const src = readFileSync(
        resolvePath(__dirname, "scene3d/postprocess.js"),
        "utf8"
    );
    check(
        "exports createSsaoPipeline",
        /export function createSsaoPipeline/.test(src),
        "factory must be the named export index.js imports"
    );
    check(
        "exports SSAO_DEFAULTS",
        /export const SSAO_DEFAULTS/.test(src),
        "defaults bag is exported for documentation / tooling"
    );
    check(
        "imports EffectComposer from three/addons",
        /from "three\/addons\/postprocessing\/EffectComposer\.js"/.test(src),
        "must use the addons importmap key, not examples/jsm or a relative path"
    );
    check(
        "imports SSAOPass from three/addons",
        /from "three\/addons\/postprocessing\/SSAOPass\.js"/.test(src),
        "addon importmap pattern"
    );
    check(
        "imports OutputPass from three/addons",
        /from "three\/addons\/postprocessing\/OutputPass\.js"/.test(src),
        "tone-map + sRGB encoding for the composer output"
    );
}

// ---- Tuned defaults match the doc-specified targets ---------------
console.log("\nGroup 2: tuned defaults (AC 24m grid)");
{
    const src = readFileSync(
        resolvePath(__dirname, "scene3d/postprocess.js"),
        "utf8"
    );
    // Extract the DEFAULT_SSAO object literal.
    const m = src.match(/const DEFAULT_SSAO = (\{[\s\S]*?\});/);
    check("DEFAULT_SSAO literal present", !!m);
    if (m) {
        // eslint-disable-next-line no-eval
        const defaults = eval("(" + m[1] + ")");
        check(
            "kernelRadius in [2, 4] (AC 2-4m scale)",
            defaults.kernelRadius >= 2 && defaults.kernelRadius <= 4,
            `kernelRadius=${defaults.kernelRadius}`
        );
        check(
            "kernelSize === 16 (doc target)",
            defaults.kernelSize === 16,
            `kernelSize=${defaults.kernelSize}`
        );
        check(
            "minDistance > 0 (avoid divide-by-zero in shader)",
            defaults.minDistance > 0,
            `minDistance=${defaults.minDistance}`
        );
        check(
            "maxDistance < 0.5 (skip far-distance noise per doc)",
            defaults.maxDistance < 0.5,
            `maxDistance=${defaults.maxDistance}`
        );
        check(
            "minDistance < maxDistance",
            defaults.minDistance < defaults.maxDistance,
            `min=${defaults.minDistance} max=${defaults.maxDistance}`
        );
    }
}

// ---- index.js wiring ---------------------------------------------
console.log("\nGroup 3: index.js wiring");
{
    const src = readFileSync(
        resolvePath(__dirname, "scene3d/index.js"),
        "utf8"
    );
    check(
        "imports createSsaoPipeline",
        /import \{ createSsaoPipeline \} from "\.\/postprocess\.js"/.test(src),
        "renderer wires the pipeline factory"
    );
    check(
        "gates on quality.flags.ssao",
        /quality\?\.flags\?\.ssao/.test(src),
        "Phase X.1 single source of truth"
    );
    check(
        "render loop calls ssaoPipeline.render when present",
        /ssaoPipeline\.render\(activeCam\)/.test(src),
        "tick swaps composer.render for the world+sky pass"
    );
    check(
        "render loop calls preFrameSkySync",
        /ssaoPipeline\.preFrameSkySync/.test(src),
        "sky camera must track active world camera each frame"
    );
    check(
        "constructs pipeline with skyScene + skyCamera",
        /skyScene: skyDome\.skyScene/.test(src) &&
            /skyCamera: skyDome\.skyCamera/.test(src),
        "sky pass folded into composer to preserve sky-then-world order"
    );
    check(
        "resize handler propagates to composer",
        /ssaoPipeline\.setSize/.test(src),
        "EffectComposer needs explicit setSize on viewport change"
    );
    check(
        "exposes ssaoPipeline on liveScene3d",
        /liveScene3d\.ssaoPipeline = ssaoPipeline/.test(src),
        "capture scripts + devtools need access"
    );
}

// ---- sky_dome.js exposes syncSkyCamera ---------------------------
console.log("\nGroup 4: sky_dome.js syncSkyCamera extract");
{
    const src = readFileSync(
        resolvePath(__dirname, "scene3d/sky_dome.js"),
        "utf8"
    );
    check(
        "exposes syncSkyCamera method",
        /syncSkyCamera\(mainCamera\)/.test(src) ||
            /syncSkyCamera ?\(/.test(src),
        "composer path needs sync-only (no render) entry point"
    );
    check(
        "renderSkyPass delegates to syncSkyCamera",
        /this\.syncSkyCamera\(mainCamera\)/.test(src),
        "direct + composer paths share the camera-sync logic"
    );
}

console.log("\n=========================");
console.log(`passed: ${passed}, failed: ${failed}`);
console.log("=========================");

if (failed > 0) process.exit(1);
