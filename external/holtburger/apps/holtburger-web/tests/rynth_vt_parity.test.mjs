// tests/rynth_vt_parity.test.mjs — T-P1, the parity oracle (PLAN INT-2, §7.2.2,
// V-2): the Default VTank layer changes NOTHING the bot does.
//
// One scripted world, two bots, each built by the REAL createGrindBot over a
// fake SessionHandle (real RynthWebHost, kernel, combat/buff/loot/vitals
// loops, router, unwedge, operator control, control channel):
//   (a) config.vt = false   — the layer absent (today's code path);
//   (b) the default layer    — bot.vt attached, Default profile.
// The world: two monsters spawn and are killed with war bolts, each leaves a
// corpse with an item that is looted, the character's health drops twice (the
// vitals loop heals), a short self buff is cast and later runs low (recast). The
// clock (Date.now) is a fake advanced 250 ms per heartbeat and every heartbeat
// is an explicit host._tick() (FakeWorker), so both runs are deterministic.
// Per heartbeat we record kernel.action, kernel.status and every host ACTION
// the session received (method + args); the two traces must be identical.
// A third run of (a) proves the harness itself is deterministic, and the
// coverage assertions prove the world really drives combat, loot, vitals and
// buffing.
//
// Run from apps/holtburger-web/:  node tests/rynth_vt_parity.test.mjs

import assert from "node:assert/strict";

class FakeWorker {
  constructor() {
    this.onmessage = null;
  }
  postMessage() {}
  terminate() {}
}
globalThis.Worker = FakeWorker;
if (typeof URL.createObjectURL !== "function") URL.createObjectURL = () => "blob:vt-parity";
if (typeof URL.revokeObjectURL !== "function") URL.revokeObjectURL = () => {};

const { createGrindBot } = await import("../rynth/bot.js");

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

const ME = 0x50000001;
const LB = 0xa9b40015;
const N_TICKS = 420;
const TICK_MS = 250;
const SPELL_BOLT = 27; // Flame Bolt I (combat_loop WAR_BOLTS[0])
const SPELL_HEAL = 6; // Heal Self I (vitals healSelf ladder)
const SPELL_STR = 2; // Strength Self I (spell ladder family 1)
const CORPSE_WCID = 21;
const ODF_ATTACKABLE = 0x10;

function fmt(a) {
  if (typeof a === "number") return Number.isInteger(a) ? String(a) : a.toFixed(3);
  if (a === undefined) return "u";
  try {
    return JSON.stringify(a);
  } catch {
    return String(a);
  }
}

/** The scripted world, reacting to what the session is asked to do. */
function makeWorld() {
  const W = {
    tick: 0,
    mode: 8,
    me: { x: 150, y: 96, z: 0, h: 0 },
    ents: new Map(),
    hp: 200,
    stam: 200,
    mana: 200,
    reg: [],
    known: [SPELL_BOLT, SPELL_HEAL, SPELL_STR],
    useDone: 0,
    castBusy: 0,
    pending: [],
    inv: [],
    ground: 0,
    sticky: 0,
    moveTo: null,
    openAt: null,
    pickAt: null,
    actions: [],
    tickActions: [],
    emit: () => {},
    corpses: 0,
  };
  const act = (n, ...a) => {
    const line = `${n}(${a.map(fmt).join(",")})`;
    W.actions.push(`${W.tick}:${line}`);
    W.tickActions.push(line);
  };
  const live = (g) => {
    const e = W.ents.get(g >>> 0);
    return e && !e.gone ? e : null;
  };
  const s = {
    isPlayerReady: () => true,
    playerGuid: () => ME,
    serverTime: () => 1000 + W.tick * (TICK_MS / 1000),
    combatMode: () => W.mode,
    getBusyState: () => 0,
    getCastBusyState: () => W.castBusy,
    getUseDoneSeq: () => W.useDone,
    getLocalPlayerPose: () => ({ landblockId: LB, x: W.me.x, y: W.me.y, z: W.me.z, heading: W.me.h, free() {} }),
    objectName: (g) => ((g >>> 0) === ME ? "Tester" : W.ents.get(g >>> 0)?.name),
    objectWcid: (g) => W.ents.get(g >>> 0)?.wcid,
    objectPosition: (g) => {
      const e = live(g);
      return e ? [LB, e.x, e.y, e.z] : undefined;
    },
    objectHealthFraction: (g) => {
      const e = live(g);
      return e && e.creature ? e.hf : undefined;
    },
    objectIntProperty: (g, k) => {
      const e = W.ents.get(g >>> 0);
      if (!e) return undefined;
      if (k === 1) return e.itemType;
      if (k === 19) return e.value;
      return undefined;
    },
    objectDescFlags: (g) => {
      const e = W.ents.get(g >>> 0);
      if (!e) return undefined;
      return e.creature ? ODF_ATTACKABLE : 0;
    },
    nearbyEntityGuids: () => Uint32Array.from([...W.ents].filter(([, e]) => !e.gone && !e.carried).map(([g]) => g)),
    playerKnownSpells: () => W.known.slice(),
    playerEnchantments: () => W.reg.map((r) => ({ ...r, free() {} })),
    playerStats: () => ({
      vitals: [1, W.hp, 200, 200, 3, W.stam, 200, 200, 5, W.mana, 200, 200],
      attributes: [],
      skills: [],
      levelInfo: [50, 0, 0, 0, 0],
      free() {},
    }),
    groundContainerId: () => W.ground,
    getContainerContents: (g) => Uint32Array.from(W.ents.get(g >>> 0)?.contents ?? []),
    playerInventory: () => W.inv.map((r) => ({ ...r, free() {} })),
    localStickyTarget: () => W.sticky,
    pursuitStatus: () => 0,
    // ── actions ──
    setCombatMode: (m) => {
      act("setCombatMode", m);
      W.mode = m;
    },
    toggleCombatMode: () => act("toggleCombatMode"),
    castTargetedSpell: (t, sp) => {
      act("castTargetedSpell", t >>> 0, sp);
      W.pending.push({ t: t >>> 0, s: sp, at: W.tick + 2 });
      W.castBusy = 1;
    },
    castUntargetedSpell: (sp) => {
      act("castUntargetedSpell", sp);
      W.pending.push({ t: ME, s: sp, at: W.tick + 2 });
      W.castBusy = 1;
    },
    attack: (...a) => act("attack", ...a),
    missileAttack: (...a) => act("missileAttack", ...a),
    cancelAttack: () => act("cancelAttack"),
    stickToEntity: (g) => {
      act("stickToEntity", g >>> 0);
      W.sticky = g >>> 0;
    },
    stopStick: () => {
      act("stopStick");
      W.sticky = 0;
    },
    cancelPursuit: () => {
      act("cancelPursuit");
      W.moveTo = null;
    },
    moveToPosition: (cell, x, y, z, run) => {
      act("moveToPosition", cell >>> 0, x, y, z, run);
      W.moveTo = { x, y, z };
    },
    pursueEntity: (...a) => act("pursueEntity", ...a),
    turnToHeading: (r) => {
      act("turnToHeading", r);
      W.me.h = r;
    },
    useObject: (g) => {
      act("useObject", g >>> 0);
      const e = live(g);
      if (e && e.corpse && Math.hypot(e.x - W.me.x, e.y - W.me.y) <= 5) W.openAt = { g: g >>> 0, at: W.tick + 2 };
    },
    moveItem: (item, dest, slot) => {
      act("moveItem", item >>> 0, dest >>> 0, slot);
      W.pickAt = { item: item >>> 0, at: W.tick + 2 };
    },
    putItemInContainer: (...a) => act("putItemInContainer", ...a),
    requestAppraisal: (g) => act("requestAppraisal", g >>> 0),
    queryHealth: (g) => act("queryHealth", g >>> 0),
    sendChat: (t) => act("sendChat", t),
    sendTell: (...a) => act("sendTell", ...a),
    noteLocalCastWindow: (...a) => act("noteLocalCastWindow", ...a),
    forceResetBusyCount: () => act("forceResetBusyCount"),
    tickMovement: () => act("tickMovement"),
    setMovementInput: (...a) => act("setMovementInput", ...a),
    jump: (...a) => act("jump", ...a),
  };
  W.session = s;
  return W;
}

function spawn(W, guid, name, x, y) {
  W.ents.set(guid, { name, wcid: 1000 + (guid & 0xff), x, y, z: 0, hf: 1, creature: true, itemType: 16 });
}

/** Advance the world to heartbeat `i` (before the bot's tick for it). */
function stepWorld(W, i) {
  W.tick = i;
  W.tickActions = [];
  if (i === 30) spawn(W, 0x80000101, "Drudge Skulker", 156, 97);
  if (i === 150) spawn(W, 0x80000102, "Mosswart", 151, 110);
  if (i === 60) W.hp = Math.max(1, W.hp - 120); // a heavy hit: below HealAt (60 %) in combat
  if (i === 175) W.hp = Math.max(1, W.hp - 130);
  if (W.castBusy && !W.pending.some((p) => p.at > i)) W.castBusy = 0;
  // casts resolve two heartbeats after issue: UseDone + their effect
  for (const c of W.pending.splice(0)) {
    if (c.at > i) {
      W.pending.push(c);
      continue;
    }
    W.useDone++;
    if (c.s === SPELL_BOLT) {
      const e = W.ents.get(c.t);
      if (e && !e.gone && e.creature) {
        e.hf = Math.max(0, e.hf - 0.35);
        W.emit({ kind: 2, stringPayload: `You singe ${e.name} for 14 points with Flame Bolt I.`, u32Payload: 0, u32Payload2: 0 });
      }
    } else if (c.s === SPELL_HEAL) {
      W.hp = Math.min(200, W.hp + 70);
      W.emit({ kind: 2, stringPayload: "You cast Heal Self I and restore 70 points of your health.", u32Payload: 0, u32Payload2: 0 });
    } else if (c.s === SPELL_STR) {
      // A short buff (6 min): it falls under the 300 s rebuff threshold about
      // a minute after it lands, so the loop recasts it inside the run. Each
      // landing is a new wire row (start time), like a real refresh.
      W.strCasts = (W.strCasts || 0) + 1;
      W.reg = W.reg.filter((r) => r.spellId !== SPELL_STR);
      W.reg.push({ spellId: SPELL_STR, spellCategory: 1, startTime: -0.01 * W.strCasts, duration: 360, layer: 1 });
      W.emit({ kind: 2, stringPayload: "You cast Strength Self I and feel stronger.", u32Payload: 0, u32Payload2: 0 });
    }
    W.emit({ kind: 14, stringPayload: "", u32Payload: 0, u32Payload2: 0 });
  }
  // deaths → kind 29, then the corpse swap
  for (const [g, e] of [...W.ents]) {
    if (!e.creature || e.gone) continue;
    if (e.hf === 0 && e.diedAt == null) {
      e.diedAt = i;
      W.emit({ kind: 29, stringPayload: `${e.name} has been slain!`, u32Payload: g, u32Payload2: ME });
    } else if (e.diedAt != null && i - e.diedAt >= 2) {
      e.gone = true;
      const n = ++W.corpses;
      const cg = 0x80001000 + n;
      const ig = 0x80002000 + n;
      W.ents.set(ig, { name: `Pyreal Mote ${n}`, wcid: 3000 + n, x: e.x, y: e.y, z: 0, itemType: 0x80, value: 120, carried: true });
      W.ents.set(cg, { name: `Corpse of ${e.name}`, wcid: CORPSE_WCID, x: e.x, y: e.y, z: 0, corpse: true, itemType: 0x200, contents: [ig] });
    }
  }
  if (W.openAt && W.openAt.at <= i) {
    W.ground = W.openAt.g;
    W.openAt = null;
  }
  if (W.pickAt && W.pickAt.at <= i) {
    const it = W.pickAt.item;
    W.pickAt = null;
    for (const [, e] of W.ents) if (e.corpse && Array.isArray(e.contents)) e.contents = e.contents.filter((x) => x !== it);
    const ent = W.ents.get(it);
    if (ent) W.inv.push({ guid: it, name: ent.name, wcid: ent.wcid, stackSize: 1, containerId: 0, equipMask: 0, itemType: ent.itemType });
    W.emit({ kind: 11, stringPayload: "", u32Payload: 0, u32Payload2: 0 });
  }
  // movement: a run-to target or a stick pulls the body 2 m per heartbeat
  const goal = W.moveTo || (W.sticky && W.ents.get(W.sticky) && !W.ents.get(W.sticky).gone ? W.ents.get(W.sticky) : null);
  if (goal) {
    const dx = goal.x - W.me.x;
    const dy = goal.y - W.me.y;
    const d = Math.hypot(dx, dy);
    const stopAt = W.moveTo ? 0.5 : 2;
    if (d > stopAt) {
      const k = Math.min(2, d - stopAt) / d;
      W.me.x += dx * k;
      W.me.y += dy * k;
    } else if (W.moveTo) W.moveTo = null;
  }
}

async function run(config, label) {
  const realNow = Date.now;
  let NOW = 1_760_000_000_000;
  Date.now = () => NOW;
  const realLog = console.log;
  const realWarn = console.warn;
  console.log = () => {};
  console.warn = () => {};
  const W = makeWorld();
  const trace = [];
  let bot = null;
  try {
    bot = await createGrindBot(W.session, {
      hz: 10,
      ai: false,
      buffs: [SPELL_STR],
      loot: { minValue: 0 },
      ...config,
    });
    W.emit = (e) => bot.host._dispatchEvent(e);
    for (let i = 0; i < N_TICKS; i++) {
      NOW += TICK_MS;
      stepWorld(W, i);
      // The operator re-applies the buff list (HUD / director set_buffs).
      // Besides being a real event, it resets buff_loop's B11 batch pass,
      // which otherwise never completes once the kernel stops giving the loop
      // the tick (a pre-existing behaviour reported by INT-2): the short buff
      // can then run low and be recast inside the run.
      if (i === 200) await bot.setBuffs([SPELL_STR]);
      bot.host._tick();
      const ks = bot.kernel.status;
      trace.push(JSON.stringify({ i, a: bot.kernel.action, acts: W.tickActions, ks }));
    }
    return { label, trace, actions: W.actions.slice(), W, vt: !!bot.vt, aux: !!bot.kernel.aux, kills: bot.kernel.status.kills, looted: bot.kernel.status.looted };
  } finally {
    try {
      bot?.stop();
    } catch {
      /* teardown */
    }
    Date.now = realNow;
    console.log = realLog;
    console.warn = realWarn;
  }
}

const A = await run({ vt: false }, "layer absent");
const A2 = await run({ vt: false }, "layer absent (again)");
const B = await run({}, "default layer");

function firstDiff(x, y) {
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) if (x[i] !== y[i]) return { i, a: x[i], b: y[i] };
  return null;
}

await check("the harness is deterministic: two layer-absent runs are identical", () => {
  const d = firstDiff(A.trace, A2.trace);
  assert.equal(d, null, d ? `tick ${d.i}\n  a: ${d.a}\n  b: ${d.b}` : "");
});

await check("the runs are what they claim: (a) no layer, no aux; (b) bot.vt attached with the aux shell", () => {
  assert.equal(A.vt, false);
  assert.equal(A.aux, false);
  assert.equal(B.vt, true);
  assert.equal(B.aux, true);
});

await check("the world drives every loop: Combat, Loot, Vitals and Buffing in the trace; bolts, heals, buff casts, corpse opens and pickups on the wire", () => {
  const actions = new Set(A.trace.map((t) => JSON.parse(t).a));
  for (const a of ["Combat", "Loot", "Vitals", "Buffing", "Idle"]) assert.ok(actions.has(a), `kernel action ${a} seen (${[...actions].join(", ")})`);
  const has = (re) => A.actions.some((x) => re.test(x));
  assert.ok(has(new RegExp(`castTargetedSpell\\(${0x80000101},${SPELL_BOLT}\\)`)), "bolts at the first monster");
  assert.ok(has(new RegExp(`castTargetedSpell\\(${0x80000102},${SPELL_BOLT}\\)`)), "bolts at the second monster");
  assert.ok(has(new RegExp(`(castTargetedSpell\\(${ME},${SPELL_HEAL}\\)|castUntargetedSpell\\(${SPELL_HEAL}\\))`)), "a heal");
  const strCasts = A.actions.filter((x) => new RegExp(`(castTargetedSpell\\(${ME},${SPELL_STR}\\)|castUntargetedSpell\\(${SPELL_STR}\\))`).test(x));
  assert.ok(strCasts.length >= 2, `the buff is cast, expires and is recast (${strCasts.length})`);
  assert.ok(has(/useObject\(/), "a corpse is opened");
  assert.ok(has(/moveItem\(/), "an item is picked up");
  assert.ok(A.kills >= 2, `kills ${A.kills}`);
  assert.ok(A.looted >= 1, `looted ${A.looted}`);
});

await check("T-P1: identical kernel.action trace, kernel.status and host action log with the Default layer (V-2)", () => {
  const d = firstDiff(A.trace, B.trace);
  assert.equal(d, null, d ? `first divergence at tick ${d.i}\n  absent : ${d.a}\n  layer  : ${d.b}` : "");
  assert.deepEqual(B.actions, A.actions);
  assert.equal(B.trace.length, N_TICKS);
});

console.log(fail === 0 ? `rynth_vt_parity: all ${pass} checks passed` : `rynth_vt_parity: ${fail} FAILED (${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);
