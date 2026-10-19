#!/usr/bin/env node
// rynth_combat_blacklist_test.cjs — the no-CONTACT blacklist in
// rynth/combat_loop.js (2026-10-12, reworked after the second review): a port
// of RynthAi's CombatManager.JudgePendingCast (BlacklistAttempts 3,
// BlacklistCastSettleMs 1500, BlacklistTimeoutSec 30) that
//   - counts RESOLVED casts only (UseDone / deadline; a refusal never counts,
//     even one that trails its own UseDone), each judged 1.5 s after it
//     resolved — a 4 s level-5+ windup is not a miss;
//   - treats CONTACT as damage (health drop, a damage line naming the lock)
//     OR defence (our attack evaded, our spell resisted) — a tough target is
//     hittable; immunity ("You fail to affect …") is not contact;
//   - never parks a lock that attacked us within the grace window;
//   - melee/missile: 20 s in ATTACK with no contact.
// Live-hit on the 1070: an admin-spawned Drudge stayed at 100 % through 30+
// Flame Bolts (they flew through it into festival pumpkins) and held the lock
// forever. Mock host, frozen clock, no infra.
// B11 (2026-10-19): VTank TargetNoProgressTimeoutSec through the VT layer's
// optFn (RynthAi T14) — parks a lock engaged that long without OUR DAMAGE
// reaching it (evades / resists are no progress), the clock paused while the
// combat loop is not ticking; 0 / no layer = off, and the 20 s rule unchanged.
// B12 (2026-10-19): a kind=13 refusal while ANOTHER module holds the cast
// token (host.castToken.owner, e.g. the VT helpers' Heal Other) is theirs —
// no stand-down for "components", no close-in for 0x0550, nothing un-counted.
// B13: the owner is host.castOwner() when the host has it (the live claim,
// else the last one while < 6 s old): a vitals claim never released and aged
// out no longer swallows combat's own refusals (a missile 0x0550 → close-in).
//   Run: node rynth_combat_blacklist_test.cjs
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");

const LB = 0xa9b40015 >>> 0;

async function importCopy(rel) {
  const src = fs.readFileSync(path.join(__dirname, rel), "utf8");
  const tmp = path.join(os.tmpdir(), `${path.basename(rel, ".js")}_blacklist_${process.pid}.mjs`);
  fs.writeFileSync(tmp, src);
  try {
    return await import("file://" + tmp);
  } finally {
    fs.unlinkSync(tmp);
  }
}

function makeHost({ ents, mode = 8, known = [27], useDone = false, events = true }) {
  const byId = new Map(ents.map((e) => [e.id, e]));
  const calls = { cast: [], melee: [], cancel: 0 };
  const subs = [];
  const host = {
    calls, byId, mode, known, seq: 0,
    IsPlayerReady: () => true,
    TryGetPlayerPose: () => ({ objCellId: LB, x: 96, y: 96, z: 0, heading: null }),
    NearbyGuids: () => ents.filter((e) => !e.gone).map((e) => e.id),
    ObjectIsPlayer: () => false,
    TryGetObjectIntProperty: (_g, stype) => (stype === 1 ? 16 : undefined),
    ObjectIsAttackable: () => true,
    TryGetTargetHealthFraction: (g) => {
      const e = byId.get(g);
      if (!e || e.gone) return -1;
      return e.hf ?? 1;
    },
    TryGetObjectPosition: (g) => {
      const e = byId.get(g);
      return e && !e.gone ? { objCellId: LB, x: e.x, y: e.y, z: 0 } : null;
    },
    TryGetObjectName: (g) => byId.get(g)?.name ?? null,
    GetCurrentCombatMode: () => host.mode,
    StickToObject: () => true,
    StopStick: () => true,
    QueryHealth: () => true,
    MeleeAttack: (g) => { calls.melee.push(g); return true; },
    MissileAttack: () => true,
    CancelAttack: () => { calls.cancel++; return true; },
    ToggleCombatMode: () => true,
    StopCompletely: () => true,
    TurnToHeading: () => true,
    CastSpell: (t, s) => { calls.cast.push({ t, s }); return true; },
    GetCastBusyState: () => 0,
    GetBusyState: () => 0,
    GetUseDoneSeq: () => host.seq,
    TryGetKnownSpells: () => host.known,
    has: (cap) => cap === "TurnToHeading" || (useDone && cap === "GetUseDoneSeq"),
    onTick: () => {},
    emit: (e) => subs.forEach((fn) => fn(e)),
    s: {},
  };
  if (events) host.onEvent = (fn) => subs.push(fn);
  return host;
}
const chat = (text, code = 0) => ({ kind: 2, text, u32: code, u32b: 0 });
const refusal = (code) => ({ kind: 13, text: "", u32: code, u32b: 0 });
const combatEvt = (type, extra = {}) => ({ kind: 19, text: JSON.stringify({ type, ...extra }), u32: 0, u32b: 0 });

const results = [];
const check = (name, ok, detail) => results.push({ name, ok: !!ok, detail: detail || "" });

async function main() {
  const { RynthCombatLoop } = await importCopy("rynth/combat_loop.js");
  const realNow = Date.now;
  let NOW = 7_000_000;
  Date.now = () => NOW;
  const quiet = () => {};
  const mk = (host, opts = {}) => new RynthCombatLoop(host, { log: quiet, ...opts });
  /** Run `secs` one-second ticks; onCast(i) fires right after each new cast. */
  const run = (loop, host, secs, { onCast, onTick } = {}) => {
    for (let s = 0; s < secs; s++) {
      const before = host.calls.cast.length;
      loop.tick();
      if (host.calls.cast.length > before && onCast) onCast(host.calls.cast.length);
      if (onTick) onTick(s);
      NOW += 1000;
    }
  };
  const DRUDGE = "Drudge Skulker";
  try {
    // ── B1: the live case — bolts never reach the lock (no lines, no health
    //        drop; the damage lines name the PUMPKIN behind it) -> parked ──
    {
      const drudge = { id: 0x80000600, name: DRUDGE, x: 96, y: 101 };
      const other = { id: 0x80000700, name: "Mite", x: 96, y: 108 };
      const host = makeHost({ ents: [drudge, other] });
      const loop = mk(host);
      let parkedAt = -1;
      run(loop, host, 20, {
        onCast: () => host.emit(chat("You incinerate Pumpkin Buffer for 40 points with Flame Bolt I.")),
        onTick: (s) => { if (parkedAt < 0 && loop.unreachable.has(drudge.id)) parkedAt = s; },
      });
      check("B1 an unreachable lock is parked after 3 resolved, settled no-contact casts", parkedAt > 0 && parkedAt <= 15,
        `parkedAt=${parkedAt}s casts=${host.calls.cast.length}`);
      check("B1 lock moved on to the other creature", loop.locked === other.id, loop.locked.toString(16));
      check("B1 blacklisted counter", loop.status.blacklisted === 1, JSON.stringify(loop.status));
    }

    // ── B2: a 4 s windup (UseDone at +4 s, damage lands 0.5–1 s later) is not a miss ──
    {
      const drudge = { id: 0x80000601, name: DRUDGE, x: 96, y: 101, hf: 1 };
      const host = makeHost({ ents: [drudge], useDone: true });
      const loop = mk(host);
      const sched = []; // [atTick, fn]
      for (let t = 0; t < 40; t++) {
        for (let i = sched.length - 1; i >= 0; i--) if (sched[i][0] === t) { sched[i][1](); sched.splice(i, 1); }
        const before = host.calls.cast.length;
        loop.tick();
        if (host.calls.cast.length > before) {
          sched.push([t + 4, () => { host.seq++; }]); // the cast resolves (UseDone)
          sched.push([t + 5, () => { drudge.hf = Math.max(0.05, drudge.hf - 0.1); }]); // its damage shows
        }
        NOW += 1000;
      }
      check("B2 long windups resolve then land: never parked", !loop.unreachable.has(drudge.id) && loop.locked === drudge.id,
        `casts=${host.calls.cast.length} misses=${loop.status.castMisses}`);
      check("B2 several casts went out", host.calls.cast.length >= 5, String(host.calls.cast.length));
    }

    // ── B3: a health drop resets the run; three fresh misses then park ──
    {
      const drudge = { id: 0x80000602, name: DRUDGE, x: 96, y: 101, hf: 1 };
      const host = makeHost({ ents: [drudge] });
      const loop = mk(host);
      run(loop, host, 8); // ~2 resolved, unsettled-or-settled misses
      drudge.hf = 0.7; // something landed
      run(loop, host, 1);
      check("B3 a health drop resets the miss run", loop.status.castMisses <= 1 && !loop.unreachable.has(drudge.id),
        `misses=${loop.status.castMisses}`);
      run(loop, host, 15);
      check("B3 with no further contact the lock is parked", loop.unreachable.has(drudge.id));
    }

    // ── B4: a damage line NAMING the lock (with a crit prefix) is contact ──
    {
      const drudge = { id: 0x80000603, name: DRUDGE, x: 96, y: 101 };
      const host = makeHost({ ents: [drudge] });
      const loop = mk(host);
      run(loop, host, 30, { onCast: () => host.emit(chat(`Critical hit! You scorch ${DRUDGE} for 12 points with Flame Bolt I.`)) });
      check("B4 named (crit-prefixed) damage lines keep the lock", !loop.unreachable.has(drudge.id) && loop.locked === drudge.id,
        `misses=${loop.status.castMisses}`);
    }

    // ── B5: resists are contact (tough, not unreachable) ──
    {
      const drudge = { id: 0x80000604, name: DRUDGE, x: 96, y: 101 };
      const host = makeHost({ ents: [drudge] });
      const loop = mk(host);
      run(loop, host, 30, { onCast: () => host.emit(chat(`${DRUDGE} resists your spell`)) });
      check("B5 a target resisting every bolt is not parked", !loop.unreachable.has(drudge.id) && loop.locked === drudge.id);
    }

    // ── B6: immunity ("You fail to affect") is NOT contact -> parked ──
    {
      const drudge = { id: 0x80000605, name: DRUDGE, x: 96, y: 101 };
      const host = makeHost({ ents: [drudge] });
      const loop = mk(host);
      run(loop, host, 20, { onCast: () => host.emit(chat(`You fail to affect ${DRUDGE} with Flame Bolt I`)) });
      check("B6 an immune target is parked", loop.unreachable.has(drudge.id));
    }

    // ── B7: a lock that keeps attacking us is never parked; parked once it stops ──
    {
      const drudge = { id: 0x80000606, name: DRUDGE, x: 96, y: 101 };
      const host = makeHost({ ents: [drudge] });
      const loop = mk(host);
      run(loop, host, 30, { onTick: (s) => { if (s % 3 === 0) host.emit(combatEvt("damageTaken", { attackerName: DRUDGE, damage: 5 })); } });
      check("B7 an attacker we can't reach is not parked (keep fighting)", !loop.unreachable.has(drudge.id) && loop.locked === drudge.id,
        `misses=${loop.status.castMisses}`);
      run(loop, host, 15); // it stopped hitting us: grace lapses, misses settle
      check("B7 parked once it stops attacking", loop.unreachable.has(drudge.id));
    }

    // ── B8: a fizzle that trails its own UseDone — delivered 300 ms after the
    //        NEXT cast already went out — is un-counted, and the new cast stays
    //        pending (fizzles aren't misses) ──
    {
      const drudge = { id: 0x80000607, name: DRUDGE, x: 96, y: 101 };
      const host = makeHost({ ents: [drudge], useDone: true });
      const loop = mk(host);
      let castsSeen = 0;
      for (let t = 0; t < 30; t++) {
        loop.tick();
        const n = host.calls.cast.length;
        const newCast = n > castsSeen;
        castsSeen = n;
        NOW += 300;
        if (newCast && n >= 2) host.emit(refusal(0x0402)); // the PREVIOUS cast's fizzle event, late
        NOW += 700;
        if (newCast) host.seq++; // this cast's UseDone lands before the next tick
      }
      check("B8 stale fizzles un-count their cast: never parked", !loop.unreachable.has(drudge.id) && loop.locked === drudge.id,
        `casts=${host.calls.cast.length} misses=${loop.status.castMisses}`);
      check("B8 casts keep flowing (the new cast was not resolved by the stale refusal)", host.calls.cast.length >= 10,
        String(host.calls.cast.length));
    }
    // ── B8b: a GENUINE refusal of the current cast (errored UseDone: seq + kind=13
    //         together) resolves it without counting a miss ──
    {
      const drudge = { id: 0x8000060b, name: DRUDGE, x: 96, y: 101 };
      const host = makeHost({ ents: [drudge], useDone: true });
      const loop = mk(host);
      let castsSeen = 0;
      for (let t = 0; t < 30; t++) {
        loop.tick();
        const n = host.calls.cast.length;
        if (n > castsSeen) {
          castsSeen = n;
          NOW += 200;
          host.seq++; // errored UseDone…
          host.emit(refusal(0x001d)); // …YoureTooBusy, delivered with it
          NOW += 800;
        } else NOW += 1000;
      }
      check("B8b refused casts are never misses (not parked)", !loop.unreachable.has(drudge.id) && loop.status.castMisses === 0,
        `misses=${loop.status.castMisses}`);
    }

    // ── B9: no evidence path at all (no health reading, no event tap) -> no verdict ──
    {
      const ghost = { id: 0x80000608, name: DRUDGE, x: 96, y: 101, hf: -1 };
      const host = makeHost({ ents: [ghost], events: false });
      host.TryGetTargetHealthFraction = () => -1;
      const loop = mk(host);
      run(loop, host, 30);
      check("B9 unknown health without an event tap is never parked", !loop.unreachable.has(ghost.id));
    }

    // ── B10: melee — 20 s with no contact parks; evades / damage / an attacking lock don't ──
    {
      const mob = { id: 0x80000609, name: "Banderling", x: 96, y: 100, hf: 1 };
      const host = makeHost({ ents: [mob], mode: 2 });
      const loop = mk(host);
      run(loop, host, 19, { onTick: () => host.emit(combatEvt("attackDone", { error: "None" })) });
      check("B10 19 s of swings with no contact: not parked yet", !loop.unreachable.has(mob.id) && host.calls.melee.length === 1);
      run(loop, host, 3);
      check("B10 20+ s with no contact: parked + attack cancelled", loop.unreachable.has(mob.id) && host.calls.cancel >= 1,
        `cancel=${host.calls.cancel}`);
    }
    for (const [label, evt] of [
      ["evades", (n) => combatEvt("evadedTarget", { defenderName: n })],
      ["damage", (n) => combatEvt("damageDealt", { defenderName: n, damage: 3, severity: 0.01 })],
      ["it attacks us", (n) => combatEvt("damageTaken", { attackerName: n, damage: 4 })],
    ]) {
      const mob = { id: 0x8000060a, name: "Banderling", x: 96, y: 100, hf: 1 };
      const host = makeHost({ ents: [mob], mode: 2 });
      const loop = mk(host);
      run(loop, host, 45, { onTick: (s) => { if (s % 5 === 0) host.emit(evt(mob.name)); } });
      check(`B10 melee lock kept when it ${label} every 5 s`, !loop.unreachable.has(mob.id) && loop.locked === mob.id);
    }

    // ── B11: TargetNoProgressTimeoutSec (VT layer optFn) ──
    const withOpts = (loop, over = {}) => {
      const opts = { TargetLock: false, AttackMinDistance: 0, MonsterDisengageRange: 0, TargetNoProgressTimeoutSec: 0, DoJiggle: false, ...over };
      loop.optFn = (k) => opts[k];
      return loop;
    };
    const firstParked = (loop, id) => (s) => loop.unreachable.has(id) ? s : -1;
    {
      // Every bolt is resisted: contact (the no-contact rule never parks, B5)
      // but no damage — parked at the 10 s timeout, and a fresh lock is taken.
      const drudge = { id: 0x80000610, name: DRUDGE, x: 96, y: 101 };
      const other = { id: 0x80000611, name: "Mite", x: 96, y: 110 };
      const host = makeHost({ ents: [drudge, other] });
      const logs = [];
      const loop = withOpts(mk(host, { log: (m) => logs.push(m) }), { TargetNoProgressTimeoutSec: 10 });
      let parkedAt = -1;
      let next = -1;
      run(loop, host, 15, {
        onCast: () => host.emit(chat(`${DRUDGE} resists your spell`)),
        onTick: (s) => {
          if (parkedAt < 0) parkedAt = firstParked(loop, drudge.id)(s);
          if (parkedAt >= 0 && next < 0) next = loop.locked;
        },
      });
      check("B11 resisted every cast: parked at the 10 s no-progress timeout", parkedAt >= 9 && parkedAt <= 11,
        `parkedAt=${parkedAt}s logs=${JSON.stringify(logs.filter((l) => /blacklisted/.test(l)))}`);
      check("B11 the park names the reason and the same tick locks the next creature", logs.some((l) => /engaged without damaging it/.test(l)) && next === other.id,
        `next=${next.toString(16)}`);
      const plain = makeHost({ ents: [{ ...drudge }] });
      const off = withOpts(mk(plain), { TargetNoProgressTimeoutSec: 0 });
      run(off, plain, 30, { onCast: () => plain.emit(chat(`${DRUDGE} resists your spell`)) });
      const bare = makeHost({ ents: [{ ...drudge }] });
      const noLayer = mk(bare);
      run(noLayer, bare, 30, { onCast: () => bare.emit(chat(`${DRUDGE} resists your spell`)) });
      check("B11 timeout 0 / no VT layer: never parked (B5 unchanged)", !off.unreachable.has(drudge.id) && !noLayer.unreachable.has(drudge.id));
    }
    {
      // Damage lines naming the lock (and the health dropping) are progress.
      const drudge = { id: 0x80000612, name: DRUDGE, x: 96, y: 101, hf: 1 };
      const host = makeHost({ ents: [drudge] });
      const loop = withOpts(mk(host), { TargetNoProgressTimeoutSec: 10 });
      run(loop, host, 40, {
        onCast: () => {
          drudge.hf = Math.max(0.05, drudge.hf - 0.02);
          host.emit(chat(`You scorch ${DRUDGE} for 3 points with Flame Bolt I.`));
        },
      });
      check("B11 a lock our bolts keep damaging is never parked", !loop.unreachable.has(drudge.id) && loop.locked === drudge.id);
      // …but damage that names ANOTHER creature (the pumpkin behind it) is not.
      const d2 = { id: 0x80000613, name: DRUDGE, x: 96, y: 101 };
      const h2 = makeHost({ ents: [d2] });
      const l2 = withOpts(mk(h2), { TargetNoProgressTimeoutSec: 5 });
      let at2 = -1;
      run(l2, h2, 12, {
        onCast: () => h2.emit(chat("You incinerate Pumpkin Buffer for 40 points with Flame Bolt I.")),
        onTick: (s) => { if (at2 < 0) at2 = firstParked(l2, d2.id)(s); },
      });
      check("B11 damage naming another creature is no progress (parked at 5 s)", at2 >= 4 && at2 <= 6, `parkedAt=${at2}s`);
    }
    {
      // Melee: every swing evaded (contact — the 20 s rule never fires) →
      // parked at 8 s with the attack cancelled; an UNNAMED damage result
      // during the engagement is the lock's damage → never parked.
      const mob = { id: 0x80000614, name: "Banderling", x: 96, y: 100, hf: 1 };
      const host = makeHost({ ents: [mob], mode: 2 });
      const loop = withOpts(mk(host), { TargetNoProgressTimeoutSec: 8 });
      let parkedAt = -1;
      run(loop, host, 20, {
        onTick: (s) => {
          host.emit(combatEvt("evadedTarget", { defenderName: mob.name }));
          if (parkedAt < 0) parkedAt = firstParked(loop, mob.id)(s);
        },
      });
      check("B11 melee: evaded every swing → parked at the 8 s timeout + attack cancelled", parkedAt >= 7 && parkedAt <= 9 && host.calls.cancel >= 1,
        `parkedAt=${parkedAt}s cancel=${host.calls.cancel}`);
      const m2 = { id: 0x80000615, name: "Banderling", x: 96, y: 100, hf: 1 };
      const h2 = makeHost({ ents: [m2], mode: 2 });
      const l2 = withOpts(mk(h2), { TargetNoProgressTimeoutSec: 8 });
      run(l2, h2, 30, { onTick: (s) => { if (s % 3 === 0) h2.emit(combatEvt("damageDealt", { damage: 4, severity: 0.01 })); } });
      check("B11 melee: unnamed damage results during the engagement are progress (never parked)", !l2.unreachable.has(m2.id) && l2.locked === m2.id);
    }
    {
      // The clock runs only while the combat loop ticks: 6 s, a 20 s gap (the
      // kernel gave the tick to buffing), 3 s → 9 s engaged < 10 → kept; 2 s
      // more → parked.
      const drudge = { id: 0x80000616, name: DRUDGE, x: 96, y: 101 };
      const host = makeHost({ ents: [drudge] });
      const loop = withOpts(mk(host), { TargetNoProgressTimeoutSec: 10 });
      const resist = () => host.emit(chat(`${DRUDGE} resists your spell`));
      run(loop, host, 6, { onCast: resist });
      NOW += 20_000;
      run(loop, host, 3, { onCast: resist });
      const keptAfterGap = !loop.unreachable.has(drudge.id) && loop.locked === drudge.id;
      run(loop, host, 3, { onCast: resist });
      check("B11 a gap in combat ticks is not engaged time (kept at 9 s engaged, parked past 10)", keptAfterGap && loop.unreachable.has(drudge.id),
        `keptAfterGap=${keptAfterGap}`);
    }
    {
      // RynthAi T14 has no attacker exemption: a lock that keeps hitting us but
      // that we cannot damage is still parked by the timeout (the no-contact
      // rules keep it, B7).
      const drudge = { id: 0x80000617, name: DRUDGE, x: 96, y: 101 };
      const host = makeHost({ ents: [drudge] });
      const loop = withOpts(mk(host), { TargetNoProgressTimeoutSec: 6 });
      run(loop, host, 10, { onTick: (s) => { if (s % 2 === 0) host.emit(combatEvt("damageTaken", { attackerName: DRUDGE, damage: 5 })); } });
      check("B11 an attacker we never damage is still parked at the timeout", loop.unreachable.has(drudge.id));
    }
    {
      // The 20 s melee/missile rule is untouched with the layer at defaults.
      const mob = { id: 0x80000618, name: "Banderling", x: 96, y: 100, hf: 1 };
      const host = makeHost({ ents: [mob], mode: 2 });
      const loop = withOpts(mk(host));
      run(loop, host, 19, { onTick: () => host.emit(combatEvt("attackDone", { error: "None" })) });
      const at19 = loop.unreachable.has(mob.id);
      run(loop, host, 3);
      check("B11 layer at defaults: the 20 s no-contact melee rule as before", !at19 && loop.unreachable.has(mob.id));
    }

    // ── B12: a kind=13 refusal under ANOTHER module's cast claim is theirs ──
    // Our bolt resolves (UseDone); on that tick a helper's Heal Other is in
    // flight (busy) under the "helpers" token; its refusal lands 300 ms later,
    // inside our 1.5 s late-refusal window.
    {
      const late = (owner, code) => {
        const drudge = { id: 0x80000620, name: DRUDGE, x: 96, y: 101 };
        const host = makeHost({ ents: [drudge], useDone: true });
        let busy = 0;
        host.GetBusyState = () => busy;
        const loop = mk(host);
        loop.tick(); // lock + our cast
        NOW += 2000;
        host.seq++; // our UseDone…
        busy = 1; // …and the helper's cast goes out
        loop.tick(); // resolves ours (counted as an attempt), holds on busy
        const misses = loop.status.castMisses;
        host.castToken = owner ? { owner } : null;
        NOW += 300;
        host.emit(refusal(code));
        return { loop, drudge, misses };
      };
      const foreign = late("helpers", 0x0400);
      const ours = late("combat", 0x0400);
      const none = late(null, 0x0400);
      check("B12 a 'missing components' refusal under the helpers' token: no stand-down (ours / no token: stand down)",
        foreign.loop.canEngage() && !ours.loop.canEngage() && !none.loop.canEngage(),
        `foreign=${foreign.loop.status.incapable} ours=${ours.loop.status.incapable} none=${none.loop.status.incapable}`);
      const rf = late("helpers", 0x0550);
      const rn = late(null, 0x0550);
      check("B12 an out-of-range refusal under another owner's token: no close-in on our lock",
        rf.loop._closeInFor === 0 && rn.loop._closeInFor === rn.drudge.id, `foreign=${rf.loop._closeInFor} none=${rn.loop._closeInFor}`);
      const ff = late("vitals", 0x0402);
      const fo = late(null, 0x0402);
      check("B12 a fizzle under another owner's token does not un-count our resolved cast",
        ff.loop.status.castMisses === ff.misses && ff.misses === 1 && fo.loop.status.castMisses === 0,
        `foreign=${ff.loop.status.castMisses}/${ff.misses} none=${fo.loop.status.castMisses}`);
    }

    // ── B13: castOwner() decides when the host has it (the raw token is only
    //         the fallback): a missile engagement's own range refusal ──
    {
      const missile = (castOwner, castToken) => {
        const mob = { id: 0x80000630, name: "Banderling", x: 96, y: 106, hf: 1 };
        const host = makeHost({ ents: [mob], mode: 4 });
        if (castOwner !== undefined) host.castOwner = () => castOwner;
        host.castToken = castToken;
        const loop = mk(host);
        loop.tick(); // lock + the shot
        NOW += 300;
        host.emit(refusal(0x0550)); // MissileOutOfRange (SendWeenieError → kind 13)
        return loop._closeInFor === mob.id;
      };
      const stale = { owner: "vitals" }; // a vitals claim nobody released
      const r = {
        agedOut: missile(null, stale), // castOwner: nobody cast for 6 s → ours
        vitalsLive: missile("vitals", stale), // castOwner names vitals → theirs
        ours: missile("combat", stale),
        rawOnly: missile(undefined, stale), // no castOwner (older host): the raw token → theirs
        nobody: missile(undefined, null),
      };
      check("B13 refusal owner = host.castOwner(): an aged-out vitals claim no longer swallows our missile range refusal",
        r.agedOut && !r.vitalsLive && r.ours && !r.rawOnly && r.nobody, JSON.stringify(r));
    }
  } finally {
    Date.now = realNow;
  }

  let fail = 0;
  for (const r of results) {
    if (!r.ok) fail++;
    console.log(`${r.ok ? "PASS" : "FAIL"} ${r.name}${r.ok || !r.detail ? "" : " — " + r.detail}`);
  }
  console.log(`\ncombat-blacklist: ${results.length - fail}/${results.length} passed`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
