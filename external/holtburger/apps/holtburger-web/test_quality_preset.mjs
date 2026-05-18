// Phase X.1 — quality preset standalone test.
//
// Run with:
//   cd apps/holtburger-web/
//   node test_quality_preset.mjs
//
// quality.js has zero runtime deps (no THREE, no wasm) so we can
// import the ESM file directly via file:// URL.

import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const qualityUrl =
    "file://" + resolvePath(__dirname, "scene3d/quality.js");
const { PRESETS, PRESET_NAMES, getQuality, isMobileUA } = await import(qualityUrl);

let failed = 0;
let passed = 0;
function check(name, ok, detail) {
    const status = ok ? "OK" : "FAIL";
    console.log(`  [${status}] ${name}${detail ? " — " + detail : ""}`);
    if (!ok) failed += 1;
    else passed += 1;
}

const DESKTOP_UA =
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const MOBILE_UA =
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) " +
    "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const ANDROID_UA =
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36";

console.log("=========================");
console.log("Phase X.1 — quality preset tests");
console.log("=========================");

// ---- Preset table integrity ----------------------------------------
console.log("\nGroup 1: preset table integrity");
{
    check(
        "PRESET_NAMES covers four tiers",
        PRESET_NAMES.length === 4 &&
            PRESET_NAMES.includes("low") &&
            PRESET_NAMES.includes("mid") &&
            PRESET_NAMES.includes("high") &&
            PRESET_NAMES.includes("ultra"),
        `names=${PRESET_NAMES.join(",")}`
    );
    check(
        "low preset: all heavy features off",
        PRESETS.low.shadows === false &&
            PRESETS.low.pom === false &&
            PRESETS.low.csm === false &&
            PRESETS.low.hero === false &&
            PRESETS.low.triplanar === false &&
            PRESETS.low.subdivLevel === 1
    );
    check(
        "mid preset: cheap features on, heavy features off",
        PRESETS.mid.shadows === true &&
            PRESETS.mid.triplanar === true &&
            PRESETS.mid.terrainDetailNormal === true &&
            PRESETS.mid.subdivLevel === 2 &&
            PRESETS.mid.pom === false &&
            PRESETS.mid.csm === false &&
            PRESETS.mid.hero === false
    );
    check(
        "high preset: all features on, subdivLevel=4",
        PRESETS.high.shadows === true &&
            PRESETS.high.pom === true &&
            PRESETS.high.csm === true &&
            PRESETS.high.hero === true &&
            PRESETS.high.subdivLevel === 4
    );
    check(
        "ultra preset: all features on, subdivLevel=8",
        PRESETS.ultra.shadows === true &&
            PRESETS.ultra.pom === true &&
            PRESETS.ultra.csm === true &&
            PRESETS.ultra.subdivLevel === 8
    );
    // Per spec § Phase X.1 acceptance criterion #1: `?quality=low`
    // produces a render with all visual-fidelity features off. The
    // table here is the source for that — make sure no future edit
    // accidentally flips a "heavy" feature on at the low tier.
    const heavy = ["shadows", "pom", "csm", "hero", "triplanar", "terrainDetailNormal", "detailFlag"];
    const allHeavyOffOnLow = heavy.every((f) => PRESETS.low[f] === false);
    check("low tier — every heavy feature flag is off", allHeavyOffOnLow);
}

// ---- URL parsing ----------------------------------------------------
console.log("\nGroup 2: URL parsing");
{
    const q1 = getQuality("https://example.com/?quality=low", DESKTOP_UA);
    check(
        "?quality=low → preset=low, source=url",
        q1.preset === "low" && q1.source === "url",
        `got preset=${q1.preset} source=${q1.source}`
    );
    check("?quality=low → flags match PRESETS.low", q1.flags.shadows === false && q1.flags.subdivLevel === 1);

    const q2 = getQuality("https://example.com/?quality=high", DESKTOP_UA);
    check(
        "?quality=high → preset=high, all heavy on",
        q2.preset === "high" &&
            q2.flags.pom === true &&
            q2.flags.csm === true &&
            q2.flags.subdivLevel === 4
    );

    const q3 = getQuality("https://example.com/?quality=ultra", DESKTOP_UA);
    check(
        "?quality=ultra → subdivLevel=8",
        q3.preset === "ultra" && q3.flags.subdivLevel === 8
    );

    const q4 = getQuality("https://example.com/?quality=garbage", DESKTOP_UA);
    check(
        "?quality=garbage → falls back to default (mid)",
        q4.preset === "mid" && q4.source === "default",
        `got preset=${q4.preset} source=${q4.source}`
    );

    const q5 = getQuality("https://example.com/", DESKTOP_UA);
    check(
        "no quality param + desktop UA → mid (default)",
        q5.preset === "mid" && q5.source === "default"
    );
}

// ---- Per-feature overrides -----------------------------------------
console.log("\nGroup 3: per-feature overrides (A/B testing)");
{
    const q1 = getQuality("https://example.com/?quality=mid&pom=on", DESKTOP_UA);
    check(
        "?quality=mid&pom=on → mid preset + pom flipped on",
        q1.preset === "mid" &&
            q1.flags.pom === true &&
            q1.flags.csm === false,
        `pom=${q1.flags.pom}`
    );

    const q2 = getQuality(
        "https://example.com/?quality=high&csm=off&pom=off",
        DESKTOP_UA
    );
    check(
        "?quality=high&csm=off&pom=off → high preset minus csm/pom",
        q2.preset === "high" &&
            q2.flags.csm === false &&
            q2.flags.pom === false &&
            q2.flags.hero === true
    );

    const q3 = getQuality(
        "https://example.com/?quality=low&subdivLevel=4",
        DESKTOP_UA
    );
    check(
        "?quality=low&subdivLevel=4 → low preset with integer override",
        q3.preset === "low" && q3.flags.subdivLevel === 4
    );

    const q4 = getQuality(
        "https://example.com/?quality=mid&pom=true&csm=yes",
        DESKTOP_UA
    );
    check(
        "boolean override aliases (true/1/yes) → all parse to true",
        q4.flags.pom === true && q4.flags.csm === true
    );

    const q5 = getQuality(
        "https://example.com/?quality=high&pom=false&csm=no",
        DESKTOP_UA
    );
    check(
        "boolean override aliases (false/0/no) → all parse to false",
        q5.flags.pom === false && q5.flags.csm === false
    );

    const q6 = getQuality(
        "https://example.com/?quality=mid&pom=banana",
        DESKTOP_UA
    );
    check(
        "unparseable override is ignored (preset value retained)",
        q6.preset === "mid" && q6.flags.pom === false,
        `pom=${q6.flags.pom}`
    );
}

// ---- Mobile detection ----------------------------------------------
console.log("\nGroup 4: mobile UA detection");
{
    check("isMobileUA(iPhone UA) === true", isMobileUA(MOBILE_UA) === true);
    check("isMobileUA(Android UA) === true", isMobileUA(ANDROID_UA) === true);
    check("isMobileUA(desktop UA) === false", isMobileUA(DESKTOP_UA) === false);
    check("isMobileUA('') === false", isMobileUA("") === false);
    check("isMobileUA(null) === false", isMobileUA(null) === false);

    const q1 = getQuality("https://example.com/", MOBILE_UA);
    check(
        "no quality + iPhone UA → low (mobile-default)",
        q1.preset === "low" && q1.source === "mobile-default",
        `got preset=${q1.preset} source=${q1.source}`
    );

    const q2 = getQuality("https://example.com/", ANDROID_UA);
    check(
        "no quality + Android UA → low (mobile-default)",
        q2.preset === "low" && q2.source === "mobile-default"
    );

    const q3 = getQuality("https://example.com/?quality=high", MOBILE_UA);
    check(
        "?quality=high + iPhone UA → high (explicit opt-in beats mobile downgrade)",
        q3.preset === "high" && q3.source === "url"
    );

    const q4 = getQuality("https://example.com/?quality=ultra", ANDROID_UA);
    check(
        "?quality=ultra + Android UA → ultra (explicit opt-in)",
        q4.preset === "ultra" && q4.source === "url"
    );
}

// ---- Edge cases ----------------------------------------------------
console.log("\nGroup 5: edge cases");
{
    const q1 = getQuality("garbage-url", DESKTOP_UA);
    check(
        "unparseable URL → falls back to default",
        q1.preset === "mid" && q1.source === "default"
    );

    const q2 = getQuality(null, DESKTOP_UA);
    check("null URL → falls back to default", q2.preset === "mid");

    const q3 = getQuality("https://example.com/?quality=low", null);
    check(
        "null UA + ?quality=low → low (URL still respected)",
        q3.preset === "low" && q3.source === "url"
    );

    const q4 = getQuality(
        "https://example.com/?quality=mid&pom=on",
        DESKTOP_UA
    );
    // Acceptance criterion #3: ?quality=mid&pom=on enables POM on top of mid preset.
    check(
        "acceptance #3: ?quality=mid&pom=on → pom on, all other mid-defaults retained",
        q4.preset === "mid" &&
            q4.flags.pom === true &&
            q4.flags.shadows === true &&
            q4.flags.triplanar === true &&
            q4.flags.csm === false &&
            q4.flags.hero === false &&
            q4.flags.subdivLevel === 2
    );

    // Returned flags object should be a fresh copy — mutating it must
    // not poison PRESETS for subsequent calls.
    const q5 = getQuality("https://example.com/?quality=mid", DESKTOP_UA);
    q5.flags.shadows = false;
    const q6 = getQuality("https://example.com/?quality=mid", DESKTOP_UA);
    check(
        "PRESETS not mutated by caller's flag mutation",
        q6.flags.shadows === true
    );
}

console.log("\n=========================");
console.log(`passed: ${passed}, failed: ${failed}`);
console.log("=========================");

if (failed > 0) {
    process.exit(1);
}
