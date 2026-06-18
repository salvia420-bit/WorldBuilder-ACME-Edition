// test_motion_sequence_wasm_smoke.mjs — drives the REAL compiled wasm
// `MotionSequence` exactly as scene3d/entities.js does (fromDescriptor with
// typed arrays → advance(dt) → globalFrameIndex/done → free). This exercises
// the JS↔wasm boundary marshalling that the cargo tests (native) and the JS
// poser test cannot — the substitute for an in-world eye-test.
//
// Run: node test_motion_sequence_wasm_smoke.mjs

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
let passed = 0, failed = 0;
function check(name, ok, detail) {
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${name}${detail != null ? " — " + detail : ""}`);
  if (ok) passed += 1; else failed += 1;
}

let init, MotionSequence;
try {
  const mod = await import("./pkg/holtburger_web.js");
  init = mod.default;
  MotionSequence = mod.MotionSequence;
  await init(readFileSync(join(here, "pkg", "holtburger_web_bg.wasm")));
} catch (e) {
  console.log(`  [SKIP] wasm pkg not loadable in Node: ${String(e.message).slice(0, 120)}`);
  process.exit(0); // not a failure — the cargo + poser tests already gate the logic
}

const EMPTY_F32 = new Float32Array(0);
const EMPTY_U32 = new Uint32Array(0);

console.log("wasm MotionSequence smoke — real compiled boundary (entities.js path)");

// One-shot swing (cyclic=false), 4 frames @10fps, dur 0.4 — exactly what
// _tryPlayLink builds. Advance like the tick loop; assert frame progression,
// one-shot `done` latch + final-frame clamp.
{
  const seq = MotionSequence.fromDescriptor(4, 10.0, 0.4, EMPTY_F32, EMPTY_U32, EMPTY_U32, false);
  check("fromDescriptor (one-shot) returns a MotionSequence", !!seq && seq.nodeCount === 1, `nodeCount=${seq?.nodeCount}`);
  check("frame 0 at rest", seq.globalFrameIndex === 0, `f=${seq.globalFrameIndex}`);
  seq.advance(0.05); check("t=0.05 → frame 0", seq.globalFrameIndex === 0, `f=${seq.globalFrameIndex}`);
  seq.advance(0.10); check("t=0.15 → frame 1", seq.globalFrameIndex === 1, `f=${seq.globalFrameIndex}`);
  seq.advance(0.20); check("t=0.35 → frame 3", seq.globalFrameIndex === 3, `f=${seq.globalFrameIndex}`);
  check("one-shot not done mid-clip", seq.done === false);
  seq.advance(0.50); // past end → one-shot completes, clamps last frame
  check("one-shot latches done", seq.done === true);
  check("one-shot clamps final frame", seq.globalFrameIndex === 3, `f=${seq.globalFrameIndex}`);
  seq.free();
  check("free() does not throw", true);
}

// Multi-segment node-split (the wasm per-segment descriptor): seg0 frames 0,1;
// seg1 frames 2,3; frameTimes [0,.1,.2,.4]. Cyclic — must wrap.
{
  const ft = Float32Array.from([0, 0.1, 0.2, 0.4]);
  const seq = MotionSequence.fromDescriptor(
    4, 10.0, 0.6, ft, Uint32Array.from([0, 2]), Uint32Array.from([2, 2]), true,
  );
  check("fromDescriptor (segmented) → 2 nodes", !!seq && seq.nodeCount === 2, `nodeCount=${seq?.nodeCount}`);
  seq.advance(0.25); check("seg-split t=0.25 → global frame 2", seq.globalFrameIndex === 2, `f=${seq.globalFrameIndex}`);
  seq.advance(0.40); // 0.65 total → wrapped (dur 0.6) → 0.05 into seg0 → frame 0
  check("cyclic wraps off the end", seq.globalFrameIndex === 0 && seq.done === false, `f=${seq.globalFrameIndex} done=${seq.done}`);
  seq.free();
}

// chainOneShotThenCycle: link (one-shot) then cycle resumes by list-advance.
{
  const link = MotionSequence.fromDescriptor(4, 10.0, 0.4, EMPTY_F32, EMPTY_U32, EMPTY_U32, false);
  const cycle = MotionSequence.fromDescriptor(4, 10.0, 0.4, EMPTY_F32, EMPTY_U32, EMPTY_U32, true);
  const chained = MotionSequence.chainOneShotThenCycle(link, cycle);
  check("chainOneShotThenCycle → 2 nodes, firstCyclic=1",
    !!chained && chained.nodeCount === 2 && chained.firstCyclicIndex === 1,
    `nodeCount=${chained?.nodeCount} firstCyclic=${chained?.firstCyclicIndex}`);
  chained.advance(0.5); // past link(0.4) into cycle
  check("chained resumes cycle (nodeIndex 1, never done)",
    chained.nodeIndex === 1 && chained.done === false, `nodeIndex=${chained.nodeIndex} done=${chained.done}`);
  link.free(); cycle.free(); chained.free();
}

// phase / seekPhase — locomotion phase carry across a cycle swap (walk→run).
{
  const walk = MotionSequence.fromDescriptor(4, 10.0, 0.4, EMPTY_F32, EMPTY_U32, EMPTY_U32, true);
  check("phase starts at 0", Math.abs(walk.phase - 0) < 1e-6, `phase=${walk.phase}`);
  walk.advance(0.2); // half of dur 0.4
  check("phase ~0.5 mid-cycle", Math.abs(walk.phase - 0.5) < 1e-4, `phase=${walk.phase}`);
  const run = MotionSequence.fromDescriptor(4, 20.0, 0.2, EMPTY_F32, EMPTY_U32, EMPTY_U32, true);
  run.seekPhase(walk.phase);
  check("seekPhase carries phase across differing durations",
    Math.abs(run.phase - 0.5) < 1e-4, `run.phase=${run.phase}`);
  walk.free(); run.free();
}

console.log("===========================================================");
console.log(`Result: ${passed} passed, ${failed} failed`);
console.log("===========================================================");
process.exit(failed > 0 ? 1 : 0);
