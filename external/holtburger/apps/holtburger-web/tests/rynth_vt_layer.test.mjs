// tests/rynth_vt_layer.test.mjs — the VTank layer composition root (PLAN INT-2,
// §3.15; §4.5 profile application; T-S1; V-2, V-5, V-7, V-9, V-14).
//
// A fake bot (loops as plain objects with today's fields) and a recording fake
// host drive the REAL rynth/vt modules wired by rynth/vt/index.js:
//   * Default profile: combat.vt null, every aux slot / idle hook disabled,
//     options read the live loop fields (no shadow copy), and 200 pre/post
//     ticks make NO host action call and write NOTHING to storage;
//   * a user profile's first attach pushes legacy keys except the URL pins;
//     a takeover rebind does not; a HUD restart under a user profile does
//     (SET review §8.1);
//   * nav index, meta state, session vars, the Default overlay and the
//     planner's SwitchWandsToDebuff pre-swap loadout survive a dispose + a new
//     layer on the same page session (D6; review runtime-3); another
//     character on the same page gets its own planner state (no leak);
//   * nav reversal / waypoint results reach the meta-visible session vars
//     navreversed / navlastresult (R22, R9; review guide-3);
//   * rs_entry.route dispatches synchronously, never sends chat, never echoes
//     twice; the bot-less page dispatcher serves `opt` from the session;
//   * dispose is idempotent and hands every hook back (combat.vt,
//     acquireRangeFn, loot.classify, item buffs, aux slots, unwedge gate);
//   * T-S1: no forbidden cast/chat member name in rynth/vt/** or
//     plugins/rynth-vt/**;
//   * the glue contracts (MetaContext, HostFnContext, the local chat chain,
//     the .utl item context incl. Decal synthetic keys) and the authorized
//     GetSelectedItemId fix (most recent selection wins).
//
// Run from apps/holtburger-web/:  node tests/rynth_vt_layer.test.mjs

import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HW = path.resolve(HERE, "..");

const VT = await import("../rynth/vt/index.js");
const RS = await import("../rynth/vt/rs_entry.js");
const SET = await import("../rynth/vt/settings/index.js");
const CMB = await import("../rynth/vt/combat/index.js");
const LOOT = await import("../rynth/vt/glue/loot_ctx.js");
const { RynthWebHost } = await import("../rynth/webhost.js");

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

const quiet = () => {};
const ME = 0x50000001;
const LB = 0xa9b40015 >>> 0;

// Host members that ACT on the game (or claim a token that gates an action).
const ACTIONS = new Set([
  "CastSpell", "CastSpellAt", "CastSelf", "CastUntargetedSafe", "CastUntargetedSpell", "UseObject", "UseItemOnTarget",
  "GiveObject", "TakeObject", "MoveToPosition", "PursueObject", "StickToObject", "StopStick", "StopCompletely",
  "MeleeAttack", "MissileAttack", "ChangeCombatMode", "ToggleCombatMode", "WriteToChat", "InvokeChatParser", "SendTell",
  "RequestId", "MoveItemToContainer", "MergeStacks", "SplitStack", "SplitStackToContainer", "WieldItem", "UnwieldItem",
  "DropItem", "TurnToHeading", "TurnToCompassHeading", "TurnToObject", "Jump", "SetMovementInput", "SelectObject",
  "RecallToLifestone", "RecallAllegianceHometown", "FellowshipCreate", "FellowshipQuit", "FellowshipRecruit",
  "FellowshipDismiss", "FellowshipSetOpen", "FellowshipAssignLeader", "QueryHealth", "CancelAttack", "SetAutoRun",
  "CloseContainer", "BuyFromVendor", "SellToVendor", "tryClaimItemAction", "tryClaimCast", "TryGetCreatureInfo",
]);

/** A recording fake RynthWebHost: reads answer from W, every call is logged. */
function makeHost({ guid = ME, inv = [], known = [], nearby = [], ents = {} } = {}) {
  const W = { seq: 1, calls: [], subs: [], ticks: [], pose: { objCellId: LB, x: 100, y: 100, z: 0, heading: 0 }, inv, known, nearby, ents, busy: 0, ground: 0, portal: false };
  const base = {
    get snap() {
      return { seq: W.seq };
    },
    nearbyRangeM: 60,
    s: { playerGuid: () => guid },
    has: (c) => c === "IsPortalSpaceActive",
    GetPlayerId: () => guid,
    TryGetObjectName: (g) => (g === guid ? "Tester" : W.ents[g]?.name ?? null),
    TryGetObjectWcid: (g) => W.ents[g]?.wcid ?? null,
    TryGetPlayerPose: () => ({ ...W.pose }),
    IsPortalSpaceActive: () => W.portal,
    NearbyGuids: () => W.nearby.slice(),
    GetBusyState: () => W.busy,
    GetGroundContainerId: () => W.ground,
    TryGetKnownSpells: () => W.known.slice(),
    TryGetPlayerInventory: () => W.inv.map((r) => ({ ...r })),
    TryGetPlayerInventoryCached: () => W.inv.map((r) => ({ ...r })),
    TryGetPackRoomCached: () => ({ main: { used: 10, cap: 102, free: 92 } }),
    TryGetBurden: () => 42,
    TryGetSelfEnchantments: () => [],
    TryGetObjectIntProperty: (g, s) => W.ents[g]?.ints?.[s] ?? (s === 1 && W.ents[g]?.creature ? 16 : undefined),
    TryGetObjectDoubleProperty: (g, s) => W.ents[g]?.floats?.[s],
    TryGetObjectStringProperty: () => undefined,
    TryGetObjectBoolProperty: () => undefined,
    TryGetObjectDataIdProperty: () => undefined,
    TryGetObjectDescFlags: () => 0,
    TryGetObjectInstanceIdProperty: () => undefined,
    TryGetObjectDistance: (g) => W.ents[g]?.dist ?? null,
    TryGetTargetHealthFraction: (g) => W.ents[g]?.hf ?? -1,
    ObjectIsAttackable: (g) => W.ents[g]?.attackable !== false,
    ObjectIsPlayer: () => false,
    HasAppraisalData: (g) => W.ents[g]?.appraised === true,
    TryGetObjectAppraisal: (g) => W.ents[g]?.appraisal ?? null,
    TryGetPlayerStats: () => ({ level: 50, skills: { 34: { current: 200, base: 150 } } }),
    get itemActionToken() {
      return null;
    },
    onEvent: (fn) => W.subs.push(fn),
    onTick: (fn) => W.ticks.push(fn),
    WriteToChatWindow: () => false,
  };
  for (const n of ACTIONS) if (!(n in base)) base[n] = () => true;
  const host = new Proxy(base, {
    get(t, p, r) {
      const v = Reflect.get(t, p, r);
      if (typeof v !== "function" || typeof p !== "string") return v;
      return (...a) => {
        W.calls.push(p);
        return v.apply(t, a);
      };
    },
  });
  W.emit = (e) => W.subs.forEach((fn) => fn(e));
  return { host, W };
}

/** A fake createGrindBot() object: the loop fields today's code has. */
function makeBot({ host } = {}) {
  const claims = new Set();
  const enables = [];
  const bot = {
    host,
    kernel: { action: "Idle", operatorHeld: false, running: true, aux: VT.createAuxShell() },
    combat: {
      enabled: true, monsterRangeM: 40, priorities: {}, meleePower: 0.6, missileAccuracy: 0.6, attackHeight: 2,
      blacklistAttempts: 3, blacklistTimeoutMs: 30_000, vt: null, acquireRangeFn: null, invalidations: 0,
      invalidateScan() { this.invalidations++; }, underAttack: () => false, disengage() {},
    },
    vitals: {
      enabled: true,
      cfg: { healAtCombat: 60, getManaAtCombat: 40, restamAtCombat: 30, topOffHp: 95, topOffStam: 95, topOffMana: 95, emergencyHp: 30, emergencyStamFloor: 20, manaRechargeStamFloor: 15 },
    },
    loot: { enabled: true, state: "SCAN", minValue: 0, corpseRangeM: 30, classify: null },
    buff: {
      enabled: true, rebuffSecondsRemaining: 300, idleRebuffWindowS: 0, itemBuffs: [], setCalls: 0,
      setItemBuffs(l) { this.itemBuffs = l.slice(); this.setCalls++; return l.length; },
      needsBuff: () => false, desired: [], pending: null, status: { desired: 0, active: 0, ready: true },
    },
    router: { status: { state: "IDLE" }, route: [], follow(legs) { this.route = legs; this.status = { state: "WALK" }; }, cancel() { this.status = { state: "IDLE" }; } },
    unwedge: { allowEscalation: null, active: () => false },
    buffSpec: null,
    setBuffs: async (spec) => { bot.buffSpec = spec; return []; },
    claimMovement: (tag) => { const t = { tag }; claims.add(t); return () => claims.delete(t); },
    movementClaimed: () => claims.size > 0,
    control: { setEnabled(name, on) { enables.push([name, on]); const loop = bot[name]; if (loop) loop.enabled = !!on; return { ok: true }; } },
    enables,
  };
  return bot;
}

/** A Map-backed localStorage that records every write. */
function spyStorage(init = {}) {
  const m = new Map(Object.entries(init));
  const writes = [];
  return {
    m,
    writes,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { writes.push(k); m.set(k, String(v)); },
    removeItem: (k) => { writes.push(`-${k}`); m.delete(k); },
    key: (i) => [...m.keys()][i] ?? null,
    get length() { return m.size; },
  };
}

async function layerOn(bot, opts = {}) {
  const win = opts.win || { localStorage: opts.storage ?? null };
  const layer = await VT.createVtLayer(bot, { aux: bot.kernel.aux, win, storage: opts.storage, log: quiet, now: opts.now, print: opts.print || quiet });
  return { layer, win };
}

// ── composition & Default inertness ─────────────────────────────────────────

await check("createAuxShell: empty shell; status() lists only enabled slots/hooks", () => {
  const a = VT.createAuxShell();
  assert.deepEqual(a.slots, []);
  assert.deepEqual(a.idleHooks, []);
  assert.equal(a.policy.boostLoot(), false);
  a.slots.push({ name: "X", rank: "beforeIdle", enabled: () => false }, { name: "Y", rank: () => "beforeCombat", enabled: () => true, pinned: () => true, status: { a: 1 } });
  a.idleHooks.push({ name: "H1", enabled: () => true }, { name: "H2", enabled: () => false });
  const st = a.status();
  assert.deepEqual(st.slots, [{ name: "Y", rank: "beforeCombat", pinned: true, status: { a: 1 } }]);
  assert.deepEqual(st.idleHooks, ["H1"]);
});

await check("Default profile: planner detached, acquireRangeFn set (identity), every aux slot and idle hook disabled, §3.13 order", async () => {
  const { host } = makeHost();
  const bot = makeBot({ host });
  const { layer } = await layerOn(bot);
  try {
    assert.equal(bot.combat.vt, null, "combat.vt null at Default");
    assert.equal(typeof bot.combat.acquireRangeFn, "function", "acquireRangeFn always set (critic G9)");
    assert.equal(bot.combat.acquireRangeFn(40), 40);
    assert.equal(bot.combat.acquireRangeFn(17.5), 17.5);
    const aux = bot.kernel.aux;
    assert.deepEqual(aux.slots.map((s) => s.name), ["Supplies", "JumpNow", "Pets", "Doors", "Navigate", "BuffItems", "IdleRebuff"]);
    for (const s of aux.slots) assert.equal(s.enabled(), false, `${s.name}.enabled() at Default`);
    assert.deepEqual(aux.idleHooks.map((h) => h.name), ["PeaceMode"]);
    for (const h of aux.idleHooks) assert.equal(h.enabled(), false, `${h.name}.enabled() at Default`);
    assert.equal(aux.policy.boostLoot(), false);
    assert.equal(aux.policy.pinnedFirst(), false, "nothing in flight at Default ⇒ the plan-literal ladder");
    assert.equal(bot.unwedge.allowEscalation(), true, "no VT route ⇒ unwedge escalates as today");
    assert.equal(bot.loot.classify, null, "no loot profile ⇒ the Value floor");
    assert.equal(bot.buff.setCalls, 0, "an empty Items list never touches the B7 list");
    assert.equal(layer.statusLine(), "VT · profile Default");
    assert.equal(host.nearbyRangeM, 60, "nearbyRangeM untouched at defaults");
    for (const k of ["session", "options", "profiles", "signals", "expr", "vars", "functions", "monsters", "items", "consumables", "planner", "ledger", "creatures", "nav", "navProfiles", "meta", "views", "loot", "library", "support", "rs", "actions", "quests", "preTick", "postTick", "statusLine", "dispose", "parseExpr", "monsterVariables"]) {
      assert.ok(layer[k] !== undefined && layer[k] !== null, `layer.${k}`);
    }
  } finally {
    layer.dispose();
  }
});

await check("Default profile: options read the LIVE loop fields (no shadow copy); snapshot holds only drift from the defaults", async () => {
  const { host } = makeHost();
  const bot = makeBot({ host });
  const { layer } = await layerOn(bot);
  try {
    const o = layer.options;
    assert.equal(o.getValue("MonsterRange"), bot.combat.monsterRangeM);
    assert.equal(o.getValue("HealAt"), bot.vitals.cfg.healAtCombat);
    assert.equal(o.getValue("TopOffStam"), bot.vitals.cfg.topOffStam);
    assert.equal(o.getValue("LootMinValue"), bot.loot.minValue);
    assert.equal(o.getValue("CorpseApproachRangeMax"), bot.loot.corpseRangeM);
    assert.equal(o.getValue("RebuffSecondsRemaining"), bot.buff.rebuffSecondsRemaining);
    assert.equal(o.getValue("MeleeAttackPower"), bot.combat.meleePower);
    assert.equal(o.getValue("BlacklistTimeoutSec"), bot.combat.blacklistTimeoutMs / 1000);
    assert.equal(o.getValue("EnableCombat"), true);
    assert.deepEqual(o.snapshot().settings, {}, "nothing differs from the defaults");
    // a director / HUD write lands in the loop field — the option sees it at once
    bot.vitals.cfg.healAtCombat = 72;
    bot.loot.minValue = 250;
    assert.equal(o.getValue("HealAt"), 72);
    assert.deepEqual(o.snapshot().settings, { HealAt: 72, LootMinValue: 250 });
    // and an option write lands in the loop field
    assert.equal(o.set("MonsterRange", 30, { source: "ui" }).ok, true);
    assert.equal(bot.combat.monsterRangeM, 30);
    assert.ok(bot.combat.invalidations > 0, "MonsterRange re-scans");
  } finally {
    layer.dispose();
  }
});

await check("Default profile: 200 pre/post ticks across kernel actions make NO host action call and write nothing to storage (V-2, V-5)", async () => {
  const { host, W } = makeHost({ nearby: [0x80000101], ents: { [0x80000101]: { name: "Drudge", creature: true, dist: 12, hf: 1 } } });
  const bot = makeBot({ host });
  const storage = spyStorage();
  const { layer } = await layerOn(bot, { storage, win: { localStorage: storage } });
  try {
    assert.equal(W.ticks.length, 1, "createVtLayer registers exactly one host.onTick closure (the post-tick)");
    assert.equal(W.subs.length, 1, "exactly one host.onEvent subscription (host_signals)");
    const writesAtAttach = storage.writes.length;
    W.calls.length = 0;
    const acts = ["Idle", "Combat", "Loot", "Idle", "Buffing", "Vitals", "Idle"];
    let now = 1_000_000;
    for (let i = 0; i < 200; i++) {
      now += 100;
      W.seq++;
      bot.kernel.action = acts[i % acts.length];
      if (i === 50) W.emit({ kind: 2, text: "You say, \"hello\"", u32: 0, u32b: 0 });
      if (i === 60) W.emit({ kind: 2, text: 'Someone tells you, "xp"', u32: 3, u32b: 2 });
      if (i === 70) W.emit({ kind: 29, text: "Drudge has been slain", u32: 0x80000101, u32b: ME });
      layer.preTick(now);
      W.ticks[0]();
    }
    const acted = W.calls.filter((n) => ACTIONS.has(n));
    assert.deepEqual(acted, [], `host actions at Default: ${[...new Set(acted)].join(", ")}`);
    assert.equal(storage.writes.length, writesAtAttach, `storage writes at Default: ${storage.writes.slice(writesAtAttach).join(", ")}`);
    assert.equal(writesAtAttach, 0, `nothing written at attach either: ${storage.writes.join(", ")}`);
    // the enchantment book (TryGetSelfEnchantments stamps receivedAt on first
    // sight) is read only while something consumes it — never at Default
    assert.equal(W.calls.filter((n) => n === "TryGetSelfEnchantments").length, 0, "no enchantment reads at Default");
    layer.options.set("UseDispelItems", true, { source: "ui" });
    for (let i = 0; i < 12; i++) {
      now += 100;
      layer.preTick(now);
    }
    assert.ok(W.calls.filter((n) => n === "TryGetSelfEnchantments").length >= 1, "an enchantment consumer keeps the book warm (1 Hz)");
  } finally {
    layer.dispose();
  }
});

await check("postTick (§3.3, V-22, SUP info): the inventory reflex acts only when Idle/Navigate, loot SCAN, not held, busy 0, no container", async () => {
  const STACK_A = 0x7100a001;
  const STACK_B = 0x7100a002;
  const row = (guid, stackSize) => ({ guid, name: "Pyreal Mote", wcid: 500, stackSize, maxStackSize: 100, containerId: 0, equipMask: 0, itemType: 0x80 });
  const { host, W } = makeHost({ inv: [row(STACK_A, 3), row(STACK_B, 5)] });
  const bot = makeBot({ host });
  const { layer } = await layerOn(bot);
  try {
    assert.equal(layer.options.set("EnableAutostack", true, { source: "ui" }).ok, true);
    const merges = () => W.calls.filter((n) => n === "MergeStacks").length;
    const post = (n = 10) => { for (let i = 0; i < n; i++) W.ticks[0](); };
    bot.kernel.action = "Combat";
    post();
    assert.equal(merges(), 0, "never while the kernel fights");
    bot.kernel.action = "Idle";
    bot.loot.state = "LOOT";
    post();
    assert.equal(merges(), 0, "never mid-loot (critic B4: a merge breaks loot CONFIRM)");
    bot.loot.state = "SCAN";
    bot.kernel.operatorHeld = true;
    post();
    assert.equal(merges(), 0, "never while operator-held (V-7)");
    bot.kernel.operatorHeld = false;
    W.busy = 1;
    post();
    assert.equal(merges(), 0, "never while busy");
    W.busy = 0;
    W.ground = 0x80001234;
    post();
    assert.equal(merges(), 0, "never with a container open");
    W.ground = 0;
    bot.kernel.action = "Navigate";
    post();
    assert.equal(merges(), 1, "Idle/Navigate + SCAN + free: the reflex stacks (the tick info carries kernelAction)");
  } finally {
    layer.dispose();
  }
});

await check("ManaChargesWhenOff: while held the pre-tick ticks ONLY the mana reflex ({held:true}); never without the option or when not held", async () => {
  const { host } = makeHost();
  const bot = makeBot({ host });
  const { layer } = await layerOn(bot);
  try {
    const seen = [];
    layer.support.manaStones.reflex.tick = (t, info) => { seen.push(info); };
    let t = 3_000_000;
    bot.kernel.operatorHeld = true;
    layer.preTick((t += 100));
    assert.equal(seen.length, 0, "held, option off ⇒ nothing");
    assert.equal(layer.options.set("ManaChargesWhenOff", true, { source: "ui" }).ok, true);
    layer.preTick((t += 100));
    assert.equal(seen.length, 1, "held + ManaChargesWhenOff ⇒ the mana reflex ticks");
    assert.equal(seen[0].held, true);
    assert.equal(seen[0].running, false);
    bot.kernel.operatorHeld = false;
    layer.preTick((t += 100));
    assert.equal(seen.length, 1, "not held ⇒ the pre-tick leaves the reflex to the gated post-tick");
  } finally {
    layer.dispose();
  }
});

await check("1 Hz syncCells: a replaced buff loop gets the profile-owned RebuffSecondsRemaining (SET §8.6)", async () => {
  const { host } = makeHost();
  const bot = makeBot({ host });
  const { layer } = await layerOn(bot);
  try {
    assert.equal(layer.options.set("RebuffSecondsRemaining", 600, { source: "ui" }).ok, true);
    assert.equal(bot.buff.rebuffSecondsRemaining, 600);
    // bot.setBuffs() builds a NEW loop (ctor default 300)
    bot.buff = { ...bot.buff, rebuffSecondsRemaining: 300, itemBuffs: [], setCalls: 0 };
    layer.preTick(4_000_000);
    assert.equal(bot.buff.rebuffSecondsRemaining, 600, "the 1 Hz rebind re-pushes the stored value");
  } finally {
    layer.dispose();
  }
});

await check("dispose unbinds the live cells: a later session write never reaches the retired bot's loops", async () => {
  const { host } = makeHost();
  const bot = makeBot({ host });
  const { layer } = await layerOn(bot);
  assert.equal(layer.options.set("HealAt", 70, { source: "ui" }).ok, true);
  assert.equal(bot.vitals.cfg.healAtCombat, 70, "bound: the write lands in the loop field");
  layer.dispose();
  assert.equal(layer.session.options.set("HealAt", 81, { source: "ui" }).ok, true, "the session outlives the bot (page dispatcher / HUD)");
  assert.equal(bot.vitals.cfg.healAtCombat, 70, "unbound after dispose");
  assert.equal(layer.session.options.storedValue("HealAt"), 81);
});

// ── profile application (§4.5) ──────────────────────────────────────────────

await check("a user profile's FIRST attach pushes legacy keys except URL pins; a takeover rebind does not", async () => {
  const storage = spyStorage();
  const win = { localStorage: storage, location: { search: "?bot=1&botBuffs=auto&botPersona=explorer" } };
  // the profile is made on this page before any bot exists (session API)
  const s = SET.getVtSession(win, String(ME), { storage, log: quiet });
  assert.equal(s.options.saveAs("Hunter").ok, true);
  for (const [k, v] of [["HealAt", 70], ["EnableLooting", false], ["EnableCombat", false], ["LootMinValue", 5000], ["AttackHeight", 3]]) {
    assert.equal(s.options.set(k, v, { source: "ui" }).ok, true, k);
  }
  assert.equal(s.options.setList("buffs", { spec: [2] }, { source: "ui" }).ok, true);
  assert.equal(s.options.setList("legacyPriorities", { drudge: 9 }, { source: "ui" }).ok, true);

  const { host: h1 } = makeHost();
  const b1 = makeBot({ host: h1 });
  const { layer: l1 } = await layerOn(b1, { storage, win });
  assert.equal(l1.firstAttach, true);
  assert.equal(b1.vitals.cfg.healAtCombat, 70, "legacy vitals pushed");
  assert.equal(b1.loot.minValue, 5000, "legacy loot floor pushed");
  assert.equal(b1.combat.attackHeight, 3, "attack height pushed");
  assert.deepEqual(b1.combat.priorities, { drudge: 9 }, "legacy priorities pushed");
  assert.equal(b1.loot.enabled, true, "EnableLooting is URL-pinned by botPersona=explorer");
  assert.equal(b1.combat.enabled, true, "EnableCombat is URL-pinned by botPersona=explorer");
  assert.equal(b1.buffSpec, null, "buffs are URL-pinned by botBuffs");
  l1.dispose();

  // takeover rebind: a fresh bot (carry-over owns legacy keys) — no legacy push
  const { host: h2 } = makeHost();
  const b2 = makeBot({ host: h2 });
  const { layer: l2 } = await layerOn(b2, { storage, win }); // same page
  assert.equal(l2.firstAttach, false);
  assert.equal(b2.vitals.cfg.healAtCombat, 60, "no legacy push on a rebind");
  assert.equal(b2.loot.minValue, 0);
  assert.equal(b2.combat.attackHeight, 3, "a boot-uncarried key is re-applied (cells.js BOOT_UNCARRIED_CELLS)");
  l2.dispose();

});

await check("HUD Restart under a user profile re-applies the profile's Enable* (SET review §8.1); a plain rebind does not", async () => {
  const storage = spyStorage();
  const win = { localStorage: storage, location: { search: "" } };
  const scope = 0x50000042;
  const s = SET.getVtSession(win, String(scope), { storage, log: quiet });
  assert.equal(s.options.saveAs("Quiet").ok, true);
  assert.equal(s.options.set("EnableLooting", false, { source: "ui" }).ok, true);
  assert.equal(s.options.set("BlacklistAttempts", 7, { source: "ui" }).ok, true);
  win.__botBootSpec = { source: "hud", overrides: { lootMin: 0 } };
  const attach = async () => {
    const { host } = makeHost({ guid: scope });
    const bot = makeBot({ host });
    const { layer } = await layerOn(bot, { storage, win });
    return { bot, layer };
  };
  const a = await attach(); // HUD START: the first attach on the page
  assert.equal(a.layer.firstAttach, true);
  assert.equal(a.bot.loot.enabled, false);
  a.layer.dispose();
  const b = await attach(); // HUD Restart: a new bot whose loops start enabled
  assert.equal(b.layer.firstAttach, false);
  assert.equal(b.bot.loot.enabled, false, "the profile's EnableLooting=false is re-applied on a HUD restart");
  assert.equal(b.bot.combat.blacklistAttempts, 7);
  b.layer.dispose();
  win.__botBootSpec = { source: "url", overrides: null };
  const c = await attach(); // a ?bot=1 takeover rebind: boot.js carry-over owns the enables
  assert.equal(c.bot.loot.enabled, true, "no legacy push on a URL rebind");
  assert.equal(c.bot.combat.blacklistAttempts, 7, "boot-uncarried keys are still re-applied");
  c.layer.dispose();
});

await check("Default never written; a 'pending' (unknown) character gets an in-memory session", async () => {
  const storage = spyStorage();
  const { host } = makeHost({ guid: 0 });
  const bot = makeBot({ host });
  bot.host.s.playerGuid = () => 0;
  const { layer } = await layerOn(bot, { storage, win: { localStorage: storage } });
  try {
    assert.equal(layer.scope, "pending");
    layer.options.set("HealAt", 50, { source: "ui" }); // Default ⇒ overlay only
    layer.vars.set("p", "x", 1);
    layer.preTick(5_000_000);
    layer.vars.flush({ force: true });
    assert.deepEqual(storage.writes, [], `nothing persisted under a bogus scope: ${storage.writes.join(", ")}`);
  } finally {
    layer.dispose();
  }
});

// ── page session continuity (D6) ────────────────────────────────────────────

await check("nav index, meta state, session vars and the Default overlay survive dispose + a new layer on the same session", async () => {
  const win = {};
  const { host: h1 } = makeHost();
  const b1 = makeBot({ host: h1 });
  const { layer: l1 } = await VT.createVtLayer(b1, { aux: b1.kernel.aux, win, storage: null, log: quiet, print: quiet }).then((layer) => ({ layer }));
  const pts = [0, 1, 2, 3].map((i) => ({ type: 0, ew: 41.5 + i * 0.01, ns: 33.5, z: 0 }));
  assert.equal(l1.nav.load({ routeType: 1, points: pts }, { name: "loop" }).ok, true);
  l1.nav.setActive(2);
  const meta = { v: 1, name: "m", source: { kind: "json" }, rules: [{ id: "r1", state: "Default", enabled: true, cond: { t: "Never" }, act: { t: "None" } }, { id: "r2", state: "Fight", enabled: true, cond: { t: "Never" }, act: { t: "None" } }], navs: {}, warnings: [] };
  assert.equal(l1.library.importMeta("m", JSON.stringify(meta), "json").ok, true);
  assert.equal(l1.library.loadMeta("m").ok, true);
  l1.meta.enterState("Fight", "manual");
  l1.vars.set("session", "counter", 7);
  l1.options.set("HealAt", 66, { source: "ui" }); // Default overlay (and the live cell)
  l1.dispose();
  assert.equal(l1.disposed, true);

  const { host: h2 } = makeHost();
  const b2 = makeBot({ host: h2 });
  const l2 = await VT.createVtLayer(b2, { aux: b2.kernel.aux, win, storage: null, log: quiet, print: quiet });
  try {
    assert.equal(l2.session, l1.session, "same page session");
    assert.equal(l2.nav.status().i, 2, "same nav index");
    assert.equal(l2.nav.status().name, "loop");
    assert.equal(l2.meta.state, "Fight", "meta state continues (no reload into Default)");
    assert.equal(l2.meta.meta().rules.length, 2);
    assert.equal(l2.vars.get("session", "counter"), 7);
    assert.equal(l2.options.storedValue("HealAt"), 66, "the Default overlay survives");
    assert.equal(b2.vitals.cfg.healAtCombat, 60, "a rebind does not push the overlay into a carried-over legacy cell");
  } finally {
    l2.dispose();
  }
});

await check("review runtime-3: the SwitchWandsToDebuff pre-swap loadout lives in the page session — after a rebind mid-debuff the NEW planner sees it and puts the bow back; Default stays inert", async () => {
  await CMB.loadCombatSpells();
  const BOW = 0x60000301;
  const WAND = 0x60000302;
  const MOB = 0x80000601;
  const IMPERIL_I = 25; // Imperil Other I (combat_spells.json "imperil" rung 1)
  const bowRow = (equipMask) => ({ guid: BOW, name: "Longbow", wcid: 306, itemType: 0x100, equipMask, containerId: ME, stackSize: 1 });
  const wandRow = (equipMask) => ({ guid: WAND, name: "Wand", wcid: 2366, itemType: 0x8000, equipMask, containerId: ME, stackSize: 1 });
  const ents = { [MOB]: { name: "Drudge", wcid: 7, creature: true, dist: 10, hf: 1 } };
  const win = {};
  const attach = async (inv) => {
    const { host, W } = makeHost({ inv, known: [IMPERIL_I], nearby: [MOB], ents });
    const bot = makeBot({ host });
    const layer = await VT.createVtLayer(bot, { aux: bot.kernel.aux, win, storage: null, log: quiet, print: quiet });
    return { host, W, bot, layer };
  };

  // Default: the session gets an empty planner-state bag and nothing else — no attach, no host call.
  const d = await attach([bowRow(0x400000), wandRow(0)]);
  const bag = d.layer.session.ext.plannerState;
  try {
    assert.ok(bag && typeof bag === "object", "the page session holds the planner state");
    assert.deepEqual(bag, { saved: null }, "Default: nothing saved");
    assert.equal(d.bot.combat.vt, null, "Default: combat.vt stays null");
    assert.equal(d.layer.planner.status().saved, null);
    d.W.calls.length = 0;
    let t0 = 7_000_000;
    for (let i = 0; i < 20; i++) { t0 += 100; d.W.seq++; d.layer.preTick(t0); d.W.ticks[0](); }
    assert.deepEqual(d.W.calls.filter((n) => ACTIONS.has(n)), [], "Default: no host action");
  } finally {
    d.layer.dispose();
  }

  // Layer 1: bow in hand, a Drudge entry with Imperil + SwitchWandsToDebuff ⇒ the swap starts and saves the bow.
  const a = await attach([bowRow(0x400000), wandRow(0)]);
  assert.equal(a.layer.session.ext.plannerState, bag, "the same page-session bag across attaches");
  assert.equal(a.layer.options.set("SwitchWandsToDebuff", true, { source: "ui" }).ok, true);
  assert.equal(a.layer.options.setList("monsters", [{ text: "Drudge", I: true }], { source: "ui" }).ok, true);
  assert.equal(a.bot.combat.vt, a.layer.planner);
  a.W.calls.length = 0;
  assert.equal(a.layer.planner.ensureLoadout(MOB, 8_000_000), "busy", "the bow is stowed for the debuff wand");
  assert.ok(a.W.calls.includes("UnwieldItem"), JSON.stringify(a.W.calls));
  const savedLoadout = { main: BOW, offhand: 0, kind: "missile" };
  assert.deepEqual(a.layer.planner.status().saved, savedLoadout);
  assert.deepEqual(bag.saved, savedLoadout, "the pre-swap loadout is in session.ext.plannerState");
  a.layer.dispose(); // HUD Restart / reconnect takeover mid-debuff: the wand is in hand now
  assert.equal(a.bot.combat.vt, null, "dispose hands combat.vt back even while the bow is still owed");
  assert.equal(a.bot.combat.acquireRangeFn, null);
  assert.deepEqual(bag.saved, savedLoadout, "dispose leaves the owed loadout in the page session");

  // Another character on the same page (its own scope ⇒ its own page session) gets its OWN bag: the
  // first character's owed bow never leaks into it, and its own swap never writes the first bag.
  {
    const OTHER = 0x50000002;
    const BOW_B = 0x60000401;
    const WAND_B = 0x60000402;
    const { host, W } = makeHost({
      guid: OTHER,
      inv: [{ ...bowRow(0x400000), guid: BOW_B, containerId: OTHER }, { ...wandRow(0), guid: WAND_B, containerId: OTHER }],
      known: [IMPERIL_I],
      nearby: [MOB],
      ents,
    });
    const bot = makeBot({ host });
    const o = await VT.createVtLayer(bot, { aux: bot.kernel.aux, win, storage: null, log: quiet, print: quiet });
    try {
      assert.notEqual(o.session, a.layer.session, "another character ⇒ another page session");
      const bagB = o.session.ext.plannerState;
      assert.ok(bagB && typeof bagB === "object" && bagB !== bag, "another character ⇒ its own planner-state bag");
      assert.deepEqual(bagB, { saved: null }, "the first character's owed bow does not leak");
      assert.equal(o.planner.status().saved, null);
      assert.equal(bot.combat.vt, null, "Default, nothing owed ⇒ its planner stays detached");
      W.calls.length = 0;
      let t0 = 8_500_000;
      for (let i = 0; i < 20; i++) { t0 += 100; W.seq++; o.preTick(t0); W.ticks[0](); }
      assert.deepEqual(W.calls.filter((n) => ACTIONS.has(n)), [], "Default: no host action for the other character");
      assert.equal(o.options.set("SwitchWandsToDebuff", true, { source: "ui" }).ok, true);
      assert.equal(o.options.setList("monsters", [{ text: "Drudge", I: true }], { source: "ui" }).ok, true);
      assert.equal(o.planner.ensureLoadout(MOB, t0 + 100), "busy");
      assert.deepEqual(bagB.saved, { main: BOW_B, offhand: 0, kind: "missile" }, "its own swap lands in its own bag");
      assert.deepEqual(bag.saved, savedLoadout, "and never in the first character's bag");
    } finally {
      o.dispose();
    }
  }

  // Layer 2 (same page session, a new bot): the new planner owes the bow back.
  const b = await attach([bowRow(0), wandRow(0x1000000)]);
  try {
    assert.equal(b.layer.firstAttach, false);
    assert.deepEqual(b.layer.planner.status().saved, savedLoadout, "the NEW planner sees the saved loadout");
    assert.equal(b.bot.combat.vt, b.layer.planner, "the new planner is attached to the new bot");
    let t = 9_000_000;
    assert.equal(b.layer.planner.ensureLoadout(MOB, t), "ok", "debuff still pending ⇒ keep the wand");
    // The debuff lands (cast issued by the new planner; the server's line through host_signals).
    const plan = b.layer.planner.nextCast(MOB, { mode: 8, dist: 10, now: t });
    assert.equal(plan && plan.spellId, IMPERIL_I, JSON.stringify(plan));
    b.layer.planner.onCastIssued(MOB, plan, true);
    b.W.emit({ kind: 2, text: "You cast Imperil Other I on Drudge", u32: 0, u32b: 0 });
    b.W.seq++;
    t += 3100;
    b.W.calls.length = 0;
    assert.equal(b.layer.planner.ensureLoadout(MOB, t), "busy", "debuffs on ⇒ restore the pre-swap loadout");
    assert.ok(b.W.calls.includes("WieldItem"), JSON.stringify(b.W.calls));
    assert.deepEqual({ op: b.layer.planner.status().swap?.op, item: b.layer.planner.status().swap?.item }, { op: "wield", item: BOW }, "the bow goes back after the rebind");
  } finally {
    b.layer.dispose();
  }
});

await check("review guide-3: navreversed / navlastresult are meta-visible session vars (R22, R9) — /rs reverseroute, a load, a FAILED waypoint", async () => {
  const { host, W } = makeHost();
  const bot = makeBot({ host });
  const layer = await VT.createVtLayer(bot, { aux: bot.kernel.aux, win: {}, storage: null, log: quiet, print: quiet });
  try {
    const getvar = (n) => layer.expr.evaluate(`getvar[${n}]`);
    assert.equal(getvar("navreversed"), 0, "unset before any reversal");
    assert.equal(layer.options.set("EnableNavigation", true, { source: "ui" }).ok, true);
    const pts = [0, 1, 2].map((i) => ({ type: 0, ew: 41.5 + i * 0.01, ns: 33.5, z: 0 }));
    assert.equal(layer.nav.load({ routeType: 2, points: pts }, { name: "lap" }).ok, true);
    // a meta that reacts to the var (R22: "navreversed" is a meta var)
    const m = {
      v: 1, name: "rev", source: { kind: "json" }, navs: {}, warnings: [],
      rules: [{ id: "r1", state: "Default", enabled: true, cond: { t: "Expr", expr: "getvar[navreversed] == 1" }, act: { t: "SetState", state: "Reversed" } }],
    };
    assert.equal(layer.library.importMeta("rev", JSON.stringify(m), "json").ok, true);
    assert.equal(layer.library.loadMeta("rev").ok, true);
    layer.options.set("EnableMeta", true, { source: "ui" });
    let t = 2_000_000;
    const step = (n = 1) => { for (let i = 0; i < n; i++) { t += 300; W.seq++; layer.preTick(t); } };
    step(2);
    assert.equal(layer.meta.state, "Default");
    const r = layer.runChat("/rs reverseroute true", { source: "console" });
    assert.equal(r.handled, true, JSON.stringify(r));
    assert.equal(layer.nav.status().reversed, true);
    assert.equal(getvar("navreversed"), 1, "/rs reverseroute true ⇒ getvar[navreversed] == 1");
    step(2);
    assert.equal(layer.meta.state, "Reversed", "a meta rule sees the reversal");
    layer.runChat("/vt reverseroute false", { source: "console" });
    assert.equal(getvar("navreversed"), 0, "and back to 0");
    layer.nav.reverse(true);
    assert.equal(getvar("navreversed"), 1);
    // a load resets the flag and says so
    assert.equal(layer.nav.load({ routeType: 2, points: pts }, { name: "lap" }).ok, true);
    assert.equal(getvar("navreversed"), 0, "a load that clears the flag ⇒ 0");

    // R9 meta-visible FAILED: a Jump waypoint whose jump primitive is unavailable fails and pauses nav.
    assert.equal(getvar("navlastresult"), 0, "no waypoint result yet");
    delete host.Jump; // the REAL goto_compose.attemptJumpLeg ⇒ jump-unavailable
    assert.equal(layer.nav.load({ routeType: 4, points: [{ type: 9, ew: 41.5, ns: 33.5, z: 0, headingDeg: 0, holdShift: false, delayMs: 100 }] }).ok, true);
    const slot = bot.kernel.aux.slots.find((s) => s.name === "Navigate");
    for (let i = 0; i < 4 && !layer.nav.paused; i++) {
      slot.tick({});
      await new Promise((res) => setTimeout(res, 0));
    }
    assert.ok(layer.nav.paused, "FAILED pauses navigation");
    assert.match(String(getvar("navlastresult")), /^FAILED:9:jump-unavailable/, "the FAILED result reaches getvar[navlastresult]");
    assert.equal(getvar("navlastresult"), layer.nav.status().lastResult);
  } finally {
    layer.dispose();
  }
});

// ── rs_entry (the page entry) ───────────────────────────────────────────────

await check("rs_entry.route: synchronous dispatch, never sendChat, one line per message, always {dispatched, echo:null}", async () => {
  const lines = [];
  const win = { __appendChatLine: (t, c) => lines.push([t, c]) };
  const { host } = makeHost();
  const bot = makeBot({ host });
  const layer = await VT.createVtLayer(bot, { aux: bot.kernel.aux, win, storage: null, log: quiet });
  win.__bot = bot;
  bot.vt = layer;
  const api = RS.installRsEntry(win);
  try {
    assert.equal(RS.installRsEntry(win), api, "idempotent");
    assert.equal(win.__rynthVt, api);
    const sent = [];
    const handle = { playerGuid: () => ME, sendChat: (t) => sent.push(t) };
    const r = api.route(handle, "/rs opt set AttackDistance 0.0833");
    assert.deepEqual(r, { dispatched: true, echo: null });
    assert.ok(Math.abs(layer.options.getValue("MonsterRange") - 19.992) < 1e-6, "applied within the call");
    assert.equal(bot.combat.monsterRangeM, layer.options.getValue("MonsterRange"));
    assert.ok(lines.some(([t]) => /Set option AttackDistance = 0\.0833/.test(t)), JSON.stringify(lines));
    lines.length = 0;
    const bad = api.route(handle, "/mt frobnicate");
    assert.deepEqual(bad, { dispatched: true, echo: null }, "an error is printed by the dispatcher, not echoed again");
    assert.equal(lines.length, 1, JSON.stringify(lines));
    assert.match(lines[0][0], /unknown \/mt command 'frobnicate'/);
    for (const p of ["/rs x", "/vt x", "/ra x", "/mt x", "/ub x"]) api.route(handle, p);
    assert.deepEqual(sent, [], "nothing reaches the server");
    // dispatch() prefers the live layer's dispatcher (its /ub delay queue is pumped by preTick)
    const d = api.dispatch("/ub delay 100 /rs echo later", { source: "chat" });
    assert.equal(d.handled, true);
    assert.equal(layer.rs.pendingDelayed(), 1);
  } finally {
    layer.dispose();
  }
});

await check("rs_entry without a bot: opt/settings act on the character's page session; nav verbs answer 'start the bot first'; hudProvider", async () => {
  const lines = [];
  const storage = spyStorage();
  const win = { __appendChatLine: (t) => lines.push(t), localStorage: storage, __sessionHandle: { playerGuid: () => 0x50000777 } };
  const api = RS.installRsEntry(win);
  const handle = { playerGuid: () => 0x50000777, sendChat: () => assert.fail("sent") };
  api.route(handle, "/vt opt set HealAt 55");
  const s = api.session();
  assert.ok(s, "session for the page character");
  assert.equal(s.scope, String(0x50000777));
  assert.equal(s.options.getValue("HealAt"), 55);
  api.route(handle, "/rs nav start");
  assert.ok(lines.some((t) => /start the bot first/.test(t)), JSON.stringify(lines));
  const hp = api.hudProvider(handle);
  assert.equal(hp.isUserProfileActive(), false);
  assert.equal(hp.hudBootOverrides(), null, "Default ⇒ null (the HUD keeps its own overrides)");
  assert.equal(hp.statusLine(), "");
  assert.equal(hp.noteLegacyEdit("lootMin", 700).ok, true);
  assert.equal(s.options.storedValue("LootMinValue"), 700, "a HUD edit lands in the Default overlay");
  assert.deepEqual(storage.writes, [], "Default never written");
  await assert.rejects(api.openPanel("route"), /needs a page/);
  assert.equal(RS.installRsEntry({}).version, 1);
});

await check("rs_entry without the layer (review runtime-5 / wiring-4): /ub delay, a multi-stack /ra give… and a /mt loot retry refuse on the unpumped page dispatcher", async () => {
  // A page whose bot has NO VTank layer (?botVt=off) — nothing ever pumps the page dispatcher, so
  // a verb that queues must refuse instead of printing "queued …" for work that never runs.
  const lines = [];
  const gives = [];
  const BOB = 0x50000002;
  const inv = [
    { guid: 0x80000011, name: "Pyreal", wcid: 273, stackSize: 25000, containerId: ME, equipMask: 0, itemType: 0x40 },
    { guid: 0x80000012, name: "Pyreal", wcid: 273, stackSize: 25000, containerId: ME, equipMask: 0, itemType: 0x40 },
  ];
  const host = {
    GetPlayerId: () => ME,
    TryGetPlayerInventory: () => inv.map((r) => ({ ...r })),
    NearbyGuids: () => [BOB],
    TryGetObjectName: (g) => (g === BOB ? "Bob" : g === ME ? "Tester" : inv.find((r) => r.guid === g)?.name ?? null),
    ObjectIsPlayer: (g) => g === BOB,
    TryGetObjectPosition: () => ({ objCellId: LB, x: 10, y: 10, z: 0 }),
    TryGetPlayerPose: () => ({ objCellId: LB, x: 11, y: 10, z: 0 }),
    TryGetObjectDistance: () => 1,
    GiveObject: (item, to, n) => { gives.push([item, to, n]); return true; },
    tryClaimItemAction: () => true,
    releaseItemAction: () => {},
    IsPortalSpaceActive: () => false,
    InvokeChatParser: () => assert.fail("nothing may reach the chat parser"),
  };
  const win = { __bot: { host, kernel: { operatorHeld: false } }, __appendChatLine: (t, c) => lines.push([String(t), c]) };
  const api = RS.installRsEntry(win);
  const errorsFor = (line) => {
    lines.length = 0;
    api.route(null, line);
    return lines;
  };
  for (const line of ["/ub delay 0 /say x", "/ra givea Pyreal to Bob", "/ra give 2 Pyreal to Bob", "/mt loot Pyreal"]) {
    const out = errorsFor(line);
    assert.ok(out.some(([t, c]) => c === 10 && /VTank layer/.test(t)), `${line}: ${JSON.stringify(out)}`);
    assert.ok(!out.some(([t]) => /queued|waiting for it to appear/.test(t)), `${line} reported queued work: ${JSON.stringify(out)}`);
  }
  assert.equal(api.pageDispatcher.pendingDelayed(), 0, "nothing in the page dispatcher's delay queue");
  api.pageDispatcher.pump(Date.now() + 60_000);
  assert.deepEqual(gives, [], "no give was queued");
  // A single stack still goes out at once (no queue involved).
  inv.pop();
  const one = errorsFor("/ra give Pyreal to Bob");
  assert.ok(one.some(([t]) => /giving Pyreal to Bob/.test(t)), JSON.stringify(one));
  assert.equal(gives.length, 1);
});

// ── dispose ─────────────────────────────────────────────────────────────────

await check("dispose: idempotent; every hook handed back; ticks after dispose do nothing", async () => {
  await CMB.loadCombatSpells();
  const SHIELD = 0x60000100;
  const { host, W } = makeHost({ inv: [{ guid: SHIELD, name: "Kite Shield", wcid: 91, itemType: 2, validLocations: 0x200000, equipMask: 0x200000, stackSize: 1 }], known: [51, 1486, 37, 1562] });
  const bot = makeBot({ host });
  const storage = null;
  const { layer } = await layerOn(bot, { storage });
  const lib = layer.library;
  assert.equal(lib.putLoot("all", { version: 1, rules: [{ name: "Keep all", enabled: true, priority: 0, action: "Keep", conditions: [] }] }).ok, true);
  assert.equal(lib.loadLoot("all").ok, true);
  assert.equal(typeof bot.loot.classify, "function", "loot profile bound");
  assert.equal(layer.items.add({ guid: SHIELD, name: "Kite Shield", wcid: 91, kind: "shield" }).ok, true);
  assert.ok(bot.buff.itemBuffs.length > 0, "a shield projects impen/bane item buffs (D38)");
  assert.ok(bot.buff.itemBuffs.every((r) => r.itemGuid === SHIELD && r.itemName === "Kite Shield"));
  assert.ok(bot.buff.itemBuffs.some((r) => r.spellId === 1486), "the best known Impenetrability rung");
  layer.options.setList("monsters", [{ text: "Drudge", priority: 3 }], { source: "ui" });
  assert.equal(bot.combat.vt, layer.planner, "a non-DEFAULT list attaches the planner");
  layer.options.set("EnableNavigation", true, { source: "ui" });
  layer.nav.load({ routeType: 1, points: [{ type: 0, ew: 41.5, ns: 33.5, z: 0 }] });
  assert.equal(bot.unwedge.allowEscalation(), false, "VT nav owns a live route ⇒ no recall/@teleloc");

  layer.dispose();
  layer.dispose();
  assert.equal(layer.disposed, true);
  assert.equal(bot.combat.vt, null);
  assert.equal(bot.combat.acquireRangeFn, null);
  assert.equal(bot.loot.classify, null);
  assert.deepEqual(bot.buff.itemBuffs, [], "item buffs handed back");
  assert.deepEqual(bot.kernel.aux.slots, []);
  assert.deepEqual(bot.kernel.aux.idleHooks, []);
  assert.equal(bot.kernel.aux.policy.boostLoot(), false);
  assert.equal(bot.kernel.aux.policy.pinnedFirst, undefined, "pinnedFirst handed back on dispose");
  assert.equal(bot.unwedge.allowEscalation, null);
  W.calls.length = 0;
  layer.preTick(9e12);
  W.ticks[0]();
  assert.deepEqual(W.calls, [], "a disposed layer's closures are inert");
});

await check("policy.pinnedFirst: true only while a VT-nav executor is pinned (recall/portal/jump in flight)", async () => {
  const { host } = makeHost();
  const bot = makeBot({ host });
  const { layer } = await layerOn(bot);
  try {
    const pf = bot.kernel.aux.policy.pinnedFirst;
    assert.equal(typeof pf, "function");
    layer.options.set("EnableNavigation", true, { source: "ui" });
    layer.nav.load({ routeType: 1, points: [{ type: 0, ew: 41.5, ns: 33.5, z: 0 }] });
    assert.equal(pf(), false, "a route walking a Point leg is not pinned");
    layer.nav._exec = { pinned: true, cancel() {} }; // white-box: an in-flight recall/portal/jump executor
    assert.equal(pf(), true, "an in-flight executor keeps the tick ahead of Combat");
    layer.options.set("EnableNavigation", false, { source: "ui" });
    assert.equal(pf(), false, "nav disabled ⇒ never pinned (NAV F4)");
    layer.options.set("EnableNavigation", true, { source: "ui" });
    layer.nav._exec = null;
    assert.equal(pf(), false);
  } finally {
    layer.dispose();
  }
});

await check("planner re-evaluation on option changes; profile selection loads the refs it names (never on kind:'ref')", async () => {
  const storage = spyStorage();
  const win = { localStorage: storage };
  const { host } = makeHost({ guid: 0x50000123 });
  const bot = makeBot({ host });
  const layer = await VT.createVtLayer(bot, { aux: bot.kernel.aux, win, storage, log: quiet, print: quiet });
  try {
    assert.equal(bot.combat.vt, null);
    layer.options.set("WarSpellMode", "vtank", { source: "ui" });
    assert.equal(bot.combat.vt, layer.planner);
    layer.options.set("WarSpellMode", "legacy", { source: "ui" });
    assert.equal(bot.combat.vt, null);
    // a nav profile saved, then a user profile that names it
    layer.nav.load({ routeType: 2, points: [{ type: 0, ew: 1, ns: 1, z: 0 }, { type: 0, ew: 2, ns: 2, z: 0 }] });
    assert.equal(layer.nav.save("Lap").ok, true);
    layer.nav.clear();
    assert.equal(layer.options.saveAs("Farm").ok, true);
    assert.equal(layer.options.getRef("navProfile"), "Lap", "Save As keeps the ref");
    assert.equal(layer.nav.isEmpty(), true, "setRef/saveAs never load anything (kind:'ref' is ignored)");
    assert.equal(layer.options.selectProfile("Default").ok, true);
    assert.equal(layer.options.selectProfile("Farm").ok, true);
    assert.equal(layer.nav.status().name, "Lap", "kind:'profile' loads the named route");
    assert.equal(layer.nav.route().points.length, 2);
  } finally {
    layer.dispose();
  }
});

await check("review logic-1: a profile switch from the running meta keeps it running (no Default re-entry, call stack kept); a profile naming ANOTHER meta still loads it into Default", async () => {
  const { host, W } = makeHost({ guid: 0x50000123 });
  const bot = makeBot({ host });
  const layer = await VT.createVtLayer(bot, { aux: bot.kernel.aux, win: {}, storage: spyStorage(), log: quiet, print: quiet });
  try {
    const farm = {
      v: 1, name: "Farm", source: { kind: "json" }, navs: {}, warnings: [],
      rules: [
        { id: "d1", state: "Default", enabled: true, cond: { t: "Always" }, act: { t: "DoAll", children: [
          { t: "DoExpr", expr: "setvar[defaultRuns,getvar[defaultRuns]+1]" },
          { t: "CallState", state: "Hunt", ret: "Default" },
        ] } },
        { id: "h1", state: "Hunt", enabled: true, cond: { t: "SecsInStateGE", secs: 1 }, act: { t: "Chat", text: "/vt settings load Hunting" } },
        { id: "h2", state: "Hunt", enabled: true, cond: { t: "SecsInStateGE", secs: 2 }, act: { t: "SetState", state: "Deep" } },
        { id: "p1", state: "Deep", enabled: true, cond: { t: "SecsInStateGE", secs: 1 }, act: { t: "Chat", text: "/vt settings load Buffing" } },
        { id: "p2", state: "Deep", enabled: true, cond: { t: "SecsInStateGE", secs: 2 }, act: { t: "SetState", state: "Done" } },
      ],
    };
    const other = {
      v: 1, name: "Other", source: { kind: "json" }, navs: {}, warnings: [],
      rules: [{ id: "o1", state: "Default", enabled: true, cond: { t: "Always" }, act: { t: "DoExpr", expr: "setvar[otherRuns,getvar[otherRuns]+1]" } }],
    };
    const lib = layer.library;
    assert.equal(lib.importMeta("Farm", JSON.stringify(farm), "json").ok, true);
    assert.equal(lib.importMeta("Other", JSON.stringify(other), "json").ok, true);
    assert.equal(lib.loadMeta("Farm").ok, true);
    layer.options.set("EnableMeta", true, { source: "ui" });
    // Two settings profiles saved while Farm is loaded (the normal way to make them): both name Farm.
    assert.equal(layer.options.saveAs("Buffing").ok, true);
    assert.equal(layer.options.saveAs("Hunting").ok, true);
    assert.equal(layer.options.getRef("metaName"), "Farm");
    assert.equal(layer.options.selectProfile("Buffing").ok, true);
    layer.options.set("EnableMeta", true, { source: "ui" });
    let t = 2_000_000;
    const step = (n = 1) => { for (let i = 0; i < n; i++) { t += 300; W.seq++; layer.preTick(t); } };
    step(1);
    assert.equal(layer.meta.state, "Hunt");
    assert.deepEqual(layer.meta.snapshot().stack, ["Default"]);
    step(5); // ~1.5 s in Hunt: its Chat rule selects the Hunting profile (which names Farm)
    assert.equal(layer.options.profiles.active().name, "Hunting");
    assert.equal(layer.meta.state, "Hunt", "the switch did not throw Farm back to Default");
    assert.deepEqual(layer.meta.snapshot().stack, ["Default"], "the call stack survives the switch");
    const seen = [];
    for (let i = 0; i < 200; i++) { step(1); if (seen[seen.length - 1] !== layer.meta.state) seen.push(layer.meta.state); }
    assert.deepEqual(seen, ["Hunt", "Deep", "Done"], `states: ${seen.join(" > ")}`);
    assert.equal(layer.options.profiles.active().name, "Buffing");
    assert.equal(Number(layer.vars.get("session", "defaultRuns")), 1, "Default's rule ran once");
    assert.deepEqual(layer.meta.snapshot().stack, ["Default"]);
    // A profile that names a DIFFERENT stored meta still loads it (PLAN 12c, V-14).
    assert.equal(layer.options.saveAs("Camp").ok, true);
    assert.equal(layer.options.setRef("metaName", "Other", { source: "ui" }).ok, true);
    assert.equal(layer.meta.snapshot().name, "Farm", "setRef alone loads nothing");
    assert.equal(layer.options.selectProfile("Buffing").ok, true);
    assert.equal(layer.meta.state, "Done", "back to a profile naming the running meta: untouched");
    assert.equal(layer.options.selectProfile("Camp").ok, true);
    assert.equal(layer.meta.snapshot().name, "Other");
    assert.equal(layer.meta.state, "Default");
    step(1);
    assert.equal(Number(layer.vars.get("session", "otherRuns")), 1);
  } finally {
    layer.dispose();
  }
});

await check("review runtime-8: delayexec[] in a Monsters-tab (monster-mode) expression is an Err and queues nothing; the meta runtime still queues it", async () => {
  const { host } = makeHost();
  const bot = makeBot({ host });
  const { layer } = await layerOn(bot);
  try {
    const { isErr } = await import("../rynth/vt/expr/index.js");
    const v = layer.monsterExpr.evaluate("delayexec[0, `setvar[x,1]`]");
    assert.equal(isErr(v), true, JSON.stringify(v));
    assert.match(String(v.msg), /delayexec is not available in monster expressions/);
    assert.equal(layer.monsterExpr.pendingDelayed, 0, "nothing queued on the unpumped monster runtime");
    assert.equal(layer.expr.evaluate("delayexec[0, `setvar[x,1]`]"), 1);
    assert.equal(layer.expr.pendingDelayed, 1, "the meta runtime (pumped by the meta engine) is unchanged");
    layer.expr.clearDelayed();
  } finally {
    layer.dispose();
  }
});

await check("review wiring-3: the 1 Hz enchantment-book warm-up also runs for a BuffItem entry and for a meta calling getspellexpiration[] (never at Default)", async () => {
  const BEER = 0x60000777;
  const count = (W) => W.calls.filter((c) => c === "TryGetSelfEnchantments").length;
  const run = (layer, W, seconds) => {
    let t = 5_000_000;
    const n0 = count(W);
    for (let i = 0; i < seconds * 10; i++) { t += 100; W.seq++; layer.preTick(t); }
    return count(W) - n0;
  };
  // Default: nothing reads enchantments ⇒ no warm-up.
  {
    const { host, W } = makeHost();
    const { layer } = await layerOn(makeBot({ host }));
    try {
      assert.equal(run(layer, W, 5), 0, "Default never reads the book");
    } finally {
      layer.dispose();
    }
  }
  // Only a BuffItem configured (no meta, no dispel): one read per second.
  {
    const { host, W } = makeHost({ inv: [{ guid: BEER, name: "Amber Ape", wcid: 4321, stackSize: 5, containerId: ME, itemType: 0x20 }] });
    const { layer } = await layerOn(makeBot({ host }));
    try {
      const r = layer.consumables.add({ guid: BEER, name: "Amber Ape", wcid: 4321, type: "BuffItem", spellIds: [9999], durationS: 3600 });
      assert.equal(r.ok, true, JSON.stringify(r));
      const n = run(layer, W, 5);
      assert.ok(n >= 4 && n <= 6, `about one read per second over 5 s, got ${n}`);
    } finally {
      layer.dispose();
    }
  }
  // Only a meta whose Expr condition calls getspellexpiration[]: one read per second.
  {
    const { host, W } = makeHost();
    const { layer } = await layerOn(makeBot({ host }));
    try {
      const m = {
        v: 1, name: "exp", source: { kind: "json" }, navs: {}, warnings: [],
        rules: [{ id: "e1", state: "Default", enabled: true, cond: { t: "Expr", expr: "getspellexpiration[2345] < 300" }, act: { t: "SetState", state: "Low" } }],
      };
      assert.equal(layer.library.importMeta("exp", JSON.stringify(m), "json").ok, true);
      assert.equal(layer.library.loadMeta("exp").ok, true);
      const n = run(layer, W, 5);
      assert.ok(n >= 4, `about one read per second over 5 s, got ${n}`);
    } finally {
      layer.dispose();
    }
  }
});

await check("signals → meta events (chat with category, our death, portal edges, vendor) and appraisals → creature profiles", async () => {
  const MOB = 0x80000301;
  const { host, W } = makeHost({
    ents: { [MOB]: { name: "Drudge", wcid: 7, creature: true, appraisal: { properties: { ints: { 2: 3 } }, creatureProfile: { health_max: 120 } } } },
  });
  host.TryGetObjectAppraisal = (g) => W.ents[g]?.appraisal ?? null;
  const bot = makeBot({ host });
  const layer = await VT.createVtLayer(bot, { aux: bot.kernel.aux, win: {}, storage: null, log: quiet, print: quiet });
  try {
    const meta = {
      v: 1, name: "ev", source: { kind: "json" }, navs: {}, warnings: [],
      rules: [
        { id: "r1", state: "Default", enabled: true, cond: { t: "ChatMatch", re: "^Hello (?<who>\\w+)$" }, act: { t: "SetState", state: "Greeted" } },
        { id: "r2", state: "Greeted", enabled: true, cond: { t: "Death" }, act: { t: "SetState", state: "Dead" } },
        { id: "r3", state: "Dead", enabled: true, cond: { t: "IntoPortal" }, act: { t: "SetState", state: "Portal" } },
        { id: "r4", state: "Portal", enabled: true, cond: { t: "VendorOpen" }, act: { t: "SetState", state: "Shop" } },
      ],
    };
    layer.library.importMeta("ev", JSON.stringify(meta), "json");
    assert.equal(layer.library.loadMeta("ev").ok, true);
    layer.options.set("EnableMeta", true, { source: "ui" });
    let t = 2_000_000;
    const step = () => {
      t += 300;
      W.seq++;
      layer.preTick(t);
    };
    step();
    W.emit({ kind: 2, text: "Hello Bob", u32: 0, u32b: 0 });
    step();
    assert.equal(layer.meta.state, "Greeted", "a chat line reaches ChatMatch");
    W.emit({ kind: 29, text: "Someone else died", u32: 0x80000999, u32b: ME });
    step();
    assert.equal(layer.meta.state, "Greeted", "another creature's death is not ours");
    W.emit({ kind: 29, text: "You died", u32: ME, u32b: 0x80000999 });
    step();
    assert.equal(layer.meta.state, "Dead", "our death latches Death");
    W.emit({ kind: 33, text: "", u32: 1, u32b: 0 });
    step();
    assert.equal(layer.meta.state, "Portal", "portal entry → IntoPortal");
    W.emit({ kind: 12, text: "Shopkeeper", u32: 0x80000444, u32b: 0 });
    step();
    assert.equal(layer.meta.state, "Shop", "vendor open → VendorOpen");
    assert.equal(layer.creatures.maxHp(7), null);
    W.emit({ kind: 32, text: "", u32: MOB, u32b: 0 });
    assert.equal(layer.creatures.maxHp(7), 120, "the appraisal was learned (wcid 7)");
  } finally {
    layer.dispose();
  }
});

await check("a construction failure half way undoes every side effect (bot boots without the layer)", async () => {
  const { host, W } = makeHost();
  const bot = makeBot({ host });
  const throwing = new Proxy(host, {
    get(t, p, r) {
      if (p === "onTick") return () => { throw new Error("no heartbeat here"); };
      return Reflect.get(t, p, r);
    },
  });
  bot.host = throwing;
  const win = {};
  await assert.rejects(VT.createVtLayer(bot, { aux: bot.kernel.aux, win, storage: null, log: quiet, print: quiet }), /no heartbeat here/);
  assert.equal(bot.combat.acquireRangeFn, null, "acquireRangeFn handed back");
  assert.equal(bot.combat.vt, null);
  assert.deepEqual(bot.kernel.aux.slots, [], "no aux slot left behind");
  assert.deepEqual(bot.kernel.aux.idleHooks, []);
  assert.equal(bot.unwedge.allowEscalation, null);
  const s = SET.peekVtSession(win, String(ME));
  assert.equal(s.attachCount, 0, "the failed attach does not count as the page's first");
  W.calls.length = 0;
  W.emit({ kind: 2, text: "after", u32: 0, u32b: 0 });
  assert.deepEqual(W.calls.filter((n) => ACTIONS.has(n)), [], "the orphaned event subscription is inert");
});

// ── glue contracts ──────────────────────────────────────────────────────────

await check("MetaContext: settings.get in VTank units, disableMeta, bag, stack-aware itemCount, monsters rows, nav adapters, chat.run local", async () => {
  const { host } = makeHost({
    inv: [{ guid: 1, name: "Mana Stone", stackSize: 3 }, { guid: 2, name: "mana stone", stackSize: 2 }, { guid: 3, name: "Mana Stones" }],
    nearby: [0x80000201, 0x80000202, 0x80000203],
    ents: { [0x80000201]: { name: "Drudge", creature: true, dist: 10, hf: 0.5 }, [0x80000202]: { name: "Banker", creature: true, dist: 4, attackable: false }, [0x80000203]: { name: "Chest", dist: 3 } },
  });
  const bot = makeBot({ host });
  const lines = [];
  const layer = await VT.createVtLayer(bot, { aux: bot.kernel.aux, win: {}, storage: null, log: quiet, print: (t) => lines.push(t) });
  try {
    const ctx = layer.meta.ctx;
    assert.ok(Math.abs(ctx.settings.get("AttackDistance").value - 40 / 240) < 1e-9, "lbf via the VTank name");
    assert.equal(ctx.settings.get("MonsterRange").value, 40, "canonical keys never convert");
    assert.equal(ctx.settings.get("NoSuchOption").ok, false);
    ctx.settings.bagSet("Foo", 3);
    assert.equal(ctx.settings.bagGet("foo"), 3);
    layer.options.set("EnableMeta", true, { source: "ui" });
    ctx.settings.disableMeta("test");
    assert.equal(layer.options.getValue("EnableMeta"), false);
    assert.equal(ctx.player.itemCount("mana stone"), 5, "exact name, case-insensitive, stack-aware");
    assert.equal(ctx.player.packFreeMain(), 92);
    assert.equal(ctx.player.burdenPct(), 42);
    assert.equal(ctx.player.guid(), ME);
    const w = ctx.player.world();
    assert.ok(Number.isFinite(w.wx) && Number.isFinite(w.wy));
    const mons = ctx.world.monsters();
    assert.deepEqual(mons.map((m) => [m.name, m.dist, m.hf, m.attackable]), [["Drudge", 10, 0.5, true], ["Banker", 4, -1, false]]);
    assert.equal(ctx.world.monsters(), mons, "memo per snapshot seq");
    assert.equal(ctx.nav.isEmpty(), true);
    assert.equal(ctx.nav.minDistToAnyPointM(), Infinity);
    assert.equal(ctx.buff.needsBuff(), false);
    assert.equal(ctx.monsters.priorityOf(0x80000201), 1, "DEFAULT P = 1");
    assert.equal(ctx.portal.active(), false);
    assert.equal(ctx.views, layer.views);
    ctx.chat.run("/rs echo from-meta");
    assert.ok(lines.includes("from-meta"), JSON.stringify(lines));
  } finally {
    layer.dispose();
  }
});

await check("the local chat chain: /rs family → dispatcher; /ls → RecallToLifestone; /ah → RecallAllegianceHometown; anything else → InvokeChatParser", async () => {
  const { host, W } = makeHost();
  const bot = makeBot({ host });
  const lines = [];
  const layer = await VT.createVtLayer(bot, { aux: bot.kernel.aux, win: {}, storage: null, log: quiet, print: (t) => lines.push(t) });
  try {
    W.calls.length = 0;
    layer.runChat("/vt echo hi", { source: "nav" });
    assert.ok(lines.includes("hi"));
    layer.runChat("/ls", { source: "nav" });
    layer.runChat("/ah", { source: "nav" });
    layer.runChat("/say hello there", { source: "nav" });
    const acted = W.calls.filter((n) => ACTIONS.has(n) || n === "RecallToLifestone" || n === "RecallAllegianceHometown");
    assert.deepEqual(acted, ["RecallToLifestone", "RecallAllegianceHometown", "InvokeChatParser"]);
    // HostFnContext: the meta host functions resolve against the live layer
    assert.ok(Math.abs(layer.expr.evaluate("vtgetsetting[AttackDistance]") - 40 / 240) < 1e-9);
    W.calls.length = 0;
    layer.expr.evaluate("chatbox[\\/rs echo viachatbox]");
    assert.ok(lines.includes("viachatbox"), JSON.stringify(lines));
    assert.deepEqual(W.calls.filter((n) => n === "InvokeChatParser" || n === "WriteToChat"), [], "a /rs line never reaches the game");
    assert.equal(layer.expr.evaluate("vtgetmetastate[]"), "Default", "META functions registered on the shared registry");
  } finally {
    layer.dispose();
  }
});

await check("loot item context: Decal synthetic keys, pending before the appraisal, KeepUpTo counts the inventory stack-aware", () => {
  const ITEM = 0x7000a001;
  const ents = {
    [ITEM]: { name: "Ornate Sword", wcid: 3000, appraised: false, ints: { 1: 1, 44: 55, 45: 4 }, floats: { 22: 0.4, 13: 1.2 } },
  };
  const { host } = makeHost({ ents, inv: [{ guid: 0x7000b001, name: "Pea", stackSize: 4 }, { guid: 0x7000b002, name: "Pea", stackSize: 3 }] });
  const ctx = LOOT.buildUtlItemCtx(host, ITEM);
  assert.equal(ctx.name, "Ornate Sword");
  assert.equal(ctx.intProp(0x0d000022), 55, "MaxDamage → STypeInt 44");
  assert.equal(ctx.intProp(0x0d000021), 4, "DamageType → STypeInt 45");
  assert.equal(ctx.intProp(0x0d000000), 3000, "Type → wcid");
  assert.equal(ctx.floatProp(0x0a00000b), 0.4, "Variance → STypeFloat 22");
  assert.equal(ctx.floatProp(0x0a000000), 1.2, "SlashProt → STypeFloat 13");
  assert.equal(ctx.intProp(0x0d000029), null, "an unmapped synthetic key is unknown, never a raw STypeInt read");
  assert.equal(ctx.intProp(44), 55, "plain STypeInt ids pass through");
  assert.equal(ctx.spellIds(), null, "unappraised ⇒ unknown");
  const prof = { version: 1, rules: [{ name: "big swords", enabled: true, priority: 0, action: "Keep", conditions: [{ type: 3, typeName: "LongValKeyGE", data: ["50", "218103842"] }] }] };
  const classify = LOOT.makeLootClassify({ profile: prof, log: quiet });
  assert.equal(classify(ITEM, { host }), "pickup");
  const prof2 = { version: 1, rules: [{ name: "spells", enabled: true, priority: 0, action: "Keep", conditions: [{ type: 8, typeName: "SpellCountGE", data: ["1"] }] }] };
  assert.equal(LOOT.makeLootClassify({ profile: prof2, log: quiet })(ITEM, { host }), "pending", "appraisal-gated ⇒ hold");
  // KeepUpTo: 4 + 3 = 7 held (< 8) ⇒ pickup; with 9 needed it still picks up; with 7 it skips
  const keep = (n) => LOOT.makeLootClassify({ profile: { version: 1, rules: [{ name: "peas", enabled: true, priority: 0, action: "KeepUpTo", keepCount: n, conditions: [{ type: 7, typeName: "ObjectClass", data: ["0"] }] }] }, log: quiet });
  const PEA = 0x7000c001;
  ents[PEA] = { name: "Pea", appraised: true };
  ents[0x7000b001] = { name: "Pea", appraised: true };
  ents[0x7000b002] = { name: "Pea", appraised: true };
  assert.equal(keep(8)(PEA, { host }), "pickup");
  assert.equal(keep(7)(PEA, { host }), "skip");
});

await check("T-S1: no forbidden cast/chat member names in rynth/vt/** and plugins/rynth-vt/** (.js)", () => {
  const roots = [path.join(HW, "rynth", "vt"), path.join(HW, "plugins", "rynth-vt")];
  const files = [];
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      const p = path.join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (n.endsWith(".js")) files.push(p);
    }
  };
  for (const r of roots) walk(r);
  assert.ok(files.length > 60, `scanned ${files.length} files`);
  assert.ok(files.some((f) => f.endsWith(path.join("vt", "index.js"))) && files.some((f) => f.endsWith("rs_entry.js")));
  const bad = /CastSpell\(|CastUntargetedSpell\(|castTargetedSpell|castUntargetedSpell|WriteToChat\(/;
  const hits = [];
  for (const f of files) {
    readFileSync(f, "utf8").split("\n").forEach((line, i) => {
      if (bad.test(line)) hits.push(`${path.relative(HW, f)}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(hits, [], hits.join("\n"));
});

await check("GetSelectedItemId (INT-2 authorized fix): the most RECENT selection wins — world after inventory, inventory after world", () => {
  const saved = { add: globalThis.addEventListener, bus: globalThis.__pluginClient, inv: globalThis.__inventory, scene: globalThis.__rynthSelClock, live: globalThis.liveScene3d };
  const et = new EventTarget();
  const busFns = [];
  globalThis.addEventListener = et.addEventListener.bind(et);
  globalThis.__pluginClient = { events: { on: (n, fn) => busFns.push([n, fn]) } };
  delete globalThis.__rynthSelClock;
  let world = 0;
  globalThis.liveScene3d = { entityManager: { getSelectedTarget: () => world } };
  globalThis.__inventory = { selectedGuid: 0 };
  try {
    const h = new RynthWebHost({ playerGuid: () => ME }, { noEventTap: true });
    const pickInv = (g) => { globalThis.__inventory.selectedGuid = g; et.dispatchEvent(new Event("hb-inventory-selection")); };
    const pickWorld = (g) => { world = g; for (const [n, fn] of busFns) if (n === "selectionChanged") fn({ guid: g }); };
    assert.equal(h.GetSelectedItemId(), 0);
    pickInv(0x7100);
    assert.equal(h.GetSelectedItemId(), 0x7100);
    pickWorld(0x80000501);
    assert.equal(h.GetSelectedItemId(), 0x80000501, "a world click after the inventory click wins (the stale-item bug)");
    pickInv(0x7200);
    assert.equal(h.GetSelectedItemId(), 0x7200, "an inventory click after the world click wins");
    // a dynamic-LOD swap of the selected rig: release ({guid:0, lodRespawn}) + re-select of the same guid
    const lodSwap = (g) => {
      world = 0;
      for (const [n, fn] of busFns) if (n === "selectionChanged") fn({ guid: 0, prevGuid: g, lodRespawn: true });
      world = g;
      for (const [n, fn] of busFns) if (n === "selectionChanged") fn({ guid: g, prevGuid: 0 });
    };
    lodSwap(0x80000501);
    assert.equal(h.GetSelectedItemId(), 0x7200, "a LOD swap of the world selection is not a newer selection");
    pickWorld(0x80000502);
    assert.equal(h.GetSelectedItemId(), 0x80000502, "a real world pick after the LOD swap still wins");
    pickInv(0x7200 + 1);
    pickWorld(0);
    assert.equal(h.GetSelectedItemId(), 0x7201, "a cleared world selection falls back to the inventory one");
    assert.equal(busFns.length, 1, "one bus hook per page");
    new RynthWebHost({ playerGuid: () => ME }, { noEventTap: true }).GetSelectedItemId();
    assert.equal(busFns.length, 1, "a second host instance shares the page clock");
  } finally {
    if (saved.add === undefined) delete globalThis.addEventListener;
    else globalThis.addEventListener = saved.add;
    if (saved.bus === undefined) delete globalThis.__pluginClient;
    else globalThis.__pluginClient = saved.bus;
    if (saved.inv === undefined) delete globalThis.__inventory;
    else globalThis.__inventory = saved.inv;
    if (saved.live === undefined) delete globalThis.liveScene3d;
    else globalThis.liveScene3d = saved.live;
    delete globalThis.__rynthSelClock;
  }
});

console.log(fail === 0 ? `rynth_vt_layer: all ${pass} checks passed` : `rynth_vt_layer: ${fail} FAILED (${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);
