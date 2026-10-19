#!/usr/bin/env node
// rynth_combat_jiggle_test.cjs — VTank DoJiggle in rynth/combat_loop.js
// (2026-10-19, owner: "strafe between casts"). With the VT layer's optFn
// answering DoJiggle true: after one of OUR magic casts resolves and before
// the next, a ~300 ms strafe through host.SetMovementInput(0, ±1, 0, true)
// (sides alternate), then the canonical all-zero stop and FACE_SETTLE_MS
// before the next cast. Never while a cast is in flight (ours, or anyone's on
// the shared busy count — a MoveToState inside a windup orphans the cast),
// never in melee/missile, never with the stick armed (an approach ends it
// first), never while another mover owns the body (the layer's
// movementClaimedFn — none = no jiggle), never in portal space; disengage()
// and stop() stop a strafe at once. Off (the default) or without the layer
// the cast cadence is unchanged.
// Mock host, frozen 100 ms heartbeat, no infra.  Run: node rynth_combat_jiggle_test.cjs
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");

const LB = 0xa9b40015 >>> 0;
const FACE_SETTLE_MS = 140; // combat_loop.js
let NOW = 9_000_000;

async function importCopy(rel) {
  const src = fs.readFileSync(path.join(__dirname, rel), "utf8");
  const tmp = path.join(os.tmpdir(), `${path.basename(rel, ".js")}_jiggle_${process.pid}.mjs`);
  fs.writeFileSync(tmp, src);
  try {
    return await import("file://" + tmp);
  } finally {
    fs.unlinkSync(tmp);
  }
}

function makeHost({ ents, mode = 8 }) {
  const byId = new Map(ents.map((e) => [e.id, e]));
  const log = []; // [kind, at, ...args] in call order
  const host = {
    log, byId, mode, seq: 0, busy: 0, portal: false, sticky: 0,
    IsPlayerReady: () => true,
    IsPortalSpaceActive: () => host.portal,
    TryGetPlayerPose: () => ({ objCellId: LB, x: 96, y: 96, z: 0, heading: null }),
    NearbyGuids: () => ents.map((e) => e.id),
    ObjectIsPlayer: () => false,
    TryGetObjectIntProperty: (_g, s) => (s === 1 ? 16 : undefined),
    ObjectIsAttackable: () => true,
    TryGetTargetHealthFraction: (g) => byId.get(g)?.hf ?? 1,
    TryGetObjectPosition: (g) => {
      const e = byId.get(g);
      return e ? { objCellId: LB, x: e.x, y: e.y, z: 0 } : null;
    },
    TryGetObjectName: (g) => byId.get(g)?.name ?? null,
    GetCurrentCombatMode: () => host.mode,
    StickToObject: (g) => { log.push(["stick", NOW, g]); host.sticky = g; return true; },
    StopStick: () => { host.sticky = 0; return true; },
    TryGetLocalStickyTarget: () => host.sticky,
    QueryHealth: () => true,
    MeleeAttack: (g) => { log.push(["melee", NOW, g]); return true; },
    CancelAttack: () => true,
    ToggleCombatMode: () => true,
    TurnToHeading: () => true,
    CastSpell: (_t, s) => { log.push(["cast", NOW, s]); return true; },
    SetMovementInput: (f, s, t, r) => { log.push(["move", NOW, f, s, t, r]); return true; },
    GetCastBusyState: () => 0,
    GetBusyState: () => host.busy,
    GetUseDoneSeq: () => host.seq,
    TryGetKnownSpells: () => [27],
    has: (cap) => cap === "TurnToHeading" || cap === "GetUseDoneSeq",
    onTick: () => {},
  };
  return host;
}

/** Tick every 100 ms for `ms`; each cast resolves (UseDone) `resolveMs` after
 *  it went out and lands (the health drops: contact, so the no-contact
 *  blacklist stays out of it). Returns the casts' [issuedAt, resolvedAt]. */
function sim(loop, host, ms, { resolveMs = 1500, onTick } = {}) {
  const windows = [];
  let pending = null;
  for (let t = 0; t < ms; t += 100) {
    if (pending && NOW >= pending[1]) {
      host.seq++;
      for (const e of host.byId.values()) e.hf = Math.max(0.1, (e.hf ?? 1) - 0.02);
      pending = null;
    }
    const n = host.log.length;
    loop.tick();
    if (host.log.slice(n).some((e) => e[0] === "cast")) {
      pending = [NOW, NOW + resolveMs];
      windows.push(pending);
    }
    if (onTick) onTick(t);
    NOW += 100;
  }
  return windows;
}

const moves = (host) => host.log.filter((e) => e[0] === "move");
const casts = (host) => host.log.filter((e) => e[0] === "cast").map((e) => e[1]);

const results = [];
const check = (name, ok, detail) => results.push({ name, ok: !!ok, detail: detail || "" });

async function main() {
  const { RynthCombatLoop } = await importCopy("rynth/combat_loop.js");
  const realNow = Date.now;
  Date.now = () => NOW;
  const DRUDGE = { id: 0x80000901, name: "Drudge Skulker", x: 96, y: 104 }; // 8 m: inside magic range
  const mk = (host, { opts, claimed = false, hook = true, logs = null } = {}) => {
    const loop = new RynthCombatLoop(host, { log: logs ? (m) => logs.push(m) : () => {} });
    if (opts) {
      const o = { TargetLock: false, AttackMinDistance: 0, MonsterDisengageRange: 0, TargetNoProgressTimeoutSec: 0, DoJiggle: false, ...opts };
      loop.optFn = (k) => o[k];
    }
    if (hook) loop.movementClaimedFn = () => (typeof claimed === "function" ? claimed() : claimed);
    return loop;
  };
  try {
    // ── J1: the cycle — cast, resolve, strafe (alternating), stop, settle, cast ──
    {
      const host = makeHost({ ents: [DRUDGE] });
      const loop = mk(host, { opts: { DoJiggle: true } });
      const windows = sim(loop, host, 9000);
      const mv = moves(host);
      const strafes = mv.filter((e) => e[3] !== 0);
      const stops = mv.filter((e) => e[2] === 0 && e[3] === 0 && e[4] === 0);
      check("J1 a strafe after every resolved cast, sides alternating (+1 right, -1 left), run held",
        strafes.length >= 3 && strafes.every((e, i) => e[3] === (i % 2 ? -1 : 1) && e[2] === 0 && e[4] === 0 && e[5] === true),
        JSON.stringify(mv));
      check("J1 every strafe ends with the all-zero stop (run off) after ~300 ms",
        stops.length === strafes.length && strafes.every((s, i) => stops[i] && stops[i][5] === false && stops[i][1] - s[1] >= 300 && stops[i][1] - s[1] <= 400),
        JSON.stringify(mv));
      const inFlight = mv.filter((e) => windows.some(([a, b]) => e[1] >= a && e[1] < b));
      check("J1 never a movement key while a cast is in flight (issue → UseDone)", inFlight.length === 0, JSON.stringify(inFlight));
      const c = casts(host);
      const settled = stops.every((s) => {
        const next = c.find((t) => t > s[1]);
        return next === undefined || next - s[1] >= FACE_SETTLE_MS;
      });
      check("J1 the next cast waits FACE_SETTLE_MS after the stop", settled, `casts=${JSON.stringify(c)} stops=${JSON.stringify(stops.map((s) => s[1]))}`);
      check("J1 casts keep flowing (one strafe per cast cycle)", c.length >= 4 && strafes.length >= c.length - 1, `casts=${c.length} strafes=${strafes.length}`);
    }

    // ── J2: off (default) / no layer: no movement key, identical cast cadence ──
    {
      const base = makeHost({ ents: [DRUDGE] });
      const t0 = NOW;
      sim(mk(base, { hook: false }), base, 9000);
      NOW = t0;
      const off = makeHost({ ents: [DRUDGE] });
      sim(mk(off, { opts: {} }), off, 9000);
      check("J2 DoJiggle off / no VT layer: no SetMovementInput, the same cast times",
        moves(base).length === 0 && moves(off).length === 0 && JSON.stringify(casts(base)) === JSON.stringify(casts(off)) && casts(base).length >= 5,
        `base=${JSON.stringify(casts(base))} off=${JSON.stringify(casts(off))}`);
    }

    // ── J3: never in melee / missile ──
    {
      const host = makeHost({ ents: [DRUDGE], mode: 2 });
      sim(mk(host, { opts: { DoJiggle: true } }), host, 6000);
      check("J3 melee mode: never a strafe (a MoveToState would stop ACE's charge chain)",
        moves(host).length === 0 && host.log.some((e) => e[0] === "melee"));
    }

    // ── J4: another mover owns the body / no movement-claim hook ──
    {
      const host = makeHost({ ents: [DRUDGE] });
      sim(mk(host, { opts: { DoJiggle: true }, claimed: true }), host, 6000);
      const h2 = makeHost({ ents: [DRUDGE] });
      const logs = [];
      sim(mk(h2, { opts: { DoJiggle: true }, hook: false, logs }), h2, 6000);
      check("J4 movementClaimedFn true (a goto, a /rs jump, unwedge…): no strafe; casts continue",
        moves(host).length === 0 && casts(host).length >= 3);
      check("J4 no movementClaimedFn: never jiggles, says so once",
        moves(h2).length === 0 && logs.filter((m) => /movementClaimedFn/.test(m)).length === 1, JSON.stringify(logs));
    }

    // ── J5: anyone's action in flight (shared busy count) holds the strafe ──
    {
      const host = makeHost({ ents: [DRUDGE] });
      const loop = mk(host, { opts: { DoJiggle: true } });
      const busyAt = [];
      sim(loop, host, 4000, {
        onTick: (t) => {
          host.busy = t >= 1400 && t < 2200 ? 1 : 0; // e.g. vitals' heal winding up across our UseDone
          if (host.busy) busyAt.push(NOW + 100);
        },
      });
      const mv = moves(host);
      const during = mv.filter((e) => busyAt.includes(e[1]));
      check("J5 no strafe while the busy count is up; it goes once the count clears", during.length === 0 && mv.length >= 1,
        JSON.stringify({ mv, busy: [busyAt[0], busyAt[busyAt.length - 1]] }));
    }

    // ── J6-J9: a strafe in progress is stopped at once ──
    const midStrafe = (setup) => {
      const host = makeHost({ ents: [{ ...DRUDGE }] });
      const loop = mk(host, { opts: { DoJiggle: true } });
      let strafeAt = -1;
      sim(loop, host, 3000, {
        onTick: () => {
          const s = moves(host).find((e) => e[3] !== 0);
          if (s && strafeAt < 0) {
            strafeAt = s[1];
            setup(loop, host);
          }
        },
      });
      const mv = moves(host);
      const stop = mv.find((e) => e[2] === 0 && e[3] === 0 && e[1] >= strafeAt);
      return { host, mv, strafeAt, stopAfter: stop ? stop[1] - strafeAt : -1 };
    };
    {
      const r = midStrafe((loop) => loop.disengage({ cancelAttack: false })); // the kernel hands the tick to Vitals
      check("J6 disengage() mid-strafe: the stop goes out at once", r.stopAfter === 0, JSON.stringify(r.mv));
      const s = midStrafe((loop) => loop.stop());
      check("J6 stop() mid-strafe: the stop goes out at once", s.stopAfter === 0, JSON.stringify(s.mv));
    }
    {
      const r = midStrafe((_loop, host) => { host.mode = 2; });
      check("J7 the stance left Magic mid-strafe: stopped on the next tick", r.stopAfter === 100, JSON.stringify(r.mv));
      const p = midStrafe((_loop, host) => { host.portal = true; });
      check("J7 portal space mid-strafe: stopped on the next tick", p.stopAfter === 100, JSON.stringify(p.mv));
    }
    {
      const r = midStrafe((_loop, host) => { host.byId.get(DRUDGE.id).y = 130; }); // 34 m: out of magic range
      const stopIdx = r.host.log.findIndex((e) => e[0] === "move" && e[3] === 0 && e[1] >= r.strafeAt);
      const stickIdx = r.host.log.findIndex((e) => e[0] === "stick");
      check("J8 the lock ran out of range mid-strafe: the strafe stops before the run-up sticks", stopIdx >= 0 && stickIdx > stopIdx,
        JSON.stringify(r.host.log.filter((e) => e[0] !== "cast")));
    }
    {
      let claimed = false;
      const host = makeHost({ ents: [DRUDGE] });
      const loop = mk(host, { opts: { DoJiggle: true }, claimed: () => claimed });
      let strafeAt = -1;
      sim(loop, host, 3000, {
        onTick: () => {
          const s = moves(host).find((e) => e[3] !== 0);
          if (s && strafeAt < 0) {
            strafeAt = s[1];
            claimed = true; // a /rs jump claims the body
          }
        },
      });
      const stop = moves(host).find((e) => e[3] === 0 && e[1] >= strafeAt);
      check("J9 another mover claims the body mid-strafe: stopped on the next tick", stop && stop[1] - strafeAt === 100, JSON.stringify(moves(host)));
    }
  } finally {
    Date.now = realNow;
  }

  let fail = 0;
  for (const r of results) {
    if (!r.ok) fail++;
    console.log(`${r.ok ? "PASS" : "FAIL"} ${r.name}${r.ok || !r.detail ? "" : " — " + r.detail}`);
  }
  console.log(`\ncombat-jiggle: ${results.length - fail}/${results.length} passed`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
