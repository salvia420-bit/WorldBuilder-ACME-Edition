// test_diag_spawn_classifier.mjs — `__diag.diff()` spawn classification
// (2026-08-03 review findings F2 + F3, task #147).
//
// F2: a spawn that had been OBSERVED and was still in flight (younger than
//     PENDING_TIMEOUT_MS) fell out of the `if (bestPending)` arm with no
//     `else` and landed on `wire-never-received` — the module reporting
//     failure mode (a) "the server never sent it" for mode (d) "the async
//     chain is still running". That is the exact inversion diag.js exists
//     to prevent, and it fires on every runAll() taken during boot.
// F3: `awaitingWhat` was written once as "init" and never updated by
//     anything in the tree — a __diag field whose producer never runs.
//     Plus `spawns.pending` had no terminal path for _spawnImpl's
//     generation-supplanted bail, so stranded records were reported as a
//     live "spawn-pending" forever.
//
// Run: node test_diag_spawn_classifier.mjs

// Offset clock on top of a REAL monotonic base: several ./diag/ attach
// modules poll with elapsed-time deadlines, and a frozen now() makes them
// spin forever. `clock` is the test's own advance, added on top.
let clock = 1000;
const _realNow = () => Number(process.hrtime.bigint() / 1000000n);
const _base = _realNow();
globalThis.performance = { now: () => (_realNow() - _base) + clock };
globalThis.window = globalThis;

const { installDiag } = await import("./scene3d/diag.js");

let pass = 0, fail = 0;
const check = (name, ok, extra = "") => {
  if (ok) { pass += 1; console.log(`  [OK] ${name}`); }
  else { fail += 1; console.log(`  [FAIL] ${name}${extra ? ` — ${extra}` : ""}`); }
};

const LB = 0xa9b40000;
const WCID = 37518;
const EXPECTED = {
  landblockId: LB,
  npcs: [{ wcid: WCID, name: "Royal Guard", x: 110.5, y: 158.3, z: 66.1 }],
};

function freshDiag() {
  delete globalThis.__diag;
  const d = installDiag();
  d.setExpected(EXPECTED);
  return d;
}

function attempt(d, guid) {
  d.onSpawnAttempted({
    guid, wcid: WCID, name: "Royal Guard",
    landblockId: LB | 0x21, x: 110.5, y: 158.3, z: 66.1,
    setupId: 0x02000001, isLocalPlayer: false,
  });
}

const classOf = (r) => (r.missing[0]?.classification ?? null);

// ── F2: in-flight must NOT read as "the wire never sent it" ────────────────
{
  const d = freshDiag();
  attempt(d, 0x1234);
  clock += 100; // 100 ms after the attempt — well inside the 5 s window
  const r = d.diff(LB);
  check("F2: fresh in-flight spawn is NOT classified wire-never-received",
    classOf(r) !== "wire-never-received",
    `got ${classOf(r)}`);
  check("F2: it is reported as spawn-in-flight",
    r.inFlight.length === 1 && r.inFlight[0].classification === "spawn-in-flight",
    JSON.stringify(r.inFlight));
  check("F2: in-flight does not flip ok/DRIFT (boot timing is not drift)",
    r.ok === true && r.missing.length === 0,
    JSON.stringify({ ok: r.ok, missing: r.missing.length }));
  check("F2: and it is not double-reported as an extra",
    r.extra.length === 0, JSON.stringify(r.extra));
}

// ── the timeout still promotes to spawn-pending ────────────────────────────
{
  const d = freshDiag();
  attempt(d, 0x1234);
  clock += 5001;
  const r = d.diff(LB);
  check("timeout: past PENDING_TIMEOUT_MS it becomes spawn-pending",
    classOf(r) === "spawn-pending", `got ${classOf(r)}`);
  check("timeout: spawn-pending IS drift (ok false)", r.ok === false);
}

// ── a genuinely absent entity still reads wire-never-received ──────────────
{
  const d = freshDiag();
  clock += 100;
  const r = d.diff(LB);
  check("absent: no observation at all still reads wire-never-received",
    classOf(r) === "wire-never-received", `got ${classOf(r)}`);
}

// ── F3: awaitingWhat is honest, and its producer is reachable ──────────────
{
  const d = freshDiag();
  attempt(d, 0x1234);
  clock += 5001;
  const r = d.diff(LB);
  check("F3: unwired stage reports 'unreported', not the fake 'init'",
    r.missing[0].detail.awaitingWhat === "unreported",
    JSON.stringify(r.missing[0].detail));
  check("F3: stageNotesReceived is 0 while nothing calls the hook",
    d.spawns.stageNotesReceived === 0);

  // The seam must actually work when a producer IS wired.
  const ok = d.noteSpawnStage(0x1234, "animation-cache");
  const r2 = d.diff(LB);
  check("F3: noteSpawnStage reaches the pending record",
    ok === true && r2.missing[0].detail.awaitingWhat === "animation-cache",
    JSON.stringify(r2.missing[0].detail));
  check("F3: and the reachability counter moves",
    d.spawns.stageNotesReceived === 1);
  check("F3: noteSpawnStage on an unknown guid is a no-op, not a throw",
    d.noteSpawnStage(0xdead, "x") === false);
}

// ── F3: stranded pending records are reaped to an explicit terminal state ──
{
  const d = freshDiag();
  attempt(d, 0x1234);          // this one is stranded (the :4689 bail)
  clock += 120_001;
  const reaped = d.reapAbandonedSpawns();
  check("F3: an aged-out pending record is reaped", reaped === 1);
  check("F3: pending map is bounded again", d.spawns.pending.size === 0);
  check("F3: and counted as abandoned, not silently dropped",
    d.spawns.abandoned === 1);
  const r = d.diff(LB);
  check("F3: a reaped record no longer reads as a LIVE stuck chain",
    classOf(r) !== "spawn-pending", `got ${classOf(r)}`);
  check("F3: the lb bucket's pending set was cleaned too",
    d.spawns.byLandblock.get(LB).pending.size === 0);
}

// ── the amortised sweep actually runs from the attempt path ────────────────
{
  const d = freshDiag();
  attempt(d, 0x9000);
  clock += 120_001;
  for (let i = 0; i < 64; i++) attempt(d, 0xa000 + i);
  check("F3: the sweep fires from onSpawnAttempted (no manual reap needed)",
    d.spawns.abandoned >= 1, `abandoned=${d.spawns.abandoned}`);
}

console.log("");
console.log(`diag spawn classifier: ${pass} passed, ${fail} failed`);
// Explicit exit: several ./diag/ attach modules install their own
// __pluginClient poll timers at install time and keep the loop alive.
process.exit(fail > 0 ? 1 : 0);
