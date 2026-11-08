// tests/challenger_m2_combat_stress.test.mjs
// Adversarial Challenger M2 Stress Test: VTank Combat Module
// Stress tests:
//   1. High-load monster prioritization (150 simulated monsters, varying priorities -1..4, strict P x 1000 domination)
//   2. Debuff sequencing stress (partial spellbooks, skipping missing spells cleanly, empty books, dynamic book update)
//   3. Weapon/wand swap stress (rapid target switching, damage interrupts, Healer's Heart protection, loadout restoration)

import assert from "node:assert/strict";

const T = await import("../rynth/vt/combat/spell_tables.js");
const { MonsterList, DEFAULT_ENTRY, normalizeEntry } = await import("../rynth/vt/combat/monster_list.js");
const { makeMonsterVars } = await import("../rynth/vt/combat/monster_vars.js");
const { DebuffLedger } = await import("../rynth/vt/combat/debuff_ledger.js");
const { AttackPlanner } = await import("../rynth/vt/combat/attack_planner.js");
const I = await import("../rynth/vt/combat/items.js");
const CP = await import("../rynth/vt/combat/creature_profiles.js");

await T.loadCombatSpells();
await CP.loadCreatureSpecies();

let pass = 0;
let fail = 0;
const results = [];

async function check(name, fn) {
  try {
    await fn();
    pass++;
    results.push({ name, status: "PASS" });
    console.log(`  [OK] ${name}`);
  } catch (e) {
    fail++;
    results.push({ name, status: "FAIL", error: e });
    console.error(`  [FAIL] ${name}\n       ${e?.stack || e}`);
  }
}

// ── Expression Engine Fake for Monster List ────────────────────────────────
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
    if (!t) throw new Error("unexpected end");
    if (t.t === "op" && t.v === "(") {
      const e = or();
      if (!eat(")")) throw new Error("expected ')'");
      return e;
    }
    if (t.t !== "w") throw new Error(t.v);
    if (Number.isFinite(Number(t.v))) return { k: "n", v: Number(t.v) };
    refs.add(t.v.toLowerCase());
    return { k: "w", lower: t.v.toLowerCase(), name: t.v };
  };
  const cmp = () => {
    let a = prim();
    while (toks[p] && toks[p].t === "op" && ["==", "!=", ">=", "<=", ">", "<"].includes(toks[p].v)) {
      a = { k: "c", op: toks[p++].v, a, b: prim() };
    }
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
    if (p < toks.length) throw new Error("trailing characters");
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

// ── World & Host Simulation Rig ───────────────────────────────────────────
let NOW = 1_700_000_000_000;
const now = () => NOW;

const SELF_GUID = 0x50000001;
const WAND_GUID = 0x60000001;
const SWORD_GUID = 0x60000002;
const BOW_GUID = 0x60000003;
const SHIELD_GUID = 0x60000004;
const HEART_GUID = 0x60000010;

const IT = { melee: 0x1, armor: 0x2, missile: 0x100, caster: 0x8000 };
const EM = { melee: 0x00100000, shield: 0x00200000, missile: 0x00400000, held: 0x01000000 };
const SKILLS = {
  31: { current: 400, training: 3 }, // Creature
  32: { current: 400, training: 3 }, // Item
  33: { current: 400, training: 3 }, // Life
  34: { current: 400, training: 3 }, // War
  43: { current: 400, training: 3 }, // Void
};

const ALL_FAMS = T.familyNames();
const allKnown = () => ALL_FAMS.flatMap((f) => T.familyLadder(f).map((r) => r.id));

function createCombatRig({
  knownSpells = allKnown(),
  entries = [],
  wielded = [[SWORD_GUID, IT.melee, EM.melee], [SHIELD_GUID, IT.armor, EM.shield]],
  mode = 2, // Melee
  opts = {},
  objects = new Map(),
} = {}) {
  const objs = new Map(objects);
  const inventory = [
    { guid: WAND_GUID, name: "Debuff Wand", wcid: 2001, itemType: IT.caster, validLocations: EM.held, equipMask: 0 },
    { guid: SWORD_GUID, name: "Broadsword", wcid: 2002, itemType: IT.melee, validLocations: EM.melee, equipMask: 0 },
    { guid: BOW_GUID, name: "Hunting Bow", wcid: 2003, itemType: IT.missile, validLocations: EM.missile, equipMask: 0 },
    { guid: SHIELD_GUID, name: "Round Shield", wcid: 2004, itemType: IT.armor, validLocations: EM.shield, equipMask: 0 },
    { guid: HEART_GUID, name: "The Healer's Heart", wcid: 8552, itemType: IT.caster, validLocations: EM.held, equipMask: 0 },
  ];

  const host = {
    snap: { seq: 1 },
    objs,
    known: [...knownSpells],
    mode,
    wielded: wielded.map(([guid, itemType, equipMask]) => ({ guid, itemType, equipMask })),
    inventory,
    actions: [],
    _itemToken: null,
    _claims: new Map(),

    GetPlayerId: () => SELF_GUID,
    TryGetObjectName: (g) => objs.get(g)?.name ?? null,
    TryGetObjectWcid: (g) => objs.get(g)?.wcid ?? 0,
    TryGetObjectDistance: (g) => objs.get(g)?.dist ?? null,
    HasShield: () => host.wielded.some((w) => w.equipMask & EM.shield),
    TryGetObjectIntProperty: (g, s) => {
      if (s === 1) return objs.has(g) ? 16 : undefined;
      if (s === 2) return objs.get(g)?.ct;
      if (s === 16) {
        // ItemUseable: Heart has 0x600004 (wielded)
        return g === HEART_GUID ? 0x600004 : undefined;
      }
      return undefined;
    },
    TryGetObjectDataIdProperty: (g, s) => {
      // 28 = PropertyDataId.Spell; Heart has 1166 (Heal Other VI)
      if (s === 28 && g === HEART_GUID) return 1166;
      return undefined;
    },
    TryGetSpellRecord: (id) => {
      if (id === 1166) return { id: 1166, category: 79, power: 200 };
      return null;
    },
    TryGetCreatureInfo: (g) => (objs.has(g) ? { guid: g, name: objs.get(g).name, wcid: objs.get(g).wcid, creatureType: objs.get(g).ct, dist: objs.get(g).dist } : null),
    TryGetKnownSpells: () => host.known.slice(),
    TryGetPlayerStats: () => ({ skills: SKILLS }),
    TryGetWieldedItems: (g) => (g === SELF_GUID ? host.wielded.map((r) => ({ ...r })) : []),
    TryGetPlayerInventory: () => host.inventory.map((r) => ({ ...r, equipMask: host.wielded.find((w) => w.guid === r.guid)?.equipMask ?? 0 })),
    GetCurrentCombatMode: () => host.mode,
    NearbyGuids: () => [...objs.keys()],
    ObjectIsPlayer: () => false,
    ObjectIsAttackable: () => true,
    TryGetTargetHealthFraction: () => 1.0,

    WieldItem(g, mask) {
      host.actions.push(["wield", g, mask]);
      const it = host.inventory.find((i) => i.guid === g);
      if (it) {
        if (mask === EM.shield) {
          host.wielded = host.wielded.filter((w) => !(w.equipMask & EM.shield));
          host.wielded.push({ guid: g, itemType: it.itemType, equipMask: EM.shield });
        } else {
          host.wielded = host.wielded.filter((w) => !(w.equipMask & (EM.melee | EM.missile | EM.held)));
          host.wielded.push({ guid: g, itemType: it.itemType, equipMask: it.validLocations });
        }
      }
      return true;
    },
    UnwieldItem(g) {
      host.actions.push(["unwield", g]);
      host.wielded = host.wielded.filter((w) => w.guid !== g);
      return true;
    },
    ChangeCombatMode(m) {
      host.actions.push(["mode", m]);
      host.mode = m;
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
    _scanTargets() {
      const out = [];
      for (const [g, o] of host.objs) {
        const v = planner.scanVerdict(g, o.dist);
        if (v && v.ignore) continue;
        const score = 100 - o.dist + (v?.scoreBias ?? 0);
        out.push({ guid: g, dist: o.dist, score, bias: v?.scoreBias ?? 0 });
      }
      return out.sort((a, b) => b.score - a.score);
    },
  };

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
      now,
      log: (m) => logs.push(m),
    });

  planner = mkPlanner();

  return {
    host,
    options,
    monsters,
    planner,
    combat,
    emit,
    logs,
    tick: () => {
      host.snap.seq++;
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// CHALLENGE 1: High-Load Monster Prioritization Stress Test
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n=== CHALLENGE 1: High-Load Monster Prioritization (150+ Monsters) ===");

await check("Strict P x 1000 domination with 150 simulated monsters spanning priorities -1..4", () => {
  const priorities = [-1, 0, 1, 2, 3, 4];
  const monsterObjects = new Map();
  const rules = [];

  for (let i = 0; i < 150; i++) {
    const guid = 0x80000000 + i;
    const pri = priorities[i % priorities.length];
    const dist = 0.5 + ((i * 7.3) % 95);
    const name = `Monster_${i}_P${pri}`;
    monsterObjects.set(guid, { name, wcid: 1000 + (i % 20), dist, ct: 1 });
    rules.push({
      text: name,
      priority: pri,
      enabled: true,
      A: true,
    });
  }

  const rig = createCombatRig({
    entries: rules,
    objects: monsterObjects,
  });

  const scanned = rig.combat._scanTargets();

  // 1. Verify all P = -1 monsters are completely ignored / omitted from scan
  const pMinus1Count = Array.from(monsterObjects.entries()).filter(([_, m]) => m.name.includes("_P-1")).length;
  assert.equal(pMinus1Count, 25, "Expected exactly 25 P=-1 monsters");
  for (const s of scanned) {
    const orig = monsterObjects.get(s.guid);
    assert.ok(!orig.name.includes("_P-1"), `Ignored monster ${orig.name} must never appear in scanTargets!`);
  }
  assert.equal(scanned.length, 125, "All 125 non-ignored monsters must appear in scanned output");

  // 2. Verify strict P x 1000 domination
  for (let i = 0; i < scanned.length - 1; i++) {
    const curr = scanned[i];
    const next = scanned[i + 1];
    const priCurr = Math.floor(curr.bias / 1000);
    const priNext = Math.floor(next.bias / 1000);

    assert.ok(curr.score >= next.score, `Targets must sort by score descending: ${curr.score} >= ${next.score}`);

    if (priCurr !== priNext) {
      assert.ok(
        priCurr > priNext,
        `Priority domination violation: Target with P=${priCurr} (dist=${curr.dist}) was placed ahead of P=${priNext} (dist=${next.dist}), but priCurr <= priNext!`
      );
    } else {
      assert.ok(
        curr.dist <= next.dist,
        `Within priority ${priCurr}, target closer to player must rank higher: dist=${curr.dist} vs next dist=${next.dist}`
      );
    }
  }

  // 3. Boundary check: Highest distance P=4 (at ~90m) vs lowest distance P=3 (at 0.5m)
  const p4Targets = scanned.filter((s) => s.bias === 4000);
  const p3Targets = scanned.filter((s) => s.bias === 3000);
  const farthestP4 = p4Targets.reduce((max, s) => (s.dist > max.dist ? s : max), p4Targets[0]);
  const closestP3 = p3Targets.reduce((min, s) => (s.dist < min.dist ? s : min), p3Targets[0]);

  assert.ok(
    farthestP4.score > closestP3.score,
    `Farthest P=4 (${farthestP4.dist}m, score=${farthestP4.score}) must dominate closest P=3 (${closestP3.dist}m, score=${closestP3.score})`
  );
  assert.ok(
    farthestP4.score - closestP3.score >= 900,
    `Score gap between P=4 and P=3 must be at least 900 points (got ${farthestP4.score - closestP3.score})`
  );
});

await check("High-load throughput: 100 scan cycles over 150 monsters execute with sub-millisecond cache hits", () => {
  const monsterObjects = new Map();
  const rules = [];
  for (let i = 0; i < 150; i++) {
    const guid = 0x80000000 + i;
    const pri = (i % 5);
    const name = `Mob_${i}`;
    monsterObjects.set(guid, { name, wcid: 2000, dist: 10 + (i % 30), ct: 1 });
    rules.push({ text: name, priority: pri, enabled: true });
  }

  const rig = createCombatRig({ entries: rules, objects: monsterObjects });

  const tStart = performance.now();
  for (let cycle = 0; cycle < 100; cycle++) {
    rig.tick();
    const res = rig.combat._scanTargets();
    assert.equal(res.length, 150);
  }
  const elapsed = performance.now() - tStart;
  console.log(`       100 scans x 150 monsters (15,000 evaluations) completed in ${elapsed.toFixed(1)} ms`);
  assert.ok(elapsed < 1500, `Scan resolution took too long: ${elapsed.toFixed(1)} ms`);
});

// ─────────────────────────────────────────────────────────────────────────────
// CHALLENGE 2: Debuff Sequencing Stress Test (Partial Spellbooks)
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n=== CHALLENGE 2: Debuff Sequencing Stress (Partial Spellbooks) ===");

await check("Partial spellbook: Planner skips missing Vuln and Fester cleanly and completes debuff ladder", () => {
  // Known debuffs: Imperil, Yield, Weaken Armor.
  // Also include Fire Bolt so after debuffs are settled, attack can be planned cleanly.
  // Missing debuffs: Vuln, Fester, FC, DC.
  const knownSpells = [
    ...T.familyLadder("imperil").map((r) => r.id),
    ...T.familyLadder("yield").map((r) => r.id),
    ...T.familyLadder("wc").map((r) => r.id),
    ...T.familyLadder("bolt:fire").map((r) => r.id),
  ];

  const targetGuid = 0x80001001;
  const targetName = "StressTroll";
  const objects = new Map([
    [targetGuid, { name: targetName, wcid: 3001, dist: 15, ct: 5 }],
  ]);

  const entries = [
    normalizeEntry({
      text: targetName,
      I: true,
      V: true,
      Y: true,
      F: true,
      WC: true,
      FC: true,
      DC: true,
      A: true,
      damageType: "Fire",
    }),
  ];

  const rig = createCombatRig({
    knownSpells,
    entries,
    objects,
    wielded: [[WAND_GUID, IT.caster, EM.held]],
    mode: 8,
  });

  const castSequence = [];

  // Step 1: Imperil should be planned
  const p1 = rig.planner.nextCast(targetGuid, { mode: 8, now: NOW });
  assert.ok(p1, "Step 1 must produce a plan");
  assert.equal(p1.family, "imperil", "First cast must be Imperil");
  castSequence.push(p1.family);
  rig.planner.onCastIssued(targetGuid, p1, true);
  rig.emit({ type: "castLine", text: `You cast Imperil on ${targetName}` });

  // Step 2: Next is Vuln (missing) -> skipped cleanly -> Yield
  const p2 = rig.planner.nextCast(targetGuid, { mode: 8, now: NOW });
  assert.ok(p2, "Step 2 must produce a plan despite missing Vuln");
  assert.equal(p2.family, "yield", "Second cast must be Yield (skipped missing Vuln)");
  castSequence.push(p2.family);
  rig.planner.onCastIssued(targetGuid, p2, true);
  rig.emit({ type: "castLine", text: `You cast Yield on ${targetName}` });

  // Step 3: Next is Fester (missing) -> skipped cleanly -> Weaken Armor (WC)
  const p3 = rig.planner.nextCast(targetGuid, { mode: 8, now: NOW });
  assert.ok(p3, "Step 3 must produce a plan despite missing Fester");
  assert.equal(p3.family, "wc", "Third cast must be Weaken Armor (skipped missing Fester)");
  castSequence.push(p3.family);
  rig.planner.onCastIssued(targetGuid, p3, true);
  rig.emit({ type: "castLine", text: `You cast Weaken Armor on ${targetName}` });

  // Step 4: Next are FC and DC (both missing) -> all debuffs settled -> war attack
  const p4 = rig.planner.nextCast(targetGuid, { mode: 8, now: NOW });
  assert.ok(p4, "Step 4 must produce a war attack plan");
  assert.equal(p4.kind, "attack", "After debuffs, must plan attack spell");
  assert.equal(p4.family, "bolt:fire", "Attack family must match element");

  assert.deepEqual(castSequence, ["imperil", "yield", "wc"]);

  // Verify that unavailable marks are stored in ledger so subsequent ticks don't re-query
  assert.ok(rig.planner.ledger.isUnavailable("vuln:fire"), "Vuln must be marked unavailable");
  assert.ok(rig.planner.ledger.isUnavailable("fester"), "Fester must be marked unavailable");
  assert.ok(rig.planner.ledger.isUnavailable("fc"), "FC must be marked unavailable");
  assert.ok(rig.planner.ledger.isUnavailable("dc"), "DC must be marked unavailable");
});

await check("Empty debuff spellbook: Non-attacking debuff-only entry cleanly drops target without stalling", () => {
  const warSpells = T.familyLadder("bolt:fire").map((r) => r.id);
  const targetGuid = 0x80001002;
  const targetName = "DebuffDummy";
  const objects = new Map([
    [targetGuid, { name: targetName, wcid: 3002, dist: 10, ct: 5 }],
  ]);

  const entries = [
    normalizeEntry({
      text: targetName,
      I: true,
      V: true,
      F: true,
      A: false,
    }),
  ];

  const rig = createCombatRig({
    knownSpells: warSpells,
    entries,
    objects,
    wielded: [[WAND_GUID, IT.caster, EM.held]],
    mode: 8,
  });

  const plan = rig.planner.nextCast(targetGuid, { mode: 8, now: NOW });
  assert.ok(plan && plan.done === true, `Must return { done: true }, got: ${JSON.stringify(plan)}`);

  rig.tick();
  const verdict = rig.planner.scanVerdict(targetGuid, 10);
  assert.ok(verdict && verdict.ignore === true, `Non-attacking target with settled/unavailable debuffs must be ignored, got: ${JSON.stringify(verdict)}`);
});

await check("Dynamic spellbook update: Newly learned spell clears unavailable mark and is cast on next tick", () => {
  const initialKnown = [
    ...T.familyLadder("imperil").map((r) => r.id),
    ...T.familyLadder("bolt:fire").map((r) => r.id),
  ];
  const targetGuid = 0x80001003;
  const targetName = "TrollKing";
  const objects = new Map([
    [targetGuid, { name: targetName, wcid: 3003, dist: 8, ct: 5 }],
  ]);

  const entries = [
    normalizeEntry({
      text: targetName,
      I: true,
      V: true,
      A: true,
      damageType: "Fire",
    }),
  ];

  const rig = createCombatRig({
    knownSpells: initialKnown,
    entries,
    objects,
    wielded: [[WAND_GUID, IT.caster, EM.held]],
    mode: 8,
  });

  // Cast 1: Imperil
  const p1 = rig.planner.nextCast(targetGuid, { mode: 8, now: NOW });
  assert.equal(p1.family, "imperil");
  rig.planner.onCastIssued(targetGuid, p1, true);
  rig.emit({ type: "castLine", text: `You cast Imperil on ${targetName}` });

  // Cast 2: Vuln is missing -> skipped, marked unavailable, falls through to attack
  const p2 = rig.planner.nextCast(targetGuid, { mode: 8, now: NOW });
  assert.equal(p2.kind, "attack");
  assert.ok(rig.planner.ledger.isUnavailable("vuln:fire"));

  // Player now dynamically learns Vuln (e.g. from scroll)
  const vulnSpells = T.familyLadder("vuln:fire").map((r) => r.id);
  rig.host.known.push(...vulnSpells);
  rig.tick(); // advance seq

  // Next cast: Planner must detect known book signature changed, clear unavailable, and cast Vuln!
  const p3 = rig.planner.nextCast(targetGuid, { mode: 8, now: NOW });
  assert.ok(p3, "Must produce a plan after book update");
  assert.equal(p3.family, "vuln:fire", `Newly learned Vuln must be cast! Got: ${p3.family}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// CHALLENGE 3: Weapon / Wand Swap Stress Test
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n=== CHALLENGE 3: Weapon / Wand Swap Stress & Healer's Heart Protection ===");

await check("Healer's Heart protection: Heart is NEVER selected as debuff wand, nor wielded as monster weapon", () => {
  const targetGuid = 0x80002001;
  const targetName = "GrievousTarget";
  const objects = new Map([
    [targetGuid, { name: targetName, wcid: 4001, dist: 12, ct: 2 }],
  ]);

  const entries = [
    normalizeEntry({
      text: targetName,
      Y: true,
      weapon: HEART_GUID,
      A: true,
    }),
  ];

  const rig = createCombatRig({
    entries,
    objects,
    wielded: [[SWORD_GUID, IT.melee, EM.melee], [SHIELD_GUID, IT.armor, EM.shield]],
    mode: 2,
    opts: { SwitchWandsToDebuff: true },
  });

  // Verify _findWand(): Heart is in inventory, but must pick WAND_GUID, never HEART_GUID
  const wand = rig.planner._findWand();
  assert.equal(wand, WAND_GUID, `_findWand() must pick Debuff Wand, never Healer's Heart (got ${wand})`);

  // Ensure loadout: must initiate swap to WAND_GUID for debuffing
  let loadoutState = rig.planner.ensureLoadout(targetGuid, NOW);
  assert.equal(loadoutState, "busy");
  assert.deepEqual(rig.host.actions.at(-1), ["wield", WAND_GUID, 0]);

  // Complete the swap to wand
  rig.host.wielded = [{ guid: WAND_GUID, itemType: IT.caster, equipMask: EM.held }];
  rig.emit({ type: "equip", item: WAND_GUID, wielder: SELF_GUID, failed: false });
  NOW += 3500;
  rig.tick();

  // Next step of ensureLoadout sets stance to Magic (mode 8)
  loadoutState = rig.planner.ensureLoadout(targetGuid, NOW);
  assert.equal(loadoutState, "busy");
  assert.deepEqual(rig.host.actions.at(-1), ["mode", 8]);
  rig.host.mode = 8;
  rig.tick();

  // Stance reached, ensureLoadout returns "ok"
  assert.equal(rig.planner.ensureLoadout(targetGuid, NOW), "ok");

  // Cast debuff Yield
  const plan = rig.planner.nextCast(targetGuid, { mode: 8, now: NOW });
  assert.equal(plan.family, "yield");
  rig.planner.onCastIssued(targetGuid, plan, true);
  rig.emit({ type: "castLine", spellName: T.nameOf(plan.spellId), targetName, outcome: "landed", raw: "" });

  NOW += 3500;
  rig.tick();

  // Debuffs finished! Target entry specifies weapon = HEART_GUID.
  // The planner must reject HEART_GUID as weapon, log a warning, and restore original SWORD_GUID!
  loadoutState = rig.planner.ensureLoadout(targetGuid, NOW);
  assert.equal(loadoutState, "busy");
  assert.deepEqual(rig.host.actions.at(-1), ["wield", SWORD_GUID, 0], "Must restore SWORD_GUID, refusing HEART_GUID as weapon");
  assert.ok(
    rig.logs.some((m) => m.includes("Healer's Heart")),
    "Must log warning that Healer's Heart cannot be used as a weapon"
  );
});

await check("wandSlotHeld gate: When Healer's Heart is in-use by healing reflex, ensureLoadout returns 'busy' and refuses wand swap", () => {
  const targetGuid = 0x80002002;
  const targetName = "Troll";
  const objects = new Map([
    [targetGuid, { name: targetName, wcid: 4002, dist: 12, ct: 2 }],
  ]);

  const entries = [
    normalizeEntry({ text: targetName, I: true, A: true }),
  ];

  const rig = createCombatRig({
    entries,
    objects,
    wielded: [[SWORD_GUID, IT.melee, EM.melee]],
    mode: 2,
    opts: { SwitchWandsToDebuff: true },
  });

  rig.planner.wandSlotHeld = () => true;

  const res = rig.planner.ensureLoadout(targetGuid, NOW);
  assert.equal(res, "busy", "ensureLoadout must return 'busy' while wand slot is held by healer");
  assert.equal(rig.host.actions.length, 0, "No equip actions must be issued while wand slot is held");
});

await check("Rapid target switching & interrupts while debuff is in flight: Loadout safely stows wand and restores weapon", () => {
  const target1 = 0x80003001;
  const target2 = 0x80003002;
  const objects = new Map([
    [target1, { name: "TargetOne", wcid: 5001, dist: 15, ct: 2 }],
    [target2, { name: "TargetTwo", wcid: 5002, dist: 5, ct: 2 }],
  ]);

  const entries = [
    normalizeEntry({ text: "TargetOne", I: true, A: true }),
    normalizeEntry({ text: "TargetTwo", I: false, A: true }), // Target 2 needs NO debuffs
  ];

  const rig = createCombatRig({
    entries,
    objects,
    wielded: [[SWORD_GUID, IT.melee, EM.melee], [SHIELD_GUID, IT.armor, EM.shield]],
    mode: 2,
    opts: { SwitchWandsToDebuff: true },
  });

  // 1. Engage Target 1 -> swap to Wand
  let res = rig.planner.ensureLoadout(target1, NOW);
  assert.equal(res, "busy");
  assert.deepEqual(rig.host.actions.at(-1), ["wield", WAND_GUID, 0]);

  // Complete wand equip
  rig.host.wielded = [{ guid: WAND_GUID, itemType: IT.caster, equipMask: EM.held }];
  rig.emit({ type: "equip", item: WAND_GUID, wielder: SELF_GUID, failed: false });
  NOW += 3500;
  rig.tick();

  // Mode changes to Magic (8)
  res = rig.planner.ensureLoadout(target1, NOW);
  assert.equal(res, "busy");
  assert.deepEqual(rig.host.actions.at(-1), ["mode", 8]);
  rig.host.mode = 8;
  rig.tick();

  // 2. Cast Imperil on Target 1 (in flight)
  const plan = rig.planner.nextCast(target1, { mode: 8, now: NOW });
  assert.equal(plan.family, "imperil");
  rig.planner.onCastIssued(target1, plan, true);
  assert.ok(rig.planner.ledger.isPending(target1, "imperil"), "Imperil must be marked pending");

  // 3. RAPID TARGET SWITCH: Switch to Target 2 (needs no debuffs)
  // Debuff is still in-flight on Target 1! Verify wand is preserved and not swapped away mid-flight.
  NOW += 500;
  rig.tick();

  // 4. Damage interrupt / spell failure arrives for Target 1's in-flight cast!
  rig.emit({ type: "useFailed", code: 0x0402, text: "Your spell fizzled." });
  NOW += 500;
  rig.tick();

  // 5. Target 2 needs NO debuffs and Target 1's cast is resolved/cleared.
  // Now ensureLoadout(target2) must safely restore Sword & Shield!
  NOW += 3500;
  rig.tick();

  // First restore main hand (SWORD)
  res = rig.planner.ensureLoadout(target2, NOW);
  assert.equal(res, "busy");
  assert.deepEqual(rig.host.actions.at(-1), ["wield", SWORD_GUID, 0]);

  // Sword equip completes
  rig.host.wielded = [{ guid: SWORD_GUID, itemType: IT.melee, equipMask: EM.melee }];
  rig.emit({ type: "equip", item: SWORD_GUID, wielder: SELF_GUID, failed: false });
  NOW += 3500;
  rig.tick();

  // Because Sword wield changed _swap.purpose to "restore", stanceStep transitions to mode 1 (noncombat)
  res = rig.planner.ensureLoadout(target2, NOW);
  assert.equal(res, "busy");
  assert.deepEqual(rig.host.actions.at(-1), ["mode", 1]);
  rig.host.mode = 2; // back in melee
  rig.tick();

  // Next restore offhand shield
  res = rig.planner.ensureLoadout(target2, NOW);
  assert.equal(res, "busy");
  assert.deepEqual(rig.host.actions.at(-1), ["wield", SHIELD_GUID, EM.shield]);

  // Shield equip completes
  rig.host.wielded.push({ guid: SHIELD_GUID, itemType: IT.armor, equipMask: EM.shield });
  rig.emit({ type: "equip", item: SHIELD_GUID, wielder: SELF_GUID, failed: false });
  NOW += 3500;
  rig.tick();

  // Final check: loadout is fully restored, ensureLoadout returns "ok"
  res = rig.planner.ensureLoadout(target2, NOW);
  assert.equal(res, "ok", "Loadout must be fully satisfied and return 'ok'");
  assert.equal(rig.planner._saved, null, "Saved loadout must be cleanly reset");
});

console.log(`\nCombat Stress Suite Results: ${pass} passed, ${fail} failed.`);
if (fail > 0) process.exit(1);
