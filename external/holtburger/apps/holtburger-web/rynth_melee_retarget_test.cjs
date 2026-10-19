#!/usr/bin/env node
// rynth_melee_retarget_test.cjs — the owner's 2026-10-19 report: "with melee
// combat, it would wait maybe 10 seconds before attacking the next thing".
//
// Root cause (combat_loop.js, 2026-10-12 engagement protocol): the kill is
// confirmed from the death motion (hf = 0) the moment the killing blow lands,
// and the next target's attack request went out on that same tick. ACE
// broadcasts the death motion from inside the swing (Creature_Death.cs Die),
// while the killing swing is still animating (Player_Melee.cs Attack:
// `Attacking` stays true until the animation's end), and it DROPS a
// TargetedMeleeAttack / TargetedMissileAttack that lands in that window
// without any reply (Player_Melee.cs:98-100, Player_Missile.cs:105-106). The
// killed loop's ActionCancelled then arrived, was swallowed as the expected
// stale end, and the new engagement — no swing, no damage, no attackDone —
// waited out MELEE_SWING_PATIENCE_MS (9 s) before asking again.
// Retail never sends that request: EndAttackRequest queues an attack made
// while the previous one's server response is pending
// (attackServerResponsePending -> attackWhenResponseReceived) and
// HandleAttackDoneEvent sends it (acclient.c:408952 / :409200-409269); the
// page's own attack path does the same (scene3d/picking.js fireOnce,
// attackRepeat.shouldQueue). The fix holds the bot's next request until the
// killed loop's AttackDone arrives (or STALE_LOOP_END_TTL_MS passes).
//
// Part 1 drives the REAL bot (createGrindBot: webhost, kernel, combat, vitals,
// loot, unwedge; with and without the VTank layer) over a fake SessionHandle
// whose server half models ACE's melee loop (Player_Melee.cs: the attack
// queue, the silent drop, the swing / damage frame / AttackDone(None) /
// refill cadence, OnAttackDone's ActionCancelled, CancelAttack, the charge,
// the death motion zeroing the health fraction, the corpse swap) and measures,
// per kill, the simulated time to the first swing on the next monster.
// Part 2 pins the gate itself on a mock host (TTL fallback, no event plane,
// an end that beat the kill confirm, missile, the CancelAttack path).
//
// Run from apps/holtburger-web/:  node rynth_melee_retarget_test.cjs
// (rynth_test_all_node.cjs discovers it; no browser, no ACE, no build.)

"use strict";
const path = require("path");
const { pathToFileURL } = require("url");

class FakeWorker {
  constructor() {
    this.onmessage = null;
  }
  postMessage() {}
  terminate() {}
}
globalThis.Worker = FakeWorker;
if (typeof URL.createObjectURL !== "function") URL.createObjectURL = () => "blob:melee-retarget";
if (typeof URL.revokeObjectURL !== "function") URL.revokeObjectURL = () => {};

const out = console.log.bind(console);
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail || "" });
}

const ME = 0x50000001;
const SWORD = 0x50000010;
const LB = 0xa9b40015;
const TICK_MS = 100; // the host heartbeat (createGrindBot hz 10)
const LAT_MS = 50; // client -> ACE one-way latency for a request
// ACE melee timing (Player_Melee.cs Attack / DoSwingMotion), a mid-speed
// one-handed weapon: the damage frame half-way through a 1.4 s swing.
const SWING_MS = 1400;
const DAMAGE_FRAC = 0.5;
const STICKY_DIST = 4.0; // Player_Melee.cs StickyDistance
const MELEE_DIST = 0.6; // Player_Melee.cs MeleeDistance
const RADII = 1.0; // centre distance -> ACE cylinder distance
const CHARGE_MPS = 6; // MoveTo(target) charge: run rate x 1.5
const DEATH_ANIM_MS = 2000; // Die(): corpse after the death animation
const MON_HP = 100;
const HIT = 40; // three swings per monster
const MON_SWING_MS = 2500;
const MON_HIT = 6;
const CORPSE_WCID = 21;
const ODF_ATTACKABLE = 0x10;
const EQUIP_MELEE_WEAPON = 0x00100000;

const fmt = (a) => (typeof a === "number" ? (Number.isInteger(a) ? String(a) : a.toFixed(3)) : JSON.stringify(a));

/** A scripted world whose server half is ACE's player melee loop. */
function makeWorld(spawns) {
  const W = {
    clock: 0,
    seq: 0,
    q: [], // scheduled server/world actions { at, seq, fn }
    mode: 2, // Melee
    me: { x: 96, y: 96, z: 0, h: 0 },
    hp: 210, // 70 % of 300: above the in-combat HealAt (60), below the idle top-off (95)
    ents: new Map(),
    sticky: 0,
    moveTo: null,
    ground: 0,
    inv: [{ guid: SWORD, name: "Longsword", wcid: 351, equipMask: EQUIP_MELEE_WEAPON, itemType: 1, containerId: ME, stackSize: 1 }],
    corpses: 0,
    actions: [], // every host action the session received
    accepted: [], // ACE took the request: { at, target }
    dropped: [], // ACE ignored it (Attacking / live MeleeTarget): { at, target }
    swings: [], // { at, target }
    kills: [], // server-side deaths { at, target }
    emit: () => {},
  };
  W.schedule = (at, fn) => W.q.push({ at, seq: ++W.seq, fn });
  const alive = (g) => {
    const e = W.ents.get(g >>> 0);
    return !!(e && e.creature && !e.gone && !e.dead);
  };
  const cyl = (g) => {
    const e = W.ents.get(g >>> 0);
    return e ? Math.max(0, Math.hypot(e.x - W.me.x, e.y - W.me.y) - RADII) : Infinity;
  };
  const combatEvt = (o) => W.emit({ kind: 19, stringPayload: JSON.stringify(o), u32Payload: 0, u32Payload2: 0 });

  // ── ACE Player_Melee.cs ──────────────────────────────────────────────
  const A = { attacking: false, meleeTarget: 0, attackTarget: 0, seq: 0, nextRefillAt: 0, cancelled: false, queue: [], power: 0.5, charge: null };
  W.ace = A;
  const fetch = () => {
    if (A.queue.length > 1) A.queue.shift();
    return A.queue.length ? A.queue[0] : 0.5; // AttackQueue.Fetch
  };
  function onAttackDone() {
    combatEvt({ type: "attackDone", error: "ActionCancelled" }); // OnAttackDone :215-235
    A.attackTarget = 0;
    A.meleeTarget = 0;
    A.queue.length = 0;
    A.cancelled = false;
    A.charge = null;
  }
  function targetedMeleeAttack(g, height, power) {
    if (W.mode !== 2) return onAttackDone(); // :55-66
    A.queue.push(Math.min(1, Math.max(0, power))); // :93
    if (!A.meleeTarget) A.power = fetch(); // :95-96
    if (A.attacking || (A.meleeTarget && alive(A.meleeTarget))) {
      W.dropped.push({ at: W.clock, target: g }); // :98-100 — no reply at all
      return;
    }
    const e = W.ents.get(g);
    if (!e || e.gone || !e.creature) return onAttackDone(); // :105-118
    if (!alive(g)) return onAttackDone(); // :127-131
    A.meleeTarget = g;
    A.attackTarget = g;
    const seq = ++A.seq;
    W.accepted.push({ at: W.clock, target: g });
    if (A.nextRefillAt > W.clock) {
      W.schedule(A.nextRefillAt, () => (alive(g) ? inner(g, seq) : onAttackDone())); // :144-161
    } else inner(g, seq);
  }
  function inner(g, seq) {
    // :170-213 — swing in place inside the sticky distance, else charge
    if (cyl(g) <= STICKY_DIST) attack(g, seq);
    else {
      A.charge = { g, seq };
      const t = ((cyl(g) - MELEE_DIST) / CHARGE_MPS) * 1000;
      W.schedule(W.clock + t, () => {
        if (!A.charge || A.charge.seq !== seq) return; // cancelled
        A.charge = null;
        const e = W.ents.get(g);
        if (e) {
          // arrive at melee distance on the line to the target
          const d = Math.hypot(e.x - W.me.x, e.y - W.me.y);
          const k = (d - RADII - MELEE_DIST) / d;
          W.me.x += (e.x - W.me.x) * k;
          W.me.y += (e.y - W.me.y) * k;
        }
        attack(A.meleeTarget, A.seq); // Player_Move.cs OnMoveComplete(None)
      });
    }
  }
  function attack(g, seq, subsequent = false) {
    // Attack :255-393
    if (A.seq !== seq) return;
    if (W.mode !== 2 || !A.meleeTarget) return onAttackDone();
    if (!alive(g)) return onAttackDone();
    A.attacking = true; // point of no return
    if (subsequent) combatEvt({ type: "combatCommenceAttack" });
    W.swings.push({ at: W.clock, target: g });
    const t0 = W.clock;
    W.schedule(t0 + SWING_MS * DAMAGE_FRAC, () => damage(g));
    W.schedule(t0 + SWING_MS, () => {
      A.attacking = false;
      A.power = fetch();
      A.nextRefillAt = W.clock + A.power * 1000;
      if (alive(g) && cyl(g) <= STICKY_DIST && !A.cancelled) {
        combatEvt({ type: "attackDone", error: "None" });
        W.schedule(A.nextRefillAt, () => attack(g, seq, true));
      } else onAttackDone();
    });
  }
  function cancelAttack() {
    // HandleActionCancelAttack :240-250
    if (A.attacking) A.cancelled = true;
    else if (A.attackTarget) onAttackDone();
    A.charge = null; // cancel_moveto
  }
  function damage(g) {
    const e = W.ents.get(g);
    if (!e || !alive(g)) return;
    e.hp -= HIT;
    combatEvt({ type: "damageDealt", defenderName: e.name, damage: HIT, severity: HIT / MON_HP });
    if (e.hp > 0) {
      e.hf = e.hp / MON_HP;
      return;
    }
    // Creature_Death.cs Die(): the Dead motion goes out at once; the client
    // zeroes the health fraction on it (holtburger-world handlers/movement.rs).
    e.dead = true;
    e.hf = 0;
    W.kills.push({ at: W.clock, target: g });
    W.schedule(W.clock + DEATH_ANIM_MS, () => corpseSwap(g));
  }
  function corpseSwap(g) {
    const e = W.ents.get(g);
    e.gone = true;
    const n = ++W.corpses;
    const cg = 0x80001000 + n;
    const ig = 0x80002000 + n;
    W.ents.set(ig, { name: `Pyreal Mote ${n}`, wcid: 3000 + n, x: e.x, y: e.y, z: 0, itemType: 0x80, value: 120, carried: true });
    W.ents.set(cg, { name: `Corpse of ${e.name}`, wcid: CORPSE_WCID, x: e.x, y: e.y, z: 0, corpse: true, itemType: 0x200, contents: [ig] });
  }
  // Each monster swings at us while it lives and is in reach.
  function monsterSwing(g) {
    const e = W.ents.get(g);
    if (!alive(g)) return;
    if (cyl(g) <= 2) {
      W.hp = Math.max(1, W.hp - MON_HIT);
      combatEvt({ type: "damageTaken", attackerName: e.name, damage: MON_HIT, severity: MON_HIT / 300 });
    }
    W.schedule(W.clock + MON_SWING_MS, () => monsterSwing(g));
  }
  for (const [i, s] of spawns.entries()) {
    W.ents.set(s.id, { name: s.name, wcid: 1000 + i, x: s.x, y: s.y, z: 0, hp: MON_HP, hf: 1, creature: true, itemType: 16 });
    W.schedule(700 + i * 450, () => monsterSwing(s.id));
  }

  const act = (n, ...a) => W.actions.push({ at: W.clock, line: `${n}(${a.map(fmt).join(",")})` });
  const send = (fn) => W.schedule(W.clock + LAT_MS, fn);
  const live = (g) => {
    const e = W.ents.get(g >>> 0);
    return e && !e.gone ? e : null;
  };
  W.session = {
    isPlayerReady: () => true,
    playerGuid: () => ME,
    serverTime: () => W.clock / 1000,
    combatMode: () => W.mode,
    getBusyState: () => 0,
    getCastBusyState: () => 0,
    getUseDoneSeq: () => 0,
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
    playerKnownSpells: () => [6], // Heal Self I known — but no caster wielded
    playerEnchantments: () => [],
    playerStats: () => ({ vitals: [1, W.hp, 300, 300, 3, 280, 300, 300, 5, 150, 300, 300], attributes: [], skills: [], levelInfo: [50, 0, 0, 0, 0], free() {} }),
    groundContainerId: () => W.ground,
    getContainerContents: (g) => Uint32Array.from(W.ents.get(g >>> 0)?.contents ?? []),
    playerInventory: () => W.inv.map((r) => ({ ...r, free() {} })),
    localStickyTarget: () => W.sticky,
    pursuitStatus: () => 0,
    // ── actions ──
    attack: (g, ht, p) => {
      act("attack", g >>> 0, ht, p);
      send(() => targetedMeleeAttack(g >>> 0, ht, p));
    },
    cancelAttack: () => {
      act("cancelAttack");
      send(() => cancelAttack());
    },
    missileAttack: (...a) => act("missileAttack", ...a),
    setCombatMode: (m) => {
      act("setCombatMode", m);
      // the wasm refuses set(Magic) locally without a wielded caster
      if (m !== 8) W.mode = m;
    },
    toggleCombatMode: () => act("toggleCombatMode"),
    castTargetedSpell: (...a) => act("castTargetedSpell", ...a),
    castUntargetedSpell: (...a) => act("castUntargetedSpell", ...a),
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
    useObject: (g) => {
      act("useObject", g >>> 0);
      const e = live(g);
      if (e && e.corpse && Math.hypot(e.x - W.me.x, e.y - W.me.y) <= 5) {
        W.schedule(W.clock + 200, () => {
          W.ground = g >>> 0;
        });
      }
    },
    moveItem: (item, dest, slot) => {
      act("moveItem", item >>> 0, dest >>> 0, slot);
      W.schedule(W.clock + 200, () => {
        for (const [, e] of W.ents) if (e.corpse && Array.isArray(e.contents)) e.contents = e.contents.filter((x) => x !== (item >>> 0));
        const ent = W.ents.get(item >>> 0);
        if (ent) W.inv.push({ guid: item >>> 0, name: ent.name, wcid: ent.wcid, stackSize: 1, containerId: ME, equipMask: 0, itemType: ent.itemType });
        W.emit({ kind: 11, stringPayload: "", u32Payload: 0, u32Payload2: 0 });
      });
    },
    queryHealth: (g) => act("queryHealth", g >>> 0),
    requestAppraisal: (g) => act("requestAppraisal", g >>> 0),
    turnToHeading: (r) => {
      act("turnToHeading", r);
      W.me.h = r;
    },
    noLongerViewingContents: (g) => {
      act("noLongerViewingContents", g >>> 0);
      if (W.ground === g >>> 0) W.ground = 0;
    },
    sendChat: (t) => act("sendChat", t),
    sendTell: (...a) => act("sendTell", ...a),
    tickMovement: () => {},
    setMovementInput: (...a) => act("setMovementInput", ...a),
  };

  /** Run the server and the world up to `t` (ms). */
  W.stepTo = (t) => {
    for (;;) {
      let best = -1;
      for (let i = 0; i < W.q.length; i++) {
        const x = W.q[i];
        if (x.at > t) continue;
        if (best < 0 || x.at < W.q[best].at || (x.at === W.q[best].at && x.seq < W.q[best].seq)) best = i;
      }
      if (best < 0) break;
      const ev = W.q.splice(best, 1)[0];
      W.clock = Math.max(W.clock, ev.at);
      ev.fn();
    }
    W.clock = t;
    // a corpse walk (MoveToPosition) or the run-up stick: 0.5 m per heartbeat
    const goal = W.moveTo || (W.sticky && live(W.sticky) ? live(W.sticky) : null);
    if (goal) {
      const dx = goal.x - W.me.x;
      const dy = goal.y - W.me.y;
      const d = Math.hypot(dx, dy);
      const stopAt = W.moveTo ? 0.5 : 1.5;
      if (d > stopAt) {
        const k = Math.min(0.5, d - stopAt) / d;
        W.me.x += dx * k;
        W.me.y += dy * k;
      } else if (W.moveTo) W.moveTo = null;
    }
  };
  return W;
}

/** Run one scripted fight with the real bot; per kill, how long until the next monster is swung at. */
async function runFight(createGrindBot, spawns, config, ticks) {
  const realNow = Date.now;
  const realLog = console.log;
  const realWarn = console.warn;
  let NOW = 1_760_000_000_000;
  const T0 = NOW;
  Date.now = () => NOW;
  const logs = [];
  console.log = (...a) => logs.push(a.join(" "));
  console.warn = () => {};
  const W = makeWorld(spawns);
  let bot = null;
  const trace = [];
  const confirms = [];
  const inCombatAt = [];
  try {
    bot = await createGrindBot(W.session, { hz: 10, ai: false, loot: { minValue: 0 }, ...config });
    W.emit = (e) => bot.host._dispatchEvent(e);
    const step = bot.vitals.step.bind(bot.vitals);
    bot.vitals.step = (ic) => {
      inCombatAt.push({ at: W.clock, ic });
      return step(ic);
    };
    let kills = 0;
    for (let i = 0; i < ticks; i++) {
      NOW += TICK_MS;
      W.stepTo(NOW - T0);
      bot.host._tick();
      trace.push({ at: NOW - T0, action: bot.kernel.action, state: bot.combat.state });
      if (bot.combat.kills > kills) {
        kills = bot.combat.kills;
        confirms.push(NOW - T0);
      }
    }
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
  // Per kill: the next swing on another monster, and the attack requests in between.
  const gaps = W.kills.map((k, n) => {
    const confirmAt = confirms[n] ?? null;
    const nextSwing = W.swings.find((s) => s.at > k.at && s.target !== k.target) || null;
    const lastKill = n === W.kills.length - 1;
    const sent = W.actions.filter((a) => a.at > k.at && (!nextSwing || a.at <= nextSwing.at) && /^attack\(/.test(a.line)).length;
    return {
      target: k.target,
      killAt: k.at,
      confirmAt,
      nextSwingAt: nextSwing ? nextSwing.at : null,
      gapMs: nextSwing ? nextSwing.at - k.at : null,
      lastKill,
      requests: sent,
    };
  });
  return { W, gaps, trace, confirms, inCombatAt, logs, vt: !!bot?.vt };
}

async function main() {
  const rel = (p) => pathToFileURL(path.join(__dirname, p)).href;
  const { createGrindBot } = await import(rel("rynth/bot.js"));
  const { RynthCombatLoop } = await import(rel("rynth/combat_loop.js"));

  // ── Part 1: the real bot against ACE's melee loop ──────────────────────
  const cluster = [
    { id: 0x80000101, name: "Drudge Skulker", x: 96, y: 97.6 }, // 1.6 m
    { id: 0x80000102, name: "Drudge Sneaker", x: 97.6, y: 95.0 }, // ~1.9 m
    { id: 0x80000103, name: "Drudge Prowler", x: 94.0, y: 95.0 }, // ~2.2 m
  ];
  for (const [label, config] of [["layer absent", { vt: false }], ["default VTank layer", {}]]) {
    const r = await runFight(createGrindBot, cluster, config, 450);
    const shown = r.gaps.map((g) => (g.gapMs == null ? "-" : `${(g.gapMs / 1000).toFixed(1)}s`)).join(", ");
    out(`  [${label}] kills at ${r.W.kills.map((k) => (k.at / 1000).toFixed(1)).join(", ")} s; kill -> next swing: ${shown}; ACE dropped ${r.W.dropped.length} request(s)`);
    check(`${label}: the bot kills all three melee monsters`, r.W.kills.length === 3, `kills=${r.W.kills.length}`);
    check(`${label}: ...with the VTank layer ${config.vt === false ? "absent" : "attached"}`, r.vt === (config.vt !== false), `vt=${r.vt}`);
    for (const g of r.gaps.filter((x) => !x.lastKill)) {
      check(
        `${label}: kill of ${g.target.toString(16)} -> first swing on the next monster within 2.5 s (was ~9 s: the patience fallback)`,
        g.gapMs != null && g.gapMs <= 2500,
        `gap=${g.gapMs} ms (kill ${g.killAt}, confirm ${g.confirmAt}, next swing ${g.nextSwingAt}, ${g.requests} request(s))`
      );
      check(
        `${label}: ...with ONE attack request for that engagement (none sent into the killing swing)`,
        g.requests === 1,
        `requests=${g.requests}`
      );
    }
    check(
      `${label}: ACE never had to drop a request (none landed while a swing was animating)`,
      r.W.dropped.length === 0,
      JSON.stringify(r.W.dropped)
    );
    const firstKill = r.W.kills[0]?.at ?? 0;
    const lastKill = r.W.kills[r.W.kills.length - 1]?.at ?? 0;
    const between = r.trace.filter((t) => t.at > firstKill && t.at <= lastKill);
    check(
      `${label}: the kernel keeps Combat between kills (no Vitals / Loot / Idle detour while monsters remain)`,
      between.length > 0 && between.every((t) => t.action === "Combat"),
      [...new Set(between.map((t) => t.action))].join(",")
    );
    const midFight = r.inCombatAt.filter((x) => x.at > firstKill && x.at <= lastKill);
    check(
      `${label}: vitals sees in-combat thresholds right after a kill while monsters are in range (no top-off)`,
      midFight.length > 0 && midFight.every((x) => x.ic === true),
      `${midFight.filter((x) => !x.ic).length} idle reads`
    );
    check(
      `${label}: after the last kill the corpses are looted (the kernel moves on)`,
      r.W.actions.some((a) => /^useObject\(/.test(a.line)) && r.W.inv.length > 1,
      `inv=${r.W.inv.length}`
    );
  }

  // A next monster outside ACE's sticky distance: the request waits for the
  // killed loop's end, then ACE charges it.
  {
    const r = await runFight(
      createGrindBot,
      [
        { id: 0x80000111, name: "Mosswart", x: 96, y: 97.6 }, // 1.6 m
        { id: 0x80000112, name: "Mosswart Worshipper", x: 96, y: 103.5 }, // 7.5 m: charge
      ],
      { vt: false },
      300
    );
    const g = r.gaps[0];
    out(`  [charge] kill -> first swing on the 7.5 m monster: ${g && g.gapMs != null ? (g.gapMs / 1000).toFixed(1) + "s" : "-"}; ACE dropped ${r.W.dropped.length}`);
    check("charge: both monsters killed", r.W.kills.length === 2, `kills=${r.W.kills.length}`);
    check(
      "charge: kill -> first swing on the next (charged) monster within 3.5 s",
      g && g.gapMs != null && g.gapMs <= 3500,
      g ? `gap=${g.gapMs} requests=${g.requests}` : "no kill"
    );
    check("charge: ACE never dropped a request", r.W.dropped.length === 0, JSON.stringify(r.W.dropped));
  }

  // ── Part 2: the gate itself (mock host, frozen clock) ──────────────────
  const realNow = Date.now;
  let NOW = 5_000_000;
  Date.now = () => NOW;
  const quiet = () => {};
  const combatEvt = (type, extra = {}) => ({ kind: 19, text: JSON.stringify({ type, ...extra }), u32: 0, u32b: 0 });
  function mockHost({ ents, mode = 2, events = true }) {
    const byId = new Map(ents.map((e) => [e.id, e]));
    const calls = { melee: [], missile: [], cancel: 0 };
    const subs = [];
    const host = {
      calls,
      mode,
      IsPlayerReady: () => true,
      TryGetPlayerPose: () => ({ objCellId: LB, x: 96, y: 96, z: 0, heading: null }),
      NearbyGuids: () => ents.filter((e) => !e.gone).map((e) => e.id),
      ObjectIsPlayer: () => false,
      TryGetObjectIntProperty: (g, k) => (k === 1 ? 16 : undefined),
      ObjectIsAttackable: () => true,
      TryGetTargetHealthFraction: (g) => {
        const e = byId.get(g);
        return !e || e.gone ? -1 : e.hf ?? 1;
      },
      TryGetObjectPosition: (g) => {
        const e = byId.get(g);
        return !e || e.gone ? null : { objCellId: LB, x: e.x, y: e.y, z: 0 };
      },
      TryGetObjectName: (g) => byId.get(g)?.name ?? null,
      GetCurrentCombatMode: () => host.mode,
      StickToObject: () => true,
      StopStick: () => true,
      QueryHealth: () => true,
      MeleeAttack: (g) => {
        calls.melee.push({ g, at: NOW });
        return true;
      },
      MissileAttack: (g) => {
        calls.missile.push({ g, at: NOW });
        return true;
      },
      CancelAttack: () => {
        calls.cancel++;
        return true;
      },
      ToggleCombatMode: () => true,
      GetCastBusyState: () => 0,
      GetUseDoneSeq: () => 0,
      has: () => false,
      emit: (e) => subs.forEach((fn) => fn(e)),
    };
    if (events) host.onEvent = (fn) => subs.push(fn);
    return host;
  }
  try {
    // (a) the killed loop's ActionCancelled releases the next request
    {
      const a = { id: 0x80000201, name: "Rat", x: 96, y: 97.5 };
      const b = { id: 0x80000202, name: "Rat", x: 96, y: 98.5 };
      const host = mockHost({ ents: [a, b] });
      const loop = new RynthCombatLoop(host, { log: quiet });
      loop.tick();
      NOW += 700;
      host.emit(combatEvt("damageDealt", { defenderName: "Rat", damage: 40, severity: 0.4 }));
      a.hf = 0; // the killing blow's death motion
      NOW += 100;
      loop.tick();
      const atConfirm = host.calls.melee.length;
      for (let i = 0; i < 5; i++) {
        NOW += 100;
        loop.tick();
      }
      const held = host.calls.melee.length;
      const heldState = loop.state;
      const endAt = NOW;
      host.emit(combatEvt("attackDone", { error: "ActionCancelled" })); // the killing swing ends
      NOW += 100;
      loop.tick();
      check(
        "gate: kill confirmed while the killed loop's end is owed -> no request into the killing swing (state ENGAGE)",
        atConfirm === 1 && held === 1 && loop.locked === b.id && heldState === "ENGAGE",
        `atConfirm=${atConfirm} held=${held} locked=${loop.locked.toString(16)} state=${heldState}`
      );
      check(
        "gate: the killed loop's ActionCancelled -> the next monster's request goes out on the next tick",
        host.calls.melee.length === 2 && host.calls.melee[1].g === b.id && host.calls.melee[1].at === endAt + 100 && loop.state === "ATTACK",
        `melee=${JSON.stringify(host.calls.melee.map((m) => [m.g.toString(16), m.at - endAt]))} state=${loop.state}`
      );
      // ACE's swings on b keep the engagement alive: no second request.
      for (let i = 0; i < 30; i++) {
        NOW += 500;
        host.emit(combatEvt(i % 2 ? "attackDone" : "damageDealt", { error: "None", damage: 10, severity: 0.1 }));
        loop.tick();
      }
      check("gate: one request per engagement afterwards (no re-request while ACE swings)", host.calls.melee.length === 2, `melee=${host.calls.melee.length}`);
    }
    // (b) a lost end: the TTL lets the request go after 3 s, not 9 s
    {
      const a = { id: 0x80000203, name: "Rat", x: 96, y: 97.5 };
      const b = { id: 0x80000204, name: "Rat", x: 96, y: 98.5 };
      const host = mockHost({ ents: [a, b] });
      const logs = [];
      const loop = new RynthCombatLoop(host, { log: (m) => logs.push(m) });
      loop.tick();
      NOW += 800;
      a.hf = 0;
      loop.tick();
      const confirmAt = NOW;
      let sentAt = null;
      for (let i = 0; i < 100 && sentAt == null; i++) {
        NOW += 100;
        loop.tick();
        if (host.calls.melee.length === 2) sentAt = NOW;
      }
      const wait = sentAt == null ? null : sentAt - confirmAt;
      check("gate: the owed end never arrives -> request after the 3 s stale-end TTL (lost-event backstop)", wait != null && wait > 2900 && wait <= 3200, `wait=${wait} ms`);
      check("gate: ...and says so once (a lost event is worth a log line)", logs.filter((m) => /never came/.test(m)).length === 1, `lines=${logs.filter((m) => /never came/.test(m)).length}`);
    }
    // (g) a hold that never held anything (the last monster died; the next one
    //     shows up after the TTL): no wait, no log line
    {
      const a = { id: 0x8000020d, name: "Rat", x: 96, y: 97.5 };
      const b = { id: 0x8000020e, name: "Rat", x: 96, y: 98.5, gone: true };
      const host = mockHost({ ents: [a, b] });
      const logs = [];
      const loop = new RynthCombatLoop(host, { log: (m) => logs.push(m) });
      loop.tick();
      NOW += 800;
      a.hf = 0;
      loop.tick(); // kill confirmed, nothing else to fight
      NOW += 5000;
      loop.tick();
      b.gone = false; // a new monster walks up long after the killed loop's end was due
      NOW += 100;
      loop.tick();
      check(
        "gate: a lapsed hold that delayed nothing -> the next monster is attacked at once, no 'never came' line",
        host.calls.melee.length === 2 && host.calls.melee[1].g === b.id && !logs.some((m) => /never came/.test(m)),
        `melee=${host.calls.melee.length} logs=${JSON.stringify(logs.filter((m) => /never came/.test(m)))}`
      );
    }
    // (c) no event plane: unchanged — the request goes out on the kill tick
    {
      const a = { id: 0x80000205, name: "Rat", x: 96, y: 97.5 };
      const b = { id: 0x80000206, name: "Rat", x: 96, y: 98.5 };
      const host = mockHost({ ents: [a, b], events: false });
      const loop = new RynthCombatLoop(host, { log: quiet });
      loop.tick();
      NOW += 800;
      a.hf = 0;
      loop.tick();
      check("no event plane (degrade-open): the next request goes out on the kill tick, as before", host.calls.melee.length === 2 && host.calls.melee[1].g === b.id, `melee=${host.calls.melee.length}`);
    }
    // (d) the end beat the kill confirm (a short swing tail): nothing owed, no wait
    {
      const a = { id: 0x80000207, name: "Rat", x: 96, y: 97.5 };
      const b = { id: 0x80000208, name: "Rat", x: 96, y: 98.5 };
      const host = mockHost({ ents: [a, b] });
      const loop = new RynthCombatLoop(host, { log: quiet });
      loop.tick();
      NOW += 1400;
      host.emit(combatEvt("attackDone", { error: "ActionCancelled" }));
      a.hf = 0;
      NOW += 100;
      loop.tick();
      check("gate: the loop's end arrived before the kill confirm -> no wait (the request goes on the kill tick)", host.calls.melee.length === 2 && host.calls.melee[1].g === b.id, `melee=${host.calls.melee.length}`);
    }
    // (e) missile: the same pending-response rule after a kill
    {
      const a = { id: 0x80000209, name: "Banderling", x: 96, y: 106 };
      const b = { id: 0x8000020a, name: "Banderling", x: 96, y: 108 };
      const host = mockHost({ ents: [a, b], mode: 4 });
      const loop = new RynthCombatLoop(host, { log: quiet });
      loop.tick();
      NOW += 900;
      a.hf = 0;
      loop.tick();
      NOW += 100;
      loop.tick();
      const held = host.calls.missile.length;
      host.emit(combatEvt("attackDone", { error: "ActionCancelled" }));
      NOW += 100;
      loop.tick();
      check("missile: no shot request into the killing shot's reload; sent on its ActionCancelled", held === 1 && host.calls.missile.length === 2 && host.calls.missile[1].g === b.id, `held=${held} shots=${host.calls.missile.length}`);
    }
    // (f) a CancelAttack re-target waits for the cancelled loop's end too (rynth_combat_engage_test case 5)
    {
      const a = { id: 0x8000020b, name: "Rat", x: 96, y: 104 };
      const b = { id: 0x8000020c, name: "Rat", x: 96, y: 107 };
      const host = mockHost({ ents: [a, b] });
      const loop = new RynthCombatLoop(host, { log: quiet });
      loop.tick();
      a.gone = true; // vanished alive: T10 re-lock + CancelAttack
      NOW += 100;
      loop.tick();
      const held = host.calls.melee.length;
      host.emit(combatEvt("attackDone", { error: "ActionCancelled" }));
      NOW += 100;
      loop.tick();
      check("CancelAttack re-target: the new request waits for the cancelled loop's ActionCancelled, then goes out", host.calls.cancel === 1 && held === 1 && host.calls.melee.length === 2 && host.calls.melee[1].g === b.id, `cancel=${host.calls.cancel} held=${held} melee=${host.calls.melee.length}`);
    }
  } finally {
    Date.now = realNow;
  }
}

main()
  .catch((e) => {
    results.push({ name: "harness ran", ok: false, detail: (e && e.stack) || String(e) });
  })
  .finally(() => {
    let pass = 0;
    for (const r of results) {
      if (r.ok) pass++;
      out(`  ${r.ok ? "ok  " : "FAIL"} ${r.name}${r.ok || !r.detail ? "" : `\n       ${r.detail}`}`);
    }
    const fail = results.length - pass;
    out(fail === 0 ? `rynth_melee_retarget: all ${pass} checks passed` : `rynth_melee_retarget: ${fail} FAILED (${pass} passed)`);
    process.exit(fail === 0 ? 0 : 1);
  });
