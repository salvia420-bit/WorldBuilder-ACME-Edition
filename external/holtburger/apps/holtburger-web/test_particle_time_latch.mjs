// Per-tick particle clock latch (time_rng.js holdTimeLatch/releaseTimeLatch):
// retail reads one PhysicsTimer::curr_time per tick; ParticleManager.tick holds
// a latch so every particle in the tick sees the same sample.
import { currentTime, setCurrentTime, holdTimeLatch, releaseTimeLatch } from "./scene3d/particles/time_rng.js";

let passed = 0, failed = 0;
function check(name, ok, detail = "") {
  if (ok) { passed++; console.log(`  [OK] ${name}`); }
  else { failed++; console.log(`  [FAIL] ${name} ${detail}`); }
}

let t = 1.0, calls = 0;
setCurrentTime(() => { calls++; return t; });

check("unlatched: each read samples the clock", (currentTime(), currentTime(), calls === 2), `calls=${calls}`);
calls = 0;
holdTimeLatch();
t = 2.0;
const a = currentTime();
t = 3.0;
const b = currentTime();
check("latched: one sample for the whole tick", calls === 1 && a === b, `calls=${calls} a=${a} b=${b}`);
holdTimeLatch();            // nested tick shares the outer sample
t = 4.0;
check("nested latch keeps the outer sample", currentTime() === a);
releaseTimeLatch();
check("inner release keeps the latch", currentTime() === a);
releaseTimeLatch();
check("outer release reads the live clock again", currentTime() === 4.0);
releaseTimeLatch();         // unbalanced release is harmless
check("extra release does not underflow", currentTime() === 4.0);

setCurrentTime(null);
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
