// tests/rynth_vt_buff_spec_migration.test.mjs — rynth/vt/index.js (12c): a
// profile's buff list stays on the scroll ladder (2026-10-19).
//
// spell_ladders.json marks each buff family's scroll spells, and the buff loop
// casts an off-ladder id in a spec exactly as named (a deliberate pick). A VT
// list is the Buffs tab's family selection — one saved before the ladder flags
// could name Zongo's Fist for Strength — so once the buff module and its table
// are loaded the layer rewrites any off-ladder id onto its family's ladder
// (buff_loop.js toLadderSpec) through options.setList (the same push to
// bot.setBuffs a Buffs-tab edit makes).
//
//   M1  an off-ladder id is rewritten to its family's tier-I ladder spell and
//       pushed to the bot; the ladder ids of the list are kept, in order
//   M2  a list already on the ladder is never written
//   M3  "auto" (no ids) is left alone
//
// The fake host/bot are rynth_vt_skill_cap_wiring.test.mjs's.
//
// Run from apps/holtburger-web/:  node tests/rynth_vt_buff_spec_migration.test.mjs

import assert from "node:assert/strict";

const VT = await import("../rynth/vt/index.js");
const BL = await import("../rynth/buff_loop.js");

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

/** A recording fake RynthWebHost (rynth_vt_layer.test.mjs shape). */
function makeHost() {
  const W = {
    calls: [], subs: [], ticks: [],
    // Life 200 (tier 4 at 35..435), Creature 300 (tier 6), War untrained.
    skills: { 33: { current: 200, base: 150, training: 2 }, 31: { current: 300, base: 250, training: 3 }, 34: { current: 10, base: 10, training: 1 } },
  };
  const base = {
    get snap() {
      return { seq: 1 };
    },
    nearbyRangeM: 60,
    s: { playerGuid: () => ME },
    has: (c) => c === "IsPortalSpaceActive",
    GetPlayerId: () => ME,
    TryGetObjectName: (g) => (g === ME ? "Tester" : null),
    TryGetObjectWcid: () => null,
    TryGetPlayerPose: () => ({ objCellId: LB, x: 100, y: 100, z: 0, heading: 0 }),
    IsPortalSpaceActive: () => false,
    NearbyGuids: () => [],
    GetBusyState: () => 0,
    GetGroundContainerId: () => 0,
    TryGetKnownSpells: () => [],
    TryGetPlayerInventory: () => [],
    TryGetPlayerInventoryCached: () => [],
    TryGetPackRoomCached: () => ({ main: { used: 10, cap: 102, free: 92 } }),
    TryGetBurden: () => 42,
    TryGetSelfEnchantments: () => [],
    TryGetObjectIntProperty: () => undefined,
    TryGetObjectDoubleProperty: () => undefined,
    TryGetObjectStringProperty: () => undefined,
    TryGetObjectBoolProperty: () => undefined,
    TryGetObjectDataIdProperty: () => undefined,
    TryGetObjectDescFlags: () => 0,
    TryGetObjectInstanceIdProperty: () => undefined,
    TryGetObjectDistance: () => null,
    TryGetTargetHealthFraction: () => -1,
    ObjectIsAttackable: () => true,
    ObjectIsPlayer: () => false,
    HasAppraisalData: () => false,
    TryGetObjectAppraisal: () => null,
    TryGetPlayerStats: () => ({ level: 50, skills: W.skills }),
    get itemActionToken() {
      return null;
    },
    onEvent: (fn) => W.subs.push(fn),
    onTick: (fn) => W.ticks.push(fn),
    WriteToChatWindow: () => false,
  };
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
  return { host, W };
}

/** A loop fake that records every setSkillCap call. */
function capLoop(extra) {
  return {
    enabled: true, caps: [],
    setSkillCap(fn) {
      this.caps.push(fn);
      this.skillCap = typeof fn === "function" ? fn : null;
    },
    ...extra,
  };
}

function makeBot({ host }) {
  const bot = {
    host,
    kernel: { action: "Idle", operatorHeld: false, running: true, aux: VT.createAuxShell() },
    combat: {
      enabled: true, monsterRangeM: 40, priorities: {}, meleePower: 0.6, missileAccuracy: 0.6, attackHeight: 2,
      blacklistAttempts: 3, blacklistTimeoutMs: 30_000, vt: null, acquireRangeFn: null,
      invalidateScan() {}, underAttack: () => false, disengage() {},
    },
    vitals: capLoop({
      cfg: { healAtCombat: 60, getManaAtCombat: 40, restamAtCombat: 30, topOffHp: 95, topOffStam: 95, topOffMana: 95, emergencyHp: 30, emergencyStamFloor: 20, manaRechargeStamFloor: 15 },
    }),
    loot: { enabled: true, state: "SCAN", minValue: 0, corpseRangeM: 30, classify: null },
    buff: capLoop({
      rebuffSecondsRemaining: 300, idleRebuffWindowS: 0, itemBuffs: [],
      setItemBuffs(l) { this.itemBuffs = l.slice(); return l.length; },
      needsBuff: () => false, desired: [], pending: null, status: { desired: 0, active: 0, ready: true },
    }),
    router: { status: { state: "IDLE" }, route: [], follow() {}, cancel() {} },
    unwedge: { allowEscalation: null, active: () => false },
    buffSpec: null,
    setBuffs: async (spec) => { bot.buffSpec = spec; return []; },
    claimMovement: () => () => {},
    movementClaimed: () => false,
    control: { setEnabled(name, on) { const loop = bot[name]; if (loop) loop.enabled = !!on; return { ok: true }; } },
  };
  return bot;
}

/** A Map-backed localStorage. */
function memStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    key: (i) => [...m.keys()][i] ?? null,
    get length() { return m.size; },
  };
}

let clockT = 1_000_000;
async function layerOn(bot, win = { localStorage: null }) {
  return VT.createVtLayer(bot, { aux: bot.kernel.aux, win, storage: win.localStorage, log: quiet, now: () => clockT, print: quiet });
}
// One pre-tick a second later: the layer's 1 Hz upkeep runs.
function oneHz(layer) {
  clockT += 1_100;
  layer.preTick(clockT);
}
const ladder = await BL.loadSpellLadders();
const ZONGO = 3864; // Zongo's Fist — Strength family (1), off the scroll ladder
const FOCUS_VI = 1426; // Focus Self VI — on the ladder
const STR_I = 2; // Strength Self I — the Strength ladder's first rung
const settle = () => new Promise((r) => setTimeout(r, 25));

/** 1 Hz upkeep until `done()` (the buff module loads asynchronously), ≤ 2 s. */
async function upkeepUntil(layer, done) {
  for (let i = 0; i < 80 && !done(); i++) {
    await settle();
    oneHz(layer);
  }
}

await check("the fixture: Zongo's Fist is off the ladder, Focus Self VI and Strength Self I are on it", () => {
  assert.equal(BL.isCanonicalBuff(ZONGO, ladder), false);
  assert.equal(BL.isCanonicalBuff(FOCUS_VI, ladder), true);
  assert.deepStrictEqual(BL.toLadderSpec([ZONGO, FOCUS_VI], ladder), [STR_I, FOCUS_VI]);
});

await check("M1 an off-ladder id is rewritten onto its family's ladder and pushed to the bot", async () => {
  const { host } = makeHost();
  const bot = makeBot({ host });
  const pushed = [];
  bot.setBuffs = async (spec) => { pushed.push(Array.isArray(spec) ? spec.slice() : spec); bot.buffSpec = spec; return []; };
  const layer = await layerOn(bot, { localStorage: memStorage() });
  try {
    assert.equal(layer.options.saveAs("Hunt", { mineOnly: false }).ok, true);
    assert.equal(layer.options.setList("buffs", { spec: [ZONGO, FOCUS_VI], disabled: [], itemSpells: {} }, { source: "ui" }).ok, true);
    await upkeepUntil(layer, () => (layer.options.getList("buffs").spec || [])[0] === STR_I);
    assert.deepStrictEqual(layer.options.getList("buffs").spec, [STR_I, FOCUS_VI], "rewritten, order kept");
    assert.deepStrictEqual(pushed.at(-1), [STR_I, FOCUS_VI], "the bot got the ladder list");
    const n = pushed.length;
    for (let i = 0; i < 3; i++) oneHz(layer);
    assert.equal(pushed.length, n, "written once");
  } finally {
    layer.dispose();
  }
});

await check("M2 a list already on the ladder is never written; M3 auto is left alone", async () => {
  const { host } = makeHost();
  const bot = makeBot({ host });
  const layer = await layerOn(bot, { localStorage: memStorage() });
  try {
    assert.equal(layer.options.saveAs("Hunt", { mineOnly: false }).ok, true);
    assert.equal(layer.options.setList("buffs", { spec: [STR_I, FOCUS_VI], disabled: [], itemSpells: {} }, { source: "ui" }).ok, true);
    let writes = 0;
    const off = layer.options.onChange((e) => { if (e && e.kind === "list" && e.key === "buffs") writes++; });
    for (let i = 0; i < 20; i++) {
      await settle();
      oneHz(layer);
    }
    assert.equal(writes, 0, "on the ladder: no write");
    assert.equal(layer.options.setList("buffs", { spec: "auto", disabled: [], itemSpells: {} }, { source: "ui" }).ok, true);
    writes = 0;
    for (let i = 0; i < 5; i++) oneHz(layer);
    assert.equal(writes, 0, "auto: no write");
    assert.equal(layer.options.getList("buffs").spec, "auto");
    off?.();
  } finally {
    layer.dispose();
  }
});

console.log(fail === 0 ? `rynth_vt_buff_spec_migration: all ${pass} checks passed` : `rynth_vt_buff_spec_migration: ${fail} FAILED (${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);
