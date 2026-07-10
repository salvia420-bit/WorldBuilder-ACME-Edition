// test_stream_bake_guard.mjs — validates the per-LB streaming-bake guard
// that stops a shard-fetch failure from being hammered into an OOM crash
// (the "terrain service worker / promises spam → browser crash" bug).
// Run: node test_stream_bake_guard.mjs   (exits non-zero on failure)
import {
  createStreamGuardState,
  guardedStreamBake,
  summarizeStreamBakeWait,
  STREAM_BAKE_RETRY_COOLDOWN_MS,
} from "./scene3d/stream_bake_guard.js";

let failed = 0;
function ok(cond, msg) {
  if (!cond) {
    failed += 1;
    console.error("  FAIL:", msg);
  } else {
    console.log("  ok:", msg);
  }
}

// A controllable clock so cooldown windows are deterministic.
let clock = 1000;
const now = () => clock;
const silentWarn = () => {};
const opts = () => ({ now, warn: silentWarn });

async function testInFlightDedup() {
  console.log("in-flight dedup: concurrent calls for the same LB run once");
  const state = createStreamGuardState();
  let runs = 0;
  let release;
  const gate = new Promise((r) => (release = r));
  const run = async () => {
    runs += 1;
    await gate; // hold the bake open so both calls overlap
    return { mesh: true };
  };
  const a = guardedStreamBake(state, "terrain", 0xa9b40000, run, opts());
  const b = guardedStreamBake(state, "terrain", 0xa9b40000, run, opts());
  release();
  const [ra, rb] = await Promise.all([a, b]);
  ok(runs === 1, `only one bake executed (got ${runs})`);
  // Exactly one call got the result; the deduped one resolved null.
  const results = [ra, rb].filter((r) => r && r.mesh).length;
  ok(results === 1, `one call got the mesh, the other was deduped (got ${results})`);
}

async function testFailureCooldown() {
  console.log("failure cooldown: a failing LB is not re-run until the window elapses");
  const state = createStreamGuardState();
  let runs = 0;
  const run = async () => {
    runs += 1;
    throw new Error("fetch body read error"); // simulate the shard-fetch failure
  };
  // First attempt runs and fails (resolves null — never rejects).
  const r1 = await guardedStreamBake(state, "terrain", 0xa9b40000, run, opts());
  ok(r1 === null, "failing bake resolves null (does not reject)");
  ok(runs === 1, `first attempt ran (got ${runs})`);

  // Many rapid re-attempts within the cooldown must all be skipped — this
  // is the spam/leak the bug exhibited (one bake per position update).
  let skippedNull = 0;
  for (let i = 0; i < 50; i += 1) {
    clock += 10; // 50 * 10ms = 500ms, still < cooldown
    // eslint-disable-next-line no-await-in-loop
    const r = await guardedStreamBake(state, "terrain", 0xa9b40000, run, opts());
    if (r === null) skippedNull += 1;
  }
  ok(skippedNull === 50, `50 cooldown retries all resolved null (got ${skippedNull})`);
  ok(runs === 1, `50 rapid retries within cooldown were all skipped (runs still ${runs})`);

  // After the cooldown elapses, exactly one retry is allowed.
  clock += STREAM_BAKE_RETRY_COOLDOWN_MS + 1;
  await guardedStreamBake(state, "terrain", 0xa9b40000, run, opts());
  ok(runs === 2, `one retry allowed after cooldown (got ${runs})`);
}

async function testSuccessClearsCooldown() {
  console.log("success clears cooldown");
  const state = createStreamGuardState();
  let mode = "fail";
  let runs = 0;
  const run = async () => {
    runs += 1;
    if (mode === "fail") throw new Error("boom");
    return { mesh: true };
  };
  await guardedStreamBake(state, "terrain", 0x11220000, run, opts()); // fail → cooldown
  ok(runs === 1, "failed once");
  clock += STREAM_BAKE_RETRY_COOLDOWN_MS + 1;
  mode = "ok";
  const r = await guardedStreamBake(state, "terrain", 0x11220000, run, opts()); // succeeds
  ok(r && r.mesh, "retry after cooldown succeeds");
  ok(runs === 2, "ran again after cooldown");
  // A subsequent call (LB now succeeds → not in BakedLbs here, but no cooldown)
  // should run immediately (no stale cooldown left behind).
  await guardedStreamBake(state, "terrain", 0x11220000, run, opts());
  ok(runs === 3, "no stale cooldown after success");
}

async function testKindAndLbIsolation() {
  console.log("kind + lbKey isolation: a failing terrain LB doesn't block buildings / other LBs");
  const state = createStreamGuardState();
  const runs = { terrain: 0, buildings: 0, otherLb: 0 };
  await guardedStreamBake(state, "terrain", 0xa9b40000, async () => { runs.terrain += 1; throw new Error("x"); }, opts());
  // Same LB, different kind — independent guard key, must run.
  await guardedStreamBake(state, "buildings", 0xa9b40000, async () => { runs.buildings += 1; return {}; }, opts());
  // Same kind, different LB — independent, must run.
  await guardedStreamBake(state, "terrain", 0xa9b50000, async () => { runs.otherLb += 1; return {}; }, opts());
  ok(runs.terrain === 1 && runs.buildings === 1 && runs.otherLb === 1,
    `independent guard keys all ran (${JSON.stringify(runs)})`);
}

// Session 7 (1114 §3) — bake-wait instrumentation: skip reasons, urgent
// tracking, pre-admission wait vs in-run duration, cycle restart.
async function testWaitLogInstrumentation() {
  console.log("wait log: skips/urgent/wait/dur recorded; guard semantics untouched");
  const state = createStreamGuardState();
  const lb = 0xa9b40000;

  // Fill the global cap with 6 held non-urgent bakes on other LBs.
  let release;
  const gate = new Promise((r) => (release = r));
  const fillers = [];
  for (let i = 0; i < 6; i += 1) {
    fillers.push(guardedStreamBake(state, "terrain", 0x01000000 + (i << 16), async () => gate, opts()));
  }
  // Non-urgent ask at cap → skipCap; urgent ask → admitted.
  clock += 40;
  await guardedStreamBake(state, "statics", lb, async () => ({}), { ...opts() });
  let s = summarizeStreamBakeWait(state);
  const capRec = s.slowestToStart.concat(s.slowestInRun).length; // settled below
  ok(s.totals.skipCap === 1, `cap skip recorded (skipCap=${s.totals.skipCap})`);
  clock += 60;
  await guardedStreamBake(state, "statics", lb, async () => ({}), { ...opts(), urgent: true });
  s = summarizeStreamBakeWait(state);
  const rec = state.waitLog.get(`statics:${lb}`);
  ok(rec.asks === 2 && rec.urgentAsks === 1, `asks/urgentAsks counted (${rec.asks}/${rec.urgentAsks})`);
  ok(rec.waitMs === 60, `pre-admission wait = firstAsk→start (waitMs=${rec.waitMs})`);
  ok(rec.ok === true && rec.durMs != null, `in-run settle recorded (durMs=${rec.durMs})`);
  ok(rec.inFlightAtStart === 6, `queue depth at admission recorded (${rec.inFlightAtStart})`);
  ok(s.totals.urgentAsks === 1 && s.totals.started >= 1, "summary totals aggregate");
  void capRec;
  release();
  await Promise.all(fillers); // drain the cap-fillers' finally handlers

  // A fresh ask after settle starts a NEW cycle on the same key.
  clock += 10;
  await guardedStreamBake(state, "statics", lb, async () => ({}), opts());
  const rec2 = state.waitLog.get(`statics:${lb}`);
  ok(rec2.cycles === 2 && rec2.asks === 1, `settled key restarts as cycle 2 (cycles=${rec2.cycles})`);

  // In-flight dedup + cooldown skips are attributed.
  let rel2;
  const gate2 = new Promise((r) => (rel2 = r));
  const held = guardedStreamBake(state, "buildings", lb, async () => gate2, opts());
  await guardedStreamBake(state, "buildings", lb, async () => ({}), opts());
  ok(state.waitLog.get(`buildings:${lb}`).skipInFlight === 1, "in-flight skip attributed");
  rel2();
  await held;
  await guardedStreamBake(state, "terrain", 0x0f0f0000, async () => { throw new Error("x"); }, opts());
  // The failed cycle settled (ok=false), so the cooldown-skipped retry
  // rotates onto a cycle-2 record and is attributed there.
  await guardedStreamBake(state, "terrain", 0x0f0f0000, async () => ({}), opts());
  const recF = state.waitLog.get(`terrain:${0x0f0f0000}`);
  ok(recF.cycles === 2 && recF.skipCooldown === 1 && recF.startMs == null,
    `cooldown skip attributed on the retry cycle (cycles=${recF.cycles} skipCooldown=${recF.skipCooldown})`);
}

async function main() {
  await testInFlightDedup();
  await testFailureCooldown();
  await testSuccessClearsCooldown();
  await testKindAndLbIsolation();
  await testWaitLogInstrumentation();
  if (failed > 0) {
    console.error(`\n${failed} assertion(s) FAILED`);
    process.exit(1);
  }
  console.log("\nall stream-bake-guard assertions passed");
}

main().catch((e) => {
  console.error("test threw:", e);
  process.exit(1);
});
