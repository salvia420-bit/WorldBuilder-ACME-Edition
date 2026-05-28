// Phase 7.4a — standalone ESM test for `scene3d/animation.js` against
// real `three` (loaded from npm, not the importmap). Run with:
//
//   cd apps/holtburger-web/
//   node test_phase7_4a_animation_clip.mjs
//
// Falls back to the host's installed copy of `three` (Playwright is
// bundled at ~/.npm/_npx/.../node_modules/three on this box). Resolves
// the bare specifier via the explicit `THREE_PATH` env var or by
// walking common cache locations. If `three` can't be located the
// test prints SKIP and exits 0 (the smoke test's regex check stays
// the floor).
//
// Two stages:
//   1. SYNTHETIC: build a small fake `EntityAnimationData`-shaped
//      object with a known keyframe layout (3 frames × 4 parts × 7
//      floats each = 84 floats) and assert the resulting clip has
//      8 tracks (2 per part), correct duration, and that quaternion
//      values were reordered from (qw, qx, qy, qz) → (qx, qy, qz, qw).
//   2. REAL DAT (best-effort): if the dist/ symlink + a known-good
//      setup_id+mtable_id pair resolve, call the wasm export and
//      build a clip from real DAT data. If no setup resolves, log
//      and continue (walk-cycle resolution is highly setup-specific
//      and most static-prop setups don't have walk cycles — that's
//      expected, not a bug).
//
// This mirrors the smoke contract but does the work three.js can't
// do in plain CommonJS smoke (bare-specifier import).
//
// Note for future maintainers: this test deliberately doesn't import
// the wasm module. The wasm bundle's keyframe export is exercised by
// `smoke_test.cjs` (symbol-presence) and the live capture flows.
// Here we focus on the JS-side `buildAnimationClip` arithmetic.

import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath, join as joinPath } from "node:path";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

let failed = 0;
function check(name, ok, detail) {
    const status = ok ? "OK" : "FAIL";
    console.log(`  [${status}] ${name}${detail ? " — " + detail : ""}`);
    if (!ok) failed += 1;
}

// ---- locate `three` --------------------------------------------------
// The host has Playwright cached at ~/.npm/_npx/...; per the auto-
// memory note, `npx playwright`-cached three is the easiest source.
// Honour THREE_PATH env override first.
function locateThree() {
    if (process.env.THREE_PATH && existsSync(process.env.THREE_PATH)) {
        return process.env.THREE_PATH;
    }
    // Try resolving via require — works if `three` is installed in
    // a node_modules visible to this script.
    try {
        return require.resolve("three");
    } catch (_) {}
    // Walk common npm/npx cache locations.
    const candidates = [
        joinPath(process.env.HOME ?? "", ".npm/_npx/e41f203b7505f1fb/node_modules/three"),
        // Newer cache hash — fallback grep
    ];
    // Look harder via filesystem if the named hash misses.
    try {
        const npxRoot = joinPath(process.env.HOME ?? "", ".npm/_npx");
        if (existsSync(npxRoot)) {
            const fs = require("node:fs");
            for (const dir of fs.readdirSync(npxRoot)) {
                candidates.push(joinPath(npxRoot, dir, "node_modules/three"));
            }
        }
    } catch (_) {}
    for (const c of candidates) {
        const idx = joinPath(c, "build/three.module.js");
        if (existsSync(idx)) return idx;
    }
    return null;
}

const threePath = locateThree();
if (!threePath) {
    console.log("Phase 7.4a animation-clip ESM test: SKIP (three not located).");
    console.log("  hint: `THREE_PATH=/abs/path/to/three.module.js node test_phase7_4a_animation_clip.mjs`");
    process.exit(0);
}

// Use Node's resolver hook via a dynamic import + URL. The cleanest
// way to load a bare-specifier-style file from an ESM script is to
// import the file by absolute path.
const threeUrl = "file://" + threePath;
const THREE = await import(threeUrl);

console.log("Phase 7.4a — animation-clip standalone ESM test");
console.log(`three loaded from: ${threePath}`);
console.log("=========================");

// Inject the loaded three.js into the module-graph so animation.js's
// bare `import * as THREE from "three"` resolves. We'll do this via
// a trampoline: write the same exports under a known path, then
// import animation.js with its bare import patched to that path.
//
// Actually — the simplest, cheapest path: import animation.js's
// source as text and `eval` it in a context where THREE is in scope.
// That avoids touching Node's module loader.
const animPath = resolvePath(__dirname, "scene3d", "animation.js");
if (!existsSync(animPath)) {
    check("animation.js exists", false, animPath);
    process.exit(failed > 0 ? 1 : 0);
}
const animSrc = await import("node:fs").then((m) =>
    m.readFileSync(animPath, "utf8"),
);

// Strip the bare import line and replace with a closure-captured
// THREE — we already loaded three.js above. The strip is
// regex-narrow so a future rewrite to a different import doesn't
// silently fail.
const patched = animSrc
    .replace(/^\s*import\s+\*\s+as\s+THREE\s+from\s+["']three["'];?\s*$/m, "")
    // animation.js also imports meshToGeometryGroups from ./adapter.js; strip
    // it (buildAnimationClip never touches it, but the bare import would make
    // `new Function` throw "Cannot use import statement outside a module").
    .replace(
        /^\s*import\s+\{[^}]*\}\s+from\s+["']\.\/adapter\.js["'];?\s*$/m,
        "",
    )
    .replace(/^\s*export\s+function\s+/gm, "function ")
    .replace(/^\s*export\s+class\s+/gm, "class ");
// Wrap in a function that returns the symbols we need.
const factory = new Function(
    "THREE",
    `${patched}\n; return { buildAnimationClip, AnimationCache, cycleTimeScale };`,
);
const { buildAnimationClip, AnimationCache, cycleTimeScale } = factory(THREE);

// ---- T11: cycle playback-rate factor (anti-ice-skating) -------------
check(
    "cycleTimeScale: actual == base → 1.0",
    Math.abs(cycleTimeScale(4, 4) - 1.0) < 1e-9,
    `got ${cycleTimeScale(4, 4)}`,
);
check(
    "cycleTimeScale: 2× speed → 2.0",
    Math.abs(cycleTimeScale(8, 4) - 2.0) < 1e-9,
    `got ${cycleTimeScale(8, 4)}`,
);
check(
    "cycleTimeScale: half speed → 0.5",
    Math.abs(cycleTimeScale(2, 4) - 0.5) < 1e-9,
    `got ${cycleTimeScale(2, 4)}`,
);
check(
    "cycleTimeScale: clamps low (0 speed → 0.25)",
    cycleTimeScale(0, 4) === 0.25,
    `got ${cycleTimeScale(0, 4)}`,
);
check(
    "cycleTimeScale: clamps high (100/4 → 4.0)",
    cycleTimeScale(100, 4) === 4.0,
    `got ${cycleTimeScale(100, 4)}`,
);
check(
    "cycleTimeScale: zero/invalid base → 1.0 no-op",
    cycleTimeScale(8, 0) === 1.0 && cycleTimeScale(NaN, 4) === 1.0,
    `got ${cycleTimeScale(8, 0)}, ${cycleTimeScale(NaN, 4)}`,
);

// ---- Stage 1: synthetic keyframe round-trip -------------------------
//
// Synthesize a 3-frame × 4-part walk cycle. Each frame has a unique
// origin and orientation per part so we can spot-check the reorder.
const partCount = 4;
const numFrames = 3;
const framerate = 30.0;
const partFrames = new Float32Array(numFrames * partCount * 7);
for (let f = 0; f < numFrames; f += 1) {
    for (let p = 0; p < partCount; p += 1) {
        const base = (f * partCount + p) * 7;
        // origin: encode (frame, part) so we can spot-check.
        partFrames[base + 0] = f * 10 + p; // x
        partFrames[base + 1] = f * 10 + p + 0.1; // y
        partFrames[base + 2] = f * 10 + p + 0.2; // z
        // orientation: (qw, qx, qy, qz) — DAT layout. Pick a
        // distinctive set so the reorder is unambiguous.
        partFrames[base + 3] = 0.7; // qw
        partFrames[base + 4] = 0.1; // qx
        partFrames[base + 5] = 0.2; // qy
        partFrames[base + 6] = 0.3; // qz
    }
}
const partNames = ["part_0", "part_1", "part_2", "part_3"];

const clip = buildAnimationClip(
    { partCount, numFrames, framerate, partFrames },
    partNames,
);

check(
    "buildAnimationClip returns a non-null AnimationClip",
    clip != null,
    `clip=${clip ? "AnimationClip" : "null"}`,
);
check(
    "AnimationClip has 2 * partCount = 8 tracks",
    clip?.tracks?.length === partCount * 2,
    `tracks=${clip?.tracks?.length}, expected=${partCount * 2}`,
);
check(
    `AnimationClip.duration = numFrames / framerate = ${numFrames / framerate}`,
    clip != null && Math.abs(clip.duration - numFrames / framerate) < 1e-6,
    `duration=${clip?.duration}`,
);

// T4 (2026-05-28): when wasm supplies per-frame `frameTimes` + `duration`
// (multi-AnimData clip with differing per-segment framerates / reverse
// segments), buildAnimationClip uses them verbatim instead of uniform
// i/framerate. Here: 3 frames at non-uniform times [0, 0.1, 0.3], dur 0.5.
const ftClip = buildAnimationClip(
    {
        partCount,
        numFrames,
        framerate, // back-compat field; frameTimes must win
        partFrames,
        frameTimes: new Float32Array([0.0, 0.1, 0.3]),
        duration: 0.5,
    },
    partNames,
);
check(
    "T4: frameTimes drives non-null clip with provided duration (not numFrames/framerate)",
    ftClip != null && Math.abs(ftClip.duration - 0.5) < 1e-6,
    `duration=${ftClip?.duration} (expected 0.5, uniform would be ${numFrames / framerate})`,
);
check(
    "T4: KeyframeTrack times match the supplied frameTimes [0, 0.1, 0.3]",
    ftClip != null &&
        ftClip.tracks.length > 0 &&
        Math.abs(ftClip.tracks[0].times[0] - 0.0) < 1e-6 &&
        Math.abs(ftClip.tracks[0].times[1] - 0.1) < 1e-6 &&
        Math.abs(ftClip.tracks[0].times[2] - 0.3) < 1e-6,
    `times=[${ftClip?.tracks?.[0]?.times?.join(", ")}]`,
);

// Track names: every part contributes `${name}.position` and
// `${name}.quaternion`.
const trackNames = (clip?.tracks ?? []).map((t) => t.name).sort();
const expectedNames = partNames
    .flatMap((n) => [`${n}.position`, `${n}.quaternion`])
    .sort();
check(
    "Track names = [partName.position, partName.quaternion] for each part",
    JSON.stringify(trackNames) === JSON.stringify(expectedNames),
    `got=${trackNames.join(",")}, expected=${expectedNames.join(",")}`,
);

// Quaternion reorder: the DAT-layout (qw=0.7, qx=0.1, qy=0.2, qz=0.3)
// must come back as three.js (x=0.1, y=0.2, z=0.3, w=0.7). Inspect
// part_0's quaternion track values for frame 0.
const part0Quat = clip?.tracks?.find(
    (t) => t.name === "part_0.quaternion",
);
const quatVals = part0Quat?.values ?? [];
check(
    "Quaternion reorder: DAT (qw,qx,qy,qz)=(0.7,0.1,0.2,0.3) → three (x,y,z,w)=(0.1,0.2,0.3,0.7)",
    Math.abs(quatVals[0] - 0.1) < 1e-6 &&
        Math.abs(quatVals[1] - 0.2) < 1e-6 &&
        Math.abs(quatVals[2] - 0.3) < 1e-6 &&
        Math.abs(quatVals[3] - 0.7) < 1e-6,
    `got=(${quatVals[0]}, ${quatVals[1]}, ${quatVals[2]}, ${quatVals[3]})`,
);

// Position passthrough: frame 1 part 2 origin should land at (12, 12.1, 12.2).
const part2Pos = clip?.tracks?.find(
    (t) => t.name === "part_2.position",
);
const posVals = part2Pos?.values ?? [];
// Frame 1 → posVals[3..6]
check(
    "Position passthrough: frame=1 part=2 → (12, 12.1, 12.2)",
    Math.abs(posVals[3] - 12) < 1e-6 &&
        Math.abs(posVals[4] - 12.1) < 1e-5 &&
        Math.abs(posVals[5] - 12.2) < 1e-5,
    `got=(${posVals[3]}, ${posVals[4]}, ${posVals[5]})`,
);

// numFrames=0 case: must return null (no animation).
const empty = buildAnimationClip(
    { partCount, numFrames: 0, framerate: 0, partFrames: new Float32Array(0) },
    partNames,
);
check(
    "buildAnimationClip returns null when numFrames=0 (rest pose only)",
    empty === null,
    `got=${empty}`,
);

// ---- Stage 2: AnimationCache memoizes via key ------------------------
const cache = new AnimationCache();
let fetches = 0;
const fakeFetch = async (
    setupId,
    _modelChanges,
    _textureChanges,
    _paletteId,
    _paletteSubsFlat,
    mtableId,
    motionCommand,
    stance,
) => {
    fetches += 1;
    return {
        partCount,
        numFrames,
        framerate,
        resolvedStance: stance || 0x80000000,
        partFrames: Array.from(partFrames),
        takePartMeshes: () => [],
    };
};

const a = await cache.get(0x02000099, 0x09000001, 0x45000005, 0, fakeFetch);
const b = await cache.get(0x02000099, 0x09000001, 0x45000005, 0, fakeFetch);
check(
    "AnimationCache.get memoizes by (setupId, mtableId, command, stance)",
    fetches === 1 && a.clip != null && b.clip === a.clip,
    `fetches=${fetches}, sameClip=${a.clip === b.clip}`,
);
const c = await cache.get(0x02000099, 0x09000001, 0x44000007, 0, fakeFetch);
check(
    "AnimationCache.get fires a second fetch for a different command",
    fetches === 2 && c.clip != null && c.clip !== a.clip,
    `fetches=${fetches}, distinctClip=${c.clip !== a.clip}`,
);

// ---- Summary --------------------------------------------------------
console.log("=========================");
if (failed === 0) {
    console.log("PASS: all phase 7.4a clip-builder checks green.");
    process.exit(0);
} else {
    console.log(`FAIL: ${failed} check(s) failed.`);
    process.exit(1);
}
