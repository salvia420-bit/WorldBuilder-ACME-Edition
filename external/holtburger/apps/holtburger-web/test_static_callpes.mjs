// Task #2 (2026-06-23) — static/scenery CallPES (hook 19) loop arm.
//
// statics.js cannot be `import`ed under node (heavy THREE/wasm imports), so —
// like the rest of the statics structural tests (see test_particle_clock.mjs) —
// this asserts the source-level contract of `_scheduleStaticCallPes` +
// `_runStaticParticleChain`. Behavioral (visual) validation is the batched 1070
// eye-test (task #3). The invariants checked here are the ones that, if broken,
// silently regress the ambient swarm loop: hook-19 dispatch, the exact
// hookData byte decode, self-vs-cross-reference depth handling, the retail
// [0,pause] jitter, and timer cleanup on dispose.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join as joinPath } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(joinPath(__dirname, "scene3d", "statics.js"), "utf8");

let passed = 0;
let failed = 0;
function check(label, cond) {
  if (cond) {
    passed += 1;
    console.log(`  [OK] ${label}`);
  } else {
    failed += 1;
    console.log(`  [FAIL] ${label}`);
  }
}

// Isolate the scheduler body so the assertions can't be satisfied by an
// unrelated mention elsewhere in the 3000-line file.
const schedFn = src.slice(
  src.indexOf("function _scheduleStaticCallPes"),
  src.indexOf("async function _runStaticParticleChain")
);
check("_scheduleStaticCallPes helper exists", schedFn.length > 0);

// 1. Hook type 19 constant + dispatch.
check("STATIC_HOOK_CALL_PES = 19 defined",
  /const STATIC_HOOK_CALL_PES = 19;/.test(src));
check("chain loop dispatches hook 19 to _scheduleStaticCallPes",
  /=== STATIC_HOOK_CALL_PES\) \{\s*\n\s*_scheduleStaticCallPes\(/.test(src));

// 2. Exact byte decode (must match the proven entity-walker layout:
//    callPesDid u32 LE @[0..4], callPesPause f32 LE @[4..8]).
check("decodes callPesDid via getUint32(0, true)",
  /getUint32\(0, true\) >>> 0/.test(schedFn));
check("decodes callPesPause via getFloat32(4, true)",
  /getFloat32\(4, true\)/.test(schedFn));
check("requires >= 8 bytes of hookData before decoding",
  /byteLength < 8\) return/.test(schedFn));
check("drops callPesDid === 0", /callPesDid === 0\) return/.test(schedFn));

// 3. Self vs cross-reference depth handling — the heart of the loop.
check("self-reference detected via callPesDid === scriptId",
  /isSelf = callPesDid === \(scriptId >>> 0\)/.test(schedFn));
check("ONLY cross-references are depth-capped (self loops forever)",
  /!isSelf && depth >= STATIC_MAX_CALL_PES_DEPTH/.test(schedFn));
check("self-reference keeps depth; cross-reference increments",
  /nextDepth = isSelf \? depth : depth \+ 1/.test(schedFn));
check("STATIC_MAX_CALL_PES_DEPTH defined", /const STATIC_MAX_CALL_PES_DEPTH = \d+;/.test(src));

// 4. Retail [0, pause] jitter (Random::RollDice; < 0.0002 fires immediately).
check("rolls uniform [0, pause] via rng(), immediate below 0.0002",
  /randPause = pauseW < 0\.0002 \? 0 : rng\(\) \* pauseW/.test(schedFn));
check("delay adds the hook's own start_time offset",
  /\(\(\+entry\.startTime \|\| 0\) \+ randPause\) \* 1000/.test(schedFn));

// 5. Re-run + liveness guards (stop on teardown / LB eviction).
check("re-run guarded on _spDisposed (scene teardown)",
  /if \(_spDisposed\) return;/.test(schedFn));
check("re-run guarded on anchor.parent (LB eviction)",
  /!anchor \|\| !anchor\.parent\) return;/.test(schedFn));
check("timer re-invokes _runStaticParticleChain with nextDepth",
  /_runStaticParticleChain\(\s*\n?\s*manager, anchor, callPesDid, wasmExports, ownerKey, nextDepth/.test(schedFn));

// 6. _runStaticParticleChain threads a depth param (default 0).
check("_runStaticParticleChain accepts depth = 0",
  /async function _runStaticParticleChain\(manager, anchor, pesId, wasmExports, ownerKey = null, depth = 0\)/.test(src));

// 7. Timer lifecycle: tracked + cancelled on dispose.
check("pending timers tracked in _staticCallPesTimeouts Set",
  /const _staticCallPesTimeouts = new Set\(\);/.test(src) &&
  /_staticCallPesTimeouts\.add\(tid\)/.test(schedFn) &&
  /_staticCallPesTimeouts\.delete\(tid\)/.test(schedFn));
const disposeFn = src.slice(
  src.indexOf("export function disposeStaticParticles"),
  src.indexOf("export function disposeStaticParticles") + 1400
);
check("disposeStaticParticles clearTimeout()s every pending timer",
  /for \(const tid of _staticCallPesTimeouts\)/.test(disposeFn) &&
  /clearTimeout\(tid\)/.test(disposeFn) &&
  /_staticCallPesTimeouts\.clear\(\)/.test(disposeFn));

// 8. Headless safety — no timers armed without setTimeout (node tests).
check("no-op when setTimeout is unavailable",
  /typeof setTimeout !== "function"\) return/.test(schedFn));

// 9. `?staticCallPes=off` escape — disables only the loop, default on.
check("STATIC_CALL_PES_ON reads ?staticCallPes (default on, =off escape)",
  /get\("staticCallPes"\)\?\.toLowerCase\(\) !== "off"/.test(src) &&
  /STATIC_CALL_PES_ON = \(\(\) => \{/.test(src));
check("_scheduleStaticCallPes honors the ?staticCallPes=off escape first",
  /if \(!STATIC_CALL_PES_ON\) return;/.test(schedFn));

console.log(`\nStatic CallPES loop arm: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
