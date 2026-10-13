// tests/rynth_vt_planner.test.mjs — rynth/vt/combat/attack_planner.js,
// debuff_ledger.js, items.js and creature_profiles.js (PLAN W1-7 CMB, §3.9;
// M2-M21, O6-O7, V-18).
//
// Everything outside the package is a fake (C2): the host (a RynthWebHost-
// shaped object), the signals bus (§3.2 Subscribe), VtOptions (getValue/get/
// getList/setList), a combat loop (mode, disengage, _scanTargets scored the
// way INT-1 will: 100 - d + scoreBias) and nav. The expression engine is a
// small monster-mode fake (same as tests/rynth_vt_monsters.test.mjs). The
// spell table is the REAL rynth/vt/data/combat_spells.json.
//
// Run from apps/holtburger-web/:  node tests/rynth_vt_planner.test.mjs

import assert from "node:assert/strict";

const T = await import("../rynth/vt/combat/spell_tables.js");
const { MonsterList, DEFAULT_ENTRY } = await import("../rynth/vt/combat/monster_list.js");
const { makeMonsterVars } = await import("../rynth/vt/combat/monster_vars.js");
const { DebuffLedger } = await import("../rynth/vt/combat/debuff_ledger.js");
const { AttackPlanner } = await import("../rynth/vt/combat/attack_planner.js");
const I = await import("../rynth/vt/combat/items.js");
const CP = await import("../rynth/vt/combat/creature_profiles.js");
await T.loadCombatSpells();
await CP.loadCreatureSpecies();

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

// ── fake monster-mode expression engine (see rynth_vt_monsters.test.mjs) ──
const OPS = ["&&", "||", "==", "!=", ">=", "<=", ">", "<", "(", ")"];
function fakeParse(src, { mode = "meta" } = {}) {
  const toks = [];
  let buf = "";
  const flush = () => {
    if (buf.trim()) toks.push({ t: "w", v: buf.trim() });
    buf = "";
  };
  for (let i = 0; i < src.length; ) {
    const op = OPS.find((o) => src.startsWith(o, i));
    if (op) {
      flush();
      toks.push({ t: "op", v: op });
      i += op.length;
    } else buf += src[i++];
  }
  flush();
  let p = 0;
  const refs = new Set();
  const eat = (v) => (toks[p] && toks[p].t === "op" && toks[p].v === v ? (p++, true) : false);
  const prim = () => {
    const t = toks[p++];
    if (!t) throw new Error("end");
    if (t.t === "op" && t.v === "(") {
      const e = or();
      if (!eat(")")) throw new Error("(");
      return e;
    }
    if (t.t !== "w") throw new Error(t.v);
    if (Number.isFinite(Number(t.v))) return { k: "n", v: Number(t.v) };
    refs.add(t.v.toLowerCase());
    return { k: "w", lower: t.v.toLowerCase(), name: t.v };
  };
  const cmp = () => {
    let a = prim();
    while (toks[p] && toks[p].t === "op" && ["==", "!=", ">=", "<=", ">", "<"].includes(toks[p].v)) a = { k: "c", op: toks[p++].v, a, b: prim() };
    return a;
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
    if (p < toks.length) throw new Error("trailing");
    const dynamic = mode === "monster" && [...refs].some((r) => ["range", "hasshield", "metastate"].includes(r) || r.startsWith("setting_"));
    return { ok: true, ast, refs, dynamic };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
const isNum = (v) => typeof v === "number" || (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)));
const truthy = (v) => (typeof v === "boolean" ? v : typeof v === "number" ? v !== 0 : typeof v === "string" ? v !== "" && v !== "0" && v.toLowerCase() !== "false" : !!v && v.t !== "err");
const equalsCI = (a, b) =>
  a != null && b != null && typeof a !== "object" && typeof b !== "object" && (isNum(a) && isNum(b) ? Number(a) === Number(b) : String(a).trim().toLowerCase() === String(b).trim().toLowerCase());
function fakeEvaluate(parsed, resolveIdent) {
  const ev = (n) => {
    if (n.k === "n") return n.v;
    if (n.k === "w") {
      const v = resolveIdent(n.lower, n.name);
      if (v !== undefined) return v;
      return n.lower === "true" ? true : n.lower === "false" ? false : n.name;
    }
    if (n.k === "and") return truthy(ev(n.a)) && truthy(ev(n.b));
    if (n.k === "or") return truthy(ev(n.a)) || truthy(ev(n.b));
    const a = ev(n.a);
    const b = ev(n.b);
    if (n.op === "==") return equalsCI(a, b);
    if (n.op === "!=") return !equalsCI(a, b);
    const x = isNum(a) ? Number(a) : 0;
    const y = isNum(b) ? Number(b) : 0;
    return n.op === ">" ? x > y : n.op === "<" ? x < y : n.op === ">=" ? x >= y : x <= y;
  };
  return ev(parsed.ast);
}

// ── fake world ───────────────────────────────────────────────────────────
let NOW = 1_800_000_000_000;
const now = () => NOW;
const SELF = 0x50000001;
const DRUDGE = 0x80000001;
const SHRETH = 0x80000002;
const OLTHOI = 0x80000003;
const MOSS = 0x80000004;
const RAT = 0x80000005;
const WAND = 0x60000001;
const SWORD = 0x60000002;
const BOW = 0x60000003;
const SHIELD = 0x60000004;
const AXE = 0x60000005;
const IT = { melee: 0x1, armor: 0x2, missile: 0x100, caster: 0x8000 };
const EM = { melee: 0x00100000, shield: 0x00200000, missile: 0x00400000, held: 0x01000000 };
const SKILLS = { 31: { current: 400, training: 3 }, 32: { current: 400, training: 3 }, 33: { current: 400, training: 3 }, 34: { current: 400, training: 3 }, 43: { current: 400, training: 3 } };
const knownOf = (...fams) => fams.flatMap((f) => T.familyLadder(f).map((r) => r.id));
const ALL_FAMS = T.familyNames();

function makeWorld({ known = knownOf(...ALL_FAMS), entries = [], opts = {}, wielded = [[WAND, IT.caster, EM.held]], mode = 8, state = undefined } = {}) {
  const objs = new Map([
    [DRUDGE, { name: "Drudge Skulker", wcid: 1002, dist: 20, ct: 3 }],
    [SHRETH, { name: "Blood Shreth", wcid: 1001, dist: 12, ct: 32 }],
    [OLTHOI, { name: "Olthoi Soldier", wcid: 1004, dist: 39, ct: 1 }],
    [MOSS, { name: "Mosswart", wcid: 1006, dist: 1, ct: 4 }],
    [RAT, { name: "Rat", wcid: 1007, dist: 30, ct: 10 }],
  ]);
  const inventory = [
    { guid: WAND, name: "Fire Baton", wcid: 2001, itemType: IT.caster, validLocations: EM.held, equipMask: 0 },
    { guid: SWORD, name: "Iron Sword", wcid: 2002, itemType: IT.melee, validLocations: EM.melee, equipMask: 0 },
    { guid: BOW, name: "Yumi", wcid: 2003, itemType: IT.missile, validLocations: EM.missile, equipMask: 0 },
    { guid: SHIELD, name: "Kite Shield", wcid: 2004, itemType: IT.armor, validLocations: EM.shield, equipMask: 0 },
    { guid: AXE, name: "War Axe", wcid: 2005, itemType: IT.melee, validLocations: EM.melee, equipMask: 0 },
  ];
  const host = {
    snap: { seq: 1 },
    objs,
    known,
    mode,
    wielded: wielded.map(([guid, itemType, equipMask]) => ({ guid, wcid: 0, itemType, equipMask })),
    inventory,
    actions: [],
    castToken: null,
    _itemToken: null,
    _claims: new Map(),
    GetPlayerId: () => SELF,
    TryGetObjectName: (g) => objs.get(g)?.name ?? null,
    TryGetObjectWcid: (g) => objs.get(g)?.wcid ?? 0,
    TryGetObjectDistance: (g) => objs.get(g)?.dist ?? null,
    HasShield: () => false,
    TryGetObjectIntProperty: (g, s) => (s === 1 ? (objs.has(g) ? 16 : undefined) : s === 2 ? objs.get(g)?.ct : s === 45 ? (g === WAND ? 0x10 : g === SWORD ? 0x1 : undefined) : undefined),
    TryGetCreatureInfo: (g) => (objs.has(g) ? { guid: g, name: objs.get(g).name, wcid: objs.get(g).wcid, creatureType: objs.get(g).ct, maxHp: null, dist: objs.get(g).dist } : null),
    TryGetKnownSpells: () => host.known.slice(),
    TryGetPlayerStats: () => ({ skills: SKILLS }),
    TryGetWieldedItems: (g) => (g === SELF ? host.wielded.map((r) => ({ ...r })) : []),
    TryGetPlayerInventory: () => host.inventory.map((r) => ({ ...r, equipMask: host.wielded.find((w) => w.guid === r.guid)?.equipMask ?? 0 })),
    GetCurrentCombatMode: () => host.mode,
    NearbyGuids: () => [...objs.keys()],
    ObjectIsPlayer: () => false,
    ObjectIsAttackable: () => true,
    TryGetTargetHealthFraction: () => 1,
    WieldItem(g, mask) {
      host.actions.push(["wield", g, mask]);
      return true;
    },
    UnwieldItem(g) {
      host.actions.push(["unwield", g]);
      return true;
    },
    ChangeCombatMode(m) {
      host.actions.push(["mode", m]);
      return true;
    },
    tryClaimItemAction(owner, o = {}) {
      const live = host._itemToken && NOW - host._itemToken.at < 8000;
      if (live && host._itemToken.owner !== owner) return false;
      const last = host._claims.get(owner);
      if (o.minIntervalMs && last != null && NOW - last < o.minIntervalMs) return false;
      host._itemToken = { owner, at: NOW };
      host._claims.set(owner, NOW);
      host.actions.push(["claim", owner]);
      return true;
    },
    releaseItemAction(owner) {
      if (host._itemToken && host._itemToken.owner === owner) host._itemToken = null;
    },
  };
  const values = {
    WarSpellMode: "legacy",
    SwitchWandsToDebuff: false,
    AllowUntargetedRings: false,
    RingRange: 5,
    MinRingTargets: 4,
    ApproachRange: 4,
    ...opts,
  };
  const lists = { items: [] };
  const options = {
    values,
    getValue: (k) => values[k],
    get: (k) => (k in values ? { ok: true, value: values[k] } : { ok: false }),
    getList: (k) => (lists[k] ? lists[k].map((x) => ({ ...x })) : []),
    setList: (k, v) => {
      lists[k] = v.map((x) => ({ ...x }));
      return { ok: true };
    },
  };
  const subs = new Map();
  const subscribe = (type, fn) => {
    if (!subs.has(type)) subs.set(type, new Set());
    subs.get(type).add(fn);
    return () => subs.get(type).delete(fn);
  };
  const emit = (sig) => {
    for (const fn of subs.get(sig.type) || []) fn(sig);
  };
  const logs = [];
  const creatures = new CP.CreatureProfiles({ now });
  const monsters = new MonsterList({
    entries,
    parse: fakeParse,
    evaluate: fakeEvaluate,
    truthy,
    equalsCI,
    varsFor: makeMonsterVars({ host, options, creatures, now }),
  });
  const items = new I.ItemsModel({ options, host });
  let planner = null;
  const combat = {
    get mode() {
      return host.mode;
    },
    disengage(o) {
      host.actions.push(["disengage", o]);
    },
    // INT-1's _scanTargets shape: ignore ⇒ skip; score = 100 - d + scoreBias (+ legacy _priorityTerm)
    legacyTerm: () => 0,
    _scanTargets() {
      const out = [];
      for (const [g, o] of objs) {
        if (o.dist > 40) continue;
        const v = planner.scanVerdict(g, o.dist);
        if (v && v.ignore) continue;
        out.push({ guid: g, dist: o.dist, score: 100 - o.dist + combat.legacyTerm(g) + (v?.scoreBias ?? 0) });
      }
      return out.sort((a, b) => b.score - a.score);
    },
  };
  let nav = null;
  // A fresh planner (and, like createVtLayer, a fresh ledger) per layer bind.
  const mkPlanner = () =>
    new AttackPlanner({
      host,
      options,
      monsters,
      spells: T,
      items,
      creatures,
      subscribe,
      getCombat: () => combat,
      getNav: () => nav,
      now,
      log: (m) => logs.push(m),
      ...(state !== undefined ? { state } : {}),
    });
  planner = mkPlanner();
  const w = {
    host,
    options,
    values,
    lists,
    monsters,
    items,
    creatures,
    combat,
    planner,
    emit,
    logs,
    setNav: (n) => (nav = n),
    tick() {
      host.snap = { seq: host.snap.seq + 1 };
    },
    /** A layer rebind: the old planner is disposed, a new one is built. */
    rebind() {
      planner.dispose();
      planner = mkPlanner();
      w.planner = planner;
      w.tick();
      return planner;
    },
    // one magic cycle: plan → issue (sent) → the server's verdict line
    cast(target, outcome = "landed") {
      const plan = planner.nextCast(target, { mode: 8, dist: objs.get(target).dist, now: NOW });
      if (plan && plan.spellId) {
        planner.onCastIssued(target, plan, true);
        if (outcome && (plan.kind === "debuff" || plan.kind === "dot")) {
          emit({ type: "castLine", spellName: outcome === "resisted" ? "" : T.nameOf(plan.spellId), targetName: objs.get(target).name, outcome, raw: "" });
        }
      }
      w.tick();
      return plan;
    },
  };
  return w;
}
const E = (text, cols = {}) => ({ text, ...cols });
const fams = (plans) => plans.map((p) => (p && p.family) || (p && p.done ? "done" : p && p.skip ? "skip" : null));

// ── tests ────────────────────────────────────────────────────────────────

await check("isActive: false for DEFAULT-only + legacy; true for any entry, an edited DEFAULT, WarSpellMode vtank, SwitchWandsToDebuff", () => {
  const w = makeWorld();
  assert.equal(w.planner.isActive(), false);
  w.values.WarSpellMode = "vtank";
  assert.equal(w.planner.isActive(), true);
  w.values.WarSpellMode = "legacy";
  w.values.SwitchWandsToDebuff = true;
  assert.equal(w.planner.isActive(), true);
  w.values.SwitchWandsToDebuff = false;
  w.monsters.setEntries([{ ...DEFAULT_ENTRY, I: true }]);
  assert.equal(w.monsters.isDefaultOnly(), false, "an edited DEFAULT row is not default-only");
  assert.equal(w.planner.isActive(), true);
  w.monsters.setEntries([E("Rat")]);
  assert.equal(w.planner.isActive(), true);
  w.monsters.setEntries([]);
  assert.equal(w.planner.isActive(), false);
});

await check("scanVerdict: P×1000 is lexicographic over distance and the legacy priority term; P -1 ignored; memo per seq", () => {
  const w = makeWorld({ entries: [E("Olthoi Soldier", { priority: 4 }), E("Rat", { priority: -1 })] });
  assert.deepEqual(w.planner.scanVerdict(OLTHOI, 39), { scoreBias: 4000 });
  assert.deepEqual(w.planner.scanVerdict(MOSS, 1), { scoreBias: 1000 }, "DEFAULT P 1");
  assert.deepEqual(w.planner.scanVerdict(RAT, 30), { ignore: true });
  w.combat.legacyTerm = (g) => (g === MOSS ? 490 : 0); // the director clamp max (99-1)*5
  const scan = w.combat._scanTargets();
  assert.equal(scan[0].guid, OLTHOI, "P4 at 39 m beats P1 at 1 m even with +490 legacy bias");
  assert.ok(!scan.some((s) => s.guid === RAT), "P -1 never enters the scan");
  // P 0 vs P 1 at any distance
  w.monsters.setEntries([E("Mosswart", { priority: 0 })]);
  w.tick();
  assert.deepEqual(w.planner.scanVerdict(MOSS, 1), { scoreBias: 0 });
  assert.ok(w.combat._scanTargets().findIndex((s) => s.guid === MOSS) > 0, "P0 ranks below every P1");
  // memo: same seq + rev ⇒ same object
  const a = w.planner.scanVerdict(DRUDGE, 20);
  assert.equal(w.planner.scanVerdict(DRUDGE, 20), a);
});

await check("debuff order (magic): I → V → ExVuln → Y,G,B → F → WC → FC → DC, school cap picks L7 over L8, then done", () => {
  const all = { I: true, V: true, exVuln: "Acid", G: true, B: true, Y: true, F: true, WC: true, FC: true, DC: true, A: false, damageType: "Fire" };
  const w = makeWorld({ entries: [E("Drudge Skulker", all)] });
  const plans = [];
  for (let i = 0; i < 11; i++) plans.push(w.cast(DRUDGE));
  assert.deepEqual(fams(plans), ["imperil", "vuln:fire", "vuln:acid", "yield", "gravity", "broadside", "fester", "wc", "fc", "dc", "done"]);
  assert.equal(plans[0].spellId, 2074, "skill 400 < tier8 435 ⇒ L7 Gossamer Flesh, not the known Incantation");
  assert.equal(plans[3].spellId, 2282, "Futility");
  assert.equal(plans[5].spellId, 2228, "Broadside of a Barn");
  for (const p of plans.slice(0, 10)) {
    assert.equal(p.kind, "debuff");
    assert.equal(p.untargeted, false, "debuffs are always targeted");
  }
});

await check("G/B/Y order follows the weapon: melee → G first, missile → B first", () => {
  const cols = { G: true, B: true, Y: true, A: false };
  const melee = makeWorld({ entries: [E("Drudge Skulker", cols)], wielded: [[SWORD, IT.melee, EM.melee]] });
  assert.deepEqual(fams([melee.cast(DRUDGE), melee.cast(DRUDGE), melee.cast(DRUDGE)]), ["gravity", "broadside", "yield"]);
  const bow = makeWorld({ entries: [E("Drudge Skulker", cols)], wielded: [[BOW, IT.missile, EM.missile]] });
  assert.deepEqual(fams([bow.cast(DRUDGE), bow.cast(DRUDGE), bow.cast(DRUDGE)]), ["broadside", "gravity", "yield"]);
});

await check("unknown rung ⇒ markUnavailable(family) and the next key (no stuck wand)", () => {
  const w = makeWorld({ known: knownOf("fester"), entries: [E("Drudge Skulker", { I: true, F: true, A: false })] });
  const p = w.cast(DRUDGE);
  assert.equal(p.family, "fester", "imperil skipped: no known rung");
  assert.equal(w.planner.ledger.isUnavailable("imperil"), true);
  assert.deepEqual(w.cast(DRUDGE), { done: true });
  assert.deepEqual(w.planner.scanVerdict(DRUDGE, 20), { ignore: true }, "settled: fester on, imperil unavailable");
  // learning the spell re-opens the family (book change clears the marks)
  w.host.known = knownOf("fester", "imperil");
  w.tick();
  assert.equal(w.planner.nextCast(DRUDGE, { mode: 8, now: NOW }).family, "imperil");
});

await check("ledger lines: landed/surpassing/refreshing/surpassed land, resisted does not, failed holds 30 s; per-id expiry (4543 = 60 s)", () => {
  const L = new DebuffLedger({ now, durationOf: T.durationOf, nameOf: T.nameOf });
  const line = (spell, target, outcome) => ({ type: "castLine", spellName: spell, targetName: target, outcome, raw: "" });
  L.noteIssued(DRUDGE, "Drudge Skulker", 4543, "broadside");
  assert.equal(L.isActive(DRUDGE, "broadside"), true, "pending counts as on (no double-cast)");
  assert.equal(L.onCastLine(line("Some Other Spell", "Drudge Skulker", "landed")), null, "not our spell");
  assert.equal(L.onCastLine(line("Incantation of Defenselessness Other", "Rat", "landed")), null, "not our target");
  assert.deepEqual(L.onCastLine(line("Incantation of Defenselessness Other", "drudge skulker", "landed")), { guid: DRUDGE, family: "broadside", outcome: "landed", spellId: 4543 });
  const t0 = NOW;
  NOW = t0 + 57_000;
  assert.equal(L.isActive(DRUDGE, "broadside"), true);
  NOW = t0 + 58_500;
  assert.equal(L.isActive(DRUDGE, "broadside"), false, "60 s minus the 2 s lead");
  assert.equal(L.isActive(DRUDGE, "broadside", { leadMs: 0 }), true);
  NOW = t0;
  for (const oc of ["surpassing", "refreshing", "surpassed"]) {
    L.noteIssued(SHRETH, "Blood Shreth", 2228, "broadside");
    assert.equal(L.onCastLine(line("Broadside of a Barn", "Blood Shreth", oc)).outcome, oc);
    assert.equal(L.isActive(SHRETH, "broadside"), true, oc);
    assert.ok(Math.abs(L.earliestExpiry(SHRETH) - (NOW + 240_000)) < 1, `${oc}: 240 s timer`);
  }
  L.forget(SHRETH);
  L.noteIssued(SHRETH, "Blood Shreth", 2228, "broadside");
  assert.equal(L.onCastLine(line("", "Blood Shreth", "resisted")).outcome, "resisted", "resist names no spell");
  assert.equal(L.isActive(SHRETH, "broadside"), false, "resisted ⇒ not on, recast");
  L.noteIssued(SHRETH, "Blood Shreth", 2228, "broadside");
  L.onCastLine(line("Broadside of a Barn", "Blood Shreth", "failed"));
  assert.equal(L.isActive(SHRETH, "broadside"), true, "failed (immune) ⇒ held");
  NOW += 31_000;
  assert.equal(L.isActive(SHRETH, "broadside"), false);
  // pending window
  L.noteIssued(OLTHOI, "Olthoi Soldier", 25, "imperil");
  NOW += 6_500;
  assert.equal(L.isActive(OLTHOI, "imperil"), false, "an unanswered cast stops counting after 6 s");
  // same-named monsters: the line goes to the guid we cast at
  L.noteIssued(0x80000099, "Drudge Skulker", 25, "imperil");
  L.onCastLine(line("Imperil Other I", "Drudge Skulker", "landed"));
  assert.equal(L.isActive(0x80000099, "imperil"), true);
  assert.equal(L.isActive(DRUDGE, "imperil"), false);
  // unavailable marks + prune
  L.markUnavailable("fester", NOW + 1000);
  assert.equal(L.isUnavailable("fester"), true);
  NOW += 1500;
  L.prune();
  assert.equal(L.isUnavailable("fester"), false);
  NOW += 400_000;
  L.prune();
  assert.equal(L.earliestExpiry(0x80000099), null);
  assert.deepEqual(L.snapshot().active, []);
  assert.equal(L.onCastLine(null), null);
  assert.equal(L.onCastLine({ type: "chat" }), null);
});

await check("A off ⇒ {done}, excluded while the debuffs are on, re-admitted at expiry for the recast", () => {
  const w = makeWorld({ known: knownOf("yield").filter((id) => id !== 4597), entries: [E("Drudge Skulker", { Y: true, A: false })] });
  assert.equal(w.cast(DRUDGE).spellId, 2282);
  assert.deepEqual(w.cast(DRUDGE), { done: true });
  assert.deepEqual(w.planner.scanVerdict(DRUDGE, 20), { ignore: true });
  NOW += 237_000; // Futility 240 s, lead 2 s
  w.tick();
  assert.deepEqual(w.planner.scanVerdict(DRUDGE, 20), { ignore: true });
  NOW += 1_500;
  w.tick();
  assert.deepEqual(w.planner.scanVerdict(DRUDGE, 20), { scoreBias: 1000 }, "expired ⇒ re-admitted (never latched)");
  assert.equal(w.planner.nextCast(DRUDGE, { mode: 8, now: NOW }).spellId, 2282, "recast");
  // an A-off entry with no debuff columns is never locked
  w.monsters.setEntries([E("Drudge Skulker", { A: false })]);
  w.tick();
  assert.deepEqual(w.planner.scanVerdict(DRUDGE, 20), { ignore: true });
});

await check("G:107-109: blood shreth S; range>5 Y A-off; a drudge at 20 m is Yielded then excluded, at 4 m re-admitted and attacked while Yield is on", () => {
  const w = makeWorld({ entries: [E("blood shreth", { S: true }), E("range>5", { Y: true, A: false })], opts: { WarSpellMode: "vtank" } });
  const shreth = w.cast(SHRETH);
  assert.equal(shreth.family, "streak:fire", "shreth: streaked (Auto ⇒ Fire)");
  assert.equal(shreth.spellId, 2129, "Sizzling Fury (L7)");
  assert.equal(w.cast(DRUDGE).family, "yield");
  assert.deepEqual(w.cast(DRUDGE), { done: true });
  assert.deepEqual(w.planner.scanVerdict(DRUDGE, 20), { ignore: true }, "excluded at 20 m");
  w.host.objs.get(DRUDGE).dist = 4; // it closes in
  w.tick();
  assert.deepEqual(w.planner.scanVerdict(DRUDGE, 4), { scoreBias: 1000 }, "range<=5 ⇒ DEFAULT ⇒ re-admitted");
  assert.equal(w.planner.ledger.isActive(DRUDGE, "yield"), true, "Yield still on");
  const p = w.cast(DRUDGE);
  assert.equal(p.kind, "attack");
  assert.equal(p.family, "bolt:fire");
  assert.equal(w.planner.attackAllowed(DRUDGE), true);
  w.host.objs.get(DRUDGE).dist = 20;
  w.tick();
  assert.equal(w.planner.attackAllowed(DRUDGE), false, "melee/missile gate: A off at range");
});

await check("WR: ring only with ≥ MinRingTargets in RingRange; R-only: ring while any R monster is in range, else standard war", () => {
  const w = makeWorld({ entries: [E("Drudge Skulker", { R: true, A: true })], opts: { AllowUntargetedRings: true } });
  const o = w.host.objs;
  o.get(DRUDGE).dist = 3;
  o.get(MOSS).dist = 1;
  o.get(SHRETH).dist = 4;
  assert.equal(w.cast(DRUDGE).kind, "attack", "3 in ring range < 4");
  o.get(RAT).dist = 5;
  const ring = w.cast(DRUDGE);
  assert.deepEqual(ring, { spellId: 6191, kind: "ring", untargeted: true, family: "ring:fire" }, "4 in range ⇒ Cassius' Ring of Fire II");
  // R-only
  w.monsters.setEntries([E("Drudge Skulker", { R: true, A: false }), E("Mosswart", { R: true, A: false })]);
  o.get(DRUDGE).dist = 10;
  o.get(MOSS).dist = 30;
  o.get(SHRETH).dist = 30;
  o.get(RAT).dist = 30;
  w.tick();
  assert.equal(w.cast(DRUDGE).kind, "attack", "no R monster within ring range ⇒ war on the one outside");
  o.get(MOSS).dist = 2;
  w.tick();
  assert.equal(w.cast(DRUDGE).kind, "ring", "an R monster within ring range ⇒ ring");
  o.get(MOSS).dist = 30;
  o.get(SHRETH).dist = 2; // a non-R monster in range does not count for R-only
  w.tick();
  assert.equal(w.cast(DRUDGE).kind, "attack");
});

await check("AllowUntargetedRings false (default) ⇒ the entry's bolt/streak, one warning; a refused ring parks rings 10 min", () => {
  const w = makeWorld({ entries: [E("Drudge Skulker", { R: true, A: true, S: true })] });
  for (const g of [DRUDGE, MOSS, SHRETH, RAT]) w.host.objs.get(g).dist = 2;
  const a = w.cast(DRUDGE);
  const b = w.cast(DRUDGE);
  assert.equal(a.family, "streak:fire");
  assert.equal(a.untargeted, false);
  assert.equal(b.family, "streak:fire");
  assert.equal(w.logs.filter((m) => /AllowUntargetedRings/.test(m)).length, 1, "one warning");
  w.values.AllowUntargetedRings = true;
  w.tick();
  const r = w.planner.nextCast(DRUDGE, { mode: 8, now: NOW });
  assert.equal(r.kind, "ring");
  w.planner.onCastIssued(DRUDGE, r, false); // the host's CastUntargetedSafe refused it
  w.tick();
  assert.equal(w.planner.nextCast(DRUDGE, { mode: 8, now: NOW }).family, "streak:fire", "rings parked after a refusal");
  NOW += 10 * 60_000 + 1;
  w.tick();
  assert.equal(w.planner.nextCast(DRUDGE, { mode: 8, now: NOW }).kind, "ring");
});

await check("Damage Type: Auto ⇒ Fire; Electric ⇒ Lightning; learned weakest resist among castable; explicit element; arc shape", () => {
  const w = makeWorld({ entries: [E("Drudge Skulker", { damageType: "Auto" })], opts: { WarSpellMode: "vtank" } });
  assert.equal(w.cast(DRUDGE).family, "bolt:fire", "Auto with nothing learned ⇒ Fire");
  // ACE ResistX are damage MULTIPLIERS: the highest one is the weakness.
  w.creatures.noteAppraisal(DRUDGE, 1002, "Drudge Skulker", { properties: { floats: { ResistElectric: 1.5, ResistFire: 0.6, ResistCold: 1.2 } } });
  w.tick();
  assert.equal(w.cast(DRUDGE).family, "bolt:lightning", "ResistElectric 1.5 (takes the most damage) ⇒ Lightning");
  w.host.known = knownOf("bolt:fire", "bolt:cold");
  w.tick();
  assert.equal(w.cast(DRUDGE).family, "bolt:cold", "weakest AMONG castable elements (Cold 1.2 > Fire 0.6)");
  w.monsters.setEntries([E("Drudge Skulker", { damageType: "Electric" })]);
  w.host.known = knownOf(...ALL_FAMS);
  w.tick();
  assert.equal(w.cast(DRUDGE).family, "bolt:lightning");
  assert.equal(w.monsters.entries()[1].damageType, "Lightning", "normalised at the entry");
  w.monsters.setEntries([E("Drudge Skulker", { damageType: "Cold", arc: true })]);
  w.tick();
  assert.equal(w.cast(DRUDGE).family, "arc:cold");
  w.monsters.setEntries([E("Drudge Skulker", { damageType: "Nether", S: true })]);
  w.tick();
  const n = w.cast(DRUDGE);
  assert.equal(n.family, "streak:nether");
  assert.equal(T.rungOf(n.spellId).school, 5, "void");
});

await check("Ex. Vuln: added after the element vuln; deduped when it equals the element", () => {
  const w = makeWorld({ entries: [E("Drudge Skulker", { V: true, exVuln: "Fire", damageType: "Fire", A: false })] });
  assert.deepEqual(fams([w.cast(DRUDGE), w.cast(DRUDGE)]), ["vuln:fire", "done"]);
  const w2 = makeWorld({ entries: [E("Drudge Skulker", { exVuln: "Cold", A: false })] });
  assert.deepEqual(fams([w2.cast(DRUDGE), w2.cast(DRUDGE)]), ["vuln:cold", "done"], "Ex. Vuln without V");
});

await check("Cp/Cs are DoT attacks once per window; the A-off entry is done after them", () => {
  const w = makeWorld({ entries: [E("Drudge Skulker", { I: true, Cp: true, Cs: true, A: false })] });
  const ps = [w.cast(DRUDGE), w.cast(DRUDGE), w.cast(DRUDGE), w.cast(DRUDGE)];
  assert.deepEqual(fams(ps), ["imperil", "cp", "cs", "done"]);
  assert.equal(ps[1].kind, "dot");
  assert.equal(ps[1].untargeted, false);
  NOW += 14_000; // Corrosion window 15 s - lead 2 s
  w.tick();
  assert.equal(w.cast(DRUDGE).family, "cs", "Corrosion recast after its 15 s window");
});

await check("WarSpellMode legacy + DEFAULT ⇒ null (legacy _pickWarSpell); DEFAULT debuffs still come first; vtank ⇒ ladder", () => {
  const w = makeWorld();
  assert.equal(w.planner.nextCast(DRUDGE, { mode: 8, now: NOW }), null);
  w.monsters.setEntries([{ ...DEFAULT_ENTRY, I: true }]);
  w.tick();
  assert.equal(w.cast(DRUDGE).family, "imperil");
  assert.equal(w.cast(DRUDGE), null, "then the legacy war pick");
  w.values.WarSpellMode = "vtank";
  w.tick();
  assert.deepEqual(w.cast(DRUDGE), { spellId: 2128, kind: "attack", untargeted: false, family: "bolt:fire" });
  assert.equal(w.planner.nextCast(DRUDGE, { mode: 2, now: NOW }), null, "only magic mode plans");
  // no castable rung at all ⇒ null (the legacy pick decides / stands down)
  w.host.known = [];
  w.tick();
  assert.equal(w.planner.nextCast(DRUDGE, { mode: 8, now: NOW }), null);
});

await check("Auto Damage Type on an LSD Ice Golem with Cold and Fire castable ⇒ Fire, not the immune Cold (review guide-5)", () => {
  const w = makeWorld({ entries: [E("Drudge Skulker", { damageType: "Auto" })], opts: { WarSpellMode: "vtank" } });
  w.host.known = knownOf("bolt:fire", "bolt:cold");
  w.creatures.noteAppraisal(DRUDGE, 1002, "Ice Golem", { properties: { floats: { 64: 0.83, 65: 0.83, 66: 0.8, 67: 1.0, 68: 0.0, 69: 0.83, 70: 0.8 } } });
  w.tick();
  assert.equal(w.cast(DRUDGE).family, "bolt:fire");
});

await check("WarSpellMode legacy: an edited S / arc / Damage Type on the DEFAULT row is honoured; a debuff-only edit still leaves the war pick to legacy (G:84/G:93, review guide-4)", () => {
  const w = makeWorld();
  w.monsters.setEntries([{ ...DEFAULT_ENTRY, S: true, damageType: "Cold" }]);
  w.tick();
  const p = w.cast(DRUDGE);
  assert.equal(p && p.kind, "attack", "DEFAULT S + Cold under legacy plans the attack");
  assert.equal(p.family, "streak:cold");
  w.monsters.setEntries([{ ...DEFAULT_ENTRY, damageType: "Cold" }]);
  w.tick();
  assert.equal(w.cast(DRUDGE).family, "bolt:cold", "an explicit Damage Type alone");
  w.monsters.setEntries([{ ...DEFAULT_ENTRY, S: true }]);
  w.tick();
  assert.equal(w.cast(DRUDGE).family.split(":")[0], "streak", "an explicit S alone");
  w.monsters.setEntries([{ ...DEFAULT_ENTRY, I: true }]);
  w.tick();
  assert.equal(w.cast(DRUDGE).family, "imperil");
  assert.equal(w.cast(DRUDGE), null, "debuff-only edit: then the legacy war pick");
  w.monsters.setEntries([{ ...DEFAULT_ENTRY, damageType: "auto" }]);
  w.tick();
  assert.equal(w.cast(DRUDGE), null, "Auto in any case is the default");
});

await check("three fizzles of one id ⇒ excluded 10 min; another module's refusal is not counted", () => {
  const w = makeWorld({ opts: { WarSpellMode: "vtank" } });
  const fizzle = () => w.emit({ type: "useFailed", code: 0x0402, text: "Your spell fizzled." });
  for (let i = 0; i < 2; i++) {
    const p = w.cast(DRUDGE);
    assert.equal(p.spellId, 2128);
    fizzle();
  }
  const p3 = w.cast(DRUDGE);
  w.host.castToken = { owner: "buff" };
  fizzle(); // the buff loop's cast: not ours
  w.host.castToken = null;
  assert.equal(w.planner.nextCast(DRUDGE, { mode: 8, now: NOW }).spellId, 2128, "still allowed after 2 of ours");
  fizzle();
  assert.equal(p3.spellId, 2128);
  w.tick();
  assert.equal(w.planner.nextCast(DRUDGE, { mode: 8, now: NOW }).spellId, 85, "Ilservian's Flame excluded ⇒ Flame Bolt VI");
  assert.ok(w.logs.some((m) => /fizzled 3x/.test(m)));
  NOW += 10 * 60_000 + 1;
  w.tick();
  assert.equal(w.planner.nextCast(DRUDGE, { mode: 8, now: NOW }).spellId, 2128, "back after 10 min");
  // a debuff fizzle clears its pending so it is recast
  const d = makeWorld({ entries: [E("Drudge Skulker", { I: true, A: false })] });
  const p = d.planner.nextCast(DRUDGE, { mode: 8, now: NOW });
  d.planner.onCastIssued(DRUDGE, p, true);
  assert.equal(d.planner.ledger.isActive(DRUDGE, "imperil"), true, "pending");
  d.emit({ type: "useFailed", code: 0x0402, text: "" });
  assert.equal(d.planner.ledger.isActive(DRUDGE, "imperil"), false);
  assert.equal(d.planner.nextCast(DRUDGE, { mode: 8, now: NOW }).family, "imperil");
});

await check("ensureLoadout: claim → disengage → wield (in that order), busy until the equip event, 3 s gate between swaps", () => {
  const w = makeWorld({ entries: [E("Drudge Skulker", { weapon: SWORD }), E("Blood Shreth", { weapon: AXE })] });
  w.items.add({ guid: SWORD });
  w.items.add({ guid: AXE });
  assert.equal(w.planner.ensureLoadout(DRUDGE, NOW), "busy");
  assert.deepEqual(w.host.actions, [["claim", "vtloadout"], ["disengage", { cancelAttack: true }], ["wield", SWORD, 0]]);
  NOW += 500;
  assert.equal(w.planner.ensureLoadout(DRUDGE, NOW), "busy", "waiting for kind 47/49");
  assert.equal(w.host.actions.length, 3);
  w.host.wielded = [{ guid: SWORD, itemType: IT.melee, equipMask: EM.melee }];
  w.emit({ type: "equip", item: SWORD, wielder: SELF, failed: false });
  w.tick();
  assert.equal(w.planner.ensureLoadout(DRUDGE, NOW), "ok", "sword wielded");
  assert.equal(w.host._itemToken, null, "token released");
  // a different entry wants the axe right away: the 3 s swap gate holds it
  NOW += 1000;
  w.tick();
  assert.equal(w.planner.ensureLoadout(SHRETH, NOW), "busy");
  assert.ok(!w.host.actions.some((a) => a[0] === "wield" && a[1] === AXE), "no swap inside 3 s");
  NOW += 2100;
  w.tick();
  assert.equal(w.planner.ensureLoadout(SHRETH, NOW), "busy");
  assert.deepEqual(w.host.actions.slice(-2), [["disengage", { cancelAttack: true }], ["wield", AXE, 0]]);
  // timeout without an event ⇒ re-read and continue after 3 s
  NOW += 3100;
  w.host.wielded = [{ guid: AXE, itemType: IT.melee, equipMask: EM.melee }];
  w.tick();
  assert.equal(w.planner.ensureLoadout(SHRETH, NOW), "ok");
  // AUTO (weapon 0) never swaps
  assert.equal(w.planner.ensureLoadout(MOSS, NOW), "ok");
});

await check("ensureLoadout: offhand wielded alongside a melee weapon (shield mask); a failed wield is parked 30 s", () => {
  const w = makeWorld({ entries: [E("Drudge Skulker", { weapon: SWORD, offhand: SHIELD })], wielded: [[SWORD, IT.melee, EM.melee]], mode: 2 });
  w.items.add({ guid: SWORD });
  w.items.add({ guid: SHIELD });
  assert.equal(w.planner.ensureLoadout(DRUDGE, NOW), "busy");
  assert.deepEqual(w.host.actions.at(-1), ["wield", SHIELD, EM.shield]);
  w.emit({ type: "equip", item: SHIELD, wielder: 0, failed: true, code: 0x1c });
  NOW += 3100;
  w.tick();
  assert.equal(w.planner.ensureLoadout(DRUDGE, NOW), "ok", "failed shield parked");
  assert.equal(w.host.actions.filter((a) => a[1] === SHIELD).length, 1);
});

await check("SwitchWandsToDebuff: stow the bow, wield the wand, enter Magic, debuff, then put the bow back", () => {
  const w = makeWorld({
    entries: [E("Drudge Skulker", { Y: true, A: true })],
    wielded: [[BOW, IT.missile, EM.missile]],
    mode: 4,
    opts: { SwitchWandsToDebuff: true },
  });
  w.items.add({ guid: WAND });
  assert.equal(w.planner.isActive(), true);
  assert.equal(w.planner.ensureLoadout(DRUDGE, NOW), "busy");
  assert.deepEqual(w.host.actions.at(-1), ["unwield", BOW], "ACE will not dequip a bow for a Held wand: stow first");
  w.host.wielded = [];
  w.emit({ type: "equip", item: BOW, wielder: SELF, failed: false });
  NOW += 3000;
  w.tick();
  assert.equal(w.planner.ensureLoadout(DRUDGE, NOW), "busy");
  assert.deepEqual(w.host.actions.at(-1), ["wield", WAND, 0]);
  w.host.wielded = [{ guid: WAND, itemType: IT.caster, equipMask: EM.held }];
  w.host.mode = 1;
  w.emit({ type: "equip", item: WAND, wielder: SELF, failed: false });
  w.tick();
  assert.equal(w.planner.ensureLoadout(DRUDGE, NOW), "busy", "waiting for Magic stance");
  assert.deepEqual(w.host.actions.at(-1), ["mode", 8]);
  w.host.mode = 8;
  w.tick();
  assert.equal(w.planner.ensureLoadout(DRUDGE, NOW), "ok");
  const p = w.cast(DRUDGE);
  assert.equal(p.family, "yield");
  assert.equal(p.spellId, 2282, "Futility (the bow user's order puts B first, but only Y is selected)");
  NOW += 3100;
  w.tick();
  assert.equal(w.planner.ensureLoadout(DRUDGE, NOW), "busy", "debuffs on ⇒ restore");
  assert.deepEqual(w.host.actions.at(-1), ["wield", BOW, 0]);
  w.host.wielded = [{ guid: BOW, itemType: IT.missile, equipMask: EM.missile }];
  w.emit({ type: "equip", item: BOW, wielder: SELF, failed: false });
  w.tick();
  assert.equal(w.planner.ensureLoadout(DRUDGE, NOW), "busy", "leaving Magic");
  assert.deepEqual(w.host.actions.at(-1), ["mode", 1]);
  w.host.mode = 4;
  w.tick();
  assert.equal(w.planner.ensureLoadout(DRUDGE, NOW), "ok");
  assert.equal(w.planner.status().saved, null);
});

await check("non-attacking entry on a character that cannot debuff (no caster, no wand swap) is ignored, not lock-thrashed", () => {
  const w = makeWorld({ entries: [E("Drudge Skulker", { Y: true, A: false })], wielded: [[SWORD, IT.melee, EM.melee]], mode: 2 });
  assert.deepEqual(w.planner.scanVerdict(DRUDGE, 20), { ignore: true });
  w.values.SwitchWandsToDebuff = true;
  w.tick();
  assert.deepEqual(w.planner.scanVerdict(DRUDGE, 20), { scoreBias: 1000 }, "a wand swap makes it debuffable");
});

await check("R-only (A off) entry: admitted while the character can cast; excluded on a melee/missile character that cannot (no lock thrash)", () => {
  const melee = makeWorld({ entries: [E("Drudge Skulker", { R: true, A: false })], wielded: [[SWORD, IT.melee, EM.melee]], mode: 2 });
  assert.equal(melee.planner.attackAllowed(DRUDGE), false, "the melee gate would drop it");
  assert.deepEqual(melee.planner.scanVerdict(DRUDGE, 3), { ignore: true }, "nothing it can do: never locked");
  melee.values.SwitchWandsToDebuff = true;
  melee.items.add({ guid: WAND });
  melee.tick();
  assert.deepEqual(melee.planner.scanVerdict(DRUDGE, 3), { ignore: true }, "a wand swap is for debuffs only: still excluded without debuff columns");
  melee.monsters.setEntries([E("Drudge Skulker", { R: true, A: false, Y: true })]);
  melee.tick();
  assert.deepEqual(melee.planner.scanVerdict(DRUDGE, 3), { scoreBias: 1000 }, "pending debuff + wand swap ⇒ admitted");
  const mage = makeWorld({ entries: [E("Drudge Skulker", { R: true, A: false })] });
  assert.deepEqual(mage.planner.scanVerdict(DRUDGE, 3), { scoreBias: 1000 }, "a caster rings / wars (G:83)");
  assert.equal(mage.cast(DRUDGE).kind, "attack", "R-only with no R monster in ring range ⇒ standard war");
});

await check("SwitchWandsToDebuff: the wand stays while our debuff is still in flight (no swap back mid-cast)", () => {
  const w = makeWorld({ entries: [E("Drudge Skulker", { Y: true, A: true })], wielded: [[BOW, IT.missile, EM.missile]], mode: 4, opts: { SwitchWandsToDebuff: true } });
  w.items.add({ guid: WAND });
  assert.equal(w.planner.ensureLoadout(DRUDGE, NOW), "busy");
  w.host.wielded = [];
  w.emit({ type: "equip", item: BOW, wielder: SELF, failed: false });
  NOW += 3000;
  w.tick();
  assert.equal(w.planner.ensureLoadout(DRUDGE, NOW), "busy");
  w.host.wielded = [{ guid: WAND, itemType: IT.caster, equipMask: EM.held }];
  w.host.mode = 8;
  w.emit({ type: "equip", item: WAND, wielder: SELF, failed: false });
  w.tick();
  assert.equal(w.planner.ensureLoadout(DRUDGE, NOW), "ok");
  const p = w.planner.nextCast(DRUDGE, { mode: 8, now: NOW });
  assert.equal(p.family, "yield");
  w.planner.onCastIssued(DRUDGE, p, true); // sent; the result line has not arrived yet
  NOW += 3100;
  w.tick();
  const n = w.host.actions.length;
  assert.equal(w.planner.ensureLoadout(DRUDGE, NOW), "ok", "in flight ⇒ keep the wand");
  assert.equal(w.host.actions.length, n, "no unwield/wield while our cast is out");
  w.emit({ type: "castLine", spellName: T.nameOf(p.spellId), targetName: "Drudge Skulker", outcome: "landed", raw: "" });
  w.tick();
  assert.equal(w.planner.ensureLoadout(DRUDGE, NOW), "busy", "landed ⇒ the bow goes back");
  assert.deepEqual(w.host.actions.at(-1), ["wield", BOW, 0]);
});

await check("SwitchWandsToDebuff: the pre-swap loadout lives in the injected page-session state, so a layer rebind mid-debuff still puts the bow back (review runtime-3)", () => {
  const session = {}; // session.ext.plannerState
  const w = makeWorld({ entries: [E("Drudge Skulker", { Y: true, A: true })], wielded: [[BOW, IT.missile, EM.missile]], mode: 4, opts: { SwitchWandsToDebuff: true }, state: session });
  w.items.add({ guid: WAND });
  assert.equal(w.planner.ensureLoadout(DRUDGE, NOW), "busy");
  assert.deepEqual(w.host.actions.at(-1), ["unwield", BOW]);
  w.host.wielded = [];
  w.emit({ type: "equip", item: BOW, wielder: SELF, failed: false });
  NOW += 3000;
  w.tick();
  assert.equal(w.planner.ensureLoadout(DRUDGE, NOW), "busy");
  assert.deepEqual(w.host.actions.at(-1), ["wield", WAND, 0]);
  w.host.wielded = [{ guid: WAND, itemType: IT.caster, equipMask: EM.held }];
  w.host.mode = 8;
  w.emit({ type: "equip", item: WAND, wielder: SELF, failed: false });
  w.tick();
  assert.equal(w.planner.ensureLoadout(DRUDGE, NOW), "ok");
  assert.equal(session.saved && session.saved.main, BOW, "the saved loadout is in the session state");
  // HUD Restart / reconnect takeover: a new planner (and a new, empty ledger).
  const p2 = w.rebind();
  assert.deepEqual(p2.status().saved, { main: BOW, offhand: 0, kind: "missile" }, "the new planner sees it");
  // The debuffs land (the new ledger learns them from the cast lines).
  const plan = w.cast(DRUDGE);
  assert.equal(plan.family, "yield");
  NOW += 3100;
  w.tick();
  assert.equal(p2.ensureLoadout(DRUDGE, NOW), "busy", "debuffs on ⇒ restore");
  assert.deepEqual(w.host.actions.at(-1), ["wield", BOW, 0], "the bow goes back after the rebind");
  // Without an injected state the memory is per planner (the old behaviour).
  const solo = makeWorld({ wielded: [[BOW, IT.missile, EM.missile]], mode: 4 });
  assert.equal(solo.planner.status().saved, null);
});

await check("attackAllowed: the A column (DEFAULT true); never throws", () => {
  const w = makeWorld({ entries: [E("Drudge Skulker", { A: false, Y: true })] });
  assert.equal(w.planner.attackAllowed(DRUDGE), false);
  assert.equal(w.planner.attackAllowed(MOSS), true);
  const badLogs = [];
  const bad = new AttackPlanner({ monsters: { resolve: () => { throw new Error("x"); }, rev: 0 }, now, log: (m) => badLogs.push(m) });
  assert.equal(bad.attackAllowed(DRUDGE), true);
  assert.equal(bad.scanVerdict(DRUDGE, 3), null);
  assert.equal(bad.nextCast(DRUDGE, { mode: 8 }), null);
  assert.equal(bad.ensureLoadout(DRUDGE, NOW), "ok");
  assert.ok(badLogs.some((m) => /nextCast failed/.test(m)), "failures are logged once, never thrown");
});

await check("acquireRangeM: max(m, ApproachRange) only with nav enabled + a route; works while the planner is INACTIVE", () => {
  const w = makeWorld();
  assert.equal(w.planner.isActive(), false);
  assert.equal(w.planner.acquireRangeM(40), 40, "no nav");
  w.values.ApproachRange = 60;
  w.setNav({ enabled: false, hasRoute: () => true });
  assert.equal(w.planner.acquireRangeM(40), 40, "nav disabled");
  w.setNav({ enabled: true, hasRoute: () => false });
  assert.equal(w.planner.acquireRangeM(40), 40, "no route");
  w.setNav({ enabled: true, hasRoute: () => true });
  assert.equal(w.planner.acquireRangeM(40), 60, "nav + route ⇒ approach range");
  w.values.ApproachRange = 4;
  assert.equal(w.planner.acquireRangeM(40), 40, "default 4 < 40: no effect");
  w.setNav({
    get enabled() {
      throw new Error("x");
    },
  });
  assert.equal(w.planner.acquireRangeM(25), 25, "never throws");
});

await check("spell table not loaded yet: attacking entry ⇒ null (legacy path), debuff-only ⇒ {skip}; the load is kicked", () => {
  let kicks = 0;
  const fakeSpells = { ...T, isLoaded: () => false, loadCombatSpells: () => (kicks++, Promise.resolve()) };
  const w = makeWorld({ entries: [E("Drudge Skulker", { Y: true, A: false })] });
  const p = new AttackPlanner({ host: w.host, options: w.options, monsters: w.monsters, spells: fakeSpells, now, log: () => {} });
  assert.ok(kicks >= 1);
  assert.deepEqual(p.nextCast(DRUDGE, { mode: 8, now: NOW }), { skip: true });
  assert.equal(p.nextCast(MOSS, { mode: 8, now: NOW }), null);
  assert.deepEqual(p.scanVerdict(DRUDGE, 20), { scoreBias: 1000 }, "not settled while the table loads");
});

await check("itemBuffFamilies (D38): noBuffs ⇒ []; per-item override; shield default ⇒ impen + 7 banes; others none", () => {
  const shield = { guid: SHIELD, name: "Kite Shield", wcid: 2004, kind: "shield", element: null, noBuffs: false };
  assert.deepEqual(I.itemBuffFamilies(shield, null), ["impen", "bane:slash", "bane:pierce", "bane:bludgeon", "bane:fire", "bane:cold", "bane:lightning", "bane:acid"]);
  assert.deepEqual(I.itemBuffFamilies({ ...shield, noBuffs: true }, null), []);
  assert.deepEqual(I.itemBuffFamilies(shield, { spec: "auto", disabled: [], itemSpells: { [String(SHIELD)]: ["impen", "bogus"] } }), ["impen"]);
  assert.deepEqual(I.itemBuffFamilies(shield, { itemSpells: { [String(SHIELD)]: [] } }), [], "explicit empty override");
  for (const k of ["melee", "missile", "caster", "pet"]) assert.deepEqual(I.itemBuffFamilies({ ...shield, kind: k }, null), [], k);
  assert.ok(Object.isFrozen(I.ITEM_BUFF_DEFAULTS) && Object.isFrozen(I.ITEM_BUFF_DEFAULTS.shield));
  for (const f of I.ITEM_BUFF_DEFAULTS.shield) assert.ok(T.familyLadder(f).length === 8, `${f} has a ladder`);
  const best = I.itemBuffFamilies(shield, null).map((f) => T.bestCastable(f, { known: new Set(knownOf("impen")) })).filter(Boolean);
  assert.deepEqual(best.map((b) => b.id), [4407], "projection helper: only known families resolve");
});

await check("ItemsModel: classify, add from inventory (kind/element), Add (No Buffs), refusals, update/remove, resolveGuid", () => {
  const w = makeWorld();
  const it = w.items;
  assert.deepEqual(I.ITEM_KINDS, ["caster", "melee", "missile", "shield", "pet"]);
  assert.equal(it.classify(w.host.inventory[0]), "caster");
  assert.equal(it.classify(w.host.inventory[1]), "melee");
  assert.equal(it.classify(w.host.inventory[2]), "missile");
  assert.equal(it.classify(w.host.inventory[3]), "shield");
  assert.equal(it.classify({ name: "Lesser Fire Essence", itemType: 0x80 }), "pet");
  assert.equal(it.classify({ name: "Leather Boots", itemType: IT.armor, validLocations: 0x100 }), null);
  assert.equal(it.classify({ name: "Arrow", itemType: IT.missile, validLocations: 0x00800000 }), null, "ammunition is not a missile weapon");
  assert.equal(it.classify({ name: "Throwing Dart", itemType: IT.missile, validLocations: 0x00c00000 }), "missile", "thrown weapon (weapon + ammo slots)");
  const a = it.add({ guid: WAND });
  assert.equal(a.ok, true);
  assert.deepEqual(a.entry, { guid: WAND, name: "Fire Baton", wcid: 2001, kind: "caster", element: "Fire", noBuffs: false });
  assert.equal(it.add({ guid: SHIELD, noBuffs: true }).entry.noBuffs, true, "Add (No Buffs)");
  assert.equal(it.add({ name: "iron sword" }).entry.element, "Slash", "add by name; DamageType 0x1");
  assert.match(it.add({ guid: WAND }).error, /already/);
  w.host.inventory.push({ guid: 0x60000099, name: "Leather Boots", wcid: 9, itemType: IT.armor, validLocations: 0x100 });
  assert.match(it.add({ guid: 0x60000099 }).error, /not a wand\/staff\/orb, melee weapon, missile weapon, shield or pet/);
  assert.match(it.add({}).error, /no item selected/);
  assert.match(it.add({ name: "nothing" }).error, /no item named/);
  assert.equal(w.lists.items.length, 3, "stored through options.setList('items')");
  assert.deepEqual(it.ofKind("shield").map((e) => e.guid), [SHIELD]);
  assert.equal(it.update(SHIELD, { noBuffs: false }).ok, true);
  assert.equal(it.find(SHIELD).noBuffs, false);
  assert.equal(it.update(SHIELD, { kind: "bogus" }).ok, false);
  assert.equal(it.update(0x1234, { noBuffs: true }).ok, false);
  assert.equal(it.resolveGuid(it.find(WAND)), WAND, "owned guid");
  assert.equal(it.resolveGuid({ guid: 0x7777, name: "Fire Baton", wcid: 2001 }), WAND, "another character's entry ⇒ (name, wcid)");
  assert.equal(it.resolveGuid({ guid: 0x7777, name: "Fire Baton", wcid: 999 }), 0, "wcid mismatch");
  assert.equal(it.resolveGuid(null), 0);
  assert.equal(it.remove(SHIELD).ok, true);
  assert.equal(it.remove(SHIELD).ok, false);
  assert.equal(I.elementFromDamageType(0x400 | 0x10), "Nether", "Nether outranks Fire");
  assert.equal(I.elementFromDamageType(0), null);
  // without options: in-memory list
  const mem = new I.ItemsModel({ host: w.host });
  assert.equal(mem.add({ guid: BOW }).ok, true);
  assert.equal(mem.list().length, 1);
});

await check("CreatureProfiles: appraisal → maxHp/resists/weakest; species; LRU persistence in rynth.vt.v1.creatures", () => {
  const m = new Map();
  const storage = { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
  const p = new CP.CreatureProfiles({ storage, now });
  p.noteAppraisal(DRUDGE, 1002, "Drudge Skulker", {
    creatureProfile: { health_max: 140 },
    properties: { ints: { CreatureType: 3 }, floats: { ResistSlash: 0.7, ResistElectric: 1.4, 67: 1.1 } },
  });
  assert.equal(p.maxHp(1002), 140);
  assert.deepEqual(p.resists(1002), { Slash: 0.7, Lightning: 1.4, Fire: 1.1 });
  assert.equal(p.weakest(1002), "Lightning", "the highest damage multiplier");
  assert.equal(p.weakest(1002, ["Fire", "Slash"]), "Fire");
  assert.equal(p.weakest(1002, ["Slash"]), null, "one element: no comparison, no information");
  assert.equal(p.weakest(1002, ["Cold", "Acid"]), null, "both unset (1.0 each): no information");
  // Real LSD floatStats (ACE PropertyFloat 64-70): Ice Golem wcid 196, Fire Wisp wcid 5748.
  p.noteAppraisal(1, 196, "Ice Golem", { properties: { floats: { 64: 0.83, 65: 0.83, 66: 0.8, 67: 1.0, 68: 0.0, 69: 0.83, 70: 0.8 } } });
  assert.equal(p.weakest(196, ["Cold", "Fire"]), "Fire", "Ice Golem: Fire, never the immune Cold");
  assert.equal(p.weakest(196), "Fire", "a learned 1.0 beats an unset (Nether) 1.0");
  p.noteAppraisal(2, 5748, "Fire Wisp", { properties: { floats: { 64: 1.0, 65: 1.0, 66: 0.18, 67: 0.0, 68: 0.18, 69: 0.75, 70: 0.18 } } });
  assert.equal(p.weakest(5748, ["Fire", "Cold", "Acid", "Lightning"]), "Acid", "Fire Wisp among the war elements");
  assert.notEqual(p.weakest(5748), "Fire", "never the element it is immune to");
  p.noteAppraisal(3, 7777, "Drudge", { properties: { floats: {} }, creatureProfile: { health_max: 50 } });
  assert.equal(p.weakest(7777), null, "a vanilla-ACE appraisal carries no resist floats");
  assert.equal(p.species(1002), "Drudge", "learned type");
  assert.equal(p.species(11039), "Olthoi", "offline table (LSD Olthoi Noble)");
  assert.equal(p.species(4_000_000), null);
  assert.ok(m.has(CP.CREATURES_STORAGE_KEY), "first note written immediately");
  p.noteAppraisal(SHRETH, 1001, "Blood Shreth", { failedCreatureProfile: { health_max: 77 } });
  assert.equal(p.maxHp(1001), 77, "failed assess still teaches max health");
  const again = new CP.CreatureProfiles({ storage, now });
  assert.equal(again.maxHp(1001), null, "second note throttled (10 s) until flush");
  p.flush();
  const again2 = new CP.CreatureProfiles({ storage, now });
  assert.equal(again2.maxHp(1001), 77);
  assert.equal(again2.maxHp(1002), 140);
  for (let i = 0; i < 2005; i++) again2.noteAppraisal(1, 50_000 + i, "x", { creatureProfile: { health_max: 10 } });
  assert.equal(again2.size, 2000, "LRU 2000");
  assert.equal(again2.maxHp(1001), null, "oldest evicted");
  again2.noteAppraisal(1, 0, "x", { creatureProfile: { health_max: 10 } });
  again2.noteAppraisal(1, 7, "x", null);
  assert.equal(again2.maxHp(7), null, "nothing learned from an empty appraisal");
  const broken = { getItem: () => "{oops", setItem: () => { throw new Error("quota"); }, removeItem: () => {} };
  const b = new CP.CreatureProfiles({ storage: broken, now });
  b.noteAppraisal(1, 9, "x", { creatureProfile: { health_max: 5 } });
  assert.equal(b.maxHp(9), 5, "quota keeps the in-memory copy");
});

await check("priorityOf works while inactive (DEFAULT P); status() shape; dispose detaches the signal handlers", () => {
  const w = makeWorld();
  assert.equal(w.planner.priorityOf(DRUDGE), 1);
  w.monsters.setEntries([E("Drudge Skulker", { priority: 3 })]);
  assert.equal(w.planner.priorityOf(DRUDGE), 3);
  const st = w.planner.status();
  for (const k of ["active", "loaded", "entries", "defaultOnly", "warSpellMode", "lastPlan", "swap", "saved", "excluded", "ledger"]) assert.ok(k in st, k);
  assert.equal(st.entries, 2);
  w.monsters.setEntries([E("Drudge Skulker", { I: true, A: false })]);
  const p = w.planner.nextCast(DRUDGE, { mode: 8, now: NOW });
  w.planner.onCastIssued(DRUDGE, p, true);
  w.planner.dispose();
  w.emit({ type: "castLine", spellName: T.nameOf(p.spellId), targetName: "Drudge Skulker", outcome: "landed", raw: "" });
  NOW += 7000;
  assert.equal(w.planner.ledger.isActive(DRUDGE, "imperil"), false, "line not seen after dispose");
});

console.log(fail === 0 ? `rynth_vt_planner: all ${pass} checks passed` : `rynth_vt_planner: ${fail} FAILED (${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);
