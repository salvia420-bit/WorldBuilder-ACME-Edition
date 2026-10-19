// tests/rynth_vt_support_ammo.test.mjs — rynth/vt/support/ammo.js, the "Ammo"
// slot (EnableMissileCrafting, "Refill missile ammo").
//
// The recipe rule (shafts decide the kind, crystal ×8 / chorizite ×64, plain
// heads on plain shafts, wrapped on wrapped), the loose-ammo pick (exact
// AmmoType, ammo-slot items only, last kind first, else the biggest stack);
// the triggers (inert without a launcher / with ammo in the slot / option off;
// a hand-unwielded stack is refilled only when the bot wants missile combat,
// after the 1.5 s grace; a used-up stack + the out-of-ammo line refills at
// once; spoofed lines ignored); wield failure / timeout parking; crafting
// (peace mode first, the launcher's shafts, product → wield, chat-less
// product, failures, too-busy and silent resends, timeout, untrained, the 50 %
// chance gate, no-recipe, the chance-of-success dialog); loot/buff pins;
// the real kernel (beforeCombatPinned above pinned Combat, keepsCombatLoop,
// Vitals first, Stopped drops the job); a throwing host; dispose.
//
// Everything outside rynth/vt/support/ is a fake (C2,
// rynth/testdata/vt/support/fakes.mjs) — except the real RynthBotKernel.
//
// Run from apps/holtburger-web/:  node tests/rynth_vt_support_ammo.test.mjs

import assert from "node:assert/strict";

const F = await import("../rynth/testdata/vt/support/fakes.mjs");
const A = await import("../rynth/vt/support/ammo.js");
const { RynthBotKernel } = await import("../rynth/kernel.js");

const run = F.makeRunner();
const T = A.AMMO_TUNING;
const ME = 0x50000001;
const EM_LAUNCHER = 0x00400000;
const EM_AMMO = 0x00800000;
const OUT = "You are out of ammunition!";
const CAT_TRANSIENT = 9;
const CAT_CRAFT = 19;

const BOW = 0x60000001;
const XBOW = 0x60000002;
const ARROWS = 0x80001001;
const ARROWS2 = 0x80001002;
const HEADS = 0x80002001; // Bundle of Arrowheads (4586, difficulty 5)
const SHAFTS = 0x80002002; // Bundle of Arrowshafts (4585)
const QSHAFTS = 0x80002003; // Bundle of Quarrelshafts (5339)
const PRODUCT = 0x80003001;

const bow = (extra = {}) => F.row(BOW, "Longbow", { wcid: 306, itemType: 0x100, validLocations: EM_LAUNCHER, equipMask: EM_LAUNCHER, ammoType: 1, ...extra });
const xbow = (extra = {}) => F.row(XBOW, "Heavy Crossbow", { wcid: 311, itemType: 0x100, validLocations: EM_LAUNCHER, equipMask: EM_LAUNCHER, ammoType: 2, ...extra });
const ammoRow = (guid, name, wcid, ammoType, size, extra = {}) =>
  F.row(guid, name, { wcid, itemType: 0x100, validLocations: EM_AMMO, ammoType, stackSize: size, maxStackSize: 1000, ...extra });
const arrows = (guid, size, extra = {}) => ammoRow(guid, "Arrow", 300, 1, size, extra);
const bundle = (guid, name, wcid, size = 10) => F.row(guid, name, { wcid, itemType: 0x8000000, stackSize: size, maxStackSize: 100 });
const heads = (guid = HEADS, name = "Bundle of Arrowheads", wcid = 4586, size = 10) => bundle(guid, name, wcid, size);
const shafts = (guid = SHAFTS, size = 10) => bundle(guid, "Bundle of Arrowshafts", 4585, size);
const qshafts = (guid = QSHAFTS, size = 10) => bundle(guid, "Bundle of Quarrelshafts", 5339, size);
const FIGHT = () => F.ctx({ inCombat: true, threat: true, combatPinned: true });

function world({ values = {}, inv = [], mode = 1, skills = null } = {}) {
  const clock = F.makeClock();
  const host = F.makeHost(clock, { me: ME, mode });
  host.inv = inv.map((r) => ({ ...r }));
  if (skills) host.stats.skills = skills;
  host.confirms = [];
  const rec = (name, ...args) => {
    host.calls.push([name, ...args]);
    return host.sendOk;
  };
  Object.assign(host, {
    WieldItem: (g, m) => rec("WieldItem", g >>> 0, m >>> 0),
    SetWielded: (g, m) => rec("SetWielded", g >>> 0, m >>> 0),
    TryGetPendingConfirmations: () => host.confirms.map((c) => ({ ...c })),
    SendConfirmationResponse(type, context, yes) {
      host.confirms = host.confirms.filter((c) => c.context !== context);
      return rec("SendConfirmationResponse", type, context, yes);
    },
  });
  const options = F.makeOptions(values);
  const bus = F.makeBus();
  const combat = F.makeCombat();
  const logs = [];
  const ammo = A.createAmmo({ host, bot: { combat }, options, subscribe: bus.on, now: clock.now, log: (m) => logs.push(m) });
  const w = { clock, host, options, bus, combat, logs, ammo, slot: ammo.slot };
  w.row = (g) => host.inv.find((r) => r.guid === g);
  /** The server put `g` into the ammo slot. */
  w.landWield = (g) => {
    w.row(g).equipMask = EM_AMMO;
    host.answer();
    bus.emit({ type: "equip", item: g, wielder: ME, failed: false });
  };
  /** The player (or a launcher swap) took the wielded stack off: it stays in the pack. */
  w.unwield = (g) => {
    w.row(g).equipMask = 0;
    bus.emit({ type: "equip", item: g, wielder: ME, failed: false });
  };
  /** The last arrow flew: the stack is gone and the server says so. */
  w.lastArrow = (g) => {
    host.inv = host.inv.filter((r) => r.guid !== g);
    bus.emit({ type: "equip", item: g, wielder: ME, failed: false });
    bus.emit({ type: "inventory" });
    bus.emit({ type: "chat", text: OUT, chatType: 0, cat: CAT_TRANSIENT });
  };
  /** ACE's successful combine: bundles down by one, a new stack, the Craft line, UseDone. */
  w.made = (product = arrows(PRODUCT, 100), { line = "You make a bundle of arrows." } = {}) => {
    for (const g of [HEADS, SHAFTS, QSHAFTS]) {
      const r = w.row(g);
      if (r && w.lastCombine && w.lastCombine.includes(g)) r.stackSize -= 1;
    }
    host.inv.push({ ...product });
    bus.emit({ type: "inventory" });
    if (line) bus.emit({ type: "chat", text: line, chatType: 0, cat: CAT_CRAFT });
    host.useDone();
    bus.emit({ type: "useDone" });
  };
  /** One kernel offer: enabled, then pinned / wants, then tick. → ticked? */
  w.drive = (c = F.ctx(), ms = 100) => {
    clock.advance(ms);
    if (!w.slot.enabled()) return false;
    if (w.slot.pinned() || w.slot.wants(c)) {
      w.slot.tick(c);
      const last = host.actions("UseItemOnTarget").slice(-1)[0];
      if (last) w.lastCombine = last.slice(1);
      return true;
    }
    return false;
  };
  w.until = (pred, c = FIGHT(), ms = 100, max = 400) => {
    for (let i = 0; i < max; i++) {
      w.drive(c, ms);
      if (pred()) return true;
    }
    return false;
  };
  return w;
}

// ── pure helpers ──────────────────────────────────────────────────────────
await run.check("craftProduct: the SHAFTS make the kind; crystal ×8, chorizite ×64; plain heads on plain shafts, wrapped on wrapped, Infinite on both", () => {
  assert.deepEqual(A.craftProduct(4586, 4585), { ammoType: 1, difficulty: 5 }, "Bundle of Arrowheads + Arrowshafts → arrows (recipe 323)");
  assert.deepEqual(A.craftProduct(4586, 5339), { ammoType: 2, difficulty: 5 }, "…on Quarrelshafts → quarrels (324)");
  assert.deepEqual(A.craftProduct(4586, 15296), { ammoType: 4, difficulty: 5 }, "…on Atlatl Dart Shafts → darts (2567)");
  assert.deepEqual(A.craftProduct(9359, 9378), { ammoType: 2, difficulty: 35 }, "wrapped on wrapped");
  assert.equal(A.craftProduct(9359, 4585), null, "wrapped heads never on plain shafts");
  assert.equal(A.craftProduct(4586, 9377), null, "plain heads never on wrapped shafts");
  assert.deepEqual(A.craftProduct(7996, 5339), { ammoType: 16, difficulty: 60 }, "crystal heads: BoltCrystal");
  assert.deepEqual(A.craftProduct(21999, 15298), { ammoType: 256, difficulty: 150 }, "chorizite heads: AtlatlChorizite");
  assert.equal(A.craftProduct(30074, 4585).difficulty, 250, "Infinite heads, plain");
  assert.equal(A.craftProduct(30074, 9377).difficulty, 180, "Infinite heads, wrapped");
  assert.equal(A.craftProduct(4585, 4586), null, "shafts are not heads");
  assert.equal(A.craftProduct(12345, 4585), null, "unknown heads");
});

await run.check("pickLooseAmmo: exact AmmoType, ammo-slot items only (a spare bow is not ammo), unequipped; the last kind first, else the biggest stack", () => {
  const inv = [
    arrows(ARROWS, 50),
    ammoRow(ARROWS2, "Broadhead Arrow", 3600, 1, 500),
    ammoRow(0x80001003, "Quarrel", 305, 2, 900),
    ammoRow(0x80001004, "Crystal-tip Arrow", 7995, 8, 900),
    F.row(0x60000009, "Shortbow", { wcid: 307, validLocations: EM_LAUNCHER, ammoType: 1 }),
    arrows(0x80001005, 999, { equipMask: EM_AMMO }),
  ];
  assert.equal(A.pickLooseAmmo(inv, 1).guid, ARROWS2, "biggest matching stack");
  assert.equal(A.pickLooseAmmo(inv, 1, { preferWcid: 300 }).guid, ARROWS, "the kind last wielded wins over size");
  assert.equal(A.pickLooseAmmo(inv, 2).guid, 0x80001003);
  assert.equal(A.pickLooseAmmo(inv, 8).guid, 0x80001004, "crystal launcher ↔ crystal ammo only");
  assert.equal(A.pickLooseAmmo(inv, 4), null);
  assert.equal(A.pickLooseAmmo(inv, 0), null, "a thrown weapon needs nothing");
  assert.equal(A.pickLooseAmmo(inv, 1, { blocked: (g) => g === ARROWS2 }).guid, ARROWS, "parked stacks are skipped");
});

await run.check("craftPlan: the easiest recipe first; the 50 % chance gate with a known Fletching skill; the launcher's shafts only", () => {
  const inv = [
    heads(),
    heads(0x80002004, "Bundle of Deadly Arrowheads", 15411),
    heads(0x80002005, "Wrapped Bundle of Arrowheads", 9359),
    shafts(),
    qshafts(),
  ];
  const p = A.craftPlan(inv, 1);
  assert.equal(p.best.heads, HEADS);
  assert.equal(p.best.shafts, SHAFTS, "arrows come from ARROWshafts");
  assert.equal(p.best.difficulty, 5);
  assert.equal(p.best.chance, null, "unknown skill: no estimate");
  assert.equal(A.craftPlan(inv, 2).best.shafts, QSHAFTS, "a crossbow's quarrels from quarrelshafts");
  assert.equal(A.craftPlan(inv, 4).best, null, "no dart shafts");
  const hard = A.craftPlan([heads(0x80002004, "Bundle of Deadly Arrowheads", 15411), shafts()], 1, { skill: 50 });
  assert.equal(hard.best, null, "Fletching 50 vs difficulty 150 ≈ 5 %");
  assert.equal(hard.tooHard, true);
  const ok = A.craftPlan([heads(0x80002004, "Bundle of Deadly Arrowheads", 15411), shafts()], 1, { skill: 200 });
  assert.ok(ok.best && ok.best.chance > 0.8, "Fletching 200 vs 150");
  assert.equal(A.craftPlan([heads(), shafts()], 1, { blocked: () => true }).best, null);
});

// ── triggers ──────────────────────────────────────────────────────────────
await run.check("inert: no launcher, ammo already in the slot, a thrown weapon (AmmoType 0), or the option off — no host action, even in a fight", () => {
  const cases = [
    { inv: [F.row(0x60000005, "Wand", { itemType: 0x8000, equipMask: 0x01000000 }), arrows(ARROWS, 50)] },
    { inv: [bow(), arrows(ARROWS, 50, { equipMask: EM_AMMO }), arrows(ARROWS2, 50)] },
    { inv: [F.row(0x60000006, "Throwing Axe", { itemType: 0x100, validLocations: EM_LAUNCHER, equipMask: EM_LAUNCHER, ammoType: 0 }), arrows(ARROWS, 50)] },
    { inv: [bow(), arrows(ARROWS, 50)], values: { EnableMissileCrafting: false } },
  ];
  for (const c of cases) {
    const w = world(c);
    w.bus.emit({ type: "chat", text: OUT, cat: CAT_TRANSIENT });
    for (let i = 0; i < 30; i++) w.drive(FIGHT(), 500);
    assert.equal(w.slot.enabled(), false, JSON.stringify(c.values || c.inv.map((r) => r.name)));
    assert.deepEqual(w.host.calls, [], "no host action");
    assert.equal(w.host.itemActionToken, null, "never claims the item token");
  }
  const w = world({ inv: [bow(), arrows(ARROWS, 50)] });
  assert.equal(w.slot.enabled(), true, "the schema default (ON) applies when the options say nothing");
  assert.equal(w.slot.name, "Ammo");
  assert.equal(w.slot.rank, "beforeCombatPinned");
  assert.equal(w.slot.keepsCombatLoop, true);
});

await run.check("a stack unwielded by hand: no refill without a fight; with one, after the 1.5 s grace → WieldItem(stack, Ammo) under vtammo; the slot filling resolves it", () => {
  const w = world({ inv: [bow(), arrows(ARROWS, 50, { equipMask: EM_AMMO }), ammoRow(ARROWS2, "Broadhead Arrow", 3600, 1, 500)] });
  w.drive();
  assert.equal(w.slot.enabled(), false, "ammo in the slot");
  w.unwield(ARROWS);
  for (let i = 0; i < 30; i++) w.drive(F.ctx(), 200);
  assert.equal(w.slot.enabled(), true);
  assert.deepEqual(w.host.calls, [], "never re-wields while the bot does not want missile combat");
  // A fight starts: the slot has long been empty → refill at once.
  assert.equal(w.drive(FIGHT()), true);
  assert.deepEqual(w.host.calls, [["WieldItem", ARROWS, EM_AMMO]], "the kind last wielded (Arrow) over the bigger Broadhead stack");
  assert.equal(w.host.itemActionToken.owner, "vtammo");
  assert.equal(w.slot.pinned(), true, "waiting for the wield");
  w.landWield(ARROWS);
  w.drive(FIGHT());
  assert.equal(w.slot.pinned(), false);
  assert.equal(w.slot.enabled(), false, "invisible again once the slot is full");
  assert.equal(w.ammo.status().wields, 1);
  assert.equal(w.host.itemActionToken, null, "token released");

  // The grace: unwielded by hand mid-fight → nothing for 1.5 s.
  const g = world({ inv: [bow(), arrows(ARROWS, 50, { equipMask: EM_AMMO }), ammoRow(ARROWS2, "Broadhead Arrow", 3600, 1, 500)] });
  g.drive(FIGHT());
  g.unwield(ARROWS);
  g.drive(FIGHT(), 100);
  for (let i = 0; i < 13; i++) g.drive(FIGHT(), 100);
  assert.equal(g.host.actions("WieldItem").length, 0, "1.4 s after the hand unwield: still waiting");
  g.drive(FIGHT(), 200);
  assert.equal(g.host.actions("WieldItem").length, 1, "after the grace");
});

await run.check("the last arrow used up + \"You are out of ammunition!\": refills at once, no threat needed; an old line or a spoofed one does not trigger", () => {
  const w = world({ inv: [bow(), arrows(ARROWS, 1, { equipMask: EM_AMMO }), ammoRow(ARROWS2, "Broadhead Arrow", 3600, 1, 500)] });
  w.drive();
  w.lastArrow(ARROWS);
  assert.equal(w.drive(F.ctx(), 100), true, "no fight in range, but the bot just ran dry shooting");
  assert.deepEqual(w.host.calls, [["WieldItem", ARROWS2, EM_AMMO]]);

  const old = world({ inv: [bow(), arrows(ARROWS, 1, { equipMask: EM_AMMO }), ammoRow(ARROWS2, "Broadhead Arrow", 3600, 1, 500)] });
  old.drive();
  old.lastArrow(ARROWS);
  old.clock.advance(T.OUT_OF_AMMO_WINDOW_MS + 1000);
  for (let i = 0; i < 10; i++) old.drive(F.ctx(), 100);
  assert.deepEqual(old.host.calls, [], "a 31 s old line no longer means 'wants missile combat'");

  const spoof = world({ inv: [bow(), arrows(ARROWS2, 500)] });
  spoof.bus.emit({ type: "chat", text: `Bob says, "${OUT}"`, cat: 1 });
  spoof.bus.emit({ type: "chat", text: OUT, cat: 1 }); // a speech category
  for (let i = 0; i < 30; i++) spoof.drive(F.ctx(), 100);
  assert.deepEqual(spoof.host.calls, [], "speech can't trigger a refill");
});

await run.check("matching: a crossbow takes AmmoType-2 quarrels (read off PropertyInt 50 when the row lacks it), never arrows or a spare launcher", () => {
  const w = world({
    inv: [
      xbow({ ammoType: undefined }),
      arrows(ARROWS, 900),
      F.row(0x60000009, "Light Crossbow", { wcid: 312, validLocations: EM_LAUNCHER, ammoType: 2 }),
      ammoRow(0x80001003, "Quarrel", 305, 2, 100),
      ammoRow(0x80001004, "Deadly Quarrel", 15438, 0, 300), // a host row without ammoType
    ],
  });
  w.host.setInt(XBOW, 50, 2);
  w.host.setInt(0x80001004, 50, 2);
  w.until(() => w.host.calls.length > 0);
  assert.deepEqual(w.host.calls, [["WieldItem", 0x80001004, EM_AMMO]], "the biggest AmmoType-2 stack");
  assert.equal(w.ammo.status().ammoType, 2);
});

await run.check("wield refused (kind 48) → that stack parked 30 s, the next one wielded; no answer in 4 s → parked, and crafting waits too", () => {
  const w = world({ inv: [bow(), arrows(ARROWS, 500), arrows(ARROWS2, 100), heads(), shafts()] });
  w.until(() => w.host.calls.length > 0);
  assert.deepEqual(w.host.calls.at(-1), ["WieldItem", ARROWS, EM_AMMO]);
  w.host.answer();
  w.bus.emit({ type: "equip", item: ARROWS, wielder: 0, failed: true, code: 0x1d });
  w.until(() => w.host.calls.length > 1);
  assert.deepEqual(w.host.calls.at(-1), ["WieldItem", ARROWS2, EM_AMMO], "the next stack");
  assert.ok(w.ammo.status().parked.includes(`item:${ARROWS}`));
  // ARROWS2 never lands: 4 s → parked; with every stack parked nothing is combined either.
  const n = w.host.calls.length;
  for (let i = 0; i < 100; i++) w.drive(FIGHT(), 200); // 20 s
  assert.equal(w.host.calls.length, n, "no new wield, no combine while the refused stacks are parked");
  assert.ok(w.ammo.status().parked.includes(`item:${ARROWS2}`));
  assert.ok(w.ammo.status().parked.includes("craft"));
  assert.equal(w.slot.pinned(), false);
  for (let i = 0; i < 60; i++) w.drive(FIGHT(), 200); // past the 30 s park
  assert.ok(w.host.actions("WieldItem").length > 2, "retried after the park");
});

// ── crafting ──────────────────────────────────────────────────────────────
await run.check("craft: no loose ammo → peace mode first, then UseItemOnTarget(heads, the LAUNCHER's shafts); \"You make\" + the new stack → WieldItem(product)", () => {
  const w = world({ inv: [bow(), heads(), qshafts(), shafts()], mode: 4 });
  w.until(() => w.host.calls.length > 0); // past the start-up grace (an empty slot of unknown history)
  assert.deepEqual(w.host.calls, [["ChangeCombatMode", 1]], "ACE crafts only in NonCombat");
  w.drive(FIGHT(), 500);
  assert.equal(w.host.actions("ChangeCombatMode").length, 1, "one request per 2 s");
  w.host.mode = 1;
  w.drive(FIGHT());
  assert.deepEqual(w.host.calls.at(-1), ["UseItemOnTarget", HEADS, SHAFTS], "arrowshafts for a bow, not the quarrelshafts");
  assert.equal(w.host.itemActionToken.owner, "vtammo");
  for (let i = 0; i < 5; i++) w.drive(FIGHT(), 300);
  assert.equal(w.host.actions("UseItemOnTarget").length, 1, "the combine runs (~1.5 s): no resend");
  w.made();
  w.until(() => w.host.actions("WieldItem").length > 0, FIGHT(), 300);
  assert.deepEqual(w.host.calls.at(-1), ["WieldItem", PRODUCT, EM_AMMO]);
  assert.equal(w.ammo.status().crafts, 1);
  w.landWield(PRODUCT);
  w.drive(FIGHT());
  assert.equal(w.slot.enabled(), false);
  assert.equal(w.ammo.status().wields, 1);
  assert.equal(w.host.actions("UseItemOnTarget").length, 1, "exactly one combine");
});

await run.check("craft: the new stack alone (no chat line) counts; \"You fail to make\" tries again and 2 failures park those heads — the next heads are used", () => {
  const w = world({ inv: [bow(), heads(), heads(0x80002006, "Bundle of Broad Arrowheads", 5345), shafts()] });
  w.until(() => w.host.actions("UseItemOnTarget").length === 1);
  w.made(arrows(PRODUCT, 100), { line: null });
  w.until(() => w.host.actions("WieldItem").length === 1, FIGHT(), 300);
  assert.deepEqual(w.host.calls.at(-1), ["WieldItem", PRODUCT, EM_AMMO]);

  const f = world({ inv: [bow(), heads(), heads(0x80002006, "Bundle of Broad Arrowheads", 5345), shafts()] });
  const fail = () => {
    f.bus.emit({ type: "chat", text: "You fail to make any arrows.", chatType: 0, cat: CAT_CRAFT });
    f.host.useDone();
    f.bus.emit({ type: "useDone" });
  };
  f.until(() => f.host.actions("UseItemOnTarget").length === 1);
  assert.deepEqual(f.host.calls.at(-1), ["UseItemOnTarget", HEADS, SHAFTS], "difficulty 5 before Broad (10)");
  fail();
  f.until(() => f.host.actions("UseItemOnTarget").length === 2, FIGHT(), 300);
  assert.deepEqual(f.host.calls.at(-1), ["UseItemOnTarget", HEADS, SHAFTS], "one failure: same heads again");
  fail();
  f.until(() => f.host.actions("UseItemOnTarget").length === 3, FIGHT(), 300);
  assert.deepEqual(f.host.calls.at(-1), ["UseItemOnTarget", 0x80002006, SHAFTS], "two failures: those heads parked, the Broad heads next");
  assert.equal(f.ammo.status().craftFails, 2);
  assert.ok(f.ammo.status().parked.includes("heads:4586"));
});

await run.check("craft resends: \"You're too busy\" → again after 2 s; silence → after 5 s only while neither bundle moved; 15 s → crafting parked 60 s", () => {
  const w = world({ inv: [bow(), heads(), shafts()] });
  w.until(() => w.host.actions("UseItemOnTarget").length === 1);
  const sentAt = w.clock.t;
  w.host.answer();
  w.bus.emit({ type: "useFailed", code: 0x1d, text: "You're too busy!" });
  w.until(() => w.host.actions("UseItemOnTarget").length === 2, FIGHT(), 100);
  const busyGap = w.clock.t - sentAt;
  assert.ok(busyGap >= T.CRAFT_RETRY_MS && busyGap < T.CRAFT_RETRY_MS + 300, `too busy → resend after ${busyGap} ms`);
  // Silence: a resend 5 s later.
  const t2 = w.clock.t;
  w.until(() => w.host.actions("UseItemOnTarget").length === 3, FIGHT(), 100);
  const gap = w.clock.t - t2;
  assert.ok(gap >= T.CRAFT_SILENT_RETRY_MS && gap < T.CRAFT_SILENT_RETRY_MS + 300, `silent → resend after ${gap} ms`);
  // The shafts moved (the combine went through, its result lost): never resent.
  w.row(SHAFTS).stackSize -= 1;
  const n = w.host.actions("UseItemOnTarget").length;
  for (let i = 0; i < 90; i++) w.drive(FIGHT(), 100);
  assert.equal(w.host.actions("UseItemOnTarget").length, n, "a combine that went through is not sent twice");
  assert.equal(w.slot.pinned(), false, "15 s from the first send: given up");
  assert.ok(w.ammo.status().parked.includes("craft"));
  for (let i = 0; i < 50; i++) w.drive(FIGHT(), 1000);
  assert.equal(w.host.actions("UseItemOnTarget").length, n, "crafting parked 60 s");
  for (let i = 0; i < 20; i++) w.drive(FIGHT(), 1000);
  assert.ok(w.host.actions("UseItemOnTarget").length > n, "and tried again after it");
});

await run.check("a cast's refusal during a combine is the cast's (host.castOwner(), else the raw cast token): no resend, the combine lands once", () => {
  const busy = (w) => w.bus.emit({ type: "useFailed", code: 0x1d, text: "You're too busy!" });
  // Vitals casts into ACE's crafting busy state; the combine (slower than the
  // old 2 s retry) lands afterwards.
  const w = world({ inv: [bow(), heads(), shafts()] });
  w.until(() => w.host.actions("UseItemOnTarget").length === 1);
  w.host.castOwner = () => "vitals";
  busy(w);
  for (let i = 0; i < 25; i++) w.drive(FIGHT(), 100);
  assert.equal(w.host.actions("UseItemOnTarget").length, 1, "2.5 s on: the vitals refusal was not taken as the combine's");
  w.host.castOwner = () => null;
  w.made();
  w.until(() => w.host.actions("WieldItem").length === 1, FIGHT(), 300);
  assert.deepEqual(w.host.calls.at(-1), ["WieldItem", PRODUCT, EM_AMMO]);
  assert.equal(w.host.actions("UseItemOnTarget").length, 1, "one combine, one pair of bundles");

  // A host without castOwner(): the raw cast token names the caster.
  const r = world({ inv: [bow(), heads(), shafts()] });
  r.until(() => r.host.actions("UseItemOnTarget").length === 1);
  assert.equal(r.host.tryClaimCast("helpers"), true);
  r.host.useDone(); // resolved (no cast in flight to wait for) — the raw token still names it
  busy(r);
  for (let i = 0; i < 25; i++) r.drive(FIGHT(), 100);
  assert.equal(r.host.actions("UseItemOnTarget").length, 1, "the helper's refusal");
});

await run.check("a genuine \"too busy\" for the combine still retries — only once the send was answered, both stacks are untouched and no product showed", () => {
  const busy = (w) => w.bus.emit({ type: "useFailed", code: 0x1d, text: "You're too busy!" });
  // castOwner() null (nobody cast lately) outranks a stale raw token: the refusal is ours.
  const g = world({ inv: [bow(), heads(), shafts()] });
  g.until(() => g.host.actions("UseItemOnTarget").length === 1);
  const sentAt = g.clock.t;
  g.host.tryClaimCast("vitals");
  g.host.useDone(); // that cast resolved long ago
  g.host.castOwner = () => null;
  busy(g);
  g.until(() => g.host.actions("UseItemOnTarget").length === 2, FIGHT(), 100);
  const gap = g.clock.t - sentAt;
  assert.ok(gap >= T.CRAFT_RETRY_MS && gap < T.CRAFT_RETRY_MS + 300, `resent after ${gap} ms`);

  // The first combine went through after all (a bundle moved) before the retry: never resent.
  const m = world({ inv: [bow(), heads(), shafts()] });
  m.until(() => m.host.actions("UseItemOnTarget").length === 1);
  busy(m);
  m.drive(FIGHT(), 1000);
  m.row(SHAFTS).stackSize -= 1;
  for (let i = 0; i < 30; i++) m.drive(FIGHT(), 100);
  assert.equal(m.host.actions("UseItemOnTarget").length, 1, "a moved bundle blocks the retry");

  // …or the heads stack moved.
  const h = world({ inv: [bow(), heads(), shafts()] });
  h.until(() => h.host.actions("UseItemOnTarget").length === 1);
  busy(h);
  h.drive(FIGHT(), 1000);
  h.row(HEADS).stackSize -= 1;
  for (let i = 0; i < 30; i++) h.drive(FIGHT(), 100);
  assert.equal(h.host.actions("UseItemOnTarget").length, 1);

  // A peace-mode refusal resends at once in NonCombat — but not once a bundle moved.
  const p = world({ inv: [bow(), heads(), shafts()] });
  p.until(() => p.host.actions("UseItemOnTarget").length === 1);
  p.row(SHAFTS).stackSize -= 1;
  p.bus.emit({ type: "useFailed", code: 0x043a, text: "" });
  for (let i = 0; i < 20; i++) p.drive(FIGHT(), 100);
  assert.equal(p.host.actions("UseItemOnTarget").length, 1, "peace-mode resend guarded too");

  // A resend waits for another module's cast in flight.
  const c = world({ inv: [bow(), heads(), shafts()] });
  c.until(() => c.host.actions("UseItemOnTarget").length === 1);
  busy(c); // ours: nobody cast yet
  c.drive(FIGHT(), 100);
  assert.equal(c.host.tryClaimCast("vitals"), true); // vitals starts a cast before the retry
  for (let i = 0; i < 30; i++) c.drive(FIGHT(), 100);
  assert.equal(c.host.actions("UseItemOnTarget").length, 1, "not into the cast");
  c.host.useDone(); // the cast resolves
  c.drive(FIGHT(), 100);
  assert.equal(c.host.actions("UseItemOnTarget").length, 2, "then resent");
});

await run.check("craft safety: untrained Fletching → no combine; under 50 % skipped for easier heads; wrapped heads + plain shafts → nothing; \"cannot be used on\" parks the pair", () => {
  const u = world({ inv: [bow(), heads(), shafts()], skills: { 37: { current: 10, base: 10, training: 1 } } });
  for (let i = 0; i < 20; i++) u.drive(FIGHT(), 300);
  assert.deepEqual(u.host.calls, []);
  assert.match(u.ammo.status().note, /Fletching is not trained/);

  const deadly = heads(0x80002004, "Bundle of Deadly Arrowheads", 15411);
  const hard = world({ inv: [bow(), deadly, shafts()], skills: { 37: { current: 50, base: 50, training: 2 } } });
  for (let i = 0; i < 20; i++) hard.drive(FIGHT(), 300);
  assert.deepEqual(hard.host.calls, [], "≈5 % — a failed combine destroys both bundles");
  assert.match(hard.ammo.status().note, /too low/);
  const easy = world({ inv: [bow(), deadly, heads(), shafts()], skills: { 37: { current: 50, base: 50, training: 2 } } });
  easy.until(() => easy.host.calls.length > 0);
  assert.deepEqual(easy.host.calls.at(-1), ["UseItemOnTarget", HEADS, SHAFTS], "the basic heads (≈79 %)");

  const wrapped = world({ inv: [bow(), heads(0x80002005, "Wrapped Bundle of Arrowheads", 9359), shafts()] });
  for (let i = 0; i < 20; i++) wrapped.drive(FIGHT(), 300);
  assert.deepEqual(wrapped.host.calls, [], "no recipe for that pair");
  assert.match(wrapped.ammo.status().note, /nothing to fletch/);

  const nr = world({ inv: [bow(), heads(), shafts()] });
  nr.until(() => nr.host.calls.length > 0);
  nr.bus.emit({ type: "chat", text: "The Bundle of Arrowheads cannot be used on the Bundle of Arrowshafts.", chatType: 0, cat: CAT_CRAFT });
  nr.host.useDone();
  nr.bus.emit({ type: "useDone" });
  for (let i = 0; i < 40; i++) nr.drive(FIGHT(), 300);
  assert.equal(nr.host.actions("UseItemOnTarget").length, 1, "that pair is skipped");
  assert.ok(nr.ammo.status().parked.includes("pair:4586:4585"));
  // A Craft line spoken by a player never counts.
  const sp = world({ inv: [bow(), heads(), shafts()] });
  sp.until(() => sp.host.calls.length > 0);
  sp.bus.emit({ type: "chat", text: "The Bundle of Arrowheads cannot be used on the Bundle of Arrowshafts.", chatType: 0, cat: 1 });
  sp.bus.emit({ type: "chat", text: "You fail to make any arrows.", chatType: 0, cat: 1 });
  sp.drive(FIGHT());
  assert.equal(sp.slot.pinned(), true, "speech is ignored: still waiting for the combine");
});

await run.check("the chance-of-success dialog of OUR combine: yes at ≥ 50 %, no below (those heads parked); a dialog pending before the send is left alone", () => {
  const w = world({ inv: [bow(), heads(), shafts()] });
  w.host.confirms = [{ confirmType: 5, context: 50, text: "You determine that you have a 30 percent chance to succeed." }];
  w.until(() => w.host.calls.length > 0);
  w.host.confirms.push({ confirmType: 5, context: 77, text: "You determine that you have a 99 percent chance to succeed." });
  w.host.useDone();
  w.bus.emit({ type: "useDone" });
  w.drive(FIGHT());
  assert.deepEqual(w.host.actions("SendConfirmationResponse"), [["SendConfirmationResponse", 5, 77, true]], "only the new dialog, answered yes");
  w.made();
  w.until(() => w.host.actions("WieldItem").length === 1, FIGHT(), 300);

  const no = world({ inv: [bow(), heads(), shafts()] });
  no.until(() => no.host.calls.length > 0);
  no.host.confirms.push({ confirmType: 5, context: 78, text: "You determine that you have a 20 percent chance to succeed." });
  no.drive(FIGHT());
  assert.deepEqual(no.host.actions("SendConfirmationResponse"), [["SendConfirmationResponse", 5, 78, false]]);
  assert.equal(no.slot.pinned(), false);
  for (let i = 0; i < 30; i++) no.drive(FIGHT(), 300);
  assert.equal(no.host.actions("UseItemOnTarget").length, 1, "those heads are skipped");
});

await run.check("loot / buff in flight: without a fight the refill waits for it; with one it goes first", () => {
  const w = world({ inv: [bow(), arrows(ARROWS, 1, { equipMask: EM_AMMO }), arrows(ARROWS2, 500)] });
  w.drive();
  w.lastArrow(ARROWS);
  w.clock.advance(100);
  assert.equal(w.slot.wants(F.ctx({ lootPinned: true })), false, "a corpse being looted finishes first");
  assert.equal(w.slot.wants(F.ctx({ buffPinned: true })), false, "a buff cast in flight finishes first");
  assert.equal(w.slot.wants(F.ctx({ lootPinned: true, inCombat: true })), true, "a fight needs the ammo now");
  assert.equal(w.slot.wants(F.ctx()), true);
  // Busy / another owner's item action / portal space: wait.
  w.host.busy = 1;
  assert.equal(w.slot.wants(F.ctx()), false, "busy");
  w.host.busy = 0;
  assert.equal(w.host.tryClaimItemAction("vtloadout"), true);
  assert.equal(w.slot.wants(F.ctx()), false, "another item action in flight");
  w.host.answer();
  w.host.portal = true;
  assert.equal(w.slot.wants(F.ctx()), false, "portal space");
  w.host.portal = false;
  assert.equal(w.slot.wants(F.ctx()), true);
});

// ── the real kernel ───────────────────────────────────────────────────────
await run.check("kernel: beforeCombatPinned takes the tick from a pinned fight (keepsCombatLoop: disengage without cancel, no combat.tick); Vitals still first; back to Combat once the stack is in; stop() drops the job", () => {
  const w = world({ inv: [bow(), arrows(ARROWS, 1, { equipMask: EM_AMMO }), arrows(ARROWS2, 500)] });
  const klog = [];
  const ks = { vitals: false };
  const khost = { IsPlayerReady: () => true, StopStick: () => klog.push("host.StopStick"), StopCompletely: () => {}, onTick: () => {} };
  const combat = {
    locked: 0x7001,
    kills: 0,
    status: { state: "ATTACK" },
    _scanTargets: () => [{ guid: 0x7001, dist: 10 }],
    tick: () => klog.push("combat.tick"),
    canEngage: () => true,
    underAttack: () => true,
    disengage: (o) => klog.push(`combat.disengage:${o && o.cancelAttack}`),
  };
  const vitals = { enabled: true, status: {}, step: () => ks.vitals };
  const aux = { slots: [w.slot], idleHooks: [], policy: { boostLoot: () => false } };
  const k = new RynthBotKernel(khost, { combat, buff: null, loot: null, vitals, unwedge: null, aux }, { log: () => {} });
  k.start();
  const tick = (ms = 100) => {
    w.clock.advance(ms);
    k.tick();
  };
  tick();
  assert.equal(k.action, "Combat", "ammo in the slot: the slot is invisible");
  w.lastArrow(ARROWS);
  klog.length = 0;
  tick();
  assert.equal(k.action, "Ammo");
  assert.deepEqual(klog, ["combat.disengage:false"], "borrowed like a Vitals heal: ACE's attack loop is not cancelled");
  assert.deepEqual(w.host.calls, [["WieldItem", ARROWS2, EM_AMMO]]);
  ks.vitals = true;
  tick();
  assert.equal(k.action, "Vitals", "a heal still preempts");
  ks.vitals = false;
  tick();
  assert.equal(k.action, "Ammo", "the wield in flight pins the slot");
  assert.ok(!klog.includes("combat.tick"), "no combat tick (no toggle spent) while the refill runs");
  w.landWield(ARROWS2);
  tick();
  assert.equal(k.action, "Combat", "the fight resumes on the same lock");
  assert.equal(klog.at(-1), "combat.tick");

  // stop() mid-wield: the job is dropped and the token released.
  w.host.inv.push(arrows(0x80001009, 300));
  w.lastArrow(ARROWS2);
  tick(T.ACTION_GAP_MS);
  assert.equal(k.action, "Ammo");
  assert.equal(w.host.itemActionToken.owner, "vtammo");
  k.stop();
  assert.equal(w.ammo.status().job, null);
  assert.equal(w.host.itemActionToken, null);
});

// ── robustness ────────────────────────────────────────────────────────────
await run.check("never throws: a host whose every member throws, a throwing subscribe and options; dispose releases the token and unsubscribes", () => {
  const clock = F.makeClock();
  const boom = new Proxy(
    {},
    {
      get: () => () => {
        throw new Error("boom");
      },
    }
  );
  const options = { getValue: () => { throw new Error("opt"); } };
  const a = A.createAmmo({ host: boom, bot: boom, options, subscribe: () => { throw new Error("sub"); }, now: clock.now, log: () => {} });
  assert.equal(a.slot.enabled(), false);
  assert.equal(a.slot.pinned(), false);
  assert.equal(a.slot.wants(F.ctx({ inCombat: true })), false);
  a.slot.tick(F.ctx());
  a.slot.onLeave("Stopped");
  assert.equal(typeof a.status(), "object");
  a.dispose();

  const w = world({ inv: [bow(), arrows(ARROWS2, 500)] });
  assert.ok(w.bus.count("chat") === 1 && w.bus.count("equip") === 1);
  w.until(() => w.host.calls.length > 0);
  assert.equal(w.host.itemActionToken.owner, "vtammo");
  w.ammo.dispose();
  assert.equal(w.host.itemActionToken, null, "dispose releases the token");
  for (const s of ["chat", "equip", "inventory", "useFailed", "useDone"]) assert.equal(w.bus.count(s), 0, `${s} unsubscribed`);
  assert.equal(w.slot.enabled(), false);
});

console.log(run.fail === 0 ? `rynth_vt_support_ammo: all ${run.pass} checks passed` : `rynth_vt_support_ammo: ${run.fail} FAILED (${run.pass} passed)`);
process.exit(run.fail === 0 ? 0 : 1);
