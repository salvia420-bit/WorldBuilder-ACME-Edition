// tests/rynth_vt_loop_hooks.test.mjs — the INT-1 loop hooks (PLAN §3.14, §5
// rows for rynth/combat_loop.js, rynth/buff_loop.js, rynth/loot_loop.js; O5,
// O20, B2, the P8 loot hook, the M8/M9 planner hooks; critic G9/B7/C10).
//
// GOLDEN (V-1): three scripted worlds — a fight (melee → magic → missile →
// magic, deaths, respawns, refusals, a no-contact ghost, an unreachable mob,
// portal space, memo re-reads, mobs at 39.9 / 40.0 / 40.1 m and across a
// landblock seam), a corpse run (approach, open, appraisal gate, refusals,
// corpses at 29.9 / 30.1 m) and a buff session (threshold crossings, casts,
// refusals, B7 item enchants confirmed by chat) — are replayed against the
// loops with every hook at its default (vt null, acquireRangeFn null,
// classify null, no item names). Every host call (name + args), the scan
// output and the loop state are hashed per tick and compared with digests
// captured from the PRE-change loops (rynth/*.js @ a33dcb16, unchanged at 008a22ae). A mismatch
// prints the first diverging tick with its call log.
//   Re-baseline ONLY for a deliberate behaviour change:
//     node tests/rynth_vt_loop_hooks.test.mjs --print-golden
//
// Then the hooks themselves: combat (monsterRangeM, acquireRangeFn with and
// without a planner, scanVerdict ignore/bias, invalidateScan, planner hook
// order, cast routing CastSpell vs CastSpellAt/CastUntargetedSafe, no misses
// for debuff/ring, {done}/{skip}, unsent casts, ensureLoadout busy,
// attackAllowed, underAttack, netBrain MonsterRange); buff
// (rebuffSecondsRemaining, idleRebuffWindowS reaching only _isActiveReal,
// needsBuff ≡ kernel _buffNeeded at window 0, the window, setItemBuffs and the
// item-name-tightened B7 confirm); loot (corpseRangeM, classify
// pickup/skip/pending/null/throw); kernel status shape (B7).
//
// Run from apps/holtburger-web/:  node tests/rynth_vt_loop_hooks.test.mjs

import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const PRINT_GOLDEN = process.argv.includes("--print-golden");

const { RynthCombatLoop } = await import("../rynth/combat_loop.js");
const { RynthLootLoop } = await import("../rynth/loot_loop.js");
const { RynthBuffLoop } = await import("../rynth/buff_loop.js");

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

// One fake clock for every loop (they all read Date.now()).
const REAL_NOW = Date.now;
let NOW = 1_800_000_000_000;
Date.now = () => NOW;

const LB = 0xa9b40015 >>> 0; // outdoor cell
const LB_EAST = 0xaab40015 >>> 0; // the outdoor landblock east of LB
const DUNGEON = 0xa9b50105 >>> 0; // an EnvCell of another landblock
const ME = 0x50000001;

const quiet = () => {};
function fmt(a) {
  if (a === null || a === undefined) return String(a);
  if (typeof a === "number") return Number.isInteger(a) ? String(a) : a.toFixed(4);
  if (typeof a === "object") return JSON.stringify(a, (k, v) => (typeof v === "number" && !Number.isInteger(v) ? Number(v.toFixed(4)) : v));
  return String(a);
}
const sha8 = (s) => createHash("sha1").update(s).digest("hex").slice(0, 8);

// mulberry32
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

// ── combat world ───────────────────────────────────────────────────────────
function makeCombatWorld() {
  const W = {
    tick: 0,
    seq: 1,
    mode: 2,
    me: { objCellId: LB, x: 150, y: 96, z: 0, heading: 0 },
    ents: new Map(),
    known: [27, 28, 58],
    sticky: 0,
    useDone: 0,
    useDoneAt: [],
    castBusy: 0,
    busy: 0,
    calls: [],
    subs: [],
    token: null,
    portal: false,
    castOk: true,
    casts: [],
    attacks: [],
  };
  const L = (n, ...a) => W.calls.push(a.length ? `${n}(${a.map(fmt).join(",")})` : n);
  const ent = (g) => W.ents.get(g >>> 0);
  const castIssued = (t, s) => {
    W.casts.push({ t: t >>> 0, s, at: W.tick });
    W.useDoneAt.push(W.tick + 2);
  };
  const host = {
    get snap() {
      return { seq: W.seq };
    },
    IsPlayerReady() {
      L("IsPlayerReady");
      return true;
    },
    IsPortalSpaceActive() {
      L("IsPortalSpaceActive");
      return W.portal;
    },
    TryGetPlayerPose() {
      L("TryGetPlayerPose");
      return { ...W.me };
    },
    GetPlayerId() {
      L("GetPlayerId");
      return ME;
    },
    NearbyGuids() {
      L("NearbyGuids");
      return [...W.ents.keys()].filter((g) => !W.ents.get(g).gone);
    },
    ObjectIsPlayer(g) {
      L("ObjectIsPlayer", g);
      return !!ent(g)?.player;
    },
    TryGetObjectIntProperty(g, s) {
      L("TryGetObjectIntProperty", g, s);
      const e = ent(g);
      return s === 1 && e ? e.itemType ?? 16 : undefined;
    },
    ObjectIsAttackable(g) {
      L("ObjectIsAttackable", g);
      return ent(g)?.attackable !== false;
    },
    TryGetTargetHealthFraction(g) {
      L("TryGetTargetHealthFraction", g);
      const e = ent(g);
      return !e || e.gone ? -1 : e.hf;
    },
    TryGetObjectPosition(g) {
      L("TryGetObjectPosition", g);
      const e = ent(g);
      return !e || e.gone ? null : { objCellId: e.cell ?? LB, x: e.x, y: e.y, z: e.z ?? 0 };
    },
    TryGetObjectName(g) {
      L("TryGetObjectName", g);
      return ent(g)?.name ?? null;
    },
    GetCurrentCombatMode() {
      L("GetCurrentCombatMode");
      return W.mode;
    },
    ToggleCombatMode() {
      L("ToggleCombatMode");
      return true;
    },
    QueryHealth(g) {
      L("QueryHealth", g);
      return true;
    },
    StickToObject(g) {
      L("StickToObject", g);
      W.sticky = g >>> 0;
      return true;
    },
    StopStick() {
      L("StopStick");
      W.sticky = 0;
      return true;
    },
    TryGetLocalStickyTarget() {
      L("TryGetLocalStickyTarget");
      return W.sticky;
    },
    MeleeAttack(g, h, p) {
      L("MeleeAttack", g, h, p);
      W.attacks.push({ g: g >>> 0, at: W.tick });
      return true;
    },
    MissileAttack(g, h, a) {
      L("MissileAttack", g, h, a);
      W.attacks.push({ g: g >>> 0, at: W.tick });
      return true;
    },
    CancelAttack() {
      L("CancelAttack");
      return true;
    },
    TurnToHeading(r) {
      L("TurnToHeading", r);
      W.me.heading = r;
      return true;
    },
    StopCompletely() {
      L("StopCompletely");
      return true;
    },
    has(c) {
      L("has", c);
      return c === "TurnToHeading" || c === "GetUseDoneSeq";
    },
    CastSpell(t, s) {
      L("CastSpell", t, s);
      if (W.castOk) castIssued(t, s);
      return W.castOk;
    },
    CastSpellAt(t, s) {
      L("CastSpellAt", t, s);
      if (W.castOk) castIssued(t, s);
      return W.castOk;
    },
    CastUntargetedSafe(s, o) {
      L("CastUntargetedSafe", s, o);
      if (W.castOk) castIssued(0, s);
      return W.castOk;
    },
    GetCastBusyState() {
      L("GetCastBusyState");
      return W.castBusy;
    },
    GetBusyState() {
      L("GetBusyState");
      return W.busy;
    },
    GetUseDoneSeq() {
      L("GetUseDoneSeq");
      return W.useDone;
    },
    TryGetKnownSpells() {
      L("TryGetKnownSpells");
      return W.known.slice();
    },
    tryClaimCast(o) {
      L("tryClaimCast", o);
      if (W.token && W.token !== o) return false;
      W.token = o;
      return true;
    },
    releaseCast(o) {
      L("releaseCast", o);
      if (W.token === o) W.token = null;
      return true;
    },
    onEvent(fn) {
      L("onEvent");
      W.subs.push(fn);
    },
    onTick() {
      L("onTick");
    },
  };
  W.emit = (e) => {
    for (const fn of W.subs) fn(e);
  };
  return { W, host };
}

const MOBS = [
  // [guid, name, dx, dy, extra]
  [0x80000101, "Drudge Skulker", 0, 8, {}],
  [0x80000102, "Mosswart", 25, 10, {}],
  [0x80000103, "Rat Edge", 0, 39.9, {}],
  [0x80000104, "Rat Exact", 0, -40, {}],
  [0x80000105, "Rat Beyond", 0, 40.1, {}],
  [0x80000106, "Ghost", 6, -6, { ghost: true }], // never takes damage (no-contact blacklist)
  [0x80000107, "Wall Banderling", -20, 0, { wall: true }], // run-up never closes (unreachable park)
  [0x80000108, "Seam Golem", 0, 0, { cell: LB_EAST, ax: 10, ay: 90 }], // across the landblock seam, ~ 52 m
  [0x80000109, "Seam Rat", 0, 0, { cell: LB_EAST, ax: 2, ay: 96 }], // across the seam, ~ 44 m → out
  [0x8000010a, "Dungeon Rat", 0, 0, { cell: DUNGEON, ax: 10, ay: 10 }], // other EnvCell landblock → out
  [0x50000002, "Some Player", 3, 3, { player: true }],
  [0x8000010b, "A Chest", 4, 0, { itemType: 512 }],
  [0x8000010c, "Town Crier", -5, 5, { attackable: false }],
];

function spawnCombatMobs(W) {
  for (const [g, name, dx, dy, x] of MOBS) {
    W.ents.set(g, {
      name,
      x: x.ax ?? W.me.x + dx,
      y: x.ay ?? W.me.y + dy,
      z: 0,
      hf: 1,
      cell: x.cell,
      ghost: !!x.ghost,
      wall: !!x.wall,
      player: !!x.player,
      itemType: x.itemType,
      attackable: x.attackable,
    });
  }
}

function modeAt(i) {
  if (i >= 50 && i < 58) return 1; // NonCombat for a while: the toggle path
  if (i < 110) return 2;
  if (i < 230) return 8;
  if (i < 290) return 4;
  return 8;
}

// The world reacts to what the loop did (casts resolve, swings land, mobs die
// and respawn, the stick drags the body) — deterministic for identical calls.
function stepCombatWorld(W, loop, i, r) {
  W.tick = i;
  W.mode = modeAt(i);
  W.portal = i >= 160 && i < 164;
  W.castBusy = i % 37 === 5 ? 1 : 0;
  W.busy = i % 41 === 7 ? 1 : 0;
  if (i % 7 !== 3) W.seq++; // every 7th tick re-reads the same snapshot (memo)
  // casts resolve two ticks after issue
  while (W.useDoneAt.length && W.useDoneAt[0] <= i) {
    W.useDoneAt.shift();
    W.useDone++;
    const c = W.casts.shift();
    const e = c ? W.ents.get(c.t) : null;
    const roll = r();
    if (roll < 0.1) W.emit({ kind: 13, u32: 0x0402, u32b: 0, text: "Your spell fizzled." });
    else if (e && !e.gone && !e.ghost && roll < 0.75) {
      e.hf = Math.max(0, e.hf - 0.3);
      W.emit({ kind: 2, u32: 0, u32b: 0, text: `You singe ${e.name} for 14 points with Flame Bolt I.` });
    } else if (e && !e.gone && !e.ghost && roll < 0.85) W.emit({ kind: 2, u32: 0, u32b: 0, text: `${e.name} resists your spell` });
  }
  // the live melee/missile engagement lands a hit every 3rd tick
  const last = W.attacks[W.attacks.length - 1];
  if (last && (i - last.at) % 3 === 2) {
    const e = W.ents.get(last.g);
    if (e && !e.gone && !e.ghost) {
      e.hf = Math.max(0, e.hf - 0.2);
      W.emit({ kind: 19, u32: 0, u32b: 0, text: JSON.stringify({ type: "damageDealt", defenderName: e.name, damage: 9, severity: 0.2 }) });
      W.emit({ kind: 19, u32: 0, u32b: 0, text: JSON.stringify({ type: "attackDone", error: "None" }) });
    } else if (e && e.ghost) W.emit({ kind: 19, u32: 0, u32b: 0, text: JSON.stringify({ type: "evadedTarget", defenderName: "Someone Else" }) });
  }
  // deaths → kind 29, then the corpse swap removes the creature; respawn later
  for (const [g, e] of W.ents) {
    if (!e.gone && e.hf === 0 && !e.diedAt) {
      e.diedAt = i;
      W.emit({ kind: 29, u32: g, u32b: ME, text: `${e.name} has been slain` });
    } else if (e.diedAt != null && !e.gone && i - e.diedAt >= 2) e.gone = true;
    else if (e.gone && i - e.diedAt >= 30) {
      e.gone = false;
      e.diedAt = null;
      e.hf = 1;
      e.x += 1.5;
    }
  }
  // someone hits us now and then (attacker memory)
  if (i % 45 === 20) W.emit({ kind: 19, u32: 0, u32b: 0, text: JSON.stringify({ type: "damageTaken", attackerName: "Mosswart", damage: 4 }) });
  if (i % 60 === 33) W.emit({ kind: 2, u32: 0, u32b: 0, text: "Drudge Skulker singes you for 6 points with Flame Bolt I." });
  if (i % 53 === 11) W.emit({ kind: 19, u32: 0, u32b: 0, text: JSON.stringify({ type: "attackDone", error: "ActionCancelled" }) });
  // the stick drags the body toward its target (never toward the wall mob)
  if (W.sticky) {
    const e = W.ents.get(W.sticky);
    if (e && !e.gone && !e.wall && (e.cell ?? LB) === LB) {
      const dx = e.x - W.me.x;
      const dy = e.y - W.me.y;
      const d = Math.hypot(dx, dy);
      if (d > 1) {
        W.me.x += (dx / d) * Math.min(2, d - 1);
        W.me.y += (dy / d) * Math.min(2, d - 1);
      }
    }
  }
  void loop;
}

function runCombatGolden(setup) {
  const { W, host } = makeCombatWorld();
  spawnCombatMobs(W);
  const loop = new RynthCombatLoop(host, { log: quiet });
  if (setup) setup(loop, W);
  const r = rng(0xc0ffee);
  const out = [];
  const logs = [];
  for (let i = 0; i < 360; i++) {
    NOW += 250;
    stepCombatWorld(W, loop, i, r);
    W.calls = [];
    loop.tick();
    const scan = loop._scanTargets().map((t) => `${t.guid.toString(16)}:${t.score.toFixed(3)}:${t.dist.toFixed(3)}`);
    const rec = JSON.stringify({ c: W.calls, scan, st: loop.status, ls: loop.lockedScore, aw: loop.awaitingCast });
    out.push(sha8(rec));
    logs.push(rec);
  }
  return { digests: out.join(""), logs, loop, W };
}

// ── loot world ─────────────────────────────────────────────────────────────
function makeLootWorld() {
  const W = {
    tick: 0,
    me: { objCellId: LB, x: 100, y: 100, z: 0 },
    objs: new Map(), // guid -> { wcid, x, y, cell }
    ground: 0,
    contents: new Map(),
    inv: new Set(),
    values: new Map(), // item -> Value(19) once appraised
    appraised: new Set(),
    appraiseAt: new Map(),
    openAt: null,
    moves: [],
    refuse: new Set(),
    busyRefuse: new Set(),
    busy: 0,
    free: 10,
    calls: [],
    subs: [],
    moveTo: null,
    portal: false,
  };
  const L = (n, ...a) => W.calls.push(a.length ? `${n}(${a.map(fmt).join(",")})` : n);
  const host = {
    IsPlayerReady() {
      L("IsPlayerReady");
      return true;
    },
    IsPortalSpaceActive() {
      L("IsPortalSpaceActive");
      return W.portal;
    },
    TryGetFreeSlots() {
      L("TryGetFreeSlots");
      return W.free;
    },
    TryGetPlayerPose() {
      L("TryGetPlayerPose");
      return { ...W.me };
    },
    NearbyGuids() {
      L("NearbyGuids");
      return [...W.objs.keys()];
    },
    TryGetObjectWcid(g) {
      L("TryGetObjectWcid", g);
      return W.objs.get(g >>> 0)?.wcid ?? null;
    },
    TryGetObjectPosition(g) {
      L("TryGetObjectPosition", g);
      const o = W.objs.get(g >>> 0);
      return o ? { objCellId: o.cell ?? LB, x: o.x, y: o.y, z: 0 } : null;
    },
    TryGetObjectName(g) {
      L("TryGetObjectName", g);
      return `obj-${(g >>> 0).toString(16)}`;
    },
    MoveToPosition(cell, x, y, z, run) {
      L("MoveToPosition", cell, x, y, z, run);
      W.moveTo = { x, y };
      return true;
    },
    StopCompletely() {
      L("StopCompletely");
      W.moveTo = null;
      return true;
    },
    UseObject(g) {
      L("UseObject", g);
      W.openAt = { g: g >>> 0, at: W.tick + 2 };
      return true;
    },
    GetGroundContainerId() {
      L("GetGroundContainerId");
      return W.ground;
    },
    GetContainerContents(g) {
      L("GetContainerContents", g);
      return (W.contents.get(g >>> 0) || []).slice();
    },
    CloseContainer(g) {
      L("CloseContainer", g);
      if (W.ground === g >>> 0) W.ground = 0;
      return true;
    },
    GetBusyState() {
      L("GetBusyState");
      return W.busy;
    },
    GetPlayerId() {
      L("GetPlayerId");
      return ME;
    },
    TryGetObjectIntProperty(item, s) {
      L("TryGetObjectIntProperty", item, s);
      if (s !== 19) return undefined;
      return W.appraised.has(item >>> 0) ? W.values.get(item >>> 0) ?? null : null;
    },
    HasAppraisalData(item) {
      L("HasAppraisalData", item);
      return W.appraised.has(item >>> 0);
    },
    RequestId(item) {
      L("RequestId", item);
      if (!W.appraiseAt.has(item >>> 0)) W.appraiseAt.set(item >>> 0, W.tick + 3);
      return true;
    },
    TryGetPackRoom() {
      L("TryGetPackRoom");
      return { main: { free: W.free }, packs: [{ guid: 0x60000001, free: 5 }] };
    },
    MoveItemToContainer(item, dest, slot) {
      L("MoveItemToContainer", item, dest, slot);
      W.moves.push({ item: item >>> 0, at: W.tick + 2 });
      return true;
    },
    TryGetPlayerInventory() {
      L("TryGetPlayerInventory");
      return [...W.inv].map((g) => ({ guid: g }));
    },
    RequestIdLog: null,
    onEvent(fn) {
      L("onEvent");
      W.subs.push(fn);
    },
  };
  W.emit = (e) => {
    for (const fn of W.subs) fn(e);
  };
  return { W, host };
}

function spawnLoot(W) {
  // corpses (wcid 21) at 10 m (approach), 3 m (in reach), 29.9 / 30.1 m, 45 m
  const add = (g, dx, dy, items) => {
    W.objs.set(g, { wcid: 21, x: W.me.x + dx, y: W.me.y + dy });
    W.contents.set(g, items);
  };
  add(0x70000001, 0, 10, [0x71000001, 0x71000002, 0x71000003]);
  add(0x70000002, 3, 0, [0x71000011, 0x71000012]);
  add(0x70000003, 0, -29.9, [0x71000021]);
  add(0x70000004, 0, 30.1, [0x71000031]);
  add(0x70000005, 45, 0, [0x71000041]);
  add(0x70000006, -6, 0, []); // empty corpse
  W.objs.set(0x72000001, { wcid: 9999, x: W.me.x + 1, y: W.me.y }); // not a corpse
  const vals = {
    0x71000001: 500, // "too busy" refusal first, then picked up
    0x71000002: 5, // below the floor
    0x71000003: 900, // refused by the server
    0x71000011: null, // never appraised → appraisal timeout
    0x71000012: 250,
    0x71000021: 1000,
    0x71000031: 1000,
    0x71000041: 1000,
  };
  for (const [k, v] of Object.entries(vals)) if (v != null) W.values.set(Number(k), v);
  W.appraised.add(0x71000001);
  W.appraised.add(0x71000012);
  W.refuse.add(0x71000003);
  W.busyRefuse.add(0x71000001);
}

function stepLootWorld(W, i) {
  W.tick = i;
  W.portal = i >= 70 && i < 73;
  W.busy = i % 29 === 4 ? 1 : 0;
  if (W.openAt && W.openAt.at <= i) {
    W.ground = W.openAt.g;
    W.openAt = null;
  }
  for (const [item, at] of W.appraiseAt) {
    if (at <= i && !W.appraised.has(item) && W.values.has(item)) W.appraised.add(item);
  }
  for (const m of W.moves.splice(0)) {
    if (m.at > i) {
      W.moves.push(m);
      continue;
    }
    if (W.busyRefuse.has(m.item)) {
      W.busyRefuse.delete(m.item);
      W.emit({ kind: 13, u32: 0x1d, u32b: 0, text: "You're too busy!" });
      W.emit({ kind: 48, u32: m.item, u32b: 0x1d, text: "" });
    } else if (W.refuse.has(m.item)) W.emit({ kind: 48, u32: m.item, u32b: 0x2a, text: "" });
    else {
      W.inv.add(m.item);
      for (const [g, list] of W.contents) W.contents.set(g, list.filter((x) => x !== m.item));
    }
  }
  if (W.moveTo) {
    const dx = W.moveTo.x - W.me.x;
    const dy = W.moveTo.y - W.me.y;
    const d = Math.hypot(dx, dy);
    if (d > 0.5) {
      W.me.x += (dx / d) * Math.min(2.5, d);
      W.me.y += (dy / d) * Math.min(2.5, d);
    } else W.moveTo = null;
  }
}

function runLootGolden(setup) {
  const { W, host } = makeLootWorld();
  spawnLoot(W);
  const loop = new RynthLootLoop(host, { minValue: 100, log: quiet });
  if (setup) setup(loop, W);
  const out = [];
  const logs = [];
  for (let i = 0; i < 240; i++) {
    NOW += 250;
    stepLootWorld(W, i);
    W.calls = [];
    loop.tick();
    const rec = JSON.stringify({
      c: W.calls,
      s: loop.state,
      corpse: loop.corpse,
      items: loop.items,
      pend: loop.pendingItem,
      n: [loop.lootedCount, loop.emptyCorpses, loop.refusedPickups],
      looted: [...loop.looted.keys()],
    });
    out.push(sha8(rec));
    logs.push(rec);
  }
  return { digests: out.join(""), logs, loop, W };
}

// ── buff world ─────────────────────────────────────────────────────────────
// Families: Strength 101 (ids 1011..1016 tiers 1..6), Focus 102 (1021..1023),
// Armor 103 (1031, permanent when it lands), a 200 s buff 104 (1041), item
// enchants 301 (3011) / 302 (3021) cast on items.
const BUFF_META = {
  1011: [101, 1], 1012: [101, 2], 1013: [101, 3], 1014: [101, 4], 1015: [101, 5], 1016: [101, 6],
  1021: [102, 1], 1022: [102, 2], 1023: [102, 3],
  1031: [103, 4],
  1041: [104, 2], // lands with less than the rebuff threshold (the short-duration hold)
  3011: [301, 6], 3021: [302, 6],
};
const BUFF_DUR = { 101: 1800, 102: 1200, 103: -1, 104: 200, 301: 1800, 302: 1800 };

function makeBuffWorld() {
  const W = {
    tick: 0,
    mode: 1,
    reg: [], // { spellId, spellCategory, startTime, duration, layer }
    known: Object.keys(BUFF_META).map(Number),
    castBusy: 0,
    busy: 0,
    useDone: 0,
    calls: [],
    subs: [],
    token: null,
    pendingCasts: [],
    inv: [{ guid: 0x60000010, equipMask: 0x01000000 }],
  };
  const L = (n, ...a) => W.calls.push(a.length ? `${n}(${a.map(fmt).join(",")})` : n);
  const host = {
    IsPlayerReady() {
      L("IsPlayerReady");
      return true;
    },
    IsPortalSpaceActive() {
      L("IsPortalSpaceActive");
      return false;
    },
    GetCurrentCombatMode() {
      L("GetCurrentCombatMode");
      return W.mode;
    },
    ChangeCombatMode(m) {
      L("ChangeCombatMode", m);
      W.modeAt = { m, at: W.tick + 2 };
      return true;
    },
    GetCastBusyState() {
      L("GetCastBusyState");
      return W.castBusy;
    },
    GetBusyState() {
      L("GetBusyState");
      return W.busy;
    },
    GetPlayerId() {
      L("GetPlayerId");
      return ME;
    },
    CastSpell(t, s) {
      L("CastSpell", t, s);
      W.pendingCasts.push({ t: t >>> 0, s: s >>> 0, at: W.tick + 1 });
      return true;
    },
    tryClaimCast(o) {
      L("tryClaimCast", o);
      if (W.token && W.token !== o) return false;
      W.token = o;
      return true;
    },
    releaseCast(o) {
      L("releaseCast", o);
      if (W.token === o) W.token = null;
      return true;
    },
    has(c) {
      L("has", c);
      return c === "GetUseDoneSeq";
    },
    GetUseDoneSeq() {
      L("GetUseDoneSeq");
      return W.useDone;
    },
    TryGetPlayerInventory() {
      L("TryGetPlayerInventory");
      return W.inv.slice();
    },
    onEvent(fn) {
      L("onEvent");
      W.subs.push(fn);
    },
    onTick() {
      L("onTick");
    },
    s: {
      playerEnchantments() {
        L("s.playerEnchantments");
        return W.reg.map((r) => ({ ...r }));
      },
      playerKnownSpells() {
        L("s.playerKnownSpells");
        return W.known.slice();
      },
      getSpellRecord(id) {
        L("s.getSpellRecord", id);
        const m = BUFF_META[id >>> 0];
        return m ? { category: m[0], roughLevel: m[1] } : null;
      },
    },
  };
  W.emit = (e) => {
    for (const fn of W.subs) fn(e);
  };
  return { W, host };
}

function stepBuffWorld(W, i, r) {
  W.tick = i;
  if (W.modeAt && W.modeAt.at <= i) {
    W.mode = W.modeAt.m;
    W.modeAt = null;
  }
  W.castBusy = i % 31 === 9 ? 1 : 0;
  W.busy = i % 43 === 2 ? 1 : 0;
  if (i === 140) W.reg = []; // death: the registry empties
  for (const c of W.pendingCasts.splice(0)) {
    if (c.at > i) {
      W.pendingCasts.push(c);
      continue;
    }
    W.useDone++;
    const m = BUFF_META[c.s];
    const roll = r();
    if (!m) continue;
    const fam = m[0];
    if (roll < 0.15) {
      W.emit({ kind: 13, u32: 0x0402, u32b: 0, text: "Your spell fizzled." });
      W.emit({ kind: 14, u32: 0, u32b: 0, text: "" });
      continue;
    }
    if (fam >= 300) {
      // item enchant: confirmed only by chat
      W.emit({ kind: 14, u32: 0, u32b: 0, text: "" });
      if (roll < 0.85) W.emit({ kind: 2, u32: 0, u32b: 0, text: `You cast Spell ${c.s} on Item ${c.t.toString(16)}` });
      continue;
    }
    W.reg = W.reg.filter((e) => e.spellCategory !== fam);
    W.reg.push({ spellId: c.s, spellCategory: fam, startTime: 0, duration: BUFF_DUR[fam], layer: 1 });
    W.emit({ kind: 2, u32: 0, u32b: 0, text: `You cast Spell ${c.s} and feel better.` });
    W.emit({ kind: 14, u32: 0, u32b: 0, text: "" });
  }
  // an unrelated other-target line now and then (today's B7 regex confirms it)
  if (i % 50 === 17) W.emit({ kind: 2, u32: 0, u32b: 0, text: "You cast Imperil Other VI on Drudge Slinker" });
}

function runBuffGolden(setup) {
  const { W, host } = makeBuffWorld();
  const loop = new RynthBuffLoop(host, [1011, 1021, 1031, 1041], {
    log: quiet,
    itemBuffs: [
      { spellId: 3011, itemGuid: 0x60000020 },
      { spellId: 3021, itemGuid: 0x60000021 },
    ],
  });
  loop.startedAt = NOW;
  if (setup) setup(loop, W);
  const r = rng(0xb0ff);
  const out = [];
  const logs = [];
  for (let i = 0; i < 260; i++) {
    NOW += i < 120 ? 400 : 20_000; // a fast start, then hours of timers
    stepBuffWorld(W, i, r);
    W.calls = [];
    if (i % 3 === 0) loop.heartbeat();
    loop.tick();
    const st = loop.status;
    const rec = JSON.stringify({
      c: W.calls,
      st,
      des: loop.desired,
      ip: loop._itemPending ? [loop._itemPending.spellId, loop._itemPending.itemGuid] : null,
      il: [...loop._itemLastCast.keys()],
      fr: loop._forceRebuffing,
      sd: [...loop._shortDurationFamilies],
    });
    out.push(sha8(rec));
    logs.push(rec);
  }
  return { digests: out.join(""), logs, loop, W };
}

// Captured from the PRE-change loops (rynth/*.js @ a33dcb16, unchanged at 008a22ae) with
// `--print-golden`; 8 hex chars per tick. `combat` re-baselined 2026-10-19 for a
// deliberate change (combat_loop.js: after a kill the next melee/missile request
// waits for the killed loop's AttackDone; this world never sends one, so the
// tick-16 request goes out after the 3 s STALE_LOOP_END_TTL_MS, tick 29); loot
// and buff unchanged. `buff` re-baselined 2026-10-19 (b) for a deliberate fix
// (buff_loop.js heartbeat() ends a finished B11/B12 pass the kernel no longer
// ticks — before, _forceRebuffing stuck true and hid every later expiry): the
// same casts and statuses every tick; tick 195 ends the pass one tick earlier
// and ticks 138/147/196/222/246 add the pass-end check's spell-record reads.
const GOLDEN = {
  combat: [
    "2031d7bb543149b6543149b63bafec50543149b654260311543149b6543149b682c3295f82c3295fc4b3067b3293b971",
    "d8f2672ad8f2672a8d5cffa25fa35f8561428a4b5a53e7cfd77c424fd77c424fe186ac5fd77c424fd77c424fd77c424f",
    "5a53e7cfe186ac5fd77c424fd77c424fd77c424f590c06ef83a7c2b8b614bcb392817d3a92817d3a92817d3a83a7c2b8",
    "92817d3a92817d3ab614bcb392817d3a83a7c2b892817d3a92817d3a92817d3a92817d3aaafd1983218a93f2218a93f2",
    "218a93f2218a93f20ef306bd19d443b96adff79c19d443b919d443b919d443b919d443b919d443b91f53a8d037bb9385",
    "aff7ad90aff7ad90aff7ad9018429682985e9dc667039e56351556d067039e565e2a838167039e5667039e5667039e56",
    "67039e561bfed51167039e5667039e5667039e5667039e565e2a838167039e56351556d067039e5667039e565e2a8381",
    "67039e5667039e5667039e56351556d05e2a838167039e5667039e5667039e5667039e565e2a8381351556d067039e56",
    "67039e5667039e565e2a838167039e5667039e56351556d067039e565e2a838167039e5667039e5667039e5667039e56",
    "1bfed511cb7f8275e1dc6ab41380f8203816d20947bb090f3816d209e6f118800630c4d13f97a4a619bf5dab3f97a4a6",
    "0630c4d1d5ce6859ab5e49ad4b84ddaddb5ac815bfd854c7bfd854c7bfd854c7ae16743b8ac2879fcd6e9e44bfd854c7",
    "bfd854c7ae16743bbfd854c7bfd854c78ac2879fbfd854c7ae16743bbfd854c7bfd854c7bfd854c7bfd854c7017b33ae",
    "bfd854c7bfd854c7bfd854c7bfd854c7ae16743bbfd854c78ac2879fbfd854c7bfd854c732f662a96fb2e28b6fb2e28b",
    "2d269ce90059b743462e7e0e39e254e1bc67f72d8537bbd3c1e1db3fe8b7251472f4d8062aba1774d122dd8324d6db5e",
    "3ac73e0e128f26893ac73e0ed104fe983ac73e0e762b688cc75e5cb504dc59d1e6645ff3c386332e1710657c313500e9",
    "382ccd388e95aec499c09f4752f920c9fee76a942d2c936b99c09f4752f920c915920950c90bdc6f345113dc5064cded",
    "611cafa87e50880e2843f7667e50880e7e50880e7e50880e7e50880e1ab450fe7e50880e7e50880e7e50880e7e50880e",
    "2843f7667e50880e611cafa824272be2dda64687887fd1a6c3c8d19fc3c8d19f225dca6d4b97c0f1887fd1a6c3c8d19f",
    "c3c8d19fc3c8d19fc3c8d19f887fd1a64b97c0f15150cb13b61b518d9059a472648e8eb9ccbece98e5d6e8517e32fe53",
    "ceec5de29d93e6d0be67a3f77150b556085706537150b556302f98c701b70222adcb77c3b04e60acf5fac10848d5cc3d",
    "f5fac1081a58fad5f5fac108f5fac10848d5cc3df5fac108f5fac108f5fac10810c7975d0ba25cac2de718782de71878",
    "2de718782de718780ba25cac76776e3c2de718782de718782de718780ba25cac2de718782de7187876776e3c2de71878",
    "0ba25cac047d1ba8047d1ba8047d1ba8047d1ba8a73ad8a7047d1ba8047d1ba8047d1ba8047d1ba8e4962e40047d1ba8",
    "69fbcf944bd68db44bd68db4116818ca4bd68db44bd68db44bd68db44799865d116818ca4bd68db44bd68db44bd68db4",
    "4bd68db4116818ca7027dec1b00d0ad1c683a2d11445ba4af08bf85a974b14904e04308286750c5aaded4cdafb29bd53",
    "3995ffb5a3b925b9802bc213e2bec75c8514ac39d92f706b105c7963637e09f65da5e9285776b21fb2853e5e63e0288a",
    "b2853e5eae20a740e8cd13d3ae20a74005e087bed41d4dcf331db075286d374d92c69966cb7e0b147843e8aacb7e0b14",
    "88c743928fc159ff7843e8aa00069d8238500cf19d37d22039625d1e39625d1e308cb84d39625d1e9d37d2201f3e3bcc",
    "39625d1e39625d1ea132176e3c71be2f39625d1e39625d1e39625d1e39625d1e9d37d22039625d1e308cb84d47557d8f",
    "7f784911ff31f1d84b4dfd004b4dfd004b4dfd001b983a0cff31f1d84b4dfd004b4dfd00c21c7b261a613ef9fded9ced",
  ].join(""),
  loot: [
    "06ed4f71ded9c5655161627762c103a24aa72fc70af885980af885980af88598027146b80af885980af885980af88598",
    "0af88598d49f4f2678b0e0e225e82992501b5780c1da63031d338a77eebe5ecc9f24072fec7e95e10e8b52b10e8b52b1",
    "f8efb8ce924b2aceb04d58760c4d1aa98bdac9031adcb7474b939bc64b939bc64b939bc64b939bc66e929fed8bdac903",
    "b93f461b86c540d1291781f7291781f7576ebff551299d7e51299d7ef8162a97aaf3e31dd538d95d25278b092809ef9c",
    "d09f519ad09f519ad09f519ad09f519ad09f519ad09f519ad09f519a893aaf90c90e2bcb363fc469b5256cba8f309b84",
    "8f309b84227ca71a2c705abdaaa6382bee8cd433fcf28c3d683c3a44fcf28c3dfcf28c3dfcf28c3d3f3ca46c3f3ca46c",
    "3f3ca46cfcf28c3d683c3a44fcf28c3dfcf28c3dfcf28c3dfcf28c3dfcf28c3dfcf28c3dfcf28c3d683c3a44fcf28c3d",
    "fcf28c3dfcf28c3dfcf28c3dfcf28c3dfcf28c3dfcf28c3d683c3a44fcf28c3dfcf28c3dfcf28c3dfcf28c3dfcf28c3d",
    "fcf28c3dfcf28c3d683c3a44fcf28c3dfcf28c3dfcf28c3dfcf28c3dfcf28c3dfcf28c3dfcf28c3d683c3a44fcf28c3d",
    "fcf28c3dfcf28c3dfcf28c3dfcf28c3dfcf28c3dfcf28c3d683c3a44fcf28c3dfcf28c3dfcf28c3dfcf28c3dfcf28c3d",
    "fcf28c3dfcf28c3d683c3a44fcf28c3dfcf28c3dfcf28c3dfcf28c3dfcf28c3dfcf28c3dfcf28c3d683c3a44fcf28c3d",
    "fcf28c3dfcf28c3dfcf28c3dfcf28c3dfcf28c3dfcf28c3d683c3a44fcf28c3dfcf28c3dfcf28c3dfcf28c3dfcf28c3d",
    "fcf28c3dfcf28c3d683c3a44fcf28c3dfcf28c3dfcf28c3dfcf28c3dfcf28c3dfcf28c3dfcf28c3d683c3a44fcf28c3d",
    "fcf28c3dfcf28c3dfcf28c3dfcf28c3dfcf28c3dfcf28c3d683c3a44fcf28c3dfcf28c3dfcf28c3dfcf28c3dfcf28c3d",
    "fcf28c3dfcf28c3d683c3a44fcf28c3dfcf28c3dfcf28c3dfcf28c3dfcf28c3dfcf28c3dfcf28c3d683c3a44fcf28c3d",
    "fcf28c3dfcf28c3dfcf28c3dfcf28c3dfcf28c3dfcf28c3d683c3a44fcf28c3dfcf28c3dfcf28c3dfcf28c3dfcf28c3d",
    "fcf28c3dfcf28c3d683c3a44fcf28c3dfcf28c3dfcf28c3dfcf28c3dfcf28c3dfcf28c3dfcf28c3d683c3a44fcf28c3d",
    "fcf28c3dfcf28c3dfcf28c3dfcf28c3dfcf28c3dfcf28c3d683c3a44fcf28c3dfcf28c3dfcf28c3dfcf28c3dfcf28c3d",
    "fcf28c3dfcf28c3d683c3a44fcf28c3dfcf28c3dfcf28c3dfcf28c3dfcf28c3dfcf28c3dfcf28c3d683c3a44fcf28c3d",
    "fcf28c3dfcf28c3dfcf28c3dfcf28c3dfcf28c3dfcf28c3d683c3a44fcf28c3dfcf28c3dfcf28c3dfcf28c3dfcf28c3d",
  ].join(""),
  buff: [
    "730fda286820f9856820f985eb2b6849b69485af4fd3eb4a53092314fa1fb0f56e8e636c80db9e04a03d151289eb7b00",
    "5035eb3485e295b7a2deeb4ff97c5b3d78021d8f63659962337d2d17337d2d17337d2d17337d2d17337d2d17337d2d17",
    "337d2d17337d2d17337d2d17337d2d17337d2d17337d2d1719800db30012d8c8ed51ff4fa2225f49a2225f49a2225f49",
    "a2225f49a2225f49a2225f49a2225f49db56ee62a2225f49a2225f49a2225f49a2225f492513f495a2225f49a2225f49",
    "a2225f49a2225f49a2225f49a2225f49a2225f49a2225f49a2225f49a2225f49a2225f49a2225f49a2225f49a2225f49",
    "a2225f49a2225f49a2225f49a2225f49a2225f49a2225f49a2225f49a2225f49a2225f49a2225f49a2225f49db56ee62",
    "a2225f49a2225f49a2225f49a2225f49a2225f49a2225f49a2225f49a2225f49a2225f49a2225f49a2225f49a2225f49",
    "a2225f49a2225f49a2225f49a2225f492513f495a2225f49a2225f49a2225f49ca68a693a2225f49a2225f49a2225f49",
    "a2225f49a2225f49a2225f49a2225f49a2225f49a2225f49db56ee62a2225f49a2225f49a2225f49a2225f49a2225f49",
    "a2225f49a2225f49a2225f49a2225f49a2225f49a2225f49a2225f49a2225f49a2225f49a2225f49a2225f49a2225f49",
    "fe9d9409a2225f49ca68a693a2225f49ca68a693a2225f49fe9d9409222bea2ae7b189673e3fdd3dda9c8be51a007a63",
    "f932addfb7efe79877143db7de76692377143db71a4a1d345ed5dacbfa396d595ed5dacba520a9c82ed6adcd479fa390",
    "74964cabd1477700dee7d3985ed5dacbfa396d595ed5dacb35bc260b5ed5dacbfa396d595ed5dacbfa396d595ed5dacb",
    "35bc260b5ed5dacbfa396d595ed5dacbfa396d595ed5dacb35bc260b5ed5dacb02464f0a5ed5dacbfa396d595ed5dacb",
    "35bc260b5ed5dacbfa396d595ed5dacbfa396d595ed5dacb3fe06eee5ed5dacbfa396d595ed5dacbfa396d595ed5dacb",
    "35bc260b5ed5dacbfa396d595ed5dacbfa396d595ed5dacb35bc260b5ed5dacbfa396d59db627b1c4197fd29479fa390",
    "266c97758dfb8fbe44f575bd36dd2b1ca3d1d25ef1adc4d71826ab53f1adc4d7da1cd384de916851da1cd384de916851",
    "7915d7b52ed6adcd479fa390f55866ae479fa3902785808111fa51a31be91fea003d0c23abc3886f53d1d9e8e61cc21f",
    "53d1d9e8726d3ca105aacf794a830aa530371cff14d86b8e0a1aa448b71de8620a1aa4483f648ab714858a7b5a2c4153",
    "078d75ea30371cff14d86b8e07a6401c231c3c948887b9ce25f989f456b0e5ad0c6b06a798afccd10c6b06a72a753c16",
    "cc6ff6a06ebfe3721d5f810c8f7ef5be688816442ab4b0a47f5fb9ed4a54d4017f5fb9ed10130f407f5fb9ed4a54d401",
    "7f5fb9ed4a54d4017f5fb9ed10130f407f5fb9ed43ee83237f5fb9ed4a54d401",
  ].join(""),
};

function compareGolden(label, got, want, logs) {
  assert.equal(got.length, want.length, `${label}: digest length`);
  for (let i = 0; i < want.length; i += 8) {
    if (got.slice(i, i + 8) !== want.slice(i, i + 8)) {
      const t = i / 8;
      assert.fail(`${label}: first divergence at tick ${t}\n         record: ${logs[t].slice(0, 1500)}`);
    }
  }
}

if (PRINT_GOLDEN) {
  const c = runCombatGolden();
  NOW = 1_800_000_000_000;
  const l = runLootGolden();
  NOW = 1_800_000_000_000;
  const b = runBuffGolden();
  console.log(`  combat: "${c.digests}",`);
  console.log(`  loot: "${l.digests}",`);
  console.log(`  buff: "${b.digests}",`);
  Date.now = REAL_NOW;
  process.exit(0);
}

// ── golden replays (V-1) ───────────────────────────────────────────────────
await check("GOLDEN combat: vt null + default perimeter ⇒ host call log, scan output and state identical to the pre-change loop (360 ticks)", () => {
  NOW = 1_800_000_000_000;
  const g = runCombatGolden();
  compareGolden("combat", g.digests, GOLDEN.combat, g.logs);
  // the world really exercised the scan perimeter and every attack path
  const first = JSON.parse(g.logs[0]).scan.map((s) => s.split(":")[0]);
  for (const inR of ["80000103", "80000104"]) assert.ok(first.includes(inR), `tick 0 scan has ${inR}: ${first}`);
  for (const out of ["80000105", "80000109", "8000010a", "50000002", "8000010b", "8000010c"]) assert.ok(!first.includes(out), `tick 0 scan excludes ${out}`);
  const all = g.logs.join("\n");
  for (const call of ["CastSpell(", "MeleeAttack(", "MissileAttack(", "ToggleCombatMode", "TurnToHeading(", "CancelAttack", "StickToObject("])
    assert.ok(all.includes(call), `the fight used ${call}`);
  assert.ok(!/CastSpellAt|CastUntargetedSafe/.test(all), "no safe-member casts without a planner");
  assert.ok(g.loop.kills >= 5 && g.loop.blacklisted >= 1 && g.loop.unreachable.size >= 1, `kills ${g.loop.kills} blacklisted ${g.loop.blacklisted}`);
  assert.ok(g.logs.some((l) => JSON.parse(l).st.state === "PORTAL"));
});

await check("GOLDEN loot: classify null + corpseRangeM 30 ⇒ identical to the pre-change loop (240 ticks)", () => {
  NOW = 1_800_000_000_000;
  const g = runLootGolden();
  compareGolden("loot", g.digests, GOLDEN.loot, g.logs);
  assert.ok(g.loop.lootedCount >= 3 && g.loop.refusedPickups >= 1 && g.loop.emptyCorpses >= 1, JSON.stringify([g.loop.lootedCount, g.loop.refusedPickups, g.loop.emptyCorpses]));
  const all = g.logs.join("\n");
  for (const call of ["RequestId(", "MoveToPosition(", "UseObject(", "CloseContainer(", "MoveItemToContainer("]) assert.ok(all.includes(call), `the run used ${call}`);
});

await check("GOLDEN buff: threshold 300 + no window + unnamed item buffs ⇒ identical to the pre-change loop (260 ticks)", () => {
  NOW = 1_800_000_000_000;
  const g = runBuffGolden();
  compareGolden("buff", g.digests, GOLDEN.buff, g.logs);
  assert.equal(g.loop._itemLastCast.size, 2, "both item enchants confirmed by chat");
  assert.ok(g.logs.some((l) => JSON.parse(l).sd.length > 0), "the short-duration hold (:1201) was exercised");
  assert.ok(g.logs.some((l) => JSON.parse(l).fr), "a batch rebuff ran");
  assert.ok(g.loop.lastRefusal && g.loop.lastRefusal.cls === "fizzle", "a refusal was resolved");
});

// ── combat hooks ───────────────────────────────────────────────────────────
function combatRig({ mobs = [[0x80000201, "Drudge", 0, 8]], mode = 8, known = [27] } = {}) {
  const { W, host } = makeCombatWorld();
  W.mode = mode;
  W.known = known;
  for (const [g, name, dx, dy, x = {}] of mobs) W.ents.set(g, { name, x: W.me.x + dx, y: W.me.y + dy, z: 0, hf: 1, ...x });
  const loop = new RynthCombatLoop(host, { log: quiet });
  return { W, host, loop };
}
function fakePlanner(over = {}) {
  const calls = [];
  return {
    calls,
    scanVerdict(g, d) {
      calls.push(["scanVerdict", g, d]);
      return over.verdict ? over.verdict(g, d) : null;
    },
    ensureLoadout(t) {
      calls.push(["ensureLoadout", t]);
      return over.loadout ? over.loadout(t) : "ok";
    },
    attackAllowed(t) {
      calls.push(["attackAllowed", t]);
      return over.attack ? over.attack(t) : true;
    },
    nextCast(t, o) {
      calls.push(["nextCast", t, o && o.mode]);
      return over.plan ? over.plan(t, o) : null;
    },
    onCastIssued(t, plan, sent) {
      calls.push(["onCastIssued", t, plan, sent]);
    },
  };
}
const scanIds = (loop) => loop._scanTargets().map((t) => t.guid >>> 0);
// two ticks: lock + face settle, then the cast (FACE_SETTLE_MS 140)
function castTicks(loop, W) {
  W.seq++;
  loop.tick();
  NOW += 200;
  W.seq++;
  loop.tick();
}

await check("combat defaults: monsterRangeM 40, acquireRangeFn null, vt null, _castKind null; opts.monsterRangeM honoured", () => {
  const { loop, host } = combatRig();
  assert.equal(loop.monsterRangeM, 40);
  assert.equal(loop.acquireRangeFn, null);
  assert.equal(loop.vt, null);
  assert.equal(loop._castKind, null);
  assert.equal(new RynthCombatLoop(host, { log: quiet, monsterRangeM: 25 }).monsterRangeM, 25);
});

await check("perimeter: 39.9/40.0 in, 40.1 out at the default; monsterRangeM re-ranges after invalidateScan (memo held otherwise)", () => {
  const { W, loop } = combatRig({ mobs: [[1, "A", 0, 39.9], [2, "B", 40, 0], [3, "C", 0, -40.1], [4, "D", 0, 15]] });
  assert.deepEqual(scanIds(loop).sort(), [1, 2, 4]);
  loop.monsterRangeM = 20;
  assert.deepEqual(scanIds(loop).sort(), [1, 2, 4], "same snapshot ⇒ memoized");
  loop.invalidateScan();
  assert.deepEqual(scanIds(loop), [4], "invalidateScan rescans this snapshot");
  loop.monsterRangeM = 41;
  W.seq++;
  assert.deepEqual(scanIds(loop).sort(), [1, 2, 3, 4], "a new snapshot reads the new range");
  loop.monsterRangeM = NaN;
  W.seq++;
  assert.deepEqual(scanIds(loop).sort(), [1, 2, 4], "a bad range falls back to 40");
});

await check("acquireRangeFn: null ⇒ 40; set ⇒ used even with vt null (critic G9); a throw / non-number falls back", () => {
  const { W, loop } = combatRig({ mobs: [[1, "A", 0, 39], [2, "B", 0, -44]] });
  let seen = null;
  loop.acquireRangeFn = (m) => {
    seen = m;
    return Math.max(m, 45);
  };
  assert.equal(loop.vt, null);
  assert.deepEqual(scanIds(loop).sort(), [1, 2]);
  assert.equal(seen, 40, "called with monsterRangeM");
  for (const bad of [() => {
    throw new Error("x");
  }, () => NaN, () => "50", () => undefined]) {
    loop.acquireRangeFn = bad;
    W.seq++;
    assert.deepEqual(scanIds(loop), [1]);
  }
  loop.acquireRangeFn = (m) => m; // the planner's value at defaults
  W.seq++;
  assert.deepEqual(scanIds(loop), [1]);
});

await check("scanVerdict: ignore excludes, scoreBias is added (P×1000 beats distance), consulted only inside the perimeter", () => {
  const { loop } = combatRig({ mobs: [[1, "Near", 0, 5], [2, "Ignored", 0, 6], [3, "Far P4", 0, 30], [4, "Outside", 0, 45], [5, "NaN bias", 0, 7]] });
  const vt = fakePlanner({
    verdict: (g) => (g === 2 ? { ignore: true } : g === 3 ? { scoreBias: 4000 } : g === 5 ? { scoreBias: NaN } : { scoreBias: 1000 }),
  });
  loop.vt = vt;
  const out = loop._scanTargets();
  assert.deepEqual(out.map((t) => t.guid), [3, 1, 5], "P4 at 30 m first, the ignored one gone");
  assert.equal(out[0].score, 100 - 30 + 4000);
  assert.equal(out[2].score, 100 - 7, "a NaN bias adds nothing");
  assert.ok(!vt.calls.some((c) => c[1] === 4), "no verdict asked beyond the perimeter");
});

await check("magic tick with a planner: hooks in order scanVerdict… → ensureLoadout → nextCast → onCastIssued; the cast goes through CastSpellAt", () => {
  const { W, loop } = combatRig();
  const vt = fakePlanner({ plan: () => ({ spellId: 2228, kind: "debuff", untargeted: false, family: "broadside" }) });
  loop.vt = vt;
  castTicks(loop, W);
  const names = vt.calls.map((c) => c[0]);
  const i1 = names.lastIndexOf("ensureLoadout");
  const i2 = names.lastIndexOf("nextCast");
  const i3 = names.lastIndexOf("onCastIssued");
  assert.ok(names.indexOf("scanVerdict") < i1 && i1 < i2 && i2 < i3, names.join(","));
  assert.deepEqual(vt.calls[i3].slice(1), [0x80000201, { spellId: 2228, kind: "debuff", untargeted: false, family: "broadside" }, true]);
  assert.equal(vt.calls[i2][2], 8, "nextCast gets mode 8");
  const casts = W.calls.filter((c) => /^Cast/.test(c));
  assert.deepEqual(casts, [`CastSpellAt(${0x80000201},2228)`]);
  assert.equal(loop._castKind, "debuff");
});

await check("cast routing: no planner ⇒ CastSpell only; planner null plan ⇒ legacy bolt via CastSpellAt; ring ⇒ CastUntargetedSafe(allowRing)", () => {
  {
    const { W, loop } = combatRig();
    castTicks(loop, W);
    const all = W.calls.join(" ");
    assert.ok(all.includes(`CastSpell(${0x80000201},27)`) && !/CastSpellAt|CastUntargetedSafe/.test(all), all);
    assert.equal(loop._castKind, null);
  }
  {
    const { W, loop } = combatRig();
    loop.vt = fakePlanner({ plan: () => null });
    castTicks(loop, W);
    const casts = W.calls.filter((c) => /^Cast/.test(c));
    assert.deepEqual(casts, [`CastSpellAt(${0x80000201},27)`]);
    assert.equal(loop._castKind, "attack");
  }
  {
    const { W, loop } = combatRig();
    const vt = fakePlanner({ plan: () => ({ spellId: 1785, kind: "ring", untargeted: true, family: "ring:fire" }) });
    loop.vt = vt;
    castTicks(loop, W);
    const casts = W.calls.filter((c) => /^Cast/.test(c));
    assert.deepEqual(casts, ['CastUntargetedSafe(1785,{"allowRing":true})']);
    assert.equal(loop._castKind, "ring");
  }
});

// Resolve the cast in flight (UseDone advances) and let BLACKLIST_CAST_SETTLE_MS pass.
function resolveAndSettle(loop, W) {
  W.useDone++;
  NOW += 1600;
  W.seq++;
  loop.tick(); // resolves (and may cast the next one)
}

await check("debuff and ring casts never count as no-contact misses (3+ debuffs keep the lock); attack and legacy casts do", () => {
  for (const kind of ["debuff", "ring"]) {
    const { W, loop } = combatRig();
    loop.vt = fakePlanner({ plan: () => ({ spellId: kind === "ring" ? 1785 : 2228, kind, untargeted: kind === "ring", family: "x" }) });
    castTicks(loop, W);
    for (let i = 0; i < 5; i++) resolveAndSettle(loop, W);
    assert.equal(loop.status.castMisses, 0, `${kind}: no misses`);
    assert.equal(loop.blacklisted, 0, `${kind}: never blacklisted`);
    assert.equal(loop.locked, 0x80000201);
  }
  {
    const { W, loop } = combatRig();
    loop.vt = fakePlanner({ plan: () => ({ spellId: 2132, kind: "attack", untargeted: false, family: "bolt:pierce" }) });
    castTicks(loop, W);
    resolveAndSettle(loop, W);
    assert.equal(loop.status.castMisses, 1, "attack kind counts");
    for (let i = 0; i < 4; i++) resolveAndSettle(loop, W);
    assert.equal(loop.blacklisted, 1, "three settled attack misses blacklist as before");
  }
  {
    const { W, loop } = combatRig();
    castTicks(loop, W);
    resolveAndSettle(loop, W);
    assert.equal(loop.status.castMisses, 1, "legacy (no planner) counts as before");
  }
});

await check("{done} drops the lock (no kill, state ACQUIRE) and invalidates the scan memo; {skip} casts nothing and keeps it", () => {
  {
    const { W, loop } = combatRig();
    let done = false;
    loop.vt = fakePlanner({ plan: () => (done ? { done: true } : null) });
    W.seq++;
    loop.tick();
    assert.equal(loop.locked, 0x80000201);
    done = true;
    const epoch = loop._scanEpoch;
    W.calls = [];
    loop.tick(); // same snapshot seq
    assert.equal(loop.locked, 0);
    assert.equal(loop.state, "ACQUIRE");
    assert.equal(loop.kills, 0, "no kill counted");
    assert.equal(loop._scanEpoch, epoch + 1, "scan memo invalidated");
    assert.ok(!W.calls.some((c) => /^Cast/.test(c)));
    W.calls = [];
    loop._scanTargets();
    assert.ok(W.calls.includes("NearbyGuids"), "the same snapshot is rescanned");
  }
  {
    const { W, loop } = combatRig();
    loop.vt = fakePlanner({ plan: () => ({ skip: true }) });
    castTicks(loop, W);
    castTicks(loop, W);
    assert.ok(!W.calls.some((c) => /^Cast/.test(c)));
    assert.equal(loop.locked, 0x80000201);
  }
});

await check("an unsent planner cast releases the cast token, tells the planner sent=false and arms nothing", () => {
  const { W, loop } = combatRig();
  const vt = fakePlanner({ plan: () => ({ spellId: 2228, kind: "debuff", untargeted: false, family: "broadside" }) });
  loop.vt = vt;
  W.castOk = false;
  castTicks(loop, W);
  assert.ok(W.calls.includes("releaseCast(combat)"), W.calls.join(" "));
  assert.equal(W.token, null);
  assert.equal(loop.awaitingCast, false);
  assert.equal(loop._castKind, null);
  const last = vt.calls.filter((c) => c[0] === "onCastIssued").pop();
  assert.equal(last[3], false);
});

await check("ensureLoadout 'busy' holds the lock before the mode toggle (no toggle, no swing); 'ok' proceeds", () => {
  const { W, loop } = combatRig({ mode: 1 });
  let busy = true;
  loop.vt = fakePlanner({ loadout: () => (busy ? "busy" : "ok") });
  for (let i = 0; i < 3; i++) {
    NOW += 4000;
    W.seq++;
    loop.tick();
  }
  assert.ok(!W.calls.includes("ToggleCombatMode"), "no toggle while a wield is in flight");
  assert.equal(loop._modeAttempts || 0, 0, "the mode-toggle guard is not charged");
  assert.equal(loop.locked, 0x80000201);
  busy = false;
  NOW += 4000;
  W.seq++;
  loop.tick();
  assert.ok(W.calls.includes("ToggleCombatMode"));
});

await check("attackAllowed false (A column off) drops the melee lock without a swing; true swings as before", () => {
  {
    const { W, loop } = combatRig({ mode: 2 });
    loop.vt = fakePlanner({ attack: () => false });
    const epoch = loop._scanEpoch;
    W.seq++;
    loop.tick();
    assert.ok(!W.calls.some((c) => c.startsWith("MeleeAttack")), W.calls.join(" "));
    assert.equal(loop.locked, 0);
    assert.equal(loop._scanEpoch, epoch + 1);
  }
  {
    const { W, loop } = combatRig({ mode: 2 });
    loop.vt = fakePlanner({ attack: () => true });
    W.seq++;
    loop.tick();
    assert.ok(W.calls.some((c) => c.startsWith("MeleeAttack")));
  }
});

await check("underAttack(): an attacker within attackerGraceMs (kind 19 damageTaken / evadedAttacker, the 'hits you' chat line)", () => {
  const { W, loop } = combatRig();
  loop.tick(); // installs the event tap
  assert.equal(loop.underAttack(), false);
  W.emit({ kind: 19, u32: 0, u32b: 0, text: JSON.stringify({ type: "damageTaken", attackerName: "Drudge", damage: 3 }) });
  assert.equal(loop.underAttack(), true);
  NOW += 10_001;
  assert.equal(loop.underAttack(), false, "grace lapsed");
  W.emit({ kind: 2, u32: 0, u32b: 0, text: "Mosswart singes you for 5 points with Flame Bolt I." });
  assert.equal(loop.underAttack(NOW), true);
  assert.equal(loop.underAttack(NOW + 10_001), false);
});

await check("underAttack() installs the combat event tap itself (an attack before the first combat tick is still seen)", () => {
  const { W, loop } = combatRig();
  assert.equal(W.subs.length, 0, "no tap before the first tick");
  assert.equal(loop.underAttack(), false);
  assert.equal(W.subs.length, 1, "tap installed by the read");
  W.emit({ kind: 19, u32: 0, u32b: 0, text: JSON.stringify({ type: "evadedAttacker", attackerName: "Drudge" }) });
  assert.equal(loop.underAttack(), true);
  loop.tick();
  assert.equal(W.subs.length, 1, "still exactly one tap");
});

await check("netBrain input: Config.MonsterRange = monsterRangeM (40 by default)", () => {
  const { loop } = combatRig();
  assert.equal(loop._nbBuildInput(0, NOW).Config.MonsterRange, 40);
  loop.monsterRangeM = 25;
  assert.equal(loop._nbBuildInput(0, NOW).Config.MonsterRange, 25);
});

await check("a planner whose every hook throws never stalls the loop (legacy decisions, safe cast member)", () => {
  const { W, loop } = combatRig();
  const boom = () => {
    throw new Error("planner bug");
  };
  loop.vt = { scanVerdict: boom, ensureLoadout: boom, attackAllowed: boom, nextCast: boom, onCastIssued: boom };
  castTicks(loop, W);
  assert.equal(loop.locked, 0x80000201);
  assert.ok(W.calls.includes(`CastSpellAt(${0x80000201},27)`), W.calls.join(" "));
  assert.equal(loop.awaitingCast, true);
});

// ── buff hooks ─────────────────────────────────────────────────────────────
function buffRig({ desired = [1016], reg = [], opts = {} } = {}) {
  const { W, host } = makeBuffWorld();
  W.mode = 8;
  W.reg = reg;
  const loop = new RynthBuffLoop(host, desired, { log: quiet, ...opts });
  loop.startedAt = NOW;
  loop._buildLadders();
  loop.registryReady = true;
  loop._refresh();
  return { W, host, loop };
}
const row = (spellId, remainingS, fam = BUFF_META[spellId][0]) => ({ spellId, spellCategory: fam, startTime: 0, duration: remainingS, layer: 1 });
// A buff that has already run part of a real duration: `remainingS` left of
// `durationS` (wire start_time = −age). The idle window is capped per landed
// duration (review safety-3), so a "400 s left" buff must not be modelled as a
// fresh 400 s landing there.
const aged = (spellId, remainingS, durationS = 1800, fam = BUFF_META[spellId][0]) => ({ spellId, spellCategory: fam, startTime: remainingS - durationS, duration: durationS, layer: 1 });

await check("buff: rebuffSecondsRemaining defaults to 300 (opts override), idleRebuffWindowS to 0", () => {
  const a = buffRig().loop;
  assert.equal(a.rebuffSecondsRemaining, 300);
  assert.equal(a.idleRebuffWindowS, 0);
  assert.equal(buffRig({ opts: { rebuffSecondsRemaining: 600 } }).loop.rebuffSecondsRemaining, 600);
});

await check("buff: _isActiveReal compares remaining with rebuffSecondsRemaining + idleRebuffWindowS (bad values fall back)", () => {
  const { loop } = buffRig({ reg: [aged(1016, 400)] });
  assert.equal(loop._isActiveReal(1016), true, "400 > 300");
  loop.rebuffSecondsRemaining = 450;
  assert.equal(loop._isActiveReal(1016), false, "400 ≤ 450");
  loop.rebuffSecondsRemaining = 300;
  loop.idleRebuffWindowS = 200;
  assert.equal(loop._isActiveReal(1016), false, "400 ≤ 300 + 200");
  loop.idleRebuffWindowS = 0;
  assert.equal(loop._isActiveReal(1016), true);
  loop.rebuffSecondsRemaining = NaN;
  loop.idleRebuffWindowS = undefined;
  assert.equal(loop._isActiveReal(1016), true, "NaN / undefined ⇒ 300 + 0");
  // the exact boundary: strictly more than the threshold is active
  loop.rebuffSecondsRemaining = 300;
  loop.idleRebuffWindowS = 0;
  loop.families.get(101).expiresAtMs = NOW + 300_500;
  assert.equal(loop._isActiveReal(1016), true, "300.5 s > 300");
  loop.families.get(101).expiresAtMs = NOW + 300_000;
  assert.equal(loop._isActiveReal(1016), false, "300 s is not > 300");
  loop.idleRebuffWindowS = 0.4;
  loop.families.get(101).expiresAtMs = NOW + 300_500;
  assert.equal(loop._isActiveReal(1016), true, "300.5 > 300.4");
  loop.idleRebuffWindowS = 0.6;
  assert.equal(loop._isActiveReal(1016), false, "300.5 ≤ 300.6");
});

await check("buff: the idle window reaches only _isActiveReal — not the netBrain config nor the short-duration hold (:1201)", () => {
  const { W, loop } = buffRig({ desired: [1016, 1023], reg: [] });
  loop.idleRebuffWindowS = 600;
  assert.equal(loop._nbBuildInput(NOW).Config.RebuffSecondsRemaining, 300);
  loop.rebuffSecondsRemaining = 450;
  assert.equal(loop._nbBuildInput(NOW).Config.RebuffSecondsRemaining, 450);
  loop.rebuffSecondsRemaining = 300;
  // a cast that lands with 250 s is held (≤ 300); one landing with 500 s is not (500 > 300, window ignored)
  for (const [id, dur, held] of [[1016, 250, true], [1023, 500, false]]) {
    loop.pending = { spellId: id, issuedAt: NOW - 1000, useDoneAtIssue: null, useDoneAt: 0, refusal: null, useDoneEvents: 0 };
    loop._lastPendingPollAt = 0;
    W.reg = W.reg.filter((r) => r.spellCategory !== BUFF_META[id][0]).concat([row(id, dur)]);
    loop._tickJs();
    assert.equal(loop.pending, null, `${id} confirmed`);
    assert.equal(loop._shortDurationFamilies.has(BUFF_META[id][0]), held, `${id} held=${held}`);
  }
});

await check("buff: needsBuff() ≡ needsBuff({extraWindowS:0}) ≡ the kernel's _buffNeeded() on a table of buff-loop states (critic C10)", async () => {
  const { RynthBotKernel } = await import("../rynth/kernel.js");
  const states = [
    ["all active", (l) => l],
    ["disabled", (l) => (l.enabled = false)],
    ["blocked, nothing pending, a buff missing", (l) => ((l._blocked = { reason: "no-caster", until: NOW + 5000 }), l.families.delete(101))],
    ["blocked with a pending cast", (l) => ((l._blocked = { reason: "mana", until: NOW + 5000 }), (l.pending = { spellId: 1016, issuedAt: NOW }))],
    ["block expired, a buff missing", (l) => ((l._blocked = { reason: "mana", until: NOW - 1 }), l.families.delete(101))],
    ["registry not ready", (l) => (l.registryReady = false)],
    ["a buff missing", (l) => l.families.delete(101)],
    ["a cast pending", (l) => (l.pending = { spellId: 1023, issuedAt: NOW })],
    ["below threshold", (l) => (l.families.get(101).expiresAtMs = NOW + 200_000)],
    ["force rebuffing", (l) => l.forceRebuff()],
  ];
  for (const [name, mut] of states) {
    const { host, loop } = buffRig({ desired: [1016, 1023], reg: [row(1016, 2000), row(1023, 2000)] });
    mut(loop);
    const k = new RynthBotKernel(host, { combat: null, buff: loop, loot: null, vitals: null, unwedge: null }, { log: quiet });
    const want = k._buffNeeded();
    assert.equal(loop.needsBuff(), want, name);
    assert.equal(loop.needsBuff({ extraWindowS: 0 }), want, `${name} (window 0)`);
  }
});

await check("buff: needsBuff({extraWindowS}) adds the idle window; permanent, short-held and parked families never count; the window is restored", () => {
  const { loop } = buffRig({ desired: [1016, 1023, 1031], reg: [aged(1016, 700), row(1023, 2000), row(1031, -1)] });
  assert.equal(loop.needsBuff(), false, "all above 300");
  assert.equal(loop.needsBuff({ extraWindowS: 600 }), true, "700 ≤ 900");
  assert.equal(loop.needsBuff({ extraWindowS: 300 }), false, "700 > 600");
  assert.equal(loop.needsBuff({ extraWindowS: -5 }), false);
  assert.equal(loop.needsBuff({ extraWindowS: NaN }), false);
  loop.idleRebuffWindowS = 42;
  loop.needsBuff({ extraWindowS: 600 });
  assert.equal(loop.idleRebuffWindowS, 42, "restored");
  loop.idleRebuffWindowS = 0;
  // permanent only
  const p = buffRig({ desired: [1031], reg: [row(1031, -1)] }).loop;
  assert.equal(p.needsBuff({ extraWindowS: 1e6 }), false, "permanent never counts");
  // short-duration held family
  const s = buffRig({ desired: [1016], reg: [row(1016, 250)] }).loop;
  s._shortDurationFamilies.add(101);
  assert.equal(s.needsBuff(), false);
  assert.equal(s.needsBuff({ extraWindowS: 600 }), false, "held short-duration family never counts");
  // parked
  const k = buffRig({ desired: [1016], reg: [row(1016, 700)] }).loop;
  k.parkedUntil.set(1016, NOW + 60_000);
  assert.equal(k.needsBuff({ extraWindowS: 600 }), false, "parked never counts");
});

// Review safety-3: RebuffSecondsRemaining + IdleRebuffWindowSec ≥ a buff's
// duration (in-schema) read every FRESH landing as "below", so the idle slot
// recast the whole set every ~1.75 s for as long as the character idled. The
// real RynthBuffLoop + the real IdleRebuff slot (rynth/vt/support/idle.js);
// every landing carries its own start_time (it re-stamps, as live).
async function idleRebuffRun({ dur = 1800, rsr = 300, win = 600, preset = null, idleSteps = 1200 } = {}) {
  const { createIdle } = await import("../rynth/vt/support/idle.js");
  const META = { 1011: [101, 1], 1021: [102, 1] };
  const W = { reg: [], useDone: 0, pending: [], subs: [], token: null, casts: [], seq: 0 };
  const host = {
    IsPlayerReady: () => true, IsPortalSpaceActive: () => false, GetCurrentCombatMode: () => 8, ChangeCombatMode: () => true,
    GetCastBusyState: () => 0, GetBusyState: () => 0, GetPlayerId: () => ME,
    CastSpell(t, sp) { W.casts.push(sp); W.pending.push({ sp, at: NOW + 1500 }); return true; },
    tryClaimCast(o) { if (W.token && W.token !== o) return false; W.token = o; return true; },
    releaseCast(o) { if (W.token === o) W.token = null; return true; },
    has: (c) => c === "GetUseDoneSeq", GetUseDoneSeq: () => W.useDone,
    TryGetPlayerInventory: () => [{ guid: 0x60000010, equipMask: 0x01000000 }],
    onEvent(fn) { W.subs.push(fn); }, onTick() {},
    s: {
      playerEnchantments: () => W.reg.map((r) => ({ ...r })),
      playerKnownSpells: () => Object.keys(META).map(Number),
      getSpellRecord: (id) => (META[id] ? { category: META[id][0], roughLevel: META[id][1] } : null),
    },
  };
  const land = () => {
    for (const c of W.pending.splice(0)) {
      if (c.at > NOW) { W.pending.push(c); continue; }
      W.useDone++;
      const fam = META[c.sp][0];
      W.reg = W.reg.filter((r) => r.spellCategory !== fam).concat([{ spellId: c.sp, spellCategory: fam, startTime: -(++W.seq) * 1e-3, duration: dur, layer: 1 }]);
      W.token = null;
      for (const fn of W.subs) fn({ kind: 2, u32: 0, u32b: 0, text: `You cast Spell ${c.sp} and feel better.` });
      for (const fn of W.subs) fn({ kind: 14, u32: 0, u32b: 0, text: "" });
    }
  };
  const loop = new RynthBuffLoop(host, [1011, 1021], { log: quiet, rebuffSecondsRemaining: rsr });
  loop.startedAt = NOW;
  const values = { RebuffWhenIdle: true, IdleRebuffWindowSec: win };
  const idle = createIdle({ host, options: { getValue: (k) => values[k] }, buff: () => loop, combat: () => null, log: quiet });
  if (preset) W.reg = preset(META);
  else for (let i = 0; i < 60; i++) { NOW += 500; land(); if (i % 3 === 0) loop.heartbeat(); loop.tick(); } // the buff-up
  const upCasts = W.casts.length;
  let slotTicks = 0;
  for (let i = 0; i < idleSteps; i++) {
    NOW += 500; land(); if (i % 3 === 0) loop.heartbeat();
    if (loop.needsBuff()) { loop.tick(); continue; } // the kernel's Buffing rung
    if (idle.rebuffSlot.enabled() && idle.rebuffSlot.wants()) { slotTicks++; idle.rebuffSlot.tick(); } // beforeIdle
  }
  return { upCasts, idleCasts: W.casts.length - upCasts, slotTicks };
}

await check("buff × IdleRebuff (review safety-3): a window that reaches a fresh landing never loops; the default window still tops off", async () => {
  const N0 = NOW;
  try {
    // [label, run options, max casts in the 10 idle minutes, max IdleRebuff slot ticks]. The
    // buffs land ~30 s before the idle period, so at RSR 1200 the BASE threshold recasts the
    // set once (age 600 s): that is RebuffSecondsRemaining doing its job, not the window.
    const cases = [
      ["RSR 1200 + window 600 on 1800 s buffs (sum = duration)", { rsr: 1200, win: 600 }, 2, 0],
      ["RSR 300 + window 1500 on 1800 s buffs (sum = duration)", { rsr: 300, win: 1500 }, 0, 0],
      ["RSR 1100 + window 600 on 1800 s buffs (sum just under)", { rsr: 1100, win: 600 }, 12, 6], // ≤ one 2-cast batch per 100 s
      ["Level VII 3600 s buffs, window at the schema max 3600", { dur: 3600, rsr: 300, win: 3600 }, 0, 0],
      ["2700 s buffs, RSR 1800 + window 900", { dur: 2700, rsr: 1800, win: 900 }, 0, 0],
      ["defaults 300 + 600 on fresh 1800 s buffs", { rsr: 300, win: 600 }, 0, 0],
    ];
    for (const [label, o, maxCasts, maxTicks] of cases) {
      NOW = N0;
      const r = await idleRebuffRun(o);
      assert.equal(r.upCasts, 2, `${label}: the buff-up casts both buffs once`);
      assert.ok(r.idleCasts <= maxCasts && r.slotTicks <= maxTicks, `${label}: ${r.idleCasts} idle casts (max ${maxCasts}), ${r.slotTicks} slot ticks (max ${maxTicks})`);
    }
    // The defaults still top off early when idle: 850 s left of 1800 (≤ 300 + 600) is recast,
    // 950 s left (> 900) is not.
    for (const [left, recast] of [[850, true], [950, false]]) {
      NOW = N0;
      const preset = (META) => Object.keys(META).map((id) => ({ spellId: Number(id), spellCategory: META[id][0], startTime: left - 1800, duration: 1800, layer: 1 }));
      const r = await idleRebuffRun({ rsr: 300, win: 600, preset, idleSteps: 20 });
      assert.equal(r.idleCasts > 0, recast, `${left} s left: idle casts ${r.idleCasts}, slot ticks ${r.slotTicks}`);
    }
  } finally {
    NOW = N0;
  }
});

await check("buff: setItemBuffs replaces the B7 list (invalid rows dropped, names trimmed); [] is today's dormant B7", () => {
  const { loop } = buffRig({ opts: { itemBuffs: [{ spellId: 3011, itemGuid: 5 }] } });
  const n = loop.setItemBuffs([
    { spellId: 3011, itemGuid: 0x60000020, itemName: "  Shield of Testing " },
    { spellId: 0, itemGuid: 1 },
    { spellId: 3021, itemGuid: 0 },
    null,
    { spellId: 3021, itemGuid: 0x60000021 },
  ]);
  assert.equal(n, 2);
  assert.deepEqual(loop.itemBuffs, [
    { spellId: 3011, itemGuid: 0x60000020, itemName: "Shield of Testing" },
    { spellId: 3021, itemGuid: 0x60000021 },
  ]);
  assert.equal(loop.setItemBuffs([]), 0);
  assert.deepEqual(loop.itemBuffs, []);
  assert.equal(loop._maintainItemBuffs(NOW, loop.host), false, "dormant");
  assert.equal(loop.setItemBuffs(undefined), 0);
});

await check("buff: a named item enchant is confirmed only by 'You cast … on <that item>[, suffix]' (U2 H5); unnamed keeps today's form", () => {
  const { W, loop } = buffRig({ desired: [1016], reg: [row(1016, 5000)] });
  loop.setItemBuffs([{ spellId: 3011, itemGuid: 0x60000020, itemName: "Shield of Testing" }]);
  W.calls = [];
  loop._tickJs();
  assert.ok(W.calls.includes(`CastSpell(${0x60000020},3011)`), W.calls.join(" "));
  assert.equal(loop._itemPending.itemName, "Shield of Testing");
  const say = (text) => W.emit({ kind: 2, u32: 0, u32b: 0, text });
  say("You cast Imperil Other VI on Drudge Slinker");
  assert.ok(loop._itemPending, "a debuff line no longer confirms the item enchant");
  say("You cast Blade Bane VI on Shield of Testing Golem");
  assert.ok(loop._itemPending, "a longer name starting with the item's does not match");
  say("You cast Blade Bane VI on shield of testing, refreshing Blade Bane V");
  assert.equal(loop._itemPending, null, "the item's own line (any case, with suffix) confirms");
  assert.ok(loop._itemLastCast.has(`3011:${0x60000020}`));
  assert.equal(W.token, null, "cast token released");
  // regex specials in the name
  const r2 = buffRig({ desired: [1016], reg: [row(1016, 5000)] });
  r2.loop.setItemBuffs([{ spellId: 3021, itemGuid: 0x60000021, itemName: "Ring (Aged) [x]+" }]);
  r2.loop._tickJs();
  r2.W.emit({ kind: 2, u32: 0, u32b: 0, text: "You cast Acid Bane VI on Ring (Aged) [x]+" });
  assert.equal(r2.loop._itemPending, null, "specials escaped");
  // unnamed: today's any-target form
  const r3 = buffRig({ desired: [1016], reg: [row(1016, 5000)], opts: { itemBuffs: [{ spellId: 3011, itemGuid: 0x60000020 }] } });
  r3.loop._tickJs();
  assert.ok(r3.loop._itemPending && !("itemName" in r3.loop._itemPending), "no itemName field without a name");
  r3.W.emit({ kind: 2, u32: 0, u32b: 0, text: "You cast Imperil Other VI on Drudge Slinker" });
  assert.equal(r3.loop._itemPending, null, "unnamed: any 'You cast X on Y' confirms, as before");
});

// ── loot hooks ─────────────────────────────────────────────────────────────
function lootRig({ corpses = [], minValue = 0, opts = {} } = {}) {
  const { W, host } = makeLootWorld();
  for (const [g, dx, dy, items = []] of corpses) {
    W.objs.set(g, { wcid: 21, x: W.me.x + dx, y: W.me.y + dy });
    W.contents.set(g, items);
  }
  const loop = new RynthLootLoop(host, { minValue, log: quiet, ...opts });
  return { W, host, loop };
}

await check("loot defaults: corpseRangeM 30, classify null; opts override", () => {
  const { host, loop } = lootRig();
  assert.equal(loop.corpseRangeM, 30);
  assert.equal(loop.classify, null);
  const f = () => null;
  const l2 = new RynthLootLoop(host, { corpseRangeM: 45, classify: f, log: quiet });
  assert.equal(l2.corpseRangeM, 45);
  assert.equal(l2.classify, f);
});

await check("loot corpseRangeM: 29.9 found, 30.1 not at the default; a larger range finds it; NaN ⇒ 30", () => {
  const { loop } = lootRig({ corpses: [[0x70000010, 0, 30.1]] });
  assert.equal(loop._findCorpse(), null);
  const near = lootRig({ corpses: [[0x70000011, 0, -29.9]] }).loop;
  assert.equal(near._findCorpse().guid, 0x70000011);
  loop.corpseRangeM = 31;
  assert.equal(loop._findCorpse().guid, 0x70000010);
  loop.corpseRangeM = NaN;
  assert.equal(loop._findCorpse(), null);
});

await check("loot classify: pickup bypasses the Value floor, skip drops, pending holds (one RequestId) then skips, null = Value rule, a throw = Value rule", () => {
  const A = 0x71000101; // pickup though worth 1
  const B = 0x71000102; // skip though worth 1e6
  const C = 0x71000103; // pending forever → timeout → skipped
  const D = 0x71000104; // null → Value rule (50 ≥ 10 → picked)
  const E = 0x71000105; // pending, then pickup
  const F = 0x71000106; // classify throws → Value rule (5 < 10 → skipped)
  const { W, loop } = lootRig({ corpses: [[0x70000020, 2, 0, [A, B, C, D, E, F]]], minValue: 10 });
  for (const [g, v] of [[A, 1], [B, 1e6], [D, 50], [E, 1], [F, 5]]) {
    W.values.set(g, v);
    W.appraised.add(g);
  }
  const seen = [];
  let eAsks = 0;
  loop.classify = (item, ctx) => {
    seen.push([item, ctx && ctx.host === loop.host, typeof (ctx && ctx.now)]);
    if (item === A) return "pickup";
    if (item === B) return "skip";
    if (item === C) return "pending";
    if (item === E) return ++eAsks <= 3 ? "pending" : "pickup"; // appraisal data lands after 3 asks
    if (item === F) throw new Error("profile bug");
    return null;
  };
  const moved = [];
  for (let i = 0; i < 80; i++) {
    NOW += 250;
    stepLootWorld(W, 1000 + i);
    W.calls = [];
    loop.tick();
    for (const c of W.calls) if (c.startsWith("MoveItemToContainer(")) moved.push(Number(c.slice(20).split(",")[0]));
  }
  assert.deepEqual(moved, [A, D, E], `picked ${moved.map((x) => x.toString(16))}`);
  assert.ok(seen.every(([, h, t]) => h && t === "number"), "classify(item, { host, now })");
  assert.ok(seen.some(([g]) => g === C) && seen.some(([g]) => g === F));
  assert.equal(loop.lootedCount, 3);
  assert.equal(loop.state, "SCAN", "corpse finished");
});

await check("loot classify 'pending': RequestId once, held APPRAISE_TIMEOUT_MS (2.5 s) at the head, then skipped", () => {
  const C = 0x71000201;
  const { W, loop } = lootRig({ corpses: [[0x70000030, 2, 0, [C]]] });
  loop.classify = () => "pending";
  let req = 0;
  let doneAt = null;
  const t0 = NOW;
  for (let i = 0; i < 40 && doneAt == null; i++) {
    NOW += 100;
    stepLootWorld(W, 2000 + i);
    W.calls = [];
    loop.tick();
    req += W.calls.filter((c) => c.startsWith("RequestId(")).length;
    if (loop.state === "SCAN" && loop.looted.has(0x70000030)) doneAt = NOW;
  }
  assert.equal(req, 1, "one RequestId");
  assert.ok(doneAt != null, "the corpse finished");
  assert.ok(!W.moves.length && W.inv.size === 0, "nothing picked up");
  assert.ok(doneAt - t0 >= 2500, `held ${doneAt - t0} ms`);
});

await check("loot classify 'pickup': a pickup refused as 'too busy' is retried at most 3 times (MAX_PICKUP_TRIES), exactly like the Value path", () => {
  const A = 0x71000301;
  const CORPSE = 0x70000040;
  for (const viaClassify of [false, true]) {
    // viaClassify: the Value floor (1e9) would skip A — only the verdict picks it up.
    const { W, loop } = lootRig({ corpses: [[CORPSE, 2, 0, [A]]], minValue: viaClassify ? 1e9 : 10 });
    W.values.set(A, 50);
    W.appraised.add(A);
    if (viaClassify) loop.classify = () => "pickup";
    let sends = 0;
    for (let i = 0; i < 160 && !loop.looted.has(CORPSE); i++) {
      NOW += 250;
      W.busyRefuse.add(A); // the server stays "too busy" for every attempt
      stepLootWorld(W, 3000 + i);
      W.calls = [];
      loop.tick();
      sends += W.calls.filter((c) => c.startsWith(`MoveItemToContainer(${A},`)).length;
    }
    const how = viaClassify ? "classify pickup" : "Value rule";
    assert.equal(sends, 3, `${how}: ${sends} pickups sent`);
    assert.ok(loop.looted.has(CORPSE), `${how}: the corpse finished`);
    assert.equal(loop.refusedPickups, 1, `${how}: counted once as refused`);
    assert.equal(W.inv.size, 0);
  }
});

// ── V-2 at the loop level: the hooks as INT-2 sets them at the Default profile ──
await check("GOLDEN at the Default layer: acquireRangeFn (m) => m, monsterRangeM/corpseRangeM/rebuffSecondsRemaining cells at 40/30/300, a classify with no verdict, the item-buff projection of the same rows ⇒ the same digests", () => {
  NOW = 1_800_000_000_000;
  const c = runCombatGolden((loop) => {
    loop.monsterRangeM = 40;
    loop.acquireRangeFn = (m) => m; // set ALWAYS by INT-2 (critic G9); planner.acquireRangeM returns m at defaults
  });
  compareGolden("combat@Default", c.digests, GOLDEN.combat, c.logs);
  NOW = 1_800_000_000_000;
  let asked = 0;
  const l = runLootGolden((loop) => {
    loop.corpseRangeM = 30;
    loop.classify = () => {
      asked++;
      return null; // a profile with no verdict = the Value floor decides
    };
  });
  compareGolden("loot@Default", l.digests, GOLDEN.loot, l.logs);
  assert.ok(asked > 0, "the classify hook was consulted");
  NOW = 1_800_000_000_000;
  const b = runBuffGolden((loop) => {
    loop.rebuffSecondsRemaining = 300;
    const rows = loop.itemBuffs.map((ib) => ({ spellId: ib.spellId, itemGuid: ib.itemGuid }));
    assert.equal(loop.setItemBuffs(rows), 2);
  });
  compareGolden("buff@Default", b.digests, GOLDEN.buff, b.logs);
});

// ── the combat options made live 2026-10-19, at their schema defaults ─────
// TargetLock off, AttackMinDistance 0, MonsterDisengageRange 0 (auto = the
// perimeter + 3 m — the one new default behaviour), TargetNoProgressTimeoutSec
// 0, DoJiggle off. In this world no lock ever sits between 40 and 43 m, so
// every host ACTION and the loop state match the literal run tick for tick;
// only reads differ: with the layer the scan memo is also keyed on the lock
// (the disengage range keeps it in), so a lock change inside one snapshot
// re-scans — a fresher scan (e.g. right after a blacklist), never a larger one.
const COMBAT_OPT_DEFAULTS = { TargetLock: false, AttackMinDistance: 0, MonsterDisengageRange: 0, TargetNoProgressTimeoutSec: 0, DoJiggle: false };
const HOST_ACTION = /^(MeleeAttack|MissileAttack|CastSpell|CastSpellAt|CastUntargetedSafe|StickToObject|StopStick|CancelAttack|TurnToHeading|ToggleCombatMode|QueryHealth|StopCompletely|tryClaimCast|releaseCast|SetMovementInput)\b/;

await check("GOLDEN combat with the VT combat options at their schema defaults: identical host actions + loop state every tick; the scan only ever fresher", () => {
  NOW = 1_800_000_000_000;
  const base = runCombatGolden();
  NOW = 1_800_000_000_000;
  const vt = runCombatGolden((loop) => {
    loop.optFn = (k) => COMBAT_OPT_DEFAULTS[k];
    loop.movementClaimedFn = () => false;
  });
  let fresher = 0;
  for (let i = 0; i < base.logs.length; i++) {
    const a = JSON.parse(base.logs[i]);
    const b = JSON.parse(vt.logs[i]);
    assert.deepEqual(b.c.filter((c) => HOST_ACTION.test(c)), a.c.filter((c) => HOST_ACTION.test(c)), `tick ${i}: host actions`);
    assert.deepEqual([b.st, b.ls, b.aw], [a.st, a.ls, a.aw], `tick ${i}: loop state`);
    assert.ok(b.scan.every((s) => a.scan.includes(s)), `tick ${i}: the scan grew\n  literal ${a.scan}\n  layer   ${b.scan}`);
    if (b.scan.length < a.scan.length) fresher++;
  }
  assert.ok(fresher <= 3, `fresher scans ${fresher}`);
  assert.ok(!vt.logs.some((l) => l.includes("SetMovementInput")), "no jiggle at the defaults");
  assert.equal(vt.loop.kills, base.loop.kills);
});

await check("netBrain input: MonsterDisengageRange 0.0 without the layer; with optFn the JS disengage range (auto +3 m, explicit, capped by nearbyRangeM)", () => {
  const { loop, host } = combatRig();
  assert.equal(loop._nbBuildInput(0, NOW).Config.MonsterDisengageRange, 0);
  const opts = { ...COMBAT_OPT_DEFAULTS };
  loop.optFn = (k) => opts[k];
  assert.equal(loop._nbBuildInput(0, NOW).Config.MonsterDisengageRange, 43);
  opts.MonsterDisengageRange = 55;
  assert.equal(loop._nbBuildInput(0, NOW).Config.MonsterDisengageRange, 55);
  host.nearbyRangeM = 50;
  assert.equal(loop._nbBuildInput(0, NOW).Config.MonsterDisengageRange, 50, "the entity scan's radius caps it");
  loop.acquireRangeFn = () => 60; // navigating with Approach Range 60
  opts.MonsterDisengageRange = 0;
  host.nearbyRangeM = 0;
  assert.equal(loop._nbBuildInput(0, NOW).Config.MonsterDisengageRange, 63, "auto = the acquire perimeter + 3 m");
});

// ── kernel status at the Default profile (critic B7) ──────────────────────
await check("kernel status with real loops: the aux key appears only once a slot/hook is enabled", async () => {
  const { RynthBotKernel } = await import("../rynth/kernel.js");
  const { W, host } = makeCombatWorld();
  const combat = new RynthCombatLoop(host, { log: quiet });
  const loot = new RynthLootLoop(host, { log: quiet });
  const nav = { name: "Navigate", rank: "beforeIdle", on: false, enabled() { return this.on; }, wants: () => false, tick() {} };
  const aux = { slots: [nav], idleHooks: [], policy: { boostLoot: () => false }, status: () => ({ nav: 1 }) };
  const plain = new RynthBotKernel(host, { combat, buff: null, loot, vitals: null, unwedge: null }, { log: quiet });
  const withAux = new RynthBotKernel(host, { combat, buff: null, loot, vitals: null, unwedge: null, aux }, { log: quiet });
  assert.deepEqual(Object.keys(withAux.status), Object.keys(plain.status));
  nav.on = true;
  assert.deepEqual(withAux.status.aux, { nav: 1 });
  void W;
});

Date.now = REAL_NOW;
console.log(fail === 0 ? `rynth_vt_loop_hooks: all ${pass} checks passed` : `rynth_vt_loop_hooks: ${fail} FAILED (${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);
