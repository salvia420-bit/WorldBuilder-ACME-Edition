// harness/test_moving_bench_boot.mjs — Tier-1 test for moving-bench's boot
// gate (harness/moving-bench.mjs `classifyBoot` / `formatBootHistory`).
//
// Pure Node. Run: node harness/test_moving_bench_boot.mjs — exit 0/1.
//
// WHY IT EXISTS
// -------------
// The 2026-08-10 MOVE-FIX baseline attempt exited on `[moving-bench]
// BOOT-FAIL` with no reason, and the blame landed on `?renderOnDemand=1`.
// That flag was innocent (the identical URL boots to `ready` in 8.4 s on
// SwiftShader, live-reproduced the same day). The gate itself was the defect:
// it treated the FIRST `__bootState === "error"` as terminal and printed
// nothing. The two real failure shapes it must survive are both encoded here:
//
//   A. stale ACE session — `[character-error] code=0x1 name=Logon` →
//      `connect failed after 1 attempts: timeout`, PRE-in-world, recoverable
//      by re-firing `window.__runAutonomousLogin` after ACE's ~5-10 s
//      character logout. (Reproduced live: two bench arms on one account.)
//   B. post-in-world ready-watchdog — index.html latches `error: in-world
//      reached but scene-ready signal did not fire within 90000ms` on a
//      session that IS in-world, because `ready` and `in-world` share one
//      scalar (index.html :6122-6131). Must NOT abort the run.
//
// Every state name used below is read-verified against index.html's
// setBootState call sites (:6106-6109 sequence, :11589 autoSpawn-target,
// :11644 ready-watchdog, :11656 char-in-world, :11664/:11668 spawn/connect).

import {
  classifyBoot, formatBootHistory, BOOT_TRANSIENT_STATES, splitBootErrors, toResultsV2,
} from "./moving-bench.mjs";

let passed = 0;
let failed = 0;
const ok = (cond, label) => {
  if (cond) { passed++; }
  else { failed++; console.error(`  FAIL ${label}`); }
};

/** Build a snapshot the way `readBootSnapshot` does: history is append-only
 *  and `state` is the LAST entry unless overridden. */
const snap = (states, over = {}) => {
  const history = states.map((s) => (typeof s === "string" ? { state: s, message: "" } : s));
  return {
    state: over.state !== undefined ? over.state : (history.length ? history[history.length - 1].state : null),
    history,
    sceneReadyEverFired: !!over.sceneReadyEverFired,
    inFlight: !!over.inFlight,
  };
};

// ── transient states: keep waiting, never a verdict ────────────────────────
{
  ok(classifyBoot(null).action === "wait", "null snapshot waits (evaluate raced a navigation)");
  ok(classifyBoot(snap([])).action === "wait", "empty page (no state yet) waits");
  for (const s of BOOT_TRANSIENT_STATES) {
    ok(classifyBoot(snap([s])).action === "wait", `transient "${s}" waits`);
  }
  // The full happy sequence, polled at every prefix, must never say fatal.
  const seq = ["form-shown", "connecting", "char-list-ready", "spawning", "in-world", "ready"];
  const actions = seq.map((_, i) => classifyBoot(snap(seq.slice(0, i + 1))).action);
  ok(actions.slice(0, 4).every((a) => a === "wait"), "pre-spawn prefixes all wait");
  ok(actions[4] === "go" && actions[5] === "go", "in-world and ready both go");
  ok(classifyBoot(snap(["form-shown", "reconnecting", "kicking"])).action === "wait", "kick dance waits");
}

// ── B: an `error` AFTER in-world does not revoke the session ───────────────
{
  const readyWatchdog = snap([
    "form-shown", "connecting", "char-list-ready", "spawning", "in-world",
    { state: "error", message: "in-world reached but scene-ready signal did not fire within 90000ms" },
  ]);
  const d = classifyBoot(readyWatchdog);
  ok(d.action === "go", "post-in-world ready-watchdog error does NOT abort (index.html :11644)");
  ok(/later error ignored/.test(d.reason), "the go reason says the later error was ignored");
  // `ready` arriving BEFORE `in-world` (the ?nullRender ordering) then being
  // overwritten: the sticky latch is the only surviving evidence.
  const latched = snap(["form-shown", "connecting"], { state: "error", sceneReadyEverFired: true });
  ok(classifyBoot(latched).action === "go", "__sceneReadyEverFired latch alone is enough to go");
  // Scalar says a transient state but history already saw in-world.
  ok(classifyBoot(snap(["in-world"], { state: "spawning" })).action === "go", "history in-world beats a stale scalar");
}

// ── A: a PRE-in-world error is retried, then reported with its message ─────
{
  const stale = snap([
    "form-shown", "connecting",
    { state: "error", message: "connect failed after 1 attempts: timeout" },
  ]);
  const first = classifyBoot(stale, { attempt: 0, maxAttempts: 2 });
  ok(first.action === "relogin", "stale-session connect timeout triggers a relogin, not an exit");
  ok(first.reason === "connect failed after 1 attempts: timeout", "relogin carries the page's own message");
  ok(classifyBoot(stale, { attempt: 1, maxAttempts: 2 }).action === "relogin", "second attempt still retries");
  const last = classifyBoot(stale, { attempt: 2, maxAttempts: 2 });
  ok(last.action === "fatal", "budget exhausted -> fatal");
  ok(/connect failed after 1 attempts: timeout/.test(last.reason) && /after 2 relogin retries/.test(last.reason),
    "fatal reason names BOTH the page message and the retries spent");
  // --loginRetries=0 restores the historical exit-on-first-error behaviour.
  ok(classifyBoot(stale, { attempt: 0, maxAttempts: 0 }).action === "fatal", "maxAttempts=0 = legacy behaviour");
  // An error while the orchestrator has not yet released its claim is a poll
  // artefact, not a verdict (the release is in a `finally`).
  const midFlight = snap(["form-shown", "connecting", { state: "error", message: "spawn: timeout" }], { inFlight: true });
  ok(classifyBoot(midFlight).action === "wait", "error while a login run is in flight waits for the claim to settle");
  // The other two real pre-in-world errors index.html can emit.
  for (const msg of ['autoSpawn target "first" not found (have: )', "spawn: char-in-world"]) {
    const d = classifyBoot(snap(["form-shown", "connecting", "char-list-ready", { state: "error", message: msg }]),
      { attempt: 0, maxAttempts: 2 });
    ok(d.action === "relogin" && d.reason === msg, `pre-in-world error retried with its message: ${msg.slice(0, 28)}`);
  }
  // A message-less error still fails loudly rather than silently.
  const bare = classifyBoot(snap([{ state: "error", message: "" }]), { attempt: 2, maxAttempts: 2 });
  ok(bare.action === "fatal" && /no message recorded/.test(bare.reason), "message-less error still names itself");
}

// ── unknown future state: wait (the deadline still ends the run) ───────────
{
  const d = classifyBoot(snap(["form-shown", "teleporting"]));
  ok(d.action === "wait" && /unrecognised/.test(d.reason), "an unknown state waits and says so");
}

// ── the history dump every failure prints ──────────────────────────────────
{
  const text = formatBootHistory(snap([
    "form-shown",
    { state: "connecting", message: "127.0.0.1:9000 as agentp07" },
    { state: "error", message: "connect failed after 1 attempts: timeout" },
  ]));
  ok(text.split("\n").length === 3, "one line per state");
  ok(/connecting: 127\.0\.0\.1:9000 as agentp07/.test(text), "messages are carried into the dump");
  ok(/no boot-state history/.test(formatBootHistory(snap([]))), "empty history says so instead of printing nothing");
  ok(/no snapshot/.test(formatBootHistory(null)), "null snapshot dump is safe");
}

// ── a recovered boot must not reject its own run ───────────────────────────
{
  // Live-observed shape (2026-08-10, run 2): the refused first connect logs
  // `start_session: no CharacterList within 30s`, the gate relogs in, the lap
  // runs clean. judge() counts errors, so that one line used to be enough to
  // turn a healthy run into REJECT.
  const all = ["start_session failed: … no CharacterList within 30s", "WebGL: minor", "late lap error"];
  const s = splitBootErrors(all, 1);
  ok(s.bootErrors.length === 1 && s.bootErrors[0].startsWith("start_session"), "login-phase error partitioned out");
  ok(s.runErrors.length === 2 && s.runErrors[0] === "WebGL: minor", "settle + lap errors stay judged");
  ok(splitBootErrors(all, 0).runErrors.length === 3, "cut 0 (clean boot) judges everything, as before");
  ok(splitBootErrors(all, 99).runErrors.length === 0, "cut past the end is clamped, not thrown");
  ok(splitBootErrors(null, 2).bootErrors.length === 0, "null log is safe");

  // And the provenance rides into the RESULTS-v2 arm.
  const rep = {
    ts: "2026-08-10T00:00:00.000Z", arm: "(default)", url: "http://127.0.0.1:8765/x?nosw=1",
    verdict: "USABLE", rejectReasons: [], spec: { mode: "orbit" },
    pathChecksum: "aa", realisedChecksum: "aa",
    frames: { requested: 4, measured: 4, warm: 4 }, missedGauge: 0,
    rafMs: { n: 4, p50: 8462.8 }, cpuMs: { n: 4, p50: 2351.7 },
    workload: { draws: { n: 4, p50: 128 }, ktris: { n: 4, p50: 19.23 }, residentInstances: 0, batchedMeshes: 1, staticBatchC: 0 },
    lb: { churnFrames: 0 }, walkDelta: null, errors: [],
    reloginAttempts: 1, bootErrors: s.bootErrors,
  };
  const v2 = toResultsV2(rep, {});
  ok(v2.arms[0].reloginAttempts === 1, "relogin count recorded in RESULTS-v2");
  ok(v2.arms[0].bootErrors.length === 1, "login-phase errors recorded in RESULTS-v2 (reported, not judged)");
  ok(v2.arms[0].errors.length === 0 && v2.arms[0].verdict === "USABLE", "a recovered boot leaves the arm USABLE");
}

console.log(`moving-bench-boot: ${passed} passed, ${failed} failed`);
if (failed === 0) {
  console.log("MOVING-BENCH-BOOT ✅");
  process.exit(0);
} else {
  console.error("MOVING-BENCH-BOOT ❌");
  process.exit(1);
}
