// VFX Phase 1 — material-oscillator registry unit test (slice 01).
//
// Locks the SINGLE per-frame VFX tick (build spec §7): the waveform math is
// deterministic + correctly-ranged, the master clock is the sole writer of
// uTime, registered channels write their shared {value} uniforms once/frame, the
// tick is O(1) (clock-only with no channels, fail-soft per channel), and the
// leaf module is THE-RULE clean under lint_caps (reads only clock, no
// Math.random / argless Date.now).

import { readFileSync } from "node:fs";
import {
  WAVES, sampleWave, tickOscillators, setMasterClock, registerOscillator,
  updateOscillator, getOscillator, listOscillators, unregisterOscillator,
  _clearOscillators, OSCILLATOR_INFRA_MANIFEST,
} from "./scene3d/vfx/oscillators.js";
import { lintSource, lintManifest, ALLOWED_READS, ALLOWED_WRITES } from "./scene3d/vfx/lint_caps.js";

let passed = 0, failed = 0;
function check(label, cond, extra = "") {
  if (cond) { passed++; console.log(`  [OK] ${label}`); }
  else { failed++; console.log(`  [FAIL] ${label} ${extra}`); }
}
const approx = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
const inRange = (v, lo, hi) => v >= lo - 1e-9 && v <= hi + 1e-9;

// ── Waveform primitives ──────────────────────────────────────────────────────
check("WAVES exposes sine/triangle/smoothNoise/decay",
  ["sine", "triangle", "smoothNoise", "decay"].every((k) => typeof WAVES[k] === "function"));

// sine: bias + amp·sin(2π·freq·t + phase)
check("sine(0) == bias", approx(sampleWave("sine", 0, { bias: 0.5, amp: 2 }), 0.5));
check("sine quarter-period hits +amp",
  approx(sampleWave("sine", 0.25, { freq: 1, amp: 3, bias: 0 }), 3));
check("sine stays in [bias-amp, bias+amp]",
  Array.from({ length: 64 }, (_, i) => sampleWave("sine", i * 0.05, { freq: 1.3, amp: 0.4, bias: 1 }))
    .every((v) => inRange(v, 0.6, 1.4)));

// triangle: symmetric, peak +amp at mid-period, in range
check("triangle peak at frac=0.5 == bias+amp",
  approx(sampleWave("triangle", 0.5, { freq: 1, amp: 2, bias: 0 }), 2));
check("triangle stays in [bias-amp, bias+amp]",
  Array.from({ length: 80 }, (_, i) => sampleWave("triangle", i * 0.037, { freq: 0.9, amp: 0.5, bias: 1 }))
    .every((v) => inRange(v, 0.5, 1.5)));

// smoothNoise: deterministic, in range, and seeds decorrelate
check("smoothNoise is DETERMINISTIC (same t,seed -> same value)",
  sampleWave("smoothNoise", 3.14159, { freq: 2, seed: 7 }) ===
  sampleWave("smoothNoise", 3.14159, { freq: 2, seed: 7 }));
check("smoothNoise stays in [bias-amp, bias+amp]",
  Array.from({ length: 200 }, (_, i) => sampleWave("smoothNoise", i * 0.11, { freq: 1.7, amp: 0.3, bias: 0.7, seed: 2 }))
    .every((v) => inRange(v, 0.4, 1.0)));
check("smoothNoise seeds decorrelate (different seed -> different curve)",
  sampleWave("smoothNoise", 5.0, { freq: 1, seed: 1 }) !== sampleWave("smoothNoise", 5.0, { freq: 1, seed: 9 }));

// decay: dormant before t0, full at t0, monotone-decaying after; wobble option
check("decay == bias before trigger t0", approx(sampleWave("decay", 1, { t0: 5, amp: 1, bias: 0 }), 0));
check("decay == bias+amp at t0", approx(sampleWave("decay", 5, { t0: 5, amp: 2, bias: 0 }), 2));
check("decay shrinks after t0",
  sampleWave("decay", 6, { t0: 5, tau: 1, amp: 1 }) > sampleWave("decay", 8, { t0: 5, tau: 1, amp: 1 }));
check("decayWobble oscillates (damped) — soft-item jiggle primitive",
  sampleWave("decay", 5.0, { t0: 5, tau: 2, amp: 1, wobbleFreq: 2 }) >
  sampleWave("decay", 5.25, { t0: 5, tau: 2, amp: 1, wobbleFreq: 2 }));

check("sampleWave throws on an unknown kind", (() => {
  try { sampleWave("sawtooth", 0); return false; } catch (_) { return true; }
})());

// ── Registry + master clock ──────────────────────────────────────────────────
_clearOscillators();

// The master clock is the SOLE writer of uTime. Use a stand-in {value} object —
// in the app this is VFX_GLOBALS.uTime, bound by reference in loop.js.
const uTime = { value: 0 };
const uWetness = { value: 0 };       // a ramped/driven uniform stand-in

check("tickOscillators is safe BEFORE setMasterClock (no clock, no channels)", (() => {
  try { tickOscillators(1.0, 0.016); return true; } catch (_) { return false; }
})());

setMasterClock(uTime);
tickOscillators(12.5, 0.016);
check("★ master clock is uTime's SOLE writer: tick sets uTime.value = tSec", uTime.value === 12.5);

// Register a sine channel onto a shared {value} uniform.
registerOscillator("test.glintPhase", { kind: "sine", target: uWetness, config: { freq: 0.5, amp: 0.5, bias: 0.5 } });
check("registerOscillator returns/stores the channel",
  getOscillator("test.glintPhase")?.kind === "sine" && listOscillators().includes("test.glintPhase"));

tickOscillators(1.0, 0.016);  // sin(2π·0.5·1)=sin(π)=0 -> 0.5+0.5·0 = 0.5
check("★ channel writes its shared {value} uniform from the master clock", approx(uWetness.value, 0.5));
check("★ phase-lock: same tSec drives uTime AND the channel coherently", uTime.value === 1.0);

tickOscillators(0.5, 0.016);  // sin(2π·0.5·0.5)=sin(π/2)=1 -> 0.5+0.5 = 1.0
check("channel re-evaluates against the new clock each tick", approx(uWetness.value, 1.0));

// O(1) determinism: re-ticking the SAME t reproduces the SAME uniform values.
const before = uWetness.value;
tickOscillators(0.5, 0.016);
check("tick is deterministic for a fixed t (idempotent uniforms)", uWetness.value === before);

// Live-tune + re-register (idempotent wiring) + unregister.
updateOscillator("test.glintPhase", { amp: 0 });
tickOscillators(0.5, 0.016);
check("updateOscillator live-tunes config (amp 0 -> flat at bias)", approx(uWetness.value, 0.5));
registerOscillator("test.glintPhase", { kind: "triangle", target: uWetness, config: { freq: 1, amp: 1, bias: 0 } });
check("re-registering same name replaces it (idempotent)", getOscillator("test.glintPhase").kind === "triangle");
check("unregisterOscillator drops the channel", unregisterOscillator("test.glintPhase") && !getOscillator("test.glintPhase"));

// Fail-soft: a channel whose target lacks .value at register time is rejected;
// a runtime throw in one channel must not stop the clock or sibling channels.
check("registerOscillator rejects a bad kind", (() => {
  try { registerOscillator("bad", { kind: "nope" }); return false; } catch (_) { return true; }
})());
check("registerOscillator rejects a non-{value} target", (() => {
  try { registerOscillator("bad", { kind: "sine", target: 42 }); return false; } catch (_) { return true; }
})());

_clearOscillators();
const uOnlyClock = { value: -1 };
setMasterClock(uOnlyClock);
tickOscillators(7.0, 0.0);
check("with ZERO channels the tick is clock-only (O(1) floor)", uOnlyClock.value === 7.0 && listOscillators().length === 0);

// uTime is wrapped to [0,3600) so the float32 GLSL uniform never loses sub-frame
// precision over a long session (handoff R-D / kit R6). The wrap is phase-locked
// across the master clock and channels and is a no-op for any tSec < 3600.
tickOscillators(3601.5, 0.016);
check("★ master clock wraps mod 3600 (float32 precision guard, R-D)", approx(uOnlyClock.value, 1.5));

// ── THE RULE: leaf module is legacy-safe + the infra pseudo-manifest is legal ─
check("OSCILLATOR_INFRA_MANIFEST reads only the clock", OSCILLATOR_INFRA_MANIFEST.reads.every((r) => ALLOWED_READS.has(r)));
check("OSCILLATOR_INFRA_MANIFEST writes only materialUniform", OSCILLATOR_INFRA_MANIFEST.writes.every((w) => ALLOWED_WRITES.has(w)));
check("OSCILLATOR_INFRA_MANIFEST passes lintManifest (deterministic/no-relink/no-instance-key)",
  lintManifest({ ...OSCILLATOR_INFRA_MANIFEST, channel: "clock" }).length === 0,
  lintManifest({ ...OSCILLATOR_INFRA_MANIFEST, channel: "clock" }).join("; "));

const src = readFileSync(new URL("./scene3d/vfx/oscillators.js", import.meta.url), "utf8");
const hits = lintSource(src);
check("★ oscillators.js source is lint-clean (no Math.random / argless Date.now / wire / .visible / per-instance key)",
  hits.length === 0, hits.map((h) => `L${h.lineno}:${h.label}`).join(" | "));

console.log(`\nVFX oscillator registry: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
