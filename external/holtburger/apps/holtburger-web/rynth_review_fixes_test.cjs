#!/usr/bin/env node
// rynth_review_fixes_test.cjs — the 2026-10-12 /code-review fixes in the
// rynth loops (findings numbered as in that review):
//   #3  RB*  buff_loop: a refusal is pinned on the pending buff only while the
//            buff's own (successful) UseDone hasn't come — a vitals/combat/
//            loot refusal after it no longer holds ALL self-buffing; a fizzle
//            (WeenieError, BEFORE the cast's own UseDone) still counts; a stale
//            pre-issue UseDone doesn't mark the cast answered.
//   #5  RK*  kernel: a Vitals heal that borrowed the tick mid-fight keeps ACE's
//            attack loop on purpose — a later stop() / Unwedge / Vitals ->
//            Loot|Buffing|Idle now cancels it; Vitals -> Combat doesn't.
//   #7  RR*  goto_compose recall waits out another module's cast token (up to
//            the 12 s token lifetime) instead of firing into its windup at 4 s.
//   #8  RL*  loot pickups go to the main pack while it has room, else the
//            first side pack with room (ACE never overflows a full main pack).
//   #11 RV*  vitals re-reads an EMPTY spellbook at most every 2 s, not on
//            every _known() call.
//   #14 RC*  one casterWielded() helper (buff_loop.js) shared by vitals.js.
//
// Run: node rynth_review_fixes_test.cjs   (exit 1 on any FAIL)
"use strict";
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const RYNTH = path.join(__dirname, "rynth");
const load = (rel) => import(pathToFileURL(path.join(RYNTH, rel)).href);

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? " — " + detail : ""}`); }
}

const SELF = 0x50000001;
const EQUIP_CASTER = 0x01000000;

// Minimal RynthWebHost double for the buff loop (shape of rynth_magic_update_test).
function buffHost(opts = {}) {
  const st = { reg: [], known: opts.known || [], useDone: 0, casts: [], handlers: [], token: null };
  return {
    st,
    IsPlayerReady: () => true,
    GetCurrentCombatMode: () => 8,
    GetCastBusyState: () => 0,
    GetBusyState: () => 0,
    GetPlayerId: () => SELF,
    CastSpell: (target, id) => st.casts.push({ target, id }),
    ChangeCombatMode: () => {},
    TryGetPlayerInventory: () => [{ guid: 7, equipMask: EQUIP_CASTER }],
    onEvent: (fn) => st.handlers.push(fn),
    tryClaimCast: (o) => { if (st.token && st.token !== o) return false; st.token = o; return true; },
    releaseCast: (o) => { if (st.token === o) st.token = null; },
    s: {
      playerEnchantments: () => st.reg.map((r) => ({ ...r, free() {} })),
      playerKnownSpells: () => st.known.slice(),
      getUseDoneSeq: () => st.useDone,
    },
    emit(e) { for (const fn of st.handlers) fn(e); },
  };
}

(async () => {
  const realNow = Date.now;
  const T0 = 9_000_000;
  let now = T0;
  Date.now = () => now;
  try {
    const bl = await load("buff_loop.js");
    const { RynthBuffLoop, loadSpellLadders, casterWielded } = bl;
    const ladder = await loadSpellLadders();
    const FAM = ladder["4325"] ? ladder["4325"][0] : 1;
    const mk = (host) => {
      const loop = new RynthBuffLoop(host, [1332], { log: () => {} });
      loop.startedAt = T0;
      loop._buildLadders();
      loop.registryReady = true;
      loop._refresh();
      return loop;
    };

    // ── #3 RB1: the review's scenario — the buff's own UseDone came, then
    // another module's cast is refused for components.
    {
      now = T0;
      const host = buffHost({ known: [1332, 4325] });
      const loop = mk(host);
      loop.tick(); // casts 4325 (pending), taps events
      const cast = loop.pending && loop.pending.spellId;
      now = T0 + 3000;
      host.st.useDone = 1;
      host.emit({ kind: 14, u32: 0, u32b: 0, text: null }); // OUR UseDone (success)
      now = T0 + 3100;
      host.emit({ kind: 13, u32: 0x0400, u32b: 0, text: "YouDontHaveAllTheComponents" }); // vitals' refusal
      check("RB1 a refusal after our own UseDone is NOT pinned on the buff",
        !!loop.pending && loop.pending.refusal == null, JSON.stringify(loop.pending));
      host.st.reg = [{ spellId: cast, spellCategory: FAM, startTime: 0, duration: 3600, layer: 0 }];
      now = T0 + 3400;
      loop.tick();
      check("RB1 the buff still confirms when it lands; buffing not held",
        loop.pending === null && !loop.status.blocked && host.st.casts.length === 1 && loop.lastRefusal == null,
        `blocked=${loop.status.blocked} casts=${host.st.casts.length} lastRefusal=${JSON.stringify(loop.lastRefusal)}`);
    }
    // ── #3 RB2: our OWN refusal (UseDone with an error, before any success UseDone) is ours.
    {
      now = T0;
      const host = buffHost({ known: [1332, 4325] });
      const loop = mk(host);
      loop.tick();
      now = T0 + 300;
      host.st.useDone = 1; // the refusal IS our UseDone (seq bumps with it)
      host.emit({ kind: 13, u32: 0x0400, u32b: 0, text: "YouDontHaveAllTheComponents" });
      now = T0 + 700;
      loop.tick();
      check("RB2 our own components refusal still holds buffing",
        loop.pending === null && loop.status.blocked === "components", `blocked=${loop.status.blocked}`);
    }
    // ── #3 RB3: a fizzle arrives as a WeenieError BEFORE the cast's own UseDone — ours.
    {
      now = T0;
      const host = buffHost({ known: [1332, 4325] });
      const loop = mk(host);
      loop.tick();
      now = T0 + 2000;
      host.emit({ kind: 13, u32: 0x0402, u32b: 0, text: "YourSpellFizzled" }); // seq unchanged (WeenieError arm)
      const pinned = loop.pending && loop.pending.refusal && loop.pending.refusal.cls;
      host.st.useDone = 1;
      host.emit({ kind: 14, u32: 0, u32b: 0, text: null }); // the cast's own UseDone follows
      check("RB3 a fizzle (WeenieError before our UseDone) is attributed to the buff", pinned === "fizzle", String(pinned));
    }
    // ── #3 RB4: a stale UseDone of an earlier action (seq bumped before our
    // issue, dispatched after it) does not mark our cast answered.
    {
      now = T0;
      const host = buffHost({ known: [1332, 4325] });
      host.st.useDone = 5; // already bumped when we cast
      const loop = mk(host);
      loop.tick();
      now = T0 + 50;
      host.emit({ kind: 14, u32: 0, u32b: 0, text: null }); // stale: live seq still == issue seq
      check("RB4 a pre-issue UseDone is not counted", loop.pending && (loop.pending.useDoneEvents || 0) === 0,
        JSON.stringify(loop.pending));
      now = T0 + 400;
      host.st.useDone = 6;
      host.emit({ kind: 13, u32: 0x0401, u32b: 0, text: "YouDontHaveEnoughManaToCast" });
      check("RB4 ...so our own later refusal is still ours", loop.pending && loop.pending.refusal && loop.pending.refusal.cls === "mana",
        JSON.stringify(loop.pending));
    }

    // ── #14 RC: one caster helper.
    {
      const v = await load("vitals.js");
      const h1 = { TryGetPlayerInventory: () => [{ equipMask: EQUIP_CASTER }] };
      const h2 = { TryGetPlayerInventory: () => [{ equipMask: 0x00100000 }] };
      const h3 = { TryGetPlayerInventory: () => [] };
      check("RC1 casterWielded: caster / melee / unknown", casterWielded(h1) === true && casterWielded(h2) === false && casterWielded(h3) === null && casterWielded({}) === null);
      const vit = new v.RynthVitals(h1, { log: () => {} });
      const bf = new RynthBuffLoop(h2, [], { log: () => {} });
      check("RC2 vitals and buff delegate to it", vit._casterWielded() === true && bf._casterWielded() === false);
      check("RC3 EQUIP_CASTER exported once", bl.EQUIP_CASTER === EQUIP_CASTER);
    }

    // ── #11 RV: empty-book refresh throttle.
    {
      const v = await load("vitals.js");
      now = T0;
      let reads = 0;
      let book = [];
      const host = { s: { playerKnownSpells: () => { reads++; return book.slice(); } } };
      const vit = new v.RynthVitals(host, { log: () => {} });
      for (let i = 0; i < 10; i++) vit._known(6);
      check("RV1 an empty book is read once per 2 s, not per call", reads === 1, `reads=${reads}`);
      now = T0 + 2100;
      book = [6];
      check("RV2 ...and re-read after 2 s (the book streamed in)", vit._known(6) === true && reads === 2, `reads=${reads}`);
      for (let i = 0; i < 10; i++) vit._known(6);
      now = T0 + 20_000;
      vit._known(6);
      check("RV3 a non-empty book keeps the 30 s cadence", reads === 2, `reads=${reads}`);
      now = T0 + 2100 + 30_001;
      vit._known(6);
      check("RV4 ...and refreshes after 30 s", reads === 3, `reads=${reads}`);
    }
  } finally {
    Date.now = realNow;
  }

  // ── #5 RK: kernel releases a Vitals-held fight.
  {
    const { RynthBotKernel } = await load("kernel.js");
    const mkKernel = () => {
      const calls = [];
      const combat = {
        locked: 0x1234, enabled: true, kills: 0, ticks: 0,
        canEngage: () => true, _scanTargets: () => [], tick() { this.ticks++; },
        disengage(o) { calls.push(o && o.cancelAttack); },
        get status() { return { engagedAt: 1 }; },
      };
      const vitals = { enabled: true, active: false, step() { return this.active; }, status: {} };
      const unwedge = { on: false, active() { return this.on; } };
      const host = { IsPlayerReady: () => true, StopStick() {}, StopCompletely() {}, onTick() {} };
      const k = new RynthBotKernel(host, { combat, buff: null, loot: null, vitals, unwedge }, { log: () => {} });
      return { k, combat, vitals, unwedge, calls };
    };
    {
      const { k, combat, vitals, calls } = mkKernel();
      k.tick();
      check("RK0 locked target -> Combat", k.action === "Combat" && combat.ticks === 1, k.action);
      vitals.active = true;
      k.tick();
      check("RK1 Combat -> Vitals keeps the attack loop", k.action === "Vitals" && calls.length === 1 && calls[0] === false, JSON.stringify(calls));
      combat.locked = 0; // the lock dropped during the heal
      vitals.active = false;
      k.tick();
      check("RK2 Vitals -> Idle (fight over) cancels the kept attack loop", k.action === "Idle" && calls.length === 2 && calls[1] === true, JSON.stringify(calls));
    }
    {
      const { k, vitals, calls } = mkKernel();
      k.tick();
      vitals.active = true;
      k.tick(); // -> Vitals (kept)
      k.stop();
      check("RK3 stop() during a mid-fight heal cancels the attack loop", calls.length === 2 && calls[1] === true && k.action === "Idle", JSON.stringify(calls));
    }
    {
      const { k, vitals, calls } = mkKernel();
      k.tick();
      vitals.active = true;
      k.tick();
      vitals.active = false;
      k.tick(); // lock still held -> back to Combat
      check("RK4 Vitals -> Combat resumes the fight without a cancel", k.action === "Combat" && calls.length === 1, JSON.stringify(calls));
      k.stop();
      check("RK4 ...and a later stop() still cancels once", calls.length === 2 && calls[1] === true, JSON.stringify(calls));
    }
    {
      const { k, vitals, unwedge, calls } = mkKernel();
      k.tick();
      vitals.active = true;
      k.tick();
      vitals.active = false;
      unwedge.on = true;
      k.tick();
      check("RK5 Vitals -> Unwedge cancels the kept attack loop", k.action === "Unwedge" && calls.length === 2 && calls[1] === true, JSON.stringify(calls));
    }
    {
      const { k, calls } = mkKernel();
      k.stop(); // never fought
      check("RK6 stop() with no fight sends nothing", calls.length === 0, JSON.stringify(calls));
    }
  }

  // ── #7 RR: recall waits out another module's cast token.
  {
    const gc = await load("goto_compose.js");
    const FARLB = 0x40400001;
    const mkHost = (freeAfterMs) => {
      const st = { pose: { objCellId: 0x05050001, x: 40, y: 40, z: 0 }, token: "vitals", order: [] };
      if (freeAfterMs != null) setTimeout(() => { st.token = null; st.order.push("vitals-done"); }, freeAfterMs);
      return {
        st,
        s: { playerKnownSpells: () => [1636] },
        TryGetPlayerPose: () => st.pose,
        GetCastBusyState: () => 0,
        GetCurrentCombatMode: () => 8,
        ChangeCombatMode: () => true,
        tryClaimCast: (o) => { if (st.token && st.token !== o) return false; st.token = o; st.order.push(`claim:${o}`); return true; },
        releaseCast: (o) => { if (st.token === o) { st.token = null; st.order.push(`release:${o}`); } },
        CastSpell: (t, id) => { st.order.push(`cast:${id}`); setTimeout(() => { st.pose = { objCellId: FARLB, x: 5, y: 5, z: 0 }; }, 4); return true; },
      };
    };
    const tune = { poseTimeoutMs: 50, posePollMs: 2, recallTeleportMs: 300, teleportPollMs: 2, portalJumpM: 30, magicModeTimeoutMs: 50 };
    {
      const host = mkHost(120);
      const r = await gc.attemptRecallCast({ host }, { meta: { spellId: 1636, spellName: "Lifestone Sending" } }, tune);
      check("RR1 recall waits for the other cast's token, then claims and casts",
        r.ok === true && host.st.order.join(",") === "vitals-done,claim:recall,cast:1636,release:recall", host.st.order.join(","));
    }
    {
      const host = mkHost(null); // never freed
      const t0 = Date.now();
      const r = await gc.attemptRecallCast({ host }, { meta: { spellId: 1636, spellName: "Lifestone Sending" } }, { ...tune, castTokenWaitMs: 60 });
      check("RR2 a token never freed: bounded by castTokenWaitMs, then degrade-open cast",
        r.ok === true && host.st.order.join(",") === "cast:1636" && Date.now() - t0 < 1000, `${host.st.order.join(",")} ${Date.now() - t0}ms`);
    }
    {
      // Drift guard: the recall's default wait must outlast the host token's
      // own lifetime (webhost.js CAST_TOKEN_TIMEOUT_MS), or it fires into the
      // other module's windup again (the 4 s vs 12 s bug).
      const fs = require("node:fs");
      const num = (src, name) => {
        const m = src.match(new RegExp(`const ${name} = ([0-9_]+);`));
        return m ? Number(m[1].replace(/_/g, "")) : NaN;
      };
      const tokenMs = num(fs.readFileSync(path.join(RYNTH, "webhost.js"), "utf8"), "CAST_TOKEN_TIMEOUT_MS");
      const waitMs = num(fs.readFileSync(path.join(RYNTH, "goto_compose.js"), "utf8"), "RECALL_TOKEN_WAIT_MS");
      check("RR3 recall token wait > the host's cast-token timeout", waitMs > tokenMs, `wait=${waitMs} token=${tokenMs}`);
    }
  }

  // ── #8 RL: pickup destination.
  {
    const { RynthLootLoop } = await load("loot_loop.js");
    const ME = 0x50000001, PACK_A = 0x80000a01, PACK_B = 0x80000b02;
    const mkLoot = (room) => {
      const moves = [];
      const host = {
        TryGetPackRoom: () => room,
        TryGetFreeSlots: () => (room ? room.freeItemSlots : null),
        MoveItemToContainer: (item, dest, place) => { moves.push([item >>> 0, dest >>> 0, place]); return true; },
        onEvent: () => {},
      };
      return { loop: new RynthLootLoop(host, { log: () => {} }), moves };
    };
    const roomOf = (mainFree, packs) => ({
      main: { used: 102 - mainFree, cap: 102, free: mainFree },
      containers: { used: packs.length, cap: 7, free: 7 - packs.length },
      packs: packs.map(([guid, free]) => ({ guid, name: "Pack", used: 24 - free, cap: 24, free })),
      freeItemSlots: mainFree + packs.reduce((s, [, f]) => s + f, 0),
    });
    {
      const { loop, moves } = mkLoot(roomOf(5, [[PACK_A, 3]]));
      loop._pickup(0x1111, ME);
      check("RL1 main pack has room -> pickup into the main pack", moves.length === 1 && moves[0][1] === ME, JSON.stringify(moves));
    }
    {
      const { loop, moves } = mkLoot(roomOf(0, [[PACK_A, 0], [PACK_B, 4]]));
      loop._pickup(0x2222, ME);
      check("RL2 main pack full -> first side pack WITH room", moves.length === 1 && moves[0][1] === PACK_B, JSON.stringify(moves));
      check("RL2 ...and looting is not paused", loop._packFull() === false);
    }
    {
      const { loop } = mkLoot(roomOf(0, [[PACK_A, 0]]));
      check("RL3 main and every side pack full -> looting paused", loop._packFull() === true);
    }
    {
      const { loop, moves } = mkLoot(null); // inventory not streamed
      loop._pickup(0x3333, ME);
      check("RL4 unknown room -> the main pack, as before", moves.length === 1 && moves[0][1] === ME && loop._packFull() === false, JSON.stringify(moves));
    }
  }

  console.log(`\nreview-fixes: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(`ERR ${e.stack || e.message}`);
  process.exit(1);
});
