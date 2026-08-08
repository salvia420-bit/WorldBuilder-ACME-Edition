// 2026-08-08 — `?xu7Budget`, the per-frame ms cap over the XUBC7 transcode FIFO.
//
// THE BUG THIS PINS. `transcodeXu7` transcoded on the calling thread with no
// yield and no budget, and its one caller (`Bc7RecordSource._begin`) issues N
// sibling `getAsync`es per landblock crossing whose payloads settle in the SAME
// microtask drain — so N transcodes ran back-to-back in ONE task. Per-record
// cost is bounded (~32 ms per 1024²); per-TASK cost was bounded only by how many
// surfaces a crossing asked for. See the tombstone atop `scene3d/xu7_textures.js`.
//
// WHAT MUST HOLD — all of it is about TASK SHAPE, not total ms. The fix does not
// make a decode cheaper and this suite must never assert that it does.
//   PART 1 — flag grammar. Absent ⇒ ON; only an explicit off-form disarms; a
//            typo must never silently uncap the queue. `?xu7BudgetMs` clamps.
//   PART 2 — DISARMED is the old behaviour exactly: straight through, no queue.
//   PART 3 — ARMED, over-budget items: a drain runs ONE and defers the rest.
//            This is the pile-up removal and the only claim the change earns.
//   PART 4 — ARMED, cheap items: they pack into one drain, so the cap is a TIME
//            budget and not a disguised one-item-per-frame limit.
//   PART 5 — the resolved value is byte-identical armed vs disarmed.
//   PART 6 — failure and reset paths still SETTLE. A never-settling promise
//            would wedge `Bc7RecordSource._inflightP` forever, which is a worse
//            bug than the hitch.
//
// No corpus fixture and no wasm: the KTX2File surface `_transcodeNow` touches is
// small and fully specified, so a fake module exercises the scheduler honestly
// while letting the suite run anywhere. The REAL transcoder against a REAL
// corpus payload is `test_xu7_transcode.mjs`, which still owns that half.
//
// Run:
//   cd apps/holtburger-web/
//   node test_xu7_budget.mjs

import {
  transcodeXu7,
  xu7BudgetEnabled,
  xu7Stats,
  xu7Transcoder,
  _setXu7ModuleForTest,
  _resetXu7ForTest,
  _drainXu7QueueForTest,
  _xu7QueueDepthForTest,
} from "./scene3d/xu7_textures.js";
import { bc7LevelBytes } from "./scene3d/bc7_textures.js";

let failed = 0;
let passed = 0;
function check(name, ok, detail) {
  console.log(`  [${ok ? "OK" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
  ok ? passed++ : failed++;
}

const _now = () => performance.now();

/** Burn `ms` of wall clock the way a transcode does: synchronously, on this
 *  thread. A `setTimeout` would not test the budget — the budget exists to
 *  bound SYNCHRONOUS work inside one task. */
function spin(ms) {
  if (ms <= 0) return;
  const end = _now() + ms;
  // eslint-disable-next-line no-empty
  while (_now() < end) {}
}

const DIM = 64; // one 64x64 level = 16x16 blocks x 16 B = 4096 B

/** A KTX2File-shaped fake with a controllable synchronous cost. `valid=false`
 *  reproduces the malformed-payload path. */
function fakeModule(costMs, { valid = true, fill = 0xab } = {}) {
  return {
    transcoder_texture_format: { cTFBC7_RGBA: { value: 7 } },
    initializeBasis() {},
    KTX2File: class {
      constructor(bytes) {
        this.bytes = bytes;
      }
      isValid() {
        return valid;
      }
      getWidth() {
        return DIM;
      }
      getHeight() {
        return DIM;
      }
      getLevels() {
        return 1;
      }
      startTranscoding() {
        return true;
      }
      getImageTranscodedSizeInBytes() {
        return bc7LevelBytes(DIM, DIM);
      }
      transcodeImage(dst) {
        spin(costMs);
        dst.fill(fill);
        return true;
      }
      close() {}
      delete() {}
    },
  };
}

/** Flush the microtask queue WITHOUT letting any macrotask (the scheduler's own
 *  `setTimeout` drain) run. That separation is what makes the drain counts in
 *  PART 3/4 deterministic — `await` on an already-resolved promise is a
 *  microtask, `setTimeout(0)` is not. */
async function flushMicrotasks(n = 8) {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

const PAYLOAD = new Uint8Array(64).fill(1);

function withSearch(search) {
  globalThis.window = { location: { search } };
}
function noWindow() {
  delete globalThis.window;
}

/** Arm the module with a fake and clear all state. Returns once the transcoder
 *  memo is resolved, so `transcodeXu7` reaches its enqueue in one microtask. */
async function arm(costMs, opts) {
  _resetXu7ForTest();
  _setXu7ModuleForTest(fakeModule(costMs, opts));
  await xu7Transcoder();
}

async function run() {
  // ---------------------------------------------------------------- PART 1 --
  console.log("PART 1 — flag grammar");
  check("absent ⇒ ON (default-ON, budgeted)", xu7BudgetEnabled("") === true);
  check("unrelated query ⇒ ON", xu7BudgetEnabled("?other=1") === true);
  check("=off disarms", xu7BudgetEnabled("?xu7Budget=off") === false);
  check("=0 disarms", xu7BudgetEnabled("?xu7Budget=0") === false);
  check("=false disarms", xu7BudgetEnabled("?xu7Budget=false") === false);
  check("=no disarms", xu7BudgetEnabled("?xu7Budget=no") === false);
  check("=OFF is case-insensitive", xu7BudgetEnabled("?xu7Budget=OFF") === false);
  check("=on stays ON", xu7BudgetEnabled("?xu7Budget=on") === true);
  // A typo must not uncap the queue — the `!== "off"` footgun, the other way up.
  check("a typo (=offf) stays ON", xu7BudgetEnabled("?xu7Budget=offf") === true);

  withSearch("");
  check("default cap is the house 6 ms", xu7Stats().budgetMs === 6);
  withSearch("?xu7BudgetMs=20");
  check("?xu7BudgetMs overrides", xu7Stats().budgetMs === 20);
  withSearch("?xu7BudgetMs=0");
  check("?xu7BudgetMs=0 clamps up to 0.5 (never a zero budget)", xu7Stats().budgetMs === 0.5);
  withSearch("?xu7BudgetMs=nonsense");
  check("garbage ⇒ the default, not NaN", xu7Stats().budgetMs === 6);
  withSearch("?xu7BudgetMs=99999");
  check("absurd values clamp to 1000", xu7Stats().budgetMs === 1000);
  noWindow();

  // ---------------------------------------------------------------- PART 2 --
  console.log("PART 2 — disarmed is the pre-fix behaviour, exactly");
  withSearch("?xu7Budget=off");
  await arm(0);
  const off = [];
  for (let i = 0; i < 5; i++) off.push(transcodeXu7(PAYLOAD));
  await flushMicrotasks();
  check("nothing is queued when disarmed", _xu7QueueDepthForTest() === 0);
  const offOut = await Promise.all(off);
  check("all five resolve", offOut.every((p) => p && p.width === DIM));
  check("no drains ran", xu7Stats().drains === 0, `drains=${xu7Stats().drains}`);
  check("decodes still tallied", xu7Stats().decodes === 5);
  check("queued stays 0", xu7Stats().queued === 0);
  // THE PILE-UP, MEASURED ON THE ARM THAT HAS NO DRAINS. Five `transcodeXu7`
  // calls whose module promise is already resolved settle in the same microtask
  // drain, exactly like five sibling `getAsync`es after a landblock crossing —
  // so all five run back-to-back with nothing between them. This is the shape
  // the whole change exists to remove, and `maxRun` is the only counter that
  // can see it here (`drains`/`maxBatch` are structurally 0 on this arm).
  check("maxRun sees all five as ONE unbroken run", xu7Stats().maxRun === 5, `maxRun=${xu7Stats().maxRun}`);
  check("...i.e. a single run", xu7Stats().runs === 1, `runs=${xu7Stats().runs}`);

  // ---------------------------------------------------------------- PART 3 --
  // THE CORE ASSERTION. Five items at 12 ms each against a 6 ms cap: pre-fix
  // this was one 60 ms task, and there is no arrangement of a 6 ms budget that
  // lets a drain start a second 12 ms item.
  console.log("PART 3 — armed, over-budget items split across drains");
  withSearch("?xu7BudgetMs=6");
  await arm(12);
  const armed = [];
  for (let i = 0; i < 5; i++) armed.push(transcodeXu7(PAYLOAD));
  await flushMicrotasks();
  check("all five queued before any ran", _xu7QueueDepthForTest() === 5, `depth=${_xu7QueueDepthForTest()}`);
  check("queued counter agrees", xu7Stats().queued === 5);
  check("high-water depth recorded", xu7Stats().maxQueueDepth === 5);
  const leftAfter1 = _drainXu7QueueForTest();
  check("one drain runs exactly ONE over-budget item", leftAfter1 === 4, `left=${leftAfter1}`);
  check("and records the deferral", xu7Stats().deferrals === 1);
  check("decodes advanced by exactly one", xu7Stats().decodes === 1);
  let guard = 0;
  while (_xu7QueueDepthForTest() > 0 && guard++ < 20) _drainXu7QueueForTest();
  const armedOut = await Promise.all(armed);
  check("the queue drains completely", _xu7QueueDepthForTest() === 0);
  check("every item resolved", armedOut.every((p) => p && p.width === DIM));
  const s3 = xu7Stats();
  check("five drains for five items", s3.drains === 5, `drains=${s3.drains}`);
  check("maxBatch is 1 — the pile-up is gone", s3.maxBatch === 1, `maxBatch=${s3.maxBatch}`);
  check("four deferrals (the fifth drain empties it)", s3.deferrals === 4, `deferrals=${s3.deferrals}`);
  // The honest bound: a drain never STARTS an item past the cap, so it is
  // `budget + one item` — NOT "<= budget ms", and NOT "one item per frame".
  check(
    "maxDrainMs is about one item, not five",
    s3.maxDrainMs < 60 && s3.maxDrainMs >= 1,
    `maxDrainMs=${s3.maxDrainMs.toFixed(1)}`,
  );
  // The cost side, asserted so it can never be quietly dropped from the report.
  check("queue wait is accounted", s3.queueWaitMs >= 0 && s3.maxQueueWaitMs >= 0);
  // The BEFORE/AFTER pair: PART 2's identical five calls gave maxRun 5 with one
  // run; budgeted they give maxRun 1 with five. Same workload, same counter.
  check("maxRun drops to 1 — this is the whole change", s3.maxRun === 1, `maxRun=${s3.maxRun}`);
  check("five separate runs instead of one", s3.runs === 5, `runs=${s3.runs}`);
  check("maxRun agrees with maxBatch when budgeted", s3.maxRun === s3.maxBatch);

  // ---------------------------------------------------------------- PART 4 --
  console.log("PART 4 — armed, cheap items pack into one drain");
  withSearch("?xu7BudgetMs=1000");
  await arm(0);
  const cheap = [];
  for (let i = 0; i < 5; i++) cheap.push(transcodeXu7(PAYLOAD));
  await flushMicrotasks();
  const leftCheap = _drainXu7QueueForTest();
  check("one drain empties a cheap burst", leftCheap === 0);
  await Promise.all(cheap);
  const s4 = xu7Stats();
  check("maxBatch is 5 — a TIME budget, not one-per-frame", s4.maxBatch === 5, `maxBatch=${s4.maxBatch}`);
  check("no deferrals", s4.deferrals === 0);
  check("one drain", s4.drains === 1);
  // And maxRun follows the batch, which is the honest reading: a generous cap
  // buys back the pile-up. `?xu7BudgetMs` is a knob, not a guarantee.
  check("maxRun tracks maxBatch under a huge cap", s4.maxRun === 5, `maxRun=${s4.maxRun}`);

  // ---------------------------------------------------------------- PART 5 --
  console.log("PART 5 — the resolved value does not depend on the flag");
  withSearch("?xu7Budget=off");
  await arm(0, { fill: 0x5c });
  const direct = await transcodeXu7(PAYLOAD);
  withSearch("");
  await arm(0, { fill: 0x5c });
  const queuedP = transcodeXu7(PAYLOAD);
  await flushMicrotasks();
  _drainXu7QueueForTest();
  const viaQueue = await queuedP;
  const sameShape =
    direct && viaQueue &&
    direct.width === viaQueue.width &&
    direct.height === viaQueue.height &&
    direct.blocksX === viaQueue.blocksX &&
    direct.blocksY === viaQueue.blocksY &&
    direct.levels.length === viaQueue.levels.length;
  check("same shape", !!sameShape);
  const sameBytes =
    sameShape &&
    direct.levels.every((lv, i) => {
      const o = viaQueue.levels[i];
      if (lv.data.length !== o.data.length) return false;
      for (let b = 0; b < lv.data.length; b++) if (lv.data[b] !== o.data[b]) return false;
      return true;
    });
  check("byte-identical mip payloads", !!sameBytes);

  // ---------------------------------------------------------------- PART 6 --
  console.log("PART 6 — failure and reset still settle");
  withSearch("");
  await arm(0, { valid: false });
  const badP = transcodeXu7(PAYLOAD);
  await flushMicrotasks();
  _drainXu7QueueForTest();
  const bad = await badP;
  check("a malformed payload resolves null (hbc7 fallback), not a hang", bad === null);
  check("and is tallied as a decode error", xu7Stats().decodeErrors === 1);

  await arm(50);
  const orphanP = transcodeXu7(PAYLOAD);
  await flushMicrotasks();
  check("job is queued", _xu7QueueDepthForTest() === 1);
  _resetXu7ForTest();
  const orphan = await Promise.race([
    orphanP,
    new Promise((r) => setTimeout(() => r("HUNG"), 500)),
  ]);
  check("reset RESOLVES pending jobs with null rather than dropping them", orphan === null);
  check("and empties the queue", _xu7QueueDepthForTest() === 0);

  noWindow();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
