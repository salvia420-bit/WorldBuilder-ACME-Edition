// tests/rynth_loot_corpse_denial.test.mjs — rynth-macro-nav-2: ACE's corpse
// refusals end the corpse at once (rynth/loot_loop.js header, 2026-10-13).
//
// ACE turns a corpse away with a CommunicationTransientString (the wasm's
// kind=2 chat event, category 9 Transient), then a plain UseDone — never a
// UseFailed — so OPEN used to wait out 3 × 6 s per corpse it may not loot and
// try again every 5 minutes. Strings re-derived from ACE.Server:
//   Corpse.Open           "You do not yet have the right to loot the X."
//                         "You may not loot the X because the X has generated a rare item."
//                         "You may not loot the X because the death was caused by a player killer."
//   Container.InUseMessage "The X is already in use by Y!"   (SendTransientError)
//
//   P1-P3  parseCorpseRefusal on the ACE strings / other lines
//   N1-N3  "not yet": parked on the tick after the refusal, exactly one Use,
//          _findCorpse() null for the deferral, found again after it
//   B1-B2  "may not loot … because" (rare / PK): parked while the guid stays
//          in NearbyGuids — even past LOOTED_TTL — and forgotten once it leaves
//   U1-U3  "already in use": skipped 10 s (not parked), retried, parked on
//          the 3rd refusal
//   X1-X4  lines that are not about this corpse change nothing: another
//          corpse's name, a player's chat, an unrelated transient; a host
//          with no TryGetObjectName takes the line on trust
//   D1     a corpse ACE opens is looted as before, chat noise or not
//
// The loop reads Date.now(): the test drives a fake clock by replacing
// Date.now for this process only.
//
// Run from apps/holtburger-web/:  node tests/rynth_loot_corpse_denial.test.mjs

import assert from "node:assert/strict";

const clock = { t: 1_800_000_000_000 };
const realNow = Date.now;
Date.now = () => clock.t;
const advance = (ms) => {
  clock.t += ms;
};

const { RynthLootLoop, parseCorpseRefusal } = await import("../rynth/loot_loop.js");

let pass = 0;
let fail = 0;
async function check(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    fail++;
    console.log(`  FAIL ${name}\n       ${e && e.stack ? e.stack.split("\n").slice(0, 5).join("\n       ") : e}`);
  }
}

// ── fakes ──────────────────────────────────────────────────────────────────
const ME = 0x50000001;
const CORPSE = 0x8000a001;
const NAME = "Corpse of Drudge";
const CHAT = 2;
const CAT_LOCAL = 1;
const CAT_TRANSIENT = 9;
const NOT_YET = `You do not yet have the right to loot the ${NAME}.`;
const RARE = `You may not loot the ${NAME} because the ${NAME} has generated a rare item.`;
const PK = `You may not loot the ${NAME} because the death was caused by a player killer.`;
const IN_USE = `The ${NAME} is already in use by someone else!`;
const quiet = () => {};

// A corpse 2 m away (in reach: SCAN Uses it at once). `answer` is the line
// the server sends back to a Use (synchronously — before _issueOpen has even
// switched to OPEN), or null for none.
function makeHost(over = {}) {
  const calls = [];
  const handlers = [];
  const h = {
    calls,
    ground: 0,
    contents: [],
    answer: null,
    nearby: [CORPSE],
    pose: { objCellId: 0xa9b40021, x: 50, y: 50, z: 0 },
    corpsePos: { objCellId: 0xa9b40021, x: 52, y: 50, z: 0 },
    onEvent: (fn) => handlers.push(fn),
    emit: (e) => handlers.forEach((fn) => fn(e)),
    say: (text, u32b = CAT_TRANSIENT) => h.emit({ kind: CHAT, text, u32: 0, u32b }),
    IsPlayerReady: () => true,
    GetBusyState: () => 0,
    GetPlayerId: () => ME,
    TryGetPlayerPose: () => h.pose,
    NearbyGuids: () => [...h.nearby],
    TryGetObjectName: (g) => (g === CORPSE ? NAME : null),
    TryGetObjectWcid: (g) => (g === CORPSE ? 21 : 0),
    TryGetObjectPosition: (g) => (g === CORPSE ? h.corpsePos : null),
    TryGetObjectIntProperty: () => 100,
    HasAppraisalData: () => true,
    MoveToPosition: (...a) => {
      calls.push(["move", ...a]);
      return true;
    },
    StopCompletely: () => {
      calls.push(["stop"]);
      return true;
    },
    UseObject: (g) => {
      calls.push(["use", g]);
      if (h.answer) h.say(h.answer);
      return true;
    },
    GetGroundContainerId: () => h.ground,
    GetContainerContents: () => [...h.contents],
    MoveItemToContainer: (item, to, slot) => {
      calls.push(["pickup", item, to, slot]);
      return true;
    },
    TryGetPlayerInventory: () => [],
    TryGetFreeSlots: () => 50,
    CloseContainer: (g) => {
      calls.push(["close", g]);
      return true;
    },
    ...over,
  };
  return h;
}
const uses = (h) => h.calls.filter((c) => c[0] === "use" && c[1] === CORPSE).length;
// Ticks at the kernel's 10 Hz.
function run(loop, n) {
  for (let i = 0; i < n; i++) {
    advance(100);
    loop.tick();
  }
}

// ── P: the parser ──────────────────────────────────────────────────────────
await check("P1 the three ACE refusals parse, with the corpse name", () => {
  assert.deepEqual(parseCorpseRefusal(NOT_YET), { why: "notYet", name: NAME });
  assert.deepEqual(parseCorpseRefusal(RARE), { why: "barred", name: NAME });
  assert.deepEqual(parseCorpseRefusal(PK), { why: "barred", name: NAME });
  assert.deepEqual(parseCorpseRefusal(IN_USE), { why: "inUse", name: NAME });
  assert.deepEqual(parseCorpseRefusal("The Treasure of Olthoi Noble is already in use by Bob!"), { why: "inUse", name: "Treasure of Olthoi Noble" });
  assert.deepEqual(parseCorpseRefusal(`${NOT_YET}\n`), { why: "notYet", name: NAME }, "a trailing newline is tolerated");
});
await check("P2 other lines are not refusals", () => {
  for (const t of [
    null,
    undefined,
    "",
    `Bob says, "${NOT_YET}"`,
    `[Popup] ${NOT_YET}`,
    "You have been involved in a player killer battle too recently to do that!",
    "The Chest is locked!",
    "You do not yet have the right to loot",
  ]) {
    assert.equal(parseCorpseRefusal(t), null, String(t));
  }
});
await check("P3 a viewer name is not mistaken for the corpse name", () => {
  assert.deepEqual(parseCorpseRefusal("The Corpse of Tusker is already in use by Ann!"), { why: "inUse", name: "Corpse of Tusker" });
});

// ── N: "You do not yet have the right to loot the X." ──────────────────────
await check("N1 parked on the tick after the refusal, exactly one Use", () => {
  const h = makeHost();
  h.answer = NOT_YET;
  const loop = new RynthLootLoop(h, { log: quiet });
  run(loop, 1); // SCAN -> Use (answered at once) -> OPEN
  assert.equal(loop.state, "OPEN");
  assert.equal(uses(h), 1);
  run(loop, 1); // the refusal ends the corpse
  assert.equal(loop.state, "SCAN");
  assert.ok(loop.looted.has(CORPSE), "parked");
  assert.equal(loop._findCorpse(), null, "_findCorpse() is null for the deferral");
  run(loop, 250); // 25 s: the old path was still re-Using here
  assert.equal(uses(h), 1, "no second Use");
  assert.equal(h.calls.filter((c) => c[0] === "close").length, 0, "nothing to close: it never opened");
});
await check("N2 a refusal arriving after the Use (async, the real wire order) parks too", () => {
  const h = makeHost();
  h.corpsePos = { objCellId: 0xa9b40021, x: 70, y: 50, z: 0 }; // 20 m: approach first
  const loop = new RynthLootLoop(h, { log: quiet });
  run(loop, 1);
  assert.equal(loop.state, "APPROACH");
  h.pose = { objCellId: 0xa9b40021, x: 68, y: 50, z: 0 }; // arrived
  run(loop, 1); // in reach -> Use -> OPEN
  assert.equal(loop.state, "OPEN");
  advance(400);
  h.say(NOT_YET);
  run(loop, 1);
  assert.equal(loop.state, "SCAN");
  assert.ok(loop.looted.has(CORPSE));
  assert.equal(uses(h), 1);
});
await check("N3 the deferral ends with the park (LOOTED_TTL_MS outlasts ACE's 180 s HalfLife)", () => {
  const h = makeHost();
  h.answer = NOT_YET;
  const loop = new RynthLootLoop(h, { log: quiet });
  run(loop, 2);
  advance(4 * 60_000);
  assert.equal(loop._findCorpse(), null, "still deferred at 4 min");
  advance(61_000);
  assert.equal(loop._findCorpse()?.guid, CORPSE, "retried after the park");
  h.answer = null;
  run(loop, 1);
  assert.equal(uses(h), 2, "one Use per visit");
});

// ── B: "You may not loot the X because …" (rare / PK) ─────────────────────
for (const [tag, line] of [
  ["rare", RARE],
  ["PK", PK],
]) {
  await check(`B1 ${tag}: parked while the guid stays in NearbyGuids, past LOOTED_TTL`, () => {
    const h = makeHost();
    h.answer = line;
    const loop = new RynthLootLoop(h, { log: quiet });
    run(loop, 2);
    assert.equal(loop.state, "SCAN");
    assert.equal(uses(h), 1);
    advance(6 * 60_000); // the ordinary park has expired
    assert.equal(loop._findCorpse(), null, "still barred while in view");
    run(loop, 50);
    assert.equal(uses(h), 1, "never re-Used while in view");
  });
}
await check("B2 forgotten once the guid leaves NearbyGuids", () => {
  const h = makeHost();
  h.answer = RARE;
  const loop = new RynthLootLoop(h, { log: quiet });
  run(loop, 2);
  advance(6 * 60_000);
  h.nearby = [];
  assert.equal(loop._findCorpse(), null);
  assert.equal(loop._barred.size, 0, "barred memory pruned");
  h.nearby = [CORPSE];
  assert.equal(loop._findCorpse()?.guid, CORPSE, "a new sighting is tried again");
});

// ── U: "The X is already in use by Y!" ────────────────────────────────────
await check("U1 skipped 10 s without parking", () => {
  const h = makeHost();
  h.answer = IN_USE;
  const loop = new RynthLootLoop(h, { log: quiet });
  run(loop, 2);
  assert.equal(loop.state, "SCAN");
  assert.equal(loop.looted.has(CORPSE), false, "not parked");
  assert.equal(loop._findCorpse(), null, "skipped");
  run(loop, 90); // 9 s
  assert.equal(uses(h), 1);
  run(loop, 15); // past 10 s: SCAN picks it up again
  assert.equal(uses(h), 2, "retried after the skip");
});
await check("U2 parked on the 3rd refusal", () => {
  const h = makeHost();
  h.answer = IN_USE;
  const loop = new RynthLootLoop(h, { log: quiet });
  run(loop, 2); // refusal 1
  advance(10_000);
  run(loop, 2); // refusal 2
  advance(10_000);
  run(loop, 2); // refusal 3 -> parked
  assert.equal(uses(h), 3);
  assert.equal(loop.state, "SCAN");
  assert.ok(loop.looted.has(CORPSE), "parked");
  assert.equal(loop._inUse.has(CORPSE), false, "the count restarts after the park");
  advance(10_000);
  run(loop, 20);
  assert.equal(uses(h), 3, "no Use while parked");
});
await check("U3 once the other looter is done the corpse is looted", () => {
  const h = makeHost();
  h.answer = IN_USE;
  h.contents = [0xa1];
  const loop = new RynthLootLoop(h, { log: quiet });
  run(loop, 2);
  h.answer = null;
  h.ground = CORPSE; // ACE opens it for us on the retry
  advance(10_000);
  run(loop, 3); // Use -> opened -> pickup
  assert.equal(uses(h), 2);
  assert.ok(h.calls.some((c) => c[0] === "pickup" && c[1] === 0xa1), "looted");
});

// ── X: lines that are not about this corpse ───────────────────────────────
await check("X1 a refusal naming another corpse leaves OPEN alone", () => {
  const h = makeHost();
  const loop = new RynthLootLoop(h, { log: quiet });
  run(loop, 1);
  h.say("You do not yet have the right to loot the Corpse of Banderling.");
  h.say("The Corpse of Banderling is already in use by Bob!");
  run(loop, 1);
  assert.equal(loop.state, "OPEN");
  assert.equal(loop.looted.has(CORPSE), false);
});
await check("X2 a player's chat or another category with the same text is ignored", () => {
  const h = makeHost();
  const loop = new RynthLootLoop(h, { log: quiet });
  run(loop, 1);
  h.say(NOT_YET, CAT_LOCAL);
  h.say(`Bob says, "${NOT_YET}"`, CAT_LOCAL);
  h.emit({ kind: 13, u32: 0x1d, text: NOT_YET }); // not a chat event
  run(loop, 1);
  assert.equal(loop.state, "OPEN");
  assert.equal(loop._openTries, 1);
});
await check("X3 an unrelated transient changes nothing; OPEN times out as before", () => {
  const h = makeHost();
  const loop = new RynthLootLoop(h, { log: quiet });
  run(loop, 1);
  h.say("You're too busy!");
  run(loop, 1);
  assert.equal(loop.state, "OPEN");
  run(loop, 62); // OPEN_TIMEOUT_MS at 10 Hz (a longer gap would read as a kernel preemption)
  assert.equal(uses(h), 2, "the old open-timeout retry still runs");
});
await check("X4 a host with no TryGetObjectName takes the line on trust", () => {
  const h = makeHost({ TryGetObjectName: undefined });
  h.answer = NOT_YET;
  const loop = new RynthLootLoop(h, { log: quiet });
  run(loop, 2);
  assert.equal(loop.state, "SCAN");
  assert.ok(loop.looted.has(CORPSE));
});

// ── D: the default path ────────────────────────────────────────────────────
await check("D1 a corpse ACE opens is looted as before, chat noise or not", () => {
  const h = makeHost();
  h.contents = [0xb1];
  const loop = new RynthLootLoop(h, { log: quiet });
  run(loop, 1); // Use
  h.say("You have entered the Holtburg chat channel.");
  h.ground = CORPSE;
  run(loop, 1); // opened -> LOOT
  assert.equal(loop.state, "LOOT");
  run(loop, 1); // pickup
  assert.equal(loop.state, "CONFIRM");
  assert.equal(uses(h), 1);
  assert.equal(loop._corpseRefusal, null);
  assert.equal(loop._barred.size + loop._inUse.size, 0);
});

Date.now = realNow;
console.log(fail === 0 ? `rynth_loot_corpse_denial: all ${pass} checks passed` : `rynth_loot_corpse_denial: ${fail} FAILED (${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);
