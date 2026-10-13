// tests/rynth_vt_monsters.test.mjs — rynth/vt/combat/monster_list.js and
// monster_vars.js (PLAN W1-7 CMB; M1, M16, M22-M25, G:68-150).
//
// The expression engine is a FAKE (C2: no import of rynth/vt/expr): a small
// monster-mode evaluator with the §3.4 shape — parse(text, {mode}) →
// {ok, ast, refs, dynamic}, evaluate(parsed, resolveIdent) → Value; string
// tokens keep inner spaces and are trimmed at operators (D14), unknown words
// are literal strings (G:119), == / != compare numbers numerically and strings
// case-insensitively (G:147).
//
// Run from apps/holtburger-web/:  node tests/rynth_vt_monsters.test.mjs

import assert from "node:assert/strict";

const ML = await import("../rynth/vt/combat/monster_list.js");
const MV = await import("../rynth/vt/combat/monster_vars.js");
const CP = await import("../rynth/vt/combat/creature_profiles.js");
const { MonsterList, DEFAULT_ENTRY, MONSTER_COLUMNS, MONSTER_VARIABLES, normalizeEntry, fromRynthAiRule, fromLegacyPriorities } = ML;
const { makeMonsterVars } = MV;

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

// ── fake monster-mode expression engine ──────────────────────────────────
const OPS = ["&&", "||", "==", "!=", ">=", "<=", ">", "<", "(", ")", "-"];
function lex(src) {
  const toks = [];
  let i = 0;
  let buf = "";
  const flush = () => {
    if (buf.trim() !== "") toks.push({ t: "word", v: buf.trim() });
    buf = "";
  };
  while (i < src.length) {
    const op = OPS.find((o) => src.startsWith(o, i));
    if (op) {
      flush();
      toks.push({ t: "op", v: op });
      i += op.length;
    } else buf += src[i++];
  }
  flush();
  return toks;
}
const DYNAMIC = new Set(["range", "hasshield", "metastate"]);
function fakeParse(src, { mode = "meta" } = {}) {
  const toks = lex(String(src));
  let p = 0;
  const refs = new Set();
  const peek = () => toks[p];
  const eat = (v) => (peek() && peek().t === "op" && peek().v === v ? (p++, true) : false);
  const primary = () => {
    const t = toks[p++];
    if (!t) throw new Error("unexpected end");
    if (t.t === "op" && t.v === "(") {
      const e = or();
      if (!eat(")")) throw new Error("unbalanced (");
      return e;
    }
    if (t.t !== "word") throw new Error(`unexpected ${t.v}`);
    const n = Number(t.v);
    if (Number.isFinite(n)) return { k: "num", v: n };
    refs.add(t.v.toLowerCase());
    return { k: "word", lower: t.v.toLowerCase(), name: t.v };
  };
  const sub = () => {
    let a = primary();
    while (eat("-")) a = { k: "sub", a, b: primary() };
    return a;
  };
  const cmp = () => {
    let a = sub();
    for (;;) {
      const t = peek();
      if (t && t.t === "op" && ["==", "!=", ">=", "<=", ">", "<"].includes(t.v)) {
        p++;
        a = { k: "cmp", op: t.v, a, b: sub() };
      } else return a;
    }
  };
  const and = () => {
    let a = cmp();
    while (eat("&&")) a = { k: "and", a, b: cmp() };
    return a;
  };
  const or = () => {
    let a = and();
    while (eat("||")) a = { k: "or", a, b: and() };
    return a;
  };
  try {
    const ast = or();
    if (p < toks.length) throw new Error(`unexpected ${toks[p].v}`);
    let dynamic = false;
    if (mode === "monster") for (const r of refs) if (DYNAMIC.has(r) || r.startsWith("setting_")) dynamic = true;
    return { ok: true, ast, refs, dynamic };
  } catch (e) {
    return { ok: false, error: e.message, pos: p };
  }
}
const num = (v) => (typeof v === "number" ? v : typeof v === "boolean" ? (v ? 1 : 0) : Number(String(v).trim()));
const isNum = (v) => typeof v === "number" || (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v.trim())));
const fakeTruthy = (v) => {
  if (v === null || v === undefined) return false;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") return v !== "" && v !== "0" && v.toLowerCase() !== "false";
  return !(v && v.t === "err");
};
const fakeEquals = (a, b) => {
  if (a == null || b == null) return false;
  if (typeof a === "object" || typeof b === "object") return false;
  if (typeof a === "boolean" || typeof b === "boolean") return num(a) === num(b);
  if (isNum(a) && isNum(b)) return num(a) === num(b);
  return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
};
let evalCalls = 0;
function fakeEvaluate(parsed, resolveIdent) {
  evalCalls++;
  const ev = (n) => {
    switch (n.k) {
      case "num":
        return n.v;
      case "word": {
        const v = resolveIdent ? resolveIdent(n.lower, n.name) : undefined;
        if (v !== undefined) return v;
        if (n.lower === "true") return true;
        if (n.lower === "false") return false;
        return n.name;
      }
      case "sub": {
        const a = ev(n.a);
        const b = ev(n.b);
        return isNum(a) && isNum(b) ? num(a) - num(b) : 0;
      }
      case "cmp": {
        const a = ev(n.a);
        const b = ev(n.b);
        if (n.op === "==") return fakeEquals(a, b);
        if (n.op === "!=") return !fakeEquals(a, b);
        const x = isNum(a) ? num(a) : 0;
        const y = isNum(b) ? num(b) : 0;
        return n.op === ">" ? x > y : n.op === "<" ? x < y : n.op === ">=" ? x >= y : x <= y;
      }
      case "and":
        return fakeTruthy(ev(n.a)) && fakeTruthy(ev(n.b));
      case "or":
        return fakeTruthy(ev(n.a)) || fakeTruthy(ev(n.b));
      default:
        return { t: "err", msg: "bad node" };
    }
  };
  try {
    return ev(parsed.ast);
  } catch (e) {
    return { t: "err", msg: e.message };
  }
}

// ── fake world ───────────────────────────────────────────────────────────
let NOW = 1_800_000_000_000;
const now = () => NOW;
const SHRETH = 0x80000001;
const DRUDGE = 0x80000002;
const RAVENER = 0x80000003;
const OLTHOI = 0x80000004;
const LORD = 0x80000005;
function makeHost() {
  const objs = new Map([
    [SHRETH, { name: "Blood Shreth", wcid: 1001, dist: 20, ct: 32, shield: false }],
    [DRUDGE, { name: "Drudge Skulker", wcid: 1002, dist: 20, ct: 3, shield: true }],
    [RAVENER, { name: "Drudge Ravener", wcid: 1003, dist: 20, ct: 3, shield: false }],
    [OLTHOI, { name: "Olthoi Soldier", wcid: 1004, dist: 8, ct: null, maxHp: null, shield: null }],
    [LORD, { name: "Drudge-Lord", wcid: 1005, dist: 3, ct: 3, shield: false }],
  ]);
  const host = {
    snap: { seq: 1 },
    objs,
    calls: [],
    TryGetObjectName: (g) => objs.get(g)?.name ?? null,
    TryGetObjectWcid: (g) => objs.get(g)?.wcid ?? 0,
    TryGetObjectDistance: (g) => objs.get(g)?.dist ?? null,
    HasShield: (g) => objs.get(g)?.shield ?? null,
    TryGetObjectIntProperty: (g, stype) => (stype === 2 ? objs.get(g)?.ct ?? undefined : undefined),
    TryGetCreatureInfo(g, opts = {}) {
      const o = objs.get(g);
      if (opts.requestAppraisal) host.calls.push(["appraise", g]);
      return o ? { guid: g, name: o.name, wcid: o.wcid, creatureType: o.ct ?? null, maxHp: o.maxHp ?? null, dist: o.dist, hasShield: o.shield } : null;
    },
  };
  return host;
}
function makeOptions(values = {}) {
  const v = { DoJiggle: true, MonsterRange: 40, ...values };
  return {
    get(name, { exactCase = false, vtUnits = false } = {}) {
      if (name === "AttackDistance") return { ok: true, value: vtUnits ? v.MonsterRange / 240 : v.MonsterRange };
      if (Object.prototype.hasOwnProperty.call(v, name)) return { ok: true, value: v[name] };
      if (!exactCase) {
        const k = Object.keys(v).find((x) => x.toLowerCase() === String(name).toLowerCase());
        if (k) return { ok: true, value: v[k] };
      }
      return { ok: false, error: `unknown option ${name}` };
    },
    getValue: (k) => v[k],
    set: (k, x) => (v[k] = x),
  };
}
function makeList({ entries = [], host = makeHost(), options = makeOptions(), meta = "Default", logs = [] } = {}) {
  const varsFor = makeMonsterVars({ host, options, creatures: null, getMetaState: () => meta, now, log: (m) => logs.push(m) });
  const list = new MonsterList({ entries, parse: fakeParse, evaluate: fakeEvaluate, truthy: fakeTruthy, equalsCI: fakeEquals, varsFor, log: (m) => logs.push(m) });
  return { list, host, options, logs };
}
const E = (text, extra = {}) => ({ text, ...extra });

await CP.loadCreatureSpecies();

await check("DEFAULT_ENTRY / MONSTER_COLUMNS / normalizeEntry defaults and coercions", () => {
  assert.deepEqual([...MONSTER_COLUMNS], ["F", "B", "G", "I", "Y", "V", "A", "R", "S", "WC", "FC", "Cp", "DC", "Cs"]);
  assert.equal(DEFAULT_ENTRY.text, "DEFAULT");
  assert.equal(DEFAULT_ENTRY.priority, 1);
  assert.equal(DEFAULT_ENTRY.A, true);
  for (const c of MONSTER_COLUMNS) if (c !== "A") assert.equal(DEFAULT_ENTRY[c], false, c);
  assert.equal(DEFAULT_ENTRY.damageType, "Auto");
  assert.equal(DEFAULT_ENTRY.exVuln, "None");
  assert.equal(DEFAULT_ENTRY.petDmg, "PAuto");
  assert.equal(DEFAULT_ENTRY.weapon, 0);
  assert.equal(DEFAULT_ENTRY.arc, false);
  assert.ok(Object.isFrozen(DEFAULT_ENTRY));
  const n = normalizeEntry({ text: "x", priority: 9, Y: "true", A: 0, damageType: "electric", exVuln: "blade", weapon: -5, petDmg: "frost" });
  assert.equal(n.priority, 4, "clamped to 4");
  assert.equal(n.Y, true);
  assert.equal(n.A, false);
  assert.equal(n.damageType, "Lightning", "Electric → Lightning");
  assert.equal(n.exVuln, "Slash", "Blade → Slash");
  assert.equal(n.weapon, 0);
  assert.equal(n.petDmg, "Cold");
  assert.equal(normalizeEntry({ priority: -7 }).priority, -1);
  assert.equal(normalizeEntry({ damageType: "garbage" }).damageType, "Auto");
  assert.equal(normalizeEntry({}).A, true, "A defaults on");
  assert.equal(normalizeEntry({ text: "default", enabled: false }).enabled, true, "DEFAULT cannot be disabled");
});

await check("DEFAULT pinned at index 0 and undeletable; a stored DEFAULT keeps its columns; duplicates dropped", () => {
  const { list } = makeList({ entries: [E("Blood Shreth", { S: true }), E("Drudge Skulker")] });
  const es = list.entries();
  assert.equal(es.length, 3);
  assert.equal(es[0].text, "DEFAULT");
  assert.equal(es[1].text, "Blood Shreth");
  list.setEntries([E("a"), { ...DEFAULT_ENTRY, text: "Default", priority: -1 }, E("b"), E("DEFAULT", { priority: 4 })]);
  const es2 = list.entries();
  assert.deepEqual(es2.map((e) => e.text), ["DEFAULT", "a", "b"]);
  assert.equal(es2[0].priority, -1, "the stored DEFAULT row keeps its P");
  list.setEntries([]);
  assert.deepEqual(list.entries().map((e) => e.text), ["DEFAULT"], "removing everything still leaves DEFAULT");
  const before = list.rev;
  list.setEntries(null);
  assert.ok(list.rev > before, "rev bumps on every set");
  es2[0].text = "mutated";
  assert.equal(list.entries()[0].text, "DEFAULT", "entries() returns copies");
});

await check("isDefaultOnly: stock DEFAULT only; an edited DEFAULT row or any extra entry is not", () => {
  const { list } = makeList();
  assert.equal(list.isDefaultOnly(), true);
  list.setEntries([{ ...DEFAULT_ENTRY }]);
  assert.equal(list.isDefaultOnly(), true);
  list.setEntries([{ ...DEFAULT_ENTRY, Y: true }]);
  assert.equal(list.isDefaultOnly(), false, "edited DEFAULT");
  list.setEntries([{ ...DEFAULT_ENTRY, priority: 0 }]);
  assert.equal(list.isDefaultOnly(), false);
  list.setEntries([E("rat", { enabled: false })]);
  assert.equal(list.isDefaultOnly(), false, "a disabled extra entry still counts");
});

await check("first match: by literal name, by expression, by evaluated name; else DEFAULT; order matters", () => {
  const { list } = makeList({
    entries: [E("Blood Shreth", { S: true }), E("range>5 && species==drudge && name!=drudge ravener", { Y: true }), E("Drudge Ravener", { priority: 3 })],
  });
  assert.equal(list.resolve(SHRETH, { seq: 1 }).index, 1, "literal name");
  assert.equal(list.resolve(DRUDGE, { seq: 1 }).index, 2, "expression (multi-word literal kept)");
  assert.equal(list.resolve(RAVENER, { seq: 1 }).index, 3, "ravener excluded by name!=… then matched by its own name");
  assert.equal(list.resolve(OLTHOI, { seq: 1 }).index, 0, "no match → DEFAULT");
  assert.equal(list.resolve(0x8000ffff, { seq: 1 }).index, 0, "unknown guid → DEFAULT");
  // order: the first matching entry wins
  list.setEntries([E("species==drudge", { priority: 2 }), E("Drudge Skulker", { priority: 4 })]);
  assert.equal(list.resolve(DRUDGE, { seq: 2 }).entry.priority, 2);
});

await check("a plain name only matches that monster (a truthy string is NOT 'true'); case-insensitive", () => {
  const { list } = makeList({ entries: [E("blood shreth"), E("  DRUDGE skulker  ")] });
  assert.equal(list.resolve(SHRETH, { seq: 1 }).index, 1);
  assert.equal(list.resolve(DRUDGE, { seq: 1 }).index, 2);
  assert.equal(list.resolve(RAVENER, { seq: 1 }).index, 0, "'blood shreth' must not match a Drudge Ravener");
  assert.equal(list.resolve(OLTHOI, { seq: 1 }).index, 0);
});

await check("evaluated name and raw-text fallback (operator characters, parse errors)", () => {
  const { list, logs } = makeList({ entries: [E("Drudge-Lord", { priority: 4 }), E("bad (( text"), E("true", { priority: 0 })] });
  assert.equal(list.resolve(LORD, { seq: 1 }).index, 1, "'Drudge-Lord' parses as a subtraction; the raw text still names it");
  assert.equal(list.resolve(DRUDGE, { seq: 1 }).index, 3, "`true` matches everything after");
  assert.ok(logs.some((m) => /does not parse/.test(m)), "parse failure logged");
  const { list: l2 } = makeList({ entries: [E("bad (( text"), E("false"), E("1"), E("0")] });
  assert.equal(l2.resolve(DRUDGE, { seq: 1 }).index, 3, "number 1 is true; false/0 are not");
  const { list: l3 } = makeList({ entries: [E("name")] });
  assert.equal(l3.resolve(DRUDGE, { seq: 1 }).index, 1, "an expression that EVALUATES to the monster's name matches");
});

await check("disabled entries are skipped; P = -1 / 0..4 via priorityOf", () => {
  const { list } = makeList({ entries: [E("Blood Shreth", { enabled: false, priority: 4 }), E("Blood Shreth", { priority: -1 }), E("Drudge Skulker", { priority: 3 })] });
  assert.equal(list.resolve(SHRETH, { seq: 1 }).index, 2);
  assert.equal(list.priorityOf(SHRETH, { seq: 1 }), -1, "ignore completely");
  assert.equal(list.priorityOf(DRUDGE, { seq: 1 }), 3);
  assert.equal(list.priorityOf(OLTHOI, { seq: 1 }), 1, "DEFAULT P");
});

await check("static cache: cached per (rev, guid) only once every referenced static var resolved", () => {
  const { list, host } = makeList({ entries: [E("species==olthoi", { priority: 4 }), E("name==Drudge Skulker", { priority: 3 })] });
  evalCalls = 0;
  for (let s = 1; s <= 5; s++) list.resolve(DRUDGE, { seq: s });
  // entry 1 (species, resolved: Drudge) and entry 2 (name) evaluated once each, then cached
  assert.equal(evalCalls, 2, `static + ready ⇒ cached (got ${evalCalls})`);
  evalCalls = 0;
  for (let s = 6; s <= 9; s++) assert.equal(list.resolve(OLTHOI, { seq: s }).index, 0);
  // the Olthoi has no CreatureType yet: entry 1 is skipped (not evaluated, not
  // cached) every scan; entry 2 evaluated once, then cached
  assert.equal(evalCalls, 1, `unresolved species ⇒ skipped + no cache (got ${evalCalls})`);
  host.objs.get(OLTHOI).ct = 1; // an appraisal taught it: Olthoi
  assert.equal(list.resolve(OLTHOI, { seq: 10 }).index, 1, "re-evaluated with the learned species");
  evalCalls = 0;
  list.resolve(OLTHOI, { seq: 11 });
  list.resolve(OLTHOI, { seq: 12 });
  assert.equal(evalCalls, 0, "now cached");
  list.invalidate();
  list.resolve(OLTHOI, { seq: 13 });
  assert.equal(evalCalls, 1, "invalidate() drops the cache");
});

await check("static cache is dropped when the guid names another object (ACE recycles dynamic guids)", () => {
  const { list, host } = makeList({ entries: [E("Drudge Skulker", { priority: 4 })] });
  assert.equal(list.priorityOf(DRUDGE, { seq: 1 }), 4);
  assert.equal(list.priorityOf(DRUDGE, { seq: 2 }), 4, "cached");
  host.objs.set(DRUDGE, { name: "Mosswart", wcid: 1006, dist: 5, ct: 4, shield: false });
  assert.equal(list.priorityOf(DRUDGE, { seq: 3 }), 1, "a recycled guid is not the old Drudge Skulker");
  host.objs.set(DRUDGE, { name: "Drudge Skulker", wcid: 1002, dist: 5, ct: 3, shield: false });
  assert.equal(list.priorityOf(DRUDGE, { seq: 4 }), 4);
});

await check("dynamic entries re-evaluate once per scan (snap.seq), memoised within one scan", () => {
  const { list, host } = makeList({ entries: [E("range>5", { Y: true, A: false })] });
  evalCalls = 0;
  assert.equal(list.resolve(DRUDGE, { seq: 1 }).index, 1);
  list.resolve(DRUDGE, { seq: 1 });
  list.resolve(DRUDGE, { seq: 1 });
  assert.equal(evalCalls, 1, "one evaluation per seq");
  host.objs.get(DRUDGE).dist = 4;
  assert.equal(list.resolve(DRUDGE, { seq: 1 }).index, 1, "same seq ⇒ memo");
  assert.equal(list.resolve(DRUDGE, { seq: 2 }).index, 0, "next scan ⇒ re-evaluated: now DEFAULT");
  assert.equal(evalCalls, 2);
  // no seq (no snapshot): evaluated every call
  list.resolve(DRUDGE, {});
  list.resolve(DRUDGE);
  assert.equal(evalCalls, 4);
});

await check("monster vars: name/typeid/species/maxhp/range/hasshield/metastate/true/false", () => {
  const host = makeHost();
  host.objs.get(DRUDGE).maxHp = 120;
  const vars = makeMonsterVars({ host, options: makeOptions(), getMetaState: () => "Hunt", now })(DRUDGE, { seq: 1 });
  assert.equal(vars.get("name"), "Drudge Skulker");
  assert.equal(vars.get("NAME"), "Drudge Skulker", "variable names are case-insensitive");
  assert.equal(vars.get("typeid"), 1002, "typeid = WCID (D31)");
  assert.equal(vars.get("species"), "Drudge");
  assert.equal(vars.get("maxhp"), 120);
  assert.equal(vars.get("range"), 20);
  assert.equal(vars.get("hasshield"), true);
  assert.equal(vars.get("metastate"), "Hunt");
  assert.equal(vars.get("true"), true);
  assert.equal(vars.get("false"), false);
  assert.equal(vars.get("drudge"), undefined, "not a variable ⇒ literal text");
  assert.equal(vars.staticReady("name"), true);
  assert.equal(vars.staticReady("species"), true);
  assert.equal(vars.staticReady("maxhp"), true);
  const v2 = makeMonsterVars({ host, now })(SHRETH, {});
  assert.equal(v2.get("species"), "Shreth");
  assert.equal(v2.get("hasshield"), false);
  assert.equal(v2.get("metastate"), "", "no meta");
});

await check("species falls back to the offline wcid table and learned profiles; unknown ⇒ '' (falsy, not ready)", () => {
  const host = makeHost();
  host.objs.get(OLTHOI).wcid = 11039; // LSD: Olthoi Noble, creatureType 1
  let vars = makeMonsterVars({ host, creatures: new CP.CreatureProfiles({ now }), now })(OLTHOI, {});
  assert.equal(vars.get("species"), "Olthoi", "creature_species.json");
  host.objs.get(OLTHOI).wcid = 4_000_000; // not in the dump
  const prof = new CP.CreatureProfiles({ now });
  vars = makeMonsterVars({ host, creatures: prof, now })(OLTHOI, {});
  assert.equal(vars.get("species"), "", "X-partial without the dump or an appraisal");
  assert.equal(vars.staticReady("species"), false);
  prof.noteAppraisal(OLTHOI, 4_000_000, "Olthoi Soldier", { properties: { ints: { CreatureType: 1 } }, creatureProfile: { health_max: 900 } });
  vars = makeMonsterVars({ host, creatures: prof, now })(OLTHOI, {});
  assert.equal(vars.get("species"), "Olthoi", "learned from an appraisal");
  assert.equal(vars.get("maxhp"), 900, "per-wcid learned max health");
});

await check("maxhp unknown ⇒ '' so `maxhp<1000` does not match; appraisal requested ≤ 2/s and once per guid per 60 s", () => {
  const host = makeHost();
  const make = makeMonsterVars({ host, now });
  assert.equal(make(OLTHOI, {}).get("maxhp"), "");
  assert.equal(make(DRUDGE, {}).get("maxhp"), "");
  assert.equal(make(SHRETH, {}).get("maxhp"), "");
  assert.deepEqual(host.calls.map((c) => c[1]), [OLTHOI, DRUDGE], "third request inside the same second is refused");
  NOW += 1000;
  make(SHRETH, {}).get("maxhp");
  make(OLTHOI, {}).get("maxhp");
  assert.deepEqual(host.calls.map((c) => c[1]), [OLTHOI, DRUDGE, SHRETH], "the Olthoi already asked < 60 s ago");
  NOW += 60_000;
  make(OLTHOI, {}).get("maxhp");
  assert.equal(host.calls.length, 4);
  const h1 = makeHost();
  const { list } = makeList({ host: h1, entries: [E("maxhp<1000", { priority: 4 })] });
  assert.equal(list.resolve(OLTHOI, { seq: 1 }).index, 0, "unknown maxhp never matches maxhp<1000 (\"\" would coerce to 0)");
  h1.objs.get(OLTHOI).maxHp = 900; // the appraisal arrived
  assert.equal(list.resolve(OLTHOI, { seq: 2 }).index, 1, "matches once maxhp is known");
  // an entry that never mentions species/maxhp never asks for an appraisal
  const h2 = makeHost();
  const { list: l2 } = makeList({ host: h2, entries: [E("range>5")] });
  l2.resolve(OLTHOI, { seq: 1 });
  assert.equal(h2.calls.length, 0);
});

await check("setting_X: exact case first (vtUnits), then case-insensitive with ONE warning; unknown = literal", () => {
  const logs = [];
  const opts = makeOptions({ DoJiggle: false });
  const make = makeMonsterVars({ host: makeHost(), options: opts, now, log: (m) => logs.push(m) });
  assert.equal(make(DRUDGE, {}).get("setting_DoJiggle"), false);
  assert.equal(logs.length, 0);
  assert.equal(make(DRUDGE, {}).get("setting_dojiggle"), false);
  assert.equal(make(DRUDGE, {}).get("setting_dojiggle"), false);
  assert.equal(logs.filter((m) => /case-insensitively/.test(m)).length, 1, "one warning per name");
  assert.ok(Math.abs(make(DRUDGE, {}).get("setting_AttackDistance") - 40 / 240) < 1e-9, "VTank units (lbf) like real metas expect");
  assert.equal(make(DRUDGE, {}).get("setting_Nope"), undefined);
  const { list } = makeList({ options: makeOptions({ DoJiggle: true }), entries: [E("setting_DoJiggle", { priority: 4 })] });
  assert.equal(list.resolve(DRUDGE, { seq: 1 }).index, 1);
});

await check("metastate entries follow the meta state per scan", () => {
  let state = "Default";
  const host = makeHost();
  const varsFor = makeMonsterVars({ host, getMetaState: () => state, now });
  const list = new MonsterList({ entries: [E("metastate==Hunt", { priority: 4 })], parse: fakeParse, evaluate: fakeEvaluate, truthy: fakeTruthy, equalsCI: fakeEquals, varsFor });
  assert.equal(list.resolve(DRUDGE, { seq: 1 }).index, 0);
  state = "hunt";
  assert.equal(list.resolve(DRUDGE, { seq: 2 }).index, 1, "case-insensitive string compare");
});

await check("no expression engine injected: name-only matching still works", () => {
  const host = makeHost();
  const list = new MonsterList({ entries: [E("Drudge Skulker", { priority: 4 }), E("range>5")], varsFor: makeMonsterVars({ host, now }) });
  assert.equal(list.resolve(DRUDGE, { seq: 1 }).index, 1);
  assert.equal(list.resolve(SHRETH, { seq: 1 }).index, 0);
  const bare = new MonsterList({ entries: [E("x")] });
  assert.equal(bare.resolve(DRUDGE).index, 0, "no varsFor ⇒ DEFAULT, never throws");
});

await check("resolve never throws: a throwing varsFor / evaluate falls back to DEFAULT", () => {
  const logs = [];
  const list = new MonsterList({
    entries: [E("range>5")],
    parse: fakeParse,
    evaluate: () => {
      throw new Error("boom");
    },
    varsFor: () => {
      throw new Error("vars boom");
    },
    log: (m) => logs.push(m),
  });
  assert.equal(list.resolve(DRUDGE, { seq: 1 }).index, 0);
});

await check("fromRynthAiRule: the U6 §1.5 import map (case-insensitive keys, UseBolt default true)", () => {
  const e = fromRynthAiRule({
    Name: "Drudge",
    MatchExpression: "",
    Priority: 3,
    Fester: true,
    Broadside: true,
    GravityWell: false,
    Imperil: true,
    Yield: true,
    Vuln: true,
    UseArc: true,
    UseRing: true,
    UseStreak: false,
    ExVuln: "Electric",
    DamageType: "Fire",
    WeaponId: 0x80001234,
    OffhandId: 7,
    PetDamage: "Cold",
  });
  assert.equal(e.text, "Drudge");
  assert.equal(e.priority, 3);
  assert.deepEqual([e.F, e.B, e.G, e.I, e.Y, e.V, e.A, e.R, e.S], [true, true, false, true, true, true, true, true, false]);
  assert.equal(e.arc, true, "UseArc ⇒ arc extension");
  assert.equal(e.exVuln, "Lightning");
  assert.equal(e.damageType, "Fire");
  assert.equal(e.weapon, 0x80001234);
  assert.equal(e.offhand, 7);
  assert.equal(e.petDmg, "Cold");
  const noBolt = fromRynthAiRule({ name: "rat", usebolt: false, usearc: false });
  assert.equal(noBolt.A, false, "neither Arc nor Bolt ⇒ debuff only");
  assert.equal(fromRynthAiRule({ name: "rat" }).A, true, "UseBolt absent ⇒ C# default true");
  const both = fromRynthAiRule({ Name: "Drudge-Lord", MatchExpression: "range>5" });
  assert.equal(both.text, "(range>5) && name==`Drudge-Lord`");
  assert.equal(fromRynthAiRule({ Name: "", MatchExpression: "maxhp>500" }).text, "maxhp>500");
  assert.equal(fromRynthAiRule({ Name: "Default", Priority: 0 }).text, "DEFAULT");
  assert.equal(fromRynthAiRule({ Name: "x", Priority: -1 }).priority, -1);
  assert.equal(fromRynthAiRule(null).text, "");
});

await check("fromLegacyPriorities: {name: p} → entries, P clamped to 0..4", () => {
  const es = fromLegacyPriorities({ olthoi: 10, rat: 0, Drudge: 3, "": 2, DEFAULT: 5, mosswart: "x" });
  assert.deepEqual(
    es.map((e) => [e.text, e.priority]),
    [["olthoi", 4], ["rat", 0], ["Drudge", 3], ["mosswart", 1]]
  );
  for (const e of es) assert.equal(e.A, true);
  assert.deepEqual(fromLegacyPriorities(null), []);
});

await check("MONSTER_VARIABLES: G:125-134 with DYNAMIC tags", () => {
  assert.deepEqual(
    MONSTER_VARIABLES.map((v) => [v.name, v.dynamic]),
    [
      ["true", false],
      ["false", false],
      ["name", false],
      ["typeid", false],
      ["species", false],
      ["maxhp", false],
      ["range", true],
      ["hasshield", true],
      ["setting_x", true],
      ["metastate", true],
    ]
  );
  for (const v of MONSTER_VARIABLES) assert.ok(typeof v.doc === "string" && v.doc.length > 5, v.name);
  assert.ok(Object.isFrozen(MONSTER_VARIABLES));
});

console.log(fail === 0 ? `rynth_vt_monsters: all ${pass} checks passed` : `rynth_vt_monsters: ${fail} FAILED (${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);
