// Batch 6 / #31 — standalone ESM test for `scene3d/audio/ambient_runtime.js`
// continuous-loop handle-identity guard.
//
// Bug #31: the post-resolve / post-play guards in _startContinuousLoop
// checked the active loop's `stbId`, not the HANDLE IDENTITY. So when a
// loop for some sType is stopped and a NEW loop for the SAME sType is
// re-started under the SAME stbId (the indoor↔outdoor toggle / STB
// re-prime case), the original (stale) closure's stbId still matched
// the new handle's stbId — and it would clobber the new handle's
// audioHandle with the source it just (belatedly) started, leaking the
// new live source and stomping the freshly-installed loop.
//
// The fix: capture the `handle` object at loop start and only proceed
// if the map slot STILL holds that exact handle. The stale closure must
// (a) NOT write its source onto the new handle and (b) still call
// `_stopAudioHandle(audio)` on its own just-started source.
//
// Run with:
//   cd apps/holtburger-web/
//   node test_ambient_liveness.mjs

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

function loadModule(relPath) {
    const full = resolvePath(__dirname, relPath);
    let src = readFileSync(full, "utf8");
    src = src.replace(
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

console.log("Batch 6 / #31 — ambient continuous-loop liveness ESM test");
console.log("=========================");

// ---- Controllable async play() --------------------------------------
// Each play() call returns a Promise we resolve manually so we can
// interleave: start H1 (pending), stop + restart -> H2 (pending),
// release H1 first, then H2. resolveSound resolves synchronously.

const STB = 0x1234;
const STYPE = 0x46;

const pending = []; // { resolve, handle, id } per play() call, in call order
let nextSourceId = 0;
const stoppedSources = []; // ids passed to source.stop()

// play() returns the audio_manager.js handle shape `{ source, panner,
// gain }` — _stopAudioHandle drives `audioHandle.source.stop(0)`.
const audioManager = {
    async play(_did, _worldPos, _opts) {
        const id = nextSourceId++;
        const handle = {
            id,
            source: {
                stop(_when) {
                    stoppedSources.push(id);
                },
            },
            panner: {},
            gain: {},
        };
        return await new Promise((resolve) => {
            pending.push({ resolve, handle, id });
        });
    },
};

const soundTableCache = {
    async resolveSound(_stbId, _sType) {
        // Synchronous-ish: resolves on the microtask queue.
        return { waveDid: 0x0a000001, volume: 1.0 };
    },
};

const rt = new AmbientRuntime({
    soundTableCache,
    audioManager,
    getPlayerPos: () => ({ x: 0, y: 0, z: 0 }),
    getRegion: () => ({}),
    rng: () => 0.0,
});

// Helper: drain microtasks so resolveSound's await + the guard run.
async function drainMicrotasks(n = 8) {
    for (let i = 0; i < n; i += 1) await Promise.resolve();
}

// ---- Drive the race -------------------------------------------------
// 1. Start loop H1. resolveSound resolves on microtasks, then it awaits
//    audioManager.play -> a pending promise (call #0). Handle H1 sits
//    in the map with audioHandle === null.
rt._startContinuousLoop(STB, STYPE, 1.0, { x: 0, y: 0, z: 0 });
await drainMicrotasks();
const H1 = rt._continuousLoops.get(STYPE);
check("H1 installed in slot", !!H1, String(!!H1));
check("play() #0 is pending for H1", pending.length === 1, `pending=${pending.length}`);

// 2. Stop all loops (indoor transition), then re-start the SAME sType
//    under the SAME stbId -> handle H2. H1's closure is still awaiting
//    play() #0.
rt._stopAllContinuousLoops();
rt._startContinuousLoop(STB, STYPE, 1.0, { x: 0, y: 0, z: 0 });
await drainMicrotasks();
const H2 = rt._continuousLoops.get(STYPE);
check("H2 is a DISTINCT handle from H1", H2 && H2 !== H1, `H2!==H1: ${H2 !== H1}`);
check("play() #1 is pending for H2", pending.length === 2, `pending=${pending.length}`);

// 3. Release H1's play() FIRST (its source = id 0). The stale H1 closure
//    runs its post-play guard: the slot now holds H2, not H1, so it must
//    NOT write its source onto H2 and MUST stop its own source (id 0).
pending[0].resolve(pending[0].handle); // H1's handle, source id 0
await drainMicrotasks();

check(
    "H1 closure did NOT write its source onto H2",
    H2.audioHandle == null || H2.audioHandle.id !== 0,
    `H2.audioHandle.id=${H2.audioHandle?.id}`
);
check(
    "_stopAudioHandle invoked exactly once on H1's stale source (id 0)",
    stoppedSources.length === 1 && stoppedSources[0] === 0,
    `stopped=${JSON.stringify(stoppedSources)}`
);

// 4. Now release H2's play() (source id 1). It IS the live slot, so it
//    must install onto H2.
pending[1].resolve(pending[1].handle); // H2's handle, source id 1
await drainMicrotasks();

check(
    "H2 closure installed its source (id 1) onto the live slot",
    rt._continuousLoops.get(STYPE) === H2 && H2.audioHandle?.id === 1,
    `H2.audioHandle.id=${H2.audioHandle?.id}`
);
check(
    "H2's source was NOT spuriously stopped",
    !stoppedSources.includes(1),
    `stopped=${JSON.stringify(stoppedSources)}`
);

console.log("=========================");
console.log(`Batch 6 / #31 ambient liveness: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
