// tests/rynth_loot_vt_options.test.mjs — the VTank looting options made live
// (rynth/loot_loop.js header, 2026-10-19), driven through a fake host with the
// layer's option reader (`loop.optFn`) set, the way rynth/vt/index.js binds it:
//
//   A1-A3  CorpseApproachRangeMin is the reach (walk, then Use), floored at 1 m;
//          without optFn the reach is the literal 4 m
//   O1-O10 corpse ownership off the corpse's "Killed by X." (one RequestId):
//          our kill / our pet's / our own corpse always; a fellow's with
//          LootFellowCorpses at once; anyone's with LootAllCorpses from 100 s;
//          never another's rare, never "misadventure"; LootOnlyRareCorpses
//          only our own rare; a corpse still being described is not available;
//          the book is pruned once a second; corpseWorkPending()
//   R1-R3  "do not yet have the right" on a corpse we may take later: again at
//          100 s, every 15 s, left in view after 5 refusals; our own kill parks
//   D1-D4  descriptions: re-asked every 3 s, 3 times, then no killer; an
//          answer without one is final at once; a host that cannot read them
//          keeps the old rule; LootOnlyRareCorpses then goes by the rare line
//          (only corpses the book saw before it)
//   S0-S7  ReadUnknownScrolls on ACE's CanReadScroll: an unknown scroll we can
//          learn is taken whatever its value and handed over for reading
//          (takeWork); known / too hard / untrained / a second copy are not; a
//          profile's Keep is kept, its Read is read, its Salvage is handed
//          over for salvaging; nothing from our own corpse is tagged
//   C1-C3  formats/utl_eval.js lootDecision, glue/loot_ctx.js classify `out`,
//          cmd/actions_lib.js objectClassFrom Scroll (42)
//   X1     parseCorpseDescription
//
// The loop reads Date.now(): a fake clock replaces it for this process only.
//
// Run from apps/holtburger-web/:  node tests/rynth_loot_vt_options.test.mjs

import assert from "node:assert/strict";

const clock = { t: 1_800_000_000_000 };
Date.now = () => clock.t;

const { RynthLootLoop, parseCorpseDescription, canReadScroll } = await import("../rynth/loot_loop.js");
const { makeLootClassify } = await import("../rynth/vt/glue/loot_ctx.js");
const { lootDecision, lootVerdict } = await import("../rynth/vt/formats/utl_eval.js");
const { objectClassFrom, OBJECT_CLASS } = await import("../rynth/vt/cmd/actions_lib.js");

let pass = 0;
let fail = 0;
async function check(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    fail++;
    console.log(`  FAIL ${name}\n       ${e && e.stack ? e.stack.split("\n").slice(0, 6).join("\n       ") : e}`);
  }
}

const ME = 0x50000001;
const CELL = 0xa9b40021;
const CAT_SYSTEM = 0;
const CAT_TRANSIENT = 9;
const quiet = () => {};
const WRITABLE = 0x2000;

// ── the fake world ─────────────────────────────────────────────────────────
// Corpses sit around the player; a Use opens one in reach (2 ticks) unless it
// carries a `refuse` line (sent back at once, as ACE's transient). RequestId on
// a corpse is answered `answerTicks` later (`desc` readable from then on, and
// GetLastIdTime stamped). MoveTo walks the player 1 m per tick.
function makeWorld(over = {}) {
  const W = {
    tick: 0,
    myName: "Tester",
    pose: { objCellId: CELL, x: 50, y: 50, z: 0 },
    corpses: new Map(), // guid -> { x, y, name, desc, items, refuse }
    objs: new Map(), // item guid -> { name, itemType, value, spell }
    described: new Set(),
    lastId: new Map(),
    answers: [],
    answerTicks: 1,
    calls: [],
    handlers: [],
    inv: new Set(),
    ground: 0,
    openAt: null,
    moveTo: null,
    fellows: [],
    known: [],
    spells: new Map(), // id -> { school, power }
    skills: {}, // skill id -> { current, training }
    caps: null, // a Set of capability names for has(); null = no has()
    ...over,
  };
  const say = (text, u32b) => W.handlers.forEach((fn) => fn({ kind: 2, text, u32: 0, u32b }));
  W.say = say;
  const host = {
    onEvent: (fn) => W.handlers.push(fn),
    IsPlayerReady: () => true,
    GetBusyState: () => 0,
    GetPlayerId: () => ME,
    TryGetPlayerPose: () => ({ ...W.pose }),
    NearbyGuids: () => [...W.corpses.keys()],
    TryGetObjectName: (g) => (g === ME ? W.myName : (W.corpses.get(g)?.name ?? W.objs.get(g)?.name ?? null)),
    TryGetObjectWcid: (g) => (W.corpses.has(g) ? 21 : 0),
    TryGetObjectPosition: (g) => {
      const c = W.corpses.get(g);
      return c ? { objCellId: CELL, x: c.x, y: c.y, z: 0 } : null;
    },
    TryGetObjectIntProperty: (g, p) => {
      const o = W.objs.get(g);
      if (!o) return undefined;
      if (p === 1) return o.itemType ?? 0x80;
      if (p === 19) return o.value;
      return undefined;
    },
    TryGetObjectDataIdProperty: (g, p) => (p === 28 ? W.objs.get(g)?.spell : undefined),
    TryGetObjectStringProperty: (g, p) => (p === 16 && W.described.has(g) ? W.corpses.get(g)?.desc : undefined),
    HasAppraisalData: () => true,
    GetLastIdTime: (g) => W.lastId.get(g) ?? 0,
    RequestId: (g) => {
      W.calls.push(["id", g]);
      if (W.corpses.has(g)) {
        if (W.answerTicks === 0) answer(g);
        else if (W.answerTicks > 0) W.answers.push({ g, at: W.tick + W.answerTicks });
      }
      return true;
    },
    MoveToPosition: (cell, x, y) => {
      W.calls.push(["move", x, y]);
      W.moveTo = { x, y };
      return true;
    },
    StopCompletely: () => {
      W.calls.push(["stop"]);
      W.moveTo = null;
      return true;
    },
    UseObject: (g) => {
      W.calls.push(["use", g]);
      const c = W.corpses.get(g);
      if (c && c.refuse) say(c.refuse, CAT_TRANSIENT);
      else if (c) W.openAt = { g, at: W.tick + 2 };
      return true;
    },
    GetGroundContainerId: () => W.ground,
    GetContainerContents: (g) => [...(W.corpses.get(g)?.items ?? [])],
    MoveItemToContainer: (item) => {
      W.calls.push(["pickup", item]);
      W.inv.add(item);
      for (const c of W.corpses.values()) c.items = c.items.filter((x) => x !== item);
      return true;
    },
    TryGetPlayerInventory: () => [...W.inv].map((guid) => ({ guid })),
    TryGetFreeSlots: () => 50,
    CloseContainer: (g) => {
      W.calls.push(["close", g]);
      if (W.ground === g) W.ground = 0;
      return true;
    },
    TryGetFellowship: () => (W.fellows.length ? { members: [{ name: W.myName }, ...W.fellows.map((name) => ({ name }))] } : null),
    TryGetKnownSpells: () => W.known.slice(),
    TryGetSpellRecord: (id) => {
      const s = W.spells.get(id);
      return s ? { id, name: `Spell ${id}`, ...s } : null;
    },
    TryGetPlayerStats: () => ({ skills: JSON.parse(JSON.stringify(W.skills)) }),
  };
  if (W.caps) host.has = (cap) => W.caps.has(cap);
  function answer(g) {
    W.described.add(g);
    W.lastId.set(g, clock.t);
  }
  W.step = () => {
    W.tick++;
    clock.t += 100;
    for (const a of W.answers.splice(0)) {
      if (a.at <= W.tick) answer(a.g);
      else W.answers.push(a);
    }
    if (W.openAt && W.openAt.at <= W.tick) {
      W.ground = W.openAt.g;
      W.openAt = null;
    }
    if (W.moveTo) {
      const dx = W.moveTo.x - W.pose.x;
      const dy = W.moveTo.y - W.pose.y;
      const d = Math.hypot(dx, dy);
      if (d <= 1) {
        W.pose = { ...W.pose, x: W.moveTo.x, y: W.moveTo.y };
        W.moveTo = null;
      } else W.pose = { ...W.pose, x: W.pose.x + dx / d, y: W.pose.y + dy / d };
    }
  };
  W.host = host;
  return W;
}

let nextGuid = 0x8000a000;
function addCorpse(W, { dx = 2, dy = 0, name = "Corpse of Drudge", desc = "Killed by Tester.", items = [], refuse = null } = {}) {
  const g = ++nextGuid;
  W.corpses.set(g, { x: W.pose.x + dx, y: W.pose.y + dy, name, desc, items: items.slice(), refuse });
  return g;
}
function addItem(W, fields = {}) {
  const g = ++nextGuid;
  W.objs.set(g, { name: "Item", itemType: 0x80, value: 100, ...fields });
  return g;
}

// The options the VT layer would hold (schema defaults, as made live).
const DEFAULT_OPTS = {
  CorpseApproachRangeMin: 2,
  LootFellowCorpses: false,
  LootAllCorpses: false,
  LootOnlyRareCorpses: false,
  ReadUnknownScrolls: true,
  CombineSalvage: true,
};
function makeLoop(W, opts = {}, loopOpts = {}) {
  const loop = new RynthLootLoop(W.host, { log: quiet, ...loopOpts });
  if (opts !== null) {
    const o = { ...DEFAULT_OPTS, ...opts };
    loop.optFn = (k) => o[k];
    loop._opts = o;
  }
  return loop;
}
// The kernel asks _findCorpse() every tick; then the loop ticks.
function run(W, loop, n) {
  for (let i = 0; i < n; i++) {
    W.step();
    loop._findCorpse();
    loop.tick();
  }
}
const uses = (W, g) => W.calls.filter((c) => c[0] === "use" && (g === undefined || c[1] === g)).length;
const ids = (W, g) => W.calls.filter((c) => c[0] === "id" && (g === undefined || c[1] === g)).length;
const picked = (W) => W.calls.filter((c) => c[0] === "pickup").map((c) => c[1]);

// ── X: the description parser ─────────────────────────────────────────────
await check("X1 parseCorpseDescription: killer, rare, misadventure, admin '+'", () => {
  assert.deepEqual(parseCorpseDescription("Killed by Tester."), { killer: "Tester", rare: false });
  assert.deepEqual(parseCorpseDescription("Killed by Tester. This corpse generated a rare item!"), { killer: "Tester", rare: true });
  assert.deepEqual(parseCorpseDescription("Killed by Tester's Fire Elemental."), { killer: "Tester's Fire Elemental", rare: false });
  assert.deepEqual(parseCorpseDescription("Killed by misadventure."), { killer: "", rare: false });
  assert.deepEqual(parseCorpseDescription("Killed by +Admin."), { killer: "Admin", rare: false });
  assert.deepEqual(parseCorpseDescription("Killed by Mr. Bones."), { killer: "Mr. Bones", rare: false });
  for (const t of ["", null, undefined, "A fine corpse.", "Killed by"]) assert.deepEqual(parseCorpseDescription(t), { killer: "", rare: false }, String(t));
});

// ── A: the reach ───────────────────────────────────────────────────────────
await check("A1 CorpseApproachRangeMin 2 m: a corpse 3 m off is walked to, then Used within 2 m", () => {
  const W = makeWorld();
  const c = addCorpse(W, { dx: 3 });
  const loop = makeLoop(W);
  run(W, loop, 2); // describe (answered next tick), then SCAN picks it
  assert.equal(loop.state, "APPROACH", "3 m > 2 m: walk");
  assert.equal(uses(W), 0);
  run(W, loop, 3);
  assert.equal(uses(W, c), 1, "Used once in reach");
  assert.ok(Math.hypot(W.corpses.get(c).x - W.pose.x, W.corpses.get(c).y - W.pose.y) <= 2);
});
await check("A2 without the layer the reach is the literal 4 m (3 m off: Used at once, no description asked)", () => {
  const W = makeWorld();
  const c = addCorpse(W, { dx: 3, desc: "Killed by Someone Else." });
  const loop = makeLoop(W, null);
  run(W, loop, 1);
  assert.equal(uses(W, c), 1);
  assert.equal(W.calls.filter((x) => x[0] === "move").length, 0);
  assert.equal(ids(W), 0, "no corpse appraisal without the layer");
});
await check("A3 the reach is floored at 1 m; 6 m is Used from 6 m", () => {
  const W = makeWorld();
  const loop = makeLoop(W, { CorpseApproachRangeMin: 0.5 });
  assert.equal(loop._reachM(), 1);
  loop._opts.CorpseApproachRangeMin = 6;
  assert.equal(loop._reachM(), 6);
  const c = addCorpse(W, { dx: 5 });
  run(W, loop, 2);
  assert.equal(uses(W, c), 1, "5 m ≤ 6 m: Used without walking");
  loop._opts.CorpseApproachRangeMin = "x";
  assert.equal(loop._reachM(), 4, "unreadable: 4 m");
});

// ── O: ownership ──────────────────────────────────────────────────────────
await check("O1 our kill: described with one RequestId, not available until then, then looted", () => {
  const W = makeWorld({ answerTicks: 3 });
  const item = addItem(W);
  const c = addCorpse(W, { items: [item] });
  const loop = makeLoop(W);
  W.step();
  assert.equal(loop._findCorpse(), null, "being described: not available (the kernel must not pin Loot)");
  assert.equal(ids(W, c), 1);
  W.step();
  assert.equal(loop._findCorpse(), null);
  assert.equal(ids(W, c), 1, "asked once");
  W.step();
  W.step();
  assert.equal(loop._findCorpse()?.guid, c, "ours: available");
  run(W, loop, 12);
  assert.deepEqual(picked(W), [item]);
  assert.equal(loop._book.get(c).kind, "own");
});
await check("O2 our pet's kill and our own corpse are ours; names compare without '+' and case", () => {
  const W = makeWorld({ myName: "+Tester" });
  const pet = addCorpse(W, { desc: "Killed by tester's Fire Elemental." });
  const mine = addCorpse(W, { dx: -2, name: "Corpse of +Tester", desc: "Killed by Drudge Ravener." });
  const fall = addCorpse(W, { dy: 2, name: "Corpse of +Tester", desc: "Killed by misadventure." });
  const other = addCorpse(W, { dy: -2, desc: "Killed by Testerson." });
  const loop = makeLoop(W);
  run(W, loop, 2);
  const o = loop._vtOpts();
  for (const g of [pet, mine, fall]) assert.equal(loop._corpseVerdict(g, loop._book.get(g), o, Date.now()), "loot", (g >>> 0).toString(16));
  assert.equal(loop._corpseVerdict(other, loop._book.get(other), o, Date.now()), "skip", "a name that merely starts with ours is someone else");
});
await check("O3 someone else's kill: left at the defaults (the bot no longer walks to every corpse)", () => {
  const W = makeWorld();
  const c = addCorpse(W, { desc: "Killed by Bob." });
  const loop = makeLoop(W);
  run(W, loop, 30);
  assert.equal(uses(W), 0);
  assert.equal(loop._findCorpse(), null);
  clock.t += 200_000;
  assert.equal(loop._findCorpse(), null, "still left long after");
  assert.equal(ids(W, c), 1, "described once");
});
await check("O4 LootAllCorpses: someone else's kill from 100 s after it appeared", () => {
  const W = makeWorld();
  const c = addCorpse(W, { desc: "Killed by Bob." });
  const loop = makeLoop(W, { LootAllCorpses: true });
  run(W, loop, 2);
  assert.equal(loop._findCorpse(), null, "too new");
  clock.t += 99_000;
  assert.equal(loop._findCorpse(), null, "at ~99 s");
  clock.t += 1_500;
  assert.equal(loop._findCorpse()?.guid, c, "at 100 s");
  run(W, loop, 1);
  assert.equal(uses(W, c), 1);
});
await check("O5 a fellow's kill (or a fellow's pet's): only with LootFellowCorpses, then at once (TryGetFellowshipInfo names)", () => {
  const W = makeWorld({ fellows: ["+Ann"] });
  const viaInfo = W.host.TryGetFellowship;
  delete W.host.TryGetFellowship;
  W.host.TryGetFellowshipInfo = () => ({ ...viaInfo(), leaderGuid: ME });
  const c = addCorpse(W, { desc: "Killed by Ann." });
  const p = addCorpse(W, { dx: -2, desc: "Killed by Ann's Wolf." });
  const loop = makeLoop(W);
  run(W, loop, 5);
  assert.equal(uses(W), 0, "LootFellowCorpses off: left");
  assert.equal(loop._book.get(c).kind, "fellow");
  loop._opts.LootFellowCorpses = true;
  assert.ok([c, p].includes(loop._findCorpse()?.guid), "on: at once");
  const o = loop._vtOpts();
  assert.equal(loop._corpseVerdict(p, loop._book.get(p), o, Date.now()), "loot", "a fellow's pet");
});
await check("O6 never someone else's rare, even with LootAllCorpses; our own rare always", () => {
  const W = makeWorld({ fellows: ["Ann"] });
  const theirs = addCorpse(W, { desc: "Killed by Bob. This corpse generated a rare item!" });
  const fellows = addCorpse(W, { dx: -2, desc: "Killed by Ann. This corpse generated a rare item!" });
  const ours = addCorpse(W, { dy: 3, desc: "Killed by Tester. This corpse generated a rare item!" });
  const loop = makeLoop(W, { LootAllCorpses: true, LootFellowCorpses: true });
  run(W, loop, 2);
  clock.t += 200_000;
  const o = loop._vtOpts();
  const now = Date.now();
  assert.equal(loop._corpseVerdict(theirs, loop._book.get(theirs), o, now), "skip");
  assert.equal(loop._corpseVerdict(fellows, loop._book.get(fellows), o, now), "skip");
  assert.equal(loop._corpseVerdict(ours, loop._book.get(ours), o, now), "loot");
});
await check("O7 a corpse that names no killer (misadventure) is never looted", () => {
  const W = makeWorld();
  addCorpse(W, { desc: "Killed by misadventure." });
  const loop = makeLoop(W, { LootAllCorpses: true, LootFellowCorpses: true });
  run(W, loop, 2);
  clock.t += 300_000;
  run(W, loop, 5);
  assert.equal(uses(W), 0);
});
await check("O8 LootOnlyRareCorpses: only our own rare's corpse", () => {
  const W = makeWorld();
  const rare = addCorpse(W, { desc: "Killed by Tester. This corpse generated a rare item!" });
  const plain = addCorpse(W, { dx: 1, desc: "Killed by Tester." });
  const theirs = addCorpse(W, { dx: -2, desc: "Killed by Bob. This corpse generated a rare item!" });
  const loop = makeLoop(W, { LootOnlyRareCorpses: true, LootAllCorpses: true });
  run(W, loop, 2);
  clock.t += 200_000;
  const o = loop._vtOpts();
  const now = Date.now();
  assert.equal(loop._corpseVerdict(rare, loop._book.get(rare), o, now), "loot");
  assert.equal(loop._corpseVerdict(plain, loop._book.get(plain), o, now), "skip", "our kill, no rare");
  assert.equal(loop._corpseVerdict(theirs, loop._book.get(theirs), o, now), "skip");
});
await check("O9 the book forgets a corpse that leaves view, pruned once a second (not on every call); options are read live", () => {
  const W = makeWorld();
  const c = addCorpse(W, { desc: "Killed by Bob." });
  const loop = makeLoop(W);
  run(W, loop, 2);
  assert.ok(loop._book.has(c));
  loop._opts.LootAllCorpses = true;
  clock.t += 101_000;
  assert.equal(loop._findCorpse()?.guid, c, "turned on later: taken once 100 s old");
  W.corpses.delete(c);
  for (let i = 0; i < 11; i++) {
    clock.t += 100;
    loop._findCorpse();
  }
  assert.equal(loop._book.size, 0, "pruned within a second");
  clock.t += 1100;
  const c2 = addCorpse(W, { desc: "Killed by Bob." });
  loop._findCorpse(); // a prune runs (≥ 1 s since the last) and stamps c2: the next prune is ≥ 1 s away
  W.corpses.delete(c2);
  for (let i = 0; i < 9; i++) {
    clock.t += 100;
    loop._findCorpse();
  }
  assert.ok(loop._book.has(c2), "0.9 s later: not walked yet");
  clock.t += 200;
  loop._findCorpse();
  assert.equal(loop._book.has(c2), false, "pruned on the second");
});
await check("O10 corpseWorkPending(): a corpse in hand, back in SCAN < 1.5 s, or a description on its way; looting off = never", () => {
  const W = makeWorld({ answerTicks: 5 });
  const c = addCorpse(W, { dx: 10 });
  const loop = makeLoop(W);
  assert.equal(loop.corpseWorkPending(), false, "nothing yet");
  W.step();
  loop._findCorpse(); // asks for its description
  assert.equal(loop.corpseWorkPending(), true, "a description on its way");
  run(W, loop, 6);
  assert.equal(loop.state, "APPROACH");
  assert.equal(loop.corpseWorkPending(), true, "a corpse in hand");
  run(W, loop, 20);
  assert.equal(loop.state, "SCAN");
  assert.ok(loop.emptyCorpses + loop.looted.size > 0, "the corpse is done");
  assert.equal(loop.corpseWorkPending(), true, "just back in SCAN");
  clock.t += 1600;
  assert.equal(loop.corpseWorkPending(), false, "settled");
  loop.enabled = false;
  loop.state = "LOOT";
  assert.equal(loop.corpseWorkPending(), false, "looting off");
  void c;
});

// ── R: "You do not yet have the right" ───────────────────────────────────
await check("R1 a fellow's kill refused: again once 100 s old, then every 15 s; left in view after 5 refusals", () => {
  const W = makeWorld({ fellows: ["Ann"] });
  const c = addCorpse(W, { desc: "Killed by Ann.", refuse: null });
  W.corpses.get(c).refuse = `You do not yet have the right to loot the Corpse of Drudge.`;
  const loop = makeLoop(W, { LootFellowCorpses: true });
  run(W, loop, 3);
  assert.equal(uses(W, c), 1, "tried at once");
  assert.equal(loop.state, "SCAN");
  assert.equal(loop.looted.has(c), false, "not parked: the book holds it back");
  run(W, loop, 50);
  assert.equal(uses(W, c), 1, "waits");
  clock.t = loop._book.get(c).seenAt + 100_000;
  run(W, loop, 2);
  assert.equal(uses(W, c), 2, "again at 100 s");
  run(W, loop, 100); // 10 s
  assert.equal(uses(W, c), 2);
  run(W, loop, 60); // past 15 s
  assert.equal(uses(W, c), 3);
  for (let i = 0; i < 4; i++) run(W, loop, 160);
  assert.equal(uses(W, c), 5, "5 refusals in all");
  assert.equal(loop._book.get(c).refused, true);
  run(W, loop, 300);
  assert.equal(uses(W, c), 5, "left while in view");
});
await check("R2 LootAllCorpses: a refusal at 100 s is tried again 15 s later (ACE opens at ~120 s)", () => {
  const W = makeWorld();
  const c = addCorpse(W, { desc: "Killed by Bob." });
  W.corpses.get(c).refuse = `You do not yet have the right to loot the Corpse of Drudge.`;
  const loop = makeLoop(W, { LootAllCorpses: true });
  run(W, loop, 2);
  clock.t += 100_000;
  run(W, loop, 2);
  assert.equal(uses(W, c), 1);
  W.corpses.get(c).refuse = null; // the server opens it now
  run(W, loop, 140);
  assert.equal(uses(W, c), 1, "not before 15 s");
  run(W, loop, 20);
  assert.equal(uses(W, c), 2, "again after 15 s");
  run(W, loop, 4);
  assert.equal(loop.emptyCorpses, 1, "opened (an empty corpse: opened and closed)");
  assert.ok(W.calls.some((x) => x[0] === "close" && x[1] === c));
});
await check("R3 our own kill refused: parked as before (LOOTED_TTL_MS)", () => {
  const W = makeWorld();
  const c = addCorpse(W, { desc: "Killed by Tester." });
  W.corpses.get(c).refuse = `You do not yet have the right to loot the Corpse of Drudge.`;
  const loop = makeLoop(W);
  run(W, loop, 3);
  assert.equal(uses(W, c), 1);
  assert.ok(loop.looted.has(c), "parked");
});

// ── D: descriptions ───────────────────────────────────────────────────────
await check("D1 no answer: asked again every 3 s, 3 times, then it names no killer (left)", () => {
  const W = makeWorld({ answerTicks: -1 });
  const c = addCorpse(W, { desc: "Killed by Tester." });
  const loop = makeLoop(W);
  run(W, loop, 29);
  assert.equal(ids(W, c), 1);
  run(W, loop, 2);
  assert.equal(ids(W, c), 2, "again at 3 s");
  run(W, loop, 31);
  assert.equal(ids(W, c), 3);
  run(W, loop, 31);
  assert.equal(ids(W, c), 3, "no 4th ask");
  assert.deepEqual(loop._book.get(c).desc, { killer: "", rare: false });
  assert.equal(uses(W), 0);
});
await check("D2 an appraisal answered without a description is final at once", () => {
  const W = makeWorld();
  const c = addCorpse(W, { desc: null });
  const loop = makeLoop(W);
  run(W, loop, 2);
  assert.deepEqual(loop._book.get(c).desc, { killer: "", rare: false });
  assert.equal(ids(W, c), 1);
});
await check("D3 a host that cannot read descriptions keeps the old rule: every corpse, no corpse appraisal", () => {
  const W = makeWorld({ caps: new Set(["RequestId"]) });
  const c = addCorpse(W, { desc: "Killed by Bob." });
  const loop = makeLoop(W);
  run(W, loop, 3);
  assert.equal(uses(W, c), 1, "the server decides, as before");
  assert.equal(ids(W), 0);
});
await check("D4 …and LootOnlyRareCorpses then takes only the corpses that appeared with '<me> has discovered the X!'", () => {
  const W = makeWorld({ caps: new Set(["RequestId"]) });
  const old = addCorpse(W, { dx: 1 });
  const loop = makeLoop(W, { LootOnlyRareCorpses: true });
  run(W, loop, 2);
  clock.t += 60_000;
  const fresh = addCorpse(W, { dx: -1 });
  run(W, loop, 5);
  assert.equal(uses(W), 0, "nothing without the announcement");
  W.say("Someone has discovered the Pearl of Blood Drinking!", CAT_SYSTEM);
  W.say("Tester has discovered the Pearl of Blood Drinking!", 1); // a player saying it
  run(W, loop, 2);
  assert.equal(uses(W), 0, "another finder, or not a System line: nothing");
  assert.equal(loop._book.get(fresh).rareHint, false);
  clock.t += 6000; // `fresh` is 6 s old now
  const rare = addCorpse(W, { dx: -2 });
  run(W, loop, 1);
  const unseen = addCorpse(W, { dy: 2 }); // appears with the line, before the book ever saw it
  W.say("Tester has discovered the Pearl of Blood Drinking!", CAT_SYSTEM);
  assert.equal(loop._book.get(rare).rareHint, true, "appeared just now: the rare's");
  assert.equal(loop._book.get(fresh).rareHint, false, "6 s old: not");
  assert.equal(loop._book.get(old).rareHint, false);
  assert.equal(loop._book.has(unseen), false, "the line creates no book entry");
  assert.equal(loop._findCorpse()?.guid, rare);
  assert.equal(loop._book.get(unseen).rareHint, false, "seen after the line: not the rare's");
  run(W, loop, 3);
  assert.equal(uses(W, rare), 1);
  assert.equal(uses(W), 1, "nothing else");
});

// ── S: scrolls and salvage ────────────────────────────────────────────────
const LIFE = 2; // MagicSchool Life → skill 33
function scrollWorld(over = {}) {
  const W = makeWorld(over);
  W.spells.set(1001, { school: LIFE, power: 250 }); // a level 6 life spell
  W.spells.set(1002, { school: LIFE, power: 1 });
  W.spells.set(1003, { school: LIFE, power: 100 });
  W.spells.set(1004, { school: LIFE, power: 300 }); // level 7: anyone (ACE)
  W.skills = { 33: { current: 235, training: 2 } };
  return W;
}
await check("S0 canReadScroll is ACE's CanReadScroll: < 50 or ≥ 300 anyone; else trained and buffed skill ≥ power − 50", () => {
  const trained = (current) => ({ current, training: 2 });
  assert.equal(canReadScroll(1, null), true);
  assert.equal(canReadScroll(49, { current: 0, training: 1 }), true);
  assert.equal(canReadScroll(300, null), true);
  assert.equal(canReadScroll(400, { current: 0, training: 0 }), true);
  assert.equal(canReadScroll(250, trained(200)), true);
  assert.equal(canReadScroll(250, trained(199)), false);
  assert.equal(canReadScroll(250, { current: 400, training: 1 }), false, "untrained");
  assert.equal(canReadScroll(250, { current: 400, training: 3 }), true, "specialized");
  assert.equal(canReadScroll(50, trained(0)), true);
  assert.equal(canReadScroll(299, trained(248)), false);
  assert.equal(canReadScroll(150, null), false, "skill unknown");
  assert.equal(canReadScroll(0, trained(500)), false, "difficulty unknown: not judged");
  assert.equal(canReadScroll(undefined, trained(500)), false);
});
await check("S1 an unknown scroll we can learn is taken whatever its value and handed over for reading", () => {
  const W = scrollWorld();
  const scroll = addItem(W, { name: "Scroll of X", itemType: WRITABLE, value: 5, spell: 1001 });
  const junk = addItem(W, { value: 5 });
  addCorpse(W, { items: [scroll, junk] });
  const loop = makeLoop(W, {}, { minValue: 1000 });
  run(W, loop, 20);
  assert.deepEqual(picked(W), [scroll], "the scroll only (the floor drops the junk)");
  assert.deepEqual(loop.takeWork("read").map((w) => [w.guid, w.spellId]), [[scroll, 1001]]);
  assert.deepEqual(loop.takeWork("read"), [], "handed over once");
});
await check("S2 ACE's rule decides (not VTank's − 15): skill < power − 50, untrained at 50-299, known, a second copy are not taken; levels 1 and 7 need no skill", () => {
  const W = scrollWorld();
  W.known = [1003];
  W.skills = { 33: { current: 199, training: 2 } };
  const hard = addItem(W, { itemType: WRITABLE, value: 5, spell: 1001 }); // 199 < 250 − 50
  const known = addItem(W, { itemType: WRITABLE, value: 5, spell: 1003 });
  const easy = addItem(W, { itemType: WRITABLE, value: 5, spell: 1002 }); // power 1: anyone
  const easy2 = addItem(W, { itemType: WRITABLE, value: 5, spell: 1002 });
  const lvl7 = addItem(W, { itemType: WRITABLE, value: 5, spell: 1004 }); // power 300: anyone
  const book = addItem(W, { itemType: WRITABLE, value: 5 }); // no spell
  addCorpse(W, { items: [hard, known, easy, easy2, lvl7, book] });
  const loop = makeLoop(W, {}, { minValue: 1000 });
  run(W, loop, 40);
  assert.deepEqual(picked(W), [easy, lvl7], "the level 1 scroll once, and the level 7");
  assert.deepEqual(loop.takeWork("read").map((w) => w.guid), [easy, lvl7]);
  const W1 = scrollWorld();
  W1.skills = { 33: { current: 200, training: 2 } }; // exactly 250 − 50
  const at = addItem(W1, { itemType: WRITABLE, value: 5, spell: 1001 });
  addCorpse(W1, { items: [at] });
  const l1 = makeLoop(W1, {}, { minValue: 1000 });
  run(W1, l1, 20);
  assert.deepEqual(picked(W1), [at], "200 ≥ 250 − 50: taken");
  const W2 = scrollWorld();
  W2.skills = { 33: { current: 300, training: 1 } };
  const mid = addItem(W2, { itemType: WRITABLE, value: 5, spell: 1003 });
  addCorpse(W2, { items: [mid] });
  const l2 = makeLoop(W2, {}, { minValue: 1000 });
  run(W2, l2, 20);
  assert.deepEqual(picked(W2), [], "difficulty 100 needs a trained school");
});
await check("S3 ReadUnknownScrolls off: a scroll is judged on its value as before, nothing handed over", () => {
  const W = scrollWorld();
  const scroll = addItem(W, { itemType: WRITABLE, value: 5, spell: 1001 });
  addCorpse(W, { items: [scroll] });
  const loop = makeLoop(W, { ReadUnknownScrolls: false }, { minValue: 1000 });
  run(W, loop, 20);
  assert.deepEqual(picked(W), []);
  assert.deepEqual(loop.takeWork("read"), []);
});
const rule = (name, action, conditions) => ({ name, enabled: true, priority: 0, action, conditions });
const objClass = (cls) => ({ type: 7, typeName: "ObjectClass", data: [String(cls)] });
await check("S4 with a loot profile: Keep keeps the scroll (not read); no rule = read it; Read = read it", () => {
  for (const [label, rules, wantRead] of [
    ["Keep", [rule("scrolls", "Keep", [objClass(42)])], false],
    ["no match", [rule("swords", "Keep", [objClass(1)])], true],
    ["Read", [rule("scrolls", "Read", [objClass(42)])], true],
  ]) {
    const W = scrollWorld();
    const scroll = addItem(W, { itemType: WRITABLE, value: 5, spell: 1001 });
    addCorpse(W, { items: [scroll] });
    const classify = makeLootClassify({ profile: { version: 1, rules }, log: quiet });
    const loop = makeLoop(W, {}, { classify });
    run(W, loop, 20);
    assert.deepEqual(picked(W), [scroll], `${label}: picked up`);
    assert.equal(loop.takeWork("read").length, wantRead ? 1 : 0, `${label}: ${wantRead ? "read" : "kept"}`);
  }
});
await check("S5 a Read rule while ReadUnknownScrolls is off: picked up, kept unread", () => {
  const W = scrollWorld();
  const scroll = addItem(W, { itemType: WRITABLE, value: 5, spell: 1001 });
  addCorpse(W, { items: [scroll] });
  const classify = makeLootClassify({ profile: { version: 1, rules: [rule("scrolls", "Read", [objClass(42)])] }, log: quiet });
  const loop = makeLoop(W, { ReadUnknownScrolls: false }, { classify });
  run(W, loop, 20);
  assert.deepEqual(picked(W), [scroll]);
  assert.deepEqual(loop.takeWork("read"), []);
});
await check("S6 a Salvage rule's pickups are handed over for salvaging; without the layer nothing is queued", () => {
  for (const layer of [true, false]) {
    const W = scrollWorld();
    const robe = addItem(W, { name: "Robe", itemType: 0x4, value: 50 });
    const gem = addItem(W, { name: "Gem", itemType: 0x800, value: 50 });
    addCorpse(W, { items: [robe, gem] });
    const classify = makeLootClassify({ profile: { version: 1, rules: [rule("salvage", "Salvage", [objClass(3)]), rule("keep", "Keep", [])] }, log: quiet });
    const loop = makeLoop(W, layer ? {} : null, { classify });
    run(W, loop, 30);
    assert.deepEqual(picked(W), [robe, gem], "both picked up");
    assert.deepEqual(loop.takeWork("salvage").map((w) => w.guid), layer ? [robe] : [], layer ? "the Salvage rule's item" : "no layer");
    assert.deepEqual(loop.takeWork("read"), []);
  }
});

await check("S7 nothing taken back from our OWN corpse is tagged: no salvage of our gear, no read of our scrolls", () => {
  const W = scrollWorld();
  const robe = addItem(W, { name: "Robe", itemType: 0x4, value: 50 });
  const scroll = addItem(W, { itemType: WRITABLE, value: 5, spell: 1001 });
  addCorpse(W, { name: "Corpse of Tester", desc: "Killed by Drudge Ravener.", items: [robe, scroll] });
  const classify = makeLootClassify({ profile: { version: 1, rules: [rule("salvage", "Salvage", [objClass(3)]), rule("read", "Read", [objClass(42)])] }, log: quiet });
  const loop = makeLoop(W, {}, { classify });
  run(W, loop, 30);
  assert.deepEqual(picked(W), [robe, scroll], "taken back as the profile says");
  assert.deepEqual(loop.takeWork("salvage"), [], "not salvaged");
  assert.deepEqual(loop.takeWork("read"), [], "not read");
  // …and with no profile, ReadUnknownScrolls takes nothing extra from it
  const W2 = scrollWorld();
  const s2 = addItem(W2, { itemType: WRITABLE, value: 5, spell: 1001 });
  addCorpse(W2, { name: "Corpse of Tester", desc: "Killed by misadventure.", items: [s2] });
  const l2 = makeLoop(W2, {}, { minValue: 1000 });
  run(W2, l2, 20);
  assert.deepEqual(picked(W2), [], "the floor decides, as before");
  assert.deepEqual(l2.takeWork("read"), []);
  // the next corpse (our kill) is tagged again
  const s3 = addItem(W2, { itemType: WRITABLE, value: 5, spell: 1001 });
  addCorpse(W2, { dx: -2, items: [s3] });
  run(W2, l2, 30);
  assert.deepEqual(l2.takeWork("read").map((w) => w.guid), [s3]);
});

// ── C: the pieces outside the loop ────────────────────────────────────────
await check("C1 lootDecision carries the rule's action; lootVerdict is its verdict", () => {
  assert.deepEqual(lootDecision({ action: "salvage", rule: "s" }), { verdict: "pickup", action: "salvage", rule: "s" });
  assert.deepEqual(lootDecision({ action: "read", rule: "r" }), { verdict: "pickup", action: "read", rule: "r" });
  assert.deepEqual(lootDecision({ action: "keepUpTo", keepCount: 2, rule: "k" }, { inventoryCount: () => 2 }), { verdict: "skip", action: "keepUpTo", rule: "k" });
  assert.deepEqual(lootDecision({ action: null, pending: true, rule: "p" }), { verdict: "pending", action: null, rule: "p" });
  assert.deepEqual(lootDecision(null), { verdict: "skip", action: null, rule: null });
  assert.equal(lootVerdict({ action: "sell", rule: "x" }), "pickup");
});
await check("C2 loot_ctx classify fills `out` with the action and rule; without `out` it is unchanged", () => {
  const W = scrollWorld();
  const robe = addItem(W, { itemType: 0x4 });
  const classify = makeLootClassify({ profile: { version: 1, rules: [rule("salvage robes", "Salvage", [objClass(3)])] }, log: quiet });
  const out = {};
  assert.equal(classify(robe, { host: W.host, out }), "pickup");
  assert.deepEqual(out, { action: "salvage", rule: "salvage robes" });
  assert.equal(classify(robe, { host: W.host }), "pickup");
});
await check("C3 objectClassFrom: a Writable item with a Spell DataId is a Scroll (42); books are not", () => {
  const C = OBJECT_CLASS;
  assert.equal(objectClassFrom(WRITABLE, 0, 1001), C.Scroll);
  assert.equal(objectClassFrom(WRITABLE, 0x100, 1001), C.Scroll, "Book flag + spell: the spell wins (ACPlugin PASS 3b)");
  assert.equal(objectClassFrom(WRITABLE, 0x100), C.Book);
  assert.equal(objectClassFrom(WRITABLE, 0x100, 0), C.Book);
  assert.equal(objectClassFrom(WRITABLE, 0), C.Unknown, "no spell: as before");
  assert.equal(objectClassFrom(0x80, 0, 1001), C.Misc, "a spell on a non-writable item changes nothing");
});

console.log(fail === 0 ? `rynth_loot_vt_options: all ${pass} checks passed` : `rynth_loot_vt_options: ${fail} FAILED (${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);
