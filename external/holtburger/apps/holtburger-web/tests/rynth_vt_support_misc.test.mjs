// tests/rynth_vt_support_misc.test.mjs — rynth/vt/support/pets.js, fellow.js,
// doors.js, idle.js and the index barrel (PLAN W1-9 SUP, §3.11; O15, O19-O23,
// C7; Z2, critic G12).
//
// Pets (pet range with/without the custom range, min monsters, PetDmg essence
// choice, refill), fellowship recruiting (gates, 30 s rate limit, the "come
// closer" reply for a sender we cannot see), doors (open, locked + lockpick,
// cooldown; door ID: appraisals within DoorIdentifyRange, a known lock picked
// first / left alone, the stale-percent rule), peace mode (cooldown,
// anti-thrash), IdleRebuff (window raised for exactly one buff tick and
// restored), and every slot/hook/reflex inert at the
// schema defaults; BuffItems/IdleRebuff off when the buff loop is disabled,
// Pets off when the combat loop is disabled.
//
// Everything outside rynth/vt/support/ is a fake (C2,
// rynth/testdata/vt/support/fakes.mjs). pet_essences.json is the real table.
//
// Run from apps/holtburger-web/:  node tests/rynth_vt_support_misc.test.mjs

import assert from "node:assert/strict";

const F = await import("../rynth/testdata/vt/support/fakes.mjs");
const C = await import("../rynth/vt/support/consumables.js");
const P = await import("../rynth/vt/support/pets.js");
const FE = await import("../rynth/vt/support/fellow.js");
const D = await import("../rynth/vt/support/doors.js");
const I = await import("../rynth/vt/support/idle.js");
const X = await import("../rynth/vt/support/index.js");
await C.loadSupportData();

const run = F.makeRunner();
const ME = 0x50000001;
const IDLE = { held: false, kernelAction: "Idle", running: true };

function base({ values = {}, lists = {}, inv = [], items = [], combat = null, buff = null } = {}) {
  const clock = F.makeClock();
  const host = F.makeHost(clock, { me: ME });
  host.inv = inv.map((r) => ({ ...r }));
  const options = F.makeOptions(values, lists);
  const bus = F.makeBus();
  const bot = { loot: { enabled: true, state: "SCAN" }, combat: combat || F.makeCombat(), buff };
  const consumables = new C.ConsumablesModel({ options, host, now: clock.now, log: () => {} });
  const deps = { host, bot, options, subscribe: bus.on, consumables, items: F.makeItems(items), now: clock.now, log: () => {} };
  return { clock, host, options, bus, bot, consumables, deps };
}
function drive(w, slot, c = F.ctx(), ms = 1100) {
  w.clock.advance(ms);
  if (slot.enabled() && slot.wants(c)) {
    slot.tick(c);
    return true;
  }
  return false;
}

// ── pets ──────────────────────────────────────────────────────────────────
const FIRE_ESS = 0x8000c001;
const COLD_ESS = 0x8000c002;
const SPIRIT = 0x8000c003;
const MOB = 0x8000d001;
const fireRow = () => F.row(FIRE_ESS, "Fire Skeleton Minion Essence", { wcid: 48942 });
const coldRow = () => F.row(COLD_ESS, "Frost Skeleton Minion Essence", { wcid: 49227 });

function petWorld({ values = {}, targets = [{ guid: MOB, dist: 10 }], petDmg = "PAuto", items = null, consumables = null, combat = null } = {}) {
  const w = base({
    values: { SummonPets: true, ...values },
    inv: [fireRow(), coldRow(), F.row(SPIRIT, "Encapsulated Spirit", { wcid: 49485 })],
    lists: { consumables: consumables ?? [{ guid: FIRE_ESS, name: "Fire Skeleton Minion Essence", wcid: 48942, type: "Pet" }] },
    items: items ?? [{ guid: COLD_ESS, name: "Frost Skeleton Minion Essence", wcid: 49227, kind: "pet" }],
    combat: combat || F.makeCombat({ targets }),
  });
  w.host.setInt(FIRE_ESS, 92, 5);
  w.host.setInt(COLD_ESS, 92, 5);
  w.host.stats.skills = { 54: { current: 200, training: 2 } };
  w.petDmg = petDmg;
  w.pets = P.createPets({ ...w.deps, monsterPetDmg: () => w.petDmg });
  w.tick = (ms = 1100) => drive(w, w.pets.slot, F.ctx({ threat: true }), ms);
  return w;
}

await run.check("pets: slot shape; summons with the Items-tab essence first; range = MonsterRange unless CustomPetRangeEnabled (G:41)", () => {
  const w = petWorld();
  assert.equal(w.pets.slot.name, "Pets");
  assert.equal(w.pets.slot.rank, "beforeCombat");
  assert.equal(w.tick(), true);
  assert.deepEqual(w.host.calls, [["UseObject", COLD_ESS]], "Items kind pet before Consumables Pet; mob at 10 m within MonsterRange 40");
  assert.equal(w.host.itemActionToken.owner, "vtpets");
  const custom = petWorld({ values: { CustomPetRangeEnabled: true, CustomPetRange: 5 } });
  assert.equal(custom.tick(), false, "10 m > custom 5 m");
  const close = petWorld({ values: { CustomPetRangeEnabled: true, CustomPetRange: 5 }, targets: [{ guid: MOB, dist: 4 }] });
  assert.equal(close.tick(), true);
  assert.equal(close.pets.status().petRangeM, 5);
  const far = petWorld({ values: { MonsterRange: 8 } });
  assert.equal(far.tick(), false, "MonsterRange 8 < 10 m");
});

await run.check("pets: PetMinMonsters (PetMonsterDensity) gates the summon", () => {
  const one = petWorld({ values: { PetMinMonsters: 2 } });
  assert.equal(one.tick(), false);
  const two = petWorld({ values: { PetMinMonsters: 2 }, targets: [{ guid: MOB, dist: 10 }, { guid: MOB + 1, dist: 12 }] });
  assert.equal(two.tick(), true);
});

await run.check("pets: PetDmg picks the essence whose pet deals that element (pet_essences.json); PAuto keeps the list order", () => {
  const fire = petWorld({ petDmg: "Fire" });
  fire.tick();
  assert.deepEqual(fire.host.calls, [["UseObject", FIRE_ESS]], "Fire wanted: the fire essence (Consumables) beats list order");
  const cold = petWorld({ petDmg: "Cold" });
  cold.tick();
  assert.deepEqual(cold.host.calls, [["UseObject", COLD_ESS]]);
  const acid = petWorld({ petDmg: "Acid" });
  acid.tick();
  assert.deepEqual(acid.host.calls, [["UseObject", COLD_ESS]], "no acid essence: fall back to the list order");
  const auto = petWorld({ petDmg: "PAuto" });
  auto.tick();
  assert.deepEqual(auto.host.calls, [["UseObject", COLD_ESS]]);
});

await run.check("pets: completion (Structure drop / pet visible / 'is already active'), assume-active 10 s, no re-summon while a pet is up", () => {
  const w = petWorld();
  w.tick();
  w.host.setInt(COLD_ESS, 92, 4); // charge spent
  w.host.answer();
  w.tick();
  assert.equal(w.pets.status().summons, 1);
  assert.equal(w.pets.status().state, "idle");
  for (let i = 0; i < 5; i++) w.tick(1000);
  assert.equal(w.host.actions("UseObject").length, 1, "10 s assume-active window");
  // A visible "<me>'s …" pet keeps it from re-summoning after the window.
  w.host.nearby = [0x8000e001];
  w.host.names.set(0x8000e001, "Tester's Frost Skeleton Minion");
  for (let i = 0; i < 10; i++) w.tick(1000);
  assert.equal(w.host.actions("UseObject").length, 1, "pet visible by name");
  w.host.names.set(0x8000e001, "Frost Skeleton Minion");
  w.host.petOwner.set(0x8000e001, ME);
  w.tick(1000);
  assert.equal(w.host.actions("UseObject").length, 1, "pet visible by PetOwner (IID 44)");
  w.host.nearby = [];
  w.tick(1000);
  assert.equal(w.host.actions("UseObject").length, 2, "pet gone: re-summon");
  w.bus.emit({ type: "chat", text: "Frost Skeleton Minion is already active", chatType: 0, cat: 0 });
  assert.equal(w.pets.status().state, "idle");
});

await run.check("pets: empty essence → refill with an Encapsulated Spirit (PetAutoRefill); off → park it and use the next essence; 8 s timeout parks 30 s", () => {
  const w = petWorld();
  w.host.setInt(COLD_ESS, 92, 0);
  w.tick();
  assert.deepEqual(w.host.calls, [["UseItemOnTarget", SPIRIT, COLD_ESS]]);
  w.host.setInt(COLD_ESS, 92, 10);
  w.host.answer();
  w.tick();
  assert.equal(w.pets.status().refills, 1);
  w.tick();
  assert.deepEqual(w.host.calls.at(-1), ["UseObject", COLD_ESS], "summon after the refill");
  const off = petWorld({ values: { PetAutoRefill: false } });
  off.host.setInt(COLD_ESS, 92, 0);
  off.tick();
  assert.deepEqual(off.host.calls, [["UseObject", FIRE_ESS]], "empty one parked, next essence used");
  const to = petWorld();
  to.tick();
  for (let i = 0; i < 9; i++) to.tick(1000); // never confirmed
  assert.equal(to.pets.status().state, "idle");
  to.tick(1000);
  assert.equal(to.host.actions("UseObject").length, 1, "an unconfirmed summon probably worked: assume a pet for 10 s");
  to.tick(10_000);
  assert.deepEqual(to.host.actions("UseObject").map((c) => c[1]), [COLD_ESS, FIRE_ESS], "timed-out essence parked 30 s; the next one is used");
});

await run.check("pets enabled(): false at defaults, when EnableCombat is off (combat.enabled === false, critic G12), with no essence configured; untrained Summoning never summons", () => {
  const def = base();
  const p0 = P.createPets(def.deps);
  assert.equal(p0.slot.enabled(), false, "defaults");
  const off = petWorld({ combat: F.makeCombat({ enabled: false, targets: [{ guid: MOB, dist: 1 }] }) });
  assert.equal(off.pets.slot.enabled(), false);
  const none = petWorld({ items: [], consumables: [] });
  assert.equal(none.pets.slot.enabled(), false);
  const untrained = petWorld();
  untrained.host.stats.skills = { 54: { current: 5, training: 1 } };
  assert.equal(untrained.tick(), false);
  const portal = petWorld();
  portal.host.portal = true;
  assert.equal(portal.tick(), false, "portal space holds");
});

// ── fellowship ────────────────────────────────────────────────────────────
const BOB = 0x50000002;
function fellowWorld({ values = {}, fellowship = undefined } = {}) {
  const w = base({ values: { AutoFellowMgmt: true, ...values } });
  w.host.fellowship = fellowship === undefined ? { name: "F", leaderGuid: ME, open: false, isLocked: false, evenShare: true, members: [{ guid: ME, name: "Tester", level: 100 }] } : fellowship;
  w.host.nearby = [BOB];
  w.host.names.set(BOB, "Bob");
  w.fellow = FE.createFellow(w.deps);
  w.tell = (name, text, isSelf = false) => w.bus.emit({ type: "tell", name, text, isSelf });
  w.tick = (info = IDLE, ms = 500) => {
    w.clock.advance(ms);
    w.fellow.reflex.tick(w.clock.t, info);
  };
  return w;
}

await run.check("fellow: 'xp' tell from a visible player while we lead → FellowshipRecruit(guid) (name → guid among visible players)", () => {
  const w = fellowWorld();
  w.tell("Bob", "xp");
  w.tick();
  assert.deepEqual(w.host.calls, [["FellowshipRecruit", BOB]]);
  for (const t of ["XP!", " xp. ", "xp!!"]) assert.ok(FE.XP_TELL_RE.test(t), t);
  for (const t of ["xp please", "need xp", "x p"]) assert.equal(FE.XP_TELL_RE.test(t), false, t);
});

await run.check("fellow gates: never creates a fellowship; closed and not leader; locked; full (9); already a member; open fellowship led by someone else is fine", () => {
  const cases = [
    ["no fellowship", null, 0],
    ["not leader, closed", { leaderGuid: 0x50000009, open: false, isLocked: false, members: [] }, 0],
    ["locked", { leaderGuid: ME, open: true, isLocked: true, members: [] }, 0],
    ["full", { leaderGuid: ME, open: true, isLocked: false, members: Array.from({ length: 9 }, (_, i) => ({ guid: i + 1, name: `M${i}` })) }, 0],
    ["already member", { leaderGuid: ME, open: true, isLocked: false, members: [{ guid: BOB, name: "bob" }] }, 0],
    ["open, other leader", { leaderGuid: 0x50000009, open: true, isLocked: false, members: [] }, 1],
  ];
  for (const [name, fs, n] of cases) {
    const w = fellowWorld({ fellowship: fs });
    w.tell("Bob", "xp");
    w.tick();
    assert.equal(w.host.actions("FellowshipRecruit").length, n, name);
    assert.equal(w.host.calls.filter((c) => /Create/.test(c[0])).length, 0, `${name}: never creates`);
  }
});

await run.check("fellow: 30 s per sender; out-of-sight sender gets one 'come closer' tell; self tells, held and option-off are ignored", () => {
  const w = fellowWorld();
  w.tell("Bob", "xp");
  w.tick();
  w.tell("Bob", "xp");
  w.tick(IDLE, 10_000);
  assert.equal(w.host.actions("FellowshipRecruit").length, 1, "rate limited");
  w.clock.advance(21_000);
  w.tell("Bob", "xp");
  w.tick();
  assert.equal(w.host.actions("FellowshipRecruit").length, 2, "after 30 s");
  const far = fellowWorld();
  far.host.nearby = [];
  far.tell("Carol", "xp");
  far.tick();
  far.tell("Carol", "xp");
  far.tick();
  assert.deepEqual(far.host.actions("SendTell"), [["SendTell", "Carol", FE.COME_CLOSER_TEXT]]);
  assert.equal(far.host.actions("FellowshipRecruit").length, 0);
  const self = fellowWorld();
  self.tell("Tester", "xp", true);
  self.tick();
  assert.equal(self.host.calls.length, 0, "self tell");
  const held = fellowWorld();
  held.tell("Bob", "xp");
  held.tick({ held: true, kernelAction: "Idle", running: false });
  held.tick();
  assert.equal(held.host.calls.length, 0, "only while running: a request seen while held is dropped");
  const off = fellowWorld({ values: { AutoFellowMgmt: false } });
  off.tell("Bob", "xp");
  off.tick();
  assert.equal(off.host.calls.length, 0);
  const stale = fellowWorld();
  stale.tell("Bob", "xp");
  stale.tick(IDLE, 16_000);
  assert.equal(stale.host.calls.length, 0, "requests older than 15 s are dropped");
  const d = fellowWorld();
  assert.equal(d.bus.count("tell"), 1);
  d.fellow.dispose();
  assert.equal(d.bus.count("tell"), 0, "dispose detaches the subscription");
});

// ── doors ─────────────────────────────────────────────────────────────────
const DOOR = 0x7a9b0042;
const PICK = 0x8000f001;
function doorWorld({ values = {}, nav = true, rank = "beforeIdle", lists = {} } = {}) {
  // Door ID off unless a check turns it on: nothing known of a lock = the
  // open → lockpick flow (the door-ID checks are further down).
  const w = base({ values: { OpenDoors: true, DoorIdentifyRange: 0, ...values }, inv: [F.row(PICK, "Lockpick")], lists });
  w.host.nearby = [DOOR];
  w.host.names.set(DOOR, "Door");
  w.host.desc.set(DOOR, 0x1000);
  w.host.dist.set(DOOR, 3);
  w.nav = nav;
  w.doors = D.createDoors({ ...w.deps, rank: () => rank, navWants: () => w.nav });
  w.tick = (ms = 300) => drive(w, w.doors.slot, F.ctx(), ms);
  return w;
}

await run.check("doors: a closed door within OpenDoorRange while navigating → UseObject(door) under vtdoors; Ethereal ⇒ open; skipped 60 s", () => {
  const w = doorWorld({ rank: "beforeCombat" });
  assert.equal(w.doors.slot.name, "Doors");
  assert.equal(w.doors.slot.rank(), "beforeCombat", "the nav slot's rank");
  assert.equal(w.tick(), true);
  assert.deepEqual(w.host.calls, [["UseObject", DOOR]]);
  assert.equal(w.host.itemActionToken.owner, "vtdoors");
  w.host.physState.set(DOOR, 0x4); // ACE opened it
  w.bus.emit({ type: "useDone" });
  w.tick();
  assert.equal(w.doors.status().opens, 1);
  assert.equal(w.doors.status().state, "none");
  w.host.physState.set(DOOR, 0); // swung shut again
  for (let i = 0; i < 20; i++) w.tick(1000);
  assert.equal(w.host.actions("UseObject").length, 1, "recently opened: skipped 60 s");
  w.clock.advance(45_000);
  w.tick();
  assert.equal(w.host.actions("UseObject").length, 2);
});

await run.check("doors: only while navigation wants the tick; out of range / dynamic guid / open / not a door are ignored; name fallback without desc flags", () => {
  const idle = doorWorld();
  idle.nav = false;
  assert.equal(idle.tick(), false);
  const far = doorWorld({ values: { OpenDoorRange: 2 } });
  assert.equal(far.tick(), false, "3 m > 2 m");
  const open = doorWorld();
  open.host.physState.set(DOOR, 0x4);
  assert.equal(open.tick(), false);
  const notDoor = doorWorld();
  notDoor.host.desc.set(DOOR, 0x0);
  assert.equal(notDoor.tick(), false);
  const dyn = doorWorld();
  dyn.host.nearby = [0x80000042];
  dyn.host.desc.set(0x80000042, 0x1000);
  dyn.host.dist.set(0x80000042, 1);
  assert.equal(dyn.tick(), false, "doors are static objects");
  const named = doorWorld();
  named.host.desc.delete(DOOR);
  assert.equal(named.tick(), true, "no desc flags: the name decides");
  const off = doorWorld({ values: { OpenDoors: false } });
  assert.equal(off.doors.slot.enabled(), false);
});

await run.check("doors: locked + AutoUnlockDoors + a Consumables lockpick → UseItemOnTarget(pick, door), then the door is used again", () => {
  const w = doorWorld({ values: { AutoUnlockDoors: true }, lists: { consumables: [{ guid: PICK, name: "Lockpick", wcid: 0, type: "Lockpick" }] } });
  w.tick(); // use
  w.tick(600); // settled, not open → checking
  w.tick(); // lockpick
  assert.deepEqual(w.host.calls, [["UseObject", DOOR], ["UseItemOnTarget", PICK, DOOR]]);
  w.tick(600); // unlocked → retry
  assert.deepEqual(w.host.calls.at(-1), ["UseObject", DOOR]);
  w.host.physState.set(DOOR, 0x4);
  w.tick(600);
  assert.equal(w.doors.status().opens, 1);
  assert.equal(w.doors.status().unlocks, 1);
});

await run.check("doors: locked with no lockpick (or AutoUnlockDoors off) → 5 s cooldown, then that door is skipped so navigation is not blocked forever; ≤ 3 attempts", () => {
  const w = doorWorld({ values: { AutoUnlockDoors: true } }); // no lockpick on the Consumables tab
  w.tick();
  w.tick(600);
  w.tick();
  assert.equal(w.doors.status().state, "cooldown");
  assert.equal(w.doors.slot.wants(F.ctx()), false, "the cooldown never holds the tick: navigation walks on (logic-3)");
  assert.equal(w.doors.status().state, "cooldown", "…while it runs on the clock");
  w.tick(5100);
  assert.equal(w.doors.status().state, "none");
  assert.equal(w.tick(), false, "the failed door is skipped for 60 s");
  assert.equal(w.host.actions("UseObject").length, 1);
  // No answer at all: 3 attempts (3 s + 0.3 s/m each), then cooldown.
  const slow = doorWorld();
  slow.tick();
  slow.host.busy = 1; // the use never settles
  for (let i = 0; i < 20; i++) slow.tick(1000);
  assert.equal(slow.host.actions("UseObject").length, 3, "max 3 attempts");
  assert.ok(["cooldown", "none"].includes(slow.doors.status().state));
});

await run.check("doors: the FSM is frozen while another slot holds the tick; a door left behind meanwhile is dropped, never re-used (no walk back)", () => {
  const w = doorWorld({ values: { AutoUnlockDoors: true }, lists: { consumables: [{ guid: PICK, name: "Lockpick", wcid: 0, type: "Lockpick" }] } });
  w.tick();
  assert.deepEqual(w.host.calls, [["UseObject", DOOR]]);
  // A fight takes the tick for 30 s (the Doors slot is not ticked) and drags
  // the player 40 m away from the door.
  w.clock.advance(30_000);
  w.host.dist.set(DOOR, 40);
  assert.equal(w.tick(), false, "no longer wants the tick for that door");
  assert.equal(w.doors.status().state, "none");
  for (let i = 0; i < 10; i++) w.tick(1000);
  assert.equal(w.host.calls.length, 1, "neither a second UseObject nor a lockpick on the far door");
  // Back within range (the route returns): targeted again, not skipped as failed.
  w.host.dist.set(DOOR, 3);
  assert.equal(w.tick(600), true, "next scan (500 ms cadence) finds it again");
  assert.deepEqual(w.host.calls.at(-1), ["UseObject", DOOR]);
});

await run.check("doors + Boost Nav (logic-3): an in-progress door yields a gentle fight-back to Combat and buffing (both modes) to Buffing — the real kernel picks them; the door is re-targeted after, not failed", async () => {
  const { RynthBotKernel } = await import("../rynth/kernel.js");
  for (const rank of ["beforeCombat", "beforeCombatPinned"]) {
    const w = doorWorld({ rank });
    const s = { threat: false, attacked: false, needBuff: false };
    const combat = { locked: 0, enabled: true, _scanTargets: () => (s.threat ? [{ guid: 0x8000d001 }] : []), canEngage: () => true, disengage() {}, tick() {}, underAttack: () => s.attacked };
    const buff = {
      enabled: true,
      pending: null,
      get status() {
        return { ready: true, active: s.needBuff ? 0 : 1, desired: 1, pending: 0, blocked: false };
      },
      heartbeat() {},
      tick() {},
    };
    const loot = { enabled: true, state: "SCAN", _findCorpse: () => null, tick() {} };
    // ActiveNav._wants' decline rules (the nav slot itself yields the same way).
    const navSlot = {
      name: "Navigate",
      rank: () => rank,
      enabled: () => true,
      pinned: () => false,
      wants: (c) => !(c.buffPinned || c.buffNeeded || c.lootPinned || (rank === "beforeCombat" && c.underAttack && (c.threat || c.corpse))),
      tick() {},
    };
    const aux = { slots: [w.doors.slot, navSlot], idleHooks: [], policy: {}, status: () => ({}) };
    const k = new RynthBotKernel({ IsPlayerReady: () => true }, { combat, buff, loot, vitals: null, unwedge: null, aux }, { log: () => {} });
    k._running = true;
    const tick = () => {
      w.clock.advance(300);
      k.tick();
      return k.action;
    };
    assert.equal(tick(), "Doors", rank);
    assert.equal(w.doors.status().state, "opening");
    w.host.busy = 1; // the use stays busy: the FSM sits in "opening"
    assert.equal(tick(), "Doors", `${rank}: the door holds the tick while nothing outranks it`);
    s.attacked = true; // attacked, nothing to fight yet: the door keeps the tick
    assert.equal(tick(), "Doors", `${rank}: attacked with no threat`);
    s.threat = true;
    if (rank === "beforeCombat") {
      assert.equal(tick(), "Combat", "gentle: the fight-back takes the tick from the door");
      assert.equal(w.doors.status().state, "none", "the door is dropped");
      assert.equal(w.host.itemActionToken, null, "the vtdoors item token is released");
    } else {
      assert.equal(tick(), "Doors", "strict: the door keeps the tick over a fight (C#-literal)");
      s.needBuff = true;
      s.threat = false;
      s.attacked = false;
      assert.equal(tick(), "Buffing", "strict: buffing takes the tick from the door (D39)");
      assert.equal(w.doors.status().state, "none");
      s.needBuff = false;
    }
    s.threat = false;
    s.attacked = false;
    s.needBuff = false;
    w.host.busy = 0;
    assert.equal(tick(), "Doors", `${rank}: re-targeted when nav wants the tick again (not marked failed)`);
    assert.equal(w.host.actions("UseObject").length, 2);
  }
  // Gentle + buffing (no attack) also yields.
  const g = doorWorld({ rank: "beforeCombat" });
  assert.equal(g.tick(), true);
  g.host.busy = 1;
  assert.equal(g.doors.slot.wants(F.ctx({ buffNeeded: true })), false, "gentle: buffing");
  assert.equal(g.doors.status().state, "none");
  // Unboosted the ladder already ranks those first: the door keeps its state.
  const u = doorWorld({ rank: "beforeIdle" });
  assert.equal(u.tick(), true);
  u.host.busy = 1;
  assert.equal(u.doors.slot.wants(F.ctx({ buffNeeded: true, underAttack: true, threat: true })), true);
  assert.equal(u.doors.status().state, "opening");
  // …but when navigation itself steps aside (navWants false: a due BuffItem,
  // nav switched off), an in-progress door does too — dropped, not failed.
  u.nav = false;
  assert.equal(u.doors.slot.wants(F.ctx()), false);
  assert.equal(u.doors.status().state, "none");
  assert.equal(u.host.itemActionToken, null);
  u.nav = true;
  u.host.busy = 0;
  assert.equal(u.tick(600), true, "re-targeted, not skipped as failed");
  assert.equal(u.host.actions("UseObject").length, 2);
});

// ── doors: door ID (DoorIdentifyRange) ────────────────────────────────────
const PICK_ROW = { guid: PICK, name: "Lockpick", wcid: 0, type: "Lockpick" };
/** Door ID on at the schema default (20 m), AutoUnlockDoors on, a lockpick on the Consumables tab. */
function idWorld({ values = {}, lists = { consumables: [PICK_ROW] } } = {}) {
  return doorWorld({ values: { DoorIdentifyRange: 20, AutoUnlockDoors: true, ...values }, lists });
}
/** The server's appraisal answer: the merged properties, then the "appraised" signal. */
function appraise(w, g, { locked, pct } = {}) {
  if (locked !== undefined) w.host.setBool(g, 3, locked);
  if (pct !== undefined) w.host.setInt(g, 173, pct);
  w.bus.emit({ type: "appraised", guid: g });
}
/** Seen from 12 m (appraised there), answered, then walked up to 3 m. */
function approachAppraised(w, answer) {
  w.host.dist.set(DOOR, 12);
  assert.equal(w.tick(), false, "12 m: appraised, not opened");
  assert.deepEqual(w.host.calls, [["RequestId", DOOR]]);
  appraise(w, DOOR, answer);
  w.host.dist.set(DOOR, 3);
}

await run.check("door ID: closed doors within DoorIdentifyRange are appraised ahead of time — nearest first, ≤ 2 a second, again only after 10 s unanswered; never beyond it, never an open door; it never takes the tick; DoorIdentifyRange 0 or no signal seam = none", () => {
  const D2 = 0x7a9b0043;
  const D3 = 0x7a9b0044;
  const D4 = 0x7a9b0045;
  const w = idWorld();
  w.host.nearby = [DOOR, D2, D3, D4];
  for (const g of [D2, D3, D4]) {
    w.host.names.set(g, "Door");
    w.host.desc.set(g, 0x1000);
  }
  w.host.dist.set(DOOR, 15);
  w.host.dist.set(D2, 8);
  w.host.dist.set(D3, 25);
  w.host.dist.set(D4, 12);
  w.host.physState.set(D4, 0x4); // open: nothing to learn
  assert.equal(w.tick(), false, "nothing within OpenDoorRange: the tick is not taken");
  assert.deepEqual(w.host.calls, [["RequestId", D2], ["RequestId", DOOR]], "nearest first; 25 m is beyond the 20 m range");
  for (let i = 0; i < 10; i++) w.tick(600);
  assert.equal(w.host.actions("RequestId").length, 2, "unanswered: asked again only after 10 s");
  w.tick(5000);
  assert.equal(w.host.actions("RequestId").length, 4);
  assert.equal(w.doors.status().appraisals, 4);
  // The budget: three doors due at once → two this second, the third the next.
  const b = idWorld();
  b.host.nearby = [DOOR, D2, D3];
  for (const g of [D2, D3]) {
    b.host.names.set(g, "Door");
    b.host.desc.set(g, 0x1000);
  }
  b.host.dist.set(DOOR, 10);
  b.host.dist.set(D2, 11);
  b.host.dist.set(D3, 12);
  b.tick();
  assert.equal(b.host.actions("RequestId").length, 2, "≤ 2 per second");
  b.tick(600);
  assert.equal(b.host.actions("RequestId").length, 2, "…the third waits");
  b.tick(600);
  assert.deepEqual(b.host.actions("RequestId").at(-1), ["RequestId", D3]);
  // Off: DoorIdentifyRange 0, or a host signal seam without "appraised".
  const off = idWorld({ values: { DoorIdentifyRange: 0 } });
  off.host.dist.set(DOOR, 12);
  off.tick();
  assert.equal(off.host.actions("RequestId").length, 0);
  const noSig = idWorld();
  noSig.doors = D.createDoors({ ...noSig.deps, subscribe: null, navWants: () => true });
  noSig.host.dist.set(DOOR, 12);
  noSig.tick();
  assert.equal(noSig.host.actions("RequestId").length, 0, "no way to see the answer: no request");
  // Nothing answered yet at the door: the lock is not known — opened as before.
  const u = idWorld();
  assert.equal(u.tick(), true);
  assert.deepEqual(u.host.calls, [["RequestId", DOOR], ["UseObject", DOOR]]);
});

await run.check("door ID: answered UNLOCKED → opened as before (one use, no lockpick)", () => {
  const w = idWorld();
  approachAppraised(w, { locked: false });
  assert.equal(w.tick(600), true);
  assert.deepEqual(w.host.calls, [["RequestId", DOOR], ["UseObject", DOOR]]);
  assert.deepEqual(w.doors.status().lock, { guid: DOOR, name: "Door", locked: false, chance: null });
  assert.equal(w.doors.status().note, "Door: opening");
  w.host.physState.set(DOOR, 0x4);
  w.bus.emit({ type: "useDone" });
  w.tick();
  assert.equal(w.doors.status().opens, 1);
  assert.equal(w.host.actions("UseItemOnTarget").length, 0);
});

await run.check("door ID: answered LOCKED with a pick chance > 0 → the Consumables lockpick FIRST (no blind use), its answer awaited (busy 0 says nothing), the use once Locked flips; status reports the chance", () => {
  const w = idWorld();
  approachAppraised(w, { locked: true, pct: 37 });
  assert.equal(w.tick(600), true);
  assert.deepEqual(w.host.calls, [["RequestId", DOOR], ["UseItemOnTarget", PICK, DOOR]], "picked first: a use would only be refused");
  assert.equal(w.doors.status().state, "unlocking");
  assert.deepEqual(w.doors.status().lock, { guid: DOOR, name: "Door", locked: true, chance: 37 });
  assert.equal(w.doors.status().note, "Door: locked, 37% to pick — using Lockpick");
  w.tick(600);
  assert.equal(w.doors.status().state, "unlocking", "no answer yet: still waiting for the pick");
  w.host.setBool(DOOR, 3, false); // the pick worked: ACE broadcasts Locked = false…
  w.host.useDone(); // …then UseDone
  w.bus.emit({ type: "useDone" });
  w.tick();
  assert.deepEqual(w.host.calls.at(-1), ["UseObject", DOOR]);
  w.host.physState.set(DOOR, 0x4);
  w.tick(600);
  assert.equal(w.doors.status().opens, 1);
  assert.equal(w.doors.status().unlocks, 1);
  assert.equal(w.host.actions("UseObject").length, 1);
});

await run.check("door ID: a failed pick (still locked after its answer) is picked again — the 3 attempts are picks, never a blind use — then the door is skipped", () => {
  const w = idWorld();
  approachAppraised(w, { locked: true, pct: 50 });
  assert.equal(w.tick(600), true);
  for (let i = 0; i < 10; i++) {
    if (w.doors.status().state === "unlocking") {
      w.host.useDone(); // answered: no Locked broadcast, the pick failed
      w.bus.emit({ type: "useDone" });
    }
    w.tick(300);
  }
  assert.equal(w.host.actions("UseItemOnTarget").length, 3);
  assert.equal(w.host.actions("UseObject").length, 0, "never a blind use");
  assert.ok(["cooldown", "none"].includes(w.doors.status().state));
  assert.match(w.doors.status().note, /^Door: the lock was not picked in 3 tries — skipped for 60 s$/);
  w.tick(5100);
  assert.equal(w.tick(600), false, "skipped");
  // No answer at all: the attempt timeout re-picks (never a use) — 3 picks, then skipped.
  const slow = idWorld();
  approachAppraised(slow, { locked: true, pct: 50 });
  slow.tick(600);
  for (let i = 0; i < 20; i++) slow.tick(1000);
  assert.equal(slow.host.actions("UseItemOnTarget").length, 3);
  assert.equal(slow.host.actions("UseObject").length, 0);
});

await run.check("door ID: known LOCKED and Auto unlock doors off, a 0 % chance (or none in the locked answer: no ResistLockpick), or no lockpick → never tried (no use, no pick, the tick is not taken), status says why; unlocked later → opened", () => {
  const cases = [
    ["auto-unlock off", { AutoUnlockDoors: false }, undefined, 40, "Door: locked — Auto unlock doors is off"],
    ["0 %", {}, undefined, 0, "Door: locked, 0% to pick — not tried"],
    ["no percent in the locked answer", {}, undefined, undefined, "Door: locked, 0% to pick — not tried"],
    ["no lockpick", {}, { consumables: [] }, 40, "Door: locked, 40% to pick — no lockpick on the Consumables tab"],
  ];
  for (const [label, values, lists, pct, note] of cases) {
    const w = idWorld({ values, lists });
    approachAppraised(w, { locked: true, pct });
    for (let i = 0; i < 5; i++) assert.equal(w.tick(600), false, label);
    assert.equal(w.host.actions("UseObject").length + w.host.actions("UseItemOnTarget").length, 0, label);
    assert.equal(w.doors.status().state, "none", label);
    assert.equal(w.doors.status().note, note, label);
    assert.equal(w.doors.status().lock.locked, true, label);
    w.host.setBool(DOOR, 3, false); // someone unlocked it (ACE broadcasts Locked)
    assert.equal(w.tick(600), true, `${label}: unlocked now`);
    assert.deepEqual(w.host.calls.at(-1), ["UseObject", DOOR], label);
  }
});

await run.check("door ID: a door known locked before its answer waits for it (≤ 2 s), then is picked without a chance if none comes; an answer taken while UNLOCKED gives no chance — locked again, it is appraised again first (a stale percent is never used)", () => {
  const b = idWorld();
  b.host.setBool(DOOR, 3, true); // Locked known (a broadcast), never appraised
  assert.equal(b.tick(), false, "its appraisal just asked: waits");
  assert.deepEqual(b.host.calls, [["RequestId", DOOR]]);
  assert.equal(b.doors.status().note, "Door: locked — appraising it");
  for (let i = 0; i < 3; i++) assert.equal(b.tick(600), false);
  assert.equal(b.tick(600), true, "no answer within 2 s: picked without knowing the chance");
  assert.deepEqual(b.host.calls.at(-1), ["UseItemOnTarget", PICK, DOOR]);
  assert.equal(b.host.actions("UseObject").length, 0, "a use would only be refused");
  assert.equal(b.doors.status().note, "Door: locked — using Lockpick");
  // The stale percent: answered unlocked with an 80 left over in the merged properties.
  const w = idWorld();
  approachAppraised(w, { locked: false, pct: 80 });
  w.host.setBool(DOOR, 3, true); // ACE re-locked it (the door's reset)
  assert.equal(w.tick(2100), false, "locked again: appraised again, and waits for that answer");
  assert.equal(w.host.actions("RequestId").length, 2);
  assert.equal(w.doors.status().lock.chance, null, "80 % is not trusted");
  appraise(w, DOOR, { locked: true, pct: 25 });
  assert.equal(w.tick(600), true);
  assert.deepEqual(w.host.calls.at(-1), ["UseItemOnTarget", PICK, DOOR]);
  assert.equal(w.doors.status().lock.chance, 25);
  // A locked answer is re-read after 60 s (buffs move the skill), not before.
  const r = idWorld();
  approachAppraised(r, { locked: true, pct: 0 });
  for (let i = 0; i < 10; i++) r.tick(600);
  assert.equal(r.host.actions("RequestId").length, 1);
  r.tick(60_000);
  assert.equal(r.host.actions("RequestId").length, 2);
});

// ── idle: peace mode + idle rebuff ────────────────────────────────────────
function idleWorld({ values = {}, buff = F.makeBuff(), combat = F.makeCombat() } = {}) {
  const w = base({ values, combat, buff });
  w.buffLoop = buff;
  w.idle = I.createIdle({ ...w.deps, buff: () => w.buffLoop, combat: () => w.bot.combat });
  w.idleTick = (ms = 100, c = F.ctx()) => {
    w.clock.advance(ms);
    if (w.idle.peaceHook.enabled()) w.idle.peaceHook.tick(c);
  };
  return w;
}

await run.check("peace mode: NonCombat after ≥ 3 s on Idle; ≤ 1 stance change per idle period (no re-send once in peace)", () => {
  const w = idleWorld({ values: { PeaceModeWhenIdle: true } });
  w.host.mode = 2; // melee stance
  for (let i = 0; i < 29; i++) w.idleTick();
  assert.equal(w.host.calls.length, 0, "< 3 s on Idle");
  w.idleTick();
  w.idleTick();
  assert.deepEqual(w.host.calls, [["ChangeCombatMode", 1]]);
  w.host.mode = 1;
  for (let i = 0; i < 50; i++) w.idleTick();
  assert.equal(w.host.calls.length, 1, "already in peace");
});

await run.check("peace mode anti-thrash: Magic entry < 3 s ago, buffs pending, monsters scanned / in combat, busy, a live cast claim, portal → no stance change", () => {
  const settle = (w) => {
    for (let i = 0; i < 35; i++) w.idleTick();
  };
  const magic = idleWorld({ values: { PeaceModeWhenIdle: true } });
  magic.host.mode = 2;
  settle(magic);
  assert.equal(magic.host.calls.length, 1);
  // A buff top-off entered Magic: the next idle period must wait 3 s after it.
  const m2 = idleWorld({ values: { PeaceModeWhenIdle: true } });
  m2.host.mode = 1;
  settle(m2);
  m2.host.mode = 8;
  m2.idleTick(); // Magic seen now
  for (let i = 0; i < 25; i++) m2.idleTick();
  assert.equal(m2.host.calls.length, 0, "< 3 s since the Magic entry");
  let k = 0;
  while (m2.host.calls.length === 0 && k < 20) {
    m2.idleTick();
    k++;
  }
  assert.ok(k >= 4 && k <= 6, `first request ~3 s after the Magic entry (k=${k})`);
  assert.deepEqual(m2.host.calls, [["ChangeCombatMode", 1]]);
  const buffs = idleWorld({ values: { PeaceModeWhenIdle: true }, buff: F.makeBuff({ needs: () => true }) });
  buffs.host.mode = 8;
  settle(buffs);
  assert.equal(buffs.host.calls.length, 0, "buffs pending (would flip straight back to Magic)");
  const legacy = idleWorld({ values: { PeaceModeWhenIdle: true }, buff: { enabled: true, status: { ready: true, desired: 3, active: 1, pending: 0, blocked: null } } });
  legacy.host.mode = 8;
  settle(legacy);
  assert.equal(legacy.host.calls.length, 0, "no needsBuff(): the kernel's _buffNeeded predicate");
  const mobs = idleWorld({ values: { PeaceModeWhenIdle: true }, combat: F.makeCombat({ targets: [{ guid: 1, dist: 30 }] }) });
  mobs.host.mode = 2;
  settle(mobs);
  assert.equal(mobs.host.calls.length, 0, "scan targets");
  const busy = idleWorld({ values: { PeaceModeWhenIdle: true } });
  busy.host.mode = 2;
  busy.host.busy = 1;
  settle(busy);
  assert.equal(busy.host.calls.length, 0, "busy");
  const cast = idleWorld({ values: { PeaceModeWhenIdle: true } });
  cast.host.mode = 2;
  cast.host.tryClaimCast("buff");
  for (let i = 0; i < 35; i++) cast.idleTick(100);
  assert.equal(cast.host.calls.length, 0, "cast claim open");
  const inCombat = idleWorld({ values: { PeaceModeWhenIdle: true } });
  inCombat.host.mode = 2;
  for (let i = 0; i < 35; i++) inCombat.idleTick(100, F.ctx({ inCombat: true }));
  assert.equal(inCombat.host.calls.length, 0, "ctx.inCombat");
});

await run.check("peace mode cooldown: a refused stance change is retried ≥ 500 ms apart, at most 3 times per idle period; a new idle period re-arms", () => {
  const w = idleWorld({ values: { PeaceModeWhenIdle: true } });
  w.host.mode = 2; // the server never switches
  for (let i = 0; i < 100; i++) w.idleTick();
  const sent = w.host.actions("ChangeCombatMode").length;
  assert.equal(sent, 3, "cap per idle period");
  w.clock.advance(5000); // the kernel left Idle for a while
  for (let i = 0; i < 31; i++) w.idleTick();
  assert.equal(w.host.actions("ChangeCombatMode").length, 4, "new idle period, after 3 s");
  const times = [];
  const w2 = idleWorld({ values: { PeaceModeWhenIdle: true } });
  w2.host.mode = 2;
  for (let i = 0; i < 60; i++) {
    const n = w2.host.calls.length;
    w2.idleTick();
    if (w2.host.calls.length > n) times.push(w2.clock.t);
  }
  assert.ok(times.length >= 2 && times[1] - times[0] >= 500, `≥ 500 ms apart: ${times.map((t) => t - times[0])}`);
});

await run.check("IdleRebuff: wants via needsBuff({extraWindowS: IdleRebuffWindowSec}); tick raises buff.idleRebuffWindowS for exactly one buff.tick() and restores it", () => {
  let asked = null;
  const buff = F.makeBuff({ needs: (o) => ((asked = o), (o.extraWindowS || 0) > 0) });
  const w = idleWorld({ values: { RebuffWhenIdle: true }, buff });
  const s = w.idle.rebuffSlot;
  assert.equal(s.name, "IdleRebuff");
  assert.equal(s.rank, "beforeIdle");
  assert.equal(s.enabled(), true);
  assert.equal(s.wants(F.ctx()), true);
  assert.deepEqual(asked, { extraWindowS: 600 });
  s.tick(F.ctx());
  assert.deepEqual(buff.ticks, [600], "the window during the tick");
  assert.equal(buff.idleRebuffWindowS, 0, "restored after it");
  buff.tick = () => {
    throw new Error("boom");
  };
  assert.doesNotThrow(() => s.tick(F.ctx()));
  assert.equal(buff.idleRebuffWindowS, 0, "restored even when buff.tick throws");
  const w0 = idleWorld({ values: { RebuffWhenIdle: true, IdleRebuffWindowSec: 0 }, buff: F.makeBuff({ needs: () => true }) });
  assert.equal(w0.idle.rebuffSlot.wants(F.ctx()), false, "window 0 = nothing extra");
  const nb = idleWorld({ values: { RebuffWhenIdle: true }, buff: F.makeBuff({ needs: () => false }) });
  assert.equal(nb.idle.rebuffSlot.wants(F.ctx()), false, "nothing within the window");
});

await run.check("IdleRebuff / BuffItems enabled() false when EnableBuffing is off (buff.enabled === false, critic G12); IdleRebuff off without a buff loop", () => {
  const off = idleWorld({ values: { RebuffWhenIdle: true }, buff: F.makeBuff({ enabled: false, needs: () => true }) });
  assert.equal(off.idle.rebuffSlot.enabled(), false);
  const none = idleWorld({ values: { RebuffWhenIdle: true }, buff: null });
  assert.equal(none.idle.rebuffSlot.enabled(), false);
  const w = base({ lists: { consumables: [{ guid: 1, name: "Ale", wcid: 0, type: "BuffItem", spellIds: [5], durationS: 1800 }] } });
  const bi = X.createBuffItems({ ...w.deps, buff: () => ({ enabled: false }) });
  assert.equal(bi.slot.enabled(), false);
  const bi2 = X.createBuffItems({ ...w.deps, buff: () => ({ enabled: true }) });
  assert.equal(bi2.slot.enabled(), true);
  // Without an injected `buff` getter (createSupport with only `bot`), both
  // read bot.buff — the EnableBuffing gate must still hold (critic G12).
  w.bot.buff = F.makeBuff({ enabled: false, needs: () => true });
  w.options.set("RebuffWhenIdle", true);
  const sup = X.createSupport({ ...w.deps });
  assert.equal(sup.buffItems.slot.enabled(), false, "BuffItems via createSupport: bot.buff.enabled === false");
  assert.equal(sup.idle.rebuffSlot.enabled(), false, "IdleRebuff via createSupport: bot.buff.enabled === false");
  w.bot.buff.enabled = true;
  assert.equal(sup.buffItems.slot.enabled(), true);
  assert.equal(sup.idle.rebuffSlot.enabled(), true);
  sup.dispose();
});

// ── the whole suite at defaults (Z2) ──────────────────────────────────────
await run.check("Z2: createSupport at the schema defaults with empty lists — every slot/hook/reflex disabled and no host action over 200 ticks", () => {
  const w = base({ combat: F.makeCombat({ locked: 0, targets: [{ guid: 1, dist: 3 }] }), buff: F.makeBuff({ needs: () => true }) });
  w.host.setVital(1, 5);
  w.host.mode = 2;
  w.host.nearby = [DOOR];
  w.host.desc.set(DOOR, 0x1000);
  w.host.dist.set(DOOR, 1);
  w.host.ench = [{ spellId: 2170, family: 110, layer: 1, level: 7, powerLevel: 325, isBeneficial: false, remainingS: 100 }];
  w.host.inv = [F.row(1, "Pyreal", { wcid: 273, stackSize: 3, maxStackSize: 25000 }), F.row(2, "Pyreal", { wcid: 273, stackSize: 4, maxStackSize: 25000 })];
  const sup = X.createSupport({ ...w.deps, buff: () => w.bot.buff, combat: () => w.bot.combat, doorsRank: () => "beforeIdle", navWants: () => true, monsterPetDmg: () => "PAuto" });
  const slots = [sup.supplies.slot, sup.pets.slot, sup.doors.slot, sup.buffItems.slot, sup.idle.rebuffSlot];
  for (const s of slots) assert.equal(s.enabled(), false, s.name);
  assert.equal(sup.idle.peaceHook.enabled(), false);
  for (const r of [sup.inventory, sup.manaStones, sup.fellow]) assert.equal(r.enabled(), false, r.reflex.name);
  w.bus.emit({ type: "tell", name: "Bob", text: "xp", isSelf: false });
  for (let i = 0; i < 200; i++) {
    w.clock.advance(100);
    for (const s of slots) if (s.enabled() && s.wants(F.ctx())) s.tick(F.ctx());
    if (sup.idle.peaceHook.enabled()) sup.idle.peaceHook.tick(F.ctx());
    for (const r of [sup.inventory.reflex, sup.manaStones.reflex, sup.fellow.reflex]) r.tick(w.clock.t, IDLE);
  }
  assert.deepEqual(w.host.calls, [], "V-2: no host action at the Default profile");
  const st = sup.status();
  for (const k of ["supplies", "manaStones", "inventory", "pets", "fellow", "doors", "buffItems", "idle"]) assert.ok(st[k], k);
  sup.dispose();
  assert.equal(w.bus.count("tell"), 0, "dispose detaches every subscription");
  assert.equal(w.bus.count("chat"), 0);
});

await run.check("Consumables rows are cached: slot enabled() every heartbeat re-reads (JSON-clones) the list at most every 5 s; an edit, a list event or a profile change re-reads at once; dispose detaches (review runtime-6)", () => {
  const w = base({ lists: { consumables: [{ guid: 0x8000a001, name: "Healing Kit", wcid: 0, type: "HealthKit" }] } });
  const listeners = new Set();
  let reads = 0;
  const getList = w.options.getList;
  w.options.getList = (n) => (n === "consumables" && reads++, getList(n));
  w.options.onChange = (fn) => (listeners.add(fn), () => listeners.delete(fn));
  const fire = (e) => [...listeners].forEach((fn) => fn(e));
  const sup = X.createSupport({ ...w.deps, consumables: undefined, buff: () => ({ enabled: true }), combat: () => w.bot.combat });
  assert.equal(listeners.size, 1, "one onChange subscription");
  for (let i = 0; i < 100; i++) {
    sup.supplies.slot.enabled();
    sup.buffItems.slot.enabled();
  }
  assert.ok(reads <= 1, `100 heartbeats, ${reads} list reads`);
  assert.equal(sup.supplies.slot.enabled(), true, "the cached rows are the real list");
  // An edit through the model re-reads at once.
  w.host.inv.push(F.row(0x8000a002, "Mana Potion"));
  assert.equal(sup.consumables.add({ guid: 0x8000a002, type: "ManaPotion" }).ok, true);
  assert.ok(sup.consumables.list().some((e) => e.guid === 0x8000a002), "the new row is visible");
  // A list change elsewhere (Consumables tab, another tab) and a profile switch.
  w.options._l.consumables = [];
  assert.equal(sup.supplies.slot.enabled(), true, "still cached");
  fire({ kind: "list", key: "consumables" });
  assert.equal(sup.supplies.slot.enabled(), false, "a list event re-reads");
  w.options._l.consumables = [{ guid: 0x8000a001, name: "Healing Kit", wcid: 0, type: "HealthKit" }];
  fire({ kind: "setting", key: "HealAt" });
  assert.equal(sup.supplies.slot.enabled(), false, "unrelated events keep the cache");
  fire({ kind: "profile", key: "Hunt" });
  assert.equal(sup.supplies.slot.enabled(), true, "a profile change re-reads");
  // Without an event the cache still expires (a safety net).
  w.options._l.consumables = [];
  w.clock.advance(4900);
  assert.equal(sup.supplies.slot.enabled(), true, "within 5 s: cached");
  w.clock.advance(100);
  assert.equal(sup.supplies.slot.enabled(), false, "5 s safety expiry");
  // Callers get copies: editing one never touches the cache.
  w.options._l.consumables = [{ guid: 0x8000a001, name: "Healing Kit", wcid: 0, type: "HealthKit", spellIds: [1] }];
  fire({ kind: "list", key: "consumables" });
  const a = sup.consumables.list();
  a[0].name = "edited";
  a[0].spellIds.push(2);
  assert.equal(sup.consumables.list()[0].name, "Healing Kit");
  assert.deepEqual(sup.consumables.list()[0].spellIds, [1]);
  sup.dispose();
  assert.equal(listeners.size, 0, "dispose detaches from VtOptions (it outlives the layer)");
});

console.log(run.fail === 0 ? `rynth_vt_support_misc: all ${run.pass} checks passed` : `rynth_vt_support_misc: ${run.fail} FAILED (${run.pass} passed)`);
process.exit(run.fail === 0 ? 0 : 1);
