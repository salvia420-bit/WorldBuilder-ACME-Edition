// C3-wire-send (2026-07-12) — __diag.cast.busyRemainMs() clock-domain test.
//
// Run with:
//   cd apps/holtburger-web/
//   node tests/test_cast_busy_clock.mjs
//
// Regression guard for SLIDECAST report Gap 4: `chain.busyUntilMs` is an
// ABSOLUTE performance.now() timestamp (stamped in entities.js as
// `performance.now() + est`). A consumer that computes `busyUntilMs - Date.now()`
// mixes clock domains — the two clocks share no epoch, so the diff is off by the
// whole Unix epoch and the "remaining" always reads ~0. `busyRemainMs()`
// subtracts the CORRECT clock (performance.now(), via the module's `_now()`),
// so it returns the real remaining time. This test asserts the accessor is
// domain-correct AND demonstrates that the naive Date.now() subtraction is wrong.

import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const modUrl = "file://" + resolvePath(__dirname, "..", "scene3d/diag/cast.js");
const { attachCast } = await import(modUrl);

// Same clock the module uses internally (`_now()` prefers performance.now()).
const _now = () =>
  (typeof performance !== "undefined" && typeof performance.now === "function")
    ? performance.now()
    : Date.now();

let failed = 0, passed = 0;
function check(name, ok, detail) {
  console.log(`  [${ok ? "OK" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
  if (ok) passed += 1; else failed += 1;
}

console.log("===========================================================");
console.log("C3-wire-send — __diag.cast.busyRemainMs() clock-domain test");
console.log("===========================================================");

const diag = {};
attachCast(diag);
const cast = diag.cast;

check("busyRemainMs is a function", typeof cast.busyRemainMs === "function");

const G = 0x50000123;
const WINDOW_MS = 5000;

// Open a live chain with a busy window 5 s into the future, stamped in the
// performance.now() domain — exactly how entities.js sets `_castBusyUntilMs`.
const busyUntil = _now() + WINDOW_MS;
cast.onCastRequested({ guid: G, spellId: 27 });
cast.onChainStart({ guid: G, spellId: 27, token: 1, busyUntilMs: busyUntil, windupCount: 1, hasCast: true });

// The accessor reads the real remaining time (~5 s), within a generous tolerance
// for the few ms of test execution between the two `_now()` reads.
const remain = cast.busyRemainMs(G);
check(
  "busyRemainMs returns the real remaining window (~5 s)",
  remain > WINDOW_MS - 250 && remain <= WINDOW_MS,
  `${remain.toFixed(1)} ms`,
);

// The Gap-4 footgun: the naive cross-domain subtraction is catastrophically
// wrong (off by ~the Unix epoch), which is why it "always read ~0" after a
// downstream max(0, …) clamp. Assert our accessor does NOT reproduce that.
const buggy = busyUntil - Date.now();
check(
  "naive busyUntilMs - Date.now() is wildly off (demonstrates the bug)",
  Math.abs(buggy - WINDOW_MS) > 1e9,
  `${buggy.toFixed(0)} ms`,
);
check(
  "busyRemainMs does NOT reproduce the cross-domain error",
  Math.abs(remain - WINDOW_MS) < 250,
  `${remain.toFixed(1)} ms`,
);

// An elapsed window clamps to 0 (never negative).
cast.onChainStart({ guid: G, spellId: 27, token: 2, busyUntilMs: _now() - 1000, windupCount: 1, hasCast: true });
check("elapsed window clamps to 0", cast.busyRemainMs(G) === 0, `${cast.busyRemainMs(G)}`);

// No busy window set → 0.
const G2 = 0x50000222;
cast.onCastRequested({ guid: G2, spellId: 9 });
cast.onChainStart({ guid: G2, spellId: 9, token: 1, busyUntilMs: null, windupCount: 0, hasCast: true });
check("null busyUntilMs → 0", cast.busyRemainMs(G2) === 0);

// Unknown guid / null guid → 0 (no throw).
check("unknown guid → 0", cast.busyRemainMs(0xDEADBEEF) === 0);
check("null guid → 0", cast.busyRemainMs(null) === 0);
check("undefined guid → 0", cast.busyRemainMs(undefined) === 0);

// ── Summary ──
console.log("");
console.log(`Cases: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
else console.log("All C3-wire-send busy-clock tests PASS.");
