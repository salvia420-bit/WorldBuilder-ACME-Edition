// tests/rynth_vt_support_helpers.test.mjs — rynth/vt/support/helpers.js, the
// "Helpers" kernel slot (VTank DoHelp / "… others at" / HelperDistance* /
// UseHealersHeart / JumpOutWandCasting, 2026-10-19).
//
// The fellow-vitals stream hold (FellowshipHoldUpdates: once while wanted,
// released exactly once on operator hold, leaving, DoHelp off and dispose; the
// page panel's share of the count untouched), fresh-vitals gating, the vital
// order and thresholds, distances and spell ranges, the ladder-position tier
// pick (+ the opt-in Life Magic cap), Magic-mode entry, pacing, refusal
// back-offs and demotions, the Healer's Heart (wield → Magic → use, the
// hand-back, the jump-out), the stale-reading guard, and the slot under the
// REAL kernel (after Supplies, before Combat, keeps ACE's attack loop).
//
// Everything outside rynth/vt/support/ is a fake (C2): the shared support
// fakes (rynth/testdata/vt/support/fakes.mjs) plus, here, the host members
// the helper reads that those fakes predate (TryGetFellowship,
// FellowshipHoldUpdates, CastSpellAt, WieldItem, Jump, CanJumpNow).
//
// Run from apps/holtburger-web/:  node tests/rynth_vt_support_helpers.test.mjs

import assert from "node:assert/strict";

const F = await import("../rynth/testdata/vt/support/fakes.mjs");
const H = await import("../rynth/vt/support/helpers.js");
const { RynthBotKernel } = await import("../rynth/kernel.js");

const run = F.makeRunner();

const ME = 0x50000001;
const BOB = 0x50000002;
const ANN = 0x50000003;
const CID = 0x50000004;
const WAND = 0x80005001;
const HEART = 0x80005002;
const SWORD = 0x80005003;
const SHIELD = 0x80005004;
const AXE = 0x80005005;
const MOB = 0x80006001;
const HELD = 0x01000000;
const MELEE = 0x00100000;
const SHIELD_SLOT = 0x00200000;
const HEAL = H.HELPER_LADDERS.heal;

const member = (guid, name, { hp = 100, sp = 100, mp = 100, max = 100 } = {}) => ({
  guid, name, level: 80, health: hp, maxHealth: max, stamina: sp, maxStamina: max, mana: mp, maxMana: max,
});
const wandRow = () => F.row(WAND, "Wand", { itemType: 0x8000, equipMask: HELD, validLocations: HELD });
const heartRow = (equipMask = 0) => F.row(HEART, "The Healer's Heart", { wcid: 8552, itemType: 0x8000, equipMask, validLocations: HELD });
const swordRow = (equipMask = MELEE) => F.row(SWORD, "Sword", { itemType: 0x1, equipMask, validLocations: MELEE });
const shieldRow = (equipMask = SHIELD_SLOT) => F.row(SHIELD, "Shield", { itemType: 0x2, equipMask, validLocations: SHIELD_SLOT });
const HEART_ITEM = { guid: HEART, name: "The Healer's Heart", wcid: 8552, kind: "caster" };

function world({ values = {}, members = undefined, inv = undefined, items = [], known = [...HEAL], mode = 8, refs = 0, dist = {}, state = undefined, subscribe = true, castOwner = true, print = undefined } = {}) {
  const clock = F.makeClock();
  const host = F.makeHost(clock, { me: ME });
  host.inv = inv ?? [wandRow()];
  host.known = known;
  host.mode = mode;
  host.fsSnap = members === null ? null : { name: "Grinders", leaderGuid: ME, open: false, shareXp: true, members: members ?? [member(ME, "Tester"), member(BOB, "Bob")] };
  host.refs = refs; // the page-wide hold count (globalThis.__hbFellowUpdateRefs)
  host.requests = []; // FellowshipRequestUpdates on the wire (count 0 ↔ 1)
  host.canJump = true;
  host.chat = []; // local chat lines (WriteToChatWindow): output, not an action
  for (const g of [BOB, ANN, CID]) host.dist.set(g, 10);
  for (const [g, d] of Object.entries(dist)) {
    if (d == null) host.dist.delete(Number(g));
    else host.dist.set(Number(g), d);
  }
  host.setDid(HEART, 28, 1166); // the heart's own spell: Heal Other VI
  const rec = (...c) => {
    host.calls.push(c);
    return host.sendOk;
  };
  Object.assign(host, {
    TryGetFellowship: () => (host.fsSnap ? JSON.parse(JSON.stringify(host.fsSnap)) : null),
    FellowshipHoldUpdates(on) {
      const before = host.refs;
      host.refs = Math.max(0, before + (on ? 1 : -1));
      host.calls.push(["FellowshipHoldUpdates", !!on]);
      if (before === 0 && host.refs > 0) host.requests.push(true);
      else if (before > 0 && host.refs === 0) host.requests.push(false);
      return host.refs;
    },
    CastSpellAt: (g, id) => rec("CastSpellAt", g >>> 0, id >>> 0),
    WieldItem: (g, m) => rec("WieldItem", g >>> 0, m >>> 0),
    UnwieldItem: (g) => rec("UnwieldItem", g >>> 0),
    Jump: (p) => rec("Jump", p),
    CanJumpNow: () => host.canJump,
    WriteToChatWindow: (text) => (host.chat.push(String(text)), true),
  });
  // rynth/webhost.js castOwner(): the live claim's owner, else the last
  // claim's (cleared by its UseDone, or released early) while it is < 6 s old.
  const releaseCast = host.releaseCast;
  host.releaseCast = (owner) => {
    if (host._cast && host._cast.owner === owner) host._lastCast = { ...host._cast };
    releaseCast(owner);
  };
  if (castOwner) {
    host.castOwner = () => {
      const c = host._cast;
      const t = clock.now();
      if (c && c.useDoneAtIssue === host.useDoneSeq && t - c.issuedAt <= 12000) return c.owner;
      const last = c || host._lastCast;
      return last && t - last.issuedAt <= 6000 ? last.owner : null;
    };
  }
  const options = F.makeOptions(values, { items });
  const bus = F.makeBus();
  const combat = F.makeCombat();
  combat.disengages = [];
  combat.disengage = (o) => combat.disengages.push(o);
  const bot = { combat };
  const logs = [];
  const deps = { host, bot, options, subscribe: subscribe ? bus.on : null, items: F.makeItems(items), now: clock.now, log: (m) => logs.push(m) };
  if (state) deps.state = state;
  if (print) deps.print = print;
  const h = H.createHelpers(deps);
  const slot = h.slot;
  // One kernel tick through the afterVitals rank (pinned first, then wants).
  const tick = () => {
    clock.advance(100);
    if (!slot.enabled()) return false;
    if (slot.pinned() || slot.wants(F.ctx({ now: clock.t }))) {
      slot.tick(F.ctx({ now: clock.t }));
      return true;
    }
    return false;
  };
  // The VT post-tick (2 Hz): the stream hold.
  const post = (held = false) => h.reflex.tick(clock.t, { held, kernelAction: "Idle", running: !held });
  // Hold the stream and let the server's answer arrive: vitals are fresh.
  const ready = () => {
    post();
    bus.emit({ type: "fellowship" });
  };
  // The server's UseDone for our action (the seam's seq + the signal).
  const answer = () => {
    host.useDone();
    bus.emit({ type: "useDone" });
  };
  // ACE's caster line for a heal that landed (it precedes the UseDone).
  const healed = (name = "Bob", pts = 100, spell = "Heal Other VI") =>
    bus.emit({ type: "chat", text: `With ${spell} you restore ${pts} points of health to ${name}.`, chatType: 0, cat: 0 });
  const setMember = (guid, patch) => {
    host.fsSnap.members = host.fsSnap.members.map((m) => (m.guid === guid ? { ...m, ...patch } : m));
    bus.emit({ type: "fellowship" });
    clock.advance(300); // the snapshot is re-read ≤ 250 ms after an update
  };
  // Tick until a new `name` action appears (or `max` ticks): the new call or null.
  const until = (name, max = 40) => {
    const n = host.actions(name).length;
    for (let i = 0; i < max; i++) {
      tick();
      const a = host.actions(name);
      if (a.length > n) return a.at(-1);
    }
    return null;
  };
  return { clock, host, options, bus, combat, bot, logs, deps, h, slot, tick, post, ready, answer, healed, setMember, until };
}

// ── shape, inertness, the vitals stream ──────────────────────────────────
await run.check("every option read is a live schema row with the owner's default (the module's fallbacks agree)", async () => {
  const SCH = await import("../rynth/vt/settings/schema.js");
  const d = SCH.defaults();
  const want = {
    DoHelp: true, HealOthersAt: 50, RestamOthersAt: 10, InfuseOthersAt: 10, HelperHealDistance: 30, HelperRestamDistance: 30,
    HelperInfuseDistance: 30, UseHealersHeart: true, JumpOutWandCasting: false, BuffTierSkillCap: false,
  };
  for (const [k, v] of Object.entries(want)) assert.equal(d[k], v, k);
  for (let i = 1; i <= 8; i++) assert.ok(`BuffMinSkillLevelTier${i}` in d, `BuffMinSkillLevelTier${i}`);
  assert.ok(SCH.LIST_KEYS.includes("items"));
});

await run.check("slot shape; inert without a fellowship or with DoHelp off — no hold, no host action", () => {
  const w = world({ members: null });
  assert.equal(w.slot.name, "Helpers");
  assert.equal(w.slot.rank, "afterVitals");
  assert.equal(w.slot.keepsCombatLoop, true);
  assert.equal(w.slot.enabled(), false);
  for (let i = 0; i < 30; i++) {
    w.post();
    w.tick();
  }
  assert.deepEqual(w.host.calls, [], "not in a fellowship");
  assert.equal(w.h.reflex.enabled(), false);
  const off = world({ values: { DoHelp: false }, members: [member(ME, "Tester"), member(BOB, "Bob", { hp: 5 })] });
  assert.equal(off.slot.enabled(), false);
  for (let i = 0; i < 30; i++) {
    off.post();
    off.bus.emit({ type: "fellowship" });
    off.tick();
  }
  assert.deepEqual(off.host.calls, [], "DoHelp off");
  for (const k of ["enabled", "holding", "fresh", "inFlight", "casts", "heartUses", "jumps", "handBack", "castBlocked", "backedOff"]) assert.ok(k in w.h.status(), k);
  assert.equal(w.slot.status.enabled, false);
});

await run.check("the vitals stream: held once while wanted; released exactly once on operator hold, leaving, DoHelp off and dispose", () => {
  const w = world();
  const holds = () => w.host.actions("FellowshipHoldUpdates").map((c) => c[1]);
  w.post();
  w.post();
  w.post();
  assert.deepEqual(holds(), [true], "one hold, however many post-ticks");
  assert.equal(w.h.status().holding, true);
  assert.deepEqual(w.host.requests, [true], "0 → 1 asks the server");
  w.post(true); // operator STOP
  w.post(true);
  assert.deepEqual(holds(), [true, false], "released once while held");
  w.post(); // RESUME
  assert.deepEqual(holds(), [true, false, true]);
  w.host.fsSnap = null; // left the fellowship
  w.bus.emit({ type: "fellowship" });
  w.clock.advance(300);
  w.post();
  w.post();
  assert.deepEqual(holds(), [true, false, true, false], "leaving releases");
  assert.equal(w.slot.enabled(), false);
  w.host.fsSnap = { name: "F", leaderGuid: BOB, open: true, members: [member(ME, "Tester"), member(BOB, "Bob")] };
  w.bus.emit({ type: "fellowship" });
  w.clock.advance(300);
  w.post();
  assert.deepEqual(holds(), [true, false, true, false, true], "joining again holds again");
  w.options.set("DoHelp", false);
  w.post();
  assert.deepEqual(holds().length, 6, "DoHelp off releases");
  w.options.set("DoHelp", true);
  w.post();
  w.h.dispose();
  w.h.dispose();
  w.post();
  assert.deepEqual(holds(), [true, false, true, false, true, false, true, false], "dispose releases once; nothing after it");
  assert.equal(w.host.refs, 0, "the shared count is balanced");
  // The page's fellowship panel already holds the stream: no wire request of
  // ours, and our release leaves the panel's share in place.
  const p = world({ refs: 1 });
  p.post();
  assert.equal(p.host.refs, 2);
  assert.equal(p.h.status().fresh, false, "fresh only after an update that follows our hold");
  p.bus.emit({ type: "fellowship" });
  assert.equal(p.h.status().fresh, true);
  p.h.dispose();
  assert.equal(p.host.refs, 1);
  assert.deepEqual(p.host.requests, [], "the panel's stream was never switched");
});

await run.check("fresh vitals only: no help until a fellowship update arrives after the hold (5 s fallback without one)", () => {
  const w = world({ members: [member(ME, "Tester"), member(BOB, "Bob", { hp: 30 })] });
  for (let i = 0; i < 5; i++) w.tick();
  assert.equal(w.host.actions("CastSpellAt").length, 0, "no hold yet: the join snapshot is stale");
  w.post();
  for (let i = 0; i < 5; i++) w.tick();
  assert.equal(w.host.actions("CastSpellAt").length, 0, "held, no update yet");
  assert.equal(w.h.status().fresh, false);
  w.bus.emit({ type: "fellowship" });
  assert.deepEqual(w.until("CastSpellAt", 3), ["CastSpellAt", BOB, 4310]);
  const q = world({ members: [member(ME, "Tester"), member(BOB, "Bob", { hp: 30 })], subscribe: false });
  q.post();
  for (let i = 0; i < 45; i++) q.tick();
  assert.equal(q.host.actions("CastSpellAt").length, 0, "4.5 s without a signal");
  assert.ok(q.until("CastSpellAt", 10), "after FRESH_FALLBACK_MS");
});

// ── who, what, which tier ─────────────────────────────────────────────────
await run.check("health: the lowest-percentage fellow within HelperHealDistance below HealOthersAt (strict <); unknown distance and yourself skipped; TARGETED cast under the token 'helpers'", () => {
  const members = [
    member(ME, "Tester", { hp: 5 }), // yourself: never
    member(BOB, "Bob", { hp: 40 }),
    member(ANN, "Ann", { hp: 30 }),
    member(CID, "Cid", { hp: 20 }), // out of range
    member(0x50000005, "Dee", { hp: 50 }), // not < 50
    member(0x50000006, "Eve", { hp: 10 }), // distance unknown
  ];
  const w = world({ members, dist: { [CID]: 45, 0x50000005: 5, 0x50000006: null } });
  w.ready();
  assert.deepEqual(w.until("CastSpellAt"), ["CastSpellAt", ANN, 4310]);
  assert.equal(w.host.castToken.owner, "helpers");
  for (const c of w.host.calls) assert.ok(!["CastSelf", "CastUntargetedSafe"].includes(c[0]), `never ${c[0]}`);
  w.answer();
  assert.deepEqual(w.until("CastSpellAt"), ["CastSpellAt", BOB, 4310], "then the next lowest");
  const r = world({ values: { HelperHealDistance: 50 }, members, dist: { [CID]: 45 } });
  r.ready();
  assert.deepEqual(r.until("CastSpellAt"), ["CastSpellAt", CID, 4310], "a wider helper distance reaches Cid");
});

await run.check("tier by LADDER position: Adja's Gift (VII) over Heal Other VI though the catalog calls it level 1; Incantation highest; nothing known ⇒ nothing", () => {
  const mk = (known) => {
    const w = world({ known, members: [member(ME, "Tester"), member(BOB, "Bob", { hp: 30 })] });
    w.ready();
    return w.until("CastSpellAt", 10);
  };
  assert.deepEqual(mk([5, 1162, 1166, 2072]), ["CastSpellAt", BOB, 2072]);
  assert.deepEqual(mk([1163, 4310, 5]), ["CastSpellAt", BOB, 4310]);
  assert.deepEqual(mk([5]), ["CastSpellAt", BOB, 5]);
  assert.equal(mk([6, 1157]), null, "Heal Self is not a helper spell");
  assert.equal(H.pickTier(HEAL, new Set([1166, 2072]), 6), 1166, "cap 6 ⇒ VI");
  assert.equal(H.pickTier(HEAL, new Set([2072]), 3), 2072, "nothing within the cap ⇒ the highest known");
  assert.equal(H.pickTier(HEAL, new Set([1165, 2072]), Infinity, (id) => id === 2072), 1165, "demoted ⇒ next lower");
  assert.equal(H.pickTier(HEAL, new Set(), Infinity), 0);
});

await run.check("Life Magic tier cap (BuffTierSkillCap + BuffMinSkillLevelTier1..8): the highest known tier the skill reaches", () => {
  const mk = (values) => {
    const w = world({ values, members: [member(ME, "Tester"), member(BOB, "Bob", { hp: 30 })] });
    w.host.stats.skills = { 33: { current: 200, base: 200, ranks: 150, training: 2 } };
    w.ready();
    return w.until("CastSpellAt", 10);
  };
  assert.deepEqual(mk({ BuffTierSkillCap: true }), ["CastSpellAt", BOB, 1164], "200 ≥ 185 (tier 4) < 235");
  assert.deepEqual(mk({ BuffTierSkillCap: true, BuffMinSkillLevelTier5: 150, BuffMinSkillLevelTier6: 190 }), ["CastSpellAt", BOB, 1166], "custom thresholds");
  assert.deepEqual(mk({}), ["CastSpellAt", BOB, 4310], "off (default): the highest known");
});

await run.check("vital order health → stamina → mana; '… others at' 0 disables; Mana Boost Other, else Infuse Mana Other; pacing is per fellow", () => {
  const known = [...HEAL, 1183, 1188, 1207, 9, 2336];
  // Three fellows, one vital each, the lowest percentages on the LAST vitals.
  const members = () => [member(ME, "Tester"), member(CID, "Cid", { mp: 2 }), member(ANN, "Ann", { sp: 3 }), member(BOB, "Bob", { hp: 45 })];
  const w = world({ known, members: members() });
  w.ready();
  assert.deepEqual(w.until("CastSpellAt"), ["CastSpellAt", BOB, 4310], "health first");
  w.answer();
  assert.deepEqual(w.until("CastSpellAt"), ["CastSpellAt", ANN, 1188], "then stamina (RestamOthersAt 10)");
  w.answer();
  assert.deepEqual(w.until("CastSpellAt"), ["CastSpellAt", CID, 1207], "then mana: Mana Boost Other");
  w.answer();
  const inf = world({ known: [9, 1255, 2336], members: members() });
  inf.ready();
  assert.deepEqual(inf.until("CastSpellAt"), ["CastSpellAt", CID, 2336], "no Mana Boost Other known ⇒ Gift of Essence (Heal / Revitalize Other unknown)");
  const z = world({ known, values: { HealOthersAt: 0, RestamOthersAt: 0 }, members: members() });
  z.ready();
  assert.deepEqual(z.until("CastSpellAt"), ["CastSpellAt", CID, 1207], "health and stamina disabled");
  const none = world({ known, values: { HealOthersAt: 0, RestamOthersAt: 0, InfuseOthersAt: 0 }, members: members() });
  none.ready();
  assert.equal(none.until("CastSpellAt", 10), null, "every vital disabled");
  // One fellow low on health AND stamina: health first; the same fellow's
  // stamina waits for its pacing (≥ 2 s after the heal was sent).
  const both = world({ known, members: [member(ME, "Tester"), member(BOB, "Bob", { hp: 45, sp: 5 })] });
  both.ready();
  assert.deepEqual(both.until("CastSpellAt"), ["CastSpellAt", BOB, 4310]);
  const t0 = both.clock.t;
  both.answer();
  both.setMember(BOB, { health: 90 });
  assert.deepEqual(both.until("CastSpellAt"), ["CastSpellAt", BOB, 1188]);
  assert.ok(both.clock.t - t0 >= 2000, `restam ${both.clock.t - t0} ms after the heal`);
});

await run.check("spell range: a fellow beyond the spell's DAT range (BaseRangeConstant + skill × BaseRangeMod) is skipped", () => {
  const w = world({ members: [member(ME, "Tester"), member(BOB, "Bob", { hp: 20 }), member(ANN, "Ann", { hp: 40 })], dist: { [BOB]: 20, [ANN]: 12 } });
  w.host.spells.set(4310, { id: 4310, name: "Incantation of Heal Other", category: 79, baseRangeConstant: 5, baseRangeMod: 0.1 });
  w.host.stats.skills = { 33: { current: 300, base: 250, ranks: 100, training: 2 } }; // range 5 + 100 × 0.1 = 15 m
  w.ready();
  assert.deepEqual(w.until("CastSpellAt"), ["CastSpellAt", ANN, 4310], "Bob (20 m) is beyond 15 m");
  const s = world({ members: [member(ME, "Tester"), member(BOB, "Bob", { hp: 20 })], dist: { [BOB]: 20 } });
  s.host.spells.set(4310, { id: 4310, name: "Incantation of Heal Other", category: 79, baseRangeConstant: 5, baseRangeMod: 0.1 });
  s.host.stats.skills = { 33: { current: 300, base: 250, ranks: 140, training: 3 } }; // specialized: init 10 ⇒ 20 m
  s.ready();
  assert.deepEqual(s.until("CastSpellAt"), ["CastSpellAt", BOB, 4310]);
});

// ── casting: mode, pacing, refusals ───────────────────────────────────────
await run.check("Magic mode first (≤ 1 request per 3 s, the slot holds the tick meanwhile); no caster wielded ⇒ no mode thrash", () => {
  const w = world({ mode: 1, members: [member(ME, "Tester"), member(BOB, "Bob", { hp: 30 })] });
  w.ready();
  assert.equal(w.tick(), true);
  assert.deepEqual(w.host.calls.at(-1), ["ChangeCombatMode", 8]);
  assert.equal(w.tick(), true, "holds the tick while the mode change lands");
  assert.equal(w.host.actions("ChangeCombatMode").length, 1);
  w.host.mode = 8;
  assert.deepEqual(w.until("CastSpellAt", 3), ["CastSpellAt", BOB, 4310]);
  const nc = world({ mode: 2, inv: [swordRow()], members: [member(ME, "Tester"), member(BOB, "Bob", { hp: 30 })] });
  nc.ready();
  for (let i = 0; i < 20; i++) nc.tick();
  assert.equal(nc.host.actions("ChangeCombatMode").length, 0);
  assert.equal(nc.host.actions("CastSpellAt").length, 0);
  assert.equal(nc.h.status().castBlocked, "no-caster");
});

await run.check("pacing: one help in flight (pinned until the answer); a fellow again only ≥ 2 s after; another fellow meanwhile; another module's live cast waits", () => {
  const w = world({ members: [member(ME, "Tester"), member(BOB, "Bob", { hp: 30 }), member(ANN, "Ann", { hp: 40 })] });
  w.ready();
  assert.deepEqual(w.until("CastSpellAt"), ["CastSpellAt", BOB, 4310]);
  const t0 = w.clock.t;
  assert.equal(w.slot.pinned(), true);
  for (let i = 0; i < 5; i++) w.tick();
  assert.equal(w.host.actions("CastSpellAt").length, 1, "nothing while unresolved");
  w.answer();
  assert.equal(w.slot.pinned(), false, "the answer resolves");
  assert.deepEqual(w.until("CastSpellAt"), ["CastSpellAt", ANN, 4310], "Bob is paced: Ann");
  w.answer();
  const bob = w.until("CastSpellAt");
  assert.deepEqual(bob, ["CastSpellAt", BOB, 4310]);
  assert.ok(w.clock.t - t0 >= 2000, `Bob again after ${w.clock.t - t0} ms`);
  w.answer();
  // Another owner's unresolved cast claim holds us.
  const c = world({ members: [member(ME, "Tester"), member(BOB, "Bob", { hp: 30 })] });
  c.ready();
  c.host.tryClaimCast("combat");
  for (let i = 0; i < 10; i++) c.tick();
  assert.equal(c.host.actions("CastSpellAt").length, 0, "combat's cast is open");
  c.host.useDone();
  assert.ok(c.until("CastSpellAt", 5), "resolved ⇒ ours");
  // The pin is bounded with no answer at all.
  c.clock.advance(6100);
  assert.equal(c.slot.pinned(), false, "CAST_PIN_MAX_MS");
});

await run.check("refusals: out of range backs that fellow off 5 s; missing components hold every helper cast 60 s", () => {
  const w = world({ members: [member(ME, "Tester"), member(BOB, "Bob", { hp: 30 }), member(ANN, "Ann", { hp: 40 })] });
  w.ready();
  assert.deepEqual(w.until("CastSpellAt"), ["CastSpellAt", BOB, 4310]);
  w.bus.emit({ type: "useFailed", code: 0x0550, text: "" }); // MissileOutOfRange
  assert.deepEqual(w.until("CastSpellAt"), ["CastSpellAt", ANN, 4310]);
  assert.ok(w.h.status().backedOff.includes(String(BOB)));
  w.answer();
  w.clock.advance(5000);
  assert.deepEqual(w.until("CastSpellAt"), ["CastSpellAt", BOB, 4310], "after the back-off");
  w.bus.emit({ type: "useFailed", code: 0x0400, text: "" }); // YouDontHaveAllTheComponents
  assert.equal(w.h.status().castBlocked, "components");
  w.clock.advance(10_000);
  assert.equal(w.until("CastSpellAt", 20), null, "held");
  w.clock.advance(50_000);
  assert.ok(w.until("CastSpellAt", 5), "after 60 s");
});

await run.check("not in the spellbook drops that tier at once; three fizzles in a row drop it too", () => {
  const w = world({ known: [1165, 1166], members: [member(ME, "Tester"), member(BOB, "Bob", { hp: 30 })] });
  w.ready();
  assert.deepEqual(w.until("CastSpellAt"), ["CastSpellAt", BOB, 1166]);
  w.bus.emit({ type: "useFailed", code: 0x03fc, text: "" }); // MagicInvalidSpellType
  w.clock.advance(2000);
  assert.deepEqual(w.until("CastSpellAt"), ["CastSpellAt", BOB, 1165]);
  const f = world({ known: [1165, 1166], members: [member(ME, "Tester"), member(BOB, "Bob", { hp: 30 })] });
  f.ready();
  for (let i = 0; i < 3; i++) {
    assert.deepEqual(f.until("CastSpellAt"), ["CastSpellAt", BOB, 1166], `try ${i + 1}`);
    f.bus.emit({ type: "useFailed", code: 0x0402, text: "Your spell fizzled." });
    f.clock.advance(2000);
  }
  assert.deepEqual(f.until("CastSpellAt"), ["CastSpellAt", BOB, 1165], "three fizzles ⇒ next lower tier");
});

await run.check("stale reading guard: 'With … you restore 0 points of health to Bob.' — Bob's health waits 30 s; a real gain does not", () => {
  const w = world({ members: [member(ME, "Tester"), member(BOB, "Bob", { hp: 30 })] });
  w.ready();
  assert.ok(w.until("CastSpellAt"));
  w.bus.emit({ type: "chat", text: "With Incantation of Heal Other you restore 0 points of health to Bob.", chatType: 0, cat: 0 });
  w.answer();
  w.clock.advance(3000);
  assert.equal(w.until("CastSpellAt", 20), null, "Bob's reading is stale");
  assert.ok(w.h.status().backedOff.includes(`${BOB}:health`));
  w.clock.advance(30_000);
  assert.ok(w.until("CastSpellAt", 5), "after 30 s");
  const g = world({ members: [member(ME, "Tester"), member(BOB, "Bob", { hp: 30 })] });
  g.ready();
  assert.ok(g.until("CastSpellAt"));
  g.bus.emit({ type: "chat", text: "With Incantation of Heal Other you restore 120 points of health to Bob.", chatType: 0, cat: 0 });
  g.answer();
  g.clock.advance(2000);
  assert.ok(g.until("CastSpellAt", 5), "a heal that landed: Bob keeps getting help");
});

await run.check("holds and skips: portal space, busy, a dead fellow, a fellow with no vitals reading", () => {
  const low = () => [member(ME, "Tester"), member(BOB, "Bob", { hp: 30 })];
  const p = world({ members: low() });
  p.host.portal = true;
  p.ready();
  for (let i = 0; i < 10; i++) p.tick();
  assert.equal(p.host.actions("CastSpellAt").length, 0, "portal space");
  const b = world({ members: low() });
  b.host.busy = 1;
  b.ready();
  for (let i = 0; i < 10; i++) b.tick();
  assert.equal(b.host.actions("CastSpellAt").length, 0, "busy");
  const d = world({ members: [member(ME, "Tester"), member(BOB, "Bob", { hp: 0, sp: 0 })] });
  d.ready();
  for (let i = 0; i < 10; i++) d.tick();
  assert.equal(d.host.actions("CastSpellAt").length, 0, "dead: nothing to heal or restam");
  const n = world({ members: [member(ME, "Tester"), member(BOB, "Bob", { hp: 0, max: 0 })] });
  n.ready();
  for (let i = 0; i < 10; i++) n.tick();
  assert.equal(n.host.actions("CastSpellAt").length, 0, "max 0: no reading");
});

// ── the Healer's Heart ────────────────────────────────────────────────────
// The Healer's Heart as ACE's world DB has it (wcid 8552): ItemUseable
// 0x600004 (SourceWieldedTargetRemoteNeverWalk), ItemDifficulty 105 (Arcane
// Lore), ItemSkillLimit Life Magic / ItemSkillLevelLimit 245, ItemSpellcraft
// 225 — appraised, and a character who meets the requirements.
function heartWorld({ values = {}, inv = undefined, state = undefined, mode = 2, members = undefined, known = undefined, dist = {}, appraised = true, print = undefined } = {}) {
  const w = world({
    values,
    mode,
    state,
    print,
    dist,
    known,
    inv: inv ?? [swordRow(), shieldRow(), heartRow()],
    items: [HEART_ITEM],
    members: members ?? [member(ME, "Tester"), member(BOB, "Bob", { hp: 30 })],
  });
  w.host.setInt(HEART, 16, 0x600004);
  w.host.setInt(HEART, 106, 225);
  w.host.setInt(HEART, 109, 105);
  w.host.setInt(HEART, 115, 245);
  w.host.setDid(HEART, 37, 33);
  if (appraised) w.host.appraised.add(HEART);
  w.host.stats.skills = { 23: { current: 150, ranks: 100, training: 2 }, 33: { current: 300, ranks: 200, training: 3 } };
  w.unland = (guid) => {
    w.host.inv = w.host.inv.map((r) => (r.guid === guid ? { ...r, equipMask: 0 } : r));
    w.bus.emit({ type: "equip", item: guid, wielder: ME, failed: false });
  };
  // The wield lands: the client moved the hand slots to the pack (ACE
  // CheckWeaponCollision / holtburger_world::equip).
  w.landHeart = () => {
    w.host.inv = w.host.inv.map((r) => (r.guid === HEART ? { ...r, equipMask: HELD } : r.equipMask & 0x03700000 ? { ...r, equipMask: 0 } : r));
    w.bus.emit({ type: "equip", item: HEART, wielder: ME, failed: false });
  };
  w.land = (guid, mask) => {
    w.host.inv = w.host.inv.map((r) => (r.guid === guid ? { ...r, equipMask: mask } : r.guid === HEART && r.equipMask ? { ...r, equipMask: 0 } : r));
    w.bus.emit({ type: "equip", item: guid, wielder: ME, failed: false });
  };
  return w;
}

await run.check("Healer's Heart first: WieldItem(heart, Held) under the item token vthelpers (fight disengaged) → Magic mode → UseItemOnTarget(heart, fellow) under the cast token; Heal Other spells wait", () => {
  const w = heartWorld();
  w.ready();
  assert.deepEqual(w.until("WieldItem"), ["WieldItem", HEART, HELD]);
  assert.equal(w.host.itemActionToken.owner, "vthelpers");
  assert.deepEqual(w.combat.disengages, [{ cancelAttack: true }], "ACE's attack loop ends before the wield");
  assert.equal(w.h.holdsWandSlot(), true);
  assert.deepEqual(w.h.status().handBack, { heart: HEART, items: [SWORD, SHIELD] }, "weapon first, then the shield");
  for (let i = 0; i < 5; i++) w.tick();
  assert.equal(w.host.calls.filter((c) => c[0] !== "FellowshipHoldUpdates").length, 1, "nothing while the wield is in flight");
  w.landHeart();
  assert.deepEqual(w.until("ChangeCombatMode", 3), ["ChangeCombatMode", 8]);
  w.host.mode = 8;
  assert.deepEqual(w.until("UseItemOnTarget", 3), ["UseItemOnTarget", HEART, BOB]);
  assert.equal(w.host.castToken.owner, "helpers");
  assert.equal(w.host.actions("CastSpellAt").length, 0, "the heart heals, not the spellbook");
  assert.equal(w.h.status().heartUses, 1);
  assert.equal(w.host.actions("Jump").length, 0, "JumpOutWandCasting is off by default");
});

await run.check("hand-back: once no fellow needs the heart, the sword then the shield go back to their own slots — even with DoHelp switched off meanwhile", () => {
  const state = {};
  const w = heartWorld({ mode: 8, state });
  w.ready();
  assert.ok(w.until("WieldItem"));
  assert.ok(state.saved, "the hand-back lives in the injected page-session state");
  w.landHeart();
  assert.deepEqual(w.until("UseItemOnTarget", 3), ["UseItemOnTarget", HEART, BOB]);
  w.healed();
  w.answer();
  w.clock.advance(1000);
  for (let i = 0; i < 5; i++) w.tick();
  assert.equal(w.host.actions("WieldItem").length, 1, "Bob still reads 30 %: the heart stays in hand");
  assert.equal(w.h.status().heartFails, 0, "the restore line: the use counted");
  w.setMember(BOB, { health: 80 });
  w.options.set("DoHelp", false);
  w.post();
  assert.equal(w.slot.enabled(), true, "a hand-back still owed keeps the slot alive");
  assert.deepEqual(w.until("WieldItem"), ["WieldItem", SWORD, MELEE]);
  for (let i = 0; i < 3; i++) w.tick();
  assert.equal(w.host.actions("WieldItem").length, 2, "one slot at a time");
  w.land(SWORD, MELEE);
  assert.deepEqual(w.until("WieldItem"), ["WieldItem", SHIELD, SHIELD_SLOT]);
  w.land(SHIELD, SHIELD_SLOT);
  for (let i = 0; i < 5; i++) w.tick();
  assert.equal(w.host.actions("WieldItem").length, 3);
  assert.equal(w.h.status().handBack, null);
  assert.equal(state.saved, null);
  assert.equal(w.h.holdsWandSlot(), false);
  assert.equal(w.slot.enabled(), false, "DoHelp off and nothing owed: inert again");
});

await run.check("hand-back edge cases: empty hands owe the heart itself (UnwieldItem, holdsWandSlot until then); a hand re-armed by someone else is left alone; a rebound module (same state) still hands back", () => {
  const e = heartWorld({ mode: 8, inv: [heartRow()] });
  e.ready();
  assert.ok(e.until("WieldItem"));
  assert.deepEqual(e.h.status().handBack, { heart: HEART, items: [] }, "nothing swapped out: the debt is the heart");
  assert.equal(e.h.holdsWandSlot(), true);
  e.landHeart();
  assert.ok(e.until("UseItemOnTarget", 3));
  e.healed();
  e.answer();
  e.setMember(BOB, { health: 90 });
  assert.deepEqual(e.until("UnwieldItem"), ["UnwieldItem", HEART], "the heart back to the pack");
  assert.equal(e.h.holdsWandSlot(), true, "until it lands");
  e.unland(HEART);
  for (let i = 0; i < 3; i++) e.tick();
  assert.equal(e.h.status().handBack, null);
  assert.equal(e.h.holdsWandSlot(), false);
  assert.equal(e.host.actions("WieldItem").length, 1, "nothing else wielded");
  const r = heartWorld({ mode: 8, inv: [swordRow(), shieldRow(), heartRow(), F.row(AXE, "Axe", { itemType: 0x1, validLocations: MELEE })] });
  r.ready();
  assert.ok(r.until("WieldItem"));
  r.landHeart();
  assert.ok(r.until("UseItemOnTarget", 3));
  r.answer();
  r.land(AXE, MELEE); // the combat planner wielded its own weapon meanwhile
  r.setMember(BOB, { health: 90 });
  for (let i = 0; i < 10; i++) r.tick();
  assert.equal(r.host.actions("WieldItem").length, 1, "not ours any more");
  assert.equal(r.h.status().handBack, null);
  const state = {};
  const a = heartWorld({ mode: 8, state });
  a.ready();
  assert.ok(a.until("WieldItem"));
  a.landHeart();
  a.h.dispose(); // a rebind: the next bot's module gets the same page-session state
  const b = world({ mode: 8, state, inv: a.host.inv, items: [HEART_ITEM], members: [member(ME, "Tester"), member(BOB, "Bob", { hp: 90 })] });
  assert.equal(b.slot.enabled(), true);
  assert.deepEqual(b.until("WieldItem"), ["WieldItem", SWORD, MELEE]);
});

await run.check("heart detection by the item's own spell: a war wand on the Items tab is no heart; an unknown id of category 79 is; UseHealersHeart off ⇒ spells", () => {
  const war = world({ mode: 8, inv: [wandRow()], items: [{ guid: WAND, name: "Wand", wcid: 0, kind: "caster" }], members: [member(ME, "Tester"), member(BOB, "Bob", { hp: 30 })] });
  war.host.setDid(WAND, 28, 27); // Flame Bolt I
  war.ready();
  assert.deepEqual(war.until("CastSpellAt"), ["CastSpellAt", BOB, 4310]);
  assert.equal(war.host.actions("UseItemOnTarget").length, 0);
  const cat = heartWorld({ mode: 8 });
  cat.host.setDid(HEART, 28, 99001);
  cat.host.spells.set(99001, { id: 99001, name: "Heal Other (custom)", category: 79 });
  cat.ready();
  assert.deepEqual(cat.until("WieldItem"), ["WieldItem", HEART, HELD], "category 79");
  const off = heartWorld({ mode: 8, values: { UseHealersHeart: false }, inv: [wandRow(), heartRow()] });
  off.ready();
  assert.deepEqual(off.until("CastSpellAt"), ["CastSpellAt", BOB, 4310]);
  assert.equal(off.host.actions("WieldItem").length, 0);
});

await run.check("a refused heart wield parks the heart 30 s (spells meanwhile); its weapons still come back when the hands are empty", () => {
  const w = heartWorld({ mode: 8, inv: [wandRow(), heartRow()] });
  w.ready();
  assert.deepEqual(w.until("WieldItem"), ["WieldItem", HEART, HELD]);
  // The client moved the wand out first; ACE drops out of Magic with it
  // (Player_Inventory.cs RequiresStanceSwap); then the wield is refused.
  w.host.inv = w.host.inv.map((r) => (r.guid === WAND ? { ...r, equipMask: 0 } : r));
  w.host.mode = 2;
  w.bus.emit({ type: "equip", item: HEART, wielder: 0, failed: true, code: 0x0029 });
  w.host.answer();
  assert.deepEqual(w.until("WieldItem"), ["WieldItem", WAND, HELD], "the wand goes back");
  assert.equal(w.host.actions("CastSpellAt").length, 0, "no cast with empty hands");
  w.land(WAND, HELD);
  w.host.mode = 8; // ACE TryShuffleStance: a Held caster in a combat mode ⇒ Magic
  assert.deepEqual(w.until("CastSpellAt"), ["CastSpellAt", BOB, 4310], "Heal Other while the heart is parked — no 15 s no-caster park");
  assert.ok(w.h.status().heartUses === 0 && w.host.actions("WieldItem").length === 2, "the parked heart is not retried");
});

await run.check("JumpOutWandCasting: a minimal Jump(0.05) ≥ 0.2 s after the heart use, on a later heartbeat, gated on CanJumpNow", () => {
  const w = heartWorld({ mode: 8, values: { JumpOutWandCasting: true }, inv: [heartRow(HELD)] });
  w.ready();
  assert.ok(w.until("UseItemOnTarget"));
  const t0 = w.clock.t;
  assert.equal(w.host.actions("Jump").length, 0, "not on the same tick");
  assert.equal(w.slot.pinned(), true);
  const j = w.until("Jump", 5);
  assert.deepEqual(j, ["Jump", 0.05]);
  assert.ok(w.clock.t - t0 >= 200, `${w.clock.t - t0} ms after the use`);
  assert.equal(w.h.status().jumps, 1);
  const g = heartWorld({ mode: 8, values: { JumpOutWandCasting: true }, inv: [heartRow(HELD)] });
  g.host.canJump = false; // airborne
  g.ready();
  assert.ok(g.until("UseItemOnTarget"));
  g.answer();
  g.setMember(BOB, { health: 90 }); // healed: no second use (and no second jump) after the pacing
  for (let i = 0; i < 25; i++) g.tick();
  assert.equal(g.host.actions("Jump").length, 0, "never while CanJumpNow() is false");
  assert.equal(g.h.status().jumpPending, false, "dropped after the window");
  assert.equal(g.slot.pinned(), false);
  const r = heartWorld({ mode: 8, values: { JumpOutWandCasting: true }, inv: [heartRow(HELD)] });
  r.ready();
  assert.ok(r.until("UseItemOnTarget"));
  r.bus.emit({ type: "useFailed", code: 0x0550, text: "" }); // out of range: no cast to jump out of
  r.setMember(BOB, { health: 90 });
  for (let i = 0; i < 10; i++) r.tick();
  assert.equal(r.host.actions("Jump").length, 0, "a refused heart use cancels the jump");
});

// ── review 2026-10-19: findings 1-7 ───────────────────────────────────────
// Use the heart once (Bob low, the heart in hand, Magic): → the use call.
const useOnce = (w) => w.until("UseItemOnTarget", 40);

await run.check("1: a heart use ACE answers with a plain UseDone (activation unmet, wrong mode) is no heal — three in a row park the heart; the hand-back runs", () => {
  const w = heartWorld({ mode: 8, known: [] }); // a melee character: no Heal Other of its own
  w.ready();
  assert.ok(w.until("WieldItem"));
  w.landHeart();
  for (let i = 1; i <= 3; i++) {
    assert.deepEqual(useOnce(w), ["UseItemOnTarget", HEART, BOB], `use ${i}`);
    w.answer(); // UseDone, no "you restore" line, Bob's reading unchanged
  }
  assert.deepEqual(w.until("WieldItem", 40), ["WieldItem", SWORD, MELEE], "parked after the third: the weapons come back");
  assert.equal(w.host.actions("UseItemOnTarget").length, 3, "no fourth use");
  assert.equal(w.h.status().heartFails, 0, "the count starts over after the park");
  assert.ok(w.logs.some((m) => /failed 3x in a row/.test(m)), "said so");
  // With Heal Other of its own (the heart is a caster in hand): the spells take over.
  const s = heartWorld({ mode: 8 });
  s.ready();
  assert.ok(s.until("WieldItem"));
  s.landHeart();
  for (let i = 0; i < 3; i++) {
    assert.ok(useOnce(s));
    s.answer();
  }
  assert.deepEqual(s.until("CastSpellAt", 40), ["CastSpellAt", BOB, 4310], "Heal Other while the heart is parked");
});

await run.check("1: a heart use counts once it shows — ACE's restore line, or (Magic chat squelched) Bob's reading rising", () => {
  const w = heartWorld({ mode: 8, inv: [heartRow(HELD)] });
  w.ready();
  for (let i = 0; i < 4; i++) {
    assert.ok(useOnce(w), `use ${i + 1}`);
    w.healed(); // the line precedes the UseDone in ACE's UI queue
    w.answer();
  }
  assert.equal(w.h.status().heartFails, 0);
  assert.equal(w.host.actions("UseItemOnTarget").length, 4, "never parked");
  const q = heartWorld({ mode: 8, inv: [heartRow(HELD)] });
  q.ready();
  assert.ok(useOnce(q));
  q.answer();
  q.setMember(BOB, { health: 45 }); // up from 30 %, no line
  assert.ok(useOnce(q), "still below 50 %: used again");
  q.answer();
  q.setMember(BOB, { health: 49 });
  assert.ok(useOnce(q));
  assert.equal(q.h.status().heartFails, 0, "rising readings count");
});

await run.check("1: an appraised heart whose activation requirements this character misses is never wielded (Heal Other instead, said once); an unappraised one is appraised ≤ 1 per minute", () => {
  for (const [skills, why] of [
    [{ 23: { current: 150 }, 33: { current: 180 } }, /Life Magic 180 < 245/],
    [{ 23: { current: 90 }, 33: { current: 300 } }, /Arcane Lore 90 < 105/],
  ]) {
    const w = heartWorld({ mode: 8, inv: [wandRow(), heartRow()] });
    w.host.stats.skills = skills;
    w.ready();
    assert.deepEqual(w.until("CastSpellAt"), ["CastSpellAt", BOB, 4310]);
    w.answer();
    for (let i = 0; i < 30; i++) w.tick();
    assert.equal(w.host.actions("WieldItem").length, 0, "never wielded");
    assert.equal(w.logs.filter((m) => why.test(m)).length, 1, "said once");
  }
  const u = heartWorld({ mode: 8, appraised: false });
  u.post();
  u.post();
  assert.deepEqual(u.host.actions("RequestId"), [["RequestId", HEART]], "appraised once");
  u.clock.advance(59_000);
  u.post();
  assert.equal(u.host.actions("RequestId").length, 1);
  u.clock.advance(2000);
  u.post();
  assert.equal(u.host.actions("RequestId").length, 2, "again after a minute");
  u.bus.emit({ type: "fellowship" });
  assert.deepEqual(u.until("WieldItem"), ["WieldItem", HEART, HELD], "unreadable requirements: tried (failures park it)");
});

await run.check("2: the cast claim is kept until the help's own answer; a refusal trailing ACE's UseDone count is still ours (castOwner); one castOwner gives to someone else is not", () => {
  const two = () => [member(ME, "Tester"), member(BOB, "Bob", { hp: 30 }), member(ANN, "Ann", { hp: 40 })];
  const w = world({ members: two() });
  w.ready();
  assert.deepEqual(w.until("CastSpellAt"), ["CastSpellAt", BOB, 4310]);
  w.host.useDone(); // the poll-plane count moves on first; the event is not dispatched yet
  for (let i = 0; i < 3; i++) w.tick();
  assert.equal(w.slot.pinned(), true, "still waiting for the answer");
  assert.equal(w.host.actions("CastSpellAt").length, 1);
  assert.equal(w.host.castOwner(), "helpers");
  w.bus.emit({ type: "useFailed", code: 0x0400, text: "" });
  assert.equal(w.h.status().castBlocked, "components", "attributed to us");
  const r = world({ members: two() });
  r.ready();
  assert.ok(r.until("CastSpellAt"));
  r.host.useDone();
  r.tick();
  r.bus.emit({ type: "useFailed", code: 0x0550, text: "" });
  assert.ok(r.h.status().backedOff.includes(String(BOB)), "the late out-of-range answer backs Bob off");
  const o = world({ members: two() });
  o.ready();
  assert.ok(o.until("CastSpellAt"));
  o.host.useDone();
  o.host.tryClaimCast("combat"); // combat cast since; the refusal is its
  o.bus.emit({ type: "useFailed", code: 0x0400, text: "" });
  assert.equal(o.h.status().castBlocked, null, "not ours");
  assert.equal(o.slot.pinned(), false, "but it answers our wait");
  const raw = world({ members: two(), castOwner: false }); // an older host: the raw token decides
  raw.ready();
  assert.ok(raw.until("CastSpellAt"));
  raw.bus.emit({ type: "useFailed", code: 0x0400, text: "" });
  assert.equal(raw.h.status().castBlocked, "components");
});

await run.check("3: a hand-back that fails keeps the debt — tried again after its (doubling) park; settled only when the items are back in hand or gone", () => {
  const swap = (inv) => {
    const w = heartWorld({ mode: 8, known: [], inv });
    w.ready();
    assert.ok(w.until("WieldItem"));
    w.landHeart();
    assert.ok(useOnce(w));
    w.healed();
    w.answer();
    w.setMember(BOB, { health: 90 });
    w.fail = (g) => {
      w.bus.emit({ type: "equip", item: g, wielder: 0, failed: true, code: 0x0029 });
      w.host.answer();
    };
    return w;
  };
  const w = swap([swordRow(), heartRow()]);
  assert.deepEqual(w.until("WieldItem"), ["WieldItem", SWORD, MELEE]);
  w.fail(SWORD);
  w.tick();
  assert.deepEqual(w.h.status().handBack, { heart: HEART, items: [SWORD] }, "the debt stays");
  assert.equal(w.h.holdsWandSlot(), true);
  w.clock.advance(29_000);
  assert.equal(w.until("WieldItem", 5), null, "parked 30 s");
  w.clock.advance(1000);
  assert.deepEqual(w.until("WieldItem", 5), ["WieldItem", SWORD, MELEE], "tried again");
  w.fail(SWORD);
  w.tick(); // the next heartbeat sees the failure
  w.clock.advance(31_000);
  assert.equal(w.until("WieldItem", 5), null, "the second park doubles (60 s)");
  w.clock.advance(30_000);
  assert.deepEqual(w.until("WieldItem", 5), ["WieldItem", SWORD, MELEE]);
  w.land(SWORD, MELEE);
  for (let i = 0; i < 3; i++) w.tick();
  assert.equal(w.h.status().handBack, null, "back in hand: settled");
  assert.equal(w.h.holdsWandSlot(), false);
  // Sword and shield: the shield goes back while the sword waits out its park.
  const b = swap([swordRow(), shieldRow(), heartRow()]);
  assert.deepEqual(b.until("WieldItem"), ["WieldItem", SWORD, MELEE]);
  b.fail(SWORD);
  assert.deepEqual(b.until("WieldItem"), ["WieldItem", SHIELD, SHIELD_SLOT], "the next owed item meanwhile");
  b.land(SHIELD, SHIELD_SLOT);
  for (let i = 0; i < 5; i++) b.tick();
  assert.deepEqual(b.h.status().handBack, { heart: HEART, items: [SWORD, SHIELD] }, "the sword is still owed");
  b.clock.advance(30_000);
  assert.deepEqual(b.until("WieldItem", 5), ["WieldItem", SWORD, MELEE]);
  b.land(SWORD, MELEE);
  for (let i = 0; i < 3; i++) b.tick();
  assert.equal(b.h.status().handBack, null);
  // An owed item that is gone (sold, dropped) settles its part of the debt.
  const g = heartWorld({ mode: 8, known: [] });
  g.ready();
  assert.ok(g.until("WieldItem"));
  g.landHeart();
  assert.ok(useOnce(g));
  g.healed();
  g.answer();
  g.setMember(BOB, { health: 90 });
  assert.deepEqual(g.until("WieldItem"), ["WieldItem", SWORD, MELEE]);
  g.bus.emit({ type: "equip", item: SWORD, wielder: 0, failed: true, code: 0x0029 });
  g.host.answer();
  g.host.inv = g.host.inv.filter((r) => r.guid !== SWORD);
  assert.deepEqual(g.until("WieldItem"), ["WieldItem", SHIELD, SHIELD_SLOT], "the sword is gone: the shield next");
  g.land(SHIELD, SHIELD_SLOT);
  for (let i = 0; i < 3; i++) g.tick();
  assert.equal(g.h.status().handBack, null);
});

await run.check("3+: five failed tries of one hand-back step give that part of the debt up with ONE local chat alert; holdsWandSlot() goes false once nothing else is owed — also for a heart that will not leave the hand", () => {
  const PARKS = [30_000, 60_000, 120_000, 240_000]; // the doubling parks between the five tries
  const swapAndHeal = (opts) => {
    const w = heartWorld({ mode: 8, known: [], ...opts });
    w.ready();
    assert.ok(w.until("WieldItem"));
    w.landHeart();
    assert.ok(useOnce(w));
    w.healed();
    w.answer();
    w.setMember(BOB, { health: 90 });
    return w;
  };
  const failFive = (w, call, g) => {
    for (let i = 0; i < 5; i++) {
      assert.deepEqual(w.until(call[0], 5), call, `try ${i + 1}`);
      assert.equal(w.h.holdsWandSlot(), true, `owed during try ${i + 1}`);
      w.bus.emit({ type: "equip", item: g, wielder: 0, failed: true, code: 0x0029 });
      w.host.answer();
      w.tick();
      if (i < 4) w.clock.advance(PARKS[i]);
    }
  };
  const w = swapAndHeal({ inv: [swordRow(), heartRow()] });
  failFive(w, ["WieldItem", SWORD, MELEE], SWORD);
  assert.equal(w.h.holdsWandSlot(), false, "given up: settled at once");
  assert.equal(w.h.status().handBack, null);
  assert.deepEqual(w.host.chat, ["[RynthSuite] could not wield Sword back after the Healer's Heart — check your pack"]);
  w.clock.advance(600_000);
  for (let i = 0; i < 10; i++) w.tick();
  assert.equal(w.host.actions("WieldItem").length, 6, "the heart's wield + five tries, no more");
  assert.equal(w.host.actions("UnwieldItem").length, 0, "the heart is left in hand");
  assert.equal(w.host.chat.length, 1, "said once");
  // Sword and shield: the shield comes back, the sword is given up — settled.
  const b = swapAndHeal({});
  assert.deepEqual(b.until("WieldItem"), ["WieldItem", SWORD, MELEE]);
  b.bus.emit({ type: "equip", item: SWORD, wielder: 0, failed: true, code: 0x0029 });
  b.host.answer();
  assert.deepEqual(b.until("WieldItem"), ["WieldItem", SHIELD, SHIELD_SLOT]);
  b.land(SHIELD, SHIELD_SLOT);
  b.clock.advance(PARKS[0]);
  for (let i = 1; i < 5; i++) {
    assert.deepEqual(b.until("WieldItem", 5), ["WieldItem", SWORD, MELEE], `sword try ${i + 1}`);
    b.bus.emit({ type: "equip", item: SWORD, wielder: 0, failed: true, code: 0x0029 });
    b.host.answer();
    b.tick();
    if (i < 4) b.clock.advance(PARKS[i]);
  }
  assert.equal(b.h.holdsWandSlot(), false);
  assert.equal(b.host.chat.length, 1);
  // An empty-hands debt whose heart will not leave the hand; the injected print.
  const lines = [];
  const e = swapAndHeal({ inv: [heartRow()], print: (text, cat) => lines.push([text, cat]) });
  failFive(e, ["UnwieldItem", HEART], HEART);
  assert.equal(e.h.holdsWandSlot(), false);
  assert.deepEqual(lines, [["[RynthSuite] could not put The Healer's Heart back in the pack after healing — check your pack", 0]]);
  assert.deepEqual(e.host.chat, [], "the injected print, not the host's chat");
});

await run.check("5: a fellow beyond the heart's own reach (DAT range at its spellcraft: 5 + 225 × 0.25 ≈ 61 m) neither gets the heart nor blocks Heal Other or the hand-back", () => {
  const rec = { id: 1166, name: "Heal Other VI", category: 79, baseRangeConstant: 5, baseRangeMod: 0.25 };
  const far = heartWorld({ mode: 8, values: { HelperHealDistance: 200 }, inv: [wandRow(), heartRow()], dist: { [BOB]: 70 } });
  far.host.spells.set(1166, rec);
  far.ready();
  assert.deepEqual(far.until("CastSpellAt"), ["CastSpellAt", BOB, 4310], "Heal Other reaches 70 m (≤ 75)");
  assert.equal(far.host.actions("WieldItem").length, 0, "the heart is not wielded for him");
  const out = heartWorld({ mode: 8, values: { HelperHealDistance: 200 }, inv: [wandRow(), heartRow()], dist: { [BOB]: 120 } });
  out.ready();
  assert.equal(out.until("CastSpellAt", 20), null, "beyond 75 m nothing reaches him");
  const hb = heartWorld({ mode: 8, known: [], values: { HelperHealDistance: 200 } });
  hb.host.spells.set(1166, rec);
  hb.ready();
  assert.ok(hb.until("WieldItem"));
  hb.landHeart();
  assert.ok(useOnce(hb));
  hb.healed();
  hb.answer();
  hb.host.dist.set(BOB, 70); // Bob ran off, still at 30 %
  assert.deepEqual(hb.until("WieldItem", 40), ["WieldItem", SWORD, MELEE], "no longer blocks the hand-back");
});

await run.check("6: JumpOutWandCasting never jumps for a PK or PKLite (a PK's jump fails the cast) — said once; an NPK jumps", () => {
  for (const [label, setup] of [
    ["PK", (w) => w.host.setInt(ME, 134, 0x04)],
    ["PKLite", (w) => w.host.setInt(ME, 134, 0x40)],
    ["PK by its description flags", (w) => w.host.desc.set(ME, 0x20)],
  ]) {
    const w = heartWorld({ mode: 8, values: { JumpOutWandCasting: true }, inv: [heartRow(HELD)] });
    setup(w);
    w.ready();
    for (let i = 0; i < 2; i++) {
      assert.ok(useOnce(w), `${label}: use ${i + 1}`);
      w.healed();
      w.answer();
    }
    for (let i = 0; i < 10; i++) w.tick();
    assert.equal(w.host.actions("Jump").length, 0, `${label}: no jump`);
    assert.equal(w.logs.filter((m) => /JumpOutWandCasting skipped/.test(m)).length, 1, `${label}: said once`);
  }
  const n = heartWorld({ mode: 8, values: { JumpOutWandCasting: true }, inv: [heartRow(HELD)] });
  n.host.setInt(ME, 134, 0x02); // NPK
  n.ready();
  assert.ok(useOnce(n));
  assert.deepEqual(n.until("Jump", 5), ["Jump", 0.05]);
});

await run.check("7: a Heal Other caster used from the pack (Seed of Mornings, Derubloom Wand: ItemUseable 0x600008) is no heart; ItemUseable unreadable ⇒ the spell alone decides", () => {
  const SEED = 0x80005006;
  const mk = (useable) => {
    const w = world({
      mode: 8,
      inv: [wandRow(), F.row(SEED, "Legendary Seed of Mornings", { wcid: 48938, itemType: 0x8000, validLocations: HELD })],
      items: [{ guid: SEED, name: "Legendary Seed of Mornings", wcid: 48938, kind: "caster" }],
      members: [member(ME, "Tester"), member(BOB, "Bob", { hp: 30 })],
    });
    w.host.setDid(SEED, 28, 2072); // Adja's Gift
    if (useable != null) w.host.setInt(SEED, 16, useable);
    w.ready();
    return w;
  };
  const seed = mk(0x600008);
  assert.deepEqual(seed.until("CastSpellAt"), ["CastSpellAt", BOB, 4310]);
  assert.equal(seed.host.actions("WieldItem").length, 0, "never wielded as a heart");
  const unknown = mk(null);
  assert.deepEqual(unknown.until("WieldItem"), ["WieldItem", SEED, HELD], "unreadable: the spell decides");
  const heart = mk(0x600004);
  assert.deepEqual(heart.until("WieldItem"), ["WieldItem", SEED, HELD], "source Wielded: a heart");
});

// ── robustness and the real kernel ────────────────────────────────────────
await run.check("never throws on a hostile host; dispose detaches every subscription", () => {
  const hostile = new Proxy({}, { get: () => () => { throw new Error("boom"); } });
  const bus = F.makeBus();
  const h = H.createHelpers({ host: hostile, options: F.makeOptions({}), subscribe: bus.on, log: () => {} });
  assert.doesNotThrow(() => {
    h.slot.enabled();
    h.slot.pinned();
    h.slot.wants(F.ctx());
    h.slot.tick(F.ctx());
    h.reflex.tick(Date.now(), { held: false });
    h.status();
    bus.emit({ type: "useFailed", code: 0x0550 });
    bus.emit({ type: "chat", text: "With X you restore 0 points of health to Bob." });
  });
  for (const k of ["useDone", "useFailed", "equip", "fellowship", "chat"]) assert.equal(bus.count(k), 1, k);
  h.dispose();
  for (const k of ["useDone", "useFailed", "equip", "fellowship", "chat"]) assert.equal(bus.count(k), 0, `${k} detached`);
});

await run.check("with the REAL kernel: after Vitals and Supplies, before Combat; borrowing the tick from a fight keeps ACE's attack loop; nothing while operator-held", () => {
  const w = world({ members: [member(ME, "Tester"), member(BOB, "Bob")] });
  const klog = [];
  Object.assign(w.host, { IsPlayerReady: () => true, StopStick: () => klog.push("StopStick"), StopCompletely: () => {}, onTick: () => {} });
  const combat = {
    locked: MOB,
    kills: 0,
    status: {},
    _scanTargets: () => [{ guid: MOB, dist: 5 }],
    canEngage: () => true,
    underAttack: () => false,
    tick: () => klog.push("combat.tick"),
    disengage: (o) => klog.push(`disengage:${o && o.cancelAttack}`),
  };
  let suppliesWants = false;
  const supplies = { name: "Supplies", rank: "afterVitals", keepsCombatLoop: true, enabled: () => true, pinned: () => false, wants: () => suppliesWants, tick: () => klog.push("supplies.tick") };
  const aux = { slots: [supplies, w.slot], idleHooks: [], policy: { boostLoot: () => false } };
  const k = new RynthBotKernel(w.host, { combat, buff: null, loot: null, vitals: null, unwedge: null, aux }, { log: () => {} });
  k.start();
  w.ready();
  w.clock.advance(100);
  k.tick();
  assert.equal(k.action, "Combat", "nobody to help: the fight");
  w.setMember(BOB, { health: 30 });
  k.tick();
  assert.equal(k.action, "Helpers");
  assert.ok(klog.includes("disengage:false"), "keepsCombatLoop: the attack loop is kept");
  assert.deepEqual(w.host.actions("CastSpellAt").at(-1), ["CastSpellAt", BOB, 4310]);
  w.answer();
  suppliesWants = true;
  w.clock.advance(3000);
  k.tick();
  assert.equal(k.action, "Supplies", "your own supplies first");
  suppliesWants = false;
  k.holdForOperator();
  const n = w.host.calls.length;
  for (let i = 0; i < 10; i++) {
    w.clock.advance(100);
    k.tick();
  }
  assert.equal(w.host.calls.length, n, "operator hold: no slot runs");
  w.post(true);
  assert.deepEqual(w.host.actions("FellowshipHoldUpdates").at(-1), ["FellowshipHoldUpdates", false], "the post-tick releases the stream");
});

console.log(run.fail === 0 ? `rynth_vt_support_helpers: all ${run.pass} checks passed` : `rynth_vt_support_helpers: ${run.fail} FAILED (${run.pass} passed)`);
process.exit(run.fail === 0 ? 0 : 1);
