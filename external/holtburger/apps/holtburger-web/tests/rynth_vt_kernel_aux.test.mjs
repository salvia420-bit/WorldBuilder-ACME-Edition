// tests/rynth_vt_kernel_aux.test.mjs — rynth/kernel.js `aux` slots (PLAN INT-1,
// §3.13; T-K1, T-K2, O17-O20; V-10, V-23, critic B7).
//
// T-K1  `aux` undefined: the kernel is the pre-VT kernel. A frozen copy of the
//       pre-change class (below, comments stripped, code verbatim) and the live
//       kernel are driven through the same randomized world (seeded) and must
//       produce the same action trace AND the same call log (loop ticks,
//       disengage/StopStick/StopCompletely, scans, corpse/buff reads, log lines)
//       and the same status on every tick, across loop-shape variants.
// T-K2  `aux` = the empty shell (and = a shell whose slots/hooks are all
//       disabled, i.e. the Default profile): exhaustive 2^6 pin combinations
//       (combatPinned, threat, lootPinned, buffPinned, corpse, buffNeeded) from
//       every prior action, plus the randomized sequences — identical to the
//       frozen kernel, side effects included.
// Then the aux contract: boost-loot order with/without underAttack;
// beforeCombatPinned / beforeCombat / beforeIdle placement; afterVitals
// pinned-then-wants; afterUnwedge pinned-only; onLeave on every action change
// (Vitals/Unwedge preempts, slot→slot, stop(), holdForOperator());
// keepsCombatLoop borrow; idle hooks only on Idle; nothing runs while the
// kernel is stopped or operator-held; status shape unchanged unless a slot or
// hook is enabled; a throwing slot never breaks the tick; the KernelCtx shapes.
//
// Run from apps/holtburger-web/:  node tests/rynth_vt_kernel_aux.test.mjs

import assert from "node:assert/strict";

const { RynthBotKernel } = await import("../rynth/kernel.js");

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

// ── frozen copy of the pre-VT kernel (rynth/kernel.js @ a33dcb16 = 008a22ae) ──
// Comments stripped, code verbatim. This is the T-K1/T-K2 oracle: do NOT edit
// it to follow later kernel changes — it pins "the layer absent / empty".
class FrozenKernel {
  constructor(host, { combat, buff, loot, vitals, unwedge }, opts = {}) {
    this.host = host;
    this.combat = combat;
    this.buff = buff;
    this.loot = loot;
    this.vitals = vitals;
    this.unwedge = unwedge;
    this.log = opts.log || ((m) => console.log(`[kernel] ${m}`));
    this.action = "Idle";
    this._running = false;
    this._tickInstalled = false;
    this._operatorHeld = false;
    this._combatHeld = false;
    this._pausedBy = null;
  }
  start() {
    if (this._operatorHeld) {
      this.log("start refused: operator hold is active (resume via the control channel)");
      return false;
    }
    this._running = true;
    this._pausedBy = null;
    if (this.buff && !this.buff.startedAt) this.buff.startedAt = Date.now();
    if (!this._tickInstalled) {
      this._tickInstalled = true;
      this.host.onTick(() => {
        if (this._running) {
          try {
            this.tick();
          } catch (e) {
            this.log(`tick threw: ${e.message}`);
          }
        }
      });
    }
    this.log("started");
    return true;
  }
  stop() {
    this._running = false;
    if (this.action === "Combat" || this._combatHeld) {
      this._leaveCombat("Stopped");
      this.action = "Idle";
    }
  }
  get running() {
    return this._running;
  }
  pauseFor(who = "pause") {
    this._pausedBy = String(who || "pause");
    this.stop();
  }
  get pausedBy() {
    return this._pausedBy;
  }
  _leaveCombat(next) {
    const c = this.combat;
    const keepLoop = next === "Vitals";
    if (c && typeof c.disengage === "function") c.disengage({ cancelAttack: !keepLoop });
    else this.host.StopStick();
    this._combatHeld = keepLoop;
  }
  _cancelLootApproach() {
    if (!this.loot || this.loot.state !== "APPROACH") return;
    if (typeof this.host.StopCompletely === "function") this.host.StopCompletely();
  }
  holdForOperator() {
    this._operatorHeld = true;
    this.stop();
  }
  releaseOperatorHold() {
    this._operatorHeld = false;
  }
  get operatorHeld() {
    return this._operatorHeld;
  }
  _threatPresent() {
    return this.combat ? this.combat._scanTargets().length > 0 : false;
  }
  _threatAvailable() {
    if (!this.combat) return false;
    if (typeof this.combat.canEngage === "function" && !this.combat.canEngage()) return false;
    return this._threatPresent();
  }
  _corpseAvailable() {
    return this.loot ? !!this.loot._findCorpse() : false;
  }
  _buffNeeded() {
    if (!this.buff || this.buff.enabled === false) return false;
    const st = this.buff.status;
    if (st.blocked && st.pending === 0) return false;
    return !st.ready || st.active < st.desired || st.pending !== 0;
  }
  tick() {
    if (!this.host.IsPlayerReady()) return;
    if (this.buff && this.buff.enabled !== false && this.buff.heartbeat) this.buff.heartbeat();
    if (this.vitals && this.vitals.enabled !== false) {
      const inCombat = (this.combat && this.combat.locked !== 0) || this._threatPresent();
      if (this.vitals.step(inCombat)) {
        if (this.action !== "Vitals") {
          this.log(`${this.action} -> Vitals`);
          if (this.action === "Combat") this._leaveCombat("Vitals");
          this.action = "Vitals";
        }
        return;
      }
    }
    if (this.unwedge && typeof this.unwedge.active === "function" && this.unwedge.active()) {
      if (this.action !== "Unwedge") {
        this.log(`${this.action} -> Unwedge`);
        if (this.action === "Combat" || this._combatHeld) this._leaveCombat("Unwedge");
        this.action = "Unwedge";
      }
      return;
    }
    const combatPinned = this.combat && this.combat.locked !== 0;
    const lootPinned = this.loot && this.loot.enabled !== false && this.loot.state !== "SCAN";
    const buffPinned = this.buff && this.buff.enabled !== false && this.buff.pending !== null;
    const threat = this._threatAvailable();
    let next;
    if (combatPinned || threat) next = "Combat";
    else if (lootPinned) next = "Loot";
    else if (buffPinned) next = "Buffing";
    else if (this._corpseAvailable()) next = "Loot";
    else if (this._buffNeeded()) next = "Buffing";
    else next = "Idle";
    if (next !== this.action) {
      this.log(`${this.action} -> ${next}`);
      if (this.action === "Combat" && next !== "Combat") this._leaveCombat(next);
      else if (this._combatHeld && next !== "Combat") this._leaveCombat(next);
      if (next === "Combat") this._combatHeld = false;
      if (next === "Combat" && this.action === "Loot") this._cancelLootApproach();
      this.action = next;
    }
    switch (next) {
      case "Combat":
        this.combat.tick();
        return;
      case "Loot":
        this.loot.tick();
        return;
      case "Buffing":
        this.buff.tick();
        return;
      default:
        return;
    }
  }
  get status() {
    return {
      action: this.action,
      running: this._running,
      operatorHeld: this._operatorHeld,
      pausedBy: this._pausedBy,
      kills: this.combat ? this.combat.kills : 0,
      looted: this.loot ? this.loot.lootedCount : 0,
      buffs: this.buff ? this.buff.status : null,
      vitals: this.vitals ? this.vitals.status : null,
      combat: this.combat && this.combat.status ? this.combat.status : null,
    };
  }
}

// ── a scripted world of fake loops that log every call ─────────────────────
// `shape` drops parts to cover the optional-loop paths: { combat:false,
// canEngage:false, disengage:false, loot:false, buff:false, heartbeat:false,
// vitals:false, unwedge:false }.
function makeWorld(shape = {}) {
  const log = [];
  const st = {
    ready: true,
    locked: 0,
    scan: [],
    canEngage: true,
    underAttack: false,
    lootEnabled: true,
    lootState: "SCAN",
    corpse: false,
    buffEnabled: true,
    pending: null,
    bstatus: { ready: true, desired: 3, active: 3, pending: 0, blocked: null },
    vitalsEnabled: true,
    vitalsStep: false,
    unwedgeActive: false,
  };
  const host = {
    IsPlayerReady: () => st.ready,
    StopStick: () => log.push("host.StopStick"),
    StopCompletely: () => log.push("host.StopCompletely"),
    onTick: (fn) => {
      log.push("host.onTick");
      host._tickFn = fn;
    },
  };
  let combat = null;
  if (shape.combat !== false) {
    combat = {
      get locked() {
        return st.locked;
      },
      kills: 0,
      status: { state: "IDLE" },
      _scanTargets() {
        log.push("combat.scan");
        return st.scan;
      },
      tick() {
        log.push("combat.tick");
      },
      underAttack() {
        log.push("combat.underAttack"); // lazy in the aux ctx: never read at Default
        return st.underAttack;
      },
    };
    if (shape.canEngage !== false)
      combat.canEngage = () => {
        log.push("combat.canEngage");
        return st.canEngage;
      };
    if (shape.disengage !== false) combat.disengage = (o) => log.push(`combat.disengage:${o && o.cancelAttack}`);
  }
  const loot =
    shape.loot === false
      ? null
      : {
          get enabled() {
            return st.lootEnabled;
          },
          get state() {
            return st.lootState;
          },
          lootedCount: 0,
          _findCorpse() {
            log.push("loot.findCorpse");
            return st.corpse ? { guid: 0x7001, d: 5 } : null;
          },
          tick() {
            log.push("loot.tick");
          },
        };
  let buff = null;
  if (shape.buff !== false) {
    buff = {
      get enabled() {
        return st.buffEnabled;
      },
      get pending() {
        return st.pending;
      },
      startedAt: 0,
      get status() {
        log.push("buff.status");
        return { ...st.bstatus };
      },
      tick() {
        log.push("buff.tick");
      },
    };
    if (shape.heartbeat !== false) buff.heartbeat = () => log.push("buff.heartbeat");
  }
  const vitals =
    shape.vitals === false
      ? null
      : {
          get enabled() {
            return st.vitalsEnabled;
          },
          status: { ok: true },
          step(inCombat) {
            log.push(`vitals.step:${inCombat}`);
            return st.vitalsStep;
          },
        };
  const unwedge =
    shape.unwedge === false
      ? null
      : {
          active() {
            log.push("unwedge.active");
            return st.unwedgeActive;
          },
        };
  return { st, log, host, loops: { combat, buff, loot, vitals, unwedge } };
}

function kernelLog(w) {
  return (m) => w.log.push(`log:${m}`);
}

// mulberry32 — a small deterministic PRNG for the scripted worlds
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// One random world step: sticky state with occasional flips, plus the
// external calls the bot makes on a kernel (stop/start/hold/pause).
function randomStep(r, st) {
  const flip = (p) => r() < p;
  if (flip(0.15)) st.locked = st.locked ? 0 : 0x80000100 + Math.floor(r() * 4);
  if (flip(0.2)) st.scan = st.scan.length ? [] : [{ guid: 0x80000101, score: 90, dist: 10 }];
  if (flip(0.05)) st.canEngage = !st.canEngage;
  if (flip(0.1)) st.underAttack = !st.underAttack;
  if (flip(0.04)) st.lootEnabled = !st.lootEnabled;
  if (flip(0.15)) st.lootState = ["SCAN", "SCAN", "APPROACH", "OPEN", "LOOT", "CONFIRM"][Math.floor(r() * 6)];
  if (flip(0.15)) st.corpse = !st.corpse;
  if (flip(0.04)) st.buffEnabled = !st.buffEnabled;
  if (flip(0.15)) st.pending = st.pending ? null : { spellId: 1011, issuedAt: 1 };
  if (flip(0.15)) {
    const opts = [
      { ready: true, desired: 3, active: 3, pending: 0, blocked: null },
      { ready: true, desired: 3, active: 2, pending: 0, blocked: null },
      { ready: false, desired: 3, active: 3, pending: 0, blocked: null },
      { ready: true, desired: 3, active: 3, pending: 1011, blocked: null },
      { ready: true, desired: 3, active: 1, pending: 0, blocked: "no-caster" },
      { ready: true, desired: 3, active: 1, pending: 1011, blocked: "mana" },
    ];
    st.bstatus = opts[Math.floor(r() * opts.length)];
  }
  if (flip(0.03)) st.vitalsEnabled = !st.vitalsEnabled;
  if (flip(0.12)) st.vitalsStep = !st.vitalsStep;
  if (flip(0.06)) st.unwedgeActive = !st.unwedgeActive;
  if (flip(0.02)) st.ready = !st.ready;
  const u = r();
  if (u < 0.02) return "stop";
  if (u < 0.04) return "start";
  if (u < 0.05) return "hold";
  if (u < 0.06) return "release";
  if (u < 0.065) return "pause";
  if (u < 0.08) return "status";
  return "tick";
}

function applyOp(k, op) {
  switch (op) {
    case "stop":
      return k.stop();
    case "start":
      return k.start();
    case "hold":
      return k.holdForOperator();
    case "release":
      return k.releaseOperatorHold();
    case "pause":
      return k.pauseFor("ai");
    case "status":
      return JSON.stringify(k.status);
    default:
      return k.tick();
  }
}

const SHAPES = [
  {},
  { canEngage: false },
  { disengage: false },
  { loot: false },
  { buff: false },
  { heartbeat: false },
  { vitals: false },
  { unwedge: false },
  { combat: false },
  { loot: false, buff: false, vitals: false, unwedge: false },
];

const emptyShell = () => ({ slots: [], idleHooks: [], policy: { boostLoot: () => false }, status: () => ({ empty: true }) });
// The Default profile: every slot and hook present but disabled.
function disabledShell() {
  const off = (name, rank) => ({
    name,
    rank,
    keepsCombatLoop: name === "Supplies",
    enabled: () => false,
    wants: () => true,
    pinned: () => true,
    tick: () => {
      throw new Error(`disabled slot ${name} ticked`);
    },
    onLeave: () => {
      throw new Error(`disabled slot ${name} left`);
    },
  });
  return {
    slots: [
      off("Supplies", "afterVitals"),
      off("JumpNow", "afterUnwedge"),
      off("Pets", "beforeCombat"),
      off("Doors", () => "beforeIdle"),
      off("Navigate", () => "beforeIdle"),
      off("BuffItems", "beforeIdle"),
      off("IdleRebuff", "beforeIdle"),
    ],
    idleHooks: [
      {
        name: "PeaceMode",
        enabled: () => false,
        tick: () => {
          throw new Error("disabled hook ticked");
        },
      },
    ],
    policy: { boostLoot: () => false },
    status: () => ({ shell: true }),
  };
}

// Drive a frozen kernel and a live kernel (aux = makeAux()) through the same
// seeded world; compare everything observable after every step.
function compareRun({ seed, steps, shape, makeAux }) {
  const wa = makeWorld(shape);
  const wb = makeWorld(shape);
  const fk = new FrozenKernel(wa.host, wa.loops, { log: kernelLog(wa) });
  const aux = makeAux ? makeAux() : undefined;
  const lk = new RynthBotKernel(wb.host, { ...wb.loops, aux }, { log: kernelLog(wb) });
  const r = rng(seed);
  fk.start();
  lk.start();
  for (let i = 0; i < steps; i++) {
    const before = { ...wa.st };
    const op = randomStep(r, wa.st);
    Object.assign(wb.st, wa.st);
    const ra = applyOp(fk, op);
    const rb = applyOp(lk, op);
    const where = `seed ${seed} step ${i} op ${op} shape ${JSON.stringify(shape)} st ${JSON.stringify(before)}`;
    assert.equal(lk.action, fk.action, `action — ${where}`);
    assert.equal(lk._combatHeld, fk._combatHeld, `_combatHeld — ${where}`);
    assert.equal(lk.running, fk.running, `running — ${where}`);
    assert.equal(lk.operatorHeld, fk.operatorHeld, `operatorHeld — ${where}`);
    assert.equal(lk.pausedBy, fk.pausedBy, `pausedBy — ${where}`);
    assert.deepEqual(rb, ra, `op result — ${where}`);
    assert.deepEqual(wb.log, wa.log, `call log — ${where}`);
  }
  return wa.log.length;
}

// ── T-K1 ───────────────────────────────────────────────────────────────────
await check("T-K1: aux undefined ⇒ the pre-VT kernel (action trace + full call log + status), 10 shapes × 6 seeds × 600 steps", () => {
  let calls = 0;
  for (const shape of SHAPES) for (let seed = 1; seed <= 6; seed++) calls += compareRun({ seed: seed * 7919, steps: 600, shape });
  assert.ok(calls > 50_000, `the scripted worlds exercised the kernel (${calls} calls)`);
});

await check("T-K1: aux undefined ⇒ kernel.aux is null and status has exactly the pre-VT keys", () => {
  const w = makeWorld();
  const k = new RynthBotKernel(w.host, w.loops, { log: () => {} });
  const f = new FrozenKernel(w.host, w.loops, { log: () => {} });
  assert.equal(k.aux, null);
  assert.deepEqual(Object.keys(k.status), Object.keys(f.status));
});

// ── T-K2 ───────────────────────────────────────────────────────────────────
const PINS = ["combatPinned", "threat", "lootPinned", "buffPinned", "corpse", "buffNeeded"];
function literalLadder(c) {
  if (c.combatPinned || c.threat) return "Combat";
  if (c.lootPinned) return "Loot";
  if (c.buffPinned) return "Buffing";
  if (c.corpse) return "Loot";
  if (c.buffNeeded) return "Buffing";
  return "Idle";
}
function setPins(st, c) {
  st.locked = c.combatPinned ? 0x80000100 : 0;
  st.scan = c.threat ? [{ guid: 0x80000101, score: 90, dist: 10 }] : [];
  st.canEngage = true;
  st.lootEnabled = true;
  st.lootState = c.lootPinned ? "LOOT" : "SCAN";
  st.pending = c.buffPinned ? { spellId: 1011 } : null;
  st.corpse = !!c.corpse;
  st.bstatus = c.buffNeeded
    ? { ready: true, desired: 3, active: 2, pending: 0, blocked: null }
    : { ready: true, desired: 3, active: 3, pending: 0, blocked: null };
  st.vitalsStep = false;
  st.unwedgeActive = false;
}

for (const [label, makeAux] of [
  ["empty shell", emptyShell],
  ["Default-profile shell (every slot/hook disabled)", disabledShell],
]) {
  await check(`T-K2 (${label}): all 64 pin combinations × 7 prior actions select the literal ladder, same side effects`, () => {
    let n = 0;
    for (let mask = 0; mask < 64; mask++) {
      const c = {};
      PINS.forEach((p, i) => (c[p] = !!(mask & (1 << i))));
      for (const prior of ["Idle", "Combat", "Loot", "Buffing", "Vitals", "VitalsHeld", "Unwedge"]) {
        const wa = makeWorld();
        const wb = makeWorld();
        setPins(wa.st, c);
        setPins(wb.st, c);
        const fk = new FrozenKernel(wa.host, wa.loops, { log: kernelLog(wa) });
        const lk = new RynthBotKernel(wb.host, { ...wb.loops, aux: makeAux() }, { log: kernelLog(wb) });
        fk.start();
        lk.start();
        for (const k of [fk, lk]) {
          k.action = prior === "VitalsHeld" ? "Vitals" : prior;
          k._combatHeld = prior === "VitalsHeld";
        }
        wa.log.length = 0;
        wb.log.length = 0;
        fk.tick();
        lk.tick();
        const want = literalLadder(c);
        assert.equal(fk.action, want, `oracle sanity mask ${mask}`);
        assert.equal(lk.action, want, `mask ${mask} prior ${prior} ${JSON.stringify(c)}`);
        assert.deepEqual(wb.log, wa.log, `side effects mask ${mask} prior ${prior}`);
        assert.equal(lk._combatHeld, fk._combatHeld);
        n++;
      }
    }
    assert.equal(n, 64 * 7);
  });

  await check(`T-K2 (${label}): randomized worlds — identical to the pre-VT kernel, 10 shapes × 4 seeds × 600 steps`, () => {
    for (const shape of SHAPES) for (let seed = 1; seed <= 4; seed++) compareRun({ seed: seed * 104729, steps: 600, shape, makeAux });
  });

  await check(`T-K2 (${label}): status keeps the pre-VT shape (no aux key, critic B7)`, () => {
    const w = makeWorld();
    const k = new RynthBotKernel(w.host, { ...w.loops, aux: makeAux() }, { log: () => {} });
    const f = new FrozenKernel(w.host, w.loops, { log: () => {} });
    k.start();
    k.tick();
    assert.deepEqual(Object.keys(k.status), Object.keys(f.status));
    assert.equal("aux" in k.status, false);
  });
}

// ── aux contract ───────────────────────────────────────────────────────────
function slot(name, rank, o = {}) {
  const s = {
    name,
    rank,
    keepsCombatLoop: o.keeps === true,
    en: o.enabled ?? true,
    wa: o.wants ?? true,
    pi: o.pinned ?? false,
    ticks: 0,
    leaves: [],
    ctxs: [],
    wantsCtxs: [],
    enabled() {
      return typeof this.en === "function" ? this.en() : this.en;
    },
    wants(ctx) {
      this.wantsCtxs.push(ctx);
      return typeof this.wa === "function" ? this.wa(ctx) : this.wa;
    },
    tick(ctx) {
      this.ticks++;
      this.ctxs.push(ctx);
      if (o.onTick) o.onTick(ctx);
    },
    onLeave(next) {
      this.leaves.push(next);
    },
  };
  if (o.noPinned) delete s.pinned;
  else
    s.pinned = function () {
      return typeof this.pi === "function" ? this.pi() : this.pi;
    };
  return s;
}
function hook(name, o = {}) {
  return {
    name,
    en: o.enabled ?? true,
    ticks: 0,
    ctxs: [],
    enabled() {
      return this.en;
    },
    tick(ctx) {
      this.ticks++;
      this.ctxs.push(ctx);
    },
  };
}
function rig({ slots = [], idleHooks = [], boostLoot = false, pinnedFirst, status } = {}) {
  const w = makeWorld();
  const policy = { boostLoot: () => (typeof boostLoot === "function" ? boostLoot() : boostLoot) };
  if (pinnedFirst !== undefined) policy.pinnedFirst = () => pinnedFirst;
  const aux = { slots, idleHooks, policy, status: status || (() => ({ slots: slots.map((s) => s.name) })) };
  const lines = [];
  const k = new RynthBotKernel(w.host, { ...w.loops, aux }, { log: (m) => lines.push(m) });
  k.start();
  return { w, st: w.st, k, aux, lines };
}

await check("boost loot: (lootPinned || corpse) beats an unlocked threat unless under attack; never a pinned Combat", () => {
  const { st, k, aux } = rig({ boostLoot: true });
  setPins(st, { threat: true, corpse: true });
  k.tick();
  assert.equal(k.action, "Loot", "corpse before an unlocked threat");
  setPins(st, { threat: true, lootPinned: true });
  k.tick();
  assert.equal(k.action, "Loot", "a pinned loot keeps the tick against a threat");
  setPins(st, { threat: true, corpse: true });
  st.underAttack = true;
  k.tick();
  assert.equal(k.action, "Combat", "survival exception: under attack ⇒ Combat");
  st.underAttack = false;
  setPins(st, { combatPinned: true, corpse: true });
  k.tick();
  assert.equal(k.action, "Combat", "a locked target is never abandoned for loot");
  aux.policy.boostLoot = () => false;
  setPins(st, { threat: true, corpse: true });
  k.tick();
  assert.equal(k.action, "Combat", "boost off ⇒ the literal ladder");
});

await check("rank placement: beforeCombatPinned > pinned Combat > beforeCombat > threat … > beforeIdle > Idle", () => {
  const bcp = slot("Strict", "beforeCombatPinned", { wants: false });
  const bc = slot("Gentle", "beforeCombat", { wants: false });
  const bi = slot("Navigate", "beforeIdle", { wants: false });
  const { st, k } = rig({ slots: [bcp, bc, bi] });
  setPins(st, { combatPinned: true });
  bcp.wa = true;
  k.tick();
  assert.equal(k.action, "Strict", "beforeCombatPinned beats a locked target");
  bcp.wa = false;
  bc.wa = true;
  k.tick();
  assert.equal(k.action, "Combat", "beforeCombat loses to a locked target");
  setPins(st, { threat: true });
  k.tick();
  assert.equal(k.action, "Gentle", "beforeCombat beats an unlocked threat");
  bc.wa = false;
  bi.wa = true;
  k.tick();
  assert.equal(k.action, "Combat", "beforeIdle loses to a threat");
  for (const p of ["lootPinned", "buffPinned", "corpse", "buffNeeded"]) {
    setPins(st, { [p]: true });
    k.tick();
    assert.notEqual(k.action, "Navigate", `beforeIdle loses to ${p}`);
  }
  setPins(st, {});
  k.tick();
  assert.equal(k.action, "Navigate", "beforeIdle beats Idle");
  bi.wa = false;
  k.tick();
  assert.equal(k.action, "Idle");
  assert.deepEqual(bcp.leaves, ["Combat"], "Strict left for the locked target");
  assert.deepEqual(bc.leaves, ["Combat"], "Gentle left for Combat");
  assert.deepEqual(bi.leaves, ["Idle"], "Navigate left for Idle");
});

await check("afterVitals: pinned first, else the first wanting slot (array order); it outranks Unwedge, never Vitals", () => {
  const a = slot("SupA", "afterVitals", { wants: true });
  const b = slot("SupB", "afterVitals", { wants: true, pinned: false });
  const { st, k } = rig({ slots: [a, b] });
  setPins(st, { combatPinned: true });
  k.tick();
  assert.equal(k.action, "SupA", "first wanting in array order");
  b.pi = true;
  k.tick();
  assert.equal(k.action, "SupB", "a pinned slot of the rank wins over an earlier wanting one");
  assert.deepEqual(a.leaves, ["SupB"], "slot → slot calls onLeave(next)");
  st.unwedgeActive = true;
  k.tick();
  assert.equal(k.action, "SupB", "afterVitals outranks Unwedge");
  st.vitalsStep = true;
  k.tick();
  assert.equal(k.action, "Vitals", "Vitals preempts an afterVitals slot");
  assert.deepEqual(b.leaves, ["Vitals"]);
  // the partial ctx0
  st.vitalsStep = false;
  st.unwedgeActive = false;
  k.tick();
  const c0 = b.ctxs[b.ctxs.length - 1];
  assert.deepEqual(Object.keys(c0).sort(), ["action", "inCombat", "now"]);
  assert.equal(c0.inCombat, true, "inCombat = locked || threat (the Vitals expression)");
  assert.equal(c0.action, "Vitals", "action = the kernel action before this tick's switch");
  assert.equal(typeof c0.now, "number");
});

await check("afterUnwedge: pinned only (wants alone never selects it); Vitals and Unwedge still preempt it", () => {
  const j = slot("JumpNow", "afterUnwedge", { wants: true, pinned: false });
  const { st, k } = rig({ slots: [j] });
  setPins(st, { combatPinned: true });
  k.tick();
  assert.equal(k.action, "Combat", "wanting but unpinned ⇒ invisible");
  assert.equal(j.ticks, 0);
  j.pi = true;
  k.tick();
  assert.equal(k.action, "JumpNow", "pinned ⇒ beats a locked target");
  st.unwedgeActive = true;
  k.tick();
  assert.equal(k.action, "Unwedge", "Unwedge preempts it");
  assert.deepEqual(j.leaves, ["Unwedge"]);
  st.unwedgeActive = false;
  k.tick();
  assert.equal(k.action, "JumpNow");
  st.vitalsStep = true;
  k.tick();
  assert.equal(k.action, "Vitals");
  assert.deepEqual(j.leaves, ["Unwedge", "Vitals"]);
});

await check("onLeave on every action change: slot → Combat/Loot/Buffing/Idle/slot, stop() and holdForOperator() → 'Stopped'", () => {
  const n = slot("Navigate", "beforeIdle");
  const p = slot("Pets", "beforeCombat", { wants: false });
  const { st, k } = rig({ slots: [p, n] });
  const seq = [
    [{}, "Navigate"],
    [{ threat: true }, "Combat"],
    [{}, "Navigate"],
    [{ corpse: true }, "Loot"],
    [{}, "Navigate"],
    [{ buffNeeded: true }, "Buffing"],
    [{}, "Navigate"],
  ];
  for (const [pins, want] of seq) {
    setPins(st, pins);
    k.tick();
    assert.equal(k.action, want, JSON.stringify(pins));
  }
  assert.deepEqual(n.leaves, ["Combat", "Loot", "Buffing"]);
  p.wa = true;
  k.tick();
  assert.equal(k.action, "Pets");
  assert.deepEqual(n.leaves, ["Combat", "Loot", "Buffing", "Pets"]);
  n.en = false;
  p.wa = false;
  k.tick();
  assert.equal(k.action, "Idle", "a slot that goes disabled is left");
  assert.deepEqual(p.leaves, ["Idle"]);
  n.en = true;
  k.tick();
  assert.equal(k.action, "Navigate");
  k.stop();
  assert.deepEqual(n.leaves.slice(-1), ["Stopped"], "stop() → onLeave('Stopped')");
  assert.equal(k.action, "Idle", "stop() leaves the action at Idle");
  k.start();
  k.tick();
  assert.equal(k.action, "Navigate");
  k.holdForOperator();
  assert.deepEqual(n.leaves.slice(-1), ["Stopped"], "operator hold → onLeave('Stopped')");
  assert.equal(k.action, "Idle");
  const ticks = n.ticks;
  k.tick(); // a direct tick while held: nothing in aux runs
  assert.equal(n.ticks, ticks, "no slot tick while operator-held");
  assert.equal(k.action, "Idle");
});

await check("keepsCombatLoop: a borrowing slot keeps ACE's attack loop (like Vitals); a plain slot cancels it", () => {
  const sup = slot("Supplies", "afterVitals", { keeps: true, wants: false });
  const pets = slot("Pets", "beforeCombat", { wants: false });
  const { w, st, k } = rig({ slots: [sup, pets] });
  setPins(st, { threat: true });
  k.tick();
  assert.equal(k.action, "Combat");
  w.log.length = 0;
  sup.wa = true;
  k.tick();
  assert.equal(k.action, "Supplies");
  assert.ok(w.log.includes("combat.disengage:false"), `kept the loop: ${w.log}`);
  assert.equal(k._combatHeld, true);
  w.log.length = 0;
  sup.wa = false;
  k.tick();
  assert.equal(k.action, "Combat", "back to the fight");
  assert.ok(!w.log.some((l) => l.startsWith("combat.disengage")), "no cancel on the way back");
  assert.equal(k._combatHeld, false);
  sup.wa = true;
  k.tick();
  sup.wa = false;
  setPins(st, {});
  w.log.length = 0;
  k.tick();
  assert.equal(k.action, "Idle");
  assert.ok(w.log.includes("combat.disengage:true"), "the orphaned loop is cancelled when the borrow ends elsewhere");
  assert.equal(k._combatHeld, false);
  // a plain slot from Combat cancels the loop
  setPins(st, { threat: true });
  k.tick();
  assert.equal(k.action, "Combat");
  w.log.length = 0;
  pets.wa = true;
  k.tick();
  assert.equal(k.action, "Pets");
  assert.ok(w.log.includes("combat.disengage:true"), `plain slot: ${w.log}`);
  // stop() mid-borrow: onLeave + the kept loop is cancelled
  pets.wa = false;
  k.tick();
  sup.wa = true;
  k.tick();
  assert.equal(k.action, "Supplies");
  w.log.length = 0;
  k.stop();
  assert.equal(k.action, "Idle");
  assert.deepEqual(sup.leaves.slice(-1), ["Stopped"]);
  assert.ok(w.log.includes("combat.disengage:true"), "stop() cancels the borrowed loop");
  assert.equal(k._combatHeld, false);
});

await check("idle hooks: ticked (full ctx) on Idle only; a disabled hook never; none while stopped", () => {
  const on = hook("PeaceMode");
  const off = hook("Off", { enabled: false });
  const n = slot("Navigate", "beforeIdle", { wants: false });
  const { st, k } = rig({ slots: [n], idleHooks: [on, off] });
  setPins(st, {});
  k.tick();
  assert.equal(k.action, "Idle");
  assert.equal(on.ticks, 1);
  assert.equal(off.ticks, 0);
  assert.ok("buffNeeded" in on.ctxs[0] && "underAttack" in on.ctxs[0], "full KernelCtx");
  for (const pins of [{ threat: true }, { corpse: true }, { buffPinned: true }]) {
    setPins(st, pins);
    k.tick();
  }
  n.wa = true;
  setPins(st, {});
  k.tick();
  assert.equal(k.action, "Navigate");
  st.vitalsStep = true;
  k.tick();
  st.vitalsStep = false;
  assert.equal(on.ticks, 1, "no hook tick on Combat/Loot/Buffing/a slot/Vitals");
  n.wa = false;
  k.stop();
  k.tick(); // direct tick while stopped
  assert.equal(on.ticks, 1, "no hook tick while stopped");
  k.start();
  k.tick();
  assert.equal(on.ticks, 2);
});

await check("nothing in aux runs while the kernel is not running (never started / stopped / held)", () => {
  const sup = slot("Supplies", "afterVitals", { pinned: true });
  const n = slot("Navigate", "beforeIdle");
  const w = makeWorld();
  let consulted = 0;
  for (const s of [sup, n]) {
    const en = s.enabled;
    s.enabled = function () {
      consulted++;
      return en.call(this);
    };
  }
  const k = new RynthBotKernel(w.host, { ...w.loops, aux: { slots: [sup, n], idleHooks: [], policy: { boostLoot: () => false } } }, { log: () => {} });
  k.tick();
  assert.equal(sup.ticks + n.ticks, 0, "never started");
  assert.equal(consulted, 0, "slots are not even consulted");
  assert.equal(k.action, "Idle");
  k.start();
  k.tick();
  assert.equal(k.action, "Supplies");
  k.pauseFor("goto");
  k.tick();
  assert.equal(sup.ticks, 1, "stopped by a mover");
  k.start();
  k.holdForOperator();
  k.tick();
  assert.equal(sup.ticks, 1, "operator-held");
  assert.equal(k.start(), false, "the hold still refuses start()");
});

await check("status: aux key only while a slot or idle hook is enabled; shape otherwise unchanged", () => {
  const n = slot("Navigate", "beforeIdle", { enabled: false });
  const h = hook("PeaceMode", { enabled: false });
  const { k } = rig({ slots: [n], idleHooks: [h], status: () => ({ nav: "x" }) });
  const base = Object.keys(new FrozenKernel(makeWorld().host, makeWorld().loops, { log: () => {} }).status);
  assert.deepEqual(Object.keys(k.status), base);
  n.en = true;
  assert.deepEqual(k.status.aux, { nav: "x" });
  assert.deepEqual(Object.keys(k.status), [...base, "aux"], "aux appended last");
  n.en = false;
  h.en = true;
  assert.deepEqual(k.status.aux, { nav: "x" }, "an enabled idle hook counts too");
  h.en = false;
  assert.equal("aux" in k.status, false);
});

await check("full KernelCtx for later ranks: every field, lazily computed corpse/buffNeeded/inCombat", () => {
  const n = slot("Navigate", "beforeIdle", { wants: false });
  const { w, st, k } = rig({ slots: [n] });
  setPins(st, {});
  st.underAttack = true;
  st.vitalsEnabled = false; // inCombat comes from the ctx itself
  k.tick();
  const c = n.wantsCtxs[n.wantsCtxs.length - 1];
  assert.deepEqual(
    Object.keys(c).sort(),
    ["action", "buffNeeded", "buffPinned", "combatPinned", "corpse", "inCombat", "lootPinned", "now", "threat", "underAttack"]
  );
  assert.equal(c.underAttack, true);
  assert.equal(c.combatPinned, false);
  assert.equal(c.corpse, false);
  assert.equal(c.buffNeeded, false);
  assert.equal(c.inCombat, false);
  // lazy: a Combat-pinned tick with a slot that never reads corpse does not scan corpses
  const strict = slot("Strict", "beforeCombatPinned", { wants: false });
  const r2 = rig({ slots: [strict] });
  setPins(r2.st, { combatPinned: true, corpse: true });
  r2.w.log.length = 0;
  r2.k.tick();
  assert.equal(r2.k.action, "Combat");
  assert.ok(!r2.w.log.includes("loot.findCorpse"), "corpse not evaluated when the ladder never reaches it");
  // and a boosted-nav style slot sees buffNeeded = the kernel predicate (D39 input)
  let sawNeed = null;
  const boost = slot("Navigate", "beforeCombat", {
    wants: (ctx) => {
      sawNeed = ctx.buffNeeded || ctx.buffPinned;
      return !sawNeed;
    },
  });
  const r3 = rig({ slots: [boost] });
  setPins(r3.st, { threat: true, buffNeeded: true });
  r3.k.tick();
  assert.equal(sawNeed, true);
  assert.equal(r3.k.action, "Combat", "the boosted slot yields while buffs are needed (D39), Combat takes the threat");
  setPins(r3.st, { buffNeeded: true });
  r3.k.tick();
  assert.equal(r3.k.action, "Buffing", "…and buffing is not starved (V-23)");
  void w;
});

await check("rank may be a function, re-read every tick", () => {
  let r = "beforeIdle";
  const n = slot("Navigate", () => r);
  const { st, k } = rig({ slots: [n] });
  setPins(st, { threat: true });
  k.tick();
  assert.equal(k.action, "Combat");
  r = "beforeCombat";
  k.tick();
  assert.equal(k.action, "Navigate", "boost turned on mid-run");
  r = "nonsense";
  k.tick();
  assert.equal(k.action, "Combat", "an unknown rank is invisible");
});

await check("a throwing slot never breaks the tick (logged, treated as absent); reserved names are ignored", () => {
  const bad = {
    name: "Bad",
    rank: "beforeCombat",
    enabled: () => true,
    wants: () => {
      throw new Error("boom");
    },
    tick: () => {},
  };
  const badTick = slot("BadTick", "beforeIdle", {
    onTick: () => {
      throw new Error("tick boom");
    },
  });
  const shadow = slot("Combat", "beforeCombatPinned");
  const { st, k, lines } = rig({ slots: [shadow, bad, badTick] });
  setPins(st, { threat: true });
  k.tick();
  assert.equal(k.action, "Combat", "wants() throwing ⇒ not wanting; a slot named Combat is ignored");
  assert.equal(shadow.ticks, 0);
  setPins(st, {});
  k.tick();
  k.tick();
  assert.equal(k.action, "BadTick");
  assert.ok(lines.some((l) => /aux Bad\.wants threw: boom/.test(l)), lines.join(" | "));
  assert.equal(lines.filter((l) => /BadTick\.tick threw/.test(l)).length, 1, "rate-limited to one line per 10 s");
});

await check("policy.pinnedFirst (optional, default off): a pinned slot of any rank keeps the tick ahead of Combat", () => {
  const n = slot("Navigate", "beforeIdle", { pinned: true });
  const off = rig({ slots: [n] });
  setPins(off.st, { threat: true });
  off.k.tick();
  assert.equal(off.k.action, "Combat", "PLAN §3.13 literal: a pinned beforeIdle slot loses to a threat");
  const n2 = slot("Navigate", "beforeIdle", { pinned: true });
  const on = rig({ slots: [n2], pinnedFirst: true });
  setPins(on.st, { combatPinned: true, threat: true });
  on.k.tick();
  assert.equal(on.k.action, "Navigate", "pinnedFirst: the in-flight recall/portal/jump keeps the tick");
  on.st.unwedgeActive = true;
  on.k.tick();
  assert.equal(on.k.action, "Unwedge", "…below Unwedge");
  on.st.unwedgeActive = false;
  on.st.vitalsStep = true;
  on.k.tick();
  assert.equal(on.k.action, "Vitals", "…and Vitals");
});

await check("the slot list is read live (filled after the kernel is built, as createVtLayer does)", () => {
  const { st, k, aux } = rig({ slots: [] });
  setPins(st, {});
  k.tick();
  assert.equal(k.action, "Idle");
  const n = slot("Navigate", "beforeIdle");
  aux.slots.push(n);
  k.tick();
  assert.equal(k.action, "Navigate");
  assert.equal(n.ticks, 1);
});

console.log(fail === 0 ? `rynth_vt_kernel_aux: all ${pass} checks passed` : `rynth_vt_kernel_aux: ${fail} FAILED (${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);
