// tests/rynth_vt_host_fns.test.mjs — the meta HOST function library, the
// shared VtActions helpers and the quest tracker (PLAN W1-5 CMD §3.7, §6 W1-5).
//
// * the 81 function names the real corpus metas use (U5 §5.6; computed from the
//   20 CORPUS .met/.af files, inline below) all resolve: host ones are
//   registered here, the pure ones (EXPR) and vtsetmetastate (META) are faked
//   as present — no other vt package is imported (C2);
// * cast functions never cast untargeted (C6, U4 H1);
// * settings functions go through a fake VtOptions (+ the meta bag);
// * chatbox → runChat; echo → print;
// * QuestTracker parses /myquests lines and computes ready/flags;
// * source scan: no forbidden cast/chat strings, no timers, no DOM, imports
//   only inside rynth/vt/cmd/.
//
// Run from apps/holtburger-web/:  node tests/rynth_vt_host_fns.test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CMD_DIR = path.resolve(HERE, "../rynth/vt/cmd");
const M = await import("../rynth/vt/cmd/index.js");
const {
  registerHostFunctions, HOST_FUNCTION_NAMES, NOT_HOST_FUNCTIONS, createVtActions, objectClassFrom, OBJECT_CLASS,
  QuestTracker, parseQuestLine, questReady, guidOfValue, valueToString, valueTypeName, chatCategoryForType, VAL,
} = M;

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

// The 81 distinct functions used by the 20 corpus metas (U5 §5.6 "the corpus uses 81").
const CORPUS_FUNCTIONS = [
  "abs", "actiontrycastbyid", "actiontrygiveitem", "actiontryuseitem", "chatbox", "clearallvars", "clearvar",
  "cnumber", "coordinatedistancewithz", "coordinategetns", "coordinategetwe", "cstr", "dictadditem", "dictcreate",
  "dictgetitem", "dicthaskey", "dictkeys", "dictvalues", "echo", "floor", "getcharintprop", "getcharquadprop",
  "getcharskill_traininglevel", "getcharstringprop", "getheading", "getinventorycountbytemplatetype",
  "getisspellknown", "getitemcountininventorybyname", "getitemcountininventorybynamerx", "getobjectinternaltype",
  "getplayercoordinates", "getplayerlandcell", "getpvar", "getquestktprogress", "getquestktrequired",
  "getqueststatus", "getvar", "ifthen", "iif", "isfalse", "isrefreshingquests", "istrue", "listadd", "listcopy",
  "listcount", "listcreate", "listfilter", "listgetitem", "listindexof", "listmap", "listpop", "listremove",
  "listremoveat", "round", "setpvar", "setvar", "spellname", "stopwatchcreate", "stopwatchelapsedseconds",
  "stopwatchstart", "stopwatchstop", "testquestflag", "testvar", "vtsetmetastate", "wobjectfindallinventory",
  "wobjectfindbyid", "wobjectfindininventorybyname", "wobjectfindininventorybynamerx",
  "wobjectfindininventorybytemplatetype", "wobjectfindnearestbynameandobjectclass",
  "wobjectfindnearestbyobjectclass", "wobjectfindnearestbytemplatetype", "wobjectgetid", "wobjectgetintprop",
  "wobjectgetname", "wobjectgetobjectclass", "wobjectgetopencontainer", "wobjectgetphysicscoordinates",
  "wobjectgetplayer", "wobjectgetselection", "wobjectgetspellids",
];
// EXPR's pure library (§3.4 groups A-H(T)) — registered by W1-1, faked here.
const PURE_NAMES = [
  "abs", "acos", "asin", "atan", "atan2", "ceiling", "chr", "clearallgvars", "clearallpvars", "clearallvars",
  "cleargvar", "clearpvar", "clearvar", "cnumber", "coordinatedistanceflat", "coordinatedistancewithz",
  "coordinategetns", "coordinategetwe", "coordinategetz", "coordinateparse", "coordinatetostring", "cos", "cosh",
  "cstr", "cstrf", "delayexec", "dictadditem", "dictclear", "dictcopy", "dictcreate", "dictgetitem", "dicthaskey",
  "dictkeys", "dictremovekey", "dictsize", "dictvalues", "exec", "floor", "getdatetimelocal", "getdatetimeutc",
  "getgvar", "getobjectinternaltype", "getpvar", "getregexmatch", "getunixtime", "getvar", "hexstr", "if", "ifthen",
  "iif", "isfalse", "istrue", "listadd", "listclear", "listcontains", "listcopy", "listcount", "listcreate",
  "listfilter", "listfromrange", "listgetitem", "listindexof", "listinsert", "listlastindexof", "listmap", "listpop",
  "listreduce", "listremove", "listremoveat", "listreverse", "listsort", "ord", "randint", "round", "setgvar",
  "setpvar", "setvar", "sin", "sinh", "sqrt", "stopwatchcreate", "stopwatchelapsedseconds", "stopwatchstart",
  "stopwatchstop", "strlen", "tan", "tanh", "testgvar", "testpvar", "testvar", "tostring", "touchgvar", "touchpvar",
  "touchvar",
];
const META_NAMES = ["vtgetmetastate", "ragetmetastate", "getmetastate", "vtsetmetastate", "rasetmetastate", "setmetastate"];
const VIEW_NAMES = ["uiviewexists", "uiviewvisible", "uigetcontrol", "uisetlabel", "uisetvisible"];

// ── fakes ────────────────────────────────────────────────────────────────────
const ME = 0x50000001;
const POSE = { objCellId: 0xa9b40019, x: 84, y: 12, z: 48, heading: 0 };

function fakeRegistry() {
  const m = new Map();
  return {
    m,
    define(name, impl, opts) {
      assert.equal(typeof impl, "function");
      m.set(String(name).toLowerCase(), { impl, opts });
      return true;
    },
    call(name, ...args) {
      const e = m.get(name);
      assert.ok(e, `function ${name} not registered`);
      return e.impl(args, { raw: args.map(String) });
    },
  };
}

function fakeHost(over = {}) {
  const calls = [];
  const rec = (n, ret = true) => (...a) => {
    calls.push([n, ...a]);
    return typeof ret === "function" ? ret(...a) : ret;
  };
  const objects = {
    [ME]: { name: "Mage Mary", pos: POSE, df: 0x8, it: 0x10, wcid: 1 },
    0x80000101: { name: "Fiun Rehlyun", pos: { objCellId: 0xa9b40019, x: 90, y: 12, z: 48 }, df: 0x0, it: 0x10, wcid: 5001 },
    0x80000102: { name: "Gateway", pos: { objCellId: 0xa9b40019, x: 84, y: 30, z: 48 }, df: 0x40000, it: 0x10000, wcid: 44204 },
    0x80000103: { name: "Shopkeeper Sal", pos: { objCellId: 0xa9b40019, x: 70, y: 12, z: 48 }, df: 0x200, it: 0x10, wcid: 5002 },
    0x80000104: { name: "Drudge Skulker", pos: { objCellId: 0xa9b40019, x: 84, y: 22, z: 48 }, df: 0x10, it: 0x10, wcid: 7 },
    0x80000105: { name: "Corpse of Sir Bellas", pos: { objCellId: 0xa9b40019, x: 85, y: 12, z: 48 }, df: 0x2000, it: 0x200, wcid: 21 },
    0x7a000001: { name: "Door", pos: { objCellId: 0xa9b40019, x: 84, y: 16, z: 48 }, df: 0x1000, it: 0x80, wcid: 412, state: 0x4 },
    0x50000042: { name: "Bob", pos: { objCellId: 0xa9b40019, x: 80, y: 12, z: 48 }, df: 0x8, it: 0x10, wcid: 1 },
  };
  const inventory = [
    { guid: 0x70000001, name: "Mana Stone", wcid: 2434, stackSize: 1, itemType: 0x80000, equipMask: 0, containerId: ME },
    { guid: 0x70000002, name: "Pyreal", wcid: 273, stackSize: 25, itemType: 0x40, equipMask: 0, containerId: ME },
    { guid: 0x70000003, name: "Pyreal", wcid: 273, stackSize: 10, itemType: 0x40, equipMask: 0, containerId: 0x70000010 },
    { guid: 0x70000004, name: "Insatiable Eater Jaw", wcid: 34441, stackSize: 1, itemType: 0x80, equipMask: 0, containerId: ME },
    { guid: 0x70000005, name: "Wand of Frost", wcid: 5000, stackSize: 1, itemType: 0x8000, equipMask: 0x1000000, containerId: ME },
    { guid: 0x70000006, name: "Facility Hub Portal Gem", wcid: 43020, stackSize: 2, itemType: 0x800, equipMask: 0, containerId: ME },
    { guid: 0x70000010, name: "Pack", wcid: 136, stackSize: 1, itemType: 0x200, equipMask: 0, containerId: ME },
  ];
  const spells = {
    2931: { id: 2931, name: "Recall Aphus Lassel", isSelfTargeted: true },
    1: { id: 1, name: "Strength Other I", isSelfTargeted: false },
    27: { id: 27, name: "Flame Bolt I", isSelfTargeted: false },
    2: { id: 2, name: "Strength Self I", isSelfTargeted: true },
  };
  const S = {
    calls,
    combatMode: 8,
    busy: 0,
    castOwner: null,
    itemOwner: null,
    known: [2931, 1, 27, 2],
    selected: 0,
    hasRecords: true,
    enchantments: [
      { spellId: 2, layer: 1, remainingS: 1234.2, permanent: false, isCooldown: false },
      { spellId: 3000, layer: 1, remainingS: 0, permanent: true, isCooldown: false },
      { spellId: 32768, layer: 1, remainingS: 50, permanent: false, isCooldown: true },
    ],
    stats: {
      vitals: { 1: { current: 150, base: 120, max: 180 }, 3: { current: 90, base: 100, max: 110 }, 5: { current: 40, base: 200, max: 250 } },
      skills: { 34: { current: 300, base: 250, training: 3 } },
      attributes: { 1: { current: 200, base: 100 } },
    },
    fellowship: { name: "Hunters", leaderGuid: ME, open: true, isLocked: false, members: [{ guid: ME, name: "Mage Mary" }, { guid: 0x50000042, name: "Bob" }] },
    room: { main: { used: 30, cap: 102, free: 72 }, containers: { used: 1, cap: 7, free: 6 }, packs: [{ guid: 0x70000010, name: "Pack", used: 1, cap: 24, free: 23 }] },
    GetPlayerId: () => ME,
    has: (cap) => (cap === "GetSpellRecord" ? S.hasRecords : true),
    TryGetPlayerPose: () => ({ ...POSE }),
    NearbyGuids: () => Object.keys(objects).map(Number),
    TryGetObjectName: (g) => objects[g]?.name ?? inventory.find((r) => r.guid === g)?.name ?? null,
    TryGetObjectPosition: (g) => (objects[g] ? { ...objects[g].pos } : null),
    TryGetObjectDistance: (g) => {
      const o = objects[g];
      if (!o) return null;
      return Math.hypot(o.pos.x - POSE.x, o.pos.y - POSE.y, o.pos.z - POSE.z);
    },
    TryGetObjectDescFlags: (g) => (objects[g] ? objects[g].df : null),
    TryGetObjectIntProperty: (g, id) => {
      if (id === 1) return objects[g]?.it ?? inventory.find((r) => r.guid === g)?.itemType;
      if (g === ME && id === 5) return 4321;
      if (g === ME && id === 25) return 126;
      if (g === 0x70000004 && id === 19) return 500;
      return undefined;
    },
    TryGetObjectQuadProperty: (g, id) => (g === ME && id === 2 ? 3_500_000_000 : undefined),
    TryGetObjectDoubleProperty: (g, id) => (g === 0x70000004 && id === 280 ? 7.5 : undefined),
    TryGetObjectBoolProperty: () => undefined,
    TryGetObjectStringProperty: (g, id) => (g === ME && id === 5 ? "Adventurer" : undefined),
    TryGetObjectWcid: (g) => objects[g]?.wcid ?? inventory.find((r) => r.guid === g)?.wcid ?? 0,
    TryGetObjectState: (g) => objects[g]?.state ?? 0,
    ObjectIsPlayer: (g) => !!(objects[g] && objects[g].df & 0x8),
    ObjectIsAttackable: (g) => !!(objects[g] && objects[g].df & 0x10),
    TryGetPlayerInventory: () => inventory.map((r) => ({ ...r })),
    TryGetPlayerInventoryCached: () => inventory.map((r) => ({ ...r })),
    TryGetPackRoomCached: () => S.room,
    GetGroundContainerId: () => 0x80000105,
    GetContainerContents: (c) => (c === 0x80000105 ? [0x70000101, 0x70000102] : []),
    TryGetObjectAppraisal: (g) => (g === 0x70000005 ? { spellBook: [1, 2, 0x80000000 | 27] } : null),
    TryGetTargetHealthFraction: (g) => (g === 0x80000104 ? 0.5 : -1),
    HasAppraisalData: (g) => g === 0x70000005,
    GetLastIdTime: () => 1234,
    RequestId: rec("RequestId"),
    TryGetKnownSpells: () => S.known.slice(),
    TryGetSpellRecord: (id) => (S.hasRecords ? spells[id] ?? null : null),
    TryGetSelfEnchantments: () => S.enchantments,
    TryGetVitae: () => 0.95,
    TryGetBurden: () => 37,
    TryGetPlayerStats: () => S.stats,
    TryGetPlayerCompassHeadingDeg: () => 123.5,
    TryGetFellowshipInfo: () => S.fellowship,
    IsPortalSpaceActive: () => false,
    GetCurrentCombatMode: () => S.combatMode,
    GetBusyState: () => S.busy,
    GetSelectedId: () => S.selected,
    tryClaimCast: (owner) => {
      if (S.castOwner && S.castOwner !== owner) return false;
      S.castOwner = owner;
      return true;
    },
    releaseCast: (owner) => {
      if (S.castOwner === owner) S.castOwner = null;
    },
    tryClaimItemAction: (owner, o) => {
      calls.push(["tryClaimItemAction", owner, o]);
      if (S.itemOwner && S.itemOwner !== owner) return false;
      S.itemOwner = owner;
      return true;
    },
    releaseItemAction: (owner) => {
      if (S.itemOwner === owner) S.itemOwner = null;
    },
    CastSelf: rec("CastSelf"),
    CastSpellAt: rec("CastSpellAt", (g) => (Number(g) >>> 0) !== 0),
    CastSpell: rec("CastSpell"),
    CastUntargetedSpell: rec("CastUntargetedSpell"),
    CastUntargetedSafe: rec("CastUntargetedSafe"),
    ChangeCombatMode: rec("ChangeCombatMode"),
    WieldItem: rec("WieldItem"),
    UnwieldItem: rec("UnwieldItem"),
    UseObject: rec("UseObject"),
    UseItemOnTarget: rec("UseItemOnTarget"),
    GiveObject: rec("GiveObject"),
    DropItem: rec("DropItem"),
    TakeObject: rec("TakeObject"),
    SelectObject: rec("SelectObject"),
    SetMovementInput: rec("SetMovementInput"),
    TurnToCompassHeading: rec("TurnToCompassHeading"),
    FindNearbyByName: (name, o = {}) =>
      Object.entries(objects)
        .map(([g, v]) => ({ guid: Number(g), name: v.name, dist: S.TryGetObjectDistance(Number(g)) }))
        .filter((x) => x.guid !== ME)
        .filter((x) => (o.exact === false ? x.name.toLowerCase().includes(String(name).toLowerCase()) : x.name.toLowerCase() === String(name).toLowerCase()))
        .filter((x) => !o.player || objects[x.guid].df & 0x8)
        .sort((a, b) => a.dist - b.dist),
    ...over,
  };
  return S;
}

function fakeOptions() {
  const calls = [];
  const known = { attackdistance: ["MonsterRange", 40], enablenav: ["EnableNavigation", false], enablecombat: ["EnableCombat", true] };
  const bag = new Map();
  return {
    calls,
    bagMap: bag,
    bag: {
      get: (n) => bag.get(String(n).toLowerCase()),
      set: (n, v) => (calls.push(["bag.set", n, v]), bag.set(String(n).toLowerCase(), v)),
      has: (n) => bag.has(String(n).toLowerCase()),
    },
    get(name, o = {}) {
      calls.push(["get", name, o]);
      const k = known[String(name).toLowerCase()];
      if (!k) return { ok: false, error: `unknown option ${name}` };
      return { ok: true, value: o.vtUnits && String(name).toLowerCase() === "attackdistance" ? k[1] / 240 : k[1], key: k[0] };
    },
    set(name, raw, o = {}) {
      calls.push(["set", name, raw, o]);
      const k = known[String(name).toLowerCase()];
      if (!k) return { ok: false, error: `unknown option ${name}` };
      k[1] = raw;
      return { ok: true, value: raw, key: k[0] };
    },
  };
}

function env({ hostOver = {}, withActions = true } = {}) {
  const host = fakeHost(hostOver);
  const printed = [];
  const chat = [];
  const logs = [];
  const options = fakeOptions();
  const quests = new QuestTracker({ runChat: (l) => chat.push(l), now: () => T.now });
  const creatures = {
    maxHp: (w) => (w === 7 ? 85 : null),
    resists: (w) => (w === 7 ? { Fire: 0.5, Cold: 1.2, Lightning: 1 } : null),
    weakest: (w) => (w === 7 ? "Fire" : null),
  };
  const T = { now: 1_800_000_000_000 };
  const actions = withActions ? createVtActions({ host, now: () => T.now, log: (m) => logs.push(m) }) : null;
  const reg = fakeRegistry();
  const defined = registerHostFunctions(reg, {
    host,
    actions,
    options,
    print: (text, cat) => printed.push({ text, cat }),
    runChat: (line) => chat.push(line),
    quests,
    creatures,
    nav: { status: () => ({}), isEmpty: () => true },
    now: () => T.now,
    log: (m) => logs.push(m),
  });
  return { host, printed, chat, logs, options, quests, reg, defined, T, actions };
}

const isWobj = (v, guid) => v && v.t === "wobj" && (guid === undefined || v.guid === guid);

// ── registration ─────────────────────────────────────────────────────────────
await check("registerHostFunctions defines exactly HOST_FUNCTION_NAMES through registry.define", () => {
  const E = env();
  assert.deepEqual([...E.defined].sort(), [...HOST_FUNCTION_NAMES].sort());
  assert.deepEqual([...E.reg.m.keys()].sort(), [...HOST_FUNCTION_NAMES].sort());
  assert.ok(HOST_FUNCTION_NAMES.length >= 148, `${HOST_FUNCTION_NAMES.length}`);
  assert.deepEqual(registerHostFunctions(null, {}), []);
});

await check("no overlap with EXPR's pure library, META's *metastate or the ui* view functions", () => {
  const host = new Set(HOST_FUNCTION_NAMES);
  for (const n of [...PURE_NAMES, ...META_NAMES, ...VIEW_NAMES]) assert.equal(host.has(n), false, n);
  assert.deepEqual([...NOT_HOST_FUNCTIONS].sort(), [...META_NAMES, ...VIEW_NAMES].sort());
});

await check("all 81 corpus function names resolve (pure + META faked present)", () => {
  assert.equal(CORPUS_FUNCTIONS.length, 81);
  const E = env();
  const present = new Set([...PURE_NAMES, ...META_NAMES, ...E.reg.m.keys()]);
  const missing = CORPUS_FUNCTIONS.filter((n) => !present.has(n));
  assert.deepEqual(missing, []);
});

// ── casting (C6) ─────────────────────────────────────────────────────────────
const castCalls = (h) => h.calls.filter((c) => /^Cast/.test(c[0]));

await check("actiontrycastbyid: SelfTargeted → CastSelf (0 = sent); never untargeted", () => {
  const E = env();
  assert.equal(E.reg.call("actiontrycastbyid", 2931), 0);
  assert.deepEqual(castCalls(E.host), [["CastSelf", 2931]]);
  E.host.castOwner = null;
  assert.equal(E.reg.call("actiontrycastbyid", 1), 2, "non-SelfTargeted with nothing selected → impossible");
  E.host.selected = 0x80000104;
  assert.equal(E.reg.call("actiontrycastbyid", 1), 0);
  assert.deepEqual(castCalls(E.host).at(-1), ["CastSpellAt", 0x80000104, 1]);
  E.host.castOwner = null;
  assert.equal(E.reg.call("actiontrycastbyidontarget", 27, VAL.wobj(0x80000104, "Drudge Skulker")), 0);
  assert.deepEqual(castCalls(E.host).at(-1), ["CastSpellAt", 0x80000104, 27]);
  E.host.castOwner = null;
  assert.equal(E.reg.call("actiontrycastbyidontarget", 27, 0), 2, "no target → impossible");
  assert.equal(E.reg.call("actiontrycastbyid", 9999), 2, "unknown spell → impossible");
  assert.equal(E.reg.call("actiontrycastbyid", "x"), 2);
  const bad = E.host.calls.filter((c) => ["CastSpell", "CastUntargetedSpell", "CastUntargetedSafe"].includes(c[0]));
  assert.deepEqual(bad, [], "never the untargeted or legacy members");
});

await check("castById steps: magic mode (≤ 1 change / 3 s), wand wield, busy, foreign cast token → 1", () => {
  const E = env();
  E.host.combatMode = 1;
  assert.equal(E.reg.call("actiontrycastbyid", 2931), 1);
  assert.equal(E.reg.call("actiontrycastbyid", 2931), 1);
  assert.equal(E.host.calls.filter((c) => c[0] === "ChangeCombatMode").length, 1, "rate limited");
  E.T.now += 3000;
  E.reg.call("actiontrycastbyid", 2931);
  assert.equal(E.host.calls.filter((c) => c[0] === "ChangeCombatMode" && c[1] === 8).length, 2);
  // a wand in the pack (not wielded) is wielded first, claiming the item token
  const W = env({
    hostOver: {
      TryGetPlayerInventoryCached: () => [{ guid: 0x70000005, name: "Wand", itemType: 0x8000, equipMask: 0, stackSize: 1 }],
      TryGetPlayerInventory: () => [{ guid: 0x70000005, name: "Wand", itemType: 0x8000, equipMask: 0, stackSize: 1 }],
    },
  });
  W.host.combatMode = 1;
  assert.equal(W.reg.call("actiontrycastbyid", 2931), 1);
  assert.deepEqual(W.host.calls.find((c) => c[0] === "WieldItem"), ["WieldItem", 0x70000005]);
  assert.deepEqual(W.host.calls.find((c) => c[0] === "tryClaimItemAction"), ["tryClaimItemAction", "vtcmd", { minIntervalMs: 3000 }]);
  E.host.combatMode = 8;
  E.host.busy = 1;
  assert.equal(E.reg.call("actiontrycastbyid", 2931), 1);
  E.host.busy = 0;
  E.host.castOwner = "buff";
  assert.equal(E.reg.call("actiontrycastbyid", 2931), 1);
  assert.equal(castCalls(E.host).length, 0);
  E.host.castOwner = null;
  assert.equal(E.reg.call("actiontrycastbyid", 2931), 0);
});

await check("castById without spell records: only the given target (CastSpellAt), else 2 — never untargeted", () => {
  const E = env();
  E.host.hasRecords = false;
  assert.equal(E.actions.castById(2931, null), 2, "SelfTargeted cannot be known → no target → impossible");
  assert.deepEqual(castCalls(E.host), []);
  assert.equal(E.actions.castById(1, 0x80000104), 0);
  assert.deepEqual(castCalls(E.host), [["CastSpellAt", 0x80000104, 1]]);
  // a refused send releases the cast token
  const F = env({ hostOver: { CastSelf: () => false } });
  assert.equal(F.actions.castById(2931), 2);
  assert.equal(F.host.castOwner, null);
});

// ── settings (P) ─────────────────────────────────────────────────────────────
await check("settings functions use VtOptions (VT units) and the meta bag for unknown names", () => {
  const E = env();
  assert.equal(E.reg.call("vtgetsetting", "AttackDistance"), 40 / 240);
  assert.deepEqual(E.options.calls.at(-1), ["get", "AttackDistance", { vtUnits: true }]);
  assert.equal(E.reg.call("vtsetsetting", "EnableNav", true), 1);
  assert.deepEqual(E.options.calls.at(-1), ["set", "EnableNav", true, { source: "meta" }]);
  assert.equal(E.reg.call("vtankgetsetting", "EnableNav"), true);
  assert.equal(E.reg.call("ragetsetting", "enablecombat"), true);
  assert.equal(E.reg.call("rasetsetting", "EnableCombat", "false"), 1);
  // unknown → bag (one warning), read back by every getter
  assert.equal(E.reg.call("uboptset", "MyFlag", 7), 1);
  assert.equal(E.options.bagMap.get("myflag"), 7);
  assert.equal(E.reg.call("raoptget", "MyFlag"), 7);
  assert.equal(E.reg.call("uboptget", "myflag"), 7);
  assert.equal(E.reg.call("raoptset", "MyFlag", VAL.list([1])), 1, "non-scalar written as text");
  assert.equal(E.options.bagMap.get("myflag"), "[1]");
  assert.equal(E.logs.filter((m) => /MyFlag/.test(m)).length, 1, "one warning per unknown name");
  assert.equal(E.reg.call("vtgetsetting", "NeverSet"), "");
});

// ── chat ─────────────────────────────────────────────────────────────────────
await check("chatbox routes to runChat (local chain first); echo prints locally with a mapped category", () => {
  const E = env();
  assert.equal(E.reg.call("chatbox", "/vt opt set enablenav true"), "/vt opt set enablenav true");
  assert.equal(E.reg.call("chatbox", "/t Bob, hi"), "/t Bob, hi");
  assert.deepEqual(E.chat, ["/vt opt set enablenav true", "/t Bob, hi"]);
  assert.equal(E.reg.call("echo", "--- hello", 2), 1);
  assert.equal(E.reg.call("echo", "help line", 15), 1);
  assert.equal(E.reg.call("echo", "plain"), 1);
  assert.deepEqual(E.printed, [{ text: "--- hello", cat: 1 }, { text: "help line", cat: 11 }, { text: "plain", cat: 0 }]);
  assert.equal(chatCategoryForType(7), 7);
  assert.equal(chatCategoryForType(99), 0);
  // no runChat → an explicit unsupported error, never a direct send
  const reg = fakeRegistry();
  registerHostFunctions(reg, { host: fakeHost(), log: () => {} });
  assert.deepEqual(reg.call("chatbox", "/vt echo x"), { t: "err", msg: "unsupported: chatbox" });
});

// ── unsupported ──────────────────────────────────────────────────────────────
await check("unimplementable functions return Err 'unsupported: <name>' with ONE warning each", () => {
  const E = env();
  for (const n of ["getgameyear", "getisday", "getaccounthash", "getworldname", "ustopen", "chatboxpaste", "actiontrygiveprofile", "creaturegetarmor", "componentname", "statushud"]) {
    assert.deepEqual(E.reg.call(n), { t: "err", msg: `unsupported: ${n}` }, n);
    E.reg.call(n);
  }
  assert.equal(E.logs.filter((m) => /getgameyear/.test(m)).length, 1);
  assert.deepEqual(E.reg.call("wobjectgetactivespellids", VAL.wobj(0x80000104)), { t: "err", msg: "unsupported: wobjectgetactivespellids" }, "monster enchantments are X");
  assert.deepEqual(E.reg.call("getheading", VAL.wobj(0x80000104)), { t: "err", msg: "unsupported: getheading" });
});

// ── character ────────────────────────────────────────────────────────────────
await check("character reads: props, vitals, skills, burden, cell, coordinates (z/240), vitae, heading", () => {
  const E = env();
  assert.equal(E.reg.call("getcharintprop", 25), 126);
  assert.equal(E.reg.call("getcharintprop", 999), 0);
  assert.equal(E.reg.call("getcharquadprop", 2), 3_500_000_000);
  assert.equal(E.reg.call("getcharstringprop", 1), "Mage Mary", "name falls back to the object name");
  assert.equal(E.reg.call("getcharstringprop", 5), "Adventurer");
  assert.equal(E.reg.call("getcharvital_current", 1), 150);
  assert.equal(E.reg.call("getcharvital_base", 2), 100);
  assert.equal(E.reg.call("getcharvital_buffedmax", 3), 250);
  assert.equal(E.reg.call("getcharskill_traininglevel", 34), 3);
  assert.equal(E.reg.call("getcharskill_buffed", 34), 300);
  assert.equal(E.reg.call("getcharattribute_base", 1), 100);
  assert.equal(E.reg.call("getcharburden"), 37);
  assert.equal(E.reg.call("getcharburden_total"), 4321);
  assert.equal(E.reg.call("getplayerlandcell"), 0xa9b40019);
  assert.equal(E.reg.call("getplayerlandblock"), 0xa9b40000);
  assert.equal(E.reg.call("getcellid"), "0xA9B40019");
  const c = E.reg.call("getplayercoordinates");
  assert.equal(c.t, "coords");
  assert.equal(c.z, 0.2);
  assert.ok(Math.abs(c.ew - ((0xa9 * 192 + 84) / 240 - 101.95)) < 1e-9);
  assert.equal(E.reg.call("vitae"), 5);
  assert.equal(E.reg.call("getheading", VAL.wobj(ME)), 123.5);
  assert.equal(E.reg.call("getisspellknown", 2931), 1);
  assert.equal(E.reg.call("getisspellknown", 5), 0);
  assert.equal(E.reg.call("getcancastspell_hunt", 27), 1);
  assert.equal(E.reg.call("getcombatstate"), "Magic");
  assert.equal(E.reg.call("getequippedweapontype"), "Wand");
  assert.equal(E.reg.call("getspellexpiration", 2), 1235);
  assert.equal(E.reg.call("getspellexpiration", 3000), 2147483647, "permanent");
  assert.equal(E.reg.call("getspellexpiration", 77), 0);
  assert.equal(E.reg.call("getspellexpirationbyname", "strength self"), 1235);
  assert.equal(E.reg.call("spellname", 2931), "Recall Aphus Lassel");
  assert.equal(E.reg.call("isportaling"), 0);
});

// ── world objects ────────────────────────────────────────────────────────────
await check("world finders: by name+class (regex), template type, class; inventory by name/rx/wcid; None when absent", () => {
  const E = env();
  assert.ok(isWobj(E.reg.call("wobjectfindnearestbynameandobjectclass", 37, "Fiun Rehlyun"), 0x80000101), "NPC = creature without the attackable flag");
  assert.ok(isWobj(E.reg.call("wobjectfindnearestbynameandobjectclass", 14, "Gateway"), 0x80000102));
  assert.ok(isWobj(E.reg.call("wobjectfindnearestbynameandobjectclass", 27, "Corpse of Sir Bellas"), 0x80000105));
  assert.ok(isWobj(E.reg.call("wobjectfindnearestbynameandobjectclass", 5, "Drudge"), 0x80000104));
  assert.equal(E.reg.call("wobjectfindnearestbynameandobjectclass", 24, "Nobody"), null, "not found = None");
  assert.ok(isWobj(E.reg.call("wobjectfindnearestbyobjectclass", 24), 0x50000042), "nearest player (not me)");
  assert.ok(isWobj(E.reg.call("wobjectfindnearestbytemplatetype", 44204), 0x80000102));
  assert.equal(E.reg.call("wobjectfindnearestbytemplatetype", 1234567), null);
  assert.ok(isWobj(E.reg.call("wobjectfindininventorybyname", "Insatiable Eater Jaw"), 0x70000004));
  assert.ok(isWobj(E.reg.call("wobjectfindininventorybynamerx", ".* Eater Jaw"), 0x70000004));
  assert.ok(isWobj(E.reg.call("wobjectfindininventorybytemplatetype", 34441), 0x70000004));
  assert.equal(E.reg.call("wobjectfindininventorybyname", "Nothing"), null);
  assert.equal(E.reg.call("wobjectfindallinventory").items.length, 7);
  assert.equal(E.reg.call("wobjectfindallinventorybytemplatetype", 273).items.length, 2);
  assert.ok(isWobj(E.reg.call("wobjectfindnearestdoor"), 0x7a000001));
  assert.ok(isWobj(E.reg.call("wobjectfindnearestmonster"), 0x80000104));
  assert.ok(isWobj(E.reg.call("wobjectfindbyid", 0x70000004), 0x70000004));
  assert.ok(isWobj(E.reg.call("wobjectfindbyid", "0x80000104"), 0x80000104));
  assert.equal(E.reg.call("wobjectfindbyid", 0x12345678), null);
  assert.equal(E.reg.call("wobjectfindallbycontainer", VAL.wobj(0x80000105)).items.length, 2);
});

await check("world getters: name, id, wcid, class, int/double props (incl. UB extended ids), coords, door, health, spells", () => {
  const E = env();
  const jaw = VAL.wobj(0x70000004, "Insatiable Eater Jaw");
  assert.equal(E.reg.call("wobjectgetname", jaw), "Insatiable Eater Jaw");
  assert.equal(E.reg.call("wobjectgetname", 0x80000104), "Drudge Skulker");
  assert.equal(E.reg.call("wobjectgetid", jaw), 0x70000004);
  assert.equal(E.reg.call("wobjectgettemplatetype", jaw), 34441);
  assert.equal(E.reg.call("wobjectgetintprop", jaw, 218103808), 34441, "UB TEMPLATE_TYPE");
  assert.equal(E.reg.call("wobjectgetintprop", jaw, 19), 500);
  assert.equal(E.reg.call("wobjectgetintprop", VAL.wobj(0x70000003), 218103810), 0x70000010, "Decal Container");
  assert.equal(E.reg.call("wobjectgetdoubleprop", jaw, 167772169), 7.5, "UB WORKMANSHIP → 280");
  assert.equal(E.reg.call("wobjectgetobjectclass", VAL.wobj(0x80000103)), OBJECT_CLASS.Vendor);
  assert.equal(E.reg.call("wobjectgetobjclass", VAL.wobj(0x70000005)), OBJECT_CLASS.WandStaffOrb);
  assert.equal(E.reg.call("wobjectgetisdooropen", VAL.wobj(0x7a000001)), 1);
  assert.equal(E.reg.call("wobjectgethealth", VAL.wobj(0x80000104)), 0.5);
  assert.equal(E.reg.call("wobjectgethealth", VAL.wobj(0x80000101)), -1);
  const pc = E.reg.call("wobjectgetphysicscoordinates", VAL.wobj(0x80000102));
  assert.equal(pc.t, "coords");
  assert.ok(Math.abs(pc.ns - ((0xb4 * 192 + 30) / 240 - 101.95)) < 1e-9);
  assert.deepEqual(E.reg.call("wobjectgetspellids", VAL.wobj(0x70000005)).items, [1, 2, 27], "high bit stripped");
  assert.deepEqual(E.reg.call("wobjectgetactivespellids", VAL.wobj(0x70000005)).items, [27], "item: enchantment (high-bit) entries");
  assert.deepEqual(E.reg.call("wobjectgetactivespelldurations", VAL.wobj(0x70000005)).items, [-1]);
  assert.deepEqual(E.reg.call("wobjectgetactivespellids", VAL.wobj(ME)).items, [2, 3000], "player: live enchantments, cooldowns skipped");
  assert.ok(isWobj(E.reg.call("wobjectgetplayer"), ME));
  assert.ok(isWobj(E.reg.call("wobjectgetopencontainer"), 0x80000105));
  assert.equal(E.reg.call("wobjectgetselection"), null);
  E.host.selected = 0x80000104;
  assert.ok(isWobj(E.reg.call("wobjectgetselection"), 0x80000104));
  assert.equal(E.reg.call("wobjecthasdata", VAL.wobj(0x70000005)), 1);
  assert.equal(E.reg.call("wobjectrequestdata", VAL.wobj(0x70000005)), 1);
  assert.equal(E.reg.call("wobjectisvalid", VAL.wobj(0x70000004)), 1);
  assert.equal(E.reg.call("wobjectisvalid", 0), 0);
  const ht = E.reg.call("getheadingto", VAL.wobj(0x80000102));
  assert.ok(Math.abs(ht - 0) < 1e-9, `north → 0, got ${ht}`);
  assert.ok(Math.abs(E.reg.call("getheadingto", VAL.wobj(0x80000101)) - 90) < 1e-9, "east → 90");
});

await check("inventory counts are stack-aware; pack room", () => {
  const E = env();
  assert.equal(E.reg.call("getitemcountininventorybyname", "pyreal"), 35);
  assert.equal(E.reg.call("getitemcountininventorybynamerx", "^Pyr"), 35);
  assert.equal(E.reg.call("getinventorycountbytemplatetype", 273), 35);
  assert.equal(E.reg.call("getitemcountininventorybyname", "Nope"), 0);
  assert.equal(E.reg.call("getfreeitemslots"), 72);
  assert.equal(E.reg.call("getfreeitemslots", VAL.wobj(0x70000010)), 23);
  assert.equal(E.reg.call("getfreecontainerslots"), 6);
  assert.equal(E.reg.call("getcontaineritemcount"), 30);
  assert.equal(E.reg.call("getfreeitemslots", VAL.wobj(0x12345)), -1);
});

await check("actions: use / apply / give (full stack) / select / equip-any-wand claim the item token", () => {
  const E = env();
  assert.equal(E.reg.call("actiontryuseitem", VAL.wobj(0x70000006)), 0);
  assert.deepEqual(E.host.calls.find((c) => c[0] === "UseObject"), ["UseObject", 0x70000006]);
  E.host.itemOwner = null;
  assert.equal(E.reg.call("actiontryapplyitem", VAL.wobj(0x70000001), VAL.wobj(ME)), 1);
  E.host.itemOwner = null;
  assert.equal(E.reg.call("actiontrygiveitem", VAL.wobj(0x70000002), VAL.wobj(0x80000101)), 1);
  assert.deepEqual(E.host.calls.find((c) => c[0] === "GiveObject"), ["GiveObject", 0x80000101, 0x70000002, 25], "GiveObject(target, item, amount)");
  E.host.itemOwner = "vtsupplies";
  assert.equal(E.reg.call("actiontryapplyitem", VAL.wobj(0x70000001), VAL.wobj(ME)), 0, "token held by another owner");
  assert.equal(E.reg.call("actiontryselect", VAL.wobj(0x80000104)), 0);
  assert.deepEqual(E.host.calls.find((c) => c[0] === "SelectObject"), ["SelectObject", 0x80000104]);
  assert.equal(E.reg.call("actiontryequipanywand"), 1, "a wand is already wielded");
  assert.ok(E.host.calls.filter((c) => c[0] === "tryClaimItemAction").every((c) => c[1] === "vtcmd"));
  assert.equal(E.reg.call("setcombatstate", "peace"), 1);
  assert.deepEqual(E.host.calls.at(-1), ["ChangeCombatMode", 1]);
  assert.equal(E.reg.call("getbusystate"), 0);
});

await check("setmotion / getmotion / clearmotion drive SetMovementInput", () => {
  const E = env();
  assert.equal(E.reg.call("setmotion", "Forward", 1), 1);
  assert.deepEqual(E.host.calls.at(-1), ["SetMovementInput", 1, 0, 0, true]);
  E.reg.call("setmotion", "StrafeLeft", 1);
  E.reg.call("setmotion", "Walk", 1);
  assert.deepEqual(E.host.calls.at(-1), ["SetMovementInput", 1, -1, 0, false]);
  assert.equal(E.reg.call("getmotion", "forward"), 1);
  assert.equal(E.reg.call("getmotion", "TurnLeft"), 0);
  assert.equal(E.reg.call("setmotion", "Fly", 1), 0);
  E.reg.call("clearmotion");
  assert.deepEqual(E.host.calls.at(-1), ["SetMovementInput", 0, 0, 0, true]);
});

await check("fellowship functions read TryGetFellowshipInfo", () => {
  const E = env();
  assert.equal(E.reg.call("getfellowshipname"), "Hunters");
  assert.equal(E.reg.call("getfellowshipcount"), 2);
  assert.equal(E.reg.call("getfellowshipstatus"), 1);
  assert.equal(E.reg.call("getfellowshipisleader"), 1);
  assert.equal(E.reg.call("getfellowshipcanrecruit"), 1);
  assert.equal(E.reg.call("getfellowshipisfull"), 0);
  assert.deepEqual(E.reg.call("getfellownames").items, ["Bob", "Mage Mary"]);
  assert.deepEqual(E.reg.call("getfellowids").items, [0x50000001, 0x50000042]);
  assert.equal(E.reg.call("getfellowname", 1), "Bob");
  E.host.fellowship = { ...E.host.fellowship, leaderGuid: 0x50000042, open: false };
  assert.equal(E.reg.call("getfellowshipstatus"), 2);
  assert.equal(E.reg.call("getfellowshipcanrecruit"), 0);
  E.host.fellowship = null;
  assert.equal(E.reg.call("getfellowshipstatus"), 0);
  assert.equal(E.reg.call("getfellowshipname"), "");
});

await check("creature functions use the learned profiles by wcid", () => {
  const E = env();
  const drudge = VAL.wobj(0x80000104, "Drudge Skulker");
  assert.equal(E.reg.call("creaturegetmaxhealth", drudge), 85);
  assert.equal(E.reg.call("creaturegetresist", drudge, "fire"), 0.5);
  assert.equal(E.reg.call("creaturegetresist", drudge, "electric"), 1);
  assert.equal(E.reg.call("creaturegetresist", drudge, "nonsense"), 1);
  assert.equal(E.reg.call("creaturegetweakest", drudge), "Fire");
  assert.equal(E.reg.call("creaturehasprofile", "Drudge Skulker"), 1, "by name");
  assert.equal(E.reg.call("creaturehasprofile", VAL.wobj(0x80000101)), 0);
});

// ── quests (M) ───────────────────────────────────────────────────────────────
await check("QuestTracker parses /myquests lines and computes ready / flags / kill tasks", () => {
  assert.deepEqual(parseQuestLine('blankaug - 1 solves (1609459200)"Blank Aug" 1 0'), {
    key: "blankaug", solves: 1, maxSolves: 1, completedOnS: 1609459200, repeatS: 0, description: "Blank Aug",
  });
  assert.equal(parseQuestLine("Quest list is empty."), null);
  const signals = new Map();
  const subscribe = (type, fn) => {
    signals.set(type, fn);
    return () => signals.delete(type);
  };
  let t = 1_700_000_000_000;
  const sent = [];
  const q = new QuestTracker({ subscribe, runChat: (l) => sent.push(l), now: () => t });
  assert.equal(q.status("anything"), 1, "unknown = ready");
  assert.equal(q.refresh(), true);
  assert.deepEqual(sent, ["/myquests"]);
  assert.equal(q.isRefreshing(), true);
  assert.equal(q.refresh(), false, "no second /myquests while refreshing");
  const nowS = Math.floor(t / 1000);
  const say = (text) => signals.get("chat")({ type: "chat", text, chatType: 0, cat: 0 });
  say('blankaug - 1 solves (1609459200)"Blank Aug" 1 0');
  say(`dailyhunt - 3 solves (${nowS - 3600})"Daily Hunt" -1 72000`);
  say(`weeklyboss - 2 solves (${nowS - 700000})"Weekly" -1 604800`);
  say(`killtask_drudges - 37 solves (${nowS - 10})"Kill 50 drudges" 50 0`);
  say("You say, \"not a quest line\"");
  t += 999;
  assert.equal(q.isRefreshing(), true);
  t += 1;
  assert.equal(q.isRefreshing(), false, "1 s of silence ends the refresh");
  assert.equal(q.testFlag("BlankAug"), true);
  assert.equal(q.testFlag("missing"), false);
  assert.equal(q.status("blankaug"), 0, "once-only flag is never ready again");
  assert.equal(q.status("dailyhunt"), 0, "repeat timer still running");
  assert.equal(q.status("weeklyboss"), 1, "timer expired");
  assert.equal(q.ktProgress("killtask_drudges"), 37);
  assert.equal(q.ktRequired("killtask_drudges"), 50);
  assert.equal(q.ktProgress("missing"), 0);
  // an empty list ends at once; no line at all ends after 15 s
  q.refresh();
  say("Quest list is empty.");
  assert.equal(q.isRefreshing(), false);
  q.refresh();
  t += 14_999;
  assert.equal(q.isRefreshing(), true);
  t += 1;
  assert.equal(q.isRefreshing(), false);
  q.dispose();
  assert.equal(signals.has("chat"), false, "dispose unsubscribes");
  assert.equal(questReady({ completedOnS: 0, repeatS: 0, maxSolves: -1, solves: 9 }, t), true);
});

await check("quest host functions go through the tracker", () => {
  const E = env();
  assert.equal(E.reg.call("refreshquests"), 1);
  assert.deepEqual(E.chat, ["/myquests"]);
  assert.equal(E.reg.call("isrefreshingquests"), 1);
  E.quests.onChatLine('oraclelumina - 1 solves (1609459200)"Lum" 1 0');
  E.quests.onChatLine("killtask_x - 4 solves (1609459200)\"Kill 10\" 10 0");
  E.T.now += 2000;
  assert.equal(E.reg.call("isrefreshingquests"), 0);
  assert.equal(E.reg.call("testquestflag", "OracleLumina"), 1);
  assert.equal(E.reg.call("getqueststatus", "oraclelumina"), 0);
  assert.equal(E.reg.call("getqueststatus", "unknown"), 1);
  assert.equal(E.reg.call("getquestktprogress", "killtask_x"), 4);
  assert.equal(E.reg.call("getquestktrequired", "killtask_x"), 10);
});

// ── VtActions helpers ────────────────────────────────────────────────────────
await check("createVtActions: name finders, class filter, loot from the open container, give order", () => {
  const E = env();
  const a = E.actions;
  assert.equal(a.findNearestByName("bob").guid, 0x50000042);
  assert.equal(a.findNearestByName("bellas", { partial: true }).guid, 0x80000105);
  assert.equal(a.findNearestByName("Gate", { partial: true, objectClass: 14 }).guid, 0x80000102);
  assert.equal(a.findNearestByName("Gate", { partial: true, objectClass: 26 }), null);
  assert.equal(a.findNearestByName("^drudge", { regex: true }).guid, 0x80000104);
  assert.equal(a.findInventoryByName("pyreal").length, 2);
  assert.equal(a.inventoryCount("pyreal"), 35);
  const objs = { 0x70000101: "Brood Matron Jaw", 0x70000102: "Pyreal" };
  const L = env({ hostOver: { TryGetObjectName: (g) => objs[g] ?? null } });
  const r = L.actions.lootFromOpen("Brood");
  assert.equal(r.ok, true);
  assert.deepEqual(L.host.calls.find((c) => c[0] === "TakeObject"), ["TakeObject", 0x70000101]);
  const n = env({ hostOver: { GetGroundContainerId: () => 0 } });
  assert.deepEqual(n.actions.lootFromOpen("x"), { ok: false, error: "no container is open", retry: true });
  assert.equal(a.face(-90).headingDeg, 270);
  assert.deepEqual(E.host.calls.at(-1), ["TurnToCompassHeading", 270]);
  assert.equal(a.setCombatState("dance").ok, false);
  assert.equal(a.use(0).ok, false);
});

await check("objectClassFrom matches the VTank/Decal classes", () => {
  const C = OBJECT_CLASS;
  assert.equal(objectClassFrom(0x10, 0x10), C.Monster);
  assert.equal(objectClassFrom(0x10, 0x0), C.Npc);
  assert.equal(objectClassFrom(0x10, 0x8), C.Player);
  assert.equal(objectClassFrom(0x10, 0x200), C.Vendor);
  assert.equal(objectClassFrom(0x10000, 0x40000), C.Portal);
  assert.equal(objectClassFrom(0x80, 0x1000), C.Door);
  assert.equal(objectClassFrom(0x200, 0x2000), C.Corpse);
  assert.equal(objectClassFrom(0x8000, 0), C.WandStaffOrb);
  assert.equal(objectClassFrom(0x1, 0), C.MeleeWeapon);
  assert.equal(objectClassFrom(0x100, 0), C.MissileWeapon);
  assert.equal(objectClassFrom(0x80000, 0), C.ManaStone);
  assert.equal(objectClassFrom(0x800, 0), C.Gem);
  assert.equal(objectClassFrom(0, 0x4000), C.Lifestone);
  assert.equal(objectClassFrom(0, 0x800000), C.Foci);
  assert.equal(objectClassFrom(0, 0), C.Unknown);
});

await check("value helpers: guid forms, string/type views", () => {
  assert.equal(guidOfValue(VAL.wobj(0x80000104, "X")), 0x80000104);
  assert.equal(guidOfValue("[WorldObject] 0x80000104: Drudge"), 0x80000104);
  assert.equal(guidOfValue("0x7A000001"), 0x7a000001);
  assert.equal(guidOfValue(2147483905), 0x80000101);
  assert.equal(guidOfValue("-2147483391"), 0x80000101);
  assert.equal(guidOfValue(""), 0);
  assert.equal(guidOfValue(null), 0);
  assert.equal(guidOfValue("Drudge"), 0);
  assert.equal(valueToString(VAL.wobj(0x80000104, "Drudge")), "[WorldObject] 0x80000104: Drudge");
  assert.equal(valueToString(VAL.list([1, "a", true])), "[1,a,1]");
  assert.equal(valueToString(VAL.coords(-12.3, 41.5, 0.2)), "12.30S, 41.50E, 0.20Z");
  assert.equal(valueToString(1e21), "1E+21");
  assert.equal(valueTypeName(null), "None");
  assert.equal(valueTypeName(VAL.wobj(1)), "WorldObject");
  assert.equal(valueTypeName({ t: "err", msg: "x" }), "Error");
});

await check("never throws: a host whose members throw degrades to defaults", () => {
  const boom = () => {
    throw new Error("wasm gone");
  };
  const reg = fakeRegistry();
  const logs = [];
  const h = new Proxy({}, { get: (_, k) => (k === "then" ? undefined : boom) });
  registerHostFunctions(reg, { host: h, log: (m) => logs.push(m), print: () => {}, runChat: () => {} });
  for (const name of HOST_FUNCTION_NAMES) {
    let v;
    assert.doesNotThrow(() => {
      v = reg.call(name, VAL.wobj(0x80000104), 1);
    }, name);
    assert.notEqual(v, undefined, name);
  }
});

// ── source discipline (C1, C2, C4, C6, C7) ──────────────────────────────────
await check("source scan: no forbidden cast/chat strings, timers, DOM, or imports outside cmd/", () => {
  const files = fs.readdirSync(CMD_DIR).filter((f) => f.endsWith(".js"));
  assert.deepEqual(files.sort(), ["actions_lib.js", "compat_commands.js", "coords.js", "index.js", "quests.js", "rs_commands.js", "stdlib_host.js"]);
  for (const f of files) {
    const src = fs.readFileSync(path.join(CMD_DIR, f), "utf8");
    for (const bad of ["CastSpell(", "CastUntargetedSpell(", "castTargetedSpell", "castUntargetedSpell", "setTimeout", "setInterval", "requestAnimationFrame", "document.", "localStorage"]) {
      assert.equal(src.includes(bad), false, `${f} contains ${bad}`);
    }
    assert.doesNotMatch(src, /\bWriteToChat\b(?!Window)/, `${f} mentions the server-sending chat member`);
    assert.doesNotMatch(src, /\bwindow\b|\bglobalThis\b/, `${f} touches the page globals`);
    for (const m of src.matchAll(/^\s*(?:import|export)\s[^;]*?from\s+["']([^"']+)["']/gm)) {
      assert.match(m[1], /^\.\/[a-z_]+\.js$/, `${f} imports ${m[1]}`);
    }
    assert.doesNotMatch(src, /\bimport\s*\(/, `${f} uses a dynamic import`);
  }
});

console.log(fail === 0 ? `rynth_vt_host_fns: all ${pass} checks passed` : `rynth_vt_host_fns: ${fail} FAILED (${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);
