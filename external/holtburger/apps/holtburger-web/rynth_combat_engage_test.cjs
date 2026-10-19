#!/usr/bin/env node
// rynth_combat_engage_test.cjs — the 2026-10-12 engagement protocol of
// rynth/combat_loop.js + the kernel body handoff in rynth/kernel.js, against
// the reworked client melee (86c4d11e Phase F: a melee click only sends the
// attack, ACE charges + auto-repeats) and ACE's loop semantics:
//   - Player_Melee.cs:99   a request while MeleeTarget is alive is ignored
//   - Player_Melee.cs Attack / OnAttackDone   attackDone(None) between swings,
//                          attackDone(ActionCancelled) when the chain ends
//   - MoveToManager.cs:488 a charge fails after 15 m (YouChargedTooFar)
//   - Player_Missile.cs / Player_Magic.cs VerifySpellRange   out of range is
//                          refused (MissileOutOfRange 0x550), never approached
//   - src/session/messages/position.rs:1100-1122  every self UpdateMotion
//                          re-runs the stick preamble (drops the bot's stick)
// Mock host, frozen clock, no infra.  Run: node rynth_combat_engage_test.cjs

"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");

const LB = 0xa9b40015 >>> 0;

async function importCopy(rel) {
  // ESM .js without "type":"module" — load the repo bytes from a temp .mjs
  // (same trick as rynth_combatparity_test.cjs).
  const src = fs.readFileSync(path.join(__dirname, rel), "utf8");
  const tmp = path.join(os.tmpdir(), `${path.basename(rel, ".js")}_engage_${process.pid}.mjs`);
  fs.writeFileSync(tmp, src);
  try {
    return await import("file://" + tmp);
  } finally {
    fs.unlinkSync(tmp);
  }
}

function makeHost({ ents, mode = 2, me = { x: 96, y: 96 }, readableStick = true, known = [] } = {}) {
  const byId = new Map(ents.map((e) => [e.id, e]));
  const calls = {
    stick: [], stopStick: 0, melee: [], missile: [], cancel: 0, cast: [],
    query: [], toggle: 0, stopCompletely: 0, nearby: 0, turn: 0,
  };
  const subs = [];
  const host = {
    calls, byId, subs, mode, sticky: 0, known, onEventCalls: 0,
    snap: null, // set per test when the memo is under test
    IsPlayerReady: () => true,
    TryGetPlayerPose: () => ({ objCellId: LB, x: me.x, y: me.y, z: 0, heading: me.heading ?? null }),
    NearbyGuids: () => {
      calls.nearby++;
      return ents.filter((e) => !e.gone).map((e) => e.id);
    },
    ObjectIsPlayer: () => false,
    TryGetObjectIntProperty: (g, stype) => (stype === 1 ? byId.get(g)?.itemType ?? 16 : undefined),
    ObjectIsAttackable: () => true,
    TryGetTargetHealthFraction: (g) => {
      const e = byId.get(g);
      if (!e || e.gone) return -1;
      return e.hf ?? 1;
    },
    TryGetObjectPosition: (g) => {
      const e = byId.get(g);
      if (!e || e.gone) return null;
      return { objCellId: LB, x: e.x, y: e.y, z: 0 };
    },
    TryGetObjectName: (g) => byId.get(g)?.name ?? null,
    GetCurrentCombatMode: () => host.mode,
    StickToObject: (g) => { calls.stick.push(g); host.sticky = g; return true; },
    StopStick: () => { calls.stopStick++; host.sticky = 0; return true; },
    QueryHealth: (g) => { calls.query.push(g); return true; },
    MeleeAttack: (g, ht, p) => { calls.melee.push({ g, ht, p }); return true; },
    MissileAttack: (g, ht, a) => { calls.missile.push({ g, ht, a }); return true; },
    CancelAttack: () => { calls.cancel++; return true; },
    ToggleCombatMode: () => { calls.toggle++; return true; },
    StopCompletely: () => { calls.stopCompletely++; return true; },
    TurnToHeading: () => { calls.turn++; return true; },
    CastSpell: (t, s) => { calls.cast.push({ t, s }); return true; },
    GetCastBusyState: () => 0,
    GetUseDoneSeq: () => 0,
    TryGetKnownSpells: () => host.known,
    has: (cap) => cap === "TurnToHeading",
    onEvent: (fn) => { host.onEventCalls++; subs.push(fn); },
    onTick: () => {}, // kernel.start() registers its closure once

    emit: (e) => subs.forEach((fn) => fn(e)),
    s: {},
  };
  if (readableStick) host.TryGetLocalStickyTarget = () => host.sticky;
  return host;
}

const combatEvt = (type, extra = {}) => ({ kind: 19, text: JSON.stringify({ type, ...extra }), u32: 0, u32b: 0 });
const deathEvt = (victim, killer = 0x50000001) => ({ kind: 29, text: "X has been slain", u32: victim, u32b: killer });

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail || "" });
}

async function main() {
  const { RynthCombatLoop, globalDist } = await importCopy("rynth/combat_loop.js");
  const { RynthBotKernel } = await importCopy("rynth/kernel.js");
  const realNow = Date.now;
  let NOW = 5_000_000;
  Date.now = () => NOW;
  const quiet = () => {};
  const mk = (host, opts = {}) => new RynthCombatLoop(host, { log: quiet, ...opts });

  try {
    // ── 1. melee in range: ONE request per engagement ──────────────────
    {
      const host = makeHost({ ents: [{ id: 0x80000101, name: "Drudge", x: 96, y: 104 }] }); // 8 m
      const loop = mk(host);
      loop.tick();
      check("melee in charge range: one attack request on lock", host.calls.melee.length === 1 && host.calls.stick.length === 0,
        `melee=${host.calls.melee.length} stick=${host.calls.stick.length}`);
      check("melee request uses the configured height/power (default Medium/0.6)",
        host.calls.melee[0]?.ht === 2 && host.calls.melee[0]?.p === 0.6, JSON.stringify(host.calls.melee[0]));
      // ACE's loop is alive (swings + damage): no re-request for 20 s.
      for (let i = 1; i <= 20; i++) {
        NOW += 1000;
        host.emit(combatEvt(i % 2 ? "damageDealt" : "attackDone", { damage: 5, severity: 0.05, error: "None" }));
        loop.tick();
      }
      check("no re-request while ACE's repeat loop shows activity (was: every 9 s)", host.calls.melee.length === 1,
        `melee=${host.calls.melee.length}`);
      // Loop ends (target ran out of sticky range): re-request once ≥1 s later.
      host.emit(combatEvt("attackDone", { error: "ActionCancelled" }));
      NOW += 200;
      loop.tick();
      check("loop end -> re-request (after the 1 s floor)", host.calls.melee.length === 2, `melee=${host.calls.melee.length}`);
    }

    // ── 2. silent loop: patience fallback still re-requests ────────────
    {
      const host = makeHost({ ents: [{ id: 0x80000102, name: "Drudge", x: 96, y: 100 }] });
      const loop = mk(host);
      loop.tick();
      NOW += 8000; loop.tick();
      const before = host.calls.melee.length;
      NOW += 1500; loop.tick();
      check("no events at all: patience fallback re-requests after 9 s (degrade-open)",
        before === 1 && host.calls.melee.length === 2, `before=${before} after=${host.calls.melee.length}`);
    }

    // ── 3. out of charge range: approach on the stick, request nothing ─
    {
      const ent = { id: 0x80000103, name: "Drudge", x: 96, y: 126 }; // 30 m
      const host = makeHost({ ents: [ent] });
      const loop = mk(host);
      loop.tick();
      check("30 m melee target: APPROACH via stick, no attack (a 15 m charge would fail)",
        loop.state === "APPROACH" && host.calls.stick.includes(ent.id) && host.calls.melee.length === 0,
        `state=${loop.state} stick=${host.calls.stick.length} melee=${host.calls.melee.length}`);
      // A server motion (stance/cast) dropped the stick: re-assert, rate-limited.
      host.sticky = 0;
      NOW += 100; loop.tick();
      const early = host.calls.stick.length;
      NOW += 500; loop.tick();
      check("stick dropped by a server motion: re-asserted (rate-limited 500 ms)",
        early === 1 && host.calls.stick.length === 2, `early=${early} after=${host.calls.stick.length}`);
      // Still stuck: no spam.
      NOW += 2000; loop.tick();
      check("stick still held: no re-assert spam", host.calls.stick.length === 2, `stick=${host.calls.stick.length}`);
      // Closed to 10 m: release our stick, then the attack (ACE's charge
      // owns the body from here — no parallel StickyManager run-up).
      ent.y = 106;
      NOW += 100; loop.tick();
      check("inside 12 m: our stick released, then the attack goes out",
        host.calls.melee.length === 1 && loop.state === "ATTACK" && host.calls.stopStick === 1 && host.sticky === 0,
        `melee=${host.calls.melee.length} state=${loop.state} stopStick=${host.calls.stopStick}`);
      // While the request is live the stick is never re-asserted, even when
      // the target drifts back past 12 m (ACE's charge is following it).
      ent.y = 116;
      NOW += 2000; host.emit(combatEvt("combatCommenceAttack")); loop.tick();
      check("live request: no re-stick while ACE's charge/loop runs", host.calls.stick.length === 2 && host.calls.melee.length === 1,
        `stick=${host.calls.stick.length} melee=${host.calls.melee.length}`);
    }

    // ── 4. blind stick (no wasm read-back): slower periodic re-assert ───
    {
      const ent = { id: 0x80000104, name: "Drudge", x: 96, y: 126 };
      const host = makeHost({ ents: [ent], readableStick: false });
      const loop = mk(host);
      loop.tick();
      NOW += 1000; loop.tick();
      const mid = host.calls.stick.length;
      NOW += 600; loop.tick();
      check("unreadable stick: re-asserted every 1.5 s, not every tick", mid === 1 && host.calls.stick.length === 2,
        `mid=${mid} after=${host.calls.stick.length}`);
    }

    // ── 5. re-target with a live loop: CancelAttack; a kill: none ──────
    {
      const a = { id: 0x80000105, name: "Rat", x: 96, y: 104 };
      const b = { id: 0x80000106, name: "Rat", x: 96, y: 107 };
      const host = makeHost({ ents: [a, b] });
      const loop = mk(host);
      loop.tick();
      check("engaged the nearer rat", loop.locked === a.id && host.calls.melee.length === 1, `locked=${loop.locked.toString(16)}`);
      a.gone = true; // vanishes alive (no hp=0, no death) — T10 re-lock to b
      NOW += 100; loop.tick();
      check("lock moved off a live engaged target -> CancelAttack (ACE would keep swinging)",
        loop.locked === b.id && host.calls.cancel === 1, `locked=${loop.locked.toString(16)} cancel=${host.calls.cancel}`);
      // The cancel's ActionCancelled for the OLD loop is swallowed, not read
      // as the end of b's engagement.
      NOW += 300; loop.tick();
      const reqB = host.calls.melee.length;
      host.emit(combatEvt("attackDone", { error: "ActionCancelled" }));
      NOW += 1500; loop.tick();
      // b's request waits for the cancelled loop's ActionCancelled (ACE drops a
      // request while that loop is still `Attacking`), then goes out once.
      check("the cancelled loop's stale ActionCancelled releases b's held request and does not end the new engagement",
        reqB === 1 && host.calls.melee.length === 2, `reqB=${reqB} now=${host.calls.melee.length}`);
      // Kill b (hp=0): no cancel; the kill's own late ActionCancelled is swallowed.
      b.hf = 0;
      NOW += 100; loop.tick();
      check("kill: confirmed, no CancelAttack, stick released", loop.kills === 1 && host.calls.cancel === 1 && host.calls.stopStick >= 1,
        `kills=${loop.kills} cancel=${host.calls.cancel} stopStick=${host.calls.stopStick}`);
    }

    // ── 6. kind=29 death confirms a kill whose creature already left ───
    {
      const a = { id: 0x80000107, name: "Mosswart", x: 96, y: 103 };
      const host = makeHost({ ents: [a] });
      const loop = mk(host);
      loop.tick();
      host.emit(deathEvt(a.id));
      a.gone = true; // corpse swap pulled the creature before any hp=0 read
      NOW += 100; loop.tick();
      check("kind=29 PlayerKilled for the lock = kill (no phantom grace drop)",
        loop.kills === 1 && loop.locked === 0 && loop.recentlyKilled.has(a.id) && host.calls.cancel === 0,
        `kills=${loop.kills} locked=${loop.locked} cancel=${host.calls.cancel}`);
    }

    // ── 7. missile: stand and shoot; range refusal closes in ───────────
    {
      const ent = { id: 0x80000108, name: "Banderling", x: 96, y: 126 }; // 30 m
      const host = makeHost({ ents: [ent], mode: 4 });
      const loop = mk(host, { missileAccuracy: 0.9 });
      loop.tick();
      check("missile 30 m: approach, no shot", loop.state === "APPROACH" && host.calls.missile.length === 0,
        `state=${loop.state} shots=${host.calls.missile.length}`);
      ent.y = 112; // 16 m
      NOW += 100; loop.tick();
      check("missile 16 m: stick released, one shot at the configured accuracy",
        host.calls.stopStick === 1 && host.calls.missile.length === 1 && host.calls.missile[0].a === 0.9 && host.calls.melee.length === 0,
        `stopStick=${host.calls.stopStick} shots=${JSON.stringify(host.calls.missile)}`);
      // ACE: "out of range" (WeenieError 0x550 as a kind=2 line) + loop end.
      host.emit({ kind: 2, text: "Target is out of range!", u32: 0x550, u32b: 0x1a });
      host.emit(combatEvt("attackDone", { error: "ActionCancelled" }));
      NOW += 1500; loop.tick();
      check("range refusal: close in (approach to 4 m) instead of re-shooting from 16 m",
        loop.state === "APPROACH" && host.calls.missile.length === 1 && host.calls.stick.length === 2,
        `state=${loop.state} shots=${host.calls.missile.length} stick=${host.calls.stick.length}`);
    }

    // ── 8. magic without a war spell: stand down, no spam ──────────────
    {
      const logs = [];
      const host = makeHost({ ents: [{ id: 0x80000109, name: "Skeleton", x: 96, y: 104 }], mode: 8, known: [] });
      const loop = new RynthCombatLoop(host, { log: (m) => logs.push(m) });
      for (let i = 0; i < 30; i++) { NOW += 100; loop.tick(); }
      check("Magic mode, no war spell: stood down (canEngage false), lock released",
        loop.canEngage() === false && loop.locked === 0 && /no war spell/.test(loop.status.incapable || ""),
        `canEngage=${loop.canEngage()} locked=${loop.locked} incapable=${loop.status.incapable}`);
      check("…and logged once, not every tick (was: 10 Hz spam, Combat held forever)",
        logs.filter((m) => /no war spell/.test(m)).length === 1, `logs=${logs.filter((m) => /no war spell/.test(m)).length}`);
      NOW += 61_000;
      check("stand-down lapses after its window", loop.canEngage() === true);
    }

    // ── 9. magic with a bolt: range first, then face + cast ────────────
    {
      const ent = { id: 0x8000010a, name: "Skeleton", x: 96, y: 120 }; // 24 m
      const host = makeHost({ ents: [ent], mode: 8, known: [27] });
      host.TryGetPlayerPose = () => ({ objCellId: LB, x: 96, y: 96, z: 0, heading: 0 }); // facing +Y
      const loop = mk(host);
      loop.tick();
      check("magic 24 m: approach (fresh-caster bolt range ~15 m)", loop.state === "APPROACH" && host.calls.cast.length === 0,
        `state=${loop.state} casts=${host.calls.cast.length}`);
      ent.y = 108; // 12 m dead ahead
      NOW += 100; loop.tick(); // face window opens
      NOW += 200; loop.tick(); // settled -> cast
      check("magic 12 m: stick released, Flame Bolt I cast", host.calls.stopStick >= 1 && host.calls.cast.length === 1 && host.calls.cast[0].s === 27,
        `stopStick=${host.calls.stopStick} casts=${JSON.stringify(host.calls.cast)}`);
    }

    // ── 10. combat mode that won't establish: stand down, not target park
    {
      const host = makeHost({ ents: [{ id: 0x8000010b, name: "Rat", x: 96, y: 100 }], mode: 1 });
      const loop = mk(host);
      for (let i = 0; i < 25; i++) { NOW += 1000; loop.tick(); }
      check("5 toggles without leaving NonCombat, 6th attempt stands down (canEngage false)",
        host.calls.toggle === 5 && loop.canEngage() === false && loop.locked === 0,
        `toggles=${host.calls.toggle} canEngage=${loop.canEngage()} locked=${loop.locked}`);
      // 10b. The VT ammo slot (rynth/vt/support/ammo.js) clears exactly that
      // stand-down once ammo is wielded — the missile stance then establishes
      // on the next toggle instead of after the 60 s window.
      const other = loop.clearIncapable("no war spell known — cannot fight in Magic mode");
      check("clearIncapable: another reason is a no-op (still stood down)", other === false && loop.canEngage() === false,
        `other=${other} canEngage=${loop.canEngage()}`);
      const cleared = loop.clearIncapable("combat mode will not establish");
      check("clearIncapable(\"combat mode will not establish\") ends the stand-down",
        cleared === true && loop.canEngage() === true && loop.status.incapable === null, `incapable=${loop.status.incapable}`);
      host.ToggleCombatMode = () => { host.calls.toggle++; host.mode = 4; return true; }; // ammo in: Missile holds
      NOW += 100; loop.tick();
      check("…the next tick re-locks and toggles the stance again", host.calls.toggle === 6 && loop.locked === 0x8000010b,
        `toggles=${host.calls.toggle} locked=${loop.locked.toString(16)}`);
      NOW += 100; loop.tick();
      check("…the stance establishes and the shot goes out", host.calls.missile.length === 1 && loop.canEngage() === true,
        `missile=${host.calls.missile.length} state=${loop.state}`);
      check("clearIncapable with no stand-down in force is a no-op", loop.clearIncapable("combat mode will not establish") === false);
    }

    // ── 11. event tap: wired lazily, exactly once, on the kernel path ──
    {
      const host = makeHost({ ents: [] });
      const loop = mk(host);
      loop.tick(); loop.tick(); loop.tick();
      check("tick() subscribes host.onEvent once (kernel never calls startOn)", host.onEventCalls === 1,
        `onEvent calls=${host.onEventCalls}`);
    }

    // ── 12. scan memo: one NearbyGuids walk per host snapshot ──────────
    {
      const host = makeHost({ ents: [{ id: 0x8000010c, name: "Rat", x: 96, y: 100 }] });
      host.snap = { seq: 7 };
      const loop = mk(host);
      const a = loop._scanTargets(); const b = loop._scanTargets(); loop._scanTargets();
      const one = host.calls.nearby;
      host.snap = { seq: 8 };
      loop._scanTargets();
      check("same snapshot seq: one scan shared (frozen); new seq rescans", one === 1 && a === b && Object.isFrozen(a) && host.calls.nearby === 2,
        `walks=${one}/${host.calls.nearby}`);
      loop._markKilledAt(0x8000010c, NOW);
      const c = loop._scanTargets();
      check("a recentlyKilled write invalidates the memo", host.calls.nearby === 3 && c.length === 0, `walks=${host.calls.nearby} len=${c.length}`);
    }

    // ── 13. P12 magic delta learning (the never-assigned _lastHf) ──────
    {
      const ent = { id: 0x8000010d, name: "Skeleton", x: 96, y: 100, hf: 1 };
      const host = makeHost({ ents: [ent], mode: 8, known: [27] });
      const loop = mk(host);
      loop.tick(); // locks, polls hf=1
      host.emit({ kind: 2, text: "You singe Skeleton for 20 points with Flame Bolt I.", u32: 0, u32b: 0 });
      ent.hf = 0.8; // the QueryHealth reply lands next
      NOW += 100; loop.tick();
      const m = loop.damageModel.get(ent.id);
      check("magic damage + next fraction drop -> MaxHP learned (20 / 0.2 = 100)",
        m && m.hits === 1 && Math.abs(m.maxHp - 100) < 1e-6, JSON.stringify(m));
    }

    // ── 14. kernel: Loot -> Combat cancels the corpse walk ─────────────
    {
      const host = makeHost({ ents: [] });
      const combat = mk(host);
      const loot = { state: "APPROACH", tick() {}, _findCorpse: () => ({ guid: 1 }), lootedCount: 0 };
      const k = new RynthBotKernel(host, { combat, loot }, { log: quiet });
      k.tick();
      const wasLoot = k.action;
      host.byId.set(0x8000010e, { id: 0x8000010e, name: "Rat", x: 96, y: 100 });
      combat._scanMemo = null;
      host.NearbyGuids = () => [0x8000010e];
      k.tick();
      check("kernel Loot -> Combat: the loot MoveToPosition is cancelled (StopCompletely)",
        wasLoot === "Loot" && k.action === "Combat" && host.calls.stopCompletely === 1,
        `was=${wasLoot} now=${k.action} stopCompletely=${host.calls.stopCompletely}`);
    }

    // ── 15. kernel: leaving Combat disengages; Vitals keeps the swing ──
    {
      const rat = { id: 0x8000010f, name: "Rat", x: 96, y: 100 };
      const host = makeHost({ ents: [rat] });
      const combat = mk(host);
      let heal = false;
      const vitals = { step: () => heal, status: {} };
      const k = new RynthBotKernel(host, { combat, vitals }, { log: quiet });
      k.tick();
      check("kernel Combat engaged", k.action === "Combat" && host.calls.melee.length === 1);
      heal = true;
      NOW += 100; k.tick();
      check("Combat -> Vitals: stick released but ACE's swing loop kept (no CancelAttack)",
        k.action === "Vitals" && host.calls.cancel === 0, `action=${k.action} cancel=${host.calls.cancel}`);
      heal = false;
      NOW += 100; k.tick(); // back to Combat, engagement still live
      k.stop(); // goto / pause / travel
      check("kernel.stop() mid-fight: CancelAttack + stick released, action Idle",
        host.calls.cancel === 1 && k.action === "Idle", `cancel=${host.calls.cancel} action=${k.action}`);
    }

    // ── 16. kernel: a stood-down combat loop doesn't hold Combat ───────
    {
      const host = makeHost({ ents: [{ id: 0x80000110, name: "Skeleton", x: 96, y: 104 }], mode: 8, known: [] });
      const combat = mk(host);
      let inCombatSeen = null;
      const vitals = { step: (ic) => { inCombatSeen = ic; return false; }, status: {} };
      const buff = { pending: null, status: { ready: true, active: 0, desired: 1, pending: 0 }, tick() { this.ticked = (this.ticked || 0) + 1; }, heartbeat() {} };
      const k = new RynthBotKernel(host, { combat, vitals, buff }, { log: quiet });
      k.tick(); // Combat -> combat stands down (no war spell)
      NOW += 100; k.tick();
      check("stood-down combat: kernel moves on to Buffing instead of starving behind Combat",
        k.action === "Buffing" && buff.ticked >= 1, `action=${k.action} buffTicks=${buff.ticked}`);
      check("…while Vitals still sees the threat as in-combat", inCombatSeen === true, `inCombat=${inCombatSeen}`);
      check("kernel.status carries the combat detail for the HUD",
        k.status.combat && k.status.combat.incapable && k.status.running === false && "operatorHeld" in k.status,
        JSON.stringify(k.status.combat));
    }

    // ── 18. a recall in flight (cast-token owner "recall") + the Magic
    //        mode it leaves behind ──────────────────────────────────────
    {
      const ent = { id: 0x80000111, name: "Drudge", x: 96, y: 104 }; // 8 m
      const host = makeHost({ ents: [ent], mode: 2, known: [27] });
      host.TryGetPlayerPose = () => ({ objCellId: LB, x: 96, y: 96, z: 0, heading: 0 });
      let holder = null; // shared token: another owner's unresolved claim blocks
      host.tryClaimCast = (owner) => {
        if (holder && holder !== owner) return false;
        holder = owner;
        return true;
      };
      host.releaseCast = (owner) => { if (holder === owner) holder = null; };
      const loop = mk(host);
      loop.tick();
      check("melee engaged before the recall", host.calls.melee.length === 1);
      // goto_compose casts Lifestone Recall: token "recall", mode -> Magic.
      holder = "recall";
      host.mode = 8;
      for (let i = 0; i < 5; i++) { NOW += 200; loop.tick(); }
      check("recall flips to Magic: engagement dropped WITHOUT CancelAttack (the mode change ended ACE's loop)",
        host.calls.cancel === 0 && host.calls.melee.length === 1, `cancel=${host.calls.cancel} melee=${host.calls.melee.length}`);
      check("…and no combat cast while the recall holds the shared token", host.calls.cast.length === 0,
        `casts=${host.calls.cast.length}`);
      holder = null; // recall resolved
      NOW += 200; loop.tick();
      check("token free again: combat casts in the Magic mode the recall left", host.calls.cast.length === 1,
        `casts=${host.calls.cast.length}`);
    }

    // ── 19. hunt_stop with netBrain "on" (the default) stands a fight down
    {
      const rat = { id: 0x80000112, name: "Rat", x: 96, y: 104 };
      const host = makeHost({ ents: [rat] });
      host.GetPlayerId = () => 0x50000001;
      host.HasObjectDescFlags = () => true;
      host._live = () => 0x10;
      const loop = mk(host);
      // Fake C# slice that always keeps the rat (its input has no hunting bit).
      let csCalls = 0;
      const brain = { scoreTargets: () => ({ SelectedTargetId: rat.id | 0, TargetLostScanAtMs: -1, Scanned: [] }) };
      const nbModule = {
        shadowTick: (b, _kind, build) => { csCalls++; build(); return b.scoreTargets(); },
        diag: () => ({ truncated: 0 }),
      };
      loop.attachNetBrain(brain, "on", nbModule, { minIntervalMs: 0 });
      loop.tick();
      check("netBrain on: C# lock engaged", loop.locked === rat.id && host.calls.melee.length === 1 && csCalls === 1);
      loop.enabled = false; // director hunt_stop
      NOW += 100; loop.tick();
      const csAfterStop = csCalls;
      NOW += 1600; loop.tick(); // T10 grace (1.5 s) expires on the empty scan
      check("hunt_stop under netBrain=on: C# not consulted, lock drops after the grace, attack cancelled",
        csCalls === csAfterStop && csAfterStop === 1 && loop.locked === 0 && host.calls.cancel === 1,
        `csCalls=${csCalls} locked=${loop.locked.toString(16)} cancel=${host.calls.cancel}`);
    }

    // ── 20. approach watchdog: a run-up that stops closing parks the mob ─
    {
      const far = { id: 0x80000113, name: "Mosswart", x: 96, y: 126 }; // 30 m, unreachable
      const near = { id: 0x80000114, name: "Rat", x: 96, y: 131 }; // 35 m, reachable
      const host = makeHost({ ents: [far, near] });
      const loop = mk(host);
      loop.tick();
      check("approach watchdog: run-up starts on the nearer mob", loop.locked === far.id && loop.state === "APPROACH");
      for (let i = 0; i < 9; i++) { NOW += 1000; loop.tick(); } // no progress for 9 s
      NOW += 100; loop.tick(); // the park drops the lock; selection re-locks next tick
      check("no 1 m of closing in 8 s: parked unreachable, lock moves on (no CancelAttack — nothing requested)",
        loop.unreachable.has(far.id) && loop.locked === near.id && host.calls.cancel === 0 && host.calls.melee.length === 0,
        `parked=${loop.unreachable.has(far.id)} locked=${loop.locked.toString(16)} cancel=${host.calls.cancel}`);
      check("parked mob is out of the threat scan", !loop._scanTargets().some((t) => t.guid === far.id));
      NOW += 61_000;
      loop._scanMemo = null;
      check("park lapses after 60 s", loop._scanTargets().some((t) => t.guid === far.id));
    }

    // ── 21. kernel honours per-loop `enabled` (HUD / OperatorControl) ──
    {
      const host = makeHost({ ents: [] });
      const combat = mk(host);
      let vitalsSteps = 0;
      const vitals = { enabled: false, step: () => { vitalsSteps++; return true; }, status: {} };
      const buff = {
        enabled: false, pending: 7, ticks: 0, beats: 0,
        status: { ready: false, active: 0, desired: 2, pending: 1 },
        tick() { this.ticks++; }, heartbeat() { this.beats++; },
      };
      const loot = { enabled: false, state: "APPROACH", ticks: 0, tick() { this.ticks++; }, _findCorpse: () => null, lootedCount: 0 };
      const k = new RynthBotKernel(host, { combat, vitals, buff, loot }, { log: quiet });
      k.tick(); k.tick();
      check("disabled vitals/buff/loot: no step, no heartbeat, no pin, no tick — kernel Idle",
        k.action === "Idle" && vitalsSteps === 0 && buff.beats === 0 && buff.ticks === 0 && loot.ticks === 0,
        `action=${k.action} vitals=${vitalsSteps} beats=${buff.beats} buffTicks=${buff.ticks} lootTicks=${loot.ticks}`);
      buff.enabled = true;
      k.tick();
      check("re-enabled buff takes the tick again (pinned on its pending cast)", k.action === "Buffing" && buff.ticks === 1 && buff.beats === 1,
        `action=${k.action} ticks=${buff.ticks}`);
      // A held buff loop (no components / no caster: status.blocked) with
      // nothing in flight doesn't park the kernel on Buffing.
      buff.pending = null;
      buff.status = { ready: true, active: 0, desired: 2, pending: 0, blocked: "components" };
      k.tick();
      check("blocked buff loop, nothing pending: kernel Idle, not Buffing", k.action === "Idle" && buff.ticks === 1,
        `action=${k.action} ticks=${buff.ticks}`);
      // Operator-hold contract the ai fork's OperatorControl relies on.
      k.holdForOperator();
      check("holdForOperator: stopped + start() refused while held", k.running === false && k.operatorHeld === true && k.start() === false);
      k.releaseOperatorHold();
      check("releaseOperatorHold: start() allowed again", k.start() === true && k.running === true);
    }

    // ── 22. priority rule keys match case-insensitively ────────────────
    {
      const host = makeHost({ ents: [
        { id: 0x80000115, name: "Drudge Skulker", x: 96, y: 104 }, // 8 m
        { id: 0x80000116, name: "Olthoi Soldier", x: 96, y: 126 }, // 30 m
      ] });
      const loop = mk(host, { priorities: { Olthoi: 10 } }); // director/HUD casing kept
      const best = loop._scanTargets()[0];
      check("capitalized rule key 'Olthoi' matches 'Olthoi Soldier' (+45 outranks 22 m closer)",
        best && best.guid === 0x80000116 && Object.keys(loop.priorities)[0] === "Olthoi",
        `best=${best && best.guid.toString(16)}`);
    }

    // ── 23. caster contract: refusal resolves early, deadline 12 s with
    //        UseDone, busy gate, portal space ────────────────────────────
    {
      const ent = { id: 0x80000117, name: "Skeleton", x: 96, y: 104 }; // 8 m, dead ahead
      const host = makeHost({ ents: [ent], mode: 8, known: [27, 28] });
      host.TryGetPlayerPose = () => ({ objCellId: LB, x: 96, y: 96, z: 0, heading: 0 });
      let useDone = 0;
      let busy = 0;
      host.has = (cap) => cap === "GetUseDoneSeq" || cap === "TurnToHeading";
      host.GetUseDoneSeq = () => useDone;
      host.GetBusyState = () => busy;
      const loop = mk(host);
      loop.tick(); NOW += 200; loop.tick();
      check("caster: first bolt out", host.calls.cast.length === 1);
      NOW += 3000; loop.tick();
      check("UseDone tracked: still awaiting at 3 s (level-5+ windups run 2.9-4.4 s; was a flat 2.5 s)",
        loop.awaitingCast === true && host.calls.cast.length === 1, `awaiting=${loop.awaitingCast}`);
      host.emit({ kind: 13, text: "YourSpellFizzled", u32: 0x0402, u32b: 0 }); // fizzle: no UseDone
      check("kind=13 fizzle resolves our cast at once", loop.awaitingCast === false);
      busy = 1; // vitals' heal in flight (shadow busy count)
      NOW += 300; loop.tick();
      check("shadow busy count gates the next bolt", host.calls.cast.length === 1);
      busy = 0;
      NOW += 300; loop.tick();
      check("busy cleared: next bolt", host.calls.cast.length === 2);
      host.emit({ kind: 13, text: "YouDontHaveEnoughManaToCast", u32: 0x0401, u32b: 0 });
      NOW += 1000; loop.tick();
      check("mana refusal: 5 s backoff before the next bolt", host.calls.cast.length === 2);
      NOW += 4500; loop.tick();
      check("…then casting resumes", host.calls.cast.length === 3);
      useDone++; // the third bolt lands
      host.emit({ kind: 13, text: "MagicInvalidSpellType", u32: 0x03fc, u32b: 0 });
      check("unknown-spell refusal drops the cached bolt for a re-pick", loop.warSpell === null);
      host.emit({ kind: 13, text: "YouDontHaveAllTheComponents", u32: 0x0400, u32b: 0 });
      // (not awaiting a cast now: an unrelated refusal must not stand us down)
      check("a refusal with no cast of ours in flight is ignored", loop.canEngage() === true);
      NOW += 300; loop.tick();
      host.emit({ kind: 13, text: "YouDontHaveAllTheComponents", u32: 0x0400, u32b: 0 });
      check("components refusal on our cast: stand down", loop.canEngage() === false && /components/.test(loop.status.incapable || ""),
        `incapable=${loop.status.incapable}`);
      // Portal space: no requests at all.
      const host2 = makeHost({ ents: [{ id: 0x80000118, name: "Rat", x: 96, y: 100 }] });
      host2.IsPortalSpaceActive = () => true;
      const loop2 = mk(host2);
      loop2.tick();
      check("portal space: no stick, no attack, state PORTAL",
        loop2.state === "PORTAL" && host2.calls.melee.length === 0 && host2.calls.stick.length === 0, `state=${loop2.state}`);
      host2.IsPortalSpaceActive = () => false;
      NOW += 100; loop2.tick();
      check("…resumes when the world is back", host2.calls.melee.length === 1);
    }

    // ── 24. a VT helper's Healer's Heart swap holds the loadout ─────────
    // combat.loadoutHeldFn (the layer wires support/helpers.js holdsWandSlot,
    // with or without a planner): a melee/missile hybrid on a Default profile
    // heals a fellow with the heart — Magic stance, the heart in hand, no war
    // bolt. While held: no "no war spell" / stance stand-down, no toggle, no
    // swing or bolt, no run-up; the lock is kept. After: the fight resumes.
    {
      const rat = { id: 0x8000018a, name: "Rat", x: 96, y: 100 }; // 4 m: melee range
      const hybrid = (held) => {
        const host = makeHost({ ents: [{ ...rat }], mode: 8, known: [] });
        const loop = mk(host);
        loop.loadoutHeldFn = typeof held === "function" ? held : () => held;
        return { host, loop };
      };
      const acts = (host) => host.calls.toggle + host.calls.cast.length + host.calls.melee.length + host.calls.missile.length + host.calls.stick.length;
      {
        let held = true;
        const { host, loop } = hybrid(() => held);
        for (let i = 0; i < 20; i++) { NOW += 1000; loop.canEngage(); loop.tick(); }
        check("held loadout (heart in hand, Magic, no war bolt): no stand-down, no toggle / bolt / swing / run-up, lock kept",
          loop.canEngage() && acts(host) === 0 && loop.locked === rat.id && loop.state === "ENGAGE",
          `canEngage=${loop.canEngage()} acts=${acts(host)} locked=${loop.locked.toString(16)} state=${loop.state} incapable=${loop.status.incapable}`);
        host.mode = 1; // the stance drops while the weapons go back…
        for (let i = 0; i < 25; i++) { NOW += 1000; loop.tick(); }
        check("…a NonCombat stance while held is no toggle either (no 'mode will not establish')", host.calls.toggle === 0 && loop.canEngage());
        held = false;
        host.mode = 2; // …the sword is back in hand and Melee holds
        NOW += 100; loop.canEngage(); loop.tick();
        check("…the hold ends: the fight resumes on the next tick (one melee request)", host.calls.melee.length === 1, `melee=${host.calls.melee.length}`);
      }
      {
        const { host, loop } = hybrid(undefined); // no hook (or never held): today's behaviour
        loop.loadoutHeldFn = null;
        NOW += 1000; loop.tick();
        const thrower = hybrid(() => { throw new Error("helpers gone"); });
        NOW += 1000; thrower.loop.tick();
        check("no hook / a throwing hook = not held: the no-war-spell stand-down as before",
          !loop.canEngage() && !thrower.loop.canEngage() && /no war spell/.test(loop.status.incapable || ""), `incapable=${loop.status.incapable}`);
        void host;
      }
      {
        // A stand-down judged on the heart before the hold was seen ends with
        // the hold (the kernel's canEngage() read notices it; a stood-down
        // loop isn't ticked) — one with no hold episode is left alone.
        let held = false;
        const { host, loop } = hybrid(() => held);
        NOW += 1000; loop.tick();
        const stoodDown = !loop.canEngage();
        held = true;
        NOW += 1000;
        const duringHold = loop.canEngage();
        held = false;
        host.mode = 2;
        NOW += 1000;
        const after = loop.canEngage();
        loop.tick();
        const other = hybrid(false);
        NOW += 1000; other.loop.tick();
        NOW += 1000;
        check("a stand-down judged on the held loadout is cleared when the hold ends (still stood down during it); no hold episode = not cleared",
          stoodDown && !duringHold && after && host.calls.melee.length === 1 && !other.loop.canEngage(),
          `stoodDown=${stoodDown} during=${duringHold} after=${after} melee=${host.calls.melee.length} other=${other.loop.canEngage()}`);
      }
      {
        // The VT no-progress clock is paused while held: 10 s held, then 3 s
        // fighting with no damage → not parked (5 s timeout); 3 s more → parked.
        let held = false;
        const { host, loop } = hybrid(() => held);
        host.mode = 2;
        const opts = { TargetLock: false, AttackMinDistance: 0, MonsterDisengageRange: 0, TargetNoProgressTimeoutSec: 5, DoJiggle: false };
        loop.optFn = (k) => opts[k];
        NOW += 100; loop.tick(); // lock (melee request)
        held = true;
        for (let i = 0; i < 10; i++) { NOW += 1000; loop.tick(); }
        held = false;
        for (let i = 0; i < 3; i++) { NOW += 1000; loop.tick(); }
        const keptAfterHold = !loop.unreachable.has(rat.id);
        for (let i = 0; i < 3; i++) { NOW += 1000; loop.tick(); }
        check("the no-progress clock pauses while the loadout is held (kept 3 s after a 10 s hold, parked past 5 s of fighting)",
          keptAfterHold && loop.unreachable.has(rat.id), `kept=${keptAfterHold} parked=${loop.unreachable.has(rat.id)}`);
      }
    }

    // ── 17. globalDist across a landblock seam ─────────────────────────
    {
      const me = { objCellId: 0xa9b40030 >>> 0, x: 190, y: 10, z: 0 };
      const pos = { objCellId: 0xaab40001 >>> 0, x: 2, y: 10, z: 0 }; // next LB east
      check("globalDist folds the landblock index (4 m across the seam, not 188)",
        Math.abs(globalDist(me, pos) - 4) < 1e-9, String(globalDist(me, pos)));
    }
  } finally {
    Date.now = realNow;
  }

  const W = Math.max(...results.map((r) => r.name.length)) + 1;
  let failed = 0;
  for (const r of results) {
    if (!r.ok) failed++;
    console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name.padEnd(W)}${r.ok ? "" : ` [${r.detail}]`}`);
  }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  if (failed) process.exit(1);
}

main().catch((e) => {
  console.error("HARNESS ERROR:", e);
  process.exit(1);
});
