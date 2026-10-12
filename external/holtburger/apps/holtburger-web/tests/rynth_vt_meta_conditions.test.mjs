// tests/rynth_vt_meta_conditions.test.mjs — rynth/vt/meta conditions.js and
// actions.js (W1-4 META, PLAN §2.9 condition + action tables, Appendix B).
//
// Every condition and every action keyword against a fake per-pass run
// context, plus the event-latch semantics (Death, VendorClosed, portal edges,
// ChatMatch over every pending line, VendorOpen level) through a real
// MetaEngine with fake injections (C2: nothing imported from other vt
// packages).
//
// Run from apps/holtburger-web/:  node tests/rynth_vt_meta_conditions.test.mjs

import assert from "node:assert/strict";

const M = await import("../rynth/vt/meta/index.js");
const { CONDITIONS, CONDITION_KEYWORDS, ACTIONS, ACTION_KEYWORDS, evalCondition, runAction, describeCondition, describeAction, chatSubjects, parseColorIds, toU32, MetaEngine } = M;

let pass = 0;
let fail = 0;
async function check(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    fail++;
    console.log(`  FAIL ${name}\n       ${e && e.stack ? e.stack.split("\n").slice(0, 4).join("\n       ") : e}`);
  }
}

const T0 = 1_800_000_000_000;

const VALUES = {
  isErr: (v) => !!v && typeof v === "object" && v.t === "err",
  truthy: (v) => {
    if (v === null || v === undefined || v === false || v === 0) return false;
    if (typeof v === "string") return !["", "0", "false"].includes(v.trim().toLowerCase());
    if (v && typeof v === "object" && v.t === "err") return false;
    return true;
  },
  toStr: (v) => (v === null || v === undefined ? "" : typeof v === "boolean" ? (v ? "1" : "0") : typeof v === "object" ? `[${v.t}]` : String(v)),
};

const regex = (p, f) => {
  try {
    return new RegExp(p, f);
  } catch {
    return null;
  }
};

// A fake per-pass run context (the members engine.js builds; see
// conditions.js / actions.js headers).
function makeRc({ ctx = {}, events = [], secs = 0, secsP = 0, vendor = false, evaluate = null, meta = null, values = VALUES } = {}) {
  const log = { errors: [], echoes: [], warns: [], vars: new Map(), out: [], states: [], calls: [], wd: [], evaluated: [] };
  const rc = {
    ctx,
    events,
    values,
    meta,
    now: T0,
    rule: { id: "r1", state: "Default" },
    secondsInState: () => secs,
    secondsInStateP: () => secsP,
    vendorOpen: () => vendor,
    evaluate: (s) => {
      log.evaluated.push(s);
      return evaluate ? evaluate(s) : s;
    },
    regex,
    setVar: (n, v) => log.vars.set(n, v),
    exprError: (m) => log.echoes.push(m),
    echoError: (m) => log.echoes.push(m),
    recordError: (m) => log.errors.push(m),
    warnOnce: (k, m) => log.warns.push(m),
    print: (t) => log.out.push(t),
    enterState: (n, why) => {
      const s = String(n ?? "").trim();
      if (!s) return false;
      log.states.push([s, why]);
      return true;
    },
    callState: (to, ret) => log.calls.push(["call", to, ret]),
    returnFromCall: () => log.calls.push(["return"]),
    setWatchdog: (spec) => {
      if (!String(spec.state ?? "").trim()) return false;
      log.wd.push(spec);
      return true;
    },
    clearWatchdog: () => log.wd.push("clear"),
    chatRun: (line) => log.out.push(line),
  };
  return { rc, log };
}

const cond = (c, opts) => {
  const { rc, log } = makeRc(opts);
  return { v: evalCondition(c, rc), log };
};
const act = (a, opts) => {
  const { rc, log } = makeRc(opts);
  runAction(a, rc);
  return log;
};

// ── Appendix B numbering ────────────────────────────────────────────────

await check("Appendix B: condition keywords ↔ .met numbers (27 unused, ChatCapture = 28, B1)", () => {
  const want = {
    Never: 0, Always: 1, All: 2, Any: 3, ChatMatch: 4, MainSlotsLE: 5, SecsInStateGE: 6, NavEmpty: 7, Death: 8, VendorOpen: 9,
    VendorClosed: 10, ItemCountLE: 11, ItemCountGE: 12, MobsInDist_Name: 13, MobsInDist_Priority: 14, NeedToBuff: 15, NoMobsInDist: 16,
    BlockE: 17, CellE: 18, IntoPortal: 19, ExitPortal: 20, Not: 21, PSecsInStateGE: 22, SecsOnSpellGE: 23, BuPercentGE: 24,
    DistToRteGE: 25, Expr: 26, ChatCapture: 28,
  };
  assert.deepEqual(Object.fromEntries(CONDITION_KEYWORDS.map((k) => [k, CONDITIONS[k].met])), want);
  assert.equal(new Set(Object.values(want)).size, CONDITION_KEYWORDS.length);
  for (const k of CONDITION_KEYWORDS) assert.ok(CONDITIONS[k].label && typeof CONDITIONS[k].test === "function");
});

await check("Appendix B: action keywords ↔ .met numbers 0..15", () => {
  const want = {
    None: 0, SetState: 1, Chat: 2, DoAll: 3, EmbedNav: 4, CallState: 5, Return: 6, DoExpr: 7, ChatExpr: 8, SetWatchdog: 9,
    ClearWatchdog: 10, GetOpt: 11, SetOpt: 12, CreateView: 13, DestroyView: 14, DestroyAllViews: 15,
  };
  assert.deepEqual(Object.fromEntries(ACTION_KEYWORDS.map((k) => [k, ACTIONS[k].met])), want);
});

// ── conditions ───────────────────────────────────────────────────────────

await check("Never / Always", () => {
  assert.equal(cond({ t: "Never" }).v, false);
  assert.equal(cond({ t: "Always" }).v, true);
});

await check("All / Any / Not: empty All true, empty Any false, Not(child[0]), Not() false, ≥3-level nesting", () => {
  assert.equal(cond({ t: "All", children: [] }).v, true);
  assert.equal(cond({ t: "All" }).v, true);
  assert.equal(cond({ t: "Any", children: [] }).v, false);
  assert.equal(cond({ t: "Not", children: [{ t: "Never" }] }).v, true);
  assert.equal(cond({ t: "Not", children: [] }).v, false);
  assert.equal(cond({ t: "All", children: [{ t: "Always" }, { t: "Never" }] }).v, false);
  assert.equal(cond({ t: "Any", children: [{ t: "Never" }, { t: "Always" }] }).v, true);
  const deep = { t: "All", children: [{ t: "Any", children: [{ t: "Not", children: [{ t: "All", children: [{ t: "Never" }] }] }] }] };
  assert.equal(cond(deep).v, true);
});

await check("All / Any short-circuit in order (side-effecting Expr children after the decider do not run)", () => {
  const r1 = cond({ t: "All", children: [{ t: "Never" }, { t: "Expr", expr: "side" }] });
  assert.deepEqual(r1.log.evaluated, []);
  const r2 = cond({ t: "Any", children: [{ t: "Always" }, { t: "Expr", expr: "side" }] });
  assert.deepEqual(r2.log.evaluated, []);
});

await check("condition depth capped at 64 (false + recorded)", () => {
  let c = { t: "Always" };
  for (let i = 0; i < 70; i++) c = { t: "Not", children: [c] };
  const r = cond(c);
  assert.equal(r.v, false);
  assert.ok(r.log.errors.some((e) => /deeper than 64/.test(e)));
});

await check("ChatMatch: case-sensitive, true if ANY pending line matches, non-chat events ignored", () => {
  const events = [{ type: "portalIn" }, { type: "chat", text: "first line", chatType: 0 }, { type: "chat", text: "You have died.", chatType: 0 }];
  assert.equal(cond({ t: "ChatMatch", re: "^You have died" }, { events }).v, true);
  assert.equal(cond({ t: "ChatMatch", re: "^you have died" }, { events }).v, false, "case-sensitive");
  assert.equal(cond({ t: "ChatMatch", re: "nothing" }, { events }).v, false);
  assert.equal(cond({ t: "ChatMatch", re: "" }, { events }).v, false, "empty pattern never matches");
  const bad = cond({ t: "ChatMatch", re: "(" }, { events });
  assert.equal(bad.v, false, "bad pattern ⇒ no match");
  assert.deepEqual(bad.log.echoes, ["invalid regular expression /(/"], "…and the user is told (once per rule, engine-side)");
});

await check("ChatMatch: each tell is also tested in synthesized retail markup <Tell:IIDString:0:Name>Name<\\Tell> tells you, \"msg\"", () => {
  const tell = { type: "chat", text: 'Bob Smith tells you, "buff me"', chatType: 3 };
  assert.deepEqual(chatSubjects(tell), ['Bob Smith tells you, "buff me"', '<Tell:IIDString:0:Bob Smith>Bob Smith<\\Tell> tells you, "buff me"']);
  const corpusRe = '^<Tell:IIDString:[0-9]+:(?<name>[^>]+)>[^<]+<\\\\Tell> tells you, "buff me"$';
  assert.equal(cond({ t: "ChatMatch", re: corpusRe }, { events: [tell] }).v, true);
  assert.equal(cond({ t: "ChatMatch", re: '^Bob Smith tells you' }, { events: [tell] }).v, true, "plain form still matches");
  assert.equal(chatSubjects({ text: 'Bob tells you, "x"', cat: 1 }).length, 1, "a non-TELL category gets no markup");
  assert.equal(chatSubjects({ text: "You say, \"x\"" }).length, 1);
});

await check("ChatCapture (28): binds every named group to capturegroup_<name>; non-participating group ⇒ \"\"", () => {
  const events = [{ type: "chat", text: "Drudge Skulker hits you for 12 points", chatType: 0 }];
  const r = cond({ t: "ChatCapture", re: "^(?<mob>.+?) hits you for (?<dmg>\\d+) points(?<crit> critically)?", colors: "" }, { events });
  assert.equal(r.v, true);
  assert.equal(r.log.vars.get("capturegroup_mob"), "Drudge Skulker");
  assert.equal(r.log.vars.get("capturegroup_dmg"), "12");
  assert.equal(r.log.vars.get("capturegroup_crit"), "");
});

await check("ChatCapture: the FIRST matching pending line binds; colour filter on the kind-2 chatType", () => {
  const events = [
    { type: "chat", text: "loot: Pyreal", chatType: 3 },
    { type: "chat", text: "loot: Gem", chatType: 5 },
    { type: "chat", text: "loot: Scroll", chatType: 5 },
  ];
  const r = cond({ t: "ChatCapture", re: "^loot: (?<item>\\w+)", colors: "" }, { events });
  assert.equal(r.log.vars.get("capturegroup_item"), "Pyreal");
  const r2 = cond({ t: "ChatCapture", re: "^loot: (?<item>\\w+)", colors: "4;5" }, { events });
  assert.equal(r2.v, true);
  assert.equal(r2.log.vars.get("capturegroup_item"), "Gem");
  const r3 = cond({ t: "ChatCapture", re: "^loot: (?<item>\\w+)", colors: "7" }, { events });
  assert.equal(r3.v, false);
  assert.equal(r3.log.vars.size, 0);
  assert.deepEqual([...parseColorIds("4; 5,0x10")], [4, 5, 16]);
  assert.equal(parseColorIds(""), null);
});

await check("Pack Slots <= (MainSlotsLE): main-pack free slots from the context", () => {
  const ctx = (free) => ({ player: { packFreeMain: () => free } });
  assert.equal(cond({ t: "MainSlotsLE", n: 3 }, { ctx: ctx(3) }).v, true);
  assert.equal(cond({ t: "MainSlotsLE", n: 2 }, { ctx: ctx(3) }).v, false);
  assert.equal(cond({ t: "MainSlotsLE", n: 3 }, { ctx: ctx(null) }).v, false, "unknown ⇒ false");
  assert.equal(cond({ t: "MainSlotsLE", n: 3 }, { ctx: {} }).v, false);
});

await check("Seconds in State >= / Seconds in state (P) >= read their own timers", () => {
  assert.equal(cond({ t: "SecsInStateGE", secs: 5 }, { secs: 5 }).v, true);
  assert.equal(cond({ t: "SecsInStateGE", secs: 5 }, { secs: 4.9 }).v, false);
  assert.equal(cond({ t: "PSecsInStateGE", secs: 5 }, { secs: 0, secsP: 6 }).v, true);
  assert.equal(cond({ t: "PSecsInStateGE", secs: 5 }, { secs: 9, secsP: 1 }).v, false);
  assert.equal(cond({ t: "SecsInStateGE" }, { secs: 9 }).v, false, "missing secs ⇒ false");
});

await check("Navroute Empty: nav.isEmpty(); no nav service ⇒ empty", () => {
  assert.equal(cond({ t: "NavEmpty" }, { ctx: { nav: { isEmpty: () => true } } }).v, true);
  assert.equal(cond({ t: "NavEmpty" }, { ctx: { nav: { isEmpty: () => false } } }).v, false);
  assert.equal(cond({ t: "NavEmpty" }, { ctx: {} }).v, true);
});

await check("Character Death: true only with a pending death event (self)", () => {
  assert.equal(cond({ t: "Death" }, { events: [{ type: "death" }] }).v, true);
  assert.equal(cond({ t: "Death" }, { events: [{ type: "death", self: false }] }).v, false);
  assert.equal(cond({ t: "Death" }, { events: [] }).v, false);
});

await check("Any Vendor Open (level) / Vendor Closed (edge)", () => {
  assert.equal(cond({ t: "VendorOpen" }, { vendor: true }).v, true);
  assert.equal(cond({ t: "VendorOpen" }, { vendor: false }).v, false);
  assert.equal(cond({ t: "VendorClosed" }, { events: [{ type: "vendorClose", guid: 5 }] }).v, true);
  assert.equal(cond({ t: "VendorClosed" }, { events: [{ type: "vendorOpen", guid: 5 }] }).v, false);
});

await check("Inventory Item Count <= / >=: stack-aware count (context sums stacks), exact name case-insensitive, trimmed", () => {
  const inv = [{ name: "Pyreal Sliver", stack: 2 }, { name: "pyreal sliver", stack: 3 }, { name: "Pyreal Sliver Pouch", stack: 9 }];
  const asked = [];
  const ctx = { player: { itemCount: (n) => (asked.push(n), inv.filter((i) => i.name.toLowerCase() === n.toLowerCase()).reduce((a, i) => a + i.stack, 0)) } };
  assert.equal(cond({ t: "ItemCountGE", name: " Pyreal Sliver ", count: 5 }, { ctx }).v, true);
  assert.equal(cond({ t: "ItemCountGE", name: "Pyreal Sliver", count: 6 }, { ctx }).v, false);
  assert.equal(cond({ t: "ItemCountLE", name: "Pyreal Sliver", count: 5 }, { ctx }).v, true);
  assert.equal(cond({ t: "ItemCountLE", name: "Pyreal Sliver", count: 4 }, { ctx }).v, false);
  assert.equal(cond({ t: "ItemCountLE", name: "Mana Stone", count: 0 }, { ctx }).v, true, "none = 0");
  assert.equal(cond({ t: "ItemCountGE", name: "", count: 0 }, { ctx }).v, false, "no name ⇒ false");
  assert.equal(asked[0], "Pyreal Sliver");
});

const MOBS = [
  { guid: 1, name: "Drudge Skulker", dist: 10, hf: -1, attackable: true }, // unknown health: counted (B16)
  { guid: 2, name: "Drudge Slinker", dist: 12, hf: 0.5, attackable: true },
  { guid: 3, name: "Drudge Ravener", dist: 8, hf: 0, attackable: true }, // known dead
  { guid: 4, name: "Drudge Skulker", dist: 50, hf: 1, attackable: true }, // out of range
  { guid: 5, name: "Drudge Prowler", dist: 5, hf: 1, attackable: false }, // not attackable
  { guid: 6, name: "Mosswart", dist: 3, attackable: true }, // hf missing = unknown
];
const mobCtx = (prio = {}) => ({ world: { monsters: () => MOBS }, monsters: { priorityOf: (g) => prio[g] ?? 1 } });

await check("Monster Name Count Within Distance: unknown health counted, dead/non-attackable excluded, case-insensitive regex, ≥ count", () => {
  const ctx = mobCtx();
  assert.equal(cond({ t: "MobsInDist_Name", re: "drudge", dist: 20, count: 2 }, { ctx }).v, true);
  assert.equal(cond({ t: "MobsInDist_Name", re: "DRUDGE", dist: 20, count: 3 }, { ctx }).v, false);
  assert.equal(cond({ t: "MobsInDist_Name", re: "^Drudge S", dist: 11, count: 1 }, { ctx }).v, true);
  assert.equal(cond({ t: "MobsInDist_Name", re: "^Drudge S", dist: 11, count: 2 }, { ctx }).v, false);
  assert.equal(cond({ t: "MobsInDist_Name", re: "Ravener|Prowler", dist: 20, count: 1 }, { ctx }).v, false);
  assert.equal(cond({ t: "MobsInDist_Name", re: "Mosswart", dist: 3, count: 1 }, { ctx }).v, true, "hf missing counted; dist ≤ D inclusive");
  assert.equal(cond({ t: "MobsInDist_Name", re: "x", dist: 20, count: 1 }, { ctx: {} }).v, false);
});

await check("Monster Priority Count Within Distance: resolved priority ≥ P (DEFAULT P from the list)", () => {
  const ctx = mobCtx({ 1: 3, 2: 1, 6: 4 });
  assert.equal(cond({ t: "MobsInDist_Priority", count: 2, dist: 20, priority: 3 }, { ctx }).v, true);
  assert.equal(cond({ t: "MobsInDist_Priority", count: 3, dist: 20, priority: 3 }, { ctx }).v, false);
  assert.equal(cond({ t: "MobsInDist_Priority", count: 3, dist: 20, priority: 1 }, { ctx }).v, true);
  assert.equal(cond({ t: "MobsInDist_Priority", count: 1, dist: 20, priority: 5 }, { ctx }).v, false);
  assert.equal(cond({ t: "MobsInDist_Priority", count: 1, dist: 20, priority: 1 }, { ctx: { world: { monsters: () => MOBS } } }).v, false, "no Monsters list ⇒ false");
});

await check("Need to Buff: buff.needsBuff()", () => {
  assert.equal(cond({ t: "NeedToBuff" }, { ctx: { buff: { needsBuff: () => true } } }).v, true);
  assert.equal(cond({ t: "NeedToBuff" }, { ctx: { buff: { needsBuff: () => false } } }).v, false);
  assert.equal(cond({ t: "NeedToBuff" }, { ctx: {} }).v, false);
});

await check("No Monsters Within Distance: inverse of a 1-count any-name match; dist ≤ 0 ⇒ 20 m", () => {
  const ctx = mobCtx();
  assert.equal(cond({ t: "NoMobsInDist", dist: 2 }, { ctx }).v, true, "only the non-attackable Prowler and the dead Ravener closer than 8 m… Mosswart at 3 m");
  assert.equal(cond({ t: "NoMobsInDist", dist: 3 }, { ctx }).v, false);
  assert.equal(cond({ t: "NoMobsInDist", dist: 0 }, { ctx }).v, false, "20 m default sees the Skulker");
  assert.equal(cond({ t: "NoMobsInDist", dist: 5 }, { ctx: { world: { monsters: () => [] } } }).v, true);
});

await check("Landblock ==: both XXXX and XXXX0000 forms (B9), hex strings, signed .met ints", () => {
  const ctx = (cell) => ({ player: { pose: () => ({ objCellId: cell, x: 0, y: 0, z: 0 }) } });
  assert.equal(cond({ t: "BlockE", value: 0xc8e90000 }, { ctx: ctx(0xc8e90012) }).v, true);
  assert.equal(cond({ t: "BlockE", value: 0xc8e9 }, { ctx: ctx(0xc8e90012) }).v, true);
  assert.equal(cond({ t: "BlockE", value: "C8E90000" }, { ctx: ctx(0xc8e90012) }).v, true);
  assert.equal(cond({ t: "BlockE", value: 0xc8ea0000 }, { ctx: ctx(0xc8e90012) }).v, false);
  assert.equal(cond({ t: "BlockE", value: -1979580416 }, { ctx: ctx(0x8a02001f) }).v, true, "signed 0x8A020000");
  assert.equal(cond({ t: "BlockE", value: 0x8a020000 }, { ctx: ctx(0x8a020123) }).v, true, "dungeon cell of the same block");
  assert.equal(cond({ t: "BlockE", value: 0xc8e90000 }, { ctx: { player: { pose: () => null } } }).v, false);
  assert.equal(toU32("0xC8E9"), 0xc8e9);
  assert.equal(toU32("zz"), null);
});

await check("Landcell ==: full uint32 compare (signed and unsigned)", () => {
  const ctx = (cell) => ({ player: { pose: () => ({ objCellId: cell }) } });
  assert.equal(cond({ t: "CellE", value: 5636705 }, { ctx: ctx(0x00560261) }).v, true, "corpus 0x00560261");
  assert.equal(cond({ t: "CellE", value: 0x8a020123 - 2 ** 32 }, { ctx: ctx(0x8a020123) }).v, true, "signed form");
  assert.equal(cond({ t: "CellE", value: 0x8a020123 }, { ctx: ctx(0x8a020123) }).v, true);
  assert.equal(cond({ t: "CellE", value: 0x8a020124 }, { ctx: ctx(0x8a020123) }).v, false);
});

await check("Portalspace Entered / Exited: edge events", () => {
  assert.equal(cond({ t: "IntoPortal" }, { events: [{ type: "portalIn" }] }).v, true);
  assert.equal(cond({ t: "IntoPortal" }, { events: [{ type: "portalOut" }] }).v, false);
  assert.equal(cond({ t: "ExitPortal" }, { events: [{ type: "portalOut" }] }).v, true);
  assert.equal(cond({ t: "ExitPortal" }, { events: [] }).v, false);
});

await check("Time Left On Spell >=: max remaining over layers; not found = 0 s; permanent = ∞", () => {
  const rows = [{ spellId: 2, remainingS: 100 }, { spellId: 2, remainingS: 1500 }, { spellId: 3, remainingS: 50 }, { spellId: 9, permanent: true, remainingS: null }];
  const ctx = { player: { selfEnchantments: () => rows } };
  assert.equal(cond({ t: "SecsOnSpellGE", spellId: 2, secs: 1000 }, { ctx }).v, true);
  assert.equal(cond({ t: "SecsOnSpellGE", spellId: 2, secs: 1501 }, { ctx }).v, false);
  assert.equal(cond({ t: "SecsOnSpellGE", spellId: 4, secs: 0 }, { ctx }).v, true, "not found = 0 ≥ 0");
  assert.equal(cond({ t: "SecsOnSpellGE", spellId: 4, secs: 1 }, { ctx }).v, false);
  assert.equal(cond({ t: "SecsOnSpellGE", spellId: 9, secs: 999999 }, { ctx }).v, true);
  assert.equal(cond({ t: "SecsOnSpellGE", spellId: 2, secs: 1 }, { ctx: { player: { selfEnchantments: () => null } } }).v, false);
});

await check("Burden Percent >=: host burden percentage", () => {
  const ctx = (b) => ({ player: { burdenPct: () => b } });
  assert.equal(cond({ t: "BuPercentGE", pct: 90 }, { ctx: ctx(95) }).v, true);
  assert.equal(cond({ t: "BuPercentGE", pct: 90 }, { ctx: ctx(89.9) }).v, false);
  assert.equal(cond({ t: "BuPercentGE", pct: 0 }, { ctx: ctx(null) }).v, false);
});

await check("Dist Any Route Pt >=: metres (Q8), no route point ⇒ false", () => {
  const ctx = (d) => ({ nav: { minDistToAnyPointM: () => d } });
  assert.equal(cond({ t: "DistToRteGE", dist: 25 }, { ctx: ctx(30) }).v, true);
  assert.equal(cond({ t: "DistToRteGE", dist: 25 }, { ctx: ctx(20) }).v, false);
  assert.equal(cond({ t: "DistToRteGE", dist: 0.1 }, { ctx: ctx(Infinity) }).v, false);
  assert.equal(cond({ t: "DistToRteGE", dist: 25 }, { ctx: {} }).v, false);
});

await check("Expression: truthy(evaluate(expr)) via injected values; an error fails closed and is echoed", () => {
  assert.equal(cond({ t: "Expr", expr: "1" }).v, true);
  assert.equal(cond({ t: "Expr", expr: "false" }).v, false);
  assert.equal(cond({ t: "Expr", expr: "   " }).v, false, "empty expression ⇒ false without evaluating");
  const r = cond({ t: "Expr", expr: "boom[" }, { evaluate: () => ({ t: "err", msg: "parse error at 5" }) });
  assert.equal(r.v, false);
  assert.deepEqual(r.log.echoes, ["parse error at 5"]);
});

await check("unknown condition keyword ⇒ false + one warning", () => {
  const r = cond({ t: "Never", unknownKeyword: "SecsOnSpellLE" });
  assert.equal(r.v, false);
  const r2 = cond({ t: "MainHealthLE" });
  assert.equal(r2.v, false);
  assert.ok(r2.log.warns.some((w) => /MainHealthLE/.test(w)));
  assert.equal(cond(null).v, false);
});

// ── actions ──────────────────────────────────────────────────────────────

await check("None: no-op; SetState: enterState(state, \"set\"), empty name ⇒ error", () => {
  assert.deepEqual(act({ t: "None" }).states, []);
  assert.deepEqual(act({ t: "SetState", state: "dead" }).states, [["dead", "set"]]);
  const l = act({ t: "SetState", state: "" });
  assert.deepEqual(l.states, []);
  assert.equal(l.echoes.length, 1);
});

await check("Chat: trimmed line to the chat runner (dispatcher first); empty text is a no-op", () => {
  assert.deepEqual(act({ t: "Chat", text: "  /vt nav load runback  " }).out, ["/vt nav load runback"]);
  assert.deepEqual(act({ t: "Chat", text: "   " }).out, []);
});

await check("DoAll: every child in order, nested, a throwing child recorded and the rest still run", () => {
  const { rc, log } = makeRc();
  const orig = rc.chatRun;
  rc.chatRun = (line) => {
    if (line === "/x boom") throw new Error("kaboom");
    orig(line);
  };
  runAction({ t: "DoAll", children: [{ t: "Chat", text: "/x 1" }, { t: "SetState", state: "s" }, { t: "Chat", text: "/x boom" }, { t: "DoAll", children: [{ t: "Chat", text: "/x 2" }] }] }, rc);
  assert.deepEqual(log.out, ["/x 1", "/x 2"]);
  assert.deepEqual(log.states, [["s", "set"]]);
  assert.ok(log.errors.some((e) => /kaboom/.test(e)));
});

await check("action depth capped at 64", () => {
  let a = { t: "Chat", text: "/x deep" };
  for (let i = 0; i < 70; i++) a = { t: "DoAll", children: [a] };
  const l = act(a);
  assert.deepEqual(l.out, []);
  assert.ok(l.errors.some((e) => /deeper than 64/.test(e)));
});

await check("EmbedNav: loads meta.navs[tag] (case-insensitive tag); an EMPTY route is passed through (clears, B3); missing tag ⇒ error", () => {
  const loads = [];
  const nav = { loadEmbedded: (tag, mn) => (loads.push([tag, mn]), { ok: true }) };
  const meta = { navs: { Route1: { displayName: "[None]", routeType: 1, navText: "" }, hunt: { displayName: "hunt", routeType: 1, navText: "uTank2 NAV 1.2\r\n1\r\n0\r\n" } } };
  act({ t: "EmbedNav", tag: "route1", displayName: "[None]" }, { ctx: { nav }, meta });
  act({ t: "EmbedNav", tag: "hunt" }, { ctx: { nav }, meta });
  assert.deepEqual(loads.map((l) => [l[0], l[1].navText]), [["route1", ""], ["hunt", "uTank2 NAV 1.2\r\n1\r\n0\r\n"]]);
  const l = act({ t: "EmbedNav", tag: "nope" }, { ctx: { nav }, meta });
  assert.equal(loads.length, 2);
  assert.ok(l.echoes.some((e) => /nope/.test(e)));
  assert.ok(act({ t: "EmbedNav", tag: "hunt" }, { ctx: {}, meta }).echoes.length === 1, "no nav service ⇒ error");
  const bad = act({ t: "EmbedNav", tag: "hunt" }, { ctx: { nav: { loadEmbedded: () => ({ ok: false, error: "bad nav" }) } }, meta });
  assert.ok(bad.echoes.some((e) => /bad nav/.test(e)));
});

await check("CallState / Return delegate to the engine's stack ops", () => {
  assert.deepEqual(act({ t: "CallState", state: "sub", ret: "combine" }).calls, [["call", "sub", "combine"]]);
  assert.deepEqual(act({ t: "CallState", state: "sub" }).calls, [["call", "sub", undefined]]);
  assert.deepEqual(act({ t: "Return" }).calls, [["return"]]);
});

await check("DoExpr: evaluated and discarded; an error goes to the debug strip only (no chat)", () => {
  const l = act({ t: "DoExpr", expr: "setvar[a,1]" });
  assert.deepEqual(l.evaluated, ["setvar[a,1]"]);
  assert.deepEqual(l.out, []);
  const e = act({ t: "DoExpr", expr: "x" }, { evaluate: () => ({ t: "err", msg: "Call to unknown function \"x\"" }) });
  assert.deepEqual(e.out, []);
  assert.deepEqual(e.echoes, []);
  assert.ok(e.errors.some((m) => /unknown function/.test(m)));
});

await check("ChatExpr: non-empty non-error result routed like Chat; ERR never sent (B18); empty result not sent", () => {
  assert.deepEqual(act({ t: "ChatExpr", expr: "x" }, { evaluate: () => "/f hello" }).out, ["/f hello"]);
  const e = act({ t: "ChatExpr", expr: "x" }, { evaluate: () => ({ t: "err", msg: "boom" }) });
  assert.deepEqual(e.out, []);
  assert.ok(e.errors.length === 1);
  assert.deepEqual(act({ t: "ChatExpr", expr: "x" }, { evaluate: () => "" }).out, []);
  assert.deepEqual(act({ t: "ChatExpr", expr: "x" }, { evaluate: () => true }).out, ["1"], "Bool stringifies 1/0");
});

await check("SetWatchdog / ClearWatchdog: spec passed through; bad numbers ⇒ 5 m / 5 s; empty state ⇒ error", () => {
  assert.deepEqual(act({ t: "SetWatchdog", state: "RunBack", dist: 5, secs: 25 }).wd, [{ state: "RunBack", dist: 5, secs: 25 }]);
  assert.deepEqual(act({ t: "SetWatchdog", state: "x", dist: "?", secs: -1 }).wd, [{ state: "x", dist: 5, secs: 5 }]);
  assert.equal(act({ t: "SetWatchdog", state: "", dist: 1, secs: 1 }).echoes.length, 1);
  assert.deepEqual(act({ t: "ClearWatchdog" }).wd, ["clear"]);
});

function settingsFake() {
  const known = { EnableCombat: true, AttackDistance: 40 };
  const writes = [];
  const bag = new Map();
  return {
    known,
    writes,
    bag,
    api: {
      get: (n) => {
        const k = Object.keys(known).find((x) => x.toLowerCase() === String(n).toLowerCase());
        return k ? { ok: true, value: known[k] } : { ok: false, error: `unknown option ${n}` };
      },
      set: (n, raw, o) => {
        writes.push([n, raw, o && o.source]);
        if (String(raw) === "bogus") return { ok: false, error: "EnableCombat: expected true/false" };
        return { ok: true, value: raw };
      },
      getValue: (k) => known[k],
      bagGet: (n) => bag.get(String(n).toLowerCase()),
      bagSet: (n, v) => bag.set(String(n).toLowerCase(), v),
      disableMeta: () => {},
    },
  };
}

await check("GetOpt: real option value into the variable; unknown ⇒ meta bag; never set ⇒ 0 + one warning", () => {
  const s = settingsFake();
  assert.equal(act({ t: "GetOpt", opt: "enablecombat", var: "ec" }, { ctx: { settings: s.api } }).vars.get("ec"), true);
  s.bag.set("mycustom", "hello");
  assert.equal(act({ t: "GetOpt", opt: "MyCustom", var: "mc" }, { ctx: { settings: s.api } }).vars.get("mc"), "hello");
  const l = act({ t: "GetOpt", opt: "Nope", var: "n" }, { ctx: { settings: s.api } });
  assert.equal(l.vars.get("n"), 0);
  assert.equal(l.warns.length, 1);
  assert.equal(act({ t: "GetOpt", opt: "", var: "n" }, { ctx: { settings: s.api } }).echoes.length, 1);
});

await check("SetOpt: the EXPRESSION is evaluated (GUIDE:289, B10) and written with source \"meta\"; unknown ⇒ bag + one warning", () => {
  const s = settingsFake();
  const l = act({ t: "SetOpt", opt: "EnableCombat", expr: "False" }, { ctx: { settings: s.api }, evaluate: (src) => (src === "False" ? "False" : "?") });
  assert.deepEqual(s.writes, [["EnableCombat", "False", "meta"]]);
  assert.deepEqual(l.evaluated, ["False"]);
  act({ t: "SetOpt", opt: "AttackDistance", expr: "x" }, { ctx: { settings: s.api }, evaluate: () => 25 });
  assert.deepEqual(s.writes.at(-1), ["AttackDistance", 25, "meta"]);
  act({ t: "SetOpt", opt: "AttackDistance", expr: "x" }, { ctx: { settings: s.api }, evaluate: () => ({ t: "list", items: [] }) });
  assert.deepEqual(s.writes.at(-1), ["AttackDistance", "[list]", "meta"], "non-scalar values are stringified");
  const bad = act({ t: "SetOpt", opt: "EnableCombat", expr: "x" }, { ctx: { settings: s.api }, evaluate: () => "bogus" });
  assert.ok(bad.echoes.some((e) => /expected true\/false/.test(e)));
  const n = s.writes.length;
  const errv = act({ t: "SetOpt", opt: "EnableCombat", expr: "x" }, { ctx: { settings: s.api }, evaluate: () => ({ t: "err", msg: "nope" }) });
  assert.equal(s.writes.length, n, "an error result is never written");
  assert.equal(errv.echoes.length, 1);
  const u = act({ t: "SetOpt", opt: "MyFlag", expr: "x" }, { ctx: { settings: s.api }, evaluate: () => 7 });
  assert.equal(s.bag.get("myflag"), 7);
  assert.equal(u.warns.length, 1);
  assert.equal(s.writes.length, n, "unknown names never reach set()");
});

await check("CreateView / DestroyView / DestroyAllViews go to ctx.views; a failed create is reported", () => {
  const calls = [];
  const views = {
    create: (n, x) => (calls.push(["create", n, x]), n === "bad" ? { ok: false, error: "invalid view XML" } : { ok: true }),
    destroy: (n) => calls.push(["destroy", n]),
    destroyAll: () => calls.push(["destroyAll"]),
  };
  act({ t: "CreateView", view: "Turn In", xml: "<view/>" }, { ctx: { views } });
  const bad = act({ t: "CreateView", view: "bad", xml: "<" }, { ctx: { views } });
  act({ t: "DestroyView", view: "Turn In" }, { ctx: { views } });
  act({ t: "DestroyAllViews" }, { ctx: { views } });
  assert.deepEqual(calls, [["create", "Turn In", "<view/>"], ["create", "bad", "<"], ["destroy", "Turn In"], ["destroyAll"]]);
  assert.ok(bad.echoes.some((e) => /invalid view XML/.test(e)));
  assert.equal(act({ t: "CreateView", view: "x", xml: "" }, { ctx: {} }).echoes.length, 1);
});

await check("unknown action keyword ⇒ no-op + one warning", () => {
  const l = act({ t: "LaunchRocket" });
  assert.equal(l.warns.length, 1);
  assert.deepEqual(l.out, []);
  act(null);
});

await check("describeCondition / describeAction produce text for every keyword", () => {
  for (const k of CONDITION_KEYWORDS) assert.ok(describeCondition({ t: k, children: [{ t: "Always" }] }).length > 0, k);
  for (const k of ACTION_KEYWORDS) assert.ok(describeAction({ t: k, children: [{ t: "None" }] }).length > 0, k);
  assert.equal(describeCondition({ t: "BlockE", value: 0xc8e90000 }), "BlockE C8E90000");
  assert.equal(describeAction({ t: "CallState", state: "a", ret: "b" }), "CallState {a} {b}");
});

// ── event semantics through a real engine ───────────────────────────────

function engineWith(rules, ctxOver = {}) {
  const clock = { t: T0 };
  const out = [];
  const prints = [];
  const ctx = {
    print: (t) => prints.push(t),
    settings: { getValue: (k) => (k === "EnableMeta" ? true : undefined), get: () => ({ ok: false }), set: () => ({ ok: true }) },
    chat: { run: (l) => out.push(l) },
    ...ctxOver,
  };
  const expr = { evaluate: (s) => (s === "bad" ? { t: "err", msg: "Call to unknown function \"bad\"" } : s), vars: { flush() {} }, pump() {}, setVar() {} };
  const engine = new MetaEngine({ ctx, expr, getRegex: regex, values: VALUES, setVar() {}, state: {}, now: () => clock.t, log: () => {} });
  engine.load({ rules: rules.map((r, i) => ({ id: `r${i + 1}`, enabled: true, ...r })), navs: {} });
  const tick = (ms = 100) => {
    clock.t += ms;
    engine.tick(clock.t, { running: true });
  };
  return { engine, out, prints, tick };
}

await check("Death / VendorClosed / IntoPortal / ExitPortal are edges: true for exactly one pass", () => {
  const re = (t) => ({ state: "Default", cond: { t }, act: { t: "Chat", text: `/x ${t}` } });
  const reArm = { state: "Default", cond: { t: "SecsInStateGE", secs: 0.15 }, act: { t: "SetState", state: "Default" } };
  const h = engineWith([re("Death"), re("VendorClosed"), re("IntoPortal"), re("ExitPortal"), reArm]);
  h.tick();
  h.engine.pushEvent({ type: "death" });
  h.engine.pushEvent({ type: "vendorClose", guid: 7 });
  h.engine.pushEvent({ type: "portalIn" });
  h.engine.pushEvent({ type: "portalOut" });
  h.tick(10);
  assert.deepEqual(h.out, ["/x Death", "/x VendorClosed", "/x IntoPortal", "/x ExitPortal"]);
  for (let i = 0; i < 20; i++) h.tick(); // re-armed repeatedly, but no new events
  assert.equal(h.out.length, 4);
});

await check("Any Vendor Open is a LEVEL (vendorOpen … vendorClose), seen by every pass in between", () => {
  const h = engineWith([
    { state: "Default", cond: { t: "VendorOpen" }, act: { t: "Chat", text: "/x open" } },
    { state: "Default", cond: { t: "SecsInStateGE", secs: 0.2 }, act: { t: "SetState", state: "Default" } },
  ]);
  h.engine.pushEvent({ type: "vendorOpen", guid: 9, name: "Shopkeep" });
  for (let i = 0; i < 10; i++) h.tick();
  const n = h.out.length;
  assert.ok(n >= 2, `level stays true across re-arms (${n})`);
  h.engine.pushEvent({ type: "vendorClose", guid: 9 });
  for (let i = 0; i < 10; i++) h.tick();
  assert.equal(h.out.length, n);
});

await check("ChatMatch sees every line pushed since the last pass (no 1 s window, no lost lines)", () => {
  const h = engineWith([{ state: "Default", cond: { t: "ChatMatch", re: "^second$" }, act: { t: "Chat", text: "/x got it" } }]);
  h.tick();
  h.engine.pushEvent({ type: "chat", text: "second", chatType: 0 });
  h.engine.pushEvent({ type: "chat", text: "third", chatType: 0 });
  h.tick(10);
  assert.deepEqual(h.out, ["/x got it"]);
});

await check("an Expr error is echoed once per rule (not every pass), and recorded in lastError", () => {
  const h = engineWith([
    { state: "Default", cond: { t: "Expr", expr: "bad" }, act: { t: "Chat", text: "/x never" } },
    { state: "Default", cond: { t: "SecsInStateGE", secs: 0.2 }, act: { t: "SetState", state: "Default" } },
  ]);
  for (let i = 0; i < 30; i++) h.tick();
  assert.equal(h.prints.filter((p) => /unknown function/.test(p)).length, 1);
  assert.equal(h.engine.snapshot().lastError.ruleId, "r1");
  assert.deepEqual(h.out, []);
});

console.log(fail === 0 ? `rynth_vt_meta_conditions: all ${pass} checks passed` : `rynth_vt_meta_conditions: ${fail} FAILED (${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);
