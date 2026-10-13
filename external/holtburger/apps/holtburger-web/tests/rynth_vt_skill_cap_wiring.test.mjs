// tests/rynth_vt_skill_cap_wiring.test.mjs — the VT option BuffTierSkillCap
// (+ BuffMinSkillLevelTier1..8) projected onto the buff / vitals loops'
// setSkillCap by rynth/vt/index.js (review Y-R2; the loops' opt-in cap is
// rynth-macro-nav-4, rynth/skill_cap.js).
//
//   W1  Default (option off): attach + 1 Hz upkeep never call setSkillCap and
//       never read the player's skills (byte-identical, V-2)
//   W2  turning it on hands both loops ONE cap over the host's buffed skills,
//       at the RynthAi default thresholds
//   W3  a threshold change hands both loops a new cap at the new thresholds
//   W4  a buff loop bot.setBuffs replaced gets the cap at the next 1 Hz upkeep
//   W5  turning it off hands both loops null; off again touches nothing
//   W6  a takeover rebind (same page session) with the option on applies it
//       at attach; dispose hands both loops null
//
// The fake host/bot follow tests/rynth_vt_layer.test.mjs (only the members the
// layer reads at attach and in its 1 Hz upkeep).
//
// Run from apps/holtburger-web/:  node tests/rynth_vt_skill_cap_wiring.test.mjs

import assert from "node:assert/strict";

const VT = await import("../rynth/vt/index.js");
const { SCHOOL } = await import("../rynth/skill_cap.js");

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
const statsReads = (W) => W.calls.filter((c) => c === "TryGetPlayerStats").length;

await check("W1 Default (option off): attach and the 1 Hz upkeep never call setSkillCap nor read the skills", async () => {
  const { host, W } = makeHost();
  const bot = makeBot({ host });
  const layer = await layerOn(bot);
  try {
    assert.equal(layer.options.getValue("BuffTierSkillCap"), false);
    for (let i = 0; i < 5; i++) oneHz(layer);
    bot.buff = capLoop({ setItemBuffs: () => 0, itemBuffs: [] }); // bot.setBuffs built a new loop
    oneHz(layer);
    assert.deepEqual(bot.vitals.caps, []);
    assert.deepEqual(bot.buff.caps, []);
    assert.equal(statsReads(W), 0);
  } finally {
    layer.dispose();
  }
  assert.deepEqual(bot.vitals.caps, [], "dispose of a never-projected cap touches nothing");
});

await check("W2-W5 on -> one host cap on both loops; thresholds -> a new cap; a replaced buff loop gets it; off -> null", async () => {
  const { host, W } = makeHost();
  const bot = makeBot({ host });
  const layer = await layerOn(bot);
  try {
    // W2
    assert.equal(layer.options.set("BuffTierSkillCap", true, { source: "ui" }).ok, true);
    assert.equal(bot.buff.caps.length, 1);
    assert.equal(bot.vitals.caps.length, 1);
    const cap = bot.buff.caps[0];
    assert.equal(typeof cap, "function");
    assert.equal(bot.vitals.caps[0], cap, "one cap (one 5 s skills read) serves both loops");
    assert.equal(cap(SCHOOL.Life), 4, "Life 200 at 35..435 -> tier 4");
    assert.equal(cap(SCHOOL.Creature), 6, "Creature 300 -> tier 6");
    assert.equal(cap(SCHOOL.War), 0, "untrained -> 0");
    assert.equal(statsReads(W), 1);
    oneHz(layer);
    assert.equal(bot.buff.caps.length, 1, "the upkeep re-applies nothing while nothing changed");
    // W3
    assert.equal(layer.options.set("BuffMinSkillLevelTier5", 200, { source: "ui" }).ok, true);
    assert.equal(bot.buff.caps.length, 2);
    assert.equal(bot.vitals.caps.length, 2);
    const cap2 = bot.buff.caps[1];
    assert.notEqual(cap2, cap);
    assert.equal(bot.vitals.caps[1], cap2);
    assert.equal(cap2(SCHOOL.Life), 5, "Life 200 now reaches tier 5");
    // W4
    const vitalsCaps = bot.vitals.caps.length;
    bot.buff = capLoop({ setItemBuffs: () => 0, itemBuffs: [] });
    oneHz(layer);
    assert.deepEqual(bot.buff.caps, [cap2], "the new buff loop gets the current cap");
    assert.equal(bot.vitals.caps.length, vitalsCaps, "the unchanged vitals loop is not re-set");
    // W5
    assert.equal(layer.options.set("BuffTierSkillCap", false, { source: "ui" }).ok, true);
    assert.deepEqual(bot.buff.caps, [cap2, null]);
    assert.equal(bot.vitals.caps[bot.vitals.caps.length - 1], null);
    const n = bot.vitals.caps.length;
    assert.equal(layer.options.set("BuffMinSkillLevelTier6", 250, { source: "ui" }).ok, true);
    bot.buff = capLoop({ setItemBuffs: () => 0, itemBuffs: [] });
    oneHz(layer);
    assert.deepEqual(bot.buff.caps, [], "off again: a new loop is left alone");
    assert.equal(bot.vitals.caps.length, n);
  } finally {
    layer.dispose();
  }
});

await check("W6 a takeover rebind on the same page session with the option on applies it at attach; dispose hands both loops null", async () => {
  const { host } = makeHost();
  const win = { localStorage: memStorage() }; // one page: the session (and its overlay) outlives the bot
  const bot1 = makeBot({ host });
  const l1 = await layerOn(bot1, win);
  assert.equal(l1.options.set("BuffTierSkillCap", true, { source: "ui" }).ok, true);
  l1.dispose(); // flushes the overlay; hands the cap back
  assert.equal(bot1.buff.caps[bot1.buff.caps.length - 1], null);
  assert.equal(bot1.vitals.caps[bot1.vitals.caps.length - 1], null);
  const bot2 = makeBot({ host });
  const l2 = await layerOn(bot2, win);
  try {
    assert.equal(l2.options.getValue("BuffTierSkillCap"), true);
    assert.equal(bot2.buff.caps.length, 1);
    assert.equal(typeof bot2.buff.caps[0], "function");
    assert.equal(bot2.vitals.caps[0], bot2.buff.caps[0]);
  } finally {
    l2.dispose();
  }
  assert.equal(bot2.buff.caps[bot2.buff.caps.length - 1], null);
});

console.log(fail === 0 ? `rynth_vt_skill_cap_wiring: all ${pass} checks passed` : `rynth_vt_skill_cap_wiring: ${fail} FAILED (${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);
