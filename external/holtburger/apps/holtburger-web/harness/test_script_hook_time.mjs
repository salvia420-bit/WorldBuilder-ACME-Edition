// SCRIPTMGR-RATE (2026-08-11) — `?scriptHookTime` headless test.
//
// The defect (batch-D PORTAL-SWIRL-RENDER `notes`, last bullet): a portal's
// per-guid `ScriptManager` was seen at `scriptsCompleted ~7,000` in a ~400 s
// session — ~17 Hz where the 0x330006DA sound self-loop should run ONE
// iteration per 2.7 s.
//
// The cause is a FIELD-NAME GAP across the A11-S1 seam, not a clock or a
// scheduling policy:
//   * `entities.js#_decodePhysicsScriptHookEntry` emits the `AnimationHookJs`
//     shape `_fireHook` consumes, whose hook-offset field is named `time`.
//   * `script_manager.js` keys its ENTIRE schedule off `entry.startTime`
//     (:134 sort, :140 `length`, :183 `_armNextHook`).
// `+undefined || 0` ⇒ 0, so on the queue path every script's derived `length`
// collapsed to 0 and every hook armed at `script.startTime + 0`. A 0x33 chain
// fired ALL its hooks in the first `update()` that reached it and a CallPES
// self-loop re-armed with zero delay — exactly ONE loop iteration PER FRAME,
// so `scriptsCompleted` tracked the FRAME RATE.
//
// This suite runs the SHIPPED decoder — it lifts `_decodePhysicsScriptHookEntry`
// and the `SCRIPT_HOOK_TIME_ON` reader out of `scene3d/entities.js` by text and
// evaluates them standalone (the method closes over neither `this` nor any
// import) — against REAL retail hook bytes read out of
// `~/ac_base_dats/client_portal.dat` this session, and drives the REAL
// `scene3d/script_manager.js` on a fake clock. Both flag arms are exercised:
// ON asserts retail cadence, OFF pins the pre-fix arithmetic as the regression
// case (frame-rate-locked, 7,000 completions at 17.5 fps × 400 s).
//
// Run with:
//   cd apps/holtburger-web/
//   node harness/test_script_hook_time.mjs

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ScriptManager } from "../scene3d/script_manager.js";
import { setCurrentTime, setRng } from "../scene3d/particles/time_rng.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, "..");

let failed = 0;
let passed = 0;
function check(name, ok, detail) {
  const status = ok ? "OK" : "FAIL";
  console.log(`  [${status}] ${name}${detail ? " — " + detail : ""}`);
  if (ok) passed += 1;
  else failed += 1;
}

const ENTITIES_SRC = readFileSync(join(APP, "scene3d", "entities.js"), "utf8");

// ---- 0. lift the shipped code -------------------------------------------
// Balanced-brace slice starting at `needle`'s first `{`. Deliberately dumb:
// the two regions we lift contain no braces inside strings/regexes/comments,
// and a mis-slice fails loudly at `new Function` rather than silently.
function sliceBraced(src, needle) {
  const at = src.indexOf(needle);
  if (at === -1) throw new Error(`anchor not found in entities.js: ${needle}`);
  const open = src.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") {
      depth -= 1;
      if (depth === 0) return { body: src.slice(open + 1, i), start: at, end: i };
    }
  }
  throw new Error(`unbalanced braces after: ${needle}`);
}

/** The shipped `_decodePhysicsScriptHookEntry`, as a standalone function. */
function liftDecoder(flagValue) {
  const { body } = sliceBraced(ENTITIES_SRC, "_decodePhysicsScriptHookEntry(e) {");
  // eslint-disable-next-line no-new-func
  const fn = new Function("SCRIPT_HOOK_TIME_ON", "e", body);
  return (e) => fn(flagValue, e);
}

/** The shipped `SCRIPT_HOOK_TIME_ON` reader, evaluated against a fake URL. */
function liftFlagReader(search) {
  const at = ENTITIES_SRC.indexOf("const SCRIPT_HOOK_TIME_ON = ");
  if (at === -1) throw new Error("SCRIPT_HOOK_TIME_ON reader not found");
  const expr = ENTITIES_SRC.slice(at + "const SCRIPT_HOOK_TIME_ON = ".length);
  const { end } = sliceBraced(expr, "(() =>");
  // `...}\n)()` — take through the closing `)` of the IIFE call.
  const call = expr.slice(0, expr.indexOf(")", expr.indexOf("(", end)) + 1);
  // eslint-disable-next-line no-new-func
  return new Function("window", "URLSearchParams", `return ${call};`)(
    { location: { search } },
    URLSearchParams,
  );
}

check("lift: decoder extracted from scene3d/entities.js",
  typeof liftDecoder(true) === "function");

// ---- 1. flag reader (I7 shape: DEFAULT-ON, `=off` escape) ----------------
{
  check("flag: absent ⇒ ON (bare URL is the fixed arm)", liftFlagReader("") === true);
  check("flag: ?scriptHookTime=off ⇒ OFF", liftFlagReader("?scriptHookTime=off") === false);
  check("flag: ?scriptHookTime=OFF is case-insensitive",
    liftFlagReader("?scriptHookTime=OFF") === false);
  check("flag: ?scriptHookTime=on ⇒ ON", liftFlagReader("?scriptHookTime=on") === true);
  check("flag: an unrelated param leaves it ON",
    liftFlagReader("?scriptQueue=on") === true);
}

// ---- 2. fixtures: REAL retail bytes --------------------------------------
// Parsed this session straight out of `~/ac_base_dats/client_portal.dat`
// (btree walk; `[u32 id][u32 count][{f64 start_time, u32 hook_type, i32
// direction, payload}]`, payload length per hook_type from
// crates/holtburger-dat/src/file_type/setup_model.rs:72-116). Field shape
// mirrors the wasm `PhysicsScriptEntryJs` the walker drains via `takeEntries()`.
//
// 0x3300067A = Setup 0x020001B3 `default_script` (the Yaraq / town portal):
//   CreateParticle 0x320002CD @0, CreateParticle 0x320002D6 @0,
//   SoundTweaked 0x0A00038E @0, CallPES → 0x330006DA @2.7 pause=0.0
const SCRIPT_0x67A = [
  { startTime: 0.0, hookType: 13, direction: 0, hookData: new Uint8Array([0xcd, 0x02, 0x00, 0x32, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x9a, 0x99, 0x19, 0x3e, 0x00, 0x00, 0x80, 0x3f, 0x00, 0x00, 0x00, 0x80, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]) },
  { startTime: 0.0, hookType: 13, direction: 0, hookData: new Uint8Array([0xd6, 0x02, 0x00, 0x32, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x9a, 0x99, 0x19, 0x3e, 0x00, 0x00, 0x80, 0x3f, 0x00, 0x00, 0x00, 0x80, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]) },
  { startTime: 0.0, hookType: 21, direction: 0, hookData: new Uint8Array([0x8e, 0x03, 0x00, 0x0a, 0x00, 0x00, 0x80, 0x3f, 0x00, 0x00, 0x00, 0x00, 0xcd, 0xcc, 0x4c, 0x3d]) },
  { startTime: 2.700000047683716, hookType: 19, direction: 0, hookData: new Uint8Array([0xda, 0x06, 0x00, 0x33, 0x00, 0x00, 0x00, 0x00]) },
];
// 0x330006DA = the sound-only SELF-loop the parent tail-calls:
//   SoundTweaked 0x0A00038E @0, CallPES → 0x330006DA (itself) @2.7 pause=0.0
const SCRIPT_0x6DA = [
  { startTime: 0.0, hookType: 21, direction: 0, hookData: new Uint8Array([0x8e, 0x03, 0x00, 0x0a, 0x00, 0x00, 0x80, 0x3f, 0x00, 0x00, 0x00, 0x00, 0xcd, 0xcc, 0x4c, 0x3d]) },
  { startTime: 2.700000047683716, hookType: 19, direction: 0, hookData: new Uint8Array([0xda, 0x06, 0x00, 0x33, 0x00, 0x00, 0x00, 0x00]) },
];
const LOOP_PERIOD = 2.700000047683716;

// ---- 3. the decoder itself ----------------------------------------------
{
  const on = liftDecoder(true);
  const off = liftDecoder(false);
  const callPesOn = on(SCRIPT_0x67A[3]);
  const callPesOff = off(SCRIPT_0x67A[3]);

  check("decode: ON carries `startTime` (the ScriptManager schedule key)",
    callPesOn.startTime === LOOP_PERIOD, `got ${callPesOn.startTime}`);
  check("decode: OFF omits `startTime` (legacy arm, collapsed to 0 downstream)",
    callPesOff.startTime === undefined);
  check("decode: `time` is emitted on BOTH arms (`_fireHook` unaffected)",
    callPesOn.time === LOOP_PERIOD && callPesOff.time === LOOP_PERIOD);
  check("decode: startTime === time (one source, no second parse)",
    callPesOn.startTime === callPesOn.time);
  check("decode: CallPES payload unchanged by the flag",
    callPesOn.callPesDid === 0x330006da && callPesOff.callPesDid === 0x330006da &&
    callPesOn.callPesPause === 0 && callPesOff.callPesPause === 0,
    `did=0x${callPesOn.callPesDid.toString(16)} pause=${callPesOn.callPesPause}`);
  check("decode: A11-S1 direction fixup survives (forced 0, A-DIR gate bypass)",
    callPesOn.direction === 0 && callPesOff.direction === 0);
  const st = on(SCRIPT_0x67A[2]);
  check("decode: SoundTweaked retail float order intact (prob@4, vol@12)",
    st.soundWaveId === 0x0a00038e && st.soundProbability === 1 &&
    Math.abs(st.soundVolume - 0.05) < 1e-6,
    `wave=0x${st.soundWaveId.toString(16)} prob=${st.soundProbability} vol=${st.soundVolume}`);
  check("decode: t=0 hook still decodes startTime 0 (not dropped by `|| 0`)",
    on(SCRIPT_0x67A[0]).startTime === 0);
  const cp = on(SCRIPT_0x67A[0]);
  check("decode: CreateParticle payload unchanged by the flag",
    cp.emitterInfoId === 0x320002cd && off(SCRIPT_0x67A[0]).emitterInfoId === 0x320002cd);
}

// ---- 4. the runtime arithmetic ------------------------------------------
// Models `_queuePhysicsScript` + `_executeScriptHook`'s CallPES arm around the
// REAL `ScriptManager`, on a fixed-step fake clock:
//   * queue path: `mgr.addScript(did, entries.map(decode), {now: startNow})`
//     (entities.js:13769-13781), `startNow` undefined for the top-level attach.
//   * CallPES arm: `subStart = currentTime() + (pause < 0.0002 ? 0 : rng()*pause)`
//     then an ASYNC `fetchPhysicsScript(...).then(...)` re-queue
//     (entities.js:13846-13857) — modelled as a microtask drained after each
//     `update()`, which is when a resolved-promise `.then` runs in the browser.
//   * tick: `if (mgr.active) mgr.update()` once per frame (entities.js:15216).
function runSession({ decode, fps, seconds }) {
  let clock = 1000.0;
  setCurrentTime(() => clock);
  setRng(() => 0.5);
  const mgr = new ScriptManager({ owner: 0x77d6406a });
  const microtasks = [];
  const soundFires = [];
  const queue = (entries, startNow) =>
    mgr.addScript(0x330006da, entries.map(decode),
      typeof startNow === "number" ? { now: startNow } : undefined);
  mgr.setExecutor((hook) => {
    if ((hook.hookType | 0) === 21) { soundFires.push(clock); return; }
    if ((hook.hookType | 0) !== 19) return;
    const pauseW = +hook.callPesPause || 0;
    const randPause = pauseW < 0.0002 ? 0 : 0.5 * pauseW; // rng() pinned to 0.5
    const subStart = clock + randPause;
    microtasks.push(() => queue(SCRIPT_0x6DA, subStart));
  });
  queue(SCRIPT_0x67A); // top-level attach (startNow undefined)
  const frames = Math.round(seconds * fps);
  for (let f = 0; f < frames; f++) {
    clock += 1 / fps;
    if (mgr.active) mgr.update();
    while (microtasks.length) microtasks.shift()();
  }
  setCurrentTime(null);
  setRng(null);
  return { completed: mgr.scriptsCompleted, hooks: mgr.hooksFired, frames, soundFires };
}

// --- 4a. the ON arm: retail cadence.
// The realised period is 2.7 s ROUNDED UP TO A FRAME: `update()` fires the
// CallPES at the first tick at/or/after `next_hook_time`, and the sub-script
// anchors its own t=0 on that fire time (`subStart = currentTime()`), so up to
// one frame of quantisation is carried into the next iteration instead of
// being absorbed. Retail quantises identically — `UpdateScripts` compares
// against `Timer::cur_time` on the physics tick and `AddScriptInternal` seeds a
// fresh chain from that same `Timer::cur_time` (acclient.c:329089-329093,
// :329195) — so this is parity, not drift we introduced. The band below is the
// exact consequence; it tightens toward 400/2.7 as fps rises, which is asserted.
for (const fps of [17.5, 60, 240]) {
  const r = runSession({ decode: liftDecoder(true), fps, seconds: 400 });
  const hi = 400 / LOOP_PERIOD;                 // 148.1 — the un-quantised ideal
  const lo = 400 / (LOOP_PERIOD + 1 / fps);     // worst case: a full frame lost
  check(`cadence@${fps}fps: scriptsCompleted inside the frame-quantised band`,
    r.completed >= Math.floor(lo) - 1 && r.completed <= Math.ceil(hi),
    `got ${r.completed}, band [${lo.toFixed(1)}, ${hi.toFixed(1)}]`);
  check(`cadence@${fps}fps: rate is CLOCK-bound, not frame-bound`,
    r.completed < r.frames / 10, `completed=${r.completed} frames=${r.frames}`);
}
{
  // The card's acceptance is "N seconds → scriptsCompleted ≈ N/2.7 ± 1". The
  // MEAN REALISED PERIOD is that statement's exact form — the integer count
  // additionally truncates the iteration still in flight at session end, so at
  // 240 fps it reads 147 against an ideal 148.1 (deficit = 147 quantisation
  // steps ≈ 0.6 s, plus the truncated tail). Assert the period directly, and
  // the count with the ≤2 bound that truncation actually implies.
  const fineRun = runSession({ decode: liftDecoder(true), fps: 240, seconds: 400 });
  const fineGaps = fineRun.soundFires.slice(1).map((t, i) => t - fineRun.soundFires[i]);
  const meanPeriod = fineGaps.reduce((a, b) => a + b, 0) / fineGaps.length;
  check("cadence: mean realised loop period === 2.7 s ± 1 frame @240fps",
    Math.abs(meanPeriod - LOOP_PERIOD) <= 1 / 240 + 1e-9,
    `mean=${meanPeriod.toFixed(5)}s over ${fineGaps.length} iterations`);
  check("cadence: scriptsCompleted within 2 of 400/2.7 (tail truncation)",
    Math.abs(fineRun.completed - 400 / LOOP_PERIOD) <= 2,
    `got ${fineRun.completed}, ideal ${(400 / LOOP_PERIOD).toFixed(1)}`);
  const fine = fineRun.completed;
  void fine;
  // Cadence is set by the CLOCK, not the frame rate — the property the defect
  // inverted (=off, below, gives exactly `frames`). Across a 13.7x fps range
  // the count moves by ~2 iterations in 400 s, and only upward.
  const a = runSession({ decode: liftDecoder(true), fps: 17.5, seconds: 400 }).completed;
  const b = runSession({ decode: liftDecoder(true), fps: 240, seconds: 400 }).completed;
  check("cadence: 17.5 fps and 240 fps agree within 3 iterations over 400 s",
    Math.abs(a - b) <= 3, `17.5fps=${a} 240fps=${b}`);
  check("cadence: a higher frame rate converges UP toward 400/2.7",
    b >= a && b <= Math.ceil(400 / LOOP_PERIOD), `${a} → ${b}`);
  // Consecutive SoundTweaked fires are one loop period apart (± a frame).
  const s = runSession({ decode: liftDecoder(true), fps: 60, seconds: 60 }).soundFires;
  const gaps = s.slice(1).map((t, i) => t - s[i]);
  const worst = Math.max(...gaps.map((g) => Math.abs(g - LOOP_PERIOD)));
  check("cadence: the loop's SoundTweaked replays every 2.7 s (± 1 frame)",
    gaps.length > 15 && worst <= 1 / 60 + 1e-9,
    `n=${gaps.length} worst drift=${worst.toFixed(5)}s`);
}

// --- 4b. the OFF arm: the pre-fix defect, pinned as the regression case.
{
  const r = runSession({ decode: liftDecoder(false), fps: 17.5, seconds: 400 });
  check("REGRESSION (=off): scriptsCompleted === frame count (one loop per frame)",
    r.completed === r.frames, `completed=${r.completed} frames=${r.frames}`);
  check("REGRESSION (=off): 400 s at 17.5 fps reproduces the observed ~7,000",
    r.completed === 7000, `got ${r.completed}`);
  const r60 = runSession({ decode: liftDecoder(false), fps: 60, seconds: 400 });
  check("REGRESSION (=off): the rate follows the FRAME RATE (60 fps ⇒ 24,000)",
    r60.completed === 24000, `got ${r60.completed}`);
  check("REGRESSION (=off): the loop's SoundTweaked replays ~17x/s",
    Math.abs(r.soundFires.length / 400 - 17.5) < 0.5,
    `${(r.soundFires.length / 400).toFixed(1)} Hz`);
}

// ---- 5. `length` is the retail value, not an approximation ---------------
// Retail `PhysicsScript::UnPack` (acclient.c:336452-336528) qsorts `script_data`
// then copies the LAST entry's `start_time` into `PhysicsScript::length` (the
// two dwords at `v4+18`/`v4+19`, immediately past `num_in_array`) — so retail's
// own `length` IS max(start_time), which is what `addScript` derives. The
// back-to-back chain (`AddScriptInternal`, acclient.c:329093-329096) is
// therefore exact, no wasm getter needed.
{
  const on = liftDecoder(true);
  let clock = 500.0;
  setCurrentTime(() => clock);
  const mgr = new ScriptManager({ owner: 1, executeHook: () => {} });
  const a = mgr.addScript(0x3300067a, SCRIPT_0x67A.map(on), { now: 500.0 });
  const b = mgr.addScript(0x330006da, SCRIPT_0x6DA.map(on));
  check("length: derived length === retail max(start_time) === 2.7",
    a.length === LOOP_PERIOD, `got ${a.length}`);
  check("length: a queued script chains at prev.start + prev.length",
    b.startTime === 500.0 + LOOP_PERIOD, `got ${b.startTime}`);
  const off = liftDecoder(false);
  const mgr2 = new ScriptManager({ owner: 2, executeHook: () => {} });
  const a2 = mgr2.addScript(0x3300067a, SCRIPT_0x67A.map(off), { now: 500.0 });
  const b2 = mgr2.addScript(0x330006da, SCRIPT_0x6DA.map(off));
  check("REGRESSION (=off): length collapses to 0",
    a2.length === 0, `got ${a2.length}`);
  check("REGRESSION (=off): back-to-back chaining collapses onto prev.start",
    b2.startTime === 500.0, `got ${b2.startTime}`);
  setCurrentTime(null);
}

// ---- 6. hook ORDERING within a script is preserved -----------------------
// The swirl must still be created at attach, not 2.7 s later: the two
// CreateParticle hooks and the SoundTweaked all sit at t=0 and only the CallPES
// tail moves. (This is the PORTAL-SWIRL-RENDER guarantee — the fix must not
// re-break the visual that lane just restored.)
{
  const on = liftDecoder(true);
  let clock = 900.0;
  setCurrentTime(() => clock);
  const fired = [];
  const mgr = new ScriptManager({
    owner: 3,
    executeHook: (h) => fired.push({ type: h.hookType, at: clock, emitter: h.emitterInfoId }),
  });
  mgr.addScript(0x3300067a, SCRIPT_0x67A.map(on), { now: 900.0 });
  clock = 900.0;
  mgr.update();
  check("ordering: all three t=0 hooks fire in the FIRST tick",
    fired.length === 3 && fired.every((f) => f.at === 900.0), `n=${fired.length}`);
  check("ordering: the swirl emitter 0x320002CD is created at attach",
    fired[0].type === 13 && fired[0].emitter === 0x320002cd);
  check("ordering: its inert sibling 0x320002D6 still follows it (DAT order)",
    fired[1].type === 13 && fired[1].emitter === 0x320002d6);
  check("ordering: SoundTweaked is third", fired[2].type === 21);
  clock = 900.0 + LOOP_PERIOD - 0.001;
  mgr.update();
  check("ordering: CallPES has NOT fired 1 ms early", fired.length === 3);
  clock = 900.0 + LOOP_PERIOD;
  mgr.update();
  check("ordering: CallPES fires at exactly +2.7 s",
    fired.length === 4 && fired[3].type === 19);
  check("ordering: the script completes on its last hook", mgr.scriptsCompleted === 1);
  setCurrentTime(null);
}

// ---- 7. the OFF arm is the byte-identical legacy path --------------------
{
  const off = liftDecoder(false);
  const on = liftDecoder(true);
  for (const e of [...SCRIPT_0x67A, ...SCRIPT_0x6DA]) {
    const a = on(e);
    const b = off(e);
    delete a.startTime;
    check(`legacy-identity: hookType ${e.hookType} decode identical ex startTime`,
      JSON.stringify(a) === JSON.stringify(b));
  }
}

console.log(`\n[test_script_hook_time] ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
