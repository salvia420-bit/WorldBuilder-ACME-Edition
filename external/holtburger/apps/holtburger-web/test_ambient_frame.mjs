// Batch 6 / #15 — standalone ESM test for `scene3d/audio/ambient_runtime.js`
// frame transform. AmbientRuntime now imports `acToThree` from
// `../adapter.js` and must transform the AC-frame listener position
// into the three.js world frame BEFORE `audioManager.play()` (so the
// PannerNode lands in the same frame as the camera-anchored
// AudioListener), while the Phase F.C `_pushEventRecord.world_pos`
// stays AC-frame for the F.D validator.
//
// This test loads ambient_runtime.js via the closure-captured-import
// trick (same pattern as test_phase7_5_camera.mjs): strip the
// `import { acToThree } from "../adapter.js"` line and inline the
// implementation so the test stays self-contained (no THREE / wasm
// needed — acToThree is pure math).
//
// Run with:
//   cd apps/holtburger-web/
//   node test_ambient_frame.mjs

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

// ---- load ambient_runtime.js with closure-captured acToThree --------
function loadModule(relPath) {
    const full = resolvePath(__dirname, relPath);
    let src = readFileSync(full, "utf8");
    src = src.replace(
        // Batch 6 added `import { acToThree } from "../adapter.js"`.
        // Inline the implementation here so the test is self-contained.
        /^\s*import\s+\{\s*acToThree\s*\}\s+from\s+["']\.\.\/adapter\.js["'];?\s*$/m,
        "const acToThree = (ax, ay, az) => [ax, az, -ay];"
    );
    return src;
}

function stripExports(src) {
    return src
        .replace(/^\s*export\s+function\s+/gm, "function ")
        .replace(/^\s*export\s+class\s+/gm, "class ")
        .replace(/^\s*export\s+const\s+/gm, "const ")
        .replace(/^\s*export\s+default\s+/gm, "")
        .replace(/^\s*export\s+\{[^}]+\}[\s;]*$/gm, "");
}

const arSrc = loadModule("scene3d/audio/ambient_runtime.js");
const composite =
    "// === ambient_runtime.js ===\n" + stripExports(arSrc) + "\n" +
    "; return { AmbientRuntime };";

const factory = new Function("performance", "console", composite);
const { AmbientRuntime } = factory(
    globalThis.performance ?? { now: () => Date.now() },
    console
);

console.log("Batch 6 / #15 — ambient frame-transform ESM test");
console.log("=========================");

// Sanity: confirm the inlined acToThree matches the contract.
{
    const acToThree = (ax, ay, az) => [ax, az, -ay];
    const r = acToThree(10, 20, 30);
    check(
        "acToThree(10,20,30) === [10,30,-20]",
        r[0] === 10 && r[1] === 30 && r[2] === -20,
        JSON.stringify(r)
    );
}

// ---- build a controllable AmbientRuntime ----------------------------
// Stub audioManager.play recording the worldPos it receives, a
// synchronous soundTableCache.resolveSound, an AC player pos
// {100,200,50}, and a deterministic rng. Drive one probabilistic fire
// + one continuous start and assert the recorded play() worldPos is
// the THREE-frame {100,50,-200} (NOT the AC {100,200,50}), while the
// pushed event-log world_pos stays AC [100,200,50].

function makeRuntime() {
    const playCalls = [];
    const eventRecords = [];
    const audioManager = {
        async play(did, worldPos, opts) {
            playCalls.push({ did, worldPos, opts });
            // Return a fake handle so the continuous path stashes it.
            return { source: { stop() {} }, panner: {}, gain: {} };
        },
    };
    const soundTableCache = {
        async resolveSound(_stbId, _sType) {
            return { waveDid: 0x0a000001, volume: 1.0 };
        },
    };
    const rt = new AmbientRuntime({
        soundTableCache,
        audioManager,
        getPlayerPos: () => ({ x: 100, y: 200, z: 50 }),
        getRegion: () => ({}),
        rng: () => 0.0,
        pushEventRecord: (rec) => eventRecords.push(rec),
    });
    return { rt, playCalls, eventRecords };
}

// ---- Test: _fireProbabilistic transforms before play() --------------
{
    const { rt, playCalls, eventRecords } = makeRuntime();
    const entry = {
        sType: 0x46,
        volume: 1.0,
        baseChance: 1.0,
        minRate: 1,
        maxRate: 2,
        remainingS: 0,
    };
    rt._fireProbabilistic(0x1234, entry, { x: 100, y: 200, z: 50 });
    // _fireProbabilistic kicks an async resolveAndPlay; await a tick.
    await Promise.resolve();
    await Promise.resolve();

    const wp = playCalls[0]?.worldPos;
    check(
        "_fireProbabilistic play() worldPos is THREE-frame {100,50,-200}",
        !!wp && wp.x === 100 && wp.y === 50 && wp.z === -200,
        JSON.stringify(wp)
    );
    const rec = eventRecords[0]?.world_pos;
    check(
        "_fireProbabilistic event world_pos stays AC [100,200,50]",
        Array.isArray(rec) && rec[0] === 100 && rec[1] === 200 && rec[2] === 50,
        JSON.stringify(rec)
    );
    check(
        "_fireProbabilistic play() opts.loop === false",
        playCalls[0]?.opts?.loop === false,
        String(playCalls[0]?.opts?.loop)
    );
}

// ---- Test: _startContinuousLoop transforms before play() ------------
{
    const { rt, playCalls, eventRecords } = makeRuntime();
    rt._startContinuousLoop(0x1234, 0x46, 1.0, { x: 100, y: 200, z: 50 });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const wp = playCalls[0]?.worldPos;
    check(
        "_startContinuousLoop play() worldPos is THREE-frame {100,50,-200}",
        !!wp && wp.x === 100 && wp.y === 50 && wp.z === -200,
        JSON.stringify(wp)
    );
    const rec = eventRecords[0]?.world_pos;
    check(
        "_startContinuousLoop event world_pos stays AC [100,200,50]",
        Array.isArray(rec) && rec[0] === 100 && rec[1] === 200 && rec[2] === 50,
        JSON.stringify(rec)
    );
    check(
        "_startContinuousLoop play() opts.loop === true",
        playCalls[0]?.opts?.loop === true,
        String(playCalls[0]?.opts?.loop)
    );
}

console.log("=========================");
console.log(`Batch 6 / #15 ambient frame: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
