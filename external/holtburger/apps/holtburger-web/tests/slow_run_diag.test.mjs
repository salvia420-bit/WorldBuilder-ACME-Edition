// tests/slow_run_diag.test.mjs — scene3d/diag/slow_run.js, the devtools
// surface over the wasm slow-run detector (holtburger_core::slow_run_diag).
// The wasm exports are faked with the exact JSON shape `read_json` emits.
//
// Run: node tests/slow_run_diag.test.mjs

globalThis.window = globalThis;

const { attachSlowRun, readSlowRunRing, compactIncident, SLOW_RUN_CAUSES } =
  await import("../scene3d/diag/slow_run.js");

let passed = 0;
let failed = 0;
function check(name, ok, detail) {
  console.log(`  [${ok ? "OK" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
  if (ok) passed += 1; else failed += 1;
}

// One incident as `push_incident` writes it (field order and spelling).
function incident(seq, cause, extra = {}) {
  return {
    seq, atMs: 1000 * seq, cause, slowSecs: 0.6,
    expectedMps: 11.3, referenceMps: 11.3, intendedMps: 11.3, leashMps: 8.4, realizedMps: 8.3,
    rateRatio: 1, driveRatio: 1, leashRatio: 0.74, transitionRatio: 0.99,
    serverControlled: false, latchAutonomous: true, interpretedDrive: false,
    pendingMotions: 0, moveToActive: false, projectionActive: false, interpolating: false,
    stickyActive: false, castLockActive: false, forwardKilledByCastLock: false,
    leashArmed: true, leashBudgetM: 17.2, indoor: false, echoAgeS: 1.4, apAgeS: 1.1,
    moveToStateAgeS: 9.0, serverMotionAgeS: null, serverMotionRate: null,
    positionEventReady: true, heartbeatsSent: 42, capabilityRate: 2.83,
    serverRunRate: 2.83, composedRunRate: 2.83,
    held: [1, 0, 0, 1], drive: [1, 0, 0, 1],
    ...extra,
  };
}

let cleared = 0;
let ring = { count: 3, incidents: [incident(1, "leash"), incident(2, "leash"), incident(3, "castForwardLock", { drive: [0, -1, 0, 1], held: [1, -1, 0, 1] })] };
function installWasm() {
  window.__hbWasm = {
    slowRunDiag: () => JSON.stringify(ring),
    slowRunDiagCount: () => ring.count,
    slowRunDiagClear: () => { cleared += 1; ring = { count: 0, incidents: [] }; },
  };
}

// ── absent exports (stale pkg/, pre-boot) ──
{
  delete window.__hbWasm;
  const diag = {};
  attachSlowRun(diag);
  check("attaches the namespace", typeof diag.slowRun === "object");
  check("available() is false without the export", diag.slowRun.available() === false);
  check("count() is null without the export", diag.slowRun.count() === null);
  check("tail() is empty without the export", Array.isArray(diag.slowRun.tail()) && diag.slowRun.tail().length === 0);
  const s = diag.slowRun.summary();
  check("summary() names the missing export", s.available === false && /slowRunDiag/.test(s.error), JSON.stringify(s));
  check("clear() is false without the export", diag.slowRun.clear() === false);
  check("explain() with nothing recorded", diag.slowRun.explain() === "no slow-run incident recorded");
}

// ── the ring ──
{
  installWasm();
  const diag = {};
  attachSlowRun(diag);
  check("available() with the export", diag.slowRun.available() === true);
  check("count() reads the wasm counter", diag.slowRun.count() === 3);
  const tail = diag.slowRun.tail(2);
  check("tail(2) is the last two, oldest first", tail.length === 2 && tail[0].seq === 2 && tail[1].seq === 3, JSON.stringify(tail.map((i) => i.seq)));
  check("tail(0) is empty", diag.slowRun.tail(0).length === 0);
  check("last() is the newest", diag.slowRun.last()?.seq === 3);
  const s = diag.slowRun.summary();
  check("summary counts causes", s.byCause.leash === 2 && s.byCause.castForwardLock === 1, JSON.stringify(s.byCause));
  check("summary count/kept", s.count === 3 && s.kept === 3);
  check("summary.last is compact", s.last.seq === 3 && s.last.ratios.leash === 0.74 && Array.isArray(s.last.drive) && !("heartbeatsSent" in s.last), JSON.stringify(s.last));
  check("explain() names the cause and the fix", /castForwardLock/.test(diag.slowRun.explain()) && /castLockRevive/.test(diag.slowRun.explain()));
  check("explain(incident) for the leash", /ConstraintManager/.test(diag.slowRun.explain(tail[0])));
  check("every cause the Rust side emits has an explanation",
    ["runRate", "serverControl", "castForwardLock", "driveMismatch", "leash", "interpolation", "sticky", "collision", "unknown"]
      .every((c) => typeof SLOW_RUN_CAUSES[c] === "string"));
  check("clear() forwards to the wasm", diag.slowRun.clear() === true && cleared === 1);
  check("after clear the ring is empty", diag.slowRun.count() === 0 && diag.slowRun.tail().length === 0 && diag.slowRun.last() === null);
}

// ── parsing edge cases ──
{
  check("readSlowRunRing: bad JSON is null", readSlowRunRing({ slowRunDiag: () => "{not json" }) === null);
  check("readSlowRunRing: missing incidents is null", readSlowRunRing({ slowRunDiag: () => "{\"count\":1}" }) === null);
  check("readSlowRunRing: throwing export is null", readSlowRunRing({ slowRunDiag: () => { throw new Error("x"); } }) === null);
  check("compactIncident(null) is null", compactIncident(null) === null);
}

console.log(`\nslow_run_diag: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
